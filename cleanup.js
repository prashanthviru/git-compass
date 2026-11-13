const vscode = require('vscode');
const g = require('./git');
const views = require('./views');
const { gitEdit } = require('./conflicts');

// Clean Up Branches: find local branches that are merged, whose remote branch is gone
// (usually a merged pull request), or that nobody has touched in a while, and delete the
// ones you pick. Every deleted branch is remembered so the Recovery view can restore it.

const SEP = '\x1f';
const DAY = 86400;

const REASONS = {
  merged: { label: 'merged', detail: (b) => `merged into ${b.base}` },
  gone: { label: 'remote deleted', detail: (b) => `${b.upstream || 'its remote branch'} was deleted, usually after the pull request merged` },
  stale: { label: 'stale', detail: (b) => `no commits for ${b.ageDays} days` },
};

// Pure: which branches are candidates, and why. Merged and gone branches are preselected;
// stale ones are only suggested.
function classifyBranches(branches, { merged = new Set(), current, protectedList = [], baseNames = [], worktreeBranches = new Set(), now = Date.now() / 1000, staleDays = 90, base } = {}) {
  const keep = new Set([current, ...protectedList, ...baseNames].filter(Boolean));
  const out = [];
  for (const b of branches) {
    if (keep.has(b.name) || worktreeBranches.has(b.name)) continue;
    const reasons = [];
    if (merged.has(b.name)) reasons.push('merged');
    if (b.gone) reasons.push('gone');
    const ageDays = b.time ? Math.floor((now - b.time) / DAY) : 0;
    if (staleDays > 0 && ageDays >= staleDays) reasons.push('stale');
    if (!reasons.length) continue;
    out.push({ ...b, base, ageDays, reasons, picked: reasons.includes('merged') || reasons.includes('gone'), safe: reasons.includes('merged') });
  }
  const rank = (c) => (c.reasons.includes('merged') ? 0 : c.reasons.includes('gone') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || (a.time || 0) - (b.time || 0));
}

async function readBranches(root) {
  const out = await g.git(root, ['for-each-ref', `--format=%(refname:short)${SEP}%(objectname)${SEP}%(upstream:short)${SEP}%(upstream:track)${SEP}%(committerdate:unix)${SEP}%(committerdate:relative)${SEP}%(subject)`, 'refs/heads']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, sha, upstream, track, time, date, subject] = l.split(SEP);
      return { name, sha, upstream, gone: track === '[gone]', time: Number(time) || 0, date, subject };
    });
}

async function findCandidates(root) {
  const bases = await g.resolveBases(root);
  const baseRef = bases[0];
  const [branches, current, worktrees, mergedOut] = await Promise.all([
    readBranches(root),
    g.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).then((s) => s.trim()).catch(() => ''),
    g.git(root, ['worktree', 'list', '--porcelain']).then(g.parseWorktrees).catch(() => []),
    baseRef ? g.git(root, ['branch', '--format=%(refname:short)', '--merged', baseRef]).catch(() => '') : '',
  ]);
  const cfg = g.config();
  return classifyBranches(branches, {
    merged: new Set(mergedOut.split('\n').filter(Boolean)),
    current,
    protectedList: cfg.get('protectedBranches', ['main', 'master', 'develop', 'dev', 'prod', 'production', 'live']),
    baseNames: bases.map(g.shortRef),
    worktreeBranches: new Set(worktrees.map((w) => w.branch).filter(Boolean)),
    staleDays: cfg.get('branchCleanup.staleDays', 90),
    base: baseRef ? g.shortRef(baseRef) : undefined,
  });
}

async function cleanUpBranches(arg) {
  const root = arg?.root || g.requireRepo();
  const candidates = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for branches to clean up…' }, async () => {
    // Prune first so branches whose remote was deleted show up as "remote deleted".
    await gitEdit(root, ['fetch', '--prune', '--quiet', 'origin']).catch(() => {});
    return findCandidates(root);
  });
  if (!candidates.length) {
    vscode.window.showInformationMessage('Nothing to clean up: no merged, remote-deleted or stale local branches.');
    return [];
  }
  const items = candidates.map((c) => ({
    label: c.name,
    description: c.reasons.map((r) => REASONS[r].label).join(' · '),
    detail: `${c.reasons.map((r) => REASONS[r].detail(c)).join('; ')} · last commit ${c.date}: ${c.subject}`,
    picked: c.picked,
    candidate: c,
  }));
  const picks = await vscode.window.showQuickPick(items, {
    title: 'Clean Up Branches',
    placeHolder: 'Pick the local branches to delete. Remote branches are not touched.',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picks?.length) return [];
  const unmerged = picks.filter((p) => !p.candidate.safe);
  const detail = [
    picks.map((p) => `• ${p.label} (${p.description})`).slice(0, 15).join('\n') + (picks.length > 15 ? `\n…and ${picks.length - 15} more` : ''),
    unmerged.length ? `${views.plural(unmerged.length, 'branch').replace('branchs', 'branches')} ${unmerged.length === 1 ? 'has' : 'have'} commits that are not in ${candidates[0].base || 'the base branch'}.` : '',
    'Only local branches are deleted. Each one is listed under Deleted branches in the Recovery view, so you can restore it.',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!(await views.confirm(`Delete ${views.plural(picks.length, 'local branch').replace('branchs', 'branches')}?`, detail, 'Delete'))) return [];
  const deleted = [];
  const failed = [];
  for (const p of picks) {
    try {
      await g.git(root, ['branch', '-D', '--end-of-options', p.label]);
      await views.rememberDeletedBranch(root, p.label, p.candidate.sha);
      deleted.push(p.label);
    } catch (e) {
      failed.push(`${p.label}: ${e.message}`);
    }
  }
  views.refreshAll();
  if (failed.length) vscode.window.showWarningMessage(`Deleted ${deleted.length}; could not delete ${failed.length}: ${failed.join('; ')}`);
  else vscode.window.showInformationMessage(`Deleted ${views.plural(deleted.length, 'branch').replace('branchs', 'branches')}. Restore any of them from the Recovery view.`);
  return deleted;
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitCompass.branch.cleanup', async (arg) => {
      try {
        await g.getGitApi();
        return await cleanUpBranches(arg);
      } catch (e) {
        vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
        return undefined;
      }
    })
  );
}

module.exports = { register, classifyBranches, findCandidates, cleanUpBranches, readBranches };

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('./git');
const views = require('./views');
const { gitEdit, readState } = require('./conflicts');
const pr = require('./pullRequests');

// Undo and recovery: undo the last thing that happened to the branch, a Recovery view
// that reads the reflog in plain words, deleted branches you can bring back, and the
// commit actions that change history (cherry-pick, revert, reset, amend, squash).

const VIEW_ID = 'gitCompass.views.recovery';
const T = vscode.TreeItemCollapsibleState;
const FS = '\x1f';
const SHA = /^[0-9a-f]{7,64}$/i;

const short = (ref) => String(ref || '').replace(/^refs\/(heads|remotes|tags)\//, '');
const quote = (text, max = 60) => {
  const t = String(text || '').trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
};

// What a reflog line ("commit: fix login", "checkout: moving from main to feat", ...) means.
function describeReflog(subject) {
  const s = String(subject || '');
  let m;
  if ((m = /^commit \(initial\): (.*)$/.exec(s))) return { kind: 'commit', initial: true, message: m[1], text: `Committed ${quote(m[1])} (first commit)`, icon: 'git-commit' };
  if ((m = /^commit \(amend\): (.*)$/.exec(s))) return { kind: 'amend', message: m[1], text: `Amended the last commit: ${quote(m[1])}`, icon: 'edit' };
  if ((m = /^commit \(merge\): (.*)$/.exec(s))) return { kind: 'merge', message: m[1], text: `Finished a merge: ${quote(m[1])}`, icon: 'git-merge' };
  if ((m = /^commit: (.*)$/.exec(s))) return { kind: 'commit', message: m[1], text: `Committed ${quote(m[1])}`, icon: 'git-commit' };
  if ((m = /^checkout: moving from (.+) to (.+)$/.exec(s))) {
    const [from, to] = [m[1], m[2]];
    const label = (r) => (SHA.test(r) ? `commit ${r.slice(0, 7)}` : r);
    return { kind: 'checkout', from, to, text: `Switched from ${label(from)} to ${label(to)}`, icon: 'arrow-swap' };
  }
  if ((m = /^(?:pull(?: --rebase)?|rebase(?: -i)?) \((finish|abort)\): (?:returning to )?(\S+)(?: onto (\S+))?/.exec(s))) {
    if (m[1] === 'abort') return { kind: 'rebaseStep', text: `Cancelled a rebase of ${short(m[2])}`, icon: 'circle-slash' };
    return { kind: 'rebase', branch: short(m[2]), text: `Rebased ${short(m[2])}${m[3] ? ` onto ${m[3].slice(0, 7)}` : ''}`, icon: 'git-pull-request' };
  }
  if ((m = /^(?:pull(?: --rebase)?|rebase(?: -i)?) \(([\w -]+)\): (.*)$/.exec(s))) return { kind: 'rebaseStep', text: `Rebase step (${m[1]}): ${m[2]}`, icon: 'debug-step-over' };
  if ((m = /^pull\b[^:]*: (.*)$/.exec(s))) return { kind: 'pull', text: `Pulled${/fast-forward/i.test(m[1]) ? ' (fast-forward)' : ` (${m[1]})`}`, icon: 'cloud-download' };
  if ((m = /^merge (.+?): (.*)$/.exec(s))) return { kind: 'merge', source: m[1], text: `Merged ${short(m[1])}${/fast-forward/i.test(m[2]) ? ' (fast-forward)' : ''}`, icon: 'git-merge' };
  if ((m = /^reset: moving to (.+)$/.exec(s))) return { kind: 'reset', text: `Reset to ${SHA.test(m[1]) ? m[1].slice(0, 7) : m[1]}`, icon: 'discard' };
  if ((m = /^cherry-pick: (.*)$/.exec(s))) return { kind: 'cherryPick', message: m[1], text: `Cherry-picked ${quote(m[1])}`, icon: 'symbol-event' };
  if ((m = /^revert: (.*)$/.exec(s))) return { kind: 'revert', message: m[1], text: `Committed ${quote(m[1])}`, icon: 'discard' };
  if ((m = /^squash: (.*)$/.exec(s))) return { kind: 'squash', text: `Squashed ${m[1]}`, icon: 'fold' };
  if ((m = /^branch: Created from (.+)$/i.exec(s))) return { kind: 'branch', text: `Branch created from ${short(m[1])}`, icon: 'git-branch' };
  if ((m = /^branch: renamed (.+) to (.+)$/i.exec(s))) return { kind: 'branch', text: `Renamed ${short(m[1])} to ${short(m[2])}`, icon: 'git-branch' };
  return { kind: 'other', text: s || '(no description)', icon: 'circle-small' };
}

function parseReflog(out) {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, abbrev, selector, subject, message] = line.split(FS);
      const time = Number(/@\{(\d+)\}$/.exec(selector || '')?.[1]) || undefined;
      return { hash, short: abbrev, selector, subject, message, time, ...describeReflog(subject) };
    });
}

async function readReflog(root, ref = 'HEAD', limit = 50) {
  try {
    return parseReflog(await g.git(root, ['log', '-g', '--date=unix', `--format=%H${FS}%h${FS}%gd${FS}%gs${FS}%s`, `-n${limit}`, ref, '--']));
  } catch {
    return [];
  }
}

// What "Undo Last Action" would do, given the newest reflog entries of the branch.
function planUndo(entries) {
  const [top, prev] = entries;
  if (!top) return { reason: 'There is nothing to undo yet: git has no record of changes to this branch.' };
  if (top.kind === 'rebaseStep') return { reason: 'A rebase is in progress. Continue or abort it from the Conflicts view instead.' };
  if (!prev) return { reason: top.initial ? `${quote(top.message)} is the first commit, so there is nothing before it to go back to.` : 'There is nothing earlier on this branch to go back to.' };
  const target = prev.hash;
  const plans = {
    commit: { mode: 'soft', title: `Undo commit ${quote(top.message)}`, detail: 'The commit is removed and its changes stay staged, so nothing is lost.' },
    amend: { mode: 'soft', title: `Undo the amend of ${quote(top.message)}`, detail: 'The commit goes back to how it was before the amend. What the amend added stays staged.' },
    merge: { mode: 'keep', title: top.source ? `Undo merging ${short(top.source)}` : 'Undo the merge', detail: 'The branch goes back to where it was before the merge.' },
    pull: { mode: 'keep', title: 'Undo the pull', detail: 'The branch goes back to where it was before the pull. Run pull again whenever you like.' },
    rebase: { mode: 'keep', title: 'Undo the rebase', detail: 'The branch goes back to its commits from before the rebase.' },
    reset: { mode: 'keep', title: `Undo the reset (back to ${prev.short})`, detail: 'The branch goes back to where it was before the reset.' },
    cherryPick: { mode: 'keep', title: `Undo cherry-pick of ${quote(top.message)}`, detail: 'The cherry-picked commit is removed.' },
    revert: { mode: 'keep', title: `Undo ${quote(top.message)}`, detail: 'The revert commit is removed.' },
    squash: { mode: 'keep', title: 'Undo the squash', detail: 'The separate commits come back exactly as they were.' },
    checkout: SHA.test(top.from) ? { mode: 'detach', title: `Go back to commit ${top.from.slice(0, 7)}`, detail: 'Checks out the commit you were on before.' } : { mode: 'switch', title: `Switch back to ${top.from}`, detail: `Switches back to ${top.from}.` },
    branch: { reason: 'This branch was just created; there is nothing to undo on it.' },
  };
  const plan = plans[top.kind] || { mode: 'keep', title: `Undo ${quote(top.subject)}`, detail: `The branch goes back to ${prev.short}.` };
  if (plan.reason) return plan;
  return { ...plan, kind: top.kind, target, targetShort: prev.short, entry: top, from: top.from };
}

function undoArgs(plan) {
  if (plan.mode === 'switch') return ['switch', '--end-of-options', plan.from];
  if (plan.mode === 'detach') return ['switch', '--detach', plan.from];
  return ['reset', plan.mode === 'soft' ? '--soft' : '--keep', plan.target];
}

function friendlyResetError(e) {
  if (/not uptodate|would be overwritten|Cannot do a .* reset/i.test(e.message)) {
    return new Error('Git stopped to protect your uncommitted changes in files this would change. Commit or stash them, then try again.');
  }
  return e;
}

async function branchName(root) {
  return (await g.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
}

async function revParse(root, ref) {
  return (await g.git(root, ['rev-parse', '--verify', '-q', ref]).catch(() => '')).trim();
}

async function upstreamOf(root) {
  return (await g.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
}

async function isAncestor(root, a, b) {
  try {
    await g.git(root, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

async function requireNoOperation(root) {
  const s = await readState(root);
  if (s.op) throw new Error(`A ${s.op.label.toLowerCase()} is in progress. Continue or abort it from the Conflicts view first.`);
}

function backupName(branch, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `backup/${branch || 'detached'}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function done(message) {
  vscode.commands.executeCommand('gitCompass.refresh');
  if (message) vscode.window.showInformationMessage(message);
}

function withMessageFile(message, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-msg-'));
  const file = path.join(dir, 'MSG');
  fs.writeFileSync(file, message);
  return Promise.resolve(fn(file)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// ---- Undo ---------------------------------------------------------------------------

// True when the staged and working files already equal the target commit, as right after
// "Undo commit": going back then needs no file changes, so a soft reset is enough.
async function filesMatch(root, target) {
  try {
    await g.git(root, ['diff', '--quiet', target, '--']);
    await g.git(root, ['diff', '--cached', '--quiet', target, '--']);
    return true;
  } catch {
    return false;
  }
}

async function runUndo(root, plan, { pushedTo } = {}) {
  if (plan.mode === 'keep' && (await filesMatch(root, plan.target))) plan = { ...plan, mode: 'soft' };
  const args = undoArgs(plan);
  const lines = [plan.detail];
  if (pushedTo) lines.push(`This is already on ${pushedTo}. Undoing it here doesn't change ${pushedTo}, so your branch will be behind it; pushing again later would need a force-push.`);
  lines.push(`Runs: git ${args.join(' ')}`, 'Changed your mind? The Recovery view lets you undo this too.');
  const buttons = pushedTo && (plan.kind === 'commit' || plan.kind === 'squash') ? ['Revert Instead', 'Undo Locally'] : ['Undo'];
  const pick = await vscode.window.showWarningMessage(`${plan.title}?`, { modal: true, detail: lines.join('\n\n') }, ...buttons);
  if (!pick) return false;
  if (pick === 'Revert Instead') {
    await revertCommit({ root, commit: { hash: plan.entry.hash, short: plan.entry.short, subject: plan.entry.message, parents: [] } }, { skipConfirm: true });
    return true;
  }
  try {
    await gitEdit(root, args);
  } catch (e) {
    throw friendlyResetError(e);
  }
  done(plan.mode === 'switch' || plan.mode === 'detach' ? `${plan.title.replace(/^Switch/, 'Switched').replace(/^Go/, 'Went')}.` : `Undone: ${plan.title.replace(/^Undo /, '')}. To redo it, use the Recovery view.`);
  return true;
}

async function undoLastAction(arg) {
  const root = arg?.root || g.requireRepo();
  await requireNoOperation(root);
  const branch = await branchName(root);
  const plan = planUndo(await readReflog(root, branch ? `refs/heads/${branch}` : 'HEAD', 2));
  if (plan.reason) {
    vscode.window.showInformationMessage(plan.reason);
    return false;
  }
  let pushedTo;
  if (plan.mode === 'soft' || plan.mode === 'keep') {
    const upstream = await upstreamOf(root);
    if (upstream && (await isAncestor(root, 'HEAD', upstream)) && !(await isAncestor(root, 'HEAD', plan.target))) pushedTo = upstream;
  }
  return runUndo(root, plan, { pushedTo });
}

async function undoCommit(node) {
  const { root, commit } = node;
  await requireNoOperation(root);
  if ((await revParse(root, 'HEAD')) !== commit.hash) throw new Error('Only the latest commit can be undone this way. Use "Reset Current Branch to Here…" for older commits.');
  const parent = await revParse(root, `${commit.hash}^`);
  if (!parent) throw new Error('This is the first commit in the repository, so there is nothing before it to go back to.');
  const upstream = await upstreamOf(root);
  const pushedTo = upstream && (await isAncestor(root, commit.hash, upstream)) ? upstream : undefined;
  return runUndo(
    root,
    { mode: 'soft', kind: 'commit', target: parent, title: `Undo commit ${quote(commit.subject)}`, detail: 'The commit is removed and its changes stay staged, so nothing is lost.', entry: { hash: commit.hash, short: commit.short, message: commit.subject } },
    { pushedTo }
  );
}

// ---- Commit actions -----------------------------------------------------------------

async function cherryPick(node) {
  const { root, commit } = node;
  await requireNoOperation(root);
  if (await isAncestor(root, commit.hash, 'HEAD')) {
    vscode.window.showInformationMessage(`${commit.short} is already on ${g.currentBranch(root)}.`);
    return 'skipped';
  }
  const args = ['cherry-pick', ...(commit.parents?.length > 1 ? ['-m', '1'] : []), commit.hash];
  let error;
  try {
    await gitEdit(root, args);
  } catch (e) {
    error = e;
  }
  return pr.afterLocalMerge(root, error, `Cherry-picked ${quote(commit.subject)} onto ${g.currentBranch(root)}.`);
}

async function revertCommit(node, { skipConfirm = false } = {}) {
  const { root, commit } = node;
  await requireNoOperation(root);
  const parents = commit.parents?.length ? commit.parents : (await g.git(root, ['rev-list', '--parents', '-n', '1', commit.hash])).trim().split(/\s+/).slice(1);
  if (!skipConfirm) {
    const ok = await views.confirm(
      `Revert ${quote(commit.subject)}?`,
      `Adds a new commit to ${g.currentBranch(root)} that undoes the changes made by ${commit.short}. History is not rewritten, so this is safe on pushed branches.${parents.length > 1 ? '\n\nThis is a merge commit: the changes it brought in from the merged branch are undone.' : ''}`,
      'Revert'
    );
    if (!ok) return 'cancelled';
  }
  let error;
  try {
    await gitEdit(root, ['revert', '--no-edit', ...(parents.length > 1 ? ['-m', '1'] : []), commit.hash]);
  } catch (e) {
    error = e;
  }
  return pr.afterLocalMerge(root, error, `Reverted ${quote(commit.subject)}.`);
}

const RESET_MODES = [
  { mode: 'soft', label: '$(git-commit) Keep the changes, staged', description: 'git reset --soft', detail: 'Commits after this one are removed; their changes stay staged, ready to commit again.' },
  { mode: 'mixed', label: '$(edit) Keep the changes, unstaged', description: 'git reset --mixed', detail: 'Commits after this one are removed; their changes stay in your files, unstaged.' },
  { mode: 'hard', label: '$(trash) Discard the commits and all uncommitted changes', description: 'git reset --hard', detail: 'Saves a backup branch first, so the commits can still be recovered.' },
];

async function resetTo(node) {
  const { root, commit } = node;
  await requireNoOperation(root);
  const branch = await branchName(root);
  const head = await revParse(root, 'HEAD');
  if (head === commit.hash) {
    vscode.window.showInformationMessage(`${branch || 'HEAD'} is already at ${commit.short}.`);
    return false;
  }
  const choice = await vscode.window.showQuickPick(RESET_MODES.map((m) => ({ ...m })), { title: `Reset ${branch || 'HEAD'} to ${commit.short} ${quote(commit.subject, 40)}` });
  if (!choice) return false;
  const onBranch = await isAncestor(root, commit.hash, 'HEAD');
  const count = Number((await g.git(root, ['rev-list', '--count', `${commit.hash}..HEAD`])).trim()) || 0;
  const upstream = await upstreamOf(root);
  const pushed = upstream && count && (await isAncestor(root, 'HEAD', upstream));
  const dirty = (await g.git(root, ['status', '--porcelain', '--untracked-files=no'])).split('\n').filter(Boolean).length;
  const backup = choice.mode === 'hard' ? backupName(branch) : undefined;
  const lines = [onBranch ? `${views.plural(count, 'commit')} after ${commit.short} ${count === 1 ? 'is' : 'are'} removed from ${branch || 'HEAD'}.` : `${commit.short} is not on ${branch || 'HEAD'}. Resetting moves the branch onto a different line of history.`, choice.detail];
  if (choice.mode === 'hard' && dirty) lines.push(`Your ${views.plural(dirty, 'uncommitted change')} ${dirty === 1 ? 'is' : 'are'} discarded too, and cannot be recovered.`);
  if (backup) lines.push(`Backup branch: ${backup}`);
  if (pushed) lines.push(`These commits are already on ${upstream}; resetting here doesn't change ${upstream}.`);
  lines.push(`Runs: git reset --${choice.mode} ${commit.short}`);
  if (!(await views.confirm(`Reset ${branch || 'HEAD'} to ${commit.short}?`, lines.join('\n\n'), 'Reset'))) return false;
  if (backup) await g.git(root, ['branch', '--end-of-options', backup, head]);
  try {
    await gitEdit(root, ['reset', `--${choice.mode}`, commit.hash]);
  } catch (e) {
    throw friendlyResetError(e);
  }
  done(`Reset ${branch || 'HEAD'} to ${commit.short}.${backup ? ` The previous state is saved as ${backup}.` : ''}`);
  return true;
}

function validateRefName(value) {
  const v = value.trim();
  if (!v) return 'Enter a name';
  if (v.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{|\/\/|\/$|\.lock$|^\.|\/\./.test(v)) return 'That is not a valid git name';
  return undefined;
}

async function createBranchAt(root, sha, { title, value = '' } = {}) {
  const name = (await vscode.window.showInputBox({ title: title || `Create Branch at ${sha.slice(0, 7)}`, prompt: 'Name for the new branch', value, validateInput: validateRefName }))?.trim();
  if (!name) return undefined;
  if (await g.refExists(root, `refs/heads/${name}`)) throw new Error(`A branch named ${name} already exists.`);
  await g.git(root, ['branch', '--end-of-options', name, sha]);
  views.refreshAll();
  const pick = await vscode.window.showInformationMessage(`Created ${name} at ${sha.slice(0, 7)}.`, 'Switch to It');
  if (pick) {
    await gitEdit(root, ['switch', '--end-of-options', name]);
    done();
  }
  return name;
}

async function createTagAt(node) {
  const { root, commit } = node;
  const name = (await vscode.window.showInputBox({ title: `Create Tag at ${commit.short}`, prompt: 'Tag name, e.g. v1.2.0', validateInput: validateRefName }))?.trim();
  if (!name) return undefined;
  if (await g.refExists(root, `refs/tags/${name}`)) throw new Error(`A tag named ${name} already exists.`);
  const message = await vscode.window.showInputBox({ title: `Create Tag ${name}`, prompt: 'Message for an annotated tag. Leave empty for a lightweight tag.' });
  if (message === undefined) return undefined;
  await g.git(root, message.trim() ? ['tag', '-a', '-m', message.trim(), '--end-of-options', name, commit.hash] : ['tag', '--end-of-options', name, commit.hash]);
  views.refreshAll();
  const pick = await vscode.window.showInformationMessage(`Created tag ${name} at ${commit.short}.`, 'Push Tag to origin');
  if (pick && (await views.confirm(`Push tag ${name} to origin?`, `Runs: git push origin refs/tags/${name}`, 'Push Tag'))) {
    await g.remote(root, ['push', 'origin', `refs/tags/${name}`], (repo) => repo.push('origin', `refs/tags/${name}`));
    vscode.window.showInformationMessage(`Pushed tag ${name}.`);
  }
  return name;
}

async function amendLastCommit(arg) {
  const root = arg?.root || g.requireRepo();
  await requireNoOperation(root);
  const [head] = await g.logCommits(root, ['-1', 'HEAD', '--']);
  if (!head) throw new Error('There is no commit to amend yet.');
  const staged = (await g.git(root, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean).length;
  const subject = await vscode.window.showInputBox({
    title: `Amend ${head.short} ${quote(head.subject, 40)}`,
    prompt: staged ? `Edit the message. Your ${views.plural(staged, 'staged file')} ${staged === 1 ? 'is' : 'are'} added to the commit too.` : 'Edit the message. To add changes as well, stage them first.',
    value: head.subject,
    validateInput: (v) => (v.trim() ? undefined : 'The message cannot be empty'),
  });
  if (subject === undefined) return false;
  if (subject.trim() === head.subject && !staged) {
    vscode.window.showInformationMessage('Nothing to amend: the message is the same and nothing is staged.');
    return false;
  }
  const upstream = await upstreamOf(root);
  if (upstream && (await isAncestor(root, 'HEAD', upstream))) {
    const ok = await views.confirm(`${head.short} is already on ${upstream}. Amend it anyway?`, `Amending rewrites the commit. ${upstream} keeps the old one, so pushing afterwards would need a force-push, which Git Compass never does.`, 'Amend Anyway');
    if (!ok) return false;
  }
  const message = head.body ? `${subject.trim()}\n\n${head.body}` : subject.trim();
  await withMessageFile(message, (file) => gitEdit(root, ['commit', '--amend', '-F', file]));
  done(`Amended ${quote(subject.trim())}. Undo Last Action brings the old commit back.`);
  return true;
}

async function squashFrom(node) {
  const { root, commit } = node;
  await requireNoOperation(root);
  const branch = await branchName(root);
  if (!branch) throw new Error('Check out a branch first; HEAD is detached.');
  const head = await revParse(root, 'HEAD');
  if (head === commit.hash) {
    vscode.window.showInformationMessage('Pick an older commit: squashing combines that commit and every newer one into a single commit.');
    return false;
  }
  if (!(await isAncestor(root, commit.hash, 'HEAD'))) throw new Error(`${commit.short} is not on ${branch}.`);
  const parent = await revParse(root, `${commit.hash}^`);
  const range = parent ? `${parent}..HEAD` : 'HEAD';
  if ((await g.git(root, ['rev-list', '--merges', '-n1', range])).trim()) throw new Error('These commits include a merge commit, which cannot be squashed this way. Use the interactive rebase editor instead.');
  const commits = await g.logCommits(root, [range, '--']);
  const oldestFirst = commits.slice().reverse();
  const subject = await vscode.window.showInputBox({
    title: `Squash ${commits.length} commits into one`,
    prompt: 'Message for the combined commit. The original messages are kept in its description.',
    value: oldestFirst[0].subject,
    validateInput: (v) => (v.trim() ? undefined : 'The message cannot be empty'),
  });
  if (!subject) return false;
  const upstream = await upstreamOf(root);
  const pushed = upstream && (await isAncestor(root, commit.hash, upstream));
  const list = oldestFirst.slice(0, 12).map((c) => `• ${c.short} ${c.subject}`);
  if (oldestFirst.length > 12) list.push(`…and ${oldestFirst.length - 12} more`);
  const detail = [list.join('\n'), pushed ? `Some of these commits are already on ${upstream}. Squashing here doesn't change ${upstream}; pushing afterwards would need a force-push.` : '', 'Your files and staged changes are not touched. Undo Last Action brings the separate commits back.'].filter(Boolean).join('\n\n');
  if (!(await views.confirm(`Squash ${commits.length} commits on ${branch} into one?`, detail, 'Squash'))) return false;
  const message = `${subject.trim()}\n\n${oldestFirst.map((c) => `* ${c.subject}`).join('\n')}\n`;
  const tree = (await g.git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
  const sha = (await withMessageFile(message, (file) => gitEdit(root, ['commit-tree', ...(parent ? ['-p', parent] : []), '-F', file, tree]))).trim();
  await g.git(root, ['update-ref', '-m', `squash: ${commits.length} commits into ${quote(subject.trim())}`, 'HEAD', sha, head]);
  done(`Squashed ${commits.length} commits into ${quote(subject.trim())}.`);
  return sha;
}

// ---- Recovery view ------------------------------------------------------------------

async function deletedCandidates(root, reflog) {
  const seen = new Set();
  const out = [];
  for (const d of views.deletedBranches(root)) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push({ ...d, source: 'git-compass' });
  }
  for (let i = 0; i < reflog.length - 1; i++) {
    const e = reflog[i];
    if (e.kind !== 'checkout' || SHA.test(e.from) || seen.has(e.from)) continue;
    seen.add(e.from);
    out.push({ root, name: e.from, sha: reflog[i + 1].hash, at: e.time ? e.time * 1000 : undefined, source: 'reflog' });
  }
  const result = [];
  for (const d of out) {
    if (result.length >= 20) break;
    if (await g.refExists(root, `refs/heads/${d.name}`)) continue;
    if (!(await g.refExists(root, d.sha))) continue;
    if (d.source === 'reflog') {
      // Only offer branches whose commits would otherwise be lost.
      const contained = (await g.git(root, ['for-each-ref', '--contains', d.sha, '--count=1', '--format=x', 'refs/heads', 'refs/remotes', 'refs/tags']).catch(() => 'x')).trim();
      if (contained) continue;
    }
    result.push(d);
  }
  return result;
}

async function recoveryRoot(view) {
  const repo = g.activeRepo();
  if (!repo) {
    view.tree.message = 'Open a folder that is a git repository.';
    return [];
  }
  const root = repo.rootUri.fsPath;
  const limit = views.limitFor('recovery');
  const reflog = await readReflog(root, 'HEAD', Math.max(limit + 1, 200));
  const deleted = await deletedCandidates(root, reflog);
  const nodes = [];
  if (deleted.length) nodes.push({ type: 'recGroup', id: 'recovery:deleted', label: 'Deleted branches', icon: 'trash', items: deleted.map((d) => ({ type: 'deletedBranch', root, ...d })) });
  const shown = reflog.slice(0, limit).map((entry, i) => ({ type: 'reflog', root, entry, index: i }));
  nodes.push(...shown);
  if (reflog.length > limit) nodes.push({ type: 'loadMore', key: 'recovery', view: 'recovery' });
  if (!reflog.length && !deleted.length) view.tree.message = 'Nothing recorded yet. Commits, merges, resets and branch switches show up here.';
  view.tree.description = reflog.length ? `${views.plural(Math.min(reflog.length, limit), 'action')}` : undefined;
  return nodes;
}

function recoveryItem(node) {
  if (node.type === 'reflog') {
    const e = node.entry;
    const item = new vscode.TreeItem(e.text, T.None);
    item.description = [e.time ? views.shortAgo(e.time) : '', e.short].filter(Boolean).join(' · ');
    item.iconPath = views.icon(e.icon, node.index === 0 ? 'charts.green' : undefined);
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`$(${e.icon}) **`);
    md.appendText(e.text);
    md.appendMarkdown(`**\n\n${e.time ? `${new Date(e.time * 1000).toLocaleString()} · ` : ''}\`${e.short}\``);
    if (e.message) {
      md.appendMarkdown('\n\n');
      md.appendText(`Commit: ${e.message}`);
    }
    md.appendMarkdown(`\n\n_${node.index === 0 ? 'This is where you are now.' : 'Right-click to go back to this point or start a branch here.'}_`);
    item.tooltip = md;
    item.contextValue = node.index === 0 ? 'reflog:current' : 'reflog';
    item.command = { command: 'gitCompass.recovery.showCommit', title: 'Show Commit', arguments: [node] };
    return item;
  }
  if (node.type === 'deletedBranch') {
    const item = new vscode.TreeItem(node.name, T.None);
    item.description = [node.at ? `deleted ${views.shortAgo(node.at / 1000)} ago` : 'no longer exists', node.sha.slice(0, 7)].join(' · ');
    item.iconPath = views.icon('git-branch', 'list.warningForeground');
    item.tooltip = `${node.name} pointed at ${node.sha.slice(0, 7)}.${node.source === 'reflog' ? ' Found in your branch-switch history; its commits are not on any other branch.' : ''}\nRestore it to bring the branch back.`;
    item.contextValue = 'deletedBranch';
    item.command = { command: 'gitCompass.recovery.restoreBranch', title: 'Restore Branch', arguments: [node] };
    return item;
  }
  if (node.type === 'recGroup') {
    const item = new vscode.TreeItem(node.label, T.Expanded);
    item.id = node.id;
    item.description = String(node.items.length);
    item.iconPath = views.icon(node.icon);
    item.contextValue = 'recGroup';
    return item;
  }
  return views.toTreeItem(node);
}

function createRecoveryView(context) {
  const view = new views.View(context, VIEW_ID, recoveryRoot);
  view.getTreeItem = recoveryItem;
  view.getChildren = async (node) => {
    try {
      if (node) return node.items || [];
      view.tree.message = undefined;
      return await recoveryRoot(view);
    } catch (e) {
      return [views.msg(e.message, 'error')];
    }
  };
  views.views.recovery = view;
  return view;
}

async function restoreToEntry(node) {
  const { root, entry } = node;
  await requireNoOperation(root);
  const branch = await branchName(root);
  const options = [
    ...(branch ? [{ id: 'move', label: `$(history) Move ${branch} back to this point`, detail: `git reset --keep ${entry.short}. Your current state is saved as a backup branch first.` }] : []),
    { id: 'branch', label: '$(git-branch) Create a new branch here…', detail: 'Leaves your current branch as it is.' },
    { id: 'detach', label: '$(debug-disconnect) Check out this point (detached)', detail: 'Look around without changing any branch.' },
  ];
  const pick = await vscode.window.showQuickPick(options, { title: `${entry.text} · ${entry.short}` });
  if (!pick) return false;
  if (pick.id === 'branch') return !!(await createBranchAt(root, entry.hash, { title: `Create Branch at ${entry.short}` }));
  if (pick.id === 'detach') {
    await gitEdit(root, ['switch', '--detach', entry.hash]);
    done(`Checked out ${entry.short}. Create a branch here if you want to keep working from it.`);
    return true;
  }
  const backup = backupName(branch);
  const ok = await views.confirm(`Move ${branch} back to ${entry.short}?`, `${entry.text}\n\nYour current ${branch} is saved as ${backup}. Uncommitted changes are kept; git stops if they touch files that would change.\n\nRuns: git reset --keep ${entry.short}`, 'Move Back');
  if (!ok) return false;
  await g.git(root, ['branch', '--end-of-options', backup, 'HEAD']);
  try {
    await gitEdit(root, ['reset', (await filesMatch(root, entry.hash)) ? '--soft' : '--keep', entry.hash]);
  } catch (e) {
    await g.git(root, ['branch', '-D', '--end-of-options', backup]).catch(() => {});
    throw friendlyResetError(e);
  }
  done(`Moved ${branch} back to ${entry.short}. The previous state is saved as ${backup}.`);
  return true;
}

async function restoreBranch(node) {
  const { root, sha } = node;
  let name = node.name;
  if (await g.refExists(root, `refs/heads/${name}`)) {
    name = (await vscode.window.showInputBox({ title: 'Restore Branch', prompt: `${name} exists again. Choose another name.`, value: `${name}-restored`, validateInput: validateRefName }))?.trim();
    if (!name) return undefined;
  }
  await g.git(root, ['branch', '--end-of-options', name, sha]);
  await views.forgetDeletedBranch(root, node.name);
  views.refreshAll();
  const pick = await vscode.window.showInformationMessage(`Restored ${name} at ${sha.slice(0, 7)}.`, 'Switch to It');
  if (pick) {
    await gitEdit(root, ['switch', '--end-of-options', name]);
    done();
  }
  return name;
}

function asCommitNode(node) {
  return { root: node.root, commit: { hash: node.entry?.hash || node.sha, short: (node.entry?.hash || node.sha).slice(0, 7), subject: node.entry?.message || node.name, parents: [] } };
}

function register(context) {
  createRecoveryView(context);
  const commands = {
    undoLastAction,
    'commit.undo': undoCommit,
    'commit.amend': amendLastCommit,
    'commit.cherryPick': cherryPick,
    'commit.revert': (node) => revertCommit(node),
    'commit.resetTo': resetTo,
    'commit.createBranch': (node) => createBranchAt(node.root, node.commit.hash),
    'commit.createTag': createTagAt,
    'commit.squashFrom': squashFrom,
    'recovery.restore': restoreToEntry,
    'recovery.createBranch': (node) => createBranchAt(node.root, node.entry?.hash || node.sha),
    'recovery.restoreBranch': restoreBranch,
    'recovery.forget': async (node) => {
      await views.forgetDeletedBranch(node.root, node.name);
      views.views.recovery.refresh();
    },
    'recovery.showCommit': (node) => g.showWholeCommit(node.root, asCommitNode(node).commit.hash),
    'recovery.copySha': (node) => vscode.env.clipboard.writeText(asCommitNode(node).commit.hash),
  };
  for (const [name, fn] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`gitCompass.${name}`, async (...args) => {
        try {
          await g.getGitApi();
          return await fn(...args);
        } catch (e) {
          vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
          return undefined;
        }
      })
    );
  }
}

module.exports = {
  register,
  VIEW_ID,
  describeReflog,
  parseReflog,
  readReflog,
  planUndo,
  undoArgs,
  undoLastAction,
  undoCommit,
  cherryPick,
  revertCommit,
  resetTo,
  createBranchAt,
  createTagAt,
  amendLastCommit,
  squashFrom,
  deletedCandidates,
  restoreToEntry,
  restoreBranch,
  backupName,
  validateRefName,
};

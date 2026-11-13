const vscode = require('vscode');
const path = require('path');
const g = require('./git');
const views = require('./views');

const optional = (name) => {
  try {
    return require(name);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && e.message.includes(name)) return undefined;
    throw e;
  }
};

let statusItem;
let refreshTimer;
let statusToken = 0;
const countCache = new Map();

// Counting ahead/behind walks history, which is slow on big repositories. The answer
// only changes when HEAD or the base moves, so cache it by both commits.
async function aheadBehind(root, ref, headCommit) {
  const baseCommit = (await g.git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => '')).trim();
  const key = `${root}\0${ref}\0${baseCommit}\0${headCommit}`;
  if (!baseCommit || !headCommit) countCache.delete(key);
  if (!countCache.has(key)) {
    if (countCache.size > 50) countCache.clear();
    countCache.set(
      key,
      g.git(root, ['rev-list', '--left-right', '--count', `${ref}...HEAD`]).then((out) => {
        const [behind, ahead] = out.trim().split(/\s+/).map(Number);
        return { ref, ahead, behind };
      })
    );
  }
  return countCache.get(key).catch((e) => {
    countCache.delete(key);
    throw e;
  });
}

function scheduleStatus() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshStatus().catch(() => statusItem.hide()), 300);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Turns the repository state into a plain-language status: what the status bar says,
// why, and what to do next. Pure, so every situation can be tested.
function describeStatus(s) {
  const actions = [];
  let text;
  let tone;
  let summary;
  const createBranch = { title: 'Create a branch', icon: 'git-branch-create', command: 'git.branch' };
  if (s.detached) {
    text = `$(debug-disconnect) Not on a branch (${s.short})`;
    tone = 'warning';
    summary = `You are on commit \`${s.short}\`, not on a branch. New commits made here are easy to lose, so create a branch first.`;
    actions.push(createBranch);
  } else if (s.isProtected || s.isBase) {
    const why = s.isProtected ? 'a protected branch' : 'your base branch';
    if (s.changed) {
      text = `$(warning) Editing ${s.branch} directly · ${plural(s.changed, 'change')}`;
      tone = 'warning';
      summary = `**${s.branch}** is ${why}. Changes should reach it through a pull request, so move your ${plural(s.changed, 'uncommitted change')} to a new branch before committing.`;
      actions.push({ ...createBranch, title: 'Move my changes to a new branch' });
    } else if (s.unpushed) {
      text = `$(warning) ${plural(s.unpushed, 'commit')} on ${s.branch} not pushed`;
      tone = 'warning';
      summary = `You committed directly on **${s.branch}**, which is ${why}. Put the work on a branch and open a pull request instead of pushing to ${s.branch}.`;
      actions.push({ ...createBranch, title: 'Create a branch from here' });
    } else if (s.incoming) {
      text = `$(arrow-down) ${s.branch} · ${plural(s.incoming, 'new commit')} on origin`;
      summary = `Others pushed ${plural(s.incoming, 'commit')} to **${s.branch}**. Pull to get them before you start new work.`;
      actions.push({ title: 'Pull', icon: 'cloud-download', command: 'git.pull' });
    } else {
      text = `$(check) ${s.branch} is up to date`;
      summary = `Nothing to do on **${s.branch}**. Start new work on a branch.`;
      actions.push({ ...createBranch, title: 'Start new work on a branch' });
    }
  } else if (s.base) {
    const parts =
      s.ahead && s.behind
        ? `${s.ahead} ahead, ${s.behind} behind ${s.base}`
        : s.ahead
          ? `${plural(s.ahead, 'commit')} ahead of ${s.base}`
          : s.behind
            ? `${s.behind} behind ${s.base}`
            : `same as ${s.base}`;
    text = `$(git-branch) ${s.branch} · ${parts}`;
    const lines = [];
    if (s.ahead) lines.push(`Your branch has ${plural(s.ahead, 'commit')} that **${s.base}** does not.`);
    if (s.behind) lines.push(`**${s.base}** has ${plural(s.behind, 'new commit')} you do not have yet. Update now to avoid conflicts later.`);
    if (!s.ahead && !s.behind) lines.push(`Your branch matches **${s.base}**. Commit your work here, then open a pull request.`);
    summary = lines.join(' ');
    if (s.behind) actions.push({ title: `Update from ${s.base}`, icon: 'repo-sync', command: 'gitCompass.branch.updateFromBase' });
    if (s.ahead) actions.push({ title: 'Create pull request', icon: 'git-pull-request-create', command: 'gitCompass.pr.create' });
    actions.push({ title: `Compare with ${s.base}`, icon: 'git-compare', command: 'gitCompass.compareBranch' });
  } else {
    text = `$(git-branch) ${s.branch}`;
    summary = `You are on **${s.branch}**. No base branch was found to compare with; set \`gitCompass.baseBranches\` to choose one.`;
  }
  if (s.worktreeCount > 1) text = `$(folder) ${s.worktree} · ${text.replace(/^\$\([^)]+\) /, '')}`;
  return { text, tone, summary, actions };
}

let lastStatus;

async function refreshStatus() {
  if (!g.config().get('statusBar.branch.enabled', true)) return statusItem.hide();
  const repo = g.activeRepo();
  if (!repo) return statusItem.hide();
  const token = ++statusToken;
  const root = repo.rootUri.fsPath;
  const { HEAD: head, workingTreeChanges, indexChanges, mergeChanges, untrackedChanges = [] } = repo.state;
  const changed = new Set([...workingTreeChanges, ...indexChanges, ...mergeChanges, ...untrackedChanges].map((c) => c.uri.toString())).size;
  const [bases, worktrees] = await Promise.all([g.resolveBases(root), g.git(root, ['worktree', 'list', '--porcelain']).then(g.parseWorktrees).catch(() => [])]);
  const baseRef = bases[0];
  const base = baseRef ? g.shortRef(baseRef) : undefined;
  const branch = head?.name;
  const isBase = !!branch && !!base && branch === base;
  const counts = baseRef && branch && !isBase ? await aheadBehind(root, baseRef, head?.commit) : { ahead: 0, behind: 0 };
  if (token !== statusToken) return;
  const s = {
    branch,
    detached: !branch,
    short: (head?.commit || '').slice(0, 7),
    isProtected: !!branch && g.config().get('protectedBranches', []).includes(branch),
    isBase,
    base,
    ahead: counts.ahead,
    behind: counts.behind,
    unpushed: head?.ahead || 0,
    incoming: head?.behind || 0,
    changed,
    worktree: path.basename(root),
    worktreeCount: worktrees.length,
  };
  const d = describeStatus(s);
  lastStatus = d;
  statusItem.text = d.text;
  statusItem.backgroundColor = d.tone === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const tip = new vscode.MarkdownString('', true);
  tip.isTrusted = { enabledCommands: [...d.actions.map((a) => a.command), 'gitCompass.menu'] };
  tip.appendMarkdown(d.summary);
  if (d.actions.length) tip.appendMarkdown(`\n\n${d.actions.map((a) => `[$(${a.icon}) ${a.title}](command:${a.command})`).join(' &nbsp;&nbsp; ')}`);
  const facts = [];
  if (changed && !(s.isProtected || s.isBase)) facts.push(`$(edit) ${plural(changed, 'file')} changed, not committed yet`);
  if (s.worktreeCount > 1) facts.push(`$(folder) This window is the **${s.worktree}** worktree (one of ${s.worktreeCount})`);
  if (facts.length) tip.appendMarkdown(`\n\n${facts.join('  \n')}`);
  tip.appendMarkdown('\n\n---\n\n[$(compass) More Git Compass actions](command:gitCompass.menu)');
  statusItem.tooltip = tip;
  statusItem.show();
}

async function menu() {
  const hasFile = vscode.window.activeTextEditor?.document.uri.scheme === 'file';
  const suggested = (lastStatus?.actions || []).map((a) => ({ label: `$(${a.icon}) ${a.title}`, command: a.command }));
  const items = [
    ...(suggested.length ? [{ label: 'Suggested', kind: vscode.QuickPickItemKind.Separator }, ...suggested, { label: 'More', kind: vscode.QuickPickItemKind.Separator }] : []),
    { label: '$(git-commit) Commits', command: `${views.VIEW.commits}.focus` },
    { label: '$(type-hierarchy) Commit Graph', command: 'gitCompass.showGraph' },
    { label: '$(discard) Undo Last Action…', command: 'gitCompass.undoLastAction' },
    { label: '$(history) Recovery', command: 'gitCompass.views.recovery.focus' },
    { label: '$(repo) Worktrees', command: 'gitCompass.worktrees' },
    { label: '$(git-compare) Compare Branch with…', command: 'gitCompass.compareBranch' },
    { label: '$(search) Search Commits…', command: 'gitCompass.search' },
    { label: '$(git-pull-request-create) Create Pull Request…', command: 'gitCompass.pr.create' },
    { label: '$(checklist) Check Branch Before Push', command: 'gitCompass.prePush.check' },
    { label: '$(clear-all) Clean Up Branches…', command: 'gitCompass.branch.cleanup' },
    ...(hasFile
      ? [
          { label: '$(history) File History', command: 'gitCompass.fileHistory' },
          { label: '$(list-selection) Line History', command: 'gitCompass.lineHistory' },
          { label: '$(diff) Compare File with Branch…', command: 'gitCompass.compareFile' },
          { label: '$(organization) Code Owners and Contributors', command: 'gitCompass.showOwnership' },
        ]
      : []),
    { label: '$(account) Switch Git Identity…', command: 'gitCompass.identity.switch' },
    { label: '$(copy) Copy Branch Name', command: 'copyBranch' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: lastStatus ? lastStatus.text.replace(/\$\([^)]+\) ?/g, '') : 'Git Compass' });
  if (!pick) return;
  if (pick.command === 'copyBranch') {
    const name = g.activeRepo()?.state.HEAD?.name;
    if (name) await vscode.env.clipboard.writeText(name);
    return;
  }
  await vscode.commands.executeCommand(pick.command);
}

async function activate(context) {
  g.registerShared(context);
  statusItem = vscode.window.createStatusBarItem('gitCompass.status', vscode.StatusBarAlignment.Left, 99);
  statusItem.name = 'Git Compass Branch';
  statusItem.command = 'gitCompass.menu';
  context.subscriptions.push(statusItem, vscode.commands.registerCommand('gitCompass.menu', menu));

  const api = await g.getGitApi();
  if (!api) return;
  views.register(context);
  for (const name of ['./forge', './editor', './visualHistory', './rebase', './ai', './conflicts', './pullRequests', './identities', './prePush', './recovery', './cleanup', './ownership', './graph']) optional(name)?.register(context);

  g.onRepoChange(context, scheduleStatus, 300);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(scheduleStatus),
    vscode.window.onDidChangeWindowState((s) => s.focused && scheduleStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gitCompass')) return;
      g.clearBaseCache();
      scheduleStatus();
      views.refreshAll();
    })
  );
  scheduleStatus();
}

module.exports = { activate, deactivate() {}, describeStatus };

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

function scheduleStatus() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshStatus().catch(() => statusItem.hide()), 300);
}

async function refreshStatus() {
  if (!g.config().get('statusBar.branch.enabled', true)) return statusItem.hide();
  const repo = g.activeRepo();
  if (!repo) return statusItem.hide();
  const token = ++statusToken;
  const root = repo.rootUri.fsPath;
  const { HEAD: head, workingTreeChanges, indexChanges, mergeChanges, untrackedChanges = [] } = repo.state;
  const branch = g.currentBranch(root);
  const changed = new Set([...workingTreeChanges, ...indexChanges, ...mergeChanges, ...untrackedChanges].map((c) => c.uri.toString())).size;
  const counts = await Promise.all(
    (await g.resolveBases(root)).map(async (ref) => {
      const [behind, ahead] = (await g.git(root, ['rev-list', '--left-right', '--count', `${ref}...HEAD`])).trim().split(/\s+/).map(Number);
      return { ref, ahead, behind };
    })
  );
  if (token !== statusToken) return;
  const worktree = path.basename(root);
  const onProtected = !!head?.name && g.config().get('protectedBranches', []).includes(head.name);
  const first = counts[0];
  statusItem.text =
    `$(${onProtected ? 'warning' : 'git-branch'}) ${worktree} · ${branch}` +
    (first ? `  $(arrow-up)${first.ahead} $(arrow-down)${first.behind} ${g.shortRef(first.ref)}` : '') +
    (changed ? `  $(circle-filled) ${changed}` : '');
  const tip = new vscode.MarkdownString('', true);
  tip.appendMarkdown(`**Worktree** \`${worktree}\`  \n${root}\n\n**Branch** \`${branch}\``);
  if (onProtected) tip.appendMarkdown(' — protected branch');
  if (counts.length) {
    tip.appendMarkdown('\n\n| compared with | ahead | behind |\n|---|---:|---:|\n');
    for (const c of counts) tip.appendMarkdown(`| ${c.ref} | ${c.ahead} | ${c.behind} |\n`);
  }
  tip.appendMarkdown(`\n\n**Uncommitted files** ${changed}\n\nClick for Git Compass actions.`);
  statusItem.tooltip = tip;
  statusItem.backgroundColor = onProtected ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  statusItem.show();
}

async function menu() {
  const hasFile = vscode.window.activeTextEditor?.document.uri.scheme === 'file';
  const items = [
    { label: '$(git-commit) Commits', command: `${views.VIEW.commits}.focus` },
    { label: '$(repo) Worktrees', command: 'gitCompass.worktrees' },
    { label: '$(git-compare) Compare Branch with…', command: 'gitCompass.compareBranch' },
    { label: '$(search) Search Commits…', command: 'gitCompass.search' },
    { label: '$(git-pull-request-create) Create Pull Request…', command: 'gitCompass.pr.create' },
    ...(hasFile
      ? [
          { label: '$(history) File History', command: 'gitCompass.fileHistory' },
          { label: '$(list-selection) Line History', command: 'gitCompass.lineHistory' },
          { label: '$(diff) Compare File with Branch…', command: 'gitCompass.compareFile' },
        ]
      : []),
    { label: '$(copy) Copy Branch Name', command: 'copyBranch' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Git Compass' });
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
  for (const name of ['./editor', './visualHistory', './rebase', './ai', './conflicts', './pullRequests']) optional(name)?.register(context);

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

module.exports = { activate, deactivate() {} };

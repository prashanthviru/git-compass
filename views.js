const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const g = require('./git');

const PAGE = 50;
const RESULT_CAP = 200;
const VIEW = {
  commits: 'gitCompass.views.commits',
  branches: 'gitCompass.views.branches',
  remotes: 'gitCompass.views.remotes',
  stashes: 'gitCompass.views.stashes',
  tags: 'gitCompass.views.tags',
  worktrees: 'gitCompass.views.worktrees',
  launchpad: 'gitCompass.views.launchpad',
  fileHistory: 'gitCompass.views.fileHistory',
  lineHistory: 'gitCompass.views.lineHistory',
  compare: 'gitCompass.views.compare',
  search: 'gitCompass.views.search',
};
const T = vscode.TreeItemCollapsibleState;
const SEP = '%1f';
const limits = new Map();
const views = {};
const state = { file: undefined, line: undefined, comparisons: [], searches: [] };
let memento;

const SEARCH_MODES = [
  { id: 'message', label: 'Message', placeholder: 'Words in the commit message', args: (q) => ['-i', '--grep', q] },
  { id: 'author', label: 'Author', placeholder: 'Name or email', args: (q) => ['-i', '--author', q] },
  { id: 'file', label: 'File', placeholder: 'File name or path, e.g. product.js', args: (q) => ['--', /[/*]/.test(q) ? q : `:(glob,icase)**/*${q}*`] },
  { id: 'changes', label: 'Code Added or Removed', placeholder: 'Exact text (git log -S)', args: (q) => ['-S', q] },
  { id: 'regex', label: 'Code Matching Regex', placeholder: 'Regular expression (git log -G)', args: (q) => ['-G', q] },
  { id: 'sha', label: 'Commit SHA', placeholder: 'Full or short SHA', args: (q) => ['-n1', q, '--'] },
];

const LAUNCHPAD_GROUPS = [
  { id: 'pinned', label: 'Pinned', icon: 'pinned' },
  { id: 'review', label: 'Needs Your Review', icon: 'eye', color: 'charts.blue' },
  { id: 'blocked', label: 'Blocked', icon: 'error', color: 'charts.red' },
  { id: 'ready', label: 'Ready to Merge', icon: 'check-all', color: 'charts.green' },
  { id: 'waiting', label: 'Waiting for Review', icon: 'clock', color: 'charts.yellow' },
  { id: 'assigned', label: 'Assigned to You', icon: 'person' },
  { id: 'draft', label: 'Drafts', icon: 'git-pull-request-draft' },
  { id: 'snoozed', label: 'Snoozed', icon: 'bell-slash', collapsed: true },
];
const PR_FIELDS = 'number,title,url,author,headRefName,baseRefName,isDraft,reviewDecision,mergeable,isCrossRepository,statusCheckRollup,additions,deletions,updatedAt';
const FAILED_CHECKS = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
const RUNNING_CHECKS = ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED', ''];
const SNOOZE_OPTIONS = [
  { label: '1 hour', ms: 3600e3 },
  { label: '4 hours', ms: 4 * 3600e3 },
  { label: 'Until tomorrow', until: () => new Date(new Date().setHours(24, 0, 0, 0)).getTime() + 9 * 3600e3 },
  { label: '1 week', ms: 7 * 86400e3 },
  { label: 'Until I unsnooze', ms: Infinity },
];
let globalMemento;
let launchpadCache;
let launchpadStatus;

function icon(id, color) {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

function msg(text, iconId = 'info') {
  return { type: 'message', text, icon: iconId };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function relativeDate(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  for (const [n, u] of [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']]) {
    if (s >= n) return `${plural(Math.floor(s / n), u)} ago`;
  }
  return 'just now';
}

function limitFor(key) {
  return limits.get(key) || PAGE;
}

function gh(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? 'Install the GitHub CLI (gh) and run gh auth login to see pull requests.' : (stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function rows(out) {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\x1f'));
}

class View {
  constructor(context, key, children) {
    this.key = key;
    this.children = children;
    this.dirty = false;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.tree = vscode.window.createTreeView(VIEW[key], { treeDataProvider: this, showCollapseAll: true });
    this.tree.onDidChangeVisibility((e) => {
      if (e.visible && this.dirty) {
        this.dirty = false;
        this.emitter.fire();
      }
    });
    context.subscriptions.push(this.tree, this.emitter);
  }

  getTreeItem(node) {
    return toTreeItem(node);
  }

  async getChildren(node) {
    try {
      if (node) return await nodeChildren(node);
      this.tree.message = undefined;
      return await this.children(this);
    } catch (e) {
      return [msg(e.message, 'error')];
    }
  }

  refresh() {
    if (!this.tree.visible) {
      this.dirty = true;
      return;
    }
    this.emitter.fire();
  }
}

function commitNodes(root, commits, { key, view, limit = PAGE, file, currentRel, unpushed } = {}) {
  const nodes = commits.slice(0, limit).map((commit) => ({
    type: 'commit',
    root,
    commit,
    file: file ? commit.change || { status: 'M', oldPath: file, path: file } : undefined,
    currentRel,
    unpushed: !!unpushed?.has(commit.hash),
  }));
  if (commits.length > limit) nodes.push(key ? { type: 'loadMore', key, view } : msg(`Showing the first ${limit} commits`));
  return nodes;
}

async function refCommits(root, ref, view) {
  const key = `${view}:${ref}`;
  const limit = limitFor(key);
  const commits = await g.logCommits(root, [`-n${limit + 1}`, ref, '--']);
  return commits.length ? commitNodes(root, commits, { key, view, limit }) : [msg('No commits')];
}

function fileNode(type, extra, change) {
  return { type, change, ...extra };
}

function fileItem(node, contextValue) {
  const ch = node.change;
  const item = new vscode.TreeItem(g.statusUri(ch.path, ch.status), T.None);
  const dir = path.posix.dirname(ch.path);
  item.description = ch.status === 'R' ? `← ${ch.oldPath}` : dir === '.' ? '' : dir;
  item.iconPath = vscode.ThemeIcon.File;
  item.tooltip = `${g.STATUS_LABEL[ch.status] || ch.status}: ${ch.status === 'R' ? `${ch.oldPath} → ` : ''}${ch.path}`;
  item.contextValue = contextValue;
  item.command = { command: 'gitCompass.openChanges', title: 'Open Changes', arguments: [node] };
  return item;
}

function toTreeItem(node) {
  switch (node.type) {
    case 'commit': {
      const c = node.commit;
      const item = new vscode.TreeItem(c.subject || '(no message)', node.file ? T.None : T.Collapsed);
      item.description = `${node.unpushed ? '↑ ' : ''}${c.author}, ${c.date}`;
      item.tooltip = g.commitTooltip(c);
      item.iconPath = node.unpushed ? icon('git-commit', 'charts.yellow') : icon(c.parents.length > 1 ? 'git-merge' : 'git-commit');
      item.contextValue = node.file ? 'commit+file' : 'commit';
      if (node.file) item.command = { command: 'gitCompass.openChanges', title: 'Open Changes', arguments: [node] };
      return item;
    }
    case 'commitFile':
      return fileItem(node, 'commitFile');
    case 'stashFile':
      return fileItem(node, 'stashFile');
    case 'compareFile':
      return fileItem(node, 'compareFile');
    case 'uncommitted': {
      const item = new vscode.TreeItem('Uncommitted Changes', T.None);
      item.description = 'Working Tree';
      item.iconPath = icon('circle-outline', 'gitDecoration.modifiedResourceForeground');
      item.contextValue = 'uncommitted';
      item.command = { command: 'gitCompass.openChanges', title: 'Open Changes', arguments: [node] };
      return item;
    }
    case 'loadMore': {
      const item = new vscode.TreeItem('Load more…', T.None);
      item.iconPath = icon('fold-down');
      item.command = { command: 'gitCompass.loadMore', title: 'Load More', arguments: [node] };
      return item;
    }
    case 'message': {
      const item = new vscode.TreeItem(node.text, T.None);
      item.iconPath = icon(node.icon);
      item.tooltip = node.text;
      return item;
    }
    case 'branch': {
      const b = node.branch;
      const item = new vscode.TreeItem(node.remote ? b.name.slice(b.name.indexOf('/') + 1) : b.name, T.Collapsed);
      item.description = [b.track, b.date].filter(Boolean).join(' · ');
      item.iconPath = b.current ? icon('check', 'charts.green') : icon('git-branch');
      const md = new vscode.MarkdownString('', true);
      md.appendMarkdown(`$(git-branch) **${b.name}**${b.current ? ' (current)' : ''}\n\n`);
      if (b.upstream) md.appendMarkdown(`Tracking \`${b.upstream}\`${b.track ? ` — ${b.track}` : ''}\n\n`);
      if (b.subject) {
        md.appendText(b.subject);
        md.appendMarkdown(` — ${b.date}`);
      }
      item.tooltip = md;
      item.contextValue = node.remote ? 'branch:remote' : b.current ? 'branch:current' : 'branch:local';
      return item;
    }
    case 'remote': {
      const item = new vscode.TreeItem(node.name, node.name === 'origin' ? T.Expanded : T.Collapsed);
      item.description = node.url;
      item.iconPath = icon('cloud');
      item.contextValue = 'remote';
      return item;
    }
    case 'stash': {
      const s = node.stash;
      const item = new vscode.TreeItem(s.subject.replace(/^(WIP on|On) [^:]+: /, ''), T.Collapsed);
      item.description = `${s.ref} · ${s.date}`;
      item.tooltip = `${s.ref}\n${s.subject}\n${s.date}`;
      item.iconPath = icon('archive');
      item.contextValue = 'stash';
      return item;
    }
    case 'tag': {
      const item = new vscode.TreeItem(node.name, T.Collapsed);
      item.description = node.date;
      item.tooltip = node.subject ? `${node.name}\n${node.subject}` : node.name;
      item.iconPath = icon('tag');
      item.contextValue = 'tag';
      return item;
    }
    case 'worktree': {
      const { wt, info, current, main } = node;
      const item = new vscode.TreeItem(wt.branch || `detached @ ${wt.head.slice(0, 7)}`, T.None);
      const parts = [path.basename(wt.path)];
      if (info.ahead !== undefined) parts.push(`↑${info.ahead} ↓${info.behind} ${g.shortRef(node.base)}`);
      if (info.changed) parts.push(`● ${info.changed}`);
      item.description = parts.join('  ');
      item.iconPath = wt.prunable ? icon('warning', 'list.warningForeground') : current ? icon('folder-active', 'charts.green') : icon(main ? 'repo' : 'folder');
      const md = new vscode.MarkdownString('', true);
      md.appendMarkdown(`$(folder) **${path.basename(wt.path)}**${current ? ' (this window)' : ''}${main ? ' · main worktree' : ''}\n\n${wt.path}\n\n`);
      md.appendMarkdown(`$(git-branch) ${wt.branch || `detached at ${wt.head.slice(0, 7)}`}\n\n`);
      if (info.ahead !== undefined) md.appendMarkdown(`${info.ahead} ahead, ${info.behind} behind \`${node.base}\`\n\n`);
      if (info.changed !== undefined) md.appendMarkdown(`${plural(info.changed, 'uncommitted file')}\n\n`);
      if (wt.locked) md.appendMarkdown('$(lock) Locked\n\n');
      if (wt.prunable) md.appendMarkdown('$(warning) Folder is missing; removing it prunes the entry\n\n');
      item.tooltip = md;
      item.contextValue = current ? 'worktree:current' : main ? 'worktree:main' : 'worktree';
      return item;
    }
    case 'compare': {
      const item = new vscode.TreeItem(`${g.currentBranch(node.root)} ↔ ${node.ref}`, T.Expanded);
      item.id = node.id;
      item.description = 'incl. working tree';
      item.iconPath = icon('git-compare');
      item.contextValue = 'compare';
      return item;
    }
    case 'group': {
      const empty = node.files ? !node.files.length : !node.count;
      const item = new vscode.TreeItem(node.label, empty ? T.None : T.Collapsed);
      item.id = node.id;
      item.description = node.description;
      item.iconPath = icon(node.icon);
      item.contextValue = 'group';
      return item;
    }
    case 'search': {
      const item = new vscode.TreeItem(`${node.label}: ${node.query}`, T.Expanded);
      item.id = node.id;
      item.description = node.results ? plural(Math.min(node.results.length, RESULT_CAP), 'result') + (node.results.length > RESULT_CAP ? '+' : '') : '';
      item.iconPath = icon('search');
      item.contextValue = 'search';
      return item;
    }
    case 'prGroup': {
      const item = new vscode.TreeItem(node.group.label, node.group.collapsed ? T.Collapsed : T.Expanded);
      item.id = `launchpad:${node.group.id}`;
      item.description = String(node.items.length);
      item.iconPath = icon(node.group.icon, node.group.color);
      item.contextValue = 'prGroup';
      return item;
    }
    case 'pr': {
      const { pr, info } = node;
      const item = new vscode.TreeItem(`#${pr.number} ${pr.title}`, T.None);
      item.description = [info.mine ? '' : pr.author?.login, ...info.badges, relativeDate(pr.updatedAt)].filter(Boolean).join(' · ');
      const group = LAUNCHPAD_GROUPS.find((x) => x.id === info.category);
      item.iconPath = pr.isDraft ? icon('git-pull-request-draft') : icon('git-pull-request', group?.color);
      const md = new vscode.MarkdownString('', true);
      md.appendMarkdown(`$(git-pull-request) **#${pr.number}** `);
      md.appendText(pr.title);
      md.appendMarkdown(`\n\n\`${pr.headRefName}\` → \`${pr.baseRefName}\` · ${pr.author?.login || ''} · updated ${relativeDate(pr.updatedAt)}\n\n`);
      md.appendMarkdown(`**${group?.label || 'Open'}** — ${info.badges.join(' · ') || 'no checks or reviews yet'}`);
      if (info.snoozedUntil) md.appendMarkdown(`\n\n$(bell-slash) Snoozed ${info.snoozedUntil === Infinity ? 'until you unsnooze it' : `until ${new Date(info.snoozedUntil).toLocaleString()}`}`);
      item.tooltip = md;
      item.contextValue = ['pr', info.pinned && 'pinned', info.snoozedUntil && 'snoozed', info.canMerge && 'mergeable'].filter(Boolean).join(':');
      item.command = { command: 'gitCompass.pr.open', title: 'Open Pull Request', arguments: [node] };
      return item;
    }
    default:
      return new vscode.TreeItem('?');
  }
}

async function nodeChildren(node) {
  switch (node.type) {
    case 'commit':
      return (await g.commitFiles(node.root, node.commit.hash)).map((change) => fileNode('commitFile', { root: node.root, commit: node.commit }, change));
    case 'branch':
      return refCommits(node.root, node.ref, node.view);
    case 'tag':
      return refCommits(node.root, `refs/tags/${node.name}`, 'tags');
    case 'remote':
      return remoteBranches(node);
    case 'stash': {
      const changes = g.parseNameStatus(await g.git(node.root, ['stash', 'show', '--name-status', node.stash.ref]));
      return changes.map((change) => fileNode('stashFile', { root: node.root, stash: node.stash }, change));
    }
    case 'compare':
      return compareGroups(node);
    case 'group':
      return groupChildren(node);
    case 'search':
      return searchResults(node);
    case 'prGroup':
      return node.items;
    default:
      return [];
  }
}

function repoOrMessage(view) {
  const repo = g.activeRepo();
  if (!repo) view.tree.message = 'Open a folder that is a git repository.';
  return repo;
}

async function unpushedCommits(root, head) {
  if (!head?.name) return { set: new Set(), upstream: undefined };
  const upstream = head.upstream ? `${head.upstream.remote}/${head.upstream.name}` : (await g.refExists(root, `origin/${head.name}`)) ? `origin/${head.name}` : undefined;
  if (!upstream) return { set: undefined, upstream };
  const out = await g.git(root, ['rev-list', `${upstream}..HEAD`]);
  return { set: new Set(out.split('\n').filter(Boolean)), upstream };
}

async function commitsRoot(view) {
  const repo = repoOrMessage(view);
  if (!repo) return [];
  const root = repo.rootUri.fsPath;
  const head = repo.state.HEAD;
  const limit = limitFor('commits');
  const [commits, unpushed] = await Promise.all([g.logCommits(root, [`-n${limit + 1}`]), unpushedCommits(root, head)]);
  const ahead = unpushed.set?.size;
  view.tree.description = `${g.currentBranch(root)}${unpushed.upstream ? (ahead ? ` · ${ahead} to push` : ' · up to date') : ' · not published'}`;
  return commitNodes(root, commits, { key: 'commits', view: 'commits', limit, unpushed: unpushed.set });
}

function formatTrack(track) {
  if (!track) return '';
  if (track === 'gone') return 'upstream gone';
  const ahead = /ahead (\d+)/.exec(track)?.[1];
  const behind = /behind (\d+)/.exec(track)?.[1];
  return [ahead && `↑${ahead}`, behind && `↓${behind}`].filter(Boolean).join(' ');
}

async function branchesRoot(view) {
  const repo = repoOrMessage(view);
  if (!repo) return [];
  const root = repo.rootUri.fsPath;
  const out = await g.git(root, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=%(refname:short)${SEP}%(upstream:short)${SEP}%(upstream:track,nobracket)${SEP}%(committerdate:relative)${SEP}%(subject)${SEP}%(HEAD)`,
    'refs/heads',
  ]);
  const branches = rows(out).map(([name, upstream, track, date, subject, head]) => ({ name, upstream, track: formatTrack(track), date, subject, current: head === '*' }));
  branches.sort((a, b) => Number(b.current) - Number(a.current));
  view.tree.description = plural(branches.length, 'branch').replace('branchs', 'branches');
  return branches.map((branch) => ({ type: 'branch', root, branch, ref: `refs/heads/${branch.name}`, view: 'branches' }));
}

async function remotesRoot(view) {
  const repo = repoOrMessage(view);
  if (!repo) return [];
  const root = repo.rootUri.fsPath;
  const remotes = new Map();
  for (const line of (await g.git(root, ['remote', '-v'])).split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(line);
    if (m) remotes.set(m[1], m[2]);
  }
  if (!remotes.size) view.tree.message = 'This repository has no remotes.';
  return [...remotes].map(([name, url]) => ({ type: 'remote', root, name, url }));
}

async function remoteBranches(node) {
  const out = await g.git(node.root, ['for-each-ref', '--sort=-committerdate', `--format=%(refname:short)${SEP}%(committerdate:relative)${SEP}%(subject)`, `refs/remotes/${node.name}`]);
  return rows(out)
    .filter(([name]) => name !== node.name && !name.endsWith('/HEAD'))
    .map(([name, date, subject]) => ({ type: 'branch', root: node.root, remote: true, branch: { name, date, subject }, ref: `refs/remotes/${name}`, view: 'remotes' }));
}

async function stashesRoot(view) {
  const repo = repoOrMessage(view);
  if (!repo) return [];
  const root = repo.rootUri.fsPath;
  const stashes = rows(await g.git(root, ['stash', 'list', '--format=%gd%x1f%H%x1f%ar%x1f%s'])).map(([ref, hash, date, subject]) => ({ ref, hash, date, subject }));
  if (!stashes.length) view.tree.message = 'No stashes.';
  return stashes.map((stash) => ({ type: 'stash', root, stash }));
}

async function tagsRoot(view) {
  const repo = repoOrMessage(view);
  if (!repo) return [];
  const root = repo.rootUri.fsPath;
  const tags = rows(await g.git(root, ['for-each-ref', '--sort=-creatordate', `--format=%(refname:short)${SEP}%(creatordate:relative)${SEP}%(subject)`, 'refs/tags']));
  if (!tags.length) view.tree.message = 'No tags.';
  return tags.map(([name, date, subject]) => ({ type: 'tag', root, name, date, subject }));
}

async function worktreesRoot(view) {
  const repo = repoOrMessage(view);
  if (!repo) return [];
  const root = repo.rootUri.fsPath;
  const list = g.parseWorktrees(await g.git(root, ['worktree', 'list', '--porcelain']));
  const base = (await g.resolveBases(root))[0];
  view.tree.description = plural(list.length, 'worktree');
  return Promise.all(
    list.map(async (wt, i) => {
      const info = {};
      if (!wt.prunable && fs.existsSync(wt.path)) {
        const [status, counts] = await Promise.all([
          g.git(wt.path, ['status', '--porcelain']).catch(() => undefined),
          base ? g.git(wt.path, ['rev-list', '--left-right', '--count', `${base}...HEAD`]).catch(() => '') : '',
        ]);
        if (status !== undefined) info.changed = status.split('\n').filter(Boolean).length;
        const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
        if (Number.isFinite(ahead)) Object.assign(info, { ahead, behind });
      }
      return { type: 'worktree', root, wt, info, base, main: i === 0, current: g.samePath(wt.path, root) };
    })
  );
}

function checksState(rollup) {
  if (!rollup?.length) return 'none';
  const states = rollup.map((c) => String(c.conclusion || c.state || c.status || '').toUpperCase());
  if (states.some((s) => FAILED_CHECKS.includes(s))) return 'failing';
  if (states.some((s) => RUNNING_CHECKS.includes(s))) return 'pending';
  return 'passing';
}

function classifyPr(pr, { mine, review }) {
  const checks = checksState(pr.statusCheckRollup);
  const conflicts = pr.mergeable === 'CONFLICTING';
  const badges = [
    { failing: '✗ checks failing', pending: '… checks running', passing: '✓ checks' }[checks],
    { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'needs review' }[pr.reviewDecision],
    conflicts && 'conflicts',
    `+${pr.additions} −${pr.deletions}`,
  ].filter(Boolean);
  let category = 'assigned';
  const isMine = mine.has(pr.number);
  if (review.has(pr.number)) category = 'review';
  else if (isMine && pr.isDraft) category = 'draft';
  else if (isMine && (checks === 'failing' || conflicts || pr.reviewDecision === 'CHANGES_REQUESTED')) category = 'blocked';
  else if (isMine && checks !== 'pending' && (pr.reviewDecision === 'APPROVED' || !pr.reviewDecision)) category = 'ready';
  else if (isMine) category = 'waiting';
  return { category, checks, badges, mine: isMine, canMerge: isMine && category === 'ready' };
}

function launchpadPrefs() {
  return globalMemento.get('gitCompass.launchpad', { pinned: [], snoozed: {} });
}

function saveLaunchpadPrefs(prefs) {
  launchpadCache = undefined;
  return globalMemento.update('gitCompass.launchpad', prefs);
}

async function loadLaunchpad(root, force = false) {
  if (!force && launchpadCache?.root === root && Date.now() - launchpadCache.at < 60e3) return launchpadCache.promise;
  const list = (extra) => gh(root, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', PR_FIELDS, ...extra]).then(JSON.parse);
  const promise = Promise.all([list(['--author', '@me']), list(['--search', 'review-requested:@me']), list(['--search', 'assignee:@me'])]).then(([mine, review, assigned]) => {
    const sets = { mine: new Set(mine.map((p) => p.number)), review: new Set(review.map((p) => p.number)) };
    const prs = new Map();
    for (const pr of [...review, ...mine, ...assigned]) prs.set(pr.number, pr);
    const prefs = launchpadPrefs();
    const now = Date.now();
    return [...prs.values()]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map((pr) => {
        const info = classifyPr(pr, sets);
        const until = prefs.snoozed[pr.url];
        info.snoozedUntil = until === null || until > now ? (until === null ? Infinity : until) : undefined;
        info.pinned = prefs.pinned.includes(pr.url);
        return { type: 'pr', root, pr, info };
      });
  });
  launchpadCache = { root, at: Date.now(), promise };
  promise.then(updateLaunchpadStatus, () => {
    launchpadCache = undefined;
    launchpadStatus?.hide();
  });
  return promise;
}

function groupLaunchpad(items) {
  const buckets = new Map(LAUNCHPAD_GROUPS.map((group) => [group.id, []]));
  for (const item of items) buckets.get(item.info.snoozedUntil ? 'snoozed' : item.info.pinned ? 'pinned' : item.info.category).push(item);
  return LAUNCHPAD_GROUPS.filter((group) => buckets.get(group.id).length).map((group) => ({ type: 'prGroup', group, items: buckets.get(group.id) }));
}

function launchpadEnabled() {
  return g.config().get('views.launchpad.enabled', true);
}

function updateLaunchpadStatus(items) {
  if (!launchpadStatus) return;
  if (!launchpadEnabled() || !g.config().get('launchpad.statusBar.enabled', true)) return launchpadStatus.hide();
  const active = items.filter((i) => !i.info.snoozedUntil);
  const count = (id) => active.filter((i) => i.info.category === id).length;
  const parts = [[count('review'), 'to review'], [count('blocked'), 'blocked'], [count('ready'), 'ready']].filter(([n]) => n);
  if (!parts.length) return launchpadStatus.hide();
  launchpadStatus.text = `$(git-pull-request) ${parts.map(([n, w]) => `${n} ${w}`).join(' · ')}`;
  launchpadStatus.tooltip = 'Launchpad: pull requests that need you';
  launchpadStatus.show();
}

async function launchpadRoot(view) {
  const repo = repoOrMessage(view);
  if (!repo) return [];
  const items = await loadLaunchpad(repo.rootUri.fsPath);
  if (!items.length) view.tree.message = 'No open pull requests involve you. 🎉';
  view.tree.description = items.length ? plural(items.filter((i) => !i.info.snoozedUntil).length, 'open PR') : undefined;
  return groupLaunchpad(items);
}

async function openPrWorktree(node) {
  const { root, pr } = node;
  const list = g.parseWorktrees(await g.git(root, ['worktree', 'list', '--porcelain']));
  const existing = list.find((w) => w.branch === pr.headRefName);
  const main = list[0].path;
  let target = existing?.path;
  if (!target) {
    target = path.join(path.dirname(main), `${path.basename(main)}-pr-${pr.number}`);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating worktree for #${pr.number}…` }, async () => {
      if (pr.isCrossRepository) {
        await g.git(root, ['fetch', 'origin', `pull/${pr.number}/head`]);
        await g.git(root, ['worktree', 'add', '--detach', target, 'FETCH_HEAD']);
        return;
      }
      await g.git(root, ['fetch', 'origin', pr.headRefName]);
      const local = await g.refExists(root, `refs/heads/${pr.headRefName}`);
      await g.git(root, local ? ['worktree', 'add', target, pr.headRefName] : ['worktree', 'add', '--track', '-b', pr.headRefName, target, `origin/${pr.headRefName}`]);
    });
    views.worktrees.refresh();
  }
  const open = await vscode.window.showInformationMessage(
    `${existing ? 'Already checked out' : 'Worktree ready'} for #${pr.number} at ${target}.${existing ? '' : ' Install dependencies there before starting apps.'}`,
    'Open in New Window'
  );
  if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
}

async function mergePr(node) {
  const { root, pr } = node;
  const choice = await vscode.window.showWarningMessage(
    `Merge #${pr.number} into ${pr.baseRefName}?`,
    { modal: true, detail: `${pr.title}\n\n${pr.headRefName} → ${pr.baseRefName}. This merges on GitHub; the branch is not deleted.` },
    'Squash and Merge',
    'Create Merge Commit',
    'Rebase and Merge'
  );
  if (!choice) return;
  const flag = { 'Squash and Merge': '--squash', 'Create Merge Commit': '--merge', 'Rebase and Merge': '--rebase' }[choice];
  await vscode.window.withProgress({ location: { viewId: VIEW.launchpad } }, () => gh(root, ['pr', 'merge', String(pr.number), flag]));
  launchpadCache = undefined;
  views.launchpad.refresh();
  vscode.window.showInformationMessage(`Merged #${pr.number}.`);
}

async function isDirty(root, rel) {
  try {
    await g.git(root, ['diff', '--quiet', 'HEAD', '--', rel]);
    return false;
  } catch {
    return true;
  }
}

async function fileHistoryRoot(view) {
  const file = state.file;
  if (!file) {
    view.tree.description = undefined;
    view.tree.message = 'Open a file to see its history.';
    return [];
  }
  view.tree.description = path.basename(file.rel);
  const limit = limitFor('fileHistory');
  const [commits, dirty] = await Promise.all([
    g.logCommits(file.root, ['--follow', '--name-status', `-n${limit + 1}`, '--', file.rel]),
    isDirty(file.root, file.rel),
  ]);
  const nodes = dirty ? [{ type: 'uncommitted', root: file.root, rel: file.rel }] : [];
  nodes.push(...commitNodes(file.root, commits, { key: 'fileHistory', view: 'fileHistory', limit, file: file.rel, currentRel: file.rel }));
  if (!nodes.length) view.tree.message = 'This file has no commits yet.';
  return nodes;
}

async function lineHistoryRoot(view) {
  const line = state.line;
  if (!line) {
    view.tree.description = undefined;
    view.tree.message = 'Place the cursor in a file to see the history of that line.';
    return [];
  }
  view.tree.description = `${path.basename(line.rel)}:${line.end > line.start ? `${line.start}–${line.end}` : line.start}`;
  const limit = limitFor('lineHistory');
  let commits;
  try {
    commits = await g.logCommits(line.root, [`-L${line.start},${line.end}:${line.rel}`, '-s', `-n${limit + 1}`]);
  } catch (e) {
    view.tree.message = /no path|has only|does not exist|unknown revision/i.test(e.message) ? 'These lines are not committed yet.' : e.message;
    return [];
  }
  if (!commits.length) view.tree.message = 'No commits touch these lines.';
  return commitNodes(line.root, commits, { key: 'lineHistory', view: 'lineHistory', limit, file: line.rel, currentRel: line.rel });
}

function compareRoot() {
  return state.comparisons.map((c) => ({ type: 'compare', ...c }));
}

async function compareGroups(node) {
  const { root, ref } = node;
  const base = (await g.git(root, ['merge-base', ref, 'HEAD'])).trim();
  const [behind, ahead] = (await g.git(root, ['rev-list', '--left-right', '--count', `${ref}...HEAD`])).trim().split(/\s+/).map(Number);
  const files = g.parseNameStatus(await g.git(root, ['diff', '--name-status', '-M', base])).sort((a, b) => a.path.localeCompare(b.path));
  return [
    { type: 'group', id: `${node.id}:behind`, root, label: 'Behind', description: plural(behind, 'commit'), icon: 'arrow-down', count: behind, range: `HEAD..${ref}` },
    { type: 'group', id: `${node.id}:ahead`, root, label: 'Ahead', description: plural(ahead, 'commit'), icon: 'arrow-up', count: ahead, range: `${ref}..HEAD` },
    { type: 'group', id: `${node.id}:files`, root, label: 'Files Changed', description: `${plural(files.length, 'file')} since ${base.slice(0, 7)}`, icon: 'files', files, base },
  ];
}

async function groupChildren(node) {
  if (node.files) return node.files.map((change) => fileNode('compareFile', { root: node.root, base: node.base }, change));
  const commits = await g.logCommits(node.root, [`-n${RESULT_CAP + 1}`, node.range, '--']);
  return commitNodes(node.root, commits, { limit: RESULT_CAP });
}

function searchRoot(view) {
  if (!state.searches.length) view.tree.message = undefined;
  return state.searches;
}

async function searchResults(node) {
  if (!node.results) {
    const mode = SEARCH_MODES.find((m) => m.id === node.mode) || SEARCH_MODES[0];
    node.results = await vscode.window.withProgress({ location: { viewId: VIEW.search } }, () =>
      g.logCommits(node.root, [`-n${RESULT_CAP + 1}`, ...(node.args || mode.args(node.query))])
    );
    setTimeout(() => views.search.emitter.fire(node), 0);
  }
  return node.results.length ? commitNodes(node.root, node.results, { limit: RESULT_CAP }) : [msg('No matching commits')];
}

async function openChanges(node) {
  switch (node.type) {
    case 'commit':
      return g.diffCommitFile(node.root, node.commit, node.file);
    case 'commitFile':
      return g.diffCommitFile(node.root, node.commit, node.change);
    case 'stashFile': {
      const ch = node.change;
      const left = ch.status === 'A' ? g.refUri(node.root, ch.path, '') : g.refUri(node.root, ch.oldPath, `${node.stash.hash}^1`);
      const right = ch.status === 'D' ? g.refUri(node.root, ch.path, '') : g.refUri(node.root, ch.path, node.stash.hash);
      return g.openDiff(left, right, `${path.basename(ch.path)} (${node.stash.ref})`);
    }
    case 'uncommitted':
      return g.openDiff(g.refUri(node.root, node.rel, 'HEAD'), g.fileUri(node.root, node.rel), `${path.basename(node.rel)} (HEAD ↔ Working Tree)`);
    case 'compareFile': {
      const ch = node.change;
      const left = ch.status === 'A' ? g.refUri(node.root, ch.path, '') : g.refUri(node.root, ch.oldPath, node.base);
      const right = ch.status === 'D' ? g.refUri(node.root, ch.path, '') : g.fileUri(node.root, ch.path);
      return g.openDiff(left, right, `${path.basename(ch.path)} (${node.base.slice(0, 7)} ↔ Working Tree)`);
    }
    default:
      return undefined;
  }
}

function changeOf(node) {
  return node.file || node.change;
}

function focus(key) {
  return vscode.commands.executeCommand(`${VIEW[key]}.focus`);
}

function refreshAll() {
  for (const v of Object.values(views)) v.refresh();
}

function saveComparisons() {
  memento.update('gitCompass.comparisons', state.comparisons);
}

async function confirm(message, detail, action) {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

async function newWorktree() {
  const root = g.requireRepo();
  const list = g.parseWorktrees(await g.git(root, ['worktree', 'list', '--porcelain']));
  const main = list[0].path;
  const branch = (
    await vscode.window.showInputBox({
      title: 'Create Worktree',
      prompt: 'Branch name. An existing local or origin branch is checked out; a new name is created.',
      placeHolder: 'feat/my-change',
      validateInput: (v) => (/^\S+$/.test(v.trim()) ? undefined : 'Enter a branch name without spaces'),
    })
  )?.trim();
  if (!branch) return;
  const exists = (await g.refExists(root, `refs/heads/${branch}`)) || (await g.refExists(root, `origin/${branch}`));
  let base;
  if (!exists) {
    const bases = await g.resolveBases(root);
    const pick = await vscode.window.showQuickPick([...bases.map((b) => ({ label: b })), { label: 'HEAD', description: 'current commit' }], {
      title: `Create ${branch} from…`,
    });
    if (!pick) return;
    base = pick.label;
  }
  const target = await vscode.window.showInputBox({
    title: 'Create Worktree',
    prompt: 'Folder for the worktree',
    value: path.join(path.dirname(main), `${path.basename(main)}-${branch.split('/').pop()}`),
  });
  if (!target) return;
  const args = exists ? ['worktree', 'add', target, branch] : ['worktree', 'add', '--no-track', '-b', branch, target, base];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating worktree ${path.basename(target)}…` }, () => g.git(root, args));
  views.worktrees.refresh();
  if (await vscode.window.showInformationMessage(`Worktree ready at ${target}. Install dependencies there before starting apps.`, 'Open in New Window')) {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
  }
}

async function removeWorktree(node) {
  const { wt } = node;
  const ok = await confirm(
    `Remove worktree "${path.basename(wt.path)}"?`,
    `${wt.path}\n\nThe branch${wt.branch ? ` ${wt.branch}` : ''} is kept. Git refuses if the worktree has uncommitted changes.`,
    'Remove'
  );
  if (!ok) return;
  await g.git(node.root, wt.prunable ? ['worktree', 'prune'] : ['worktree', 'remove', wt.path]);
  views.worktrees.refresh();
}

async function deleteBranch(node) {
  const name = node.branch.name;
  if (!(await confirm(`Delete branch "${name}"?`, 'Only the local branch is deleted.', 'Delete'))) return;
  try {
    await g.git(node.root, ['branch', '-d', name]);
  } catch (e) {
    if (!/not fully merged/.test(e.message)) throw e;
    if (!(await confirm(`"${name}" has commits that are not merged anywhere.`, 'Force-deleting loses those commits unless another branch or tag points at them.', 'Force Delete'))) return;
    await g.git(node.root, ['branch', '-D', name]);
  }
  views.branches.refresh();
}

function addComparison(root, ref) {
  state.comparisons.unshift({ id: `compare-${Date.now()}`, root, ref });
  saveComparisons();
  views.compare.refresh();
  return focus('compare');
}

function trackEditor(editor) {
  const uri = editor?.document.uri;
  if (uri?.scheme !== 'file') return;
  let file;
  try {
    file = g.targetFile(uri);
  } catch {
    return;
  }
  if (state.file?.uri.toString() !== file.uri.toString()) {
    state.file = file;
    limits.delete('fileHistory');
    views.fileHistory.refresh();
  }
  trackSelection(editor, file);
}

let selectionTimer;
function trackSelection(editor, file) {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const sel = editor.selection;
    const start = sel.start.line + 1;
    let end = sel.end.line + 1;
    if (sel.end.character === 0 && sel.end.line > sel.start.line) end -= 1;
    const prev = state.line;
    if (prev && prev.uri.toString() === file.uri.toString() && prev.start === start && prev.end === end) return;
    state.line = { ...file, start, end };
    limits.delete('lineHistory');
    views.lineHistory.refresh();
  }, 400);
}

function register(context) {
  memento = context.workspaceState;
  globalMemento = context.globalState;
  state.comparisons = memento.get('gitCompass.comparisons', []);
  Object.assign(views, {
    commits: new View(context, 'commits', commitsRoot),
    branches: new View(context, 'branches', branchesRoot),
    remotes: new View(context, 'remotes', remotesRoot),
    stashes: new View(context, 'stashes', stashesRoot),
    tags: new View(context, 'tags', tagsRoot),
    worktrees: new View(context, 'worktrees', worktreesRoot),
    launchpad: new View(context, 'launchpad', launchpadRoot),
    fileHistory: new View(context, 'fileHistory', fileHistoryRoot),
    lineHistory: new View(context, 'lineHistory', lineHistoryRoot),
    compare: new View(context, 'compare', compareRoot),
    search: new View(context, 'search', searchRoot),
  });

  const commands = {
    fileHistory: async (arg) => {
      const file = g.targetFile(arg);
      state.file = file;
      limits.delete('fileHistory');
      views.fileHistory.refresh();
      await focus('fileHistory');
    },
    lineHistory: async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) trackEditor(editor);
      await focus('lineHistory');
    },
    worktrees: () => focus('worktrees'),
    createWorktree: newWorktree,
    compareBranch: async () => {
      const root = g.requireRepo();
      const ref = await g.pickRef(root, 'Compare the current branch (incl. working tree) with…');
      if (ref) await addComparison(root, ref);
    },
    compareFile: async (arg) => {
      const file = g.targetFile(arg);
      const ref = await g.pickRef(file.root, `Compare ${path.basename(file.rel)} with…`);
      if (ref) await g.openDiff(g.refUri(file.root, file.rel, ref), file.uri, `${path.basename(file.rel)} (${g.shortRef(ref)} ↔ Working Tree)`, {});
    },
    search: async () => {
      const root = g.requireRepo();
      const mode = await vscode.window.showQuickPick(SEARCH_MODES.map((m) => ({ ...m, description: m.placeholder })), { title: 'Search Commits by…' });
      if (!mode) return;
      const query = (await vscode.window.showInputBox({ title: `Search Commits by ${mode.label}`, placeHolder: mode.placeholder }))?.trim();
      if (!query) return;
      state.searches.unshift({ type: 'search', id: `search-${Date.now()}`, root, mode: mode.id, label: mode.label, query });
      views.search.refresh();
      await focus('search');
    },
    refresh: () => {
      g.clearBaseCache();
      launchpadCache = undefined;
      for (const v of Object.values(views)) v.emitter.fire();
    },
    openChanges: openChanges,
    openFileAtRevision: (node) => vscode.window.showTextDocument(g.refUri(node.root, changeOf(node).path, node.commit.hash), { preview: true }),
    compareWithWorking: (node) => {
      const ch = changeOf(node);
      return g.openDiff(g.refUri(node.root, ch.path, node.commit.hash), g.fileUri(node.root, node.currentRel || ch.path), `${path.basename(ch.path)} (${node.commit.short} ↔ Working Tree)`, {});
    },
    showCommit: (node) => g.showWholeCommit(node.root, node.commit.hash),
    copySha: (node) => vscode.env.clipboard.writeText(node.commit.hash),
    copyMessage: (node) => vscode.env.clipboard.writeText(node.commit.body ? `${node.commit.subject}\n\n${node.commit.body}` : node.commit.subject),
    copyName: (node) => vscode.env.clipboard.writeText(node.branch?.name || node.name),
    loadMore: (node) => {
      limits.set(node.key, limitFor(node.key) + PAGE);
      views[node.view].emitter.fire();
    },
    'worktree.openNewWindow': (node) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.wt.path), { forceNewWindow: true }),
    'worktree.openHere': (node) => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.wt.path), { forceReuseWindow: true }),
    'worktree.reveal': (node) => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.wt.path)),
    'worktree.copyPath': (node) => vscode.env.clipboard.writeText(node.wt.path),
    'worktree.remove': removeWorktree,
    'branch.checkout': async (node) => {
      const name = node.remote ? node.branch.name.slice(node.branch.name.indexOf('/') + 1) : node.branch.name;
      await vscode.window.withProgress({ location: { viewId: VIEW[node.view] } }, () => g.git(node.root, ['switch', name]));
      refreshAll();
    },
    'branch.compare': (node) => addComparison(node.root, node.branch.name),
    'branch.delete': deleteBranch,
    'tag.compare': (node) => addComparison(node.root, node.name),
    'tag.delete': async (node) => {
      if (!(await confirm(`Delete tag "${node.name}"?`, 'Only the local tag is deleted; the remote is untouched.', 'Delete'))) return;
      await g.git(node.root, ['tag', '-d', node.name]);
      views.tags.refresh();
    },
    'stash.apply': async (node) => {
      await g.git(node.root, ['stash', 'apply', node.stash.ref]);
      views.stashes.refresh();
    },
    'stash.pop': async (node) => {
      await g.git(node.root, ['stash', 'pop', node.stash.ref]);
      views.stashes.refresh();
    },
    'stash.drop': async (node) => {
      if (!(await confirm(`Drop ${node.stash.ref}?`, `${node.stash.subject}\n\nA dropped stash cannot be restored from here.`, 'Drop'))) return;
      await g.git(node.root, ['stash', 'drop', node.stash.ref]);
      views.stashes.refresh();
    },
    'compare.dismiss': (node) => {
      state.comparisons = state.comparisons.filter((c) => c.id !== node.id);
      saveComparisons();
      views.compare.emitter.fire();
    },
    'search.dismiss': (node) => {
      state.searches = state.searches.filter((s) => s.id !== node.id);
      views.search.emitter.fire();
    },
    'pr.open': (node) => vscode.env.openExternal(vscode.Uri.parse(node.pr.url)),
    'pr.copyUrl': (node) => vscode.env.clipboard.writeText(node.pr.url),
    'pr.checkout': async (node) => {
      if (!(await confirm(`Check out #${node.pr.number}?`, `Switches this window to ${node.pr.headRefName}.`, 'Check Out'))) return;
      await vscode.window.withProgress({ location: { viewId: VIEW.launchpad } }, () => gh(node.root, ['pr', 'checkout', String(node.pr.number)]));
      refreshAll();
    },
    'launchpad.openWorktree': openPrWorktree,
    'launchpad.merge': mergePr,
    'launchpad.pin': async (node) => {
      const prefs = launchpadPrefs();
      await saveLaunchpadPrefs({ ...prefs, pinned: [...new Set([...prefs.pinned, node.pr.url])] });
      views.launchpad.refresh();
    },
    'launchpad.unpin': async (node) => {
      const prefs = launchpadPrefs();
      await saveLaunchpadPrefs({ ...prefs, pinned: prefs.pinned.filter((u) => u !== node.pr.url) });
      views.launchpad.refresh();
    },
    'launchpad.snooze': async (node) => {
      const pick = await vscode.window.showQuickPick(SNOOZE_OPTIONS, { title: `Snooze #${node.pr.number}` });
      if (!pick) return;
      const until = pick.until ? pick.until() : pick.ms === Infinity ? null : Date.now() + pick.ms;
      const prefs = launchpadPrefs();
      await saveLaunchpadPrefs({ ...prefs, snoozed: { ...prefs.snoozed, [node.pr.url]: until } });
      views.launchpad.refresh();
    },
    'launchpad.unsnooze': async (node) => {
      const prefs = launchpadPrefs();
      const snoozed = { ...prefs.snoozed };
      delete snoozed[node.pr.url];
      await saveLaunchpadPrefs({ ...prefs, snoozed });
      views.launchpad.refresh();
    },
  };

  for (const [name, fn] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`gitCompass.${name}`, async (...args) => {
        try {
          await g.getGitApi();
          await fn(...args);
        } catch (e) {
          vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
        }
      })
    );
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(trackEditor),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor && e.textEditor.document.uri.scheme === 'file' && state.file) {
        if (e.textEditor.document.uri.toString() === state.file.uri.toString()) trackSelection(e.textEditor, state.file);
      }
    })
  );
  g.onRepoChange(context, refreshAll, 800);
  trackEditor(vscode.window.activeTextEditor);

  launchpadStatus = vscode.window.createStatusBarItem('gitCompass.launchpad', vscode.StatusBarAlignment.Left, 98);
  launchpadStatus.name = 'Git Compass Launchpad';
  launchpadStatus.command = `${VIEW.launchpad}.focus`;
  context.subscriptions.push(launchpadStatus);
  const pollLaunchpad = () => {
    const repo = g.activeRepo();
    if (!repo || !launchpadEnabled()) return launchpadStatus.hide();
    loadLaunchpad(repo.rootUri.fsPath, true)
      .then(() => views.launchpad.refresh())
      .catch(() => {});
  };
  setTimeout(pollLaunchpad, 5000);
  const timer = setInterval(pollLaunchpad, 10 * 60e3);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitCompass.launchpad') || e.affectsConfiguration('gitCompass.views.launchpad')) pollLaunchpad();
    })
  );
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function addSearch(root, label, query, args) {
  state.searches.unshift({ type: 'search', id: `search-${Date.now()}`, root, mode: 'custom', label, query, args });
  views.search.refresh();
  return focus('search');
}

module.exports = { register, refreshAll, addSearch, VIEW, SEARCH_MODES, formatTrack, relativeDate, checksState, classifyPr, groupLaunchpad };

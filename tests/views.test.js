const { vscode, state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../git');
const views = require('../views');

const lines = (n, edit = {}) => Array.from({ length: n }, (_, i) => edit[i] ?? `line ${i + 1}`).join('\n') + '\n';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let repo;
let bare;
let wtPath;
let context;
const sha = {};

const tree = (key) => state.trees.get(views.VIEW[key]);
const children = (key, node) => tree(key).provider.getChildren(node);
const item = (key, node) => tree(key).provider.getTreeItem(node);
const run = (id, ...args) => state.commands.get(`gitCompass.${id}`)(...args);
const errors = () => state.messages.filter(([kind]) => kind === 'error');

before(async () => {
  reset();
  repo = createRepo();
  repo.write('src/app.js', lines(20));
  sha.feat = repo.commit('feat: app');
  repo.write('src/app.js', lines(20, { 2: 'line three fixed' }));
  sha.fix = repo.commit('fix: app line');
  repo.git('branch', 'feature-x');
  for (let i = 1; i <= 52; i++) repo.git('commit', '-q', '--allow-empty', '-m', `chore: filler ${i}`);
  repo.git('mv', 'src/app.js', 'src/main.js');
  sha.rename = repo.commit('refactor: rename app');
  bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-origin-')));
  repo.git('init', '-q', '--bare', '-b', 'main', bare);
  repo.git('remote', 'add', 'origin', bare);
  repo.git('push', '-q', '-u', 'origin', 'main', 'feature-x');
  repo.git('remote', 'set-head', 'origin', 'main');
  repo.write('src/main.js', lines(20, { 5: 'unpushed-marker' }));
  sha.unpushed = repo.commit('feat: unpushed work');
  repo.git('tag', 'v1.0.0');
  repo.write('src/main.js', lines(20, { 5: 'unpushed-marker', 9: 'stashed change' }));
  repo.git('stash', 'push', '-q', '-m', 'wip notes');
  wtPath = path.join(fs.realpathSync(os.tmpdir()), `git-compass-wt-${process.pid}-${Date.now()}`);
  repo.git('worktree', 'add', '-q', '-b', 'wt-feature', wtPath);
  repo.write('src/main.js', lines(20, { 5: 'unpushed-marker', 15: 'dirty edit' }));

  state.repos = [makeRepo(repo.root, 'main')];
  state.config['gitCompass.baseBranches'] = ['main'];
  state.config['gitCompass.views.launchpad.enabled'] = false;
  state.config['gitCompass.views.commits.enabled'] = false;
  await g.getGitApi();
  g.clearBaseCache();
  context = createContext();
  views.register(context);
});

after(() => {
  for (const d of context.subscriptions) d?.dispose?.();
  try {
    repo.git('worktree', 'remove', '--force', wtPath);
  } catch {}
  fs.rmSync(wtPath, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
  repo.cleanup();
});

test('registers every view even when a view is turned off', () => {
  for (const id of Object.values(views.VIEW)) assert.ok(state.trees.has(id), id);
  assert.ok(context.subscriptions.length > 20);
});

test('commits view marks unpushed commits and pages with load more', async () => {
  const nodes = await children('commits');
  assert.equal(nodes[0].commit.subject, 'feat: unpushed work');
  assert.equal(nodes[0].unpushed, true);
  assert.equal(nodes[1].unpushed, false);
  assert.match(tree('commits').description, /main · 1 to push/);
  assert.equal(nodes.length, 51);
  const more = nodes.at(-1);
  assert.equal(more.type, 'loadMore');
  assert.equal(item('commits', nodes[0]).contextValue, 'commit');
  await run('loadMore', more);
  const all = await children('commits');
  assert.equal(all.length, 56);
  assert.ok(all.every((n) => n.type === 'commit'));
  const files = await children('commits', all.find((n) => n.commit.hash === sha.rename));
  assert.deepEqual(files.map((f) => [f.type, f.change.status, f.change.path]), [['commitFile', 'R', 'src/main.js']]);
});

test('branches view shows the current branch first with upstream tracking', async () => {
  const nodes = await children('branches');
  assert.equal(nodes[0].branch.name, 'main');
  assert.equal(nodes[0].branch.current, true);
  assert.equal(nodes[0].branch.upstream, 'origin/main');
  assert.equal(nodes[0].branch.track, '↑1');
  assert.deepEqual(nodes.map((n) => n.branch.name).sort(), ['feature-x', 'main', 'wt-feature']);
  assert.equal(item('branches', nodes[0]).contextValue, 'branch:current');
  const commits = await children('branches', nodes.find((n) => n.branch.name === 'feature-x'));
  assert.equal(commits[0].commit.hash, sha.fix);
});

test('remotes view lists remotes and their branches', async () => {
  const [origin] = await children('remotes');
  assert.equal(origin.name, 'origin');
  assert.ok(g.samePath(origin.url, bare));
  const branches = await children('remotes', origin);
  assert.deepEqual(branches.map((b) => item('remotes', b).label).sort(), ['feature-x', 'main']);
  assert.ok(branches.every((b) => b.remote));
});

test('stashes view lists stashes and their files', async () => {
  const nodes = await children('stashes');
  assert.equal(nodes.length, 1);
  assert.equal(item('stashes', nodes[0]).label, 'wip notes');
  assert.equal(nodes[0].stash.ref, 'stash@{0}');
  const files = await children('stashes', nodes[0]);
  assert.deepEqual(files.map((f) => [f.type, f.change.path]), [['stashFile', 'src/main.js']]);
});

test('tags view lists tags and their commits', async () => {
  const [tag] = await children('tags');
  assert.equal(tag.name, 'v1.0.0');
  const commits = await children('tags', tag);
  assert.equal(commits[0].commit.hash, sha.unpushed);
});

test('worktrees view lists every worktree with status', async () => {
  const nodes = await children('worktrees');
  assert.equal(nodes.length, 2);
  const main = nodes.find((n) => n.current);
  const other = nodes.find((n) => !n.current);
  assert.equal(main.main, true);
  assert.equal(main.info.changed, 1);
  assert.equal(main.base, 'origin/main');
  assert.equal(main.info.ahead, 1);
  assert.equal(main.info.behind, 0);
  assert.equal(other.wt.branch, 'wt-feature');
  assert.ok(g.samePath(other.wt.path, wtPath));
  assert.equal(item('worktrees', main).contextValue, 'worktree:current');
  assert.equal(item('worktrees', other).contextValue, 'worktree');
});

test('file history follows renames and shows uncommitted changes', async () => {
  await run('fileHistory', vscode.Uri.file(path.join(repo.root, 'src', 'main.js')));
  const nodes = await children('fileHistory');
  assert.equal(tree('fileHistory').description, 'main.js');
  assert.equal(nodes[0].type, 'uncommitted');
  const commits = nodes.filter((n) => n.type === 'commit');
  assert.deepEqual(commits.map((c) => c.commit.hash), [sha.unpushed, sha.rename, sha.fix, sha.feat]);
  assert.equal(commits[1].file.status, 'R');
  assert.equal(commits[1].file.oldPath, 'src/app.js');
  assert.equal(item('fileHistory', commits[0]).contextValue, 'commit+file');
  await run('openChanges', commits[0]);
  const [id, args] = state.executed.at(-1);
  assert.equal(id, 'vscode.diff');
  assert.equal(g.parseRefUri(args[0]).ref, `${sha.unpushed}^`);
  assert.equal(g.parseRefUri(args[1]).ref, sha.unpushed);
  await run('copySha', commits[0]);
  assert.equal(state.clipboard, sha.unpushed);
});

test('line history follows the cursor', async () => {
  const uri = vscode.Uri.file(path.join(repo.root, 'src', 'main.js'));
  state.activeEditor = { document: { uri }, selection: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } } };
  await run('lineHistory');
  await wait(550);
  const nodes = await children('lineHistory');
  assert.equal(tree('lineHistory').description, 'main.js:6');
  assert.equal(nodes[0].commit.hash, sha.unpushed);
  assert.ok(nodes.every((n) => n.type === 'commit'));
  state.activeEditor = undefined;
});

test('compare view groups commits and files, including a rename', async () => {
  state.answers.push((items) => items.find((i) => i.label === 'feature-x'));
  await run('compareBranch');
  const [cmp] = await children('compare');
  assert.equal(cmp.ref, 'feature-x');
  assert.match(item('compare', cmp).label, /main ↔ feature-x/);
  const [behind, ahead, files] = await children('compare', cmp);
  assert.equal(behind.count, 0);
  assert.equal(ahead.count, 54);
  assert.equal(item('compare', behind).collapsibleState, vscode.TreeItemCollapsibleState.None);
  const changed = await children('compare', files);
  assert.deepEqual(changed.map((f) => [f.change.status, f.change.oldPath, f.change.path]), [['R', 'src/app.js', 'src/main.js']]);
  const aheadCommits = await children('compare', ahead);
  assert.equal(aheadCommits.length, 54);
  await run('openChanges', changed[0]);
  const [, args] = state.executed.at(-1);
  assert.equal(g.parseRefUri(args[0]).rel, 'src/app.js');
  assert.equal(args[1].scheme, 'file');
  assert.equal(context.workspaceState.get('gitCompass.comparisons').length, 1);
  await run('compare.dismiss', cmp);
  assert.deepEqual(await children('compare'), []);
});

test('search view runs every search mode', async () => {
  const search = async (mode, query) => {
    state.answers.push((items) => items.find((i) => i.id === mode), query);
    await run('search');
    const [node] = await children('search');
    assert.equal(node.query, query);
    return children('search', node);
  };
  assert.deepEqual((await search('message', 'rename')).map((n) => n.commit.hash), [sha.rename]);
  assert.ok((await search('author', 'test user')).filter((n) => n.type === 'commit').length >= 50);
  assert.deepEqual((await search('file', 'main.js')).map((n) => n.commit.hash), [sha.unpushed, sha.rename]);
  assert.deepEqual((await search('changes', 'unpushed-marker')).map((n) => n.commit.hash), [sha.unpushed]);
  assert.ok((await search('regex', 'line t[a-z]+ fixed')).some((n) => n.commit.hash === sha.fix));
  assert.deepEqual((await search('sha', sha.fix.slice(0, 10))).map((n) => n.commit.hash), [sha.fix]);
  assert.equal((await search('message', 'nothing-matches-this')).at(0).type, 'message');
  const nodes = await children('search');
  assert.equal(nodes.length, 7);
  for (const node of nodes) await run('search.dismiss', node);
  assert.deepEqual(await children('search'), []);
});

test('addSearch adds a custom search with its own arguments', async () => {
  await views.addSearch(repo.root, 'AI', 'filler work', ['--grep=filler 5', '-i']);
  const [node] = await children('search');
  const results = await children('search', node);
  assert.deepEqual(results.map((n) => n.commit.subject).sort(), ['chore: filler 5', 'chore: filler 50', 'chore: filler 51', 'chore: filler 52']);
  await run('search.dismiss', node);
});

test('no command reported an error', () => {
  assert.deepEqual(errors(), []);
});

test('formatTrack and relativeDate', () => {
  assert.equal(views.formatTrack('ahead 3, behind 2'), '↑3 ↓2');
  assert.equal(views.formatTrack('behind 1'), '↓1');
  assert.equal(views.formatTrack('gone'), 'upstream gone');
  assert.equal(views.formatTrack(''), '');
  assert.equal(views.relativeDate(new Date(Date.now() - 2 * 86400e3).toISOString()), '2 days ago');
  assert.equal(views.relativeDate(new Date().toISOString()), 'just now');
});

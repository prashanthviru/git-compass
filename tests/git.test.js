const { vscode, state, reset, makeRepo } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../git');

let repo;
let shas;

before(async () => {
  reset();
  repo = createRepo();
  repo.write('src/a.js', 'one\ntwo\nthree\n');
  const first = repo.commit('feat: add a');
  repo.write('src/a.js', 'one\ntwo\nthree\nfour\n');
  const second = repo.commit('fix(a): add four\n\nLonger body line.');
  repo.git('mv', 'src/a.js', 'src/b.js');
  const renamed = repo.commit('refactor: rename a to b');
  repo.git('checkout', '-q', '-b', 'side');
  repo.write('side.txt', 'side\n');
  const side = repo.commit('feat: side work');
  repo.git('checkout', '-q', 'main');
  repo.write('main.txt', 'main\n');
  repo.commit('chore: main work');
  repo.git('merge', '-q', '--no-ff', '-m', 'Merge branch side', 'side');
  shas = { first, second, renamed, side };
  state.repos = [makeRepo(repo.root, 'main')];
  await g.getGitApi();
});

after(() => repo.cleanup());

test('parseLog reads fields, bodies, parents and refs', async () => {
  const commits = await g.logCommits(repo.root, ['-n10']);
  assert.equal(commits.length, 6);
  const merge = commits[0];
  assert.equal(merge.subject, 'Merge branch side');
  assert.equal(merge.parents.length, 2);
  assert.ok(merge.refs.some((r) => r.includes('main')));
  const fix = commits.find((c) => c.hash === shas.second);
  assert.equal(fix.subject, 'fix(a): add four');
  assert.equal(fix.body, 'Longer body line.');
  assert.equal(fix.author, 'Test User');
  assert.equal(fix.email, 'test@example.com');
  assert.equal(fix.short, shas.second.slice(0, fix.short.length));
  assert.ok(!Number.isNaN(Date.parse(fix.iso)));
  assert.equal(fix.stats, undefined);
});

test('parseLog reads name-status changes including renames', async () => {
  const commits = await g.logCommits(repo.root, ['--follow', '--name-status', '-M', '--', 'src/b.js']);
  assert.deepEqual(commits.map((c) => c.hash), [shas.renamed, shas.second, shas.first]);
  assert.deepEqual(commits[0].change, { status: 'R', oldPath: 'src/a.js', path: 'src/b.js' });
  assert.deepEqual(commits[1].change, { status: 'M', oldPath: 'src/a.js', path: 'src/a.js' });
  assert.equal(commits[2].change.status, 'A');
});

test('parseLog totals numstat additions and deletions', async () => {
  const [commit] = await g.logCommits(repo.root, ['--numstat', '-n1', shas.second]);
  assert.deepEqual(commit.stats, { additions: 1, deletions: 0 });
  const [first] = await g.logCommits(repo.root, ['--numstat', '-n1', shas.first]);
  assert.deepEqual(first.stats, { additions: 3, deletions: 0 });
});

test('parseNameStatus handles every status shape and skips noise', () => {
  const out = ['M\tsrc/x.js', 'A\tnew file.txt', 'D\told.js', 'R087\ta/b.js\ta/c.js', 'C100\tx.js\ty.js', '', 'not a status line'].join('\n');
  assert.deepEqual(g.parseNameStatus(out), [
    { status: 'M', oldPath: 'src/x.js', path: 'src/x.js' },
    { status: 'A', oldPath: 'new file.txt', path: 'new file.txt' },
    { status: 'D', oldPath: 'old.js', path: 'old.js' },
    { status: 'R', oldPath: 'a/b.js', path: 'a/c.js' },
    { status: 'C', oldPath: 'x.js', path: 'y.js' },
  ]);
});

test('commitFiles lists a merge against its first parent', async () => {
  const [merge] = await g.logCommits(repo.root, ['-n1']);
  const files = await g.commitFiles(repo.root, merge.hash);
  assert.deepEqual(files.map((f) => f.path), ['side.txt']);
});

test('parseWorktrees reads porcelain output for linked worktrees', async () => {
  const wtPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-wt-')));
  fs.rmSync(wtPath, { recursive: true, force: true });
  repo.git('worktree', 'add', '-q', '-b', 'wt-branch', wtPath);
  try {
    const list = g.parseWorktrees(await g.git(repo.root, ['worktree', 'list', '--porcelain']));
    assert.equal(list.length, 2);
    assert.ok(g.samePath(list[0].path, repo.root));
    assert.equal(list[0].branch, 'main');
    assert.equal(list[1].branch, 'wt-branch');
    assert.ok(g.samePath(list[1].path, wtPath));
    assert.match(list[1].head, /^[0-9a-f]{40}$/);
  } finally {
    repo.git('worktree', 'remove', '--force', wtPath);
  }
  const parsed = g.parseWorktrees('worktree /a\nHEAD abc\ndetached\n\nworktree /b\nHEAD def\nbranch refs/heads/x\nlocked\nprunable gitdir file points to non-existent location\n');
  assert.equal(parsed[0].detached, true);
  assert.equal(parsed[0].branch, undefined);
  assert.equal(parsed[1].locked, true);
  assert.equal(parsed[1].prunable, true);
});

test('refUri and parseRefUri round-trip', () => {
  const uri = g.refUri(repo.root, 'src/b.js', 'HEAD~1');
  assert.equal(uri.scheme, g.SCHEME);
  assert.deepEqual(g.parseRefUri(uri), { root: repo.root, ref: 'HEAD~1', rel: 'src/b.js' });
  assert.equal(g.parseRefUri(g.refUri(repo.root, 'x.txt', '')).ref, '');
});

test('toRel always uses forward slashes', () => {
  assert.equal(g.toRel(repo.root, path.join(repo.root, 'dir', 'sub', 'f.js')), 'dir/sub/f.js');
  assert.equal(g.toRel(repo.root, path.join(repo.root, 'top.txt')), 'top.txt');
});

test('shortRef and samePath', () => {
  assert.equal(g.shortRef('origin/dev'), 'dev');
  assert.equal(g.shortRef('feature/x'), 'feature/x');
  assert.ok(g.samePath(repo.root, path.join(repo.root, '.')));
  assert.ok(!g.samePath(repo.root, os.tmpdir()));
});

test('resolveBases uses configured branches, preferring origin', async () => {
  state.config['gitCompass.baseBranches'] = ['side', 'missing'];
  g.clearBaseCache();
  assert.deepEqual(await g.resolveBases(repo.root), ['side']);
  delete state.config['gitCompass.baseBranches'];
  g.clearBaseCache();
});

test('resolveBases falls back to the remote default branch', async () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-origin-')));
  try {
    repo.git('init', '-q', '--bare', '-b', 'main', bare);
    repo.git('remote', 'add', 'origin', bare);
    repo.git('push', '-q', 'origin', 'main', 'side');
    repo.git('remote', 'set-head', 'origin', 'main');
    g.clearBaseCache();
    assert.deepEqual(await g.resolveBases(repo.root), ['origin/main']);
    state.config['gitCompass.baseBranches'] = ['side'];
    g.clearBaseCache();
    assert.deepEqual(await g.resolveBases(repo.root), ['origin/side']);
  } finally {
    delete state.config['gitCompass.baseBranches'];
    g.clearBaseCache();
    repo.git('remote', 'remove', 'origin');
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('targetFile resolves a file and a revision document', () => {
  const file = g.targetFile(vscode.Uri.file(path.join(repo.root, 'src', 'b.js')));
  assert.equal(file.rel, 'src/b.js');
  assert.equal(file.root, repo.root);
  const fromRef = g.targetFile(g.refUri(repo.root, 'src/b.js', 'HEAD'));
  assert.equal(fromRef.rel, 'src/b.js');
  assert.throws(() => g.targetFile(vscode.Uri.parse('untitled:x')), /Open a file/);
});

test('git reports errors with stderr text', async () => {
  await assert.rejects(g.git(repo.root, ['rev-parse', '--verify', 'no-such-ref']), /no-such-ref|fatal|Needed a single revision/);
  assert.equal(await g.refExists(repo.root, 'no-such-ref'), false);
  assert.equal(await g.refExists(repo.root, 'side'), true);
});

test('non-ASCII file names come back unquoted', async () => {
  const r = createRepo();
  try {
    r.write('base.txt', 'x\n');
    r.commit('base');
    r.write('café/日本.txt', 'hi\n');
    const sha = r.commit('add unicode file');
    const files = await g.commitFiles(r.root, sha);
    assert.deepEqual(files.map((f) => f.path), ['café/日本.txt']);
  } finally {
    r.cleanup();
  }
});

test('a missing git binary gives a clear message', () => {
  const e = g.gitError(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }), '');
  assert.match(e.message, /Git was not found/);
  assert.equal(g.gitError(new Error('x'), 'fatal: bad revision\n').message, 'fatal: bad revision');
});

test('fetchRef refuses refs that look like options', async () => {
  await assert.rejects(g.fetchRef(repo.root, '--upload-pack=evil'), /looks like a git option/);
});

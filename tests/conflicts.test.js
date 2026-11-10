const { state, reset } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const c = require('../conflicts');

function tryGit(r, ...args) {
  try {
    execFileSync('git', args, { cwd: r.root, stdio: 'pipe', env: { ...process.env, GIT_EDITOR: 'true', GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@example.com' } });
    return true;
  } catch {
    return false;
  }
}

function mergeConflict() {
  const r = createRepo();
  r.write('a.txt', 'base\n');
  r.commit('base');
  r.git('switch', '-q', '-c', 'feature');
  r.write('a.txt', 'feature\n');
  r.commit('feature change');
  r.git('switch', '-q', 'main');
  r.write('a.txt', 'main\n');
  r.commit('main change');
  assert.strictEqual(tryGit(r, 'merge', '--no-edit', 'feature'), false);
  return r;
}

function rebaseConflict() {
  const r = createRepo();
  r.write('a.txt', 'base\n');
  r.commit('base');
  r.git('switch', '-q', '-c', 'feature');
  r.write('b.txt', 'one\n');
  r.commit('feat: add b');
  r.write('a.txt', 'feature\n');
  r.commit('feat: change a');
  r.write('c.txt', 'three\n');
  r.commit('feat: add c');
  r.git('switch', '-q', 'main');
  r.write('a.txt', 'main\n');
  r.commit('main change');
  r.git('switch', '-q', 'feature');
  assert.strictEqual(tryGit(r, 'rebase', 'main'), false);
  return r;
}

test.beforeEach(() => reset());

test('describes every unmerged status code', () => {
  assert.strictEqual(c.describeConflict('UU'), 'Changed on both sides');
  assert.strictEqual(c.describeConflict('AA'), 'Added on both sides');
  assert.strictEqual(c.describeConflict('DU'), 'Deleted in current, changed in incoming');
  assert.strictEqual(c.describeConflict('UD'), 'Changed in current, deleted in incoming');
  assert.strictEqual(c.describeConflict('AU'), 'Added in current only');
  assert.strictEqual(c.describeConflict('UA'), 'Added in incoming only');
  assert.strictEqual(c.describeConflict('DD'), 'Deleted on both sides');
});

test('parses porcelain -z output into unmerged and staged files', () => {
  const out = ['UU both.txt', 'AA added.txt', 'DU gone-here.txt', 'UD gone-there.txt', 'M  staged.txt', 'R  new.txt', 'old.txt', ' M unstaged.txt', ''].join('\0');
  const { unmerged, staged } = c.parseStatus(out);
  assert.deepStrictEqual(unmerged, [
    { code: 'UU', path: 'both.txt' },
    { code: 'AA', path: 'added.txt' },
    { code: 'DU', path: 'gone-here.txt' },
    { code: 'UD', path: 'gone-there.txt' },
  ]);
  assert.deepStrictEqual(staged.map((s) => s.path), ['staged.txt', 'new.txt']);
});

test('knows which side of a conflict still has the file', () => {
  assert.deepStrictEqual(['UU', 'AA', 'DU', 'UD', 'AU', 'UA', 'DD'].map((code) => [c.sideExists(code, 'ours'), c.sideExists(code, 'theirs')]), [
    [true, true],
    [true, true],
    [false, true],
    [true, false],
    [true, false],
    [false, true],
    [false, false],
  ]);
});

test('detects a merge and labels the sides', async () => {
  const r = mergeConflict();
  try {
    const op = await c.detectOperation(r.root);
    assert.strictEqual(op.kind, 'merge');
    assert.strictEqual(op.label, 'Merging feature into main');
    assert.strictEqual(op.ours, 'Current (main)');
    assert.strictEqual(op.theirs, 'Incoming (feature)');
    const s = await c.readState(r.root);
    assert.deepStrictEqual(s.files, [{ code: 'UU', path: 'a.txt' }]);
  } finally {
    r.cleanup();
  }
});

test('detects a rebase with progress and labels the sides the rebase way', async () => {
  const r = rebaseConflict();
  try {
    const op = await c.detectOperation(r.root);
    assert.strictEqual(op.kind, 'rebase');
    assert.strictEqual(op.branch, 'feature');
    assert.strictEqual(op.step, 2);
    assert.strictEqual(op.total, 3);
    assert.strictEqual(op.label, 'Rebasing feature onto main (2/3)');
    assert.strictEqual(op.ours, 'Current (main)');
    assert.strictEqual(op.theirs, 'Incoming (feat: change a)');
  } finally {
    r.cleanup();
  }
});

test('detects a cherry-pick', async () => {
  const r = createRepo();
  try {
    r.write('a.txt', 'base\n');
    r.commit('base');
    r.git('switch', '-q', '-c', 'feature');
    r.write('a.txt', 'feature\n');
    const sha = r.commit('pick me');
    r.git('switch', '-q', 'main');
    r.write('a.txt', 'main\n');
    r.commit('main change');
    assert.strictEqual(tryGit(r, 'cherry-pick', sha), false);
    const op = await c.detectOperation(r.root);
    assert.strictEqual(op.kind, 'cherryPick');
    assert.strictEqual(op.label, `Cherry-picking ${sha.slice(0, 7)} pick me`);
    assert.strictEqual(op.ours, 'Current (main)');
    assert.strictEqual(c.skipArgs(op.kind).join(' '), 'cherry-pick --skip');
  } finally {
    r.cleanup();
  }
});

test('no operation means nothing to detect', async () => {
  const r = createRepo();
  try {
    r.write('a.txt', 'x\n');
    r.commit('one');
    assert.strictEqual(await c.detectOperation(r.root), undefined);
    const s = await c.readState(r.root);
    assert.deepStrictEqual(s.files, []);
  } finally {
    r.cleanup();
  }
});

test('accept current keeps our version and stages it', async () => {
  const r = mergeConflict();
  try {
    assert.strictEqual(await c.acceptSide(r.root, 'a.txt', 'UU', 'ours'), 'kept');
    assert.strictEqual(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'main\n');
    assert.deepStrictEqual((await c.readState(r.root)).files, []);
  } finally {
    r.cleanup();
  }
});

test('accept incoming takes their version and stages it', async () => {
  const r = mergeConflict();
  try {
    await c.acceptSide(r.root, 'a.txt', 'UU', 'theirs');
    assert.strictEqual(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'feature\n');
    assert.deepStrictEqual((await c.readState(r.root)).files, []);
  } finally {
    r.cleanup();
  }
});

test('accepting the side that deleted a file removes it', async () => {
  const r = createRepo();
  try {
    r.write('a.txt', 'base\n');
    r.commit('base');
    r.git('switch', '-q', '-c', 'feature');
    r.write('a.txt', 'changed\n');
    r.commit('change a');
    r.git('switch', '-q', 'main');
    r.git('rm', '-q', 'a.txt');
    r.commit('delete a');
    assert.strictEqual(tryGit(r, 'merge', '--no-edit', 'feature'), false);
    const { files } = await c.readState(r.root);
    assert.deepStrictEqual(files, [{ code: 'DU', path: 'a.txt' }]);
    assert.strictEqual(await c.acceptSide(r.root, 'a.txt', 'DU', 'ours'), 'removed');
    assert.strictEqual(fs.existsSync(path.join(r.root, 'a.txt')), false);
    assert.deepStrictEqual((await c.readState(r.root)).files, []);
  } finally {
    r.cleanup();
  }
});

test('warns about leftover markers and marks a hand-edited file resolved', async () => {
  const r = mergeConflict();
  try {
    assert.strictEqual(c.hasMarkers(r.root, 'a.txt'), true);
    fs.writeFileSync(path.join(r.root, 'a.txt'), 'main and feature\n');
    assert.strictEqual(c.hasMarkers(r.root, 'a.txt'), false);
    await c.markResolved(r.root, 'a.txt');
    assert.deepStrictEqual((await c.readState(r.root)).files, []);
  } finally {
    r.cleanup();
  }
});

test('continue refuses while files are unresolved, then finishes the merge', async () => {
  const r = mergeConflict();
  try {
    await assert.rejects(c.continueOperation(r.root), /Resolve the remaining 1 conflicted file first/);
    await c.acceptSide(r.root, 'a.txt', 'UU', 'theirs');
    const result = await c.continueOperation(r.root);
    assert.strictEqual(result.stoppedAgain, false);
    assert.strictEqual(result.state.op, undefined);
    assert.strictEqual(r.git('rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
  } finally {
    r.cleanup();
  }
});

test('abort restores the branch before the merge', async () => {
  const r = mergeConflict();
  try {
    const op = await c.abortOperation(r.root);
    assert.strictEqual(op.kind, 'merge');
    assert.strictEqual(await c.detectOperation(r.root), undefined);
    assert.strictEqual(fs.readFileSync(path.join(r.root, 'a.txt'), 'utf8'), 'main\n');
  } finally {
    r.cleanup();
  }
});

test('continue finishes a rebase after resolving', async () => {
  const r = rebaseConflict();
  try {
    await c.acceptSide(r.root, 'a.txt', 'UU', 'theirs');
    const result = await c.continueOperation(r.root);
    assert.strictEqual(result.stoppedAgain, false);
    assert.strictEqual(await c.detectOperation(r.root), undefined);
    assert.strictEqual(r.git('symbolic-ref', '--short', 'HEAD').trim(), 'feature');
    assert.deepStrictEqual(r.git('log', '--format=%s', '-4').trim().split('\n'), ['feat: add c', 'feat: change a', 'feat: add b', 'main change']);
  } finally {
    r.cleanup();
  }
});

test('abort cancels a rebase', async () => {
  const r = rebaseConflict();
  try {
    const before = r.git('rev-parse', 'ORIG_HEAD').trim();
    await c.abortOperation(r.root);
    assert.strictEqual(await c.detectOperation(r.root), undefined);
    assert.strictEqual(r.git('rev-parse', 'HEAD').trim(), before);
  } finally {
    r.cleanup();
  }
});

test('operation argument tables', () => {
  assert.deepStrictEqual(c.continueArgs('merge'), ['commit', '--no-edit']);
  assert.deepStrictEqual(c.continueArgs('rebase'), ['rebase', '--continue']);
  assert.deepStrictEqual(c.abortArgs('revert'), ['revert', '--abort']);
  assert.strictEqual(c.skipArgs('merge'), undefined);
  assert.ok(state);
});

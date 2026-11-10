const { state, reset } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pr = require('../pullRequests');

function twoBranches({ conflict = false } = {}) {
  const r = createRepo();
  r.write('a.txt', 'base\n');
  r.commit('base');
  r.git('switch', '-q', '-c', 'feature');
  r.write(conflict ? 'a.txt' : 'f.txt', 'feature\n');
  const featureSha = r.commit('feature work');
  r.git('switch', '-q', 'main');
  return { ...r, featureSha };
}

test.beforeEach(() => reset());

test('merge strategy argv', () => {
  assert.deepStrictEqual(pr.mergeArgs('noff', 'feature'), ['merge', '--no-ff', '--no-edit', 'feature']);
  assert.deepStrictEqual(pr.mergeArgs('ffonly', 'origin/x'), ['merge', '--ff-only', 'origin/x']);
  assert.deepStrictEqual(pr.mergeArgs('squash', 'feature'), ['merge', '--squash', 'feature']);
  assert.deepStrictEqual(pr.mergeArgs('default', 'feature'), ['merge', '--no-edit', 'feature']);
  assert.deepStrictEqual(pr.BRANCH_STRATEGIES.map((s) => s.id), ['noff', 'ffonly', 'squash', 'default']);
});

test('merge commit records two parents', async () => {
  const r = twoBranches();
  try {
    assert.strictEqual(await pr.mergeBranch(r.root, 'feature', 'noff'), 'ok');
    assert.strictEqual(r.git('rev-list', '--parents', '-n1', 'HEAD').trim().split(' ').length, 3);
  } finally {
    r.cleanup();
  }
});

test('fast-forward only moves the branch to the other commit', async () => {
  const r = twoBranches();
  try {
    await pr.mergeBranch(r.root, 'feature', 'ffonly');
    assert.strictEqual(r.git('rev-parse', 'HEAD').trim(), r.featureSha);
  } finally {
    r.cleanup();
  }
});

test('fast-forward only fails cleanly when histories diverged', async () => {
  const r = twoBranches();
  try {
    r.write('m.txt', 'main\n');
    r.commit('main work');
    await assert.rejects(pr.mergeBranch(r.root, 'feature', 'ffonly'), /fast-forward|Not possible/i);
  } finally {
    r.cleanup();
  }
});

test('squash stages the changes without committing', async () => {
  const r = twoBranches();
  try {
    const before = r.git('rev-parse', 'HEAD').trim();
    await pr.mergeBranch(r.root, 'feature', 'squash');
    assert.strictEqual(r.git('rev-parse', 'HEAD').trim(), before);
    assert.match(r.git('diff', '--cached', '--name-only'), /f\.txt/);
    assert.match(state.messages.find((m) => m[0] === 'info')[1], /staged/);
  } finally {
    r.cleanup();
  }
});

test('refuses to merge into a dirty working tree', async () => {
  const r = twoBranches();
  try {
    fs.writeFileSync(path.join(r.root, 'a.txt'), 'local edit\n');
    await assert.rejects(pr.mergeBranch(r.root, 'feature', 'default'), /Commit or stash your changes/);
  } finally {
    r.cleanup();
  }
});

test('a conflicting merge focuses the Conflicts view', async () => {
  const r = twoBranches({ conflict: true });
  try {
    r.write('a.txt', 'main\n');
    r.commit('main change');
    assert.strictEqual(await pr.mergeBranch(r.root, 'feature', 'default'), 'conflicts');
    assert.ok(state.executed.some(([id]) => id === 'gitCompass.views.conflicts.focus'));
  } finally {
    r.cleanup();
  }
});

test('rebase onto replays the current branch', async () => {
  const r = twoBranches();
  try {
    r.write('m.txt', 'main\n');
    r.commit('main work');
    r.git('switch', '-q', 'feature');
    await pr.rebaseOnto(r.root, 'main');
    assert.deepStrictEqual(r.git('log', '--format=%s', '-3').trim().split('\n'), ['feature work', 'main work', 'base']);
  } finally {
    r.cleanup();
  }
});

test('update from base fetches origin and merges the latest base', async () => {
  const r = createRepo();
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-origin-')));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-clone-')));
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    r.write('a.txt', 'base\n');
    r.commit('base');
    r.git('remote', 'add', 'origin', bare);
    r.git('push', '-q', '-u', 'origin', 'main');
    r.git('switch', '-q', '-c', 'feature');
    r.write('f.txt', 'feature\n');
    r.commit('feature work');
    const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
    execFileSync('git', ['clone', '-q', bare, other], { env });
    fs.writeFileSync(path.join(other, 'n.txt'), 'new on main\n');
    execFileSync('git', ['add', '-A'], { cwd: other, env });
    execFileSync('git', ['commit', '-q', '-m', 'upstream work'], { cwd: other, env });
    execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other, env });
    state.config['gitCompass.baseBranches'] = ['main'];
    assert.strictEqual(await pr.updateFromBase(r.root), 'ok');
    assert.ok(fs.existsSync(path.join(r.root, 'n.txt')));
    assert.match(r.git('log', '--format=%s', '-5'), /upstream work/);
  } finally {
    r.cleanup();
    fs.rmSync(bare, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

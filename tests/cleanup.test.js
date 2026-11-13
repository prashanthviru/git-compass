const { state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const g = require('../git');
const views = require('../views');
const cleanup = require('../cleanup');

test.beforeEach(() => reset());

const now = 1_800_000_000;
const day = 86400;

test('classifyBranches keeps protected, current and worktree branches out', () => {
  const branches = [
    { name: 'main', time: now - 400 * day },
    { name: 'merged-1', time: now - day },
    { name: 'gone-1', gone: true, time: now - day },
    { name: 'old-1', time: now - 200 * day },
    { name: 'fresh', time: now - day },
    { name: 'mine', time: now - 300 * day },
    { name: 'in-worktree', time: now - 300 * day },
    { name: 'release', time: now - 300 * day },
  ];
  const out = cleanup.classifyBranches(branches, {
    merged: new Set(['main', 'merged-1']),
    current: 'mine',
    protectedList: ['release'],
    baseNames: ['main'],
    worktreeBranches: new Set(['in-worktree']),
    now,
    staleDays: 90,
    base: 'main',
  });
  assert.deepEqual(out.map((c) => [c.name, c.reasons, c.picked]), [
    ['merged-1', ['merged'], true],
    ['gone-1', ['gone'], true],
    ['old-1', ['stale'], false],
  ]);
  assert.equal(out[2].ageDays, 200);
  assert.deepEqual(cleanup.classifyBranches(branches.slice(3, 4), { now, staleDays: 0 }), []);
});

test('Clean Up Branches deletes the picked branches and remembers them', async () => {
  const r = createRepo();
  const context = createContext();
  try {
    r.write('a.txt', 'a\n');
    r.commit('base');
    r.git('branch', 'merged-feature');
    r.git('switch', '-q', '-c', 'old-experiment');
    r.write('old.txt', 'o\n');
    const date = '2020-01-01T00:00:00Z';
    execFileSync('git', ['commit', '-q', '-am', 'old', '--allow-empty'], { cwd: r.root, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
    r.git('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', 'old work'], { cwd: r.root, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
    const oldSha = r.git('rev-parse', 'HEAD').trim();
    r.git('switch', '-q', 'main');
    r.git('switch', '-q', '-c', 'active');
    r.write('active.txt', 'x\n');
    r.commit('active work');
    r.git('switch', '-q', 'main');

    state.repos = [makeRepo(r.root, 'main')];
    state.config['gitCompass.baseBranches'] = ['main'];
    await g.getGitApi();
    g.clearBaseCache();
    views.register(context);

    const found = await cleanup.findCandidates(r.root);
    assert.deepEqual(found.map((c) => [c.name, c.reasons]), [['merged-feature', ['merged']], ['old-experiment', ['stale']]]);

    state.answers = [(items) => items, 'Delete'];
    const deleted = await cleanup.cleanUpBranches({ root: r.root });
    assert.deepEqual(deleted, ['merged-feature', 'old-experiment']);
    assert.equal(r.git('branch', '--format=%(refname:short)').trim().split('\n').sort().join(' '), 'active main');
    assert.deepEqual(views.deletedBranches(r.root).find((d) => d.name === 'old-experiment').sha, oldSha);

    state.messages = [];
    assert.deepEqual(await cleanup.cleanUpBranches({ root: r.root }), []);
    assert.match(state.messages.at(-1)[1], /Nothing to clean up/);
  } finally {
    for (const d of context.subscriptions) d?.dispose?.();
    r.cleanup();
  }
});

test('nothing is deleted when the confirmation is dismissed', async () => {
  const r = createRepo();
  try {
    r.write('a.txt', 'a\n');
    r.commit('base');
    r.git('branch', 'merged-feature');
    state.config['gitCompass.baseBranches'] = ['main'];
    g.clearBaseCache();
    state.answers = [(items) => items, undefined];
    assert.deepEqual(await cleanup.cleanUpBranches({ root: r.root }), []);
    assert.match(r.git('branch', '--list', 'merged-feature'), /merged-feature/);
  } finally {
    r.cleanup();
  }
});

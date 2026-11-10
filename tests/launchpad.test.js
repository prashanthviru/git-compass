const { vscode, state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checksState, classifyPr, groupLaunchpad } = require('../views');

const pr = (number, extra = {}) => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  author: { login: 'someone' },
  headRefName: `feature-${number}`,
  baseRefName: 'main',
  additions: 10,
  deletions: 4,
  updatedAt: new Date().toISOString(),
  statusCheckRollup: [],
  reviewDecision: '',
  mergeable: 'MERGEABLE',
  isDraft: false,
  ...extra,
});

const sets = { mine: new Set([1, 2, 3, 4, 5, 6, 7]), review: new Set([8]) };

test('checksState summarises check runs and status contexts', () => {
  assert.equal(checksState(undefined), 'none');
  assert.equal(checksState([]), 'none');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }, { conclusion: 'SKIPPED' }]), 'passing');
  assert.equal(checksState([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }]), 'pending');
  assert.equal(checksState([{ state: 'PENDING' }]), 'pending');
  assert.equal(checksState([{ conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'failing');
  assert.equal(checksState([{ state: 'ERROR' }]), 'failing');
  assert.equal(checksState([{ conclusion: 'TIMED_OUT' }]), 'failing');
});

test('classifyPr puts each pull request in the right group', () => {
  const cases = [
    [1, { isDraft: true }, 'draft'],
    [2, { statusCheckRollup: [{ conclusion: 'FAILURE' }] }, 'blocked'],
    [3, { mergeable: 'CONFLICTING' }, 'blocked'],
    [4, { reviewDecision: 'CHANGES_REQUESTED' }, 'blocked'],
    [5, { reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }, 'ready'],
    [6, { reviewDecision: 'REVIEW_REQUIRED' }, 'waiting'],
    [7, { statusCheckRollup: [{ status: 'QUEUED' }] }, 'waiting'],
    [8, {}, 'review'],
    [9, {}, 'assigned'],
  ];
  for (const [n, extra, category] of cases) assert.equal(classifyPr(pr(n, extra), sets).category, category, `#${n}`);
});

test('classifyPr builds badges and only offers merge for ready pull requests', () => {
  const ready = classifyPr(pr(5, { reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }), sets);
  assert.equal(ready.canMerge, true);
  assert.equal(ready.mine, true);
  assert.deepEqual(ready.badges, ['✓ checks', 'approved', '+10 −4']);
  const blocked = classifyPr(pr(3, { mergeable: 'CONFLICTING', statusCheckRollup: [{ conclusion: 'FAILURE' }] }), sets);
  assert.equal(blocked.canMerge, false);
  assert.deepEqual(blocked.badges, ['✗ checks failing', 'conflicts', '+10 −4']);
  assert.equal(classifyPr(pr(8), sets).canMerge, false);
  assert.equal(classifyPr(pr(9), sets).mine, false);
});

test('groupLaunchpad orders groups and moves pinned and snoozed items', () => {
  const items = [1, 2, 5, 6, 8, 9].map((n) => {
    const p = pr(n, n === 5 ? { reviewDecision: 'APPROVED' } : n === 2 ? { mergeable: 'CONFLICTING' } : n === 1 ? { isDraft: true } : {});
    const info = classifyPr(p, sets);
    if (n === 9) info.pinned = true;
    if (n === 6) info.snoozedUntil = Infinity;
    return { type: 'pr', pr: p, info };
  });
  const groups = groupLaunchpad(items);
  assert.deepEqual(groups.map((g) => [g.group.id, g.items.map((i) => i.pr.number)]), [
    ['pinned', [9]],
    ['review', [8]],
    ['blocked', [2]],
    ['ready', [5]],
    ['draft', [1]],
    ['snoozed', [6]],
  ]);
  assert.equal(groups.at(-1).group.collapsed, true);
  assert.deepEqual(groupLaunchpad([]), []);
});

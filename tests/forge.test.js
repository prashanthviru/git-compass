const { state, reset } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert/strict');
const forge = require('../forge');
const { classifyPr } = require('../views');

test.beforeEach(() => {
  reset();
  forge.setRunners();
  forge.clearCache();
});

test('kindFromUrl detects GitLab hosts', () => {
  assert.equal(forge.kindFromUrl('git@gitlab.com:group/repo.git'), 'gitlab');
  assert.equal(forge.kindFromUrl('https://gitlab.example.com/group/sub/repo'), 'gitlab');
  assert.equal(forge.kindFromUrl('ssh://git@code.gitlab.internal:2222/a/b.git'), 'gitlab');
  assert.equal(forge.kindFromUrl('https://github.com/o/r.git'), 'github');
  assert.equal(forge.kindFromUrl(''), 'github');
});

test('kind follows the setting, then the origin URL', async () => {
  const r = createRepo();
  try {
    r.write('a', 'a');
    r.commit('a');
    assert.equal(await forge.kind(r.root), 'github');
    forge.clearCache();
    r.git('remote', 'add', 'origin', 'git@gitlab.com:g/r.git');
    assert.equal(await forge.kind(r.root), 'gitlab');
    state.config['gitCompass.launchpad.provider'] = 'github';
    assert.equal(await forge.kind(r.root), 'github');
  } finally {
    r.cleanup();
  }
});

test('mapMergeRequest turns GitLab merge requests into Launchpad items', () => {
  const mr = (extra) => ({ iid: 7, title: 'Add x', web_url: 'https://gitlab.com/g/r/-/merge_requests/7', author: { username: 'ann' }, source_branch: 'feat', target_branch: 'main', updated_at: '2026-01-01T00:00:00Z', source_project_id: 1, target_project_id: 1, ...extra });
  const pr = forge.mapMergeRequest(mr({ detailed_merge_status: 'mergeable' }));
  assert.equal(pr.number, 7);
  assert.equal(pr.url, 'https://gitlab.com/g/r/-/merge_requests/7');
  assert.equal(pr.headRefName, 'feat');
  assert.equal(pr.isCrossRepository, false);
  assert.equal(pr.forge, 'gitlab');
  const sets = { mine: new Set([7]), review: new Set() };
  assert.equal(classifyPr(pr, sets).category, 'ready');
  assert.ok(!classifyPr(pr, sets).badges.some((b) => b.startsWith('+')), 'no made-up diff stats');
  assert.equal(classifyPr(forge.mapMergeRequest(mr({ draft: true })), sets).category, 'draft');
  assert.equal(classifyPr(forge.mapMergeRequest(mr({ has_conflicts: true })), sets).category, 'blocked');
  assert.equal(classifyPr(forge.mapMergeRequest(mr({ detailed_merge_status: 'ci_must_pass' })), sets).category, 'blocked');
  assert.equal(classifyPr(forge.mapMergeRequest(mr({ detailed_merge_status: 'ci_still_running' })), sets).category, 'waiting');
  assert.equal(classifyPr(forge.mapMergeRequest(mr({ detailed_merge_status: 'not_approved' })), sets).badges.includes('needs review'), true);
  assert.equal(forge.mapMergeRequest(mr({ source_project_id: 2 })).isCrossRepository, true);
});

test('glab argument builders', () => {
  assert.deepEqual(forge.glabMergeArgs({ number: 7, method: 'squash', auto: false, deleteBranch: true }), ['mr', 'merge', '7', '--yes', '--squash', '--remove-source-branch', '--auto-merge=false']);
  assert.deepEqual(forge.glabMergeArgs({ number: 7, method: 'rebase', auto: true }), ['mr', 'merge', '7', '--yes', '--rebase', '--auto-merge=true']);
  assert.deepEqual(forge.glabCreateArgs({ base: 'origin/main', head: 'feat', title: 'T', body: 'B', draft: true, reviewers: '@ann, bo', labels: 'x, y' }), [
    'mr', 'create', '--source-branch', 'feat', '--target-branch', 'main', '--title', 'T', '--description', 'B', '--yes', '--draft', '--reviewer', 'ann,bo', '--label', 'x,y',
  ]);
  assert.deepEqual(forge.checkoutArgs('gitlab', 3), ['mr', 'checkout', '3']);
  assert.deepEqual(forge.checkoutArgs('github', 3), ['pr', 'checkout', '3']);
  assert.equal(forge.headRef('gitlab', 3), 'refs/merge-requests/3/head');
  assert.equal(forge.headRef('github', 3), 'pull/3/head');
  assert.equal(forge.lastUrl('Creating merge request\n!7 Add x\nhttps://gitlab.com/g/r/-/merge_requests/7\n'), 'https://gitlab.com/g/r/-/merge_requests/7');
  assert.equal(forge.noun('gitlab'), 'merge request');
});

test('listForLaunchpad asks glab for authored, review and assigned merge requests', async () => {
  const calls = [];
  forge.setRunners({
    glab: async (cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'api') return JSON.stringify({ username: 'ann' });
      return JSON.stringify([{ iid: args.includes('--reviewer') ? 2 : 1, title: 't', author: { username: 'ann' } }]);
    },
  });
  state.config['gitCompass.launchpad.provider'] = 'gitlab';
  const [mine, review, assigned] = await forge.listForLaunchpad('/tmp', 'x');
  assert.equal(mine[0].number, 1);
  assert.equal(review[0].number, 2);
  assert.equal(assigned[0].number, 1);
  assert.deepEqual(calls, ['api user', 'mr list --author ann --per-page 100 --output json', 'mr list --reviewer ann --per-page 100 --output json', 'mr list --assignee ann --per-page 100 --output json']);
});

test('listForLaunchpad uses gh for GitHub', async () => {
  const calls = [];
  forge.setRunners({ gh: async (cwd, args) => (calls.push(args.slice(-2).join(' ')), '[]') });
  state.config['gitCompass.launchpad.provider'] = 'github';
  assert.deepEqual(await forge.listForLaunchpad('/tmp', 'number'), [[], [], []]);
  assert.deepEqual(calls, ['--author @me', '--search review-requested:@me', '--search assignee:@me']);
});

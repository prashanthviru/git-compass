const { vscode, state, reset } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pr = require('../pullRequests');

function withOrigin() {
  const r = createRepo();
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-origin-')));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  r.write('a.txt', 'base\n');
  r.commit('base');
  r.git('remote', 'add', 'origin', bare);
  r.git('push', '-q', '-u', 'origin', 'main');
  r.git('switch', '-q', '-c', 'feature/login-form');
  r.write('login.js', 'x\n');
  r.commit('feat: add login form');
  return { ...r, bare, cleanupAll: () => { r.cleanup(); fs.rmSync(bare, { recursive: true, force: true }); } };
}

function fakeGh(result = 'https://github.com/acme/app/pull/12\n') {
  const calls = [];
  pr.setGhRunner(async (cwd, args) => {
    const i = args.indexOf('--body-file');
    calls.push({ cwd, args: [...args], body: i >= 0 ? fs.readFileSync(args[i + 1], 'utf8') : undefined });
    return result;
  });
  return calls;
}

test.beforeEach(() => reset());
test.after(() => pr.setGhRunner());

test('push refspec is explicit', () => {
  assert.deepStrictEqual(pr.pushArgs('feature/x'), ['push', '-u', 'origin', 'HEAD:refs/heads/feature/x']);
});

test('refuses to push protected, base or detached branches', () => {
  assert.throws(() => pr.checkPushAllowed('main', 'origin/dev', ['main']), /protected branch/);
  assert.throws(() => pr.checkPushAllowed('dev', 'origin/dev', []), /is the base branch/);
  assert.throws(() => pr.checkPushAllowed('', 'origin/dev', []), /detached/);
  assert.doesNotThrow(() => pr.checkPushAllowed('feature/x', 'origin/dev', ['main', 'dev']));
});

test('builds the gh pr create argv with draft, reviewers and labels', () => {
  assert.deepStrictEqual(
    pr.prCreateArgs({ base: 'origin/dev', head: 'feature/x', title: 'Add x', bodyFile: '/tmp/b.md', draft: true, reviewers: '@alice, bob', labels: 'bug, needs review' }),
    ['pr', 'create', '--base', 'dev', '--head', 'feature/x', '--title', 'Add x', '--body-file', '/tmp/b.md', '--draft', '--reviewer', 'alice,bob', '--label', 'bug', '--label', 'needs review']
  );
  assert.deepStrictEqual(pr.prCreateArgs({ base: 'main', head: 'f', title: 't', bodyFile: 'b' }), ['pr', 'create', '--base', 'main', '--head', 'f', '--title', 't', '--body-file', 'b']);
});

test('finds a pull request template in the usual places', () => {
  const r = createRepo();
  try {
    assert.strictEqual(pr.findPrTemplate(r.root), undefined);
    r.write('docs/pull_request_template.md', 'docs template');
    assert.strictEqual(pr.findPrTemplate(r.root), 'docs template');
    r.write('.github/PULL_REQUEST_TEMPLATE.md', 'upper template');
    assert.strictEqual(pr.findPrTemplate(r.root), 'upper template');
    r.write('.github/pull_request_template.md', 'lower template');
    assert.strictEqual(pr.findPrTemplate(r.root), 'lower template');
  } finally {
    r.cleanup();
  }
});

test('title prefill uses a single commit or a humanised branch name', () => {
  assert.strictEqual(pr.humanizeBranch('feature/login-form_v2'), 'Login form v2');
  assert.strictEqual(pr.defaultTitle([{ subject: 'feat: one thing' }], 'feature/x'), 'feat: one thing');
  assert.strictEqual(pr.defaultTitle([{ subject: 'a' }, { subject: 'b' }], 'fix/broken-cart'), 'Broken cart');
  assert.strictEqual(pr.commitBullets([{ subject: 'second' }, { subject: 'first' }]), '- first\n- second');
});

test('summarises commits and files against the base', async () => {
  const r = withOrigin();
  try {
    const s = await pr.branchSummary(r.root, 'origin/main');
    assert.strictEqual(s.commits.length, 1);
    assert.strictEqual(pr.summaryLine(s), '1 commit · 1 file');
    state.config['gitCompass.baseBranches'] = ['main'];
    assert.deepStrictEqual(await pr.baseOptions(r.root, 'feature/login-form'), ['origin/main']);
  } finally {
    r.cleanupAll();
  }
});

test('submit pushes first, then creates the pull request with the exact argv', async () => {
  const r = withOrigin();
  const calls = fakeGh();
  try {
    state.answers = ['Push and Continue', 'Create Pull Request'];
    const url = await pr.submitPullRequest(r.root, 'feature/login-form', { base: 'origin/main', title: 'feat: add login form', body: '## Summary\n- form', draft: true, reviewers: 'alice', labels: 'ui' });
    assert.strictEqual(url, 'https://github.com/acme/app/pull/12');
    assert.strictEqual(calls.length, 1);
    const args = calls[0].args;
    assert.deepStrictEqual(args.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'feature/login-form', '--title', 'feat: add login form']);
    assert.strictEqual(args[8], '--body-file');
    assert.deepStrictEqual(args.slice(10), ['--draft', '--reviewer', 'alice', '--label', 'ui']);
    assert.strictEqual(calls[0].body, '## Summary\n- form');
    assert.strictEqual(fs.existsSync(args[9]), false);
    const remote = execFileSync('git', ['ls-remote', '--heads', r.bare, 'feature/login-form'], { encoding: 'utf8' }).split('\t')[0];
    assert.strictEqual(remote, r.git('rev-parse', 'HEAD').trim());
    assert.deepStrictEqual(state.messages.filter((m) => m[0] === 'warning').map((m) => m[1]), ['Push feature/login-form to origin and create the pull request?', 'Create pull request feature/login-form → main?']);
  } finally {
    r.cleanupAll();
  }
});

test('submit skips the push when origin is up to date', async () => {
  const r = withOrigin();
  const calls = fakeGh();
  try {
    r.git('push', '-q', 'origin', 'HEAD:refs/heads/feature/login-form');
    state.answers = ['Create Pull Request'];
    await pr.submitPullRequest(r.root, 'feature/login-form', { base: 'origin/main', title: 'T', body: 'B' });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(state.messages.filter((m) => m[0] === 'warning').length, 1);
  } finally {
    r.cleanupAll();
  }
});

test('cancelling the push confirm creates nothing', async () => {
  const r = withOrigin();
  const calls = fakeGh();
  try {
    state.answers = [undefined];
    assert.strictEqual(await pr.submitPullRequest(r.root, 'feature/login-form', { base: 'origin/main', title: 'T', body: 'B' }), undefined);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(execFileSync('git', ['ls-remote', '--heads', r.bare, 'feature/login-form'], { encoding: 'utf8' }).trim(), '');
  } finally {
    r.cleanupAll();
  }
});

test('submit refuses a protected head or an empty title', async () => {
  const r = withOrigin();
  fakeGh();
  try {
    await assert.rejects(pr.submitPullRequest(r.root, 'main', { base: 'origin/dev', title: 'T' }), /protected branch/);
    await assert.rejects(pr.submitPullRequest(r.root, 'feature/login-form', { base: 'origin/main', title: '  ' }), /Add a title/);
  } finally {
    r.cleanupAll();
  }
});

test('push current branch refuses protected branches and pushes otherwise', async () => {
  const r = withOrigin();
  try {
    state.answers = ['Push'];
    assert.strictEqual(await pr.pushCurrentBranch(r.root), true);
    assert.strictEqual(execFileSync('git', ['ls-remote', '--heads', r.bare, 'feature/login-form'], { encoding: 'utf8' }).split('\t')[0], r.git('rev-parse', 'HEAD').trim());
    r.git('switch', '-q', 'main');
    await assert.rejects(pr.pushCurrentBranch(r.root), /protected branch/);
  } finally {
    r.cleanupAll();
  }
});

test('pull request merge argv and warnings', () => {
  assert.deepStrictEqual(pr.prMergeArgs({ number: 7, method: 'squash' }), ['pr', 'merge', '7', '--squash']);
  assert.deepStrictEqual(pr.prMergeArgs({ number: 7, method: 'rebase', auto: true, deleteBranch: true }), ['pr', 'merge', '7', '--rebase', '--auto', '--delete-branch']);
  assert.deepStrictEqual(pr.prMergeArgs({ number: 7, method: 'merge' }), ['pr', 'merge', '7', '--merge']);
  assert.deepStrictEqual(
    pr.prWarnings({ statusCheckRollup: [{ conclusion: 'FAILURE' }], reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING', isDraft: true }),
    ['Checks are failing.', 'It has not been approved yet.', 'It has merge conflicts with the base branch.', 'It is still a draft.']
  );
  assert.deepStrictEqual(pr.prWarnings({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }], reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', isDraft: false }), ['Checks are still running.']);
  assert.deepStrictEqual(pr.prWarnings({ statusCheckRollup: [], reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' }), []);
});

test('merging a pull request with auto-merge and branch deletion runs the right gh command', async () => {
  const calls = fakeGh('');
  state.answers = [(items) => items.find((i) => i.id === 'auto'), (items) => items.find((i) => i.id === 'squash'), (items) => items.find((i) => i.value === true), 'Enable Auto-Merge'];
  const node = { root: os.tmpdir(), pr: { number: 7, title: 'Add x', headRefName: 'feature/x', baseRefName: 'main', statusCheckRollup: [{ status: 'IN_PROGRESS' }], reviewDecision: 'APPROVED' } };
  const args = await pr.mergePullRequest(node);
  assert.deepStrictEqual(args, ['pr', 'merge', '7', '--squash', '--auto', '--delete-branch']);
  assert.deepStrictEqual(calls[0].args, args);
  assert.match(state.messages.find((m) => m[0] === 'warning')[1], /Enable auto-merge for #7/);
});

test('declining the merge confirm does nothing', async () => {
  const calls = fakeGh('');
  state.answers = [(items) => items.find((i) => i.id === 'merge'), (items) => items[0], undefined];
  const node = { root: os.tmpdir(), pr: { number: 9, title: 't', headRefName: 'f', baseRefName: 'main' } };
  assert.strictEqual(await pr.mergePullRequest(node), undefined);
  assert.strictEqual(calls.length, 0);
});

test('the create form uses a strict nonce CSP', () => {
  const html = pr.formHtml({ cspSource: 'vscode-resource:' }, 'abc123');
  assert.match(html, /script-src 'nonce-abc123'/);
  assert.match(html, /default-src 'none'/);
  assert.ok(!html.includes('${'));
  assert.ok(vscode);
});

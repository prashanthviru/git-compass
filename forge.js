const vscode = require('vscode');
const { execFile } = require('child_process');
const g = require('./git');

// Launchpad, checkout, merge and create work with GitHub (gh) and GitLab (glab).
// GitLab merge requests are mapped onto the same shape as GitHub pull requests, so the
// views and merge flows stay the same for both.

const kindCache = new Map();
let glabRunner;
let ghRunner;
let gitlabUser;

function run(cmd, cwd, args, missing) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, GLAB_NO_PROMPT: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? missing : (stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function gh(cwd, args) {
  if (ghRunner) return ghRunner(cwd, args);
  return run('gh', cwd, args, 'Install the GitHub CLI (gh) and run gh auth login to see pull requests.');
}

function glab(cwd, args) {
  if (glabRunner) return glabRunner(cwd, args);
  return run('glab', cwd, args, 'Install the GitLab CLI (glab) and run glab auth login to see merge requests.');
}

function setRunners({ gh: ghFn, glab: glabFn } = {}) {
  ghRunner = ghFn;
  glabRunner = glabFn;
  gitlabUser = undefined;
}

// "gitlab" for gitlab.com and self-hosted hosts with "gitlab" in the name, otherwise "github".
function kindFromUrl(url) {
  const host = (/^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(String(url || ''))?.[1] || '').toLowerCase();
  return host.includes('gitlab') ? 'gitlab' : 'github';
}

async function kind(root) {
  const setting = g.config().get('launchpad.provider', 'auto');
  if (setting === 'github' || setting === 'gitlab') return setting;
  if (!kindCache.has(root)) {
    kindCache.set(
      root,
      g
        .git(root, ['remote', 'get-url', 'origin'])
        .then((url) => kindFromUrl(url.trim()))
        .catch(() => 'github')
    );
  }
  return kindCache.get(root);
}

function clearCache() {
  kindCache.clear();
}

function noun(k) {
  return k === 'gitlab' ? 'merge request' : 'pull request';
}

const CHECKS = {
  ci_still_running: [{ state: 'PENDING' }],
  checking: [{ state: 'PENDING' }],
  ci_must_pass: [{ state: 'FAILURE' }],
};

// A GitLab merge request (glab mr list --output json) as a GitHub-shaped pull request.
function mapMergeRequest(mr) {
  const status = mr.detailed_merge_status || mr.merge_status || '';
  const review = { not_approved: 'REVIEW_REQUIRED', requested_changes: 'CHANGES_REQUESTED', approved: 'APPROVED' }[status];
  return {
    number: mr.iid,
    title: mr.title || '',
    url: mr.web_url || '',
    author: { login: mr.author?.username || '' },
    headRefName: mr.source_branch || '',
    baseRefName: mr.target_branch || '',
    isDraft: !!(mr.draft || mr.work_in_progress || status === 'draft_status'),
    reviewDecision: review,
    mergeable: mr.has_conflicts || status === 'conflict' ? 'CONFLICTING' : 'MERGEABLE',
    isCrossRepository: !!mr.source_project_id && !!mr.target_project_id && mr.source_project_id !== mr.target_project_id,
    statusCheckRollup: CHECKS[status] || [],
    updatedAt: mr.updated_at || mr.created_at || new Date(0).toISOString(),
    forge: 'gitlab',
  };
}

async function gitlabUsername(root) {
  if (!gitlabUser) {
    gitlabUser = glab(root, ['api', 'user'])
      .then((out) => {
        const name = JSON.parse(out).username;
        if (!name) throw new Error('glab is not signed in. Run glab auth login.');
        return name;
      })
      .catch((e) => {
        gitlabUser = undefined;
        throw e;
      });
  }
  return gitlabUser;
}

// The three lists Launchpad needs: authored by me, waiting for my review, assigned to me.
async function listForLaunchpad(root, ghFields) {
  if ((await kind(root)) === 'gitlab') {
    const user = await gitlabUsername(root);
    const list = (flag) => glab(root, ['mr', 'list', `--${flag}`, user, '--per-page', '100', '--output', 'json']).then((out) => (JSON.parse(out || '[]') || []).map(mapMergeRequest));
    return Promise.all([list('author'), list('reviewer'), list('assignee')]);
  }
  const list = (extra) => gh(root, ['pr', 'list', '--state', 'open', '--limit', '100', '--json', ghFields, ...extra]).then(JSON.parse);
  return Promise.all([list(['--author', '@me']), list(['--search', 'review-requested:@me']), list(['--search', 'assignee:@me'])]);
}

function checkoutArgs(k, number) {
  return k === 'gitlab' ? ['mr', 'checkout', String(number)] : ['pr', 'checkout', String(number)];
}

async function checkout(root, number) {
  const k = await kind(root);
  return (k === 'gitlab' ? glab : gh)(root, checkoutArgs(k, number));
}

// The ref that holds a pull/merge request's commits on origin, for forks.
function headRef(k, number) {
  return k === 'gitlab' ? `refs/merge-requests/${number}/head` : `pull/${number}/head`;
}

function glabMergeArgs({ number, method, auto, deleteBranch }) {
  const args = ['mr', 'merge', String(number), '--yes'];
  if (method === 'squash') args.push('--squash');
  if (method === 'rebase') args.push('--rebase');
  if (deleteBranch) args.push('--remove-source-branch');
  args.push(`--auto-merge=${auto ? 'true' : 'false'}`);
  return args;
}

function glabCreateArgs({ base, head, title, body, draft, reviewers, labels }) {
  const args = ['mr', 'create', '--source-branch', head, '--target-branch', g.shortRef(base), '--title', title, '--description', body || '', '--yes'];
  if (draft) args.push('--draft');
  const r = String(reviewers || '')
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
  if (r.length) args.push('--reviewer', r.join(','));
  const l = String(labels || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (l.length) args.push('--label', l.join(','));
  return args;
}

function lastUrl(out) {
  return (
    String(out)
      .split(/\s+/)
      .filter((w) => /^https?:\/\//.test(w))
      .pop() || String(out).trim().split('\n').pop()
  );
}

function register(context) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gitCompass.launchpad.provider')) clearCache();
    })
  );
}

module.exports = {
  register,
  gh,
  glab,
  setRunners,
  kind,
  kindFromUrl,
  clearCache,
  noun,
  mapMergeRequest,
  listForLaunchpad,
  checkout,
  checkoutArgs,
  headRef,
  glabMergeArgs,
  glabCreateArgs,
  lastUrl,
};

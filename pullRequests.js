const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const g = require('./git');
const views = require('./views');
const { gitEdit, readState } = require('./conflicts');

const TEMPLATE_PATHS = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md'];
const BRANCH_STRATEGIES = [
  { id: 'noff', label: 'Merge commit', description: 'git merge --no-ff — always records a merge commit' },
  { id: 'ffonly', label: 'Fast-forward only', description: 'git merge --ff-only — fails instead of creating a merge commit' },
  { id: 'squash', label: 'Squash', description: 'git merge --squash — stages all changes as one commit for you to make' },
  { id: 'default', label: 'Default', description: 'git merge — fast-forward when possible, otherwise a merge commit' },
];
const PR_METHODS = [
  { id: 'squash', label: 'Squash and merge', flag: '--squash' },
  { id: 'merge', label: 'Create a merge commit', flag: '--merge' },
  { id: 'rebase', label: 'Rebase and merge', flag: '--rebase' },
  { id: 'auto', label: 'Enable auto-merge when checks pass', auto: true },
];

let ghRunner = (cwd, args) => views.gh(cwd, args);
let panel;
let panelState;

function setGhRunner(fn) {
  ghRunner = fn || ((cwd, args) => views.gh(cwd, args));
}

function protectedBranches() {
  return g.config().get('protectedBranches', ['main', 'master', 'develop', 'dev', 'prod', 'production', 'live']);
}

function baseName(base) {
  return g.shortRef(base || '');
}

function checkPushAllowed(branch, base, protectedList = protectedBranches()) {
  if (!branch) throw new Error('Check out a branch first; HEAD is detached.');
  if (protectedList.includes(branch)) throw new Error(`${branch} is a protected branch (gitCompass.protectedBranches). Git Compass will not push it.`);
  if (base && baseName(base) === branch) throw new Error(`${branch} is the base branch. Create a pull request from a different branch.`);
}

function pushArgs(branch) {
  return ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`];
}

function splitList(text) {
  return String(text || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);
}

function prCreateArgs({ base, head, title, bodyFile, draft, reviewers, labels }) {
  const args = ['pr', 'create', '--base', baseName(base), '--head', head, '--title', title, '--body-file', bodyFile];
  if (draft) args.push('--draft');
  const r = splitList(reviewers);
  if (r.length) args.push('--reviewer', r.join(','));
  for (const label of String(labels || '').split(',').map((l) => l.trim()).filter(Boolean)) args.push('--label', label);
  return args;
}

function prMergeArgs({ number, method, auto, deleteBranch }) {
  const flag = PR_METHODS.find((m) => m.id === method)?.flag || '--squash';
  const args = ['pr', 'merge', String(number), flag];
  if (auto) args.push('--auto');
  if (deleteBranch) args.push('--delete-branch');
  return args;
}

function prWarnings(pr) {
  const warnings = [];
  const checks = views.checksState(pr.statusCheckRollup);
  if (checks === 'failing') warnings.push('Checks are failing.');
  if (checks === 'pending') warnings.push('Checks are still running.');
  if (pr.reviewDecision === 'CHANGES_REQUESTED') warnings.push('A reviewer requested changes.');
  else if (pr.reviewDecision === 'REVIEW_REQUIRED') warnings.push('It has not been approved yet.');
  if (pr.mergeable === 'CONFLICTING') warnings.push('It has merge conflicts with the base branch.');
  if (pr.isDraft) warnings.push('It is still a draft.');
  return warnings;
}

function mergeArgs(strategy, ref) {
  return {
    noff: ['merge', '--no-ff', '--no-edit', '--end-of-options', ref],
    ffonly: ['merge', '--ff-only', '--end-of-options', ref],
    squash: ['merge', '--squash', '--end-of-options', ref],
    default: ['merge', '--no-edit', '--end-of-options', ref],
  }[strategy];
}

function humanizeBranch(branch) {
  const last = String(branch || '').split('/').pop().replace(/[-_]+/g, ' ').trim();
  return last ? last.charAt(0).toUpperCase() + last.slice(1) : '';
}

function defaultTitle(commits, branch) {
  return commits.length === 1 ? commits[0].subject : humanizeBranch(branch);
}

function findPrTemplate(root) {
  for (const rel of TEMPLATE_PATHS) {
    const file = path.join(root, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8');
  }
  const dir = path.join(root, '.github', 'PULL_REQUEST_TEMPLATE');
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const first = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()[0];
    if (first) return fs.readFileSync(path.join(dir, first), 'utf8');
  }
  return undefined;
}

async function currentBranchName(root) {
  return (await g.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
}

async function isDirty(root) {
  return !!(await g.git(root, ['status', '--porcelain', '--untracked-files=no'])).trim();
}

async function requireClean(root, action) {
  if (await isDirty(root)) throw new Error(`Commit or stash your changes before you ${action}.`);
}

async function branchSummary(root, base) {
  const mergeBase = (await g.git(root, ['merge-base', base, 'HEAD']).catch(() => '')).trim();
  if (!mergeBase) return { commits: [], files: 0, mergeBase: '' };
  const [commits, files] = await Promise.all([
    g.logCommits(root, ['--no-merges', '-n200', `${mergeBase}..HEAD`, '--']),
    g.git(root, ['diff', '--name-only', mergeBase, 'HEAD']).then((o) => o.split('\n').filter(Boolean).length),
  ]);
  return { commits, files, mergeBase };
}

function summaryLine({ commits, files }) {
  return `${commits.length} commit${commits.length === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}`;
}

function commitBullets(commits) {
  return commits
    .slice()
    .reverse()
    .map((c) => `- ${c.subject}`)
    .join('\n');
}

async function baseOptions(root, branch) {
  const bases = await g.resolveBases(root);
  const remotes = (await g.git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin']).catch(() => ''))
    .split('\n')
    .filter((r) => r && r !== 'origin' && !r.endsWith('/HEAD') && r !== `origin/${branch}` && !bases.includes(r));
  return [...bases, ...remotes];
}

async function remoteSha(root, branch) {
  try {
    return (await g.git(root, ['ls-remote', '--exit-code', '--heads', 'origin', branch])).split('\t')[0].trim();
  } catch {
    return '';
  }
}

async function needsPush(root, branch) {
  const [remote, local] = await Promise.all([remoteSha(root, branch), g.git(root, ['rev-parse', 'HEAD']).then((s) => s.trim())]);
  return remote !== local;
}

async function confirm(message, detail, action) {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

async function pushBranch(root, branch) {
  await g.remote(root, pushArgs(branch), (repo) => repo.push('origin', branch, true), gitEdit);
}

async function submitPullRequest(root, branch, form) {
  const title = String(form.title || '').trim();
  if (!title) throw new Error('Add a title.');
  if (!form.base) throw new Error('Choose a base branch.');
  checkPushAllowed(branch, form.base);
  if (await needsPush(root, branch)) {
    const go = await confirm(
      `Push ${branch} to origin and create the pull request?`,
      `Runs: git ${pushArgs(branch).join(' ')}\nThen creates a pull request ${branch} → ${baseName(form.base)}. Git Compass never force-pushes; if origin has commits you don't, the push stops and nothing is created.`,
      'Push and Continue'
    );
    if (!go) return undefined;
    await pushBranch(root, branch);
  }
  const extras = [form.draft ? 'Draft' : '', splitList(form.reviewers).length ? `Reviewers: ${splitList(form.reviewers).join(', ')}` : '', form.labels ? `Labels: ${form.labels}` : ''].filter(Boolean).join('\n');
  const ok = await confirm(`Create pull request ${branch} → ${baseName(form.base)}?`, `Title: ${title}${extras ? `\n${extras}` : ''}\n\nThis creates the pull request on GitHub.`, 'Create Pull Request');
  if (!ok) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-pr-'));
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, String(form.body || ''));
  try {
    const out = await ghRunner(root, prCreateArgs({ base: form.base, head: branch, title, bodyFile, draft: !!form.draft, reviewers: form.reviewers, labels: form.labels }));
    return out.trim().split('\n').pop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function nonce() {
  return crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

function formHtml(webview, n) {
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${n}'; script-src 'nonce-${n}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Create Pull Request</title>
<style nonce="${n}">
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 24px; max-width: 820px; }
h1 { font-size: 1.3em; font-weight: 600; margin: 0 0 4px; }
.sub { color: var(--vscode-descriptionForeground); margin-bottom: 18px; }
label { display: block; font-weight: 600; margin: 14px 0 6px; }
input[type=text], select, textarea { width: 100%; box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 6px 8px; font-family: inherit; font-size: inherit; border-radius: 2px; }
input[type=text]:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
textarea { min-height: 240px; resize: vertical; font-family: var(--vscode-editor-font-family); }
.row { display: flex; gap: 12px; align-items: center; }
.row > * { flex: 1; }
.head { padding: 6px 8px; background: var(--vscode-textBlockQuote-background); border-radius: 2px; font-family: var(--vscode-editor-font-family); }
.arrow { flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
.check { display: flex; align-items: center; gap: 6px; margin-top: 14px; font-weight: normal; }
.summary { color: var(--vscode-descriptionForeground); margin-top: 6px; }
.actions { display: flex; gap: 8px; margin-top: 20px; align-items: center; }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 7px 14px; cursor: pointer; border-radius: 2px; font-family: inherit; font-size: inherit; }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: 0.6; cursor: default; }
.error { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 8px 10px; margin-top: 14px; white-space: pre-wrap; display: none; }
.busy { color: var(--vscode-descriptionForeground); }
.hidden { display: none; }
</style>
</head>
<body>
<h1>Create Pull Request</h1>
<div class="sub" id="repo"></div>
<div class="row">
  <div><label>Compare</label><div class="head" id="head"></div></div>
  <div class="arrow">→</div>
  <div><label for="base">Base</label><select id="base"></select></div>
</div>
<div class="summary" id="summary"></div>
<label for="title">Title</label>
<input type="text" id="title" maxlength="256">
<label for="body">Description</label>
<textarea id="body"></textarea>
<div class="row">
  <div><label for="reviewers">Reviewers</label><input type="text" id="reviewers" placeholder="octocat, hubot"></div>
  <div><label for="labels">Labels</label><input type="text" id="labels" placeholder="bug, enhancement"></div>
</div>
<label class="check"><input type="checkbox" id="draft"> Create as draft</label>
<div class="error" id="error"></div>
<div class="actions">
  <button id="submit">Create Pull Request</button>
  <button id="ai" class="secondary hidden">Write with AI</button>
  <button id="cancel" class="secondary">Cancel</button>
  <span class="busy" id="busy"></span>
</div>
<script nonce="${n}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let edited = { title: false, body: false };
let busy = false;
function setBusy(text) {
  busy = !!text;
  $('busy').textContent = text || '';
  for (const id of ['submit', 'ai', 'base']) $(id).disabled = busy;
}
function showError(message) {
  $('error').textContent = message || '';
  $('error').style.display = message ? 'block' : 'none';
}
$('title').addEventListener('input', () => { edited.title = true; });
$('body').addEventListener('input', () => { edited.body = true; });
$('base').addEventListener('change', () => { showError(''); vscode.postMessage({ type: 'base', base: $('base').value }); });
$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
$('ai').addEventListener('click', () => { showError(''); setBusy('Writing with AI…'); vscode.postMessage({ type: 'ai', base: $('base').value }); });
$('submit').addEventListener('click', () => {
  if (busy) return;
  showError('');
  setBusy('Working…');
  vscode.postMessage({ type: 'submit', form: { base: $('base').value, title: $('title').value, body: $('body').value, reviewers: $('reviewers').value, labels: $('labels').value, draft: $('draft').checked } });
});
window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type === 'init') {
    $('repo').textContent = m.repo;
    $('head').textContent = m.branch;
    const select = $('base');
    select.textContent = '';
    for (const b of m.bases) { const o = document.createElement('option'); o.value = b; o.textContent = b; select.appendChild(o); }
    select.value = m.base;
    $('title').value = m.title;
    $('body').value = m.body;
    $('summary').textContent = m.summary;
    $('draft').checked = !!m.draft;
    $('ai').classList.toggle('hidden', !m.aiEnabled);
    edited = { title: false, body: false };
    setBusy('');
    showError('');
  } else if (m.type === 'summary') {
    $('summary').textContent = m.summary;
    if (!edited.title && m.title !== undefined) $('title').value = m.title;
    if (!edited.body && m.body !== undefined) $('body').value = m.body;
  } else if (m.type === 'draft') {
    $('title').value = m.title;
    $('body').value = m.body;
    edited = { title: true, body: true };
    setBusy('');
  } else if (m.type === 'error') {
    setBusy('');
    showError(m.message);
  } else if (m.type === 'idle') {
    setBusy('');
  }
});
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

async function prefill(root, branch, base, template) {
  const summary = await branchSummary(root, base);
  return { summary: summaryLine(summary), title: defaultTitle(summary.commits, branch), body: template ?? commitBullets(summary.commits) };
}

function aiEnabled() {
  return vscode.workspace.getConfiguration('gitCompass').get('ai.provider', 'none') !== 'none';
}

async function onFormMessage(message) {
  const { root, branch, template } = panelState;
  const post = (m) => panel?.webview.postMessage(m);
  try {
    if (message.type === 'ready') return post(panelState.init);
    if (message.type === 'cancel') return panel?.dispose();
    if (message.type === 'base') {
      const p = await prefill(root, branch, message.base, template);
      return post({ type: 'summary', ...p });
    }
    if (message.type === 'ai') {
      const draft = await require('./ai').draftPullRequest(root, branch, message.base);
      if (!draft) return post({ type: 'error', message: `${branch} has no commits that are not already in ${message.base}.` });
      return post({ type: 'draft', ...draft });
    }
    if (message.type === 'submit') {
      const url = await submitPullRequest(root, branch, message.form);
      if (!url) return post({ type: 'idle' });
      panel?.dispose();
      vscode.commands.executeCommand('gitCompass.refresh');
      const choice = await vscode.window.showInformationMessage(`Pull request created: ${url}`, 'Open', 'Copy URL');
      if (choice === 'Open') await vscode.env.openExternal(vscode.Uri.parse(url));
      else if (choice === 'Copy URL') await vscode.env.clipboard.writeText(url);
    }
  } catch (e) {
    post({ type: 'error', message: e.message });
  }
}

async function openCreateForm(root) {
  const branch = await currentBranchName(root);
  checkPushAllowed(branch);
  const bases = await baseOptions(root, branch);
  if (!bases.length) throw new Error('No branch on origin to target. Push a base branch first, or set gitCompass.baseBranches.');
  const base = bases[0];
  const template = findPrTemplate(root);
  const p = await prefill(root, branch, base, template);
  panelState = {
    root,
    branch,
    template,
    init: { type: 'init', repo: path.basename(root), branch, bases, base, ...p, draft: g.config().get('pr.defaultDraft', false), aiEnabled: aiEnabled() },
  };
  if (panel) {
    panel.reveal();
    panel.webview.postMessage(panelState.init);
    return panel;
  }
  panel = vscode.window.createWebviewPanel('gitCompass.prCreate', `Create Pull Request: ${branch}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  panel.iconPath = new vscode.ThemeIcon('git-pull-request-create');
  panel.webview.html = formHtml(panel.webview, nonce());
  panel.webview.onDidReceiveMessage(onFormMessage);
  panel.onDidDispose(() => {
    panel = undefined;
    panelState = undefined;
  });
  return panel;
}

function rootFromArg(arg) {
  if (arg?.root) return arg.root;
  if (arg?.rootUri) return arg.rootUri.fsPath;
  return g.requireRepo();
}

async function afterLocalMerge(root, error, successMessage) {
  vscode.commands.executeCommand('gitCompass.refresh');
  await vscode.commands.executeCommand('gitCompass.conflicts.refresh');
  if (!error) {
    if (successMessage) vscode.window.showInformationMessage(successMessage);
    return 'ok';
  }
  const s = await readState(root);
  if (s.files.length) {
    await vscode.commands.executeCommand('gitCompass.views.conflicts.focus');
    vscode.window.showWarningMessage(`${s.op ? s.op.label : 'Merge'}: ${s.files.length} file${s.files.length === 1 ? '' : 's'} need resolving. Resolve them in the Conflicts view, then Continue.`);
    return 'conflicts';
  }
  throw error;
}

async function mergeBranch(root, ref, strategy) {
  await requireClean(root, 'merge');
  let error;
  try {
    await gitEdit(root, mergeArgs(strategy, ref));
  } catch (e) {
    error = e;
  }
  return afterLocalMerge(root, error, strategy === 'squash' ? `Changes from ${ref} are staged. Commit them to finish the squash.` : `Merged ${ref}.`);
}

async function rebaseOnto(root, ref) {
  await requireClean(root, 'rebase');
  let error;
  try {
    await gitEdit(root, ['rebase', '--end-of-options', ref]);
  } catch (e) {
    error = e;
  }
  return afterLocalMerge(root, error, `Rebased onto ${ref}.`);
}

async function updateFromBase(root) {
  const base = (await g.resolveBases(root))[0];
  if (!base) throw new Error('No base branch found. Set gitCompass.baseBranches.');
  await requireClean(root, 'update from the base branch');
  if (base.startsWith('origin/')) await g.fetchRef(root, baseName(base), gitEdit);
  let error;
  try {
    await gitEdit(root, mergeArgs('default', base));
  } catch (e) {
    error = e;
  }
  return afterLocalMerge(root, error, `Merged the latest ${base}.`);
}

async function mergePullRequest(node) {
  const { root, pr } = node;
  const method = await vscode.window.showQuickPick(PR_METHODS.map((m) => ({ ...m })), { title: `Merge #${pr.number} into ${pr.baseRefName}` });
  if (!method) return undefined;
  let mergeMethod = method.id;
  if (method.auto) {
    const pick = await vscode.window.showQuickPick(PR_METHODS.filter((m) => !m.auto).map((m) => ({ ...m })), { title: 'When checks pass, merge with…' });
    if (!pick) return undefined;
    mergeMethod = pick.id;
  }
  const deleteDefault = g.config().get('pr.deleteBranchAfterMerge', false);
  const keep = { label: 'Keep the branch', value: false };
  const del = { label: `Delete ${pr.headRefName} after merging`, value: true };
  const branchChoice = await vscode.window.showQuickPick(deleteDefault ? [del, keep] : [keep, del], { title: 'After merging' });
  if (!branchChoice) return undefined;
  const warnings = prWarnings(pr);
  const methodLabel = PR_METHODS.find((m) => m.id === mergeMethod).label.toLowerCase();
  const what = method.auto
    ? `GitHub merges it automatically (${methodLabel}) once all required checks pass.`
    : `GitHub merges it now (${methodLabel}).`;
  const ok = await confirm(
    method.auto ? `Enable auto-merge for #${pr.number}?` : `Merge #${pr.number} into ${pr.baseRefName}?`,
    [`${pr.title}\n${pr.headRefName} → ${pr.baseRefName}`, what, branchChoice.value ? `The branch ${pr.headRefName} is deleted afterwards.` : 'The branch is kept.', warnings.length ? `Warnings:\n• ${warnings.join('\n• ')}` : ''].filter(Boolean).join('\n\n'),
    method.auto ? 'Enable Auto-Merge' : 'Merge'
  );
  if (!ok) return undefined;
  const args = prMergeArgs({ number: pr.number, method: mergeMethod, auto: !!method.auto, deleteBranch: branchChoice.value });
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Merging #${pr.number}…` }, () => ghRunner(root, args));
  vscode.commands.executeCommand('gitCompass.refresh');
  vscode.window.showInformationMessage(method.auto ? `Auto-merge enabled for #${pr.number}.` : `Merged #${pr.number}.`);
  return args;
}

async function resolvePrConflicts(node) {
  const { root, pr } = node;
  const ok = await confirm(
    `Resolve conflicts for #${pr.number} locally?`,
    `Checks out ${pr.headRefName} in this window, fetches ${pr.baseRefName} and merges it in. You resolve the conflicts here, continue, then push to update the pull request.`,
    'Check Out and Merge'
  );
  if (!ok) return undefined;
  await requireClean(root, 'check out the pull request');
  await ghRunner(root, ['pr', 'checkout', String(pr.number)]);
  await g.fetchRef(root, pr.baseRefName, gitEdit);
  let error;
  try {
    await gitEdit(root, mergeArgs('default', `origin/${pr.baseRefName}`));
  } catch (e) {
    error = e;
  }
  const result = await afterLocalMerge(root, error);
  if (result === 'conflicts') {
    vscode.window.showInformationMessage('Resolve the files, then Continue. Afterwards push the branch to update the pull request.', 'Push Current Branch').then((c) => {
      if (c) vscode.commands.executeCommand('gitCompass.pr.pushCurrentBranch');
    });
  } else if ((await vscode.window.showInformationMessage(`${pr.baseRefName} merged cleanly into ${pr.headRefName}. Push to update the pull request.`, 'Push Current Branch')) === 'Push Current Branch') {
    await vscode.commands.executeCommand('gitCompass.pr.pushCurrentBranch');
  }
  return result;
}

async function pushCurrentBranch(root) {
  const branch = await currentBranchName(root);
  checkPushAllowed(branch);
  const s = await readState(root);
  if (s.op || s.files.length) throw new Error('Finish or abort the merge in progress before pushing.');
  if (!(await needsPush(root, branch))) {
    vscode.window.showInformationMessage(`origin/${branch} is already up to date.`);
    return false;
  }
  if (!(await confirm(`Push ${branch} to origin?`, `Runs: git ${pushArgs(branch).join(' ')}\nGit Compass never force-pushes; if origin has commits you don't, the push stops.`, 'Push'))) return false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pushing ${branch}…` }, () => pushBranch(root, branch));
  vscode.commands.executeCommand('gitCompass.refresh');
  vscode.window.showInformationMessage(`Pushed ${branch}.`);
  return true;
}

function branchRef(node) {
  return node.branch.name;
}

function register(context) {
  const commands = {
    'pr.create': (arg) => openCreateForm(rootFromArg(arg)),
    'pr.createFromBranch': async (node) => {
      if (!node?.branch?.current) {
        vscode.window.showInformationMessage(`Pull requests are created from the branch you have checked out. Switch to ${node?.branch?.name || 'that branch'} first.`);
        return;
      }
      await openCreateForm(node.root);
    },
    'pr.merge': (node) => mergePullRequest(node),
    'pr.resolveConflicts': (node) => resolvePrConflicts(node),
    'pr.pushCurrentBranch': (arg) => pushCurrentBranch(rootFromArg(arg)),
    'branch.merge': async (node) => {
      const strategy = await vscode.window.showQuickPick(BRANCH_STRATEGIES, { title: `Merge ${branchRef(node)} into ${g.currentBranch(node.root)}` });
      if (strategy) await mergeBranch(node.root, branchRef(node), strategy.id);
    },
    'branch.rebaseOnto': async (node) => {
      const ref = branchRef(node);
      const cur = g.currentBranch(node.root);
      if (!(await confirm(`Rebase ${cur} onto ${ref}?`, `Replays your commits on top of ${ref}. This rewrites ${cur}'s history: if it is already pushed, updating origin needs a force-push, which Git Compass never does for you.`, 'Rebase'))) return;
      await rebaseOnto(node.root, ref);
    },
    'branch.updateFromBase': (arg) => updateFromBase(rootFromArg(arg)),
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
}

module.exports = {
  register,
  setGhRunner,
  checkPushAllowed,
  pushArgs,
  prCreateArgs,
  prMergeArgs,
  prWarnings,
  mergeArgs,
  humanizeBranch,
  defaultTitle,
  findPrTemplate,
  branchSummary,
  summaryLine,
  commitBullets,
  baseOptions,
  needsPush,
  submitPullRequest,
  mergeBranch,
  rebaseOnto,
  updateFromBase,
  mergePullRequest,
  resolvePrConflicts,
  pushCurrentBranch,
  openCreateForm,
  formHtml,
  splitList,
  BRANCH_STRATEGIES,
  PR_METHODS,
};

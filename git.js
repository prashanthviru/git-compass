const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCHEME = 'git-compass';
const STATUS_SCHEME = 'git-compass-status';
const FS = '\x1f';
const RS = '\x1e';
const END = '\x1d';
const LOG_FORMAT = `--format=${RS}%H${FS}%h${FS}%an${FS}%ae${FS}%ar${FS}%aI${FS}%P${FS}%D${FS}%s${FS}%b${END}`;

const STATUS_LABEL = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict' };
const STATUS_COLOR = {
  A: 'gitDecoration.addedResourceForeground',
  C: 'gitDecoration.addedResourceForeground',
  M: 'gitDecoration.modifiedResourceForeground',
  T: 'gitDecoration.modifiedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  U: 'gitDecoration.conflictingResourceForeground',
};

let gitApi;
const baseCache = new Map();

// Use the git that VS Code's Git extension found (git.path setting, Windows install
// folders, GitHub Desktop, ...), not only whatever is on PATH.
function gitPath() {
  return gitApi?.git?.path || 'git';
}

// LANGUAGE=en keeps git's messages in English so the few we match on (for example
// "not fully merged") work in every locale, without changing the character encoding.
function gitEnv(extra = {}) {
  return { ...process.env, LANGUAGE: 'en', ...extra };
}

function gitError(err, stderr, stdout = '') {
  if (err.code === 'ENOENT') {
    return Object.assign(new Error('Git was not found. Install Git, or set "git.path" to the git executable, then reload the window.'), { code: 'ENOENT' });
  }
  return Object.assign(new Error((stderr || stdout || err.message).trim()), { stdout, stderr, code: err.code });
}

// --no-optional-locks keeps background reads (status, diff) from taking index.lock,
// so they never make the user's own git commands fail with "index.lock exists".
// core.quotePath=false returns non-ASCII file names as-is instead of "caf\303\251.txt",
// and color.ui=false keeps ANSI codes out of output when a user forces color on.
const GIT_PREFIX = ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'color.ui=false'];

function git(cwd, args, { input, signal, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(gitPath(), [...GIT_PREFIX, ...args], { cwd, maxBuffer, signal, env: gitEnv(), windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(gitError(err, stderr));
      else resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function parseStatus(line) {
  const [code, a, b] = line.split('\t');
  const status = code[0];
  return status === 'R' || status === 'C' ? { status, oldPath: a, path: b } : { status, oldPath: a, path: a };
}

function parseNameStatus(out) {
  return out
    .split('\n')
    .filter((l) => /^[ACDMRTU]\d*\t/.test(l))
    .map(parseStatus);
}

function parseLog(out) {
  return out
    .split(RS)
    .slice(1)
    .map((rec) => {
      const end = rec.indexOf(END);
      const [hash, short, author, email, date, iso, parents, refs, subject, body] = rec.slice(0, end).split(FS);
      const tail = rec.slice(end + 1);
      const changes = parseNameStatus(tail);
      let additions = 0;
      let deletions = 0;
      let numstat = false;
      for (const m of tail.matchAll(/^(\d+|-)\t(\d+|-)\t/gm)) {
        numstat = true;
        additions += Number(m[1]) || 0;
        deletions += Number(m[2]) || 0;
      }
      return {
        hash,
        short,
        author,
        email,
        date,
        iso,
        parents: parents ? parents.split(' ') : [],
        refs: refs ? refs.split(', ') : [],
        subject,
        body: (body || '').trim(),
        changes,
        change: changes[0],
        stats: numstat ? { additions, deletions } : undefined,
      };
    });
}

async function logCommits(root, args) {
  return parseLog(await git(root, ['log', LOG_FORMAT, ...args]));
}

function parseWorktrees(out) {
  return out
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const wt = { path: '', head: '', branch: undefined, detached: false, locked: false, prunable: false };
      for (const line of block.split('\n')) {
        const i = line.indexOf(' ');
        const key = i === -1 ? line : line.slice(0, i);
        const value = i === -1 ? '' : line.slice(i + 1);
        if (key === 'worktree') wt.path = value;
        else if (key === 'HEAD') wt.head = value;
        else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
        else if (key in wt) wt[key] = true;
      }
      return wt;
    });
}

function config() {
  return vscode.workspace.getConfiguration('gitCompass');
}

function samePath(a, b) {
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

function shortRef(ref) {
  return ref.replace(/^origin\//, '');
}

function toRel(root, fsPath) {
  return path.relative(root, fsPath).split(path.sep).join('/');
}

function fileUri(root, rel) {
  return vscode.Uri.file(path.join(root, rel));
}

function refUri(root, rel, ref) {
  return vscode.Uri.from({ scheme: SCHEME, path: '/' + rel, query: JSON.stringify({ root, ref: ref || '' }) });
}

function parseRefUri(uri) {
  const { root, ref } = JSON.parse(uri.query);
  return { root, ref, rel: uri.path.slice(1) };
}

function statusUri(rel, status) {
  return vscode.Uri.from({ scheme: STATUS_SCHEME, path: '/' + rel, query: status });
}

const contentProvider = {
  async provideTextDocumentContent(uri) {
    const { root, ref, rel } = parseRefUri(uri);
    if (!ref) return '';
    try {
      return await git(root, ['show', `${ref}:${rel}`]);
    } catch {
      return '';
    }
  },
};

const decorationProvider = {
  provideFileDecoration(uri) {
    if (uri.scheme !== STATUS_SCHEME) return undefined;
    const s = uri.query;
    return {
      badge: s,
      tooltip: STATUS_LABEL[s],
      color: STATUS_COLOR[s] ? new vscode.ThemeColor(STATUS_COLOR[s]) : undefined,
    };
  },
};

let gitMissingShown = false;

// Returns undefined (instead of throwing) when the Git extension is missing or disabled,
// or Git itself is not installed, so activation never fails.
async function getGitApi() {
  if (gitApi) return gitApi;
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (exports && exports.enabled === false) {
      notifyGitUnavailable(exports);
      return undefined;
    }
    gitApi = exports.getAPI(1);
    return gitApi;
  } catch {
    notifyGitUnavailable();
    return undefined;
  }
}

function notifyGitUnavailable(exports) {
  if (gitMissingShown) return;
  gitMissingShown = true;
  exports?.onDidChangeEnablement?.((enabled) => {
    if (!enabled) return;
    vscode.window.showInformationMessage('Git is available now. Reload the window to start Git Compass.', 'Reload Window').then((pick) => {
      if (pick) vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  });
  vscode.window.showWarningMessage('Git Compass needs Git. Install Git, or turn on the "git.enabled" setting, then reload the window.');
}

const AUTH_ERROR = /terminal prompts disabled|could not read (?:username|password)|authentication failed|permission denied \(publickey|askpass|invalid username or password/i;

// Our git processes cannot show VS Code's sign-in prompt. When a fetch or push fails
// for lack of credentials (common in Remote SSH and WSL), retry it through the Git
// extension, which can ask the user.
async function remote(root, args, viaGitExtension, run = git) {
  try {
    return await run(root, args);
  } catch (e) {
    const repo = gitApi?.getRepository(vscode.Uri.file(root));
    if (!repo || !AUTH_ERROR.test(e.message)) throw e;
    await viaGitExtension(repo);
    return '';
  }
}

function fetchRef(root, ref, run = git) {
  if (String(ref).startsWith('-')) return Promise.reject(new Error(`Refusing to fetch "${ref}": it looks like a git option.`));
  return remote(root, ['fetch', '--end-of-options', 'origin', ref], (repo) => repo.fetch({ remote: 'origin', ref }), run);
}

function repoForUri(uri) {
  if (!gitApi || !uri) return undefined;
  if (uri.scheme === SCHEME) return gitApi.getRepository(vscode.Uri.file(parseRefUri(uri).root));
  return uri.scheme === 'file' ? gitApi.getRepository(uri) : undefined;
}

function activeRepo() {
  if (!gitApi) return undefined;
  return repoForUri(vscode.window.activeTextEditor?.document.uri) || gitApi.repositories[0];
}

function requireRepo() {
  const repo = activeRepo();
  if (!repo) throw new Error('No git repository is open.');
  return repo.rootUri.fsPath;
}

function targetFile(arg) {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (uri?.scheme === SCHEME) {
    const { root, rel } = parseRefUri(uri);
    return { uri: fileUri(root, rel), root, rel };
  }
  if (!uri || uri.scheme !== 'file') throw new Error('Open a file from the repository first.');
  const repo = gitApi?.getRepository(uri);
  if (!repo) throw new Error('This file is not in a git repository.');
  const root = repo.rootUri.fsPath;
  return { uri, root, rel: toRel(root, uri.fsPath) };
}

function currentBranch(root) {
  const repo = gitApi?.repositories.find((r) => samePath(r.rootUri.fsPath, root));
  const head = repo?.state.HEAD;
  return head?.name || (head?.commit ? `detached @ ${head.commit.slice(0, 7)}` : 'HEAD');
}

async function refExists(root, ref) {
  try {
    await git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function resolveBases(root) {
  if (baseCache.has(root)) return baseCache.get(root);
  const bases = [];
  const configured = config().get('baseBranches', []);
  for (const name of configured.length ? configured : [await defaultBranch(root)].filter(Boolean)) {
    for (const ref of [`origin/${name}`, name]) {
      if (await refExists(root, ref)) {
        bases.push(ref);
        break;
      }
    }
  }
  baseCache.set(root, bases);
  return bases;
}

async function defaultBranch(root) {
  try {
    return (await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
  } catch {
    for (const name of ['main', 'master', 'develop']) if (await refExists(root, name)) return name;
    return undefined;
  }
}

function clearBaseCache() {
  baseCache.clear();
}

async function pickRef(root, title) {
  const bases = await resolveBases(root);
  const refs = (await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags']))
    .split('\n')
    .filter((r) => r && !r.endsWith('/HEAD'))
    .map((r) => r.replace(/^refs\/(heads|remotes|tags)\//, ''))
    .filter((r) => !bases.includes(r));
  const pick = await vscode.window.showQuickPick(
    [
      ...bases.map((r) => ({ label: r, description: 'base branch' })),
      { label: 'Branches and tags', kind: vscode.QuickPickItemKind.Separator },
      ...refs.map((r) => ({ label: r })),
    ],
    { title, placeHolder: 'Branch, tag or ref' }
  );
  return pick?.label;
}

function openDiff(left, right, title, options = { preview: true, preserveFocus: true }) {
  return vscode.commands.executeCommand('vscode.diff', left, right, title, options);
}

function diffCommitFile(root, commit, change, options) {
  const left = change.status === 'A' ? refUri(root, change.path, '') : refUri(root, change.oldPath, `${commit.hash}^`);
  const right = change.status === 'D' ? refUri(root, change.path, '') : refUri(root, change.path, commit.hash);
  return openDiff(left, right, `${path.basename(change.path)} (${commit.short}^ ↔ ${commit.short})`, options);
}

async function commitFiles(root, hash) {
  // Merge commits are compared with their first parent. This avoids --diff-merges,
  // which needs git 2.31 (Debian 11 and Ubuntu 20.04 ship older versions).
  const parents = (await git(root, ['rev-list', '--parents', '-n', '1', hash, '--'])).trim().split(/\s+/).slice(1);
  const args = parents.length > 1 ? [`${parents[0]}`, hash] : ['--root', hash];
  return parseNameStatus(await git(root, ['diff-tree', '-r', '-M', '--no-commit-id', '--name-status', ...args]));
}

async function showWholeCommit(root, hash) {
  const content = await git(root, ['show', '--no-ext-diff', '--stat', '--patch', '--format=fuller', hash]);
  const doc = await vscode.workspace.openTextDocument({ content, language: 'diff' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function commitTooltip(commit, links) {
  const md = new vscode.MarkdownString('', true);
  md.isTrusted = true;
  md.appendMarkdown('$(account) **');
  md.appendText(commit.author);
  md.appendMarkdown(`**, ${commit.date} _(${new Date(commit.iso).toLocaleString()})_\n\n`);
  md.appendText(commit.subject);
  if (commit.body) {
    md.appendMarkdown('\n\n');
    md.appendText(commit.body);
  }
  const refs = (commit.refs || []).filter((r) => r && r !== 'HEAD');
  if (refs.length) md.appendMarkdown(`\n\n$(tag) ${refs.map((r) => `\`${r.replace(/^HEAD -> /, '')}\``).join(' ')}`);
  if (commit.stats) md.appendMarkdown(`\n\n$(diff) +${commit.stats.additions} −${commit.stats.deletions}`);
  md.appendMarkdown(`\n\n---\n\n$(git-commit) \`${commit.short}\``);
  if (links?.length) md.appendMarkdown(' · ' + links.map((l) => `[${l.title}](${commandLink(l.command, l.args)})`).join(' · '));
  return md;
}

function commandLink(command, args) {
  return `command:${command}?${encodeURIComponent(JSON.stringify(args ?? []))}`;
}

function onRepoChange(context, listener, delay = 500) {
  let timer;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(listener, delay);
  };
  const watched = new Set();
  const watch = (repo) => {
    if (watched.has(repo)) return;
    watched.add(repo);
    context.subscriptions.push(repo.state.onDidChange(fire));
  };
  gitApi.repositories.forEach(watch);
  context.subscriptions.push(
    gitApi.onDidOpenRepository((repo) => {
      watch(repo);
      fire();
    })
  );
}

function registerShared(context) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider),
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );
}

module.exports = {
  SCHEME,
  gitPath,
  gitEnv,
  gitError,
  remote,
  fetchRef,
  LOG_FORMAT,
  STATUS_LABEL,
  git,
  parseLog,
  parseNameStatus,
  parseWorktrees,
  logCommits,
  config,
  samePath,
  shortRef,
  toRel,
  fileUri,
  refUri,
  parseRefUri,
  statusUri,
  getGitApi,
  repoForUri,
  activeRepo,
  requireRepo,
  targetFile,
  currentBranch,
  refExists,
  resolveBases,
  clearBaseCache,
  pickRef,
  openDiff,
  diffCommitFile,
  commitFiles,
  showWholeCommit,
  commitTooltip,
  commandLink,
  onRepoChange,
  registerShared,
};

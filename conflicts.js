const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const g = require('./git');

const VIEW_ID = 'gitCompass.views.conflicts';
const PROPOSAL_SCHEME = 'git-compass-proposal';
const T = vscode.TreeItemCollapsibleState;
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const MARKERS = /^(<{7}|>{7})(\s|$)/m;
const proposals = new Map();
let emitter;
let tree;
let statusItem;
let current = { op: undefined, files: [], resolved: [], root: undefined };
let refreshTimer;

function gitEdit(root, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: root, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_TERMINAL_PROMPT: '0', ...extraEnv } },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(new Error((stderr || stdout || err.message).trim()), { stdout, stderr, code: err.code }));
        else resolve(stdout);
      }
    );
  });
}

function readIf(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

async function refName(root, sha) {
  if (!sha) return '';
  const names = (await g.git(root, ['for-each-ref', '--points-at', sha, '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => ''))
    .split('\n')
    .filter((n) => n && !n.endsWith('/HEAD'));
  return names[0] || sha.slice(0, 7);
}

async function subjectOf(root, rev) {
  return (await g.git(root, ['log', '-1', '--format=%s', rev]).catch(() => '')).trim();
}

async function detectOperation(root) {
  const keys = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'];
  const out = await g.git(root, ['rev-parse', ...keys.flatMap((k) => ['--git-path', k])]);
  const paths = Object.fromEntries(out.trim().split('\n').map((p, i) => [keys[i], path.resolve(root, p.trim())]));
  const branch = (await g.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    if (!fs.existsSync(paths[dir])) continue;
    const merge = dir === 'rebase-merge';
    const head = (readIf(path.join(paths[dir], 'head-name')) || '').replace(/^refs\/heads\//, '') || 'HEAD';
    const onto = await refName(root, readIf(path.join(paths[dir], 'onto')));
    const step = Number(readIf(path.join(paths[dir], merge ? 'msgnum' : 'next'))) || undefined;
    const total = Number(readIf(path.join(paths[dir], merge ? 'end' : 'last'))) || undefined;
    const stopped = fs.existsSync(paths.REBASE_HEAD) ? readIf(paths.REBASE_HEAD) : readIf(path.join(paths[dir], 'stopped-sha'));
    const subject = stopped ? await subjectOf(root, stopped) : '';
    return {
      kind: 'rebase',
      branch: head,
      other: onto,
      step,
      total,
      label: `Rebasing ${head} onto ${onto}${step && total ? ` (${step}/${total})` : ''}`,
      ours: `Current (${onto})`,
      theirs: `Incoming (${subject || 'your commit'})`,
    };
  }
  if (fs.existsSync(paths.MERGE_HEAD)) {
    const sha = readIf(paths.MERGE_HEAD)?.split('\n')[0];
    const msg = readIf(path.join(path.dirname(paths.MERGE_HEAD), 'MERGE_MSG')) || '';
    const other = /Merge (?:remote-tracking )?branch '([^']+)'/.exec(msg)?.[1] || /Merge commit '([^']+)'/.exec(msg)?.[1] || (await refName(root, sha));
    return { kind: 'merge', branch, other, label: `Merging ${other} into ${branch || 'HEAD'}`, ours: `Current (${branch || 'HEAD'})`, theirs: `Incoming (${other})` };
  }
  for (const [file, kind, verb] of [['CHERRY_PICK_HEAD', 'cherryPick', 'Cherry-picking'], ['REVERT_HEAD', 'revert', 'Reverting']]) {
    if (!fs.existsSync(paths[file])) continue;
    const sha = readIf(paths[file]);
    const subject = await subjectOf(root, sha);
    const short = sha.slice(0, 7);
    return { kind, branch, other: short, label: `${verb} ${short}${subject ? ` ${subject}` : ''}`, ours: `Current (${branch || 'HEAD'})`, theirs: `Incoming (${short}${subject ? ` ${subject}` : ''})` };
  }
  return undefined;
}

function parseStatus(out) {
  const parts = out.split('\0');
  const unmerged = [];
  const staged = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++;
    if (UNMERGED.has(code)) unmerged.push({ code, path: file });
    else if (code[0] !== ' ' && code[0] !== '?' && code[0] !== '!') staged.push({ code, path: file });
  }
  return { unmerged, staged };
}

function describeConflict(code) {
  return (
    {
      UU: 'Changed on both sides',
      AA: 'Added on both sides',
      DU: 'Deleted in current, changed in incoming',
      UD: 'Changed in current, deleted in incoming',
      AU: 'Added in current only',
      UA: 'Added in incoming only',
      DD: 'Deleted on both sides',
    }[code] || code
  );
}

function sideExists(code, side) {
  const letter = side === 'ours' ? code[0] : code[1];
  if (letter === 'D') return false;
  if (code === 'AU') return side === 'ours';
  if (code === 'UA') return side === 'theirs';
  return true;
}

async function readState(root) {
  const [op, status] = await Promise.all([detectOperation(root), g.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=no'])]);
  const { unmerged, staged } = parseStatus(status);
  return { root, op, files: unmerged, resolved: op ? staged : [] };
}

async function acceptSide(root, file, code, side) {
  if (sideExists(code, side)) {
    await g.git(root, ['checkout', `--${side}`, '--', file]);
    await g.git(root, ['add', '--', file]);
    return 'kept';
  }
  await g.git(root, ['rm', '-q', '--', file]).catch(() => g.git(root, ['rm', '-q', '--cached', '--', file]));
  return 'removed';
}

function hasMarkers(root, file) {
  try {
    return MARKERS.test(fs.readFileSync(path.join(root, file), 'utf8'));
  } catch {
    return false;
  }
}

async function markResolved(root, file) {
  if (fs.existsSync(path.join(root, file))) await g.git(root, ['add', '--', file]);
  else await g.git(root, ['rm', '-q', '--', file]).catch(() => g.git(root, ['rm', '-q', '--cached', '--', file]));
}

function continueArgs(kind) {
  return { merge: ['commit', '--no-edit'], rebase: ['rebase', '--continue'], cherryPick: ['cherry-pick', '--continue'], revert: ['revert', '--continue'] }[kind];
}

function abortArgs(kind) {
  return { merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], cherryPick: ['cherry-pick', '--abort'], revert: ['revert', '--abort'] }[kind];
}

function skipArgs(kind) {
  return { rebase: ['rebase', '--skip'], cherryPick: ['cherry-pick', '--skip'] }[kind];
}

async function continueOperation(root) {
  const s = await readState(root);
  if (!s.op) throw new Error('No merge, rebase, cherry-pick or revert is in progress.');
  if (s.files.length) throw new Error(`Resolve the remaining ${s.files.length} conflicted file${s.files.length === 1 ? '' : 's'} first.`);
  try {
    await gitEdit(root, continueArgs(s.op.kind));
  } catch (e) {
    const after = await readState(root);
    if (after.op && after.files.length) return { stoppedAgain: true, state: after };
    throw e;
  }
  return { stoppedAgain: false, state: await readState(root) };
}

async function abortOperation(root) {
  const s = await readState(root);
  if (!s.op) throw new Error('Nothing to abort.');
  await gitEdit(root, abortArgs(s.op.kind));
  return s.op;
}

async function confirm(message, detail, action) {
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
}

function nodeFile(node) {
  return { root: node.root, file: node.path, code: node.code };
}

async function refresh() {
  const repo = g.activeRepo();
  if (!repo) {
    current = { op: undefined, files: [], resolved: [], root: undefined };
  } else {
    try {
      current = await readState(repo.rootUri.fsPath);
    } catch {
      current = { op: undefined, files: [], resolved: [], root: repo.rootUri.fsPath };
    }
  }
  const active = !!current.op || current.files.length > 0;
  await vscode.commands.executeCommand('setContext', 'gitCompass.hasConflicts', active);
  await vscode.commands.executeCommand('setContext', 'gitCompass.conflictOperation', current.op?.kind || '');
  if (statusItem) {
    if (current.files.length) {
      statusItem.text = `$(warning) Merge conflicts: ${current.files.length}`;
      statusItem.tooltip = current.op ? `${current.op.label}. Click to resolve.` : 'Click to resolve.';
      statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      statusItem.show();
    } else if (current.op) {
      statusItem.text = `$(git-merge) Ready to continue`;
      statusItem.tooltip = `${current.op.label}. All conflicts are resolved.`;
      statusItem.backgroundColor = undefined;
      statusItem.show();
    } else statusItem.hide();
  }
  emitter?.fire();
  return current;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 200);
}

const provider = {
  getTreeItem(node) {
    if (node.type === 'cfHeader') {
      const item = new vscode.TreeItem(node.op.label, T.None);
      item.description = current.files.length ? `${current.files.length} to resolve` : 'ready to continue';
      item.tooltip = `${node.op.ours}\n${node.op.theirs}`;
      item.iconPath = new vscode.ThemeIcon(node.op.kind === 'rebase' ? 'git-pull-request' : 'git-merge');
      item.contextValue = `conflictOperation:${node.op.kind}`;
      return item;
    }
    if (node.type === 'cfFile') {
      const item = new vscode.TreeItem(g.statusUri(node.path, 'U'), T.None);
      const dir = path.posix.dirname(node.path);
      item.description = `${describeConflict(node.code)}${dir === '.' ? '' : ` · ${dir}`}`;
      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = `${node.path}\n${describeConflict(node.code)}${node.op ? `\n\n${node.op.ours}\n${node.op.theirs}` : ''}`;
      item.contextValue = 'conflictFile';
      item.command = { command: 'gitCompass.conflicts.openMergeEditor', title: 'Open in Merge Editor', arguments: [node] };
      return item;
    }
    if (node.type === 'cfResolvedGroup') {
      const item = new vscode.TreeItem(`${node.files.length} file${node.files.length === 1 ? '' : 's'} resolved`, T.Collapsed);
      item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
      item.id = 'conflicts:resolved';
      return item;
    }
    const item = new vscode.TreeItem(g.statusUri(node.path, node.code[0]), T.None);
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'conflictResolved';
    item.command = { command: 'vscode.open', title: 'Open File', arguments: [g.fileUri(node.root, node.path)] };
    return item;
  },
  getChildren(node) {
    if (node?.type === 'cfResolvedGroup') return node.files.map((f) => ({ type: 'cfResolved', root: current.root, ...f }));
    if (node) return [];
    const nodes = [];
    if (current.op) nodes.push({ type: 'cfHeader', root: current.root, op: current.op });
    for (const f of current.files) nodes.push({ type: 'cfFile', root: current.root, op: current.op, ...f });
    if (current.resolved.length) nodes.push({ type: 'cfResolvedGroup', files: current.resolved });
    if (tree) tree.message = nodes.length ? undefined : 'No conflicts.';
    return nodes;
  },
};

function rootOf(node) {
  return node?.root || current.root || g.requireRepo();
}

async function afterOperation(result, label) {
  await refresh();
  vscode.commands.executeCommand('gitCompass.refresh');
  if (result?.stoppedAgain) {
    vscode.window.showWarningMessage(`${result.state.op.label}: stopped at the next conflict.`);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  } else if (label) vscode.window.showInformationMessage(label);
}

async function suggestResolution(node) {
  const providers = require('./aiProviders');
  const { stripFences } = require('./ai');
  const { root, file } = nodeFile(node);
  const read = (rev) => g.git(root, ['show', rev]).catch(() => '');
  const [working, base, ours, theirs] = await Promise.all([fs.promises.readFile(path.join(root, file), 'utf8').catch(() => ''), read(`:1:${file}`), read(`:2:${file}`), read(`:3:${file}`)]);
  const op = node.op || current.op;
  const context = [
    `File: ${file}`,
    op ? `Operation: ${op.label}. "${op.ours}" is the current side, "${op.theirs}" is the incoming side.` : '',
    `--- Working copy with conflict markers ---\n${working}`,
    `--- Common ancestor ---\n${base}`,
    `--- Current side ---\n${ours}`,
    `--- Incoming side ---\n${theirs}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const text = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Git Compass AI: resolving ${path.basename(file)}…`, cancellable: true }, (_p, token) =>
    providers.complete({
      prompt: 'Resolve the merge conflict in the input. Keep the intent of both sides where they are compatible, prefer the incoming side only when they truly contradict, and remove every conflict marker. Reply with the complete resolved file content only, no explanations and no code fences.',
      context,
      token,
      cwd: root,
    })
  );
  const proposal = stripFences(text);
  const uri = vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${file}`, query: String(Date.now()) });
  proposals.set(uri.toString(), proposal);
  await vscode.commands.executeCommand('vscode.diff', g.fileUri(root, file), uri, `${path.basename(file)} (working copy ↔ AI suggestion)`);
  const choice = await vscode.window.showInformationMessage(`Apply the suggested resolution to ${file}? It is not staged; review it, then mark the file as resolved.`, 'Apply', 'Discard');
  if (choice === 'Apply') {
    await fs.promises.writeFile(path.join(root, file), proposal);
    vscode.window.setStatusBarMessage(`Applied suggestion to ${file}`, 3000);
  }
  proposals.delete(uri.toString());
}

function register(context) {
  emitter = new vscode.EventEmitter();
  provider.onDidChangeTreeData = emitter.event;
  tree = vscode.window.createTreeView(VIEW_ID, { treeDataProvider: provider });
  statusItem = vscode.window.createStatusBarItem('gitCompass.conflicts', vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Git Compass Conflicts';
  statusItem.command = `${VIEW_ID}.focus`;
  context.subscriptions.push(
    tree,
    emitter,
    statusItem,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, { provideTextDocumentContent: (uri) => proposals.get(uri.toString()) || '' })
  );

  const commands = {
    refresh: () => refresh(),
    openMergeEditor: async (node) => {
      const uri = g.fileUri(node.root, node.path);
      try {
        await vscode.commands.executeCommand('git.openMergeEditor', uri);
      } catch {
        await vscode.commands.executeCommand('vscode.open', uri);
      }
    },
    openFile: (node) => vscode.commands.executeCommand('vscode.open', g.fileUri(node.root, node.path)),
    acceptCurrent: async (node) => {
      const op = node.op || current.op;
      const side = op?.ours || 'the current side';
      if (!(await confirm(`Use ${side} for ${node.path}?`, `${describeConflict(node.code)}. Any edits you made to this file are replaced, and the file is marked as resolved.`, 'Use Current'))) return;
      await acceptSide(node.root, node.path, node.code, 'ours');
      await refresh();
    },
    acceptIncoming: async (node) => {
      const op = node.op || current.op;
      const side = op?.theirs || 'the incoming side';
      if (!(await confirm(`Use ${side} for ${node.path}?`, `${describeConflict(node.code)}. Any edits you made to this file are replaced, and the file is marked as resolved.`, 'Use Incoming'))) return;
      await acceptSide(node.root, node.path, node.code, 'theirs');
      await refresh();
    },
    markResolved: async (node) => {
      if (hasMarkers(node.root, node.path) && !(await confirm(`${node.path} still contains conflict markers.`, 'Lines starting with <<<<<<< or >>>>>>> are still in the file. Marking it resolved commits them as they are.', 'Mark Resolved Anyway'))) return;
      await markResolved(node.root, node.path);
      await refresh();
    },
    aiSuggest: suggestResolution,
    continue: async (node) => {
      const result = await continueOperation(rootOf(node));
      await afterOperation(result, result.stoppedAgain ? undefined : result.state.op ? `${result.state.op.label}: continued.` : 'Done. The operation is complete.');
    },
    skip: async (node) => {
      const root = rootOf(node);
      const s = await readState(root);
      const args = s.op && skipArgs(s.op.kind);
      if (!args) throw new Error('Skip is only available while rebasing or cherry-picking.');
      if (!(await confirm(`Skip this commit?`, `${s.op.theirs.replace(/^Incoming \(|\)$/g, '')} is dropped from the ${s.op.kind === 'rebase' ? 'rebase' : 'cherry-pick'}. Its changes will not be applied.`, 'Skip Commit'))) return;
      try {
        await gitEdit(root, args);
      } catch (e) {
        const after = await readState(root);
        if (!(after.op && after.files.length)) throw e;
      }
      await afterOperation(undefined, undefined);
    },
    abort: async (node) => {
      const root = rootOf(node);
      const s = await readState(root);
      if (!s.op) throw new Error('Nothing to abort.');
      if (!(await confirm(`Abort: ${s.op.label}?`, 'Your branch goes back to how it was before this started. Conflict resolutions made so far are lost.', 'Abort'))) return;
      await abortOperation(root);
      await afterOperation(undefined, 'Aborted.');
    },
  };
  for (const [name, fn] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`gitCompass.conflicts.${name}`, async (...args) => {
        try {
          await g.getGitApi();
          await fn(...args);
        } catch (e) {
          vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
        }
      })
    );
  }
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(scheduleRefresh));
  g.getGitApi()
    .then((api) => {
      if (api) g.onRepoChange(context, scheduleRefresh, 300);
    })
    .catch(() => {});
  scheduleRefresh();
}

module.exports = {
  register,
  refresh,
  gitEdit,
  detectOperation,
  parseStatus,
  describeConflict,
  sideExists,
  readState,
  acceptSide,
  hasMarkers,
  markResolved,
  continueOperation,
  abortOperation,
  continueArgs,
  abortArgs,
  skipArgs,
  VIEW_ID,
};

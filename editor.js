const vscode = require('vscode');
const path = require('path');
const g = require('./git');

const UNCOMMITTED = /^0{40}$/;
const HEADER = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;
const MAX_CHARS = 5 * 1024 * 1024;
const HEAT_STEPS = 10;
const GUTTER_WIDTH = 30;
const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
const UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

const blameCache = new Map();
const commitCache = new Map();
const userNames = new Map();
const annotations = new Map();
const historyCache = new Map();

let navSession;
let lineToken = 0;
let navToken = 0;
let lineTimer;
let navTimer;
let annotateTimer;
let lineDecoration;
let statusItem;
let blameType;
let heatTypes = [];
let changeTypes;
let codeLensEmitter;

function parseBlame(out) {
  const commits = new Map();
  const lines = [];
  let sha;
  for (const raw of out.split('\n')) {
    if (!raw || raw.startsWith('\t')) continue;
    const header = HEADER.exec(raw);
    if (header) {
      sha = header[1];
      lines[Number(header[3]) - 1] = sha;
      if (!commits.has(sha)) {
        commits.set(sha, { hash: sha, short: sha.slice(0, 8), author: '', email: '', time: 0, summary: '', filename: '', previous: undefined });
      }
      continue;
    }
    const c = commits.get(sha);
    if (!c) continue;
    const i = raw.indexOf(' ');
    const key = i === -1 ? raw : raw.slice(0, i);
    const value = i === -1 ? '' : raw.slice(i + 1);
    if (key === 'author') c.author = value;
    else if (key === 'author-mail') c.email = value.replace(/^<|>$/g, '');
    else if (key === 'author-time') c.time = Number(value);
    else if (key === 'summary') c.summary = value;
    else if (key === 'filename') c.filename = value;
    else if (key === 'previous') {
      const j = value.indexOf(' ');
      c.previous = { hash: value.slice(0, j), filename: value.slice(j + 1) };
    }
  }
  return { commits, lines };
}

function parseDiffHunks(out) {
  const result = { added: [], modified: [], deleted: [] };
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (newCount === 0) {
      result.deleted.push(Math.max(newStart - 1, 0));
      continue;
    }
    const target = oldCount === 0 ? result.added : result.modified;
    for (let i = 0; i < newCount; i++) target.push(newStart - 1 + i);
  }
  return result;
}

function relativeTime(seconds, now = Date.now() / 1000) {
  const diff = seconds - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return RTF.format(Math.round(diff / size), unit);
  }
  return 'just now';
}

function heatBuckets(times) {
  const known = times.filter((t) => t !== undefined);
  if (!known.length) return times.map(() => undefined);
  const min = Math.min(...known);
  const max = Math.max(...known);
  return times.map((t) => {
    if (t === undefined) return undefined;
    return max === min ? HEAT_STEPS - 1 : Math.round(((t - min) / (max - min)) * (HEAT_STEPS - 1));
  });
}

function gutterLabel(author, when) {
  const name = author.length > 16 ? author.slice(0, 15) + '…' : author;
  return `${name.padEnd(16)} ${when}`.slice(0, GUTTER_WIDTH).padEnd(GUTTER_WIDTH).replace(/ /g, ' ');
}

function lineInfo(blame, line) {
  const sha = blame?.lines[line];
  if (!sha) return undefined;
  return { ...blame.commits.get(sha), uncommitted: UNCOMMITTED.test(sha) };
}

function docInfo(doc) {
  if (!doc || doc.uri.scheme !== 'file') return undefined;
  const repo = g.repoForUri(doc.uri);
  if (!repo) return undefined;
  if (doc.offsetAt(new vscode.Position(doc.lineCount, 0)) > MAX_CHARS) return undefined;
  const root = repo.rootUri.fsPath;
  return { root, rel: g.toRel(root, doc.uri.fsPath) };
}

function userName(root) {
  if (!userNames.has(root)) {
    userNames.set(
      root,
      g
        .git(root, ['config', 'user.name'])
        .then((s) => s.trim())
        .catch(() => '')
    );
  }
  return userNames.get(root);
}

async function displayAuthor(root, c) {
  if (c.uncommitted || UNCOMMITTED.test(c.hash)) return 'You';
  return c.author && c.author === (await userName(root)) ? 'You' : c.author;
}

async function runBlame(doc, info, extra = []) {
  const args = ['blame', '--porcelain', ...extra];
  let input;
  if (doc.isDirty) {
    args.push('--contents', '-');
    input = doc.getText();
  }
  args.push('--', info.rel);
  try {
    return parseBlame(await g.git(info.root, args, { input }));
  } catch {
    return null;
  }
}

function fullBlame(doc, info) {
  const key = doc.uri.toString();
  const cached = blameCache.get(key);
  if (cached && cached.version === doc.version) return cached.promise;
  const promise = runBlame(doc, info);
  blameCache.set(key, { version: doc.version, promise });
  return promise;
}

async function blameLine(doc, info, line) {
  const cached = blameCache.get(doc.uri.toString());
  if (cached && cached.version === doc.version) return lineInfo(await cached.promise, line);
  if (!doc.isDirty) return lineInfo(await fullBlame(doc, info), line);
  return lineInfo(await runBlame(doc, info, ['-L', `${line + 1},${line + 1}`]), line);
}

function fullCommit(root, hash) {
  if (!commitCache.has(hash)) {
    commitCache.set(
      hash,
      g
        .logCommits(root, ['-1', '--numstat', hash])
        .then((r) => r[0])
        .catch(() => undefined)
    );
  }
  return commitCache.get(hash);
}

function changeArgs(info, c) {
  return [info.root, c.hash, c.filename || info.rel, c.previous?.filename || null];
}

function scheduleLine(delay = 150) {
  clearTimeout(lineTimer);
  lineTimer = setTimeout(() => updateLine().catch(() => {}), delay);
}

function clearLine() {
  for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(lineDecoration, []);
}

async function updateLine() {
  const token = ++lineToken;
  const cfg = g.config();
  const showLine = cfg.get('currentLine.enabled', true);
  const showStatus = cfg.get('statusBarBlame.enabled', true);
  const editor = vscode.window.activeTextEditor;
  clearLine();
  const info = editor && editor.selections.length === 1 ? docInfo(editor.document) : undefined;
  if (!info || (!showLine && !showStatus)) {
    statusItem.hide();
    return;
  }
  const doc = editor.document;
  const line = editor.selection.active.line;
  const c = await blameLine(doc, info, line);
  if (token !== lineToken) return;
  if (!c) {
    statusItem.hide();
    return;
  }
  const who = await displayAuthor(info.root, c);
  if (token !== lineToken || line >= doc.lineCount) return;
  const when = c.uncommitted ? '' : relativeTime(c.time);
  if (showLine) {
    const end = doc.lineAt(line).range.end;
    const contentText = c.uncommitted ? `${who} • Uncommitted changes` : `${who}, ${when} • ${c.summary}`;
    editor.setDecorations(lineDecoration, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText } } }]);
  }
  if (showStatus) {
    statusItem.text = c.uncommitted ? `$(git-commit) ${who} • Uncommitted` : `$(git-commit) ${who}, ${when}`;
    statusItem.tooltip = c.uncommitted ? 'Open working changes' : `${c.summary}\n\nClick to show the commit`;
    statusItem.command = c.uncommitted
      ? { command: 'gitCompass.blame.openWorkingChanges', title: 'Open Changes', arguments: [info.root, info.rel] }
      : { command: 'gitCompass.blame.showCommit', title: 'Show Commit', arguments: [info.root, c.hash] };
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

async function blameHover(info, c) {
  if (c.uncommitted) {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.appendMarkdown(
      `$(account) **You** · Uncommitted changes\n\n[Open Changes](${g.commandLink('gitCompass.blame.openWorkingChanges', [info.root, info.rel])})`
    );
    return md;
  }
  const commit = (await fullCommit(info.root, c.hash)) || {
    hash: c.hash,
    short: c.short,
    author: c.author,
    date: relativeTime(c.time),
    iso: new Date(c.time * 1000).toISOString(),
    subject: c.summary,
    body: '',
  };
  const links = [{ title: 'Open Changes', command: 'gitCompass.blame.openChanges', args: changeArgs(info, c) }];
  if (c.previous) {
    links.push({ title: 'Open Previous Revision', command: 'gitCompass.blame.openRevision', args: [info.root, c.previous.hash, c.previous.filename] });
  }
  links.push(
    { title: 'Show Commit', command: 'gitCompass.blame.showCommit', args: [info.root, c.hash] },
    { title: 'Copy SHA', command: 'gitCompass.blame.copySha', args: [c.hash] }
  );
  return g.commitTooltip(commit, links);
}

const hoverProvider = {
  async provideHover(doc, pos) {
    if (!g.config().get('currentLine.enabled', true)) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== doc || pos.line !== editor.selection.active.line) return undefined;
    const end = doc.lineAt(pos.line).range.end;
    if (pos.character < end.character) return undefined;
    const info = docInfo(doc);
    if (!info) return undefined;
    const c = await blameLine(doc, info, pos.line);
    if (!c) return undefined;
    return new vscode.Hover(await blameHover(info, c), new vscode.Range(end, end));
  },
};

function clearAnnotationDecorations(editor) {
  editor.setDecorations(blameType, []);
  for (const t of heatTypes) editor.setDecorations(t, []);
  for (const t of Object.values(changeTypes)) editor.setDecorations(t, []);
}

async function renderBlameGutter(editor, info) {
  const blame = await fullBlame(editor.document, info);
  if (!blame) return;
  const me = await userName(info.root);
  const options = [];
  let prev;
  let hunk = 0;
  for (let i = 0; i < editor.document.lineCount; i++) {
    const sha = blame.lines[i];
    const start = sha !== prev;
    if (start) hunk++;
    prev = sha;
    let text = '';
    if (start && sha) {
      const c = blame.commits.get(sha);
      text = UNCOMMITTED.test(sha)
        ? gutterLabel('You', 'uncommitted')
        : gutterLabel(c.author === me ? 'You' : c.author, relativeTime(c.time));
    }
    options.push({
      range: new vscode.Range(i, 0, i, 0),
      renderOptions: {
        before: {
          contentText: text || ' '.repeat(GUTTER_WIDTH),
          backgroundColor: hunk % 2 ? 'rgba(127, 127, 127, 0.12)' : 'rgba(127, 127, 127, 0.04)',
        },
      },
    });
  }
  if (annotations.get(editor.document.uri.toString()) === 'blame') editor.setDecorations(blameType, options);
}

async function renderHeatmap(editor, info) {
  const blame = await fullBlame(editor.document, info);
  if (!blame) return;
  const now = Date.now() / 1000;
  const times = [];
  for (let i = 0; i < editor.document.lineCount; i++) {
    const sha = blame.lines[i];
    times.push(sha ? (UNCOMMITTED.test(sha) ? now : blame.commits.get(sha).time) : undefined);
  }
  const buckets = heatBuckets(times);
  const ranges = heatTypes.map(() => []);
  buckets.forEach((b, i) => b !== undefined && ranges[b].push(new vscode.Range(i, 0, i, 0)));
  if (annotations.get(editor.document.uri.toString()) !== 'heatmap') return;
  heatTypes.forEach((t, i) => editor.setDecorations(t, ranges[i]));
}

async function renderChanges(editor, info) {
  let out = '';
  try {
    out = await g.git(info.root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', info.rel]);
  } catch {
    return;
  }
  const hunks = parseDiffHunks(out);
  if (annotations.get(editor.document.uri.toString()) !== 'changes') return;
  for (const kind of ['added', 'modified', 'deleted']) {
    editor.setDecorations(
      changeTypes[kind],
      hunks[kind].filter((l) => l < editor.document.lineCount).map((l) => new vscode.Range(l, 0, l, 0))
    );
  }
}

async function renderAnnotations(editor) {
  clearAnnotationDecorations(editor);
  const mode = annotations.get(editor.document.uri.toString());
  if (!mode) return;
  const info = docInfo(editor.document);
  if (!info) return;
  if (mode === 'blame') await renderBlameGutter(editor, info);
  else if (mode === 'heatmap') await renderHeatmap(editor, info);
  else if (mode === 'changes') await renderChanges(editor, info);
}

function renderVisible(uri) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (!uri || editor.document.uri.toString() === uri) renderAnnotations(editor).catch(() => {});
  }
}

function updateAnnotationContext() {
  const uri = vscode.window.activeTextEditor?.document.uri.toString();
  vscode.commands.executeCommand('setContext', 'gitCompass.annotationsActive', !!(uri && annotations.has(uri)));
}

function toggleAnnotation(mode) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !docInfo(editor.document)) {
    vscode.window.showInformationMessage('Open a committed file from the repository to annotate it.');
    return;
  }
  const uri = editor.document.uri.toString();
  if (annotations.get(uri) === mode) annotations.delete(uri);
  else annotations.set(uri, mode);
  renderVisible(uri);
  updateAnnotationContext();
}

function clearAnnotations() {
  const uri = vscode.window.activeTextEditor?.document.uri.toString();
  if (!uri) return;
  annotations.delete(uri);
  renderVisible(uri);
  updateAnnotationContext();
}

const LENS_KINDS = () =>
  new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class, vscode.SymbolKind.Constructor]);

const codeLensProvider = {
  get onDidChangeCodeLenses() {
    return codeLensEmitter.event;
  },
  async provideCodeLenses(doc, token) {
    if (!g.config().get('codeLens.enabled', true)) return [];
    const info = docInfo(doc);
    if (!info) return [];
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
    if (!symbols?.length || token.isCancellationRequested) return [];
    const kinds = LENS_KINDS();
    const ranges = [];
    const seen = new Set();
    const add = (s) => {
      const range = s.range || s.location?.range;
      if (!range || !kinds.has(s.kind) || seen.has(range.start.line)) return;
      seen.add(range.start.line);
      ranges.push(range);
    };
    for (const s of symbols) {
      add(s);
      for (const child of s.children || []) add(child);
    }
    const lenses = [];
    for (const range of ranges) {
      const at = new vscode.Range(range.start.line, 0, range.start.line, 0);
      for (const kind of ['recent', 'authors']) {
        const lens = new vscode.CodeLens(at);
        lens.meta = { doc, info, range, kind };
        lenses.push(lens);
      }
    }
    return lenses;
  },
  async resolveCodeLens(lens) {
    const { doc, info, range, kind } = lens.meta;
    // While the file has unsaved edits, reuse the last blame instead of re-blaming the
    // whole file after every pause in typing. Lenses refresh on save.
    const previous = doc.isDirty ? blameCache.get(doc.uri.toString()) : undefined;
    const blame = await (previous ? previous.promise : fullBlame(doc, info));
    const me = await userName(info.root);
    const authors = new Map();
    let latest;
    let total = 0;
    for (let i = range.start.line; i <= range.end.line; i++) {
      const c = lineInfo(blame, i);
      if (!c) continue;
      total++;
      const who = c.uncommitted || c.author === me ? 'You' : c.author;
      authors.set(who, (authors.get(who) || 0) + 1);
      const time = c.uncommitted ? Infinity : c.time;
      if (!latest || time > latest.sortTime) latest = { ...c, sortTime: time, who };
    }
    if (!latest) {
      lens.command = { title: '', command: '' };
      return lens;
    }
    if (kind === 'recent') {
      lens.command = latest.uncommitted
        ? { title: 'You, uncommitted changes', command: 'gitCompass.blame.openWorkingChanges', arguments: [info.root, info.rel] }
        : {
            title: `${latest.who}, ${relativeTime(latest.time)}`,
            tooltip: latest.summary,
            command: 'gitCompass.blame.openChanges',
            arguments: changeArgs(info, latest),
          };
    } else {
      const list = [...authors.entries()].sort((a, b) => b[1] - a[1]);
      const more = list.length > 1 ? ' and others' : '';
      lens.command = {
        title: `${list.length} author${list.length > 1 ? 's' : ''} (${list[0][0]}${more})`,
        command: 'gitCompass.blame.showAuthors',
        arguments: [list, total],
      };
    }
    return lens;
  },
};

function fileHistory(root, rel) {
  const key = `${root}\0${rel}`;
  if (!historyCache.has(key)) {
    historyCache.set(key, g.logCommits(root, ['--follow', '--name-status', '--', rel]).catch(() => []));
  }
  return historyCache.get(key);
}

async function navState(editor) {
  const doc = editor?.document;
  if (!doc) return undefined;
  if (doc.uri.scheme === 'file') {
    const info = docInfo(doc);
    if (!info) return undefined;
    return { root: info.root, rel: info.rel, history: await fileHistory(info.root, info.rel), index: -1 };
  }
  if (doc.uri.scheme !== g.SCHEME) return undefined;
  const { root, rel, ref } = g.parseRefUri(doc.uri);
  if (!ref) return undefined;
  const offset = ref.endsWith('^') ? 1 : 0;
  const base = offset ? ref.slice(0, -1) : ref;
  const session =
    navSession && g.samePath(navSession.root, root) && navSession.history.some((c) => c.hash.startsWith(base)) ? navSession : undefined;
  const state = session ? { ...session } : { root, rel, history: await fileHistory(root, rel) };
  let index = state.history.findIndex((c) => c.hash.startsWith(base));
  if (index === -1) {
    try {
      const hash = (await g.git(root, ['log', '-1', '--format=%H', base, '--', rel])).trim();
      index = state.history.findIndex((c) => c.hash === hash);
    } catch {
      index = -1;
    }
    if (index === -1) return undefined;
  }
  return { ...state, index: index + offset };
}

function openRevisionDiff(state, index) {
  const c = state.history[index];
  navSession = { root: state.root, rel: state.rel, history: state.history };
  return g.diffCommitFile(state.root, c, c.change || { status: 'M', oldPath: state.rel, path: state.rel }, { preview: true });
}

async function goPrevious() {
  const state = await navState(vscode.window.activeTextEditor);
  if (!state) return;
  const target = state.index + 1;
  if (target >= state.history.length) {
    vscode.window.setStatusBarMessage('No older revisions of this file', 2500);
    return;
  }
  await openRevisionDiff(state, target);
}

async function goNext() {
  const state = await navState(vscode.window.activeTextEditor);
  if (!state || state.index < 0) return;
  const target = state.index - 1;
  if (target === -1) {
    await vscode.window.showTextDocument(g.fileUri(state.root, state.rel), { preview: true });
    return;
  }
  await openRevisionDiff(state, target);
}

function scheduleNav(delay = 200) {
  clearTimeout(navTimer);
  navTimer = setTimeout(() => updateNav().catch(() => {}), delay);
}

async function updateNav() {
  const token = ++navToken;
  if (!g.config().get('revisionNavigation.enabled', true)) {
    await vscode.commands.executeCommand('setContext', 'gitCompass.canGoPrevious', false);
    await vscode.commands.executeCommand('setContext', 'gitCompass.canGoNext', false);
    return;
  }
  const editor = vscode.window.activeTextEditor;
  let canPrevious;
  let canNext;
  if (editor?.document.uri.scheme === 'file') {
    // Loading the full --follow history here ran on every editor switch; one commit is enough.
    const info = docInfo(editor.document);
    canPrevious = !!info && !!(await g.git(info.root, ['log', '-1', '--format=%H', '--', info.rel]).catch(() => '')).trim();
    canNext = false;
  } else {
    const state = await navState(editor);
    canPrevious = !!state && state.index + 1 < state.history.length;
    canNext = !!state && state.index >= 0;
  }
  if (token !== navToken) return;
  await vscode.commands.executeCommand('setContext', 'gitCompass.canGoPrevious', canPrevious);
  await vscode.commands.executeCommand('setContext', 'gitCompass.canGoNext', canNext);
}

async function showAuthors(list, total) {
  await vscode.window.showQuickPick(
    list.map(([name, count]) => ({
      label: `$(account) ${name}`,
      description: `${count} line${count > 1 ? 's' : ''} · ${Math.round((count / total) * 100)}%`,
    })),
    { title: 'Authors of this block' }
  );
}

function command(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
    }
  };
}

function heatColor(step) {
  const t = step / (HEAT_STEPS - 1);
  const mix = (a, b) => Math.round(a + (b - a) * t);
  return `rgba(${mix(70, 255)}, ${mix(130, 95)}, ${mix(255, 40)}, ${(0.45 + 0.45 * t).toFixed(2)})`;
}

function createDecorations(context) {
  lineDecoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  blameType = vscode.window.createTextEditorDecorationType({
    before: { margin: '0 1.2em 0 0', color: new vscode.ThemeColor('editorLineNumber.foreground') },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  heatTypes = Array.from({ length: HEAT_STEPS }, (_, i) =>
    vscode.window.createTextEditorDecorationType({
      before: { contentText: ' ', width: '4px', margin: '0 8px 0 0', backgroundColor: heatColor(i) },
      overviewRulerColor: i >= HEAT_STEPS - 2 ? heatColor(i) : undefined,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    })
  );
  const bar = (color, ruler, extra = {}) => ({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor(color),
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    overviewRulerColor: new vscode.ThemeColor(ruler),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    ...extra,
  });
  changeTypes = {
    added: vscode.window.createTextEditorDecorationType(
      bar('editorGutter.addedBackground', 'editorOverviewRuler.addedForeground', {
        backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      })
    ),
    modified: vscode.window.createTextEditorDecorationType(bar('editorGutter.modifiedBackground', 'editorOverviewRuler.modifiedForeground')),
    deleted: vscode.window.createTextEditorDecorationType(
      bar('editorGutter.deletedBackground', 'editorOverviewRuler.deletedForeground', { borderWidth: '0 0 2px 0' })
    ),
  };
  context.subscriptions.push(lineDecoration, blameType, ...heatTypes, ...Object.values(changeTypes));
}

let lastHeads = '';
let repoApi;

function headsKey() {
  return (repoApi?.repositories || []).map((r) => `${r.rootUri.fsPath}\0${r.state.HEAD?.commit || ''}`).join('\n');
}

// Repository state changes fire on every save and file-watcher event. Blame and file
// history only depend on commits (edits are keyed by document version, saves are
// handled in onDidSaveTextDocument), so only start over when a HEAD moves.
function onRepoChanged() {
  const heads = headsKey();
  if (heads === lastHeads) return;
  lastHeads = heads;
  blameCache.clear();
  historyCache.clear();
  scheduleLine(0);
  renderVisible();
  codeLensEmitter.fire();
  scheduleNav(0);
}

async function register(context) {
  const api = await g.getGitApi();
  repoApi = api;
  lastHeads = headsKey();
  createDecorations(context);
  statusItem = vscode.window.createStatusBarItem('gitCompass.blame', vscode.StatusBarAlignment.Right, 1000);
  statusItem.name = 'Git Compass Blame';
  codeLensEmitter = new vscode.EventEmitter();
  context.subscriptions.push(statusItem, codeLensEmitter);

  const commands = {
    'gitCompass.blame.openChanges': (root, hash, filename, previous) =>
      g.diffCommitFile(
        root,
        { hash, short: hash.slice(0, 8) },
        previous ? { status: 'M', oldPath: previous, path: filename } : { status: 'A', oldPath: filename, path: filename },
        { preview: true }
      ),
    'gitCompass.blame.openRevision': (root, hash, filename) =>
      vscode.window.showTextDocument(g.refUri(root, filename, hash), { preview: true }),
    'gitCompass.blame.openWorkingChanges': (root, rel) =>
      g.openDiff(g.refUri(root, rel, 'HEAD'), g.fileUri(root, rel), `${path.basename(rel)} (HEAD ↔ Working Tree)`, { preview: true }),
    'gitCompass.blame.showCommit': (root, hash) => g.showWholeCommit(root, hash),
    'gitCompass.blame.copySha': async (hash) => {
      await vscode.env.clipboard.writeText(hash);
      vscode.window.setStatusBarMessage(`Copied ${hash.slice(0, 8)}`, 2000);
    },
    'gitCompass.blame.showAuthors': showAuthors,
    'gitCompass.toggleFileBlame': () => toggleAnnotation('blame'),
    'gitCompass.toggleHeatmap': () => toggleAnnotation('heatmap'),
    'gitCompass.toggleChanges': () => toggleAnnotation('changes'),
    'gitCompass.clearAnnotations': clearAnnotations,
    'gitCompass.revision.previous': goPrevious,
    'gitCompass.revision.next': goNext,
  };
  context.subscriptions.push(
    ...Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(id, command(fn))),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) scheduleLine();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleLine(0);
      updateAnnotationContext();
      scheduleNav();
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => renderVisible()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        clearLine();
        scheduleLine(500);
      }
      const uri = e.document.uri.toString();
      if (annotations.has(uri)) {
        clearTimeout(annotateTimer);
        annotateTimer = setTimeout(() => renderVisible(uri), 500);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      blameCache.delete(doc.uri.toString());
      codeLensEmitter.fire();
      if (annotations.has(doc.uri.toString())) renderVisible(doc.uri.toString());
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      blameCache.delete(doc.uri.toString());
      annotations.delete(doc.uri.toString());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gitCompass')) return;
      scheduleLine(0);
      scheduleNav(0);
      codeLensEmitter.fire();
    })
  );
  if (api) g.onRepoChange(context, onRepoChanged);
  scheduleLine(0);
  scheduleNav(0);
  updateAnnotationContext();
}

module.exports = { register, parseBlame, parseDiffHunks, relativeTime, heatBuckets, gutterLabel, lineInfo };

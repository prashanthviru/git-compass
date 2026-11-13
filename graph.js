const vscode = require('vscode');
const crypto = require('crypto');
const g = require('./git');

// Commit Graph: every branch, remote branch and tag as one history, with lanes drawn for
// branches and merges. Pick a scope, search, click a commit to see it, and use the row
// actions to branch, tag, cherry-pick, revert or copy.

const PAGE = 400;
const FS = '\x1f';
const RS = '\x1e';
const FORMAT = `--format=${RS}%H${FS}%P${FS}%an${FS}%ae${FS}%at${FS}%D${FS}%s`;

let panel;
let current = { root: undefined, scope: 'all', limit: PAGE };
let commits = new Map();
let loadToken = 0;
let ready = false;
let lastMessage;

function parseGraphLog(out) {
  return out
    .split(RS)
    .slice(1)
    .map((rec) => {
      const [hash, parents, author, email, time, refs, subject] = rec.replace(/\n$/, '').split(FS);
      return { hash, short: hash.slice(0, 7), parents: parents ? parents.split(' ') : [], author, email, time: Number(time) || 0, refs: refs ? refs.split(', ') : [], subject: subject || '' };
    });
}

// Lane layout. Commits arrive newest first with children before parents (--date-order).
// Each lane holds the commit it is waiting for. A commit takes the lane that expects it
// (or a free one), lanes that also expected it merge into it, its first parent continues
// in its lane and other parents get their own lane. Lanes never move sideways, so lines
// that pass a row are straight.
function layoutGraph(list) {
  const lanes = [];
  let width = 0;
  const rows = list.map((c) => {
    let col = lanes.indexOf(c.hash);
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(null);
      }
    }
    const pass = [];
    const incoming = [];
    lanes.forEach((h, i) => {
      if (h === c.hash) incoming.push(i);
      else if (h !== null) pass.push(i);
    });
    for (const i of incoming) lanes[i] = null;
    const parents = [];
    c.parents.forEach((p, k) => {
      let pc = lanes.indexOf(p);
      if (pc === -1) {
        if (k === 0 && lanes[col] === null) pc = col;
        else {
          pc = lanes.indexOf(null);
          if (pc === -1) {
            pc = lanes.length;
            lanes.push(null);
          }
        }
        lanes[pc] = p;
      }
      parents.push(pc);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const rowWidth = Math.max(col + 1, lanes.length, ...pass.map((i) => i + 1), ...incoming.map((i) => i + 1), ...parents.map((i) => i + 1));
    width = Math.max(width, rowWidth);
    return { col, pass, incoming, parents };
  });
  return { rows, width };
}

// "HEAD -> main, origin/main, tag: v1.0" as typed badges. origin/HEAD is dropped.
function parseRefs(refs, remotes = ['origin']) {
  const out = [];
  for (const r of refs) {
    if (!r || r === 'HEAD' || /\/HEAD$/.test(r)) {
      if (r === 'HEAD') out.push({ name: 'HEAD', kind: 'head' });
      continue;
    }
    if (r.startsWith('HEAD -> ')) out.push({ name: r.slice(8), kind: 'current' });
    else if (r.startsWith('tag: ')) out.push({ name: r.slice(5), kind: 'tag' });
    else if (remotes.some((rm) => r.startsWith(`${rm}/`))) out.push({ name: r, kind: 'remote' });
    else out.push({ name: r, kind: 'branch' });
  }
  return out;
}

function scopeArgs(scope) {
  if (scope === 'current') return ['HEAD'];
  if (scope === 'local') return ['--branches', 'HEAD'];
  if (scope && scope !== 'all') return ['--end-of-options', scope];
  return ['--branches', '--remotes', '--tags', 'HEAD'];
}

async function readGraph(root, scope, limit) {
  const [out, remotesOut, branchesOut] = await Promise.all([
    g.git(root, ['log', '--date-order', `-n${limit + 1}`, FORMAT, ...scopeArgs(scope), '--']),
    g.git(root, ['remote']).catch(() => ''),
    g.git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).catch(() => ''),
  ]);
  const remotes = remotesOut.split('\n').filter(Boolean);
  const list = parseGraphLog(out);
  const hasMore = list.length > limit;
  const shown = list.slice(0, limit);
  const { rows, width } = layoutGraph(shown);
  return {
    hasMore,
    width,
    rows: shown.map((c, i) => ({ ...c, refs: parseRefs(c.refs, remotes), graph: rows[i] })),
    branches: branchesOut.split('\n').filter((b) => b && !b.endsWith('/HEAD') && !remotes.includes(b)),
    commits: shown,
  };
}

function post(message) {
  lastMessage = message;
  if (panel && ready) panel.webview.postMessage(message);
}

async function load() {
  if (!panel || !current.root) return;
  const token = ++loadToken;
  post({ type: 'loading' });
  try {
    const data = await readGraph(current.root, current.scope, current.limit);
    if (token !== loadToken) return;
    commits = new Map(data.commits.map((c) => [c.hash, c]));
    const branch = g.currentBranch(current.root);
    panel.title = `Commit Graph: ${require('path').basename(current.root)}`;
    post({ type: 'data', scope: current.scope, branch, branches: data.branches, rows: data.rows, width: data.width, hasMore: data.hasMore });
  } catch (e) {
    if (token !== loadToken) return;
    post({ type: 'error', message: /does not have any commits|bad default revision|unknown revision/i.test(e.message) ? 'This repository has no commits yet.' : e.message });
  }
}

const ACTIONS = {
  branch: 'gitCompass.commit.createBranch',
  tag: 'gitCompass.commit.createTag',
  cherryPick: 'gitCompass.commit.cherryPick',
  revert: 'gitCompass.commit.revert',
};

async function onMessage(m) {
  if (m.type === 'ready') {
    ready = true;
    if (lastMessage) panel.webview.postMessage(lastMessage);
    return;
  }
  if (m.type === 'scope') {
    current = { ...current, scope: String(m.scope || 'all'), limit: PAGE };
    return load();
  }
  if (m.type === 'more') {
    current = { ...current, limit: current.limit + PAGE };
    return load();
  }
  if (m.type === 'refresh') return load();
  const c = commits.get(m.hash);
  if (!c) return undefined;
  const node = { root: current.root, commit: { hash: c.hash, short: c.short, subject: c.subject, parents: c.parents, author: c.author } };
  if (m.type === 'open') return g.showWholeCommit(current.root, c.hash).catch((e) => vscode.window.showErrorMessage(`Git Compass: ${e.message}`));
  if (m.type === 'copy') {
    await vscode.env.clipboard.writeText(c.hash);
    vscode.window.setStatusBarMessage(`Copied ${c.short}`, 2000);
    return undefined;
  }
  if (m.type === 'action' && ACTIONS[m.action]) {
    await vscode.commands.executeCommand(ACTIONS[m.action], node);
    return load();
  }
  return undefined;
}

function createPanel() {
  ready = false;
  panel = vscode.window.createWebviewPanel('gitCompass.graph', 'Commit Graph', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
  panel.iconPath = new vscode.ThemeIcon('git-merge');
  panel.webview.html = html(panel.webview, crypto.randomBytes(16).toString('base64'));
  panel.webview.onDidReceiveMessage((m) => Promise.resolve(onMessage(m)).catch((e) => vscode.window.showErrorMessage(`Git Compass: ${e.message}`)));
  panel.onDidDispose(() => {
    panel = undefined;
    lastMessage = undefined;
    commits = new Map();
  });
}

async function show(arg) {
  await g.getGitApi();
  const root = arg?.root || g.requireRepo();
  const scope = arg?.ref || (root === current.root ? current.scope : 'all');
  current = { root, scope, limit: PAGE };
  if (panel) panel.reveal();
  else createPanel();
  await load();
}

let refreshTimer;
function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitCompass.showGraph', (arg) => show(arg).catch((e) => vscode.window.showErrorMessage(`Git Compass: ${e.message}`))),
    { dispose: () => panel?.dispose() }
  );
  g.onRepoChange(
    context,
    () => {
      if (!panel) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(load, 300);
    },
    800
  );
}

function html(webview, nonce) {
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
  :root {
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.25)));
    --hover: var(--vscode-list-hoverBackground);
    --sel: var(--vscode-list-activeSelectionBackground);
    --l0: var(--vscode-charts-blue); --l1: var(--vscode-charts-orange); --l2: var(--vscode-charts-green); --l3: var(--vscode-charts-purple);
    --l4: var(--vscode-charts-red); --l5: var(--vscode-charts-yellow); --l6: #3fb9c4; --l7: #d16ba5;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; padding: 10px 16px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--border); }
  select, input, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 3px; padding: 3px 6px; }
  input { min-width: 180px; flex: 1 1 200px; max-width: 360px; }
  button { cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: 4px 10px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .count { color: var(--muted); font-size: .9em; }
  #list { padding: 4px 0 24px; }
  .row { display: flex; align-items: center; height: 26px; padding-right: 12px; cursor: pointer; outline: none; }
  .row:hover { background: var(--hover); }
  .row:focus-visible, .row.sel { background: var(--sel); color: var(--vscode-list-activeSelectionForeground); }
  .row.dim { opacity: .35; }
  .row.match .subject { font-weight: 600; }
  svg { flex: none; display: block; margin-left: 8px; overflow: hidden; }
  svg path { fill: none; stroke-width: 2; }
  svg circle { stroke-width: 2; stroke: var(--vscode-editor-background); }
  .l0 { stroke: var(--l0); fill: var(--l0); } .l1 { stroke: var(--l1); fill: var(--l1); } .l2 { stroke: var(--l2); fill: var(--l2); } .l3 { stroke: var(--l3); fill: var(--l3); }
  .l4 { stroke: var(--l4); fill: var(--l4); } .l5 { stroke: var(--l5); fill: var(--l5); } .l6 { stroke: var(--l6); fill: var(--l6); } .l7 { stroke: var(--l7); fill: var(--l7); }
  path.l0, path.l1, path.l2, path.l3, path.l4, path.l5, path.l6, path.l7 { fill: none; }
  circle.merge { fill: var(--vscode-editor-background) !important; stroke-width: 2.5; }
  .text { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; padding-left: 6px; }
  .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ref { flex: none; font-size: .82em; padding: 0 6px; border-radius: 9px; line-height: 17px; border: 1px solid var(--border); white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .ref.current { background: var(--vscode-charts-green); color: var(--vscode-editor-background); border-color: transparent; font-weight: 600; }
  .ref.branch { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
  .ref.remote { border-color: var(--vscode-charts-blue); color: var(--vscode-charts-blue); }
  .ref.tag { border-color: var(--vscode-charts-yellow); color: var(--vscode-charts-yellow); }
  .ref.head { border-color: var(--vscode-charts-red); color: var(--vscode-charts-red); }
  .meta { flex: none; display: flex; gap: 12px; color: var(--muted); font-size: .9em; white-space: nowrap; }
  .author { width: 130px; overflow: hidden; text-overflow: ellipsis; }
  .when { width: 64px; text-align: right; }
  .sha { width: 62px; font-family: var(--vscode-editor-font-family); }
  .acts { flex: none; display: none; gap: 2px; margin-left: 8px; }
  .row:hover .acts, .row:focus-within .acts, .row.sel .acts { display: inline-flex; }
  .acts button { padding: 1px 7px; font-size: .85em; }
  .message { padding: 40px 16px; text-align: center; color: var(--muted); }
  .more { display: block; margin: 10px auto; }
  @media (max-width: 720px) { .author, .when { display: none; } }
</style>
</head>
<body>
<header>
  <select id="scope" aria-label="Which history to show"></select>
  <input id="search" type="search" placeholder="Find: message, author or SHA (Enter for next)" aria-label="Find commits">
  <span class="count" id="count"></span>
  <span style="flex:1"></span>
  <button id="refresh" title="Reload">Refresh</button>
</header>
<div id="list"><div class="message">Loading…</div></div>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var LANE = 14, H = 26, MID = 13, MAX_LANES = 30;
  var data = null, selected = null, matches = [], matchIndex = -1;
  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';

  function ago(t) {
    var s = Math.max(0, Date.now() / 1000 - t);
    var units = [['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]];
    for (var i = 0; i < units.length; i++) if (s >= units[i][1]) return Math.floor(s / units[i][1]) + units[i][0];
    return 'now';
  }
  function x(i) { return i * LANE + LANE / 2; }
  function lane(i) { return 'l' + (i % 8); }
  function path(svg, d, cls) { var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); svg.appendChild(p); }

  function drawGraph(g, width, isMerge) {
    var svg = document.createElementNS(NS, 'svg');
    var w = Math.min(width, MAX_LANES) * LANE;
    svg.setAttribute('width', w); svg.setAttribute('height', H); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + H);
    g.pass.forEach(function (i) { path(svg, 'M' + x(i) + ' 0V' + H, lane(i)); });
    g.incoming.forEach(function (i) {
      path(svg, i === g.col ? 'M' + x(i) + ' 0V' + MID : 'M' + x(i) + ' 0C' + x(i) + ' ' + MID + ' ' + x(g.col) + ' 0 ' + x(g.col) + ' ' + MID, lane(i));
    });
    g.parents.forEach(function (p) {
      path(svg, p === g.col ? 'M' + x(p) + ' ' + MID + 'V' + H : 'M' + x(g.col) + ' ' + MID + 'C' + x(g.col) + ' ' + H + ' ' + x(p) + ' ' + MID + ' ' + x(p) + ' ' + H, lane(p));
    });
    var c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x(g.col)); c.setAttribute('cy', MID); c.setAttribute('r', isMerge ? 4 : 4.5);
    c.setAttribute('class', lane(g.col) + (isMerge ? ' merge' : ''));
    if (isMerge) c.style.stroke = 'var(--' + lane(g.col) + ')';
    svg.appendChild(c);
    return svg;
  }

  function el(tag, cls, text, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function action(row, label, title, fn) {
    var b = el('button', null, label);
    b.title = title;
    b.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
    row.appendChild(b);
  }

  function render() {
    var list = $('list');
    list.textContent = '';
    if (!data.rows.length) { el('div', 'message', 'No commits to show.', list); return; }
    data.rows.forEach(function (r) {
      var row = el('div', 'row', null, list);
      row.tabIndex = 0;
      row.dataset.hash = r.hash;
      row.title = r.subject + '\\n' + r.author + ' <' + r.email + '>\\n' + new Date(r.time * 1000).toLocaleString() + '\\n' + r.hash;
      row.appendChild(drawGraph(r.graph, data.width, r.parents.length > 1));
      var text = el('div', 'text', null, row);
      r.refs.forEach(function (ref) { var b = el('span', 'ref ' + ref.kind, ref.name, text); b.title = ref.kind === 'current' ? 'Current branch' : ref.kind; });
      el('span', 'subject', r.subject, text);
      var acts = el('span', 'acts', null, row);
      action(acts, 'Branch', 'Create a branch at this commit', function () { vscode.postMessage({ type: 'action', action: 'branch', hash: r.hash }); });
      action(acts, 'Tag', 'Create a tag at this commit', function () { vscode.postMessage({ type: 'action', action: 'tag', hash: r.hash }); });
      action(acts, 'Cherry-pick', 'Apply this commit to ' + (data.branch || 'the current branch'), function () { vscode.postMessage({ type: 'action', action: 'cherryPick', hash: r.hash }); });
      action(acts, 'Revert', 'Add a commit that undoes this one', function () { vscode.postMessage({ type: 'action', action: 'revert', hash: r.hash }); });
      action(acts, 'Copy', 'Copy the full SHA', function () { vscode.postMessage({ type: 'copy', hash: r.hash }); });
      var meta = el('span', 'meta', null, row);
      el('span', 'author', r.author, meta);
      el('span', 'when', ago(r.time), meta);
      el('span', 'sha', r.short, meta);
      row.addEventListener('click', function () { select(row); vscode.postMessage({ type: 'open', hash: r.hash }); });
      row.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { select(row); vscode.postMessage({ type: 'open', hash: r.hash }); }
        else if (ev.key === 'ArrowDown' && row.nextElementSibling && row.nextElementSibling.classList.contains('row')) { ev.preventDefault(); row.nextElementSibling.focus(); }
        else if (ev.key === 'ArrowUp' && row.previousElementSibling) { ev.preventDefault(); row.previousElementSibling.focus(); }
      });
    });
    if (data.hasMore) {
      var more = el('button', 'more', 'Load more commits', list);
      more.addEventListener('click', function () { more.disabled = true; more.textContent = 'Loading…'; vscode.postMessage({ type: 'more' }); });
    }
    applySearch(false);
  }

  function select(row) {
    if (selected) selected.classList.remove('sel');
    selected = row;
    row.classList.add('sel');
  }

  function applySearch(jump) {
    var q = $('search').value.trim().toLowerCase();
    matches = [];
    document.querySelectorAll('.row').forEach(function (row, i) {
      var r = data.rows[i];
      var hit = !q || r.subject.toLowerCase().indexOf(q) >= 0 || r.author.toLowerCase().indexOf(q) >= 0 || r.email.toLowerCase().indexOf(q) >= 0 || r.hash.indexOf(q) === 0 || r.refs.some(function (f) { return f.name.toLowerCase().indexOf(q) >= 0; });
      row.classList.toggle('dim', !!q && !hit);
      row.classList.toggle('match', !!q && hit);
      if (q && hit) matches.push(row);
    });
    $('count').textContent = q ? matches.length + ' match' + (matches.length === 1 ? '' : 'es') : data.rows.length + ' commits' + (data.hasMore ? '+' : '');
    if (jump && matches.length) {
      matchIndex = (matchIndex + 1) % matches.length;
      matches[matchIndex].scrollIntoView({ block: 'center' });
      select(matches[matchIndex]);
    }
  }

  function fillScopes(m) {
    var s = $('scope');
    s.textContent = '';
    var opts = [['all', 'All branches, remotes and tags'], ['local', 'Local branches'], ['current', 'Current branch' + (m.branch ? ' (' + m.branch + ')' : '')]];
    opts.forEach(function (o) { var op = el('option', null, o[1], s); op.value = o[0]; });
    if (m.branches.length) {
      var group = document.createElement('optgroup');
      group.label = 'One branch';
      m.branches.forEach(function (b) { var op = el('option', null, b, group); op.value = b; });
      s.appendChild(group);
    }
    s.value = m.scope;
    if (s.value !== m.scope) { var op = el('option', null, m.scope, s); op.value = m.scope; s.value = m.scope; }
  }

  $('scope').addEventListener('change', function () { vscode.postMessage({ type: 'scope', scope: $('scope').value }); });
  $('search').addEventListener('input', function () { matchIndex = -1; if (data) applySearch(false); });
  $('search').addEventListener('keydown', function (ev) { if (ev.key === 'Enter' && data) applySearch(true); });
  $('refresh').addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); });

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (m.type === 'loading') { if (!data) $('list').innerHTML = '<div class="message">Loading…</div>'; }
    else if (m.type === 'error') { data = null; $('list').textContent = ''; el('div', 'message', m.message, $('list')); $('count').textContent = ''; }
    else if (m.type === 'data') {
      var keep = selected && selected.dataset.hash;
      var scrollY = window.scrollY;
      data = m;
      fillScopes(m);
      render();
      if (keep) { var row = document.querySelector('.row[data-hash="' + keep + '"]'); if (row) select(row); }
      window.scrollTo(0, scrollY);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { register, show, layoutGraph, parseGraphLog, parseRefs, scopeArgs, readGraph };

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { git, LOG_FORMAT, parseLog, targetFile, diffCommitFile, showWholeCommit, getGitApi, SCHEME } = require('./git');

const MAX_COMMITS = 500;
const RS = '\x1e';

let panel;
let current;
let lastMessage;
let lastData;
let sourceColumn = vscode.ViewColumn ? vscode.ViewColumn.One : 1;
let loadToken = 0;

function parseRenamePath(p) {
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, pre, before, after, post] = brace;
    const join = (mid) => (pre + mid + post).replace(/\/{2,}/g, '/');
    return { oldPath: join(before), path: join(after) };
  }
  const plain = p.split(' => ');
  if (plain.length === 2) return { oldPath: plain[0], path: plain[1] };
  return { oldPath: p, path: p };
}

function numstatPaths(record) {
  const end = record.indexOf('\x1d');
  const line = record
    .slice(end + 1)
    .split('\n')
    .find((l) => /^(\d+|-)\t(\d+|-)\t/.test(l));
  return line ? parseRenamePath(line.split('\t').slice(2).join('\t')) : undefined;
}

function shapeHistory(out, rel) {
  const commits = parseLog(out);
  const records = out.split(RS).slice(1);
  const counts = new Map();
  for (const c of commits) counts.set(c.author, (counts.get(c.author) || 0) + 1);
  const authors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count, additions: 0, deletions: 0 }));
  const lane = new Map(authors.map((a, i) => [a.name, i]));
  const points = commits
    .map((c, i) => {
      const paths = numstatPaths(records[i]) || { oldPath: rel, path: rel };
      const additions = c.stats ? c.stats.additions : 0;
      const deletions = c.stats ? c.stats.deletions : 0;
      const author = authors[lane.get(c.author)];
      author.additions += additions;
      author.deletions += deletions;
      return {
        hash: c.hash,
        short: c.short,
        author: c.author,
        lane: lane.get(c.author),
        time: Date.parse(c.iso),
        date: c.date,
        iso: c.iso,
        subject: c.subject,
        additions,
        deletions,
        path: paths.path,
        oldPath: paths.oldPath,
        status: paths.path !== paths.oldPath ? 'R' : 'M',
      };
    })
    .reverse()
    .sort((a, b) => a.time - b.time);
  return { authors, points };
}

async function readHistory(file) {
  const out = await git(file.root, ['log', LOG_FORMAT, '--follow', '--numstat', '-M', `-n${MAX_COMMITS}`, '--', file.rel]);
  const shaped = shapeHistory(out, file.rel);
  return { ...shaped, truncated: shaped.points.length >= MAX_COMMITS };
}

function post(message) {
  lastMessage = message;
  if (panel) panel.webview.postMessage(message);
}

async function load(file) {
  const token = ++loadToken;
  current = file;
  lastData = undefined;
  panel.title = `Visual History: ${path.basename(file.rel)}`;
  post({ type: 'loading', file: file.rel });
  try {
    const data = await readHistory(file);
    if (token !== loadToken) return;
    if (!data.points.length) {
      post({ type: 'empty', file: file.rel, message: 'This file has no commits yet. Commit it to see its history.' });
      return;
    }
    lastData = data;
    post({ type: 'data', file: file.rel, ...data });
  } catch (e) {
    if (token !== loadToken) return;
    post({ type: 'empty', file: file.rel, message: e.message });
  }
}

function sameFile(a, b) {
  return !!a && !!b && a.root === b.root && a.rel === b.rel;
}

function onMessage(message) {
  if (message.type === 'ready') {
    if (lastMessage) panel.webview.postMessage(lastMessage);
    return;
  }
  const point = lastData && current ? lastData.points.find((p) => p.hash === message.hash) : undefined;
  if (!point) return;
  if (message.type === 'open') {
    diffCommitFile(
      current.root,
      { hash: point.hash, short: point.short },
      { status: point.status, path: point.path, oldPath: point.oldPath },
      { preview: true, viewColumn: sourceColumn }
    );
  } else if (message.type === 'commit') {
    showWholeCommit(current.root, point.hash).catch((e) => vscode.window.showErrorMessage(`Git Compass: ${e.message}`));
  }
}

function createPanel() {
  panel = vscode.window.createWebviewPanel(
    'gitCompass.visualHistory',
    'Visual History',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
  );
  panel.iconPath = new vscode.ThemeIcon('graph-scatter');
  panel.webview.html = html(panel.webview, crypto.randomBytes(16).toString('base64'));
  panel.webview.onDidReceiveMessage(onMessage);
  panel.onDidDispose(() => {
    panel = undefined;
    current = undefined;
    lastMessage = undefined;
    lastData = undefined;
  });
}

async function show(arg) {
  await getGitApi();
  const file = targetFile(arg instanceof vscode.Uri ? arg : undefined);
  const editor = vscode.window.activeTextEditor;
  if (editor?.viewColumn) sourceColumn = editor.viewColumn;
  if (panel) panel.reveal(undefined, true);
  else createPanel();
  if (!sameFile(file, current) || !lastData) await load(file);
}

function follow(editor) {
  if (!panel || !editor) return;
  const uri = editor.document.uri;
  if (uri.scheme !== 'file' && uri.scheme !== SCHEME) return;
  let file;
  try {
    file = targetFile(uri);
  } catch {
    return;
  }
  if (editor.viewColumn) sourceColumn = editor.viewColumn;
  if (!sameFile(file, current)) load(file);
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitCompass.visualHistory', (arg) =>
      show(arg).catch((e) => vscode.window.showErrorMessage(`Git Compass: ${e.message}`))
    ),
    vscode.window.onDidChangeActiveTextEditor(follow),
    { dispose: () => panel?.dispose() }
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
    --card: var(--vscode-editorWidget-background, rgba(128,128,128,.06));
    --hover: var(--vscode-list-hoverBackground);
    --add: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green));
    --del: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red));
    --accent: var(--vscode-focusBorder);
    --heat: var(--vscode-charts-green);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 20px 32px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  button { font: inherit; color: inherit; }
  header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px 16px; margin-bottom: 16px; }
  .file { min-width: 0; }
  h1 { font-size: 1.35em; font-weight: 600; margin: 0 0 2px; word-break: break-all; }
  .path { color: var(--muted); font-size: .92em; word-break: break-all; }
  .periods { display: inline-flex; padding: 2px; gap: 2px; border-radius: 6px; background: var(--card); border: 1px solid var(--border); }
  .periods button { border: 0; padding: 3px 10px; border-radius: 4px; cursor: pointer; background: transparent; color: var(--muted); }
  .periods button:hover { color: var(--vscode-foreground); background: var(--hover); }
  .periods button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 8px; margin-bottom: 18px; }
  .card { padding: 9px 11px; border-radius: 8px; background: var(--card); border: 1px solid var(--border); min-width: 0; }
  .card .value { font-size: 1.3em; font-weight: 600; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .card .label { color: var(--muted); font-size: .85em; margin-top: 2px; }
  .plus { color: var(--add); }
  .minus { color: var(--del); }
  section { margin-bottom: 18px; }
  .section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 8px; font-size: .78em; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .section-title button { border: 0; background: none; padding: 0; cursor: pointer; color: var(--vscode-textLink-foreground); text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 1.2em; }
  .activity { display: flex; align-items: flex-end; gap: 3px; height: 72px; padding: 6px 8px 0; border-radius: 8px; background: var(--card); border: 1px solid var(--border); }
  .bucket { flex: 1 1 0; min-width: 3px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; border: 0; padding: 0; background: none; cursor: pointer; border-radius: 3px 3px 0 0; }
  .bucket:hover { background: var(--hover); }
  .bucket.empty { cursor: default; }
  .bucket.empty:hover { background: none; }
  .bucket.dim { opacity: .35; }
  .bucket > div { width: 100%; max-width: 22px; }
  .bucket .seg-add { background: var(--add); border-radius: 2px 2px 0 0; }
  .bucket .seg-del { background: var(--del); }
  .bucket .seg-none { background: var(--muted); opacity: .5; border-radius: 2px 2px 0 0; }
  .axis { display: flex; justify-content: space-between; color: var(--muted); font-size: .8em; padding: 4px 2px 0; }
  .authors { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 3px 10px 3px 3px; border-radius: 999px; cursor: pointer; background: var(--card); border: 1px solid var(--border); }
  .chip:hover { background: var(--hover); }
  .chip.off { opacity: .45; }
  .chip .count { color: var(--muted); }
  .avatar { flex: none; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,.25); }
  .chip .avatar { width: 20px; height: 20px; font-size: 9px; }
  .day { margin: 14px 0 4px; font-size: .85em; font-weight: 600; color: var(--muted); }
  .day:first-child { margin-top: 0; }
  .commit { display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left; padding: 8px 10px; border: 1px solid transparent; border-radius: 8px; background: none; cursor: pointer; }
  .commit:hover { background: var(--hover); }
  .commit:focus-visible { outline: 1px solid var(--accent); }
  .commit .body { flex: 1; min-width: 0; }
  .commit .subject { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 3px; color: var(--muted); font-size: .9em; }
  .sha { font-family: var(--vscode-editor-font-family); font-size: .95em; padding: 0 5px; border-radius: 4px; background: var(--vscode-textCodeBlock-background, var(--card)); }
  .rename { color: var(--muted); font-size: .88em; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .diffstat { display: inline-flex; align-items: center; gap: 6px; }
  .blocks { display: inline-flex; gap: 1px; }
  .blocks i { width: 7px; height: 7px; border-radius: 1px; background: var(--border); }
  .blocks i.a { background: var(--add); }
  .blocks i.d { background: var(--del); }
  .whole { flex: none; align-self: center; border: 0; background: none; padding: 2px 6px; border-radius: 4px; cursor: pointer; color: var(--muted); visibility: hidden; }
  .commit:hover .whole, .commit:focus-within .whole { visibility: visible; }
  .whole:hover { color: var(--vscode-foreground); background: var(--hover); }
  .more { margin-top: 8px; width: 100%; padding: 6px; border-radius: 6px; cursor: pointer; border: 1px dashed var(--border); background: none; color: var(--vscode-textLink-foreground); }
  .message { padding: 32px 0; text-align: center; color: var(--muted); }
  .note { color: var(--muted); font-size: .88em; margin-top: 6px; }
  .heat { padding: 10px 10px 8px; border-radius: 8px; background: var(--card); border: 1px solid var(--border); overflow: hidden; }
  .heat-body { display: flex; gap: 6px; }
  .heat-days { display: grid; grid-template-rows: repeat(7, var(--cell)); gap: var(--gap); padding-top: 16px; color: var(--muted); font-size: 9px; line-height: var(--cell); }
  .heat-main { min-width: 0; }
  .heat-months { position: relative; height: 16px; color: var(--muted); font-size: 10px; }
  .heat-months span { position: absolute; top: 0; white-space: nowrap; }
  .heat-grid { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, var(--cell)); grid-auto-columns: var(--cell); gap: var(--gap); }
  .cell { width: var(--cell); height: var(--cell); border-radius: 2px; border: 0; padding: 0; background: var(--border); }
  .cell.out { visibility: hidden; }
  .cell.l1 { background: color-mix(in srgb, var(--heat) 30%, transparent); }
  .cell.l2 { background: color-mix(in srgb, var(--heat) 55%, transparent); }
  .cell.l3 { background: color-mix(in srgb, var(--heat) 78%, transparent); }
  .cell.l4 { background: var(--heat); }
  .cell.hit { cursor: pointer; }
  .cell.hit:hover, .cell.sel { outline: 1px solid var(--vscode-foreground); outline-offset: 1px; }
  .heat-legend { display: flex; align-items: center; justify-content: flex-end; gap: 3px; margin-top: 8px; color: var(--muted); font-size: .8em; }
  .heat-legend .cell { width: 10px; height: 10px; }
</style>
</head>
<body>
<header>
  <div class="file">
    <h1 id="title">Visual History</h1>
    <div class="path" id="path"></div>
  </div>
  <div class="periods" role="group" aria-label="Period">
    <button data-period="all" aria-pressed="true">All</button>
    <button data-period="1y" aria-pressed="false">1y</button>
    <button data-period="6m" aria-pressed="false">6m</button>
    <button data-period="3m" aria-pressed="false">3m</button>
    <button data-period="1m" aria-pressed="false">1m</button>
  </div>
</header>
<main id="main"></main>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var DAY = 86400000;
  var PAGE = 60;
  var PERIODS = { all: 0, '1y': 365, '6m': 182, '3m': 91, '1m': 30 };
  var PALETTE = ['var(--vscode-charts-blue)', 'var(--vscode-charts-orange)', 'var(--vscode-charts-green)', 'var(--vscode-charts-purple)', 'var(--vscode-charts-red)', 'var(--vscode-charts-yellow)'];
  var saved = vscode.getState() || {};
  var period = PERIODS.hasOwnProperty(saved.period) ? saved.period : 'all';
  var data = null;
  var hidden = new Set();
  var bucketFilter = null;
  var shown = PAGE;
  var titleEl = document.getElementById('title');
  var pathEl = document.getElementById('path');
  var mainEl = document.getElementById('main');

  function color(i) { return i < PALETTE.length ? PALETTE[i] : 'hsl(' + ((i * 47) % 360) + ', 55%, 50%)'; }
  function el(name, cls, text, parent) {
    var e = document.createElement(name);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function plural(n, word) { return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's'); }
  function initials(name) {
    var parts = String(name || '?').trim().split(/\\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function ago(t) {
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    var units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (var i = 0; i < units.length; i++) {
      if (s >= units[i][1]) { var n = Math.floor(s / units[i][1]); return n + ' ' + units[i][0] + (n === 1 ? '' : 's') + ' ago'; }
    }
    return 'just now';
  }
  function shortAgo(t) {
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'now';
    var units = [['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60]];
    for (var i = 0; i < units.length; i++) if (s >= units[i][1]) return Math.floor(s / units[i][1]) + units[i][0] + ' ago';
    return 'now';
  }
  function dayLabel(t) {
    var d = new Date(t); d.setHours(0, 0, 0, 0);
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var diff = Math.round((today - d) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    var opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  function avatar(lane, name, parent) {
    var a = el('span', 'avatar', initials(name), parent);
    a.style.background = color(lane);
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  function inPeriod() {
    var days = PERIODS[period];
    var since = days ? Date.now() - days * DAY : -Infinity;
    return data.points.filter(function (p) { return p.time >= since; });
  }

  // Bucket size that gives at most ~36 bars over the commits' actual date range.
  function buckets(pts) {
    var min = Math.min.apply(null, pts.map(function (p) { return p.time; }));
    var days = PERIODS[period];
    var start = days ? Math.min(min, Date.now() - days * DAY) : min;
    var end = Date.now();
    var sizes = [[DAY, 'day'], [7 * DAY, 'week'], [30.44 * DAY, 'month'], [91.3 * DAY, 'quarter'], [365.25 * DAY, 'year']];
    var size = sizes[sizes.length - 1];
    for (var i = 0; i < sizes.length; i++) { if ((end - start) / sizes[i][0] <= 36) { size = sizes[i]; break; } }
    var first = new Date(start); first.setHours(0, 0, 0, 0);
    var t0 = first.getTime();
    var count = Math.max(1, Math.ceil((end - t0) / size[0]));
    var list = [];
    for (var b = 0; b < count; b++) list.push({ from: t0 + b * size[0], to: t0 + (b + 1) * size[0], unit: size[1], pts: [], add: 0, del: 0 });
    pts.forEach(function (p) {
      var idx = Math.min(count - 1, Math.max(0, Math.floor((p.time - t0) / size[0])));
      var bk = list[idx]; bk.pts.push(p); bk.add += p.additions; bk.del += p.deletions;
    });
    return list;
  }
  var WEEKS = { all: 53, '1y': 53, '6m': 27, '3m': 14, '1m': 6 };
  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

  function renderHeatmap(pts) {
    var sec = el('section', null, null, mainEl);
    var head = el('div', 'section-title', null, sec);
    el('span', null, 'Heat map', head);
    var byDay = new Map();
    pts.forEach(function (p) {
      var k = dayKey(p.time);
      var d = byDay.get(k) || { n: 0, add: 0, del: 0 };
      d.n++; d.add += p.additions; d.del += p.deletions;
      byDay.set(k, d);
    });
    var weeks = WEEKS[period] || 53;
    // Width left for squares: panel minus the box padding and the weekday labels.
    var avail = Math.max(120, mainEl.clientWidth - 64);
    var gap = weeks > 30 ? 2 : 3;
    var MIN_CELL = 8;
    // Show only the most recent weeks that fit, so today is never cut off.
    weeks = Math.max(4, Math.min(weeks, Math.floor((avail + gap) / (MIN_CELL + gap))));
    var cell = Math.max(MIN_CELL, Math.min(weeks <= 14 ? 22 : 16, Math.floor((avail - gap * (weeks - 1)) / weeks)));
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var end = new Date(today); end.setDate(end.getDate() + (6 - end.getDay()));
    var start = new Date(end); start.setDate(start.getDate() - weeks * 7 + 1);
    var box = el('div', 'heat', null, sec);
    box.style.setProperty('--cell', cell + 'px');
    box.style.setProperty('--gap', gap + 'px');
    var body = el('div', 'heat-body', null, box);
    var days = el('div', 'heat-days', null, body);
    ['', 'Mon', '', 'Wed', '', 'Fri', ''].forEach(function (d) { el('span', null, cell >= 10 ? d : '', days); });
    var main = el('div', 'heat-main', null, body);
    var months = el('div', 'heat-months', null, main);
    var grid = el('div', 'heat-grid', null, main);
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-label', 'Commits per day');
    var max = 0;
    byDay.forEach(function (d) { max = Math.max(max, d.add + d.del + d.n); });
    var lastMonth = -1;
    for (var i = 0; i < weeks * 7; i++) {
      var day = new Date(start); day.setDate(start.getDate() + i);
      if (day.getDay() === 0 && day.getMonth() !== lastMonth && day.getDate() <= 7) {
        lastMonth = day.getMonth();
        var m = el('span', null, day.toLocaleDateString(undefined, { month: 'short' }), months);
        m.style.left = (Math.floor(i / 7) * (cell + gap)) + 'px';
      }
      var info = byDay.get(dayKey(day.getTime()));
      var future = day > today;
      var c = el('button', 'cell' + (future ? ' out' : ''), null, grid);
      var label = day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ': ';
      if (info) {
        // Square-root scale so one huge commit does not wash out the rest.
        var level = Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt((info.add + info.del + info.n) / max))));
        c.classList.add('l' + level, 'hit');
        label += plural(info.n, 'commit') + ', +' + info.add + ' \\u2212' + info.del;
        var from = day.getTime();
        var to = from + DAY;
        if (bucketFilter && bucketFilter.from === from && bucketFilter.to === to) c.classList.add('sel');
        (function (from, to, name) {
          c.addEventListener('click', function () {
            bucketFilter = bucketFilter && bucketFilter.from === from && bucketFilter.to === to ? null : { from: from, to: to, name: name };
            shown = PAGE;
            render();
          });
        })(from, to, day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
      } else {
        label += 'no commits';
        c.tabIndex = -1;
      }
      c.title = label;
      c.setAttribute('aria-label', label);
    }
    var legend = el('div', 'heat-legend', null, box);
    el('span', null, 'Less', legend);
    ['', 'l1', 'l2', 'l3', 'l4'].forEach(function (l) { el('span', 'cell ' + l, null, legend); });
    el('span', null, 'More', legend);
  }

  function bucketName(bk) {
    var f = new Date(bk.from);
    if (bk.unit === 'day') return f.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    if (bk.unit === 'week') return 'Week of ' + f.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (bk.unit === 'month') return f.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (bk.unit === 'quarter') return 'Quarter from ' + f.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    return String(f.getFullYear());
  }

  function card(parent, value, label, cls) {
    var c = el('div', 'card', null, parent);
    var v = el('div', 'value', null, c);
    if (Array.isArray(value)) value.forEach(function (part) { el('span', part[1], part[0], v); });
    else v.textContent = value;
    v.title = v.textContent;
    el('div', 'label', label, c);
    return c;
  }

  function diffBlocks(p, parent) {
    var wrap = el('span', 'diffstat', null, parent);
    if (p.additions || !p.deletions) el('span', 'plus', '+' + p.additions, wrap);
    if (p.deletions) el('span', 'minus', '\\u2212' + p.deletions, wrap);
    var total = p.additions + p.deletions;
    var blocks = el('span', 'blocks', null, wrap);
    var filled = total ? Math.min(5, Math.max(1, Math.round(Math.log10(total + 1) * 2))) : 0;
    var adds = total ? Math.round(filled * p.additions / total) : 0;
    for (var i = 0; i < 5; i++) el('i', i < adds ? 'a' : i < filled ? 'd' : '', null, blocks);
    wrap.title = plural(p.additions, 'line') + ' added, ' + plural(p.deletions, 'line') + ' removed';
  }

  function commitRow(p, parent) {
    var row = el('button', 'commit', null, parent);
    row.title = 'Open the changes to this file \\u2014 Ctrl/Cmd+click for the whole commit';
    avatar(p.lane, p.author, row);
    var body = el('div', 'body', null, row);
    el('div', 'subject', p.subject || '(no message)', body);
    if (p.path !== p.oldPath) el('div', 'rename', 'Renamed from ' + p.oldPath, body);
    var meta = el('div', 'meta', null, body);
    if (data.authors.length > 1) el('span', null, p.author, meta);
    var when = el('span', null, ago(p.time), meta);
    when.title = new Date(p.iso).toLocaleString();
    el('span', 'sha', p.short, meta);
    diffBlocks(p, meta);
    var whole = el('span', 'whole', '\\u2197 Commit', row);
    whole.title = 'Show the whole commit';
    whole.addEventListener('click', function (ev) { ev.stopPropagation(); vscode.postMessage({ type: 'commit', hash: p.hash }); });
    row.addEventListener('click', function (ev) {
      vscode.postMessage({ type: ev.ctrlKey || ev.metaKey || ev.shiftKey ? 'commit' : 'open', hash: p.hash });
    });
  }

  function render() {
    mainEl.textContent = '';
    if (!data) return;
    var period_ = inPeriod();
    var visible = period_.filter(function (p) { return !hidden.has(p.lane); });

    // Summary
    var cards = el('div', 'cards', null, mainEl);
    var adds = 0, dels = 0;
    visible.forEach(function (p) { adds += p.additions; dels += p.deletions; });
    var authorsHere = new Set(period_.map(function (p) { return p.lane; }));
    card(cards, visible.length.toLocaleString(), visible.length === 1 ? 'commit' : 'commits');
    card(cards, authorsHere.size.toLocaleString(), authorsHere.size === 1 ? 'author' : 'authors');
    var compact = function (n) { return n < 1000 ? String(n) : n.toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 }); };
    var linesCard = card(cards, [['+' + compact(adds), 'plus'], [' ', ''], ['\\u2212' + compact(dels), 'minus']], 'lines changed');
    linesCard.title = adds.toLocaleString() + ' lines added, ' + dels.toLocaleString() + ' removed';
    if (visible.length) card(cards, shortAgo(visible[visible.length - 1].time), 'last change');
    if (data.truncated) el('div', 'note', 'Showing the latest ' + data.points.length + ' commits.', mainEl);

    if (!period_.length) { el('div', 'message', 'No commits in this period. Try a longer one.', mainEl); return; }

    // Activity
    var bks = buckets(visible.length ? visible : period_);
    var act = el('section', null, null, mainEl);
    var head = el('div', 'section-title', null, act);
    el('span', null, 'Activity', head);
    if (bucketFilter) {
      var clear = el('button', null, 'Clear filter', head);
      clear.addEventListener('click', function () { bucketFilter = null; shown = PAGE; render(); });
    }
    var bars = el('div', 'activity', null, act);
    bars.setAttribute('role', 'group');
    bars.setAttribute('aria-label', 'Changes over time');
    var maxChange = Math.max.apply(null, bks.map(function (b) { return b.add + b.del; }).concat([1]));
    var maxCount = Math.max.apply(null, bks.map(function (b) { return b.pts.length; }).concat([1]));
    bks.forEach(function (bk) {
      var b = el('button', 'bucket' + (bk.pts.length ? '' : ' empty'), null, bars);
      var active = bucketFilter && bucketFilter.from === bk.from;
      if (bucketFilter && !active) b.classList.add('dim');
      var label = bucketName(bk) + ': ' + (bk.pts.length ? plural(bk.pts.length, 'commit') + ', +' + bk.add + ' \\u2212' + bk.del : 'no commits');
      b.title = label;
      b.setAttribute('aria-label', label);
      if (bk.pts.length) {
        var total = bk.add + bk.del;
        // Height mixes line changes and commit count so small commits stay visible.
        var h = Math.max(8, 100 * (0.6 * (total / maxChange) + 0.4 * (bk.pts.length / maxCount)));
        if (total) {
          var a = el('div', 'seg-add', null, b); a.style.height = (h * bk.add / total) + '%';
          var d = el('div', 'seg-del', null, b); d.style.height = (h * bk.del / total) + '%';
        } else {
          var n = el('div', 'seg-none', null, b); n.style.height = h + '%';
        }
        b.addEventListener('click', function () { bucketFilter = active ? null : { from: bk.from, to: bk.to, name: bucketName(bk) }; shown = PAGE; render(); });
      } else {
        b.disabled = true;
      }
    });
    var axis = el('div', 'axis', null, act);
    el('span', null, bucketName(bks[0]), axis);
    if (bks.length > 1) el('span', null, 'now', axis);

    // Calendar heat map: one square per day, coloured by how much the file changed.
    renderHeatmap(visible);

    // Authors
    if (data.authors.length) {
      var auth = el('section', null, null, mainEl);
      el('div', 'section-title', 'Authors', auth);
      var chips = el('div', 'authors', null, auth);
      var counts = new Map();
      period_.forEach(function (p) { counts.set(p.lane, (counts.get(p.lane) || 0) + 1); });
      data.authors.forEach(function (a, i) {
        var n = counts.get(i) || 0;
        if (!n) return;
        var chip = el('button', 'chip' + (hidden.has(i) ? ' off' : ''), null, chips);
        chip.title = (hidden.has(i) ? 'Show ' : 'Hide ') + a.name + ' \\u2014 ' + Math.round((n / period_.length) * 100) + '% of commits';
        chip.setAttribute('aria-pressed', String(!hidden.has(i)));
        avatar(i, a.name, chip);
        el('span', null, a.name, chip);
        el('span', 'count', String(n), chip);
        chip.addEventListener('click', function () {
          if (hidden.has(i)) hidden.delete(i); else hidden.add(i);
          shown = PAGE;
          render();
        });
      });
    }

    // Commits, newest first, grouped by day
    var list = visible.slice().reverse();
    if (bucketFilter) list = list.filter(function (p) { return p.time >= bucketFilter.from && p.time < bucketFilter.to; });
    var sec = el('section', null, null, mainEl);
    el('div', 'section-title', bucketFilter ? 'Commits \\u00b7 ' + bucketFilter.name : 'Commits', sec);
    if (!list.length) { el('div', 'message', 'Every author in this period is hidden.', sec); return; }
    var lastDay = '';
    list.slice(0, shown).forEach(function (p) {
      var day = dayLabel(p.time);
      if (day !== lastDay) { el('div', 'day', day, sec); lastDay = day; }
      commitRow(p, sec);
    });
    if (list.length > shown) {
      var more = el('button', 'more', 'Show ' + Math.min(PAGE, list.length - shown) + ' more of ' + (list.length - shown), sec);
      more.addEventListener('click', function () { shown += PAGE; render(); });
    }
  }

  function showMessage(text) {
    data = null;
    mainEl.textContent = '';
    el('div', 'message', text, mainEl);
  }

  function syncPeriodButtons() {
    document.querySelectorAll('.periods button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.period === period)); });
  }
  document.querySelectorAll('.periods button').forEach(function (b) {
    b.addEventListener('click', function () {
      period = b.dataset.period;
      bucketFilter = null;
      shown = PAGE;
      vscode.setState({ period: period });
      syncPeriodButtons();
      render();
    });
  });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.file) {
      var slash = msg.file.lastIndexOf('/');
      titleEl.textContent = msg.file.slice(slash + 1);
      pathEl.textContent = slash > 0 ? msg.file.slice(0, slash) : '';
    }
    if (msg.type === 'loading') showMessage('Loading history\\u2026');
    else if (msg.type === 'empty') showMessage(msg.message);
    else if (msg.type === 'data') {
      data = msg;
      hidden = new Set();
      bucketFilter = null;
      shown = PAGE;
      render();
    }
  });

  var lastWidth = 0;
  new ResizeObserver(function () {
    if (data && Math.abs(mainEl.clientWidth - lastWidth) > 8) { lastWidth = mainEl.clientWidth; requestAnimationFrame(render); }
  }).observe(mainEl);

  syncPeriodButtons();
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { register, show, shapeHistory, parseRenamePath, html };

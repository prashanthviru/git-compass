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
  body { margin: 0; padding: 12px 16px 24px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-bottom: 10px; }
  h1 { font-size: 1.15em; font-weight: 600; margin: 0; word-break: break-all; }
  .periods { display: inline-flex; border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent)); border-radius: 4px; overflow: hidden; }
  .periods button { border: 0; padding: 3px 10px; cursor: pointer; font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .periods button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .periods button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  #status { color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  #legend { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  #legend button { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; font: inherit; cursor: pointer; border-radius: 10px; color: var(--vscode-foreground); background: transparent; border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.4))); }
  #legend button:hover { background: var(--vscode-list-hoverBackground); }
  #legend button.off { opacity: .45; text-decoration: line-through; }
  #legend .swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  #legend .count { color: var(--vscode-descriptionForeground); }
  #chart { width: 100%; overflow: hidden; }
  svg { display: block; }
  .grid { stroke: var(--vscode-editorIndentGuide-background1, rgba(128,128,128,.2)); stroke-width: 1; }
  .lane { stroke: var(--vscode-editorIndentGuide-background1, rgba(128,128,128,.15)); stroke-dasharray: 2 4; }
  .axis { stroke: var(--vscode-editorWidget-border, rgba(128,128,128,.5)); }
  .tick { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .label { font-size: 12px; }
  .caption { fill: var(--vscode-descriptionForeground); font-size: 11px; }
  .dot { stroke: var(--vscode-editor-background); stroke-width: 1.5; cursor: pointer; opacity: .9; }
  .dot:hover, .dot.active { stroke: var(--vscode-focusBorder); stroke-width: 2.5; opacity: 1; }
  .add { fill: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green)); cursor: pointer; }
  .del { fill: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red)); cursor: pointer; }
  .add:hover, .del:hover { opacity: .75; }
  #tip { position: fixed; z-index: 10; display: none; max-width: 380px; padding: 8px 10px; pointer-events: none; border-radius: 4px; color: var(--vscode-editorHoverWidget-foreground); background: var(--vscode-editorHoverWidget-background); border: 1px solid var(--vscode-editorHoverWidget-border); box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,.3)); }
  #tip .subject { font-weight: 600; margin-bottom: 4px; word-break: break-word; }
  #tip .meta { color: var(--vscode-descriptionForeground); }
  #tip .sha { font-family: var(--vscode-editor-font-family); }
  #tip .plus { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green)); }
  #tip .minus { color: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red)); }
  #tip .hint { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: .9em; }
  .message { padding: 24px 0; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header>
  <h1 id="title">Visual History</h1>
  <div class="periods" role="group" aria-label="Period">
    <button data-period="all" aria-pressed="true">All</button>
    <button data-period="1y" aria-pressed="false">1y</button>
    <button data-period="6m" aria-pressed="false">6m</button>
    <button data-period="3m" aria-pressed="false">3m</button>
    <button data-period="1m" aria-pressed="false">1m</button>
  </div>
</header>
<div id="status"></div>
<div id="legend"></div>
<div id="chart"></div>
<div id="tip"></div>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var NS = 'http://www.w3.org/2000/svg';
  var DAY = 86400000;
  var PERIODS = { all: 0, '1y': 365, '6m': 182, '3m': 91, '1m': 30 };
  var PALETTE = ['var(--vscode-charts-blue)', 'var(--vscode-charts-orange)', 'var(--vscode-charts-green)', 'var(--vscode-charts-purple)', 'var(--vscode-charts-red)', 'var(--vscode-charts-yellow)'];
  var saved = vscode.getState() || {};
  var period = PERIODS.hasOwnProperty(saved.period) ? saved.period : 'all';
  var data = null;
  var hidden = new Set();
  var lastWidth = 0;
  var titleEl = document.getElementById('title');
  var statusEl = document.getElementById('status');
  var legendEl = document.getElementById('legend');
  var chartEl = document.getElementById('chart');
  var tipEl = document.getElementById('tip');

  function color(i) { return i < PALETTE.length ? PALETTE[i] : 'hsl(' + ((i * 47) % 360) + ', 55%, 55%)'; }

  function svgEl(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function htmlEl(name, cls, text, parent) {
    var e = document.createElement(name);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function sincePeriod() {
    var days = PERIODS[period];
    return days ? Date.now() - days * DAY : -Infinity;
  }

  function periodPoints() {
    var since = sincePeriod();
    return data.points.filter(function (p) { return p.time >= since; });
  }

  function syncPeriodButtons() {
    document.querySelectorAll('.periods button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.period === period));
    });
  }

  function ticksFor(min, max, maxTicks) {
    var steps = [1, 2, 7, 14, 30, 61, 91, 182, 365, 730, 1825];
    var span = (max - min) / DAY;
    var step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (span / steps[i] <= maxTicks) { step = steps[i]; break; } }
    var out = [];
    var fmt;
    if (step < 30) {
      fmt = { month: 'short', day: 'numeric' };
      var d = new Date(min); d.setHours(0, 0, 0, 0);
      var t = d.getTime();
      while (t < min) t += DAY;
      for (; t <= max; t += step * DAY) out.push(t);
    } else {
      var months = Math.round(step / 30.4);
      fmt = months >= 12 ? { year: 'numeric' } : { month: 'short', year: 'numeric' };
      var m = new Date(min); m.setDate(1); m.setHours(0, 0, 0, 0);
      if (months >= 12) m.setMonth(0);
      while (m.getTime() < min) m.setMonth(m.getMonth() + months);
      for (; m.getTime() <= max; m.setMonth(m.getMonth() + months)) out.push(m.getTime());
    }
    return out.map(function (t) { return { t: t, label: new Date(t).toLocaleDateString(undefined, fmt) }; });
  }

  function showTip(p, ev) {
    tipEl.textContent = '';
    htmlEl('div', 'subject', p.subject || '(no message)', tipEl);
    var meta = htmlEl('div', 'meta', null, tipEl);
    meta.textContent = p.author + ' \\u00b7 ' + p.date + ' (' + new Date(p.iso).toLocaleString() + ')';
    var line = htmlEl('div', null, null, tipEl);
    htmlEl('span', 'sha', p.short, line);
    line.appendChild(document.createTextNode('  '));
    htmlEl('span', 'plus', '+' + p.additions, line);
    line.appendChild(document.createTextNode(' '));
    htmlEl('span', 'minus', '\\u2212' + p.deletions, line);
    if (p.path !== p.oldPath) htmlEl('div', 'meta', p.oldPath + ' \\u2192 ' + p.path, tipEl);
    htmlEl('div', 'hint', 'Click to open the diff \\u00b7 Ctrl/Cmd+click for the whole commit', tipEl);
    tipEl.style.display = 'block';
    moveTip(ev);
  }

  function moveTip(ev) {
    var pad = 14;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 4) x = Math.max(4, ev.clientX - w - pad);
    if (y + h > window.innerHeight - 4) y = Math.max(4, ev.clientY - h - pad);
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  }

  function hideTip() { tipEl.style.display = 'none'; }

  function bind(node, p) {
    node.addEventListener('mouseenter', function (ev) { showTip(p, ev); });
    node.addEventListener('mousemove', moveTip);
    node.addEventListener('mouseleave', hideTip);
    node.addEventListener('click', function (ev) {
      vscode.postMessage({ type: ev.ctrlKey || ev.metaKey || ev.shiftKey ? 'commit' : 'open', hash: p.hash });
    });
  }

  function renderLegend(pts) {
    legendEl.textContent = '';
    var counts = new Map();
    pts.forEach(function (p) { counts.set(p.lane, (counts.get(p.lane) || 0) + 1); });
    data.authors.forEach(function (a, i) {
      var n = counts.get(i) || 0;
      if (!n) return;
      var b = htmlEl('button', hidden.has(i) ? 'off' : '', null, legendEl);
      b.title = hidden.has(i) ? 'Show ' + a.name : 'Hide ' + a.name;
      var sw = htmlEl('span', 'swatch', null, b);
      sw.style.background = color(i);
      htmlEl('span', null, a.name, b);
      htmlEl('span', 'count', String(n), b);
      b.addEventListener('click', function () {
        if (hidden.has(i)) hidden.delete(i); else hidden.add(i);
        render();
      });
    });
  }

  function render() {
    hideTip();
    chartEl.textContent = '';
    if (!data) return;
    var inPeriod = periodPoints();
    renderLegend(inPeriod);
    var pts = inPeriod.filter(function (p) { return !hidden.has(p.lane); });
    var authorsInPeriod = new Set(inPeriod.map(function (p) { return p.lane; })).size;
    var summary = data.points.length + ' commits by ' + data.authors.length + (data.authors.length === 1 ? ' author' : ' authors');
    if (data.truncated) summary += ' (latest ' + data.points.length + ' shown)';
    if (period !== 'all') summary += ' \\u00b7 ' + inPeriod.length + ' commits by ' + authorsInPeriod + ' in this period';
    statusEl.textContent = summary;
    if (!pts.length) {
      htmlEl('div', 'message', inPeriod.length ? 'Every author in this period is hidden.' : 'No commits in this period.', chartEl);
      return;
    }
    var lanes = [];
    pts.forEach(function (p) { if (lanes.indexOf(p.lane) === -1) lanes.push(p.lane); });
    lanes.sort(function (a, b) { return a - b; });
    var laneIndex = new Map(lanes.map(function (l, i) { return [l, i]; }));
    var width = Math.max(320, chartEl.clientWidth);
    lastWidth = chartEl.clientWidth;
    var labelW = Math.round(Math.min(190, Math.max(90, width * 0.2)));
    var right = 18, top = 30, laneH = 30, gap = 22, barH = 76, bottom = 8;
    var plotW = width - labelW - right;
    var barTop = top + lanes.length * laneH + gap;
    var height = barTop + barH + bottom;
    var svg = svgEl('svg', { width: width, height: height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': 'Commit timeline' }, chartEl);
    var min = Math.min.apply(null, pts.map(function (p) { return p.time; }));
    var max = Math.max.apply(null, pts.map(function (p) { return p.time; }));
    if (period !== 'all') { min = Math.min(min, sincePeriod()); max = Math.max(max, Date.now()); }
    if (max - min < DAY) { min -= DAY; max += DAY; }
    var pad = (max - min) * 0.03;
    min -= pad; max += pad;
    function x(t) { return labelW + ((t - min) / (max - min)) * plotW; }

    ticksFor(min, max, Math.max(2, Math.floor(plotW / 110))).forEach(function (tk) {
      var tx = x(tk.t);
      svgEl('line', { x1: tx, x2: tx, y1: top - 8, y2: height - bottom, class: 'grid' }, svg);
      var text = svgEl('text', { x: tx, y: 14, 'text-anchor': 'middle', class: 'tick' }, svg);
      text.textContent = tk.label;
    });

    lanes.forEach(function (lane, i) {
      var y = top + i * laneH + laneH / 2;
      svgEl('line', { x1: labelW, x2: width - right, y1: y, y2: y, class: 'lane' }, svg);
      var name = data.authors[lane].name;
      var maxChars = Math.max(6, Math.floor((labelW - 12) / 7));
      var label = svgEl('text', { x: labelW - 10, y: y + 4, 'text-anchor': 'end', class: 'label' }, svg);
      label.textContent = name.length > maxChars ? name.slice(0, maxChars - 1) + '\\u2026' : name;
      label.style.fill = color(lane);
      var title = svgEl('title', {}, label);
      title.textContent = name;
    });

    var maxChange = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p.additions + p.deletions; })));
    var maxR = Math.min(laneH / 2 - 2, 13);
    pts.slice().sort(function (a, b) { return (b.additions + b.deletions) - (a.additions + a.deletions); }).forEach(function (p) {
      var r = 3 + (maxR - 3) * Math.sqrt((p.additions + p.deletions) / maxChange);
      var cy = top + laneIndex.get(p.lane) * laneH + laneH / 2;
      var dot = svgEl('circle', { cx: x(p.time), cy: cy, r: r.toFixed(2), class: 'dot' }, svg);
      dot.style.fill = color(p.lane);
      bind(dot, p);
    });

    var mid = barTop + barH / 2;
    var addCap = svgEl('text', { x: labelW - 10, y: barTop + 12, 'text-anchor': 'end', class: 'caption' }, svg);
    addCap.textContent = 'Lines added';
    var delCap = svgEl('text', { x: labelW - 10, y: barTop + barH - 4, 'text-anchor': 'end', class: 'caption' }, svg);
    delCap.textContent = 'Lines removed';
    svgEl('line', { x1: labelW, x2: width - right, y1: mid, y2: mid, class: 'axis' }, svg);
    var maxSide = Math.max(1, Math.max.apply(null, pts.map(function (p) { return Math.max(p.additions, p.deletions); })));
    var bw = Math.max(2, Math.min(8, (plotW / pts.length) * 0.6));
    var half = barH / 2 - 2;
    pts.forEach(function (p) {
      var bx = x(p.time) - bw / 2;
      var ah = Math.max(p.additions ? 1 : 0, (half * p.additions) / maxSide);
      var dh = Math.max(p.deletions ? 1 : 0, (half * p.deletions) / maxSide);
      if (ah) bind(svgEl('rect', { x: bx, y: mid - ah, width: bw, height: ah, class: 'add' }, svg), p);
      if (dh) bind(svgEl('rect', { x: bx, y: mid, width: bw, height: dh, class: 'del' }, svg), p);
    });
  }

  function showMessage(text) {
    data = null;
    legendEl.textContent = '';
    chartEl.textContent = '';
    statusEl.textContent = '';
    htmlEl('div', 'message', text, chartEl);
  }

  document.querySelectorAll('.periods button').forEach(function (b) {
    b.addEventListener('click', function () {
      period = b.dataset.period;
      vscode.setState({ period: period });
      syncPeriodButtons();
      render();
    });
  });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.file) titleEl.textContent = msg.file;
    if (msg.type === 'loading') showMessage('Loading history\\u2026');
    else if (msg.type === 'empty') showMessage(msg.message);
    else if (msg.type === 'data') {
      data = msg;
      hidden = new Set();
      render();
    }
  });

  new ResizeObserver(function () {
    if (data && chartEl.clientWidth !== lastWidth) requestAnimationFrame(render);
  }).observe(chartEl);

  syncPeriodButtons();
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { register, show, shapeHistory, parseRenamePath, html };

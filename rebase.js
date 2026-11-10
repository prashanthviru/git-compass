const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { git, showWholeCommit } = require('./git');

const VIEW_TYPE = 'gitCompass.rebaseEditor';
const ALIASES = {
  p: 'pick',
  pick: 'pick',
  r: 'reword',
  reword: 'reword',
  e: 'edit',
  edit: 'edit',
  s: 'squash',
  squash: 'squash',
  f: 'fixup',
  fixup: 'fixup',
  d: 'drop',
  drop: 'drop',
  x: 'exec',
  exec: 'exec',
  b: 'break',
  break: 'break',
  l: 'label',
  label: 'label',
  t: 'reset',
  reset: 'reset',
  m: 'merge',
  merge: 'merge',
  u: 'update-ref',
  'update-ref': 'update-ref',
};
const COMMIT_ACTIONS = new Set(['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']);

function parseTodo(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const slots = [];
  const entries = [];
  const comments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      slots.push({ text: raw });
      if (line.startsWith('#')) comments.push(line);
      continue;
    }
    const m = line.match(/^(\S+)(?:\s+(.*))?$/);
    const action = ALIASES[m[1]];
    const rest = m[2] || '';
    let entry;
    if (!action) {
      entry = { action: 'unknown', origAction: 'unknown', raw };
    } else if (COMMIT_ACTIONS.has(action)) {
      let flag = '';
      let body = rest;
      const fm = action === 'fixup' ? body.match(/^(-[cC])\s+(.*)$/) : null;
      if (fm) {
        flag = fm[1];
        body = fm[2];
      }
      const space = body.search(/\s/);
      const sha = space === -1 ? body : body.slice(0, space);
      const subject = space === -1 ? '' : body.slice(space).trim();
      entry = { action, origAction: action, flag, sha, subject, raw };
    } else {
      entry = { action, origAction: action, arg: rest, raw };
    }
    slots.push({ entry: entries.length });
    entries.push(entry);
  }
  return { eol, slots, entries, header: parseHeader(comments) };
}

function parseHeader(comments) {
  for (const line of comments) {
    const m = line.match(/^#\s*Rebase\s+(\S+)\s+onto\s+(\S+)(?:\s+\((\d+)\s+commands?\))?/i);
    if (m) return { range: m[1], onto: m[2], count: m[3] ? Number(m[3]) : undefined };
  }
  return undefined;
}

function serializeEntry(e) {
  if (e.action === e.origAction) return e.raw;
  if (COMMIT_ACTIONS.has(e.action) && COMMIT_ACTIONS.has(e.origAction)) {
    return [e.action, e.action === 'fixup' ? e.flag : '', e.sha, e.subject].filter(Boolean).join(' ');
  }
  return e.raw;
}

function sanitizeEntries(parsed, incoming) {
  if (!Array.isArray(incoming) || incoming.length !== parsed.entries.length) return undefined;
  const pool = parsed.entries.slice();
  const result = [];
  for (const item of incoming) {
    const i = item && typeof item.raw === 'string' ? pool.findIndex((e) => e && e.raw === item.raw) : -1;
    if (i === -1) return undefined;
    const e = { ...pool[i] };
    pool[i] = null;
    if (COMMIT_ACTIONS.has(e.origAction) && COMMIT_ACTIONS.has(item.action)) e.action = item.action;
    result.push(e);
  }
  return result;
}

function serializeTodo(parsed, entries) {
  return parsed.slots
    .map((slot) => (slot.entry === undefined ? slot.text : serializeEntry(entries[slot.entry])))
    .join(parsed.eol);
}

async function commitInfo(cwd, shas, cache = {}) {
  const known = Object.keys(cache);
  const missing = [...new Set(shas)].filter(
    (s) => /^[0-9a-fA-F]{4,64}$/.test(s) && !known.some((k) => k.startsWith(s.toLowerCase()))
  );
  if (!missing.length) return cache;
  const format = '--format=%H%x1f%h%x1f%an%x1f%ar%x1f%aI%x1f%s';
  const parse = (out) => {
    for (const line of out.split('\n').filter(Boolean)) {
      const [hash, short, author, date, iso, subject] = line.split('\x1f');
      cache[hash] = { hash, short, author, date, iso, subject };
    }
  };
  try {
    parse(await git(cwd, ['log', '--no-walk=unsorted', format, ...missing, '--']));
  } catch {
    for (const sha of missing) {
      try {
        parse(await git(cwd, ['log', '-1', format, sha, '--']));
      } catch {}
    }
  }
  return cache;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

async function rebaseDetails(todoPath, gitDir, header) {
  const dir = path.dirname(todoPath);
  const headName = readText(path.join(dir, 'head-name'));
  const ontoSha = readText(path.join(dir, 'onto')) || header?.onto || '';
  const branch = headName ? headName.replace(/^refs\/heads\//, '') : '';
  let onto = ontoSha ? ontoSha.slice(0, 9) : '';
  if (ontoSha) {
    try {
      const names = (await git(gitDir, ['for-each-ref', '--points-at', ontoSha, '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']))
        .split('\n')
        .filter((n) => n && !n.endsWith('/HEAD'));
      if (names.length) onto = `${names[0]} (${ontoSha.slice(0, 7)})`;
    } catch {}
  }
  if (!branch && !onto) return header ? `Rebasing ${header.range} onto ${header.onto}` : 'Interactive rebase';
  return `Rebasing ${branch || header?.range || 'HEAD'} onto ${onto || header?.onto || '?'}`;
}

function closeTabs(uri) {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => (t.input instanceof vscode.TabInputCustom || t.input instanceof vscode.TabInputText) && t.input.uri.toString() === uri.toString());
  return tabs.length ? vscode.window.tabGroups.close(tabs) : undefined;
}

async function replaceDocument(document, text) {
  if (text === document.getText()) return true;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  return vscode.workspace.applyEdit(edit);
}

async function openAsText(uri) {
  const target =
    uri instanceof vscode.Uri
      ? uri
      : vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom
        ? vscode.window.tabGroups.activeTabGroup.activeTab.input.uri
        : undefined;
  if (!target) return;
  const custom = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE && t.input.uri.toString() === target.toString());
  await vscode.commands.executeCommand('vscode.openWith', target, 'default');
  if (custom.length) await vscode.window.tabGroups.close(custom);
}

class RebaseEditorProvider {
  async resolveCustomTextEditor(document, webviewPanel) {
    if (!vscode.workspace.getConfiguration('gitCompass').get('rebaseEditor.enabled', true)) {
      webviewPanel.dispose();
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
      return;
    }
    const todoPath = document.uri.fsPath;
    const gitDir = path.dirname(path.dirname(todoPath));
    const cache = {};
    let parsed = parseTodo(document.getText());
    let headerText;
    let timer;

    webviewPanel.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewPanel.webview.html = html(webviewPanel.webview, crypto.randomBytes(16).toString('base64'));

    const postState = async () => {
      parsed = parseTodo(document.getText());
      if (headerText === undefined) headerText = await rebaseDetails(todoPath, gitDir, parsed.header);
      await commitInfo(
        gitDir,
        parsed.entries.filter((e) => e.sha).map((e) => e.sha),
        cache
      );
      webviewPanel.webview.postMessage({ type: 'state', header: headerText, entries: parsed.entries, info: cache });
    };

    const fail = (e) => vscode.window.showErrorMessage(`Git Compass: ${e.message}`);

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        clearTimeout(timer);
        timer = setTimeout(() => postState().catch(fail), 30);
      }),
      webviewPanel.webview.onDidReceiveMessage(async (message) => {
        try {
          if (message.type === 'ready') await postState();
          else if (message.type === 'update') {
            const current = parseTodo(document.getText());
            const entries = sanitizeEntries(current, message.entries);
            if (entries) await replaceDocument(document, serializeTodo(current, entries));
            else await postState();
          } else if (message.type === 'start') {
            await document.save();
            await closeTabs(document.uri);
          } else if (message.type === 'abort') {
            await replaceDocument(document, '');
            await document.save();
            await closeTabs(document.uri);
          } else if (message.type === 'text') {
            await openAsText(document.uri);
          } else if (message.type === 'show' && /^[0-9a-fA-F]{4,64}$/.test(message.sha || '')) {
            await showWholeCommit(gitDir, message.sha);
          }
        } catch (e) {
          fail(e);
        }
      }),
    ];
    webviewPanel.onDidDispose(() => {
      clearTimeout(timer);
      subscriptions.forEach((s) => s.dispose());
    });
  }
}

function register(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new RebaseEditorProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('gitCompass.rebase.openAsText', (uri) =>
      openAsText(uri).catch((e) => vscode.window.showErrorMessage(`Git Compass: ${e.message}`))
    )
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
  body { margin: 0; padding: 14px 18px 80px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.2em; font-weight: 600; margin: 0 0 4px; }
  #summary { color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  #warn { display: none; margin-bottom: 10px; padding: 6px 10px; border-radius: 3px; color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
  #list { display: flex; flex-direction: column; gap: 2px; }
  .row { display: grid; grid-template-columns: 18px 96px 76px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 4px 8px; border-radius: 3px; border: 1px solid transparent; outline: none; cursor: default; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected { background: var(--vscode-list-inactiveSelectionBackground); }
  .row:focus { border-color: var(--vscode-focusBorder); }
  .row.drop-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .row.drop-after { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
  .row.dragging { opacity: .4; }
  .row.meld { margin-left: 22px; }
  .row.drop .subject, .row.drop .sha { text-decoration: line-through; opacity: .6; }
  .handle { cursor: grab; color: var(--vscode-descriptionForeground); user-select: none; text-align: center; letter-spacing: -2px; }
  select { font: inherit; padding: 2px 4px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px; }
  .badge { font-size: .85em; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); padding: 1px 6px; border-radius: 8px; justify-self: start; }
  .sha { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); cursor: pointer; background: none; border: 0; padding: 0; text-align: left; font-size: inherit; }
  .sha:hover { text-decoration: underline; }
  .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: .92em; }
  .act-pick .accent, .act-reword .accent, .act-edit .accent { }
  .row.commit { border-left: 3px solid transparent; }
  .row.act-pick { border-left-color: var(--vscode-charts-blue); }
  .row.act-reword { border-left-color: var(--vscode-charts-purple); }
  .row.act-edit { border-left-color: var(--vscode-charts-orange); }
  .row.act-squash, .row.act-fixup { border-left-color: var(--vscode-charts-yellow); }
  .row.act-drop { border-left-color: var(--vscode-charts-red); }
  footer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 18px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35)); }
  footer .spacer { flex: 1; }
  button.primary, button.secondary { font: inherit; padding: 4px 14px; border-radius: 2px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .link { color: var(--vscode-textLink-foreground); background: none; border: 0; cursor: pointer; font: inherit; padding: 0; }
  .keys { color: var(--vscode-descriptionForeground); font-size: .9em; }
  kbd { font-family: var(--vscode-editor-font-family); padding: 0 4px; border-radius: 3px; border: 1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,.5)); background: var(--vscode-keybindingLabel-background); color: var(--vscode-keybindingLabel-foreground); }
  .empty { color: var(--vscode-descriptionForeground); padding: 18px 0; }
</style>
</head>
<body>
<h1 id="header">Interactive rebase</h1>
<div id="summary"></div>
<div id="warn"></div>
<div id="list" role="listbox" aria-label="Rebase steps"></div>
<footer>
  <span class="keys"><kbd>p</kbd> pick <kbd>r</kbd> reword <kbd>e</kbd> edit <kbd>s</kbd> squash <kbd>f</kbd> fixup <kbd>d</kbd> drop &nbsp; <kbd>Alt</kbd>+<kbd>&uarr;</kbd>/<kbd>&darr;</kbd> move</span>
  <span class="spacer"></span>
  <button class="link" id="text">Open as Text</button>
  <button class="secondary" id="abort">Abort</button>
  <button class="primary" id="start">Start Rebase</button>
</footer>
<script nonce="${nonce}">
(function () {
  var vscode = acquireVsCodeApi();
  var COMMIT = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
  var LABEL = { pick: 'Pick', reword: 'Reword', edit: 'Edit', squash: 'Squash', fixup: 'Fixup', drop: 'Drop' };
  var KEYS = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
  var entries = [];
  var info = {};
  var selected = 0;
  var dragFrom = -1;
  var listEl = document.getElementById('list');
  var headerEl = document.getElementById('header');
  var summaryEl = document.getElementById('summary');
  var warnEl = document.getElementById('warn');

  function isCommit(e) { return COMMIT.indexOf(e.origAction) !== -1; }
  function send() { vscode.postMessage({ type: 'update', entries: entries }); }

  function lookup(sha) {
    if (!sha) return null;
    var s = sha.toLowerCase();
    for (var k in info) { if (k.indexOf(s) === 0) return info[k]; }
    return null;
  }

  function el(name, cls, text, parent) {
    var e = document.createElement(name);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  function setAction(i, action) {
    var e = entries[i];
    if (!e || !isCommit(e) || e.action === action) return;
    e.action = action;
    if (action !== 'fixup') e.flag = '';
    render(true);
    send();
  }

  function move(from, to) {
    if (from < 0 || to < 0 || to >= entries.length || from === to) return;
    var item = entries.splice(from, 1)[0];
    entries.splice(to, 0, item);
    selected = to;
    render(true);
    send();
  }

  function select(i, focus) {
    if (!entries.length) return;
    selected = Math.max(0, Math.min(entries.length - 1, i));
    var rows = listEl.children;
    for (var r = 0; r < rows.length; r++) rows[r].classList.toggle('selected', r === selected);
    if (focus && rows[selected]) rows[selected].focus();
  }

  function clearDrop() {
    listEl.querySelectorAll('.drop-before, .drop-after').forEach(function (r) { r.classList.remove('drop-before', 'drop-after'); });
  }

  function summarize() {
    var counts = {};
    var commits = 0;
    entries.forEach(function (e) {
      if (!isCommit(e)) return;
      commits++;
      counts[e.action] = (counts[e.action] || 0) + 1;
    });
    var parts = COMMIT.filter(function (a) { return counts[a]; }).map(function (a) { return counts[a] + ' ' + a; });
    summaryEl.textContent = commits + (commits === 1 ? ' commit' : ' commits') + (parts.length ? ' \\u00b7 ' + parts.join(', ') : '');
    var firstCommit = entries.filter(isCommit)[0];
    var warnings = [];
    if (firstCommit && (firstCommit.action === 'squash' || firstCommit.action === 'fixup')) warnings.push('The first commit cannot be squashed or fixed up: there is no earlier commit to combine it with.');
    if (commits && !entries.some(function (e) { return isCommit(e) && e.action !== 'drop'; })) warnings.push('Every commit is dropped. Starting the rebase will remove them all.');
    warnEl.textContent = warnings.join(' ');
    warnEl.style.display = warnings.length ? 'block' : 'none';
  }

  function render(keepFocus) {
    var hadFocus = keepFocus || listEl.contains(document.activeElement);
    listEl.textContent = '';
    if (!entries.length) {
      el('div', 'empty', 'Nothing to do. Starting will finish the rebase without changes; Abort cancels it.', listEl);
      summarize();
      return;
    }
    if (selected >= entries.length) selected = entries.length - 1;
    var prevCommit = false;
    entries.forEach(function (e, i) {
      var commit = isCommit(e);
      var row = el('div', 'row ' + (commit ? 'commit act-' + e.action : 'other'), null, listEl);
      if (commit && (e.action === 'squash' || e.action === 'fixup') && prevCommit) row.classList.add('meld');
      if (commit && e.action === 'drop') row.classList.add('drop');
      if (commit) prevCommit = true;
      if (i === selected) row.classList.add('selected');
      row.tabIndex = 0;
      row.draggable = true;
      row.setAttribute('role', 'option');
      el('span', 'handle', '\\u22ee\\u22ee', row).title = 'Drag to reorder';
      if (commit) {
        var sel = el('select', null, null, row);
        sel.setAttribute('aria-label', 'Action');
        COMMIT.forEach(function (a) {
          var o = el('option', null, LABEL[a], sel);
          o.value = a;
          if (a === e.action) o.selected = true;
        });
        sel.addEventListener('change', function () { setAction(i, sel.value); });
        var c = lookup(e.sha);
        var shaBtn = el('button', 'sha', e.sha.slice(0, 9), row);
        shaBtn.title = 'Show commit ' + e.sha;
        shaBtn.addEventListener('click', function (ev) { ev.stopPropagation(); vscode.postMessage({ type: 'show', sha: e.sha }); });
        var subject = el('span', 'subject', (c && c.subject) || e.subject || '(no message)', row);
        subject.title = subject.textContent;
        el('span', 'meta', c ? c.author + ' \\u00b7 ' + c.date : '', row);
      } else {
        el('span', 'badge', e.action === 'unknown' ? 'line' : e.action, row);
        el('span', null, '', row);
        var text = el('span', 'subject', e.action === 'unknown' ? e.raw.trim() : e.arg, row);
        text.title = text.textContent;
        el('span', 'meta', '', row);
      }
      row.addEventListener('mousedown', function (ev) { if (ev.target.tagName !== 'SELECT' && ev.target.tagName !== 'BUTTON') select(i, false); });
      row.addEventListener('focus', function () { select(i, false); });
      row.addEventListener('dragstart', function (ev) {
        dragFrom = i;
        row.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', String(i));
      });
      row.addEventListener('dragend', function () { row.classList.remove('dragging'); clearDrop(); dragFrom = -1; });
      row.addEventListener('dragover', function (ev) {
        if (dragFrom === -1) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        var after = ev.offsetY > row.offsetHeight / 2;
        clearDrop();
        row.classList.add(after ? 'drop-after' : 'drop-before');
      });
      row.addEventListener('drop', function (ev) {
        ev.preventDefault();
        if (dragFrom === -1) return;
        var after = row.classList.contains('drop-after');
        clearDrop();
        var to = i + (after ? 1 : 0);
        if (dragFrom < to) to--;
        var from = dragFrom;
        dragFrom = -1;
        move(from, to);
      });
    });
    summarize();
    if (hadFocus) select(selected, true);
  }

  document.addEventListener('keydown', function (ev) {
    var tag = ev.target && ev.target.tagName;
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      move(selected, selected + (ev.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (tag === 'SELECT' || tag === 'BUTTON' || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      select(selected + (ev.key === 'ArrowUp' ? -1 : 1), true);
      return;
    }
    var action = KEYS[ev.key.toLowerCase()];
    if (action) {
      ev.preventDefault();
      setAction(selected, action);
    }
  });

  document.getElementById('start').addEventListener('click', function () { vscode.postMessage({ type: 'start' }); });
  document.getElementById('abort').addEventListener('click', function () { vscode.postMessage({ type: 'abort' }); });
  document.getElementById('text').addEventListener('click', function () { vscode.postMessage({ type: 'text' }); });

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg.type !== 'state') return;
    headerEl.textContent = msg.header || 'Interactive rebase';
    entries = msg.entries || [];
    info = msg.info || {};
    render(false);
  });

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

module.exports = { register, parseTodo, serializeTodo, sanitizeEntries, parseHeader, commitInfo, html, VIEW_TYPE };

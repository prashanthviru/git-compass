const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const g = require('./git');

// Who owns this code: the CODEOWNERS rule for a file or folder, who wrote the lines
// that are there today (blame), and who has committed to it most, overall and recently.

const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'];
const RECENT_DAYS = 90;

function parseCodeowners(text) {
  const rules = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/(^|\s)#.*$/, '').trim();
      // GitLab sections ("[Docs]" or "^[Docs] @team") apply their default owners below them; skip the header.
      if (!line || /^\^?\[[^\]]+\]/.test(line)) return;
      const [pattern, ...owners] = line.split(/\s+/);
      rules.push({ pattern, owners, line: i + 1 });
    });
  return rules;
}

function escapeRe(c) {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

// CODEOWNERS uses gitignore-style patterns, with GitHub's rule that "dir/*" does not reach subfolders.
function patternRegExp(pattern) {
  let p = pattern;
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const shallow = p.endsWith('/*');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += escapeRe(c);
  }
  const suffix = shallow ? '$' : dirOnly ? '/.*$' : '(?:/.*)?$';
  return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${re}${suffix}`);
}

function codeownersMatch(pattern, rel, isDir = false) {
  try {
    const re = patternRegExp(pattern);
    return re.test(rel) || (isDir && re.test(`${rel}/`)) || (isDir && re.test(`${rel}/x`));
  } catch {
    return false;
  }
}

// The last matching rule wins, as on GitHub and GitLab.
function ownersFor(rules, rel, isDir = false) {
  let found;
  for (const rule of rules) if (codeownersMatch(rule.pattern, rel, isDir)) found = rule;
  return found;
}

function readCodeowners(root) {
  for (const rel of CODEOWNERS_PATHS) {
    try {
      return { file: rel, rules: parseCodeowners(fs.readFileSync(path.join(root, rel), 'utf8')) };
    } catch {
      // try the next location
    }
  }
  return undefined;
}

function parseShortlog(out) {
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\t(.*?)\s*(?:<([^>]*)>)?$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ commits: Number(m[1]), name: m[2], email: m[3] || '' }));
}

function blameShares(out) {
  const counts = new Map();
  let total = 0;
  let author;
  let email;
  for (const line of out.split('\n')) {
    if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('author-mail ')) email = line.slice(12).replace(/^<|>$/g, '');
    else if (line.startsWith('\t')) {
      const key = `${author}\0${email}`;
      counts.set(key, (counts.get(key) || 0) + 1);
      total += 1;
    }
  }
  return [...counts]
    .map(([key, lines]) => {
      const [name, mail] = key.split('\0');
      return { name, email: mail, lines, share: total ? lines / total : 0 };
    })
    .sort((a, b) => b.lines - a.lines);
}

async function ownership(root, rel, isDir) {
  const spec = rel || '.';
  const [all, recent, blame] = await Promise.all([
    g.git(root, ['shortlog', '-sne', '--no-merges', 'HEAD', '--', spec]).then(parseShortlog),
    g.git(root, ['shortlog', '-sne', '--no-merges', `--since=${RECENT_DAYS}.days`, 'HEAD', '--', spec]).then(parseShortlog),
    isDir ? Promise.resolve([]) : g.git(root, ['blame', '--line-porcelain', '-w', 'HEAD', '--', rel]).then(blameShares).catch(() => []),
  ]);
  const co = readCodeowners(root);
  const rule = co ? ownersFor(co.rules, rel, isDir) : undefined;
  const recentBy = new Map(recent.map((r) => [r.email.toLowerCase() || r.name, r.commits]));
  return {
    codeowners: co ? { file: co.file, rule } : undefined,
    contributors: all.map((c) => ({ ...c, recent: recentBy.get(c.email.toLowerCase() || c.name) || 0 })),
    blame,
  };
}

function target(arg) {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  if (uri?.scheme === 'file') {
    let isDir = false;
    try {
      isDir = fs.statSync(uri.fsPath).isDirectory();
    } catch {
      // deleted file: treat as a file
    }
    const repo = g.repoForUri(uri);
    if (repo) {
      const root = repo.rootUri.fsPath;
      return { root, rel: g.toRel(root, uri.fsPath), isDir };
    }
  }
  const t = g.targetFile(arg);
  return { root: t.root, rel: t.rel, isDir: false };
}

async function showOwnership(arg) {
  const { root, rel, isDir } = target(arg);
  const name = rel ? path.posix.basename(rel) : path.basename(root);
  const info = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Finding owners of ${name}…` }, () => ownership(root, rel, isDir));
  const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const items = [];
  if (info.codeowners?.rule) {
    const r = info.codeowners.rule;
    items.push(sep(`Code owners · ${info.codeowners.file} line ${r.line}: ${r.pattern}`));
    if (!r.owners.length) items.push({ label: '$(circle-slash) No owners', description: 'This rule removes ownership for these paths' });
    for (const owner of r.owners) items.push({ label: `$(shield) ${owner}`, copy: owner });
  } else {
    items.push(sep('Code owners'));
    items.push({ label: info.codeowners ? `$(info) No rule in ${info.codeowners.file} matches ${name}` : '$(info) This repository has no CODEOWNERS file' });
  }
  if (info.blame.length) {
    items.push(sep('Wrote the lines in this file today'));
    for (const b of info.blame.slice(0, 5)) items.push({ label: `$(account) ${b.name}`, description: `${Math.round(b.share * 100)}% · ${b.lines} line${b.lines === 1 ? '' : 's'}`, detail: b.email, copy: b.email ? `${b.name} <${b.email}>` : b.name });
  }
  items.push(sep('Most commits'));
  if (!info.contributors.length) items.push({ label: '$(info) No commits yet' });
  for (const c of info.contributors.slice(0, 10)) {
    items.push({ label: `$(person) ${c.name}`, description: `${c.commits} commit${c.commits === 1 ? '' : 's'}${c.recent ? ` · ${c.recent} in the last ${RECENT_DAYS} days` : ''}`, detail: c.email, copy: c.email ? `${c.name} <${c.email}>` : c.name });
  }
  const pick = await vscode.window.showQuickPick(items, { title: `Owners of ${rel || name}`, placeHolder: 'Pick someone to copy their handle or email', matchOnDescription: true, matchOnDetail: true });
  if (pick?.copy) {
    await vscode.env.clipboard.writeText(pick.copy);
    vscode.window.setStatusBarMessage(`Copied ${pick.copy}`, 3000);
  }
  return info;
}

// CODEOWNERS owners for a set of changed files, for suggesting reviewers.
function suggestedReviewers(root, files) {
  const co = readCodeowners(root);
  if (!co) return [];
  const owners = new Set();
  for (const f of files) for (const o of ownersFor(co.rules, f)?.owners || []) owners.add(o);
  return [...owners];
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitCompass.showOwnership', async (arg) => {
      try {
        await g.getGitApi();
        return await showOwnership(arg);
      } catch (e) {
        vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
        return undefined;
      }
    })
  );
}

module.exports = { register, parseCodeowners, patternRegExp, codeownersMatch, ownersFor, readCodeowners, parseShortlog, blameShares, ownership, showOwnership, suggestedReviewers };

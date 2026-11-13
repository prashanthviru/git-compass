const vscode = require('vscode');
const g = require('./git');

// Checks that run before Git Compass pushes a branch: secrets, conflict markers and
// debug code in the lines you added, very large files, commits made as the wrong person,
// fixup/WIP commits, and (optionally) a missing ticket reference in commit messages.

const SECRET_RULES = [
  { label: 'private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { label: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { label: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'Stripe live key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { label: 'API key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
];
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/;
const DEFAULT_DEBUG_PATTERNS = [
  'console\\.log\\(',
  '^\\s*debugger;?\\s*$',
  '\\b(?:describe|it|test)\\.only\\(',
  '(?<![.\\w])(?:fdescribe|fit)\\(',
  '\\bbinding\\.pry\\b',
  '\\bvar_dump\\(',
  '\\bpdb\\.set_trace\\(\\)|^\\s*breakpoint\\(\\)',
];
const NO_DEBUG_CHECK = /\.(?:md|mdx|markdown|txt|rst|adoc|lock|snap|svg|map)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|CHANGELOG[^/]*)$|\.min\.[a-z]+$/i;
const WIP_SUBJECT = /^(?:fixup!|squash!|amend!)|^wip\b/i;
const MAX_FINDINGS = 200;

function compile(patterns) {
  const out = [];
  for (const p of patterns || []) {
    try {
      out.push({ source: p, re: new RegExp(p) });
    } catch {
      // An invalid pattern in settings is skipped rather than blocking every push.
    }
  }
  return out;
}

// Added lines of a unified diff (git diff -U0), with their file and new line number.
function* addedLines(diff) {
  let file;
  let line = 0;
  for (const raw of String(diff).split('\n')) {
    if (raw.startsWith('+++ ')) {
      const name = raw.slice(4);
      file = name === '/dev/null' ? undefined : name.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      yield { file, line, text: raw.slice(1) };
      line += 1;
    } else if (raw.startsWith(' ')) {
      line += 1;
    }
  }
}

function scanDiff(diff, { debugPatterns = DEFAULT_DEBUG_PATTERNS } = {}) {
  const debug = compile(debugPatterns);
  const findings = [];
  for (const { file, line, text } of addedLines(diff)) {
    if (findings.length >= MAX_FINDINGS) break;
    const where = `${file}:${line}`;
    const secret = SECRET_RULES.find((r) => r.re.test(text));
    if (secret) {
      findings.push({ kind: 'secret', file, line, text: `Possible ${secret.label} in ${where}` });
      continue;
    }
    if (CONFLICT_MARKER.test(text)) {
      findings.push({ kind: 'conflict', file, line, text: `Leftover conflict marker in ${where}` });
      continue;
    }
    if (NO_DEBUG_CHECK.test(file)) continue;
    const hit = debug.find((d) => d.re.test(text));
    if (hit) findings.push({ kind: 'debug', file, line, text: `Debug code in ${where}: ${text.trim().slice(0, 80)}` });
  }
  return findings;
}

function checkCommits(commits, { expectedEmail, ticketPattern } = {}) {
  const findings = [];
  let ticket;
  if (ticketPattern) {
    try {
      ticket = new RegExp(ticketPattern);
    } catch {
      ticket = undefined;
    }
  }
  for (const c of commits) {
    const label = `${c.short} "${c.subject}"`;
    if (expectedEmail && c.email && c.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      findings.push({ kind: 'identity', hash: c.hash, text: `${label} was committed as ${c.email}, but this repository's identity rule expects ${expectedEmail}` });
    }
    if (WIP_SUBJECT.test(c.subject || '')) findings.push({ kind: 'wip', hash: c.hash, text: `${label} looks like a fixup or work-in-progress commit` });
    if (ticket && !ticket.test(`${c.subject}\n${c.body || ''}`)) findings.push({ kind: 'ticket', hash: c.hash, text: `${label} has no ticket reference (${ticketPattern})` });
  }
  return findings;
}

function checkSizes(entries, maxKB) {
  if (!maxKB) return [];
  return entries.filter((e) => e.size > maxKB * 1024).map((e) => ({ kind: 'size', file: e.path, text: `${e.path} is ${(e.size / 1024 / 1024).toFixed(1)} MB (limit ${maxKB >= 1024 ? `${(maxKB / 1024).toFixed(1)} MB` : `${maxKB} KB`})` }));
}

// The commit the push starts from: where origin's copy of the branch, or the base branch, meets HEAD.
async function pushBase(root, branch) {
  const candidates = [];
  if (branch) candidates.push([`refs/remotes/origin/${branch}`, `origin/${branch}`]);
  const base = (await g.resolveBases(root))[0];
  if (base) candidates.push([base, g.shortRef(base)]);
  for (const [ref, label] of candidates) {
    if (!(await g.refExists(root, ref))) continue;
    const mb = (await g.git(root, ['merge-base', ref, 'HEAD']).catch(() => '')).trim();
    if (mb) return { from: mb, label };
  }
  return undefined;
}

async function expectedIdentity(root) {
  try {
    const identities = require('./identities');
    const url = (await g.git(root, ['remote', 'get-url', 'origin'])).trim();
    return identities.matchIdentity(identities.identities(), url);
  } catch {
    return undefined;
  }
}

async function runChecks(root, branch) {
  const cfg = g.config();
  const start = await pushBase(root, branch);
  const range = start ? `${start.from}..HEAD` : 'HEAD';
  const [commits, diff, expected] = await Promise.all([
    g.logCommits(root, ['--no-merges', '-n200', range, '--']),
    start ? g.git(root, ['diff', '--no-ext-diff', '--no-color', '-U0', start.from, 'HEAD']) : g.git(root, ['show', '--no-ext-diff', '--no-color', '-U0', '--format=', 'HEAD']).catch(() => ''),
    expectedIdentity(root),
  ]);
  const findings = [
    ...scanDiff(diff, { debugPatterns: cfg.get('prePush.debugPatterns', DEFAULT_DEBUG_PATTERNS) }),
    ...checkCommits(commits, { expectedEmail: expected?.email, ticketPattern: cfg.get('prePush.ticketPattern', '') }),
  ];
  const maxKB = cfg.get('prePush.maxFileSizeKB', 5120);
  if (maxKB && start) {
    const changed = new Set((await g.git(root, ['diff', '--name-only', '-z', '--diff-filter=AM', start.from, 'HEAD'])).split('\0').filter(Boolean));
    if (changed.size) {
      const entries = (await g.git(root, ['ls-tree', '-r', '-l', '-z', 'HEAD']))
        .split('\0')
        .map((rec) => /^\d+ blob \w+\s+(\d+)\t(.*)$/s.exec(rec))
        .filter((m) => m && changed.has(m[2]))
        .map((m) => ({ path: m[2], size: Number(m[1]) }));
      findings.push(...checkSizes(entries, maxKB));
    }
  }
  return { findings, commits: commits.length, against: start?.label };
}

const KIND_TITLES = {
  secret: 'Possible secrets',
  conflict: 'Conflict markers',
  debug: 'Debug code',
  size: 'Large files',
  identity: 'Committed as someone else',
  wip: 'Fixup and WIP commits',
  ticket: 'Missing ticket reference',
};

function report(branch, result) {
  const lines = [`# Pre-push checks for ${branch || 'HEAD'}`, '', `${result.commits} commit${result.commits === 1 ? '' : 's'} checked${result.against ? ` against ${result.against}` : ''}.`, ''];
  if (!result.findings.length) lines.push('No problems found.');
  for (const [kind, title] of Object.entries(KIND_TITLES)) {
    const items = result.findings.filter((f) => f.kind === kind);
    if (!items.length) continue;
    lines.push(`## ${title} (${items.length})`, '', ...items.map((f) => `- ${f.text}`), '');
  }
  lines.push('', 'Change these checks with the `gitCompass.prePush.*` settings.');
  return lines.join('\n');
}

async function showReport(branch, result) {
  const doc = await vscode.workspace.openTextDocument({ content: report(branch, result), language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function summary(findings, max = 8) {
  const shown = findings.slice(0, max).map((f) => `• ${f.text}`);
  if (findings.length > max) shown.push(`…and ${findings.length - max} more`);
  return shown.join('\n');
}

// Returns true when the push should go ahead.
async function gate(root, branch) {
  if (!g.config().get('prePush.enabled', true)) return true;
  let result;
  try {
    result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking commits before push…' }, () => runChecks(root, branch));
  } catch {
    return true;
  }
  if (!result.findings.length) return true;
  const n = result.findings.length;
  const pick = await vscode.window.showWarningMessage(
    `Before you push ${branch}: ${n} thing${n === 1 ? '' : 's'} to check`,
    { modal: true, detail: `${summary(result.findings)}\n\nTurn these checks off with gitCompass.prePush.enabled.` },
    'Push Anyway',
    'Show Details'
  );
  if (pick === 'Show Details') await showReport(branch, result);
  return pick === 'Push Anyway';
}

async function checkNow() {
  const root = g.requireRepo();
  const branch = (await g.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking commits before push…' }, () => runChecks(root, branch));
  if (!result.findings.length) {
    vscode.window.showInformationMessage(`Pre-push checks: ${result.commits} commit${result.commits === 1 ? '' : 's'} checked${result.against ? ` against ${result.against}` : ''}, no problems found.`);
    return result;
  }
  await showReport(branch, result);
  return result;
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitCompass.prePush.check', async () => {
      try {
        await g.getGitApi();
        await checkNow();
      } catch (e) {
        vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
      }
    })
  );
}

module.exports = { register, gate, runChecks, checkNow, scanDiff, checkCommits, checkSizes, addedLines, report, DEFAULT_DEBUG_PATTERNS };

// Git identities: switch who you commit as (user.name / user.email), which GitHub account
// pushes (gh auth switch) and which SSH key is used, per repository or globally.
// Nothing secret is stored: identities hold names, emails, a GitHub login and a key path.

const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const g = require('./git');

const SETTING = 'identities';
const DISMISSED = 'gitCompass.identity.dismissed';

let statusItem;
let refreshTimer;
let refreshToken = 0;
let workspaceState;
let ghCache = { at: 0, value: undefined };
const prompted = new Set();

function identities() {
  const list = g.config().get(SETTING, []);
  return Array.isArray(list) ? list.filter((i) => i && i.name && i.email).map(normalize) : [];
}

function normalize(i) {
  return {
    label: String(i.label || i.name).trim(),
    name: String(i.name).trim(),
    email: String(i.email).trim(),
    githubAccount: i.githubAccount ? String(i.githubAccount).trim() : undefined,
    sshKey: i.sshKey ? String(i.sshKey).trim() : undefined,
    match: Array.isArray(i.match) ? i.match.map((m) => String(m).trim()).filter(Boolean) : [],
  };
}

function saveIdentities(list) {
  return g.config().update(SETTING, list, vscode.ConfigurationTarget.Global);
}

// "github.com/owner/repo" from https, ssh and scp-style remote URLs, lower-cased.
function remoteKey(url) {
  const text = String(url || '').trim();
  if (/^[\w+.-]+:\/\//.test(text)) {
    try {
      const u = new URL(text);
      const repoPath = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
      return u.hostname && repoPath ? `${u.hostname}/${repoPath}`.toLowerCase() : '';
    } catch {
      return '';
    }
  }
  const m = /^(?:[^@/]+@)?([^/:]+):\/?(.+?)(?:\.git)?\/?$/.exec(text);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
}

// The identity whose rule matches this remote. Longer (more specific) rules win.
function matchIdentity(list, remoteUrl) {
  const key = remoteKey(remoteUrl);
  if (!key) return undefined;
  let best;
  for (const identity of list) {
    for (const rule of identity.match) {
      const r = rule.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/:/, '/').replace(/\.git$/, '');
      if (r && (key === r.replace(/\/$/, '') || key.startsWith(r.endsWith('/') ? r : `${r}/`)) && (!best || r.length > best.len)) {
        best = { identity, len: r.length };
      }
    }
  }
  return best?.identity;
}

// Accounts from `gh auth status`, e.g. [{ host: 'github.com', user: 'ann', active: true }].
function parseGhAccounts(text) {
  const out = [];
  let last;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /Logged in to (\S+) account (\S+)/.exec(line) || /Logged in to (\S+) as (\S+)/.exec(line);
    if (m) {
      last = { host: m[1], user: m[2], active: false };
      out.push(last);
    } else if (last && /Active account:\s*true/i.test(line)) {
      last.active = true;
    }
  }
  if (out.length === 1 && !/Active account:/i.test(text)) out[0].active = true;
  return out;
}

// core.sshCommand that uses one key only. Forward slashes work for Git's ssh on Windows too.
function sshCommandFor(keyPath) {
  const p = String(keyPath).replace(/^~(?=[/\\]|$)/, os.homedir()).replace(/\\/g, '/');
  return `ssh -i '${p.replace(/'/g, "'\\''")}' -o IdentitiesOnly=yes`;
}

function run(cmd, args, cwd, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: 15000, env: env ? { ...process.env, ...env } : undefined }, (err, stdout, stderr) =>
      resolve({ ok: !err, missing: err?.code === 'ENOENT', stdout: stdout || '', out: `${stdout || ''}${stderr || ''}` })
    );
  });
}

// Name and commit email choices for a signed-in GitHub account, read with that account's own
// gh token. The token only goes to the child gh process; it is never shown or stored.
async function githubProfile(login) {
  const token = (await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', login], os.homedir())).stdout.trim();
  if (!token) throw new Error(`The GitHub CLI has no token for ${login}. Sign in again with gh auth login.`);
  const env = { GH_TOKEN: token };
  const userRes = await run('gh', ['api', 'user'], os.homedir(), env);
  if (!userRes.ok) throw new Error(`Could not read the GitHub profile for ${login}.`);
  const user = JSON.parse(userRes.stdout);
  const emails = [];
  const listRes = await run('gh', ['api', 'user/emails'], os.homedir(), env);
  if (listRes.ok) {
    try {
      for (const e of JSON.parse(listRes.stdout)) if (e.verified && e.email) emails.push({ email: e.email, primary: !!e.primary });
    } catch {
      // The token may lack the user:email scope; the public and noreply addresses still work.
    }
  }
  if (user.email && !emails.some((e) => e.email === user.email)) emails.push({ email: user.email, primary: !emails.length });
  emails.sort((a, b) => Number(b.primary) - Number(a.primary));
  const noreply = `${user.id}+${user.login}@users.noreply.github.com`;
  return { login: user.login, name: user.name || user.login, emails: emails.map((e) => e.email), noreply };
}

async function useGithubAccount(root, account, current) {
  const profile = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reading GitHub profile for ${account.user}…` },
    () => githubProfile(account.user)
  );
  const globalEmail = await readConfig(root, 'user.email', 'global');
  const options = [];
  const seen = new Set();
  const add = (email, description) => {
    if (!email || seen.has(email.toLowerCase())) return;
    // Never offer another GitHub account's private no-reply address: commits would be credited to that account.
    const noreplyOwner = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];
    if (noreplyOwner && noreplyOwner.toLowerCase() !== profile.login.toLowerCase()) return;
    seen.add(email.toLowerCase());
    options.push({ label: email, description, email });
  };
  profile.emails.forEach((email, i) => add(email, i === 0 ? 'primary GitHub email' : 'GitHub email'));
  add(current.email, 'used in this repository now');
  add(globalEmail, 'your global git email');
  add(profile.noreply, 'GitHub private address, keeps your email hidden');
  options.push({ label: '$(edit) Enter another email…', other: true });
  const pick = await vscode.window.showQuickPick(options, {
    title: `Commit as ${profile.name} (${profile.login}) with which email?`,
    placeHolder: profile.emails.length ? undefined : 'Tip: run "gh auth refresh -s user:email" to list your GitHub emails here',
  });
  if (!pick) return;
  if (pick.other) {
    const typed = await vscode.window.showInputBox({
      title: `Email for ${profile.login}`,
      placeHolder: 'you@example.com',
      validateInput: (v) => (/^[^\s@]+@[^\s@]+$/.test(v.trim()) ? undefined : 'Enter an email address'),
    });
    if (!typed) return;
    pick.email = typed.trim();
  }
  const identity = normalize({
    label: profile.login,
    name: profile.name,
    email: pick.email,
    githubAccount: profile.login,
    // Repositories owned by this account are suggested for it automatically.
    match: [`github.com/${profile.login.toLowerCase()}/`],
  });
  const scope = await pickScope(identity);
  if (!scope) return;
  const list = identities().filter((i) => (i.githubAccount || '').toLowerCase() !== profile.login.toLowerCase());
  await saveIdentities([...list, identity]);
  await use(root, identity, scope);
}

async function ghAccounts(force = false) {
  if (!force && ghCache.value && Date.now() - ghCache.at < 60e3) return ghCache.value;
  const r = await run('gh', ['auth', 'status'], os.homedir());
  const value = r.missing ? { missing: true, accounts: [] } : { missing: false, accounts: parseGhAccounts(r.out) };
  ghCache = { at: Date.now(), value };
  return value;
}

async function readConfig(root, key, scope) {
  const args = ['config'];
  if (scope) args.push(`--${scope}`);
  args.push('--get', key);
  return (await g.git(root, args).catch(() => '')).trim();
}

async function currentIdentity(root) {
  const [name, email, localEmail, localName, ssh, origin] = await Promise.all([
    readConfig(root, 'user.name'),
    readConfig(root, 'user.email'),
    readConfig(root, 'user.email', 'local'),
    readConfig(root, 'user.name', 'local'),
    readConfig(root, 'core.sshCommand', 'local'),
    readConfig(root, 'remote.origin.url'),
  ]);
  return { name, email, scope: localEmail || localName ? 'repository' : 'global', sshCommand: ssh, origin };
}

function sameIdentity(identity, current) {
  return !!identity && !!current.email && identity.email.toLowerCase() === current.email.toLowerCase() && identity.name === current.name;
}

async function applyIdentity(root, identity, scope = 'repository', { switchGithub = true } = {}) {
  const flag = scope === 'global' ? '--global' : '--local';
  await g.git(root, ['config', flag, 'user.name', identity.name]);
  await g.git(root, ['config', flag, 'user.email', identity.email]);
  const notes = [];
  if (scope !== 'global') {
    if (identity.sshKey) {
      await g.git(root, ['config', '--local', 'core.sshCommand', sshCommandFor(identity.sshKey)]);
      notes.push('SSH key set for this repository');
    } else {
      await g.git(root, ['config', '--local', '--unset', 'core.sshCommand']).catch(() => {});
    }
  }
  if (switchGithub && identity.githubAccount) {
    const gh = await ghAccounts(true);
    if (gh.missing) notes.push('GitHub CLI not installed, push account not switched');
    else if (!gh.accounts.some((a) => a.user.toLowerCase() === identity.githubAccount.toLowerCase())) {
      notes.push(`GitHub account ${identity.githubAccount} is not signed in to gh`);
    } else {
      const r = await run('gh', ['auth', 'switch', '--hostname', 'github.com', '--user', identity.githubAccount], root);
      notes.push(r.ok ? `pushing as ${identity.githubAccount} on GitHub` : `could not switch GitHub account: ${r.out.trim().split('\n').pop()}`);
      ghCache.at = 0;
    }
  }
  return notes;
}

async function refresh() {
  const token = ++refreshToken;
  if (!g.config().get('identity.statusBar.enabled', true)) return statusItem.hide();
  const repo = g.activeRepo();
  if (!repo) return statusItem.hide();
  const root = repo.rootUri.fsPath;
  const current = await currentIdentity(root);
  if (token !== refreshToken) return;
  const list = identities();
  const known = list.find((i) => sameIdentity(i, current));
  const rule = matchIdentity(list, current.origin);
  const mismatch = rule && !sameIdentity(rule, current);
  statusItem.text = `$(${mismatch ? 'warning' : 'account'}) ${known ? known.label : current.name || 'No git user'}`;
  statusItem.backgroundColor = mismatch || !current.email ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  const md = new vscode.MarkdownString('', true);
  md.appendMarkdown('**Committing as**  \n');
  md.appendText(current.email ? `${current.name} <${current.email}>` : 'No user.name / user.email set');
  md.appendMarkdown(`\n\n$(${current.scope === 'repository' ? 'repo' : 'globe'}) ${current.scope === 'repository' ? 'Set for this repository' : 'From your global git config'}`);
  if (current.sshCommand) md.appendMarkdown('\n\n$(key) Uses its own SSH key');
  const gh = await ghAccounts();
  if (token !== refreshToken) return;
  const active = gh.accounts.find((a) => a.active && a.host === 'github.com');
  if (active) md.appendMarkdown(`\n\n$(github) Pushing to GitHub as **${active.user}**`);
  if (mismatch) md.appendMarkdown(`\n\n$(warning) This repository's rule says **${rule.label}** (${rule.email}).`);
  md.appendMarkdown('\n\nClick to switch identity.');
  statusItem.tooltip = md;
  statusItem.show();
  if (mismatch) offerFix(root, rule, current);
}

function scheduleRefresh(delay = 300) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => statusItem?.hide()), delay);
}

async function offerFix(root, rule, current) {
  const key = `${root}\0${rule.email}`;
  const dismissed = workspaceState?.get(DISMISSED, []) || [];
  if (prompted.has(key) || dismissed.includes(key)) return;
  prompted.add(key);
  const pick = await vscode.window.showWarningMessage(
    `This repository commits as ${current.name || '(nobody)'}${current.email ? ` <${current.email}>` : ''}, but your rule says ${rule.label} <${rule.email}>.`,
    `Use ${rule.label}`,
    "Don't Ask for This Repository"
  );
  if (pick === `Use ${rule.label}`) await use(root, rule, 'repository');
  else if (pick) await workspaceState?.update(DISMISSED, [...dismissed, key]);
}

async function use(root, identity, scope) {
  const notes = await applyIdentity(root, identity, scope);
  vscode.window.showInformationMessage(
    `Committing as ${identity.name} <${identity.email}> ${scope === 'global' ? 'in all repositories' : 'in this repository'}${notes.length ? ` · ${notes.join(' · ')}` : ''}.`
  );
  scheduleRefresh(0);
  vscode.commands.executeCommand('gitCompass.refresh').then(undefined, () => {});
}

async function pickScope(identity) {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(repo) This repository', description: 'Recommended', scope: 'repository' },
      { label: '$(globe) All repositories', description: 'Sets your global git config', scope: 'global' },
    ],
    { title: `Use ${identity.label} for…` }
  );
  return pick?.scope;
}

async function switchIdentity() {
  const root = g.requireRepo();
  const [current, gh] = await Promise.all([currentIdentity(root), ghAccounts()]);
  const list = identities();
  const rule = matchIdentity(list, current.origin);
  const linked = new Set(list.map((i) => (i.githubAccount || '').toLowerCase()).filter(Boolean));
  const accounts = gh.accounts.filter((a) => a.host === 'github.com' && !linked.has(a.user.toLowerCase()));
  const items = [];
  if (list.length) items.push({ label: 'Your identities', kind: vscode.QuickPickItemKind.Separator });
  items.push(...list.map((identity) => ({
    label: `${sameIdentity(identity, current) ? '$(check)' : '$(account)'} ${identity.label}`,
    description: identity.email,
    detail: [
      identity.githubAccount && `$(github) ${identity.githubAccount}`,
      identity.sshKey && `$(key) ${path.basename(identity.sshKey)}`,
      rule === identity && '$(pin) Rule matches this repository',
    ]
      .filter(Boolean)
      .join('   '),
    identity,
  })));
  if (accounts.length) {
    // Every account already signed in to the GitHub CLI, ready to use without typing anything.
    items.push({ label: 'Signed-in GitHub accounts', kind: vscode.QuickPickItemKind.Separator });
    items.push(
      ...accounts.map((account) => ({
        label: `$(github) ${account.user}`,
        description: account.active ? 'pushing as this account now' : '',
        detail: 'Commit and push as this GitHub account',
        account,
      }))
    );
  }
  items.push(
    { label: 'More', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add identity…', action: 'add' },
    ...(current.email && !list.some((i) => sameIdentity(i, current)) ? [{ label: `$(save) Save current user as an identity`, description: `${current.name} <${current.email}>`, action: 'saveCurrent' }] : []),
    ...(gh.missing ? [] : [{ label: '$(github) Sign in to another GitHub account…', action: 'ghLogin' }]),
    ...(list.length ? [{ label: '$(trash) Remove identity…', action: 'remove' }] : []),
    { label: '$(gear) Edit identities in settings', action: 'settings' }
  );
  const pick = await vscode.window.showQuickPick(items, {
    title: `Git identity · committing as ${current.email ? `${current.name} <${current.email}>` : 'nobody yet'}`,
    placeHolder: list.length || accounts.length ? 'Choose who to commit as' : 'Add an identity to get started',
    matchOnDescription: true,
  });
  if (!pick) return;
  if (pick.identity) {
    const scope = await pickScope(pick.identity);
    if (scope) await use(root, pick.identity, scope);
  } else if (pick.account) await useGithubAccount(root, pick.account, current);
  else if (pick.action === 'add') await addIdentity(root, {});
  else if (pick.action === 'saveCurrent') await addIdentity(root, { name: current.name, email: current.email });
  else if (pick.action === 'ghLogin') ghLogin();
  else if (pick.action === 'remove') await removeIdentity();
  else if (pick.action === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', 'gitCompass.identities');
}

function sshKeys() {
  const dir = path.join(os.homedir(), '.ssh');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.pub') && fs.existsSync(path.join(dir, f.slice(0, -4))))
      .map((f) => path.join(dir, f.slice(0, -4)));
  } catch {
    return [];
  }
}

async function addIdentity(root, seed) {
  const current = await currentIdentity(root);
  const name = await vscode.window.showInputBox({ title: 'New identity (1/5) · Name used in commits', value: seed.name ?? current.name, validateInput: (v) => (v.trim() ? undefined : 'Enter a name') });
  if (name === undefined) return;
  const email = await vscode.window.showInputBox({
    title: 'New identity (2/5) · Email used in commits',
    value: seed.email ?? '',
    placeHolder: 'you@example.com',
    validateInput: (v) => (/^[^\s@]+@[^\s@]+$/.test(v.trim()) ? undefined : 'Enter an email address'),
  });
  if (email === undefined) return;
  const label = await vscode.window.showInputBox({ title: 'New identity (3/5) · Short label', prompt: 'Shown in the status bar, e.g. Personal or Work', value: /@(gmail|outlook|hotmail|yahoo|icloud|proton)/i.test(email) ? 'Personal' : 'Work' });
  if (label === undefined) return;

  const gh = await ghAccounts(true);
  let githubAccount;
  if (!gh.missing && gh.accounts.length) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(circle-slash) Don’t switch GitHub accounts', value: undefined },
        ...gh.accounts.filter((a) => a.host === 'github.com').map((a) => ({ label: `$(github) ${a.user}`, description: a.active ? 'active now' : '', value: a.user })),
      ],
      { title: 'New identity (4/5) · GitHub account to push with', placeHolder: 'Switching identity also switches the GitHub CLI to this account' }
    );
    if (!pick) return;
    githubAccount = pick.value;
  }

  const keys = sshKeys();
  let sshKey;
  const keyPick = await vscode.window.showQuickPick(
    [
      { label: '$(circle-slash) Use my normal SSH setup', value: undefined },
      ...keys.map((k) => ({ label: `$(key) ${path.basename(k)}`, description: k, value: k })),
      { label: '$(folder-opened) Choose a key file…', browse: true },
    ],
    { title: 'New identity (5/5) · SSH key for this identity (optional)', placeHolder: 'Only used for SSH remotes, and only in repositories you switch' }
  );
  if (!keyPick) return;
  if (keyPick.browse) {
    const uri = await vscode.window.showOpenDialog({ title: 'Choose a private SSH key', defaultUri: vscode.Uri.file(path.join(os.homedir(), '.ssh')), canSelectMany: false });
    if (uri?.[0]) sshKey = uri[0].fsPath;
  } else sshKey = keyPick.value;

  const origin = remoteKey(current.origin);
  const owner = origin ? origin.split('/').slice(0, 2).join('/') + '/' : '';
  const match = [];
  if (owner) {
    const rule = await vscode.window.showQuickPick(
      [
        { label: `$(pin) Suggest it for repositories under ${owner}`, value: owner },
        { label: '$(circle-slash) No automatic rule', value: undefined },
      ],
      { title: 'Automatic rule', placeHolder: 'Git Compass warns you when a matching repository commits as someone else' }
    );
    if (!rule) return;
    if (rule.value) match.push(rule.value);
  }

  const identity = normalize({ label, name, email, githubAccount, sshKey, match });
  const list = identities().filter((i) => i.label.toLowerCase() !== identity.label.toLowerCase());
  await saveIdentities([...list, identity]);
  const now = await vscode.window.showInformationMessage(`Saved identity ${identity.label}. Use it for this repository now?`, 'Use Here', 'Use Everywhere');
  if (now) await use(root, identity, now === 'Use Everywhere' ? 'global' : 'repository');
  else scheduleRefresh(0);
}

async function removeIdentity() {
  const list = identities();
  const pick = await vscode.window.showQuickPick(
    list.map((i) => ({ label: i.label, description: i.email, identity: i })),
    { title: 'Remove identity', placeHolder: 'Your git config is not changed' }
  );
  if (!pick) return;
  await saveIdentities(list.filter((i) => i !== pick.identity));
  scheduleRefresh(0);
}

function ghLogin() {
  const terminal = vscode.window.createTerminal({ name: 'GitHub sign-in' });
  terminal.show();
  terminal.sendText('gh auth login --hostname github.com --web && gh auth setup-git');
  vscode.window.showInformationMessage('Finish signing in in the terminal, then add or edit an identity to use the new account.');
}

function register(context) {
  workspaceState = context.workspaceState;
  statusItem = vscode.window.createStatusBarItem('gitCompass.identity', vscode.StatusBarAlignment.Left, 97);
  statusItem.name = 'Git Compass Identity';
  statusItem.command = 'gitCompass.identity.switch';
  const guard = (fn) => async (...args) => {
    try {
      await g.getGitApi();
      await fn(...args);
    } catch (e) {
      vscode.window.showErrorMessage(`Git Compass: ${e.message}`);
    }
  };
  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('gitCompass.identity.switch', guard(switchIdentity)),
    vscode.commands.registerCommand('gitCompass.identity.add', guard(() => addIdentity(g.requireRepo(), {}))),
    vscode.window.onDidChangeActiveTextEditor(() => scheduleRefresh()),
    vscode.window.onDidChangeWindowState((s) => s.focused && scheduleRefresh()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('gitCompass') && scheduleRefresh(0)),
    { dispose: () => clearTimeout(refreshTimer) }
  );
  g.getGitApi()
    .then((api) => api && g.onRepoChange(context, () => scheduleRefresh(), 500))
    .catch(() => {});
  scheduleRefresh(0);
}

module.exports = { register, githubProfile, identities, normalize, remoteKey, matchIdentity, parseGhAccounts, sshCommandFor, currentIdentity, applyIdentity, sameIdentity };

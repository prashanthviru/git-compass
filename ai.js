const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('./git');
const providers = require('./aiProviders');

const NOISE = [
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)**/pnpm-lock.yaml',
  ':(exclude)**/package-lock.json',
  ':(exclude)**/yarn.lock',
  ':(exclude)**/*.min.js',
  ':(exclude)**/dist/**',
];
const NOISE_PATH = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.min\.js$|(^|\/)dist\//;
const SEARCH_FLAGS = new Set(['-i', '--all-match', '--no-merges']);
const SEARCH_VALUE_FLAG = /^--(grep|author|since|until)=[^\0\r\n]+$/;
const PATHSPEC_MAGIC = /^:\((glob|icase|exclude|top|literal)(,(glob|icase|exclude|top|literal))*\)/;

const { CancelledError, AiNotConfiguredError } = providers;

function stripFences(text) {
  let t = text.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  if (/^(["'`]).*\1$/s.test(t) && !t.includes('\n')) t = t.slice(1, -1).trim();
  return t;
}

function stripNoiseFromDiff(diff) {
  const blocks = diff.split(/^(?=diff --git )/m);
  return blocks
    .filter((block) => {
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(block);
      return !m || !(NOISE_PATH.test(m[1]) || NOISE_PATH.test(m[2]));
    })
    .join('');
}

async function ask(title, instruction, context, root) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Git Compass AI: ${title}…`, cancellable: true },
    (_progress, token) => providers.complete({ prompt: instruction, context, token, cwd: root })
  );
}

function gh(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.code === 'ENOENT' ? 'Install the GitHub CLI (gh) and run gh auth login.' : (stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

function diffText(root, args) {
  return g.git(root, ['diff', '--no-color', '--no-ext-diff', ...args, '--', '.', ...NOISE]);
}

function showText(root, hash) {
  return g.git(root, ['show', '--no-color', '--no-ext-diff', '--stat', '--patch', '--format=fuller', hash, '--', '.', ...NOISE]);
}

async function workingChanges(root) {
  const [staged, unstaged, untracked] = await Promise.all([
    diffText(root, ['--cached']),
    diffText(root, []),
    g.git(root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const files = untracked.split('\n').filter(Boolean);
  const parts = [];
  if (staged.trim()) parts.push(`Staged changes:\n${staged}`);
  if (unstaged.trim()) parts.push(`Unstaged changes:\n${unstaged}`);
  if (files.length) parts.push(`New untracked files (contents not shown):\n${files.join('\n')}`);
  return parts.join('\n\n');
}

function repoFromArg(arg) {
  const uri = arg?.rootUri;
  if (uri) {
    const repo = g.repoForUri(uri);
    if (repo) return repo;
  }
  const repo = g.activeRepo();
  if (!repo) throw new Error('No git repository is open.');
  return repo;
}

async function showMarkdown(content, preview = true) {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
  if (preview) await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  return doc;
}

async function pickBase(root, title) {
  const bases = await g.resolveBases(root);
  const pick = await vscode.window.showQuickPick([...bases.map((b) => ({ label: b })), { label: 'Other branch or tag…', other: true }], { title });
  if (!pick) return undefined;
  return pick.other ? g.pickRef(root, title) : pick.label;
}

function commitList(commits, withBody) {
  return commits
    .map((c) => {
      const head = `- ${c.short} ${c.subject} (${c.author}, ${c.date})`;
      return withBody && c.body ? `${head}\n${c.body.replace(/^/gm, '    ')}` : head;
    })
    .join('\n');
}

async function generateCommitMessage(arg) {
  const repo = repoFromArg(arg);
  const root = repo.rootUri.fsPath;
  let diff = await diffText(root, ['--cached']);
  let scope = 'staged';
  if (!diff.trim()) {
    const all = await diffText(root, []);
    if (!all.trim()) {
      vscode.window.showInformationMessage('There are no changes to describe.');
      return;
    }
    const choice = await vscode.window.showInformationMessage('Nothing is staged. Write a message for all unstaged changes instead?', 'Use All Changes');
    if (!choice) return;
    diff = all;
    scope = 'unstaged';
  }
  const recent = (await g.git(root, ['log', '-15', '--no-merges', '--format=%s'])).trim();
  const message = stripFences(
    await ask(
      'Writing commit message',
      [
        `Write a git commit message for the ${scope} changes in the diff in the input.`,
        'Match the style of the recent commit subjects listed before the diff: conventional-commit type with a scope when it fits, imperative mood, subject line under 72 characters.',
        'Add a short body after a blank line only when the reason for the change is not obvious from the subject.',
        'Reply with the commit message only, with no quotes, code fences or commentary.',
      ].join(' '),
      `Recent commit subjects:\n${recent}\n\nDiff:\n${diff}`,
      root
    )
  );
  repo.inputBox.value = message;
  await vscode.commands.executeCommand('workbench.view.scm');
}

async function stashWithMessage(arg) {
  const repo = repoFromArg(arg);
  const root = repo.rootUri.fsPath;
  const changes = await workingChanges(root);
  if (!changes.trim()) {
    vscode.window.showInformationMessage('There are no changes to stash.');
    return;
  }
  const suggestion = stripFences(
    await ask(
      'Naming stash',
      'Write a short description, under 60 characters, of the uncommitted work in the input, suitable as a git stash message. Reply with the description only.',
      changes,
      root
    )
  ).split('\n')[0];
  const message = await vscode.window.showInputBox({ title: 'Stash Changes', prompt: 'Stash message (includes untracked files)', value: suggestion });
  if (!message?.trim()) return;
  await g.git(root, ['stash', 'push', '-u', '-m', message.trim()]);
  vscode.window.setStatusBarMessage(`Stashed: ${message.trim()}`, 4000);
  vscode.commands.executeCommand('gitCompass.refresh').then(undefined, () => {});
}

async function generateChangelog() {
  const root = g.requireRepo();
  const ref = await g.pickRef(root, 'Changelog for commits since…');
  if (!ref) return;
  const commits = await g.logCommits(root, ['--no-merges', '-n400', `${ref}..HEAD`, '--']);
  if (!commits.length) {
    vscode.window.showInformationMessage(`No commits since ${ref}.`);
    return;
  }
  const text = await ask(
    'Writing changelog',
    [
      `Write a release changelog in Markdown for the commits in the input (newest first), covering ${ref}..HEAD.`,
      `Start with the heading "# Changelog: ${ref}..HEAD".`,
      'Group entries under "## Features", "## Fixes" and "## Other", leaving out empty groups.',
      'Write one bullet per user-visible change in plain language, merge commits that describe the same change, and end each bullet with the short hash(es) in parentheses.',
      'Reply with the Markdown only.',
    ].join(' '),
    commitList(commits, true),
    root
  );
  await showMarkdown(stripFences(text));
}

function parsePrDraft(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first === -1) return { title: '', body: '' };
  const title = lines[first].replace(/^#+\s*/, '').trim();
  return { title, body: lines.slice(first + 1).join('\n').trim() };
}

async function createPrWithGh(root, branch, base, doc) {
  const baseName = g.shortRef(base);
  const { title, body } = parsePrDraft(doc.getText());
  if (!title) throw new Error('The draft needs a first line with the title.');
  const ok = await vscode.window.showWarningMessage(
    `Create a pull request from ${branch} into ${baseName}?`,
    { modal: true, detail: `Title: ${title}\n\nRuns gh pr create with the title and body from the open draft.` },
    'Create Pull Request'
  );
  if (ok !== 'Create Pull Request') return;
  let remoteSha = '';
  try {
    remoteSha = (await g.git(root, ['ls-remote', '--exit-code', '--heads', 'origin', branch])).split('\t')[0].trim();
  } catch {
    remoteSha = '';
  }
  if (!remoteSha) {
    vscode.window.showWarningMessage(`${branch} is not on origin yet. Push it first, then create the pull request again.`);
    return;
  }
  const localSha = (await g.git(root, ['rev-parse', 'HEAD'])).trim();
  if (remoteSha !== localSha) {
    const go = await vscode.window.showWarningMessage(
      `origin/${branch} is not at your latest commit.`,
      { modal: true, detail: 'The pull request will only contain what is on origin. Push first if you want your latest commits included.' },
      'Create Anyway'
    );
    if (go !== 'Create Anyway') return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-pr-'));
  const bodyFile = path.join(dir, 'body.md');
  fs.writeFileSync(bodyFile, body);
  try {
    const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Creating pull request…' }, () =>
      gh(root, ['pr', 'create', '--base', baseName, '--head', branch, '--title', title, '--body-file', bodyFile])
    );
    const url = out.trim().split('\n').pop();
    if ((await vscode.window.showInformationMessage(`Pull request created: ${url}`, 'Open')) === 'Open') {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function generatePullRequest() {
  const repo = repoFromArg();
  const root = repo.rootUri.fsPath;
  const branch = repo.state.HEAD?.name;
  if (!branch) throw new Error('Check out a branch first; HEAD is detached.');
  const base = await pickBase(root, `Pull request from ${branch} into…`);
  if (!base) return;
  const mergeBase = (await g.git(root, ['merge-base', base, 'HEAD'])).trim();
  const commits = await g.logCommits(root, ['--no-merges', '-n200', `${mergeBase}..HEAD`, '--']);
  if (!commits.length) {
    vscode.window.showInformationMessage(`${branch} has no commits that are not already in ${base}.`);
    return;
  }
  const [stat, diff] = await Promise.all([g.git(root, ['diff', '--stat', mergeBase, 'HEAD']), diffText(root, [mergeBase, 'HEAD'])]);
  const text = await ask(
    'Writing pull request',
    [
      `Write a pull request for merging ${branch} into ${g.shortRef(base)}, from the commits, file summary and diff in the input.`,
      'The first line must be "# " followed by a concise title under 70 characters, in conventional-commit style if the commits use it.',
      'Then a Markdown body with "## Summary" (what and why, 2-5 bullets), "## Changes" (grouped by area), "## Testing" (how to verify; say what is unknown rather than inventing steps), and "## Notes" only for risks, migrations or follow-ups.',
      'Reply with the Markdown only.',
    ].join(' '),
    `Commits:\n${commitList(commits, true)}\n\nFiles:\n${stat}\n\nDiff:\n${diff}`,
    root
  );
  const doc = await showMarkdown(stripFences(text), false);
  const choice = await vscode.window.showInformationMessage(
    `Pull request draft for ${branch} → ${g.shortRef(base)} is open. Edit it if needed, then:`,
    'Create PR with gh',
    'Copy'
  );
  if (choice === 'Copy') {
    await vscode.env.clipboard.writeText(doc.getText());
    vscode.window.setStatusBarMessage('Pull request draft copied', 3000);
  } else if (choice === 'Create PR with gh') {
    await createPrWithGh(root, branch, base, doc);
  }
}

async function pickCommit(root) {
  const commits = await g.logCommits(root, ['-n50']);
  const pick = await vscode.window.showQuickPick(
    commits.map((c) => ({ label: c.subject, description: `${c.short} · ${c.author}, ${c.date}`, commit: c })),
    { title: 'Pick a commit', matchOnDescription: true }
  );
  return pick?.commit;
}

async function commitTarget(root, commit) {
  return { root, label: `commit ${commit.short} "${commit.subject}"`, heading: `Commit ${commit.short}: ${commit.subject}`, context: await showText(root, commit.hash) };
}

async function compareTarget(root, ref) {
  const branch = g.currentBranch(root);
  const mergeBase = (await g.git(root, ['merge-base', ref, 'HEAD'])).trim();
  const [commits, stat, diff] = await Promise.all([
    g.logCommits(root, ['--no-merges', '-n200', `${mergeBase}..HEAD`, '--']),
    g.git(root, ['diff', '--stat', mergeBase]),
    diffText(root, [mergeBase]),
  ]);
  return {
    root,
    label: `${branch} compared with ${ref}, including uncommitted changes`,
    heading: `${branch} ↔ ${ref}`,
    context: `Commits on ${branch} since ${ref}:\n${commitList(commits, false) || '(none)'}\n\nFiles:\n${stat}\n\nDiff (merge base to working tree):\n${diff}`,
  };
}

async function workingTarget(root) {
  const context = await workingChanges(root);
  if (!context.trim()) throw new Error('There are no uncommitted changes.');
  return { root, label: 'uncommitted changes', heading: 'Uncommitted changes', context };
}

async function prTarget(root, pr) {
  const n = String(pr.number);
  const [diff, view] = await Promise.all([gh(root, ['pr', 'diff', n]), gh(root, ['pr', 'view', n, '--json', 'title,body,headRefName,baseRefName'])]);
  const info = JSON.parse(view);
  return {
    root,
    label: `pull request #${n} "${info.title}"`,
    heading: `#${n} ${info.title}`,
    context: `Pull request #${n}: ${info.title}\n${info.headRefName} → ${info.baseRefName}\n\nDescription:\n${info.body || '(empty)'}\n\nDiff:\n${stripNoiseFromDiff(diff)}`,
  };
}

async function targetFromArg(arg) {
  if (arg?.type === 'compare') return compareTarget(arg.root, arg.ref);
  if (arg?.type === 'pr') return prTarget(arg.root, arg.pr);
  if (arg?.commit?.hash) return commitTarget(arg.root, arg.commit);
  return undefined;
}

async function explainCommit(arg) {
  let root = arg?.root;
  let commit = arg?.commit;
  if (!commit?.hash) {
    root = g.requireRepo();
    commit = await pickCommit(root);
    if (!commit) return;
  }
  const target = await commitTarget(root, commit);
  const text = await ask(
    'Explaining commit',
    [
      'Explain the commit in the input for a teammate reading the history.',
      'Use Markdown with "## What changed" (concrete, grouped by area), "## Why" (infer the intent from the message and the code, and say when you are guessing), and "## Risks and things to check".',
      'Stay under 400 words. Reply with the Markdown only.',
    ].join(' '),
    target.context,
    root
  );
  await showMarkdown(`# ${target.heading}\n\n${stripFences(text)}`);
}

async function explainChanges(arg) {
  const target = arg?.type === 'compare' ? await compareTarget(arg.root, arg.ref) : await workingTarget(repoFromArg(arg).rootUri.fsPath);
  const text = await ask(
    'Explaining changes',
    [
      `Explain these changes (${target.label}) in plain language for a teammate.`,
      'Use Markdown with "## Summary" (2-4 sentences), "## By area" (bullets per group of files) and "## Things to double-check".',
      'Reply with the Markdown only.',
    ].join(' '),
    target.context,
    target.root
  );
  await showMarkdown(`# Explain: ${target.heading}\n\n${stripFences(text)}`);
}

function reviewInstruction(label) {
  return [
    `Review this code change (${label}) the way a careful senior engineer would.`,
    'Write Markdown that starts with "## Summary" (one short paragraph).',
    'Then "## Findings" with the subsections "### Bug", "### Risk" and "### Nit", including only subsections that have findings.',
    'Each finding is one bullet that starts with `path:line` (line number on the new side of the diff, best effort), then the problem and a concrete fix.',
    'Prioritise correctness, security, data loss, error handling and performance over style.',
    'If nothing is worth changing, write "Looks good" under Findings. Do not assume context that is not in the input.',
  ].join(' ');
}

async function runReview(target) {
  const text = await ask('Reviewing', reviewInstruction(target.label), target.context, target.root);
  return showMarkdown(`# Review: ${target.heading}\n\n${stripFences(text)}`);
}

async function review(arg) {
  let target = await targetFromArg(arg);
  if (!target) {
    const root = g.requireRepo();
    const base = (await g.resolveBases(root))[0];
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Uncommitted changes', kind: 'working' },
        ...(base ? [{ label: `$(git-compare) Current branch vs ${base}`, kind: 'branch' }] : []),
        { label: '$(git-commit) A commit…', kind: 'commit' },
      ],
      { title: 'Review what?' }
    );
    if (!choice) return;
    if (choice.kind === 'working') target = await workingTarget(root);
    else if (choice.kind === 'branch') target = await compareTarget(root, base);
    else {
      const commit = await pickCommit(root);
      if (!commit) return;
      target = await commitTarget(root, commit);
    }
  }
  await runReview(target);
}

function parseSearchReply(text) {
  const t = stripFences(text);
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('The AI did not return a search.');
  const parsed = JSON.parse(t.slice(start, end + 1));
  return { args: validateSearchArgs(parsed.args), label: typeof parsed.label === 'string' ? parsed.label.slice(0, 120) : '' };
}

function validateSearchArgs(args) {
  if (!Array.isArray(args) || !args.length || args.length > 40) throw new Error('The search needs between 1 and 40 arguments.');
  const out = [];
  let paths = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string' || !a || a.length > 300 || /[\0\r\n]/.test(a)) throw new Error('Invalid search argument.');
    if (paths) {
      if (a.startsWith('-')) throw new Error(`Unsupported pathspec: ${a}`);
      if (a.startsWith(':(') && !PATHSPEC_MAGIC.test(a)) throw new Error(`Unsupported pathspec: ${a}`);
      out.push(a);
    } else if (a === '--') {
      paths = true;
      out.push(a);
    } else if (SEARCH_FLAGS.has(a) || SEARCH_VALUE_FLAG.test(a)) {
      out.push(a);
    } else if (a === '-S' || a === '-G') {
      const v = args[++i];
      if (typeof v !== 'string' || !v || v.length > 300 || /[\0\r\n]/.test(v)) throw new Error(`${a} needs a value.`);
      out.push(`${a}${v}`);
    } else if (/^-[SG][^\0\r\n]+$/.test(a)) {
      out.push(a);
    } else {
      throw new Error(`Unsupported search argument: ${a}`);
    }
  }
  if (out[out.length - 1] === '--') out.pop();
  if (!out.length) throw new Error('The search is empty.');
  return out;
}

async function search() {
  const root = g.requireRepo();
  const query = (
    await vscode.window.showInputBox({ title: 'AI Search Commits', prompt: 'Describe the commits you are looking for', placeHolder: 'login fixes by alice last month' })
  )?.trim();
  if (!query) return;
  const [me, authors] = await Promise.all([
    g.git(root, ['config', 'user.name']).catch(() => ''),
    g.git(root, ['shortlog', '-sn', '--no-merges', '-n', 'HEAD']).catch(() => ''),
  ]);
  const context = [
    `Request: ${query}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    `Current user: ${me.trim() || 'unknown'}`,
    `Known authors (commit count, name):\n${authors.split('\n').slice(0, 40).join('\n')}`,
  ].join('\n\n');
  const reply = await ask(
    'Building search',
    [
      'Turn the request in the input into arguments for `git log`.',
      'Reply with ONLY a JSON object: {"args": [...], "label": "short description"}.',
      'Allowed arguments: "--grep=<regex>", "--author=<regex>", "--since=<date>", "--until=<date>", "-S" followed by a separate string, "-G" followed by a separate regex, "-i", "--all-match", "--no-merges", and file pathspecs after a "--" element.',
      'Use the author list to match names, ISO dates for time ranges, and "-i" for case-insensitive text. Use no other arguments.',
    ].join(' '),
    context,
    root
  );
  const { args, label } = parseSearchReply(reply);
  const views = require('./views');
  if (typeof views.addSearch !== 'function') throw new Error('Search view is not available in this build.');
  await views.addSearch(root, 'AI', query, args);
  if (label) vscode.window.setStatusBarMessage(`AI search: ${label}`, 5000);
}

function slugify(text, maxWords = 5) {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '');
}

function isBugIssue(issue) {
  return (issue.labels || []).some((l) => /bug|fix|defect|regression/i.test(l.name || l)) || /^(fix|bug)\b/i.test(issue.title || '');
}

function fallbackBranch(issue) {
  return `${isBugIssue(issue) ? 'fix' : 'feat'}/${slugify(issue.title || '') || `issue-${issue.number}`}`;
}

async function validBranchName(root, name) {
  if (!name || /\s/.test(name)) return false;
  try {
    await g.git(root, ['check-ref-format', '--branch', name]);
    return true;
  } catch {
    return false;
  }
}

async function startWork() {
  const root = g.requireRepo();
  const issues = JSON.parse(await gh(root, ['issue', 'list', '--assignee', '@me', '--state', 'open', '--json', 'number,title,labels,url', '--limit', '50']));
  if (!issues.length) {
    vscode.window.showInformationMessage('No open issues are assigned to you.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    issues.map((issue) => ({ label: `#${issue.number} ${issue.title}`, description: (issue.labels || []).map((l) => l.name).join(', '), issue })),
    { title: 'Start Work on…', matchOnDescription: true }
  );
  if (!pick) return;
  const issue = pick.issue;
  let suggestion = fallbackBranch(issue);
  try {
    const reply = stripFences(
      await ask(
        'Naming branch',
        'Suggest a git branch name for the issue in the input: "fix/" for bugs, "feat/" otherwise, then a lowercase kebab-case slug of 2-5 ASCII words. Reply with the branch name only.',
        `Issue #${issue.number}: ${issue.title}\nLabels: ${(issue.labels || []).map((l) => l.name).join(', ') || 'none'}`,
        root
      )
    ).split('\n')[0].replace(/[`'"]/g, '').trim();
    if (await validBranchName(root, reply)) suggestion = reply;
  } catch (e) {
    if (e instanceof CancelledError) return;
  }
  const name = (
    await vscode.window.showInputBox({
      title: `Start Work on #${issue.number}`,
      prompt: 'Branch name',
      value: suggestion,
      validateInput: async (v) => {
        const n = v.trim();
        if (!(await validBranchName(root, n))) return 'Not a valid branch name';
        if (await g.refExists(root, `refs/heads/${n}`)) return 'A branch with this name already exists';
        return undefined;
      },
    })
  )?.trim();
  if (!name) return;
  const base = (await g.resolveBases(root))[0] || 'HEAD';
  const where = await vscode.window.showQuickPick(
    [
      { label: '$(arrow-swap) Switch in This Window', value: 'switch', description: `new branch from ${base}` },
      { label: '$(repo) New Worktree', value: 'worktree', description: `new folder, branch from ${base}` },
    ],
    { title: `Create ${name}` }
  );
  if (!where) return;
  if (where.value === 'switch') {
    await g.git(root, ['switch', '--no-track', '-c', name, base]);
    vscode.window.setStatusBarMessage(`Switched to ${name}`, 4000);
  } else {
    const list = g.parseWorktrees(await g.git(root, ['worktree', 'list', '--porcelain']));
    const main = list[0]?.path || root;
    const target = await vscode.window.showInputBox({ title: `Worktree for ${name}`, prompt: 'Folder for the worktree', value: `${main}-${name.split('/').pop()}` });
    if (!target) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating worktree ${path.basename(target)}…` }, () =>
      g.git(root, ['worktree', 'add', '--no-track', '-b', name, target, base])
    );
    if ((await vscode.window.showInformationMessage(`Worktree ready at ${target}. Install dependencies there before starting apps.`, 'Open in New Window')) === 'Open in New Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceNewWindow: true });
    }
  }
  vscode.commands.executeCommand('gitCompass.refresh').then(undefined, () => {});
}

async function startReview() {
  const root = g.requireRepo();
  const prs = JSON.parse(await gh(root, ['pr', 'list', '--search', 'review-requested:@me', '--state', 'open', '--json', 'number,title,headRefName,url', '--limit', '50']));
  if (!prs.length) {
    vscode.window.showInformationMessage('No pull requests are waiting for your review.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    prs.map((pr) => ({ label: `#${pr.number} ${pr.title}`, description: pr.headRefName, pr })),
    { title: 'Start Review of…', matchOnDescription: true }
  );
  if (!pick) return;
  await runReview(await prTarget(root, pick.pr));
  const choice = await vscode.window.showInformationMessage(`Review of #${pick.pr.number} is ready.`, 'Open in Worktree');
  if (choice === 'Open in Worktree') await vscode.commands.executeCommand('gitCompass.launchpad.openWorktree', { type: 'pr', root, pr: pick.pr });
}

async function offerSetup() {
  const choice = await vscode.window.showWarningMessage('Git Compass AI is not set up yet. Choose where AI requests should go: a command-line agent, an API, a local model or a VS Code language model.', 'Set Up AI…');
  if (choice) await providers.configure();
}

function register(context) {
  providers.init(context);
  const commands = {
    configure: providers.configure,
    setApiKey: providers.setApiKey,
    clearApiKey: providers.clearApiKey,
    testConnection: providers.testConnection,
    generateCommitMessage,
    stashWithMessage,
    generateChangelog,
    generatePullRequest,
    explainCommit,
    explainChanges,
    review,
    search,
    startWork,
    startReview,
  };
  for (const [name, fn] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`gitCompass.ai.${name}`, async (...args) => {
        try {
          await g.getGitApi();
          await fn(...args);
        } catch (e) {
          if (e instanceof CancelledError) return;
          if (e instanceof AiNotConfiguredError) return offerSetup();
          vscode.window.showErrorMessage(`Git Compass AI: ${e.message}`);
        }
      })
    );
  }
}

module.exports = {
  register,
  ask,
  scrubEnv: providers.scrubEnv,
  truncateContext: providers.truncateContext,
  stripFences,
  stripNoiseFromDiff,
  parsePrDraft,
  parseSearchReply,
  validateSearchArgs,
  slugify,
  fallbackBranch,
  isBugIssue,
  CancelledError,
  AiNotConfiguredError,
};

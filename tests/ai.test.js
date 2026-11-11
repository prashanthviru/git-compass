const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const ai = require('../ai');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-ai-cmd-'));
const fakeCli = path.join(tmp, 'answer.js');
fs.writeFileSync(
  fakeCli,
  `let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (process.argv[2] === 'search') process.stdout.write('\`\`\`json\\n{"args": ["--grep=login", "-i", "--", "src/"], "label": "login work"}\\n\`\`\`');
  else process.stdout.write(input.includes('Write a git commit message') ? 'feat(core): add greeting' : 'unexpected');
});
`
);

const repos = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  repos.forEach((r) => r.cleanup());
});

beforeEach(() => reset());

describe('search argument whitelist', () => {
  test('accepts supported flags and pathspecs', () => {
    assert.deepEqual(ai.validateSearchArgs(['--grep=fix', '--author=Alice', '--since=2026-01-01', '-i', '--no-merges', '-S', 'token', '-Gfoo.*', '--', ':(glob,icase)**/*.js', 'src/']), [
      '--grep=fix',
      '--author=Alice',
      '--since=2026-01-01',
      '-i',
      '--no-merges',
      '-Stoken',
      '-Gfoo.*',
      '--',
      ':(glob,icase)**/*.js',
      'src/',
    ]);
    assert.deepEqual(ai.validateSearchArgs(['--grep=x', '--']), ['--grep=x']);
  });

  test('rejects anything that could change what git does', () => {
    for (const bad of [['--output=x'], [';rm -rf /'], ['-c', 'core.pager=sh'], ['--exec=sh'], ['--exec'], ['--', '--output=x'], ['--', ':(attr:foo)x'], ['--grep=a\nb'], [], 'nope', ['-S']]) {
      assert.throws(() => ai.validateSearchArgs(bad), Error, JSON.stringify(bad));
    }
  });

  test('parses a fenced JSON reply', () => {
    assert.deepEqual(ai.parseSearchReply('```json\n{"args":["--grep=a"],"label":"A"}\n```'), { args: ['--grep=a'], label: 'A' });
    assert.throws(() => ai.parseSearchReply('no json here'), /did not return a search/);
  });
});

describe('text helpers', () => {
  test('slugify and branch names', () => {
    assert.equal(ai.slugify('Fix: Crème brûlée crashes on SAVE!!'), 'fix-creme-brulee-crashes-on');
    assert.equal(ai.fallbackBranch({ number: 7, title: 'Login button broken', labels: [{ name: 'bug' }] }), 'fix/login-button-broken');
    assert.equal(ai.fallbackBranch({ number: 8, title: 'Add dark mode', labels: [] }), 'feat/add-dark-mode');
    assert.equal(ai.fallbackBranch({ number: 9, title: '!!!', labels: [] }), 'feat/issue-9');
    assert.equal(ai.isBugIssue({ title: 'fix typo', labels: [] }), true);
  });

  test('stripFences, PR drafts and noisy diffs', () => {
    assert.equal(ai.stripFences('```\nfeat: x\n```'), 'feat: x');
    assert.equal(ai.stripFences('"quoted"'), 'quoted');
    assert.deepEqual(ai.parsePrDraft('\n# Title here\n\nBody\ntext'), { title: 'Title here', body: 'Body\ntext' });
    const diff = 'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n+x\ndiff --git a/src/a.js b/src/a.js\n+y\n';
    assert.equal(ai.stripNoiseFromDiff(diff), 'diff --git a/src/a.js b/src/a.js\n+y\n');
  });

  test('remote images in AI answers become plain links', () => {
    assert.equal(ai.stripRemoteImages('see ![x](https://evil.example/?d=secret) now'), 'see [x](https://evil.example/?d=secret) now');
    assert.equal(ai.stripRemoteImages('a <img src="https://evil.example/p.png"> b'), 'a  b');
    assert.equal(ai.stripRemoteImages('keep [link](https://example.com) and `code`'), 'keep [link](https://example.com) and `code`');
  });

  test('truncation and env scrubbing are shared with the providers', () => {
    assert.equal(ai.truncateContext('abcdef', 2).truncated, true);
    assert.deepEqual(ai.scrubEnv({ A: '1', CLAUDECODE: '1', CLAUDE_CODE_EXTRA_BODY: '{}' }), { A: '1' });
  });
});

describe('commands', () => {
  function activate() {
    const context = createContext();
    ai.register(context);
    return context;
  }

  test('registers the AI and setup commands', () => {
    activate();
    for (const name of ['generateCommitMessage', 'stashWithMessage', 'generateChangelog', 'generatePullRequest', 'explainCommit', 'explainChanges', 'review', 'search', 'startWork', 'startReview', 'configure', 'setApiKey', 'clearApiKey', 'testConnection']) {
      assert.ok(state.commands.has(`gitCompass.ai.${name}`), name);
    }
  });

  test('offers setup instead of failing when no provider is chosen', async () => {
    activate();
    const r = createRepo();
    repos.push(r);
    r.write('a.txt', 'one\n');
    r.commit('chore: init');
    r.write('a.txt', 'two\n');
    r.git('add', 'a.txt');
    state.repos = [makeRepo(r.root)];
    await state.commands.get('gitCompass.ai.generateCommitMessage')();
    const warning = state.messages.find(([kind]) => kind === 'warning');
    assert.ok(warning, 'expected a warning');
    assert.match(warning[1], /not set up/);
    assert.ok(!state.messages.some(([kind]) => kind === 'error'));
  });

  test('writes a generated commit message into the SCM input box', async () => {
    activate();
    const r = createRepo();
    repos.push(r);
    r.write('hello.js', 'module.exports = 1;\n');
    r.commit('chore: init');
    r.write('hello.js', 'module.exports = () => "hi";\n');
    r.git('add', 'hello.js');
    const repo = makeRepo(r.root);
    state.repos = [repo];
    Object.assign(state.config, { 'gitCompass.ai.provider': 'cli', 'gitCompass.ai.cli.command': process.execPath, 'gitCompass.ai.cli.args': [fakeCli], 'gitCompass.ai.cli.promptInput': 'stdin' });
    state.answers.push('Continue');
    await state.commands.get('gitCompass.ai.generateCommitMessage')();
    assert.deepEqual(state.messages.filter(([k]) => k === 'error'), []);
    assert.equal(repo.inputBox.value, 'feat(core): add greeting');
    assert.match(state.messages[0][1], /local command/);
  });
});

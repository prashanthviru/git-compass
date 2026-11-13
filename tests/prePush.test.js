const { state, reset } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../git');
const prePush = require('../prePush');

// Built from parts so this file doesn't trip the checks it tests.
const LOG = 'console' + '.log(';
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const MARK = '<'.repeat(7);

test.beforeEach(() => reset());

test('addedLines follows files and new line numbers', () => {
  const diff = ['diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js', '@@ -1,0 +2,2 @@', '+one', '+two', '@@ -9 +11 @@', '-old', '+eleven', 'diff --git a/gone.js b/gone.js', '--- a/gone.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-bye'].join('\n');
  assert.deepEqual([...prePush.addedLines(diff)], [
    { file: 'a.js', line: 2, text: 'one' },
    { file: 'a.js', line: 3, text: 'two' },
    { file: 'a.js', line: 11, text: 'eleven' },
  ]);
});

test('scanDiff finds secrets, conflict markers and debug code', () => {
  const diff = ['+++ b/src/app.js', '@@ -0,0 +1,6 @@', `+  ${LOG}'here');`, `+const key = '${AWS}';`, `+${MARK} HEAD`, '+model.fit(x)', '+  debugger;', '+ok();', '+++ b/README.md', '@@ -0,0 +1 @@', `+Use ${LOG}) to debug`].join('\n');
  const found = prePush.scanDiff(diff);
  assert.deepEqual(found.map((f) => [f.kind, f.line]), [['debug', 1], ['secret', 2], ['conflict', 3], ['debug', 5]]);
  assert.match(found[1].text, /AWS access key in src\/app\.js:2/);
  assert.deepEqual(prePush.scanDiff(diff, { debugPatterns: [] }).map((f) => f.kind), ['secret', 'conflict']);
  assert.deepEqual(prePush.scanDiff(diff, { debugPatterns: ['(unclosed'] }).map((f) => f.kind), ['secret', 'conflict']);
});

test('checkCommits flags the wrong identity, fixups and missing tickets', () => {
  const commits = [
    { hash: '1', short: '1111111', subject: 'PROJ-1 add login', email: 'me@work.com' },
    { hash: '2', short: '2222222', subject: 'fixup! add login', email: 'me@home.com' },
    { hash: '3', short: '3333333', subject: 'WIP stuff', body: 'refs PROJ-2', email: 'ME@WORK.COM' },
  ];
  const found = prePush.checkCommits(commits, { expectedEmail: 'me@work.com', ticketPattern: '[A-Z]+-\\d+' });
  assert.deepEqual(found.map((f) => [f.kind, f.hash]), [['identity', '2'], ['wip', '2'], ['ticket', '2'], ['wip', '3']]);
  assert.deepEqual(prePush.checkCommits(commits, {}).map((f) => f.kind), ['wip', 'wip']);
  assert.deepEqual(prePush.checkCommits(commits, { ticketPattern: '([' }).map((f) => f.kind), ['wip', 'wip']);
});

test('checkSizes flags files over the limit', () => {
  const found = prePush.checkSizes([{ path: 'big.bin', size: 6 * 1024 * 1024 }, { path: 'small.txt', size: 10 }], 5120);
  assert.equal(found.length, 1);
  assert.match(found[0].text, /big\.bin is 6\.0 MB \(limit 5\.0 MB\)/);
  assert.deepEqual(prePush.checkSizes([{ path: 'big.bin', size: 1e9 }], 0), []);
});

test('runChecks looks only at what the push would add, and gate asks before pushing', async () => {
  const r = createRepo();
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-origin-')));
  try {
    r.write('old.js', `${LOG}'already on origin');\n`);
    r.commit('base');
    r.git('init', '-q', '--bare', '-b', 'main', bare);
    r.git('remote', 'add', 'origin', bare);
    r.git('push', '-q', '-u', 'origin', 'main');
    r.git('switch', '-q', '-c', 'feature');
    r.write('new.js', `const k = '${AWS}';\n${LOG}'new');\n`);
    r.commit('fixup! base');
    state.config['gitCompass.baseBranches'] = ['main'];
    g.clearBaseCache();

    const result = await prePush.runChecks(r.root, 'feature');
    assert.equal(result.commits, 1);
    assert.equal(result.against, 'main');
    assert.deepEqual(result.findings.map((f) => f.kind).sort(), ['debug', 'secret', 'wip']);
    assert.ok(result.findings.every((f) => !f.file || f.file === 'new.js'));
    assert.match(prePush.report('feature', result), /## Possible secrets \(1\)/);

    state.answers = ['Push Anyway'];
    assert.equal(await prePush.gate(r.root, 'feature'), true);
    state.answers = [undefined];
    assert.equal(await prePush.gate(r.root, 'feature'), false);
    state.config['gitCompass.prePush.enabled'] = false;
    state.messages = [];
    assert.equal(await prePush.gate(r.root, 'feature'), true);
    assert.deepEqual(state.messages, []);
  } finally {
    r.cleanup();
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('gate lets a clean branch through without asking', async () => {
  const r = createRepo();
  try {
    r.write('a.txt', 'a\n');
    r.commit('base');
    r.git('switch', '-q', '-c', 'clean');
    r.write('b.txt', 'b\n');
    r.commit('add b');
    state.config['gitCompass.baseBranches'] = ['main'];
    g.clearBaseCache();
    assert.equal(await prePush.gate(r.root, 'clean'), true);
    assert.deepEqual(state.messages, []);
  } finally {
    r.cleanup();
  }
});

const { vscode, state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { parseBlame, parseDiffHunks, relativeTime, heatBuckets, gutterLabel, lineInfo } = require('../editor');

let repo;
const sha = {};

before(() => {
  repo = createRepo();
  repo.write('f.txt', 'a\nb\nc\n');
  sha.first = repo.commit('feat: first');
  repo.write('f.txt', 'a\nB\nc\nd\n');
  sha.second = repo.commit('fix: second');
});

after(() => repo.cleanup());

test('parseBlame maps each line to its commit', () => {
  const blame = parseBlame(repo.git('blame', '--porcelain', '--', 'f.txt'));
  assert.deepEqual(blame.lines, [sha.first, sha.second, sha.first, sha.second]);
  const second = blame.commits.get(sha.second);
  assert.equal(second.author, 'Test User');
  assert.equal(second.email, 'test@example.com');
  assert.equal(second.summary, 'fix: second');
  assert.equal(second.filename, 'f.txt');
  assert.equal(second.short, sha.second.slice(0, 8));
  assert.deepEqual(second.previous, { hash: sha.first, filename: 'f.txt' });
  assert.ok(second.time > 1e9);
  assert.equal(blame.commits.get(sha.first).previous, undefined);
});

test('parseBlame marks unsaved lines as uncommitted', () => {
  const out = require('child_process').execFileSync('git', ['blame', '--porcelain', '--contents', '-', '--', 'f.txt'], { cwd: repo.root, input: 'a\nB\nc\nd\nnew line\n', encoding: 'utf8' });
  const live = parseBlame(out);
  assert.equal(live.lines.length, 5);
  assert.equal(lineInfo(live, 4).uncommitted, true);
  assert.equal(lineInfo(live, 0).uncommitted, false);
  assert.equal(lineInfo(live, 0).hash, sha.first);
  assert.equal(lineInfo(live, 99), undefined);
});

test('parseDiffHunks splits added, modified and deleted lines', () => {
  const diff = ['@@ -2 +2 @@', '-b', '+B', '@@ -3,0 +4,2 @@', '+d', '+e', '@@ -9,2 +10,0 @@', '-x', '-y', '@@ -20,3 +21,3 @@'].join('\n');
  assert.deepEqual(parseDiffHunks(diff), { added: [3, 4], modified: [1, 20, 21, 22], deleted: [9] });
  assert.deepEqual(parseDiffHunks(''), { added: [], modified: [], deleted: [] });
});

test('relativeTime describes past times in words', () => {
  const now = 1_700_000_000;
  assert.match(relativeTime(now - 3600, now), /hour/);
  assert.match(relativeTime(now - 3 * 86400, now), /3 days ago/);
  assert.match(relativeTime(now - 400 * 86400, now), /year/);
  assert.equal(relativeTime(now - 5, now), 'just now');
});

test('heatBuckets scales times from oldest to newest', () => {
  assert.deepEqual(heatBuckets([100, 200, undefined, 150]), [0, 9, undefined, 5]);
  assert.deepEqual(heatBuckets([5, 5]), [9, 9]);
  assert.deepEqual(heatBuckets([undefined]), [undefined]);
});

test('gutterLabel has a fixed width and truncates long names', () => {
  const short = gutterLabel('Ann', '2 days ago');
  assert.equal(short.length, 30);
  assert.ok(!short.includes(' '));
  assert.ok(short.startsWith('Ann'));
  const long = gutterLabel('A very long author name here', 'yesterday');
  assert.equal(long.length, 30);
  assert.ok(long.includes('…'));
});

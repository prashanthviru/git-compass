const { vscode, state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { LOG_FORMAT } = require('../git');
const { shapeHistory, parseRenamePath } = require('../visualHistory');

let repo;
const sha = {};

const dated = (message, date) => {
  repo.commit(message);
  repo.git('commit', '-q', '--amend', '--no-edit', '--date', date);
  return repo.git('rev-parse', 'HEAD').trim();
};

before(() => {
  repo = createRepo();
  repo.write('docs/guide.md', Array.from({ length: 30 }, (_, i) => `para ${i}`).join('\n') + '\n');
  sha.add = dated('docs: add guide', '2026-01-01T10:00:00Z');
  repo.write('docs/guide.md', Array.from({ length: 30 }, (_, i) => (i === 3 ? 'changed' : `para ${i}`)).join('\n') + '\nextra\n');
  sha.edit = dated('docs: edit guide', '2026-02-01T10:00:00Z');
  repo.git('mv', 'docs/guide.md', 'docs/manual.md');
  sha.rename = dated('docs: rename guide', '2026-03-01T10:00:00Z');
});

after(() => repo.cleanup());

test('shapeHistory builds sorted points with stats, lanes and renames', () => {
  const out = repo.git('log', LOG_FORMAT, '--follow', '--numstat', '-M', '--', 'docs/manual.md');
  const { authors, points } = shapeHistory(out, 'docs/manual.md');
  assert.deepEqual(points.map((p) => p.hash), [sha.add, sha.edit, sha.rename]);
  assert.ok(points.every((p, i) => i === 0 || p.time >= points[i - 1].time));
  assert.deepEqual([points[0].additions, points[0].deletions], [30, 0]);
  assert.deepEqual([points[1].additions, points[1].deletions], [2, 1]);
  assert.equal(points[2].status, 'R');
  assert.equal(points[2].oldPath, 'docs/guide.md');
  assert.equal(points[2].path, 'docs/manual.md');
  assert.equal(points[0].path, 'docs/guide.md');
  assert.deepEqual(authors, [{ name: 'Test User', count: 3, additions: 32, deletions: 1 }]);
  assert.ok(points.every((p) => p.lane === 0));
});

test('shapeHistory keeps oldest-first order when commits share a timestamp', () => {
  const other = createRepo();
  try {
    other.write('a.txt', '1\n');
    const first = other.commit('one');
    other.write('a.txt', '2\n');
    const second = other.commit('two');
    other.git('commit', '-q', '--amend', '--no-edit', '--date', other.git('log', '-1', '--format=%aI', first).trim());
    const head = other.git('rev-parse', 'HEAD').trim();
    const { points } = shapeHistory(other.git('log', LOG_FORMAT, '--follow', '--numstat', '--', 'a.txt'), 'a.txt');
    assert.deepEqual(points.map((p) => p.hash), [first, head]);
    assert.ok(second);
  } finally {
    other.cleanup();
  }
});

test('shapeHistory handles an empty log', () => {
  assert.deepEqual(shapeHistory('', 'x'), { authors: [], points: [] });
});

test('parseRenamePath understands git rename notations', () => {
  assert.deepEqual(parseRenamePath('src/{a => b}/f.js'), { oldPath: 'src/a/f.js', path: 'src/b/f.js' });
  assert.deepEqual(parseRenamePath('{old => new}.js'), { oldPath: 'old.js', path: 'new.js' });
  assert.deepEqual(parseRenamePath('dir/{ => sub}/f.js'), { oldPath: 'dir/f.js', path: 'dir/sub/f.js' });
  assert.deepEqual(parseRenamePath('a.js => b.js'), { oldPath: 'a.js', path: 'b.js' });
  assert.deepEqual(parseRenamePath('plain/path.js'), { oldPath: 'plain/path.js', path: 'plain/path.js' });
});

const { reset } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert/strict');
const graph = require('../graph');

test.beforeEach(() => reset());

const c = (hash, ...parents) => ({ hash, parents });

test('a straight history stays in one lane', () => {
  const { rows, width } = graph.layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
  assert.equal(width, 1);
  assert.deepEqual(rows, [
    { col: 0, pass: [], incoming: [], parents: [0] },
    { col: 0, pass: [], incoming: [0], parents: [0] },
    { col: 0, pass: [], incoming: [0], parents: [] },
  ]);
});

test('a merge opens a lane for the second parent that joins back at the fork', () => {
  // m merges f into b; f and b both come from a.
  const { rows, width } = graph.layoutGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')]);
  assert.equal(width, 2);
  assert.deepEqual(rows[0], { col: 0, pass: [], incoming: [], parents: [0, 1] });
  assert.deepEqual(rows[1], { col: 1, pass: [0], incoming: [1], parents: [1] });
  // b continues lane 0 and its parent a is already expected in lane 1, so the line crosses over.
  assert.deepEqual(rows[2], { col: 0, pass: [1], incoming: [0], parents: [1] });
  // a is where both lanes meet.
  assert.deepEqual(rows[3], { col: 1, pass: [], incoming: [1], parents: [] });
});

test('two branch tips get their own lanes and free lanes are reused', () => {
  const { rows } = graph.layoutGraph([c('x', 'a'), c('y', 'a'), c('a', 'z'), c('z')]);
  assert.equal(rows[0].col, 0);
  assert.equal(rows[1].col, 1);
  assert.deepEqual(rows[1].pass, [0]);
  assert.deepEqual(rows[2].incoming, [0]);
  assert.equal(rows[2].col, 0);
  assert.deepEqual(rows[2].parents, [0]);
});

test('parseRefs types the badges and drops origin/HEAD', () => {
  assert.deepEqual(graph.parseRefs(['HEAD -> main', 'origin/main', 'origin/HEAD', 'tag: v1.0.0', 'feature/x', 'upstream/dev'], ['origin', 'upstream']), [
    { name: 'main', kind: 'current' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0.0', kind: 'tag' },
    { name: 'feature/x', kind: 'branch' },
    { name: 'upstream/dev', kind: 'remote' },
  ]);
  assert.deepEqual(graph.parseRefs(['HEAD']), [{ name: 'HEAD', kind: 'head' }]);
});

test('scopeArgs', () => {
  assert.deepEqual(graph.scopeArgs('all'), ['--branches', '--remotes', '--tags', 'HEAD']);
  assert.deepEqual(graph.scopeArgs('current'), ['HEAD']);
  assert.deepEqual(graph.scopeArgs('local'), ['--branches', 'HEAD']);
  assert.deepEqual(graph.scopeArgs('--output=x'), ['--end-of-options', '--output=x']);
});

test('readGraph lays out a real repository with a merge', async () => {
  const r = createRepo();
  try {
    r.write('a.txt', 'a\n');
    r.commit('base');
    r.git('switch', '-q', '-c', 'feature');
    r.write('f.txt', 'f\n');
    r.commit('feature work');
    r.git('switch', '-q', 'main');
    r.write('m.txt', 'm\n');
    r.commit('main work');
    r.git('merge', '-q', '--no-ff', '--no-edit', 'feature');
    r.git('tag', 'v1');
    const data = await graph.readGraph(r.root, 'all', 400);
    assert.equal(data.rows.length, 4);
    assert.equal(data.hasMore, false);
    assert.equal(data.width, 2);
    assert.equal(data.rows[0].parents.length, 2);
    assert.deepEqual(data.rows[0].refs.map((x) => x.kind).sort(), ['current', 'tag']);
    assert.deepEqual(data.branches.sort(), ['feature', 'main']);
    const page = await graph.readGraph(r.root, 'feature', 1);
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].subject, 'feature work');
    assert.equal(page.hasMore, true);
  } finally {
    r.cleanup();
  }
});

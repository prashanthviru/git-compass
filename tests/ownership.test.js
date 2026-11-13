const { state, reset, makeRepo, Uri } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const g = require('../git');
const own = require('../ownership');

test.beforeEach(() => reset());

test('parseCodeowners reads rules and skips comments and GitLab sections', () => {
  const rules = own.parseCodeowners('# owners\n* @org/all\n\n[Docs] @docs\n/docs/ @writers @ann # docs team\n*.js @js\n');
  assert.deepEqual(rules, [
    { pattern: '*', owners: ['@org/all'], line: 2 },
    { pattern: '/docs/', owners: ['@writers', '@ann'], line: 5 },
    { pattern: '*.js', owners: ['@js'], line: 6 },
  ]);
});

test('CODEOWNERS patterns follow GitHub rules', () => {
  const m = own.codeownersMatch;
  assert.ok(m('*', 'any/file.txt'));
  assert.ok(m('*.js', 'src/deep/app.js'));
  assert.ok(!m('*.js', 'src/app.ts'));
  assert.ok(m('/build/logs/', 'build/logs/a/b.log'));
  assert.ok(!m('/build/logs/', 'src/build/logs/a.log'));
  assert.ok(m('apps/', 'x/apps/y.txt'));
  assert.ok(m('docs/*', 'docs/intro.md'));
  assert.ok(!m('docs/*', 'docs/guide/intro.md'), 'docs/* does not reach subfolders');
  assert.ok(m('**/logs', 'a/b/logs/x.txt'));
  assert.ok(m('/scripts/', 'scripts', true));
  assert.ok(m('src/app.js', 'src/app.js'));
  assert.ok(!m('src/app.js', 'lib/src/app.js'));
});

test('the last matching rule wins', () => {
  const rules = own.parseCodeowners('* @all\n*.js @js\n/src/legacy/ @old\n');
  assert.deepEqual(own.ownersFor(rules, 'README.md').owners, ['@all']);
  assert.deepEqual(own.ownersFor(rules, 'src/app.js').owners, ['@js']);
  assert.deepEqual(own.ownersFor(rules, 'src/legacy/app.js').owners, ['@old']);
  assert.equal(own.ownersFor([], 'x'), undefined);
});

test('parseShortlog and blameShares', () => {
  assert.deepEqual(own.parseShortlog('    12\tAnn Lee <ann@x.io>\n     3\tBo <bo@x.io>\n'), [
    { commits: 12, name: 'Ann Lee', email: 'ann@x.io' },
    { commits: 3, name: 'Bo', email: 'bo@x.io' },
  ]);
  const blame = own.blameShares(['abc 1 1 1', 'author Ann', 'author-mail <ann@x.io>', '\tline', 'abc 2 2', 'author Ann', 'author-mail <ann@x.io>', '\tline', 'def 3 3 1', 'author Bo', 'author-mail <bo@x.io>', '\tline'].join('\n'));
  assert.deepEqual(blame.map((b) => [b.name, b.lines]), [['Ann', 2], ['Bo', 1]]);
  assert.equal(Math.round(blame[0].share * 100), 67);
});

test('ownership combines CODEOWNERS, blame and commit counts', async () => {
  const r = createRepo();
  try {
    r.write('.github/CODEOWNERS', '* @org/everyone\n/src/ @org/core\n');
    r.write('src/app.js', 'a\nb\n');
    r.commit('feat: app');
    r.write('src/app.js', 'a\nb\nc\n');
    execFileSync('git', ['commit', '-q', '-am', 'feat: more'], { cwd: r.root, env: { ...process.env, GIT_AUTHOR_NAME: 'Bo', GIT_AUTHOR_EMAIL: 'bo@example.com' } });
    const info = await own.ownership(r.root, 'src/app.js', false);
    assert.deepEqual(info.codeowners.rule.owners, ['@org/core']);
    assert.equal(info.codeowners.file, '.github/CODEOWNERS');
    assert.deepEqual(info.contributors.map((c) => [c.name, c.commits]).sort(), [['Bo', 1], ['Test User', 1]]);
    assert.equal(info.contributors[0].recent, 1);
    assert.deepEqual(info.blame.map((b) => [b.name, b.lines]), [['Test User', 2], ['Bo', 1]]);
    const folder = await own.ownership(r.root, 'src', true);
    assert.deepEqual(folder.codeowners.rule.owners, ['@org/core']);
    assert.deepEqual(folder.blame, []);
    assert.deepEqual(own.suggestedReviewers(r.root, ['README.md', 'src/app.js']), ['@org/everyone', '@org/core']);

    state.repos = [makeRepo(r.root, 'main')];
    await g.getGitApi();
    state.answers = [(items) => items.find((i) => i.copy === '@org/core')];
    await own.showOwnership(Uri.file(path.join(r.root, 'src', 'app.js')));
    assert.equal(state.clipboard, '@org/core');
  } finally {
    r.cleanup();
  }
});

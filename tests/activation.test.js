const { vscode, state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

let repo;
let context;

before(async () => {
  reset();
  repo = createRepo();
  repo.write('index.js', 'module.exports = 1;\n');
  repo.commit('feat: init');
  state.repos = [makeRepo(repo.root, 'main')];
  state.config['gitCompass.views.launchpad.enabled'] = false;
  context = createContext();
  await require('../extension').activate(context);
});

after(() => {
  for (const d of context.subscriptions) d?.dispose?.();
  repo.cleanup();
});

test('every command declared in package.json is registered', () => {
  const declared = pkg.contributes.commands.map((c) => c.command);
  const missing = declared.filter((id) => !state.commands.has(id));
  assert.deepEqual(missing, []);
});

test('every registered command is declared', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const undeclared = [...state.commands.keys()].filter((id) => id.startsWith('gitCompass.') && !declared.has(id));
  assert.deepEqual(undeclared, []);
});

test('activation registers disposables and every view', () => {
  assert.ok(context.subscriptions.length > 50);
  const viewIds = Object.values(pkg.contributes.views).flat().map((v) => v.id);
  for (const id of viewIds) assert.ok(state.trees.has(id), id);
});

test('every menu and keybinding points at a declared command', () => {
  const declared = new Set(pkg.contributes.commands.map((c) => c.command));
  const refs = [...Object.values(pkg.contributes.menus).flat(), ...pkg.contributes.keybindings].map((m) => m.command);
  assert.deepEqual(refs.filter((id) => !declared.has(id)), []);
});

test('every setting read by the code is declared', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  const declared = new Set(pkg.contributes.configuration.flatMap((s) => Object.keys(s.properties)));
  const code = fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const read = [...code.matchAll(/config\(\)\.get\('([\w.]+)'/g)].map((m) => `gitCompass.${m[1]}`);
  assert.deepEqual([...new Set(read)].filter((k) => !declared.has(k)), []);
});

test('no error was shown during activation', () => {
  assert.deepEqual(state.messages.filter(([kind]) => kind === 'error'), []);
});

test('branch status explains the situation in plain words', () => {
  const { describeStatus } = require('../extension');
  const base = { branch: 'main', base: 'main', isBase: true, isProtected: true, ahead: 0, behind: 0, unpushed: 0, incoming: 0, changed: 0, worktree: 'app', worktreeCount: 1, short: 'abc1234' };
  const say = (over) => describeStatus({ ...base, ...over });

  const editing = say({ changed: 6 });
  assert.equal(editing.text, '$(warning) Editing main directly · 6 changes');
  assert.equal(editing.tone, 'warning');
  assert.equal(editing.actions[0].title, 'Move my changes to a new branch');

  assert.equal(say({ unpushed: 2 }).text, '$(warning) 2 commits on main not pushed');
  assert.equal(say({ incoming: 1 }).text, '$(arrow-down) main · 1 new commit on origin');
  assert.equal(say({ incoming: 1 }).tone, undefined);
  assert.equal(say({}).text, '$(check) main is up to date');

  const feature = { branch: 'feature/x', isBase: false, isProtected: false };
  assert.equal(say({ ...feature, ahead: 3 }).text, '$(git-branch) feature/x · 3 commits ahead of main');
  assert.equal(say({ ...feature, ahead: 1 }).text, '$(git-branch) feature/x · 1 commit ahead of main');
  assert.equal(say({ ...feature, behind: 2 }).text, '$(git-branch) feature/x · 2 behind main');
  assert.equal(say({ ...feature, ahead: 3, behind: 2 }).text, '$(git-branch) feature/x · 3 ahead, 2 behind main');
  assert.deepEqual(say({ ...feature, ahead: 3, behind: 2 }).actions.map((a) => a.command), ['gitCompass.branch.updateFromBase', 'gitCompass.pr.create', 'gitCompass.compareBranch']);
  assert.equal(say({ ...feature }).text, '$(git-branch) feature/x · same as main');

  assert.equal(say({ branch: undefined, detached: true }).text, '$(debug-disconnect) Not on a branch (abc1234)');
  assert.equal(say({ ...feature, ahead: 3, worktreeCount: 2 }).text, '$(folder) app · feature/x · 3 commits ahead of main');
  assert.equal(say({ ...feature, base: undefined }).text, '$(git-branch) feature/x');
});

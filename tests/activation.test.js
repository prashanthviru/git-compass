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

const { vscode, state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseTodo, serializeTodo, sanitizeEntries, parseHeader, VIEW_TYPE } = require('../rebase');

const TODO = [
  'pick 1111111 feat: first',
  'p 2222222 fix: second',
  'fixup -C 3333333 squash me',
  'reword 4444444 docs: wording',
  'exec npm test',
  'break',
  'label onto',
  'reset onto',
  'merge -C 5555555 topic # Merge topic',
  '',
  '# Rebase 0011223..9a8b7c6 onto 0011223 (9 commands)',
  '#',
  '# Commands:',
  '# p, pick <commit> = use commit',
  '',
].join('\n');

test('parseTodo reads commit and command lines', () => {
  const parsed = parseTodo(TODO);
  assert.equal(parsed.eol, '\n');
  assert.equal(parsed.entries.length, 9);
  assert.deepEqual(parsed.entries.slice(0, 3).map((e) => [e.action, e.sha, e.subject, e.flag]), [
    ['pick', '1111111', 'feat: first', ''],
    ['pick', '2222222', 'fix: second', ''],
    ['fixup', '3333333', 'squash me', '-C'],
  ]);
  assert.equal(parsed.entries[4].action, 'exec');
  assert.equal(parsed.entries[4].arg, 'npm test');
  assert.deepEqual(parsed.header, { range: '0011223..9a8b7c6', onto: '0011223', count: 9 });
  assert.equal(VIEW_TYPE, 'gitCompass.rebaseEditor');
});

test('serializeTodo round-trips unchanged text exactly, LF and CRLF', () => {
  const parsed = parseTodo(TODO);
  assert.equal(serializeTodo(parsed, parsed.entries), TODO);
  const crlf = TODO.replace(/\n/g, '\r\n');
  const parsedCrlf = parseTodo(crlf);
  assert.equal(parsedCrlf.eol, '\r\n');
  assert.equal(serializeTodo(parsedCrlf, parsedCrlf.entries), crlf);
  const empty = parseTodo('');
  assert.equal(serializeTodo(empty, empty.entries), '');
});

test('reordering and action changes are written back with comments kept', () => {
  const parsed = parseTodo(TODO);
  const incoming = parsed.entries.map((e) => ({ raw: e.raw, action: e.action }));
  [incoming[0], incoming[1]] = [incoming[1], incoming[0]];
  incoming[0].action = 'squash';
  incoming[2].action = 'pick';
  incoming[3].action = 'drop';
  const entries = sanitizeEntries(parsed, incoming);
  const out = serializeTodo(parsed, entries).split('\n');
  assert.deepEqual(out.slice(0, 4), ['squash 2222222 fix: second', 'pick 1111111 feat: first', 'pick 3333333 squash me', 'drop 4444444 docs: wording']);
  assert.ok(out.includes('# Rebase 0011223..9a8b7c6 onto 0011223 (9 commands)'));
});

test('sanitizeEntries refuses tampered updates', () => {
  const parsed = parseTodo(TODO);
  const same = parsed.entries.map((e) => ({ raw: e.raw, action: e.action }));
  assert.equal(sanitizeEntries(parsed, same.slice(1)), undefined);
  assert.equal(sanitizeEntries(parsed, 'nope'), undefined);
  assert.equal(sanitizeEntries(parsed, [...same.slice(1), { raw: 'exec rm -rf /', action: 'exec' }]), undefined);
  assert.equal(sanitizeEntries(parsed, [same[0], ...same.slice(0, -1)]), undefined);
  const promote = same.map((e) => ({ ...e }));
  promote[0].action = 'exec';
  promote[4].action = 'pick';
  const kept = sanitizeEntries(parsed, promote);
  assert.equal(kept[0].action, 'pick');
  assert.equal(kept[4].action, 'exec');
});

test('parseHeader finds the rebase range', () => {
  assert.deepEqual(parseHeader(['# Rebase abc..def onto abc (1 command)']), { range: 'abc..def', onto: 'abc', count: 1 });
  assert.deepEqual(parseHeader(['# Rebase abc..def onto ghi']), { range: 'abc..def', onto: 'ghi', count: undefined });
  assert.equal(parseHeader(['# nothing here']), undefined);
});

const { state, reset, makeRepo, createContext } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../git');
const views = require('../views');
const recovery = require('../recovery');

const head = (r) => r.git('rev-parse', 'HEAD').trim();
const subject = (r, ref = 'HEAD') => r.git('log', '-1', '--format=%s', ref).trim();
const staged = (r) => r.git('diff', '--cached', '--name-only').trim().split('\n').filter(Boolean);

function repoWith(n = 2) {
  const r = createRepo();
  const shas = [];
  for (let i = 1; i <= n; i++) {
    r.write(`f${i}.txt`, `${i}\n`);
    shas.push(r.commit(`commit ${i}`));
  }
  return { ...r, shas };
}

test.beforeEach(() => {
  reset();
});

test('describeReflog explains reflog lines in plain words', () => {
  const d = recovery.describeReflog;
  assert.equal(d('commit: fix login').text, 'Committed "fix login"');
  assert.equal(d('commit (initial): first').kind, 'commit');
  assert.equal(d('commit (initial): first').initial, true);
  assert.equal(d('commit (amend): better').kind, 'amend');
  assert.equal(d('commit (merge): Merge branch x').kind, 'merge');
  const co = d('checkout: moving from main to feature/x');
  assert.equal(co.kind, 'checkout');
  assert.equal(co.from, 'main');
  assert.equal(co.text, 'Switched from main to feature/x');
  assert.equal(d('checkout: moving from main to 0123456789abcdef').text, 'Switched from main to commit 0123456');
  assert.equal(d('merge feature: Fast-forward').text, 'Merged feature (fast-forward)');
  assert.equal(d('merge origin/main: Merge made by the \'ort\' strategy.').kind, 'merge');
  assert.equal(d('pull: Fast-forward').text, 'Pulled (fast-forward)');
  assert.equal(d('rebase (finish): refs/heads/feat onto 1234567abc').text, 'Rebased feat onto 1234567');
  assert.equal(d('rebase (finish): returning to refs/heads/feat').kind, 'rebase');
  assert.equal(d('rebase -i (finish): returning to refs/heads/feat').kind, 'rebase');
  assert.equal(d('pull --rebase (finish): returning to refs/heads/feat').kind, 'rebase');
  assert.equal(d('rebase (pick): add thing').kind, 'rebaseStep');
  assert.equal(d('rebase (abort): returning to refs/heads/feat').kind, 'rebaseStep');
  assert.equal(d('reset: moving to HEAD~1').text, 'Reset to HEAD~1');
  assert.equal(d('cherry-pick: port fix').kind, 'cherryPick');
  assert.equal(d('revert: Revert "x"').kind, 'revert');
  assert.equal(d('squash: 3 commits into "x"').kind, 'squash');
  assert.equal(d('branch: Created from HEAD').text, 'Branch created from HEAD');
  assert.equal(d('something new').kind, 'other');
});

test('planUndo picks a safe way back for each kind of action', () => {
  const e = (subject, hash = 'b'.repeat(40)) => ({ hash, short: hash.slice(0, 7), subject, ...recovery.describeReflog(subject) });
  const prev = e('commit: before', 'a'.repeat(40));
  assert.match(recovery.planUndo([]).reason, /nothing to undo/);
  assert.match(recovery.planUndo([e('commit (initial): first')]).reason, /first commit/);
  const commit = recovery.planUndo([e('commit: work'), prev]);
  assert.equal(commit.mode, 'soft');
  assert.equal(commit.target, 'a'.repeat(40));
  assert.deepEqual(recovery.undoArgs(commit), ['reset', '--soft', 'a'.repeat(40)]);
  assert.equal(recovery.planUndo([e('commit (amend): work'), prev]).mode, 'soft');
  for (const s of ['merge feature: Fast-forward', 'pull: Fast-forward', 'rebase (finish): refs/heads/x onto abc', 'reset: moving to HEAD~2', 'cherry-pick: x', 'revert: Revert "x"', 'squash: 2 commits']) {
    assert.equal(recovery.planUndo([e(s), prev]).mode, 'keep', s);
  }
  const sw = recovery.planUndo([e('checkout: moving from main to feat'), prev]);
  assert.deepEqual(recovery.undoArgs(sw), ['switch', '--end-of-options', 'main']);
  assert.match(recovery.planUndo([e('rebase (pick): x'), prev]).reason, /rebase is in progress/);
  assert.match(recovery.planUndo([e('branch: Created from main'), prev]).reason, /just created/);
});

test('undo last commit keeps its changes staged, and the undo can itself be undone', async () => {
  const r = repoWith(2);
  try {
    state.answers = ['Undo'];
    assert.equal(await recovery.undoLastAction({ root: r.root }), true);
    assert.equal(head(r), r.shas[0]);
    assert.deepEqual(staged(r), ['f2.txt']);
    // The reset is now the last action; undoing it brings the commit back.
    state.answers = ['Undo'];
    assert.equal(await recovery.undoLastAction({ root: r.root }), true);
    assert.equal(head(r), r.shas[1]);
    assert.deepEqual(staged(r), []);
  } finally {
    r.cleanup();
  }
});

test('undo is cancelled when the confirmation is dismissed', async () => {
  const r = repoWith(2);
  try {
    state.answers = [undefined];
    assert.equal(await recovery.undoLastAction({ root: r.root }), false);
    assert.equal(head(r), r.shas[1]);
  } finally {
    r.cleanup();
  }
});

test('undo an amend restores the original commit', async () => {
  const r = repoWith(2);
  try {
    r.git('commit', '--amend', '-q', '-m', 'commit 2 reworded');
    state.answers = ['Undo'];
    await recovery.undoLastAction({ root: r.root });
    assert.equal(head(r), r.shas[1]);
    assert.equal(subject(r), 'commit 2');
  } finally {
    r.cleanup();
  }
});

test('undo a merge moves the branch back', async () => {
  const r = repoWith(1);
  try {
    r.git('switch', '-q', '-c', 'feature');
    r.write('feature.txt', 'x\n');
    r.commit('feature work');
    r.git('switch', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '--no-edit', 'feature');
    state.answers = ['Undo'];
    await recovery.undoLastAction({ root: r.root });
    assert.equal(head(r), r.shas[0]);
    assert.equal(fs.existsSync(path.join(r.root, 'feature.txt')), false);
  } finally {
    r.cleanup();
  }
});

test('undo refuses to overwrite uncommitted changes', async () => {
  const r = repoWith(1);
  try {
    r.git('switch', '-q', '-c', 'feature');
    r.write('f1.txt', 'feature\n');
    r.commit('feature edit');
    r.git('switch', '-q', 'main');
    r.git('merge', '-q', '--ff-only', 'feature');
    r.write('f1.txt', 'local edit\n');
    state.answers = ['Undo'];
    await assert.rejects(recovery.undoLastAction({ root: r.root }), /protect your uncommitted changes/);
    assert.equal(fs.readFileSync(path.join(r.root, 'f1.txt'), 'utf8'), 'local edit\n');
  } finally {
    r.cleanup();
  }
});

test('a pushed commit offers Revert Instead', async () => {
  const r = repoWith(2);
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-origin-')));
  try {
    r.git('init', '-q', '--bare', '-b', 'main', bare);
    r.git('remote', 'add', 'origin', bare);
    r.git('push', '-q', '-u', 'origin', 'main');
    state.answers = ['Revert Instead'];
    await recovery.undoLastAction({ root: r.root });
    assert.match(subject(r), /^Revert "commit 2"/);
    assert.equal(fs.existsSync(path.join(r.root, 'f2.txt')), false);
    assert.equal(r.git('rev-parse', 'HEAD~1').trim(), r.shas[1]);
  } finally {
    r.cleanup();
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('undoCommit only works on the latest commit', async () => {
  const r = repoWith(3);
  try {
    await assert.rejects(recovery.undoCommit({ root: r.root, commit: { hash: r.shas[1], short: 'x', subject: 'commit 2' } }), /latest commit/);
    state.answers = ['Undo'];
    await recovery.undoCommit({ root: r.root, commit: { hash: r.shas[2], short: 'x', subject: 'commit 3' } });
    assert.equal(head(r), r.shas[1]);
    assert.deepEqual(staged(r), ['f3.txt']);
  } finally {
    r.cleanup();
  }
});

test('squash combines commits into one with the same files, and undo brings them back', async () => {
  const r = repoWith(4);
  try {
    const before = head(r);
    const tree = r.git('rev-parse', 'HEAD^{tree}').trim();
    state.answers = ['Squashed work', 'Squash'];
    const sha = await recovery.squashFrom({ root: r.root, commit: { hash: r.shas[1], short: r.shas[1].slice(0, 7), subject: 'commit 2' } });
    assert.equal(head(r), sha);
    assert.equal(r.git('rev-parse', 'HEAD^').trim(), r.shas[0]);
    assert.equal(r.git('rev-parse', 'HEAD^{tree}').trim(), tree);
    const message = r.git('log', '-1', '--format=%B').trim();
    assert.equal(message, 'Squashed work\n\n* commit 2\n* commit 3\n* commit 4');
    const [top] = await recovery.readReflog(r.root, 'refs/heads/main', 1);
    assert.equal(top.kind, 'squash');
    state.answers = ['Undo'];
    await recovery.undoLastAction({ root: r.root });
    assert.equal(head(r), before);
  } finally {
    r.cleanup();
  }
});

test('squash refuses the latest commit and ranges with merges', async () => {
  const r = repoWith(2);
  try {
    assert.equal(await recovery.squashFrom({ root: r.root, commit: { hash: r.shas[1], short: 'x', subject: 'x' } }), false);
    r.git('switch', '-q', '-c', 'side', r.shas[0]);
    r.write('side.txt', 's\n');
    r.commit('side');
    r.git('switch', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '--no-edit', 'side');
    await assert.rejects(recovery.squashFrom({ root: r.root, commit: { hash: r.shas[1], short: 'x', subject: 'x' } }), /merge commit/);
  } finally {
    r.cleanup();
  }
});

test('cherry-pick applies a commit from another branch and skips ones already there', async () => {
  const r = repoWith(1);
  try {
    r.git('switch', '-q', '-c', 'feature');
    r.write('picked.txt', 'p\n');
    const pick = r.commit('feature: picked');
    r.git('switch', '-q', 'main');
    const node = { root: r.root, commit: { hash: pick, short: pick.slice(0, 7), subject: 'feature: picked', parents: [r.shas[0]] } };
    assert.equal(await recovery.cherryPick(node), 'ok');
    assert.equal(subject(r), 'feature: picked');
    assert.ok(fs.existsSync(path.join(r.root, 'picked.txt')));
    assert.equal(await recovery.cherryPick({ ...node, commit: { ...node.commit, hash: r.shas[0] } }), 'skipped');
  } finally {
    r.cleanup();
  }
});

test('revert adds a commit that undoes another', async () => {
  const r = repoWith(2);
  try {
    state.answers = ['Revert'];
    assert.equal(await recovery.revertCommit({ root: r.root, commit: { hash: r.shas[1], short: 'x', subject: 'commit 2', parents: [r.shas[0]] } }), 'ok');
    assert.equal(subject(r), 'Revert "commit 2"');
    assert.equal(fs.existsSync(path.join(r.root, 'f2.txt')), false);
  } finally {
    r.cleanup();
  }
});

test('hard reset saves a backup branch first', async () => {
  const r = repoWith(3);
  try {
    const before = head(r);
    state.answers = [(items) => items.find((i) => i.mode === 'hard'), 'Reset'];
    assert.equal(await recovery.resetTo({ root: r.root, commit: { hash: r.shas[0], short: r.shas[0].slice(0, 7), subject: 'commit 1' } }), true);
    assert.equal(head(r), r.shas[0]);
    const backups = r.git('for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/backup').trim().split('\n');
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(`^backup/main-\\d{8}-\\d{6} ${before}$`));
  } finally {
    r.cleanup();
  }
});

test('soft reset keeps the changes staged', async () => {
  const r = repoWith(3);
  try {
    state.answers = [(items) => items.find((i) => i.mode === 'soft'), 'Reset'];
    await recovery.resetTo({ root: r.root, commit: { hash: r.shas[0], short: 'x', subject: 'commit 1' } });
    assert.equal(head(r), r.shas[0]);
    assert.deepEqual(staged(r).sort(), ['f2.txt', 'f3.txt']);
    assert.equal(r.git('branch', '--list', 'backup/*').trim(), '');
  } finally {
    r.cleanup();
  }
});

test('create a branch and a tag at a commit', async () => {
  const r = repoWith(2);
  try {
    state.answers = ['from-here', undefined];
    assert.equal(await recovery.createBranchAt(r.root, r.shas[0]), 'from-here');
    assert.equal(r.git('rev-parse', 'from-here').trim(), r.shas[0]);
    state.answers = ['from-here'];
    await assert.rejects(recovery.createBranchAt(r.root, r.shas[0]), /already exists/);
    state.answers = ['v0.1.0', 'First release', undefined];
    assert.equal(await recovery.createTagAt({ root: r.root, commit: { hash: r.shas[0], short: 'x' } }), 'v0.1.0');
    assert.equal(r.git('cat-file', '-t', 'v0.1.0').trim(), 'tag');
    assert.equal(r.git('rev-parse', 'v0.1.0^{commit}').trim(), r.shas[0]);
    assert.equal(recovery.validateRefName('-x'), 'That is not a valid git name');
    assert.equal(recovery.validateRefName('a b'), 'That is not a valid git name');
    assert.equal(recovery.validateRefName('feat/ok-1'), undefined);
  } finally {
    r.cleanup();
  }
});

test('amend changes the message and adds staged files', async () => {
  const r = repoWith(2);
  try {
    r.write('extra.txt', 'e\n');
    r.git('add', 'extra.txt');
    state.answers = ['commit 2, now complete'];
    assert.equal(await recovery.amendLastCommit({ root: r.root }), true);
    assert.equal(subject(r), 'commit 2, now complete');
    assert.match(r.git('show', '--name-only', '--format=', 'HEAD'), /extra\.txt/);
    assert.equal(r.git('rev-parse', 'HEAD^').trim(), r.shas[0]);
    state.answers = ['commit 2, now complete'];
    assert.equal(await recovery.amendLastCommit({ root: r.root }), false);
  } finally {
    r.cleanup();
  }
});

test('recovery finds deleted branches whose commits would be lost, and restores them', async () => {
  const r = repoWith(1);
  const context = createContext();
  try {
    state.repos = [makeRepo(r.root, 'main')];
    await g.getGitApi();
    views.register(context);
    recovery.register(context);
    r.git('switch', '-q', '-c', 'lost-work');
    r.write('lost.txt', 'l\n');
    const lost = r.commit('lost work');
    r.git('switch', '-q', 'main');
    r.git('switch', '-q', '-c', 'merged-work');
    r.git('switch', '-q', 'main');
    r.git('branch', '-D', 'lost-work');
    r.git('branch', '-D', 'merged-work');
    const reflog = await recovery.readReflog(r.root, 'HEAD', 50);
    assert.equal(reflog[0].kind, 'checkout');
    const found = await recovery.deletedCandidates(r.root, reflog);
    assert.deepEqual(found.map((d) => [d.name, d.sha]), [['lost-work', lost]]);

    const nodes = await state.trees.get(recovery.VIEW_ID).provider.getChildren();
    const group = nodes.find((n) => n.type === 'recGroup');
    assert.equal(group.items[0].name, 'lost-work');
    const item = state.trees.get(recovery.VIEW_ID).provider.getTreeItem(nodes.find((n) => n.type === 'reflog'));
    assert.equal(item.contextValue, 'reflog:current');

    state.answers = [undefined];
    assert.equal(await recovery.restoreBranch(group.items[0]), 'lost-work');
    assert.equal(r.git('rev-parse', 'lost-work').trim(), lost);
  } finally {
    for (const d of context.subscriptions) d?.dispose?.();
    r.cleanup();
  }
});

test('branches deleted from the Branches view are remembered for recovery', async () => {
  const r = repoWith(1);
  const context = createContext();
  try {
    state.repos = [makeRepo(r.root, 'main')];
    await g.getGitApi();
    views.register(context);
    r.git('branch', 'old-idea');
    const sha = r.git('rev-parse', 'old-idea').trim();
    state.answers = ['Delete'];
    await state.commands.get('gitCompass.branch.delete')({ root: r.root, branch: { name: 'old-idea' } });
    assert.equal(r.git('branch', '--list', 'old-idea').trim(), '');
    assert.deepEqual(views.deletedBranches(r.root).map((d) => [d.name, d.sha]), [['old-idea', sha]]);
    await views.forgetDeletedBranch(r.root, 'old-idea');
    assert.deepEqual(views.deletedBranches(r.root), []);
  } finally {
    for (const d of context.subscriptions) d?.dispose?.();
    r.cleanup();
  }
});

test('go back to a reflog entry saves a backup branch', async () => {
  const r = repoWith(3);
  try {
    const before = head(r);
    const reflog = await recovery.readReflog(r.root, 'HEAD', 10);
    const target = reflog.find((e) => e.hash === r.shas[0]);
    state.answers = [(items) => items.find((i) => i.id === 'move'), 'Move Back'];
    assert.equal(await recovery.restoreToEntry({ root: r.root, entry: target }), true);
    assert.equal(head(r), r.shas[0]);
    assert.match(r.git('for-each-ref', '--format=%(objectname)', 'refs/heads/backup').trim(), new RegExp(before));
  } finally {
    r.cleanup();
  }
});

test('backup names are sortable timestamps', () => {
  assert.equal(recovery.backupName('feat/x', new Date(2026, 0, 2, 3, 4, 5)), 'backup/feat/x-20260102-030405');
  assert.equal(recovery.backupName('', new Date(2026, 0, 2, 3, 4, 5)), 'backup/detached-20260102-030405');
});

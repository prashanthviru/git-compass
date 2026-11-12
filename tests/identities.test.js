const { state, reset, makeRepo } = require('./helpers/vscode');
const { createRepo } = require('./helpers/repo');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../git');
const id = require('../identities');

let repo;

before(async () => {
  reset();
  repo = createRepo();
  repo.write('a.txt', 'a\n');
  repo.commit('init');
  repo.git('remote', 'add', 'origin', 'git@github.com:Acme/widgets.git');
  state.repos = [makeRepo(repo.root, 'main')];
  await g.getGitApi();
});

after(() => repo.cleanup());

const personal = id.normalize({ label: 'Personal', name: 'Ann', email: 'ann@gmail.com', match: ['github.com/ann/'] });
const work = id.normalize({ label: 'Work', name: 'Ann Lee', email: 'ann@acme.com', githubAccount: 'ann-acme', match: ['github.com/acme/'] });
const team = id.normalize({ label: 'Widgets team', name: 'Ann Lee', email: 'ann@widgets.acme.com', match: ['github.com/acme/widgets'] });

test('remoteKey normalises https, ssh and scp remotes', () => {
  assert.equal(id.remoteKey('https://github.com/Acme/Widgets.git'), 'github.com/acme/widgets');
  assert.equal(id.remoteKey('git@github.com:Acme/widgets.git'), 'github.com/acme/widgets');
  assert.equal(id.remoteKey('ssh://git@gitlab.example.com:22/team/app'), 'gitlab.example.com/team/app');
  assert.equal(id.remoteKey('https://user:pw@bitbucket.org/team/repo/'), 'bitbucket.org/team/repo');
  assert.equal(id.remoteKey(''), '');
});

test('matchIdentity picks the most specific rule', () => {
  assert.equal(id.matchIdentity([personal, work], 'git@github.com:acme/api.git'), work);
  assert.equal(id.matchIdentity([personal, work, team], 'https://github.com/Acme/widgets.git'), team);
  assert.equal(id.matchIdentity([personal, work], 'https://github.com/ann/notes'), personal);
  assert.equal(id.matchIdentity([personal, work], 'https://github.com/acmecorp/x'), undefined);
  assert.equal(id.matchIdentity([personal, work], ''), undefined);
});

test('parseGhAccounts reads every signed-in account and the active one', () => {
  const out = `github.com
  ✓ Logged in to github.com account ann-acme (keyring)
  - Active account: true
  - Git operations protocol: https
  ✓ Logged in to github.com account ann (keyring)
  - Active account: false`;
  assert.deepEqual(id.parseGhAccounts(out), [
    { host: 'github.com', user: 'ann-acme', active: true },
    { host: 'github.com', user: 'ann', active: false },
  ]);
  assert.deepEqual(id.parseGhAccounts('  ✓ Logged in to github.com as old-style (oauth_token)'), [{ host: 'github.com', user: 'old-style', active: true }]);
  assert.deepEqual(id.parseGhAccounts('You are not logged into any GitHub hosts.'), []);
});

test('sshCommandFor quotes the key path for the shell', () => {
  assert.equal(id.sshCommandFor('/keys/work key'), "ssh -i '/keys/work key' -o IdentitiesOnly=yes");
  assert.equal(id.sshCommandFor("/keys/it's"), "ssh -i '/keys/it'\\''s' -o IdentitiesOnly=yes");
  assert.equal(id.sshCommandFor('C:\\Users\\ann\\.ssh\\id_work'), "ssh -i 'C:/Users/ann/.ssh/id_work' -o IdentitiesOnly=yes");
});

test('applyIdentity sets the repository identity and SSH key, and clears the key again', async () => {
  const withKey = id.normalize({ ...personal, sshKey: '/keys/id_personal' });
  await id.applyIdentity(repo.root, withKey, 'repository', { switchGithub: false });
  const current = await id.currentIdentity(repo.root);
  assert.equal(current.name, 'Ann');
  assert.equal(current.email, 'ann@gmail.com');
  assert.equal(current.scope, 'repository');
  assert.equal(current.sshCommand, "ssh -i '/keys/id_personal' -o IdentitiesOnly=yes");
  assert.equal(id.remoteKey(current.origin), 'github.com/acme/widgets');
  assert.ok(id.sameIdentity(withKey, current));

  await id.applyIdentity(repo.root, work, 'repository', { switchGithub: false });
  const after = await id.currentIdentity(repo.root);
  assert.equal(after.email, 'ann@acme.com');
  assert.equal(after.sshCommand, '');
});

test('identities ignores incomplete entries from settings', () => {
  state.config['gitCompass.identities'] = [{ name: 'Ann', email: 'ann@gmail.com' }, { name: 'No email' }, null];
  assert.deepEqual(id.identities().map((i) => i.label), ['Ann']);
  delete state.config['gitCompass.identities'];
});

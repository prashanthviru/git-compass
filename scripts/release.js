#!/usr/bin/env node
// Cuts a release: bumps the version, moves the [Unreleased] notes in CHANGELOG.md under
// the new version, commits, tags vX.Y.Z and pushes. Pushing the tag starts the Release
// workflow, which tests, publishes and creates the GitHub Release with these notes.
//
//   npm run release -- patch             0.2.1 -> 0.2.2
//   npm run release -- minor             0.2.1 -> 0.3.0
//   npm run release -- major             0.2.1 -> 1.0.0
//   npm run release -- 1.4.0             an exact version
//   npm run release -- patch --dry-run   show what would happen, change nothing

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const changelog = require('./changelog');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(ROOT, f), s);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function nextVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump;
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('Say which release to make: patch, minor, major, or an exact version like 1.2.3.');
}

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const bump = args.find((a) => !a.startsWith('--'));

  const pkgText = read('package.json');
  const current = JSON.parse(pkgText).version;
  const version = nextVersion(current, bump);
  if (!newer(version, current)) throw new Error(`${version} is not newer than the current version ${current}.`);
  const tag = `v${version}`;
  const date = new Date().toISOString().slice(0, 10);

  if (!dryRun) {
    if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') throw new Error('Releases are made from main. Switch to main first.');
    if (git('status', '--porcelain')) throw new Error('Commit or stash your changes first; the working tree is not clean.');
    git('fetch', '--quiet', 'origin', 'main', '--tags');
    if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) throw new Error('main is not the same as origin/main. Pull or push first.');
    if (git('tag', '--list', tag)) throw new Error(`Tag ${tag} already exists.`);
  }

  const nextChangelog = changelog.release(read('CHANGELOG.md'), version, date, current);
  const notes = changelog.notes(nextChangelog, version);
  console.log(`Release ${current} -> ${version} (${tag})\n\nRelease notes:\n\n${notes}\n`);
  if (dryRun) {
    console.log('Dry run: nothing was changed.');
    return;
  }

  console.log('Running tests…');
  execFileSync(process.execPath, ['--test'], { cwd: ROOT, stdio: 'inherit' });

  write('package.json', pkgText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
  write('CHANGELOG.md', nextChangelog);
  const readme = read('README.md');
  write('README.md', readme.replace(/Git Compass is at \d+\.\d+\.\d+/, `Git Compass is at ${version}`));

  git('add', 'package.json', 'CHANGELOG.md', 'README.md');
  git('commit', '-q', '-m', `release: ${tag}`);
  git('tag', '-a', tag, '-m', `Git Compass ${version}\n\n${notes}`);
  git('push', '--atomic', 'origin', 'main', tag);
  console.log(`\nPushed ${tag}. The Release workflow now publishes it:\n  https://github.com/prashanthviru/git-compass/actions/workflows/release.yml`);
}

try {
  main();
} catch (e) {
  console.error(`release: ${e.message}`);
  process.exit(1);
}

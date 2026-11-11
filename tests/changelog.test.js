const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const changelog = require('../scripts/changelog');

const SAMPLE = `# Changelog

Intro.

## [Unreleased]

### Fixed
- A bug.

## [0.2.0] - 2026-11-11

First Marketplace release.

### Added
- A feature.

[Unreleased]: https://github.com/prashanthviru/git-compass/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/prashanthviru/git-compass/compare/v0.1.0...v0.2.0
`;

test('notes returns one version section without its heading or links', () => {
  assert.equal(changelog.notes(SAMPLE, '0.2.0'), 'First Marketplace release.\n\n### Added\n- A feature.');
  assert.throws(() => changelog.notes(SAMPLE, '9.9.9'), /no "## \[9\.9\.9\]" section/);
});

test('release moves Unreleased notes under the new version and updates links', () => {
  const out = changelog.release(SAMPLE, '0.2.1', '2026-12-01', '0.2.0');
  assert.equal(changelog.section(out, 'Unreleased'), '');
  assert.equal(changelog.notes(out, '0.2.1'), '### Fixed\n- A bug.');
  assert.equal(changelog.notes(out, '0.2.0'), 'First Marketplace release.\n\n### Added\n- A feature.');
  assert.match(out, /## \[0\.2\.1\] - 2026-12-01/);
  assert.match(out, /^\[Unreleased\]: .*compare\/v0\.2\.1\.\.\.HEAD$/m);
  assert.match(out, /^\[0\.2\.1\]: .*compare\/v0\.2\.0\.\.\.v0\.2\.1$/m);
});

test('release refuses an empty Unreleased section or an existing version', () => {
  const released = changelog.release(SAMPLE, '0.2.1', '2026-12-01', '0.2.0');
  assert.throws(() => changelog.release(released, '0.2.2', '2026-12-02', '0.2.1'), /Nothing to release/);
  assert.throws(() => changelog.release(SAMPLE, '0.2.0', '2026-12-02', '0.1.0'), /already has a section/);
});

test('release keeps CRLF line endings', () => {
  const out = changelog.release(SAMPLE.replace(/\n/g, '\r\n'), '0.2.1', '2026-12-01', '0.2.0');
  assert.ok(!/[^\r]\n/.test(out));
});

test('the real CHANGELOG has notes for the current version', () => {
  const root = path.join(__dirname, '..');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(changelog.notes(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), version).length > 0);
});

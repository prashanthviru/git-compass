#!/usr/bin/env node
// Reads and updates CHANGELOG.md (Keep a Changelog format).
//
//   node scripts/changelog.js notes 0.2.1   prints the notes for 0.2.1 (used for GitHub Releases)
//   node scripts/changelog.js unreleased    prints the notes waiting under [Unreleased]

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'CHANGELOG.md');
const REPO = 'https://github.com/prashanthviru/git-compass';

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The body of "## [name]" up to the next "## [" heading or the link references.
function section(text, name) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## \\[${escape(name)}\\]`).test(l));
  if (start === -1) return undefined;
  let end = lines.findIndex((l, i) => i > start && (/^## \[/.test(l) || /^\[[^\]]+\]: /.test(l)));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

function notes(text, version) {
  const body = section(text, version);
  if (body === undefined) throw new Error(`CHANGELOG.md has no "## [${version}]" section.`);
  if (!body) throw new Error(`The "## [${version}]" section in CHANGELOG.md is empty.`);
  return body;
}

// Moves everything under [Unreleased] into a new version section and updates the compare links.
function release(text, version, date, previous) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const src = text.replace(/\r\n/g, '\n');
  if (section(src, version) !== undefined) throw new Error(`CHANGELOG.md already has a section for ${version}.`);
  const pending = section(src, 'Unreleased');
  if (pending === undefined) throw new Error('CHANGELOG.md has no "## [Unreleased]" section.');
  if (!pending) throw new Error('Nothing to release: the [Unreleased] section in CHANGELOG.md is empty.');
  let out = src.replace(/^## \[Unreleased\][^\n]*\n[\s\S]*?(?=^## \[|^\[[^\]]+\]: |(?![\s\S]))/m, `## [Unreleased]\n\n## [${version}] - ${date}\n\n${pending}\n\n`);
  const unreleasedLink = /^\[Unreleased\]: .*$/m;
  const versionLink = `[${version}]: ${REPO}/compare/v${previous}...v${version}`;
  if (unreleasedLink.test(out)) {
    out = out.replace(unreleasedLink, `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n${versionLink}`);
  } else {
    out = `${out.trimEnd()}\n\n[Unreleased]: ${REPO}/compare/v${version}...HEAD\n${versionLink}\n`;
  }
  return out.replace(/\n/g, eol);
}

if (require.main === module) {
  const [command, version] = process.argv.slice(2);
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    if (command === 'notes' && version) process.stdout.write(`${notes(text, version.replace(/^v/, ''))}\n`);
    else if (command === 'unreleased') process.stdout.write(`${section(text, 'Unreleased') || ''}\n`);
    else {
      console.error('Usage: node scripts/changelog.js notes <version> | unreleased');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { section, notes, release };

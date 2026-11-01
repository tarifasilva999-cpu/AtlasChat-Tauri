'use strict';

// Compute a unique patch version within the current checked-in version line.
// A commit that changes the checked-in version uses that version exactly.
// The generated version exists only in the CI checkout used for this build.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// The independently tagged 1.0.0 commit is the starting point for automation.
const RELEASE_BASE = '33c8df9968f12e57a76b76306b66e55ac9674647';

function releaseVersion(base, count) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (!match || !Number.isSafeInteger(count) || count < 0) throw Error('Expected a numeric app version and a nonnegative commit count.');
  const patch = Number(match[3]) + count;
  if (patch > 65535) throw Error('Release patch exceeds the Windows version limit; advance the minor version.');
  return `${Number(match[1])}.${Number(match[2])}.${patch}`;
}
function commitsSinceVersionChange(versions) {
  if (!Array.isArray(versions) || !versions.length) throw Error('Missing version history.');
  let lastChange=0;
  for(let i=1;i<versions.length;i++)if(versions[i]!==versions[i-1])lastChange=i;
  return versions.length-1-lastChange;
}
function applyVersion(root, version) {
  for (const name of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const file = path.join(root, name), data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.version = version;
    if (name === 'package-lock.json') data.packages[''].version = version;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
  for (const [name, pattern] of [
    ['src-tauri/Cargo.toml', /(\[package\]\s*\nname\s*=\s*"atlaschat-tauri"\s*\nversion\s*=\s*")[^"]+(".*)/],
    ['src-tauri/Cargo.lock', /(\[\[package\]\]\s*\nname\s*=\s*"atlaschat-tauri"\s*\nversion\s*=\s*")[^"]+(".*)/]
  ]) {
    const file = path.join(root, name), source = fs.readFileSync(file, 'utf8');
    if (!pattern.test(source)) throw Error(`Could not find AtlasChat's version in ${name}.`);
    fs.writeFileSync(file, source.replace(pattern, (_match, start, end) => start + version + end));
  }
}
if (require.main === module) {
  const root = process.cwd();
  const base = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
  execFileSync('git', ['merge-base', '--is-ancestor', RELEASE_BASE, 'HEAD']);
  const commits=execFileSync('git',['rev-list','--first-parent','--reverse',`${RELEASE_BASE}..HEAD`],{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
  if(!commits.length)throw Error('No new main-branch commit to release.');
  const versions=[RELEASE_BASE,...commits].map(commit=>JSON.parse(execFileSync('git',['show',`${commit}:src-tauri/tauri.conf.json`],{encoding:'utf8'})).version);
  const count=commitsSinceVersionChange(versions);
  const version = releaseVersion(base, count);
  applyVersion(root, version);
  if (!process.env.GITHUB_OUTPUT) throw Error('GITHUB_OUTPUT is required for the release workflow.');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`);
  console.log(`Building AtlasChat ${version} for commit ${process.env.GITHUB_SHA || 'HEAD'}.`);
}
module.exports = { releaseVersion, commitsSinceVersionChange, applyVersion };

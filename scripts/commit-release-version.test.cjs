'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { releaseVersion, applyVersion } = require('./commit-release-version.cjs');

test('each main commit has a higher valid Windows release version', () => {
  assert.equal(releaseVersion('1.0.0', 1), '1.0.1');
  assert.equal(releaseVersion('1.0.0', 2), '1.0.2');
  assert.equal(releaseVersion('1.1.2', 2), '1.1.4');
  assert.throws(() => releaseVersion('1.0.0-rc1', 18));
  assert.throws(() => releaseVersion('1.0.65535', 1));
});
test('CI applies the version consistently to package, Tauri, and Cargo files', t => {
  const root = fs.mkdtempSync(path.join(__dirname, '..', '.release-test-'));
  if (!root.startsWith(path.resolve(__dirname, '..') + path.sep)) throw Error('Unsafe test directory.');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"version":"1.0.0","packages":{"":{"version":"1.0.0"}}}');
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), '{"version":"1.0.0"}');
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "atlaschat-tauri"\nversion = "1.0.0"\n');
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "atlaschat-tauri"\nversion = "1.0.0"\n');
  applyVersion(root, '1.0.17');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages[''].version, '1.0.17');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).version, '1.0.17');
  assert.match(fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'), /version = "1\.0\.17"/);
});

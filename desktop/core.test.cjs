'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store, files, projectPath, dependencyPlan, fingerprint } = require('./core.cjs');
test('portable relative paths and nested folders', () => {
  assert.equal(projectPath('src/components/app.ts'), 'src/components/app.ts');
  for (const bad of ['../a', '/a', 'C:/a', 'a\\b', 'a/../../b', 'CON.txt', 'a.', 'node_modules/a', '.git/config', 'a//b']) {
    assert.throws(() => projectPath(bad), undefined, bad);
  }
  assert.throws(() => files([{ path: 'a.py', content: '' }, { path: 'A.py', content: '' }]));
  assert.throws(() => files([{ path: 'a.py', content: 'a'.repeat(65537) }]));
});
test('dependency requests restrict package origins', () => {
  const python = content => dependencyPlan([{ path: 'requirements.txt', content }], 'python');
  assert.equal(python('requests==2.32.3').packages[0], 'requests==2.32.3');
  for (const bad of ['-r private.txt', '--index-url https://evil.invalid', 'git+https://evil.invalid/a', 'foo @ file:///tmp/a']) assert.throws(() => python(bad));
  const npm = dependencies => dependencyPlan([{ path: 'package.json', content: JSON.stringify({ dependencies }) }], 'web');
  assert.equal(npm({ typescript: '5.7.3' }).packages[0], 'typescript@5.7.3');
  assert.throws(() => npm({ package: 'file:../a' }));
  assert.throws(() => npm({ package: 'https://evil.invalid/a.tgz' }));
});
test('project files persist separately and unfinished runs recover', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-core-'));
  try {
    const store = new Store(root); await store.init();
    const run = await store.create({ title: 'Example', runtime: 'python', entrypoint: 'src/main.py' });
    const source = [{ path: 'src/main.py', content: 'print("hello")\n' }];
    await store.save(run.id, source);
    await store.event(run.id, { stage: 'Running', text: 'python src/main.py' });
    assert.deepEqual(await store.source(run.id), source);
    assert.equal((await store.read(run.id)).sourceHash, fingerprint(source));
    await store.recover();
    assert.equal((await store.read(run.id)).status, 'interrupted');
    assert.equal((await store.read(run.id)).events.length, 1);
    await store.save(run.id, []);
    assert.deepEqual(await store.source(run.id), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

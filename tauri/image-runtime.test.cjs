'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ImageRuntime, WEIGHTS } = require('./image-runtime.cjs');
const ROOT = path.resolve(__dirname, '..');

function child() {
  const process = new EventEmitter(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  return process;
}
test('image generation invokes the pinned Turbo pipeline and returns a PNG', async t => {
  const directory = await fs.mkdtemp(path.join(ROOT, '.atlas-image-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [], png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(32)]);
  const image = new ImageRuntime(directory, event => events.push(event), (_exe, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(args[args.indexOf('--sigmas') + 1], 'qwen-image-2.1-turbo');
    assert.equal(args[args.indexOf('--llm') + 1], 'encoder');
    assert.equal(args[args.indexOf('--diffusion-model') + 1], 'denoiser');
    assert.equal(args[args.indexOf('-p') + 1], 'a tree');
    const p = child();
    setImmediate(async () => { await fs.writeFile(args[args.indexOf('-o') + 1], png); p.emit('close', 0); });
    return p;
  });
  image.ready = { executable: path.join(directory, 'sd-cli.exe'), encoder: 'encoder', denoiser: 'denoiser', vae: 'vae' };
  const result = await image.generate({ prompt: ' a tree ' });
  assert.deepEqual(Buffer.from(result.png, 'base64'), png);
  assert.equal(result.width, 512); assert.ok(events.some(event => event.stage === 'build-engine'));
  assert.deepEqual(await fs.readdir(directory), []);
  assert.deepEqual(WEIGHTS.map(item => item.key), ['encoder', 'denoiser', 'vae']);
});
test('stopping an image kills the runner and removes its temporary output', async t => {
  const directory = await fs.mkdtemp(path.join(ROOT, '.atlas-image-stop-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const image = new ImageRuntime(directory, () => {}, () => {
    const p = child(); p.kill = () => { setImmediate(() => p.emit('close', 1)); return true; }; started(); return p;
  });
  image.ready = { executable: path.join(directory, 'sd-cli.exe'), encoder: 'encoder', denoiser: 'denoiser', vae: 'vae' };
  const pending = image.generate({ prompt: 'a tree' });
  await waiting; image.cancel();
  await assert.rejects(pending, /stopped/);
  assert.deepEqual(await fs.readdir(directory), []);
});

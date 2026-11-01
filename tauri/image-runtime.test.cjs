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
test('image generation invokes the pinned Qwen base pipeline and returns a PNG', async t => {
  const directory = await fs.mkdtemp(path.join(ROOT, '.atlas-image-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [], png = Buffer.alloc(56);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(1024, 16); png.writeUInt32BE(1024, 20);
  const image = new ImageRuntime(directory, event => events.push(event), (_exe, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(args[args.indexOf('--llm') + 1], 'encoder');
    assert.equal(args[args.indexOf('--diffusion-model') + 1], 'denoiser');
    assert.equal(args[args.indexOf('-p') + 1], 'a tree');
    assert.equal(args[args.indexOf('--steps') + 1], '40');
    assert.equal(args[args.indexOf('--cfg-scale') + 1], '6.0');
    assert.equal(args.includes('--sigmas'), false);
    assert.equal(args[args.indexOf('-W') + 1], '1024');
    assert.equal(args[args.indexOf('-H') + 1], '1024');
    const p = child();
    setImmediate(async () => { await fs.writeFile(args[args.indexOf('-o') + 1], png); p.emit('close', 0); });
    return p;
  });
  image.ready = { executable: path.join(directory, 'sd-cli.exe'), encoder: 'encoder', denoiser: 'denoiser', vae: 'vae' };
  const result = await image.generate({ prompt: ' a tree ' });
  assert.deepEqual(Buffer.from(result.png, 'base64'), png);
  assert.equal(result.width, 1024); assert.ok(events.some(event => event.stage === 'build-engine'));
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

test('selected 2x output downloads its pinned upscaler and returns the larger PNG', async t => {
  const directory = await fs.mkdtemp(path.join(ROOT, '.atlas-image-upscale-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [], downloads = [];
  const pngFor = (width, height) => {
    const png = Buffer.alloc(56);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
    png.writeUInt32BE(width, 16); png.writeUInt32BE(height, 20);
    return png;
  };
  const image = new ImageRuntime(directory, event => events.push(event), (_exe, args) => {
    const p = child(), output = args[args.indexOf('-o') + 1];
    if (args.includes('--upscale-model')) {
      assert.equal(args[args.indexOf('-M') + 1], 'upscale');
      assert.equal(args[args.indexOf('--upscale-tile-size') + 1], '128');
      assert.equal(args[args.indexOf('--upscale-model') + 1], downloads[0].destination);
      setImmediate(async () => { await fs.writeFile(output, pngFor(2048, 1152)); p.emit('close', 0); });
    } else {
      assert.equal(args[args.indexOf('-W') + 1], '1024');
      assert.equal(args[args.indexOf('-H') + 1], '576');
      setImmediate(async () => { await fs.writeFile(output, pngFor(1024, 576)); p.emit('close', 0); });
    }
    return p;
  }, async item => {
    downloads.push(item);
    await fs.mkdir(path.dirname(item.destination), { recursive: true });
    await fs.writeFile(item.destination, 'fixture model');
    return item.destination;
  });
  image.ready = { executable: path.join(directory, 'sd-cli.exe'), encoder: 'encoder', denoiser: 'denoiser', vae: 'vae' };
  const result = await image.generate({ prompt: 'a landscape', width: 1024, height: 576, upscale: '2x' });
  assert.equal(result.width, 2048); assert.equal(result.height, 1152);
  assert.equal(downloads.length, 1); assert.equal(downloads[0].key, 'upscaler2x');
  assert.match(downloads[0].url, /\/64b5812d1cfd8f5edf06cdf31fa0677163a77c35\/2x-ESRGAN\.gguf$/);
  assert.ok(events.some(event => event.stage === 'upscale'));
  await assert.rejects(image.generate({ prompt: 'a landscape', width: 1000, height: 576 }), /multiples of 32/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { NativeInference, messagesFor, readSSE } = require('./native-inference.cjs');
const { runtimeFor, modelFor, contextFor } = require('./native-catalog.cjs');
const { downloadVerified, archivePath, unpackRuntime } = require('./native-download.cjs');
// The command sandbox's system temp folder disallows rename. Use owned fixture
// folders in the writable project, where atomic file publication is supported.
const TEST_ROOT = path.resolve(__dirname, '..');

test('native choices keep one Apex weight set across efforts and cap context by physical RAM', () => {
  assert.equal(modelFor('apex-ultra').repo, 'unsloth/Qwen3.5-4B-GGUF');
  assert.equal(modelFor('ultra-code').files[0].name, 'gemma4-v2-Q4_K_M.gguf');
  assert.equal(modelFor('forge').repo, 'openbmb/MiniCPM5-2B-GGUF');
  assert.equal(modelFor('firefly'), modelFor('forge'));
  assert.equal(contextFor(32768, 8 * 1024 ** 3), 8192);
  assert.equal(contextFor(32768, 16 * 1024 ** 3), 16384);
  assert.equal(contextFor(32768, 32 * 1024 ** 3), 32768);
  assert.equal(runtimeFor('win32', 'x64').backend, 'vulkan');
  assert.equal(runtimeFor('win32', 'x64', true).backend, 'cpu');
  assert.equal(runtimeFor('darwin', 'arm64').backend, 'metal');
  assert.throws(() => modelFor('../../anything'));
  assert.throws(() => modelFor('constructor'));
  assert.throws(() => runtimeFor('win32', 'ia32'));
});
test('resumed downloads are hashed before publishing, and verified cache avoids network', async t => {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, '.atlas-native-download-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('known model bytes'), destination = path.join(directory, 'model.gguf');
  await fs.writeFile(destination + '.part', bytes.subarray(0, 6));
  let calls = 0;
  const options = { url: 'https://example.invalid/model', destination, size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), signal: new AbortController().signal,
    fetchImpl: async (_url, init) => {
      calls++; assert.equal(init.headers.Range, 'bytes=6-');
      return new Response(bytes.subarray(6), { status: 206, headers: { 'Content-Range': `bytes 6-${bytes.length - 1}/${bytes.length}` } });
    } };
  await downloadVerified(options);
  assert.deepEqual(await fs.readFile(destination), bytes);
  await downloadVerified(options);
  assert.equal(calls, 1);
  await assert.rejects(fs.stat(destination + '.part'));
});
test('corrupt downloads never become a runnable model', async t => {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, '.atlas-native-corrupt-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const destination = path.join(directory, 'model.gguf');
  await assert.rejects(downloadVerified({ destination, url: 'https://example.invalid', size: 3,
    sha256: 'a'.repeat(64), signal: new AbortController().signal, fetchImpl: async () => new Response('bad') }), /integrity/);
  await assert.rejects(fs.stat(destination));
  await assert.rejects(fs.stat(destination + '.part'));
});
test('runtime extraction rejects archive traversal and installs only inside its directory', async t => {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, '.atlas-native-archive-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const name of ['../outside', '/absolute', 'C:/absolute', 'inside\\escape']) assert.throws(() => archivePath(directory, name));
  const { zipSync } = require('fflate');
  const archive = path.join(directory, 'runtime.zip');
  await fs.writeFile(archive, zipSync({ 'bin/llama-server.exe': Buffer.from('fixture'), 'bin/library.dll': Buffer.from('fixture') }));
  const server = await unpackRuntime(archive, path.join(directory, 'installed'));
  assert.equal(server, path.join(directory, 'installed', 'bin', 'llama-server.exe'));
  await fs.writeFile(archive, zipSync({ '../escape.exe': Buffer.from('fixture') }));
  await assert.rejects(unpackRuntime(archive, path.join(directory, 'unsafe')), /unsafe path/);
});
test('SSE survives split UTF-8 and CRLF, ignores heartbeat comments, and surfaces errors', async () => {
  const bytes = Buffer.from(': ping\r\n\r\ndata: {"choices":[{"delta":{"content":"héllo"}}]}\r\n\r\ndata: [DONE]\n\n');
  async function* fragments() { for (let offset = 0; offset < bytes.length; offset += 3) yield bytes.subarray(offset, offset + 3); }
  const result = [];
  for await (const chunk of readSSE(fragments(), new AbortController().signal)) result.push(chunk);
  assert.equal(result.length, 1); assert.equal(result[0].choices[0].delta.content, 'héllo');
  async function* error() { yield Buffer.from('data: {"error":{"message":"device lost"}}\n\n'); }
  await assert.rejects(async () => { for await (const _chunk of readSSE(error(), new AbortController().signal)) {} }, /device lost/);
  assert.throws(() => messagesFor([{ role: 'user', content: 'x'.repeat(300001) }]), /Shorten/);
});
function fakeRunner(fetchImpl, events = []) {
  const runner = new NativeInference({ directory: path.join(os.tmpdir(), 'unused-atlas-native'), fetchImpl, emit: event => events.push(event) });
  const child = new EventEmitter(); child.exitCode = null; child.kill = () => { child.exitCode = 0; child.emit('exit', 0); return true; };
  runner.server = { child, port: 12345, apiKey: 'test-secret', lease: 'test-lease',
    choice: 'apex-ultra', instructions: { marker: 'ATLAS_MODEL_PROFILE:atlas-7.5:v1', prompt: 'ATLAS_MODEL_PROFILE:atlas-7.5:v1' } };
  runner.ready = { key: 'apex-ultra:8192' };
  return runner;
}
test('a stalled first token times out in the supervisor and kills the native process', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const runner = fakeRunner(async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), events);
  const pending = runner.complete({ id: 'reply:test', messages: [{ role: 'user', content: 'Make a plan.' }], kind: 'plan' });
  const rejected = assert.rejects(pending, error => error.code === 'TIMEOUT');
  t.mock.timers.tick(120000);
  await rejected;
  assert.equal(runner.server, null); assert.equal(runner.ready, null); assert.equal(runner.jobs.size, 0);
  assert.ok(events.some(event => event.type === 'runtime-reset'));
});
test('Stop interrupts an in-flight request, while a stale request cannot stop a new one', async () => {
  const runner = fakeRunner(async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const pending = runner.complete({ id: 'reply:current', messages: [{ role: 'user', content: 'Hello' }] });
  runner.cancel({ id: 'reply:old' }); assert.ok(runner.server);
  runner.cancel({ id: 'reply:current' });
  const result = await pending;
  assert.equal(result.stopped, true); assert.equal(runner.server, null); assert.equal(runner.jobs.size, 0);
});
test('native requests are authenticated on loopback and stream real tokens within the requested budget', async () => {
  const events = [];
  const runner = fakeRunner(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:12345/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-secret');
    const body = JSON.parse(init.body); assert.equal(body.max_tokens, 6000); assert.equal(body.stream, true);
    return new Response('data: {"choices":[{"delta":{"content":"Ready"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, events);
  const result = await runner.complete({ id: 'reply:live', lease: 'test-lease', max_tokens: 6000, messages: [{ role: 'user', content: 'Hello' }] });
  assert.equal(result.text, 'Ready'); assert.equal(result.finishReason, 'stop');
  assert.equal(events.filter(event => event.type === 'chunk').length, 2);
  await assert.rejects(runner.complete({ id: 'reply:stale', lease: 'old', messages: [{ role: 'user', content: 'Hello' }] }), /loaded again/);
});
test('renderer adapter uses native chat and coding APIs without importing WebLLM', async () => {
  const listeners = new Set(), requests = [], events = [];
  const bridge = {
    onInference: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    inferenceLoad: async request => ({ choice: request.choice, label: 'Apex 7.3', tier: 'apex', contextWindow: 8192,
      modelId: 'native-qwen', lease: 'lease', backend: 'native-vulkan' }),
    inferenceComplete: async request => {
      requests.push(request);
      for (const listener of [...listeners]) listener({ type: 'chunk', runtimeId: request.runtimeId, id: request.id, chunk: { choices: [{ delta: { content: 'A plan' }, finish_reason: 'stop' }] } });
      return { ok: true, text: 'A plan', finishReason: 'stop' };
    }, inferenceUnload: async () => {}, inferenceCancel: async () => {}
  };
  const window = { atlasDesktop: bridge };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'atlas-native.js'), 'utf8'), { window, crypto, queueMicrotask });
  class Base { constructor() { this.generationEpoch = 1; } async _summarizeContext() { return ''; } }
  const state = { modelChoice: 'apex-ultra', contextPreferences: {}, effort: 'max' };
  const adapter = window.createAtlasNativeAdapter(Base, { state, contextWindowForChoice: () => 32768, isPlanCandidate: () => true, isCodeRequest: () => false });
  adapter.onmessage = ({ data }) => events.push(data);
  await adapter._load();
  await adapter._generate({ id: 'reply:one', messages: [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Plan my notes' }], maxNewTokens: 6000 });
  assert.equal(requests[0].max_tokens, 6000); assert.equal(requests[0].kind, 'plan');
  assert.ok(events.some(event => event.type === 'loaded' && event.contextWindow === 8192));
  assert.ok(events.some(event => event.type === 'token' && event.text === 'A plan'));
  assert.ok(events.some(event => event.type === 'done' && event.text === 'A plan'));
  const coding = await adapter.engine.chat.completions.create({ messages: [{ role: 'user', content: 'Write a small file.' }], stream: false, max_tokens: 7000 });
  assert.equal(coding.choices[0].message.content, 'A plan'); assert.equal(requests[1].kind, 'code');
  const codeEngine = await adapter._createEngine({ id: 'atlas-native-code' });
  assert.equal(adapter.nativeMeta.choice, 'ultra-code');
  await codeEngine.unload();
  const miniEngine = await adapter._createEngine({ id: 'atlas-native-mini' });
  assert.equal(adapter.nativeMeta.choice, 'forge');
  await miniEngine.unload();
  await adapter._dispose();
});

test('native adapter retries a code description and returns the corrected final answer', async () => {
  const listeners = new Set(), events = [], requests = [];
  const bridge = {
    onInference: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    inferenceLoad: async () => ({ label: 'Atlas', lease: 'lease', contextWindow: 8192 }),
    inferenceComplete: async request => {
      requests.push(request);
      const text = requests.length === 1 ? 'A description, but no code.' : '<html><body>Hello</body></html>';
      for (const fn of [...listeners]) fn({ type: 'chunk', runtimeId: request.runtimeId, id: request.id, chunk: { choices: [{ delta: { content: text }, finish_reason: 'stop' }] } });
      return { ok: true, text, finishReason: 'stop' };
    }, inferenceUnload: async () => {}, inferenceCancel: async () => {}
  };
  const window = { atlasDesktop: bridge };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '..', 'atlas-native.js'), 'utf8'), { window, crypto, queueMicrotask });
  class Base { constructor() { this.generationEpoch = 1; } async _summarizeContext() { return ''; } }
  const adapter = window.createAtlasNativeAdapter(Base, { state: { contextPreferences: {}, effort: 'max' }, contextWindowForChoice: () => 8192,
    isPlanCandidate: () => false, isCodeRequest: () => true, hasUsableCodeResponse: text => text.includes('<html>'), choice: 'apex-ultra' });
  adapter.onmessage = ({ data }) => events.push(data);
  await adapter._load();
  await adapter._generate({ id: 'reply:code', mode: 'code', messages: [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Make HTML' }] });
  assert.equal(requests.length, 2);
  assert.ok(events.some(event => event.type === 'done' && event.text === '<html><body>Hello</body></html>'));
  await adapter._dispose();
});

test('failed GPU startup retries identical weights on CPU and reports actual runner context', async t => {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, '.atlas-native-load-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.method(os, 'totalmem', () => 32 * 1024 ** 3);
  const events = [], starts = [];
  const runner = new NativeInference({ directory, emit: event => events.push(event) });
  runner.modelFiles = async () => path.join(directory, 'same-weights.gguf');
  runner.runtime = async cpu => ({ backend: cpu ? 'cpu' : 'vulkan' });
  runner.startServer = async (runtime, weights, context, cpu) => {
    starts.push({ weights, context, cpu });
    if (!cpu) throw new Error('No graphics device');
    const child = new EventEmitter(); child.exitCode = 0; child.kill = () => true;
    runner.server = { child, lease: 'cpu-lease' };
    return { lease: 'cpu-lease', backend: 'native-cpu', contextWindow: 8192 };
  };
  runner.complete = async value => { assert.equal(value.kind, 'verify'); return { text: 'Ready' }; };
  const loaded = await runner.load({ id: 'load:test', choice: 'apex-ultra', contextWindow: 32768 });
  assert.equal(starts.length, 2); assert.equal(starts[0].weights, starts[1].weights);
  assert.equal(loaded.contextWindow, 8192); assert.equal(loaded.backend, 'native-cpu');
  assert.equal(loaded.choice, 'apex-ultra'); assert.equal(loaded.verified, true);
  assert.ok(events.some(event => event.phase === 'cpu-fallback'));
  await runner.unload();
});
test('a runner that rejects its properties request fails promptly', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.exitCode = 0; child.kill = () => true;
  const runner = new NativeInference({ directory: os.tmpdir(), spawnImpl: () => child,
    fetchImpl: async url => url.endsWith('/health') ? new Response('', { status: 200 }) : new Response('', { status: 500 }) });
  await assert.rejects(runner.startServer({ server: path.join(os.tmpdir(), 'llama-server'), backend: 'cpu' }, 'model.gguf', 4096, true, new AbortController().signal), /could not report its context size/);
  await runner.stopServer();
});
test('setup can be cancelled before any engine exists and does not emit false readiness', async t => {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, '.atlas-native-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.mock.method(os, 'totalmem', () => 32 * 1024 ** 3);
  const runner = new NativeInference({ directory });
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  runner.modelFiles = async (_choice, _model, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered();
  });
  const loading = runner.load({ id: 'load:cancel', choice: 'apex-ultra' });
  const rejected = assert.rejects(loading, /setup stopped/);
  await waiting; runner.cancel({ id: 'load:cancel' }); await rejected;
  assert.equal(runner.loading, null); assert.equal(runner.ready, null); assert.equal(runner.server, null);
});
test('tar extraction supports native Unix binaries and rejects links outside the runtime', async t => {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, '.atlas-native-tar-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const zlib = require('node:zlib');
  const entry = (name, content = '', type = '0', link = '') => {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name, 0); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write(type, 156); if (link) header.write(link, 157);
    return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
  };
  const archive = path.join(directory, 'runtime.tar.gz');
  await fs.writeFile(archive, zlib.gzipSync(Buffer.concat([entry('bin/llama-server', 'fixture'), Buffer.alloc(1024)])));
  assert.equal(await unpackRuntime(archive, path.join(directory, 'valid')), path.join(directory, 'valid', 'bin', 'llama-server'));
  await fs.writeFile(archive, zlib.gzipSync(Buffer.concat([entry('bin/llama-server', 'fixture'), entry('bin/unsafe.so', '', '2', '../../escape'), Buffer.alloc(1024)])));
  await assert.rejects(unpackRuntime(archive, path.join(directory, 'invalid')), /escaped/);
});

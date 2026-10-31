const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Small browser doubles: exercise progress/completion/cancellation without opening
// an app, downloading models, or running a GPU job.
function setup({ reduced = false, decode = Promise.resolve(), save, gpuDone = Promise.resolve() } = {}) {
  const observers = [], frames = new Map(), timers = new Map();
  let id = 0;
  class Node extends EventTarget {
    constructor(tag) {
      super(); this.tag = tag; this.children = []; this.style = {}; this.attrs = {};
      this.dataset = {}; this.isConnected = true;
      const classes = new Set();
      this.classList = { add: x => classes.add(x), remove: x => classes.delete(x),
        toggle: (x, yes) => yes ? classes.add(x) : classes.delete(x), contains: x => classes.has(x) };
    }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = value; }
    removeAttribute(key) { delete this.attrs[key]; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.isConnected = false; }
    getBoundingClientRect() { return { width: 320, height: 320 }; }
    getContext() { return { clearRect() {}, fillRect() {}, setTransform() {} }; }
  }
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  const document = new Node('document');
  document.body = new Node('body'); document.documentElement = new Node('html');
  document.createElement = tag => new Node(tag);
  document.documentElement.dataset.reduceMotion = String(reduced);
  const window = new Node('window'); window.indexedDB = {};
  const media = new EventTarget(); media.matches = false;
  const engine = { generate: async () => ({ blob: new Blob(['image']), width: 512, height: 512 }) };
  const device = { queue: { onSubmittedWorkDone: () => gpuDone }, destroy() {} };
  let emit;
  const context = {
    window, document, Blob, DOMException, AbortController, EventTarget, console,
    performance: { now: () => 100 }, devicePixelRatio: 2, matchMedia: () => media,
    ResizeObserver: Observer, MutationObserver: Observer,
    Image: class { decode() { return decode; } },
    crypto: { randomUUID: () => 'image-id' },
    requestAnimationFrame: cb => { frames.set(++id, cb); return id; },
    cancelAnimationFrame: key => frames.delete(key),
    setTimeout: cb => { timers.set(++id, cb); return id; },
    clearTimeout: key => timers.delete(key),
    indexedDB: { open() {
      const request = {};
      queueMicrotask(() => {
        request.result = { transaction() {
          const transaction = { objectStore: () => ({ put() {} }) };
          if (save) save(transaction); else queueMicrotask(() => transaction.oncomplete());
          return transaction;
        } };
        request.onsuccess();
      });
      return request;
    } },
    runtimeModule: { requestGpuDevice: async () => ({ device }),
      createFluxKlein: async ({ onEvent }) => { emit = onEvent; return engine; } }
  };
  const source = fs.readFileSync(require.resolve('./atlas-poem3.js'), 'utf8');
  vm.runInNewContext(source.replace('import(RUNTIME_URL)', 'Promise.resolve(runtimeModule)'), context);
  const api = window.AtlasPoem3, host = new Node('host');
  const overlay = api.createGenerationOverlay(host);
  const frame = host.children[0], copy = frame.children[1].children[1];
  return { api, host, overlay, frame, counter: copy.children[2], line: copy.children[3],
    detail: copy.children[4], observers, frames, timers, document, media, engine,
    emit: event => emit(event) };
}

test('real nested steps advance monotonically; downloads and mobile segments cannot claim completion', () => {
  const s = setup();
  s.overlay.update({ stage: 'weights', detail: { shard: 1, shards: 5, loaded: 100, total: 100 } });
  assert.equal(s.counter.textContent, '0%');
  assert.match(s.detail.textContent, /file 1 of 5/);
  s.overlay.update({ stage: 'denoise', detail: { step: 1, i: 4, n: 4 } });
  assert.equal(s.counter.textContent, '12%'); // Segment callback is not step completion.
  s.overlay.update({ stage: 'denoise', _gpuComplete: true, detail: { step: 1, steps: 4 } });
  assert.equal(s.counter.textContent, '25%');
  s.overlay.update({ stage: 'denoise', detail: { step: 2, i: 1, n: 4 } });
  assert.equal(s.counter.textContent, '25%');
  s.overlay.update({ stage: 'denoise', _gpuComplete: true, detail: { step: 4, steps: 4 } });
  assert.equal(s.counter.textContent, '62%');
  s.overlay.update({ stage: 'decode' });
  assert.equal(s.counter.textContent, '62%');
  s.overlay.update({ stage: 'image-rendered' });
  assert.equal(s.counter.textContent, '75%');
  s.overlay.update({ stage: 'image-saved' });
  assert.equal(s.counter.textContent, '87%');
  s.overlay.dispose();
});

test('submitted GPU steps only count after their queue completion fence resolves', async () => {
  const gpu = deferred(); const s = setup({ gpuDone: gpu.promise });
  await s.api.prepare({ onProgress: s.overlay.update });
  s.emit({ stage: 'encode-prompt' });
  s.emit({ stage: 'denoise', detail: { step: 1, steps: 4 } });
  assert.equal(s.counter.textContent, '0%');
  gpu.resolve(); await Promise.resolve();
  assert.equal(s.counter.textContent, '25%');
  await s.api.unload(); s.overlay.dispose();
});

test('changing to reduced motion during the final pulse clears its timer and completes the reveal', async () => {
  const s = setup();
  const finished = s.overlay.finish('blob:ready', 'Finished image');
  await new Promise(setImmediate);
  assert.equal(s.counter.textContent, '100%'); assert.equal(s.timers.size, 1);
  s.document.documentElement.dataset.reduceMotion = 'true'; s.observers[1].callback();
  await finished;
  assert.equal(s.timers.size, 0); assert.equal(s.frames.size, 0);
  assert.ok(s.observers.every(x => !x.active));
});

test('a delayed GPU report from an earlier run cannot update the next overlay', async () => {
  const gpu = deferred(); const s = setup({ gpuDone: gpu.promise });
  await s.api.prepare({ onProgress: s.overlay.update });
  s.emit({ stage: 'denoise', detail: { step: 4, steps: 4 } });
  await s.api.prepare({ onProgress: s.overlay.update });
  gpu.resolve(); await new Promise(setImmediate);
  assert.equal(s.counter.textContent, '0%');
  await s.api.unload(); s.overlay.dispose();
});

test('cancelling during the completion pulse clears its timer and settles the reveal', async () => {
  const s = setup(); s.overlay.dispose();
  const controller = new AbortController();
  const overlay = s.api.createGenerationOverlay(s.host, { signal: controller.signal });
  const finished = overlay.finish('blob:ready', 'Finished image');
  await new Promise(setImmediate); assert.equal(s.timers.size, 1);
  controller.abort(); await assert.rejects(finished, { name: 'AbortError' });
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
  assert.ok(s.observers.every(x => !x.active));
});

test('100% waits for decoded preview, then reduced motion completes without animated frames or delays', async () => {
  const decode = deferred(); const s = setup({ reduced: true, decode: decode.promise });
  s.overlay.update({ stage: 'image-saved' });
  const finished = s.overlay.finish('blob:ready', 'Finished image');
  assert.equal(s.counter.textContent, '87%');
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
  decode.resolve(); await finished;
  assert.equal(s.counter.textContent, '100%');
  assert.equal(s.frame.children.length, 1);
  assert.ok(s.observers.every(x => !x.active));
});

test('Stop cancels preview decode and cleans frames, observers and overlay immediately', async () => {
  const decode = deferred(); const s = setup({ decode: decode.promise });
  s.overlay.dispose();
  const controller = new AbortController();
  const overlay = s.api.createGenerationOverlay(s.host, { signal: controller.signal });
  const finished = overlay.finish('blob:ready', 'Finished image');
  controller.abort();
  await assert.rejects(finished, { name: 'AbortError' });
  assert.equal(s.frames.size, 0); assert.equal(s.timers.size, 0);
  assert.ok(s.observers.every(x => !x.active));
  overlay.dispose(); decode.resolve();
});

test('motion setting changes and detached cards release animation resources', () => {
  const s = setup(); assert.equal(s.frames.size, 1);
  s.document.documentElement.dataset.reduceMotion = 'true';
  s.observers[1].callback(); assert.equal(s.frames.size, 0);
  s.document.documentElement.dataset.reduceMotion = 'false';
  s.observers[1].callback(); assert.equal(s.frames.size, 1);
  s.frame.isConnected = false; s.observers[2].callback();
  assert.equal(s.frames.size, 0); assert.ok(s.observers.every(x => !x.active));
});

test('decode failure cannot show 100%', async () => {
  const s = setup({ decode: Promise.reject(new Error('Bad image')) });
  s.overlay.update({ stage: 'image-saved' });
  await assert.rejects(s.overlay.finish('blob:bad', ''), /Bad image/);
  assert.equal(s.counter.textContent, '87%'); s.overlay.dispose();
});

test('generation only reports saved after storage commits and passes cancellation into the engine', async () => {
  let transaction;
  const s = setup({ save: t => { transaction = t; } });
  const controller = new AbortController(); const events = [];
  const original = s.engine.generate;
  s.engine.generate = options => {
    assert.equal(options.signal, controller.signal); assert.equal(options.steps, 4);
    return original(options);
  };
  const result = s.api.generate('A quiet garden', { signal: controller.signal, onProgress: e => events.push(e.stage) });
  await new Promise(setImmediate);
  assert.ok(transaction); assert.deepEqual(events, ['image-rendered']);
  controller.abort(); transaction.oncomplete();
  await assert.rejects(result, { name: 'AbortError' });
  assert.deepEqual(events, ['image-rendered']); s.overlay.dispose();
});

test('browser and desktop entries share generation hooks and remain syntactically valid', () => {
  let lifecycle;
  for (const file of ['index.html', 'Atlas-CHAT.html']) {
    const source = fs.readFileSync(require.resolve('./' + file), 'utf8');
    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc\s*=/.test(match[1]) && !/application\/(ld\+)?json/.test(match[1])) new vm.Script(match[2], { filename: file });
    }
    const current = source.slice(source.indexOf('  function poem3Progress(event)'), source.indexOf('  function submit(override)'));
    if (lifecycle) assert.equal(current, lifecycle); else lifecycle = current;
    assert.match(current, /createGenerationOverlay/); assert.match(current, /await overlay\.finish/);
  }
});

'use strict';
// Qwen Image 2.1 Turbo is a native diffusion pipeline, separate from llama.cpp.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { downloadVerified, unpackRuntime } = require('../desktop/native-download.cjs');

const RUNNER = {
  name: 'sd-master-c6dfa9d-bin-win-vulkan-x64.zip', size: 29827028,
  sha256: '31a26c404fab36ba8fe527116c4f039e70fe3f440cd6b75b28ff06305532208c',
  url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1031-c6dfa9d/sd-master-c6dfa9d-bin-win-vulkan-x64.zip'
};
const WEIGHTS = [
  { key: 'encoder', repo: 'AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF', revision: '881a778e306c44920e42536def3e52c3a3ecc7cd', name: 'Qwen-Image-2.1-Turbo-Uncensored-AD-Q4_K.gguf', size: 5287517120, sha256: '8123f36d2b3e562deef164dffdae33bdb1d152797ad10bb630827eaa7bce795d' },
  { key: 'denoiser', repo: 'AtomicChat/Qwen-Image-2.1-Turbo-GGUF', revision: 'cbcb9ff83b17e1eeef693479a8d34cea355a0ee4', name: 'Qwen-Image-2.1-Turbo-AD-Q4_K.gguf', size: 4201694944, sha256: '4bb73c53cbe284bbd6d69b9fdc59539c531f0389dd2aa567663d777f8130bc59' },
  { key: 'vae', repo: 'Comfy-Org/Qwen-Image-2.1', revision: 'aacf31a6d48e707f352ecba714cee0680da3479b', name: 'vae/qwen_image_2.1_vae_bf16.safetensors', size: 675509688, sha256: 'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9' }
];

class ImageRuntime {
  constructor(directory, emit = () => {}, spawnImpl = spawn) { this.directory = directory; this.emit = emit; this.spawn = spawnImpl; this.controller = null; this.task = null; this.ready = null; }
  event(stage, detail = {}) { this.emit({ type: 'image-progress', stage, detail }); }
  async prepare() {
    if (this.ready) return true;
    if (this.task) return this.task;
    if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Image 1.1 currently requires Windows on an x64 PC.');
    const controller = new AbortController(); this.controller = controller;
    const signal = controller.signal;
    const task = (async () => {
      const base = this.directory, files = {};
      await fs.mkdir(base, { recursive: true });
      const weightsDir = path.join(base, 'weights');
      const total = WEIGHTS.reduce((sum, item) => sum + item.size, 0);
      let completed = 0, lastNotice = 0;
      for (const item of WEIGHTS) {
        const destination = path.join(weightsDir, item.revision, path.basename(item.name));
        files[item.key] = await downloadVerified({ ...item, destination, signal,
          url: `https://huggingface.co/${item.repo}/resolve/${item.revision}/${item.name}`,
          progress: (loaded, _size, checking) => {
            if (Date.now() - lastNotice < 200 && loaded < item.size) return;
            lastNotice = Date.now(); this.event(checking ? 'cache' : 'download', { loaded: completed + loaded, total });
          } });
        completed += item.size;
      }
      this.event('load');
      const archive = path.join(base, 'downloads', RUNNER.name);
      await downloadVerified({ ...RUNNER, destination: archive, signal });
      const runtimeDir = path.join(base, 'runtime-c6dfa9d');
      const manifest = await fs.readFile(path.join(runtimeDir, 'ready.json'), 'utf8').then(JSON.parse).catch(() => null);
      let executable = manifest?.sha256 === RUNNER.sha256 && typeof manifest.executable === 'string' ? path.resolve(runtimeDir, manifest.executable) : '';
      if (!executable.startsWith(runtimeDir + path.sep) || !await fs.stat(executable).then(s => s.isFile()).catch(() => false)) {
        const staging = runtimeDir + '-' + crypto.randomUUID();
        try {
          const runner = await unpackRuntime(archive, staging, 'sd-cli');
          const relative = path.relative(staging, runner);
          signal.throwIfAborted();
          await fs.writeFile(path.join(staging, 'ready.json'), JSON.stringify({ sha256: RUNNER.sha256, executable: relative }));
          await fs.rm(runtimeDir, { recursive: true, force: true });
          await fs.rename(staging, runtimeDir); executable = path.join(runtimeDir, relative);
        } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
      }
      signal.throwIfAborted(); this.ready = { executable, ...files }; return true;
    })();
    this.task = task;
    try { return await task; } finally { if (this.task === task) this.task = null; if (this.controller === controller) this.controller = null; }
  }
  async generate(value = {}) {
    const prompt = typeof value.prompt === 'string' ? value.prompt.trim() : '';
    if (!prompt || prompt.length > 2000) throw Error('Image prompts must be between 1 and 2,000 characters.');
    if (this.task) throw Error('Image 1.1 is already working.');
    if (!this.ready) await this.prepare();
    const controller = new AbortController(); this.controller = controller;
    const task = (async () => {
      const temp = await fs.mkdtemp(path.join(this.directory, 'render-'));
      try {
        const output = path.join(temp, 'image.png'), m = this.ready;
        const args = ['--diffusion-model', m.denoiser, '--llm', m.encoder, '--vae', m.vae, '-p', prompt,
          '--steps', '8', '--cfg-scale', '1', '--sampling-method', 'euler', '--sigmas', 'qwen-image-2.1-turbo',
          '-W', '512', '-H', '512', '--diffusion-fa', '--vae-tiling', '-o', output];
        this.event('build-engine');
        await new Promise((resolve, reject) => {
          const child = this.spawn(m.executable, args, { cwd: path.dirname(m.executable), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let log = '', done = false;
          const abort = () => child.kill();
          controller.signal.addEventListener('abort', abort, { once: true });
          const onData = data => { log = (log + String(data)).slice(-5000); };
          child.stdout.on('data', onData); child.stderr.on('data', onData);
          child.once('error', error => { if (!done) { done = true; reject(error); } });
          child.once('close', code => {
            controller.signal.removeEventListener('abort', abort);
            if (done) return; done = true;
            if (controller.signal.aborted) return reject(Error('Image creation stopped.'));
            if (code !== 0) return reject(Error('Image 1.1 could not run on this device. ' + log.slice(-400)));
            resolve();
          });
          if (controller.signal.aborted) abort();
        });
        controller.signal.throwIfAborted();
        const png = await fs.readFile(output);
        if (png.length > 10 * 1024 * 1024 || png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Image 1.1 returned an invalid image.');
        return { png: png.toString('base64'), width: 512, height: 512 };
      } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
    })();
    this.task = task;
    try { return await task; } finally { if (this.task === task) this.task = null; if (this.controller === controller) this.controller = null; }
  }
  cancel() { this.controller?.abort(); }
}
module.exports = { ImageRuntime, RUNNER, WEIGHTS };

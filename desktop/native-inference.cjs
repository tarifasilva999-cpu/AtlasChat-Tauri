'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: pause } = require('node:timers/promises');
const { RELEASE, runtimeFor, modelFor, contextFor } = require('./native-catalog.cjs');
const { loadModelInstructions, withModelInstructions } = require('./model-instructions.cjs');
const { downloadVerified, unpackRuntime } = require('./native-download.cjs');

function failure(message, code = 'NATIVE_ERROR') { return Object.assign(new Error(message), { code }); }
function requestId(id) {
  if (typeof id !== 'string' || !/^[\w:.-]{1,120}$/.test(id)) throw failure('Invalid model request.');
  return id;
}
function messagesFor(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 128) throw failure('The conversation is too large for this request.');
  let bytes = 0;
  return messages.map(message => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw failure('Invalid conversation message.');
    bytes += Buffer.byteLength(message.content);
    if (bytes > 300000) throw failure('Shorten this conversation before sending it to the local model.');
    return { role: message.role, content: message.content };
  });
}
async function* readSSE(body, signal) {
  const decoder = new TextDecoder();
  let pending = '', data = [];
  for await (const bytes of body) {
    signal.throwIfAborted();
    pending += decoder.decode(bytes, { stream: true });
    if (pending.length > 2 * 1024 ** 2) throw failure('The local model returned an invalid stream.');
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
      if (!line) {
        if (data.length) {
          const value = data.join('\n'); data = [];
          if (value === '[DONE]') return;
          const chunk = JSON.parse(value);
          if (chunk.error) throw failure(String(chunk.error.message || 'Local model error.'));
          yield chunk;
        }
      } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) data.push(pending.slice(5).trim());
  if (data.length && data.join('\n') !== '[DONE]') yield JSON.parse(data.join('\n'));
}
async function availablePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

class NativeInference {
  constructor({ directory, emit = () => {}, platform = process.platform, arch = process.arch, fetchImpl = fetch, spawnImpl = spawn }) {
    this.directory = directory; this.emit = emit; this.platform = platform; this.arch = arch;
    this.fetch = fetchImpl; this.spawn = spawnImpl; this.server = null; this.ready = null;
    this.loading = null; this.jobs = new Map(); this.phase = 'idle'; this.lastLog = '';
  }
  notify(type, detail, extra = {}) {
    const now = Date.now();
    if (type.startsWith('downloading') && this.phase === type && now - (this.lastNotice || 0) < 200 && extra.loaded < extra.total) return;
    this.lastNotice = now;
    this.phase = type;
    this.emit({ type: 'phase', phase: type, detail, loadId: this.loading?.id, ...extra });
  }
  info() {
    return { native: true, release: RELEASE, phase: this.phase, totalMemory: os.totalmem(), freeMemory: os.freemem(),
      cpus: os.availableParallelism?.() || os.cpus().length, ready: this.ready, lastLog: this.lastLog };
  }
  async runtime(cpu, signal) {
    const record = runtimeFor(this.platform, this.arch, cpu);
    const runtimeDirectory = path.join(this.directory, 'runtimes', `${RELEASE}-${record.key}`);
    const manifest = await fs.readFile(path.join(runtimeDirectory, 'ready.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (manifest?.sha256 === record.sha256 && typeof manifest.server === 'string') {
      const server = path.resolve(runtimeDirectory, manifest.server);
      if (server.startsWith(runtimeDirectory + path.sep) && await fs.stat(server).then(s => s.isFile()).catch(() => false)) return { ...record, server };
    }
    const archive = path.join(this.directory, 'downloads', record.name);
    await downloadVerified({ ...record, destination: archive, signal, fetchImpl: this.fetch,
      progress: (loaded, total, checking) => this.notify(checking ? 'checking-runtime' : 'downloading-runtime',
        checking ? 'Checking the desktop runner…' : 'Downloading the desktop runner…', { loaded, total, file: 'native-runtime' }) });
    signal.throwIfAborted();
    const staging = runtimeDirectory + '-' + crypto.randomUUID();
    try {
      const server = await unpackRuntime(archive, staging);
      signal.throwIfAborted();
      const relative = path.relative(staging, server);
      await fs.writeFile(path.join(staging, 'ready.json'), JSON.stringify({ sha256: record.sha256, server: relative }));
      await fs.rm(runtimeDirectory, { recursive: true, force: true });
      await fs.rename(staging, runtimeDirectory);
      return { ...record, server: path.join(runtimeDirectory, relative) };
    } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }
  async modelFiles(choice, model, signal) {
    const directory = path.join(this.directory, 'models', choice, model.revision);
    await fs.mkdir(directory, { recursive: true });
    const total = model.files.reduce((sum, file) => sum + file.size, 0);
    let available = 0;
    for (const file of model.files) available += Math.min(file.size, await fs.stat(path.join(directory, file.name)).then(s => s.size).catch(() => 0) || await fs.stat(path.join(directory, file.name + '.part')).then(s => s.size).catch(() => 0));
    const disk = await fs.statfs(directory).catch(() => null);
    if (disk && disk.bavail * disk.bsize < total - available + 300 * 1024 ** 2) throw failure('There is not enough free disk space for this model. Free some space or choose a smaller Atlas model.');
    let completed = 0;
    for (const file of model.files) {
      const destination = path.join(directory, file.name);
      await downloadVerified({ ...file, destination, signal, fetchImpl: this.fetch,
        url: `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`,
        progress: (loaded, _total, checking) => this.notify(checking ? 'checking-model' : 'downloading-model',
          checking ? `Checking the saved ${model.label} download…` : `Downloading ${model.label}…`,
          { loaded: completed + loaded, total, file: 'native-model' }) });
      completed += file.size;
    }
    return path.join(directory, model.files[0].name);
  }
  load(value = {}) {
    const id = requestId(value.id), choice = value.choice;
    const model = modelFor(choice);
    runtimeFor(this.platform, this.arch);
    const context = contextFor(value.contextWindow, os.totalmem()), key = `${choice}:${context}`;
    if (this.ready?.key === key) return Promise.resolve(this.ready);
    if (this.loading) {
      if (this.loading.key === key) return this.loading.promise;
      return Promise.reject(failure('Wait for the current model to finish loading.'));
    }
    if (this.jobs.size) return Promise.reject(failure('Stop the current response before changing models.'));
    const controller = new AbortController();
    const operation = { id, key, controller, promise: null };
    this.loading = operation;
    const deadline = setTimeout(() => controller.abort(failure('The model setup reached its time limit. Send again to resume the saved download.', 'TIMEOUT')), 45 * 60 * 1000);
    operation.promise = (async () => {
      try {
        const instructions = await loadModelInstructions(choice);
        this.notify('starting', `Preparing ${model.label} on this computer…`);
        if (os.totalmem() < model.minimumGB * 1024 ** 3) throw failure(`${model.label} needs at least ${model.minimumGB} GB of system memory. Choose a smaller Atlas model on this computer.`);
        await fs.mkdir(this.directory, { recursive: true });
        const modelPath = await this.modelFiles(choice, model, controller.signal);
        await this.stopServer();
        let lastError, graphicsError;
        // Falling back changes the hardware path, never the selected weights.
        for (const cpu of [false, true]) {
          controller.signal.throwIfAborted();
          try {
            const runtime = await this.runtime(cpu, controller.signal);
            const meta = await this.startServer(runtime, modelPath, context, cpu, controller.signal);
            this.server.choice = choice;
            this.server.instructions = instructions;
            this.notify('verifying', `Checking that ${model.label} can reply…`);
            const reply = await this.complete({ id: `verify:${id}`, lease: meta.lease, kind: 'verify', max_tokens: 8,
              messages: [{ role: 'user', content: 'Reply with the word Ready.' }] }, controller.signal);
            if (!reply.text.trim()) throw failure('The desktop model loaded but could not produce a reply.');
            controller.signal.throwIfAborted();
            if (this.server?.lease !== meta.lease) throw failure('The model runner closed before setup finished.');
            this.ready = { ...meta, key, choice, modelId: `${model.repo}:Q4_K_M`, label: model.label, tier: model.tier, verified: true };
            this.notify('ready', `${model.label} is ready.`);
            return this.ready;
          } catch (error) {
            lastError = error; await this.stopServer();
            if (controller.signal.aborted) throw controller.signal.reason;
            if (cpu) break;
            graphicsError = error;
            this.notify('cpu-fallback', 'The graphics path could not start. Trying this model with the processor…');
          }
        }
        throw failure(`Atlas could not start its desktop model. Graphics: ${String(graphicsError?.message || 'unavailable').slice(0,300)} Processor: ${String(lastError?.message || 'unavailable').slice(0,300)}`);
      } catch (error) {
        await this.stopServer();
        this.phase = controller.signal.aborted ? 'stopped' : 'error';
        throw controller.signal.aborted ? controller.signal.reason : error;
      } finally {
        clearTimeout(deadline);
        if (this.loading === operation) this.loading = null;
      }
    })();
    return operation.promise;
  }
  async startServer(runtime, model, context, cpu, signal) {
    signal.throwIfAborted();
    const port = await availablePort(), apiKey = crypto.randomBytes(32).toString('hex'), lease = crypto.randomUUID();
    const threads = Math.max(1, Math.min(12, (os.availableParallelism?.() || os.cpus().length) - 1));
    const args = ['--model', model, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', String(context), '--parallel', '1',
      '--n-gpu-layers', cpu ? '0' : 'auto', '--threads', String(threads), '--batch-size', '256', '--ubatch-size', '128', '--jinja', '--no-webui', '--no-context-shift', '--log-verbosity', '4'];
    if (cpu) args.push('--device', 'none');
    const child = this.spawn(runtime.server, args, { cwd: path.dirname(runtime.server), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LLAMA_API_KEY: apiKey,
        LD_LIBRARY_PATH: [path.dirname(runtime.server), process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) } });
    const server = { child, port, apiKey, lease, runtime, exitError: null, offloaded: 0 };
    this.lastLog = '';
    this.server = server;
    child.once('error', error => { server.exitError = error; });
    child.once('exit', (code, exitSignal) => {
      server.exitError ||= failure(`The model runner exited (${exitSignal || code}). ${this.lastLog.slice(-200)}`);
      if (this.server === server) {
        this.server = null; this.ready = null;
        for (const job of this.jobs.values()) job.controller.abort(server.exitError);
        this.emit({ type: 'runtime-reset', detail: 'The local model stopped. Send again to reload it.' });
      }
    });
    const log = bytes => {
      const text = String(bytes); this.lastLog = (this.lastLog + text).slice(-4000);
      const offload = this.lastLog.match(/offloaded (\d+)\/\d+ layers/);
      if (offload) server.offloaded = Number(offload[1]);
    };
    child.stdout?.on('data', log); child.stderr?.on('data', log);
    this.notify('loading-model', 'Loading the model into memory…');
    const started = Date.now();
    while (Date.now() - started < 180000) {
      signal.throwIfAborted();
      if (server.exitError) throw server.exitError;
      let health;
      try {
        health = await this.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
      } catch (error) { if (signal.aborted) throw signal.reason; }
      if (health?.ok) {
          let properties;
          try {
            properties = await this.fetch(`http://127.0.0.1:${port}/props`, {
              headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            await pause(250, undefined, { signal });
            continue;
          }
          if (!properties.ok) throw failure('The local runner could not report its context size.');
          const props = await properties.json();
          const actualContext = Number(props.default_generation_settings?.n_ctx);
          if (!Number.isInteger(actualContext) || actualContext < 512 || actualContext > 32768) throw failure('The local runner reported an invalid context size.');
          server.contextWindow = actualContext;
          return { lease, contextWindow: actualContext, backend: `native-${!cpu && server.offloaded > 0 ? runtime.backend : 'cpu'}`, runtime: runtime.key };
      }
      await pause(250, undefined, { signal });
    }
    throw failure('The model could not finish loading into memory within three minutes.', 'TIMEOUT');
  }
  async complete(value = {}, parentSignal) {
    const id = requestId(value.id), inputMessages = messagesFor(value.messages);
    const server = this.server;
    if (!server || (value.lease && value.lease !== server.lease)) throw failure('The local model needs to be loaded again.');
    if (this.jobs.size) throw failure('The local model is already working on another request.');
    const kind = String(value.kind || 'chat');
    let messages = inputMessages;
    if (['chat', 'plan', 'code'].includes(kind)) {
      const choice = server.choice || this.ready?.choice || String(this.ready?.key || '').split(':')[0];
      const instructions = server.instructions || await loadModelInstructions(choice);
      messages = messagesFor(withModelInstructions(inputMessages, choice, instructions));
    }
    const controller = new AbortController(), job = { id, controller };
    this.jobs.set(id, job);
    const signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const limits = { plan: 180000, chat: 480000, code: 1200000, title: 45000, summary: 90000, verify: 90000 };
    const limit = limits[value.kind] || limits.chat;
    const timeout = () => controller.abort(failure('Apex stopped responding. Its desktop runner was reset; send again to retry.', 'TIMEOUT'));
    const absolute = setTimeout(timeout, limit);
    let idle, text = '', finishReason = null;
    const armIdle = () => { clearTimeout(idle); idle = setTimeout(timeout, Math.min(limit, 120000)); };
    armIdle();
    try {
      const maxTokens = Math.max(1, Math.min(8192, Math.floor(Number(value.max_tokens) || 2048)));
      const temperature = Math.max(0, Math.min(1, Number(value.temperature) || 0));
      this.emit({ type: 'reply-phase', id, detail: value.kind === 'summary' ? 'Organizing earlier messages…' : 'Waiting for the first response…' });
      const response = await this.fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.apiKey}` },
        body: JSON.stringify({ model: 'local', messages, stream: true, max_tokens: maxTokens, temperature,
          top_p: 0.9, min_p: 0, repeat_penalty: 1.1, chat_template_kwargs: { enable_thinking: false } })
      });
      if (!response.ok || !response.body) {
        const detail = await response.json().catch(() => null);
        throw failure(String(detail?.error?.message || `The local model returned HTTP ${response.status}.`).slice(0,500));
      }
      for await (const chunk of readSSE(response.body, signal)) {
        const delta = String(chunk.choices?.[0]?.delta?.content || '');
        if (delta) { text += delta; armIdle(); }
        if (text.length > 2 * 1024 ** 2) throw failure('The local reply exceeded its size limit.');
        finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
        this.emit({ type: 'chunk', id, chunk });
      }
      signal.throwIfAborted();
      if (!text.trim()) throw failure('Apex returned an empty reply. Try sending again.');
      return { text, finishReason, stopped: false };
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error;
      if (reason?.code === 'STOPPED') return { text, finishReason: 'stop', stopped: true };
      if (reason?.code === 'TIMEOUT') {
        await this.stopServer();
        this.emit({ type: 'runtime-reset', detail: reason.message });
      }
      throw reason;
    } finally {
      clearTimeout(idle); clearTimeout(absolute); this.jobs.delete(id);
    }
  }
  cancel(value = {}) {
    const id = value.id ? requestId(value.id) : null;
    if (this.loading && (!id || id === this.loading.id)) this.loading.controller.abort(failure('Model setup stopped. Saved downloads will resume next time.', 'STOPPED'));
    for (const job of this.jobs.values()) if (!id || id === job.id) job.controller.abort(failure('Stopped.', 'STOPPED'));
    // A terminated native process is the final cancellation guarantee, including
    // a server which does not observe HTTP disconnects promptly.
    if (!id || this.jobs.has(id) || id === this.loading?.id) {
      if (this.server) this.emit({ type: 'runtime-reset', detail: 'The desktop model was stopped. Send again to reload it.' });
      void this.stopServer();
    }
    return true;
  }
  async stopServer() {
    const server = this.server; this.server = null; this.ready = null;
    if (!server) return;
    server.child.kill();
    if (server.child.exitCode !== null || server.child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.child.kill('SIGKILL'); resolve(); }, 1500);
      server.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  async unload(value = {}) {
    if (value.lease && value.lease !== this.server?.lease) return;
    this.cancel(); await this.stopServer();
    if (this.loading) await this.loading.promise.catch(() => {});
    this.phase = 'idle';
  }
}
module.exports = { NativeInference, messagesFor, readSSE };

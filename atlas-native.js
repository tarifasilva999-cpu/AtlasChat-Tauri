/* Native desktop adapter. The browser does not load or start a native runner. */
(() => {
  'use strict';
  window.createAtlasNativeAdapter = (Base, settings) => {
    const bridge = window.atlasDesktop;
    if (!bridge?.inferenceLoad) throw new Error('Atlas desktop components are out of date. Close Atlas and reopen it from the updated folder.');
    const { state, contextWindowForChoice, isPlanCandidate, isCodeRequest, hasUsableCodeResponse, choice: initialChoice, runtimeId } = settings;
    const legacyIds = { 'apex-ultra': 'atlas-native-chat', 'ultra-code': 'atlas-native-code',
      forge: 'atlas-native-mini', firefly: 'atlas-native-mini' };
    const choiceFrom = (model, fallback) => model.choice ||
      ({ 'atlas-native-chat': 'apex-ultra', 'atlas-native-code': 'ultra-code', 'atlas-native-mini': 'forge' })[model.id] || fallback;
    const identifier = prefix => `${prefix}:${crypto.randomUUID()}`;
    class DesktopAdapter extends Base {
      constructor(choice=initialChoice, id=runtimeId) {
        super(choice); this.native = true; this.runtimeId = id || 'primary'; this.loadEpoch = 0; this.nativeMeta = null; this.pendingLoadId = null;
        this.unsubscribeInference = bridge.onInference(event => {
          if (event.runtimeId !== this.runtimeId) return;
          if (event.type === 'phase' && event.loadId === this.pendingLoadId) {
            const downloading = event.phase.startsWith('downloading');
            const total = Number(event.total) || 0, loaded = Number(event.loaded) || 0;
            const progress = downloading && total ? Math.min(99, loaded / total * 100) : 0;
            const info = { status: downloading ? 'progress' : 'phase', file: event.file || 'native-model',
              loaded, total, progress, text: event.detail, native: true, phase: event.phase };
            this.onCodingProgress?.(info);
            if (event.phase === 'verifying') this._emit({ type: 'verify-phase', backend: 'native' });
            this._emit({ type: 'progress', info });
          } else if (event.type === 'runtime-reset') {
            this.engine = null; this.nativeMeta = null;
            this._emit({ type: 'runtime-reset', message: event.detail });
          } else if (event.type === 'reply-phase') {
            this._emit({ type: 'reply-phase', id: event.id, message: event.detail });
          }
        });
      }
      // Native lifecycle deadlines run in Electron's main process, independent
      // of the UI event loop and of progress messages from the model.
      _emit(data) { queueMicrotask(() => this.onmessage?.({ data })); }
      postMessage(message) {
        if (message?.type === 'interrupt-load') { void this._cancelLoad(); return; }
        if (message?.type === 'interrupt' && this.pendingLoadId) {
          this.loadEpoch++;
          void bridge.inferenceCancel({ id: this.pendingLoadId, runtimeId: this.runtimeId });
          return;
        }
        super.postMessage(message);
      }
      async _cancelLoad() {
        const pending = this.loadingPromise, id = this.pendingLoadId, lease = this.nativeMeta?.lease;
        if (!pending && !id) return false;
        this.loadEpoch++;
        this.pendingLoadId = null;
        if (id) await bridge.inferenceCancel({ id, runtimeId: this.runtimeId });
        if (pending) await Promise.resolve(pending).catch(() => {});
        const activeLease = this.nativeMeta?.lease || lease;
        if (activeLease) await bridge.inferenceUnload({ lease: activeLease, runtimeId: this.runtimeId }).catch(() => {});
        this.engine = null; this.nativeMeta = null; this.modelId = null; this.variant = null;
        if (this.loadingPromise === pending) this.loadingPromise = null;
        return true;
      }
      async _createEngine(model, expectedEpoch = this.loadEpoch) {
        const choice = choiceFrom(model, this.choice);
        const epoch = expectedEpoch;
        if (epoch !== this.loadEpoch) throw new Error('Model loading stopped.');
        const id = identifier('load'); this.pendingLoadId = id;
        try {
          const meta = await bridge.inferenceLoad({ id, choice, runtimeId: this.runtimeId,
            contextWindow: contextWindowForChoice(choice, state.contextPreferences, state.effort) });
          if (epoch !== this.loadEpoch) { await bridge.inferenceUnload({ lease: meta.lease, runtimeId: this.runtimeId }); throw new Error('Model loading stopped.'); }
          this.nativeMeta = meta;
          this.contextWindowSize = meta.contextWindow; this.projectContextWindow = meta.contextWindow;
          return this._proxy(meta);
        } finally { if (this.pendingLoadId === id) this.pendingLoadId = null; }
      }
      _proxy(meta) {
        const adapter = this;
        const engine = { lastText: '',
          interruptGenerate() { void bridge.inferenceCancel({ runtimeId: adapter.runtimeId }); },
          async unload() { await bridge.inferenceUnload({ lease: meta.lease, runtimeId: adapter.runtimeId }); },
          async getMessage() { return engine.lastText; },
          chat: { completions: { async create(parameters) {
            const id = parameters._atlasId || identifier('call');
            const kind = parameters._atlasKind || (/compact memory/i.test(parameters.messages?.[0]?.content || '') ? 'summary' : 'code');
            const request = { id, lease: meta.lease, runtimeId: adapter.runtimeId, kind, messages: parameters.messages,
              max_tokens: parameters.max_tokens, temperature: parameters.temperature };
            if (!parameters.stream) {
              const result = await bridge.inferenceComplete(request);
              if (!result.ok) throw Object.assign(new Error(result.message), { generationTimeout: result.timeout });
              engine.lastText = result.text;
              return { choices: [{ message: { content: result.text }, finish_reason: result.finishReason }] };
            }
            let ended = false, error = null, wake = null;
            const queue = [];
            const unsubscribe = bridge.onInference(event => {
              if (event.runtimeId !== adapter.runtimeId) return;
              if (event.type !== 'chunk' || event.id !== id) return;
              queue.push(event.chunk); wake?.(); wake = null;
            });
            const task = bridge.inferenceComplete(request).then(result => {
              if (!result.ok) error = Object.assign(new Error(result.message), { generationTimeout: result.timeout });
              else engine.lastText = result.text;
            }).catch(problem => { error = problem; }).finally(() => { ended = true; unsubscribe(); wake?.(); wake = null; });
            return (async function* () {
              try {
                for (;;) {
                  while (queue.length) yield queue.shift();
                  if (ended) break;
                  await new Promise(resolve => { wake = resolve; });
                }
                if (error) throw error;
              } finally {
                unsubscribe();
                if (!ended) await bridge.inferenceCancel({ id, runtimeId: adapter.runtimeId });
                await task;
              }
            })();
          } } }
        };
        return engine;
      }
      async _load(silent = false) {
        if (this.loadingPromise) return this.loadingPromise;
        const epoch = this.loadEpoch;
        this._emit({ type: 'load-phase', backend: 'native' });
        const task = Promise.resolve().then(async () => {
          try {
            if (epoch !== this.loadEpoch) return;
            const choice = this.choice;
            const engine = this.engine || await this._createEngine({ choice }, epoch);
            if (epoch !== this.loadEpoch) { await engine.unload(); return; }
            this.engine = engine; this.modelId = legacyIds[choice];
            this.variant = this.nativeMeta.label; this.modelTier = this.nativeMeta.tier;
            this._emit({ type: 'loaded', backend: this.nativeMeta.backend, modelId: this.modelId,
              runtimeModel: this.nativeMeta.modelId, variant: this.variant, tier: this.modelTier,
              contextWindow: this.nativeMeta.contextWindow, verified: true });
          } catch (error) {
            if (epoch === this.loadEpoch && !silent) this._emit({ type: 'error', message: String(error.message || error) });
          } finally {
            this.pendingLoadId = null;
            if (this.loadingPromise === task) this.loadingPromise = null;
          }
        });
        this.loadingPromise = task;
        return task;
      }
      async _generate(message, epoch = this.generationEpoch) {
        let full = ''; this.interrupted = false;
        try {
          if (!this.engine) await this._load();
          if (epoch !== this.generationEpoch) return;
          if (this.interrupted) {
            this._emit({ type: 'done', id: message.id, text: 'Stopped.', stopped: true,
              backend: this.nativeMeta?.backend || 'native', modelId: this.modelId, variant: this.variant, verified: true });
            return;
          }
          const engine = this.engine;
          if (!engine) throw new Error('The desktop model needs to be loaded again.');
          if (message.contextToSummarize?.length) this._emit({ type: 'reply-phase', id: message.id, message: 'Organizing earlier messages…' });
          const summary = await this._summarizeContext(message);
          if (epoch !== this.generationEpoch) return;
          if (this.interrupted) {
            this._emit({ type: 'done', id: message.id, text: full.trim() || 'Stopped.', stopped: true,
              backend: this.nativeMeta?.backend || 'native', modelId: this.modelId, variant: this.variant, verified: true });
            return;
          }
          if (summary) message.messages[0].content += `\n\nEarlier conversation summary:\n${summary}`;
          const latest = [...message.messages].reverse().find(item => item.role === 'user')?.content || '';
          const kind = message.id?.startsWith('title:') ? 'title' : message.mode === 'code' ? 'code' : isPlanCandidate(latest) && !isCodeRequest(latest) ? 'plan' : 'chat';
          const stream = await engine.chat.completions.create({ messages: message.messages, stream: true,
            max_tokens: message.maxNewTokens || 2048, temperature: message.mode === 'code' ? 0.15 : 0.35,
            _atlasId: message.id, _atlasKind: kind });
          let finishReason;
          for await (const chunk of stream) {
            if (epoch !== this.generationEpoch) break;
            if (this.interrupted) break;
            const text = String(chunk.choices?.[0]?.delta?.content || '');
            finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
            if (text) { full += text; this._emit({ type: 'token', id: message.id, text }); }
          }
          if (epoch !== this.generationEpoch) return;
          if (!full.trim() && !this.interrupted) throw new Error('Apex returned an empty response.');
          if (!this.interrupted && kind === 'code' && hasUsableCodeResponse && !hasUsableCodeResponse(full, latest)) {
            this._emit({ type: 'reply-phase', id: message.id, message: 'Fixing the code response…' });
            const retry = await engine.chat.completions.create({ messages: [
              { role: 'system', content: 'Return complete, runnable code that fulfills the request, in a fenced code block. Do not substitute a description, pseudocode, or placeholders for code.' },
              { role: 'user', content: latest }
            ], max_tokens: message.maxNewTokens || 2048, temperature: 0.2, _atlasKind: 'code' });
            if (epoch !== this.generationEpoch) return;
            const corrected = String(retry.choices?.[0]?.message?.content || '').trim();
            if (!hasUsableCodeResponse(corrected, latest)) throw new Error('Atlas could not produce usable code for this request. Try again or break the task into smaller parts.');
            full = corrected;
          }
          this._emit({ type: 'done', id: message.id, text: full.trim() || 'Stopped.', stopped: this.interrupted,
            truncated: finishReason === 'length', backend: this.nativeMeta?.backend || 'native',
            modelId: this.modelId, variant: this.variant, verified: true });
        } catch (error) {
          if (epoch !== this.generationEpoch) return;
          if (this.interrupted) this._emit({ type: 'done', id: message.id, text: full.trim() || 'Stopped.', stopped: true });
          else this._emit({ type: 'error', id: message.id, message: String(error.message || error), generationTimeout: error.generationTimeout === true });
        } finally {
          if (epoch === this.generationEpoch) { this.interrupted = false; this.activeGenerationId = null; }
        }
      }
      async _dispose() {
        this.loadEpoch++;
        await bridge.inferenceUnload({ runtimeId: this.runtimeId });
        if (this.loadingPromise) await this.loadingPromise.catch(() => {});
        this.engine = null; this.nativeMeta = null; this.modelId = null; this.variant = null;
      }
      _detach() { this.unsubscribeInference?.(); this.unsubscribeInference = null; }
    }
    return new DesktopAdapter();
  };
})();

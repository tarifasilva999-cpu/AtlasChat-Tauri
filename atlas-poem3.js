"use strict";

(() => {
  const RUNTIME_URL = "https://esm.run/flux-klein.js@0.6.0";
  const DB_NAME = "atlas-poem3-images-v1";
  const STORE_NAME = "images";
  let runtimeTask = null;
  let runtime = null;
  let runtimeDevice = null;
  let runtimeCycle = 0;
  let progressHandler = null;
  let progressCycle = 0;
  let databaseTask = null;
  let nativeUnsubscribe = null;
  const imageUrls = new Map();
  const GENERATION_STEPS = 4;

  // Count actual work units: prompt, four completed image steps, rendered pixels,
  // saved image, decoded preview. This is completion progress, never a time estimate.
  function generationProgress() {
    let completed = 0;
    let label = "Getting Image 1.1 ready…";
    const total = GENERATION_STEPS + 4;
    return event => {
      const stage = event?.stage;
      const d = event?.detail || event || {};
      if (completed >= GENERATION_STEPS + 2 && stage !== "image-rendered" && stage !== "image-saved") {
        return { label, percent: Math.floor(completed / total * 100), detail: "" };
      }
      if (stage === "build-engine") completed = Math.max(completed, 1);
      if (stage === "denoise") {
        // Mobile segment events describe the current step, not completed steps.
        const stepsDone = d.n || !event?._gpuComplete ? 0 : Number(d.step);
        if (Number.isFinite(stepsDone)) completed = Math.max(completed, 1 + Math.min(GENERATION_STEPS, stepsDone));
      }
      if (stage === "decode") completed = Math.max(completed, 1 + GENERATION_STEPS);
      if (stage === "image-rendered") completed = GENERATION_STEPS + 2;
      if (stage === "image-saved") completed = GENERATION_STEPS + 3;
      const info = progressInfo(event);
      if (!/^(worker|worker-fallback|warning|cooldown|release|idle-release)$/.test(stage || "")) label = info.label;
      if (stage === "build-engine") label = "Creating your image…";
      if (stage === "denoise" && completed === 1 + GENERATION_STEPS) label = "Finishing your image…";
      return { label, percent: Math.floor(completed / total * 100), detail: info.detail };
    };
  }

  function withSignal(task, signal) {
    if (!signal) return Promise.resolve(task);
    if (signal.aborted) return Promise.reject(new DOMException("Image creation stopped.", "AbortError"));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException("Image creation stopped.", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  function progressInfo(event) {
    const stage = String(event?.stage || event?.type || event?.phase || "").toLowerCase();
    let label = "Getting Image 1.1 ready…";
    if (/download|fetch/.test(stage)) label = "Downloading Image 1.1…";
    else if (/cache|opfs|read/.test(stage)) label = "Opening the saved image model…";
    else if (/weight|load|upload|engine|device/.test(stage)) label = "Loading Image 1.1…";
    else if (/token|text|prompt|embed/.test(stage)) label = "Reading your prompt…";
    else if (/denois|transform|sample|step|generat/.test(stage)) label = "Creating your image…";
    else if (/decode|vae|finish/.test(stage)) label = "Finishing the image…";

    const data = event?.detail && typeof event.detail === "object" ? event.detail : event;
    const loaded = Number(data?.loadedBytes ?? data?.bytesLoaded ?? data?.loaded);
    const total = Number(data?.totalBytes ?? data?.bytesTotal ?? data?.total);
    let percent = null;
    let detail = "";
    if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0 && loaded >= 0) {
      percent = Math.min(100, Math.round(loaded / total * 100));
      detail = `${formatBytes(loaded)} / ${formatBytes(total)}`;
    } else {
      const fraction = Number(event?._fraction ?? event?.fraction ?? event?.progress);
      if (Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) percent = Math.round(fraction * 100);
      else if (Number.isFinite(fraction) && fraction > 1 && fraction <= 100) percent = Math.round(fraction);
    }

    const step = Number(data?.step ?? data?.currentStep);
    const steps = Number(data?.steps ?? data?.totalSteps);
    if (percent === null && Number.isFinite(step) && Number.isFinite(steps) && steps > 0) {
      percent = Math.round(Math.min(steps, step) / steps * 100);
      detail = `${Math.min(steps, step)} / ${steps}`;
    }
    if (stage === "denoise" && step > 0) detail = steps > 0 ? `Image step ${Math.min(steps, step)} of ${steps}` : `Image step ${step}`;
    if (/^(text-encoder|embeddings|weights|lora)$/.test(stage) && total > 0 && !data?.cached) {
      label = "Downloading image model…";
      const shard = Number(data?.shard), shards = Number(data?.shards);
      if (shard > 0 && shards > 0) detail += ` · file ${shard} of ${shards}`;
    }
    if (stage === "image-rendered") label = "Saving your image…";
    if (stage === "image-saved") label = "Opening your image…";
    return { label, percent, detail };
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
  }

  function progressText(event) {
    const info = progressInfo(event);
    return info.percent === null ? info.label : `${info.label} ${info.percent}%`;
  }

  async function loadRuntime(onProgress) {
    if (onProgress) { progressHandler = onProgress; progressCycle++; }
    if (window.atlasDesktop?.imagePrepare) {
      if (!runtimeTask) {
        const cycle = runtimeCycle;
        nativeUnsubscribe = window.atlasDesktop.onInference(event => {
          if (event.type === 'image-progress' && cycle === runtimeCycle) progressHandler?.(event);
        });
        runtimeTask = window.atlasDesktop.imagePrepare().then(() => {
          if (cycle !== runtimeCycle) throw new DOMException('Image creation stopped.', 'AbortError');
          runtime = { native: true }; return runtime;
        }).catch(error => {
          if (cycle === runtimeCycle) { runtimeTask = null; runtime = null; nativeUnsubscribe?.(); nativeUnsubscribe = null; }
          throw error;
        });
      }
      return runtimeTask;
    }
    if (!runtimeTask) {
      const cycle = runtimeCycle;
      runtimeTask = (async () => {
        const module = await import(RUNTIME_URL);
        if (typeof module.createFluxKlein !== "function") throw new Error("The local image runtime is unavailable.");
        // Use the runtime's own device helper with its default options. Keeping
        // the device lets us confirm a submitted step has really left the GPU.
        const { device } = await module.requestGpuDevice();
        if (cycle !== runtimeCycle) { device.destroy(); throw new DOMException("Image creation stopped.", "AbortError"); }
        runtimeDevice = device;
        const engine = await module.createFluxKlein({
          device,
          mode: "auto",
          cacheDir: "flux-klein-v1",
          onEvent: event => {
            if (cycle !== runtimeCycle) return;
            const handler = progressHandler;
            const reportCycle = progressCycle;
            if (event.stage === "denoise" && event.detail?.steps > 0) {
              // onStep fires just after queue.submit(). Fence the queue at this
              // point without delaying the engine or doing a GPU readback.
              device.queue.onSubmittedWorkDone().then(() => {
                if (cycle === runtimeCycle && reportCycle === progressCycle && progressHandler === handler) handler?.({ ...event, _gpuComplete: true });
              }).catch(() => {}); // The generation promise reports device failures.
              return;
            }
            let fraction = null;
            try {
              const value = module.progressFraction?.(event);
              if (Number.isFinite(value)) fraction = value;
            } catch {}
            handler?.(fraction === null ? event : { ...event, _fraction: fraction });
          }
        });
        if (cycle !== runtimeCycle) { await engine.destroy?.(); device.destroy(); throw new DOMException("Image creation stopped.", "AbortError"); }
        runtime = engine;
        return runtime;
      })().catch(error => {
        if (cycle === runtimeCycle) {
          runtimeDevice?.destroy();runtimeDevice = null;
          runtimeTask = null;
          runtime = null;
        }
        throw error;
      });
    }
    return runtimeTask;
  }

  function prepare(options = {}) {
    return loadRuntime(options.onProgress);
  }

  function isReady() {
    return Boolean(runtime);
  }

  async function unload() {
    const engine = runtime;
    const device = runtimeDevice;
    runtimeCycle++;
    runtimeDevice = null;
    runtime = null;
    runtimeTask = null;
    progressHandler = null;
    progressCycle++;
    nativeUnsubscribe?.(); nativeUnsubscribe = null;
    if (window.atlasDesktop?.imageCancel) await window.atlasDesktop.imageCancel().catch(() => {});
    try { if (typeof engine?.destroy === "function") await engine.destroy(); }
    finally { device?.destroy(); }
  }

  function openDatabase() {
    if (!databaseTask) {
      databaseTask = new Promise((resolve, reject) => {
        if (!("indexedDB" in window)) return reject(new Error("Local image storage is unavailable in this browser."));
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open local image storage."));
      }).catch(error => {
        databaseTask = null;
        throw error;
      });
    }
    return databaseTask;
  }

  async function saveImage(id, blob) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ blob, created: Date.now() }, id);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save the generated image."));
      transaction.onabort = () => reject(transaction.error || new Error("Could not save the generated image."));
    });
  }

  async function readImage(id) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(String(id || ""));
      request.onsuccess = () => resolve(request.result?.blob || null);
      request.onerror = () => reject(request.error || new Error("Could not open the saved image."));
    });
  }

  function pixelsToBlob(result) {
    if (result?.blob instanceof Blob) return Promise.resolve(result.blob);
    const image = result?.image;
    const pixels = result?.rgba || image?.data || image;
    const width = Number(result?.width || image?.width);
    const height = Number(result?.height || image?.height);
    if (!pixels || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4096 * 4096) {
      throw new Error("Image 1.1 returned an image Atlas could not read.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Atlas could not prepare the generated image.");
    const data = pixels instanceof ImageData ? pixels : new ImageData(new Uint8ClampedArray(pixels), width, height);
    context.putImageData(data, 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("Atlas could not save the generated image."));
    }, "image/webp", 0.92));
  }

  async function generate(prompt, options = {}) {
    const cleanPrompt = String(prompt || "").trim();
    if (!cleanPrompt || cleanPrompt.length > 2000) throw new Error("Image prompts must be between 1 and 2,000 characters.");
    const engine = await withSignal(loadRuntime(options.onProgress), options.signal);
    if (options.signal?.aborted) throw new DOMException("Image creation stopped.", "AbortError");
    progressHandler = options.onProgress || progressHandler;
    const abortNative = () => { if (engine.native) void window.atlasDesktop.imageCancel(); };
    options.signal?.addEventListener('abort', abortNative, { once: true });
    try {
      const result = engine.native ? await window.atlasDesktop.imageGenerate({ prompt: cleanPrompt }) : await engine.generate({
        prompt: cleanPrompt,
        steps: GENERATION_STEPS,
        width: options.width || 512,
        height: options.height || 512,
        signal: options.signal
      });
      if (options.signal?.aborted) throw new DOMException("Image creation stopped.", "AbortError");
      options.onProgress?.({ stage: "image-rendered" });
      const blob = engine.native
        ? new Blob([Uint8Array.from(atob(result.png), c => c.charCodeAt(0))], { type: 'image/png' })
        : await pixelsToBlob(result);
      if (options.signal?.aborted) throw new DOMException("Image creation stopped.", "AbortError");
      const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await saveImage(id, blob);
      if (options.signal?.aborted) throw new DOMException("Image creation stopped.", "AbortError");
      options.onProgress?.({ stage: "image-saved" });
      return { id, width: Number(result?.width || result?.image?.width) || 512, height: Number(result?.height || result?.image?.height) || 512 };
    } finally {
      options.signal?.removeEventListener('abort', abortNative);
      if (progressHandler === options.onProgress) { progressHandler = null; progressCycle++; }
    }
  }

  async function loadPreview(id) {
    const key = String(id || "");
    if (!key) return null;
    if (imageUrls.has(key)) return imageUrls.get(key);
    const blob = await readImage(key);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    imageUrls.set(key, url);
    return url;
  }

  async function download(id, filename = "atlas-image-1.1.png") {
    const blob = await readImage(id);
    if (!blob) throw new Error("This image is no longer available on this device.");
    const url = URL.createObjectURL(blob);
    const extension = blob.type === "image/png" ? "png" : "webp";
    const downloadName = String(filename || "atlas-image-1.1.png").replace(/\.(?:png|webp)$/i, "") + "." + extension;
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function exportImageData(id) {
    const blob = await readImage(id);
    if (!blob || blob.size > 10 * 1024 * 1024) return null;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Could not add the image to the backup."));
      reader.readAsDataURL(blob);
    });
  }

  async function restoreImage(id, dataUrl) {
    if (!/^data:image\/(?:webp|png|jpeg);base64,/i.test(String(dataUrl || ""))) throw new Error("The backup contains an unsupported image.");
    const blob = await fetch(dataUrl).then(response => response.blob());
    if (blob.size > 10 * 1024 * 1024) throw new Error("The backup image is too large to restore.");
    await saveImage(String(id || ""), blob);
  }

  function createGenerationOverlay(host, { signal, artwork = "" } = {}) {
    const frame = document.createElement("div");
    frame.className = "poem3-generation is-generating";
    frame.setAttribute("aria-busy", "true");
    const image = document.createElement("img");
    image.className = "poem3-generation-artwork";
    image.alt = "";
    if (artwork) image.src = artwork;
    const veil = document.createElement("div");
    veil.className = "poem3-generation-veil";
    const field = document.createElement("canvas");
    field.className = "poem3-generation-pixels";
    field.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "poem3-generation-copy";
    const kicker = document.createElement("span");
    kicker.className = "poem3-generation-kicker";
    kicker.textContent = "Image 1.1 / Image study";
    const label = document.createElement("span");
    label.className = "poem3-generation-label";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    const counter = document.createElement("span");
    counter.className = "poem3-generation-percent";
    counter.title = "Completed image steps and finishing stages. This is not a time estimate.";
    const detail = document.createElement("span");
    detail.className = "poem3-generation-detail";
    const line = document.createElement("div");
    line.className = "poem3-generation-line";
    line.setAttribute("role", "progressbar");
    line.setAttribute("aria-label", "Image completion");
    line.setAttribute("aria-valuemin", "0");
    line.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    line.append(fill);
    copy.append(kicker, label, counter, line, detail);
    veil.append(field, copy);
    frame.append(image, veil);
    host.replaceChildren(frame);

    const measure = generationProgress();
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => motion.matches || document.documentElement.dataset.reduceMotion === "true";
    const context = field.getContext("2d");
    let disposed = false, finishing = false, raf = 0, lastDraw = 0;
    let width = 1, height = 1, points = [], pulse = null, started = performance.now();
    const waits = new Map();

    function update(event) {
      if (disposed || finishing) return;
      const info = measure(event);
      label.textContent = info.label;
      counter.textContent = `${info.percent}%`;
      line.setAttribute("aria-valuenow", String(info.percent));
      fill.style.width = `${info.percent}%`;
      // Download bytes are scoped to a model file, never added to image completion.
      detail.textContent = info.detail || "Completed work";
    }
    function draw(now) {
      if (!context || disposed) return;
      context.clearRect(0, 0, width, height);
      const still = reduced();
      const time = still ? 0 : (now - started) / 1000;
      const sideAge = time % 3.2;
      const front = -0.12 + sideAge / 1.8 * 1.24;
      const radius = pulse === null || still ? -1 : (now - pulse) / 850;
      const maxDistance = Math.hypot(width * .58, height * .5);
      for (const p of points) {
        let alpha = .07 + p.energy * .23 * (still ? .5 : Math.pow((Math.sin(time * p.speed + p.phase) + 1) / 2, 2));
        let size = p.size;
        if (!still && !finishing && sideAge < 1.8) {
          const crest = Math.exp(-Math.pow((p.x - front) / .045, 2));
          alpha += crest * .22;
        }
        if (radius >= 0) {
          const distance = Math.hypot((p.x - .58) * width, (p.y - .5) * height) / maxDistance;
          const ring = Math.exp(-Math.pow((distance - radius) / .055, 2));
          alpha = alpha * (radius > distance ? .35 : 1) + ring * .48;
          size *= 1 + ring * .35;
        }
        const driftX = still ? 0 : Math.sin(time * .28 + p.phase) * 1.5;
        const driftY = still ? 0 : Math.cos(time * .22 + p.phase) * 1.1;
        context.fillStyle = `rgba(${p.cool ? "183,207,238" : "230,226,218"},${Math.min(.72, alpha)})`;
        context.fillRect(p.x * width + driftX, p.y * height + driftY, size, size);
      }
    }
    function resize() {
      if (disposed) return;
      const rect = frame.getBoundingClientRect();
      width = Math.max(1, rect.width); height = Math.max(1, rect.height);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      field.width = Math.round(width * dpr); field.height = Math.round(height * dpr);
      context?.setTransform(dpr, 0, 0, dpr, 0, 0);
      const columns = Math.max(10, Math.min(60, Math.round(width / 14)));
      const rows = Math.max(10, Math.min(60, Math.round(height / 14)));
      points = [];
      for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
        const index = row * columns + col;
        const noise = Math.abs(Math.sin((index + 1) * 12.9898 + row * 78.233) * 43758.5453) % 1;
        points.push({ x: (col + .5) / columns, y: (row + .5) / rows, energy: noise,
          phase: noise * Math.PI * 2, speed: .7 + noise, size: 1 + noise * .7, cool: index % 11 === 0 });
      }
      draw(performance.now());
    }
    function tick(now) {
      raf = 0;
      if (disposed || reduced() || document.hidden) return;
      if (now - lastDraw >= 40) { draw(now); lastDraw = now; }
      raf = requestAnimationFrame(tick);
    }
    function motionChanged() {
      if (disposed) return;
      frame.classList.toggle("is-still", reduced());
      cancelAnimationFrame(raf); raf = 0;
      draw(performance.now());
      if (reduced()) {
        for (const [timer, resolve] of waits) { clearTimeout(timer); resolve(); }
        waits.clear();
      } else if (!document.hidden && context) raf = requestAnimationFrame(tick);
    }
    function pause(ms) {
      if (disposed || reduced()) return Promise.resolve();
      return new Promise(resolve => {
        const timer = setTimeout(() => { waits.delete(timer); resolve(); }, ms);
        waits.set(timer, resolve);
      });
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf); raf = 0;
      for (const [timer, resolve] of waits) { clearTimeout(timer); resolve(); }
      waits.clear();
      sizeObserver?.disconnect(); settingsObserver.disconnect(); removalObserver.disconnect();
      motion.removeEventListener("change", motionChanged);
      document.removeEventListener("visibilitychange", motionChanged);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pagehide", dispose);
      signal?.removeEventListener("abort", dispose);
      frame.classList.remove("is-generating");
      frame.removeAttribute("aria-busy");
      image.style.filter = "none"; image.style.opacity = "1";
      veil.remove(); points = [];
    }
    async function finish(url, alt) {
      const ready = new Image();
      ready.src = url;
      await withSignal(ready.decode(), signal);
      if (disposed) throw new DOMException("Image creation stopped.", "AbortError");
      finishing = true;
      image.src = url; image.alt = alt;
      counter.textContent = "100%"; label.textContent = "Image ready"; detail.textContent = "Finished on this device";
      line.setAttribute("aria-valuenow", "100"); fill.style.width = "100%";
      frame.setAttribute("aria-busy", "false");
      pulse = performance.now();
      await withSignal(pause(900), signal);
      frame.classList.add("is-revealing");
      await withSignal(pause(550), signal);
      if (disposed) throw new DOMException("Image creation stopped.", "AbortError");
      dispose();
    }
    const sizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    sizeObserver?.observe(frame);
    if (!sizeObserver) window.addEventListener("resize", resize);
    const settingsObserver = new MutationObserver(motionChanged);
    settingsObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-reduce-motion"] });
    const removalObserver = new MutationObserver(() => { if (!frame.isConnected) dispose(); });
    removalObserver.observe(document.body, { childList: true, subtree: true });
    motion.addEventListener("change", motionChanged);
    document.addEventListener("visibilitychange", motionChanged);
    window.addEventListener("pagehide", dispose, { once: true });
    signal?.addEventListener("abort", dispose, { once: true });
    resize(); update({ stage: "load" }); motionChanged();
    if (signal?.aborted) dispose();
    return { update, finish, dispose, setArtwork(url) { if (!disposed && !finishing && url) image.src = url; } };
  }

  window.AtlasPoem3 = { prepare, isReady, unload, generate, loadPreview, download, exportImageData, restoreImage, progressInfo, progressText, createGenerationOverlay, withSignal };
})();

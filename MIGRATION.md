# AtlasChat Tauri migration

Work is confined to this sibling copy. The Electron source and installed data remain the recovery copy. This document records the implementation and validation as work proceeds.

## Inspected implementation

- Frontend: static `Atlas-CHAT.html` (desktop entry), `index.html`, shared CSS and JS; no frontend framework or bundler originally.
- Electron: `desktop/main.cjs` and its allowlisted `desktop/preload.cjs` bridge. Frameless 1240 x 850 window, minimum 650 x 500. Native dialogs, project preview/behavior checks, import/export, optional configured research.
- Chat inference: `NativeInference` drives pinned llama.cpp b11429 processes with Vulkan on Windows, Metal on macOS and CPU fallback, authenticated loopback SSE, SHA-256 downloads/resume, leases, cancellation and deadlines.
- Existing models: Apex 7.3 = Qwen2.5 7B Instruct GGUF Q4_K_M; UltraCode = Qwen2.5 Coder 7B GGUF Q4_K_M; Forge 2.1 = Qwen2.5 1.5B; Firefly 4.5 = Qwen2.5 0.5B. Browser-only WebLLM is a separate capability-dependent path. Selector effort labels do not establish the weights used.
- Poem 3: FLUX.2 Klein 4B through flux-klein.js 0.6.0, WebGPU and browser cache; generated images in IndexedDB `atlas-poem3-images-v1`. It is not a llama.cpp model.
- Chats/settings/global memory: browser localStorage (`apex.chats.v1`, `apex.settings.v1`, `apex.memory.v1`, plus legacy/preferences keys). Project files and project memory: native ZIP-backed ProjectManager, revision/hash guarded edits, checkpoints and Docker-scoped execution. InlineUI already sanitizes and isolates markup in sandboxed opaque-origin frames.
- Actual Electron profile found: `%APPDATA%/atlas-desktop`, with localStorage, IndexedDB, native-ai and coding-projects outside the source tree. All four chat model downloads and a Vulkan runtime are present. One Projects directory exists. Personal contents are not reproduced in reports.
- No implemented Microns or 7.5 runtime was found in the inspected application paths. Those remain future work. No replacement models are requested or added.

## Stages

1. Copy original application assets/source; omit regenerated node_modules and large model weights. Record source hashes and data inventory.
2. Add Tauri 2 Rust host, restricted command surface and managed Node sidecar to preserve tested project and inference modules. Node is packaged without Electron/Chromium.
3. Reuse original model files read-only; new downloads and writable caches belong to Tauri. Copy Projects into a new isolated data root. Export browser data from a disposable Electron profile snapshot, validate, then import once before app initialization. Preserve snapshot/export for recovery.
4. Keep both HTML entry points and UI assets. Add compatibility bridge, local Poem runtime assets and isolated project preview support.
5. Build Windows x64, run source/security/migration tests and real application checks where possible. Report actual evidence and remaining limits separately.

## References

- [Tauri capabilities and app-command ACL](https://v2.tauri.app/security/capabilities/)
- [Tauri configuration](https://v2.tauri.app/reference/config/)
- [Tauri sidecar packaging](https://v2.tauri.app/develop/sidecar/)

## Recovery policy

Never point WebView2 at the Electron profile. Never run the Electron exporter against the original profile. Never let downloads repair/overwrite files in the legacy model cache. Failed/partial imports must be retried or rolled back within the new profile only. Original Atlas remains independently runnable.

## Implemented architecture

- `src-tauri` is the Rust/Tauri 2 host. It owns the frameless window, dialogs, app-command ACL, main-window URL checks, preview WebViews, process supervision and shutdown. The application command manifest is restricted to the packaged main window. No filesystem, shell or arbitrary HTTP plugin is exposed to model-generated content.
- The original native inference and Projects modules run in a packaged plain Node service, not Electron. Rust sends a closed set of operations over private stdio, receives streamed inference events, and handles reverse native dialog/preview requests. There is no public RPC listener or cloud service. The separate Poem server is read-only, loopback-only, token-protected and restricted to validated cache mappings.
- `scripts/prepare.cjs` reuses the source HTML/CSS/JS and stages both entry points. Styling and fonts are unchanged. It adds the same `atlasDesktop` surface, startup data import gate and native drag behavior; bundles the pinned Poem runtime/tokenizer/WASM locally; and excludes personal data and test fixtures from deployed resources.
- Generated InlineUI remains sanitized and sandboxed with an opaque origin. Project previews use separate origins and private WebViews, no capabilities, blocked browser permissions and isolated-world assertions. WebView2 runtime exceptions feed the existing verification report. Default implicit favicon requests no longer turn a valid project into a failed build.
- Native model weights are SHA-256 checked and reused read-only. New downloads and extracted runtimes belong to the Tauri profile. Poem's existing physical cache files are read via HTTP ranges without a second weight copy. Original browser data was recovered from snapshots; Projects were validated in a staged independent root before publication.
- A Windows Job Object owns the Node service and descendant inference/tool processes. Shutdown cancels requests, awaits native unload and bounded Docker cleanup, and terminates the process tree if needed. At most one primary and one lightweight secondary runtime are permitted.

Small compatibility/reliability repairs were needed: the existing Project-start code referenced `active.chat` before initialization; Windows atomic Project replacements now tolerate transient scanner locks without deleting the destination; llama.cpp startup logging now exposes the offload line needed for accurate GPU reporting. Existing tests were updated where their mocks/schema assumptions lagged the current source. No new model family, Microns runtime, Project system or UI design was introduced.

## Outcome and performance boundary

The Windows x64 release executable, portable resource folder and separate NSIS installer were produced. Real WebView2 checks cover restored messages/images, all four native chat models, streaming, Stop, native GPU execution, offline default-size Poem generation and Project browser assertions including exception detection. See `TESTING.md` and `BUILD.md`.

The package is smaller than an Electron distribution, but this migration does **not** establish a RAM reduction. A single comparable visible-window sample measured approximately 240 MiB private memory for the Tauri debug shell versus 217 MiB for Electron, with models deferred in both. The retained Node service is a deliberate compatibility cost. This is not a controlled release benchmark or proof of AI speed changes. Preserve the Electron version as a fallback while reviewing the new build.

## Next architectural work for AtlasAI 7.5

1. Introduce versioned model/provider manifests for engine, format, quantization, context and acceleration requirements. Validate the user-selected future foundations separately before adding/downloading any of them.
2. Move stable native storage/download primitives into Rust incrementally if measurement justifies removing the Node process. Keep the existing frontend/model contract and integrity tests throughout.
3. Add a shared model lease pool and resource scheduler before background teammates, with explicit pause/shutdown controls and persisted task ownership. Several Microns should share one heavy engine instance.
4. Extend existing Project permission validation independently of model text: scoped roots, revision/hash edits and user-approved execution. Do not infer native authority from generated instructions.
5. Add schema-validated InlineUI templates within the existing opaque renderer, then test macOS Node packaging, WKWebView/GPU behavior and browser assertion parity before claiming platform support.

# Migration verification

Validation date: October 17, 2026. Results refer to this local Windows x64 environment and the existing downloaded models.

| Check | Result and evidence |
|---|---|
| Existing automated suites plus migration/Poem regression tests | 53/53 passed; `migration-data/tests.log`. Test doubles were updated for runtime IDs, SVG creation, chat-scoped state and ZIP checkpoint pairs. |
| Frontend in Tauri/WebView2 | Passed actual application launch; original desktop layout/styles retained. Both entry points are staged with the same compatibility bridge. |
| Packaged release | Windows release EXE launched from the portable folder with adjacent deployed resources and closed normally. Separate NSIS installer built successfully, approximately 37.8 MiB. Installer wizard itself was not installed into the OS during testing. |
| Browser data migration | 11 conversations, all original message objects compared against the export, 13 original images restored. The validation profile has one additional generated test image. No personal text is reproduced in this report. |
| Native Projects migration | Existing project copied and opened with its revision preserved. |
| Settings across restart | Appearance toggle worked in the real new profile, persisted across a second launch, and was restored to the original preference. `migration-data/real-profile-results.json` and `persistence-results.json`. |
| Project browser behavior | Real WebView2 click/assert behavior test passed; screenshot captured. A second fixture with an intentional JS exception correctly failed. Assertions execute in an isolated world. |
| Native command confinement | Unknown command rejected. Main-window capability only; no frontend shell or filesystem plugin. Generated InlineUI script removed and frame verified opaque-origin. |
| WebGPU/browser support | Actual WebGPU device creation succeeded, including shader-f16/subgroups support; WASM, workers, IndexedDB and OPFS available. SharedArrayBuffer absent with the current non-isolated document. |
| Existing models | Firefly, Forge, Apex 7.3 and UltraCode each initialized and produced streamed responses through the real Tauri bridge. `migration-data/inference-results.json`. |
| Stop | An in-flight Firefly generation was cancelled and its model process terminated. Unit tests also cover stalled setup, stale requests, deadlines and CPU fallback. |
| Native GPU execution | Read-only offline probe confirmed NVIDIA RTX 5070 Vulkan execution and 25/25 Firefly layers offloaded. `migration-data/gpu-results.json`. Existing logging at verbosity 3 hid the offload line and incorrectly labeled acceleration as CPU; verbosity 4 fixes the existing supervisor's reporting. |
| Poem 3 | Actual 512 x 512 image generated, saved in IndexedDB and preview decoded, with external fetches blocked: zero external fetch attempts, approximately 102 seconds including initialization. `migration-data/poem-results.json`. |
| Existing downloads/cache | All four GGUF models validated against existing pinned SHA-256 digests; 12 Poem cache files mapped and content-validated without copying weights. Unit tests cover resumable transfer, corrupt downloads and archive traversal. |
| Offline | Native Firefly load/reply completed with external backend fetches rejected. Poem's existing default 512px path completed with external browser fetches rejected. |
| Original preservation | Final original source SHA-256 comparison and complete profile size/mtime comparison unchanged. No original installation or model file was removed or replaced. |

## Limits and remaining manual checks

- This is a locally built migration, not a broad release certification. Manual keyboard, accessibility, clipboard, file-picker and visual interaction review remains useful; the full frontend was preserved rather than redesigned.
- The 256px Poem offline test initially requested an uncached r256 decoder and correctly failed. The user's cached r320/default 512px path passed. Other sizes/variants may need their existing one-time decoder download. No new Atlas 7.5 models were added.
- Fresh multi-GB downloads were not repeated unnecessarily. Transfer correctness is covered by deterministic download tests and existing-file validation; real slow/interrupted network transfers need a separate network test.
- Physical CPU fallback after a real GPU failure, concurrent secondary-model pressure, low-memory behavior and macOS remain unverified. Unit fallback/cancellation tests are not hardware proof.
- Docker build/test execution and daemon-side container cleanup were not exercised live. The existing restricted Docker runner and approval flow remain; shutdown now awaits its bounded cleanup jobs, while a Windows Job Object kills child native processes if the host exits/crashes.
- The optional research service is not configured in this environment. Its existing opt-in configuration and behavior remain.
- SharedArrayBuffer/cross-origin isolation was not enabled just for the migration. The Poem library uses its existing single-thread WASM fallback here. GPU compute remains WebGPU; enabling isolation later requires dependency/header compatibility checks and measurement.

## Local evidence

`migration-data` keeps exports, source/profile inventories, build logs, raw model/smoke reports, the isolated validation profile and screenshots. These files can contain personal data and are not bundled with the app.

## Shell measurement

A single warm visible-window comparison used the same conversation snapshot and deferred model initialization in both applications. Measurements were taken after 15 seconds plus a 5-second CPU sample. The first run was discarded because Electron was hidden and therefore subject to different background throttling.

| Sample | Electron 40 | Tauri 2 debug |
|---|---:|---:|
| Private memory, summed process tree | 217.0 MiB | 239.7 MiB |
| Working sets, summed process tree | 340.5 MiB | 434.3 MiB |
| CPU, percent of one core during sample | 16.25% | 7.19% |
| Window appearance after launch | 566 ms | 155 ms |

These are shell observations, not model-performance benchmarks. Summed working sets double-count shared pages; the window-appearance metric is not full UI/model readiness. The Tauri sample includes the debug validation poll and retained Node service. Both apps were displaying the existing pending-load UI, so this is not a steady-state model-ready idle test. Do not use these numbers to promise a RAM reduction: this sample shows about 23 MiB **more** private memory for Tauri. A controlled release benchmark remains future work. Raw evidence: `migration-data/performance.json`.

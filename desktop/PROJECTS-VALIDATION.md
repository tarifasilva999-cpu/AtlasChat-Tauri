# Projects implementation verification

Date: October 2, 2026.

## Core suite

`npm run check:core`: 20 passing tests.

Tests cover persistent reopen, two-chat shared state, simultaneous stale writes, file-hash conflicts, checkpoint restoration and retention, memory and command persistence, legacy migration, ZIP binary/folder round-trip, traversal/duplicate/expansion protection, dependency/path restrictions, syntax/export/configuration/asset failures, repair budgets and stall detection, telemetry, restart recovery, cancellation and source-bound completion gates.

The failure fixture `fixtures/card-game.zip` is copied from the actual supplied Create-a-Full-Game-Build.zip. It contains a missing scripts/build.js reference, nested illegal import declarations in script.js, prose instead of PNG bytes, absent cards/ images and inconsistent card modules. The actual runner rejects it at static audit before any Docker execution or download. Its status cannot become verified.

## Real Chromium integration

`npm run check:browser` uses hidden Electron windows and the production preview engine, with hardware acceleration disabled for the test process only. Scenarios:

1. Full static-project audit/run/behavior pipeline, requiring no Docker, with success tied to the source hash.
2. Real button click followed by a DOM assertion.
3. Silent button failure with no console error.
4. Exception raised by an interaction.
5. Missing image / network 404.
6. Clean load without behavior tests: remains unverified.
7. Failed module resource request.
8. Uncaught exception during page startup.

All eight scenarios passed in the final Chromium run.

## Usage measurements

The larger retrieval fixture has 303 files. A movement/gravity request selected three relevant files and returned 153 source characters under a 1,200-character content cap. It did not place all 303 files in model context.

The deterministic inference-double workflow completed a primary implementation and one focused repair using three model calls, one repair and zero research calls. These verify routing/accounting limits; they are not measurements of live model generation speed, token usage, or first-build success rates.

## Remaining verification

Docker is absent from PATH and the standard installation path, so Python/npm container execution was not run. No model weights were downloaded and live Apex/Ultra Code inference was not exercised. Visual layout, device GPU behavior, controller input, Godot execution and production package builds remain unverified. Existing differences between index.html and Atlas-CHAT.html were preserved; both received the Projects chat-binding changes and passed inline JavaScript syntax checks.

The workspace is a bounded persisted virtual filesystem, not a full Git client or language server. Semantic embeddings and additional runtime adapters are future extensions. Behavior verification checks declared tests; it cannot certify untested requirements or visual quality.

A pre-edit source backup is available in `.projects-implementation-backup/` at the Atlas workspace root.

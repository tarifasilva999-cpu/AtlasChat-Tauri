# Atlas Projects

## AtlasChat command line

Start a local, interactive chat from a terminal:

```sh
npm run chat
npm run chat -- --model firefly
npm run chat -- --model apex --yes
```

The CLI uses the same pinned llama.cpp runner and Qwen model catalog as Atlas's
desktop chat. Forge is the default model. Before loading a model, Atlas asks for
confirmation because first use may download its weights and the local runner.
`--yes` skips that prompt. Replies stream as they are generated; `/model` lists
choices, `/model forge` switches models, `/clear` resets the current
conversation, and `/exit` closes the CLI. The conversation remains in memory
for that session.

The CLI looks for an existing `Atlas` or `atlas-desktop` data directory and
reuses its `native-ai` cache. Set `ATLAS_USER_DATA_DIR` to choose the data
directory explicitly when needed.

Projects replaces the desktop **Build and run** toggle. Open **Projects** beside the composer to create a workspace, import a ZIP, resume a project, or start another chat in it. Select Apex 7.3 Ultra when asking for implementation work. Existing project cards and legacy runs remain readable and migrate in place.

## Workspace and conversations

Each project has one canonical, persistent virtual filesystem in the app's user-data directory, under `coding-projects/<project-id>/workspace.json`. The atomic snapshot contains file paths, text or lossless binary content, metadata, revisions, project notes, command settings, activity, task telemetry and change history. ZIPs are import/export formats. All project chats refer to the same ID; follow-ups no longer copy a previous run into a new project.

The original Store is extended by `ProjectManager` in `projects.cjs`. Old `run.json` / `source.json` workspaces migrate on their first command without changing their identity. Chat histories remain separate in Atlas's existing chat storage. `SEARCH_CHATS` searches only matching fragments in other conversations belonging to this project, and only when requested. Shared project notes do not automatically archive conversations or summarize every turn.

Writes require the revision observed by the caller. Replacements and patches also require the observed file hash; patches must match exactly once. Concurrent writes are serialized and stale edits fail with a conflict. A task captures its chat identity, preventing a navigation change from redirecting work. Restart recovery interrupts unfinished tasks while retaining completed files.

Before a task, Projects saves a recoverable checkpoint. The latest 20 snapshots are retained. Restoring a checkpoint restores files, architecture, notes and entry configuration, and invalidates previous verification. Revision history records task/chat identity, touched files, old/new hashes, checkpoint and time.

Limits: 512 files, 8 MB per file, 32 MB of decoded workspace contents, 20 retained checkpoints, 100 change records and 50 task records. ZIP paths are validated before creation; traversal, duplicate/case-colliding names, reserved paths and expansion-limit violations are rejected. Imports preserve image bytes and empty directories. Python, web, Godot and unknown archives can persist; Godot/unknown execution adapters are not yet implemented.

## Commands and context

The restricted preload exposes `projectCommand`, not a host filesystem or shell. The main process validates the caller and project ID.

| Area | Commands |
| --- | --- |
| Inspect | PROJECT_STATUS, LIST_FILES, LIST_DIRECTORY, READ_FILE, READ_RANGE, SEARCH_FILES, SEARCH_SYMBOL, FIND_REFERENCES |
| Dependencies | GET_DEPENDENCIES, GET_DEPENDENTS, GET_PROJECT_MANIFEST |
| Shared context | SELECT_CONTEXT, GET_PROJECT_MEMORY, SET_PROJECT_MEMORY, SEARCH_CHATS (renderer chat storage) |
| Edit | CREATE_FILE, WRITE_FILE, PATCH_FILE, DELETE_FILE, MOVE_FILE, RENAME_FILE, CREATE_DIRECTORY |
| Configuration | SET_MANIFEST, SET_COMMANDS, RENAME_PROJECT |
| Changes | GET_CHANGED_FILES, GET_RECENT_CHANGES, CHECKPOINT, LIST_CHECKPOINTS, ROLLBACK |
| Verify | AUDIT, CHECK_SYNTAX, VALIDATE_REFERENCES, VALIDATE_ASSETS; BUILD / RUN / RUN_TESTS / RUN_BROWSER_TEST use the combined verification pipeline |
| Results | GET_BUILD_OUTPUT, GET_RUNTIME_OUTPUT, GET_CONSOLE_ERRORS, GET_NETWORK_ERRORS, SCREENSHOT |
| Export | EXPORT_ZIP |

`BATCH` groups up to eight manager operations. Execution/export are main-process operations and are requested individually. Model responses can group four inspection/edit operations without an inference round-trip between them.

Indexes cache content hashes, basic symbols, literal imports/exports and asset references, invalidating when source or tree structure changes. JavaScript syntax results are cached with indexed content. This is a lightweight lexical index, not a complete language server or semantic embedding search. Dynamic references, TypeScript interfaces, Python imports and arbitrary shared object contracts still require execution/tests or further adapters.

Context selection ranks filenames, symbols and matching source, then adds direct dependencies. It returns at most five bounded excerpts. Actual current files come before notes or old conversations. The coder sees the canonical architecture, focused source, compact command results and exact failures; it does not receive every project file or every conversation. Truncated reads are labeled, and precise ranges can be requested.

## Models and usage

Apex 7.3 Ultra produces one short architecture/interface plan for medium/large tasks. Simple edits skip architecture planning. The existing optional Ultra Code model loader handles implementation, preserving the model-download confirmation, cancellation and explicit fallback behavior. Model routing is separate from workspace management and validation. The current coding model ID remains Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC; its size does not define project storage or command capabilities. The context budget can be supplied through the adapter's `projectContextWindow` property; the current default is 4,096 tokens.

| Complexity | Maximum model calls | Maximum automatic repairs | Maximum research calls |
| --- | --- | --- | --- |
| Small | 4 | 1 | 0 |
| Medium | 10 | 2 | 1 |
| Large | 20 | 3 | 2 |

Budgets are enforced in persisted task state before inference. Tool loops consume this same budget. Repeated failure evidence stops automatic repairs; changing only a reported duration does not justify another repair. Research requires a specific question and local repair evidence, remains optional, and uses the existing Atlas research service. No general web browsing is performed for every task. Tasks also have the existing ten-minute cancellation deadline.

Telemetry records model-call count, prompt/output/context character counts, files read/changed, build attempts, repairs, research and elapsed time. Character counts are estimates of context cost, not claimed tokenizer usage. These metrics are stored internally rather than shown by default.

## Audit, run and completion

The pipeline is **targeted edits → deterministic audit → build/run → behavior checks → focused repair → repeat only with new evidence**.

The static audit checks entrypoints, literal HTML/CSS asset paths, local imports, explicit named/default exports, undeclared npm dependencies, JSON configuration, JavaScript and inline-script syntax, and image signatures. Text masquerading as a PNG fails before execution. Unknown contracts and dynamic paths are not treated as statically proven.

Static HTML projects without package.json run directly in a separate Electron preview session, with no host bridge, permissions, external network, navigation or popups. No Docker download is needed for these projects. The preview captures console errors, uncaught exceptions, failed/blocked resource requests, broken images and a screenshot. Manual Preview opens the app without executing its test clicks.

Python and npm projects retain the original Docker runner. Only a disposable, materialized project copy is mounted. The canonical source, host home, credentials, Docker socket and chats are not mounted. Runtime images are pinned after approval. Containers retain read-only roots, non-root users, dropped capabilities, resource limits, bounded logs, cancellation, 90-second command limits, and networking only during approved dependency installation. Persistent servers and interactive stdin are not supported by this first execution adapter.

Commands are detected from project configuration, recorded after successful execution, and can be overridden with finite node/python/npm argument arrays under **Project notes → Run commands**. These execute inside the container. Python gets compilation, unittest discovery and a finite entrypoint run; npm gets declared typecheck/build/test commands and finite Node entrypoints. Missing Docker retains source and reports execution unavailable.

Web completion requires `project.tests.json` containing actual DOM actions and assertions, for example:

```json
{
  "tests": [{
    "name": "Add increments the score",
    "steps": [
      {"action": "click", "selector": "#add"},
      {"action": "assert", "selector": "#score", "property": "text", "equals": "1"}
    ]
  }]
}
```

Supported actions: click, type, keydown, wait and assert. Assertions support text, value, count, attribute and visibility. Bounds: 20 tests, 30 steps per test, 1.5-second waits, a 20-second test deadline and a 30-second preview deadline. Passing DOM checks prove their asserted behavior, not comprehensive game quality. These are synthetic DOM interactions; browser-native input, animation feel, WebGL rendering and controller hardware need additional verification.

A clean page load or a zero-test Python run cannot become a verified project. Python/npm completion requires observed passing test output. Results must match the exact current source hash. Unverified files are explicitly exported as a draft after confirmation. A verified export is never generated automatically from a failed build.

## Backups and setup

Desktop **Save a backup** includes all Projects, chat bindings, source, metadata and checkpoints in an AtlasBundle v2. Restore accepts v1/v2 bundles, assigns new project IDs, restores notes/commands/checkpoints, and requires fresh verification. Bundles are bounded to 50 MB expanded. Existing JSON chat-backup import remains available. Ordinary project ZIPs contain files/folders; use a desktop bundle to preserve Atlas-specific metadata and checkpoints.

Development commands: `npm run desktop`, `npm run package`, `npm run check:core`, `npm run check:browser`. npm/Python execution needs Docker with Linux containers. No package build or model download was performed in this implementation pass.

The existing research service is `service/research.cjs`. It uses BRAVE_SEARCH_API_KEY, ATLAS_SESSION_SECRET, optional HOST/PORT/ATLAS_SEARCH_HOURLY_LIMIT and ATLAS_TRUST_PROXY configuration. The desktop reads ATLAS_SEARCH_URL. Provider credentials remain on the service host. Public release still needs durable account/shared-service quotas; the existing anonymous in-memory limits are not a billing system.

## Verification status

See [PROJECTS-VALIDATION.md](PROJECTS-VALIDATION.md) for tested scenarios and remaining runtime limits. Core tests use real persistence and the exact attached ZIP; model orchestration uses deterministic inference doubles. Browser integration tests use the production isolated Chromium preview and static-project execution pipeline. Docker/npm/Python container execution and live WebLLM generation remain unverified on this machine.

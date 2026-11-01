# Build and run AtlasChat

## GitHub releases

Each new commit pushed to `main` gets a signed Windows release through `.github/workflows/release.yml`. A push containing multiple first-parent commits schedules a release for each. The build uses the checked-in major/minor version and adds the number of commits since the `v1.0.0` baseline to its patch version; CI applies that version to all Tauri, Cargo and npm version fields in the build checkout. The source version files are not changed by CI. The first commit after `v1.0.0` therefore builds as `v1.0.1`. Pushed version tags also retain the existing manual release workflow and must match the checked-in app version. GitHub repository signing secrets must remain configured for updater artifacts.

This folder is the migration copy. `../Atlas` remains the original Electron application. Git and GitHub accounts are not required.

## Windows prerequisites

- Windows 11 x64 with Microsoft Edge WebView2 Runtime (the installed runtime was used for validation).
- Node.js 24 and npm; the packaged runtime was prepared with Node 24.13.0.
- Rust MSVC toolchain and Visual Studio C++ build tools/Windows SDK.
- Network access for the first dependency installation; existing model files are reused locally.

From this folder in PowerShell:

```powershell
npm ci
npm test
npm run desktop
```

The frontend remains the existing HTML/CSS/JavaScript. `scripts/prepare.cjs` stages both chat entry points, adds the Tauri bridge/startup migration gate, bundles the pinned Poem runtime and copies the managed Node service. Do not edit generated `frontend-dist` or `src-tauri/resources/backend` files; edit the source and prepare again.

```powershell
npm run build:desktop
```

The x64 installer is `src-tauri/target/release/bundle/nsis/AtlasChat_0.1.0_x64-setup.exe`. It installs AtlasChat separately from Electron Atlas. The installer uses the existing system WebView2 runtime; it does not include an offline WebView2 installer. The build is unsigned.

`npm run build:exe` builds without an installer. The executable needs its adjacent `node` and `backend` resource folders. Use the supplied `dist/AtlasChat` folder as a unit; moving only the EXE will break native operations.

## Data migration and recovery

The current migration uses `%APPDATA%/atlas-desktop` as the original profile and `%APPDATA%/ai.atlas.chat.tauri` as the new profile. It never points WebView2 at Electron storage.

The local export/snapshots in `migration-data` contain personal data. Keep them private; they are excluded from the application bundle and from the ignore-file's default publication set. No data was uploaded.

For another fresh profile, close the original app before snapshotting, then run:

```powershell
npm run migrate:data
node migration/export.cjs --cache
node migration/install.cjs
```

The exporter needs the existing Electron executable at `../Atlas/node_modules/electron/dist/electron.exe`; override `ATLAS_EXPORT_ELECTRON` if necessary. It reads browser data only through a disposable profile. Completed Poem cache files are mapped to their original physical files and validated against upstream LFS hashes (Xet ETags are not SHA-256 hashes). `--cache` does not duplicate the weights. The mapping can be retried separately with `node migration/map-poem.cjs` if only mapping failed. Export/install commands refuse to replace existing completed outputs/profiles.

The installer copies Projects into a staged new profile, validates them, and atomically publishes it. Browser chats/preferences/images are imported and verified before the frontend reads them; a completion marker prevents reimport on later launches. Partial imports are retryable. Exports and the original profile remain the recovery source.

If migration fails, close AtlasChat, preserve/rename only its new profile, and rerun the install step for a fresh target. Do not reset or delete the Electron profile. Preserve `electron-export.json`, `electron-cache-export.json`, `source.json`, and the receipts before retrying. A nonempty unrelated Tauri profile is not silently overwritten; use the app's existing backup restore flow for intentional replacement.

Keep the original model/cache directories available. Tauri reads validated GGUF files there; it writes new downloads, runtime extraction and receipts only under its own `native-ai`. Poem reads the mapped cache through a token-protected loopback range server, without copying the multi-GB files into WebView2. Normal new Poem downloads still use its existing OPFS cache.

## Validation tools

- `npm test`: inherited regression suites plus migration checks and Poem tests.
- `node scripts/inventory.cjs --verify`: compare original source SHA-256 hashes and profile size/mtime inventory against the pre-migration record.
- `migration/smoke.js`, `inference-smoke.js`, `poem-smoke.js`: actual WebView2 validation scenarios, enabled only in a debug build with `ATLAS_VALIDATION_SCRIPT` and an isolated `ATLAS_TAURI_DATA_DIR`. The release executable omits the script runner.
- `scripts/benchmark.ps1`: desktop-shell comparison with models deferred in both apps and disposable data profiles.

See `TESTING.md` for measured results and limits. macOS is not a validated deliverable: it needs platform-specific Node packaging, WKWebView checks and an equivalent isolated project-browser test adapter.

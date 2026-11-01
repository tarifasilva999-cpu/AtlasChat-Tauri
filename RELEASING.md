# Releasing AtlasChat Tauri

The updater checks the GitHub Releases `latest.json` feed. The release workflow builds and publishes a Windows installer for each commit pushed to `main`, and also supports an explicitly pushed matching `v<version>` tag.

Before the first release:

1. Keep the updater private key outside this repository and make a secure backup. Losing it prevents future updates for existing installs.
2. Add the private key as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`. If the key has a passphrase, add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too. Never put the private key in source control or share it publicly.
3. Keep the version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` aligned. Push the release commit to `main`; the workflow creates the matching tag and publishes the release. A new checked-in version starts a new version line, with subsequent commits receiving increasing patch versions.

The workflow builds the signed NSIS installer and publishes it to GitHub Releases. Manually pushed tags must match the checked-in app version. Install the first updater-enabled build manually; later releases can be offered in-app.

Windows updates use the passive NSIS installer. When the user selects Install and restart, AtlasChat exits and the installer reopens it after installation. A new signed release and matching tag are required for existing installations to receive an update; pushing source alone does not publish one.

The in-app prompt can be deferred. Settings > You > Check for updates reopens an available update. Installation waits until the current chat or project task has finished or been stopped. Download failures retain the update so the user can retry.

NSIS uses the header and welcome/finish artwork in `src-tauri/installer`. Run `src-tauri/installer/generate-branding.ps1` to regenerate these bitmaps. The app and installer icons keep their existing artwork.

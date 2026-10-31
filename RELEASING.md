# Releasing AtlasChat Tauri

The updater is configured to check the GitHub Releases `latest.json` feed. The release workflow builds the Windows installer and publishes a release when a matching `v<version>` tag is pushed.

Before the first release:

1. Keep the updater private key outside this repository and make a secure backup. Losing it prevents future updates for existing installs.
2. Add the private key as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`. If the key has a passphrase, add it as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too. Never put the private key in source control or share it publicly.
3. Bump the version in `src-tauri/tauri.conf.json`, commit and push the change, then push the matching tag, such as `v0.1.1`.

The workflow checks that the tag matches the app version, builds the signed NSIS installer, and publishes it to GitHub Releases. Install the first updater-enabled build manually; later releases can be offered in-app.

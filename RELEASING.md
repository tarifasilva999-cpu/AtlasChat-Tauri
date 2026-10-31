# Releasing AtlasChat Tauri

The release workflow builds a Windows installer and publishes it to a GitHub Release when a `v<version>` tag is pushed. The app version in `src-tauri/tauri.conf.json` must match the tag.

Before the first release, finish the updater signing setup:

1. Generate a Tauri updater key pair and save the private key outside this repository. Never publish or share the private key. Keep a secure backup; losing it prevents future updates for existing installs.
2. Add the private key as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`. If the key has a passphrase, add that as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too.
3. Put the generated public key in `src-tauri/tauri.conf.json` with the GitHub Releases `latest.json` endpoint, enable `bundle.createUpdaterArtifacts`, and enable update checks in `tauri/updater.js`.
4. Commit the configuration and push it to `main`. Bump the app version in `src-tauri/tauri.conf.json`, commit, then push a matching tag such as `v0.1.1` to publish an update.

Do not push a release tag until the updater configuration and GitHub secret are set. The first updater-enabled installer must be installed manually; it enables existing installations to receive later updates.

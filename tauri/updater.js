import { check } from "@tauri-apps/plugin-updater";

// Signed updates are served from the GitHub Releases endpoint in tauri.conf.json.
const UPDATE_FEED_CONFIGURED = true;
const REQUEST_TIMEOUT_MS = 12_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
let checkInFlight = null;
let updateFound = false;

async function checkForUpdates(force = false) {
  if (!UPDATE_FEED_CONFIGURED || !window.atlasDesktop || !window.__TAURI__) return false;
  if (!navigator.onLine) {
    if (force) throw new Error("Connect to the internet to check for updates.");
    return false;
  }
  if (checkInFlight) return checkInFlight;
  if (updateFound && !force) return true;

  checkInFlight = (async () => {
    try {
      const update = await check({ timeout: REQUEST_TIMEOUT_MS });
      if (!update) return false;

      updateFound = true;
      window.dispatchEvent(new CustomEvent("atlas:tauri-update-available", {
        detail: { update }
      }));
      return true;
    } catch (error) {
      console.info("Atlas update check is unavailable:", error?.message || error);
      if (force) throw error;
      return false;
    } finally {
      checkInFlight = null;
    }
  })();

  return checkInFlight;
}

window.atlasTauriUpdater = Object.freeze({
  checkForUpdates: () => checkForUpdates(true)
});

function scheduleStartupCheck() {
  window.setTimeout(() => { void checkForUpdates(); }, 8_000);
}

if (document.readyState === "complete") {
  scheduleStartupCheck();
} else {
  window.addEventListener("load", scheduleStartupCheck, { once: true });
}

window.addEventListener("online", () => { void checkForUpdates(); }, { passive: true });
window.setInterval(() => { void checkForUpdates(); }, CHECK_INTERVAL_MS);

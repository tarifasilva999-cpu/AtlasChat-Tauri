/* Shared update UI; native installation stays inside Tauri's signed updater. */
(() => {
  "use strict";
  const get = id => document.getElementById(id);
  const banner = get("updateBanner"), button = get("updateNow");
  const message = get("updateMessage"), progress = get("updateProgress");
  const checkButton = get("settingsCheckUpdates"), status = get("settingsUpdateStatus");
  let nativeUpdate = null, registration = null, installing = false, checking = false;
  let beforeInstall = () => true;

  function show() { banner.classList.add("show"); }
  function dismiss() { if (!installing) banner.classList.remove("show"); }
  function setInstalling(value) {
    installing = value;
    button.disabled = value;
    get("updateDismiss").disabled = value;
    get("updateLater").disabled = value;
    banner.setAttribute("aria-busy", String(value));
  }
  function available(update) {
    if (installing) return;
    nativeUpdate = update;
    get("updateTitle").textContent = "AtlasChat " + update.version + " is ready";
    message.textContent = "Install the latest improvements. AtlasChat will close and reopen; your chats and models stay here.";
    status.textContent = "Version " + update.version + " available";
    button.textContent = "Update and restart";
    progress.hidden = true;
    show();
  }
  function showWeb(reg) {
    registration = reg || registration;
    get("updateTitle").textContent = "An update is ready";
    message.textContent = "Refresh AtlasChat for the latest improvements. Your chats stay on this device.";
    button.textContent = "Update and refresh";
    show();
  }

  get("updateDismiss").onclick = dismiss;
  get("updateLater").onclick = dismiss;
  banner.addEventListener("keydown", event => {
    if (event.key === "Escape" && !installing) {
      dismiss();
      document.getElementById("input")?.focus({ preventScroll: true });
    }
  });
  window.addEventListener("atlas:tauri-update-available", event => {
    if (window.atlasDesktop && event.detail?.update) available(event.detail.update);
  });

  button.onclick = async () => {
    if (installing) return;
    if (!beforeInstall()) {
      message.textContent = "Finish or stop the current task, then update when you’re ready.";
      return;
    }
    if (!nativeUpdate) {
      if (window.atlasDesktop) return checkButton.click();
      setInstalling(true);
      button.textContent = "Refreshing…";
      if (registration?.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
      else location.reload();
      return;
    }
    setInstalling(true);
    button.textContent = "Downloading…";
    let total = 0, downloaded = 0;
    try {
      await nativeUpdate.downloadAndInstall(event => {
        if (event.event === "Started") {
          total = event.data?.contentLength || 0;
          progress.hidden = false;
          progress.removeAttribute("value");
          message.textContent = "Downloading the update. Keep AtlasChat open.";
        } else if (event.event === "Progress") {
          downloaded += event.data?.chunkLength || 0;
          if (total) progress.value = Math.min(100, Math.round(downloaded / total * 100));
        } else if (event.event === "Finished") {
          progress.value = 100;
          button.textContent = "Installing…";
          message.textContent = "Installing the update. AtlasChat will reopen automatically.";
        }
      });
      // On Windows the updater hands off to NSIS and exits the app itself.
    } catch (error) {
      console.error("AtlasChat update installation failed:", error);
      progress.hidden = true;
      message.textContent = "The update couldn’t be installed. Check your connection and try again.";
      button.textContent = "Try again";
      setInstalling(false);
    }
  };

  checkButton.onclick = async () => {
    if (checking || installing) return;
    if (nativeUpdate) { available(nativeUpdate); return; }
    checking = true;
    checkButton.disabled = true;
    status.textContent = "Checking…";
    try {
      if (window.atlasDesktop) {
        if (!window.atlasTauriUpdater) throw new Error("The updater is unavailable.");
        const found = await window.atlasTauriUpdater.checkForUpdates();
        if (!found) status.textContent = "You’re up to date";
      } else if (registration) {
        await registration.update();
        if (registration.waiting) showWeb(registration);
        status.textContent = registration.waiting ? "An update is ready" : "Checked for updates";
      } else status.textContent = "Updates load when you reopen AtlasChat";
    } catch {
      status.textContent = "Couldn’t check. Try again when you’re online.";
    } finally {
      checking = false;
      checkButton.disabled = false;
    }
  };
  window.AtlasUpdates = Object.freeze({
    configure(options) { if (typeof options.beforeInstall === "function") beforeInstall = options.beforeInstall; },
    setWebRegistration(reg) { registration = reg; },
    showWeb
  });
})();

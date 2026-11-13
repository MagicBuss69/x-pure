// Cross-browser MV3 background script (Chrome service worker + Firefox event page).
// Manages default settings in storage.local and keeps the toolbar badge synced
// with the current on/off toggle state.

const ext = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "enabled";

let syncQueue = Promise.resolve();

function syncExtensionState(enabled) {
  syncQueue = syncQueue
    .then(async () => {
      await ext.action.setBadgeText({ text: enabled ? "" : "OFF" });
      if (!enabled) {
        await ext.action.setBadgeBackgroundColor({ color: "#52525b" });
        if (typeof ext.action.setBadgeTextColor === "function") {
          await ext.action.setBadgeTextColor({ color: "#ffffff" });
        }
      }
    })
    .catch((err) => {
      console.error("[Friends Only] Failed to sync state:", err);
    });

  return syncQueue;
}

async function initState() {
  const stored = await ext.storage.local.get({ [STORAGE_KEY]: true });
  const enabled = stored[STORAGE_KEY] !== false;
  await ext.storage.local.set({ [STORAGE_KEY]: enabled });
  await syncExtensionState(enabled);
}

ext.runtime.onInstalled.addListener(() => {
  initState();
});

ext.runtime.onStartup.addListener(() => {
  initState();
});

ext.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEY]) {
    syncExtensionState(Boolean(changes[STORAGE_KEY].newValue));
  }
});

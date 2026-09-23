// Non-persistent, so tab state lives in storage rather than in memory.
const store = browser.storage.session || browser.storage.local;
const key = (tabId) => `tab:${tabId}`;
const NATIVE_ID = "com.bezalel.tabmixer"; // Safari ignores the value but requires one
// Routine "info" events are only logged when VERBOSE is true (same flag in
// background.js, bridge.js, inject.js and popup.js). Warnings, errors and the
// Dump button's "notice" snapshots are always logged.
const VERBOSE = false;

// ---- logging ----------------------------------------------------------------
// Entries from every part of the extension are batched here and handed to the
// native handler, which writes them to the unified log (see tools/logs.sh).
const buf = [];
let flushTimer = null;
let nativeFailed = false;

function enqueue(entry) {
  if (entry.level === "info" && !VERBOSE) return;
  if (entry.data !== undefined && typeof entry.data !== "string") {
    let s;
    try { s = JSON.stringify(entry.data); } catch { s = String(entry.data); }
    entry.data = s && s.length > 3000 ? s.slice(0, 3000) + "…(truncated)" : s;
  }
  console.log(`[${entry.src}] ${entry.level} ${entry.event}`, entry.data || "");
  buf.push(entry);
  if (buf.length >= 25) flush();
  else if (!flushTimer) flushTimer = setTimeout(flush, 250);
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!buf.length) return;
  const entries = buf.splice(0);
  try {
    await browser.runtime.sendNativeMessage(NATIVE_ID, { type: "log", entries });
    nativeFailed = false;
  } catch (err) {
    // Only complain once per failure streak; the console copy above still exists.
    if (!nativeFailed) console.error("Tab Mixer: native logging failed:", err);
    nativeFailed = true;
  }
}

const log = (level, event, data) => enqueue({ src: "bg", level, event, data, t: Date.now() });
const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };

log("info", "start", {
  version: browser.runtime.getManifest().version,
  storage: browser.storage.session ? "session" : "local",
});

// ---- state ------------------------------------------------------------------
async function getState(tabId) {
  const r = await store.get(key(tabId));
  return r[key(tabId)] || null;
}

async function setState(tabId, state) {
  const isDefault = state.volume === 100 && !state.muted;
  if (isDefault) await store.remove(key(tabId));
  else await store.set({ [key(tabId)]: state });
}

// The popup's on/off switch. Off sends every tab the default (normal volume)
// while keeping the saved per-tab settings; persists across restarts.
const DEFAULT = { volume: 100, muted: false };
const ENABLED = "pref:enabled";
async function isEnabled() {
  const r = await browser.storage.local.get(ENABLED);
  return r[ENABLED] !== false;
}
const effective = async (state) => ((await isEnabled()) ? state : DEFAULT);

async function setEnabled(on) {
  await browser.storage.local.set({ [ENABLED]: on });
  const all = await store.get(null);
  // Only tabs with a saved setting differ from the default; re-apply those.
  for (const [k, state] of Object.entries(all)) {
    if (!k.startsWith("tab:")) continue;
    const tabId = Number(k.slice(4));
    browser.tabs.sendMessage(tabId, { type: "apply", ...(on ? state : DEFAULT) }).catch(() => {});
  }
  log("info", "enabled", { enabled: on });
}

async function dumpEverything() {
  const tabs = await browser.tabs.query({});
  const all = await store.get(null);
  const states = {};
  for (const [k, v] of Object.entries(all)) if (k.startsWith("tab:")) states[k.slice(4)] = v;
  let registered;
  try { registered = await browser.scripting.getRegisteredContentScripts(); }
  catch (err) { registered = `unavailable: ${err}`; }

  log("notice", "snapshot-bg", {
    registered: Array.isArray(registered) ? registered.map((r) => ({ id: r.id, world: r.world })) : registered,
    states,
    tabs: tabs.map((t) => ({
      id: t.id, win: t.windowId, active: t.active, audible: t.audible,
      discarded: t.discarded, host: hostOf(t.url),
    })),
  });

  // Ask every web tab's content scripts to report. A rejection means nothing
  // is listening there: extension not allowed on that site, or a restricted page.
  for (const t of tabs) {
    if (!/^https?:/.test(t.url || "")) continue;
    browser.tabs.sendMessage(t.id, { type: "dump" }).catch((err) =>
      log("warn", "dump-undelivered", { tab: t.id, host: hostOf(t.url), error: String(err) })
    );
  }
}

// ---- messages ---------------------------------------------------------------
browser.runtime.onMessage.addListener(async (msg, sender) => {
  switch (msg.type) {
    // Log entries from the bridge, page world or popup.
    case "log":
      for (const entry of msg.entries || []) {
        if (sender.tab) { entry.tab = sender.tab.id; entry.frame = sender.frameId; }
        enqueue(entry);
      }
      return;

    // A content script asking for its tab's setting.
    case "get": {
      const result = await effective((await getState(sender.tab.id)) || DEFAULT);
      log("info", "get", { tab: sender.tab.id, frame: sender.frameId, result });
      return result;
    }

    // The popup changing a tab. Reaches every frame in that tab.
    case "set": {
      const state = { volume: msg.volume, muted: msg.muted };
      await setState(msg.tabId, state);
      try {
        await browser.tabs.sendMessage(msg.tabId, { type: "apply", ...(await effective(state)) });
        log("info", "set", { tab: msg.tabId, ...state, delivered: true });
      } catch (err) {
        // Nothing received it: no content script in that tab (site not allowed, or restricted page).
        log("warn", "set", { tab: msg.tabId, ...state, delivered: false, error: String(err) });
      }
      return true;
    }

    // The popup asking for every tab that has a non-default setting.
    case "getAll": {
      const all = await store.get(null);
      const out = {};
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith("tab:")) out[k.slice(4)] = v;
      }
      return out;
    }

    case "setEnabled":
      await setEnabled(!!msg.enabled);
      return true;

    // The popup's Dump button.
    case "dump":
      log("notice", "dump-requested", {});
      await dumpEverything();
      return true;
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  log("info", "tab-removed", { tab: tabId });
  store.remove(key(tabId));
});

// Earliest possible injection into the page world, if this Safari supports it.
// Failure is fine: bridge.js falls back to a <script> tag.
(async () => {
  try {
    const id = "tab-mixer-inject";
    const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length) {
      log("info", "main-world-registration", { status: "already-registered" });
      return;
    }
    await browser.scripting.registerContentScripts([{
      id,
      matches: ["<all_urls>"],
      js: ["inject.js"],
      runAt: "document_start",
      allFrames: true,
      world: "MAIN",
    }]);
    log("info", "main-world-registration", { status: "registered" });
  } catch (err) {
    log("warn", "main-world-registration", { status: "unavailable, using script-tag fallback", error: String(err) });
  }
})();

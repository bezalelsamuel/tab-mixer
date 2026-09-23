const list = document.getElementById("list");
const showAll = document.getElementById("showAll");
const enabled = document.getElementById("enabled");
const mixer = document.getElementById("mixer");

const DEFAULT = { volume: 100, muted: false };
let states = {};
const rows = new Map(); // tabId -> row element, reused across renders so a drag in progress survives

// See background.js.
const VERBOSE = false;

function log(level, event, data) {
  if (level === "info" && !VERBOSE) return;
  browser.runtime.sendMessage({
    type: "log",
    entries: [{ src: "popup", level, event, data, t: Date.now() }],
  }).catch(() => {});
}
window.addEventListener("error", (e) => log("error", "uncaught", { message: e.message, line: e.lineno }));
window.addEventListener("unhandledrejection", (e) => log("error", "unhandled-rejection", { message: String(e.reason) }));

function send(tabId, state) {
  states[tabId] = state;
  browser.runtime.sendMessage({ type: "set", tabId, ...state });
}

function row(tab) {
  const state = { ...DEFAULT, ...states[tab.id] };

  const el = document.createElement("div");
  el.className = "row" + (state.muted ? " muted" : "");

  const title = document.createElement("div");
  title.className = "title";
  // Called again on each render: title and playing state change while the popup is open.
  el.update = (tab) => {
    const text = tab.title || tab.url || `Tab ${tab.id}`;
    title.title = text;
    title.replaceChildren();
    if (tab.audible) {
      const dot = document.createElement("span");
      dot.className = "dot";
      title.append(dot);
    }
    title.append(text);
  };
  el.update(tab);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = 0;
  slider.max = 100;
  slider.value = state.volume;

  const pct = document.createElement("span");
  pct.className = "pct";
  pct.textContent = `${state.volume}%`;

  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.title = "Set volume back to 100%";
  reset.disabled = state.volume === DEFAULT.volume;

  const mute = document.createElement("button");
  mute.className = "mute";
  mute.textContent = state.muted ? "Unmute" : "Mute";

  // "input" fires for every pixel of a drag; send at most once per frame.
  let frame = 0;
  slider.addEventListener("input", () => {
    state.volume = Number(slider.value);
    pct.textContent = `${state.volume}%`;
    reset.disabled = state.volume === DEFAULT.volume;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; send(tab.id, { ...state }); });
  });
  // "change" fires once where the drag ends: make sure that exact value lands.
  slider.addEventListener("change", () => {
    cancelAnimationFrame(frame);
    frame = 0;
    send(tab.id, { ...state });
    log("info", "slider", { tab: tab.id, volume: state.volume });
  });

  reset.addEventListener("click", () => {
    state.volume = DEFAULT.volume;
    slider.value = state.volume;
    pct.textContent = `${state.volume}%`;
    reset.disabled = true;
    send(tab.id, { ...state });
    log("info", "reset", { tab: tab.id });
  });

  mute.addEventListener("click", () => {
    state.muted = !state.muted;
    mute.textContent = state.muted ? "Unmute" : "Mute";
    el.classList.toggle("muted", state.muted);
    send(tab.id, { ...state });
    log("info", "mute", { tab: tab.id, muted: state.muted });
  });

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.append(slider, pct, reset, mute);
  el.append(title, controls);
  return el;
}

async function render() {
  const [tabs, saved] = await Promise.all([
    browser.tabs.query({}),
    browser.runtime.sendMessage({ type: "getAll" }),
  ]);
  states = saved || {};

  const shown = tabs.filter(
    (t) => showAll.checked || t.audible || states[t.id]
  );

  log("info", "render", { tabs: tabs.length, shown: shown.length, showAll: showAll.checked, audible: tabs.filter((t) => t.audible).length });

  const ids = new Set(shown.map((t) => t.id));
  for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);

  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tabs are playing audio. Start something, or tick “All tabs”.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...shown.map((tab) => {
    let el = rows.get(tab.id);
    if (el) el.update(tab);
    else rows.set(tab.id, (el = row(tab)));
    return el;
  }));
}

// Coalesce bursts of tab events (a page load fires several) into one render.
let pending = null;
function scheduleRender() {
  clearTimeout(pending);
  pending = setTimeout(() => render().catch((err) => log("error", "render-failed", { message: String(err) })), 150);
}

// Keep the list current while the popup is open: tabs start/stop playing,
// get retitled, opened or closed.
browser.tabs.onUpdated.addListener((id, change) => {
  if ("audible" in change || "title" in change) scheduleRender();
});
browser.tabs.onCreated.addListener(scheduleRender);
browser.tabs.onRemoved.addListener(scheduleRender);

// The "All tabs" choice is remembered between popup openings.
const PREF = "pref:showAll";
showAll.addEventListener("change", () => {
  browser.storage.local.set({ [PREF]: showAll.checked }).catch(() => {});
  render();
});

const dump = document.getElementById("dump");
dump.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "dump" });
  dump.textContent = "Logged ✓";
  setTimeout(() => (dump.textContent = "Dump"), 1500);
});

// The on/off switch. The background owns the setting and re-applies every tab.
enabled.addEventListener("change", () => {
  mixer.disabled = !enabled.checked;
  browser.runtime.sendMessage({ type: "setEnabled", enabled: enabled.checked });
  log("info", "enabled", { enabled: enabled.checked });
});

browser.storage.local.get([PREF, "pref:enabled"])
  .then((r) => {
    showAll.checked = !!r[PREF];
    enabled.checked = r["pref:enabled"] !== false;
    mixer.disabled = !enabled.checked;
  })
  .catch(() => {})
  .then(render)
  .catch((err) => log("error", "render-failed", { message: String(err) }));

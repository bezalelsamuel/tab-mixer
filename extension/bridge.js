// Isolated-world relay: background <-> inject.js (page world). Also forwards
// inject.js's log entries to the background, which writes them to the native log.
(() => {
  // See background.js.
  const VERBOSE = false;
  let state = { volume: 100, muted: false };
  const isTop = (() => { try { return window === window.top; } catch { return false; } })();

  // ---- logging -------------------------------------------------------------
  const MAX_ENTRIES = 2000; // per page load; a misbehaving page can't flood the log
  let sent = 0;

  function send(entry) {
    if (entry.level === "info" && !VERBOSE) return;
    if (sent > MAX_ENTRIES) return;
    if (sent === MAX_ENTRIES) entry = { src: "bridge", level: "warn", event: "log-cap-reached", data: { max: MAX_ENTRIES }, t: Date.now() };
    sent++;
    browser.runtime.sendMessage({ type: "log", entries: [entry] }).catch(() => {});
  }
  const log = (level, event, data) =>
    send({ src: "bridge", level, event, data, top: isTop, origin: location.origin, t: Date.now() });

  log("info", "start", { readyState: document.readyState, path: location.pathname });

  // ---- injecting inject.js into the page's JS world ------------------------
  // Fallback for when the background's MAIN-world registration isn't available.
  // inject.js guards against running twice.
  // Strict-CSP sites (YouTube) block this tag even when the registered copy is
  // already running, so a failure only counts as an error if inject.js never
  // announced itself.
  let injectSeen = false;
  const fallbackFailed = (event, data) => setTimeout(() => {
    if (injectSeen) log("info", event, { ...data, harmless: "inject.js already running via MAIN-world registration" });
    else log("error", event, data);
  }, 1000);
  const s = document.createElement("script");
  s.src = browser.runtime.getURL("inject.js");
  s.async = false;
  s.onload = () => { log("info", "inject-tag-loaded", {}); s.remove(); };
  s.onerror = () => fallbackFailed("inject-tag-failed", { src: s.src });
  (document.head || document.documentElement).prepend(s);

  // A page CSP that blocks our script tag shows up here.
  document.addEventListener("securitypolicyviolation", (e) => {
    if (String(e.blockedURI).includes("safari-web-extension") || String(e.blockedURI) === "inline") {
      fallbackFailed("csp-violation", { blocked: e.blockedURI, directive: e.violatedDirective });
    }
  }, true);

  // ---- state relay ---------------------------------------------------------
  // Slider position (0-100) -> amplitude. Squared taper so the slider feels even.
  const gainOf = (volume) => (volume / 100) ** 2;

  function push() {
    window.postMessage(
      { __tabMixer: "state", gain: gainOf(state.volume), muted: state.muted },
      "*"
    );
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    switch (e.data.__tabMixer) {
      case "ready":
        injectSeen = true;
        window.postMessage({ __tabMixer: "bridge-up" }, "*");
        push();
        break;
      case "log":
        if (e.data.entry && typeof e.data.entry === "object") send(e.data.entry);
        break;
    }
  });
  // In case inject.js is already listening.
  window.postMessage({ __tabMixer: "bridge-up" }, "*");

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "apply") {
      state = { volume: msg.volume, muted: msg.muted };
      log("info", "apply", state);
      push();
    } else if (msg.type === "dump") {
      log("notice", "snapshot-bridge", { state, gain: gainOf(state.volume), readyState: document.readyState });
      window.postMessage({ __tabMixer: "dump" }, "*");
    }
  });

  // New frames and navigations pick up the tab's existing setting.
  browser.runtime.sendMessage({ type: "get" }).then((st) => {
    log("info", "get-state", st);
    if (st) {
      state = st;
      push();
    }
  }).catch((err) => log("error", "get-state-failed", { error: String(err) }));
})();

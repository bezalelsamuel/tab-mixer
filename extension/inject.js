// Runs in the page's own JS world so it can wrap the audio APIs the page uses.
// It scales everything by a single per-tab gain. Everything notable is reported
// to the log via the bridge (window.postMessage -> bridge.js -> background -> native).
(() => {
  const via = document.currentScript && document.currentScript.src ? "script-tag" : "main-world-registered";

  // Both injection routes may run; the second one just reports itself and stops.
  if (window.__tabMixerInstalled) {
    window.postMessage({ __tabMixer: "second-injection", via }, "*");
    return;
  }
  window.__tabMixerInstalled = true;

  // ---- logging -------------------------------------------------------------
  const isTop = (() => { try { return window === window.top; } catch { return false; } })();
  // The bridge may not be listening yet, so hold entries until it says it is.
  const pending = [];
  let bridgeUp = false;

  function post(entry) {
    try { window.postMessage({ __tabMixer: "log", entry }, "*"); } catch {}
  }
  // See background.js.
  const VERBOSE = false;
  function emit(level, event, data) {
    if (level === "info" && !VERBOSE) return;
    const entry = { src: "inject", level, event, data, top: isTop, origin: location.origin, t: Date.now() };
    if (bridgeUp) post(entry);
    else if (pending.length < 200) pending.push(entry);
  }
  const log = (event, data) => emit("info", event, data);
  const logErr = (event, err, extra) =>
    emit("error", event, {
      message: String((err && err.message) || err),
      stack: String((err && err.stack) || "").split("\n").slice(0, 4).join(" | "),
      ...extra,
    });

  let gain = 1;
  let muted = false;
  const effective = () => (muted ? 0 : gain);

  // ---- <audio>/<video> elements -------------------------------------------
  // The page keeps seeing its own volume; the real volume is pageVolume * gain.
  const pageVolume = new WeakMap();
  const webAudioElements = new WeakSet(); // routed through Web Audio: master gain handles them
  const volumeSets = new WeakMap(); // how many times the page has set .volume
  const tracked = new Set(); // WeakRefs

  const volumeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
  const origGet = volumeDesc.get;
  const origSet = volumeDesc.set;

  function describe(el) {
    let kind = "none";
    try {
      if (el.srcObject) {
        const s = el.srcObject;
        kind = s instanceof MediaStream
          ? `MediaStream(audio=${s.getAudioTracks().length},video=${s.getVideoTracks().length})`
          : s.constructor.name;
      } else if (el.currentSrc) {
        const u = new URL(el.currentSrc, location.href);
        kind = u.protocol === "blob:" ? "blob:" : `${u.protocol}//${u.host}`;
      }
    } catch {}
    return {
      tag: el.tagName,
      kind,
      paused: el.paused,
      ended: el.ended,
      readyState: el.readyState,
      elMuted: el.muted,
      page: pageVolume.get(el),
      real: origGet.call(el),
      webAudio: webAudioElements.has(el),
      inDom: el.isConnected,
      pageSets: volumeSets.get(el) || 0,
    };
  }

  function applyToElement(el) {
    const page = pageVolume.get(el) ?? 1;
    origSet.call(el, webAudioElements.has(el) ? page : Math.min(1, page * effective()));
  }

  function track(el, why) {
    if (pageVolume.has(el)) return;
    pageVolume.set(el, origGet.call(el));
    tracked.add(new WeakRef(el));
    applyToElement(el);
    log("track", { why, gain: effective(), ...describe(el) });
  }

  Object.defineProperty(HTMLMediaElement.prototype, "volume", {
    configurable: true,
    enumerable: volumeDesc.enumerable,
    get() {
      return pageVolume.has(this) ? pageVolume.get(this) : origGet.call(this);
    },
    set(v) {
      const n = Number(v);
      if (!(n >= 0 && n <= 1)) return origSet.call(this, v); // invalid: let the browser throw, as it would anyway
      try {
        track(this, "volume-set");
        pageVolume.set(this, n);
        applyToElement(this);
        const count = (volumeSets.get(this) || 0) + 1;
        volumeSets.set(this, count);
        if (count <= 3) log("page-set-volume", { value: n, applied: origGet.call(this), count });
      } catch (err) {
        logErr("volume-hook-error", err);
        return origSet.call(this, v);
      }
    },
  });

  // Elements can start playing without ever touching .volume or the DOM
  // (new Audio(), srcObject from WebRTC), so catch them on play().
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try { track(this, "play()"); } catch (err) { logErr("play-hook-error", err); }
    return origPlay.apply(this, args);
  };
  document.addEventListener("play", (e) => {
    try { if (e.target instanceof HTMLMediaElement) track(e.target, "play-event"); }
    catch (err) { logErr("play-event-error", err); }
  }, true);

  // ---- Web Audio -----------------------------------------------------------
  // Redirect anything connected to ctx.destination through one master GainNode.
  const AC = window.AudioContext || window.webkitAudioContext;
  const masters = new WeakMap();
  const redirects = new WeakMap(); // ctx -> number of connect() calls redirected
  const contexts = new Set(); // WeakRefs

  const origConnect = AudioNode.prototype.connect;
  const origDisconnect = AudioNode.prototype.disconnect;
  const isRealtimeDest = (d) =>
    d instanceof AudioDestinationNode &&
    !(typeof OfflineAudioContext !== "undefined" && d.context instanceof OfflineAudioContext);

  function masterFor(ctx) {
    let m = masters.get(ctx);
    if (!m) {
      m = ctx.createGain();
      m.gain.value = effective();
      origConnect.call(m, ctx.destination);
      masters.set(ctx, m);
      redirects.set(ctx, 0);
      contexts.add(new WeakRef(ctx));
      log("ctx-master", { state: ctx.state, sampleRate: ctx.sampleRate, gain: effective() });
    }
    return m;
  }

  AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      if (isRealtimeDest(dest) && masters.get(dest.context) !== this) {
        const m = masterFor(dest.context);
        const n = redirects.get(dest.context) + 1;
        redirects.set(dest.context, n);
        if (n <= 3) log("connect-redirect", { from: this.constructor.name, n });
        origConnect.call(this, m, ...rest);
        return dest;
      }
    } catch (err) {
      logErr("connect-hook-error", err);
    }
    return origConnect.call(this, dest, ...rest);
  };

  AudioNode.prototype.disconnect = function (dest, ...rest) {
    try {
      if (isRealtimeDest(dest) && masters.get(dest.context) !== this) {
        return origDisconnect.call(this, masterFor(dest.context), ...rest);
      }
    } catch (err) {
      logErr("disconnect-hook-error", err);
    }
    return origDisconnect.call(this, dest, ...rest);
  };

  // Media elements captured into a graph would otherwise be scaled twice.
  if (AC) {
    const origCreateSrc = AC.prototype.createMediaElementSource;
    AC.prototype.createMediaElementSource = function (el) {
      try {
        webAudioElements.add(el);
        if (pageVolume.has(el)) applyToElement(el);
        log("media-element-source", { tag: el.tagName, state: this.state });
      } catch (err) {
        logErr("media-element-source-error", err);
      }
      return origCreateSrc.call(this, el);
    };
  }

  // ---- state from the extension -------------------------------------------
  function applyAll() {
    const g = effective();
    let els = 0;
    let ctxs = 0;
    for (const ref of tracked) {
      const el = ref.deref();
      if (el) { applyToElement(el); els++; }
      else tracked.delete(ref);
    }
    for (const ref of contexts) {
      const ctx = ref.deref();
      const m = ctx && masters.get(ctx);
      if (m) { m.gain.setTargetAtTime(g, ctx.currentTime, 0.015); ctxs++; }
      else contexts.delete(ref);
    }
    // Elements the page created before we saw them.
    for (const el of document.querySelectorAll("audio, video")) track(el, "dom-scan");
    log("apply-all", { gain: g, elements: els, contexts: ctxs });
  }

  function snapshot() {
    const elements = [];
    for (const ref of tracked) {
      const el = ref.deref();
      if (el) elements.push(describe(el));
    }
    const ctxs = [];
    for (const ref of contexts) {
      const ctx = ref.deref();
      const m = ctx && masters.get(ctx);
      if (ctx) ctxs.push({ state: ctx.state, sampleRate: ctx.sampleRate, masterGain: m && m.gain.value, redirects: redirects.get(ctx) });
    }
    emit("notice", "snapshot", {
      via,
      readyState: document.readyState,
      gain, muted, effective: effective(),
      hooks: {
        volume: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume").get !== origGet,
        play: HTMLMediaElement.prototype.play !== origPlay,
        connect: AudioNode.prototype.connect !== origConnect,
        mediaElementSource: !!AC && AC.prototype.createMediaElementSource.toString().indexOf("native code") === -1,
      },
      hasAudioContext: !!AC,
      domMedia: document.querySelectorAll("audio, video").length,
      elements,
      contexts: ctxs,
    });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    switch (e.data.__tabMixer) {
      case "state":
        gain = Math.max(0, Math.min(1, Number(e.data.gain)));
        muted = !!e.data.muted;
        log("state", { gain, muted });
        applyAll();
        break;
      case "bridge-up":
        if (!bridgeUp) {
          bridgeUp = true;
          for (const entry of pending.splice(0)) post(entry);
          // If we ran before the bridge was listening it missed our "ready"; repeat it once.
          window.postMessage({ __tabMixer: "ready" }, "*");
        }
        break;
      case "dump":
        snapshot();
        break;
      case "second-injection":
        log("second-injection", { firstVia: via, secondVia: e.data.via });
        break;
    }
  });

  window.addEventListener("error", (e) => {
    // Only care about errors coming from this file.
    if (e.filename && e.filename.includes("inject.js")) logErr("uncaught", e.error || e.message);
  });

  log("installed", { via, readyState: document.readyState, hasAudioContext: !!AC });

  // Tell the bridge we're here; it answers with bridge-up and the current state.
  window.postMessage({ __tabMixer: "ready" }, "*");
})();

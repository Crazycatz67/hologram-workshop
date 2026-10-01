// sessionrec.js — the "shadow site" session recorder for the NORMAL app pages.
//
// Why: the owner tests the app by just using it (hologram.html, hands.html, platform/), not
// only through test pages, and wanted every such session written down automatically: what
// happened, how smooth it was, and anything that went wrong, without having to describe it.
//
// SCOPE (owner-approved 2026-10-01; docs/testing/README.md "Shadow site vs public site"):
//   - The page loads this file ONLY when location.hostname is 'localhost' or '127.0.0.1', via
//     an inline guard that dynamic-imports it. The public site (GitHub Pages) never downloads
//     it. startSession() re-checks the hostname anyway and returns null elsewhere.
//   - Numbers and events only. It never reads pixels, canvases, video frames or images; it
//     reads app state the pages already expose (window.hologram, the mode/readout text,
//     <video>.srcObject track state) and never stores user file / project names (only short
//     project ids and the repo's own model names).
//   - It edits no app module: it taps globals, console, window events and its own rAF.
//
// ---------------------------------------------------------------------------------------
// CONTRACT
//   startSession({ name }) -> session | null
//     name   'hologram' | 'hands' | 'platform' (any [A-Za-z0-9._-]); the run folder is
//            docs/testing/runs/session-<name>/. Returns null off-localhost, with ?rec=off in
//            the URL, inside an iframe, or if a session is already running in this document.
//   session.snapshot()  the record as it would be saved now (for the badge / debugging).
//   session.end()       ends and sends now (normally automatic on pagehide). Idempotent.
//   window.__sessionrec = { current, lastSent }
//
//   Ends on pagehide: the record is sent with navigator.sendBeacon to POST /__testrun
//   (serve.py; same schema 1 record as testrec.js, status 'done'). sendBeacon has a ~64 KB
//   budget, so timelines are trimmed (counts are never trimmed) to fit MAX_BEACON.
//   If the beacon is refused, the record waits in localStorage and is posted on the next
//   load of any shadow page. A tab that died without a pagehide (crash, killed process)
//   leaves its 5 s checkpoint behind; the next load posts it with status 'crashed'
//   (serve.py flags that as ended-early). A checkpoint is "dead" when no live tab holds its
//   Web Lock (or, without the Locks API, when it is older than STALE_MS).
//   After a bfcache restore (pageshow.persisted) a fresh session starts.
//
//   Flags (source 'page'; serve.py adds console-error and ended-early itself):
//     low-fps      visible-tab fps < 20 for more than 2 s (each episode counted)
//     mode-flicker more than 4 gesture/mode changes within 1 s
//     hidden-tab   the tab was hidden and came back (or stayed hidden > 1 s before closing);
//                  closing a tab always hides it for a moment, which is not flagged.
//
//   Pure helpers (no DOM, testable in Node): createFpsTracker, createModeTracker.
// ---------------------------------------------------------------------------------------

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const FPS_FLOOR = 20, LOW_FPS_MS = 2000, FPS_BUCKET_MS = 500;
const FLICKER_CHANGES = 4, FLICKER_WINDOW_MS = 1000;
const CHECKPOINT_MS = 5000, STALE_MS = 10 * 60 * 1000;
const MAX_BEACON = 60000;           // under Chrome's 64 KB keepalive budget
const MAX_EVENTS = 300, MAX_TIMELINE = 600, MAX_LOG = 50, MAX_MSG = 400, MAX_KEYS = 60;
const BENIGN_ERRORS = [/^INFO: Created TensorFlow Lite XNNPACK delegate/];
const OPEN_PREFIX = 'sessionrec:open:', PENDING_KEY = 'sessionrec:pending';

const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';

// ---- pure helpers ---------------------------------------------------------------------

// Frame rate from frame timestamps, in fixed buckets. Hidden time is excluded: browsers stop
// rAF in hidden tabs, and a "0 fps" bucket there says nothing about the app.
export function createFpsTracker({ floor = FPS_FLOOR, lowMs = LOW_FPS_MS, bucketMs = FPS_BUCKET_MS } = {}) {
  const hist = new Uint32Array(241);   // whole fps 0..240, so median/p5 stay exact for any length
  let buckets = 0, bucketStart = null, frames = 0, last = null;
  let lowStart = null, lowMin = Infinity, lowCounted = false;
  const episodes = [];
  let episodeCount = 0, longestLowMs = 0;
  function closeLow(t) {
    if (lowStart !== null && lowCounted) longestLowMs = Math.max(longestLowMs, t - lowStart);
    lowStart = null; lowMin = Infinity; lowCounted = false;
  }
  return {
    frame(t) {
      if (bucketStart === null) { bucketStart = t; frames = 0; last = t; return; }
      // No gap filter here on purpose: a visible page that produced no frame for seconds was
      // frozen, the worst kind of low fps. Hidden time is cut out by pause() instead.
      frames++; last = t;
      const span = t - bucketStart;
      if (span < bucketMs) return;
      const fps = (frames * 1000) / span;
      hist[Math.min(240, Math.round(fps))]++; buckets++;
      if (fps < floor) {
        if (lowStart === null) lowStart = bucketStart;
        lowMin = Math.min(lowMin, fps);
        if (!lowCounted && t - lowStart > lowMs) {
          lowCounted = true; episodeCount++;
          if (episodes.length < 20) episodes.push({ t: Math.round(lowStart), minFps: +lowMin.toFixed(1) });
        }
        if (lowCounted) { const e = episodes[episodes.length - 1]; if (e && e.t === Math.round(lowStart)) { e.ms = Math.round(t - lowStart); e.minFps = +lowMin.toFixed(1); } }
      } else closeLow(t);
      bucketStart = t; frames = 0;
    },
    pause(t) { bucketStart = null; closeLow(t ?? last ?? 0); },
    stats() {
      const q = (p) => {
        if (!buckets) return null;
        let need = Math.max(1, Math.ceil(p * buckets)), acc = 0;
        for (let i = 0; i < hist.length; i++) { acc += hist[i]; if (acc >= need) return i; }
        return 240;
      };
      let min = null;
      for (let i = 0; i < hist.length; i++) if (hist[i]) { min = i; break; }
      const longest = Math.max(longestLowMs, ...episodes.map((e) => e.ms ?? 0));
      return { samples: buckets, median: q(0.5), p5: q(0.05), min, lowEpisodes: episodeCount, longestLowMs: Math.round(longest), episodes };
    }
  };
}

// A string-valued state over time (gesture mode, hand labels, scene/object mode): timeline of
// changes, entries and time per value, and flicker episodes (> maxChanges within windowMs).
export function createModeTracker({ maxChanges = FLICKER_CHANGES, windowMs = FLICKER_WINDOW_MS, maxTimeline = MAX_TIMELINE } = {}) {
  let cur = null, since = 0, changes = 0, dropped = 0;
  const counts = {}, timeline = [], recent = [], flicker = [];
  let flickerCount = 0, inFlicker = false;
  return {
    set(value, t) {
      const v = String(value);
      if (v === cur) return false;
      if (cur !== null) {
        counts[cur].ms += t - since;
        changes++;
        recent.push(t);
        while (recent.length && recent[0] <= t - windowMs) recent.shift();
        if (recent.length > maxChanges) {
          if (!inFlicker) {
            inFlicker = true; flickerCount++;
            if (flicker.length < 20) flicker.push({ t: Math.round(recent[0]), changes: recent.length });
          } else { const e = flicker[flicker.length - 1]; if (e) e.changes = Math.max(e.changes, recent.length); }
        } else inFlicker = false;
      }
      counts[v] ??= { entries: 0, ms: 0 };
      counts[v].entries++;
      cur = v; since = t;
      if (timeline.length < maxTimeline) timeline.push({ t: Math.round(t), v }); else dropped++;
      return true;
    },
    get value() { return cur; },
    stats(t) {
      const out = {};
      for (const [k, c] of Object.entries(counts)) out[k] = { entries: c.entries, ms: Math.round(c.ms + (k === cur ? t - since : 0)) };
      return { changes, counts: out, flickerEpisodes: flickerCount, flicker, timeline, timelineDropped: dropped };
    }
  };
}

// ---- page probes ----------------------------------------------------------------------
// Each reads state a page already exposes; all are wrapped so a renamed global just records
// nothing. `fast` runs every frame (cheap getters only), `slow` 4x a second.

function hologramProbe(ctx) {
  let manip = null, resets = 0, canUndo = false, model = null;
  return {
    fast(t) {
      const h = window.hologram;
      const m = h?.manipulator;
      if (m) ctx.mode.set(m.mode, t);
      if (m && m !== manip) { manip = m; resets = m.resetCount; canUndo = m.canUndo; }
      else if (m) {
        if (m.resetCount > resets) { ctx.count('resets', m.resetCount - resets); ctx.event(t, 'reset'); resets = m.resetCount; }
        // canUndo true -> false without a new reset = the reset was undone.
        else if (canUndo && !m.canUndo) { ctx.count('undos'); ctx.event(t, 'undo'); }
        canUndo = m.canUndo;
      }
      if (h && h.model && h.model !== model) {
        model = h.model;
        ctx.count('modelLoads');
        // The registry id of the carousel's active model (repo models, never user files).
        const id = document.querySelector('#modelCarousel .active')?.dataset.id || model.name || '';
        ctx.event(t, 'model-load', { model: String(id).slice(0, 60) });
      }
    },
    slow() {}
  };
}

function handsProbe(ctx) {
  const el = document.getElementById('readout');
  return {
    fast(t) {
      if (!el) return;
      const txt = el.textContent || '';
      let label;
      if (!txt) label = 'off';
      else if (txt.startsWith('no hands')) label = 'no-hands';
      else {
        // hands.js readout: "<Left|Right> <Gesture> (score) ..." then "gap ... PINCH|open|blocked".
        const parts = [];
        const re = /^(Left|Right)\s+(\S+) \([^)]*\)[^\n]*\n\s+gap \S+\s+(\S+)/gm;
        for (let m; (m = re.exec(txt));) parts.push(`${m[1]}:${m[2]}${m[3] === 'PINCH' ? '+pinch' : ''}`);
        label = parts.sort().join(' ') || 'hands';
      }
      ctx.mode.set(label, t);
    },
    slow() {}
  };
}

function platformProbe(ctx) {
  let edits = null, items = null, stats = null, project, ringOpen = null, unit = null;
  return {
    fast(t) {
      const om = window.hologram?.objectMode;
      if (om) ctx.mode.set(om.mode, t);
    },
    slow(t) {
      const h = window.hologram;
      if (!h) return;
      const n = Array.isArray(h.edits) ? h.edits.length : null;
      const st = h.library?.state?.();
      const pid = st ? (st.projectId ?? null) : undefined;
      if (pid !== undefined && pid !== project) {
        // Opening or closing a project swaps the whole edit log: don't read that as undos.
        if (project !== undefined) ctx.event(t, pid ? 'project-open' : 'project-close', pid ? { id: String(pid).slice(0, 8), sample: !!st.sample } : {});
        if (pid) ctx.count('projectOpens');
        project = pid; edits = n;
      } else if (n !== null && edits !== null && n !== edits) {
        if (n > edits) ctx.count('edits', n - edits); else { ctx.count('undos', edits - n); ctx.event(t, 'undo', { steps: edits - n }); }
        edits = n;
      } else edits = n;
      const ni = Array.isArray(h.items) ? h.items.length : (h.items?.size ?? null);
      if (ni !== null && items !== null && ni !== items) ctx.event(t, 'items', { count: ni });
      items = ni;
      if (h.stats && h.stats !== stats) {
        stats = h.stats;
        ctx.count('modelLoads');
        const s = stats, num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
        ctx.event(t, 'model-load', { tris: num(s.tris), points: num(s.points), parts: num(s.parts), components: num(s.components), splitMs: num(s.splitMs), parseMs: num(s.parseMs) });
      }
      const ring = h.library?.ring;
      const open = typeof ring?.isOpen === 'function' ? !!ring.isOpen() : null;
      if (open !== null && open !== ringOpen) { if (ringOpen !== null) ctx.event(t, open ? 'ring-open' : 'ring-close'); ringOpen = open; }
      const u = h.measurements?.unit;
      if (u && u !== unit) { if (unit !== null) ctx.event(t, 'unit', { unit: String(u) }); unit = u; }
    }
  };
}

const PROBES = { hologram: hologramProbe, hands: handsProbe, platform: platformProbe };

// ---- storage helpers --------------------------------------------------------------------

function lsGet(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function lsSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } }
function lsDel(key) { try { localStorage.removeItem(key); } catch { /* storage blocked */ } }

async function post(record) {
  try {
    const r = await fetch('/__testrun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
    return r.ok;
  } catch { return false; }
}

// Sessions a previous load could not deliver: refused beacons, and checkpoints of tabs that
// died without a pagehide (no live tab holds their lock) -> sent as 'crashed'.
async function flushLeftovers(ownKey) {
  for (const rec of lsGet(PENDING_KEY, [])) if (!(await post(rec))) return; // server down: try next time
  lsDel(PENDING_KEY);
  let held = null;
  try { held = new Set((await navigator.locks.query()).held.map((l) => l.name)); } catch { /* no Locks API */ }
  const keys = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(OPEN_PREFIX) && k !== ownKey) keys.push(k); } } catch { return; }
  for (const k of keys) {
    const rec = lsGet(k, null);
    if (!rec) { lsDel(k); continue; }
    const alive = held ? held.has(k) : Date.now() - (rec.__beat ?? 0) < STALE_MS;
    if (alive) continue;
    delete rec.__beat;
    rec.status = 'crashed';
    if (await post(rec)) lsDel(k);
  }
}

// ---- badge ------------------------------------------------------------------------------
// Static (no animation, no blinking dot: photosafety, BUGS #14) and small; it only says this
// copy records, and on click lists the flags of the last saved session of this page.
function mountBadge(session, page) {
  const b = document.createElement('div');
  b.id = 'sessionrec-badge';
  b.textContent = 'SHADOW · recording';
  b.title = 'local test copy, sessions saved to docs/testing/runs/';
  // Bottom centre: on all three pages that is the quiet middle of the status bar / empty stage.
  b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:5px;z-index:99998;font:10px/1.4 ui-monospace,monospace;letter-spacing:.06em;' +
    'color:#9fc9d8;background:rgba(8,18,26,.78);border:1px solid #2a4a5a;border-radius:4px;padding:2px 8px;cursor:pointer;user-select:none';
  const panel = document.createElement('pre');
  panel.id = 'sessionrec-panel';
  panel.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:30px;z-index:99998;max-width:min(520px,90vw);max-height:50vh;overflow:auto;margin:0;' +
    'font:11px/1.45 ui-monospace,monospace;white-space:pre-wrap;color:#cfe6ee;background:rgba(8,18,26,.94);border:1px solid #2a4a5a;' +
    'border-radius:4px;padding:8px 10px;display:none';
  // Keep the badge's clicks away from the app's own pointer/key handlers (ring dismiss etc.).
  for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'wheel']) { b.addEventListener(ev, (e) => e.stopPropagation()); panel.addEventListener(ev, (e) => e.stopPropagation()); }
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.textContent = 'loading…';
    const now = session.snapshot();
    const fmtFlags = (fl) => (fl?.length ? fl.map((f) => `  · ${f.kind}: ${f.message}`).join('\n') : '  none');
    let last = 'Last saved session: none yet.';
    try {
      const url = new URL(`docs/testing/runs/${page}/latest.json`, import.meta.url);
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) {
        const rec = await r.json();
        last = `Last saved session (${rec.receivedAt || rec.endedAt || '?'}, ${Math.round((rec.durationMs || 0) / 1000)} s, ${rec.status}):\n${fmtFlags(rec.flags)}`;
      }
    } catch { /* show "none yet" */ }
    panel.textContent = `${last}\n\nThis session so far (${Math.round(now.durationMs / 1000)} s, ${now.attachments.session.events.length} events, ` +
      `${now.consoleErrors.length} console errors):\n${fmtFlags(now.flags)}\n\nSaved when the tab closes, to docs/testing/runs/${page}/.`;
  });
  document.body.append(b, panel);
  return () => { b.remove(); panel.remove(); };
}

// ---- the session ------------------------------------------------------------------------

function textOf(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || String(a);
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, MAX_MSG);
}

export function startSession({ name } = {}) {
  if (!hasWindow || !LOCAL_HOSTS.includes(location.hostname)) return null;
  if (new URLSearchParams(location.search).get('rec') === 'off') return null;
  // Framed copies are test harnesses (ring-test / library-test load platform/index.html in an
  // iframe): not the owner's session, and a badge there could catch the harness's clicks.
  if (window.top !== window) return null;
  if (window.__sessionrec?.current && !window.__sessionrec.current.ended) return null;

  const page = 'session-' + (String(name || 'page').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'page');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const openKey = OPEN_PREFIX + id;
  const t0 = performance.now();
  const rel = () => performance.now() - t0;
  const startedAt = new Date().toISOString();

  const fps = createFpsTracker();
  const mode = createModeTracker();
  const counts = {};
  const events = [];
  let eventsDropped = 0;
  const consoleErrors = [], warnings = [], visibility = [{ t: 0, state: document.visibilityState }];
  const clicks = {}, keys = {};
  const hidden = { periods: 0, ms: 0, since: document.hidden ? 0 : null };
  let cameraOnMs = 0, cameraSince = null;
  let ended = false;

  const ctx = {
    mode,
    count(k, n = 1) { counts[k] = (counts[k] ?? 0) + n; },
    event(t, type, data = {}) {
      if (events.length < MAX_EVENTS) events.push({ t: Math.round(t), type, ...data }); else eventsDropped++;
    }
  };
  const probe = (PROBES[name] ?? (() => ({ fast() {}, slow() {} })))(ctx);

  // ---- console + errors (restored in end()) ----
  const undo = [];
  const push = (list, args) => { if (list.length < MAX_LOG) list.push({ t: Math.round(rel()), msg: textOf(args) }); };
  const origError = console.error, origWarn = console.warn;
  // MediaPipe's wasm prints this info line through console.error on every camera start; left
  // as an error it would flag every camera session and hide the real first error.
  const benign = (a) => typeof a[0] === 'string' && BENIGN_ERRORS.some((re) => re.test(a[0]));
  const ourError = function (...a) { push(benign(a) ? warnings : consoleErrors, a); return origError.apply(this, a); };
  const ourWarn = function (...a) { push(warnings, a); return origWarn.apply(this, a); };
  console.error = ourError; console.warn = ourWarn;
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); undo.push(() => target.removeEventListener(type, fn, opts)); };
  on(window, 'error', (e) => push(consoleErrors, [`uncaught: ${e.message || e.type}${e.filename ? ` (${e.filename.split('?')[0]}:${e.lineno})` : ''}`]));
  on(window, 'unhandledrejection', (e) => push(consoleErrors, ['unhandled rejection:', e.reason]));
  undo.push(() => { if (console.error === ourError) console.error = origError; if (console.warn === ourWarn) console.warn = origWarn; });

  // ---- visibility ----
  on(document, 'visibilitychange', () => {
    const t = rel(), state = document.visibilityState;
    if (visibility.length < MAX_LOG) visibility.push({ t: Math.round(t), state });
    if (state === 'hidden') { hidden.since = t; fps.pause(t); checkpoint(); }
    else if (hidden.since !== null) { hidden.periods++; hidden.ms += t - hidden.since; hidden.since = null; }
  });

  // ---- clicks / shortcut keys: element ids and key names only, never text ----
  on(document, 'click', (e) => {
    const el = e.target?.closest?.('[id]');
    if (!el || el.id.startsWith('sessionrec-')) return;
    const k = `${el.tagName.toLowerCase()}#${el.id}`.slice(0, 60);
    if (k in clicks || Object.keys(clicks).length < MAX_KEYS) clicks[k] = (clicks[k] ?? 0) + 1;
  }, true);
  on(window, 'keydown', (e) => {
    if (e.target?.matches?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return; // typed text is never recorded
    const k = (e.ctrlKey || e.metaKey ? 'mod+' : '') + (e.key === ' ' ? 'Space' : e.key).slice(0, 12);
    if (k in keys || Object.keys(keys).length < MAX_KEYS) keys[k] = (keys[k] ?? 0) + 1;
  }, true);

  // ---- camera: getUserMedia outcome (wrapped) + whether a <video> shows a live track ----
  const md = navigator.mediaDevices;
  if (md?.getUserMedia) {
    const orig = md.getUserMedia;
    const ours = function (...a) {
      const t = rel();
      ctx.event(t, 'camera-request');
      return orig.apply(this, a).then((s) => s, (err) => { ctx.count('cameraErrors'); ctx.event(rel(), 'camera-error', { error: String(err?.name || 'Error').slice(0, 40), ms: Math.round(rel() - t) }); throw err; });
    };
    md.getUserMedia = ours;
    undo.push(() => { if (md.getUserMedia === ours) md.getUserMedia = orig; });
  }
  function pollCamera(t) {
    let live = false;
    for (const v of document.querySelectorAll('video')) {
      const s = v.srcObject;
      if (s && typeof s.getVideoTracks === 'function' && s.getVideoTracks().some((tr) => tr.readyState === 'live')) { live = true; break; }
    }
    if (live && cameraSince === null) { cameraSince = t; ctx.count('cameraStarts'); ctx.event(t, 'camera-start'); }
    else if (!live && cameraSince !== null) { const on = t - cameraSince; cameraOnMs += on; cameraSince = null; ctx.event(t, 'camera-stop', { onS: +(on / 1000).toFixed(1) }); }
  }

  // ---- loops ----
  let raf = 0;
  const frame = () => {
    if (ended) return;
    const t = rel();
    fps.frame(t);
    try { probe.fast(t); } catch { /* a page mid-swap; next frame */ }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  const slowTimer = setInterval(() => {
    const t = rel();
    try { probe.slow(t); } catch { /* ignore */ }
    pollCamera(t);
  }, 250);
  const beatTimer = setInterval(() => checkpoint(), CHECKPOINT_MS);
  undo.push(() => { cancelAnimationFrame(raf); clearInterval(slowTimer); clearInterval(beatTimer); });

  // Hold a Web Lock for this document's lifetime: when the tab dies (closed or crashed) the
  // lock goes with it, which is how a later load tells a crashed session from a live tab.
  try { navigator.locks?.request(openKey, () => new Promise(() => {})); } catch { /* no Locks API: STALE_MS fallback */ }

  function flagsOf(rec, closing) {
    const f = [];
    const s = rec.attachments.session;
    if (s.fps.lowEpisodes) {
      const e = s.fps.episodes[0];
      f.push({ kind: 'low-fps', message: `fps < ${FPS_FLOOR} for > ${LOW_FPS_MS / 1000} s, ${s.fps.lowEpisodes} time(s); longest ${(s.fps.longestLowMs / 1000).toFixed(1)} s; first at ${(e.t / 1000).toFixed(1)} s (min ${e.minFps} fps)` });
    }
    if (s.mode.flickerEpisodes) {
      const e = s.mode.flicker[0];
      f.push({ kind: 'mode-flicker', message: `> ${FLICKER_CHANGES} mode changes within 1 s, ${s.mode.flickerEpisodes} time(s); first at ${(e.t / 1000).toFixed(1)} s (${e.changes} changes)` });
    }
    // Closing a tab hides it for a moment first; only a hide that came back, or one that
    // lasted over a second before the close, means the session ran in a background tab.
    const trailing = hidden.since !== null ? rel() - hidden.since : 0;
    const periods = hidden.periods + (trailing > 1000 || (!closing && hidden.since !== null) ? 1 : 0);
    if (periods) f.push({ kind: 'hidden-tab', message: `tab hidden ${periods} time(s), ${((hidden.ms + (trailing > 1000 ? trailing : 0)) / 1000).toFixed(1)} s in total: rAF/fps paused then` });
    return f.map((x) => ({ ...x, source: 'page' }));
  }

  function build(status, closing = false) {
    const t = rel();
    const camOn = cameraOnMs + (cameraSince !== null ? t - cameraSince : 0);
    const fs = fps.stats();
    const ms = mode.stats(t);
    const visibleMs = t - hidden.ms - (hidden.since !== null ? t - hidden.since : 0);
    const metrics = {
      durationS: +(t / 1000).toFixed(1), visibleS: +(visibleMs / 1000).toFixed(1),
      cameraOnS: +(camOn / 1000).toFixed(1), modeChanges: ms.changes, flickerEpisodes: ms.flickerEpisodes,
      lowFpsEpisodes: fs.lowEpisodes, consoleErrors: consoleErrors.length, ...counts
    };
    if (fs.median !== null) Object.assign(metrics, { fps: fs.median, fpsP5: fs.p5, fpsMin: fs.min });
    const rec = {
      schema: 1, page, title: document.title, url: location.pathname, status,
      startedAt, endedAt: new Date().toISOString(), durationMs: Math.round(t),
      commit: null, dirty: null,                // serve.py fills these in
      browser: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform || '',
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio }, viewport: { w: innerWidth, h: innerHeight },
      fps: fs.median, fpsFloor: null, timingSensitive: false, rawStreams: false,
      settings: { sessionId: id, kind: 'session' }, tolerances: {},
      results: [], metrics, summary: { checks: 0, passed: 0, failed: 0, info: 0 },
      consoleErrors: consoleErrors.slice(), warnings: warnings.slice(), visibility: visibility.slice(),
      attachments: {
        session: {
          fps: fs, mode: ms, events: events.slice(), eventsDropped, counts: { ...counts },
          clicks: { ...clicks }, keys: { ...keys },
          hidden: { periods: hidden.periods, ms: Math.round(hidden.ms) }
        }
      },
      flags: []
    };
    rec.flags = flagsOf(rec, closing);
    // Fit the beacon budget: trim the long lists, never the counts.
    for (let i = 0; i < 6 && JSON.stringify(rec).length > MAX_BEACON; i++) {
      const s = rec.attachments.session;
      s.mode.timelineDropped += Math.ceil(s.mode.timeline.length / 2); s.mode.timeline = s.mode.timeline.slice(0, Math.floor(s.mode.timeline.length / 2));
      s.eventsDropped += Math.ceil(s.events.length / 2); s.events = s.events.slice(0, Math.floor(s.events.length / 2));
      rec.warnings = rec.warnings.slice(0, 10);
      rec.consoleErrors = rec.consoleErrors.slice(0, Math.max(10, rec.consoleErrors.length >> 1)).map((e) => ({ ...e, msg: e.msg.slice(0, 200) }));
    }
    return rec;
  }

  function checkpoint() {
    if (ended) return;
    const rec = build('crashed');   // what a later load sends if this tab never reaches pagehide
    rec.__beat = Date.now();
    lsSet(openKey, rec);
  }

  let cleanupBadge = () => {};
  const session = {
    page,
    get ended() { return ended; },
    snapshot: () => build('running'),
    end() {
      if (ended) return true;
      const rec = build('done', true);
      ended = true;
      undo.forEach((fn) => fn());
      cleanupBadge();
      let sent = false;
      try { sent = navigator.sendBeacon('/__testrun', new Blob([JSON.stringify(rec)], { type: 'application/json' })); } catch { sent = false; }
      if (!sent) lsSet(PENDING_KEY, [rec, ...lsGet(PENDING_KEY, [])].slice(0, 5));
      lsDel(openKey);
      window.__sessionrec.lastSent = { page, sent, flags: rec.flags, metrics: rec.metrics };
      return sent;
    }
  };

  on(window, 'pagehide', () => session.end());
  window.__sessionrec ??= { current: null, lastSent: null };
  window.__sessionrec.current = session;
  // Restored from the back/forward cache: the old session was already sent on pagehide.
  if (!window.__sessionrec.pageshowHooked) {
    window.__sessionrec.pageshowHooked = true;
    addEventListener('pageshow', (e) => { if (e.persisted) startSession({ name }); });
  }

  const mount = () => { cleanupBadge = mountBadge(session, page); };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount, { once: true });
  checkpoint();
  flushLeftovers(openKey);
  return session;
}

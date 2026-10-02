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
//   Guided test (2026-10-01): when guide.html has a run active (localStorage 'testguide:v1'),
//   startSession also mounts the testguide.js dock (even with ?rec=off). The session records
//   'guide' events { id, verdict } and metric guideVerdicts, and raises a 'guide-fail' flag
//   per step left marked Fail (never the note text).
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
//     possible-accidental-explode  3+ explode entries each shorter than 1.5 s within 10 s
//     (hidden-tab says "mostly in background" when the tab was hidden > half the session;
//      metrics.mostlyBackground / backgroundPct carry the same fact for every session.)
//
//   Feature evidence (2026-10-01, after pointer slice 1), in attachments.session.page and
//   flattened into metrics. Read-only taps, all undone in end():
//     hologram  wraps the live manipulator's update() to see each camera frame's hands
//               (hand.engaged, hand.pointer.gun, wrists); finds the reticle group in the
//               scene (pointer.js state is module-private, the reticle is what the owner sees);
//               listens to 'hologram:click' for click outcomes (#status text as fallback), the measure panel's
//               .measure-tape text for tape distances; reads the model's quaternion / scale.
//               pointer: activeS / entries (reticle shown with the hand beam), mouseS,
//               cursorTravelPx; clicks: { source hand|mouse, outcome tape-point|note|
//               part-select|deselect|miss }; tape: [{ t, dist, m }]; hands: per handedness
//               engagedS / restedS / raises / pointerPoseS; tilt: upDeg / downDeg (model pitch
//               during grab; up = negative pitch about world X, hologram.js) and withHandDeg /
//               againstHandDeg (pitch agreeing with the second hand's vertical motion);
//               scale: per pinch-scale episode from -> to factor + reversals; explodes:
//               [{ t, ms }]; resets by clap | key | button, undos by key | other.
//               One-hand selection (2026-10-01): clicks carry via hold|pinch|other-pinch|mouse;
//               metrics selectsHold / selectsPinch / selectsOtherPinch / selectsMouse (the
//               runtime's own counts, window.hologram.pointerStats.selects) and selectMisses*
//               (miss outcomes by via); page.selects = { byVia, misses }. Selection practice
//               (window.hologram.selectionPractice, calibrate.js): page.selectionPractice = the
//               results as published, a 'practice' event when they appear, and metrics
//               practiceRounds / practiceHits / practiceN / practiceFalseSelects / practiceCancelled
//               plus practice<Commit>Hits / N per commit (Hold, Pinch, OtherPinch, Any).
//     platform  wraps the library store's saveWorking / saveVersion / checkout (counts and
//               triggers only), reads ring.isOpen(), file extensions of dropped / picked files
//               (never names), the navigation type (reload) and per-project version counts.
//               Polygon lens (window.hologram.polygon, platform/polygon.js): wraps that one
//               api's enter / exit / select / hidePatch / toggleInferredPatch (arguments and
//               results pass through) and polls api.active / api.radius. page.polygon =
//               { entries, activeS, bvhMs:[ms per enter], radius:{ adjusts, min, max, last },
//               selects:[{ t, add, faces, areaCm2, inferredPct }], ops:[{ t, op hide|mark|
//               unmark, faces }], undos:{ hide, mark, unmark } }. An undo of a polygon op is
//               an edit-log entry (op polyHide / polyInfer) that left h.edits.
//   checklist: one entry per step of docs/testing/LEDGER.md "Owner live checklist"
//     { step: 'C1', what, status, evidence } with status 'seen' | 'partial' | 'not-seen' |
//     'problem' (seen, but the wrong outcome) | 'manual' (not observable here) |
//     'other-page'. P1-P3 (pointer) and L1-L3 (polygon lens) are steps the ledger does not
//     list yet.
//
//   Pure helpers (no DOM, testable in Node): createFpsTracker, createModeTracker,
//   createExplodeWatch, parseLength, classifyFiles, checklistEvidence.
// ---------------------------------------------------------------------------------------

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const FPS_FLOOR = 20, LOW_FPS_MS = 2000, FPS_BUCKET_MS = 500;
const FLICKER_CHANGES = 4, FLICKER_WINDOW_MS = 1000;
const CHECKPOINT_MS = 5000, STALE_MS = 10 * 60 * 1000;
const MAX_BEACON = 60000;           // under Chrome's 64 KB keepalive budget
const MAX_EVENTS = 300, MAX_TIMELINE = 600, MAX_LOG = 50, MAX_MSG = 400, MAX_KEYS = 60;
const BENIGN_ERRORS = [/^INFO: Created TensorFlow Lite XNNPACK delegate/];
const OPEN_PREFIX = 'sessionrec:open:', PENDING_KEY = 'sessionrec:pending';
const QUICK_EXPLODE_MS = 1500, QUICK_EXPLODES = 3, QUICK_WINDOW_MS = 10000;
const MOSTLY_BACKGROUND = 0.5;     // hidden share of the session above which it is "mostly in background"
const MAX_LIST = 60;               // per-feature lists (clicks, tape, explodes, scale episodes)
const DEG = 180 / Math.PI;

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

// Explode entries that end within 1.5 s, three of them inside 10 s, are what an explode that
// keeps firing by itself looks like (BUGS #26: open hands after a tilt), not a deliberate
// pull-apart, which the owner holds for longer. add() returns true when it opens an episode.
export function createExplodeWatch({ shortMs = QUICK_EXPLODE_MS, count = QUICK_EXPLODES, windowMs = QUICK_WINDOW_MS } = {}) {
  let starts = [];
  const episodes = [];
  return {
    add(t, ms) {
      if (!(ms < shortMs)) return false;
      starts.push(t);
      starts = starts.filter((s) => s >= t - windowMs);
      if (starts.length < count) return false;
      if (episodes.length < 20) episodes.push({ t: Math.round(starts[0]), entries: starts.length });
      starts = [];   // the next episode needs three fresh short entries
      return true;
    },
    get episodes() { return episodes; }
  };
}

// measure.js formatLength output ("42.0 cm", "1.23 m", '5.1"', "1' 5.1\"") -> metres, or null.
export function parseLength(s) {
  const txt = String(s);
  let m;
  if ((m = /(\d+)' ([\d.]+)"/.exec(txt))) return +((+m[1] * 12 + +m[2]) * 0.0254).toFixed(4);
  if ((m = /([\d.]+)"/.exec(txt))) return +(+m[1] * 0.0254).toFixed(4);
  if ((m = /([\d.]+) cm\b/.exec(txt))) return +(+m[1] / 100).toFixed(4);
  if ((m = /([\d.]+) m\b/.exec(txt))) return +(+m[1]).toFixed(4);
  return null;
}

// File names -> counts by kind (extensions only; the names themselves are never kept).
// Photos are just labelled: the photo pipeline is a separate feature, not an error.
const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic'], SCAN_EXTS = ['glb', 'gltf', 'obj', 'ply'], PART_EXTS = ['bin', 'mtl'];
export function classifyFiles(names) {
  const out = { photos: 0, scans: 0, sidecars: 0, parts: 0, other: 0, exts: [] };
  for (const n of names) {
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(String(n))?.[1]?.toLowerCase() ?? '';
    if (PHOTO_EXTS.includes(ext)) out.photos++;
    else if (SCAN_EXTS.includes(ext)) out.scans++;
    else if (ext === 'json') out.sidecars++;
    else if (PART_EXTS.includes(ext)) out.parts++;
    else out.other++;
    if (ext && !out.exts.includes(ext) && out.exts.length < 8) out.exts.push(ext);
  }
  out.kind = out.photos && !out.scans ? 'photo' : out.scans ? 'scan' : out.sidecars ? 'sidecar' : 'other';
  return out;
}

// The owner's live checklist (docs/testing/LEDGER.md, "Owner live checklist (draft,
// 2026-10-01)"), step by step, judged from what this session saw. `ev` is the flat evidence
// object the page probe builds (see each probe's evidence()); missing fields read as 0.
// Keep the step ids and wording in step with the ledger when it changes.
const CHECKLIST = [
  ['A1', 'gun-lab self-test 45/0'], ['A2', 'gun-lab camera + skeleton'], ['A3', 'gun-lab guided probe'], ['A4', 'gun-lab copy results JSON'],
  ['B1', 'hands.html: camera on, hands tracked'], ['B2', 'hands.html: 5 camera starts'], ['B3', 'hands.html: memory flat (Activity Monitor)'],
  ['C1', 'raise other hand during fist: tilts UP'], ['C2', 'lower other hand: tilts DOWN'],
  ['C3', 'hold tilt, open fist, lower hands: no explode'], ['C4', 'two-hand pinch scale, small reversals'],
  ['C5', 'explode, click a part, fist-grab moves only it'], ['C6', 'claps reset (x5), U undoes, no reset after explode'],
  ['P1', 'pointer: aim (index out, 3 curled)'], ['P2', 'pointer: other-hand pinch clicks'], ['P3', 'pointer: tape measured with pinch clicks'],
  ['D1', 'platform opens on the ring, 0 errors'], ['D2', 'edit autosaves; reload restores it'], ['D3', 'Cmd+S saves a version'],
  ['D4', 'drop a scan file -> new project'], ['D5', 'drop OBJ + JSON together, press I twice'],
  ['L1', 'polygon lens: P on an item, wheel resizes the lens, click / Shift-click select'],
  ['L2', 'polygon lens: Delete hides the patch, Cmd+Z brings it back'],
  ['L3', 'polygon lens: I marks / unmarks the patch inferred, Cmd+Z undoes']
];
const PAGE_OF = { A: 'gun-lab', B: 'hands', C: 'hologram', P: 'hologram', D: 'platform', L: 'platform' };
export function checklistEvidence(page, ev = {}) {
  const n = (k) => (Number.isFinite(ev[k]) ? ev[k] : 0);
  const f1 = (v) => (+v).toFixed(1);
  const judge = {
    B1: () => [n('cameraStarts') && n('handsSeenS') > 0.5 ? 'seen' : n('cameraStarts') ? 'partial' : 'not-seen', `camera starts ${n('cameraStarts')}, hands tracked ${f1(n('handsSeenS'))} s`],
    B2: () => [n('cameraStarts') >= 5 ? 'seen' : n('cameraStarts') >= 2 ? 'partial' : 'not-seen', `camera starts ${n('cameraStarts')}, stops ${n('cameraStops')}`],
    B3: () => ['manual', ev.jsHeapMB ? `JS heap ${ev.jsHeapMB} MB (not the renderer total; read Activity Monitor)` : 'read Activity Monitor'],
    C1: () => [n('tiltAgainstHandDeg') > 5 && n('tiltAgainstHandDeg') > n('tiltWithHandDeg') ? 'problem' : n('tiltUpDeg') >= 5 ? 'seen' : n('tiltUpDeg') > 0.5 ? 'partial' : 'not-seen',
      `tilt up ${f1(n('tiltUpDeg'))} deg; with hand ${f1(n('tiltWithHandDeg'))} deg, against hand ${f1(n('tiltAgainstHandDeg'))} deg`],
    C2: () => [n('tiltDownDeg') >= 5 ? 'seen' : n('tiltDownDeg') > 0.5 ? 'partial' : 'not-seen', `tilt down ${f1(n('tiltDownDeg'))} deg`],
    C3: () => [n('explodeAfterGrab') ? 'problem' : n('tiltedGrabEnds') && n('restAfterGrab') ? 'seen' : n('tiltedGrabEnds') ? 'partial' : 'not-seen',
      `tilted grabs released ${n('tiltedGrabEnds')}, lowered to rest after ${n('restAfterGrab')}, explode within 2 s of a release ${n('explodeAfterGrab')}`],
    C4: () => [n('scaleEpisodes') && n('scaleReversals') >= 2 ? 'seen' : n('scaleEpisodes') ? 'partial' : 'not-seen', `pinch-scale episodes ${n('scaleEpisodes')}, reversals ${n('scaleReversals')}, ${ev.scaleSummary || 'no change'}`],
    C5: () => [n('explodeEntries') && n('partSelects') && n('partGrabS') > 0.3 ? 'seen' : n('explodeEntries') || n('partSelects') ? 'partial' : 'not-seen',
      `explodes ${n('explodeEntries')}, part selects ${n('partSelects')}, grab on a part ${f1(n('partGrabS'))} s`],
    C6: () => [n('resetsAfterExplode') ? 'problem' : n('clapResets') >= 5 && n('undos') ? 'seen' : n('clapResets') || n('undos') ? 'partial' : 'not-seen',
      `clap resets ${n('clapResets')}, key/button resets ${n('keyResets') + n('buttonResets')}, undos ${n('undos')}, resets within 1.5 s of an explode ${n('resetsAfterExplode')}`],
    P1: () => [n('pointerActiveS') >= 1 ? 'seen' : n('pointerPoseS') > 0 ? 'partial' : 'not-seen', `pointer shown ${f1(n('pointerActiveS'))} s in ${n('pointerEntries')} entries, pose held ${f1(n('pointerPoseS'))} s, cursor travel ${Math.round(n('cursorTravelPx'))} px`],
    P2: () => [n('handClicks') && n('handClicks') > n('handMisses') ? 'seen' : n('handClicks') ? 'partial' : 'not-seen', `hand clicks ${n('handClicks')} (tape ${n('tapeClicks')}, part ${n('handPartClicks')}, miss ${n('handMisses')})`],
    P3: () => [n('tapeMeasurements') && n('tapeClicks') >= 2 ? 'seen' : n('tapeMeasurements') || n('tapeClicks') ? 'partial' : 'not-seen', `tape measurements ${n('tapeMeasurements')}${ev.tapeDists ? ` (${ev.tapeDists})` : ''}, by pinch ${n('tapeClicks')} points`],
    D1: () => [n('ringAtLanding') ? (n('consoleErrors') ? 'problem' : 'seen') : 'not-seen', `ring open at landing ${n('ringAtLanding') ? 'yes' : 'no'}, console errors ${n('consoleErrors')}`],
    D2: () => [n('reloadRestores') || (n('edits') && n('autosaveWrites')) ? 'seen' : n('edits') ? 'partial' : 'not-seen',
      `edits ${n('edits')}, autosave writes ${n('autosaveWrites')}${n('autosaveFailures') ? ` (${n('autosaveFailures')} failed)` : ''}, reload restored a project ${n('reloadRestores') ? 'yes' : 'no'}`],
    D3: () => [n('versionSavesKey') ? 'seen' : n('versionSaves') || n('saveAttempts') ? 'partial' : 'not-seen',
      `version saves ${n('versionSaves')} (Cmd+S ${n('versionSavesKey')}, button ${n('versionSavesButton')}), attempts ${n('saveAttempts')}${ev.versionCounts ? `, versions ${ev.versionCounts}` : ''}`],
    D4: () => [n('scanUploads') ? 'seen' : n('photoUploads') ? 'partial' : 'not-seen', `scan files ${n('scanUploads')}, photo files ${n('photoUploads')} (photo = label only)`],
    L1: () => [n('polyEntries') && n('polyRadiusAdjusts') && n('polySelects') ? 'seen' : n('polyEntries') ? 'partial' : 'not-seen',
      `lens entries ${n('polyEntries')} (${f1(n('polyActiveS'))} s, BVH max ${Math.round(n('polyBvhMaxMs'))} ms), radius adjusts ${n('polyRadiusAdjusts')}, patches selected ${n('polySelects')} (${n('polySelectFaces')} faces)`],
    L2: () => [n('polyHides') && n('polyHideUndos') ? 'seen' : n('polyHides') ? 'partial' : 'not-seen',
      `hides ${n('polyHides')} (${n('polyHideFaces')} faces), undone ${n('polyHideUndos')}`],
    L3: () => [n('polyMarks') + n('polyUnmarks') && n('polyInferUndos') ? 'seen' : n('polyMarks') + n('polyUnmarks') ? 'partial' : 'not-seen',
      `marked inferred ${n('polyMarks')} (${n('polyMarkFaces')} faces), unmarked ${n('polyUnmarks')} (${n('polyUnmarkFaces')} faces), undone ${n('polyInferUndos')}`],
    D5: () => [n('objJsonDrops') && n('inferredToggles') >= 2 ? 'seen' : n('objJsonDrops') || n('inferredToggles') ? 'partial' : 'not-seen', `OBJ+JSON drops ${n('objJsonDrops')}, I presses ${n('inferredToggles')}`]
  };
  return CHECKLIST.map(([step, what]) => {
    const where = PAGE_OF[step[0]];
    if (where !== page) return { step, what, status: 'other-page', evidence: where === 'gun-lab' ? 'gun-lab runs are saved by testrec.js' : `${where} page` };
    const [status, evidence] = judge[step]();
    return { step, what, status, evidence };
  });
}

// ---- page probes ----------------------------------------------------------------------
// Each reads state a page already exposes; all are wrapped so a renamed global just records
// nothing. `fast` runs every frame (cheap getters only), `slow` 4x a second.

// hologram.html. pointer.js, the measure panel and the hand list are module-private in
// hologram.js, so this reads what they produce instead: the hands handed to the manipulator
// (by wrapping that one instance's update()), the reticle in the scene, the 'hologram:click'
// events (or, on older pages, the #status line) for click outcomes, and the measure panel's tape text.
// 'other-pinch' -> 'OtherPinch' (metric name suffixes).
const camel = (s) => String(s).split(/[^a-z0-9]+/i).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');

// Tool enter / exit counts and seconds per tool, from the 'hologram:tool' { tool, prev } event
// (toolWheel.js createToolStatus; both pages). 'none' = free move, so its seconds are the time
// spent in no tool. Evidence: toolEnters / toolExits (any tool) and tool<Id>Enters / tool<Id>S
// per tool; data: tools { id: { enters, exits, s } }.
function toolTracker(ctx) {
  const tools = {}, r1 = (v) => Math.round(v * 10) / 10;
  let cur = window.hologram?.tool ?? 'none', since = ctx.now();
  const row = (id) => (tools[id] = tools[id] ?? { enters: 0, exits: 0, ms: 0 });
  ctx.on(window, 'hologram:tool', (e) => {
    const d = e?.detail || {};
    if (typeof d.tool !== 'string' || d.tool === cur) return;
    const t = ctx.now();
    row(cur).ms += t - since;
    if (cur !== 'none') row(cur).exits++;
    if (d.tool !== 'none') row(d.tool).enters++;
    ctx.event(t, 'tool', { tool: d.tool, prev: cur });
    cur = d.tool; since = t;
  });
  const snap = (t) => {
    const out = {};
    for (const [id, r] of Object.entries(tools)) out[id] = { enters: r.enters, exits: r.exits, s: r1((r.ms + (id === cur ? t - since : 0)) / 1000) };
    if (!out[cur]) out[cur] = { enters: 0, exits: 0, s: r1((t - since) / 1000) };
    return out;
  };
  return {
    evidence(t = ctx.now()) {
      const out = { toolEnters: 0, toolExits: 0 };
      for (const [id, r] of Object.entries(snap(t))) {
        out.toolEnters += r.enters; out.toolExits += r.exits;
        out['tool' + camel(id) + 'Enters'] = r.enters; out['tool' + camel(id) + 'S'] = r.s;
      }
      return out;
    },
    data(t = ctx.now()) { return snap(t); }
  };
}

function hologramProbe(ctx) {
  const tt = toolTracker(ctx);
  let manip = null, resets = 0, canUndo = false, model = null, prevMode = null, lastT = null;
  const recent = { r: -1e9, resetBtn: -1e9, undoKey: -1e9, canvasUp: -1e9 };
  const ev = { clapResets: 0, keyResets: 0, buttonResets: 0, undos: 0, undosByKey: 0, resetsAfterExplode: 0,
    explodeEntries: 0, explodeAfterGrab: 0, tiltedGrabEnds: 0, restAfterGrab: 0, scaleEpisodes: 0, scaleReversals: 0,
    partSelects: 0, partGrabS: 0, pointerActiveS: 0, pointerEntries: 0, pointerPoseS: 0, mouseCursorS: 0, cursorTravelPx: 0,
    handClicks: 0, mouseClicks: 0, tapeClicks: 0, handPartClicks: 0, handMisses: 0, noteClicks: 0, tapeMeasurements: 0,
    tiltUpDeg: 0, tiltDownDeg: 0, tiltWithHandDeg: 0, tiltAgainstHandDeg: 0 };
  const explodes = [], scales = [], clickList = [], tape = [], hands = {};
  const explodeWatch = createExplodeWatch();
  let explodeStart = null, explodeEnd = -1e9, grab = null, lastGrabEnd = null, scaleEp = null, firstScale = null;
  let pitchSinceCam = 0, lastQ = null, lastQTarget = null;
  let reticle = null, ret = null, rect = null, ptrOn = false, ptrOffAt = -1e9, lastPx = null, tapeTxt = '';
  let wrapped = null, origUpdate = null, ourUpdate = null, lastCam = null;
  const wrist = {};
  let practiceSeen = window.hologram?.selectionPractice ?? null; // results from before this session don't count

  const push = (list, item) => { if (list.length < MAX_LIST) list.push(item); };
  const targetOf = (m, h) => m.activePart ?? h.model;

  // Keys / button / canvas releases, to tell a clap reset from R or the Reset button and a
  // mouse click from a pinch click. Same input filter as hologram.js's own key handler.
  ctx.on(window, 'keydown', (e) => {
    if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const k = String(e.key).toLowerCase(), mod = e.metaKey || e.ctrlKey;
    if (!mod && !e.altKey && k === 'r') recent.r = ctx.now();
    if ((!mod && !e.altKey && k === 'u') || (mod && k === 'z')) recent.undoKey = ctx.now();
  }, true);
  ctx.on(document, 'click', (e) => { if (e.target?.closest?.('#reset')) recent.resetBtn = ctx.now(); }, true);
  ctx.on(document, 'pointerup', (e) => { if (e.target?.tagName === 'CANVAS') recent.canvasUp = ctx.now(); }, true);

  // Click outcomes. hologram.js publishes each one as a 'hologram:click' event
  // (detail { outcome, source: 'hand'|'mouse', t }) since the 2026-10-01 declutter reworded
  // the #status lines. The old status-line regexes stay as a fallback for older copies of the
  // page, but switch off for good once an event arrives so nothing is counted twice.
  let clickEvents = false;
  const missesByVia = {};
  const record = (t, source, outcome, via = null) => {
    push(clickList, via ? { t: Math.round(t), source, outcome, via } : { t: Math.round(t), source, outcome });
    if (outcome === 'miss' && via) missesByVia[via] = (missesByVia[via] ?? 0) + 1;
    if (source === 'mouse') ev.mouseClicks++; else ev.handClicks++;
    if (outcome === 'part-select') ev.partSelects++;
    if (source === 'hand') {
      if (outcome === 'tape-point') ev.tapeClicks++;
      else if (outcome === 'note') ev.noteClicks++;
      else if (outcome === 'miss') ev.handMisses++;
      else ev.handPartClicks++;
    }
    ctx.event(t, 'click', via ? { source, outcome, via } : { source, outcome });
  };
  const KNOWN = ['tape-point', 'note', 'miss', 'part-select', 'deselect'];
  ctx.on(window, 'hologram:click', (e) => {
    const d = e?.detail || {};
    if (!KNOWN.includes(d.outcome)) return;
    clickEvents = true;
    record(ctx.now(), d.source === 'mouse' ? 'mouse' : 'hand', d.outcome, typeof d.via === 'string' ? d.via : null);
  });

  const OUTCOMES = [
    [/^tape: point [AB] placed/, 'tape-point'], [/^note pinned/, 'note'], [/^pointer click missed the model/, 'miss'],
    [/^selected: /, 'part-select'], [/^whole model selected/, 'deselect'],
    [/^click · turn on the tape/, 'miss'], [/^click · explode the model past half-way/, 'miss']
  ];
  const statusEl = document.getElementById('status');
  if (statusEl && typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => {
      if (clickEvents) return;
      const txt = statusEl.textContent || '';
      const hit = OUTCOMES.find(([re]) => re.test(txt));
      if (!hit) return;
      const t = ctx.now(), outcome = hit[1];
      // tape / note / miss lines are only ever written for hand clicks (the panel handles mouse
      // clicks itself); a part select is a mouse click when the canvas was just released.
      record(t, ['part-select', 'deselect'].includes(outcome) && t - recent.canvasUp < 200 ? 'mouse' : 'hand', outcome);
    });
    mo.observe(statusEl, { childList: true, characterData: true, subtree: true });
    ctx.undo(() => mo.disconnect());
  }

  // One camera frame's hands, exactly as the manipulator gets them (after annotateHand and
  // createEngagement). Never throws into the app's loop.
  function onCameraFrame(handsIn, m) {
    const now = ctx.now();
    const dt = lastCam === null ? 0 : Math.min(250, Math.max(0, now - lastCam));
    lastCam = now;
    let engagedCount = 0;
    const dys = [];
    for (const hand of handsIn ?? []) {
      const label = String(hand?.handedness || '?').slice(0, 8);
      const r = (hands[label] ??= { engagedMs: 0, restedMs: 0, raises: 0, poseMs: 0, was: null });
      const eng = hand.engaged !== false;
      if (eng) { r.engagedMs += dt; engagedCount++; } else r.restedMs += dt;
      if (eng && r.was === false) r.raises++;
      r.was = eng;
      if (eng && hand.pointer?.gun === true) { r.poseMs += dt; ev.pointerPoseS += dt / 1000; }
      const y = hand.landmarks?.[0]?.y;
      if (Number.isFinite(y)) {
        if (Number.isFinite(wrist[label])) dys.push({ dy: y - wrist[label], fist: hand.gesture === 'Closed_Fist' });
        wrist[label] = y;
      }
    }
    // Tilt direction vs the second hand: in a grab the non-fist hand drives pitch, and
    // raising it (image y falling) should tilt the model up (negative pitch).
    if (m.mode === 'grab' && engagedCount === 2 && dys.length === 2 && Math.abs(pitchSinceCam) > 0.02) {
      const second = dys[0].fist !== dys[1].fist ? dys.find((d) => !d.fist) : dys.reduce((a, b) => (Math.abs(b.dy) > Math.abs(a.dy) ? b : a));
      if (Math.abs(second.dy) > 0.002) {
        if (pitchSinceCam * second.dy > 0) ev.tiltWithHandDeg += Math.abs(pitchSinceCam); else ev.tiltAgainstHandDeg += Math.abs(pitchSinceCam);
      }
    }
    pitchSinceCam = 0;
    // C3: after a tilted grab ends, the hands drop to rest (none engaged).
    if (lastGrabEnd && !lastGrabEnd.rested && now - lastGrabEnd.t < 3000 && engagedCount === 0) { lastGrabEnd.rested = true; ev.restAfterGrab++; }
  }
  function wrap(m) {
    unwrap();
    if (typeof m.update !== 'function') return;
    const orig = m.update;
    const ours = function (handsIn, ...rest) {
      try { onCameraFrame(handsIn, m); } catch { /* recording must never break tracking */ }
      return orig.call(this, handsIn, ...rest);
    };
    try { m.update = ours; wrapped = m; origUpdate = orig; ourUpdate = ours; } catch { /* frozen object: no hand data */ }
  }
  function unwrap() {
    // Only put the original back if nobody re-wrapped it after us.
    if (wrapped && wrapped.update === ourUpdate) { try { wrapped.update = origUpdate; } catch { /* ignore */ } }
    wrapped = null; origUpdate = null; ourUpdate = null;
  }
  ctx.undo(unwrap);

  function modeChange(mode, t, m, h) {
    if (prevMode === 'explode' && explodeStart !== null) {
      const ms = t - explodeStart;
      push(explodes, { t: Math.round(explodeStart), ms: Math.round(ms) });
      if (explodeWatch.add(explodeStart, ms)) ctx.event(t, 'quick-explodes', { entries: QUICK_EXPLODES });
      explodeStart = null; explodeEnd = t;
    }
    if (prevMode === 'grab' && grab) {
      if (Math.abs(grab.pitch) >= 5) { ev.tiltedGrabEnds++; lastGrabEnd = { t, rested: false }; }
      grab = null;
    }
    if (prevMode === 'transform' && scaleEp) {
      const target = targetOf(m, h);
      const to = target?.scale?.x;
      if (Number.isFinite(to) && scaleEp.from) {
        const e = { t: Math.round(scaleEp.t), ms: Math.round(t - scaleEp.t), from: +scaleEp.from.toFixed(4), to: +to.toFixed(4), factor: +(to / scaleEp.from).toFixed(3), reversals: scaleEp.reversals };
        push(scales, e);
        ev.scaleReversals += scaleEp.reversals;
        ctx.event(t, 'scale', { factor: e.factor, reversals: e.reversals });
      }
      scaleEp = null;
    }
    if (mode === 'explode') {
      explodeStart = t; ev.explodeEntries++;
      if (lastGrabEnd && t - lastGrabEnd.t < 2000) ev.explodeAfterGrab++;
    }
    if (mode === 'grab') grab = { t, pitch: 0 };
    if (mode === 'transform') {
      const s = targetOf(m, h)?.scale?.x;
      scaleEp = { t, from: s, last: s, dir: 0, acc: 0, reversals: 0 };
      ev.scaleEpisodes++;
    }
    prevMode = mode;
  }

  function findReticle(h) {
    // reticle.js: a Group (renderOrder 1000) holding [holder Group (ring + dot), beam Line].
    for (const o of h.scene?.children ?? []) {
      if (o.isGroup && o.renderOrder === 1000 && o.children.length === 2 && o.children[1].isLine) return { group: o, holder: o.children[0], beam: o.children[1], v: o.children[0].position.clone() };
    }
    return null;
  }

  return {
    fast(t) {
      const h = window.hologram;
      const m = h?.manipulator;
      const dt = lastT === null ? 0 : Math.min(100, t - lastT);
      lastT = t;
      if (m) { ctx.mode.set(m.mode, t); if (m.mode !== prevMode) modeChange(m.mode, t, m, h); }
      if (m && m !== manip) { manip = m; resets = m.resetCount; canUndo = m.canUndo; wrap(m); lastQ = null; }
      else if (m) {
        if (m.resetCount > resets) {
          const by = t - recent.r < 300 ? 'key' : t - recent.resetBtn < 300 ? 'button' : 'clap';
          const k = m.resetCount - resets;
          ctx.count('resets', k); ev[by + 'Resets'] += k;
          // A clap firing while (or just after) the hands bring exploded parts together.
          const afterExplode = by === 'clap' && (prevMode === 'explode' || t - explodeEnd < 1500);
          if (afterExplode) ev.resetsAfterExplode += k;
          ctx.event(t, 'reset', { by, ...(afterExplode ? { afterExplode: true } : {}) });
          resets = m.resetCount;
        }
        // canUndo true -> false without a new reset = the reset was undone.
        else if (canUndo && !m.canUndo) {
          const by = t - recent.undoKey < 300 ? 'key' : 'other';
          ctx.count('undos'); ev.undos++; if (by === 'key') ev.undosByKey++;
          ctx.event(t, 'undo', { by });
        }
        canUndo = m.canUndo;
      }
      if (h && h.model && h.model !== model) {
        model = h.model;
        ctx.count('modelLoads');
        firstScale = null;
        // The registry id of the carousel's active model (repo models, never user files).
        const id = document.querySelector('#modelCarousel .active')?.dataset.id || model.name || '';
        ctx.event(t, 'model-load', { model: String(id).slice(0, 60) });
      }
      if (!m || !h?.model) return;
      const target = targetOf(m, h);
      // Pitch: world-frame rotation delta of the controlled object, x component.
      const q = target.quaternion;
      if (q && lastQ && lastQTarget === target) {
        const cx = -lastQ.x, cy = -lastQ.y, cz = -lastQ.z, cw = lastQ.w;
        const w = q.w * cw - q.x * cx - q.y * cy - q.z * cz;
        const x = q.w * cx + q.x * cw + q.y * cz - q.z * cy;
        const pitch = 2 * Math.sign(w || 1) * x * DEG;   // small-angle rotation vector, degrees
        if (m.mode === 'grab' && Math.abs(pitch) > 1e-4) {
          if (pitch < 0) ev.tiltUpDeg -= pitch; else ev.tiltDownDeg += pitch;
          pitchSinceCam += pitch;
          if (grab) grab.pitch += pitch;
        }
      }
      if (q) { lastQ = { x: q.x, y: q.y, z: q.z, w: q.w }; lastQTarget = target; }
      // Scale: start->end factor per pinch-scale episode, reversals with a 0.5% deadzone.
      const s = h.model.scale?.x;
      if (Number.isFinite(s)) firstScale ??= s;
      if (scaleEp && m.mode === 'transform') {
        const cur = target.scale?.x;
        if (Number.isFinite(cur) && scaleEp.last) {
          scaleEp.acc += Math.log(cur / scaleEp.last);
          scaleEp.last = cur;
          if (Math.abs(scaleEp.acc) > 0.005) {
            const dir = Math.sign(scaleEp.acc);
            if (scaleEp.dir && dir !== scaleEp.dir) scaleEp.reversals++;
            scaleEp.dir = dir; scaleEp.acc = 0;
          }
        }
      }
      if (m.mode === 'grab' && m.activePart) ev.partGrabS += dt / 1000;
      // Pointer as the owner saw it: the reticle shown with the hand's beam = hand pointer;
      // shown without a beam = the mouse cursor.
      if (ret?.group && ret.group.parent) {
        const shown = ret.group.visible, beam = shown && ret.beam.visible;
        if (beam) {
          ev.pointerActiveS += dt / 1000;
          if (!ptrOn && t - ptrOffAt > 250) { ev.pointerEntries++; ctx.event(t, 'pointer-on'); }
          ptrOn = true;
          if (rect && h.camera) {
            ret.v.copy(ret.holder.position).project(h.camera);
            const px = { x: ret.v.x * rect.width / 2, y: ret.v.y * rect.height / 2 };
            if (lastPx) ev.cursorTravelPx += Math.hypot(px.x - lastPx.x, px.y - lastPx.y);
            lastPx = px;
          }
        } else {
          if (ptrOn) ptrOffAt = t;
          ptrOn = false; lastPx = null;
          if (shown) ev.mouseCursorS += dt / 1000;
        }
      }
    },
    slow(t) {
      const h = window.hologram;
      if (h && (!ret || !ret.group.parent)) ret = findReticle(h);
      // Selection practice results appear (finished or stopped) as a new object.
      const sp = h?.selectionPractice;
      if (sp && sp !== practiceSeen) {
        practiceSeen = sp;
        const rounds = Array.isArray(sp.rounds) ? sp.rounds : [];
        ctx.event(t, 'practice', { rounds: rounds.length, hits: rounds.reduce((a, r) => a + (r.hits || 0), 0), n: rounds.reduce((a, r) => a + (r.n || 0), 0) });
      }
      const r = h?.renderer?.domElement?.getBoundingClientRect?.();
      if (r) rect = r;
      // Tape: a new measurement is the readout turning into "<distance> apart ..."; a change
      // while it already shows one (unit switch, calibration) only updates the last entry.
      const txt = document.querySelector('#measure .measure-tape')?.textContent || '';
      const m = /^(.{1,24}) apart on the real object/.exec(txt);
      if (m && txt !== tapeTxt) {
        const entry = { t: Math.round(t), dist: m[1], m: parseLength(m[1]) };
        if (/ apart on the real object/.test(tapeTxt) && tape.length) Object.assign(tape[tape.length - 1], { dist: entry.dist, m: entry.m });
        else { push(tape, entry); ev.tapeMeasurements++; ctx.event(t, 'tape', { dist: entry.dist, m: entry.m }); }
      }
      tapeTxt = txt;
    },
    evidence(t) {
      const out = { ...ev, ...tt.evidence(t) };
      for (const k of ['pointerActiveS', 'pointerPoseS', 'mouseCursorS', 'partGrabS', 'tiltUpDeg', 'tiltDownDeg', 'tiltWithHandDeg', 'tiltAgainstHandDeg']) out[k] = +out[k].toFixed(1);
      out.cursorTravelPx = Math.round(out.cursorTravelPx);
      out.accidentalExplodes = explodeWatch.episodes.length;
      out.tapeDists = tape.slice(-5).map((x) => x.dist).join(', ');
      out.scaleSummary = scales.slice(-4).map((x) => `x${x.factor}`).join(', ');
      const s = window.hologram?.model?.scale?.x;
      if (firstScale && Number.isFinite(s)) out.scaleSessionFactor = +(s / firstScale).toFixed(3);
      const sel = window.hologram?.pointerStats?.selects;
      if (sel) {
        out.selectsHold = sel.hold ?? 0; out.selectsPinch = sel.pinch ?? 0;
        out.selectsOtherPinch = sel['other-pinch'] ?? 0; out.selectsMouse = sel.mouse ?? 0;
      }
      out.selectMisses = Object.values(missesByVia).reduce((a, b) => a + b, 0);
      for (const [via, n] of Object.entries(missesByVia)) out['selectMisses' + camel(via)] = n;
      const sp = practiceSeen;
      if (sp && Array.isArray(sp.rounds)) {
        const sum = (k, rs = sp.rounds) => rs.reduce((a, r) => a + (Number(r[k]) || 0), 0);
        out.practiceRounds = sp.rounds.length;
        out.practiceHits = sum('hits'); out.practiceN = sum('n'); out.practiceFalseSelects = sum('falseSelects');
        out.practiceCancelled = sp.rounds.some((r) => r.cancelled) ? 1 : 0;
        for (const c of ['hold', 'pinch', 'other-pinch', 'any']) {
          const rs = sp.rounds.filter((r) => r.commit === c);
          if (rs.length) { out['practice' + camel(c) + 'Hits'] = sum('hits', rs); out['practice' + camel(c) + 'N'] = sum('n', rs); }
        }
      }
      return out;
    },
    data(t) {
      const hs = {};
      for (const [k, r] of Object.entries(hands)) hs[k] = { engagedS: +(r.engagedMs / 1000).toFixed(1), restedS: +(r.restedMs / 1000).toFixed(1), raises: r.raises, pointerPoseS: +(r.poseMs / 1000).toFixed(1) };
      const sel = window.hologram?.pointerStats?.selects;
      return { tools: tt.data(t), hands: hs, clicks: clickList, tape, explodes, quickExplodes: explodeWatch.episodes, scale: scales, cameraFramesSeen: lastCam !== null,
        selects: { byVia: sel ? { ...sel } : null, misses: { ...missesByVia } }, selectionPractice: practiceSeen ?? null };
    },
    flags() {
      const e = explodeWatch.episodes;
      return e.length ? [{ kind: 'possible-accidental-explode', message: `${QUICK_EXPLODES}+ explode entries shorter than ${QUICK_EXPLODE_MS / 1000} s within ${QUICK_WINDOW_MS / 1000} s, ${e.length} time(s); first at ${(e[0].t / 1000).toFixed(1)} s` }] : [];
    }
  };
}

function handsProbe(ctx) {
  const el = document.getElementById('readout');
  let handsMs = 0, lastT = null;
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
      if (/Left|Right/.test(label)) handsMs += lastT === null ? 0 : Math.min(100, t - lastT);
      lastT = t;
    },
    slow() {},
    evidence() { return { handsSeenS: +(handsMs / 1000).toFixed(1) }; }
  };
}

// platform/index.html. The library store and the ring are reachable through
// window.hologram.library; the store's three write methods are wrapped on that one instance
// (counts and triggers only, arguments pass through untouched).
function platformProbe(ctx) {
  const tt = toolTracker(ctx);
  let edits = null, items = null, stats = null, project, ringOpen = null, unit = null;
  let ringClosedAt = -1e9, ringEverOpen = false, firstOpenDone = false, store = null, wasOpening = false, pendingRing = null;
  const recent = { modS: -1e9, saveBtn: -1e9 };
  const ev = { ringOpens: 0, ringCloses: 0, ringChooses: 0, ringAtLanding: 0, saveAttempts: 0, versionSaves: 0, versionSavesKey: 0,
    versionSavesButton: 0, versionSaveFailures: 0, autosaveWrites: 0, autosaveFailures: 0, versionCheckouts: 0, reloadRestores: 0,
    landingRestores: 0, uploads: 0, photoUploads: 0, scanUploads: 0, objJsonDrops: 0, inferredToggles: 0, edits: 0,
    polyEntries: 0, polyActiveS: 0, polyBvhMaxMs: 0, polyRadiusAdjusts: 0, polySelects: 0, polySelectFaces: 0, polySelectAreaCm2: 0,
    polyHides: 0, polyHideFaces: 0, polyMarks: 0, polyMarkFaces: 0, polyUnmarks: 0, polyUnmarkFaces: 0,
    polyHideUndos: 0, polyInferUndos: 0 };
  const versionCounts = {}, autosaveByProject = {}, uploads = [];
  // Polygon lens. `log` is a shallow copy of h.edits (same entry objects) so an undo can be
  // attributed to the op it removed; objectmode pops the shared array in place.
  const poly = { api: null, active: false, since: 0, activeMs: 0, radius: null, radiusAt: -1e9, radiusFrom: null,
    radiusMin: null, radiusMax: null, bvhMs: [], selects: [], ops: [], undos: { hide: 0, mark: 0, unmark: 0 } };
  let log = [];
  let navType = '';
  try { navType = String(performance.getEntriesByType('navigation')[0]?.type ?? ''); } catch { /* old browser */ }

  ctx.on(window, 'keydown', (e) => {
    if (e.target?.matches?.('input, textarea')) return;
    const k = String(e.key).toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && k === 's' && !e.repeat) { recent.modS = ctx.now(); ev.saveAttempts++; }
    // With a patch selected, polygon.js takes I (mark inferred) before main.js sees it: that
    // press is a polygon op, not a "show inferred" toggle (D5).
    if (!e.metaKey && !e.ctrlKey && !e.altKey && k === 'i' && !(poly.api?.active && poly.api.state?.().patch)) ev.inferredToggles++;
  }, true);
  ctx.on(document, 'click', (e) => { if (e.target?.closest?.('#saveVersionBtn')) { recent.saveBtn = ctx.now(); ev.saveAttempts++; } }, true);
  // Uploads: extensions only. Capture phase, so this runs before main.js's drop handler; reading
  // dataTransfer.files does not consume anything.
  function noteUpload(files, via) {
    const names = [...(files ?? [])].map((f) => f?.name ?? '');
    if (!names.length) return;
    const c = classifyFiles(names), t = ctx.now();
    ev.uploads++; ev.photoUploads += c.photos; ev.scanUploads += c.scans;
    if (c.exts.includes('obj') && c.sidecars) ev.objJsonDrops++;
    const u = { t: Math.round(t), via, kind: c.kind, photos: c.photos, scans: c.scans, sidecars: c.sidecars, parts: c.parts, other: c.other, exts: c.exts };
    if (uploads.length < MAX_LIST) uploads.push(u);
    ctx.event(t, 'upload', { via, kind: c.kind, files: names.length });
  }
  ctx.on(window, 'drop', (e) => noteUpload(e.dataTransfer?.files, 'drop'), true);
  ctx.on(document, 'change', (e) => { if (e.target?.type === 'file') noteUpload(e.target.files, 'picker'); }, true);

  const id8 = (id) => String(id ?? '').slice(0, 8);
  function countVersions(projectId) {
    if (!store?.listProjects || !projectId) return;
    store.listProjects().then((list) => {
      const p = list.find((x) => x.project?.id === projectId);
      if (p) versionCounts[id8(projectId)] = p.versions.filter((v) => v.type !== 'working').length;
    }).catch(() => {});
  }
  // A project (or version) opened while the ring is up, or just after it closed, was chosen
  // on the ring.
  const fromRing = (t) => ringOpen === true || t - ringClosedAt < 1500;

  function wrapStore(s) {
    const undo = [];
    const tap = (name, before, after) => {
      const orig = s[name];
      if (typeof orig !== 'function') return;
      const ours = function (...a) {
        let tag;
        try { tag = before(a); } catch { /* ignore */ }
        const p = orig.apply(this, a);
        Promise.resolve(p).then((r) => { try { after(tag, true, a, r); } catch { /* ignore */ } }, () => { try { after(tag, false, a); } catch { /* ignore */ } });
        return p;
      };
      try { s[name] = ours; undo.push(() => { if (s[name] === ours) s[name] = orig; }); } catch { /* frozen */ }
    };
    tap('saveWorking', () => null, (_, ok, a) => {
      if (ok) { ev.autosaveWrites++; const k = id8(a[0]); autosaveByProject[k] = (autosaveByProject[k] ?? 0) + 1; } else ev.autosaveFailures++;
    });
    tap('saveVersion', () => {
      // The newest trigger within 3 s (the write waits for any queued autosave first).
      const t = ctx.now(), last = Math.max(recent.modS, recent.saveBtn);
      return t - last >= 3000 ? 'other' : last === recent.modS ? 'key' : 'button';
    }, (by, ok, a) => {
      const t = ctx.now();
      if (!ok) { ev.versionSaveFailures++; ctx.event(t, 'version-save-failed', { by }); return; }
      ev.versionSaves++;
      if (by === 'key') ev.versionSavesKey++; else if (by === 'button') ev.versionSavesButton++;
      ctx.event(t, 'version-save', { by, id: id8(a[0]) });
      countVersions(a[0]);
    });
    tap('checkout', () => null, (_, ok) => {
      if (!ok) return;
      const t = ctx.now();
      ev.versionCheckouts++;
      ctx.event(t, 'version-checkout', { ring: fromRing(t) });
    });
    return () => undo.forEach((fn) => fn());
  }
  let unwrapStore = () => {};
  ctx.undo(() => unwrapStore());

  const r1 = (v) => Math.round(v * 10) / 10;
  function polyEnterEnd(t) { if (poly.active) { poly.activeMs += t - poly.since; poly.active = false; } }
  function wrapPolygon(api) {
    const undo = [];
    const tap = (name, after) => {
      const orig = api[name];
      if (typeof orig !== 'function') return;
      const ours = function (...a) {
        const r = orig.apply(this, a);
        try { after(r, a); } catch { /* recording must never break the lens */ }
        return r;
      };
      try { api[name] = ours; undo.push(() => { if (api[name] === ours) api[name] = orig; }); } catch { /* frozen */ }
    };
    // bvhMs is the build time of this enter (≈0 when the item's BVHs were already built).
    tap('enter', (ok) => {
      if (!ok) { ctx.event(ctx.now(), 'polygon-enter-failed'); return; }
      const ms = Number(api.state?.().bvhMs) || 0;
      if (poly.bvhMs.length < MAX_LIST) poly.bvhMs.push(Math.round(ms));
      ev.polyBvhMaxMs = Math.max(ev.polyBvhMaxMs, Math.round(ms));
      ctx.event(ctx.now(), 'polygon-enter', { bvhMs: Math.round(ms) });
    });
    tap('select', (S, a) => {
      if (!S) return;
      const t = ctx.now(), add = !!a[0]?.add, areaCm2 = r1((S.area || 0) * 1e4);
      ev.polySelects++; ev.polySelectFaces += S.faces || 0; ev.polySelectAreaCm2 = r1(ev.polySelectAreaCm2 + areaCm2);
      if (poly.selects.length < MAX_LIST) poly.selects.push({ t: Math.round(t), add, faces: S.faces || 0, areaCm2, inferredPct: Math.round(S.inferredPct || 0) });
      ctx.event(t, 'polygon-select', { add, faces: S.faces || 0, areaCm2 });
    });
    const noteOp = (op, faces) => {
      const t = ctx.now();
      if (poly.ops.length < MAX_LIST) poly.ops.push({ t: Math.round(t), op, faces });
      ctx.event(t, 'polygon-' + op, { faces });
    };
    tap('hidePatch', (e) => { if (!e) return; ev.polyHides++; ev.polyHideFaces += e.faces || 0; noteOp('hide', e.faces || 0); });
    tap('toggleInferredPatch', (e) => {
      if (!e) return;
      if (e.to) { ev.polyMarks++; ev.polyMarkFaces += e.faces || 0; } else { ev.polyUnmarks++; ev.polyUnmarkFaces += e.faces || 0; }
      noteOp(e.to ? 'mark' : 'unmark', e.faces || 0);
    });
    return () => undo.forEach((fn) => fn());
  }
  let unwrapPolygon = () => {};
  ctx.undo(() => unwrapPolygon());
  function polyUndone(removed, t) {
    for (const e of removed) {
      const kind = e?.op === 'polyHide' ? 'hide' : e?.op === 'polyInfer' ? (e.to ? 'mark' : 'unmark') : null;
      if (!kind) continue;
      poly.undos[kind]++;
      if (kind === 'hide') ev.polyHideUndos++; else ev.polyInferUndos++;
      ctx.event(t, 'polygon-undo', { op: kind, faces: e.faces || 0 });
    }
  }
  // Wheel notches arrive as a burst of radius changes: one "adjust" per burst (600 ms quiet).
  function pollPolygon(t) {
    const api = poly.api;
    if (!api) return;
    const on = !!api.active;
    if (on && !poly.active) { poly.active = true; poly.since = t; ev.polyEntries++; }
    else if (!on && poly.active) { polyEnterEnd(t); ctx.event(t, 'polygon-exit'); }
    const r = Number(api.radius);
    if (Number.isFinite(r) && r !== poly.radius) {
      if (poly.radius !== null) {
        if (t - poly.radiusAt > 600) { ev.polyRadiusAdjusts++; poly.radiusFrom = poly.radius; }
        poly.radiusAt = t;
      }
      poly.radius = r;
      poly.radiusMin = poly.radiusMin === null ? r : Math.min(poly.radiusMin, r);
      poly.radiusMax = poly.radiusMax === null ? r : Math.max(poly.radiusMax, r);
    }
    if (poly.radiusFrom !== null && t - poly.radiusAt > 600) {
      ctx.event(poly.radiusAt, 'lens-radius', { from: Math.round(poly.radiusFrom), to: Math.round(poly.radius) });
      poly.radiusFrom = null;
    }
  }

  return {
    fast(t) {
      const om = window.hologram?.objectMode;
      if (om) ctx.mode.set(om.mode, t);
      pollPolygon(t);
    },
    slow(t) {
      const h = window.hologram;
      if (!h) return;
      const s = h.library?.store;
      if (s && s !== store) { unwrapStore(); store = s; unwrapStore = wrapStore(s); }
      const pa = h.polygon;
      if (pa && pa !== poly.api) { unwrapPolygon(); poly.api = pa; unwrapPolygon = wrapPolygon(pa); }
      pollPolygon(t);
      const ring = h.library?.ring;
      const open = typeof ring?.isOpen === 'function' ? !!ring.isOpen() : null;
      if (open !== null && open !== ringOpen) {
        if (open) { ev.ringOpens++; if (!ringEverOpen && !firstOpenDone && t < 20000) ev.ringAtLanding = 1; ringEverOpen = true; }
        else if (ringOpen) { ev.ringCloses++; ringClosedAt = t; }
        if (ringOpen !== null || open) ctx.event(t, open ? 'ring-open' : 'ring-close');
        ringOpen = open;
      }
      const n = Array.isArray(h.edits) ? h.edits.length : null;
      const st = h.library?.state?.();
      const pid = st ? (st.projectId ?? null) : undefined;
      // openProject() raises state().opening at once, while a load can take seconds: judge
      // "chosen on the ring" at that edge, not when the project id finally changes.
      if (st?.opening && !wasOpening) { pendingRing = fromRing(t); if (pendingRing) { ev.ringChooses++; ctx.event(t, 'ring-choose'); } }
      wasOpening = !!st?.opening;
      if (pid !== undefined && pid !== project) {
        // Opening or closing a project swaps the whole edit log: don't read that as undos.
        if (pid) {
          let ringChose = pendingRing;
          if (ringChose === null) { ringChose = fromRing(t); if (ringChose) { ev.ringChooses++; ctx.event(t, 'ring-choose'); } }
          pendingRing = null;
          // The first project of a load that the ring did not choose was reopened by landing()
          // (the last project); after a reload that is "reload restored the project".
          const landing = !firstOpenDone && !ringChose && !ringEverOpen && t < 20000;
          if (landing) { ev.landingRestores++; if (navType === 'reload') ev.reloadRestores++; }
          ctx.event(t, 'project-open', { id: id8(pid), sample: !!st.sample, ...(ringChose ? { ring: true } : {}), ...(landing ? { landing: true, nav: navType } : {}) });
          ctx.count('projectOpens');
          firstOpenDone = true;
          countVersions(pid);
        } else if (project) ctx.event(t, 'project-close');
        project = pid; edits = n;
      } else if (n !== null && edits !== null && n !== edits) {
        if (n > edits) { ctx.count('edits', n - edits); ev.edits += n - edits; } else {
          ctx.count('undos', edits - n); ctx.event(t, 'undo', { steps: edits - n });
          polyUndone(log.slice(n), t);
        }
        edits = n;
      } else edits = n;
      log = Array.isArray(h.edits) ? h.edits.slice() : [];
      const ni = Array.isArray(h.items) ? h.items.length : (h.items?.size ?? null);
      if (ni !== null && items !== null && ni !== items) ctx.event(t, 'items', { count: ni });
      items = ni;
      if (h.stats && h.stats !== stats) {
        stats = h.stats;
        ctx.count('modelLoads');
        const s = stats, num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
        ctx.event(t, 'model-load', { tris: num(s.tris), points: num(s.points), parts: num(s.parts), components: num(s.components), splitMs: num(s.splitMs), parseMs: num(s.parseMs) });
      }
      const u = h.measurements?.unit;
      if (u && u !== unit) { if (unit !== null) ctx.event(t, 'unit', { unit: String(u) }); unit = u; }
    },
    evidence(t) {
      ev.polyActiveS = r1((poly.activeMs + (poly.active ? (t ?? ctx.now()) - poly.since : 0)) / 1000);
      return { ...ev, ...tt.evidence(t), versionCounts: Object.entries(versionCounts).map(([k, v]) => `${k}:${v}`).join(', ') };
    },
    data(t) {
      const polygon = poly.api ? {
        entries: ev.polyEntries, activeS: r1((poly.activeMs + (poly.active ? (t ?? ctx.now()) - poly.since : 0)) / 1000), bvhMs: poly.bvhMs.slice(),
        radius: { adjusts: ev.polyRadiusAdjusts, min: poly.radiusMin, max: poly.radiusMax, last: poly.radius },
        selects: poly.selects.slice(), ops: poly.ops.slice(), undos: { ...poly.undos }
      } : null;
      return { tools: tt.data(t), navType, versionCounts: { ...versionCounts }, autosaveByProject: { ...autosaveByProject }, uploads, polygon };
    },
    flags() { return []; }
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
  // A page can offer a slot (hologram.html: #recSlot, right end of the status bar), because
  // the fixed bottom-centre spot sits on its coach box there. Other pages keep bottom centre.
  const slot = document.getElementById('recSlot');
  const look = 'z-index:99998;font:10px/1.4 ui-monospace,monospace;letter-spacing:.06em;' +
    'color:#9fc9d8;background:rgba(8,18,26,.78);border:1px solid #2a4a5a;border-radius:4px;padding:2px 8px;cursor:pointer;user-select:none';
  b.style.cssText = slot ? `position:relative;display:inline-block;white-space:nowrap;${look}`
    : `position:fixed;left:50%;transform:translateX(-50%);bottom:5px;${look}`;
  const panel = document.createElement('pre');
  panel.id = 'sessionrec-panel';
  const panelAt = slot ? 'right:10px;bottom:calc(var(--status-h, 28px) + 6px)' : 'left:50%;transform:translateX(-50%);bottom:30px';
  panel.style.cssText = `position:fixed;${panelAt};z-index:99998;max-width:min(520px,90vw);max-height:50vh;overflow:auto;margin:0;` +
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
    const bg = now.metrics.mostlyBackground ? `\nMostly in background: ${now.metrics.backgroundPct}% of it hidden (fps and gesture numbers say little).` : '';
    const steps = (now.attachments.session.checklist || []).filter((c) => c.status !== 'other-page')
      .map((c) => `  ${c.step} ${c.status.padEnd(9)} ${c.evidence}`).join('\n');
    panel.textContent = `${last}\n\nThis session so far (${Math.round(now.durationMs / 1000)} s, ${now.attachments.session.events.length} events, ` +
      `${now.consoleErrors.length} console errors):${bg}\n${fmtFlags(now.flags)}` +
      (steps ? `\n\nChecklist evidence (docs/testing/LEDGER.md):\n${steps}` : '') +
      `\n\nSaved when the tab closes, to docs/testing/runs/${page}/.`;
  });
  if (slot) { slot.append(b); document.body.append(panel); } else document.body.append(b, panel);
  return {
    cleanup: () => { b.remove(); panel.remove(); },
    // Static text swap, no animation (photosafety).
    note(mostlyBackground) {
      const txt = mostlyBackground ? 'SHADOW · recording · mostly in background' : 'SHADOW · recording';
      if (b.textContent !== txt) b.textContent = txt;
    }
  };
}

// ---- guided test dock -------------------------------------------------------------------
// testguide.js shows the owner's current guided-test step on this page. It is only fetched
// when guide.html has started a run (a localStorage flag), so normal sessions load nothing.
function maybeMountGuide(name) {
  let active = false;
  try { active = !!JSON.parse(localStorage.getItem('testguide:v1') || 'null')?.active; } catch { /* no guide */ }
  if (!active) return;
  const go = () => import(new URL(`./testguide.js?v=${Date.now()}`, import.meta.url).href)
    .then((m) => m.mountGuide({ page: name })).catch(() => {});
  if (document.body) go(); else addEventListener('DOMContentLoaded', go, { once: true });
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
  // Framed copies are test harnesses (ring-test / library-test load platform/index.html in an
  // iframe): not the owner's session, and a badge there could catch the harness's clicks.
  if (window.top !== window) return null;
  // Guided test dock (testguide.js): shown only while the owner runs the guide from
  // guide.html. Loaded from here so no page needs its own guard; it also shows with ?rec=off.
  maybeMountGuide(name);
  if (new URLSearchParams(location.search).get('rec') === 'off') return null;
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
  const guideFails = new Map();   // guided-test step id -> kind, for steps marked Fail
  let ended = false;

  const ctx = {
    mode,
    count(k, n = 1) { counts[k] = (counts[k] ?? 0) + n; },
    event(t, type, data = {}) {
      if (events.length < MAX_EVENTS) events.push({ t: Math.round(t), type, ...data }); else eventsDropped++;
    },
    now: rel,
    on: (...a) => on(...a),
    undo: (fn) => undo.push(fn)
  };

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
  const probe = { evidence: () => ({}), data: () => null, flags: () => [], ...(PROBES[name] ?? (() => ({ fast() {}, slow() {} })))(ctx) };
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
    else if (!live && cameraSince !== null) { const on = t - cameraSince; cameraOnMs += on; cameraSince = null; ctx.count('cameraStops'); ctx.event(t, 'camera-stop', { onS: +(on / 1000).toFixed(1) }); }
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
    badgeNote(t > 5000 && hiddenShare(t, false) > MOSTLY_BACKGROUND);
  }, 250);
  const beatTimer = setInterval(() => checkpoint(), CHECKPOINT_MS);
  undo.push(() => { cancelAnimationFrame(raf); clearInterval(slowTimer); clearInterval(beatTimer); });

  // Hold a Web Lock for this document's lifetime: when the tab dies (closed or crashed) the
  // lock goes with it, which is how a later load tells a crashed session from a live tab.
  try { navigator.locks?.request(openKey, () => new Promise(() => {})); } catch { /* no Locks API: STALE_MS fallback */ }

  function flagsOf(rec, closing) {
    const f = [];
    for (const [id, kind] of guideFails) f.push({ kind: 'guide-fail', message: `owner marked guided step ${id} as Fail (${kind || 'step'}; see guide.html for the note)` });
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
    const bg = rec.metrics.mostlyBackground ? `mostly in background (${rec.metrics.backgroundPct}% of the session hidden): ` : '';
    if (periods) f.push({ kind: 'hidden-tab', message: `${bg}tab hidden ${periods} time(s), ${((hidden.ms + (trailing > 1000 ? trailing : 0)) / 1000).toFixed(1)} s in total: rAF/fps paused then` });
    try { f.push(...probe.flags(rel())); } catch { /* a probe bug must not lose the record */ }
    return f.map((x) => ({ ...x, source: 'page' }));
  }

  // Share of the session the tab spent hidden (same close rule as the hidden-tab flag). Agent
  // tabs and forgotten tabs run hidden; their fps and gesture numbers say little about the app.
  function hiddenShare(t, closing) {
    const trailing = hidden.since !== null ? t - hidden.since : 0;
    const ms = hidden.ms + (!closing || trailing > 1000 ? trailing : 0);
    return t > 0 ? ms / t : 0;
  }
  function jsHeapMB() {
    const m = performance.memory?.usedJSHeapSize;   // Chrome only; JS heap, not the whole renderer
    return Number.isFinite(m) ? Math.round(m / 1048576) : null;
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
    const share = hiddenShare(t, closing);
    metrics.backgroundPct = Math.round(share * 100);
    metrics.mostlyBackground = share > MOSTLY_BACKGROUND;
    const heap = jsHeapMB();
    if (heap !== null) metrics.jsHeapMB = heap;
    let evidence = {}, pageData = null;
    try { evidence = probe.evidence(t) || {}; pageData = probe.data(t); } catch { /* keep the base record */ }
    // Numbers go into metrics too (flat, so FLAGS / ledger tooling can read them directly).
    for (const [k, v] of Object.entries(evidence)) if (typeof v === 'number' && !(k in metrics)) metrics[k] = v;
    const checklist = checklistEvidence(name, { ...counts, ...evidence, consoleErrors: consoleErrors.length, jsHeapMB: heap });
    const mine = checklist.filter((c) => c.status !== 'other-page');
    metrics.checklistSeen = mine.filter((c) => c.status === 'seen').map((c) => c.step).join(' ');
    metrics.checklistProblems = mine.filter((c) => c.status === 'problem').map((c) => c.step).join(' ');
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
          hidden: { periods: hidden.periods, ms: Math.round(hidden.ms) },
          page: pageData, checklist
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

  let cleanupBadge = () => {}, badgeNote = () => {};
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

  // Guided test verdicts: the step id and verdict only (never the owner's note text), and a
  // page flag per step marked Fail, so a Fail reaches FLAGS.md with this session even if the
  // owner never saves the run from guide.html.
  on(window, 'testguide:verdict', (e) => {
    const d = e.detail || {};
    if (typeof d.id !== 'string' || !/^[A-Z]{1,4}\d{1,3}$/.test(d.id)) return;
    const verdict = ['pass', 'fail', 'unsure'].includes(d.verdict) ? d.verdict : 'cleared';
    ctx.event(rel(), 'guide', { id: d.id, verdict });
    ctx.count('guideVerdicts');
    if (verdict === 'fail') guideFails.set(d.id, String(d.kind || '').slice(0, 20)); else guideFails.delete(d.id);
  });
  on(window, 'pagehide', () => session.end());
  window.__sessionrec ??= { current: null, lastSent: null };
  window.__sessionrec.current = session;
  // Restored from the back/forward cache: the old session was already sent on pagehide.
  if (!window.__sessionrec.pageshowHooked) {
    window.__sessionrec.pageshowHooked = true;
    addEventListener('pageshow', (e) => { if (e.persisted) startSession({ name }); });
  }

  const mount = () => { const bd = mountBadge(session, page); cleanupBadge = bd.cleanup; badgeNote = bd.note; };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount, { once: true });
  checkpoint();
  flushLeftovers(openKey);
  return session;
}

// Pointer calibration (owner decision 2, 2026-10-01): ~45 s, skippable, on first camera use and
// again on "Recalibrate" (key C or the button). Three steps:
//   a) open hand 3 s      -> palm length in px (the speed unit), camera fps, lighting check
//   b) trace a rectangle  -> reach box (5th-95th percentile of the palm) + engage line below it
//   c) target practice    -> two rounds of 8 targets (sizes alternate), clicked with the other
//                            hand's pinch, one round per smoothing preset; the better one is kept
// The result is saved to localStorage[PROFILE_KEY] and applied to the pointer + engagement.
//
// CONTRACT
//   PROFILE_KEY = 'hologram.pointerProfile.v1'
//   profile = { v: 1, at: ISO string, skipped: bool,
//               reach: { x0, x1, y0, y1 } (image units of the palm centroid),
//               engageY (wrist y of the engage line, image units),
//               smoothing: { name: 'responsive' | 'steady', minCutoff, beta, dCutoff },
//               palmPx, fps, light (mean luma 0-255 or null), trackRate (0-1),
//               score: { n, hits, errMedianPx, errP90Px, timeMedianMs, overshoots, throughput,
//                        perSetting: { responsive: {...same}, steady: {...same} } } | null,
//               warnings: [string] }
//   loadProfile(storage?) -> profile | null      never throws (bad JSON / blocked storage -> null)
//   saveProfile(profile, storage?) -> bool       never throws
//   applyProfile(profile, { pointer, engagement })
//   scoreLine(profile) -> one-line human summary
//   Pure helpers (tested): quantile, reachFromPalms, palmLengthPx, makeTargets, scoreTrials, pickSetting
//   createCalibration({ pointer, engagement, rect, video?, parent?, onDone(profile), onCancel(profile) })
//     -> { active, step, start(tMs), cancel() (skip: saves skipped profile), abort() (no save),
//          onFrame(hands, tMs), onClick(click), tick(tMs), dispose() }
//     onFrame: every camera frame AFTER pointer.update (it reads pointer.state).
//     onClick: hand clicks while active (the caller routes them here instead of act()).
//     rect(): the canvas's client rect { left, top, width, height } (CSS px).
//     storage: where the profile is saved (default localStorage; tests pass their own so a test
//     run never overwrites the owner's real profile, which shares the localhost origin).
//
// SELECTION PRACTICE (A/B of one-hand selection, owner 2026-10-01 (3)); separate from the
// 45 s calibration, started by the host (handsRuntime.startPractice):
//   PRACTICE_ROUNDS: 3 commit modes (hold / same-hand pinch / other-hand pinch) x (point /
//     bubble) + a cluster round (6 targets 30-60 px apart, any commit, bubble).
//   makeClusterTargets(viewW, viewH, n = 6, rng?) -> [{ x, y, r }] centres 30-60 px apart.
//   rankTargets(targets, cursorPx, bubble) -> selector candidates (hit = inside the ring).
//   scoreSelectRound(trials) -> { n, hits, misses, falseSelects, errMedianPx, timeMedianMs }
//     trials: [{ ok: bool, wrong: count of wrong selections, errPx | null, ms | null }]
//   createSelectionPractice({ pointer, rect, parent?, rounds?, onDone(results) })
//     -> { active, round, start(tMs), onFrame(tMs) -> selector state, onClick(click), cancel(),
//          dispose(), results }
//     The card has a "✕ Stop (Esc)" button ([data-role="practice-stop"]) that calls cancel().
//     All targets of a round show at once; one is lit (the cue). Select it with the round's
//     commit; selecting another one is a false select; 6 s without = a miss. Clicks of
//     another commit kind are ignored (and counted as `offMode`).
//     results = { v: 1, at, rounds: [{ commit, targeting, cluster, n, hits, misses,
//       falseSelects, offMode, errMedianPx, timeMedianMs }] }; also set on
//     globalThis.hologram.selectionPractice when that exists (sessionrec reads it).
// Photosafety (BUGS #14): nothing flashes; every appearance is an eased opacity transition, the
// progress bar's width is CSS-eased, and a target hit only fades the target out.

import { palmCentroid, SMOOTHING, createSelector, BUBBLE_PX } from './pointer.js';
import { hammerAngleDeg, createHammer, HAMMER_DEFAULTS } from './gunPose.js';
import { palmLength } from './gestures.js';
import { HF } from './handFeatures.js';

export const PROFILE_KEY = 'hologram.pointerProfile.v1';
export const HAND_MS = 3000;
export const REACH_MS = 6000;
export const TARGETS_PER_ROUND = 8;
export const TARGET_RADII_PX = [44, 22];  // two sizes, alternating within a round
const TARGET_TIMEOUT_MS = 6000;           // a target not clicked by then counts as a miss
const GAP_MS = 200;                       // blank pause between targets (the old ring fades first)
const MIN_REACH_SAMPLES = 60;
const MIN_REACH_SPAN = 0.12;              // image units; a smaller "rectangle" isn't a trace
const ENGAGE_BELOW = 0.05;                // engage line this far below the lowest comfortable wrist
const DIM_LUMA = 60;

export function quantile(values, q) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

// Wrist (0) to middle-finger knuckle (9): the most rigid span on the hand, so it doesn't change
// with the pose. In video pixels, the unit later speeds can be expressed in.
export function palmLengthPx(landmarks, videoW, videoH) {
  const a = landmarks[0];
  const b = landmarks[9];
  return Math.hypot((b.x - a.x) * videoW, (b.y - a.y) * videoH);
}

// palms: [{ x, y }] palm centroids; wrists: [y] wrist heights (image units).
export function reachFromPalms(palms, wrists = [], { lo = 0.05, hi = 0.95 } = {}) {
  const warnings = [];
  if (palms.length < MIN_REACH_SAMPLES) {
    return { reach: null, engageY: null, warnings: [`only ${palms.length} palm samples (need ${MIN_REACH_SAMPLES}); reach box not changed`] };
  }
  const xs = palms.map((p) => p.x);
  const ys = palms.map((p) => p.y);
  const reach = { x0: quantile(xs, lo), x1: quantile(xs, hi), y0: quantile(ys, lo), y1: quantile(ys, hi) };
  if (reach.x1 - reach.x0 < MIN_REACH_SPAN || reach.y1 - reach.y0 < MIN_REACH_SPAN) {
    return { reach: null, engageY: null, warnings: ['the traced rectangle was too small; reach box not changed'] };
  }
  // Round to 3 decimals: the profile is read by people too.
  for (const k of Object.keys(reach)) reach[k] = Math.round(reach[k] * 1000) / 1000;
  const wristLow = quantile(wrists, hi);
  let engageY = Number.isFinite(wristLow) ? Math.round(Math.min(0.92, Math.max(0.5, wristLow + ENGAGE_BELOW)) * 1000) / 1000 : null;
  if (engageY !== null && wristLow + ENGAGE_BELOW > 0.92) warnings.push('your comfortable reach goes near the bottom of the camera view; engage line kept at 0.92');
  return { reach, engageY, warnings };
}

// ISO 9241-9 ring: N targets on a circle, visited across the circle (0, N/2, 1, N/2+1, ...),
// so every movement is about a diameter long and directions vary. Sizes alternate.
export function makeTargets(viewW, viewH, n = TARGETS_PER_ROUND, radii = TARGET_RADII_PX) {
  const R = 0.32 * Math.min(viewW, viewH);
  const order = [];
  for (let k = 0; k < n / 2; k++) order.push(k, k + n / 2);
  return order.map((idx, i) => {
    const a = (2 * Math.PI * idx) / n - Math.PI / 2;
    return { x: viewW / 2 + R * Math.cos(a), y: viewH / 2 + R * Math.sin(a), r: radii[i % radii.length] };
  });
}

// trials: [{ target: {x, y, r}, from: {x, y} | null, click: {x, y} | null, ms, entries }] in px.
export function scoreTrials(trials) {
  const clicked = trials.filter((t) => t.click);
  const errs = clicked.map((t) => Math.hypot(t.click.x - t.target.x, t.click.y - t.target.y));
  const hits = clicked.filter((t, i) => errs[i] <= t.target.r).length;
  // Overshoot: the cursor entered the target, left it, and came back (entries beyond the first).
  const overshoots = trials.reduce((n, t) => n + Math.max(0, (t.entries ?? 0) - 1), 0);
  // Effective throughput (ISO 9241-9 / Soukoreff & MacKenzie 2004): endpoint spread along the
  // movement axis gives the effective width We = 4.133 SD; IDe = log2(De / We + 1); TP = IDe / MT.
  let throughput = null;
  const moves = clicked.filter((t) => t.from);
  if (moves.length >= 3) {
    const along = [];
    const dist = [];
    for (const t of moves) {
      const ax = t.target.x - t.from.x;
      const ay = t.target.y - t.from.y;
      const len = Math.hypot(ax, ay) || 1;
      const d = ((t.click.x - t.target.x) * ax + (t.click.y - t.target.y) * ay) / len;
      along.push(d);
      dist.push(len + d);
    }
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const m = mean(along);
    const sd = Math.sqrt(along.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, along.length - 1));
    const We = Math.max(1, 4.133 * sd);
    const mt = mean(moves.map((t) => t.ms)) / 1000;
    if (mt > 0) throughput = Math.round((Math.log2(mean(dist) / We + 1) / mt) * 100) / 100;
  }
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return {
    n: trials.length,
    hits,
    errMedianPx: r1(quantile(errs, 0.5)),
    errP90Px: r1(quantile(errs, 0.9)),
    timeMedianMs: r1(quantile(clicked.map((t) => t.ms), 0.5)),
    overshoots,
    throughput
  };
}

// The better smoothing preset: higher throughput (it folds speed and accuracy together); if
// either round has no throughput, fewer misses, then lower median error.
export function pickSetting(a, b) {
  if (Number.isFinite(a?.throughput) && Number.isFinite(b?.throughput) && a.throughput !== b.throughput) {
    return a.throughput > b.throughput ? 'a' : 'b';
  }
  if ((a?.hits ?? 0) !== (b?.hits ?? 0)) return (a?.hits ?? 0) > (b?.hits ?? 0) ? 'a' : 'b';
  return (a?.errMedianPx ?? Infinity) <= (b?.errMedianPx ?? Infinity) ? 'a' : 'b';
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked (privacy mode, sandboxed iframe)
  }
}

export function loadProfile(storage = defaultStorage()) {
  try {
    const p = JSON.parse(storage?.getItem(PROFILE_KEY) ?? 'null');
    return p && p.v === 1 ? p : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile, storage = defaultStorage()) {
  try {
    storage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function applyProfile(profile, { pointer, engagement, features = null }) {
  if (!profile) return;
  if (profile.v === 2) return applyProfileV2(profile, { pointer, features });
  if (profile.reach || profile.smoothing) pointer?.setProfile({ reach: profile.reach, smoothing: profile.smoothing });
  if (Number.isFinite(profile.engageY)) engagement?.setLine(profile.engageY);
}

export function scoreLine(profile) {
  if (!profile) return 'pointer not calibrated · press C to calibrate';
  if (profile.skipped) return 'pointer calibration skipped · default reach · press C to calibrate';
  const s = profile.score;
  if (!s || s.errMedianPx === null) return `pointer calibrated (reach only) · ${profile.smoothing?.name ?? 'responsive'} smoothing`;
  return `pointer calibrated · error ${Math.round(s.errMedianPx)} px median (p90 ${Math.round(s.errP90Px)}) · ` +
    `${(s.timeMedianMs / 1000).toFixed(1)} s per target · ${s.hits}/${s.n} hit` +
    (Number.isFinite(s.throughput) ? ` · ${s.throughput} bits/s` : '') + ` · ${profile.smoothing?.name} smoothing`;
}

const STEP_TEXT = {
  hand: ['1 / 3 · Hand size', 'Hold one open hand up to the camera, palm facing it, and keep it still.'],
  reach: ['2 / 3 · Your reach', 'Make the pointer (index out, three fingers curled) and slowly trace the biggest rectangle you can reach comfortably.'],
  targets: ['3 / 3 · Target practice', 'Aim at the ring and pinch your OTHER hand to click it.']
};

// v1 by default (unchanged); { v2: true } runs calibration v2 (see CALIBRATION V2 below).
export function createCalibration(opts) {
  return opts?.v2 ? createCalibrationV2(opts) : createCalibrationV1(opts);
}

function createCalibrationV1({ pointer, engagement, rect, video = null, parent = document.body, storage = defaultStorage(), onDone = () => {}, onCancel = () => {} }) {
  let step = 'idle';
  let since = 0;
  let handMs = 0;
  let lastFrameT = null;
  // Step a
  let palmPx = [];
  let frames = 0;
  let framesWithHand = 0;
  let firstT = null;
  let handLastT = null; // fps is measured over step a only
  let light = null;
  let lastLightT = -Infinity;
  // Step b
  let palms = [];
  let wrists = [];
  let reachResult = null;
  // Step c
  const settings = ['responsive', 'steady'];
  let round = 0;
  let targets = [];
  let ti = 0;
  let shownAt = 0;
  let entries = 0;
  let inside = false;
  let from = null;
  let trials = [[], []];
  let pending = null;   // { at, kind }: next target / round appears at this frame time
  let warnings = [];
  const startProfile = pointer.profile;

  // ---- UI (built once; eased) ----
  const ease = 'transition:opacity 350ms ease';
  const card = document.createElement('div');
  card.style.cssText = 'position:fixed;left:50%;top:calc(var(--bar-h, 48px) + 10px);transform:translateX(-50%);z-index:60;width:min(520px,90vw);' +
    'padding:12px 16px;border-radius:12px;background:rgba(8,20,30,.88);border:1px solid rgba(120,200,230,.35);' +
    `color:#d6f3ff;font:14px/1.4 system-ui,sans-serif;opacity:0;${ease};pointer-events:none`;
  // pointer-events stays none until start(): an opacity-0 card still takes clicks, and this one
  // sat invisibly over the top centre of the page eating mouse drags (owner report 2026-10-01).
  card.dataset.role = 'calibration-card';
  card.innerHTML = '<div data-k="title" style="font-weight:600;margin-bottom:4px"></div>' +
    '<div data-k="body" style="color:#a9d4e6"></div>' +
    '<div style="height:4px;margin-top:10px;border-radius:2px;background:rgba(120,200,230,.18)">' +
    '<div data-k="bar" style="height:4px;width:0;border-radius:2px;background:#7fd3f0;transition:width 250ms linear"></div></div>' +
    '<div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#7fa9bb">' +
    '<span data-k="note"></span><button data-k="skip" style="font-size:12px">skip (Esc)</button></div>';
  const q = (k) => card.querySelector(`[data-k="${k}"]`);
  q('skip').addEventListener('click', () => api.cancel());
  for (const ev of ['pointerdown', 'pointerup']) card.addEventListener(ev, (e) => e.stopPropagation());

  const targetEl = document.createElement('div');
  targetEl.style.cssText = 'position:fixed;z-index:55;border-radius:50%;border:2px solid #9fe8ff;' +
    `background:rgba(159,232,255,.08);pointer-events:none;opacity:0;${ease};transform:translate(-50%,-50%)`;
  const dotEl = document.createElement('div'); // where the palm is, during the reach trace
  dotEl.style.cssText = 'position:fixed;z-index:55;width:12px;height:12px;border-radius:50%;background:#9fe8ff;' +
    `pointer-events:none;opacity:0;${ease};transform:translate(-50%,-50%)`;
  parent.append(card, targetEl, dotEl);

  const setText = (s) => {
    q('title').textContent = STEP_TEXT[s][0];
    q('body').textContent = STEP_TEXT[s][1];
  };
  const setBar = (f) => (q('bar').style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`);
  const note = (t) => (q('note').textContent = t);

  function sampleLight(t) {
    if (!video?.videoWidth || t - lastLightT < 500) return;
    lastLightT = t;
    try {
      const c = sampleLight.canvas ??= Object.assign(document.createElement('canvas'), { width: 16, height: 9 });
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(video, 0, 0, 16, 9);
      const d = g.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const luma = sum / (d.length / 4);
      light = light === null ? luma : light * 0.7 + luma * 0.3;
    } catch {
      light = null;
    }
  }

  function viewSize() {
    const r = rect();
    return { left: r.left ?? 0, top: r.top ?? 0, width: r.width || 1, height: r.height || 1 };
  }

  function showTarget() {
    const v = viewSize();
    const tg = targets[ti];
    targetEl.style.left = `${v.left + tg.x}px`;
    targetEl.style.top = `${v.top + tg.y}px`;
    targetEl.style.width = targetEl.style.height = `${2 * tg.r}px`;
    targetEl.style.opacity = '1';
    entries = 0;
    inside = false;
    note(`round ${round + 1} of 2 · target ${ti + 1} of ${targets.length}`);
  }

  function beginRound(t) {
    pointer.setProfile({ smoothing: SMOOTHING[settings[round]] });
    const v = viewSize();
    targets = makeTargets(v.width, v.height);
    ti = 0;
    from = null;
    shownAt = t;
    showTarget();
  }

  function go(next, t) {
    step = next;
    since = t;
    handMs = 0;
    if (next in STEP_TEXT) setText(next);
    setBar(0);
    dotEl.style.opacity = next === 'reach' ? '1' : '0';
    pending = null;
    if (next === 'targets') {
      round = 0;
      trials = [[], []];
      beginRound(t);
    } else {
      targetEl.style.opacity = '0';
    }
  }

  function cursorPx() {
    const st = pointer.state;
    if (st.mode !== 'aim' || st.source !== 'hand') return null;
    const v = viewSize();
    return { x: ((st.x + 1) / 2) * v.width, y: ((1 - st.y) / 2) * v.height };
  }

  function nextTarget(t, click) {
    const tg = targets[ti];
    trials[round].push({ target: tg, from, click, ms: t - shownAt, entries });
    from = click ?? { x: tg.x, y: tg.y };
    ti++;
    shownAt = t;
    targetEl.style.opacity = '0';
    if (ti < targets.length) {
      // Let the old ring fade before the next appears in a new place (no jump-cut). Timed on
      // the frame clock (not setTimeout) so tests can replay it.
      pending = { at: t + GAP_MS, kind: 'target' };
      shownAt = pending.at;
      setBar(ti / targets.length);
      return;
    }
    round++;
    if (round < settings.length) {
      pending = { at: t + 2 * GAP_MS, kind: 'round' };
      shownAt = pending.at;
      return;
    }
    finish();
  }

  function advance(t) {
    if (step !== 'targets' || !pending || t < pending.at) return;
    const kind = pending.kind;
    pending = null;
    if (kind === 'round') beginRound(t);
    else showTarget();
  }

  function buildProfile(skipped) {
    const fps = firstT !== null && handLastT > firstT ? Math.round(((frames - 1) * 1000) / (handLastT - firstT)) : null;
    const base = {
      v: 1,
      at: new Date().toISOString(),
      skipped,
      reach: reachResult?.reach ?? startProfile.reach,
      engageY: reachResult?.engageY ?? engagement?.line?.enterY ?? null,
      smoothing: { name: 'responsive', ...SMOOTHING.responsive },
      palmPx: palmPx.length ? Math.round(quantile(palmPx, 0.5) * 10) / 10 : null,
      fps,
      light: light === null ? null : Math.round(light),
      trackRate: frames ? Math.round((framesWithHand / frames) * 100) / 100 : null,
      score: null,
      warnings
    };
    if (!skipped) {
      const a = scoreTrials(trials[0]);
      const b = scoreTrials(trials[1]);
      const pick = pickSetting(a, b) === 'a' ? 0 : 1;
      const name = settings[pick];
      base.smoothing = { name, ...SMOOTHING[name] };
      base.score = { ...(pick === 0 ? a : b), perSetting: { [settings[0]]: a, [settings[1]]: b } };
    }
    return base;
  }

  function hideAll() {
    card.style.opacity = '0';
    targetEl.style.opacity = '0';
    dotEl.style.opacity = '0';
    card.style.pointerEvents = 'none';
  }

  function finish() {
    const profile = buildProfile(false);
    step = 'done';
    hideAll();
    applyProfile(profile, { pointer, engagement });
    saveProfile(profile, storage);
    onDone(profile);
  }

  const api = {
    get active() {
      return step !== 'idle' && step !== 'done';
    },
    get step() {
      return step;
    },
    start(t = performance.now()) {
      palmPx = []; frames = 0; framesWithHand = 0; firstT = null; handLastT = null; lastFrameT = null; light = null;
      palms = []; wrists = []; reachResult = null; warnings = [];
      card.style.pointerEvents = 'auto';
      card.style.opacity = '1';
      go('hand', t);
    },
    cancel() {
      if (!api.active) return;
      // Skipping keeps whatever was measured so far (a finished reach trace is still useful).
      const profile = buildProfile(true);
      step = 'done';
      hideAll();
      applyProfile(profile, { pointer, engagement });
      pointer.setProfile({ smoothing: SMOOTHING.responsive });
      saveProfile(profile, storage);
      onCancel(profile);
    },
    // Stop without saving anything (the camera was turned off mid-run).
    abort() {
      if (!api.active) return;
      step = 'idle';
      hideAll();
      pointer.setProfile({ smoothing: startProfile.smoothing, reach: startProfile.reach });
    },
    onFrame(hands, t) {
      if (!api.active) return;
      const dt = lastFrameT === null ? 0 : Math.min(200, Math.max(0, t - lastFrameT));
      lastFrameT = t;
      const seen = hands.filter((h) => Array.isArray(h?.landmarks) && h.landmarks.length >= 18);
      if (step === 'hand') {
        frames++;
        firstT ??= t;
        handLastT = t;
        sampleLight(t);
        if (!seen.length) return note('no hand in view yet');
        framesWithHand++;
        const vw = video?.videoWidth || 1280;
        const vh = video?.videoHeight || 720;
        palmPx.push(palmLengthPx(seen[0].landmarks, vw, vh));
        handMs += dt;
        setBar(handMs / HAND_MS);
        note(light !== null && light < DIM_LUMA ? 'the room looks dim · more light helps tracking' : '');
        if (handMs >= HAND_MS) {
          if (light !== null && light < DIM_LUMA) warnings.push(`dim lighting (mean luma ${Math.round(light)})`);
          go('reach', t);
        }
      } else if (step === 'reach') {
        const h = seen.find((x) => x.pointer?.gun === true) ?? seen[0];
        if (!h) return note('no hand in view');
        const c = palmCentroid(h.landmarks);
        palms.push(c);
        wrists.push(h.landmarks[0].y);
        const v = viewSize();
        dotEl.style.left = `${v.left + (1 - c.x) * v.width}px`;
        dotEl.style.top = `${v.top + c.y * v.height}px`;
        handMs += dt;
        setBar(handMs / REACH_MS);
        note('');
        if (handMs >= REACH_MS) {
          reachResult = reachFromPalms(palms, wrists);
          warnings.push(...reachResult.warnings);
          applyProfile({ reach: reachResult.reach, engageY: reachResult.engageY }, { pointer, engagement });
          go('targets', t);
        }
      } else if (step === 'targets') {
        advance(t);
        if (pending || ti >= targets.length || t < shownAt) return;
        const c = cursorPx();
        const tg = targets[ti];
        const now = !!c && Math.hypot(c.x - tg.x, c.y - tg.y) <= tg.r;
        if (now && !inside) entries++;
        inside = now;
        if (t - shownAt >= TARGET_TIMEOUT_MS) nextTarget(t, null);
      }
    },
    onClick(click) {
      if (step !== 'targets' || pending || ti >= targets.length || click?.source !== 'hand' || click.t < shownAt) return;
      const v = viewSize();
      nextTarget(click.t, { x: ((click.x + 1) / 2) * v.width, y: ((1 - click.y) / 2) * v.height });
    },
    tick(t = performance.now()) {
      advance(t);
    },
    dispose() {
      card.remove();
      targetEl.remove();
      dotEl.remove();
    }
  };
  return api;
}

// ---- Calibration v2 (plans/hands-v2/CONTRACT.md §4; ranges: Ricky's report §2-5) -------------
// Opt-in: createCalibration({ v2: true, features, ... }). The v1 flow above is untouched.
// Steps (each ≤1 line of text, icon + verb first, a ✓ line on success; owner writing standard):
//   hand   2 s open hand      -> sizeM (world palm), finger lengths, palmPx, fps, light
//   reach  6 s relaxed sweep  -> anchor box (landmark 5, the v2 aim point), V_HIGH, absGain
//   hammer 10 targets         -> COCK/DROP (angle AND gap), Gmin from overshoot, before→after
//   pinch 5 · clap 3 · fist 3 -> PINCH_ON/OFF, CLAP_* , CLOSED_ENTER/EXIT_DEG
//   summary 2.5 s             -> "✓ Calibrated · clicks a/10 → b/10", then save + apply
// "Quick tune-up" (start(t, { quick: true }) or the card's ⚡ button while a v2 profile exists)
// runs the drills only and keeps the saved hand + reach.
//
// Why the drills don't trust the current thresholds: they are what's being fitted, so a ✓
// comes from an ADAPTIVE detector (a fall of ≥ ADAPT_DROP_DEG from the recent peak, a dip below
// half the running open pinch ratio, ...) as well as from the live click. "Before → after" is an
// offline replay of the SAME recorded hammer frames through gunPose.createHammer with the old and
// the fitted thresholds, so both numbers come from identical hand motion.
//
// CONTRACT (v2)
//   PROFILE_V2_KEY = 'hands.profile.v2'
//   profile = { v: 2, at: ISO, skipped, quick,
//     sizeM, fingersM: { thumb, index, middle, ring, pinky } (metres, bone sums), palmPx
//     (aspect-corrected image units), palmVideoPx, fps, light, trackRate,
//     reach: { x0, x1, y0, y1 } image units of landmark 5 (pointer v2's anchor centre), vHigh m/s,
//     thresholds: { <handFeatures HF key>: number, CLAP_ARM_SPAN, CLAP_CONTACT_SPAN (palms),
//                   CLAP_V_MIN (palms/s on raw wrists) }   (only fitted keys are present)
//     gains: { gmin, gmax, vinf, lambda, absGain }         (pointer v2 cursor overrides)
//     score: { hammer: { before: { hits, n, falseClicks }, after: {...} }, overshootRate,
//              pinch: n, clap: n, fist: n } | null,
//     warnings: [string] }
//   loadProfileV2(storage?) / saveProfileV2(profile, storage?)   never throw
//   applyProfileV2(profile, { pointer, features })  features.setProfile({ thresholds }) +
//     pointer.setProfile({ reach, cursor: gains }); applyProfile() forwards v: 2 profiles here.
//   Pure fitters (tested): kmeans1d2, fitHammer, fitPinch, fitClap, fitFist, fitGains, fitReachV2,
//     replayHammer, fingerLengthsM
//   createCalibrationV2({ pointer, rect, features?, video?, parent?, doc?, storage?, aspect?,
//     onDone(profile), onCancel(profile) })  same api as v1 + start(t, { quick }) and .drill
//     ({ name, done, need } of the running drill). features = the runtime's handFeatures (needed
//     to apply the thresholds; without it only the pointer gets the profile).
//   Skip (Esc) keeps an existing v2 profile untouched (a skip must not erase a good calibration);
//   with none saved it saves { skipped: true } plus whatever was measured.

export const PROFILE_V2_KEY = 'hands.profile.v2';
export const V2_HAND_MS = 2000;
export const V2_REACH_MS = 6000;
export const V2_DRILLS = Object.freeze({ hammer: 10, pinch: 5, clap: 3, fist: 3 });
export const V2_TARGET_RADII_PX = [44, 30];
const V2_TARGET_MS = 7000;      // a hammer target not hit by then is skipped
const V2_DRILL_MS = 20000;      // a pinch / clap / fist drill ends after this even if incomplete
const V2_GAP_MS = 300;          // between targets: the trial keeps recording (a stricter fit may fire later)
const V2_SUMMARY_MS = 2500;
const ADAPT_DROP_DEG = 18;      // adaptive hammer: fall from the 400 ms peak that counts as a drop
const ADAPT_REARM_DEG = 12;     // ... re-armed once the thumb rises this far above the fall's low
const MIN_SEP_DEG = 15;         // [Ricky §3] cock vs drop bands closer than this: warn
const MIN_SEP_GAP = 0.15;       // [Ricky §3] same for thumbGap
const GAP_OFF = 9;              // thumbGap threshold that disables the gap rule (finite: setProfile drops non-finite)
const FINGER_CHAINS = { thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };

const r2 = (v, k = 100) => (Number.isFinite(v) ? Math.round(v * k) / k : null);
const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const P = (pt) => (Array.isArray(pt) ? { x: pt[0], y: pt[1], z: pt[2] ?? 0 } : pt);

export function loadProfileV2(storage = defaultStorage()) {
  try {
    const p = JSON.parse(storage?.getItem(PROFILE_V2_KEY) ?? 'null');
    return p && p.v === 2 ? p : null;
  } catch {
    return null;
  }
}

export function saveProfileV2(profile, storage = defaultStorage()) {
  try {
    storage.setItem(PROFILE_V2_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function applyProfileV2(profile, { pointer, features = null } = {}) {
  if (!profile || profile.v !== 2) return;
  features?.setProfile?.({ thresholds: profile.thresholds ?? {} });
  pointer?.setProfile?.({ reach: profile.reach ?? undefined, cursor: profile.gains ?? undefined });
}

// Two-cluster 1-D k-means (Lloyd, from the min/max). Returns null when there's nothing to split.
export function kmeans1d2(values) {
  const a = values.filter(Number.isFinite);
  if (a.length < 4) return null;
  let lo = Math.min(...a);
  let hi = Math.max(...a);
  if (!(hi > lo)) return null;
  let split = (lo + hi) / 2;
  for (let i = 0; i < 30; i++) {
    const L = a.filter((v) => v <= split);
    const H = a.filter((v) => v > split);
    if (!L.length || !H.length) break;
    lo = L.reduce((s, v) => s + v, 0) / L.length;
    hi = H.reduce((s, v) => s + v, 0) / H.length;
    const next = (lo + hi) / 2;
    if (Math.abs(next - split) < 1e-9) break;
    split = next;
  }
  return { lo, hi, split };
}

// frames: [{ deg, gap }] of the aiming hand during the hammer drill. Cocked vs dropped is decided
// by the ANGLE clusters; both features are then fitted on those labels, cock = p20 of cocked,
// drop = p80 of dropped (Ricky §3). The gap is fitted too because handFeatures' cock rule is
// "angle > COCK_DEG OR gap > COCK_GAP": with the default 0.5 the OR stretched the cocked band down
// to ~37° on synthetic thumbs (Cody-P), so a gap that doesn't separate the clusters is switched
// off (GAP_OFF) rather than left to override the angle.
export function fitHammer(frames, { minDrops = 3, drops = Infinity } = {}) {
  const warnings = [];
  const degs = frames.map((f) => f.deg).filter(Number.isFinite);
  const km = kmeans1d2(degs);
  if (!km || km.hi - km.lo < 10 || drops < minDrops) {
    warnings.push(`click: not enough thumb drops measured (${Number.isFinite(drops) ? drops : 0}); kept the click thresholds`);
    return { thresholds: {}, warnings, stats: null };
  }
  const cocked = frames.filter((f) => Number.isFinite(f.deg) && f.deg > km.split);
  const dropped = frames.filter((f) => Number.isFinite(f.deg) && f.deg <= km.split);
  if (cocked.length < 6 || dropped.length < 3) {
    warnings.push('click: too few cocked or dropped frames; kept the click thresholds');
    return { thresholds: {}, warnings, stats: null };
  }
  const cockDeg = quantile(cocked.map((f) => f.deg), 0.2);
  const dropDeg = quantile(dropped.map((f) => f.deg), 0.8);
  const cockGap = quantile(cocked.map((f) => f.gap), 0.2);
  const dropGap = quantile(dropped.map((f) => f.gap), 0.8);
  const stats = { cockDeg: r2(cockDeg, 10), dropDeg: r2(dropDeg, 10), cockGap: r2(cockGap), dropGap: r2(dropGap), nCocked: cocked.length, nDropped: dropped.length };
  const thresholds = {};
  if (cockDeg - dropDeg < 5) {
    warnings.push(`click: thumb up/down angles overlap (${stats.cockDeg}° vs ${stats.dropDeg}°); kept the click thresholds`);
    return { thresholds, warnings, stats };
  }
  if (cockDeg - dropDeg < MIN_SEP_DEG) warnings.push(`click: thumb up/down only ${Math.round(cockDeg - dropDeg)}° apart (want ≥${MIN_SEP_DEG}°); lift the thumb higher`);
  // 1° inside each band: the rules are strict (angle > COCK_DEG), and a steady thumb's p20 IS its
  // plateau, so an exact p20 would never count that thumb as cocked.
  thresholds.COCK_DEG = r2(cockDeg - 1, 10);
  thresholds.DROP_DEG = r2(dropDeg + 1, 10);
  // A gap rule that would call ≥5% of the dropped frames cocked is worse than none.
  const gapLeak = dropped.filter((f) => f.gap > cockGap).length / dropped.length;
  if (Number.isFinite(cockGap) && Number.isFinite(dropGap) && cockGap - dropGap >= MIN_SEP_GAP && gapLeak <= 0.05) {
    thresholds.COCK_GAP = r2(cockGap - 0.01);
    thresholds.DROP_GAP = r2(dropGap + 0.01);
  } else {
    warnings.push(`click: thumb gap doesn't separate up/down (${stats.cockGap} vs ${stats.dropGap}); angle alone decides`);
    thresholds.COCK_GAP = GAP_OFF;
    thresholds.DROP_GAP = GAP_OFF;
  }
  return { thresholds, warnings, stats };
}

// trials: [{ target: {x,y,r}, frames: [{ t, deg, gap, cx, cy }] }] (cursor in view px, null =
// no cursor). A trial is a hit when a replayed click lands in the target, at the cursor one frame
// before the onset (pointer v2's rewind); every other click is a false click.
export function replayHammer(trials, thresholds = {}) {
  let hits = 0;
  let falseClicks = 0;
  for (const tr of trials) {
    const ham = createHammer({ ...HAMMER_DEFAULTS, ...thresholds });
    let hit = false;
    for (let i = 0; i < tr.frames.length; i++) {
      const f = tr.frames[i];
      const o = ham.update(f.deg, f.gap, f.t);
      if (!o.edge) continue;
      let j = i;
      while (j > 0 && tr.frames[j].t >= o.fallT) j--;
      const c = tr.frames[j];
      const inside = Number.isFinite(c?.cx) && Math.hypot(c.cx - tr.target.x, c.cy - tr.target.y) <= tr.target.r;
      if (inside && !hit) hit = true;
      else falseClicks++;
    }
    if (hit) hits++;
  }
  return { hits, n: trials.length, falseClicks };
}

// closed / open: per-frame |w4-w8|/palm ratios while the drill saw the pinch closed / open.
export function fitPinch(closed, open, { minPinches = 3, pinches = Infinity } = {}) {
  const warnings = [];
  const c = quantile(closed, 0.8);
  const o = quantile(open, 0.2);
  if (pinches < minPinches || !Number.isFinite(c) || !Number.isFinite(o)) {
    warnings.push(`pinch: only ${Number.isFinite(pinches) ? pinches : 0} pinches measured; kept the pinch thresholds`);
    return { thresholds: {}, warnings, stats: null };
  }
  const stats = { closedP80: r2(c), openP20: r2(o) };
  if (o - c < 0.08) {
    warnings.push(`pinch: closed and open look alike (${stats.closedP80} vs ${stats.openP20}); kept the pinch thresholds`);
    return { thresholds: {}, warnings, stats };
  }
  if (o - c < MIN_SEP_GAP) warnings.push('pinch: open the fingers wider between pinches');
  // Capped near Ricky's starting values (0.20 / 0.30; contract off ≈0.45): a very wide open hand
  // must not make a half-closed one count as a pinch.
  const on = clampN(c + 0.3 * (o - c), 0.08, 0.3);
  const off = clampN(c + 0.55 * (o - c), on + 0.05, 0.45);
  return { thresholds: { PINCH_ON: r2(on), PINCH_OFF: r2(off) }, warnings, stats };
}

// claps: [{ preMax, minSpan, peakV }] spans in palms, peakV = fastest closing speed (palms/s).
// Arm a bit below the narrowest start, contact a bit above the widest touch, speed floor = the
// slowest clap × 0.6 (contract §4) so slow claps still pass.
export function fitClap(claps, { minClaps = 2 } = {}) {
  const warnings = [];
  if (claps.length < minClaps) {
    warnings.push(`clap: only ${claps.length} claps measured; kept the clap thresholds`);
    return { thresholds: {}, warnings, stats: null };
  }
  const preMin = Math.min(...claps.map((c) => c.preMax));
  const minMax = Math.max(...claps.map((c) => c.minSpan));
  const vMin = Math.min(...claps.map((c) => c.peakV));
  const stats = { preMin: r2(preMin), contactMax: r2(minMax), slowestV: r2(vMin, 10) };
  const arm = clampN(0.8 * preMin, 1.6, 2.5);
  const contact = clampN(1.2 * minMax + 0.1, 0.8, Math.min(1.6, arm - 0.4));
  return { thresholds: { CLAP_ARM_SPAN: r2(arm), CLAP_CONTACT_SPAN: r2(contact), CLAP_V_MIN: r2(0.6 * vMin, 10) }, warnings, stats };
}

// fistPip: the smallest PIP bend of the four fingers in each closed frame; openPip: the largest in
// each open frame. Only ever LOWERS the closed threshold (a fist the default already reads is
// left alone), and keeps ≥15° between the two bands.
export function fitFist(fistPip, openPip, { minFists = 2, fists = Infinity } = {}) {
  const warnings = [];
  const f = quantile(fistPip, 0.2);
  const o = quantile(openPip, 0.9);
  if (fists < minFists || !Number.isFinite(f)) {
    warnings.push(`fist: only ${Number.isFinite(fists) ? fists : 0} fists measured; kept the fist thresholds`);
    return { thresholds: {}, warnings, stats: null };
  }
  const stats = { fistP20: r2(f, 10), openP90: r2(o, 10) };
  if (f - 5 >= HF.CLOSED_ENTER_DEG) return { thresholds: {}, warnings, stats };
  const floor = Number.isFinite(o) ? o + 15 : 40;
  if (f - 5 < floor) {
    warnings.push(`fist: curl the fingers tighter (fist ${stats.fistP20}° vs open ${stats.openP90}°); kept the fist thresholds`);
    return { thresholds: {}, warnings, stats };
  }
  const enter = clampN(f - 5, 40, HF.CLOSED_ENTER_DEG);
  const exit = clampN(Math.max(floor - 7, enter - 15), 25, enter - 5);
  return { thresholds: { CLOSED_ENTER_DEG: r2(enter, 10), CLOSED_EXIT_DEG: r2(exit, 10) }, warnings, stats };
}

// Gmin from overshoot (contract §4): re-entries per target = the cursor flew past at slow
// speed, so lower the slow gain; no overshoot but slow acquisition = raise it. V_HIGH sets the
// sigmoid's inflection; absGain maps the measured reach half-width onto half the 1460-px canvas.
export function fitGains({ overshootRate = null, acquireMedianMs = null, vHigh = null, reachHalfM = null } = {}, base = {}) {
  const g = { gmin: 1.5, gmax: 6.0, vinf: 0.08, lambda: 40, absGain: 5.84, ...base };
  if (Number.isFinite(overshootRate)) {
    if (overshootRate > 0.5) g.gmin *= 0.75;
    else if (overshootRate > 0.25) g.gmin *= 0.85;
    else if (overshootRate < 0.1 && acquireMedianMs > 1500) g.gmin *= 1.2;
  }
  g.gmin = clampN(g.gmin, 0.8, 3);
  g.gmax = Math.max(g.gmax, 2.5 * g.gmin);
  if (Number.isFinite(vHigh) && vHigh > 0) g.vinf = clampN(0.4 * vHigh, 0.05, 0.15);
  if (Number.isFinite(reachHalfM) && reachHalfM > 0.01) g.absGain = clampN(730 / (reachHalfM * 1000), 3, 12);
  for (const k of Object.keys(g)) g[k] = r2(g[k]);
  return g;
}

// points: landmark 5 image positions; ms: aim.m metres (only spreads used); speeds: m/s.
export function fitReachV2(points, ms = [], speeds = []) {
  const r = reachFromPalms(points, [], { lo: 0.05, hi: 0.95 });
  const xm = ms.map((m) => m[0]);
  const halfM = ms.length >= MIN_REACH_SAMPLES ? (quantile(xm, 0.95) - quantile(xm, 0.05)) / 2 : null;
  const vHigh = speeds.length >= 10 ? quantile(speeds, 0.9) : null;
  return { reach: r.reach, warnings: r.warnings, reachHalfM: r2(halfM, 1000), vHigh: r2(vHigh, 1000) };
}

export function fingerLengthsM(world) {
  if (!Array.isArray(world) || world.length < 21) return null;
  const out = {};
  for (const [name, ch] of Object.entries(FINGER_CHAINS)) {
    let s = 0;
    for (let i = 1; i < ch.length; i++) {
      const a = P(world[ch[i - 1]]);
      const b = P(world[ch[i]]);
      s += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    out[name] = s;
  }
  return out;
}

export const V2_STEP_TEXT = {
  hand: ['Hand', '✋ Hold up one open hand, palm to the camera, and keep still', '✓ Hand measured'],
  reach: ['Reach', '↔ Sweep your finger-gun slowly to every edge you reach easily (elbow can rest)', '✓ Reach saved'],
  hammer: ['Click', '🎯 Aim at the ring and drop your thumb to click it', '✓ Click tuned'],
  pinch: ['Pinch', '🤏 Pinch thumb to index, then open wide', '✓ Pinch tuned'],
  clap: ['Clap', '👏 Clap slowly, starting with your hands wide apart', '✓ Clap tuned'],
  fist: ['Fist', '✊ Close one hand into a fist, then open it', '✓ Grab tuned'],
  summary: ['Done', '✓ Calibrated', '']
};
const V2_ORDER = ['hand', 'reach', 'hammer', 'pinch', 'clap', 'fist', 'summary'];
const V2_ICON = { pinch: '🤏', clap: '👏', fist: '✊' };

function createCalibrationV2({ pointer, rect, features = null, video = null, parent, doc = globalThis.document, storage = defaultStorage(), aspect: aspect0 = null, onDone = () => {}, onCancel = () => {} }) {
  parent ??= doc.body;
  let step = 'idle';
  let quick = false;
  let since = 0;
  let stepMs = 0;
  let lastFrameT = null;
  let pending = null;          // { at, kind: 'target' | 'step' | 'finish', next }
  let warnings = [];
  let startPointer = pointer.profile;
  let startThresholds = { ...(features?.thresholds ?? HF) };
  let saved = loadProfileV2(storage);
  // hand
  let sizes = [], palmPxs = [], palmVid = [], fingers = [], frames = 0, framesWithHand = 0, firstT = null, handLastT = null;
  let light = null, lastLightT = -Infinity;
  // reach
  let reachPts = [], reachM = [], reachV = [], prevM = null, reachFit = null;
  // hammer
  let targets = [], ti = 0, shownAt = 0, inside = false, entries = 0, firstEntryT = null;
  let trials = [], trial = null, drops = 0, hamFrames = [], adapt = null, hammerHits = 0, acquire = [], overshoots = 0;
  // pinch / clap / fist
  let count = 0, pinchClosed = [], pinchOpen = [], pinchState = null, openLevel = 0.6;
  let claps = [], clap = null, prevTwo = null;
  let fistPip = [], openPip = [], fistState = false;
  let result = null;

  // ---- UI: element refs kept directly (no querySelector), eased opacity only (BUGS #14) ----
  const el = (tag, css, text = '') => { const e = doc.createElement(tag); e.style.cssText = css; e.textContent = text; return e; };
  const ease = 'transition:opacity 350ms ease';
  const card = el('div', 'position:fixed;left:50%;top:calc(var(--bar-h, 48px) + 10px);transform:translateX(-50%);z-index:60;width:min(560px,92vw);' +
    'padding:12px 16px;border-radius:12px;background:rgba(8,20,30,.88);border:1px solid rgba(120,200,230,.35);' +
    `color:#d6f3ff;font:14px/1.4 system-ui,sans-serif;opacity:0;${ease};pointer-events:none`);
  card.dataset.role = 'calibration-card';
  card.dataset.v = '2';
  const title = el('div', 'font-weight:600;margin-bottom:4px');
  const body = el('div', 'color:#d6f3ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
  const ticks = el('div', 'margin-top:6px;letter-spacing:4px;font-size:16px;color:#7fd3f0;min-height:20px');
  const track = el('div', 'height:4px;margin-top:8px;border-radius:2px;background:rgba(120,200,230,.18)');
  const bar = el('div', 'height:4px;width:0;border-radius:2px;background:#7fd3f0;transition:width 250ms linear');
  track.append(bar);
  const foot = el('div', 'margin-top:8px;display:flex;gap:8px;justify-content:space-between;align-items:center;font-size:12px;color:#7fa9bb');
  const noteEl = el('span', '');
  const quickBtn = el('button', 'font-size:12px;display:none', '⚡ Quick tune-up');
  quickBtn.dataset.role = 'calibration-quick';
  const skipBtn = el('button', 'font-size:12px', 'Skip (Esc)');
  skipBtn.dataset.role = 'calibration-skip';
  foot.append(noteEl, quickBtn, skipBtn);
  card.append(title, body, ticks, track, foot);
  skipBtn.addEventListener('click', () => api.cancel());
  quickBtn.addEventListener('click', () => { if (step === 'hand') beginDrills(lastFrameT ?? 0); });
  for (const ev of ['pointerdown', 'pointerup']) card.addEventListener(ev, (e) => e.stopPropagation());
  const targetEl = el('div', 'position:fixed;z-index:55;border-radius:50%;border:2px solid #9fe8ff;' +
    `background:rgba(159,232,255,.08);pointer-events:none;opacity:0;${ease};transform:translate(-50%,-50%)`);
  targetEl.dataset.role = 'calibration-target';
  const dotEl = el('div', 'position:fixed;z-index:55;width:12px;height:12px;border-radius:50%;background:#9fe8ff;' +
    `pointer-events:none;opacity:0;${ease};transform:translate(-50%,-50%)`);
  // The visible "target" of the pose drills: a big icon in the middle of the view.
  const iconEl = el('div', 'position:fixed;z-index:55;font-size:72px;line-height:1;pointer-events:none;' +
    `opacity:0;${ease};transform:translate(-50%,-50%)`);
  parent.append(card, targetEl, dotEl, iconEl);

  const setBar = (f) => (bar.style.width = `${Math.round(clampN(f, 0, 1) * 100)}%`);
  const note = (t) => (noteEl.textContent = t);
  const need = () => V2_DRILLS[step] ?? 0;
  const done = () => (step === 'hammer' ? hammerHits : count);
  function drawTicks() {
    const n = need();
    ticks.textContent = n ? '✓'.repeat(done()) + '○'.repeat(Math.max(0, n - done())) : '';
  }
  function viewSize() {
    const r = rect();
    return { left: r.left ?? 0, top: r.top ?? 0, width: r.width || 1, height: r.height || 1 };
  }
  const camAspect = () => aspect0 ?? (video?.videoWidth && video?.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9);

  function sampleLight(t) {
    if (!video?.videoWidth || t - lastLightT < 500) return;
    lastLightT = t;
    try {
      const c = sampleLight.canvas ??= Object.assign(doc.createElement('canvas'), { width: 16, height: 9 });
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(video, 0, 0, 16, 9);
      const d = g.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const luma = sum / (d.length / 4);
      light = light === null ? luma : light * 0.7 + luma * 0.3;
    } catch {
      light = null;
    }
  }

  function go(next, t) {
    step = next;
    since = t;
    stepMs = 0;
    pending = null;
    count = 0;
    const [name, line] = V2_STEP_TEXT[next];
    const k = quick ? V2_ORDER.indexOf(next) - 1 : V2_ORDER.indexOf(next) + 1;
    const of = quick ? V2_ORDER.length - 3 : V2_ORDER.length - 1;
    title.textContent = next === 'summary' ? name : `${k} / ${of} · ${name}`;
    body.textContent = next === 'summary' ? summaryLine() : line;
    quickBtn.style.display = next === 'hand' && saved && !saved.skipped ? '' : 'none';
    setBar(0);
    note('');
    dotEl.style.opacity = next === 'reach' ? '1' : '0';
    targetEl.style.opacity = '0';
    const v = viewSize();
    iconEl.textContent = V2_ICON[next] ?? '';
    iconEl.style.left = `${v.left + v.width / 2}px`;
    iconEl.style.top = `${v.top + v.height / 2}px`;
    iconEl.style.opacity = V2_ICON[next] ? '0.85' : '0';
    if (next === 'hammer') {
      targets = makeTargets(v.width, v.height, V2_DRILLS.hammer, V2_TARGET_RADII_PX);
      ti = 0;
      trials = [];
      showTarget(t);
    }
    drawTicks();
  }

  // ✓ for the step just finished, then the next step after a short beat (no jump-cut).
  function stepDone(t, next) {
    body.textContent = V2_STEP_TEXT[step][2] || body.textContent;
    setBar(1);
    targetEl.style.opacity = '0';
    iconEl.style.opacity = '0';
    pending = { at: t + 600, kind: 'step', next };
  }

  function showTarget(t) {
    const v = viewSize();
    const tg = targets[ti];
    targetEl.style.left = `${v.left + tg.x}px`;
    targetEl.style.top = `${v.top + tg.y}px`;
    targetEl.style.width = targetEl.style.height = `${2 * tg.r}px`;
    targetEl.style.opacity = '1';
    shownAt = t;
    inside = false;
    entries = 0;
    firstEntryT = null;
    trial = { target: tg, frames: [] };
    trials.push(trial);
    note(`target ${ti + 1} of ${targets.length}`);
  }

  function endTarget(t, hit) {
    if (hit) hammerHits++;
    overshoots += Math.max(0, entries - 1);
    if (firstEntryT !== null) acquire.push(firstEntryT - shownAt);
    drawTicks();
    targetEl.style.opacity = '0';
    ti++;
    setBar(ti / targets.length);
    if (ti >= targets.length || hammerHits >= V2_DRILLS.hammer) {
      pending = { at: t + V2_GAP_MS, kind: 'step', next: 'pinch', done: true };
      return;
    }
    pending = { at: t + V2_GAP_MS, kind: 'target' };
  }

  function cursorPx() {
    const st = pointer.state;
    if (st.mode !== 'aim' || st.source !== 'hand') return null;
    const v = viewSize();
    return { x: ((st.x + 1) / 2) * v.width, y: ((1 - st.y) / 2) * v.height };
  }

  function advance(t) {
    if (!pending || t < pending.at) return;
    const p = pending;
    pending = null;
    if (p.kind === 'target') showTarget(t);
    else if (p.kind === 'step') {
      if (p.done) { stepDone(t, p.next); return; } // the hammer's last trial recorded its gap first
      if (p.next === 'finish') finish();
      else go(p.next, t);
    }
  }

  function beginDrills(t) {
    quick = true;
    go('hammer', t);
  }

  const seenHands = (hands) => hands.filter((h) => Array.isArray(h?.landmarks) && h.landmarks.length >= 18);
  const ptsOf = (h) => (Array.isArray(h.rawLandmarks) && h.rawLandmarks.length >= 18 ? h.rawLandmarks : h.landmarks).map(P);
  const gunHand = (hs) => hs.find((h) => h === pointer.state.aimHand) ?? hs.find((h) => h.pointer?.gun === true || h.f?.pose?.label === 'gun') ?? null;
  const pipsOf = (h) => { const p = h.f?.pip; return p && ['index', 'middle', 'ring', 'pinky'].every((k) => Number.isFinite(p[k])) ? [p.index, p.middle, p.ring, p.pinky] : null; };

  function frameHand(hs, t, dt) {
    frames++;
    firstT ??= t;
    handLastT = t;
    sampleLight(t);
    if (!hs.length) return note('no hand in view yet');
    framesWithHand++;
    const h = hs[0];
    const f = h.f;
    if (Number.isFinite(f?.sizeM)) sizes.push(f.sizeM);
    const pts = ptsOf(h);
    palmPxs.push(palmLength(pts, camAspect()));
    palmVid.push(palmLengthPx(pts, video?.videoWidth || 1280, video?.videoHeight || 720));
    const fl = fingerLengthsM(h.worldLandmarks);
    if (fl) fingers.push(fl);
    stepMs += dt;
    setBar(stepMs / V2_HAND_MS);
    note(light !== null && light < DIM_LUMA ? 'the room looks dim · more light helps tracking' : '');
    if (stepMs >= V2_HAND_MS) {
      if (light !== null && light < DIM_LUMA) warnings.push(`dim lighting (mean luma ${Math.round(light)})`);
      stepDone(t, 'reach');
    }
  }

  function frameReach(hs, t, dt) {
    const h = gunHand(hs) ?? hs[0];
    if (!h) { prevM = null; return note('no hand in view'); }
    const pts = ptsOf(h);
    reachPts.push({ x: pts[5].x, y: pts[5].y });
    const m = h.f?.aim?.m;
    if (Array.isArray(m) && Number.isFinite(m[0])) {
      reachM.push(m);
      if (prevM && dt > 0) reachV.push(Math.hypot(m[0] - prevM[0], m[1] - prevM[1]) / (dt / 1000));
      prevM = m;
    }
    const v = viewSize();
    dotEl.style.left = `${v.left + (1 - pts[5].x) * v.width}px`;
    dotEl.style.top = `${v.top + pts[5].y * v.height}px`;
    stepMs += dt;
    setBar(stepMs / V2_REACH_MS);
    note('');
    if (stepMs >= V2_REACH_MS) {
      reachFit = fitReachV2(reachPts, reachM, reachV);
      warnings.push(...reachFit.warnings);
      // Apply now so the hammer targets are reachable with this person's box.
      const g = fitGains({ vHigh: reachFit.vHigh, reachHalfM: reachFit.reachHalfM }, startPointer.cursor ?? {});
      pointer.setProfile({ reach: reachFit.reach ?? undefined, cursor: g });
      stepDone(t, 'hammer');
    }
  }

  // Adaptive drop: the thumb fell ADAPT_DROP_DEG below its 400 ms peak (works whatever the live
  // thresholds are); re-armed once it rises ADAPT_REARM_DEG above the fall's low.
  function adaptiveDrop(deg, t) {
    if (!Number.isFinite(deg)) { adapt = null; return false; }
    adapt ??= { hist: [], armed: true, low: deg };
    adapt.hist.push({ t, deg });
    while (adapt.hist.length && adapt.hist[0].t < t - 400) adapt.hist.shift();
    const peak = Math.max(...adapt.hist.map((p) => p.deg));
    if (!adapt.armed) {
      adapt.low = Math.min(adapt.low, deg);
      if (deg >= adapt.low + ADAPT_REARM_DEG) adapt.armed = true;
      return false;
    }
    if (peak - deg >= ADAPT_DROP_DEG) {
      adapt.armed = false;
      adapt.low = deg;
      return true;
    }
    return false;
  }

  function frameHammer(hs, t) {
    const h = gunHand(hs);
    const c = cursorPx();
    const deg = h ? hammerAngleDeg(h.worldLandmarks) : null;
    const gap = h?.f?.thumbGap;
    if (trial && Number.isFinite(deg) && Number.isFinite(gap)) {
      const fr = { t, deg, gap, cx: c?.x ?? null, cy: c?.y ?? null };
      trial.frames.push(fr);
      hamFrames.push(fr);
    }
    if (pending) return;
    if (!h) note('make the finger-gun (index out, three fingers curled)');
    const tg = targets[ti];
    const now = !!c && Math.hypot(c.x - tg.x, c.y - tg.y) <= tg.r;
    if (now && !inside) { entries++; firstEntryT ??= t; }
    inside = now;
    if (adaptiveDrop(deg, t)) {
      drops++;
      // Judge at the cursor before the fall began (the live click rewinds the same way).
      let at = null;
      for (const fr of trial.frames) if (fr.t >= t - 400 && (!at || fr.deg > at.deg)) at = fr;
      const hit = Number.isFinite(at?.cx) && Math.hypot(at.cx - tg.x, at.cy - tg.y) <= tg.r;
      if (hit) return endTarget(t, true);
    }
    if (t - shownAt >= V2_TARGET_MS) endTarget(t, false);
  }

  function framePinch(hs, t) {
    const withRatio = hs.filter((h) => Number.isFinite(h.f?.pinch?.ratio));
    if (!withRatio.length) return note('show one hand');
    const r = Math.min(...withRatio.map((h) => h.f.pinch.ratio));
    pinchState ??= r < 0.5 * openLevel;
    if (!pinchState) {
      pinchOpen.push(r);
      openLevel = Math.max(0.25, quantile(pinchOpen.slice(-60), 0.8));
      if (r < 0.45 * openLevel) { pinchState = true; count++; drawTicks(); }
    } else {
      pinchClosed.push(r);
      if (r > 0.7 * openLevel) pinchState = false;
    }
    setBar(count / V2_DRILLS.pinch);
    if (count >= V2_DRILLS.pinch && !pinchState) stepDone(t, 'clap');
    else if (t - since >= V2_DRILL_MS) stepDone(t, 'clap');
  }

  function frameClap(hs, t) {
    const two = hs.length >= 2 ? hs.slice(0, 2) : null;
    if (two) {
      const A = camAspect();
      const a = ptsOf(two[0]);
      const b = ptsOf(two[1]);
      const palm = (palmLength(a, A) + palmLength(b, A)) / 2;
      if (palm > 1e-4) {
        const span = Math.hypot((a[0].x - b[0].x) * A, a[0].y - b[0].y) / palm;
        const v = prevTwo && t > prevTwo.t ? ((prevTwo.span - span) * 1000) / (t - prevTwo.t) : 0;
        prevTwo = { t, span };
        clap ??= { hist: [], preMax: 0, minSpan: Infinity, peakV: 0, closing: false };
        clap.hist.push({ t, span });
        while (clap.hist.length && clap.hist[0].t < t - 1200) clap.hist.shift();
        const recentMax = Math.max(...clap.hist.map((p) => p.span));
        if (!clap.closing && recentMax >= 1.6 && span < recentMax - 0.4) {
          clap.closing = true; clap.preMax = recentMax; clap.minSpan = span; clap.peakV = v;
        }
        if (clap.closing) {
          clap.minSpan = Math.min(clap.minSpan, span);
          clap.peakV = Math.max(clap.peakV, v);
          if (span <= 1.3) landClap(t);
          // Opened again without touching: not a clap.
          else if (span > clap.minSpan + 0.6) clap.closing = false;
        }
      }
    } else if (clap?.closing && prevTwo && t - prevTwo.t <= 150 && prevTwo.span < 2.0) {
      landClap(t); // one hand lost at contact (the merge case, Ricky §5)
    } else if (!two) {
      prevTwo = null;
      if (!clap?.closing) note('show both hands');
    }
    setBar(count / V2_DRILLS.clap);
    if (count >= V2_DRILLS.clap || t - since >= V2_DRILL_MS) stepDone(t, 'fist');
  }
  function landClap(t) {
    claps.push({ preMax: clap.preMax, minSpan: clap.minSpan, peakV: clap.peakV, t });
    count++;
    drawTicks();
    clap = { hist: [], preMax: 0, minSpan: Infinity, peakV: 0, closing: false };
    prevTwo = null;
  }

  function frameFist(hs, t) {
    const h = hs.find((x) => pipsOf(x));
    if (!h) return note('show one hand');
    const p = pipsOf(h);
    const closed = h.f?.pose?.label === 'fist' || Math.min(...p) >= 50;
    const open = h.f?.pose?.label === 'open' || Math.max(...p) < 35;
    if (closed) fistPip.push(Math.min(...p));
    else if (open) openPip.push(Math.max(...p));
    if (closed && !fistState) { fistState = true; count++; drawTicks(); }
    else if (open && fistState) fistState = false;
    setBar(count / V2_DRILLS.fist);
    if ((count >= V2_DRILLS.fist && !fistState) || t - since >= V2_DRILL_MS) stepDone(t, 'summary');
  }

  function fitAll() {
    const ham = fitHammer(hamFrames, { drops });
    const pin = fitPinch(pinchClosed, pinchOpen, { pinches: pinchClosed.length ? countOf.pinch : 0 });
    const clp = fitClap(claps);
    const fst = fitFist(fistPip, openPip, { fists: countOf.fist });
    const fitted = { ...ham.thresholds, ...pin.thresholds, ...clp.thresholds, ...fst.thresholds };
    const before = replayHammer(trials, startThresholds);
    const after = replayHammer(trials, { ...startThresholds, ...fitted });
    const withEntry = trials.length;
    const overshootRate = withEntry ? overshoots / withEntry : null;
    const prevGains = quick ? saved?.gains ?? startPointer.cursor ?? {} : null;
    const gains = fitGains({
      overshootRate, acquireMedianMs: quantile(acquire, 0.5),
      vHigh: quick ? null : reachFit?.vHigh, reachHalfM: quick ? null : reachFit?.reachHalfM
    }, prevGains ?? startPointer.cursor ?? {});
    return {
      fitted, gains,
      warnings: [...ham.warnings, ...pin.warnings, ...clp.warnings, ...fst.warnings],
      stats: { hammer: ham.stats, pinch: pin.stats, clap: clp.stats, fist: fst.stats },
      score: { hammer: { before, after }, overshootRate: r2(overshootRate), pinch: countOf.pinch, clap: claps.length, fist: countOf.fist }
    };
  }
  const countOf = { pinch: 0, fist: 0 };

  function summaryLine() {
    const s = result?.score?.hammer;
    return s ? `✓ Calibrated · clicks ${s.before.hits}/${s.before.n} → ${s.after.hits}/${s.after.n}` : '✓ Calibrated';
  }

  function buildProfile(skipped) {
    const fps = firstT !== null && handLastT > firstT ? Math.round(((frames - 1) * 1000) / (handLastT - firstT)) : null;
    const base = quick && saved ? saved : {};
    const fl = {};
    if (fingers.length) for (const k of Object.keys(FINGER_CHAINS)) fl[k] = r2(quantile(fingers.map((f) => f[k]), 0.5), 10000);
    const p = {
      v: 2,
      at: new Date().toISOString(),
      skipped,
      quick,
      sizeM: sizes.length ? r2(quantile(sizes, 0.5), 10000) : base.sizeM ?? null,
      fingersM: fingers.length ? fl : base.fingersM ?? null,
      palmPx: palmPxs.length ? r2(quantile(palmPxs, 0.5), 10000) : base.palmPx ?? null,
      palmVideoPx: palmVid.length ? r2(quantile(palmVid, 0.5), 10) : base.palmVideoPx ?? null,
      fps: fps ?? base.fps ?? null,
      light: light === null ? base.light ?? null : Math.round(light),
      trackRate: frames ? r2(framesWithHand / frames) : base.trackRate ?? null,
      reach: reachFit?.reach ?? base.reach ?? null,
      vHigh: reachFit?.vHigh ?? base.vHigh ?? null,
      thresholds: { ...(base.thresholds ?? {}) },
      gains: base.gains ?? null,
      score: null,
      warnings
    };
    if (result) {
      p.thresholds = { ...p.thresholds, ...result.fitted };
      p.gains = result.gains;
      p.score = result.score;
      p.fit = result.stats;
    } else if (reachFit) {
      p.gains = fitGains({ vHigh: reachFit.vHigh, reachHalfM: reachFit.reachHalfM }, startPointer.cursor ?? {});
    }
    return p;
  }

  function hideAll() {
    card.style.opacity = '0';
    targetEl.style.opacity = '0';
    dotEl.style.opacity = '0';
    iconEl.style.opacity = '0';
    card.style.pointerEvents = 'none';
  }

  function finish() {
    const profile = buildProfile(false);
    step = 'done';
    hideAll();
    applyProfileV2(profile, { pointer, features });
    saveProfileV2(profile, storage);
    onDone(profile);
  }

  const api = {
    v2: true,
    get active() { return step !== 'idle' && step !== 'done'; },
    get step() { return step; },
    get drill() { return V2_DRILLS[step] ? { name: step, done: done(), need: need() } : null; },
    get quick() { return quick; },
    start(t = 0, { quick: q = false } = {}) {
      saved = loadProfileV2(storage);
      startPointer = pointer.profile;
      startThresholds = { ...(features?.thresholds ?? HF) };
      sizes = []; palmPxs = []; palmVid = []; fingers = []; frames = 0; framesWithHand = 0; firstT = null; handLastT = null;
      light = null; lastLightT = -Infinity; lastFrameT = null;
      reachPts = []; reachM = []; reachV = []; prevM = null; reachFit = null;
      trials = []; trial = null; drops = 0; hamFrames = []; adapt = null; hammerHits = 0; acquire = []; overshoots = 0;
      pinchClosed = []; pinchOpen = []; pinchState = null; openLevel = 0.6; countOf.pinch = 0; countOf.fist = 0;
      claps = []; clap = null; prevTwo = null; fistPip = []; openPip = []; fistState = false;
      result = null; warnings = [];
      quick = !!q && !!saved;
      card.style.pointerEvents = 'auto';
      card.style.opacity = '1';
      go(quick ? 'hammer' : 'hand', t);
    },
    cancel() {
      if (!api.active) return;
      step = 'done';
      hideAll();
      // Never let a skip erase a good calibration: restore what was in force at start().
      if (saved && !saved.skipped) {
        applyProfileV2(saved, { pointer, features });
        onCancel(saved);
        return;
      }
      pointer.setProfile({ reach: startPointer.reach, cursor: startPointer.cursor });
      const profile = buildProfile(true);
      saveProfileV2(profile, storage);
      onCancel(profile);
    },
    abort() {
      if (!api.active) return;
      step = 'idle';
      hideAll();
      pointer.setProfile({ reach: startPointer.reach, cursor: startPointer.cursor });
    },
    onFrame(hands, t) {
      if (!api.active) return;
      const dt = lastFrameT === null ? 0 : Math.min(200, Math.max(0, t - lastFrameT));
      lastFrameT = t;
      advance(t);
      if (!api.active) return;
      const hs = seenHands(hands ?? []);
      if (step === 'hammer') return frameHammer(hs, t); // records through the gap too
      if (pending) return;
      if (step === 'hand') frameHand(hs, t, dt);
      else if (step === 'reach') frameReach(hs, t, dt);
      else if (step === 'pinch') { framePinch(hs, t); countOf.pinch = count; }
      else if (step === 'clap') frameClap(hs, t);
      else if (step === 'fist') { frameFist(hs, t); countOf.fist = count; }
      else if (step === 'summary' && !result) {
        result = fitAll();
        warnings.push(...result.warnings);
        body.textContent = summaryLine();
        setBar(1);
        pending = { at: t + V2_SUMMARY_MS, kind: 'step', next: 'finish' };
      }
    },
    // Live hand clicks (pointer v2 hammer, rewound): a ✓ when one lands in the ring.
    onClick(click) {
      if (step !== 'hammer' || pending || !click || click.source !== 'hand' || click.t < shownAt) return;
      const v = viewSize();
      const c = { x: ((click.x + 1) / 2) * v.width, y: ((1 - click.y) / 2) * v.height };
      const tg = targets[ti];
      if (Math.hypot(c.x - tg.x, c.y - tg.y) <= tg.r) { drops++; endTarget(click.t, true); }
    },
    tick(t = 0) {
      if (!api.active) return;
      advance(t);
    },
    dispose() {
      card.remove();
      targetEl.remove();
      dotEl.remove();
      iconEl.remove();
    }
  };
  return api;
}

// ---- Selection practice (A/B) ---------------------------------------------------------------

export const PRACTICE_ROUNDS = [
  { commit: 'hold', targeting: 'point' }, { commit: 'hold', targeting: 'bubble' },
  { commit: 'pinch', targeting: 'point' }, { commit: 'pinch', targeting: 'bubble' },
  { commit: 'other-pinch', targeting: 'point' }, { commit: 'other-pinch', targeting: 'bubble' },
  { commit: 'any', targeting: 'bubble', cluster: true }
];
// Thumb-tap A/B (owner-approved trial 2026-10-01): pass rounds: PRACTICE_ROUNDS_THUMB to
// startPractice. The practice turns the pointer's thumb-tap on for its own rounds only.
export const PRACTICE_ROUNDS_THUMB = [
  ...PRACTICE_ROUNDS.filter((r) => !r.cluster),
  { commit: 'thumb-tap', targeting: 'point' }, { commit: 'thumb-tap', targeting: 'bubble' },
  ...PRACTICE_ROUNDS.filter((r) => r.cluster)
];
const PRACTICE_TARGETS = 6;
// 24 px radius = 48 px across, the hands-mode minimum (HANDS-UX-SPEC §2: webcam thumb drift
// reaches 48 px). It was 18 (36 px), and the owner's 2026-10-01 run scored hold and same-hand
// pinch 0/12 on it. Still smaller than calibration's 44 px rings.
export const PRACTICE_RADIUS_PX = 24;
const PRACTICE_TIMEOUT_MS = 6000;
// Short copy (Cody-U owns the wording; keep these short).
const PRACTICE_COPY = {
  hold: '✋ Hold still on the lit ring · ✓ it fills, then turns',
  pinch: '🤏 Pinch your pointing hand on the lit ring',
  'other-pinch': '🤏 Pinch your other hand on the lit ring',
  'thumb-tap': '👍 Tap your thumb down on your pointing hand on the lit ring',
  any: '🎯 Close targets · select the lit one, any way'
};

export function makeClusterTargets(viewW, viewH, n = PRACTICE_TARGETS, rng = Math.random) {
  // A short random walk: each new centre 30-60 px from the previous one and >= 30 px from all.
  const pts = [{ x: viewW / 2, y: viewH / 2 }];
  for (let guard = 0; pts.length < n && guard < 2000; guard++) {
    const from = pts[Math.floor(rng() * pts.length)];
    const a = rng() * 2 * Math.PI;
    const d = 30 + rng() * 30;
    const p = { x: from.x + d * Math.cos(a), y: from.y + d * Math.sin(a) };
    if (pts.every((q) => Math.hypot(q.x - p.x, q.y - p.y) >= 30)) pts.push(p);
  }
  return pts.map((p) => ({ ...p, r: 12 }));
}

export function rankTargets(targets, cursorPx, bubble = true) {
  if (!cursorPx) return [];
  const out = targets.map((t, i) => {
    const d = Math.hypot(t.x - cursorPx.x, t.y - cursorPx.y);
    const distPx = Math.max(0, d - t.r);
    return { id: i, hit: d <= t.r, distPx, rankPx: distPx === 0 ? 0 : distPx + 0.1 * d, d };
  });
  const hits = out.filter((c) => c.hit).sort((a, b) => a.d - b.d);
  return bubble ? hits.concat(out.filter((c) => !c.hit).sort((a, b) => a.rankPx - b.rankPx)) : hits;
}

export function scoreSelectRound(trials) {
  const ok = trials.filter((t) => t.ok);
  const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  return {
    n: trials.length,
    hits: ok.length,
    misses: trials.length - ok.length,
    falseSelects: trials.reduce((a, t) => a + (t.wrong ?? 0), 0),
    errMedianPx: r1(quantile(ok.map((t) => t.errPx).filter(Number.isFinite), 0.5)),
    timeMedianMs: r1(quantile(ok.map((t) => t.ms).filter(Number.isFinite), 0.5))
  };
}

export function createSelectionPractice({ pointer, rect, parent = document.body, rounds = PRACTICE_ROUNDS, onDone = () => {}, rng = Math.random }) {
  let active = true;
  let ri = -1;
  let spec = null;
  let targets = [];
  let cue = 0;
  let cueAt = 0;
  let trial = null;
  let trials = [];
  let offMode = 0;
  let selector = null;
  let lastT = 0;
  const results = { v: 1, at: new Date().toISOString(), rounds: [] };
  // Thumb-tap rounds switch the pointer's trial click on for themselves only.
  const tapBefore = pointer.thumbTap;
  const setTap = (on) => { if (typeof pointer.setThumbTap === 'function' && pointer.thumbTap !== on) pointer.setThumbTap(on); };

  const card = document.createElement('div');
  card.style.cssText = 'position:fixed;left:50%;top:calc(var(--bar-h, 48px) + 10px);transform:translateX(-50%);z-index:56;padding:8px 14px;' +
    'border-radius:10px;background:rgba(8,20,30,.88);border:1px solid rgba(120,200,230,.35);color:#cfe9f5;' +
    'font:13px system-ui,sans-serif;pointer-events:none;display:flex;align-items:center;gap:12px';
  // A visible way out (BUGS #52: the owner could not leave practice to start the tape; Esc was
  // the only exit and nothing said so). Only the button takes the mouse; the card stays
  // click-through so it never blocks the model.
  const textEl = document.createElement('span');
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.dataset.role = 'practice-stop';
  stopBtn.textContent = '✕ Stop (Esc)';
  stopBtn.title = 'Stop selection practice (Esc or P)';
  stopBtn.style.cssText = 'pointer-events:auto;cursor:pointer;padding:3px 10px;border-radius:7px;' +
    'border:1px solid rgba(120,200,230,.5);background:rgba(120,200,230,.12);color:inherit;font:inherit';
  for (const ev of ['pointerdown', 'pointerup']) stopBtn.addEventListener(ev, (e) => e.stopPropagation());
  card.append(textEl, stopBtn);
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;z-index:55;pointer-events:none';
  parent.append(layer, card);
  let els = [];

  function draw() {
    const v = rect();
    els.forEach((el, i) => {
      const t = targets[i];
      el.style.left = `${v.left + t.x}px`;
      el.style.top = `${v.top + t.y}px`;
      el.style.width = el.style.height = `${2 * t.r}px`;
      // The cue is lit by an eased border/opacity change, never a flash.
      el.style.opacity = i === cue ? '1' : '0.35';
    });
  }

  function beginRound(t) {
    ri++;
    if (ri >= rounds.length) return finish();
    spec = rounds[ri];
    setTap(spec.commit === 'thumb-tap' ? true : tapBefore === true);
    const v = rect();
    targets = spec.cluster
      ? makeClusterTargets(v.width, v.height, PRACTICE_TARGETS, rng)
      : makeTargets(v.width, v.height, PRACTICE_TARGETS, [PRACTICE_RADIUS_PX]);
    selector = createSelector({ bubblePx: spec.targeting === 'bubble' ? BUBBLE_PX : 0 });
    layer.replaceChildren();
    els = targets.map(() => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;border-radius:50%;border:2px solid #9fe8ff;background:rgba(159,232,255,.08);' +
        'transform:translate(-50%,-50%);transition:opacity 300ms ease';
      layer.append(el);
      return el;
    });
    trials = [];
    offMode = 0;
    cue = 0;
    cueAt = t;
    trial = { ok: false, wrong: 0, errPx: null, ms: null };
    textEl.textContent = `${ri + 1} / ${rounds.length} · ${PRACTICE_COPY[spec.commit]}`;
    draw();
  }

  function endTrial(t) {
    trials.push(trial);
    cue++;
    if (cue >= targets.length) {
      results.rounds.push({ commit: spec.commit, targeting: spec.targeting, cluster: !!spec.cluster, ...scoreSelectRound(trials), offMode });
      return beginRound(t);
    }
    cueAt = t;
    trial = { ok: false, wrong: 0, errPx: null, ms: null };
    draw();
  }

  function select(id, cursorPx, t) {
    if (id === null || id === undefined) return; // nothing under the cursor: neither hit nor false
    if (id === cue) {
      const tg = targets[cue];
      trial.ok = true;
      trial.errPx = cursorPx ? Math.round(Math.hypot(cursorPx.x - tg.x, cursorPx.y - tg.y) * 10) / 10 : null;
      trial.ms = Math.round(t - cueAt);
      endTrial(t);
    } else {
      trial.wrong++;
    }
  }

  const cursorPx = () => {
    const st = pointer.state;
    if (st.mode !== 'aim') return null;
    const v = rect();
    return { x: ((st.x + 1) / 2) * v.width, y: ((1 - st.y) / 2) * v.height };
  };

  function finish() {
    active = false;
    setTap(tapBefore === true);
    layer.remove();
    card.remove();
    if (globalThis.hologram) globalThis.hologram.selectionPractice = results;
    onDone(results);
  }

  const api = {
    get active() { return active; },
    get round() { return spec ? { index: ri, ...spec } : null; },
    get results() { return results; },
    get cue() { return cue; },          // index of the lit target in this round
    get targets() { return targets; },  // this round's targets, CSS px in rect()
    start(t = performance.now()) { lastT = t; beginRound(t); },
    onFrame(t = performance.now()) {
      if (!active || !spec) return;
      lastT = t;
      const c = cursorPx();
      const s = selector.update({
        candidates: rankTargets(targets, c, spec.targeting === 'bubble'),
        cursorPx: c,
        t,
        canHold: (spec.commit === 'hold' || spec.commit === 'any') && pointer.state.source === 'hand' && !pointer.state.frozen
      });
      if (s.fired) select(s.fired.id, c, t);
      else if (t - cueAt >= PRACTICE_TIMEOUT_MS) endTrial(t);
      return s; // the hold ring to draw (visibleProgress)
    },
    onClick(click) {
      if (!active || !spec || !click) return;
      if (spec.commit !== 'any' && click.via !== spec.commit) { offMode++; return; }
      const v = rect();
      const at = { x: ((click.x + 1) / 2) * v.width, y: ((1 - click.y) / 2) * v.height };
      selector.block(at);
      const ranked = rankTargets(targets, at, spec.targeting === 'bubble').filter((c) => c.hit || c.distPx <= BUBBLE_PX);
      // Bubble: keep the hovered target if it is still in reach (hysteresis), as the runtime does.
      const keep = spec.targeting === 'bubble' ? ranked.find((c) => c.id === selector.current) : null;
      select((keep || ranked[0])?.id ?? null, at, click.t ?? lastT);
    },
    cancel() {
      if (!active) return;
      if (spec && trials.length) results.rounds.push({ commit: spec.commit, targeting: spec.targeting, cluster: !!spec.cluster, ...scoreSelectRound(trials), offMode, cancelled: true });
      finish();
    },
    dispose() {
      if (active) setTap(tapBefore === true);
      active = false;
      layer.remove();
      card.remove();
    }
  };
  stopBtn.addEventListener('click', () => api.cancel());
  return api;
}

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

export function applyProfile(profile, { pointer, engagement }) {
  if (!profile) return;
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

export function createCalibration({ pointer, engagement, rect, video = null, parent = document.body, storage = defaultStorage(), onDone = () => {}, onCancel = () => {} }) {
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

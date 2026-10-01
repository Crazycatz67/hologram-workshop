// Pointer lab ("finger gun"): diagnose and calibrate the aiming pose, and measure the click.
//
// History: the 2026-09-30 version asked "is a thumb drop steady enough to be a click?". The
// owner's live run on 2026-10-01 (MacBook webcam, 1280x720, 49 fps) answered it: the
// other-hand pinch is the click, and the thumb is no longer a trigger. The same run showed the
// pose itself was recognised on 0% of frames, with no record of which check rejected it.
//
// This version answers three questions on a real webcam, in about 1.5 minutes:
//   (1) WHY does the pointer pose fail on a real hand? Per step: a histogram of isGun's
//       rejection reasons (first reason and every failed reason), and p10/median/p90 of every
//       feature gunPose.js measures, side-on vs aimed at the camera.
//   (2) WHAT thresholds would work? From 5 s holds of pointer side-on, pointer at the camera,
//       a relaxed open hand and a fist, suggest thresholds that separate the pointer from the
//       open hand and the fist, print them as constants to paste into gunPose.js, and let the
//       page apply them live (never written to gunPose.js by the page).
//   (3) Does the CLICK (pinch with the OTHER hand) move the aiming hand? Palm-centroid shift
//       of the aiming hand per other-hand pinch, against a do-nothing baseline from the holds.
//
// Two kinds of hand motion are reported, and must not be confused:
//   drift  = RMS distance of the palm centroid from its mean over a whole 5 s hold. Mostly
//            slow wandering of the arm; the old page called this "jitter".
//   jitter = frame-to-frame centroid displacement (median and p90 over consecutive frames,
//            frames more than 100 ms apart are not paired). Tracking noise plus tremor.
//
// Units: px are video pixels; "frame units" (fu) are px / video height, i.e. the same
// aspect-corrected normalized distance gestures.js uses. 0.01 fu = 7.2 px at 720p.
// Centroid numbers are reported on the SMOOTHED landmarks (smoothLandmarks.js, what the app
// would aim with) and on the RAW ones for reference. Pose features use raw worldLandmarks
// (smoothLandmarks.js only filters the 2D landmarks).
//
// The page also runs a synthetic self-test of gunPose.js and of this file's statistics and
// calibration on load (no camera). Those checks belong in test.js; they live here because
// test.js is owned by other agents.
//
// Photosafety (BUGS #14): nothing on this page flashes. State badges change colour only on a
// state change, with a 180 ms fade and low-contrast fills.
//
// Reuses camera.js, handTracker.js, smoothLandmarks.js, gestures.js and overlay.js read-only.
// handTracker.js is imported lazily, on "start camera": it pulls MediaPipe from a CDN at module
// load, and the self-test must work offline (and under Node).

// Propagate the page's cache-busting stamp to every sibling import (same reason as hands.js).
const V = new URL(import.meta.url).search;
const ROOT = '../../../';
const gp = await import(`${ROOT}gunPose.js${V}`);
const { gunFeatures, isGun, thumbState, GUN_DEFAULTS } = gp;
const { pinch, isFistLike, isFistShape, PINCH_THRESHOLD } = await import(`${ROOT}gestures.js${V}`);

// ---- decision rule -----------------------------------------------------------------------
// READY to wire the pointer + other-hand-pinch click only if ALL hold:
//  - pointer recognised on >= 80% of still frames side-on AND aimed at the camera;
//  - pointer recognised on <= 5% of open-hand frames and of fist frames (false positives);
//  - at least 4 of 5 other-hand pinches detected;
//  - aiming hand's palm-centroid shift per pinch: median <= 0.015 fu (~11 px at 720p, about
//    half a small on-screen target) and p90 <= 0.03 fu (an occasional big jerk is what users
//    notice). Same limits the thumb-drop probe used, so the two runs compare directly.
export const RULE = {
  minGunHoldPct: 80,
  maxFalsePct: 5,
  minPinches: 4,
  maxMedianShiftFu: 0.015,
  maxP90ShiftFu: 0.03
};

const EVENT_TAIL_MS = 250;     // keep measuring this long after a pinch is detected
const LOOKBACK_MS = 800;       // how far back to search for the start of the motion
const BUFFER_MS = 1600;
const MAX_STEP_GAP_MS = 100;   // frame-to-frame jitter only pairs frames closer than this
const AIM_FORGET_MS = 300;     // after this long without two hands, re-pick the aiming hand
const MIN_CAL_FRAMES = 30;     // fewer frames than this in a class -> that class is "no data"
const PALM_IDS = [0, 5, 9, 13, 17];

// Every feature whose distribution is reported per step. Dotted paths into gunFeatures().
export const FEATURE_KEYS = [
  'index.pipDeg', 'index.dipDeg', 'index.reach',
  'middle.pipDeg', 'middle.reach', 'ring.pipDeg', 'ring.reach', 'pinky.pipDeg', 'pinky.reach',
  'curledCount', 'separation', 'thumbGap',
  'indexBendDeg', 'othersMinPipDeg', 'othersMaxReach'
];
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
export const REASONS = ['no-hand', 'label', 'index-bent', 'index-short', 'curl-pip', 'curl-reach', 'no-separation'];
const reasonKey = (r) => (r.startsWith('label:') ? 'label' : r);

// ---- calibration spec ----------------------------------------------------------------------
// One row per numeric threshold in gunPose.js. `feature` is the single number isGun compares;
// `pointer` says which side of the threshold a pointer must be on; `against` is the class the
// check exists to reject (open hands are rejected by the curl checks, fists by the index
// checks, both by separation). `margin` is in the feature's own unit.
export const CAL_SPEC = [
  { key: 'indexBendMaxDeg', constant: 'INDEX_BEND_MAX_DEG', feature: 'indexBendDeg', pointer: 'below', against: ['fist'], margin: 5, decimals: 0 },
  { key: 'indexReachMin', constant: 'INDEX_REACH_MIN', feature: 'index.reach', pointer: 'above', against: ['fist'], margin: 0.05, decimals: 2 },
  { key: 'curlBendMinDeg', constant: 'CURL_BEND_MIN_DEG', feature: 'othersMinPipDeg', pointer: 'above', against: ['open'], margin: 5, decimals: 0 },
  { key: 'curlReachMax', constant: 'CURL_REACH_MAX', feature: 'othersMaxReach', pointer: 'below', against: ['open'], margin: 0.05, decimals: 2 },
  { key: 'separationMin', constant: 'INDEX_SEPARATION_MIN', feature: 'separation', pointer: 'above', against: ['open', 'fist'], margin: 0.05, decimals: 2 }
];
// A default veto label seen on more than this share of pointer frames is dropped from the
// suggestion: on 2026-10-01 a held side-on pointer was labelled Open_Palm on 28% of frames.
const VETO_DROP_PCT = 5;

// ======================================================================================
// Synthetic hands (world landmarks, metres) for the self-test
// ======================================================================================
// Palm in the x-y plane, fingers along +y, flexion curls toward -z. Rough adult proportions:
// palm (wrist->middle MCP) 9 cm. Thumb poses are hand-placed: cocked = an L to the radial side,
// dropped = tip resting against the side of the index's middle bone.
const MCP = { index: [0.03, 0.085, 0], middle: [0.008, 0.09, 0], ring: [-0.012, 0.085, 0], pinky: [-0.03, 0.075, 0] };
const BONES = { index: [0.04, 0.025, 0.02], middle: [0.045, 0.028, 0.02], ring: [0.042, 0.026, 0.02], pinky: [0.032, 0.02, 0.018] };
const THUMB_COCKED = [[0.02, 0.02, -0.005], [0.05, 0.045, -0.015], [0.075, 0.06, -0.015], [0.095, 0.07, -0.015]];
const THUMB_DROPPED = [[0.02, 0.02, -0.005], [0.045, 0.05, -0.015], [0.05, 0.08, -0.018], [0.045, 0.105, -0.015]];
const STRAIGHT = [0, 0, 0];
const CURLED = [80, 100, 60];

function rotate([x, y, z], [rx, ry, rz]) {
  const r = (d) => (d * Math.PI) / 180;
  let c = Math.cos(r(rx)), s = Math.sin(r(rx));
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(r(ry)); s = Math.sin(r(ry));
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(r(rz)); s = Math.sin(r(rz));
  [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

// spec: { index, middle, ring, pinky: [mcp, pip, dip] flexion degrees; thumb: 0 = cocked ..
//         1 = dropped (linear blend); rot: [rx, ry, rz] degrees; scale; offset: [x,y,z] }
export function buildWorldHand(spec = {}) {
  const { thumb = 0, rot = [0, 0, 0], scale = 1, offset = [0, 0, 0] } = spec;
  const pts = Array.from({ length: 21 }, () => [0, 0, 0]);
  for (let k = 0; k < 4; k++) {
    pts[1 + k] = THUMB_COCKED[k].map((v, a) => v + (THUMB_DROPPED[k][a] - v) * thumb);
  }
  const names = ['index', 'middle', 'ring', 'pinky'];
  names.forEach((name, f) => {
    const base = 5 + f * 4;
    const flex = spec[name] ?? STRAIGHT;
    let p = MCP[name].slice();
    pts[base] = p;
    let theta = 0;
    for (let b = 0; b < 3; b++) {
      theta += (flex[b] * Math.PI) / 180;
      const l = BONES[name][b];
      p = [p[0], p[1] + l * Math.cos(theta), p[2] - l * Math.sin(theta)];
      pts[base + b + 1] = p;
    }
  });
  return pts.map((q) => {
    const [x, y, z] = rotate(q.map((v) => v * scale), rot);
    return { x: x + offset[0], y: y + offset[1], z: z + offset[2] };
  });
}

// Orthographic projection to normalized image landmarks (x right, y down), palm ~0.12 of the
// frame height, so gestures.js can be asked what TODAY's code would make of the same hand.
export function projectToImage(world, aspect = 16 / 9) {
  const k = 0.12 / 0.09;
  return world.map((p) => ({ x: 0.5 + (p.x * k) / aspect, y: 0.55 - p.y * k, z: p.z * k }));
}

const GUN = { index: STRAIGHT, middle: CURLED, ring: CURLED, pinky: CURLED };
// Side-on: the camera sees the hand from the thumb side (palm turned 90 deg away).
const SIDE_ON = [0, 90, 90];
// Aimed at the camera: the index direction (+y) turned toward the viewer (-z). Exactly
// 90 deg collapses the palm to a point in 2D, so the 2D collision rows use 60 deg (a real
// hand pointing "at" the lens is rarely dead-on); the 3D invariance checks use the full 90.
const AT_CAMERA = [-90, 0, 0];
const TOWARD_CAMERA = [-60, 0, 0];

// Small seeded PRNG so the noisy synthetic classes are the same on every load.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// n noisy synthetic frames of one class, as {f, label} like the live recorder stores.
function synthClass(kind, n, seed, rot = [0, 0, 0]) {
  const R = rng(seed);
  const jit = (arr, d) => arr.map((v) => Math.max(0, v + (R() * 2 - 1) * d));
  const out = [];
  for (let i = 0; i < n; i++) {
    const relaxed = () => jit([8, 10, 8], 8);
    const curl = () => jit(CURLED, 15);
    const spec = kind === 'pointer' ? { index: jit([5, 8, 5], 8), middle: curl(), ring: curl(), pinky: curl() }
      : kind === 'open' ? { index: relaxed(), middle: relaxed(), ring: relaxed(), pinky: relaxed() }
        : { index: curl(), middle: curl(), ring: curl(), pinky: curl() };
    spec.thumb = R();
    spec.rot = rot.map((v) => v + (R() * 2 - 1) * 10);
    out.push({ f: gunFeatures(buildWorldHand(spec)), label: 'None' });
  }
  return out;
}

// ======================================================================================
// Statistics helpers (exported for the self-test and for re-analysis of a pasted JSON)
// ======================================================================================
export function quantile(arr, q) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo);
}
const median = (a) => quantile(a, 0.5);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);
const roundTo = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const pct = (n, of) => (of ? Math.round((100 * n) / of) : null);

export function spread(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? { p10: r3(quantile(v, 0.1)), median: r3(median(v)), p90: r3(quantile(v, 0.9)), n: v.length } : null;
}

function centroidPx(lm, W, H) {
  let x = 0, y = 0;
  for (const i of PALM_IDS) { x += lm[i].x; y += lm[i].y; }
  return { x: (x / PALM_IDS.length) * W, y: (y / PALM_IDS.length) * H };
}
const dpx = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// drift: RMS distance from the mean position over the whole track, px.
export function driftPx(points) {
  if (points.length < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  return Math.sqrt(points.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / points.length);
}

// jitter: frame-to-frame displacement over consecutive samples. track: [{t, x, y}] in time
// order; pairs further apart than MAX_STEP_GAP_MS (a lost frame, a hand leaving) are skipped,
// so a gap never counts as one huge step.
export function frameJitter(track, H) {
  const steps = [];
  for (let i = 1; i < track.length; i++) {
    if (track[i].t - track[i - 1].t <= MAX_STEP_GAP_MS) steps.push(dpx(track[i], track[i - 1]));
  }
  if (!steps.length) return null;
  const m = median(steps), p90 = quantile(steps, 0.9);
  return { medianPx: r3(m), p90Px: r3(p90), medianFu: r4(m / H), p90Fu: r4(p90 / H), steps: steps.length };
}

// Do-nothing baseline for the click: median over all start frames of the largest centroid
// excursion within the next `ms`, i.e. how far a still-held hand wanders anyway in the time
// a pinch event is measured over. track: [{t, x, y}], px.
export function windowShiftPx(track, ms) {
  const out = [];
  for (let i = 0; i < track.length; i++) {
    let m = 0, j = i + 1;
    for (; j < track.length && track[j].t - track[i].t <= ms; j++) m = Math.max(m, dpx(track[j], track[i]));
    if (j < track.length || track.at(-1).t - track[i].t >= ms) out.push(m);
  }
  return out.length ? median(out) : null;
}

// Two hands in view during the click step: which one aims and which one pinches. Once an
// aiming hand is known, follow it by position (hands do not swap places mid-gesture, but
// MediaPipe's handedness labels sometimes do). Fresh pick: the only pointer hand if exactly
// one is recognised, else the hand whose thumb and index are further apart.
// hands: [{ c: {x, y}, gun: bool, pinchRatio: number }] -> { aim, pinch } indices, or null.
export function pickAimAndPinch(hands, prevAimC = null) {
  if (hands.length < 2) return null;
  let aim;
  if (prevAimC) {
    aim = hands.reduce((best, h, i) => (dpx(h.c, prevAimC) < dpx(hands[best].c, prevAimC) ? i : best), 0);
  } else {
    const guns = hands.map((h, i) => (h.gun ? i : -1)).filter((i) => i >= 0);
    aim = guns.length === 1 ? guns[0] : hands.reduce((best, h, i) => (h.pinchRatio > hands[best].pinchRatio ? i : best), 0);
  }
  let pin = -1;
  hands.forEach((h, i) => { if (i !== aim && (pin < 0 || h.pinchRatio < hands[pin].pinchRatio)) pin = i; });
  return { aim, pinch: pin };
}

// ======================================================================================
// Calibration
// ======================================================================================
// classes: { side, camera, open, fist }, each [{ f: GunFeatures|null, label }].
// Returns { thresholds, rows, veto, rates: { current, suggested }, frames, warnings, snippet,
//   suggestedPass }. Threshold per row: midpoint between the pointer's edge (p90 if a pointer
// must be below, p10 if above) and the rejected class's facing edge (its p10 / p90). Status:
// 'clean' if the gap is at least 2 x margin, 'tight' if positive but smaller, 'overlap' if the
// classes overlap: then the threshold sits `margin` beyond the pointer's edge, keeping the
// pointer and leaving the rejection to the other checks (the rates table shows if that works).
// Fitted and scored on the same frames, so the suggested rates are optimistic; the page says so.
export function suggestThresholds(classes, current = GUN_DEFAULTS) {
  const cur = { ...GUN_DEFAULTS, ...current };
  const ok = (arr) => (arr ?? []).filter((x) => x && x.f);
  const C = { side: ok(classes.side), camera: ok(classes.camera), open: ok(classes.open), fist: ok(classes.fist) };
  const pointer = [...C.side, ...C.camera];
  const frames = Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v.length]));
  const warnings = [];
  const enough = (k) => (k === 'pointer' ? pointer.length >= MIN_CAL_FRAMES : C[k].length >= MIN_CAL_FRAMES);
  for (const k of ['side', 'camera', 'open', 'fist']) {
    if (C[k].length < MIN_CAL_FRAMES) warnings.push(`${k}: only ${C[k].length} frames with world landmarks (need ${MIN_CAL_FRAMES}); its rows keep the current value.`);
  }

  const thresholds = { ...cur };
  const rows = CAL_SPEC.map((s) => {
    const val = (arr) => arr.map((x) => getPath(x.f, s.feature));
    const other = s.against.flatMap((k) => C[k]);
    const row = { key: s.key, constant: s.constant, feature: s.feature, pointerMust: s.pointer, against: s.against.join('+'),
      current: cur[s.key], pointer: spread(val(pointer)), other: spread(val(other)), suggested: cur[s.key], gap: null, status: 'no data' };
    if (!enough('pointer') || !s.against.every(enough)) return row;
    const below = s.pointer === 'below';
    const pEdge = quantile(val(pointer), below ? 0.9 : 0.1);
    const oEdge = quantile(val(other), below ? 0.1 : 0.9);
    const gap = below ? oEdge - pEdge : pEdge - oEdge;
    let v;
    if (gap > 0) {
      v = (pEdge + oEdge) / 2;
      row.status = gap >= 2 * s.margin ? 'clean' : 'tight';
    } else {
      v = below ? pEdge + s.margin : pEdge - s.margin;
      row.status = 'overlap';
    }
    row.gap = r3(gap);
    row.suggested = roundTo(v, s.decimals);
    thresholds[s.key] = row.suggested;
    return row;
  });

  // Veto labels: keep a default veto only if real pointer frames rarely carry it.
  const labelPct = {};
  for (const x of pointer) labelPct[x.label] = (labelPct[x.label] || 0) + 1;
  for (const k of Object.keys(labelPct)) labelPct[k] = pct(labelPct[k], pointer.length);
  const vetoLabels = pointer.length >= MIN_CAL_FRAMES ? cur.vetoLabels.filter((l) => (labelPct[l] ?? 0) <= VETO_DROP_PCT) : cur.vetoLabels;
  thresholds.vetoLabels = vetoLabels;
  const veto = { current: cur.vetoLabels, suggested: vetoLabels, pointerLabelPct: labelPct,
    dropped: cur.vetoLabels.filter((l) => !vetoLabels.includes(l)) };

  const rateOf = (arr, T) => pct(arr.filter((x) => isGun(x.f, { gesture: x.label, thresholds: T }).gun).length, arr.length);
  const ratesFor = (T) => ({ side: rateOf(C.side, T), camera: rateOf(C.camera, T), open: rateOf(C.open, T), fist: rateOf(C.fist, T) });
  const rates = { current: ratesFor(cur), suggested: ratesFor(thresholds) };
  const s = rates.suggested;
  const suggestedPass = [s.side, s.camera, s.open, s.fist].every((v) => v != null) &&
    s.side >= RULE.minGunHoldPct && s.camera >= RULE.minGunHoldPct && s.open <= RULE.maxFalsePct && s.fist <= RULE.maxFalsePct;

  const snippet = [
    `// gunPose.js thresholds calibrated ${new Date().toISOString().slice(0, 10)} (gun-lab calibrate; side ${frames.side} / camera ${frames.camera} / open ${frames.open} / fist ${frames.fist} frames)`,
    ...CAL_SPEC.map((sp) => `export const ${sp.constant} = ${thresholds[sp.key]};`),
    `export const GUN_VETO_LABELS = ${JSON.stringify(vetoLabels).replace(/,/g, ', ')};`
  ].join('\n');

  return { thresholds, rows, veto, rates, frames, warnings, snippet, suggestedPass };
}

// ======================================================================================
// Synthetic self-test
// ======================================================================================
export function runSelfTest() {
  const rows = [];
  const check = (name, pass, detail = '') => rows.push({ name, pass: !!pass, detail });
  const info = (name, detail) => rows.push({ name, pass: null, detail });
  const f = (spec) => gunFeatures(buildWorldHand(spec));
  const fmt = (x) => JSON.stringify(x);

  // The pose: no thumb condition. Thumb anywhere from up to resting on the index.
  const thumbs = [0, 0.25, 0.5, 0.75, 1];
  const onAll = thumbs.map((t) => isGun(f({ ...GUN, thumb: t }), { gesture: 'None' }));
  check('pointer is on for every thumb position (thumb up .. resting on the index)', onAll.every((r) => r.gun), onAll.map((r) => r.rejectedBy ?? 'on').join(','));
  const cocked = f({ ...GUN, thumb: 0 });
  const dropped = f({ ...GUN, thumb: 1 });
  check('pointer passes with an empty failed list', isGun(cocked).failed.length === 0, fmt(isGun(cocked)));
  check('pointer side-on and aimed at the camera: on', isGun(f({ ...GUN, rot: SIDE_ON })).gun && isGun(f({ ...GUN, rot: AT_CAMERA })).gun);

  // Thumb state is a diagnostic now; keep it honest.
  check('(diagnostic) thumbState reads up as cocked, resting as dropped',
    thumbState(cocked).state === 'cocked' && thumbState(dropped, 'cocked').state === 'dropped',
    `gap ${cocked.thumbGap} / ${dropped.thumbGap}`);
  const walk = [0, 0.5, 1, 0.5, 0];
  let prev = 'unknown';
  const states = walk.map((t) => (prev = thumbState(f({ ...GUN, thumb: t }), prev).state)).join(',');
  check('(diagnostic) thumbState hysteresis keeps the previous state mid-band', states === 'cocked,cocked,dropped,dropped,cocked', states);

  // Rejections, with EVERY failed check listed (that is what the live histogram counts).
  const has = (r, ...k) => k.every((x) => r.failed.includes(x));
  const open = isGun(f({}));
  check('open hand: not a pointer; failed lists curl-pip, curl-reach and no-separation', !open.gun && has(open, 'curl-pip', 'curl-reach', 'no-separation'), fmt(open.failed));
  const fist = isGun(f({ index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED }));
  check('fist: not a pointer; failed lists index-bent and index-short', !fist.gun && has(fist, 'index-bent', 'index-short') && fist.rejectedBy === 'index-bent', fmt(fist.failed));
  const peace = isGun(f({ index: STRAIGHT, middle: STRAIGHT, ring: CURLED, pinky: CURLED }), { gesture: 'None' });
  check('peace sign (label None): not a pointer', !peace.gun, fmt(peace.failed));
  const hook = isGun(f({ ...GUN, index: [10, 60, 40] }));
  check('hooked index: not a pointer (index-bent)', !hook.gun && hook.rejectedBy === 'index-bent', fmt(hook.failed));
  for (const label of ['Victory', 'Closed_Fist']) {
    check(`label ${label} vetoes a perfect pointer`, isGun(cocked, { gesture: label }).rejectedBy === `label:${label}`);
  }
  check('label Thumb_Up does NOT veto (live: pointer at the camera reads Thumb_Up)', isGun(cocked, { gesture: 'Thumb_Up' }).gun);
  check('label Open_Palm does NOT veto (calibrated 2026-10-01: side-on pointers carry it)', isGun(cocked, { gesture: 'Open_Palm' }).gun);
  const sup = isGun(cocked, { gesture: 'Pointing_Up' });
  check('label Pointing_Up supports but does not decide', sup.gun && sup.supported && !isGun(f({}), { gesture: 'Pointing_Up' }).gun);
  const label2 = isGun(f({}), { gesture: 'Closed_Fist' });
  check('label veto is listed alongside the geometry failures', label2.rejectedBy === 'label:Closed_Fist' && has(label2, 'curl-pip'), fmt(label2.failed));

  // Threshold overrides (what the calibrate step applies live).
  check('override: vetoLabels [] lets a Victory-labelled pointer through', isGun(cocked, { gesture: 'Victory', thresholds: { vetoLabels: [] } }).gun);
  check('override: indexReachMin 5 rejects as index-short, other defaults kept',
    fmt(isGun(cocked, { thresholds: { indexReachMin: 5 } }).failed) === '["index-short"]');
  check('override: gunFeatures curledCount follows the thresholds passed',
    cocked.curledCount === 3 && gunFeatures(buildWorldHand(GUN), { curlBendMinDeg: 179 }).curledCount === 0);
  check('default thresholds are the named constants', GUN_DEFAULTS.indexBendMaxDeg === gp.INDEX_BEND_MAX_DEG &&
    GUN_DEFAULTS.separationMin === gp.INDEX_SEPARATION_MIN && GUN_DEFAULTS.vetoLabels === gp.GUN_VETO_LABELS);

  // Invariance: moving, turning or scaling the hand must not change a single feature.
  const close = (a, b) => {
    const flat = (o, p = '', acc = {}) => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') flat(v, `${p}${k}.`, acc);
        else acc[p + k] = v;
      }
      return acc;
    };
    const A = flat(a), B = flat(b);
    let worst = ['', 0];
    for (const k of Object.keys(A)) {
      if (k === 'palmM') continue; // palm is metres, it scales on purpose
      if (typeof A[k] !== 'number') { if (A[k] !== B[k]) worst = [k, Infinity]; continue; }
      const tol = /Deg$/.test(k) ? 0.2 : 0.002;
      const d = Math.abs(A[k] - B[k]) / tol;
      if (d > worst[1]) worst = [k, d];
    }
    return { ok: worst[1] <= 1, worst };
  };
  for (const [name, extra] of [
    ['scale x0.8', { scale: 0.8 }], ['scale x1.3', { scale: 1.3 }],
    ['moved 20 cm', { offset: [0.2, -0.1, 0.15] }],
    ['side-on', { rot: SIDE_ON }],
    ['aimed at the camera', { rot: AT_CAMERA }],
    ['turned 37/-52/115 deg', { rot: [37, -52, 115] }]
  ]) {
    const r = close(f(GUN), f({ ...GUN, ...extra }));
    check(`features invariant under ${name}`, r.ok, r.ok ? '' : `worst ${r.worst[0]} off by ${r.worst[1].toFixed(2)} tol`);
  }

  // Bad input never throws and never yields NaN.
  check('null / short / NaN input -> null features, no-hand, unknown thumb',
    gunFeatures(null) === null && gunFeatures([]) === null &&
    gunFeatures(buildWorldHand().map((p, i) => (i === 3 ? { x: NaN, y: 0, z: 0 } : p))) === null &&
    thumbState(null, 'cocked').state === 'unknown' && isGun(null).rejectedBy === 'no-hand');
  check('zero-size hand -> null features', gunFeatures(Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }))) === null);

  // Drift vs jitter: a hand gliding 30 px in 5 s at 50 fps has big drift but tiny jitter;
  // the same hand with +-2 px per-frame noise has jitter of a pixel or two.
  const glide = Array.from({ length: 250 }, (_, i) => ({ t: i * 20, x: 100 + i * 0.12, y: 200 }));
  const R = rng(7);
  const noisy = glide.map((p) => ({ ...p, x: p.x + (R() * 4 - 2), y: p.y + (R() * 4 - 2) }));
  const jg = frameJitter(glide, 720), jn = frameJitter(noisy, 720);
  check('drift vs jitter: slow 30 px glide -> drift ~8.7 px, jitter ~0.12 px/frame',
    Math.abs(driftPx(glide) - 8.66) < 0.1 && Math.abs(jg.medianPx - 0.12) < 0.005, `drift ${r3(driftPx(glide))} px, jitter median ${jg.medianPx} px`);
  check('drift vs jitter: +-2 px noise -> jitter median 1-3 px, p90 above median', jn.medianPx > 1 && jn.medianPx < 3 && jn.p90Px > jn.medianPx, fmt(jn));
  const gappy = [{ t: 0, x: 0, y: 0 }, { t: 20, x: 1, y: 0 }, { t: 500, x: 300, y: 0 }, { t: 520, x: 301, y: 0 }];
  check('jitter skips pairs more than 100 ms apart (a lost hand is not a 299 px step)', frameJitter(gappy, 720).steps === 2 && frameJitter(gappy, 720).p90Px === 1);
  check('do-nothing baseline: steady 0.12 px/frame glide over 300 ms -> ~1.8 px', Math.abs(windowShiftPx(glide, 300) - 1.8) < 0.01, r3(windowShiftPx(glide, 300)));

  // Aiming / pinching hand assignment for the click step.
  const hA = { c: { x: 300, y: 300 }, gun: false, pinchRatio: 1.2 }, hB = { c: { x: 900, y: 320 }, gun: false, pinchRatio: 0.1 };
  check('click step: fresh pick aims with the hand whose thumb-index gap is wider', fmt(pickAimAndPinch([hB, hA])) === '{"aim":1,"pinch":0}');
  check('click step: an only-pointer hand is the aiming hand', pickAimAndPinch([{ ...hA, pinchRatio: 0.05 }, { ...hB, gun: true, pinchRatio: 2 }]).aim === 1);
  check('click step: once known, the aiming hand is followed by position',
    pickAimAndPinch([{ ...hB, pinchRatio: 3 }, hA], { x: 310, y: 305 }).aim === 1 && pickAimAndPinch([hA]) === null);

  // Calibration on noisy synthetic classes: must find thresholds that separate them, and
  // must say so plainly when two classes cannot be separated.
  const syn = {
    side: synthClass('pointer', 60, 1, SIDE_ON), camera: synthClass('pointer', 60, 2, AT_CAMERA),
    open: synthClass('open', 60, 3), fist: synthClass('fist', 60, 4)
  };
  const cal = suggestThresholds(syn);
  const rs = cal.rates.suggested;
  check('calibrate (synthetic): suggested thresholds keep >= 95% pointer, <= 2% open/fist',
    rs.side >= 95 && rs.camera >= 95 && rs.open <= 2 && rs.fist <= 2 && cal.suggestedPass, fmt(rs));
  check('calibrate (synthetic): every row separable (clean or tight)', cal.rows.every((r) => r.status === 'clean' || r.status === 'tight'),
    cal.rows.map((r) => `${r.key}=${r.suggested}(${r.status})`).join(' '));
  check('calibrate: snippet carries every constant',
    CAL_SPEC.every((s) => cal.snippet.includes(`export const ${s.constant} = `)) && cal.snippet.includes('GUN_VETO_LABELS'));
  // Deliberately wrong defaults (what happened live): calibration must rescue them.
  const bad = { indexBendMaxDeg: 2, indexReachMin: 3, curlBendMinDeg: 150, curlReachMax: 0.2, separationMin: 2 };
  const calBad = suggestThresholds(syn, bad);
  check('calibrate: from thresholds that pass 0% of pointers, suggests ones that pass >= 95%',
    calBad.rates.current.side === 0 && calBad.rates.suggested.side >= 95 && calBad.rates.suggested.camera >= 95, fmt(calBad.rates));
  const calSame = suggestThresholds({ side: syn.side, camera: syn.camera, open: syn.side, fist: syn.camera });
  check('calibrate: identical classes are flagged overlap and fail', calSame.rows.every((r) => r.status === 'overlap') && !calSame.suggestedPass);
  const labelled = syn.side.map((x, i) => ({ ...x, label: i % 3 ? 'None' : 'Open_Palm' }));
  const calVeto = suggestThresholds({ ...syn, side: labelled });
  check('calibrate: drops a veto label that real pointer frames carry (Open_Palm on 17% of pointer frames)',
    !calVeto.thresholds.vetoLabels.includes('Open_Palm') && calVeto.thresholds.vetoLabels.includes('Closed_Fist'), fmt(calVeto.veto));
  check('calibrate: too few frames -> current values kept, with a warning',
    (() => { const c = suggestThresholds({ side: syn.side.slice(0, 5), camera: [], open: syn.open, fist: syn.fist }); return c.rows.every((r) => r.status === 'no data' && r.suggested === r.current) && c.warnings.length >= 2; })());

  // The recorder's per-step summary (what lands in the results JSON), fed a synthetic hold:
  // 40 frames, half pointer, half open hand, gliding 0.2 px per 20 ms frame.
  const mix = [...synthClass('pointer', 20, 11), ...synthClass('open', 20, 12)];
  const rec = { frames: 42, noHand: 2, twoHands: 0, tooFewHands: 0, labels: { None: 40 }, pointer: 0, fistLike: 0, pinchBlocked: 0,
    first: {}, any: {}, cal: mix, trackSm: [], trackRaw: [], events: [] };
  mix.forEach((x, i) => {
    const g = isGun(x.f);
    if (g.gun) rec.pointer++;
    if (g.failed.length) rec.first[reasonKey(g.failed[0])] = (rec.first[reasonKey(g.failed[0])] || 0) + 1;
    for (const k of new Set(g.failed.map(reasonKey))) rec.any[k] = (rec.any[k] || 0) + 1;
    rec.trackSm.push({ t: i * 20, x: 100 + i * 0.2, y: 50 });
    rec.trackRaw.push({ t: i * 20, x: 100 + i * 0.2, y: 50 });
  });
  const sum = summarisePhase(SCRIPT[0], rec, 720);
  check('step summary: pointer %, reason histogram, all feature spreads, drift and jitter',
    sum.pointerOnPct === 50 && sum.failedAnyPct['curl-pip'] === 50 && FEATURE_KEYS.every((k) => sum.features[k]?.n === 40) &&
    Math.abs(sum.jitter.smoothed.medianPx - 0.2) < 1e-9 && sum.driftPx > 2 && sum.driftPx < 3,
    `pointer ${sum.pointerOnPct}%, any ${fmt(sum.failedAnyPct)}, drift ${sum.driftPx} px, jitter ${sum.jitter.smoothed.medianPx} px`);

  // decide(): the verdict reads what it should from hand-made phase summaries.
  const ev = (fu) => ({ shiftFu: fu, shiftPx: fu * 720 });
  const P = {
    sideHold: { pointerOnPct: 90 }, camHold: { pointerOnPct: 85 }, openHold: { pointerOnPct: 0 }, fistHold: { pointerOnPct: 1 },
    aimPinch: { requested: 5, detected: 5, events: [ev(0.005), ev(0.006), ev(0.01), ev(0.008), ev(0.007)] }
  };
  check('decide: good numbers -> READY', decide(P).choice.startsWith('READY'), decide(P).choice);
  check('decide: 0% pointer side-on -> NOT READY', decide({ ...P, sideHold: { pointerOnPct: 0 } }).choice.startsWith('NOT READY'));
  check('decide: calibrate-only run (no click step) -> INCONCLUSIVE', decide({ ...P, aimPinch: undefined }).choice.startsWith('INCONCLUSIVE'));

  // The pointer/fist collision (BUGS #32): with label None, isFistShape counts the three curled
  // fingers in 2D, so the 2D-only rule says "grab". Since 2026-10-01 gestures.js arbitrates
  // with the pointer state (world landmarks), which the hologram page passes. INFO rows: the
  // 2D-only rule vs the shipped one; test.js "Pointer is never a grab" is the pass/fail check.
  const aspect = 16 / 9;
  for (const [name, rot] of [['palm to camera', [0, 0, 0]], ['side-on', SIDE_ON], ['60 deg toward camera', TOWARD_CAMERA]]) {
    const world = buildWorldHand({ ...GUN, rot });
    const img = projectToImage(world, aspect);
    const p = pinch(img, aspect, { gesture: 'None', worldLandmarks: world });
    info(`collision: pointer ${name}, label None`,
      `isFistShape (2D only)=${isFistShape(img, aspect)} isFistLike with pointer=${isFistLike('None', img, aspect, { worldLandmarks: world })} pinch ratio ${p.ratio.toFixed(2)} ${p.pinching ? 'PINCH' : p.rejectedBy ? 'blocked:' + p.rejectedBy : 'open'}`);
  }

  const passed = rows.filter((r) => r.pass === true).length;
  const failed = rows.filter((r) => r.pass === false).length;
  return { passed, failed, rows };
}

// ======================================================================================
// Live page
// ======================================================================================
const SCRIPT = [
  { id: 'sideHold', cls: 'side', kind: 'hold', ms: 5000,
    text: 'POINTER, SIDE-ON to the camera: index straight out, middle/ring/pinky curled, thumb wherever it is comfortable. Hold still.' },
  { id: 'camHold', cls: 'camera', kind: 'hold', ms: 5000,
    text: 'POINTER aimed AT THE CAMERA (index toward the lens). Hold still.' },
  { id: 'openHold', cls: 'open', kind: 'hold', ms: 5000,
    text: 'Relaxed OPEN hand, fingers loosely apart, palm roughly to the camera. Hold still.' },
  { id: 'fistHold', cls: 'fist', kind: 'hold', ms: 5000,
    text: 'FIST, held naturally. Hold still.' },
  { id: 'aimPinch', cls: null, kind: 'aimPinch', count: 5, maxMs: 25000,
    text: 'BOTH hands in view. AIM with one hand (pointer at the screen) and keep it still; with the OTHER hand, pinch thumb to index and open again. 5 times, normal pace.' }
];
const CALIBRATE_STEPS = 4;     // "calibrate only" runs the first four (the holds)
const READY_MS = 3000;

function boot() {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const setStatus = (t, err = false) => { statusEl.textContent = t; statusEl.classList.toggle('error', err); };

  // Self-test first: it needs no camera and no network.
  const st = runSelfTest();
  window.__gunSelfTest = st;
  $('selftest').innerHTML = [
    `<span class="${st.failed ? 'fail' : 'pass'}">${st.passed} passed, ${st.failed} failed</span>` +
      ` (+ ${st.rows.filter((r) => r.pass === null).length} info rows documenting today's gestures.js collision)`,
    '',
    ...st.rows.map((r) => {
      const tag = r.pass === null ? '<span class="info">INFO</span>' : r.pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>';
      return `${tag} ${escapeHtml(r.name)}${r.detail ? '  ·  ' + escapeHtml(String(r.detail)) : ''}`;
    })
  ].join('\n');
  setStatus(`self-test ${st.passed}/${st.passed + st.failed} passed · camera off`, st.failed > 0);

  const video = $('cam');
  const canvas = $('overlay');
  const ctx = canvas.getContext('2d');
  const startBtn = $('start'), runBtn = $('run'), calBtn = $('calibrate'), skipBtn = $('skip'), copyBtn = $('copy');
  const applyBtn = $('apply'), resetBtn = $('reset');

  let mods = null;       // lazily imported camera/tracker/smoothing/overlay modules
  let tracker = null, stream = null, running = false;
  let lastVideoTime = -1;
  let buffer = [];       // recent samples (aiming hand in the click step)
  let pinchArmed = true;
  let pending = [];      // pinch events waiting for their tail
  let aimPrev = null;    // { c, t }: last aiming-hand centroid in the click step
  let thumbPrev = 'unknown';
  let run = null;        // guided-run state
  let results = null;
  let calibration = null;
  let active = null;     // thresholds applied live from a calibration; null = gunPose.js defaults
  const frameTimes = [];
  const T = () => active ?? GUN_DEFAULTS;

  async function start() {
    startBtn.disabled = true;
    try {
      if (!mods) {
        setStatus('loading modules…');
        const [cam, ht, sm, ov] = await Promise.all([
          import(`${ROOT}camera.js${V}`), import(`${ROOT}handTracker.js${V}`),
          import(`${ROOT}smoothLandmarks.js${V}`), import(`${ROOT}overlay.js${V}`)
        ]);
        mods = { ...cam, ...ht, ...sm, ...ov };
      }
      setStatus('loading gesture model (~8 MB)…');
      tracker = await mods.createHandTracker({ numHands: 2 });
      setStatus('requesting camera…');
      stream = await mods.startCamera(video);
      mods.resetLandmarkSmoothing();
      setStatus(`tracking · ${video.videoWidth}×${video.videoHeight} · self-test ${st.passed}/${st.passed + st.failed}`);
      startBtn.textContent = 'stop camera';
      startBtn.disabled = false;
      runBtn.disabled = false;
      calBtn.disabled = false;
      running = true;
      requestAnimationFrame(loop);
    } catch (err) {
      setStatus(mods ? mods.describeCameraError(err) : String(err), true);
      tracker?.close();
      tracker = null;
      startBtn.disabled = false;
      console.error(err);
    }
  }

  function stop() {
    running = false;
    mods.stopCamera(stream);
    stream = null;
    video.srcObject = null;
    // Close the recognizer on every stop: not closing it leaked one per restart (BUGS #16, #29).
    tracker?.close();
    tracker = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('readout').textContent = 'camera off';
    startBtn.textContent = 'start camera';
    runBtn.disabled = true;
    calBtn.disabled = true;
    if (run) abortRun('camera stopped');
    setStatus('stopped');
  }

  startBtn.addEventListener('click', () => (running ? stop() : start()));
  runBtn.addEventListener('click', () => (run ? abortRun('cancelled') : beginRun(SCRIPT.length)));
  calBtn.addEventListener('click', () => (run ? abortRun('cancelled') : beginRun(CALIBRATE_STEPS)));
  skipBtn.addEventListener('click', () => run && nextStep(performance.now()));
  applyBtn.addEventListener('click', () => { if (calibration) { active = calibration.thresholds; showThresholds(); } });
  resetBtn.addEventListener('click', () => { active = null; showThresholds(); });
  copyBtn.addEventListener('click', async () => {
    const text = JSON.stringify(results, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'copied';
    } catch {
      // Clipboard can be refused (permissions, non-secure origin): select the JSON instead.
      const pre = $('json');
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copyBtn.textContent = 'selected: press Cmd+C';
    }
    setTimeout(() => (copyBtn.textContent = 'copy results JSON'), 2000);
  });

  function showThresholds() {
    const el = $('thrBadge');
    el.textContent = `thresholds: ${active ? 'CALIBRATED (live, not saved)' : 'gunPose.js defaults'}`;
    el.className = 'badge' + (active ? ' warn' : '');
    resetBtn.disabled = !active;
    applyBtn.disabled = !calibration || active === calibration.thresholds;
    lastBadge = ''; // force the pointer badge to re-evaluate under the new thresholds
  }

  // ---- per-frame --------------------------------------------------------------------
  function loop() {
    if (!running) return;
    if (mods.sizeOverlayTo(canvas, video) && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const t = performance.now();
      frameTimes.push(t);
      while (frameTimes.length && t - frameTimes[0] > 2000) frameTimes.shift();
      if (frameTimes.length > 1) $('fps').textContent = `${Math.round(((frameTimes.length - 1) * 1000) / (t - frameTimes[0]))} fps`;
      onFrame(t);
    }
    requestAnimationFrame(loop);
  }

  function onFrame(t) {
    const W = canvas.width, H = canvas.height, aspect = W / H;
    const hands = tracker.read(video, t);
    const raw = hands.map((h) => h.landmarks);
    // Replaces hand.landmarks with smoothed copies; `raw` keeps the originals.
    mods.smoothHandLandmarks(hands, t);

    hands.forEach((h, i) => {
      h.raw = raw[i];
      h.feats = gunFeatures(h.worldLandmarks, T());
      h.gunR = isGun(h.feats, { gesture: h.gesture, thresholds: T() });
      // Same arbitration as hologram.js (gestures.js annotateHand), but with this lab's pointer
      // verdict, so applied calibrated thresholds are honoured too: a pointer is not a grab.
      h.fistLike = isFistLike(h.gesture, h.landmarks, aspect, { pointer: h.gunR });
      h.pinch = pinch(h.landmarks, aspect, { gesture: h.gesture, pointer: h.gunR });
      h.c = centroidPx(h.landmarks, W, H);
    });

    const step = run ? SCRIPT[run.i] : null;
    const clickStep = step?.kind === 'aimPinch';
    let hand = null, pincher = null;
    if (clickStep) {
      if (aimPrev && t - aimPrev.t > AIM_FORGET_MS) aimPrev = null;
      const pick = pickAimAndPinch(hands.map((h) => ({ c: h.c, gun: h.gunR.gun, pinchRatio: h.pinch.ratio })), aimPrev?.c);
      if (pick) {
        hand = hands[pick.aim];
        pincher = hands[pick.pinch];
        aimPrev = { c: hand.c, t };
      }
    } else if (hands.length) {
      hand = hands.find((h) => h.gunR.gun) ?? hands[0];
    }

    let sample = null;
    if (hand) {
      sample = {
        t, nHands: hands.length, label: hand.gesture,
        cSm: hand.c, cRaw: centroidPx(hand.raw, W, H),
        tipSm: { x: hand.landmarks[8].x * W, y: hand.landmarks[8].y * H },
        f: hand.feats, gunR: hand.gunR, fistLike: hand.fistLike,
        pinchRatio: pincher ? pincher.pinch.ratio : null,
        pinchBlocked: pincher ? pincher.pinch.rejectedBy === 'fist' : null
      };
      if (pincher) detectPinch(sample, t);
      buffer.push(sample);
    }
    const shown = hand ?? hands[0];
    if (shown) {
      const th = thumbState(shown.feats, thumbPrev);
      thumbPrev = th.state;
      renderLive(shown, th, hands.length, clickStep ? (pincher ? 'aiming hand (other hand pinches)' : 'need BOTH hands in view') : null);
    } else {
      thumbPrev = 'unknown';
      $('readout').textContent = clickStep ? 'no hands detected (need both)' : 'no hands detected';
      setBadges(null);
    }
    while (buffer.length && t - buffer[0].t > BUFFER_MS) buffer.shift();
    finishEvents(t, H);
    if (run) tickRun(t, sample, hands.length);

    mods.drawHands(ctx, hands, mods.HAND_CONNECTIONS);
    if (sample) {
      // Palm centroid of the tracked (aiming) hand, mirrored to match the mirrored video.
      ctx.beginPath();
      ctx.arc(W - sample.cSm.x, sample.cSm.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(230, 196, 138, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // A pinch = the OTHER hand's ratio crosses under PINCH_THRESHOLD; it re-arms only after
  // opening past 2x the threshold, so tracking flicker cannot double-count.
  function detectPinch(s, t) {
    if (pinchArmed && s.pinchRatio < PINCH_THRESHOLD) {
      pinchArmed = false;
      pending.push({ tDetect: t, tStart: lastWhere((b) => b.pinchRatio != null && b.pinchRatio > 2 * PINCH_THRESHOLD, t), blocked: s.pinchBlocked });
    } else if (!pinchArmed && s.pinchRatio > 2 * PINCH_THRESHOLD) {
      pinchArmed = true;
    }
  }

  // Time of the most recent buffered sample matching pred within LOOKBACK_MS (the moment the
  // motion started), or the oldest sample in that window if none matches.
  function lastWhere(pred, t) {
    const win = buffer.filter((b) => t - b.t <= LOOKBACK_MS);
    for (let i = win.length - 1; i >= 0; i--) if (pred(win[i])) return win[i].t;
    return win.length ? win[0].t : t;
  }

  function finishEvents(t, H) {
    const ready = pending.filter((e) => t - e.tDetect >= EVENT_TAIL_MS);
    pending = pending.filter((e) => t - e.tDetect < EVENT_TAIL_MS);
    for (const e of ready) {
      const frames = buffer.filter((b) => b.t >= e.tStart && b.t <= e.tDetect + EVENT_TAIL_MS && b.pinchRatio != null);
      if (frames.length < 2) continue;
      const base = frames[0];
      const maxOf = (key) => Math.max(...frames.map((b) => dpx(b[key], base[key])));
      const ev = {
        windowMs: Math.round(frames.at(-1).t - base.t),
        motionMs: Math.round(e.tDetect - e.tStart),
        frames: frames.length,
        shiftPx: r1(maxOf('cSm')), shiftFu: r4(maxOf('cSm') / H),
        netPx: r1(dpx(frames.at(-1).cSm, base.cSm)),
        rawShiftPx: r1(maxOf('cRaw')), rawShiftFu: r4(maxOf('cRaw') / H),
        indexTipShiftPx: r1(maxOf('tipSm')),
        aimPointerPct: pct(frames.filter((b) => b.gunR.gun).length, frames.length),
        blockedAsFist: e.blocked
      };
      if (run?.phase === 'record' && SCRIPT[run.i].kind === 'aimPinch') run.data.aimPinch.events.push(ev);
    }
  }

  // ---- guided run -------------------------------------------------------------------
  function beginRun(nSteps) {
    results = null;
    run = { i: 0, n: nSteps, phase: 'ready', t0: performance.now(), data: {}, thresholds: T(), calibrated: !!active };
    dispatchEvent(new CustomEvent('gunlab:run-start', { detail: { steps: nSteps } })); // test recorder (gun-lab.html)
    for (const s of SCRIPT.slice(0, nSteps)) {
      run.data[s.id] = { frames: 0, noHand: 0, twoHands: 0, tooFewHands: 0, labels: {}, pointer: 0, fistLike: 0, pinchBlocked: 0,
        first: {}, any: {}, cal: [], trackSm: [], trackRaw: [], events: [] };
    }
    runBtn.textContent = nSteps === SCRIPT.length ? 'cancel run' : 'run guided probe';
    calBtn.textContent = nSteps === SCRIPT.length ? 'calibrate only' : 'cancel calibration';
    runBtn.disabled = calBtn.disabled = false;
    if (nSteps === SCRIPT.length) calBtn.disabled = true; else runBtn.disabled = true;
    skipBtn.disabled = false;
    copyBtn.disabled = true;
    showStep();
  }

  function resetButtons() {
    runBtn.textContent = 'run guided probe';
    calBtn.textContent = 'calibrate only';
    runBtn.disabled = calBtn.disabled = !running;
    skipBtn.disabled = true;
  }

  function abortRun(why) {
    dispatchEvent(new CustomEvent('gunlab:run-abort', { detail: { why } })); // test recorder (gun-lab.html)
    run = null;
    resetButtons();
    $('step').textContent = `Run ${why}. Start it again when ready.`;
    $('bar').style.width = '0';
  }

  function nextStep(t) {
    run.i++;
    run.phase = 'ready';
    run.t0 = t;
    if (run.i >= run.n) return finishRun();
    showStep();
  }

  function showStep() {
    const s = SCRIPT[run.i];
    $('step').textContent = `Step ${run.i + 1}/${run.n} · get ready… ${s.text}`;
  }

  function tickRun(t, sample, nHands) {
    const s = SCRIPT[run.i];
    const el = t - run.t0;
    if (run.phase === 'ready') {
      $('bar').style.width = `${Math.min(100, (100 * el) / READY_MS)}%`;
      $('step').textContent = `Step ${run.i + 1}/${run.n} · starts in ${Math.ceil((READY_MS - el) / 1000)} s · ${s.text}`;
      if (el >= READY_MS) {
        run.phase = 'record';
        run.t0 = t;
        // Events detected during "get ready" must not count toward this step.
        pending = [];
      }
      return;
    }
    const d = run.data[s.id];
    d.frames++;
    if (!nHands) d.noHand++;
    else if (!sample) d.tooFewHands++;      // click step with only one hand in view
    else {
      if (nHands > 1) d.twoHands++;
      d.labels[sample.label] = (d.labels[sample.label] || 0) + 1;
      if (sample.gunR.gun) d.pointer++;
      if (sample.fistLike) d.fistLike++;
      if (sample.pinchBlocked) d.pinchBlocked++;
      const failed = sample.gunR.failed;
      if (failed.length) {
        const k = reasonKey(failed[0]);
        d.first[k] = (d.first[k] || 0) + 1;
      }
      for (const k of new Set(failed.map(reasonKey))) d.any[k] = (d.any[k] || 0) + 1;
      d.cal.push({ f: sample.f, label: sample.label });
      d.trackSm.push({ t, ...sample.cSm });
      d.trackRaw.push({ t, ...sample.cRaw });
    }
    let done, progress, counter = '';
    if (s.kind === 'hold') {
      progress = el / s.ms;
      done = el >= s.ms;
      counter = `${Math.max(0, Math.ceil((s.ms - el) / 1000))} s left`;
    } else {
      progress = Math.max(d.events.length / s.count, el / s.maxMs);
      done = d.events.length >= s.count || el >= s.maxMs;
      counter = `${d.events.length}/${s.count} pinches seen · ${Math.ceil((s.maxMs - el) / 1000)} s max`;
    }
    $('bar').style.width = `${Math.min(100, 100 * progress)}%`;
    $('step').textContent = `Step ${run.i + 1}/${run.n} · RECORDING · ${counter} · ${s.text}`;
    // Let the last event's tail finish before moving on.
    if (done && pending.length === 0) nextStep(t);
  }

  function finishRun() {
    const H = canvas.height, W = canvas.width;
    const phases = {};
    for (const s of SCRIPT.slice(0, run.n)) phases[s.id] = summarisePhase(s, run.data[s.id], H);
    const holds = SCRIPT.slice(0, CALIBRATE_STEPS);
    // Do-nothing baseline for the click: how far the still pointer holds wander in the same
    // window length the pinch events were measured over.
    const ap = phases.aimPinch;
    if (ap) {
      const winMs = median(ap.events.map((e) => e.windowMs)) ?? 500;
      const base = median(['sideHold', 'camHold'].map((id) => windowShiftPx(run.data[id]?.trackSm ?? [], winMs)).filter((v) => v != null));
      ap.baseline = { windowMs: Math.round(winMs), stillHoldShiftPx: r1(base), stillHoldShiftFu: r4(base == null ? null : base / H) };
    }
    calibration = suggestThresholds(Object.fromEntries(holds.map((s) => [s.cls, run.data[s.id]?.cal ?? []])), run.thresholds);
    results = {
      probe: 'pointer pose diagnosis + calibration + other-hand pinch click',
      date: new Date().toISOString(),
      run: run.n === SCRIPT.length ? 'full' : 'calibrate-only',
      video: { width: W, height: H },
      fps: frameTimes.length > 1 ? Math.round(((frameTimes.length - 1) * 1000) / (frameTimes.at(-1) - frameTimes[0])) : null,
      thresholdsUsed: { source: run.calibrated ? 'calibrated (applied live)' : 'gunPose.js defaults', ...run.thresholds },
      rule: RULE,
      phases,
      calibration: { ...calibration, note: 'suggested rates are fitted and scored on the same frames (optimistic); apply them and re-run to confirm' },
      verdict: decide(phases, calibration)
    };
    window.__gunProbe = results;
    dispatchEvent(new CustomEvent('gunlab:run-done', { detail: { results } })); // test recorder (gun-lab.html)
    renderResults(results);
    run = null;
    resetButtons();
    copyBtn.disabled = false;
    showThresholds();
    $('step').textContent = 'Done. Results are below; copy the JSON for the overseer. To try the suggested thresholds, press "apply suggested thresholds" and run again.';
    $('bar').style.width = '100%';
  }

  // ---- rendering --------------------------------------------------------------------
  let lastBadge = '';
  function setBadges(h) {
    // Only touch the DOM when a state actually changes (no per-frame restyling).
    const key = h ? `${h.gunR.gun}|${h.gunR.rejectedBy}|${h.fistLike}` : 'none';
    if (key === lastBadge) return;
    lastBadge = key;
    const set = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = 'badge' + (cls ? ' ' + cls : ''); };
    if (!h) { set('gunBadge', 'pointer: —'); set('fistBadge', 'grab (isFistLike): —'); return; }
    set('gunBadge', `pointer: ${h.gunR.gun ? 'ON' : 'off · ' + h.gunR.rejectedBy}`, h.gunR.gun ? 'on' : '');
    set('fistBadge', `grab (isFistLike): ${h.fistLike}`, h.fistLike && h.gunR.gun ? 'warn' : '');
  }

  function renderLive(hand, th, nHands, role) {
    setBadges(hand);
    const f = hand.feats;
    const p = hand.pinch;
    const fin = (n, x) => `${n} pip ${x.pipDeg}° reach ${x.reach}`;
    const t = T();
    const lines = [
      role ? `[click step] ${role}` : '',
      `hand ${hand.handedness}   label ${hand.gesture} (${hand.score.toFixed(2)})   hands in view ${nHands}`,
      `gestures.js  isFistLike ${hand.fistLike}   pinch ratio ${p.ratio.toFixed(2)} ${p.pinching ? 'PINCH' : p.rejectedBy ? 'blocked:' + p.rejectedBy : 'open'}`,
      f ? `index        pip ${f.index.pipDeg}° dip ${f.index.dipDeg}° reach ${f.index.reach}   (need bend < ${t.indexBendMaxDeg}°, reach >= ${t.indexReachMin})` : 'gunFeatures  (no world landmarks)',
      f ? `${fin('middle', f.middle)} · ${fin('ring', f.ring)} · ${fin('pinky', f.pinky)}` : '',
      f ? `others: min pip ${f.othersMinPipDeg}° (need > ${t.curlBendMinDeg}°), max reach ${f.othersMaxReach} (need < ${t.curlReachMax})   curled ${f.curledCount}/3` : '',
      f ? `separation ${f.separation} (need >= ${t.separationMin})   palm ${(f.palmM * 100).toFixed(1)} cm` : '',
      `pointer ${hand.gunR.gun ? 'ON' : 'off'}${hand.gunR.failed.length ? '  failed: ' + hand.gunR.failed.join(', ') : ''}${hand.gunR.supported ? ' · label supports' : ''}`,
      `thumb (diagnostic only) ${th.state}   gap ${th.gap ?? '—'}   angle ${th.angleDeg ?? '—'}°`,
      hand.fistLike && hand.gunR.gun ? 'COLLISION: today\'s gestures.js would read this pointer as a grab' : ''
    ];
    $('readout').textContent = lines.filter(Boolean).join('\n');
  }

  function renderResults(res) {
    const P = res.phases;
    const ids = Object.keys(P);
    const v = (x, suffix = '') => (x == null ? '—' : `${x}${suffix}`);
    const top = (labels) => Object.entries(labels ?? {}).slice(0, 3).map(([k, n]) => `${k} ${n}%`).join(', ') || '—';
    const table = (head, body) => `<div class="scroll"><table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body}</table></div>`;

    // 1. Overview.
    const overview = ids.map((id) => {
      const p = P[id];
      const moves = p.kind === 'hold'
        ? `drift ${v(p.driftPx, ' px')} · jitter med ${v(p.jitter?.smoothed?.medianPx, ' px')} p90 ${v(p.jitter?.smoothed?.p90Px, ' px')} (raw med ${v(p.jitter?.raw?.medianPx)} p90 ${v(p.jitter?.raw?.p90Px)})`
        : `${p.detected}/${p.requested} pinches · aim shift med ${v(p.medianShiftPx, ' px')} (${v(p.medianShiftFu, ' fu')}) p90 ${v(p.p90ShiftFu, ' fu')} max ${v(p.maxShiftPx, ' px')} · still-hold baseline ${v(p.baseline?.stillHoldShiftPx, ' px')} · aim jitter med ${v(p.jitter?.smoothed?.medianPx, ' px')}`;
      const extra = [p.noHandFrames && `${p.noHandFrames} no hand`, p.tooFewHandFrames && `${p.tooFewHandFrames} one hand`, p.twoHandFrames && p.kind === 'hold' && `${p.twoHandFrames} two hands`].filter(Boolean).join(', ');
      return `<tr><td>${id}</td><td>${p.frames}${extra ? ` (${extra})` : ''}</td><td>${escapeHtml(top(p.labels))}</td>` +
        `<td>${v(p.pointerOnPct, '%')}</td><td>${v(p.fistLikePct, '%')}</td><td>${escapeHtml(moves)}</td></tr>`;
    }).join('');

    // 2. Why the pointer was rejected.
    const why = REASONS.filter((r) => r !== 'no-hand').map((r) =>
      `<tr><td>${r}</td>${ids.map((id) => `<td>${v(P[id].rejectedFirstPct?.[r], '%')} / ${v(P[id].failedAnyPct?.[r], '%')}</td>`).join('')}</tr>`).join('');

    // 3. Feature distributions.
    const feat = FEATURE_KEYS.map((k) => `<tr><td>${k}</td>${ids.map((id) => {
      const s = P[id].features?.[k];
      return `<td>${s ? `${s.p10} / <b>${s.median}</b> / ${s.p90}` : '—'}</td>`;
    }).join('')}</tr>`).join('');

    // 4. Calibration.
    const cal = res.calibration;
    let calHtml = '<p>No calibration (needs the four hold steps).</p>';
    if (cal) {
      const sp = (s) => (s ? `${s.p10} – ${s.p90}` : '—');
      const rowsHtml = cal.rows.map((r) => `<tr><td>${r.constant}</td><td>${r.feature} ${r.pointerMust === 'below' ? '<' : '>'}</td><td>${r.current}</td>` +
        `<td>${sp(r.pointer)}</td><td>${r.against}: ${sp(r.other)}</td><td><b>${r.suggested}</b></td><td class="${r.status === 'clean' ? 'pass' : r.status === 'tight' ? 'info' : 'fail'}">${r.status}${r.gap != null ? ` (gap ${r.gap})` : ''}</td></tr>`).join('') +
        `<tr><td>GUN_VETO_LABELS</td><td>label</td><td>${escapeHtml(cal.veto.current.join(', '))}</td><td colspan="2">pointer labels: ${escapeHtml(Object.entries(cal.veto.pointerLabelPct).map(([k, n]) => `${k} ${n}%`).join(', ') || '—')}</td>` +
        `<td><b>${escapeHtml(cal.veto.suggested.join(', ') || '(none)')}</b></td><td>${cal.veto.dropped.length ? 'dropped ' + escapeHtml(cal.veto.dropped.join(', ')) : 'unchanged'}</td></tr>`;
      const rr = (r) => `side ${v(r.side, '%')} · camera ${v(r.camera, '%')} · open ${v(r.open, '%')} · fist ${v(r.fist, '%')}`;
      calHtml = table(['constant', 'check', 'used this run', 'pointer p10 – p90', 'rejected class p10 – p90', 'suggested', 'separation'], rowsHtml) +
        `<p>Pointer recognised with the thresholds used this run: ${rr(cal.rates.current)}<br>` +
        `With the suggested thresholds (same frames, so optimistic): <b>${rr(cal.rates.suggested)}</b> → ` +
        `<span class="${cal.suggestedPass ? 'pass' : 'fail'}">${cal.suggestedPass ? 'separates the classes' : 'does NOT separate the classes'}</span></p>` +
        (cal.warnings.length ? `<p class="info">${cal.warnings.map(escapeHtml).join('<br>')}</p>` : '') +
        `<p>To commit, paste into gunPose.js (the page never writes it):</p><pre class="snippet">${escapeHtml(cal.snippet)}</pre>`;
    }

    const vd = res.verdict;
    $('results').innerHTML =
      `<div id="verdict"><b>Verdict: ${escapeHtml(vd.choice)}</b><br>${escapeHtml(vd.pointer)}<br>${escapeHtml(vd.click)}<br>` +
      vd.checks.map((c) => `<span class="${c.pass == null ? 'info' : c.pass ? 'pass' : 'fail'}">${c.pass == null ? 'n/a ' : c.pass ? 'PASS' : 'FAIL'}</span> ${escapeHtml(c.text)}`).join('<br>') +
      (vd.notes.length ? '<br>' + vd.notes.map((n) => `<span class="info">note</span> ${escapeHtml(n)}`).join('<br>') : '') + '</div>' +
      `<h3>Steps</h3>` + table(['step', 'frames', 'MediaPipe labels', 'pointer on', 'read as grab (isFistLike)', 'palm-centroid motion (smoothed): drift = RMS over the hold, jitter = frame to frame'], overview) +
      `<h3>Why the pointer was rejected (% of frames: first failed check / any failed check)</h3>` + table(['check', ...ids], why) +
      `<h3>Features: p10 / <b>median</b> / p90 (degrees; reach and separation in palm lengths)</h3>` + table(['feature', ...ids], feat) +
      `<h3>Calibration</h3>` + calHtml +
      `<p>${res.video.width}×${res.video.height} @ ${v(res.fps)} fps · 1 fu = ${res.video.height} px · thresholds used: ${escapeHtml(res.thresholdsUsed?.source ?? '—')} · per-event numbers are in the JSON.</p>`;
    const pre = $('json');
    pre.hidden = false;
    pre.textContent = JSON.stringify(res, null, 2);
  }

  // previewResults(phases, calibration) renders hand-made summaries through the real results
  // view, so the tables and verdict can be checked without a camera.
  window.__gunLab = {
    runSelfTest, decide, suggestThresholds, get results() { return results; }, get active() { return active; },
    previewResults(phases, cal = null, video = { width: 1280, height: 720 }) {
      calibration = cal;
      renderResults({ video, fps: null, phases, calibration: cal, thresholdsUsed: { source: 'preview' }, verdict: decide(phases, cal) });
      showThresholds();
    },
    apply() { applyBtn.click(); }
  };
  showThresholds();
  return { setStatus };
}

// One step's raw recording -> the summary stored in the results JSON.
export function summarisePhase(s, d, H) {
  const seen = d.frames - d.noHand - d.tooFewHands;
  const P = (n) => pct(n, seen);
  const pctMap = (m) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, P(n)]));
  const withF = d.cal.filter((x) => x.f);
  const out = {
    kind: s.kind, frames: d.frames, noHandFrames: d.noHand, twoHandFrames: d.twoHands,
    ...(s.kind === 'aimPinch' ? { tooFewHandFrames: d.tooFewHands } : {}),
    labels: pctMap(d.labels),
    pointerOnPct: P(d.pointer), fistLikePct: P(d.fistLike),
    rejectedFirstPct: pctMap(d.first), failedAnyPct: pctMap(d.any),
    featureFrames: withF.length,
    features: Object.fromEntries(FEATURE_KEYS.map((k) => [k, spread(withF.map((x) => getPath(x.f, k)))])),
    jitter: { smoothed: frameJitter(d.trackSm, H), raw: frameJitter(d.trackRaw, H) }
  };
  if (s.kind === 'hold') {
    const dS = driftPx(d.trackSm), dR = driftPx(d.trackRaw);
    Object.assign(out, { driftPx: r1(dS), driftFu: r4(dS == null ? null : dS / H), rawDriftPx: r1(dR), rawDriftFu: r4(dR == null ? null : dR / H) });
  } else {
    const ev = d.events;
    Object.assign(out, {
      pinchBlockedPct: P(d.pinchBlocked),
      requested: s.count, detected: ev.length, events: ev,
      medianShiftPx: r1(median(ev.map((e) => e.shiftPx))),
      medianShiftFu: r4(median(ev.map((e) => e.shiftFu))),
      p90ShiftFu: r4(quantile(ev.map((e) => e.shiftFu), 0.9)),
      maxShiftPx: ev.length ? r1(Math.max(...ev.map((e) => e.shiftPx))) : null
    });
  }
  return out;
}

// Applies RULE to the phase summaries (and, optionally, the calibration). Exported (via
// window.__gunLab) so the rule can be re-applied to a pasted JSON without re-running.
export function decide(P, calibration = null) {
  const checks = [];
  const notes = [];
  const add = (pass, text) => checks.push({ pass, text });
  const on = (id) => P[id]?.pointerOnPct;
  for (const id of ['sideHold', 'camHold']) {
    add(on(id) == null ? null : on(id) >= RULE.minGunHoldPct, `${id}: pointer recognised on ${on(id) ?? '—'}% of still frames (need >= ${RULE.minGunHoldPct}%)`);
  }
  for (const id of ['openHold', 'fistHold']) {
    add(on(id) == null ? null : on(id) <= RULE.maxFalsePct, `${id}: pointer (wrongly) recognised on ${on(id) ?? '—'}% of frames (need <= ${RULE.maxFalsePct}%)`);
  }
  const ap = P.aimPinch;
  const ev = ap?.events ?? [];
  const med = median(ev.map((e) => e.shiftFu));
  const p90 = quantile(ev.map((e) => e.shiftFu), 0.9);
  add(ap ? ap.detected >= RULE.minPinches : null, `other-hand pinches detected: ${ap?.detected ?? '—'} of ${ap?.requested ?? 5} (need ${RULE.minPinches})`);
  add(med == null ? null : med <= RULE.maxMedianShiftFu, `aiming hand's median palm shift per pinch ${med == null ? '—' : med.toFixed(4)} fu <= ${RULE.maxMedianShiftFu} fu`);
  add(p90 == null ? null : p90 <= RULE.maxP90ShiftFu, `aiming hand's p90 palm shift per pinch ${p90 == null ? '—' : p90.toFixed(4)} fu <= ${RULE.maxP90ShiftFu} fu`);

  const part = (cs) => (cs.some((c) => c.pass === false) ? false : cs.every((c) => c.pass === true) ? true : null);
  const pointerOk = part(checks.slice(0, 4));
  const clickOk = part(checks.slice(4));
  const pointer = pointerOk === true ? 'Pointer: recognised with the thresholds used.'
    : pointerOk === null ? 'Pointer: not fully measured.'
      : calibration?.suggestedPass ? 'Pointer: FAILS with the thresholds used, but the suggested thresholds separate it on this data. Apply them, run again to confirm, then commit them to gunPose.js.'
        : calibration ? 'Pointer: FAILS, and calibration could not separate it from the open hand / fist on this data. See the "why" and "features" tables.'
          : 'Pointer: FAILS with the thresholds used.';
  const click = clickOk === true ? 'Click: an other-hand pinch moves the aiming hand little enough.'
    : clickOk === null ? 'Click: not measured in this run (calibrate-only or missing data).'
      : 'Click: the aiming hand moved too much on other-hand pinches (see the events in the JSON).';
  let choice;
  if (pointerOk === false || clickOk === false) choice = 'NOT READY to wire the pointer + other-hand pinch';
  else if (pointerOk === null || clickOk === null) choice = 'INCONCLUSIVE (some measurements missing)';
  else choice = 'READY to wire the pointer + other-hand pinch';

  const fist = Math.max(P.sideHold?.fistLikePct ?? 0, P.camHold?.fistLikePct ?? 0);
  // Since BUGS #32 the grab reading includes the pointer arbitration, so anything here is a
  // frame the pointer check rejected and the 2D fist rule then caught.
  if (fist > 0) notes.push(`the held pointer still read as a GRAB on up to ${fist}% of frames (frames where the pointer check failed and the 2D fist rule took over): see the rejection histogram.`);
  const blocked = ev.filter((e) => e.blockedAsFist).length;
  if (blocked) notes.push(`${blocked} of ${ev.length} other-hand pinches were blocked as a fist by gestures.js pinch().`);
  if (ap?.baseline?.stillHoldShiftPx != null && ap.medianShiftPx != null) {
    notes.push(`for scale: a still pointer wanders ${ap.baseline.stillHoldShiftPx} px in ${ap.baseline.windowMs} ms anyway (do-nothing baseline); the median other-hand pinch moved it ${ap.medianShiftPx} px.`);
  }
  const two = ['sideHold', 'camHold', 'openHold', 'fistHold'].filter((id) => (P[id]?.twoHandFrames ?? 0) > (P[id]?.frames ?? 0) * 0.1);
  if (two.length) notes.push(`two hands were in view during ${two.join(', ')}: keep only the one hand in frame for the holds.`);
  return { choice, pointer, click, checks, notes };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The page boots itself; under Node (offline checks) only the exports are used.
if (typeof document !== 'undefined') boot();

// Pointer ("finger gun") pose: pure geometry for the aim-with-one-hand gesture.
// STATUS: probe only. Nothing in the live pages calls this yet; the lab page
// docs/lab/gestures/gun-lab.html uses it to measure and calibrate the pose on a real hand
// before anyone wires it into gestures.js / manipulator.js.
//
// DECISION 2026-10-01 (owner + overseer, from the live probe): the click is a pinch with the
// OTHER hand. The thumb is no longer a trigger, and the pose has no thumb condition: the
// thumb may be up, resting on the index or tucked. thumbState() stays exported for
// diagnostics only (the lab still reports the thumb gap).
//
// CONTRACT
//   GUN_DEFAULTS: { indexBendMaxDeg, indexReachMin, curlBendMinDeg, curlReachMax,
//     separationMin, vetoLabels }. The thresholds isGun() uses when none are passed. A caller
//     (the lab's calibrate step) may pass any subset to override them; missing keys fall back.
//   gunFeatures(worldLandmarks, thresholds = GUN_DEFAULTS) -> GunFeatures | null
//     worldLandmarks: MediaPipe hand.worldLandmarks (21 x {x,y,z}, metres, origin near the hand
//       centre; handTracker.js toHands() already carries them). Returns null for anything that is
//       not 21 finite points or has a (near) zero palm, so callers never see NaN.
//     All distances are in WORLD PALM LENGTHS (wrist 0 -> middle MCP 9), all angles in DEGREES.
//     Every value is a ratio or an angle of the 3D hand, so features do not change when the
//     hand is moved, turned or scaled (the lab's self-test checks that).
//     `thresholds` only affects the convenience fields indexExtended and curledCount; the raw
//     measurements never depend on it.
//   isGun(features, { gesture, thresholds }) -> { gun, rejectedBy, failed, supported }
//     The pointer: index extended (both upper joints nearly straight, tip far from the wrist),
//     middle/ring/pinky curled (PIP bent AND tip pulled in), index reach clearly above the
//     other three. No thumb condition. The canned MediaPipe label only vetoes
//     (thresholds.vetoLabels) or supports (Pointing_Up); it never makes a pointer on its own.
//     failed: EVERY check that failed, in this order: 'label:<name>', 'index-bent',
//       'index-short', 'curl-pip' (some other finger's PIP not bent enough), 'curl-reach'
//       (some other finger's tip too far out), 'no-separation'. rejectedBy = failed[0] ?? null,
//       or 'no-hand' when features is null. The full list is what lets a live run say which
//       check real hands fail, rather than only the first one.
//   thumbState(features, prev) -> { state, gap, angleDeg, angleAgrees }   (DIAGNOSTIC ONLY)
//     state: 'cocked' | 'dropped' | 'unknown', with hysteresis between the two thresholds.
//
// Why world landmarks and not the 2D image ones gestures.js uses: the pointer is USED aiming
// at the camera, where the index finger foreshortens to almost nothing in 2D and reads as
// curled. That is the same foreshortening trap that sank the old 2D "reach" pinch check (see
// gestures.js pinch()). World landmarks are metric 3D, so a straight finger stays straight from
// any viewing angle, at least in principle; MediaPipe's world depth is itself estimated.
//
// The default thresholds are still the 2026-09-30 design guesses, tuned on a synthetic hand.
// On 2026-10-01 a real hand (MacBook webcam, 1280x720) passed them on 0% of frames, so they
// are known to be wrong for real hands. They are kept as defaults only until the lab's
// calibrate step produces measured values for the overseer to commit here.

export const GUN_LANDMARK = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_TIP: 4,
  INDEX: [5, 6, 7, 8],   // MCP, PIP, DIP, TIP
  MIDDLE: [9, 10, 11, 12],
  RING: [13, 14, 15, 16],
  PINKY: [17, 18, 19, 20]
};

// Calibrated 2026-10-01 on the owner's hand (gun-lab calibrate, 50 fps webcam; side 254 / camera 229 /
// open 252 / fist 200 frames). Each value sits midway between the pointer's p10/p90 edge and the
// class it rejects; every gap was "clean" (docs/testing/LEDGER.md has the numbers).
// Index "extended": both upper joints nearly straight and the tip well out from the wrist
// (pointer 17-25° bend, 1.81-1.91 reach; fist 97-109°, 0.60-0.88). The bend limit is 45°, not the
// calibration midpoint 61°: it keeps 20° of margin over the real pointer and still rejects a
// half-hooked index (~60°), which the midpoint would have let through.
export const INDEX_BEND_MAX_DEG = 45;
export const INDEX_REACH_MIN = 1.35;
// Middle/ring/pinky "curled": PIP clearly bent and the tip pulled back toward the wrist.
// (pointer: others bent 66-81°, reach 0.76-0.85; open hand 21-22°, 1.94-1.95).
export const CURL_BEND_MIN_DEG = 44;
export const CURL_REACH_MAX = 1.39;
// The index must stand out from the other three by this much reach, so a loosely half-open
// hand that scrapes past both thresholds does not count (pointer 0.99-1.13; open/fist -0.13-0.05).
export const INDEX_SEPARATION_MIN = 0.52;
// DIAGNOSTIC ONLY (not part of the pose): thumb tip distance to the index's first bone
// (MCP 5 -> PIP 6), in palm lengths. Above COCKED = thumb up; below DROPPED = resting on the
// index; between = keep the previous state.
export const THUMB_COCKED_MIN = 0.55;
export const THUMB_DROPPED_MAX = 0.30;
// Cross-check for the diagnostic: angle between the thumb (MCP 2 -> tip 4) and the index bone.
export const THUMB_ANGLE_COCKED_MIN_DEG = 40;
export const THUMB_ANGLE_DROPPED_MAX_DEG = 35;

// Labels that mean "definitely not a pointer". Pointing_Up is the label MediaPipe gives a
// pointer seen from the side often enough to count as support, but it never decides alone.
// Thumb_Up is deliberately NOT a veto: the live probe labelled a pointer aimed at the camera
// Thumb_Up on 100% of frames. Open_Palm is not a veto either: an earlier probe labelled a side-on
// pointer Open_Palm on 28-100% of frames, and geometry separates the real open hand cleanly.
export const GUN_VETO_LABELS = ['Victory', 'Closed_Fist'];
export const GUN_SUPPORT_LABELS = ['Pointing_Up'];

export const GUN_DEFAULTS = Object.freeze({
  indexBendMaxDeg: INDEX_BEND_MAX_DEG,
  indexReachMin: INDEX_REACH_MIN,
  curlBendMinDeg: CURL_BEND_MIN_DEG,
  curlReachMax: CURL_REACH_MAX,
  separationMin: INDEX_SEPARATION_MIN,
  vetoLabels: GUN_VETO_LABELS
});

const withDefaults = (t) => (t && t !== GUN_DEFAULTS ? { ...GUN_DEFAULTS, ...t } : GUN_DEFAULTS);

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v) => Math.hypot(v.x, v.y, v.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const dist = (a, b) => len(sub(a, b));

// Angle between two vectors in degrees; 0 when parallel. Used as a joint's bend: the angle
// between the bone going into the joint and the bone coming out of it.
function angleDeg(u, v) {
  const d = len(u) * len(v);
  if (d === 0) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))) * 180) / Math.PI;
}

function bendAt(lm, a, b, c) {
  return angleDeg(sub(lm[b], lm[a]), sub(lm[c], lm[b]));
}

// Shortest distance from p to the segment a-b (not the infinite line: a thumb tip beyond the
// PIP should measure to the PIP, not to an imaginary extension of the bone).
function distToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t, z: a.z + ab.z * t });
}

const round = (v, k = 3) => Math.round(v * 10 ** k) / 10 ** k;

function valid(lm) {
  return Array.isArray(lm) && lm.length === 21 &&
    lm.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
}

export function gunFeatures(worldLandmarks, thresholds = GUN_DEFAULTS) {
  const lm = worldLandmarks;
  if (!valid(lm)) return null;
  const T = withDefaults(thresholds);
  const wrist = lm[GUN_LANDMARK.WRIST];
  const palm = dist(wrist, lm[GUN_LANDMARK.MIDDLE[0]]);
  // 1 mm: MediaPipe world palms are ~7-10 cm, so anything this small is a degenerate frame.
  if (!(palm > 1e-3)) return null;

  const reach = (tip) => dist(lm[tip], wrist) / palm;
  const finger = ([m, p, d, t]) => ({
    pipDeg: round(bendAt(lm, m, p, d), 1),
    dipDeg: round(bendAt(lm, p, d, t), 1),
    reach: round(reach(t))
  });
  const index = finger(GUN_LANDMARK.INDEX);
  const middle = finger(GUN_LANDMARK.MIDDLE);
  const ring = finger(GUN_LANDMARK.RING);
  const pinky = finger(GUN_LANDMARK.PINKY);
  const others = [middle, ring, pinky];

  const [i5, i6] = GUN_LANDMARK.INDEX;
  const thumbGap = distToSegment(lm[GUN_LANDMARK.THUMB_TIP], lm[i5], lm[i6]) / palm;
  const thumbAngleDeg = angleDeg(sub(lm[GUN_LANDMARK.THUMB_TIP], lm[GUN_LANDMARK.THUMB_MCP]), sub(lm[i6], lm[i5]));
  // The three summary values isGun() actually compares against thresholds. Exposed so the
  // lab can calibrate one number per check instead of re-deriving the logic.
  const indexBendDeg = Math.max(index.pipDeg, index.dipDeg);
  const othersMinPipDeg = Math.min(...others.map((f) => f.pipDeg));
  const othersMaxReach = Math.max(...others.map((f) => f.reach));

  return {
    palmM: round(palm, 4),
    index,
    middle,
    ring,
    pinky,
    indexBendDeg,
    othersMinPipDeg,
    othersMaxReach,
    indexExtended: indexBendDeg < T.indexBendMaxDeg && index.reach >= T.indexReachMin,
    curledCount: others.filter((f) => f.pipDeg > T.curlBendMinDeg && f.reach < T.curlReachMax).length,
    separation: round(index.reach - othersMaxReach),
    thumbGap: round(thumbGap),
    thumbAngleDeg: round(thumbAngleDeg, 1)
  };
}

export function isGun(features, { gesture = null, thresholds = GUN_DEFAULTS } = {}) {
  const supported = GUN_SUPPORT_LABELS.includes(gesture);
  if (!features) return { gun: false, rejectedBy: 'no-hand', failed: ['no-hand'], supported };
  const T = withDefaults(thresholds);
  const f = features;
  const failed = [];
  if (T.vetoLabels.includes(gesture)) failed.push(`label:${gesture}`);
  if (f.indexBendDeg >= T.indexBendMaxDeg) failed.push('index-bent');
  if (f.index.reach < T.indexReachMin) failed.push('index-short');
  // "All three curled" == "the least-bent one is bent enough AND the furthest-out one is
  // pulled in enough", split in two so a live run can tell which half real hands miss.
  if (f.othersMinPipDeg <= T.curlBendMinDeg) failed.push('curl-pip');
  if (f.othersMaxReach >= T.curlReachMax) failed.push('curl-reach');
  if (f.separation < T.separationMin) failed.push('no-separation');
  return { gun: failed.length === 0, rejectedBy: failed[0] ?? null, failed, supported };
}

// ---- Hands v2 hammer click (plans/hands-v2/CONTRACT.md §3.2, Ricky's report §3) -----------
// The thumb is a trigger again in v2 (owner 2026-10-02: click = finger-gun thumb hammer drop).
// LOCAL FALLBACK: handFeatures.js computes the same thing as hand.f.hammer, and pointer.js reads
// that when it is present. This copy only runs when a hand has no hand.f (v2 runtime not wired
// yet, or a test/lab feeding plain hands). Same formula and thresholds as handFeatures.js HF;
// swap it out once every v2 caller runs handFeatures first.
//
//   hammerAngleDeg(worldLandmarks) -> degrees | null
//     angle(thumb MCP 2 -> tip 4, wrist 0 -> index MCP 5): measured against the index
//     METACARPAL, which is rigid, not the 5->6 bone thumbAngleDeg uses (the thumb's tendon drags
//     that bone along when it drops). null for anything gunFeatures would reject.
//   createHammer(thresholds = HAMMER_DEFAULTS) -> { update(angleDeg, thumbGap, tMs) -> hammer, reset() }
//     hammer = { angleDeg, state, dropT, fallT, edge }, the hand.f.hammer shape:
//     angleDeg: 3-frame median (null when angleDeg in is null; the state resets to 'unknown').
//     state 'cocked' after COCK_HOLD_MS in the cock band (angle > COCK_DEG or gap > COCK_GAP);
//     'dropped' on entering the drop band (angle < DROP_DEG and gap < DROP_GAP) within
//     DROP_WINDOW_MS of the last cocked frame; 'unknown' after a too-slow lowering (no click, the
//     thumb must re-cock). edge = true only on the drop frame. fallT = the onset: the earlier of
//     the last cocked frame and the first frame of a fall faster than FALL_RATE_DPS.
export const HAMMER_DEFAULTS = Object.freeze({
  COCK_DEG: 50,          // [Ricky §3, unconfirmed] thumb up off the index
  COCK_GAP: 0.50,        // ... or its tip this far (palm lengths) from the index's first bone
  DROP_DEG: 30,          // dropped needs BOTH angle below this ...
  DROP_GAP: 0.30,        // ... and the gap below this
  COCK_HOLD_MS: 100,     // a resting thumb that flickers into the band never arms
  DROP_WINDOW_MS: 300,   // a slow lowering (resting the thumb) is not a click
  FALL_RATE_DPS: -150,   // a fall this fast marks the onset even inside the cock band
  MEDIAN_N: 3            // +1 frame latency, removes single-frame spikes
});

export function hammerAngleDeg(worldLandmarks) {
  const lm = worldLandmarks;
  if (!valid(lm)) return null;
  const meta = sub(lm[GUN_LANDMARK.INDEX[0]], lm[GUN_LANDMARK.WRIST]);
  if (!(len(meta) > 1e-3)) return null;
  return angleDeg(sub(lm[GUN_LANDMARK.THUMB_TIP], lm[GUN_LANDMARK.THUMB_MCP]), meta);
}

export function createHammer(thresholds = HAMMER_DEFAULTS) {
  const T = { ...HAMMER_DEFAULTS, ...thresholds };
  let h;
  const reset = () => {
    h = { state: 'unknown', degs: [], prevDeg: null, prevT: null, cockSince: null, lastCockT: null, fastT: null, dropT: null, fallT: null };
  };
  reset();
  const out = (deg, edge) => ({ angleDeg: deg, state: h.state, dropT: h.dropT, fallT: h.fallT, edge });
  return {
    reset,
    update(rawDeg, gap, t) {
      if (rawDeg == null || !Number.isFinite(gap)) {
        Object.assign(h, { state: 'unknown', degs: [], prevDeg: null, prevT: null, cockSince: null, fastT: null });
        return out(null, false);
      }
      h.degs.push(rawDeg);
      while (h.degs.length > T.MEDIAN_N) h.degs.shift();
      const sorted = [...h.degs].sort((a, b) => a - b);
      const m = sorted.length >> 1;
      const deg = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2; // = handFeatures median
      const rate = h.prevT != null && t > h.prevT ? ((deg - h.prevDeg) * 1000) / (t - h.prevT) : 0;
      const fallStart = h.prevT; // a fast fall measured on this frame began on the previous one
      h.prevDeg = deg;
      h.prevT = t;
      if (deg > T.COCK_DEG || gap > T.COCK_GAP) {
        h.cockSince ??= t;
        if (t - h.cockSince >= T.COCK_HOLD_MS) h.state = 'cocked';
        if (h.state === 'cocked') h.lastCockT = t;
        if (rate < T.FALL_RATE_DPS) h.fastT ??= fallStart;
        else h.fastT = null;
        return out(deg, false);
      }
      h.cockSince = null;
      if (h.state !== 'cocked') return out(deg, false);
      if (rate < T.FALL_RATE_DPS) h.fastT ??= fallStart;
      if (t - h.lastCockT > T.DROP_WINDOW_MS) {
        h.state = 'unknown';
        h.fastT = null;
      } else if (deg < T.DROP_DEG && gap < T.DROP_GAP) {
        h.state = 'dropped';
        h.dropT = t;
        h.fallT = Math.min(h.lastCockT, h.fastT ?? Infinity);
        h.fastT = null;
        return out(deg, true);
      }
      return out(deg, false);
    }
  };
}

// DIAGNOSTIC ONLY since 2026-10-01: the thumb is not a trigger and not part of the pose.
export function thumbState(features, prev = 'unknown') {
  const prevState = typeof prev === 'string' ? prev : prev?.state ?? 'unknown';
  if (!features) return { state: 'unknown', gap: null, angleDeg: null, angleAgrees: null };
  const { thumbGap: gap, thumbAngleDeg: angleDeg } = features;
  let state = prevState;
  if (gap > THUMB_COCKED_MIN) state = 'cocked';
  else if (gap < THUMB_DROPPED_MAX) state = 'dropped';
  const angleAgrees =
    state === 'cocked' ? angleDeg >= THUMB_ANGLE_COCKED_MIN_DEG
      : state === 'dropped' ? angleDeg <= THUMB_ANGLE_DROPPED_MAX_DEG
        : null;
  return { state, gap, angleDeg, angleAgrees };
}

// Finger-gun pose: pure geometry for the "point, then drop the thumb to click" probe.
// STATUS: probe only (2026-09-30). Nothing in the live pages calls this yet; the lab page
// docs/lab/gestures/gun-lab.html uses it to measure whether a thumb drop is steady enough to be
// a click, before anyone wires it into gestures.js / manipulator.js.
//
// CONTRACT
//   gunFeatures(worldLandmarks) -> GunFeatures | null
//     worldLandmarks: MediaPipe hand.worldLandmarks (21 x {x,y,z}, metres, origin near the hand
//       centre; handTracker.js toHands() already carries them). Returns null for anything that is
//       not 21 finite points or has a (near) zero palm, so callers never see NaN.
//     All distances are in WORLD PALM LENGTHS (wrist 0 -> middle MCP 9), all angles in DEGREES.
//     Because every value is a ratio or an angle of the 3D hand, features do not change when the
//     hand is moved, turned or scaled (the lab's self-test checks that).
//   isGun(features, { gesture }) -> { gun, rejectedBy, supported }
//     Geometry decides; the canned MediaPipe label only vetoes (Open_Palm / Victory /
//     Closed_Fist) or supports (Pointing_Up). rejectedBy: null | 'no-hand' | 'label:<name>' |
//     'index-bent' | 'index-short' | 'fingers-open' | 'no-separation'.
//   thumbState(features, prev) -> { state, gap, angleDeg, angleAgrees }
//     state: 'cocked' | 'dropped' | 'unknown'. Hysteresis: between the two thresholds the
//     previous state is kept (prev may be the previous result object or its state string).
//     features === null -> 'unknown' (tracking lost; the caller decides whether to hold).
//
// Why world landmarks and not the 2D image ones gestures.js uses: a finger gun is USED pointing
// at the camera, where the index finger foreshortens to almost nothing in 2D and reads as
// curled. That is the same foreshortening trap that sank the old 2D "reach" pinch check (see
// gestures.js pinch()). World landmarks are metric 3D, so a straight finger stays straight from
// any viewing angle.
//
// Every threshold below is a design guess (Ricky's design, 2026-09-30), not measured on a real
// hand yet. The lab exists to measure them; expect them to move.

export const GUN_LANDMARK = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_TIP: 4,
  INDEX: [5, 6, 7, 8],   // MCP, PIP, DIP, TIP
  MIDDLE: [9, 10, 11, 12],
  RING: [13, 14, 15, 16],
  PINKY: [17, 18, 19, 20]
};

// Index "extended": both upper joints nearly straight and the tip well out from the wrist.
export const INDEX_BEND_MAX_DEG = 35;
export const INDEX_REACH_MIN = 1.1;
// Middle/ring/pinky "curled": PIP clearly bent and the tip pulled back toward the wrist.
// 0.9 matches gestures.js's CURL_THRESHOLD (measured on a real hand in 2D); the 3D value may differ.
export const CURL_BEND_MIN_DEG = 70;
export const CURL_REACH_MAX = 0.9;
// The index must stand out from the other three by this much reach, so a loosely half-open
// hand that scrapes past both thresholds does not count.
export const INDEX_SEPARATION_MIN = 0.3;
// Thumb tip distance to the index's first bone (MCP 5 -> PIP 6), in palm lengths.
// Above COCKED = hammer up; below DROPPED = thumb resting on the index; between = keep state.
// The gap between them is the hysteresis band that stops a trembling thumb double-clicking.
export const THUMB_COCKED_MIN = 0.55;
export const THUMB_DROPPED_MAX = 0.30;
// Cross-check only (reported, not used to decide): angle between the thumb (MCP 2 -> tip 4)
// and the index bone (5 -> 6). Cocked is roughly an L, dropped roughly parallel.
export const THUMB_ANGLE_COCKED_MIN_DEG = 40;
export const THUMB_ANGLE_DROPPED_MAX_DEG = 35;

// Labels that mean "definitely not a gun". Pointing_Up is the label MediaPipe gives a gun seen
// from the side often enough to count as support, but it never forces a gun on its own.
export const GUN_VETO_LABELS = ['Open_Palm', 'Victory', 'Closed_Fist'];
export const GUN_SUPPORT_LABELS = ['Pointing_Up'];

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

export function gunFeatures(worldLandmarks) {
  const lm = worldLandmarks;
  if (!valid(lm)) return null;
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

  const curled = (f) => f.pipDeg > CURL_BEND_MIN_DEG && f.reach < CURL_REACH_MAX;
  const [i5, i6] = GUN_LANDMARK.INDEX;
  const thumbGap = distToSegment(lm[GUN_LANDMARK.THUMB_TIP], lm[i5], lm[i6]) / palm;
  const thumbAngleDeg = angleDeg(sub(lm[GUN_LANDMARK.THUMB_TIP], lm[GUN_LANDMARK.THUMB_MCP]), sub(lm[i6], lm[i5]));

  return {
    palmM: round(palm, 4),
    index,
    middle,
    ring,
    pinky,
    indexExtended: index.pipDeg < INDEX_BEND_MAX_DEG && index.dipDeg < INDEX_BEND_MAX_DEG && index.reach >= INDEX_REACH_MIN,
    curledCount: [middle, ring, pinky].filter(curled).length,
    separation: round(index.reach - Math.max(middle.reach, ring.reach, pinky.reach)),
    thumbGap: round(thumbGap),
    thumbAngleDeg: round(thumbAngleDeg, 1)
  };
}

export function isGun(features, { gesture = null } = {}) {
  const supported = GUN_SUPPORT_LABELS.includes(gesture);
  if (!features) return { gun: false, rejectedBy: 'no-hand', supported };
  if (GUN_VETO_LABELS.includes(gesture)) return { gun: false, rejectedBy: `label:${gesture}`, supported };
  const f = features;
  let rejectedBy = null;
  if (f.index.pipDeg >= INDEX_BEND_MAX_DEG || f.index.dipDeg >= INDEX_BEND_MAX_DEG) rejectedBy = 'index-bent';
  else if (f.index.reach < INDEX_REACH_MIN) rejectedBy = 'index-short';
  else if (f.curledCount < 3) rejectedBy = 'fingers-open';
  else if (f.separation < INDEX_SEPARATION_MIN) rejectedBy = 'no-separation';
  return { gun: rejectedBy === null, rejectedBy, supported };
}

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

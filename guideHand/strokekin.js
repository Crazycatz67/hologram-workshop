// guideHand/strokekin.js — rigid-motion, spline and easing helpers for the guide hand.
//
// PROVENANCE. Ported verbatim from the owner's ASL project, asl-recognizer/js/strokekin.js.
// There it moved the J/Z motion letters; here it moves whole hands along gesture paths
// (catmullRom2D), rolls a fist about its wrist (rigidPoseAt), starts a motion after a pose
// has formed (delayedEase) and lets a hand arrive with a small settle (easeOutBack).

// =============================================================================
// js/strokekin.js — rigid-motion + spline math for the demo hand (Engine)
// =============================================================================
// WHAT: Pure rigid-motion + spline math for the demo-hand's motion-letter
//   animation (S2d part 2) and word-level coarticulation (S2e). No DOM, no
//   canvas — just functions over [x, y] points.
//
// WHY: posekin.js interpolates a hand's OWN bone angles between two shapes (a
//   hand reconfiguring itself — right for every static letter). J needs a
//   different model: the "I" handshape never changes, only the wrist's
//   position and orientation do — a rigid body moving through space, not a
//   hand curling. This module provides that: rotate a fixed pose around its
//   own wrist, glide the wrist along a short spline, and read the fingertip's
//   resulting path back out. The hook in a real J falls out of that rotation;
//   it is never hand-plotted as a polyline.
//
// WHERE IT SITS: output side only (the animated demo hand in Practice's
//   reference panel and Read mode) — imported by reference.js's canonical
//   player. Not part of recognition.
//
// PUBLIC API (all pure):
//   rotate2D(v, theta)                  → v rotated by theta radians
//   catmullRom2D(pts, t)                → point on a smooth spline through pts, t ∈ [0,1]
//   delayedEase(t, start, ease)         → 0 until `start`, then ease() over the rest
//   rigidPoseAt(basePose, theta, wrist) → pose rotated about its wrist, moved to `wrist`
//   bump(t, center, width)              → raised-cosine pulse, 1 at center, 0 beyond width
//   translatePose(pose, [dx, dy])       → every point shifted
//   easeOutBack(t, overshoot?)          → 0→1 ease with a small overshoot
//   arcFractions(pts)                   → cumulative arc-length fraction per waypoint
//
// UNITS: poses are 21 [x, y] landmarks in whatever 2D space the caller uses
//   (reference.js works in normalized hand units, +y down); angles in
//   radians; t is a 0..1 animation progress fraction.

// ---- pose, spline and easing helpers ----

// Rotate a 2D vector by theta (radians) around the origin.
export function rotate2D([x, y], theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [x * c - y * s, x * s + y * c];
}

// Catmull-Rom spline through 2+ control points, t clamped to [0,1].
// Endpoints are clamped rather than looped (the nearest real point stands in
// for the missing phantom neighbour), so as few as 2 points is just a
// straight line and no extra padding points are needed to author a curve.
export function catmullRom2D(pts, t) {
  const n = pts.length;
  if (n === 1) return pts[0].slice();
  const e = Math.max(0, Math.min(1, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(e));
  const local = e - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[Math.min(n - 1, i + 1)];
  const p3 = pts[Math.min(n - 1, i + 2)];
  const t2 = local * local, t3 = t2 * local;
  const c = (a, b, cc, d) =>
    0.5 * (2 * b + (-a + cc) * local + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
  return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
}

// An ease that stays at 0 until `start`, then runs `ease` over the rest of
// the range. J's rotation uses this to start after the downstroke — without
// the delay, rotation and translation blend from frame 0 and the top of the
// J reads as a diagonal instead of a straight line.
export function delayedEase(t, start, ease) {
  const e = Math.max(0, Math.min(1, t));
  if (e <= start) return 0;
  return ease((e - start) / (1 - start));
}

// `basePose` (21 [x,y], wrist at basePose[0]) rigidly rotated by theta
// around its own wrist, then translated so the wrist lands at `wristAt`.
// Passing basePose[0] itself as `wristAt` rotates in place with no net
// translation — used for a momentary wrist "cock" layered on top of an
// already-positioned pose.
export function rigidPoseAt(basePose, theta, wristAt) {
  const origin = basePose[0];
  return basePose.map(([x, y]) => {
    const r = rotate2D([x - origin[0], y - origin[1]], theta);
    return [r[0] + wristAt[0], r[1] + wristAt[1]];
  });
}

// Raised-cosine bump: 1 at `center`, easing smoothly down to 0 by `width`
// away in either direction, 0 beyond that. Used to place Z's small wrist
// cock at each direction-change corner without a hard on/off snap.
export function bump(t, center, width) {
  const d = Math.abs(t - center);
  if (d >= width) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / width));
}

// Rigidly translate every landmark of `pose` by [dx, dy] — used for a
// doubled letter's wrist bounce (S2e): the handshape doesn't change, the
// whole hand just nudges and returns, so a plain per-point shift is exactly
// right (no rotation/bone math needed).
export function translatePose(pose, [dx, dy]) {
  return pose.map(([x, y]) => [x + dx, y + dy]);
}

// "Back ease out": eases 0->1 but overshoots past 1 partway through before
// settling exactly at 1 — a small, deliberate overshoot-and-settle instead of
// a dead stop, which is what a real arriving hand does and what makes pure
// easeInOut read as robotic (S2e arrival dynamics). `overshoot` controls how
// far past 1 it swings; the default (1.3) peaks around t=0.58 at ~1.06, the
// plan's target ~6% overshoot. Fed straight into posekin.js's `poseAt`
// (deliberately unclamped) - see that module's comment on why the overshoot
// survives instead of being flattened back to the target.
export function easeOutBack(t, overshoot = 1.3) {
  const c1 = overshoot;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

// ---- path measurement ----

// Cumulative arc-length fraction (0..1) at each point of a polyline —
// where along a hand-authored path (like STROKE.Z) each original waypoint
// actually falls once the path is walked at a constant rate. Used to place
// per-corner effects (a wrist cock, a numbered waypoint) at the right
// progress fraction rather than guessing.
export function arcFractions(pts) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  const fracs = [0];
  let acc = 0;
  for (const s of seg) {
    acc += s;
    fracs.push(total > 0 ? acc / total : 0);
  }
  return fracs;
}

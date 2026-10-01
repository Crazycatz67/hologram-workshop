// guideHand/posekin.js — anatomical pose interpolation for the guide hand.
//
// PROVENANCE. Ported verbatim from the owner's ASL project, asl-recognizer/js/posekin.js
// (makeHandInterpolator: rigid palm SLERP + per-finger bend/spread lerp so a curl always
// travels toward the palm; makeInterpolator / decompose / angleDistance kept for parity).
// The ASL comments below talk about letters and centroids; here the poses are the authored
// gesture poses in guideHand/gestures.js, which follow the same frame: right hand, palm to the
// viewer, thumb and index at +x, fingers up (-y), folding toward the camera (-z).
// The one ASL-specific note that no longer applies: tools/ci-check.mjs (guideHand-test.js
// checks rigidity and bend direction instead).

// js/posekin.js — bone-length-preserving interpolation over the hand's
// kinematic tree. Pure math, no DOM, no canvas: decompose a 21-landmark pose
// into (root, per-bone {len, direction}), then interpolate each bone's
// DIRECTION in 3D rather than raw x,y. A naive Cartesian lerp (the old
// poseAt() in reference.js) makes a curling finger cut a straight chord
// through space and lets bone lengths drift mid-animation; interpolating a
// fixed-length bone's direction instead makes it sweep the arc a real finger
// actually swings through, and pins every bone to one constant length for
// the whole clip — "same physical hand" the whole time.
//
// Landmark tree (MediaPipe hand topology): wrist (0) is the root. Five palm
// bones fan out from the wrist to each finger's base knuckle; each finger is
// then a 3-bone chain from its knuckle to its tip. The three cross-palm
// links (5-9, 9-13, 13-17) are drawn by skeleton.js but aren't part of this
// kinematic tree — they're rendered between wherever the driven knuckles
// land, never driven themselves.
//
// Why 3D, when everything on screen is 2D: a finger curling into a fist
// doesn't just rotate in the camera's image plane — a real letter centroid's
// z per landmark (already read for S2c's depth-cue rendering) shows the
// curl happens substantially IN DEPTH too (confirmed empirically: for a
// closed fist the index PIP-DIP bone's z-only contribution is a real,
// non-trivial fraction of its length, growing knuckle to tip). Interpolating
// the 2D PROJECTION of that motion in-plane forces the entire depth rotation
// to be represented as an exaggerated in-plane swing — for several
// fist-shaped letters that swing approaches 180 degrees on a single joint,
// which is anatomically impossible and reads as a finger flipping/bending
// backwards (the confirmed root cause of checklist item 7's still-open
// W/R/X/K/V case). Interpolating the true 3D bone direction and projecting
// the RESULT back to 2D lets that same motion happen mostly in depth, where
// it belongs, and the on-screen swing shrinks to whatever the real 2D
// component actually is.
//
// Poses may be given as 21 [x,y] pairs OR 21 [x,y,z] triples — z defaults to
// 0 when omitted (e.g. NEUTRAL_HAND, a hand-authored placeholder with no
// measured depth of its own — treated as facing the camera flat). When both
// poses fed to makeInterpolator have z=0 throughout, every bone direction
// lies in the z=0 plane and its 3D SLERP reduces to exactly the same
// shortest-arc in-plane rotation the old 2D implementation computed — this
// is a strict superset of the old behavior, not a divergent rewrite.

const PALM_BONES = [[0, 1], [0, 5], [0, 9], [0, 13], [0, 17]];
const CHAINS = [
  [1, 2, 3, 4],     // thumb
  [5, 6, 7, 8],     // index
  [9, 10, 11, 12],  // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];

// Shortest-arc angular difference, always in (-pi, pi]. No longer used
// internally (3D bone angles are compared via dot/cross products instead,
// which have no sign ambiguity to wrap), but kept exported as-is: it's a
// generically useful, independently-tested utility, and existing callers
// (tools/ci-check.mjs) exercise it directly.
export function wrap(d) {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

const toV3 = (p) => [p[0], p[1], p.length > 2 ? p[2] : 0];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
function norm3(a) {
  const l = len3(a) || 1e-9;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function bone3(pa, pb) {
  const d = sub3(pb, pa);
  return { len: len3(d), dir: norm3(d) };
}

// Spherical linear interpolation between two unit 3D vectors at fraction e —
// the 3D analogue of the old wrap()-based shortest-arc 2D angle lerp, with no
// sign ambiguity: the shortest rotation between two vectors is unique in 3D
// (the ±180-degree wraparound problem is specifically a 2D-signed-angle
// artifact). `e` is NOT clamped to [0,1] — the formula below extrapolates
// smoothly past either endpoint, which is what lets S2e's overshoot easing
// (briefly e>1) keep working exactly as it did with the old lerp.
function slerp3(a, b, e) {
  const d = Math.max(-1, Math.min(1, dot3(a, b)));
  const omega = Math.acos(d);
  // Near-parallel or near-antipodal: the great-circle axis is ill-conditioned
  // (or undefined, for exact antipodes). Fall back to a plain lerp + re-
  // normalize — indistinguishable from true SLERP in this narrow regime, and
  // never hit in practice by two real, distinct bone directions.
  if (omega < 1e-6 || Math.PI - omega < 1e-6) {
    return norm3([
      a[0] + (b[0] - a[0]) * e,
      a[1] + (b[1] - a[1]) * e,
      a[2] + (b[2] - a[2]) * e,
    ]);
  }
  const s = Math.sin(omega);
  const wa = Math.sin((1 - e) * omega) / s;
  const wb = Math.sin(e * omega) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

// pose: 21 [x,y] or [x,y,z] points -> { root, palm:[{len,dir}]x5, chains:[[{len,dir}]x3]x5 }
// `dir` is each bone's WORLD-space unit direction (not parent-relative) — see
// the module comment on why per-bone world SLERP is enough here without a
// full parent-relative rotation frame.
export function decompose(pose) {
  const p = pose.map(toV3);
  const root = p[0];
  const palm = PALM_BONES.map(([a, b]) => bone3(p[a], p[b]));
  const chains = CHAINS.map((chain) => {
    const bones = [];
    for (let i = 0; i < chain.length - 1; i++) bones.push(bone3(p[chain[i]], p[chain[i + 1]]));
    return bones;
  });
  return { root, palm, chains };
}

// Build a t (0..1, unclamped) -> 21 [x,y] interpolator between two poses.
// Bone lengths are pinned to poseB's (the target's) 3D length for the ENTIRE
// clip, including t=0 — see the module comment: this assumes poseA and
// poseB are proportioned consistently (e.g. two real letter centroids from
// the same normalization pipeline). Fed a poseA whose bone lengths differ
// from poseB's (e.g. the hand-authored NEUTRAL_HAND placeholder), t=0
// reproduces poseA's DIRECTIONS at poseB's LENGTHS rather than poseA
// exactly — a real tradeoff, not a bug: a hand that never resizes mid-clip
// is the whole point of this module. Note the pin is on 3D length; the
// PROJECTED 2D length can still vary a little as a bone's z component
// changes (real foreshortening as it turns toward/away from the camera) —
// that's the fix working as intended, not the old invariant regressing.
export function makeInterpolator(poseA, poseB) {
  const a = decompose(poseA);
  const b = decompose(poseB);

  return function poseAt(t) {
    const e = t;
    const rootA = a.root, rootB = b.root;
    const root = [
      rootA[0] + (rootB[0] - rootA[0]) * e,
      rootA[1] + (rootB[1] - rootA[1]) * e,
      rootA[2] + (rootB[2] - rootA[2]) * e,
    ];

    const out = new Array(21);
    out[0] = root;

    PALM_BONES.forEach(([, child], i) => {
      const len = b.palm[i].len; // constant: target's 3D length, whole clip
      const dir = slerp3(a.palm[i].dir, b.palm[i].dir, e);
      out[child] = add3(root, scale3(dir, len));
    });

    CHAINS.forEach((chain, fi) => {
      let parentPt = out[chain[0]];
      for (let i = 0; i < chain.length - 1; i++) {
        const len = b.chains[fi][i].len; // constant: target's 3D length, whole clip
        const dir = slerp3(a.chains[fi][i].dir, b.chains[fi][i].dir, e);
        const pt = add3(parentPt, scale3(dir, len));
        out[chain[i + 1]] = pt;
        parentPt = pt;
      }
    });

    return out.map(([x, y]) => [x, y]); // project back to 2D for the canvas renderer
  };
}

// Normalized RMS angular distance between two poses' bone DIRECTIONS — how
// big a reconfiguration poseA -> poseB actually is, in the same 3D space
// makeInterpolator moves through. Used by S2e (js/reference.js `setWord`) to
// derive each letter-to-letter transition's duration from the shapes
// themselves: A -> B is a big reconfiguration and should take longer, U -> V
// is a flick and shouldn't. Root position is deliberately excluded — this
// measures HANDSHAPE change, not where the hand happens to sit.
export function angleDistance(poseA, poseB) {
  const a = decompose(poseA);
  const b = decompose(poseB);
  let sumSq = 0;
  let n = 0;
  const angleBetween = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot3(u, v))));
  for (let i = 0; i < a.palm.length; i++) {
    sumSq += angleBetween(a.palm[i].dir, b.palm[i].dir) ** 2;
    n++;
  }
  for (let fi = 0; fi < a.chains.length; fi++) {
    for (let bi = 0; bi < a.chains[fi].length; bi++) {
      sumSq += angleBetween(a.chains[fi][bi].dir, b.chains[fi][bi].dir) ** 2;
      n++;
    }
  }
  return Math.sqrt(sumSq / n) / Math.PI; // ~0 (no change) .. ~1 (avg bone flips pi)
}

// =============================================================================
// makeHandInterpolator — anatomically constrained hand motion (Stage 4b,
// 2026-09-25). makeInterpolator above rotates every bone independently in
// world space, the five palm bones included, so the palm isn't rigid and a
// finger's bend direction is only as reliable as the 3D direction of travel —
// M/N/P/Q still squeezed flat mid-animation and folding fingers could take
// sideways paths (owner's first QA note: "impossible and unrecreatable
// movements"). This version moves a hand the way a hand moves:
//   * the PALM is one rigid body: its orientation (a frame from wrist ->
//     middle knuckle and across the knuckles) is SLERPed as a single
//     rotation; its shape is interpolated in its own frame;
//   * each FINGER bone is expressed relative to that palm frame and moves by
//     two angles — forward bend (flexion) and sideways spread (abduction) —
//     interpolated linearly, with bend unwrapped so a curl ALWAYS travels
//     toward the palm (measured on the dataset: folding is -z in this frame
//     for every letter); no bone can swing through the palm or flip sideways;
//   * the thumb (which moves in its own cone) SLERPs in the palm frame.
// Endpoints are exact (t=0 -> poseA, t=1 -> poseB). Returns 2D points like
// makeInterpolator; pure, DOM-free (tools/ci-check.mjs tests it in Node).
// =============================================================================
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function palmFrame(p) {
  const y = norm3(sub3(p[9], p[0]));
  const xp = sub3(p[17], p[5]);
  const x = norm3(sub3(xp, scale3(y, dot3(xp, y))));
  const z = cross3(x, y);
  return { x, y, z };
}
const toLocal = (v, f) => [dot3(v, f.x), dot3(v, f.y), dot3(v, f.z)];
const fromLocal = (l, f) => add3(add3(scale3(f.x, l[0]), scale3(f.y, l[1])), scale3(f.z, l[2]));

// rotation matrix <-> quaternion for the palm frame
function frameToQuat(f) {
  const m00 = f.x[0], m01 = f.y[0], m02 = f.z[0];
  const m10 = f.x[1], m11 = f.y[1], m12 = f.z[1];
  const m20 = f.x[2], m21 = f.y[2], m22 = f.z[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  return [w, x, y, z];
}
function quatToFrame([w, x, y, z]) {
  return {
    x: [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
    y: [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
    z: [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
  };
}
function slerpQuat(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (d < 0) { b = b.map((v) => -v); d = -d; } // shortest way round
  if (d > 0.9995) {
    const r = a.map((v, i) => v + (b[i] - v) * t);
    const l = Math.hypot(...r);
    return r.map((v) => v / l);
  }
  const om = Math.acos(d), s = Math.sin(om);
  const wa = Math.sin((1 - t) * om) / s, wb = Math.sin(t * om) / s;
  return a.map((v, i) => v * wa + b[i] * wb);
}

// finger bone local direction <-> (bend, spread). Folding toward the palm is
// -z in palmFrame (checked on A S E M N O C X centroids), so bend = atan2(-lz,
// ly): 0 = straight along the palm, +90° = pointing into the palm, ~150°+ =
// curled back. Unwrapped to [-90°, 270°) so a curl near 180° never snaps to
// -180° and swings the wrong way.
function toBend(l) {
  let bend = Math.atan2(-l[2], l[1]);
  if (bend < -Math.PI / 2) bend += 2 * Math.PI;
  const spread = Math.asin(Math.max(-1, Math.min(1, l[0])));
  return { bend, spread };
}
function fromBend({ bend, spread }) {
  const c = Math.cos(spread);
  return [Math.sin(spread), c * Math.cos(bend), -c * Math.sin(bend)];
}

export function makeHandInterpolator(poseA, poseB) {
  const pa = poseA.map(toV3), pb = poseB.map(toV3);
  const fa = palmFrame(pa), fb = palmFrame(pb);
  const qa = frameToQuat(fa), qb = frameToQuat(fb);
  const PALM_PTS = [1, 5, 9, 13, 17];
  const palmLocal = (p, f) => PALM_PTS.map((j) => toLocal(sub3(p[j], p[0]), f));
  const la = palmLocal(pa, fa), lb = palmLocal(pb, fb);
  const bonesOf = (p, f) =>
    CHAINS.map((chain) => {
      const out = [];
      for (let i = 0; i < chain.length - 1; i++) {
        const d = sub3(p[chain[i + 1]], p[chain[i]]);
        const len = len3(d);
        out.push({ len, local: toLocal(scale3(d, 1 / (len || 1e-9)), f) });
      }
      return out;
    });
  const ba = bonesOf(pa, fa), bb = bonesOf(pb, fb);
  const angA = ba.map((ch) => ch.map((b) => toBend(b.local)));
  const angB = bb.map((ch) => ch.map((b) => toBend(b.local)));

  function at3d(t) {
    const e = t;
    const lerp = (x, y) => x + (y - x) * e;
    const f = quatToFrame(slerpQuat(qa, qb, e));
    const root = [lerp(pa[0][0], pb[0][0]), lerp(pa[0][1], pb[0][1]), lerp(pa[0][2], pb[0][2])];
    const out = new Array(21);
    out[0] = root;
    PALM_PTS.forEach((j, i) => {
      const l = [lerp(la[i][0], lb[i][0]), lerp(la[i][1], lb[i][1]), lerp(la[i][2], lb[i][2])];
      out[j] = add3(root, fromLocal(l, f));
    });
    CHAINS.forEach((chain, fi) => {
      let parent = out[chain[0]];
      for (let i = 0; i < chain.length - 1; i++) {
        const len = lerp(ba[fi][i].len, bb[fi][i].len);
        let local;
        if (fi === 0) {
          local = slerp3(ba[fi][i].local, bb[fi][i].local, e); // thumb: its own cone
        } else {
          const A = angA[fi][i], B = angB[fi][i];
          local = fromBend({ bend: lerp(A.bend, B.bend), spread: lerp(A.spread, B.spread) });
        }
        const pt = add3(parent, scale3(fromLocal(local, f), len));
        out[chain[i + 1]] = pt;
        parent = pt;
      }
    });
    return out;
  }
  // poseAt(t) -> 21 [x, y] (what the canvas draws); poseAt.at3d(t) -> 21
  // [x, y, z] (tests check rigidity / bend monotonicity on it)
  const poseAt = (t) => at3d(t).map(([x, y]) => [x, y]);
  poseAt.at3d = at3d;
  return poseAt;
}
// exported for tests: a finger bone's forward bend (radians) in its pose's palm frame
export function fingerBends(pose3) {
  const p = pose3.map(toV3);
  const f = palmFrame(p);
  return CHAINS.slice(1).map((chain) =>
    chain.slice(0, -1).map((j, i) => toBend(toLocal(norm3(sub3(p[chain[i + 1]], p[j])), f)).bend));
}

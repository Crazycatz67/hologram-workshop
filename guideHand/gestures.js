// guideHand/gestures.js — the gesture keyframe library for the guide hand.
//
// CONTRACT (consumers: guideHand/player.js, assets/site/demo-slot.js, later Help / tours)
//   POSES[name] -> 21 [x, y, z]   canonical poses, names: open, relaxed, fist, pointer,
//       pinchOpen (the "ready" shape just before a pinch), pinch, peace (✌), thumbsUp,
//       thumbsDown (👎). Frame = the ASL project's: a RIGHT hand, palm to the viewer, wrist at
//       the origin, fingers up (-y), thumb and index at +x, curling toward the camera (-z).
//       One pose unit ~ wrist to middle fingertip (0.96). posekin's makeHandInterpolator
//       assumes this frame (fold = -z in the palm frame), so author new poses with makePose.
//   GESTURES[name] -> spec { name, title, T (loop ms), still (ms: the key pose shown under
//       reduced motion), at(t) -> frame, hint: cue[] (static arrows shown with the still) }
//     frame = { hands: hand[], cues: cue[], fx: { channel: number } }
//     hand  = { side: 'R'|'L', pose: 21 [x,y,z], x, y, s, roll?, pivot?, face?, alpha? }
//             x, y = where the pivot sits on the stage (fractions of stage width / height);
//             s = stage heights per pose unit; roll = degrees, clockwise on screen, about
//             pivot (pose units, default the wrist [0, 0]). Or { side, lm: 21 [X, Y, z] }
//             already in stage height units (recorded clips).
//             Shown as in a mirror (selfie view): the user's RIGHT hand is drawn mirrored on
//             the right, which is how they see their own hand in the camera preview.
//     cue   = { type: 'arrow'|'trail'|'ring'|'cursor'|'label'|'track', a (alpha 0..1), … }
//             positions are { u, v } stage fractions or { hand, joint, dx, dy } (offsets in
//             stage heights) anchored to a drawn hand's landmark.
//     fx    = 0..1 channels a host scene can animate an object with (e.g. grab-move: grip,
//             carry; scale: spread). Names per gesture are listed in its comment.
//   STAGE_ASPECT = 1.6 (the stage is 16:10; the player fits it inside any canvas).
//
// Photosafety (BUGS #14): every alpha change here is a K() ease over >= 250 ms and fires at
// most once per loop (loops >= 4 s), the hold rings only ever FILL (no blink), nothing inverts.

import { makeHandInterpolator } from './posekin.js';
import { catmullRom2D, easeOutBack } from './strokekin.js';

export const STAGE_ASPECT = 1.6;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- authored poses
// Knuckle layout and bone lengths follow the ASL project's NEUTRAL_HAND (reference.js), so the
// hand has the same proportions as the ASL guide hand.
const KNUCKLE = [[0.10, -0.42], [-0.02, -0.45], [-0.14, -0.42], [-0.25, -0.36]];
const SEG = [[0.21, 0.14, 0.13], [0.22, 0.15, 0.14], [0.20, 0.14, 0.12], [0.16, 0.11, 0.10]];
const FAN = [6, 0, -6, -13];                 // each finger's rest direction, degrees toward +x
const CMC = [0.16, -0.09, 0];
const THUMB_SEG = [0.18, 0.14, 0.13];
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Thumb bone directions (unit-ised), per shape. Tucked lays the tip across the curled index
// and middle, in front of them (smaller z), which is what makes a fist read as a fist.
const THUMB = {
  open: [[0.62, -0.78, -0.1], [0.52, -0.85, -0.05], [0.45, -0.89, 0]],
  relaxed: [[0.7, -0.65, -0.3], [0.5, -0.8, -0.3], [0.35, -0.9, -0.25]],
  side: [[0.6, -0.72, -0.35], [0.2, -0.88, -0.45], [-0.05, -0.88, -0.48]],
  tucked: [[0.35, -0.75, -0.55], [-0.55, -0.55, -0.63], [-0.9, -0.1, -0.4]],
  up: [[0.45, -0.85, -0.25], [0.18, -0.97, -0.12], [0.06, -1, 0]]
};

// Two-bone reach: places thumb joints 3 and 4 so the tip lands on `target` (a pinch), bending
// the thumb's middle joint out toward `pole` the way a real thumb bows.
function reach(p2, target, a, b, pole) {
  let D = sub3(target, p2);
  let d = Math.hypot(D[0], D[1], D[2]);
  const dn = mul3(D, 1 / (d || 1));
  d = Math.max(Math.abs(a - b) + 1e-3, Math.min(a + b - 1e-3, d));
  const along = (a * a - b * b + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, a * a - along * along));
  let n = sub3(pole, mul3(dn, dot3(pole, dn)));
  n = norm3(n);
  const p3 = add3(add3(p2, mul3(dn, along)), mul3(n, h));
  return [p3, add3(p3, mul3(norm3(sub3(target, p3)), b))];
}

// makePose({ bends: 4 × [mcp, pip, dip] degrees, spread?: 4 × degrees, thumb: name | {
// reach: [dx, dy, dz] from the index tip } }) -> 21 [x, y, z] in the canonical frame.
export function makePose({ bends, spread = [0, 0, 0, 0], thumb = 'relaxed' }) {
  const pts = new Array(21);
  pts[0] = [0, 0, 0];
  for (let f = 0; f < 4; f++) {
    const a = (FAN[f] + spread[f]) * DEG;
    let p = [KNUCKLE[f][0], KNUCKLE[f][1], 0];
    let cum = 0;
    pts[5 + f * 4] = p;
    for (let k = 0; k < 3; k++) {
      cum += bends[f][k] * DEG;
      const dir = [Math.sin(a) * Math.cos(cum), -Math.cos(a) * Math.cos(cum), -Math.sin(cum)];
      p = add3(p, mul3(dir, SEG[f][k]));
      pts[6 + f * 4 + k] = p;
    }
  }
  pts[1] = CMC.slice();
  if (typeof thumb === 'string') {
    let p = pts[1];
    THUMB[thumb].forEach((d, k) => { p = add3(p, mul3(norm3(d), THUMB_SEG[k])); pts[2 + k] = p; });
  } else {
    // the thumb's first bone swings toward the target (bowed a little outward, +x), the
    // last two bend to land the tip on it
    const target = add3(pts[8], thumb.reach);
    const p2 = add3(pts[1], mul3(norm3(add3(sub3(target, pts[1]), [0.1, 0, 0])), THUMB_SEG[0]));
    pts[2] = p2;
    const [p3, p4] = reach(p2, target, THUMB_SEG[1], THUMB_SEG[2], [0.8, 0.1, -0.6]);
    pts[3] = p3;
    pts[4] = p4;
  }
  return pts;
}

const CURL = [88, 100, 62];
const FIST4 = [CURL, CURL, CURL, [84, 98, 60]];
const READY = [[30, 40, 20], [22, 30, 14], [26, 34, 16], [30, 38, 18]];
export const POSES = {
  open: makePose({ bends: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], spread: [5, 0, -4, -8], thumb: 'open' }),
  relaxed: makePose({ bends: [[12, 18, 8], [15, 22, 10], [18, 26, 12], [22, 30, 14]], thumb: 'relaxed' }),
  fist: makePose({ bends: FIST4, thumb: 'tucked' }),
  pointer: makePose({ bends: [[0, 0, 0], CURL, CURL, [84, 98, 60]], thumb: 'side' }),
  pinchOpen: makePose({ bends: READY, thumb: { reach: [0.13, 0.07, 0] } }),
  pinch: makePose({ bends: [[60, 70, 40], ...READY.slice(1)], thumb: { reach: [0.03, 0.012, -0.02] } }),
  peace: makePose({ bends: [[0, 0, 0], [0, 0, 0], CURL, [84, 98, 60]], spread: [9, -7, 0, 0], thumb: 'tucked' }),
  thumbsUp: makePose({ bends: FIST4, thumb: 'up' })
};
// 👎 as a still pose: the thumbs-up turned over in the image plane (a rigid 180° turn keeps
// the hand's chirality). Animated guides turn thumbsUp with `roll` instead, so the turn is seen.
POSES.thumbsDown = POSES.thumbsUp.map(([x, y, z]) => [-x, -y - 0.7, z]);

// ---------------------------------------------------------------- timing helpers
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (u) => { u = clamp01(u); return u * u * (3 - 2 * u); };
const mix = (a, b, u) => a + (b - a) * u;

// K([[t0, v0], [t1, v1], …])(t): eased hold-then-move between number (or array) keys.
export function K(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
        const u = smooth((t - t0) / (t1 - t0));
        return Array.isArray(v0) ? v0.map((x, j) => mix(x, v1[j], u)) : mix(v0, v1, u);
      }
    }
    return keys[keys.length - 1][1];
  };
}

// P([[t0, 'open'], [t1, 'fist'], …])(t) -> 21 [x,y,z]: the hand reshapes with posekin's
// anatomical interpolator (rigid palm, fingers bend in arcs toward the palm), arriving with a
// slight settle (easeOutBack, ~3% overshoot) instead of a dead stop.
const interpCache = new Map();
function interp(a, b) {
  const key = `${a}>${b}`;
  if (!interpCache.has(key)) interpCache.set(key, makeHandInterpolator(POSES[a], POSES[b]).at3d);
  return interpCache.get(key);
}
export function P(keys) {
  return (t) => {
    if (t <= keys[0][0]) return POSES[keys[0][1]];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const [t0, a] = keys[i - 1], [t1, b] = keys[i];
        if (a === b) return POSES[a];
        return interp(a, b)(easeOutBack(clamp01((t - t0) / (t1 - t0)), 0.6));
      }
    }
    return POSES[keys[keys.length - 1][1]];
  };
}

// A point along a smooth path (catmull-rom through `pts`, [u, v] stage fractions) at eased
// progress u.
const along = (pts, u) => catmullRom2D(pts, u);

// ---------------------------------------------------------------- cue shorthands
const S = 0.4;                                   // default hand size, stage heights per pose unit
const R = (pose, x, y, extra) => ({ side: 'R', pose, x, y, s: S, ...extra });
const L = (pose, x, y, extra) => ({ side: 'L', pose, x, y, s: S, ...extra });
const tipCursor = (hand, a, extra) => ({ type: 'cursor', at: { hand, joint: 8, dy: -0.12 }, r: 0.035, a, ...extra });
const arrow = (pts, a = 0.5, extra) => ({ type: 'arrow', pts, a, ...extra });
const trail = (hand, joint, a = 0.5) => ({ type: 'trail', hand, joint, ms: 420, a });
const holdRing = (hand, joint, fill, a = 1, dy = 0) => ({ type: 'ring', at: { hand, joint, dy }, r: 0.085, fill, a });
const label = (text, u, v, a, warm = false) => ({ type: 'label', text, at: { u, v }, a, warm });

// ---------------------------------------------------------------- gestures
// Each comment: what the user does · fx channels.
export const GESTURES = {
  // Pointer (index out, 3 curled) sweeps; a cursor rides ahead of the fingertip · fx: aim, cursorU
  'aim-sweep': {
    title: 'Aim: point and sweep', T: 4400, still: 2100,
    hint: [arrow([[0.5, 0.42], [0.62, 0.38], [0.74, 0.42]])],
    at(t) {
      const go = K([[0, 0], [700, 0], [2100, 1], [2600, 1], [3900, 0]])(t);
      const [x, y] = along([[0.5, 0.94], [0.62, 0.9], [0.74, 0.94]], go);
      return {
        hands: [R(P([[0, 'relaxed'], [500, 'pointer'], [3900, 'pointer'], [4300, 'relaxed']])(t), x, y, { roll: mix(-8, 8, go) })],
        cues: [tipCursor(0, K([[0, 0], [400, 0], [700, 0.9], [3800, 0.9], [4200, 0]])(t)), trail(0, 8, 0.45)],
        fx: { aim: go, cursorU: x }
      };
    }
  },

  // Pointer aims; the OTHER hand pinches = click · fx: press, hl
  click: {
    title: 'Click: other hand pinches', T: 4400, still: 1900,
    hint: [label('pinch', 0.3, 0.5, 0.9, true)],
    at(t) {
      const press = K([[0, 0], [1300, 0], [1600, 1], [2200, 1], [2600, 0]])(t);
      const pulse = K([[0, 0], [1450, 0], [2300, 1]])(t);    // a ring opens once per loop, eased in and out
      return {
        hands: [
          R(POSES.pointer, 0.66, 0.94),
          L(P([[0, 'pinchOpen'], [1300, 'pinchOpen'], [1600, 'pinch'], [2200, 'pinch'], [2600, 'pinchOpen']])(t), 0.3, 0.94)
        ],
        cues: [
          tipCursor(0, 0.9, { r: 0.035 + 0.015 * press }),
          { type: 'ring', at: { hand: 1, joint: 8, dx: 0.02 }, r: 0.03 + 0.05 * pulse, fill: 1, a: 0.6 * Math.sin(Math.PI * pulse), cyan: true },
          label('other hand pinches', 0.3, 0.12, K([[0, 0.35], [1300, 0.35], [1600, 0.95], [2600, 0.95], [3000, 0.35]])(t), true)
        ],
        fx: { press, hl: K([[0, 0], [1500, 0], [1900, 1], [3300, 1], [3800, 0]])(t) }
      };
    }
  },

  // Fist grabs, carries, opens to let go · fx: grip, carry
  'grab-move': {
    title: 'Grab and move: make a fist', T: 4800, still: 2400,
    hint: [arrow([[0.42, 0.66], [0.55, 0.6], [0.68, 0.64]])],
    at(t) {
      const grip = K([[0, 0], [500, 0], [900, 1], [3100, 1], [3500, 0]])(t);
      const carry = K([[0, 0], [1000, 0], [2700, 1], [3700, 1], [4700, 0]])(t);
      const [x, y] = along([[0.42, 0.93], [0.55, 0.87], [0.68, 0.91]], carry);
      return {
        hands: [R(P([[0, 'open'], [450, 'open'], [900, 'fist'], [3100, 'fist'], [3550, 'open']])(t), x, y)],
        cues: [{ ...trail(0, 9, 0.5), a: 0.5 * grip }],
        fx: { grip, carry }
      };
    }
  },

  // Fist turns like a knob · fx: grip, roll (-1..1)
  twist: {
    title: 'Twist: turn the fist', T: 4600, still: 1700,
    hint: [arrow([[0.42, 0.42], [0.5, 0.36], [0.58, 0.42]], 0.55)],
    at(t) {
      const grip = K([[0, 0], [400, 0], [800, 1], [3600, 1], [4000, 0]])(t);
      const roll = K([[0, 0], [900, 0], [1700, -1], [2700, 1], [3500, 0]])(t);
      return {
        hands: [R(P([[0, 'open'], [400, 'open'], [800, 'fist'], [3600, 'fist'], [4000, 'open']])(t), 0.5, 0.9, { roll: 35 * roll, pivot: [0, -0.25] })],
        cues: [arrow([[0.42, 0.42], [0.5, 0.36], [0.58, 0.42]], 0.45 * grip, { flip: roll > 0 })],
        fx: { grip, roll }
      };
    }
  },

  // One fist holds; the other open hand raises / lowers = tilt · fx: grip, tilt (-1..1)
  tilt: {
    title: 'Tilt: fist holds, other hand lifts', T: 4600, still: 1600,
    hint: [arrow([[0.84, 0.62], [0.84, 0.46]], 0.55)],
    at(t) {
      const grip = K([[0, 0], [300, 0], [700, 1], [4000, 1], [4400, 0]])(t);
      const up = K([[0, 0], [700, 0], [1600, 1], [2500, 1], [3400, -1], [3900, -1], [4500, 0]])(t);
      return {
        hands: [
          L(P([[0, 'relaxed'], [300, 'relaxed'], [700, 'fist'], [4000, 'fist'], [4400, 'relaxed']])(t), 0.27, 0.93),
          R(P([[0, 'relaxed'], [500, 'open'], [4000, 'open'], [4500, 'relaxed']])(t), 0.73, 0.93 - 0.12 * up)
        ],
        cues: [{ ...trail(1, 12, 0.45) }],
        fx: { grip, tilt: up }
      };
    }
  },

  // Both hands pinch and pull apart / together = scale · fx: grip, spread
  scale: {
    title: 'Scale: pinch with both hands, pull apart', T: 4600, still: 2300,
    hint: [arrow([[0.56, 0.58], [0.76, 0.58]], 0.55), arrow([[0.44, 0.58], [0.24, 0.58]], 0.55)],
    at(t) {
      const sp = K([[0, 0], [900, 0], [2300, 1], [3200, 1], [4300, 0]])(t);
      const pose = P([[0, 'pinchOpen'], [400, 'pinchOpen'], [750, 'pinch'], [3700, 'pinch'], [4100, 'pinchOpen']])(t);
      return {
        hands: [R(pose, 0.6 + 0.16 * sp, 0.94), L(pose, 0.4 - 0.16 * sp, 0.94)],
        cues: [trail(0, 8, 0.35), trail(1, 8, 0.35)],
        fx: { grip: K([[0, 0], [600, 0], [750, 1], [3700, 1], [3900, 0]])(t), spread: sp }
      };
    }
  },

  // Two open hands start together and pull apart = explode · fx: spread
  explode: {
    title: 'Explode: open hands apart', T: 4600, still: 2300,
    hint: [arrow([[0.58, 0.56], [0.8, 0.56]], 0.55), arrow([[0.42, 0.56], [0.2, 0.56]], 0.55)],
    at(t) {
      const sp = K([[0, 0], [800, 0], [2200, 1], [3300, 1], [4300, 0]])(t);
      const pose = P([[0, 'relaxed'], [500, 'open'], [3800, 'open'], [4400, 'relaxed']])(t);
      return {
        hands: [R(pose, 0.6 + 0.2 * sp, 0.95, { roll: 8 * sp }), L(pose, 0.4 - 0.2 * sp, 0.95, { roll: -8 * sp })],
        cues: [trail(0, 12, 0.35), trail(1, 12, 0.35)],
        fx: { spread: sp }
      };
    }
  },

  // From rest, open hands meet = clap (reset) · fx: close, reset
  clap: {
    title: 'Clap: reset', T: 4600, still: 1500,
    hint: [arrow([[0.74, 0.56], [0.58, 0.56]], 0.55), arrow([[0.26, 0.56], [0.42, 0.56]], 0.55)],
    at(t) {
      const close = K([[0, 0], [700, 0], [1400, 1], [1800, 1], [2500, 0]])(t);
      const pulse = K([[0, 0], [1350, 0], [2400, 1]])(t);
      return {
        hands: [
          R(POSES.open, 0.78 - 0.21 * close, 0.95, { roll: -14 * close }),
          L(POSES.open, 0.22 + 0.21 * close, 0.95, { roll: 14 * close })
        ],
        cues: [{ type: 'ring', at: { u: 0.5, v: 0.5 }, r: 0.06 + 0.1 * pulse, fill: 1, a: 0.55 * Math.sin(Math.PI * pulse), cyan: true }],
        fx: { close, reset: K([[0, 0], [1400, 0], [2400, 1], [3600, 1], [4400, 0]])(t) }
      };
    }
  },

  // ✌ held (ring fills) opens the tool wheel; pointer aims, other hand pinches to pick
  // · fx: hold, wheel, aim, pick
  wheel: {
    title: 'Tool wheel: hold ✌', T: 5600, still: 1300,
    hint: [label('hold', 0.68, 0.48, 0.9, true)],
    at(t) {
      const hold = K([[0, 0], [300, 0], [1300, 1]])(t);
      const aim = K([[0, 0], [1700, 0], [2400, 1], [3800, 1], [4500, 0]])(t);
      const pick = K([[0, 0], [2700, 0], [3000, 1], [3500, 1], [3800, 0]])(t);
      return {
        hands: [
          R(P([[0, 'relaxed'], [250, 'peace'], [1400, 'peace'], [1800, 'pointer'], [5000, 'pointer'], [5500, 'relaxed']])(t), 0.66 + 0.08 * aim, 0.95 - 0.04 * aim),
          L(P([[0, 'relaxed'], [1700, 'relaxed'], [2200, 'pinchOpen'], [2700, 'pinchOpen'], [3000, 'pinch'], [3500, 'pinch'], [3800, 'pinchOpen'], [4800, 'pinchOpen'], [5300, 'relaxed']])(t), 0.2, 0.96)
        ],
        cues: [holdRing(0, 9, t < 1500 ? hold : 0, K([[0, 0], [250, 0], [550, 1], [1400, 1], [1750, 0]])(t), -0.03)],
        fx: { hold, wheel: K([[0, 0], [1200, 0], [1500, 1], [4200, 1], [4700, 0]])(t), aim, pick }
      };
    }
  },

  // 👎 held (ring fills) = undo · fx: hold, undone
  undo: {
    title: 'Undo: hold 👎', T: 4600, still: 1300,
    hint: [label('hold', 0.76, 0.3, 0.9, true)],
    at(t) {
      const turn = K([[0, 0], [100, 0], [500, 1], [2300, 1], [2800, 0]])(t);
      const hold = K([[0, 0], [500, 0], [1500, 1]])(t);
      return {
        hands: [R(P([[0, 'relaxed'], [400, 'thumbsUp'], [2300, 'thumbsUp'], [2800, 'relaxed']])(t), 0.74, 0.66, { roll: 180 * turn, pivot: [0, -0.35] })],
        cues: [holdRing(0, 9, t < 1700 ? hold : 0, K([[0, 0], [400, 0], [700, 1], [1600, 1], [1950, 0]])(t))],
        fx: { hold, undone: K([[0, 0], [1500, 0], [2300, 1], [3600, 1], [4400, 0]])(t) }
      };
    }
  },

  // Pinch-hold drag (sliders, tape): the other hand HOLDS its pinch while the pointer moves
  // · fx: press, drag, shown
  drag: {
    title: 'Drag: hold the pinch, move the pointer', T: 5000, still: 2500,
    hint: [arrow([[0.48, 0.42], [0.76, 0.42]], 0.55), label('hold pinch', 0.2, 0.5, 0.9, true)],
    at(t) {
      const press = K([[0, 0], [700, 0], [1000, 1], [2700, 1], [3000, 0]])(t);
      const drag = K([[0, 0], [1100, 0], [2600, 1], [3700, 1], [4700, 0]])(t);
      return {
        hands: [
          R(POSES.pointer, 0.46 + 0.28 * drag, 0.95),
          L(P([[0, 'pinchOpen'], [700, 'pinchOpen'], [1000, 'pinch'], [2700, 'pinch'], [3000, 'pinchOpen']])(t), 0.17, 0.95)
        ],
        cues: [
          tipCursor(0, 0.9),
          holdRing(1, 8, press, 0.8 * press, 0),
          { type: 'track', from: { u: 0.5, v: 0.3 }, to: { u: 0.8, v: 0.3 }, knob: drag, a: 0.55 }
        ],
        fx: { press, drag, shown: K([[0, 0], [2700, 0], [3000, 1], [3900, 1], [4300, 0]])(t) }
      };
    }
  },

  // Hands lower out of view = rest (tracking resets, nothing fires) · fx: down
  rest: {
    title: 'Rest: lower your hands', T: 4400, still: 2000,
    hint: [arrow([[0.5, 0.42], [0.5, 0.62]], 0.55)],
    at(t) {
      const down = K([[0, 0], [800, 0], [2000, 1], [3200, 1], [4200, 0]])(t);
      const pose = P([[0, 'open'], [700, 'open'], [1600, 'relaxed'], [3300, 'relaxed'], [4100, 'open']])(t);
      return {
        hands: [R(pose, 0.64, 0.86 + 0.3 * down, { roll: 10 * down }), L(pose, 0.36, 0.86 + 0.3 * down, { roll: -10 * down })],
        cues: [label('rest · nothing fires', 0.5, 0.18, K([[0, 0], [1600, 0], [2000, 0.9], [3200, 0.9], [3600, 0]])(t))],
        fx: { down }
      };
    }
  },

  // ---- landing-card variants (same building blocks)
  // Lens: pointer moves the lens; other hand pinch-holds and lifts to grow it · fx: mv, grow, press
  lens: {
    title: 'Lens: pinch-hold and lift to resize', T: 5000, still: 2600,
    hint: [arrow([[0.2, 0.66], [0.2, 0.52]], 0.55)],
    at(t) {
      const mv = K([[0, 0], [1600, 1], [3400, 1], [4800, 0]])(t);
      const grow = K([[0, 0], [1700, 0], [2800, 1], [3800, 1], [4600, 0]])(t);
      return {
        hands: [
          R(POSES.pointer, 0.48 + 0.16 * mv, 0.96),
          L(P([[0, 'pinchOpen'], [1500, 'pinchOpen'], [1700, 'pinch'], [3000, 'pinch'], [3200, 'pinchOpen']])(t), 0.16, 0.96 - 0.1 * grow)
        ],
        cues: [],
        fx: { mv, grow, press: K([[0, 0], [1500, 0], [1700, 1], [3000, 1], [3200, 0]])(t) }
      };
    }
  },
  // Library ring: fist grabs and swipes to spin; pointer + other-hand pinch opens · fx: grip, spin, open
  'ring-spin': {
    title: 'Library ring: grab and swipe', T: 5400, still: 1800,
    hint: [arrow([[0.36, 0.6], [0.64, 0.6]], 0.55)],
    at(t) {
      const spin = K([[0, 0], [800, 0], [2400, 1]])(t);
      const grip = K([[0, 0], [600, 0], [900, 1], [2400, 1], [2700, 0]])(t);
      const open = K([[0, 0], [3000, 0], [3400, 1], [4500, 1], [5000, 0]])(t);
      const hx = K([[0, 0.36], [800, 0.36], [2400, 0.66], [2600, 0.66], [3200, 0.58], [4900, 0.58], [5400, 0.36]])(t);
      const hands = [R(P([[0, 'open'], [600, 'open'], [900, 'fist'], [2400, 'fist'], [2800, 'pointer'], [4900, 'pointer'], [5300, 'open']])(t), hx, 0.96)];
      hands.push(L(P([[0, 'relaxed'], [2700, 'relaxed'], [3000, 'pinchOpen'], [3300, 'pinch'], [4300, 'pinch'], [4700, 'pinchOpen'], [5200, 'relaxed']])(t), 0.17, 0.96, { alpha: K([[0, 0], [2600, 0], [2900, 1], [4900, 1], [5300, 0]])(t) }));
      return { hands, cues: [{ ...trail(0, 9, 0.45), a: 0.45 * grip }], fx: { grip, spin, open } };
    }
  },
  // Pin: fist grabs and tugs; the pinned object stays put · fx: grip, tug, lock
  pin: {
    title: 'Pinned: a tug does nothing', T: 4600, still: 1900,
    hint: [arrow([[0.5, 0.6], [0.7, 0.6]], 0.55)],
    at(t) {
      const grip = K([[0, 0], [600, 0], [1000, 1], [2800, 1], [3200, 0]])(t);
      const tug = K([[0, 0], [1100, 0], [2400, 1], [3400, 1], [4200, 0]])(t);
      return {
        hands: [R(P([[0, 'open'], [600, 'open'], [1000, 'fist'], [2800, 'fist'], [3200, 'open']])(t), 0.5 + 0.18 * tug, 0.95)],
        cues: [{ ...trail(0, 9, 0.4), a: 0.4 * grip }],
        fx: { grip, tug, lock: K([[0, 0.5], [1100, 0.5], [1500, 1], [2800, 1], [3300, 0.5]])(t) }
      };
    }
  }
};
for (const [name, g] of Object.entries(GESTURES)) g.name = name;

// The seven canonical poses as still "gestures" (Help pages can show a single pose).
for (const name of Object.keys(POSES)) {
  GESTURES[`pose:${name}`] = { name: `pose:${name}`, title: name, T: 1000, still: 0, hint: [], at: () => ({ hands: [R(POSES[name], 0.5, 0.93, { s: 0.6 })], cues: [], fx: {} }) };
}

export const GESTURE_NAMES = Object.keys(GESTURES).filter((n) => !n.startsWith('pose:'));

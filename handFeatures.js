// Hands v2 per-hand features (plans/hands-v2/CONTRACT.md §1). Pure: no three.js, no DOM, so
// test.js, replay.js (Node) and the live runtime all run exactly this.
//
// Why a separate stage: v1 decided every gesture from a different 2D ratio in a different file
// (gestures.js pinch, gunPose.js pointer, manipulator.js fist), each with its own debounce. v2
// measures the hand ONCE per frame in 3D, votes one pose label with enter/exit hysteresis, and
// every consumer (inputArbiter, pointer, manipulator) reads hand.f instead of re-deriving it.
// Numbers: Ricky's docs/team-log/reports/2026-10-02-ricky-input-params.md (they override the
// contract's bracketed values; most are still unconfirmed starting points, see HF).
//
// CONTRACT
//   createHandFeatures({ profile?, aspect? = 16/9 }) -> hf
//   hf.update(hands, tMs, { aspect }?) -> hands   sets hand.f on every hand (see below); keeps a
//       per-hand history keyed by id. Never mutates any other field of the input hands.
//   hf.setProfile(profile)   profile.thresholds = { <HF key>: number } overrides (calibration v2, §4)
//   hf.reset()               forget every hand (a replay restart, a camera restart)
//   hf.thresholds            the merged HF + profile values in force (read-only use)
//
//   INPUT hand (handTracker.js toHands shape): { landmarks: 21 image points 0..1 (UNmirrored),
//     worldLandmarks: 21 points in metres (MediaPipe world) | null, handedness, gesture, score,
//     rawLandmarks? }. Points may be {x,y,z} or [x,y,z]. Velocity reads hand.rawLandmarks when
//     present, else hand.landmarks: call update() BEFORE smoothLandmarks.js overwrites them.
//
//   hand.f = {
//     id,         'Left' | 'Right' | 'X2'.. : the history slot. Normally the MediaPipe handedness;
//                 a one-frame label flip keeps the old id (nearest previous wrist).
//     sizeM,      palm length |world0 - world9| in metres, median of the last 30 frames
//     palmPx,     2D palm length |img0 - img9| with x scaled by aspect (= gestures.palmLength)
//     frame: { q:[x,y,z,w], normal:[x,y,z], facing }
//                 q: basis [x̂ ŷ n̂] with ŷ = norm(mean(w5,w9,w13,w17) - w0), x' = w5 - w17,
//                 n̂ = norm(x' × ŷ), x̂ = ŷ × n̂ (Ricky §6: label-independent, so Δq = q·q0⁻¹ needs
//                 no handedness). normal = n̂ flipped by handedness to point OUT OF THE PALM;
//                 facing = dot(normal, toCamera) in -1..1; palm to camera when > HF.FACING_MIN.
//     curl: { thumb, index, middle, ring, pinky }  degrees, PIP + DIP flexion in 3D (thumb MCP + IP)
//     pip:  { index, middle, ring, pinky }         degrees, PIP flexion alone (the fist test uses it)
//     thumbGap,   thumb tip to the index's first bone (5->6), in palm lengths (gunPose.thumbGap)
//     pinch: { ratio, on, strength }  ratio = |w4 - w8| / sizeM; on: enter < PINCH_ON, exit >
//                 PINCH_OFF, each needing PINCH_HOLD_MS in the new band; strength 0..1
//     hammer: { angleDeg, state, dropT, fallT, edge }  angleDeg = 3-frame median of
//                 angle(w2->w4, w0->w5). state 'cocked' after COCK_HOLD_MS in the cock band
//                 (angle > COCK_DEG or thumbGap > COCK_GAP); 'dropped' on entering the drop band
//                 (angle < DROP_DEG and thumbGap < DROP_GAP) within DROP_WINDOW_MS of the last cocked
//                 frame; else 'unknown' (a slow lowering never clicks; the thumb must re-cock).
//                 dropT = time of the drop; fallT = onset t_on = earlier of the last cocked frame and
//                 the first frame of the fall faster than FALL_RATE_DPS (pointer rewinds from it);
//                 edge = true only on the drop frame. Never voted: click edges are instant.
//     aim: { img:[x,y], m:[x,y], s, origin:[x,y], dir:[x,y,z], ok }
//                 img = origin = image landmark 5 (index MCP), 0..1. s = metres per aspect-corrected
//                 image unit (sizeM / palmPx, EMA τ = S_TAU_MS); m = [img.x·aspect·s, img.y·s]:
//                 only ever use DIFFERENCES of m (absolute values carry depth noise). dir (optional,
//                 secondary) = norm(0.6·û(w5->w6) + 0.4·û(w5->w8)), world axes. ok = index straight.
//     vel: { wrist:[vx,vy], speed }  image wrist velocity in palmPx per second between consecutive
//                 raw frames (no smoothing; 0 on a hand's first frame)
//     pose: { label, conf, stableMs }  voted label (§1.3), conf = its weighted share of the window,
//                 stableMs = ms since the label changed
//     mp: { gesture, score }  the MediaPipe label: a hint, never a veto
//   }
//   Labels: fist | open | gun | point | pinch | victory | thumbDown | none.
//   'point' is reserved: CONTRACT §1.3 defines gun as "index straight + others curled, any thumb",
//   which is also every geometric point, so no rule emits 'point' yet.
//
// FAILURE BEHAVIOUR: a hand without 21 image landmarks gets hand.f = null. A hand without usable
// world landmarks gets neutral world fields (curls null, pinch off, hammer unknown, aim.ok false)
// and its per-frame label is the MediaPipe label mapped through MP_TO_LABEL. Time running
// backwards (a replay restart) resets every history. Never throws on hand content.
//
// Units: time ms; image landmarks 0..1; world metres; angles degrees.

// Every threshold in one place. [R] = Ricky's report (2026-10-02); "unconfirmed" there means a
// literature/derived starting value, not measured on the owner's hand yet: re-fit on the owner's
// clips (assets/gesture-clips/, none recorded at the time of writing) before the v2 gate.
export const HF = Object.freeze({
  LOST_GRACE_MS: 150,       // [contract ≈150] a hand's history survives this long without a detection
  SIZE_MEDIAN_N: 30,        // frames in the sizeM median (contract)
  // Hand-id matching, in palm lengths (palmPx) of wrist travel. A flipped label costs more than a
  // short wrist move, and starting a new history costs more than either, so a one-frame
  // Left/Right flip on the same hand keeps its history, while a far-away hand starts fresh.
  ID_LABEL_COST: 1.0,
  ID_NEW_COST: 1.5,
  // Fingers. Closed = PIP bend with hysteresis [R: enter ≥60°, exit ≤45°; owner open 21-22°,
  // curled others 66-81°, fist index 97-109°]. Straight = max(PIP, DIP) below gunPose's
  // INDEX_BEND_MAX_DEG (owner pointer index 17-25°).
  CLOSED_ENTER_DEG: 60,
  CLOSED_EXIT_DEG: 45,
  STRAIGHT_MAX_DEG: 45,
  FIST_THUMB_GAP_MAX: 0.6,  // [R, unconfirmed] a fist's thumb sits near the index; a thumbs-up's doesn't
  THUMB_STRAIGHT_MAX: 50,   // thumbDown: thumb MCP + IP flexion below this (our guess, no data)
  THUMB_DOWN_MIN: 0.5,      // thumbDown: image-space thumb (2->4) unit-vector y (y down) above this
  FACING_MIN: 0.55,         // [R] palm counts as facing the camera above this (Done)
  PINCH_ON: 0.20,           // [R] |w4-w8| / palm to switch on
  PINCH_OFF: 0.30,          // [R] to switch off
  PINCH_FULL: 0.08,         // ratio at which strength reaches 1
  PINCH_HOLD_MS: 40,        // [R] ≥40 ms (2 frames at 50 fps) in the new band before the state flips
  COCK_DEG: 50,             // [R, unconfirmed] hammer angle above this = cocked ...
  COCK_GAP: 0.50,           // [R] ... or thumbGap above this
  DROP_DEG: 30,             // [R, unconfirmed] dropped = angle below this ...
  DROP_GAP: 0.30,           // [R] ... and thumbGap below this
  COCK_HOLD_MS: 100,        // [R] cocked for ≥100 ms before a drop counts (also the re-arm time)
  DROP_WINDOW_MS: 300,      // [R] last cocked frame -> drop band within this, else no click
  FALL_RATE_DPS: -150,      // [R] a fall faster than this marks the click onset (t_on)
  HAMMER_MEDIAN_N: 3,       // [R] median filter on the angle (+1 frame latency)
  AIM_DIR_W56: 0.6,         // [R] optional aim direction: weight of û(5->6) vs û(5->8)
  S_TAU_MS: 1000,           // [R] EMA time constant of s (metres per image unit)
  VOTE_WINDOW_MS: 120,      // [R] pose vote window (6 frames at 50 fps, 4 at 30 fps)
  VOTE_ENTER: 2 / 3,        // [R] a new label needs ≥2/3 of the window's (weighted) votes
  VOTE_EXIT: 1 / 3,         // [R] the current label is kept until its share is ≤1/3
  VOTE_MIN_FRAMES: 2,       // a label can't be entered on a hand's first frame alone
  MP_VOTE: 1,               // contract: +1 when MediaPipe agrees, nothing when it disagrees
  MP_MIN_SCORE: 0.5         // below this the MediaPipe label is ignored entirely
});

// MediaPipe canned label -> our label. Thumb_Up and ILoveYou map to nothing: the live probe
// labelled an aimed pointer Thumb_Up, and a fist with the thumb slightly out often reads Thumb_Up.
export const MP_TO_LABEL = Object.freeze({
  Closed_Fist: 'fist', Open_Palm: 'open', Pointing_Up: 'gun', Victory: 'victory', Thumb_Down: 'thumbDown'
});
export const POSE_LABELS = Object.freeze(['fist', 'open', 'gun', 'point', 'pinch', 'victory', 'thumbDown', 'none']);
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const MCP = { index: 5, middle: 9, ring: 13, pinky: 17 };

// ---- small vector helpers on [x, y, z] arrays ----------------------------------------------
const pt = (p) => (Array.isArray(p) ? p : p ? [p.x, p.y, p.z ?? 0] : null);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addK = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = norm(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function angleDeg(u, v) {
  const d = norm(u) * norm(v);
  if (!(d > 0)) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))) * 180) / Math.PI;
}
const bend = (w, a, b, c) => angleDeg(sub(w[b], w[a]), sub(w[c], w[b]));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Segment, not line: a thumb tip beyond the PIP measures to the PIP (as gunPose.distToSegment).
function distToSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return norm(sub(p, addK(a, ab, t)));
}

function points(list) {
  if (!Array.isArray(list) || list.length !== 21) return null;
  const out = list.map(pt);
  return out.every((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])) ? out : null;
}

// Rotation matrix with columns X, Y, Z -> quaternion [x, y, z, w] (as three.js setFromRotationMatrix).
function quatFromBasis(X, Y, Z) {
  const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

// MediaPipe world axes: x right, y DOWN, z AWAY from the camera, so the camera is at -z.
const TO_CAMERA = [0, 0, -1];
// n̂ = (w5 - w17) × ŷ points out of the BACK of a hand MediaPipe labels 'Right' and out of the
// palm of one it labels 'Left' (a real right hand on the unmirrored webcam frame is labelled
// 'Left': MediaPipe assumes selfie-mirrored input; Ricky §units, "verify on a clip").
// gun-lab/replay synthetic hands (labelled Right, palm toward -z) agree. If a live probe shows
// facing inverted, flip these two signs and nothing else.
const PALM_SIGN = { Left: 1, Right: -1 };

// The geometric part of a frame: everything that needs no history.
function measure(img, w, handedness, aspect) {
  const palmPx = Math.hypot((img[0][0] - img[9][0]) * aspect, img[0][1] - img[9][1]);
  const origin = [img[5][0], img[5][1]];
  if (!w) return { palmPx, origin, world: null };
  const sizeNow = norm(sub(w[9], w[0]));
  if (!(sizeNow > 1e-3)) return { palmPx, origin, world: null }; // degenerate (< 1 mm) world hand

  const mean = scale([5, 9, 13, 17].reduce((a, i) => addK(a, w[i], 1), [0, 0, 0]), 0.25);
  const Y = unit(sub(mean, w[0]));
  const N = unit(cross(sub(w[5], w[17]), Y));
  const X = cross(Y, N);
  const normal = scale(N, PALM_SIGN[handedness] ?? -1);
  const finger = (m) => bend(w, m, m + 1, m + 2) + bend(w, m + 1, m + 2, m + 3);
  const curl = { thumb: bend(w, 1, 2, 3) + bend(w, 2, 3, 4) };
  const pip = {};
  const straight = {};
  for (const name of FINGERS) {
    const m = MCP[name];
    curl[name] = finger(m);
    pip[name] = bend(w, m, m + 1, m + 2);
    straight[name] = Math.max(pip[name], bend(w, m + 1, m + 2, m + 3));
  }
  return {
    palmPx, origin,
    world: {
      sizeNow,
      pinchGapM: norm(sub(w[4], w[8])),
      thumbGap: distToSegment(w[4], w[5], w[6]) / sizeNow,
      frame: { q: quatFromBasis(X, Y, N), normal, facing: dot(normal, TO_CAMERA) },
      curl, pip, maxBend: straight,
      hammerDeg: angleDeg(sub(w[4], w[2]), sub(w[5], w[0])),
      aimDir: (k) => unit(addK(scale(unit(sub(w[6], w[5])), k), unit(sub(w[8], w[5])), 1 - k)),
      // Thumb pointing down in the IMAGE (y down): "down" is the screen's, not the hand's.
      thumbDownImg: unit(sub(img[4], img[2]))[1]
    }
  };
}

function newTrack(id) {
  return {
    id, lastT: -Infinity, wrist: null, palmPx: 0, sizes: [], s: null,
    closed: { index: false, middle: false, ring: false, pinky: false },
    pinch: { on: false, since: null },
    hammer: { state: 'unknown', degs: [], prevDeg: null, prevT: null, cockSince: null, lastCockT: null, fastT: null, dropT: null, fallT: null },
    votes: [], label: 'none', labelT: null
  };
}

export function createHandFeatures({ profile = null, aspect: aspect0 = 16 / 9 } = {}) {
  let T = HF;
  let tracks = new Map();
  let lastT = -Infinity;

  function setProfile(p) {
    const over = {};
    for (const [k, v] of Object.entries(p?.thresholds ?? {})) if (k in HF && Number.isFinite(v)) over[k] = v;
    T = Object.freeze({ ...HF, ...over });
  }
  setProfile(profile);

  function reset() { tracks = new Map(); lastT = -Infinity; }

  // Assign each hand a track id. Cost per hand: wrist travel (palm lengths) from a live track of
  // that id, + ID_LABEL_COST if the id is not its MediaPipe label, or + ID_NEW_COST if no live
  // track has that id. Brute force over assignments: there are at most a few hands.
  function assignIds(entries) {
    const pool = ['Left', 'Right'];
    for (let k = 2; pool.length < entries.length; k++) pool.push(`X${k}`);
    const cost = (e, id) => {
      const tr = tracks.get(id);
      const label = e.hand.handedness === id ? 0 : T.ID_LABEL_COST;
      if (!tr?.wrist) return label + T.ID_NEW_COST;
      const palm = e.m.palmPx || tr.palmPx || 1;
      return label + Math.hypot(e.wrist[0] - tr.wrist[0], e.wrist[1] - tr.wrist[1]) / palm;
    };
    let best = null;
    const walk = (i, used, ids, sum) => {
      if (best && sum >= best.sum) return;
      if (i === entries.length) { best = { sum, ids: [...ids] }; return; }
      for (const id of pool) {
        if (used.has(id)) continue;
        used.add(id); ids.push(id);
        walk(i + 1, used, ids, sum + cost(entries[i], id));
        used.delete(id); ids.pop();
      }
    };
    walk(0, new Set(), [], 0);
    return best.ids;
  }

  function updatePinch(tr, ratio, t) {
    const p = tr.pinch;
    // In the band that would flip the state: start the hold clock at THIS frame's time, so a
    // fresh candidate gets no credit for the frame gap before it.
    const wantsFlip = p.on ? ratio > T.PINCH_OFF : ratio < T.PINCH_ON;
    if (!wantsFlip) p.since = null;
    else if (p.since == null) p.since = t;
    if (wantsFlip && t - p.since >= T.PINCH_HOLD_MS) { p.on = !p.on; p.since = null; }
    return p.on;
  }

  // Returns { deg, edge }. deg is the median-filtered angle the state machine used.
  function updateHammer(tr, rawDeg, gap, t) {
    const h = tr.hammer;
    if (rawDeg == null) {
      Object.assign(h, { state: 'unknown', degs: [], prevDeg: null, prevT: null, cockSince: null, fastT: null });
      return { deg: null, edge: false };
    }
    h.degs.push(rawDeg);
    while (h.degs.length > T.HAMMER_MEDIAN_N) h.degs.shift();
    const deg = median(h.degs);
    const rate = h.prevT != null && t > h.prevT ? ((deg - h.prevDeg) * 1000) / (t - h.prevT) : 0;
    const fallStart = h.prevT; // a fast fall measured on this frame began at the previous one
    h.prevDeg = deg; h.prevT = t;

    let edge = false;
    if (deg > T.COCK_DEG || gap > T.COCK_GAP) {
      if (h.cockSince == null) h.cockSince = t;
      if (t - h.cockSince >= T.COCK_HOLD_MS) h.state = 'cocked';
      if (h.state === 'cocked') h.lastCockT = t;
      // Onset can start while still in the cock band (a fast fall from 80° to 55°).
      if (rate < T.FALL_RATE_DPS) { if (h.fastT == null) h.fastT = fallStart; } else h.fastT = null;
      return { deg, edge };
    }
    h.cockSince = null;
    if (h.state !== 'cocked') return { deg, edge };
    if (rate < T.FALL_RATE_DPS && h.fastT == null) h.fastT = fallStart;
    if (t - h.lastCockT > T.DROP_WINDOW_MS) {
      h.state = 'unknown'; h.fastT = null; // lowered too slowly: not a click, and it must re-cock
    } else if (deg < T.DROP_DEG && gap < T.DROP_GAP) {
      h.state = 'dropped'; h.dropT = t;
      h.fallT = Math.min(h.lastCockT, h.fastT ?? Infinity);
      h.fastT = null; edge = true;
    }
    return { deg, edge };
  }

  // Per-finger closed state with hysteresis, then the frame's label (§1.3, Ricky §4). Order
  // matters: a closed hand is decided before pinch, because a fist's thumb rests near the index.
  function classify(tr, W, pinchOn) {
    for (const name of FINGERS) {
      const d = W.pip[name];
      if (tr.closed[name] ? d <= T.CLOSED_EXIT_DEG : d >= T.CLOSED_ENTER_DEG) tr.closed[name] = !tr.closed[name];
    }
    const c = tr.closed;
    const straight = (name) => W.maxBend[name] < T.STRAIGHT_MAX_DEG && !c[name];
    const othersClosed = c.middle && c.ring && c.pinky;
    if (c.index && othersClosed) {
      if (W.thumbGap < T.FIST_THUMB_GAP_MAX) return 'fist';
      // Thumb clear of the fingers: a thumbs-down if it points down the image, else a thumbs-up,
      // which has no label of its own.
      return W.curl.thumb < T.THUMB_STRAIGHT_MAX && W.thumbDownImg > T.THUMB_DOWN_MIN ? 'thumbDown' : 'none';
    }
    if (pinchOn) return 'pinch';
    if (straight('index') && othersClosed) return 'gun';
    if (straight('index') && straight('middle') && c.ring && c.pinky) return 'victory';
    if (!FINGERS.some((n) => c[n]) && FINGERS.filter(straight).length >= 3) return 'open';
    return 'none';
  }

  // Time-window vote (Ricky §4): weight 1 per frame, + MP_VOTE when MediaPipe agrees.
  function vote(tr, geo, mpLabel, t) {
    tr.votes.push({ t, geo, w: 1 + (mpLabel === geo ? T.MP_VOTE : 0) });
    while (tr.votes.length && t - tr.votes[0].t >= T.VOTE_WINDOW_MS) tr.votes.shift();
    const tally = {};
    let total = 0;
    for (const v of tr.votes) { tally[v.geo] = (tally[v.geo] ?? 0) + v.w; total += v.w; }
    const share = (k) => (tally[k] ?? 0) / total;
    let top = null;
    for (const k of Object.keys(tally)) if (k !== tr.label && (top == null || tally[k] > tally[top])) top = k;
    const canEnter = top != null && tr.votes.length >= T.VOTE_MIN_FRAMES && share(top) >= T.VOTE_ENTER;
    const losing = share(tr.label) <= T.VOTE_EXIT;
    if (canEnter && (losing || tr.label === 'none')) { tr.label = top; tr.labelT = t; }
    else if (losing && tr.label !== 'none') { tr.label = 'none'; tr.labelT = t; } // lost, nothing won yet
    if (tr.labelT == null) tr.labelT = t;
    return { label: tr.label, conf: Math.round(share(tr.label) * 1000) / 1000, stableMs: t - tr.labelT };
  }

  function update(hands, tMs, { aspect = aspect0 } = {}) {
    const list = Array.isArray(hands) ? hands : [];
    if (tMs < lastT) reset();
    lastT = tMs;
    for (const [id, tr] of tracks) if (tMs - tr.lastT > T.LOST_GRACE_MS) tracks.delete(id);

    const entries = [];
    for (const hand of list) {
      const img = points(hand?.landmarks);
      if (!img) { if (hand) hand.f = null; continue; }
      const raw = points(hand.rawLandmarks) ?? img;
      const m = measure(img, points(hand.worldLandmarks), hand.handedness, aspect);
      entries.push({ hand, m, wrist: [raw[0][0] * aspect, raw[0][1]] });
    }
    const ids = entries.length ? assignIds(entries) : [];

    entries.forEach(({ hand, m, wrist }, i) => {
      const id = ids[i];
      const tr = tracks.get(id) ?? newTrack(id);
      tracks.set(id, tr);
      const dtMs = tMs - tr.lastT;
      const palm = m.palmPx || tr.palmPx;
      let vel = [0, 0];
      if (tr.wrist && dtMs > 0 && palm > 0) vel = [((wrist[0] - tr.wrist[0]) / palm) * (1000 / dtMs), ((wrist[1] - tr.wrist[1]) / palm) * (1000 / dtMs)];

      const trusted = hand.score == null || hand.score >= T.MP_MIN_SCORE;
      const mpLabel = trusted ? MP_TO_LABEL[hand.gesture] ?? null : null;
      const W = m.world;
      let f;
      if (W) {
        tr.sizes.push(W.sizeNow);
        while (tr.sizes.length > T.SIZE_MEDIAN_N) tr.sizes.shift();
        const sizeM = median(tr.sizes);
        if (m.palmPx > 0) {
          const sNow = sizeM / m.palmPx;
          const a = tr.s == null || !(dtMs > 0) ? 1 : 1 - Math.exp(-dtMs / T.S_TAU_MS);
          tr.s = tr.s == null ? sNow : tr.s + (sNow - tr.s) * a;
        }
        const ratio = W.pinchGapM / sizeM;
        const on = updatePinch(tr, ratio, tMs);
        const ham = updateHammer(tr, W.hammerDeg, W.thumbGap, tMs);
        const geo = classify(tr, W, on);
        f = {
          sizeM, palmPx: m.palmPx,
          frame: W.frame, curl: W.curl, pip: W.pip, thumbGap: W.thumbGap,
          pinch: { ratio, on, strength: clamp01((T.PINCH_OFF - ratio) / (T.PINCH_OFF - T.PINCH_FULL)) },
          hammer: { angleDeg: ham.deg, state: tr.hammer.state, dropT: tr.hammer.dropT, fallT: tr.hammer.fallT, edge: ham.edge },
          aimDir: W.aimDir(T.AIM_DIR_W56),
          aimOk: W.maxBend.index < T.STRAIGHT_MAX_DEG && !tr.closed.index,
          geo
        };
      } else {
        updatePinch(tr, Infinity, tMs);
        updateHammer(tr, null, null, tMs);
        f = {
          sizeM: tr.sizes.length ? median(tr.sizes) : null, palmPx: m.palmPx,
          frame: { q: [0, 0, 0, 1], normal: [0, 0, -1], facing: 0 },
          curl: { thumb: null, index: null, middle: null, ring: null, pinky: null },
          pip: { index: null, middle: null, ring: null, pinky: null }, thumbGap: null,
          pinch: { ratio: Infinity, on: tr.pinch.on, strength: 0 },
          hammer: { angleDeg: null, state: 'unknown', dropT: tr.hammer.dropT, fallT: tr.hammer.fallT, edge: false },
          aimDir: [0, 0, 0], aimOk: false,
          geo: mpLabel ?? 'none'
        };
      }
      const pose = vote(tr, f.geo, mpLabel, tMs);
      const s = tr.s;
      const aim = {
        img: m.origin, origin: m.origin,
        m: s == null ? null : [m.origin[0] * aspect * s, m.origin[1] * s], s,
        dir: f.aimDir, ok: f.aimOk
      };
      delete f.geo; delete f.aimDir; delete f.aimOk;
      hand.f = {
        id, ...f, aim,
        vel: { wrist: vel, speed: Math.hypot(vel[0], vel[1]) },
        pose,
        mp: { gesture: hand.gesture ?? null, score: hand.score ?? null }
      };
      tr.wrist = wrist; tr.palmPx = palm; tr.lastT = tMs;
    });
    return hands;
  }

  return {
    update, setProfile, reset,
    get thresholds() { return T; },
    // Diagnostics only (tests, labs): the live track ids.
    get ids() { return [...tracks.keys()]; }
  };
}

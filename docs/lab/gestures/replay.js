// Gesture replay: the hologram version of the ASL project's per-letter report
// (asl-recognizer/tools/lab/letter-report.mjs). Feeds a recorded gesture-clip/1 clip frame by
// frame, at its own timestamps, through the SHIPPED hand pipeline and records what fired.
//
// Why: gesture-lab.js measures synthetic hands one channel at a time; it cannot say "when the
// owner does a real clap, does anything else go off too". This replays whole clips (real ones
// once the owner records them in clip-lab; a synthetic fixture set until then) through the
// same order handsRuntime.js uses and scores them like ASL scores letters: fires, misses, false
// fires, time to fire, and a confusion matrix with ASL's 30% gate (ci-check #13f).
//
// PIPELINE per camera frame (handsRuntime.js update() + processFrame(), same order):
//   smoothHandLandmarks -> gestures.annotateHand -> pointer.createEngagement ->
//   manipulator.update -> pointer.update (aim, same-hand pinch, other-hand pinch click) ->
//   toolWheel.feed (✌ through holdGate) -> [modelled] 👎 undo holdGate -> click routing
//   (an open wheel takes the click, else it is a click and selector.block()) ;
// then every 60 Hz display tick until the next camera frame: manipulator.tick,
//   pointer.tick, wheel.point(cursor px), pointer.createSelector (hold-select).
// Differences from the live page, on purpose: no three.js scene/reticle/handModel (nothing
// they do feeds back into what fires); the hold-select target is the model's on-screen centre
// (60 px radius) instead of exploded parts or a surface hit; the 👎 undo is NOT wired in any
// live page yet (manipulator.undo() says "a future gesture (e.g. a held thumbs-down)"), so it
// is modelled here as holdGate tier { undo: 'ring' } on MediaPipe 'Thumb_Down' and the report
// marks it "modelled".
//
// CONTRACT
//   CLASSES                     what can fire: grab tilt scale explode clap click select wheel undo aim
//   PENDING                     owner-decided classes the pipeline cannot fire yet (2026-10-02:
//                               hammer done assemble swipe stretch). A clip expecting one is scored
//                               and shown, but its confusion row never fails the gate: it lands in
//                               gate.pending instead (null-* clips still gate as usual). An EXPECT
//                               entry can also be pending: true for a built class (tilt-ratchet):
//                               its runs score in their own row '<class> (pending)'.
//   expectedOf(name) -> { expected, allowed[], mapped, pending }   from the clip name (EXPECT
//                               table); a '-t<k>' take suffix (clip-lab ground-truth takes) and a
//                               '.<take>' suffix (semi-real) are stripped first;
//                               'null-*' -> expected 'none' (must fire nothing at all).
//   FIRE                        gesture-lab.js's "visible on screen" thresholds (copied, see below)
//   VARIANTS                    stress runs: base, jitter ±0.003/±0.006, fps 15/30, 10%/30%
//                               hand dropouts, mirrored hand
//   perturbClip(clip, variant, seed) -> clip   pure; never mutates its input
//   mirrorClip(clip) -> clip    clip-lab.js mirrorClip (copied: importing clip-lab boots its page)
//   buildSyntheticClips() -> clip[]   the fixtures/synthetic/ set (gesture-clip/1 + synthetic:true)
//   buildSemiRealClips(dataset, sequences, { takes }) -> { clips, stats }   fixtures/semi-real/:
//                               real hand shapes (ASL project's Kaggle dataset), scripted motion
//   loadPipeline(root, v?) -> Promise<P>   browser only (manipulator.js imports 'three')
//   replayClip(clip, P) -> run  { fired: { class: tMs }, channels: { move|push|spin|tilt|scale|
//                               explode: { tMs, mag } }, clicks: [{ t, via }], wheel: [{ t, type,
//                               dir? }], frames, durationMs }   t = ms since the clip's first frame
//   scoreRuns(runs) -> { perGesture, falseFires, matrix, byVariant, gate }   (one clip set)
//                               runs: [{ clip, synthetic, variant, expected, allowed, fired }]
//   diffReports(old, cur) -> string[]   what moved (for --compare)
//   renderMd(report, diff?) -> string    REPORT.md
// Units: time ms; image landmarks 0..1 (UNmirrored camera image); world landmarks metres.
// FAILURE BEHAVIOUR: a clip with no frames replays as "nothing fired"; a hand without 21
// landmarks is dropped from its frame (the pipeline would ignore it anyway). Never throws on
// clip content; loadPipeline rejects if a root module fails to import.
// Deterministic: fixed SEED + per-clip/variant hashes; only `generated` varies run to run.
//
// CLI (Node, no browser; on the Mac: ELECTRON_RUN_AS_NODE=1 ".../Visual Studio Code.app/
// Contents/MacOS/Code" docs/lab/gestures/replay.js ...):
//   --fixtures                  (re)write fixtures/synthetic/*.json (+ its rows in fixtures/index.json)
//   --semireal [--asl dir] [--takes 3]   (re)write fixtures/semi-real/ from asl-recognizer/data (read-only)
//   --write [--from run.json] [--compare old.json] [--out dir]
//                               turn the run that replay-lab.html saved through testrec.js /
//                               serve.py (docs/testing/runs/replay-lab/latest.json by default)
//                               into <out>/report.json + REPORT.md (default docs/lab/gestures/).
//                               --compare defaults to the report.json being replaced.

export const SCHEMA = 'gesture-replay-report/1';
export const SEED = 4242;
export const CLASSES = ['grab', 'tilt', 'scale', 'explode', 'clap', 'click', 'select', 'wheel', 'undo', 'aim'];
export const OFF_DIAGONAL_MAX = 0.3; // ASL ci-check #13f: no pair confused in more than 30% of runs
export const AIM_FIRE_MS = 300; // the cursor counts as "shown" after this much aim (a flicker isn't a fire)
export const MODELLED = ['undo'];
// Owner's new vocabulary (plan Phase 0, 2026-10-02), not built yet: recorded now so the
// owner's clips are the ground truth the later phases are measured against.
export const PENDING = ['hammer', 'done', 'assemble', 'swipe', 'stretch'];

// Clip name -> what it should fire. Clip names are clip-lab.js CLIPS (HANDS-UX-SPEC section 6).
// `allowed` = side effects that are part of doing the gesture (aiming before a click), never
// counted as confusion. Authored, not inferred: a new clip name must be added here.
const CLICKY = { expected: 'click', allowed: ['aim', 'select'] };
export const EXPECT = {
  engage: { expected: 'none', allowed: ['aim'] },
  'rest-lower': { expected: 'none', allowed: ['aim'] },
  'aim-sweep': { expected: 'aim', allowed: [] },
  'click-other': CLICKY,
  'thumb-tap': CLICKY,
  'grab-move': { expected: 'grab', allowed: [] },
  'grab-twist': { expected: 'grab', allowed: [] },
  'grab-push': { expected: 'grab', allowed: [] },
  tilt: { expected: 'tilt', allowed: ['grab'] }, // the holding fist is a grab
  scale: { expected: 'scale', allowed: [] },
  explode: { expected: 'explode', allowed: [] },
  clap: { expected: 'clap', allowed: [] },
  'wheel-pick': { expected: 'wheel', allowed: ['aim'] },
  'wheel-cancel': { expected: 'wheel', allowed: ['aim'] },
  undo: { expected: 'undo', allowed: [] },
  'tape-drag': CLICKY,
  slider: CLICKY,
  scroll: CLICKY,
  lens: CLICKY,
  'ring-spin': { expected: 'grab', allowed: ['aim', 'click', 'select'] },
  pin: { expected: 'wheel', allowed: ['aim'] },
  // Phase 0 ground truth (clip-lab GROUND_TRUTH). Pending classes can't fire yet; the
  // existing gestures they resemble are NOT allowed, so today's confusions stay visible.
  'hammer-click': { expected: 'hammer', allowed: ['aim'] },
  'done-palm': { expected: 'done', allowed: [] },
  'tilt-any': { expected: 'tilt', allowed: ['grab'] }, // the holding fist is a grab
  // Owner tilt decision 2026-10-02: ratchet + flick-to-release are tilt, but their behaviour
  // isn't built, so the clips are pending even though the class exists (own matrix row).
  'tilt-ratchet': { expected: 'tilt', allowed: ['grab'], pending: true },
  'tilt-flick': { expected: 'tilt', allowed: ['grab'], pending: true },
  'assemble-close': { expected: 'assemble', allowed: [] },
  'clap-slow': { expected: 'clap', allowed: [] },
  'clap-normal': { expected: 'clap', allowed: [] },
  'clap-fast': { expected: 'clap', allowed: [] },
  'swipe-left': { expected: 'swipe', allowed: [] },
  'swipe-right': { expected: 'swipe', allowed: [] },
  'swipe-up': { expected: 'swipe', allowed: [] },
  'stretch-vertical': { expected: 'stretch', allowed: [] },
  'fist-grab-tucked': { expected: 'grab', allowed: [] },
  'fist-grab-thumb-out': { expected: 'grab', allowed: [] }
};
export function expectedOf(name = '') {
  // '<gesture>.<take>' (semi-real) and '<gesture>-t<k>' (clip-lab ground truth) -> gesture
  name = String(name).split('.')[0].replace(/-t\d+$/, '');
  if (name.startsWith('null-')) return { expected: 'none', allowed: [], mapped: true, pending: false };
  const e = EXPECT[name];
  return e ? { ...e, allowed: [...e.allowed], mapped: true, pending: !!e.pending || PENDING.includes(e.expected) } : { expected: name, allowed: [], mapped: false, pending: false };
}

// gesture-lab.js FIRE (2026-10-01), copied because gesture-lab.js runs its whole report on
// import. Keep in step with it: "visible on screen", not "nonzero".
export const FIRE = {
  move: (r) => r.lateralCm > 1,
  push: (r) => Math.abs(r.depthCm) > 1,
  spin: (r) => Math.abs(r.spinDeg) > 2,
  tilt: (r) => Math.abs(r.pitchDeg) > 2 || Math.abs(r.rollDeg) > 2,
  scale: (r) => Math.abs(Math.log(r.scaleRatio)) > 0.03 && r.stretch < 1.03,
  explode: (r) => r.stretch > 1.03
};
const MAG = {
  move: (r) => `${r.lateralCm.toFixed(1)}cm`,
  push: (r) => `${r.depthCm.toFixed(1)}cm`,
  spin: (r) => `${r.spinDeg.toFixed(1)}°`,
  tilt: (r) => `p${r.pitchDeg.toFixed(1)}°/r${r.rollDeg.toFixed(1)}°`,
  scale: (r) => `×${r.scaleRatio.toFixed(2)}`,
  explode: (r) => `stretch ${r.stretch.toFixed(2)}`
};
const CHANNEL_CLASS = { move: 'grab', push: 'grab', spin: 'grab', tilt: 'tilt', scale: 'scale', explode: 'explode' };

export const VARIANTS = [
  { id: 'base' },
  { id: 'jitter-0.003', jitter: 0.003 },
  { id: 'jitter-0.006', jitter: 0.006 },
  { id: 'fps-15', fps: 15 },
  { id: 'fps-30', fps: 30 },
  { id: 'drop-10', drop: 0.1 },
  { id: 'drop-30', drop: 0.3 },
  { id: 'mirror', mirror: true }
];

// ---- deterministic helpers (ASL lab-data.mjs rng) ------------------------------------------
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
export function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}
const r5 = (v) => Math.round(v * 1e5) / 1e5;

// ---- clip transforms -----------------------------------------------------------------------
const SWAP = { Left: 'Right', Right: 'Left' };
export function mirrorClip(clip) {
  return {
    ...clip,
    mirrored: !clip.mirrored,
    frames: clip.frames.map((f) => ({
      t: f.t,
      hands: f.hands.map((h) => ({
        ...h,
        handedness: SWAP[h.handedness] ?? h.handedness,
        landmarks: h.landmarks?.map(([x, y, z]) => [r5(1 - x), y, z]) ?? null,
        worldLandmarks: h.worldLandmarks?.map(([x, y, z]) => [x === 0 ? 0 : -x, y, z]) ?? null
      }))
    }))
  };
}

// Stress variants. Jitter is uniform ±j on image x/y (world landmarks get the same in metres
// scaled by palm size, ~0.09 m per 0.12 image units). fps resamples to a fixed rate by sample-
// and-hold (the newest recorded frame at or before each tick: no invented in-between poses).
// A dropout is a frame where the tracker lost every hand (hands: []), which is how MediaPipe
// fails, not a missing camera frame.
export function perturbClip(clip, variant = {}, seed = SEED) {
  let c = variant.mirror ? mirrorClip(clip) : clip;
  let frames = c.frames ?? [];
  if (variant.fps && frames.length) {
    const step = 1000 / variant.fps;
    const end = frames[frames.length - 1].t;
    const out = [];
    let k = 0;
    for (let t = frames[0].t; t <= end + 1e-6; t += step) {
      while (k + 1 < frames.length && frames[k + 1].t <= t + 1e-6) k++;
      out.push({ t: Math.round(t * 100) / 100, hands: frames[k].hands });
    }
    frames = out;
  }
  const R = rng(seed);
  if (variant.jitter) {
    const j = variant.jitter;
    const jw = j * 0.75;
    const n = (a) => (R() * 2 - 1) * a;
    frames = frames.map((f) => ({
      t: f.t,
      hands: f.hands.map((h) => ({
        ...h,
        landmarks: h.landmarks?.map(([x, y, z]) => [x + n(j), y + n(j), z]) ?? null,
        worldLandmarks: h.worldLandmarks?.map(([x, y, z]) => [x + n(jw), y + n(jw), z + n(jw)]) ?? null
      }))
    }));
  }
  if (variant.drop) frames = frames.map((f) => (R() < variant.drop ? { t: f.t, hands: [] } : f));
  return { ...c, frames };
}

// ---- synthetic hands (gesture-lab.js makeHand + gun-lab.js buildWorldHand, copied) ----------
// Copied rather than imported: both lab modules run their full page on import. Image hands
// are gesture-lab's (fingertips placed so isFistShape/pinch behave like a real hand); the
// world hands are gun-lab's finger-flex model so the 3D pointer check (gunPose.js) sees a
// believable pointer / fist / open hand. These prove the harness and the code's thresholds,
// NOT how a real hand performs.
function makeImageHand({ x, y, twist = 0, palm = 0.12, shape = 'open' }) {
  const t = (twist * Math.PI) / 180;
  const up = (k) => y - palm * k;
  const lm = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[9] = { x, y: up(1), z: 0 };
  lm[5] = { x: x + 0.05 * Math.cos(t), y: y - 0.08 + 0.05 * Math.sin(t), z: 0 };
  lm[17] = { x: x - 0.05 * Math.cos(t), y: y - 0.08 - 0.05 * Math.sin(t), z: 0 };
  lm[13] = { x: x - 0.025 * Math.cos(t), y: y - 0.085, z: 0 };
  const closed = shape === 'fist' || shape === 'thumbdown';
  const reach = closed ? 0.5 : 1.9;
  lm[12] = { x, y: up(shape === 'victory' ? 1.9 : reach), z: 0 };
  lm[16] = { x: x - 0.02, y: up(shape === 'victory' ? 0.5 : reach * 0.95), z: 0 };
  lm[20] = { x: x - 0.04, y: up(shape === 'victory' ? 0.5 : reach * 0.8), z: 0 };
  if (shape === 'pinch') {
    lm[8] = { x: x + 0.03, y: up(1.3), z: 0 };
    lm[4] = { x: x + 0.032, y: up(1.28), z: 0 };
  } else {
    lm[8] = { x: x + 0.02, y: up(reach), z: 0 };
    lm[4] = { x: x + (closed ? 0.02 : 0.07), y: up(closed ? 0.6 : 1.0), z: 0 };
  }
  // A thumbs-down's thumb points DOWN the image (v2 reads the direction 2->4). Only the MCP and
  // IP move (they sat on the wrist before); the tip (4), which v1's pinch test reads, stays.
  if (shape === 'thumbdown') {
    lm[2] = { x: x + 0.02, y: up(1.0), z: 0 };
    lm[3] = { x: x + 0.02, y: up(0.8), z: 0 };
  }
  return lm;
}
const MCP = { index: [0.03, 0.085, 0], middle: [0.008, 0.09, 0], ring: [-0.012, 0.085, 0], pinky: [-0.03, 0.075, 0] };
const BONES = { index: [0.04, 0.025, 0.02], middle: [0.045, 0.028, 0.02], ring: [0.042, 0.026, 0.02], pinky: [0.032, 0.02, 0.018] };
const THUMB_COCKED = [[0.02, 0.02, -0.005], [0.05, 0.045, -0.015], [0.075, 0.06, -0.015], [0.095, 0.07, -0.015]];
const STRAIGHT = [0, 0, 0];
const CURLED = [80, 100, 60];
const BENT = [25, 40, 25];
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
// Thumb per shape (Hands v2, 2026-10-02). Every shape used to share THUMB_COCKED, so the v2
// 3D pose vote (handFeatures.js) read every fist as a thumbs-up ('none'), every pinch as an
// open hand and every thumbs-down as 'none'. World landmarks only: v1 reads the thumb from the
// IMAGE landmarks (gestures.js pinch), and gunPose's world thumb is diagnostic, so v1 scores
// don't move. 'wrap' = the tip tucked against the curled index (test.js handFeatures WRAP);
// 'pinch' = the tip PINCH_GAP palm lengths in front of the index tip.
const THUMB_WRAP_TIP = [0.05, 0.085, -0.03];
const PINCH_GAP = 0.1;
const THUMB_OF = { fist: 'wrap', pinch: 'pinch' };
function buildWorldHand(flex, rot = [0, 0, 0], thumb = 'cocked') {
  const pts = Array.from({ length: 21 }, () => [0, 0, 0]);
  for (let k = 0; k < 4; k++) pts[1 + k] = THUMB_COCKED[k].slice();
  ['index', 'middle', 'ring', 'pinky'].forEach((name, f) => {
    const base = 5 + f * 4;
    let p = MCP[name].slice();
    pts[base] = p;
    let theta = 0;
    for (let b = 0; b < 3; b++) {
      theta += (flex[name][b] * Math.PI) / 180;
      const l = BONES[name][b];
      p = [p[0], p[1] + l * Math.cos(theta), p[2] - l * Math.sin(theta)];
      pts[base + b + 1] = p;
    }
  });
  if (thumb !== 'cocked') {
    const palm = Math.hypot(...pts[9]);
    pts[4] = thumb === 'wrap' ? THUMB_WRAP_TIP.slice() : [pts[8][0], pts[8][1], pts[8][2] - PINCH_GAP * palm];
    pts[3] = pts[2].map((v, i) => (v + pts[4][i]) / 2);
  }
  return pts.map((q) => rotate(q, rot));
}
const WORLD_FLEX = {
  open: { index: STRAIGHT, middle: STRAIGHT, ring: STRAIGHT, pinky: STRAIGHT },
  fist: { index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED },
  thumbdown: { index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED },
  pinch: { index: BENT, middle: STRAIGHT, ring: STRAIGHT, pinky: STRAIGHT },
  victory: { index: STRAIGHT, middle: STRAIGHT, ring: CURLED, pinky: CURLED },
  pointer: { index: STRAIGHT, middle: CURLED, ring: CURLED, pinky: CURLED }
};
const LABEL = { open: 'Open_Palm', fist: 'Closed_Fist', pinch: 'None', victory: 'Victory', thumbdown: 'Thumb_Down', pointer: 'None' };
const SIDE_ON = [0, 90, 90]; // gun-lab: the camera sees a pointer from the thumb side

// One synthetic hand in clip format. A pointer's image landmarks are the orthographic
// projection of its world hand (gun-lab projectToImage), moved so its palm centroid (what
// pointer.js aims with) sits at (x, y).
export function synthHand(spec, R = null, noise = 0) {
  const n = () => (R && noise ? (R() * 2 - 1) * noise : 0);
  const shape = spec.shape ?? 'open';
  const world = buildWorldHand(WORLD_FLEX[shape], shape === 'pointer' ? SIDE_ON : [0, 0, spec.twist ?? 0], THUMB_OF[shape]);
  let img;
  if (shape === 'pointer') {
    const k = 0.12 / 0.09, A = 16 / 9;
    img = world.map(([x, y, z]) => ({ x: 0.5 + (x * k) / A, y: 0.55 - y * k, z: z * k }));
    const c = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + img[i].x / 5, y: a.y + img[i].y / 5 }), { x: 0, y: 0 });
    img = img.map((p) => ({ x: p.x + spec.x - c.x, y: p.y + spec.y - c.y, z: p.z }));
  } else {
    img = makeImageHand({ ...spec, shape });
  }
  const label = spec.label ?? LABEL[shape];
  return {
    handedness: spec.hand ?? 'Right',
    gesture: label,
    score: label === 'None' ? 0.55 : 0.9,
    landmarks: img.map((p) => [r5(p.x + n()), r5(p.y + n()), r5(p.z)]),
    worldLandmarks: world.map(([x, y, z]) => [r5(x + n() * 0.75), r5(y + n() * 0.75), r5(z)])
  };
}

// timeline: [{ ms, hands: (u) => [spec...] }]; u goes 0..1 across the segment.
function buildClip(name, instruction, timeline, { fps = 30, seed = SEED, noise = 0.0008 } = {}) {
  const R = rng(seed + hashStr(name));
  const frames = [];
  const step = 1000 / fps;
  let t0 = 0;
  for (const seg of timeline) {
    const n = Math.max(1, Math.round(seg.ms / step));
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 1 : i / (n - 1);
      frames.push({ t: Math.round((t0 + i * step) * 100) / 100, hands: seg.hands(u, R).map((s) => synthHand(s, R, noise)) });
    }
    t0 += n * step;
  }
  return {
    schema: 'gesture-clip/1', name, gesture: name, instruction,
    synthetic: true, generator: 'docs/lab/gestures/replay.js buildSyntheticClips (gesture-lab makeHand + gun-lab buildWorldHand)',
    recordedAt: null, durationMs: frames.at(-1).t, frameCount: frames.length, fps,
    mirrored: false, video: { width: 1280, height: 720 }, frames
  };
}

const lerp = (a, b, u) => a + (b - a) * u;
const R_ = (x, y, shape, extra = {}) => ({ x, y, shape, hand: 'Right', ...extra });
const L_ = (x, y, shape, extra = {}) => ({ x, y, shape, hand: 'Left', ...extra });
const still = (ms, ...specs) => ({ ms, hands: () => specs });

// The scripted motions, shared by the synthetic and semi-real builders.
export function clipTimelines() {
  const tl = (name, instruction, timeline) => ({ name, instruction, timeline });
  const LEFT_REST = L_(0.25, 0.6, 'open');
  return [
    tl('grab-move', 'Make a right fist, move it across the frame, then open to let go.', [
      still(400, R_(0.35, 0.5, 'open')),
      still(300, R_(0.35, 0.5, 'fist')),
      { ms: 1000, hands: (u) => [R_(lerp(0.35, 0.65, u), 0.5, 'fist')] },
      still(300, R_(0.65, 0.5, 'fist')),
      still(500, R_(0.65, 0.5, 'open'))
    ]),
    tl('scale', 'Pinch both hands close together, then spread them apart and open.', [
      still(400, L_(0.42, 0.5, 'open'), R_(0.58, 0.5, 'open')),
      still(400, L_(0.42, 0.5, 'pinch'), R_(0.58, 0.5, 'pinch')),
      { ms: 600, hands: (u) => [L_(lerp(0.42, 0.25, u), 0.5, 'pinch'), R_(lerp(0.58, 0.75, u), 0.5, 'pinch')] },
      still(300, L_(0.25, 0.5, 'pinch'), R_(0.75, 0.5, 'pinch')),
      still(400, L_(0.25, 0.5, 'open'), R_(0.75, 0.5, 'open'))
    ]),
    tl('explode', 'Two open hands close together, palms out; spread them apart.', [
      still(600, L_(0.45, 0.5, 'open'), R_(0.55, 0.5, 'open')),
      { ms: 420, hands: (u) => [L_(lerp(0.45, 0.25, u), 0.5, 'open'), R_(lerp(0.55, 0.75, u), 0.5, 'open')] },
      still(500, L_(0.25, 0.5, 'open'), R_(0.75, 0.5, 'open'))
    ]),
    tl('clap', 'Two open hands apart; clap once and hold together.', [
      still(700, L_(0.2, 0.5, 'open'), R_(0.8, 0.5, 'open')),
      { ms: 200, hands: (u) => [L_(lerp(0.2, 0.47, u), 0.5, 'open'), R_(lerp(0.8, 0.53, u), 0.5, 'open')] },
      still(600, L_(0.47, 0.5, 'open'), R_(0.53, 0.5, 'open'))
    ]),
    tl('wheel-pick', 'Hold ✌ with your right hand, aim at a slot, pinch your left hand.', [
      still(300, LEFT_REST, R_(0.55, 0.5, 'open')),
      still(1000, LEFT_REST, R_(0.55, 0.5, 'victory')),
      still(300, LEFT_REST, R_(0.5, 0.47, 'pointer')),
      { ms: 400, hands: (u) => [LEFT_REST, R_(0.5, lerp(0.47, 0.35, u), 'pointer')] },
      still(400, LEFT_REST, R_(0.5, 0.35, 'pointer')),
      still(250, L_(0.25, 0.6, 'pinch'), R_(0.5, 0.35, 'pointer')),
      still(400, LEFT_REST, R_(0.5, 0.35, 'pointer'))
    ]),
    tl('undo', 'Hold a right thumbs-down 👎 still for a second, then open.', [
      still(300, R_(0.5, 0.5, 'open')),
      still(1200, R_(0.5, 0.5, 'thumbdown')),
      still(500, R_(0.5, 0.5, 'open'))
    ]),
    tl('aim-sweep', 'Point your index, curl three; sweep slowly left to right, then top to bottom.', [
      still(300, R_(0.35, 0.47, 'pointer')),
      { ms: 1500, hands: (u) => [R_(lerp(0.35, 0.65, u), 0.47, 'pointer')] },
      { ms: 600, hands: (u) => [R_(lerp(0.65, 0.5, u), lerp(0.47, 0.35, u), 'pointer')] },
      { ms: 1200, hands: (u) => [R_(0.5, lerp(0.35, 0.6, u), 'pointer')] }
    ]),
    tl('click-other', 'Right hand aims and stays still; left hand pinches once, then opens.', [
      still(1000, LEFT_REST, R_(0.5, 0.47, 'pointer')),
      still(250, L_(0.25, 0.6, 'pinch'), R_(0.5, 0.47, 'pointer')),
      still(800, LEFT_REST, R_(0.5, 0.47, 'pointer'))
    ]),
    // Hands lowered below the engagement line (pointer.js ENGAGE_ENTER_Y 0.88), drifting.
    tl('null-rest', 'Hands resting low, below the engage line; small drift.', [
      { ms: 2500, hands: (u) => [L_(0.3 + 0.03 * Math.sin(u * 6), 0.95, 'open'), R_(0.7 - 0.03 * Math.sin(u * 5), 0.96, 'fist', { label: 'None' })] },
      still(500)
    ]),
    // Talking with the hands: two raised, loosely open hands wandering, label flickering
    // Open_Palm/None, never closer than ~0.18 apart. Must fire nothing.
    tl('null-talk', 'Two raised hands gesturing loosely while talking.', [
      { ms: 3000, hands: (u, R) => {
        const w = (f, p) => 0.04 * Math.sin(u * f + p);
        const lab = () => (R() < 0.2 ? 'None' : 'Open_Palm');
        return [L_(0.36 + w(9, 0), 0.6 + w(7, 1), 'open', { label: lab() }), R_(0.64 + w(8, 2), 0.6 + w(11, 3), 'open', { label: lab() })];
      } }
    ])
  ];
}
export const buildSyntheticClips = () => clipTimelines().map((c) => buildClip(c.name, c.instruction, c.timeline));

// ---- semi-real clips: real human hand SHAPES, scripted motion ------------------------------
// Source (read-only): asl-recognizer/data/dataset.json, whose header says "Kaggle grassknoted/
// asl-alphabet ... HandLandmarker IMAGE mode": posed stills of real hands, NOT the owner's,
// stored wrist-centred, aspect-corrected, scaled by the largest wrist->point distance, left
// hands mirrored to right. Timing/jitter come from asl-recognizer/data/fs_sequences.json
// (Kaggle asl-fingerspelling, real frame-to-frame video). Pose -> letter: fist A/S, open B,
// ✌ V, pointer L/G (the brief said D/1: no '1' label exists, and the shipped gunPose check
// reads only 20% of D poses as a pointer vs 93% of L and of G, because ASL D curls the
// fingers onto the thumb tip; poseReadings keeps a D row so this stays visible), pinch F (thumb-index circle, other fingers out),
// 👎 = an A hand turned 180° in the image plane (no ASL letter is a thumbs-down).
export const SEMI_REAL_LABEL = 'real human hand shapes (Kaggle ASL alphabet via the ASL project dataset), synthetic motion';
export const POSE_LETTERS = { fist: ['A', 'S'], open: ['B'], victory: ['V'], pointer: ['L', 'G'], pinch: ['F'], thumbdown: ['A'] };
const gauss = (R) => Math.sqrt(-2 * Math.log(Math.max(1e-9, R()))) * Math.cos(2 * Math.PI * R());
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];

// Per-frame jitter and shape-change length measured on real video. jitterPalm = median |x_t -
// (x_t-1 + x_t+1)/2| per landmark in palm lengths (wrist->middle MCP); fingerspelling hands
// move all the time, so this is an upper bound on a resting hand's jitter. transitionFrames =
// runs of frames whose mean landmark step exceeds 0.08 palm (a shape change in progress).
export function motionStats(sequences) {
  const res = [], runs = [];
  for (const s of sequences) {
    const N = s.frames.filter((f) => f?.length === 21).map((f) => {
      const [w, m] = [f[0], f[9]];
      const pl = Math.hypot(m[0] - w[0], m[1] - w[1]);
      return pl > 1e-6 ? f.map((p) => [(p[0] - w[0]) / pl, (p[1] - w[1]) / pl]) : null;
    });
    let run = 0;
    for (let i = 1; i < N.length; i++) {
      const [a, b, c] = [N[i - 1], N[i], N[i + 1]];
      if (a && b && c) for (let k = 1; k < 21; k++) for (const j of [0, 1]) res.push(Math.abs(b[k][j] - (a[k][j] + c[k][j]) / 2));
      if (!a || !b) continue;
      let step = 0;
      for (let k = 1; k < 21; k++) step += Math.hypot(b[k][0] - a[k][0], b[k][1] - a[k][1]) / 20;
      if (step > 0.08) run++;
      else if (run) { runs.push(run); run = 0; }
    }
  }
  res.sort((x, y) => x - y);
  runs.sort((x, y) => x - y);
  return { jitterPalm: Math.round(q(res, 0.5) * 1e4) / 1e4, transitionFrames: runs, p50: q(runs, 0.5), p90: q(runs, 0.9), sequences: sequences.length };
}

function poseOf(sample, shape, hand) {
  const v = sample.v;
  return Array.from({ length: 21 }, (_, i) => {
    let [x, y, z] = [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
    if (shape === 'thumbdown') { x = -x; y = -y; }
    if (hand === 'Left') x = -x;
    return { x, y, z };
  });
}
// A wrist-relative pose -> clip hand: image palm 0.12 frame heights (as gesture-lab), world
// palm 0.09 m (MediaPipe world, y down like the image), jitter in palm units.
export function placePose(pts, spec, label, R = null, jitterPalm = 0, aspect = 16 / 9) {
  const palm2 = Math.hypot(pts[9].x, pts[9].y) || 1;
  const palm3 = Math.hypot(pts[9].x, pts[9].y, pts[9].z) || 1;
  const s = 0.12 / palm2, sw = 0.09 / palm3;
  let ox = spec.x, oy = spec.y;
  if (spec.shape === 'pointer') { // pointer.js aims with the palm centroid: put that at (x, y)
    const c = [0, 5, 9, 13, 17].reduce((a, i) => ({ x: a.x + pts[i].x / 5, y: a.y + pts[i].y / 5 }), { x: 0, y: 0 });
    ox -= (c.x * s) / aspect; oy -= c.y * s;
  }
  const n = (sd) => (R && sd ? gauss(R) * sd : 0);
  return {
    handedness: spec.hand ?? 'Right', gesture: label, score: label === 'None' ? 0.55 : 0.9,
    landmarks: pts.map((p) => [r5(ox + (p.x * s + n(jitterPalm * 0.12)) / aspect), r5(oy + p.y * s + n(jitterPalm * 0.12)), r5(p.z * s)]),
    worldLandmarks: pts.map((p) => [r5(p.x * sw + n(jitterPalm * 0.09)), r5(p.y * sw + n(jitterPalm * 0.09)), r5(p.z * sw)])
  };
}

export function buildSemiRealClips(dataset, sequences, { takes = 3, seed = SEED, fps = 30 } = {}) {
  const stats = motionStats(sequences);
  const byLetter = {};
  dataset.samples.forEach((smp, i) => (byLetter[smp.label] ??= []).push(i));
  const clips = [];
  for (let take = 1; take <= takes; take++) {
    for (const c of clipTimelines()) {
      const R = rng(seed + hashStr(`${c.name}.sr${take}`));
      const picks = {}; // `${hand}|${shape}` -> sample index: one person's hand keeps its pose
      const pick = (hand, shape) => {
        const k = `${hand}|${shape}`;
        if (!(k in picks)) {
          const letters = POSE_LETTERS[shape];
          const pool = byLetter[letters[Math.floor(R() * letters.length)]];
          picks[k] = pool[Math.floor(R() * pool.length)];
        }
        return poseOf(dataset.samples[picks[k]], shape, hand);
      };
      const state = {}; // per hand: current pts, transition, label
      const frames = [];
      const step = 1000 / fps;
      let t0 = 0;
      for (const seg of c.timeline) {
        const n = Math.max(1, Math.round(seg.ms / step));
        for (let i = 0; i < n; i++) {
          const u = n === 1 ? 1 : i / (n - 1);
          const specs = seg.hands(u, R);
          const hands = specs.map((spec) => {
            const hand = spec.hand ?? 'Right';
            const label = spec.label ?? LABEL[spec.shape];
            let st = state[hand];
            if (!st || st.shape !== spec.shape) {
              const to = pick(hand, spec.shape);
              // A real shape change takes a measured number of frames, sampled per change.
              const len = st ? Math.max(1, stats.transitionFrames[Math.floor(R() * stats.transitionFrames.length)]) : 0;
              st = state[hand] = { shape: spec.shape, from: st?.pts ?? to, to, k: 0, len, label: st?.label ?? label, pts: st?.pts ?? to };
            }
            if (st.k < st.len) {
              st.k++;
              const a = st.k / st.len;
              st.pts = st.from.map((p, j) => ({ x: p.x + (st.to[j].x - p.x) * a, y: p.y + (st.to[j].y - p.y) * a, z: p.z + (st.to[j].z - p.z) * a }));
              if (a >= 0.5) st.label = label; // MediaPipe's label flips about half-way through
            } else { st.pts = st.to; st.label = label; }
            return placePose(st.pts, spec, spec.label ?? st.label, R, stats.jitterPalm);
          });
          for (const h of Object.keys(state)) if (!specs.some((sp) => (sp.hand ?? 'Right') === h)) delete state[h];
          frames.push({ t: Math.round((t0 + i * step) * 100) / 100, hands });
        }
        t0 += n * step;
      }
      clips.push({
        schema: 'gesture-clip/1', name: `${c.name}.sr${take}`, gesture: c.name, instruction: c.instruction,
        semiReal: true, set: 'semi-real', label: SEMI_REAL_LABEL,
        provenance: { poses: Object.fromEntries(Object.entries(picks).map(([k, i]) => [k, `${dataset.samples[i].label}#${i}`])), jitterPalm: stats.jitterPalm, transitionFramesP50: stats.p50, transitionFramesP90: stats.p90 },
        recordedAt: null, durationMs: frames.at(-1).t, frameCount: frames.length, fps, mirrored: false, video: { width: 1280, height: 720 }, frames
      });
    }
  }
  return { clips, stats: { jitterPalm: stats.jitterPalm, transitionFramesP50: stats.p50, transitionFramesP90: stats.p90, transitions: stats.transitionFrames.length, sequences: stats.sequences } };
}

// How the shipped gestures.annotateHand reads every dataset pose of each shape, placed still at
// frame centre (no smoothing): says up front which real shapes the pipeline can't see.
export function poseReadings(dataset, G, { max = 150 } = {}) {
  const out = {};
  for (const [name, letters] of Object.entries({ ...POSE_LETTERS, 'pointer-D': ['D'] })) {
    const shape = name.split('-')[0];
    const idx = dataset.samples.map((s, i) => (letters.includes(s.label) ? i : -1)).filter((i) => i >= 0).slice(0, max);
    const r = { n: idx.length, fist: 0, pinch: 0, pointer: 0 };
    for (const i of idx) {
      const h = placePose(poseOf(dataset.samples[i], shape, 'Right'), { x: 0.5, y: 0.6, shape }, LABEL[shape]);
      const hand = { ...h, landmarks: h.landmarks.map(([x, y, z]) => ({ x, y, z })), worldLandmarks: h.worldLandmarks.map(([x, y, z]) => ({ x, y, z })) };
      G.annotateHand(hand, 16 / 9);
      r.fist += hand.fistLike ? 1 : 0; r.pinch += hand.pinch?.pinching ? 1 : 0; r.pointer += hand.pointer?.gun ? 1 : 0;
    }
    for (const k of ['fist', 'pinch', 'pointer']) r[k] = Math.round((100 * r[k]) / Math.max(1, r.n));
    out[name] = { letters: letters.join('/'), label: LABEL[shape], ...r };
  }
  return out;
}

// ---- the replay ----------------------------------------------------------------------------
export async function loadPipeline(root = '../../../', v = '') {
  const [THREE, manip, gest, smooth, ptr, wheel, gate] = await Promise.all([
    import('three'),
    import(`${root}manipulator.js${v}`),
    import(`${root}gestures.js${v}`),
    import(`${root}smoothLandmarks.js${v}`),
    import(`${root}pointer.js${v}`),
    import(`${root}toolWheel.js${v}`),
    import(`${root}holdGate.js${v}`)
  ]);
  return { THREE, ...manip, ...gest, ...smooth, ...ptr, ...wheel, ...gate };
}

const toPts = (arr) => (Array.isArray(arr) ? arr.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1], z: p[2] ?? 0 } : { ...p })) : null);
const WHEEL_ITEMS = [
  { dir: 'up', icon: '↶', label: 'Undo' }, { dir: 'down', icon: '⟲', label: 'Reset view' },
  { dir: 'upRight', icon: '📏', label: 'Tape' }, { dir: 'downRight', icon: '💥', label: 'Explode' },
  { dir: 'upLeft', icon: '👁', label: 'Look' }, { dir: 'downLeft', icon: '📌', label: 'Pin' }
];

export function replayClip(clip, P, { settleMs = 600, wheelParent = null } = {}) {
  const { THREE } = P;
  const aspect = clip.video?.width && clip.video?.height ? clip.video.width / clip.video.height : 16 / 9;
  P.resetLandmarkSmoothing();
  // gesture-lab.js runTrial's object and camera, so FIRE thresholds mean the same thing.
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5));
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 100);
  camera.position.set(0, 0.2, 2.2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const m = P.createManipulator(object, camera); // live defaults: all channels, momentum on
  // Offset from home (as gesture-lab): shrinking and a reset are both measurable.
  object.scale.setScalar(1.3);
  object.position.set(0.05, 0, 0);

  const engagement = P.createEngagement();
  const pointer = P.createPointer();
  const selector = P.createSelector();
  const undoGate = P.createHoldGate({ tiers: { undo: 'ring' } });
  const items = WHEEL_ITEMS.map((it) => ({ ...it, run: () => {} }));
  const wheel = P.createToolWheel({ items, parent: wheelParent ?? undefined });
  const W = globalThis.innerWidth || 1280, H = globalThis.innerHeight || 720;
  const pxOf = (s) => ({ x: ((s.x + 1) / 2) * W, y: ((1 - s.y) / 2) * H });

  const out = { fired: {}, channels: {}, clicks: [], wheel: [], frames: 0, durationMs: 0 };
  const T0 = 1000;
  const fire = (cls, t) => { if (!(cls in out.fired)) out.fired[cls] = Math.round(t - T0); };
  wheel.on('open', () => out.wheel.push({ t: Math.round(curT - T0), type: 'open' }));
  wheel.on('pick', (d) => out.wheel.push({ t: Math.round(curT - T0), type: 'pick', dir: d.dir }));
  wheel.on('close', (d) => out.wheel.push({ t: Math.round(curT - T0), type: 'close', why: d.why }));

  let base = null;
  const snap = () => { base = { p: object.position.clone(), q: object.quaternion.clone(), s: object.scale.clone() }; };
  snap();
  let resets = m.resetCount ?? 0;
  const ray = new THREE.Vector3(), disp = new THREE.Vector3(), lateral = new THREE.Vector3(), Rq = new THREE.Quaternion();
  const e = new THREE.Euler();
  const deg = (r) => (r * 180) / Math.PI;
  function measure(t) {
    if ((m.resetCount ?? 0) !== resets) { // a clap (or any reset) snaps to home: re-baseline
      resets = m.resetCount;
      fire('clap', t);
      snap();
      return;
    }
    ray.copy(base.p).sub(camera.position).normalize();
    disp.copy(object.position).sub(base.p);
    const along = disp.z / ray.z;
    lateral.copy(disp).sub(ray.clone().multiplyScalar(along));
    Rq.copy(object.quaternion).multiply(base.q.clone().invert());
    e.setFromQuaternion(Rq, 'YXZ');
    const ratios = ['x', 'y', 'z'].map((k) => object.scale[k] / base.s[k]);
    const r = {
      lateralCm: lateral.length() * 100, depthCm: along * 100,
      spinDeg: deg(e.y), pitchDeg: deg(e.x), rollDeg: deg(e.z),
      scaleRatio: Math.cbrt(ratios[0] * ratios[1] * ratios[2]),
      stretch: Math.max(...ratios) / Math.min(...ratios)
    };
    for (const [ch, ok] of Object.entries(FIRE)) {
      if (!out.channels[ch] && ok(r)) {
        out.channels[ch] = { tMs: Math.round(t - T0), mag: MAG[ch](r) };
        fire(CHANNEL_CLASS[ch], t);
      }
    }
  }

  let curT = T0;
  let aimMs = 0;
  let lastFrameT = null;
  const route = (click, t) => {
    if (!click) return;
    if (wheel.isOpen && wheel.click()) return; // the open wheel takes every hand click
    out.clicks.push({ t: Math.round(t - T0), via: click.via ?? 'other-pinch' });
    fire(click.via === 'hold' ? 'select' : 'click', t);
    if (pointer.state.mode !== 'off') selector.block(pxOf(click));
  };
  function display(t) {
    curT = t;
    m.tick(t);
    pointer.tick(t);
    const st = pointer.state;
    const handCursor = st.source === 'hand' && st.mode !== 'off';
    wheel.point(handCursor ? pxOf(st) : null, t);
    // Hold-select stand-in: the model's on-screen centre is the one target (60 px).
    const aiming = st.mode === 'aim' && !wheel.isOpen;
    let candidates = [];
    if (aiming) {
      const c = object.position.clone().project(camera);
      const cp = pxOf({ x: c.x, y: c.y }), cur = pxOf(st);
      const d = Math.hypot(cp.x - cur.x, cp.y - cur.y);
      candidates = [{ id: 'model', hit: d < 60, distPx: d, rankPx: d }];
    }
    const s = selector.update({ candidates, cursorPx: aiming ? pxOf(st) : null, t, canHold: st.source === 'hand' && !st.frozen });
    if (s.fired) route({ type: 'click', x: st.x, y: st.y, t, source: 'hand', via: 'hold' }, t);
    measure(t);
  }

  const frames = clip.frames ?? [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const now = T0 + f.t;
    curT = now;
    const hands = (f.hands ?? [])
      .filter((h) => Array.isArray(h.landmarks) && h.landmarks.length === 21)
      .map((h) => ({ handedness: h.handedness, gesture: h.gesture ?? 'None', score: h.score ?? 0, landmarks: toPts(h.landmarks), worldLandmarks: toPts(h.worldLandmarks) }));
    P.smoothHandLandmarks(hands, now);
    for (const h of hands) P.annotateHand(h, aspect);
    engagement.update(hands);
    m.update(hands, aspect, now);
    const click = pointer.update(hands, aspect, now);
    const fed = wheel.feed(hands, now);
    if (fed.opened) fire('wheel', now);
    const engaged = hands.filter((h) => h.engaged !== false);
    const uh = engaged.find((h) => h.gesture === 'Thumb_Down') ?? engaged[0];
    const us = undoGate.update({
      pose: uh ? (uh.gesture === 'Thumb_Down' ? 'undo' : 'other') : null,
      confidence: uh?.score ?? 0,
      wristPos: uh ? { x: uh.landmarks[0].x, y: uh.landmarks[0].y } : null,
      spanPx: uh ? Math.hypot(uh.landmarks[9].x - uh.landmarks[0].x, uh.landmarks[9].y - uh.landmarks[0].y) || 0.1 : 1,
      timestampMs: now
    });
    if (us.fired === 'undo') { fire('undo', now); if (m.undo()) snap(); }
    route(click, now);
    if (pointer.state.mode === 'aim' && pointer.state.source === 'hand' && lastFrameT !== null) {
      aimMs += now - lastFrameT;
      if (aimMs >= AIM_FIRE_MS) fire('aim', now);
    }
    lastFrameT = now;
    const next = i + 1 < frames.length ? T0 + frames[i + 1].t : now + settleMs;
    for (let t = now; t < next - 1e-6; t += 1000 / 60) display(t);
  }
  wheel.dispose();
  out.frames = frames.length;
  out.durationMs = frames.length ? frames.at(-1).t : 0;
  return out;
}

// ---- scoring -------------------------------------------------------------------------------
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };

// runs: [{ clip, synthetic, variant, expected, allowed, pending?, fired: { class: tMs } }]
// A pending run of a BUILT class gets its own row '<class> (pending)' so it never mixes into
// (or gates) the built behaviour's row; rowOf maps a row back to the class it expects.
const rowOf = (r) => (r.pending && !PENDING.includes(r.expected) ? `${r.expected} (pending)` : r.expected);
export function scoreRuns(runs) {
  const rowsSet = [...new Set(runs.map(rowOf))];
  const rowClass = Object.fromEntries(runs.map((r) => [rowOf(r), r.expected]));
  const pendingRows = new Set(runs.filter((r) => r.pending || PENDING.includes(r.expected)).map(rowOf));
  const cols = [...CLASSES, 'nothing'];
  const matrix = { rows: rowsSet, cols, counts: {}, runs: {}, rates: {} };
  const perGesture = {};
  const falseFires = Object.fromEntries(CLASSES.map((c) => [c, { runs: 0, clips: [] }]));
  const byVariant = {};
  for (const r of runs) {
    const firedCls = Object.keys(r.fired);
    const wrong = firedCls.filter((c) => c !== r.expected && !r.allowed.includes(c));
    const hit = r.expected === 'none' ? wrong.length === 0 : firedCls.includes(r.expected);
    r.wrong = wrong;
    r.pass = hit && wrong.length === 0;
    const rk = rowOf(r);
    const row = (matrix.counts[rk] ??= Object.fromEntries(cols.map((c) => [c, 0])));
    matrix.runs[rk] = (matrix.runs[rk] ?? 0) + 1;
    if (r.expected === 'none') { if (!wrong.length) row.nothing++; }
    else if (hit) row[r.expected]++;
    else row.nothing++;
    for (const c of wrong) {
      row[c]++;
      falseFires[c].runs++;
      if (!falseFires[c].clips.includes(r.clip)) falseFires[c].clips.push(r.clip);
    }
    const g = (perGesture[rk] ??= { clips: [], runs: 0, fires: 0, misses: 0, falseFireRuns: 0, ttf: [] });
    if (!g.clips.includes(r.clip)) g.clips.push(r.clip);
    g.runs++;
    if (r.expected !== 'none') {
      if (hit) { g.fires++; g.ttf.push(r.fired[r.expected]); } else g.misses++;
    }
    if (wrong.length) g.falseFireRuns++;
    const v = (byVariant[r.variant] ??= { runs: 0, pass: 0, failed: [] });
    v.runs++;
    if (r.pass) v.pass++; else v.failed.push(r.clip);
  }
  for (const g of Object.values(perGesture)) {
    g.ttfMedianMs = median(g.ttf);
    g.ttfMaxMs = g.ttf.length ? Math.max(...g.ttf) : null;
    delete g.ttf;
  }
  const failures = [];
  const pendingLines = []; // confusions in a not-yet-built class's row: reported, never gating
  for (const row of matrix.rows) {
    matrix.rates[row] = {};
    for (const c of cols) {
      const rate = matrix.counts[row][c] / matrix.runs[row];
      matrix.rates[row][c] = Math.round(rate * 1000) / 1000;
      const off = c !== rowClass[row] && c !== 'nothing';
      if (off && rate > OFF_DIAGONAL_MAX) (pendingRows.has(row) ? pendingLines : failures).push(`${row} -> ${c} in ${Math.round(rate * 100)}% of runs (> ${OFF_DIAGONAL_MAX * 100}%)`);
    }
  }
  const nulls = {}; // one gate line per null clip: which variants fired what
  for (const r of runs) {
    if (r.clip.split('.')[0].startsWith('null-') && Object.keys(r.fired).length) {
      const n = (nulls[r.clip] ??= { runs: 0, of: 0, fired: new Set() });
      n.runs++;
      Object.keys(r.fired).forEach((k) => n.fired.add(k));
    }
  }
  for (const [clip, n] of Object.entries(nulls)) {
    const of = runs.filter((r) => r.clip === clip).length;
    failures.push(`null clip ${clip} fired ${[...n.fired].join(', ')} in ${n.runs}/${of} runs`);
  }
  return { perGesture, falseFires, matrix, byVariant, gate: { pass: failures.length === 0, failures, pending: pendingLines, offDiagonalMax: OFF_DIAGONAL_MAX } };
}

// ---- compare + markdown --------------------------------------------------------------------
// A report has one score block per clip SET ('owner' = clip-lab ground-truth takes, 'real' =
// clip-lab demo-hand clips, 'semi-real', 'synthetic'),
// so synthetic results never dilute or flatter real ones: report.sets[name] = { label,
// perGesture, falseFires, matrix, byVariant, gate }; report.gate passes only if every set does.
function diffSet(prefix, o = {}, c = {}, lines) {
  if (o.gate?.pass !== c.gate?.pass) lines.push(`${prefix}gate ${o.gate?.pass ? 'PASS' : o.gate ? 'FAIL' : '—'} -> ${c.gate?.pass ? 'PASS' : 'FAIL'}`);
  for (const [g, s] of Object.entries(c.perGesture ?? {})) {
    const p = o.perGesture?.[g];
    if (!p) { lines.push(`${prefix}${g}: new (${s.fires}/${s.runs} fire)`); continue; }
    if (p.fires !== s.fires || p.misses !== s.misses || p.falseFireRuns !== s.falseFireRuns) {
      lines.push(`${prefix}${g}: fires ${p.fires}->${s.fires}, misses ${p.misses}->${s.misses}, false-fire runs ${p.falseFireRuns}->${s.falseFireRuns} (of ${s.runs})`);
    }
    if (p.ttfMedianMs != null && s.ttfMedianMs != null && Math.abs(p.ttfMedianMs - s.ttfMedianMs) >= 50) lines.push(`${prefix}${g}: median time to fire ${p.ttfMedianMs}->${s.ttfMedianMs} ms`);
  }
  for (const row of c.matrix?.rows ?? []) {
    for (const col of c.matrix.cols) {
      const a = o.matrix?.counts?.[row]?.[col] ?? 0, b = c.matrix.counts[row][col];
      if (a !== b && col !== row && col !== 'nothing') lines.push(`${prefix}matrix ${row} -> ${col}: ${a} -> ${b}`);
    }
  }
}
export function diffReports(old, cur) {
  if (!old) return ['no previous report to compare against'];
  const lines = [];
  // Reports from before sets existed hold one top-level block: compare it as 'synthetic'.
  const setsOf = (r) => r.sets ?? (r.perGesture ? { synthetic: r } : {});
  const os = setsOf(old), cs = setsOf(cur);
  for (const [name, c] of Object.entries(cs)) diffSet(`[${name}] `, os[name], c, lines);
  const oldRuns = new Map((old.runs ?? []).map((r) => [`${r.clip}|${r.variant}`, r]));
  for (const r of cur.runs ?? []) {
    const o = oldRuns.get(`${r.clip}|${r.variant}`);
    if (o && o.pass !== r.pass) lines.push(`${r.clip} [${r.variant}] ${o.pass ? 'pass' : 'FAIL'} -> ${r.pass ? 'pass' : 'FAIL'}`);
  }
  return lines.length ? lines : ['nothing moved'];
}

const pct = (x) => (x == null ? '—' : `${Math.round(100 * x)}%`);
function renderSet(md, name, S) {
  md.push(`## Set: ${name} — ${S.label}`, '', `Gate: **${S.gate.pass ? 'PASS' : 'FAIL'}** (${S.clips.length} clips, ${Object.values(S.byVariant).reduce((a, v) => a + v.runs, 0)} runs)`, '');
  for (const f of S.gate.failures) md.push(`- ${f}`);
  for (const f of S.gate.pending ?? []) md.push(`- (pending, not gating) ${f}`);
  if (S.gate.failures.length || S.gate.pending?.length) md.push('');
  if (S.poseReadings) {
    md.push('How the shipped gestures.annotateHand reads the source poses (still, frame centre):', '', '| pose | letters | MediaPipe label used | n | read as fist | pinch | pointer |', '|---|---|---|---|---|---|---|');
    for (const [k, r] of Object.entries(S.poseReadings)) md.push(`| ${k} | ${r.letters} | ${r.label} | ${r.n} | ${r.fist}% | ${r.pinch}% | ${r.pointer}% |`);
    md.push('');
  }
  if (S.motion) md.push(`Motion model from real video: per-frame jitter ${S.motion.jitterPalm} palm lengths (median, an upper bound), shape changes take ${S.motion.transitionFramesP50} frames median / ${S.motion.transitionFramesP90} p90 (${S.motion.transitions} transitions in ${S.motion.sequences} sequences).`, '');
  md.push('| expected | clips | runs | fires | misses | runs with a false fire | time to fire median / max |', '|---|---|---|---|---|---|---|');
  for (const [g, s] of Object.entries(S.perGesture)) {
    md.push(`| ${g}${MODELLED.includes(g) ? ' (modelled)' : ''}${PENDING.includes(g) ? ' (pending: not built)' : ''} | ${s.clips.length} | ${s.runs} | ${g === 'none' ? '—' : `${s.fires} (${pct(s.fires / s.runs)})`} | ${g === 'none' ? '—' : s.misses} | ${s.falseFireRuns} | ${s.ttfMedianMs ?? '—'} / ${s.ttfMaxMs ?? '—'} ms |`);
  }
  const ff = Object.entries(S.falseFires).filter(([, f]) => f.runs);
  md.push('', `False fires (fired where not expected or allowed): ${ff.length ? ff.map(([c, f]) => `**${c}** ${f.runs} runs (${f.clips.join(', ')})`).join('; ') : 'none'}.`, '');
  const M = S.matrix;
  const cols = M.cols.filter((c) => M.rows.includes(c) || c === 'nothing' || M.rows.some((r) => M.counts[r][c]));
  md.push(`| expected \\ fired | runs | ${cols.join(' | ')} |`, `|---|---|${cols.map(() => '---').join('|')}|`);
  for (const r of M.rows) {
    md.push(`| **${r}** | ${M.runs[r]} | ${cols.map((c) => { const v = M.counts[r][c]; const s = v ? pct(M.rates[r][c]) : '·'; return (c === r.replace(/ \(pending\)$/, '') || (r === 'none' && c === 'nothing')) ? `**${s}**` : (v && c !== 'nothing' && M.rates[r][c] > OFF_DIAGONAL_MAX ? `**${s}!**` : s); }).join(' | ')} |`);
  }
  md.push('', '| variant | pass | failed clips |', '|---|---|---|');
  for (const [v, s] of Object.entries(S.byVariant)) md.push(`| ${v} | ${s.pass}/${s.runs} | ${[...new Set(s.failed)].join(', ') || '—'} |`);
  md.push('');
}

export function renderMd(report, diff = null) {
  const md = [];
  md.push('# Gesture replay report', '');
  if (report.ownerClips) md.push(`Owner ground-truth takes: ${report.ownerClips} scored${report.excludedTakes ? `, ${report.excludedTakes} marked bad in clip-lab and left out` : ''}. Pending classes (${PENDING.join(', ')}) are not built yet: their rows are shown but never fail the gate.`, '');
  if (!report.realClips && !report.ownerClips) md.push('> **NO REAL CLIPS YET.** assets/gesture-clips/ is empty, so nothing below is the owner\'s hands. "semi-real" = real human hand SHAPES from the Kaggle ASL alphabet set (via the ASL project; not the owner) moved along scripted paths; "synthetic" = model hands. They prove the harness and where the code\'s thresholds sit, not how the owner\'s hands perform. Re-run after the owner records clips in clip-lab.', '');
  md.push(`Generated ${report.generated} by \`docs/lab/gestures/replay-lab.html\` (tree ${report.commit ?? '?'}${report.dirty ? '+dirty' : ''}). Seed ${report.seed}. ${report.clips.length} clips × ${report.variants.length} variants (${report.variants.join(', ')}) = ${report.runs.length} runs.`, '');
  md.push(`Pipeline: smoothLandmarks → gestures.annotateHand → engagement → manipulator.update/tick → pointer (aim, pinch, other-hand click) → toolWheel (✌ holdGate) → undo (👎 holdGate, **modelled: not wired live**) → selector (hold-select on the model centre). "Fires" = gesture-lab thresholds (move >1 cm, push >1 cm, spin/tilt >2°, scale >3% uniform, explode >3% stretch), clap = a reset, aim = cursor shown ≥${AIM_FIRE_MS} ms. Time to fire = ms from the clip's FIRST frame (includes its lead-in). A set's gate fails if any off-diagonal cell is over ${OFF_DIAGONAL_MAX * 100}% of its row's runs (ASL #13f) or any null-* clip fires anything in any run. Matrix: diagonal = expected fired, "nothing" = missed (for \`none\`: correctly nothing); rows can sum past 100%; allowed side effects (aim before a click) are not counted.`, '');
  md.push(`## Overall gate: **${report.gate.pass ? 'PASS' : 'FAIL'}** (${Object.entries(report.sets).map(([n, s]) => `${n} ${s.gate.pass ? 'PASS' : 'FAIL'}`).join(', ')})`, '');
  for (const [name, S] of Object.entries(report.sets)) renderSet(md, name, S);
  md.push('## Per clip', '');
  for (const c of report.clips) {
    const rs = report.runs.filter((r) => r.clip === c.name);
    md.push(`- **${c.name}** (${c.set})${c.mapped ? '' : ' (name not in EXPECT table)'}: expect ${c.expected}${c.pending ? ' (pending)' : ''}${c.allowed.length ? ` (allowed ${c.allowed.join(', ')})` : ''}. ` +
      rs.map((r) => `${r.variant} ${r.pass ? '✓' : '✗'}${Object.keys(r.fired).length ? ` [${Object.entries(r.fired).map(([k, t]) => `${k}@${t}`).join(' ')}]` : ' [nothing]'}`).join(' · '));
  }
  if (diff) md.push('', `## Compare (vs ${report.comparedTo ?? 'previous report'})`, '', ...diff.map((l) => `- ${l}`));
  md.push('');
  return md.join('\n');
}

// ---- Node CLI ------------------------------------------------------------------------------
const isCli = typeof window === 'undefined' && typeof process !== 'undefined' && /replay\.js$/.test(process.argv?.[1] ?? '');
if (isCli) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.resolve(HERE, '../../..');
  const args = process.argv.slice(2);
  const arg = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o) + '\n'); };
  // fixtures/index.json lists every fixture set; each writer replaces only its own set's rows.
  const indexPath = path.join(HERE, 'fixtures', 'index.json');
  const writeSet = (set, clips, extra = {}) => {
    let idx = { schema: 'gesture-clip-index/1', clips: [], sets: {} };
    try { idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch { /* first write */ }
    idx.sets ??= {};
    idx.note = 'Fixtures for replay-lab (replay.js --fixtures / --semireal). NOT the owner\'s recorded clips.';
    idx.clips = (idx.clips ?? []).filter((e) => (e.set ?? 'synthetic') !== set);
    const dir = set === 'synthetic' ? 'synthetic' : 'semi-real';
    for (const c of clips) {
      writeJson(path.join(HERE, 'fixtures', dir, `${c.name}.json`), c);
      idx.clips.push({ name: c.name, file: `${dir}/${c.name}.json`, set, synthetic: set === 'synthetic', frames: c.frames.length, durationMs: c.durationMs });
    }
    idx.sets[set] = extra;
    writeJson(indexPath, idx);
    console.log(`wrote ${clips.length} ${set} clips to fixtures/${dir}/`);
  };
  if (args.includes('--fixtures')) writeSet('synthetic', buildSyntheticClips(), { label: 'synthetic hands (gesture-lab makeHand + gun-lab buildWorldHand), synthetic motion' });
  if (args.includes('--semireal')) {
    const asl = path.resolve(arg('--asl', path.join(ROOT, '..', 'asl-recognizer', 'data')));
    const dataset = JSON.parse(fs.readFileSync(path.join(asl, 'dataset.json'), 'utf8'));
    const sequences = JSON.parse(fs.readFileSync(path.join(asl, 'fs_sequences.json'), 'utf8')).sequences;
    const { clips, stats } = buildSemiRealClips(dataset, sequences, { takes: +arg('--takes', 3) });
    const G = await import(new URL('../../../gestures.js', import.meta.url).href);
    const readings = poseReadings(dataset, G);
    writeSet('semi-real', clips, { label: SEMI_REAL_LABEL, source: `${dataset.source} (asl-recognizer/data/dataset.json, ${dataset.count} samples); motion stats from asl-recognizer/data/fs_sequences.json (${sequences.length} sequences)`, motion: stats, poseReadings: readings });
    console.log('motion', JSON.stringify(stats), '\nposeReadings (% of poses read as fist / pinch / pointer)');
    for (const [k, r] of Object.entries(readings)) console.log(`  ${k.padEnd(9)} ${r.letters.padEnd(4)} n=${r.n} fist ${r.fist}% pinch ${r.pinch}% pointer ${r.pointer}%`);
  }
  if (args.includes('--write')) {
    const from = arg('--from', path.join(ROOT, 'docs/testing/runs/replay-lab/latest.json'));
    const outDir = path.resolve(arg('--out', HERE));
    const rec = JSON.parse(fs.readFileSync(from, 'utf8'));
    const report = rec.attachments?.report;
    if (!report || report.schema !== SCHEMA) { console.error(`no ${SCHEMA} report attached in ${from}`); process.exit(2); }
    const cmpPath = arg('--compare', path.join(outDir, 'report.json'));
    let old = null;
    try { old = JSON.parse(fs.readFileSync(cmpPath, 'utf8')); } catch { /* first report */ }
    report.comparedTo = old ? `${path.relative(ROOT, cmpPath)} (${old.generated})` : null;
    const diff = diffReports(old, report);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1) + '\n');
    fs.writeFileSync(path.join(outDir, 'REPORT.md'), renderMd(report, diff));
    console.log(`gate ${report.gate.pass ? 'PASS' : 'FAIL'} · wrote ${path.relative(ROOT, outDir)}/report.json + REPORT.md\n--compare: ${diff.join('\n  ')}`);
  }
}

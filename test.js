// Regression suite — every check this session ran once in a browser console and then threw
// away, including several that caught real bugs (the release-doesn't-release grab, the
// palm-length units on clap, the footprint algorithm's 94ms→30.7ms rewrite). A check that
// only exists in scrollback protects nothing the next time a file changes. This page is
// those same checks, kept.
//
// No test framework, on purpose — this project has no build step and no dependencies
// beyond what ships to the browser (see CLAUDE.md's hard constraints), and pulling one in
// just to assert numbers would be the kind of scope creep that file asks to flag first.
// A run is: open test.html, read the page.
//
// This does NOT replace a real webcam session. Every number here is synthetic hand
// geometry — it proves the code does what it is supposed to given known inputs, not that
// the thresholds feel right on an actual hand. See ROADMAP.md.

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

const resultsEl = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const rawEl = document.getElementById('raw');

const groups = [];
let currentGroup = null;
let passCount = 0;
let failCount = 0;

function group(name, fn) {
  currentGroup = { name, cases: [] };
  groups.push(currentGroup);
  try {
    fn();
  } catch (err) {
    currentGroup.cases.push({ name: '(group threw)', pass: false, detail: String(err) });
  }
}

// `within` is a fraction of `expected` (e.g. 0.02 = 2%), not an absolute — so the same test
// stays meaningful whether it is checking centimetres or ratios.
function check(name, actual, expected, within = 0) {
  const tolerance = within * Math.abs(expected);
  const pass = Math.abs(actual - expected) <= (tolerance || 1e-9);
  currentGroup.cases.push({
    name, pass,
    detail: pass
      ? `${fmt(actual)}`
      : `got ${fmt(actual)}, expected ${fmt(expected)}${within ? ` ±${(within * 100).toFixed(0)}%` : ''}`
  });
  pass ? passCount++ : failCount++;
}

// `detail` should describe what ACTUALLY happened (a measured value, a computed angle),
// not a canned "why this would fail" string -- that reads as true-but-misleading when the
// check passes, which the first version of this file did for two of its own checks
// ("a dominant surface is found: OK ... no surfaces detected").
function checkTrue(name, condition, detail = '') {
  currentGroup.cases.push({ name, pass: !!condition, detail });
  condition ? passCount++ : failCount++;
}

function fmt(n) {
  return typeof n === 'number' ? (Number.isInteger(n) ? n : n.toFixed(4)) : String(n);
}

function render() {
  resultsEl.innerHTML = '';
  for (const g of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'group';
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = g.name;
    wrap.appendChild(title);
    for (const c of g.cases) {
      const row = document.createElement('div');
      row.className = `case ${c.pass ? 'pass' : 'fail'}`;
      row.innerHTML =
        `<span class="mark">${c.pass ? 'OK' : 'FAIL'}</span>` +
        `<span class="name">${c.name}</span>` +
        `<span class="detail">${c.detail}</span>`;
      wrap.appendChild(row);
    }
    resultsEl.appendChild(wrap);
  }
  summaryEl.textContent = `${passCount} passed, ${failCount} failed`;
  summaryEl.className = failCount === 0 ? 'pass' : 'fail';
}

// ---------------------------------------------------------------------------------------
// Synthetic hand geometry. Only the landmarks the manipulator and gestures actually read are
// populated (wrist, index/pinky MCP for span and twist, middle MCP for palm length) — see
// gestures.js for which indices those are. `jitter` reproduces realistic per-frame tracking
// noise (~0.002 normalized units, measured against real MediaPipe output earlier this
// session) so the drift tests are checking the same failure mode that was actually found.
let seed = 1;
function rnd() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function hand(x, y, twistDeg, kind, jitter = 0, palm = 0.12) {
  const j = () => (jitter ? (rnd() - 0.5) * 2 * jitter : 0);
  const t = (twistDeg * Math.PI) / 180;
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x: x + j(), y: y + j(), z: 0 });
  lm[0] = { x: x + j(), y: y + j(), z: 0 };
  lm[9] = { x: x + j(), y: y - palm + j(), z: 0 };
  lm[5] = { x: x + 0.05 * Math.cos(t) + j(), y: y - 0.08 + 0.05 * Math.sin(t) + j(), z: 0 };
  lm[17] = { x: x - 0.05 * Math.cos(t) + j(), y: y - 0.08 - 0.05 * Math.sin(t) + j(), z: 0 };
  const fist = kind === 'fist';
  const pinching = kind === 'pinch';
  return {
    gesture: fist ? 'Closed_Fist' : pinching ? 'None' : 'Open_Palm',
    handedness: 'Right',
    landmarks: lm,
    pinch: { pinching },
    fistLike: fist
  };
}

const ALL_CHANNELS = ['move', 'spin', 'tilt', 'push', 'scale', 'explode', 'clap'];
const REALISTIC_JITTER = 0.002;

async function main() {
  const V = `?v=${Date.now()}`;
  const { createManipulator, MODE } = await import(`./manipulator.js${V}`);
  const measure = await import(`./measure.js${V}`);
  const gestures = await import(`./gestures.js${V}`);

  // A bare mesh and camera, not a full scene — the manipulator only needs an Object3D with
  // position/rotation/scale and a camera with a real fov/aspect/position for its
  // screen-to-world math.
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5));
  const camera = new THREE.PerspectiveCamera(45, 1.78, 0.01, 100);
  camera.position.set(0, 0.2, 2.2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  const IDENT = new THREE.Quaternion();

  group('Gesture isolation — the practice-mode guarantee', () => {
    const m = createManipulator(object, camera);
    const cfg = (channels) => m.configure({ channels, sensitivity: 1, momentum: false, triggerFrames: 3 });

    m.reset();
    cfg(['spin']);
    let t = 1000;
    const motion = [
      [0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, 0.5, 0],
      [0.55, 0.5, 10], [0.6, 0.5, 20], [0.65, 0.5, 30], [0.7, 0.5, 40]
    ];
    for (const [x, y, tw] of motion) { m.update([hand(x, y, tw, 'fist')], 1.78, t); t += 16.7; }
    check('spin-only channel does not move', object.position.length(), 0, 0);
    checkTrue('spin-only channel does rotate', object.quaternion.angleTo(IDENT) > 0.01,
      `rotated ${object.quaternion.angleTo(IDENT).toFixed(3)} rad`);

    m.reset();
    cfg(['move']);
    t = 1000;
    for (const [x, y, tw] of motion) { m.update([hand(x, y, tw, 'fist')], 1.78, t); t += 16.7; }
    check('move-only channel does not rotate', object.quaternion.angleTo(IDENT), 0, 0);
    checkTrue('move-only channel does move', object.position.length() > 0.005,
      `moved ${(object.position.length() * 100).toFixed(1)}cm`);

    m.reset();
    cfg(['scale']);
    t = 1000;
    for (const [x, y, tw] of motion) { m.update([hand(x, y, tw, 'fist')], 1.78, t); t += 16.7; }
    check('a fist with only scale armed: no movement', object.position.length(), 0, 0);
    check('a fist with only scale armed: no rotation', object.quaternion.angleTo(IDENT), 0, 0);
  });

  group('Tracking-noise robustness', () => {
    const m = createManipulator(object, camera);
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: true, triggerFrames: 3 });
    const home = object.position.clone();
    let t = 1000;
    for (let i = 0; i < 90; i++) { m.update([hand(0.5, 0.5, 0, 'fist', REALISTIC_JITTER)], 1.78, t); t += 16.7; }
    check('a motionless fist with realistic jitter does not drift',
      object.position.distanceTo(home) * 100, 0, 0.005 || undefined);
    checkTrue('drift stays under 1cm', object.position.distanceTo(home) * 100 < 1,
      `${(object.position.distanceTo(home) * 100).toFixed(2)}cm`);
    m.reset();
  });

  group('Deliberate motion still works', () => {
    const m = createManipulator(object, camera);
    m.reset();
    m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    for (let i = 0; i < 10; i++) { m.update([hand(0.3, 0.5, 0, 'fist', REALISTIC_JITTER)], 1.78, t); t += 16.7; }
    const start = object.position.clone();
    for (let i = 1; i <= 60; i++) { m.update([hand(0.3 + 0.005 * i, 0.5, 0, 'fist', REALISTIC_JITTER)], 1.78, t); t += 16.7; }
    checkTrue('a hand sweep moves the object noticeably', object.position.distanceTo(start) * 100 > 10,
      `${(object.position.distanceTo(start) * 100).toFixed(1)}cm`);

    m.reset();
    m.configure({ channels: ['push'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    for (let i = 0; i < 10; i++) { m.update([hand(0.5, 0.5, 0, 'fist', REALISTIC_JITTER, 0.08)], 1.78, t); t += 16.7; }
    const d0 = camera.position.distanceTo(object.position);
    for (let i = 1; i <= 60; i++) { m.update([hand(0.5, 0.5, 0, 'fist', REALISTIC_JITTER, 0.08 + 0.05 * (i / 60))], 1.78, t); t += 16.7; }
    checkTrue('a hand approaching the camera pulls the object closer',
      camera.position.distanceTo(object.position) < d0,
      `distance changed ${((camera.position.distanceTo(object.position) - d0) * 100).toFixed(1)}cm`);
    m.reset();
  });

  group('Release actually releases', () => {
    const m = createManipulator(object, camera);
    m.reset();
    m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    for (let i = 0; i < 10; i++) { m.update([hand(0.5, 0.5, 0, 'fist', 0)], 1.78, t); t += 16.7; }
    const held = object.position.clone();
    for (let i = 0; i < 6; i++) { m.update([hand(0.5 + 0.05 * (i + 1), 0.5, 0, 'open', 0)], 1.78, t); t += 16.7; }
    check('opening the hand stops further movement', object.position.distanceTo(held) * 100, 0, 0);
    m.reset();
  });

  group('Hand-reorder robustness', () => {
    const m = createManipulator(object, camera);
    m.reset();
    m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    const gap = 0.10; // close together, where a naive first-match pick could swap hands
    const A = () => hand(0.5 - gap / 2, 0.5, 0, 'fist');
    const B = () => hand(0.5 + gap / 2, 0.5, 0, 'fist');
    let t = 1000;
    for (let i = 0; i < 10; i++) { m.update([A(), B()], 1.78, t); t += 16.7; }
    const settled = object.position.clone();
    for (let i = 0; i < 6; i++) { m.update(i % 2 ? [A(), B()] : [B(), A()], 1.78, t); t += 16.7; }
    check('two close fists reordering between frames does not jump the object',
      object.position.distanceTo(settled) * 100, 0, 0);
    m.reset();
  });

  group('Scale, explode, tilt, clap', () => {
    const m = createManipulator(object, camera);

    m.reset();
    m.configure({ channels: ['scale'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    const s0 = object.scale.x;
    for (let i = 0; i < 8; i++) { m.update([hand(0.45, 0.5, 0, 'pinch'), hand(0.55, 0.5, 0, 'pinch')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 25; i++) { m.update([hand(0.45 - 0.008 * i, 0.5, 0, 'pinch'), hand(0.55 + 0.008 * i, 0.5, 0, 'pinch')], 1.78, t); t += 16.7; }
    checkTrue('two-hand pinch apart grows the object', object.scale.x > s0 + 0.3, `scale.x=${object.scale.x.toFixed(2)}`);

    // Explode's stretch axis follows the actual direction the hands separate along --
    // reported live as "keeps exploding vertically and not horizontally" when it was
    // hard-coded to scale.y regardless of motion. Both directions get their own case.
    m.reset();
    m.configure({ channels: ['explode'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    const x0 = object.scale.x;
    for (let i = 0; i < 8; i++) { m.update([hand(0.45, 0.5, 0, 'open'), hand(0.55, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 25; i++) { m.update([hand(0.45 - 0.008 * i, 0.5, 0, 'open'), hand(0.55 + 0.008 * i, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('hands apart HORIZONTALLY stretches width (scale.x)', object.scale.x > x0 + 0.3, `scale.x=${object.scale.x.toFixed(2)}`);

    m.reset();
    m.configure({ channels: ['explode'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    const y0 = object.scale.y;
    for (let i = 0; i < 8; i++) { m.update([hand(0.5, 0.35, 0, 'open'), hand(0.5, 0.65, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 25; i++) { m.update([hand(0.5, 0.35 - 0.008 * i, 0, 'open'), hand(0.5, 0.65 + 0.008 * i, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('hands apart VERTICALLY stretches height (scale.y)', object.scale.y > y0 + 0.3, `scale.y=${object.scale.y.toFixed(2)}`);

    m.reset();
    m.configure({ channels: ['tilt'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    for (let i = 0; i < 10; i++) { m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    const q0 = object.quaternion.clone();
    for (let i = 1; i <= 40; i++) { m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65, 0.5 - 0.006 * i, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('raising the second hand tilts the object', object.quaternion.angleTo(q0) > 0.2,
      `${(object.quaternion.angleTo(q0) * 180 / Math.PI).toFixed(1)}°`);

    // Clap: verified against the actual palm-length units handSpan() uses (see gestures.js),
    // not a 0-1 screen fraction — that unit mismatch was a real bug found this session.
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    object.position.x += 0.3;
    object.scale.multiplyScalar(1.4);
    t = 1000;
    for (let i = 0; i < 5; i++) { m.update([hand(0.20, 0.5, 0, 'open'), hand(0.80, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 12; i++) {
      const sep = 0.60 + (0.06 - 0.60) * (i / 12);
      m.update([hand(0.5 - sep / 2, 0.5, 0, 'open'), hand(0.5 + sep / 2, 0.5, 0, 'open')], 1.78, t);
      t += 16.7;
    }
    check('a fast clap resets scale to 1', object.scale.x, 1, 0.02);
    check('a fast clap resets position to origin', object.position.length(), 0, 0);

    // and a slow bring-together must NOT be mistaken for a clap. Channels restricted to
    // just clap: the same open hands also satisfy explode's trigger, and explode
    // legitimately shrinking the object as hands close together is a different behavior
    // that would otherwise contaminate this assertion (both end at scale 1.0, for
    // unrelated reasons -- verified directly by comparing ['clap','explode'] against
    // ['clap'] alone).
    m.reset();
    m.configure({ channels: ['clap'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    object.scale.multiplyScalar(1.4);
    t = 1000;
    for (let i = 0; i < 5; i++) { m.update([hand(0.20, 0.5, 0, 'open'), hand(0.80, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 12; i++) {
      const sep = 0.60 + (0.06 - 0.60) * (i / 12);
      m.update([hand(0.5 - sep / 2, 0.5, 0, 'open'), hand(0.5 + sep / 2, 0.5, 0, 'open')], 1.78, t);
      t += 2000 / 12; // same motion, spread over 2 seconds instead of ~200ms
    }
    check('a slow bring-together does not trigger a reset', object.scale.x, 1.4, 0.02);
    m.reset();
  });

  group('Mode-switch rigidity — an active gesture resists a brief interruption', () => {
    // Reported live as "two hands, it breaks out": mid-tilt, a single misread frame where
    // the second (open) hand briefly LOOKED like it was pinching was enough to hijack
    // control into transform, using the same short confirmation window a fresh gesture
    // gets from idle. Two things have to both be true for the fix to be right: a brief
    // flicker must NOT switch modes, but a genuine, sustained gesture change still must.
    const m = createManipulator(object, camera);

    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    // establish a confirmed, active grab first
    for (let i = 0; i < 10; i++) { m.update([hand(0.5, 0.5, 0, 'fist')], 1.78, t); t += 16.7; }
    checkTrue('grab is confirmed active before the interruption test', m.mode === MODE.GRAB, `mode=${m.mode}`);

    // a single-frame flicker: both hands suddenly read as pinching for ONE call, then back
    for (let i = 0; i < 3; i++) {
      m.update([hand(0.35, 0.5, 0, 'pinch'), hand(0.65, 0.5, 0, 'pinch')], 1.78, t);
      t += 16.7;
    }
    checkTrue('a brief pinch flicker does not hijack an active grab', m.mode === MODE.GRAB, `mode=${m.mode}`);

    // a genuine, sustained pinch -- held well past SWITCH_AWAY_MS -- should still take over
    for (let i = 0; i < 25; i++) {
      m.update([hand(0.35, 0.5, 0, 'pinch'), hand(0.65, 0.5, 0, 'pinch')], 1.78, t);
      t += 16.7;
    }
    checkTrue('a sustained pinch still switches into transform', m.mode === MODE.TRANSFORM, `mode=${m.mode}`);
    m.reset();
  });

  group('Tilt — roll (second hand left/right), added after live feedback', () => {
    const m = createManipulator(object, camera);
    m.reset();
    m.configure({ channels: ['tilt'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    for (let i = 0; i < 10; i++) { m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    const q0 = object.quaternion.clone();
    // second hand sweeps LEFT (x decreasing), not up/down this time
    for (let i = 1; i <= 40; i++) { m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65 - 0.006 * i, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('moving the second hand left/right also tilts the object', object.quaternion.angleTo(q0) > 0.2,
      `${(object.quaternion.angleTo(q0) * 180 / Math.PI).toFixed(1)}°`);
    m.reset();
  });

  group('Frame-rate independence — the cause behind "gets stuck" and "janky"', () => {
    // Real webcam tracking does not call update() at a fixed interval; it drops frames
    // under load. Every rate limit in manipulator.js was rewritten to be a genuine
    // per-second bound checked against real elapsed time specifically because a per-call
    // bound rejects perfectly normal motion whenever the gap between calls happens to be
    // longer than usual. This proves it: the SAME physical motion, delivered at two very
    // different (but each internally steady) frame rates, should produce close to the
    // SAME result -- not one that silently stalls at the slower rate. This exact class of
    // bug shipped once already this session (an explode rate cap ten times too strict,
    // caught only because a synthetic test happened to run at a demanding pace) --
    // this check exists so a future threshold mistake shows up here instead of live.
    function sweepAt(hz) {
      const m = createManipulator(object, camera);
      m.reset();
      m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
      const stepMs = 1000 / hz;
      let t = 1000;
      for (let i = 0; i < 10; i++) { m.update([hand(0.30, 0.5, 0, 'fist')], 1.78, t); t += stepMs; }
      const start = object.position.clone();
      const totalMs = 1000; // sweep the same real 1 second of motion regardless of rate
      const steps = Math.round(totalMs / stepMs);
      for (let i = 1; i <= steps; i++) {
        m.update([hand(0.30 + 0.3 * (i / steps), 0.5, 0, 'fist')], 1.78, t);
        t += stepMs;
      }
      // Measure BEFORE resetting -- reset() snaps position back to home immediately, and
      // doing it first here made an early version of this very test read 0.0cm at every
      // frame rate regardless of what actually happened, a bug in the test's own statement
      // order rather than in the manipulator.
      const moved = object.position.distanceTo(start);
      m.reset();
      return moved;
    }

    const at60 = sweepAt(60);
    const at24 = sweepAt(24); // a genuinely choppy real camera, not a dropped-frame edge case
    checkTrue('the same 1-second sweep moves the object a similar amount at 60fps and 24fps',
      Math.abs(at60 - at24) / at60 < 0.35,
      `60fps=${(at60 * 100).toFixed(1)}cm, 24fps=${(at24 * 100).toFixed(1)}cm`);
  });

  group('Clap survives a transient pinch misread mid-close', () => {
    // Reported live: clap "barely registered, had to try many times". Reproduced directly:
    // a real clap's closing speed clears the threshold easily on its own (measured through
    // landmark smoothing too -- that damps it only ~6%, nowhere near enough to explain the
    // report) -- but the whole in-progress measurement was thrown away the instant EITHER
    // hand read as pinching for even one frame, and fast clapping hand shapes are exactly
    // the pose that can transiently misread as a pinch. Combined with a real, imperfect
    // camera frame rate (a documented risk since Phase 1, meaning as few as 3-4 samples
    // across the whole clap to begin with), losing even one sample to a false pinch
    // reading routinely left too little data to reconstruct real speed before the hands
    // finished closing. A single glitched frame now just isn't used to update the
    // measurement, rather than wiping out every prior sample.
    function hand(x, y, pinching) {
      const lm = []; for (let i = 0; i < 21; i++) lm.push({ x, y, z: 0 });
      lm[0] = { x, y, z: 0 }; lm[9] = { x, y: y - 0.12, z: 0 };
      lm[5] = { x: x + 0.05, y: y - 0.08, z: 0 }; lm[17] = { x: x - 0.05, y: y - 0.08, z: 0 };
      return { gesture: 'Open_Palm', handedness: 'Right', landmarks: lm,
               pinch: { pinching: !!pinching }, fistLike: false };
    }
    function clapTrial(fps, glitchAtFrame) {
      const m = createManipulator(object, camera);
      m.configure({ channels: ['clap'], sensitivity: 1, momentum: false, triggerFrames: 3 });
      const stepMs = 1000 / fps;
      const steps = Math.round(180 / stepMs); // a genuinely fast, ~180ms clap
      let t = 1000;
      for (let i = 0; i < 5; i++) { m.update([hand(0.25, 0.5), hand(0.75, 0.5)], 1.78, t); t += stepMs; }
      object.scale.set(1.3, 1.3, 1.3);
      let fired = false;
      for (let i = 1; i <= steps; i++) {
        const sep = 0.5 + (0.02 - 0.5) * (i / steps);
        const glitch = glitchAtFrame === i;
        m.update([hand(0.5 - sep / 2, 0.5, glitch), hand(0.5 + sep / 2, 0.5)], 1.78, t);
        if (object.scale.x < 1.05) fired = true;
        t += stepMs;
      }
      m.reset();
      return fired;
    }
    // 22fps is a realistic, not extreme, real-webcam rate for this pipeline.
    checkTrue('a clean fast clap fires at a realistic frame rate', clapTrial(22, -1));
    checkTrue('a clap still fires despite ONE glitched (falsely pinching) frame mid-close', clapTrial(22, 2));

    // A GENUINE, sustained pinch must still block a clap -- the fix must not have traded
    // away the guard it was built to keep.
    const m2 = createManipulator(object, camera);
    m2.configure({ channels: ['clap', 'scale'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    for (let i = 0; i < 5; i++) { m2.update([hand(0.15, 0.5), hand(0.85, 0.5)], 1.78, t); t += 16.7; }
    for (let i = 0; i < 30; i++) { m2.update([hand(0.3, 0.5, true), hand(0.7, 0.5, true)], 1.78, t); t += 16.7; } // real, sustained pinch
    object.position.set(0.3, 0.1, 0);
    let clapFiredWhilePinching = false;
    for (let i = 1; i <= 10; i++) {
      const sep = 0.4 - 0.038 * i;
      m2.update([hand(0.5 - sep / 2, 0.5, true), hand(0.5 + sep / 2, 0.5, true)], 1.78, t);
      if (object.position.length() < 0.001) clapFiredWhilePinching = true;
      t += 16.7;
    }
    checkTrue('a genuinely sustained pinch still blocks a clap entirely', !clapFiredWhilePinching);
    m2.reset();
  });

  group('handSpan units — the bug that made clap impossible', () => {
    // handSpan returns wrist separation in PALM LENGTHS, not a 0-1 screen fraction. This
    // pins that contract down so a future refactor can't silently invert it again.
    const close = gestures.handSpan(hand(0.49, 0.5, 0, 'open'), hand(0.51, 0.5, 0, 'open'), 1.78);
    const apart = gestures.handSpan(hand(0.2, 0.5, 0, 'open'), hand(0.8, 0.5, 0, 'open'), 1.78);
    checkTrue('touching hands read under 2 palm-lengths', close < 2, `span=${close.toFixed(2)}`);
    checkTrue('far-apart hands read several palm-lengths', apart > 3, `span=${apart.toFixed(2)}`);
  });

  group('Literal explode + per-part retargeting (synthetic multi-mesh group)', () => {
    // A real THREE.Group with several distinctly-positioned meshes -- this is what actually
    // exercises literalMode (findExplodeParts needs >=2 meshes). Every other group in this
    // file reuses the single shared box `object`, which can only ever exercise the stretch
    // branch -- so despite ROADMAP.md's earlier claim of a synthetic 4-mesh explode test,
    // no such coverage existed anywhere in this file until now (confirmed via git history).
    const multiObject = new THREE.Group();
    const partA = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05));
    partA.position.set(0.1, 0, 0);
    const partB = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05));
    partB.position.set(-0.1, 0, 0);
    const partC = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05));
    partC.position.set(0, 0.1, 0);
    multiObject.add(partA, partB, partC);

    // Raycasting-based selection needs real, current world matrices -- nothing here has a
    // renderer/scene traversal keeping them fresh the way the real app's render loop does,
    // so they're updated explicitly wherever a check below depends on them.
    camera.updateMatrixWorld(true);

    const m = createManipulator(multiObject, camera);
    checkTrue('a 3-mesh group is detected as literal explode, not stretch', m.explodeIsLiteral,
      `explodeIsLiteral=${m.explodeIsLiteral}`);

    // Before any explode has happened, a literalMode object behaves exactly like a
    // single-mesh one for grab -- currentTarget() must resolve to the whole group, not any
    // part, until the user has actually exploded and selected something.
    m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    for (let i = 0; i < 10; i++) { m.update([hand(0.5, 0.5, 0, 'fist')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 20; i++) { m.update([hand(0.5 + 0.01 * i, 0.5, 0, 'fist')], 1.78, t); t += 16.7; }
    checkTrue('before exploding, grab moves the WHOLE group -- unexploded literalMode is unaffected',
      multiObject.position.length() > 0.01, `group moved ${(multiObject.position.length() * 100).toFixed(2)}cm`);
    m.reset();

    // Explode outward and confirm each part moved along ITS OWN precomputed direction, not
    // just "something moved" -- exercises findExplodeParts' centroid/direction math.
    m.configure({ channels: ['explode'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    for (let i = 0; i < 8; i++) { m.update([hand(0.45, 0.5, 0, 'open'), hand(0.55, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 40; i++) { m.update([hand(0.45 - 0.01 * i, 0.5, 0, 'open'), hand(0.55 + 0.01 * i, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('part A moved outward along its own (+x) direction',
      partA.position.x > 0.1 + 0.01, `partA.x=${partA.position.x.toFixed(3)}`);
    checkTrue('part B moved outward along its own, opposite (-x) direction',
      partB.position.x < -0.1 - 0.01, `partB.x=${partB.position.x.toFixed(3)}`);
    checkTrue("part C moved along its own (+y) direction, not A/B's horizontal one",
      partC.position.y > 0.1 + 0.01, `partC.y=${partC.position.y.toFixed(3)}`);

    // Select part A by raycasting through its ACTUAL screen position -- the same mechanism
    // hologram.js's pointerdown handler calls in the real app -- and confirm grab now moves
    // ONLY that part, leaving the group and every other part untouched.
    multiObject.updateMatrixWorld(true);
    const worldA = partA.getWorldPosition(new THREE.Vector3());
    const ndcA = worldA.clone().project(camera);
    const selected = m.selectPartAtScreenPoint(ndcA.x, ndcA.y);
    checkTrue("raycasting at part A's own screen position selects it", selected === partA,
      selected ? (selected === partA ? 'selected A' : 'selected a different part') : 'selected nothing');

    const groupPosBefore = multiObject.position.clone();
    const partAPosBefore = partA.position.clone();
    const partBPosBefore = partB.position.clone();

    m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    for (let i = 0; i < 10; i++) { m.update([hand(0.5, 0.5, 0, 'fist')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 20; i++) { m.update([hand(0.5 + 0.01 * i, 0.5, 0, 'fist')], 1.78, t); t += 16.7; }

    checkTrue('grabbing after selecting part A moves ONLY part A',
      partA.position.distanceTo(partAPosBefore) * 100 > 1,
      `part A moved ${(partA.position.distanceTo(partAPosBefore) * 100).toFixed(2)}cm`);
    check('the whole group does not move while a part is selected',
      multiObject.position.distanceTo(groupPosBefore) * 100, 0, 0);
    check('part B (not selected) does not move',
      partB.position.distanceTo(partBPosBefore) * 100, 0, 0);

    // Reset restores every part's exact position, rotation AND scale -- the extension
    // performReset needed once a part could be individually grabbed/spun/scaled, not just
    // moved by the uniform explode curve.
    m.reset();
    const posErr = partA.position.distanceTo(partA.userData.explodeHome);
    const rotErr = partA.quaternion.angleTo(partA.userData.explodeHomeQuaternion);
    const scaleErr = partA.scale.distanceTo(partA.userData.explodeHomeScale);
    checkTrue('reset restores part A exactly (position + rotation + scale)',
      posErr < 1e-6 && rotErr < 1e-6 && scaleErr < 1e-6,
      `pos off by ${posErr.toExponential(2)}, rot off by ${rotErr.toExponential(2)}, scale off by ${scaleErr.toExponential(2)}`);
    checkTrue('reset deselects the active part', m.activePart === null, `activePart=${m.activePart}`);

    // Below the part-select threshold there's nothing separate to select yet -- a click
    // must not silently grab a part before the user has actually pulled the pieces apart.
    const missedSelect = m.selectPartAtScreenPoint(ndcA.x, ndcA.y);
    checkTrue('selecting before any explode has happened selects nothing', missedSelect === null,
      `selected=${missedSelect}`);
  });

  group('Literal explode on OBJ-style parts — geometry-baked positions', () => {
    // A real OBJ file with several `o`-named groups has NO per-object transform concept at
    // all: every part comes out of OBJLoader with `.position` at the default (0,0,0), and its
    // real location is baked directly into the geometry's own vertex coordinates. The group
    // above builds its fixture the OTHER way (via Object3D.position, geometry centered on its
    // own local origin) -- the idiomatic THREE.js way, but NOT how the real chess pipeline's
    // output will actually load. This is the representation that would have caught the
    // findExplodeParts bug: reading `part.position` directly, without first recentering
    // geometry into it, put every part's centroid at (0,0,0) and every explodeDir at the same
    // degenerate fallback, since every part's `.position` read as identical and zero.
    const multiObject = new THREE.Group();
    const geomA = new THREE.BoxGeometry(0.05, 0.05, 0.05).translate(0.1, 0, 0);
    const partA = new THREE.Mesh(geomA); // .position left at the Object3D default (0,0,0)
    const geomB = new THREE.BoxGeometry(0.05, 0.05, 0.05).translate(-0.1, 0, 0);
    const partB = new THREE.Mesh(geomB);
    const geomC = new THREE.BoxGeometry(0.05, 0.05, 0.05).translate(0, 0.1, 0);
    const partC = new THREE.Mesh(geomC);
    multiObject.add(partA, partB, partC);

    camera.updateMatrixWorld(true);

    const m = createManipulator(multiObject, camera);
    checkTrue('a 3-mesh OBJ-style group is still detected as literal explode', m.explodeIsLiteral,
      `explodeIsLiteral=${m.explodeIsLiteral}`);

    // The fix itself: findExplodeParts must have folded each part's baked-in geometry offset
    // into `.position`, or every one of these would read back as (0,0,0).
    checkTrue("part A's baked geometry offset survived into .position",
      Math.abs(partA.position.x - 0.1) < 1e-6 && Math.abs(partA.position.y) < 1e-6,
      `partA.position=(${partA.position.x.toFixed(3)}, ${partA.position.y.toFixed(3)})`);
    checkTrue("part C's baked geometry offset survived into .position",
      Math.abs(partC.position.y - 0.1) < 1e-6 && Math.abs(partC.position.x) < 1e-6,
      `partC.position=(${partC.position.x.toFixed(3)}, ${partC.position.y.toFixed(3)})`);

    // Recentering must not move any vertex on screen -- the geometry offset it removes is
    // exactly cancelled by the position it adds, so the rendered box for A should still sit
    // at world x=0.1, not x=0.2 (double-counted) or x=0 (offset lost).
    const worldCheck = partA.getWorldPosition(new THREE.Vector3());
    checkTrue('recentering does not change where the part actually renders',
      Math.abs(worldCheck.x - 0.1) < 1e-6, `partA world position x=${worldCheck.x.toFixed(3)}`);

    // Same full sequence as the position-based group: explode outward along each part's own
    // direction, select part A by raycasting its real screen position, grab moves only that
    // part, reset restores everything exactly.
    m.configure({ channels: ['explode'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    for (let i = 0; i < 8; i++) { m.update([hand(0.45, 0.5, 0, 'open'), hand(0.55, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 40; i++) { m.update([hand(0.45 - 0.01 * i, 0.5, 0, 'open'), hand(0.55 + 0.01 * i, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('OBJ-style part A explodes outward along its own (+x) direction',
      partA.position.x > 0.1 + 0.01, `partA.x=${partA.position.x.toFixed(3)}`);
    checkTrue('OBJ-style part B explodes outward along its own, opposite (-x) direction',
      partB.position.x < -0.1 - 0.01, `partB.x=${partB.position.x.toFixed(3)}`);

    multiObject.updateMatrixWorld(true);
    const worldA = partA.getWorldPosition(new THREE.Vector3());
    const ndcA = worldA.clone().project(camera);
    const selected = m.selectPartAtScreenPoint(ndcA.x, ndcA.y);
    checkTrue('raycasting selects OBJ-style part A at its real screen position', selected === partA,
      selected ? (selected === partA ? 'selected A' : 'selected a different part') : 'selected nothing');

    const groupPosBefore = multiObject.position.clone();
    const partAPosBefore = partA.position.clone();
    const partBPosBefore = partB.position.clone();

    m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    for (let i = 0; i < 10; i++) { m.update([hand(0.5, 0.5, 0, 'fist')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 20; i++) { m.update([hand(0.5 + 0.01 * i, 0.5, 0, 'fist')], 1.78, t); t += 16.7; }
    checkTrue('grabbing after selecting OBJ-style part A moves ONLY part A',
      partA.position.distanceTo(partAPosBefore) * 100 > 1,
      `part A moved ${(partA.position.distanceTo(partAPosBefore) * 100).toFixed(2)}cm`);
    check('the whole group does not move while an OBJ-style part is selected',
      multiObject.position.distanceTo(groupPosBefore) * 100, 0, 0);
    check('OBJ-style part B (not selected) does not move',
      partB.position.distanceTo(partBPosBefore) * 100, 0, 0);

    m.reset();
    const posErr = partA.position.distanceTo(partA.userData.explodeHome);
    const rotErr = partA.quaternion.angleTo(partA.userData.explodeHomeQuaternion);
    const scaleErr = partA.scale.distanceTo(partA.userData.explodeHomeScale);
    checkTrue('reset restores OBJ-style part A exactly (position + rotation + scale)',
      posErr < 1e-6 && rotErr < 1e-6 && scaleErr < 1e-6,
      `pos off by ${posErr.toExponential(2)}, rot off by ${rotErr.toExponential(2)}, scale off by ${scaleErr.toExponential(2)}`);
  });

  // ---- measurement, against the real shipped chair -------------------------------------
  let model = null;
  try {
    model = await new Promise((resolve, reject) =>
      new OBJLoader().load('assets/chair/chair_clean.obj', resolve, undefined, reject)
    );
  } catch (err) {
    group('Measurement (assets/chair/chair_clean.obj)', () => {
      checkTrue('model loads', false, String(err));
    });
  }

  if (model) {
    group('Measurement — oriented footprint (assets/chair/chair_clean.obj)', () => {
      const t0 = performance.now();
      const base = measure.measureObject(model);
      const ms = performance.now() - t0;

      // These reference values are the chair as measured and reported earlier this session.
      // A few mm of tolerance covers floating-point path differences between the old O(n·θ)
      // sweep and the current hull-based search — they are expected to agree closely, not
      // bit-for-bit.
      check('width ≈ 57.7cm', base.width * 100, 57.7, 0.01);
      check('depth ≈ 50.3cm', base.depth * 100, 50.3, 0.01);
      check('height ≈ 79.5cm', base.height * 100, 79.5, 0.01);
      check('footprint angle ≈ 15.8°', base.footprintAngleDeg, 15.8, 0.05);
      checkTrue('hull is small relative to the mesh', base.hullSize < 200,
        `${base.hullSize} hull points from ${base.triangleCount} triangles`);
      checkTrue('completes well within a model-load pause (not a per-frame cost)', ms < 500, `${ms.toFixed(1)}ms`);

      // The naive axis-aligned box must be LARGER than the oriented footprint for a
      // rotated object — this is the whole reason the oriented search exists.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      checkTrue('oriented footprint is smaller than the axis-aligned box',
        base.width * base.depth < size.x * size.z,
        `oriented ${(base.width * base.depth * 10000).toFixed(0)}cm² vs axis-aligned ${(size.x * size.z * 10000).toFixed(0)}cm²`);
    });

    group('Measurement — detected horizontal surfaces', () => {
      const surfaces = measure.horizontalSurfaces(model);
      const main = surfaces[0];
      checkTrue('a dominant surface is found', !!main,
        main ? `${(main.height * 100).toFixed(1)}cm, ${(main.share * 100).toFixed(0)}% share` : 'none detected');
      if (main) {
        check('main surface height ≈ 44.7cm (seat)', main.height * 100, 44.7, 0.03);
        checkTrue('main surface holds most of the horizontal area', main.share > 0.5,
          `share=${(main.share * 100).toFixed(0)}%`);
      }
    });

    group('Measurement — calibration exponents', () => {
      const base = measure.measureObject(model);
      const factor = 1.028; // the +2.8% correction exercised earlier this session
      const cal = measure.calibrate(base, factor);
      check('length scales by f¹', cal.width / base.width, factor, 0.001);
      check('surface area scales by f²', cal.surfaceArea / base.surfaceArea, factor ** 2, 0.001);
      check('volume scales by f³', cal.volume / base.volume, factor ** 3, 0.001);
      check('factor=1 is a no-op', measure.calibrate(base, 1).width, base.width, 0);
    });

    group('Measurement — fit check', () => {
      const base = measure.measureObject(model);
      const doorway = measure.fitCheck(base, 0.76, 1.98); // 76 × 198cm
      checkTrue('fits a standard doorway', doorway.fits, JSON.stringify(doorway.best?.label));

      const hatch = measure.fitCheck(base, 0.45, 0.60); // 45 × 60cm
      checkTrue('correctly refuses a too-small hatch', !hatch.fits);

      // The orientation search must actually try turning the object, not just axis-aligned —
      // this is what makes "does it fit through the door" mean something.
      const tight = measure.fitCheck(base, Math.min(base.width, base.depth) + 0.02, base.height + 0.5);
      checkTrue('a gap narrower than the long axis still fits when turned', tight.fits,
        tight.best ? tight.best.label : 'no orientation fit');
    });
  }

  render();
  rawEl.textContent = `${groups.reduce((n, g) => n + g.cases.length, 0)} checks · ${new Date().toISOString()}`;
}

main().catch((err) => {
  summaryEl.textContent = 'suite crashed — see console';
  summaryEl.className = 'fail';
  console.error(err);
});

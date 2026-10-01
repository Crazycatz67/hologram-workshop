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
    failCount++; // a thrown group used to show FAIL in its list but leave the summary green
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
  const mn = await import(`./manipulator.js${V}`);
  const measure = await import(`./measure.js${V}`);
  const gestures = await import(`./gestures.js${V}`);
  const { gunFeatures } = await import(`./gunPose.js${V}`);

  // A bare mesh and camera, not a full scene — the manipulator only needs an Object3D with
  // position/rotation/scale and a camera with a real fov/aspect/position for its
  // screen-to-world math.
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5));
  const camera = new THREE.PerspectiveCamera(45, 1.78, 0.01, 100);
  camera.position.set(0, 0.2, 2.2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  const IDENT = new THREE.Quaternion();

  // Regression for the multi-part GLB bug (2026-09-29): measure.js read raw vertices and
  // ignored each part's node transform, so chair_detail.glb's eight parts were measured
  // stacked at one spot (51 cm tall instead of 80). Two unit boxes, one 2 m above the other.
  group('Measurement honours part transforms (multi-part models)', () => {
    const g = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); a.position.set(0, 0.5, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); b.position.set(0, 2.5, 0);
    g.add(a, b);
    const d = measure.measureObject(g);
    check('height spans both parts', d.height, 3, 1e-9);
    check('volume sums both parts', d.volume, 2, 1e-9);
    g.scale.setScalar(2);   // the object's OWN transform must still be ignored
    check('scaling the whole object does not change its real size', measure.measureObject(g).height, 3, 1e-9);
    // Regression (2026-09-30): the platform's Measure tab passes a plain stand-in with no
    // matrices (vertices already baked); partMatrix crashed on it and broke every
    // measurement on the workshop page.
    const pos = new THREE.BoxGeometry(1, 2, 1).getAttribute('position');
    const idx = new THREE.BoxGeometry(1, 2, 1).getIndex();
    const stand = { isMesh: true, geometry: { getAttribute: (n) => (n === 'position' ? pos : undefined), getIndex: () => idx } };
    const proxy = { children: [stand], updateWorldMatrix() {}, traverse(fn) { fn(stand); } };
    check('matrix-less stand-ins (platform Measure tab) measure without crashing', measure.measureObject(proxy).height, 2, 1e-9);
  });

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

  // Explode bleed (replay-lab 2026-10-01): clap, ✌ + a relaxed hand and "talking hands" all
  // stretched the model past gesture-lab's 3% "visible" line. Explode now needs relaxed open
  // hands (never ✌/☝/👎) AND a deliberate spread from a stable start before it moves anything.
  group('Explode bleed — only a deliberate spread explodes (replay-lab)', () => {
    const m = createManipulator(object, camera);
    const as = (h, gesture) => ({ ...h, gesture });
    const stretchOf = () => Math.max(object.scale.x, object.scale.y) / Math.min(object.scale.x, object.scale.y);
    checkTrue('isOpenForExplode: ✌ / ☝ / 👎 are never open; Open_Palm and None are',
      ['Victory', 'Pointing_Up', 'Thumb_Down'].every((g) => !gestures.isOpenForExplode?.({ gesture: g })) &&
      ['Open_Palm', 'None'].every((g) => gestures.isOpenForExplode?.({ gesture: g })));

    // ✌ + a relaxed open hand, the ✌ hand moving away fast (as when it goes on to aim).
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    const seen = new Set();
    for (let i = 0; i < 20; i++) { seen.add(m.update([hand(0.3, 0.6, 0, 'open'), as(hand(0.55, 0.5, 0, 'open'), 'Victory')], 1.78, t)); t += 16.7; }
    for (let i = 1; i <= 25; i++) { seen.add(m.update([hand(0.3, 0.6, 0, 'open'), as(hand(0.55 + 0.012 * i, 0.5, 0, 'open'), 'Victory')], 1.78, t)); t += 16.7; }
    checkTrue('✌ + a relaxed open hand never explodes', !seen.has(MODE.EXPLODE) && stretchOf() < 1.03,
      `modes ${[...seen].join(',')}, stretch ${stretchOf().toFixed(3)}`);

    // Clap on a stretched model: the closing hands must not squash it before the reset.
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    object.scale.x *= 1.3;
    t = 1000;
    let minX = object.scale.x;
    const x0 = object.scale.x;
    let reset = false;
    for (let i = 0; i < 20; i++) { m.update([hand(0.20, 0.5, 0, 'open'), hand(0.80, 0.5, 0, 'open')], 1.78, t); t += 16.7; minX = Math.min(minX, object.scale.x); }
    for (let i = 1; i <= 12 && !reset; i++) {
      const sep = 0.60 + (0.06 - 0.60) * (i / 12);
      m.update([hand(0.5 - sep / 2, 0.5, 0, 'open'), hand(0.5 + sep / 2, 0.5, 0, 'open')], 1.78, t);
      t += 16.7;
      if (Math.abs(object.scale.x - 1) < 1e-6) reset = true; else minX = Math.min(minX, object.scale.x);
    }
    checkTrue('a clap resets a stretched model without squashing it first', reset && minX > x0 * 0.97,
      `reset=${reset}, lowest scale.x before reset ${minX.toFixed(3)} of ${x0.toFixed(3)}`);

    // Talking hands: two raised, loosely open hands wandering (±6% of the frame, ~1 Hz) for 3 s.
    // The old code stretched the model to 1.26 here.
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    let talkMax = 1;
    for (let i = 0; i < 180; i++) {
      const u = (2 * i) / 180;
      const w = (f, p) => 0.06 * Math.sin(u * f + p);
      m.update([hand(0.36 + w(9, 0), 0.6 + w(7, 1), 0, 'open'), hand(0.64 + w(8, 2), 0.6 + w(11, 3), 0, 'open')], 1.78, t);
      t += 16.7;
      talkMax = Math.max(talkMax, stretchOf());
    }
    checkTrue('"talking hands" (wandering open hands) never stretch the model', talkMax < 1.03,
      `peak stretch ${talkMax.toFixed(3)}`);

    // Holding still for 1 s and then a deliberate spread still explodes, with all channels on.
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    for (let i = 0; i < 60; i++) { m.update([hand(0.45, 0.5, 0, 'open'), hand(0.55, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 25; i++) { m.update([hand(0.45 - 0.008 * i, 0.5, 0, 'open'), hand(0.55 + 0.008 * i, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('a still hold then a deliberate spread still explodes (all channels on)', object.scale.x > 1.3,
      `scale.x=${object.scale.x.toFixed(2)}`);

    // A SLOW but wide spread (together -> wide apart over 1.5 s) still explodes, by distance.
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    for (let i = 0; i < 30; i++) { m.update([hand(0.45, 0.5, 0, 'open'), hand(0.55, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    for (let i = 1; i <= 45; i++) { m.update([hand(0.45 - 0.2 * i / 45, 0.5, 0, 'open'), hand(0.55 + 0.2 * i / 45, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    for (let i = 0; i < 15; i++) { m.update([hand(0.25, 0.5, 0, 'open'), hand(0.75, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    checkTrue('a slow (1.5 s) but wide spread still explodes', object.scale.x > 1.3, `scale.x=${object.scale.x.toFixed(2)}`);
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

  // Owner request after the 2026-10-01 webcam test: raising the second hand must tilt the
  // model UP (its front edge rises on screen, its top tips away from the camera); it used to
  // tilt down. Roll keeps its old sign. The front point faces the camera (+z) at home.
  group('Tilt direction — second hand up tilts the model up (owner, 2026-10-01)', () => {
    const m = createManipulator(object, camera);
    const tiltBy = (dy, dx = 0) => {
      m.reset();
      m.configure({ channels: ['tilt'], sensitivity: 1, momentum: false, triggerFrames: 3 });
      let t = 1000;
      for (let i = 0; i < 10; i++) { m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
      for (let i = 1; i <= 30; i++) { m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65 + dx * i, 0.5 + dy * i, 0, 'open')], 1.78, t); t += 16.7; }
      for (let i = 0; i < 30; i++) { m.tick(t); t += 16.7; }
      object.updateMatrixWorld(true);
      const front = object.localToWorld(new THREE.Vector3(0, 0, 0.25));
      const top = object.localToWorld(new THREE.Vector3(0, 0.4, 0));
      const frontScreenY = front.clone().project(camera).y;
      const home = new THREE.Vector3(0, 0, 0.25).project(camera).y;
      const euler = new THREE.Euler().setFromQuaternion(object.quaternion, 'XYZ');
      return { frontRise: frontScreenY - home, topZ: top.z, pitch: euler.x, roll: euler.z };
    };
    const up = tiltBy(-0.006);   // image y falls = hand raised
    checkTrue('raising the second hand lifts the model\'s front edge on screen', up.frontRise > 0.05,
      `front edge moved ${up.frontRise.toFixed(3)} NDC (was negative before the change)`);
    checkTrue('raising the second hand tips the top away from the camera', up.topZ < -0.05, `top z ${up.topZ.toFixed(3)}`);
    const down = tiltBy(0.006);
    checkTrue('lowering the second hand drops the front edge (tilts down)', down.frontRise < -0.05,
      `front edge moved ${down.frontRise.toFixed(3)} NDC`);
    const right = tiltBy(0, 0.006);
    checkTrue('roll sign unchanged: second hand right in the image rolls positive about Z', right.roll > 0.2 && Math.abs(right.pitch) < 1e-6,
      `roll ${(right.roll * 180 / Math.PI).toFixed(1)}°, pitch ${(right.pitch * 180 / Math.PI).toFixed(2)}°`);
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
    // Hands down for 0.5s between the explode and the grab (the neutral gap, BUGS #26; in
    // real use this is while the mouse picks the part).
    for (let i = 0; i < 30; i++) { m.update([], 1.78, t); t += 16.7; }
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
    // Hands down for 0.5s between the explode and the grab (the neutral gap, BUGS #26; in
    // real use this is while the mouse picks the part).
    for (let i = 0; i < 30; i++) { m.update([], 1.78, t); t += 16.7; }
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

  // ---- smoothing, accuracy and smoothness rewrite (2026-09-29) --------------------------
  // One Euro landmark filter (smoothLandmarks.js), command -> deadzone -> critically damped
  // follow in manipulator.js, platform mouse editing. Numbers are synthetic; see
  // docs/lab/gestures/smoothing-lab.html for the before/after table these bounds come from.
  const smoothing = await import(`./smoothLandmarks.js${V}`);
  const RS = () => smoothing.resetLandmarkSmoothing();
  const SM = (hands, t) => smoothing.smoothHandLandmarks(hands, t);

  // Drives the real pipeline order (smooth -> manipulator.update) with a camera at `fps` and
  // manipulator.tick at 60Hz between camera frames, the way hologram.js runs it.
  function pipeline(m, specsAt, { fps = 30, totalS = 1, smooth = true, jitter = 0, onDisplay = null, t0 = 1000 } = {}) {
    RS();
    const camStep = 1000 / fps;
    let nextCam = t0;
    for (let t = t0; t <= t0 + totalS * 1000 + 1e-6; t += 1000 / 60) {
      while (nextCam <= t + 1e-6) {
        const ts = (nextCam - t0) / 1000;
        const hands = specsAt(ts).map(([x, y, tw, kind, palm]) => hand(x, y, tw, kind, jitter, palm));
        if (smooth) SM(hands, nextCam);
        m.update(hands, 1.78, nextCam);
        nextCam += camStep;
      }
      m.tick(t);
      onDisplay?.((t - t0) / 1000);
    }
  }

  group('Landmark smoothing — One Euro filter (BUGS #12)', () => {
    // Rest jitter: a still hand with the realistic 0.002 per-landmark noise.
    for (const fps of [30, 60]) {
      seed = 5; RS();
      let se = 0, seRaw = 0, n = 0;
      for (let i = 0; i < fps * 3; i++) {
        const h = hand(0.5, 0.5, 0, 'open', REALISTIC_JITTER);
        const raw = h.landmarks[0].x;
        SM([h], 1000 + (i * 1000) / fps);
        if (i > fps / 2) { se += (h.landmarks[0].x - 0.5) ** 2; seRaw += (raw - 0.5) ** 2; n++; }
      }
      const ratio = Math.sqrt(se / n) / Math.sqrt(seRaw / n);
      checkTrue(`rest jitter at ${fps}fps falls below 40% of raw (the old EMA kept ~54%)`, ratio < 0.4,
        `RMS ${(ratio * 100).toFixed(0)}% of raw`);
    }
    // Lag on a moving hand, steady state: fast motion must lag LESS than a frame.
    const lagMs = (speed, fps) => {
      RS();
      let sum = 0, k = 0;
      const N = Math.round(fps * 0.4);
      for (let i = 0; i < N; i++) {
        const x = 0.3 + (speed * i) / fps;
        const h = hand(x, 0.5, 0, 'open');
        SM([h], 1000 + (i * 1000) / fps);
        if (i >= N - 3) { sum += (x - h.landmarks[0].x) / speed; k++; }
      }
      return (sum / k) * 1000;
    };
    const fast30 = lagMs(1.35, 30), move30 = lagMs(0.3, 30);
    checkTrue('a clap-speed hand (1.35/s) lags under 10ms at 30fps (old EMA: 33ms)', fast30 < 10, `${fast30.toFixed(1)}ms`);
    checkTrue('a moving hand (0.3/s) lags under 20ms at 30fps', move30 < 20, `${move30.toFixed(1)}ms`);

    // Lost-tracking recovery: a hand that blinks out for 150ms resumes its filter state (so
    // its jitter stays smoothed and nothing jumps); one gone 400ms is a new hand, unfiltered.
    RS();
    for (let i = 0; i < 10; i++) SM([hand(0.3, 0.5, 0, 'open')], 1000 + i * 33);
    const back = hand(0.303, 0.5, 0, 'open'); // a jitter-sized offset
    SM([back], 1000 + 9 * 33 + 150);
    checkTrue('a hand back after a 150ms dropout resumes its filter (offset partly absorbed, not raw)', back.landmarks[0].x < 0.3025,
      `wrist x ${back.landmarks[0].x.toFixed(4)} (raw 0.3030)`);
    RS();
    for (let i = 0; i < 10; i++) SM([hand(0.3, 0.5, 0, 'open')], 1000 + i * 33);
    const late = hand(0.303, 0.5, 0, 'open');
    SM([late], 1000 + 9 * 33 + 400);
    check('a hand back after 400ms starts fresh (raw passthrough)', late.landmarks[0].x, 0.303, 0);
    RS();
  });

  group('Clap at low camera frame rates, through the landmark filter (BUGS #12)', () => {
    const clapAt = (fps, phase, durS = 0.2) => {
      const m = createManipulator(object, camera);
      m.configure({ channels: ['clap'], sensitivity: 1, momentum: false, triggerFrames: 3 });
      object.scale.set(1.3, 1.3, 1.3);
      let fired = false;
      pipeline(m, (t) => {
        const u = THREE.MathUtils.clamp((t - 0.6 - phase / fps) / durS, 0, 1);
        const sep = 0.6 - 0.54 * u;
        return [[0.5 - sep / 2, 0.5, 0, 'open'], [0.5 + sep / 2, 0.5, 0, 'open']];
      }, { fps, totalS: 1.2, onDisplay: () => { if (object.scale.x === 1) fired = true; } });
      m.reset();
      return fired;
    };
    for (const fps of [12, 24, 60]) {
      let hits = 0;
      for (let p = 0; p < 8; p++) hits += clapAt(fps, p / 8) ? 1 : 0;
      checkTrue(`a 200ms clap fires at ${fps}fps (8 frame phases)`, hits === 8, `${hits}/8 (old: 0/8 at 12fps)`);
    }
    let hits8 = 0;
    for (let p = 0; p < 8; p++) hits8 += clapAt(8, p / 8) ? 1 : 0;
    checkTrue('a 200ms clap mostly fires even at 8fps', hits8 >= 6, `${hits8}/8 (old: 0/8)`);
    // Still guarded: a slow 2s bring-together must not fire.
    const m = createManipulator(object, camera);
    m.configure({ channels: ['clap'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    object.scale.set(1.3, 1.3, 1.3);
    pipeline(m, (t) => {
      const sep = 0.6 - 0.54 * THREE.MathUtils.clamp((t - 0.3) / 2, 0, 1);
      return [[0.5 - sep / 2, 0.5, 0, 'open'], [0.5 + sep / 2, 0.5, 0, 'open']];
    }, { fps: 30, totalS: 2.6 });
    check('a slow 2s bring-together still does not reset', object.scale.x, 1.3, 0.001);
    m.reset();
  });

  group('Model follow — a still hand holds the model exactly still (BUGS #11)', () => {
    const cases = {
      'fist + second open hand (move/spin/push/tilt)': [[0.35, 0.5, 0, 'fist'], [0.65, 0.5, 0, 'open']],
      'two pinching hands (scale)': [[0.35, 0.5, 0, 'pinch'], [0.65, 0.5, 0, 'pinch']],
      'two open hands (explode)': [[0.35, 0.5, 0, 'open'], [0.65, 0.5, 0, 'open']]
    };
    for (const [name, specs] of Object.entries(cases)) {
      for (const smooth of [true, false]) {
        seed = 11;
        const m = createManipulator(object, camera);
        m.configure({ channels: ALL_CHANNELS.filter((c) => c !== 'clap'), sensitivity: 1, momentum: true, triggerFrames: 3 });
        pipeline(m, () => specs, { fps: 30, totalS: smooth ? 3 : 10, smooth, jitter: REALISTIC_JITTER });
        const moved = object.position.length() * 100;
        const turned = object.quaternion.angleTo(IDENT) * 180 / Math.PI;
        const scaled = Math.max(...object.scale.toArray().map((v) => Math.abs(v - 1)));
        checkTrue(`${name}, ${smooth ? '3s through the filter' : '10s raw (no filter)'}: drift is exactly 0`,
          moved === 0 && turned === 0 && scaled === 0,
          `${moved.toFixed(3)}cm, ${turned.toFixed(3)}°, scale off ${(scaled * 100).toFixed(2)}% (old raw explode: +10.9% after 10s)`);
        m.reset();
      }
    }
  });

  // BUGS #31: the 0.05 ln(span) deadzone made small slow pinch-scales start late (a start
  // cost 5% of span) and freeze at every reversal (10%). The span is now normalised by a held
  // palm length and the deadzone is 0.12 palm lengths. Bounds come from the BUGS #31 sim
  // (same pipeline, these hands): new code start mean ~455 ms, reversal worst 617 ms, reached
  // >= 88%; the old code start mean ~535 ms, reversal 750-817 ms, reached 77-83%.
  group('Scale responsiveness (BUGS #31)', () => {
    const ease = (u) => (1 - Math.cos(Math.PI * THREE.MathUtils.clamp(u, 0, 1))) / 2;
    const strokeS = 1.5, holdS = 0.6, backAt = holdS + strokeS + holdS;
    // Hands 3.7 palms apart spread to x1.27 over 1.5 s (eased), hold, and come back.
    const outAndBack = (seedN, fps) => {
      seed = seedN;
      const m = createManipulator(object, camera);
      m.configure({ channels: ['scale'], sensitivity: 1, momentum: true, triggerFrames: 3 });
      const w0 = 0.25, w1 = 0.25 * 1.27;
      const series = [];
      pipeline(m, (t) => {
        const w = t < backAt ? w0 + (w1 - w0) * ease((t - holdS) / strokeS) : w1 + (w0 - w1) * ease((t - backAt) / strokeS);
        return [[0.5 - w / 2, 0.5, 0, 'pinch'], [0.5 + w / 2, 0.5, 0, 'pinch']];
      }, { fps, totalS: backAt + strokeS + holdS, jitter: REALISTIC_JITTER, onDisplay: (t) => series.push({ t, s: object.scale.x }) });
      m.reset();
      // "Moved" = 0.2% of size, from the moment the hands start (or start back).
      const s0 = series.find((p) => p.t >= holdS - 0.02).s;
      const start = series.find((p) => p.t >= holdS && Math.log(p.s / s0) > 0.002);
      const peak = Math.max(...series.filter((p) => p.t < backAt).map((p) => p.s));
      const back = series.find((p) => p.t >= backAt && Math.log(peak / p.s) > 0.002);
      return {
        startMs: start ? (start.t - holdS) * 1000 : Infinity,
        backMs: back ? (back.t - backAt) * 1000 : Infinity,
        reached: Math.log(peak / s0) / Math.log(1.27)
      };
    };
    const runs = [];
    for (const fps of [30, 49]) for (const sd of [3, 7, 11]) runs.push(outAndBack(sd, fps));
    const startMean = runs.reduce((a, r) => a + r.startMs, 0) / runs.length;
    const backWorst = Math.max(...runs.map((r) => r.backMs));
    const reachedMin = Math.min(...runs.map((r) => r.reached));
    checkTrue('a small slow spread (x1.27 over 1.5 s) starts within 500 ms on average (old: ~535 ms)', startMean < 500,
      `${startMean.toFixed(0)} ms mean (${runs.map((r) => r.startMs.toFixed(0)).join(', ')})`);
    checkTrue('and follows the hands back within 700 ms of them reversing (old: 750-817 ms)', backWorst < 700,
      `${backWorst.toFixed(0)} ms worst (${runs.map((r) => r.backMs.toFixed(0)).join(', ')})`);
    checkTrue('and reaches at least 85% of the intended size (old: 77%)', reachedMin >= 0.85, `${(reachedMin * 100).toFixed(0)}% worst`);

    // Still hands close together (1.8 palms apart), double the measured jitter, 10 s: the
    // old ln-width deadzone drifted in 5 of these 6 (up to 2.1%).
    let drifted = 0, worst = 0;
    for (const sd of [1, 2, 3, 4, 5, 6]) {
      seed = sd;
      const m = createManipulator(object, camera);
      m.configure({ channels: ['scale'], sensitivity: 1, momentum: true, triggerFrames: 3 });
      pipeline(m, () => [[0.44, 0.5, 0, 'pinch'], [0.56, 0.5, 0, 'pinch']], { fps: 30, totalS: 10, jitter: 0.004 });
      const d = Math.abs(object.scale.x - 1);
      if (d > 0) drifted++;
      worst = Math.max(worst, d);
      m.reset();
    }
    checkTrue('still pinching hands 1.8 palms apart, jitter 0.004, 10 s: drift is exactly 0', drifted === 0,
      `${drifted}/6 drifted, worst ${(worst * 100).toFixed(2)}% (old: 5/6, 2.1%)`);

    // Leaning 25% nearer (wrist distance and palms both grow) is not a spread. The held palm
    // length re-normalises past its 4% deadzone, so only a small one-off leak is allowed; a
    // fully frozen normaliser read this as a 23% scale.
    seed = 5;
    const m = createManipulator(object, camera);
    m.configure({ channels: ['scale'], sensitivity: 1, momentum: true, triggerFrames: 3 });
    pipeline(m, (t) => {
      const k = Math.exp(Math.log(1.25) * ease((t - 0.6) / 1));
      const w = 0.25 * k;
      return [[0.5 - w / 2, 0.5, 0, 'pinch', 0.12 * k], [0.5 + w / 2, 0.5, 0, 'pinch', 0.12 * k]];
    }, { fps: 30, totalS: 2.6, jitter: REALISTIC_JITTER });
    const leak = object.scale.x - 1;
    m.reset();
    checkTrue('leaning 25% toward the camera mid-pinch changes the scale by under 8% (frozen palm: 23%)', Math.abs(leak) < 0.08,
      `${(leak * 100).toFixed(1)}%`);
  });

  group('Model follow — step response, top speed, frame-rate independence', () => {
    const perUnitX = 2 * camera.position.distanceTo(new THREE.Vector3()) * Math.tan((camera.fov * Math.PI) / 360) * camera.aspect;
    // A quick 0.2-frame-width slide inside 100ms, then hold.
    const step = (fps) => {
      const m = createManipulator(object, camera);
      m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
      const series = [];
      pipeline(m, (t) => [[0.4 + 0.2 * THREE.MathUtils.clamp((t - 0.5) / 0.1, 0, 1), 0.5, 0, 'fist']],
        { fps, totalS: 1.6, onDisplay: (t) => series.push({ t, x: -object.position.x }) });
      m.reset();
      const final = series[series.length - 1].x;
      let settle = 0, peak = 0;
      for (const p of series) peak = Math.max(peak, p.x);
      for (let i = series.length - 1; i >= 0; i--) if (Math.abs(series[i].x - final) > 0.02 * final) { settle = series[i].t - 0.6; break; }
      return { final, settle, overshoot: (peak - final) / final, series };
    };
    const s30 = step(30);
    checkTrue('a quick slide lands within 3% of the 1:1 hand mapping (old: 82%)', Math.abs(s30.final / (0.2 * perUnitX) - 1) < 0.03,
      `${((s30.final / (0.2 * perUnitX)) * 100).toFixed(1)}% of ideal`);
    checkTrue('it settles within 250ms of the hand stopping (old: 350ms)', s30.settle < 0.25, `${(s30.settle * 1000).toFixed(0)}ms`);
    checkTrue('with no overshoot', s30.overshoot < 0.005, `${(s30.overshoot * 100).toFixed(2)}%`);
    const s24 = step(24), s60 = step(60);
    checkTrue('the same slide ends in the same place at 24fps and 60fps (within 1%)',
      Math.abs(s24.final - s60.final) / s60.final < 0.01, `24fps ${(s24.final * 100).toFixed(1)}cm, 60fps ${(s60.final * 100).toFixed(1)}cm`);
    const mid = (s) => s.series.find((p) => p.t >= 0.75).x;
    checkTrue('and is at the same point along the way 150ms after the hand stops (within 5%)',
      Math.abs(mid(s24) - mid(s60)) / s60.final < 0.05, `24fps ${(mid(s24) * 100).toFixed(1)}cm, 60fps ${(mid(s60) * 100).toFixed(1)}cm`);
    const smooth30 = step(30).series.filter((p) => p.t > 0.5 && p.t < 0.9);
    const maxSpeed = Math.max(...smooth30.slice(1).map((p, i) => Math.abs(p.x - smooth30[i].x) / (p.t - smooth30[i].t)));
    checkTrue('the model never exceeds its 4 units/s top speed, even on a flick', maxSpeed <= 4.0001, `${maxSpeed.toFixed(2)} units/s`);
    // Display-rate glide: with a 30fps camera, the model moves on every 60Hz display frame.
    const m = createManipulator(object, camera);
    m.configure({ channels: ['move'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    const xs = [];
    pipeline(m, (t) => [[0.3 + 0.3 * THREE.MathUtils.clamp((t - 0.4) / 1.2, 0, 1), 0.5, 0, 'fist']],
      { fps: 30, totalS: 1.6, onDisplay: (t) => { if (t > 0.8 && t < 1.5) xs.push(object.position.x); } });
    m.reset();
    const still = xs.slice(1).filter((v, i) => v === xs[i]).length;
    checkTrue('a steady sweep moves the model on every display frame (old: every other frame)', still === 0, `${still} frozen frames of ${xs.length - 1}`);
    // Momentum still coasts after a release mid-motion; without momentum it settles in place.
    const release = (momentum) => {
      const mm = createManipulator(object, camera);
      mm.configure({ channels: ['move'], sensitivity: 1, momentum, triggerFrames: 3 });
      let atRelease = null;
      pipeline(mm, (t) => {
        const x = 0.3 + 0.3 * THREE.MathUtils.clamp((t - 0.3) / 0.5, 0, 1);
        return [[x, 0.5, 0, t < 0.7 ? 'fist' : 'open']];
      }, { fps: 30, totalS: 2, onDisplay: (t) => { if (atRelease === null && t >= 0.7) atRelease = -object.position.x; } });
      const end = -object.position.x;
      mm.reset();
      return end - atRelease;
    };
    const coast = release(true), stop = release(false);
    checkTrue('momentum on: a release mid-slide coasts on further than momentum off', coast > stop + 0.05,
      `coast ${(coast * 100).toFixed(1)}cm vs ${(stop * 100).toFixed(1)}cm`);
  });

  group('Slow deliberate motion registers (BUGS #5)', () => {
    // The old per-second velocity deadzones ignored slow motion entirely: a 40° twist over
    // 2 s did nothing. The backlash deadzone follows motion at any speed.
    const m = createManipulator(object, camera);
    m.configure({ channels: ['spin'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    pipeline(m, (t) => [[0.5, 0.5, 40 * THREE.MathUtils.clamp((t - 0.3) / 2, 0, 1), 'fist']], { fps: 30, totalS: 3 });
    const deg = object.quaternion.angleTo(IDENT) * 180 / Math.PI;
    m.reset();
    checkTrue('a slow 40° wrist twist over 2s spins the model (old: 0°)', deg > 15, `${deg.toFixed(1)}°`);
    const m2 = createManipulator(object, camera);
    m2.configure({ channels: ['push'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    const d0 = camera.position.distanceTo(object.position);
    pipeline(m2, (t) => [[0.5, 0.5, 0, 'fist', 0.10 + 0.03 * THREE.MathUtils.clamp((t - 0.3) / 1, 0, 1)]], { fps: 30, totalS: 1.8 });
    const pulled = d0 - camera.position.distanceTo(object.position);
    m2.reset();
    checkTrue('a slow push (palm 0.10 -> 0.13 over 1s) pulls the model closer (old: nothing)', pulled > 0.1, `${(pulled * 100).toFixed(1)}cm closer`);
  });

  group('Clap ignores a degenerate (zero-size) hand', () => {
    // handSpan returns 0 when a hand's palm length is 0, which read as "hands together and
    // closing infinitely fast" and fired a reset out of nothing (BUGS #15).
    const flat = (x) => ({ gesture: 'Open_Palm', handedness: 'Right', landmarks: Array.from({ length: 21 }, () => ({ x, y: 0.5, z: 0 })), pinch: { pinching: false } });
    const m = createManipulator(object, camera);
    m.configure({ channels: ['clap'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    let t = 1000;
    for (let i = 0; i < 5; i++) { m.update([hand(0.2, 0.5, 0, 'open'), hand(0.8, 0.5, 0, 'open')], 1.78, t); t += 33; }
    object.scale.set(1.3, 1.3, 1.3);
    m.update([flat(0.2), flat(0.8)], 1.78, t);
    check('a frame of zero-size hands does not reset the model', object.scale.x, 1.3, 0.001);
    m.reset();
  });

  group('Neutral gap and safe clap (BUGS #26, #27)', () => {
    // Owner's "Engage -> Aim -> Act" (2026-09-30): after a gesture ends, a DIFFERENT gesture
    // waits for ~400ms of relaxed hands; clap (a command) only fires from rest. 30fps frames.
    const FR = 1000 / 30;
    const drive = (m, n, specs, t, seen) => {
      for (let i = 0; i < n; i++) {
        const mode = m.update(specs(i).map(([x, y, kind]) => hand(x, y, 0, kind)), 1.78, t);
        seen?.add(mode);
        t += FR;
      }
      return t;
    };
    const fresh = () => {
      // createManipulator takes "home" from the object's current pose, and earlier groups
      // leave the shared box moved and stretched.
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.scale.set(1, 1, 1);
      const m = createManipulator(object, camera);
      m.reset();
      m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
      return m;
    };

    // #26 repro: hold a tilt, open the fist, keep both hands up, then drop the second hand
    // away. Before the fix explode engaged ~300ms after the fist opened and the drop
    // stretched the model.
    let m = fresh();
    let t = 1000;
    t = drive(m, 15, () => [[0.35, 0.5, 'fist'], [0.65, 0.5, 'open']], t);
    t = drive(m, 15, (i) => [[0.35, 0.5, 'fist'], [0.65, 0.5 - 0.01 * i, 'open']], t);
    checkTrue('tilt is active before the release', m.mode === MODE.GRAB, `mode=${m.mode}`);
    let seen = new Set();
    const scaleAtRelease = object.scale.clone();
    t = drive(m, 30, () => [[0.35, 0.5, 'open'], [0.65, 0.36, 'open']], t, seen);
    t = drive(m, 15, (i) => [[0.35, 0.5, 'open'], [0.65 + 0.015 * i, 0.36 + 0.01 * i, 'open']], t, seen);
    checkTrue('#26: opening the fist after a tilt does not chain into explode', !seen.has(MODE.EXPLODE), [...seen].join(','));
    check('#26: dropping the second hand afterwards does not stretch the model', object.scale.distanceTo(scaleAtRelease), 0, 0);

    // Same chain from a two-hand pinch: releasing both pinches leaves two open hands.
    m = fresh();
    t = 1000;
    t = drive(m, 20, () => [[0.4, 0.5, 'pinch'], [0.6, 0.5, 'pinch']], t);
    checkTrue('two-hand pinch is active before the release', m.mode === MODE.TRANSFORM, `mode=${m.mode}`);
    seen = new Set();
    const scaleAtPinchRelease = object.scale.clone();
    t = drive(m, 30, () => [[0.4, 0.5, 'open'], [0.6, 0.5, 'open']], t, seen);
    t = drive(m, 15, (i) => [[0.4 - 0.01 * i, 0.5, 'open'], [0.6 + 0.01 * i, 0.5, 'open']], t, seen);
    checkTrue('#26: releasing a two-hand pinch does not chain into explode', !seen.has(MODE.EXPLODE), [...seen].join(','));
    check('#26: pulling the released hands apart does not stretch the model', object.scale.distanceTo(scaleAtPinchRelease), 0, 0);

    // The gap is a pause, not a lock: relax (no gesture pose) past it and explode works.
    t = drive(m, 15, () => [], t); // hands down 0.5s
    seen = new Set();
    const scaleBefore = object.scale.x;
    t = drive(m, 5, () => [[0.45, 0.5, 'open'], [0.55, 0.5, 'open']], t, seen);
    t = drive(m, 15, (i) => [[0.45 - 0.015 * i, 0.5, 'open'], [0.55 + 0.015 * i, 0.5, 'open']], t, seen);
    checkTrue('after relaxing past the gap, explode still engages and stretches', seen.has(MODE.EXPLODE) && object.scale.x > scaleBefore + 0.1,
      `modes ${[...seen].join(',')}, scale.x ${scaleBefore.toFixed(2)} -> ${object.scale.x.toFixed(2)}`);

    // Resuming the SAME gesture is never held back: let go of a fist, re-close it at once.
    m = fresh();
    t = 1000;
    t = drive(m, 10, () => [[0.5, 0.5, 'fist']], t);
    t = drive(m, 9, () => [[0.5, 0.5, 'open']], t); // 300ms open: grab has ended
    checkTrue('grab ended after the fist opened', m.mode === MODE.IDLE, `mode=${m.mode}`);
    t = drive(m, 3, () => [[0.5, 0.5, 'fist']], t);
    checkTrue('re-closing the fist inside the gap grabs again straight away', m.mode === MODE.GRAB, `mode=${m.mode}`);

    // #27 repro: explode (pull apart), hold, then bring the hands together FAST.
    m = fresh();
    t = 1000;
    object.position.set(0.3, 0, 0); // a reset would snap this to 0
    t = drive(m, 8, () => [[0.45, 0.5, 'open'], [0.55, 0.5, 'open']], t);
    t = drive(m, 18, (i) => [[0.45 - 0.017 * i, 0.5, 'open'], [0.55 + 0.017 * i, 0.5, 'open']], t);
    t = drive(m, 10, () => [[0.14, 0.5, 'open'], [0.86, 0.5, 'open']], t);
    const resets0 = m.resetCount;
    t = drive(m, 6, (i) => { const s = 0.72 - 0.68 * (i + 1) / 6; return [[0.5 - s / 2, 0.5, 'open'], [0.5 + s / 2, 0.5, 'open']]; }, t);
    // Superseded 2026-10-01 by the owner-approved clap E2 (Ricky gesture feedback): a clap
    // during an explode, pulled apart or not, resets. This close (0.72 -> 0.04 apart in 200 ms)
    // is a physical clap, so it now resets; a slow un-explode still never does (below).
    check('#27 → E2: a fast close (a clap) during a pulled-apart explode now resets', m.resetCount - resets0, 1);
    check('#27 → E2: ... so the model goes home', object.position.x, 0, 1e-9);
    m = fresh();
    t = 1000;
    t = drive(m, 8, () => [[0.45, 0.5, 'open'], [0.55, 0.5, 'open']], t);
    t = drive(m, 18, (i) => [[0.45 - 0.017 * i, 0.5, 'open'], [0.55 + 0.017 * i, 0.5, 'open']], t);
    const resetsSlow = m.resetCount;
    t = drive(m, 40, (i) => { const s = 0.72 - 0.68 * (i + 1) / 40; return [[0.5 - s / 2, 0.5, 'open'], [0.5 + s / 2, 0.5, 'open']]; }, t);
    check('#27: a slow un-explode (1.3 s) never resets', m.resetCount - resetsSlow, 0);

    // A clap straight after letting go of another gesture (inside the gap) is also blocked.
    m = fresh();
    t = 1000;
    object.position.set(0.3, 0, 0);
    t = drive(m, 15, () => [[0.2, 0.5, 'fist'], [0.8, 0.5, 'open']], t);
    t = drive(m, 8, () => [[0.2, 0.5, 'open'], [0.8, 0.5, 'open']], t); // grab ends ~220ms in
    const resets1 = m.resetCount;
    t = drive(m, 6, (i) => { const s = 0.6 - 0.56 * (i + 1) / 6; return [[0.5 - s / 2, 0.5, 'open'], [0.5 + s / 2, 0.5, 'open']]; }, t);
    check('a clap inside the neutral gap after a tilt does not reset', m.resetCount - resets1, 0);

    // From rest, with everything armed, a clap still resets (the pose is also explode's, so
    // explode engages first but has not pulled apart).
    m = fresh();
    t = 1000;
    object.position.set(0.3, 0, 0);
    t = drive(m, 5, () => [[0.2, 0.5, 'open'], [0.8, 0.5, 'open']], t);
    t = drive(m, 6, (i) => { const s = 0.6 - 0.56 * (i + 1) / 6; return [[0.5 - s / 2, 0.5, 'open'], [0.5 + s / 2, 0.5, 'open']]; }, t);
    check('a clap from rest (everything armed, 30fps) still resets', object.position.x, 0, 0);

    // After the clap the hands are together and open -- explode's pose. Separating them must
    // not explode the model that was just reset.
    seen = new Set();
    t = drive(m, 15, (i) => [[0.48 - 0.02 * i, 0.5, 'open'], [0.52 + 0.02 * i, 0.5, 'open']], t, seen);
    checkTrue('separating the hands after a clap does not explode the fresh reset', !seen.has(MODE.EXPLODE) && object.scale.x === 1,
      `modes ${[...seen].join(',')}, scale.x ${object.scale.x.toFixed(3)}`);

    // Found while fixing #27: hands that leave the frame apart and come back close together
    // 0.5s later used to read as a fast close (the last two-hand sample was kept across the
    // dropout) and reset the model. Clap only armed, so nothing else is involved.
    m = fresh();
    m.configure({ channels: ['clap'] });
    t = 1000;
    const resets2 = m.resetCount;
    t = drive(m, 5, () => [[0.26, 0.5, 'open'], [0.74, 0.5, 'open']], t);
    t = drive(m, 15, () => [], t);
    t = drive(m, 5, () => [[0.45, 0.5, 'open'], [0.55, 0.5, 'open']], t);
    check('hands re-entering close together after a dropout are not a clap', m.resetCount - resets2, 0);
    m.reset();
  });

  // Owner-shaped synthetic hands with world landmarks (gun-lab's bone model), shared by the
  // pointer groups below. Moved out of 'Pointer is never a grab' unchanged so the finger-gun
  // pointer group can replay the same hands.
  const ASPECT = 16 / 9;
  const MCP = { index: [0.03, 0.085, 0], middle: [0.008, 0.09, 0], ring: [-0.012, 0.085, 0], pinky: [-0.03, 0.075, 0] };
  const BONES = { index: [0.04, 0.025, 0.02], middle: [0.045, 0.028, 0.02], ring: [0.042, 0.026, 0.02], pinky: [0.032, 0.02, 0.018] };
  const THUMB = [[0.02, 0.02, -0.005], [0.045, 0.05, -0.015], [0.05, 0.08, -0.018], [0.045, 0.105, -0.015]];
  const rot = ([x, y, z], [rx, ry, rz]) => {
    const r = (d) => (d * Math.PI) / 180;
    let c = Math.cos(r(rx)), s = Math.sin(r(rx));
    [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(r(ry)); s = Math.sin(r(ry));
    [x, z] = [x * c + z * s, -x * s + z * c];
    c = Math.cos(r(rz)); s = Math.sin(r(rz));
    [x, y] = [x * c - y * s, x * s + y * c];
    return [x, y, z];
  };
  // flex: per finger [MCP, PIP, DIP] degrees. Returns world landmarks (metres).
  const world = (flex, view) => {
    const pts = Array.from({ length: 21 }, () => [0, 0, 0]);
    for (let k = 0; k < 4; k++) pts[1 + k] = THUMB[k];
    ['index', 'middle', 'ring', 'pinky'].forEach((name, f) => {
      let p = MCP[name].slice();
      pts[5 + f * 4] = p;
      let th = 0;
      for (let b = 0; b < 3; b++) {
        th += (flex[name][b] * Math.PI) / 180;
        p = [p[0], p[1] + BONES[name][b] * Math.cos(th), p[2] - BONES[name][b] * Math.sin(th)];
        pts[5 + f * 4 + b + 1] = p;
      }
    });
    return pts.map((q) => { const [x, y, z] = rot(q, view); return { x, y, z }; });
  };
  const all = (f) => ({ index: f, middle: f, ring: f, pinky: f });
  const POSES = {
    pointer: { index: [5, 22, 15], middle: [80, 74, 45], ring: [80, 74, 45], pinky: [80, 74, 45] },
    fist: all([80, 103, 60]),
    open: all([8, 21, 12])
  };
  const VIEW = { palm: [0, 0, 0], side: [0, 90, 90], camera: [-60, 0, 0] };
  // One camera frame of one hand: world + orthographic image landmarks (palm ~0.12 of the
  // frame height, gun-lab's projection), with tracking noise on both.
  const frame = (pose, view, gesture, { cx = 0.5, cy = 0.55, jitter = REALISTIC_JITTER, thumbTo = null } = {}) => {
    const w = world(POSES[pose], VIEW[view]);
    if (thumbTo !== null) w[4] = { x: w[8].x + 0.004, y: w[8].y, z: w[8].z }; // pinch: thumb on the index tip
    const k = 0.12 / 0.09;
    const j = (d) => (rnd() - 0.5) * 2 * d;
    return {
      gesture, handedness: 'Right', score: 0.9,
      worldLandmarks: w.map((p) => ({ x: p.x + j(0.0015), y: p.y + j(0.0015), z: p.z + j(0.0015) })),
      landmarks: w.map((p) => ({ x: cx + (p.x * k) / ASPECT + j(jitter), y: cy - p.y * k + j(jitter), z: p.z * k }))
    };
  };

  group('Two-hand scale starts with everything armed (BUGS #45)', () => {
    // Owner live bug 2026-10-01 ("Everything on" drill): raising two open hands is explode's
    // pose, so explode engaged; pinching then ended it, and its neutral gap waited for a
    // neutral moment a held pinch never gives -- scale never started (0 of 76 pinching frames).
    const FR = 1000 / 30;
    const drive = (m, n, specs, t, seen) => {
      for (let i = 0; i < n; i++) {
        const mode = m.update(specs(i).map(([x, y, kind]) => hand(x, y, 0, kind)), 1.78, t);
        seen?.add(mode);
        t += FR;
      }
      return t;
    };
    const fresh = () => {
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.scale.set(1, 1, 1);
      const m = createManipulator(object, camera);
      m.reset();
      m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
      return m;
    };
    // Open hands up (explode engages), then both pinch and pull apart.
    let m = fresh();
    let t = 1000;
    let seen = new Set();
    t = drive(m, 12, () => [[0.4, 0.5, 'open'], [0.6, 0.5, 'open']], t, seen);
    checkTrue('open hands raised first engage explode (the trigger)', seen.has(MODE.EXPLODE), [...seen].join(','));
    seen = new Set();
    t = drive(m, 15, () => [[0.4, 0.5, 'pinch'], [0.6, 0.5, 'pinch']], t, seen);
    checkTrue('#45: pinching after open hands reaches transform within 0.5 s', seen.has(MODE.TRANSFORM), [...seen].join(','));
    const s0 = object.scale.x;
    t = drive(m, 20, (i) => [[0.4 - 0.01 * i, 0.5, 'pinch'], [0.6 + 0.01 * i, 0.5, 'pinch']], t);
    checkTrue('#45: ... and pulling apart grows the model', object.scale.x > s0 + 0.1, `scale ${fmt(s0)} -> ${fmt(object.scale.x)}`);

    // #26 still holds: releasing the pinch into open hands does not chain into explode.
    seen = new Set();
    t = drive(m, 30, () => [[0.4, 0.5, 'open'], [0.6, 0.5, 'open']], t, seen);
    checkTrue('#26 kept: releasing the pinch into open hands does not explode', !seen.has(MODE.EXPLODE), [...seen].join(','));
  });

  group('Pointer is never a grab (live probe 2026-10-01)', () => {
    // Owner's webcam, 2026-10-01: a pointer (index out, middle/ring/pinky curled) labelled
    // None was read as a grabbing fist on 100% of frames (isFistShape counts 3 curled fingers
    // in 2D). Replays owner-shaped hands through the live page's per-frame pipeline
    // (smoothLandmarks -> gestures.annotateHand -> manipulator.update, 50 fps like the probe).
    // World hands use gun-lab's bone model, with flexion chosen to land inside the owner's
    // measured ranges (LEDGER.md / gunPose.js comments), checked first below.
    const FR = 1000 / 50;
    // Before annotateHand existed, hologram.js read hands like this. Kept as the fallback so
    // this group can be pointed at the pre-fix gestures.js and shown to fail there.
    const annotate = gestures.annotateHand ?? ((h, a) => {
      h.pinch = gestures.pinch(h.landmarks, a, { gesture: h.gesture });
      h.fistLike = gestures.isFistLike(h.gesture, h.landmarks, a);
      return h;
    });

    const fresh = () => {
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.scale.set(1, 1, 1);
      RS();
      const m = createManipulator(object, camera);
      m.reset();
      m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
      return m;
    };
    // Runs n frames; specs(i) -> array of frame() hands. Returns per-frame records.
    const run = (m, n, specs, t) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const hands = specs(i);
        SM(hands, t.now);
        hands.forEach((h) => annotate(h, ASPECT));
        const mode = m.update(hands, ASPECT, t.now);
        m.tick(t.now);
        out.push({ t: t.now, mode, hands });
        t.now += FR;
      }
      return out;
    };
    const pct = (rows, pred) => Math.round((100 * rows.filter(pred).length) / rows.length);

    // 0. The replayed hands are owner-shaped.
    const fp = gunFeatures(world(POSES.pointer, VIEW.side));
    const ff = gunFeatures(world(POSES.fist, VIEW.palm));
    const fo = gunFeatures(world(POSES.open, VIEW.palm));
    checkTrue('replayed hands sit in the owner\'s measured ranges',
      fp.indexBendDeg >= 15 && fp.indexBendDeg <= 25 && fp.index.reach >= 1.81 && fp.index.reach <= 1.91 &&
      fp.othersMinPipDeg >= 66 && fp.othersMinPipDeg <= 81 && fp.othersMaxReach >= 0.76 && fp.othersMaxReach <= 0.85 &&
      ff.indexBendDeg >= 97 && ff.indexBendDeg <= 109 && ff.index.reach >= 0.6 && ff.index.reach <= 0.88 &&
      fo.othersMinPipDeg >= 19 && fo.othersMinPipDeg <= 24,
      `pointer bend ${fp.indexBendDeg}° reach ${fp.index.reach}, others ${fp.othersMinPipDeg}°/${fp.othersMaxReach}; ` +
      `fist bend ${ff.indexBendDeg}° reach ${ff.index.reach}; open others ${fo.othersMinPipDeg}°`);

    // 1. A held pointer never grabs (2 s, label None, side-on and aimed at the camera).
    for (const view of ['side', 'camera']) {
      const m = fresh();
      const t = { now: 1000 };
      const rows = run(m, 100, () => [frame('pointer', view, 'None')], t);
      const fistPct = pct(rows, (r) => r.hands[0].fistLike);
      const grabPct = pct(rows, (r) => r.mode === MODE.GRAB);
      check(`pointer ${view === 'side' ? 'side-on' : 'at the camera'} (label None): frames read as a fist, % (was 100)`, fistPct, 0);
      check(`pointer ${view === 'side' ? 'side-on' : 'at the camera'}: frames in grab, % (was 100)`, grabPct, 0);
    }

    // 2. A real fist is still a fist, from every view and with either label.
    for (const [view, label] of [['palm', 'None'], ['side', 'None'], ['camera', 'None'], ['palm', 'Closed_Fist']]) {
      const m = fresh();
      const t = { now: 1000 };
      const rows = run(m, 50, () => [frame('fist', view, label)], t);
      const held = rows.slice(5); // the grab enters after triggerFrames (50 ms)
      checkTrue(`real fist (${view}, ${label}): read as a fist and grabbing`,
        pct(rows, (r) => r.hands[0].fistLike) === 100 && pct(held, (r) => r.mode === MODE.GRAB) === 100,
        `fist ${pct(rows, (r) => r.hands[0].fistLike)}%, grab ${pct(held, (r) => r.mode === MODE.GRAB)}% after 100 ms, pointer ${pct(rows, (r) => r.hands[0].pointer?.gun)}%`);
    }
    {
      const m = fresh();
      const rows = run(m, 50, () => [frame('open', 'palm', 'None')], { now: 1000 });
      check('open hand: frames read as a fist or a pointer, %', pct(rows, (r) => r.hands[0].fistLike || r.hands[0].pointer?.gun), 0);
    }

    // 3. Pinch: the pointer no longer blocks its own hand's pinch as 'fist', the other hand's
    // pinch is unaffected, and a fist still blocks a pinch.
    {
      const m = fresh();
      const rows = run(m, 50, () => [frame('pointer', 'camera', 'None', { cx: 0.3 }), frame('open', 'palm', 'None', { cx: 0.7, thumbTo: 8 })], { now: 1000 });
      check('pointer hand: pinch rejected as fist, % of frames (was 100)', pct(rows, (r) => r.hands[0].pinch.rejectedBy === 'fist'), 0);
      check('pointer hand: pinching (it is not a pinch), %', pct(rows, (r) => r.hands[0].pinch.pinching), 0);
      check('other hand pinching while the pointer aims, %', pct(rows, (r) => r.hands[1].pinch.pinching), 100);
      check('... and none of it grabs, %', pct(rows, (r) => r.mode === MODE.GRAB), 0);
      const fistRows = run(fresh(), 20, () => [frame('fist', 'palm', 'None')], { now: 1000 });
      check('a fist still blocks a pinch (rejectedBy fist), %', pct(fistRows, (r) => r.hands[0].pinch.rejectedBy === 'fist'), 100);
    }

    // 4. Pointer + a relaxed other hand, aiming around: no grab, and (now that the pointer
    // is not a fist) no explode either.
    {
      const m = fresh();
      const rows = run(m, 75, (i) => [frame('pointer', 'side', 'None', { cx: 0.35 - 0.003 * i }), frame('open', 'palm', 'None', { cx: 0.7 })], { now: 1000 });
      check('pointer + open other hand, moving apart: frames not idle, %', pct(rows, (r) => r.mode !== MODE.IDLE), 0);
      check('... model scale unchanged', object.scale.x, 1, 0);
    }

    // 5. A grab does not continue as a pointer: extend the index mid-grab and sweep the hand.
    {
      const m = fresh();
      const t = { now: 1000 };
      run(m, 25, () => [frame('fist', 'palm', 'None')], t);
      const grabbed = m.mode === MODE.GRAB;
      const before = object.position.clone();
      run(m, 25, (i) => [frame('pointer', 'side', 'None', { cx: 0.5 + 0.006 * i })], t);
      checkTrue('a grab that turns into a pointer stops steering at once', grabbed && object.position.distanceTo(before) < 1e-6,
        `grabbed ${grabbed}, moved ${object.position.distanceTo(before).toFixed(4)} while the pointer swept 0.15`);
    }

    // 6. Post-pointer gap: curling the index (pointer -> fist) is a fist, but it may not grab
    // until ~300 ms after the pointer ends. From rest a fist grabs at once.
    const firstGrabMs = (rows) => { const r = rows.find((x) => x.mode === MODE.GRAB); return r ? Math.round(r.t - rows[0].t) : Infinity; };
    {
      const m = fresh();
      const t = { now: 1000 };
      run(m, 50, () => [frame('pointer', 'camera', 'None')], t);
      const rows = run(m, 40, () => [frame('fist', 'camera', 'None')], t);
      const ms = firstGrabMs(rows);
      checkTrue('pointer -> fist: no grab for ~300 ms, then it grabs', ms >= 300 && ms <= 400, `first grab ${ms} ms after the pointer ended`);
    }
    {
      const m = fresh();
      const t = { now: 1000 };
      run(m, 50, () => [], t);
      const ms = firstGrabMs(run(m, 40, () => [frame('fist', 'camera', 'None')], t));
      checkTrue('rest -> fist (control): grabs straight away', ms <= 80, `first grab ${ms} ms`);
    }
    {
      // A one-frame pointer dropout mid-aim reads as a fist on that frame; the gap holds it.
      const m = fresh();
      const t = { now: 1000 };
      const rows = run(m, 100, (i) => [i % 10 === 9 ? frame('fist', 'camera', 'None') : frame('pointer', 'camera', 'None')], t);
      check('pointer with a misread frame every 200 ms: frames in grab, %', pct(rows, (r) => r.mode === MODE.GRAB), 0);
    }
    object.position.set(0, 0, 0);
    object.quaternion.identity();
    object.scale.set(1, 1, 1);
  });

  group('Reset is undoable, one step (BUGS #27)', () => {
    const g = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05)); a.position.set(0.1, 0, 0);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05)); b.position.set(-0.1, 0, 0);
    g.add(a, b);
    const m = createManipulator(g, camera);
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
    checkTrue('nothing to undo before any reset', !m.canUndo && m.undo() === false);
    // Explode it, then move it and turn a part by hand, the kind of work a misfired clap wiped.
    let t = 1000;
    for (let i = 0; i < 8; i++) { m.update([hand(0.45, 0.5, 0, 'open'), hand(0.55, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    for (let i = 1; i <= 20; i++) { m.update([hand(0.45 - 0.015 * i, 0.5, 0, 'open'), hand(0.55 + 0.015 * i, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    for (let i = 0; i < 20; i++) { m.update([], 1.78, t); t += 33.3; }
    g.position.set(0.2, -0.1, 0);
    g.scale.setScalar(1.5);
    b.rotation.set(0, 0.7, 0);
    const want = { g: g.position.clone(), s: g.scale.x, a: a.position.clone(), b: b.position.clone(), bq: b.quaternion.clone() };
    checkTrue('the group is exploded before the reset', a.position.x > 0.15, `a.x=${a.position.x.toFixed(3)}`);

    m.reset();
    checkTrue('reset puts everything home', g.position.length() === 0 && a.position.x === 0.1 && m.canUndo);
    checkTrue('undo returns true', m.undo() === true);
    check('undo restores the group position', g.position.distanceTo(want.g), 0, 0);
    check('undo restores the group scale', g.scale.x, want.s, 0);
    check('undo restores each exploded part', a.position.distanceTo(want.a) + b.position.distanceTo(want.b), 0, 0);
    check("undo restores a part's own rotation", b.quaternion.angleTo(want.bq), 0, 0);
    checkTrue('undo is one step: a second undo does nothing', !m.canUndo && m.undo() === false && g.position.distanceTo(want.g) === 0);

    // The explode keeps working from the restored amount (no jump back to 0 on the next pull).
    const aBefore = a.position.x;
    for (let i = 0; i < 8; i++) { m.update([hand(0.3, 0.5, 0, 'open'), hand(0.7, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    checkTrue('two still open hands after an undo do not snap the parts', Math.abs(a.position.x - aBefore) < 1e-9, `a.x ${aBefore.toFixed(3)} -> ${a.position.x.toFixed(3)}`);

    // A clap reset is undoable the same way.
    g.position.set(0.25, 0, 0);
    m.reset(); m.undo(); // clear state; g stays at 0.25
    for (let i = 0; i < 20; i++) { m.update([], 1.78, t); t += 33.3; }
    for (let i = 0; i < 5; i++) { m.update([hand(0.2, 0.5, 0, 'open'), hand(0.8, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    for (let i = 1; i <= 6; i++) { const s = 0.6 - 0.56 * i / 6; m.update([hand(0.5 - s / 2, 0.5, 0, 'open'), hand(0.5 + s / 2, 0.5, 0, 'open')], 1.78, t); t += 33.3; }
    checkTrue('the clap fired', g.position.x === 0, `x=${g.position.x}`);
    m.undo();
    check('undo after a clap restores the pose', g.position.x, 0.25, 0);
  });

  const om = await import(`./platform/objectmode.js${V}`);
  group('Platform object mode — wheel steps, eased drag, exact history', () => {
    const W = { deltaMode: 0, deltaX: 0 };
    check('a 100px wheel notch reads 100px', om.wheelPixels({ ...W, deltaY: 100 }), 100);
    check('a line-mode notch (Firefox, 3 lines) reads 120px', om.wheelPixels({ ...W, deltaMode: 1, deltaY: 3 }), 120);
    check('Shift+wheel on macOS (deltaX only) is read', om.wheelPixels({ ...W, deltaY: 0, deltaX: -100 }), -100);
    check('one burst event is capped at two notches', om.wheelPixels({ ...W, deltaY: 1000 }), 200);

    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;opacity:0;pointer-events:none';
    document.body.appendChild(canvas);
    const cam = new THREE.PerspectiveCamera(50, 400 / 300, 0.01, 100);
    cam.position.set(0, 2, 3);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    scene.add(root);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshBasicMaterial());
    mesh.userData.partId = '1.1';
    mesh.userData.itemId = 1;
    root.add(mesh);
    scene.updateMatrixWorld(true);
    const edits = [];
    const controls = { enabled: true };
    const mode = om.createObjectMode({ camera: cam, canvas, controls, materialFor: () => mesh.material, edits, onChange: null });
    mode.addParts([{ id: '1.1', mesh }]);
    mode.addItem(1, root);
    mode.setMode('object');
    const rect = canvas.getBoundingClientRect();
    const screenOf = (v) => { const p = v.clone().project(cam); return { x: rect.left + (p.x + 1) / 2 * rect.width, y: rect.top + (1 - p.y) / 2 * rect.height }; };
    const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true }));

    const before = om.snapshot(mesh);
    const c = screenOf(new THREE.Vector3(0, 0, 0));
    fire('pointerdown', c.x, c.y);
    checkTrue('pressing on the part starts a drag', mode.dragging, `dragging=${mode.dragging}`);
    let now = 5000;
    for (let i = 1; i <= 6; i++) { fire('pointermove', c.x + 10 * i, c.y + 4 * i); mode.tick(now); now += 16.7; }
    const eased = mesh.position.x;
    fire('pointerup', c.x + 60, c.y + 24);
    // Where the cursor ray actually meets the drag plane, computed independently.
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(((c.x + 60 - rect.left) / rect.width) * 2 - 1, -((c.y + 24 - rect.top) / rect.height) * 2 + 1), cam);
    const hitEnd = new THREE.Vector3();
    rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitEnd);
    rc.setFromCamera(new THREE.Vector2(((c.x - rect.left) / rect.width) * 2 - 1, -((c.y - rect.top) / rect.height) * 2 + 1), cam);
    const hitStart = new THREE.Vector3();
    rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitStart);
    const want = hitEnd.clone().sub(hitStart);
    checkTrue('mid-drag the part eases toward the cursor (not yet all the way)', eased > 0 && eased < want.x,
      `${(eased * 100).toFixed(1)}cm of ${(want.x * 100).toFixed(1)}cm`);
    checkTrue('release lands exactly under the cursor', Math.abs(mesh.position.x - want.x) < 1e-9 && Math.abs(mesh.position.z - want.z) < 1e-9,
      `off by ${Math.hypot(mesh.position.x - want.x, mesh.position.z - want.z).toExponential(1)}`);
    checkTrue('one move edit is recorded with the true drop point', edits.length === 1 && edits[0].op === 'move' && JSON.stringify(edits[0].after) === JSON.stringify(om.snapshot(mesh)),
      `${edits.length} edit(s), op ${edits[0]?.op}`);
    checkTrue('controls are re-enabled after the drag', controls.enabled, '');

    // Wheel: two notches of Shift+wheel coalesce into one rotate edit of exactly 15°.
    mode.select('1.1');
    const afterMove = om.snapshot(mesh);
    for (let i = 0; i < 2; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, shiftKey: true, cancelable: true }));
    check('two Shift+wheel notches = one rotate edit', edits.length, 2);
    check('…of exactly 15°', (edits[1].dy * 180) / Math.PI, 15, 1e-9);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, deltaMode: 0, altKey: true, cancelable: true }));
    check('one Alt+wheel notch scales ×1.051', edits[2].factor, Math.exp(0.05), 1e-9);
    const end = om.snapshot(mesh);
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    mode.replayTo(0);
    checkTrue('replayTo(0) restores the loaded state bit-exactly', same(om.snapshot(mesh), before), '');
    mode.replayTo(edits[0].seq);
    checkTrue('replayTo(first edit) reproduces the move bit-exactly', same(om.snapshot(mesh), afterMove), '');
    mode.replayTo(Infinity);
    checkTrue('replayTo(end) reproduces the final state bit-exactly', same(om.snapshot(mesh), end), '');
    mode.undo(); mode.undo(); mode.undo();
    checkTrue('undoing all three edits is bit-exact', same(om.snapshot(mesh), before) && edits.length === 0, `${edits.length} edits left`);
    mode.setMode('scene');
    canvas.remove();
  });

  // ---- saved notes survive panel construction and a carousel swap ----------------------
  // Found by the 2026-09-29 lab run: with ANY saved note, createMeasurePanel threw a TDZ
  // ReferenceError (annotations restored notes and called back into renderNotes before the
  // `annotations` const existed), which left hologram.html's carousel stuck busy and the
  // camera button disabled; and dispose() (every carousel swap) saved an empty list over the
  // model's stored notes. Uses its own storage key and cleans up after itself.
  const { createMeasurePanel } = await import(`./measurePanel.js${V}`);
  group('Measure panel — saved notes (load + swap-away)', () => {
    const key = 'hologram-notes:__regression-test';
    const saved = JSON.stringify([{ x: 0, y: 0.1, z: 0, text: 'kept' }]);
    localStorage.setItem(key, saved);
    const panelScene = new THREE.Scene();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5));
    panelScene.add(box);
    const mount = document.createElement('div');
    mount.hidden = true;
    document.body.appendChild(mount);
    let panel = null;
    let err = null;
    try {
      panel = createMeasurePanel({
        mount, object: box, camera, scene: panelScene,
        renderer: { domElement: document.createElement('canvas') },
        modelName: '__regression-test'
      });
    } catch (e) {
      err = e;
    }
    checkTrue('a model with a saved note builds its panel without throwing', !err, err ? String(err) : 'ok');
    const rows = mount.querySelectorAll('.note-row').length;
    checkTrue('the saved note is listed', rows === 1, `${rows} note rows`);
    panel?.dispose();
    const after = localStorage.getItem(key);
    checkTrue('dispose (a carousel swap) keeps the stored notes', after === saved, `stored after dispose: ${after}`);
    localStorage.removeItem(key);
    mount.remove();
  });

  // ---- finger-gun pointer, slice 1 (pointer.js, reticle.js; 2026-10-01) ------------------
  const ptr = await import(`./pointer.js${V}`);
  const ret = await import(`./reticle.js${V}`);
  group('Finger-gun pointer — engage, aim, hold, click (pointer.js, reticle.js)', () => {
    // Replays owner-shaped synthetic hands through the live page's per-frame order:
    // smoothLandmarks -> annotateHand -> createEngagement -> manipulator.update -> pointer.update.
    const FR = 1000 / 50;
    const t = { now: 50000 };
    const fresh = () => {
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.scale.set(1, 1, 1);
      RS();
      const m = createManipulator(object, camera);
      m.reset();
      m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
      return { m, eng: ptr.createEngagement(), p: ptr.createPointer() };
    };
    // One frame: specs -> hands; returns { mode, click, state, hands }.
    const step = (rig, hands) => {
      SM(hands, t.now);
      hands.forEach((h) => gestures.annotateHand(h, ASPECT));
      rig.eng.update(hands);
      const mode = rig.m.update(hands, ASPECT, t.now);
      rig.m.tick(t.now);
      const click = rig.p.update(hands, ASPECT, t.now);
      rig.p.tick(t.now);
      const out = { t: t.now, mode, click, state: rig.p.state, hands };
      t.now += FR;
      return out;
    };
    const gun = (cx, cy = 0.55, o = {}) => frame('pointer', 'side', 'None', { cx, cy, ...o });
    const other = (pinching, cx = 0.25, cy = 0.55) =>
      frame('open', 'palm', 'None', { cx, cy, jitter: 0, thumbTo: pinching ? 1 : null });

    // 1. Engage zone: wrist above the line counts; hysteresis between enter and exit.
    {
      const eng = ptr.createEngagement();
      const at = (y) => { const h = hand(0.5, y, 0, 'open'); eng.update([h]); return h.engaged; };
      const seq = [at(0.8), at(0.91), at(0.96), at(0.91), at(0.8)];
      checkTrue('engage: raised, stays inside the band, lowered, stays lowered in the band, raised again',
        seq.join() === 'true,true,false,false,true', seq.join());
      const lone = ptr.createEngagement();
      const h = hand(0.5, 0.91, 0, 'open');
      lone.update([h]);
      checkTrue('a hand that first appears inside the band starts at rest', h.engaged === false, String(h.engaged));
    }

    // 2. A lowered fist does nothing; the same fist raised grabs.
    {
      const run = (y) => {
        const rig = fresh();
        let grabs = 0;
        for (let i = 0; i < 40; i++) {
          const h = hand(0.4 + i * 0.004, y, 0, 'fist');
          rig.eng.update([h]);
          if (rig.m.update([h], ASPECT, t.now) === MODE.GRAB) grabs++;
          rig.m.tick(t.now);
          t.now += FR;
        }
        return { grabs, moved: object.position.length() };
      };
      const low = run(0.97);
      const high = run(0.6);
      checkTrue('lowered fist (wrist y 0.97): never grabs, model still', low.grabs === 0 && low.moved < 1e-6,
        `${low.grabs} grab frames, moved ${low.moved.toFixed(4)}`);
      checkTrue('raised fist (wrist y 0.60): grabs and moves the model', high.grabs > 30 && high.moved > 0.01,
        `${high.grabs} grab frames, moved ${high.moved.toFixed(3)}`);
    }

    // 3. A held pointer is detected and its cursor holds still under tracking noise.
    {
      const rig = fresh();
      const rows = [];
      for (let i = 0; i < 100; i++) rows.push(step(rig, [gun(0.5)]));
      const aim = rows.filter((r) => r.state.mode === 'aim').length;
      const drift = Math.hypot(rows[99].state.x - rows[5].state.x, rows[99].state.y - rows[5].state.y);
      let maxStep = 0;
      for (let i = 11; i < 100; i++) maxStep = Math.max(maxStep, Math.hypot(rows[i].state.x - rows[i - 1].state.x, rows[i].state.y - rows[i - 1].state.y));
      checkTrue('still pointer (2 s, realistic jitter): aiming on >= 95% of frames', aim >= 95, `${aim}%`);
      checkTrue('still pointer: cursor drift < 0.01 NDC over 2 s (absolute + One Euro)', drift < 0.01, drift.toFixed(5));
      checkTrue('still pointer: largest frame-to-frame step < 0.004 NDC (< 2 px on 900 px)', maxStep < 0.004, maxStep.toFixed(5));
      checkTrue('a pointer never grabs or transforms while aiming', rows.every((r) => r.mode === MODE.IDLE), 'all idle');
    }

    // 4. Absolute: the same 0.1-frame palm move gives the same cursor move, slow or fast,
    //    = 0.1 x 2 / reach-box width, mirrored like the ghost hands.
    {
      const move = (frames) => {
        const rig = fresh();
        for (let i = 0; i < 10; i++) step(rig, [gun(0.5, 0.55, { jitter: 0 })]);
        const x0 = rig.p.state.x;
        for (let i = 1; i <= frames; i++) step(rig, [gun(0.5 + (0.1 * i) / frames, 0.55, { jitter: 0 })]);
        for (let i = 0; i < 40; i++) step(rig, [gun(0.6, 0.55, { jitter: 0 })]);
        return rig.p.state.x - x0;
      };
      const want = (-0.1 * 2) / (ptr.DEFAULT_REACH.x1 - ptr.DEFAULT_REACH.x0);
      const slow = move(200);
      const fast = move(5);
      check('slow move: cursor moves 0.1 x 2 / reach width, mirrored', slow, want, 0.01);
      check('fast move: the same distance (no speed gain, nothing to drift)', fast, want, 0.01);
    }

    // 5. Pose lost: the cursor holds still; re-entering goes straight to where the hand is; hides.
    {
      const rig = fresh();
      for (let i = 0; i < 30; i++) step(rig, [gun(0.5, 0.55, { jitter: 0 })]);
      const held = rig.p.state.x;
      const blip = step(rig, [frame('open', 'palm', 'None', { cx: 0.5, jitter: 0 })]);
      checkTrue('one-frame pose dropout: cursor held, still aiming', blip.state.mode === 'aim' && blip.state.x === held, blip.state.mode);
      let holding = true;
      for (let i = 1; i <= 25; i++) {
        const r = step(rig, [frame('open', 'palm', 'None', { cx: 0.5 - 0.004 * i, jitter: 0 })]);
        // Sticky pointer (round G): label None is wobble, held as 'aim' until STICKY_MS.
        if (i * FR > ptr.STICKY_MS + FR && r.state.mode !== 'clutch') holding = false;
      }
      checkTrue('pose lost: cursor held still while the open hand moves', holding && rig.p.state.x === held, `x ${rig.p.state.x} vs ${held}`);
      let r;
      for (let i = 0; i < 10; i++) r = step(rig, [gun(0.4, 0.55, { jitter: 0 })]);
      const at = ptr.mapReach(ptr.palmCentroid(r.hands[0].landmarks));
      check('re-entering the pose elsewhere: cursor is where the hand is (absolute)', rig.p.state.x, at.x, 0.005);
      const hideLog = [];
      // STICKY_MS of held aim, then CLUTCH_SHOW_MS visible-held: 1.85 s; 100 frames @ 50 fps = 2 s.
      for (let i = 0; i < 100; i++) { step(rig, []); if (i % 10 === 0) hideLog.push(rig.p.state.mode); }
      checkTrue('a held cursor hides after 0.35 + 1.5 s without the pose', rig.p.state.mode === 'off', hideLog.join(','));
    }

    // 6. Click = the other hand's pinch: one click per pinch, held pinches don't repeat.
    {
      const rig = fresh();
      const clicks = [];
      const modes = new Set();
      const go = (n, pinching) => {
        for (let i = 0; i < n; i++) {
          const r = step(rig, [gun(0.6), other(pinching)]);
          modes.add(r.mode);
          if (r.click) clicks.push(r.click);
        }
      };
      go(15, false); go(50, true); go(15, false); go(10, true); go(10, false);
      check('two pinches (one held 1 s) = exactly two clicks', clicks.length, 2);
      checkTrue('clicks are hand clicks with a cursor position', clicks.every((c) => c.source === 'hand' && Number.isFinite(c.x)), JSON.stringify(clicks[0]));
      checkTrue('pointing + other hand pinching never grabs, scales or explodes', [...modes].every((m) => m === MODE.IDLE), [...modes].join());
    }

    // 7. Rewind: the click lands where the cursor was 120 ms before the pinch was seen.
    {
      const rig = fresh();
      const xs = [];
      let click = null;
      for (let i = 0; i < 40 && !click; i++) {
        const r = step(rig, [gun(0.4 + 0.006 * i, 0.55, { jitter: 0 }), other(i >= 30)]);
        if (r.click) click = r.click;
        else xs.push({ t: r.t, x: r.state.x });
      }
      const want = [...xs].reverse().find((s) => s.t <= click.t - ptr.REWIND_MS);
      checkTrue('click while the aim is drifting lands at the rewound cursor (t - 120 ms)',
        click && want && Math.abs(click.x - want.x) < 1e-9 && Math.abs(click.x - xs[xs.length - 1].x) > 1e-4,
        click ? `click x ${click.x.toFixed(4)}, cursor 120 ms earlier ${want?.x.toFixed(4)}, at the pinch ${xs[xs.length - 1].x.toFixed(4)}` : 'no click');
    }

    // 8. No accidental clicks: a hand that arrives already pinching, or a lowered hand.
    {
      const rig = fresh();
      let n = 0;
      for (let i = 0; i < 20; i++) if (step(rig, [gun(0.6)]).click) n++;
      for (let i = 0; i < 20; i++) if (step(rig, [gun(0.6), other(true)]).click) n++;
      for (let i = 0; i < 20; i++) if (step(rig, [gun(0.6), other(false, 0.25, 0.97)]).click) n++;
      for (let i = 0; i < 20; i++) if (step(rig, [gun(0.6), other(true, 0.25, 0.97)]).click) n++;
      check('hand arriving mid-pinch, and a lowered hand pinching: no clicks', n, 0);
    }

    // 9. Mouse fallback: same cursor; the hand takes over without a jump.
    {
      const rig = fresh();
      rig.p.mouseMove(0.3, -0.2, t.now);
      const ms = rig.p.state;
      const mc = rig.p.mouseClick(0.31, -0.2, t.now);
      const r = step(rig, [gun(0.5, 0.55, { jitter: 0 })]);
      checkTrue('mouse drives the cursor and clicks (source mouse)', ms.mode === 'aim' && ms.source === 'mouse' && mc.source === 'mouse' && mc.x === 0.31, JSON.stringify({ mode: ms.mode, src: mc.source }));
      const want = ptr.mapReach(ptr.palmCentroid(r.hands[0].landmarks));
      checkTrue('the pointer pose takes over from the mouse at the hand\'s absolute position', r.state.source === 'hand' && Math.abs(r.state.x - want.x) < 1e-9 && Math.abs(r.state.y - want.y) < 1e-9, `${r.state.source} ${r.state.x.toFixed(3)},${r.state.y.toFixed(3)}`);
      rig.p.mouseLeave();
      checkTrue('mouse leaving the canvas does not hide a hand cursor', rig.p.state.mode === 'aim', rig.p.state.mode);
    }

    // 10. Reticle: surface hit, vertex snap with hysteresis, amber over inferred, eased.
    {
      const sc = new THREE.Scene();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5), new THREE.MeshBasicMaterial());
      sc.add(box);
      sc.updateMatrixWorld(true);
      const viewport = { width: 1600, height: 900 };
      const ndcOf = (v) => v.clone().project(camera);
      const pxToNdc = (px) => (2 * px) / viewport.width;
      const center = probe0(0, 0);
      function probe0(x, y, snapped = null) { return ret.probe(x, y, { object: box, camera, viewport, snapped }); }
      const ray = new THREE.Vector3().subVectors(center.point, camera.position);
      checkTrue('cursor over the box: hit, ring normal faces the camera', center && center.normal.dot(ray) < 0, center ? center.normal.toArray().map((n) => n.toFixed(2)).join() : 'miss');
      // Front-top-right corner of the box (a vertex), seen from the test camera.
      const corner = ndcOf(new THREE.Vector3(0.25, 0.4, 0.25));
      const near = probe0(corner.x - pxToNdc(8), corner.y - pxToNdc(8) * (viewport.width / viewport.height));
      checkTrue('8 px from a vertex (11 px diagonal): snaps onto it', near?.vertex && near.point.distanceTo(new THREE.Vector3(0.25, 0.4, 0.25)) < 1e-6, near?.vertex ? 'snapped' : 'not snapped');
      const at18 = (snapped) => probe0(corner.x - pxToNdc(18), corner.y - pxToNdc(4) * (viewport.width / viewport.height), snapped);
      checkTrue('18 px away: no fresh snap (beyond 14 px)', !at18(null)?.vertex, 'fresh');
      checkTrue('18 px away while snapped: stays snapped (hysteresis, releases at 22 px)', !!at18(near?.vertex)?.vertex, 'held');
      // Sweep a resting cursor around the 14 px radius with 2 px noise: snap must not flicker.
      let snapped = null;
      let toggles = 0;
      for (let i = 0; i < 120; i++) {
        const d = 14 + 3 * Math.sin(i / 10) + (rnd() - 0.5) * 4;
        const r2 = probe0(corner.x - pxToNdc(d), corner.y - pxToNdc(1), snapped);
        if (!!r2?.vertex !== !!snapped) toggles++;
        snapped = r2?.vertex ?? null;
      }
      checkTrue('cursor wobbling at the snap radius (±5 px): snap toggles at most twice in 120 frames', toggles <= 2, `${toggles} toggles`);

      box.userData.inferred = true;
      const reticle = ret.createReticle(sc);
      const ringOf = () => sc.children[sc.children.length - 1].children[0].children[0];
      let now = 0;
      const upd = () => reticle.update({ cursor: { x: 0, y: 0 }, object: box, camera, viewport, beamFrom: new THREE.Vector3(0.6, -0.3, 1.2), nowMs: (now += 1000 / 60) });
      const first = upd();
      const e1 = reticle.eased;
      const op1 = ringOf().material.opacity;
      for (let i = 0; i < 8; i++) upd(); // ~150 ms in
      const e150 = reticle.eased;
      for (let i = 0; i < 60; i++) upd();
      const eEnd = reticle.eased;
      checkTrue('over an inferred (filled-in) surface: the reticle turns amber', first?.inferred && eEnd.amber > 0.95, `amber ${eEnd.amber.toFixed(3)}`);
      checkTrue('no step changes: after one 60 fps frame, visibility and amber < 15% of the way', e1.vis < 0.15 && e1.amber < 0.15 && op1 < 0.15, `vis ${e1.vis.toFixed(3)}, amber ${e1.amber.toFixed(3)}`);
      checkTrue('eased >= 150 ms: still under 90% at 150 ms', e150.vis < 0.9 && e150.amber < 0.9, `vis ${e150.vis.toFixed(3)} at 150 ms`);
      checkTrue('beam is faint (opacity <= 0.25) and never brighter than the ring',
        sc.children[sc.children.length - 1].children[1].material.opacity <= 0.25, sc.children[sc.children.length - 1].children[1].material.opacity.toFixed(3));
      reticle.dispose();
      delete box.userData.inferred;
    }
  });

  const ghostMod = await import(`./ghostHands.js${V}`);
  group('Pointer — absolute cursor, smoothing, beam line-up (owner decision 1, 2026-10-01)', () => {
    const R = ptr.DEFAULT_REACH;
    // mapReach: the reach box's corners are the canvas corners, mirrored; outside is clamped.
    const tl = ptr.mapReach({ x: R.x0, y: R.y0 });
    const br = ptr.mapReach({ x: R.x1, y: R.y1 });
    const mid = ptr.mapReach({ x: (R.x0 + R.x1) / 2, y: (R.y0 + R.y1) / 2 });
    const out = ptr.mapReach({ x: -0.5, y: 2 });
    checkTrue('reach box -> canvas: image top-left = screen top-right (mirrored), bottom-right = bottom-left, centre = 0',
      tl.x === 1 && tl.y === 1 && br.x === -1 && br.y === -1 && Math.abs(mid.x) < 1e-9 && Math.abs(mid.y) < 1e-9,
      `${tl.x},${tl.y} ${br.x},${br.y} ${mid.x.toFixed(3)},${mid.y.toFixed(3)}`);
    checkTrue('outside the reach box: clamped to the canvas edge', out.x === 1 && out.y === -1, `${out.x},${out.y}`);

    // One Euro on the cursor: still-hand jitter cut, a deliberate step followed quickly,
    // and the same result at 30 and 60 fps.
    const run = (fps, ms, src) => {
      const f = ptr.createOneEuro2D();
      const outv = [];
      for (let t = 0; t <= ms; t += 1000 / fps) outv.push({ t, ...f.filter(...src(t), t) });
      return outv;
    };
    seed = 7;
    const noisy = run(30, 3000, () => [(rnd() - 0.5) * 0.02, (rnd() - 0.5) * 0.02]);
    const sd = (a) => Math.sqrt(a.reduce((q, v) => q + v * v, 0) / a.length);
    const outSd = sd(noisy.slice(15).map((p) => p.x));
    checkTrue('still hand, ±0.01 NDC jitter (sd 0.0058): filtered sd < 0.0025', outSd < 0.0025, outSd.toFixed(5));
    const stepAt = (fps) => {
      const o = run(fps, 1000, (t) => (t < 200 ? [0, 0] : [0.5, 0]));
      return o.find((p) => p.t >= 200 && p.x >= 0.45)?.t - 200;
    };
    const s30 = stepAt(30);
    const s60 = stepAt(60);
    checkTrue('a 0.5 NDC step reaches 90% within 150 ms (30 and 60 fps)', s30 <= 150 && s60 <= 150, `${s30?.toFixed(0)} ms @30, ${s60?.toFixed(0)} ms @60`);

    // setProfile: a narrower calibrated box makes the same hand move go further; junk is ignored.
    const p = ptr.createPointer();
    p.setProfile({ reach: { x0: 0.4, x1: 0.6, y0: 0.4, y1: 0.6 } });
    const narrow = p.profile.reach.x1 - p.profile.reach.x0;
    p.setProfile({ reach: { x0: 0.5, x1: 0.5, y0: 0, y1: 1 }, smoothing: { minCutoff: NaN } });
    checkTrue('setProfile applies a valid reach box and ignores a degenerate one / NaN smoothing',
      Math.abs(narrow - 0.2) < 1e-9 && Math.abs(p.profile.reach.x1 - p.profile.reach.x0 - 0.2) < 1e-9 && Number.isFinite(p.profile.smoothing.minCutoff),
      JSON.stringify(p.profile.reach));
    p.setProfile({ smoothing: ptr.SMOOTHING.steady });
    checkTrue('setProfile switches the smoothing preset', p.profile.smoothing.minCutoff === ptr.SMOOTHING.steady.minCutoff, String(p.profile.smoothing.minCutoff));

    // Beam line-up: shift a side-on pointer by ghostOffset; its tip + BEAM_LEN along wrist->tip
    // lands exactly on the cursor, in screen space, for cursors all over the canvas.
    const g = frame('pointer', 'side', 'None', { jitter: 0 });
    const va = 16 / 9;
    let worst = 0;
    for (const c of [{ x: 0, y: 0 }, { x: 0.9, y: -0.8 }, { x: -1, y: 1 }, { x: 0.3, y: 0.6 }]) {
      const o = ptr.ghostOffset(g, c, va);
      const w = g.landmarks[0];
      const tp = g.landmarks[8];
      const tipN = { x: 1 - 2 * (tp.x + o.dx), y: 1 - 2 * (tp.y + o.dy) };
      let ux = -(tp.x - w.x) * va;
      let uy = -(tp.y - w.y);
      const n = Math.hypot(ux, uy); ux /= n; uy /= n;
      const end = { x: tipN.x + (ux * ptr.BEAM_LEN) / va, y: tipN.y + uy * ptr.BEAM_LEN };
      worst = Math.max(worst, Math.hypot(end.x - c.x, end.y - c.y));
    }
    checkTrue('ghostOffset: shifted index tip + beam along the finger ends on the cursor (4 cursors)', worst < 1e-9, worst.toExponential(2));

    // ghostHands draws the aim hand shifted (weight eased in), the beam's start follows.
    const sc = new THREE.Scene();
    const obj = new THREE.Object3D();
    sc.add(obj);
    const cam = new THREE.PerspectiveCamera(50, va, 0.1, 100);
    cam.position.set(0, 0, 3);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const gh = ghostMod.createGhostHands(sc, []);
    const cursor = { x: 0.6, y: -0.5 };
    const o = ptr.ghostOffset(g, cursor, va);
    const want = { x: 1 - 2 * (g.landmarks[8].x + o.dx), y: 1 - 2 * (g.landmarks[8].y + o.dy) };
    let nowMs = 0;
    const tipNdc = () => gh.landmarkOf(g, 8).project(cam);
    gh.update([g], { camera: cam, object: obj, aspect: va, nowMs: (nowMs += 16), offsetOf: () => o });
    const first = tipNdc();
    const firstErr = Math.hypot(first.x - want.x, first.y - want.y);
    for (let i = 0; i < 60; i++) gh.update([g], { camera: cam, object: obj, aspect: va, nowMs: (nowMs += 16), offsetOf: () => o });
    const settled = tipNdc();
    const err = Math.hypot(settled.x - want.x, settled.y - want.y);
    checkTrue('ghost aim hand: shift eases in (not a teleport), then the drawn tip sits on the line-up point',
      firstErr > 0.05 && err < 1e-3, `first frame ${firstErr.toFixed(3)} NDC off, after 1 s ${err.toExponential(1)}`);
    gh.dispose();
  });

  group('Pointer — tracking reset and struggle hints (owner decision 3, 2026-10-01)', () => {
    const FR = 1000 / 30;
    const up = (x = 0.4) => { const h = hand(x, 0.6, 0, 'open'); h.engaged = true; return h; };
    const down = (x = 0.4) => { const h = hand(x, 0.97, 0, 'open'); h.engaged = false; return h; };
    // Reset gate.
    {
      const gate = ptr.createResetGate();
      let t = 0;
      const fires = [];
      const feed = (n, mk) => { for (let i = 0; i < n; i++) { if (gate.update(mk(), t)) fires.push(t); t += FR; } };
      feed(20, () => [down(0.3), down(0.7)]);
      checkTrue('hands already lowered at start (never raised): no reset', fires.length === 0, `${fires.length}`);
      feed(20, () => [up(0.3), up(0.7)]);
      const t0 = t;
      feed(60, () => [down(0.3), down(0.7)]);
      checkTrue('raise, then lower both hands: exactly one reset, after 1.0-1.1 s', fires.length === 1 && fires[0] - t0 >= 1000 && fires[0] - t0 < 1100,
        fires.map((f) => (f - t0).toFixed(0)).join());
      feed(20, () => []);
      feed(20, () => [down(0.3)]);
      checkTrue('staying lowered: no second reset', fires.length === 1, `${fires.length}`);
      const g2 = ptr.createResetGate();
      let n = 0;
      t = 0;
      const feed2 = (k, mk) => { for (let i = 0; i < k; i++) { if (g2.update(mk(), t)) n++; t += FR; } };
      feed2(5, () => [up()]);
      feed2(20, () => [down()]);       // 0.66 s lowered
      feed2(3, () => [up()]);          // raised again: hold restarts
      feed2(20, () => [down()]);       // 0.66 s
      checkTrue('a raise mid-hold restarts the 1 s count (no reset after two 0.66 s lowerings)', n === 0, `${n}`);
      feed2(6, () => []);              // 200 ms hands-lost blip...
      feed2(14, () => [down()]);       // ...doesn't break the hold: 0.66 + 0.2 + 0.46 s > 1 s
      checkTrue('a short hands-lost blip (< 300 ms) does not break the hold', n === 1, `${n}`);
    }
    // Hint monitor.
    {
      const mon = ptr.createTrackingMonitor();
      let t = 0;
      const gun = (g) => { const h = up(); h.pointer = { gun: g }; return h; };
      const aim = { mode: 'aim', source: 'hand', x: 0.2, y: 0.1 };
      let seen = new Set();
      for (let i = 0; i < 90; i++) { const h = mon.update([gun(true)], aim, t); if (h) seen.add(h.key); t += FR; }
      checkTrue('steady pointing for 3 s: no hint at all', seen.size === 0, [...seen].join());
      seen = new Set();
      for (let i = 0; i < 40; i++) { const h = mon.update([gun(Math.floor(i / 4) % 2 === 0)], aim, t); if (h) seen.add(h.key); t += FR; }
      checkTrue('pose flickering on/off every 130 ms: "flicker" hint', seen.has('flicker'), [...seen].join() || 'none');
      let last = null;
      for (let i = 0; i < 150; i++) { last = mon.update([gun(true)], aim, t); t += FR; }
      checkTrue('after recovering, the hint clears within HINT_HOLD_MS (+ the 2 s flicker window)', last === null, JSON.stringify(last));
      const edge = { ...aim, x: -1 };
      const keys = [];
      for (let i = 0; i < 45; i++) { keys.push(mon.update([gun(true)], edge, t)?.key ?? null); t += FR; }
      const firstEdge = keys.indexOf('edge');
      checkTrue('cursor pinned at the edge: "edge" hint after ~1 s, not before', firstEdge >= 29 && firstEdge <= 32, `frame ${firstEdge}`);
      mon.reset();
      for (let i = 0; i < 10; i++) { mon.update([gun(true)], aim, t); t += FR; }
      const lostKeys = [];
      for (let i = 0; i < 30; i++) { lostKeys.push(mon.update([], { mode: 'clutch', source: 'hand', x: 0, y: 0 }, t)?.key ?? null); t += FR; }
      checkTrue('aiming hand vanishes: "lost" hint after ~0.5 s', lostKeys.indexOf('lost') >= 14 && lostKeys.indexOf('lost') <= 17, `frame ${lostKeys.indexOf('lost')}`);
      mon.reset();
      const restKeys = [];
      for (let i = 0; i < 5; i++) { mon.update([gun(true)], aim, t); t += FR; }
      for (let i = 0; i < 5; i++) { mon.update([down()], { mode: 'clutch', source: 'hand', x: 0, y: 0 }, t); t += FR; }
      for (let i = 0; i < 40; i++) { restKeys.push(mon.update([], { mode: 'off', source: 'hand', x: 0, y: 0 }, t)?.key ?? null); t += FR; }
      checkTrue('hands lowered then out of view (resting): no "lost" hint', restKeys.every((k) => k === null), restKeys.filter(Boolean).join());
    }
    // pointer.reset() recentres; engagement.setLine moves the engage line.
    {
      const p = ptr.createPointer();
      p.mouseMove(0.7, -0.4, 0);
      p.reset();
      const st = p.state;
      const eng = ptr.createEngagement();
      eng.setLine(0.7);
      const h = hand(0.5, 0.75, 0, 'open');
      eng.update([h]);
      checkTrue('reset recentres the cursor and turns it off; setLine(0.7) makes wrist y 0.75 "lowered"',
        st.x === 0 && st.y === 0 && st.mode === 'off' && h.engaged === false && eng.line.exitY > 0.7, `${st.x},${st.y},${st.mode},${h.engaged}`);
    }
  });

  const cal = await import(`./calibrate.js${V}`);
  group('Pointer calibration — helpers and a full synthetic run (calibrate.js, owner decision 2)', () => {
    const memStore = () => ({ data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = String(v); } });
    // Storage: round-trip, corrupt JSON, blocked storage.
    {
      const st = memStore();
      const okSave = cal.saveProfile({ v: 1, reach: { x0: 0.3, x1: 0.7, y0: 0.2, y1: 0.6 } }, st);
      const back = cal.loadProfile(st);
      st.data[cal.PROFILE_KEY] = '{not json';
      const bad = cal.loadProfile(st);
      const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
      checkTrue('profile save/load round-trips; corrupt JSON and blocked storage give null/false without throwing',
        okSave && back?.reach?.x1 === 0.7 && bad === null && cal.loadProfile(throwing) === null && cal.saveProfile({ v: 1 }, throwing) === false,
        `${okSave} ${back?.reach?.x1} ${bad}`);
    }
    // Reach box from palms: percentiles, too-few and too-small guards.
    {
      const palms = [];
      for (let i = 0; i < 200; i++) palms.push({ x: 0.3 + 0.4 * (i / 199), y: 0.25 + 0.4 * ((i * 7) % 200) / 199 });
      const r = cal.reachFromPalms(palms, palms.map((p) => p.y + 0.12));
      checkTrue('reach box = 5th-95th percentile of the traced palm (x 0.32-0.68), engage line just below the lowest wrist',
        Math.abs(r.reach.x0 - 0.32) < 0.005 && Math.abs(r.reach.x1 - 0.68) < 0.005 && r.engageY > 0.75 && r.engageY <= 0.92,
        JSON.stringify(r.reach) + ' engageY ' + r.engageY);
      const few = cal.reachFromPalms(palms.slice(0, 20));
      const tiny = cal.reachFromPalms(palms.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.1, y: p.y })));
      checkTrue('too few samples or a tiny trace: reach not changed, with a warning', few.reach === null && tiny.reach === null && few.warnings.length && tiny.warnings.length, few.warnings[0]);
    }
    // ISO ring and the throughput formula.
    {
      const tg = cal.makeTargets(1600, 900);
      const R = 0.32 * 900;
      let dmin = Infinity;
      for (let i = 1; i < tg.length; i++) dmin = Math.min(dmin, Math.hypot(tg[i].x - tg[i - 1].x, tg[i].y - tg[i - 1].y));
      checkTrue('8 targets on a ring, each move at least 0.75 of a diameter, two sizes alternating',
        tg.length === 8 && dmin > 1.5 * R && tg[0].r !== tg[1].r && tg[0].r === tg[2].r, `min move ${dmin.toFixed(0)} px, R ${R.toFixed(0)}`);
      // Hand-computed case: 4 moves of 400 px, along-axis errors +-5 px (sd 5.77, We 23.9),
      // 1 s each: TP = log2(400 / 23.86 + 1) = 4.15 bits/s.
      const trials = [5, -5, 5, -5].map((e, i) => ({ target: { x: 400, y: 0, r: 20 }, from: { x: 0, y: 0 }, click: { x: 400 + e, y: 0 }, ms: 1000, entries: i === 0 ? 2 : 1 }));
      const sc = cal.scoreTrials(trials);
      check('effective throughput (ISO 9241-9) on a hand-computed case', sc.throughput, 4.15, 0.02);
      checkTrue('score: 4/4 hits, median error 5 px, one overshoot', sc.hits === 4 && sc.errMedianPx === 5 && sc.overshoots === 1, JSON.stringify(sc));
    }
    // A whole calibration, driven with synthetic hands and direct clicks.
    {
      const p = ptr.createPointer();
      const eng = ptr.createEngagement();
      const st = memStore();
      let done = null;
      const view = { left: 0, top: 0, width: 1600, height: 900 };
      const c = cal.createCalibration({ pointer: p, engagement: eng, rect: () => view, storage: st, onDone: (x) => (done = x) });
      let t = 1000;
      const FR = 1000 / 30;
      c.start(t);
      const steps = [c.step];
      for (let i = 0; i < 100; i++) { const h = frame('open', 'palm', 'None', { cx: 0.5, cy: 0.5 }); c.onFrame([h], (t += FR)); }
      steps.push(c.step);
      // Trace a rectangle x 0.30-0.70, y 0.30-0.62 (palm centre offsets from cx/cy are small).
      const path = (u) => {
        const per = [0.4, 0.32, 0.4, 0.32];
        let d = (u % 1) * 1.44;
        const pts = [[0.3, 0.3], [0.7, 0.3], [0.7, 0.62], [0.3, 0.62]];
        for (let k = 0; k < 4; k++) {
          if (d <= per[k]) { const a = pts[k]; const b = pts[(k + 1) % 4]; const f = d / per[k]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; }
          d -= per[k];
        }
        return pts[0];
      };
      const palm0 = ptr.palmCentroid(frame('pointer', 'side', 'None', { cx: 0.5, cy: 0.5, jitter: 0 }).landmarks);
      for (let i = 0; i < 190; i++) {
        const [cx, cy] = path(i / 95);
        const h = frame('pointer', 'side', 'None', { cx: cx - (palm0.x - 0.5), cy: cy - (palm0.y - 0.5) });
        h.pointer = { gun: true };
        c.onFrame([h], (t += FR));
      }
      steps.push(c.step);
      const reach = p.profile.reach;
      checkTrue('steps run hand -> reach -> targets; reach box applied to the pointer (traced 0.30-0.70 x 0.30-0.62)',
        steps.join() === 'hand,reach,targets' && Math.abs(reach.x0 - 0.3) < 0.04 && Math.abs(reach.x1 - 0.7) < 0.04 && Math.abs(reach.y0 - 0.3) < 0.04 && Math.abs(reach.y1 - 0.62) < 0.04,
        steps.join() + ' ' + JSON.stringify(reach));
      // Targets: round 1 lands tight (±3 px), round 2 sloppy (±18 px) -> round 1's preset wins.
      const tg = cal.makeTargets(view.width, view.height);
      const smoothSeen = [];
      for (let round = 0; round < 2; round++) {
        for (let k = 0; k < 8; k++) {
          for (let i = 0; i < 24; i++) { c.onFrame([], (t += FR)); c.tick(t); }
          if (k === 0) smoothSeen.push(p.profile.smoothing.minCutoff);
          const e = (round === 0 ? 3 : 18) * (k % 2 ? 1 : -1);
          const px = { x: tg[k].x + e, y: tg[k].y };
          c.onClick({ type: 'click', source: 'hand', t, x: (px.x / view.width) * 2 - 1, y: 1 - (px.y / view.height) * 2 });
        }
      }
      const saved = cal.loadProfile(st);
      checkTrue('two rounds use the two smoothing presets', smoothSeen[0] === ptr.SMOOTHING.responsive.minCutoff && smoothSeen[1] === ptr.SMOOTHING.steady.minCutoff, smoothSeen.join());
      checkTrue('finished: profile saved (v1), better round kept (responsive), 16 clicks scored, cursor uses it',
        done && saved && saved.v === 1 && !saved.skipped && saved.smoothing.name === 'responsive' && saved.score.n === 8 &&
        saved.score.perSetting.steady.n === 8 && saved.score.errMedianPx === 3 && !c.active && p.profile.smoothing.minCutoff === ptr.SMOOTHING.responsive.minCutoff,
        saved ? cal.scoreLine(saved) : 'not saved');
      checkTrue('profile records palm length, fps (~30) and tracking rate', saved?.palmPx > 10 && Math.abs(saved.fps - 30) <= 1 && saved.trackRate === 1, `palm ${saved?.palmPx} px, ${saved?.fps} fps, rate ${saved?.trackRate}`);
      // End to end: the palm at the traced box's top-left corner puts the cursor top-right (mirrored).
      const corner = ptr.mapReach({ x: reach.x0, y: reach.y0 }, p.profile.reach);
      checkTrue('after calibration the reach-box corner maps to the canvas corner', corner.x === 1 && corner.y === 1, `${corner.x},${corner.y}`);
      c.dispose();
    }
    // Skip: saves a skipped profile, keeps the default reach.
    {
      const p = ptr.createPointer();
      const st = memStore();
      let cancelled = null;
      const c = cal.createCalibration({ pointer: p, engagement: ptr.createEngagement(), rect: () => ({ left: 0, top: 0, width: 800, height: 600 }), storage: st, onCancel: (x) => (cancelled = x) });
      // Hidden card must not take the mouse (owner report: an invisible card at the top centre
      // blocked clicks/drags). Probe the hit test at the card's centre before, during and after.
      const cards = document.querySelectorAll('[data-role="calibration-card"]');
      const cardEl = cards[cards.length - 1];
      const hits = () => { const r = cardEl.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + 6); return !!el && cardEl.contains(el); };
      const pe = [];
      pe.push(getComputedStyle(cardEl).pointerEvents + ':' + hits());
      c.start(0);
      pe.push(getComputedStyle(cardEl).pointerEvents);
      c.cancel();
      pe.push(getComputedStyle(cardEl).pointerEvents + ':' + hits());
      checkTrue('calibration card takes no clicks while hidden (before start and after skip), clicks while shown',
        pe.join() === 'none:false,auto,none:false', pe.join());
      const saved = cal.loadProfile(st);
      checkTrue('skip (Esc): skipped profile saved, default reach kept, calibration closed', cancelled && saved?.skipped === true && saved.reach.x0 === ptr.DEFAULT_REACH.x0 && !c.active, cal.scoreLine(saved));
      c.dispose();
    }
  });

  // ---- One-hand selection (owner decisions 2026-10-01 (3)): bubble targeting, hold-to-select,
  // same-hand pinch. Synthetic parts and hands; the thresholds still need a live session.
  const holdMod = await import(`./holdGate.js${V}`);
  // Four exploded parts: A in front, C straight behind it (hidden from the camera), B, D.
  const selRig = () => {
    const g = new THREE.Group();
    const mk = (name, x, y, z) => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12));
      p.name = name;
      p.position.set(x, y, z);
      g.add(p);
      return p;
    };
    // A and C sit on the camera's line of sight, and explode pushes them along it (the
    // centroid is at x 0), so C stays hidden behind A; B and D are left and right.
    const A = mk('A', 0, 0.2, 0.4);
    const B = mk('B', -0.6, 0.2, 0);
    const C = mk('C', 0, 0.2, -0.4);
    mk('D', 0.6, 0.2, 0);
    const m = createManipulator(g, camera);
    m.setExplode(0.6);
    g.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const ndcOf = (p) => { const v = p.getWorldPosition(new THREE.Vector3()).project(camera); return { x: v.x, y: v.y }; };
    return { g, m, A, B, C, ndcOf };
  };
  const VP = { width: 1600, height: 900 };
  const pxToNdc = (x, y) => ({ x: (x / VP.width) * 2 - 1, y: 1 - (y / VP.height) * 2 });
  const ndcToPx = (n) => ({ x: ((n.x + 1) / 2) * VP.width, y: ((1 - n.y) / 2) * VP.height });

  group('One-hand selection — bubble targeting (manipulator.partsNear, pointer.createSelector)', () => {
    const { m, A, B, C, ndcOf } = selRig();
    checkTrue('exploded past half-way: parts are selectable', m.partsSelectable && Math.abs(m.explodeAmount - 0.6) < 1e-9, `explode ${m.explodeAmount}`);
    const onA = m.partsNear(ndcOf(A), 80, { viewport: VP });
    checkTrue('cursor on A: A is a ray hit, ranked first', onA[0]?.part === A && onA[0].hit && onA[0].rankPx === 0, onA.map((c) => `${c.part.name}${c.hit ? '*' : ''}`).join(' '));
    checkTrue('cursor on A: C (hidden behind A) is the next hit, depth-sorted', onA[1]?.part === C && onA[1].hit && onA[1].depth > onA[0].depth, onA.map((c) => `${c.part.name}@${c.depth.toFixed(2)}`).join(' '));
    // 40 px left of B's screen box: a miss that the bubble still catches.
    const pB = ndcToPx(ndcOf(B));
    let edge = pB.x;
    while (m.partsNear(pxToNdc(edge - 1, pB.y), 0, { viewport: VP }).some((c) => c.part === B)) edge--;
    const near = m.partsNear(pxToNdc(edge - 40, pB.y), 80, { viewport: VP });
    checkTrue('40 px off B\'s box: B is the bubble target (no ray hit)', near[0]?.part === B && !near[0].hit, near.map((c) => `${c.part.name} ${c.distPx.toFixed(1)}px`).join(', '));
    check('...its box distance is 40 px', near[0]?.distPx ?? -1, 40, 0.05);
    const far = m.partsNear(pxToNdc(edge - 120, pB.y), 80, { viewport: VP });
    checkTrue('120 px off every box: no candidates', far.length === 0, `${far.length} candidates`);
    m.setExplode(0.3);
    checkTrue('below half-way explode: partsNear is empty (nothing is selectable)', m.partsNear(ndcOf(A), 80, { viewport: VP }).length === 0 && !m.partsSelectable);
    m.setExplode(0.6);
    const viaPart = m.selectPartAtScreenPoint(0.99, 0.99, { part: B });
    checkTrue('selectPartAtScreenPoint(x, y, { part }) selects the targeted part where a raycast misses', viaPart === B && m.activePart === B);
    checkTrue('...and a plain miss still deselects, as before', m.selectPartAtScreenPoint(0.99, 0.99) === null && m.activePart === null);

    // Hysteresis on synthetic candidates: the current target is kept until another is 15% closer.
    const sel = ptr.createSelector();
    const c = (id, rankPx, hit = false) => ({ id, hit, distPx: rankPx, rankPx });
    const at = { x: 100, y: 100 };
    let t = 0;
    const tgt = (cands) => sel.update({ candidates: cands, cursorPx: at, t: (t += 16), canHold: false }).target?.id ?? null;
    const seq = [
      tgt([c('A', 30), c('B', 40)]),
      tgt([c('B', 27), c('A', 30)]),   // B 10% closer: keep A
      tgt([c('B', 25), c('A', 30)]),   // B 17% closer: switch
      tgt([c('A', 26), c('B', 25)]),   // A 4% closer than B... B is current, keep B
      tgt([c('C', 0, true), c('B', 5)]), // a ray hit always wins
      tgt([c('B', 90)])                 // outside 80 px: nothing
    ];
    checkTrue('bubble hysteresis: keep A at 10% closer, switch at 17%, hit wins, nothing past 80 px', seq.join() === 'A,A,B,B,C,', seq.join());
    const hits = [{ part: A, hit: true }, { part: C, hit: true }];
    checkTrue('nextInStack: after A comes C, after C wraps to A, unknown starts at the front',
      ptr.nextInStack(hits, A).part === C && ptr.nextInStack(hits, C).part === A && ptr.nextInStack(hits, B).part === A);
  });

  group('One-hand selection — hold still to select (createSelector over holdGate)', () => {
    const FR = 1000 / 60;
    const tgtA = [{ id: 'A', hit: true, distPx: 0, rankPx: 0 }];
    // Runs `ms` of frames; pos(t) gives the cursor; returns fire times and the progress trace.
    const run = (sel, ms, pos, { cands = () => tgtA, canHold = true, t0 = 0 } = {}) => {
      const fires = [];
      const vis = [];
      for (let t = t0; t <= t0 + ms; t += FR) {
        const s = sel.update({ candidates: cands(t), cursorPx: pos(t), t, canHold });
        vis.push(s.visibleProgress);
        if (s.fired) fires.push(t - t0);
      }
      return { fires, vis };
    };
    const jitter = (amp) => () => ({ x: 400 + (rnd() - 0.5) * 2 * amp, y: 300 + (rnd() - 0.5) * 2 * amp });
    {
      const r = run(ptr.createSelector(), 3000, jitter(0));
      checkTrue('steady on a target: fires once, ~650 ms', r.fires.length === 1 && Math.abs(r.fires[0] - 650) <= FR + 1, r.fires.map((f) => f.toFixed(0)).join(', '));
      const firstVis = r.vis.findIndex((v) => v > 0) * FR;
      checkTrue('ring invisible for the first 200 ms of the hold', firstVis >= 200 - FR && firstVis <= 200 + 2 * FR, `first drawn at ${firstVis.toFixed(0)} ms`);
      let rises = true;
      const upTo = Math.round(r.fires[0] / FR);
      for (let i = 1; i < upTo; i++) if (r.vis[i] < r.vis[i - 1] - 1e-9) rises = false;
      checkTrue('ring only grows while charging (calm: no flicker)', rises);
    }
    {
      const r = run(ptr.createSelector(), 3000, jitter(3));
      checkTrue('±3 px hand tremor: still fires once', r.fires.length === 1, r.fires.map((f) => f.toFixed(0)).join(', '));
    }
    {
      // Sweeping 20 px per 200 ms (> 12 px steady radius): never charges.
      const r = run(ptr.createSelector(), 2000, (t) => ({ x: 400 + 0.1 * t, y: 300 }));
      checkTrue('cursor moving 20 px / 200 ms: never fires in 2 s', r.fires.length === 0, `${r.fires.length} fires`);
      // 300 ms of motion in the middle pauses the ring; it resumes rather than restarting.
      const r2 = run(ptr.createSelector(), 2000, (t) => ({ x: 400 + (t > 300 && t < 600 ? (t - 300) * 0.15 : t >= 600 ? 45 : 0), y: 300 }));
      checkTrue('a 300 ms move mid-hold pauses the ring (fires at ~650 ms of stillness + the pause)',
        r2.fires.length === 1 && r2.fires[0] > 850 && r2.fires[0] < 1250, r2.fires.map((f) => f.toFixed(0)).join(', '));
    }
    {
      // After firing: resting there never re-fires; moving 30 px away and back re-arms it.
      const sel = ptr.createSelector();
      const r = run(sel, 2500, (t) => ({ x: 400 + (t > 1200 && t < 1400 ? 30 : 0), y: 300 }));
      checkTrue('hold again: rest = 1 fire; move 30 px off and back = a second fire', r.fires.length === 2 && r.fires[1] > 1400 + 600,
        r.fires.map((f) => f.toFixed(0)).join(', '));
    }
    {
      const sel = ptr.createSelector();
      sel.update({ candidates: tgtA, cursorPx: { x: 400, y: 300 }, t: 0 });
      sel.block({ x: 400, y: 300 });
      const r = run(sel, 1500, jitter(2), { t0: 16 });
      checkTrue('after a pinch click on the target, resting on it does not also fire by hold', r.fires.length === 0, `${r.fires.length} fires`);
    }
    {
      const r = run(ptr.createSelector(), 2000, jitter(0), { canHold: false });
      checkTrue('mouse (canHold false): never fires', r.fires.length === 0);
      // Target switch at 400 ms restarts the ring for the new target.
      const r2 = run(ptr.createSelector(), 2000, jitter(0), { cands: (t) => [{ id: t < 400 ? 'A' : 'B', hit: true, distPx: 0, rankPx: 0 }] });
      checkTrue('a new target restarts the ring (fires ~650 ms after the switch)', r2.fires.length === 1 && Math.abs(r2.fires[0] - 1050) <= 2 * FR, r2.fires.map((f) => f.toFixed(0)).join(', '));
    }
    {
      // holdGate's new option keeps its default (ASL behaviour unchanged for other callers).
      checkTrue('holdGate: releaseOnUnsteady defaults to true', holdMod.HOLD_GATE.releaseOnUnsteady === true);
    }
  });

  group('One-hand selection — same-hand quick pinch (pointer.js)', () => {
    const FR = 1000 / 50;
    let now = 90000;
    const rig = (o) => ({ eng: ptr.createEngagement(), p: ptr.createPointer(o) });
    const step = (r, hands) => {
      hands.forEach((h) => gestures.annotateHand(h, ASPECT));
      r.eng.update(hands);
      const click = r.p.update(hands, ASPECT, now);
      const out = { t: now, click, st: r.p.state, gun: hands[0]?.pointer?.gun, ratio: hands[0]?.pinch?.ratio };
      now += FR;
      return out;
    };
    const gun = (cx, o = {}) => frame('pointer', 'side', 'None', { cx, cy: 0.55, jitter: 0, ...o });
    // Aim, drift right, pinch (thumb onto the index tip) while the palm keeps drifting, open.
    const script = (r, pinchPose = 'pointer') => {
      const rows = [];
      for (let i = 0; i < 30; i++) rows.push(step(r, [gun(0.5)]));
      for (let i = 1; i <= 10; i++) rows.push(step(r, [gun(0.5 + 0.003 * i)]));
      for (let i = 1; i <= 10; i++) rows.push(step(r, [frame(pinchPose, 'side', 'None', { cx: 0.53 + 0.003 * i, cy: 0.55, jitter: 0, thumbTo: 8 })]));
      for (let i = 0; i < 20; i++) rows.push(step(r, [gun(0.56)]));
      return rows;
    };
    {
      const rows = script(rig());
      const clicks = rows.filter((x) => x.click);
      const c = clicks[0]?.click;
      checkTrue('aiming hand pinches: exactly one click, via "pinch"', clicks.length === 1 && c.via === 'pinch' && c.source === 'hand',
        `${clicks.length} clicks · via ${c?.via} · pinch ratio ${rows[40].ratio?.toFixed(2)} · gun while pinched ${rows[40].gun}`);
      // Rewind: the click lands where the cursor was REWIND_MS before the onset.
      const before = rows.filter((x) => x.t <= c.t - ptr.REWIND_MS).at(-1);
      checkTrue('click lands at the cursor 120 ms before the pinch (rewind)', Math.abs(c.x - before.st.x) < 1e-9,
        `click x ${c.x.toFixed(4)} vs ${before.st.x.toFixed(4)} at -120 ms; cursor at onset ${rows[39].st.x.toFixed(4)}`);
      const pinched = rows.slice(41, 50);
      checkTrue('cursor frozen while the pinch is held (palm drifts 0.027)', pinched.every((x) => x.st.x === c.x && x.st.frozen && x.st.mode === 'aim'),
        pinched.map((x) => x.st.x.toFixed(3)).join(' '));
      const last = rows.at(-1).st;
      checkTrue('pinch opened: cursor follows the hand again', !last.frozen && Math.abs(last.x - c.x) > 0.05, `x ${last.x.toFixed(3)}`);
    }
    {
      // Pose drops while pinching (index curls with the other three): the hand is still the
      // aiming hand (matched by palm), so the pinch still clicks and the cursor stays.
      const rows = script(rig(), 'fist');
      const clicks = rows.filter((x) => x.click);
      checkTrue('pose drops during the pinch: still one "pinch" click, cursor held (no clutch)',
        clicks.length === 1 && clicks[0].click.via === 'pinch' && rows.slice(41, 50).every((x) => x.st.mode === 'aim'),
        `${clicks.length} clicks · gun while pinched ${rows[42].gun} · modes ${[...new Set(rows.slice(41, 50).map((x) => x.st.mode))].join('/')}`);
    }
    {
      const rows = script(rig({ sameHandPinch: false }));
      checkTrue('sameHandPinch: false -> no same-hand click (old behaviour)', rows.every((x) => !x.click));
    }
    {
      const r = rig();
      let n = 0;
      for (let i = 0; i < 150; i++) if (step(r, [frame('pointer', 'side', 'None', { cx: 0.5, cy: 0.55 })]).click) n++;
      checkTrue('still pointer, realistic jitter, 3 s: no false clicks', n === 0, `${n} clicks`);
    }
    {
      const r = rig();
      const other = (p) => frame('open', 'palm', 'None', { cx: 0.25, cy: 0.55, jitter: 0, thumbTo: p ? 1 : null });
      const rows = [];
      for (let i = 0; i < 20; i++) rows.push(step(r, [gun(0.6), other(false)]));
      for (let i = 0; i < 5; i++) rows.push(step(r, [gun(0.6), other(true)]));
      const clicks = rows.filter((x) => x.click);
      checkTrue('other hand\'s pinch still clicks, via "other-pinch"', clicks.length === 1 && clicks[0].click.via === 'other-pinch', clicks.map((x) => x.click.via).join());
    }
  });

  group('Exploded parts — spread to fit, hover outline (manipulator, reticle.js)', () => {
    // Two overlapping parts side by side: explode pulls them apart along x.
    const g = new THREE.Group();
    const P = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12));
    const Q = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12));
    P.position.set(-0.03, 0, 0.02);
    Q.position.set(0.03, 0, -0.02);
    g.add(P, Q);
    const m = createManipulator(g, camera);
    camera.updateMatrixWorld(true);
    const a = m.spreadToFit({ viewport: VP });
    const visiblePx = (part) => {
      g.updateMatrixWorld(true);
      const rc = new THREE.Raycaster();
      let n = 0;
      for (let y = 0; y < VP.height; y += 4) for (let x = 0; x < VP.width; x += 4) {
        const nd = pxToNdc(x, y);
        rc.setFromCamera(nd, camera);
        if (rc.intersectObjects([P, Q], false)[0]?.object === part) n++;
      }
      return n * 16;
    };
    const vp = visiblePx(P);
    const vq = visiblePx(Q);
    checkTrue('spread to fit: each part shows >= 44 x 44 px of itself', a > 0.5 && a < 1 && vp >= 44 * 44 && vq >= 44 * 44,
      `explode ${a?.toFixed(2)} · visible ${vp} / ${vq} px² (need 1936)`);
    m.setExplode(a - 0.05);
    const tight = Math.min(visiblePx(P), visiblePx(Q));
    m.setExplode(a);
    checkTrue('...and it is the smallest such amount (one step less is too tight, or the threshold)', a - 0.05 <= 0.5 + 1e-9 || tight < 44 * 44, `one step less: ${tight} px²`);
    const one = new THREE.Group();
    one.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1)));
    checkTrue('spread to fit on a single-mesh (stretch) object: null', createManipulator(one, camera).spreadToFit({ viewport: VP }) === null);

    const scene = new THREE.Scene();
    const hl = ret.createPartHighlight(scene);
    let t = 0;
    const trace = [];
    for (let i = 0; i < 40; i++) trace.push({ shown: hl.update({ part: P, nowMs: (t += 16) }), o: hl.opacity });
    for (let i = 0; i < 80; i++) trace.push({ shown: hl.update({ part: Q, nowMs: (t += 16) }), o: hl.opacity });
    let maxStep = 0;
    for (let i = 1; i < trace.length; i++) maxStep = Math.max(maxStep, Math.abs(trace[i].o - trace[i - 1].o));
    const swapAt = trace.findIndex((x) => x.shown === Q);
    checkTrue('outline fades in on the hovered part', trace[39].shown === P && trace[39].o > 0.6, `opacity ${trace[39].o.toFixed(2)}`);
    checkTrue('hover change: the old outline fades out before the new one appears', swapAt > 40 && trace[swapAt - 1].o < 0.02 && trace.at(-1).o > 0.6,
      `swap after ${(swapAt - 40) * 16} ms · final ${trace.at(-1).o.toFixed(2)}`);
    checkTrue('outline never jumps (largest per-frame opacity change < 0.1)', maxStep < 0.1, maxStep.toFixed(3));
    Q.userData.inferred = true;
    checkTrue('part label: name, or "part N"; inferred flag for the amber chip', ret.partLabel(P).name === 'part 1' && ret.partLabel(Q).inferred === true, JSON.stringify(ret.partLabel(Q)));
    hl.dispose();
  });

  group('Selection practice — A/B rounds, cluster, scoring (calibrate.js)', () => {
    const W = 800, H = 600;
    const fakeState = { mode: 'aim', source: 'hand', x: 0, y: 0, frozen: false };
    const fake = { get state() { return fakeState; } };
    const aimPx = (x, y) => { fakeState.x = (x / W) * 2 - 1; fakeState.y = 1 - (y / H) * 2; };
    const toNdc = (x, y) => ({ x: (x / W) * 2 - 1, y: 1 - (y / H) * 2 });
    const hadHologram = 'hologram' in globalThis;
    const saved = globalThis.hologram;
    globalThis.hologram = {};
    let done = null;
    const pr = cal.createSelectionPractice({
      pointer: fake, rect: () => ({ left: 0, top: 0, width: W, height: H }), parent: document.createElement('div'),
      rounds: [{ commit: 'hold', targeting: 'point' }, { commit: 'hold', targeting: 'bubble' }, { commit: 'pinch', targeting: 'point' }],
      onDone: (r) => (done = r)
    });
    let t = 0;
    pr.start(t);
    // Rounds 1-2: the cursor rests 25 px beside each lit target (outside its 18 px ring).
    let guard = 0;
    while (pr.active && pr.round.index < 2 && guard++ < 20000) {
      const tg = pr.targets[pr.cue];
      aimPx(tg.x + 25, tg.y);
      pr.onFrame((t += 16));
    }
    const cueTargets = pr.targets;
    // Pinch round: one wrong click, one other-hand click (ignored), then the right one each time.
    let k = 0;
    while (pr.active && k < 6) {
      const tg = cueTargets[k];
      const wrong = cueTargets[(k + 3) % 6];
      pr.onClick({ x: toNdc(wrong.x, wrong.y).x, y: toNdc(wrong.x, wrong.y).y, t: (t += 300), via: k === 0 ? 'pinch' : 'other-pinch' });
      pr.onClick({ x: toNdc(tg.x + 5, tg.y).x, y: toNdc(tg.x + 5, tg.y).y, t: (t += 300), via: 'pinch' });
      k++;
    }
    const [pt, bub, pin] = done?.rounds ?? [];
    checkTrue('hold + point, cursor 25 px beside each target: 6 misses (timeouts), 0 false selects', pt?.misses === 6 && pt.falseSelects === 0, JSON.stringify(pt));
    checkTrue('hold + bubble, same cursor: 6/6 selected, ~650 ms, error 25 px', bub?.hits === 6 && Math.abs(bub.errMedianPx - 25) < 1 && bub.timeMedianMs >= 650 && bub.timeMedianMs < 700, JSON.stringify(bub));
    checkTrue('pinch round: 6/6, the wrong-target click counted as 1 false select, other-hand clicks ignored (offMode 5)',
      pin?.hits === 6 && pin.falseSelects === 1 && pin.offMode === 5 && pin.errMedianPx === 5, JSON.stringify(pin));
    checkTrue('results exposed on window.hologram.selectionPractice (sessionrec)', globalThis.hologram.selectionPractice === done && done.rounds.length === 3);
    if (hadHologram) globalThis.hologram = saved; else delete globalThis.hologram;
    // Cluster: centres 30-60 px apart.
    const cl = cal.makeClusterTargets(W, H, 6, rnd);
    let minD = Infinity, maxNN = 0;
    for (const a of cl) {
      let nn = Infinity;
      for (const b of cl) if (a !== b) { const d = Math.hypot(a.x - b.x, a.y - b.y); minD = Math.min(minD, d); nn = Math.min(nn, d); }
      maxNN = Math.max(maxNN, nn);
    }
    checkTrue('cluster round: 6 targets, every pair >= 30 px, each within 60 px of a neighbour', cl.length === 6 && minD >= 30 && maxNN <= 60, `min ${minD.toFixed(1)} · max nearest ${maxNN.toFixed(1)}`);
    checkTrue('default practice: 3 commits x (point, bubble) + 1 cluster round', cal.PRACTICE_ROUNDS.length === 7 && cal.PRACTICE_ROUNDS.filter((r) => r.cluster).length === 1);
  });

  group('Gesture fixes round G (owner-approved 2026-10-01: sticky pointer, clap, tilt, scale, aim→grab, outline, practice, thumb-tap)', () => {
    const FR = 1000 / 30;
    // Pointer hands: the same side-on pointer landmarks, with the pose verdict, label and pinch set.
    const ph = (gun, { gesture = 'None', cx = 0.5, ratio = 1, world = null } = {}) => {
      const h = frame('pointer', 'side', gesture, { cx, cy: 0.5, jitter: 0 });
      if (world) h.worldLandmarks = world;
      h.pointer = { gun };
      h.pinch = { ratio, pinching: ratio < 0.25 };
      h.engaged = true;
      return h;
    };
    // 1. Sticky pointer.
    {
      const p = ptr.createPointer({ thumbTap: false });
      let t = 0;
      for (let i = 0; i < 20; i++) p.update([ph(true)], 1.78, (t += FR));
      const modes = [];
      for (let i = 0; i < 8; i++) { p.update([ph(false)], 1.78, (t += FR)); modes.push(p.state.mode); }  // 267 ms of wobble
      checkTrue('#G1 sticky pointer: 267 ms of pose wobble (label None) stays "aim", cursor held', modes.every((m) => m === 'aim'), modes.join(','));
      const x0 = p.state.x;
      p.update([ph(true, { cx: 0.42 })], 1.78, (t += FR));
      const raw = p.state.raw.x;
      checkTrue('#G1 re-entry within 400 ms keeps the filter: the cursor glides (no snap to the new hand spot)',
        Math.abs(p.state.x - raw) > 0.02 && Math.abs(p.state.x - x0) > 0.001, `x ${p.state.x.toFixed(3)} raw ${raw.toFixed(3)} was ${x0.toFixed(3)}`);
      for (let i = 0; i < 10; i++) p.update([ph(true)], 1.78, (t += FR));
      p.update([ph(false, { gesture: 'Open_Palm' })], 1.78, (t += FR));
      const palmMode = p.state.mode;
      for (let i = 0; i < 10; i++) p.update([ph(true)], 1.78, (t += FR));
      const ends = [];
      for (let i = 0; i < 14; i++) { p.update([], 1.78, (t += FR)); ends.push(p.state.mode); }
      const firstClutch = ends.indexOf('clutch');
      checkTrue('#G1 a clear Open_Palm ends aiming at once; a lost pose ends it at 350 ms, not before',
        palmMode === 'clutch' && firstClutch >= 0 && (firstClutch + 1) * FR >= ptr.STICKY_MS && firstClutch * FR < ptr.STICKY_MS + FR,
        `palm → ${palmMode}; lost → clutch after ${((firstClutch + 1) * FR).toFixed(0)} ms`);
      // The other hand's click still lands during wobble.
      const q = ptr.createPointer({ thumbTap: false });
      t = 0;
      for (let i = 0; i < 20; i++) q.update([ph(true, { cx: 0.4 }), ph(false, { cx: 0.75, ratio: 0.6 })], 1.78, (t += FR));
      let click = null;
      for (let i = 0; i < 6; i++) click = q.update([ph(false, { cx: 0.4 }), ph(false, { cx: 0.75, ratio: i >= 4 ? 0.1 : 0.6 })], 1.78, (t += FR)) ?? click;
      checkTrue('#G1 other-hand pinch 170 ms into a wobble still clicks (was lost after 100 ms)', click?.via === 'other-pinch', JSON.stringify(click));
    }
    // 2. Clap.
    {
      const fresh = (channels = ALL_CHANNELS) => {
        object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1);
        const m = createManipulator(object, camera);
        m.reset();
        m.configure({ channels, sensitivity: 1, momentum: false, triggerFrames: 3 });
        return m;
      };
      const two = (sep, cy = 0.5, kindA = 'open', kindB = 'open') => [hand(0.5 - sep / 2, cy, 0, kindA), hand(0.5 + sep / 2, cy, 0, kindB)];
      let m = fresh();
      let t = 1000;
      for (let i = 0; i < 6; i++) m.update(two(0.4), 1.78, (t += FR));
      const r0 = m.resetCount;
      for (const sep of [0.34, 0.28, 0.22, 0.16]) m.update(two(sep), 1.78, (t += FR));
      m.update([hand(0.5, 0.5, 0, 'open')], 1.78, (t += FR)); // one hand lost at contact
      check('#G2 clap E1: approach then merge (one hand drops at contact) resets', m.resetCount - r0, 1);
      // E1 must not fire when a hand leaves the frame moving apart.
      m = fresh();
      t = 1000;
      for (let i = 0; i < 6; i++) m.update(two(0.3), 1.78, (t += FR));
      const r1 = m.resetCount;
      for (const sep of [0.34, 0.4]) m.update(two(sep), 1.78, (t += FR));
      m.update([hand(0.3, 0.5, 0, 'open')], 1.78, (t += FR));
      check('#G2 clap E1: hands moving apart, then one leaves the frame: no reset', m.resetCount - r1, 0);
      // E3: a clap blocked by a pointer keeps its arm.
      m = fresh();
      t = 1000;
      const gunOpen = (x) => { const h = hand(x, 0.5, 0, 'open'); h.pointer = { gun: true }; return h; };
      for (let i = 0; i < 6; i++) m.update([gunOpen(0.3), hand(0.7, 0.5, 0, 'open')], 1.78, (t += FR));
      const r2 = m.resetCount;
      for (const sep of [0.3, 0.2, 0.1]) m.update([gunOpen(0.5 - sep / 2), hand(0.5 + sep / 2, 0.5, 0, 'open')], 1.78, (t += FR));
      const blocked = m.resetCount - r2;
      for (let i = 0; i < 20; i++) m.update(two(0.15), 1.78, (t += FR));   // span ~2.2: never re-arms (needs > 2.5)
      for (const sep of [0.1, 0.06]) m.update(two(sep), 1.78, (t += FR));
      checkTrue('#G2 clap E3: a clap blocked by a pointer does not spend the arm (the next clap fires)', blocked === 0 && m.resetCount - r2 === 1, `blocked ${blocked}, total ${m.resetCount - r2}`);
      // E2: a clap during a pulled-apart explode resets.
      m = fresh();
      t = 1000;
      for (let i = 0; i <= 20; i++) m.update(two(0.14 + i * 0.02), 1.78, (t += FR));
      const exploding = m.mode === MODE.EXPLODE;
      const r3 = m.resetCount;
      for (const sep of [0.4, 0.3, 0.2, 0.1, 0.05]) m.update(two(sep), 1.78, (t += FR));
      checkTrue('#G2 clap E2: a clap during a pulled-apart explode resets', exploding && m.resetCount - r3 === 1, `exploding ${exploding}, resets ${m.resetCount - r3}`);
    }
    // 3. Tilt: hybrid position/rate.
    {
      const tiltRun = (dy) => {
        object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1);
        const m = createManipulator(object, camera);
        m.reset();
        m.configure({ channels: ['tilt'], sensitivity: 1, momentum: false, triggerFrames: 3 });
        let t = 1000;
        const step = (y) => m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65, y, 0, 'open')], 1.78, (t += FR));
        for (let i = 0; i < 8; i++) step(0.6);
        for (let i = 1; i <= 10; i++) step(0.6 + (dy * i) / 10);
        for (let i = 0; i < 3; i++) step(0.6 + dy);
        const qa = object.quaternion.clone();
        for (let i = 0; i < 6; i++) step(0.6 + dy);
        return object.quaternion.angleTo(qa); // turned during 0.2 s of holding still
      };
      // Offsets kept small enough that the model is still short of TILT_LIMIT (#G3b): -0.24
      // is ~43° by position alone, already past the rate cap (0.08 + 0.15).
      const inZone = tiltRun(-0.06);
      const beyond = tiltRun(-0.12);
      const far = tiltRun(-0.24);
      checkTrue('#G3 tilt: still inside ±0.08 = position only (no drift); held beyond it keeps turning; speed capped',
        inZone < 0.01 && beyond > 0.04 && far <= mn.TILT_RATE_MAX * 0.2 + 0.02 && far > beyond,
        `0.2 s held: in-zone ${inZone.toFixed(3)} · 0.12 out ${beyond.toFixed(3)} · 0.24 out ${far.toFixed(3)} rad (cap ${(mn.TILT_RATE_MAX * 0.2).toFixed(2)})`);
    }
    // 3b. Tilt limit (Timmy pass 4: gesture-lab tilt read p-79/r180 + "spin 180" = a real
    // -101° pitch, the rate zone kept tilting past 90°). A long full-rate hold stays within
    // ±TILT_LIMIT of the grab start, eases in (no hard stop), never rolls or spins, and lowering
    // the hand tilts back at once. Run at 10, 30 and 60 fps.
    {
      const results = [10, 30, 60].map((fps) => {
        const fr = 1000 / fps;
        object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1);
        const m = createManipulator(object, camera);
        m.reset();
        m.configure({ channels: ['move', 'spin', 'tilt', 'push'], sensitivity: 1, momentum: false, triggerFrames: 3 });
        let t = 1000;
        const step = (y) => { m.update([hand(0.35, 0.5, 0, 'fist'), hand(0.65, y, 0, 'open')], 1.78, (t += fr)); m.tick?.(t); };
        const q0 = () => object.quaternion.angleTo(new THREE.Quaternion());
        for (let i = 0; i < fps * 0.3; i++) step(0.6);
        for (let i = 1; i <= fps * 0.3; i++) step(0.6 - (0.24 * i) / (fps * 0.3)); // hand up 0.24: past the rate cap, ~43° by position
        let maxA = 0, rateMid = 0, rateNear = 0, prev = q0();
        for (let i = 0; i < fps * 10; i++) {
          step(0.36);
          const a = q0(), r = (a - prev) * fps; prev = a;
          maxA = Math.max(maxA, a);
          if (a > 0.95 && a < 1.05) rateMid = Math.max(rateMid, r); // ~55-60°: easing has begun
          if (a > 1.22) rateNear = Math.max(rateNear, r);
        }
        const e = new THREE.Euler().setFromQuaternion(object.quaternion, 'YXZ');
        const held = q0();
        for (let i = 1; i <= fps * 0.2; i++) step(0.36 + (0.19 * i) / (fps * 0.2)); // lower the hand over 0.2 s: tilts back promptly
        return { fps, maxDeg: (maxA * 180) / Math.PI, pitchDeg: (e.x * 180) / Math.PI, rollDeg: (e.z * 180) / Math.PI, spinDeg: (e.y * 180) / Math.PI,
          rateMid, rateNear, backDeg: ((held - q0()) * 180) / Math.PI };
      });
      const lim = (mn.TILT_LIMIT * 180) / Math.PI;
      checkTrue('#G3b tilt limit: 10 s full-rate hold stays within the limit (eased), roll/spin ≈0, lowering tilts back',
        results.every((r) => r.maxDeg <= lim + 0.5 && r.maxDeg > lim - 5 && Math.abs(r.rollDeg) < 1 && Math.abs(r.spinDeg) < 1 && r.pitchDeg < 0
          && r.rateMid > 0.4 && r.rateNear < r.rateMid * 0.5 && r.backDeg > 5),
        results.map((r) => `${r.fps}fps max ${r.maxDeg.toFixed(1)}° (p${r.pitchDeg.toFixed(1)} r${r.rollDeg.toFixed(1)} s${r.spinDeg.toFixed(1)}) rate mid ${r.rateMid.toFixed(2)} near-limit ${r.rateNear.toFixed(2)} rad/s, back ${r.backDeg.toFixed(1)}°`).join(' · '));
    }
    // 4. Scale: vertical gives the same range (direction gain), still uniform.
    {
      const scaleRun = (vertical) => {
        object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1);
        const m = createManipulator(object, camera);
        m.reset();
        m.configure({ channels: ['scale'], sensitivity: 1, momentum: false, triggerFrames: 3 });
        let t = 1000;
        const at = (sep) => vertical
          ? [hand(0.5, 0.55 - sep / 2, 0, 'pinch'), hand(0.5, 0.55 + sep / 2, 0, 'pinch')]
          : [hand(0.5 - sep / 2, 0.5, 0, 'pinch'), hand(0.5 + sep / 2, 0.5, 0, 'pinch')];
        for (let i = 0; i < 8; i++) m.update(at(0.2), 1.78, (t += FR));
        for (let i = 1; i <= 20; i++) m.update(at(0.2 + (0.1 * i) / 20), 1.78, (t += FR));
        for (let i = 0; i < 40; i++) m.update(at(0.3), 1.78, (t += FR));
        return { k: Math.log(object.scale.x), uniform: Math.abs(object.scale.x - object.scale.y) < 1e-9 && Math.abs(object.scale.x - object.scale.z) < 1e-9 };
      };
      const h = scaleRun(false);
      const v = scaleRun(true);
      const ratio = v.k / h.k;
      checkTrue('#G4 scale: the same 1.5x hand spread zooms ~1.75x as far (log) stacked vertically as side by side; uniform',
        h.k > 0.1 && ratio >= 1.4 && ratio <= 2.1 && h.uniform && v.uniform, `ln scale: side ${h.k.toFixed(3)} · stacked ${v.k.toFixed(3)} · ratio ${ratio.toFixed(2)}`);
    }
    // 5 + 6. aim -> grab and the pointer-blocks-grab guard.
    {
      const run = (fistOpts, frames = 20) => {
        object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1);
        const m = createManipulator(object, camera);
        m.reset();
        m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
        let t = 1000;
        const gun = () => { const h = hand(0.5, 0.5, 0, 'open'); h.gesture = 'None'; h.pointer = { gun: true }; h.pinch = { pinching: false, ratio: 0.6 }; return h; };
        for (let i = 0; i < 10; i++) m.update([gun()], 1.78, (t += FR));
        const t0 = t;
        for (let i = 0; i < frames; i++) {
          const f = hand(0.5, 0.5, 0, 'fist');
          f.score = fistOpts.score; f.pinch = { pinching: fistOpts.ratio < 0.25, ratio: fistOpts.ratio }; f.pointer = { gun: false };
          if (m.update([f], 1.78, (t += FR)) === MODE.GRAB) return t - t0;
        }
        return Infinity;
      };
      const sure = run({ score: 0.9, ratio: 0.6 });
      const unsure = run({ score: 0.6, ratio: 0.6 });
      const pinched = run({ score: 0.95, ratio: 0.1 });
      checkTrue('#G5 aim → grab ≤ 250 ms for a sure Closed_Fist (≥ 0.8, thumb off the index); unsure fist still waits the 300 ms gap; #47 pinch never grabs',
        sure <= 250 && unsure > 300 && pinched === Infinity, `sure ${sure.toFixed(0)} ms · unsure ${unsure.toFixed(0)} ms · pinched ${pinched}`);
      object.position.set(0, 0, 0); object.quaternion.identity(); object.scale.set(1, 1, 1);
      const m = createManipulator(object, camera);
      m.reset();
      m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
      let t = 1000;
      const seen = new Set();
      for (let i = 0; i < 30; i++) {
        const a = hand(0.3, 0.5, 0, 'open'); a.pointer = { gun: true };
        const b = hand(0.7, 0.5, 0, 'fist'); b.handedness = 'Left'; b.score = 0.9; b.pinch = { pinching: true, ratio: 0.1 };
        seen.add(m.update([a, b], 1.78, (t += FR)));
      }
      checkTrue('#G6 pointer up + other hand click-pinch read as Closed_Fist: never grabs (Platform POINTER_GRAB_BLOCK equivalent)', !seen.has(MODE.GRAB), [...seen].join(','));
    }
    // 7. Selected-part outline: brighter, eased.
    {
      const sc = new THREE.Scene();
      const P = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
      sc.add(P);
      const hover = ret.createPartHighlight(sc);
      const sel = ret.createPartHighlight(sc, ret.SELECTED_OUTLINE);
      let t = 0;
      const ops = [];
      for (let i = 0; i < 40; i++) { hover.update({ part: P, nowMs: (t += 16) }); sel.update({ part: P, nowMs: t }); ops.push(sel.opacity); }
      const hoverOn = hover.opacity;
      const shownSel = sel.shown;
      for (let i = 0; i < 40; i++) { sel.update({ part: null, nowMs: (t += 16) }); ops.push(sel.opacity); }
      let maxStep = 0;
      for (let i = 1; i < ops.length; i++) maxStep = Math.max(maxStep, Math.abs(ops[i] - ops[i - 1]));
      checkTrue('#G7 selected outline: second instance, brighter than hover, eased in and out (no step > 0.15)',
        ops[39] > hoverOn + 0.2 && ops[0] < 0.2 && ops.at(-1) < 0.02 && maxStep < 0.15 && shownSel === P && sel.shown === null,
        `sel ${ops[39].toFixed(2)} vs hover ${hoverOn.toFixed(2)} · first ${ops[0].toFixed(2)} · max step ${maxStep.toFixed(3)}`);
      hover.dispose(); sel.dispose();
    }
    // 8. Practice targets at least the hands-mode minimum.
    {
      const tg = cal.makeTargets(1600, 900, 6, [cal.PRACTICE_RADIUS_PX]);
      checkTrue('#G8 practice targets ≥ 48 px across (HANDS-UX-SPEC §2; was 36 px)', 2 * cal.PRACTICE_RADIUS_PX >= 48 && tg.every((x) => 2 * x.r >= 48), String(cal.PRACTICE_RADIUS_PX));
    }
    // 9. Thumb-tap click: off by default, rewinds to the onset, A/B in practice.
    {
      const base = frame('pointer', 'side', 'None', { jitter: 0 }).worldLandmarks;
      const withThumb = (g) => {
        const w = base.map((q) => ({ ...q }));
        const mid = { x: (w[5].x + w[6].x) / 2, y: (w[5].y + w[6].y) / 2, z: (w[5].z + w[6].z) / 2 };
        const palm = Math.hypot(w[0].x - w[9].x, w[0].y - w[9].y, w[0].z - w[9].z);
        w[4] = { x: mid.x, y: mid.y, z: mid.z + g * palm };
        return w;
      };
      const gapOf = (w) => gunFeatures(w).thumbGap;
      const cocked = withThumb(1.0);
      const dropped = withThumb(0.05);
      const mk = (on) => ptr.createPointer({ thumbTap: on });
      const drive = (p) => {
        let t = 0;
        let click = null;
        let xAtOnset = null;
        for (let i = 0; i < 15; i++) p.update([ph(true, { cx: 0.5, world: cocked })], 1.78, (t += FR));
        // Tap: the thumb drops over 3 frames while the hand (and cursor) drifts right.
        const gs = [1.0, 0.5, 0.2, 0.05];
        for (let i = 0; i < gs.length; i++) {
          const r = p.update([ph(true, { cx: 0.5 + 0.02 * i, world: withThumb(gs[i]) })], 1.78, (t += FR));
          if (i === 0) xAtOnset = p.state.x;
          click = r ?? click;
        }
        return { click, xAtOnset };
      };
      const off = drive(mk(false));
      const on = drive(mk(true));
      checkTrue('#G9 thumb-tap: off by default = no click; on = a click via thumb-tap at the onset cursor (rewound)',
        gapOf(cocked) > 0.55 && gapOf(dropped) < 0.3 && off.click === null && on.click?.via === 'thumb-tap' && Math.abs(on.click.x - on.xAtOnset) < 1e-9,
        `gaps ${gapOf(cocked)}/${gapOf(dropped)} · off ${JSON.stringify(off.click)} · on ${on.click?.via} x ${on.click?.x?.toFixed(3)} onset ${on.xAtOnset?.toFixed(3)}`);
      const p = mk(false);
      let t = 0;
      for (let i = 0; i < 15; i++) p.update([ph(true, { world: cocked })], 1.78, (t += FR));
      p.setThumbTap(true);
      const slowOn = [];
      for (let i = 0; i < 15; i++) p.update([ph(true, { world: cocked })], 1.78, (t += FR));
      for (let i = 0; i <= 50; i++) slowOn.push(p.update([ph(true, { world: withThumb(1.0 - i * 0.02) })], 1.78, (t += FR)));
      checkTrue('#G9 thumb-tap: a slow thumb lowering (1.7 s; 0.55 → 0.30 gap in ~420 ms) never clicks', slowOn.every((c) => c === null) && p.thumbTap === true, String(slowOn.filter(Boolean).length));
      // Practice A/B: thumb-tap rounds switch the pointer's trial on, and back off after.
      const fp = { thumbTap: false, log: [], get state() { return { mode: 'aim', source: 'hand', x: 0, y: 0, frozen: false }; }, setThumbTap(v) { this.thumbTap = v; this.log.push(v); } };
      const hadH = 'hologram' in globalThis; const savedH = globalThis.hologram; globalThis.hologram = {};
      const pr = cal.createSelectionPractice({ pointer: fp, rect: () => ({ left: 0, top: 0, width: 800, height: 600 }), parent: document.createElement('div'),
        rounds: [{ commit: 'other-pinch', targeting: 'point' }, { commit: 'thumb-tap', targeting: 'point' }] });
      pr.start(0);
      const during1 = fp.thumbTap;
      let tt = 0;
      while (pr.active && pr.round.index === 0) pr.onFrame((tt += 100));
      const during2 = fp.thumbTap;
      while (pr.active) pr.onFrame((tt += 100));
      if (hadH) globalThis.hologram = savedH; else delete globalThis.hologram;
      checkTrue('#G9 practice A/B: PRACTICE_ROUNDS_THUMB adds thumb-tap point + bubble; the trial is on only in its rounds',
        cal.PRACTICE_ROUNDS_THUMB.filter((r) => r.commit === 'thumb-tap').length === 2 && during1 === false && during2 === true && fp.thumbTap === false,
        `${during1} → ${during2} → ${fp.thumbTap}`);
    }
  });

  const { createHandsRuntime } = await import(`./handsRuntime.js${V}`);
  group('One-hand selection — hands runtime end to end (hold, hold again, pinch + bubble)', () => {
    const { g, m, A, B, C, ndcOf } = selRig();
    const scene = new THREE.Scene();
    scene.add(g);
    const cv = document.createElement('canvas');
    Object.assign(cv.style, { position: 'fixed', left: '-4000px', top: '0', width: `${VP.width}px`, height: `${VP.height}px` });
    document.body.appendChild(cv);
    const rt = createHandsRuntime({
      scene, camera, renderer: { domElement: cv }, overlay: document.createElement('canvas'),
      video: document.createElement('video'), pickTargets: () => g, manipulator: () => m
    });
    try {
      const clicks = [];
      const targets = [];
      // The host's part of the contract (hologram.js act()).
      rt.on('click', (c) => { clicks.push(c); m.selectPartAtScreenPoint(c.x, c.y, { part: c.part }); });
      rt.on('target', (x) => targets.push(x?.part?.name ?? null));
      const FR = 1000 / 60;
      let now = 300000;
      const reach = rt.pointer.profile.reach;
      const probe = frame('pointer', 'side', 'None', { cx: 0.5, cy: 0.55, jitter: 0 });
      const c0 = ptr.palmCentroid(probe.landmarks);
      const handAt = (ndc, o = {}) => frame('pointer', 'side', 'None', {
        cx: reach.x0 + ((1 - ndc.x) * (reach.x1 - reach.x0)) / 2 - (c0.x - 0.5),
        cy: reach.y0 + ((1 - ndc.y) * (reach.y1 - reach.y0)) / 2 - (c0.y - 0.55), jitter: 0, ...o
      });
      const run = (ms, hands) => {
        // The camera path is off here, so the pointer's own clicks go in through injectClick
        // (the same router the camera path uses).
        for (let e = 0; e < ms; e += FR) {
          const hs = hands();
          hs.forEach((h) => gestures.annotateHand(h, ASPECT));
          rt.engagement.update(hs);
          const click = rt.pointer.update(hs, ASPECT, now);
          if (click) rt.injectClick(click);
          rt.update(now);
          now += FR;
        }
      };
      const nA = ndcOf(A);
      run(1000, () => [handAt(nA)]);
      checkTrue('hold still on A for 1 s: one "hold" click, A selected', clicks.length === 1 && clicks[0].via === 'hold' && m.activePart === A,
        `${clicks.map((c) => `${c.via}:${c.part?.name}`).join(', ')} · cursor ${rt.pointer.state.x.toFixed(3)},${rt.pointer.state.y.toFixed(3)} vs A ${nA.x.toFixed(3)},${nA.y.toFixed(3)}`);
      checkTrue('the hovered target was announced (target event: A)', targets.includes('A'), targets.join());
      const off = pxToNdc(ndcToPx(nA).x + 40, ndcToPx(nA).y);
      run(300, () => [handAt(off)]);
      run(1000, () => [handAt(nA)]);
      checkTrue('hold again on the same spot: the next part behind (C) is selected', clicks.length === 2 && clicks[1].part === C && m.activePart === C,
        clicks.map((c) => `${c.via}:${c.part?.name}`).join(', '));
      // Same-hand pinch beside B (a miss): the bubble target B is selected.
      const pB = ndcToPx(ndcOf(B));
      let edge = pB.x;
      while (m.partsNear(pxToNdc(edge - 1, pB.y), 0, { viewport: VP }).some((c) => c.part === B)) edge--;
      const nearB = pxToNdc(edge - 30, pB.y);
      run(300, () => [handAt(nearB)]);
      run(100, () => [handAt(nearB, { thumbTo: 8 })]);
      const last = clicks.at(-1);
      checkTrue('quick same-hand pinch 30 px beside B: "pinch" click selects B (bubble)', clicks.length === 3 && last.via === 'pinch' && last.part === B && m.activePart === B,
        clicks.map((c) => `${c.via}:${c.part?.name ?? '-'}`).join(', '));
      run(1200, () => [handAt(nearB)]);
      checkTrue('resting after the pinch never also fires by hold', clicks.length === 3, `${clicks.length} clicks`);
      const s = rt.stats.selects;
      checkTrue('stats.selects counts each commit kind (for sessionrec)', s.hold === 2 && s.pinch === 1 && rt.stats.clicks === 3, JSON.stringify(s));
      // Tab (keyboard): with the cursor on A, the stack under it is A then C.
      run(300, () => [handAt(nA)]);
      const tabs = [rt.cycleTarget(), rt.cycleTarget(), rt.cycleTarget()].map((p) => p?.name);
      checkTrue('Tab cycles the parts under the cursor front to back: A, C, A', tabs.join() === 'A,C,A', tabs.join());
    } finally {
      rt.dispose();
      cv.remove();
    }
  });

  group('Measure panel — pointer placement at NDC (placeAtNdc)', () => {
    const panelScene = new THREE.Scene();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5));
    panelScene.add(box);
    panelScene.updateMatrixWorld(true);
    const mount = document.createElement('div');
    mount.hidden = true;
    document.body.appendChild(mount);
    const panel = createMeasurePanel({
      mount, object: box, camera, scene: panelScene,
      renderer: { domElement: document.createElement('canvas') },
      modelName: '__regression-pointer'
    });
    checkTrue('panel starts with clicks not claimed (mode off), and a pointer click places nothing', panel.mode === 'off' && panel.placeAtNdc(0, 0) === false, panel.mode);
    [...mount.querySelectorAll('button')].find((b) => b.textContent.startsWith('pick two points'))?.click();
    const a = new THREE.Vector3(0, 0.4, 0.25).project(camera);
    const b = new THREE.Vector3(0, -0.2, 0.25).project(camera);
    const okA = panel.placeAtNdc(a.x, a.y - 0.01);
    const okB = panel.placeAtNdc(b.x, b.y, new THREE.Vector3(0, -0.2, 0.25));
    const text = [...mount.querySelectorAll('*')].map((e) => e.childElementCount === 0 ? e.textContent : '').find((s) => s.includes('apart')) ?? '';
    checkTrue('tape on: two pointer clicks place A and B', panel.mode === 'tape' && okA && okB && panel.tapePoints === 2, `${panel.mode} ${panel.tapePoints}`);
    checkTrue('B placed at the snapped vertex given; tape reads the distance', /^\s*[\d.]+\s*cm apart/.test(text), text);
    checkTrue('a miss places nothing', panel.placeAtNdc(0.99, 0.99) === false, 'miss');
    panel.dispose();
    mount.remove();
    localStorage.removeItem('hologram-notes:__regression-pointer');
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

  // BUGS #53: the owner's mouse spun the chair. r161 OrbitControls stays mid-drag when one
  // pointerup is lost, so every plain mouse move rotates; the next click then throws at
  // OrbitControls.js:1071. These drive real OrbitControls with synthetic pointer events (pointer
  // capture stubbed: synthetic pointers can't be captured) and never let it reach the throwing
  // path, so the suite stays at 0 console errors.
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const { createOrbitGuard } = await import(`./orbitGuard.js${V}`);
  group('Orbit guard — the model only turns while dragging (orbitGuard.js, BUGS #53)', () => {
    const cv = document.createElement('canvas');
    Object.assign(cv.style, { position: 'fixed', left: '-4000px', top: '0', width: '400px', height: '300px' });
    cv.setPointerCapture = cv.releasePointerCapture = () => {};
    document.body.appendChild(cv);
    const errors = [];
    const onErr = (e) => errors.push(String(e.message ?? e));
    window.addEventListener('error', onErr);
    const rig = (guarded) => {
      const cam = new THREE.PerspectiveCamera(45, 4 / 3, 0.01, 100);
      cam.position.set(0, 0.4, 2);
      const controls = new OrbitControls(cam, cv);
      const guard = guarded ? createOrbitGuard({ controls }) : null;
      const r = cv.getBoundingClientRect();
      let x = r.left + 200, y = r.top + 150;
      const ev = (type, buttons, dx = 0) => {
        x += dx;
        cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons, pointerId: 1, pointerType: 'mouse', bubbles: true }));
        controls.update();
      };
      const az = () => controls.getAzimuthalAngle();
      return { controls, guard, ev, az, dispose: () => { guard?.dispose(); controls.dispose(); } };
    };
    try {
      // The repro, unguarded: a pointerdown whose pointerup never arrives, then plain moves.
      {
        const { ev, az, dispose } = rig(false);
        ev('pointerdown', 1);
        const a0 = az();
        ev('pointermove', 0, 120);
        checkTrue('without the guard, a lost pointerup leaves plain mouse moves spinning the view (the bug)',
          Math.abs(az() - a0) > 0.1, `azimuth moved ${(az() - a0).toFixed(3)} rad with no button held`);
        ev('pointercancel', 0); // leave this controls clean before dispose
        dispose();
      }
      const { guard, ev, az, dispose } = rig(true);
      // A normal drag still orbits.
      let a0 = az();
      ev('pointerdown', 1);
      ev('pointermove', 1, 120);
      ev('pointerup', 0);
      checkTrue('a real drag still orbits', Math.abs(az() - a0) > 0.1, `azimuth moved ${(az() - a0).toFixed(3)} rad over 120 px`);
      check('a normal drag needs no repair', guard.repairs, 0);
      check('the drag is closed after pointerup', guard.dragging ? 1 : 0, 0);
      // Lost pointerup, then plain moves: the first button-less move ends the drag, no spin.
      ev('pointerdown', 1);
      ev('pointermove', 1, 40);
      a0 = az();
      ev('pointermove', 0, 120);
      ev('pointermove', 0, 120);
      check('after a lost pointerup, plain mouse moves turn the view by 0 rad', Math.abs(az() - a0), 0);
      check('the stuck drag was repaired once', guard.repairs, 1);
      // Lost pointerup, then a new click straight away (no move between): repaired before the
      // controls see a duplicate pointer, so its pointerup cannot throw.
      ev('pointerdown', 1);
      ev('pointerdown', 1);
      ev('pointerup', 0);
      check('a click after a lost pointerup is repaired first', guard.repairs, 2);
      a0 = az();
      ev('pointermove', 0, 120);
      check('after that click, plain moves still turn the view by 0 rad', Math.abs(az() - a0), 0);
      // A scroll is start+end in one go: never left "dragging".
      cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
      check('a wheel step leaves no drag open', guard.dragging ? 1 : 0, 0);
      check('no errors thrown (OrbitControls.js:1071 path never reached)', errors.length, 0);
      dispose();
    } finally {
      window.removeEventListener('error', onErr);
      cv.remove();
    }
  });

  // BUGS #28: part selection was never wired on hologram.html. This drives the REAL page (in
  // a hidden iframe) and its real click handler with synthetic pointer events: explode the
  // 8-part chair past half-way, click a part, click empty space, drag. Needs the page's model
  // and CDN imports, so it waits up to 30s and reports a failure rather than hanging.
  currentGroup = { name: 'Part selection by mouse on hologram.html (BUGS #28)', cases: [] };
  groups.push(currentGroup);
  const frameEl = document.createElement('iframe');
  frameEl.style.cssText = 'position:fixed;left:0;top:0;width:1100px;height:720px;opacity:0;pointer-events:none;border:0';
  frameEl.src = 'hologram.html';
  document.body.appendChild(frameEl);
  try {
    const w = frameEl.contentWindow;
    const deadline = performance.now() + 30000;
    while (!(w.hologram?.manipulator && w.hologram.model) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const h = w.hologram;
    if (!h?.manipulator) throw new Error('hologram.html did not finish loading in 30s');
    const m = h.manipulator;
    checkTrue('the page loads a multi-part (literal explode) model', m.explodeIsLiteral);
    h.controls.enabled = false; // synthetic pointers can't be captured by OrbitControls
    const canvas = h.renderer.domElement;
    const parts = [];
    h.model.traverse((c) => { if (c.isMesh) parts.push(c); });
    const click = (x, y, dx = 0) => {
      const opts = { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true };
      canvas.dispatchEvent(new w.PointerEvent('pointerdown', opts));
      canvas.dispatchEvent(new w.PointerEvent('pointerup', { ...opts, clientX: x + dx }));
    };
    const screenOf = (part) => {
      h.model.updateMatrixWorld(true);
      h.camera.updateMatrixWorld(true);
      const v = part.getWorldPosition(new part.position.constructor()).project(h.camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    };
    const clickAnyPart = () => {
      for (const p of parts) { const s = screenOf(p); click(s.x, s.y); if (m.activePart) return s; }
      return null;
    };

    m.reset();
    clickAnyPart();
    checkTrue('before exploding, a click on the chair selects nothing', m.activePart === null);

    // Explode with synthetic open hands (the page's own clock, so its render-loop tick agrees).
    const oh = (x) => hand(x, 0.5, 0, 'open');
    let t = w.performance.now();
    for (let i = 0; i < 8; i++) { m.update([oh(0.45), oh(0.55)], 1.78, t); t += 33.3; }
    for (let i = 1; i <= 25; i++) { m.update([oh(0.45 - 0.016 * i), oh(0.55 + 0.016 * i)], 1.78, t); t += 33.3; }
    for (let i = 0; i < 20; i++) { m.update([], 1.78, t); t += 33.3; }
    const off = Math.max(...parts.map((p) => p.position.distanceTo(p.userData.explodeHome)));
    checkTrue('the chair is exploded past half-way', off > 0.3, `max offset ${off.toFixed(3)} (full = 0.6)`);

    const at = clickAnyPart();
    checkTrue('a click on a part selects it', !!m.activePart && parts.includes(m.activePart), m.activePart ? `selected "${m.activePart.name}"` : 'nothing selected');
    const chosen = m.activePart;
    if (at) click(at.x, at.y, 40); // a 40px drag from the same spot is an orbit, not a click
    checkTrue('a drag does not change the selection', m.activePart === chosen);
    const r = canvas.getBoundingClientRect();
    click(r.left + 4, r.top + 4);
    checkTrue('a click on empty space goes back to the whole model', m.activePart === null);
    m.reset();
  } catch (err) {
    currentGroup.cases.push({ name: '(group threw)', pass: false, detail: String(err) });
    failCount++;
  }

  // BUGS #52: once Selection practice started there was no visible way out, and it took every
  // hand click, so the owner could not start the tape. Each exit, on the real page: the card's
  // Stop button, the 🎯 button again, Esc, P, and starting the tape / notes / calibration / a drill.
  currentGroup = { name: 'Selection practice always has a way out (hologram.html, BUGS #52)', cases: [] };
  groups.push(currentGroup);
  try {
    const w = frameEl.contentWindow;
    const h = w.hologram;
    if (!h?.handsRuntime) throw new Error('hologram.html did not load');
    const rt = h.handsRuntime;
    const doc = w.document;
    const btn = doc.getElementById('selPractice');
    const key = (k) => doc.body.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));
    const start = () => {
      // The page's button refuses without a camera; the runtime's force flag starts it anyway.
      rt.startPractice({ force: true });
      return !!rt.practice?.active;
    };
    const noteBtn = doc.querySelector('#measure [data-role="note"]');
    const exits = [
      ['the card\'s ✕ Stop button', () => doc.querySelector('[data-role="practice-stop"]')?.click()],
      ['the 🎯 button pressed again', () => btn.click()],
      ['Esc', () => key('Escape')],
      ['P', () => key('p')],
      ['T (tape on)', () => key('t')],
      ['the Notes button', () => noteBtn?.click()],
      ['C (calibrate)', () => key('c')],
      ['a drill button', () => doc.querySelector('#drills button')?.click()]
    ];
    checkTrue('the practice card has a visible Stop button', (() => {
      rt.startPractice({ force: true });
      const b = doc.querySelector('[data-role="practice-stop"]');
      const ok = !!b && w.getComputedStyle(b).pointerEvents !== 'none' && /Stop/.test(b.textContent);
      rt.practice?.cancel();
      return ok;
    })(), 'button [data-role="practice-stop"] reads "✕ Stop (Esc)" and takes clicks');
    for (const [name, act] of exits) {
      const started = start();
      act();
      checkTrue(`practice stops with ${name}`, started && !rt.practice?.active,
        `started ${started}, active after ${!!rt.practice?.active}`);
      // Tidy up whatever that exit turned on, so the next exit (and group) starts clean.
      if (h.calibration?.active) h.calibration.abort();
      const mode = h.measurePanel?.mode ?? 'off';
      if (mode !== 'off') h.measurePanel.toggleMode(mode);
    }
    // The label is synced by the page's render loop, so wait a couple of frames.
    const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : w.requestAnimationFrame(f)); w.requestAnimationFrame(f); });
    const settle = () => Promise.race([frames(3), new Promise((r) => setTimeout(r, 1000))]);
    rt.startPractice({ force: true });
    await settle();
    checkTrue('while practice runs, the 🎯 button reads "Stop"', /Stop/.test(btn.textContent), btn.textContent);
    rt.practice?.cancel();
    await settle();
    checkTrue('after it stops, the 🎯 button reads "Selection practice" again', /Selection practice/.test(btn.textContent) && !/Stop/.test(btn.textContent), btn.textContent);
    checkTrue('the page runs the orbit guard (BUGS #53)', typeof h.orbitGuard?.repairs === 'number');
  } catch (err) {
    currentGroup.cases.push({ name: '(group threw)', pass: false, detail: String(err) });
    failCount++;
  }
  frameEl.remove();

  render();
  rawEl.textContent = `${groups.reduce((n, g) => n + g.cases.length, 0)} checks · ${new Date().toISOString()}`;
}

// test.html's test recorder awaits this: the finished suite, or null when it crashed.
export const finished = main().then(() => ({ groups, passed: passCount, failed: failCount })).catch((err) => {
  summaryEl.textContent = 'suite crashed — see console';
  summaryEl.className = 'fail';
  console.error(err);
  return null;
});

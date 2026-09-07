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

    m.reset();
    m.configure({ channels: ['explode'], sensitivity: 1, momentum: false, triggerFrames: 3 });
    t = 1000;
    const y0 = object.scale.y;
    for (let i = 0; i < 8; i++) { m.update([hand(0.45, 0.5, 0, 'open'), hand(0.55, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    for (let i = 1; i <= 25; i++) { m.update([hand(0.45 - 0.008 * i, 0.5, 0, 'open'), hand(0.55 + 0.008 * i, 0.5, 0, 'open')], 1.78, t); t += 16.7; }
    checkTrue('two open hands apart stretches a single-mesh object', object.scale.y > y0 + 0.3, `scale.y=${object.scale.y.toFixed(2)}`);

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

    // and a slow bring-together must NOT be mistaken for a clap
    m.reset();
    m.configure({ channels: ALL_CHANNELS, sensitivity: 1, momentum: false, triggerFrames: 3 });
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

  group('handSpan units — the bug that made clap impossible', () => {
    // handSpan returns wrist separation in PALM LENGTHS, not a 0-1 screen fraction. This
    // pins that contract down so a future refactor can't silently invert it again.
    const close = gestures.handSpan(hand(0.49, 0.5, 0, 'open'), hand(0.51, 0.5, 0, 'open'), 1.78);
    const apart = gestures.handSpan(hand(0.2, 0.5, 0, 'open'), hand(0.8, 0.5, 0, 'open'), 1.78);
    checkTrue('touching hands read under 2 palm-lengths', close < 2, `span=${close.toFixed(2)}`);
    checkTrue('far-apart hands read several palm-lengths', apart > 3, `span=${apart.toFixed(2)}`);
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

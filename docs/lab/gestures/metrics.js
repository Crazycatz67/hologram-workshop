// Smoothness / accuracy metrics for the gesture pipeline (gesture-tester skill, 2026-09-29).
//
// Runs the SAME synthetic measurements against any version of the pipeline, so the frozen
// copy in ./baseline/ (the code as it was before the smoothing rewrite) and the live root
// modules can be compared in one deterministic run. Synthetic != real webcam: perfect hand
// geometry, uniform random jitter, a clean MediaPipe label every frame.
//
// pipeline = { name, createManipulator, pinch, isFistLike, smooth(hands, t), resetSmoothing() }
//
// Metrics:
//   filter.restJitter   RMS wrist error (normalized units) of a still hand after the landmark
//                       filter, raw jitter 0.002, at 30 and 60fps (raw RMS for reference)
//   filter.lagMs        steady-state lag of the landmark filter on a constant-speed wrist, ms
//   step.*              object response to a quick hand "step" (move 0.2 frame / twist 40°
//                       inside 100ms, then hold): accuracy (final / ideal 1:1 mapping), t50,
//                       settle time (inside ±2% of final for good), overshoot
//   drift               3s still hands with jitter: position cm, rotation °, scale / stretch %
//   fps                 same 1s move sweep at 24 vs 60fps: ratio of displacements
//   clapRecall          fraction of claps (3 durations × 8 frame phases) that fire, per fps
//   judder              per-rendered-frame object step, coefficient of variation, while the
//                       hand sweeps at constant speed with a 30fps camera and a 60Hz display

import * as THREE from 'three';

const ASPECT = 1.78;
let seed = 1;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// Same geometry as gesture-lab.js's makeHand.
export function makeHand(spec, jitter = 0) {
  const { x, y, twist = 0, palm = 0.12, shape = 'open' } = spec;
  const j = () => (jitter ? (rnd() - 0.5) * 2 * jitter : 0);
  const t = (twist * Math.PI) / 180;
  const up = (k) => y - palm * k;
  const lm = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[0] = { x, y, z: 0 };
  lm[9] = { x, y: up(1), z: 0 };
  lm[5] = { x: x + 0.05 * Math.cos(t), y: y - 0.08 + 0.05 * Math.sin(t), z: 0 };
  lm[17] = { x: x - 0.05 * Math.cos(t), y: y - 0.08 - 0.05 * Math.sin(t), z: 0 };
  const reach = shape === 'fist' ? 0.5 : 1.9;
  lm[12] = { x, y: up(reach), z: 0 };
  lm[16] = { x: x - 0.02, y: up(reach * 0.95), z: 0 };
  lm[20] = { x: x - 0.04, y: up(reach * 0.8), z: 0 };
  if (shape === 'pinch') {
    lm[8] = { x: x + 0.03, y: up(1.3), z: 0 };
    lm[4] = { x: x + 0.032, y: up(1.28), z: 0 };
  } else {
    lm[8] = { x: x + 0.02, y: up(reach), z: 0 };
    lm[4] = { x: x + (shape === 'fist' ? 0.02 : 0.07), y: up(shape === 'fist' ? 0.6 : 1.0), z: 0 };
  }
  for (const p of lm) { p.x += j(); p.y += j(); }
  const label = spec.label ?? (shape === 'fist' ? 'Closed_Fist' : shape === 'open' ? 'Open_Palm' : 'None');
  return { gesture: label, handedness: 'Right', landmarks: lm };
}

function rig() {
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5));
  const camera = new THREE.PerspectiveCamera(45, ASPECT, 0.01, 100);
  camera.position.set(0, 0.2, 2.2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return { object, camera };
}

// Drives a pipeline through `specsAt(tSeconds)` for `totalS`, camera at `fps`, display at
// 60Hz (manipulator.tick, when the version has one, runs every display frame the way
// hologram.js now calls it). `sample(t, object)` runs every display frame.
function drive(P, { specsAt, totalS, fps = 30, jitter = 0, channels, momentum = true, sample, smoothing = true, startScale = 1, phaseMs = 0 }) {
  seed = 777;
  P.resetSmoothing();
  const { object, camera } = rig();
  const m = P.createManipulator(object, camera);
  m.configure({ channels: channels ?? ['move', 'spin', 'tilt', 'push', 'scale', 'explode', 'clap'], sensitivity: 1, momentum, triggerFrames: 3 });
  object.scale.setScalar(startScale);
  const t0 = 1000;
  const camStep = 1000 / fps;
  const dispStep = 1000 / 60;
  let nextCam = t0 + phaseMs;
  let clap = false;
  for (let t = t0; t <= t0 + totalS * 1000 + 1e-6; t += dispStep) {
    while (nextCam <= t + 1e-6) {
      const ts = (nextCam - t0) / 1000;
      const hands = specsAt(ts).map((s) => makeHand(s, jitter));
      if (smoothing) P.smooth(hands, nextCam);
      for (const h of hands) {
        h.pinch = P.pinch(h.landmarks, ASPECT, { gesture: h.gesture });
        h.fistLike = P.isFistLike(h.gesture, h.landmarks, ASPECT);
      }
      const wasOff = object.position.lengthSq() !== 0 || object.scale.x !== 1;
      m.update(hands, ASPECT, nextCam);
      if (wasOff && object.position.lengthSq() === 0 && object.scale.x === 1) clap = true;
      nextCam += camStep;
    }
    m.tick?.(t);
    sample?.((t - t0) / 1000, object);
  }
  return { object, camera, clap };
}

const deg = (r) => (r * 180) / Math.PI;
const round = (v, n = 1) => (Number.isFinite(v) ? +v.toFixed(n) : v);

function stepMetrics(series, ideal, motionStart, motionEnd) {
  const final = series[series.length - 1].v;
  let peak = 0;
  let t50 = null;
  let settle = null;
  for (const { t, v } of series) {
    if (t < motionStart) continue;
    if (Math.abs(v) > Math.abs(peak)) peak = v;
    if (t50 === null && Math.abs(v) >= 0.5 * Math.abs(final)) t50 = t - motionStart;
  }
  for (let i = series.length - 1; i >= 0; i--) {
    if (Math.abs(series[i].v - final) > 0.02 * Math.abs(final)) { settle = series[i].t - motionEnd; break; }
  }
  return {
    accuracy: round(final / ideal, 3),
    t50Ms: round((t50 ?? NaN) * 1000, 0),
    settleMsAfterHandStops: round(Math.max(0, settle ?? 0) * 1000, 0),
    overshootPct: round(Math.max(0, (Math.abs(peak) - Math.abs(final)) / Math.abs(final)) * 100, 1)
  };
}

export function runMetrics(P) {
  const out = { name: P.name, filter: {}, step: {}, drift: {}, fps: {}, clapRecall: {}, judder: {} };

  // ---- landmark filter alone ----------------------------------------------------------
  for (const fps of [30, 60]) {
    seed = 99;
    P.resetSmoothing();
    let se = 0, seRaw = 0, n = 0;
    for (let i = 0; i < fps * 3; i++) {
      const t = 1000 + (i * 1000) / fps;
      const h = makeHand({ x: 0.5, y: 0.5, shape: 'open' }, 0.002);
      const rawX = h.landmarks[0].x;
      P.smooth([h], t);
      if (i > fps / 2) { se += (h.landmarks[0].x - 0.5) ** 2; seRaw += (rawX - 0.5) ** 2; n++; }
    }
    out.filter[`restJitter${fps}`] = { rms: +Math.sqrt(se / n).toExponential(2), rawRms: +Math.sqrt(seRaw / n).toExponential(2) };
    for (const [label, speed] of [['slow 0.1/s', 0.1], ['move 0.3/s', 0.3], ['clap 1.35/s', 1.35]]) {
      P.resetSmoothing();
      let lagSum = 0, k = 0;
      const N = Math.round(fps * 0.4);
      for (let i = 0; i < N; i++) {
        const ts = i / fps;
        const x = 0.3 + speed * ts;
        const h = makeHand({ x, y: 0.5, shape: 'open' });
        P.smooth([h], 1000 + ts * 1000);
        if (i >= N - Math.max(2, Math.round(fps * 0.1))) { lagSum += (x - h.landmarks[0].x) / speed; k++; }
      }
      out.filter[`lagMs${fps} ${label}`] = round((lagSum / k) * 1000, 0);
    }
  }

  // ---- step responses (whole pipeline, camera 30fps, display 60Hz) ---------------------
  const { camera: cam0 } = rig();
  const perUnitX = 2 * cam0.position.length() * Math.tan((cam0.fov * Math.PI) / 360) * cam0.aspect;
  for (const momentum of [true, false]) {
    const tag = momentum ? 'momentum on' : 'momentum off';
    // move: fist grabs at 0.4 for 0.5s, slides to 0.6 over 100ms, holds 1.5s
    const ser = [];
    drive(P, {
      totalS: 2.1, momentum, channels: ['move'],
      specsAt: (t) => [{ x: 0.4 + 0.2 * THREE.MathUtils.clamp((t - 0.5) / 0.1, 0, 1), y: 0.5, shape: 'fist' }],
      sample: (t, o) => ser.push({ t, v: -o.position.x })
    });
    out.step[`move ${tag}`] = stepMetrics(ser, 0.2 * perUnitX, 0.5, 0.6);
    const spin = [];
    drive(P, {
      totalS: 2.1, momentum, channels: ['spin'],
      specsAt: (t) => [{ x: 0.5, y: 0.5, twist: 40 * THREE.MathUtils.clamp((t - 0.5) / 0.1, 0, 1), shape: 'fist' }],
      sample: (t, o) => spin.push({ t, v: deg(new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ').y) })
    });
    // The image-plane twist handTwist() actually sees for a 40° knuckle-line turn on a
    // 1.78 aspect frame (x is stretched by the aspect before the angle is taken).
    const seen = deg(Math.atan(Math.tan((40 * Math.PI) / 180) / ASPECT));
    out.step[`spin ${tag}`] = stepMetrics(spin, seen, 0.5, 0.6);
  }
  // scale: two pinches 0.3 apart -> 0.5 apart over 150ms
  const sc = [];
  drive(P, {
    totalS: 2.1, channels: ['scale'],
    specsAt: (t) => { const s = 0.3 + 0.2 * THREE.MathUtils.clamp((t - 0.5) / 0.15, 0, 1); return [{ x: 0.5 - s / 2, y: 0.5, shape: 'pinch' }, { x: 0.5 + s / 2, y: 0.5, shape: 'pinch' }]; },
    sample: (t, o) => sc.push({ t, v: Math.log(o.scale.x) })
  });
  out.step.scale = stepMetrics(sc, Math.log(0.5 / 0.3), 0.5, 0.65);

  // ---- still-hand drift -----------------------------------------------------------------
  const still = {
    fist: () => [{ x: 0.5, y: 0.5, shape: 'fist' }],
    'fist + open 2nd hand': () => [{ x: 0.35, y: 0.5, shape: 'fist' }, { x: 0.65, y: 0.5, shape: 'open' }],
    'two open (explode)': () => [{ x: 0.35, y: 0.5, shape: 'open' }, { x: 0.65, y: 0.5, shape: 'open' }],
    'two pinch (scale)': () => [{ x: 0.35, y: 0.5, shape: 'pinch' }, { x: 0.65, y: 0.5, shape: 'pinch' }]
  };
  for (const jitter of [0.002, 0.004]) {
    for (const [name, specsAt] of Object.entries(still)) {
      for (const smoothing of [true, false]) {
        const { object } = drive(P, { totalS: 3, jitter, specsAt, smoothing, channels: ['move', 'spin', 'tilt', 'push', 'scale', 'explode'] });
        const s = object.scale;
        out.drift[`${name} j${jitter}${smoothing ? '' : ' raw'}`] = {
          cm: round(object.position.length() * 100, 2),
          deg: round(deg(object.quaternion.angleTo(new THREE.Quaternion())), 2),
          scalePct: round((Math.cbrt(s.x * s.y * s.z) - 1) * 100, 2),
          stretchPct: round((Math.max(s.x, s.y, s.z) / Math.min(s.x, s.y, s.z) - 1) * 100, 2)
        };
      }
    }
  }

  // ---- frame-rate independence -----------------------------------------------------------
  const sweep = (fps) => drive(P, {
    fps, totalS: 2.5, channels: ['move'], momentum: false,
    specsAt: (t) => [{ x: 0.3 + 0.3 * THREE.MathUtils.clamp((t - 0.5) / 1, 0, 1), y: 0.5, shape: 'fist' }]
  }).object.position.x;
  const s60 = sweep(60), s24 = sweep(24), s12 = sweep(12);
  out.fps = { move60cm: round(-s60 * 100), move24cm: round(-s24 * 100), move12cm: round(-s12 * 100), ratio24to60: round(s24 / s60, 3), ratio12to60: round(s12 / s60, 3) };

  // ---- clap recall -------------------------------------------------------------------------
  for (const fps of [8, 12, 24, 60]) {
    let hit = 0, n = 0;
    for (const dur of [0.15, 0.2, 0.3]) {
      for (let p = 0; p < 8; p++) {
        const { clap } = drive(P, {
          fps, totalS: 1.4, channels: ['clap'], startScale: 1.3, phaseMs: (p / 8) * (1000 / fps),
          specsAt: (t) => { const u = THREE.MathUtils.clamp((t - 0.6) / dur, 0, 1); const s = 0.6 - 0.54 * u; return [{ x: 0.5 - s / 2, y: 0.5, shape: 'open' }, { x: 0.5 + s / 2, y: 0.5, shape: 'open' }]; }
        });
        hit += clap ? 1 : 0; n++;
      }
    }
    out.clapRecall[`${fps}fps`] = `${hit}/${n}`;
  }
  // slow bring-together must still NOT fire
  out.clapRecall['slow 2s bring-together (must be 0)'] = drive(P, {
    fps: 30, totalS: 3, channels: ['clap'], startScale: 1.3,
    specsAt: (t) => { const u = THREE.MathUtils.clamp((t - 0.5) / 2, 0, 1); const s = 0.6 - 0.54 * u; return [{ x: 0.5 - s / 2, y: 0.5, shape: 'open' }, { x: 0.5 + s / 2, y: 0.5, shape: 'open' }]; }
  }).clap ? 'FIRED' : 0;

  // ---- display judder --------------------------------------------------------------------
  const xs = [];
  drive(P, {
    fps: 30, totalS: 1.6, channels: ['move'], momentum: false,
    specsAt: (t) => [{ x: 0.3 + 0.3 * THREE.MathUtils.clamp((t - 0.4) / 1.2, 0, 1), y: 0.5, shape: 'fist' }],
    sample: (t, o) => { if (t > 0.8 && t < 1.5) xs.push(o.position.x); }
  });
  const steps = xs.slice(1).map((v, i) => Math.abs(v - xs[i]));
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  const sd = Math.sqrt(steps.reduce((a, b) => a + (b - mean) ** 2, 0) / steps.length);
  out.judder = { perFrameStepCV: round(sd / mean, 2), zeroStepFrames: steps.filter((s) => s < 1e-9).length + '/' + steps.length };
  return out;
}

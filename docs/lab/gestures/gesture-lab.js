// Gesture lab: per-gesture measurement for the gesture-tester skill.
//
// Drives the SHIPPED gesture pipeline (smoothLandmarks -> gestures.pinch / isFistLike ->
// manipulator.update, exactly the order hologram.js uses) with synthetic hands, and records
// what each motion actually does to the object on EVERY channel. Output is machine-readable
// first (window.__gestureReport, JSON) and markdown second (window.__gestureReportMd).
//
// Synthetic != real webcam. These hands have perfect landmark geometry, a clean MediaPipe
// label every frame, and uniform random jitter. They prove what the code does given known
// motions -- where the thresholds sit, what bleeds, what is frame-rate dependent -- not how a
// real hand feels. Every "fires" below is a statement about the code, not about a person.
//
// Deterministic: seeded RNG, fixed timestamps. Run it twice, get the same numbers.
//
// Open http://localhost:8080/docs/lab/gestures/gesture-lab.html  (add ?only=move,clap to
// scope the per-gesture sweeps to a few gestures).

import * as THREE from 'three';

const V = `?v=${Date.now()}`;
// ?code=baseline runs the frozen pre-2026-09-29-rewrite copies in ./baseline/ instead of the
// live root modules, so a before/after report pair comes from the same harness.
const CODE = new URLSearchParams(location.search).get('code') === 'baseline' ? './baseline/' : '../../../';
const { createManipulator, CHANNELS } = await import(`${CODE}manipulator.js${V}`);
const { pinch, isFistLike } = await import(`${CODE}gestures.js${V}`);
const { smoothHandLandmarks, resetLandmarkSmoothing } = await import(`${CODE}smoothLandmarks.js${V}`);

const ASPECT = 1.78;

// ---- deterministic RNG ----------------------------------------------------------------
let seed = 1;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

// ---- synthetic hand ---------------------------------------------------------------------
// Richer than test.js's hand(): fingertips are placed so the geometric checks behave like a
// real hand (open: tips ~1.9 palm lengths out; fist: ~0.5; pinch: thumb and index tips
// touching, other fingers out). test.js leaves every fingertip AT the wrist, which makes
// isFistShape() true for every hand, including "open" and "pinch" ones -- harmless there
// because those tests hard-code pinch/fistLike, but it would hide real bleed here.
//
// spec: { x, y, twist (deg), palm (normalized length, default 0.12), shape: fist|open|pinch,
//         label (MediaPipe category override, e.g. 'None' for a punch-orientation fist) }
function makeHand(spec, jitter) {
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
  lm[12] = { x, y: up(reach), z: 0 };                  // middle tip
  lm[16] = { x: x - 0.02, y: up(reach * 0.95), z: 0 }; // ring tip
  lm[20] = { x: x - 0.04, y: up(reach * 0.8), z: 0 };  // pinky tip
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

// ---- one trial --------------------------------------------------------------------------
// motion(u) -> array of hand specs for progress u in [0,1]. Hold at u=0 for holdS, move over
// durationS, hold at u=1 for settleS. Effects are measured from the end of the first hold.
function runTrial({
  motion, channels = CHANNELS, fps = 60, durationS = 1, holdS = 0.3, settleS = 0.5,
  jitter = 0, smoothing = true, momentum = false, sensitivity = 1, glitch = null, startScale = 1.3
}) {
  seed = 12345;
  resetLandmarkSmoothing();
  const object = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5));
  const camera = new THREE.PerspectiveCamera(45, ASPECT, 0.01, 100);
  camera.position.set(0, 0.2, 2.2);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const m = createManipulator(object, camera);
  m.configure({ channels, sensitivity, momentum, triggerFrames: 3 });

  // Offset from home so a clap (performReset) is detectable as an exact snap back.
  // Scale offset too for the per-gesture sweeps (so shrinking is measurable); the drift
  // probes start at the real home scale 1.0, since explode's clamp floor IS home scale.
  object.scale.setScalar(startScale);
  object.position.set(0.05, 0, 0);

  const step = 1000 / fps;
  let t = 1000;
  let clapFired = false;
  const modeFrames = {};
  let firstActiveMs = null;
  const frame = (u, motionT, i) => {
    // glitch(i) -> true turns hand 0 into a pinch shape for this one frame, SAME position.
    const specs = motion(u).map((s, k) => (k === 0 && glitch && glitch(i) ? { ...s, shape: 'pinch' } : s));
    const hands = specs.map((s) => makeHand(s, jitter));
    if (smoothing) smoothHandLandmarks(hands, t);
    for (const h of hands) {
      h.pinch = pinch(h.landmarks, ASPECT, { gesture: h.gesture });
      h.fistLike = isFistLike(h.gesture, h.landmarks, ASPECT);
    }
    const before = object.position.lengthSq() !== 0 || object.scale.x !== 1; // snap-to-home = clap
    const mode = m.update(hands, ASPECT, t);
    if (before && object.position.lengthSq() === 0 && object.scale.x === 1 && object.scale.y === 1) clapFired = true;
    // Display-rate follow steps between camera frames, the way hologram.js calls tick().
    for (let d = 1000 / 60; d < step - 1e-6; d += 1000 / 60) m.tick?.(t + d);
    if (motionT !== null) {
      modeFrames[mode] = (modeFrames[mode] || 0) + 1;
      if (mode !== 'idle' && firstActiveMs === null) firstActiveMs = motionT;
    }
    t += step;
  };

  const holdN = Math.max(1, Math.round((holdS * 1000) / step));
  for (let i = 0; i < holdN; i++) frame(0, null, -1);
  const p0 = object.position.clone();
  const q0 = object.quaternion.clone();
  const s0 = object.scale.clone();
  const clapBefore = clapFired;

  const n = Math.max(1, Math.round((durationS * 1000) / step));
  for (let i = 1; i <= n; i++) frame(i / n, (i * step), i);
  const settleN = Math.round((settleS * 1000) / step);
  for (let i = 0; i < settleN; i++) frame(1, null, -1);

  // Effects, split by channel.
  // Move only ever writes x/y and push only moves along the camera->object ray, so push is
  // recovered from the z change alone (raw camera distance also grows when the object slides
  // sideways, which would read as false push).
  const ray = p0.clone().sub(camera.position).normalize();
  const disp = object.position.clone().sub(p0);
  const alongRay = disp.z / ray.z;
  const lateral = disp.clone().sub(ray.clone().multiplyScalar(alongRay));
  const R = object.quaternion.clone().multiply(q0.clone().invert());
  const e = new THREE.Euler().setFromQuaternion(R, 'YXZ');
  const deg = (r) => (r * 180) / Math.PI;
  const ratios = ['x', 'y', 'z'].map((k) => object.scale[k] / s0[k]);
  return {
    lateralCm: lateral.length() * 100,
    depthCm: alongRay * 100, // negative = toward the camera
    spinDeg: deg(e.y), pitchDeg: deg(e.x), rollDeg: deg(e.z),
    scaleRatio: Math.cbrt(ratios[0] * ratios[1] * ratios[2]),
    stretch: Math.max(...ratios) / Math.min(...ratios),
    clap: clapFired && !clapBefore,
    clapDuringHold: clapBefore,
    modeFrames, firstActiveMs
  };
}

// Which channels a result says fired. Thresholds are "visible on screen", not "nonzero".
const FIRE = {
  move: (r) => r.lateralCm > 1,
  push: (r) => Math.abs(r.depthCm) > 1,
  spin: (r) => Math.abs(r.spinDeg) > 2,
  tilt: (r) => Math.abs(r.pitchDeg) > 2 || Math.abs(r.rollDeg) > 2,
  scale: (r) => Math.abs(Math.log(r.scaleRatio)) > 0.03 && r.stretch < 1.03,
  explode: (r) => r.stretch > 1.03,
  clap: (r) => r.clap
};
const fired = (r) => Object.keys(FIRE).filter((k) => !r.clap || k === 'clap').filter((k) => FIRE[k](r));
const mag = {
  move: (r) => `${r.lateralCm.toFixed(1)}cm`,
  push: (r) => `${r.depthCm.toFixed(1)}cm`,
  spin: (r) => `${r.spinDeg.toFixed(1)}°`,
  tilt: (r) => `p${r.pitchDeg.toFixed(1)}°/r${r.rollDeg.toFixed(1)}°`,
  scale: (r) => `×${r.scaleRatio.toFixed(2)}`,
  explode: (r) => `stretch ${r.stretch.toFixed(2)}`,
  clap: (r) => (r.clap ? 'reset' : '-')
};

// ---- canonical motions (one per gesture) -----------------------------------------------
const lerp = (a, b, u) => a + (b - a) * u;
const MOTIONS = {
  move: { durationS: 1, desc: 'one fist slides 0.30 of frame width left-to-right',
    motion: (u, k = 1) => [{ x: lerp(0.35, 0.35 + 0.3 * k, u), y: 0.5, shape: 'fist' }] },
  spin: { durationS: 0.5, desc: 'one fist, wrist twists 0°→40°',
    motion: (u, k = 1) => [{ x: 0.5, y: 0.5, twist: 40 * k * u, shape: 'fist' }] },
  push: { durationS: 1, desc: 'one fist approaches camera: palm length 0.08→0.13',
    motion: (u, k = 1) => [{ x: 0.5, y: 0.5, palm: 0.08 + 0.05 * k * u, shape: 'fist' }] },
  tilt: { durationS: 0.67, desc: 'fist holds; open second hand rises 0.24',
    motion: (u, k = 1) => [{ x: 0.35, y: 0.5, shape: 'fist' }, { x: 0.65, y: 0.5 - 0.24 * k * u, shape: 'open' }] },
  scale: { durationS: 0.42, desc: 'two pinching hands move apart 0.10→0.50 (horizontal)',
    motion: (u, k = 1) => [{ x: 0.45 - 0.2 * k * u, y: 0.5, shape: 'pinch' }, { x: 0.55 + 0.2 * k * u, y: 0.5, shape: 'pinch' }] },
  explode: { durationS: 0.42, desc: 'two open hands move apart 0.10→0.50 (horizontal)',
    motion: (u, k = 1) => [{ x: 0.45 - 0.2 * k * u, y: 0.5, shape: 'open' }, { x: 0.55 + 0.2 * k * u, y: 0.5, shape: 'open' }] },
  clap: { durationS: 0.2, desc: 'two open hands close 0.60→0.06 apart',
    motion: (u, k = 1) => { const sep = lerp(0.6, 0.6 - 0.54 * k, u); return [{ x: 0.5 - sep / 2, y: 0.5, shape: 'open' }, { x: 0.5 + sep / 2, y: 0.5, shape: 'open' }]; } }
};
// Motions that should do NOTHING (or only their named gesture) -- false-fire probes.
const NULLS = {
  'open hand slides': { durationS: 1, expect: [], motion: (u) => [{ x: lerp(0.35, 0.65, u), y: 0.5, shape: 'open' }] },
  'still fist (3s)': { durationS: 3, expect: [], motion: () => [{ x: 0.5, y: 0.5, shape: 'fist' }] },
  'still two open hands (3s)': { durationS: 3, expect: [], motion: () => [{ x: 0.35, y: 0.5, shape: 'open' }, { x: 0.65, y: 0.5, shape: 'open' }] },
  'still two pinches (3s)': { durationS: 3, expect: [], motion: () => [{ x: 0.35, y: 0.5, shape: 'pinch' }, { x: 0.65, y: 0.5, shape: 'pinch' }] },
  'slow bring-together (2s)': { durationS: 2, expect: ['explode'], motion: (u) => { const sep = lerp(0.6, 0.06, u); return [{ x: 0.5 - sep / 2, y: 0.5, shape: 'open' }, { x: 0.5 + sep / 2, y: 0.5, shape: 'open' }]; } },
  'fist slides + second open hand still': { durationS: 1, expect: ['move'], motion: (u) => [{ x: lerp(0.3, 0.5, u), y: 0.5, shape: 'fist' }, { x: 0.75, y: 0.5, shape: 'open' }] },
  'fist slides vertically (y 0.35→0.65)': { durationS: 1, expect: ['move'], motion: (u) => [{ x: 0.5, y: lerp(0.35, 0.65, u), shape: 'fist' }] },
  'fist slides with hand growing (diagonal toward camera)': { durationS: 1, expect: ['move', 'push'], motion: (u) => [{ x: lerp(0.35, 0.6, u), y: 0.5, palm: lerp(0.10, 0.13, u), shape: 'fist' }] },
  'punch fist (label None) slides': { durationS: 1, expect: ['move'], motion: (u) => [{ x: lerp(0.35, 0.65, u), y: 0.5, shape: 'fist', label: 'None' }] },
  'thumbs-up (label Thumb_Up, curled) slides': { durationS: 1, expect: [], motion: (u) => [{ x: lerp(0.35, 0.65, u), y: 0.5, shape: 'fist', label: 'Thumb_Up' }] }
};

// ---- experiments ----------------------------------------------------------------------
const only = new URLSearchParams(location.search).get('only')?.split(',') ?? Object.keys(MOTIONS);
const report = { generated: new Date().toISOString(), code: CODE === './baseline/' ? 'baseline (before 2026-09-29 smoothing rewrite)' : 'live root modules', synthetic: true, aspect: ASPECT, gestures: {}, nulls: {}, jitter: {}, notes: [] };

for (const name of Object.keys(MOTIONS).filter((g) => only.includes(g))) {
  const G = MOTIONS[name];
  const g = { desc: G.desc };
  // 1. isolated (practice mode: only this channel armed)
  const iso = runTrial({ motion: (u) => G.motion(u), durationS: G.durationS, channels: [name] });
  g.isolated = { fires: FIRE[name](iso), magnitude: mag[name](iso), latencyMs: iso.firstActiveMs && Math.round(iso.firstActiveMs) };
  // 2. everything armed: what else fires (bleed)
  const all = runTrial({ motion: (u) => G.motion(u), durationS: G.durationS });
  g.allArmed = { fired: fired(all), magnitudes: Object.fromEntries(fired(all).map((k) => [k, mag[k](all)])), modes: all.modeFrames };
  g.bleed = fired(all).filter((k) => k !== name);
  // 3. speed sweep: same amplitude, different durations -> where the deadzone / rate cap bite
  g.speed = [0.05, 0.1, 0.2, 0.5, 1, 2, 4, 8].map((d) => {
    const r = runTrial({ motion: (u) => G.motion(u), durationS: d, channels: [name] });
    return { durationS: d, fires: FIRE[name](r), magnitude: mag[name](r) };
  });
  // 4. amplitude sweep at canonical duration -> smallest motion that registers
  g.amplitude = [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1].map((k) => {
    const r = runTrial({ motion: (u) => G.motion(u, k), durationS: G.durationS, channels: [name] });
    return { fraction: k, fires: FIRE[name](r), magnitude: mag[name](r) };
  });
  // 5. frame-rate sweep: same real motion at different camera rates
  g.fps = [10, 15, 24, 30, 60].map((fps) => {
    const r = runTrial({ motion: (u) => G.motion(u), durationS: G.durationS, channels: [name], fps });
    return { fps, fires: FIRE[name](r), magnitude: mag[name](r) };
  });
  // 6. jitter robustness of the gesture itself
  g.jitter = [0, 0.002, 0.004, 0.008].map((jit) => {
    const r = runTrial({ motion: (u) => G.motion(u), durationS: G.durationS, channels: [name], jitter: jit });
    return { jitter: jit, fires: FIRE[name](r), magnitude: mag[name](r) };
  });
  // 7. smoothing on vs off (hologram.js always smooths)
  const raw = runTrial({ motion: (u) => G.motion(u), durationS: G.durationS, channels: [name], smoothing: false });
  g.smoothingOff = { fires: FIRE[name](raw), magnitude: mag[name](raw) };
  report.gestures[name] = g;
}

// Clap specifics: arming span, and a one-frame pinch glitch at 15/22/30 fps
if (only.includes('clap')) {
  const openPair = (sep) => [{ x: 0.5 - sep / 2, y: 0.5, shape: 'open' }, { x: 0.5 + sep / 2, y: 0.5, shape: 'open' }];
  report.gestures.clap.startSeparation = [0.15, 0.2, 0.25, 0.3, 0.4, 0.6].map((start) => {
    const r = runTrial({ motion: (u) => openPair(lerp(start, 0.04, u)), durationS: 0.15, channels: ['clap'] });
    return { startSep: start, fires: r.clap };
  });
  report.gestures.clap.glitchedFrame = [15, 22, 30].map((fps) => {
    const r = runTrial({
      motion: (u) => MOTIONS.clap.motion(u), durationS: 0.2, channels: ['clap'], fps,
      glitch: (i) => i === 2
    });
    return { fps, fires: r.clap };
  });
  // Frame rate with landmark smoothing OFF, to separate the smoother's per-call ALPHA from
  // the clap detector itself.
  report.gestures.clap.fpsSmoothingOff = [8, 10, 12, 15].map((fps) => {
    const r = runTrial({ motion: (u) => MOTIONS.clap.motion(u), durationS: 0.2, channels: ['clap'], fps, smoothing: false });
    const on = runTrial({ motion: (u) => MOTIONS.clap.motion(u), durationS: 0.2, channels: ['clap'], fps });
    return { fps, smoothingOn: on.clap, smoothingOff: r.clap };
  });
}

// False-fire probes, everything armed, realistic jitter, momentum ON (normal use)
for (const [name, N] of Object.entries(NULLS)) {
  const r = runTrial({ motion: N.motion, durationS: N.durationS, jitter: 0.002, momentum: true, startScale: 1 });
  const f = fired(r);
  report.nulls[name] = { expect: N.expect, fired: f, unexpected: f.filter((k) => !N.expect.includes(k)),
    magnitudes: Object.fromEntries(Object.keys(FIRE).map((k) => [k, mag[k](r)])) };
}

// Stationary drift vs jitter level (everything armed, momentum on)
for (const jit of [0.002, 0.004, 0.008, 0.012]) {
  const still = { fist: NULLS['still fist (3s)'], 'two open': NULLS['still two open hands (3s)'], 'two pinch': NULLS['still two pinches (3s)'] };
  report.jitter[jit] = Object.fromEntries(Object.entries(still).map(([k, N]) => {
    const r = runTrial({ motion: N.motion, durationS: 3, jitter: jit, momentum: true, startScale: 1 });
    return [k, { fired: fired(r), drift: Object.fromEntries(Object.keys(FIRE).map((c) => [c, mag[c](r)])) }];
  }));
}

// ---- markdown -------------------------------------------------------------------------
const yes = (b) => (b ? 'yes' : '**no**');
const md = [];
md.push('# Gesture lab report (synthetic)', '');
md.push(`Code: **${report.code}**. Generated ${report.generated} by \`docs/lab/gestures/gesture-lab.html\`. Synthetic hands through the shipped pipeline (smoothLandmarks → pinch/isFistLike → manipulator.update), aspect ${ASPECT}, triggerFrames 3, sensitivity 1. **Not a webcam** — see the gesture-tester skill.`, '');
md.push('"Fires" = visible effect: move >1cm lateral, push >1cm depth, spin/tilt >2°, scale >3% uniform, explode >3% stretch, clap = exact reset.', '');
md.push('## Summary', '', '| gesture | canonical motion | isolated | all armed: also fired (bleed) | slowest duration that fires | smallest amplitude that fires | fps 10→60 |', '|---|---|---|---|---|---|---|');
for (const [name, g] of Object.entries(report.gestures)) {
  const slow = [...g.speed].reverse().find((s) => s.fires);
  const small = g.amplitude.find((a) => a.fires);
  const fastFail = g.speed.filter((s) => !s.fires && s.durationS < 0.5).map((s) => `${s.durationS}s`);
  md.push(`| ${name} | ${g.desc} | ${g.isolated.fires ? g.isolated.magnitude : '**no**'} | ${g.bleed.length ? g.bleed.map((k) => `${k} ${g.allArmed.magnitudes[k]}`).join(', ') : '—'}${g.allArmed.fired.includes(name) ? '' : ' · **own channel did not fire**'} | ${slow ? `${slow.durationS}s` : 'none'}${fastFail.length ? ` (fails fast: ${fastFail.join(', ')})` : ''} | ${small ? `${Math.round(small.fraction * 100)}%` : 'none'} | ${g.fps.map((f) => f.magnitude).join(' / ')} |`);
}
md.push('');
for (const [name, g] of Object.entries(report.gestures)) {
  md.push(`## ${name}`, '', `Motion: ${g.desc}. Isolated: ${g.isolated.fires ? `fires (${g.isolated.magnitude}${g.isolated.latencyMs ? `, first active ${g.isolated.latencyMs}ms` : ''})` : '**does not fire**'}. All armed: ${g.allArmed.fired.join(', ') || 'nothing'}; modes ${JSON.stringify(g.allArmed.modes)}.`, '');
  md.push(`- speed (same amplitude): ${g.speed.map((s) => `${s.durationS}s ${s.fires ? s.magnitude : '✗'}`).join(' · ')}`);
  md.push(`- amplitude (canonical speed): ${g.amplitude.map((a) => `${Math.round(a.fraction * 100)}% ${a.fires ? a.magnitude : '✗'}`).join(' · ')}`);
  md.push(`- frame rate: ${g.fps.map((f) => `${f.fps}fps ${f.fires ? f.magnitude : '✗'}`).join(' · ')}`);
  md.push(`- jitter: ${g.jitter.map((j) => `${j.jitter} ${j.fires ? j.magnitude : '✗'}`).join(' · ')}`);
  md.push(`- landmark smoothing off: ${g.smoothingOff.fires ? g.smoothingOff.magnitude : '✗'}`);
  if (g.startSeparation) md.push(`- clap arming (start separation → fires): ${g.startSeparation.map((s) => `${s.startSep} ${s.fires ? '✓' : '✗'}`).join(' · ')}`);
  if (g.fpsSmoothingOff) md.push(`- clap vs frame rate, smoothing on / off: ${g.fpsSmoothingOff.map((s) => `${s.fps}fps ${s.smoothingOn ? '✓' : '✗'}/${s.smoothingOff ? '✓' : '✗'}`).join(' · ')}`);
  if (g.glitchedFrame) md.push(`- one pinch-glitched frame mid-clap: ${g.glitchedFrame.map((s) => `${s.fps}fps ${s.fires ? '✓' : '✗'}`).join(' · ')}`);
  md.push('');
}
md.push('## False-fire probes (everything armed, jitter 0.002, momentum on)', '', '| motion | expected | fired | unexpected |', '|---|---|---|---|');
for (const [name, n] of Object.entries(report.nulls)) {
  md.push(`| ${name} | ${n.expect.join(', ') || '—'} | ${n.fired.map((k) => `${k} ${n.magnitudes[k]}`).join(', ') || '—'} | ${n.unexpected.length ? `**${n.unexpected.join(', ')}**` : '—'} |`);
}
md.push('', '## Stationary drift vs jitter (3s still, everything armed, momentum on)', '', '| jitter | still fist | two open | two pinch |', '|---|---|---|---|');
for (const [jit, row] of Object.entries(report.jitter)) {
  md.push(`| ${jit} | ${['fist', 'two open', 'two pinch'].map((k) => row[k].fired.map((c) => `${c} ${row[k].drift[c]}`).join(', ') || 'still').join(' | ')} |`);
}
md.push('');

window.__gestureReport = report;
window.__gestureReportMd = md.join('\n');
document.getElementById('status').textContent = 'done';
document.getElementById('out').textContent = window.__gestureReportMd;

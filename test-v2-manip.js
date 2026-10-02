// Hands v2 two-hand manipulation checks (manipulator.js with { v2: true }): quaternion tilt with
// ratchet and flick, horizontal/vertical scale, explode/assemble, clap. Plans:
// plans/hands-v2/CONTRACT.md §3.3-3.4, Ricky's report §5-6, owner decisions 2026-10-02.
//
// CONTRACT
//   run(check) -> Promise<{ passed, failed }>
//     check(name, pass, detail): one result row (test.js checkTrue has this shape). Needs the
//     page's three.js import map (test.html); the overseer wires it in.
//
// Hands are synthetic. Image landmarks: wrist 0, index MCP 5, middle MCP 9, pinky MCP 17 (what
// span/palm/twist read), palm length 0.12. World landmarks: a flat canonical right hand (metres,
// MediaPipe axes: y down, z away from the camera) rotated by a chosen quaternion, so the palm
// frame's change since engage is exactly that rotation. Pose verdicts come from the MediaPipe
// label (Closed_Fist / Open_Palm) and hand.pinch, so these checks test the manipulator, not the
// classifier. 30 fps camera frames.

const V = typeof location !== 'undefined' ? `?v=${Date.now()}` : '';
const ASPECT = 16 / 9;
const DT = 1000 / 30;
const DEG = Math.PI / 180;

// Canonical right hand, palm plane z = 0, fingers up (-y). Exported for platform/hands-test.js
// (its v2 clap needs world landmarks with the palms facing each other).
export const CANON = [
  [0, 0, 0], [0.025, -0.02, 0], [0.04, -0.04, 0], [0.05, -0.06, 0], [0.06, -0.075, 0],
  [0.03, -0.085, 0], [0.032, -0.12, 0], [0.033, -0.145, 0], [0.034, -0.165, 0],
  [0.008, -0.09, 0], [0.008, -0.13, 0], [0.008, -0.155, 0], [0.008, -0.18, 0],
  [-0.012, -0.085, 0], [-0.013, -0.12, 0], [-0.014, -0.145, 0], [-0.015, -0.165, 0],
  [-0.03, -0.075, 0], [-0.032, -0.1, 0], [-0.033, -0.12, 0], [-0.034, -0.135, 0]
];

export async function run(check) {
  const THREE = await import('three');
  const M = await import(`./manipulator.js${V}`);
  const { createHandFeatures } = await import(`./handFeatures.js${V}`);
  const { createManipulator, MODE, tiltBoost, mpToView, palmFrameFromWorld } = M;

  let passed = 0;
  let failed = 0;
  const ok = (name, pass, detail = '') => { check(name, !!pass, detail); pass ? passed++ : failed++; };
  const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  // q: THREE.Quaternion in MediaPipe world axes; mirror: left-hand geometry (x -> -x).
  function world(q, { mirror = false, jitter = 0 } = {}) {
    const v = new THREE.Vector3();
    return CANON.map(([x, y, z]) => {
      v.set(mirror ? -x : x, y, z).applyQuaternion(q);
      const j = () => (jitter ? (rnd() - 0.5) * 2 * jitter : 0);
      return { x: v.x + j(), y: v.y + j(), z: v.z + j() };
    });
  }
  function image(x, y, palm = 0.12) {
    const lm = [];
    for (let i = 0; i < 21; i++) lm.push({ x, y: y - 0.05, z: 0 });
    lm[0] = { x, y, z: 0 };
    lm[9] = { x, y: y - palm, z: 0 };
    lm[5] = { x: x + 0.05, y: y - 0.08, z: 0 };
    lm[17] = { x: x - 0.05, y: y - 0.08, z: 0 };
    return lm;
  }
  // kind: 'fist' | 'open' | 'pinch'
  function hand(x, y, kind, { q = new THREE.Quaternion(), label = 'Right', mirror = false, jitter = 0 } = {}) {
    return {
      gesture: kind === 'fist' ? 'Closed_Fist' : 'Open_Palm',
      score: 0.9,
      handedness: label,
      landmarks: image(x, y),
      worldLandmarks: world(q, { mirror, jitter }),
      pinch: { pinching: kind === 'pinch' },
      fistLike: kind === 'fist'
    };
  }
  const qAxis = (ax, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...ax).normalize(), deg * DEG);
  const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));

  const camera = new THREE.PerspectiveCamera(50, ASPECT, 0.1, 100);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const box = () => new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), new THREE.MeshBasicMaterial());
  function parts3() {
    const g = new THREE.Group();
    [[-0.4, 0, 0], [0.4, 0, 0], [0, 0.4, 0]].forEach((p) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial());
      m.position.set(...p);
      g.add(m);
    });
    return g;
  }

  // Runs frames; framesFn(i, n) -> hands. Returns the time after the last frame.
  let frameDt = DT;   // camera frame interval (the low-fps clap checks change it)
  function drive(m, t, n, framesFn) {
    for (let i = 0; i < n; i++) { m.update(framesFn(i, n), ASPECT, t); t += frameDt; }
    return t;
  }
  const FIST = () => hand(0.35, 0.6, 'fist');
  // Grab with the fist, second hand open at identity, then turn the second hand to R over
  // rampFrames, then hold holdFrames. Returns { m, obj, t }.
  function tiltRun(R, { rampFrames = 15, holdFrames = 45, label = 'Right', mirror = false, jitter = 0, v2 = true } = {}) {
    const obj = box();
    const m = createManipulator(obj, camera, { v2 });
    let t = 1000;
    t = drive(m, t, 10, () => [FIST(), hand(0.65, 0.6, 'open', { label, mirror })]);
    const I = new THREE.Quaternion();
    t = drive(m, t, rampFrames, (i, n) => [FIST(), hand(0.65, 0.6, 'open', { q: I.clone().slerp(R, (i + 1) / n), label, mirror, jitter })]);
    t = drive(m, t, holdFrames, () => [FIST(), hand(0.65, 0.6, 'open', { q: R, label, mirror, jitter })]);
    return { m, obj, t };
  }
  const expectedTilt = (R) => {
    const { axis, angle } = (() => {
      const v = mpToView(R);
      const s = Math.hypot(v.x, v.y, v.z);
      return { axis: new THREE.Vector3(v.x / s, v.y / s, v.z / s), angle: 2 * Math.atan2(s, v.w) };
    })();
    return new THREE.Quaternion().setFromAxisAngle(axis, tiltBoost(angle));
  };

  // ---- 1. Tilt follows any axis, x1.5 past the knee ----------------------------------------
  for (const [name, ax] of [['x (pitch)', [1, 0, 0]], ['y (yaw)', [0, 1, 0]], ['z (roll)', [0, 0, 1]], ['diagonal', [1, 1, 1]]]) {
    const R = qAxis(ax, 40);
    const { m, obj } = tiltRun(R);
    const err = angleBetween(obj.quaternion, expectedTilt(R)) / DEG;
    ok(`tilt v2: ${name} 40° hand -> boosted model turn`, m.mode === MODE.GRAB && err < 0.5,
      `mode ${m.mode}, model ${f2(angleBetween(obj.quaternion, new THREE.Quaternion()) / DEG)}° (want ${f2(tiltBoost(40 * DEG) / DEG)}°), err ${f2(err)}°`);
  }
  {
    const a = tiltRun(qAxis([0, 1, 0], 30)).obj.quaternion;
    const b = tiltRun(qAxis([0, 1, 0], 50)).obj.quaternion;
    const slope = (angleBetween(b, new THREE.Quaternion()) - angleBetween(a, new THREE.Quaternion())) / (20 * DEG);
    ok('tilt v2: gain 1.5 past 8° (30°->50° hand)', Math.abs(slope - 1.5) < 0.02, `slope ${f2(slope)}`);
    const small = tiltRun(qAxis([0, 1, 0], 3)).obj.quaternion;
    ok('tilt v2: 3° hand turn inside the 4° dead-zone -> no turn', angleBetween(small, new THREE.Quaternion()) < 1e-6,
      `${f2(angleBetween(small, new THREE.Quaternion()) / DEG)}°`);
  }
  // Stops when still; no drift with tracking noise.
  {
    const R = qAxis([0, 1, 0], 40);
    const { m, obj, t } = tiltRun(R);
    const q1 = obj.quaternion.clone();
    drive(m, t, 15, () => [FIST(), hand(0.65, 0.6, 'open', { q: R })]);
    const moved = angleBetween(q1, obj.quaternion) / DEG;
    ok('tilt v2: still hand -> model still (0.5 s)', moved < 0.01, `moved ${moved.toFixed(4)}°`);
    const n = tiltRun(R, { holdFrames: 90, jitter: 0.0008 });
    const err = angleBetween(n.obj.quaternion, expectedTilt(R)) / DEG;
    ok('tilt v2: 0.8 mm landmark noise for 3 s -> no drift', err < 1.5, `err ${f2(err)}°`);
  }
  // Pitch: fingers tip toward the camera (-z MediaPipe) -> model top tips INTO the screen.
  {
    const { obj } = tiltRun(qAxis([1, 0, 0], 30));
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(obj.quaternion);
    ok('tilt v2: mapping convention (fingers to screen -> top into screen; live check)', up.z < -0.3, `up.z ${f2(up.z)}`);
    const big = tiltRun(qAxis([1, 0, 0], 75)).obj.quaternion;
    const upB = new THREE.Vector3(0, 1, 0).applyQuaternion(big);
    const pitch = Math.asin(Math.abs(upB.z)) / DEG;
    ok('tilt v2: soft pitch limit (75° hand would be 104°)', pitch < 80 && pitch > 60, `pitch ${f2(pitch)}°`);
    const yaw = tiltRun(qAxis([0, 1, 0], 100)).obj.quaternion;
    ok('tilt v2: yaw unlimited (100° hand -> 142°)', Math.abs(angleBetween(yaw, new THREE.Quaternion()) / DEG - tiltBoost(100 * DEG) / DEG) < 0.5,
      `${f2(angleBetween(yaw, new THREE.Quaternion()) / DEG)}°`);
  }
  // Handedness / mirror invariance: label swap and left-hand geometry give the same turn.
  {
    const R = qAxis([1, 2, 0.5], 35);
    const base = tiltRun(R).obj.quaternion;
    const swapped = tiltRun(R, { label: 'Left' }).obj.quaternion;
    const mirrored = tiltRun(R, { label: 'Left', mirror: true }).obj.quaternion;
    ok('tilt v2: handedness label swap -> identical turn', angleBetween(base, swapped) < 1e-6, `${(angleBetween(base, swapped) / DEG).toExponential(1)}°`);
    ok('tilt v2: left-hand (mirrored) geometry -> same turn', angleBetween(base, mirrored) / DEG < 0.01, `${(angleBetween(base, mirrored) / DEG).toExponential(1)}°`);
  }
  // hand.f (handFeatures.js) frame == local helper frame.
  {
    const hf = createHandFeatures({ aspect: ASPECT });
    const h = hand(0.65, 0.6, 'open', { q: qAxis([1, 1, 0], 33) });
    hf.update([h], 1000, { aspect: ASPECT });
    const a = new THREE.Quaternion(...h.f.frame.q);
    const b = palmFrameFromWorld(h.worldLandmarks).q;
    ok('tilt v2: hand.f.frame.q matches the local palm-frame helper', angleBetween(a, b) < 1e-6, `${(angleBetween(a, b) / DEG).toExponential(1)}°`);
  }

  // Tracking glitches (Debbie break-it 2026-10-02, B1/B1b/B2): one bad palm fit must not turn,
  // twitch or flick the model, including the distorted last frame of a hand leaving the view.
  {
    const glitchRun = (deg, thenGone) => {
      const obj = box();
      const m = createManipulator(obj, camera, { v2: true });
      let t = drive(m, 1000, 30, () => [FIST(), hand(0.65, 0.6, 'open')]);
      t = drive(m, t, 1, () => [FIST(), hand(0.65, 0.6, 'open', { q: qAxis([0, 0, 1], deg) })]);
      let peak = angleBetween(obj.quaternion, new THREE.Quaternion());
      for (let i = 0; i < 60; i++) {
        m.update(thenGone ? [FIST()] : [FIST(), hand(0.65, 0.6, 'open')], ASPECT, t);
        t += DT;
        peak = Math.max(peak, angleBetween(obj.quaternion, new THREE.Quaternion()));
      }
      return { peak: peak / DEG, end: angleBetween(obj.quaternion, new THREE.Quaternion()) / DEG };
    };
    for (const deg of [25, 45, 180]) {
      const g = glitchRun(deg, true);
      ok(`tilt v2: ${deg}° glitch on the leaving frame -> no turn, no flick`, g.end < 0.5, `end ${f2(g.end)}°`);
    }
    const stay = glitchRun(25, false);
    ok('tilt v2: 25° one-frame glitch, hand stays -> twitch < 8°', stay.peak < 8 && stay.end < 0.01, `peak ${f2(stay.peak)}°, end ${f2(stay.end)}°`);
  }

  // ---- 2. Ratchet --------------------------------------------------------------------------
  {
    const R = qAxis([0, 1, 0], 30);
    const run0 = tiltRun(R);
    const { m, obj } = run0;
    let t = run0.t;
    // Close the second hand, turn it back to identity while closed, open, turn 30° again.
    t = drive(m, t, 6, () => [FIST(), hand(0.65, 0.6, 'fist', { q: R })]);
    const I = new THREE.Quaternion();
    t = drive(m, t, 10, (i, n) => [FIST(), hand(0.65, 0.6, 'fist', { q: R.clone().slerp(I, (i + 1) / n) })]);
    const during = obj.quaternion.clone();
    t = drive(m, t, 6, () => [FIST(), hand(0.65, 0.6, 'open', { q: I })]);
    t = drive(m, t, 15, (i, n) => [FIST(), hand(0.65, 0.6, 'open', { q: I.clone().slerp(R, (i + 1) / n) })]);
    t = drive(m, t, 45, () => [FIST(), hand(0.65, 0.6, 'open', { q: R })]);
    const want = 2 * tiltBoost(30 * DEG) / DEG;
    const got = angleBetween(obj.quaternion, new THREE.Quaternion()) / DEG;
    ok('tilt v2: ratchet (turn, close+return, open+turn) adds up', Math.abs(got - want) < 0.5 && m.mode === MODE.GRAB, `${f2(got)}° want ${f2(want)}°`);
    ok('tilt v2: returning the closed hand does not turn the model back',
      angleBetween(during, new THREE.Quaternion()) / DEG > tiltBoost(30 * DEG) / DEG - 0.5, `${f2(angleBetween(during, new THREE.Quaternion()) / DEG)}°`);
  }

  // ---- 3. Flick ----------------------------------------------------------------------------
  function flickRun() {
    const obj = box();
    const m = createManipulator(obj, camera, { v2: true });
    let t = 1000;
    t = drive(m, t, 10, () => [FIST(), hand(0.65, 0.6, 'open')]);
    const R = qAxis([0, 1, 0], 60);
    const I = new THREE.Quaternion();
    t = drive(m, t, 4, (i, n) => [FIST(), hand(0.65, 0.6, 'open', { q: I.clone().slerp(R, (i + 1) / n) })]);
    return { m, obj, t };
  }
  {
    const fr = flickRun();
    let t = fr.t;
    // Release: the second hand leaves.
    const qs = [];
    for (let i = 0; i < 120; i++) { fr.m.update([FIST()], ASPECT, t); qs.push(fr.obj.quaternion.clone()); t += DT; }
    const w = (i) => angleBetween(qs[i], qs[i + 3]) / (3 * DT / 1000);
    ok('flick v2: fast twist + release keeps turning', w(6) > 1.0, `${f2(w(6))} rad/s just after release`);
    ok('flick v2: coast decays', w(45) < w(6) * 0.5 && w(45) > 0, `${f2(w(6))} -> ${f2(w(45))} rad/s`);
    ok('flick v2: coast stops', qs[116].equals(qs[119]), `last 0.1 s ${(angleBetween(qs[116], qs[119]) / DEG).toExponential(1)}°`);
  }
  {
    // A new grab stops a flick at once.
    const fr = flickRun();
    let t = fr.t;
    t = drive(fr.m, t, 3, () => []);           // let go of everything: flick coasts
    t = drive(fr.m, t, 12, () => []);          // grab mode exits, neutral
    const before = fr.obj.quaternion.clone();
    t = drive(fr.m, t, 3, () => [FIST()]);     // grab again
    const q1 = fr.obj.quaternion.clone();
    t = drive(fr.m, t, 6, () => [FIST()]);
    ok('flick v2: grabbing again stops it', q1.equals(fr.obj.quaternion) && angleBetween(before, q1) > 0,
      `turn after re-grab ${(angleBetween(q1, fr.obj.quaternion) / DEG).toExponential(1)}°`);
  }
  {
    // A slow turn then release does not coast.
    const obj = box();
    const m = createManipulator(obj, camera, { v2: true });
    let t = drive(m, 1000, 10, () => [FIST(), hand(0.65, 0.6, 'open')]);
    const R = qAxis([0, 1, 0], 20);
    t = drive(m, t, 30, (i, n) => [FIST(), hand(0.65, 0.6, 'open', { q: new THREE.Quaternion().slerp(R, (i + 1) / n) })]);
    t = drive(m, t, 30, () => [FIST(), hand(0.65, 0.6, 'open', { q: R })]);
    t = drive(m, t, 30, () => [FIST()]);
    const q1 = obj.quaternion.clone();
    drive(m, t, 15, () => [FIST()]);
    ok('flick v2: slow turn + release -> no coast', q1.equals(obj.quaternion), `${(angleBetween(q1, obj.quaternion) / DEG).toExponential(1)}°`);
  }

  // ---- 4. Scale: horizontal uniform, vertical height-only ------------------------------------
  {
    const obj = box();
    const m = createManipulator(obj, camera, { v2: true });
    // Stacked hands (x equal), spread vertically 0.18 -> 0.36 apart.
    let t = drive(m, 1000, 10, () => [hand(0.5, 0.41, 'pinch'), hand(0.5, 0.59, 'pinch', { label: 'Left' })]);
    t = drive(m, t, 20, (i, n) => { const d = 0.09 + 0.09 * (i + 1) / n; return [hand(0.5, 0.5 - d, 'pinch'), hand(0.5, 0.5 + d, 'pinch', { label: 'Left' })]; });
    t = drive(m, t, 20, () => [hand(0.5, 0.32, 'pinch'), hand(0.5, 0.68, 'pinch', { label: 'Left' })]);
    const s = obj.scale;
    ok('scale v2: vertical spread -> height only', m.mode === MODE.TRANSFORM && s.y > 1.5 && s.x === 1 && s.z === 1, `scale ${f2(s.x)}, ${f2(s.y)}, ${f2(s.z)}`);
    const h = m.height;
    ok('scale v2: height readout follows the stretch', Math.abs(h.stretch - s.y) < 1e-9 && Math.abs(h.world - 0.6 * s.y) < 1e-6, `stretch ${f2(h.stretch)}, height ${f2(h.world)}`);
  }
  {
    const obj = box();
    const m = createManipulator(obj, camera, { v2: true });
    let t = drive(m, 1000, 10, () => [hand(0.4, 0.6, 'pinch'), hand(0.6, 0.6, 'pinch', { label: 'Left' })]);
    t = drive(m, t, 20, (i, n) => { const d = 0.1 + 0.1 * (i + 1) / n; return [hand(0.5 - d, 0.6, 'pinch'), hand(0.5 + d, 0.6, 'pinch', { label: 'Left' })]; });
    drive(m, t, 20, () => [hand(0.3, 0.6, 'pinch'), hand(0.7, 0.6, 'pinch', { label: 'Left' })]);
    const s = obj.scale;
    ok('scale v2: horizontal spread -> uniform size', s.x > 1.5 && Math.abs(s.x - s.y) < 1e-9 && Math.abs(s.x - s.z) < 1e-9, `scale ${f2(s.x)}, ${f2(s.y)}, ${f2(s.z)}`);
  }
  {
    // Sticky: starts stacked (vertical), then the hands swing to side by side while spreading.
    const obj = box();
    const m = createManipulator(obj, camera, { v2: true });
    let t = drive(m, 1000, 10, () => [hand(0.5, 0.41, 'pinch'), hand(0.5, 0.59, 'pinch', { label: 'Left' })]);
    drive(m, t, 30, (i, n) => {
      const k = (i + 1) / n; const ang = (90 - 80 * k) * DEG; const r = 0.09 + 0.12 * k;
      return [hand(0.5 - r * Math.cos(ang) / ASPECT, 0.5 - r * Math.sin(ang), 'pinch'), hand(0.5 + r * Math.cos(ang) / ASPECT, 0.5 + r * Math.sin(ang), 'pinch', { label: 'Left' })];
    });
    ok('scale v2: vertical choice is sticky for the gesture', obj.scale.x === 1 && obj.scale.y > 1.2, `scale ${f2(obj.scale.x)}, ${f2(obj.scale.y)}`);
  }

  // ---- 5. Explode / assemble ---------------------------------------------------------------
  // Open hands at y 0.6, centred at x 0.5, `span` palms apart (palm 0.12, aspect-corrected).
  const dOf = (span) => (span * 0.12) / ASPECT / 2;
  const facingQ = (side) => qAxis([0, 1, 0], side * 90); // palms toward each other when sides are +1 / -1
  function pair(span, { kind = 'open', facing = false } = {}) {
    const d = dOf(span);
    return [
      hand(0.5 - d, 0.6, kind, { label: 'Right', q: facing ? facingQ(1) : new THREE.Quaternion() }),
      hand(0.5 + d, 0.6, kind, { label: 'Left', mirror: true, q: facing ? facingQ(-1) : new THREE.Quaternion() })
    ];
  }
  const ramp = (m, t, from, to, frames, opts) => drive(m, t, frames, (i, n) => pair(from + (to - from) * (i + 1) / n, opts));
  function exploded() {
    const obj = parts3();
    const m = createManipulator(obj, camera, { v2: true });
    let t = drive(m, 1000, 6, () => pair(2));
    t = ramp(m, t, 2, 5.5, 15);
    t = drive(m, t, 15, () => pair(5.5));
    return { obj, m, t };
  }
  {
    const { obj, m } = exploded();
    ok('explode v2: spreading open hands explodes fully', Math.abs(m.explodeAmount - 1) < 1e-6 && m.resetCount === 0, `amount ${f2(m.explodeAmount)}`);
  }
  {
    // Explode tail (test.js 'part B (not selected) does not move' under ?hands=v2): the absolute
    // command sits exactly at 1, so the follow spring's last µm used to keep every part creeping
    // for ~10 frames after the hands left (4.1 µm). Hands down = bit-still, amount exactly 1.
    let { m, t } = exploded();
    const before = m.parts.map((p) => p.position.clone());
    t = drive(m, t, 30, () => []);
    const moved = Math.max(...m.parts.map((p, i) => p.position.distanceTo(before[i])));
    ok('explode v2: hands down after a full explode -> parts bit-still, amount exactly 1', moved === 0 && m.explodeAmount === 1, `moved ${moved.toExponential(1)} m, amount 1-${(1 - m.explodeAmount).toExponential(1)}`);
  }
  {
    // Slow close with an edit kept.
    let { obj, m, t } = exploded();
    t = drive(m, t, 25, () => []); // hands down: session ends
    const undoAfterExplode = m.canUndo;
    const part = m.parts[0];
    const home0 = part.userData.explodeHome.clone();
    part.position.x += 0.2; // the edit (as a part grab would leave it)
    part.rotateY(0.5);
    const editQ = part.quaternion.clone();
    t = drive(m, t, 4, () => pair(5.5));
    t = ramp(m, t, 5.5, 1.9, 90); // 3 s slow close
    t = drive(m, t, 30, () => pair(1.9));
    const off = part.position.clone().sub(home0);
    ok('assemble v2: slow close -> explode 0', m.explodeAmount < 1e-9 && m.resetCount === 0, `amount ${f2(m.explodeAmount)}, resets ${m.resetCount}`);
    ok('assemble v2: part edits kept', Math.abs(off.x - 0.2) < 1e-6 && Math.abs(off.y) < 1e-6 && Math.abs(off.z) < 1e-6 && part.quaternion.equals(editQ),
      `offset ${f2(off.x)}, ${f2(off.y)}, ${f2(off.z)}, rot diff ${(angleBetween(part.quaternion, editQ) / DEG).toExponential(1)}°`);
    const others = m.parts.slice(1).every((p) => p.position.distanceTo(p.userData.explodeHome) < 1e-6);
    ok('assemble v2: unedited parts back home', others);
    t = drive(m, t, 25, () => []);
    ok('explode/assemble v2: each session is undoable', undoAfterExplode && m.canUndo && m.undo() && Math.abs(m.explodeAmount - 1) < 1e-6,
      `after undo amount ${f2(m.explodeAmount)}`);
    // Re-explode after assembling counts from the new start (both directions, no "pulled" flag).
    t = drive(m, t, 25, () => []);
    m.setExplode(0);
    t = drive(m, t, 6, () => pair(1.5));
    t = ramp(m, t, 1.5, 2.4, 20);
    t = drive(m, t, 10, () => pair(2.4));
    const half = m.explodeAmount;
    t = ramp(m, t, 2.4, 1.5, 30);
    t = drive(m, t, 30, () => pair(1.5));
    ok('explode v2: f(span/span0) both ways in one gesture', half > 0.3 && half < 0.9 && m.explodeAmount < 1e-9, `${f2(half)} -> ${f2(m.explodeAmount)}`);
  }
  {
    // Clap during explode -> original parts; view kept; undoable.
    let { obj, m, t } = exploded();
    obj.position.x = 0.3;
    const part = m.parts[1];
    part.position.y += 0.15;
    part.rotateX(0.7);
    t = drive(m, t, 6, () => pair(5.5, { facing: true }));
    t = ramp(m, t, 5.5, 0.9, 5, { facing: true });
    t = drive(m, t, 2, () => pair(0.9, { facing: true }));
    const home = m.parts.every((p) => p.position.distanceTo(p.userData.explodeHome) < 1e-9 && angleBetween(p.quaternion, p.userData.explodeHomeQuaternion) < 1e-9);
    ok('clap v2 during explode -> original parts', m.resetCount === 1 && m.explodeAmount === 0 && home, `resets ${m.resetCount}, amount ${f2(m.explodeAmount)}, parts home ${home}`);
    ok('clap v2 during explode keeps the view', obj.position.x === 0.3, `x ${f2(obj.position.x)}`);
    const undone = m.undo();
    ok('clap v2 during explode is undoable (edit back)', undone && Math.abs(part.position.y - (part.userData.explodeHome.y + part.userData.explodeDir.y * 0.6 * m.explodeAmount + 0.15)) < 1e-6 && m.explodeAmount > 0,
      `amount ${f2(m.explodeAmount)}`);
  }

  // ---- 6. Clap -----------------------------------------------------------------------------
  function clapRun(script, { obj = box() } = {}) {
    const m = createManipulator(obj, camera, { v2: true });
    obj.position.x = 0.4;
    let t = 1000;
    for (const step of script) t = step(m, t);
    return { m, obj };
  }
  const hold = (span, frames, opts) => (m, t) => drive(m, t, frames, () => pair(span, opts));
  const go = (from, to, frames, opts) => (m, t) => ramp(m, t, from, to, frames, opts);
  const none = (frames) => (m, t) => drive(m, t, frames, () => []);
  const F = { facing: true };
  {
    const slow = clapRun([hold(2.5, 6, F), go(2.5, 1.0, 27, F), hold(1.0, 3, F)]);
    ok('clap v2: slow clap (1.6 palms/s) fires', slow.m.resetCount === 1 && slow.obj.position.x === 0, `resets ${slow.m.resetCount}`);
    const fast = clapRun([hold(5, 6, F), go(5, 0.9, 5, F), hold(0.9, 2, F)]);
    ok('clap v2: fast clap (25 palms/s) fires', fast.m.resetCount === 1, `resets ${fast.m.resetCount}`);
    const merge = clapRun([hold(5, 6, F), go(5, 1.8, 4, F), (m, t) => drive(m, t, 2, () => [pair(1.8, F)[0]])]);
    ok('clap v2: one hand lost at contact (merge) fires', merge.m.resetCount === 1, `resets ${merge.m.resetCount}`);
    const parts = clapRun([hold(2.5, 6, F), go(2.5, 1.0, 10, F), hold(1.0, 3, F)], { obj: parts3() });
    ok('clap v2: not exploded -> reset view (multi-part model)', parts.m.resetCount === 1 && parts.obj.position.x === 0, `x ${f2(parts.obj.position.x)}`);
  }
  {
    const d2 = (n) => (m, t) => drive(m, t, n, () => [pair(2, F)[0]]); // n frames with one hand
    const two = clapRun([hold(3, 6, F), go(3, 2.2, 3, F), d2(2), go(2.2, 1.0, 2, F), hold(1.0, 2, F)]);
    ok('clap v2: survives 2 dropped frames', two.m.resetCount === 1, `resets ${two.m.resetCount}`);
    const pin = clapRun([hold(4, 6, F), go(4, 2.0, 3, F), (m, t) => drive(m, t, 1, () => pair(1.8, { kind: 'pinch', facing: true })), go(1.8, 0.9, 3, F), hold(0.9, 2, F)]);
    ok('clap v2: 1-frame pinch misread does not disarm', pin.m.resetCount === 1, `resets ${pin.m.resetCount}`);
    const held = clapRun([hold(4, 6, F), go(4, 0.9, 5, F), hold(0.9, 60, F)]);
    ok('clap v2: hands held together fire once', held.m.resetCount === 1, `resets ${held.m.resetCount}`);
  }
  {
    const camFacing = clapRun([hold(4, 6), go(4, 0.9, 5), hold(0.9, 3)]);
    ok('clap v2: palms facing the camera never clap', camFacing.m.resetCount === 0, `resets ${camFacing.m.resetCount}`);
    const spread = clapRun([hold(1.0, 6, F), go(1.0, 6, 12, F), hold(6, 10, F)], { obj: parts3() });
    ok('clap v2: explode spread (palms facing) does not clap', spread.m.resetCount === 0 && spread.m.explodeAmount > 0.9, `resets ${spread.m.resetCount}, amount ${f2(spread.m.explodeAmount)}`);
    const noArm = clapRun([hold(1.9, 10, F), go(1.9, 0.9, 5, F), hold(0.9, 3, F)]);
    ok('clap v2: never apart (< 2 palms) -> no clap', noArm.m.resetCount === 0, `resets ${noArm.m.resetCount}`);
  }
  {
    // Exploded, then a SLOW close with palms facing: assembles, keeps edits, no clap (deviation:
    // CLAP_EXPLODED_MIN_SPEED). A fast one claps.
    let { m, t } = exploded();
    t = drive(m, t, 6, () => pair(5.5, F));
    t = ramp(m, t, 5.5, 1.0, 75, F);
    t = drive(m, t, 30, () => pair(1.0, F));
    ok('clap v2: slow palms-facing close while exploded assembles (no clap)', m.resetCount === 0 && m.explodeAmount < 1e-9, `resets ${m.resetCount}, amount ${f2(m.explodeAmount)}`);
  }

  {
    // Calibration overrides (setThresholds): a higher arm span stops a 2.5-palm slow clap; a speed floor stops a slow one.
    const arm = clapRun([(m, t) => { m.setThresholds({ CLAP_ARM_SPAN: 3 }); return t; }, hold(2.5, 6, F), go(2.5, 1.0, 27, F), hold(1.0, 3, F)]);
    const vmin = clapRun([(m, t) => { m.setThresholds({ CLAP_V_MIN: 4, CLAP_ARM_SPAN: NaN }); return t; }, hold(2.5, 6, F), go(2.5, 1.0, 27, F), hold(1.0, 3, F)]);
    const fastOk = clapRun([(m, t) => { m.setThresholds({ CLAP_V_MIN: 4 }); return t; }, hold(5, 6, F), go(5, 0.9, 5, F), hold(0.9, 2, F)]);
    ok('clap v2: setThresholds overrides (arm span, speed floor; NaN ignored)', arm.m.resetCount === 0 && vmin.m.resetCount === 0 && fastOk.m.resetCount === 1 && vmin.m.setThresholds().CLAP_ARM_SPAN === 2,
      `arm3 ${arm.m.resetCount}, vmin4 slow ${vmin.m.resetCount}, vmin4 fast ${fastOk.m.resetCount}`);
    // Break-it B9: "this big" talking hands (palms facing, 2.2 -> 1.1 palms in 1 s) is no clap with
    // the default speed floor; a calibrated slow clapper (CLAP_V_MIN 0.6) still claps that slowly.
    const talk = clapRun([hold(2.2, 6, F), go(2.2, 1.1, 30, F), hold(1.1, 6, F)]);
    const talkCal = clapRun([(m, t) => { m.setThresholds({ CLAP_V_MIN: 0.6 }); return t; }, hold(2.2, 6, F), go(2.2, 1.1, 30, F), hold(1.1, 6, F)]);
    ok('clap v2: talking hands (1.1 palms/s) do not clap by default; calibrated CLAP_V_MIN 0.6 does', talk.m.resetCount === 0 && talkCal.m.resetCount === 1,
      `default ${talk.m.resetCount}, calibrated ${talkCal.m.resetCount}`);
    // Low camera fps (8-12 fps, a slow laptop): the same slow (0.9 s) and quick (~0.25 s) claps.
    const fpsRes = [];
    for (const fps of [8, 10, 12]) {
      frameDt = 1000 / fps;
      const n = (sec) => Math.max(1, Math.round(sec * fps));
      const sl = clapRun([hold(2.5, n(0.2), F), go(2.5, 1.0, n(0.9), F), hold(1.0, n(0.1) + 1, F)]);
      const qk = clapRun([hold(4, n(0.2), F), go(4, 0.9, n(0.25), F), hold(0.9, 2, F)]);
      fpsRes.push(`${fps}fps slow ${sl.m.resetCount} quick ${qk.m.resetCount}`);
      ok(`clap v2 at ${fps} fps: slow and quick claps each fire once`, sl.m.resetCount === 1 && qk.m.resetCount === 1, fpsRes.at(-1));
    }
    frameDt = DT;
    // Both hands pinching through the whole approach is a two-hand pinch (scale), not a clap.
    const pinchHeld = clapRun([hold(4, 6, { kind: 'pinch', facing: true }), go(4, 0.9, 5, { kind: 'pinch', facing: true }), hold(0.9, 3, { kind: 'pinch', facing: true })]);
    ok('clap v2: pinches held through the approach never clap', pinchHeld.m.resetCount === 0, `resets ${pinchHeld.m.resetCount}`);
  }

  // ---- 6b. snapUpright (hologram Done with no tool) ------------------------------------------
  {
    const obj = box();
    const m = createManipulator(obj, camera, { v2: true });
    const tilted = qAxis([0, 1, 0], 40).multiply(qAxis([1, 0, 0], 30)).multiply(qAxis([0, 0, 1], -20));
    obj.quaternion.copy(tilted); obj.position.set(0.2, -0.1, 0.3); obj.scale.set(1.5, 2, 1.5);
    const pos0 = obj.position.clone(), scl0 = obj.scale.clone();
    // Upright = the SHORTEST turn that stands the model's up axis back on +Y (keeps its facing).
    const Y = new THREE.Vector3(0, 1, 0);
    const want = new THREE.Quaternion().setFromUnitVectors(Y.clone().applyQuaternion(tilted), Y).multiply(tilted);
    const started = m.snapUpright();
    m.tick(5000); m.tick(5200);
    const mid = angleBetween(obj.quaternion, want) / DEG, start = angleBetween(tilted, want) / DEG;
    m.tick(5500);
    const err = angleBetween(obj.quaternion, want) / DEG;
    ok('snapUpright: eases (mid-way at 200 ms), ends upright by the shortest turn (facing kept)', started && mid > 0.5 && mid < start - 0.5 && err < 1e-6 && !m.uprighting,
      `start ${f2(start)}°, 200 ms ${f2(mid)}°, end ${err.toExponential(1)}°`);
    ok('snapUpright: position and scale untouched', obj.position.equals(pos0) && obj.scale.equals(scl0));
    ok('snapUpright: already upright -> false, nothing to undo added', m.snapUpright() === false && m.canUndo);
    ok('snapUpright: undo puts the tilt back', m.undo() && angleBetween(obj.quaternion, tilted) < 1e-9);
    m.snapUpright(); m.tick(6000); m.tick(6100); m.reset();
    const r0 = obj.quaternion.clone(); m.tick(6300); m.tick(7000);
    ok('snapUpright: a reset mid-ease cancels it', !m.uprighting && obj.quaternion.equals(r0));
  }

  // ---- 7. v2 off ignores all of this --------------------------------------------------------
  {
    const R = qAxis([0, 1, 0], 40);
    const { obj } = tiltRun(R, { v2: false });
    ok('v2 off: a still second hand keeps its v1 behaviour (no 3D tilt)', angleBetween(obj.quaternion, expectedTilt(R)) / DEG > 5,
      `${f2(angleBetween(obj.quaternion, new THREE.Quaternion()) / DEG)}°`);
  }
  return { passed, failed };
}

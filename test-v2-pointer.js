// Hands v2 pointer checks (pointer.js createPointerV2, gunPose.js createHammer,
// smoothLandmarks.js rawLandmarks). Plans: plans/hands-v2/CONTRACT.md §3.1-3.2, Ricky's report §1-3.
//
// CONTRACT
//   run(check) -> Promise<{ passed, failed }>
//     check(name, pass, detail): one result row (test.js checkTrue has this shape). The overseer
//     wires this into test.html; it also runs in Node (no DOM, no three.js).
//
// Hands are synthetic: image landmark 5 (index MCP) is the aim point, wrist 0 sits 0.15 image
// units below it (so s = palm metres / 0.15), and world landmarks place the thumb at a chosen
// hammer angle in the palm plane. Pose verdicts are set directly (hand.pointer.gun), so these
// checks test the cursor and the click, not the pose classifier.

const V = typeof location !== 'undefined' ? `?v=${Date.now()}` : '';
const ASPECT = 16 / 9;
const FPS = 50;
const DT = 1000 / FPS;
const PX = 1460 / 2; // NDC x -> px on the 1460-px reference canvas

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// World hand (metres): wrist at the origin, index metacarpal 0->5 up the palm, thumb tip laid in
// the palm plane at `deg` from the metacarpal, rotated away from the fingers.
function worldHand(deg) {
  const w = Array.from({ length: 21 }, (_, i) => ({ x: 0.001 * i, y: 0.05, z: 0.001 }));
  w[0] = { x: 0, y: 0, z: 0 };
  w[5] = { x: 0.03, y: 0.085, z: 0 }; w[6] = { x: 0.03, y: 0.125, z: 0 };
  w[9] = { x: 0.008, y: 0.09, z: 0 };
  w[2] = { x: 0.02, y: 0.03, z: 0 };
  const L = Math.hypot(0.03, 0.085);
  const u = [0.03 / L, 0.085 / L];
  const perp = [u[1], -u[0]];
  const r = (deg * Math.PI) / 180;
  const d = [u[0] * Math.cos(r) + perp[0] * Math.sin(r), u[1] * Math.cos(r) + perp[1] * Math.sin(r)];
  w[4] = { x: 0.02 + d[0] * 0.06, y: 0.03 + d[1] * 0.06, z: 0 };
  w[3] = { x: 0.02 + d[0] * 0.03, y: 0.03 + d[1] * 0.03, z: 0 };
  return w;
}

function hand({ x = 0.5, y = 0.47, jitter = 0, deg = 70, gun = true, f = null, pinching = false } = {}) {
  const j = () => (jitter ? (rnd() - 0.5) * 2 * jitter : 0);
  const ax = x + j();
  const ay = y + j();
  const lm = Array.from({ length: 21 }, () => ({ x: ax, y: ay, z: 0 }));
  lm[0] = { x: ax, y: ay + 0.15, z: 0 };
  const h = { landmarks: lm, worldLandmarks: worldHand(deg), handedness: 'Right', gesture: 'None',
    pointer: { gun }, pinch: { pinching, ratio: pinching ? 0.1 : 0.6 }, engaged: true };
  if (f) h.f = f;
  return h;
}

export { worldHand }; // for the lab's diagnostics

export async function run(check) {
  let passed = 0;
  let failed = 0;
  const ok = (name, pass, detail = '') => { check(name, !!pass, detail); pass ? passed++ : failed++; };
  const ptr = await import(`./pointer.js${V}`);
  const gp = await import(`./gunPose.js${V}`);
  const sm = await import(`./smoothLandmarks.js${V}`);
  const mk = (o = {}) => ptr.createPointer({ v2: true, clickAlt: null, ...o });

  // 1. The switch: off = the v1 object, on = v2.
  ok('v2 off by default in a plain page/Node: createPointer() is v1', ptr.createPointer({ v2: false }).v2 === undefined && mk().v2 === true);

  // 2. Rest jitter: still hand, uniform ±0.002 image units on the raw points (smoothing-lab's figure), 3 s.
  {
    seed = 11;
    const p = mk();
    const xs = [];
    for (let i = 0; i < FPS * 3; i++) {
      p.update([hand({ jitter: 0.002 })], ASPECT, 1000 + i * DT);
      if (i > FPS) xs.push([p.state.x * PX, p.state.y * PX / ASPECT]);
    }
    const mean = xs.reduce((a, v) => [a[0] + v[0] / xs.length, a[1] + v[1] / xs.length], [0, 0]);
    const dev = xs.map((v) => Math.hypot(v[0] - mean[0], v[1] - mean[1])).sort((a, b) => a - b);
    const med = dev[dev.length >> 1];
    ok('rest jitter ≤ 1 px median (1460-px canvas)', med <= 1, `median ${med.toFixed(2)} px, max ${dev[dev.length - 1].toFixed(2)} px`);
  }

  // 3. Latency at slow speed: the filtered cursor vs the same pipeline with the filter wide open.
  const lagAt = (speedImg) => {
    const p = mk();
    const ref = mk({ profile: { cursor: { minCutoff: 1e6, beta: 0 } } });
    let lag = 0, k = 0, prevRef = null;
    const N = Math.round(FPS * Math.min(1.2, 0.12 / speedImg)); // stay off the canvas edge
    for (let i = 0; i < N; i++) {
      const t = 1000 + i * DT;
      const h = hand({ x: 0.4 + speedImg * (i / FPS) });
      p.update([h], ASPECT, t);
      ref.update([hand({ x: 0.4 + speedImg * (i / FPS) })], ASPECT, t);
      const vx = prevRef === null ? 0 : (ref.state.x - prevRef) / DT;
      if (i > N - FPS * 0.1 && Math.abs(vx) > 1e-9) { lag += (ref.state.x - p.state.x) / vx; k++; }
      prevRef = ref.state.x;
    }
    return lag / k;
  };
  const slow = lagAt(0.1);
  const slowMs = 0.1 * ASPECT * (0.085 / 0.15);
  ok('latency at slow speed ≤ 40 ms', slow <= 40, `${slow.toFixed(1)} ms at 0.1 image/s (≈${(slowMs * 100).toFixed(0)} cm/s); 0.3/s: ${lagAt(0.3).toFixed(1)} ms`);

  // 4. Speed gain: the same 10 cm (image) move, fast vs slow, lands far vs short.
  const travel = (secs) => {
    const p = mk();
    const N = Math.round(FPS * secs);
    p.update([hand({ x: 0.45 })], ASPECT, 1000);
    const x0 = p.state.x;
    for (let i = 1; i <= N + FPS / 2; i++) {
      const k = Math.min(1, i / N);
      const e = k * k * (3 - 2 * k);
      p.update([hand({ x: 0.45 + 0.1 * e })], ASPECT, 1000 + i * DT);
    }
    return Math.abs(p.state.x - x0) * PX;
  };
  const fast = travel(0.3), slowT = travel(3);
  ok('sigmoid gain: a fast move travels > 2× a slow one of the same length', fast > 2 * slowT, `fast ${fast.toFixed(0)} px, slow ${slowT.toFixed(0)} px`);
  ok('gain is px/mm in [1.5, 6]', (() => { const p = mk(); p.update([hand()], ASPECT, 0); p.update([hand({ x: 0.52 })], ASPECT, 20); const g = p.state.v2.gain; return g >= 1.5 && g <= 6; })());

  // 5. Absolute anchor: entry lands on the anchor. A slow drift leaves the cursor behind the
  // anchor (gain 1.5-2 px/mm < 5.84); a fast move on in the same direction (toward the anchor,
  // seen from the cursor) closes the offset (PRISM recovery + the higher gain).
  {
    const p = mk();
    let t = 1000;
    p.update([hand({ x: 0.5 })], ASPECT, t);
    const off0 = Math.hypot(...p.state.v2.offsetPx);
    for (let i = 0; i < FPS * 4; i++) p.update([hand({ x: 0.5 + 0.08 * (i / (FPS * 4)) })], ASPECT, (t += DT));
    const offSlow = Math.hypot(...p.state.v2.offsetPx);
    for (let i = 0; i < FPS * 0.25; i++) p.update([hand({ x: 0.58 + 0.06 * ((i + 1) / (FPS * 0.25)) })], ASPECT, (t += DT));
    for (let i = 0; i < 10; i++) p.update([hand({ x: 0.64 })], ASPECT, (t += DT));
    const offBack = Math.hypot(...p.state.v2.offsetPx);
    ok('entry: cursor starts on the absolute anchor', off0 < 1e-6, `offset ${off0.toFixed(3)} px`);
    ok('PRISM: a fast move toward the anchor shrinks the offset', offBack < offSlow * 0.7, `after slow drift ${offSlow.toFixed(0)} px → after a fast move on ${offBack.toFixed(0)} px`);
  }

  // 6. Hammer from hand.f (features path): freeze at onset, click at the drop, rewound.
  {
    const p = mk();
    let t = 1000;
    const F = (state, deg, extra = {}) => ({ thumbGap: deg > 50 ? 0.7 : 0.2, aim: {}, hammer: { angleDeg: deg, state, dropT: null, fallT: null, edge: false, ...extra } });
    for (let i = 0; i < 10; i++) p.update([hand({ x: 0.5, f: F('cocked', 70) })], ASPECT, (t += DT));
    const before = { x: p.state.x, y: p.state.y };
    const onsetT = t;
    // The thumb falls over 3 frames and drags the palm 0.01 image units (~1 cm) sideways.
    p.update([hand({ x: 0.503, f: F('cocked', 45) })], ASPECT, (t += DT));
    const pend = p.state.v2.phase;
    p.update([hand({ x: 0.506, f: F('cocked', 35) })], ASPECT, (t += DT));
    const c = p.update([hand({ x: 0.51, f: F('dropped', 20, { edge: true, dropT: t + DT, fallT: onsetT }) })], ASPECT, (t += DT));
    ok('hammer (hand.f): click fires on the drop frame', c?.via === 'hammer', JSON.stringify(c && { via: c.via }));
    const err = c ? Math.hypot(c.x - before.x, c.y - before.y) * PX : Infinity;
    ok('hammer: cursor frozen from the onset (phase pending)', pend === 'pending', pend);
    ok('hammer: click lands at the pre-onset aim (≤ 1 px)', err <= 1, `${err.toFixed(2)} px from the aim before the thumb moved`);
    // Thumb stays down, hand still: cursor stays on the target.
    p.update([hand({ x: 0.51, f: F('dropped', 20) })], ASPECT, (t += DT));
    ok('hammer: cursor held on the target while the thumb stays down', Math.hypot(p.state.x - c.x, p.state.y - c.y) < 1e-9 && p.state.v2.phase === 'held');
    // Re-cock: eases back to the hand within ~100 ms.
    for (let i = 0; i < 8; i++) p.update([hand({ x: 0.5, f: F('dropped', 70) })], ASPECT, (t += DT));
    ok('hammer: thumb lift eases back to live', p.state.v2.phase === 'live', p.state.v2.phase);
  }

  // 7. Hammer from world landmarks (local fallback, no hand.f).
  const drill = (degs, dtMs = DT) => {
    const p = mk();
    let t = 1000;
    const clicks = [];
    for (const d of degs) { const c = p.update([hand({ deg: d })], ASPECT, (t += dtMs)); if (c) clicks.push(c); }
    return { clicks, p };
  };
  const cocked = Array(10).fill(70);
  {
    const { clicks, p } = drill([...cocked, 50, 25, 10, 10, 10]);
    ok('hammer (local): a quick drop clicks once', clicks.length === 1 && p.state.v2.hammer.source === 'local', `${clicks.length} click(s), source ${p.state.v2.hammer.source}`);
    const again = drill([...cocked, 50, 25, 10, 10, 10, 10, 70, 10, 10]).clicks.length;
    ok('hammer: no second click without re-cocking ≥ 100 ms', again === 1, `${again} click(s)`);
    const twice = drill([...cocked, 25, 10, 10, 10, ...cocked, 25, 10, 10, 10]).clicks.length;
    ok('hammer: re-cock re-arms (two clean drops = two clicks)', twice === 2, `${twice} click(s)`);
    // 2 s from 70° to 10°: ~600 ms between leaving the cock band (~37° here, where the thumb gap
    // falls under 0.5) and entering the drop band (~18°, gap < 0.3).
    const slowDrop = drill([...cocked, ...Array.from({ length: 100 }, (_, i) => 70 - (60 * i) / 99), 10, 10]).clicks.length;
    ok('hammer: a slow lowering (> 300 ms) never clicks', slowDrop === 0, `${slowDrop} click(s)`);
    const shortCock = drill([20, 20, 70, 70, 10, 10, 10]).clicks.length;
    ok('hammer: a thumb cocked < 100 ms never clicks', shortCock === 0, `${shortCock} click(s)`);
    const abort = drill([...cocked, 40, 40, 70, 70, 70, 70, 70, 70, 70, 70]);
    ok('hammer: an aborted fall clicks nothing and eases back', abort.clicks.length === 0 && abort.p.state.v2.phase === 'live', `${abort.clicks.length} click(s), phase ${abort.p.state.v2.phase}`);
  }

  // 8. No sticky hold: a frame without the pose holds the cursor at once (clutch); a quick
  // re-entry continues from it without a jump.
  {
    const p = mk();
    let t = 1000;
    for (let i = 0; i < 20; i++) p.update([hand({ x: 0.5 + i * 0.002 })], ASPECT, (t += DT));
    const at = p.state.x;
    p.update([hand({ x: 0.54, gun: false })], ASPECT, (t += DT));
    ok('no sticky: pose lost → clutch on the same frame', p.state.mode === 'clutch', p.state.mode);
    p.update([hand({ x: 0.541 })], ASPECT, (t += DT));
    const jump = Math.abs(p.state.x - at) * PX;
    ok('quick re-entry continues without snapping', p.state.mode === 'aim' && jump < 60, `${jump.toFixed(1)} px`);
  }

  // 9. clickAlt: other-hand pinch only when asked.
  {
    const other = (pinching) => ({ ...hand({ x: 0.2, gun: false, pinching }) });
    const seq = (alt) => {
      const p = mk({ clickAlt: alt });
      let t = 1000, n = 0;
      for (let i = 0; i < 10; i++) if (p.update([hand(), other(false)], ASPECT, (t += DT))) n++;
      for (let i = 0; i < 3; i++) if (p.update([hand(), other(true)], ASPECT, (t += DT))) n++;
      return n;
    };
    ok('clickAlt null (default): other-hand pinch does not click', seq(null) === 0);
    ok("clickAlt 'pinch': other-hand pinch clicks once", seq('pinch') === 1);
    const p = mk();
    ok('clickAlt setter accepts only pinch|hold|null', (p.setClickAlt('hold'), p.clickAlt === 'hold') && (p.setClickAlt('x'), p.clickAlt === null));
  }

  // 10. The cursor stays on the canvas however far the hand goes.
  {
    const p = mk();
    let t = 1000;
    for (let i = 0; i < 40; i++) p.update([hand({ x: 0.5 - i * 0.03 })], ASPECT, (t += DT));
    ok('edge clamp: cursor stays within NDC ±1', Math.abs(p.state.x) <= 1 && Math.abs(p.state.y) <= 1, `x ${p.state.x.toFixed(3)}`);
  }

  // 11. The cursor reads RAW landmarks when present (one filter stage, not two).
  {
    const a = mk(), b = mk();
    let t = 1000;
    for (let i = 0; i < 10; i++) {
      t += DT;
      const h1 = hand({ x: 0.5 + i * 0.01 });
      a.update([h1], ASPECT, t);
      const h2 = hand({ x: 0.5 + i * 0.01 });
      h2.rawLandmarks = h2.landmarks;
      h2.landmarks = h2.landmarks.map((q) => ({ ...q, x: 0.3 })); // a stale "smoothed" copy
      b.update([h2], ASPECT, t);
    }
    ok('aim uses hand.rawLandmarks over hand.landmarks', Math.abs(a.state.x - b.state.x) < 1e-9);
  }

  // 12. smoothLandmarks keeps the tracker's points.
  {
    sm.resetLandmarkSmoothing();
    const h = hand();
    const orig = h.landmarks;
    sm.smoothHandLandmarks([h], 1000);
    const h2 = hand({ x: 0.52 });
    const orig2 = h2.landmarks;
    sm.smoothHandLandmarks([h2], 1020);
    ok('smoothLandmarks sets hand.rawLandmarks = the unfiltered input', h.rawLandmarks === orig && h2.rawLandmarks === orig2 && h2.landmarks[5].x !== orig2[5].x);
    sm.resetLandmarkSmoothing();
  }

  // 13. gunPose hammer angle: measured against the metacarpal.
  {
    const a = gp.hammerAngleDeg(worldHand(70));
    ok('hammerAngleDeg reads the thumb vs index metacarpal angle', Math.abs(a - 70) < 0.5 && gp.hammerAngleDeg(null) === null, `${a?.toFixed(2)}°`);
  }

  return { passed, failed };
}

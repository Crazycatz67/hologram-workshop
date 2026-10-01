// Finger-gun lab: the PROBE the owner approved ("probe first, then decide the click").
//
// Question it answers: can "drop the thumb" on a finger gun be the click, or does dropping the
// thumb jerk the aiming hand so much that the click should be a pinch with the OTHER hand?
// It measures, on a real webcam:
//   (a) how far the palm centroid (landmarks 0,5,9,13,17) moves during each thumb drop, and
//       during a one-hand pinch (the click gesture the project already accepts);
//   (b) the palm centroid's resting jitter;
//   (c) MediaPipe's label distribution side-on (L-shape) vs pointing at the camera,
//       plus how often today's gestures.js would read the gun as a grab (isFistLike) or a pinch.
//
// Units: px are video pixels; "frame units" (fu) are px / video height, i.e. the same
// aspect-corrected normalized distance gestures.js uses. 0.01 fu = 7.2 px at 720p.
// Centroid numbers are reported on the SMOOTHED landmarks (smoothLandmarks.js, what the app
// would aim with) and on the RAW ones for reference. Gun/thumb state uses raw worldLandmarks
// (smoothLandmarks.js only filters the 2D landmarks).
//
// Decision rule (provisional, Cody's numbers, printed with the results): see RULE below.
//
// Page also runs a synthetic self-test of gunPose.js on load (no camera). Those checks belong
// in test.js; they live here only because test.js was owned by another agent on 2026-09-30.
//
// Photosafety (BUGS #14): nothing on this page flashes. State badges change colour only on a
// state change, with a 180 ms fade and low-contrast fills.
//
// Reuses camera.js, handTracker.js, smoothLandmarks.js, gestures.js and overlay.js read-only.
// handTracker.js is imported lazily, on "start camera": it pulls MediaPipe from a CDN at module
// load, and the self-test must work offline.

// Propagate the page's cache-busting stamp to every sibling import (same reason as hands.js).
const V = new URL(import.meta.url).search;
const ROOT = '../../../';
const gp = await import(`${ROOT}gunPose.js${V}`);
const { gunFeatures, isGun, thumbState, THUMB_COCKED_MIN } = gp;
const { pinch, isFistLike, isFistShape, PINCH_THRESHOLD } = await import(`${ROOT}gestures.js${V}`);

// ---- decision rule -----------------------------------------------------------------------
// THUMB DROP becomes the click only if ALL hold; otherwise the click is a pinch with the other
// hand (which by construction does not move the aiming hand at all).
//  - median palm-centroid shift over all drops <= 0.015 fu (~11 px at 720p). Why: ~7x the
//    0.002 fu raw MediaPipe noise this project measured, and about half a small on-screen
//    target once mapped to the hologram view.
//  - 90th percentile shift <= 0.03 fu: an occasional big jerk is what users notice.
//  - median drop shift <= 1.5x the median one-hand pinch shift: no worse than the pinch the
//    pinch-measure design already accepts (with its ~120 ms rewind).
//  - at least 4 of 5 drops detected in EACH orientation (side-on and at the camera).
//  - gun recognized on >= 80% of still-hold frames in each orientation.
// The grab collision (isFistLike true on a gun) is reported but is not part of the click
// choice: either click needs the gun pose, so the collision must be fixed either way.
export const RULE = {
  maxMedianShiftFu: 0.015,
  maxP90ShiftFu: 0.03,
  maxRatioToPinch: 1.5,
  minDropsPerOrientation: 4,
  minGunHoldPct: 80
};

const EVENT_TAIL_MS = 250;     // keep measuring this long after a drop/pinch is detected
const LOOKBACK_MS = 800;       // how far back to search for the start of the motion
const BUFFER_MS = 1600;
const PALM_IDS = [0, 5, 9, 13, 17];

// ======================================================================================
// Synthetic hands (world landmarks, metres) for the self-test
// ======================================================================================
// Palm in the x-y plane, fingers along +y, flexion curls toward -z. Rough adult proportions:
// palm (wrist->middle MCP) 9 cm. Thumb poses are hand-placed: cocked = an L to the radial side,
// dropped = tip resting against the side of the index's middle bone.
const MCP = { index: [0.03, 0.085, 0], middle: [0.008, 0.09, 0], ring: [-0.012, 0.085, 0], pinky: [-0.03, 0.075, 0] };
const BONES = { index: [0.04, 0.025, 0.02], middle: [0.045, 0.028, 0.02], ring: [0.042, 0.026, 0.02], pinky: [0.032, 0.02, 0.018] };
const THUMB_COCKED = [[0.02, 0.02, -0.005], [0.05, 0.045, -0.015], [0.075, 0.06, -0.015], [0.095, 0.07, -0.015]];
const THUMB_DROPPED = [[0.02, 0.02, -0.005], [0.045, 0.05, -0.015], [0.05, 0.08, -0.018], [0.045, 0.105, -0.015]];
const STRAIGHT = [0, 0, 0];
const CURLED = [80, 100, 60];

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

// spec: { index, middle, ring, pinky: [mcp, pip, dip] flexion degrees; thumb: 0 = cocked ..
//         1 = dropped (linear blend); rot: [rx, ry, rz] degrees; scale; offset: [x,y,z] }
export function buildWorldHand(spec = {}) {
  const { thumb = 0, rot = [0, 0, 0], scale = 1, offset = [0, 0, 0] } = spec;
  const pts = Array.from({ length: 21 }, () => [0, 0, 0]);
  for (let k = 0; k < 4; k++) {
    pts[1 + k] = THUMB_COCKED[k].map((v, a) => v + (THUMB_DROPPED[k][a] - v) * thumb);
  }
  const names = ['index', 'middle', 'ring', 'pinky'];
  names.forEach((name, f) => {
    const base = 5 + f * 4;
    const flex = spec[name] ?? STRAIGHT;
    let p = MCP[name].slice();
    pts[base] = p;
    let theta = 0;
    for (let b = 0; b < 3; b++) {
      theta += (flex[b] * Math.PI) / 180;
      const l = BONES[name][b];
      p = [p[0], p[1] + l * Math.cos(theta), p[2] - l * Math.sin(theta)];
      pts[base + b + 1] = p;
    }
  });
  return pts.map((q) => {
    const [x, y, z] = rotate(q.map((v) => v * scale), rot);
    return { x: x + offset[0], y: y + offset[1], z: z + offset[2] };
  });
}

// Orthographic projection to normalized image landmarks (x right, y down), palm ~0.12 of the
// frame height, so gestures.js can be asked what TODAY's code would make of the same hand.
export function projectToImage(world, aspect = 16 / 9) {
  const k = 0.12 / 0.09;
  return world.map((p) => ({ x: 0.5 + (p.x * k) / aspect, y: 0.55 - p.y * k, z: p.z * k }));
}

const GUN = { index: STRAIGHT, middle: CURLED, ring: CURLED, pinky: CURLED };
// Side-on L: the camera sees the hand from the thumb side (palm turned 90 deg away).
const SIDE_ON = [0, 90, 90];
// Pointing at the camera: the index direction (+y) turned toward the viewer (-z). Exactly
// 90 deg collapses the palm to a point in 2D, so the 2D collision rows use 60 deg (a real
// hand pointing "at" the lens is rarely dead-on); the 3D invariance checks use the full 90.
const AT_CAMERA = [-90, 0, 0];
const TOWARD_CAMERA = [-60, 0, 0];

export function runSelfTest() {
  const rows = [];
  const check = (name, pass, detail = '') => rows.push({ name, pass: !!pass, detail });
  const info = (name, detail) => rows.push({ name, pass: null, detail });
  const f = (spec) => gunFeatures(buildWorldHand(spec));
  const fmt = (x) => JSON.stringify(x);

  const cocked = f({ ...GUN, thumb: 0 });
  const dropped = f({ ...GUN, thumb: 1 });
  check('gun, thumb cocked: gun on', isGun(cocked, { gesture: 'None' }).gun, fmt(isGun(cocked)));
  check('gun, thumb cocked: thumb reads cocked', thumbState(cocked).state === 'cocked', `gap ${cocked.thumbGap}, angle ${cocked.thumbAngleDeg}°`);
  check('gun, thumb dropped: gun STAYS on (pose must not depend on the thumb)', isGun(dropped).gun, fmt(isGun(dropped)));
  check('gun, thumb dropped: thumb reads dropped', thumbState(dropped, 'cocked').state === 'dropped', `gap ${dropped.thumbGap}, angle ${dropped.thumbAngleDeg}°`);
  check('angle cross-check agrees in both clean poses',
    thumbState(cocked).angleAgrees && thumbState(dropped).angleAgrees,
    `cocked ${cocked.thumbAngleDeg}°, dropped ${dropped.thumbAngleDeg}°`);

  // Hysteresis: walk the thumb down and back up through the dead band.
  const walk = [0, 0.5, 1, 0.5, 0];
  let prev = 'unknown';
  const seen = walk.map((t) => {
    const r = thumbState(f({ ...GUN, thumb: t }), prev);
    prev = r.state;
    return `${t}:${r.gap}:${r.state}`;
  });
  const states = seen.map((s) => s.split(':')[2]).join(',');
  check('hysteresis: mid-band keeps the previous state', states === 'cocked,cocked,dropped,dropped,cocked', seen.join('  '));
  const mid = f({ ...GUN, thumb: 0.5 });
  check('hysteresis: mid-band from unknown stays unknown', thumbState(mid, 'unknown').state === 'unknown', `gap ${mid.thumbGap}`);

  // Rejections.
  const open = f({});
  check('open hand: not a gun', !isGun(open).gun, fmt(isGun(open)));
  const fist = f({ index: CURLED, middle: CURLED, ring: CURLED, pinky: CURLED });
  check('fist: not a gun', !isGun(fist).gun, fmt(isGun(fist)));
  const peace = f({ index: STRAIGHT, middle: STRAIGHT, ring: CURLED, pinky: CURLED });
  check('peace sign (label None): not a gun', !isGun(peace, { gesture: 'None' }).gun, fmt(isGun(peace, { gesture: 'None' })));
  const hook = f({ ...GUN, index: [10, 60, 40] });
  check('hooked index: not a gun', !isGun(hook).gun, fmt(isGun(hook)));
  for (const label of ['Open_Palm', 'Victory', 'Closed_Fist']) {
    check(`label ${label} vetoes a perfect gun`, isGun(cocked, { gesture: label }).rejectedBy === `label:${label}`);
  }
  const sup = isGun(cocked, { gesture: 'Pointing_Up' });
  check('label Pointing_Up supports but does not decide', sup.gun && sup.supported && !isGun(open, { gesture: 'Pointing_Up' }).gun);

  // Invariance: moving, turning or scaling the hand must not change a single feature.
  const close = (a, b) => {
    const flat = (o, p = '', acc = {}) => {
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') flat(v, `${p}${k}.`, acc);
        else acc[p + k] = v;
      }
      return acc;
    };
    const A = flat(a), B = flat(b);
    let worst = ['', 0];
    for (const k of Object.keys(A)) {
      if (k === 'palmM') continue; // palm is metres, it scales on purpose
      if (typeof A[k] !== 'number') { if (A[k] !== B[k]) worst = [k, Infinity]; continue; }
      const tol = /Deg$/.test(k) ? 0.2 : 0.002;
      const d = Math.abs(A[k] - B[k]) / tol;
      if (d > worst[1]) worst = [k, d];
    }
    return { ok: worst[1] <= 1, worst };
  };
  for (const [name, extra] of [
    ['scale x0.8', { scale: 0.8 }], ['scale x1.3', { scale: 1.3 }],
    ['moved 20 cm', { offset: [0.2, -0.1, 0.15] }],
    ['side-on L', { rot: SIDE_ON }],
    ['pointing at the camera', { rot: AT_CAMERA }],
    ['turned 37/-52/115 deg', { rot: [37, -52, 115] }]
  ]) {
    for (const thumb of [0, 1]) {
      const r = close(f({ ...GUN, thumb }), f({ ...GUN, thumb, ...extra }));
      check(`invariant under ${name} (thumb ${thumb ? 'dropped' : 'cocked'})`, r.ok, r.ok ? '' : `worst ${r.worst[0]} off by ${r.worst[1].toFixed(2)} tol`);
    }
  }

  // Bad input never throws and never yields NaN.
  check('null / short / NaN input -> null features, unknown thumb',
    gunFeatures(null) === null && gunFeatures([]) === null &&
    gunFeatures(buildWorldHand().map((p, i) => (i === 3 ? { x: NaN, y: 0, z: 0 } : p))) === null &&
    thumbState(null, 'cocked').state === 'unknown' && isGun(null).rejectedBy === 'no-hand');
  const zeroPalm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  check('zero-size hand -> null features', gunFeatures(zeroPalm) === null);

  // The known collision in TODAY's gestures.js: with label None, isFistShape counts the three
  // curled fingers and isFistLike says "grab". INFO rows, not pass/fail: they document the risk.
  const aspect = 16 / 9;
  for (const [name, rot] of [['palm to camera', [0, 0, 0]], ['side-on L', SIDE_ON], ['60 deg toward camera', TOWARD_CAMERA]]) {
    for (const thumb of [0, 1]) {
      const img = projectToImage(buildWorldHand({ ...GUN, thumb, rot }), aspect);
      const p = pinch(img, aspect, { gesture: 'None' });
      info(`collision: gun ${name}, thumb ${thumb ? 'dropped' : 'cocked'}, label None`,
        `isFistLike=${isFistLike('None', img, aspect)} isFistShape=${isFistShape(img, aspect)} pinch ratio ${p.ratio.toFixed(2)} ${p.pinching ? 'PINCH' : p.rejectedBy ? 'blocked:' + p.rejectedBy : 'open'}`);
    }
  }

  const passed = rows.filter((r) => r.pass === true).length;
  const failed = rows.filter((r) => r.pass === false).length;
  return { passed, failed, rows };
}

// ======================================================================================
// Statistics helpers
// ======================================================================================
const median = (a) => quantile(a, 0.5);
function quantile(arr, q) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = (a.length - 1) * q;
  const lo = Math.floor(i);
  return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo);
}
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

function centroidPx(lm, W, H) {
  let x = 0, y = 0;
  for (const i of PALM_IDS) { x += lm[i].x; y += lm[i].y; }
  return { x: (x / PALM_IDS.length) * W, y: (y / PALM_IDS.length) * H };
}
const dpx = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// RMS distance from the mean position, in px.
function jitterPx(points) {
  if (points.length < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;
  return Math.sqrt(points.reduce((s, p) => s + (p.x - mx) ** 2 + (p.y - my) ** 2, 0) / points.length);
}

// ======================================================================================
// Live page
// ======================================================================================
const SCRIPT = [
  { id: 'sideHold', orient: 'side', kind: 'hold', ms: 5000,
    text: 'Hold a finger gun SIDE-ON to the camera (an L: index forward, thumb up). Keep still.' },
  { id: 'sideDrops', orient: 'side', kind: 'drops', count: 5, maxMs: 25000,
    text: 'Still side-on: drop the thumb onto the index and raise it again. 5 times, at a normal pace.' },
  { id: 'camHold', orient: 'camera', kind: 'hold', ms: 5000,
    text: 'Now point the gun AT THE CAMERA, thumb up. Keep still.' },
  { id: 'camDrops', orient: 'camera', kind: 'drops', count: 5, maxMs: 25000,
    text: 'Still pointing at the camera: drop the thumb and raise it again. 5 times.' },
  { id: 'pinches', orient: 'pinch', kind: 'pinches', count: 5, maxMs: 25000,
    text: 'Relax the hand, then pinch thumb to index and open again. 5 times.' }
];
const READY_MS = 3000;

function boot() {
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const setStatus = (t, err = false) => { statusEl.textContent = t; statusEl.classList.toggle('error', err); };

  // Self-test first: it needs no camera and no network.
  const st = runSelfTest();
  window.__gunSelfTest = st;
  $('selftest').innerHTML = [
    `<span class="${st.failed ? 'fail' : 'pass'}">${st.passed} passed, ${st.failed} failed</span>` +
      ` (+ ${st.rows.filter((r) => r.pass === null).length} info rows documenting today's gestures.js collision)`,
    '',
    ...st.rows.map((r) => {
      const tag = r.pass === null ? '<span class="info">INFO</span>' : r.pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>';
      return `${tag} ${escapeHtml(r.name)}${r.detail ? '  ·  ' + escapeHtml(r.detail) : ''}`;
    })
  ].join('\n');
  setStatus(`self-test ${st.passed}/${st.passed + st.failed} passed · camera off`, st.failed > 0);

  const video = $('cam');
  const canvas = $('overlay');
  const ctx = canvas.getContext('2d');
  const startBtn = $('start'), runBtn = $('run'), skipBtn = $('skip'), copyBtn = $('copy');

  let mods = null;       // lazily imported camera/tracker/smoothing/overlay modules
  let tracker = null, stream = null, running = false;
  let lastVideoTime = -1;
  let buffer = [];       // recent samples of the primary hand
  let thumbPrev = 'unknown';
  let pinchArmed = true;
  let pending = [];      // events waiting for their tail
  let run = null;        // guided-probe state
  let results = null;
  const frameTimes = [];

  async function start() {
    startBtn.disabled = true;
    try {
      if (!mods) {
        setStatus('loading modules…');
        const [cam, ht, sm, ov] = await Promise.all([
          import(`${ROOT}camera.js${V}`), import(`${ROOT}handTracker.js${V}`),
          import(`${ROOT}smoothLandmarks.js${V}`), import(`${ROOT}overlay.js${V}`)
        ]);
        mods = { ...cam, ...ht, ...sm, ...ov };
      }
      setStatus('loading gesture model (~8 MB)…');
      tracker = await mods.createHandTracker({ numHands: 2 });
      setStatus('requesting camera…');
      stream = await mods.startCamera(video);
      mods.resetLandmarkSmoothing();
      setStatus(`tracking · ${video.videoWidth}×${video.videoHeight} · self-test ${st.passed}/${st.passed + st.failed}`);
      startBtn.textContent = 'stop camera';
      startBtn.disabled = false;
      runBtn.disabled = false;
      running = true;
      requestAnimationFrame(loop);
    } catch (err) {
      setStatus(mods ? mods.describeCameraError(err) : String(err), true);
      tracker?.close();
      tracker = null;
      startBtn.disabled = false;
      console.error(err);
    }
  }

  function stop() {
    running = false;
    mods.stopCamera(stream);
    stream = null;
    video.srcObject = null;
    // Close the recognizer on every stop: not closing it leaked one per restart (BUGS #16, #29).
    tracker?.close();
    tracker = null;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    $('readout').textContent = 'camera off';
    startBtn.textContent = 'start camera';
    runBtn.disabled = true;
    if (run) abortRun('camera stopped');
    setStatus('stopped');
  }

  startBtn.addEventListener('click', () => (running ? stop() : start()));
  runBtn.addEventListener('click', () => (run ? abortRun('cancelled') : beginRun()));
  skipBtn.addEventListener('click', () => run && nextStep(performance.now()));
  copyBtn.addEventListener('click', async () => {
    const text = JSON.stringify(results, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'copied';
    } catch {
      // Clipboard can be refused (permissions, non-secure origin): select the JSON instead.
      const pre = $('json');
      const range = document.createRange();
      range.selectNodeContents(pre);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copyBtn.textContent = 'selected: press Cmd+C';
    }
    setTimeout(() => (copyBtn.textContent = 'copy results JSON'), 2000);
  });

  // ---- per-frame --------------------------------------------------------------------
  function loop() {
    if (!running) return;
    if (mods.sizeOverlayTo(canvas, video) && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const t = performance.now();
      frameTimes.push(t);
      while (frameTimes.length && t - frameTimes[0] > 2000) frameTimes.shift();
      if (frameTimes.length > 1) $('fps').textContent = `${Math.round(((frameTimes.length - 1) * 1000) / (t - frameTimes[0]))} fps`;
      onFrame(t);
    }
    requestAnimationFrame(loop);
  }

  function onFrame(t) {
    const W = canvas.width, H = canvas.height, aspect = W / H;
    const hands = tracker.read(video, t);
    const raw = hands.map((h) => h.landmarks);
    // Replaces hand.landmarks with smoothed copies; `raw` keeps the originals.
    mods.smoothHandLandmarks(hands, t);

    hands.forEach((h, i) => {
      h.raw = raw[i];
      h.feats = gunFeatures(h.worldLandmarks);
      h.gunR = isGun(h.feats, { gesture: h.gesture });
      h.fistLike = isFistLike(h.gesture, h.landmarks, aspect);
      h.pinch = pinch(h.landmarks, aspect, { gesture: h.gesture });
    });

    // Primary hand: the pinching-most hand in the pinch step, otherwise a gun hand if any.
    const step = run?.phase === 'record' ? SCRIPT[run.i] : null;
    let hand = null;
    if (hands.length) {
      hand = step?.kind === 'pinches'
        ? hands.reduce((a, b) => (b.pinch.ratio < a.pinch.ratio ? b : a))
        : hands.find((h) => h.gunR.gun) ?? hands[0];
    }

    let sample = null;
    if (hand) {
      const th = thumbState(hand.feats, thumbPrev);
      sample = {
        t, nHands: hands.length, label: hand.gesture, score: hand.score,
        cSm: centroidPx(hand.landmarks, W, H), cRaw: centroidPx(hand.raw, W, H),
        tipSm: { x: hand.landmarks[8].x * W, y: hand.landmarks[8].y * H },
        gun: hand.gunR.gun, fistLike: hand.fistLike, gap: th.gap, thumb: th.state,
        pinchRatio: hand.pinch.ratio, pinchBlocked: hand.pinch.rejectedBy === 'fist'
      };
      detectEvents(sample, thumbPrev, t);
      thumbPrev = th.state;
      buffer.push(sample);
      renderLive(hand, th, hands.length, sample);
    } else {
      thumbPrev = 'unknown';
      $('readout').textContent = 'no hands detected';
      setBadges(null);
    }
    while (buffer.length && t - buffer[0].t > BUFFER_MS) buffer.shift();
    finishEvents(t, H);
    if (run) tickRun(t, sample, H);

    mods.drawHands(ctx, hands, mods.HAND_CONNECTIONS);
    if (sample) {
      // Palm centroid, mirrored to match the mirrored video.
      ctx.beginPath();
      ctx.arc(W - sample.cSm.x, sample.cSm.y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(230, 196, 138, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // A drop = thumb goes cocked -> dropped. A pinch = ratio crosses under PINCH_THRESHOLD; it
  // re-arms only after opening past 2x the threshold, so tracking flicker cannot double-count.
  function detectEvents(s, prevThumb, t) {
    if (prevThumb === 'cocked' && s.thumb === 'dropped') {
      pending.push({ kind: 'drop', tDetect: t, tStart: lastWhere((b) => b.gap != null && b.gap > THUMB_COCKED_MIN, t), gunAtDetect: s.gun });
    }
    if (pinchArmed && s.pinchRatio < PINCH_THRESHOLD) {
      pinchArmed = false;
      pending.push({ kind: 'pinch', tDetect: t, tStart: lastWhere((b) => b.pinchRatio > 2 * PINCH_THRESHOLD, t), blocked: s.pinchBlocked });
    } else if (!pinchArmed && s.pinchRatio > 2 * PINCH_THRESHOLD) {
      pinchArmed = true;
    }
  }

  // Time of the most recent buffered sample matching pred within LOOKBACK_MS (the moment the
  // motion started), or the oldest sample in that window if none matches.
  function lastWhere(pred, t) {
    const win = buffer.filter((b) => t - b.t <= LOOKBACK_MS);
    for (let i = win.length - 1; i >= 0; i--) if (pred(win[i])) return win[i].t;
    return win.length ? win[0].t : t;
  }

  function finishEvents(t, H) {
    const ready = pending.filter((e) => t - e.tDetect >= EVENT_TAIL_MS);
    pending = pending.filter((e) => t - e.tDetect < EVENT_TAIL_MS);
    for (const e of ready) {
      const frames = buffer.filter((b) => b.t >= e.tStart && b.t <= e.tDetect + EVENT_TAIL_MS);
      if (frames.length < 2) continue;
      const base = frames[0];
      const maxOf = (key) => Math.max(...frames.map((b) => dpx(b[key], base[key])));
      const ev = {
        kind: e.kind,
        motionMs: Math.round(e.tDetect - e.tStart),
        frames: frames.length,
        shiftPx: r1(maxOf('cSm')), shiftFu: r4(maxOf('cSm') / H),
        netPx: r1(dpx(frames[frames.length - 1].cSm, base.cSm)),
        rawShiftPx: r1(maxOf('cRaw')), rawShiftFu: r4(maxOf('cRaw') / H),
        indexTipShiftPx: r1(maxOf('tipSm')),
        gunHeldPct: Math.round((100 * frames.filter((b) => b.gun).length) / frames.length)
      };
      if (e.kind === 'drop') ev.gunAtDetect = e.gunAtDetect;
      else ev.blockedAsFist = e.blocked;
      if (run?.phase === 'record') {
        const step = SCRIPT[run.i];
        if ((step.kind === 'drops' && e.kind === 'drop') || (step.kind === 'pinches' && e.kind === 'pinch')) {
          run.data[step.id].events.push(ev);
        }
      }
    }
  }

  // ---- guided probe -----------------------------------------------------------------
  function beginRun() {
    results = null;
    run = { i: 0, phase: 'ready', t0: performance.now(), data: {} };
    for (const s of SCRIPT) run.data[s.id] = { frames: 0, noHand: 0, twoHands: 0, labels: {}, gun: 0, fistLike: 0, pinchBlocked: 0, cSm: [], cRaw: [], events: [] };
    runBtn.textContent = 'cancel probe';
    skipBtn.disabled = false;
    copyBtn.disabled = true;
    showStep();
  }

  function abortRun(why) {
    run = null;
    runBtn.textContent = 'run guided probe';
    skipBtn.disabled = true;
    $('step').textContent = `Probe ${why}. Run it again when ready.`;
    $('bar').style.width = '0';
  }

  function nextStep(t) {
    run.i++;
    run.phase = 'ready';
    run.t0 = t;
    if (run.i >= SCRIPT.length) return finishRun();
    showStep();
  }

  function showStep() {
    const s = SCRIPT[run.i];
    $('step').textContent = `Step ${run.i + 1}/${SCRIPT.length} · get ready… ${s.text}`;
  }

  function tickRun(t, sample, H) {
    const s = SCRIPT[run.i];
    const el = t - run.t0;
    if (run.phase === 'ready') {
      $('bar').style.width = `${Math.min(100, (100 * el) / READY_MS)}%`;
      $('step').textContent = `Step ${run.i + 1}/${SCRIPT.length} · starts in ${Math.ceil((READY_MS - el) / 1000)} s · ${s.text}`;
      if (el >= READY_MS) {
        run.phase = 'record';
        run.t0 = t;
        // Events detected during "get ready" must not count toward this step.
        pending = [];
      }
      return;
    }
    const d = run.data[s.id];
    d.frames++;
    if (!sample) d.noHand++;
    else {
      if (sample.nHands > 1) d.twoHands++;
      d.labels[sample.label] = (d.labels[sample.label] || 0) + 1;
      if (sample.gun) d.gun++;
      if (sample.fistLike) d.fistLike++;
      if (sample.pinchBlocked) d.pinchBlocked++;
      if (s.kind === 'hold') { d.cSm.push(sample.cSm); d.cRaw.push(sample.cRaw); }
    }
    let done, progress, counter = '';
    if (s.kind === 'hold') {
      progress = el / s.ms;
      done = el >= s.ms;
      counter = `${Math.max(0, Math.ceil((s.ms - el) / 1000))} s left`;
    } else {
      progress = Math.max(d.events.length / s.count, el / s.maxMs);
      done = d.events.length >= s.count || el >= s.maxMs;
      counter = `${d.events.length}/${s.count} seen · ${Math.ceil((s.maxMs - el) / 1000)} s max`;
    }
    $('bar').style.width = `${Math.min(100, 100 * progress)}%`;
    $('step').textContent = `Step ${run.i + 1}/${SCRIPT.length} · RECORDING · ${counter} · ${s.text}`;
    // Let the last event's tail finish before moving on.
    if (done && pending.length === 0) nextStep(t);
  }

  function finishRun() {
    const H = canvas.height, W = canvas.width;
    const phases = {};
    for (const s of SCRIPT) {
      const d = run.data[s.id];
      const seen = d.frames - d.noHand;
      const pct = (n) => (seen ? Math.round((100 * n) / seen) : null);
      const jS = jitterPx(d.cSm), jR = jitterPx(d.cRaw);
      phases[s.id] = {
        orient: s.orient, kind: s.kind, frames: d.frames, noHandFrames: d.noHand, twoHandFrames: d.twoHands,
        labels: Object.fromEntries(Object.entries(d.labels).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])),
        gunOnPct: pct(d.gun), fistLikePct: pct(d.fistLike), pinchBlockedPct: pct(d.pinchBlocked),
        ...(s.kind === 'hold' ? {
          jitterPx: r1(jS), jitterFu: r4(jS == null ? null : jS / H),
          rawJitterPx: r1(jR), rawJitterFu: r4(jR == null ? null : jR / H)
        } : {
          requested: s.count, detected: d.events.length, events: d.events,
          medianShiftPx: r1(median(d.events.map((e) => e.shiftPx))),
          medianShiftFu: r4(median(d.events.map((e) => e.shiftFu))),
          p90ShiftFu: r4(quantile(d.events.map((e) => e.shiftFu), 0.9)),
          maxShiftPx: r1(Math.max(...d.events.map((e) => e.shiftPx), -Infinity)) ?? null
        })
      };
      if (phases[s.id].maxShiftPx === -Infinity) phases[s.id].maxShiftPx = null;
    }
    results = {
      probe: 'finger-gun thumb-drop vs other-hand pinch',
      date: new Date().toISOString(),
      video: { width: W, height: H },
      fps: frameTimes.length > 1 ? Math.round(((frameTimes.length - 1) * 1000) / (frameTimes.at(-1) - frameTimes[0])) : null,
      thresholds: Object.fromEntries(Object.entries(gp).filter(([, v]) => typeof v === 'number')),
      rule: RULE,
      phases,
      verdict: decide(phases)
    };
    window.__gunProbe = results;
    renderResults(results);
    run = null;
    runBtn.textContent = 'run guided probe again';
    skipBtn.disabled = true;
    copyBtn.disabled = false;
    $('step').textContent = 'Done. Results are below; screenshot them or copy the JSON.';
    $('bar').style.width = '100%';
  }

  // ---- rendering --------------------------------------------------------------------
  let lastBadge = '';
  function setBadges(s) {
    // Only touch the DOM when a state actually changes (no per-frame restyling).
    const key = s ? `${s.gun}|${s.thumb}|${s.fistLike}` : 'none';
    if (key === lastBadge) return;
    lastBadge = key;
    const set = (id, text, cls) => { const el = $(id); el.textContent = text; el.className = 'badge' + (cls ? ' ' + cls : ''); };
    if (!s) { set('gunBadge', 'gun: —'); set('thumbBadge', 'thumb: —'); set('fistBadge', 'grab (isFistLike): —'); return; }
    set('gunBadge', `gun: ${s.gun ? 'ON' : 'off'}`, s.gun ? 'on' : '');
    set('thumbBadge', `thumb: ${s.thumb}`, s.thumb === 'dropped' ? 'on' : '');
    set('fistBadge', `grab (isFistLike): ${s.fistLike}`, s.fistLike && s.gun ? 'warn' : '');
  }

  function renderLive(hand, th, nHands, s) {
    setBadges(s);
    const f = hand.feats;
    const p = hand.pinch;
    const fin = (n, x) => `${n} pip ${x.pipDeg}° reach ${x.reach}`;
    const lines = [
      `hand ${hand.handedness}   label ${hand.gesture} (${hand.score.toFixed(2)})   hands in view ${nHands}`,
      `gestures.js  isFistLike ${hand.fistLike}   pinch ratio ${p.ratio.toFixed(2)} ${p.pinching ? 'PINCH' : p.rejectedBy ? 'blocked:' + p.rejectedBy : 'open'}`,
      f ? `index        pip ${f.index.pipDeg}° dip ${f.index.dipDeg}° reach ${f.index.reach}   extended ${f.indexExtended}` : 'gunFeatures  (no world landmarks)',
      f ? `${fin('middle', f.middle)} · ${fin('ring', f.ring)} · ${fin('pinky', f.pinky)}` : '',
      f ? `curled ${f.curledCount}/3   separation ${f.separation}   palm ${(f.palmM * 100).toFixed(1)} cm` : '',
      `gun ${hand.gunR.gun ? 'ON' : 'off'}${hand.gunR.rejectedBy ? ' (' + hand.gunR.rejectedBy + ')' : ''}${hand.gunR.supported ? ' · label supports' : ''}`,
      `thumb ${th.state}   gap ${th.gap ?? '—'}   angle ${th.angleDeg ?? '—'}°   angle agrees ${th.angleAgrees ?? '—'}`,
      `palm centroid ${s.cSm.x.toFixed(0)}, ${s.cSm.y.toFixed(0)} px (smoothed)`,
      hand.fistLike && hand.gunR.gun ? 'COLLISION: today\'s gestures.js would read this gun as a grab' : ''
    ];
    $('readout').textContent = lines.filter(Boolean).join('\n');
  }

  function renderResults(res) {
    const P = res.phases;
    const top = (labels) => Object.entries(labels).slice(0, 3).map(([k, v]) => `${k} ${v}%`).join(', ') || '—';
    const v = (x, suffix = '') => (x == null ? '—' : `${x}${suffix}`);
    const rows = SCRIPT.map((s) => {
      const p = P[s.id];
      const moves = p.kind === 'hold'
        ? `jitter ${v(p.jitterPx, ' px')} (${v(p.jitterFu, ' fu')}) · raw ${v(p.rawJitterPx, ' px')}`
        : `${p.detected}/${p.requested} seen · median shift ${v(p.medianShiftPx, ' px')} (${v(p.medianShiftFu, ' fu')}) · p90 ${v(p.p90ShiftFu, ' fu')} · max ${v(p.maxShiftPx, ' px')}`;
      return `<tr><td>${s.id}</td><td>${p.frames}${p.noHandFrames ? ` (${p.noHandFrames} no hand)` : ''}${p.twoHandFrames ? ` (${p.twoHandFrames} two hands)` : ''}</td>` +
        `<td>${escapeHtml(top(p.labels))}</td><td>${v(p.gunOnPct, '%')}</td><td>${v(p.fistLikePct, '%')}</td><td>${escapeHtml(moves)}</td></tr>`;
    }).join('');
    const vd = res.verdict;
    $('results').innerHTML =
      `<div class="scroll"><table><tr><th>step</th><th>frames</th><th>MediaPipe labels</th><th>gun on</th><th>read as grab (isFistLike)</th><th>palm-centroid movement (smoothed)</th></tr>${rows}</table></div>` +
      `<div id="verdict"><b>Verdict: ${escapeHtml(vd.choice)}</b><br>` +
      vd.checks.map((c) => `<span class="${c.pass == null ? 'info' : c.pass ? 'pass' : 'fail'}">${c.pass == null ? 'n/a ' : c.pass ? 'PASS' : 'FAIL'}</span> ${escapeHtml(c.text)}`).join('<br>') +
      (vd.notes.length ? '<br>' + vd.notes.map((n) => `<span class="info">note</span> ${escapeHtml(n)}`).join('<br>') : '') +
      `</div><p>${res.video.width}×${res.video.height} @ ${v(res.fps)} fps · 1 fu = ${res.video.height} px · per-event numbers are in the JSON.</p>`;
    const pre = $('json');
    pre.hidden = false;
    pre.textContent = JSON.stringify(res, null, 2);
  }

  // previewResults(phases) renders a hand-made phase summary through the real results table,
  // so the table and verdict can be checked without a camera.
  window.__gunLab = {
    runSelfTest, decide, get results() { return results; },
    previewResults(phases, video = { width: 1280, height: 720 }) {
      renderResults({ video, fps: null, phases, verdict: decide(phases) });
    }
  };
  return { setStatus };
}

// Applies RULE to the phase summaries. Exported (via window.__gunLab) so the rule can be
// re-applied to a pasted JSON without re-running the probe.
export function decide(P) {
  const checks = [];
  const notes = [];
  const drops = [...(P.sideDrops?.events ?? []), ...(P.camDrops?.events ?? [])];
  const pinches = P.pinches?.events ?? [];
  const dMed = median(drops.map((e) => e.shiftFu));
  const dP90 = quantile(drops.map((e) => e.shiftFu), 0.9);
  const pMed = median(pinches.map((e) => e.shiftFu));
  const add = (pass, text) => checks.push({ pass, text });

  add(dMed == null ? null : dMed <= RULE.maxMedianShiftFu,
    `median palm shift on thumb drop ${dMed == null ? '—' : dMed.toFixed(4)} fu <= ${RULE.maxMedianShiftFu} fu`);
  add(dP90 == null ? null : dP90 <= RULE.maxP90ShiftFu,
    `90th-percentile shift on thumb drop ${dP90 == null ? '—' : dP90.toFixed(4)} fu <= ${RULE.maxP90ShiftFu} fu`);
  add(dMed == null || !pMed ? null : dMed <= RULE.maxRatioToPinch * pMed,
    `thumb-drop shift / one-hand-pinch shift ${dMed == null || !pMed ? '—' : (dMed / pMed).toFixed(2)} <= ${RULE.maxRatioToPinch}`);
  for (const id of ['sideDrops', 'camDrops']) {
    const p = P[id];
    add(p ? p.detected >= RULE.minDropsPerOrientation : null,
      `${id}: ${p?.detected ?? '—'} of ${p?.requested ?? 5} drops detected (need ${RULE.minDropsPerOrientation})`);
  }
  for (const id of ['sideHold', 'camHold']) {
    const p = P[id];
    add(p?.gunOnPct == null ? null : p.gunOnPct >= RULE.minGunHoldPct,
      `${id}: gun recognized on ${p?.gunOnPct ?? '—'}% of still frames (need ${RULE.minGunHoldPct}%)`);
  }
  const fist = Math.max(P.sideHold?.fistLikePct ?? 0, P.camHold?.fistLikePct ?? 0);
  if (fist > 0) notes.push(`today's gestures.js reads the held gun as a GRAB on up to ${fist}% of frames: must be fixed before any gun click ships, whichever click wins.`);
  const blocked = pinches.filter((e) => e.blockedAsFist).length;
  if (blocked) notes.push(`${blocked} of ${pinches.length} one-hand pinches were blocked as a fist by gestures.js.`);
  const disagree = drops.filter((e) => e.gunHeldPct < 100).length;
  if (disagree) notes.push(`gun recognition dropped out during ${disagree} of ${drops.length} thumb drops.`);

  const decided = checks.filter((c) => c.pass != null);
  let choice;
  if (decided.length < checks.length) choice = 'INCONCLUSIVE (some measurements missing; re-run the probe)';
  else if (decided.every((c) => c.pass)) choice = 'THUMB DROP on the gun hand is the click';
  else choice = 'OTHER-HAND PINCH is the click (thumb drop failed a check below)';
  return { choice, checks, notes };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// The page boots itself; under Node (offline checks) only the exports are used.
if (typeof document !== 'undefined') boot();

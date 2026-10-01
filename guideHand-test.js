// Guide hand checks (guideHand/: skeleton, posekin, strokekin ported from asl-recognizer;
// gestures, player new).
//
//   A. Poses read as themselves, from the landmarks: fist = every fingertip folded below its
//      knuckle and toward the camera; pointer = index up, three curled; ✌ = index + middle up;
//      pinch = thumb tip on index tip; open = all tips well above the knuckles.
//   B. Fist pixel check (like the ASL self-test's drawHandShape check): every pose draws opaque
//      pixels; the fist is compact (its drawn bbox much shorter than the open hand's, and fuller).
//   C. posekin: open -> fist / pointer -> pinch endpoints exact; no finger point goes behind the
//      palm (z > 0) mid-curl; bone lengths stay put (same physical hand).
//   D. Every gesture renders opaque pixels at 24 moments of its loop without throwing, and the
//      loop seam (end -> start) doesn't jump.
//   E. Photosafety: WCAG 2.3.1 flashes per tile (safety-test.js's method) <= 3/s per gesture.
//   F. Player API: setGesture, play / pause, unknown gesture -> false, reduced motion = still
//      key pose + hint (not playing), fps cap <= 30, loop:false stops, dispose stops drawing.
//   Z. 0 console errors.

const V = new URL(import.meta.url).search;
const { POSES, GESTURES, GESTURE_NAMES } = await import('./guideHand/gestures.js' + V);
const { makeHandInterpolator } = await import('./guideHand/posekin.js' + V);
const { drawHandShape, handSpan } = await import('./guideHand/skeleton.js' + V);
const { createGuidePlayer } = await import('./guideHand/player.js' + V);

const out = document.getElementById('out');
out.textContent = '';
const log = (s) => { out.textContent += s + '\n'; };
const results = [], metrics = {};
const consoleErrors = [];
window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));
const origError = console.error;
console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); origError(...a); };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
const f2 = (v) => Number(v).toFixed(2);
const frameWait = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- A. poses
const TIPS = [8, 12, 16, 20], MCP = [5, 9, 13, 17];
const up = (p, f) => p[MCP[f]][1] - p[TIPS[f]][1];          // > 0: tip above its knuckle (y down)
for (const [name, p] of Object.entries(POSES)) {
  check(`A0 ${name}: 21 finite points`, p.length === 21 && p.every((q) => q.length === 3 && q.every(Number.isFinite)));
}
{
  const p = POSES.fist;
  const ups = [0, 1, 2, 3].map((f) => up(p, f));
  check('A1 fist: every fingertip folded below its knuckle and toward the camera',
    ups.every((u) => u < 0) && TIPS.every((t) => p[t][2] < 0), `tip-above-knuckle ${ups.map(f2).join(' ')}`);
  check('A1b fist: thumb lies across the front of the curled fingers',
    p[4][0] < p[5][0] && p[4][2] < Math.min(...[6, 7, 10, 11].map((j) => p[j][2])) + 0.05, `thumb tip x ${f2(p[4][0])} z ${f2(p[4][2])}`);
}
{
  const p = POSES.open, ups = [0, 1, 2, 3].map((f) => up(p, f));
  check('A2 open: all four fingertips well above their knuckles', ups.every((u) => u > 0.3), ups.map(f2).join(' '));
}
{
  const p = POSES.pointer, ups = [0, 1, 2, 3].map((f) => up(p, f));
  check('A3 pointer: index out, three curled', ups[0] > 0.3 && ups.slice(1).every((u) => u < 0), ups.map(f2).join(' '));
}
{
  const p = POSES.peace, ups = [0, 1, 2, 3].map((f) => up(p, f));
  const gap = Math.abs(p[8][0] - p[12][0]);
  check('A4 ✌: index + middle up and apart, ring + pinky curled', ups[0] > 0.3 && ups[1] > 0.3 && ups[2] < 0 && ups[3] < 0 && gap > 0.12, `${ups.map(f2).join(' ')} gap ${f2(gap)}`);
}
{
  const d = (p) => Math.hypot(p[4][0] - p[8][0], p[4][1] - p[8][1], p[4][2] - p[8][2]);
  check('A5 pinch: thumb tip on the index tip; ready shape is open', d(POSES.pinch) < 0.06 && d(POSES.pinchOpen) > 0.1, `pinch ${f2(d(POSES.pinch))} ready ${f2(d(POSES.pinchOpen))}`);
}
{
  const p = POSES.thumbsUp;
  check('A6 thumbs-up: thumb tip above the curled fingers; 👎 = thumb tip lowest', p[4][1] < p[5][1] && POSES.thumbsDown[4][1] >= Math.max(...POSES.thumbsDown.map((q) => q[1])) - 1e-9);
}

// ---------------------------------------------------------------- B. pixel check
const scratch = document.getElementById('scratch');
function drawAlone(pose, size = 240) {
  scratch.width = size; scratch.height = size;
  const g = scratch.getContext('2d');
  g.clearRect(0, 0, size, size);
  const s = size * 0.7, ox = size * 0.5, oy = size * 0.9;
  const px = pose.map(([x, y]) => [ox + x * s, oy + y * s]);
  drawHandShape(g, px, { depth: { z: pose.map((q) => q[2]) }, face: 0.6, span: handSpan(POSES.open) * s });
  const d = g.getImageData(0, 0, size, size).data;
  let n = 0, x0 = size, y0 = size, x1 = -1, y1 = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (d[(y * size + x) * 4 + 3] > 200) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  return { n, frac: n / (size * size), bh, fill: n / Math.max(1, bw * bh) };
}
const shapes = {};
for (const name of Object.keys(POSES)) {
  shapes[name] = drawAlone(POSES[name]);
  check(`B0 ${name}: draws opaque pixels`, shapes[name].frac > 0.03, `${(100 * shapes[name].frac).toFixed(1)}% of the canvas`);
}
{
  const F = shapes.fist, O = shapes.open;
  metrics.fistHeightRatio = +(F.bh / O.bh).toFixed(3);
  metrics.fistFill = +F.fill.toFixed(3);
  metrics.openFill = +O.fill.toFixed(3);
  check('B1 fist pixel check: compact (height <= 0.65 x open) and solid (fill > open + 0.1)',
    F.bh / O.bh <= 0.65 && F.fill > O.fill + 0.1, `height ratio ${f2(F.bh / O.bh)}, fill ${f2(F.fill)} vs open ${f2(O.fill)}`);
}
{
  let threw = null;
  try {
    const g = scratch.getContext('2d');
    drawHandShape(g, null); drawHandShape(g, [[0, 0]]); drawHandShape(g, Array(21).fill([NaN, 1]));
  } catch (e) { threw = e; }
  check('B2 drawHandShape: no throw on junk input', !threw, threw ? String(threw) : '');
}

// ---------------------------------------------------------------- C. posekin
{
  const dist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1], (p[2] || 0) - (b[i][2] || 0))));
  let worstEnd = 0, worstZ = -Infinity, worstLen = 0;
  for (const [A, B] of [['open', 'fist'], ['pointer', 'pinch'], ['relaxed', 'peace'], ['pinchOpen', 'pinch'], ['open', 'thumbsUp']]) {
    const it = makeHandInterpolator(POSES[A], POSES[B]).at3d;
    worstEnd = Math.max(worstEnd, dist(it(0), POSES[A]), dist(it(1), POSES[B]));
    const lenA = (p, i, j) => Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1], p[i][2] - p[j][2]);
    for (let k = 0; k <= 20; k++) {
      const p = it(k / 20);
      for (let j = 5; j < 21; j++) worstZ = Math.max(worstZ, p[j][2]);
      for (const [i, j] of [[5, 6], [6, 7], [7, 8], [9, 10], [17, 18]]) {
        const ref = lenA(POSES[B], i, j);
        worstLen = Math.max(worstLen, Math.abs(lenA(p, i, j) - ref) / ref);
      }
    }
  }
  check('C1 interpolator endpoints exact', worstEnd < 1e-6, `max error ${worstEnd.toExponential(1)}`);
  check('C2 no finger swings behind the palm mid-curl (z <= 0.01)', worstZ <= 0.01, `max finger z ${worstZ.toFixed(3)}`);
  check('C3 bone lengths constant through the curl (< 1%)', worstLen < 0.01, `worst ${(100 * worstLen).toFixed(2)}%`);
}

// ---------------------------------------------------------------- D. every gesture
const W = 480, H = 300;
function testCanvas() {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  return c;
}
function opaqueFrac(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 200) n++;
  return n / (c.width * c.height);
}
for (const name of GESTURE_NAMES) {
  const c = testCanvas();
  let threw = null, minFrac = 1, seam = 0;
  try {
    const p = createGuidePlayer(c, { gesture: name, autoplay: false, reducedMotion: false });
    const T = p.gesture.T;
    for (let k = 0; k < 24; k++) {
      p.renderAt((k / 24) * T);
      minFrac = Math.min(minFrac, opaqueFrac(c));
    }
    // loop seam: the last moment and the first must be the same picture (no jump on wrap)
    const a = p.frameAt(T - 1).hands, b = p.frameAt(0).hands;
    a.forEach((h, i) => h.landmarks.forEach((q, j) => { seam = Math.max(seam, Math.hypot(q[0] - b[i].landmarks[j][0], q[1] - b[i].landmarks[j][1])); }));
    if (a.length !== b.length) seam = Infinity;
    p.dispose();
  } catch (e) { threw = e; console.warn(e); }
  check(`D ${name}: renders opaque pixels in every moment, loops seamlessly`, !threw && minFrac > 0.005 && seam < 0.01,
    threw ? String(threw) : `min opaque ${(100 * minFrac).toFixed(1)}%, seam jump ${seam.toFixed(4)}`);
  await frameWait();
}

// ---------------------------------------------------------------- E. photosafety
// safety-test.js's WCAG 2.3.1 method, at a card-sized canvas: relative luminance per tile,
// a transition = >= 0.10 swing from the last extreme with the darker state < 0.80, a flash =
// a pair, worst tile's flashes in any 1 s window. Rendered over the landing's dark card colour.
const LUT = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
function flashesPerSecond(name, fps = 30) {
  const c = testCanvas();
  const bg = document.createElement('canvas'); bg.width = W; bg.height = H;
  const bgx = bg.getContext('2d', { willReadFrequently: true });
  const p = createGuidePlayer(c, { gesture: name, autoplay: false, reducedMotion: false });
  const T = p.gesture.T, n = Math.ceil((2 * T) / 1000 * fps);
  const TW = 80, TH = 60, tx = W / TW, ty = H / TH;
  const tiles = Array.from({ length: tx * ty }, () => new Float32Array(n));
  for (let f = 0; f < n; f++) {
    p.renderAt(((f * 1000) / fps) % T);
    bgx.fillStyle = '#0a1118'; bgx.fillRect(0, 0, W, H); bgx.drawImage(c, 0, 0);
    const d = bgx.getImageData(0, 0, W, H).data;
    for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
      let s = 0;
      for (let y = j * TH; y < (j + 1) * TH; y += 2) for (let x = i * TW; x < (i + 1) * TW; x += 2) {
        const q = (y * W + x) * 4;
        s += 0.2126 * LUT[d[q]] + 0.7152 * LUT[d[q + 1]] + 0.0722 * LUT[d[q + 2]];
      }
      tiles[j * tx + i][f] = s / ((TW * TH) / 4);
    }
  }
  p.dispose();
  let worst = 0;
  for (const L of tiles) {
    const tr = [];
    let ext = L[0], dir = 0;
    for (let f = 1; f < n; f++) {
      const dd = L[f] - ext;
      if (dir >= 0 && L[f] > ext) { ext = L[f]; dir = 1; continue; }
      if (dir <= 0 && L[f] < ext) { ext = L[f]; dir = -1; continue; }
      if (Math.abs(dd) >= 0.1 && Math.min(L[f], ext) < 0.8) { tr.push(f); dir = dd > 0 ? 1 : -1; ext = L[f]; }
    }
    for (let i = 0; i < tr.length; i++) {
      let j = i;
      while (j < tr.length && tr[j] - tr[i] < fps) j++;
      worst = Math.max(worst, Math.floor((j - i) / 2));
    }
  }
  return worst;
}
{
  let worst = 0, worstName = '';
  for (const name of GESTURE_NAMES) {
    const f = flashesPerSecond(name);
    if (f > worst || !worstName) { worst = f; worstName = name; }
    await frameWait();
  }
  metrics.flashesPerSecondWorst = worst;
  check('E photosafety: every gesture <= 3 flashes/s (worst tile, 80x60 px tiles)', worst <= 3, `worst ${worst}/s (${worstName})`);
}

// ---------------------------------------------------------------- F. player API
{
  const c = testCanvas();
  const p = createGuidePlayer(c, { gesture: 'grab-move', reducedMotion: true });
  check('F1 reduced motion: not playing, still key pose drawn with a hint arrow', !p.playing && p.reduced && opaqueFrac(c) > 0.01);
  const ok = p.setGesture('no-such-gesture');
  check('F2 unknown gesture: setGesture -> false, canvas cleared, no throw', ok === false && opaqueFrac(c) === 0);
  check('F3 setGesture(known) -> true and redraws', p.setGesture('clap') === true && opaqueFrac(c) > 0.01);
  p.dispose();
}
{
  // live loop, attached to the page so IntersectionObserver reports it visible
  const fig = document.createElement('figure');
  const c = document.createElement('canvas');
  fig.append(c);
  const cap = document.createElement('figcaption');
  cap.textContent = 'fps-cap probe (aim-sweep)';
  fig.append(cap);
  document.getElementById('gallery').prepend(fig);
  const p = createGuidePlayer(c, { gesture: 'aim-sweep', reducedMotion: false });
  await sleep(150);
  const f0 = p.stats.frames;
  await sleep(1000);
  const fps = p.stats.frames - f0;
  metrics.liveFps = fps;
  check('F4 live loop plays and caps at <= 30 fps', p.playing && fps > 0 && fps <= 31, `${fps} frames in 1 s${document.hidden ? ' (tab hidden: rAF throttled)' : ''}`);
  p.pause();
  const fp = p.stats.frames;
  await sleep(250);
  check('F5 pause stops drawing', !p.playing && p.stats.frames === fp);
  p.dispose();
  const once = createGuidePlayer(c, { gesture: 'clap', loop: false, speed: 20, reducedMotion: false });
  await sleep(700);
  check('F6 loop:false plays once then stops on the last frame', !once.playing, `frames ${once.stats.frames}`);
  once.play();
  await sleep(60);
  once.dispose();
  const fd = once.stats.frames;
  await sleep(200);
  check('F7 dispose stops drawing', once.stats.frames === fd);
  fig.remove();
}

// ---------------------------------------------------------------- gallery (for eyes / screenshots)
const gallery = document.getElementById('gallery');
for (const name of GESTURE_NAMES) {
  const fig = document.createElement('figure');
  const c = document.createElement('canvas');
  const cap = document.createElement('figcaption');
  cap.textContent = `${name} · ${GESTURES[name].title}`;
  fig.append(c, cap);
  gallery.append(fig);
  createGuidePlayer(c, { gesture: name });
}

await sleep(300);
check('Z 0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
const passed = results.filter((r) => r.ok).length;
log(`\n${passed}/${results.length} passed`);
document.title = `Guide hand test: ${passed}/${results.length}`;
window.guideHandResults = { results, metrics, passed, failed: results.length - passed };
export const done = Promise.resolve(window.guideHandResults);

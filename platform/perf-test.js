// Render benchmark for the Platform (perf-test.html).
//
// The page's fps counter is driven by requestAnimationFrame, which browsers throttle in
// background tabs (and under automation), so it can't be trusted for measurements. This
// loads a scan through the SAME pipeline as platform/main.js (parse -> split into parts ->
// place on floor -> look.js materials and single-layer rendering -> display LOD) and then
// calls the render function directly N times at a fixed canvas size, forcing the GPU to
// finish each frame with a 1-pixel readPixels. GPU time comes from
// EXT_disjoint_timer_query_webgl2 when the browser exposes it.
//
// Modes:
//   empty     the scan hidden: the fixed cost of clear + readPixels sync, to subtract
//   legacy    hologramLook.renderSingleLayer on the FULL geometry: the renderer as it was
//             before the display-LOD work (kept reproducible so the "before" column can be
//             re-measured at any time)
//   nolod     the platform's render path with the display LOD switched off (isolates the
//             filtered pre-pass from the LOD)
//   platform  whatever platform/main.js renders with today (scene.userData.renderSingleLayer)
//
// Results land in the table and on window.perfResult.

import * as THREE from 'three';
import { createScene } from '../scene.js';
import { createLook } from './look.js';
import { parseGroup } from './upload.js';
import { splitComponents } from './segment.js';
import { loadSimplifier } from './parts.js';
import { placeOnFloor, frameSingle, frameRoom, ROOM_THRESHOLD_M } from './framing.js';
import { renderSingleLayer as legacyRender } from '../hologramLook.js';
import { createDisplayLod } from './lod.js';

const q = new URLSearchParams(location.search);
const SCAN = q.get('scan') || '../assets/chair/chair_detail.glb';
const N = +(q.get('n') || 200);
const PRS = (q.get('pr') || '1,2').split(',').map(Number);
const MODES = (q.get('modes') || 'empty,legacy,nolod,platform').split(',');
const W = 1280, H = 800;
const statusEl = document.getElementById('status');
const status = (s) => { statusEl.textContent = s; };

const { scene, camera, renderer, controls } = createScene(document.getElementById('stage'));
renderer.setSize(W, H, false);
camera.aspect = W / H;
camera.updateProjectionMatrix();
const look = createLook({ scene, mount: null });
look.set('realism', +(q.get('realism') || 0));
const lod = createDisplayLod({ scene, camera, renderer, look });
scene.userData.renderSingleLayer = lod.render;   // as platform/main.js does
window.perf = { scene, renderer, camera, lod, look };
const gl = renderer.getContext();
const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');

async function load() {
  await loadSimplifier();
  const res = await fetch(SCAN);
  if (!res.ok) throw new Error(`${SCAN}: HTTP ${res.status}`);
  const blob = await res.blob();
  const file = new File([blob], SCAN.split('/').pop());
  const scan = await parseGroup({ kind: 'scan', name: file.name, main: file, sidecars: [] });
  const seg = splitComponents(scan.object);
  const root = seg.root;
  root.traverse((c) => { if (c.isMesh && !c.userData.original) c.userData.original = c.material; });
  const { box } = placeOnFloor(root);
  scene.add(root);
  look.prepare(root);
  root.traverse((c) => { if (c.isMesh) c.material = look.materialFor(c, 'base'); });
  lod.add(root);
  await lod.ready();
  const size = box.getSize(new THREE.Vector3());
  (Math.max(size.x, size.z) > ROOM_THRESHOLD_M ? frameRoom : frameSingle)(box, camera, controls);
  roots.push(root);
  return { root, parts: seg.parts.length };
}

const roots = [];
const pixel = new Uint8Array(4);
const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function gpuBytes() {
  // Unique buffers the scene would upload: attributes + indices (LOD indices included).
  const seen = new Set();
  let bytes = 0;
  const addGeo = (g) => {
    if (!g) return;
    for (const a of [...Object.values(g.attributes), g.index]) {
      if (a && !seen.has(a.array)) { seen.add(a.array); bytes += a.array.byteLength; }
    }
  };
  scene.traverse((c) => { if (c.geometry) { addGeo(c.geometry); addGeo(c.userData.lod?.geometry); } });
  return bytes;
}

const drawFor = (mode) => (mode === 'legacy' || mode === 'empty')
  ? () => legacyRender(renderer, scene, camera)
  : () => scene.userData.renderSingleLayer(renderer, scene, camera);
function setMode(mode) {
  lod.enabled = mode === 'platform';   // 'nolod' = today's pass structure on full geometry
  for (const r of roots) r.visible = mode !== 'empty';   // 'empty' = fixed cost (clear + sync)
}

// Per-frame latency: render + readPixels sync on every frame (the GPU finishes each frame).
function sampleFrames(mode, n, acc) {
  setMode(mode);
  const draw = drawFor(mode);
  for (let i = 0; i < 5; i++) { look.update(); draw(); sync(); }   // settle after the switch
  renderer.info.autoReset = false;
  for (let i = 0; i < n; i++) {
    look.update();
    renderer.info.reset();
    const qy = timer ? gl.createQuery() : null;
    if (qy) gl.beginQuery(timer.TIME_ELAPSED_EXT, qy);
    const t0 = performance.now();
    draw();
    if (qy) gl.endQuery(timer.TIME_ELAPSED_EXT);
    sync();
    acc.cpu.push(performance.now() - t0);
    if (qy) acc.queries.push(qy);
    acc.tris = renderer.info.render.triangles; acc.calls = renderer.info.render.calls;
  }
  renderer.info.autoReset = true;
}
// Throughput: frames queued back to back, one sync at the end (how a real page pipelines).
function sampleThroughput(mode, n) {
  setMode(mode);
  const draw = drawFor(mode);
  draw(); sync();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) { look.update(); draw(); }
  sync();
  return (performance.now() - t0) / n;
}

// Modes are interleaved in rounds so thermal / clock drift hits every mode equally.
async function runPr(pr, rows) {
  renderer.setPixelRatio(pr);
  renderer.setSize(W, H, false);
  const acc = Object.fromEntries(MODES.map((m) => [m, { cpu: [], queries: [], thr: [], tris: 0, calls: 0 }]));
  for (const m of MODES) { setMode(m); for (let i = 0; i < 20; i++) { look.update(); drawFor(m)(); sync(); } } // warm-up
  const ROUNDS = 5;
  for (let r = 0; r < ROUNDS; r++) {
    for (const m of MODES) {
      sampleFrames(m, Math.ceil(N / ROUNDS), acc[m]);
      acc[m].thr.push(sampleThroughput(m, Math.ceil(N / ROUNDS)));
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  setMode('platform');
  for (const m of MODES) {
    const a = acc[m];
    let gpu = null;
    if (timer && !gl.getParameter(timer.GPU_DISJOINT_EXT)) {
      gpu = a.queries.map((qy) => gl.getQueryParameter(qy, gl.QUERY_RESULT_AVAILABLE) ? gl.getQueryParameter(qy, gl.QUERY_RESULT) / 1e6 : null).filter((v) => v != null);
    }
    a.queries.forEach((qy) => gl.deleteQuery(qy));
    rows.push({
      scan: SCAN.split('/').pop(), mode: m, pr, n: a.cpu.length,
      median: +pct(a.cpu, 0.5).toFixed(2), p95: +pct(a.cpu, 0.95).toFixed(2),
      mean: +(a.cpu.reduce((x, y) => x + y, 0) / a.cpu.length).toFixed(3),
      pipelined: +pct(a.thr, 0.5).toFixed(3),
      gpuMedian: gpu?.length ? +pct(gpu, 0.5).toFixed(3) : null,
      triangles: a.tris, calls: a.calls,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
      bufferMB: +(gpuBytes() / 1048576).toFixed(1)
    });
  }
}

// Does switching between the LOD and the full scan change brightness? Renders the same
// frame both ways (time frozen) and compares relative luminance per pixel. WCAG counts a
// flash as a >=10% luminance change over a sizeable area; a level swap should touch only
// scattered silhouette pixels and leave the mean unchanged.
function swapCheck() {
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  const w = W, h = H;
  const grab = (lodOn) => {
    setMode(lodOn ? 'platform' : 'nolod');
    scene.userData.renderSingleLayer(renderer, scene, camera);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = new Float32Array(w * h);
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    for (let i = 0; i < w * h; i++) lum[i] = 0.2126 * lin(px[i * 4]) + 0.7152 * lin(px[i * 4 + 1]) + 0.0722 * lin(px[i * 4 + 2]);
    return lum;
  };
  const motion = look.settings.motion;
  look.set('motion', 0);           // freeze the animation so only the geometry differs
  look.update();
  const full = grab(false), lodL = grab(true);
  look.set('motion', motion);
  let sumF = 0, sumL = 0, changed = 0, lit = 0;
  for (let i = 0; i < full.length; i++) {
    sumF += full[i]; sumL += lodL[i];
    if (full[i] > 0.01 || lodL[i] > 0.01) lit++;
    if (Math.abs(full[i] - lodL[i]) >= 0.1) changed++;
  }
  return {
    meanLumFull: +(sumF / full.length).toFixed(5), meanLumLod: +(sumL / full.length).toFixed(5),
    pixelsChanged10pct: changed, ofObjectPixels: lit, changedFrac: +(changed / Math.max(1, lit)).toFixed(5)
  };
}

// Photosafety of the platform path (safety-test.html only covers the v1 path). Same method
// as safety-test.js: 480x360, fixed 60 fps timestep, model turning 20 deg/s, per-tile
// (80x60) relative luminance, a transition = a >=0.10 swing with the darker side < 0.80,
// flash = a pair; worst tile's flashes in any 1 s window. `toggleEvery` forces the LOD on/off
// every k frames -- far harsher than real use (hysteresis means a swap happens only when
// zooming across the threshold), so passing it bounds what a swap can ever do.
function flashTest(toggleEvery = 0, seconds = 6) {
  const FW = 480, FH = 360, TW = 80, TH = 60, FPS = 60;
  renderer.setPixelRatio(1);
  renderer.setSize(FW, FH, false);
  camera.aspect = FW / FH; camera.updateProjectionMatrix();
  const lin = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const tx = FW / TW, ty = FH / TH, n = seconds * FPS;
  const tiles = Array.from({ length: tx * ty }, () => new Float32Array(n));
  const px = new Uint8Array(FW * FH * 4);
  const root = roots[0];
  const rot0 = root.rotation.y;
  let blown = 0;
  setMode('platform');
  for (let f = 0; f < n; f++) {
    root.rotation.y = rot0 + THREE.MathUtils.degToRad(20) * f / FPS;
    root.updateMatrixWorld(true);
    if (toggleEvery) lod.enabled = Math.floor(f / toggleEvery) % 2 === 0;
    for (const m of Object.values(look.parents)) m.update(f / FPS);
    scene.userData.renderSingleLayer(renderer, scene, camera);
    gl.readPixels(0, 0, FW, FH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const sums = new Float32Array(tx * ty);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const p = (y * FW + x) * 4;
      const L = 0.2126 * lin[px[p]] + 0.7152 * lin[px[p + 1]] + 0.0722 * lin[px[p + 2]];
      if (L > 0.95) blown++;
      sums[Math.floor(y / TH) * tx + Math.floor(x / TW)] += L;
    }
    for (let t = 0; t < sums.length; t++) tiles[t][f] = sums[t] / (TW * TH);
  }
  root.rotation.y = rot0; root.updateMatrixWorld(true);
  lod.enabled = true;
  let worst = 0;
  for (const L of tiles) {
    const tr = [];
    let ext = L[0], dir = 0;
    for (let f = 1; f < n; f++) {
      const d = L[f] - ext;
      if (dir >= 0 && L[f] > ext) { ext = L[f]; dir = 1; continue; }
      if (dir <= 0 && L[f] < ext) { ext = L[f]; dir = -1; continue; }
      if (Math.abs(d) >= 0.1 && Math.min(L[f], ext) < 0.8) { tr.push(f); dir = d > 0 ? 1 : -1; ext = L[f]; }
    }
    for (let i = 0; i < tr.length; i++) { let j = i; while (j < tr.length && tr[j] - tr[i] < FPS) j++; worst = Math.max(worst, Math.floor((j - i) / 2)); }
  }
  camera.aspect = W / H; camera.updateProjectionMatrix();
  renderer.setSize(W, H, false);
  return { toggleEvery, flashesPerSecond: worst, verdict: worst <= 3 ? 'PASS' : 'FAIL', blownPct: +(100 * blown / (FW * FH * n)).toFixed(2) };
}

function show(rows) {
  const cols = Object.keys(rows[0]);
  document.getElementById('out').innerHTML =
    `<tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>` +
    rows.map((r) => `<tr>${cols.map((c) => `<td>${r[c] ?? '–'}</td>`).join('')}</tr>`).join('');
}

try {
  const { parts } = await load();
  status(`loaded (${parts} parts); timing ${N} frames per run…`);
  await new Promise((r) => setTimeout(r, 50));
  const rows = [];
  for (const pr of PRS) { await runPr(pr, rows); show(rows); }
  status(`done · ${parts} parts · GPU timer ${timer ? 'available' : 'not exposed (CPU+sync time only)'} · ${renderer.getContext().getParameter(renderer.getContext().VERSION)}`);
  const swap = swapCheck();
  const flash = q.get('flash') === '0' ? [] : [flashTest(0), flashTest(10)];
  document.getElementById('out').insertAdjacentHTML('afterend', `<pre>Photosafety, platform path (LOD normal; LOD forced on/off every 10 frames): ${JSON.stringify(flash)}</pre>`);
  document.getElementById('out').insertAdjacentHTML('afterend', `<pre>LOD vs full, same frame: ${JSON.stringify(swap)}</pre>`);
  window.perfResult = { rows, parts, timer: !!timer, lod: lod.stats(), swap, flash };
} catch (err) {
  console.error(err);
  status(`failed: ${err.message}`);
  window.perfResult = { error: err.message };
}

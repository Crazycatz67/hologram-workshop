// Photosensitivity test for the hologram look: renders frames deterministically, measures
// brightness the way WCAG 2.3.1 defines a flash, and reports flashes per second.
//
// Why a measured test and not eyeballing: the owner reported "blooming and flashing" that
// some people cannot tolerate. Flashing is a safety property with a published threshold
// (no more than 3 general flashes in any 1-second period), so "fixed" has to mean a number
// under that threshold, re-checked on every change -- the same way test.html guards
// gestures.
//
// Method (a simplified PEAT-style analysis, conservative on purpose):
//   - Render the chair with a given look at a fixed 60 fps timestep for DURATION seconds,
//     rotating at 20 deg/s (sparkle and bloom only show up when the surface moves),
//     on black (worst-case contrast; the live page shows a camera feed).
//   - Relative luminance per pixel (sRGB -> linear, Rec.709 weights), averaged per tile.
//     Tiles approximate WCAG's "25% of a 10-degree visual field" (~170x128 px on a laptop
//     at arm's length); the render is ~half size, so tiles are 80x60.
//   - A transition = luminance moving >= 0.10 from the last extreme in the opposite
//     direction, with the darker state below 0.80. A flash = a pair of transitions.
//     Report the worst tile's max flashes in any 1-second window.
//   - Also report: blown-out pixels (L > 0.95, the "bloom" hot spots) and per-pixel
//     frame-to-frame luminance change (shimmer/sparkle).
//   - Mode switches (idle <-> grab brightness) are simulated every 0.4 s, because the live
//     page changes brightness on every gesture start and stop.

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const V = new URL(import.meta.url).search;
const { default: HolographicMaterial } = await import('./HolographicMaterial.js' + V);
const look = await import('./hologramLook.js' + V).catch(() => null);

const W = 480, H = 360, FPS = 60, DURATION = 6;
const TILE_W = 80, TILE_H = 60;
const FLASH_DELTA = 0.10, DARK_LIMIT = 0.80;

const out = document.getElementById('out');
const log = (s) => { out.textContent += s + '\n'; };

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
document.getElementById('view').append(renderer.domElement);
const gl = renderer.getContext();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(45, W / H, 0.01, 50);

// Two subjects: the chair (little self-overlap) and the raw chess scan (many stacked
// layers -- the case where additive "bloom" stacking shows up).
const chairObj = new OBJLoader().parse(await (await fetch('./assets/chair/chair_clean.obj')).text());
const chessObj = await new Promise((res, rej) => new GLTFLoader().load('./assets/chess/chess.glb', (g) => res(g.scene), undefined, rej));
const pivot = new THREE.Group();
scene.add(pivot);
let chair;   // the current subject
function useSubject(obj) {
  pivot.clear();
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.sub(box.getCenter(new THREE.Vector3()));
  const size = box.getSize(new THREE.Vector3()).length();
  camera.position.set(0, size * 0.45, size * 1.1);
  camera.lookAt(0, 0, 0);
  pivot.add(obj);
  chair = obj;
}
useSubject(chairObj);

// The v1 pages' parameters (hologram.js / main.js) -- the look people actually saw.
const V1_PARAMS = {
  hologramColor: '#4fd1ff', hologramBrightness: 1.25, fresnelAmount: 0.45, fresnelOpacity: 1.0,
  scanlineSize: 40.0, signalSpeed: 0.6, hologramOpacity: 1.0, enableBlinking: true, blinkFresnelOnly: true
};
const MODE_BRIGHTNESS = { idle: 1.25, grab: 1.8 };

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LUT = new Float32Array(256).map((_, i) => srgbToLinear(i));

function analyse(frames) {
  const tilesX = Math.floor(W / TILE_W), tilesY = Math.floor(H / TILE_H);
  const n = frames.length;
  const tileL = Array.from({ length: tilesX * tilesY }, () => new Float32Array(n));
  let blown = 0, shimmer = 0;
  let prev = null;
  for (let f = 0; f < n; f++) {
    const px = frames[f];
    const lum = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) {
      lum[i] = 0.2126 * LUT[px[p]] + 0.7152 * LUT[px[p + 1]] + 0.0722 * LUT[px[p + 2]];
      if (lum[i] > 0.95) blown++;
    }
    if (prev) for (let i = 0; i < lum.length; i++) shimmer += Math.abs(lum[i] - prev[i]);
    prev = lum;
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
      let s = 0;
      for (let y = ty * TILE_H; y < (ty + 1) * TILE_H; y++)
        for (let x = tx * TILE_W; x < (tx + 1) * TILE_W; x++) s += lum[y * W + x];
      tileL[ty * tilesX + tx][f] = s / (TILE_W * TILE_H);
    }
  }
  // WCAG-style transition counting per tile, then the worst 1 s window.
  let worstFlashes = 0, worstTile = -1;
  tileL.forEach((L, t) => {
    const transitions = [];
    let ext = L[0], dir = 0;
    for (let f = 1; f < n; f++) {
      const d = L[f] - ext;
      if (dir >= 0 && L[f] > ext) { ext = L[f]; dir = 1; continue; }
      if (dir <= 0 && L[f] < ext) { ext = L[f]; dir = -1; continue; }
      if (Math.abs(d) >= FLASH_DELTA && Math.min(L[f], ext) < DARK_LIMIT) {
        transitions.push(f);
        dir = d > 0 ? 1 : -1;
        ext = L[f];
      }
    }
    for (let i = 0; i < transitions.length; i++) {
      let j = i;
      while (j < transitions.length && transitions[j] - transitions[i] < FPS) j++;
      const flashes = Math.floor((j - i) / 2);
      if (flashes > worstFlashes) { worstFlashes = flashes; worstTile = t; }
    }
  });
  return {
    flashesPerSecond: worstFlashes,
    worstTile,
    blownPct: (100 * blown) / (W * H * n),
    shimmer: shimmer / (W * H * (n - 1)),
  };
}

async function run(label, material, { setBrightness, prepare, legacyTime = false } = {}) {
  chair.traverse((c) => { if (c.isMesh) c.material = material; });
  prepare?.(chair);
  const frames = [];
  for (let f = 0; f < FPS * DURATION; f++) {
    const t = f / FPS;
    pivot.rotation.y = THREE.MathUtils.degToRad(20 * t);
    const mode = Math.floor(t / 0.4) % 2 ? 'grab' : 'idle';
    setBrightness(material, MODE_BRIGHTNESS[mode]);
    material.update(t);   // deterministic time, not the wall clock
    if (legacyTime) material.uniforms.time.value = t;  // the old material ignores update()'s argument
    if (scene.userData.renderSingleLayer) scene.userData.renderSingleLayer(renderer, scene, camera);
    else renderer.render(scene, camera);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    frames.push(px);
    if (f % 60 === 0) await new Promise((r) => setTimeout(r));
  }
  const r = analyse(frames);
  const verdict = r.flashesPerSecond <= 3 ? 'PASS' : 'FAIL';
  log(`${verdict}  ${label.padEnd(34)} ${String(r.flashesPerSecond).padStart(3)} flashes/s (limit 3)` +
      `   blown-out ${r.blownPct.toFixed(2)}%   shimmer ${(r.shimmer * 1000).toFixed(2)}e-3`);
  return { label, verdict, ...r };
}

const firstMaterial = (o) => { let m; o.traverse((c) => { if (c.isMesh && !m) m = c.material; }); return m; };
const results = [];
const direct = (m, b) => { m.uniforms.hologramBrightness.value = b; };
const eased = (m, b) => (m.setBrightness ? m.setBrightness(b) : direct(m, b));

// Hand-rolled "legacy" run: whatever HolographicMaterial currently is, driven the way v1
// drove it (brightness written straight to the uniform on every mode change).
results.push(await run('v1 settings, as v1 drives it', new HolographicMaterial(V1_PARAMS), { setBrightness: direct, legacyTime: !HolographicMaterial.prototype.setBrightness }));
if (look) {
  results.push(await run('v1 settings + comfort look', new HolographicMaterial(V1_PARAMS),
    { setBrightness: eased, prepare: (o) => { look.prepareHologram(o); look.enableSingleLayer(scene, [firstMaterial(o)]); } }));
  results.push(await run('reduced motion', new HolographicMaterial({ ...V1_PARAMS, motion: 0 }),
    { setBrightness: eased, prepare: (o) => { look.prepareHologram(o); look.enableSingleLayer(scene, [firstMaterial(o)]); } }));
}
// Bloom check on the multi-layer chess scan: same look, with and without single-layer.
useSubject(chessObj);
delete scene.userData.renderSingleLayer;
results.push(await run('chess scan, additive stacking', new HolographicMaterial(V1_PARAMS), { setBrightness: eased }));
if (look) {
  results.push(await run('chess scan + comfort look', new HolographicMaterial(V1_PARAMS),
    { setBrightness: eased, prepare: (o) => { look.prepareHologram(o); look.enableSingleLayer(scene, [firstMaterial(o)]); } }));
}
window.safetyResults = results;
log(results.every((r) => r.verdict === 'PASS') ? '\nALL PASS' : '\nSOME FAIL');

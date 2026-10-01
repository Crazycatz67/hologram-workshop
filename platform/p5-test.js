// P5 checks: Track B completion output (`usemtl scanned` / `usemtl inferred` + JSON sidecar)
// loaded through the Platform's own code (upload.js -> segment.js -> look.js).
//
//   A. Contract: the inferred share read from the faces matches the sidecar; the scanned
//      triangles come out of the split EXACTLY as measured (count, area, position checksum);
//      a complete scan infers nothing; sidecar parsing; .json grouping with its model.
//   B. Look: scanned meshes get the unchanged hologram material; inferred ones the hatched
//      variant; "As scanned" hides inferred surfaces in BOTH passes (no depth hole in the
//      single-layer pre-pass); hatch contrast stays under the ITU-R BT.1702 pattern limit.
//   C. Photosafety: the same flash measure as safety-test.html (WCAG 2.3.1, <= 3 flashes in
//      any 1 s), on the completed chair turning underside-up, with and without the I toggle
//      being hammered every 0.4 s.
//
// Needs completion/out/chair_underside_completed.{obj,json} and chair_completed.{obj,json}
// (git-ignored Track B outputs; see the P5 report for the command that makes them).

import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

const V = new URL(import.meta.url).search;
const { parseGroup, groupFiles, separateInferred, readSidecar } = await import('./upload.js' + V);
const { splitComponents } = await import('./segment.js' + V);
const { createLook, INFERRED_DIM, INFERRED_HATCH } = await import('./look.js' + V);
const { default: HolographicMaterial } = await import('../HolographicMaterial.js' + V);

const out = document.getElementById('out');
out.textContent = '';
const log = (s) => { out.textContent += s + '\n'; };
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

const fileFrom = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} (make the Track B outputs first)`);
  return new File([await res.blob()], url.split('/').pop());
};
const DIR = '../completion/out/';
const underObj = await fileFrom(DIR + 'chair_underside_completed.obj');
const underJson = await fileFrom(DIR + 'chair_underside_completed.json');
const fullObj = await fileFrom(DIR + 'chair_completed.obj');

// ---- A. contract ---------------------------------------------------------------------------
// Reference: the scanned faces straight from OBJLoader (no Platform code involved).
function scannedRef(object) {
  let tris = 0, area = 0, sum = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  object.traverse((m) => {
    if (!m.isMesh) return;
    const mats = [m.material].flat();
    const pos = m.geometry.attributes.position;
    const groups = m.geometry.groups.length ? m.geometry.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
    for (const g of groups) {
      if (/inferred/i.test(mats[g.materialIndex]?.name ?? '')) continue;
      for (let v = g.start; v < g.start + g.count; v += 3) {
        a.fromBufferAttribute(pos, v); b.fromBufferAttribute(pos, v + 1); c.fromBufferAttribute(pos, v + 2);
        sum += a.x + 2 * a.y + 3 * a.z + b.x + 2 * b.y + 3 * b.z + c.x + 2 * c.y + 3 * c.z;
        area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
        tris++;
      }
    }
  });
  return { tris, area, sum };
}
// The same numbers over every non-inferred mesh after the Platform's split.
function scannedAfter(root) {
  let tris = 0, area = 0, sum = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  root.traverse((m) => {
    if (!m.isMesh || m.userData.inferred) return;
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const n = (idx ? idx.count : pos.count) / 3;
    for (let t = 0; t < n; t++) {
      const v = [0, 1, 2].map((k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k));
      a.fromBufferAttribute(pos, v[0]); b.fromBufferAttribute(pos, v[1]); c.fromBufferAttribute(pos, v[2]);
      sum += a.x + 2 * a.y + 3 * a.z + b.x + 2 * b.y + 3 * b.z + c.x + 2 * c.y + 3 * c.z;
      area += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
      tris++;
    }
  });
  return { tris, area, sum };
}

const ref = scannedRef(new OBJLoader().parse(await underObj.text()));
const sidecar = readSidecar(await underJson.text(), underJson.name);
const scan = await parseGroup({ kind: 'scan', name: underObj.name, main: underObj, sidecars: [] });
const measured = scan.completion.inferredArea / scan.completion.totalArea;
check('underside chair is recognised as completion output', scan.completion.isCompletion,
  `${scan.completion.inferredTris.toLocaleString()} of ${scan.completion.totalTris.toLocaleString()} faces inferred (sidecar says ${sidecar.inferredFaces?.toLocaleString()})`);
check('inferred faces match the sidecar exactly', scan.completion.inferredTris === sidecar.inferredFaces && scan.completion.totalTris === sidecar.totalFaces);
check('inferred AREA share measured in the browser matches the sidecar (+-0.001)', Math.abs(measured - sidecar.inferredShare) < 0.001,
  `measured ${(measured * 100).toFixed(2)}%, sidecar ${(sidecar.inferredShare * 100).toFixed(2)}%`);
const seg = splitComponents(scan.object);
const stats = separateInferred(seg.root);
const after = scannedAfter(seg.root);
check('scanned triangles survive the split unchanged: count', after.tris === ref.tris, `${after.tris} vs ${ref.tris}`);
check('scanned triangles unchanged: area (1e-6 rel)', Math.abs(after.area - ref.area) / ref.area < 1e-6, `${after.area.toFixed(6)} vs ${ref.area.toFixed(6)} m²`);
check('scanned triangles unchanged: position checksum (1e-6 rel)', Math.abs(after.sum - ref.sum) / Math.abs(ref.sum) < 1e-6);
let infTris = 0, noAttr = true;
seg.root.traverse((m) => {
  if (!m.isMesh) return;
  if (m.geometry.attributes.inferred) noAttr = false;
  if (m.userData.inferred) infTris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
});
check('every inferred face lands in an inferred mesh', infTris === scan.completion.inferredTris,
  `${infTris} (${stats.meshesWithInferred} meshes: ${stats.wholeInferred} all-inferred parts, ${stats.meshesWithInferred - stats.wholeInferred} child patches)`);
check('working attribute removed after the split (clean export)', noAttr);
let shareTagged = 0;
seg.parts.forEach((p) => { if (p.mesh.userData.inferredShare > 0) shareTagged++; });
check('parts holding inferred geometry carry userData.inferredShare (measurements.js tag)', shareTagged > 0, `${shareTagged} parts`);

const full = await parseGroup({ kind: 'scan', name: fullObj.name, main: fullObj, sidecars: [] });
const fullStats = separateInferred(splitComponents(full.object).root);
check('complete chair: completion output, 0 inferred faces', full.completion.isCompletion && full.completion.inferredTris === 0 && fullStats.meshesWithInferred === 0);

let threw = false;
try { readSidecar('{nope', 'bad.json'); } catch { threw = true; }
check('malformed sidecar throws a readable error', threw);
check('out-of-range share is dropped, not trusted', readSidecar('{"inferred_area_share": 3}').inferredShare === null);
const stray = new File(['{}'], 'layout.json');
const grouped = await groupFiles([underObj, underJson, stray]);
check('dropped .json pairs with its model by name; unrelated .json ignored',
  grouped.groups.length === 1 && grouped.groups[0].completionFile === underJson && grouped.ignored.includes('layout.json'));

// ---- B. look ---------------------------------------------------------------------------------
const W = 480, H = 360, FPS = 60, DURATION = 6;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
document.getElementById('view').append(renderer.domElement);
const gl = renderer.getContext();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(45, W / H, 0.01, 50);
const look = createLook({ scene, mount: null });
// Worst case, set on the uniforms directly so this page never rewrites the saved settings.
for (const p of Object.values(look.parents)) { p.uniforms.realism.value = 0; p.uniforms.blinkAmount.value = 0.08; p.motion = 1; }
const draw = () => scene.userData.renderSingleLayer(renderer, scene, camera);
const readPx = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const LUT = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const lumAt = (px, x, y) => { const p = ((H - 1 - y) * W + x) * 4; return 0.2126 * LUT[px[p]] + 0.7152 * LUT[px[p + 1]] + 0.0722 * LUT[px[p + 2]]; };

const plainHolo = new HolographicMaterial({ hologramColor: '#4fd1ff' });
const scannedMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
const infMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
infMesh.userData.inferred = true;
check('scanned surfaces keep the unchanged hologram shader', look.materialFor(scannedMesh) === look.parents.base && look.parents.base.fragmentShader === plainHolo.fragmentShader);
check('inferred surfaces get the marked variant', look.materialFor(infMesh).userData.inferred === true && /P5: inferred/.test(look.materialFor(infMesh).fragmentShader));

// Scanned plane behind, inferred plane in front, both facing the camera and filling the centre.
// Background null for section B (written while BUGS #30 wiped the pre-pass under a Color
// background; fixed 2026-10-01, and section B30 below now covers the Color-background case).
scene.background = null;
renderer.setClearColor(0x000000, 1);
camera.position.set(0, 0, 1.5); camera.lookAt(0, 0, 0);
scannedMesh.position.z = -0.2;
scannedMesh.material = look.materialFor(scannedMesh);
infMesh.material = look.materialFor(infMesh);
scene.add(scannedMesh);
look.parents.base.update(0);
draw(); const onlyScanned = readPx();
scene.add(infMesh);
draw(); const completed = readPx();
look.setShowInferred(false); draw(); const asScanned = readPx(); look.setShowInferred(true);
const region = (px) => { let s = 0, n = 0; for (let y = 150; y < 210; y++) for (let x = 210; x < 270; x++) { s += lumAt(px, x, y); n++; } return s / n; };
const Ls = region(onlyScanned), Lc = region(completed), La = region(asScanned);
check('"As scanned" shows the scan behind a hidden inferred surface (no pre-pass depth hole)', Math.abs(La - Ls) < 0.002,
  `L as-scanned ${La.toFixed(4)} vs scan alone ${Ls.toFixed(4)}`);
check('inferred surface is visibly dimmer than scanned', Lc < Ls * 0.8, `inferred ${Lc.toFixed(4)} = ${(100 * Lc / Ls).toFixed(0)}% of scanned (dim ${INFERRED_DIM}, hatch depth ${INFERRED_HATCH})`);
// Hatch contrast along a row across the inferred plane. BT.1702 treats a regular pattern as
// potentially harmful only when bars differ by >= 20 cd/m²; assume a bright 300-nit display.
let lo = 1, hi = 0;
for (let x = 150; x < 330; x++) { const L = lumAt(completed, x, 180); lo = Math.min(lo, L); hi = Math.max(hi, L); }
const NITS = 300;
check('hatch contrast under the BT.1702 pattern limit (< 20 cd/m² at 300 nits)', (hi - lo) * NITS < 20,
  `bars ${lo.toFixed(4)}-${hi.toFixed(4)} rel. lum = ${((hi - lo) * NITS).toFixed(1)} cd/m²`);
scene.remove(scannedMesh, infMesh);
scene.background = new THREE.Color(0x000000);   // back to how the Platform renders (see above)

// ---- B30. BUGS #30: single layer WITH a Color background (as every real page renders) ------
// Two scanned planes stacked on the view axis. With the pre-pass working, the stack shows only
// the front plane; if the colour pass's forced background clear wipes the pre-pass depth, the
// back plane adds its brightness. Checked for both renderers (v1 hologramLook, Platform lod).
{
  const { renderSingleLayer } = await import('../hologramLook.js' + V);
  const { createDisplayLod } = await import('./lod.js' + V);
  const lod = createDisplayLod({ scene, camera, renderer, look });
  const front = new THREE.Mesh(new THREE.PlaneGeometry(1, 1)), back = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  front.material = back.material = look.materialFor(front);
  back.position.z = -0.2;
  camera.position.set(0, 0, 1.5); camera.lookAt(0, 0, 0);
  look.parents.base.update(0);
  const centreRGB = (px) => { const p = ((H - 1 - 180) * W + 240) * 4; return `${px[p]},${px[p + 1]},${px[p + 2]}`; };
  const region = (px) => { let s = 0, n = 0; for (let y = 150; y < 210; y++) for (let x = 210; x < 270; x++) { s += lumAt(px, x, y); n++; } return s / n; };
  for (const [name, render] of [['v1 hologramLook', () => renderSingleLayer(renderer, scene, camera)], ['Platform lod', () => lod.render(renderer, scene, camera)]]) {
    scene.add(front); lod.add(front);
    render(); const alone = readPx();
    renderer.render(scene, camera); const onePass = readPx();
    scene.add(back); lod.add(back);
    render(); const stacked = readPx();
    scene.remove(front, back); lod.remove(front); lod.remove(back);
    const La = region(alone), Ls = region(stacked);
    check(`#30 ${name}: stacked surfaces don't add up with a Color background`, Math.abs(Ls - La) < 0.002,
      `centre ${centreRGB(alone)} alone -> ${centreRGB(stacked)} stacked; L ${La.toFixed(4)} -> ${Ls.toFixed(4)}`);
    let maxDiff = 0;
    for (let i = 0; i < alone.length; i++) maxDiff = Math.max(maxDiff, Math.abs(alone[i] - onePass[i]));
    check(`#30 ${name}: a single layer looks the same as a plain one-pass render`, maxDiff <= 1, `max channel diff ${maxDiff}`);
  }
}

// ---- C. photosafety (same measure as safety-test.html) -------------------------------------
const TILE_W = 80, TILE_H = 60, FLASH_DELTA = 0.10, DARK_LIMIT = 0.80;
function flashes(frames) {
  const tilesX = W / TILE_W, tilesY = H / TILE_H, n = frames.length;
  const tileL = Array.from({ length: tilesX * tilesY }, () => new Float32Array(n));
  let blown = 0;
  frames.forEach((px, f) => {
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
      let s = 0;
      for (let y = ty * TILE_H; y < (ty + 1) * TILE_H; y++) for (let x = tx * TILE_W; x < (tx + 1) * TILE_W; x++) {
        const p = (y * W + x) * 4, L = 0.2126 * LUT[px[p]] + 0.7152 * LUT[px[p + 1]] + 0.0722 * LUT[px[p + 2]];
        s += L; if (L > 0.95) blown++;
      }
      tileL[ty * tilesX + tx][f] = s / (TILE_W * TILE_H);
    }
  });
  let worst = 0;
  for (const L of tileL) {
    const tr = [];
    let ext = L[0], dir = 0;
    for (let f = 1; f < n; f++) {
      const d = L[f] - ext;
      if (dir >= 0 && L[f] > ext) { ext = L[f]; dir = 1; continue; }
      if (dir <= 0 && L[f] < ext) { ext = L[f]; dir = -1; continue; }
      if (Math.abs(d) >= FLASH_DELTA && Math.min(L[f], ext) < DARK_LIMIT) { tr.push(f); dir = d > 0 ? 1 : -1; ext = L[f]; }
    }
    for (let i = 0; i < tr.length; i++) { let j = i; while (j < tr.length && tr[j] - tr[i] < FPS) j++; worst = Math.max(worst, Math.floor((j - i) / 2)); }
  }
  return { perSecond: worst, blownPct: (100 * blown) / (W * H * n) };
}

const chair = seg.root;
look.prepare(chair);
chair.traverse((m) => { if (m.isMesh) m.material = look.materialFor(m); });
const box = new THREE.Box3().setFromObject(chair);
chair.position.sub(box.getCenter(new THREE.Vector3()));
const pivot = new THREE.Group();
pivot.add(chair);
scene.add(pivot);
const size = box.getSize(new THREE.Vector3()).length();
camera.position.set(0, -size * 0.55, size * 1.05);   // from below: the inferred underside faces the camera
camera.lookAt(0, 0, 0);

async function run(label, toggleEvery) {
  const frames = [];
  for (let f = 0; f < FPS * DURATION; f++) {
    const t = f / FPS;
    pivot.rotation.y = THREE.MathUtils.degToRad(20 * t);
    if (toggleEvery) look.setShowInferred(Math.floor(t / toggleEvery) % 2 === 0);
    look.parents.base.update(t);
    draw();
    frames.push(readPx());
    if (f % 60 === 0) await new Promise((r) => setTimeout(r));
  }
  look.setShowInferred(true);
  const r = flashes(frames);
  check(`photosafe: ${label}`, r.perSecond <= 3, `${r.perSecond} flashes/s (limit 3), blown-out ${r.blownPct.toFixed(2)}%`);
}
await run('completed chair turning, underside view', 0);
await run('same, I toggled every 0.4 s', 0.4);

const failed = results.filter((r) => !r.ok).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
window.p5Results = { passed: results.length - failed, failed, results };

// See hands.js: the entry point stamps a version onto this module's URL, and passing it
// along is what stops GitHub Pages' ten-minute cache from serving stale code.
const V = new URL(import.meta.url).search;

const THREE = await import('three');
const { createScene, startRenderLoop } = await import('../scene.js' + V);
const { default: HolographicMaterial } = await import('../HolographicMaterial.js' + V);
const { parseScanFiles, countTriangles } = await import('./upload.js' + V);
const { placeOnFloor, frameRoom, frameSingle, ROOM_THRESHOLD_M } = await import('./framing.js' + V);

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const fpsEl = $('fps');
const infoEl = $('info');

const { scene, camera, renderer, controls } = createScene();

// Same look as hologram.js / main.js, so an uploaded scan is judged through the shader that ships.
const hologramMaterial = new HolographicMaterial({
  hologramColor: '#4fd1ff',
  hologramBrightness: 1.25,
  fresnelAmount: 0.45,
  fresnelOpacity: 1.0,
  scanlineSize: 40.0,
  signalSpeed: 0.6,
  hologramOpacity: 1.0,
  enableBlinking: true,
  blinkFresnelOnly: true
});
const plainMaterial = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, roughness: 0.6, metalness: 0.0 });
const pointsMaterial = new THREE.PointsMaterial({ color: 0x4fd1ff, size: 0.01 });

window.hologram = { scene, camera, renderer, controls, model: null, material: hologramMaterial };

startRenderLoop({
  renderer, scene, camera, controls,
  onFrame: (fps) => { fpsEl.textContent = `${fps} fps`; },
  onTick: () => { hologramMaterial.update(); }
});

// Plain (opaque) mode separates "the mesh is wrong" from "the shader is hiding it".
let plain = new URLSearchParams(location.search).get('plain') === '1';
const plainBtn = $('plain');

function applyMaterials() {
  const model = window.hologram.model;
  if (!model) return;
  model.traverse((c) => {
    if (c.isMesh) c.material = plain ? plainMaterial : hologramMaterial;
    else if (c.isPoints) c.material = pointsMaterial;
  });
  plainBtn.textContent = plain ? 'Hologram look' : 'Plain material';
}
plainBtn.addEventListener('click', () => { plain = !plain; applyMaterials(); });
plainBtn.textContent = plain ? 'Hologram look' : 'Plain material';

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

function disposeModel(model) {
  scene.remove(model);
  // Geometry only: the materials are shared instances that must outlive the model.
  model.traverse((c) => c.geometry?.dispose());
}

function showScan({ object, name, parseMs }) {
  const old = window.hologram.model;
  if (old) disposeModel(old);

  const { box } = placeOnFloor(object);
  const size = box.getSize(new THREE.Vector3());
  const mode = Math.max(size.x, size.z) > ROOM_THRESHOLD_M ? 'room' : 'object';

  scene.add(object);
  window.hologram.model = object;
  applyMaterials();

  // Both keep the scan standing on y=0 (see frameBox for why this differs from v1).
  (mode === 'room' ? frameRoom : frameSingle)(box, camera, controls);

  const { tris, points } = countTriangles(object);
  const dims = [size.x, size.z, size.y].map((n) => n.toFixed(2)).join(' × ');
  const count = points ? `${points.toLocaleString()} points` : `${tris.toLocaleString()} tris`;
  infoEl.textContent = `${name}  ·  ${count}  ·  ${dims} m (W×D×H)  ·  ${mode}  ·  ${Math.round(parseMs)} ms`;
  setStatus('loaded');
  window.hologram.stats = { name, tris, points, size: size.toArray(), mode, parseMs };
}

async function loadFiles(files) {
  setStatus(`parsing ${[...files].map((f) => f.name).join(', ')}…`);
  const t0 = performance.now();
  try {
    const scan = await parseScanFiles(files);
    // Include placement in the reported time: for a big room the floor histogram isn't free.
    showScan(scan);
    scan.parseMs = performance.now() - t0;
    window.hologram.stats.parseMs = scan.parseMs;
    infoEl.textContent = infoEl.textContent.replace(/\d+ ms$/, `${Math.round(scan.parseMs)} ms`);
  } catch (err) {
    console.error(err);
    setStatus(err.message, true);
  }
}
window.loadScanFiles = loadFiles;

async function loadUrl(url) {
  setStatus('loading…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const blob = await res.blob();
    await loadFiles([new File([blob], url.split('/').pop())]);
  } catch (err) {
    setStatus(err.message, true);
  }
}
window.loadScanUrl = loadUrl;

// Drop anywhere: listen on window and cancel dragover, or the browser navigates to the file.
const dropEl = $('drop');
let depth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; dropEl.classList.add('on'); });
window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dropEl.classList.remove('on'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  depth = 0;
  dropEl.classList.remove('on');
  if (e.dataTransfer?.files.length) loadFiles(e.dataTransfer.files);
});

const picker = $('picker');
$('pick').addEventListener('click', () => picker.click());
picker.addEventListener('change', () => { if (picker.files.length) loadFiles(picker.files); picker.value = ''; });
$('sample').addEventListener('click', () => loadUrl('../assets/chair/chair_clean.obj'));

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') controls.autoRotate = !controls.autoRotate;
});

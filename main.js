// See hands.js: the entry point stamps a version onto this module's URL, and passing it
// along is what stops GitHub Pages' ten-minute cache from serving stale code.
const V = new URL(import.meta.url).search;

const { createScene, startRenderLoop } = await import('./scene.js' + V);
const { loadModel, frameObject } = await import('./loadModel.js' + V);
const { default: HolographicMaterial } = await import('./HolographicMaterial.js' + V);

const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const hintEl = document.getElementById('hint');

const { scene, camera, renderer, controls } = createScene();

// The real scan texture is fully replaced by this material's procedural shader — that's
// the intended Phase 3 look, not a hybrid of scanned color and hologram effect.
const hologramMaterial = new HolographicMaterial({
  hologramColor: '#4fd1ff',
  hologramBrightness: 1.0,
  fresnelAmount: 0.45,
  fresnelOpacity: 1.0,
  scanlineSize: 8.0,
  signalSpeed: 0.6,
  hologramOpacity: 1.0,
  enableBlinking: true,
  blinkFresnelOnly: true
});

// Live handle for tuning from the console — Phase 3's "done" bar is fresnel/color/
// brightness confirmed tunable at runtime, e.g. window.hologram.material.uniforms.
// fresnelAmount.value = 0.8
window.hologram = { scene, camera, renderer, controls, model: null, material: hologramMaterial };

startRenderLoop({
  renderer,
  scene,
  camera,
  controls,
  onFrame: (fps) => { fpsEl.textContent = `${fps} fps`; },
  onTick: () => { hologramMaterial.update(); }
});

// Pre-cleaned by clean_scan.py; see hologram.js for why cropping moved offline.
// ?model=<path> loads a different mesh, so a candidate coming out of clean_scan.py can be
// judged through the actual hologram shader (which is what ships) rather than in a separate
// grey-material preview that flatters or hides surface noise differently.
const objPath = new URLSearchParams(location.search).get('model') ?? 'assets/chair/chair_clean.obj';
loadModel({ objPath })
  .then(({ object, path }) => {
    object.traverse((child) => {
      if (child.isMesh) child.material = hologramMaterial;
    });
    scene.add(object);
    window.hologram.model = object;
    const { size } = frameObject(object, camera, controls);
    const dims = [size.x, size.y, size.z].map((n) => n.toFixed(2)).join(' × ');
    statusEl.textContent = `${path}  ·  ${dims} m`;
    hintEl.hidden = false;
  })
  .catch((err) => {
    statusEl.textContent = err.message;
    statusEl.classList.add('error');
  });

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'r') controls.autoRotate = !controls.autoRotate;
});

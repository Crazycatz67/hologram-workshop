// See hands.js: the entry point stamps a version onto this module's URL, and passing it
// along is what stops GitHub Pages' ten-minute cache from serving stale code.
const V = new URL(import.meta.url).search;

const { createScene, startRenderLoop } = await import('./scene.js' + V);
const { loadModel, frameObject } = await import('./loadModel.js' + V);
const { trimByCylinder } = await import('./trimGeometry.js' + V);

// See hologram.js for how these numbers were derived from the real scan data.
const CHAIR_TRIM = { center: { x: -0.02, z: -0.14 }, radius: 0.65 };

const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const hintEl = document.getElementById('hint');

const { scene, camera, renderer, controls } = createScene();

// Live handle for tuning from the console — Phase 3 needs the hologram material's
// properties adjustable at runtime, and it makes performance measurable on demand.
window.hologram = { scene, camera, renderer, controls, model: null };

startRenderLoop({
  renderer,
  scene,
  camera,
  controls,
  onFrame: (fps) => { fpsEl.textContent = `${fps} fps`; }
});

loadModel({
  glbPath: 'assets/chair/chair.glb',
  objPath: 'assets/chair/chair.obj',
  mtlPath: 'assets/chair/chair.mtl'
})
  .then(({ object, path }) => {
    trimByCylinder(object, CHAIR_TRIM);
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

import { createScene, startRenderLoop } from './scene.js';
import { loadModel, frameObject } from './loadModel.js';

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

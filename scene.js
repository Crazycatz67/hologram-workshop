import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createScene(container = document.body) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d10);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 0.4, 2);

  // Canvas size comes from CSS; the render loop syncs the drawing buffer to it.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotateSpeed = 1.5;

  // Scan textures come out of Scaniverse with real-world lighting already baked in,
  // so keep lighting flat and bright rather than sculpting with a strong key.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x33343f, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 4, 3);
  scene.add(key);

  return { scene, camera, renderer, controls };
}

// Checked every frame rather than driven by the window 'resize' event: the canvas can
// also change size from layout shifts that never fire one (Phase 4 adds a webcam feed
// beside the 3D view). Two property reads per frame is cheaper than getting this wrong.
export function resizeIfNeeded(renderer, camera) {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width === w * renderer.getPixelRatio() && canvas.height === h * renderer.getPixelRatio()) return;

  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// onTick runs every frame (Phase 4 drives hand tracking from it, so gestures and rendering
// stay on one clock); onFrame is only the twice-a-second FPS sample.
export function startRenderLoop({ renderer, scene, camera, controls, onTick, onFrame }) {
  let frames = 0;
  let lastSample = performance.now();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    frames++;
    if (now - lastSample >= 500) {
      const fps = Math.round((frames * 1000) / (now - lastSample));
      frames = 0;
      lastSample = now;
      if (onFrame) onFrame(fps);
    }

    // setAnimationLoop stops scheduling further frames if its callback throws — an
    // uncaught error anywhere in onTick would silently freeze the entire scene (no more
    // rendering, no more orbit controls, nothing), which is far worse than one skipped
    // gesture update. Catching here protects every onTick consumer, not just this one.
    if (onTick) {
      try {
        onTick(now);
      } catch (err) {
        console.error('onTick threw; skipping this frame:', err);
      }
    }
    resizeIfNeeded(renderer, camera);
    controls.update();
    renderer.render(scene, camera);
  });
}

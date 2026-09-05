const V = new URL(import.meta.url).search;

const { createScene, startRenderLoop } = await import('./scene.js' + V);
const { loadModel, frameObject } = await import('./loadModel.js' + V);
const { trimByCylinder } = await import('./trimGeometry.js' + V);

// Measured against this specific scan (see ROADMAP.md Phase 2/3): a histogram of vertex
// distance from this center shows a genuine empty gap between radius 0.58 and 0.77 — the
// wall sliver sits entirely outside it, the chair entirely inside. Re-derive these numbers
// from scratch if this ever runs against a different scan.
const CHAIR_TRIM = { center: { x: -0.02, z: -0.14 }, radius: 0.65 };
const { startCamera, stopCamera, describeCameraError } = await import('./camera.js' + V);
const { createHandTracker, HAND_CONNECTIONS } = await import('./handTracker.js' + V);
const { pinch, isFistShape } = await import('./gestures.js' + V);
const { drawHands, sizeOverlayTo } = await import('./overlay.js' + V);
const { createManipulator, MODE } = await import('./manipulator.js' + V);
const { default: HolographicMaterial } = await import('./HolographicMaterial.js' + V);
const { createGhostHands } = await import('./ghostHands.js' + V);

const video = document.getElementById('cam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const modeEl = document.getElementById('mode');
const readoutEl = document.getElementById('readout');
const startBtn = document.getElementById('start');
const resetBtn = document.getElementById('reset');

const { scene, camera, renderer, controls } = createScene(document.getElementById('stage'), {
  transparentBackground: true
});

let manipulator = null;
let tracker = null;
let stream = null;
let tracking = false;
let hands = [];
let lastVideoTime = -1;

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

const ghostHands = createGhostHands(scene, HAND_CONNECTIONS);
const isFist = (h) => h.gesture === 'Closed_Fist' || h.fistShape;

window.hologram = { scene, camera, renderer, controls, model: null, material: hologramMaterial };

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

loadModel({
  glbPath: 'assets/chair/chair.glb',
  objPath: 'assets/chair/chair.obj',
  mtlPath: 'assets/chair/chair.mtl'
})
  .then(({ object, path }) => {
    trimByCylinder(object, CHAIR_TRIM);
    object.traverse((child) => {
      if (child.isMesh) child.material = hologramMaterial;
    });
    scene.add(object);
    window.hologram.model = object;
    frameObject(object, camera, controls);
    manipulator = createManipulator(object, camera);
    setStatus(`${path} loaded · start the camera to control it`);
    startBtn.disabled = false;
  })
  .catch((err) => {
    setStatus(err.message, true);
  });

async function startTracking() {
  startBtn.disabled = true;
  try {
    setStatus('loading gesture model…');
    tracker = await createHandTracker({ numHands: 2 });

    setStatus('requesting camera…');
    stream = await startCamera(video);

    tracking = true;
    startBtn.textContent = 'stop camera';
    startBtn.disabled = false;
    setStatus('tracking · fist to move · two-hand pinch to scale and rotate');
  } catch (err) {
    setStatus(describeCameraError(err), true);
    startBtn.disabled = false;
    console.error(err);
  }
}

function stopTracking() {
  tracking = false;
  stopCamera(stream);
  stream = null;
  video.srcObject = null;
  hands = [];
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  ghostHands.update([], { camera, object: window.hologram.model ?? scene, aspect: 1 });
  readoutEl.textContent = '';
  modeEl.textContent = 'idle';
  startBtn.textContent = 'start camera';
  setStatus('camera stopped · drag to orbit');
}

startBtn.addEventListener('click', () => (tracking ? stopTracking() : startTracking()));
resetBtn.addEventListener('click', () => manipulator?.reset());
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'r') manipulator?.reset();
  if (key === 'd') document.body.classList.toggle('debug-camera');
});

startRenderLoop({
  renderer,
  scene,
  camera,
  controls,
  onFrame: (fps) => {
    fpsEl.textContent = `${fps} fps`;
  },
  onTick: () => {
    hologramMaterial.update();

    if (!tracking || !sizeOverlayTo(overlay, video)) return;

    const aspect = overlay.width / overlay.height;

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      hands = tracker.read(video, performance.now());
      for (const hand of hands) {
        hand.pinch = pinch(hand.landmarks, aspect, { gesture: hand.gesture });
        hand.fistShape = isFistShape(hand.landmarks, aspect);
      }

      const mode = manipulator?.update(hands, aspect) ?? MODE.IDLE;
      modeEl.textContent = mode;
      modeEl.className = mode;
      updateReadout();
    }

    // Real 3D hands (always on) are the primary visual feedback; the flat 2D skeleton
    // stays available behind the D-debug toggle for checking raw tracking accuracy.
    if (window.hologram.model) {
      ghostHands.update(hands, { camera, object: window.hologram.model, aspect, isFist });
    }
    drawHands(overlayCtx, hands, HAND_CONNECTIONS);
  }
});

function updateReadout() {
  if (hands.length === 0) {
    readoutEl.textContent = 'no hands';
    return;
  }
  readoutEl.textContent = hands
    .map((h) => {
      const p = h.pinch;
      const state = p.pinching ? 'PINCH' : p.rejectedBy ? `no (${p.rejectedBy})` : 'open';
      return `${h.handedness.padEnd(5)} ${h.gesture.padEnd(12)} ${state}`;
    })
    .join('\n');
}

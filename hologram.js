const V = new URL(import.meta.url).search;

const { createScene, startRenderLoop } = await import('./scene.js' + V);
const { loadModel, frameObject } = await import('./loadModel.js' + V);

// The model now loads pre-cleaned. Isolating the object used to happen here at runtime,
// via trimByCylinder on the raw scan — but a radius crop can only remove what is beside
// the object, never the floor underneath it, so the chair shipped standing in a visible
// crater of scanned floor. Cleaning is now an offline step (clean_scan.py), which can do
// the things a live radius crop cannot: detect the actual ground plane, keep the runners
// resting on it, rebuild the leg the scanner missed, and weld the result watertight.
const { startCamera, stopCamera, describeCameraError } = await import('./camera.js' + V);
const { createHandTracker, HAND_CONNECTIONS } = await import('./handTracker.js' + V);
const { pinch, isFistLike, handSpan } = await import('./gestures.js' + V);
const { drawHands, sizeOverlayTo } = await import('./overlay.js' + V);
const { createManipulator, MODE, CHANNELS } = await import('./manipulator.js' + V);
const { default: HolographicMaterial } = await import('./HolographicMaterial.js' + V);
const { createGhostHands } = await import('./ghostHands.js' + V);
const { smoothHandLandmarks, resetLandmarkSmoothing } = await import('./smoothLandmarks.js' + V);

const video = document.getElementById('cam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const modeEl = document.getElementById('mode');
const startBtn = document.getElementById('start');
const resetBtn = document.getElementById('reset');

const panelEl = document.getElementById('panel');
const drillsEl = document.getElementById('drills');
const lampEl = document.getElementById('lamp');
const liveTextEl = document.getElementById('liveText');
const coachTitleEl = document.getElementById('coachTitle');
const coachBodyEl = document.getElementById('coachBody');

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
const isFist = (h) => h.fistLike;

// Interaction-tied visual feedback on the hologram itself, in place of haptics this can't
// have — requested directly during testing ("depending on what we're interacting with,
// add more color"). This is the coarse whole-object version; per-region glow (e.g. just
// the legs while rotating) is a bigger, separate undertaking, not done here.
const MODE_BRIGHTNESS = { idle: 1.0, grab: 1.6, transform: 1.6 };

window.hologram = { scene, camera, renderer, controls, model: null, material: hologramMaterial };

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

loadModel({ objPath: 'assets/chair/chair_clean.obj' })
  .then(({ object, path }) => {
    object.traverse((child) => {
      if (child.isMesh) child.material = hologramMaterial;
    });
    scene.add(object);
    window.hologram.model = object;
    frameObject(object, camera, controls);
    manipulator = createManipulator(object, camera);
    // Same live-tuning handle the material already uses — lets thresholds be poked from the
    // console (window.hologram.manipulator.configure({ sensitivity: 0.4 })) without a redeploy.
    window.hologram.manipulator = manipulator;
    applyDrill(activeDrill);
    applyTuning();
    // Decided once from the loaded model's own mesh count — see manipulator.js. No manual
    // override control exists yet since only a single-mesh scan exists to test against.
    document.getElementById('explodeMode').textContent = manipulator.explodeIsLiteral
      ? 'explode: literal'
      : 'explode: stretch';
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
    setStatus('tracking');
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
  resetLandmarkSmoothing();
  hologramMaterial.uniforms.hologramBrightness.value = MODE_BRIGHTNESS.idle;
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  ghostHands.update([], { camera, object: window.hologram.model ?? scene, aspect: 1 });
  setLive(false, 'camera off');
  modeEl.textContent = 'idle';
  modeEl.className = '';
  startBtn.textContent = 'start camera';
  setStatus('camera stopped · drag to orbit');
}

startBtn.addEventListener('click', () => (tracking ? stopTracking() : startTracking()));
resetBtn.addEventListener('click', () => manipulator?.reset());
window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'r') manipulator?.reset();
  if (key === 'd') document.body.classList.toggle('debug-camera');
  if (key === 'p') togglePanel();
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
      smoothHandLandmarks(hands);
      for (const hand of hands) {
        hand.pinch = pinch(hand.landmarks, aspect, { gesture: hand.gesture });
        hand.fistLike = isFistLike(hand.gesture, hand.landmarks, aspect);
      }

      const mode = manipulator?.update(hands, aspect) ?? MODE.IDLE;
      modeEl.textContent = mode;
      modeEl.className = mode;
      hologramMaterial.uniforms.hologramBrightness.value = MODE_BRIGHTNESS[mode] ?? 1.0;
      updateLive(mode);
    }

    // Real 3D hands (always on) are the primary visual feedback; the flat 2D skeleton
    // stays available behind the D-debug toggle for checking raw tracking accuracy.
    if (window.hologram.model) {
      ghostHands.update(hands, { camera, object: window.hologram.model, aspect, isFist });
    }
    drawHands(overlayCtx, hands, HAND_CONNECTIONS);
  }
});

// ---------------------------------------------------------------------------------------
// Practice drills. Reported live: "it keeps accidentally moving around and doing commands I
// never intended", with a request to "test each feature separately without it bleeding
// across". One closed fist drives move, spin, tilt AND push simultaneously, so with
// everything armed there is no way to tell which channel misfired, and no way to build any
// feel for one of them. Each drill arms exactly one channel in the manipulator; every other
// gesture becomes genuinely inert rather than merely ignored.
const DRILLS = [
  {
    id: 'free',
    label: 'Everything on',
    sub: 'normal use',
    channels: CHANNELS,
    title: 'All gestures active',
    body: 'Fist — move, twist to spin, hand nearer/farther to push-pull · second hand up/down — tilt · two-hand pinch — scale · two open hands apart — explode · clap — reset'
  },
  {
    id: 'move',
    label: 'Move',
    sub: 'fist, slide it around',
    channels: ['move'],
    title: 'Move',
    body: 'Close one hand into a fist and slide it around. Spin, tilt and push are switched off, so it can only translate — nothing else can fire while you get the feel of it.'
  },
  {
    id: 'spin',
    label: 'Spin',
    sub: 'fist, twist your wrist',
    channels: ['spin'],
    title: 'Spin',
    body: 'Make a fist and twist your wrist like turning a doorknob. It will not drift while you do — movement is disarmed, so only rotation responds.'
  },
  {
    id: 'tilt',
    label: 'Tilt',
    sub: 'second hand up / down',
    channels: ['tilt'],
    title: 'Tilt',
    body: 'Hold a fist with one hand to take hold, then raise and lower your OTHER hand to tip it toward or away from you. The second hand can be any shape.'
  },
  {
    id: 'push',
    label: 'Push / pull',
    sub: 'fist nearer / farther',
    channels: ['push'],
    title: 'Push and pull',
    body: 'Make a fist, then move it toward the camera to pull the chair closer, and away to push it back. It is judged by how big your hand looks in frame, so keep the whole hand visible.'
  },
  {
    id: 'scale',
    label: 'Scale',
    sub: 'two-hand pinch',
    channels: ['scale'],
    title: 'Scale',
    body: 'Pinch thumb and index on BOTH hands at once, then move your hands apart to grow it and together to shrink it. Both hands must read as pinching before it engages.'
  },
  {
    id: 'explode',
    label: 'Explode',
    sub: 'two open hands apart',
    channels: ['explode'],
    title: 'Explode / stretch',
    body: 'Hold both hands open — not fisted, not pinching — and pull them apart. On a single-mesh scan like this chair it stretches rather than separating into parts.'
  },
  {
    id: 'reset',
    label: 'Clap reset',
    sub: 'clap open hands',
    channels: ['clap'],
    title: 'Clap to reset',
    body: 'Open both hands wide apart, then bring them together quickly. It has to be genuinely quick — drifting them together slowly deliberately will not count.'
  }
];

let activeDrill = DRILLS[0];

function applyDrill(drill) {
  activeDrill = drill;
  manipulator?.configure({ channels: drill.channels });
  coachTitleEl.textContent = drill.title;
  coachBodyEl.textContent = drill.body;
  for (const btn of drillsEl.children) btn.classList.toggle('active', btn.dataset.id === drill.id);
}

for (const drill of DRILLS) {
  const btn = document.createElement('button');
  btn.dataset.id = drill.id;
  const name = document.createElement('span');
  name.className = 'k';
  name.textContent = drill.label;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = drill.sub;
  btn.append(name, sub);
  btn.addEventListener('click', () => applyDrill(drill));
  drillsEl.appendChild(btn);
}

function togglePanel() {
  const hidden = panelEl.classList.toggle('hidden');
  document.getElementById('togglePanel').textContent = hidden ? 'show panel' : 'hide panel';
}
document.getElementById('togglePanel').addEventListener('click', togglePanel);

// Feel controls. Every sensitivity and threshold in manipulator.js is an untuned guess made
// without a webcam (see ROADMAP.md Phase 1). These make them adjustable against real hands
// instead of needing a code edit and a redeploy per attempt.
const sensEl = document.getElementById('sens');
const sensValEl = document.getElementById('sensVal');
const trigEl = document.getElementById('trig');
const trigValEl = document.getElementById('trigVal');
const momentumEl = document.getElementById('momentum');

function applyTuning() {
  const sensitivity = Number(sensEl.value);
  const triggerFrames = Number(trigEl.value);
  sensValEl.textContent = sensitivity.toFixed(1) + '×';
  trigValEl.textContent = triggerFrames + (triggerFrames === 1 ? ' frame' : ' frames');
  manipulator?.configure({ sensitivity, triggerFrames, momentum: momentumEl.checked });
}
sensEl.addEventListener('input', applyTuning);
trigEl.addEventListener('input', applyTuning);
momentumEl.addEventListener('change', applyTuning);

applyDrill(DRILLS[0]);
applyTuning();

function setLive(on, text) {
  lampEl.classList.toggle('on', on);
  liveTextEl.textContent = text;
}

// What the active drill is actually seeing right now, so a gesture that refuses to fire says
// WHY (no fist detected, only one hand, not pinching) rather than just doing nothing.
function updateLive(mode) {
  if (hands.length === 0) {
    setLive(false, 'no hands in frame');
    return;
  }

  const fists = hands.filter((h) => h.fistLike).length;
  const pinches = hands.filter((h) => h.pinch?.pinching).length;
  const open = hands.filter((h) => !h.fistLike && !h.pinch?.pinching).length;

  switch (activeDrill.id) {
    case 'move':
    case 'spin':
      setLive(mode === MODE.GRAB, fists ? 'fist held · ' + mode : 'no fist yet — curl your fingers in');
      break;
    case 'tilt':
    case 'push':
      setLive(
        mode === MODE.GRAB,
        !fists
          ? 'no fist yet — one hand must take hold'
          : activeDrill.id === 'tilt' && hands.length < 2
            ? 'fist held · now raise your other hand'
            : 'fist held · ' + mode
      );
      break;
    case 'scale':
      setLive(mode === MODE.TRANSFORM, hands.length < 2 ? 'need both hands' : 'pinching: ' + pinches + '/2');
      break;
    case 'explode':
      setLive(mode === MODE.EXPLODE, hands.length < 2 ? 'need both hands' : 'open hands: ' + open + '/2');
      break;
    case 'reset':
      setLive(false, hands.length < 2 ? 'need both hands' : 'ready — clap quickly');
      break;
    default:
      setLive(mode !== MODE.IDLE, hands.length + (hands.length === 1 ? ' hand · ' : ' hands · ') + mode);
  }
}

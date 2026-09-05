// GitHub Pages serves everything with max-age=600 and offers no way to change that, so a
// push can sit invisible on another machine for ten minutes. The entry point stamps a
// version onto this module's URL; propagating that stamp to every sibling import is what
// makes a refresh actually pick up new code.
const V = new URL(import.meta.url).search;

const { startCamera, stopCamera, describeCameraError } = await import('./camera.js' + V);
const { createHandTracker, HAND_CONNECTIONS } = await import('./handTracker.js' + V);
const { pinch, handSpan, handAngle, fingerReach, isFistShape } = await import('./gestures.js' + V);
const { drawHands, sizeOverlayTo } = await import('./overlay.js' + V);

const video = document.getElementById('cam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');

const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const readoutEl = document.getElementById('readout');
const startBtn = document.getElementById('start');

let tracker = null;
let stream = null;
let running = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

async function start() {
  startBtn.disabled = true;
  try {
    setStatus('loading gesture model (~8 MB)…');
    tracker = await createHandTracker({ numHands: 2 });

    setStatus('requesting camera…');
    stream = await startCamera(video);

    setStatus(`tracking · ${video.videoWidth}×${video.videoHeight}`);
    startBtn.textContent = 'stop';
    startBtn.disabled = false;
    running = true;
    requestAnimationFrame(loop);
  } catch (err) {
    setStatus(describeCameraError(err), true);
    startBtn.disabled = false;
    console.error(err);
  }
}

function stop() {
  running = false;
  stopCamera(stream);
  stream = null;
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  readoutEl.textContent = '';
  startBtn.textContent = 'start camera';
  setStatus('stopped');
}

startBtn.addEventListener('click', () => (running ? stop() : start()));

let lastVideoTime = -1;
let hands = [];
let frames = 0;
let lastSample = performance.now();

function loop() {
  if (!running) return;

  if (sizeOverlayTo(canvas, video)) {
    const aspect = canvas.width / canvas.height;

    // recognizeForVideo() is only worth calling on a genuinely new camera frame; the
    // display refresh rate is usually higher than the camera's.
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      hands = tracker.read(video, performance.now());
      for (const hand of hands) {
        // The recognizer's own classification is passed in so a Closed_Fist can veto a
        // pinch, rather than both firing off the same balled-up hand.
        hand.pinch = pinch(hand.landmarks, aspect, { gesture: hand.gesture });
        hand.reach = fingerReach(hand.landmarks, aspect);
        hand.fistShape = isFistShape(hand.landmarks, aspect);
      }
      updateReadout(hands, aspect);
    }

    drawHands(ctx, hands, HAND_CONNECTIONS);
  }

  frames++;
  const now = performance.now();
  if (now - lastSample >= 500) {
    fpsEl.textContent = `${Math.round((frames * 1000) / (now - lastSample))} fps`;
    frames = 0;
    lastSample = now;
  }

  requestAnimationFrame(loop);
}

function updateReadout(hands, aspect) {
  if (hands.length === 0) {
    readoutEl.textContent = 'no hands detected';
    return;
  }

  const lines = hands.flatMap((h) => {
    const state = h.pinch.pinching
      ? 'PINCH'
      : h.pinch.rejectedBy
        ? `blocked:${h.pinch.rejectedBy}`
        : 'open';
    const r = h.reach;
    return [
      `${h.handedness.padEnd(5)} ${h.gesture} (${h.score.toFixed(2)})  fistShape:${h.fistShape}`,
      `      gap ${h.pinch.ratio.toFixed(2)}  ${state}`,
      r ? `      tips t${r.thumb} i${r.index} m${r.middle} r${r.ring} p${r.pinky}` : ''
    ].filter(Boolean);
  });

  // Two-hand measurements are what Phase 4 turns into scale and rotate.
  if (hands.length === 2) {
    const span = handSpan(hands[0], hands[1], aspect);
    const angle = (handAngle(hands[0], hands[1], aspect) * 180) / Math.PI;
    lines.push(`span ${span.toFixed(2)}   angle ${angle.toFixed(0)}°`);
  }

  readoutEl.textContent = lines.join('\n');
}

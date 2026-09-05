import { startCamera, stopCamera, describeCameraError } from './camera.js';
import { createHandTracker, HAND_CONNECTIONS } from './handTracker.js';
import { pinch, handSpan, handAngle } from './gestures.js';
import { drawHands, sizeOverlayTo } from './overlay.js';

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
      for (const hand of hands) hand.pinch = pinch(hand.landmarks, aspect);
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

  const lines = hands.map(
    (h) =>
      `${h.handedness.padEnd(5)} ${h.gesture} (${h.score.toFixed(2)})  pinch ${h.pinch.ratio.toFixed(2)}${h.pinch.pinching ? ' ←' : ''}`
  );

  // Two-hand measurements are what Phase 4 turns into scale and rotate.
  if (hands.length === 2) {
    const span = handSpan(hands[0], hands[1], aspect);
    const angle = (handAngle(hands[0], hands[1], aspect) * 180) / Math.PI;
    lines.push(`span ${span.toFixed(2)}   angle ${angle.toFixed(0)}°`);
  }

  readoutEl.textContent = lines.join('\n');
}

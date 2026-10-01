// Clip Lab: records the owner performing each gesture of HANDS-UX-SPEC section 6 as a
// landmark clip, so the future demo hand (tours, stuck hints) can replay real motion.
//
// Privacy: only numbers are kept. The <video> is shown so the owner can see themselves, but
// no frame, canvas or image is ever read back, stored or sent.
//
// Clip file contract (schema "gesture-clip/1"), assets/gesture-clips/<name>.json:
//   {
//     schema: 'gesture-clip/1',
//     name: 'grab-move',            // one of CLIPS below (also the file name)
//     gesture: 'grab-move',         // gesture label the clip demonstrates (= name)
//     instruction: '…',             // what the performer was asked to do
//     recordedAt: ISO-8601 string,
//     durationMs: number,           // t of the last frame
//     frameCount: number, fps: number (measured),
//     mirrored: boolean,            // true when mirrorClip() was applied (an odd number of times)
//     video: { width, height },     // source camera size, to restore the aspect of `landmarks`
//     frames: [{
//       t: ms since capture start (first frame = 0),
//       hands: [{                   // 0..2 hands, as MediaPipe reported them
//         handedness: 'Right'|'Left'|'Unknown',   // MediaPipe's label (camera-image convention)
//         gesture: 'Closed_Fist'|…|'None', score: 0..1,   // MediaPipe canned gesture per frame
//         landmarks: [[x, y, z] × 21],        // image-normalised, UNmirrored camera image: x,y in 0..1
//         worldLandmarks: [[x, y, z] × 21]    // metres, hand-centred (MediaPipe world), or null
//       }]
//     }]
//   }
// Numbers are rounded to 5 decimals (0.01 mm in world, ~0.01 px in image).
//
// mirrorClip(clip) turns a right-hand clip into a left-hand one (spec: "negate x and swap the
// label"): worldLandmarks x -> -x; image landmarks x -> 1 - x (the image-space equivalent of
// negating x, so they stay in 0..1); handedness Left <-> Right; mirrored flag toggles.
//
// Test seam: window.clipLab (see the bottom of this file). setHandSource(fn) replaces the
// tracker's output with fn(nowMs) -> hands[] (same shape as handTracker.toHands), so a headless
// run with a fake camera (which shows no hand) can still record a non-empty clip.

const ROOT = '../../../';
const CLIP_DIR = `${ROOT}assets/gesture-clips/`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const isLocal = LOCAL_HOSTS.has(location.hostname);

// [name, one-line instruction, default seconds]. Right hand unless the clip needs two.
export const CLIPS = [
  ['engage', 'Start with your hand below the frame; raise an open right hand into view and hold it.', 3],
  ['rest-lower', 'Open right hand up in view; lower it slowly out of the frame.', 3],
  ['aim-sweep', 'Point your index, curl three; sweep slowly left to right, then top to bottom.', 5],
  ['click-other', 'Right hand aims and stays still; left hand pinches once, then opens.', 3],
  ['thumb-tap', 'Right hand aims; tap your thumb once against the side of your middle finger.', 3],
  ['grab-move', 'Make a right fist, move it across the frame, then open to let go.', 4],
  ['grab-twist', 'Make a right fist, twist your wrist about 90° and back, then open.', 4],
  ['grab-push', 'Make a right fist, push toward the camera and pull back, then open.', 4],
  ['tilt', 'Hold a left fist still; raise then lower your open right hand.', 4],
  ['scale', 'Pinch both hands close together, then spread them apart and open.', 4],
  ['explode', 'Two open hands close together, palms out; spread them apart.', 3],
  ['clap', 'Two open hands apart; clap once and hold together.', 3],
  ['wheel-pick', 'Hold ✌ with your right hand, aim at a slot, pinch your left hand.', 5],
  ['wheel-cancel', 'Hold ✌ with your right hand for a second, then open your palm without picking.', 4],
  ['undo', 'Hold a right thumbs-down 👎 still for a second, then open.', 3],
  ['tape-drag', 'Right hand aims at A; left hand pinches and holds; move the aim to B; release.', 5],
  ['slider', 'Right hand pinch-hold, slide left to right, release.', 4],
  ['scroll', 'Right hand pinch-hold, drag up then down, release.', 4],
  ['lens', 'Aim to move the lens; then pinch-hold and drag up or down to resize; release.', 5],
  ['ring-spin', 'Right fist, drag sideways to spin; open; aim and pinch your left hand to open.', 5],
  ['pin', 'Hold ✌ with your right hand, aim at the top-left slot, pinch your left hand.', 4]
];

const MIN_MS = 2000;
const MAX_MS = 5000;
const COUNT_FROM = 3;

// The 21-landmark hand topology is fixed by MediaPipe; kept here (not imported from
// handTracker.js) so playback of saved clips works without loading the tracker from the CDN.
const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]
];

const $ = (id) => document.getElementById(id);
const r5 = (v) => Math.round(v * 1e5) / 1e5;

// --- pure helpers (exported for the future demo-hand consumer) ---------------------------

export function packHand(h) {
  const pts = (arr) => (arr ? arr.map((p) => [r5(p.x ?? p[0]), r5(p.y ?? p[1]), r5(p.z ?? p[2] ?? 0)]) : null);
  return {
    handedness: h.handedness ?? 'Unknown',
    gesture: h.gesture ?? 'None',
    score: r5(h.score ?? 0),
    landmarks: pts(h.landmarks),
    worldLandmarks: pts(h.worldLandmarks)
  };
}

const SWAP = { Left: 'Right', Right: 'Left' };
export function mirrorClip(clip) {
  return {
    ...clip,
    mirrored: !clip.mirrored,
    frames: clip.frames.map((f) => ({
      t: f.t,
      hands: f.hands.map((h) => ({
        ...h,
        handedness: SWAP[h.handedness] ?? h.handedness,
        // 0 - 0 would give -0; keep it a plain 0 so the JSON stays tidy.
        landmarks: h.landmarks?.map(([x, y, z]) => [r5(1 - x), y, z]) ?? null,
        worldLandmarks: h.worldLandmarks?.map(([x, y, z]) => [x === 0 ? 0 : -x, y, z]) ?? null
      }))
    }))
  };
}

// --- page state ---------------------------------------------------------------------------

const state = {
  current: CLIPS[0][0],
  saved: new Set(),
  stream: null,
  tracker: null,
  handSource: null, // test seam: fn(now) -> hands[]
  lastVideoTime: -1,
  liveHands: [],
  phase: 'idle', // idle | countdown | recording
  frames: [],
  t0: 0,
  stopAt: 0,
  take: null, // unsaved clip
  play: null, // { clip, start, frame, done }
  playedFrames: 0
};

const status = (msg) => { $('status').textContent = msg; };

function clipInfo(name) {
  const c = CLIPS.find(([n]) => n === name);
  return { name: c[0], instruction: c[1], seconds: c[2] };
}

function renderList() {
  const ul = $('clips');
  ul.textContent = '';
  for (const [name, ins] of CLIPS) {
    const li = document.createElement('li');
    li.dataset.name = name;
    if (name === state.current) li.classList.add('active');
    li.innerHTML = `<span class="name"></span><span class="saved"></span><div class="ins"></div>`;
    li.querySelector('.name').textContent = name;
    li.querySelector('.saved').textContent = state.saved.has(name) ? '✓ saved' : '';
    li.querySelector('.ins').textContent = ins;
    li.addEventListener('click', () => select(name));
    ul.appendChild(li);
  }
}

function syncButtons() {
  const busy = state.phase !== 'idle';
  $('recBtn').disabled = busy || !state.stream;
  $('stopBtn').disabled = state.phase !== 'recording';
  $('playBtn').disabled = busy || !state.take;
  $('mirrorBtn').disabled = busy || !state.take;
  $('keepBtn').disabled = busy || !state.take;
  $('discardBtn').disabled = busy || !state.take;
  $('savedBtn').disabled = busy || !state.saved.has(state.current);
  $('keepBtn').textContent = isLocal ? '✓ Keep' : '✓ Keep (download)';
}

function select(name) {
  if (state.phase !== 'idle') return;
  state.current = name;
  state.take = null;
  const info = clipInfo(name);
  $('dur').value = String(info.seconds);
  renderList();
  syncButtons();
  describeTake(null);
  status(`${name}: ${info.instruction}`);
}

async function refreshSaved() {
  try {
    const res = await fetch(`${CLIP_DIR}index.json`, { cache: 'reload' });
    if (res.ok) {
      const idx = await res.json();
      state.saved = new Set((idx.clips ?? []).map((c) => c.name));
    }
  } catch { /* no index yet: nothing saved */ }
  renderList();
  syncButtons();
}

// --- camera + tracking --------------------------------------------------------------------

async function startCam() {
  if (state.stream) return;
  $('camBtn').disabled = true;
  status('Starting camera and hand tracker…');
  const cam = await import(`${ROOT}camera.js`);
  try {
    state.stream = await cam.startCamera($('video'));
  } catch (err) {
    $('camBtn').disabled = false;
    status('Camera: ' + cam.describeCameraError(err));
    return;
  }
  try {
    const { createHandTracker } = await import(`${ROOT}handTracker.js`);
    state.tracker = await createHandTracker({ numHands: 2 });
  } catch (err) {
    status('Hand tracker failed to load: ' + (err?.message || err));
    console.error(err);
    return;
  }
  $('camBtn').textContent = '📷 Camera on';
  status(`Camera on. ${clipInfo(state.current).instruction}`);
  syncButtons();
}

function readHands(now) {
  const v = $('video');
  if (state.handSource) return state.handSource(now);
  if (!state.tracker || v.readyState < 2) return null;
  // Only new video frames: re-reading the same frame would record duplicate samples.
  if (v.currentTime === state.lastVideoTime) return null;
  state.lastVideoTime = v.currentTime;
  return state.tracker.read(v, now);
}

function tick(now) {
  requestAnimationFrame(tick);
  if (state.stream || state.handSource) {
    const hands = readHands(now);
    if (hands) {
      state.liveHands = hands;
      if (state.phase === 'recording') {
        if (!state.frames.length) state.t0 = now;
        state.frames.push({ t: Math.round(now - state.t0), hands: hands.map(packHand) });
      }
      drawLive(hands);
    }
    if (state.phase === 'recording' && now >= state.stopAt) finishRecording();
  }
  if (state.play) stepPlayback(now);
}

// --- recording ----------------------------------------------------------------------------

function record() {
  if (state.phase !== 'idle' || !state.stream) return;
  state.take = null;
  state.phase = 'countdown';
  syncButtons();
  const ms = Math.min(MAX_MS, Math.max(MIN_MS, Number($('dur').value) * 1000));
  const count = $('count');
  let n = COUNT_FROM;
  // One number per second, eased fade (photosafety: no flashing).
  const show = () => {
    count.textContent = String(n);
    count.classList.add('show');
    status(`${state.current}: get ready… ${clipInfo(state.current).instruction}`);
  };
  show();
  const timer = setInterval(() => {
    n -= 1;
    if (n > 0) return show();
    clearInterval(timer);
    count.classList.remove('show');
    state.frames = [];
    state.phase = 'recording';
    state.stopAt = performance.now() + ms;
    $('recDot').classList.add('on');
    status(`Recording ${state.current} for ${ms / 1000} s…`);
    syncButtons();
  }, 1000);
}

function finishRecording() {
  if (state.phase !== 'recording') return;
  state.phase = 'idle';
  $('recDot').classList.remove('on');
  const frames = state.frames;
  state.frames = [];
  const durationMs = frames.length ? frames[frames.length - 1].t : 0;
  if (durationMs < MIN_MS * 0.9 || frames.length < 2) {
    status(`Too short (${(durationMs / 1000).toFixed(1)} s, ${frames.length} frames): record again (2–5 s).`);
    syncButtons();
    return;
  }
  const info = clipInfo(state.current);
  const v = $('video');
  state.take = {
    schema: 'gesture-clip/1',
    name: info.name,
    gesture: info.name,
    instruction: info.instruction,
    recordedAt: new Date().toISOString(),
    durationMs,
    frameCount: frames.length,
    fps: r5((frames.length - 1) / (durationMs / 1000)),
    mirrored: false,
    video: { width: v.videoWidth || 0, height: v.videoHeight || 0 },
    frames
  };
  const withHand = frames.filter((f) => f.hands.length).length;
  status(`Take ready: ${frames.length} frames, ${(durationMs / 1000).toFixed(1)} s, hands in ${withHand}. Play, then Keep or Discard.`);
  if (!withHand) status(`No hand was seen in this take (${frames.length} frames). Discard and try again.`);
  describeTake(state.take);
  syncButtons();
  play(state.take);
}

function stopEarly() {
  if (state.phase !== 'recording') return;
  finishRecording();
}

function describeTake(clip) {
  if (!clip) { $('take').textContent = ''; return; }
  const hands = new Set();
  for (const f of clip.frames) for (const h of f.hands) hands.add(h.handedness);
  $('take').textContent =
    `${clip.name}${clip.mirrored ? ' (mirrored)' : ''} · ${clip.frameCount} frames · ${(clip.durationMs / 1000).toFixed(2)} s · ` +
    `${clip.fps} fps · hands: ${[...hands].join(', ') || 'none'}`;
}

function mirror() {
  if (!state.take) return;
  state.take = mirrorClip(state.take);
  describeTake(state.take);
  status(state.take.mirrored ? 'Mirrored: x flipped, Left/Right swapped.' : 'Mirror undone.');
  play(state.take);
}

function discard() {
  state.take = null;
  state.play = null;
  describeTake(null);
  clearPreviews();
  status(`Discarded. ${clipInfo(state.current).instruction}`);
  syncButtons();
}

async function keep() {
  const clip = state.take;
  if (!clip) return;
  const body = JSON.stringify(clip);
  if (!isLocal) {
    // Off localhost nothing is sent anywhere: hand the file to the owner instead.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    a.download = `${clip.name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    status(`Downloaded ${clip.name}.json (not on localhost, so nothing was saved to the repo).`);
    return { ok: true, downloaded: true };
  }
  status(`Saving ${clip.name}…`);
  let out;
  try {
    const res = await fetch('/__clip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    out = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  } catch (err) {
    out = { ok: false, error: String(err?.message || err) };
  }
  if (!out.ok) {
    // An old serve.py (started before /__clip existed) answers 405.
    status(`Save failed: ${out.error}. Is serve.py up to date (restart it)?`);
    return out;
  }
  state.take = null;
  await refreshSaved();
  describeTake(null);
  status(`Saved ${out.path}. Pick the next clip.`);
  return out;
}

async function loadSaved(name = state.current) {
  const res = await fetch(`${CLIP_DIR}${name}.json`, { cache: 'reload' });
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  return res.json();
}

async function playSaved() {
  try {
    const clip = await loadSaved();
    describeTake(clip);
    play(clip);
    status(`Playing saved ${clip.name} (${clip.frameCount} frames).`);
    return clip;
  } catch (err) {
    status('Could not load the saved clip: ' + err.message);
    return null;
  }
}

// --- drawing ------------------------------------------------------------------------------

const HAND_COLOURS = { Right: '#4fd1ff', Left: '#ffb86b', Unknown: '#c9dcec' };

function drawSkeleton(ctx, pts, map, colour) {
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of BONES) {
    const [ax, ay] = map(pts[a]);
    const [bx, by] = map(pts[b]);
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.stroke();
  for (const p of pts) {
    const [x, y] = map(p);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

const asArr = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

function drawLive(hands) {
  const c = $('live');
  const v = $('video');
  const w = v.videoWidth || 640;
  const h = v.videoHeight || 360;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  // The canvas is CSS-mirrored with the video, so draw in raw image coordinates.
  for (const hand of hands) {
    if (!hand.landmarks) continue;
    drawSkeleton(ctx, hand.landmarks.map(asArr), ([x, y]) => [x * w, y * h], HAND_COLOURS[hand.handedness] ?? '#c9dcec');
  }
}

function clearPreviews() {
  for (const id of ['pvImage', 'pvWorld']) {
    const c = $(id);
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
}

function drawFrame(clip, frame) {
  const ci = $('pvImage');
  const cw = $('pvWorld');
  const ii = ci.getContext('2d');
  const wi = cw.getContext('2d');
  ii.clearRect(0, 0, ci.width, ci.height);
  wi.clearRect(0, 0, cw.width, cw.height);
  // Fit the source aspect into the preview; x drawn mirrored to match the selfie view.
  const vw = clip.video?.width || 16;
  const vh = clip.video?.height || 9;
  const s = Math.min(ci.width / vw, ci.height / vh);
  const ox = (ci.width - vw * s) / 2;
  const oy = (ci.height - vh * s) / 2;
  ii.strokeStyle = '#16222e';
  ii.strokeRect(ox, oy, vw * s, vh * s);
  const n = frame.hands.length;
  frame.hands.forEach((hand, i) => {
    const col = HAND_COLOURS[hand.handedness] ?? '#c9dcec';
    if (hand.landmarks) drawSkeleton(ii, hand.landmarks, ([x, y]) => [ox + (1 - x) * vw * s, oy + y * vh * s], col);
    if (hand.worldLandmarks) {
      // Each world hand is centred on itself, so give each hand its own slot; 0.25 m spans a slot.
      const slotW = cw.width / Math.max(1, n);
      const cx = slotW * (n - 1 - i) + slotW / 2; // reversed order matches the mirrored image view
      const k = Math.min(slotW, cw.height) / 0.25;
      drawSkeleton(wi, hand.worldLandmarks, ([x, y]) => [cx - x * k, cw.height / 2 + y * k], col);
    }
  });
  ii.fillStyle = '#7f93a6';
  ii.fillText(`t ${frame.t} ms`, 8, ci.height - 8);
}

function play(clip) {
  if (!clip?.frames?.length) return;
  state.play = { clip, start: performance.now(), frame: -1, done: false };
}

function stepPlayback(now) {
  const p = state.play;
  if (p.done) return;
  const t = now - p.start;
  const frames = p.clip.frames;
  let i = p.frame < 0 ? 0 : p.frame;
  while (i + 1 < frames.length && frames[i + 1].t <= t) i += 1;
  if (i !== p.frame) {
    p.frame = i;
    drawFrame(p.clip, frames[i]);
    state.playedFrames += 1;
  }
  if (i === frames.length - 1) p.done = true;
}

// --- wiring -------------------------------------------------------------------------------

$('camBtn').addEventListener('click', startCam);
$('recBtn').addEventListener('click', record);
$('stopBtn').addEventListener('click', stopEarly);
$('playBtn').addEventListener('click', () => play(state.take));
$('mirrorBtn').addEventListener('click', mirror);
$('keepBtn').addEventListener('click', keep);
$('discardBtn').addEventListener('click', discard);
$('savedBtn').addEventListener('click', playSaved);
$('dur').addEventListener('change', () => syncButtons());

window.clipLab = {
  CLIPS,
  state,
  select,
  startCam,
  record,
  stop: stopEarly,
  keep,
  discard,
  mirror,
  play,
  playSaved,
  loadSaved,
  mirrorClip,
  setHandSource(fn) { state.handSource = typeof fn === 'function' ? fn : null; }
};

select(state.current);
refreshSaved();
requestAnimationFrame(tick);

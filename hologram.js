const V = new URL(import.meta.url).search;

const { createScene, startRenderLoop } = await import('./scene.js' + V);
const { loadModel, frameObject } = await import('./loadModel.js' + V);

// The model now loads pre-cleaned. Isolating the object used to happen here at runtime,
// via trimByCylinder on the raw scan — but a radius crop can only remove what is beside
// the object, never the floor underneath it, so the chair shipped standing in a visible
// crater of scanned floor. Cleaning is now an offline step (clean_scan.py), which can do
// the things a live radius crop cannot: detect the actual ground plane, keep the runners
// resting on it, rebuild the leg the scanner missed, and weld the result watertight.
const { describeCameraError } = await import('./camera.js' + V);
const { createManipulator, MODE, CHANNELS } = await import('./manipulator.js' + V);
const { default: HolographicMaterial } = await import('./HolographicMaterial.js' + V);
const { prepareHologram, enableSingleLayer } = await import('./hologramLook.js' + V);
const { createMeasurePanel } = await import('./measurePanel.js' + V);
const { MODELS } = await import('./models.js' + V);
const { createCarousel } = await import('./carousel.js' + V);
const { scoreLine, PRACTICE_ROUNDS, PRACTICE_ROUNDS_THUMB } = await import('./calibrate.js' + V);
const { partLabel } = await import('./reticle.js' + V);
// Camera, tracker, smoothing, engagement, pointer, reticle, calibration, reset gate, tracking
// monitor and ghost hands live in the shared hands runtime (also used by the Platform).
const { createHandsRuntime } = await import('./handsRuntime.js' + V);
const { autoStartCamera, mountRememberToggle, setRememberCamera } = await import('./handUI.js' + V);
const { createOrbitGuard } = await import('./orbitGuard.js' + V);
const { createToolStatus, slot, TOOLS } = await import('./toolWheel.js' + V);
// Hands v2 host wiring (chip colour, hand tint, Done / undo ring, scopes), shared with the
// Platform; that module's only static import is three.
const { wireHandsV2 } = await import('./platform/hands.js' + V);

const video = document.getElementById('cam');
const overlay = document.getElementById('overlay');

const statusEl = document.getElementById('status');
const fpsEl = document.getElementById('fps');
const modeEl = document.getElementById('mode');
const startBtn = document.getElementById('start');
const resetBtn = document.getElementById('reset');

const toolsEl = document.getElementById('tools');
const toolsBtn = document.getElementById('toolsBtn');
const drillsEl = document.getElementById('drills');
const coachEl = document.getElementById('coach');
const coachTitleEl = document.getElementById('coachTitle');
const coachBodyEl = document.getElementById('coachBody');
const coachLiveEl = document.getElementById('coachLive');
const lampEl = document.getElementById('lamp');
const liveTextEl = document.getElementById('liveText');
const helpEl = document.getElementById('help');
const helpBtn = document.getElementById('helpBtn');
const calLineEl = document.getElementById('calLine');
const partChipEl = document.getElementById('partChip');
const selPracticeBtn = document.getElementById('selPractice');

const { scene, camera, renderer, controls } = createScene(document.getElementById('stage'), {
  transparentBackground: true
});

let manipulator = null;
let currentMeasurePanel = null;
let currentModelId = null;
let swapping = false;
let triedTape = false;   // #try=tape (landing link) handled once
let seenResets = 0; // manipulator.resetCount already announced (see noticeResets)
// The loaded model's own words for the instructions: "Chair" from "Chair (raw scan)", and how
// it explodes (literal parts vs stretch). Filled in by loadModelById.
const model = { name: MODELS[0].name.replace(/\s*\(.*\)\s*$/, ''), parts: 0, literal: false };
const the = () => `the ${model.name.toLowerCase()}`;

// scanlineSize is high on purpose. At the library's default (8) the scanline bands are
// wide enough to cut clean across a chair leg, and thin parts read as SEVERED -- reported
// as the model looking "half disconnected". Confirmed it was the shader and not the mesh by
// rendering the same file with an opaque material (the viewer, viewer.html?plain=1), where the chair is
// visibly whole. Finer bands read as surface texture instead of breaks.
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

// Photosafety (BUGS.md #14): one-layer rendering so stacked surfaces can't bloom to white.
enableSingleLayer(scene, [hologramMaterial]);

// Interaction-tied visual feedback on the hologram itself, in place of haptics this can't
// have — requested directly during testing ("depending on what we're interacting with,
// add more color"). This is the coarse whole-object version; per-region glow (e.g. just
// the legs while rotating) is a bigger, separate undertaking, not done here.
// Floor raised in step with the material's own hologramBrightness -- this map is written
// to the uniform every frame, so leaving idle at 1.0 would undo the fix on every idle frame.
// explode needs its own entry: the lookup falls back to 1.0, so without one the model
// would DIM below its idle brightness the moment explode engaged.
const MODE_BRIGHTNESS = { idle: 1.25, grab: 1.8, transform: 1.8, explode: 1.8 };

window.hologram = { scene, camera, renderer, controls, model: null, material: hologramMaterial };

// BUGS #53: a lost pointerup left OrbitControls mid-drag, so every plain mouse move spun the
// model (and every later click threw at OrbitControls.js:1071). The guard ends any drag the
// moment the mouse moves with no button held, so the model only turns while dragging -- with
// the tape and notes on too, where a stray spin made mouse points hard to place. A real drag
// still orbits in every mode (the back of the model has to stay reachable for the tape).
window.hologram.orbitGuard = createOrbitGuard({ controls });

// ---- the coach: ONE slot for every prompt -------------------------------------------------
// The owner's live test (2026-10-01) found toasts, hint chips, the drill text and the
// calibration card all talking at once and overlapping. Now every prompt goes into a slot here
// and #coach shows the single most important one: an error beats a tracking hint beats the
// calibration step beats the drill step beats a toast. A toast only shows when nothing else is
// up (its text also goes to the status line, so nothing is lost). Text swaps in place and the
// box only fades (eased opacity), so changing messages never flashes (BUGS #14).
// While calibrating, calibrate.js draws its own card, so the calibration slot just keeps the
// drill and toast quiet ({ silent: true }) instead of saying the same thing twice.
// Message shape: { title, body? }; title starts with an icon and a verb, body ends "✓ …".
const COACH_ORDER = ['error', 'hint', 'calibration', 'drill', 'toast'];
const coachSlots = { error: null, hint: null, calibration: null, drill: null, toast: null };
let coachKey = null;
function setCoach(kind, msg) {
  coachSlots[kind] = msg ?? null;
  const top = COACH_ORDER.find((k) => coachSlots[k]);
  const m = top ? coachSlots[top] : null;
  const key = m && !m.silent ? `${top}|${m.title}|${m.body ?? ''}` : '';
  if (key === coachKey) return;
  coachKey = key;
  if (!key) {
    coachEl.className = 'empty';
    return;
  }
  coachEl.className = top;
  coachTitleEl.textContent = m.title;
  coachBodyEl.textContent = m.body ?? '';
  // The live "what I can see" line belongs to a practice drill only.
  coachLiveEl.hidden = top !== 'drill' || !m.live;
}
let toastTimer = null;
function showToast(title, body = '', ms = 3000) {
  setCoach('toast', { title, body });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setCoach('toast', null), ms);
}
// Tracking hints (pointer.js createTrackingMonitor) in this page's own words, by key, so the
// wording follows the writing standard without touching pointer.js.
const HINT_TEXT = {
  flicker: ['☝ Hold the pointer shape', 'Index straight out, the other three fingers curled tight. ✓ Success looks like: the ring stops blinking out.'],
  edge: ['↔ Bring your hand back toward the middle', 'Or press C to recalibrate your reach. ✓ Success looks like: the ring leaves the edge.'],
  lost: ['✋ Keep your hand inside the camera view', 'Move back a little if needed. ✓ Success looks like: the ghost hand comes back.']
};
function showHint(hint) {
  if (!hint) return setCoach('hint', null);
  const [title, body] = HINT_TEXT[hint.key] ?? [hint.text, ''];
  setCoach('hint', { title, body });
}
function showError(title, body) {
  setCoach('error', { title, body });
}

// The hands runtime (handsRuntime.js) runs inside this page's render loop (onTick below).
// Created before the first model load so its canvas listeners keep their old place in line,
// ahead of the measure panel's.
const runtime = createHandsRuntime({
  scene, camera, renderer, overlay, video,
  pickTargets: () => window.hologram.model,
  // Tape on = the model is frozen (Hands v2 #18): the runtime gets a manipulator that sees no
  // hands, so grab / tilt / scale / explode can't reach it (manipulator.js untouched).
  manipulator: () => gatedManipulator(),
  // What a held cursor or a pointing-hand pinch selects: with the tape or notes on, a point on
  // the surface (the click goes to the measure panel); otherwise an exploded part.
  // Tape and notes take the other hand's pinch only (Ricky (b), Debbie-G): no hold-to-place.
  holdOn: () => ((currentMeasurePanel?.mode ?? 'off') !== 'off' ? null : 'parts'),
  // Hands on the page (handUI.js): the hand cursor reaches the whole window (top bar, Tools
  // panel) and works its buttons and sliders; over them, no 3D pick fires.
  handUI: true,
  cursorSpace: 'page',
  // The ✌ tool wheel (toolWheel.js, HANDS-UX-SPEC section 4): the same slot meanings as the
  // Platform (toolWheel.js SLOTS). Centre = Done while a tool is on, else Help.
  toolWheel: () => [
    { dir: 'up', ...slot('up'), run: () => undoReset() },
    { dir: 'down', ...slot('down'), run: () => { manipulator?.reset(); setStatus('⟲ Reset · ✌ wheel ↑ Undo brings it back'); } },
    { dir: 'upRight', ...slot('upRight', 'hologram'), run: () => currentMeasurePanel?.toggleMode('tape'), enabled: () => !!currentMeasurePanel },
    { dir: 'downRight', ...slot('downRight', 'hologram'), run: () => {
      if (!manipulator) return;
      const on = manipulator.explodeAmount > 0.5;
      manipulator.setExplode(on ? 0 : 1);
      setStatus(on ? 'Parts back together' : '💥 Exploded · point at a part and pinch your other hand to pick it · ✋ Done puts it back');
    }, enabled: () => !!manipulator?.explodeIsLiteral && !modelFrozen() },
    { dir: 'downLeft', ...slot('downLeft', 'hologram'), run: () => stepModel(1) },
    { dir: 'upLeft', ...slot('upLeft', 'hologram'), run: () => currentMeasurePanel?.toggleMode('note'), enabled: () => !!currentMeasurePanel },
    { dir: 'center', icon: () => slot('center', activeTool() === 'none' ? 'none' : 'tool').icon,
      label: () => slot('center', activeTool() === 'none' ? 'none' : 'tool').label,
      run: () => (activeTool() === 'none' ? toggleHelp() : exitTool()) }
  ],
  onAction: (type, detail) => {
    if (type === 'click') act(detail);
    else if (type === 'practice') finishPractice(detail);
    else if (type === 'practice-start') syncPracticeButton();
    else if (type === 'frame') onCameraFrame(detail.mode);
    else if (type === 'hint') showHint(detail);
    else if (type === 'wheel' && detail.type === 'open') setStatus('✌ Tool wheel · ☝ aim at a tool, 🤏 pinch your other hand · ✌ again closes');
    else if (type === 'wheel' && detail.type === 'pick' && detail.dir !== 'center') setStatus(`✌ ${detail.label}`);
    else if (type === 'reset') {
      setStatus(`Tracking reset · ${detail.why}`);
      showToast('↻ Tracking reset', `${detail.why[0].toUpperCase()}${detail.why.slice(1)}. Raise a hand to carry on. ✓ Success looks like: the ghost hand reappears.`);
    } else if (type === 'calibrated') finishCalibration(detail);
    else if (type === 'starting') setStatus(detail.phase === 'model' ? 'Loading hand tracking…' : 'Asking for the camera…');
    else if (type === 'ui-type') setStatus('⌨ Type (optional) · or pinch elsewhere to carry on');
  }
});
const pointer = runtime.pointer;
const calibration = runtime.calibration;

// Numbers sessionrec.js (or anyone) can read: window.hologram.pointerStats, .pointerProfile,
// .calibration (.active, .step). Same objects and names as before the runtime existed.
window.hologram.pointerStats = runtime.stats;
window.hologram.pointerProfile = runtime.profile;
window.hologram.calibration = calibration;
window.hologram.handsRuntime = runtime;
// The current model's measure panel (tests and sessionrec read .mode: 'off'|'tape'|'note').
Object.defineProperty(window.hologram, 'measurePanel', { get: () => currentMeasurePanel, enumerable: true });

// Calibration (calibrate.js): first camera use with no saved profile, then C / Recalibrate.
// The score's numbers (error px, hit rate) go in the ⚙ Pointer section, not the status line.
function finishCalibration(profile) {
  window.hologram.pointerProfile = profile;
  calLineEl.textContent = scoreLine(profile);
  if (profile?.skipped) {
    setStatus('Pointer calibration skipped · press C any time');
    showToast('🎯 Calibration skipped', 'Press C any time to calibrate. ✓ Success looks like: a card with three short steps.');
  } else {
    setStatus('✓ Pointer calibrated');
    showToast('✓ Pointer calibrated', `Point at ${the()} and pinch your other hand to click. ✓ Success looks like: the ring follows your finger.`);
  }
}
function startCalibration() {
  stopSelectionPractice();
  if (runtime.calibrate() === 'not-tracking') {
    setStatus('Start the camera first, then press C');
    showToast('▶ Start the camera first', 'Then press C to calibrate the pointer. ✓ Success looks like: a card with three short steps.');
  }
}
// Selection practice (calibrate.js createSelectionPractice via the runtime): an A/B of the
// three ways to select (hold still / pinch the pointing hand / pinch the other hand). It draws
// its own card and targets, so the coach stays quiet while it runs (onTick). The results land
// on window.hologram.selectionPractice, which sessionrec.js records.
// A part's name for people: partLabel's name with file-style separators read as spaces
// ("leg_·_front_right" -> "leg · front right").
const partName = (part) => partLabel(part).name.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
const COMMIT_WORDS = { hold: 'hold', pinch: 'pinch', 'other-pinch': 'other hand', any: 'close targets' };
// BUGS #52: practice must always have a way out (the card's Stop button, Esc, P, the 🎯 button
// again), and it ends by itself when another tool starts: while it runs every hand click goes
// to its targets, so the tape or a note could never get one.
function stopSelectionPractice() {
  if (!runtime.practice?.active) return false;
  runtime.practice.cancel(); // -> 'practice' event -> finishPractice()
  return true;
}
// Also run every frame (onTick), so the label is right however practice started or ended.
function syncPracticeButton() {
  const on = !!runtime.practice?.active;
  if (selPracticeBtn.getAttribute('aria-pressed') === String(on)) return;
  selPracticeBtn.textContent = on ? '■ Stop selection practice' : '🎯 Selection practice';
  selPracticeBtn.setAttribute('aria-pressed', String(on));
}
// Shift+P: the thumb-tap A/B rounds (calibrate.js PRACTICE_ROUNDS_THUMB).
function startSelectionPractice({ thumb = false } = {}) {
  const r = runtime.startPractice(thumb ? { rounds: PRACTICE_ROUNDS_THUMB } : {});
  if (r === 'not-tracking') {
    setStatus('Start the camera first, then Selection practice');
    showToast('▶ Start the camera first', 'Then press 🎯 Selection practice. ✓ Success looks like: a row of rings with one lit.');
  } else if (r === 'busy') setStatus('Finish the calibration first (Esc skips it)');
  else setStatus('🎯 Selection practice · Esc or P stops');
  syncPracticeButton();
}
function finishPractice(results) {
  syncPracticeButton();
  // Hits per commit kind across its rounds, e.g. "hold 11/12 · pinch 12/12 · other hand 9/12".
  const by = {};
  for (const r of results?.rounds ?? []) {
    const k = COMMIT_WORDS[r.commit] ?? r.commit;
    by[k] = by[k] ?? { hits: 0, n: 0 };
    by[k].hits += r.hits;
    by[k].n += r.n;
  }
  const line = Object.entries(by).map(([k, v]) => `${k} ${v.hits}/${v.n}`).join(' · ');
  const cancelled = (results?.rounds ?? []).some((r) => r.cancelled) || (results?.rounds?.length ?? 0) < PRACTICE_ROUNDS.length;
  setStatus(`${cancelled ? 'Selection practice stopped' : '✓ Selection practice done'}${line ? ' · ' + line : ''}`);
  showToast(cancelled ? '🎯 Selection practice stopped' : '✓ Selection practice done',
    `${line ? line + ' hit. ' : ''}Pick the way that felt easiest. ✓ Success looks like: parts select on the first try.`, 6000);
}
selPracticeBtn.addEventListener('click', () => (stopSelectionPractice() || startSelectionPractice()));

calLineEl.textContent = scoreLine(runtime.profile);
// Thumb-tap click (trial, Debbie-G #9): default off; saved per browser by pointer.js.
{
  const label = document.createElement('label');
  label.style.cssText = 'display:flex;gap:6px;align-items:center;margin:6px 0';
  const thumbTapBox = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'thumbTap' });
  thumbTapBox.checked = !!runtime.pointer.thumbTap;
  thumbTapBox.addEventListener('change', () => runtime.pointer.setThumbTap?.(thumbTapBox.checked, { persist: true }));
  label.append(thumbTapBox, document.createTextNode(' 👍 Thumb-tap click (trial) · Shift+P practises it'));
  calLineEl.after(label);
}
document.getElementById('recal').addEventListener('click', () => startCalibration());

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// Swaps which hologram is loaded, live, with no page reload -- the carousel's whole point.
// Load-then-swap on purpose: the new model is fully fetched and parsed BEFORE anything about
// the old one is touched, so a failed load (bad path, bad file) leaves the current hologram
// completely untouched instead of leaving the scene empty.
async function loadModelById(id) {
  if (swapping || id === currentModelId) return;
  const entry = MODELS.find((m) => m.id === id);
  if (!entry) return;

  swapping = true;
  carousel.setBusy(true);
  setStatus(`Loading ${entry.name}…`);

  let object, path;
  try {
    ({ object, path } = await loadModel(entry));
  } catch (err) {
    setStatus(`Couldn't load ${entry.name}`, true);
    showError(`⚠ Couldn't load ${entry.name}`, `${err.message} Pick another model with ◂ ▸. ✓ Success looks like: a hologram in the middle.`);
    swapping = false;
    carousel.setBusy(false);
    return;
  }

  // Only now, with the replacement confirmed loadable, tear down whatever was loaded before.
  const oldObject = window.hologram.model;
  if (oldObject) {
    // Must run before scene.remove() below -- dispose() still needs live references to the
    // object it was measuring.
    currentMeasurePanel?.dispose();
    scene.remove(oldObject);
    // Geometry only, never the material: hologramMaterial is one shared instance assigned by
    // reference to every mesh (see the traverse below) and has to survive to serve the next
    // model too.
    oldObject.traverse((child) => {
      if (!child.isMesh) return;
      child.geometry.dispose();
      // Per-mesh colour variants (see below) are this model's own; the shared one survives.
      if (child.material !== hologramMaterial) child.material.dispose();
    });
  }
  // createManipulator has no rebind -- it closes over one object for its whole lifetime -- so
  // the old one is simply discarded and a fresh one built below.
  manipulator = null;
  window.hologram.manipulator = null;

  // Meshes that carry real colour (a texture or vertex colours, e.g. the detailed chair)
  // get a variant of the shared material: same look uniforms, plus their own colour source,
  // so the Realism slider can blend the real scan back in. Everything else shares one.
  object.traverse((child) => {
    if (!child.isMesh) return;
    const src = child.material;
    const map = src?.map ?? null;
    const vertexColors = !!(src?.vertexColors && child.geometry.attributes.color);
    child.material = map || vertexColors ? hologramMaterial.variant({ map, vertexColors }) : hologramMaterial;
  });
  // Smooth the shading normals on rough scans (stops rim sparkle; no vertex moves).
  prepareHologram(object);
  scene.add(object);
  // Both of these must be reassigned together, synchronously: the render loop's onTick reads
  // window.hologram.model live every frame for ghost-hands, but reads the closed-over
  // `manipulator` variable for gesture control. Letting them drift out of sync for even one
  // frame means gestures would silently keep acting on a model that's no longer in the scene.
  window.hologram.model = object;
  frameObject(object, camera, controls);
  manipulator = createManipulator(object, camera);
  window.hologram.manipulator = manipulator;
  seenResets = manipulator.resetCount;
  setCoach('error', null);
  model.name = entry.name.replace(/\s*\(.*\)\s*$/, '');
  model.literal = manipulator.explodeIsLiteral;
  model.parts = 0;
  object.traverse((c) => { if (c.isMesh) model.parts++; });
  installPartDim(manipulator.parts);
  chipPart = undefined;   // re-evaluate the chip against the new model

  // Re-apply whatever practice drill/tuning was active -- otherwise a mid-session drill
  // selection would silently reset to "everything on" with default tuning on the new model.
  applyDrill(activeDrill);
  applyTuning();

  // Literal explode vs stretch is decided once per model from its own mesh count (see
  // manipulator.js); the Explode drill and Help say which, via `model` above.
  renderHelp();

  // Live dimensions sit next to the gestures on purpose: scaling or stretching the model
  // reports what the size has become, which is the whole reason to have both on one page.
  currentMeasurePanel = createMeasurePanel({
    mount: document.getElementById('measure'),
    object, camera, renderer, scene,
    // A stable id from the registry, not a filename -- two models could otherwise collide on
    // the same derived name and share localStorage keys.
    modelName: entry.id,
    displayName: model.name.toLowerCase(),
    tapeKey: 'T',
    onModeChange: (mode) => {
      if (mode !== 'off') stopSelectionPractice();
      if (mode === 'tape') {
        setStatus('📏 Tape on · the model holds still · aim, click point A, click point B');
        showToast('📏 Aim at ' + the() + ', click point A, then point B', 'Mouse click, or pinch your other hand. ✓ Success looks like: the distance next to the tool chip.');
      } else if (mode === 'note') {
        setStatus('📝 Notes on · click to add one');
        showToast('📝 Click ' + the() + ' to add a note', 'Then type it in the Measure tab. ✓ Success looks like: a label on the model.');
      } else setStatus('Free move · tape and notes off');
    }
  });

  currentModelId = id;
  carousel.setActive(id);
  carousel.setBusy(false);
  swapping = false;
  setStatus(`${entry.name} ready · drag to orbit, or ▶ Camera for hands`);
  // Stock samples carry a credit line (samples.js); CC BY ones must show it while on screen.
  const creditEl = document.getElementById('credit');
  if (creditEl) { creditEl.textContent = entry.credit ? `Model: ${entry.credit}` : ''; creditEl.title = creditEl.textContent; }
  startBtn.disabled = false;
  // Landing "Try it" link (index.html #try=tape): open on the tape, once.
  if (location.hash === '#try=tape' && !triedTape && currentMeasurePanel) {
    triedTape = true;
    currentMeasurePanel.toggleMode('tape');
  }
}

const carousel = createCarousel({
  mount: document.getElementById('modelCarousel'),
  models: MODELS,
  activeId: MODELS[0].id,
  onSelect: (id) => loadModelById(id)
});

loadModelById(MODELS[0].id);

async function startTracking() {
  startBtn.disabled = true;
  try {
    // Status lines for each phase come back as 'starting' events (onAction above).
    await runtime.start();
    setRememberCamera(document.getElementById('rememberCamera')?.checked ?? true);
    setCameraButton(true);
    startBtn.disabled = false;
    setCoach('error', null);
    setStatus(runtime.profile ? 'Camera on · raise a hand' : 'Camera on · first, a 45 s pointer calibration (Esc skips)');
    applyDrill(activeDrill);
    if (!runtime.profile) startCalibration();
  } catch (err) {
    setStatus("The camera didn't start", true);
    showError("⚠ The camera didn't start", `${describeCameraError(err)} Then press ▶ Camera again. ✓ Success looks like: the chip says "Ready".`);
    startBtn.disabled = false;
    console.error(err);
  }
}

function stopTracking() {
  runtime.stop();
  hologramMaterial.setBrightness(MODE_BRIGHTNESS.idle);
  renderChip(null);
  setCameraButton(false);
  setStatus('Camera off · drag to orbit');
  applyDrill(activeDrill);
}

function setCameraButton(on) {
  startBtn.innerHTML = on ? '■<span class="btn-word"> Camera</span>' : '▶<span class="btn-word"> Camera</span>';
  startBtn.title = on ? 'Turn the camera off' : 'Camera on / off: use your hands';
}

startBtn.addEventListener('click', () => (runtime.tracking ? stopTracking() : startTracking()));
// Remember on + permission already granted: start on load; not asked yet: the button pulses.
// Waits for the first model so startBtn is enabled and the status line isn't overwritten.
(async () => {
  for (let i = 0; i < 200 && startBtn.disabled; i++) await new Promise((r) => setTimeout(r, 50));
  if (!runtime.tracking) autoStartCamera({ start: () => startTracking().then(() => runtime.tracking), button: startBtn, setStatus });
})();
resetBtn.addEventListener('click', () => manipulator?.reset());

// Every reset (clap, R, the Reset button) can be undone one step (BUGS #27: a misfired clap
// used to wipe the pose with no way back). Checked every frame so a clap reset, which happens
// inside manipulator.update(), gets the same hint as a button press.
function noticeResets() {
  if (!manipulator || manipulator.resetCount === seenResets) return;
  seenResets = manipulator.resetCount;
  setStatus('Reset · press U to undo');
  showToast('↺ Reset', `Press U (or Ctrl+Z) to undo. ✓ Success looks like: ${the()} back where it started.`);
}
function undoReset() {
  if (manipulator?.undo()) setStatus('Reset undone');
}

window.addEventListener('keydown', (e) => {
  // Typing in a field (the measure panel's calibration and fit-check inputs, a note) must not
  // reset the model, hide panels, or swap models on every arrow key (BUGS #17).
  if (e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const key = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === 'z') {
    e.preventDefault();
    undoReset();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (key === 'escape' && calibration.active) {
    calibration.cancel();
    return;
  }
  // Esc or P leaves practice (P is what the owner reached for, BUGS #52) instead of the tab.
  if ((key === 'escape' || key === 'p') && stopSelectionPractice()) return;
  if (key === 'p' && e.shiftKey && !e.repeat) { startSelectionPractice({ thumb: true }); return; }
  // Tab: the next part behind the cursor (or the next in order). Only taken while parts can be
  // selected, so Tab keeps moving keyboard focus the rest of the time.
  if (key === 'tab' && !e.shiftKey && manipulator?.partsSelectable) {
    e.preventDefault();
    const part = runtime.cycleTarget();
    if (part) setStatus(`✓ ${partName(part)} selected · Tab for the next one`);
    return;
  }
  if (key === 'escape' && !helpEl.hidden) return toggleHelp(false);
  // Esc = the Done button: leave the tool (tape, notes, explode), back to free move.
  if (key === 'escape' && exitTool()) return;
  if (key === '?') toggleHelp();
  if (key === 'c') startCalibration();
  // W: the ✌ tool wheel at the screen centre (keyboard / mouse users; click a slot).
  if (key === 'w' && !e.repeat) { runtime.wheel?.isOpen ? runtime.wheel.close('api') : runtime.wheel?.open(); return; }
  if (key === 'r') manipulator?.reset();
  if (key === 'u') undoReset();
  if (key === 'd') document.body.classList.toggle('debug-camera');
  // P / M open the Tools panel on that tab, or close it if that tab is already showing.
  if (key === 'p') toggleTools('practice');
  if (key === 'm') toggleTools('measure');
  // T only switches the tape; it doesn't open the panel (the readout is in Measure).
  if (key === 't') currentMeasurePanel?.toggleMode('tape');
  if (key === 'arrowleft' || key === 'arrowright') stepModel(key === 'arrowleft' ? -1 : 1);
});

function stepModel(dir) {
  const idx = MODELS.findIndex((m) => m.id === currentModelId);
  loadModelById(MODELS[(idx + dir + MODELS.length) % MODELS.length].id);
}
document.getElementById('prevModel').addEventListener('click', () => stepModel(-1));
document.getElementById('nextModel').addEventListener('click', () => stepModel(1));

// Clicks, from the mouse or the finger-gun pointer, reach act() as the runtime's 'click' event
// (a mouse drag is an orbit, not a click; the runtime applies the 5px rule). Part selection
// (BUGS #28): once the model is exploded past half-way, a click on a part makes
// grab/spin/tilt/scale act on that part alone; a click on empty space goes back to the whole
// model. While the measure panel's point-picking or note mode is on, clicks belong to it: a
// mouse click is already handled by the panel's own listener, a pointer click is passed to it here.
function act(click) {
  if (!click) return;
  const panelMode = currentMeasurePanel?.mode ?? 'off';
  if (panelMode !== 'off') {
    if (click.source !== 'hand') return;
    // Tape / notes: the other hand's pinch only (a same-hand pinch or a thumb-tap drifts the aim).
    if (click.via !== 'other-pinch') return;
    runtime.pulse();
    // Re-probe at the rewound cursor so the point lands on the vertex the reticle showed.
    const hit = runtime.probeAt(click.x, click.y);
    const placed = currentMeasurePanel.placeAtNdc(click.x, click.y, hit?.vertex ? hit.point : null);
    if (!placed) clickOutcome('miss', click, `Missed ${the()} · aim at it and pinch again`);
    else if (panelMode === 'tape') {
      clickOutcome('tape-point', click, currentMeasurePanel.tapePoints === 1 ? '📏 Point A placed · aim at B and pinch' : `📏 Point B placed · ${currentMeasurePanel.tapeDistance?.text ?? ''} apart`);
    } else clickOutcome('note', click, '📝 Note added · type it in Measure');
    return;
  }
  if (click.source === 'hand') runtime.pulse();
  if (!manipulator?.explodeIsLiteral) {
    if (click.source === 'hand') clickOutcome('miss', click, `Nothing to click · press T for the tape`);
    return;
  }
  const before = manipulator.activePart;
  // click.part: the runtime's bubble / hold target (a near miss still picks the nearest part).
  const part = manipulator.selectPartAtScreenPoint(click.x, click.y, { part: click.part });
  if (part) clickOutcome('part-select', click, `✓ ${partName(part)} selected${VIA_WORDS[click.via] ?? ''} · gestures move only this part`);
  else if (before && !manipulator.activePart) clickOutcome('deselect', click, `Whole ${model.name.toLowerCase()} selected`);
  else if (click.source === 'hand') clickOutcome('miss', click, `Nothing to pick · explode ${the()} past half-way first`);
}

// Click results as data as well as words. sessionrec.js used to regex the old status lines;
// the reworded lines no longer match, so the outcome is published here (board note
// 2026-10-01): window.hologram.lastClick and a 'hologram:click' event on window, with
// outcome 'tape-point' | 'note' | 'miss' | 'part-select' | 'deselect'.
// via (2026-10-01, one-hand selection): 'hold' | 'pinch' | 'other-pinch' | 'mouse'.
const VIA_WORDS = { hold: ' by holding still', pinch: ' by pinching', 'thumb-tap': ' by a thumb tap', 'other-pinch': '', mouse: '' };
function clickOutcome(outcome, click, text) {
  const detail = { outcome, source: click.source, via: click.via ?? (click.source === 'mouse' ? 'mouse' : 'other-pinch'), t: performance.now() };
  window.hologram.lastClick = detail;
  window.dispatchEvent(new CustomEvent('hologram:click', { detail }));
  setStatus(text);
}

// ---- the active tool: which one you're in, and how to get out (Hands v2 #12, #13) --------------
// One answer for the chip, the Done button, the wheel's centre and Esc. Tape and notes are the
// measure panel's modes; an exploded model (literal parts, past half-way) counts as the Explode
// tool, and Done puts the parts back (edits kept, like a slow close).
function activeTool() {
  const m = currentMeasurePanel?.mode ?? 'off';
  if (m === 'tape' || m === 'note') return m;
  if (manipulator?.explodeIsLiteral && manipulator.explodeAmount > 0.5) return 'explode';
  return 'none';
}
// exitTool() -> what it left ('tape' | 'note' | 'explode' | 'wheel') or null when already in
// free move. The one host function the Done button, Esc and the wheel centre call; the open-palm
// "done" gesture (inputArbiter.js, CONTRACT section 2.2) will call it too.
function exitTool() {
  let left = null;
  if (runtime.wheel?.isOpen) { runtime.wheel.close('api'); left = 'wheel'; }
  const tool = activeTool();
  if (tool === 'tape' || tool === 'note') currentMeasurePanel.toggleMode(tool);
  else if (tool === 'explode') manipulator.setExplode(0);
  if (tool !== 'none') {
    left = tool;
    setStatus(`✋ Done · ${TOOLS[tool].name} off · free move`);
  }
  return left;
}
window.hologram.exitTool = exitTool;
window.hologram.activeTool = activeTool;

// Hands v2 (?hands=v2 only; null otherwise, v1 untouched): the open-palm Done is the Done
// button (or, with no tool on, snaps the model upright), thumbs-down is U, the tool sets the
// arbiter's scope (tape: aim + click, the model frozen) and the mode chip takes the owner colour.
window.hologram.handsV2 = wireHandsV2(runtime, {
  camera, canvas: renderer.domElement, chip: modeEl,
  activeTool: () => activeTool(),
  onDone: () => {
    if (exitTool()) return;
    // Snap upright needs the manipulator (manipulator.js, Debbie): used once it exists.
    if (typeof manipulator?.snapUpright === 'function') { manipulator.snapUpright(); setStatus(`✋ Done · ${the()} upright`); }
    else setStatus('✋ Done · free move');
  },
  // Still the one-step undo of the last reset (manipulator.undo): no multi-step history here yet.
  onUndo: () => { if (manipulator?.canUndo) undoReset(); else setStatus('Nothing to undo · 👎 undoes the last reset'); }
});

// Frozen model while the tape is on: the manipulator is fed no hands (it releases a grab the
// same way as when the hands drop, and its follow springs still settle), so nothing a hand does
// can move, turn, scale or explode the thing being measured.
const modelFrozen = () => (currentMeasurePanel?.mode ?? 'off') === 'tape';
const frozenViews = new WeakMap();
function gatedManipulator() {
  if (!manipulator || !modelFrozen()) return manipulator;
  let view = frozenViews.get(manipulator);
  if (!view) {
    const real = manipulator;
    view = new Proxy(real, {
      get(t, k) {
        if (k === 'update') return (hands, aspect, ts) => t.update([], aspect, ts);
        const v = Reflect.get(t, k, t);
        return typeof v === 'function' ? v.bind(t) : v;
      }
    });
    frozenViews.set(real, view);
  }
  return view;
}

// The aim, for the live tape distance: the reticle's (snapped) surface hit from the hands
// runtime, or the mouse over the canvas.
let aimHit = null, mouseNdc = null;
runtime.on('aim', (d) => { aimHit = d?.hit?.point ? d.hit : null; });
renderer.domElement.addEventListener('pointermove', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  mouseNdc = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
});
renderer.domElement.addEventListener('pointerleave', () => { mouseNdc = null; });

const toolStatus = createToolStatus({
  chip: document.getElementById('toolChip'),
  done: document.getElementById('doneBtn'),
  onDone: () => exitTool()
});
function updateTool() {
  const tool = activeTool();
  let detail = '';
  if (tool === 'tape') {
    const live = currentMeasurePanel.tapePreview(aimHit ? { point: aimHit.point } : mouseNdc ? { ndc: mouseNdc } : null);
    const n = currentMeasurePanel.tapePoints;
    detail = live ? live.text : n === 0 ? 'click point A' : 'click point B';
  }
  toolStatus.set(tool, { detail });
}

// Once per camera frame, after the runtime has routed this frame's click, reset and hint.
function onCameraFrame(mode) {
  renderChip(mode);
  // Eased, never a step: a brightness jump on every gesture start/stop is a flash.
  hologramMaterial.setBrightness(MODE_BRIGHTNESS[mode] ?? 1.0);
  updateLive(mode);
}

startRenderLoop({
  renderer,
  scene,
  camera,
  controls,
  onFrame: (fps) => {
    fpsEl.textContent = `${fps}`;
  },
  onTick: (tickNow = performance.now()) => {
    hologramMaterial.update();
    // Calibration and the selection practice draw their own cards: keep the coach quiet.
    setCoach('calibration', calibration.active || runtime.practice?.active ? { silent: true } : null);
    syncPracticeButton();
    noticeResets();
    // Camera frame (tracker, gestures, manipulator, pointer), follow springs, ghost hands,
    // debug skeleton and reticle: handsRuntime.js, inside this one render loop.
    runtime.update(tickNow);
    updateHover(tickNow);
    updateTool();
  }
});

// ---- the hovered part: its name next to the reticle, the other parts dimmed --------------
// runtime.target is the part a hold or pinch would select right now (bubble targeting). The
// chip names it (reticle.js partLabel; amber = inferred). The other parts ease down to
// DIM_OTHERS of their brightness so the target stands out; with nothing hovered every part
// is back at exactly 1 and its draw is untouched, so the scanned look is identical.
// Per part, without per-part materials: the meshes share one HolographicMaterial (and its
// variants share its uniform objects), so the brightness uniform is scaled just for that
// mesh's draw (onBeforeRender) and put back right after (onAfterRender). uniformsNeedUpdate
// makes three upload it even when consecutive draws share the material.
// Photosafety (BUGS #14): only ever darker than the resting look, eased with DIM_EASE_MS.
const DIM_OTHERS = 0.55;
const DIM_EASE_MS = 150;     // 63% of the way after 150 ms, 95% after 450 ms
const CHIP_DX = 18, CHIP_DY = -34;   // CSS px from the cursor: above-right, clear of the ring
const partDim = new WeakMap();       // part -> { f, saved }
let dimParts = [];
let dimLastT = null;
let chipPart = null;
function installPartDim(parts) {
  dimParts = parts;
  for (const part of parts) {
    const d = { f: 1, saved: null };
    partDim.set(part, d);
    part.onBeforeRender = (r, sc, cam, geo, material) => {
      const u = material?.uniforms?.hologramBrightness;
      if (d.f >= 1 || !u) return;     // the depth pre-pass's material has no such uniform
      d.saved = u.value;
      u.value = d.saved * d.f;
      material.uniformsNeedUpdate = true;
    };
    part.onAfterRender = (r, sc, cam, geo, material) => {
      if (d.saved === null) return;
      material.uniforms.hologramBrightness.value = d.saved;
      d.saved = null;
      material.uniformsNeedUpdate = true;
    };
  }
}
function updateHover(nowMs) {
  const hovered = runtime.target?.part ?? null;
  const dt = dimLastT === null ? 16 : Math.min(100, Math.max(0, nowMs - dimLastT));
  dimLastT = nowMs;
  const k = 1 - Math.exp(-dt / DIM_EASE_MS);
  for (const part of dimParts) {
    const d = partDim.get(part);
    const goal = hovered && part !== hovered ? DIM_OTHERS : 1;
    d.f += (goal - d.f) * k;
    if (goal === 1 && d.f > 0.998) d.f = 1;
  }
  // The chip: text swaps only when the part changes; position follows the cursor.
  if (hovered !== chipPart) {
    chipPart = hovered;
    if (hovered) {
      const label = partLabel(hovered);
      partChipEl.textContent = label.inferred ? `${partName(hovered)} · inferred` : partName(hovered);
      partChipEl.classList.toggle('inferred', label.inferred);
    }
    partChipEl.classList.toggle('on', !!hovered);
  }
  if (hovered) {
    const st = runtime.pointer.state;
    const c = renderer.domElement;
    const w = c.clientWidth, h = c.clientHeight;
    // The hand cursor's page px (its reach covers the whole window, handUI); the mouse's NDC.
    const rect = c.getBoundingClientRect();
    const at = runtime.cursorPx ? { x: runtime.cursorPx.x - rect.left, y: runtime.cursorPx.y - rect.top } : { x: ((st.x + 1) / 2) * w, y: ((1 - st.y) / 2) * h };
    const x = Math.min(Math.max(at.x + CHIP_DX, 4), w - partChipEl.offsetWidth - 4);
    const y = Math.min(Math.max(at.y + CHIP_DY, 4), h - 30);
    partChipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
}

// ---------------------------------------------------------------------------------------
// Practice drills. Reported live: "it keeps accidentally moving around and doing commands I
// never intended", with a request to "test each feature separately without it bleeding
// across". One closed fist drives move, spin, tilt AND push simultaneously, so with
// everything armed there is no way to tell which channel misfired, and no way to build any
// feel for one of them. Each drill arms exactly one channel in the manipulator; every other
// gesture becomes genuinely inert rather than merely ignored.
// Writing standard (2026-10-01): icon + verb first, at most two lines, ending with what
// success looks like, using the loaded model's real name -- so title/body are functions.
// `help` is the one-line entry in the ? Help popover (the old #legend, now in one place).
const DRILLS = [
  {
    id: 'free',
    label: 'Everything on',
    sub: 'normal use',
    channels: CHANNELS,
    chip: 'move · spin · tilt',
    // Only shown while the camera is off (see applyDrill).
    title: () => '▶ Press Camera to use your hands',
    body: () => `Or drag to orbit ${the()}; ? Help lists every gesture. ✓ Success looks like: the chip says "Ready".`
  },
  {
    id: 'move',
    label: 'Move',
    sub: 'fist, slide it around',
    help: 'fist, slide it',
    channels: ['move'],
    chip: 'move',
    title: () => '✊ Make a fist and slide it around',
    body: () => `Only moving is on, so nothing else can fire. ✓ Success looks like: ${the()} follows your fist without turning.`
  },
  {
    id: 'spin',
    label: 'Spin',
    sub: 'fist, twist your wrist',
    help: 'fist, twist your wrist',
    channels: ['spin'],
    chip: 'spin',
    title: () => '✊ Make a fist and twist your wrist like a doorknob',
    body: () => `Only spinning is on. ✓ Success looks like: ${the()} turns in place without drifting.`
  },
  {
    id: 'tilt',
    label: 'Tilt',
    sub: 'fist + raise or lower your other hand',
    help: 'fist, then raise / lower / slide the other hand',
    channels: ['tilt'],
    chip: 'tilt',
    title: () => '✊ Hold a fist, then raise or lower your other hand',
    body: () => `Slide that hand left or right to roll. ✓ Success looks like: ${the()}'s front edge rises as your hand rises.`
  },
  {
    id: 'push',
    label: 'Push / pull',
    sub: 'fist nearer / farther',
    help: 'fist toward / away from the camera',
    channels: ['push'],
    chip: 'push',
    title: () => '✊ Make a fist and move it toward the camera, then away',
    body: () => `Keep your whole hand in view. ✓ Success looks like: ${the()} comes closer, then moves back.`
  },
  {
    id: 'scale',
    label: 'Scale',
    sub: 'pinch with both hands',
    help: 'pinch both hands, move apart / together',
    channels: ['scale'],
    chip: 'scale',
    title: () => '🤏 Pinch thumb and index on both hands, then move them apart',
    body: () => `Bring them together to shrink. ✓ Success looks like: ${the()} grows, and Measure shows its on-screen size.`
  },
  {
    id: 'explode',
    label: 'Explode',
    sub: 'two open hands apart',
    help: 'two open hands, pull apart',
    channels: ['explode'],
    chip: 'explode',
    title: () => '👐 Hold both hands open and pull them apart',
    body: () => model.literal
      ? `Past half-way, point at a part and hold still to select it. ✓ Success looks like: ${the()} splits into its ${model.parts} parts.`
      : `This scan is one piece, so it stretches. ✓ Success looks like: ${the()} stretches out along your hands.`
  },
  {
    id: 'reset',
    label: 'Clap reset',
    sub: 'clap open hands, from rest',
    help: 'from rest, clap quickly (U undoes)',
    channels: ['clap'],
    chip: 'reset',
    title: () => '👏 From rest, open both hands wide and clap them together fast',
    body: () => `A slow clap won't count; U undoes a reset. ✓ Success looks like: ${the()} jumps back to where it started.`
  }
];

let activeDrill = DRILLS[0];

// Everything-on only needs the coach before the hands are in (afterwards the chip says it all
// and the slot is free for toasts); a practice drill keeps its step and live line up.
function applyDrill(drill) {
  activeDrill = drill;
  manipulator?.configure({ channels: drill.channels });
  const showStep = drill.id !== 'free' || !runtime.tracking;
  setCoach('drill', showStep ? { title: drill.title(), body: drill.body(), live: drill.id !== 'free' } : null);
  if (drill.id !== 'free' && !runtime.tracking) setLive(false, 'Camera off · press ▶ Camera to practise');
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
  btn.addEventListener('click', () => {
    stopSelectionPractice();
    applyDrill(drill);
  });
  drillsEl.appendChild(btn);
}

// ---- the mode chip: what your hands are doing, in plain words --------------------------
// Was the manipulator's internal mode name ("transform"); now an icon and a verb.
function renderChip(mode) {
  let text, cls;
  const hands = runtime.hands ?? [];
  if (mode === null || !runtime.tracking) [text, cls] = ['📷 Camera off', 'off'];
  else if (calibration.active) [text, cls] = ['🎯 Calibrating', 'aim'];
  else if (runtime.practice?.active) [text, cls] = ['🎯 Practising selection', 'aim'];
  else if (mode === MODE.GRAB) [text, cls] = [`✊ Holding · ${activeDrill.chip}`, 'grab'];
  else if (mode === MODE.TRANSFORM) [text, cls] = ['🤏 Scaling', 'transform'];
  else if (mode === MODE.EXPLODE) [text, cls] = [model.literal ? '👐 Exploding' : '👐 Stretching', 'explode'];
  else if (pointer.state.mode === 'aim' && pointer.state.source === 'hand') [text, cls] = ['👉 Aiming', 'aim'];
  else if (!hands.length) [text, cls] = ['🙌 Raise a hand', 'idle'];
  else if (!hands.some((h) => h.engaged !== false)) [text, cls] = ['💤 Hands at rest', 'idle'];
  else [text, cls] = ['✋ Ready', 'idle'];
  if (modeEl.textContent !== text) modeEl.textContent = text;
  modeEl.className = cls;
}

// ---- Tools panel: one panel, three tabs, one open at a time ----------------------------
const TABS = ['practice', 'measure', 'look'];
let activeTab = 'practice';
function showTab(id) {
  activeTab = id;
  for (const t of TABS) {
    document.getElementById(t).hidden = t !== id;
    document.getElementById('tab-' + t).setAttribute('aria-selected', String(t === id));
  }
}
function setToolsOpen(open) {
  toolsEl.classList.toggle('hidden', !open);
  toolsBtn.setAttribute('aria-expanded', String(open));
}
// P / M: open on that tab, or close if that tab is already the one showing.
function toggleTools(tab) {
  const open = !toolsEl.classList.contains('hidden');
  if (open && activeTab === tab) return setToolsOpen(false);
  showTab(tab);
  setToolsOpen(true);
}
for (const t of TABS) document.getElementById('tab-' + t).addEventListener('click', () => showTab(t));
toolsBtn.addEventListener('click', () => setToolsOpen(toolsEl.classList.contains('hidden')));

// ---- ? Help: every gesture and key in one popover (was #legend + #coachKeys) ------------
function renderHelp() {
  const row = (k, v) => {
    const r = document.createElement('div');
    r.className = 'help-row';
    const a = document.createElement('span');
    const b = document.createElement('span');
    a.textContent = k;
    b.textContent = v;
    r.append(a, b);
    return r;
  };
  const h = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  helpEl.replaceChildren(h('h3', `Using ${the()}`), h('h4', 'Hands'));
  for (const d of DRILLS.filter((x) => x.help)) {
    helpEl.append(row(d.label, d.id === 'explode' && !model.literal ? 'two open hands apart (stretches: one-piece scan)' : d.help));
  }
  helpEl.append(
    row('Point', 'index out, other fingers curled'),
    row('Click', 'pinch your OTHER hand'),
    row('Select a part', 'point at it and hold still, or pinch that hand'),
    row('Next part', 'hold again, or Tab'),
    row('Rest', 'lower your hands'),
    h('h4', 'Mouse'),
    row('Orbit / zoom', 'drag / scroll'),
    row('Pick a part', 'click it once exploded'),
    h('h4', 'Keys'),
    row('R / U', 'reset / undo reset'),
    row('T', 'tape on / off (the model holds still)'),
    row('Esc / ✋ Done', 'leave the tool (tape, notes, explode)'),
    row('W', 'the ✌ tool wheel'),
    row('P / M', 'Practice / Measure tab (P or Esc also stops selection practice)'),
    row('← →', 'switch model'),
    row('C / Esc', 'calibrate pointer / skip'),
    row('Tab', 'next part (once exploded)'),
    row('D', 'show the camera view'),
    row('?', 'this help')
  );
  // Spec section 3: the camera starts by itself next time (after the browser's one-time ask).
  mountRememberToggle(helpEl);
}
function toggleHelp(open = helpEl.hidden) {
  helpEl.hidden = !open;
  helpBtn.setAttribute('aria-expanded', String(open));
}
helpBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleHelp();
});
document.addEventListener('pointerdown', (e) => {
  if (!helpEl.hidden && !helpEl.contains(e.target) && e.target !== helpBtn) toggleHelp(false);
});
renderHelp();

// Feel controls. Every sensitivity and threshold in manipulator.js is an untuned guess made
// without a webcam (see ROADMAP.md Phase 1). These make them adjustable against real hands
// instead of needing a code edit and a redeploy per attempt.
const sensEl = document.getElementById('sens');
const sensValEl = document.getElementById('sensVal');
const trigEl = document.getElementById('trig');
const trigValEl = document.getElementById('trigVal');
const momentumEl = document.getElementById('momentum');

// Realism: 0 = pure hologram, 1 = the scan's real colours (see HolographicMaterial). Shared
// uniform, so every mesh and variant follows the one slider. Remembered per browser.
const realismEl = document.getElementById('realism');
if (realismEl) {
  const setRealism = (v) => {
    hologramMaterial.uniforms.realism.value = v;
    document.getElementById('realismVal').textContent = `${Math.round(v * 100)}%`;
    try { localStorage.setItem('hologram-demo-realism', String(v)); } catch { /* private mode */ }
  };
  let saved = 0;
  try { saved = parseFloat(localStorage.getItem('hologram-demo-realism')) || 0; } catch { /* default */ }
  realismEl.value = saved;
  setRealism(saved);
  realismEl.addEventListener('input', () => setRealism(+realismEl.value));
}

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
  if (liveTextEl.textContent !== text) liveTextEl.textContent = text;
}

// What the active drill is actually seeing right now, so a gesture that refuses to fire says
// WHY (no fist detected, only one hand, not pinching) rather than just doing nothing. Shown
// as the coach's live line under a practice drill's step; Everything-on uses the chip.
function updateLive(mode) {
  if (activeDrill.id === 'free') return;
  const hands = runtime.hands;
  if (hands.length === 0) {
    setLive(false, 'No hands seen · raise your hand into view');
    return;
  }

  const fists = hands.filter((h) => h.fistLike).length;
  const pinches = hands.filter((h) => h.pinch?.pinching).length;
  // A pointer is not an open hand (it can't explode or clap; manipulator.js isOpen).
  const open = hands.filter((h) => !h.fistLike && !h.pinch?.pinching && !h.pointer?.gun).length;
  const both = hands.length >= 2;

  switch (activeDrill.id) {
    case 'move':
    case 'spin':
    case 'push':
      setLive(mode === MODE.GRAB, mode === MODE.GRAB ? '✓ Holding' : fists ? 'Fist seen · hold it a moment' : 'Curl your fingers into a fist');
      break;
    case 'tilt':
      setLive(
        mode === MODE.GRAB,
        !fists ? 'Make a fist with one hand first' : !both ? '✓ Fist held · now raise your other hand' : '✓ Holding · raise, lower or slide your other hand'
      );
      break;
    case 'scale':
      setLive(mode === MODE.TRANSFORM, !both ? 'Raise both hands' : mode === MODE.TRANSFORM ? '✓ Scaling' : `Pinching ${pinches} of 2 hands`);
      break;
    case 'explode':
      setLive(mode === MODE.EXPLODE, !both ? 'Raise both hands' : mode === MODE.EXPLODE ? '✓ Pulling apart' : `Open hands ${open} of 2`);
      break;
    case 'reset':
      setLive(false, !both ? 'Raise both hands' : 'Ready · clap quickly');
      break;
  }
}

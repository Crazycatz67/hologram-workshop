// The hands runtime: everything a page wires around the webcam to get hand control, in one
// place, so hologram.html and the Platform share one system instead of two copies of the
// gesture plumbing (plans/platform/P1-hands-design.md, step 1). Lifted out of hologram.js
// with no behaviour change; the host keeps its own UI (status line, mode badge, buttons,
// keys, toasts) and decides what a click means.
//
// CONTRACT
//   createHandsRuntime({ scene, camera, renderer, canvas?, overlay, video, pickTargets?,
//                        ghostAnchor?, manipulator?, onAction? }) -> runtime
//     scene, camera, renderer: the host's three.js objects. canvas defaults to
//       renderer.domElement; mouse input and the viewport size come from it.
//     overlay: the 2D <canvas> the debug skeleton is drawn on, sized to the video.
//     video: the <video> element the camera stream plays into.
//     pickTargets(): Object3D | null, the root the reticle and probeAt() raycast (recursive).
//       Called every display frame, so a model swap is picked up with no rebind.
//     ghostAnchor(): Object3D | null, what the drawn hands are placed against (its distance
//       sets their depth plane); defaults to pickTargets. While it returns null the hands are
//       not updated (as before). The hands are handModel.js (ghostHands.js if it can't load).
//     manipulator(): manipulator | null, read every frame (hosts swap it on model load). Its
//       update(hands, aspect, tMs) is called as a method on each camera frame, so wrapping
//       m.update (sessionrec.js does) keeps working; tick(tMs) runs every display frame.
//     onAction(type, detail): optional catch-all listener, same events as runtime.on().
//     holdSelect: true (default) = hold-to-select is on (owner 2026-10-01 (3)).
//     holdOn(): 'parts' | 'surface' | null, read every display frame: what a held cursor or a
//       hand pinch targets. 'parts' (default): exploded parts (manipulator.partsNear, bubble
//       targeting); 'surface': any point on pickTargets (e.g. tape placement); null: hold off.
//   runtime.start() -> Promise   loads the tracker once (reused across restarts, BUGS #16),
//     starts the camera. Emits 'starting' { phase: 'model' | 'camera' }. Rethrows camera /
//     model errors for the host to report (camera.js describeCameraError).
//   runtime.stop()               camera off and every per-frame filter reset. Emits 'stop'.
//   runtime.update(nowMs)        call once per display frame from the HOST's render loop (no
//     second rAF loop here). Returns the manipulator mode on a camera frame, else null.
//   runtime.calibrate() -> 'started' | 'busy' | 'not-tracking'
//   runtime.probeAt(ndcX, ndcY) -> reticle.probe result | null, with the reticle's current snap
//     as hysteresis (so a click lands on the vertex the reticle showed).
//   runtime.pulse()              the reticle's click pulse.
//   runtime.startPractice(opts?) -> 'started' | 'busy' | 'not-tracking'   the selection A/B
//     practice (calibrate.js createSelectionPractice; opts pass through, e.g. rounds). While it
//     runs, hand clicks and the hold ring go to its targets. Emits 'practice' with the results
//     (also stats.practice, and window.hologram.selectionPractice). runtime.practice?.cancel().
//   runtime.cycleTarget() -> part | null   Tab: the next part behind the cursor, or the next
//     part in order; selects it on the manipulator (host binds the key).
//   runtime.injectClick(click)   route a click as if the hands made it ({ x, y, t, source,
//     via?, part?, px? }; x, y in canvas NDC); for labs, tests and replays. Ignored while calibrating.
//   runtime.injectFrame(hands, { aspect?, t? }) -> mode   one camera frame of annotated hands
//     through the live path (pointer, clicks, handUI, pinchHeld) plus a display frame; no camera.
//   runtime.on(type, fn) -> unsubscribe
//   runtime.dispose()            stop, remove canvas listeners, remove the reticle.
//   Getters: tracking, hands (this camera frame's annotated hands), pointer (pointer.js),
//     handModel (handModel.js: .mode 'loading' | 'model' | 'ghost', .debug(), .landmarkOf),
//     engagement, calibration (calibrate.js; .active, .step, .cancel()), profile (the pointer
//     profile, or null before the first calibration), stats (see below).
//   target -> { part, hit, distPx, progress } | null  the hovered target this display frame
//     (progress = hold ring 0..1 as drawn).
//   stats = { resets, lastResetAt, hints: { key: count }, hint, clicks,
//     selects: { hold, pinch, 'other-pinch', mouse } }: hologram.js exposes
//     it as window.hologram.pointerStats for sessionrec.js. clicks counts hand clicks routed
//     to the host (not calibration clicks).
//   Events (type, detail):
//     'frame'       { mode, hands, calibrating, now }   each camera frame, after clicks/reset/hint
//     'click'       { type, x, y (NDC, y up), t, source: 'hand' | 'mouse',
//                     via: 'hold' | 'pinch' | 'other-pinch' | 'mouse', part: Object3D | null }
//                   a hand click while not calibrating, or a mouse click (<= 5 px between
//                   down and up). part: the targeted exploded part (bubble targeting, or the
//                   next part behind on a hold-again), hand clicks only; pass it on:
//                   manipulator.selectPartAtScreenPoint(x, y, { part }).
//     'target'      { part, hit, distPx } | null   the hovered selection target changed
//     'aim'         { state: pointer.state, hit: reticle result | null }       each display frame
//     'reset'       { why }       tracking reset (both hands lowered 1 s), not while calibrating
//     'hint'        hint | null   only when the hint key changes (pointer.js createTrackingMonitor)
//     'calibrated'  profile       calibration finished or was skipped
//     'practice-start' { rounds }  selection practice started (the host's button can say Stop at once)
//     'starting' / 'stop'         see start() / stop()
//     'ui-click'    { kind, el, label, x, y (page px), via }  a hand click that went to the page
//                   (handUI.js) instead of the 3D pick; kind = handUI press() result
//
//   HANDS ON THE PAGE (HANDS-UX-SPEC section 2; both options default off = the old behaviour):
//     handUI: true | handUI.js options   the hand cursor also works the page's buttons, sliders,
//       lists and scroll areas (handUI.js). While the cursor is over the page UI the 3D reticle
//       hides, nothing is hover/hold-selected and a hand click goes to the page, never to the
//       3D pick. body.hands-on is set while the camera runs.
//     cursorSpace: 'canvas' (default) | 'page'   what the calibrated reach maps onto: the canvas
//       (old) or the whole window, so the hand can reach a top bar or side panel outside the 3D
//       view. Calibration and selection practice always use the canvas (their targets are drawn
//       there). With 'page', 3D clicks and aim still arrive in canvas NDC (values past +-1 =
//       outside the canvas).
//     runtime.ui (handUI | null), runtime.pinchHeld (the clicking hand is still pinched; for
//       pinch-hold drags), runtime.cursorPx ({ x, y } page px of the hand cursor | null),
//       runtime.overUi. The 'aim' event detail also carries { px, ui } (page px, over the UI).
//   TOOL WHEEL (HANDS-UX-SPEC section 4; default off):
//     toolWheel: items | () => items   toolWheel.js items ({ dir, icon, label, run, enabled? }).
//       ✌ held 650 ms opens the wheel at the hand cursor; while it is open the other hand's pinch
//       picks the lit slot (never a 3D pick or a page click) and hold-select stands down. Closed
//       during calibration and selection practice. runtime.wheel (toolWheel | null);
//       events 'wheel' { type: 'open' | 'close' | 'pick', ...detail }.
//   HANDS V2 (plans/hands-v2/CONTRACT.md §0/§2; only with gestures.handsV2Enabled(), i.e. ?hands=v2
//   or localStorage['hands.v2']='1'; switch off = the v1 path above, unchanged):
//     each camera frame: handFeatures.update on the RAW hands (before smoothLandmarks) -> annotate
//     -> engagement -> inputArbiter.update -> manipulator.update(route.manip), pointer.update(
//     route.pointer), wheel.feed(route.wheel); a hand click passes arbiter.click() first.
//     runtime.arbiter (inputArbiter | null when v2 is off); runtime.setScope(name, { allow }?)
//     (no-op when v2 is off). injectFrame runs handFeatures on hands that have no hand.f yet.
//     Extra events: 'intent' arbiter.state every camera frame (owner, scope, poses, arming:
//     the Done / undo ring); 'done' { t, hand }, 'undo' { t, hand }, 'swipe' { t, hand, dir,
//     dxPalms, peakSpeed } (the host acts; a 'done' also closes an open tool wheel).
//     Hold-to-select only runs when pointer.clickAlt === 'hold' (v2 click = the hammer drop).
//   Not built yet (P1 step 2+): a per-hand 'rest' event and multiple pick roots.
const V = new URL(import.meta.url).search;

const { startCamera, stopCamera } = await import('./camera.js' + V);
const { createHandTracker, HAND_CONNECTIONS } = await import('./handTracker.js' + V);
const { annotateHand, handsV2Enabled } = await import('./gestures.js' + V);
const { createHandFeatures } = await import('./handFeatures.js' + V);
const { createInputArbiter } = await import('./inputArbiter.js' + V);
const { drawHands, sizeOverlayTo } = await import('./overlay.js' + V);
const { MODE } = await import('./manipulator.js' + V);
const { createHandModel } = await import('./handModel.js' + V);
const { smoothHandLandmarks, resetLandmarkSmoothing } = await import('./smoothLandmarks.js' + V);
const { createPointer, createEngagement, createResetGate, createTrackingMonitor, createSelector, nextInStack, BUBBLE_PX } = await import('./pointer.js' + V);
const { createReticle, probe, createPartHighlight, SELECTED_OUTLINE } = await import('./reticle.js' + V);
const { createCalibration, loadProfile, loadProfileV2, applyProfile, createSelectionPractice } = await import('./calibrate.js' + V);
const { createHandUI } = await import('./handUI.js' + V);
const { createToolWheel } = await import('./toolWheel.js' + V);

// A drag is an orbit, not a click (same 5 px rule as the measure panel).
const CLICK_TOLERANCE_PX = 5;

export function createHandsRuntime({
  scene, camera, renderer, canvas = renderer.domElement, overlay, video,
  pickTargets = () => null, ghostAnchor = pickTargets, manipulator = () => null, onAction = null,
  holdSelect = true, holdOn = () => 'parts', handUI = false, cursorSpace = 'canvas',
  toolWheel = null
}) {
  const overlayCtx = overlay.getContext('2d');
  const listeners = new Map();
  const emit = (type, detail) => {
    onAction?.(type, detail);
    for (const fn of listeners.get(type) ?? []) fn(detail);
  };

  let tracker = null;
  let stream = null;
  let tracking = false;
  let hands = [];
  let lastVideoTime = -1;

  // The hands drawn in the scene: a rigged hologram hand at a constant size (handModel.js),
  // falling back to ghostHands.js's skeleton if the hand asset can't load.
  const handModel = createHandModel(scene, HAND_CONNECTIONS);

  // Hands on the page (handUI.js): opt-in, so test pages that build a bare runtime are unchanged.
  const ui = handUI ? createHandUI({
    canvas, ...(handUI === true ? {} : handUI),
    onAction: (type, d) => { if (type === 'type') emit('ui-type', d); }
  }) : null;
  // The ✌ tool wheel (toolWheel.js): opt-in, like handUI.
  const wheel = toolWheel ? createToolWheel({ items: typeof toolWheel === 'function' ? toolWheel() : toolWheel }) : null;
  if (wheel) for (const type of ['open', 'close', 'pick']) wheel.on(type, (d) => emit('wheel', { type, ...d }));
  let pinchHeld = false;     // the non-aiming raised hand is pinched (camera frames)
  let cursorPx = null;       // page px of the hand cursor this display frame
  let overUi = false;
  const isFist = (h) => h.fistLike;

  // Finger-gun pointer (pointer.js) and its reticle (reticle.js). Aim with one hand in the
  // pointer pose, click with the other hand's pinch; the mouse drives the same cursor. Hands
  // count only while raised (createEngagement): lowered = at rest, drawn hand dimmed.
  const engagement = createEngagement();
  const pointer = createPointer();
  // Hands v2: read once, like gestures.js (switching mid-session would mix the two pipelines).
  const v2 = handsV2Enabled();
  const features = v2 ? createHandFeatures() : null;
  const arbiter = v2 ? createInputArbiter() : null;
  let lastManipMode = null; // the manipulator's previous-frame mode: arbiter ownership hint
  const reticle = createReticle(scene);
  const highlight = createPartHighlight(scene); // the hovered exploded part's outline
  // The SELECTED part's outline (Debbie-G #7): steady, brighter, drawn whether or not you aim.
  const selectedHighlight = createPartHighlight(scene, SELECTED_OUTLINE);
  // Lower both hands for 1 s = tracking reset; hints only while tracking struggles (owner, 2026-10-01).
  const resetGate = createResetGate();
  const trackingMonitor = createTrackingMonitor();

  const stats = { resets: 0, lastResetAt: null, hints: {}, hint: null, clicks: 0, selects: { hold: 0, pinch: 0, 'other-pinch': 0, mouse: 0 } };
  // One-hand selection: bubble targeting + hold-to-select (pointer.js createSelector).
  const selector = createSelector();
  let target = null;      // { part, hit, distPx, progress } | null
  let targetKey = null;
  let holdShown = 0;      // ring fill drawn on the reticle (one display frame behind: invisible)
  let hintKey = null;
  function setHint(hint) {
    const key = hint?.key ?? null;
    if (key === hintKey) return;
    hintKey = key;
    if (hint) stats.hints[key] = (stats.hints[key] ?? 0) + 1;
    emit('hint', hint ?? null);
  }

  // Calibration (calibrate.js): first camera use with no saved profile, then C / Recalibrate.
  // While it runs, gestures don't drive the model and hand clicks go to the targets.
  let profile = (v2 && loadProfileV2()) || loadProfile();
  applyProfile(profile, { pointer, engagement, features });
  const calibration = createCalibration({
    pointer,
    engagement,
    v2,
    features,
    rect: () => canvas.getBoundingClientRect(),
    video,
    onDone: (p) => finishCalibration(p),
    onCancel: (p) => finishCalibration(p)
  });
  function finishCalibration(p) {
    profile = p;
    thresholdsFor = null; // re-push the new clap thresholds on the next v2 frame
    emit('calibrated', p);
  }
  function calibrate(opts) {
    if (!tracking) return 'not-tracking';
    if (calibration.active) return 'busy';
    pointer.reset();
    calibration.start(performance.now(), opts);
    return 'started';
  }

  // Full tracking reset: everything that remembers past frames starts over. The model's pose is
  // NOT reset (that is the host's job); the manipulator's stabilisers drain on their own once no
  // hand is raised (their exit hold is 220 ms, well inside the 1 s lowering).
  function trackingReset(why = 'hands lowered') {
    resetLandmarkSmoothing();
    engagement.reset();
    pointer.reset();
    trackingMonitor.reset();
    selector.reset();
    setHint(null);
    stats.resets++;
    stats.lastResetAt = new Date().toISOString();
    emit('reset', { why });
  }

  function viewportSize() {
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width || 1, height: rect.height || 1 };
  }

  function eventNdc(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((e.clientY - rect.top) / rect.height) * 2 + 1
    };
  }

  function cursorPxOf(st) {
    const vp = viewportSize();
    return { x: ((st.x + 1) / 2) * vp.width, y: ((1 - st.y) / 2) * vp.height };
  }

  // Page px of a cursor in reach NDC (pointer.state / a pointer click), in the cursor space.
  const pageSpace = () => cursorSpace === 'page' && !calibration.active && !practice?.active;
  function pagePxOf(ndc) {
    if (pageSpace()) {
      const w = globalThis.innerWidth || 1, h = globalThis.innerHeight || 1;
      return { x: ((ndc.x + 1) / 2) * w, y: ((1 - ndc.y) / 2) * h };
    }
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
  }
  // Canvas NDC of a page px (past +-1 = outside the canvas).
  function canvasNdcOf(px) {
    const rect = canvas.getBoundingClientRect();
    return { x: ((px.x - rect.left) / (rect.width || 1)) * 2 - 1, y: -((px.y - rect.top) / (rect.height || 1)) * 2 + 1 };
  }
  // A pointer click (reach NDC) as a canvas-NDC click carrying its page px.
  function placeClick(click) {
    if (!click || click.source !== 'hand') return click;
    const px = pagePxOf(click);
    return pageSpace() ? { ...click, ...canvasNdcOf(px), px } : { ...click, px };
  }

  // Ranked part candidates at an NDC point, or [] when parts aren't the target right now.
  function partCandidates(ndc) {
    const manip = manipulator();
    if (holdOn() !== 'parts' || !manip?.partsSelectable || !manip.partsNear) return [];
    return manip.partsNear(ndc, BUBBLE_PX, { viewport: viewportSize() });
  }

  // The part a hand pinch-click means: the hovered target if it is still in reach at the
  // (rewound) click point, else the front hit or nearest box there.
  function partForClick(click) {
    const ranked = partCandidates({ x: click.x, y: click.y });
    const keep = target?.part && ranked.find((c) => c.part === target.part && (c.hit || c.distPx <= BUBBLE_PX));
    if (keep) return keep.part;
    const first = ranked[0];
    return first && (first.hit || first.distPx <= BUBBLE_PX) ? first.part : null;
  }

  // Selection practice (calibrate.js createSelectionPractice): while it runs, hand clicks and
  // the hold ring belong to its targets, not the model.
  let practice = null;
  function startPractice(opts = {}) {
    if (!tracking && !opts.force) return 'not-tracking';
    if (calibration.active || practice?.active) return 'busy';
    practice = createSelectionPractice({
      pointer,
      rect: () => canvas.getBoundingClientRect(),
      ...opts,
      onDone: (r) => { stats.practice = r; emit('practice', r); opts.onDone?.(r); }
    });
    practice.start(performance.now());
    emit('practice-start', { rounds: opts.rounds ?? null });
    return 'started';
  }

  // Hand clicks while not calibrating, and mouse clicks, all reach the host here.
  function route(click) {
    if (!click) return;
    click.via ??= click.source === 'mouse' ? 'mouse' : 'other-pinch';
    if (practice?.active && click.source === 'hand') {
      practice.onClick(click);
      return;
    }
    // The open tool wheel takes every hand click (runs the lit slot); a mouse click elsewhere closes it.
    if (wheel?.isOpen) {
      if (click.source === 'hand' && wheel.click()) return;
      if (click.source === 'mouse') { wheel.close('api'); return; }
    }
    // Over the page UI: the click is the page's (a button, slider, list), never a 3D pick.
    if (ui && click.source === 'hand' && click.via !== 'hold') {
      // Injected clicks carry canvas NDC (no px): their page px is on the canvas.
      const rect = canvas.getBoundingClientRect();
      const px = click.px ?? { x: rect.left + ((click.x + 1) / 2) * rect.width, y: rect.top + ((1 - click.y) / 2) * rect.height };
      if (ui.overUiAt(px)) {
        const kind = ui.press({ px, tap: click.via === 'pinch' });
        stats.uiClicks = (stats.uiClicks ?? 0) + 1;
        emit('ui-click', { kind, el: ui.target, label: ui.target ? (ui.target.getAttribute('aria-label') || ui.target.textContent || '').trim().slice(0, 60) : '', x: px.x, y: px.y, via: click.via, t: click.t });
        return;
      }
    }
    if (click.source === 'hand') {
      stats.clicks++;
      if (click.part === undefined) click.part = partForClick(click);
    } else {
      click.part ??= null;
    }
    stats.selects[click.via] = (stats.selects[click.via] ?? 0) + 1;
    // Whatever was clicked must not then also fire by hold while the cursor rests on it.
    selector.block(cursorPxOf(click));
    emit('click', click);
  }

  // Bubble target + hold ring, every display frame after the reticle.
  function updateSelection(st, hit, nowMs) {
    if (practice?.active) {
      holdShown = practice.onFrame(nowMs)?.visibleProgress ?? 0;
      return;
    }
    const aiming = holdSelect && !calibration.active && st.mode === 'aim';
    let candidates = [];
    if (aiming) {
      const on = holdOn();
      if (on === 'parts') candidates = partCandidates({ x: st.x, y: st.y });
      else if (on === 'surface' && hit) candidates = [{ id: 'surface', hit: true, distPx: 0, rankPx: 0 }];
    }
    const s = selector.update({
      candidates,
      cursorPx: aiming ? cursorPxOf(st) : null,
      t: nowMs,
      // v2: the hammer drop is the click; hold-to-select is an opt-in alternative (pointer.clickAlt).
      canHold: st.source === 'hand' && !st.frozen && (!v2 || pointer.clickAlt === 'hold')
    });
    holdShown = s.visibleProgress;
    target = s.target ? { part: s.target.part ?? null, hit: !!s.target.hit, distPx: s.target.distPx ?? 0, progress: s.visibleProgress } : null;
    const key = s.target ? (s.target.part ?? s.target.id) : null;
    if (key !== targetKey) {
      targetKey = key;
      emit('target', target ? { part: target.part, hit: target.hit, distPx: target.distPx } : null);
    }
    if (!s.fired) return;
    // Hold again on a part that is already selected: the next part behind it, front to back.
    let part = s.fired.part ?? null;
    const manip = manipulator();
    if (part && manip?.activePart) {
      const hits = candidates.filter((c) => c.hit);
      if (hits.some((c) => c.part === manip.activePart)) part = nextInStack(hits, manip.activePart).part;
    }
    route({ type: 'click', x: st.x, y: st.y, t: nowMs, source: 'hand', via: 'hold', part });
  }

  // Mouse input on the canvas: clicks (a drag is an orbit, not a click) and the mouse fallback,
  // which drives the same cursor (and reticle) as the hand pointer.
  let clickDownAt = null;
  const onDown = (e) => {
    clickDownAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const onUp = (e) => {
    const down = clickDownAt;
    clickDownAt = null;
    if (!down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX) return;
    const at = eventNdc(e);
    route(pointer.mouseClick(at.x, at.y));
  };
  const onMove = (e) => {
    if (e.pointerType === 'touch') return;
    const at = eventNdc(e);
    pointer.mouseMove(at.x, at.y);
  };
  const onLeave = () => pointer.mouseLeave();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  // Camera frame timing. requestVideoFrameCallback reports each new camera frame once, with
  // its capture time; the old way (polling video.currentTime from the render loop) stamped
  // frames with whenever the render loop noticed them, which adds up to a display frame of
  // random error to every dt. At 30 fps that is ±50% noise on the elapsed time the landmark
  // filter and every per-second rate divide by. Falls back to the old polling where the API
  // is missing (older Safari), and to the callback's own time where captureTime is absent.
  let latestFrame = null;   // { t, id } of the newest camera frame not yet processed
  let frameCounter = 0;
  let lastFrameStamp = -Infinity;
  let frameWatchStream = null;
  let processedFrameId = 0;

  function watchVideoFrames() {
    if (!video.requestVideoFrameCallback || frameWatchStream === stream) return;
    frameWatchStream = stream;
    const mine = stream;
    const onFrame = (now, meta) => {
      if (!tracking || stream !== mine) return;
      // captureTime shares performance.now()'s clock; anything implausible falls back to the
      // callback's own time.
      const c = meta?.captureTime;
      const t = Number.isFinite(c) && Math.abs(c - now) < 1000 ? c : now;
      latestFrame = { t, id: ++frameCounter };
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  // The timestamp of a camera frame that hasn't been processed yet, or null. Always strictly
  // increasing, which the tracker requires.
  function nextFrameTime() {
    let t = null;
    if (video.requestVideoFrameCallback) {
      if (!latestFrame || latestFrame.id === processedFrameId) return null;
      processedFrameId = latestFrame.id;
      t = latestFrame.t;
    } else {
      if (video.currentTime === lastVideoTime) return null;
      lastVideoTime = video.currentTime;
      t = performance.now();
    }
    if (t <= lastFrameStamp) t = lastFrameStamp + 1;
    lastFrameStamp = t;
    return t;
  }

  async function start() {
    // Reused across stop/start: the recognizer holds the WASM runtime, the model and a GPU
    // context, and stop never closed it, so every restart used to build (and leak) another
    // one (BUGS #16). Loading it once also makes a restart near-instant.
    if (!tracker) {
      emit('starting', { phase: 'model' });
      tracker = await createHandTracker({ numHands: 2 });
    }
    emit('starting', { phase: 'camera' });
    stream = await startCamera(video);
    tracking = true;
    ui?.setEnabled(true);
    watchVideoFrames();
  }

  function stop() {
    tracking = false;
    pinchHeld = false;
    ui?.setEnabled(false);
    stopCamera(stream);
    stream = null;
    video.srcObject = null;
    hands = [];
    latestFrame = null;
    frameWatchStream = null;
    resetLandmarkSmoothing();
    engagement.reset();
    pointer.reset();
    features?.reset();
    arbiter?.reset();
    lastManipMode = null;
    resetGate.reset();
    trackingMonitor.reset();
    selector.reset();
    practice?.dispose();
    setHint(null);
    calibration.abort();
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    handModel.clear();
    overlayShown = null;
    emit('stop');
  }

  // Whether the debug overlay canvas can be seen, re-read at most every 250 ms (a style read
  // per frame isn't free). Cleared once when it becomes hidden, so it reappears blank.
  let overlayShown = null;
  let overlayCheckedAt = -Infinity;
  function overlayVisible(nowMs) {
    if (nowMs - overlayCheckedAt < 250 && overlayShown !== null) return overlayShown;
    overlayCheckedAt = nowMs;
    const shown = overlay.isConnected && (overlay.checkVisibility
      ? overlay.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      : getComputedStyle(overlay).visibility !== 'hidden');
    if (!shown && overlayShown !== false) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    overlayShown = shown;
    return shown;
  }

  let snappedVertex = null; // the reticle's current snap, for hysteresis when a click re-probes

  // Every display frame (after the drawn hands, whose index tip the beam starts from).
  function updatePointerVisuals(nowMs) {
    pointer.tick(nowMs);
    let st = pointer.state;
    // The hand cursor on the page (handUI.js): over the UI, the 3D reticle and hold-select stand down.
    const handCursor = st.source === 'hand' && st.mode !== 'off';
    cursorPx = handCursor ? pagePxOf(st) : null;
    if (handCursor && pageSpace()) st = { ...st, ...canvasNdcOf(cursorPx) };
    overUi = false;
    if (ui) {
      const special = calibration.active || !!practice?.active;
      overUi = ui.update({ px: special ? null : cursorPx, pinchHeld, nowMs }).overUi;
    }
    const target = pickTargets();
    const shown = st.mode !== 'off' && target && !overUi;
    const result = reticle.update({
      cursor: shown ? { x: st.x, y: st.y } : null,
      object: target,
      camera,
      viewport: viewportSize(),
      beamFrom: st.source === 'hand' && st.aimHand ? handModel.landmarkOf(st.aimHand, 8) : null,
      nowMs,
      hold: shown ? holdShown : 0
    });
    snappedVertex = result?.vertex ?? null;
    wheel?.point(cursorPx, nowMs);
    updateSelection(overUi || wheel?.isOpen ? { ...st, mode: 'off' } : st, result, nowMs);
    highlight.update({ part: target?.part ?? null, nowMs });
    selectedHighlight.update({ part: manipulator()?.activePart ?? null, nowMs });
    emit('aim', { state: st, hit: overUi ? null : result ?? null, px: cursorPx, ui: overUi });
  }

  // One camera frame's hands (annotated) through engagement, the manipulator, the pointer and
  // the click router. Shared by update() and injectFrame() (tests drive it without a camera).
  function processFrame(frameHands, aspect, now, manip = manipulator()) {
    hands = frameHands;
    // Raised hands only (hand.engaged); the manipulator and pointer both ignore lowered ones.
    engagement.update(hands);
    const calibrating = calibration.active;
    if (v2) return processFrameV2(aspect, now, manip, calibrating);

    const mode = calibrating ? MODE.IDLE : manip?.update(hands, aspect, now) ?? MODE.IDLE;
    const click = pointer.update(hands, aspect, now);
    // Pinch-hold drags (sliders, scroll, the polygon lens radius): the clicking hand = any
    // raised hand other than the aiming one, still pinched.
    const aimHand = pointer.state.aimHand;
    pinchHeld = hands.some((h) => h !== aimHand && h.engaged !== false && h.pinch?.pinching === true);
    if (wheel) {
      if (calibrating || practice?.active) wheel.close('api');
      else wheel.feed(hands, now);
    }
    if (calibrating) {
      calibration.onClick(click);
      calibration.onFrame(hands, now);
      if (click) reticle.pulse();
    } else {
      route(placeClick(click));
    }
    if (resetGate.update(hands, now) && !calibrating) trackingReset();
    const hint = trackingMonitor.update(hands, pointer.state, now);
    stats.hint = hint?.key ?? null;
    setHint(hint);
    emit('frame', { mode, hands, calibrating, now });
    return mode;
  }

  // v2 twin of processFrame (CONTRACT §0): the arbiter decides which consumer sees the hands.
  // Kept separate so the v1 path above stays byte-for-byte what it was.
  // Per-person clap thresholds from the calibration v2 profile, pushed once per manipulator
  // (hosts swap the manipulator on model load) and again after each calibration.
  let thresholdsFor = null;
  function applyManipThresholds(manip) {
    if (!manip?.setThresholds || manip === thresholdsFor) return;
    thresholdsFor = manip;
    const t = profile?.v === 2 ? profile.thresholds : null;
    if (!t) return;
    const patch = {};
    for (const k of ['CLAP_ARM_SPAN', 'CLAP_CONTACT_SPAN', 'CLAP_V_MIN']) if (Number.isFinite(t[k])) patch[k] = t[k];
    manip.setThresholds(patch);
  }

  function processFrameV2(aspect, now, manip, calibrating) {
    applyManipThresholds(manip);
    // Calibration owns the hands outright: it needs the pointer, never the arbiter's routing.
    const arb = arbiter.update(hands, now, { wheelOpen: !!wheel?.isOpen, manipMode: lastManipMode, aspect });
    const to = calibrating ? { pointer: hands, manip: [], wheel: [] } : arb.route;
    const mode = calibrating ? MODE.IDLE : manip?.update(to.manip, aspect, now) ?? MODE.IDLE;
    lastManipMode = mode;
    const vp = pageSpace() ? { width: window.innerWidth || 1, height: window.innerHeight || 1 } : viewportSize();
    pointer.setView?.(vp.width / vp.height);
    const click = pointer.update(to.pointer, aspect, now);
    const aimHand = pointer.state.aimHand;
    pinchHeld = to.pointer.some((h) => h !== aimHand && h.engaged !== false && h.pinch?.pinching === true);
    if (wheel) {
      if (calibrating || practice?.active) wheel.close('api');
      else wheel.feed(to.wheel, now);
    }
    if (calibrating) {
      calibration.onClick(click);
      calibration.onFrame(hands, now);
      if (click) reticle.pulse();
    } else {
      route(arbiter.click(placeClick(click)));
      for (const ev of arb.events) {
        if (ev.type === 'done' && wheel?.isOpen) wheel.close('done');
        emit(ev.type, ev);
      }
    }
    emit('intent', arb.state);
    if (resetGate.update(hands, now) && !calibrating) trackingReset();
    const hint = trackingMonitor.update(hands, pointer.state, now);
    stats.hint = hint?.key ?? null;
    setHint(hint);
    emit('frame', { mode, hands, calibrating, now });
    return mode;
  }

  function update(tickNow = performance.now()) {
    const manip = manipulator();
    if (!tracking || !sizeOverlayTo(overlay, video)) {
      // Still advance the model's follow springs, so a release that was coasting when the
      // camera stopped settles instead of freezing mid-glide.
      manip?.tick(tickNow);
      updatePointerVisuals(tickNow);
      return null;
    }

    const aspect = overlay.width / overlay.height;
    let mode = null;

    const frameTime = nextFrameTime();
    if (frameTime !== null) {
      // One timestamp per camera frame, used by the tracker, the landmark filter and the
      // manipulator alike. Every filter downstream is time-based now, so this has to be when
      // the frame was captured, not when the render loop happened to notice it (see
      // nextFrameTime).
      const now = frameTime;
      hands = tracker.read(video, now);
      // v2: features from the RAW landmarks (velocity, hammer and aim must not see the filter).
      if (v2) features.update(hands, now, { aspect });
      smoothHandLandmarks(hands, now);
      // Pointer first, once per hand per frame (gestures.js annotateHand): a pointer is never
      // read as a grabbing fist and never blocks a pinch (BUGS #32). hand.pointer is
      // { gun, rejectedBy }; the manipulator also uses it for the post-pointer gap.
      for (const hand of hands) annotateHand(hand, aspect);
      mode = processFrame(hands, aspect, now, manip);
    }
    // Every display frame, not just camera frames: the model's follow springs glide between
    // camera frames instead of stepping at camera rate (manipulator.js, "FOLLOW").
    manip?.tick(tickNow);
    calibration.tick(tickNow);

    // Real 3D hands (always on) are the primary visual feedback. The aiming hand is drawn
    // where it really is; the reticle's beam runs from its real index tip to the cursor
    // (the old ghostOffset shift moved the hand onto the cursor, which read as the hand
    // jumping away from where it was).
    const anchor = ghostAnchor();
    if (anchor) handModel.update(hands, { camera, object: anchor, aspect, isFist, nowMs: tickNow });
    // The flat 2D skeleton is a debug view behind the host's toggle and hidden otherwise
    // (always hidden on the Platform): only draw it while it can be seen.
    if (overlayVisible(tickNow)) drawHands(overlayCtx, hands, HAND_CONNECTIONS);
    updatePointerVisuals(tickNow);
    return mode;
  }

  function dispose() {
    if (tracking) stop();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    reticle.dispose?.();
    handModel.dispose();
    highlight.dispose();
    selectedHighlight.dispose();
    ui?.dispose();
    wheel?.dispose();
    listeners.clear();
  }

  return {
    start,
    stop,
    update,
    calibrate,
    dispose,
    probeAt: (x, y) => probe(x, y, { object: pickTargets(), camera, viewport: viewportSize(), snapped: snappedVertex }),
    pulse: () => reticle.pulse(),
    // Keyboard Tab: select the next part behind the cursor (front to back), or the next part
    // in order when the cursor is over none. Returns the part selected, or null.
    cycleTarget() {
      const manip = manipulator();
      if (!manip?.partsSelectable) return null;
      const st = pointer.state;
      const hits = st.mode === 'off' ? [] : partCandidates({ x: st.x, y: st.y }).filter((c) => c.hit);
      const list = hits.length > 1 ? hits : manip.parts.map((part) => ({ part }));
      const next = nextInStack(list, manip.activePart)?.part ?? null;
      return manip.selectPart(next);
    },
    injectClick(click) {
      if (click && !calibration.active) route({ ...click });
    },
    // Tests / replays: one camera frame of already-annotated hands (gestures.annotateHand, or
    // hand.pointer / hand.pinch set by hand) through the same path as update() (engagement,
    // manipulator, pointer, clicks incl. handUI, pinchHeld), then a display frame. No camera.
    injectFrame(frameHands, { aspect = 16 / 9, t = performance.now() } = {}) {
      const manip = manipulator();
      if (v2 && frameHands?.some((h) => h && h.f === undefined)) features.update(frameHands, t, { aspect });
      const mode = processFrame(frameHands, aspect, t, manip);
      manip?.tick(t);
      updatePointerVisuals(t);
      return mode;
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    get tracking() { return tracking; },
    get hands() { return hands; },
    get pointer() { return pointer; },
    get engagement() { return engagement; },
    get calibration() { return calibration; },
    get profile() { return profile; },
    get stats() { return stats; },
    get target() { return target; },
    get practice() { return practice; },
    get handModel() { return handModel; },
    get ui() { return ui; },
    get pinchHeld() { return pinchHeld; },
    get cursorPx() { return cursorPx; },
    get wheel() { return wheel; },
    get arbiter() { return arbiter; },
    setScope(name, opts) { arbiter?.setScope(name, opts); },
    get overUi() { return overUi; },
    startPractice,
    get selector() { return selector; }
  };
}

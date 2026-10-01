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
//     via?, part? }); for labs, tests and replays. Ignored while calibrating.
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
//     'starting' / 'stop'         see start() / stop()
//   Not built yet (P1 step 2+): a per-hand 'rest' event and multiple pick roots.
const V = new URL(import.meta.url).search;

const { startCamera, stopCamera } = await import('./camera.js' + V);
const { createHandTracker, HAND_CONNECTIONS } = await import('./handTracker.js' + V);
const { annotateHand } = await import('./gestures.js' + V);
const { drawHands, sizeOverlayTo } = await import('./overlay.js' + V);
const { MODE } = await import('./manipulator.js' + V);
const { createHandModel } = await import('./handModel.js' + V);
const { smoothHandLandmarks, resetLandmarkSmoothing } = await import('./smoothLandmarks.js' + V);
const { createPointer, createEngagement, createResetGate, createTrackingMonitor, createSelector, nextInStack, BUBBLE_PX } = await import('./pointer.js' + V);
const { createReticle, probe, createPartHighlight } = await import('./reticle.js' + V);
const { createCalibration, loadProfile, applyProfile, createSelectionPractice } = await import('./calibrate.js' + V);

// A drag is an orbit, not a click (same 5 px rule as the measure panel).
const CLICK_TOLERANCE_PX = 5;

export function createHandsRuntime({
  scene, camera, renderer, canvas = renderer.domElement, overlay, video,
  pickTargets = () => null, ghostAnchor = pickTargets, manipulator = () => null, onAction = null,
  holdSelect = true, holdOn = () => 'parts'
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
  const isFist = (h) => h.fistLike;

  // Finger-gun pointer (pointer.js) and its reticle (reticle.js). Aim with one hand in the
  // pointer pose, click with the other hand's pinch; the mouse drives the same cursor. Hands
  // count only while raised (createEngagement): lowered = at rest, drawn hand dimmed.
  const engagement = createEngagement();
  const pointer = createPointer();
  const reticle = createReticle(scene);
  const highlight = createPartHighlight(scene); // the hovered exploded part's outline
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
  let profile = loadProfile();
  applyProfile(profile, { pointer, engagement });
  const calibration = createCalibration({
    pointer,
    engagement,
    rect: () => canvas.getBoundingClientRect(),
    video,
    onDone: (p) => finishCalibration(p),
    onCancel: (p) => finishCalibration(p)
  });
  function finishCalibration(p) {
    profile = p;
    emit('calibrated', p);
  }
  function calibrate() {
    if (!tracking) return 'not-tracking';
    if (calibration.active) return 'busy';
    pointer.reset();
    calibration.start(performance.now());
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
      canHold: st.source === 'hand' && !st.frozen
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
    watchVideoFrames();
  }

  function stop() {
    tracking = false;
    stopCamera(stream);
    stream = null;
    video.srcObject = null;
    hands = [];
    latestFrame = null;
    frameWatchStream = null;
    resetLandmarkSmoothing();
    engagement.reset();
    pointer.reset();
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
    const st = pointer.state;
    const target = pickTargets();
    const shown = st.mode !== 'off' && target;
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
    updateSelection(st, result, nowMs);
    highlight.update({ part: target?.part ?? null, nowMs });
    emit('aim', { state: st, hit: result ?? null });
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
      smoothHandLandmarks(hands, now);
      // Pointer first, once per hand per frame (gestures.js annotateHand): a pointer is never
      // read as a grabbing fist and never blocks a pinch (BUGS #32). hand.pointer is
      // { gun, rejectedBy }; the manipulator also uses it for the post-pointer gap.
      for (const hand of hands) annotateHand(hand, aspect);
      // Raised hands only (hand.engaged); the manipulator and pointer both ignore lowered ones.
      engagement.update(hands);

      const calibrating = calibration.active;
      mode = calibrating ? MODE.IDLE : manip?.update(hands, aspect, now) ?? MODE.IDLE;
      const click = pointer.update(hands, aspect, now);
      if (calibrating) {
        calibration.onClick(click);
        calibration.onFrame(hands, now);
        if (click) reticle.pulse();
      } else {
        route(click);
      }
      if (resetGate.update(hands, now) && !calibrating) trackingReset();
      const hint = trackingMonitor.update(hands, pointer.state, now);
      stats.hint = hint?.key ?? null;
      setHint(hint);
      emit('frame', { mode, hands, calibrating, now });
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
    startPractice,
    get selector() { return selector; }
  };
}

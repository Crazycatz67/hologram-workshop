// Hands on the Platform (plans/platform/P1-hands-design.md, step 2): the Platform adapter for
// the shared hands runtime (../handsRuntime.js). The runtime does the camera, tracking, pointer,
// reticle, ghost hands, calibration and the lower-both-hands reset; this file only says what a
// hand means HERE: aim = objectMode hover, click = objectMode select. Every change still goes
// through objectmode.js, so undo, autosave and versions see hand edits exactly like mouse ones.
// Step 3 adds grab / move / twist-turn / two-hand scale and pins (see GESTURES below).
//
// CONTRACT
//   createPlatformHands({ scene, camera, renderer, controls, objectMode, getItems, button?,
//                         setStatus?, busy?, expose?, loadRuntime? }) -> hands
//     getItems(): the ready library items ({ root, parts: [{ id, mesh }] }), read every frame.
//     button: the top-bar Camera toggle (label, aria-pressed and .active are kept in sync).
//     setStatus(msg, isError): the page's status line.
//     busy(): true while hands must do nothing in the scene (no hover, select or gesture). Default
//       false. (The polygon lens and the Library ring no longer gate the hands: see ring/polygon.)
//     ring(): the Library ring (ring.js) or null. While it is open the scene is behind it: aim +
//       other-pinch works its cards through handUI.js (the ring's surface is data-hand=surface),
//       a fist-drag spins it (ring.spinBy / spinEnd) and a flick coasts; nothing else moves.
//     polygon(): the polygon lens (polygon.js) or null. While it is on, the lens follows the hand
//       cursor; the other hand's pinch selects the faces in it (on the release); pinch-hold +
//       vertical move sets its radius (up = bigger, x2 per LENS_PX_PER_E2 px), shown on the lens.
//     resetView(): what a clap does on the Platform (main.js: frame everything; no edit).
//     helpEl: the Help popover; gets the "remember the camera" checkbox (handUI.js).
//     expose: an object (window.hologram) that gets handsRuntime / pointerStats / pointerProfile /
//       calibration once the runtime exists, under the same names hologram.html uses, so
//       sessionrec.js and tests read both pages the same way.
//     loadRuntime(): Promise<createHandsRuntime>; injectable for tests. The default imports
//       ../handsRuntime.js on the FIRST Camera press: it pulls MediaPipe from the CDN, and the
//       Platform must open (and work offline) without it.
//   hands.update(nowMs)   call once per display frame from the Platform's render loop (main.js
//     onTick); never starts its own rAF. Cheap no-op until the camera has been started.
//   hands.start() -> Promise<boolean>  / hands.stop() / hands.toggle()
//   hands.autoStart() -> Promise<state>   page load: start the camera if it was remembered and
//     the browser already allows it; else pulse the Camera button (handUI.js autoStartCamera).
//   The runtime is built with handUI: true and cursorSpace 'page': the hand cursor reaches the
//   top bar and both side panels and clicks / drags / scrolls them; over them nothing in the 3D
//   view is hovered, held or picked.
//   hands.calibrate() -> runtime.calibrate() result, or 'not-tracking'
//   hands.handleAim({ state, hit }) / hands.handleClick(click)   what the runtime's 'aim' and
//     'click' events do; exported so tests can drive the adapter without a camera.
//   hands.pickRoot        the Object3D the reticle raycasts (proxy over every visible item mesh)
//   Getters: runtime (null before first start), tracking, hoverKey (what the hand hovers:
//     part id in object mode, 'item:<id>' in scene mode, or null), stats.
//
//   Meaning of a hand click (any `via`: 'hold' | 'pinch' | 'other-pinch'):
//     object mode: select the part under the click (mouse parity: a part of the already
//       selected whole item keeps the whole item); empty space clears the selection.
//     scene mode:  select the whole item under the click (design table); empty space clears.
//   Mouse clicks are ignored here: objectmode.js already handles the mouse, and handling them
//   twice would change mouse behaviour (scene-mode clicks select nothing today).
//   A pinned whole item does not swallow clicks on its parts: they select the part, which is
//   how you grab one part of a pinned item.
//
// GESTURES (step 3). Which hand shape is which gesture is decided by the v1 manipulator
// (../manipulator.js), not here: it already holds the stabilisers, deadzones, follow springs,
// the Engage -> Aim -> Act gaps and the BUGS #47 latch (a same-hand pinch on the aiming hand
// is never a fist, so it never starts a grab). It drives an invisible PROXY in a private
// camera frame instead of a model; every display frame this adapter reads the proxy's change
// and turns it into objectMode calls, then puts the proxy back. So the Platform never moves
// an object itself, and every hand edit lands in objectMode's edit log (undo, autosave,
// versions). Channels: move, spin, push, scale, tilt, clap.
//   Fist, nothing selected: orbit; push / pull while orbiting = zoom (dolly to the orbit centre,
//     clamped to controls.minDistance..maxDistance); the second hand's tilt raises / lowers the
//     view (like the fist's own up/down). A selected item never tilts (furniture stays upright).
//   Clap (from rest): resetView() (no edit, so nothing to undo; the camera view autosaves).
//   Explode: not on the Platform yet (objectMode has no explode op); the gesture says so.
//   Fist, something selected     -> objectMode.beginMove(sel) ... moveBy(dx, dz, dy) ...
//                                   endMove(): ONE 'move' edit per grab. Hand left/right ->
//                                   along the screen's right on the floor; push/pull -> along
//                                   the view direction on the floor; wrist twist -> turn about
//                                   the vertical (dy). Height never changes.
//   Fist, nothing selected       -> orbit the camera about its target (no edit).
//   Both hands pinching          -> objectMode.scaleTarget(sel, f, { group }): ONE 'scale'
//                                   edit per two-hand pinch.
//   Selection pinned             -> nothing moves and the camera holds still; the status line
//                                   says it is pinned.
//   The gesture target is the selection at the moment the gesture starts, in either mode
//   (scene mode selects whole items), so hands never need Tab. Gestures pause while busy().
//   A release lets the follow spring land (<= SETTLE_MAX_MS) before the edit is committed.
//   hands.gesture  the manipulator-shaped object the runtime drives ({ update(hands, aspect,
//     t), tick(t), mode }); tests feed synthetic hands straight into it after ensureGesture().
//   hands.ensureGesture() -> Promise   loads ../manipulator.js (no MediaPipe) and builds it.
//   hands.session  the running gesture: null | { kind: 'move'|'orbit'|'scale'|'held', id }.

import * as THREE from 'three';

const V = new URL(import.meta.url).search;

// Same wording as hologram.html's coach (hologram.js HINT_TEXT), one line for the status bar.
const HINT_TEXT = {
  flicker: '☝ Hold the pointer shape: index straight out, the other three fingers curled tight',
  edge: '↔ Bring your hand back toward the middle (or press C to recalibrate your reach)',
  lost: '✋ Keep your hand inside the camera view'
};

const isItemKey = (k) => typeof k === 'string' && k.startsWith('item:');

export function createPlatformHands({
  scene, camera, renderer, controls, objectMode, getItems,
  button = null, setStatus = () => {}, busy = () => false, expose = null,
  ring = () => null, polygon = () => null, resetView = null, helpEl = null, toolWheel = null,
  loadRuntime = () => import('../handsRuntime.js' + V).then((m) => m.createHandsRuntime)
}) {
  let runtime = null;
  let loading = null;
  let clearFrames = 0;      // display frames still to run after stop, so the reticle eases out
  let hoverKey = null;      // what the HAND set as objectMode's hover (never the mouse's)
  const stats = {
    clicks: 0, selects: 0, misses: 0, ignored: 0, bvhBuilt: 0, bvhMs: 0,
    // step 3: gestures started, by what they did; refused = blocked by a pin
    grabs: 0, moves: 0, orbits: 0, scales: 0, refused: 0,
    // hands on the page: ring spins, lens selects / resizes, claps, page clicks (handUI)
    ringSpins: 0, lensSelects: 0, lensResizes: 0, claps: 0, zooms: 0
  };
  const ringOpen = () => !!ring()?.isOpen?.();
  const lens = () => { const p = polygon(); return p?.active ? p : null; };

  // The camera stream and the debug skeleton canvas: the runtime needs both. Hidden, like on
  // hologram.html (seeing your own video breaks the illusion); visibility rather than display,
  // so the browser still decodes frames and requestVideoFrameCallback keeps firing.
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:120px;visibility:hidden;pointer-events:none;z-index:-1';
  const video = Object.assign(document.createElement('video'), { playsInline: true, muted: true });
  const overlay = document.createElement('canvas');
  for (const el of [video, overlay]) { el.style.cssText = 'width:100%;height:100%'; mount.append(el); }
  document.body.append(mount);

  // The runtime raycasts one root. The Platform has many items, so this proxy stands in for all
  // of them: its raycast() tests every drawn mesh (not hidden parts, not hidden items, not the
  // inferred surfaces "As scanned" hides by material) and three sorts the hits. It is never added
  // to the scene. Its position is the orbit centre, which ghostHands.js and the reticle use as
  // "how far away the things are".
  const pickRoot = new THREE.Object3D();
  pickRoot.name = 'platform-hands-pick';
  const drawn = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
  const matShown = (m) => [m.material].flat().some((x) => x && x.visible !== false);
  function meshes() {
    const list = [];
    for (const it of getItems()) {
      if (!it.root || !drawn(it.root)) continue;
      for (const p of it.parts ?? []) if (p.mesh?.isMesh && drawn(p.mesh) && matShown(p.mesh)) list.push(p.mesh);
    }
    return list;
  }
  pickRoot.raycast = (raycaster, intersects) => {
    for (const m of meshes()) {
      const bvh = bvhFor(m.geometry);
      if (bvh) bvh.raycastObject3D(m, raycaster, intersects); else m.raycast(raycaster, intersects);
    }
  };

  // The reticle probes every display frame while the cursor is up. A plain raycast of the 304k-
  // triangle sample chair took ~7 ms a probe (measured headless), half a frame, so each drawn
  // geometry gets a three-mesh-bvh tree (already the polygon lens's library; same import map
  // entry, loaded only with the runtime). indirect: true leaves the geometry's index untouched,
  // so face numbers stay those of the scan. Trees build one geometry per macrotask after the
  // camera starts; until a tree exists that mesh is raycast the plain way. If the library
  // can't load (offline), everything stays plain.
  let MeshBVH = null;
  let bvhLoad = null;
  const bvhs = new WeakMap();   // geometry -> MeshBVH | 'queued'
  const buildQueue = [];
  let buildTimer = null;
  function bvhFor(geo) {
    const b = bvhs.get(geo);
    if (b && b !== 'queued') return b;
    if (!b && MeshBVH && geo?.attributes?.position) { bvhs.set(geo, 'queued'); buildQueue.push(geo); buildTimer ??= setTimeout(buildNext, 0); }
    return null;
  }
  function buildNext() {
    buildTimer = null;
    const geo = buildQueue.shift();
    if (!geo) return;
    const t0 = performance.now();
    try { bvhs.set(geo, new MeshBVH(geo, { indirect: true })); stats.bvhBuilt++; } catch (err) { console.warn('hands: BVH build failed, raycasting plain', err); bvhs.delete(geo); }
    stats.bvhMs += performance.now() - t0;
    if (buildQueue.length) buildTimer = setTimeout(buildNext, 0);
  }
  const hasTargets = () => getItems().some((it) => it.root && drawn(it.root));

  // Part / item under an NDC point, through the runtime's probe (the same hit the reticle shows).
  function hitAt(x, y) {
    const r = runtime?.probeAt(x, y) ?? null;
    const obj = r?.hit?.object ?? null;
    if (!obj) return null;
    return { partId: obj.userData.partId ?? null, itemId: obj.userData.itemId ?? null };
  }

  // The objectMode key a hand means at this hit, in the current mode.
  function keyFor(h) {
    if (!h) return null;
    if (objectMode.mode === 'object') return h.partId ?? (h.itemId != null ? `item:${h.itemId}` : null);
    return h.itemId != null ? `item:${h.itemId}` : null;
  }

  function setHover(key) {
    // setMode() clears objectMode's hover behind our back, so compare with what it shows too.
    if (key === hoverKey && objectMode.hoverId === key) return;
    // Only clear a hover the hand set; the mouse's own hover (objectmode tick) is left alone.
    if (key == null && objectMode.hoverId !== hoverKey) { hoverKey = null; return; }
    hoverKey = key;
    objectMode.hover(key);
  }

  // The lens follows the hand cursor (only a pointer the hand set is cleared by the hand).
  let lensByHand = false;
  function aimLens(px) {
    const L = lens();
    if (!L) { lensByHand = false; return; }
    if (px) { L.setPointer(px.x, px.y); lensByHand = true; } else if (lensByHand) { L.clearPointer(); lensByHand = false; }
  }

  function handleAim({ state, hit, px = null, ui = false } = {}) {
    const handAim = state && state.source === 'hand' && state.mode !== 'off' && !busy() && !runtime?.calibration?.active;
    aimLens(handAim && !ui && !ringOpen() ? px : null);
    // Over the page UI or the open ring, the scene behind is not hovered.
    if (!handAim || ui || ringOpen()) { setHover(null); return; }
    const obj = hit?.hit?.object ?? null;
    setHover(obj ? keyFor({ partId: obj.userData.partId ?? null, itemId: obj.userData.itemId ?? null }) : null);
  }

  function handleClick(click) {
    if (!click || click.source !== 'hand') return null;
    if (busy() || ringOpen()) { stats.ignored++; return null; }
    // Polygon lens: the click selects the lens's faces on the release (a pinch-hold that moves
    // up or down resizes the lens instead; see updateLensPress).
    const L = lens();
    if (L) {
      stats.clicks++;
      runtime?.pulse();
      const px = click.px ?? runtime?.cursorPx ?? null;
      if (px) L.setPointer(px.x, px.y);
      lensPress = { y0: px?.y ?? 0, r0: L.radius, resized: false, tap: click.via !== 'other-pinch' };
      if (lensPress.tap) finishLensPress();
      return 'lens';
    }
    stats.clicks++;
    runtime?.pulse();
    const h = hitAt(click.x, click.y);
    let key = keyFor(h);
    // Mouse parity (objectmode pointerdown): with a whole item selected, clicking one of its
    // parts keeps the whole item (it is what a grab will move in step 3).
    const sel = objectMode.selectedId;
    // Not when that item is pinned: then the click takes the part, which a grab can move alone.
    if (key && !isItemKey(key) && isItemKey(sel) && String(h.itemId) === sel.slice(5) && !objectMode.isPinned?.(sel)) key = sel;
    if (key) stats.selects++; else stats.misses++;
    objectMode.select(key);
    return key;
  }

  // ---- polygon lens by hand ---------------------------------------------------------------------
  // Pinch-hold + vertical move = lens radius (spec section 2: one "drag a value" meaning). Moving
  // the cursor up LENS_PX_PER_E2 px doubles it; LENS_SLOP_PX of wobble still counts as a click.
  const LENS_PX_PER_E2 = 160, LENS_SLOP_PX = 12;
  let lensPress = null;      // { y0, r0, resized, tap }
  function finishLensPress() {
    const p = lensPress;
    lensPress = null;
    const L = lens();
    if (!p || !L) return;
    if (p.resized) { stats.lensResizes++; return; }
    L.select({ add: false });
    stats.lensSelects++;
  }
  function updateLensPress() {
    if (!lensPress) return;
    const L = lens();
    const px = runtime?.cursorPx;
    if (!L) { lensPress = null; return; }
    if (px) {
      const dy = lensPress.y0 - px.y;   // up = positive
      if (!lensPress.resized && Math.abs(dy) > LENS_SLOP_PX) lensPress.resized = true;
      if (lensPress.resized) L.radius = lensPress.r0 * Math.pow(2, dy / LENS_PX_PER_E2);
    }
    if (!runtime?.pinchHeld) finishLensPress();
  }

  // ---- gestures: the v1 manipulator on a proxy, read back as objectMode calls ----------------
  // The proxy sits 1 unit in front of a private camera that has the real camera's fov and
  // aspect, so after a step its x / y are "world units per unit of depth" across / up the
  // screen, ln(|position|) is the push/pull, its Y turn is the twist and its scale the pinch
  // ratio. Put back every frame, so the manipulator's view clamp and depth limits never bite:
  // its springs keep their own state and only ever ADD the next step to whatever is there.
  let gestureLib = null;      // { createManipulator, MODE }
  let gestureLoad = null;
  let manip = null;
  let session = null;         // { kind, id, gesture, dx, dz, dy, group, endAt, still }
  let groupSeq = 0;
  const vcam = new THREE.PerspectiveCamera();
  const proxy = new THREE.Object3D();
  const PROXY_HOME = new THREE.Vector3(0, 0, -1);
  proxy.position.copy(PROXY_HOME);
  // After a release the follow spring still glides the last few mm (it trails a steady hand by
  // ~63 ms); the edit is committed once two display frames bring nothing new, or after this.
  const SETTLE_MAX_MS = 400;
  // Click = the OTHER hand's pinch while one hand aims. If MediaPipe reads that pinching hand
  // as Closed_Fist, the v1 manipulator would start a grab (it only latches the AIMING hand,
  // BUGS #47) and the click would drag the selection. So no grab opens while a pointer was up
  // this recently. The manipulator's own 300 ms post-pointer gap already delays a real
  // pointer -> fist switch past this, so that still grabs (hands-test G4).
  const POINTER_GRAB_BLOCK_MS = 200;
  let lastPointerAt = -Infinity;
  const GESTURE_CHANNELS = ['move', 'spin', 'push', 'scale', 'tilt', 'clap', 'explode'];

  function ensureGesture() {
    gestureLoad ??= import('../manipulator.js' + V).then((m) => {
      gestureLib = m;
      syncVcam();
      manip = m.createManipulator(proxy, vcam);
      // No coasting: an edit ends where the hand let go, not wherever momentum would carry it.
      manip.configure({ channels: GESTURE_CHANNELS, momentum: false });
      return gesture;
    });
    return gestureLoad;
  }

  function syncVcam() {
    if (vcam.fov !== camera.fov || vcam.aspect !== camera.aspect) {
      vcam.fov = camera.fov;
      vcam.aspect = camera.aspect;
      vcam.updateProjectionMatrix();
    }
  }

  // The proxy's change since it was last put back, then put it back.
  const qTmp = new THREE.Quaternion();
  function takeProxyStep() {
    const p = proxy.position;
    const len = p.length();
    qTmp.copy(proxy.quaternion);
    const step = {
      x: p.x - PROXY_HOME.x, y: p.y - PROXY_HOME.y,
      depth: len > 0 ? Math.log(len / PROXY_HOME.length()) : 0,
      spin: 2 * Math.atan2(qTmp.y, qTmp.w),
      // Tilt (the manipulator's pitch about the screen's x): only the orbit uses it.
      pitch: 2 * Math.atan2(qTmp.x, qTmp.w),
      scale: proxy.scale.x
    };
    if (step.pitch > Math.PI) step.pitch -= 2 * Math.PI;
    if (step.spin > Math.PI) step.spin -= 2 * Math.PI;
    proxy.position.copy(PROXY_HOME);
    proxy.quaternion.identity();
    proxy.scale.set(1, 1, 1);
    return step;
  }
  const isStill = (d) => Math.abs(d.x) < 1e-9 && Math.abs(d.y) < 1e-9 && Math.abs(d.depth) < 1e-9 && Math.abs(d.spin) < 1e-9 && Math.abs(d.pitch ?? 0) < 1e-9 && Math.abs(d.scale - 1) < 1e-9;

  const nameOf = (key) => {
    if (isItemKey(key)) return getItems().find((it) => String(it.id) === key.slice(5))?.name ?? 'This item';
    return `Part #${key}`;
  };
  function refusePinned(key) {
    stats.refused++;
    setStatus(`📌 ${nameOf(key)} is pinned · press K (or the pin chip) to unpin it`);
  }

  function centreOf(obj) {
    obj.updateWorldMatrix(true, true);
    return new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
  }

  function openSession(kind, nowMs) {
    const sel = objectMode.selectedId;
    if (kind === 'grab') stats.grabs++;
    // The Library ring is up: a fist spins it, nothing else moves.
    if (ringOpen()) {
      if (kind === 'grab') { stats.ringSpins++; return { kind: 'ring', id: null, gesture: kind }; }
      return { kind: 'held', id: null, gesture: kind };
    }
    if (kind === 'grab' && nowMs - lastPointerAt < POINTER_GRAB_BLOCK_MS) return { kind: 'held', id: sel, gesture: kind };
    // A mouse drag already owns the selection; the hand waits.
    if (objectMode.dragging) return { kind: 'held', id: sel, gesture: kind };
    if (sel == null) {
      if (kind === 'grab') { stats.orbits++; return { kind: 'orbit', id: null, gesture: kind }; }
      return { kind: 'held', id: null, gesture: kind };
    }
    if (objectMode.isPinned?.(sel)) { refusePinned(sel); return { kind: 'held', id: sel, gesture: kind }; }
    if (kind === 'scale') { stats.scales++; return { kind: 'scale', id: sel, gesture: kind, group: `hand-scale-${++groupSeq}` }; }
    const obj = objectMode.target(sel);
    const c = obj ? centreOf(obj) : new THREE.Vector3();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -c.y);
    if (!obj || !objectMode.beginMove(sel, plane, c)) return { kind: 'held', id: sel, gesture: kind };
    stats.moves++;
    return { kind: 'move', id: sel, gesture: kind, dx: 0, dz: 0, dy: 0, centre: c };
  }

  // The screen's right and the view direction, both laid flat on the floor.
  const flatRight = new THREE.Vector3(), flatFwd = new THREE.Vector3();
  function floorAxes() {
    camera.updateMatrixWorld();
    flatRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0);
    camera.getWorldDirection(flatFwd).setY(0);
    if (flatRight.lengthSq() < 1e-12) flatRight.set(1, 0, 0);
    // Looking straight down: "forward" on the floor is screen-up.
    if (flatFwd.lengthSq() < 1e-12) flatFwd.setFromMatrixColumn(camera.matrixWorld, 1).setY(0);
    flatRight.normalize();
    flatFwd.normalize();
  }

  const sph = new THREE.Spherical();
  function feed(s, d) {
    if (s.kind === 'move') {
      if (!objectMode.dragging) { s.kind = 'held'; return; }   // ended elsewhere (Tab, mouse)
      floorAxes();
      // The proxy works at depth 1; the real target is `dist` away, so lateral steps scale up
      // by dist, and a push of ln-ratio `depth` moves it dist * (e^depth - 1) along the view.
      const at = s.centre.clone().add(new THREE.Vector3(s.dx, 0, s.dz));
      const dist = Math.max(0.05, camera.position.distanceTo(at));
      const lateral = d.x * dist;
      const along = dist * (Math.exp(d.depth) - 1);
      s.dx += flatRight.x * lateral + flatFwd.x * along;
      s.dz += flatRight.z * lateral + flatFwd.z * along;
      s.dy += d.spin;
      if (d.x || d.depth || d.spin) objectMode.moveBy(s.dx, s.dz, s.dy);
    } else if (s.kind === 'ring') {
      // Hand right = the ring follows right (like a pointer drag): cards per proxy unit = the
      // view's width in px at depth 1 over the ring's px per card.
      const r = ring();
      if (!r || !d.x) return;
      const vw = renderer.domElement.clientWidth || 800;
      const unitsAcross = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
      r.spinBy?.(-(d.x * vw / unitsAcross) / (r._state?.().pxPerCard || 160));
    } else if (s.kind === 'orbit') {
      // Push / pull = zoom: dolly toward the orbit centre by the same ln-ratio the hand moved.
      if (d.depth) {
        const off = camera.position.clone().sub(controls.target);
        const lo = controls.minDistance ?? 0.01, hi = Number.isFinite(controls.maxDistance) ? controls.maxDistance : Infinity;
        const len = THREE.MathUtils.clamp(off.length() * Math.exp(-d.depth), Math.max(0.01, lo), hi);
        camera.position.copy(controls.target).add(off.setLength(len));
        s.zoomed = true;
      }
      const tilt = d.pitch ?? 0;
      if (!d.x && !d.y && !tilt) { if (d.depth) controls.update(); return; }
      // The world follows the fist: hand right turns the scene right (camera goes left), hand
      // up tips its near edge up (camera goes down). At depth 1 the step is already ~radians.
      const off = camera.position.clone().sub(controls.target);
      sph.setFromVector3(off);
      sph.theta -= d.x;
      const lo = Math.max(0.05, controls.minPolarAngle ?? 0), hi = Math.min(Math.PI - 0.05, controls.maxPolarAngle ?? Math.PI);
      sph.phi = THREE.MathUtils.clamp(sph.phi + d.y - tilt, lo, hi);
      camera.position.copy(controls.target).add(off.setFromSpherical(sph));
      camera.lookAt(controls.target);
      controls.update();
    } else if (s.kind === 'scale') {
      if (Math.abs(d.scale - 1) > 1e-9) objectMode.scaleTarget(s.id, d.scale, { group: s.group });
    }
  }

  function closeSession() {
    if (!session) return;
    if (session.kind === 'move' && objectMode.dragging) objectMode.endMove();
    if (session.kind === 'ring') ring()?.spinEnd?.();
    if (session.kind === 'orbit' && session.zoomed) stats.zooms++;
    session = null;
  }

  // Once per display frame (gesture.tick), after the manipulator has stepped.
  function applyGesture(nowMs) {
    const MODE = gestureLib.MODE;
    const d = takeProxyStep();
    const mode = busy() || runtime?.calibration?.active ? MODE.IDLE : manip.mode;
    // Clap (manipulator resetCount): the Platform's reset is the view, not an edit.
    if (manip.resetCount !== lastResets) {
      lastResets = manip.resetCount;
      if (!busy() && !ringOpen()) { stats.claps++; resetView?.(); setStatus('👏 View reset · a fist orbits, push / pull zooms'); }
    }
    if (mode === MODE.EXPLODE && !explodeSaid) { explodeSaid = true; setStatus('👐 Explode isn\'t on the Platform yet · select a part to move it on its own'); }
    if (mode !== MODE.EXPLODE) explodeSaid = false;
    const want = mode === MODE.GRAB ? 'grab' : mode === MODE.TRANSFORM ? 'scale' : null;
    if (session && session.gesture !== want) {
      // The gesture ended (or changed): let the spring land, then commit the one edit.
      session.endAt ??= nowMs;
      feed(session, d);
      session.still = isStill(d) ? (session.still ?? 0) + 1 : 0;
      if (want || session.still >= 2 || nowMs - session.endAt > SETTLE_MAX_MS || busy()) closeSession();
      if (session) return;
      if (want) session = openSession(want, nowMs);   // this frame's step belonged to the old one
      return;
    }
    if (!session && want) { session = openSession(want, nowMs); return; }   // first frame: references only
    if (session) feed(session, d);
  }

  let lastResets = 0, explodeSaid = false;
  // What the runtime calls "the manipulator" (handsRuntime.js: update on camera frames, tick
  // every display frame). busy(): hands are not read at all.
  const gesture = {
    update(hands, aspect, t) {
      if (!manip) return 'idle';
      if (busy()) return manip.mode;
      syncVcam();
      if (hands.some((h) => h.engaged !== false && h.pointer?.gun)) lastPointerAt = t;
      return manip.update(hands, aspect, t);
    },
    tick(t = performance.now()) {
      if (!manip) return;
      manip.tick(t);
      applyGesture(t);
    },
    get mode() { return manip?.mode ?? 'idle'; }
  };

  function onAction(type, detail) {
    if (type === 'aim') handleAim(detail);
    else if (type === 'click') handleClick(detail);
    else if (type === 'ui-type') setStatus('⌨ Type (optional) · or pinch elsewhere to carry on');
    else if (type === 'reset') setStatus(`↻ Tracking reset · ${detail.why} · raise a hand to carry on`);
    else if (type === 'hint') { if (detail) setStatus(HINT_TEXT[detail.key] ?? detail.text ?? ''); }
    else if (type === 'calibrated') {
      if (expose) expose.pointerProfile = detail;
      setStatus(detail?.skipped ? 'Pointer calibration skipped · press C any time' : '✓ Pointer calibrated · point at an item and pinch your other hand (or hold still) to select');
    } else if (type === 'starting') setStatus(detail.phase === 'model' ? 'Loading hand tracking…' : 'Asking for the camera…');
  }

  async function ensureRuntime() {
    if (runtime) return runtime;
    bvhLoad ??= import('three-mesh-bvh').then((m) => { MeshBVH = m.MeshBVH; }).catch((err) => console.warn('hands: three-mesh-bvh unavailable, raycasting plain', err));
    loading ??= Promise.all([loadRuntime(), ensureGesture()]).then(([createHandsRuntime]) => {
      runtime = createHandsRuntime({
        scene, camera, renderer, overlay, video,
        pickTargets: () => (hasTargets() ? pickRoot : null),
        ghostAnchor: () => pickRoot,
        manipulator: () => gesture,
        // A steady cursor on any drawn surface selects what is there (hold-to-select); off while
        // the lens or the ring owns the input.
        holdOn: () => (busy() || ringOpen() || lens() ? null : 'surface'),
        handUI: true,
        cursorSpace: 'page',
        toolWheel,
        onAction
      });
      lastResets = manip?.resetCount ?? 0;
      if (expose) {
        expose.handsRuntime = runtime;
        expose.pointerStats = runtime.stats;
        expose.pointerProfile = runtime.profile;
        expose.calibration = runtime.calibration;
      }
      return runtime;
    });
    try { return await loading; } catch (err) { loading = null; throw err; }
  }

  function syncButton() {
    if (!button) return;
    const on = !!runtime?.tracking;
    // Icon only, same width on and off: the top bar is already full at 1400 px (measured), and
    // a label that changes width would shift every button after it. State = .active + pressed.
    button.textContent = '📷';
    button.setAttribute('aria-label', on ? 'Camera on: turn it off' : 'Camera off: turn it on');
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Turn the camera off' : 'Camera on / off: point at items with your hand (C calibrates)';
  }

  async function start() {
    if (runtime?.tracking) return true;
    if (button) button.disabled = true;
    try {
      const rt = await ensureRuntime();
      await rt.start();
      button?.classList.remove('hand-pulse');
      syncButton();
      if (rt.profile) setStatus('Camera on · raise a hand, point at an item, pinch your other hand (or hold still) to select');
      else { setStatus('Camera on · first, a 45 s pointer calibration (Esc skips)'); rt.calibrate(); }
      return true;
    } catch (err) {
      const { describeCameraError } = await import('../camera.js' + V);
      setStatus(`The camera didn't start: ${describeCameraError(err)}`, true);
      console.warn('hands: camera did not start', err);
      return false;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function stop() {
    if (!runtime?.tracking) return;
    runtime.stop();
    setHover(null);
    closeSession();
    clearFrames = 30;   // ~0.5 s of frames so the reticle and ghost hands fade instead of freezing
    syncButton();
    setStatus('Camera off');
  }

  const toggle = () => (runtime?.tracking ? (stop(), Promise.resolve(false)) : start());

  function calibrate() {
    if (!runtime) return 'not-tracking';
    const r = runtime.calibrate();
    if (r === 'not-tracking') setStatus('Start the camera first, then press C');
    else if (r === 'busy') setStatus('Finish the calibration first (Esc skips it)');
    return r;
  }

  function update(nowMs = performance.now()) {
    if (!runtime) return;
    if (!runtime.tracking) {
      if (clearFrames <= 0) return;
      clearFrames--;
    }
    pickRoot.position.copy(controls.target);
    pickRoot.updateMatrixWorld();
    runtime.update(nowMs);
    updateLensPress();
  }

  // Spec section 3: remember the camera (checkbox in Help, default on) and start it on load.
  let uiLib = null;
  const loadUiLib = () => (uiLib ??= import('../handUI.js' + V));
  if (helpEl) loadUiLib().then((m) => m.mountRememberToggle(helpEl)).catch((err) => console.warn('hands: no remember toggle', err));
  async function autoStart() {
    const m = await loadUiLib();
    return m.autoStartCamera({ start, button, setStatus });
  }

  // C calibrates, Esc skips a running calibration. Capture phase, so Esc during calibration
  // does not also clear the object selection (objectmode.js) or leave the polygon lens.
  function onKey(e) {
    if (!runtime || e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input, textarea, select')) return;
    if (e.key === 'Escape' && runtime.calibration.active) {
      e.preventDefault();
      e.stopImmediatePropagation();
      runtime.calibration.cancel();
    } else if ((e.key === 'c' || e.key === 'C') && !e.repeat && runtime.tracking) calibrate();
  }
  window.addEventListener('keydown', onKey, true);

  button?.addEventListener('click', () => { toggle(); });
  syncButton();

  return {
    update, start, stop, toggle, calibrate, handleAim, handleClick, pickRoot, autoStart,
    get lensPress() { return lensPress && { ...lensPress }; },
    ensureRuntime, ensureGesture, gesture,
    get session() { return session && { kind: session.kind, id: session.id }; },
    get runtime() { return runtime; },
    get tracking() { return !!runtime?.tracking; },
    get hoverKey() { return hoverKey; },
    get stats() { return stats; },
    dispose() {
      window.removeEventListener('keydown', onKey, true);
      runtime?.dispose();
      mount.remove();
    }
  };
}

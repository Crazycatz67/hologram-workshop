// Hands on the Platform (plans/platform/P1-hands-design.md, step 2): the Platform adapter for
// the shared hands runtime (../handsRuntime.js). The runtime does the camera, tracking, pointer,
// reticle, ghost hands, calibration and the lower-both-hands reset; this file only says what a
// hand means HERE: aim = objectMode hover, click = objectMode select. Every change still goes
// through objectmode.js, so undo, autosave and versions see hand edits exactly like mouse ones.
// No grab / move / rotate / scale yet (step 3).
//
// CONTRACT
//   createPlatformHands({ scene, camera, renderer, controls, objectMode, getItems, button?,
//                         setStatus?, busy?, expose?, loadRuntime? }) -> hands
//     getItems(): the ready library items ({ root, parts: [{ id, mesh }] }), read every frame.
//     button: the top-bar Camera toggle (label, aria-pressed and .active are kept in sync).
//     setStatus(msg, isError): the page's status line.
//     busy(): true while hand clicks must not select (polygon lens up, Library ring open).
//     expose: an object (window.hologram) that gets handsRuntime / pointerStats / pointerProfile /
//       calibration once the runtime exists, under the same names hologram.html uses, so
//       sessionrec.js and tests read both pages the same way.
//     loadRuntime(): Promise<createHandsRuntime>; injectable for tests. The default imports
//       ../handsRuntime.js on the FIRST Camera press: it pulls MediaPipe from the CDN, and the
//       Platform must open (and work offline) without it.
//   hands.update(nowMs)   call once per display frame from the Platform's render loop (main.js
//     onTick); never starts its own rAF. Cheap no-op until the camera has been started.
//   hands.start() -> Promise<boolean>  / hands.stop() / hands.toggle()
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
  loadRuntime = () => import('../handsRuntime.js' + V).then((m) => m.createHandsRuntime)
}) {
  let runtime = null;
  let loading = null;
  let clearFrames = 0;      // display frames still to run after stop, so the reticle eases out
  let hoverKey = null;      // what the HAND set as objectMode's hover (never the mouse's)
  const stats = { clicks: 0, selects: 0, misses: 0, ignored: 0, bvhBuilt: 0, bvhMs: 0 };

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

  function handleAim({ state, hit } = {}) {
    const handAim = state && state.source === 'hand' && state.mode !== 'off' && !busy() && !runtime?.calibration?.active;
    if (!handAim) { setHover(null); return; }
    const obj = hit?.hit?.object ?? null;
    setHover(obj ? keyFor({ partId: obj.userData.partId ?? null, itemId: obj.userData.itemId ?? null }) : null);
  }

  function handleClick(click) {
    if (!click || click.source !== 'hand') return null;
    if (busy()) { stats.ignored++; return null; }
    stats.clicks++;
    runtime?.pulse();
    const h = hitAt(click.x, click.y);
    let key = keyFor(h);
    // Mouse parity (objectmode pointerdown): with a whole item selected, clicking one of its
    // parts keeps the whole item (it is what a grab will move in step 3).
    const sel = objectMode.selectedId;
    if (key && !isItemKey(key) && isItemKey(sel) && String(h.itemId) === sel.slice(5)) key = sel;
    if (key) stats.selects++; else stats.misses++;
    objectMode.select(key);
    return key;
  }

  function onAction(type, detail) {
    if (type === 'aim') handleAim(detail);
    else if (type === 'click') handleClick(detail);
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
    loading ??= loadRuntime().then((createHandsRuntime) => {
      runtime = createHandsRuntime({
        scene, camera, renderer, overlay, video,
        pickTargets: () => (hasTargets() ? pickRoot : null),
        ghostAnchor: () => pickRoot,
        // A steady cursor on any drawn surface selects what is there (hold-to-select); off while
        // the lens or the ring owns the input.
        holdOn: () => (busy() ? null : 'surface'),
        onAction
      });
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
    update, start, stop, toggle, calibrate, handleAim, handleClick, pickRoot,
    ensureRuntime,
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

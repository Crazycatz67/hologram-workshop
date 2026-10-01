// Playground framework: one shared game page (demos/play.html?game=<id>) that hosts small
// hologram games as modules, so every game gets the same hands runtime, mouse fallbacks,
// timer, best score, "how to play" card and win banner instead of re-plumbing them.
// Design: docs/team-log/reports/2026-10-01-ricky-playground-ideas.md (Architecture).
//
// CONTRACT (for game authors; demos/<id>/demo.js default-exports one game object)
//   game = { id, title, thumb, tutorial, load(ctx), onGesture(evt), tick(dt), reset(),
//            isWon(), dispose(), winText?(timeText), debug?(), bestKey?(), againText?() }
//     bestKey?(): a suffix for the best-time slot (e.g. 'level2'); omitted = one best per game.
//     againText?(): the banner button label (e.g. '→ Level 2'); omitted = '↻ Play again'.
//     tutorial: up to 3 lines [{ icon, text, keys? }], verb first ("Pinch-drag to paint").
//       (Ricky's sketch had clip names here; the gesture clips aren't recorded yet.)
//     load(ctx) may be async; the timer starts at the first non-aim gesture after it.
//     tick(dt): dt in SECONDS, every display frame, clamped to 0.1.
//     isWon(): polled every frame; the first true stops the timer, saves the best time and
//       shows the banner. reset() must make it false again (the banner's Play again calls it).
//   ctx = { THREE, scene, camera, renderer, controls, canvas, root (Group, cleared on
//           dispose), panel (DOM strip for game buttons), runtime (handsRuntime), loadGLB(url),
//           ndcToPlane(ndc, point, normal?) -> Vector3 | null, raycast(ndc, objects) -> hits,
//           toScreen(vec3) -> { x, y } canvas px, setStatus(text), sfx(name), frameView(box),
//           restart() = the banner's Play again: game.reset() + timer back to 0 }
//   evt (all carry type, source: 'hand' | 'mouse' | 'key' | 'synthetic'; ndc = canvas NDC, y up):
//     aim     { ndc }                          cursor moved (hand pointer or mouse)
//     click   { ndc, via }                     other-hand pinch / mouse click (<= 5 px)
//     drag    { phase: 'start'|'move'|'end', ndc }   pinch-hold + move / mouse left-drag
//     grab    { phase: 'start'|'move', ndc?, dPos: Vector3 (world), dQuat: Quaternion (world) }
//               fist move + twist / Shift+left-drag; mouse wheel and Q/E send a 'move' with a
//               15 deg yaw dQuat (twist fallback) and no start
//     release { }                              fist opened / Shift-drag ended
//     (the hybrid tilt, a fist plus a second hand, arrives as the dQuat of 'grab' moves)
//     tilt    { dQuat }                        two-hand transform turn / arrow keys (up/down
//               15 deg about world X, left/right 15 deg about world Z; source 'key')
//     scale   { factor }                       two-hand pinch / + and - keys
//     explode { amount }                       open hands spreading (stretch delta) / X key
//     clap    { }                              clap / C key
//     undo    { }                              thumbs-down held 650 ms / U or Ctrl+Z
//     wheel   { }                              victory held 650 ms / W key (no wheel UI yet)
//   Hand gestures come from the shared modules without changing them: the runtime's own
//   manipulator path drives a hidden "probe" Object3D, and its per-frame motion is read back
//   as grab/tilt/scale/explode deltas (same deadzones and springs as hologram.html), its
//   resetCount as clap; undo/wheel go through holdGate.js.
//   Test hook: window.playground = { ready, game, runtime, emit(evt), counts, won, lastTimeMs,
//     best(), frames }. emit() routes a synthetic event exactly like a real one.
//   Photosafety (BUGS #14): the banner fades in over 700 ms with a fixed glow; games must
//   ease every brightness change (glowPulse below) and never cycle colours.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const V = new URL(import.meta.url).search;
const { createScene, startRenderLoop } = await import('../scene.js' + V);
const { createHandsRuntime } = await import('../handsRuntime.js' + V);
const { createManipulator, MODE } = await import('../manipulator.js' + V);
const { createHoldGate } = await import('../holdGate.js' + V);
const { palmLength } = await import('../gestures.js' + V);
const { describeCameraError } = await import('../camera.js' + V);
const { autoStartCamera } = await import('../handUI.js' + V);

// The hub reads this list; a card with ready:false shows "coming soon".
export const GAMES = [
  { id: 'paint', title: 'Light painting', thumb: '🖌️', blurb: 'Draw glowing light in the air. Light every spark in its colour.', verbs: ['☝', '🤏', '👎', '👏'], secs: 60, ready: true },
  { id: 'chair', title: 'Rebuild the chair', thumb: '🪑', blurb: 'Eight scrambled parts. Move and twist each one until it snaps home.', verbs: ['🤏', '✊', '🔄'], secs: 90, ready: true },
  { id: 'tower', title: 'Block tower', thumb: '🧱', blurb: 'Pull three blocks out with a fist and stack them on top. Don\'t let it fall.', verbs: ['✊', '🖐', '👏'], secs: 60, ready: true },
  { id: 'maze', title: 'Marble maze', thumb: '🔮', blurb: 'Tilt the board to roll the marble home. Three short levels; mind the holes.', verbs: ['✊', '✋', '👏'], secs: 90, ready: true }
];

const BEST_KEY = (id) => `playground.best.${id}`;
export function readBest(id, storage = globalThis.localStorage) {
  try { const v = Number(storage?.getItem(BEST_KEY(id))); return v > 0 ? v : null; } catch { return null; }
}
function saveBest(id, ms, storage = globalThis.localStorage) {
  const old = readBest(id, storage);
  if (old !== null && old <= ms) return false;
  try { storage?.setItem(BEST_KEY(id), String(Math.round(ms))); } catch { /* private mode: no best */ }
  return true;
}
export function formatTime(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

// One smooth brightness pulse for "it worked" moments: 0 -> 1 -> 0 over durMs with a
// smoothstep rise (first 30%) and a long smoothstep fall. One rise + one fall is one flash
// at most, and the slopes stay far from the 3-per-second limit.
export function glowPulse(tMs, durMs = 900) {
  if (!(tMs >= 0) || tMs >= durMs) return 0;
  const u = tMs / durMs;
  const ss = (x) => x * x * (3 - 2 * x);
  return u < 0.3 ? ss(u / 0.3) : ss(1 - (u - 0.3) / 0.7);
}
// Exponential ease toward a target with a time constant, frame-rate independent.
export function easeTo(current, target, dt, tauS = 0.15) {
  return target + (current - target) * Math.exp(-dt / tauS);
}

const YAW_STEP = THREE.MathUtils.degToRad(15);

export async function startPlayground({ gameId, el }) {
  const meta = GAMES.find((g) => g.id === gameId && g.ready);
  // Best-time slot: one per game, or one per game.bestKey() (e.g. per maze level).
  const bestId = () => { const k = pg.game?.bestKey?.(); return k ? `${gameId}.${k}` : gameId; };
  const pg = {
    ready: false, game: null, counts: {}, won: false, lastTimeMs: null, frames: 0, error: null,
    best: () => readBest(bestId()), emit: (evt) => route({ source: 'synthetic', ...evt })
  };
  window.playground = pg;
  if (!meta) {
    el.status.textContent = `No game called "${gameId}". Back to the arcade.`;
    pg.error = 'unknown game';
    return pg;
  }
  document.title = `${meta.title} · Hologram playground`;
  el.title.textContent = `${meta.thumb} ${meta.title}`;

  const { scene, camera, renderer, controls } = createScene(el.stage);
  // Left mouse belongs to the games (drag / click); right-drag orbits; the wheel is the twist
  // fallback, so no dolly.
  controls.mouseButtons = { LEFT: null, MIDDLE: null, RIGHT: THREE.MOUSE.ROTATE };
  controls.enableZoom = false;
  controls.enablePan = false;
  const canvas = renderer.domElement;
  const root = new THREE.Group();
  scene.add(root);
  const homeView = { pos: camera.position.clone(), target: controls.target.clone() };

  // ---- the probe the manipulator moves (see CONTRACT) -------------------------------------
  const probe = new THREE.Object3D();
  scene.add(probe);
  let manip = createManipulator(probe, camera);
  manip.configure({ momentum: false });   // a released part must stop where the hand let go
  let lastResets = manip.resetCount;
  let handMode = MODE.IDLE;
  const holdGate = createHoldGate({ tiers: { undo: 'ring', toolWheel: 'ring' } });

  const runtime = createHandsRuntime({
    scene, camera, renderer, overlay: el.overlay, video: el.video,
    pickTargets: () => root, manipulator: () => manip,
    holdOn: () => null, handUI: true, cursorSpace: 'page',
    onAction: (type, d) => {
      if (type === 'click') {
        if (Math.abs(d.x) <= 1 && Math.abs(d.y) <= 1) route({ type: 'click', source: d.source, via: d.via, ndc: { x: d.x, y: d.y } });
      } else if (type === 'frame') onHandFrame(d);
      else if (type === 'starting') setStatus(d.phase === 'model' ? 'Loading hand tracking…' : 'Asking for the camera…');
    }
  });

  pg.runtime = runtime;

  function onHandFrame({ mode, hands, now }) {
    const prev = handMode;
    handMode = mode;
    if (manip.resetCount !== lastResets) { lastResets = manip.resetCount; route({ type: 'clap', source: 'hand' }); }
    if (mode === MODE.GRAB && prev !== MODE.GRAB) route({ type: 'grab', phase: 'start', source: 'hand', ndc: aimNdc, dPos: new THREE.Vector3(), dQuat: new THREE.Quaternion() });
    if (prev === MODE.GRAB && mode !== MODE.GRAB) route({ type: 'release', source: 'hand' });
    // Command poses through the hold gate: a raised hand showing 👎 or ✌.
    const h = hands.find((x) => x.engaged !== false && (x.gesture === 'Thumb_Down' || x.gesture === 'Victory')) ?? hands.find((x) => x.engaged !== false);
    const pose = h?.gesture === 'Thumb_Down' ? 'undo' : h?.gesture === 'Victory' ? 'toolWheel' : h ? 'other' : null;
    const s = holdGate.update({
      pose, confidence: h?.score ?? 0, wristPos: h ? { x: h.landmarks[0].x, y: h.landmarks[0].y } : null,
      spanPx: h ? palmLength(h.landmarks, 16 / 9) : 1, timestampMs: now
    });
    if (s.fired === 'undo') route({ type: 'undo', source: 'hand' });
    if (s.fired === 'toolWheel') route({ type: 'wheel', source: 'hand' });
  }

  // Display-rate: read what the manipulator did to the probe this frame, then put it back.
  function readProbe() {
    const dPos = probe.position.clone();
    const dQuat = probe.quaternion.clone();
    const f = probe.scale.x;
    const fy = probe.scale.y;
    probe.position.set(0, 0, 0);
    probe.quaternion.identity();
    probe.scale.set(1, 1, 1);
    const moved = dPos.lengthSq() > 1e-12;
    const turned = 1 - Math.abs(dQuat.w) > 1e-9;
    if (handMode === MODE.GRAB && (moved || turned)) route({ type: 'grab', phase: 'move', source: 'hand', dPos, dQuat });
    else if (handMode === MODE.TRANSFORM) {
      if (turned) route({ type: 'tilt', source: 'hand', dQuat });
      if (Math.abs(f - 1) > 1e-6) route({ type: 'scale', source: 'hand', factor: f });
    } else if (handMode === MODE.EXPLODE && Math.abs(fy - 1) > 1e-6) route({ type: 'explode', source: 'hand', amount: Math.log(fy) });
  }

  // ---- hand drag (pinch-hold with the other hand) and aim ---------------------------------
  let aimNdc = { x: 0, y: 0 };
  let handDrag = false;
  function pageToNdc(px) {
    const r = canvas.getBoundingClientRect();
    return { x: ((px.x - r.left) / r.width) * 2 - 1, y: 1 - ((px.y - r.top) / r.height) * 2 };
  }
  let lastAimKey = '';
  function handPointerFrame() {
    const st = runtime.pointer?.state;
    const px = runtime.cursorPx;
    const handAim = st?.source === 'hand' && st.mode !== 'off' && px && !runtime.overUi;
    if (handAim) {
      const ndc = pageToNdc(px);
      const key = `${ndc.x.toFixed(4)},${ndc.y.toFixed(4)}`;
      if (key !== lastAimKey) { lastAimKey = key; aimNdc = ndc; route({ type: 'aim', source: 'hand', ndc }); }
    }
    const want = !!(handAim && runtime.pinchHeld);
    if (want && !handDrag) { handDrag = true; route({ type: 'drag', phase: 'start', source: 'hand', ndc: aimNdc }); } else if (want) route({ type: 'drag', phase: 'move', source: 'hand', ndc: aimNdc });
    else if (handDrag) { handDrag = false; route({ type: 'drag', phase: 'end', source: 'hand', ndc: aimNdc }); }
  }

  // ---- mouse fallbacks --------------------------------------------------------------------
  const ndcOf = (e) => pageToNdc({ x: e.clientX, y: e.clientY });
  let mouse = null;   // { x, y, dragging, shift, last }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    mouse = { x: e.clientX, y: e.clientY, dragging: false, shift: e.shiftKey, last: ndcOf(e) };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && !mouse) return;
    const ndc = ndcOf(e);
    aimNdc = ndc;
    route({ type: 'aim', source: 'mouse', ndc });
    if (!mouse) return;
    if (!mouse.dragging && Math.hypot(e.clientX - mouse.x, e.clientY - mouse.y) > 5) {
      mouse.dragging = true;
      if (mouse.shift) route({ type: 'grab', phase: 'start', source: 'mouse', ndc: mouse.last, dPos: new THREE.Vector3(), dQuat: new THREE.Quaternion() });
      else route({ type: 'drag', phase: 'start', source: 'mouse', ndc: mouse.last });
    }
    if (mouse.dragging) {
      if (mouse.shift) {
        // Shift-drag = fist move: world motion in the camera-facing plane through the origin.
        const a = ndcToPlane(mouse.last, new THREE.Vector3());
        const b = ndcToPlane(ndc, new THREE.Vector3());
        if (a && b) route({ type: 'grab', phase: 'move', source: 'mouse', ndc, dPos: b.sub(a), dQuat: new THREE.Quaternion() });
      } else route({ type: 'drag', phase: 'move', source: 'mouse', ndc });
    }
    mouse.last = ndc;
  });
  const endMouse = (e) => {
    if (!mouse) return;
    if (mouse.dragging) {
      if (mouse.shift) route({ type: 'release', source: 'mouse' });
      else route({ type: 'drag', phase: 'end', source: 'mouse', ndc: e ? ndcOf(e) : mouse.last });
    }
    mouse = null;
  };
  canvas.addEventListener('pointerup', endMouse);
  canvas.addEventListener('pointercancel', () => endMouse(null));
  // Mouse wheel = twist (one notch = 15 deg of yaw), throttled so a trackpad's burst of tiny
  // wheel events doesn't spin a part round and round.
  let wheelAcc = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    wheelAcc += e.deltaY;
    if (Math.abs(wheelAcc) < 60) return;
    twist(Math.sign(wheelAcc), 'mouse');
    wheelAcc = 0;
  }, { passive: false });
  function twist(sign, source) {
    route({ type: 'grab', phase: 'move', source, ndc: aimNdc, dPos: new THREE.Vector3(), dQuat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sign * YAW_STEP) });
  }
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea')) return;
    const k = e.key.toLowerCase();
    if ((k === 'z' && (e.ctrlKey || e.metaKey)) || k === 'u') route({ type: 'undo', source: 'key' });
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (k === 'c') route({ type: 'clap', source: 'key' });
    else if (k === 'q') twist(1, 'key');
    else if (k === 'e') twist(-1, 'key');
    else if (k === 'w') route({ type: 'wheel', source: 'key' });
    else if (k === 'x') route({ type: 'explode', source: 'key', amount: 0.25 });
    else if (k === '+' || k === '=') route({ type: 'scale', source: 'key', factor: 1.1 });
    else if (k === '-') route({ type: 'scale', source: 'key', factor: 1 / 1.1 });
    else if (k === 'arrowup' || k === 'arrowdown') route({ type: 'tilt', source: 'key', dQuat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (k === 'arrowup' ? -1 : 1) * YAW_STEP) });
    else if (k === 'arrowleft' || k === 'arrowright') route({ type: 'tilt', source: 'key', dQuat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (k === 'arrowleft' ? 1 : -1) * YAW_STEP) });
    else if (k === 'r') playAgain();
    else if (k === 'h' || k === '?') toggleHowto();
    else if (k === 'escape') hideBanner();
    else return;
    e.preventDefault();
  });

  // ---- helpers handed to the game ---------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  function ndcToPlane(ndc, point, normal = null) {
    raycaster.setFromCamera(ndc, camera);
    const n = normal ?? camera.getWorldDirection(new THREE.Vector3()).negate();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, point);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }
  function raycast(ndc, objects) {
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(objects, true);
  }
  function toScreen(v) {
    const p = v.clone().project(camera);
    const r = canvas.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * r.width, y: ((1 - p.y) / 2) * r.height };
  }
  const gltf = new GLTFLoader();
  const loadGLB = (url) => new Promise((res, rej) => gltf.load(url, (g) => res(g.scene), undefined, rej));
  // Fits a box in view (same framing rule as loadModel.frameObject) and makes it the clap home.
  function frameView(box, margin = 1.6) {
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    // Fit the height AND the width (a narrow window would otherwise crop the sides).
    const fitDist = Math.max(maxDim / 2 / tanV, size.x / 2 / (tanV * camera.aspect)) * margin;
    camera.position.set(c.x, c.y + maxDim * 0.15, c.z + fitDist);
    camera.near = fitDist / 100;
    camera.far = fitDist * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(c);
    controls.update();
    homeView.pos.copy(camera.position);
    homeView.target.copy(c);
  }
  // Tiny WebAudio cues (free, local, quiet). Created on first use so autoplay rules are met.
  let audio = null;
  function sfx(name) {
    try {
      audio ??= new AudioContext();
      const f = { snap: 660, win: 880, stroke: 520, undo: 330, spark: 990 }[name] ?? 440;
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.05, audio.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + 0.4);
    } catch { /* no audio: silent game */ }
  }
  function setStatus(text) { el.status.textContent = text; }

  const ctx = { THREE, scene, camera, renderer, controls, canvas, root, panel: el.panel, runtime, loadGLB, ndcToPlane, raycast, toScreen, setStatus, sfx, frameView, restart: () => playAgain() };

  // ---- timer, best, banner, how-to --------------------------------------------------------
  let startedAt = null;
  let wonAt = null;
  function showBest() {
    const b = readBest(bestId());
    el.best.textContent = b ? `best ${formatTime(b)}` : 'best –';
  }
  showBest();
  function showBanner(ms, isBest) {
    const extra = isBest ? 'New best!' : `best ${formatTime(readBest(bestId()))}`;
    el.again.textContent = pg.game.againText?.() ?? '↻ Play again';
    el.bannerText.textContent = pg.game.winText?.(formatTime(ms)) ?? `You won in ${formatTime(ms)}`;
    el.bannerSub.textContent = extra;
    el.banner.hidden = false;
    requestAnimationFrame(() => el.banner.classList.add('show'));
  }
  function hideBanner() {
    el.banner.classList.remove('show');
    setTimeout(() => { if (!el.banner.classList.contains('show')) el.banner.hidden = true; }, 750);
  }
  function playAgain() {
    hideBanner();
    pg.game?.reset();
    startedAt = null;
    wonAt = null;
    pg.won = false;
    el.timer.textContent = formatTime(0);
    showBest();   // the game may have switched best slot (bestKey)
  }
  el.again.addEventListener('click', playAgain);
  function toggleHowto(force) {
    el.howto.hidden = force === undefined ? !el.howto.hidden : !force;
  }
  el.howtoBtn.addEventListener('click', () => toggleHowto());
  el.howtoClose.addEventListener('click', () => toggleHowto(false));

  // ---- routing ----------------------------------------------------------------------------
  function route(evt) {
    if (!pg.ready || !pg.game) return;
    pg.counts[evt.type] = (pg.counts[evt.type] ?? 0) + 1;
    if (evt.type === 'clap') {
      // Clap always also puts the view back (games may do more: clear, reset parts).
      camera.position.copy(homeView.pos);
      controls.target.copy(homeView.target);
      controls.update();
    }
    if (evt.type !== 'aim' && startedAt === null && !pg.won) {
      startedAt = performance.now();
      toggleHowto(false);   // out of the way once play starts; ? or H brings it back
    }
    try { pg.game.onGesture(evt); } catch (err) { console.error('game.onGesture threw:', err); }
  }

  // ---- load the game ----------------------------------------------------------------------
  setStatus(`Loading ${meta.title}…`);
  const mod = await import(`./${gameId}/demo.js${V}`);
  const game = mod.default;
  pg.game = game;
  el.howtoList.replaceChildren(...(game.tutorial ?? []).slice(0, 3).map((t) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ic"></span><span class="tx"></span><kbd></kbd>`;
    li.querySelector('.ic').textContent = t.icon;
    li.querySelector('.tx').textContent = t.text;
    li.querySelector('kbd').textContent = t.keys ?? '';
    return li;
  }));
  await game.load(ctx);
  pg.ready = true;
  setStatus('Ready · mouse works now; 📷 adds your hands');

  let lastT = null;
  startRenderLoop({
    renderer, scene, camera, controls,
    onTick: (now) => {
      pg.frames++;
      const dt = lastT === null ? 0 : Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      runtime.update(now);
      readProbe();
      handPointerFrame();
      game.tick(dt);
      if (!pg.won && game.isWon()) {
        pg.won = true;
        wonAt = now;
        const ms = startedAt === null ? 0 : wonAt - startedAt;
        pg.lastTimeMs = ms;
        const isBest = saveBest(bestId(), ms);
        showBest();
        showBanner(ms, isBest);
        sfx('win');
      }
      el.timer.textContent = formatTime(startedAt === null ? 0 : (pg.won ? wonAt : now) - startedAt);
    }
  });

  // ---- camera button ----------------------------------------------------------------------
  async function startCam() {
    try {
      await runtime.start();
      el.camBtn.textContent = '📷 On';
      setStatus('Hands on · raise a hand above the line');
    } catch (err) {
      setStatus(`📷 ${describeCameraError(err)} · mouse still works`);
    }
  }
  el.camBtn.addEventListener('click', () => {
    if (runtime.tracking) { runtime.stop(); el.camBtn.textContent = '📷 Camera'; setStatus('Camera off · mouse still works'); } else startCam();
  });
  autoStartCamera({ start: startCam, button: el.camBtn, setStatus }).catch(() => {});

  window.addEventListener('pagehide', () => { try { game.dispose(); runtime.dispose(); } catch { /* page is going */ } });
  return pg;
}

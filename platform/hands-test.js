// Platform hands adapter checks (platform/hands.js, P1 step 2).
//
//   A. Lazy load: creating the adapter loads nothing; update() before the first start is a no-op;
//      the runtime is created once and exposed under hologram.html's names.
//   B. Pick root: the reticle's proxy hits the right part, and skips hidden parts, hidden items
//      and material-hidden (inferred "As scanned") surfaces; no items = no pick target.
//   C. Click -> objectMode select, through the REAL runtime (injectClick): every hand `via`;
//      part in object mode, whole item in scene mode; miss clears; mouse ignored; busy ignored;
//      a part of the selected whole item keeps the whole item (mouse parity).
//   D. Aim -> objectMode hover: hand only, cleared when the hand leaves, never clears a hover
//      the mouse set; hold-to-select targets surfaces and is off while busy.
//   E. Runtime events -> status line (reset, hint, calibrated).
//   F. (?camera=1) Camera on: tracking, button state, overlay sized, frames driven by the host
//      loop only (no requestAnimationFrame from hands code), first-use calibration starts and
//      Esc skips it without clearing the selection; camera off. The saved pointer profile is
//      restored afterwards.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const V = new URL(import.meta.url).search;
const { createObjectMode } = await import('./objectmode.js' + V);
const { createPlatformHands } = await import('./hands.js' + V);

const out = document.getElementById('out');
out.textContent = '';
const log = (s) => { out.textContent += s + '\n'; };
const results = [], metrics = {};
const consoleErrors = [];
window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));
const origError = console.error;
// MediaPipe's WASM prints its own INFO lines through console.error (also on hologram.html); not errors.
const MEDIAPIPE_INFO = /^INFO: /;
console.error = (...a) => { const m = a.map(String).join(' '); if (!MEDIAPIPE_INFO.test(m)) consoleErrors.push(m); origError(...a); };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
const params = new URLSearchParams(location.search);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- scene: two items, two parts each, in a real objectMode -------------------------------------
const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(480, 360);
view.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 480 / 360, 0.01, 100);
camera.position.set(0, 1.2, 4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.4, 0);
controls.update();
const mats = { base: new THREE.MeshBasicMaterial({ color: 0x3a8fb0 }), hover: new THREE.MeshBasicMaterial({ color: 0x8fd3ff }), selected: new THREE.MeshBasicMaterial({ color: 0xffb040 }) };
const edits = [];
const objectMode = createObjectMode({ camera, canvas: renderer.domElement, controls, edits, materialFor: (kind) => mats[kind] });

const items = [];
function makeItem(id, x) {
  const root = new THREE.Group();
  root.position.x = x;
  scene.add(root);
  const parts = [0, 1].map((local) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), mats.base);
    mesh.position.y = 0.2 + local * 0.45;
    mesh.userData.itemId = id;
    mesh.userData.partId = `${id}.${local}`;
    root.add(mesh);
    return { id: `${id}.${local}`, local, mesh };
  });
  const item = { id, name: `item ${id}`, status: 'ready', root, parts };
  objectMode.addParts(parts.map(({ id: pid, mesh }) => ({ id: pid, mesh })));
  objectMode.addItem(id, root);
  items.push(item);
  return item;
}
const itemA = makeItem(1, -0.8);
const itemB = makeItem(2, 0.8);
scene.updateMatrixWorld(true);
const ndcOf = (mesh) => {
  const p = mesh.getWorldPosition(new THREE.Vector3()).project(camera);
  return { x: p.x, y: p.y };
};
const render = () => renderer.render(scene, camera);

// ---- A. lazy load ---------------------------------------------------------------------------
let loads = 0, captured = null, rafCalls = 0;
const statuses = [];
const button = document.createElement('button');
let busyFlag = false;
let itemsShown = true;
const hands = createPlatformHands({
  scene, camera, renderer, controls, objectMode,
  getItems: () => (itemsShown ? items : []),
  button, setStatus: (m, err) => statuses.push({ m, err: !!err }), busy: () => busyFlag,
  expose: (window.hologram = {}),
  loadRuntime: () => {
    loads++;
    return import('../handsRuntime.js' + V).then((m) => (opts) => { captured = opts; return m.createHandsRuntime(opts); });
  }
});
check('A1 creating the adapter loads no runtime (MediaPipe stays off the page until Camera is pressed)', loads === 0 && hands.runtime === null, `loads=${loads}`);
let threw = null;
try { for (let i = 0; i < 5; i++) hands.update(performance.now()); } catch (e) { threw = e; }
check('A2 update() before the first start is a silent no-op', !threw && hands.runtime === null, threw ? String(threw) : '');
check('A3 button starts off: aria-pressed false, not .active, label says off', button.getAttribute('aria-pressed') === 'false' && !button.classList.contains('active') && /off/.test(button.getAttribute('aria-label')), button.getAttribute('aria-label'));
const rt = await hands.ensureRuntime();
await hands.ensureRuntime();
check('A4 runtime created once, exposed as handsRuntime / pointerStats / pointerProfile / calibration (hologram.html names)',
  loads === 1 && rt && window.hologram.handsRuntime === rt && window.hologram.pointerStats === rt.stats && window.hologram.calibration === rt.calibration && 'pointerProfile' in window.hologram,
  `loads=${loads}`);
check('A5 runtime runs in the host loop: no ghostAnchor/pickTargets gaps (proxy is the anchor)', captured.ghostAnchor() === hands.pickRoot && captured.pickTargets() === hands.pickRoot);

// ---- B. pick root -----------------------------------------------------------------------------
const probePart = (mesh) => { const n = ndcOf(mesh); return rt.probeAt(n.x, n.y)?.hit?.object ?? null; };
render();
check('B1 the proxy hits the part under the cursor (each of the 4 parts)', [...itemA.parts, ...itemB.parts].every((p) => probePart(p.mesh) === p.mesh));
const t0 = performance.now();
for (let i = 0; i < 50; i++) probePart(itemA.parts[0].mesh);
metrics.probeMsSynthetic = +((performance.now() - t0) / 50).toFixed(3);
itemA.parts[1].mesh.visible = false;
const hidPart = probePart(itemA.parts[1].mesh);
itemA.parts[1].mesh.visible = true;
itemB.root.visible = false;
const hidItem = probePart(itemB.parts[0].mesh);
itemB.root.visible = true;
const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
itemB.parts[1].mesh.material = hiddenMat;
const hidMat = probePart(itemB.parts[1].mesh);
objectMode.refresh();   // repaint restores the base material
check('B2 hidden part, hidden item and material-hidden (inferred off) surfaces are not hit', hidPart !== itemA.parts[1].mesh && hidItem === null && hidMat === null,
  `part=${hidPart?.userData.partId ?? null} item=${hidItem?.userData.partId ?? null} mat=${hidMat?.userData.partId ?? null}`);
itemsShown = false;
check('B3 no items -> no pick target (reticle hidden)', captured.pickTargets() === null && captured.ghostAnchor() === hands.pickRoot);
itemsShown = true;
// The BVH trees build one geometry per macrotask once the runtime exists; the hits must match
// a plain three raycast face for face (indirect BVH: the index is never reordered).
for (const p of [...itemA.parts, ...itemB.parts]) probePart(p.mesh);
for (let i = 0; i < 50 && hands.stats.bvhBuilt < 4; i++) await wait(20);
const plainRc = new THREE.Raycaster();
const same = [...itemA.parts, ...itemB.parts].every((p) => {
  const n = ndcOf(p.mesh);
  plainRc.setFromCamera(new THREE.Vector2(n.x, n.y), camera);
  const a = plainRc.intersectObject(p.mesh, false)[0];
  const b = rt.probeAt(n.x, n.y)?.hit;
  return a && b && b.object === p.mesh && a.faceIndex === b.faceIndex && Math.abs(a.distance - b.distance) < 1e-6;
});
check('B4 BVH-accelerated pick: trees built, hits identical to a plain raycast (object, face, distance)', hands.stats.bvhBuilt >= 4 && same, `built=${hands.stats.bvhBuilt} in ${hands.stats.bvhMs.toFixed(1)} ms`);

// ---- C. click -> select (real runtime routing) ---------------------------------------------
const click = (mesh, via = 'other-pinch', source = 'hand') => {
  const n = mesh ? ndcOf(mesh) : { x: 0.95, y: 0.95 };
  rt.injectClick({ type: 'click', x: n.x, y: n.y, t: performance.now(), source, via });
  return objectMode.selectedId;
};
objectMode.setMode('object');
const vias = ['other-pinch', 'pinch', 'hold'].map((via) => { objectMode.select(null); return click(itemB.parts[1].mesh, via); });
check('C1 object mode: a hand click of every via selects the part under it', vias.every((v) => v === '2.1'), vias.join(','));
check('C2 object mode: a click on empty space clears the selection', click(null) === null);
objectMode.select(null);
check('C3 mouse clicks are left to objectmode.js (adapter ignores them)', click(itemA.parts[0].mesh, 'mouse', 'mouse') === null);
objectMode.select('item:1');
check('C4 with a whole item selected, clicking one of its parts keeps the whole item (mouse parity)', click(itemA.parts[1].mesh) === 'item:1');
check('C5 ... and clicking another item\'s part selects that part', click(itemB.parts[0].mesh) === '2.0');
objectMode.setMode('scene');
check('C6 scene mode: a hand click selects the whole item', click(itemB.parts[0].mesh) === 'item:2' && objectMode.mode === 'scene');
busyFlag = true;
const before = objectMode.selectedId;
const ign = hands.stats.ignored;
check('C7 busy (polygon lens / Library ring up): hand clicks select nothing', click(itemA.parts[0].mesh) === before && hands.stats.ignored === ign + 1);
check('D4 hold-to-select is off while busy, targets surfaces otherwise', captured.holdOn() === null && ((busyFlag = false), captured.holdOn() === 'surface'));
check('C8 edits log untouched by selecting (selection is not an edit)', edits.length === 0, `edits=${edits.length}`);

// ---- D. aim -> hover ----------------------------------------------------------------------
const aim = (mesh, source = 'hand', mode = 'aim') => {
  const n = mesh ? ndcOf(mesh) : { x: 0.95, y: 0.95 };
  hands.handleAim({ state: { mode, source, x: n.x, y: n.y }, hit: mesh ? rt.probeAt(n.x, n.y) : null });
  return objectMode.hoverId;
};
objectMode.setMode('object');
check('D1 object mode: the hand hovers the part under the cursor', aim(itemA.parts[0].mesh) === '1.0' && hands.hoverKey === '1.0');
objectMode.setMode('scene');
check('D2 scene mode: the hand hovers the whole item; hand gone clears it', aim(itemB.parts[1].mesh) === 'item:2' && aim(null, 'hand', 'off') === null);
objectMode.setMode('object');
objectMode.hover('2.0');   // as if the mouse hovered it (objectmode tick)
const mouseKept = aim(itemA.parts[0].mesh, 'mouse');
const handGone = aim(null, 'hand', 'off');
check('D3 mouse-driven cursor and an absent hand never clear the mouse\'s own hover', mouseKept === '2.0' && handGone === '2.0', `${mouseKept},${handGone}`);
objectMode.hover(null);

// ---- E. events -> status --------------------------------------------------------------------
statuses.length = 0;
captured.onAction('reset', { why: 'hands lowered' });
captured.onAction('hint', { key: 'lost', text: 'x' });
captured.onAction('hint', null);
captured.onAction('calibrated', { skipped: true });
check('E1 reset, hint and calibration outcomes reach the status line', statuses.length === 3 && /Tracking reset · hands lowered/.test(statuses[0].m) && /camera view/.test(statuses[1].m) && /skipped/.test(statuses[2].m) && window.hologram.pointerProfile?.skipped === true,
  statuses.map((s) => s.m).join(' | '));
check('E2 calibrate() without the camera says so', hands.calibrate() === 'not-tracking');

// ---- F. camera on (opt-in) -------------------------------------------------------------------
if (params.get('camera') === '1') {
  const KEY = 'hologram.pointerProfile.v1';
  const savedProfile = localStorage.getItem(KEY);
  localStorage.removeItem(KEY);
  const rafOrig = window.requestAnimationFrame;
  window.requestAnimationFrame = (fn) => { rafCalls++; return rafOrig.call(window, fn); };
  try {
    // The runtime read the profile when it was created, so a fresh adapter is needed for "first use".
    hands.dispose();
    let cap2 = null;
    const statuses2 = [];
    const button2 = document.createElement('button');
    const hands2 = createPlatformHands({
      scene, camera, renderer, controls, objectMode, getItems: () => items, button: button2,
      setStatus: (m) => statuses2.push(m), expose: (window.hologram = {}),
      loadRuntime: () => import('../handsRuntime.js' + V).then((m) => (o) => { cap2 = o; return m.createHandsRuntime(o); })
    });
    const t1 = performance.now();
    const ok = await hands2.start();
    metrics.cameraStartMs = Math.round(performance.now() - t1);
    check('F1 camera starts; button pressed + .active', ok && hands2.tracking && button2.classList.contains('active') && button2.getAttribute('aria-pressed') === 'true',
      `${statuses2.join(' | ')}`);
    check('F2 first use (no saved profile): calibration starts', hands2.runtime.calibration.active === true);
    let frames = 0;
    rafCalls = 0;
    const tEnd = performance.now() + 1500;
    while (performance.now() < tEnd) { hands2.update(performance.now()); render(); frames++; await wait(16); }
    const ov = cap2.overlay;
    check('F3 host-driven frames: overlay sized to the video, no requestAnimationFrame from hands code', ov.width > 0 && ov.height > 0 && rafCalls === 0,
      `frames=${frames} overlay=${ov.width}x${ov.height} raf=${rafCalls}`);
    objectMode.setMode('object');
    objectMode.select('1.0');
    const selBefore = objectMode.selectedId;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));   // where a real key press lands
    check('F4 Esc skips the calibration without clearing the selection', !hands2.runtime.calibration.active && objectMode.selectedId === '1.0' && window.hologram.pointerProfile?.skipped === true,
      `before=${selBefore} active=${hands2.runtime.calibration.active} sel=${objectMode.selectedId} skipped=${window.hologram.pointerProfile?.skipped}`);
    hands2.stop();
    for (let i = 0; i < 35; i++) hands2.update(performance.now());
    check('F5 camera off: not tracking, button released, status says so', !hands2.tracking && button2.getAttribute('aria-pressed') === 'false' && !button2.classList.contains('active') && statuses2.at(-1) === 'Camera off');
    hands2.dispose();
  } finally {
    window.requestAnimationFrame = rafOrig;
    if (savedProfile == null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, savedProfile);
  }
} else {
  log('(camera checks skipped: add ?camera=1)');
}

check('0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
window.handsResults = { passed: results.length - failed, failed, results, metrics };

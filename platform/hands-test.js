// Platform hands adapter checks (platform/hands.js, P1 steps 2 and 3).
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
//   G. (step 3) Gestures through objectMode, synthetic hands fed to hands.gesture: a fist moves
//      the selection as ONE undoable move edit, 1:1 with the hand on screen; BUGS #47 (a held
//      same-hand pinch on the aiming hand never grabs) with a control that a real fist does;
//      twist turns inside the same edit; two-hand pinch = one scale edit; nothing selected =
//      orbit; busy = nothing.
//   H. (step 3) Pins: pin/unpin are edits; a pinned target refuses hand and mouse moves (no
//      orbit either) and the API refuses; a part of a pinned item can still be moved alone;
//      K toggles; undo and replay keep pins; mouse moves keep their old log shape.
//   I. Hands on the page (fake ring / lens with the real widgets' surface): ring open = a fist-drag
//      spins it (and back), clicks reach nothing; the lens follows the hand cursor, lets go over
//      the page UI, pinch-hold + up resizes it (x2 per 160 px), a still pinch selects; push-zoom
//      (fist with nothing selected: push away = in, pull = out); clap = resetView, not with the
//      ring open.
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
let fakeRing = null, fakeLens = null, viewResets = 0;
const hands = createPlatformHands({
  scene, camera, renderer, controls, objectMode,
  getItems: () => (itemsShown ? items : []),
  button, setStatus: (m, err) => statuses.push({ m, err: !!err }), busy: () => busyFlag,
  // Section I swaps in a fake ring / lens; null (the default) for everything before it.
  ring: () => fakeRing, polygon: () => fakeLens, resetView: () => { viewResets++; },
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
// Up to 5 s: on a cold browser profile the three-mesh-bvh CDN module can take > 1 s to arrive.
for (let i = 0; i < 250 && hands.stats.bvhBuilt < 4; i++) await wait(20);
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

// ---- G. gestures -> objectMode edits (step 3) -------------------------------------------------
// Synthetic hands (test.js's builder, plus the pointer verdict annotateHand would set) go
// straight into hands.gesture at 30 fps camera frames, with a display tick after each, exactly
// the order handsRuntime.update calls them. No camera, no MediaPipe.
const { handTwist } = await import('../gestures.js' + V);
await hands.ensureGesture();
const G = hands.gesture;
const ASPECT = 16 / 9;
function synthHand(x, y, kind, { twist = 0, palm = 0.12, handedness = 'Right' } = {}) {
  const t = (twist * Math.PI) / 180;
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x, y, z: 0 });
  lm[9] = { x, y: y - palm, z: 0 };
  lm[5] = { x: x + 0.05 * Math.cos(t), y: y - 0.08 + 0.05 * Math.sin(t), z: 0 };
  lm[17] = { x: x - 0.05 * Math.cos(t), y: y - 0.08 - 0.05 * Math.sin(t), z: 0 };
  const fist = kind === 'fist' || kind === 'pinchfist';
  const pinching = kind === 'pinch' || kind === 'pinchfist';
  return {
    gesture: fist ? 'Closed_Fist' : kind === 'open' ? 'Open_Palm' : 'None',
    handedness, landmarks: lm,
    pinch: { pinching, ratio: pinching ? 0.1 : 0.6 },
    pointer: { gun: kind === 'gun', rejectedBy: kind === 'gun' ? null : 'label' },
    fistLike: fist && kind !== 'pinchfist'
  };
}
let gT = 100000;
const modesSeen = new Set();
// frames: (i, n) -> hands[]; ms of camera frames at 30 fps, each followed by a display tick.
function drive(ms, handsAt) {
  const n = Math.max(1, Math.round(ms / 33));
  for (let i = 0; i < n; i++) {
    gT += 33;
    modesSeen.add(G.update(handsAt(i / Math.max(1, n - 1)), ASPECT, gT));
    G.tick(gT + 1);
  }
}
const rest = (ms) => drive(ms, () => []);
const lerp = (a, b, k) => a + (b - a) * k;
const ndcCentre = (obj) => new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3()).project(camera);
const arr = (o) => [...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()];
const sameArr = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const camSnap = () => [...camera.position.toArray(), ...controls.target.toArray()];

objectMode.setMode('scene');
objectMode.select('item:1');
rest(500);
let n0 = edits.length;
const rootA0 = arr(itemA.root);
const ndc0 = ndcCentre(itemA.root);
const y0 = itemA.root.position.y;
drive(300, () => [synthHand(0.5, 0.6, 'fist')]);
const sessionDuring = hands.session;
drive(300, (k) => [synthHand(lerp(0.5, 0.3, k), 0.6, 'fist')]);
drive(300, () => [synthHand(0.3, 0.6, 'fist')]);
drive(700, () => [synthHand(0.3, 0.6, 'open')]);
const mv = edits.slice(n0);
const ndc1 = ndcCentre(itemA.root);
// 1:1 with the hand on screen: the wrist moved 0.2 of the frame (minus the 0.005 deadzone),
// i.e. 0.39 of the NDC width (2 units), mirrored so the item follows the hand you see.
const dNdc = ndc1.x - ndc0.x;
metrics.grabNdcShift = +dNdc.toFixed(3);
check('G1 fist with an item selected: ONE move edit through objectMode, 1:1 with the hand on screen (±15%), height unchanged',
  mv.length === 1 && mv[0].op === 'move' && mv[0].part === null && String(mv[0].item) === '1' && sessionDuring?.kind === 'move'
  && Math.abs(dNdc - 0.39) < 0.06 && Math.abs(itemA.root.position.y - y0) < 1e-9 && hands.session === null && !objectMode.dragging && controls.enabled,
  `edits=${mv.map((e) => e.op).join(',')} session=${sessionDuring?.kind} dNdc=${dNdc.toFixed(3)} dx=${mv[0]?.dx?.toFixed(3)} dz=${mv[0]?.dz?.toFixed(3)}`);
objectMode.undo();
check('G2 Ctrl+Z undoes the hand move exactly', sameArr(arr(itemA.root), rootA0) && edits.length === n0);

// BUGS #47: a same-hand pinch on the AIMING hand (it may read as Closed_Fist) never grabs.
rest(500);
n0 = edits.length;
let grabs0 = hands.stats.grabs;
modesSeen.clear();
drive(400, () => [synthHand(0.5, 0.6, 'gun')]);
drive(1200, (k) => [synthHand(lerp(0.5, 0.35, k), 0.6, 'pinchfist')]);
drive(500, () => [synthHand(0.35, 0.6, 'gun')]);
check('G3 BUGS #47: pointer, then a held same-hand pinch read as a fist (1.2 s, hand moving): no grab, no edit, item still',
  !modesSeen.has('grab') && hands.stats.grabs === grabs0 && edits.length === n0 && sameArr(arr(itemA.root), rootA0),
  `modes=${[...modesSeen].join(',')} grabs=${hands.stats.grabs - grabs0}`);
// ... while a real fist after the pointer (no pinch) still grabs, so G3 is not passing by accident.
modesSeen.clear();
drive(400, () => [synthHand(0.5, 0.6, 'gun')]);
drive(600, () => [synthHand(0.5, 0.6, 'fist')]);
const grabbedAfterPointer = modesSeen.has('grab') && hands.stats.grabs === grabs0 + 1;
drive(700, () => [synthHand(0.5, 0.6, 'open')]);
check('G4 control: pointer -> plain fist (no pinch) does grab (after the post-pointer gap); a still fist makes no edit',
  grabbedAfterPointer && edits.length === n0, `modes=${[...modesSeen].join(',')} edits+${edits.length - n0}`);

// Click = other hand's pinch. If that pinching hand reads as Closed_Fist while the first hand
// aims, it must not drag the selection (the v1 manipulator alone would grab here).
rest(500);
n0 = edits.length;
modesSeen.clear();
drive(300, () => [synthHand(0.3, 0.6, 'gun'), synthHand(0.7, 0.6, 'open', { handedness: 'Left' })]);
drive(900, (k) => [synthHand(0.3, 0.6, 'gun'), synthHand(lerp(0.7, 0.55, k), 0.6, 'pinchfist', { handedness: 'Left' })]);
drive(700, () => [synthHand(0.3, 0.6, 'open'), synthHand(0.55, 0.6, 'open', { handedness: 'Left' })]);
check('G4b aim + other hand\'s pinch read as a fist (0.9 s, moving): the selection never moves, no edit',
  edits.length === n0 && sameArr(arr(itemA.root), rootA0), `manipulator modes=${[...modesSeen].join(',')} edits+${edits.length - n0}`);

// Twist while holding: one move edit that also turns the item about the vertical.
rest(500);
n0 = edits.length;
const tw0 = handTwist(synthHand(0.5, 0.6, 'fist').landmarks, ASPECT);
const tw1 = handTwist(synthHand(0.5, 0.6, 'fist', { twist: 40 }).landmarks, ASPECT);
drive(300, () => [synthHand(0.5, 0.6, 'fist')]);
drive(400, (k) => [synthHand(0.5, 0.6, 'fist', { twist: 40 * k })]);
drive(300, () => [synthHand(0.5, 0.6, 'fist', { twist: 40 })]);
drive(700, () => [synthHand(0.5, 0.6, 'open')]);
const tw = edits.slice(n0);
// The knuckle line's angle wraps at ±180° (the manipulator unwraps it the same way).
let twistDiff = tw1 - tw0;
if (twistDiff > Math.PI) twistDiff -= 2 * Math.PI;
if (twistDiff < -Math.PI) twistDiff += 2 * Math.PI;
const wantDy = twistDiff - Math.sign(twistDiff) * 0.05;   // minus the manipulator's 2.9° deadzone
const gotDy = tw[0]?.dy ?? 0;
const upright = new THREE.Vector3(0, 1, 0).applyQuaternion(itemA.root.quaternion).y;
metrics.twistDyDeg = +((gotDy * 180) / Math.PI).toFixed(1);
check('G5 fist twist: the same single move edit carries the turn (dy within 10% of the wrist twist), item stays upright',
  tw.length === 1 && tw[0].op === 'move' && Math.abs(gotDy - wantDy) < 0.1 * Math.abs(wantDy) && upright > 1 - 1e-9,
  `edits=${tw.length} dy=${(gotDy * 180 / Math.PI).toFixed(1)}° want=${(wantDy * 180 / Math.PI).toFixed(1)}°`);
objectMode.undo();
check('G6 ... and one undo puts position AND rotation back', sameArr(arr(itemA.root), rootA0));

// Two-hand pinch: one scale edit for the whole gesture, even with a pause in the middle.
rest(500);
n0 = edits.length;
const s0 = itemA.root.scale.x;
const two = (l, r) => [synthHand(l, 0.6, 'pinch', { handedness: 'Left' }), synthHand(r, 0.6, 'pinch')];
drive(300, () => two(0.42, 0.58));
drive(300, (k) => two(lerp(0.42, 0.36, k), lerp(0.58, 0.64, k)));
drive(800, () => two(0.36, 0.64));   // a pause longer than the wheel's 600 ms coalescing
drive(300, (k) => two(lerp(0.36, 0.3, k), lerp(0.64, 0.7, k)));
drive(700, () => [synthHand(0.3, 0.6, 'open', { handedness: 'Left' }), synthHand(0.7, 0.6, 'open')]);
const sc = edits.slice(n0);
const f = itemA.root.scale.x / s0;
metrics.twoHandScale = +f.toFixed(3);
check('G7 two-hand pinch spread: ONE scale edit (pause included), item grew, stays on the floor',
  sc.length === 1 && sc[0].op === 'scale' && Math.abs(sc[0].factor - f) < 1e-6 && f > 1.3 && f < 2.6,
  `edits=${sc.map((e) => e.op).join(',')} factor=${f.toFixed(3)}`);
objectMode.undo();
check('G8 ... undone in one step', sameArr(arr(itemA.root), rootA0));

// Nothing selected: a fist orbits the camera, no edit.
rest(500);
objectMode.select(null);
n0 = edits.length;
const cam0 = camSnap();
const az0 = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
drive(300, () => [synthHand(0.5, 0.6, 'fist')]);
drive(300, (k) => [synthHand(lerp(0.5, 0.4, k), 0.6, 'fist')]);
drive(700, () => [synthHand(0.4, 0.6, 'open')]);
const az1 = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z);
const camMoved = !sameArr(camSnap(), cam0, 1e-6);
const targetSame = sameArr(controls.target.toArray(), cam0.slice(3), 1e-9);
check('G9 fist with nothing selected orbits the camera about its target (no edit)',
  camMoved && targetSame && edits.length === n0 && Math.abs(az1 - az0) > 0.05, `azimuth ${((az1 - az0) * 180 / Math.PI).toFixed(1)}°`);
camera.position.fromArray(cam0.slice(0, 3)); controls.update();

// Busy (polygon lens / Library ring): hands are not read.
rest(500);
objectMode.select('item:1');
busyFlag = true;
n0 = edits.length;
grabs0 = hands.stats.grabs;
drive(300, () => [synthHand(0.5, 0.6, 'fist')]);
drive(300, (k) => [synthHand(lerp(0.5, 0.3, k), 0.6, 'fist')]);
drive(300, () => [synthHand(0.3, 0.6, 'open')]);
busyFlag = false;
rest(700);
check('G10 busy: a fist moves nothing', edits.length === n0 && hands.stats.grabs === grabs0 && sameArr(arr(itemA.root), rootA0));

// ---- H. pins ----------------------------------------------------------------------------------
rest(500);
n0 = edits.length;
const pinE = objectMode.setPinned('item:1', true);
check('H1 pin is an edit: op pin, before/after pinned false/true, selection reports pinned',
  pinE?.op === 'pin' && pinE.before.pinned === false && pinE.after.pinned === true && objectMode.state().selection?.pinned === true && edits.length === n0 + 1);
const ref0 = hands.stats.refused;
statuses.length = 0;
const camP = camSnap();
drive(300, () => [synthHand(0.5, 0.6, 'fist')]);
drive(300, (k) => [synthHand(lerp(0.5, 0.3, k), 0.6, 'fist')]);
drive(700, () => [synthHand(0.3, 0.6, 'open')]);
check('H2 fist on a pinned item: nothing moves, camera holds still, status says pinned',
  edits.length === n0 + 1 && sameArr(arr(itemA.root), rootA0) && sameArr(camSnap(), camP, 1e-9) && hands.stats.refused === ref0 + 1
  && statuses.some((s) => /pinned/.test(s.m)), statuses.map((s) => s.m).join(' | '));
drive(300, () => two(0.42, 0.58));
drive(300, (k) => two(lerp(0.42, 0.3, k), lerp(0.58, 0.7, k)));
drive(700, () => [synthHand(0.3, 0.6, 'open', { handedness: 'Left' }), synthHand(0.7, 0.6, 'open')]);
check('H3 two-hand scale on a pinned item: refused', edits.length === n0 + 1 && sameArr(arr(itemA.root), rootA0) && hands.stats.refused === ref0 + 2);
const plane0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
check('H4 objectMode API refuses a pinned target: beginMove false, rotateTarget / scaleTarget null',
  objectMode.beginMove('item:1', plane0, new THREE.Vector3()) === false && objectMode.rotateTarget('item:1', 0.3) === null
  && objectMode.scaleTarget('item:1', 1.2) === null && edits.length === n0 + 1 && sameArr(arr(itemA.root), rootA0));
// A part of the pinned item: the click takes the part, a fist moves only that part.
objectMode.setMode('object');
objectMode.select('item:1');
render();
const partClicked = click(itemA.parts[0].mesh);
const part0 = arr(itemA.parts[0].mesh);
rest(400);
drive(300, () => [synthHand(0.5, 0.6, 'fist')]);
drive(300, (k) => [synthHand(lerp(0.5, 0.4, k), 0.6, 'fist')]);
drive(700, () => [synthHand(0.4, 0.6, 'open')]);
const pe = edits.slice(n0 + 1);
check('H5 pinned item: a hand click on its part selects the part, and a fist moves only that part (item root still)',
  partClicked === '1.0' && pe.length === 1 && pe[0].op === 'move' && pe[0].part === '1.0' && sameArr(arr(itemA.root), rootA0) && !sameArr(arr(itemA.parts[0].mesh), part0),
  `clicked=${partClicked} edits=${pe.map((e) => `${e.op}:${e.part}`).join(',')}`);
objectMode.undo();
// Mouse on a pinned item's... pinned part: no drag, no orbit while pressed.
objectMode.setPinned('1.0', true);
const cv = renderer.domElement;
const rct = cv.getBoundingClientRect();
const pN = ndcOf(itemA.parts[0].mesh);
const px = rct.left + ((pN.x + 1) / 2) * rct.width, py = rct.top + ((1 - pN.y) / 2) * rct.height;
const nM = edits.length;
cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: px, clientY: py, button: 0, pointerId: 7, bubbles: true }));
const orbitOff = controls.enabled === false && !objectMode.dragging;
cv.dispatchEvent(new PointerEvent('pointermove', { clientX: px + 40, clientY: py, pointerId: 7, bubbles: true }));
cv.dispatchEvent(new PointerEvent('pointerup', { clientX: px + 40, clientY: py, button: 0, pointerId: 7, bubbles: true }));
check('H6 mouse press on a pinned part: no drag, orbit off while pressed, back on after release, no edit',
  orbitOff && controls.enabled && edits.length === nM && sameArr(arr(itemA.parts[0].mesh), part0), `orbitOff=${orbitOff}`);
// K toggles the selection's pin (either mode), undoably; replay keeps pins.
objectMode.select('1.0');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
const unpinnedByK = !objectMode.isPinned('1.0') && edits.at(-1).op === 'unpin';
objectMode.undo();
const repinnedByUndo = objectMode.isPinned('1.0');
const last = edits.at(-1).seq;
objectMode.replayTo(0);
const atStart = !objectMode.isPinned('1.0') && !objectMode.isPinned('item:1');
objectMode.replayTo(Infinity);
check('H7 K unpins (op unpin); undo re-pins; replayTo(0) has no pins, replayTo(end) restores both',
  unpinnedByK && repinnedByUndo && atStart && objectMode.isPinned('1.0') && objectMode.isPinned('item:1') && edits.at(-1).seq === last);
objectMode.undo(); objectMode.undo();
check('H8 undoing both pins frees them; selection readout follows', !objectMode.isPinned('1.0') && !objectMode.isPinned('item:1') && objectMode.state().selection?.pinned === false);

// Mouse moves keep their old log shape (no dy key), so earlier sessions and tools read the same.
objectMode.select(null);
const nD = edits.length;
cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: px, clientY: py, button: 0, pointerId: 8, bubbles: true }));
for (let i = 1; i <= 5; i++) {
  cv.dispatchEvent(new PointerEvent('pointermove', { clientX: px + i * 10, clientY: py, pointerId: 8, bubbles: true }));
  objectMode.tick(performance.now() + i * 16);
}
cv.dispatchEvent(new PointerEvent('pointerup', { clientX: px + 50, clientY: py, button: 0, pointerId: 8, bubbles: true }));
const md = edits.slice(nD);
check('H9 mouse drag still logs one plain move (dx/dz, no dy) and stays undoable', md.length === 1 && md[0].op === 'move' && !('dy' in md[0]) && md[0].dx > 0,
  `edits=${md.map((e) => e.op).join(',')} dx=${md[0]?.dx?.toFixed(3)}`);
objectMode.undo();
check('H10 edit log back to the pre-gesture length after the undos (nothing leaked)', edits.length === nD && sameArr(arr(itemA.parts[0].mesh), part0) && sameArr(arr(itemA.root), rootA0), `edits=${edits.length}`);

// ---- I. hands on the page: ring spin, lens follow / resize, push-zoom, clap ------------------
// Fakes with the exact surface hands.js reads (ring.js isOpen/spinBy/spinEnd/_state; polygon.js
// active/radius/setPointer/clearPointer/select), so these pin the adapter, not the widgets.
{
  const spins = [];
  let spinEnds = 0;
  fakeRing = { isOpen: () => true, spinBy: (n) => spins.push(n), spinEnd: () => { spinEnds++; }, _state: () => ({ pxPerCard: 160 }) };
  rest(700);
  objectMode.select('item:1');
  n0 = edits.length;
  const camR = camSnap();
  const ring0 = hands.stats.ringSpins;
  drive(300, () => [synthHand(0.5, 0.6, 'fist')]);
  drive(300, (k) => [synthHand(lerp(0.5, 0.3, k), 0.6, 'fist')]);
  drive(700, () => [synthHand(0.3, 0.6, 'open')]);
  const cards = spins.reduce((a, b) => a + b, 0);
  metrics.ringSpinCards = +cards.toFixed(2);
  check('I1 ring open: a fist-drag spins the ring (one spin, ends with spinEnd), moves nothing, no edit, camera still',
    hands.stats.ringSpins === ring0 + 1 && spins.length > 3 && Math.abs(cards) > 0.3 && spinEnds === 1 && edits.length === n0 &&
    sameArr(arr(itemA.root), rootA0) && sameArr(camSnap(), camR, 1e-9),
    `${spins.length} steps, ${cards.toFixed(2)} cards, spinEnd ${spinEnds}`);
  // Opposite drag spins the other way (the ring follows the hand like a pointer drag).
  const before = spins.length;
  drive(300, () => [synthHand(0.3, 0.6, 'fist')]);
  drive(300, (k) => [synthHand(lerp(0.3, 0.5, k), 0.6, 'fist')]);
  drive(700, () => [synthHand(0.5, 0.6, 'open')]);
  const back = spins.slice(before).reduce((a, b) => a + b, 0);
  check('I2 ... dragging back spins it back by about the same amount (±25%)', Math.sign(back) === -Math.sign(cards) && Math.abs(Math.abs(back) / Math.abs(cards) - 1) < 0.25, `${back.toFixed(2)} vs ${cards.toFixed(2)}`);
  check('I3 ring open: a hand click reaches nothing in the scene', hands.handleClick({ source: 'hand', via: 'other-pinch', x: 0, y: 0 }) === null && objectMode.selectedId === 'item:1');
  fakeRing = null;
  rest(700);

  // Lens: follows the hand cursor; leaves it alone over page UI; pinch-hold + up = bigger.
  let ptr = null, lensSel = 0;
  fakeLens = { active: true, radius: 60, setPointer: (x, y) => { ptr = { x, y }; }, clearPointer: () => { ptr = null; }, select: () => { lensSel++; } };
  const aimState = { source: 'hand', mode: 'aim' };
  hands.handleAim({ state: aimState, hit: null, px: { x: 140, y: 120 } });
  const followed = ptr && ptr.x === 140 && ptr.y === 120;
  hands.handleAim({ state: aimState, hit: null, px: { x: 160, y: 130 }, ui: true });
  const clearedOverUi = ptr === null;
  hands.handleAim({ state: aimState, hit: null, px: { x: 200, y: 150 } });
  hands.handleAim({ state: null, hit: null });
  check('I4 lens follows the hand cursor, lets go over the page UI and when the hand leaves', followed && clearedOverUi && ptr === null);
  // Pinch-hold and move up 160 px (= x2), via a stubbed runtime cursor (no camera here).
  const own = (k) => Object.getOwnPropertyDescriptor(rt, k);
  const saved = { cursorPx: own('cursorPx'), pinchHeld: own('pinchHeld'), tracking: own('tracking'), update: own('update') };
  let cur = { x: 200, y: 300 }, held = true;
  Object.defineProperty(rt, 'cursorPx', { get: () => cur, configurable: true });
  Object.defineProperty(rt, 'pinchHeld', { get: () => held, configurable: true });
  Object.defineProperty(rt, 'tracking', { get: () => true, configurable: true });
  Object.defineProperty(rt, 'update', { value: () => {}, configurable: true, writable: true });
  try {
    const rs0 = hands.stats.lensResizes, ls0 = hands.stats.lensSelects;
    const r = hands.handleClick({ source: 'hand', via: 'other-pinch', x: 0, y: 0, px: { x: 200, y: 300 } });
    for (let i = 1; i <= 8; i++) { cur = { x: 200, y: 300 - 20 * i }; hands.update(performance.now()); }
    const grown = fakeLens.radius;
    held = false;
    hands.update(performance.now());
    metrics.lensResizeRatio = +(grown / 60).toFixed(3);
    check('I5 lens: pinch-hold + 160 px up doubles the radius (±5%); the release selects nothing', r === 'lens' && Math.abs(grown / 60 - 2) < 0.1 &&
      hands.stats.lensResizes === rs0 + 1 && hands.stats.lensSelects === ls0 && lensSel === 0, `r=${grown.toFixed(1)}`);
    // A still pinch (inside the 12 px slop) is a click: the lens selects on release.
    held = true; cur = { x: 200, y: 300 };
    hands.handleClick({ source: 'hand', via: 'other-pinch', x: 0, y: 0, px: { x: 200, y: 300 } });
    cur = { x: 203, y: 294 }; hands.update(performance.now());
    held = false; hands.update(performance.now());
    check('I6 lens: a still pinch selects the faces on release, radius unchanged', lensSel === 1 && hands.stats.lensSelects === ls0 + 1 && fakeLens.radius === grown, `selects=${lensSel}`);
  } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(rt, k, d); else delete rt[k]; }
  }
  fakeLens = null;

  // Push-zoom: fist with nothing selected, pushed away from the camera (palm shrinks) = dolly in
  // toward the orbit centre (hands.js contract: push / pull = zoom; pull = out).
  rest(700);
  objectMode.select(null);
  n0 = edits.length;
  const camZ = camSnap();
  const dist0 = camera.position.distanceTo(controls.target);
  const zooms0 = hands.stats.zooms;
  drive(300, () => [synthHand(0.5, 0.6, 'fist', { palm: 0.12 })]);
  drive(400, (k) => [synthHand(0.5, 0.6, 'fist', { palm: lerp(0.12, 0.08, k) })]);
  drive(700, () => [synthHand(0.5, 0.6, 'open', { palm: 0.08 })]);
  const dist1 = camera.position.distanceTo(controls.target);
  metrics.pushZoomRatio = +(dist1 / dist0).toFixed(3);
  check('I7 push-zoom: fist pushed away from the camera with nothing selected dollies in (target fixed, no edit)',
    dist1 < dist0 * 0.95 && sameArr(controls.target.toArray(), camZ.slice(3), 1e-9) && edits.length === n0 && hands.stats.zooms === zooms0 + 1,
    `distance ${dist0.toFixed(3)} -> ${dist1.toFixed(3)}`);
  drive(300, () => [synthHand(0.5, 0.6, 'fist', { palm: 0.08 })]);
  drive(400, (k) => [synthHand(0.5, 0.6, 'fist', { palm: lerp(0.08, 0.12, k) })]);
  drive(700, () => [synthHand(0.5, 0.6, 'open', { palm: 0.12 })]);
  const dist2 = camera.position.distanceTo(controls.target);
  check('I8 ... pulling it back toward the camera dollies out again (back within 10% of the start)', dist2 > dist1 && Math.abs(dist2 / dist0 - 1) < 0.1, `${dist2.toFixed(3)}`);
  camera.position.fromArray(camZ.slice(0, 3)); controls.update();

  // Clap from rest: resetView once, status says so, no edit; not while the ring is open.
  const clap = () => {
    rest(800);
    drive(200, () => [synthHand(0.2, 0.6, 'open', { handedness: 'Left' }), synthHand(0.8, 0.6, 'open')]);
    drive(230, (k) => [synthHand(lerp(0.2, 0.47, k), 0.6, 'open', { handedness: 'Left' }), synthHand(lerp(0.8, 0.53, k), 0.6, 'open')]);
    rest(300);
  };
  n0 = edits.length;
  const v0 = viewResets, c0 = hands.stats.claps, st0 = statuses.length;
  clap();
  check('I9 clap: resetView() once, no edit, status says the view was reset', viewResets === v0 + 1 && hands.stats.claps === c0 + 1 && edits.length === n0 &&
    statuses.slice(st0).some((s) => /View reset/.test(s.m)), `resets ${viewResets - v0}`);
  fakeRing = { isOpen: () => true, spinBy: () => {}, spinEnd: () => {}, _state: () => ({ pxPerCard: 160 }) };
  clap();
  check('I10 clap with the ring open: no view reset', viewResets === v0 + 1, `resets ${viewResets - v0}`);
  fakeRing = null;
  rest(700);
}

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

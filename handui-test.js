// handui-test.js: hands on the page (handUI.js through the real handsRuntime). A synthetic
// aiming hand (pointer pose) puts the cursor on known page px and the other hand pinches, all
// through runtime.injectFrame (the camera-frame path minus the tracker), so no camera is needed.
// Run: handui-test.html (results on window.handUIResults; recorded by testrec.js on localhost).
import * as THREE from 'three';

const V = '?v=' + Date.now();
const { createHandsRuntime } = await import('./handsRuntime.js' + V);
const ui = await import('./handUI.js' + V);
const { createRing } = await import('./platform/ring.js' + V);

const out = document.getElementById('out');
const results = [];
const metrics = {};
const consoleErrors = [];
const origError = console.error;
const MEDIAPIPE_INFO = /^INFO: /;
console.error = (...a) => { const m = a.map(String).join(' '); if (!MEDIAPIPE_INFO.test(m)) consoleErrors.push(m); origError(...a); };
window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));
const log = (s) => { out.textContent += s + '\n'; };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
const $ = (id) => document.getElementById(id);
const centre = (el) => { const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 }; };

// ---- a small 3D view the runtime picks in ------------------------------------------------------
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(400, 220, false);
stage.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 400 / 220, 0.01, 100);
camera.position.set(0, 0, 3);
const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x3a8fb0 }));
scene.add(box);
scene.updateMatrixWorld(true);

// ---- fixture listeners ------------------------------------------------------------------------
const clicks = { btn: [], tiny: 0, pa: 0, pb: 0, list: [] };
$('btn').addEventListener('click', (e) => clicks.btn.push({ x: e.clientX, y: e.clientY }));
for (const id of ['tiny', 'pa', 'pb']) $(id).addEventListener('click', () => clicks[id]++);
const sliderEv = { input: 0, change: 0 };
$('slider').addEventListener('input', () => sliderEv.input++);
$('slider').addEventListener('change', () => sliderEv.change++);
for (let i = 0; i < 30; i++) {
  const b = document.createElement('button');
  b.textContent = `Item ${i + 1}`;
  b.addEventListener('click', () => clicks.list.push(i));
  $('list').append(b);
}

const rt = createHandsRuntime({
  scene, camera, renderer, overlay: document.createElement('canvas'), video: document.createElement('video'),
  pickTargets: () => box, holdOn: () => null, handUI: true, cursorSpace: 'page'
});
const sceneClicks = [], uiClicks = [], uiTypes = [];
rt.on('click', (c) => sceneClicks.push(c));
rt.on('ui-click', (c) => uiClicks.push(c));
rt.on('ui-type', (c) => uiTypes.push(c));

// ---- synthetic hands ---------------------------------------------------------------------------
// The aiming hand's palm centroid (landmarks 0, 5, 9, 13, 17) is put where the pointer's reach
// mapping sends it to the wanted page px (cursorSpace 'page': the reach covers the window).
const reach = rt.pointer.profile.reach;
function palmFor(px) {
  const nx = (px.x / innerWidth) * 2 - 1, ny = 1 - (px.y / innerHeight) * 2;
  return { x: reach.x0 + ((1 - nx) * (reach.x1 - reach.x0)) / 2, y: reach.y0 + ((1 - ny) * (reach.y1 - reach.y0)) / 2 };
}
function hand(c, { gun = false, pinching = false, handedness = 'Right' } = {}) {
  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x: c.x, y: c.y, z: 0 });
  lm[0] = { x: c.x, y: c.y + 0.06, z: 0 };          // wrist below, middle MCP above: centroid stays c
  lm[9] = { x: c.x, y: c.y - 0.06, z: 0 };
  lm[5] = { x: c.x + 0.03, y: c.y, z: 0 };
  lm[17] = { x: c.x - 0.03, y: c.y, z: 0 };
  return {
    gesture: 'None', handedness, landmarks: lm,
    pinch: { pinching, ratio: pinching ? 0.1 : 0.7 },
    pointer: { gun, rejectedBy: gun ? null : 'label' }, fistLike: false
  };
}
const OTHER = { x: 0.15, y: 0.5 };   // the clicking hand sits to one side
let t = 500000;
// ms of 30 fps camera frames with the cursor gliding from -> to (page px) and the other hand
// open or pinched.
function drive(ms, from, to = from, pinching = false) {
  const n = Math.max(1, Math.round(ms / 33));
  for (let i = 0; i < n; i++) {
    const k = n > 1 ? i / (n - 1) : 1;
    const px = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    t += 33;
    rt.injectFrame([hand(palmFor(px), { gun: true }), hand(OTHER, { pinching, handedness: 'Left' })], { t });
  }
}
// Settle on px with the other hand open (arms the pinch edge), then pinch for `holdMs`, release.
function pinchAt(px, holdMs = 150) {
  drive(600, px);
  drive(holdMs, px, px, true);
  drive(200, px);
}

rt.ui.setEnabled(true);   // runtime.start() does this with a camera
check('A1 handUI is opt-in: a bare runtime has none; enabled sets body.hands-on',
  createHandsRuntime({ scene: new THREE.Scene(), camera, renderer: { domElement: document.createElement('canvas') }, overlay: document.createElement('canvas'), video: document.createElement('video') }).ui === null && document.body.classList.contains('hands-on'));

// ---- B. button: hover, click at the centre, no 3D pick -------------------------------------------
const bc = centre($('btn'));
drive(700, bc);
const cur = rt.cursorPx;
check('B1 the synthetic cursor lands on the wanted page px (<= 2 px)', cur && Math.hypot(cur.x - bc.x, cur.y - bc.y) <= 2, cur ? `${cur.x.toFixed(1)},${cur.y.toFixed(1)} vs ${bc.x},${bc.y}` : 'no cursor');
check('B2 over a button: overUi, target = the button, hover ring shown', rt.overUi && rt.ui.target === $('btn') && document.querySelector('.hand-ui-ring.on') !== null);
const ringCss = getComputedStyle(document.querySelector('.hand-ui-ring'));
check('B3 photosafe: the hover ring fades (opacity transition >= 120 ms), never steps', /opacity/.test(ringCss.transitionProperty) && parseFloat(ringCss.transitionDuration) >= 0.12, `${ringCss.transitionProperty} ${ringCss.transitionDuration}`);
pinchAt(bc);
check('B4 aim + other-hand pinch clicks the button once', clicks.btn.length === 1 && uiClicks.length === 1 && uiClicks[0].kind === 'click', `btn=${clicks.btn.length} ui=${uiClicks.length}`);
check('B5 ... and the 3D pick does not also fire', sceneClicks.length === 0, `scene clicks ${sceneClicks.length}`);

// ---- C. magnetism, 48 px minimum, switch hysteresis -----------------------------------------------
const near = { x: $('btn').getBoundingClientRect().right + 15, y: bc.y };
pinchAt(near);
const last = clicks.btn.at(-1);
check('C1 magnetism: 15 px right of the button still clicks it, at its centre', clicks.btn.length === 2 && Math.abs(last.x - bc.x) < 0.6 && Math.abs(last.y - bc.y) < 0.6, last ? `${last.x},${last.y}` : '-');
const tc = centre($('tiny'));
const offTiny = { x: tc.x + 40, y: tc.y };
check('C2 48 px minimum: 40 px from an 18 px button\'s centre targets it in hands mode', rt.ui.resolve(offTiny) === $('tiny'));
document.body.classList.remove('hands-on');
check('C3 ... and not without body.hands-on (33 px reach)', rt.ui.resolve(offTiny) === null);
document.body.classList.add('hands-on');
// A at 420..460, B at 520..560: the gap is 60 px; with A held, B must be 1.3x closer.
const ra = $('pa').getBoundingClientRect(), rb = $('pb').getBoundingClientRect();
drive(500, centre($('pa')));
const mid = { x: (ra.right + rb.left) / 2 + 3, y: centre($('pa')).y };   // B 3 px closer: not enough
drive(400, centre($('pa')), mid);
const kept = rt.ui.target;
const nearB = { x: rb.left - 8, y: mid.y };   // A 52 px away, B 8: switches
drive(300, mid, nearB);
check('C4 switch hysteresis: a slightly closer neighbour does not steal the target; 1.3x closer does', kept === $('pa') && rt.ui.target === $('pb'), `${kept?.id} -> ${rt.ui.target?.id}`);

// ---- D. slider: pinch-hold drag (input while moving, change on release) -----------------------------
const s = $('slider');
const sr = s.getBoundingClientRect();
const thumb = { x: sr.left + sr.width * 0.2, y: (sr.top + sr.bottom) / 2 };
drive(600, thumb);
drive(66, thumb, thumb, true);
const inputs0 = sliderEv.input;
drive(400, thumb, { x: thumb.x + 150, y: thumb.y }, true);   // ~375 px/s: full gain
const midValue = Number(s.value), changesDuring = sliderEv.change;
drive(100, { x: thumb.x + 150, y: thumb.y }, { x: thumb.x + 150, y: thumb.y }, true);
drive(200, { x: thumb.x + 150, y: thumb.y });
const fastValue = Number(s.value);
check('D1 pinch-hold drag moves the slider (~+75 for 150 px of a 200 px track, the cursor filter lags a little)', fastValue >= 75 && fastValue <= 100, `20 -> ${fastValue}`);
check('D2 input events while moving, no change until the release, then exactly one', sliderEv.input > inputs0 + 3 && changesDuring === 0 && sliderEv.change === 1, `input +${sliderEv.input - inputs0}, change during ${changesDuring}, after ${sliderEv.change} (mid ${midValue})`);
// Precision: below 5 cm/s the gain halves.
s.value = '20';
drive(600, thumb);
drive(66, thumb, thumb, true);
drive(1500, thumb, { x: thumb.x + 60, y: thumb.y }, true);   // 40 px/s
drive(200, { x: thumb.x + 60, y: thumb.y });
const slowValue = Number(s.value);
check('D3 slow drag (40 px/s) moves at half gain: ~+15 for 60 px, not +30', slowValue >= 30 && slowValue <= 40, `20 -> ${slowValue}`);
metrics.sliderFast = fastValue; metrics.sliderSlow = slowValue;

// ---- E. scroll area: pinch-hold + move scrolls (no click), a tap clicks -----------------------------
const list = $('list');
const lr = list.getBoundingClientRect();
const inList = { x: lr.left + 100, y: lr.top + 90 };
list.scrollTop = 0;
drive(600, inList);
drive(66, inList, inList, true);
drive(300, inList, { x: inList.x, y: inList.y - 80 }, true);
const scrolled = list.scrollTop;
const listClicks0 = clicks.list.length;
drive(200, { x: inList.x, y: inList.y - 80 });
const coastFrom = list.scrollTop;
drive(1500, { x: inList.x, y: inList.y - 80 });   // the flick's momentum runs out
metrics.coastPx = list.scrollTop - coastFrom;
check('E1 pinch-hold + move up 80 px scrolls the list ~80 px (touch-like) and clicks nothing', scrolled >= 60 && scrolled <= 90 && listClicks0 === 0 && clicks.list.length === 0, `scrollTop ${scrolled}, list clicks ${clicks.list.length}`);
const before = clicks.list.length;
const item = list.children[Math.ceil(list.scrollTop / 28) + 1];
const ic = centre(item);
pinchAt(ic);
check('E2 a pinch without moving in a list clicks the item under the cursor (on the release)', clicks.list.length === before + 1 && clicks.list.at(-1) === [...list.children].indexOf(item), `clicked ${clicks.list.at(-1)} want ${[...list.children].indexOf(item)}`);

// ---- F. select / text field --------------------------------------------------------------------------
const sel = $('sel');
pinchAt(centre(sel));
check('F1 a pinch on a select steps to its next option', sel.selectedIndex === 1, `index ${sel.selectedIndex}`);
pinchAt(centre($('txt')));
check('F2 a pinch on a text field focuses it and says typing is optional (ui-type)', document.activeElement === $('txt') && uiTypes.length === 1, `active ${document.activeElement?.id || document.activeElement?.tagName} types ${uiTypes.length} last ui-click ${uiClicks.at(-1)?.kind} resolve ${rt.ui.resolve(centre($('txt')))?.id} efp ${document.elementFromPoint(centre($('txt')).x, centre($('txt')).y)?.id} cursor ${rt.cursorPx?.x.toFixed(0)},${rt.cursorPx?.y.toFixed(0)} want ${centre($('txt')).x},${centre($('txt')).y}`);
$('txt').blur();

// ---- G. the 3D view: hand clicks go to the scene, not the page -----------------------------------------
const sc = centre(renderer.domElement);
const ui0 = uiClicks.length;
pinchAt(sc);
check('G1 over the 3D canvas: not overUi, the pinch is a 3D click (canvas NDC ~0,0), no page click', !rt.overUi && sceneClicks.length === 1 && uiClicks.length === ui0 && Math.abs(sceneClicks[0].x) < 0.02 && Math.abs(sceneClicks[0].y) < 0.03,
  sceneClicks[0] ? `ndc ${sceneClicks[0].x.toFixed(3)},${sceneClicks[0].y.toFixed(3)}` : 'no scene click');

// ---- H. the Library ring: aim + pinch opens a card; pinch-hold drag spins it -------------------------
{
  const html = await (await fetch('./platform/index.html')).text();
  const a = html.indexOf('/* ---- library ring (ring.js)'), b = html.indexOf('/* ---- narrow screens');
  const style = document.createElement('style');
  style.textContent = a >= 0 && b > a ? html.slice(a, b) : '';
  document.head.append(style);
}
const rs = $('ringStage');
const rRenderer = new THREE.WebGLRenderer({ antialias: true });
rRenderer.setPixelRatio(1);
rs.prepend(rRenderer.domElement);
rRenderer.setSize(800, 420, false);
const rScene = new THREE.Scene();
const rCam = new THREE.PerspectiveCamera(45, 800 / 420, 0.01, 100);
rCam.position.set(0, 0.4, 2);
rCam.lookAt(0, 0.2, 0);
const cards = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, title: `Project ${i + 1}`, subtitle: '', badges: [], thumbUrl: null, sample: false, versions: [{ id: `p${i}-v0`, label: 'Working copy', type: 'working', date: 0, thumbUrl: null, badges: [] }], currentVersionId: `p${i}-v0` }));
const ring = createRing({ THREE, scene: rScene, camera: rCam, renderer: rRenderer, controls: { enabled: true, autoRotate: false }, root: $('libraryRing'), list: $('libraryList'), reducedMotion: false, keys: false });
const chosen = [];
ring.on('choose', (d) => chosen.push(d.projectId));
ring.setProjects(cards);
ring.open();
for (let i = 0; i < 60; i++) ring.update(16.7);
const rect0 = ring._state().rects.find((r) => r.off === 0);
const rootR = $('libraryRing').getBoundingClientRect();
const cardCentre = rect0 ? { x: rootR.left + (rect0.l + rect0.r) / 2, y: rootR.top + (rect0.t + rect0.b) / 2 } : centre(rs);
drive(600, cardCentre);
check('H1 over the ring: overUi on its surface (data-hand=surface), no hover ring on the backdrop', rt.overUi && rt.ui.surface?.classList.contains('lr-surface') && rt.ui.target === null);
pinchAt(cardCentre);
check('H2 aim at the centre card + other-hand pinch opens it (ring "choose")', chosen.length === 1 && chosen[0] === 'p0', `chosen ${chosen.join(',') || 'none'}`);
ring.open();
for (let i = 0; i < 60; i++) ring.update(16.7);
const active0 = ring._state().active;
drive(600, cardCentre);
drive(66, cardCentre, cardCentre, true);
const left = { x: cardCentre.x - 330, y: cardCentre.y };
for (let i = 0; i < 15; i++) { drive(33, { x: cardCentre.x - (330 * i) / 15, y: cardCentre.y }, { x: cardCentre.x - (330 * (i + 1)) / 15, y: cardCentre.y }, true); ring.update(33); }
drive(100, left);
for (let i = 0; i < 120; i++) ring.update(16.7);
check('H3 pinch-hold + drag left on the ring spins it to a later card (no card chosen)', ring._state().active !== active0 && chosen.length === 1, `active ${active0} -> ${ring._state().active}`);
ring.close();
for (let i = 0; i < 30; i++) ring.update(16.7);

// ---- I. camera: remember + auto-start (spec section 3) -----------------------------------------------
{
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  const perm = (state) => ({ query: async () => ({ state }) });
  let starts = 0;
  const start = async () => { starts++; return true; };
  const btn = document.createElement('button');
  const statuses = [];
  const granted = await ui.autoStartCamera({ start, button: btn, storage, permissions: perm('granted') });
  check('I1 remember on by default + permission granted: starts the camera on load', granted === 'started' && starts === 1 && ui.rememberCamera(storage));
  const prompt = await ui.autoStartCamera({ start, button: btn, storage, permissions: perm('prompt') });
  const pulsing = btn.classList.contains('hand-pulse');
  btn.click();
  check('I2 permission not asked yet: no start, the Camera button pulses until clicked', prompt === 'prompt' && starts === 1 && pulsing && !btn.classList.contains('hand-pulse'));
  const denied = await ui.autoStartCamera({ start, button: btn, storage, permissions: perm('denied'), setStatus: (m) => statuses.push(m) });
  check('I3 blocked: says how to unblock it, no start', denied === 'denied' && starts === 1 && /address bar/.test(statuses[0] ?? ''));
  const host = document.createElement('div');
  const label = ui.mountRememberToggle(host, { storage });
  const boxEl = label.querySelector('input');
  boxEl.checked = false; boxEl.dispatchEvent(new Event('change'));
  const off = await ui.autoStartCamera({ start, button: btn, storage, permissions: perm('granted') });
  check('I4 the Help checkbox (default on) turns it off: stored "0", no auto-start', label && mem.get(ui.REMEMBER_KEY) === '0' && off === 'off' && starts === 1);
  const pulseCss = (() => { const b2 = document.createElement('button'); b2.className = 'hand-pulse'; document.body.append(b2); const cs = getComputedStyle(b2); const d = parseFloat(cs.animationDuration); b2.remove(); return d; })();
  check('I5 photosafe: the pulse is a slow glow (>= 2 s a cycle: < 0.5 flashes/s)', pulseCss >= 2, `${pulseCss}s`);
}

// ---- J. off: no cursor, nothing over the UI ------------------------------------------------------------
rt.ui.setEnabled(false);
check('J1 disabled (camera off): body.hands-on removed, ring hidden, nothing over the UI', !document.body.classList.contains('hands-on') && !document.querySelector('.hand-ui-ring.on') && !rt.ui.overUiAt(bc));
metrics.uiClicks = uiClicks.length;
metrics.sceneClicks = sceneClicks.length;
rt.dispose();
ring.dispose();

check('0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
window.handUIResults = { passed: results.length - failed, failed, results, metrics };

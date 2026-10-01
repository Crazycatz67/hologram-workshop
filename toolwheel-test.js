// toolwheel-test.js: the ✌ tool wheel (toolWheel.js) with synthetic hands and cursor points,
// no camera. Run: toolwheel-test.html (results on window.toolWheelResults; recorded by testrec.js
// on localhost).
const V = '?v=' + Date.now();
const { createToolWheel, sectorAt, DIRS, WHEEL } = await import('./toolWheel.js' + V);

const out = document.getElementById('out');
const results = [];
const consoleErrors = [];
const origError = console.error;
console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); origError(...a); };
window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));
const log = (s) => { out.textContent += s + '\n'; };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}

// A synthetic hand: 21 landmarks around a wrist point, a MediaPipe gesture label and score.
function hand(gesture, { x = 0.5, y = 0.5, score = 0.95, engaged = true } = {}) {
  const landmarks = Array.from({ length: 21 }, (_, i) => ({ x: x + (i % 5) * 0.01, y: y - Math.floor(i / 5) * 0.02, z: 0 }));
  landmarks[0] = { x, y, z: 0 };
  landmarks[9] = { x, y: y - 0.1, z: 0 };
  return { gesture, score, landmarks, engaged };
}
// Feed frames at 30 fps from t0 for ms; returns the last feed result and the end time.
function hold(wheel, hands, t0, ms) {
  let r = null, t = t0;
  for (; t <= t0 + ms; t += 33) r = wheel.feed(hands, t);
  return { r, t };
}

// ---- A. geometry ---------------------------------------------------------------------------------
const R = 120;
check('A1 inside 40% of the radius is the centre', sectorAt(10, -20, R) === 'center' && sectorAt(0, 47, R) === 'center');
const dirOk = Object.entries(DIRS).every(([d, a]) => sectorAt(100 * Math.cos(a * Math.PI / 180), 100 * Math.sin(a * Math.PI / 180), R) === d);
check('A2 each slot centre maps to its own direction', dirOk);
check('A3 marking menu: direction wins, distance beyond the ring still picks', sectorAt(0, -900, R) === 'up' && sectorAt(600, 350, R) === 'downRight');
check('A4 boundaries split at ±30° from each centre', sectorAt(Math.cos(-61 * Math.PI / 180) * 90, Math.sin(-61 * Math.PI / 180) * 90, R) === 'up' && sectorAt(Math.cos(-59 * Math.PI / 180) * 90, Math.sin(-59 * Math.PI / 180) * 90, R) === 'upRight');

// ---- B. opening by ✌ through the hold gate ----------------------------------------------------------
const ran = [];
const items = [
  { dir: 'up', icon: '↶', label: 'Undo', run: () => ran.push('undo') },
  { dir: 'down', icon: '⟲', label: 'Reset view', run: () => ran.push('reset') },
  { dir: 'upRight', icon: '📏', label: 'Tape', run: () => ran.push('tape') },
  { dir: 'downRight', icon: '🔷', label: 'Lens', run: () => ran.push('lens'), enabled: () => lensOn },
  { dir: 'center', icon: '?', label: 'Help', run: () => ran.push('help') }
];
let lensOn = false;
const wheel = createToolWheel({ items });
const events = [];
wheel.on('open', (e) => events.push(['open', e]));
wheel.on('close', (e) => events.push(['close', e.why]));
wheel.on('pick', (e) => events.push(['pick', e.dir]));

let t = 1000;
let r = hold(wheel, [hand('Victory')], t, 300); t = r.t;
check('B1 a ✌ passed through for 300 ms does not open the wheel', !wheel.isOpen);
r = hold(wheel, [hand('Open_Palm')], t, 400); t = r.t;
wheel.point({ x: 400, y: 300 }, t);
r = hold(wheel, [hand('Victory')], t, 750); t = r.t;
check('B2 ✌ held ~650 ms opens it', wheel.isOpen && events.some((e) => e[0] === 'open'));
const box = wheel.el.getBoundingClientRect();
check('B3 it opens where the hand cursor was', Math.abs((box.left + box.right) / 2 - 400) < 3 && Math.abs((box.top + box.bottom) / 2 - 300) < 3, `${Math.round((box.left + box.right) / 2)},${Math.round((box.top + box.bottom) / 2)}`);
check('B4 a held ✌ does not re-fire (no instant close)', (() => { const x = hold(wheel, [hand('Victory')], t, 600); t = x.t; return wheel.isOpen; })());

// ---- C. aiming and picking ------------------------------------------------------------------------------
wheel.point({ x: 400, y: 300 - 80 }, t);
check('C1 aiming up lights Undo', wheel.lit === 'up' && wheel.el.querySelector('[data-dir="up"]').classList.contains('lit'));
wheel.point({ x: 400 + 70, y: 300 + 40 }, t + 10);
check('C2 a disabled slot never lights', wheel.lit === null);
wheel.point({ x: 400 + 70, y: 300 - 40 }, t + 20);
check('C3 aiming up-right lights Tape', wheel.lit === 'upRight');
const took = wheel.click();
check('C4 the other-hand pinch runs the lit slot and closes', took && ran.at(-1) === 'tape' && !wheel.isOpen && events.at(-1)[0] === 'pick');
check('C5 a click while closed is not taken', wheel.click() === false);

// ---- D. closing ---------------------------------------------------------------------------------------------
const reopen = () => { t += 2000; hold(wheel, [hand('Open_Palm')], t, 400); t += 433; wheel.point({ x: 500, y: 400 }, t); const x = hold(wheel, [hand('Victory')], t, 750); t = x.t; return wheel.isOpen; };
check('D0 reopens', reopen());
wheel.point({ x: 500, y: 400 }, t);
wheel.click();
check('D1 a pinch in the centre opens Help', ran.at(-1) === 'help' && !wheel.isOpen);
reopen();
hold(wheel, [hand('Open_Palm')], t, 400); t += 433;
const x = hold(wheel, [hand('Victory')], t, 750); t = x.t;
check('D2 ✌ again closes it (toggle)', !wheel.isOpen && events.at(-1)[1] === 'toggle');
reopen();
dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
check('D3 Esc closes it', !wheel.isOpen && events.at(-1)[1] === 'esc');
reopen();
wheel.point({ x: 500, y: 320 }, t);
for (let k = 33; k <= WHEEL.idleMs + 50; k += 500) wheel.feed([hand('Pointing_Up')], t + k);
wheel.point({ x: 500, y: 320 }, t + WHEEL.idleMs + 50);
check('D4 5 s with no new slot closes it', !wheel.isOpen && events.at(-1)[1] === 'idle');
t += WHEEL.idleMs + 100;
reopen();
wheel.feed([hand('Pointing_Up')], t + WHEEL.restMs + 100);
wheel.point(null, t + WHEEL.restMs + 200);
check('D5 no cursor while the ✌ hand turns into a pointer does NOT close it', wheel.isOpen);
wheel.feed([], t + WHEEL.restMs + 300);
wheel.point(null, t + 2 * WHEEL.restMs + 250);
check('D6 hands lowered (no raised hand) closes it', !wheel.isOpen && events.at(-1)[1] === 'rest');

// ---- E. mouse, keys, layout, photosafety ---------------------------------------------------------------------
lensOn = true;
wheel.open({ x: 300, y: 300 }, t);
wheel.el.querySelector('[data-dir="downRight"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
check('E1 a mouse click on a slot runs it (enabled() is read at open)', ran.at(-1) === 'lens' && !wheel.isOpen);
wheel.open({ x: 5, y: 5 }, t);
const b2 = wheel.el.getBoundingClientRect();
wheel.point(null, t + 60000);
check('E1b opened by W / mouse (no hands): no rest or idle timeout', wheel.isOpen);
check('E2 opened at a screen corner it stays fully on screen', b2.left >= 0 && b2.top >= 0 && b2.right <= innerWidth && b2.bottom <= innerHeight, `${Math.round(b2.left)},${Math.round(b2.top)}`);
wheel.close();
const cs = getComputedStyle(wheel.el);
const fade = parseFloat(cs.transitionDuration) * 1000;
const slotFade = parseFloat(getComputedStyle(wheel.el.querySelector('.tw-slot path')).transitionDuration) * 1000;
check('E3 photosafe: eased fades (wheel >= 120 ms, slot light >= 100 ms), no animation loops', fade >= 120 && slotFade >= 100 && cs.animationName === 'none', `${fade} / ${slotFade} ms`);
const slotW = (() => { const g = wheel.el.querySelector('[data-dir="up"]').getBoundingClientRect(); return Math.min(g.width, g.height); })();
check('E4 slots are big hand targets (>= 48 px each way)', slotW >= 48, `${Math.round(slotW)} px`);
check('E5 accessible: role=menu, slots are menuitems with labels', wheel.el.getAttribute('role') === 'menu' && wheel.el.querySelectorAll('[role="menuitem"][aria-label]').length === items.length);
wheel.dispose();
check('E6 dispose removes it', !document.querySelector('.tool-wheel'));

// ---- F. through the real hands runtime: ✌ opens, aim lights, other-hand pinch picks -----------------
{
  const THREE = await import('three');
  const { createHandsRuntime } = await import('./handsRuntime.js' + V);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px';
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas });
  renderer.setSize(640, 360, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.01, 100);
  camera.position.set(0, 0, 3);
  const picked = [], sceneClicks = [];
  const rt = createHandsRuntime({
    scene, camera, renderer, overlay: document.createElement('canvas'), video: document.createElement('video'),
    pickTargets: () => null, holdOn: () => null, handUI: true, cursorSpace: 'page',
    toolWheel: [
      { dir: 'up', icon: '↶', label: 'Undo', run: () => picked.push('undo') },
      { dir: 'down', icon: '⟲', label: 'Reset view', run: () => picked.push('reset') },
      { dir: 'center', icon: '?', label: 'Help', run: () => picked.push('help') }
    ]
  });
  rt.on('click', (c) => sceneClicks.push(c));
  rt.ui.setEnabled(true);
  const reach = rt.pointer.profile.reach;
  const palmFor = (px) => {
    const nx = (px.x / innerWidth) * 2 - 1, ny = 1 - (px.y / innerHeight) * 2;
    return { x: reach.x0 + ((1 - nx) * (reach.x1 - reach.x0)) / 2, y: reach.y0 + ((1 - ny) * (reach.y1 - reach.y0)) / 2 };
  };
  const rhand = (c, { gun = false, pinching = false, gesture = 'None', handedness = 'Right' } = {}) => {
    const lm = Array.from({ length: 21 }, () => ({ x: c.x, y: c.y, z: 0 }));
    lm[0] = { x: c.x, y: c.y + 0.06, z: 0 }; lm[9] = { x: c.x, y: c.y - 0.06, z: 0 };
    lm[5] = { x: c.x + 0.03, y: c.y, z: 0 }; lm[17] = { x: c.x - 0.03, y: c.y, z: 0 };
    return { gesture, score: 0.95, handedness, landmarks: lm, pinch: { pinching, ratio: pinching ? 0.1 : 0.7 }, pointer: { gun, rejectedBy: gun ? null : 'label' }, fistLike: false };
  };
  const OTHER = { x: 0.15, y: 0.5 };
  let tt = 900000;
  const frames = (ms, make) => { for (let k = 0; k < Math.round(ms / 33); k++) { tt += 33; rt.injectFrame(make(), { t: tt }); } };
  const spot = { x: 700, y: 450 };
  frames(600, () => [rhand(palmFor(spot), { gun: true }), rhand(OTHER, { handedness: 'Left' })]);
  frames(900, () => [rhand(palmFor(spot), { gesture: 'Victory' }), rhand(OTHER, { handedness: 'Left' })]);
  check('F1 runtime: ✌ held opens the wheel at the last hand cursor', rt.wheel?.isOpen === true);
  const up = { x: spot.x, y: spot.y - 90 };
  frames(500, () => [rhand(palmFor(up), { gun: true }), rhand(OTHER, { handedness: 'Left' })]);
  check('F2 runtime: aiming up lights Undo', rt.wheel.lit === 'up', String(rt.wheel.lit));
  frames(150, () => [rhand(palmFor(up), { gun: true }), rhand(OTHER, { handedness: 'Left', pinching: true })]);
  frames(200, () => [rhand(palmFor(up), { gun: true }), rhand(OTHER, { handedness: 'Left' })]);
  check('F3 runtime: the other-hand pinch runs Undo and closes; no scene click', picked.join() === 'undo' && !rt.wheel.isOpen && sceneClicks.length === 0, `${picked.join()} scene=${sceneClicks.length}`);
  rt.dispose();
  canvas.remove();
}

check('0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
const failed = results.filter((x2) => !x2.ok).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
window.toolWheelResults = { passed: results.length - failed, failed, results };

// Library ring checks (platform/ring.js), in a bare three scene with 20 fake projects.
//
//   A. List = source of truth: listbox roles, aria-activedescendant follows every move, the
//      3D ring settles on the list's active item; card labels read as a sentence.
//   B. Keyboard: arrows (wrap-around), up/down versions (working copy on top), Enter chooses,
//      Esc / L close and open, keys never reach the workbench's shortcuts while open.
//   C. Pointer: clicking a side card brings it to the centre, clicking the centre chooses.
//   D. Actions: fork, rename, restore, '__new__', sample Hide; Delete needs the press-and-hold.
//   E. Photosafety: a simulated fast drag and wheel spam never move the ring faster than
//      3 cards/s past the centre; the open fade takes >= 150 ms; reduced motion jumps.
//   F. Filter chips only above 12 projects; "All" is a searchable grid; without a 3D scene the
//      grid alone works from the keyboard.
//   G. dispose() leaves no listeners, meshes, geometries or textures behind.

import * as THREE from 'three';

const V = new URL(import.meta.url).search;

// Count every listener added/removed from here on (before ring.js is even imported), keyed by
// target + type + function + capture, so dispose() can be checked for leftovers. Image
// elements are three's TextureLoader internals and clean themselves up on load.
const liveListeners = new Map();
const keyOf = (t, type, fn, opts) => [t, type, fn, !!(typeof opts === 'boolean' ? opts : opts?.capture)];
const sameKey = (a, b) => a.every((x, i) => x === b[i]);
const origAdd = EventTarget.prototype.addEventListener, origRemove = EventTarget.prototype.removeEventListener;
let recording = false;
EventTarget.prototype.addEventListener = function (type, fn, opts) {
  if (recording && !(this instanceof HTMLImageElement)) {
    const k = keyOf(this, type, fn, opts);
    if (![...liveListeners.values()].some((x) => sameKey(x, k))) liveListeners.set(Symbol(), k);
  }
  return origAdd.call(this, type, fn, opts);
};
EventTarget.prototype.removeEventListener = function (type, fn, opts) {
  const k = keyOf(this, type, fn, opts);
  for (const [s, x] of liveListeners) if (sameKey(x, k)) liveListeners.delete(s);
  return origRemove.call(this, type, fn, opts);
};

const { createRing, MAX_CARDS_PER_S, NEW_ID, describeCard } = await import('./ring.js' + V);

// The ring's CSS lives in index.html; read it from there so this page can't drift from it.
{
  const html = await (await fetch('./index.html')).text();
  const a = html.indexOf('/* ---- library ring (ring.js)'), b = html.indexOf('/* ---- narrow screens');
  const style = document.createElement('style');
  style.textContent = a >= 0 && b > a ? html.slice(a, b) : '';
  document.head.append(style);
}

const out = document.getElementById('out');
out.textContent = '';
const log = (s) => { out.textContent += s + '\n'; };
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a bare scene --------------------------------------------------------------------------
const stage = document.getElementById('stage');
const root = document.getElementById('libraryRing');
const list = document.getElementById('libraryList');
const btn = document.getElementById('libraryBtn');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
const camera = new THREE.PerspectiveCamera(45, 800 / 450, 0.01, 100);
camera.position.set(0, 0.4, 2);
camera.lookAt(0, 0.2, 0);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
stage.prepend(renderer.domElement);
const fit = () => { const r = stage.getBoundingClientRect(); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; camera.updateProjectionMatrix(); };
fit();
// A "workbench" to dim behind the ring.
const bench = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.4, 0.4), new THREE.MeshBasicMaterial({ color: 0x2f8fb0, wireframe: true }));
bench.position.y = 0.2;
scene.add(bench);
const controls = { enabled: true, autoRotate: true };

// ---- fake projects with generated thumbnails ------------------------------------------------
function thumb(i) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = `hsl(${(i * 47) % 360} 35% 22%)`; g.fillRect(0, 0, 128, 96);
  g.strokeStyle = 'rgba(214,251,255,.6)'; g.lineWidth = 2;
  g.strokeRect(34, 22, 60, 52);
  g.fillStyle = 'rgba(214,251,255,.85)'; g.font = '20px monospace'; g.fillText(String(i + 1), 52, 56);
  return c.toDataURL('image/png');
}
const DAY = 86400000, T0 = Date.UTC(2026, 8, 30);
function makeCards(n) {
  const cards = [];
  for (let i = 0; i < n; i++) {
    const nv = 1 + (i % 4);
    const versions = [];
    for (let j = 0; j < nv; j++) {
      const working = j === nv - 1;
      versions.push({ id: `p${i}-v${j}`, label: working ? 'Working copy' : `Saved ${j + 1}`, type: working ? 'working' : j === 0 ? 'original' : 'edited', date: T0 - (n - i) * DAY + j * 3600e3, thumbUrl: null, badges: [] });
    }
    const sample = i < 3;
    cards.push({
      id: `p${i}`, title: sample ? `Sample chair ${i + 1}` : `${i % 3 === 0 ? 'Room' : 'Chair'} ${i + 1}`,
      subtitle: `edited ${new Date(T0 - (n - i) * DAY).getUTCDate()} Sep`,
      badges: [sample ? 'sample' : 'scanned', ...(i % 5 === 1 ? ['completed · 12% inferred'] : []), ...(i % 4 === 2 ? ['hand-edited · 3 edits'] : [])],
      kind: i % 3 === 0 ? 'room' : 'object',
      thumbUrl: i % 6 === 5 ? null : thumb(i), sample,
      versions, currentVersionId: versions[versions.length - 1].id,
    });
  }
  cards.push({ id: NEW_ID, title: 'Drop your own scan', subtitle: 'GLB, OBJ, PLY or a photo', badges: [], thumbUrl: null, sample: false, versions: [], currentVersionId: null });
  return cards;
}
const CARDS = makeCards(20);

// ---- helpers -------------------------------------------------------------------------------
const FRAME = 1000 / 60;
let ring = null;
function frames(n, dt = FRAME) { for (let i = 0; i < n; i++) { ring.update(dt); } renderer.render(scene, camera); }
function key(k, target = document.activeElement || document.body, extra = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(e);
  target.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...extra }));
  return e;
}
function pointer(type, el, x, y, extra = {}) {
  el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, ...extra }));
}
const events = [];
const st = () => ring._state();
const activeOpt = () => list.querySelector('[aria-selected="true"]');
const surface = () => root.querySelector('.lr-surface');
const settle = () => frames(240);
const idxOf = (id) => st().shown.indexOf(id);

// =============================================================================================
recording = true;
renderer.render(scene, camera);
const baseChildren = scene.children.length;
const baseGeo = renderer.info.memory.geometries, baseTex = renderer.info.memory.textures;
ring = createRing({ THREE, scene, camera, renderer, controls, root, list, reducedMotion: false });
for (const ev of ['choose', 'action', 'close']) ring.on(ev, (d) => events.push({ ev, ...d }));
ring.setProjects(CARDS);
await wait(50);   // data-URL thumbnails decode

// ---- A. list is the source of truth -----------------------------------------------------------
{
  const opts = list.querySelectorAll('[role=option]');
  check('listbox has one option per card (20 + "Drop your own scan")', list.getAttribute('role') === 'listbox' && opts.length === 21, `${opts.length} options`);
  check('aria-activedescendant starts on the first option', list.getAttribute('aria-activedescendant') === opts[0].id && opts[0].getAttribute('aria-selected') === 'true');
  const label = describeCard(CARDS[11]);
  check('card label reads as a sentence: title, edited date, versions, % inferred',
    /^Chair 12, edited \d+ Sep, 4 versions, scanned, completed, 12% inferred$/.test(label), JSON.stringify(label));
  check('the option carries that sentence as its accessible name', list.querySelector('[data-id="p11"]')?.getAttribute('aria-label') === label);
}

// ---- open ---------------------------------------------------------------------------------------
ring.open();
{
  check('open: overlay shown, orbit controls and auto-rotate off, list focused',
    !root.hidden && ring.isOpen() && controls.enabled === false && controls.autoRotate === false && document.activeElement === list);
  let n = 0;
  while (st().presence < 1 && n < 100) { ring.update(FRAME); n++; }
  check('open fade is eased over >= 150 ms (one smooth change, not a flash)', n * FRAME >= 150, `${(n * FRAME).toFixed(0)} ms to full`);
  frames(5);
  const ringMeshes = scene.getObjectByName('libraryRing');
  check('ring lives in the page scene (one WebGL context), drawn only while open', !!ringMeshes && ringMeshes.visible);
}

// ---- B. keyboard ------------------------------------------------------------------------------
{
  key('ArrowRight', list);
  const opt1 = list.querySelector('#lr-opt-1');
  check('→ moves the list: aria-activedescendant + aria-selected on option 2',
    list.getAttribute('aria-activedescendant') === opt1.id && activeOpt() === opt1 && st().active === 1);
  settle();
  const centre = st().rects.find((r) => Math.abs(r.off) < 0.01);
  check('the 3D ring mirrors the list: centre card = active item after the glide', centre?.idx === 1 && Math.abs(st().pos - 1) < 1e-6, `centre idx ${centre?.idx}, pos ${st().pos.toFixed(3)}`);
  key('Home', list); settle();
  key('ArrowLeft', list); settle();
  const n = st().shown.length;
  check('← from the first card wraps to the last', st().active === n - 1 && activeOpt()?.dataset.index === String(n - 1), `active ${st().active} of ${n}`);
  key('ArrowRight', list); settle();
  check('→ from the last card wraps to the first', st().active === 0);
  const leftCentre = st().rects.find((r) => Math.abs(r.off) < 0.01);
  check('wrapped ring still centres the active card', leftCentre?.idx === 0);

  // versions: a project with 4 versions
  ring.focus('p3'); settle();
  const chips = () => [...root.querySelectorAll('.lr-vchip')];
  check('versions column: working copy on top, newest saved next', chips()[0]?.textContent.startsWith('Working copy') && chips().length === 4 && chips()[0].getAttribute('aria-pressed') === 'true',
    chips().map((c) => c.textContent).join(' | '));
  key('ArrowDown', list);
  check('↓ selects the next version (chip + state)', st().versionIdx === 1 && chips()[1].getAttribute('aria-pressed') === 'true');
  key('ArrowDown', list); key('ArrowDown', list); key('ArrowDown', list);
  check('↓ stops at the oldest version (no wrap vertically)', st().versionIdx === 3);
  key('ArrowUp', list); key('ArrowUp', list); key('ArrowUp', list); key('ArrowUp', list);
  check('↑ returns to the working copy and stops there', st().versionIdx === 0);
  key('ArrowDown', list);
  events.length = 0;
  key('Enter', list);
  const ch = events.find((e) => e.ev === 'choose');
  check('Enter emits choose {projectId, versionId} for the selected version', ch?.projectId === 'p3' && ch?.versionId === 'p3-v2', JSON.stringify(ch));
  check('choosing closes the ring without a "close" event, controls restored',
    !ring.isOpen() && root.hidden && !events.some((e) => e.ev === 'close') && controls.enabled === true && controls.autoRotate === true);
  frames(30);
  check('after the fade-out nothing is drawn', scene.getObjectByName('libraryRing').visible === false && st().presence === 0);

  // L / Esc
  events.length = 0;
  document.body.focus();
  key('l', document.body);
  check('L opens the ring', ring.isOpen());
  key('Escape', list);
  check('Esc closes it and emits "close" once', !ring.isOpen() && events.filter((e) => e.ev === 'close').length === 1);
  key('L', document.body);
  key('l', list);
  check('L toggles closed again (with "close")', !ring.isOpen() && events.filter((e) => e.ev === 'close').length === 2);
  const outside = document.getElementById('outsideInput');
  outside.focus();
  key('l', outside);
  check('L typed into a text field does not open the ring', !ring.isOpen());
  btn.click();
  check('#libraryBtn toggles it open (aria-expanded true)', ring.isOpen() && btn.getAttribute('aria-expanded') === 'true');

  // scene shortcuts are blocked while open
  let reached = 0;
  const spy = (e) => { if (['Tab', 'Delete', 'h', 'r', 'i', '?', 'z'].includes(e.key)) reached++; };
  window.addEventListener('keydown', spy);
  for (const k of ['Tab', 'Delete', 'h', 'r', 'i', '?']) key(k, list);
  key('z', list, { ctrlKey: true });
  const whileOpen = reached;
  ring.close();
  reached = 0;
  for (const k of ['Tab', 'Delete', 'h', 'r', 'i', '?']) key(k, document.body);
  window.removeEventListener('keydown', spy);
  check('while open, Tab/Del/H/R/I/?/Ctrl+Z never reach the workbench shortcuts; closed, they do', whileOpen === 0 && reached === 6, `open: ${whileOpen} reached, closed: ${reached}`);
  ring.open(); frames(20);
}

// ---- C. pointer --------------------------------------------------------------------------------
{
  ring.focus('p0'); settle();
  const side = st().rects.find((r) => Math.round(r.off) === 2);
  const r0 = root.getBoundingClientRect();
  const cx = r0.left + (side.l + side.r) / 2, cy = r0.top + (side.t + side.b) / 2;
  pointer('pointerdown', surface(), cx, cy); pointer('pointerup', surface(), cx, cy);
  check('click on a side card brings it to the centre (list follows)', st().active === side.idx && list.getAttribute('aria-activedescendant') === `lr-opt-${side.idx}`, `clicked idx ${side.idx}`);
  settle();
  const c = st().rects.find((r) => Math.abs(r.off) < 0.01);
  events.length = 0;
  const x = r0.left + (c.l + c.r) / 2, y = r0.top + (c.t + c.b) / 2;
  pointer('pointerdown', surface(), x, y); pointer('pointerup', surface(), x, y);
  check('click on the centre card chooses it', events.some((e) => e.ev === 'choose' && e.projectId === st().shown[c.idx]));
  ring.open(); frames(20);
  // drag: 1.2 cards to the left and release -> snaps to a whole card
  ring.focus('p5'); settle();
  const before = st().active;
  const ppc = st().pxPerCard;
  pointer('pointerdown', surface(), 400, 200);
  for (let i = 1; i <= 6; i++) { pointer('pointermove', surface(), 400 - i * ppc * 0.2, 200); frames(3); }
  pointer('pointerup', surface(), 400 - 1.2 * ppc, 200);
  settle();
  check('drag spins and snaps to the nearest card', Number.isInteger(st().pos) && st().active !== before && st().pos === st().target, `active ${before} -> ${st().active}, pos ${st().pos}`);
}

// ---- D. actions -------------------------------------------------------------------------------
{
  const more = { click() { if (root.querySelector('.lr-actions').hidden) root.querySelector('.lr-more').click(); } };
  const btnText = (t) => [...root.querySelectorAll('.lr-actions button')].find((b) => b.textContent.includes(t));
  ring.focus('p4'); settle();
  more.click();
  check('"…" opens the action row: Fork, Rename, Hold to delete', !root.querySelector('.lr-actions').hidden && !btnText('Fork').hidden && !btnText('Rename').hidden && !btnText('Hold to delete').hidden && btnText('Hide').hidden);
  events.length = 0;
  btnText('Fork').click();
  check('Fork emits {type:fork, projectId, versionId}', events[0]?.type === 'fork' && events[0].projectId === 'p4' && events[0].versionId === 'p4-v0', JSON.stringify(events[0]));
  events.length = 0;
  btnText('Rename').click();
  const input = root.querySelector('.lr-rename input');
  check('Rename shows an inline input with the current name, focused', document.activeElement === input && input.value === CARDS[4].title);
  input.value = '  Desk corner  ';
  key('Enter', input);
  check('Enter in the rename input emits {type:rename, title} (trimmed)', events[0]?.type === 'rename' && events[0].title === 'Desk corner' && events[0].projectId === 'p4', JSON.stringify(events[0]));

  // delete: a quick click does nothing; a hold fires once
  more.click();
  const del = btnText('Hold to delete');
  events.length = 0;
  pointer('pointerdown', del, 0, 0); await wait(120); pointer('pointerup', del, 0, 0); del.click();
  await wait(700);
  check('Delete: a quick click (120 ms) does nothing', events.length === 0, `${events.length} events`);
  pointer('pointerdown', del, 0, 0);
  await wait(400);
  const midRing = Number(root.querySelector('.lr-hold-fill').getAttribute('stroke-dashoffset'));
  await wait(500);
  pointer('pointerup', del, 0, 0);
  const dels = events.filter((e) => e.type === 'delete');
  check('Delete: press and hold ~650 ms emits exactly one delete (whole project: versionId null)', dels.length === 1 && dels[0].projectId === 'p4' && dels[0].versionId === null, JSON.stringify(dels));
  // The ring is drawn on animation frames, which a hidden tab doesn't get; the confirm itself
  // is a timer and is checked above either way.
  if (document.visibilityState === 'visible') check('the hold ring was filling part-way at 400 ms', midRing > 0 && midRing < 47.1, `dashoffset ${midRing.toFixed(1)} of 47.1`);
  else log('SKIP  the hold ring was filling part-way at 400 ms   (tab hidden: no animation frames to draw it)');
  // keyboard hold (Space held on the button)
  events.length = 0;
  del.focus();
  del.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
  await wait(900);
  del.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
  check('Delete: Space held on the button also confirms (keyboard users)', events.filter((e) => e.type === 'delete').length === 1);

  // a saved version selected: Delete is still the whole project (the store has no per-version delete)
  ring.focus('p3', 'p3-v1'); settle();
  more.click();
  check('a saved version selected: no Restore, Delete stays project-level', btnText('Restore').hidden && !btnText('Hold to delete').hidden && !btnText('delete version'));
  // a deleted project: Restore only
  ring.setProjects(CARDS.map((c) => (c.id === 'p8' ? { ...c, deleted: true, badges: [...c.badges, 'deleted'] } : c)));
  check('deleted projects sort last under Recent (just before the new card here)', st().shown.at(-2) === 'p8', st().shown.slice(-3).join(','));
  ring.focus('p8'); settle();
  more.click();
  check('a deleted project shows Restore, and no Fork / Delete / Hide', !btnText('Restore').hidden && btnText('Fork').hidden && btnText('Hold to delete').hidden && btnText('Hide').hidden);
  events.length = 0;
  btnText('Restore').click();
  check('Restore emits {type:restore, projectId, versionId:null}', events[0]?.type === 'restore' && events[0].projectId === 'p8' && events[0].versionId === null, JSON.stringify(events[0]));
  ring.setProjects(CARDS);

  // samples: Hide instead of Delete
  ring.focus('p1'); settle();
  more.click();
  check('sample card shows Hide, not Delete', !btnText('Hide').hidden && btnText('Hold to delete').hidden);
  events.length = 0;
  btnText('Hide').click();
  check('Hide emits {type:delete, sample:true} on a plain click', events[0]?.type === 'delete' && events[0].sample === true && events[0].projectId === 'p1');

  // "Drop your own scan"
  ring.focus(NEW_ID); settle();
  events.length = 0;
  key('Enter', list);
  check('"Drop your own scan" (__new__) emits {type:new}, not choose, and has no "…"', events.length === 1 && events[0].ev === 'action' && events[0].type === 'new' && root.querySelector('.lr-more').hidden);
  await wait(550);   // past the double-choose guard
}

// ---- E. photosafety: speed cap -----------------------------------------------------------------
function maxCrossingsPerSecond(trace) {
  const cross = [];
  for (let i = 1; i < trace.length; i++) if (Math.round(trace[i].pos) !== Math.round(trace[i - 1].pos)) cross.push(trace[i].t);
  let worst = 0;
  for (let i = 0; i < cross.length; i++) { let j = i; while (j < cross.length && cross[j] - cross[i] < 1000) j++; worst = Math.max(worst, j - i); }
  return { worst, total: cross.length };
}
function maxSpeed(trace) {
  let m = 0;
  for (let i = 1; i < trace.length; i++) m = Math.max(m, Math.abs(trace[i].pos - trace[i - 1].pos) / ((trace[i].t - trace[i - 1].t) / 1000));
  return m;
}
{
  ring.focus('p0'); settle();
  // A violent fling: 40 cards' worth of pointer travel in 10 frames, then release.
  const trace = [];
  let t = 0;
  const rec = () => trace.push({ t, pos: st().pos });
  rec();
  pointer('pointerdown', surface(), 700, 200);
  for (let i = 1; i <= 10; i++) {
    pointer('pointermove', surface(), 700 - i * st().pxPerCard * 4, 200);
    ring.update(FRAME); t += FRAME; rec();
  }
  pointer('pointerup', surface(), 700 - 40 * st().pxPerCard, 200);
  for (let i = 0; i < 360; i++) { ring.update(FRAME); t += FRAME; rec(); }
  const s = maxSpeed(trace), c = maxCrossingsPerSecond(trace);
  check('fast drag: ring speed never exceeds the cap', s <= MAX_CARDS_PER_S + 1e-6, `max ${s.toFixed(2)} cards/s (cap ${MAX_CARDS_PER_S})`);
  check('fast drag: <= 3 cards pass the centre in any 1 s', c.worst <= 3, `worst 1 s window ${c.worst}, ${c.total} crossings total`);
  check('fast drag: ends at rest on a whole card, list in sync', Number.isInteger(st().pos) && st().active === ((st().pos % st().shown.length) + st().shown.length) % st().shown.length);

  // Wheel spam: 40 notches in one frame.
  const trace2 = []; t = 0;
  for (let i = 0; i < 40; i++) surface().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
  check('wheel spam: the ring is never asked to run more than 2 cards ahead', st().target - st().pos <= 2 + 1e-9, `target - pos = ${(st().target - st().pos).toFixed(2)}`);
  for (let i = 0; i < 240; i++) { ring.update(FRAME); t += FRAME; trace2.push({ t, pos: st().pos }); }
  const c2 = maxCrossingsPerSecond(trace2);
  check('wheel spam: <= 3 cards pass the centre in any 1 s', c2.worst <= 3 && maxSpeed(trace2) <= MAX_CARDS_PER_S + 1e-6, `worst window ${c2.worst}, max ${maxSpeed(trace2).toFixed(2)} cards/s`);

  // Held arrow key (key repeat at ~30/s for 2 s).
  const trace3 = []; t = 0;
  for (let i = 0; i < 120; i++) { if (i % 2 === 0) key('ArrowRight', list, { repeat: i > 0 }); ring.update(FRAME); t += FRAME; trace3.push({ t, pos: st().pos }); }
  const c3 = maxCrossingsPerSecond(trace3);
  check('held arrow key: <= 3 cards pass the centre in any 1 s', c3.worst <= 3, `worst window ${c3.worst}`);
  // a single step is an eased glide of >= 150 ms
  settle();
  let n = 0;
  key('ArrowRight', list);
  while (st().pos !== st().target && n < 200) { ring.update(FRAME); n++; }
  check('one step is an eased glide of >= 150 ms', n * FRAME >= 150, `${(n * FRAME).toFixed(0)} ms`);
}

// ---- F. filters / grid -------------------------------------------------------------------------
{
  const chipsEl = root.querySelector('.lr-chips');
  check('filter chips shown with 20 projects (> 12)', !chipsEl.hidden);
  ring.setProjects(makeCards(10));
  check('filter chips hidden with 10 projects (<= 12)', chipsEl.hidden);
  ring.setProjects(CARDS);
  const chip = (k) => root.querySelector(`[data-filter="${k}"]`);
  chip('samples').click();
  check('Samples chip: only samples (+ the new card)', st().shown.length === 4 && st().shown.slice(0, 3).every((id) => ['p0', 'p1', 'p2'].includes(id)), st().shown.join(','));
  chip('rooms').click();
  check('Rooms chip: only rooms', st().shown.filter((id) => id !== NEW_ID).every((id) => Number(id.slice(1)) % 3 === 0));
  chip('recent').click();
  check('Recent: most recently edited first', st().shown[0] === 'p19', st().shown.slice(0, 3).join(','));
  chip('all').click();
  const search = root.querySelector('.lr-search');
  check('All switches to a grid with a search box and thumbnails', st().view === 'grid' && list.classList.contains('grid') && !search.hidden && list.querySelectorAll('img.lr-thumb').length > 0);
  search.value = 'room 1';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  check('search filters the grid', st().shown.length >= 1 && st().shown.every((id) => /^Room 1/.test(CARDS.find((c) => c.id === id).title)), st().shown.join(','));
  search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
  list.focus();
  const before = st().active;
  key('ArrowRight', list);
  const want = st().shown[st().active];
  events.length = 0;
  key('Enter', list);
  check('grid: keyboard still moves and chooses', st().active === before + 1 && events.some((e) => e.ev === 'choose' && e.projectId === want), `${before} -> ${st().active}, chose ${events[0]?.projectId}`);
  ring.open();
  chip('recent').click();
  check('leaving All returns to the 3D ring', st().view === 'ring' && !list.classList.contains('grid'));
}

// ---- BUGS #39: a refresh mid-glide must not skip the glide -------------------------------------
{
  // The app calls setProjects whenever the library changes (sample thumbnails arriving on the
  // first visit, a rename): rebuild() used to jump pos to the target, passing up to 2 cards in
  // one frame, so a few refreshes during a fling broke the 3 cards/s cap.
  ring.focus('p0'); settle();
  const n = st().shown.length;
  const trace = []; let t = 0;
  const rec = () => trace.push({ t, pos: st().pos });
  rec();
  for (let f = 0; f < 4; f++) {
    for (let i = 0; i < 3; i++) key('ArrowRight', list);
    for (let i = 0; i < 6; i++) { ring.update(FRAME); t += FRAME; rec(); }
    ring.setProjects(CARDS.map((c) => ({ ...c })));
    for (let i = 0; i < 20; i++) { ring.update(FRAME); t += FRAME; rec(); }
  }
  for (let i = 0; i < 300; i++) { ring.update(FRAME); t += FRAME; rec(); }
  // Centre-card changes, counted on the wrapped index (the unwrapped position may renumber).
  const wrapped = trace.map((x) => ({ t: x.t, pos: ((Math.round(x.pos) % n) + n) % n }));
  let maxStep = 0;
  for (let i = 1; i < wrapped.length; i++) { const d = Math.abs(wrapped[i].pos - wrapped[i - 1].pos); maxStep = Math.max(maxStep, Math.min(d, n - d)); }
  const c = maxCrossingsPerSecond(wrapped);
  check('#39 refreshes during a fling: <= 3 cards pass the centre in any 1 s, never 2 in one frame', c.worst <= 3 && maxStep <= 1,
    `worst 1 s window ${c.worst}, most cards in one frame ${maxStep}`);
}

// ---- BUGS #40: a long title must not push the actions button off the panel ---------------------
{
  const long = CARDS.map((c) => (c.id === 'p7' ? { ...c, title: 'A very long project title with many words '.repeat(3).trim() } : c));
  ring.setProjects(long);
  ring.focus('p7'); settle();
  const panel = root.querySelector('.lr-panel').getBoundingClientRect();
  const more = root.querySelector('.lr-more').getBoundingClientRect();
  check('#40 long title: ellipsised, the actions button stays inside the panel', more.right <= panel.right + 1 && more.left >= panel.left - 1 && more.width > 0,
    `panel ${Math.round(panel.left)}-${Math.round(panel.right)}, button ${Math.round(more.left)}-${Math.round(more.right)}`);
  ring.setProjects(CARDS.map((c) => ({ ...c })));
}

// ---- thumbnails -------------------------------------------------------------------------------
{
  ring.focus('p0'); settle();
  await wait(150); frames(2);   // thumbnails requested by the first layout finish decoding
  const faces = scene.getObjectByName('libraryRing').children.filter((m) => m.visible && m.material.map);
  const withImg = faces.filter((m) => m.material.map.image instanceof HTMLImageElement);
  const placeholder = faces.filter((m) => m.material.map.image instanceof HTMLCanvasElement);
  check('cards show their thumbnails; null thumbUrl gets the calm placeholder', withImg.length >= 4 && placeholder.length >= 1, `${withImg.length} thumbnails, ${placeholder.length} placeholders`);
  check('7 cards drawn (centre + 3 each side)', st().rects.length === 7, `${st().rects.length}`);
}

// ---- setProjects / focus keep their place ------------------------------------------------------
{
  ring.focus('p7', 'p7-v1');
  ring.setProjects(CARDS.map((c) => ({ ...c })));
  check('setProjects keeps the active project and version', st().shown[st().active] === 'p7' && root.querySelector('.lr-vchip[aria-pressed="true"]')?.textContent.startsWith('Saved 2'));
  ring.focus('nope');
  check('focus() with an unknown id is ignored', st().shown[st().active] === 'p7');
}

// ---- G. dispose -------------------------------------------------------------------------------
{
  ring.close();
  ring.dispose();
  recording = false;
  renderer.render(scene, camera);
  const left = [...liveListeners.values()];
  check('dispose: no listeners left on window, document, list, button or anything else', left.length === 0, left.map(([t, type]) => `${t.constructor.name}:${type}`).join(', ') || '0 left');
  check('dispose: ring meshes removed from the scene', scene.children.length === baseChildren && !scene.getObjectByName('libraryRing'));
  check('dispose: geometries and textures released', renderer.info.memory.geometries === baseGeo && renderer.info.memory.textures === baseTex,
    `geometries ${renderer.info.memory.geometries}/${baseGeo}, textures ${renderer.info.memory.textures}/${baseTex}`);
  check('dispose: overlay emptied (the caller\'s #libraryList stays) and hidden', root.children.length === 1 && root.firstElementChild === list && root.hidden && list.children.length === 0);
}

// ---- reduced motion ------------------------------------------------------------------------------
{
  ring = createRing({ THREE, scene, camera, renderer, controls, root, list, reducedMotion: true, button: null });
  ring.setProjects(CARDS);
  ring.open();
  ring.update(FRAME);
  check('reduced motion: the dim appears without a fade', st().presence === 1);
  key('ArrowRight', list);
  ring.update(FRAME);
  check('reduced motion: a step is a jump (no glide)', st().pos === 1);
  key('ArrowRight', list);
  ring.update(FRAME);
  const afterSecond = st().pos;
  frames(30);
  check('reduced motion: jumps are still capped (one card per >= 357 ms)', afterSecond === 1 && st().pos === 2, `immediately ${afterSecond}, after 0.5 s ${st().pos}`);
  check('reduced motion: positions are only ever whole cards', Number.isInteger(st().pos));
  ring.dispose();
}

// ---- no 3D (WebGL trouble): the list alone ------------------------------------------------------
{
  ring = createRing({ THREE: null, scene: null, camera: null, renderer: null, controls, root, list, button: null });
  const ev = [];
  ring.on('choose', (d) => ev.push(d));
  ring.setProjects(CARDS);
  ring.open();
  ring.update(FRAME);   // must be harmless without a scene
  key('ArrowLeft', list);   // wraps to the last card ("Drop your own scan")
  key('ArrowLeft', list);   // the oldest project
  const id = st().shown[st().active];
  const card = CARDS.find((c) => c.id === id);
  key('ArrowDown', list);
  key('Enter', list);
  const want = [...card.versions].reverse()[1]?.id;
  check('without a 3D scene: grid view, arrows wrap, versions and Enter work from the keyboard',
    list.classList.contains('grid') && ev.length === 1 && ev[0].projectId === id && st().shown[0] === 'p19' && (card.versions.length < 2 || ev[0].versionId === want),
    JSON.stringify(ev[0]));
  ring.dispose();
}

const failed = results.filter((r) => !r.ok).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
window.ringResults = { passed: results.length - failed, failed, results };

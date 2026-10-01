// Library ring: the console-menu-style (XMB) selector for saved workbench scenes. The design
// is Ricky's report docs/team-log/reports/2026-09-30-library-ring-selector.md; the owner's
// decisions (2026-10-01): a card is a whole workbench scene, versions stack under their
// project (autosaved working copy on top), and the ring is the landing screen.
//
// Two views of ONE state:
//   - #libraryList, a page listbox (role=listbox + aria-activedescendant). It is the source
//     of truth: every key, click, drag or wheel changes the list's active item, and
//     everything else mirrors it. With the 3D ring unavailable (no scene / WebGL trouble) or
//     in the "All" grid, the list alone is fully usable from the keyboard.
//   - the 3D ring: up to 7 camera-facing thumbnail cards (centre + 3 each side) on an arc in
//     front of the workbench, in the page's existing scene and WebGL context. Titles, badges
//     and buttons are HTML on the page layer, never 3D text. Nothing is drawn or ticked
//     while the ring is closed.
//
// Axes: left/right (keys, drag, wheel, swipe) = projects, wrapping around; up/down = the
// centre project's versions (a short column of chips, working copy on top).
//
// PHOTOSAFETY (BUGS.md #14, WCAG 2.3.1). The ring never flashes: outlines are steady, the
// open/close dim is a single eased fade (>= 150 ms), and the ring's displayed position moves
// at most MAX_CARDS_PER_S, so no more than 3 cards pass the centre in any second however hard
// it is flung. Under prefers-reduced-motion cards jump card by card (no glide) at that same
// capped rate, and the dim switches without a fade.
//
// CONTRACT (consumed by main.js)
//   const ring = createRing({ THREE, scene, camera, renderer, controls, root, list, ...opts })
//     root      the overlay element (#libraryRing); ring.js fills it, and shows/hides it.
//     list      the listbox element (#libraryList), inside root.
//     scene     may be null: then there is no 3D ring and the list shows as the grid.
//     controls  OrbitControls (or anything with .enabled/.autoRotate); disabled while open,
//               restored to their previous values on close.
//     opts      reducedMotion?: bool (default: the OS setting, live), button?: Element
//               (default #libraryBtn), keys?: bool (default true; the L / Esc / arrows
//               handling on window).
//   ring.setProjects(cards)   cards: [{ id, title, subtitle, badges:[string], thumbUrl|null,
//                             sample:bool, kind?:'room'|'object', versions:[{ id, label,
//                             type:'original'|'completed'|'edited'|'imported'|'working',
//                             date:number(ms), thumbUrl|null, badges:[string] }],
//                             currentVersionId, deleted?:bool }]
//                             The special id '__new__' is the "Drop your own scan" card;
//                             ring.js does not add it, the caller includes it where it wants it.
//                             Keeps the active project (and version) when it is still there.
//   ring.open() / close() / toggle() / isOpen()
//   ring.focus(projectId, versionId?)   make it the active card (glides if open, jumps if not)
//   ring.update(dtMs)          call every frame; a no-op (and nothing drawn) while closed
//   ring.on(event, cb)         returns an unsubscribe function. Events:
//     'choose' {projectId, versionId}   Enter / click or double-click the centre card. The ring
//                                       closes itself afterwards WITHOUT a 'close' event.
//     'action' {type, projectId, versionId, title?, sample?}
//         'new'     the '__new__' card was chosen (open the file picker)
//         'fork'    versionId = the selected version
//         'rename'  title = the new name (trimmed, non-empty); versionId null
//         'restore' un-delete a soft-deleted / hidden project (shown only on cards with
//                   deleted:true or a 'deleted' / 'hidden' badge); versionId null
//         'delete'  the whole project (versionId null), confirmed by a ~650 ms press-and-hold.
//                   Sample cards show Hide instead: a plain click, {sample:true}.
//                   (There is no per-version delete: the store soft-deletes projects.)
//     'close'    the user dismissed the ring (Esc, L, the Library button, the close button).
//               Programmatic close() and the close after 'choose' don't emit it.
//   ring.spinBy(cards) / ring.spinEnd()   a hand fist-drag (platform/hands.js): moves the ring
//                             like a pointer drag (same LEAD slip and speed cap), then on the
//                             release coasts by the flick and snaps to a card. No-op when closed.
//   ring.dispose()            removes every listener, mesh, material and texture it made.
//   Extras (tests, later wiring): setFilter(name), setView('ring'|'grid'), _state().
//
// FAILURE BEHAVIOUR: a thumbnail that fails to load shows the placeholder card; a throwing
// event handler is logged and does not break the ring; unknown ids in focus() are ignored.

const V = new URL(import.meta.url).search;
const { HOLD_GATE } = await import('../holdGate.js' + V);
const { wheelPixels } = await import('./objectmode.js' + V);

export const NEW_ID = '__new__';
// Speed cap: the ring's DISPLAYED position never moves faster than this, so at most 3 cards
// cross the centre in any 1 s window (2.8/s leaves room for window alignment: crossings are
// >= 357 ms apart, so no 1 s window can hold a 4th).
export const MAX_CARDS_PER_S = 2.8;
const SIDE = 3;                    // cards drawn each side of the centre
const EASE_MS = 80;                // glide time constant once under the speed cap
const FADE_MS = 200;               // open/close dim (>= 150 ms, BUGS #14)
const DIM = 0.6;                   // how far the workbench behind dims
const DRAG_PX = 6;                 // below this a press is a click
const LEAD = 1.5;                  // how far a drag may run ahead of the displayed ring (cards)
const THROW_S = 0.35;              // release velocity x this = the coast before the snap
const NOTCH_PX = 100;              // one wheel notch = one card
const FILTER_MIN = 12;             // filter chips appear above this many projects
const DOUBLE_CHOOSE_MS = 500;      // a dblclick's first click already chose; don't emit twice
const FILTERS = [['recent', 'Recent'], ['rooms', 'Rooms'], ['objects', 'Objects'], ['edited', 'Edited'], ['samples', 'Samples'], ['all', 'All']];

// Layout, in units of u = the half-height visible at the centre card's distance, so the ring
// looks the same whatever the camera's field of view. The arc curves away from the viewer
// (30 degrees of curvature per card); x is evenly spaced so side cards never overlap.
const D = 2.4;                     // camera -> centre card distance (camera space)
const CARD_W = 0.64, CARD_H = 0.48, CARD_Y = 0.12;
const STEP_X = 0.8, ARC_R = 1.0, ARC_DEG = 30;
const STACK = 0.028;               // offset of each stacked edge behind a multi-version card

const mod = (a, n) => ((a % n) + n) % n;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Plain-language description, also the option's accessible name:
// "Chair, edited 30 Sep, 3 versions, completed, 12% inferred".
export function describeCard(c) {
  const parts = [c.title || 'Untitled'];
  if (c.subtitle) parts.push(c.subtitle);
  const n = c.versions?.length ?? 0;
  if (n > 1) parts.push(`${n} versions`);
  for (const b of c.badges ?? []) parts.push(String(b).replace(/\s*·\s*/g, ', '));
  return parts.join(', ');
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function createRing({
  THREE, scene = null, camera = null, renderer = null, controls = null, root, list,
  reducedMotion, button = document.getElementById('libraryBtn'), keys = true
} = {}) {
  if (!root || !list) throw new TypeError('createRing: root and list elements are required');
  const has3D = !!(THREE && scene && camera);

  // ---- listeners: every one goes through here so dispose() can prove it removed them all ---
  const listeners = [];
  const listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn, opts]); };

  const handlers = { choose: new Set(), action: new Set(), close: new Set() };
  function emit(type, detail) {
    for (const cb of [...handlers[type]]) {
      try { cb(detail); } catch (err) { console.error(`ring '${type}' handler threw:`, err); }
    }
  }

  // ---- reduced motion (live) ----
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  let calm = reducedMotion ?? mq.matches;
  if (reducedMotion == null) listen(mq, 'change', () => { calm = mq.matches; });

  // ---- state ----
  let cards = [];          // as given
  let shown = [];          // filtered + ordered, what the list and the ring show
  let active = 0;          // index into shown (THE state; the ring mirrors it)
  let versionIdx = 0;      // index into ordered versions of shown[active]
  let filter = 'recent';
  let query = '';
  let view = has3D ? 'ring' : 'grid';
  let open = false;
  let target = 0;          // unwrapped ring position the list asks for
  let pos = 0;             // unwrapped ring position on screen (speed-capped)
  let presence = 0;        // 0..1 fade of the whole ring + dim
  let lastJumpAt = -Infinity;   // reduced motion: time of the last card jump
  let clock = 0;           // ms, advanced by update()
  let lastChoose = -Infinity;
  let saved = null;        // controls state while open
  let returnFocus = null;
  let actionsOpen = false;
  let renaming = false;

  // Versions newest-first with the working copy on top: what the chips and up/down walk.
  const orderedVersions = (c) => {
    const v = [...(c?.versions ?? [])];
    return v.sort((a, b) => (b.type === 'working') - (a.type === 'working') || (b.date ?? 0) - (a.date ?? 0));
  };
  const latest = (c) => Math.max(0, ...(c.versions ?? []).map((v) => v.date ?? 0));
  const isRoom = (c) => c.kind === 'room' || (c.badges ?? []).some((b) => /\broom\b/i.test(b));
  const isEdited = (c) => (c.badges ?? []).some((b) => /edited/i.test(b)) || (c.versions ?? []).some((v) => v.type === 'edited');
  const isGone = (c) => !!c.deleted || (c.badges ?? []).some((b) => /^(deleted|hidden)$/i.test(b));
  const realCount = () => cards.filter((c) => c.id !== NEW_ID).length;
  const chipsOn = () => realCount() > FILTER_MIN;
  const cur = () => shown[active] ?? null;
  const curVersions = () => orderedVersions(cur());
  const curVersion = () => curVersions()[versionIdx] ?? null;

  function computeShown() {
    const f = chipsOn() ? filter : 'recent';
    const newCard = cards.find((c) => c.id === NEW_ID);
    const newFirst = cards[0]?.id === NEW_ID;
    let out = cards.filter((c) => c.id !== NEW_ID);
    if (f === 'rooms') out = out.filter(isRoom);
    else if (f === 'objects') out = out.filter((c) => !isRoom(c));
    else if (f === 'edited') out = out.filter(isEdited);
    else if (f === 'samples') out = out.filter((c) => c.sample);
    // Below the chip threshold the caller's order stands; with chips, Recent means recent.
    // Deleted / hidden cards stay last (they are only there to be restored).
    if (f === 'recent' && chipsOn()) out = out.map((c, i) => [c, i]).sort((a, b) => isGone(a[0]) - isGone(b[0]) || latest(b[0]) - latest(a[0]) || a[1] - b[1]).map(([c]) => c);
    if (view === 'grid' && query) {
      const q = query.toLowerCase();
      out = out.filter((c) => describeCard(c).toLowerCase().includes(q));
    }
    if (newCard && !query) out = newFirst ? [newCard, ...out] : [...out, newCard];
    return out;
  }

  // ---- DOM -------------------------------------------------------------------------------
  for (const c of [...root.children]) if (c !== list) c.remove();
  root.classList.add('lr');
  root.hidden = true;
  const head = el('div', 'lr-head');
  const heading = el('h2', 'lr-title', 'Library');
  const chips = el('div', 'lr-chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Filter projects');
  const chipBtns = new Map();
  for (const [key, label] of FILTERS) {
    const b = el('button', 'lr-chip', label);
    b.type = 'button';
    b.dataset.filter = key;
    listen(b, 'click', () => setFilter(key));
    chipBtns.set(key, b);
    chips.append(b);
  }
  const search = el('input', 'lr-search');
  search.type = 'search';
  search.placeholder = 'Search projects';
  search.setAttribute('aria-label', 'Search projects');
  search.setAttribute('aria-controls', list.id || 'libraryList');
  listen(search, 'input', () => { query = search.value.trim(); rebuild({ keepId: cur()?.id }); });
  const viewBtn = el('button', 'lr-viewbtn ghost', has3D ? 'Grid' : '');
  viewBtn.type = 'button';
  viewBtn.hidden = !has3D;
  listen(viewBtn, 'click', () => setView(view === 'grid' ? 'ring' : 'grid'));
  const closeBtn = el('button', 'lr-close ghost', 'Close');
  closeBtn.type = 'button';
  closeBtn.title = 'Close the library (Esc or L)';
  listen(closeBtn, 'click', () => userClose());
  head.append(heading, chips, search, el('div', 'spacer'), viewBtn, closeBtn);

  // The drag / click / wheel surface over the 3D cards.
  const surface = el('div', 'lr-surface');
  surface.setAttribute('aria-hidden', 'true');
  // handUI.js: the hand's pinch reaches this as raw pointer events at the cursor (aim at a card +
  // pinch = click it; pinch-hold + move = drag the ring), not as a click at its centre.
  surface.dataset.hand = 'surface';
  const labels = el('div', 'lr-labels');
  labels.setAttribute('aria-hidden', 'true');
  const sideLabels = [];
  for (let i = 0; i < SIDE * 2; i++) { const l = el('div', 'lr-sidelabel'); labels.append(l); sideLabels.push(l); }

  // The centre card's details: title, badges, version chips, actions.
  const panel = el('div', 'lr-panel');
  const pTitle = el('div', 'lr-ptitle');
  const pSub = el('div', 'lr-psub');
  const pBadges = el('div', 'lr-badges');
  const pVersions = el('div', 'lr-versions');
  pVersions.setAttribute('aria-label', 'Versions (up / down arrows)');
  const moreBtn = el('button', 'lr-more', '…');
  moreBtn.type = 'button';
  moreBtn.title = 'Actions: fork, rename, delete';
  moreBtn.setAttribute('aria-label', 'Actions');
  moreBtn.setAttribute('aria-expanded', 'false');
  const actions = el('div', 'lr-actions');
  actions.hidden = true;
  const mkAct = (label, fn, cls = '') => { const b = el('button', cls, label); b.type = 'button'; listen(b, 'click', fn); actions.append(b); return b; };
  const forkBtn = mkAct('Fork', () => fireAction('fork'));
  const renameBtn = mkAct('Rename', () => startRename());
  const restoreBtn = mkAct('Restore', () => fireAction('restore'));
  const hideBtn = mkAct('Hide', () => fireAction('delete'));
  // Delete: press and hold (mouse, touch, or Space/Enter held). A quick click does nothing.
  const delBtn = el('button', 'lr-hold', '');
  delBtn.type = 'button';
  const delLabel = el('span', null, 'Hold to delete');
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(svgNS, 'circle');
  const fill = document.createElementNS(svgNS, 'circle');
  for (const c of [track, fill]) { c.setAttribute('cx', '10'); c.setAttribute('cy', '10'); c.setAttribute('r', '7.5'); }
  track.setAttribute('class', 'lr-hold-track');
  fill.setAttribute('class', 'lr-hold-fill');
  fill.setAttribute('transform', 'rotate(-90 10 10)');   // fill from 12 o'clock
  const CIRC = 2 * Math.PI * 7.5;
  fill.setAttribute('stroke-dasharray', CIRC.toFixed(2));
  fill.setAttribute('stroke-dashoffset', CIRC.toFixed(2));
  svg.append(track, fill);
  delBtn.append(svg, delLabel);
  actions.append(delBtn);
  const renameRow = el('div', 'lr-rename');
  renameRow.hidden = true;
  const renameIn = el('input');
  renameIn.type = 'text';
  renameIn.maxLength = 120;
  renameIn.setAttribute('aria-label', 'New name');
  const renameOk = el('button', 'primary', 'Save');
  renameOk.type = 'button';
  const renameCancel = el('button', null, 'Cancel');
  renameCancel.type = 'button';
  listen(renameOk, 'click', () => commitRename());
  listen(renameCancel, 'click', () => endRename());
  renameRow.append(renameIn, renameOk, renameCancel);
  const pTop = el('div', 'lr-ptop');
  pTop.append(pTitle, moreBtn);
  panel.append(pTop, pSub, pBadges, pVersions, actions, renameRow);
  listen(moreBtn, 'click', () => setActionsOpen(!actionsOpen));
  // One delegated listener: the chips are rebuilt on every change, so per-chip listeners
  // would pile up in `listeners` for the life of the page.
  listen(pVersions, 'click', (e) => { const b = e.target.closest?.('[data-v]'); if (b) setVersion(Number(b.dataset.v)); });

  const hint = el('div', 'lr-hint', '← → projects · ↑ ↓ versions · Enter opens · Esc closes');
  const live = el('div', 'lr-live');
  live.setAttribute('aria-live', 'polite');

  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Projects');
  list.tabIndex = 0;
  list.classList.add('lr-list');
  root.append(head, surface, labels, list, panel, hint, live);

  // ---- 3D ----------------------------------------------------------------------------------
  let group = null, geo = null, dimMesh = null, frameMesh = null;
  const slots = [];        // { face, stacks:[m,m], idx }
  const texCache = new Map();   // url -> { tex, ok }
  let placeholderTex = null, newTex = null;
  if (has3D) {
    geo = new THREE.PlaneGeometry(1, 1);
    group = new THREE.Group();
    group.name = 'libraryRing';
    group.visible = false;
    const basic = (opts) => new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false, ...opts });
    dimMesh = new THREE.Mesh(geo, basic({ color: 0x05080b, opacity: 0 }));
    dimMesh.renderOrder = 990;
    dimMesh.frustumCulled = false;
    frameMesh = new THREE.Mesh(geo, basic({ color: 0x4fd1ff, opacity: 0 }));
    frameMesh.frustumCulled = false;
    group.add(dimMesh, frameMesh);
    for (let i = 0; i < SIDE * 2 + 1; i++) {
      const face = new THREE.Mesh(geo, basic({ color: 0xffffff, opacity: 0 }));
      const stacks = [0, 1].map(() => new THREE.Mesh(geo, basic({ color: 0x2a3a4a, opacity: 0 })));
      for (const m of [face, ...stacks]) { m.frustumCulled = false; m.visible = false; group.add(m); }
      slots.push({ face, stacks });
    }
    scene.add(group);
    placeholderTex = makeCardTexture(false);
    newTex = makeCardTexture(true);
  }

  // Calm placeholder for cards without a thumbnail, and the "Drop your own scan" card.
  function makeCardTexture(isNew) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 192;
    const g = c.getContext('2d');
    g.fillStyle = '#0c1117'; g.fillRect(0, 0, 256, 192);
    g.strokeStyle = isNew ? 'rgba(79,209,255,.7)' : '#2a3a4a';
    g.lineWidth = 3;
    if (isNew) g.setLineDash([10, 8]);
    g.strokeRect(6, 6, 244, 180);
    g.setLineDash([]);
    g.strokeStyle = 'rgba(79,209,255,.55)';
    g.lineWidth = isNew ? 6 : 2;
    g.beginPath();
    if (isNew) { g.moveTo(128, 66); g.lineTo(128, 126); g.moveTo(98, 96); g.lineTo(158, 96); }
    else {   // a quiet wireframe cube
      const p = [[100, 80], [146, 80], [146, 126], [100, 126]], o = [18, -16];
      for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
        g.moveTo(...p[a]); g.lineTo(...p[b]);
        g.moveTo(p[a][0] + o[0], p[a][1] + o[1]); g.lineTo(p[b][0] + o[0], p[b][1] + o[1]);
      }
      for (const q of p) { g.moveTo(...q); g.lineTo(q[0] + o[0], q[1] + o[1]); }
    }
    g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const loader = has3D ? new THREE.TextureLoader() : null;
  function texFor(card, version) {
    if (card?.id === NEW_ID) return newTex;
    const url = version?.thumbUrl ?? card?.thumbUrl ?? null;
    if (!url) return placeholderTex;
    let e = texCache.get(url);
    if (!e) {
      e = { tex: null, ok: false };
      e.tex = loader.load(url, () => { e.ok = true; }, undefined, () => { e.ok = false; e.failed = true; });
      e.tex.colorSpace = THREE.SRGBColorSpace;
      texCache.set(url, e);
    }
    return e.ok ? e.tex : placeholderTex;
  }
  function pruneTextures() {
    const keep = new Set();
    for (const c of cards) { if (c.thumbUrl) keep.add(c.thumbUrl); for (const v of c.versions ?? []) if (v.thumbUrl) keep.add(v.thumbUrl); }
    for (const [url, e] of texCache) if (!keep.has(url)) { e.tex.dispose(); texCache.delete(url); }
  }

  // ---- list --------------------------------------------------------------------------------
  const optId = (i) => `lr-opt-${i}`;
  function renderList() {
    list.replaceChildren();
    list.classList.toggle('grid', view === 'grid');
    shown.forEach((c, i) => {
      const o = el('div', 'lr-opt');
      o.id = optId(i);
      o.setAttribute('role', 'option');
      o.dataset.index = String(i);
      o.dataset.id = String(c.id);
      o.setAttribute('aria-label', describeCard(c));
      if (view === 'grid') {
        const url = c.thumbUrl;
        const th = url ? el('img', 'lr-thumb') : el('div', 'lr-thumb lr-thumb-empty', c.id === NEW_ID ? '+' : '');
        if (url) { th.src = url; th.alt = ''; th.loading = 'lazy'; th.draggable = false; }
        o.append(th, el('div', 'lr-otitle', c.title || 'Untitled'), el('div', 'lr-osub', c.subtitle || ''));
      } else {
        o.textContent = describeCard(c);
      }
      list.append(o);
    });
    syncActive();
  }
  function syncActive() {
    for (const o of list.children) o.setAttribute('aria-selected', String(Number(o.dataset.index) === active));
    if (shown.length) list.setAttribute('aria-activedescendant', optId(active));
    else list.removeAttribute('aria-activedescendant');
    if (view === 'grid') list.querySelector(`#${optId(active)}`)?.scrollIntoView?.({ block: 'nearest' });
    renderPanel();
  }

  function renderPanel() {
    const c = cur();
    panel.hidden = !c;
    if (!c) return;
    pTitle.textContent = c.title || 'Untitled';
    pSub.textContent = c.subtitle || '';
    const vs = curVersions();
    const v = vs[versionIdx];
    pBadges.replaceChildren(...[...(c.badges ?? []), ...(v?.badges ?? []).filter((b) => !(c.badges ?? []).includes(b))]
      .map((b) => el('span', /inferred/i.test(b) ? 'lr-badge inf' : 'lr-badge', b)));
    pVersions.replaceChildren(...vs.map((ver, i) => {
      const b = el('button', 'lr-vchip', `${ver.label || ver.type}${ver.date ? ' · ' + fmtDate(ver.date) : ''}`);
      b.type = 'button';
      b.tabIndex = -1;   // up/down reach them; one tab stop for the whole library list
      b.dataset.v = String(i);
      b.setAttribute('aria-pressed', String(i === versionIdx));
      return b;
    }));
    pVersions.hidden = vs.length < 2;
    const isNew = c.id === NEW_ID;
    moreBtn.hidden = isNew;
    if (isNew && actionsOpen) setActionsOpen(false);
    const gone = isGone(c);
    restoreBtn.hidden = !gone;
    forkBtn.hidden = gone;
    hideBtn.hidden = !c.sample || gone;
    delBtn.hidden = !!c.sample || gone;
  }
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  // ---- state changes -------------------------------------------------------------------------
  function versionIndexFor(c, versionId) {
    const vs = orderedVersions(c);
    const want = versionId ?? c?.currentVersionId;
    const i = vs.findIndex((v) => v.id === want);
    return i < 0 ? 0 : i;
  }
  function setActive(i, { glide = true, versionId } = {}) {
    if (!shown.length) return;
    const n = shown.length;
    const next = mod(i, n);
    const changed = next !== active;
    // Move the ring the short way round to the new index.
    let d = next - mod(Math.round(target), n);
    if (d > n / 2) d -= n; else if (d < -n / 2) d += n;
    target = Math.round(target) + d;
    if (!glide || !open) pos = target;
    active = next;
    if (changed || versionId !== undefined) versionIdx = versionIndexFor(cur(), versionId);
    if (changed) { endRename(); setActionsOpen(false); }
    syncActive();
  }
  function step(dir) {
    if (!shown.length) return;
    // Key repeat / wheel spam may not run the ring more than 2 cards ahead of what is shown.
    if (Math.abs(target + dir - pos) > 2) return;
    target = Math.round(target) + dir;
    active = mod(target, shown.length);
    versionIdx = versionIndexFor(cur());
    endRename(); setActionsOpen(false);
    syncActive();
  }
  function setVersion(i) {
    const vs = curVersions();
    if (!vs.length) return;
    versionIdx = clamp(i, 0, vs.length - 1);
    renderPanel();
    const v = vs[versionIdx];
    live.textContent = `Version ${versionIdx + 1} of ${vs.length}: ${v.label || v.type}${v.date ? ', ' + fmtDate(v.date) : ''}`;
  }
  function rebuild({ keepId, keepVersion } = {}) {
    // A refresh mid-glide (thumbnails arriving, a rename) keeps the remaining glide: jumping
    // pos to the target would pass up to 2 cards in one frame and break the speed cap.
    const lag = open ? clamp(pos - target, -SIDE, SIDE) : 0;
    shown = computeShown();
    const i = keepId != null ? shown.findIndex((c) => c.id === keepId) : -1;
    active = i >= 0 ? i : 0;
    target = active;
    pos = target + lag;
    versionIdx = versionIndexFor(cur(), i >= 0 ? keepVersion : undefined);
    renderList();
    renderChips();
  }
  function renderChips() {
    chips.hidden = !chipsOn();
    for (const [key, b] of chipBtns) b.setAttribute('aria-pressed', String(key === filter));
    search.hidden = view !== 'grid';
    viewBtn.textContent = view === 'grid' ? 'Ring' : 'Grid';
    root.classList.toggle('lr-grid', view === 'grid');
  }
  function setFilter(name) {
    if (!FILTERS.some(([k]) => k === name)) return;
    filter = name;
    // "All" is the long-list view: a grid with search. Leaving it returns to the ring.
    if (name === 'all') view = 'grid';
    else if (has3D) { view = 'ring'; query = ''; search.value = ''; }
    rebuild({ keepId: cur()?.id, keepVersion: curVersion()?.id });
  }
  function setView(v) {
    view = v === 'grid' || !has3D ? 'grid' : 'ring';
    if (view === 'ring') { query = ''; search.value = ''; if (filter === 'all') filter = 'recent'; }
    rebuild({ keepId: cur()?.id, keepVersion: curVersion()?.id });
  }

  // ---- choose / actions -------------------------------------------------------------------
  function choose() {
    const c = cur();
    if (!c || !open) return;
    lastChoose = performance.now();
    if (c.id === NEW_ID) { emit('action', { type: 'new', projectId: NEW_ID, versionId: null }); return; }
    const v = curVersion();
    emit('choose', { projectId: c.id, versionId: v?.id ?? c.currentVersionId ?? null });
    closeRing(false);
  }
  function fireAction(type, extra = {}) {
    const c = cur();
    if (!c || c.id === NEW_ID) return;
    const v = curVersion();
    const versionId = type === 'fork' ? v?.id ?? c.currentVersionId ?? null : null;
    const detail = { type, projectId: c.id, versionId, ...extra };
    if (type === 'delete' && c.sample) detail.sample = true;
    emit('action', detail);
  }
  function setActionsOpen(v) {
    actionsOpen = v && !!cur() && cur().id !== NEW_ID;
    actions.hidden = !actionsOpen;
    moreBtn.setAttribute('aria-expanded', String(actionsOpen));
    if (!actionsOpen) cancelHold();
  }
  function startRename() {
    const c = cur();
    if (!c || c.id === NEW_ID) return;
    renaming = true;
    renameRow.hidden = false;
    actions.hidden = true;
    renameIn.value = c.title || '';
    renameIn.focus();
    renameIn.select();
  }
  function commitRename() {
    const t = renameIn.value.trim();
    if (t && t !== cur()?.title) fireAction('rename', { title: t });
    endRename();
  }
  function endRename() {
    if (!renaming) return;
    renaming = false;
    renameRow.hidden = true;
    actions.hidden = !actionsOpen;
    if (open) list.focus();
  }

  // ---- press-and-hold delete. The timings are holdGate.js's (650 ms, the ring stays
  // invisible for the first 200 ms so a passing click never flashes it). A pointer or key
  // press has a true wall-clock length, so the confirm is a timer, not holdGate's per-frame
  // integration (that exists for noisy gesture frames); frames only draw the ring, so the
  // confirm still lands on time when frames are throttled. --------------------------------
  const HOLD_MS = HOLD_GATE.ringMs, HOLD_HIDDEN_MS = HOLD_GATE.graceVisibleMs;
  let holdRaf = 0, holdTimer = 0, holdT0 = 0;
  let holding = false;
  function drawHold(p) { fill.setAttribute('stroke-dashoffset', (CIRC * (1 - p)).toFixed(2)); }
  function startHold() {
    if (holding || delBtn.hidden) return;
    holding = true;
    holdT0 = performance.now();
    delBtn.classList.add('holding');
    holdTimer = setTimeout(() => { if (holding) { cancelHold(); fireAction('delete'); } }, HOLD_MS);
    const draw = () => {
      if (!holding) return;
      drawHold(clamp((performance.now() - holdT0 - HOLD_HIDDEN_MS) / (HOLD_MS - HOLD_HIDDEN_MS), 0, 1));
      holdRaf = requestAnimationFrame(draw);
    };
    draw();
  }
  function cancelHold() {
    holding = false;
    clearTimeout(holdTimer);
    cancelAnimationFrame(holdRaf);
    delBtn.classList.remove('holding');
    drawHold(0);
  }
  listen(delBtn, 'pointerdown', (e) => { if (e.button === 0 || e.pointerType !== 'mouse') { e.preventDefault(); startHold(); } });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) listen(delBtn, t, cancelHold);
  listen(delBtn, 'contextmenu', (e) => e.preventDefault());   // long-press on touch

  // ---- open / close ------------------------------------------------------------------------
  function openRing() {
    if (open) return;
    open = true;
    returnFocus = document.activeElement;
    root.hidden = false;
    if (controls) { saved = { enabled: controls.enabled, autoRotate: controls.autoRotate }; controls.enabled = false; controls.autoRotate = false; }
    if (group) group.visible = true;
    pos = target;   // a reopened ring starts at rest on the active card
    if (calm) presence = 1;
    button?.classList.add('active');
    button?.setAttribute('aria-expanded', 'true');
    renderChips();
    list.focus({ preventScroll: true });
  }
  function closeRing(user) {
    if (!open) return;
    open = false;
    cancelHold(); endRename(); setActionsOpen(false);
    drag = null;
    root.hidden = true;
    if (controls && saved) { controls.enabled = saved.enabled; controls.autoRotate = saved.autoRotate; }
    saved = null;
    if (calm) { presence = 0; if (group) group.visible = false; }
    button?.classList.remove('active');
    button?.setAttribute('aria-expanded', 'false');
    if (returnFocus && document.contains(returnFocus) && returnFocus !== document.body) returnFocus.focus?.({ preventScroll: true });
    returnFocus = null;
    if (user) emit('close');
  }
  const userClose = () => closeRing(true);
  const toggle = () => (open ? userClose() : openRing());
  if (button) {
    button.setAttribute('aria-controls', root.id || 'libraryRing');
    button.setAttribute('aria-expanded', 'false');
    listen(button, 'click', (e) => { e.stopPropagation(); toggle(); });
  }

  // ---- keyboard ----------------------------------------------------------------------------
  // One capture-phase listener on window: it sees every key before the page's own shortcuts
  // (Tab mode switch, Del hide, H, R, I, ?, Ctrl/Cmd+Z in objectmode.js / main.js / shell.js)
  // and, while the ring is open, stops them reaching those -- the workbench behind can't be
  // edited blind. Ctrl/Cmd combos other than Z still pass (Cmd+S save, browser shortcuts).
  const typingIn = (t) => t?.matches?.('input, textarea, select, [contenteditable="true"]');
  function onKeyDown(e) {
    const t = e.target;
    const typing = typingIn(t);
    const mods = e.ctrlKey || e.metaKey || e.altKey;
    if (!open) {
      if (keys && !typing && !mods && !e.repeat && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); openRing(); }
      return;
    }
    if (mods && e.key.toLowerCase() !== 'z') return;
    e.stopPropagation();
    if (mods) return;   // Ctrl/Cmd+Z: native undo inside our inputs, nothing on the scene
    if (t === renameIn) {
      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
      else if (e.key === 'Escape') { e.preventDefault(); endRename(); }
      return;
    }
    if (t === delBtn && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      if (!e.repeat) startHold();
      return;
    }
    if (typing) {   // the search box
      if (e.key === 'Escape') { e.preventDefault(); if (search.value) { search.value = ''; query = ''; rebuild({ keepId: cur()?.id }); } else list.focus(); }
      else if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); list.focus(); }
      return;
    }
    // A focused button (ours or the toolbar's) keeps its own Enter / Space.
    const onButton = t !== list && !!t?.closest?.('button, a[href], summary');
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); step(1); break;
      case 'ArrowLeft': e.preventDefault(); step(-1); break;
      case 'ArrowDown': e.preventDefault(); setVersion(versionIdx + 1); break;
      case 'ArrowUp': e.preventDefault(); setVersion(versionIdx - 1); break;
      case 'Home': e.preventDefault(); setActive(0); break;
      case 'End': e.preventDefault(); setActive(shown.length - 1); break;
      case 'Enter': case ' ':
        if (onButton) return;   // the button's own click
        e.preventDefault(); choose(); break;
      case 'Escape':
        e.preventDefault();
        if (actionsOpen) { setActionsOpen(false); list.focus(); } else userClose();
        break;
      case 'l': case 'L': if (!e.repeat) { e.preventDefault(); userClose(); } break;
      default: break;   // Tab moves focus as usual; nothing reaches the scene shortcuts
    }
  }
  function onKeyUp(e) {
    if (open && e.target === delBtn && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); cancelHold(); }
  }
  if (keys) { listen(window, 'keydown', onKeyDown, true); listen(window, 'keyup', onKeyUp, true); }

  // ---- list pointer (grid view, and screen-reader / switch clicks) --------------------------
  listen(list, 'click', (e) => {
    const o = e.target.closest?.('[role=option]');
    if (!o) return;
    const i = Number(o.dataset.index);
    if (i === active) choose(); else setActive(i);
  });

  // ---- drag / click / wheel on the 3D cards ----------------------------------------------
  let drag = null;   // { id, x0, t0, target0, moved, samples:[{t, target}] }
  let pxPerCard = 160;
  const rects = [];  // screen rects of drawn cards: { off, idx, l, t, r, b }
  listen(surface, 'pointerdown', (e) => {
    if (!open || (e.pointerType === 'mouse' && e.button !== 0)) return;
    try { surface.setPointerCapture(e.pointerId); } catch { /* synthetic or already-ended pointer */ }
    if (document.activeElement !== list) list.focus({ preventScroll: true });   // keys keep working
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, target0: target, moved: false, samples: [{ t: performance.now(), target }] };
  });
  listen(surface, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    if (!drag.moved && Math.hypot(dx, e.clientY - drag.y0) < DRAG_PX) return;
    drag.moved = true;
    let t = drag.target0 - dx / pxPerCard;
    // The finger may run ahead of the speed-capped ring by LEAD cards; past that it slips
    // (re-anchors), like a wheel with friction, rather than queueing up a long glide.
    if (Math.abs(t - pos) > LEAD) { t = pos + Math.sign(t - pos) * LEAD; drag.x0 = e.clientX; drag.target0 = t; }
    target = t;
    const now = performance.now();
    drag.samples.push({ t: now, target });
    while (drag.samples.length > 2 && now - drag.samples[0].t > 120) drag.samples.shift();
    const i = mod(Math.round(target), shown.length || 1);
    if (i !== active && shown.length) { active = i; versionIdx = versionIndexFor(cur()); syncActive(); }
  });
  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (d.moved || cancelled) {
      const a = d.samples[0], b = d.samples[d.samples.length - 1];
      const v = b.t > a.t ? clamp((b.target - a.target) / ((b.t - a.t) / 1000), -MAX_CARDS_PER_S, MAX_CARDS_PER_S) : 0;
      setActive(Math.round(target + (cancelled ? 0 : v * THROW_S)));
      return;
    }
    // A click: the centre card chooses, a side card comes to the centre.
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;
    if (hit.idx === active) choose();
    else setActive(hit.idx);
  }
  // A hand fist-drag: the same as a pointer drag, in cards instead of px.
  let spin = null;   // { samples:[{t, target}] }
  function spinBy(cards) {
    if (!open || !shown.length || !Number.isFinite(cards)) return;
    spin ??= { samples: [{ t: performance.now(), target }] };
    let t = target + cards;
    if (Math.abs(t - pos) > LEAD) t = pos + Math.sign(t - pos) * LEAD;
    target = t;
    const now = performance.now();
    spin.samples.push({ t: now, target });
    while (spin.samples.length > 2 && now - spin.samples[0].t > 120) spin.samples.shift();
    const i = mod(Math.round(target), shown.length);
    if (i !== active) { active = i; versionIdx = versionIndexFor(cur()); syncActive(); }
  }
  function spinEnd() {
    const sp = spin;
    spin = null;
    if (!sp || !open) return;
    const a = sp.samples[0], b = sp.samples[sp.samples.length - 1];
    const v = b.t > a.t ? clamp((b.target - a.target) / ((b.t - a.t) / 1000), -MAX_CARDS_PER_S, MAX_CARDS_PER_S) : 0;
    setActive(Math.round(target + v * THROW_S));
  }
  listen(surface, 'pointerup', (e) => endDrag(e, false));
  listen(surface, 'pointercancel', (e) => endDrag(e, true));
  // The dblclick's first click already chose (or brought the card to the centre); only a
  // dblclick that didn't follow a choose acts, so one double-click never chooses twice.
  listen(surface, 'dblclick', (e) => {
    if (performance.now() - lastChoose < DOUBLE_CHOOSE_MS) return;
    const hit = hitTest(e.clientX, e.clientY);
    if (hit && hit.idx === active) choose();
  });
  let wheelAcc = 0;
  listen(surface, 'wheel', (e) => {
    if (!open) return;
    e.preventDefault();
    wheelAcc += wheelPixels(e);
    while (Math.abs(wheelAcc) >= NOTCH_PX) { const s = Math.sign(wheelAcc); wheelAcc -= s * NOTCH_PX; step(s); }
  }, { passive: false });
  function hitTest(x, y) {
    const r0 = root.getBoundingClientRect();
    const px = x - r0.left, py = y - r0.top;
    let best = null;
    for (const r of rects) if (px >= r.l && px <= r.r && py >= r.t && py <= r.b && (!best || Math.abs(r.off) < Math.abs(best.off))) best = r;
    return best;
  }

  // ---- per-frame -------------------------------------------------------------------------
  const v3 = has3D ? new THREE.Vector3() : null;
  const tmpScale = has3D ? new THREE.Vector3() : null;
  function project(x, y, z, cw, ch, ox, oy) {
    v3.set(x, y, z).applyMatrix4(camera.projectionMatrix);
    return [ox + (v3.x * 0.5 + 0.5) * cw, oy + (-v3.y * 0.5 + 0.5) * ch];
  }

  function update(dtMs = 16.7) {
    const dt = clamp(Number.isFinite(dtMs) ? dtMs : 16.7, 0, 100);
    clock += dt;
    if (!open && presence <= 0) return;
    // Fade in/out (instant under reduced motion).
    const want = open ? 1 : 0;
    if (calm) presence = want;
    else presence = want > presence ? Math.min(want, presence + dt / FADE_MS) : Math.max(want, presence - dt / FADE_MS);
    // Glide toward the target, never faster than MAX_CARDS_PER_S.
    if (calm) {
      // Reduced motion: whole-card jumps, at most one per 1/MAX_CARDS_PER_S.
      const goal = Math.round(target);
      if (goal !== pos && clock - lastJumpAt >= 1000 / MAX_CARDS_PER_S) { pos = Math.round(pos) + Math.sign(goal - Math.round(pos)); lastJumpAt = clock; }
    } else {
      const d = target - pos;
      let move = d * (1 - Math.exp(-dt / EASE_MS));
      const cap = MAX_CARDS_PER_S * dt / 1000;
      move = clamp(move, -cap, cap);
      if (Math.abs(d) < 0.002 && !drag && !spin) pos = target; else pos += move;
    }
    if (has3D) layout();
    if (!open && presence <= 0 && group) group.visible = false;
  }

  function layout() {
    camera.updateMatrixWorld();
    camera.matrixWorld.decompose(group.position, group.quaternion, tmpScale);
    group.scale.set(1, 1, 1);
    const ease = presence * presence * (3 - 2 * presence);   // smoothstep
    const u = D * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (camera.zoom || 1);
    const aspect = camera.aspect || 1;
    const fit = clamp(aspect / 1.6, 0.45, 1.2);
    const cardScale = clamp(aspect / 1.4, 0.55, 1);
    // Dim: a camera-facing sheet just in front of the near content, covering the view.
    const dz = 0.5;
    const hh = dz * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / (camera.zoom || 1) * 1.2;
    dimMesh.position.set(0, 0, -dz);
    dimMesh.scale.set(hh * 2 * aspect, hh * 2, 1);
    dimMesh.material.opacity = DIM * ease;

    const canvas = renderer?.domElement;
    const cr = canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 1, height: 1 };
    const rr = root.getBoundingClientRect();
    const ox = cr.left - rr.left, oy = cr.top - rr.top;
    const cw = cr.width, ch = cr.height;

    // Cards are evenly spaced on screen: one card = STEP_X * fit / aspect of the half-width.
    pxPerCard = Math.max(40, (STEP_X * fit / aspect) * cw / 2);
    const n = shown.length;
    const showCards = view === 'ring' && n > 0;
    rects.length = 0;
    const base = Math.round(pos);
    let frameSet = false;
    for (let k = -SIDE; k <= SIDE; k++) {
      const slot = slots[k + SIDE];
      const label = k === 0 ? null : sideLabels[k < 0 ? k + SIDE : k + SIDE - 1];
      const idx = mod(base + k, n || 1);
      const off = base + k - pos;
      // With few projects, don't draw the same card twice round the ring.
      const dup = n > 0 && (k < 0 ? -k : k) > 0 && (n <= 2 * SIDE) && (k < -Math.floor((n - 1) / 2) || k > Math.ceil((n - 1) / 2));
      const vis = showCards && !dup && Math.abs(off) < SIDE + 0.5;
      if (!vis) {
        slot.face.visible = slot.stacks[0].visible = slot.stacks[1].visible = false;
        if (label) label.style.opacity = '0';
        continue;
      }
      const c = shown[idx];
      const a = Math.abs(off);
      const alpha = clamp(1 - 0.24 * a, 0, 1) * clamp(SIDE + 0.5 - a, 0, 1) * ease;
      const z = -(D + ARC_R * u * (1 - Math.cos(THREE.MathUtils.degToRad(ARC_DEG * clamp(off, -SIDE, SIDE)))));
      // x is pushed out with depth so the cards stay evenly spaced on screen (no overlap);
      // size and height are left to perspective, so the arc reads as curving away.
      const xs = off * STEP_X * u * fit * (-z / D);
      const y = CARD_Y * u;
      const w = CARD_W * u * cardScale, h = CARD_H * u * cardScale;
      const order = 1000 + Math.round((SIDE + 1 - Math.min(a, SIDE + 1)) * 10);
      const isActive = idx === active;
      const version = isActive ? curVersion() : orderedVersions(c).find((v) => v.id === c.currentVersionId);
      slot.face.visible = true;
      slot.face.position.set(xs, y, z);
      slot.face.scale.set(w, h, 1);
      slot.face.material.map = texFor(c, version);
      slot.face.material.needsUpdate = slot.face.material.userData.map !== slot.face.material.map;
      slot.face.material.userData.map = slot.face.material.map;
      slot.face.material.opacity = alpha;
      slot.face.renderOrder = order + 3;
      // Stacked edges: one per extra version, up to two.
      const extra = Math.min(2, Math.max(0, (c.versions?.length ?? 0) - 1));
      slot.stacks.forEach((m, j) => {
        m.visible = j < extra;
        if (!m.visible) return;
        const o = STACK * u * cardScale * (j + 1);
        m.position.set(xs + o, y + o, z);
        m.scale.set(w, h, 1);
        m.material.opacity = alpha * (0.9 - 0.25 * j);
        m.renderOrder = order + 1 - j;
      });
      if (isActive) {   // steady outline on the active card (never blinks)
        frameSet = true;
        const p = 0.012 * u;
        frameMesh.position.set(xs, y, z);
        frameMesh.scale.set(w + 2 * p, h + 2 * p, 1);
        frameMesh.material.opacity = 0.9 * ease * clamp(1 - 0.24 * a, 0.3, 1);
        frameMesh.renderOrder = order + 2;
      }
      // Screen rect (for clicks) and the label under the card.
      const [l, t] = project(xs - w / 2, y + h / 2, z, cw, ch, ox, oy);
      const [r, b] = project(xs + w / 2, y - h / 2, z, cw, ch, ox, oy);
      rects.push({ off, idx, l, t, r, b });
      if (label) {
        label.textContent = c.title || 'Untitled';
        label.style.opacity = String(alpha * (a < 0.5 ? 0 : 1));
        label.style.transform = `translate(${((l + r) / 2).toFixed(1)}px, ${(b + 6).toFixed(1)}px) translateX(-50%)`;
        label.style.maxWidth = `${Math.max(60, r - l + 20).toFixed(0)}px`;
      } else {
        // The centre panel sits under the centre slot.
        panel.style.top = `${(b + 10).toFixed(1)}px`;
      }
    }
    frameMesh.visible = frameSet;
    for (const l of sideLabels) if (!showCards) l.style.opacity = '0';
  }

  // ---- public ----------------------------------------------------------------------------
  function setProjects(next) {
    const keepId = cur()?.id, keepVersion = curVersion()?.id;
    cards = Array.isArray(next) ? next.filter((c) => c && c.id != null) : [];
    if (!chipsOn() && filter !== 'recent') { filter = 'recent'; if (has3D) view = 'ring'; }
    rebuild({ keepId, keepVersion });
    if (has3D) pruneTextures();
  }
  function focus(projectId, versionId) {
    let i = shown.findIndex((c) => c.id === projectId);
    if (i < 0 && cards.some((c) => c.id === projectId)) {   // filtered out: widen to everything
      filter = 'recent'; query = ''; search.value = '';
      if (has3D) view = 'ring';
      rebuild();
      i = shown.findIndex((c) => c.id === projectId);
    }
    if (i < 0) return;
    setActive(i, { glide: open, versionId: versionId ?? null });
  }
  function dispose() {
    if (open) closeRing(false);
    cancelHold();
    for (const [t, type, fn, opts] of listeners) t.removeEventListener(type, fn, opts);
    listeners.length = 0;
    for (const s of Object.values(handlers)) s.clear();
    if (group) {
      scene.remove(group);
      group.traverse((m) => { if (m.isMesh) m.material.dispose(); });
      geo.dispose();
      placeholderTex.dispose(); newTex.dispose();
      for (const e of texCache.values()) e.tex.dispose();
      texCache.clear();
    }
    for (const c of [...root.children]) if (c !== list) c.remove();   // the list is the caller's markup
    root.classList.remove('lr', 'lr-grid');
    root.hidden = true;
    list.replaceChildren();
    list.removeAttribute('aria-activedescendant');
    button?.classList.remove('active');
  }

  renderChips();
  renderList();

  return {
    setProjects, open: openRing, close: () => closeRing(false), toggle, isOpen: () => open,
    focus, update, spinBy, spinEnd,
    on(event, cb) {
      if (!handlers[event]) throw new TypeError(`ring.on: unknown event '${event}'`);
      handlers[event].add(cb);
      return () => handlers[event].delete(cb);
    },
    dispose, setFilter, setView,
    _state: () => ({ pos, target, active, versionIdx, view, filter, presence, open, shown: shown.map((c) => c.id), pxPerCard, rects: rects.map((r) => ({ ...r })), calm }),
  };
}

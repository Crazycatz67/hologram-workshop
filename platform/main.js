// See hands.js: the entry point stamps a version onto this module's URL, and passing it
// along is what stops GitHub Pages' ten-minute cache from serving stale code.
const V = new URL(import.meta.url).search;

const THREE = await import('three');
const { createScene, startRenderLoop } = await import('../scene.js' + V);
const { createLook } = await import('./look.js' + V);
const { createDisplayLod, PREPASS_LAYER } = await import('./lod.js' + V);
const { groupFiles, parseGroup, countTriangles, sha256Hex, filesFromDrop, ACCEPT, separateInferred, readSidecar } = await import('./upload.js' + V);
const { createLibrary } = await import('./library.js' + V);
const exporter = await import('./export.js' + V);
const { splitComponents } = await import('./segment.js' + V);
const { createToolStatus, slot, TOOLS } = await import('../toolWheel.js' + V);
// meshoptimizer for the part splitter's proxy on dense scans; loads in the background.
import('./parts.js').then((m) => m.loadSimplifier());   // same specifier as segment.js's import -> same module instance
const { createObjectMode } = await import('./objectmode.js' + V);
const { createMeasurements } = await import('./measurements.js' + V);
const { createShell } = await import('./shell.js' + V);
const { placeOnFloor, frameRoom, frameSingle, ROOM_THRESHOLD_M } = await import('./framing.js' + V);
const { openStore, DB_NAME } = await import('./store.js' + V);
const { MODELS } = await import('../models.js' + V);
const { HOLD_GATE } = await import('../holdGate.js' + V);

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const fpsEl = $('fps');
const infoEl = $('info');

// The 3D view lives in its own grid cell (#stage) -- panels sit beside it, not on top.
const { scene, camera, renderer, controls } = createScene($('stage'));
createShell();

// Every hologram material comes from look.js: photosafe (WCAG flash limit, no additive
// bloom, smoothed shading on rough scans), with the Realism / Motion controls.
const look = createLook({ scene, mount: $('look') });
const hologramMaterial = look.parents.base;
// Display LOD + a filtered single-layer pass (lod.js). Replaces the whole-scene pre-pass
// look.js installed; mesh.geometry stays the FULL scan outside render(), so measurements,
// exports, raycasts and part splitting never see the simplified copy.
const lod = createDisplayLod({ scene, camera, renderer, look });
scene.userData.renderSingleLayer = lod.render;
const plainMaterial = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, roughness: 0.6, metalness: 0.0 });
const pointsMaterial = new THREE.PointsMaterial({ color: 0x4fd1ff, size: 0.01 });

// Object-mode highlights (hover pale cyan, selection amber) live in look.js too, so they
// share the realism blend and the safety settings; these are the plain-mode equivalents.
const hoverPlain = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, emissive: 0x2f8fb0, roughness: 0.6 });
const selectedPlain = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, emissive: 0xb07020, roughness: 0.6 });

const edits = [];
// Polygon mode (wired below). Up here because the render loop and objectMode's onChange read it.
const polyBtn = $('polyBtn');
let polygon = null;
let polyHome = null;   // the item polygon mode was entered from, reselected on the way out
// The tool chip + Done button (toolWheel.js createToolStatus), built further down; the render
// loop starts before this module finishes loading, so it reads this through a null check.
let toolStatus = null;
let polyWasActive = false;
let library = null; // created below; object-mode callbacks may run before it exists
let measurements = null;
// items: id -> library item. Shape (also what export.js reads):
//   { id, name, sourceFile, fileSize, sha256, kind:'scan'|'photo', status, root:Group,
//     parts:[{id:'<item>.<local>', local, mesh}], tris, points }
// root carries the item transform (floor placement / arrange); parts sit under it.
const items = new Map();
window.hologram = { scene, camera, renderer, controls, model: null, material: hologramMaterial, edits, items, lod };

// ---- project library state (store.js + ring.js; wired in the "project library" section) ----
// The open PROJECT is the whole scene. Edits autosave into its working copy; Ctrl/Cmd+S
// saves an immutable version. Declared up here because objectMode's onChange reads it.
const params = new URLSearchParams(location.search);
const lib = {
  store: null, ring: null,
  projectId: null, title: '', sample: false,
  opening: false,      // true while a project loads: its replayed edits must not autosave
  sig: '',             // edit-log signature last seen, to spot real edits among onChange calls
  timer: null, pending: false, saving: Promise.resolve(),
  lastThumbAt: -Infinity, thumbTimer: null,
  saveFailed: false,
  changeSeq: 0, savedSeq: 0,   // scene changes counted vs. the last one in the store (unload stash)   // the last working-copy save failed (storage full...): don't clear the scene
  rev: 0,              // working-copy revision this tab last loaded / wrote (store.js baseRev)
  changedSinceVersion: true,  // false right after a version save / a clean open: Cmd+S then makes no duplicate
  editsPending: false, // an unsaved change is a real edit (not just the view): the save marks the copy dirty
  viewSig: ''          // camera + mode + selection last seen (#51: a reload restores the view too)
};

startRenderLoop({
  renderer, scene, camera, controls,
  onFrame: (fps) => { fpsEl.textContent = `${fps} fps`; },
  onTick: (now) => {
    look.update();
    objectMode.tick();
    polygon?.tick();
    measurements?.tick();
    window.hologram.hands?.update(now);   // hands on the Platform (hands.js): runs in THIS loop, no second rAF
    lib.ring?.update(Math.min(100, now - (lib.lastTick ?? now)));
    lib.lastTick = now;
    updateTool();
  }
});

const readyItems = () => [...items.values()].filter((i) => i.status === 'ready');
const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
// Box of what is actually drawn (hidden parts don't count).
function drawnBox(root) {
  const box = new THREE.Box3(), b = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((c) => { if ((c.isMesh || c.isPoints) && shown(c)) box.union(b.setFromObject(c)); });
  return box;
}

// Plain (opaque) mode separates "the mesh is wrong" from "the shader is hiding it".
let plain = new URLSearchParams(location.search).get('plain') === '1';
const plainBtn = $('plain');

// THE one place materials are assigned. Contract: before a mesh reaches here its loaded
// material is on `mesh.userData.original` (textures / vertex colours intact) -- look.js
// reads it for the realism blend, export.js for GLB export.
function applyMaterials() {
  for (const item of items.values()) {
    if (!item.root.userData.lookPrepared) { look.prepare(item.root); item.root.userData.lookPrepared = true; }
    item.root.traverse((c) => {
      if (c.isMesh) c.material = plain ? (look.plainFor(c) ?? plainMaterial) : look.materialFor(c, 'base');
      else if (c.isPoints) c.material = pointsMaterial;
    });
  }
  objectMode.refresh(); // re-applies hover/selected tints on top of the base look
  polygon?.refreshMaterials();
  plainBtn.textContent = plain ? 'Hologram look' : 'Plain material';
}
plainBtn.addEventListener('click', () => { plain = !plain; applyMaterials(); });

function materialFor(kind, mesh) {
  if (plain) return look.plainFor(mesh) ?? (kind === 'hover' ? hoverPlain : kind === 'selected' ? selectedPlain : plainMaterial);
  return look.materialFor(mesh, kind);
}

const modeBtn = $('mode'), undoBtn = $('undo'), showAllBtn = $('showall');
const partsEl = $('parts'), selEl = $('sel'), pinBtn = $('pinBtn');
const objectMode = createObjectMode({
  camera, canvas: renderer.domElement, controls, materialFor, edits,
  // A pinned target refused a move / turn / resize (mouse or hands): say why nothing moved.
  onRefuse: ({ id }) => setStatus(`📌 ${objectMode.isItemKey(id) ? items.get(Number(id.slice(5)))?.name ?? 'This item' : `Part #${id}`} is pinned · press K (or the pin chip) to unpin it`),
  onChange: (st) => {
    modeBtn.textContent = st.mode === 'object' ? 'Object mode' : 'Scene mode';
    modeBtn.classList.toggle('active', st.mode === 'object');
    partsEl.textContent = `${st.parts} selectable part${st.parts === 1 ? '' : 's'}`;
    const selName = st.selection?.kind === 'item' ? `${items.get(Number(st.selection.id.slice(5)))?.name ?? st.selection.id} (whole)` : `#${st.selection?.id}`;
    selEl.textContent = st.selection
      ? `selected ${selName}  ·  ${st.selection.size.map((n) => n.toFixed(2)).join(' × ')} m (W×D×H)`
      : st.mode === 'object' ? 'nothing selected' : '';
    selEl.style.display = selEl.textContent ? '' : 'none';
    // Pin chip: on the selection, either mode (hands select whole items in scene mode too).
    if (pinBtn) {
      const pinned = !!st.selection?.pinned;
      pinBtn.hidden = !st.selection;
      pinBtn.textContent = pinned ? '📌 Pinned' : '📌 Pin';
      pinBtn.classList.toggle('active', pinned);
      pinBtn.setAttribute('aria-pressed', String(pinned));
      pinBtn.title = pinned ? 'K: unpin, so it can be moved, turned and resized again' : 'K: pin it in place (blocks moving, turning and resizing; undoable)';
    }
    undoBtn.disabled = st.edits === 0;
    showAllBtn.disabled = st.hidden === 0;
    showAllBtn.textContent = st.hidden ? `Show all (${st.hidden} hidden)` : 'Show all';
    syncLibraryVisibility();
    // Tab back into object mode while the polygon lens is up: the lens steps aside.
    if (st.mode === 'object' && polygon?.active) polygon.exit();
    syncPolygonBtn(st);
    measurements?.onState(st);
    noteEdits();
    noteView();
  }
});
window.hologram.objectMode = objectMode;
// Per-part sizes, originals and the edit history (measurements.js).
// Visibility is the inspector tab's job (shell.js), so no toggle button is passed.
measurements = createMeasurements({ mount: $('measurements'), toggleBtn: null, objectMode, getItems: readyItems });
window.hologram.measurements = measurements;
modeBtn.addEventListener('click', () => objectMode.toggleMode());
undoBtn.addEventListener('click', () => { objectMode.undo(); syncLibrary(); });
showAllBtn.addEventListener('click', () => objectMode.showAll());
pinBtn?.addEventListener('click', () => objectMode.togglePin());
plainBtn.textContent = plain ? 'Hologram look' : 'Plain material';

// ---- Polygon mode (polygon.js) ---------------------------------------------------------------
// The selected item's real triangles in a lens under the mouse; non-destructive edits (hide,
// mark inferred) go into the same edit log. Loaded lazily: three-mesh-bvh comes from jsDelivr,
// and a CDN hiccup must cost only this button, never the page.
const selectedItemId = (st = objectMode.state()) => {
  const sel = st.selection;
  if (!sel) return null;
  return sel.kind === 'item' ? Number(sel.id.slice(5)) : objectMode.target(sel.id)?.userData.itemId ?? null;
};
function syncPolygonBtn(st = objectMode.state()) {
  const on = !!polygon?.active;
  polyBtn.disabled = !polygon || (!on && !readyItems().some((i) => i.root?.isObject3D));   // no selection = whole scene
  polyBtn.textContent = on ? 'Polygon: on' : 'Polygon';
  polyBtn.setAttribute('aria-pressed', String(on));
}
function togglePolygon() {
  if (!polygon) return;
  if (polygon.active) { polygon.exit(); return; }
  const id = selectedItemId();   // null: nothing selected -> the whole scene (BUGS #46)
  polyHome = id;
  objectMode.setMode('scene');   // the camera orbits; clicks go to the lens, not to part picking
  if (!polygon.enter(id)) { polyHome = null; setStatus('Polygon: nothing with triangles here (point cloud?)', true); syncPolygonBtn(); return; }
  setStatus(`Polygon: ${polygon.state().name} as triangles · point at it to aim the lens, click to select faces · Esc leaves`);
  syncPolygonBtn();
}
// #51: openProject waits for this, so a saved polygon edit finds its op registered on reopen.
const polygonLoaded = import('./polygon.js' + V).then(({ createPolygonMode }) => {
  polygon = createPolygonMode({
    scene, camera, canvas: renderer.domElement, objectMode, getItem: (id) => items.get(id) ?? null, getItems: readyItems,
    onSkin: (k) => look.setSkin(k),   // the hologram eases to a faint skin under the wire
    materialFor: (m) => (plain ? (look.plainFor(m) ?? plainMaterial) : look.materialFor(m, 'base')),
    prepassLayer: PREPASS_LAYER,
    // The lens action bar's Undo: the same path as the top bar's Undo button.
    onUndo: () => { if (!undoBtn.disabled) { objectMode.undo(); syncLibrary(); } else setStatus('Nothing to undo'); },
    onChange: (st) => {
      if (!st.active && polyHome != null && polyWasActive) {   // left (Esc, button, P, item removed): back where we were
        const id = polyHome; polyHome = null;
        if (objectMode.mode !== 'object') objectMode.setMode('object');
        if (items.has(id)) objectMode.selectItem(id);
      }
      polyWasActive = st.active;
      syncPolygonBtn();
    }
  });
  // Hidden / relabelled faces are swapped in only for the frame (the scan stays whole).
  scene.userData.renderSingleLayer = polygon.wrapRender(lod.render);
  window.hologram.polygon = polygon;
  syncPolygonBtn();
}).catch((err) => {
  polyBtn.title = `Polygon mode unavailable: ${err.message}`;
  console.warn('polygon.js failed to load', err);
});
polyBtn.addEventListener('click', togglePolygon);


function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

// ---- library ---------------------------------------------------------------------------
function frameBoxOf(box) {
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  (Math.max(size.x, size.z) > ROOM_THRESHOLD_M ? frameRoom : frameSingle)(box, camera, controls);
}
function frameAll() {
  const box = new THREE.Box3();
  for (const it of readyItems()) if (it.root.visible) box.union(drawnBox(it.root));
  frameBoxOf(box);
}

library = createLibrary($('library'), {
  onToggle(id) {
    const it = items.get(id);
    if (!it) return;
    // A recorded edit (hide/show of the whole item), so it is in the history and undoable.
    objectMode.setVisible(objectMode.itemKey(id), !it.root.visible);
    syncLibrary();
  },
  onFocus(id) { const it = items.get(id); if (it) frameBoxOf(drawnBox(it.root)); },
  onRemove(id) { removeItem(id); }
});
function syncLibrary() {
  syncLibraryVisibility();
  updateInfo();
}
// Undo / replay can flip an item's visibility; keep the Hide/Show buttons honest.
function syncLibraryVisibility() {
  if (!library) return;
  for (const it of items.values()) if (it.status === 'ready') library.update(it.id, { visible: it.root.visible });
}

function updateInfo() {
  const ready = readyItems();
  const tris = ready.reduce((n, i) => n + i.tris, 0);
  infoEl.textContent = ready.length ? `${ready.length} item${ready.length === 1 ? '' : 's'}  ·  ${tris.toLocaleString()} tris` : '';
  syncInferredToggle();
}

function disposeRoot(root) {
  root.traverse((c) => {
    c.geometry?.dispose();
    const m = c.userData.original;
    if (m) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose?.(); }
  });
}

function removeItem(id, { quiet = false } = {}) {
  const it = items.get(id);
  if (!it) return;
  if (polygon?.active && polygon.itemId === id) polygon.exit();
  objectMode.removeItem(id);
  measurements.removeItem(id);
  scene.remove(it.root);
  lod.remove(it.root);
  disposeRoot(it.root);
  items.delete(id);
  library.remove(id);
  const first = readyItems()[0];
  window.hologram.model = first ? first.root : null;
  updateInfo();
  if (quiet) return;
  setStatus(`removed ${it.name}`);
  scheduleAutosave();   // the scene's file list changed
}

let nextId = 1;
const GAP = 0.3; // metres between items when auto-placing / arranging

// Builds the item's root + parts from a parsed scan or a photo mesh, then places it beside
// `others` (default: what is on screen). Nothing is added to the scene here.
async function buildItem(id, group, onProgress, others = readyItems().filter((i) => i.root.visible)) {
  let root, parts, ms = 0, components = 0, completion = null;
  if (group.kind === 'photo') {
    let mod;
    try { mod = await import('./photo.js' + V); }
    catch { throw new Error('photo → hologram not available yet'); }
    onProgress('building relief', 0.3);
    const mesh = await mod.photoToMesh(group.main, { onProgress: (f) => onProgress('building relief', 0.3 + 0.5 * (typeof f === 'number' ? f : 0)) });
    if (!mesh?.isMesh) throw new Error('photo.js did not return a Mesh');
    root = new THREE.Group();
    root.add(mesh);
    parts = [{ id: 1, mesh }];
  } else {
    onProgress('parsing', 0.15);
    const scan = await parseGroup(group);
    let obj = scan.object;
    if (obj.isPoints) { const g = new THREE.Group(); g.add(obj); obj = g; }
    onProgress('splitting parts', 0.55);
    await new Promise((r) => setTimeout(r));
    // Split BEFORE placeOnFloor: parts bake the (still identity) root transform.
    // A file that already names its parts (stock samples, chair_detail.glb) keeps each named
    // mesh whole: connected-component splitting cut the tool chest's 7 drawers and frame into
    // 23 loose bits. An infinite weld makes every triangle of a mesh one component, and
    // minDiagFrac 0 keeps small named parts (a handle) selectable. Generic exporter names
    // ("mesh_0", "Object 3") don't count as named, so multi-mesh scans still split.
    const meshNames = [];
    obj.traverse((c) => { if (c.isMesh) meshNames.push(c.name ?? ''); });
    const namedParts = meshNames.length > 1 && meshNames.every((n) => n && !/^(mesh|node|object|geometry|scene)?[\s_-]*\d*$/i.test(n));
    const seg = splitComponents(obj, namedParts ? { weld: Infinity, minDiagFrac: 0 } : {});
    root = seg.root; parts = seg.parts; ms = seg.ms; components = seg.components;
    if (scan.completion.isCompletion) completion = await describeCompletion(group, scan.completion, separateInferred(root));
  }
  root.name = group.name;
  // Keep the loaded material (textures, vertex colours) before any hologram material replaces it.
  root.traverse((c) => { if ((c.isMesh || c.isPoints) && !c.userData.original) c.userData.original = c.material; });

  onProgress('placing', 0.85);
  const { box } = placeOnFloor(root);
  if (others.length) { // first item stays as-is (centred, floor at y=0); later ones go beside it
    const room = new THREE.Box3();
    others.forEach((i) => room.union(drawnBox(i.root)));
    root.position.x += room.max.x + GAP - box.min.x;
    root.updateMatrixWorld(true);
  }
  const { tris, points } = countTriangles(root);
  return { root, parts, tris, points, ms, components, completion };
}

// ---- P5: completed scans (Track B output) ----------------------------------------------------
// What the item's info shows. The sidecar is the authority for method / licence / share; the
// share is also measured here from the loaded faces, so a stale or mismatched sidecar shows up.
async function describeCompletion(group, tagged, split) {
  let sidecar = null, sidecarError = null;
  try {
    if (group.completionFile) sidecar = readSidecar(await group.completionFile.text(), group.completionFile.name);
    else if (group.main._sidecarUrl) {
      // Only fetched for files that ARE completion output (materials scanned/inferred), so a
      // plain scan never triggers a 404 for a sidecar that was never going to exist.
      const res = await fetch(group.main._sidecarUrl);
      if (res.ok) sidecar = readSidecar(await res.text(), group.main._sidecarUrl.split('/').pop());
    }
  } catch (err) { sidecarError = err.message ?? String(err); console.warn('completion sidecar:', sidecarError); }
  const measuredShare = tagged.totalArea > 0 ? tagged.inferredArea / tagged.totalArea : 0;
  return {
    share: sidecar?.inferredShare ?? measuredShare, measuredShare, fromSidecar: sidecar?.inferredShare != null,
    inferredTris: tagged.inferredTris, totalTris: tagged.totalTris, wholeInferredParts: split.wholeInferred,
    method: sidecar?.method ?? null, licence: sidecar?.licence ?? null, mode: sidecar?.mode ?? null,
    sidecarName: sidecar?.fileName ?? null, sidecarError
  };
}

const inferredBtn = $('inferredBtn');
const hasInferred = () => readyItems().some((i) => i.completion?.inferredTris > 0);
// The button only exists while something on screen has inferred geometry to hide.
function syncInferredToggle() {
  inferredBtn.hidden = !hasInferred();
  inferredBtn.textContent = look.showInferred ? 'View: Completed' : 'View: As scanned';
  inferredBtn.setAttribute('aria-pressed', String(!look.showInferred));
}
function setShowInferred(v) {
  look.setShowInferred(v);
  syncInferredToggle();
  if (hasInferred()) setStatus(v ? 'completed: inferred surfaces shown hatched' : 'as scanned: inferred surfaces hidden');
}
inferredBtn.addEventListener('click', () => setShowInferred(!look.showInferred));
window.hologram.setShowInferred = setShowInferred;

const queue = [];
let pumping = null;

function enqueue(groups) {
  for (const g of groups) {
    const id = nextId++;
    library.add(id, { name: g.name, kind: g.kind });
    queue.push({ id, group: g });
  }
  if (!pumping) pumping = pump().finally(() => { pumping = null; });
  return pumping;
}

async function pump() {
  let done = 0;
  while (queue.length) {
    const { id, group } = queue.shift();
    const total = done + queue.length + 1;
    setStatus(`loading ${done + 1}/${total}: ${group.name}`);
    const onProgress = (message, progress) => library.update(id, { status: 'loading', message, progress });
    onProgress('reading', 0.05);
    await new Promise((r) => setTimeout(r, 30)); // let the panel paint between items
    const t0 = performance.now();
    try {
      const built = await buildItem(id, group, onProgress);
      onProgress('hashing', 0.95);
      await registerItem(id, group, built, t0);
      frameAll();
    } catch (err) {
      console.warn('load failed', group.name, err);
      library.update(id, { status: 'error', message: err.message ?? String(err) });
    }
    done++;
  }
  const nErr = document.querySelectorAll('#libList .libRow[data-status="error"]').length;
  setStatus(nErr ? `done, ${nErr} item${nErr === 1 ? '' : 's'} failed (see library)` : 'loaded');
  if (nErr) statusEl.classList.add('error');
}

// Puts a built item into the scene, object mode, measurements and its (already added) library row.
// sourceRefs: where each of its files lives in the project library ({sha} once stored, {url}
// for files fetched from the site), so a saved project can reload exactly these files.
async function registerItem(id, group, built, t0) {
  const sha256 = group.main._libSource?.sha ?? await sha256Hex(group.main);
  const item = {
    id, name: group.name, sourceFile: group.main.name, fileSize: group.main.size, sha256, kind: group.kind,
    status: 'ready', root: built.root, tris: built.tris, points: built.points, completion: built.completion,
    parts: built.parts.map(({ mesh }, i) => ({ id: `${id}.${i + 1}`, local: i + 1, mesh })),
    files: groupFilesOf(group), sourceRefs: null,
    // As placed on load: a reopened project puts items back here before replaying its edit
    // log, so the log's first `before` states match and the undo history can be adopted.
    loaded: objectMode.snapshot(built.root)
  };
  for (const p of item.parts) { p.mesh.userData.itemId = id; p.mesh.userData.partId = p.id; }
  items.set(id, item);
  scene.add(item.root);
  objectMode.addParts(item.parts.map(({ id: pid, mesh }) => ({ id: pid, mesh })));
  objectMode.addItem(id, item.root);
  applyMaterials();
  lod.add(item.root);   // after applyMaterials: the LOD shares the smoothed shading normals
  window.hologram.model ??= item.root;
  if (built.completion) item.root.userData.inferredShare = built.completion.share;
  // Determine the display label: flatPreview shows badge+hint, photo mode shows photo→3D label
  let kindLabel = group.kind;
  if (item.parts[0]?.mesh.userData.flatPreview) {
    kindLabel = `${item.parts[0].mesh.userData.badge} · ${item.parts[0].mesh.userData.hint}`;
  } else if (built.completion?.mode === 'photo') {
    kindLabel = 'photo → 3D (TripoSR, inferred)';
  }
  library.update(id, { status: 'ready', message: '', tris: built.tris, points: built.points, progress: 1, completion: built.completion, kindLabel });
  updateInfo();
  measurements.addItem(item);
  window.hologram.stats = { name: group.name, tris: built.tris, points: built.points, parts: item.parts.length, components: built.components, splitMs: built.ms, parseMs: performance.now() - t0 };
  return item;
}
const groupFilesOf = (g) => [g.main, ...(g.sidecars ?? []), ...(g.completionFile ? [g.completionFile] : [])];

// Drop / pick / URL loads. With a project of the visitor's open, the files join its scene
// (a project is the whole scene). With none open, or the sample open (the sample belongs to
// the app, so it is closed untouched), they start a new project. project:false (?model=)
// loads without creating one; Ctrl/Cmd+S still can.
async function loadFiles(files, { project = true } = {}) {
  if (lib.opening) { setStatus('wait: a project is still opening', true); return; }
  const { groups, ignored } = await groupFiles(files);
  if (!groups.length) {
    setStatus(`nothing to load (${[...files].map((f) => f.name).join(', ') || 'no files'}) -- use .glb .gltf .obj .ply or photos`, true);
    return;
  }
  if (project && lib.sample && !await closeProject()) return;
  lib.ring?.close();
  const p = enqueue(groups);
  if (ignored.length) console.info('ignored files (not a model, texture or photo):', ignored.join(', '));
  await p;
  if (!project || !lib.store || !readyItems().length) return;
  try {
    if (lib.projectId) { await storeSources(); scheduleAutosave(); }
    else await queueSave(() => createProjectFromScene());
  } catch (err) { reportStoreError('saving', err); }
}
window.loadScanFiles = loadFiles;

async function loadUrl(url, opts) {
  setStatus('loading…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], url.split('/').pop());
    // Where a Track B sidecar would sit (<stem>.json); only fetched if the model turns out to be completion output.
    Object.defineProperty(file, '_sidecarUrl', { value: url.replace(/\.[^./]+(\?.*)?$/, '.json') });
    Object.defineProperty(file, '_url', { value: url });   // a project keeps the URL, not a copy of the bytes
    await loadFiles([file], opts);
  } catch (err) {
    setStatus(err.message, true);
  }
}
window.loadScanUrl = loadUrl;

// ---- arrange -----------------------------------------------------------------------------
function arrangeAll() {
  const list = readyItems();
  if (!list.length) return setStatus('nothing to arrange', true);
  objectMode.ensureLive();
  const rows = list.map((it) => {
    const b = drawnBox(it.root);
    return { it, b, w: b.max.x - b.min.x, area: (b.max.x - b.min.x) * (b.max.z - b.min.z) };
  }).filter((r) => !r.b.isEmpty()).sort((a, b) => b.area - a.area); // largest first
  const total = rows.reduce((n, r) => n + r.w, 0) + GAP * (rows.length - 1);
  let cursor = -total / 2;
  const moves = [];
  for (const r of rows) {
    const dx = cursor - r.b.min.x;
    const dz = -(r.b.min.z + r.b.max.z) / 2;
    moves.push({ it: r.it, dx, dz, from: r.it.root.position.clone() });
    cursor += r.w + GAP;
  }
  const changes = [];
  for (const m of moves) {
    const before = objectMode.snapshot(m.it.root);
    m.it.root.position.x += m.dx; m.it.root.position.z += m.dz; m.it.root.updateMatrixWorld(true);
    changes.push({ item: m.it.id, part: null, before, after: objectMode.snapshot(m.it.root) });
  }
  objectMode.record({ op: 'arrange', items: moves.map((m) => ({ item: m.it.id, dx: m.dx, dz: m.dz })), changes });
  frameAll();
  setStatus(`arranged ${moves.length} item${moves.length === 1 ? '' : 's'}`);
}
$('arrange').addEventListener('click', arrangeAll);
window.arrangeAll = arrangeAll;

// ---- export ------------------------------------------------------------------------------
const exportCtx = {
  items: readyItems, renderer, scene, camera, controls, edits, objectMode,
  restoreMaterials: () => applyMaterials()
};
function download({ blob, filename }) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  setStatus(`exported ${filename} (${(blob.size / 1024).toFixed(blob.size > 1e6 ? 0 : 1)} KB)`);
}
const runExport = (fn) => async () => {
  try { download(await fn(exportCtx)); } catch (err) { console.error(err); setStatus(`export failed: ${err.message}`, true); }
};
function doImportLayout(layout) {
  const rep = exporter.importLayout(exportCtx, layout);
  syncLibrary();
  setStatus(`layout applied to ${rep.applied} item${rep.applied === 1 ? '' : 's'}` + (rep.mismatches.length ? `; ${rep.mismatches.length} mismatch${rep.mismatches.length === 1 ? '' : 'es'}: ${rep.mismatches.join('; ')}` : ''), !rep.applied);
  return rep;
}
window.hologramExport = {
  glb: () => exporter.exportGLB(exportCtx),
  layout: () => exporter.exportLayout(exportCtx),
  plan: () => exporter.exportPlan(exportCtx),
  png: () => exporter.exportPNG(exportCtx),
  importLayout: (layout) => doImportLayout(layout)
};

const menu = $('exportMenu');
$('exportBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
window.addEventListener('click', () => { menu.hidden = true; });
const layoutPicker = $('layoutPicker');
menu.addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  if (act === 'glb') runExport(exporter.exportGLB)();
  else if (act === 'layout') runExport(exporter.exportLayout)();
  else if (act === 'plan') runExport(exporter.exportPlan)();
  else if (act === 'png') runExport(exporter.exportPNG)();
  else if (act === 'import') layoutPicker.click();
});
layoutPicker.addEventListener('change', async () => {
  const f = layoutPicker.files[0];
  layoutPicker.value = '';
  if (!f) return;
  try { doImportLayout(JSON.parse(await f.text())); } catch (err) { setStatus(`import failed: ${err.message}`, true); }
});

// ---- project library (store.js) + the Library ring (ring.js) -------------------------------
// Owner decisions 2026-10-01: a project is the whole scene; edits autosave into its working
// copy (~2 s after the last edit, thumbnail at most every 10 s) and Ctrl/Cmd+S or "Save
// version" keeps an immutable version; versions are edit logs replayed on the original files;
// the ring is the landing screen on a first visit, otherwise the last project reopens.
const AUTOSAVE_MS = 2000;
const THUMB_MIN_MS = 10000;
const SWAP_TRIS_MAX = 3e6;     // above this, free the old scene before loading (memory), else load-then-swap
const NEW_CARD = '__new__';
const SAMPLE_ID = 'sample-chair';
// ?db=<name>: a separate library (tests, checks) that never touches the visitor's real one.
const dbName = /^[\w-]{1,64}$/.test(params.get('db') ?? '') ? params.get('db') : DB_NAME;
// Per database, so library-test.html (its own DB) never changes which project the app reopens.
const LAST_KEY = 'hologram-platform-lastProject' + (dbName === DB_NAME ? '' : `:${dbName}`);
const remember = (id) => { try { if (id) localStorage.setItem(LAST_KEY, id); else localStorage.removeItem(LAST_KEY); } catch { /* private mode */ } };

// objectMode's onChange also fires on hover / selection; only a changed edit log is an edit.
// Wheel rotate / scale ticks merge into the last entry (same length and seq), so its end
// state is part of the signature too.
function editSig() {
  const e = edits[edits.length - 1];
  return `${edits.length}:${e?.seq ?? 0}:${e ? JSON.stringify(e.after ?? null) : ''}`;
}
function noteEdits() {
  const s = editSig();
  if (s === lib.sig) return;
  lib.sig = s;
  if (!lib.opening) scheduleAutosave();
}
// #51 (owner decision 2026-10-01): a reload restores the camera, the Scene/Object mode and
// the selection as well as the edits. They are not edits (no undo step, no "changed since
// version"), so a change to them alone saves with view:true.
const r4 = (v) => v.toArray().map((n) => Math.round(n * 1e4) / 1e4).join();
function viewState() {
  const ready = readyItems(), key = objectMode.selectedId;
  let sel = null;
  if (key != null) {
    const whole = objectMode.isItemKey(key);
    const i = ready.findIndex((it) => (whole ? `item:${it.id}` === key : it.parts.some((p) => p.id === key)));
    if (i >= 0) sel = { i, part: whole ? null : ready[i].parts.find((p) => p.id === key).local };
  }
  return { mode: objectMode.mode, sel };
}
const viewSig = () => `${r4(camera.position)}|${r4(controls.target)}|${JSON.stringify(viewState())}`;
function noteView() {
  if (!lib.projectId || lib.opening || lib.ring?.isOpen?.()) return;   // the ring flies the camera itself
  const s = viewSig();
  if (s === lib.viewSig) return;
  lib.viewSig = s;
  scheduleAutosave(AUTOSAVE_MS, { view: true });
}
// Puts the saved mode + selection back (byRec: saved item index -> the item it reopened as).
function applyView(view, byRec) {
  if (!view) return;
  if (view.mode === 'object' || view.mode === 'scene') objectMode.setMode(view.mode);
  const it = view.sel ? byRec.get(view.sel.i) : null;
  if (!it) return;
  objectMode.select(view.sel.part == null ? objectMode.itemKey(it.id) : it.parts.find((p) => p.local === view.sel.part)?.id ?? null);
}
function scheduleAutosave(delay = AUTOSAVE_MS, { view = false } = {}) {
  if (!lib.store || !lib.projectId || lib.opening) return;
  if (!view) { lib.changedSinceVersion = true; lib.editsPending = true; }
  lib.changeSeq++;
  lib.pending = true;
  clearTimeout(lib.timer);
  lib.timer = setTimeout(() => { lib.timer = null; flushAutosave(); }, delay);
}
// Every write goes through one chain, so an autosave can never land after a version save
// (or a project switch) that was started later.
function queueSave(fn) {
  lib.saving = lib.saving.then(fn).catch((err) => reportStoreError('saving', err));
  return lib.saving;
}
// whileOpening: openProject's own flush (it sets lib.opening first, which otherwise makes
// saveWorkingNow skip the save and the pending edits would be lost in the switch).
function flushAutosave({ thumb = true, whileOpening = false } = {}) {
  clearTimeout(lib.timer);
  lib.timer = null;
  if (!lib.pending || !lib.projectId) return lib.saving;
  lib.pending = false;
  const projectId = lib.projectId;
  return queueSave(() => saveWorkingNow(projectId, { thumb, whileOpening }));
}
function reportStoreError(what, err) {
  console.warn(`library ${what} failed:`, err);
  setStatus(err?.code === 'quota' ? err.message : `${what} failed: ${err?.message ?? err}`, true);
  if (err?.code === 'quota') freeSpaceBtn.hidden = false;
}

// #43 (owner decision): storage full -> a press-and-hold "Free space now" button. Holding it for
// HOLD_GATE.ringMs permanently removes the projects already in the trash and any unreferenced
// files at once (not after 30 days / 1 day), then retries the failed save. The open scene's
// own files are spared even when the failed save never got to reference them.
const freeSpaceBtn = $('freeSpace');
freeSpaceBtn.style.setProperty('--hold-ms', `${HOLD_GATE.ringMs}ms`);
let freeHold = null;
function freeHoldStart(e) {
  if (freeHold || freeSpaceBtn.hidden || (e.type === 'keydown' && (e.repeat || (e.key !== 'Enter' && e.key !== ' ')))) return;
  e.preventDefault();
  freeSpaceBtn.classList.add('holding');
  freeHold = setTimeout(() => { freeHold = null; freeSpaceBtn.classList.remove('holding'); freeSpaceNow(); }, HOLD_GATE.ringMs);
}
function freeHoldEnd() {
  if (!freeHold) return;
  clearTimeout(freeHold);
  freeHold = null;
  freeSpaceBtn.classList.remove('holding');
}
freeSpaceBtn.addEventListener('pointerdown', freeHoldStart);
freeSpaceBtn.addEventListener('keydown', freeHoldStart);
for (const t of ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur']) freeSpaceBtn.addEventListener(t, freeHoldEnd);
freeSpaceBtn.addEventListener('click', (e) => { if (e.detail === 0 && !freeHold && !freeSpaceBtn.hidden) setStatus('hold the button (about a second) to free space', true); });
async function freeSpaceNow() {
  if (!lib.store) return;
  freeSpaceBtn.hidden = true;
  setStatus('freeing space…');
  await lib.saving;   // nothing half-written while the purge runs
  const keep = new Set();
  for (const it of readyItems()) for (const r of it.sourceRefs ?? []) if (r.sha) keep.add(r.sha);
  let n;
  try { n = await lib.store.purgeExpired(0, { orphanMs: 0, keep }); } catch (err) { reportStoreError('freeing space', err); return; }
  if (lib.saveFailed && lib.projectId) { lib.pending = true; await flushAutosave(); }
  if (lib.saveFailed) return;   // still full: reportStoreError showed the message and the button again
  const what = `${n.projects} deleted project${n.projects === 1 ? '' : 's'} and ${n.blobs} unused file${n.blobs === 1 ? '' : 's'}`;
  setStatus(`freed space: removed ${what}` + (lib.projectId ? '; your edits are saved' : ''));
}

// room: what the ring's Rooms / Objects chips file the card under. Same rule framing.js uses
// for the dollhouse view (footprint wider than ROOM_THRESHOLD_M), or a Track B completion
// whose sidecar says it was completed in room mode.
const sceneStats = () => {
  const ready = readyItems();
  const box = new THREE.Box3();
  for (const it of ready) box.union(drawnBox(it.root));
  const size = box.isEmpty() ? null : box.getSize(new THREE.Vector3());
  return {
    items: ready.length, tris: ready.reduce((n, i) => n + i.tris, 0), points: ready.reduce((n, i) => n + (i.points ?? 0), 0),
    edits: edits.length, inferred: ready.some((i) => i.completion?.inferredTris > 0),
    room: ready.some((i) => i.completion?.mode === 'room') || (!!size && Math.max(size.x, size.z) > ROOM_THRESHOLD_M)
  };
};
// Where each item sat when it was loaded (see registerItem): replay needs the same start.
const sceneExtras = () => ({ loaded: readyItems().map((it) => ({ sha256: it.sha256, name: it.name, state: it.loaded })), view: viewState() });
// One entry per item's MAIN file, even when two items are the same file (two copies of one
// scan, or the same bytes under another name): each becomes its own item again on reopen.
// Sidecars (textures, .bin, .mtl) shared between items are listed once.
function currentSources() {
  const seen = new Set(), out = [];
  for (const it of readyItems()) (it.sourceRefs ?? []).forEach((r, i) => {
    const k = r.sha ?? `url:${r.url}`;
    if (i > 0 && seen.has(k)) return;
    seen.add(k);
    out.push(r);
  });
  return out;
}
// Copies newly dropped files into the library (deduped by sha256); files fetched from the
// site are kept as URLs, not bytes.
async function storeSources() {
  for (const it of readyItems()) {
    if (it.sourceRefs) continue;
    const refs = [];
    for (const f of it.files ?? []) {
      if (f._libSource) refs.push({ ...f._libSource, name: f.name });
      else if (f._url) refs.push({ url: f._url, name: f.name });
      else refs.push({ sha: await lib.store.putBlob(f, { name: f.name, mime: f.type }), name: f.name });
    }
    it.sourceRefs = refs;
    it.files = null;   // the bytes now live in IndexedDB (or at the URL)
  }
}
async function takeThumb() {
  if (lib.ring?.isOpen?.()) return null;   // the ring may draw into this scene
  try {
    const blob = await exporter.renderThumbnail(exportCtx, 256);
    lib.lastThumbAt = performance.now();
    return blob;
  } catch (err) { console.warn('thumbnail failed:', err); return null; }
}

// thumb:false skips the thumbnail (its toBlob is async): the page is being hidden or
// unloaded, and the write must start in this task to land before the page goes.
// whileOpening: openProject saving edits made to the old scene during its load.
async function saveWorkingNow(projectId, { thumb = true, whileOpening = false } = {}) {
  if (projectId !== lib.projectId || (lib.opening && !whileOpening)) return;   // the scene is no longer that project
  await storeSources();
  let thumbBlob = null;
  const since = performance.now() - lib.lastThumbAt;
  if (thumb && since >= THUMB_MIN_MS) thumbBlob = await takeThumb();
  else if (thumb && !lib.thumbTimer) {   // edits kept coming: one trailing save brings the card up to date
    lib.thumbTimer = setTimeout(() => { lib.thumbTimer = null; scheduleAutosave(0, { view: true }); }, THUMB_MIN_MS - since);
  }
  const seq = lib.changeSeq;
  const edited = lib.editsPending;
  lib.editsPending = false;
  try {
    const w = await lib.store.saveWorking(projectId, {
      layout: exporter.buildLayout(exportCtx), extras: sceneExtras(), stats: sceneStats(), sources: currentSources(), thumbBlob, baseRev: lib.rev, dirty: edited
    });
    if (projectId === lib.projectId) { lib.rev = w.rev; lib.saveFailed = false; lib.savedSeq = seq; freeSpaceBtn.hidden = true; }
    if (lib.changeSeq === seq || projectId !== lib.projectId) dropRescue(projectId);
  } catch (err) {
    // Changed or deleted in another tab: this scene continues as a new project.
    if ((err?.code === 'conflict' || err?.code === 'gone') && projectId === lib.projectId) return keepConflictAsCopy();
    // Not saved: stay pending, so the next flush (a project switch, hiding the tab) retries
    // and openProject refuses to clear the scene over unsaved edits.
    if (projectId === lib.projectId) { lib.pending = true; lib.saveFailed = true; lib.editsPending ||= edited; }
    throw err;
  }
  refreshRing();
}

// Another tab wrote this project's working copy since this tab last read it. Overwriting would
// silently drop that tab's edits, so this tab's scene continues as a new project instead.
async function keepConflictAsCopy() {
  const from = lib.title;
  const p = await createProjectFromScene({ from: 'conflict', title: `${from} (edits from another tab)` });
  setStatus(`"${from}" was also changed in another tab, so your edits here continue in a new project: "${p.title}"`, true);
  return p;
}

async function createProjectFromScene({ from = 'upload', title: given = null } = {}) {
  await storeSources();
  const names = readyItems().map((i) => i.name.replace(/\.[^.]+$/, ''));
  const title = given ?? (names.length > 1 ? `${names[0]} + ${names.length - 1} more` : names[0] ?? 'Untitled scene');
  const p = await lib.store.createProject({
    title, kind: 'scene', sources: currentSources(), layout: exporter.buildLayout(exportCtx), extras: sceneExtras(),
    stats: sceneStats(), thumbBlob: await takeThumb(), provenance: { app: 'platform', from }
  });
  setCurrent(p);
  lib.sig = editSig();
  lib.rev = 0;
  lib.pending = lib.saveFailed = false;
  lib.savedSeq = lib.changeSeq;
  lib.changedSinceVersion = false;   // its 'original' version is this scene
  refreshRing();
  return p;
}
function setCurrent(p) {
  lib.projectId = p?.id ?? null;
  lib.title = p?.title ?? '';
  lib.sample = !!p?.sample;
  if (p) remember(p.id);
}

// Ctrl/Cmd+S and #saveVersionBtn. No prompt: "Version N" (the ring's rename edits it later).
function saveVersionNow() {
  if (!lib.store) return setStatus('saving is off: this browser blocked local storage', true);
  if (lib.opening) return setStatus('wait: a project is still opening', true);
  if (!readyItems().length) return setStatus('nothing to save yet: add a scan first', true);
  clearTimeout(lib.timer);
  lib.timer = null;
  lib.pending = false;
  return queueSave(async () => {
    if (!lib.projectId) {   // its 'original' version is this scene: nothing more to save
      await createProjectFromScene({ from: 'save' });
      setStatus(`saved as a new project: ${lib.title}`);
      return null;
    }
    // Nothing changed since the last version (Cmd+S pressed again, or held down): don't
    // stack identical versions in the ring.
    if (!lib.changedSinceVersion) { setStatus(`no changes since the last saved version of ${lib.title}`); return null; }
    await storeSources();
    const seq = lib.changeSeq;
    let v;
    try {
      v = await lib.store.saveVersion(lib.projectId, {
        layout: exporter.buildLayout(exportCtx), extras: sceneExtras(), stats: sceneStats(), sources: currentSources(),
        thumbBlob: await takeThumb(), provenance: { app: 'platform', edits: edits.length }, baseRev: lib.rev
      });
    } catch (err) {
      if (err?.code === 'conflict' || err?.code === 'gone') return keepConflictAsCopy();
      lib.pending = lib.saveFailed = true;   // as saveWorkingNow: the next flush retries
      throw err;
    }
    lib.rev = v.workingRev;
    lib.saveFailed = false;
    lib.savedSeq = seq;
    if (lib.changeSeq === seq) dropRescue(lib.projectId);
    lib.changedSinceVersion = false;
    if (lib.changeSeq === seq) lib.editsPending = false;   // the version holds them; a later view-only save stays clean
    setStatus(`saved "${v.label}" of ${lib.title}`);
    refreshRing();
    return v;
  });
}

function setBusy(on) {
  document.body.toggleAttribute('data-library-busy', on);
  $('stage').setAttribute('aria-busy', String(on));
  const b = $('saveVersionBtn');
  if (b) b.disabled = on;
}

// Removes every item (and its history) from the scene. Not undoable: the project keeps it.
function clearScene() {
  for (const id of [...items.keys()]) removeItem(id, { quiet: true });
  // Rows of items that failed to load have no scene object; drop them too.
  for (const row of document.querySelectorAll('#libList .libRow')) library.remove(Number(row.dataset.id));
  edits.length = 0;   // main owns the log; anything left referred to the removed items
  objectMode.select(null);
  updateInfo();
}

// Library files -> File objects the normal loaders accept, tagged with where they came from.
async function filesForSources(sources) {
  const out = [];
  for (const s of sources ?? []) {
    let blob;
    if (s.sha) {
      blob = await lib.store.getBlob(s.sha);
      if (!blob) throw new Error(`${s.name} is missing from this browser's storage`);
    } else if (s.url) {
      const res = await fetch(s.url);
      if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status}`);
      blob = await res.blob();
    } else continue;
    const f = new File([blob], s.name, { type: blob.type });
    Object.defineProperty(f, '_libSource', { value: s.sha ? { sha: s.sha } : { url: s.url } });
    if (s.url) Object.defineProperty(f, '_sidecarUrl', { value: s.url.replace(/\.[^./]+(\?.*)?$/, '.json') });
    out.push(f);
  }
  return out;
}

// Builds every group off-scene first, then swaps (the old scene survives a failed load), or
// with removeFirst frees the old scene before building (huge scenes: two in memory won't fit).
// beforeClear runs just before a load-then-swap clears the old scene (openProject saves edits
// made to it while the new one was loading).
async function replaceScene(groups, removeFirst, beforeClear = null) {
  if (removeFirst) clearScene();
  const staged = [];
  try {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      setStatus(`opening ${lib.openingTitle}: ${i + 1}/${groups.length} ${g.name}`);
      await new Promise((r) => setTimeout(r, 30));   // let the status paint
      const t0 = performance.now();
      const id = nextId++;
      staged.push({ id, group: g, t0, built: await buildItem(id, g, () => {}, staged.map((x) => x.built)) });
    }
  } catch (err) {
    for (const x of staged) disposeRoot(x.built.root);
    throw err;
  }
  if (!removeFirst) {
    try { await beforeClear?.(); } catch (err) { for (const x of staged) disposeRoot(x.built.root); throw err; }
    clearScene();
  }
  for (const x of staged) {
    library.add(x.id, { name: x.group.name, kind: x.group.kind });
    const it = await registerItem(x.id, x.group, x.built, x.t0);
    it.sourceRefs = groupFilesOf(x.group).map((f) => ({ ...f._libSource, name: f.name }));
    it.files = null;
  }
}

// Puts each item back where it was first loaded, then hands the saved layout (with its edit
// history) to importLayout, which adopts the history so undo keeps working.
function applyProjectLayout(layout, extras) {
  const recs = extras?.loaded ?? [];
  const used = new Set();
  const byRec = new Map();   // saved item index -> the item it reopened as (applyView)
  for (const it of readyItems()) {
    let i = recs.findIndex((r, k) => !used.has(k) && r.sha256 && r.sha256 === it.sha256);
    if (i < 0) i = recs.findIndex((r, k) => !used.has(k) && r.name === it.name);
    if (i < 0) continue;
    byRec.set(i, it);
    if (!recs[i].state) continue;
    used.add(i);
    const s = recs[i].state, o = it.root;
    o.position.fromArray(s.position); o.quaternion.fromArray(s.quaternion); o.scale.fromArray(s.scale);
    o.visible = s.visible; o.updateMatrixWorld(true);
    it.loaded = s;
  }
  if (!layout?.items?.length) { frameAll(); return { applied: 0, mismatches: [], historyRestored: 0, byRec }; }
  // No edits: the scene is already exactly as saved (the loaded placement above). Going
  // through importLayout would record a pointless "importLayout" step in the undo history.
  if (!layout.edits?.length) {
    if (layout.camera?.position && layout.camera?.target) {
      camera.position.fromArray(layout.camera.position);
      controls.target.fromArray(layout.camera.target);
      controls.update();
    } else frameAll();
    return { applied: readyItems().length, mismatches: [], historyRestored: 0, byRec };
  }
  const rep = exporter.importLayout(exportCtx, layout);
  syncLibrary();
  return { ...rep, byRec };
}

// Opens a project's working copy, or (versionId) resets the working copy to that version
// first -- store.checkout keeps any unsaved working edits as a version, so nothing is lost.
async function openProject(projectId, versionId = null, { fallback = true } = {}) {
  if (!lib.store) return false;
  if (lib.opening) { setStatus('wait: a project is already opening', true); return false; }
  if (pumping) { setStatus('wait: files are still loading', true); return false; }
  const prev = lib.projectId;
  let cleared = false;
  lib.opening = true;
  setBusy(true);
  try {
    await flushAutosave({ whileOpening: true });
    // The save failed (storage full...): clearing the scene now would lose those edits.
    // A second attempt goes ahead without them (the visitor has been told).
    if (lib.saveFailed && prev && !lib.discardOk) {
      lib.discardOk = true;
      throw new Error('your current edits could not be saved (storage full?). Export them first, or choose again to continue without them');
    }
    // The old scene stays interactive while the new one loads (load-then-swap); edits made to
    // it meanwhile are saved just before it is cleared.
    const sig0 = editSig();
    const p = await lib.store.getProject(projectId);
    if (!p) throw new Error('that project is no longer in this browser');
    if (p.deletedAt) throw new Error(`"${p.title}" is deleted; restore it first`);
    lib.openingTitle = p.title;
    setStatus(`opening ${p.title}…`);
    const target = versionId && versionId !== p.workingVersionId ? await lib.store.getVersion(versionId) : null;
    if (target) await lib.store.checkout(projectId, versionId);
    const ver = await lib.store.getVersion(p.workingVersionId);
    const files = await filesForSources(ver.sources);
    const { groups } = await groupFiles(files);
    if (!groups.length) throw new Error('it has no files this page can load');
    const removeFirst = (ver.stats?.tris ?? 0) > SWAP_TRIS_MAX;
    cleared = removeFirst;
    await replaceScene(groups, removeFirst, async () => {
      if (prev && lib.projectId === prev && editSig() !== sig0) await saveWorkingNow(prev, { thumb: false, whileOpening: true });
    });
    cleared = true;
    setCurrent(p);
    lib.rev = ver.rev ?? 0;
    lib.pending = lib.saveFailed = lib.discardOk = false;
    lib.savedSeq = lib.changeSeq;
    lib.changedSinceVersion = !!ver.dirty;
    lib.editsPending = false;
    await polygonLoaded;   // its edit-log ops must be registered before the history is adopted
    const rep = applyProjectLayout(ver.layout, ver.extras);
    applyView(ver.extras?.view, rep.byRec);
    const sigOpened = lib.sig = editSig();
    setStatus(`opened ${p.title}${target ? ` (${target.label})` : ''}` +
      (rep.historyRestored ? `  ·  ${rep.historyRestored} edit${rep.historyRestored === 1 ? '' : 's'} restored, undo works` : '') +
      (rep.mismatches.length ? `  ·  ${rep.mismatches.length} layout mismatch${rep.mismatches.length === 1 ? '' : 'es'} (see console)` : ''));
    if (rep.mismatches.length) console.warn('layout mismatches:', rep.mismatches);
    // Cards opened for the first time (the seeded sample) get their thumbnail now.
    // #44: still "opening" until the thumbnail is stored, so a second open can't start here
    // (its load would run unguarded once this one finished, and this capture could be of it).
    if (!ver.thumbId || (target && !target.thumbId)) {
      // One frame for the swap to settle; the timeout because a hidden tab runs no frames.
      await new Promise((r) => { requestAnimationFrame(r); setTimeout(r, 100); });
      try {
        const blob = await takeThumb();
        if (blob) {
          if (!ver.thumbId) await lib.store.setThumb(ver.id, blob);
          if (target && !target.thumbId) await lib.store.setThumb(target.id, blob);
        }
      } catch (err) { console.warn('thumbnail not stored:', err); }   // the project is open; a missing card picture is not a failed open
    }
    lib.opening = false;
    lib.viewSig = viewSig();   // the view as opened is the saved one: no save until it changes
    if (editSig() !== sigOpened) scheduleAutosave();   // edits made during the thumbnail step
    return true;
  } catch (err) {
    console.warn('open failed:', err);
    setStatus(`could not open: ${err.message ?? err}`, true);
    // A failed load-then-swap never touched the old scene. Anything that did clear it puts the
    // previous project back (once: fallback=false stops a loop if that fails too).
    if (cleared && fallback && prev && prev !== projectId) {
      lib.opening = false;
      setCurrent(null);
      await openProject(prev, null, { fallback: false });
    } else if (cleared) setCurrent(null);
    return false;
  } finally {
    lib.opening = false;
    setBusy(false);
    refreshRing();
  }
}

// Returns false (and leaves the scene alone) when the current edits could not be saved.
async function closeProject({ save = true } = {}) {
  if (save) await flushAutosave();
  await lib.saving;
  if (save && lib.saveFailed && lib.projectId && !lib.discardOk) {
    lib.discardOk = true;
    setStatus('your current edits could not be saved (storage full?). Export them first, or try again to continue without them', true);
    return false;
  }
  lib.saveFailed = lib.discardOk = false;
  clearTimeout(lib.thumbTimer);
  lib.thumbTimer = null;
  setCurrent(null);
  lib.opening = true;    // removing items is not an edit to save
  try { clearScene(); } finally { lib.opening = false; }
  lib.sig = editSig();
  lib.changedSinceVersion = true;
  return true;
}

async function startNew() {
  lib.ring?.close();
  if (!await closeProject()) return;
  setStatus('new scene: drop scans or photos anywhere (they stay in this browser)');
  refreshRing();
  try { picker.click(); } catch { /* needs a user gesture; the drop zone still works */ }
}

// ---- ring cards ----
const fmtDate = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const fmtTris = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n ?? 0));

// The ring's cards. First card: "Drop your own scan". Deleted projects (and hidden samples)
// come last, badged, so 'restore' is reachable; they are purged after 30 days.
async function buildCards() {
  const list = await lib.store.listProjects({ includeDeleted: true });
  const cards = [{ id: NEW_CARD, title: 'Drop your own scan', subtitle: 'GLB, glTF, OBJ, PLY or photos. Stays in this browser.', badges: [], thumbUrl: null, sample: false, versions: [], currentVersionId: null }];
  const live = [], gone = [];
  for (const { project: p, versions } of list) {
    const working = versions.find((v) => v.type === 'working');
    const vcards = await Promise.all(versions.map(async (v) => ({
      id: v.id, label: v.label, type: v.type, date: v.updatedAt ?? v.createdAt, thumbUrl: await lib.store.thumbUrl(v.thumbId),
      badges: [...(v.dirty ? ['unsaved'] : []), ...(v.stats?.inferred ? ['inferred'] : []), ...(v.edits ? [`${v.edits} edit${v.edits === 1 ? '' : 's'}`] : [])]
    })));
    const st = working?.stats;
    const credit = versions.find((v) => v.provenance?.credit)?.provenance.credit ?? null;
    const badges = [];
    if (p.sample) badges.push('sample');
    if (p.id === lib.projectId) badges.push('open');
    if (p.deletedAt) badges.push('deleted');
    if (p.hidden) badges.push('hidden');
    if (st?.inferred) badges.push('inferred');
    const thumbUrl = vcards.find((v) => v.type === 'working')?.thumbUrl ?? [...vcards].reverse().find((v) => v.thumbUrl)?.thumbUrl ?? null;
    const card = {
      id: p.id, title: p.title, sample: p.sample, badges, thumbUrl, deleted: !!(p.deletedAt || p.hidden),
      kind: st?.room ? 'room' : 'object',
      // A stock sample's credit leads its subtitle: CC BY models must show their attribution
      // wherever they are shown (samples.js), and the ring is where people pick them.
      subtitle: [credit, st?.items != null ? `${st.items} item${st.items === 1 ? '' : 's'}` : null, st?.tris ? `${fmtTris(st.tris)} tris` : null, fmtDate(p.updatedAt)].filter(Boolean).join(' · '),
      versions: vcards, currentVersionId: working?.id ?? null
    };
    (card.deleted ? gone : live).push(card);
  }
  // The chair leads the ring (it is the reference scan; the stock samples were all seeded after
  // it, so recency alone would bury it behind them).
  live.sort((a, b) => (b.id === SAMPLE_ID) - (a.id === SAMPLE_ID));
  return cards.concat(live, gone);
}
let ringSeq = 0;
async function refreshRing(focusId) {
  if (!lib.ring || !lib.store) return;
  const seq = ++ringSeq;
  try {
    const cards = await buildCards();
    if (seq !== ringSeq) return;   // a newer refresh is on its way
    lib.ring.setProjects(cards);
    if (focusId) lib.ring.focus(focusId);
  } catch (err) { console.warn('library ring refresh failed:', err); }
}

async function onRingChoose({ projectId, versionId }) {
  if (projectId === NEW_CARD) return startNew();
  const p = await lib.store.getProject(projectId);
  lib.ring?.close();
  if (projectId === lib.projectId && (!versionId || versionId === p?.workingVersionId)) return;   // already open
  await openProject(projectId, versionId);
}
async function onRingAction({ type, projectId, versionId, title }) {
  const S = lib.store;
  if (type === 'new') return startNew();
  if (!projectId || projectId === NEW_CARD) return;
  if (type === 'delete') {
    if (projectId === lib.projectId) await flushAutosave();
    const how = await S.softDelete(projectId);
    if (how === 'deleted' && projectId === lib.projectId) { await closeProject({ save: false }); remember(null); }
    setStatus(how === 'hidden' ? 'sample hidden; restore it from the library' : 'project deleted; restore it from the library within 30 days');
  } else if (type === 'restore') {
    await S.restore(projectId);
    setStatus('project restored');
  } else if (type === 'fork') {
    if (projectId === lib.projectId) await flushAutosave();
    const p = await S.fork(projectId, versionId);
    lib.ring?.close();
    await openProject(p.id);
    return refreshRing(p.id);
  } else if (type === 'rename') {
    const p = await S.rename(projectId, title);
    if (projectId === lib.projectId) lib.title = p.title;
  }
  return refreshRing(projectId);
}

async function setupRing() {
  // library-test.html runs this page in an iframe with ?ring=stub and a recording stub ring.
  const stub = params.get('ring') === 'stub' && window.parent !== window ? window.parent.__hologramRingStub : null;
  let createRing = stub ?? null;
  if (!createRing) {
    if (!$('libraryRing')) return null;   // ring markup not on this page
    try { ({ createRing } = await import('./ring.js' + V)); } catch (err) { console.warn('library ring unavailable:', err.message); return null; }
  }
  const ring = createRing({ THREE, scene, camera, renderer, controls, root: $('libraryRing'), list: $('libraryList') });
  ring.on('choose', (e) => onRingChoose(e).catch((err) => reportStoreError('opening', err)));
  ring.on('action', (e) => onRingAction(e).catch((err) => reportStoreError(e?.type ?? 'library', err)));
  ring.on('close', () => { if (!readyItems().length && !lib.projectId) setStatus('drop scans or photos anywhere, or open the library'); });
  return ring;
}

async function seedSample() {
  const src = (id) => {
    const m = MODELS.find((x) => x.id === id);
    const url = '../' + (m.glbPath ?? m.objPath);
    return [{ url, name: url.split('/').pop() }];
  };
  // Sources are URLs: the sample's bytes stay on the site, never copied into the visitor's storage.
  return lib.store.seedSample({
    key: 'chair', title: 'Chair', versions: [
      { label: 'Raw scan', type: 'original', sources: src('chair-raw'), provenance: { note: 'Scaniverse capture as exported' } },
      { label: 'Clean', type: 'edited', sources: src('chair'), provenance: { note: 'clean_scan.py: floor removed by surface identity, gaps mirrored from measured geometry' } },
      { label: 'Detail', type: 'edited', sources: src('chair-detail'), provenance: { note: 'completion/detail.py + bake_parts.py: denoised, real colours, 8 named parts (nothing inferred)' } }
    ]
  });
}

// Thumbnails for seeded versions nobody has opened yet: each scan is parsed into a scratch
// scene (never the live one) and shot once with the hologram look. One at a time, after
// landing, since parsing a 15 MB scan blocks the page for a moment.
async function offscreenThumb(sources) {
  const { groups } = await groupFiles(await filesForSources(sources));
  const s = new THREE.Scene();
  s.background = scene.background;
  s.add(new THREE.HemisphereLight(0xffffff, 0x33343f, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 4, 3);
  s.add(key);
  const roots = [], box = new THREE.Box3();
  try {
    for (const g of groups) {
      if (g.kind !== 'scan') continue;
      const { object } = await parseGroup(g);
      const root = new THREE.Group();
      root.add(object);
      const { box: b } = placeOnFloor(root);
      if (roots.length) { root.position.x += box.max.x + GAP - b.min.x; root.updateMatrixWorld(true); }
      box.union(new THREE.Box3().setFromObject(root));
      root.traverse((c) => { if ((c.isMesh || c.isPoints) && !c.userData.original) c.userData.original = c.material; });
      look.prepare(root);
      root.traverse((c) => { if (c.isMesh) c.material = look.materialFor(c, 'base'); else if (c.isPoints) c.material = pointsMaterial; });
      s.add(root);
      roots.push(root);
    }
    if (!roots.length) return null;
    const cam = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    const target = new THREE.Vector3();
    frameSingle(box, cam, { target, update() { cam.lookAt(target); } });
    return await exporter.renderThumbnail(exportCtx, 256, { scene: s, camera: cam });
  } finally {
    roots.forEach(disposeRoot);
  }
}
async function ensureSampleThumbs() {
  // Every seeded sample (the chair first: it is the card people land on), one after another.
  const all = (await lib.store.listProjects({ includeDeleted: true })).filter((x) => x.project.sample);
  all.sort((a, b) => (b.project.id === SAMPLE_ID) - (a.project.id === SAMPLE_ID));
  for (const entry of all) await ensureThumbsOf(entry);
}

async function ensureThumbsOf(entry) {
  for (const v of entry.versions) {
    if (v.thumbId || v.type === 'working') continue;
    while (lib.opening || pumping) await new Promise((r) => setTimeout(r, 500));
    const fresh = await lib.store.getVersion(v.id);
    if (fresh?.thumbId) continue;   // opened meanwhile, which took a live thumbnail
    const t0 = performance.now();
    try {
      const blob = await offscreenThumb(v.sources);
      if (blob) await lib.store.setThumb(v.id, blob);
      console.info(`sample thumbnail "${v.label}": ${Math.round(performance.now() - t0)} ms`);
    } catch (err) { console.warn(`sample thumbnail "${v.label}" failed:`, err); }
    refreshRing();
    await new Promise((r) => setTimeout(r, 250));
  }
  // The working copy shows the version it starts from until it is opened.
  const w = await lib.store.getVersion(entry.project.workingVersionId);
  if (w && !w.thumbId && w.parentId) {
    const parent = await lib.store.getVersion(w.parentId);
    const url = await lib.store.thumbUrl(parent?.thumbId);
    if (url) await lib.store.setThumb(w.id, await (await fetch(url)).blob());
    refreshRing();
  }
}

// ---- unsaved edits at reload / tab close --------------------------------------------------
// An IndexedDB write started in pagehide never commits (the page is gone between its request
// hops), so the pending working copy is also stashed synchronously in localStorage and written
// on the next start, before the last project reopens. Same revision check as autosave: if
// another tab changed the project meanwhile, the stash becomes a new project instead.
const RESCUE_PREFIX = `hologram-platform-rescue:${dbName}:`;
function stashForUnload() {
  if (!lib.store || !lib.projectId || lib.opening || lib.changeSeq === lib.savedSeq) return;
  try {
    localStorage.setItem(RESCUE_PREFIX + lib.projectId, JSON.stringify({
      projectId: lib.projectId, title: lib.title, rev: lib.rev, at: Date.now(), dirty: lib.editsPending,
      layout: exporter.buildLayout(exportCtx), extras: sceneExtras(), stats: sceneStats(), sources: currentSources()
    }));
  } catch (err) { console.warn('could not stash unsaved edits:', err); }
}
function dropRescue(projectId) { try { localStorage.removeItem(RESCUE_PREFIX + projectId); } catch { /* private mode */ } }
async function applyRescues() {
  let keys = [];
  try { keys = Object.keys(localStorage).filter((k) => k.startsWith(RESCUE_PREFIX)); } catch { return; }
  for (const k of keys) {
    let r = null;
    try { r = JSON.parse(localStorage.getItem(k)); } catch { /* corrupt: dropped below */ }
    try {
      if (r?.projectId && r.layout) {
        try {
          await lib.store.saveWorking(r.projectId, { layout: r.layout, extras: r.extras, stats: r.stats, sources: r.sources, baseRev: r.rev, dirty: r.dirty ?? true });
          console.info(`restored unsaved edits to "${r.title}"`);
        } catch (err) {
          if (err?.code !== 'conflict' && err?.code !== 'gone') throw err;
          await lib.store.createProject({ title: `${r.title} (recovered edits)`, kind: 'scene', sources: r.sources, layout: r.layout, extras: r.extras, stats: r.stats, provenance: { app: 'platform', from: 'recovered' } });
          console.info(`unsaved edits to "${r.title}" kept as a new project (it changed meanwhile)`);
        }
      }
      localStorage.removeItem(k);
    } catch (err) { console.warn('could not restore unsaved edits:', err); }   // kept for the next start
  }
}

async function landing() {
  if (startModel) return;   // ?model= is a direct-load hook for live checks
  let last = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* private mode: treat as a first visit */ }
  if (last) {
    const p = await lib.store.getProject(last).catch(() => null);
    if (p && !p.deletedAt && await openProject(last, null, { fallback: false })) return;
  }
  if (lib.ring) { await refreshRing(); lib.landingRing = true; lib.ring.open(); }
}

async function initLibrary() {
  try {
    lib.store = await openStore({ name: dbName });
  } catch (err) {
    console.warn('library storage unavailable:', err);
    setStatus('saving is off: this browser blocked local storage (private window?)', true);
    return;
  }
  try { await seedSample(); } catch (err) { console.warn('sample seed failed:', err); }
  // The stock samples (samples.js, shared with the gesture demo's carousel). Seeding is
  // idempotent; one failure must not stop the library from opening.
  try {
    const { sampleSeeds } = await import('../samples.js' + V);
    // Seeded last-first: the ring lists newest first, so they then show in samples.js order.
    for (const seed of sampleSeeds('../').reverse()) await lib.store.seedSample(seed);
  } catch (err) { console.warn('stock sample seed failed:', err); }
  await applyRescues();
  lib.store.purgeExpired(30).then((n) => { if (n.projects || n.blobs) console.info('library purge:', n); }).catch(() => {});
  lib.ring = await setupRing();
  await landing();
  lib.thumbsDone = new Promise((r) => setTimeout(r, 1500)).then(ensureSampleThumbs).catch((err) => console.warn('sample thumbnails:', err));
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();   // not the browser's "save page"
    if (!e.repeat) saveVersionNow();   // holding the keys down saves once
  }
});
$('saveVersionBtn')?.addEventListener('click', () => saveVersionNow());
// #51: orbit / pan / zoom (mouse, hands, Focus, auto-rotate) are saved too, on the same debounce.
controls.addEventListener('change', () => noteView());
// Leaving or hiding the tab: don't sit on an unsaved edit for the rest of the debounce.
// No thumbnail then: its async toBlob would push the write past a reload / tab close.
// The localStorage stash covers a reload / close, where the IndexedDB write can't finish.
document.addEventListener('visibilitychange', () => { if (document.hidden) { stashForUnload(); flushAutosave({ thumb: false }); } });
window.addEventListener('pagehide', () => { stashForUnload(); flushAutosave({ thumb: false }); });

window.hologram.library = {
  open: openProject, close: closeProject, saveVersion: saveVersionNow, flush: flushAutosave, cards: buildCards, startNew,
  state: () => ({ projectId: lib.projectId, title: lib.title, sample: lib.sample, opening: lib.opening, pending: lib.pending, dbName }),
  get store() { return lib.store; }, get ring() { return lib.ring; }, get thumbsDone() { return lib.thumbsDone; }
};

// ---- drop / pick ---------------------------------------------------------------------------
// Drop anywhere: listen on window and cancel dragover, or the browser navigates to the file.
const dropEl = $('drop');
let depth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; dropEl.classList.add('on'); });
window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dropEl.classList.remove('on'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  depth = 0;
  dropEl.classList.remove('on');
  const files = await filesFromDrop(e.dataTransfer); // entries are read synchronously inside
  if (files.length) loadFiles(files);
});

const picker = $('picker'), folderPicker = $('folderPicker');
picker.accept = ACCEPT;
$('pick').addEventListener('click', () => picker.click());
$('folder').addEventListener('click', () => folderPicker.click());
for (const p of [picker, folderPicker]) {
  p.addEventListener('change', () => { if (p.files.length) loadFiles([...p.files]); p.value = ''; });
}
// The sample is a library project (3 versions); without storage it still loads directly.
// The landing ring closes like any other way into a model (onRingChoose, loadFiles do the same).
$('sample').addEventListener('click', () => {
  lib.ring?.close();
  return lib.store ? openProject(SAMPLE_ID) : loadUrl('../assets/chair/chair_detail.glb');
});
// ?model=<url> loads a model on open (e.g. a completed scan and its sidecar for a live check).
const startModel = params.get('model');
if (startModel) loadUrl(startModel, { project: false });

window.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  // Esc = the Done button (the polygon lens and the ring take their own Esc first).
  if (k === 'escape') { if (exitTool()) e.preventDefault(); return; }
  if (k === 'r') controls.autoRotate = !controls.autoRotate;
  else if (k === 'p') togglePolygon();   // P: polygon lens on the selected item
  else if (k === 'i' && hasInferred()) setShowInferred(!look.showInferred);   // I: inferred on/off
});


lib.ready = initLibrary();
window.hologram.library.ready = lib.ready;

// ---- the active tool: which one you're in, and how to get out (Hands v2 #12, #13) --------------
// One answer for the chip, the Done button, the wheel's centre and Esc. Pin is a one-step action
// on the selection (📌 chip / K / wheel ↖), never a mode, so it has no Done.
function activeTool() {
  if (polygon?.active) return 'polygon';
  if (lib.ring?.isOpen?.()) return 'ring';
  return 'none';
}
// exitTool() -> what it left ('polygon' | 'ring' | 'wheel') or null when already in free move.
// The one host function the Done buttons, Esc and the wheel centre call; the open-palm "done"
// gesture (inputArbiter.js, CONTRACT section 2.2) will call it too.
function exitTool() {
  let left = null;
  const w = window.hologram.hands?.runtime?.wheel;
  if (w?.isOpen) { w.close('api'); left = 'wheel'; }
  const tool = activeTool();
  if (tool === 'polygon') polygon.exit();
  else if (tool === 'ring') lib.ring.close();
  if (tool !== 'none') { left = tool; setStatus(`✋ Done · ${TOOLS[tool].name} off · free move`); }
  return left;
}
window.hologram.exitTool = exitTool;
window.hologram.activeTool = activeTool;
toolStatus = createToolStatus({ chip: $('toolChip'), done: $('doneBtn'), onDone: () => exitTool() });
function updateTool() {
  const tool = activeTool();
  // The ring on the landing screen is where you start, not a tool you can leave: no Done there.
  // Once it closes the flag is spent, so a ring opened later (wheel, button) gets its Done.
  if (tool !== 'ring') lib.landingRing = false;
  // The polygon lens carries its own Done in its action bar: one Done on screen, not two.
  toolStatus?.set(tool, { done: tool !== 'polygon' && !lib.landingRing });
}

// ---- Hands (hands.js, P1 step 2) ---------------------------------------------------------------
// The Camera button; the shared hands runtime loads on first press (or on load, when the camera
// was remembered and is already allowed). Aim = hover, click = select, both through objectMode;
// the hand cursor also works the page (handUI.js). With the Library ring up, aim + pinch opens a
// card and a fist spins it; with the polygon lens on, the lens follows the hand (hands.js).
const { createPlatformHands } = await import('./hands.js' + V);
window.hologram.hands = createPlatformHands({
  scene, camera, renderer, controls, objectMode, getItems: readyItems, setStatus,
  button: $('handsBtn'), expose: window.hologram,
  ring: () => lib.ring, polygon: () => polygon, resetView: () => frameAll(), helpEl: $('guide'),
  // Hands v2 (?hands=v2 only; hands.js wireHandsV2): the tool sets the arbiter's scope, the
  // open-palm Done is the Done button, thumbs-down is the Undo button.
  activeTool: () => activeTool(), chipAfter: $('toolChip'),
  onDone: () => {
    // The landing ring is where you start, not a tool to leave (no Done button there either).
    if (activeTool() === 'ring' && lib.landingRing) { setStatus('✋ Pick a project first · swipe to browse, aim + click (or a fist) opens one'); return; }
    // Nothing to leave: furniture is always upright on the Platform, so there's nothing to snap.
    if (!exitTool()) setStatus('✋ Done · free move');
  },
  onUndo: () => {
    if (undoBtn.disabled) { setStatus('Nothing to undo'); return; }
    objectMode.undo(); syncLibrary(); setStatus('↶ Undone · 👎 again undoes the step before');
  },
  // The ✌ tool wheel (toolWheel.js, HANDS-UX-SPEC section 4): the same slot meanings as
  // hologram.html (toolWheel.js SLOTS). Centre = Done while a tool is on, else Help.
  toolWheel: () => [
    { dir: 'up', ...slot('up'), run: () => { objectMode.undo(); syncLibrary(); } },
    { dir: 'down', ...slot('down'), run: () => frameAll() },
    { dir: 'upRight', ...slot('upRight', 'platform'), run: () => $('measureBtn').click() },
    { dir: 'downRight', ...slot('downRight', 'platform'), run: () => togglePolygon(), enabled: () => !polyBtn.disabled },
    { dir: 'downLeft', ...slot('downLeft', 'platform'), run: () => { if (lib.ring) refreshRing().then(() => lib.ring.open()); }, enabled: () => !!lib.ring },
    { dir: 'upLeft', ...slot('upLeft', 'platform'), run: () => objectMode.togglePin() },
    { dir: 'center', icon: () => slot('center', activeTool() === 'none' ? 'none' : 'tool').icon,
      label: () => slot('center', activeTool() === 'none' ? 'none' : 'tool').label,
      run: () => (activeTool() === 'none' ? $('help').click() : exitTool()) }
  ]
});
// W: the ✌ tool wheel at the screen centre for mouse / keyboard users (click a slot).
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'w' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '')) return;
  const w = window.hologram.hands.runtime?.wheel;
  if (w) (w.isOpen ? w.close('api') : w.open());
});
// Not in tests (?db=...): a test page must never turn a real camera on by itself.
if (!params.get('db')) lib.ready.then(() => window.hologram.hands.autoStart()).catch((err) => console.warn('hands: auto-start', err));

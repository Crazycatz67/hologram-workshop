// See hands.js: the entry point stamps a version onto this module's URL, and passing it
// along is what stops GitHub Pages' ten-minute cache from serving stale code.
const V = new URL(import.meta.url).search;

const THREE = await import('three');
const { createScene, startRenderLoop } = await import('../scene.js' + V);
const { createLook } = await import('./look.js' + V);
const { groupFiles, parseGroup, countTriangles, sha256Hex, filesFromDrop, ACCEPT } = await import('./upload.js' + V);
const { createLibrary } = await import('./library.js' + V);
const exporter = await import('./export.js' + V);
const { splitComponents } = await import('./segment.js' + V);
const { createObjectMode } = await import('./objectmode.js' + V);
const { placeOnFloor, frameRoom, frameSingle, ROOM_THRESHOLD_M } = await import('./framing.js' + V);

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const fpsEl = $('fps');
const infoEl = $('info');

const { scene, camera, renderer, controls } = createScene();

// Every hologram material comes from look.js: photosafe (WCAG flash limit, no additive
// bloom, smoothed shading on rough scans), with the Realism / Motion controls.
const look = createLook({ scene, mount: $('look') });
const hologramMaterial = look.parents.base;
const plainMaterial = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, roughness: 0.6, metalness: 0.0 });
const pointsMaterial = new THREE.PointsMaterial({ color: 0x4fd1ff, size: 0.01 });

// Object-mode highlights (hover pale cyan, selection amber) live in look.js too, so they
// share the realism blend and the safety settings; these are the plain-mode equivalents.
const hoverPlain = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, emissive: 0x2f8fb0, roughness: 0.6 });
const selectedPlain = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, emissive: 0xb07020, roughness: 0.6 });

const edits = [];
// items: id -> library item. Shape (also what export.js reads):
//   { id, name, sourceFile, fileSize, sha256, kind:'scan'|'photo', status, root:Group,
//     parts:[{id:'<item>.<local>', local, mesh}], tris, points }
// root carries the item transform (floor placement / arrange); parts sit under it.
const items = new Map();
window.hologram = { scene, camera, renderer, controls, model: null, material: hologramMaterial, edits, items };

startRenderLoop({
  renderer, scene, camera, controls,
  onFrame: (fps) => { fpsEl.textContent = `${fps} fps`; },
  onTick: () => {
    look.update();
    objectMode.tick();
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
      if (c.isMesh) c.material = plain ? plainMaterial : look.materialFor(c, 'base');
      else if (c.isPoints) c.material = pointsMaterial;
    });
  }
  objectMode.refresh(); // re-applies hover/selected tints on top of the base look
  plainBtn.textContent = plain ? 'Hologram look' : 'Plain material';
}
plainBtn.addEventListener('click', () => { plain = !plain; applyMaterials(); });

function materialFor(kind, mesh) {
  if (plain) return kind === 'hover' ? hoverPlain : kind === 'selected' ? selectedPlain : plainMaterial;
  return look.materialFor(mesh, kind);
}

const modeBtn = $('mode'), undoBtn = $('undo'), showAllBtn = $('showall');
const partsEl = $('parts'), selEl = $('sel');
const objectMode = createObjectMode({
  camera, canvas: renderer.domElement, controls, materialFor, edits,
  onChange: (st) => {
    modeBtn.textContent = st.mode === 'object' ? 'Mode: OBJECT (Tab)' : 'Mode: SCENE (Tab)';
    modeBtn.classList.toggle('active', st.mode === 'object');
    partsEl.textContent = `${st.parts} selectable part${st.parts === 1 ? '' : 's'}`;
    selEl.textContent = st.selection
      ? `selected #${st.selection.id}  ·  ${st.selection.size.map((n) => n.toFixed(2)).join(' × ')} m (W×D×H)`
      : st.mode === 'object' ? 'nothing selected' : '';
    selEl.style.display = selEl.textContent ? '' : 'none';
    undoBtn.disabled = st.edits === 0;
    showAllBtn.disabled = st.hidden === 0;
    showAllBtn.textContent = st.hidden ? `Show all (${st.hidden} hidden)` : 'Show all';
  }
});
window.hologram.objectMode = objectMode;
modeBtn.addEventListener('click', () => objectMode.toggleMode());
undoBtn.addEventListener('click', () => { objectMode.undo(); syncLibrary(); });
showAllBtn.addEventListener('click', () => objectMode.showAll());
plainBtn.textContent = plain ? 'Hologram look' : 'Plain material';

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

const library = createLibrary($('library'), {
  onToggle(id) {
    const it = items.get(id);
    if (!it) return;
    it.root.visible = !it.root.visible;
    if (String(objectMode.selectedId ?? '').startsWith(`${id}.`)) objectMode.select(null);
    syncLibrary();
    objectMode.refresh();
  },
  onFocus(id) { const it = items.get(id); if (it) frameBoxOf(drawnBox(it.root)); },
  onRemove(id) { removeItem(id); }
});
function syncLibrary() {
  for (const it of items.values()) library.update(it.id, { visible: it.root.visible });
  updateInfo();
}

function updateInfo() {
  const ready = readyItems();
  const tris = ready.reduce((n, i) => n + i.tris, 0);
  infoEl.textContent = ready.length ? `${ready.length} item${ready.length === 1 ? '' : 's'}  ·  ${tris.toLocaleString()} tris` : '';
}

function removeItem(id) {
  const it = items.get(id);
  if (!it) return;
  objectMode.removeItem(id);
  scene.remove(it.root);
  it.root.traverse((c) => {
    c.geometry?.dispose();
    const m = c.userData.original;
    if (m) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose?.(); }
  });
  items.delete(id);
  library.remove(id);
  const first = readyItems()[0];
  window.hologram.model = first ? first.root : null;
  updateInfo();
  setStatus(`removed ${it.name}`);
}

let nextId = 1;
const GAP = 0.3; // metres between items when auto-placing / arranging

// Builds the item's root + parts from a parsed scan or a photo mesh, then places it in the scene.
async function buildItem(id, group, onProgress) {
  let root, parts, ms = 0, components = 0;
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
    const seg = splitComponents(obj);
    root = seg.root; parts = seg.parts; ms = seg.ms; components = seg.components;
  }
  root.name = group.name;
  // Keep the loaded material (textures, vertex colours) before any hologram material replaces it.
  root.traverse((c) => { if ((c.isMesh || c.isPoints) && !c.userData.original) c.userData.original = c.material; });

  onProgress('placing', 0.85);
  const others = readyItems().filter((i) => i.root.visible);
  const { box } = placeOnFloor(root);
  if (others.length) { // first item stays as-is (centred, floor at y=0); later ones go beside it
    const room = new THREE.Box3();
    others.forEach((i) => room.union(drawnBox(i.root)));
    root.position.x += room.max.x + GAP - box.min.x;
    root.updateMatrixWorld(true);
  }
  const { tris, points } = countTriangles(root);
  return { root, parts, tris, points, ms, components };
}

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
      const sha256 = await sha256Hex(group.main);
      const item = {
        id, name: group.name, sourceFile: group.main.name, fileSize: group.main.size, sha256, kind: group.kind,
        status: 'ready', root: built.root, tris: built.tris, points: built.points,
        parts: built.parts.map(({ mesh }, i) => ({ id: `${id}.${i + 1}`, local: i + 1, mesh }))
      };
      for (const p of item.parts) { p.mesh.userData.itemId = id; p.mesh.userData.partId = p.id; }
      items.set(id, item);
      scene.add(item.root);
      objectMode.addParts(item.parts.map(({ id: pid, mesh }) => ({ id: pid, mesh })));
      applyMaterials();
      window.hologram.model ??= item.root;
      library.update(id, { status: 'ready', message: '', tris: built.tris, points: built.points, progress: 1 });
      frameAll();
      updateInfo();
      window.hologram.stats = { name: group.name, tris: built.tris, points: built.points, parts: item.parts.length, components: built.components, splitMs: built.ms, parseMs: performance.now() - t0 };
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

async function loadFiles(files) {
  const { groups, ignored } = await groupFiles(files);
  if (!groups.length) {
    setStatus(`nothing to load (${[...files].map((f) => f.name).join(', ') || 'no files'}) -- use .glb .gltf .obj .ply or photos`, true);
    return;
  }
  const p = enqueue(groups);
  if (ignored.length) console.info('ignored files (not a model, texture or photo):', ignored.join(', '));
  await p;
}
window.loadScanFiles = loadFiles;

async function loadUrl(url) {
  setStatus('loading…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const blob = await res.blob();
    await loadFiles([new File([blob], url.split('/').pop())]);
  } catch (err) {
    setStatus(err.message, true);
  }
}
window.loadScanUrl = loadUrl;

// ---- arrange -----------------------------------------------------------------------------
function arrangeAll() {
  const list = readyItems();
  if (!list.length) return setStatus('nothing to arrange', true);
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
  for (const m of moves) { m.it.root.position.x += m.dx; m.it.root.position.z += m.dz; m.it.root.updateMatrixWorld(true); }
  objectMode.record(
    { op: 'arrange', items: moves.map((m) => ({ item: m.it.id, dx: m.dx, dz: m.dz })) },
    () => moves.forEach((m) => m.it.root.position.copy(m.from))
  );
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
$('sample').addEventListener('click', () => loadUrl('../assets/chair/chair_clean.obj'));

window.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, textarea')) return;
  if (e.key.toLowerCase() === 'r') controls.autoRotate = !controls.autoRotate;
});

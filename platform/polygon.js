// Polygon mode: see and select the scan's REAL triangles, non-destructively.
//
// Entering the mode turns the whole target (the selected item, or the whole scene) into its
// triangle form at once (BUGS #46): the hologram eases to a faint skin and a calm full wire
// covers every part (a simplification sized so triangles are ~8 px on screen, <= 120k drawn;
// zooming in reaches the real triangles). The lens below then picks real faces.
// A lens circle follows the mouse over one library item. Inside it the item's own triangles
// are drawn as a calm barycentric wireframe (dimmer and dashed on inferred faces). Click
// selects the faces in the lens as a "patch", Shift-click adds to it; Delete hides the patch,
// I marks / unmarks it as inferred. Both edits go into objectmode's edit log (one undo step
// each, Ctrl/Cmd+Z), so they replay, export and autosave with every other edit.
//
// NON-DESTRUCTIVE (owner decision 2026-10-01). `mesh.geometry` is never modified: lod.js and
// measurements / export / raycasts rely on it being the full scan at all times. Instead:
//   * hidden faces: inside render() only, an edited mesh shows a DISPLAY geometry that shares
//     every vertex buffer with the full one and has an index without the hidden faces
//     (wrapRender; the same trick lod.js uses). Its LOD is parked for that frame, so lod.js
//     never sees a geometry it didn't build (otherwise it rebuilds every frame). Edited parts
//     therefore draw at full detail.
//   * relabelled faces (scanned <-> inferred) are left out of that display index too and drawn
//     by an OVERLAY mesh (same vertex buffers) whose userData.inferred is the new label, so
//     look.js gives it the right material: inferred geometry stays visibly marked.
//
// CONTRACT
//   createPolygonMode({ scene, camera, canvas, objectMode, getItem, getItems?, materialFor,
//                       prepassLayer?, onChange?, onSkin? }) -> api
//     getItems() -> every ready item (whole-scene mode)
//     onSkin(k)  hologram skin opacity factor, eased 1 -> SKIN_FAINT -> 1 (look.setSkin)
//     getItem(itemId) -> { id, name, root, parts:[{ id, mesh }] } | null
//     materialFor(mesh) -> the base material the page would give `mesh` (plain or hologram)
//     prepassLayer  camera layer of the single-layer depth pre-pass (lod.js PREPASS_LAYER)
//   api.enter(itemId|null) -> bool   null = whole scene; builds BVHs (lazily, once per mesh), shows wire + lens
//   api.exit()                  hides the lens, keeps the edits
//   api.active, api.itemId, api.radius (CSS px, settable; clamped to RADIUS_MIN..RADIUS_MAX)
//   api.setPointer(clientX, clientY) / api.clearPointer()   (the canvas listeners call these)
//   api.select({ add }) -> patch summary      faces in the lens become (or join) the patch
//   api.clearPatch(); api.hidePatch() -> entry|null; api.toggleInferredPatch() -> entry|null
//   api.tick()                  once per frame: lens follows pointer / camera, overlays follow parts
//   api.wrapRender(fn) -> fn'   render wrapper that swaps in the display geometries
//   api.refreshMaterials()      after the page's look changes (Plain / Hologram)
//   api.state() -> { active, item, name, radius, bvhMs, lens:S|null, patch:S|null,
//                    wire:{ shown, total, fade }, skin }
//                  S = { faces, area (m^2, world), inferredPct (by area, 0..100) }
//   api.faceState(mesh) -> { faces, hidden:Uint8Array, inferred(face)->bool } (tests)
//   Edit-log ops (registered with objectMode.registerOp):
//     { op:'polyHide',  item, part:null, faces:N, polys:[{ part, faces:[i...] }] }
//     { op:'polyInfer', item, part:null, faces:N, to:0|1, polys:[{ part, faces:[i...], prev:[0|1...] }] }
//     Face i = triangle i of the part's full geometry (index order, or vertex order if unindexed).
//   Failure: an item with no meshes (point cloud) -> enter() returns false; an entry whose
//   part no longer exists is skipped on apply.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
// Same version stamp as the page's own imports, so these are the page's module instances.
const V = new URL(import.meta.url).search;
const { createLensMaterial, createPatchMaterial, createWireDepthMaterial, SKIN_FAINT } = await import('./look.js' + V);
const { loadSimplifier } = await import('./parts.js' + V);
const { wheelPixels } = await import('./objectmode.js' + V);

export const RADIUS_MIN = 12, RADIUS_MAX = 400, RADIUS_DEFAULT = 70;   // CSS px
const RADIUS_PER_NOTCH = 0.15;      // x exp(0.15) = 1.16 per wheel notch
const NOTCH_PX = 100;
const CLICK_PX = 3;                 // same drag threshold as objectmode
const MAX_LENS_FACES = 60000;       // draw cap; the read-out still counts every face
const FADE_MS = 180;                // lens eases in/out, never pops (BUGS #14)
// Full wire (BUGS #46): the whole target drawn as triangles while the mode is on.
export const WIRE_BUDGET = 120_000; // drawn wire triangles at most (same budget as lod.js)
export const WIRE_EDGE_PX = 8;      // pick the finest level whose triangles are >= this on screen
const WIRE_HYST = 1.2;              // level hysteresis (levels are ~2x apart in edge length)
const WIRE_MIN_TRIS = 400;          // stop simplifying below this
const WIRE_FADE_MS = 900;           // wire fades in / skin fades back, eased, never pops (on/off
                                    // toggled at any rate stays <= 2 flashes/s: polygon-test F)

const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
const inScene = (o, scene) => { for (; o; o = o.parent) if (o === scene) return true; return false; };

export function createPolygonMode({ scene, camera, canvas, objectMode, getItem, getItems = () => [], materialFor, prepassLayer = null, onChange, onSkin }) {
  const group = new THREE.Group();
  group.name = 'polygon-mode';
  scene.add(group);
  const states = new WeakMap();     // mesh -> per-mesh face state (ms)
  const edited = new Set();         // ms with hidden or relabelled faces (display / overlay live)
  let active = false, itemId = null, radius = RADIUS_DEFAULT, bvhMs = 0;
  let pointer = null;               // { x, y } client px, or null when off the canvas
  let lens = new Map();             // ms -> number[] faces in the lens
  let patch = new Map();            // ms -> Set<face>
  let lensSig = '', fade = 0, fadeTarget = 0, lastT = performance.now();
  let down = null;
  const patchHolders = new Set();   // ms with a patch mesh in the scene

  // ---- per-mesh face state --------------------------------------------------------------------
  function stateOf(mesh) {
    let ms = states.get(mesh);
    if (ms) return ms;
    const g = mesh.geometry;
    if (!g?.attributes?.position) return null;
    const tri = g.index ? Uint32Array.from(g.index.array) : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
    const faces = Math.floor(tri.length / 3);
    ms = {
      mesh, partId: mesh.userData.partId ?? null, tri, faces, full: g,
      origInferred: !!mesh.userData.inferred,
      hidden: new Uint8Array(faces), flip: new Uint8Array(faces),
      bvh: null, display: null, overlay: null, patchMesh: null
    };
    states.set(mesh, ms);
    return ms;
  }
  const inferredFace = (ms, f) => ms.origInferred !== !!ms.flip[f];

  function ensureBvh(ms) {
    if (ms.bvh) return ms.bvh;
    // A private geometry (shared positions, a copy of the index) so the BVH never reorders
    // anything the page draws; indirect keeps face numbers = index order.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', ms.full.attributes.position);
    geo.setIndex(new THREE.BufferAttribute(ms.tri, 1));
    ms.bvh = new MeshBVH(geo, { indirect: true });
    return ms.bvh;
  }

  // id null = the whole scene (every ready item).
  const partsOf = (id) => (id == null ? getItems() : [getItem(id)]).flatMap((it) => it?.parts ?? []).map((p) => p.mesh).filter((m) => m?.isMesh);

  // ---- display geometry + overlay (the non-destructive edits) --------------------------------
  function rebuild(ms) {
    const keep = [], other = [];
    for (let f = 0; f < ms.faces; f++) {
      if (ms.hidden[f]) continue;
      (ms.flip[f] ? other : keep).push(f);
    }
    const anyEdit = keep.length !== ms.faces;
    const subset = (list) => {
      const idx = new Uint32Array(list.length * 3);
      list.forEach((f, i) => { idx[i * 3] = ms.tri[f * 3]; idx[i * 3 + 1] = ms.tri[f * 3 + 1]; idx[i * 3 + 2] = ms.tri[f * 3 + 2]; });
      const g = new THREE.BufferGeometry();
      for (const k in ms.full.attributes) g.setAttribute(k, ms.full.attributes[k]);
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      if (!ms.full.boundingSphere) ms.full.computeBoundingSphere();
      if (!ms.full.boundingBox) ms.full.computeBoundingBox();
      g.boundingSphere = ms.full.boundingSphere;   // a subset of the same vertices
      g.boundingBox = ms.full.boundingBox;
      return g;
    };
    // Shared buffers stay alive: drop our index only (same handover rule as lod.js dropLod).
    const drop = (g) => { if (g) { g.attributes = {}; g.dispose(); } };
    drop(ms.display); ms.display = anyEdit ? subset(keep) : null;
    if (other.length) {
      if (!ms.overlay) {
        ms.overlay = new THREE.Mesh();
        ms.overlay.matrixAutoUpdate = false;
        ms.overlay.name = 'polygon-relabelled';
        group.add(ms.overlay);
      }
      drop(ms.overlay.geometry?.isBufferGeometry && ms.overlay.geometry.index ? ms.overlay.geometry : null);
      ms.overlay.geometry = subset(other);
      ms.overlay.userData = { inferred: !ms.origInferred, original: ms.mesh.userData.original, polygonOverlay: true };
      ms.overlay.material = materialFor(ms.overlay);
    } else if (ms.overlay) {
      drop(ms.overlay.geometry); group.remove(ms.overlay); ms.overlay = null;
    }
    if (anyEdit) edited.add(ms); else edited.delete(ms);
    ms.wire = null; wireSig = '';
    lensSig = '';
  }

  // ---- edit-log ops ---------------------------------------------------------------------------
  const meshFor = (item, part) => objectMode.resolve(item, part);
  objectMode.registerOp('polyHide', (e, which) => {
    for (const p of e.polys ?? []) {
      const mesh = meshFor(e.item, p.part); const ms = mesh?.isMesh && stateOf(mesh);
      if (!ms) continue;
      const v = which === 'after' ? 1 : 0;
      for (const f of p.faces) if (f < ms.faces) ms.hidden[f] = v;
      rebuild(ms);
    }
    prunePatch();
  });
  objectMode.registerOp('polyInfer', (e, which) => {
    for (const p of e.polys ?? []) {
      const mesh = meshFor(e.item, p.part); const ms = mesh?.isMesh && stateOf(mesh);
      if (!ms) continue;
      p.faces.forEach((f, i) => {
        if (f >= ms.faces) return;
        const label = which === 'after' ? !!e.to : !!p.prev[i];
        ms.flip[f] = label !== ms.origInferred ? 1 : 0;
      });
      rebuild(ms);
    }
    rebuildPatchMeshes();
  });

  function prunePatch() {
    for (const [ms, set] of patch) { for (const f of set) if (ms.hidden[f]) set.delete(f); if (!set.size) patch.delete(ms); }
    rebuildPatchMeshes();
  }

  // ---- lens query -----------------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2(), inv = new THREE.Matrix4(), ray = new THREE.Ray();
  const sphere = new THREE.Sphere(), tmp = new THREE.Vector3(), hitW = new THREE.Vector3();

  function query() {
    lens = new Map();
    if (!active || !pointer) return null;
    const r = canvas.getBoundingClientRect();
    ndc.set(((pointer.x - r.left) / r.width) * 2 - 1, -((pointer.y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // Nearest VISIBLE face under the pointer, across the item's shown parts.
    let best = Infinity;
    for (const mesh of partsOf(itemId)) {
      if (!shown(mesh)) continue;
      const ms = stateOf(mesh); if (!ms) continue;
      inv.copy(mesh.matrixWorld).invert();
      ray.copy(raycaster.ray).applyMatrix4(inv);
      for (const h of ensureBvh(ms).raycast(ray, THREE.DoubleSide)) {
        if (ms.hidden[h.faceIndex]) continue;
        tmp.copy(h.point).applyMatrix4(mesh.matrixWorld);
        const d = tmp.distanceTo(raycaster.ray.origin);
        if (d < best) { best = d; hitW.copy(tmp); }
      }
    }
    if (best === Infinity) return null;
    // Lens radius in metres at the hit's depth, so the sphere matches the circle on screen.
    const depth = Math.max(camera.near, -tmp.copy(hitW).applyMatrix4(camera.matrixWorldInverse).z);
    const worldPerPx = camera.isPerspectiveCamera
      ? (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (r.height || 1)
      : (camera.top - camera.bottom) / camera.zoom / (r.height || 1);
    const rW = radius * worldPerPx;
    for (const mesh of partsOf(itemId)) {
      if (!shown(mesh)) continue;
      const ms = stateOf(mesh); if (!ms) continue;
      inv.copy(mesh.matrixWorld).invert();
      sphere.center.copy(hitW).applyMatrix4(inv);
      sphere.radius = rW / mesh.matrixWorld.getMaxScaleOnAxis();
      const found = [];
      ensureBvh(ms).shapecast({
        intersectsBounds: (box) => box.intersectsSphere(sphere),
        intersectsTriangle: (t, i) => {
          if (!ms.hidden[i] && t.closestPointToPoint(sphere.center, tmp).distanceTo(sphere.center) <= sphere.radius) found.push(i);
          return false;
        }
      });
      if (found.length) lens.set(ms, found);
    }
    return { centre: hitW.clone(), radiusM: rW };
  }

  // ---- lens + patch drawing -------------------------------------------------------------------
  const lensMat = createLensMaterial();
  const lensGeo = new THREE.BufferGeometry();
  const lensMesh = new THREE.Mesh(lensGeo, lensMat);
  lensMesh.frustumCulled = false;
  lensMesh.renderOrder = 10;
  lensMesh.name = 'polygon-lens';
  group.add(lensMesh);
  let lensCap = 0;
  const v = new THREE.Vector3();

  function drawLens() {
    let n = 0;
    for (const f of lens.values()) n += f.length;
    n = Math.min(n, MAX_LENS_FACES);
    if (n > lensCap) {
      lensCap = Math.max(n, lensCap * 2, 1024);
      lensGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lensCap * 9), 3));
      lensGeo.setAttribute('inferred', new THREE.BufferAttribute(new Float32Array(lensCap * 3), 1));
      const bary = new Float32Array(lensCap * 9);
      for (let i = 0; i < lensCap; i++) { bary[i * 9] = 1; bary[i * 9 + 4] = 1; bary[i * 9 + 8] = 1; }
      lensGeo.setAttribute('bary', new THREE.BufferAttribute(bary, 3));
    }
    if (!lensCap) return;
    const P = lensGeo.attributes.position.array, I = lensGeo.attributes.inferred.array;
    let k = 0;
    outer: for (const [ms, faces] of lens) {
      const pos = ms.full.attributes.position, m = ms.mesh.matrixWorld;
      for (const f of faces) {
        if (k >= n) break outer;
        const inf = inferredFace(ms, f) ? 1 : 0;
        for (let c = 0; c < 3; c++) {
          v.fromBufferAttribute(pos, ms.tri[f * 3 + c]).applyMatrix4(m);
          P[k * 9 + c * 3] = v.x; P[k * 9 + c * 3 + 1] = v.y; P[k * 9 + c * 3 + 2] = v.z;
          I[k * 3 + c] = inf;
        }
        k++;
      }
    }
    lensGeo.attributes.position.needsUpdate = true;
    lensGeo.attributes.inferred.needsUpdate = true;
    lensGeo.setDrawRange(0, k * 3);
  }

  const patchMat = createPatchMaterial();
  function rebuildPatchMeshes() {
    for (const ms of [...edited, ...patchHolders]) if (ms.patchMesh && !patch.has(ms)) { group.remove(ms.patchMesh); ms.patchMesh.geometry.dispose(); ms.patchMesh = null; patchHolders.delete(ms); }
    for (const [ms, set] of patch) {
      // Local-space copy of the patch faces; the mesh follows its part's matrix in tick().
      const pos = ms.full.attributes.position, arr = new Float32Array(set.size * 9);
      let k = 0;
      for (const f of set) for (let c = 0; c < 3; c++) { v.fromBufferAttribute(pos, ms.tri[f * 3 + c]); arr.set([v.x, v.y, v.z], k); k += 3; }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      if (ms.patchMesh) { ms.patchMesh.geometry.dispose(); ms.patchMesh.geometry = g; }
      else {
        ms.patchMesh = new THREE.Mesh(g, patchMat);
        ms.patchMesh.matrixAutoUpdate = false;
        ms.patchMesh.renderOrder = 9;
        ms.patchMesh.name = 'polygon-patch';
        group.add(ms.patchMesh);
        patchHolders.add(ms);
      }
    }
    notify();
  }

  // ---- read-out -------------------------------------------------------------------------------
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3();
  function summarise(map) {
    let faces = 0, area = 0, inf = 0;
    for (const [ms, list] of map) {
      const pos = ms.full.attributes.position, m = ms.mesh.matrixWorld;
      for (const f of list) {
        a.fromBufferAttribute(pos, ms.tri[f * 3]).applyMatrix4(m);
        b.fromBufferAttribute(pos, ms.tri[f * 3 + 1]).applyMatrix4(m);
        c3.fromBufferAttribute(pos, ms.tri[f * 3 + 2]).applyMatrix4(m);
        const s = b.sub(a).cross(c3.sub(a)).length() / 2;
        faces++; area += s; if (inferredFace(ms, f)) inf += s;
      }
    }
    return faces ? { faces, area, inferredPct: area > 0 ? (100 * inf) / area : 0 } : null;
  }

  const stage = canvas.parentElement ?? document.body;
  const ring = document.createElement('div');
  ring.className = 'poly-ring';
  ring.style.cssText = 'position:fixed;pointer-events:none;border:1px solid rgba(200,246,255,.45);border-radius:50%;opacity:0;transition:opacity .18s ease;z-index:5;';
  const readout = document.createElement('div');
  readout.className = 'poly-readout';
  readout.setAttribute('role', 'status');
  readout.style.cssText = 'position:absolute;left:10px;bottom:10px;pointer-events:none;font:12px ui-monospace,monospace;color:#cfe;background:rgba(8,14,20,.78);border:1px solid #2a4250;border-radius:6px;padding:6px 8px;line-height:1.5;z-index:5;display:none;white-space:pre';
  stage.append(ring, readout);

  const fmt = (S) => (S ? `${S.faces.toLocaleString()} faces · ${S.area < 0.01 ? (S.area * 1e4).toFixed(1) + ' cm²' : S.area.toFixed(3) + ' m²'} · ${S.inferredPct.toFixed(0)}% inferred` : '—');
  let lensSummary = null;
  // One line: what to do next.
  const coach = (st) => st.patch ? 'Del hides the patch · I marks it inferred · Shift-click adds · Esc clears'
    : st.lens ? 'Click selects the faces in the lens · Shift-click adds · wheel sizes the lens · Esc leaves'
    : 'Point at the model: the lens shows its real triangles · Esc leaves';
  function notify() {
    const st = api.state();
    readout.style.display = active ? '' : 'none';
    if (active) {
      const w = st.wire;
      const wire = !w.total ? 'building…' : w.shown >= w.total ? `all ${w.total.toLocaleString()} triangles` : `${w.shown.toLocaleString()} of ${w.total.toLocaleString()} triangles · zoom in for finer`;
      readout.textContent = `Polygon · ${st.name}\nwire   ${wire}\nlens   ${fmt(st.lens)}\npatch  ${fmt(st.patch)}\n` + coach(st);
    }
    onChange?.(st);
  }

  // ---- full wire (BUGS #46) ---------------------------------------------------------------------
  // The whole target as triangles: per mesh, a ladder of simplifications (level 0 = every
  // visible face, each next level ~1/4 the triangles), and per frame the finest level whose
  // triangles are ~WIRE_EDGE_PX across on screen, inside WIRE_BUDGET. A dense scan therefore
  // reads as a calm mesh at the default view and resolves to its real triangles as you zoom in.
  // Hidden faces are left out; relabelled faces keep their own (dashed) label.
  let simplifier = null;
  loadSimplifier().then((sm) => { simplifier = sm ?? null; if (simplifier) { for (const m of wireMeshes) { const ms = stateOf(m); if (ms) ms.wire = null; } wireSig = ''; } }).catch(() => {});
  const wireMat = createLensMaterial({ full: true });
  const wireGeo = new THREE.BufferGeometry();
  const wireMesh = new THREE.Mesh(wireGeo, wireMat);
  const wireDepth = new THREE.Mesh(wireGeo, Object.assign(createWireDepthMaterial(), { transparent: true, depthWrite: true }));
  for (const [o, order, name] of [[wireDepth, 20, 'polygon-wire-depth'], [wireMesh, 21, 'polygon-wire']]) {
    o.frustumCulled = false; o.renderOrder = order; o.name = name; o.visible = false; group.add(o);
  }
  // Its own depth: after the hologram, lens and patch have drawn, clear depth and lay down the
  // wire's surface, so the wire hides its own back lines whatever level the hologram drew.
  wireDepth.onBeforeRender = (r) => r.clearDepth();
  let wireMeshes = [], wireSig = '', wireCap = 0, wireFade = 0, skinK = 1;
  let wireStats = { shown: 0, total: 0 };

  // Typical triangle size of a level: the edge of an equilateral triangle with the level's mean
  // area (a median edge is skewed by the slivers simplification leaves along creases).
  const typicalEdge = (pos, groups) => {
    let area = 0, n = 0;
    for (const g of groups) {
      for (let t = 0; t < g.idx.length; t += 3) {
        a.fromBufferAttribute(pos, g.idx[t]); b.fromBufferAttribute(pos, g.idx[t + 1]); c3.fromBufferAttribute(pos, g.idx[t + 2]);
        area += b.sub(a).cross(c3.sub(a)).length() / 2; n++;
      }
    }
    return n ? Math.sqrt((4 * area / n) / Math.sqrt(3)) : 0;
  };
  function wireLevels(ms) {
    if (ms.wire && ms.wire.simp === !!simplifier) return ms.wire.levels;
    const keep = [], other = [];
    for (let f = 0; f < ms.faces; f++) if (!ms.hidden[f]) (ms.flip[f] ? other : keep).push(f);
    const idxOf = (list) => { const o = new Uint32Array(list.length * 3); list.forEach((f, i) => { o[i * 3] = ms.tri[f * 3]; o[i * 3 + 1] = ms.tri[f * 3 + 1]; o[i * 3 + 2] = ms.tri[f * 3 + 2]; }); return o; };
    const level0 = [[keep, ms.origInferred], [other, !ms.origInferred]].filter(([l]) => l.length).map(([l, inf]) => ({ inf, idx: idxOf(l) }));
    const pos = ms.full.attributes.position;
    const levels = [level0];
    const tris = (lv) => lv.reduce((n, g) => n + g.idx.length / 3, 0);
    if (simplifier) {
      if (!ms.posF32) { ms.posF32 = new Float32Array(pos.count * 3); for (let i = 0; i < pos.count; i++) { ms.posF32[i * 3] = pos.getX(i); ms.posF32[i * 3 + 1] = pos.getY(i); ms.posF32[i * 3 + 2] = pos.getZ(i); } }
      for (let guard = 0; guard < 12; guard++) {
        const prev = levels[levels.length - 1], pt = tris(prev);
        if (pt <= WIRE_MIN_TRIS) break;
        const next = prev.map((g) => {
          const n = g.idx.length / 3;
          if (n <= 64) return g;
          const [simp] = simplifier.simplify(g.idx, ms.posF32, 3, Math.max(64, Math.floor(n / 4)) * 3, 0.05, ['Permissive']);
          return { inf: g.inf, idx: simp.length ? simp : g.idx };
        });
        if (tris(next) > pt * 0.7) break;   // barely simplified: this is the coarsest
        levels.push(next);
      }
    }
    const scale = ms.mesh.matrixWorld.getMaxScaleOnAxis();
    ms.wire = { simp: !!simplifier, levels: levels.map((lv) => ({ groups: lv, tris: tris(lv), edgeM: typicalEdge(pos, lv) * scale })) };
    ms.wireLevel = undefined;
    return ms.wire.levels;
  }

  const cssH = () => canvas.clientHeight || canvas.height || 1;
  function pxPerMetre(mesh) {
    if (!camera.isPerspectiveCamera) return cssH() / ((camera.top - camera.bottom) / camera.zoom);
    const g = mesh.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    tmp.copy(g.boundingSphere.center).applyMatrix4(mesh.matrixWorld);
    const r = g.boundingSphere.radius * mesh.matrixWorld.getMaxScaleOnAxis();
    const depth = Math.max(camera.near, tmp.distanceTo(camera.position) - r * 0.5);
    return cssH() / (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }
  function pickLevels() {
    const list = wireMeshes.filter((m) => shown(m) && inScene(m, scene)).map(stateOf).filter(Boolean);
    const total = list.reduce((n, ms) => n + ms.faces, 0) || 1;
    for (const ms of list) {
      const levels = wireLevels(ms), ppm = pxPerMetre(ms.mesh), share = WIRE_BUDGET * ms.faces / total;
      const px = (L) => levels[L].edgeM * ppm;
      let ideal = levels.findIndex((lv) => lv.edgeM * ppm >= WIRE_EDGE_PX);
      if (ideal < 0) ideal = levels.length - 1;
      while (ideal < levels.length - 1 && levels[ideal].tris > share) ideal++;
      const cur = ms.wireLevel;
      if (cur == null || cur >= levels.length || levels[cur].tris > share
        || (ideal < cur && px(ideal) >= WIRE_EDGE_PX * WIRE_HYST) || (ideal > cur && px(cur) < WIRE_EDGE_PX / WIRE_HYST)) ms.wireLevel = ideal;
    }
    return list;
  }
  function buildWire(list) {
    let n = 0;
    for (const ms of list) n += ms.wire.levels[ms.wireLevel].tris;
    if (n > wireCap) {
      wireCap = Math.max(n, wireCap * 2, 4096);
      wireGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wireCap * 9), 3));
      wireGeo.setAttribute('inferred', new THREE.BufferAttribute(new Float32Array(wireCap * 3), 1));
      const bary = new Float32Array(wireCap * 9);
      for (let i = 0; i < wireCap; i++) { bary[i * 9] = 1; bary[i * 9 + 4] = 1; bary[i * 9 + 8] = 1; }
      wireGeo.setAttribute('bary', new THREE.BufferAttribute(bary, 3));
    }
    if (!wireCap) return;
    const P = wireGeo.attributes.position.array, I = wireGeo.attributes.inferred.array;
    let k = 0;
    for (const ms of list) {
      const pos = ms.full.attributes.position, m = ms.mesh.matrixWorld;
      for (const g of ms.wire.levels[ms.wireLevel].groups) {
        const inf = g.inf ? 1 : 0;
        for (let i = 0; i < g.idx.length; i++, k++) {
          v.fromBufferAttribute(pos, g.idx[i]).applyMatrix4(m);
          P[k * 3] = v.x; P[k * 3 + 1] = v.y; P[k * 3 + 2] = v.z; I[k] = inf;
        }
      }
    }
    wireGeo.attributes.position.needsUpdate = true;
    wireGeo.attributes.inferred.needsUpdate = true;
    wireGeo.setDrawRange(0, k);
    wireStats = { shown: k / 3, total: list.reduce((t, ms) => t + ms.faces - ms.hidden.reduce((h, x) => h + x, 0), 0) };
  }
  function updateWire(dt) {
    if (wireMeshes.length) {
      const list = pickLevels();
      const sig = list.map((ms) => `${ms.wireLevel}:${ms.mesh.matrixWorld.elements.join()}`).join('|');
      if (sig !== wireSig) { wireSig = sig; buildWire(list); notify(); }
    }
    const target = active && wireMeshes.length ? 1 : 0;
    wireFade += Math.sign(target - wireFade) * Math.min(Math.abs(target - wireFade), dt / WIRE_FADE_MS);
    if (!active && wireFade === 0 && wireMeshes.length) { wireMeshes = []; wireSig = ''; wireGeo.setDrawRange(0, 0); }
    wireMat.uniforms.uFade.value = wireFade;
    wireMesh.visible = wireDepth.visible = wireFade > 0.001;
    const k = 1 - (1 - SKIN_FAINT) * wireFade;
    if (Math.abs(k - skinK) > 1e-4 || (k === 1 && skinK !== 1)) { skinK = k; onSkin?.(k); }
  }

  // ---- per frame ------------------------------------------------------------------------------
  function tick() {
    const now = performance.now(), dt = Math.min(100, now - lastT);
    lastT = now;
    // Overlays / patch meshes follow their part; they vanish with it (hidden or removed).
    for (const ms of [...edited, ...patchHolders]) {
      const alive = inScene(ms.mesh, scene);
      if (!alive) {   // its item was removed: drop everything we drew for it
        for (const o of [ms.overlay, ms.patchMesh]) if (o) group.remove(o);
        ms.overlay = ms.patchMesh = ms.display = null;
        edited.delete(ms); patchHolders.delete(ms); patch.delete(ms);
        continue;
      }
      for (const o of [ms.overlay, ms.patchMesh]) {
        if (!o) continue;
        o.matrix.copy(ms.mesh.matrixWorld);
        o.matrixWorldNeedsUpdate = true;
        o.visible = shown(ms.mesh);
      }
      if (ms.overlay && prepassLayer != null) {
        if (ms.overlay.material?.blending === THREE.AdditiveBlending) ms.overlay.layers.enable(prepassLayer);
        else ms.overlay.layers.disable(prepassLayer);
      }
    }
    if (active) {
      const sig = `${pointer?.x},${pointer?.y},${radius},${camera.matrixWorld.elements.join()},${camera.projectionMatrix.elements[0]},`
        + partsOf(itemId).map((m) => (shown(m) ? m.matrixWorld.elements.join() : 'h')).join('|');
      if (sig !== lensSig) {
        lensSig = sig;
        const hit = query();
        drawLens();
        lensSummary = summarise(lens);
        fadeTarget = hit ? 1 : 0;
        notify();
      }
    } else fadeTarget = 0;
    // Ease the lens in / out: a linear ramp over FADE_MS, no overshoot, no blink.
    fade += Math.sign(fadeTarget - fade) * Math.min(Math.abs(fadeTarget - fade), dt / FADE_MS);
    lensMesh.visible = fade > 0.001;
    updateWire(dt);
    const dpr = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
    const r = canvas.getBoundingClientRect();
    if (pointer) lensMat.uniforms.uCentre.value.set((pointer.x - r.left) * dpr, (r.bottom - pointer.y) * dpr);
    lensMat.uniforms.uRadius.value = radius * dpr;
    lensMat.uniforms.uFade.value = fade;
    if (pointer) {
      ring.style.left = `${pointer.x - radius}px`; ring.style.top = `${pointer.y - radius}px`;
      ring.style.width = ring.style.height = `${radius * 2}px`;
    }
    ring.style.opacity = active && pointer && fadeTarget ? '1' : '0';
  }

  // ---- render wrapper -------------------------------------------------------------------------
  function wrapRender(fn) {
    return (r, s, c) => {
      const swapped = [];
      for (const ms of edited) {
        if (!ms.display || ms.mesh.geometry !== ms.full) continue;
        ms.parked = ms.mesh.userData.lod;
        delete ms.mesh.userData.lod;
        ms.mesh.geometry = ms.display;
        swapped.push(ms);
      }
      try { return fn(r, s, c); } finally {
        for (const ms of swapped) {
          ms.mesh.geometry = ms.full;
          if (ms.parked) ms.mesh.userData.lod = ms.parked;
          ms.parked = undefined;
        }
      }
    };
  }

  // ---- input ----------------------------------------------------------------------------------
  canvas.addEventListener('pointermove', (e) => { if (active && e.pointerType !== 'touch') pointer = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerleave', () => { pointer = null; lensSig = ''; });
  canvas.addEventListener('pointerdown', (e) => { if (active && e.button === 0) down = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('pointerup', (e) => {
    if (!active || !down || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_PX;
    down = null;
    if (moved) return;   // a drag orbits the camera, it doesn't select
    api.setPointer(e.clientX, e.clientY);
    api.select({ add: e.shiftKey });
  });
  // Wheel over the item = lens size; off the item it still zooms the camera.
  canvas.addEventListener('wheel', (e) => {
    if (!active || !lens.size || e.ctrlKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    api.radius = radius * Math.exp(-(wheelPixels(e) / NOTCH_PX) * RADIUS_PER_NOTCH);
  }, { capture: true, passive: false });
  // Capture on window: runs before objectmode's and main's keydown handlers (main's I is
  // "show inferred", objectmode's Delete hides the selected part), so polygon keys win only
  // while polygon mode is on.
  window.addEventListener('keydown', (e) => {
    if (!active || e.target.matches?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); e.stopImmediatePropagation(); api.hidePatch(); }
    else if (k.toLowerCase() === 'i' && patch.size) { e.stopImmediatePropagation(); api.toggleInferredPatch(); }   // no patch: I stays "show inferred"
    else if (k === 'Escape') { e.stopImmediatePropagation(); if (patch.size) api.clearPatch(); else api.exit(); }
  }, { capture: true });

  // ---- API ------------------------------------------------------------------------------------
  const sceneName = () => { const n = getItems().length; return `whole scene (${n} item${n === 1 ? '' : 's'})`; };
  // Item of an edit: the mode's item, or (whole scene) the one item all its faces belong to.
  const itemFor = (polys) => { if (itemId != null) return itemId; const ids = new Set(polys.map((p) => meshFor(null, p.part)?.userData.itemId ?? null)); return ids.size === 1 ? [...ids][0] : null; };
  const patchList = () => new Map([...patch].map(([ms, set]) => [ms, [...set].sort((x, y) => x - y)]));

  const api = {
    enter(id = null) {
      const meshes = partsOf(id);
      if (!meshes.length) return false;
      const t0 = performance.now();
      for (const m of meshes) { const ms = stateOf(m); if (ms) ensureBvh(ms); }
      bvhMs = performance.now() - t0;
      const fresh = itemId !== id || !active;
      active = true; itemId = id; lensSig = '';
      wireMeshes = meshes; wireSig = '';
      if (fresh) { patch.clear(); rebuildPatchMeshes(); }
      notify();
      return true;
    },
    exit() {
      if (!active) return;
      active = false; pointer = null; lens = new Map(); lensSummary = null;
      patch.clear(); rebuildPatchMeshes();
      notify();
    },
    get active() { return active; },
    get itemId() { return itemId; },
    get radius() { return radius; },
    set radius(px) { radius = Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, px)); lensSig = ''; },
    setPointer(x, y) { pointer = { x, y }; tick(); },
    clearPointer() { pointer = null; lensSig = ''; },
    select({ add = false } = {}) {
      if (!active) return null;
      if (!add) patch.clear();
      for (const [ms, faces] of lens) {
        let set = patch.get(ms);
        if (!set) patch.set(ms, (set = new Set()));
        for (const f of faces) set.add(f);
      }
      rebuildPatchMeshes();
      return summarise(patchList());
    },
    clearPatch() { patch.clear(); rebuildPatchMeshes(); },
    hidePatch() {
      if (!active || !patch.size) return null;
      const polys = [...patchList()].map(([ms, faces]) => ({ part: ms.partId, faces }));
      const entry = { op: 'polyHide', item: itemFor(polys), part: null, faces: polys.reduce((n, p) => n + p.faces.length, 0), polys };
      objectMode.ensureLive();
      const rec = objectMode.record(entry);
      for (const p of polys) { const ms = stateOf(meshFor(itemId, p.part)); for (const f of p.faces) ms.hidden[f] = 1; rebuild(ms); }
      patch.clear(); rebuildPatchMeshes();
      return rec;
    },
    // Toggle: if every face in the patch is already inferred, unmark them; else mark them all.
    toggleInferredPatch() {
      if (!active || !patch.size) return null;
      const list = patchList();
      let allInf = true;
      for (const [ms, faces] of list) for (const f of faces) if (!inferredFace(ms, f)) { allInf = false; break; }
      const to = allInf ? 0 : 1;
      const polys = [...list].map(([ms, faces]) => ({ part: ms.partId, faces, prev: faces.map((f) => (inferredFace(ms, f) ? 1 : 0)) }));
      objectMode.ensureLive();
      const rec = objectMode.record({ op: 'polyInfer', item: itemFor(polys), part: null, faces: polys.reduce((n, p) => n + p.faces.length, 0), to, polys });
      for (const [ms, faces] of list) { for (const f of faces) ms.flip[f] = !!to !== ms.origInferred ? 1 : 0; rebuild(ms); }
      rebuildPatchMeshes();
      return rec;
    },
    tick,
    wrapRender,
    refreshMaterials() { for (const ms of edited) if (ms.overlay) ms.overlay.material = materialFor(ms.overlay); },
    state() {
      return {
        active, item: itemId, name: itemId == null ? sceneName() : getItem(itemId)?.name ?? itemId, radius, bvhMs,
        lens: active ? lensSummary : null, patch: summarise(patchList()),
        wire: { ...wireStats, fade: wireFade }, skin: skinK
      };
    },
    faceState(mesh) {
      const ms = stateOf(mesh);
      return ms && { faces: ms.faces, hidden: ms.hidden, inferred: (f) => inferredFace(ms, f), display: ms.display, overlay: ms.overlay };
    },
    lensFaces() { return new Map([...lens].map(([ms, f]) => [ms.partId, f.slice()])); },
    get objects() { return { group, lensMesh, wireMesh, wireDepth, ring, readout }; }
  };
  return api;
}

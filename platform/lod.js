// Display LOD + a cheaper single-layer pass for the Platform.
//
// WHY: the detailed sample chair is ~304k triangles and the photosafe single-layer look
// (hologramLook.js, BUGS.md #14) draws every mesh twice: a depth-only pre-pass, then the
// additive hologram. The hologram look (fresnel rim, scanlines, flat body colour) hides
// sub-millimetre detail anyway, so the screen shows a meshoptimizer-simplified copy while
// the scene is dense, and the full scan whenever the detail could actually be seen.
//
// THE FULL GEOMETRY NEVER LEAVES THE MESH. `mesh.geometry` is the full scan at all times,
// except for the few microseconds inside render() where it is swapped for the LOD and
// swapped straight back. Everything that reads geometry -- measurements.js, measure.js,
// export.js, object-mode raycasts, part splitting -- runs outside render() and therefore
// always sees the scanned mesh. Measurements cannot change.
//
// The LOD shares the full geometry's vertex buffers (position/normal/uv/colour); only a new,
// smaller index buffer is made. So memory grows by one index buffer, and the pre-pass and
// the colour pass always draw the SAME geometry (required: different geometry in the two
// passes z-fights, which BUGS.md #14 measured at 17 flashes/s).
//
// Level choice, per mesh, per frame (hysteresis so it never flickers between levels):
//   full detail   when the simplification error would be visible (> ~1.5 CSS px on screen,
//                 i.e. zoomed in close), when Realism > 0.5 (you're judging the real
//                 surface), or when the material isn't the additive hologram (Plain mode
//                 exists to show the real mesh).
//   LOD           otherwise, while the scene is over the triangle budget.
//
// Single-layer pass: instead of re-rendering the whole scene with an override material,
// only visible meshes that actually blend additively get the depth pre-pass (camera layer
// PREPASS_LAYER), and the pre-pass is skipped entirely when nothing blends additively
// (Plain material mode). Same photosafety guarantee, less work.

import * as THREE from 'three';
import { loadSimplifier } from './parts.js';

const BUDGET = 120_000;        // displayed triangles per scene in hologram mode
const MIN_TRIS = 8_000;        // meshes smaller than this aren't worth simplifying
const REBUILD_SLACK = 0.25;    // rebuild a LOD only when its target moves by more than this
const ERR_IN_PX = 1.5;         // switch to full detail when the LOD's error exceeds this...
const ERR_OUT_PX = 1.0;        // ...and back to the LOD only once it's below this (hysteresis)
const REALISM_FULL = 0.5;      // realism above this always shows the full scan
export const PREPASS_LAYER = 30;

// Same pre-pass material as hologramLook.js (depth only, polygon offset pushes it a hair
// behind so the hologram's own draw of the same surface wins the LessEqual test).
const prepassMaterial = new THREE.MeshBasicMaterial({
  colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
});

const triCount = (g) => Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3);
const isAdditive = (m) => !!m && !Array.isArray(m) && m.blending === THREE.AdditiveBlending && m.visible !== false;

export function createDisplayLod({ scene, camera, renderer, look, budget = BUDGET }) {
  const roots = new Set();
  const queue = new Set();       // meshes waiting for a (re)build
  let simplifier = null;
  let pumping = false;
  let totalTris = 0;             // full triangles registered (all items), for the budget
  const state = { enabled: true, budget, frames: 0, lastTris: 0, lastSwapped: 0, prepassMeshes: 0 };

  loadSimplifier().then((s) => { simplifier = s; recount(); });

  function recount() {
    totalTris = 0;
    for (const r of roots) r.traverse((m) => { if (m.isMesh && m.geometry?.attributes.position) totalTris += triCount(m.geometry); });
    for (const r of roots) r.traverse((m) => { if (m.isMesh) consider(m); });
  }

  // Does this mesh need a (new) LOD for the current budget? Queue it if so.
  function consider(mesh) {
    const g = mesh.geometry;
    if (!g?.attributes.position) return;
    const tris = triCount(g);
    const lod = mesh.userData.lod;
    const target = totalTris > state.budget && tris >= MIN_TRIS ? Math.floor(tris * state.budget / totalTris) : 0;
    if (lod && (lod.source !== g || (target && Math.abs(lod.target - target) > lod.target * REBUILD_SLACK) || !target)) {
      dropLod(mesh);
    }
    if (target && !mesh.userData.lod && simplifier) { queue.add(mesh); pump(); }
  }

  // keepShared: the full mesh stays, so its vertex buffers must stay on the GPU. The LOD
  // shares them and three's dispose() frees every attribute a geometry lists, so the LOD
  // is handed over with only its index. On item removal (keepShared false) the shared
  // buffers go too: while a mesh is only ever DRAWN as its LOD, the renderer knows those
  // buffers through the LOD geometry alone, and disposing the full geometry wouldn't free them.
  function dropLod(mesh, keepShared = true) {
    const lod = mesh.userData.lod;
    if (!lod) return;
    if (keepShared) lod.geometry.attributes = {};
    lod.geometry.dispose();
    delete mesh.userData.lod;
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    const step = () => {
      const mesh = queue.values().next().value;
      if (!mesh) { pumping = false; return; }
      queue.delete(mesh);
      if ([...roots].some((r) => isUnder(mesh, r))) build(mesh);
      setTimeout(step, 0);   // one mesh per task: never a long stall
    };
    setTimeout(step, 0);
  }

  function build(mesh) {
    const g = mesh.geometry;
    const tris = triCount(g);
    const target = totalTris > state.budget ? Math.floor(tris * state.budget / totalTris) : 0;
    if (!target || tris < MIN_TRIS) return;
    const pos = g.attributes.position;
    const positions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { positions[i * 3] = pos.getX(i); positions[i * 3 + 1] = pos.getY(i); positions[i * 3 + 2] = pos.getZ(i); }
    let index;
    if (g.index) index = g.index.array instanceof Uint32Array ? g.index.array : Uint32Array.from(g.index.array);
    else { index = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) index[i] = i; }
    // target_error 0.02 = up to 2% of the mesh extent; the triangle target is what stops it.
    // Permissive lets it collapse across UV seams, which scans are full of.
    const [simp, relErr] = simplifier.simplify(index, positions, 3, target * 3, 0.02, ['Permissive']);
    if (simp.length / 3 > tris * 0.85) return;   // barely simplified: not worth a second level
    const errWorld = relErr * simplifier.getScale(positions, 3) * mesh.matrixWorld.getMaxScaleOnAxis();
    const lodGeo = new THREE.BufferGeometry();
    lodGeo.setIndex(new THREE.BufferAttribute(pos.count > 65535 ? simp : Uint16Array.from(simp), 1));
    syncAttributes(lodGeo, g);
    if (!g.boundingSphere) g.computeBoundingSphere();
    lodGeo.boundingSphere = g.boundingSphere;   // subset of the same vertices: the full sphere bounds it
    lodGeo.boundingBox = g.boundingBox;
    mesh.userData.lod = { geometry: lodGeo, source: g, target, tris: simp.length / 3, fullTris: tris, errorM: errWorld, useFull: false };
  }

  function syncAttributes(lodGeo, full) {
    for (const k in full.attributes) if (lodGeo.attributes[k] !== full.attributes[k]) lodGeo.attributes[k] = full.attributes[k];
    for (const k in lodGeo.attributes) if (!(k in full.attributes)) delete lodGeo.attributes[k];
  }

  function isUnder(o, root) { for (; o; o = o.parent) if (o === root) return true; return false; }

  // ---- per frame ----------------------------------------------------------------------------
  const sphere = new THREE.Sphere();
  const swapped = [];        // meshes currently showing their LOD (reused array, no per-frame garbage)
  let prepassCount = 0;
  let pxPerMetreAtOne = 0;   // CSS pixels per metre at 1 m from the camera
  let realismFull = false;

  function visit(m) {
    if (!m.isMesh) return;
    const additive = isAdditive(m.material);
    if (additive) { m.layers.enable(PREPASS_LAYER); prepassCount++; } else m.layers.disable(PREPASS_LAYER);
    const lod = m.userData.lod;
    if (!lod || !state.enabled) return;
    if (lod.source !== m.geometry) { consider(m); return; }   // re-split or replaced: stale
    if (!additive || realismFull) { lod.useFull = true; return; }
    sphere.copy(lod.source.boundingSphere).applyMatrix4(m.matrixWorld);
    const dist = Math.max(camera.near, sphere.center.distanceTo(camera.position) - sphere.radius);
    const px = lod.errorM * pxPerMetreAtOne / dist;
    lod.useFull = lod.useFull ? px > ERR_OUT_PX : px > ERR_IN_PX;
    if (lod.useFull) return;
    syncAttributes(lod.geometry, lod.source);
    m.geometry = lod.geometry;
    swapped.push(m);
  }

  function render(renderer_, scene_, camera_) {
    const r = renderer_ ?? renderer, s = scene_ ?? scene, cam = camera_ ?? camera;
    realismFull = (look?.settings?.realism ?? 0) > REALISM_FULL;
    const cssH = r.domElement.clientHeight || r.domElement.height / r.getPixelRatio();
    pxPerMetreAtOne = cam.isPerspectiveCamera ? cssH / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) : 0;
    prepassCount = 0;
    swapped.length = 0;
    try {
      for (const root of roots) root.traverseVisible(visit);
      state.prepassMeshes = prepassCount;
      state.lastSwapped = swapped.length;
      if (!prepassCount) { r.render(s, cam); return; }   // nothing additive (Plain mode): one pass
      const autoClear = r.autoClear;
      r.clear();
      r.autoClear = false;
      const mask = cam.layers.mask;
      const background = s.background;
      cam.layers.set(PREPASS_LAYER);   // depth pre-pass: additive meshes only
      s.overrideMaterial = prepassMaterial;
      s.background = null;             // don't paint the background twice
      r.render(s, cam);
      s.overrideMaterial = null;
      s.background = background;
      cam.layers.mask = mask;
      r.render(s, cam);
      r.autoClear = autoClear;
    } finally {
      for (const m of swapped) m.geometry = m.userData.lod.source;   // full geometry back, always
      swapped.length = 0;
      state.frames++;
    }
  }

  return {
    render,
    get enabled() { return state.enabled; },
    set enabled(v) { state.enabled = !!v; },
    add(root) { roots.add(root); recount(); },
    remove(root) {
      roots.delete(root);
      root.traverse((m) => { if (m.isMesh) { queue.delete(m); dropLod(m, false); } });
      recount();
    },
    /** Rebuild targets after a re-split or budget change. */
    refresh: recount,
    setBudget(n) { state.budget = n; recount(); },
    /** Resolves once every queued LOD is built (tests, perf-test.html). */
    async ready() {
      simplifier ??= await loadSimplifier();
      recount();
      while (queue.size || pumping) await new Promise((res) => setTimeout(res, 10));
    },
    stats() {
      const meshes = [];
      for (const r of roots) r.traverse((m) => {
        if (m.isMesh && m.userData.lod) meshes.push({ name: m.name, full: m.userData.lod.fullTris, lod: m.userData.lod.tris, errorMm: +(m.userData.lod.errorM * 1000).toFixed(2), full_now: m.userData.lod.useFull });
      });
      return { budget: state.budget, totalTris, prepassMeshes: state.prepassMeshes, swapped: state.lastSwapped, meshes };
    }
  };
}

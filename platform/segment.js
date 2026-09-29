import * as THREE from 'three';

// PLACEHOLDER segmentation for P1. It only answers "which triangles are physically connected?",
// which is enough to make a chess set's pieces or a room's loose furniture selectable, and
// nothing more: a chair tucked under a desk stays one blob, and a room's floor/walls stay
// one huge component. P2 replaces this with the real thing (RANSAC floor/wall peel, then
// components on the remainder, run in a Worker) behind the same `parts` shape, so the
// object-mode code that consumes it does not change.

const DEFAULTS = {
  weld: 0.001,      // metres: vertices closer than this count as the same point (see below)
  minDiagFrac: 0.02 // components smaller than 2% of the scan's bbox diagonal are not selectable
};

function find(parent, i) {
  while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } // path halving
  return i;
}

// Copy the given triangles of `geo` into a new indexed geometry, baking `matrix` into the
// positions/normals so the part lives in the scan root's frame with an identity transform
// (moving or rotating a part is then just position/rotation.y on the part).
function extract(geo, tris, matrix, normalMatrix) {
  const idx = geo.index;
  const remap = new Map();
  const attrs = Object.entries(geo.attributes);
  const out = {};
  for (const [name, a] of attrs) out[name] = [];
  const index = [];
  const v = new THREE.Vector3();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const old = idx ? idx.getX(t * 3 + k) : t * 3 + k;
      let n = remap.get(old);
      if (n === undefined) {
        n = remap.size;
        remap.set(old, n);
        for (const [name, a] of attrs) {
          if (name === 'position' || name === 'normal') {
            v.fromBufferAttribute(a, old);
            if (name === 'position') v.applyMatrix4(matrix);
            else v.applyMatrix3(normalMatrix).normalize();
            out[name].push(v.x, v.y, v.z);
          } else {
            // Generic path (uv, color, ...). getX..W handle interleaved attributes too.
            const s = a.itemSize;
            out[name].push(a.getX(old));
            if (s > 1) out[name].push(a.getY(old));
            if (s > 2) out[name].push(a.getZ(old));
            if (s > 3) out[name].push(a.getW(old));
          }
        }
      }
      index.push(n);
    }
  }
  const g = new THREE.BufferGeometry();
  for (const [name, a] of attrs) {
    g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(out[name]), a.itemSize));
  }
  g.setIndex(index);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Splits every mesh under `object` into connected components. Mutates the scene graph:
// each source mesh is replaced by one mesh per selectable component plus (if anything small
// was left over) one "rest" mesh, all direct children of the returned root, all with
// identity transforms. Call it BEFORE placeOnFloor so the root is still untransformed.
// Each source mesh is treated separately, since a GLB can already contain several meshes.
// Points (PLY point clouds) are left alone: there are no triangles to connect.
//
// Returns { root, parts, rests, ms, components }:
//   parts: [{ id, mesh, tris, box }]  id is a stable 1-based integer, biggest part first
//   rests: meshes holding the tiny leftovers (never selectable)
export function splitComponents(object, opts = {}) {
  const t0 = performance.now();
  const { weld, minDiagFrac } = { ...DEFAULTS, ...opts };

  // A bare Mesh (PLY) can't hold children of its own that render separately; wrap it.
  let root = object;
  if (object.isMesh) { root = new THREE.Group(); root.add(object); }
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const sources = [];
  root.traverse((c) => { if (c.isMesh && c.geometry.attributes.position) sources.push(c); });

  // Scan diagonal in root space, for the size threshold.
  const scanBox = new THREE.Box3();
  const tmpBox = new THREE.Box3();
  for (const m of sources) {
    m.geometry.computeBoundingBox();
    tmpBox.copy(m.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld));
    scanBox.union(tmpBox);
  }
  const minDiag = scanBox.isEmpty() ? 0 : scanBox.getSize(new THREE.Vector3()).length() * minDiagFrac;

  const found = [];  // { geo, material, tris }
  const rests = [];
  let components = 0;

  for (const m of sources) {
    const geo = m.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
    const matrix = new THREE.Matrix4().multiplyMatrices(rootInv, m.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);

    // Weld first, always. Non-indexed geometry has no shared vertices at all, and indexed
    // GLBs split vertices along UV seams and hard edges; either would shatter one physical
    // object into many components. Quantising positions (~1 mm) merges them again.
    const weldId = new Int32Array(pos.count);
    const seen = new Map();
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      const key = `${Math.round(p.x / weld)},${Math.round(p.y / weld)},${Math.round(p.z / weld)}`;
      let w = seen.get(key);
      if (w === undefined) { w = seen.size; seen.set(key, w); }
      weldId[i] = w;
    }

    const parent = new Int32Array(seen.size);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const vi = (t, k) => weldId[idx ? idx.getX(t * 3 + k) : t * 3 + k];
    for (let t = 0; t < triCount; t++) {
      const a = find(parent, vi(t, 0));
      const b = find(parent, vi(t, 1));
      const c = find(parent, vi(t, 2));
      parent[b] = a;
      parent[find(parent, c)] = a;
    }

    // Group triangles by component root, and grow each component's bbox as we go.
    const groups = new Map(); // root -> { tris:[], box }
    for (let t = 0; t < triCount; t++) {
      const r = find(parent, vi(t, 0));
      let g = groups.get(r);
      if (!g) { g = { tris: [], box: new THREE.Box3() }; groups.set(r, g); }
      g.tris.push(t);
      for (let k = 0; k < 3; k++) {
        const vIdx = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        g.box.expandByPoint(p.fromBufferAttribute(pos, vIdx).applyMatrix4(matrix));
      }
    }
    components += groups.size;

    const restTris = [];
    for (const g of groups.values()) {
      if (g.box.getSize(p).length() >= minDiag) {
        found.push({ geo: extract(geo, g.tris, matrix, normalMatrix), material: m.material, tris: g.tris.length });
      } else {
        for (const t of g.tris) restTris.push(t);
      }
    }
    if (restTris.length) {
      const rest = new THREE.Mesh(extract(geo, restTris, matrix, normalMatrix), m.material);
      rest.name = `${m.name || 'mesh'}:rest`;
      rests.push(rest);
    }

    m.parent.remove(m);
    geo.dispose();
  }

  found.sort((a, b) => b.tris - a.tris);
  const parts = found.map((f, i) => {
    const mesh = new THREE.Mesh(f.geo, f.material);
    mesh.name = `part-${i + 1}`;
    mesh.userData.partId = i + 1;
    root.add(mesh);
    return { id: i + 1, mesh, tris: f.tris, box: f.geo.boundingBox.clone() };
  });
  for (const r of rests) root.add(r);

  return { root, parts, rests, components, ms: performance.now() - t0 };
}

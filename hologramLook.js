// Geometry-side comfort fixes for the hologram look, shared by the v1 pages and the Platform.
// The shader-side fixes (no strobe, no aliasing scanlines, eased brightness, reduced
// motion) live in HolographicMaterial.js; both are measured by safety-test.html.
//
//   enableSingleLayer(scene, [materials])   once per page
//   prepareHologram(object)                 once per loaded model (and after any re-split)
//
// 1. SINGLE LAYER. The hologram draws with additive blending, so every surface BEHIND the
//    front one adds its brightness too. Where a scan has several layers (thin panels, room
//    walls behind furniture, loose scan fragments) pixels stack to white -- the "blooming"
//    -- and the hot spots jump around as the model turns. The scene is drawn depth-only
//    first; the hologram then only passes where it IS the front-most surface. Same
//    see-through-to-the-background glow, one layer deep.
//
// 2. SMOOTH SHADING ON ROUGH SCANS. The rim glow follows surface normals, and a LiDAR scan's
//    normals are noisy (and OBJ meshes without normals come out faceted), so the rim
//    sparkles as the model moves. Normals are replaced by an average over a ~1 cm
//    neighbourhood. Only the SHADING normals change: no vertex moves, so every measurement
//    stays exactly what was scanned. How noisy the surface was is recorded on
//    mesh.userData.shading.

import * as THREE from 'three';

const SMOOTH_RADIUS = 0.012;   // metres; about the size of LiDAR surface noise

export function prepareHologram(object, { smooth = true } = {}) {
  object.traverse((mesh) => {
    if (smooth && mesh.isMesh && !mesh.userData.shading) mesh.userData.shading = smoothShadingNormals(mesh.geometry);
  });
}

// The hologram material must depth-TEST against the pre-pass (but never write depth itself).
export function configureSingleLayer(material) {
  material.depthTest = true;
  material.depthWrite = false;
  material.depthFunc = THREE.LessEqualDepth;
}

// Polygon offset pushes the pre-pass's depth a hair BEHIND the real surface, so the
// hologram's own draw of that surface always wins the LessEqual test. Without it two
// draws of identical geometry can differ by rounding and z-fight: per-pixel flicker
// (measured 17 flashes/s before the offset and the shared projection path were added).
const prepassMaterial = new THREE.MeshBasicMaterial({
  colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
});

/**
 * Turn on single-layer rendering for a scene (scene.js's render loop picks it up).
 * Done as a whole-scene depth pass rather than extra meshes on purpose: measurement,
 * explode, selection and export all walk every mesh in a model, and a hidden copy
 * would silently double volumes and invent parts.
 */
export function enableSingleLayer(scene, materials = []) {
  materials.forEach(configureSingleLayer);
  scene.userData.renderSingleLayer = renderSingleLayer;
}

export function renderSingleLayer(renderer, scene, camera) {
  const autoClear = renderer.autoClear;
  renderer.clear();
  renderer.autoClear = false;
  scene.overrideMaterial = prepassMaterial;
  const background = scene.background;
  scene.background = null;              // don't paint the background twice
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  scene.background = background;
  renderColourPass(renderer, scene, camera);
  renderer.autoClear = autoClear;
}

/**
 * The colour pass, keeping the pre-pass depth (BUGS #30). In three r161 a THREE.Color
 * scene.background makes every renderer.render() force-clear colour AND depth, even with
 * autoClear = false, which wiped the pre-pass and let stacked surfaces add up again. Only
 * the depth/stencil part is switched off: the colour clear still paints the background
 * (the pre-pass writes no colour, so nothing is lost).
 */
export function renderColourPass(renderer, scene, camera) {
  const { autoClearDepth, autoClearStencil } = renderer;
  renderer.autoClearDepth = false;
  renderer.autoClearStencil = false;
  try { renderer.render(scene, camera); } finally {
    renderer.autoClearDepth = autoClearDepth;
    renderer.autoClearStencil = autoClearStencil;
  }
}

/**
 * Replace shading normals with area-weighted normals averaged over a SMOOTH_RADIUS
 * neighbourhood (voxel grid, 27 neighbouring cells). Works on indexed and non-indexed
 * geometry, keeps uv/colour attributes untouched. Returns how noisy the surface was and
 * how much the shading changed.
 */
export function smoothShadingNormals(geometry, radius = SMOOTH_RADIUS) {
  const pos = geometry.attributes.position;
  if (!pos || pos.count < 3) return null;
  const idx = geometry.index;
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  const vert = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);

  // Per-vertex own face normal (for the roughness measure) and per-cell normal sums.
  const faceN = new Float32Array(pos.count * 3);
  const cells = new Map();
  const key = (x, y, z) => ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791));
  const cellOf = (i) => [
    Math.floor(pos.getX(i) / radius), Math.floor(pos.getY(i) / radius), Math.floor(pos.getZ(i) / radius)
  ];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const i0 = vert(t, 0), i1 = vert(t, 1), i2 = vert(t, 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1).sub(a);
    c.fromBufferAttribute(pos, i2).sub(a);
    const n = b.cross(c);                      // length = 2 x area: area weighting for free
    for (const i of [i0, i1, i2]) {
      faceN[i * 3] += n.x; faceN[i * 3 + 1] += n.y; faceN[i * 3 + 2] += n.z;
      const [x, y, z] = cellOf(i);
      const k = key(x, y, z);
      const s = cells.get(k);
      if (s) { s[0] += n.x; s[1] += n.y; s[2] += n.z; } else cells.set(k, [n.x, n.y, n.z]);
    }
  }

  const before = geometry.attributes.normal;
  const out = new Float32Array(pos.count * 3);
  let noise = 0, change = 0;
  const own = new THREE.Vector3(), sm = new THREE.Vector3(), old = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = cellOf(i);
    sm.set(0, 0, 0);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const s = cells.get(key(x + dx, y + dy, z + dz));
      if (s) sm.x += s[0], sm.y += s[1], sm.z += s[2];
    }
    own.set(faceN[i * 3], faceN[i * 3 + 1], faceN[i * 3 + 2]).normalize();
    // Never let smoothing flip a normal to the other side of a thin panel: if the
    // neighbourhood average points away from this vertex's own faces, keep its own.
    if (sm.lengthSq() === 0 || sm.dot(own) <= 0) sm.copy(own); else sm.normalize();
    out[i * 3] = sm.x; out[i * 3 + 1] = sm.y; out[i * 3 + 2] = sm.z;
    noise += 1 - own.dot(sm);
    if (before) change += 1 - old.fromBufferAttribute(before, i).normalize().dot(sm);
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  // surfaceNoise: how far faces deviate from their neighbourhood (0 = perfectly smooth);
  // shadingChange: how much the shading normals moved (0 = nothing to fix).
  return { radius, surfaceNoise: noise / pos.count, shadingChange: before ? change / pos.count : null };
}

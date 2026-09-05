import * as THREE from 'three';

// Removes whatever a scan happened to capture around the intended object — for the chair
// scan that turned out to be a wall sliver and a wide floor patch (see ROADMAP.md Phase 2/3).
// A whole triangle is kept or dropped as one unit, never split, so the cut edge stays a
// clean boundary instead of a stretched sliver of geometry straddling the cylinder wall.
//
// `center`/`radius` are a property of one specific scan, not something this function can
// infer — find them by histogramming the real vertex data (a genuine empty gap in the
// distance-from-center distribution is what to look for) rather than guessing.
export function trimByCylinder(object, { center = { x: 0, z: 0 }, radius }) {
  let keptTriangles = 0;
  let totalTriangles = 0;

  object.traverse((child) => {
    if (!child.isMesh) return;

    const geom = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry;
    const pos = geom.attributes.position;
    const normal = geom.attributes.normal;
    const uv = geom.attributes.uv;
    const triCount = pos.count / 3;
    totalTriangles += triCount;

    const keepPos = [];
    const keepNormal = normal ? [] : null;
    const keepUv = uv ? [] : null;

    for (let t = 0; t < triCount; t++) {
      const base = t * 3;
      let inside = true;
      for (let v = 0; v < 3 && inside; v++) {
        const i = base + v;
        const dx = pos.getX(i) - center.x;
        const dz = pos.getZ(i) - center.z;
        if (Math.hypot(dx, dz) >= radius) inside = false;
      }
      if (!inside) continue;

      keptTriangles++;
      for (let v = 0; v < 3; v++) {
        const i = base + v;
        keepPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        if (normal) keepNormal.push(normal.getX(i), normal.getY(i), normal.getZ(i));
        if (uv) keepUv.push(uv.getX(i), uv.getY(i));
      }
    }

    const trimmed = new THREE.BufferGeometry();
    trimmed.setAttribute('position', new THREE.Float32BufferAttribute(keepPos, 3));
    if (normal) trimmed.setAttribute('normal', new THREE.Float32BufferAttribute(keepNormal, 3));
    if (uv) trimmed.setAttribute('uv', new THREE.Float32BufferAttribute(keepUv, 2));

    child.geometry.dispose();
    child.geometry = trimmed;
  });

  return { keptTriangles, totalTriangles };
}

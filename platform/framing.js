import * as THREE from 'three';

// Above this horizontal extent (metres) a scan is a room, not a thing you'd hold or place on
// a desk. A large armchair or a dining table is ~2 m; the smallest real room scan is bigger.
export const ROOM_THRESHOLD_M = 2.5;

const MAX_SAMPLES = 20000;
const BIN_M = 0.01;

// Floors are found by surface identity, not a fixed height cut. v1 lesson (see the
// clean_scan.py docstring): a "drop everything below Y" rule either leaves floor behind or
// slices off the bottom of the object, because scans are never level or the same size. So we
// look for the lowest big horizontal surface instead. Pure: reads the object, changes nothing.
export function detectFloorY(object) {
  object.updateMatrixWorld(true);

  // Count vertices first so the sample stride spreads evenly over every mesh.
  let total = 0;
  object.traverse((c) => {
    const p = c.geometry?.attributes.position;
    if ((c.isMesh || c.isPoints) && p) total += p.count;
  });
  if (total === 0) return 0;
  const stride = Math.max(1, Math.floor(total / MAX_SAMPLES));

  const ys = [];         // every sampled world Y
  const flatYs = [];     // sampled Y of points whose normal points near-vertically
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  const nm = new THREE.Matrix3();

  object.traverse((c) => {
    const pos = c.geometry?.attributes.position;
    if (!(c.isMesh || c.isPoints) || !pos) return;
    const nor = c.geometry.attributes.normal;
    nm.getNormalMatrix(c.matrixWorld);
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld);
      ys.push(v.y);
      if (nor) {
        n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
        // Upward only: a floor faces up. Downward-facing bases (chair-leg ends, ceilings)
        // are surfaces too, but not the ground the object stands on.
        if (n.y > 0.85) flatYs.push(v.y);
      }
    }
  });

  ys.sort((a, b) => a - b);
  const minY = ys[0];
  const maxY = ys[ys.length - 1];
  // Fallback: 1st percentile, not the min, so a few stray floating vertices don't set the floor.
  const percentileY = ys[Math.floor(ys.length * 0.01)];

  // Too few up-facing samples (no normals, or a point cloud) means the histogram would be noise.
  if (flatYs.length < Math.max(50, ys.length * 0.03)) return percentileY;

  const bins = new Map();
  for (const y of flatYs) {
    const b = Math.floor((y - minY) / BIN_M);
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  const nBins = Math.floor((maxY - minY) / BIN_M) + 1;
  // 3-bin smoothing: a floor that is a few mm off-level spans neighbouring bins.
  const smooth = new Array(nBins).fill(0);
  for (let b = 0; b < nBins; b++) {
    smooth[b] = (bins.get(b - 1) ?? 0) + (bins.get(b) ?? 0) + (bins.get(b + 1) ?? 0);
  }
  const peak = Math.max(...smooth);
  // The lowest bin holding a substantial share of the biggest flat surface. "Lowest" beats
  // "biggest": a tabletop can out-count a cluttered floor, but the floor is still the floor.
  let floorBin = -1;
  for (let b = 0; b < nBins; b++) {
    if (smooth[b] >= peak * 0.25) { floorBin = b; break; }
  }
  const candidateY = minY + (floorBin + 0.5) * BIN_M;

  // A floor must sit at the bottom of the scan. A cleaned chair has no floor at all, and its
  // seat would otherwise win the histogram and lift the chair off y=0.
  if (candidateY - minY > (maxY - minY) * 0.15) return percentileY;
  return candidateY;
}

// Y-up assumed (Scaniverse exports are). Floor to y=0 and the XZ bbox centre to the origin.
export function placeOnFloor(object) {
  const floorY = detectFloorY(object);
  const box = new THREE.Box3().setFromObject(object);
  const c = box.getCenter(new THREE.Vector3());
  object.position.x -= c.x;
  object.position.z -= c.z;
  object.position.y -= floorY;
  object.updateMatrixWorld(true);
  return { floorY, box: new THREE.Box3().setFromObject(object) };
}

// Aim the camera at a scan WITHOUT moving it. v1's frameObject re-centres the model on the
// origin so gestures pivot on it; the platform keeps every scan standing on y=0 instead,
// because snapping furniture to the floor (P4) and per-object pivots (P1) both need one
// consistent floor, and a pivot belongs to whatever is selected, not to the whole scan.
function frameBox(box, camera, controls, elevation, margin) {
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = size.length() / 2; // bounding sphere: fits from any orbit angle
  const dist = (radius / Math.sin((camera.fov * Math.PI / 180) / 2)) * margin;

  const el = elevation;
  camera.position.set(centre.x, centre.y + Math.sin(el) * dist, centre.z + Math.cos(el) * dist);
  camera.near = dist / 200;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();

  controls.target.copy(centre);
  controls.minDistance = radius * 0.1;
  controls.maxDistance = dist * 3;
  controls.update();
  return { size, centre };
}

// Dollhouse view: camera above and outside the room at ~45 degrees, looking at its centre,
// so walls and furniture read as a model to inspect rather than a place you're stuck inside.
export const frameRoom = (box, camera, controls) => frameBox(box, camera, controls, Math.PI / 4, 1.05);

// A single object: a lower, closer three-quarter view, like looking at it across a room.
export const frameSingle = (box, camera, controls) => frameBox(box, camera, controls, Math.PI / 12, 1.1);

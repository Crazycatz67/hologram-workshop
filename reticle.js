import * as THREE from 'three';

// The pointer's reticle: a calm ring lying on the surface under the cursor, a faint beam from
// the ghost hand's index tip, and vertex snapping. Drawn in the scene, not as a DOM overlay,
// so it sits ON the model and tilts with the face it is over.
//
// CONTRACT
//   probe(ndcX, ndcY, { object, camera, viewport, snapped }) ->
//       { hit, point, normal, inferred, vertex } | null
//     Raycasts the cursor against `object` (recursive). viewport = { width, height } in CSS px.
//     `snapped`: the previous probe's vertex, or null, for hysteresis: a vertex is taken
//     within SNAP_IN_PX of the cursor and kept until it is SNAP_OUT_PX away. When snapped,
//     point is the vertex (world) and vertex = { object, index }. inferred = the hit mesh or
//     an ancestor has userData.inferred (platform/look.js marks Track B fill that way).
//     Pure: no state, so a click can re-probe the rewound cursor position.
//   createReticle(scene) -> reticle
//     reticle.update({ cursor: { x, y } | null, object, camera, viewport, beamFrom, nowMs })
//       -> the probe result for this frame (or null). Call once per display frame.
//       cursor null = hide (eased). beamFrom: world Vector3 of the aiming index tip, or null
//       (mouse: no beam).
//     reticle.pulse()   click feedback (a size bump, eased; never a brightness flash).
//     reticle.dispose()
//
// Photosafety (BUGS #14): every change of colour, opacity and size is eased with a time
// constant of EASE_MS, so no state change completes in under ~150 ms, and nothing here gets
// brighter than its resting look. Snap uses hysteresis so a cursor resting near the snap
// radius cannot flicker in and out of it.

export const SNAP_IN_PX = 14;
export const SNAP_OUT_PX = 22;
const RING_PX = 18;          // ring radius on screen (constant size at any distance)
const EASE_MS = 120;         // 1 - e^-1.25 = 71% after 150 ms, 95% after 360 ms
const MOVE_EASE_MS = 35;     // position follows quickly; it only smooths the snap jump
const COLOR = new THREE.Color(0x9fe8ff);
const INFERRED_COLOR = new THREE.Color(0xffb347); // amber: "this surface was filled in, not scanned"
const RING_OPACITY = 0.8;
const FREE_OPACITY = 0.35;   // cursor over empty space: present but quiet
const BEAM_OPACITY = 0.22;
const PULSE_MS = 320;

const raycaster = new THREE.Raycaster();
const tmpA = new THREE.Vector3();
const tmpN = new THREE.Matrix3();

function isInferred(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData?.inferred) return true;
  return false;
}

function toPx(world, camera, viewport) {
  tmpA.copy(world).project(camera);
  return { x: ((tmpA.x + 1) / 2) * viewport.width, y: ((1 - tmpA.y) / 2) * viewport.height };
}

function vertexWorld(mesh, index, out = new THREE.Vector3()) {
  out.fromBufferAttribute(mesh.geometry.attributes.position, index);
  return mesh.localToWorld(out);
}

export function probe(ndcX, ndcY, { object, camera, viewport, snapped = null }) {
  if (!object) return null;
  raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
  const hit = raycaster.intersectObject(object, true)[0];
  if (!hit) return null;

  const normal = hit.face
    ? hit.face.normal.clone().applyMatrix3(tmpN.getNormalMatrix(hit.object.matrixWorld)).normalize()
    : raycaster.ray.direction.clone().negate();
  // Face the camera whichever way the triangle is wound (scans are not consistently wound).
  if (normal.dot(raycaster.ray.direction) > 0) normal.negate();

  const cursorPx = { x: ((ndcX + 1) / 2) * viewport.width, y: ((1 - ndcY) / 2) * viewport.height };
  let vertex = null;
  let point = hit.point.clone();
  if (hit.face && hit.object.geometry?.attributes?.position) {
    // Keep the previous snap while the cursor is still within SNAP_OUT_PX of it.
    if (snapped && snapped.object === hit.object) {
      const p = vertexWorld(hit.object, snapped.index);
      const s = toPx(p, camera, viewport);
      if (Math.hypot(s.x - cursorPx.x, s.y - cursorPx.y) <= SNAP_OUT_PX) {
        vertex = snapped;
        point = p;
      }
    }
    if (!vertex) {
      let bestD = SNAP_IN_PX;
      for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
        const p = vertexWorld(hit.object, index);
        const s = toPx(p, camera, viewport);
        const d = Math.hypot(s.x - cursorPx.x, s.y - cursorPx.y);
        if (d <= bestD) {
          bestD = d;
          vertex = { object: hit.object, index };
          point = p;
        }
      }
    }
  }
  return { hit, point, normal, inferred: isInferred(hit.object), vertex };
}

export function createReticle(scene) {
  const group = new THREE.Group();
  group.renderOrder = 1000;
  scene.add(group);

  // Drawn over everything (depthTest off) so the ring is never half-buried in a rough scan.
  const overlay = (m) => Object.assign(m, { transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.82, 1, 48),
    overlay(new THREE.MeshBasicMaterial({ color: COLOR.clone(), side: THREE.DoubleSide }))
  );
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 24),
    overlay(new THREE.MeshBasicMaterial({ color: COLOR.clone(), side: THREE.DoubleSide }))
  );
  ring.renderOrder = dot.renderOrder = 1000;
  const holder = new THREE.Group(); // oriented to the surface; ring and dot lie in its XY plane
  holder.add(ring, dot);
  group.add(holder);

  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const beam = new THREE.Line(beamGeo, overlay(new THREE.LineBasicMaterial({ color: COLOR.clone() })));
  beam.renderOrder = 999;
  beam.frustumCulled = false;
  group.add(beam);

  // Eased values (current) and their targets.
  const e = { vis: 0, onSurface: 0, snap: 0, amber: 0, beam: 0, pulse: 0 };
  let lastT = null;
  let pulseAt = -Infinity;
  let snapped = null;
  const pos = new THREE.Vector3();
  let havePos = false;
  const quat = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);

  return {
    update({ cursor, object, camera, viewport, beamFrom = null, nowMs = performance.now() }) {
      const dt = lastT === null ? 16 : Math.min(100, Math.max(0, nowMs - lastT));
      lastT = nowMs;
      const k = 1 - Math.exp(-dt / EASE_MS);
      const kMove = 1 - Math.exp(-dt / MOVE_EASE_MS);
      const ease = (key, target) => (e[key] += (target - e[key]) * k);

      let result = null;
      let targetPos = null;
      let targetNormal = null;
      if (cursor && object) {
        result = probe(cursor.x, cursor.y, { object, camera, viewport, snapped });
        snapped = result?.vertex ?? null;
        if (result) {
          targetPos = result.point;
          targetNormal = result.normal;
        } else {
          // Over empty space: float the ring at the model's depth, facing the camera.
          raycaster.setFromCamera(cursor, camera);
          const depth = camera.position.distanceTo(object.getWorldPosition(tmpA));
          targetPos = raycaster.ray.at(depth, new THREE.Vector3());
          targetNormal = raycaster.ray.direction.clone().negate();
        }
      } else {
        snapped = null;
      }

      ease('vis', cursor && object ? 1 : 0);
      ease('onSurface', result ? 1 : 0);
      ease('snap', result?.vertex ? 1 : 0);
      ease('amber', result?.inferred ? 1 : 0);
      ease('beam', cursor && beamFrom ? 1 : 0);
      // Click pulse: a half-sine size bump over PULSE_MS, so it eases in as well as out.
      const sincePulse = nowMs - pulseAt;
      e.pulse = sincePulse >= 0 && sincePulse < PULSE_MS ? Math.sin((Math.PI * sincePulse) / PULSE_MS) : 0;

      if (targetPos) {
        quat.setFromUnitVectors(Z, targetNormal);
        if (!havePos) {
          // Appearing from hidden: start where the cursor is, not where it last vanished.
          pos.copy(targetPos);
          holder.quaternion.copy(quat);
        } else {
          pos.lerp(targetPos, kMove);
          holder.quaternion.slerp(quat, kMove);
        }
        havePos = true;
      } else if (e.vis < 0.002) {
        havePos = false;
      }

      // Constant on-screen size: world size of one CSS pixel at this distance.
      const dist = camera.position.distanceTo(pos);
      const pxWorld = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, viewport.height);
      const radius = RING_PX * pxWorld * (1 - 0.3 * e.snap) * (1 + 0.35 * e.pulse);
      holder.position.copy(pos);
      holder.scale.setScalar(radius);

      const color = COLOR.clone().lerp(INFERRED_COLOR, e.amber);
      const opacity = e.vis * (FREE_OPACITY + (RING_OPACITY - FREE_OPACITY) * e.onSurface);
      ring.material.color.copy(color);
      ring.material.opacity = opacity;
      dot.material.color.copy(color);
      dot.material.opacity = opacity * e.snap;

      const beamOpacity = BEAM_OPACITY * e.vis * e.beam;
      beam.material.color.copy(color);
      beam.material.opacity = beamOpacity;
      beam.visible = beamOpacity > 0.002 && !!beamFrom;
      if (beam.visible) {
        const a = beamGeo.attributes.position;
        a.setXYZ(0, beamFrom.x, beamFrom.y, beamFrom.z);
        a.setXYZ(1, pos.x, pos.y, pos.z);
        a.needsUpdate = true;
      }
      group.visible = opacity > 0.002 || beam.visible;
      return result;
    },

    pulse() {
      pulseAt = lastT ?? performance.now();
    },

    // Eased state, for tests and the live readout.
    get eased() {
      return { ...e };
    },

    dispose() {
      scene.remove(group);
      ring.geometry.dispose();
      ring.material.dispose();
      dot.geometry.dispose();
      dot.material.dispose();
      beamGeo.dispose();
      beam.material.dispose();
    }
  };
}

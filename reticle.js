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
//     hold (optional, 0..1): hold-to-select progress (pointer.js createSelector
//       visibleProgress). Drawn as an arc filling clockwise just outside the ring; it fades in
//       and out with EASE_MS and keeps its last fill while fading, so it never blinks off.
//     reticle.pulse()   click feedback (a size bump, eased; never a brightness flash).
//     reticle.dispose()
//   createPartHighlight(scene) -> highlight      the hovered exploded part's outline
//     highlight.update({ part | null, nowMs })    call once per display frame. The outline
//       (the part's edges, drawn over everything) fades in and out with EASE_MS; a change of
//       part fades the old one out before the new one fades in, so it never jumps or blinks.
//       Amber when the part is inferred (filled in, not scanned).
//     highlight.shown -> the part currently outlined (or fading out), or null
//     highlight.dispose()
//   partLabel(part) -> { name, inferred }   for the host's name chip ("part 3" when unnamed).
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
const HOLD_SEGMENTS = 64;

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
  // Hold-to-select arc: drawRange reveals whole theta segments, 6 indices each (RingGeometry
  // emits them in theta order). Mirrored in x so it fills clockwise from the top.
  const arc = new THREE.Mesh(
    new THREE.RingGeometry(1.12, 1.32, HOLD_SEGMENTS, 1, Math.PI / 2, Math.PI * 2),
    overlay(new THREE.MeshBasicMaterial({ color: COLOR.clone(), side: THREE.DoubleSide }))
  );
  arc.scale.x = -1;
  arc.renderOrder = 1000;
  arc.geometry.setDrawRange(0, 0);
  const holder = new THREE.Group(); // oriented to the surface; ring and dot lie in its XY plane
  holder.add(ring, dot, arc);
  group.add(holder);

  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const beam = new THREE.Line(beamGeo, overlay(new THREE.LineBasicMaterial({ color: COLOR.clone() })));
  beam.renderOrder = 999;
  beam.frustumCulled = false;
  group.add(beam);

  // Eased values (current) and their targets.
  const e = { vis: 0, onSurface: 0, snap: 0, amber: 0, beam: 0, pulse: 0, hold: 0 };
  let holdFill = 0; // last drawn fill, kept while the arc fades out
  let lastT = null;
  let pulseAt = -Infinity;
  let snapped = null;
  const pos = new THREE.Vector3();
  let havePos = false;
  const quat = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);

  return {
    update({ cursor, object, camera, viewport, beamFrom = null, nowMs = performance.now(), hold = 0 }) {
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
      const holding = cursor && hold > 0;
      if (holding) holdFill = Math.min(1, hold);
      ease('hold', holding ? 1 : 0);
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
      arc.material.color.copy(color);
      arc.material.opacity = e.vis * RING_OPACITY * e.hold;
      arc.geometry.setDrawRange(0, 6 * Math.round(HOLD_SEGMENTS * holdFill));
      arc.visible = arc.material.opacity > 0.002;

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
      return { ...e, holdFill };
    },

    dispose() {
      scene.remove(group);
      ring.geometry.dispose();
      ring.material.dispose();
      dot.geometry.dispose();
      dot.material.dispose();
      arc.geometry.dispose();
      arc.material.dispose();
      beamGeo.dispose();
      beam.material.dispose();
    }
  };
}

export function partLabel(part) {
  if (!part) return null;
  const idx = part.parent ? part.parent.children.filter((c) => c.isMesh).indexOf(part) : -1;
  return { name: part.name || `part ${idx + 1}`, inferred: isInferred(part) };
}

const OUTLINE_OPACITY = 0.7;
const OUTLINE_ANGLE_DEG = 30; // edges sharper than this are drawn (keeps a scan's noise out)

// The SELECTED part's lasting outline (owner-approved 2026-10-01, Ricky (f)): a second
// createPartHighlight, brighter than the hover one and drawn over it, with the same eased fades
// (EASE_MS in and out; nothing flashes, BUGS #14).
export const SELECTED_OUTLINE = { opacity: 1, color: new THREE.Color(0xdff8ff), renderOrder: 999 };

export function createPartHighlight(scene, { opacity: maxOpacity = OUTLINE_OPACITY, color = COLOR, renderOrder = 998 } = {}) {
  const base = new THREE.Color(color);
  const edgesOf = new WeakMap();
  const material = new THREE.LineBasicMaterial({ color: base.clone(), transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
  const lines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
  lines.renderOrder = renderOrder;
  lines.frustumCulled = false;
  lines.visible = false;
  scene.add(lines);
  let shown = null;
  let vis = 0;
  let amber = 0;
  let lastT = null;
  const edges = (part) => {
    let g = edgesOf.get(part.geometry);
    if (!g) {
      g = new THREE.EdgesGeometry(part.geometry, OUTLINE_ANGLE_DEG);
      edgesOf.set(part.geometry, g);
    }
    return g;
  };
  return {
    update({ part = null, nowMs = performance.now() } = {}) {
      const dt = lastT === null ? 16 : Math.min(100, Math.max(0, nowMs - lastT));
      lastT = nowMs;
      const k = 1 - Math.exp(-dt / EASE_MS);
      // Swap only once the old outline has faded out.
      if (part !== shown && vis < 0.02) {
        shown = part?.geometry ? part : null;
        if (shown) lines.geometry = edges(shown);
        amber = shown && isInferred(shown) ? 1 : 0;
      }
      vis += ((part && part === shown ? 1 : 0) - vis) * k;
      if (shown) {
        shown.updateWorldMatrix(true, false);
        lines.matrixAutoUpdate = false;
        lines.matrix.copy(shown.matrixWorld);
        lines.matrixWorld.copy(shown.matrixWorld);
      }
      material.color.copy(base).lerp(INFERRED_COLOR, amber);
      material.opacity = maxOpacity * vis;
      lines.visible = !!shown && material.opacity > 0.002;
      return shown;
    },
    get shown() { return shown; },
    get opacity() { return material.opacity; },
    dispose() {
      scene.remove(lines);
      material.dispose();
    }
  };
}

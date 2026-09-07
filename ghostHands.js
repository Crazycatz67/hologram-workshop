import * as THREE from 'three';

// Renders tracked hands as real geometry inside the 3D scene, at the same depth as the
// hologram, instead of a flat 2D skeleton drawn over a video feed. Reported directly after
// hiding the camera: without it, there was no way to tell where your hand actually was
// relative to the floating object — this is the replacement, closer to how a VR headset
// shows a tracked hand in passthrough rather than a 2D overlay.
//
// Landmark depth (z) is unreliable (see ROADMAP.md Phase 1), so every joint is placed on
// one flat plane facing the camera, at the same distance as the object itself — that's
// enough for the hand to read as "in the same place as the chair" without pretending to
// track real depth it doesn't have.

const JOINT_COLOR = 0x4fd1ff;
const PINCH_COLOR = 0x7fe3a1;
const FIST_COLOR = 0xffd166;
// Thickened from the original 0.012/0.005 after live feedback: correctly more 3D-legible
// than the flat overlay, but still read as "skeletal" (bead-and-stick) rather than the
// filled-in passthrough hand referenced (Quest-style hand tracking). Confirmed again on a
// real webcam ("still a skeletal view... prefer if we can fill in the skeleton"). A fully
// rigged, skinned hand mesh is still a bigger asset undertaking than this pass, but the
// PALM specifically doesn't need one: it's a single roughly-flat, roughly-convex region
// (wrist + the four finger-base knuckles), so a filled polygon across those points reads
// as a solid hand base immediately, closing most of the gap toward "filled in" cheaply.
// Fingers stay as bone-and-joint capsules — genuinely jointed, unlike the palm, so a filled
// plate there would either look like a mitten (one blob) or need per-segment skinning
// (the bigger undertaking this note has always deferred).
const JOINT_RADIUS = 0.02;
const BONE_RADIUS = 0.011;
const PALM_OPACITY = 0.5;

const FINGERTIPS = new Set([4, 8, 12, 16, 20]);
const PINCH_TIPS = new Set([4, 8]);
// Wrist, then the four finger MCPs in hand order (thumb's CMC stands in for its MCP, since
// landmark 1 sits closer to the actual base of the palm on that side) -- fan-triangulated
// from the wrist, this traces the palm's actual base rather than an arbitrary quad.
const PALM_LOOP = [0, 1, 5, 9, 13, 17];

function landmarkToWorld(landmark, camera, depth, mirror) {
  const mirroredX = mirror ? 1 - landmark.x : landmark.x;
  const height = 2 * depth * Math.tan((camera.fov * Math.PI) / 360);
  const width = height * camera.aspect;
  const localX = (mirroredX - 0.5) * width;
  const localY = (0.5 - landmark.y) * height;

  const forward = camera.getWorldDirection(new THREE.Vector3());
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();

  return camera.position
    .clone()
    .addScaledVector(forward, depth)
    .addScaledVector(right, localX)
    .addScaledVector(up, localY);
}

function orientBoneBetween(mesh, a, b) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a);
  const len = dir.length();
  mesh.position.copy(mid);
  mesh.scale.set(1, len, 1);
  if (len > 1e-6) {
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  }
  mesh.visible = len > 1e-6;
}

function createHandPool(scene, connections) {
  const group = new THREE.Group();
  scene.add(group);

  const jointGeo = new THREE.SphereGeometry(1, 10, 8);
  const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1);

  const joints = Array.from({ length: 21 }, () => {
    const mesh = new THREE.Mesh(jointGeo, new THREE.MeshBasicMaterial({ color: JOINT_COLOR, transparent: true, opacity: 0.9 }));
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });

  const bones = connections.map(() => {
    const mesh = new THREE.Mesh(boneGeo, new THREE.MeshBasicMaterial({ color: JOINT_COLOR, transparent: true, opacity: 0.55 }));
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });

  // A fan of triangles from the wrist across the four knuckle points, rebuilt every frame
  // from the tracked landmark positions (a real hand's palm isn't flat or rigid, so this
  // can't be a fixed shape scaled/oriented like the bones are -- it has to be re-triangulated
  // per frame from wherever those five points actually are). DoubleSide because the palm can
  // face either toward or away from the camera depending on hand orientation.
  const palmGeo = new THREE.BufferGeometry();
  palmGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PALM_LOOP.length * 3), 3));
  const palmIndices = [];
  for (let i = 1; i < PALM_LOOP.length - 1; i++) palmIndices.push(0, i, i + 1);
  palmGeo.setIndex(palmIndices);
  const palm = new THREE.Mesh(
    palmGeo,
    new THREE.MeshBasicMaterial({ color: JOINT_COLOR, transparent: true, opacity: PALM_OPACITY, side: THREE.DoubleSide })
  );
  palm.visible = false;
  group.add(palm);

  return { group, joints, bones, palm };
}

export function createGhostHands(scene, connections) {
  const pools = [createHandPool(scene, connections), createHandPool(scene, connections)];

  function hideAll(pool) {
    pool.joints.forEach((j) => (j.visible = false));
    pool.bones.forEach((b) => (b.visible = false));
    pool.palm.visible = false;
  }

  return {
    // hands: the tracked hands this frame (0-2), each already carrying .pinch and
    // whatever fist classification the caller computed. camera/object set where the flat
    // depth plane sits; aspect matches the video's own, same as everywhere else in Phase 1/4.
    update(hands, { camera, object, aspect, mirror = true, isFist = () => false }) {
      const depth = camera.position.distanceTo(object.position);

      for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        const hand = hands[i];
        if (!hand) {
          hideAll(pool);
          continue;
        }

        const pinching = hand.pinch?.pinching ?? false;
        const fisted = isFist(hand);
        const points = hand.landmarks.map((lm) => landmarkToWorld(lm, camera, depth, mirror));

        points.forEach((p, idx) => {
          const joint = pool.joints[idx];
          joint.position.copy(p);
          joint.visible = true;

          const isPinchTip = pinching && PINCH_TIPS.has(idx);
          const color = fisted ? FIST_COLOR : isPinchTip ? PINCH_COLOR : JOINT_COLOR;
          joint.material.color.setHex(color);

          const scale = FINGERTIPS.has(idx) ? (isPinchTip || fisted ? 1.8 : 1.3) : 1;
          joint.scale.setScalar(JOINT_RADIUS * scale);
        });

        connections.forEach((conn, idx) => {
          const bone = pool.bones[idx];
          orientBoneBetween(bone, points[conn.start], points[conn.end]);
          bone.scale.x = bone.scale.z = BONE_RADIUS;
          bone.material.color.setHex(fisted ? FIST_COLOR : JOINT_COLOR);
        });

        const palmPos = pool.palm.geometry.getAttribute('position');
        PALM_LOOP.forEach((landmarkIdx, i) => palmPos.setXYZ(i, points[landmarkIdx].x, points[landmarkIdx].y, points[landmarkIdx].z));
        palmPos.needsUpdate = true;
        pool.palm.geometry.computeVertexNormals();
        pool.palm.geometry.computeBoundingSphere();
        pool.palm.material.color.setHex(fisted ? FIST_COLOR : JOINT_COLOR);
        pool.palm.visible = true;
      }
    },

    dispose() {
      for (const pool of pools) {
        scene.remove(pool.group);
      }
    }
  };
}

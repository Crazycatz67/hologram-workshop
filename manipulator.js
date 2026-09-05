import * as THREE from 'three';
import { createStabilizer } from './stabilizer.js';
import { LANDMARK, handSpan, handAngle } from './gestures.js';

export const MODE = { IDLE: 'idle', GRAB: 'grab', TRANSFORM: 'transform' };

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

// Guards against a single bad frame teleporting or exploding the model: a hand that jumps
// half the frame, or a span that doubles between frames, is tracking noise rather than
// intent. Deltas beyond these are dropped.
const MAX_MOVE_PER_FRAME = 0.15;
const MAX_SPAN_RATIO_PER_FRAME = 1.5;

function wristOf(hand) {
  return hand.landmarks[LANDMARK.WRIST];
}

// Converts a normalized screen delta into world units at the object's depth, so dragging
// tracks the hand roughly 1:1 rather than at some arbitrary tuned speed.
function worldPerScreenUnit(camera, object) {
  const distance = camera.position.distanceTo(object.position);
  const height = 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
  return { x: height * camera.aspect, y: height };
}

export function createManipulator(object, camera) {
  const grab = createStabilizer({ enter: 3, exit: 6 });
  const transform = createStabilizer({ enter: 3, exit: 6 });

  const home = {
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone()
  };

  let lastWrist = null;
  let lastSpan = null;
  let lastAngle = null;
  let mode = MODE.IDLE;

  function clearGrab() {
    lastWrist = null;
  }

  function clearTransform() {
    lastSpan = null;
    lastAngle = null;
  }

  return {
    get mode() {
      return mode;
    },

    reset() {
      object.position.copy(home.position);
      object.quaternion.copy(home.quaternion);
      object.scale.copy(home.scale);
      grab.reset();
      transform.reset();
      clearGrab();
      clearTransform();
      mode = MODE.IDLE;
    },

    update(hands, aspect) {
      const twoHanded = hands.length === 2 && hands.every((h) => h.pinch?.pinching);
      const fisted = hands.length >= 1 && hands.some((h) => h.gesture === 'Closed_Fist');

      // Two-handed transform outranks grab: with both hands up, a fist reading on one of
      // them is far more likely to be a misclassification than an intent to drag.
      const transforming = transform.update(twoHanded);
      const grabbing = grab.update(fisted && !transforming);

      if (transforming) {
        mode = MODE.TRANSFORM;
        clearGrab();
        applyTransform(hands, aspect);
      } else if (grabbing) {
        mode = MODE.GRAB;
        clearTransform();
        applyGrab(hands);
      } else {
        mode = MODE.IDLE;
        clearGrab();
        clearTransform();
      }

      return mode;
    }
  };

  function applyGrab(hands) {
    const hand = hands.find((h) => h.gesture === 'Closed_Fist') ?? hands[0];
    const wrist = wristOf(hand);

    if (lastWrist) {
      // Landmark x runs left-to-right in the raw frame while the view is mirrored, so the
      // sign is flipped here to make the model follow the hand the user actually sees.
      const dx = -(wrist.x - lastWrist.x);
      const dy = wrist.y - lastWrist.y;

      if (Math.abs(dx) < MAX_MOVE_PER_FRAME && Math.abs(dy) < MAX_MOVE_PER_FRAME) {
        const perUnit = worldPerScreenUnit(camera, object);
        object.position.x += dx * perUnit.x;
        object.position.y -= dy * perUnit.y;
      }
    }

    lastWrist = { x: wrist.x, y: wrist.y };
  }

  function applyTransform(hands, aspect) {
    const span = handSpan(hands[0], hands[1], aspect);
    const angle = handAngle(hands[0], hands[1], aspect);

    if (lastSpan && span > 0) {
      const ratio = span / lastSpan;
      if (ratio > 1 / MAX_SPAN_RATIO_PER_FRAME && ratio < MAX_SPAN_RATIO_PER_FRAME) {
        const next = THREE.MathUtils.clamp(object.scale.x * ratio, MIN_SCALE, MAX_SCALE);
        object.scale.setScalar(next);
      }
    }

    if (lastAngle !== null) {
      let delta = angle - lastAngle;
      // Keep the shortest way round, so crossing the ±180° seam doesn't spin the model.
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      // Mirrored view again: twisting the hands clockwise should turn the model clockwise.
      object.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), -delta);
    }

    lastSpan = span;
    lastAngle = angle;
  }
}

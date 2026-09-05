import * as THREE from 'three';
import { createStabilizer } from './stabilizer.js';
import { handSpan, handTwist, isFistLike } from './gestures.js';

export const MODE = { IDLE: 'idle', GRAB: 'grab', TRANSFORM: 'transform' };

const MIN_SCALE = 0.2;
// Lowered from 5 after live testing: frameObject() already sizes the model to comfortably
// fill the view at scale 1, so 5x let it grow far past the edges of the screen -- reported
// as making it hard to see what you were doing or get gestures to register. 2.5 still
// gives real "make it huge" range without the object swallowing the whole viewport.
const MAX_SCALE = 2.5;

// Guards against a single bad frame teleporting, exploding, or wildly spinning the model:
// a hand that jumps half the frame, a span that doubles between frames, or a knuckle-angle
// that swings 60 degrees in one tick is tracking noise rather than intent.
const MAX_MOVE_PER_FRAME = 0.15;
const MAX_SPAN_RATIO_PER_FRAME = 1.5;
const MAX_TWIST_PER_FRAME = Math.PI / 3;

// Keeps the object's pivot within this fraction of the visible frustum at its own depth,
// so a fast or erratic drag can never carry it fully off-screen — losing it that way had
// no recovery except Reset, reported directly as frustrating during live testing.
const VIEW_MARGIN = 0.7;

// Grab no longer applies a raw per-frame delta directly to the object — it only sets a
// target velocity. Every update() call decays and applies whatever velocity currently
// exists, whether or not a hand is still gripping. Reported live: releasing a twist felt
// like "a direct pause" — the rotation stopped dead the instant tracking stopped feeding
// a delta. This lets it coast for a few frames instead, closer to how spinning something
// with real momentum behaves.
const VELOCITY_DAMPING = 0.85;
const MIN_ANGULAR_VELOCITY = 0.0005;
const MIN_LINEAR_VELOCITY = 0.00005;

// A clap — hands rapidly closing together — resets the hologram. Re-arms only once the
// hands separate again, so holding them together doesn't fire it repeatedly.
//
// Reported live 2026-09-05: didn't fire at all in testing. Unlike PINCH_THRESHOLD, these
// three numbers were never calibrated against a real clap — a real clap is also exactly
// the kind of fast motion that MediaPipe tracks worst (see Phase 1's known risks), so a
// real attempt may genuinely drop hand detection for a frame or two right at the moment
// of impact. Loosened as a reasonable guess pending real numbers; `readoutEl` now prints
// live span so the next test can report actual values instead of another guess.
const CLAP_CLOSE_SPAN = 0.45;
const CLAP_ARM_SPAN = 0.6;
const CLAP_MIN_CLOSING_SPEED = 0.08;

function wristOf(hand) {
  return hand.landmarks[0];
}

// Converts a normalized screen delta into world units at the object's depth, so dragging
// tracks the hand roughly 1:1 rather than at some arbitrary tuned speed.
function worldPerScreenUnit(camera, object) {
  const distance = camera.position.distanceTo(object.position);
  const height = 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
  return { x: height * camera.aspect, y: height };
}

function clampToView(object, camera) {
  const perUnit = worldPerScreenUnit(camera, object);
  const maxX = (perUnit.x / 2) * VIEW_MARGIN;
  const maxY = (perUnit.y / 2) * VIEW_MARGIN;
  object.position.x = THREE.MathUtils.clamp(object.position.x, -maxX, maxX);
  object.position.y = THREE.MathUtils.clamp(object.position.y, -maxY, maxY);
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
  let lastTwist = null;
  let lastSpan = null;
  let mode = MODE.IDLE;

  let angularVelocity = 0;
  let linearVelocityX = 0;
  let linearVelocityY = 0;

  let clapArmed = true;
  let lastClapSpan = null;

  function clearGrab() {
    lastWrist = null;
    lastTwist = null;
  }

  function clearTransform() {
    lastSpan = null;
  }

  function performReset() {
    object.position.copy(home.position);
    object.quaternion.copy(home.quaternion);
    object.scale.copy(home.scale);
    grab.reset();
    transform.reset();
    clearGrab();
    clearTransform();
    angularVelocity = 0;
    linearVelocityX = 0;
    linearVelocityY = 0;
    mode = MODE.IDLE;
  }

  // A clap requires open hands, not pinching ones — both because that's what a real clap
  // physically is, and because scaling down aggressively (pinching hands closing fast) is
  // otherwise indistinguishable from a clap by span alone. Found by testing: scaling all
  // the way down to nearly-touching in one quick step triggered a false reset before this
  // guard existed.
  function checkClap(hands, aspect) {
    if (hands.some((h) => h.pinch?.pinching)) {
      lastClapSpan = null;
      return false;
    }
    const span = handSpan(hands[0], hands[1], aspect);
    if (span > CLAP_ARM_SPAN) clapArmed = true;

    const closingSpeed = lastClapSpan !== null ? lastClapSpan - span : 0;
    const clapped = clapArmed && span < CLAP_CLOSE_SPAN && closingSpeed > CLAP_MIN_CLOSING_SPEED;
    if (clapped) clapArmed = false;

    lastClapSpan = span;
    return clapped;
  }

  return {
    get mode() {
      return mode;
    },

    reset: performReset,

    update(hands, aspect) {
      if (hands.length === 2 && checkClap(hands, aspect)) {
        performReset();
        return mode;
      }

      const twoHanded = hands.length === 2 && hands.every((h) => h.pinch?.pinching);
      // isFistLike trusts MediaPipe's own classifier when it has a confident opinion
      // either way, and only falls back to geometric curl detection when it doesn't (see
      // gestures.js) — a thumbs-up and a loosely-closed hand were both registering as a
      // grab before that gating existed.
      const fisted = hands.some((h) => isFistLike(h.gesture, h.landmarks, aspect));

      // Two-handed transform outranks grab: with both hands up, a fist reading on one of
      // them is far more likely to be a misclassification than an intent to drag.
      const transforming = transform.update(twoHanded);
      const grabbing = grab.update(fisted && !transforming);

      if (transforming) {
        mode = MODE.TRANSFORM;
        clearGrab();
        // Hysteresis can hold this mode true for a few frames after a hand drops out —
        // that's the point of it, so a momentary tracking dropout doesn't cancel the
        // gesture. But it means `hands` can still have fewer than 2 entries here.
        // Skipping the write just holds the last scale until hysteresis resolves.
        if (hands.length === 2) applyTransform(hands, aspect);
      } else if (grabbing) {
        mode = MODE.GRAB;
        clearTransform();
        if (hands.length >= 1) setGrabVelocity(hands, aspect);
        else clearGrab(); // hand is gone, not just paused — drop the reference so no jump on return
      } else {
        mode = MODE.IDLE;
        clearGrab();
        clearTransform();
      }

      applyMomentum();
      return mode;
    }
  };

  // A single closed fist both moves the object (from wrist position) and spins it (from
  // twisting the wrist like turning a doorknob) — this replaced a two-hand pinch-and-twist
  // rotate after live testing called it "janky and cluttered." Sets velocity rather than
  // applying position/rotation directly; applyMomentum() below does the actual moving, so
  // motion can keep coasting for a moment after the grab itself ends.
  function setGrabVelocity(hands, aspect) {
    const hand = hands.find((h) => isFistLike(h.gesture, h.landmarks, aspect)) ?? hands[0];
    const wrist = wristOf(hand);
    const twist = handTwist(hand.landmarks, aspect);

    if (lastWrist) {
      // Landmark x runs left-to-right in the raw frame while the view is mirrored, so the
      // sign is flipped here to make the model follow the hand the user actually sees.
      const dx = -(wrist.x - lastWrist.x);
      const dy = wrist.y - lastWrist.y;

      if (Math.abs(dx) < MAX_MOVE_PER_FRAME && Math.abs(dy) < MAX_MOVE_PER_FRAME) {
        const perUnit = worldPerScreenUnit(camera, object);
        linearVelocityX = dx * perUnit.x;
        linearVelocityY = -dy * perUnit.y;
      }
    }

    if (lastTwist !== null) {
      let delta = twist - lastTwist;
      // Keep the shortest way round, so crossing the ±180° seam doesn't spin the model.
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;

      // Twisting your wrist is really a roll around the camera-viewing axis, but mapping
      // that to spin the object around ITS vertical axis instead — like a lazy Susan —
      // is what's actually useful for looking at the sides of something like a chair.
      // Deliberate stylization, not a literal transfer of the physical motion.
      if (Math.abs(delta) < MAX_TWIST_PER_FRAME) angularVelocity = delta;
    }

    lastWrist = { x: wrist.x, y: wrist.y };
    lastTwist = twist;
  }

  // Applies whatever velocity currently exists and decays it — runs every update() call
  // regardless of mode, which is what lets a released grab keep coasting briefly instead
  // of stopping dead the instant the gesture ends.
  function applyMomentum() {
    if (Math.abs(angularVelocity) > MIN_ANGULAR_VELOCITY) {
      object.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), angularVelocity);
    }
    angularVelocity *= VELOCITY_DAMPING;

    if (linearVelocityX * linearVelocityX + linearVelocityY * linearVelocityY > MIN_LINEAR_VELOCITY * MIN_LINEAR_VELOCITY) {
      object.position.x += linearVelocityX;
      object.position.y += linearVelocityY;
      clampToView(object, camera);
    }
    linearVelocityX *= VELOCITY_DAMPING;
    linearVelocityY *= VELOCITY_DAMPING;
  }

  function applyTransform(hands, aspect) {
    const span = handSpan(hands[0], hands[1], aspect);

    if (lastSpan && span > 0) {
      const ratio = span / lastSpan;
      if (ratio > 1 / MAX_SPAN_RATIO_PER_FRAME && ratio < MAX_SPAN_RATIO_PER_FRAME) {
        const next = THREE.MathUtils.clamp(object.scale.x * ratio, MIN_SCALE, MAX_SCALE);
        object.scale.setScalar(next);
      }
    }

    lastSpan = span;
  }
}

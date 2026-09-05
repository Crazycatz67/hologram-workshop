import * as THREE from 'three';
import { createStabilizer } from './stabilizer.js';
import { handSpan, handTwist, isFistLike, palmLength } from './gestures.js';

export const MODE = { IDLE: 'idle', GRAB: 'grab', TRANSFORM: 'transform', EXPLODE: 'explode' };

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
const MAX_PITCH_PER_FRAME = Math.PI / 3;
const MAX_DEPTH_RATIO_PER_FRAME = 1.5;

// Radians of pitch per normalized frame-height the second hand moves — an untuned guess,
// same as every other sensitivity constant here started out; needs a real hand to tune.
const PITCH_SENSITIVITY = Math.PI;

// Push/pull moves the object nearer or farther along the camera-to-object line, clamped
// to this range of the distance it started at — close enough (0.3x) that pulling it
// toward you feels real, far enough (3x) it can still retreat a long way, but it can
// never clip into the camera or shrink to a vanishing point.
const MIN_DEPTH_RATIO = 0.3;
const MAX_DEPTH_RATIO = 3;

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

// Explode: two open hands (neither fisted nor pinching, keeping it out of grab/scale's
// hand-shape space) pulling apart drives it, continuously, like scale rather than a
// one-shot trigger like clap. Untuned guess for the span-to-amount conversion, same as
// every other sensitivity constant here.
const EXPLODE_SENSITIVITY = 0.6;
const MAX_EXPLODE_SPAN_DELTA_PER_FRAME = 2;
// Single-mesh objects (no separate parts to pull apart) get a non-uniform vertical stretch
// instead — deliberately distinct from pinch-scale's uniform resize, so the two gestures
// don't produce the same-looking result on an object like the chair.
const MAX_STRETCH = 1.2;
// Literal explode (multi-part meshes): each part moves outward from the object's overall
// centroid along its own direction, up to this fraction of the object's own size. Only
// unit-tested against synthetic multi-mesh data — no real multi-part scan exists yet.
const MAX_EXPLODE_OFFSET = 0.6;

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

// Finds every mesh under `object` and records where each sits relative to the group's own
// centroid, so literal explode has a "this part's outward direction" for each one to push
// along. Assumes each mesh's own `.position` is meaningful relative to a shared parent —
// true for a simple multi-mesh group (what the synthetic test below uses), but real
// multi-part exports vary in how they nest transforms; revisit once a real one exists.
function findExplodeParts(object) {
  const parts = [];
  object.traverse((child) => {
    if (child.isMesh) parts.push(child);
  });

  if (parts.length < 2) return { literal: false, parts: [] };

  const centroid = new THREE.Vector3();
  for (const part of parts) centroid.add(part.position);
  centroid.divideScalar(parts.length);

  for (const part of parts) {
    const offset = part.position.clone().sub(centroid);
    part.userData.explodeHome = part.position.clone();
    part.userData.explodeDir = offset.lengthSq() > 1e-8 ? offset.normalize() : new THREE.Vector3(0, 1, 0);
  }

  return { literal: true, parts };
}

export function createManipulator(object, camera) {
  const grab = createStabilizer({ enter: 3, exit: 6 });
  const transform = createStabilizer({ enter: 3, exit: 6 });
  const explode = createStabilizer({ enter: 3, exit: 6 });

  const home = {
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
    distance: camera.position.distanceTo(object.position)
  };

  const { literal: literalMode, parts: explodeParts } = findExplodeParts(object);

  let lastWrist = null;
  let lastTwist = null;
  let lastPitchWrist = null;
  let lastPalm = null;
  let lastSpan = null;
  let lastExplodeSpan = null;
  let explodeAmount = 0;
  let mode = MODE.IDLE;

  let angularVelocity = 0;
  let pitchVelocity = 0;
  let depthVelocity = 0;
  let linearVelocityX = 0;
  let linearVelocityY = 0;

  let clapArmed = true;
  let lastClapSpan = null;

  function clearGrab() {
    lastWrist = null;
    lastTwist = null;
    lastPitchWrist = null;
    lastPalm = null;
  }

  function clearTransform() {
    lastSpan = null;
  }

  // Only clears the tracking reference, not explodeAmount or the applied transform itself
  // — releasing the gesture holds whatever shape it left, the same as letting go of grab
  // leaves the object wherever it was moved to, rather than snapping back.
  function clearExplode() {
    lastExplodeSpan = null;
  }

  function performReset() {
    object.position.copy(home.position);
    object.quaternion.copy(home.quaternion);
    object.scale.copy(home.scale);
    grab.reset();
    transform.reset();
    explode.reset();
    clearGrab();
    clearTransform();
    clearExplode();
    explodeAmount = 0;
    if (literalMode) {
      for (const part of explodeParts) part.position.copy(part.userData.explodeHome);
    }
    angularVelocity = 0;
    pitchVelocity = 0;
    depthVelocity = 0;
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

    // For a HUD indicator: which explode behavior this object will actually use, decided
    // once from its mesh count at creation. True only means a second scan happened to be
    // multi-part — no manual override exists yet, since only one scan (single-mesh) exists
    // to test against.
    get explodeIsLiteral() {
      return literalMode;
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
      // Explode's trigger occupies a hand-shape space disjoint from both pinch (transform)
      // and fist (grab) on purpose — two open hands, neither pinching nor fisted — so it
      // can never fire from the same pose as either of those.
      const openHanded =
        hands.length === 2 && hands.every((h) => !isFistLike(h.gesture, h.landmarks, aspect) && !h.pinch?.pinching);

      // Two-handed transform outranks grab and explode: with both hands up, a fist or
      // open-hand reading on either one is far more likely to be a misclassification mid-
      // pinch than a real change of gesture.
      const transforming = transform.update(twoHanded);
      const exploding = explode.update(openHanded && !transforming);
      const grabbing = grab.update(fisted && !transforming && !exploding);

      if (transforming) {
        mode = MODE.TRANSFORM;
        clearGrab();
        clearExplode();
        // Hysteresis can hold this mode true for a few frames after a hand drops out —
        // that's the point of it, so a momentary tracking dropout doesn't cancel the
        // gesture. But it means `hands` can still have fewer than 2 entries here.
        // Skipping the write just holds the last scale until hysteresis resolves.
        if (hands.length === 2) applyTransform(hands, aspect);
      } else if (exploding) {
        mode = MODE.EXPLODE;
        clearGrab();
        clearTransform();
        if (hands.length === 2) applyExplode(hands, aspect);
      } else if (grabbing) {
        mode = MODE.GRAB;
        clearTransform();
        clearExplode();
        if (hands.length >= 1) setGrabVelocity(hands, aspect);
        else clearGrab(); // hand is gone, not just paused — drop the reference so no jump on return
      } else {
        mode = MODE.IDLE;
        clearGrab();
        clearTransform();
        clearExplode();
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
  //
  // If a second hand is also up, its raw vertical position independently drives pitch
  // (tipping the object up/down) — requested directly ("I wanna rotate it vertically, not
  // horizontally"). One hand holds and spins side-to-side, the other tips it, matching how
  // you'd actually handle a real object with both hands. The second hand doesn't need any
  // particular shape; it just needs to not be the hand already doing the grabbing.
  //
  // The grabbing hand's own apparent size also drives push/pull: moving your fist closer
  // to the camera makes it read bigger in frame, farther makes it read smaller, and that
  // change is a genuine depth signal — see palmLength() in gestures.js for why it's used
  // over MediaPipe's own (noisier) z-coordinate.
  function setGrabVelocity(hands, aspect) {
    const hand = hands.find((h) => isFistLike(h.gesture, h.landmarks, aspect)) ?? hands[0];
    const wrist = wristOf(hand);
    const twist = handTwist(hand.landmarks, aspect);
    const palm = palmLength(hand.landmarks, aspect);
    const pitchHand = hands.find((h) => h !== hand);

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

    if (pitchHand) {
      const pitchWrist = wristOf(pitchHand);
      if (lastPitchWrist) {
        const dy = pitchWrist.y - lastPitchWrist.y;
        if (Math.abs(dy) * PITCH_SENSITIVITY < MAX_PITCH_PER_FRAME) pitchVelocity = -dy * PITCH_SENSITIVITY;
      }
      lastPitchWrist = { y: pitchWrist.y };
    } else {
      lastPitchWrist = null;
    }

    if (lastPalm && palm > 0) {
      const ratio = palm / lastPalm;
      if (ratio > 1 / MAX_DEPTH_RATIO_PER_FRAME && ratio < MAX_DEPTH_RATIO_PER_FRAME) {
        // Hand got bigger (closer to camera) -> pull the object closer too; smaller -> push
        // it away. Stored as a ratio, same shape as scale's, not a screen-space delta.
        depthVelocity = ratio - 1;
      }
    }
    lastPalm = palm;

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

    if (Math.abs(pitchVelocity) > MIN_ANGULAR_VELOCITY) {
      // World X, not the object's own local X: yaw already changes what the object's
      // local axes point in, and pitch should still mean "tip toward/away from the
      // camera" regardless of however much it's currently spun — same reasoning as yaw
      // using world Y rather than local Y.
      object.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), pitchVelocity);
    }
    pitchVelocity *= VELOCITY_DAMPING;

    if (Math.abs(depthVelocity) > MIN_LINEAR_VELOCITY) {
      // Moves along the actual camera-to-object line (via the camera's current basis),
      // not a fixed world axis, so this still behaves correctly after the view has been
      // orbited with the mouse.
      const currentDistance = camera.position.distanceTo(object.position);
      const direction = object.position.clone().sub(camera.position).normalize();
      // Divides rather than multiplies: depthVelocity is positive when the hand got
      // BIGGER (closer to camera), and that should SHRINK the object's distance (pull it
      // closer), not grow it. Multiplying here was backwards and sent the object away
      // from the camera when the hand approached it -- caught by testing before shipping.
      const targetDistance = THREE.MathUtils.clamp(
        currentDistance / (1 + depthVelocity),
        home.distance * MIN_DEPTH_RATIO,
        home.distance * MAX_DEPTH_RATIO
      );
      object.position.copy(camera.position).addScaledVector(direction, targetDistance);
    }
    depthVelocity *= VELOCITY_DAMPING;

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

  // Two open hands pulling apart: on a multi-part object, each mesh slides outward from
  // the group's centroid along its own direction (literal explode); on a single-mesh
  // object like the chair, there's nothing separate to pull apart, so it stretches the
  // whole hologram vertically instead — deliberately non-uniform, so it doesn't look like
  // the same uniform resize two-hand pinch already does.
  //
  // Both branches update incrementally from the span delta, the same pattern applyTransform
  // uses for scale, rather than computing from a captured baseline — that avoids a
  // real bug class: a baseline captured fresh each time explode mode is re-entered would
  // compound with whatever amount was already applied from a previous session.
  function applyExplode(hands, aspect) {
    const span = handSpan(hands[0], hands[1], aspect);

    if (lastExplodeSpan !== null) {
      const delta = span - lastExplodeSpan;
      if (Math.abs(delta) < MAX_EXPLODE_SPAN_DELTA_PER_FRAME) {
        if (literalMode) {
          explodeAmount = THREE.MathUtils.clamp(explodeAmount + delta * EXPLODE_SENSITIVITY, 0, 1);
          for (const part of explodeParts) {
            part.position.copy(part.userData.explodeHome).addScaledVector(part.userData.explodeDir, explodeAmount * MAX_EXPLODE_OFFSET);
          }
        } else {
          const stretchRatio = 1 + delta * EXPLODE_SENSITIVITY;
          object.scale.y = THREE.MathUtils.clamp(
            object.scale.y * stretchRatio,
            home.scale.y,
            home.scale.y * (1 + MAX_STRETCH)
          );
        }
      }
    }

    lastExplodeSpan = span;
  }
}

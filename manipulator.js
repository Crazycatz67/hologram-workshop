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
// Reported live 2026-09-05: didn't fire at all in testing, so the closing-speed threshold
// was loosened. Testing afterward found the opposite failure: a slow, ordinary hand
// relaxation (not a deliberate clap) could ALSO fire it. Root cause common to both: speed
// was measured as span-change-per-CALL, which isn't actually speed — it's confounded with
// frame rate. Drop a couple of tracking frames (a real, documented risk here) and the same
// physical motion produces a bigger apparent per-frame jump purely from fewer samples,
// not from moving faster. Measuring span-change-per-real-SECOND (see checkClap, which now
// takes a timestamp) fixes both directions at once: a genuine clap has real velocity high
// enough to clear the bar regardless of frame rate, and a slow relaxation doesn't, also
// regardless of frame rate.
// UNITS: handSpan() returns the distance between the wrists divided by the average PALM
// LENGTH — i.e. "how many palms apart are the hands", not a 0-1 fraction of the frame.
// These constants were originally written as though it were the latter, which made the
// clap gesture impossible to perform rather than merely fussy: measured across realistic
// geometry, span only drops below the old 0.45 threshold when the two wrists are 0.01-0.03
// of the frame apart, i.e. essentially the same point in the image. In a real clap the
// palms touch while the wrists stay roughly 0.06-0.10 apart, giving a span near 1.0-1.8 —
// so the close test could never pass and reset-by-clapping never fired at all. That matches
// it being reported as not working during live testing.
//
// Re-derived from the measured span table: hands spread apart read 4-9 palms, hands clapped
// together read 0.8-1.5 palms.
const CLAP_CLOSE_SPAN = 1.5;
const CLAP_ARM_SPAN = 4.0;
// Span-units (palm-lengths) per second, not per frame. Rescaled along with the two spans
// above, since it was expressed in the same wrong unit: a deliberate clap closes roughly 5
// palm-lengths in about 200ms, so ~25/s, while slowly bringing the hands together over a
// couple of seconds is nearer 2.5/s. This sits between them.
const CLAP_MIN_CLOSING_SPEED = 8.0;

// Explode: two open hands (neither fisted nor pinching, keeping it out of grab/scale's
// hand-shape space) pulling apart drives it, continuously, like scale rather than a
// one-shot trigger like clap. Untuned guess for the span-to-amount conversion, same as
// every other sensitivity constant here.
const EXPLODE_SENSITIVITY = 0.6;
const MAX_EXPLODE_SPAN_DELTA_PER_FRAME = 2;
// Single-mesh objects (no separate parts to pull apart) get a non-uniform vertical stretch
// instead — deliberately distinct from pinch-scale's uniform resize, so the two gestures
// don't produce the same-looking result on an object like the chair. Clamped to the same
// MAX_SCALE ceiling pinch-scale uses (see applyExplode) rather than its own fixed value —
// an earlier version used a separate, lower absolute ceiling, and if scale had already
// pushed scale.y past it, the moment explode engaged it snapped scale.y sharply DOWN to
// that lower ceiling on the very first frame, a jarring, unintended shrink. Sharing one
// ceiling between both gestures means neither one's cap can undercut what the other
// already applied.
// Literal explode (multi-part meshes): each part moves outward from the object's overall
// centroid along its own direction, up to this fraction of the object's own size. Only
// unit-tested against synthetic multi-mesh data — no real multi-part scan exists yet.
const MAX_EXPLODE_OFFSET = 0.6;

// Hand tracking is never perfectly still: even with a hand held motionless and landmark
// smoothing applied, positions jitter by roughly 0.002 in normalized frame units every
// frame. Nothing rejected that, so every frame of noise was written straight into a
// velocity and then coasted by momentum. Measured before this existed: a completely
// stationary fist drifted the model 6.0cm, spun it 2.2 degrees and pushed it 3.5cm in
// depth over 1.5 seconds -- reported as "it keeps accidentally moving around and doing
// commands I never intended".
//
// These are SOFT deadzones (see deadzone()): the threshold is subtracted rather than
// gating, so motion eases up from zero instead of snapping to full speed the instant it
// crosses the line. Hard gating would trade drift for a jolt at the threshold, which is
// the other half of the complaint -- that none of it felt fluid.
//
// Sized between the two: noise is ~0.002/frame, while deliberately sweeping a hand across
// the frame in a second is ~0.008/frame at 60fps.
// Velocity is read as the GAP BETWEEN two exponential filters of the same signal — one
// quick, one slow — instead of the difference between consecutive frames.
//
// Frame-to-frame differencing cannot work here, and that is measured, not assumed. For a
// hand held still with realistic landmark jitter, the per-frame noise in each signal versus
// the per-frame signal from deliberately moving that hand across the frame in one second:
//
//                        noise (median)    deliberate motion
//   wrist position       0.0012 - 0.0026   0.0083     workable
//   twist angle          0.0141 - 0.0417   ~0.026     marginal
//   palm size ratio      0.0157 - 0.0360   0.0082     HOPELESS -- noise exceeds signal
//
// Push/pull read frame-to-frame is pure noise: a deadzone high enough to reject it would be
// several times larger than the real gesture, so the choice was drift or a dead gesture.
//
// Two filters fix it because real motion is SUSTAINED and noise is not. Both filters track
// a moving hand, the quick one leading the slow one by an amount proportional to speed, so
// the gap between them is a velocity estimate averaged over many frames. Noise averages
// out; a steady push does not. When the hand stops, the two converge and the gap decays to
// zero on its own, which also gives motion a natural run-down instead of a hard stop.
const FILTER_FAST = 0.35;
const FILTER_SLOW = 0.12;
// Converts the filter gap back into per-frame units. For a signal ramping at v per frame,
// an exponential filter with weight a settles v*(1-a)/a behind it, so the gap between the
// two filters settles at v * ((1-SLOW)/SLOW - (1-FAST)/FAST). Dividing by that recovers v
// and keeps hand-to-object motion at roughly 1:1, as it was before.
const FILTER_GAIN =
  1 / ((1 - FILTER_SLOW) / FILTER_SLOW - (1 - FILTER_FAST) / FILTER_FAST);

// These apply to the FILTERED velocity, not to a raw frame-to-frame difference, so they are
// much smaller than the raw noise figures above — the filter has already removed most of it
// and these only mop up the residue. Sizing them for raw noise was a mistake worth recording:
// at 0.004 the deadzone was subtracting most of a real gesture (deliberate motion is only
// ~0.005/frame), and a full hand sweep across a third of the frame moved the model 5cm
// instead of tracking the hand.
const MOVE_DEADZONE = 0.0008;   // normalized frame units per frame
const TWIST_DEADZONE = 0.004;   // radians per frame
const PITCH_DEADZONE = 0.0008;  // normalized frame units per frame
const DEPTH_DEADZONE = 0.005;   // ratio deviation per frame -- larger than the others on
                                // purpose: apparent hand size is the noisiest signal here,
                                // and also the one with the most headroom, since a real
                                // push moves the model far more than a real sideways sweep

function deadzone(value, threshold) {
  if (value > threshold) return value - threshold;
  if (value < -threshold) return value + threshold;
  return 0;
}

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

// Every channel a gesture can drive, individually switchable. Reported live as "it keeps
// accidentally moving around and doing commands I never intended": with everything armed
// at once there is no way to tell which channel misfired, because a single fist drives
// four of them simultaneously (move, spin, tilt, push) and a misread hand shape can hand
// control to a different mode entirely. Practice mode arms exactly one of these, so a
// gesture can be learned and tuned in isolation without anything else bleeding in.
export const CHANNELS = ['move', 'spin', 'tilt', 'push', 'scale', 'explode', 'clap'];

export function createManipulator(object, camera) {
  // Live-tunable, because every threshold in this file is an untuned guess made without a
  // webcam (see ROADMAP.md Phase 1) and the only way to fix "out of proportion" is to
  // adjust it against real hands and watch what happens.
  const settings = {
    channels: new Set(CHANNELS), // all armed = normal use; one entry = practice mode
    sensitivity: 1.0,
    momentum: true,
    triggerFrames: 3             // consecutive frames a gesture must hold before it fires
  };

  let grab = createStabilizer({ enter: settings.triggerFrames, exit: 6 });
  let transform = createStabilizer({ enter: settings.triggerFrames, exit: 6 });
  let explode = createStabilizer({ enter: settings.triggerFrames, exit: 6 });

  const on = (channel) => settings.channels.has(channel);

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
  let twistAccum = 0;
  // Two exponential filters over every tracked signal, one quick and one slow. See
  // FILTER_FAST for why velocity is read from the gap between them rather than from a
  // frame-to-frame difference.
  let fast = null;
  let slow = null;
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
  let lastClapTime = null;

  function clearGrab() {
    lastWrist = null;
    lastTwist = null;
    lastPitchWrist = null;
    lastPalm = null;
    twistAccum = 0;
    fast = null;
    slow = null;
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
  function checkClap(hands, aspect, timestampMs) {
    if (hands.some((h) => h.pinch?.pinching)) {
      lastClapSpan = null;
      lastClapTime = null;
      return false;
    }
    const span = handSpan(hands[0], hands[1], aspect);
    if (span > CLAP_ARM_SPAN) clapArmed = true;

    // Velocity (span per real second), not a per-call delta — see the constant's comment
    // for why a per-frame delta is the wrong thing to measure here.
    let closingSpeed = 0;
    if (lastClapSpan !== null && lastClapTime !== null) {
      const dtSeconds = (timestampMs - lastClapTime) / 1000;
      if (dtSeconds > 0) closingSpeed = (lastClapSpan - span) / dtSeconds;
    }

    const clapped = clapArmed && span < CLAP_CLOSE_SPAN && closingSpeed > CLAP_MIN_CLOSING_SPEED;
    if (clapped) clapArmed = false;

    lastClapSpan = span;
    lastClapTime = timestampMs;
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

    // Live tuning surface for the UI. Changing triggerFrames rebuilds the stabilizers,
    // since their frame counts are fixed at construction.
    configure(patch) {
      if (patch.channels) settings.channels = new Set(patch.channels);
      if (patch.sensitivity !== undefined) settings.sensitivity = patch.sensitivity;
      if (patch.momentum !== undefined) settings.momentum = patch.momentum;
      if (patch.triggerFrames !== undefined && patch.triggerFrames !== settings.triggerFrames) {
        settings.triggerFrames = patch.triggerFrames;
        grab = createStabilizer({ enter: settings.triggerFrames, exit: 6 });
        transform = createStabilizer({ enter: settings.triggerFrames, exit: 6 });
        explode = createStabilizer({ enter: settings.triggerFrames, exit: 6 });
      }
    },

    get settings() {
      return { ...settings, channels: [...settings.channels] };
    },

    // timestampMs: defaults to performance.now() so existing callers (and every test in
    // this file's history) that don't pass one keep working — only checkClap's real-time
    // velocity measurement actually needs it.
    update(hands, aspect, timestampMs = performance.now()) {
      if (on('clap') && hands.length === 2 && checkClap(hands, aspect, timestampMs)) {
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
      // Each mode is additionally gated on its channel being armed, so practice mode can
      // silence a gesture completely rather than merely ignoring its effect -- a disarmed
      // gesture must not even claim the mode, or it would still block the one being practised.
      const grabArmed = on('move') || on('spin') || on('tilt') || on('push');
      const transforming = transform.update(twoHanded && on('scale'));
      const exploding = explode.update(openHanded && on('explode') && !transforming);
      const grabbing = grab.update(fisted && grabArmed && !transforming && !exploding);

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
        // Only steer while the fist is ACTUALLY closed, not merely while grab mode is still
        // held open by hysteresis. The exit hysteresis exists so a dropped tracking frame
        // cannot cancel a gesture — but it was also letting an opened hand keep driving the
        // model for its whole exit window: measured, opening the hand and sweeping it away
        // dragged the model a further 28cm, so releasing did not release. Now the velocity
        // simply stops being written and existing momentum coasts out, which is what
        // letting go should feel like. clearGrab() also drops the stale wrist reference, so
        // re-closing the fist measures from where it actually is rather than jumping.
        if (hands.length >= 1 && fisted) setGrabVelocity(hands, aspect);
        else clearGrab();
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
  // Which hand is doing the grabbing has to be decided by CONTINUITY, not by taking the
  // first match in the array. MediaPipe can reorder `hands` between frames, and it can also
  // change its mind about which hands read as fists — so "the grabbing hand" could silently
  // become the other hand, and its position would then be differenced against the previous
  // frame's OTHER hand, producing a jump out of nothing. MAX_MOVE_PER_FRAME hides this while
  // the hands are far apart (the bogus delta is too big and gets rejected) but not when they
  // are close: measured, two fists 0.10 apart in frame jumped the model 5.2cm on a reorder,
  // while the same test at 0.20 apart showed nothing. Nearest-to-last-known wins instead,
  // the same reasoning smoothLandmarks.js uses — a hand cannot teleport between frames.
  function nearestTo(pool, reference) {
    if (!reference || pool.length === 1) return pool[0];
    let best = pool[0];
    let bestDistance = Infinity;
    for (const candidate of pool) {
      const wrist = wristOf(candidate);
      const d = Math.hypot(wrist.x - reference.x, wrist.y - reference.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    return best;
  }

  function setGrabVelocity(hands, aspect) {
    const fists = hands.filter((h) => isFistLike(h.gesture, h.landmarks, aspect));
    const hand = nearestTo(fists.length ? fists : hands, lastWrist);
    const wrist = wristOf(hand);
    const palm = palmLength(hand.landmarks, aspect);
    const others = hands.filter((h) => h !== hand);
    const pitchHand = others.length ? nearestTo(others, lastPitchWrist) : null;

    // Twist has to be unwrapped into a continuous angle before it can be filtered, or the
    // ±180° seam registers as a full-speed spin every time it is crossed.
    const rawTwist = handTwist(hand.landmarks, aspect);
    if (lastTwist !== null) {
      let step = rawTwist - lastTwist;
      if (step > Math.PI) step -= Math.PI * 2;
      if (step < -Math.PI) step += Math.PI * 2;
      twistAccum += step;
    }
    lastTwist = rawTwist;

    const pitchY = pitchHand ? wristOf(pitchHand).y : null;

    const sample = { x: wrist.x, y: wrist.y, twist: twistAccum, palm, pitch: pitchY };

    // First frame of a grab: seed both filters and produce no motion, so taking hold of the
    // object never itself moves it.
    if (!fast) {
      fast = { ...sample };
      slow = { ...sample };
      lastWrist = { x: wrist.x, y: wrist.y };
      if (pitchY !== null) lastPitchWrist = { y: pitchY };
      return;
    }

    for (const key of ['x', 'y', 'twist', 'palm']) {
      fast[key] += (sample[key] - fast[key]) * FILTER_FAST;
      slow[key] += (sample[key] - slow[key]) * FILTER_SLOW;
    }
    if (pitchY !== null) {
      if (fast.pitch === null || slow.pitch === null) {
        fast.pitch = pitchY;
        slow.pitch = pitchY;
      } else {
        fast.pitch += (pitchY - fast.pitch) * FILTER_FAST;
        slow.pitch += (pitchY - slow.pitch) * FILTER_SLOW;
      }
    } else {
      fast.pitch = null;
      slow.pitch = null;
    }

    const perUnit = worldPerScreenUnit(camera, object);

    // Landmark x runs left-to-right in the raw frame while the view is mirrored, so the sign
    // is flipped to make the model follow the hand the user actually sees.
    const vx = deadzone(-(fast.x - slow.x) * FILTER_GAIN, MOVE_DEADZONE);
    const vy = deadzone((fast.y - slow.y) * FILTER_GAIN, MOVE_DEADZONE);
    if (on('move') && Math.abs(vx) < MAX_MOVE_PER_FRAME && Math.abs(vy) < MAX_MOVE_PER_FRAME) {
      linearVelocityX = vx * perUnit.x * settings.sensitivity;
      linearVelocityY = -vy * perUnit.y * settings.sensitivity;
    }

    // Twisting your wrist is really a roll around the camera-viewing axis, but mapping that
    // to spin the object around ITS vertical axis instead — like a lazy Susan — is what is
    // actually useful for looking at the sides of something like a chair. Deliberate
    // stylization, not a literal transfer of the physical motion.
    const vTwist = deadzone((fast.twist - slow.twist) * FILTER_GAIN, TWIST_DEADZONE);
    if (on('spin') && Math.abs(vTwist) < MAX_TWIST_PER_FRAME) {
      angularVelocity = vTwist * settings.sensitivity;
    }

    if (fast.pitch !== null) {
      const vPitch = deadzone((fast.pitch - slow.pitch) * FILTER_GAIN, PITCH_DEADZONE);
      if (on('tilt') && Math.abs(vPitch) * PITCH_SENSITIVITY < MAX_PITCH_PER_FRAME) {
        pitchVelocity = -vPitch * PITCH_SENSITIVITY * settings.sensitivity;
      }
      lastPitchWrist = { y: pitchY };
    } else {
      lastPitchWrist = null;
    }

    // Hand got bigger (closer to camera) -> pull the object closer; smaller -> push it away.
    // Kept as a ratio, the same shape scale uses, rather than a screen-space delta.
    if (slow.palm > 0) {
      const ratio = fast.palm / slow.palm;
      const change = deadzone((ratio - 1) * FILTER_GAIN, DEPTH_DEADZONE);
      if (on('push') && ratio > 1 / MAX_DEPTH_RATIO_PER_FRAME && ratio < MAX_DEPTH_RATIO_PER_FRAME) {
        depthVelocity = change * settings.sensitivity;
      }
    }

    lastWrist = { x: wrist.x, y: wrist.y };
    lastPalm = palm;
  }

  // Applies whatever velocity currently exists and decays it — runs every update() call
  // regardless of mode, which is what lets a released grab keep coasting briefly instead
  // of stopping dead the instant the gesture ends.
  // Momentum off means damping 0: whatever velocity exists is applied for this frame and
  // then dies, so the object stops the instant the gesture does. Reported live that things
  // 'keep accidentally moving around' -- coasting is a prime suspect, since a single jittery
  // frame sets a velocity that then keeps being applied after the hand has already stopped.
  // Must be a function declaration, not a const arrow: everything below here sits after
  // createManipulator's `return`, so a const would never initialize and every call would
  // throw "Cannot access 'damping' before initialization". The other helpers down here are
  // function declarations for the same reason — they get hoisted, a const does not.
  function damping() {
    return settings.momentum ? VELOCITY_DAMPING : 0;
  }

  function applyMomentum() {
    if (Math.abs(angularVelocity) > MIN_ANGULAR_VELOCITY) {
      object.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), angularVelocity);
    }
    angularVelocity *= damping();

    if (Math.abs(pitchVelocity) > MIN_ANGULAR_VELOCITY) {
      // World X, not the object's own local X: yaw already changes what the object's
      // local axes point in, and pitch should still mean "tip toward/away from the
      // camera" regardless of however much it's currently spun — same reasoning as yaw
      // using world Y rather than local Y.
      object.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), pitchVelocity);
    }
    pitchVelocity *= damping();

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
    depthVelocity *= damping();

    if (linearVelocityX * linearVelocityX + linearVelocityY * linearVelocityY > MIN_LINEAR_VELOCITY * MIN_LINEAR_VELOCITY) {
      object.position.x += linearVelocityX;
      object.position.y += linearVelocityY;
      clampToView(object, camera);
    }
    linearVelocityX *= damping();
    linearVelocityY *= damping();
  }

  function applyTransform(hands, aspect) {
    const span = handSpan(hands[0], hands[1], aspect);

    if (lastSpan && span > 0) {
      const ratio = span / lastSpan;
      if (ratio > 1 / MAX_SPAN_RATIO_PER_FRAME && ratio < MAX_SPAN_RATIO_PER_FRAME) {
        // Multiplies each axis independently rather than setScalar-ing all three to one
        // value. Found by testing: stretching the object with explode first, then
        // scaling, silently flattened the stretch back to a uniform shape — setScalar
        // discarded whatever proportions already existed. Multiplying preserves them,
        // the same way scaling an already-non-uniform object works in any 3D tool.
        object.scale.x = THREE.MathUtils.clamp(object.scale.x * ratio, MIN_SCALE, MAX_SCALE);
        object.scale.y = THREE.MathUtils.clamp(object.scale.y * ratio, MIN_SCALE, MAX_SCALE);
        object.scale.z = THREE.MathUtils.clamp(object.scale.z * ratio, MIN_SCALE, MAX_SCALE);
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
          object.scale.y = THREE.MathUtils.clamp(object.scale.y * stretchRatio, home.scale.y, MAX_SCALE);
        }
      }
    }

    lastExplodeSpan = span;
  }
}

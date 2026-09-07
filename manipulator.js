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

// Real-hands testing (first live webcam session) found move/spin/tilt/explode all described
// as "finicky", "janky", or "gets stuck" -- different symptoms with one shared cause: nearly
// every rate limit in this file was expressed as a PER-CALL bound (e.g. "no more than X per
// frame"), which only means something fixed if update() fires at a constant rate. It does
// not: MediaPipe drops frames under load, a documented risk since Phase 1. A per-call cap
// evaluated against a call that happened to span more real time than usual will reject
// motion that was, in real terms, perfectly normal speed -- reads as the gesture "sticking".
// Everything below is now a genuine per-SECOND rate, checked against real elapsed time
// (already threaded through every update() call as a timestamp). This is the same fix
// already applied once, narrowly, to clap's closing-speed check; this generalizes it to
// spin, pitch, roll, push, and explode.
const MAX_MOVE_PER_SECOND = 9.0;
const MAX_SPAN_RATIO_PER_FRAME = 1.5; // see applyTransform -- left as a per-call sanity bound
                                       // on purpose; scale was reported working, and a huge
                                       // ratio in any single call is a tracking glitch
                                       // regardless of how much real time that call spanned.
const MAX_TWIST_PER_SECOND = (Math.PI / 3) * 60; // old per-call cap x 60 (nominal 60fps)
const MAX_PITCH_PER_SECOND = (Math.PI / 3) * 60;
const MAX_ROLL_PER_SECOND = (Math.PI / 3) * 60;
const MAX_DEPTH_RATIO_PER_SECOND = 6.0; // ratio-change per second, same reasoning as move/spin

// Radians of pitch/roll per normalized frame-unit the second hand moves per second — an
// untuned guess, same as every other sensitivity constant here started out; needs a real
// hand to tune further after this first live pass.
const PITCH_SENSITIVITY = Math.PI;
const ROLL_SENSITIVITY = Math.PI;

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
// target velocity (units/second, see above). Every update() call decays and applies
// whatever velocity currently exists, scaled by real elapsed time, whether or not a hand is
// still gripping. Reported live: releasing a twist felt like "a direct pause" — the
// rotation stopped dead the instant tracking stopped feeding a delta. This lets it coast
// for a moment instead, closer to how spinning something with real momentum behaves.
//
// DAMPING_HALFLIFE: real seconds for coasting velocity to drop to half. Converted to a
// per-call decay factor from real dt each frame (see damping()), rather than a fixed 0.85
// per call — the fixed version decayed slower in real time whenever frames were dropped,
// since fewer, bigger per-call multiplications by 0.85 covered more wall-clock time than
// intended.
const DAMPING_HALFLIFE = 0.42; // seconds; ~0.85 per call at a nominal 60fps
const MIN_ANGULAR_VELOCITY = 0.03;  // rad/s
const MIN_LINEAR_VELOCITY = 0.003;  // world units/s

// A clap — hands rapidly closing together — resets the hologram. Re-arms only once the
// hands separate again, so holding them together doesn't fire it repeatedly.
//
// UNITS: handSpan() returns the distance between the wrists divided by the average PALM
// LENGTH — "how many palms apart are the hands" — not a 0-1 fraction of the frame. Hands
// spread apart read 4-9 palms, hands clapped together read 0.8-1.5 palms (measured earlier
// this session against realistic geometry).
const CLAP_CLOSE_SPAN = 1.5;
// Lowered from 4.0 after live feedback that clap "renders and registers" late, i.e. the
// FIRST clap attempt often did nothing and only a second one fired. Likely cause: normal
// hand movement between other gestures rarely spreads to a full 4.0-palm span, so
// `clapArmed` was often still false (left over from a previous gesture) by the time a real
// clap began — the reset then only fires on whichever clap happens to follow a moment the
// hands were genuinely flung wide. 2.5 is still unambiguously "apart" (well clear of the
// 1.5 close threshold) but reachable from an ordinary ready stance, so arming happens
// during normal use rather than requiring a deliberate extra spread first.
const CLAP_ARM_SPAN = 2.5;
// Palm-lengths per second. A deliberate clap closes roughly 5 palm-lengths in ~200ms
// (~25/s); a slow, ordinary hand relaxation is nearer 2.5/s. 8.0 sits between them —
// unchanged by the per-second rewrite above, since this one was already measuring real
// velocity (span change per real second), not a per-call delta; that fix predates this
// session. Still an untuned guess pending real clap numbers, same as everything else here.
const CLAP_MIN_CLOSING_SPEED = 8.0;

// Explode: two open hands (neither fisted nor pinching, keeping it out of grab/scale's
// hand-shape space) pulling apart drives it, continuously, like scale rather than a
// one-shot trigger like clap. Untuned guess for the span-to-amount conversion, same as
// every other sensitivity constant here.
const EXPLODE_SENSITIVITY = 0.6;
// Palm-lengths of span-change per second — same per-call-to-per-second conversion as the
// rest of this file, and for the same reason: "gets stuck at times" on a gesture guarded by
// a raw per-call delta is the signature of a frame-rate-dependent threshold.
//
// The conversion itself is worth flagging: the old per-call cap (2.0, assumed ~60fps)
// converts to 2.0*60 = 120/s, not a smaller number. An earlier pass here used 12.0 -- ten
// times too strict -- which was caught by the test suite: it rejected EVERY frame of even
// the test's own deliberately fast synthetic gesture (measured ~14/s), so explode never
// grew at all. A guard that strict would have made "gets stuck at times" into "never
// works", the opposite of the point of this whole rewrite.
const MAX_EXPLODE_SPAN_RATE_PER_SECOND = 120.0;
// Single-mesh objects (no separate parts to pull apart) get a non-uniform stretch instead —
// deliberately distinct from pinch-scale's uniform resize, so the two gestures don't
// produce the same-looking result on an object like the chair.
//
// Reported live: it "keeps exploding vertically and not horizontally" — the first version
// always stretched scale.y regardless of which way the hands actually moved apart, because
// it read only the SPAN (a scalar distance) and had no axis to put it on but the one hard-
// coded choice. Fixed by reading the actual separation vector between the two wrists each
// call and stretching whichever local axis that vector is more aligned with: hands apart
// mostly left-right widens the object (scale.x), hands apart mostly up-down heightens it
// (scale.y) — matching how the gesture actually looks rather than a fixed axis.
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
// Velocity is read as the GAP BETWEEN two exponential filters of the same signal — one
// quick, one slow — instead of the difference between consecutive frames. Frame-to-frame
// differencing cannot work here: for a hand held still with realistic landmark jitter, the
// per-frame noise in each signal versus the per-frame signal from deliberately moving that
// hand across the frame in one second:
//
//                        noise (median)    deliberate motion
//   wrist position       0.0012 - 0.0026   0.0083     workable
//   twist angle          0.0141 - 0.0417   ~0.026     marginal
//   palm size ratio      0.0157 - 0.0360   0.0082     HOPELESS -- noise exceeds signal
//
// Two filters fix it because real motion is SUSTAINED and noise is not: the quick filter
// tracks a moving hand closely, the slow one lags behind by an amount proportional to
// speed, and the gap between them is a velocity estimate averaged over many samples.
//
// TAU_FAST / TAU_SLOW are real TIME CONSTANTS (seconds), not per-call blend weights. The
// first version used fixed per-call weights (0.35 / 0.12), which is the same frame-rate
// trap as everything else in this file: a filter that blends by a fixed fraction EVERY
// CALL responds differently in real time depending on how often calls happen. A real time
// constant lets the per-call blend weight be recomputed from actual elapsed time
// (alpha = 1 - exp(-dt/tau), standard exponential-filter time-constant conversion), so the
// filter's responsiveness means the same thing regardless of frame rate. Values below are
// simply the OLD per-call weights converted to the time constant they implied at a nominal
// 60fps, so the filter feels the same as before at a steady frame rate and stays correct
// away from one: tau = -dt / ln(1 - alpha).
const TAU_FAST = 0.0388; // seconds
const TAU_SLOW = 0.1307; // seconds
// For a signal ramping at a steady rate v, each filter lags the true value by v*tau in
// steady state, so the gap between them settles at v * (TAU_SLOW - TAU_FAST) — inverting
// that recovers v directly in real units/second, no per-frame convention involved.
const FILTER_GAIN = 1 / (TAU_SLOW - TAU_FAST);

// Per-second deadzones, since the signals they're applied to are now genuine per-second
// rates (see above) rather than per-call deltas.
const MOVE_DEADZONE = 0.05;   // normalized units/second
const TWIST_DEADZONE = 0.24;  // radians/second
const PITCH_DEADZONE = 0.05;  // normalized units/second
const ROLL_DEADZONE = 0.05;   // normalized units/second
const DEPTH_DEADZONE = 0.3;   // ratio-change/second -- largest of the four on purpose:
                               // apparent hand size is the noisiest signal here, and also
                               // the one with the most headroom, since a real push moves
                               // the model far more than a real sideways sweep

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
    // Milliseconds a gesture must hold before it fires -- see stabilizer.js for why this
    // is time, not a frame count. Kept as "frames" in the public API and converted, since
    // the practice panel's slider already speaks in frames and re-labeling it mid-session
    // would be its own confusion; 3 frames at a nominal 60fps is 50ms.
    triggerFrames: 3
  };
  const framesToMs = (frames) => (frames / 60) * 1000;
  // How long a DIFFERENT gesture must be confirmed before it's allowed to interrupt one
  // that's already active (see update() below). Deliberately several times a normal
  // enterMs: a normal enterMs is tuned to feel instant for a gesture starting fresh, and
  // reusing that same short window for an interrupt is exactly what let a brief
  // misclassification hijack an active grab. Not tied to triggerFrames — the practice
  // panel's trigger-delay slider is about how quickly a gesture starts, not about how hard
  // it is to rip control away from one already running, and conflating the two would make
  // that slider affect something the user didn't ask it to.
  const SWITCH_AWAY_MS = 300;

  let grab = createStabilizer({ enterMs: framesToMs(settings.triggerFrames), exitMs: 220 });
  let transform = createStabilizer({ enterMs: framesToMs(settings.triggerFrames), exitMs: 220 });
  let explode = createStabilizer({ enterMs: framesToMs(settings.triggerFrames), exitMs: 220 });

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
  // TAU_FAST for why velocity is read from the gap between them rather than from a
  // frame-to-frame difference.
  let fast = null;
  let slow = null;
  let lastSpan = null;
  let lastExplodeSpan = null;
  let explodeAmount = 0;
  let mode = MODE.IDLE;
  let lastUpdateTime = null;

  let angularVelocity = 0;
  let pitchVelocity = 0;
  let rollVelocity = 0;
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
    rollVelocity = 0;
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
    // since their durations are fixed at construction.
    configure(patch) {
      if (patch.channels) settings.channels = new Set(patch.channels);
      if (patch.sensitivity !== undefined) settings.sensitivity = patch.sensitivity;
      if (patch.momentum !== undefined) settings.momentum = patch.momentum;
      if (patch.triggerFrames !== undefined && patch.triggerFrames !== settings.triggerFrames) {
        settings.triggerFrames = patch.triggerFrames;
        const enterMs = framesToMs(settings.triggerFrames);
        grab = createStabilizer({ enterMs, exitMs: 220 });
        transform = createStabilizer({ enterMs, exitMs: 220 });
        explode = createStabilizer({ enterMs, exitMs: 220 });
      }
    },

    get settings() {
      return { ...settings, channels: [...settings.channels] };
    },

    // timestampMs: defaults to performance.now() so existing callers (and every test in
    // this file's history) that don't pass one keep working.
    update(hands, aspect, timestampMs = performance.now()) {
      // Real elapsed time since the last call -- the single number everything below is
      // rewritten around. Clamped so a long pause (tab backgrounded, camera hiccup) can't
      // produce a huge dt that reads as a wildly fast gesture the instant tracking resumes;
      // 250ms already covers a very choppy real frame, and a genuine gap should just look
      // like the hand "restarted" rather than lunging.
      let dt = lastUpdateTime !== null ? (timestampMs - lastUpdateTime) / 1000 : 1 / 60;
      if (!(dt > 0)) dt = 1 / 60;
      dt = Math.min(dt, 0.25);
      lastUpdateTime = timestampMs;

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

      // Starting a gesture from IDLE and INTERRUPTING a different, already-active gesture
      // are not the same decision, and treating them the same was a real source of
      // "finicky" — reported as "two hands, it breaks out": mid-tilt, a single misread
      // frame where the open second hand briefly looked like it was pinching was enough to
      // yank control away into transform, using the exact same brief confirmation window a
      // fresh gesture gets from idle. SWITCH_AWAY_MS raises that bar specifically for the
      // interrupt case — a genuine, deliberate gesture change still gets through, just not
      // off a single flicker — while leaving how quickly a gesture starts from idle alone,
      // since that responsiveness was tuned separately and wasn't the complaint.
      const startingFromIdle = mode === MODE.IDLE;
      const enterFor = (targetMode) => (startingFromIdle || mode === targetMode ? undefined : SWITCH_AWAY_MS);

      const transforming = transform.update(twoHanded && on('scale'), timestampMs, enterFor(MODE.TRANSFORM));
      const exploding = explode.update(openHanded && on('explode') && !transforming, timestampMs, enterFor(MODE.EXPLODE));
      const grabbing = grab.update(fisted && grabArmed && !transforming && !exploding, timestampMs, enterFor(MODE.GRAB));

      if (transforming) {
        mode = MODE.TRANSFORM;
        clearGrab();
        clearExplode();
        // Hysteresis can hold this mode true for a while after a hand drops out — that's
        // the point of it, so a momentary tracking dropout doesn't cancel the gesture. But
        // it means `hands` can still have fewer than 2 entries here. Skipping the write
        // just holds the last scale until hysteresis resolves.
        if (hands.length === 2) applyTransform(hands, aspect);
      } else if (exploding) {
        mode = MODE.EXPLODE;
        clearGrab();
        clearTransform();
        if (hands.length === 2) applyExplode(hands, aspect, dt);
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
        if (hands.length >= 1 && fisted) setGrabVelocity(hands, aspect, dt);
        else clearGrab();
      } else {
        mode = MODE.IDLE;
        clearGrab();
        clearTransform();
        clearExplode();
      }

      applyMomentum(dt);
      return mode;
    }
  };

  // A single closed fist both moves the object (from wrist position) and spins it (from
  // twisting the wrist like turning a doorknob) — this replaced a two-hand pinch-and-twist
  // rotate after live testing called it "janky and cluttered." Sets velocity rather than
  // applying position/rotation directly; applyMomentum() below does the actual moving, so
  // motion can keep coasting for a moment after the grab itself ends.
  //
  // If a second hand is also up, its raw position independently drives tilt — requested
  // directly, both the original "rotate it vertically, not horizontally" and, after living
  // with that, "have a move up to go up, down to go down, left and right to move left and
  // right": vertical second-hand motion pitches the object (tip toward/away from camera),
  // horizontal motion rolls it (tip side-to-side), matching how you'd actually steady and
  // tilt a real object held in one hand with the other hand resting against it. The second
  // hand doesn't need any particular shape; it just needs to not be the hand already doing
  // the grabbing.
  //
  // The grabbing hand's own apparent size also drives push/pull: moving your fist closer
  // to the camera makes it read bigger in frame, farther makes it read smaller, and that
  // change is a genuine depth signal — see palmLength() in gestures.js for why it's used
  // over MediaPipe's own (noisier) z-coordinate.
  // Which hand is doing the grabbing has to be decided by CONTINUITY, not by taking the
  // first match in the array. MediaPipe can reorder `hands` between frames, and it can also
  // change its mind about which hands read as fists — so "the grabbing hand" could silently
  // become the other hand, and its position would then be differenced against the previous
  // frame's OTHER hand, producing a jump out of nothing. Nearest-to-last-known wins instead,
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

  function setGrabVelocity(hands, aspect, dt) {
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

    const pitchX = pitchHand ? wristOf(pitchHand).x : null;
    const pitchY = pitchHand ? wristOf(pitchHand).y : null;

    const sample = { x: wrist.x, y: wrist.y, twist: twistAccum, palm, pitchX, pitchY };

    // First frame of a grab: seed both filters and produce no motion, so taking hold of the
    // object never itself moves it.
    if (!fast) {
      fast = { ...sample };
      slow = { ...sample };
      lastWrist = { x: wrist.x, y: wrist.y };
      if (pitchY !== null) lastPitchWrist = { x: pitchX, y: pitchY };
      return;
    }

    // Per-call blend weight recomputed from real elapsed time -- see TAU_FAST for why a
    // fixed weight was frame-rate-dependent.
    const alphaFast = 1 - Math.exp(-dt / TAU_FAST);
    const alphaSlow = 1 - Math.exp(-dt / TAU_SLOW);

    for (const key of ['x', 'y', 'twist', 'palm']) {
      fast[key] += (sample[key] - fast[key]) * alphaFast;
      slow[key] += (sample[key] - slow[key]) * alphaSlow;
    }
    if (pitchY !== null) {
      if (fast.pitchY === null || slow.pitchY === null) {
        fast.pitchX = pitchX; slow.pitchX = pitchX;
        fast.pitchY = pitchY; slow.pitchY = pitchY;
      } else {
        fast.pitchX += (pitchX - fast.pitchX) * alphaFast;
        slow.pitchX += (pitchX - slow.pitchX) * alphaSlow;
        fast.pitchY += (pitchY - fast.pitchY) * alphaFast;
        slow.pitchY += (pitchY - slow.pitchY) * alphaSlow;
      }
    } else {
      fast.pitchX = null; slow.pitchX = null;
      fast.pitchY = null; slow.pitchY = null;
    }

    const perUnit = worldPerScreenUnit(camera, object);

    // Landmark x runs left-to-right in the raw frame while the view is mirrored, so the sign
    // is flipped to make the model follow the hand the user actually sees.
    const vx = deadzone(-(fast.x - slow.x) * FILTER_GAIN, MOVE_DEADZONE);
    const vy = deadzone((fast.y - slow.y) * FILTER_GAIN, MOVE_DEADZONE);
    if (on('move') && Math.abs(vx) < MAX_MOVE_PER_SECOND && Math.abs(vy) < MAX_MOVE_PER_SECOND) {
      linearVelocityX = vx * perUnit.x * settings.sensitivity;
      linearVelocityY = -vy * perUnit.y * settings.sensitivity;
    }

    // Twisting your wrist is really a roll around the camera-viewing axis, but mapping that
    // to spin the object around ITS vertical axis instead — like a lazy Susan — is what is
    // actually useful for looking at the sides of something like a chair. Deliberate
    // stylization, not a literal transfer of the physical motion.
    const vTwist = deadzone((fast.twist - slow.twist) * FILTER_GAIN, TWIST_DEADZONE);
    if (on('spin') && Math.abs(vTwist) < MAX_TWIST_PER_SECOND) {
      angularVelocity = vTwist * settings.sensitivity;
    }

    if (fast.pitchY !== null) {
      const vPitch = deadzone((fast.pitchY - slow.pitchY) * FILTER_GAIN, PITCH_DEADZONE);
      if (on('tilt') && Math.abs(vPitch) * PITCH_SENSITIVITY < MAX_PITCH_PER_SECOND) {
        pitchVelocity = -vPitch * PITCH_SENSITIVITY * settings.sensitivity;
      }
      // Second hand's horizontal position rolls the object left/right -- requested directly
      // after living with pitch-only tilt ("have left and right to move left and right").
      // Rotating about the camera's forward (world Z-ish, via rotateOnWorldAxis with the
      // camera's own view axis would drift as the mouse orbits the scene; using world Z
      // directly keeps "left/right" meaning the same thing regardless of hand height,
      // matching how pitch already uses world X rather than the object's own local axis.
      const vRoll = deadzone((fast.pitchX - slow.pitchX) * FILTER_GAIN, ROLL_DEADZONE);
      if (on('tilt') && Math.abs(vRoll) * ROLL_SENSITIVITY < MAX_ROLL_PER_SECOND) {
        rollVelocity = vRoll * ROLL_SENSITIVITY * settings.sensitivity;
      }
      lastPitchWrist = { x: pitchX, y: pitchY };
    } else {
      lastPitchWrist = null;
    }

    // Hand got bigger (closer to camera) -> pull the object closer; smaller -> push it away.
    // Kept as a ratio, the same shape scale uses, rather than a screen-space delta.
    if (slow.palm > 0) {
      const ratio = fast.palm / slow.palm;
      const change = deadzone((ratio - 1) * FILTER_GAIN, DEPTH_DEADZONE);
      if (on('push') && Math.abs(change) < MAX_DEPTH_RATIO_PER_SECOND) {
        depthVelocity = change * settings.sensitivity;
      }
    }

    lastWrist = { x: wrist.x, y: wrist.y };
    lastPalm = palm;
  }

  // Applies whatever velocity currently exists and decays it — runs every update() call
  // regardless of mode, which is what lets a released grab keep coasting briefly instead
  // of stopping dead the instant the gesture ends. Velocities are real per-second rates now
  // (see the top of this file), so both the application and the decay are scaled by `dt`.
  //
  // Momentum off means no coasting: whatever velocity exists this instant is applied for
  // this frame and then zeroed, so the object stops the moment the gesture does. Reported
  // live that things 'keep accidentally moving around' -- coasting was a prime suspect,
  // since a single jittery frame set a velocity that then kept being applied after the hand
  // had already stopped.
  //
  // Must be a function declaration, not a const arrow: everything below here sits after
  // createManipulator's `return`, so a const would never initialize and every call would
  // throw "Cannot access 'damping' before initialization". The other helpers down here are
  // function declarations for the same reason — they get hoisted, a const does not.
  function damping(dt) {
    if (!settings.momentum) return 0;
    return Math.exp((-dt / DAMPING_HALFLIFE) * Math.LN2);
  }

  function applyMomentum(dt) {
    const decay = damping(dt);

    if (Math.abs(angularVelocity) > MIN_ANGULAR_VELOCITY) {
      object.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), angularVelocity * dt);
    }
    angularVelocity *= decay;

    if (Math.abs(pitchVelocity) > MIN_ANGULAR_VELOCITY) {
      // World X, not the object's own local X: yaw already changes what the object's
      // local axes point in, and pitch should still mean "tip toward/away from the
      // camera" regardless of however much it's currently spun — same reasoning as yaw
      // using world Y rather than local Y.
      object.rotateOnWorldAxis(new THREE.Vector3(1, 0, 0), pitchVelocity * dt);
    }
    pitchVelocity *= decay;

    if (Math.abs(rollVelocity) > MIN_ANGULAR_VELOCITY) {
      object.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), rollVelocity * dt);
    }
    rollVelocity *= decay;

    if (Math.abs(depthVelocity) > MIN_LINEAR_VELOCITY / 10) {
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
        currentDistance / (1 + depthVelocity * dt),
        home.distance * MIN_DEPTH_RATIO,
        home.distance * MAX_DEPTH_RATIO
      );
      object.position.copy(camera.position).addScaledVector(direction, targetDistance);
    }
    depthVelocity *= decay;

    const speedSq = linearVelocityX * linearVelocityX + linearVelocityY * linearVelocityY;
    if (speedSq > MIN_LINEAR_VELOCITY * MIN_LINEAR_VELOCITY) {
      object.position.x += linearVelocityX * dt;
      object.position.y += linearVelocityY * dt;
      clampToView(object, camera);
    }
    linearVelocityX *= decay;
    linearVelocityY *= decay;
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
  // whole hologram instead — deliberately non-uniform, so it doesn't look like the same
  // uniform resize two-hand pinch already does.
  //
  // Both branches update incrementally from the span delta, the same pattern applyTransform
  // uses for scale, rather than computing from a captured baseline — that avoids a
  // real bug class: a baseline captured fresh each time explode mode is re-entered would
  // compound with whatever amount was already applied from a previous session.
  function applyExplode(hands, aspect, dt) {
    const span = handSpan(hands[0], hands[1], aspect);

    if (lastExplodeSpan !== null && dt > 0) {
      const delta = span - lastExplodeSpan;
      const rate = delta / dt; // palm-lengths of span-change per real second
      if (Math.abs(rate) < MAX_EXPLODE_SPAN_RATE_PER_SECOND) {
        if (literalMode) {
          explodeAmount = THREE.MathUtils.clamp(explodeAmount + delta * EXPLODE_SENSITIVITY, 0, 1);
          for (const part of explodeParts) {
            part.position.copy(part.userData.explodeHome).addScaledVector(part.userData.explodeDir, explodeAmount * MAX_EXPLODE_OFFSET);
          }
        } else {
          const stretchRatio = 1 + delta * EXPLODE_SENSITIVITY;
          // Stretch whichever local axis the hands are actually pulling apart along,
          // rather than a fixed vertical -- see MAX_EXPLODE_OFFSET's comment above for why.
          const wristA = wristOf(hands[0]);
          const wristB = wristOf(hands[1]);
          const horizontal = Math.abs(wristA.x - wristB.x);
          const vertical = Math.abs(wristA.y - wristB.y);
          const axis = vertical > horizontal ? 'y' : 'x';
          object.scale[axis] = THREE.MathUtils.clamp(
            object.scale[axis] * stretchRatio,
            home.scale[axis],
            MAX_SCALE
          );
        }
      }
    }

    lastExplodeSpan = span;
  }
}

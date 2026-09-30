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

// ---- How hand motion becomes model motion (rewritten 2026-09-29) --------------------------
//
// Every continuous channel (move x/y, spin, pitch, roll, push, scale, explode) now runs the
// same three stages, all timed by REAL elapsed time so they mean the same thing at 8 fps and
// 60 fps (the project rule since the first live session; see stabilizer.js):
//
//   1. COMMAND: the hand's displacement since it took hold, mapped straight onto the model
//      (move is 1:1 with the hand on screen, spin is 1:1 with the wrist twist). The previous
//      version estimated hand VELOCITY from the gap between two exponential filters and
//      integrated it. That lost 18% of a quick move and 58% of a quick twist (the estimate
//      never caught up before the hand stopped), lost more at low frame rates (BUGS #12:
//      60-78% of the 60 fps result at 10 fps), and a per-second velocity deadzone ignored slow
//      deliberate motion entirely (BUGS #5: a 40° twist over 2 s did nothing).
//   2. DEADZONE: a backlash ("slack") deadzone on each raw signal. The command only moves once
//      the hand has moved further than the deadzone from where the slack was last taken up,
//      so tracking jitter smaller than the deadzone produces EXACTLY zero motion (a steady
//      hand holds the model still; BUGS #11's explode ratchet cannot happen), while a real
//      move of any speed is followed exactly, minus the slack.
//   3. FOLLOW: the model follows the command through a critically damped spring (the fastest
//      response with no overshoot), integrated in closed form so a step settles in the same
//      real time at any frame rate, with a per-channel top speed so a flick can't whip it
//      across the screen. manipulator.tick(now), called every display frame by hologram.js,
//      advances the spring between camera frames, so the model glides at display rate
//      instead of stepping at camera rate.
//
// Momentum is kept (the owner asked for a release to coast rather than "a direct pause"): on
// release the spring's current speed keeps pushing the command, decaying with
// DAMPING_HALFLIFE. With momentum off, the model settles where the hand left it.

// Deadzones, per raw signal, sized so the synthetic 0.002 per-landmark jitter (the figure
// measured against real MediaPipe) can never reach them even WITHOUT landmark smoothing:
// raw wrist noise peaks at ±0.002 per axis, raw palm size at ±3.3%, raw twist at ±1.3°.
const MOVE_DEADZONE = 0.005;   // normalized frame units (≈1.6 cm of model at the default framing)
const TWIST_DEADZONE = 0.05;   // radians of wrist twist (2.9°)
const TILT_DEADZONE = 0.005;   // normalized frame units of second-hand motion
const DEPTH_DEADZONE = 0.07;   // ln(palm size): apparent hand size is the noisiest signal
const SCALE_DEADZONE = 0.05;   // ln(hand span)
const EXPLODE_DEADZONE = 0.3;  // palm lengths of hand span (≈5% of a canonical pull-apart)

// Spring stiffness (rad/s). Critically damped: a step settles to 2% in ~5.8/OMEGA seconds
// (~180 ms) with no overshoot, and a steady motion trails by 2/OMEGA (~63 ms).
const FOLLOW_OMEGA = 32;

// Top speeds of the model itself, whatever the hand does.
const MAX_SPEED = {
  x: 4.0, y: 4.0,          // world units / s (the default framing is ~3.2 units wide)
  spin: 6.0,               // rad / s
  pitch: 4.0, roll: 4.0,   // rad / s
  depth: 3.0,              // ln(distance) / s
  scale: 3.0,              // ln(scale) / s
  explode: 3.0             // ln(stretch) / s, or explode amount / s for literal explode
};

// Tracking-glitch guards: a raw signal changing faster than this between two camera frames
// is a tracking jump (hand swap, mis-detection), not a motion; it is absorbed into the
// deadzone reference instead of being followed.
const MAX_MOVE_PER_SECOND = 9.0;                   // normalized frame widths / s
const MAX_TWIST_PER_SECOND = 40;                   // rad / s
const MAX_TILT_PER_SECOND = 9.0;                   // normalized frame units / s
const MAX_DEPTH_RATIO_PER_SECOND = 6.0;            // ln(palm size) / s
const MAX_SPAN_RATIO_PER_SECOND = 20.0;            // ln(span) / s

// Push/pull gain: distance ∝ (palm size)^-PUSH_GAIN. 1.0 would be "hand twice as close, model
// twice as close", which measured 2.7x the old push for the same motion (the old velocity
// estimate only ever delivered part of it, and less at low frame rates); 0.5 keeps the
// canonical push (palm 0.08 -> 0.13) near its old 60 fps size, now at every frame rate.
const PUSH_GAIN = 0.5;

// Radians of pitch/roll per normalized frame-unit the second hand moves (unchanged gain).
const PITCH_SENSITIVITY = Math.PI;
const ROLL_SENSITIVITY = Math.PI;

// Coasting after release: real seconds for the release speed to halve.
const DAMPING_HALFLIFE = 0.42;
const MIN_COAST_FRACTION = 0.02; // stop coasting below 2% of the channel's top speed

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
// How long a pinch reading must hold, uninterrupted, before it's trusted enough to discard
// an in-progress clap measurement -- see checkClap. Matches the same "brief flicker vs
// genuine, sustained gesture" reasoning as SWITCH_AWAY_MS elsewhere in this file, just
// smaller: a real pinch-to-scale is held far longer than this, but a single glitched frame
// during a fast clap is not.
const PINCH_GLITCH_MS = 100;

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

// Once explode has separated the parts past this point, grab/spin/tilt/scale retarget from
// the whole assembly to whichever single part is currently selected (see
// selectPartAtScreenPoint) -- pieces read as "genuinely separate" past half-exploded, not
// while they're still mostly overlapping the group. Below this, everything behaves exactly
// as it always has (whole-object mode) -- literalMode objects with nothing ever selected are
// completely unaffected by any of this.
const EXPLODE_PART_SELECT_THRESHOLD = 0.5;
// How far a grabbed part can be carried from its own exploded position, as a multiple of
// MAX_EXPLODE_OFFSET -- generous room to actually reposition a piece, but still bounded so a
// stray gesture can't fling it arbitrarily far off into space with no way back short of
// Reset.
const PART_GRAB_RANGE = 3;

function wristOf(hand) {
  return hand.landmarks[0];
}

// Converts a normalized screen delta into world units at the given world-space point, so
// dragging tracks the hand roughly 1:1 rather than at some arbitrary tuned speed. Takes a
// world position rather than an object, since a part's own `.position` is LOCAL (relative to
// its parent `object`), not the world-space point a camera distance needs.
function worldPerScreenUnit(camera, worldPos) {
  const distance = camera.position.distanceTo(worldPos);
  const height = 2 * distance * Math.tan((camera.fov * Math.PI) / 360);
  return { x: height * camera.aspect, y: height };
}

function clampToView(object, camera) {
  const perUnit = worldPerScreenUnit(camera, object.position);
  const maxX = (perUnit.x / 2) * VIEW_MARGIN;
  const maxY = (perUnit.y / 2) * VIEW_MARGIN;
  object.position.x = THREE.MathUtils.clamp(object.position.x, -maxX, maxX);
  object.position.y = THREE.MathUtils.clamp(object.position.y, -maxY, maxY);
}

// Finds every mesh under `object` and records where each sits relative to the group's own
// centroid, so literal explode has a "this part's outward direction" for each one to push
// along.
//
// Every part is first RE-CENTERED: geometry is shifted so its own local bounding-box center
// lands at the origin, and that center is folded into `part.position`. This has to happen
// before anything below reads `part.position`, because a real OBJ file with several
// `o`-named groups has no per-object transform at all -- every part's `.position` comes out
// of the loader at the default (0,0,0), with its real location baked directly into the
// geometry's own vertex coordinates. Reading `.position` for the centroid/direction math
// without this step would put every part's centroid at (0,0,0) and every explodeDir at the
// same degenerate fallback -- every piece would try to explode straight up from the origin
// instead of outward from its real spot, and Reset would snap every piece toward world
// origin instead of its actual home.
//
// The geometry's LOCAL bounding box is used deliberately, not a world-space one -- a
// world-space box would depend on every ancestor's current matrixWorld, which can be stale
// at this point (findExplodeParts runs at construction time, before this object has ever
// been through a render pass). Reading `part.geometry.boundingBox` sidesteps that: it's pure
// vertex data, unaffected by any transform.
//
// The new center is ADDED to whatever `part.position` already held, not blindly overwritten
// -- an already-correctly-positioned part (the synthetic test's THREE.Group children, whose
// geometry is already centered on its own local origin) must keep its position, not have it
// zeroed out by a geometry center of (0,0,0). Composing the two this way is exactly correct
// as long as the part has no rotation/scale already applied before this runs, which holds for
// every case this project actually produces: OBJLoader never sets a non-identity
// quaternion/scale on a parsed mesh (OBJ has no per-object transform concept at all -- every
// part comes out at identity, real placement baked purely into vertex data), and the
// synthetic test fixture is built the same way. A hypothetical future GLTF-based multi-part
// export with real per-node rotation would need the offset rotated into geometry space
// first; not needed for the OBJ-only pipeline this project actually has.
function findExplodeParts(object) {
  const parts = [];
  object.traverse((child) => {
    if (child.isMesh) parts.push(child);
  });

  if (parts.length < 2) return { literal: false, parts: [] };

  for (const part of parts) {
    part.geometry.computeBoundingBox();
    const geomCenter = part.geometry.boundingBox.getCenter(new THREE.Vector3());
    const truePosition = geomCenter.clone().add(part.position);
    part.geometry.translate(-geomCenter.x, -geomCenter.y, -geomCenter.z);
    part.position.copy(truePosition);
  }

  const centroid = new THREE.Vector3();
  for (const part of parts) centroid.add(part.position);
  centroid.divideScalar(parts.length);

  for (const part of parts) {
    const offset = part.position.clone().sub(centroid);
    part.userData.explodeHome = part.position.clone();
    // Rotation/scale snapshots too, not just position -- needed so Reset can put a part that
    // was individually grabbed/spun/scaled back EXACTLY as it started, not just back at the
    // right spot but still rotated or resized from being handled.
    part.userData.explodeHomeQuaternion = part.quaternion.clone();
    part.userData.explodeHomeScale = part.scale.clone();
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

// Backlash deadzone on one raw signal. `sig` holds the slack reference (`anchor`) and the
// previous raw value. Returns how far the anchor moved this call, which is the only motion
// that reaches the command: zero while the signal wanders inside ±width of the anchor.
function takeUpSlack(sig, value, width, maxRate, dt) {
  const jump = value - sig.last;
  sig.last = value;
  // A tracking jump: shift the reference with it so the jump itself is never followed.
  if (Math.abs(jump) > maxRate * dt) {
    sig.anchor += jump;
    return 0;
  }
  const off = value - sig.anchor;
  if (off > width) { sig.anchor = value - width; return off - width; }
  if (off < -width) { sig.anchor = value + width; return off + width; }
  return 0;
}

const newSignal = (value) => ({ anchor: value, last: value });
const newChannel = () => ({ cmd: 0, out: 0, vel: 0, coast: 0 });

// One closed-form step of a critically damped spring pulling `c.out` toward `c.cmd`, exact
// for any dt (so settle time is frame-rate independent), then the channel's top speed.
// Returns the change in output this step.
function follow(c, dt, maxSpeed) {
  const e = c.out - c.cmd;
  const j = c.vel + FOLLOW_OMEGA * e;
  const ex = Math.exp(-FOLLOW_OMEGA * dt);
  let next = c.cmd + (e + j * dt) * ex;
  let vel = (c.vel - FOLLOW_OMEGA * j * dt) * ex;
  let delta = next - c.out;
  const cap = maxSpeed * dt;
  if (Math.abs(delta) > cap) {
    delta = Math.sign(delta) * cap;
    vel = Math.sign(delta) * maxSpeed;
  }
  // Snap once the remaining error is below float noise, so a settled model is bit-still.
  if (Math.abs(c.out + delta - c.cmd) < 1e-12 && Math.abs(vel) < 1e-9) {
    delta = c.cmd - c.out;
    vel = 0;
  }
  c.out += delta;
  c.vel = vel;
  return delta;
}

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
  // it is to rip control away from one already running.
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

  // Every gesture's tracking and follow state, keyed by WHICHEVER thing it's currently being
  // applied to -- `object` itself (every single-mesh model, and a literalMode object
  // before/below the part-select threshold), or one specific part once the user has
  // exploded past EXPLODE_PART_SELECT_THRESHOLD and selected it.
  const targetStates = new Map();
  function stateFor(target) {
    let s = targetStates.get(target);
    if (!s) {
      s = {
        holding: false,       // a fist is currently steering this target
        lastWrist: null, lastPitchWrist: null,
        lastTwist: null, twistAccum: 0,
        sig: {},              // raw-signal deadzone state, rebuilt at every new grab
        spanSig: null,        // two-hand scale deadzone state
        ch: { x: newChannel(), y: newChannel(), spin: newChannel(), pitch: newChannel(), roll: newChannel(), depth: newChannel(), scale: newChannel() }
      };
      targetStates.set(target, s);
    }
    return s;
  }

  // Which single part (if any) grab/spin/tilt/scale currently act on instead of the whole
  // object -- see selectPartAtScreenPoint. Push/pull deliberately never retargets: it always
  // moves the whole assembly along the camera ray, since that ray is only meaningful in world
  // space and a part's transform is local to `object`.
  let activePart = null;
  const raycaster = new THREE.Raycaster();

  function currentTarget() {
    return literalMode && explodeAmount > EXPLODE_PART_SELECT_THRESHOLD && activePart ? activePart : object;
  }

  // object's own parent (the scene) never rotates, so rotateOnWorldAxis is exactly right for
  // it. A part's parent IS `object`, which may itself be rotated; rotateOnWorldAxis does not
  // correct for a rotated parent, so parts rotate about their own LOCAL axes instead (a
  // deliberate, documented v1 simplification).
  function rotateTarget(target, axis, angle) {
    if (target === object) target.rotateOnWorldAxis(axis, angle);
    else target.rotateOnAxis(axis, angle);
  }

  const _worldPos = new THREE.Vector3();
  function targetWorldPosition(target) {
    return target === object ? object.position : target.getWorldPosition(_worldPos);
  }

  const _partOffset = new THREE.Vector3();
  function clampPartOffset(part) {
    const maxDist = MAX_EXPLODE_OFFSET * PART_GRAB_RANGE;
    _partOffset.copy(part.position).sub(part.userData.explodeHome);
    if (_partOffset.lengthSq() > maxDist * maxDist) {
      _partOffset.setLength(maxDist);
      part.position.copy(part.userData.explodeHome).add(_partOffset);
    }
  }

  // Explode is global (not per target): one command/follow channel, its deadzone state, and
  // which axis the hands last pulled along (stretch mode).
  let explodeCh = newChannel();
  let explodeSig = null;
  let explodeAxis = 'x';
  // Explode's limits (stretch floor = home scale, literal amount 0..1) are applied to an
  // UNCLAMPED per-session value rather than by clamping each increment. Clamping increments
  // is a ratchet: noise pressing down against the floor is thrown away while noise going up
  // is kept, which is exactly how two still hands used to creep the stretch upward (BUGS
  // #11). Re-synced to the real state at the start of every explode session.
  let explodeV = { x: 0, y: 0 };
  let explodeScale0 = { x: object.scale.x, y: object.scale.y };
  let explodeLiteralV = 0;
  let explodeAmount = 0;
  let mode = MODE.IDLE;
  let lastUpdateTime = null;
  let lastAdvanceTime = null;

  let clapArmed = true;
  let lastClapSpan = null;
  let lastClapTime = null;
  let pinchSince = null; // see checkClap -- how long pinching has read true, uninterrupted

  const GRAB_CHANNELS = ['x', 'y', 'spin', 'pitch', 'roll', 'depth'];

  // Letting go. The deadzone references are dropped (re-closing the fist measures from where
  // the hand actually is, so it never jumps), and with momentum on each channel keeps its
  // release speed as a coast.
  function release(s) {
    if (!s.holding) return;
    s.holding = false;
    s.lastWrist = null;
    s.lastPitchWrist = null;
    s.lastTwist = null;
    s.twistAccum = 0;
    s.sig = {};
    for (const k of GRAB_CHANNELS) {
      const c = s.ch[k];
      c.coast = settings.momentum ? c.vel : 0;
    }
  }

  function clearGrab() {
    release(stateFor(currentTarget()));
    // Depth lives on the object's own state even while a part is the target.
    const os = stateFor(object);
    if (os.holding) release(os);
  }

  function clearTransform() {
    stateFor(currentTarget()).spanSig = null;
  }

  // Only clears the tracking reference, not explodeAmount or the applied transform itself
  // — releasing the gesture holds whatever shape it left, the same as letting go of grab
  // leaves the object wherever it was moved to, rather than snapping back.
  function clearExplode() {
    explodeSig = null;
  }

  function performReset() {
    object.position.copy(home.position);
    object.quaternion.copy(home.quaternion);
    object.scale.copy(home.scale);
    grab.reset();
    transform.reset();
    explode.reset();
    // Wipes tracking and follow state for every target at once -- object AND every part --
    // so nothing keeps coasting or resumes mid-gesture after a reset.
    targetStates.clear();
    clearExplode();
    explodeCh = newChannel();
    explodeAmount = 0;
    explodeV = { x: 0, y: 0 };
    explodeScale0 = { x: home.scale.x, y: home.scale.y };
    explodeLiteralV = 0;
    activePart = null;
    lastAdvanceTime = null;
    if (literalMode) {
      for (const part of explodeParts) {
        part.position.copy(part.userData.explodeHome);
        part.quaternion.copy(part.userData.explodeHomeQuaternion);
        part.scale.copy(part.userData.explodeHomeScale);
      }
    }
    mode = MODE.IDLE;
  }

  // A clap requires open hands, not pinching ones — both because that's what a real clap
  // physically is, and because scaling down aggressively (pinching hands closing fast) is
  // otherwise indistinguishable from a clap by span alone.
  function checkClap(hands, aspect, timestampMs) {
    // A genuine, sustained pinch (actually doing the scale gesture) disqualifies a clap, but
    // a single glitched frame does not: pinching must hold for PINCH_GLITCH_MS before it's
    // trusted enough to discard the in-progress measurement (a fast clapping hand can
    // transiently misread as a pinch, and at a low frame rate there are only 3-4 samples).
    const anyPinching = hands.some((h) => h.pinch?.pinching);
    if (anyPinching) {
      if (pinchSince === null) pinchSince = timestampMs;
      if (timestampMs - pinchSince >= PINCH_GLITCH_MS) {
        lastClapSpan = null;
        lastClapTime = null;
      }
      return false;
    }
    pinchSince = null;

    const span = handSpan(hands[0], hands[1], aspect);
    // A degenerate hand (zero palm length) makes handSpan return 0, which would otherwise
    // read as "hands together, closing infinitely fast" and fire a reset out of nothing.
    if (!(span > 0)) return false;
    if (span > CLAP_ARM_SPAN) clapArmed = true;

    // Velocity (span per real second), not a per-call delta.
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

  // Advances every follow spring to `timestampMs` and applies the change to the scene. Runs
  // from update() (camera rate) and from tick() (display rate); a timestamp at or before the
  // last one is ignored, so mixing the two clocks can never run time backwards.
  function advance(timestampMs) {
    if (lastAdvanceTime === null) { lastAdvanceTime = timestampMs; return; }
    let dt = (timestampMs - lastAdvanceTime) / 1000;
    // A clock that jumped far backwards was restarted (a caller reusing timestamps, a new
    // session): resynchronise instead of freezing until it catches up.
    if (dt < -1) { lastAdvanceTime = timestampMs; return; }
    if (!(dt > 0)) return;
    lastAdvanceTime = timestampMs;
    dt = Math.min(dt, 0.25);
    const decay = Math.exp((-dt / DAMPING_HALFLIFE) * Math.LN2);

    const target = currentTarget();
    const s = stateFor(target);
    const os = stateFor(object);
    const step = (c, key) => {
      if (c.coast) {
        c.cmd += c.coast * dt;
        c.coast *= decay;
        if (Math.abs(c.coast) < MIN_COAST_FRACTION * MAX_SPEED[key]) c.coast = 0;
      }
      if (c.out === c.cmd && c.vel === 0) return 0;
      return follow(c, dt, MAX_SPEED[key]);
    };

    // Move. Clamped afterwards (frustum for the object, exploded-home range for a part); a
    // clamp pulls the command back to where the model really is, so pushing against the edge
    // never winds up slack that would have to be undone before it comes back.
    const dx = step(s.ch.x, 'x');
    const dy = step(s.ch.y, 'y');
    if (dx || dy) {
      const wantX = target.position.x + dx;
      const wantY = target.position.y + dy;
      target.position.x = wantX;
      target.position.y = wantY;
      if (target === object) clampToView(object, camera);
      else clampPartOffset(target);
      settleClamp(s.ch.x, target.position.x - wantX);
      settleClamp(s.ch.y, target.position.y - wantY);
    }

    // Rotation. World axes for the object (pitch should mean "tip toward/away from the
    // camera" however much it is already spun); local axes for a part (see rotateTarget).
    const dSpin = step(s.ch.spin, 'spin');
    if (dSpin) rotateTarget(target, AXIS_Y, dSpin);
    const dPitch = step(s.ch.pitch, 'pitch');
    if (dPitch) rotateTarget(target, AXIS_X, dPitch);
    const dRoll = step(s.ch.roll, 'roll');
    if (dRoll) rotateTarget(target, AXIS_Z, dRoll);

    // Push/pull: always the whole object, along the real camera-to-object line (so it still
    // behaves after the view has been orbited), in ln(distance) units.
    const dDepth = step(os.ch.depth, 'depth');
    if (dDepth) {
      const current = camera.position.distanceTo(object.position);
      const want = current * Math.exp(dDepth);
      const next = THREE.MathUtils.clamp(want, home.distance * MIN_DEPTH_RATIO, home.distance * MAX_DEPTH_RATIO);
      const direction = object.position.clone().sub(camera.position).normalize();
      object.position.copy(camera.position).addScaledVector(direction, next);
      settleClamp(os.ch.depth, Math.log(next / want));
    }

    // Two-hand scale, in ln(scale). Each axis multiplied independently so an explode stretch
    // keeps its proportions (setScalar would flatten it back to uniform).
    const dScale = step(s.ch.scale, 'scale');
    if (dScale) {
      const f = Math.exp(dScale);
      const before = target.scale.x;
      target.scale.x = THREE.MathUtils.clamp(target.scale.x * f, MIN_SCALE, MAX_SCALE);
      target.scale.y = THREE.MathUtils.clamp(target.scale.y * f, MIN_SCALE, MAX_SCALE);
      target.scale.z = THREE.MathUtils.clamp(target.scale.z * f, MIN_SCALE, MAX_SCALE);
      settleClamp(s.ch.scale, Math.log(target.scale.x / before) - dScale);
    }

    // Explode.
    const dExplode = step(explodeCh, 'explode');
    if (dExplode) {
      if (literalMode) {
        explodeLiteralV += dExplode;
        const next = THREE.MathUtils.clamp(explodeLiteralV, 0, 1);
        if (next !== explodeAmount) {
          explodeAmount = next;
          for (const part of explodeParts) {
            part.position.copy(part.userData.explodeHome).addScaledVector(part.userData.explodeDir, explodeAmount * MAX_EXPLODE_OFFSET);
          }
        }
      } else {
        const axis = explodeAxis;
        const lo = Math.log(home.scale[axis] / explodeScale0[axis]);
        const hi = Math.log(MAX_SCALE / explodeScale0[axis]);
        const prev = THREE.MathUtils.clamp(explodeV[axis], lo, hi);
        explodeV[axis] += dExplode;
        const next = THREE.MathUtils.clamp(explodeV[axis], lo, hi);
        if (next !== prev) object.scale[axis] *= Math.exp(next - prev);
      }
    }
  }

  // A limit was hit: move the command and output to where the model really is and stop,
  // so no slack is stored beyond the limit.
  function settleClamp(c, correction) {
    if (Math.abs(correction) < 1e-12) return;
    c.out += correction;
    c.cmd = c.out;
    c.vel = 0;
    c.coast = 0;
  }

  return {
    get mode() {
      return mode;
    },

    // For a HUD indicator: which explode behavior this object will actually use, decided
    // once from its mesh count at creation.
    get explodeIsLiteral() {
      return literalMode;
    },

    reset: performReset,

    // Which part grab/spin/tilt/scale currently act on, or null when nothing is selected
    // (whole-object mode). Read by the UI to name the active part on the coach HUD.
    get activePart() {
      return activePart;
    },

    // Raycasts against the exploded parts and selects whichever one was hit (or deselects,
    // back to whole-object mode, on a miss). No-ops below EXPLODE_PART_SELECT_THRESHOLD or on
    // a non-literalMode object. ndcX/ndcY are normalized device coordinates in [-1, 1].
    selectPartAtScreenPoint(ndcX, ndcY) {
      if (!literalMode || explodeAmount <= EXPLODE_PART_SELECT_THRESHOLD) return null;
      raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
      const hits = raycaster.intersectObjects(explodeParts, false);
      activePart = hits.length ? hits[0].object : null;
      return activePart;
    },

    // Live tuning surface for the UI. Changing triggerFrames rebuilds the stabilizers,
    // since their durations are fixed at construction.
    configure(patch) {
      if (patch.channels) settings.channels = new Set(patch.channels);
      if (patch.sensitivity !== undefined && Number.isFinite(patch.sensitivity) && patch.sensitivity >= 0) {
        settings.sensitivity = patch.sensitivity;
      }
      if (patch.momentum !== undefined) settings.momentum = !!patch.momentum;
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

    // Display-rate step: advances the follow springs without new hand input. hologram.js
    // calls it every rendered frame so the model glides between camera frames.
    tick(timestampMs = performance.now()) {
      advance(timestampMs);
    },

    // timestampMs: the camera frame's time. Defaults to performance.now() so callers that
    // don't pass one keep working.
    update(hands, aspect, timestampMs = performance.now()) {
      // Real elapsed time since the last call. Clamped so a long pause (tab backgrounded,
      // camera hiccup) can't read as a wildly fast gesture the instant tracking resumes.
      let dt = lastUpdateTime !== null ? (timestampMs - lastUpdateTime) / 1000 : 1 / 60;
      if (!(dt > 0)) dt = 1 / 60;
      dt = Math.min(dt, 0.25);
      lastUpdateTime = timestampMs;

      if (on('clap') && hands.length === 2 && checkClap(hands, aspect, timestampMs)) {
        performReset();
        lastAdvanceTime = timestampMs;
        return mode;
      }

      const twoHanded = hands.length === 2 && hands.every((h) => h.pinch?.pinching);
      // isFistLike trusts MediaPipe's own classifier when it has a confident opinion
      // either way, and only falls back to geometric curl detection when it doesn't.
      const fisted = hands.some((h) => isFistLike(h.gesture, h.landmarks, aspect));
      // Explode's trigger occupies a hand-shape space disjoint from both pinch (transform)
      // and fist (grab) on purpose — two open hands, neither pinching nor fisted.
      const openHanded =
        hands.length === 2 && hands.every((h) => !isFistLike(h.gesture, h.landmarks, aspect) && !h.pinch?.pinching);

      // Each mode is gated on its channel being armed, so practice mode can silence a
      // gesture completely rather than merely ignoring its effect.
      const grabArmed = on('move') || on('spin') || on('tilt') || on('push');

      // Starting a gesture from IDLE and INTERRUPTING a different, already-active gesture
      // are not the same decision: SWITCH_AWAY_MS raises the bar for the interrupt case so a
      // single misread frame can't hijack an active gesture.
      const startingFromIdle = mode === MODE.IDLE;
      const enterFor = (targetMode) => (startingFromIdle || mode === targetMode ? undefined : SWITCH_AWAY_MS);

      const transforming = transform.update(twoHanded && on('scale'), timestampMs, enterFor(MODE.TRANSFORM));
      const exploding = explode.update(openHanded && on('explode') && !transforming, timestampMs, enterFor(MODE.EXPLODE));
      const grabbing = grab.update(fisted && grabArmed && !transforming && !exploding, timestampMs, enterFor(MODE.GRAB));

      if (transforming) {
        mode = MODE.TRANSFORM;
        clearGrab();
        clearExplode();
        // Hysteresis can hold this mode for a while after a hand drops out; skipping the
        // command just holds the last scale until it resolves.
        if (hands.length === 2) commandTransform(currentTarget(), hands, aspect, dt);
      } else if (exploding) {
        mode = MODE.EXPLODE;
        clearGrab();
        clearTransform();
        if (hands.length === 2) commandExplode(hands, aspect, dt);
      } else if (grabbing) {
        mode = MODE.GRAB;
        clearTransform();
        clearExplode();
        // Only steer while the fist is ACTUALLY closed, not merely while grab mode is still
        // held open by exit hysteresis: opening the hand and sweeping it away once dragged
        // the model a further 28cm, so releasing did not release.
        if (hands.length >= 1 && fisted) commandGrab(currentTarget(), hands, aspect, dt);
        else clearGrab();
      } else {
        mode = MODE.IDLE;
        clearGrab();
        clearTransform();
        clearExplode();
      }

      advance(timestampMs);
      return mode;
    }
  };

  // Which hand is doing the grabbing is decided by CONTINUITY, not by taking the first match
  // in the array: MediaPipe can reorder `hands` between frames and change its mind about
  // which hands read as fists. Nearest-to-last-known wins — a hand cannot teleport.
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

  // One closed fist: its wrist moves the model (1:1 with the hand on screen), twisting it
  // like a doorknob spins the model about its vertical axis (a lazy Susan, deliberately not
  // a literal roll), and its apparent size pushes/pulls (bigger = nearer; see palmLength()
  // for why that is used instead of MediaPipe's noisier z). A second hand, any shape, tilts:
  // up/down pitches, left/right rolls.
  function commandGrab(target, hands, aspect, dt) {
    const s = stateFor(target);
    const os = target === object ? s : stateFor(object); // depth always on the object

    const fists = hands.filter((h) => isFistLike(h.gesture, h.landmarks, aspect));
    const hand = nearestTo(fists.length ? fists : hands, s.lastWrist);
    const wrist = wristOf(hand);
    const palm = palmLength(hand.landmarks, aspect);
    const others = hands.filter((h) => h !== hand);
    const pitchHand = others.length ? nearestTo(others, s.lastPitchWrist) : null;

    // Twist unwrapped into a continuous angle, or the ±180° seam would read as a full spin.
    const rawTwist = handTwist(hand.landmarks, aspect);
    if (s.lastTwist !== null) {
      let turn = rawTwist - s.lastTwist;
      if (turn > Math.PI) turn -= Math.PI * 2;
      if (turn < -Math.PI) turn += Math.PI * 2;
      s.twistAccum += turn;
    }
    s.lastTwist = rawTwist;
    const logPalm = palm > 0 ? Math.log(palm) : null;

    // First frame of a hold: take the references and produce no motion, so taking hold of
    // the object never itself moves it. Any coast still running stops: the hand has it now.
    if (!s.holding) {
      s.holding = true;
      os.holding = true;
      s.sig = { x: newSignal(wrist.x), y: newSignal(wrist.y), twist: newSignal(s.twistAccum) };
      if (logPalm !== null) os.sig.palm = newSignal(logPalm);
      for (const k of GRAB_CHANNELS) { s.ch[k].coast = 0; os.ch[k].coast = 0; }
      s.lastWrist = { x: wrist.x, y: wrist.y };
    }

    const sens = settings.sensitivity;
    const perUnit = worldPerScreenUnit(camera, targetWorldPosition(target));

    // Landmark x runs left-to-right in the raw frame while the view is mirrored, so x is
    // flipped to make the model follow the hand the user actually sees; y is flipped because
    // image y grows downward.
    const mx = takeUpSlack(s.sig.x, wrist.x, MOVE_DEADZONE, MAX_MOVE_PER_SECOND, dt);
    const my = takeUpSlack(s.sig.y, wrist.y, MOVE_DEADZONE, MAX_MOVE_PER_SECOND, dt);
    if (on('move')) {
      s.ch.x.cmd += -mx * perUnit.x * sens;
      s.ch.y.cmd += -my * perUnit.y * sens;
    }

    const tw = takeUpSlack(s.sig.twist, s.twistAccum, TWIST_DEADZONE, MAX_TWIST_PER_SECOND, dt);
    if (on('spin')) s.ch.spin.cmd += tw * sens;

    if (pitchHand) {
      const pw = wristOf(pitchHand);
      if (!s.sig.px) {
        // The second hand just appeared: take its reference, no motion.
        s.sig.px = newSignal(pw.x);
        s.sig.py = newSignal(pw.y);
      } else {
        const tx = takeUpSlack(s.sig.px, pw.x, TILT_DEADZONE, MAX_TILT_PER_SECOND, dt);
        const ty = takeUpSlack(s.sig.py, pw.y, TILT_DEADZONE, MAX_TILT_PER_SECOND, dt);
        if (on('tilt')) {
          // Same signs as before the rewrite: raising the hand (image y falling) pitches
          // positive about world X; moving it right in the image rolls positive about Z.
          s.ch.pitch.cmd -= ty * PITCH_SENSITIVITY * sens;
          s.ch.roll.cmd += tx * ROLL_SENSITIVITY * sens;
        }
      }
      s.lastPitchWrist = { x: pw.x, y: pw.y };
    } else {
      delete s.sig.px;
      delete s.sig.py;
      s.lastPitchWrist = null;
    }

    // Hand bigger (closer to the camera) -> pull the object closer: distance falls in
    // proportion, ln(distance) -= ln(palm growth).
    if (logPalm !== null) {
      if (!os.sig.palm) os.sig.palm = newSignal(logPalm);
      const dp = takeUpSlack(os.sig.palm, logPalm, DEPTH_DEADZONE, MAX_DEPTH_RATIO_PER_SECOND, dt);
      if (on('push')) os.ch.depth.cmd += -dp * PUSH_GAIN * sens;
    }

    s.lastWrist = { x: wrist.x, y: wrist.y };
  }

  // Two pinching hands: the change in their span, as a ratio, scales the target by that
  // ratio (hands twice as far apart = twice the size).
  function commandTransform(target, hands, aspect, dt) {
    const s = stateFor(target);
    const span = handSpan(hands[0], hands[1], aspect);
    if (!(span > 0)) return;
    const logSpan = Math.log(span);
    if (!s.spanSig) {
      s.spanSig = newSignal(logSpan);
      s.ch.scale.coast = 0;
      return;
    }
    const d = takeUpSlack(s.spanSig, logSpan, SCALE_DEADZONE, MAX_SPAN_RATIO_PER_SECOND, dt);
    s.ch.scale.cmd += d * settings.sensitivity;
  }

  // Two open hands pulling apart: on a multi-part object, each mesh slides outward from the
  // group's centroid along its own direction (literal explode); on a single-mesh object like
  // the chair it stretches along whichever axis the hands are separating on (hands apart
  // left-right widens it, up-down heightens it), deliberately non-uniform so it doesn't look
  // like pinch-scale. Commanded from the change in span with a deadzone, so a still pair of
  // hands can no longer ratchet the stretch upward against its floor (BUGS #11).
  function commandExplode(hands, aspect, dt) {
    const span = handSpan(hands[0], hands[1], aspect);
    if (!(span > 0)) return;
    const wristA = wristOf(hands[0]);
    const wristB = wristOf(hands[1]);
    explodeAxis = Math.abs(wristA.y - wristB.y) > Math.abs(wristA.x - wristB.x) ? 'y' : 'x';
    if (!explodeSig) {
      explodeSig = newSignal(span);
      explodeCh.coast = 0;
      explodeV = { x: 0, y: 0 };
      explodeScale0 = { x: object.scale.x, y: object.scale.y };
      explodeLiteralV = explodeAmount;
      return;
    }
    const d = takeUpSlack(explodeSig, span, EXPLODE_DEADZONE, MAX_EXPLODE_SPAN_RATE_PER_SECOND, dt);
    explodeCh.cmd += d * EXPLODE_SENSITIVITY * settings.sensitivity;
  }
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

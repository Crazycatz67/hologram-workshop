import * as THREE from 'three';
import { createStabilizer } from './stabilizer.js';
import { handSpan, handTwist, isFistLike, isOpenForExplode, palmLength, handsV2Enabled } from './gestures.js';

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
const SCALE_DEADZONE = 0.12;   // palm lengths of hand span (was 0.05 in ln(span); BUGS #31)
// Two-hand scale weights the vertical span (owner-approved 2026-10-01, Ricky (d)): a 16:9 frame
// has ~1/1.78 the vertical room, so the same zoom range needs ~1.75x the gain when the hands
// are stacked vertically (commandTransform). Still one uniform scale; explode/clap unchanged.
export const SCALE_V_WEIGHT = 1.75;
const PALM_REF_DEADZONE = 0.04; // ln(palm size): when the span's palm-length normaliser updates
const EXPLODE_DEADZONE = 0.3;  // palm lengths of hand span (≈5% of a canonical pull-apart)
// Explode needs a DELIBERATE spread before it moves anything (replay-lab 2026-10-01: a clap's
// closing hands, ✌ + a relaxed hand and "talking hands" all stretched the model 3-8%). Until
// the hands have spread EXPLODE_START_SPREAD palms beyond the narrowest span of the session
// (the stable start) at an average of EXPLODE_MIN_SPREAD_SPEED palms/s or faster, explode is
// armed but commands nothing; closing or holding still never counts. Synthetic + Kaggle-shape
// clips: deliberate spreads 6-6.7 palms at ~14-18/s; clap jitter <=1.1 palms; talking hands
// <=2.2 palms at ~3/s (test.js: ±6%-of-frame wandering at ~1 Hz stays out; ±8% does not).
// PROVISIONAL until the owner's recorded clips confirm them.
const EXPLODE_START_SPREAD = 2.5;     // palm lengths
const EXPLODE_MIN_SPREAD_SPEED = 6.0; // palm lengths per second, averaged from the start
// A slow spread still counts once it is this wide: a deliberate "together -> wide apart" is
// 5-7 palms; talking hands stay under ~2.5 (test.js sweep: 3-4.5 palms in <=0.5-0.6 s fire,
// slower ones only past this distance).
const EXPLODE_FAR_SPREAD = 5.0;       // palm lengths, any speed

// Two-hand scale (BUGS #31). The hand span is wrist distance / average palm length, and the
// live palm length was most of its noise (smoothed peak-to-peak 0.020-0.053 in ln, vs
// 0.005-0.024 for the wrist distance alone). That forced a 0.05 deadzone on ln(span): a start
// cost 5% of span and every reversal 10%, so small slow moves felt stuck. Now:
//   - While a pinch is held, the span is divided by a HELD palm length that only updates
//     once the measured palm has changed by more than PALM_REF_DEADZONE (its own backlash),
//     so palm noise never reaches the span. Not frozen outright: leaning toward or away from
//     the camera grows or shrinks the wrist distance and the palms together, and a frozen
//     normaliser read a 25% lean as a 24% scale. With 0.04 a lean of any size leaks a
//     one-off 3.5-5% (0.8x to 1.25x leans, measured), against 0 for the old live
//     normaliser; 0.03 and below let palm noise back in (still hands drifted again).
//   - The deadzone is in palm lengths of span, not ln(span), because what is left is wrist
//     position noise, which is a fixed size in the image: in ln units it is 2-3x larger with
//     the hands close together than far apart, so one ln width was too wide when they are
//     apart and too narrow when they are close. 0.12 palm lengths holds still hands at
//     exactly zero drift (10 s, jitter 0.002/0.003/0.004, hands 1.5-4.5 palms apart, 120
//     trials per jitter level; 0.1 drifted in 5 of 40 at 0.004), where the old 0.05 ln width
//     drifted up to 2.4% with the hands under 2 palms apart. It costs 3.2% of span with the
//     hands 3.7 palms apart and 2.3% at 5.2 palms (was 5% everywhere), and 5.7% at 2.1 palms.

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
// Hybrid position/rate tilt (owner-approved 2026-10-01, RubberEdge, UIST 2007): within
// TILT_RATE_ZONE (frame units) of where the second hand appeared, tilt follows its position
// as before; beyond it, the overshoot also turns the model continuously at TILT_RATE_GAIN rad/s
// per frame unit, capped at TILT_RATE_MAX, so a hand that runs out of room keeps tilting.
export const TILT_RATE_ZONE = 0.08;
const TILT_RATE_GAIN = 10;
export const TILT_RATE_MAX = 1.5;   // rad/s (~86°/s)
// Pitch/roll limit per grab (Debbie, 2026-10-01): rate control kept tilting while the hand was
// held up, so a long hold tipped the model past 90° (upside down mid-demo). Each axis is held to
// ±TILT_LIMIT from where the grab started; beyond TILT_EASE_START the outward step shrinks
// linearly to 0 at the limit, so it eases in (no hard stop). Moving back is never slowed.
export const TILT_LIMIT = (75 * Math.PI) / 180;
const TILT_EASE_START = (45 * Math.PI) / 180;
function easeTilt(rel, d) {
  // Exact integral of "outward step scaled by remaining room", so one big step (low fps, fast
  // hand) still can't jump the limit: past the knee, rel approaches the limit exponentially.
  if (d === 0 || (rel !== 0 && Math.sign(d) !== Math.sign(rel))) return d;
  const sg = Math.sign(d), w = TILT_LIMIT - TILT_EASE_START;
  const a = Math.abs(rel), want = a + Math.abs(d);
  if (want <= TILT_EASE_START) return d;
  const from = Math.max(a, TILT_EASE_START);
  const excess = want - from + (a > TILT_EASE_START ? -w * Math.log(Math.max(1e-9, (TILT_LIMIT - a) / w)) : 0);
  const end = TILT_LIMIT - w * Math.exp(-excess / w);
  return sg * (Math.max(a, end) - a);
}

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
// Approach-then-merge (owner-approved 2026-10-01, Ricky E1): in a fast clap the tracker often
// loses one hand at contact, so the frame that would read "span < CLAP_CLOSE_SPAN" never
// arrives. A two-hand frame that is armed, closing faster than CLAP_MIN_CLOSING_SPEED and
// already within CLAP_MERGE_SPAN palms, followed within CLAP_MERGE_MS by a frame with one
// open hand, counts as the clap. (A hand leaving the frame moves apart, not closing fast.)
const CLAP_MERGE_SPAN = 2.5;
const CLAP_MERGE_MS = 150;

// Neutral gap ("Engage -> Aim -> Act", owner decision 2026-09-30; BUGS #26/#27). After any
// gesture ends, a DIFFERENT gesture (clap included) can only start once NEUTRAL_GAP_MS has
// passed AND the hands have spent NEUTRAL_HOLD_MS making no gesture's pose. The second half is
// what actually breaks the chain: "two open hands" is exactly the pose a tilt or a two-hand
// pinch leaves behind, so a timer alone would only delay the accidental explode, not stop it.
// Resuming the SAME gesture (re-closing the fist) is never blocked. NEUTRAL_HOLD_MS is long
// enough that a one- or two-frame tracking dropout doesn't count as "neutral".
const NEUTRAL_GAP_MS = 400;
const NEUTRAL_HOLD_MS = 100;
const CLAP = 'clap'; // not a MODE (it is instant), but it ends like one for the neutral gap

// Post-pointer gap (BUGS #32, 2026-10-01). The pointer ("finger gun", gunPose.js) is left by
// curling the index back in, and that IS a fist, so without a pause every exit from the
// pointer would grab the model. For POINTER_GAP_MS after the pointer ends (while nothing else
// is active) no gesture may start. Deliberately NOT the neutral gap above: that one also
// demands 100 ms of relaxed hands, which would make "point, then make a fist and hold it"
// never grab until the hand had opened first. A timer alone is enough here, because the
// unwanted fist is the transition itself and lasts only while the index curls (a fist held
// past the gap is meant). It shares the `allowed` gate in update(). Pointer state comes from
// hand.pointer (gestures.js annotateHand); hands without it never start this gap.
const POINTER_GAP_MS = 300;
const FIST_SURE_SCORE = 0.8;  // Closed_Fist confidence that skips POINTER_GAP_MS (see update)

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

// One-hand selection (owner decision, plans/platform/ROADMAP.md 2026-10-01 (3)): the cursor
// rarely lands exactly on a thin exploded part, so a miss falls back to the nearest part's
// on-screen box. partsNear() ranks the candidates; the hysteresis that stops the target
// flickering between two parts lives in pointer.js createSelector (pure, shared with the
// calibration practice).
export const PARTS_NEAR_PX = 80;
// rankPx = box distance + this x centre distance: two boxes that both contain the cursor
// (distance 0) are told apart by whose centre is nearer, without letting a big box's far
// centre push it out of the 80 px gate (the gate uses the box distance alone).
const CENTRE_WEIGHT = 0.1;
const _corner = new THREE.Vector3();
const _box = new THREE.Box3();

// Screen-space rectangle (CSS px, y down) of a mesh's world bounding box, or null when any
// corner is behind the camera (projection flips there, so the rectangle would be nonsense).
function screenRect(mesh, camera, viewport) {
  const g = mesh.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  _box.copy(g.boundingBox);
  const r = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let i = 0; i < 8; i++) {
    _corner.set(i & 1 ? _box.max.x : _box.min.x, i & 2 ? _box.max.y : _box.min.y, i & 4 ? _box.max.z : _box.min.z);
    _corner.applyMatrix4(mesh.matrixWorld).project(camera);
    if (_corner.z > 1 || _corner.z < -1) return null;
    const x = ((_corner.x + 1) / 2) * viewport.width;
    const y = ((1 - _corner.y) / 2) * viewport.height;
    r.x0 = Math.min(r.x0, x); r.x1 = Math.max(r.x1, x);
    r.y0 = Math.min(r.y0, y); r.y1 = Math.max(r.y1, y);
  }
  return r;
}

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

// The hand's grab reading, honouring its precomputed pointer state: a pointer is never a fist.
// Hands built without `pointer` (tests, labs) get exactly the old isFistLike rule.
function fistOf(h, aspect) {
  return isFistLike(h.gesture, h.landmarks, aspect, { pointer: h.pointer });
}

export function createManipulator(object, camera, { v2 = handsV2Enabled() } = {}) {
  const useV2 = !!v2;
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
        palmSig: null,        // two-hand scale's held palm-length normaliser
        ch: { x: newChannel(), y: newChannel(), spin: newChannel(), pitch: newChannel(), roll: newChannel(), depth: newChannel(), scale: newChannel() }
      };
      // v2: height-only stretch (vertical two-hand spread), the tilt in progress, a flick coasting.
      if (useV2) { s.ch.stretchY = newChannel(); s.tilt = null; s.flick = null; }
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
  let clapApproach = null; // { t } of the last armed, fast-closing, near two-hand frame (E1)

  // The pending neutral gap, or null when any gesture may start (see NEUTRAL_GAP_MS).
  // { endedMode, since, neutralSince, sawNeutral }
  let gap = null;
  // Post-pointer gap (see POINTER_GAP_MS): when it started, or null; and whether any hand was a
  // pointer on the previous camera frame.
  let pointerGapSince = null;
  let wasPointing = false;
  // A same-hand pinch on an aiming hand is a CLICK (pointer.js), never a grab (owner live test
  // 2026-10-01; Cody-I: a held pinch whose hand read as a fist started a grab at 367 ms). Such a
  // hand stays latched until the pinch opens or the hand leaves, and counts as still pointing.
  const pinchLatch = new Set();   // handedness of an aiming hand holding a same-hand pinch
  const wasGunBy = new Map();     // handedness -> was a pointer on its previous frame
  const SAME_PINCH_CLOSE = 0.25;  // keep in step with pointer.js SAME_PINCH_CLOSE
  // Whether the current explode session has made its deliberate spread (EXPLODE_START_SPREAD
  // at EXPLODE_MIN_SPREAD_SPEED). Two open hands are both the explode pose AND the clap's
  // ready stance, so explode engages the moment the hands come up; until they have spread it
  // commands nothing and is still "at rest" for the clap. Once pulled, closing un-explodes.
  let explodePulled = false;
  let explodeStart = null; // { span, age s } narrowest span of this session and time since
  // One-step undo of the last reset (clap, R key or Reset button): the pose from just before.
  let undoSnapshot = null;
  let resetCount = 0;
  let v2Now = 0; // the camera frame's time, for v2 histories

  // v2 state (unused with v2 off). explodeSession: { snapshot, maxAmount } for the explode state
  // in progress (undo entry + "is this a clap during explode"). originalParts: part transforms
  // snapshotted at the first explode since the last reset (clap during explode restores them).
  let explodeSession = null;
  let originalParts = null;
  // snapUpright() ease in progress: { from, to, t0, ms } (stepped in advance(), display rate).
  let upright = null;
  // Clap v2: two-hand span history (arm), dropped-frame count, last facing reading, merge approach.
  let clap2 = null;
  const newClap2 = () => ({ hist: [], dropped: 0, last: null, facingT: null, approachT: null, glitchSince: null, cooldownUntil: -Infinity });
  clap2 = newClap2();
  // Per-person clap thresholds (calibration v2 profile, wired by the host via setThresholds).
  // CLAP_V_MIN = average approach speed floor (palms/s) everywhere. Default V2.CLAP_V_MIN_DEFAULT
  // (no profile); a calibration profile replaces it with the person's slowest clap x 0.6.
  const clapT = { CLAP_ARM_SPAN: V2.CLAP_ARM_SPAN, CLAP_CONTACT_SPAN: V2.CLAP_FIRE_SPAN, CLAP_V_MIN: V2.CLAP_V_MIN_DEFAULT };
  // v2 grab: the voted pose decides (CONTRACT §3.3 "Grab: pose.label === 'fist'"); hands without
  // hand.f (tests, labs) keep the v1 reading.
  const fistOfM = useV2 ? (h, aspect) => (h.f?.pose ? h.f.pose.label === 'fist' : fistOf(h, aspect)) : fistOf;

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
    // v2: letting go of the model mid-tilt. A fast turn keeps spinning (flick), else it settles.
    if (useV2 && s.tilt?.q0) { trimReleaseGlitch(s.tilt); if (!flickFromTilt(s)) pauseTilt(s.tilt); }
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
    if (useV2 && explodeSession) endExplodeSession();
    explodeSig = null;
    explodePulled = false;
    explodeStart = null;
  }

  // Drops every gesture's tracking and follow state -- object AND every part -- so nothing
  // keeps coasting or resumes mid-gesture after a reset or an undo.
  function clearMotionState() {
    upright = null;
    grab.reset();
    transform.reset();
    explode.reset();
    targetStates.clear();
    explodeSession = null;
    clearExplode();
    explodeCh = newChannel();
    explodeV = { x: 0, y: 0 };
    lastAdvanceTime = null;
    gap = null;
    pointerGapSince = null;
    pinchLatch.clear();
    wasGunBy.clear();
    mode = MODE.IDLE;
  }

  // Everything a reset changes, so undo can put it back exactly.
  function takeSnapshot() {
    return {
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
      explodeAmount,
      activePart,
      parts: literalMode ? explodeParts.map((p) => [p.position.clone(), p.quaternion.clone(), p.scale.clone()]) : null
    };
  }

  function performReset() {
    undoSnapshot = takeSnapshot();
    resetCount++;
    clearMotionState();
    object.position.copy(home.position);
    object.quaternion.copy(home.quaternion);
    object.scale.copy(home.scale);
    explodeAmount = 0;
    explodeScale0 = { x: home.scale.x, y: home.scale.y };
    explodeLiteralV = 0;
    activePart = null;
    originalParts = null;
    if (literalMode) {
      for (const part of explodeParts) {
        part.position.copy(part.userData.explodeHome);
        part.quaternion.copy(part.userData.explodeHomeQuaternion);
        part.scale.copy(part.userData.explodeHomeScale);
      }
    }
  }

  // Upright = the home orientation with the user's turn about the world vertical kept (the
  // swing-twist split of the rotation since home: only the twist about +Y survives), so Done
  // stands the model back up without undoing which way it faces. Position and scale untouched.
  const UPRIGHT_MS = 450;
  function uprightTarget() {
    const rel = object.quaternion.clone().multiply(home.quaternion.clone().invert());
    const n = Math.hypot(rel.y, rel.w);
    const twist = n > 1e-9 ? new THREE.Quaternion(0, rel.y / n, 0, rel.w / n) : new THREE.Quaternion();
    return twist.multiply(home.quaternion);
  }
  // Starts an eased (smoothstep, UPRIGHT_MS) turn back to upright; undoable (one step, like a
  // reset). Stops any coast; a new grab / transform / explode cancels the ease where it is.
  // Returns false (and changes nothing) when the model is already upright.
  function snapUpright({ ms = UPRIGHT_MS } = {}) {
    const to = uprightTarget();
    if (2 * Math.acos(Math.min(1, Math.abs(object.quaternion.dot(to)))) < 1e-6) return false;
    undoSnapshot = takeSnapshot();
    clearMotionState();
    upright = { from: object.quaternion.clone(), to, t0: null, ms: Math.max(0, ms) };
    return true;
  }
  function stepUpright(t) {
    if (mode !== MODE.IDLE) { upright = null; return; }
    if (upright.t0 === null) upright.t0 = t;
    const k = upright.ms > 0 ? THREE.MathUtils.clamp((t - upright.t0) / upright.ms, 0, 1) : 1;
    if (k >= 1) { object.quaternion.copy(upright.to); upright = null; return; }
    object.quaternion.slerpQuaternions(upright.from, upright.to, k * k * (3 - 2 * k));
  }

  // Puts back the pose from just before the last reset. One step: a second undo does nothing
  // until another reset happens. Returns whether anything was restored.
  function performUndo() {
    if (!undoSnapshot) return false;
    const s = undoSnapshot;
    undoSnapshot = null;
    clearMotionState();
    object.position.copy(s.position);
    object.quaternion.copy(s.quaternion);
    object.scale.copy(s.scale);
    // Explode's per-session values re-sync from these at the next explode (commandExplode).
    explodeAmount = s.explodeAmount;
    explodeLiteralV = s.explodeAmount;
    explodeScale0 = { x: object.scale.x, y: object.scale.y };
    activePart = s.activePart;
    if (s.parts) {
      explodeParts.forEach((part, i) => {
        part.position.copy(s.parts[i][0]);
        part.quaternion.copy(s.parts[i][1]);
        part.scale.copy(s.parts[i][2]);
      });
    }
    return true;
  }

  function startGap(endedMode, timestampMs) {
    gap = { endedMode, since: timestampMs, neutralSince: null, sawNeutral: false };
  }

  // Advances the pending neutral gap by one camera frame; clears it once satisfied.
  function updateGap(neutral, timestampMs) {
    if (!gap) return;
    if (neutral) {
      if (gap.neutralSince === null) gap.neutralSince = timestampMs;
      if (timestampMs - gap.neutralSince >= NEUTRAL_HOLD_MS) gap.sawNeutral = true;
    } else {
      gap.neutralSince = null;
    }
    if (gap.sawNeutral && timestampMs - gap.since >= NEUTRAL_GAP_MS) gap = null;
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
      clapApproach = null;
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

    // The arm is spent by the caller only when the clap actually fires (E3): a clap that was
    // blocked (neutral gap, pointer) no longer uses it up.
    const clapped = clapArmed && span < CLAP_CLOSE_SPAN && closingSpeed > CLAP_MIN_CLOSING_SPEED;
    clapApproach = clapArmed && span < CLAP_MERGE_SPAN && closingSpeed > CLAP_MIN_CLOSING_SPEED ? { t: timestampMs } : null;

    lastClapSpan = span;
    lastClapTime = timestampMs;
    return clapped;
  }

  // Advances every follow spring to `timestampMs` and applies the change to the scene. Runs
  // from update() (camera rate) and from tick() (display rate); a timestamp at or before the
  // last one is ignored, so mixing the two clocks can never run time backwards.
  function advance(timestampMs) {
    if (upright) stepUpright(timestampMs);
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
    if (dSpin) {
      rotateTarget(target, AXIS_Y, dSpin);
      if (useV2 && s.tilt) spinTiltRefs(target, s.tilt, dSpin);
    }
    const dPitch = step(s.ch.pitch, 'pitch');
    if (dPitch) rotateTarget(target, AXIS_X, dPitch);
    const dRoll = step(s.ch.roll, 'roll');
    if (dRoll) rotateTarget(target, AXIS_Z, dRoll);
    if (useV2) advanceTiltV2(target, s, dt, decay);

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
    // v2 vertical spread: height only.
    if (useV2) {
      const dStretch = step(s.ch.stretchY, 'scale');
      if (dStretch) {
        const before = target.scale.y;
        target.scale.y = THREE.MathUtils.clamp(before * Math.exp(dStretch), MIN_SCALE, MAX_SCALE);
        settleClamp(s.ch.stretchY, Math.log(target.scale.y / before) - dStretch);
      }
    }

    // Explode.
    const dExplode = useV2 && literalMode ? stepExplodeV2(step) : step(explodeCh, 'explode');
    if (dExplode) {
      if (literalMode) {
        explodeLiteralV += dExplode;
        const next = THREE.MathUtils.clamp(explodeLiteralV, 0, 1);
        if (next !== explodeAmount && useV2) {
          // v2: move each part by the CHANGE only, so a part grabbed and moved while exploded keeps
          // its edit through a slow close (owner 2026-10-02: assemble keeps edits).
          const dA = (next - explodeAmount) * MAX_EXPLODE_OFFSET;
          explodeAmount = next;
          for (const part of explodeParts) part.position.addScaledVector(part.userData.explodeDir, dA);
          if (explodeSession) explodeSession.maxAmount = Math.max(explodeSession.maxAmount, explodeAmount);
        } else if (next !== explodeAmount) {
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

  // v2 literal explode: the follow step, but a tiny slow tail finishes at once (V2.EXPLODE_SNAP).
  function stepExplodeV2(step) {
    const c = explodeCh, e = c.cmd - c.out;
    if (e !== 0 && !c.coast && Math.abs(e) < V2.EXPLODE_SNAP && Math.abs(c.vel) < V2.EXPLODE_SNAP_VEL) {
      c.out = c.cmd;
      c.vel = 0;
      return e;
    }
    return step(c, 'explode');
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

    // Hands v2 Done with no tool on: ease the model back upright (keeps position, scale and its
    // turn about the vertical); undo puts the tilt back. -> true when it started an ease.
    snapUpright,
    get uprighting() { return upright !== null; },

    // One-step undo of the last reset (a misfired clap, the R key, the Reset button). Kept
    // on the API so a future gesture (e.g. a held thumbs-down) can call it too.
    undo: performUndo,

    get canUndo() {
      return undoSnapshot !== null;
    },

    // Counts every reset, whatever triggered it, so the UI can notice a clap reset and offer
    // the undo.
    get resetCount() {
      return resetCount;
    },

    // Which part grab/spin/tilt/scale currently act on, or null when nothing is selected
    // (whole-object mode). Read by the UI to name the active part on the coach HUD.
    get activePart() {
      return activePart;
    },

    // Raycasts against the exploded parts and selects whichever one was hit (or deselects,
    // back to whole-object mode, on a miss). No-ops below EXPLODE_PART_SELECT_THRESHOLD or on
    // a non-literalMode object. ndcX/ndcY are normalized device coordinates in [-1, 1].
    // { part } (optional): the part the hands runtime already targeted for this click (bubble
    // targeting or hold-again cycling, which a plain raycast can't reproduce). Used when it is
    // one of this object's parts; otherwise the raycast decides, exactly as before.
    selectPartAtScreenPoint(ndcX, ndcY, { part } = {}) {
      if (!literalMode || explodeAmount <= EXPLODE_PART_SELECT_THRESHOLD) return null;
      if (part && explodeParts.includes(part)) {
        activePart = part;
        return activePart;
      }
      raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
      const hits = raycaster.intersectObjects(explodeParts, false);
      activePart = hits.length ? hits[0].object : null;
      return activePart;
    },

    // True while a click can pick a part (literal explode, past half-way).
    get partsSelectable() {
      return literalMode && explodeAmount > EXPLODE_PART_SELECT_THRESHOLD;
    },

    // 0..1 for literal explode (0 for a stretch object).
    get explodeAmount() {
      return literalMode ? explodeAmount : 0;
    },

    get parts() {
      return literalMode ? explodeParts.slice() : [];
    },

    // v2 height readout: the model's world-space height (bounding box) and its height-only
    // stretch relative to home proportions (1 = untouched; vertical two-hand spread changes it).
    get height() {
      object.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(object);
      const stretch = (object.scale.y / object.scale.x) / (home.scale.y / home.scale.x);
      return { world: box.isEmpty() ? 0 : box.max.y - box.min.y, stretch };
    },

    // v2 per-person clap thresholds (calibration v2 profile.thresholds). Only finite numbers in
    // the known keys are taken: { CLAP_ARM_SPAN, CLAP_CONTACT_SPAN, CLAP_V_MIN }. Returns the values
    // in force. Harmless with v2 off (v1 clap ignores them).
    setThresholds(patch = {}) {
      for (const k of Object.keys(clapT)) {
        const v = patch?.[k];
        if (Number.isFinite(v) && v >= 0) clapT[k] = v;
      }
      return { ...clapT };
    },

    // Whether this manipulator runs the v2 two-hand behaviours (fixed at creation).
    get v2() {
      return useV2;
    },

    // Ranked parts around a screen point, for bubble targeting and hold-again cycling.
    //   ndc: { x, y } (-1..1, y up); px: bubble radius in CSS px (PARTS_NEAR_PX);
    //   viewport: { width, height } CSS px of the canvas (default 900 tall at camera.aspect).
    //   -> [{ part, hit, depth, distPx, rankPx }], ray hits first (front to back, one entry per
    //      part, distPx = rankPx = 0), then misses whose screen box is within px, nearest first.
    //   Empty unless partsSelectable (pass { any: true } to rank an unexploded object too).
    //   Reads matrixWorld as it stands (the render loop keeps it current; tests update it).
    partsNear(ndc, px = PARTS_NEAR_PX, { viewport = null, any = false } = {}) {
      if (!literalMode || (!any && explodeAmount <= EXPLODE_PART_SELECT_THRESHOLD)) return [];
      if (!ndc || !Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return [];
      const vp = viewport ?? { width: 900 * camera.aspect, height: 900 };
      raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, camera);
      const out = [];
      const seen = new Set();
      for (const h of raycaster.intersectObjects(explodeParts, false)) {
        if (seen.has(h.object)) continue;
        seen.add(h.object);
        out.push({ part: h.object, hit: true, depth: h.distance, distPx: 0, rankPx: 0 });
      }
      const cx = ((ndc.x + 1) / 2) * vp.width;
      const cy = ((1 - ndc.y) / 2) * vp.height;
      const near = [];
      for (const part of explodeParts) {
        if (seen.has(part) || !part.visible) continue;
        const r = screenRect(part, camera, vp);
        if (!r) continue;
        const dx = Math.max(r.x0 - cx, 0, cx - r.x1);
        const dy = Math.max(r.y0 - cy, 0, cy - r.y1);
        const distPx = Math.hypot(dx, dy);
        if (distPx > px) continue;
        const centre = Math.hypot((r.x0 + r.x1) / 2 - cx, (r.y0 + r.y1) / 2 - cy);
        near.push({ part, hit: false, depth: camera.position.distanceTo(part.getWorldPosition(_corner)), distPx, rankPx: distPx + CENTRE_WEIGHT * centre });
      }
      near.sort((a, b) => a.rankPx - b.rankPx);
      return out.concat(near);
    },

    // "Spread to fit": the smallest explode amount (from the current one up, in `step`s, max 1)
    // at which every part shows at least minPx x minPx of itself in front of the others, so a
    // fingertip-sized cursor can land on each (44 px: the usual touch-target minimum). Visible
    // area is sampled on an 11 px grid over each part's screen box (front ray hit = visible);
    // a part too small to ever show that much needs half its own box instead. Leaves the
    // explode at the amount found and returns it, or null on a stretch object.
    spreadToFit({ viewport = null, minPx = 44, step = 0.05 } = {}) {
      if (!literalMode) return null;
      const vp = viewport ?? { width: 900 * camera.aspect, height: 900 };
      const GRID = 11;
      const fits = () => {
        object.updateMatrixWorld(true);
        for (const part of explodeParts) {
          if (!part.visible) continue;
          const r = screenRect(part, camera, vp);
          if (!r) continue;
          let seen = 0;
          let cells = 0;
          for (let y = r.y0 + GRID / 2; y < r.y1; y += GRID) {
            for (let x = r.x0 + GRID / 2; x < r.x1; x += GRID) {
              cells++;
              raycaster.setFromCamera({ x: (x / vp.width) * 2 - 1, y: 1 - (y / vp.height) * 2 }, camera);
              if (raycaster.intersectObjects(explodeParts, false)[0]?.object === part) seen++;
            }
          }
          const need = Math.min((minPx * minPx) / (GRID * GRID), cells / 2);
          if (seen < need) return false;
        }
        return true;
      };
      let a = Math.max(explodeAmount, EXPLODE_PART_SELECT_THRESHOLD + step / 2);
      for (;;) {
        this.setExplode(a);
        if (a >= 1 || fits()) return explodeAmount;
        a = Math.min(1, a + step);
      }
    },

    // Selects a part directly (or null = whole object). Same gate as a click.
    selectPart(part) {
      if (!literalMode || explodeAmount <= EXPLODE_PART_SELECT_THRESHOLD) return null;
      activePart = part && explodeParts.includes(part) ? part : null;
      return activePart;
    },

    // Sets the literal explode amount (0..1) directly ("spread to fit"). Parts go to
    // home + dir x amount, as the explode gesture puts them. Returns the amount applied, or
    // null on a stretch object.
    setExplode(amount) {
      if (!literalMode || !Number.isFinite(amount)) return null;
      explodeAmount = THREE.MathUtils.clamp(amount, 0, 1);
      explodeLiteralV = explodeAmount;
      for (const part of explodeParts) {
        part.position.copy(part.userData.explodeHome).addScaledVector(part.userData.explodeDir, explodeAmount * MAX_EXPLODE_OFFSET);
      }
      return explodeAmount;
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
      // Engage zone (Engage -> Aim -> Act): a lowered hand is at rest and does nothing, as if
      // it were out of frame. hand.engaged is set by pointer.js createEngagement; hands without
      // it (tests, labs, the viewer) all count, exactly as before.
      if (hands.some((h) => h.engaged === false)) hands = hands.filter((h) => h.engaged !== false);

      // Real elapsed time since the last call. Clamped so a long pause (tab backgrounded,
      // camera hiccup) can't read as a wildly fast gesture the instant tracking resumes.
      let dt = lastUpdateTime !== null ? (timestampMs - lastUpdateTime) / 1000 : 1 / 60;
      if (!(dt > 0)) dt = 1 / 60;
      dt = Math.min(dt, 0.25);
      lastUpdateTime = timestampMs;
      v2Now = timestampMs;

      const twoHanded = hands.length === 2 && hands.every((h) => h.pinch?.pinching);
      // isFistLike trusts MediaPipe's own classifier when it has a confident opinion
      // either way, and only falls back to geometric curl detection when it doesn't.
      // fistOf also honours hand.pointer: a pointer is never a fist (BUGS #32).
      for (const h of hands) {
        const k = h.handedness ?? '?';
        const r = h.pinch?.ratio;
        const closed = h.pinch?.pinching === true || (Number.isFinite(r) && r < SAME_PINCH_CLOSE);
        if (closed && (h.pointer?.gun === true || wasGunBy.get(k) || pinchLatch.has(k))) pinchLatch.add(k);
        else pinchLatch.delete(k);
        wasGunBy.set(k, h.pointer?.gun === true);
      }
      for (const k of [...pinchLatch]) if (!hands.some((h) => (h.handedness ?? '?') === k)) pinchLatch.delete(k);
      const latched = (h) => pinchLatch.has(h.handedness ?? '?');
      const fisted = hands.some((h) => fistOfM(h, aspect) && !latched(h));
      const pointing = hands.some((h) => h.pointer?.gun === true || latched(h));
      // Explode's trigger occupies a hand-shape space disjoint from both pinch (transform)
      // and fist (grab) on purpose — two open hands, neither pinching nor fisted. Nor
      // pointing: once a pointer stopped reading as a fist, "pointer + relaxed other hand"
      // would otherwise have become explode, and aiming moves the hands apart.
      const openHanded =
        hands.length === 2 && hands.every((h) => !fistOfM(h, aspect) && !h.pinch?.pinching && isOpenForExplode(h));

      // Each mode is gated on its channel being armed, so practice mode can silence a
      // gesture completely rather than merely ignoring its effect.
      const grabArmed = on('move') || on('spin') || on('tilt') || on('push');
      const wantTransform = twoHanded && on('scale');
      const wantExplode = openHanded && on('explode');
      const wantGrab = fisted && grabArmed;

      // Neutral gap (BUGS #26): after a gesture ends, a different one waits until the hands
      // have been neutral. `allowed` only ever bites in IDLE -- the gap is cleared the
      // moment any gesture is active.
      updateGap(!wantTransform && !wantExplode && !wantGrab, timestampMs);
      // Post-pointer gap: starts on the first frame without a pointer, only from rest (an
      // active gesture by the other hand is left alone), and blocks every gesture start.
      if (wasPointing && !pointing && mode === MODE.IDLE) pointerGapSince = timestampMs;
      wasPointing = pointing;
      if (pointerGapSince !== null && timestampMs - pointerGapSince >= POINTER_GAP_MS) pointerGapSince = null;
      // aim -> grab in <=250 ms (owner-approved 2026-10-01, HANDS-UX-SPEC §1): a fist MediaPipe
      // is sure of (Closed_Fist, score >= FIST_SURE_SCORE) with the thumb clearly off the index
      // (pinch ratio above the close threshold) is a deliberate grab, not the index curling
      // back, so it skips the post-pointer gap. A latched same-hand pinch (BUGS #47) still
      // counts as pointing and never gets here.
      if (pointerGapSince !== null && hands.some((h) => !latched(h) && h.gesture === 'Closed_Fist' &&
        h.score >= FIST_SURE_SCORE && !h.pinch?.pinching && Number.isFinite(h.pinch?.ratio) && h.pinch.ratio > SAME_PINCH_CLOSE)) {
        pointerGapSince = null;
      }
      // TRANSFORM is exempt from the neutral gap (owner live bug 2026-10-01, BUGS #45): the gap
      // exists to stop the open hands a gesture LEAVES BEHIND from exploding (#26), and a
      // two-hand pinch is never left behind by anything. But "neutral" means no gesture pose,
      // and with everything armed the open hands raised before pinching are explode's pose:
      // explode engaged, ended when the hands pinched, and its gap then needed a neutral moment
      // that a held pinch can never give, so scale never started until the hands dropped.
      const allowed = (m) => (!gap || gap.endedMode === m || m === MODE.TRANSFORM) && pointerGapSince === null;

      // Clap is a command: it fires from IDLE or during an explode (owner-approved 2026-10-01,
      // Ricky E2: a clap resets an explode, pulled apart or not; this replaces the BUGS #27
      // "explodePulled" block), never inside a neutral gap and never from a pointer.
      // checkClap still runs on every two-hand frame so its speed tracking stays continuous;
      // a blocked clap keeps its arm (E3).
      let clapped = false;
      if (useV2) {
        clapped = on('clap') && checkClapV2(hands, aspect, timestampMs);
      } else if (hands.length !== 2) {
        // Approach-then-merge (E1): the hands were closing fast and near, and one vanished at
        // contact; the hand left must be open (a fist or pointer is a different gesture).
        const h = hands[0];
        clapped = hands.length === 1 && on('clap') && clapApproach !== null &&
          timestampMs - clapApproach.t <= CLAP_MERGE_MS && !fistOfM(h, aspect) && !h.pinch?.pinching;
        // Clap speed is only measured across consecutive two-hand frames. Keeping the last
        // sample across a dropout made hands that left the frame apart and came back close
        // together read as a fast close, and reset the model out of nothing.
        lastClapSpan = null;
        lastClapTime = null;
        clapApproach = null;
      } else if (on('clap')) {
        clapped = checkClap(hands, aspect, timestampMs);
      }
      {
        const atRest = mode === MODE.IDLE || mode === MODE.EXPLODE;
        // A pointer is not an open hand, so it never claps.
        if (clapped && atRest && allowed(CLAP) && !pointing) {
          clapArmed = false;
          clapApproach = null;
          if (useV2) {
            clap2.hist = [];
            clap2.approachT = null;
            clap2.cooldownUntil = timestampMs + V2.CLAP_COOLDOWN_MS;
            // Clap during explode = the ORIGINAL model's parts (view kept); otherwise reset view.
            if (literalMode && explodedForClap()) restoreOriginalParts();
            else performReset();
          } else {
            performReset();
          }
          lastAdvanceTime = timestampMs;
          // A clap ends like any gesture: the hands it leaves together and open are the
          // explode pose, so separating them afterwards must not explode the fresh reset.
          startGap(CLAP, timestampMs);
          return mode;
        }
      }

      // Starting a gesture from IDLE and INTERRUPTING a different, already-active gesture
      // are not the same decision: SWITCH_AWAY_MS raises the bar for the interrupt case so a
      // single misread frame can't hijack an active gesture.
      const startingFromIdle = mode === MODE.IDLE;
      const enterFor = (targetMode) => (startingFromIdle || mode === targetMode ? undefined : SWITCH_AWAY_MS);
      const prevMode = mode;

      const transforming = transform.update(wantTransform && allowed(MODE.TRANSFORM), timestampMs, enterFor(MODE.TRANSFORM));
      const exploding = explode.update(wantExplode && allowed(MODE.EXPLODE) && !transforming, timestampMs, enterFor(MODE.EXPLODE));
      // A pointer that is up blocks a grab from STARTING (HANDS-UX-SPEC §1 "a recent pointer
      // blocks it"; the Platform's POINTER_GRAB_BLOCK_MS, now here for hologram.html too): the
      // other hand's click-pinch often reads Closed_Fist, and would otherwise grab mid-aim. The
      // post-pointer gap covers the moments after. A grab already running is left alone.
      const pointerBlocksGrab = pointing && mode !== MODE.GRAB;
      const grabbing = grab.update(wantGrab && allowed(MODE.GRAB) && !pointerBlocksGrab && !transforming && !exploding, timestampMs, enterFor(MODE.GRAB));

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

      if (mode !== MODE.IDLE) gap = null;
      else if (prevMode !== MODE.IDLE) startGap(prevMode, timestampMs);
      // v2: a flick coasts until any other gesture takes the model (a new grab stops it in commandGrab).
      if (useV2 && (mode === MODE.TRANSFORM || mode === MODE.EXPLODE)) for (const st of targetStates.values()) st.flick = null;

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
  // raising it tilts the model up (front edge rises), lowering tilts it down; left/right rolls.
  function commandGrab(target, hands, aspect, dt) {
    const s = stateFor(target);
    const os = target === object ? s : stateFor(object); // depth always on the object

    const fists = hands.filter((h) => fistOfM(h, aspect));
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
      if (useV2) s.flick = null;
      s.lastWrist = { x: wrist.x, y: wrist.y };
      s.tiltBase = { pitch: s.ch.pitch.cmd, roll: s.ch.roll.cmd };
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

    if (useV2) {
      tiltV2(target, s, pitchHand, aspect, dt);
    } else if (pitchHand) {
      const pw = wristOf(pitchHand);
      if (!s.sig.px) {
        // The second hand just appeared: take its reference, no motion.
        s.sig.px = newSignal(pw.x);
        s.sig.py = newSignal(pw.y);
        s.tiltOrigin = { x: pw.x, y: pw.y };
      } else {
        // A tracking jump moves the rate zone's centre with it, as takeUpSlack does its anchor.
        if (Math.abs(pw.x - s.sig.px.last) > MAX_TILT_PER_SECOND * dt) s.tiltOrigin.x += pw.x - s.sig.px.last;
        if (Math.abs(pw.y - s.sig.py.last) > MAX_TILT_PER_SECOND * dt) s.tiltOrigin.y += pw.y - s.sig.py.last;
        let tx = takeUpSlack(s.sig.px, pw.x, TILT_DEADZONE, MAX_TILT_PER_SECOND, dt);
        let ty = takeUpSlack(s.sig.py, pw.y, TILT_DEADZONE, MAX_TILT_PER_SECOND, dt);
        const rate = (off) => {
          const over = Math.abs(off) - TILT_RATE_ZONE;
          return over > 0 ? Math.sign(off) * Math.min(over * TILT_RATE_GAIN, TILT_RATE_MAX) * dt : 0;
        };
        // In frame units, so the gains below convert it like a position step.
        tx += rate(pw.x - s.tiltOrigin.x) / ROLL_SENSITIVITY;
        ty += rate(pw.y - s.tiltOrigin.y) / PITCH_SENSITIVITY;
        if (on('tilt')) {
          // Raising the hand (image y falling) tilts the model UP: its front edge rises on
          // screen and its top tips away from the camera (negative pitch about world X).
          // Owner request after the 2026-10-01 webcam test; it used to tilt down. Moving the
          // hand right in the image rolls positive about Z (unchanged).
          const base = s.tiltBase || (s.tiltBase = { pitch: s.ch.pitch.cmd, roll: s.ch.roll.cmd });
          s.ch.pitch.cmd += easeTilt(s.ch.pitch.cmd - base.pitch, ty * PITCH_SENSITIVITY * sens);
          s.ch.roll.cmd += easeTilt(s.ch.roll.cmd - base.roll, tx * ROLL_SENSITIVITY * sens);
        }
      }
      s.lastPitchWrist = { x: pw.x, y: pw.y };
    } else {
      delete s.sig.px;
      delete s.sig.py;
      s.tiltOrigin = null;
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
    if (useV2) return commandTransformV2(target, hands, aspect, dt);
    const s = stateFor(target);
    // Normalised by the HELD palm length (see PALM_REF_DEADZONE), captured when the pinch
    // engages and updated only past its own deadzone, so palm noise stays out of the span.
    const palm = (palmLength(hands[0].landmarks, aspect) + palmLength(hands[1].landmarks, aspect)) / 2;
    if (!(palm > 0)) return;
    const logPalm = Math.log(palm);
    if (!s.spanSig) {
      s.palmSig = newSignal(logPalm);
      s.spanSig = newSignal(handSpan(hands[0], hands[1], aspect, { palm }));
      s.ch.scale.coast = 0;
      return;
    }
    takeUpSlack(s.palmSig, logPalm, PALM_REF_DEADZONE, MAX_DEPTH_RATIO_PER_SECOND, dt);
    const span = handSpan(hands[0], hands[1], aspect, { palm: Math.exp(s.palmSig.anchor) });
    if (!(span > 0)) return;
    // Slack in palm lengths (see SCALE_DEADZONE), but the tracking-jump guard stays in
    // ln(span)/s as before (a jump moves the slack reference with it), and the model still
    // scales by the RATIO the slack reference moved.
    const jumped = Math.abs(Math.log(span / s.spanSig.last)) > MAX_SPAN_RATIO_PER_SECOND * dt;
    const d = takeUpSlack(s.spanSig, span, SCALE_DEADZONE, jumped ? 0 : Infinity, dt);
    const from = s.spanSig.anchor - d;
    // Direction gain (SCALE_V_WEIGHT): a constant weight cancels out of the span RATIO, so the
    // vertical share of the separation scales the log-ratio instead: 1 side by side, W stacked.
    const gain = handSpan(hands[0], hands[1], aspect, { palm: 1, vWeight: SCALE_V_WEIGHT }) / (handSpan(hands[0], hands[1], aspect, { palm: 1 }) || 1);
    if (d && from > 0) s.ch.scale.cmd += Math.log(s.spanSig.anchor / from) * gain * settings.sensitivity;
  }

  // Two open hands pulling apart: on a multi-part object, each mesh slides outward from the
  // group's centroid along its own direction (literal explode); on a single-mesh object like
  // the chair it stretches along whichever axis the hands are separating on (hands apart
  // left-right widens it, up-down heightens it), deliberately non-uniform so it doesn't look
  // like pinch-scale. Commanded from the change in span with a deadzone, so a still pair of
  // hands can no longer ratchet the stretch upward against its floor (BUGS #11).
  function commandExplode(hands, aspect, dt) {
    if (useV2 && literalMode) return commandExplodeV2(hands, aspect, dt);
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
      explodeStart = { span, age: 0 };
      return;
    }
    if (!explodePulled) {
      // Not yet a deliberate spread: track the stable start, command nothing.
      const jump = span - explodeSig.last;
      explodeSig.last = span;
      explodeStart.age += dt;
      // A tracking jump shifts the start with it (as takeUpSlack does), so it never counts.
      if (Math.abs(jump) > MAX_EXPLODE_SPAN_RATE_PER_SECOND * dt) explodeStart.span += jump;
      if (span <= explodeStart.span) { explodeStart = { span, age: 0 }; return; }
      const rise = span - explodeStart.span;
      // Still near the start (inside the deadzone): the spread has not begun, so a long still
      // hold before it never dilutes its speed.
      if (rise <= EXPLODE_DEADZONE) { explodeStart.age = 0; return; }
      const fast = rise >= EXPLODE_START_SPREAD && rise / Math.max(explodeStart.age, dt) >= EXPLODE_MIN_SPREAD_SPEED;
      if (!fast && rise < EXPLODE_FAR_SPREAD) return;
      // The spread counts from the stable start, less the usual deadzone.
      explodePulled = true;
      explodeSig.anchor = span - EXPLODE_DEADZONE;
      explodeCh.cmd += (rise - EXPLODE_DEADZONE) * EXPLODE_SENSITIVITY * settings.sensitivity;
      return;
    }
    const d = takeUpSlack(explodeSig, span, EXPLODE_DEADZONE, MAX_EXPLODE_SPAN_RATE_PER_SECOND, dt);
    explodeCh.cmd += d * EXPLODE_SENSITIVITY * settings.sensitivity;
  }

  // ---- v2 two-hand behaviours (see the V2 block at the end of this file) ----

  // Tilt: the second (open) hand's palm-frame rotation since it engaged, boosted, applied
  // ABSOLUTELY to the model's rotation at engage (never accumulated, so a still hand = a still
  // model and nothing drifts). Closing that hand = ratchet: re-baseline from where the model is.
  function tiltV2(target, s, pitchHand, aspect, dt) {
    if (!on('tilt')) return;
    const t = s.tilt;
    const open = !!pitchHand && !fistOfM(pitchHand, aspect);
    const raw = open ? handFrameQ(pitchHand) : null;
    s.lastPitchWrist = pitchHand ? { x: wristOf(pitchHand).x, y: wristOf(pitchHand).y } : null;
    if (!pitchHand || (open && !raw)) {
      // Second hand gone (or no 3D): let go of the tilt; a fast turn flicks.
      if (t?.q0) { trimReleaseGlitch(t); if (!flickFromTilt(s)) pauseTilt(t); }
      return;
    }
    if (!open) { if (t?.q0) pauseTilt(t); return; } // ratchet: hand closed
    if (!t || !t.q0) {
      // Engage (or re-engage after a ratchet): baseline = what the model is commanded to be now.
      const base = t ? t.qT.clone() : target.quaternion.clone();
      s.flick = null;
      s.tilt = {
        q0: raw.clone(), base, qT: base.clone(), lastRaw: raw.clone(), dMp: new THREE.Quaternion(),
        omega: 0, hist: [{ t: v2Now, q: base.clone() }], paused: false,
        limit: Math.max(V2.TILT_PITCH_LIMIT_DEG * D2R, Math.abs(pitchOf(base)))
      };
      return;
    }
    // Tracking jump (a label swap, a mis-fit frame): keep the current Δ, re-anchor q0 under it.
    const jump = quatAngle(raw, t.lastRaw);
    t.lastRaw.copy(raw);
    if (jump > V2.TILT_JUMP_MIN_RAD && jump > V2.TILT_JUMP_RAD_S * dt) {
      t.q0 = t.dMp.clone().invert().multiply(raw);
      return;
    }
    t.dMp = raw.clone().multiply(t.q0.clone().invert());
    const { axis, angle } = axisAngle(mpToView(t.dMp));
    const boosted = new THREE.Quaternion().setFromAxisAngle(axis, tiltBoost(angle) * settings.sensitivity);
    let qT;
    if (target === object) {
      qT = boosted.multiply(t.base);
      limitPitch(qT, t.limit);
    } else {
      // A part's rotation is local to the (possibly rotated) model: express the view-space turn there.
      const po = object.quaternion;
      qT = po.clone().invert().multiply(boosted).multiply(po).multiply(t.base);
    }
    // Smoothing speed = the lower of the last two frame speeds: one glitched frame can't open the
    // filter (break-it B1b: a 25 deg one-frame glitch twitched the model 29 deg).
    const wNow = dt > 0 ? quatAngle(qT, t.qT) / dt : 0;
    t.omega = Math.min(wNow, t.wPrev ?? 0);
    t.wPrev = wNow;
    t.qT.copy(qT);
    t.hist.push({ t: v2Now, q: qT.clone() });
    while (t.hist.length > 2 && v2Now - t.hist[0].t > 3 * V2.FLICK_WINDOW_MS) t.hist.shift();
  }

  function pauseTilt(t) {
    t.base = t.qT.clone();
    t.q0 = null;
    t.paused = true;
  }

  // A hand leaving the frame often distorts its last fit: drop a last step that is both large and
  // far bigger than the one before it, so the model doesn't keep that turn (break-it B2).
  function trimReleaseGlitch(t) {
    const h = t.hist;
    if (h.length < 3) return;
    const a1 = quatAngle(h[h.length - 1].q, h[h.length - 2].q);
    const a0 = quatAngle(h[h.length - 2].q, h[h.length - 3].q);
    if (a1 > V2.RELEASE_TRIM_DEG * D2R && a1 > 3 * a0) {
      h.pop();
      t.qT.copy(h[h.length - 1].q);
    }
  }

  // Release speed over the last FLICK_WINDOW_MS of the commanded rotation; fast enough = coast.
  // Sustained: the window without its last frame must be fast too, so one late frame can't flick.
  function flickFromTilt(s) {
    const t = s.tilt;
    if (!settings.momentum || !t || t.hist.length < 3) return false;
    const speed = (end) => {
      const last = t.hist[end];
      let ref = t.hist[0];
      for (let i = 0; i <= end; i++) if (last.t - t.hist[i].t >= V2.FLICK_WINDOW_MS) ref = t.hist[i];
      const secs = (last.t - ref.t) / 1000;
      if (!(secs >= 0.03)) return null;
      const { axis, angle } = axisAngle(last.q.clone().multiply(ref.q.clone().invert()));
      return { axis, w: angle / secs };
    };
    const full = speed(t.hist.length - 1);
    const early = speed(t.hist.length - 2);
    if (!full || !early || !(full.w >= V2.FLICK_MIN_RAD_S) || !(early.w >= V2.FLICK_MIN_RAD_S)) return false;
    const { axis, w } = full;
    s.flick = { axis, w, limit: t.limit };
    s.tilt = null;
    return true;
  }

  // A fist twist (spin channel) during a tilt turns the tilt's references with the model.
  function spinTiltRefs(target, t, angle) {
    const r = new THREE.Quaternion().setFromAxisAngle(AXIS_Y, angle);
    if (target === object) { t.base.premultiply(r); t.qT.premultiply(r); } else { t.base.multiply(r); t.qT.multiply(r); }
  }

  // Display-rate follow: adaptive slerp toward the commanded rotation (Ricky §6: fc = 1 + 2·ω Hz),
  // then any flick coasting with the same half-life as every other channel.
  function advanceTiltV2(target, s, dt, decay) {
    const t = s.tilt;
    if (t) {
      const fc = V2.TILT_FC0_HZ + V2.TILT_FC_PER_RAD * (t.omega || 0);
      const a = 1 - Math.exp(-2 * Math.PI * fc * dt);
      const left = quatAngle(target.quaternion, t.qT);
      if (left < 1e-6) target.quaternion.copy(t.qT);
      else target.quaternion.slerp(t.qT, a);
      if (t.paused && left < 1e-4) { target.quaternion.copy(t.qT); s.tilt = null; }
    }
    const f = s.flick;
    if (f) {
      target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(f.axis, f.w * dt));
      if (target === object) limitPitch(target.quaternion, f.limit);
      f.w *= decay;
      if (f.w < V2.FLICK_STOP_RAD_S) s.flick = null;
    }
  }

  // Two pinching hands: side by side = uniform size (as v1, without the vertical gain); stacked
  // (|angle| > 55 deg, decided when the pinch engages and sticky for the gesture) = height only.
  function commandTransformV2(target, hands, aspect, dt) {
    const s = stateFor(target);
    const palm = (palmLength(hands[0].landmarks, aspect) + palmLength(hands[1].landmarks, aspect)) / 2;
    if (!(palm > 0)) return;
    const logPalm = Math.log(palm);
    if (!s.spanSig) {
      s.palmSig = newSignal(logPalm);
      s.spanSig = newSignal(handSpan(hands[0], hands[1], aspect, { palm }));
      s.ch.scale.coast = 0;
      s.ch.stretchY.coast = 0;
      const a = wristOf(hands[0]);
      const b = wristOf(hands[1]);
      s.scaleVertical = Math.atan2(Math.abs(a.y - b.y), Math.abs(a.x - b.x) * aspect) > V2.SCALE_VERTICAL_DEG * D2R;
      return;
    }
    takeUpSlack(s.palmSig, logPalm, PALM_REF_DEADZONE, MAX_DEPTH_RATIO_PER_SECOND, dt);
    const span = handSpan(hands[0], hands[1], aspect, { palm: Math.exp(s.palmSig.anchor) });
    if (!(span > 0)) return;
    const jumped = Math.abs(Math.log(span / s.spanSig.last)) > MAX_SPAN_RATIO_PER_SECOND * dt;
    const d = takeUpSlack(s.spanSig, span, SCALE_DEADZONE, jumped ? 0 : Infinity, dt);
    const from = s.spanSig.anchor - d;
    if (d && from > 0) {
      const k = Math.log(s.spanSig.anchor / from) * settings.sensitivity;
      if (s.scaleVertical) s.ch.stretchY.cmd += k;
      else s.ch.scale.cmd += k;
    }
  }

  // Literal explode/assemble: amount = f(span / span0) both ways for the whole EXPLODE state.
  // span0 is back-solved on entry so re-engaging an exploded model never jumps; closing past it
  // while assembled re-anchors it (the next spread counts from the closest point).
  function commandExplodeV2(hands, aspect, dt) {
    const span = handSpan(hands[0], hands[1], aspect);
    if (!(span > 0)) return;
    const lnDead = Math.log(V2.EXPLODE_DEAD_RATIO);
    const lnFull = Math.log(V2.EXPLODE_FULL_RATIO);
    if (!explodeSig) {
      const a = explodeAmount;
      explodeSig = { span0: a > 0 ? span * Math.exp(-(lnDead + a * (lnFull - lnDead))) : span, last: span };
      explodeCh = { cmd: a, out: a, vel: 0, coast: 0 };
      explodeLiteralV = a;
      if (!explodeSession) explodeSession = { snapshot: takeSnapshot(), maxAmount: a };
      if (!originalParts && a === 0) originalParts = explodeParts.map((p) => [p.position.clone(), p.quaternion.clone(), p.scale.clone()]);
      return;
    }
    const jr = Math.log(span / explodeSig.last);
    explodeSig.last = span;
    if (Math.abs(jr) > MAX_SPAN_RATIO_PER_SECOND * dt) { explodeSig.span0 *= Math.exp(jr); return; }
    const r = Math.log(span / explodeSig.span0);
    if (r < 0 && explodeCh.cmd <= 0) explodeSig.span0 = span;
    explodeCh.cmd = THREE.MathUtils.clamp((r - lnDead) / (lnFull - lnDead), 0, 1);
  }

  // "During explode" for the clap: parts visibly apart now or earlier in this explode state (a
  // fast clap's own close assembles some of the way first). EPS: the follow spring only reaches
  // 0 asymptotically, and a leftover 1e-5 must not turn a later clap into "restore original".
  function explodedForClap() {
    const EPS = 0.01;
    return explodeAmount > EPS || (explodeSession?.maxAmount ?? 0) > EPS;
  }

  // The explode state ended: if it changed the explode, undo puts back the pose from before it.
  function endExplodeSession() {
    const sess = explodeSession;
    explodeSession = null;
    if (Math.abs(explodeAmount - sess.snapshot.explodeAmount) > 1e-6) undoSnapshot = sess.snapshot;
  }

  // Clap during explode: every part back to its ORIGINAL transform (snapshot at the first explode),
  // the model's own position/rotation/scale kept. Undoable (back to the exploded, edited state).
  function restoreOriginalParts() {
    undoSnapshot = takeSnapshot();
    resetCount++;
    clearMotionState();
    explodeAmount = 0;
    explodeLiteralV = 0;
    activePart = null;
    explodeParts.forEach((part, i) => {
      const o = originalParts?.[i];
      part.position.copy(o ? o[0] : part.userData.explodeHome);
      part.quaternion.copy(o ? o[1] : part.userData.explodeHomeQuaternion);
      part.scale.copy(o ? o[2] : part.userData.explodeHomeScale);
    });
    originalParts = null;
  }

  // Clap v2 (Ricky §5): armed by span >= 2.0 palms in the last 1.2 s; fires at span <= 1.2 or on
  // the merge rule; palms must face each other; no speed floor (except CLAP_EXPLODED_MIN_SPEED
  // while parts are exploded); survives <= 2 dropped frames; a brief pinch/fist misread doesn't
  // disarm. Spans from RAW wrists. The caller spends the arm and starts the cooldown on firing.
  function checkClapV2(hands, aspect, t) {
    const c = clap2;
    if (hands.length === 2) {
      if (hands.some((h) => h.pinch?.pinching || fistOfM(h, aspect))) {
        c.approachT = null;
        if (c.glitchSince === null) c.glitchSince = t;
        if (t - c.glitchSince >= V2.CLAP_GLITCH_MS) { c.hist = []; c.last = null; }
        return false;
      }
      c.glitchSince = null;
      const span = rawSpan(hands[0], hands[1], aspect);
      if (!(span > 0)) return false;
      c.dropped = 0;
      c.hist.push({ t, span });
      while (c.hist.length && t - c.hist[0].t > V2.CLAP_ARM_MS) c.hist.shift();
      if (palmsFacing(hands[0], hands[1])) c.facingT = t;
      const facing = c.facingT !== null && t - c.facingT <= V2.CLAP_FACING_MS;
      let armAt = null;
      for (let i = c.hist.length - 1; i >= 0; i--) if (c.hist[i].span >= clapT.CLAP_ARM_SPAN) { armAt = c.hist[i]; break; }
      const closing = c.last !== null && span < c.last.span;
      let fastEnough = true;
      const floor = Math.max(clapT.CLAP_V_MIN, literalMode && explodedForClap() ? V2.CLAP_EXPLODED_MIN_SPEED : 0);
      if (floor > 0 && armAt) {
        const secs = (t - armAt.t) / 1000;
        fastEnough = secs > 0 && (armAt.span - span) / secs >= floor;
      }
      c.last = { t, span };
      const ready = armAt !== null && facing && fastEnough && t >= c.cooldownUntil;
      c.approachT = ready && closing && span < V2.CLAP_MERGE_SPAN ? t : null;
      return ready && span <= clapT.CLAP_CONTACT_SPAN;
    }
    let fired = false;
    if (hands.length === 1 && c.approachT !== null && t - c.approachT <= V2.CLAP_MERGE_MS && t >= c.cooldownUntil) {
      const h = hands[0];
      fired = !fistOfM(h, aspect) && !h.pinch?.pinching;
    }
    c.dropped++;
    if (c.dropped > V2.CLAP_MAX_DROPPED) { c.hist = []; c.last = null; c.approachT = null; }
    return fired;
  }
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------------------------
// HANDS V2 two-hand behaviours (plans/hands-v2/CONTRACT.md §3.3-3.4; Ricky's report §5-6; owner
// decisions 2026-10-02). Active only when createManipulator(..., { v2: true }) or, by default,
// gestures.handsV2Enabled() (?hands=v2 / localStorage 'hands.v2'='1'). With v2 off none of this
// runs and the v1 code above behaves bit for bit as before.
//
// Every number is a starting value (synthetic hands only, no owner clips yet): tune on clips.
export const V2 = Object.freeze({
  // Tilt (second hand's palm frame, position control).
  TILT_GAIN: 1.5,               // owner 2026-10-02: axis-angle x 1.5 ...
  TILT_GAIN_FROM_DEG: 8,        // ... but no boost below ~8 deg of hand turn
  TILT_DEADZONE_DEG: 4,         // soft: subtracted from the angle, the axis is kept (Ricky §6)
  TILT_PITCH_LIMIT_DEG: 80,     // soft limit on tipping toward/away from the camera
  TILT_PITCH_KNEE_DEG: 60,      // the soft limit starts easing here
  TILT_FC0_HZ: 1.0,             // adaptive slerp: fc = FC0 + FC_PER_RAD * angular speed (rad/s)
  TILT_FC_PER_RAD: 2.0,
  TILT_JUMP_RAD_S: 15,          // a palm frame turning faster than this between frames is a tracking jump
                                //   (deliberate wrist turns peak ~5-10 rad/s; Debbie break-it B2: 30 let a
                                //   45 deg one-frame glitch through)
  TILT_JUMP_MIN_RAD: 0.6,       // ... and only past this angle (35 deg) in one frame
  FLICK_WINDOW_MS: 100,         // release speed measured over the last 100 ms
  FLICK_MIN_RAD_S: 2.5,         // ~140 deg/s of model turn: below it, releasing just stops
  FLICK_STOP_RAD_S: 0.12,       // coast ends below this
  RELEASE_TRIM_DEG: 8,          // on release, a last step bigger than this AND 3x the one before is a
                                //   glitch (a hand leaving the frame distorts its last fit): dropped
  // Scale.
  SCALE_VERTICAL_DEG: 55,       // hand-to-hand line steeper than this = height-only stretch
  // Explode / assemble: amount = f(span / span0).
  EXPLODE_DEAD_RATIO: 1.12,     // spans within 12% of span0 do nothing
  EXPLODE_FULL_RATIO: 2.5,      // span0 x 2.5 = fully exploded
  // Clap speed floor with no calibration profile (palms/s, last arming frame -> contact). Ricky §5
  // had none; "this big" talking hands (palms facing, 2.2 -> 1.1 palms in 1 s) read ~1.1 and
  // reset the view (Debbie break-it B9). The slowest clap check (2.5 -> 1.0 in 0.9 s) reads ~1.67.
  CLAP_V_MIN_DEFAULT: 1.5,
  // The absolute v2 command sits exactly AT its 0..1 limit, so the follow spring only reaches it
  // asymptotically and its last few µm kept moving every part for ~10 frames after the hands
  // left (test.js 'part B (not selected) does not move'; v1's accumulating command overshoots
  // the clamp instead). A tail this small (amount units; x MAX_EXPLODE_OFFSET 0.6 m = 60 µm)
  // and this slow finishes in one step: invisible, and a settled model is bit-still.
  EXPLODE_SNAP: 1e-4,
  EXPLODE_SNAP_VEL: 0.01,       // amount / s
  // Clap (Ricky §5, no speed floor).
  CLAP_ARM_SPAN: 2.0,           // palms, at some two-hand frame in the last CLAP_ARM_MS
  CLAP_ARM_MS: 1200,
  CLAP_FIRE_SPAN: 1.2,
  CLAP_MERGE_SPAN: 2.5,         // the existing merge rule: closing + this near, then one hand lost ...
  CLAP_MERGE_MS: 150,           // ... within this
  CLAP_FACING_DOT: -0.5,        // palm normals opposed ...
  CLAP_FACING_NX: 0.6,          // ... and both mostly sideways
  CLAP_FACING_MS: 250,          // a facing reading this recent counts (normals smear at contact)
  CLAP_MAX_DROPPED: 2,          // frames without two hands the arm survives
  CLAP_COOLDOWN_MS: 600,
  CLAP_GLITCH_MS: 100,          // a pinch/fist reading must hold this long to disarm
  // Deviation (Debbie 2026-10-02, owner/overseer to confirm): while parts are exploded, a clap
  // needs this average approach speed (palms/s), so a SLOW close with palms facing each other
  // assembles (keeps edits) instead of firing "restore original". 0 = no floor anywhere.
  CLAP_EXPLODED_MIN_SPEED: 3.0
});

const D2R = Math.PI / 180;

function ptOf(p) {
  if (!p) return null;
  return Array.isArray(p) ? p : [p.x, p.y, p.z];
}
const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]); return n > 1e-12 ? [a[0] / n, a[1] / n, a[2] / n] : null; };

// Palm frame from WORLD landmarks 0,5,9,13,17 (Ricky §6, same formula as handFeatures.js):
// ŷ = norm(mean(5,9,13,17) − 0), n̂ = norm((5 − 17) × ŷ), x̂ = ŷ × n̂. -> { q, n } or null.
// Local fallback for hands that have world landmarks but no hand.f (handFeatures not run).
export function palmFrameFromWorld(world) {
  if (!Array.isArray(world) || world.length !== 21) return null;
  const w = [0, 5, 9, 13, 17].map((i) => ptOf(world[i]));
  if (!w.every((p) => p && p.every(Number.isFinite))) return null;
  const mean = [0, 1, 2].map((k) => (w[1][k] + w[2][k] + w[3][k] + w[4][k]) / 4);
  const Y = v3unit(v3sub(mean, w[0]));
  if (!Y) return null;
  const N = v3unit(v3cross(v3sub(w[1], w[4]), Y));
  if (!N) return null;
  const X = v3cross(Y, N);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...X), new THREE.Vector3(...Y), new THREE.Vector3(...N));
  return { q: new THREE.Quaternion().setFromRotationMatrix(m), n: N };
}

// handFeatures.js signs its normal out of the palm by handedness; the local fallback does the same.
const PALM_SIGN_V2 = { Left: 1, Right: -1 };

// The hand's palm-frame quaternion (MediaPipe world axes), or null when it has no usable 3D.
// hand.f (handFeatures.js) wins; a hand.f without world data reports identity q with null curls,
// which is NOT an orientation, so it falls through to the local helper / null.
function handFrameQ(hand) {
  const f = hand?.f;
  if (f?.frame?.q && f.curl && f.curl.index != null) return new THREE.Quaternion(...f.frame.q);
  return palmFrameFromWorld(hand?.worldLandmarks)?.q ?? null;
}

// Palm normal pointing out of the palm (MediaPipe world axes), or null.
function handPalmNormal(hand) {
  const f = hand?.f;
  if (f?.frame?.normal && f.curl && f.curl.index != null) return f.frame.normal;
  const pf = palmFrameFromWorld(hand?.worldLandmarks);
  if (!pf) return null;
  const s = PALM_SIGN_V2[hand.handedness] ?? -1;
  return [pf.n[0] * s, pf.n[1] * s, pf.n[2] * s];
}

// MediaPipe world (x image-right, y down, z away from the camera) -> the view the user sees
// (mirrored display: x = the user's right, y up, z toward the user). The map is diag(-1,-1,+1),
// a proper rotation (180 deg about z), so a rotation about axis a becomes the same angle about
// diag(-1,-1,1)·a: q (x,y,z,w) -> (-x,-y,z,w). "Tip the fingers toward the screen" therefore tips
// the model's top INTO the screen. NOTE: Ricky §6 assumed three.js z = -MediaPipe z (−I, components
// unchanged), which mirrors pitch and yaw (mirror semantics). Live check decides; one line to flip.
export function mpToView(q) {
  return new THREE.Quaternion(-q.x, -q.y, q.z, q.w);
}

// Hand turn angle (rad) -> model turn angle (rad): soft dead-zone, then x1.5 past ~8 deg.
export function tiltBoost(theta) {
  const dz = V2.TILT_DEADZONE_DEG * D2R;
  const from = V2.TILT_GAIN_FROM_DEG * D2R;
  return Math.max(0, theta - dz) + (V2.TILT_GAIN - 1) * Math.max(0, theta - from);
}

// Axis-angle of a quaternion, shortest way round. -> { axis: Vector3, angle >= 0 }
function axisAngle(q) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  const angle = 2 * Math.atan2(s, w);
  return { axis: s > 1e-12 ? new THREE.Vector3(x / s, y / s, z / s) : new THREE.Vector3(1, 0, 0), angle };
}

function quatAngle(a, b) {
  const d = Math.min(1, Math.abs(a.dot(b)));
  return 2 * Math.acos(d);
}

// How far the model's up axis tips toward (+) / away from (−) the viewer, radians.
function pitchOf(q) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  return Math.asin(THREE.MathUtils.clamp(up.z, -1, 1));
}

// Soft pitch limit, in place: past the knee the tip eases toward `limit` and never passes it.
// Spin about the vertical and roll in the screen plane leave the up axis' z alone, so they stay free.
function limitPitch(q, limit) {
  const knee = Math.min(V2.TILT_PITCH_KNEE_DEG * D2R, limit * 0.75);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const phi = Math.asin(THREE.MathUtils.clamp(up.z, -1, 1));
  const a = Math.abs(phi);
  if (a <= knee) return q;
  const w = limit - knee;
  const want = knee + w * Math.tanh((a - knee) / w);
  const axis = new THREE.Vector3().crossVectors(up, AXIS_Z);
  if (axis.lengthSq() < 1e-12) axis.copy(AXIS_X); else axis.normalize();
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, -Math.sign(phi) * (a - want)));
  return q;
}

// Palms facing each other (Ricky §5): both normals mostly sideways and opposed. Two hands with
// the same handedness label (a mislabel) can't be told palm from back, so only "sideways" counts.
function palmsFacing(a, b) {
  const na = handPalmNormal(a);
  const nb = handPalmNormal(b);
  if (!na || !nb) return false;
  if (Math.abs(na[0]) <= V2.CLAP_FACING_NX || Math.abs(nb[0]) <= V2.CLAP_FACING_NX) return false;
  if (a.handedness && a.handedness === b.handedness) return true;
  return na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] < V2.CLAP_FACING_DOT;
}

// Wrist-to-wrist span in palms from RAW landmarks when present (clap timing must not be smoothed).
function rawSpan(a, b, aspect) {
  const la = a.rawLandmarks ?? a.landmarks;
  const lb = b.rawLandmarks ?? b.landmarks;
  if (!la?.[0] || !lb?.[0] || !la[9] || !lb[9]) return 0;
  return handSpan({ landmarks: la }, { landmarks: lb }, aspect);
}

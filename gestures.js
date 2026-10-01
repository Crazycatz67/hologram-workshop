import { gunFeatures, isGun } from './gunPose.js';

// CONTRACT (pointer arbitration, added 2026-10-01; every new argument is optional and the
// defaults reproduce the old behaviour exactly, so hands.js, the labs and tests are unchanged
// unless they opt in):
//   pointerState(worldLandmarks, gesture) -> { gun: boolean, rejectedBy: string | null }
//     gunPose.js's pointer ("finger gun") check for ONE hand, on MediaPipe world landmarks
//     (metres). gun is false with rejectedBy 'no-hand' when there are no usable world landmarks.
//   isFistLike(gesture, landmarks, aspect = 1, { pointer, worldLandmarks } = {}) -> boolean
//     pointer: a precomputed pointerState() for this hand (preferred: compute once per frame).
//     worldLandmarks: used to compute it here when `pointer` is not given.
//     Neither given -> exactly the pre-2026-10-01 rule.
//   pinch(landmarks, aspect, { threshold, gesture, pointer, worldLandmarks }) -> as before;
//     pointer/worldLandmarks are passed through to isFistLike, so a pointer never blocks a pinch.
//   annotateHand(hand, aspect) -> hand, with hand.pointer, hand.pinch, hand.fistLike set.
//     The per-frame hand building hologram.js does; exported so test.js replays the same code.

export const LANDMARK = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_TIP: 20
};

// Measured against a real hand 2026-09-05: a deliberate pinch reads ~0.15, so 0.4 was
// far too loose and left a wide band where a closed fist also qualified.
export const PINCH_THRESHOLD = 0.25;

// A fist is "curled" when most non-thumb fingertips sit close to the wrist. Measured
// against a real hand: an open/pinching hand's fingers reach out past ~1.0-1.2 palm
// lengths; a genuinely curled fist's sit under ~0.9. The thumb is excluded — it behaves
// too differently (it doesn't curl the same way the other four do) to be part of a
// single shared threshold.
const CURL_THRESHOLD = 0.9;

// Landmark x and y are each normalized against their own axis, so on a 16:9 frame a
// horizontal gap reads ~1.8x shorter than the same gap measured vertically. Undo that
// before comparing any two distances.
function distance(a, b, aspect) {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

// Exported for a second purpose beyond normalizing the ratios above: since it's a raw,
// un-normalized 2D length, it also shrinks and grows with the hand's actual distance from
// the camera — closer reads bigger, farther reads smaller, ordinary perspective. That
// makes its own frame-to-frame change a usable depth proxy for push/pull, and one that
// doesn't depend on MediaPipe's own z-coordinate, which the roadmap already flags as
// noisier than x/y.
export function palmLength(landmarks, aspect) {
  return distance(landmarks[LANDMARK.WRIST], landmarks[LANDMARK.MIDDLE_MCP], aspect);
}

// Pinch is not in MediaPipe's canned gesture set, so it is measured here: the thumb-to-index
// gap divided by the hand's own palm length. Dividing by palm length is what makes this work
// across people — a small hand and a large hand pinch at the same ratio, and so does one hand
// held near the camera versus far from it.
//
// `gesture` is the recognizer's own classification. When it says Closed_Fist, that wins:
// the two readings are otherwise computed independently and both fire at once on a fist.
//
// A previous version also rejected a pinch whose thumb-index midpoint sat too close to the
// wrist ("reach"), to catch a curled fist reading as a pinch. Removed 2026-09-05: reach is
// a 2D-projected distance, and a real pinch performed facing the camera dead-on foreshortens
// in exactly the same way a curled fist does — the metric could not actually tell them apart
// across viewing angles, it just happened to on the one angle it was tuned against. Fixed on
// a real hand: facing the camera, a genuine pinch measured as "curled" and silently failed.
// `isFistShape()` below is the replacement — it targets the actual fist shape instead.
export function pinch(landmarks, aspect = 1, { threshold = PINCH_THRESHOLD, gesture = null, pointer, worldLandmarks } = {}) {
  const thumb = landmarks[LANDMARK.THUMB_TIP];
  const index = landmarks[LANDMARK.INDEX_TIP];
  const palm = palmLength(landmarks, aspect);

  if (palm <= 0) return { ratio: Infinity, pinching: false, rejectedBy: 'no-palm' };

  const ratio = distance(thumb, index, aspect) / palm;
  const rejectedBy = isFistLike(gesture, landmarks, aspect, { pointer, worldLandmarks }) ? 'fist' : null;

  return { ratio, pinching: ratio < threshold && rejectedBy === null, rejectedBy };
}

// How far each fingertip sits from the wrist, in palm lengths. Useful for telling an
// extended hand from a balled one, and for calibrating thresholds against real hands.
export function fingerReach(landmarks, aspect = 1) {
  const wrist = landmarks[LANDMARK.WRIST];
  const palm = palmLength(landmarks, aspect);
  if (palm <= 0) return null;
  const of = (i) => +(distance(landmarks[i], wrist, aspect) / palm).toFixed(2);
  return {
    thumb: of(LANDMARK.THUMB_TIP),
    index: of(LANDMARK.INDEX_TIP),
    middle: of(LANDMARK.MIDDLE_TIP),
    ring: of(LANDMARK.RING_TIP),
    pinky: of(LANDMARK.PINKY_TIP)
  };
}

// Geometric fist detection, independent of hand orientation: true when at least 3 of the
// 4 non-thumb fingertips sit close to the wrist. Built as a supplement to MediaPipe's own
// Closed_Fist classification after finding on a real hand that Closed_Fist does not fire
// reliably in every hand orientation — a fist held knuckles-toward-camera ("punching" the
// camera) went unrecognized, presumably because the classifier's training skews toward
// palm-facing-camera poses. Curl, measured this way, does not care which way the hand
// is turned.
//
// On its own this over-triggers: a thumbs-up and a loosely-closed hand both curl 3+
// non-thumb fingertips too, so both were registering as a fist and grabbing the object
// when live-tested. isFistLike() below is what should actually be called — this stays
// exported for that and for fingerReach-style diagnostics.
export function isFistShape(landmarks, aspect = 1) {
  const reach = fingerReach(landmarks, aspect);
  if (!reach) return false;
  const curled = [reach.index, reach.middle, reach.ring, reach.pinky].filter((r) => r < CURL_THRESHOLD).length;
  return curled >= 3;
}

// The actual "should this count as a grabbing fist" check. MediaPipe's classifier wins
// when it has a confident opinion either way: Closed_Fist counts, and any other specific
// label (Thumb_Up, Open_Palm, ...) means it does NOT, full stop — isFistShape is only
// consulted when the classifier couldn't confidently label the pose at all ('None'),
// which is exactly the punch-orientation gap it exists to backstop. Trusting a confident
// alternative label over the geometric guess is what stops a thumbs-up or a loosely
// closed hand from being read as a grab.
//
// Pointer arbitration (live probe 2026-10-01): a pointer (index out, the other three curled)
// labelled None was read as a grabbing fist on 100% of frames, because isFistShape counts the
// three curled fingers in 2D, and aimed at the camera the index foreshortens into a fourth.
// A 2D image cannot separate the two, so the 3D pointer check (gunPose.js, world landmarks)
// decides first: a pointer is never a fist. A real fist cannot pass it: on the owner's hand
// a fist's index bends 97-109 deg with reach 0.60-0.88, the pointer's <= 25 deg / >= 1.81,
// against limits of 45 deg / 1.35. Closed_Fist still wins outright (isGun vetoes that label
// anyway, so the two can never disagree).
export function isFistLike(gesture, landmarks, aspect = 1, { pointer, worldLandmarks } = {}) {
  if (gesture === 'Closed_Fist') return true;
  const p = pointer ?? (worldLandmarks ? pointerState(worldLandmarks, gesture) : null);
  if (p?.gun) return false;
  if (gesture === 'None' || gesture == null) return isFistShape(landmarks, aspect);
  return false;
}

// One hand's pointer state, in the small shape the hand object carries (hand.pointer). The
// full feature set stays in gunPose.js; the pages only need the verdict and, for the live
// readout, the first failed check.
export function pointerState(worldLandmarks, gesture = null) {
  const { gun, rejectedBy } = isGun(gunFeatures(worldLandmarks), { gesture });
  return { gun, rejectedBy };
}

// The per-frame hand reading the live page does, in one place so the pointer is computed
// once per hand per frame and the regression suite replays exactly this. hand.worldLandmarks
// comes from handTracker.js toHands(); landmarks should already be smoothed (the pointer uses
// the raw world landmarks, which smoothLandmarks.js does not filter, as the calibration did).
export function annotateHand(hand, aspect = 1) {
  hand.pointer = pointerState(hand.worldLandmarks, hand.gesture);
  hand.pinch = pinch(hand.landmarks, aspect, { gesture: hand.gesture, pointer: hand.pointer });
  hand.fistLike = isFistLike(hand.gesture, hand.landmarks, aspect, { pointer: hand.pointer });
  return hand;
}

// Distance between the two hands, in the same palm-relative units as pinch(), so it is
// comparable across users. Phase 4 uses the change in this for two-hand scale.
//
// `palm` overrides the live average palm length as the normaliser. Two-hand scale passes a
// held reference (BUGS #31): the live palm length is the noisiest part of this ratio, and
// while the hands hold one pinch the normaliser only needs to track real depth change.
export function handSpan(handA, handB, aspect = 1, { palm: palmOverride = null } = {}) {
  const palm = palmOverride ?? (palmLength(handA.landmarks, aspect) + palmLength(handB.landmarks, aspect)) / 2;
  if (palm <= 0) return 0;
  return distance(handA.landmarks[LANDMARK.WRIST], handB.landmarks[LANDMARK.WRIST], aspect) / palm;
}

// Signed angle of the line between the two hands. No longer used for the primary rotate
// gesture (see handTwist) but kept — a future two-hand gesture may still want it.
export function handAngle(handA, handB, aspect = 1) {
  const a = handA.landmarks[LANDMARK.WRIST];
  const b = handB.landmarks[LANDMARK.WRIST];
  return Math.atan2(b.y - a.y, (b.x - a.x) * aspect);
}

// Signed angle, in the camera's own image plane, of the line across a single hand's
// knuckles (index MCP to pinky MCP). Twisting your wrist like turning a doorknob rotates
// this line visibly in the 2D image even though the motion is really a 3D rotation of the
// forearm — using knuckles rather than fingertips is what keeps this trackable while the
// hand is held in a fist, since fingertips curl out of view but knuckles stay put. Feeds
// the single-hand grab-and-twist rotate gesture: the manipulator tracks the frame-to-frame
// change in this angle while a hand is gripping, not its absolute value.
export function handTwist(landmarks, aspect = 1) {
  const a = landmarks[LANDMARK.INDEX_MCP];
  const b = landmarks[LANDMARK.PINKY_MCP];
  return Math.atan2(b.y - a.y, (b.x - a.x) * aspect);
}

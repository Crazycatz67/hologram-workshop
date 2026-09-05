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

function palmLength(landmarks, aspect) {
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
export function pinch(landmarks, aspect = 1, { threshold = PINCH_THRESHOLD, gesture = null } = {}) {
  const thumb = landmarks[LANDMARK.THUMB_TIP];
  const index = landmarks[LANDMARK.INDEX_TIP];
  const palm = palmLength(landmarks, aspect);

  if (palm <= 0) return { ratio: Infinity, pinching: false, rejectedBy: 'no-palm' };

  const ratio = distance(thumb, index, aspect) / palm;
  const rejectedBy = gesture === 'Closed_Fist' || isFistShape(landmarks, aspect) ? 'fist' : null;

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
export function isFistShape(landmarks, aspect = 1) {
  const reach = fingerReach(landmarks, aspect);
  if (!reach) return false;
  const curled = [reach.index, reach.middle, reach.ring, reach.pinky].filter((r) => r < CURL_THRESHOLD).length;
  return curled >= 3;
}

// Distance between the two hands, in the same palm-relative units as pinch(), so it is
// comparable across users. Phase 4 uses the change in this for two-hand scale.
export function handSpan(handA, handB, aspect = 1) {
  const palm = (palmLength(handA.landmarks, aspect) + palmLength(handB.landmarks, aspect)) / 2;
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

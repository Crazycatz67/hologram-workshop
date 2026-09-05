export const LANDMARK = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20
};

// Measured against a real hand 2026-09-05: a deliberate pinch reads ~0.15, so 0.4 was
// far too loose and left a wide band where a closed fist also qualified.
export const PINCH_THRESHOLD = 0.25;

// How far the pinch point must sit from the wrist, in palm lengths. A real pinch happens
// out at the end of the fingers; in a fist every tip curls back toward the palm, which is
// what made a fist read as a pinch when the back of the hand faced the camera.
export const MIN_PINCH_REACH = 1.15;

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
export function pinch(landmarks, aspect = 1, { threshold = PINCH_THRESHOLD, gesture = null } = {}) {
  const wrist = landmarks[LANDMARK.WRIST];
  const thumb = landmarks[LANDMARK.THUMB_TIP];
  const index = landmarks[LANDMARK.INDEX_TIP];
  const palm = palmLength(landmarks, aspect);

  if (palm <= 0) return { ratio: Infinity, reach: 0, pinching: false, rejectedBy: 'no-palm' };

  const ratio = distance(thumb, index, aspect) / palm;

  const midpoint = { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
  const reach = distance(midpoint, wrist, aspect) / palm;

  let rejectedBy = null;
  if (gesture === 'Closed_Fist') rejectedBy = 'fist';
  else if (reach < MIN_PINCH_REACH) rejectedBy = 'curled';

  return { ratio, reach, pinching: ratio < threshold && rejectedBy === null, rejectedBy };
}

// How far each fingertip sits from the wrist, in palm lengths. Useful for telling an
// extended hand from a balled one, and for calibrating MIN_PINCH_REACH against real hands.
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

// Distance between the two hands, in the same palm-relative units as pinch(), so it is
// comparable across users. Phase 4 uses the change in this for two-hand scale.
export function handSpan(handA, handB, aspect = 1) {
  const palm = (palmLength(handA.landmarks, aspect) + palmLength(handB.landmarks, aspect)) / 2;
  if (palm <= 0) return 0;
  return distance(handA.landmarks[LANDMARK.WRIST], handB.landmarks[LANDMARK.WRIST], aspect) / palm;
}

// Signed angle of the line between the two hands. Phase 4 uses the frame-to-frame delta
// for two-hand rotation.
export function handAngle(handA, handB, aspect = 1) {
  const a = handA.landmarks[LANDMARK.WRIST];
  const b = handB.landmarks[LANDMARK.WRIST];
  return Math.atan2(b.y - a.y, (b.x - a.x) * aspect);
}

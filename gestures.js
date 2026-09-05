export const LANDMARK = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9
};

export const PINCH_THRESHOLD = 0.4;

// Landmark x and y are each normalized against their own axis, so on a 16:9 frame a
// horizontal gap reads ~1.8x shorter than the same gap measured vertically. Undo that
// before comparing any two distances.
function distance(a, b, aspect) {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

// Pinch is not in MediaPipe's canned gesture set, so it is measured here: the thumb-to-index
// gap divided by the hand's own palm length. Dividing by palm length is what makes this
// work across people — a small hand and a large hand pinch at the same ratio, and so does
// one hand held near the camera versus far from it.
export function pinch(landmarks, aspect = 1, threshold = PINCH_THRESHOLD) {
  const gap = distance(landmarks[LANDMARK.THUMB_TIP], landmarks[LANDMARK.INDEX_TIP], aspect);
  const palm = distance(landmarks[LANDMARK.WRIST], landmarks[LANDMARK.MIDDLE_MCP], aspect);
  const ratio = palm > 0 ? gap / palm : Infinity;

  // Raw per-frame threshold with no hysteresis, so it will chatter when held right at the
  // boundary. Phase 4 puts the ASL project's stabilizer between this and any action.
  return { ratio, pinching: ratio < threshold };
}

// Distance between the two hands, in the same palm-relative units as pinch(), so it is
// comparable across users. Phase 4 uses the change in this for two-hand scale.
export function handSpan(handA, handB, aspect = 1) {
  const a = handA.landmarks[LANDMARK.WRIST];
  const b = handB.landmarks[LANDMARK.WRIST];
  const palmA = distance(handA.landmarks[LANDMARK.WRIST], handA.landmarks[LANDMARK.MIDDLE_MCP], aspect);
  const palmB = distance(handB.landmarks[LANDMARK.WRIST], handB.landmarks[LANDMARK.MIDDLE_MCP], aspect);
  const palm = (palmA + palmB) / 2;
  return palm > 0 ? distance(a, b, aspect) / palm : 0;
}

// Signed angle of the line between the two hands. Phase 4 uses the frame-to-frame delta
// for two-hand rotation.
export function handAngle(handA, handB, aspect = 1) {
  const a = handA.landmarks[LANDMARK.WRIST];
  const b = handB.landmarks[LANDMARK.WRIST];
  return Math.atan2(b.y - a.y, (b.x - a.x) * aspect);
}

// Exponential smoothing on raw landmark positions, applied once right after tracking reads
// a frame — before pinch/fist detection, the manipulator, or the ghost hands ever see the
// data. Reported live: bending the thumb back made the rendered hand look "broken," and
// grabbing sometimes produced "rubber-band"-like jumps. MediaPipe's landmark noise (worst
// on the thumb — see ROADMAP.md Phase 1) was previously going straight into both the visual
// skeleton and the gesture math unfiltered; this smooths it once for everything downstream.
//
// Matched frame-to-frame by nearest wrist position, not by MediaPipe's handedness label.
// A first version keyed by handedness and had a real bug: when MediaPipe misclassified two
// hands as the same handedness (which happens — low confidence, hands crossing, a hand seen
// from the back), both hands smoothed toward the SAME stored state and their positions
// bled into each other. Array index would have the same class of problem if MediaPipe ever
// reorders which hand comes first. Physical position can't teleport between frames, so it's
// the one signal that's actually reliable to match on.

const ALPHA = 0.5; // 1.0 = no smoothing (raw passthrough); lower = smoother but more lag

// Beyond this normalized-frame distance, the nearest previous hand is probably a different
// hand entirely (or this one just entered), not the same hand having moved — start fresh
// rather than smooth toward an unrelated position. An untuned guess, like every other
// threshold in this file started as; a hand moving faster than this in one frame just gets
// that one frame unsmoothed (safe fallback) rather than corrupted, so guessing wrong here
// is low-risk, but real-hand tuning would still make it more accurate.
const MAX_MATCH_DISTANCE = 0.35;

let previousHands = []; // [{ landmarks }], most recent frame's post-smoothing state

export function smoothHandLandmarks(hands) {
  const claimed = new Set();

  for (const hand of hands) {
    const wrist = hand.landmarks[0];
    let bestIndex = -1;
    let bestDist = Infinity;

    for (let i = 0; i < previousHands.length; i++) {
      if (claimed.has(i)) continue;
      const prevWrist = previousHands[i].landmarks[0];
      const d = Math.hypot(wrist.x - prevWrist.x, wrist.y - prevWrist.y);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }

    if (bestIndex === -1 || bestDist > MAX_MATCH_DISTANCE) {
      // No usable match: a genuinely new hand, or the closest candidate is implausibly far
      // to be the same one. Pass this frame through unsmoothed rather than drag it toward
      // an unrelated hand's position.
      hand.landmarks = hand.landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    } else {
      claimed.add(bestIndex);
      const prev = previousHands[bestIndex].landmarks;
      hand.landmarks = hand.landmarks.map((p, i) => ({
        x: prev[i].x + (p.x - prev[i].x) * ALPHA,
        y: prev[i].y + (p.y - prev[i].y) * ALPHA,
        z: prev[i].z + (p.z - prev[i].z) * ALPHA
      }));
    }
  }

  previousHands = hands.map((h) => ({ landmarks: h.landmarks }));
}

export function resetLandmarkSmoothing() {
  previousHands = [];
}

// Exponential smoothing on raw landmark positions, applied once right after tracking reads
// a frame — before pinch/fist detection, the manipulator, or the ghost hands ever see the
// data. Reported live: bending the thumb back made the rendered hand look "broken," and
// grabbing sometimes produced "rubber-band"-like jumps. MediaPipe's landmark noise (worst
// on the thumb — see ROADMAP.md Phase 1) was previously going straight into both the visual
// skeleton and the gesture math unfiltered; this smooths it once for everything downstream.
//
// Keyed by handedness (Left/Right) rather than array index, since that stays consistent
// frame-to-frame for a continuously-tracked hand in a way array position doesn't.

const ALPHA = 0.5; // 1.0 = no smoothing (raw passthrough); lower = smoother but more lag

const previous = new Map();

export function smoothHandLandmarks(hands) {
  const seenKeys = new Set();

  for (const hand of hands) {
    const key = hand.handedness;
    seenKeys.add(key);
    const prev = previous.get(key);

    if (!prev) {
      previous.set(key, hand.landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z })));
      continue;
    }

    hand.landmarks = hand.landmarks.map((p, i) => {
      const smoothed = {
        x: prev[i].x + (p.x - prev[i].x) * ALPHA,
        y: prev[i].y + (p.y - prev[i].y) * ALPHA,
        z: prev[i].z + (p.z - prev[i].z) * ALPHA
      };
      prev[i] = smoothed;
      return smoothed;
    });
  }

  // Drop state for a hand that's no longer present, so it doesn't smooth toward a stale
  // position if that hand (or the same handedness slot) reappears later.
  for (const key of previous.keys()) {
    if (!seenKeys.has(key)) previous.delete(key);
  }
}

export function resetLandmarkSmoothing() {
  previous.clear();
}

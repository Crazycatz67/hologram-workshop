// Landmark smoothing, applied once right after tracking reads a frame — before pinch/fist
// detection, the manipulator, or the ghost hands ever see the data. Reported live: bending
// the thumb back made the rendered hand look "broken," and grabbing sometimes produced
// "rubber-band"-like jumps. MediaPipe's landmark noise (worst on the thumb) was going straight
// into both the visual skeleton and the gesture math unfiltered; this smooths it once for
// everything downstream.
//
// ONE EURO FILTER (Casiez, Roussel & Vogel, CHI 2012), replacing a fixed per-call EMA
// (2026-09-29, BUGS #12). The old filter blended 50% per CALL, which has two problems:
//   1. Frame-rate dependent: at 8-12 fps a 50%-per-call blend is a ~60-120 ms lag, which
//      halved a fast clap's measured closing speed and made it never fire below ~15 fps.
//   2. Equally laggy at rest and in motion: still hands kept half their jitter, fast hands
//      lagged a full frame.
// One Euro is a low-pass filter whose cutoff rises with speed: cutoff = MIN_CUTOFF +
// BETA * |velocity|. A still hand gets a low cutoff (heavy smoothing, jitter gone); a fast hand
// gets a high one (almost no lag). Everything is computed from REAL elapsed time (the frame
// timestamp hologram.js passes in), so it means the same thing at 8 fps and 60 fps.
//
// Tuned with docs/lab/gestures/smoothing-lab.html (synthetic hands, 0.002 uniform jitter,
// which is the figure measured against real MediaPipe earlier): rest jitter RMS falls ~3x
// vs raw and lag on a clap-speed hand is a few ms. Tuning recipe from the paper: lower
// MIN_CUTOFF until a still hand stops shaking, then raise BETA until fast moves stop lagging.
// Synthetic noise is not the real spectrum, so these want a live check (see BUGS #12).
//
// Matched frame-to-frame by nearest wrist position, not by MediaPipe's handedness label.
// A first version keyed by handedness and had a real bug: when MediaPipe misclassified two
// hands as the same handedness (which happens — low confidence, hands crossing, a hand seen
// from the back), both hands smoothed toward the SAME stored state and their positions
// bled into each other. Array index would have the same class of problem if MediaPipe ever
// reorders which hand comes first. Physical position can't teleport between frames, so it's
// the one signal that's actually reliable to match on.

const MIN_CUTOFF = 1.2;   // Hz, cutoff for a still hand (lower = smoother at rest)
const BETA = 25;          // Hz per (normalized frame unit / s) of landmark speed
const D_CUTOFF = 1.0;     // Hz, cutoff for the speed estimate itself
const Z_MIN_CUTOFF = 0.6; // MediaPipe's z is the noisiest axis: filter it harder at rest

// Beyond this normalized-frame distance, the nearest previous hand is probably a different
// hand entirely (or this one just entered), not the same hand having moved — start fresh
// rather than smooth toward an unrelated position.
const MAX_MATCH_DISTANCE = 0.35;

// Lost-tracking recovery: a hand that drops out (occlusion, motion blur, a missed detection)
// keeps its filter state this long, and may be re-acquired within a larger radius, since it
// kept moving while unseen. Past the hold it is forgotten.
const HOLD_MS = 250;
const RECOVER_MATCH_DISTANCE = 0.5;

// A gap this long means the hand's history is stale even if it matches (tab backgrounded,
// camera stall): restart rather than filter across it.
const MAX_GAP_MS = 500;

let tracks = []; // [{ landmarks, deriv, lastSeen }]

const alphaFor = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

function freshTrack(landmarks, now) {
  return {
    landmarks: landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
    deriv: landmarks.map(() => ({ x: 0, y: 0, z: 0 })),
    lastSeen: now
  };
}

// One Euro step for one landmark. Speed is taken as the 2D magnitude of the (filtered)
// velocity so x and y share one cutoff: filtering them with different cutoffs would bend
// the hand's shape during diagonal motion.
function filterPoint(prev, d, p, dt) {
  const aD = alphaFor(D_CUTOFF, dt);
  const z = p.z ?? 0;
  d.x += ((p.x - prev.x) / dt - d.x) * aD;
  d.y += ((p.y - prev.y) / dt - d.y) * aD;
  d.z += ((z - prev.z) / dt - d.z) * aD;
  const speed = Math.hypot(d.x, d.y);
  const a = alphaFor(MIN_CUTOFF + BETA * speed, dt);
  const aZ = alphaFor(Z_MIN_CUTOFF + BETA * Math.hypot(speed, d.z), dt);
  return {
    x: prev.x + (p.x - prev.x) * a,
    y: prev.y + (p.y - prev.y) * a,
    z: prev.z + (z - prev.z) * aZ
  };
}

// timestampMs: the frame's time (hologram.js passes the camera frame time). Defaults to
// performance.now() so a caller without one keeps working.
export function smoothHandLandmarks(hands, timestampMs = performance.now()) {
  const now = timestampMs;
  // Forget tracks that have been unseen past the hold.
  tracks = tracks.filter((tr) => now - tr.lastSeen <= HOLD_MS && now >= tr.lastSeen);
  const claimed = new Set();
  const next = [];

  for (const hand of hands) {
    const wrist = hand.landmarks[0];
    let bestIndex = -1;
    let bestDist = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      if (claimed.has(i)) continue;
      const w = tracks[i].landmarks[0];
      const d = Math.hypot(wrist.x - w.x, wrist.y - w.y);
      // A track seen last frame must be close; one that has been missing a while may have
      // moved further while unseen.
      const limit = tracks[i].missed ? RECOVER_MATCH_DISTANCE : MAX_MATCH_DISTANCE;
      if (d <= limit && d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }

    let track;
    if (bestIndex === -1) {
      // A genuinely new hand, or nothing plausible to match: pass this frame through
      // unsmoothed rather than drag it toward an unrelated hand's position.
      track = freshTrack(hand.landmarks, now);
    } else {
      claimed.add(bestIndex);
      const prev = tracks[bestIndex];
      const gap = now - prev.lastSeen;
      if (!(gap > 0) || gap > MAX_GAP_MS) {
        // Same timestamp twice (nothing new to filter) or a stale history: restart.
        track = gap === 0 ? prev : freshTrack(hand.landmarks, now);
      } else {
        const dt = gap / 1000;
        const out = hand.landmarks.map((p, i) => filterPoint(prev.landmarks[i], prev.deriv[i], p, dt));
        track = { landmarks: out, deriv: prev.deriv, lastSeen: now };
      }
    }
    track.missed = false;
    hand.landmarks = track.landmarks.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    next.push(track);
  }

  // Unclaimed tracks are held (not output) so a hand that blinks out can resume smoothly.
  for (let i = 0; i < tracks.length; i++) {
    if (!claimed.has(i)) {
      tracks[i].missed = true;
      next.push(tracks[i]);
    }
  }
  tracks = next;
}

export function resetLandmarkSmoothing() {
  tracks = [];
}

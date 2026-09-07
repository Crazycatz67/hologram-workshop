// Hysteresis, ported in spirit from the ASL project's stabilizer: a gesture has to hold
// for a while before it counts, and has to be absent for longer before it stops.
//
// Time-based, not frame-count-based. The first version counted CALLS ("3 frames to enter"),
// which assumes update() fires at a roughly constant rate. It doesn't: real webcam tracking
// drops frames under load and the gap between calls varies, a risk this file's own original
// comment already named. Live testing surfaced the consequence directly — move getting
// "stuck", tilt "breaking out" of a held gesture, explode getting "stuck at times" — all
// different symptoms of the same cause: "3 frames" is 50ms on a good run and 300ms on a
// choppy one, so how forgiving the hysteresis actually is keeps changing underneath the
// user without anything else having changed. Measuring the real elapsed time between calls
// (already threaded through as a timestamp everywhere else in this pipeline, see
// manipulator.js) makes the hysteresis mean the same thing regardless of frame rate.
//
// The two thresholds are still deliberately asymmetric. Entering needs enough time to ignore
// a single noisy classification, but staying in needs *more*, because losing a grab halfway
// through a drag is far worse than starting one a moment late.
export function createStabilizer({ enterMs = 90, exitMs = 220 } = {}) {
  let state = false;
  let agreeingSince = null;

  return {
    // timestampMs: defaults to performance.now() so a caller that never passes one (existing
    // tests, anything not on the live tracking path) keeps working exactly as before.
    //
    // enterOverrideMs: raises the bar for entering, for this call only, without touching the
    // instance's own configured enterMs. Exists for mode-switch rigidity (see
    // manipulator.js): a gesture should need only its normal, already-tuned confirmation to
    // start from idle, but a LONGER, harder-to-reach confirmation to interrupt some OTHER
    // gesture that's already actively engaged — a single misread frame shouldn't be able to
    // hijack an in-progress grab into transform. Passing a bigger number here for exactly
    // that situation, and leaving it out otherwise, gets both behaviors from one stabilizer
    // instance rather than needing the caller to juggle two.
    update(input, timestampMs = performance.now(), enterOverrideMs = null) {
      // Coerced rather than compared with ===: a truthy non-boolean would otherwise never
      // equal `state` and every call would count as disagreement, which fires the gesture
      // off a single spike.
      const raw = Boolean(input);

      if (raw === state) {
        agreeingSince = null;
        return state;
      }

      if (agreeingSince === null) agreeingSince = timestampMs;
      const held = timestampMs - agreeingSince;
      const needed = raw ? (enterOverrideMs ?? enterMs) : exitMs;
      if (held >= needed) {
        state = raw;
        agreeingSince = null;
      }
      return state;
    },

    get value() {
      return state;
    },

    reset() {
      state = false;
      agreeingSince = null;
    }
  };
}

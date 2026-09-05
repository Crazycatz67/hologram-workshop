// Hysteresis, ported in spirit from the ASL project's stabilizer: a gesture has to hold
// for several frames before it counts, and has to be absent for longer before it stops.
//
// The two thresholds are deliberately asymmetric. Entering needs enough frames to ignore a
// single noisy classification, but staying in needs *more*, because losing a grab halfway
// through a drag is far worse than starting one a frame late — and MediaPipe drops the odd
// frame whenever a hand turns or moves fast.
export function createStabilizer({ enter = 3, exit = 6 } = {}) {
  let state = false;
  let agreeing = 0;

  return {
    update(input) {
      // Coerced rather than compared with ===: a truthy non-boolean would otherwise never
      // equal `state` and every frame would count as disagreement, which fires the gesture
      // off a single spike.
      const raw = Boolean(input);

      if (raw === state) {
        agreeing = 0;
        return state;
      }

      agreeing++;
      const needed = raw ? enter : exit;
      if (agreeing >= needed) {
        state = raw;
        agreeing = 0;
      }
      return state;
    },

    get value() {
      return state;
    },

    reset() {
      state = false;
      agreeing = 0;
    }
  };
}

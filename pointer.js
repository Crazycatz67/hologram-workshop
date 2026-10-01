// The finger-gun pointer: a remote-style cursor you aim with one hand and click with the
// other hand's pinch (owner decisions and live probe, plans/platform/ROADMAP.md 2026-10-01).
// Pure logic: no DOM, no three.js, so test.js can replay it frame by frame.
//
// CONTRACT
//   createEngagement({ enterY, exitY }) -> { update(hands) -> hands, reset() }
//     Sets hand.engaged on each hand. A hand is engaged ("raised") while its wrist is above a
//     horizontal line in the camera image: it engages when wrist y < enterY and disengages
//     when wrist y > exitY (image units, 0 = top, 1 = bottom; hysteresis between the two).
//     Lowered hands are at rest: the manipulator and the pointer ignore them.
//   palmCentroid(landmarks) -> { x, y }   mean of landmarks 0, 5, 9, 13, 17 (image units).
//   prismGain(speed) -> gain   speed in frame-heights per second (aspect-corrected).
//   createPointer(options) -> pointer
//     pointer.update(hands, aspect, tMs) -> click event or null. hands: this camera frame's
//       hands, already through gestures.annotateHand (hand.pointer, hand.pinch) and
//       createEngagement (hand.engaged; a hand without it counts as engaged).
//     pointer.mouseMove(ndcX, ndcY, tMs) / pointer.mouseLeave() / pointer.mouseClick(ndcX, ndcY, tMs)
//       The mouse fallback, fed through the same state. mouseClick returns a click event.
//     pointer.tick(tMs)   display-rate step: ends a clutch hold after CLUTCH_SHOW_MS.
//     pointer.reset()
//     pointer.state -> { mode: 'off' | 'aim' | 'clutch', source: 'hand' | 'mouse' | null,
//                        x, y (NDC, -1..1, y up), aimHand (hand object or null) }
//     click event: { type: 'click', x, y (NDC, rewound), t, source }
//   Units: cursor in NDC (-1..1, y up, already mirrored like the ghost hands); time in ms.
//   Never throws on missing fields: a hand without landmarks is ignored.

export const ENGAGE_ENTER_Y = 0.88;
export const ENGAGE_EXIT_Y = 0.94;

// The line is low on purpose. Every existing gesture is made with the hands somewhere in the
// middle of the frame, and a webcam on a laptop sees a raised hand's wrist anywhere from
// mid-frame down to near the bottom edge. "Lowered" therefore means the wrist has dropped into
// the bottom ~6-12% of the image (or out of it: MediaPipe still reports landmarks past the
// edge). Not yet measured on the owner's hands: tune live, then record the numbers here.
const ENGAGE_MATCH_DIST = 0.2; // image units: farther than this from every previous wrist = a new hand

const PALM = [0, 5, 9, 13, 17];

// PRISM (Frees, Kessler & Kay 2007): scale cursor gain with hand speed, so slow hands get
// precision and fast hands get reach. Below MIN_SPEED the motion is treated as tremor and
// dropped (PRISM's "MinS"), which also keeps a still hand's residual tracking wander from
// creeping the cursor.
export const PRISM = {
  minSpeed: 0.02,  // frame heights / s
  slowSpeed: 0.05, // at or below: slowGain
  fastSpeed: 0.8,  // at or above: fastGain
  slowGain: 0.3,
  fastGain: 2.5
};
const SPEED_WINDOW_MS = 100; // speed is measured over this window, not frame to frame:
// one-frame differences are dominated by tracking noise and read a still hand as moving.

// Forming the pose moves the palm centroid by itself (fingers curl, the hand turns side-on)
// and the landmark filter is still catching up, so for this long after the pose is (re)entered
// the cursor re-anchors every frame instead of moving.
const SETTLE_MS = 150;
const CLUTCH_GRACE_MS = 100;  // a pose dropout shorter than this is not a clutch (tracking blips)
const CLUTCH_SHOW_MS = 1500;  // how long a frozen cursor stays visible before it hides

// Click = the other hand's pinch. Measured live (gun-lab, 2026-10-01): the aiming palm moves a
// median 3.6 px while the other hand pinches, less than its resting wander, so the click does
// not need to freeze the cursor. The rewind still removes what motion there is (Wolf et al.):
// the click lands where the cursor was REWIND_MS before the pinch was first seen.
export const REWIND_MS = 120;
const PINCH_RELEASE_RATIO = 0.35;  // pinch re-arms only once opened past this (gestures.js closes at 0.25)
const PINCH_REARM_MS = 60;         // ...for this long, so one noisy frame can't re-arm it
const CLICK_REFRACTORY_MS = 250;   // at most 4 clicks per second, whatever the tracking does
const HISTORY_MS = 400;

export function palmCentroid(landmarks) {
  let x = 0;
  let y = 0;
  for (const i of PALM) {
    x += landmarks[i].x;
    y += landmarks[i].y;
  }
  return { x: x / PALM.length, y: y / PALM.length };
}

export function prismGain(speed, p = PRISM) {
  if (!(speed >= p.minSpeed)) return 0;
  if (speed <= p.slowSpeed) return p.slowGain;
  if (speed >= p.fastSpeed) return p.fastGain;
  const t = (speed - p.slowSpeed) / (p.fastSpeed - p.slowSpeed);
  return p.slowGain + t * (p.fastGain - p.slowGain);
}

const clamp = (v) => Math.max(-1, Math.min(1, v));
const hasLandmarks = (h) => Array.isArray(h?.landmarks) && h.landmarks.length >= 18;

export function createEngagement({ enterY = ENGAGE_ENTER_Y, exitY = ENGAGE_EXIT_Y } = {}) {
  // Previous frame's wrists and their state. Hands are matched by nearest wrist rather than by
  // array index or handedness: MediaPipe reorders hands and sometimes labels both the same.
  let previous = [];
  return {
    update(hands) {
      const next = [];
      for (const h of hands) {
        if (!hasLandmarks(h)) continue;
        const w = h.landmarks[0];
        let best = null;
        let bestD = ENGAGE_MATCH_DIST;
        for (const p of previous) {
          const d = Math.hypot(p.x - w.x, p.y - w.y);
          if (d < bestD) { bestD = d; best = p; }
        }
        // Hysteresis: a known hand keeps its state inside the band; a new hand is judged
        // against the entry line, so a hand appearing in the band starts at rest.
        h.engaged = best ? (best.engaged ? w.y <= exitY : w.y < enterY) : w.y < enterY;
        next.push({ x: w.x, y: w.y, engaged: h.engaged });
      }
      previous = next;
      return hands;
    },
    reset() {
      previous = [];
    }
  };
}

export function createPointer({ prism = PRISM, rewindMs = REWIND_MS } = {}) {
  let mode = 'off';
  let source = null;
  let x = 0;
  let y = 0;
  let aimHand = null;
  let lastCentroid = null;   // image units, of the aim hand on the previous frame
  let lastGunT = -Infinity;
  let aimSince = -Infinity;
  let clutchSince = null;
  let samples = [];          // [{ t, cx, cy }] palm centroid, for speed
  let history = [];          // [{ t, x, y }] cursor, for the click rewind
  // The click hand's pinch: armed once it has been open; the first pinching frame clicks.
  let pinchArmed = false;
  let openSince = null;
  let wasPinching = false;
  let lastClickT = -Infinity;

  function record(t) {
    history.push({ t, x, y });
    while (history.length > 2 && history[0].t < t - HISTORY_MS) history.shift();
  }

  // Cursor position at time t (the newest sample at or before t).
  function cursorAt(t) {
    let best = history[0] ?? { x, y };
    for (const h of history) {
      if (h.t <= t) best = h;
      else break;
    }
    return best;
  }

  function anchor(c, t) {
    lastCentroid = c;
    samples = [{ t, cx: c.x, cy: c.y }];
  }

  function enterClutch(t) {
    if (mode !== 'aim' || source !== 'hand') return;
    mode = 'clutch';
    clutchSince = t;
    aimHand = null;
    lastCentroid = null;
  }

  function pickAimHand(guns) {
    if (guns.length === 1 || !lastCentroid) return guns[0];
    // Both hands pointing: keep the one that was aiming (nearest to its last palm).
    let best = guns[0];
    let bestD = Infinity;
    for (const g of guns) {
      const c = palmCentroid(g.landmarks);
      const d = Math.hypot(c.x - lastCentroid.x, c.y - lastCentroid.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  function resetPinch() {
    pinchArmed = false;
    openSince = null;
    wasPinching = false;
  }

  // Returns true on the frame a deliberate pinch starts.
  function pinchOnset(hand, t) {
    const pinching = hand.pinch?.pinching === true;
    const ratio = hand.pinch?.ratio;
    const open = !pinching && (Number.isFinite(ratio) ? ratio > PINCH_RELEASE_RATIO : true);
    if (open) {
      openSince ??= t;
      if (t - openSince >= PINCH_REARM_MS) pinchArmed = true;
    } else {
      openSince = null;
    }
    const onset = pinching && !wasPinching && pinchArmed;
    wasPinching = pinching;
    if (onset) pinchArmed = false;
    return onset;
  }

  return {
    get state() {
      return { mode, source, x, y, aimHand };
    },

    update(hands, aspect = 1, t = performance.now()) {
      const engaged = hands.filter((h) => hasLandmarks(h) && h.engaged !== false);
      const guns = engaged.filter((h) => h.pointer?.gun === true);

      if (guns.length) {
        const hand = pickAimHand(guns);
        const c = palmCentroid(hand.landmarks);
        lastGunT = t;
        if (mode !== 'aim' || source !== 'hand' || !lastCentroid) {
          // Entering the pose (or taking over from the mouse) re-anchors: the cursor stays
          // where it was and only later motion moves it. This is the clutch.
          mode = 'aim';
          source = 'hand';
          clutchSince = null;
          aimSince = t;
          anchor(c, t);
          resetPinch();
        } else if (t - aimSince < SETTLE_MS) {
          anchor(c, t);
        } else {
          samples.push({ t, cx: c.x, cy: c.y });
          while (samples.length > 2 && samples[1].t <= t - SPEED_WINDOW_MS) samples.shift();
          const s0 = samples[0];
          const span = (t - s0.t) / 1000;
          const speed = span > 0 ? Math.hypot((c.x - s0.cx) * aspect, c.y - s0.cy) / span : 0;
          const gain = prismGain(speed, prism);
          // Mirrored like the ghost hands: the image's x runs the other way to the screen's.
          // Image y runs down, NDC y runs up.
          x = clamp(x - (c.x - lastCentroid.x) * 2 * gain);
          y = clamp(y - (c.y - lastCentroid.y) * 2 * gain);
          lastCentroid = c;
        }
        aimHand = hand;
        record(t);
      } else if (mode === 'aim' && source === 'hand') {
        // A short dropout holds the cursor still (no motion, no click); a longer one clutches.
        if (t - lastGunT >= CLUTCH_GRACE_MS) enterClutch(t);
        else record(t);
      }

      if (mode !== 'aim' || source !== 'hand') {
        resetPinch();
        return null;
      }
      const clicker = engaged.find((h) => h !== aimHand && h.pointer?.gun !== true) ?? null;
      if (!clicker) {
        resetPinch();
        return null;
      }
      if (!pinchOnset(clicker, t) || t - lastClickT < CLICK_REFRACTORY_MS) return null;
      lastClickT = t;
      const at = cursorAt(t - rewindMs);
      // Put the cursor back where the click landed, so what you see is what was clicked.
      x = at.x;
      y = at.y;
      record(t);
      return { type: 'click', x, y, t, source: 'hand' };
    },

    mouseMove(ndcX, ndcY, t = performance.now()) {
      // Last input wins: moving the mouse takes over from a hand, and the next frame that
      // sees the pose takes it back (re-anchored, so the cursor does not jump).
      mode = 'aim';
      source = 'mouse';
      aimHand = null;
      lastCentroid = null;
      clutchSince = null;
      x = clamp(ndcX);
      y = clamp(ndcY);
      record(t);
    },

    mouseLeave() {
      if (source === 'mouse') mode = 'off';
    },

    mouseClick(ndcX, ndcY, t = performance.now()) {
      this.mouseMove(ndcX, ndcY, t);
      return { type: 'click', x, y, t, source: 'mouse' };
    },

    tick(t = performance.now()) {
      if (mode === 'clutch' && clutchSince !== null && t - clutchSince >= CLUTCH_SHOW_MS) {
        mode = 'off';
        clutchSince = null;
      }
    },

    reset() {
      mode = 'off';
      source = null;
      aimHand = null;
      lastCentroid = null;
      clutchSince = null;
      samples = [];
      history = [];
      lastGunT = -Infinity;
      lastClickT = -Infinity;
      resetPinch();
    }
  };
}

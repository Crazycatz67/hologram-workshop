// The finger-gun pointer: an absolute cursor you aim with one hand and click with the other
// hand's pinch (owner decisions and live probe, plans/platform/ROADMAP.md 2026-10-01).
// Pure logic: no DOM, no three.js, so test.js can replay it frame by frame.
//
// CONTRACT
//   createEngagement({ enterY, exitY }) -> { update(hands) -> hands, reset() }
//     Sets hand.engaged on each hand. A hand is engaged ("raised") while its wrist is above a
//     horizontal line in the camera image: it engages when wrist y < enterY and disengages
//     when wrist y > exitY (image units, 0 = top, 1 = bottom; hysteresis between the two).
//     Lowered hands are at rest: the manipulator and the pointer ignore them.
//     setLine(enterY) moves the line (exitY = enterY + the default band); calibration uses it.
//   palmCentroid(landmarks) -> { x, y }   mean of landmarks 0, 5, 9, 13, 17 (image units).
//   mapReach({ x, y }, reach) -> { x, y }  image point -> NDC, mirrored like the ghost hands,
//     reach = { x0, x1, y0, y1 } (image units) maps onto -1..1; clamped to -1..1.
//   createOneEuro2D({ minCutoff, beta, dCutoff }) -> { filter(x, y, tMs) -> { x, y }, reset() }
//   ghostOffset(hand, cursor, viewAspect, len) -> { dx, dy } image units: DEPRECATED, no
//     longer used (2026-10-01, Phase 2A): the hand is drawn where it really is and the beam
//     runs from its real index tip. Kept only until test.js drops its two checks of it.
//   createPointer({ rewindMs, profile }) -> pointer
//     pointer.update(hands, aspect, tMs) -> click event or null. hands: this camera frame's
//       hands, already through gestures.annotateHand (hand.pointer, hand.pinch) and
//       createEngagement (hand.engaged; a hand without it counts as engaged).
//     pointer.mouseMove(ndcX, ndcY, tMs) / pointer.mouseLeave() / pointer.mouseClick(ndcX, ndcY, tMs)
//       The mouse fallback, fed through the same state. mouseClick returns a click event.
//     pointer.tick(tMs)   display-rate step: hides a held cursor after CLUTCH_SHOW_MS.
//     pointer.reset()     full reset: cursor recentred to (0, 0), filter and click state cleared.
//     pointer.setProfile({ reach?, smoothing? })   apply a calibration (calibrate.js profile).
//     pointer.profile -> { reach, smoothing }
//     pointer.state -> { mode: 'off' | 'aim' | 'clutch', source: 'hand' | 'mouse' | null,
//                        x, y (NDC, -1..1, y up), aimHand (hand object or null),
//                        raw: { x, y } (unfiltered mapped palm, NDC) | null }
//       'clutch' (name kept for sessionrec/tests) now just means "pose lost: cursor held still".
//     click event: { type: 'click', x, y (NDC, rewound), t, source }
//   createResetGate({ holdMs }) -> { update(hands, tMs) -> true on the frame a reset fires, reset() }
//     Fires once when no hand has been raised for holdMs while at least one lowered hand is in
//     view ("lower both hands for 1 s"); re-arms only after a hand is raised again.
//   createTrackingMonitor() -> { update(hands, pointerState, tMs) -> hint | null, reset() }
//     hint = { key: 'flicker' | 'edge' | 'lost', text } while tracking struggles, kept for
//     HINT_HOLD_MS after it recovers; null otherwise.
//   Units: cursor in NDC (-1..1, y up, already mirrored like the ghost hands); time in ms.
//   Never throws on missing fields: a hand without landmarks is ignored.
//
//   ONE-HAND SELECTION (owner decisions 2026-10-01 (3)); three commits route to one click:
//     click.via = 'hold' (handsRuntime, from createSelector) | 'pinch' (the aiming hand's own
//     quick pinch: click at the cursor REWIND_MS before onset, cursor frozen until the pinch
//     opens; createPointer option sameHandPinch, default true) | 'other-pinch' | 'mouse'.
//     pointer.state.frozen: true while a same-hand pinch holds the cursor.
//   createSelector({ holdMs, steadyPx, bubblePx, switchRatio, releasePx }) -> selector
//     selector.update({ candidates, cursorPx, t, canHold }) -> { target, progress,
//       visibleProgress, phase, fired }
//       candidates: ranked [{ id?, part?, hit, distPx, rankPx }] (manipulator.partsNear, or any
//       2D targets): ray hits front to back, then misses nearest first. Identity = id ?? part.
//       target: a ray hit wins (the front one); on a miss the nearest within bubblePx, but the
//       current target is kept until another is switchRatio (0.85 = 15%) closer (rankPx).
//       Holding the cursor within steadyPx per 200 ms on one target for holdMs fires once
//       (holdGate.js: ring invisible for its first 200 ms, paused by motion); it can fire
//       again only after the cursor has moved releasePx from where it fired, or the target
//       changed. cursorPx: { x, y } CSS px, or null (no cursor: target null, gate idle).
//       canHold false: target is still tracked but nothing charges (e.g. the mouse).
//     selector.block(cursorPx)   a click (any kind) just landed: no hold-fire on the same
//       target until the cursor has moved releasePx or the target changed.
//     selector.reset()
//   HANDS V2 (?hands=v2 / localStorage 'hands.v2'='1', or createPointer({ v2: true })): a
//     separate cursor + thumb-hammer click with the same API; see "Hands v2 cursor" below.
//   nextInStack(hits, current) -> the entry after `current` in the front-to-back hits (wraps),
//     or hits[0]: "hold again on the same spot" picks the next part behind.

import { createHoldGate } from './holdGate.js';
import { gunFeatures, THUMB_COCKED_MIN, THUMB_DROPPED_MAX, hammerAngleDeg, createHammer, HAMMER_DEFAULTS } from './gunPose.js';
import { palmLength, handsV2Enabled } from './gestures.js';

export const ENGAGE_ENTER_Y = 0.88;
export const ENGAGE_EXIT_Y = 0.94;

// The line is low on purpose. Every existing gesture is made with the hands somewhere in the
// middle of the frame, and a webcam on a laptop sees a raised hand's wrist anywhere from
// mid-frame down to near the bottom edge. "Lowered" therefore means the wrist has dropped into
// the bottom ~6-12% of the image (or out of it: MediaPipe still reports landmarks past the
// edge). Not yet measured on the owner's hands: tune live, then record the numbers here.
const ENGAGE_MATCH_DIST = 0.2; // image units: farther than this from every previous wrist = a new hand

const PALM = [0, 5, 9, 13, 17];

// ABSOLUTE cursor (owner decision 2026-10-01, after "very difficult to control"): the cursor is
// the palm centroid mapped from the user's reach box (where their palm comfortably goes, in
// image units) onto the whole canvas. Same hand position = same cursor position, always, so
// there is nothing to drift and nothing to clutch. The reach box comes from calibrate.js
// (5th-95th percentile of the palm while tracing a rectangle); until then DEFAULT_REACH is a
// box a seated laptop user reaches without stretching, above the engage line.
export const DEFAULT_REACH = { x0: 0.22, x1: 0.78, y0: 0.22, y1: 0.72 };

// One Euro on the cursor (Casiez et al. 2012), in NDC. The landmarks are already filtered
// (smoothLandmarks.js), but the reach-box mapping multiplies their residual jitter by
// 2 / box width (~3.5x), so the cursor needs its own filter. Cutoff = minCutoff + beta * speed:
// a still hand gets ~1 Hz (jitter gone), a hand crossing the screen in half a second gets
// ~13 Hz (little lag). Two presets; calibration tries both on the owner and keeps the better.
export const SMOOTHING = {
  responsive: { minCutoff: 1.0, beta: 3.0, dCutoff: 1.0 },
  steady: { minCutoff: 0.5, beta: 1.5, dCutoff: 1.0 }
};
export const DEFAULT_SMOOTHING = SMOOTHING.responsive;

// Only for the deprecated ghostOffset (see the contract): how far behind the cursor it put
// the shifted index tip.
export const BEAM_LEN = 0.14; // NDC-height units (~63 px on a 900 px canvas)

// Sticky pointer (owner-approved 2026-10-01, HANDS-UX-SPEC §1): pose wobble holds the cursor
// still and stays 'aim' until a clear release pose (palm, fist, ✌) or STICKY_MS without the
// pose. A re-entry within REENTRY_KEEP_MS of the last pose frame keeps the filter (no snap).
export const STICKY_MS = 350;
export const REENTRY_KEEP_MS = 400;
const RELEASE_POSES = new Set(['Open_Palm', 'Closed_Fist', 'Victory']);
// Thumb-tap click (owner-approved TRIAL 2026-10-01, behind a setting, default off; Ricky (b)):
// the aiming hand's thumb drops from cocked (gunPose THUMB_COCKED_MIN) to on the index
// (THUMB_DROPPED_MAX) within THUMB_TAP_MAX_MS. The thumb drags the index (Linburg-Comstock), so
// the click lands where the cursor was when the thumb LEFT cocked (the onset), not at contact.
// Must have been cocked for THUMB_COCKED_HOLD_MS first, so a resting thumb never clicks.
export const THUMB_TAP_KEY = 'hands.thumbTap';
const THUMB_TAP_MAX_MS = 250;  // a tap is ~100-150 ms; provisional until a live probe
const THUMB_COCKED_HOLD_MS = 120;
const CLUTCH_SHOW_MS = 1500;  // how long a held cursor stays visible before it hides

// Click = the other hand's pinch. Measured live (gun-lab, 2026-10-01): the aiming palm moves a
// median 3.6 px while the other hand pinches, less than its resting wander, so the click does
// not need to freeze the cursor. The rewind still removes what motion there is (Wolf et al.):
// the click lands where the cursor was REWIND_MS before the pinch was first seen.
export const REWIND_MS = 120;
const PINCH_RELEASE_RATIO = 0.35;  // pinch re-arms only once opened past this (gestures.js closes at 0.25)
const PINCH_REARM_MS = 60;         // ...for this long, so one noisy frame can't re-arm it
const CLICK_REFRACTORY_MS = 250;   // at most 4 clicks per second, whatever the tracking does
// Hold-to-select (owner 2026-10-01 (3)). 650 ms is holdGate's measured ring time; the
// steady radius is in screen px because the cursor, not the wrist, is what has to be still.
export const SELECT_HOLD_MS = 650;
export const SELECT_STEADY_PX = 12;
export const SELECT_RELEASE_PX = 24;
export const BUBBLE_PX = 80;
export const BUBBLE_SWITCH_RATIO = 0.85;

// Same-hand pinch (one-hand selection, owner 2026-10-01 (3)). SAME_PINCH_CLOSE is
// gestures.js PINCH_THRESHOLD (a deliberate pinch reads ~0.15). SAME_HAND_MATCH: palm within
// this (image units, ~2/3 of a palm) of the last aiming palm = the same hand. The freeze ends
// when the pinch opens, or after FREEZE_MAX_MS so a hand that stays pinched can't lock it.
const SAME_PINCH_CLOSE = 0.25;
const SAME_HAND_MATCH = 0.08;
const FREEZE_MAX_MS = 1500;
const HISTORY_MS = 400;

// Reset and hints (owner decision 3). Lowering both hands is the one gesture that can't be
// confused with any other: every gesture is made with raised hands.
export const RESET_HOLD_MS = 1000;
const LOWER_GAP_MS = 300;          // lowered hands may vanish this long without breaking the hold
const FLICKER_WINDOW_MS = 2000;
const FLICKER_TOGGLES = 6;         // pose on/off 3 times in 2 s: the classifier is struggling
const EDGE_NDC = 0.985;
const EDGE_MS = 1000;              // cursor pinned at an edge this long: reach box is wrong or hand is out of it
const LOST_MS = 500;               // aiming hand gone this long (no hands at all)
export const HINT_HOLD_MS = 2500;  // a hint stays this long after tracking recovers, then fades
export const HINTS = {
  flicker: 'pointer pose keeps dropping · index straight out, other three fingers curled tight',
  edge: 'cursor stuck at the edge · bring your hand back toward the middle, or press C to recalibrate',
  lost: 'hand lost · keep your hand inside the camera view'
};

export function palmCentroid(landmarks) {
  let x = 0;
  let y = 0;
  for (const i of PALM) {
    x += landmarks[i].x;
    y += landmarks[i].y;
  }
  return { x: x / PALM.length, y: y / PALM.length };
}

const clamp = (v) => Math.max(-1, Math.min(1, v));
const hasLandmarks = (h) => Array.isArray(h?.landmarks) && h.landmarks.length >= 18;

export function mapReach(c, reach = DEFAULT_REACH) {
  const w = Math.max(1e-3, reach.x1 - reach.x0);
  const h = Math.max(1e-3, reach.y1 - reach.y0);
  // Mirrored like the ghost hands: the image's x runs the other way to the screen's.
  // Image y runs down, NDC y runs up.
  return {
    x: clamp(1 - (2 * (c.x - reach.x0)) / w),
    y: clamp(1 - (2 * (c.y - reach.y0)) / h)
  };
}

const alphaFor = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export function createOneEuro2D(params = DEFAULT_SMOOTHING) {
  let p = { ...DEFAULT_SMOOTHING, ...params };
  let prev = null; // { x, y, dx, dy, t }
  return {
    filter(x, y, t) {
      if (!prev) {
        prev = { x, y, dx: 0, dy: 0, t };
        return { x, y };
      }
      // Clamp dt: a long gap (hidden tab, dropped frames) must not read as a huge speed or
      // a fully-open filter.
      const dt = Math.min(0.1, Math.max(1e-3, (t - prev.t) / 1000));
      const ad = alphaFor(p.dCutoff, dt);
      const dx = prev.dx + ad * ((x - prev.x) / dt - prev.dx);
      const dy = prev.dy + ad * ((y - prev.y) / dt - prev.dy);
      // One cutoff for both axes from the 2D speed, so a diagonal move doesn't bend.
      const a = alphaFor(p.minCutoff + p.beta * Math.hypot(dx, dy), dt);
      prev = { x: prev.x + a * (x - prev.x), y: prev.y + a * (y - prev.y), dx, dy, t };
      return { x: prev.x, y: prev.y };
    },
    reset() {
      prev = null;
    },
    set(params2) {
      p = { ...p, ...params2 };
    },
    get params() {
      return { ...p };
    }
  };
}

// Deprecated: no caller since handModel.js (the shift moved the drawn hand off the real one).
export function ghostOffset(hand, cursor, viewAspect = 16 / 9, len = BEAM_LEN) {
  if (!hasLandmarks(hand) || !cursor) return { dx: 0, dy: 0 };
  const w = hand.landmarks[0];
  const tip = hand.landmarks[8];
  // Wrist -> index tip, in screen-shaped units (x scaled by the canvas aspect, y up). Side-on
  // it runs along the finger; pointing at the camera it runs up the hand. Either way it is
  // long enough to have a stable direction, unlike the foreshortened index alone.
  let ux = -(tip.x - w.x) * viewAspect;
  let uy = -(tip.y - w.y);
  const n = Math.hypot(ux, uy);
  if (n < 1e-6) { ux = 0; uy = 1; } else { ux /= n; uy /= n; }
  const tipX = 1 - 2 * tip.x;
  const tipY = 1 - 2 * tip.y;
  const wantX = cursor.x - (ux * len) / viewAspect;
  const wantY = cursor.y - uy * len;
  // NDC -> image units: x is mirrored, both axes span 2 NDC per 1 image unit.
  return { dx: -(wantX - tipX) / 2, dy: -(wantY - tipY) / 2 };
}

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
    setLine(y) {
      if (!Number.isFinite(y)) return;
      const band = ENGAGE_EXIT_Y - ENGAGE_ENTER_Y;
      enterY = Math.min(0.97 - band, Math.max(0.3, y));
      exitY = enterY + band;
    },
    get line() {
      return { enterY, exitY };
    },
    reset() {
      previous = [];
    }
  };
}

// One hand's pinch as clicks: armed once it has been open (ratio > PINCH_RELEASE_RATIO) for
// PINCH_REARM_MS; the first closed frame after that is the onset.
function createPinchEdge() {
  let armed = false;
  let openSince = null;
  let was = false;
  return {
    update(closed, ratio, t) {
      const open = !closed && (Number.isFinite(ratio) ? ratio > PINCH_RELEASE_RATIO : true);
      if (open) {
        openSince ??= t;
        if (t - openSince >= PINCH_REARM_MS) armed = true;
      } else {
        openSince = null;
      }
      const onset = closed && !was && armed;
      was = closed;
      if (onset) armed = false;
      return onset;
    },
    get open() { return openSince !== null; },
    reset() { armed = false; openSince = null; was = false; }
  };
}

function readThumbTapSetting() {
  try { return globalThis.localStorage?.getItem(THUMB_TAP_KEY) === '1'; } catch { return false; }
}

export function createPointer({ rewindMs = REWIND_MS, profile = null, sameHandPinch = true, thumbTap = readThumbTapSetting(), v2 = handsV2Enabled(), clickAlt = readClickAltSetting() } = {}) {
  // Hands v2 (?hands=v2 / localStorage 'hands.v2'='1'): a separate implementation, so the v1
  // code below runs byte-for-byte as before with the switch off.
  if (v2) return createPointerV2({ rewindMs, profile, clickAlt });
  let tapOn = thumbTap === true;
  let thumb = { cockedSince: null, leftCockedAt: null, armed: false }; // see THUMB_TAP_MAX_MS
  let reach = { ...DEFAULT_REACH };
  const euro = createOneEuro2D(DEFAULT_SMOOTHING);
  let mode = 'off';
  let source = null;
  let x = 0;
  let y = 0;
  let raw = null;
  let aimHand = null;
  let lastPalm = null;       // image units, of the aim hand on the previous pose frame
  let lastGunT = -Infinity;
  let clutchSince = null;
  let history = [];          // [{ t, x, y }] cursor, for the click rewind
  // Each click hand's pinch: armed once it has been open; the first pinching frame clicks.
  const otherPinch = createPinchEdge();
  const samePinch = createPinchEdge();
  let lastClickT = -Infinity;
  // Same-hand pinch: the cursor is frozen from the click until the pinch opens again, so the
  // palm shift a thumb-to-index pinch causes never drags the cursor off what was clicked.
  let frozenAt = null;

  function setProfile(pr) {
    const r = pr?.reach;
    if (r && [r.x0, r.x1, r.y0, r.y1].every(Number.isFinite) && r.x1 - r.x0 > 0.05 && r.y1 - r.y0 > 0.05) {
      reach = { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 };
    }
    const sm = pr?.smoothing;
    if (sm && Number.isFinite(sm.minCutoff) && Number.isFinite(sm.beta)) euro.set(sm);
  }
  if (profile) setProfile(profile);

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

  function enterClutch(t) {
    if (mode !== 'aim' || source !== 'hand') return;
    mode = 'clutch';
    clutchSince = t;
    aimHand = null;
  }

  function pickAimHand(guns) {
    if (guns.length === 1 || !lastPalm) return guns[0];
    // Both hands pointing: keep the one that was aiming (nearest to its last palm).
    let best = guns[0];
    let bestD = Infinity;
    for (const g of guns) {
      const c = palmCentroid(g.landmarks);
      const d = Math.hypot(c.x - lastPalm.x, c.y - lastPalm.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  function resetPinch() {
    otherPinch.reset();
    samePinch.reset();
    frozenAt = null;
    thumb = { cockedSince: null, leftCockedAt: null, armed: false };
  }

  // The engaged hand whose palm is nearest the last aiming palm, within SAME_HAND_MATCH.
  function formerAimHand(engaged) {
    let best = null;
    let bestD = SAME_HAND_MATCH;
    for (const h of engaged) {
      const c = palmCentroid(h.landmarks);
      const d = Math.hypot(c.x - lastPalm.x, c.y - lastPalm.y);
      if (d <= bestD) { bestD = d; best = h; }
    }
    return best;
  }

  function clickAt(t, via) {
    lastClickT = t;
    const at = cursorAt(t - rewindMs);
    // Put the cursor back where the click landed, so what you see is what was clicked.
    x = at.x;
    y = at.y;
    record(t);
    return { type: 'click', x, y, t, source: 'hand', via };
  }

  return {
    get state() {
      return { mode, source, x, y, aimHand, raw, frozen: frozenAt !== null };
    },

    get profile() {
      return { reach: { ...reach }, smoothing: euro.params };
    },

    setProfile,

    // Thumb-tap click trial (default off). persist: also store it for the next page load.
    get thumbTap() { return tapOn; },
    setThumbTap(on, { persist = false } = {}) {
      tapOn = on === true;
      thumb = { cockedSince: null, leftCockedAt: null, armed: false };
      if (persist) { try { globalThis.localStorage?.setItem(THUMB_TAP_KEY, tapOn ? '1' : '0'); } catch { /* storage blocked */ } }
    },

    update(hands, aspect = 1, t = performance.now()) {
      const engaged = hands.filter((h) => hasLandmarks(h) && h.engaged !== false);
      const guns = engaged.filter((h) => h.pointer?.gun === true);

      // Sticky pointer: without the pose, the hand that was aiming (matched by palm position)
      // still counts as the aiming hand for STICKY_MS, and for as long as its same-hand pinch
      // holds the cursor frozen, unless it clearly shows a release pose (palm, fist, ✌). A
      // pinching hand reads fist-like, so a closed pinch is never a release.
      let former = null;
      let released = false;
      if (!guns.length && mode === 'aim' && source === 'hand' && lastPalm) {
        const f = formerAimHand(engaged);
        const pinched = f && (f.pinch?.pinching === true || (Number.isFinite(f.pinch?.ratio) && f.pinch.ratio < SAME_PINCH_CLOSE));
        released = !!f && !pinched && frozenAt === null && RELEASE_POSES.has(f.gesture);
        if (f && !released && (frozenAt !== null || t - lastGunT < STICKY_MS)) former = f;
      }

      if (guns.length) {
        const hand = pickAimHand(guns);
        const c = palmCentroid(hand.landmarks);
        if (mode !== 'aim' || source !== 'hand') {
          // (Re)entering the pose: the cursor goes straight to where the hand is. Absolute,
          // so a fresh filter start is right (it would otherwise glide in from the old spot),
          // except on a quick re-entry after wobble, where a reset would make the cursor snap.
          const quick = source === 'hand' && t - lastGunT < REENTRY_KEEP_MS;
          mode = 'aim';
          source = 'hand';
          clutchSince = null;
          if (!quick) euro.reset();
          resetPinch();
        }
        lastGunT = t;
        lastPalm = c;
        raw = mapReach(c, reach);
        const f = euro.filter(raw.x, raw.y, t);
        if (frozenAt === null) {
          x = clamp(f.x);
          y = clamp(f.y);
        }
        aimHand = hand;
        record(t);
      } else if (former) {
        // Held cursor (no motion) while the pose wobbles or is down for the pinch.
        if (frozenAt !== null) lastGunT = t;
        lastPalm = palmCentroid(former.landmarks);
        aimHand = former;
        record(t);
      } else if (mode === 'aim' && source === 'hand') {
        // A clear release pose ends aiming at once; otherwise the cursor holds still until
        // STICKY_MS without the pose (hand out of view, or wandered off), then hides after
        // CLUTCH_SHOW_MS.
        if (released || t - lastGunT >= STICKY_MS) enterClutch(t);
        else { aimHand = null; record(t); }
      }

      if (mode !== 'aim' || source !== 'hand') {
        resetPinch();
        return null;
      }

      let click = null;
      // 1. Same-hand pinch (owner decision 2026-10-01 (3): one-hand selection). The raw ratio,
      // not hand.pinch.pinching: with three fingers curled the pinching hand is fist-shaped
      // apart from the index, and the fist veto would throw the pinch away.
      if (sameHandPinch && aimHand) {
        const ratio = aimHand.pinch?.ratio;
        const closed = aimHand.pinch?.pinching === true || (Number.isFinite(ratio) && ratio < SAME_PINCH_CLOSE);
        const onset = samePinch.update(closed, ratio, t);
        if (frozenAt !== null && (samePinch.open || t - frozenAt > FREEZE_MAX_MS)) frozenAt = null;
        if (onset && t - lastClickT >= CLICK_REFRACTORY_MS) {
          click = clickAt(t, 'pinch');
          frozenAt = t;
        }
      }

      // 1b. Thumb-tap (trial, behind the setting), only on frames that really see the pose.
      if (tapOn && !click && aimHand && guns.includes(aimHand) && aimHand.worldLandmarks) {
        const gap = gunFeatures(aimHand.worldLandmarks)?.thumbGap;
        if (Number.isFinite(gap)) {
          if (gap > THUMB_COCKED_MIN) {
            thumb.cockedSince ??= t;
            thumb.lastCockedT = t;
            thumb.leftCockedAt = null;
            if (t - thumb.cockedSince >= THUMB_COCKED_HOLD_MS) thumb.armed = true;
          } else {
            if (thumb.cockedSince !== null) thumb.leftCockedAt = thumb.lastCockedT;  // the onset
            thumb.cockedSince = null;
            if (thumb.leftCockedAt !== null && t - thumb.leftCockedAt > THUMB_TAP_MAX_MS) thumb.armed = false;
            if (gap < THUMB_DROPPED_MAX && thumb.armed && thumb.leftCockedAt !== null && t - lastClickT >= CLICK_REFRACTORY_MS) {
              thumb.armed = false;
              const onset = thumb.leftCockedAt;
              lastClickT = t;
              const at = cursorAt(onset);
              x = at.x;
              y = at.y;
              record(t);
              click = { type: 'click', x, y, t, source: 'hand', via: 'thumb-tap' };
            }
          }
        }
      }

      // 2. The other hand's pinch (precise: the aiming palm hardly moves).
      const clicker = engaged.find((h) => h !== aimHand && h.pointer?.gun !== true) ?? null;
      if (!clicker) {
        otherPinch.reset();
        return click;
      }
      const onset = otherPinch.update(clicker.pinch?.pinching === true, clicker.pinch?.ratio, t);
      if (click || !onset || t - lastClickT < CLICK_REFRACTORY_MS) return click;
      return clickAt(t, 'other-pinch');
    },

    mouseMove(ndcX, ndcY, t = performance.now()) {
      // Last input wins: moving the mouse takes over from a hand, and the next frame that
      // sees the pose takes it back (absolute: the cursor goes to where the hand is).
      mode = 'aim';
      source = 'mouse';
      aimHand = null;
      raw = null;
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
      return { type: 'click', x, y, t, source: 'mouse', via: 'mouse' };
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
      x = 0;
      y = 0;
      raw = null;
      aimHand = null;
      lastPalm = null;
      clutchSince = null;
      history = [];
      lastGunT = -Infinity;
      lastClickT = -Infinity;
      euro.reset();
      resetPinch();
    }
  };
}

// ---- Hands v2 cursor (plans/hands-v2/CONTRACT.md §3.1-3.2; numbers: Ricky's report §1-3) ----
// CONTRACT (createPointer({ v2: true }) or the page switch). Same object API as v1, plus:
//   pointer.v2 === true
//   pointer.clickAlt / setClickAlt('pinch' | 'hold' | null, { persist })  (localStorage
//     'hands.clickAlt'; default null). 'pinch' = the other hand's pinch clicks (v1 rule, no freeze);
//     'hold' = the host's createSelector may charge (pointer.js itself does nothing for it);
//     null = the thumb hammer is the only hand click.
//   pointer.setView(aspect)  the cursor canvas's width/height (default: the camera aspect passed
//     to update). Gains are px per mm on a 1460-px-wide canvas scaled by canvasWidth/1460, which
//     makes NDC-x per mm independent of the canvas size; only the aspect is needed for y.
//   setProfile({ reach?, cursor? }): reach's centre is the absolute anchor's centre (A0);
//     cursor = { minCutoff, beta, dCutoff, gmin, gmax, vinf, lambda, absGain } overrides V2.
//   state adds { v2: { phase: 'live'|'pending'|'held'|'easing', speed (m/s), gain (px/mm),
//     offsetPx: [x, y] cursor - absolute anchor (1460-px units), hammer: { state, angleDeg,
//     source: 'features'|'local' } } }. state.raw = the absolute anchor in NDC.
//   click via 'hammer' (rewound to onset - 1 frame, cap 200 ms) | 'other-pinch' | 'mouse'.
// Behaviour: aim = index MCP (landmark 5) of hand.rawLandmarks (else hand.landmarks), as metres
// through a heavily smoothed s = palm metres / palm image length (only differences are scaled),
// ONE One Euro stage, a sigmoid speed gain and PRISM offset recovery toward the absolute anchor.
// No sticky hold, no pinch freeze: a frame without the gun pose holds the cursor ('clutch'); a
// re-entry within REENTRY_KEEP_MS continues from it. Any gun pose engages (no wrist line).
// Hammer: hand.f.hammer when present (handFeatures.js), else gunPose createHammer (local copy).
export const CLICK_ALT_KEY = 'hands.clickAlt';
export const V2 = Object.freeze({
  minCutoff: 1.0,    // Hz      [Ricky §2] One Euro on the aim point in metres
  beta: 40,          // Hz per m/s
  dCutoff: 1.0,      // Hz
  gmin: 1.5,         // px/mm   sigmoid CD gain (Nancel et al.) at slow speed ...
  gmax: 6.0,         // px/mm   ... and fast
  vinf: 0.08,        // m/s     inflection
  lambda: 40,        // s/m     steepness
  absGain: 5.84,     // px/mm   the absolute anchor's mapping about the calibrated centre
  REF_W: 1460,       // px      the canvas width the gains are quoted for
  prismV: 0.15,      // m/s     offset recovery only while moving at least this fast ...
  prismK: 0.5,       //         ... toward the anchor, by at most this share of the step
  sTauMs: 1000,      // ms      EMA on s (metres per image unit)
  palmM: 0.085,      // m       assumed palm when a hand has no world landmarks
  rewindCapMs: 200,  // ms      the hammer rewind never reaches further back than this
  easeMs: 100,       // ms      abort / release eases the frozen cursor back to the hand
  holdMaxMs: 1000,   // ms      after a hammer click the cursor stays on the target at most this long
  moveV: 0.15        // m/s     ... or until the hand moves this fast (a deliberate re-aim)
});

function readClickAltSetting() {
  try {
    const v = globalThis.localStorage?.getItem(CLICK_ALT_KEY);
    return v === 'pinch' || v === 'hold' ? v : null;
  } catch { return null; }
}

const smooth01 = (k) => { const c = Math.max(0, Math.min(1, k)); return c * c * (3 - 2 * c); };

function createPointerV2({ rewindMs = REWIND_MS, profile = null, clickAlt = null } = {}) {
  let P = { ...V2 };
  let alt = clickAlt === 'pinch' || clickAlt === 'hold' ? clickAlt : null;
  let reach = { ...DEFAULT_REACH };
  let viewAspect = null;
  const euro = createOneEuro2D({ minCutoff: P.minCutoff, beta: P.beta, dCutoff: P.dCutoff });
  const localHammer = createHammer(HAMMER_DEFAULTS);
  const otherPinch = createPinchEdge();
  let mode = 'off';
  let source = null;
  let x = 0;                   // displayed cursor, NDC
  let y = 0;
  let raw = null;
  let aimHand = null;
  let lastPalm = null;
  let lastGunT = -Infinity;
  let clutchSince = null;
  let history = [];
  let lastClickT = -Infinity;
  // Aim tracking (metres). acc = raw aim accumulated from frame-to-frame differences; filt = its
  // One Euro output. live = the cursor the hand drives, in 1460-px units (x right, y up).
  let aim = null;              // { A: {x,y} image, s, acc: [x,y], filt: [x,y], t }
  let live = [0, 0];
  let speed = 0;
  let gain = P.gmin;
  let absPx = [0, 0];
  // Freeze / ease: phase 'pending' (thumb falling, cursor held), 'held' (after a click),
  // 'easing' (blending back to live), 'live'.
  let phase = 'live';
  let frozen = null;           // { x, y, since } NDC
  let ease = null;             // { x, y, since } NDC start of the blend
  let hammerOut = { state: 'unknown', angleDeg: null, source: null };
  let prevHam = null;          // { deg, t } for the fall rate when reading hand.f

  const halfW = () => P.REF_W / 2;
  const halfH = (aspect) => P.REF_W / 2 / (viewAspect ?? aspect);

  function setProfile(pr) {
    const r = pr?.reach;
    if (r && [r.x0, r.x1, r.y0, r.y1].every(Number.isFinite) && r.x1 - r.x0 > 0.05 && r.y1 - r.y0 > 0.05) {
      reach = { x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1 };
    }
    const c = pr?.cursor;
    if (c && typeof c === 'object') {
      for (const k of ['minCutoff', 'beta', 'dCutoff', 'gmin', 'gmax', 'vinf', 'lambda', 'absGain']) {
        if (Number.isFinite(c[k])) P[k] = c[k];
      }
      euro.set({ minCutoff: P.minCutoff, beta: P.beta, dCutoff: P.dCutoff });
    }
  }
  if (profile) setProfile(profile);

  function record(t) {
    history.push({ t, x, y });
    while (history.length > 2 && history[0].t < t - HISTORY_MS) history.shift();
  }
  function cursorAt(t) {
    let best = history[0] ?? { x, y };
    for (const h of history) {
      if (h.t <= t) best = h;
      else break;
    }
    return best;
  }

  function pickAimHand(guns) {
    if (guns.length === 1 || !lastPalm) return guns[0];
    let best = guns[0];
    let bestD = Infinity;
    for (const g of guns) {
      const c = palmCentroid(g.landmarks);
      const d = Math.hypot(c.x - lastPalm.x, c.y - lastPalm.y);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best;
  }

  // Metres per aspect-corrected image unit. handFeatures' smoothed s when it has one (same
  // formula), else a local EMA (tau sTauMs) of palm metres / palm image length.
  function sFor(hand, pts, aspect, prevS, dtMs) {
    const fs = hand.f?.aim?.s;
    if (Number.isFinite(fs) && fs > 0) return fs;
    const img = palmLength(pts, aspect);
    if (!(img > 1e-4)) return prevS ?? P.palmM / 0.15;
    const m = hand.f?.sizeM ?? gunFeatures(hand.worldLandmarks)?.palmM ?? P.palmM;
    const now = m / img;
    if (!Number.isFinite(prevS) || !(dtMs > 0)) return now;
    return prevS + (now - prevS) * (1 - Math.exp(-dtMs / P.sTauMs));
  }

  const sigmoidGain = (v) => P.gmin + (P.gmax - P.gmin) / (1 + Math.exp(-P.lambda * (v - P.vinf)));

  function toNdc(px, aspect) {
    return { x: clamp(px[0] / halfW()), y: clamp(px[1] / halfH(aspect)) };
  }
  function clampPx(px, aspect) {
    return [Math.max(-halfW(), Math.min(halfW(), px[0])), Math.max(-halfH(aspect), Math.min(halfH(aspect), px[1]))];
  }

  // One aim frame: returns nothing, updates live / absPx / speed / gain.
  function track(hand, aspect, t, fresh) {
    const pts = Array.isArray(hand.rawLandmarks) && hand.rawLandmarks.length >= 18 ? hand.rawLandmarks : hand.landmarks;
    const A = { x: pts[5].x, y: pts[5].y };
    const dtMs = aim ? t - aim.t : 0;
    const s = sFor(hand, pts, aspect, fresh ? null : aim?.s, dtMs);
    if (fresh || !aim) {
      euro.reset();
      aim = { A, s, acc: [0, 0], filt: [0, 0], t };
      euro.filter(0, 0, t);
    } else {
      // Only DIFFERENCES are scaled by s: an absolute position times a noisy s would turn depth
      // noise into cursor noise (Ricky §Units).
      const acc = [aim.acc[0] + (A.x - aim.A.x) * aspect * s, aim.acc[1] + (A.y - aim.A.y) * s];
      const f = euro.filter(acc[0], acc[1], t);
      const filt = [f.x, f.y];
      const dt = Math.min(0.1, Math.max(1e-3, dtMs / 1000));
      const d = [filt[0] - aim.filt[0], filt[1] - aim.filt[1]];
      speed = Math.hypot(d[0], d[1]) / dt;
      gain = sigmoidGain(speed);
      // Image x runs opposite to the screen (mirrored like the ghost hands), image y runs down.
      const step = [-d[0] * 1000 * gain, -d[1] * 1000 * gain];
      live = [live[0] + step[0], live[1] + step[1]];
      aim = { A, s, acc, filt, t };
      absPx = anchorPx(aspect);
      // PRISM offset recovery (Frees 2007, via Ricky §2): while moving fast TOWARD the anchor,
      // close up to half of the step's length of the gap, so the cursor never drifts off the hand.
      const gap = [absPx[0] - live[0], absPx[1] - live[1]];
      const gl = Math.hypot(gap[0], gap[1]);
      const sl = Math.hypot(step[0], step[1]);
      if (speed > P.prismV && gl > 1e-6 && step[0] * gap[0] + step[1] * gap[1] > 0) {
        const k = Math.min(gl, P.prismK * sl) / gl;
        live = [live[0] + gap[0] * k, live[1] + gap[1] * k];
      }
      live = clampPx(live, aspect); // an edge clamp moves the offset too
      return;
    }
    absPx = anchorPx(aspect);
    live = clampPx(absPx, aspect);
    speed = 0;
    gain = sigmoidGain(0);
  }

  // The absolute anchor in 1460-px units: the filtered aim's metric offset from the calibrated
  // centre (reach box centre) times absGain. (filt - acc) carries the filter's lag into it.
  function anchorPx(aspect) {
    const c = { x: (reach.x0 + reach.x1) / 2, y: (reach.y0 + reach.y1) / 2 };
    const dx = (aim.A.x - c.x) * aspect * aim.s + (aim.filt[0] - aim.acc[0]);
    const dy = (aim.A.y - c.y) * aim.s + (aim.filt[1] - aim.acc[1]);
    return [-dx * 1000 * P.absGain, -dy * 1000 * P.absGain];
  }

  function readHammer(hand, t) {
    const fh = hand.f?.hammer;
    if (fh && typeof fh === 'object') {
      return { h: fh, gap: hand.f.thumbGap, src: 'features' };
    }
    const gap = gunFeatures(hand.worldLandmarks)?.thumbGap;
    return { h: localHammer.update(hammerAngleDeg(hand.worldLandmarks), gap, t), gap, src: 'local' };
  }

  function startEase(t) {
    ease = { x, y, since: t };
    phase = 'easing';
    frozen = null;
  }

  function resetAll() {
    euro.reset();
    localHammer.reset();
    otherPinch.reset();
    aim = null;
    phase = 'live';
    frozen = null;
    ease = null;
    prevHam = null;
  }

  return {
    v2: true,
    get state() {
      return {
        mode, source, x, y, aimHand, raw, frozen: phase === 'pending' || phase === 'held',
        v2: { phase, speed, gain, offsetPx: [live[0] - absPx[0], live[1] - absPx[1]], hammer: { ...hammerOut } }
      };
    },
    get profile() {
      const { minCutoff, beta, dCutoff, gmin, gmax, vinf, lambda, absGain } = P;
      return { reach: { ...reach }, smoothing: euro.params, cursor: { minCutoff, beta, dCutoff, gmin, gmax, vinf, lambda, absGain } };
    },
    setProfile,
    // v1's thumb-tap trial has no meaning in v2 (the hammer is always on).
    get thumbTap() { return false; },
    setThumbTap() {},
    get clickAlt() { return alt; },
    setClickAlt(v, { persist = false } = {}) {
      alt = v === 'pinch' || v === 'hold' ? v : null;
      otherPinch.reset();
      if (persist) { try { globalThis.localStorage?.setItem(CLICK_ALT_KEY, alt ?? ''); } catch { /* storage blocked */ } }
    },
    setView(aspect) { viewAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : null; },

    update(hands, aspect = 1, t = performance.now()) {
      const guns = hands.filter((h) => hasLandmarks(h) && h.pointer?.gun === true);
      if (!guns.length) {
        if (mode === 'aim' && source === 'hand') {
          mode = 'clutch';
          clutchSince = t;
          aimHand = null;
        }
        if (mode !== 'aim') otherPinch.reset();
        return null;
      }
      const hand = pickAimHand(guns);
      const quick = source === 'hand' && t - lastGunT < REENTRY_KEEP_MS && aim !== null;
      if (mode !== 'aim' || source !== 'hand') {
        mode = 'aim';
        source = 'hand';
        clutchSince = null;
        if (!quick) resetAll();
      }
      // A different hand took over (both pointing, the old one left): start it fresh.
      const swapped = aimHand && hand !== aimHand && lastPalm &&
        Math.hypot(palmCentroid(hand.landmarks).x - lastPalm.x, palmCentroid(hand.landmarks).y - lastPalm.y) > SAME_HAND_MATCH * 2;
      if (swapped) resetAll();
      track(hand, aspect, t, aim === null);
      lastGunT = t;
      lastPalm = palmCentroid(hand.landmarks);
      aimHand = hand;
      raw = toNdc(absPx, aspect);
      const liveNdc = toNdc(live, aspect);

      // Hammer (§3.2): freeze from the onset, click at the drop, rewind to onset - 1 frame.
      let click = null;
      const { h, gap, src } = readHammer(hand, t);
      const deg = h.angleDeg;
      const rate = prevHam && deg != null && t > prevHam.t ? ((deg - prevHam.deg) * 1000) / (t - prevHam.t) : 0;
      const frameMs = prevHam ? t - prevHam.t : 20;
      prevHam = deg == null ? null : { deg, t };
      hammerOut = { state: h.state, angleDeg: deg, source: src };
      const T = HAMMER_DEFAULTS;
      const inCock = deg != null && (deg > T.COCK_DEG || gap > T.COCK_GAP);
      if (h.edge && t - lastClickT >= CLICK_REFRACTORY_MS) {
        const onset = Number.isFinite(h.fallT) ? h.fallT : frozen?.since ?? t;
        const at = cursorAt(Math.max(onset - frameMs, t - P.rewindCapMs));
        lastClickT = t;
        x = at.x;
        y = at.y;
        frozen = { x, y, since: t };
        phase = 'held';
        record(t);
        click = { type: 'click', x, y, t, source: 'hand', via: 'hammer' };
      } else if (phase === 'live' || phase === 'easing') {
        if (h.state === 'cocked' && deg != null && (!inCock || rate < T.FALL_RATE_DPS)) {
          // The thumb started to fall: hold the cursor where it was on the previous frame.
          const prev = history[history.length - 1] ?? { x, y };
          frozen = { x: prev.x, y: prev.y, since: t };
          phase = 'pending';
          ease = null;
        }
      } else if (phase === 'pending') {
        const aborted = h.state !== 'cocked' || t - frozen.since > T.DROP_WINDOW_MS || (inCock && rate >= 0);
        if (aborted) startEase(t);
      } else if (phase === 'held') {
        // Stay on the target while the thumb is down; the lift reverses the drop's palm shift,
        // so the live cursor comes back near the click point by itself.
        const lifted = h.state !== 'dropped' || inCock;
        if (lifted || speed > P.moveV || t - frozen.since > P.holdMaxMs) startEase(t);
      }
      if (!click) {
        if (phase === 'pending' || phase === 'held') { x = frozen.x; y = frozen.y; }
        else if (phase === 'easing') {
          const k = smooth01((t - ease.since) / P.easeMs);
          x = ease.x + (liveNdc.x - ease.x) * k;
          y = ease.y + (liveNdc.y - ease.y) * k;
          if (k >= 1) { phase = 'live'; ease = null; }
        } else { x = liveNdc.x; y = liveNdc.y; }
        record(t);
      }

      // Other-hand pinch, only when the setting asks for it (CONTRACT §3.2).
      if (alt !== 'pinch') return click;
      const clicker = hands.find((o) => o !== hand && hasLandmarks(o) && o.engaged !== false && o.pointer?.gun !== true) ?? null;
      if (!clicker) { otherPinch.reset(); return click; }
      const onset = otherPinch.update(clicker.pinch?.pinching === true, clicker.pinch?.ratio, t);
      if (click || !onset || t - lastClickT < CLICK_REFRACTORY_MS) return click;
      lastClickT = t;
      const at = cursorAt(t - rewindMs);
      x = at.x;
      y = at.y;
      record(t);
      return { type: 'click', x, y, t, source: 'hand', via: 'other-pinch' };
    },

    mouseMove(ndcX, ndcY, t = performance.now()) {
      mode = 'aim';
      source = 'mouse';
      aimHand = null;
      raw = null;
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
      return { type: 'click', x, y, t, source: 'mouse', via: 'mouse' };
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
      x = 0;
      y = 0;
      raw = null;
      aimHand = null;
      lastPalm = null;
      clutchSince = null;
      history = [];
      lastGunT = -Infinity;
      lastClickT = -Infinity;
      live = [0, 0];
      absPx = [0, 0];
      resetAll();
    }
  };
}

export function createResetGate({ holdMs = RESET_HOLD_MS } = {}) {
  let armed = false;   // a hand has been raised since the last reset
  let since = null;    // first frame of the current "all lowered" stretch
  let lastLowered = -Infinity;
  return {
    update(hands, t) {
      const visible = hands.filter(hasLandmarks);
      const raised = visible.some((h) => h.engaged !== false);
      if (raised) {
        armed = true;
        since = null;
        return false;
      }
      // Hands gone from view is "lost", not "lowered": it neither starts nor (briefly) breaks
      // the hold, so MediaPipe dropping a hand at the bottom edge for a frame is harmless.
      if (!visible.length) {
        if (t - lastLowered > LOWER_GAP_MS) since = null;
        return false;
      }
      lastLowered = t;
      if (!armed) return false;
      since ??= t;
      if (t - since >= holdMs) {
        armed = false;
        since = null;
        return true;
      }
      return false;
    },
    reset() {
      armed = false;
      since = null;
      lastLowered = -Infinity;
    }
  };
}

export function createTrackingMonitor() {
  let poseFlips = [];  // times the aim pose toggled
  let lastPose = null;
  let edgeSince = null;
  let lostSince = null;
  let wasAiming = false;
  let hint = null;
  let hintUntil = -Infinity;
  return {
    update(hands, st, t) {
      const visible = hands.filter(hasLandmarks);
      const raised = visible.filter((h) => h.engaged !== false);
      const pose = raised.some((h) => h.pointer?.gun === true);
      if (lastPose !== null && pose !== lastPose && raised.length) poseFlips.push(t);
      lastPose = pose;
      while (poseFlips.length && poseFlips[0] < t - FLICKER_WINDOW_MS) poseFlips.shift();

      const handAim = st?.mode === 'aim' && st.source === 'hand';
      const atEdge = handAim && (Math.abs(st.x) >= EDGE_NDC || Math.abs(st.y) >= EDGE_NDC);
      edgeSince = atEdge ? (edgeSince ?? t) : null;

      if (handAim) wasAiming = true;
      if (visible.length) lostSince = null;
      else if (wasAiming) lostSince ??= t;
      // A lowered hand ends "aiming"; only a hand vanishing mid-aim is "lost".
      if (visible.length && !raised.length) wasAiming = false;

      let now = null;
      if (lostSince !== null && t - lostSince >= LOST_MS) now = 'lost';
      else if (edgeSince !== null && t - edgeSince >= EDGE_MS) now = 'edge';
      else if (poseFlips.length >= FLICKER_TOGGLES) now = 'flicker';
      if (now) {
        hint = { key: now, text: HINTS[now] };
        hintUntil = t + HINT_HOLD_MS;
      } else if (t >= hintUntil) {
        hint = null;
      }
      if (lostSince !== null && t - lostSince > 10000) wasAiming = false; // stop nagging an empty room
      return hint;
    },
    reset() {
      poseFlips = [];
      lastPose = null;
      edgeSince = null;
      lostSince = null;
      wasAiming = false;
      hint = null;
      hintUntil = -Infinity;
    }
  };
}

const idOf = (c) => c?.id ?? c?.part ?? null;

export function nextInStack(hits, current) {
  if (!hits?.length) return null;
  const i = hits.findIndex((h) => idOf(h) === current || h === current);
  return i < 0 ? hits[0] : hits[(i + 1) % hits.length];
}

export function createSelector({
  holdMs = SELECT_HOLD_MS, steadyPx = SELECT_STEADY_PX, bubblePx = BUBBLE_PX,
  switchRatio = BUBBLE_SWITCH_RATIO, releasePx = SELECT_RELEASE_PX
} = {}) {
  // Steadiness and release are measured in units of `steadyPx` (spanPx below), so
  // steadySpans 1 = steadyPx per 200 ms and releaseSpans = releasePx / steadyPx.
  const gateOptions = {
    tiers: { select: 'ring' }, ringMs: holdMs, steadySpans: 1, releaseSpans: releasePx / steadyPx,
    releaseOnUnsteady: false, repeatWindowMs: 0
  };
  let gate = createHoldGate(gateOptions);
  let current = null; // id of the current target
  // After any click (a pinch too), the clicked target must not also fire by hold while the
  // cursor rests on it: blocked until the cursor moves releasePx or the target changes.
  let blocked = null; // { id, x, y }

  function pick(candidates) {
    if (!candidates?.length) return null;
    const hit = candidates.find((c) => c.hit);
    if (hit) return hit;
    let best = null;
    let cur = null;
    for (const c of candidates) {
      if (!(c.distPx <= bubblePx)) continue;
      if (!best || c.rankPx < best.rankPx) best = c;
      if (idOf(c) === current) cur = c;
    }
    if (cur && best !== cur && !(best.rankPx < switchRatio * cur.rankPx)) return cur;
    return best;
  }

  return {
    update({ candidates = [], cursorPx = null, t = performance.now(), canHold = true } = {}) {
      const target = cursorPx ? pick(candidates) : null;
      const id = idOf(target);
      // A new target restarts the ring from zero (and clears "held": a different part may be
      // selected straight away).
      if (id !== current) gate.reset();
      current = id;
      if (blocked && (id !== blocked.id || !cursorPx || Math.hypot(cursorPx.x - blocked.x, cursorPx.y - blocked.y) >= releasePx)) blocked = null;
      const s = gate.update({
        pose: target && canHold && !blocked ? 'select' : null,
        confidence: 1,
        wristPos: cursorPx,
        spanPx: steadyPx,
        timestampMs: t
      });
      return {
        target,
        progress: s.progress,
        visibleProgress: s.visibleProgress,
        phase: s.phase,
        fired: s.fired ? target : null
      };
    },
    get current() { return current; },
    // A click just landed at cursorPx (CSS px) on the current target.
    block(cursorPx) {
      if (current !== null && cursorPx) blocked = { id: current, x: cursorPx.x, y: cursorPx.y };
      gate.reset();
    },
    reset() {
      gate = createHoldGate(gateOptions);
      current = null;
      blocked = null;
    }
  };
}

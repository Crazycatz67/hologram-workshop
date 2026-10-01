// Cody-I, 2026-10-01: proposed fix for manipulator.js (NOT applied; manipulator.js owner applies).
// Risk found: an aiming hand's same-hand pinch held > ~300 ms starts a GRAB when the pose reads
// as a fist while pinched (index curls with the other three, or MediaPipe says Closed_Fist):
// grab at 367 ms (POINTER_GAP_MS 300 + trigger frames), object moved up to 0.04. With the
// pointer shape kept (gun true) there is no grab. Synthetic hands, test.js bone model.
// Fix verified on a patched in-page copy: 0 grab frames in all 12 pinch cases (400/1000/2000 ms,
// pointer|fist pose x None|Closed_Fist), and a direct pointer -> fist (no pinch) still grabs at
// 367 ms. Needs an owner live probe: if a REAL fist puts the thumb within 0.25 of the index tip,
// pointer -> fist would stay latched until the hand opens.

// 1. Next to `let wasPointing = false;` in createManipulator:
const pinchLatch = new Set();   // handedness of an aiming hand holding a same-hand pinch
const wasGunBy = new Map();     // handedness -> was a pointer on its previous frame
const SAME_PINCH_CLOSE = 0.25;  // = pointer.js SAME_PINCH_CLOSE (export it there and import, ideally)

// 2. In update(), replace
//      const fisted = hands.some((h) => fistOf(h, aspect));
//      const pointing = hands.some((h) => h.pointer?.gun === true);
//    with:
// A same-hand pinch (pointer.js sameHandPinch) is a click, not a grab: a hand that was a pointer
// and is now pinch-closed stays latched until the pinch opens or the hand leaves, and counts as
// still pointing, so the post-pointer gap starts at the release.
for (const h of hands) {
  const k = h.handedness ?? '?';
  const r = h.pinch?.ratio;
  const closed = h.pinch?.pinching === true || (Number.isFinite(r) && r < SAME_PINCH_CLOSE);
  if (closed && (h.pointer?.gun === true || wasGunBy.get(k) || pinchLatch.has(k))) pinchLatch.add(k);
  else pinchLatch.delete(k);
  wasGunBy.set(k, h.pointer?.gun === true);
}
for (const k of [...pinchLatch]) if (!hands.some((h) => (h.handedness ?? '?') === k)) pinchLatch.delete(k);
const latched = (h) => pinchLatch.has(h.handedness ?? '?');
const fisted = hands.some((h) => fistOf(h, aspect) && !latched(h));
const pointing = hands.some((h) => h.pointer?.gun === true || latched(h));
// 3. Clear pinchLatch / wasGunBy in reset() next to `pointerGapSince = null;`.
// Suggested test.js check: script() from 'One-hand selection — same-hand quick pinch' with the
// 'fist' pinch pose held 1000 ms through manipulator.update -> 0 GRAB frames.

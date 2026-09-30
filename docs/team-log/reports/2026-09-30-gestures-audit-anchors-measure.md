# Gestures: audit, anchors and pinch-measure

**Date:** 2026-09-30 · **Authors:** Debbie (verify-only audit), Ricky (design); overseer verified Debbie's code claims by grep and reading · **Status:** audit done; designs await the owner; nothing live-tested with a webcam

## Summary

The v1 gesture page works in tests, but four real bugs turned up (#26-#29) and several feedback gaps. The platform has **no hand gestures at all yet** (mouse and keyboard only, though the action API is ready). Ricky proposes two additions: **anchors** (pin an item or part so it stays put) and **pinch-measure** (measure between two pinched points), plus one shared gesture vocabulary so tools do not clash. Recommendation on the one point where Ricky differs from the owner's idea: **letting go keeps the tape measure; a held thumbs-down undoes it.**

## Audit (Debbie, verify-only)

- v1 gesture page: 7 gestures. `test.html`: **120 passed / 0 failed**. The gesture lab and smoothing lab reproduce the numbers in BUGS.
- Platform: no hand gestures yet.

| Bug | What happens | Where |
| --- | --- | --- |
| #26 | Releasing a tilt or two-hand pinch chains into **explode** ~267 ms later; lowering both hands then flies parts to the full 0.6 offset | `manipulator.js:738-741` |
| #27 | A **fast** reverse of explode fires the clap check and resets pose, scale, explode and part selection, no undo (slow reverse is fine: 0.6 → 0.108) | `manipulator.js:715-719` |
| #28 | Part selection is **never wired** on hologram.html; only `test.js` calls it, so #2's live confirm can't be tried | `manipulator.js:670` |
| #29 | hands.html **leaks a GestureRecognizer** on every camera stop/start (same as #16, fixed only in hologram.js) | `hands.js:34`, `hands.js:51-60` |

Also: stale text at `hologram.js:428`. Feedback gaps: no clap cue; grab, scale and explode look identical; no "explode ready" cue; no cancel.

Fix direction for #26 (owner decision): require a short neutral gap after any release before a two-hand gesture can start, or start explode only from IDLE with no gesture in the last ~400 ms.

## Owner's 5-minute webcam checklist (needed: live hardware)

1. Check fps.
2. Hold a still fist (does it drift?).
3. Tilt, then release (#26: does it explode?).
4. Fast explode reverse (#27: does it clap-reset?).
5. Still open hands (no false gesture).
6. 5 claps (recognised each time?).
7. Camera stop/start x5 on hands.html, watching memory in Activity Monitor (#29).

## Anchors (Ricky's design)

- A **pin flag** per item or part: toggle with **P**, shown with a pin glyph and a steady "pinned" look, undoable, saved in the layout.
- **Automatic hold** of the item and the camera while editing a part. This fixes "dragging a part drags the whole chair" (`objectmode.js:463`).

## Pinch-measure (Ricky's design)

- Aim with the **thumb-index midpoint**; a **snapping reticle** (amber when over inferred surface).
- Pinch A, pinch B (or hold-drag-release). **Rewind ~120 ms** to cancel the point shift caused by the pinching motion itself.
- Estimated accuracy **+/-0.5-1 cm at chair distance**. This is arithmetic, not measured: needs a live probe.
- **Letting go keeps the tape; thumbs-down held 0.6 s undoes.** This differs from the owner's "release removes" idea. Reasons: tracking dropouts would delete measurements, there is nothing to save otherwise, and releasing shifts the point.

## Gesture budget (shared vocabulary)

Shared actions across tools: **aim**, **pinch = place/select**, **fist = grab**, **thumbs-down = undo**. A held **peace sign (about 1 s)** opens a **tool wheel**. Each tool disarms gestures that would clash with it.

## Limits

- Bug reproductions were offline with synthetic hands; the live half needs the owner's webcam.
- Pinch accuracy and the 120 ms rewind are estimates.
- No gesture code was changed in this round.

## Open questions for the owner

1. Should "held in place" apply to **edits only**, or also to upright/floor locks?
2. Tape measure: **keep** on release (recommended) or **peek** (release removes)?
3. Is the **peace-sign tool wheel** OK?
4. Go-ahead to fix #26-#29? (#26's fix direction is a decision.)

## Sources
- `BUGS.md` #26-#29 and file:line references above (overseer verified by grep/reading, 2026-09-30).
- `test.html` 120/0 (Debbie, 2026-09-30).

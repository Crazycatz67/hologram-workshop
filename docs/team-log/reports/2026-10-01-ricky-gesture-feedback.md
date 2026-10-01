# Gesture feedback (owner live run 2026-10-01): causes, options, ranking
*Ricky, 2026-10-01. Research only. Saved by the overseer (Ricky's tools are read-only). Evidence: owner run `docs/testing/runs/session-hologram/2026-10-01_13-18-30.json` (1655 s).*

## Evidence
- **Hand clicks:** same-hand pinch 12 (10 missed), other-pinch 13 (5 missed), hold 5.
- **Selection practice hits:** hold 0/12, same-hand pinch 0/12, other-pinch 3/12, "any" 2/6, with 4 false selects.
- **Resets:** 5 by clap, all after an explode. The run also has 3 "possible accidental explode" flags.
- **Pointer flicker:** 0 episodes.
- **Errors:** 16 `OrbitControls.js:1071` TypeErrors (that is BUGS #53).

## Ranked by value ÷ effort

1. **(a) Hand leaves the frame.** Draw the real hand, with a beam to the cursor. Tiny.
   - Cause: `ghostOffset` shifts the drawn aiming hand so its tip sits behind the cursor. That cursor moves through the reach-mapped palm at about 1.8–2× the hand's motion. See `handsRuntime.js:464-470` and `pointer.js:207-224`.
   - Fix: `offsetOf: null`, with the beam from the real fingertip.
2. **(f) Lasting outline on the selected part.** Small.
   - Cause: `reticle.js:280` `createPartHighlight` outlines only the hovered part.
   - Fix: add a second, brighter instance for the selection.
3. **(f) Polygon brush size controls.** Tiny.
   - The size already exists: `platform/polygon.js:60`, 12–400 px, mouse wheel.
   - Fix: add `[`/`]` keys and a size readout. For hands, use the other hand's pinch-spread.
4. **(b) Measuring needs the other-hand pinch.** Tiny.
   - Accept only `via: 'other-pinch'` while the tape is on. It is the most precise click (3.6 px median shift).
5. **(e) Clap.** Small.
   - Causes:
     - Spreading the hands sets `explodePulled`, which blocks the clap and still spends it (`manipulator.js:699`, `:1079`, `:1292`).
     - In a fast clap, one hand drops out at contact (`:1068-1073`).
   - Fixes:
     - E1: fire on approach-then-merge.
     - E3: don't spend the clap when it was blocked.
     - E2: a clap during an explode resets. Owner approved.
6. **(a) Sticky pointer pose.** Small.
   - Keep following the aiming hand until a clear Open_Palm, fist or Victory, or 300–400 ms without the pose.
   - Don't reset the filter on a re-entry within 400 ms (`pointer.js:408-441`).
7. **(c) Continuous tilt.** Small–medium.
   - Cause: tilt follows the position of the second hand (`manipulator.js:1208-1224`), so it stops when that hand runs out of room or crosses the lowered line.
   - Fix: hybrid position/rate control, as in RubberEdge (UIST 2007).
8. **(b) Thumb-tap click.** Medium.
   - Use `gunPose.thumbState` with an onset rewind. A/B it in Selection practice; the owner approved it as a trial.
   - Meta advises against using thumb-tap for selection.
9. **(f) Drag to measure.** Medium.
   - Pinch down = point A, hold = a line follows the cursor, release = point B.
   - Needs one coach line to teach it.
10. **(a) MediaPipe confidence thresholds.** Tiny, but the value is unknown.
    - Try presence/tracking at 0.3 instead of 0.5 (`handTracker.js:14-18`).
    - Run it only as a measured A/B.
11. **(d) Vertical scale.** Small.
    - Cause: pinch-scale is uniform (`manipulator.js:771-780`), and the frame has less vertical room.
    - Fix: weight the vertical span ×1.5–2. Owner chose "same zoom range, proportional".
12. **(f) Tool wheel.** Large.
    - Open it at the hand, then keep it fixed in place.
    - Pick items by direction (marking menu).
    - Six items or fewer.

## Also worth noting
- Hold and same-hand pinch both scored 0/12 in practice. Check the size of the practice targets before tuning the click methods.
- Fatigue: raised arms tire quickly. Lowering the reach box toward the chest helps, but conflicts with the "lowered" line.

## Sources
- MediaPipe Gesture Recognizer options: https://developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer/web_js
- MediaPipe hand tracking: https://research.google/blog/on-device-real-time-hand-tracking-with-mediapipe/
- Meta microgestures: https://developers.meta.com/horizon/design/design-microgestures/
- Ultraleap microgestures: https://docs.ultraleap.com/xr-guidelines/Interactions/microgestures.html
- STMG, CHI 2024: https://dl.acm.org/doi/10.1145/3613904.3642702
- RubberEdge: https://arxiv.org/abs/0804.0556
- Meta hands UI best practices: https://developers.meta.com/horizon/design/hands-ui-best-practices/
- Microsoft hand menu: https://learn.microsoft.com/en-us/windows/mixed-reality/design/hand-menu
- Kurtenbach, marking menus (1993): https://www.research.autodesk.com/app/uploads/2023/03/the-design-and-evaluation.pdf_recHpUp1v9dc1n2CJ.pdf

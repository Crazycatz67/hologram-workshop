# Research: Improving Hand Tracking and the Chair Demo

**Compiled 2026-09-29.** Web research plus a read of the v1 gesture engine (`handTracker.js`, `smoothLandmarks.js`, `gestures.js`, `manipulator.js`, `stabilizer.js`, `hologram.js`). This applies to the live chair demo and to the Platform, which reuses the same engine.

## Findings

- **No newer stable MediaPipe exists.** `@mediapipe/tasks-vision` latest stable is still **1.0.1** (what we pin); there is only a 1.1.0-rc nightly. Only one model size ships, so there's no "complexity" setting to tune. [npm](https://registry.npmjs.org/@mediapipe/tasks-vision)
- **Tracker confidence settings are unused.** HandLandmarker/GestureRecognizer options `minHandDetectionConfidence` / `minHandPresenceConfidence` / `minTrackingConfidence` all default to 0.5, and `handTracker.js` sets none of them. The palm detector only runs when tracking is lost. [MediaPipe docs](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)
- **Landmark depth (z) is known to be noisy**, which supports our palm-size depth workaround. [#742](https://github.com/google-ai-edge/mediapipe/issues/742), [#1729](https://github.com/google-ai-edge/mediapipe/issues/1729)
- **One Euro filter** (Casiez et al.): a speed-adaptive low-pass filter. Tuning recipe: set beta = 0, lower `mincutoff` until jitter at rest disappears, then raise beta until fast moves stop lagging. [gery.casiez.net/1euro](https://gery.casiez.net/1euro/)
- **Meta's hand guidelines:** "hands are not controllers"; gate input behind an explicit idle → active pose to stop accidental activation; keep arms near the body; give immediate visual and audio feedback. [Meta](https://developers.meta.com/horizon/design/hands/). Ultraleap says the same: hover/proximity reactions, feedback on focus and activation, and spacing between poses. [Ultraleap](https://docs.ultraleap.com/xr-guidelines/Getting%20started/design-principles.html)

## What the code review found

- **`smoothLandmarks.js` is a fixed EMA** (ALPHA 0.5 per call, not time-based). That's the same frame-rate trap already fixed elsewhere. It is equally laggy at rest and in motion, which means jittery when still and sluggish when fast. It costs ~6% of clap closing speed (2026-09-08 entry).
- **The tracker runs on all defaults:** no confidence settings, and `onTick` polls `video.currentTime` inside the rAF loop.
- **`camera.js` asks for 1280×720.** MediaPipe downsizes internally, so this adds upload cost, not accuracy.
- **One fist still drives move, spin, tilt and push at once.** Practice mode works around this; it doesn't fix it. Free mode still bleeds between channels.
- **No real landmark data has ever been recorded.** Every threshold is a guess validated only on synthetic hands (BUGS #1–3 and #5 are all "needs live confirm").

## Ranked improvements

1. **★ Highest leverage: a record-and-replay harness (M).**
   - **Record:** in `hologram.js` `onTick`, before smoothing, save `{t, hands:[{landmarks, worldLandmarks, handedness, gesture, score}]}` per frame. R toggles recording, with a JSON download, the armed drill, and a "mark" key to label intent ("this was a clap").
   - **Replay:** in `test.js` / a replay page, push the frames through `smoothHandLandmarks` → `pinch` / `isFistLike` → `manipulator.update` using the *recorded* timestamps, so real frame-rate irregularity is preserved.
   - **Report:** jitter at rest, lag (cross-correlation of raw vs filtered wrist speed), recall per gesture, and false triggers per minute during "talking with hands" segments.
   - **Record three sessions:** rest, deliberate reps of each gesture, and natural hand movement. Store them in `assets/recordings/`.

   This turns every later change from a guess into a measured diff, and it means the owner records once and everything else can be tuned offline.
2. **One Euro filter replacing the EMA (S).** Rewrite the loop in `smoothLandmarks.js` with a `dt` taken from real timestamps. Start around mincutoff ≈ 1.0 Hz and beta ≈ 0.01–0.05, filter z harder, and keep the wrist-matching logic. Verify with #1, plus test.js cases for rest jitter, a fast sweep and 24 vs 60 fps.
3. **An explicit "engage" clutch and a rest pose (M). The structural fix for bleeding and misfires.**
   - The model ignores hands until you engage it: open palms held ~0.4 s, or a pinch held ~250 ms. It disengages when the hands leave the frame or after ~2 s idle.
   - Split the fist so it only moves. Spin, tilt and push come from a second-hand modifier or a distinct hand shape: **one pose, one channel**.
   - Where: `manipulator.js` `update()` (near `SWITCH_AWAY_MS`), a `createStabilizer` gate, shown in the HUD.
   - Test: "idle hands don't move the model" in test.js, then a replay of the "talking with hands" recording (target: 0 mode switches).
4. **Two-hand mode lock (M).** Once scale, explode or clap is entered, keep it until both hands leave the pose, with a longer exit than entry. Clap should require both palms open and facing, closing past 1.5 palms from an armed state.
5. **Safer reset than clap (S).** Keep clap, but add "both palms up for 0.8 s", an R key and an on-screen button. Clap needs at least two frames of motion (the 12 fps limit).
6. **Per-user calibration (M).** A 3-second "open hand, pinch, fist" routine sets this user's palm size, pinch range and fist reach, and the thresholds derive from those. Pinch gets hysteresis (enter 0.25, exit ~0.35) in `gestures.js` `pinch`. Push/pull normalises by baseline palm size. Saved to localStorage.
7. **Tracker configuration and camera timing (S).**
   - Detection confidence ≈ 0.6 and tracking confidence 0.5–0.6.
   - Camera at 640×480 or 960×540 with `frameRate: {ideal: 60}` (30 in dim light).
   - `video.requestVideoFrameCallback` for true per-frame timestamps, which the One Euro filter needs.
   - Measure before and after with recordings. Replay can't test this, because it changes the input.
8. **Lost-tracking recovery (S).** Keep a hand's smoothing state for ~200–300 ms after it vanishes, accept it back within a larger radius, and treat a low `score` as no hand.
9. **Feedback and onboarding (M).**
   - Hover state when a hand is near the model, a progress ring while a gesture is "charging" (the stabilizer knows `enterMs`), a soft audio tick on engage/reset, and a "tracking lost" indicator.
   - A first-run walkthrough reusing the practice drills.
   - A low-light warning, and a fatigue hint ("elbows down").
10. **Chair presentation polish (S–M).** A bloom pass so only the rim glows, an idle turntable that pauses during interaction, an eased staged explode, an eased reset tween, a scanline sweep on load, and pixel ratio capped at 2 on the Air.

**Order:** 1 → then 2, 7, 8 (all measurable with 1) → 3, 4 (the bleed fix) → 5, 6 → 9, 10.

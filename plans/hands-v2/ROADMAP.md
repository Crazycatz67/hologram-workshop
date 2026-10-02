# Hands v2: seamless gestures

**Status:** Approved by owner 2026-10-02; round 1 = Phase 0 + Phase 1 design.

## Context
From live use, the owner reports that the hologram works but feels like a test, not a tool. The cursor drags,
clicks and pinches miss, fist and clap are unreliable, tilt drifts, there is no assemble, and gestures fire
while you are trying to do something else. On top of that, nobody can tell which mode they're in, which
gestures work there, or how to get back to normal, and the written instructions make people guess. Photo→3D
gives a flat relief, and the library ring sticks. The ✌ tool wheel is the one thing the owner is proud of,
so it's the model to follow: one deliberate pose, a clear menu, and an obvious result.

Goal: **every function feels natural on the first try.** That means fewer gestures, one way to click, a
cursor that keeps up, gestures that never steal each other's input, teaching by doing instead of reading,
and playful demo holograms that invite exploring.

## Expanded brief (the owner's notes, with the gaps filled)
Root causes are cited from the code audit. Real numbers are from session `2026-10-01_13-18-30`: 42 practice
selections with 5–6 hits, 15 of 30 live clicks missed, and 218 mode changes in 27 minutes.

| # | Owner issue | Root cause found | Fix direction |
|---|---|---|---|
| 1 | Cursor feels heavy, like fighting to pull it | The cursor is the palm centre, not the finger (`pointer.js:161`). It's smoothed twice (landmark One Euro `smoothLandmarks.js:33` + cursor One Euro `pointer.js:94`, ≈65–130 ms lag on slow moves). A fixed absolute reach box means ~56% of the frame for a full screen. The arm must stay above the engage line (`pointer.js:69`). Freezes of 350 ms (sticky) and up to 1.5 s (pinch). | One smoothing stage, tuned by the One Euro method (raise beta). Speed-based gain (slow = precise, fast = far) so small, relaxed arm moves cover the screen. Lower or relax the engage line so the elbow can rest. Remove the long freezes. |
| 2 | Aim isn't straight, you aim like your hand is sideways | No aim direction exists. The beam is drawn from the index tip to a palm-driven cursor (`handsRuntime.js:514`). | A **real finger-gun ray**: direction from the index knuckle to the tip in 3D world landmarks, blended with hand position (Ultraleap far-field method), filtered. Crosshair plus scope line along the true finger. |
| 3 | Click is confusing (gun vs off-hand vs hold); wants to aim and click with the same hand | Four click paths. The thumb "hammer drop" exists but is off by default (`pointer.js:115`). | **One click** = the thumb hammer drop on the gun pose, with the click landing at the aim position from ~120 ms *before* the thumb moved (fixes the aim jump the lab measured). Other-hand pinch and hold stay as accessibility options in settings, off by default. |
| 4 | Pinch unreliable (scale, tape, select) | 2D thumb-to-index gap ÷ 2D palm length, so it breaks when the palm tilts. Vetoed whenever "fist-like" (`gestures.js:83`). No hysteresis. | 3D world-landmark ratio, separate on/off thresholds (≈0.30 on / 0.45 off), short hold, no fist veto, thresholds set per person from calibration. |
| 5 | Fist struggles | Trusts the MediaPipe label; a fist labelled Thumb_Up or Open_Palm always fails (`gestures.js:139`). | Our own finger-curl-angle classifier from world landmarks, voting over the last 5–8 frames. The MediaPipe label is only a hint. |
| 6 | Clap rarely registers, fast or slow | Needs a closing speed above 8 palms/s (slow claps can never pass). Smoothing cuts fast claps. Any 1-frame hand drop or a 100 ms pinch misread wipes it (`manipulator.js:723-761`). | Detect "approach + contact" (span < ~1 palm, or hands merge or one is lost at contact) with a low speed floor, measured on raw wrists. Survives 1–2 dropped frames. Tuned on recorded slow, normal and fast claps. |
| 7 | Explode works, assemble doesn't | Closing your hands only un-explodes inside the same pull. A fast close fires the clap, which **resets** (`manipulator.js:625, 1153`). | Mirror explode exactly: while exploded, closing open hands assembles in proportion to the span, and a clap = snap assembled (not reset). Slow close keeps edits; clap = original (decision above). |
| 8 | Tilt only left/right, drifts | Second hand's 2D wrist x/y → pitch/roll at a *rate* (it keeps turning while held still), with incremental rotations that pile up (`manipulator.js:1292-1328`). | **Full 3D orientation**: build the second hand's palm frame (wrist, index knuckle, pinky knuckle in world landmarks) as a quaternion and apply the *change since grab* 1:1 (position control). Any angle or spin follows the hand, it stops when the hand stops, with smooth blending. |
| 9 | Scale top/bottom not as intended | Vertical spread = the same uniform scale with 1.75× gain (`manipulator.js:1365`). | Vertical = height-only stretch (decision above). |
| 10 | Calibration not accurate; should measure hand size, and drills should tune it | Measures palm px but nothing uses it. Drills are recorded, never fed back (`calibrate.js`). | Calibration v2: measure hand size (palm + finger lengths, 3D), reach and distance. Drills **fit** your thresholds (pinch on/off, hammer-drop gap, cursor gain) and show before/after. "Quick tune-up" anytime. Thresholds saved per person. |
| 11 | Other inputs fire while you're doing the intended one | Pointer, manipulator and wheel all read the same hands every frame (`handsRuntime.js:533-542`). | **One owner at a time**: an input state machine (Idle → Aim / Manipulate / Tool). Each mode turns on only its own gestures. A hand-outline colour and the chip show what the system thinks you're doing. |
| 12 | Don't know which mode I'm in, what it does, which gestures work | The chip shows hand states only. Help is incomplete and differs per page. The landing page describes the tape wrongly. "Try it" links do nothing. | The chip always names the active tool. A live **gesture legend** for the current mode only (2–3 mini guide-hand animations). One gesture registry generates Help, legend and landing cards, so they can't drift apart. |
| 13 | After picking a tool, no way back to normal without the wheel | Each slot is a toggle. There is no exit. | A universal **Done gesture** (one open palm held still for ~0.6 s) plus an on-screen Done button that a hand can click. |
| 14 | Instructions get pushed away; reading them is awful | The card's × is hand-clickable by an accidental pinch, and nothing brings it back. The text makes you interpret it. | **Learn by doing**: each mode/game opens a 10-second "watch → copy → ✓" with the guide hand and your ghost hand side by side. The game waits for your first success. Instructions collapse to a "?" tab, never vanish. Text is ≤1 line. |
| 15 | Games: fist moves left/right only, inaccurate | Games pass x+y, but the Platform drops y (`platform/hands.js:405`). Fist detection (#5) and conflicts (#11) cause the rest. | Fixed by #5/#11; Platform fist gets vertical movement; verify each game live. |
| 16 | Library ring sticks | Lead cap 1.5 cards, speed cap 2.8 cards/s (`ring.js:78-84`); fist-drag only; versions keyboard-only. | **Swipe** (open-hand flick, with momentum) to scroll; **pick up** a card (pinch or grab) to open it; vertical swipe = versions; remove the caps. |
| 17 | Undo is a lot of work | hologram.html undo only reverses a reset (1 step). Platform undo = ✌ hold + aim + click. | Real multi-step undo on every page (move, tilt, scale, explode, tape, pins). One quick gesture (👎, already used in games) + wheel ↑ + Ctrl+Z, the same everywhere. |
| 18 | Tape hard to be accurate; model moves; pinch misses | The model isn't frozen in tape mode; each point needs an other-hand pinch. | Tape mode **freezes the model**. Snap to surface with a magnifier loupe. Points placed with the one click. Live distance. Points can be dragged to fix. |
| 19 | Pins: couldn't figure them out | 3 steps; 📌 means "pin" on the Platform but "note" in hologram. | One meaning everywhere. Pin = wheel ↖ on whatever is under the crosshair (1 step). Taught by a mini lesson. |
| 20 | Polygon lens hard to reach / untested | Hide/mark are keyboard-only. | A small hand-clickable action bar next to the lens (Hide, Mark inferred, Undo, Done). |
| 21 | Tool wheel: picking is a little hard; when to use what | Fixed slot angles, small targets. | Bigger slices with magnetism; labels say what the tool is *for*; the same slots on every page; the Done slot is always at the centre. |
| 22 | Photo→3D is flat, no depth, no detail | The browser does a depth-relief (Depth-Anything, front only). Local TripoSR at marching cubes 256, CPU. | Spike the free MIT models on the M5: **TripoSG** and **TRELLIS.2 (trellis-mac)** vs TripoSR on the same 5 photos. Keep the best. Add a localhost-only "Make real 3D" button driving the local script. |
| 23 | Wants playful, interactive demos | Only furniture plus a teapot and vase. The chess GLB isn't registered. | A **fruit bowl** where explode scatters the fruit everywhere, each fruit is grabbable and you can assemble it back. Plus more (see Phase 5). |

## Owner decisions (2026-10-02)
- **Click** = finger-gun thumb hammer drop. The click lands at the aim position from just before the thumb moved. Off-hand pinch and hold become optional settings, off by default.
- **Done / back to normal** = **one** open palm facing the camera, held still ~0.6 s, with a filling ring, plus a hand-clickable Done button. The arbiter must tell it apart from explode (two open hands *moving apart*) and from the start of a swipe (moving), so Done requires stillness and exactly one hand.
- **Scale**: horizontal spread = uniform size. **Vertical spread = stretch height only** (non-uniform Y scale), shown with a height readout. The tape and measurements use the stretched size. One-tap "reset proportions" in undo.
- **Assemble**: while exploded, a slow close reverses the explode and **keeps part edits**. A **clap = snap to the original** untouched model. Outside explode, the clap stays reset view. Both are undoable.

- **Tilt** (owner 2026-10-02): the second hand's 3D angle is copied with a **1.5× boost** (no boost on tiny moves; adjustable in settings). **Ratchet**: close the second hand, return the wrist, open and turn again, while the fist keeps holding the model. **Flick to spin**: a quick twist then release keeps turning with friction; grabbing again stops it. A soft ~80° limit on tipping up/down; left/right spin is unlimited. No turning while the hand is held still. Done snaps the model upright.

## Plan (rounds; the overseer keeps the cross-cutting design + arbitration)

> **Owner 2026-10-02:** Phase 0 is postponed to the end. The owner records clips only once everything works; until then, tuning uses research numbers, synthetic + semi-real fixtures, calibration v2 and live checks.

**Phase 0 – Measure before tuning (owner, ~10 min, + Cody).** The replay lab has *no real owner clips*,
so every threshold today is a guess. Add a "record my gestures" page to the replay lab (localhost only):
it prompts each gesture (point, hammer click, pinch, fist, open, clap slow/normal/fast, tilt any way,
spread/close, swipe), 5× each, plus "near misses". Landmarks only, no video. The recorded clips become the
ground-truth set for every fix below. Reuse `docs/lab/gestures/replay-lab` + `sessionrec.js` recording.

**Phase 1 – Input core.** Overseer designs the contract; Cody builds; Debbie breaks it.
- New `handFeatures.js`: 3D world-landmark features (palm frame quaternion, finger curl angles, pinch
  ratio, thumb hammer angle), hand size, and per-gesture voting over recent frames. Replaces the 2D logic in
  `gestures.js` (keep its exports as thin wrappers so the games and labs keep working).
- New `inputArbiter.js`: one owner at a time (Idle / Aim / Manipulate / Tool / Mode-scoped), replacing the
  parallel calls in `handsRuntime.js:533-542`. Modes register their allowed gestures.
- `pointer.js`: finger-gun ray + speed-based gain + a single One Euro stage; hammer click with ~120 ms
  rewind; remove the sticky and pinch freezes; settings for the accessibility clicks.
- `manipulator.js`: quaternion tilt (position control), symmetric explode/assemble, new clap detector,
  scale per the decision, fist from the new classifier.
- `calibrate.js` v2: hand size + reach + drills that fit thresholds. Store a profile (existing
  `hologram.pointerProfile.v1` → v2).
- Gate: every lab + test.html green **and** replay of the owner's clips ≥95% recall, ≤2% false triggers
  per gesture.

**Phase 2 – Modes & controls.** Cody-U style UI slice + Tony.
- Active-tool chip, the universal Done gesture/button, unified wheel slots and meanings on hologram + Platform.
- Real undo history on hologram.html, 👎 quick undo everywhere.
- Tape: freeze + snap + loupe + draggable points. Polygon action bar. One-step pin.
- Ring: swipe with momentum, pick-up to open, vertical swipe = versions, no caps. Platform fist gets y.

**Phase 3 – Teach by doing.** Cody-GH (guide hand) + Tony for wording.
- `gestureRegistry.js` as the single source for Help, legend, landing cards and the wheel labels.
- A "watch → copy → ✓" mini lesson per mode and per game (guide hand + live ghost hand + success check),
  auto on first use, ▶ replay later. Wire the `#try=` deep links.
- Game cards collapse to "?" and can't be closed by a stray pinch. Each game waits for the first success.
- Fix landing text that disagrees with the code (tape, undo).

**Phase 4 – Photo→3D upgrade.** Ricky spike + Cody; heavy CPU, run alone.
- Bench TripoSG / TRELLIS.2 (mac port) / TripoSR on 5 photos: depth, detail, time, peak memory on 16 GB.
  Licences: MIT only. Avoid Hunyuan (licence excludes regions) and SPAR3D unless needed.
- Wire the winner into `completion/photo3d.py`, plus a localhost-only "Make real 3D" button. Keep the
  "inferred" marking.

**Phase 5 – Playground holograms.** Cody builds GLBs via `assets/samples/build_samples.py`. One named,
untransformed mesh per part (`manipulator.js:337` constraint).
- **Fruit bowl**: explode scatters the fruit, grab/spin each one, assemble back. Bonus: slice an apple
  with the polygon lens to see inside.
- **Clockwork/engine** with gears that spin when you twist; **layered Earth or building** (explode
  floors/layers, which fits the architectural platform goal); **chess set** (register the existing
  `assets/chess/chess.glb`); **low-poly animal** to try the polygon lens on.
- Each demo has a 30-second "try this" challenge built from the Phase 3 lessons.

**Phase 6 – UI polish + log.** Tony touch-up (top bar at 1400 px, consistent wording), Timmy full pass,
Randy logs, team-retro.

## First round, if this plan is approved
Phase 0 (Cody builds the clip recorder; the owner records about 10 minutes) runs in parallel with Phase 1
design: the overseer writes the `handFeatures`/`inputArbiter` contract and Ricky checks the One Euro and
gain values against the research. Phases 1–6 then follow as separate rounds, each ending with Timmy GREEN,
a report and an owner live check. Nothing gets pushed without asking.

## Critical files
`pointer.js`, `gestures.js`, `gunPose.js`, `smoothLandmarks.js`, `handsRuntime.js`, `manipulator.js`,
`calibrate.js`, `toolWheel.js`, `hologram.js`, `measurePanel.js`, `platform/hands.js`, `platform/main.js`,
`platform/polygon.js`, `ring.js`, `demos/playground.js`, `play.html`, `guideHand/`, `samples.js`,
`completion/photo3d.py`; new `handFeatures.js`, `inputArbiter.js`, `gestureRegistry.js`.

## Verification
- Per round: Timmy's full pass (test.html, gesture/gun/holdgate/replay/smoothing labs, library/ring/p5/
  polygon/hands tests, 0 console errors on every page). The replay gate on the **owner's own clips** is
  the main acceptance number for Phase 1.
- Before/after numbers from shadow sessions (`docs/testing/runs/`): click hit rate (today ~50%),
  accidental mode changes, clap recall, time to complete each mini lesson.
- A short live owner checklist per phase (≤10 min). Nothing committed until Timmy is GREEN. Push only
  with the owner's go-ahead.

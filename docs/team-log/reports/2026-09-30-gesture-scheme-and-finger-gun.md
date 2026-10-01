# Gesture scheme (Engage → Aim → Act) and the finger gun

Date: 2026-09-30. Author of the research: Ricky (two reports merged by the overseer). Written up by Randy. Follows [Gestures: audit, anchors and pinch-measure](2026-09-30-gestures-audit-anchors-measure.md).

## Summary

The owner chose a new gesture scheme, **Engage → Aim → Act**: raise your hands to engage, hover to target, then act through one of three timing tiers. Pointing uses a **finger gun** as a remote-style cursor. Whether the click is a thumb drop or a pinch is **not decided**: a 2-minute webcam probe (built, self-tested 29/0, not yet run live) settles it. The hold timing comes from the ASL project's "ring", which improved offline letter accuracy but has never been felt live. The bug fixes from the audit are done; wiring the new scheme into the page is waiting on the probe.

## The scheme (owner decisions, 2026-09-30; in `plans/platform/ROADMAP.md`)

- **Engage:** raise hands to engage. **Aim:** hovering = target. **Act:** a pose does something.
- About 400 ms neutral gap between poses.
- Three tiers: instant; short (150-250 ms); ring (about 650 ms, hidden for the first 200 ms).
- 2 s repeat window. At most 6 poses. Either hand.
- Clap kept, but safe and undoable.
- Finger-gun pointer, remote-style cursor; click decided by the probe.
- One-hand pinch retired for select. Peace sign held about 0.65 s = tool wheel. Thumbs-down = undo.
- Pins protect against edits only. Polygon lens is non-destructive. Measuring keeps its tapes.

## Where the ring idea comes from (ASL project)

| Fact | Value |
| --- | --- |
| Hold time (`spellgate.js`) | 650 ms |
| Confidence threshold | 0.8 |
| Grace period | 300 ms |
| Behaviour | held until release |
| Offline letters correct | 75% → 83% |
| Offline doubled letters | 3% → 0% |
| Offline words | 0/8 → 8/8 |

Limit: these are offline replays. **Never felt live.**

## Prior art used

- Kinect: engagement zone and at most 6 gestures.
- MRTK (HoloLens): palm ray plus point-and-commit.
- Meta: hysteresis and a minimum time in a state.
- Raskin quasimodes; Sellen, Kurtenbach and Buxton (1992): hold-to-mode.
- Guiard: two-hand division of labour.
- Wolf (CHI 2020) "Heisenberg": rewind the onset of a gesture so the click does not move the cursor.

## Overlaps found in the current gestures

| ID | Overlap | Status |
| --- | --- | --- |
| O1 | Tilt/scale vs explode (#26) | fixed (400 ms gap + 100 ms relaxed hands) |
| O2 | Explode reverse vs clap (#27) | fixed (clap only from rest/outside the gap) |
| O3 | Spinning fist vs thumbs | open |
| O4 | Gun vs fist / thumbs-up | open; `isFistLike()` reads a gun as a grab with label None, must be fixed before wiring |
| O5 | Pinch select vs scale | pinch retired for select |
| O6 | Tap vs drag | open |
| O7 | Tilt by the second hand | open |
| O8 | Pinch flicker (no hysteresis) | open |
| O9 | Peace sign vs passing shapes | covered by the 0.65 s hold |
| O10 | Thumbs-up vs thumbs-down | open |
| O11 | Fist moves scene or object | target decided by hover |
| O12 | Dragging a part drags the whole item | pins (edit protection) |

"Open" here means the list did not record a fix; it is not a statement that nothing was done.

## Gaps found

- No gesture for redo, hide, show all, pin, units, exit or deselect: the tool wheel takes these.
- No feedback for clap, explode-ready or the tilt hand.
- Grab, scale and explode look identically bright.
- No sound.
- No undo on v1: now fixed for reset (one step, U / Ctrl+Z).

## The finger gun

**Why not a finger ray:** pointing rays from the finger fail in practice (Vogel and Balakrishnan 2005: 22.5% errors vs 3.5% for the better technique). HoloLens uses a palm ray instead.

**Design:**
- Palm-driven relative cursor with PRISM-style gain and a clutch (lift to reposition).
- Click: thumb drop, with the onset rewound (Wolf) so the cursor does not jump; other-hand pinch as a precision alternative.
- Reticle snap states; amber over inferred geometry; photosafe hysteresis (no flashing).

**Uses, ranked:** measure, far select, notes, laser demo, far grab, hide/pin, focus, polygon lens, wheel, floor place.

## Built so far (all verified by the overseer)

| Piece | Result |
| --- | --- |
| `gunPose.js` + `docs/lab/gestures/gun-lab.html/.js` (Cody) | self-test 29/0 (re-ran 29/0) |
| `holdGate.js` + `holdgate-lab.*` (Cody-3) | 19/0 (re-ran 19/0) |
| Gesture bug fixes #26-#28 (Debbie) | `test.html` 153/0 (was 120/0); #29 needs a live confirm |

Deviation in `holdGate.js`: wrist motion does **not** release a held command, because a wiggle re-fired undo twice in the lab. The same one-frame-early bug exists in ASL `spellgate.js` (not changed there).

## The probe and its decision rule

2 minutes, guided, webcam. **Thumb drop wins only if all hold:**
- median palm shift at most 0.015 frame units (about 11 px);
- p90 at most 0.03;
- at most 1.5 times the pinch shift;
- 4 of 5 drops seen in each orientation;
- gun detected on at least 80% of still frames.

If it fails, the click falls back to the pinch (with hysteresis) or the other-hand pinch.

## Not tested / limits

- The probe has not been run; no live result exists for the gun, the ring timing in this project, or #29.
- Prior-art figures are from Ricky's research; the overseer did not re-check the papers.
- The ASL ring gains are offline only.

## Open questions for the owner

1. Run the probe (about 2 minutes)?
2. Keep the direct interrupt above 300 ms? (Debbie)
3. After a big pull-apart, un-exploding takes 0.7-1 s (#11, pre-existing): change it?
4. Wire `holdGate` and the gun into the page once the probe decides?

## Sources

- Vogel and Balakrishnan (2005), distant freehand pointing: finger-ray error rates.
- Raskin, *The Humane Interface*; Sellen, Kurtenbach, Buxton (1992): quasimodes.
- Guiard (1987): bimanual asymmetric division of labour.
- Wolf et al. (CHI 2020): Heisenberg effect and rewind.
- Microsoft MRTK hand ray; Meta hand-tracking guidance; Kinect human interface guidelines.
- Project files: `plans/platform/ROADMAP.md`, ASL `spellgate.js`, `docs/lab/gestures/`.

(Exact URLs were not included in the material handed to me; the full links are in Ricky's source reports.)

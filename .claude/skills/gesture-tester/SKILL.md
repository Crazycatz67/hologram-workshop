---
name: gesture-tester
description: Per-gesture measurement for the hologram's hand controls (move, spin, tilt, push/pull, scale, explode, clap). Drives the shipped gesture pipeline with synthetic hands to find exactly which motions fire each gesture, what bleeds into other channels, and where thresholds, frame rate or jitter make a gesture fail. It writes a report a fixer can act on, then optionally hands off to a fixer and to verification. Use when the owner says "test each gesture", "why doesn't clap/push/spin register", "what bleeds into what", "tune the gestures", or asks for a per-gesture report.
---

# gesture-tester: measure each gesture → fix its exact failures → verify

This is the hologram analogue of the ASL project's `letter-tester`. The owner's request is to
learn exactly when each gesture registers and exactly where it struggles, then fix those exact
failures.

**Honest boundary: synthetic ≠ real webcam.** The harness feeds hand-built landmark sets
(geometry from test.js's `hand()`, with fingertips placed properly) through the SHIPPED
pipeline, in hologram.js's order:
`smoothHandLandmarks → gestures.pinch / isFistLike → manipulator.update(hands, aspect, t)`.

It measures what the code does given known motions. It cannot show:
- real MediaPipe label flicker (Closed_Fist↔None across frames)
- real jitter spectra
- dropouts or crossing hands
- how a real person actually moves

Every number is a statement about the code. Feel stays "needs live confirm" (see BUGS #5).

## The harness (one script does the measuring)

`docs/lab/gestures/gesture-lab.html` loads `gesture-lab.js`. Open
`http://localhost:8080/docs/lab/gestures/gesture-lab.html` in your own Chrome tab (the dev
server must be up; see `hologram-livelab` step 1). It runs in a few seconds and is deterministic
(seeded RNG, fixed timestamps), so before/after diffs are real. `?only=spin,clap` scopes the
per-gesture sweeps.

Output:
- `window.__gestureReport` holds the JSON.
- `window.__gestureReportMd` holds the markdown, also rendered in the page's `<pre>`.

If `javascript_tool` returns `[BLOCKED…]` for the big string, read it with `get_page_text` or
pull out individual JSON fields.

Per canonical gesture (`MOTIONS` in the script), it measures:
- **isolated**: only that channel armed (practice mode). Does it fire, how much, and first-active latency.
- **allArmed / bleed**: every channel armed. Which other channels also produced a visible effect.
- **speed sweep**: the same amplitude over 0.05–8s. Slow failures show where the deadzone bites; fast failures show the rate caps.
- **amplitude sweep**: 5–100% of the canonical motion. The smallest motion that registers.
- **frame-rate sweep**: 10/15/24/30/60fps for the same real motion.
- **jitter sweep**: 0–0.008 per-landmark noise. 0.002 is the realistic figure measured earlier.
- **smoothing off**: separates `smoothLandmarks.js` from the manipulator.
- **clap extras**: start-separation arming, fps with smoothing on and off, and one pinch-glitched frame.

It also runs false-fire probes (`NULLS`: still hands, an open-hand slide, a punch fist, a
thumbs-up, a slow bring-together, and so on, with everything armed and momentum on) and a
stationary drift table against jitter.

"Fires" means a visible effect: move more than 1cm sideways, push more than 1cm along the camera
ray, spin or tilt more than 2°, scale more than 3% uniform, explode more than 3% stretch, clap an
exact snap to home. Push is recovered from the z change (move only writes x/y), because raw
camera distance also grows when the object slides sideways. An earlier version logged that as
false push bleed.

Extending it: add a motion to `MOTIONS` (canonical, `motion(u, k)` for progress `u` and amplitude
`k`) or to `NULLS` (with `expect`). Hand specs are `{x, y, twist°, palm, shape: fist|open|pinch,
label}`. `label` overrides the MediaPipe category (for example `'None'` for a punch-orientation
fist that goes through the geometric fallback).

## Stage 1: tester (background agent; read-only on app code)

Brief:
> Start the dev server if needed, open your own tab, and run gesture-lab.html. Save the previous
> `docs/lab/gestures/report.json` as `report.prev.json` if it exists, then write the new JSON and
> `docs/lab/gestures/REPORT.md`. Put a "For the fixer" section at the top: for each weak gesture,
> say what registers it (the motion envelope from the sweeps), where it fails (ranked, with
> numbers and the constant responsible, file:function), and 1–2 concrete hypotheses. Reproduce
> any suspected code bug independently before logging it to BUGS.md (hologram-bugwatch rules,
> tag `[A-v1]`). Tuning findings go on the existing item (#5 for push/pitch/explode feel), not a
> new one. Do not edit manipulator.js / gestures.js / smoothLandmarks.js. Return a summary of
> 500 words or less, plus the paths.

If the harness can't write REPORT.md (for example, a subagent that isn't allowed to write report
files), return the markdown in the hand-off and let the main session save it.

## Stage 2: fixer (background agent, `isolation: "worktree"`)

Only after stage 1's report exists. Brief:
> Read REPORT.md + report.json and manipulator.js / gestures.js / smoothLandmarks.js /
> stabilizer.js. For the worst failures, make changes that:
> (a) keep every rate per-second, using real `dt` (the project rule; see manipulator.js's header),
> (b) give every continuous channel a deadzone sized from measured jitter, not a guess, and
> (c) don't change a channel's feel beyond what the finding needs.
> Every change needs a before/after from the harness with no other gesture's isolated magnitude
> moving more than 10%, a new test.js case pinning the fixed failure, and test.html at 0
> failures. Mark gesture-feel changes `FIXED (needs live confirm)` in BUGS.md. Commit small on
> your branch, and don't push. Return the branch, the before/after table, and what needs a real
> hand.

## Stage 3: main session (verify, bug report, ship)

1. Merge the fixer branch. Re-run the harness: the fixer's numbers must reproduce.
2. Run test.html (0 failed), with the new cases listed.
3. Update BUGS.md statuses. Anything about feel stays "needs live confirm", and gets a short
   "what to try on the Mac" line: which drill, which motion, what to watch for.
4. Ship through `hologram-verify` (push only with the owner's go-ahead).
5. Tell the owner, per gesture, what moved and what still needs a real hand.

## Report contract (REPORT.md)

- A header that says synthetic, with the date, the settings (aspect, triggerFrames,
  sensitivity) and what "fires" means.
- **For the fixer**: numbered findings, each giving the gesture, the failing envelope with
  numbers, the responsible constant or function, the BUGS.md item number, and a fix direction.
- A summary table: gesture | canonical motion | isolated | bleed | slowest duration that fires |
  smallest amplitude that fires | effect at fps 10→60.
- One section per gesture with the sweep lines, a false-fire probe table, and the stationary
  drift table.
- "Not measured here (needs a real camera)".

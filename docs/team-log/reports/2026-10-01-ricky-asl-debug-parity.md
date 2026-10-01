# Gesture debugging like the ASL project: gap and plan (Ricky, 2026-10-01; saved by the overseer)

**Short answer:** most of the ASL workflow already has a counterpart here:
- the skill pair
- auto-flags
- synthetic per-gesture sweeps
- a clip recorder

The real gap is **real-hand data**. ASL scores every letter on held-out recorded real hands. The hologram project has 0 recorded clips, and sessionrec keeps no landmarks, so a flagged live session can't be replayed.

## How ASL does it
- **Skills:**
  - asl-verify: ci-check.mjs plus a 164-check selftest, then a VERSION bump.
  - asl-bugwatch: `Bug Reports/checklist.md`; "FIXED (needs live confirm)"; every logic fix gets a selftest check.
  - asl-livelab: work on a shadow branch, served on :8010.
  - letter-tester: tester → fixer → overseer.
- **Real-hand data:** tools/lab/lab-data.mjs splits data/dataset.json 80/20 by recording order, plus a "relaxed" reject class.
- **Per-letter report:** tools/lab/letter-report.mjs gives pass rate, why misses fail, the worst false accept and Spell outcomes. It writes REPORT.md and report.json, has `--compare`, and uses a fixed seed.
- **Stress tests:** probe-axes / probe-thresholds (tilt, jitter, fan, curl, wrong finger); spell-sim (30 fps replay with jitter, sway, dropouts); break-it (NaN, time going backwards).
- **Confusion:** data/confusion.json; ci-check #13f fails if any pair is confused more than 30%.
- **Issue store:** tools/lab/issues.mjs upsertIssue → docs/lab/issues.json + ISSUES.md, deduped, graded P0–P3, each with a repro command.
- **Live bug → test:** a checklist item becomes a dataset or synthetic check. History goes in docs/CHANGELOG.md.

## Gap
| ASL | Hologram | Missing |
|---|---|---|
| verify / bugwatch skills | hologram-* skills exist | Extend them |
| Real hands | clip-lab (21 gestures) | No clips recorded; no "should do nothing" clips |
| letter-report | gesture-lab (synthetic) | Real-clip replay; pointer.js coverage |
| Confusion matrix + gate | gesture-lab bleed | Label × fired matrix and a gate |
| probe-axes | synthetic sweeps | Perturbations of real clips |
| issues.json | FLAGS.md + BUGS.md | Repro / fixture per bug |
| bug → regression check | test.js | Flagged session → fixture |

## Build plan
1. **The owner records clips** in clip-lab: the 21 gestures plus about 6 "should do nothing" clips. About 15 minutes.
2. **Replay harness:**
   - Files: docs/lab/gestures/replay.js and replay-lab.{html,js}.
   - Pipeline: clips → smoothLandmarks → gestures → manipulator + pointer + gunPose + holdGate.
   - Output: per-gesture fires / misses / false fires, a confusion matrix, REPORT.md and report.json, `--compare`.
   - It must run in a browser, because manipulator.js imports `three`.
3. **Stress tests on real clips:** jitter, fps, dropouts, mirrored hands.
4. **Session → fixture:** an opt-in rolling 10 s landmark buffer in sessionrec. When a flag or a guide Fail fires, save a gesture-clip/1 fixture. **Owner decision needed** (privacy scope).
5. **Regression gate:** test.js replays fixtures. Each BUGS entry links its fixture. Add the rule to the skills.
6. **Live debug overlay** (`?debug=hands`): per hand and per frame, show the pinch ratio, fist, gun features and why rejected, the hold-gate state and the active channel.

Also worth considering: dedupe FLAGS.md (upsertIssue-style).

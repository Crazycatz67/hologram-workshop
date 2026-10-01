# Gesture replay report

> **NO REAL CLIPS YET.** assets/gesture-clips/ is empty, so nothing below is the owner's hands. "semi-real" = real human hand SHAPES from the Kaggle ASL alphabet set (via the ASL project; not the owner) moved along scripted paths; "synthetic" = model hands. They prove the harness and where the code's thresholds sit, not how the owner's hands perform. Re-run after the owner records clips in clip-lab.

Generated 2026-10-01T21:49:02.637Z by `docs/lab/gestures/replay-lab.html` (tree cde7592+dirty). Seed 4242. 40 clips × 8 variants (base, jitter-0.003, jitter-0.006, fps-15, fps-30, drop-10, drop-30, mirror) = 320 runs.

Pipeline: smoothLandmarks → gestures.annotateHand → engagement → manipulator.update/tick → pointer (aim, pinch, other-hand click) → toolWheel (✌ holdGate) → undo (👎 holdGate, **modelled: not wired live**) → selector (hold-select on the model centre). "Fires" = gesture-lab thresholds (move >1 cm, push >1 cm, spin/tilt >2°, scale >3% uniform, explode >3% stretch), clap = a reset, aim = cursor shown ≥300 ms. Time to fire = ms from the clip's FIRST frame (includes its lead-in). A set's gate fails if any off-diagonal cell is over 30% of its row's runs (ASL #13f) or any null-* clip fires anything in any run. Matrix: diagonal = expected fired, "nothing" = missed (for `none`: correctly nothing); rows can sum past 100%; allowed side effects (aim before a click) are not counted.

## Overall gate: **FAIL** (semi-real FAIL, synthetic FAIL)

## Set: semi-real — real human hand shapes (Kaggle ASL alphabet via the ASL project dataset), synthetic motion

Gate: **FAIL** (30 clips, 240 runs)

- clap -> explode in 100% of runs (> 30%)
- wheel -> explode in 96% of runs (> 30%)
- none -> explode in 50% of runs (> 30%)
- null clip null-talk.sr1 fired explode in 8/8 runs
- null clip null-talk.sr2 fired explode in 8/8 runs
- null clip null-talk.sr3 fired explode in 8/8 runs

How the shipped gestures.annotateHand reads the source poses (still, frame centre):

| pose | letters | MediaPipe label used | n | read as fist | pinch | pointer |
|---|---|---|---|---|---|---|
| fist | A/S | Closed_Fist | 150 | 100% | 0% | 0% |
| open | B | Open_Palm | 150 | 0% | 0% | 0% |
| victory | V | Victory | 150 | 0% | 0% | 0% |
| pointer | L/G | None | 150 | 0% | 3% | 93% |
| pinch | F | None | 150 | 0% | 90% | 0% |
| thumbdown | A | Thumb_Down | 150 | 0% | 0% | 0% |
| pointer-D | D | None | 150 | 0% | 9% | 20% |

Motion model from real video: per-frame jitter 0.0335 palm lengths (median, an upper bound), shape changes take 3 frames median / 11 p90 (3064 transitions in 300 sequences).

| expected | clips | runs | fires | misses | runs with a false fire | time to fire median / max |
|---|---|---|---|---|---|---|
| grab | 3 | 24 | 24 (100%) | 0 | 0 | 800 / 1017 ms |
| scale | 3 | 24 | 16 (67%) | 8 | 1 | 900 / 950 ms |
| explode | 3 | 24 | 24 (100%) | 0 | 0 | 700 / 733 ms |
| clap | 3 | 24 | 23 (96%) | 1 | 24 | 867 / 933 ms |
| wheel | 3 | 24 | 22 (92%) | 2 | 23 | 1167 / 1400 ms |
| undo (modelled) | 3 | 24 | 24 (100%) | 0 | 0 | 1167 / 1533 ms |
| aim | 3 | 24 | 24 (100%) | 0 | 1 | 300 / 333 ms |
| click | 3 | 24 | 22 (92%) | 2 | 0 | 1033 / 1200 ms |
| none | 6 | 48 | — | — | 24 | — / — ms |

False fires (fired where not expected or allowed): **grab** 1 runs (aim-sweep.sr1); **explode** 72 runs (scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3); **click** 1 runs (wheel-pick.sr3).

| expected \ fired | runs | grab | scale | explode | clap | click | wheel | undo | aim | nothing |
|---|---|---|---|---|---|---|---|---|---|---|
| **grab** | 24 | **100%** | · | · | · | · | · | · | · | · |
| **scale** | 24 | · | **67%** | 4% | · | · | · | · | · | 33% |
| **explode** | 24 | · | · | **100%** | · | · | · | · | · | · |
| **clap** | 24 | · | · | **100%!** | **96%** | · | · | · | · | 4% |
| **wheel** | 24 | · | · | **96%!** | · | 4% | **92%** | · | · | 8% |
| **undo** | 24 | · | · | · | · | · | · | **100%** | · | · |
| **aim** | 24 | 4% | · | · | · | · | · | · | **100%** | · |
| **click** | 24 | · | · | · | · | **92%** | · | · | · | 8% |
| **none** | 48 | · | · | **50%!** | · | · | · | · | · | **50%** |

| variant | pass | failed clips |
|---|---|---|
| base | 20/30 | scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3 |
| jitter-0.003 | 21/30 | scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3 |
| jitter-0.006 | 19/30 | scale.sr1, clap.sr1, wheel-pick.sr1, aim-sweep.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3 |
| fps-15 | 20/30 | scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3 |
| fps-30 | 20/30 | scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3 |
| drop-10 | 19/30 | scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, click-other.sr3, null-talk.sr3 |
| drop-30 | 19/30 | scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, click-other.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3 |
| mirror | 20/30 | scale.sr1, clap.sr1, wheel-pick.sr1, null-talk.sr1, clap.sr2, wheel-pick.sr2, null-talk.sr2, clap.sr3, wheel-pick.sr3, null-talk.sr3 |

## Set: synthetic — synthetic hands (gesture-lab makeHand + gun-lab buildWorldHand), synthetic motion

Gate: **FAIL** (10 clips, 80 runs)

- clap -> explode in 100% of runs (> 30%)
- wheel -> explode in 88% of runs (> 30%)
- none -> explode in 50% of runs (> 30%)
- null clip null-talk fired explode in 8/8 runs

| expected | clips | runs | fires | misses | runs with a false fire | time to fire median / max |
|---|---|---|---|---|---|---|
| grab | 1 | 8 | 8 (100%) | 0 | 0 | 817 / 833 ms |
| scale | 1 | 8 | 8 (100%) | 0 | 0 | 900 / 950 ms |
| explode | 1 | 8 | 8 (100%) | 0 | 0 | 700 / 733 ms |
| clap | 1 | 8 | 7 (88%) | 1 | 8 | 867 / 933 ms |
| wheel | 1 | 8 | 7 (88%) | 1 | 8 | 1133 / 1133 ms |
| undo (modelled) | 1 | 8 | 8 (100%) | 0 | 0 | 967 / 1267 ms |
| aim | 1 | 8 | 8 (100%) | 0 | 0 | 300 / 333 ms |
| click | 1 | 8 | 7 (88%) | 1 | 0 | 1033 / 1067 ms |
| none | 2 | 16 | — | — | 8 | — / — ms |

False fires (fired where not expected or allowed): **explode** 23 runs (clap, wheel-pick, null-talk); **click** 1 runs (wheel-pick).

| expected \ fired | runs | grab | scale | explode | clap | click | wheel | undo | aim | nothing |
|---|---|---|---|---|---|---|---|---|---|---|
| **grab** | 8 | **100%** | · | · | · | · | · | · | · | · |
| **scale** | 8 | · | **100%** | · | · | · | · | · | · | · |
| **explode** | 8 | · | · | **100%** | · | · | · | · | · | · |
| **clap** | 8 | · | · | **100%!** | **88%** | · | · | · | · | 13% |
| **wheel** | 8 | · | · | **88%!** | · | 13% | **88%** | · | · | 13% |
| **undo** | 8 | · | · | · | · | · | · | **100%** | · | · |
| **aim** | 8 | · | · | · | · | · | · | · | **100%** | · |
| **click** | 8 | · | · | · | · | **88%** | · | · | · | 13% |
| **none** | 16 | · | · | **50%!** | · | · | · | · | · | **50%** |

| variant | pass | failed clips |
|---|---|---|
| base | 7/10 | clap, wheel-pick, null-talk |
| jitter-0.003 | 7/10 | clap, wheel-pick, null-talk |
| jitter-0.006 | 7/10 | clap, wheel-pick, null-talk |
| fps-15 | 7/10 | clap, wheel-pick, null-talk |
| fps-30 | 7/10 | clap, wheel-pick, null-talk |
| drop-10 | 6/10 | clap, wheel-pick, click-other, null-talk |
| drop-30 | 7/10 | clap, wheel-pick, null-talk |
| mirror | 7/10 | clap, wheel-pick, null-talk |

## Per clip

- **grab-move** (synthetic): expect grab. base ✓ [grab@817] · jitter-0.003 ✓ [grab@817] · jitter-0.006 ✓ [grab@800] · fps-15 ✓ [grab@833] · fps-30 ✓ [grab@817] · drop-10 ✓ [grab@817] · drop-30 ✓ [grab@817] · mirror ✓ [grab@817]
- **scale** (synthetic): expect scale. base ✓ [scale@900] · jitter-0.003 ✓ [scale@900] · jitter-0.006 ✓ [scale@900] · fps-15 ✓ [scale@933] · fps-30 ✓ [scale@917] · drop-10 ✓ [scale@900] · drop-30 ✓ [scale@950] · mirror ✓ [scale@900]
- **explode** (synthetic): expect explode. base ✓ [explode@700] · jitter-0.003 ✓ [explode@700] · jitter-0.006 ✓ [explode@700] · fps-15 ✓ [explode@733] · fps-30 ✓ [explode@700] · drop-10 ✓ [explode@700] · drop-30 ✓ [explode@700] · mirror ✓ [explode@700]
- **clap** (synthetic): expect clap. base ✗ [explode@733 clap@867] · jitter-0.003 ✗ [explode@733 clap@867] · jitter-0.006 ✗ [explode@533 clap@867] · fps-15 ✗ [explode@733 clap@933] · fps-30 ✗ [explode@733 clap@900] · drop-10 ✗ [explode@733 clap@867] · drop-30 ✗ [explode@733] · mirror ✗ [explode@733 clap@867]
- **wheel-pick** (synthetic): expect wheel (allowed aim). base ✗ [wheel@1133 explode@1317 aim@1567] · jitter-0.003 ✗ [wheel@1133 explode@1317 aim@1567] · jitter-0.006 ✗ [wheel@1133 explode@1317 aim@1567] · fps-15 ✗ [wheel@1133 explode@1467 aim@1600] · fps-30 ✗ [wheel@1133 explode@1317 aim@1567] · drop-10 ✗ [wheel@1033 explode@1333 aim@1567] · drop-30 ✗ [aim@1567 click@2433] · mirror ✗ [wheel@1133 explode@1317 aim@1567]
- **undo** (synthetic): expect undo. base ✓ [undo@967] · jitter-0.003 ✓ [undo@967] · jitter-0.006 ✓ [undo@967] · fps-15 ✓ [undo@1000] · fps-30 ✓ [undo@967] · drop-10 ✓ [undo@1033] · drop-30 ✓ [undo@1267] · mirror ✓ [undo@967]
- **aim-sweep** (synthetic): expect aim. base ✓ [aim@300] · jitter-0.003 ✓ [aim@300] · jitter-0.006 ✓ [aim@300] · fps-15 ✓ [aim@333] · fps-30 ✓ [aim@300] · drop-10 ✓ [aim@300] · drop-30 ✓ [aim@300] · mirror ✓ [aim@300]
- **click-other** (synthetic): expect click (allowed aim, select). base ✓ [aim@300 select@667 click@1033] · jitter-0.003 ✓ [aim@300 select@667 click@1033] · jitter-0.006 ✓ [aim@300 select@667 click@1033] · fps-15 ✓ [aim@333 select@650 click@1067] · fps-30 ✓ [aim@300 select@667 click@1033] · drop-10 ✗ [aim@300 select@667] · drop-30 ✓ [aim@300 select@667 click@1033] · mirror ✓ [aim@300 select@667 click@1033]
- **null-rest** (synthetic): expect none. base ✓ [nothing] · jitter-0.003 ✓ [nothing] · jitter-0.006 ✓ [nothing] · fps-15 ✓ [nothing] · fps-30 ✓ [nothing] · drop-10 ✓ [nothing] · drop-30 ✓ [nothing] · mirror ✓ [nothing]
- **null-talk** (synthetic): expect none. base ✗ [explode@250] · jitter-0.003 ✗ [explode@250] · jitter-0.006 ✗ [explode@217] · fps-15 ✗ [explode@267] · fps-30 ✗ [explode@233] · drop-10 ✗ [explode@250] · drop-30 ✗ [explode@367] · mirror ✗ [explode@250]
- **grab-move.sr1** (semi-real): expect grab. base ✓ [grab@817] · jitter-0.003 ✓ [grab@817] · jitter-0.006 ✓ [grab@800] · fps-15 ✓ [grab@833] · fps-30 ✓ [grab@817] · drop-10 ✓ [grab@817] · drop-30 ✓ [grab@1017] · mirror ✓ [grab@817]
- **scale.sr1** (semi-real): expect scale. base ✗ [nothing] · jitter-0.003 ✗ [explode@2083] · jitter-0.006 ✗ [nothing] · fps-15 ✗ [nothing] · fps-30 ✗ [nothing] · drop-10 ✗ [nothing] · drop-30 ✗ [nothing] · mirror ✗ [nothing]
- **explode.sr1** (semi-real): expect explode. base ✓ [explode@700] · jitter-0.003 ✓ [explode@700] · jitter-0.006 ✓ [explode@683] · fps-15 ✓ [explode@733] · fps-30 ✓ [explode@700] · drop-10 ✓ [explode@700] · drop-30 ✓ [explode@700] · mirror ✓ [explode@700]
- **clap.sr1** (semi-real): expect clap. base ✗ [explode@750 clap@867] · jitter-0.003 ✗ [explode@550 clap@867] · jitter-0.006 ✗ [explode@300 clap@867] · fps-15 ✗ [explode@733 clap@933] · fps-30 ✗ [explode@733 clap@900] · drop-10 ✗ [explode@450 clap@933] · drop-30 ✗ [explode@733 clap@933] · mirror ✗ [explode@750 clap@867]
- **wheel-pick.sr1** (semi-real): expect wheel (allowed aim). base ✗ [wheel@1133 explode@1317 aim@1800] · jitter-0.003 ✗ [wheel@1133 explode@1333 aim@1800] · jitter-0.006 ✗ [wheel@1133 explode@1333 aim@1767] · fps-15 ✗ [wheel@1133 explode@1350 aim@1800] · fps-30 ✗ [wheel@1133 explode@1333 aim@1800] · drop-10 ✗ [wheel@1233 explode@1333 aim@1833] · drop-30 ✗ [explode@1350 wheel@1400 aim@1900] · mirror ✗ [wheel@1133 explode@1317 aim@1800]
- **undo.sr1** (semi-real): expect undo. base ✓ [undo@1133] · jitter-0.003 ✓ [undo@1133] · jitter-0.006 ✓ [undo@1133] · fps-15 ✓ [undo@1200] · fps-30 ✓ [undo@1167] · drop-10 ✓ [undo@1167] · drop-30 ✓ [undo@1333] · mirror ✓ [undo@1133]
- **aim-sweep.sr1** (semi-real): expect aim. base ✓ [aim@300] · jitter-0.003 ✓ [aim@300] · jitter-0.006 ✗ [aim@300 grab@1917] · fps-15 ✓ [aim@333] · fps-30 ✓ [aim@300] · drop-10 ✓ [aim@300] · drop-30 ✓ [aim@300] · mirror ✓ [aim@300]
- **click-other.sr1** (semi-real): expect click (allowed aim, select). base ✓ [aim@300 select@667 click@1033] · jitter-0.003 ✓ [aim@300 select@667 click@1033] · jitter-0.006 ✓ [aim@300 select@667 click@1033] · fps-15 ✓ [aim@333 select@650 click@1067] · fps-30 ✓ [aim@300 select@667 click@1033] · drop-10 ✓ [aim@300 select@667 click@1033] · drop-30 ✓ [aim@300 select@683 click@1033] · mirror ✓ [aim@300 select@667 click@1033]
- **null-rest.sr1** (semi-real): expect none. base ✓ [nothing] · jitter-0.003 ✓ [nothing] · jitter-0.006 ✓ [nothing] · fps-15 ✓ [nothing] · fps-30 ✓ [nothing] · drop-10 ✓ [nothing] · drop-30 ✓ [nothing] · mirror ✓ [nothing]
- **null-talk.sr1** (semi-real): expect none. base ✗ [explode@250] · jitter-0.003 ✗ [explode@233] · jitter-0.006 ✗ [explode@233] · fps-15 ✗ [explode@300] · fps-30 ✗ [explode@267] · drop-10 ✗ [explode@250] · drop-30 ✗ [explode@250] · mirror ✗ [explode@250]
- **grab-move.sr2** (semi-real): expect grab. base ✓ [grab@683] · jitter-0.003 ✓ [grab@667] · jitter-0.006 ✓ [grab@750] · fps-15 ✓ [grab@800] · fps-30 ✓ [grab@800] · drop-10 ✓ [grab@717] · drop-30 ✓ [grab@817] · mirror ✓ [grab@683]
- **scale.sr2** (semi-real): expect scale. base ✓ [scale@900] · jitter-0.003 ✓ [scale@900] · jitter-0.006 ✓ [scale@900] · fps-15 ✓ [scale@933] · fps-30 ✓ [scale@917] · drop-10 ✓ [scale@900] · drop-30 ✓ [scale@900] · mirror ✓ [scale@900]
- **explode.sr2** (semi-real): expect explode. base ✓ [explode@700] · jitter-0.003 ✓ [explode@700] · jitter-0.006 ✓ [explode@700] · fps-15 ✓ [explode@733] · fps-30 ✓ [explode@700] · drop-10 ✓ [explode@700] · drop-30 ✓ [explode@700] · mirror ✓ [explode@700]
- **clap.sr2** (semi-real): expect clap. base ✗ [explode@667 clap@867] · jitter-0.003 ✗ [explode@183 clap@867] · jitter-0.006 ✗ [explode@317 clap@867] · fps-15 ✗ [explode@433 clap@933] · fps-30 ✗ [explode@400 clap@900] · drop-10 ✗ [explode@750 clap@867] · drop-30 ✗ [explode@667] · mirror ✗ [explode@667 clap@867]
- **wheel-pick.sr2** (semi-real): expect wheel (allowed aim). base ✗ [aim@1067 wheel@1267 explode@1317] · jitter-0.003 ✓ [aim@1067 wheel@1267] · jitter-0.006 ✗ [wheel@1267 aim@1300 explode@1317] · fps-15 ✗ [aim@1133 wheel@1267 explode@1350] · fps-30 ✗ [aim@1200 wheel@1267 explode@1333] · drop-10 ✗ [aim@1133 wheel@1200 explode@1317] · drop-30 ✗ [aim@833 explode@1317] · mirror ✗ [aim@1067 wheel@1267 explode@1317]
- **undo.sr2** (semi-real): expect undo. base ✓ [undo@1167] · jitter-0.003 ✓ [undo@1167] · jitter-0.006 ✓ [undo@1167] · fps-15 ✓ [undo@1200] · fps-30 ✓ [undo@1167] · drop-10 ✓ [undo@1267] · drop-30 ✓ [undo@1533] · mirror ✓ [undo@1167]
- **aim-sweep.sr2** (semi-real): expect aim. base ✓ [aim@300] · jitter-0.003 ✓ [aim@300] · jitter-0.006 ✓ [aim@300] · fps-15 ✓ [aim@333] · fps-30 ✓ [aim@300] · drop-10 ✓ [aim@300] · drop-30 ✓ [aim@300] · mirror ✓ [aim@300]
- **click-other.sr2** (semi-real): expect click (allowed aim, select). base ✓ [aim@300 select@667 click@1033] · jitter-0.003 ✓ [aim@300 select@667 click@1033] · jitter-0.006 ✓ [aim@300 select@667 click@1033] · fps-15 ✓ [aim@333 select@650 click@1067] · fps-30 ✓ [aim@300 select@667 click@1033] · drop-10 ✓ [aim@300 select@667 click@1033] · drop-30 ✗ [aim@300 select@667] · mirror ✓ [aim@300 select@667 click@1033]
- **null-rest.sr2** (semi-real): expect none. base ✓ [nothing] · jitter-0.003 ✓ [nothing] · jitter-0.006 ✓ [nothing] · fps-15 ✓ [nothing] · fps-30 ✓ [nothing] · drop-10 ✓ [nothing] · drop-30 ✓ [nothing] · mirror ✓ [nothing]
- **null-talk.sr2** (semi-real): expect none. base ✗ [explode@250] · jitter-0.003 ✗ [explode@233] · jitter-0.006 ✗ [explode@217] · fps-15 ✗ [explode@333] · fps-30 ✗ [explode@300] · drop-10 ✗ [explode@250] · drop-30 ✗ [explode@433] · mirror ✗ [explode@250]
- **grab-move.sr3** (semi-real): expect grab. base ✓ [grab@800] · jitter-0.003 ✓ [grab@800] · jitter-0.006 ✓ [grab@717] · fps-15 ✓ [grab@783] · fps-30 ✓ [grab@800] · drop-10 ✓ [grab@883] · drop-30 ✓ [grab@800] · mirror ✓ [grab@800]
- **scale.sr3** (semi-real): expect scale. base ✓ [scale@900] · jitter-0.003 ✓ [scale@900] · jitter-0.006 ✓ [scale@900] · fps-15 ✓ [scale@950] · fps-30 ✓ [scale@917] · drop-10 ✓ [scale@900] · drop-30 ✓ [scale@917] · mirror ✓ [scale@900]
- **explode.sr3** (semi-real): expect explode. base ✓ [explode@700] · jitter-0.003 ✓ [explode@700] · jitter-0.006 ✓ [explode@700] · fps-15 ✓ [explode@733] · fps-30 ✓ [explode@700] · drop-10 ✓ [explode@700] · drop-30 ✓ [explode@700] · mirror ✓ [explode@700]
- **clap.sr3** (semi-real): expect clap. base ✗ [explode@733 clap@867] · jitter-0.003 ✗ [explode@733 clap@867] · jitter-0.006 ✗ [explode@617 clap@867] · fps-15 ✗ [explode@733 clap@933] · fps-30 ✗ [explode@733 clap@900] · drop-10 ✗ [explode@733 clap@867] · drop-30 ✗ [explode@733 clap@867] · mirror ✗ [explode@733 clap@867]
- **wheel-pick.sr3** (semi-real): expect wheel (allowed aim). base ✗ [wheel@1167 explode@1317 aim@1600] · jitter-0.003 ✗ [wheel@1167 explode@1317 aim@1600] · jitter-0.006 ✗ [wheel@1167 explode@1317 aim@1600] · fps-15 ✗ [wheel@1133 explode@1167 aim@1600] · fps-30 ✗ [explode@350 wheel@1167 aim@1600] · drop-10 ✗ [explode@1317 aim@1633 click@2533] · drop-30 ✗ [wheel@1267 explode@1317 aim@1600] · mirror ✗ [wheel@1167 explode@1317 aim@1600]
- **undo.sr3** (semi-real): expect undo. base ✓ [undo@967] · jitter-0.003 ✓ [undo@967] · jitter-0.006 ✓ [undo@967] · fps-15 ✓ [undo@1000] · fps-30 ✓ [undo@967] · drop-10 ✓ [undo@1067] · drop-30 ✓ [undo@1300] · mirror ✓ [undo@967]
- **aim-sweep.sr3** (semi-real): expect aim. base ✓ [aim@300] · jitter-0.003 ✓ [aim@300] · jitter-0.006 ✓ [aim@300] · fps-15 ✓ [aim@333] · fps-30 ✓ [aim@300] · drop-10 ✓ [aim@300] · drop-30 ✓ [aim@300] · mirror ✓ [aim@300]
- **click-other.sr3** (semi-real): expect click (allowed aim, select). base ✓ [aim@300 select@667 click@1167] · jitter-0.003 ✓ [aim@300 select@667 click@1167] · jitter-0.006 ✓ [aim@300 select@667 click@1167] · fps-15 ✓ [aim@333 select@650 click@1200] · fps-30 ✓ [aim@300 select@667 click@1200] · drop-10 ✗ [aim@300 select@683] · drop-30 ✓ [aim@300 select@667 click@1167] · mirror ✓ [aim@300 select@667 click@1167]
- **null-rest.sr3** (semi-real): expect none. base ✓ [nothing] · jitter-0.003 ✓ [nothing] · jitter-0.006 ✓ [nothing] · fps-15 ✓ [nothing] · fps-30 ✓ [nothing] · drop-10 ✓ [nothing] · drop-30 ✓ [nothing] · mirror ✓ [nothing]
- **null-talk.sr3** (semi-real): expect none. base ✗ [explode@217] · jitter-0.003 ✗ [explode@217] · jitter-0.006 ✗ [explode@233] · fps-15 ✗ [explode@283] · fps-30 ✗ [explode@250] · drop-10 ✗ [explode@217] · drop-30 ✗ [explode@1183] · mirror ✗ [explode@217]

## Compare (vs docs/lab/gestures/report.json (2026-10-01T21:43:56.699Z))

- [semi-real] gate — -> FAIL
- [semi-real] grab: new (24/24 fire)
- [semi-real] scale: new (16/24 fire)
- [semi-real] explode: new (24/24 fire)
- [semi-real] clap: new (23/24 fire)
- [semi-real] wheel: new (22/24 fire)
- [semi-real] undo: new (24/24 fire)
- [semi-real] aim: new (24/24 fire)
- [semi-real] click: new (22/24 fire)
- [semi-real] none: new (0/48 fire)
- [semi-real] matrix scale -> explode: 0 -> 1
- [semi-real] matrix clap -> explode: 0 -> 24
- [semi-real] matrix wheel -> explode: 0 -> 23
- [semi-real] matrix wheel -> click: 0 -> 1
- [semi-real] matrix aim -> grab: 0 -> 1
- [semi-real] matrix none -> explode: 0 -> 24

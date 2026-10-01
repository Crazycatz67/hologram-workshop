# Test ledger

Kept by Timmy (tester). Every verification pass records its counts here; the owner's live
results are recorded here too. Rules: a count that drops or a check that disappears is a
finding even at 0 failed. Statuses: `verified-offline`, `needs-live`,
`live-confirmed (owner, date)`, `failing`, `not-run (reason)`. Rows are updated in place;
history is appended as dated lines under Notes, never deleted.

**Baseline for this ledger (2026-10-01):** commit `f439528` plus an uncommitted tree
(modified: BUGS.md, gun-lab.html/.js, gestures.js, gunPose.js, hologram.js, manipulator.js,
plans/platform/ROADMAP.md, platform/export.js, platform/index.html, platform/main.js, test.js;
new: platform/ring.js, store.js, ring-test.*, library-test.*). At the time of writing Debbie
is break-testing the Library ring (platform/ring.js, store.js, main.js, export.js,
index.html, ring-test.js, library-test.js) and Cody is changing scale (manipulator.js,
gestures.js, test.js), so suites that load those files were **not re-run** in this pass.

Server: `python3 serve.py` from the repo root → `http://localhost:8080/` (no-store headers).
It was already up (HTTP 200) on 2026-10-01; check before starting a second one.

## Suites

"Needs" key: **srv** = dev server on :8080; **tab** = a browser tab (Chrome extension);
**vis** = must be a visible (foreground) tab because it counts animation frames;
**cam** = webcam (owner only); **cpu** = heavy, run alone on the laptop; **node** = runs under
Electron-as-node (see the bottom of this file).

| Suite | How to run | Needs | Last result | Date / commit |
| --- | --- | --- | --- | --- |
| `test.html` (v1 regression, imports test.js) | open `/test.html`, wait ~5 s, read `#summary` and every `.case.fail` | srv, tab | 326 / 0 (Timmy pass 3, headless visible tab; was 304). NOTE: in a HIDDEN tab 1 check fails (`🎯 button reads Stop`, label synced by rAF): needs visible tab | 2026-10-01 commit gate, f439528 + dirty |
| `platform/ring-test.html` (Library ring) | open `/platform/ring-test.html`, read pass/fail | srv, tab | 74 / 0 (Timmy pass 3, visible; a hidden tab shows 73/0: one rAF check skipped) | 2026-10-01 commit gate |
| `platform/library-test.html` (store + app wiring) | open `/platform/library-test.html`; uses its own IndexedDB names `hologram-library-test-unit` and `hologram-library-test-app` (the app runs in an iframe with `?db=…&ring=stub`) | srv, tab | 72 / 0 (Timmy pass 3, headless real time, ~40 s; was 69, +B33/B34/B35) | 2026-10-01 commit gate |
| `platform/polygon-test.html` (polygon lens, whole-model view #46) | open, read pass/fail (recorded run) | srv, tab | 43 / 0 (Timmy pass 3, virtual-time headless; was 42, +#54) | 2026-10-01, c90d3e2+dirty |
| `platform/hands-test.html` (Platform hands step 2, synthetic; `?camera=1` = fake cam, owner/agents) | open, read recorded run | srv, tab | 45 / 0 (Timmy pass 3, visible headless; was 24, +grab/pin H-checks; `?camera=1` not run) | 2026-10-01, c90d3e2+dirty |
| `platform/p5-test.html` (P5 inferred display, look, photosafety) | open, read pass/fail | srv, tab | 24 / 0 (Timmy pass 3, unchanged) | 2026-10-01 commit gate |
| `docs/lab/gestures/holdgate-lab.html` (hold-to-confirm ring timing) | page, or node: import `holdgate-lab.js`, call `runScenarios()` | node or srv+tab | 19 / 19 PASS (Timmy pass 3) | 2026-10-01 commit gate |
| `docs/lab/gestures/gun-lab.html` self-test (finger-gun pose maths) | page (self-test runs on load, no camera), or node: import `gun-lab.js`, call `runSelfTest()` | node or srv+tab | 45 / 0 + 3 info rows = 48 rows (Timmy pass 3, same as pass 2) | 2026-10-01 commit gate |
| `docs/lab/gestures/gun-lab.html` live probe (decides the click) | owner, webcam, ~2 min guided | cam | Owner ran it 2026-10-01 at 49 fps: click = **other hand's pinch** (8 px median palm shift vs 13–25 px thumb drop); gun pose recognised on **0%** of real frames | 2026-10-01 (owner) |
| `docs/lab/gestures/gesture-lab.html` (per-gesture sweeps; `?only=spin,clap`) | open, read `window.__gestureReport` / the `<pre>` | srv, tab | 7 / 7 gestures fire, no bleed (Timmy pass 3; page reports 'done', no pass/fail count) | 2026-10-01 commit gate |
| `docs/lab/gestures/smoothing-lab.html` (One Euro filter, clap recall by fps) | open, wait for "done" | srv, tab | done; clap recall 22/24 at 8 fps, 24/24 at 12-60 fps, slow bring-together 0 (unchanged) | 2026-10-01 commit gate |
| `safety-test.html` (photosafety, WCAG ≤ 3 flashes/s) | open, wait for `ALL PASS` / `SOME FAIL`; shows the look on screen | srv, tab | ALL PASS 5/5, 0-1 flashes/s (Timmy pass 3: v1 3.79%, v1+comfort 3.25%); blown pixels: chess+comfort 0.60% (was 0.81), v1+comfort 3.25% (was 3.85) (Debbie #30 numbers, confirmed by Timmy) | 2026-10-01 commit gate |
| `platform/perf-test.html` (render cost, readPixels-synced) | open, read the table | srv, tab, **vis** (uses rAF) | done, GPU timer; platform mode pr1 1.1 ms median on chair_detail (608k tri, LOD 240k); pr2 legacy 6.1 ms vs 3.5 before (tolerance flag; hidden tab, legacy path, not shipped) | 2026-10-01 commit gate |
| `platform/parts-test.html` (parts.js splitter) | open, read pass/fail | srv, tab | runs: chair_clean.obj -> 8 parts, 8 rows all ok (table, no pass/fail line) | 2026-10-01 commit gate |
| `platform/photo-test.html` (photo.js, photo → hologram) | open, read pass/fail | srv, tab | loads clean, waits for "pick a photo" (needs a human photo; not exercised) | 2026-10-01 commit gate |
| Page loads, 0 console errors: `index.html`, `hologram.html`, `hands.html`, `platform/index.html` | load each, read console errors; hologram.html: arrow-key swap ×5; platform: landing ring, load a sample. **Never click "start camera"** | srv, tab | 0 console errors on index, hologram (+5 arrow swaps), hands, platform/index (Timmy) | 2026-10-01 commit gate |
| `completion/benchmark.py` (Track B object chain) | `.venv/bin/python completion/benchmark.py` (smoke: `--methods none thickness --scenarios holes`, ~3 s) | cpu (full run minutes; sofa ~277 s) | chair `complete`: underside 98%/96%, wall 99%/96%, holes 100%/100% (coverage@2cm / added-real) | 2026-09-30 (e8c50f4) |
| `completion/benchmark.py --truth completion/out/truths/sofa.obj --methods none` (BUGS #21 regression) | as written | cpu | must print `added 0.000 m2` on every row | 2026-09-30 |
| `completion/photo3d.py` (photo → real 3D via TripoSR, Track B contract, all `inferred`) | `.venv/bin/python completion/photo3d.py completion/out/chess-photos/IMG_1979.JPG --height-cm 7`, then load `/platform/index.html?model=/completion/out/photo3d/IMG_1979.obj&db=<test>` | cpu + `.models/triposr` env (~5.6 GB peak) | chess IMG_1979: 105,748 faces, 14.3 s wall warm (model 3.4 s, mesh 6.1 s), peak 5.56 GB, levelled 42°, 41×7×39 cm; Platform: hatch on, 100.0% inferred (sidecar), method shown, 0 JS errors (favicon 404 only). Flat photo preview: photo-test with a real photo 92,646 tris, part labelled "Flat photo preview (2.5D)" (Cody-T) | 2026-10-01, f439528 + dirty |
| `completion/truths.py` (builds stool/vase/lamp/sofa truths) | `.venv/bin/python completion/truths.py [--only vase]` | cpu | built 2026-09-30 into `completion/out/truths/` | 2026-09-30 |
| `completion/room_bench.py` (room mode, BUGS #25 regression) | `.venv/bin/python completion/room_bench.py --methods complete plane_extend --scenarios occlusion` | cpu (up to 3.5 GB for `complete`) | plane_extend occlusion 54% / 100% real; holes 100/100 | 2026-09-30 |
| `completion/redwood.py` (Track B REAL room: Redwood Bedroom recon scored vs laser) | `.venv/bin/python completion/redwood.py` (stages cached in `completion/out/redwood/`; `--stage prep|register` to stop early) | cpu, one heavy job (prep 5.5 GB / 68 s; register 4.0 GB / 47 s; bench 6.4 GB parent / 19 min) | Registration: FPFH+RANSAC+pt-to-plane ICP + uniform scale 0.9793 (recon 2% too big; rigid-only fit@2cm 49%) -> fit@2cm 76.7%, @5cm 93.1%, inlier RMSE 9.4 mm. Occlusion (37.8% hidden), cov@2cm / real@2cm / F@5cm: none 31%/-/-; poisson FAILED (null normals; preclean variant 66%/25%/57%); plane_extend = auto (room mode) 52%/31%/69%; merged-shells prototype 50%/43%/67%. Holes: plane_extend 50%/21%/56%; merged-shells 51%/35%/61%; poisson[preclean] 58%/13%/41% (Debbie) | 2026-10-01, f439528 + dirty |
| Python tool smoke (`clean_scan.py`, `analyze_scan.py`, `repair_scan.py`) | see `.claude/skills/hologram-livelab` step 3; outputs to a scratch folder, never `assets/`; run Poisson tools several times and check the output file exists (exit 0 proves nothing, BUGS #8/#13) | cpu (light) | chair: symmetry 164.3° / 88.3%, ~75.5k verts, manifold | 2026-09-29/30 |

## Features

| Feature | Offline status | Live status | Last checked | Notes |
| --- | --- | --- | --- | --- |
| v1 move (fist grab) | verified-offline (test.html) | needs-live | 2026-10-01 | Synthetic hands only. |
| v1 spin (wrist twist while grabbing) | verified-offline | needs-live | 2026-10-01 | 2026-09-29 rewrite: slow twists now register. |
| v1 tilt (second hand up/down) | verified-offline (new test.js group "Tilt direction — second hand up tilts the model up") | needs-live | 2026-10-01 | 2026-10-01: direction **reversed** on the owner's request after his webcam test (raise = model tilts up). Owner must confirm the new direction feels right. |
| v1 push/pull (palm size) | verified-offline | needs-live | 2026-10-01 | BUGS #5: feel never confirmed on real hands; still-fist depth creep possible at real jitter. |
| v1 two-hand scale (pinch spread) | verified-offline (old behaviour) | **failing** (owner, 2026-10-01: "not as smooth as it was") | 2026-10-01 | BUGS #31 OPEN: sticky on small moves and at reversals (SCALE_DEADZONE 0.05). Fix in progress by Cody (held palm normaliser, uncommitted). Re-test after it lands. |
| v1 explode (two open hands pulled apart) | verified-offline | needs-live | 2026-10-01 | BUGS #11 (still-hands creep) fixed offline, needs a still-hands live check. |
| v1 clap reset, from rest only, undoable (U / Ctrl+Z) | verified-offline (groups "Neutral gap and safe clap", "Reset is undoable") | needs-live | 2026-10-01 | BUGS #27. Live: 5 claps from rest register; fast explode reverse does NOT reset; U undoes. |
| v1 neutral gap between gestures (BUGS #26) | verified-offline | needs-live | 2026-10-01 | Live: tilt → open fist must not explode; check relaxing doesn't feel sticky. |
| v1 part select by mouse click when exploded (BUGS #28) | verified-offline (iframe test with synthetic pointer events) | needs-live | 2026-10-01 | Live: explode, click a leg, fist-grab, only the leg moves (also closes #2). |
| hands.html recognizer reuse on stop/start (BUGS #29, same as #16 on hologram.html) | not-run (needs camera; no automated check) | needs-live | 2026-10-01 | Stop/start 5×, memory flat in Activity Monitor. |
| Finger-gun pointer pose (`gunPose.js`) | verified-offline (gun-lab self-test 45/0, Timmy 2026-10-01) | **failing** (owner probe 2026-10-01: recognised on 0% of real frames) | 2026-10-01 | Thresholds came from a synthetic hand; recalibration pending the owner's per-check diagnostics probe. Fist check read the gun as a grab on 33–47% of frames: a per-hand gun veto is required before wiring. Not wired into any page. |
| Finger-gun click method | n/a | live-confirmed (owner, 2026-10-01): other hand's pinch wins | 2026-10-01 | Decision recorded in plans/platform/ROADMAP.md 2026-10-01 (2). |
| holdGate confirmation ring (`holdGate.js`) | verified-offline (holdgate-lab 19/19, Timmy 2026-10-01) | not-run (not wired into any page) | 2026-10-01 | Timing rules only; feel untested. |
| Platform P5: inferred geometry ghosted, View Completed / As scanned, I key | verified-offline (p5-test 20/0, 2026-09-30) | needs-live (owner look check) | 2026-09-30 | Re-run p5-test after the library wiring in main.js lands. Overlap brightness affected by BUGS #30. |
| Platform Library ring (landing screen, cards = scenes) | verified-offline (ring-test 71/0, overseer 2026-10-01) | needs-live (look and feel) | 2026-10-01 | Being break-tested by Debbie now; re-run after. |
| Platform Library store (IndexedDB autosave, Save version Cmd/Ctrl+S, versions, drop your own scan) | verified-offline (library-test 55/0, overseer 2026-10-01) | needs-live | 2026-10-01 | Tests use `?db=` so the visitor's real `hologram-library` is never touched. Real OS drag-drop only exercised programmatically. |
| Platform polygon lens (P key: whole model shows triangles, click selects a patch, Delete hides, I marks inferred, undo) | verified-offline (polygon-test 32/0) | needs-live | 2026-10-01 | Checklist steps L1–L3 below. Debbie is reworking the P-key view now, so re-run polygon-test after. |
| Photosafety (≤ 3 flashes/s) | verified-offline (safety-test, 2026-09-29) | needs-live (not yet seen by a flicker-sensitive person) | 2026-09-29 | BUGS #14. |
| BUGS #30 depth pre-pass wiped by background clear (layers add up) | failing (OPEN; p5-test works around it with a null background) | n/a | 2026-09-30 | Brightness stacking, not flashing (0 flashes/s). Re-run safety-test + p5-test after the fix. |
| Scan completion, object mode (`complete.py --mode object`) | verified-offline (benchmark, chair 98–100%) | not-run (no real partial scan of the owner's yet) | 2026-09-30 | Fails on thin shells (#24) and big thick furniture (#23); synthetic, noise-free = upper bounds. |
| Scan completion, room mode (`--mode room`, plane_extend) | verified-offline (room_bench) | not-run | 2026-09-30 | Synthetic planar room: upper bounds. #25 mitigated by auto-routing. **Real room (Redwood, 2026-10-01): recall holds (52% vs synthetic 54% @2cm) but precision collapses (31% vs 100%)**: non-planar real floors/walls split into parallel shell fragments that are extended room-wide. See the redwood.py row. |
| Carousel model swap on hologram.html (BUGS #1) | verified-offline (12 swaps, agent browser run 2026-09-29) | needs-live (rAF count in a visible tab) | 2026-09-29 | |

## Owner live checklist (draft, 2026-10-01)

Total if all groups run: about 21 minutes. Do the READY NOW groups first.

### A. Finger-gun pointer probe (gun-lab) — ~3 min — READY NOW
(server: `python3 serve.py` in the repo; open `http://localhost:8080/docs/lab/gestures/gun-lab.html`; hard refresh Cmd+Shift+R)
1. Check the self-test line at the top. Expected: "45 passed, 0 failed".
2. Click "start camera", allow the camera. Expected: video and skeleton appear, fps about 30–50.
3. Follow the on-screen guided probe (point side-on, point at the camera, open hand, fist, other-hand pinches). Expected: it finishes and shows a per-check diagnostics table.
4. Click "copy results JSON". Expected: JSON on the clipboard.
Send back: the pasted JSON, and the fps you saw.

### B. hands.html recognizer leak (BUGS #29) — ~3 min — READY NOW
(open `http://localhost:8080/hands.html`; hard refresh; open Activity Monitor → Memory, find the Chrome tab's renderer / "Google Chrome Helper (Renderer)")
1. Note the memory figure. Click start camera, allow. Expected: hands tracked.
2. Stop, start, stop, start, stop (5 starts in total, ~5 s each). Expected: each restart is quick (no model reload).
3. Read the memory figure again. Expected: within about 50 MB of step 1, not climbing by roughly 50–100 MB per restart.
Send back: memory before / after, pass or fail.

### C. hologram.html gestures — ~5 min — WAIT (Cody is changing scale in manipulator.js/gestures.js now; a half-written file looks like a bug)
(open `http://localhost:8080/hologram.html`; hard refresh; start camera)
1. Make a fist with one hand, raise your other open hand about 20 cm. Expected: the model's front edge tilts **up** (new direction).
2. Lower the other hand. Expected: it tilts down.
3. Hold the tilt, then open the fist and lower both hands casually. Expected: no explode (BUGS #26).
4. Pinch both hands, spread them a little (about 10 cm), back, a little again. Expected: scale follows promptly, no dead start, no pause at each reversal (BUGS #31).
5. Pull two open hands apart to explode, then click a chair leg with the mouse, then fist-grab. Expected: only the leg moves (BUGS #28).
6. Explode, then bring the open hands together fast. Expected: no reset. Then rest, and clap 5 times. Expected: 5 resets; press U after one. Expected: the reset is undone (BUGS #27).
Send back: pass/fail per step number, plus one line on how scale feels.

### D. Platform Library ring + P5 look — ~5 min — WAIT (Debbie is break-testing ring.js/store.js/main.js now)
(open `http://localhost:8080/platform/index.html`; hard refresh)
1. Page opens on the ring. Expected: 3 chair samples + "Drop your own scan", 0 errors.
2. Open a sample, move a part, reload the page. Expected: the change is still there (autosave).
3. Press Cmd+S. Expected: a "version saved" message; the version shows under that project on the ring.
4. Drag a scan file from Finder onto the page. Expected: a new card/project with your scan.
5. Drag `completion/out/chair_underside_completed.obj` and `completion/out/chair_underside_completed.json` onto the page together, then press I twice. Expected: filled-in faces look ghosted and still, clearly different from scanned faces, and nothing flashes.
Send back: pass/fail per step, a screenshot of step 5.

### E. Platform polygon lens — ~3 min — WAIT (Debbie is reworking the P-key triangle view now)
(open `http://localhost:8080/platform/index.html`; hard refresh; open the chair sample)
L1. Select the chair, press P. Expected: the whole model shows its triangles.
L2. Click a patch to select it, press Delete, then Ctrl/Cmd+Z. Expected: the patch hides, then comes back.
L3. Select a patch, press I, press I again, then Ctrl/Cmd+Z. Expected: I marks it inferred, the second I unmarks it, undo reverses the last change.
Send back: pass/fail per step.

### F. hologram.html pointer — ~3 min — WAIT (Cody-S is rebuilding selection; Cody-U the layout)
(open `http://localhost:8080/hologram.html`; hard refresh; start camera)
P1. Point with the index finger out and the other three fingers curled. Expected: the pointer shows and follows your finger.
P2. Pinch with your other hand while pointing. Expected: that counts as a click (on the model, a part is picked).
P3. Use the tape measure: click two points on the model with pinch clicks. Expected: a measured length appears.
Send back: pass/fail per step.

## How runs work here (for the next pass)
- Lab self-tests that need no DOM run under Electron-as-node:
  `ELECTRON_RUN_AS_NODE=1 '/Applications/Visual Studio Code.app/Contents/MacOS/Code' script.mjs`,
  where the script imports `file://…/docs/lab/gestures/holdgate-lab.js` (call `runScenarios()`)
  or `gun-lab.js` (call `runSelfTest()`). There is no system node.
- Browser suites: own Chrome tab, read the DOM summary, read console errors, close the tab.
  Background tabs don't tick rAF; perf-test and any fps/rAF check need a visible tab.
- Platform tests that touch the library use their own IndexedDB names via `?db=`; never run
  them against the default `hologram-library`.

## History
- 2026-10-01 (Timmy): ledger created. Ran holdgate-lab 19/19 and gun-lab self-test 45/0 under
  Electron-node (gun-lab was 29/0 on 2026-09-30; the rise to 45 is the 2026-10-01 rewrite of
  gun-lab.js, not a regression). Everything else carried from the overseer's 2026-10-01 runs
  or older records, not re-run, because ring/library and scale files were mid-edit.

- **2026-10-01 (overseer, from the owner's calibrate-only probe, 50 fps):** pointer **at the camera** separates cleanly. Index "separation" is 1.04–1.10 palm lengths, against −0.11…−0.08 for an open hand and −0.02…0.07 for a fist (p10–p90), so a threshold of ~0.5 should recognise it on almost every frame. It failed only because the curl thresholds were too strict (middle finger 64° < 70°). Steadiness at camera: jitter median 0.26 px, p90 0.66 px; drift 4.8 px over 5 s. **Side-on is unusable:** MediaPipe labels it Open_Palm 100% and its features match the open hand, because the curled fingers are hidden. The current fist check reads the at-camera pointer as a GRAB on 100% of frames, so a veto is required before wiring. The other-hand pinch click is not yet measured (0/5 detected in the earlier run, suspected lab bug). Next: recalibrate gunPose (separation-based, at-camera only) and add the gestures.js veto once the scale work lands.
- **2026-10-01 (overseer, owner's full probe run, 50 fps):** **click = other-hand pinch PASSES.** The aiming hand moved 3.6 px median (max 4.9 px) per pinch, less than its own 4.4 px still-hold wander over the same window; 5/5 pinches detected. **Pointer thresholds calibrated** from this run and committed to `gunPose.js` (uncommitted tree). Every gap is clean: side-on 100% / at-camera 100% / open 0% / fist 0% on the fitting frames. Index bend limit set to 45° instead of the midpoint 61° so a hooked index is rejected; Open_Palm dropped from the veto labels. Self-test 45/0. **Side-on works** when the three fingers are truly curled (the earlier side-on failure was an uncurled hold). Remaining blocker: gestures.js reads the pointer as a GRAB on 100% of frames, so a veto is required. Optional owner confirmation run with the committed defaults on fresh frames.


## Commit-gate pass, 2026-10-01 (Timmy), f439528 + dirty tree
GREEN. All suites run fresh in my own tab (hidden tab; perf timings may be affected). Counts above.
- Changes covered: tilt reversed, scale #31, gunPose + pointer veto #32, Library ring/store #33-#44, #30 depth pre-pass, test recorder, shadow-site sessionrec.js, pointer slice 1.
- Debbie #30: p5 24/0; safety blown pixels chess 0.81 -> 0.60%, v1 3.85 -> 3.25%. Confirmed.
- ring-test is 73, not 74. No count dropped versus any agent-reported number except that.
- FLAGS.md: older lines are agent noise, not current failures: 02:18 p5 #30 fails (before the fix), 02:32 test pointer fails (Cody-P mid-edit; now 217/0), 02:43 safety "5 gone" (aborted run; rerun 5/5), session-* console-error/crashed lines (sessionrec self-checks / injected error), hidden-tab and low-fps (agent tabs). Left in place. Only live concern: perf-test tolerance flag (pr2 legacy).
- Not run: Python Track B (no change in this diff), photo-test with a real photo, anything needing a webcam.
- Features: pointer slice 1 (engage/aim/click, measure placement) verified-offline with synthetic hands, needs-live; Library ring needs-live; shadow recorder verified-offline (badge present, sessions recorded).

### Track B re-run after BUGS #25 fix (slab_fill skips room-shell planes), 2026-10-01, c90d3e2 + dirty (Timmy)
- Chair (benchmark.py): underside 98%/97%, wall 99%/96%, holes 100%/100% (6.5 s, ~400 MB). Unchanged.
- Sofa `complete`: underside 24%/21%, wall 68%/33%, holes 100%/22% (18 s, ~920 MB). Identical to the post-#22 baseline.
- Stool `complete`: 100%/100%, 100%/100%, 94%/100%. Lamp `complete`: 94%/79%, 100%/15%, 86%/83%. Within baseline.
- room_bench `complete`: occlusion 40%@2cm / 28% real (was 13/19), holes 95%/18% (was 84/18); 75-85 s, 3.8-4.1 GB (was ~30 s, ~3 GB). plane_extend unchanged: 54%/100%, 100%/100%.

### Track B benchmark of BUGS #24 fix (normal-aware keep_only_gaps; poisson density_trim=3.0 in complete), 2026-10-01, working tree (Timmy)
- `complete`, cov@2cm / added-real (peak MB 400-925; times noisy, Debbie's job may have been running).
- Chair: underside 98%/98%, wall 99%/96%, holes 100%/100% (7 s, 650 MB). PASS (bar >=97% cov). Baseline 98/99/100, real 96-97.
- Vase: underside 100%/48%, wall 100%/**34%**, holes 77%/100%. Wall added-real was 15%, bar 40%, Ricky predicted 42%: improved, **bar MISSED**.
- Lamp: underside 94%/84%, wall 100%/46%, holes 87%/85%. Wall added-real was 14%: PASS (bar 40%, predicted 55%).
- Stool: underside 100%/100%, wall 100%/100%, holes 94%/100%. PASS (bar 97%).
- Sofa (report only): underside 24%/32%, wall 68%/36%, holes 100%/23% (22-25 s, 925 MB). Cov identical to baseline (24/21, 68/33, 100/22); real +11/+3/+1.


## Commit-gate pass 2, 2026-10-01 (Timmy), c90d3e2 + dirty tree
PARTIAL: every suite GREEN, but the page-load / console-error sweep could not be run (browser extension disconnected mid-pass).
- Fresh runs (own tab, server :8080): test.html 304/0, library 69/0, ring 74/0, p5 24/0, polygon 42/0, hands 24/0, holdgate 19/19, gun-lab 48/0, gesture-lab 17/0, safety ALL PASS 5/5, parts 9 rows ok, smoothing-lab done (0 flags), perf done (tolerance flag = numbers got FASTER, visible tab: legacy pr1 3.9 -> 0.9 ms; not a regression). All recorded runs: 0 failures, 0 console errors.
- Track B: chair `complete` underside 98% @2cm / 98% real (bar 97%), 6.7 s, 598 MB. completion/redwood.py imports OK (not re-run).
- Not run: photo-test (no photo), console-error sweep of hologram.html / hands.html / platform/index.html / index.html (extension lost; Cody-S/-U/Cody/Debbie report 0 on their last runs, unverified by me), anything with a webcam.
- Gotchas: library-test B32 (#44) needs animation frames: in a hidden tab it hangs forever and freezes the renderer (CDP timeouts). A screenshot call makes the tab visible and it finishes (69/0 in ~90 s). Do not navigate away mid-run: it records an "incomplete, 69 checks gone" flag (09:19, 09:25, 09:28 lines in FLAGS.md are mine, not failures). MediaPipe "INFO: Created TensorFlow Lite" lines are known noise on camera pages.
- FLAGS.md 04:54-04:55 "Selection practice" fails: Cody-S mid-edit runs, fixed (test.html 304/0).

### Features (pass 2)
| Feature | Offline | Live |
| --- | --- | --- |
| One-hand selection (hold+bubble, same-hand pinch, other-hand pinch; test.js +50) | verified-offline (test.html 304/0, synthetic) | needs-live |
| Gesture-demo layout (Tools panel, one coach slot, ? Help; Cody-U) | verified-offline (test.html; hologram.html 0 errors per Cody-U, not re-seen) | needs-live (legibility) |
| Selection practice (calibrate.js) | verified-offline | needs-live |
| Polygon whole-model view (#46) | verified-offline (polygon-test 42/0) | needs-live |
| Platform hands step 2 (Camera button, hover/select, BVH pick) | verified-offline (hands-test 24/0) | needs-live |
| #47 pinch latch (same-hand pinch while fist-like starts GRAB at 367 ms; fix in reports/2026-10-01-cody-i-pinch-grab-fix.js) | RISK open, fix not applied | needs-live |
| #24 thin shells (partial) | verified-offline: vase wall 34% added-real, bar 40% MISSED; lamp, stool, chair PASS | n/a |
| #25 slab skips room shell | verified-offline (room_bench occlusion 40%@2cm, up from 13) | n/a |
| #23 big thick furniture | parked: geodesic fallback (HW_SLAB_GEO=1, default off) failed the bar | n/a |
| #48 / #49 | open (see BUGS.md) | n/a |

## Owner live checklist for NEXT session, shadow site (about 14 min). Server: `python3 serve.py`; hard refresh (Cmd+Shift+R) each page. Sessions record themselves (SHADOW badge); nothing to paste unless a step fails.
READY marks: wait until the overseer confirms no one is mid-edit.

### G. Gesture demo, http://localhost:8080/hologram.html — ~7 min — READY
1. Look at the page without the camera. Expected: one Tools panel (tabs Practice / Measure / Look), one coach line, top bar not covered.
2. Press ?. Expected: help opens and closes.
3. Start camera, allow. Complete the calibration card. Expected: card sits under the top bar, plain wording, bar fills each step.
4. Point (index out, other three curled), hold still ~0.7 s on a chair part. Expected: bubble fills, part selects.
5. Point at another part and pinch with the OTHER hand. Expected: that part selects at once.
6. Point at a part and pinch with the SAME hand. Expected: selects; the model does NOT start moving (#47).
7. Press P, run Selection practice (hold vs pinch). Expected: a score line; note which felt easier.
8. Press T, click two points with pinch. Expected: a length appears.
Send back: pass/fail per step, which selection method you prefer.

### H. Platform, http://localhost:8080/platform/index.html — ~5 min — READY
1. Landing ring shows samples + "Drop your own scan". Expected: no errors; ring is smooth and readable.
2. Open the chair, press P. Expected: the WHOLE chair becomes a wire over a faint skin (not just one part).
3. Click a patch, Delete, Cmd/Ctrl+Z. Expected: hides, then returns.
4. Press the Camera button, allow. Expected: hand cursor; hover highlights a part; other-hand pinch selects it.
5. Press I on a selected patch. Expected: marked inferred, hatched.
Send back: pass/fail per step.

### I. Library ring look — ~2 min — READY
1. Back to the ring, spin it with mouse or hands. Expected: no flashing, easing is comfortable.
Send back: pass/fail, one line on comfort.

## Console sweep, 2026-10-01 (Timmy), working tree (no git; :8099 own server, camera never started)
Fresh load + ~5 s wait, console read from load. Window would not go past 1280 px viewport, so layout was measured in a 1400 px-wide iframe (same-origin); screenshot taken at 1280 px.
| Page | Console errors/warnings | Top bar at 1400 px |
| --- | --- | --- |
| hologram.html | 0 | fits, one row, no overflow |
| hands.html | 0 | no top bar |
| platform/index.html?db=timmy-sweep | 0 (1 INFO: sample thumbnail timing) | OVERFLOWS: bar content 1441 px in 1400 px (about 41 px), single row (nowrap, no wrapping); "Inspector" button (right edge 1429) is clipped. Unlogged bug. |
| index.html | 0 (1 INFO thumbnail timing) | fits, no overflow |
Not verified: a true 1400 px window (browser stayed 1280 px); iframe results are the same layout width but not a real window.

## Commit-gate pass 3, 2026-10-01 (Timmy), working tree (no git), own :8099 + headless Chrome via CDP (the Chrome extension disconnected mid-pass)

Tree includes: P1 step 3 (grab/pin), #50 top bar, #51 autosave, #52/#53 practice exit + orbitGuard, handModel.js hand,
guide.html/testguide.js, clip-lab, serve.py /__clip, Track B #48/#49. Completion benchmarks NOT run (Debbie on #24 CPU).

| Check | Before (pass 2) | Now | Status |
| --- | --- | --- | --- |
| test.html | 304/0 | 326/0 (visible). Hidden tab: 325/1, `🎯 button reads Stop` (rAF-synced label; needs visible tab) | GREEN |
| ring-test | 74/0 | 74/0 (hidden tab 73/0) | GREEN |
| library-test | 69/0 | 72/0 | GREEN |
| p5-test | 24/0 | 24/0 | GREEN |
| polygon-test | 42/0 | 43/0 | GREEN |
| platform hands-test | 24/0 | 45/0 | GREEN |
| hand-model-test (new) | n/a | 24/0 (`?camera=1` 25 not run) | GREEN |
| holdgate-lab | 19/19 | 19/19 | GREEN |
| gun-lab self-test | 45 + 3 info | 45 + 3 info | GREEN |
| gesture-lab | 17/0 (old format) | 7/7 gestures fire, no bleed | GREEN |
| safety-test | 5/5 | ALL PASS 5/5 | GREEN |
| guide pure checks | n/a | my structural checks on testguide-steps.js (Electron-as-node): 37 steps, unique ids, HA3-HA7, GD5b, PL1/PL2, UP2, LR1, GD11, MT2 present: 88/0 (no committed script exists; Cody-G's 340 not reproduced) | GREEN (limited) |
| Console sweep: hologram, hands, platform/index, index, guide, clip-lab | 0 | 0 errors on all 6 (camera never started) | GREEN |
| Platform top bar 800/1200/1400/1600 px | overflow 41 px at 1400 | bar 48 px high, no horizontal overflow, nothing past the right edge at all four widths (screenshots 800, 1400: icons only) | GREEN (#50 fixed) |
| serve.py | n/a | py_compile OK; POST /__clip NOT exercised (would write assets); :8099 GET /__clip 404 as expected | partial |
| completion #48/#49 | n/a | NOT RUN (CPU claimed by Debbie, #24); Debbie's numbers are unverified by me | not-run |

Not verified: gesture/hand feel, real camera, MediaPipe, clip-lab record/Keep, :8080 server (old, needs restart for /__clip), polygon-test in real time (virtual time only).

### Features (pass 3)
| Feature | Offline | Live |
| --- | --- | --- |
| Hologram hand (handModel.js) | verified-offline 24/0 | needs-live |
| Platform grab/pin (P1 step 3) | verified-offline (hands-test 45) | needs-live |
| #51 autosave (camera/mode/selection/polygon) | verified-offline (library 72) | needs-live (PL2) |
| #52/#53 practice Stop + mouse no-spin | verified-offline (test.html 22 new) | needs-live |
| #50 top bar | verified-offline (4 widths) | none needed |

### Owner live checklist for pass 3 (~6 min). Server: restart :8080 first (`python3 serve.py`), hard refresh (Cmd+Shift+R).
**A. New hand, http://localhost:8080/hologram.html (1.5 min)**
1. Press Start camera, raise one open hand. Expected: a glowing rigged hand (not the old ghost outline) follows yours.
2. Make a fist, then a pointer (index out), then pinch. Expected: finger shapes match yours; no flashing.
**B. Practice Stop + mouse no-spin, same page (1.5 min)**
3. Press the 🎯 button. Expected: button reads Stop; card shows "Stop (Esc)". Click it, then repeat and press Esc, then P. Expected: practice ends each time.
4. Click and hold on the page background without moving, then release. Expected: model does not spin; drag does rotate.
**C. PL2 reload, http://localhost:8080/platform/index.html (1.5 min)**
5. Load the sample, rotate the view, switch to Object mode, select a part, enter polygon lens and hide a patch (Delete).
6. Reload (Cmd+R). Expected: same camera, mode, selection and the hidden patch are back; no "unsaved" marker from view changes alone.
**D. Grab/pin HA3-HA7 (1.5 min, camera on in Platform)**
7. Follow guide steps HA3 to HA7 at http://localhost:8080/guide.html (one at a time): fist to grab a part, move it, pin with K, try to grab the pinned part, K again to unpin. Expected per step as written in the guide.
Send back: pass/fail per step number (1-7), plus a note if the hand lags.

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
| `test.html` (v1 regression, imports test.js) | open `/test.html`, wait ~5 s, read `#summary` and every `.case.fail` | srv, tab | 217 passed / 0 failed (Timmy) | 2026-10-01 commit gate, f439528 + dirty |
| `platform/ring-test.html` (Library ring) | open `/platform/ring-test.html`, read pass/fail | srv, tab | 73 / 0 (Timmy; 74 was an agent/overseer miscount, Debbie reported 73) | 2026-10-01 commit gate |
| `platform/library-test.html` (store + app wiring) | open `/platform/library-test.html`; uses its own IndexedDB names `hologram-library-test-unit` and `hologram-library-test-app` (the app runs in an iframe with `?db=…&ring=stub`) | srv, tab | 69 / 0 (Timmy; ~100 s, hidden tab) | 2026-10-01 commit gate |
| `platform/p5-test.html` (P5 inferred display, look, photosafety) | open, read pass/fail | srv, tab | 24 / 0 (Timmy; incl. #30 stacking checks) | 2026-10-01 commit gate |
| `docs/lab/gestures/holdgate-lab.html` (hold-to-confirm ring timing) | page, or node: import `holdgate-lab.js`, call `runScenarios()` | node or srv+tab | 19 / 19 PASS (Timmy, browser) | 2026-10-01 commit gate |
| `docs/lab/gestures/gun-lab.html` self-test (finger-gun pose maths) | page (self-test runs on load, no camera), or node: import `gun-lab.js`, call `runSelfTest()` | node or srv+tab | 45 / 0 + 3 info rows (Timmy, browser) | 2026-10-01 commit gate |
| `docs/lab/gestures/gun-lab.html` live probe (decides the click) | owner, webcam, ~2 min guided | cam | Owner ran it 2026-10-01 at 49 fps: click = **other hand's pinch** (8 px median palm shift vs 13–25 px thumb drop); gun pose recognised on **0%** of real frames | 2026-10-01 (owner) |
| `docs/lab/gestures/gesture-lab.html` (per-gesture sweeps; `?only=spin,clap`) | open, read `window.__gestureReport` / the `<pre>` | srv, tab | 17 / 0 (Timmy; recorded run) | 2026-10-01 commit gate |
| `docs/lab/gestures/smoothing-lab.html` (One Euro filter, clap recall by fps) | open, wait for "done" | srv, tab | done; clap recall 22/24 at 8 fps, 24/24 at 12-60 fps, slow bring-together 0 (unchanged) | 2026-10-01 commit gate |
| `safety-test.html` (photosafety, WCAG ≤ 3 flashes/s) | open, wait for `ALL PASS` / `SOME FAIL`; shows the look on screen | srv, tab | ALL PASS 5/5, 0-1 flashes/s; blown pixels: chess+comfort 0.60% (was 0.81), v1+comfort 3.25% (was 3.85) (Debbie #30 numbers, confirmed by Timmy) | 2026-10-01 commit gate |
| `platform/perf-test.html` (render cost, readPixels-synced) | open, read the table | srv, tab, **vis** (uses rAF) | done, GPU timer; platform mode pr1 1.1 ms median on chair_detail (608k tri, LOD 240k); pr2 legacy 6.1 ms vs 3.5 before (tolerance flag; hidden tab, legacy path, not shipped) | 2026-10-01 commit gate |
| `platform/parts-test.html` (parts.js splitter) | open, read pass/fail | srv, tab | runs: chair_clean.obj -> 8 parts, 8 rows all ok (table, no pass/fail line) | 2026-10-01 commit gate |
| `platform/photo-test.html` (photo.js, photo → hologram) | open, read pass/fail | srv, tab | loads clean, waits for "pick a photo" (needs a human photo; not exercised) | 2026-10-01 commit gate |
| Page loads, 0 console errors: `index.html`, `hologram.html`, `hands.html`, `platform/index.html` | load each, read console errors; hologram.html: arrow-key swap ×5; platform: landing ring, load a sample. **Never click "start camera"** | srv, tab | 0 console errors on index, hologram (+5 arrow swaps), hands, platform/index (Timmy) | 2026-10-01 commit gate |
| `completion/benchmark.py` (Track B object chain) | `.venv/bin/python completion/benchmark.py` (smoke: `--methods none thickness --scenarios holes`, ~3 s) | cpu (full run minutes; sofa ~277 s) | chair `complete`: underside 98%/96%, wall 99%/96%, holes 100%/100% (coverage@2cm / added-real) | 2026-09-30 (e8c50f4) |
| `completion/benchmark.py --truth completion/out/truths/sofa.obj --methods none` (BUGS #21 regression) | as written | cpu | must print `added 0.000 m2` on every row | 2026-09-30 |
| `completion/truths.py` (builds stool/vase/lamp/sofa truths) | `.venv/bin/python completion/truths.py [--only vase]` | cpu | built 2026-09-30 into `completion/out/truths/` | 2026-09-30 |
| `completion/room_bench.py` (room mode, BUGS #25 regression) | `.venv/bin/python completion/room_bench.py --methods complete plane_extend --scenarios occlusion` | cpu (up to 3.5 GB for `complete`) | plane_extend occlusion 54% / 100% real; holes 100/100 | 2026-09-30 |
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
| Photosafety (≤ 3 flashes/s) | verified-offline (safety-test, 2026-09-29) | needs-live (not yet seen by a flicker-sensitive person) | 2026-09-29 | BUGS #14. |
| BUGS #30 depth pre-pass wiped by background clear (layers add up) | failing (OPEN; p5-test works around it with a null background) | n/a | 2026-09-30 | Brightness stacking, not flashing (0 flashes/s). Re-run safety-test + p5-test after the fix. |
| Scan completion, object mode (`complete.py --mode object`) | verified-offline (benchmark, chair 98–100%) | not-run (no real partial scan of the owner's yet) | 2026-09-30 | Fails on thin shells (#24) and big thick furniture (#23); synthetic, noise-free = upper bounds. |
| Scan completion, room mode (`--mode room`, plane_extend) | verified-offline (room_bench) | not-run | 2026-09-30 | Synthetic planar room: upper bounds. #25 mitigated by auto-routing. Redwood real room still needs registration before scoring. |
| Carousel model swap on hologram.html (BUGS #1) | verified-offline (12 swaps, agent browser run 2026-09-29) | needs-live (rAF count in a visible tab) | 2026-09-29 | |

## Owner live checklist (draft, 2026-10-01)

Total if all groups run: about 15 minutes. Do the READY NOW groups first.

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

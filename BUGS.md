# hologram-workshop — Bug Tracker

A durable task-clipboard for known issues, separate from the track roadmaps'
narrative revision histories (`plans/<track>/ROADMAP.md`) — that file records what changed and why, this
one tracks what's currently open at a glance. Treat it as a living document:
read it, update it in place, never spawn a parallel tracking file. See the
`hologram-bugwatch` skill for how to work through it.

Each item's status line is one of:
- `OPEN` — confirmed or reported, not yet resolved.
- `FIXED (verified offline)` — fixed and confirmed via `test.html` or direct
  execution (e.g. running `clean_scan.py` for real), no live camera needed.
- `FIXED (needs live confirm)` — fixed and reasoned through / code-reviewed,
  but not yet confirmed against a real browser, real webcam, or real asset.
- `NOT A BUG` — investigated and found to already work correctly.
- `DEFERRED` — real, not a bug in this project's code, blocked on something
  outside it (a re-scan, a design decision, etc).

**Tracks (2026-09-29):** one file for all tracks, but every new item's
heading starts with its track tag: `[A]` Hologram Platform, `[B]` Scan
Completion, `[C]` Neurotech Bionic Arm (see the root `ROADMAP.md`). Items #1–7
below predate the split and are `[A-v1]`: bugs in the v1 engine the Platform
builds on.

---

## 1. Carousel model-swap — never run in a browser this session

**Status: FIXED (needs live confirm)**

`loadModelById()` in `hologram.js`, `carousel.js`, `models.js` — built
2026-09-23, code-reviewed and balance-checked, but this session had no
Node and no browser automation available, so none of it has actually
executed. Needs: open `hologram.html`, swap between the two `MODELS`
entries via the carousel UI and via arrow keys, 5+ times, confirm no
console errors and no growing count of orphaned `requestAnimationFrame`
loops (each `createMeasurePanel`/`.dispose()` pair should net to zero).
**2026-09-29 lab run:** swapped 12× via arrow keys in a real browser (after the #9 fix; before it,
the carousel stuck on "busy" whenever the model had a saved note). No console errors, status and
active card are correct each time, and notes survive the swap (#10). The rAF count is still
unconfirmed: the automation tab was backgrounded, so rAF never ticked. Code check: `dispose()`
does `cancelAnimationFrame(frame)`.

## 2. Per-part explode retargeting — never run in a browser, and no real multi-part asset yet

**Status: FIXED (needs live confirm)**

`manipulator.js`'s per-target state map, `selectPartAtScreenPoint`, and the
extended `performReset` — built 2026-09-23, same "unexecuted this session"
caveat as #1. Additionally blocked on item #4 below: there is no real
multi-part model in the app yet to actually select/grab a part of, so even
a real browser check can only confirm the synthetic `test.js` coverage, not
a genuine live-hands feel.

## 3. New `test.js` group ('Literal explode + per-part retargeting') — never actually run

**Status: FIXED (verified offline)**: 2026-09-29 lab run. test.html ran in Chrome and every case
in this group and in the OBJ-style group (#7) passes (suite 72/72).

Written 2026-09-23 to close the real gap described in item #5. Needs
`test.html` opened in a real browser to confirm it actually passes as
written — the assertions are reasoned through carefully (including explicit
`updateMatrixWorld()` calls for the raycasting checks) but never executed.

## 4. Chess scan is too fragmented for `clean_scan.py --multi-part`

**Status: DEFERRED — superseded by a capture-strategy change, not a code fix**

`assets/chess/chess.glb` (2026-09-23 capture) splits into 376 disconnected
components instead of ~33 real objects. Confirmed this is not fixable by
any pipeline change, not just `--multi-part`: a direct test of reconstructing
the whole scan as ONE combined object (abandoning per-piece splitting
entirely) crashes Poisson reconstruction outright. The whole-set-scan
approach is abandoned — see item #6 and v1 roadmap's 2026-09-23(2) entry.
`clean_scan.py --multi-part` itself is not deleted (still correct against
synthetic data, might be useful for a smaller future multi-object scan) but
is no longer the path to the chess hologram.

## 5. Pitch, push/pull, and stretch-explode — still not confirmed on real hands

**Status: OPEN — needs live camera confirm**

Carried forward from v1 roadmap's 2026-09-08 entry: these three gestures
have only ever been exercised by synthetic `test.js` sequences, never a real
webcam session. Not touched this session.
**2026-09-29 gesture lab (synthetic):** the thresholds a live test should check first. Push only
fires when apparent hand size changes by more than 30% per second (`DEPTH_DEADZONE`): palm
0.10→0.13 over 1s does nothing, and neither does 0.08→0.13 over 2s. Spin ignores twists slower
than ~14°/s (`TWIST_DEADZONE`): a 40° twist gives 13.9° of spin over 0.5s and 0 over 2s. Pitch
needs the second hand to move more than ~35% of 0.24 frame in 0.67s. Stretch-explode has no lower
bound at all (see #11).
**2026-09-29 smoothing rewrite (synthetic):** the per-second velocity deadzones are gone. Every
channel now maps hand displacement to model motion through a small backlash deadzone, so slow
motion registers: a 40° twist over 2s now spins 22.4° (was 0), palm 0.10→0.13 over 1s now pulls
the model ~39cm closer (was 0), and push, pitch and spin fire at every duration tried up to 8s.
Push gain is 0.5 (canonical push −41cm; was −28cm at 60fps and −13cm at 10fps). Still needs a real
hand: whether push and pitch feel right, and whether a still real fist creeps in depth (it does
at 4–6× the synthetic jitter: −1.4/−5.2cm over 3s).

## 6. Chess pipeline rebuilt around per-piece-type scans + `assemble_chess_set.py`

**Status: FIXED (verified offline) for the script; blocked on the user for real scans**

New capture plan (see v1 roadmap, 2026-09-23(2)): scan the board once plus
one example of each of the 6 unique piece types, clean each individually
with the existing unmodified `clean_scan.py`, then run the new
`assemble_chess_set.py` to lay them onto a standard starting position and
write one combined `o`-grouped OBJ. The script itself was actually executed
(not just reasoned through) against synthetic board+piece meshes and
verified correct: every placed piece's bottom lands exactly at the board's
detected top surface, and mirrored squares land at the expected symmetric
coordinates. One real bug found and fixed during that run — the dry-run's
board-diagram printout abbreviated King and Knight both as "K"; now uses
standard algebraic notation. **Still needs**: the actual 7 scans (blocked on
the user), then a run against real data and the same visual/live-app
verification the chair went through.

## 7. `findExplodeParts` didn't work on real OBJ-loaded multi-part meshes

**Status: FIXED (needs live confirm)**

`manipulator.js`'s `findExplodeParts` read `part.position` for centroid/
explode-direction/home, which is meaningless for a real OBJ file with
multiple `o`-named groups — OBJLoader gives every part `.position` at the
default `(0,0,0)`, with real location baked into geometry vertex data. Every
part's centroid would have read as `(0,0,0)` and every explode direction
would collapse to the same degenerate fallback. Fixed by recentering each
part's geometry around its own local bounding-box center and folding that
into `.position`, composed with whatever position already existed rather
than overwritten. A new `test.js` group builds parts the way a real
multi-group OBJ actually loads and confirms explode/select/grab/reset all
work correctly against that representation — this is reasoned through very
carefully and the synthetic test is designed specifically to catch a
regression here, but per items #1-3, `test.html` still hasn't actually been
run in a browser this session to confirm it passes as written.

## 8. [A-v1] Poisson fill randomly aborted clean_scan.py — and reported success

**Status: FIXED (verified offline)** (2026-09-29). Found while building
`completion/benchmark.py` (Track B): PyMeshLab's screened Poisson with default
threading intermittently prints `Failed to close loop` and exits the process with
**status 0**, so a failed clean-up looked like a successful one (no output file,
no error code). Measured on the chair: multi-threaded Poisson succeeded 1/5
identical runs; the documented `clean_scan.py` chair command produced output 1/3.
Fix: `threads=1` on both Poisson calls (`POISSON_THREADS_NOTE` in `clean_scan.py`).
After: 5/5 runs produce output, identical stage stats (symmetry 164.3°, 88.3%), and
faster (5.4 s vs ~10.5 s). No regression check in `test.html` possible (Python) —
`completion/benchmark.py` exercises Poisson on every run and reports any native
crash as a FAILED row instead of hanging.

## 9. [A-v1] Any saved note crashed the measure panel, and left hologram.html's camera button disabled

**Status: FIXED (verified offline)**: 2026-09-29 lab run. `createAnnotations()` restores saved
notes synchronously and calls `onChange` → `renderNotes()`, which read the `annotations` const
before it was initialised (measurePanel.js, TDZ `ReferenceError`). Reproduced by saving one note
to localStorage and reloading. index.html showed the error as its status, with the SIZE section
empty. On hologram.html, `loadModelById` threw part-way through, so `swapping` stayed true, the
carousel was stuck "busy", and `startBtn` was never re-enabled. Fixed by ignoring `onChange` until
construction finishes; the existing initial `renderNotes()` draws the list. The regression group
in test.js is "Measure panel — saved notes". Both pages now load cleanly with a saved note.

## 10. [A-v1] Swapping models erased the previous model's saved notes

**Status: FIXED (verified offline)**: 2026-09-29 lab run. `measurePanel.dispose()` →
`annotations.clear()` → `remove()` per note, and `remove()` saves each time, so a carousel swap
wrote `[]` over the model's stored notes. Measured: a stored note became `[]` after one swap, and
the note was gone after swapping back. `clear()` now tears down markers and labels without
persisting. Covered by the same test.js group, and confirmed live with 6 back-and-forth swaps.

## 11. [A-v1] Explode stretches the object while two open hands are held still

**Status: FIXED (needs live confirm)** (2026-09-29 smoothing rewrite). Found by the gesture lab
(`docs/lab/gestures/gesture-lab.html`). Explode is the only continuous channel with no deadzone
(`applyExplode`), and its clamp floor is the home scale. Tracking noise can therefore push the
stretch up but never back down. Measured with two still open hands, realistic 0.002 jitter and
smoothing off: scale.x reaches 1.069 after 3s and 1.109 after 10s. At 0.004 jitter it reaches
1.25 after 3s. Through the full pipeline (smoothing on) the lab shows none at 0.002 and
1.06/1.15/1.21 at 0.004/0.008/0.012. Fix direction: a span-rate deadzone like the other channels.
It needs a real-jitter number to size the deadzone, so it has not been guess-fixed.
**Fix:** explode is commanded from the change in hand span through a 0.3-palm backlash deadzone
(`commandExplode`), and its limits (home-scale floor, literal 0..1) are applied to an unclamped
per-session value instead of clamping each increment, which was the ratchet. Measured after: two
still open hands give stretch exactly 1.000 for 10s raw at 0.002 and for 3s through the filter at
0.002–0.012 (was 1.109 / 1.06–1.21); the canonical pull-apart still gives stretch 1.92. The
deadzone is sized for the synthetic jitter, so a real still-hands check is still owed. test.js:
"Model follow — a still hand holds the model exactly still".

## 12. [A-v1] A fast clap fails below ~15fps because landmark smoothing is per-call

**Status: FIXED (needs live confirm)** (2026-09-29 smoothing rewrite). `smoothLandmarks.js` blended with a fixed
`ALPHA = 0.5` on every call, which is the frame-rate trap manipulator.js removed everywhere else.
The gesture lab ran a 200ms clap at 8, 10 and 12fps: it does not fire with smoothing on, and fires
with smoothing off (it fires both ways at 15fps and above). A related effect: at 10fps, move, spin,
push and tilt give 60–78% of their 60fps result (push gives 48%). Part of that is measured
(`FILTER_GAIN` is exact only in continuous time; the discrete estimate is 0.93 at 15fps and 0.86
at 10fps). Fix direction: a time-constant alpha, `1-exp(-dt/tau)` with tau ≈ 24ms (equal to 0.5
at 60fps), which needs a timestamp passed in. Worth fixing only if the real camera runs below
~20fps; check the fps HUD first.
**Fix:** a One Euro filter (speed-adaptive cutoff) on real frame timestamps, which hologram.js
now passes in (from `requestVideoFrameCallback` capture times where available), plus a 250ms hold
for a hand that drops out. The manipulator no longer estimates velocity (FILTER_GAIN is gone), so
the 10fps shortfall is gone too. Measured after (synthetic): clap recall 22/24, 24/24, 24/24,
24/24 at 8/12/24/60fps (was 0, 0, 22, 24); move 98.6cm at 60, 24 and 12fps (was 76.1/73.3/64.3);
rest jitter 26–33% of raw (was 54%); lag on a clap-speed hand 4–5ms (was 17–33ms). test.js groups
"Landmark smoothing — One Euro filter" and "Clap at low camera frame rates". Live check: the
fps HUD, then clap in the Clap drill.

## 13. [A-v1] repair_scan.py `--poisson` silently wrote nothing about 2 runs in 5 (same cause as #8)

**Status: FIXED (verified offline)**: 2026-09-29 lab run. The #8 fix (`threads=1`) was applied
to clean_scan.py and completion/fill.py but not to repair_scan.py. Before: 5 identical runs of the
documented chair `--poisson` command gave exit 0 every time, but only 3 wrote a file ("Failed to
close loop"). After: 8/8 runs wrote a file with identical topology (56371 verts), ~2.0s each.
Also fixed in this pass: analyze_scan.py told users to paste a `CHAIR_TRIM` into
`trimByCylinder`, which no page calls any more. It now prints clean_scan.py's
`--crop-center-x/--crop-center-z/--crop-radius` flags. The printed values were verified with a
`clean_scan.py --dry-run`.

## 14. [A-v1] Hologram strobed ~27 times a second — photosensitivity hazard

**Status: FIXED (verified offline)** (2026-09-29). Reported by the owner as "blooming and
flashing … people who can't handle the flashing". Measured with the new
`safety-test.html` (WCAG 2.3.1: max 3 flashes in any 1 s): the v1 look produced
**27 flashes/s**. Root causes in the vendored `HolographicMaterial.js`:
- **Strobe:** `blink = fract(cos(t) * 43758.5)`, a random hash whose input moves far
  enough per frame to return a new random value every frame. The rim jumped 0 ↔ 100%
  about 60×/s. Replaced with a 0.3 Hz sine "breathing" capped at 15% depth.
- **Aliasing shimmer:** scanlines at 60 × scanlineSize cycles per screen (2400 at v1's
  40), which is sub-pixel noise. Now drawn in pixel space with a period of at least 4 px, plus a
  soft slow sweep. The whole-object pulse went from 25 → 100% swings to ±10%.
- **Step brightness on every gesture.** Now eased via `setBrightness()` (0.3 s).
- **Additive "bloom" stacking:** every surface behind the front one added its brightness.
  Now a scene-level depth pre-pass (`hologramLook.js`, opt-in via `scene.js`). On the
  multi-layer chess scan, blown-out pixels went 2.69% → 0.81%.
- **Rim sparkle on rough/faceted scans.** Shading normals are now smoothed over ~1.2 cm
  (no vertex moves, so measurements are unchanged; chair surface noise measured 0.098).
- **Found while fixing it:** the pre-pass first *added* flicker (17 flashes/s). The
  vendored vertex shader recomputed gl_Position with a different matrix order than three's,
  so the two draws z-fought. Fixed with the shared projection path plus polygon offset.
- The OS "reduce motion" setting now stills all animation (`motion` = 0).

Result: every configuration now measures **0–1 flashes/s** (chair and chess), and test.html
still reports 72/0. Not yet confirmed by a person sensitive to flicker; `safety-test.html` is
the regression check and belongs in `hologram-verify`.

## 15. [A-v1] A frame with a zero-size hand fired a clap reset

**Status: FIXED (verified offline)** (2026-09-29, found in the smoothing/accuracy sweep).
`handSpan()` returns 0 when either hand's palm length is 0, and `checkClap` (manipulator.js) read
that as "hands together, closing infinitely fast", so one degenerate frame (all landmarks on one
point) after the hands had been apart reset the model. Reproduced against the pre-fix code: scale
1.3 → 1.0 on that frame. `checkClap` now ignores a span that isn't > 0. test.js: "Clap ignores a
degenerate (zero-size) hand". Rare with real MediaPipe output, but it is a free reset out of
nothing when it happens.

## 16. [A-v1] Every camera stop/start leaked a whole gesture recognizer

**Status: FIXED (needs live confirm)** (2026-09-29). `startTracking()` in hologram.js called
`createHandTracker()` on every start, and `stopTracking()` never called `tracker.close()`, so each
stop → start built another MediaPipe GestureRecognizer (WASM runtime, 8 MB model, GPU context)
and orphaned the old one. Found by code reading; it can't be run here because starting needs the
camera permission. The tracker is now created once and reused, which also makes a restart skip
the model load. Live check: stop/start the camera 5× and watch memory in Activity Monitor.

## 17. [A-v1] Typing in the measure panel's fields fired hologram.js keyboard shortcuts

**Status: FIXED (verified offline)** (2026-09-29). hologram.js's window `keydown` handler did not
check the event target, so typing in the measure panel's calibration or fit-check inputs ran the
shortcuts: arrow keys (moving the caret) swapped the model, `m` hid the measure panel, `r` reset
the model, `p`/`d` toggled panels. Reproduced in hologram.html by focusing the calibration input
and sending `m` + ArrowRight: the panel hid and the chair swapped to chair.glb. The handler now
ignores keys aimed at inputs/textareas/selects/contenteditable and modified keys; re-checked the
same way (nothing fires in the input, ArrowRight outside it still swaps).

## 18. [A] Platform object mode: coarse, device-dependent wheel steps and a jumpy drag

**Status: FIXED (verified offline)** (2026-09-29). `platform/objectmode.js`:
- Wheel steps were 0.005 rad and 0.1% per raw delta unit: one Chrome notch (100) turned 29° and
  scaled ×1.105, while a Firefox line-mode notch (deltaMode 1, deltaY 3) turned 0.9°, 33× less.
  Now normalised to pixels (`wheelPixels`: lines × 40, pages × 800, capped at two notches per
  event) and stepped 7.5° / ×1.051 per 100 px notch; a trackpad swipe of the same length turns the
  same.
- The drag applied every pointermove immediately, so uneven event delivery (0–3 per frame on
  trackpads and high-DPI mice) moved the part in uneven steps. It now eases toward the newest
  cursor position once per display frame (25 ms), and release (or any endMove) snaps to the exact
  cursor point first, so the recorded edit and undo/replay stay exact.
- A drag ray within 3° of the horizontal drag plane is ignored (and such a press doesn't start a
  drag): near the horizon the plane hit runs toward infinity, so one pixel flung the part metres.
  Found by ray/plane arithmetic, not a regression test.
test.js: "Platform object mode — wheel steps, eased drag, exact history" (replayTo(0 / first /
end) and full undo are bit-exact). Also checked on platform/index.html with the sample loaded:
3 Shift+wheel notches → one 22.5° edit, one Alt notch → ×1.0513, undo restores bit-exactly.


## 19. [A-v1] measure.js ignored part transforms — multi-part models measured wrong

**Status: FIXED (verified offline)** (2026-09-29). Found when the gesture demo switched
to `assets/chair/chair_detail.glb`, which has 8 named parts. Each part sits at its own node
offset, with its geometry centred on its own origin (trimesh GLB output). `measure.js` read
raw vertex positions, so all eight parts were measured stacked at one spot. The panel said
**51.3 cm tall** for a 79.6 cm chair, and volume and seat height were also wrong. Any
multi-part GLB from any tool would hit this. Fix: `partMatrix()` / `readVertex()` place
every part's vertices by its transform relative to the measured object. The object's own
transform stays excluded, so scaling the hologram still doesn't change the real size. The
first version of the fix froze the page because its variable `e` clashed with
`horizontalSurfaces`'s own `e` (a temporal-dead-zone error inside the panel build); it was
renamed. Now: detailed chair 57.7 × 50.3 × 79.6 cm, 16.1 L, seat 44.8 cm (the clean mesh
gives 57.7 × 50.3 × 79.5 cm and 15.98 L). There are 3 new regression checks in test.html
(119/0).

## 20. [A] Workshop Measure tab crashed for every model (regression from #19)

**Status: FIXED (verified offline)** (2026-09-30). Found while loading the owner's chess
photo on the workshop page: the item showed "Cannot read properties of undefined (reading
'clone')" and the Measure tab stuck on "measuring…". Root cause: #19's `partMatrix`
(measure.js) assumed every object has `matrixWorld`, but `platform/measurements.js` measures a
plain stand-in whose transforms are already baked into its vertices, so every workshop
measurement threw each frame. #19 was verified on the gesture demo only, not the workshop page;
this was live for about 12 hours. Fix: objects without matrices are treated as already placed.
Regression check: "matrix-less stand-ins (platform Measure tab) measure without crashing"
(test.html 120/0). Verified on platform/index.html: the chair (57.7 cm, all 8 parts) and the chess
photo both measure.

## 21. [B] Completion thresholds meant nothing on large objects: fixed 250k samples

**Status: FIXED (verified offline)** (2026-09-30). Found by Debbie running the benchmark on a
synthetic 2.1 m sofa (`completion/truths.py`).
- **Symptom:** the `none` method (the partial scan, unchanged) reported 0.27–0.72 m² of
  "added" surface on the sofa (0.000 on the chair). Scores and `slab_fill`'s "is the back
  already scanned?" probe were silently wrong on anything much bigger than the chair.
- **Reproduction:** sample 250k points on `completion/out/truths/sofa.obj` twice and query one
  set against the other: 9.0% of the sofa's own surface is >5 mm from the nearest sample (the
  added threshold) and 21.5% is >4 mm (`PROBE_HIT`). Chair: 0.00% / 0.00%.
- **Root cause:** `fill.SAMPLES` and `benchmark.OUTPUT_SAMPLES` were fixed counts (commented
  "~3 mm on a chair") used against absolute-distance thresholds, so spacing grew with area
  (fill.py `keep_only_gaps`, `thickness_fill`, `slab_fill`, `complete`; benchmark.py `score`, `main`).
- **Fix:** `fill.sample_count()` = max(250k, area × 210k/m²), the chair's own density; the
  chair keeps exactly 250k. Scoring queries capped with `distance_upper_bound` (bit-identical
  scores, 50.7 s → 5.5 s per sofa output) so the denser sampling doesn't cost 20 minutes a run.
- **Regression check:** `.venv/bin/python completion/benchmark.py --truth completion/out/truths/sofa.obj --methods none`
  must print `added 0.000 m2` on every row.

## 22. [B] Symmetry search misses the mirror plane on objects over ~1 m (clean_scan.py)

**Status: FIXED (verified offline)** (2026-09-30, owner approved). Offsets are now at most 1 cm apart (`clean_scan.py` `find_symmetry_plane`). Sofa: 61.5° / 56.4% (wrong plane, mirroring refused) → **152.6° / 76.0%** (true plane, mirroring on), 2.5 → 12.6 s. Chair: 164.3° both before and after (99.8% → 99.7%, sampling noise), 2.5 → 3.7 s. Benchmark `complete` after the fix: chair unchanged (98/99/100%); sofa underside 24%/21% real (was 24/13), wall 68%/33% (was 74/35), holes 100%/22% (was 96/12). The plane is right now, but mirroring is not the sofa's bottleneck: slab_fill's 8 cm probe (#23) and Poisson (#24) are. The angle grid (3.9°) was not changed; 76% is still short of the 92% the exact plane scores.
which is shared with v1 and was not in her assignment.
- **Symptom:** a perfectly mirror-symmetric 2.1 m sofa scores 56.4% overlap (trust threshold
  60%) at 61.5° — the wrong (front/back) plane — so `mirror_gaps` refuses to mirror. The true
  plane at 152° scores 92.4%.
- **Reproduction:** `clean_scan.find_symmetry_plane(v, np.random.default_rng(0))` on
  `completion/out/truths/sofa.obj` → 56.4% at 61.5°.
- **Root cause:** `clean_scan.py:293` samples a fixed 30 offsets across the object, a 6.1 cm
  step on the sofa (1.4 cm on the chair), against a 2 cm voxel tolerance; 3.3 cm off the true
  plane the overlap is already down to 61%, so the coarse pass never lands in the right basin.
  Proven by re-running the identical search with the offset step capped at 1 cm: 76.0% at
  152.6° (16.6 s instead of 3.4 s).
- **Fix (proposed):** in `proj_range`, `np.linspace(lo, hi, max(30, int(abs(hi - lo) / 0.01) + 1))`
  (step ≤ SYMMETRY_VOXEL / 2). The 46-angle coarse grid (3.9°) likely needs the same treatment
  for long objects: 76% is still well short of the true 92%. Re-run the chair after changing it
  (`clean_scan.py` chair command + `completion/benchmark.py`).

## 23. [B] slab_fill takes the "thickness" from a different part's edge

**Status: OPEN** (2026-09-30). Found by Debbie on non-slab truths (`completion/truths.py`). A — **2026-10-01 update: PARKED.** Geodesic-boundary fallback with an empty-probe guard tried behind `HW_SLAB_GEO=1` (default off): lamp underside 94→100%, stool 99%, vase/lamp wall real 34→40% / 46→52%, but chair underside added-real 98→93% and sofa real 32→20%. Same trade-off class as every variant; next idea if revisited: accept the geodesic drop only when its path length ≈ the straight-line distance (Ricky's 'hybc').
design weakness rather than a crash, logged so the numbers aren't lost.
- **Symptom:** stool: 36.9% of the seat top is never offset (Poisson happens to close it, so
  coverage still reads 100%). Lamp: 54% of the base top is never offset, underside 94%. Sofa:
  with 1% of the surface hidden as holes, `slab_fill` adds 0.85 m² of which 23% is real.
- **Root cause:** `fill.py` `slab_fill` picks the nearest open-boundary vertex in the plane
  perpendicular to the direction, ignoring distance along it, then discards the face if that
  drop is outside [4 mm, 8 cm]. The nearest edge is often another part: the stool's rung
  31 cm below the seat, the lamp shade rim and spokes 27–44 cm *above* its base (the 26
  directions sit ~16° off vertical, so tall parts project sideways by ~8 cm). On thick parts
  (sofa, 14–30 cm) the 8 cm probe never meets the far side, so every face looks like a slab
  and its "thickness" is the drop to the nearest hole edge.
- **Tried, not shipped:** picking the nearest boundary *with a plausible drop* (k=32). Lamp
  underside 94% → 100% coverage but added-real 83% → 63%; sofa underside 24% → 39%; chair
  underside 98%/96% → 96%/92% and holes real 100% → 96%. A trade-off for the owner, not a fix.

## 24. [B] Poisson balloons when one side of a thin shell is hidden

**Status: FIXED (verified offline)** (2026-10-01, Debbie; thin-shell part below). `complete` added-real (`benchmark.py --methods complete`), before → after: **vase wall 34 → 75%** (0.077 → 0.046 m2 added), vase underside 48 → 100%, lamp wall 46 → 60%, lamp underside 84 → 90%, lamp holes 85 → 100%. Chair identical within 0.2 pts (underside 97.5% cov / 98.4% real), stool and sofa identical, synthetic room `slab_fill` bitwise identical (all 3 scenarios). `slab_fill` 0.5 → 0.6 s on the chair.
- **Thin-shell root cause (Debbie, isolated per stage on the vase walls):** (1) `slab_fill`'s "is the back already there?" probe started at 2 x PROBE_STEP = 10 mm (completion/fill.py, `depths`), so a 5 mm wall's far skin was never seen. Every shell face read as an open slab and was copied up to 8 cm into the cavity (15-20% of the invented points). (2) The real cause of the balloon: with one skin hidden, nothing supplied it. `mirror_gaps` adds 0 faces (a surface of revolution with one side hidden is still symmetric about the plane that maps the hidden side onto itself), and slab's in-plane boundary drop measures curvature, not wall thickness. So Poisson saw a single sheet and closed it 2-5 cm out (about 60% of the invented points).
- **Fix (completion/fill.py):** the probe starts at PROBE_STEP. New `_shell_offsets` (called by `slab_fill`): where a face's back IS captured, it measures the wall thickness (first opposite-facing sample, 1 mm steps, ≤ SHELL_MAX_THICKNESS 12 mm). An open face with no plausible slab drop is copied by a nearby similar-facing measured thickness, but only if ≥ SHELL_VOTE 50% of its 64 nearest captured faces (within 15 cm) are thin, and the copies are merged normal-aware. Without the vote the chair underside fell to 89% coverage (a seat borrowing a thin part's thickness); with it the chair gets 0 shell faces. Without the opposite-facing test the 5 mm probe read curved surfaces as 5 mm shells.
- **Regression check:** `docs/team-log/reports/2026-10-01-debbie-bug24-thin-shell-check.py` (PASS: vase wall+u 72.9%, chair underside 97.5/98.4; on the old fill.py via `--fill-dir`: 33.2% → FAIL).
- **Still open:** the sofa (big thick furniture) is untouched, 23-36% real. The vase "holes" coverage is still 77%. Thresholds are tuned on synthetic shells; a real scanned vase or lamp is unverified.

*Earlier status (overseer, from Ricky's research): IMPROVED, partly open.* Two causes: (1) Poisson balloons the open side; (2) the merge rule (`keep_only_gaps`) discarded the true outer skin, since a 5 mm wall's missing face is always within 1 cm of the scanned inner skin. Fix: normal-aware merge (a candidate is redundant only if a nearby scan sample faces the same way) in `slab_fill` + `complete`, and `poisson(density_trim=3.0)` in `complete` (drops low-density, unsupported surface; PyMeshLab density = `vertex_scalar_array`). Timmy, `complete`: vase wall added-real 15% → 34%, lamp wall 14% → 46%, sofa real +3–11 points, stool unchanged, chair 97–100% coverage. Trim 2.5 tested by the overseer: chair underside drops to 95%, so 3.0 stays (env `HW_DENSITY_TRIM` for experiments). Open: vase wall still ~66% invented; next ideas are thickness-aware shell offsetting and a per-region trim.
- **Symptom:** lamp, wall scenario: ~0.18 m² added (the whole lamp is 0.35 m²), only 14–18%
  real, a skirt out to r ≈ 0.30 m around a 0.14 m shade. Vase underside: 0.22 m² added, 24% real.
  Also inflates the sofa: underside 3.8 m² added, 13% real.
- **Root cause:** with one face of a 5 mm wall hidden, screened Poisson (`fill.py` `poisson`)
  sees a single oriented sheet and closes the solid on the open side; `keep_only_gaps` then
  keeps it because it is far from the scan. The roadmap's tier 3 specifies "screened Poisson
  with density trim"; `fill.poisson` has no density trim.
- **Fix (proposed, needs a benchmark run):** trim low-density Poisson vertices
  (`compute_selection_by_condition_per_vertex` on quality after Poisson with `preclean`/density
  output), or reject patches that don't touch a scan boundary.
- **Note:** coverage@2cm cannot see this class of failure. On the vase and lamp, `none` already
  scores 100% on walls because the kept inner skin is within 5 mm of every hidden point.
  Normal-aware coverage (an output point within 2 cm must face the same way, dot > 0.5) gives
  the honest numbers for `complete`: vase wall **36%**, vase underside 65%, lamp wall **55%**
  (plain coverage says 100% for all three).

## 25. [B] The object pipeline invents walls on room scans (slab_fill treats walls as slabs)

**Status: FIXED (verified offline)** (2026-10-01, overseer; Timmy benchmarks: chair/stool/lamp/sofa unchanged, room `complete` occlusion 13→40% and holes 84→95% coverage; that path now ~80 s vs ~30 s, but rooms use plane_extend via auto mode). `fill.slab_fill` now skips faces on shell planes (`planes.find_planes`, `shell=True`: floor, walls, ceiling), since a wall is not a slab. Room occlusion scan, slab_fill alone: **5.64 m² added at 25% real → 0.48 m² at 77% real**. Objects have no shell planes, so the chair/stool/sofa paths are unchanged (benchmarks re-run by Timmy). complete.py's room auto-mode stays the main protection; this closes the gap for a room part that includes a slice of wall.
(`completion/room_bench.py`).
- **Symptom:** `fill.complete()` on the room occlusion scan adds 22–27 m², only 18–21% of it real,
  in 30–34 s at up to 3.5 GB. `slab_fill` alone adds 5.64 m² by copying floor and walls to fake
  "thickness" offsets, and Poisson then wraps the ghost walls. (`mirror_gaps` correctly declines:
  overlap 0.44, below 0.60.)
- **Mitigation:** `completion/complete.py` now auto-detects rooms (≥3 shell planes from
  `planes.find_planes`) and runs `planes.plane_extend` instead of the object chain. Synthetic room:
  6 shell planes found → room mode, 6.9% inferred, 1.7 s; the chair still finds 0 → object mode,
  0.0% inferred.
- **Still open:** `fill.slab_fill` itself should skip faces on shell planes (or cap probe offsets by
  object size), so a segmented room part that includes a slice of wall can't trigger it.
- **Regression check:** `.venv/bin/python completion/room_bench.py --methods complete plane_extend --scenarios occlusion`.

## 26. [A-v1] Releasing a tilt or two-hand pinch chains straight into explode

**Status: FIXED (verified offline)** (2026-09-30, found by Debbie's gesture audit; fixed by Debbie).
- **Symptom:** hold a tilt (fist + second hand), open the fist: the mode became `explode` ~300 ms
  later, and lowering both hands casually then flew the parts out to the full 0.6 offset.
- **Root cause:** "two open hands" is exactly the pose a tilt or two-hand pinch leaves behind, and
  explode's entry timer was already running during the old gesture's 220 ms release
  (`manipulator.js` `enterFor` / `explode.update`); nothing required a pause between gestures.
- **Fix (owner's "Engage → Aim → Act"):** `manipulator.js` neutral gap. After any gesture ends
  (clap included), a *different* gesture can start only once 400 ms have passed and the hands have
  made no gesture's pose for 100 ms (`NEUTRAL_GAP_MS`, `NEUTRAL_HOLD_MS`, `updateGap`). Re-closing
  the same fist is never blocked. Direct interrupts of an active gesture (`SWITCH_AWAY_MS`) are unchanged.
- **Regression check:** `test.html` group "Neutral gap and safe clap (BUGS #26, #27)". Live page
  repro: explode never engages, offset stays 0 (was 300 ms / 0.6).
- **Still to confirm:** webcam checklist step 3 (tilt, release: no explode). Also check that
  relaxing before a new gesture feels natural and not sticky.

## 27. [A-v1] A fast reverse of explode fires a clap and resets everything, with no undo

**Status: FIXED (verified offline)** (2026-09-30, Debbie). Explode the chair, then bring the open
hands together fast: the clap check (`manipulator.js` `update`) ran in every mode and reset pose,
scale, explode and part selection.
- **Fix:** clap only fires from rest, meaning IDLE or an explode that has engaged but not pulled
  apart (two open hands are also the clap's ready stance), and never inside the neutral gap (#26).
  A clap also starts the gap, so separating the hands afterwards can't explode the fresh reset.
  Every reset (clap, R, Reset button) is now undoable, one step: `manipulator.undo()` /
  `canUndo` / `resetCount`, with the U key or Ctrl/Cmd+Z in `hologram.js`, and a status hint after a reset.
- **Also found and fixed:** hands that left the frame apart and came back close together read as a
  fast close (the last two-hand sample was kept across the dropout) and fired a phantom reset.
  Clap speed is now measured only across consecutive two-hand frames.
- **Regression check:** `test.html` groups "Neutral gap and safe clap" and "Reset is undoable,
  one step". Gesture lab and smoothing lab unchanged (clap recall 22/24 at 8 fps, 24/24 at 12-60 fps).
- **Still to confirm:** webcam checklist step 4 (fast explode reverse: no reset) and step 6
  (5 claps from rest still register). Known, not changed: after a big pull-apart a fast close
  un-explodes only after ~0.7-1 s, because explode's amount is deliberately unclamped (BUGS #11).

## 28. [A-v1] Part selection is never wired on hologram.html

**Status: FIXED (verified offline)** (2026-09-30, Debbie). `manipulator.selectPartAtScreenPoint`
was only called from `test.js`.
- **Fix:** `hologram.js` mouse click (the one-hand pinch is being retired for a finger-gun pointer
  later). Once exploded past half-way, clicking a part selects it and clicking empty space goes
  back to the whole model. A drag of more than 5 px is an orbit, and clicks are left alone while the
  measure panel's point or note mode is on. The status line names the selected part.
- **Regression check:** `test.html` group "Part selection by mouse on hologram.html (BUGS #28)"
  drives the real page in an iframe with synthetic pointer events (selected `seat_cushion`).
- **Still to confirm:** with a real mouse, explode, click a leg, then fist-grab: only that leg moves (#2's live confirm).

## 29. [A-v1] hands.html leaks a whole GestureRecognizer on every camera stop/start

**Status: FIXED (needs live confirm)** (2026-09-30, Debbie). Same bug as #16. `hands.js` created a
new tracker on every start and `stop()` never closed it.
- **Fix:** `hands.js` reuses the tracker (`if (!tracker)`, copied from hologram.js).
- **Regression check:** none automated (needs a camera). The page loads with no console errors.
- **Still to confirm:** stop/start 5× on hands.html while watching memory in Activity Monitor.

## 30. [A] The single-layer depth pre-pass is wiped by the background clear, so surfaces add up (photosafety #14 guard inactive)

**Status: FIXED (verified offline)** (2026-10-01). Found by Cody-2 building P5 (2026-09-30); fixed by Debbie.
- **Symptom:** two stacked scanned planes add their brightness: centre pixel 16,132,207 alone → 32,255,255 stacked (luminance 0.2211 → 0.7858), in both v1 `hologramLook` and Platform `lod`.
- **Reproduction:** `platform/p5-test.html`, section B30 (Color background, two stacked planes, read pixels). It failed 2/2 before the fix and was deterministic.
- **Root cause:** in three r161, `WebGLBackground.render` sets `forceClear = true` for a `THREE.Color` background and then calls `renderer.clear(autoClearColor, autoClearDepth, autoClearStencil)` even with `autoClear = false`. The background comes from `scene.js:9`. The colour pass in `hologramLook.renderSingleLayer` and `platform/lod.js` `render` was erasing the pre-pass depth.
- **Fix:** a new `hologramLook.renderColourPass()` turns `autoClearDepth` and `autoClearStencil` off for the colour pass only, so the background colour still gets painted. `renderSingleLayer` and `lod.js` both use it. `scene.js` is unchanged.
- **Regression check:** p5-test section B30, 4 checks (stacked = front alone; a single layer matches a plain one-pass render byte for byte, max diff 0), run on both renderers. p5-test 22/2 → 24/0.
- **Numbers:** in safety-test, chess + comfort blown pixels went 0.81% → 0.60% and v1 + comfort 3.85% → 3.25%. Every row is still 0–1 flashes/s. The 2026-09-29 #14 figures were taken with this bug present. In perf-test, Platform blown 2.26% → 2.00% and render time is unchanged (pr1 median 0.9 ms both runs).
- **Still to confirm:** whether the owner thinks the look is right where layers overlap (overlaps are now dimmer, as #14 intended).

## 31. [A-v1] Two-hand scale feels sticky on small motions and at every direction change (not a regression from f439528)

**Status: FIXED, awaiting live check** (2026-10-01: owner chose the "smarter fix"; built by Cody. Reported in the owner's webcam test as "not as smooth as it was, depends on the range of motion"; investigated by Debbie).
- **Symptom:** the model ignores the first part of a pinch-scale move and freezes for a while each time the hands change direction. Small moves feel dead, big moves feel fine.
- **Reproduction:** a synthetic pipeline with two pinching hands (smoothLandmarks → `pinch()` → `update()`, `tick()` at 60 Hz), jitter 0.002-0.004, 30 and 49 fps, 4-5 seeds, moving out and back with an eased sweep. Small move (span ×1.27), 1.5 s per leg: scale starts **598 ms** after the hands start (pre-2026-09-29 code: 55 ms) and holds still for **809 ms** after they reverse (old: 39 ms). It reaches 82% of the intended size. Large move (×3.3): 250 ms to start and 439 ms after a reversal (old: 33 and 41 ms).
- **Not f439528:** current code and `f439528^` give **bit-identical scale traces** in every realistic case: pinch ratio 0.15, 0.21 and 0.23 × 4 motions × 30/49 fps × jitter 0.002/0.004 × 5 seeds. They differ only when one pinch is so loose that it fails 71% of frames, where both versions are broken. With a sustained misread (pinch read as a fist or as open hands for 400 ms or more), the new neutral gap *helps*: the old code jumped to grab (moved 0.22-0.52, rotated 14-29°) or to explode (stretched 0.37 ln). The new code just holds the scale. Pinch flicker (single threshold, `gestures.js:15`) is not the cause: a firm pinch (ratio 0.15) misses under 2% of frames and causes 0.07 mode-drop frames per trial. The 2.5 clamp, the speed cap (`MAX_SPEED.scale` 3 → 8 changed nothing) and the One Euro settings (unchanged since 2026-09-29) are also ruled out.
- **Root cause:** the backlash deadzone on ln(hand span) from the 2026-09-29 rewrite (fa343f2): `SCALE_DEADZONE = 0.05` (`manipulator.js:50`, applied by `takeUpSlack` in `commandTransform`). A start costs 5% of span and a reversal costs 10% (2 × width) before anything moves. On a ×1.27 move, 10% is about 40% of the return stroke, which is why it "depends on the range of motion". The old velocity code had no deadzone, but a still pair of hands drifted the scale by up to 6.6%.
- **Trade-off (measured; rest drift = worst over 10 s with still pinching hands, 12 trials per jitter level):**

  | `SCALE_DEADZONE` | start / reversal delay, small slow move | rest drift at jitter 0.002 / 0.003 / 0.004 |
  |---|---|---|
  | 0.05 (now) | 598 / 809 ms | 0 / 0 / 0 |
  | 0.04 | not measured | 0 / 0 / 0.19% (1 of 12) |
  | 0.035 | not measured | 0 / 0 / 0.69% (5 of 12) |
  | 0.03 | 484 / 627 ms | 0 / 0.10% / 1.19% |
  | 0.02 | 436 / 551 ms | 0.04% / 1.01% / 1.75% |

  0.05 is the smallest width that keeps still hands at exactly zero drift up to 0.004 jitter, so a pure retune trades stickiness for drift. A structural option that could get both: about half to three-quarters of the ln(span) noise comes from the palm-length normaliser in `handSpan` (smoothed noise peak-to-peak 0.020-0.053 for the span vs 0.005-0.024 for the wrist distance alone). Normalising by a palm length smoothed much more heavily, or frozen when the pinch engages, should let the deadzone drop to about 0.025 with zero drift. That is untested and is a design change for the owner.
- **Fix:** `manipulator.js` `commandTransform` (constants and reasoning at `SCALE_DEADZONE` / `PALM_REF_DEADZONE`). While a pinch is held, the span is divided by a **held palm length** (captured at engage, re-normalised only past a 4% backlash of its own) instead of the live, noisy one (`gestures.js` `handSpan` gained an optional `{ palm }`). The deadzone moved from ln(span) to **0.12 palm lengths of span**, because the noise left is wrist-position noise, a fixed size in the image. It costs 3.2% of span with the hands 3.7 palms apart (was 5%), 2.3% at 5.2 palms, and 5.7% at 2.1 palms. Measured (same synthetic pipeline, medians of 5 seeds, start / reversal / reached):

  | case (30 fps, jitter 0.002) | before | after |
  |---|---|---|
  | small x1.27, 1.5 s, from 3.7 palms | 533 / 783 ms / 82% | 450 / 583 ms / 90% |
  | small x1.27, 1.5 s, from 5.2 palms | 533 / 783 ms / 82% | 400 / 517 ms / 93% |
  | small x1.27, 1.5 s, from 2.1 palms | 533 / 783 ms / 83% | 583 / 783 ms / 82% |
  | small x1.27, 0.3 s | 150 / 200 ms / 82% | 133 / 167 ms / 91% |
  | large x3.3, 1.5 s | 233 / 417 ms | 233 / 300 ms |
  | still hands 10 s, 1.5-4.5 palms apart, jitter 0.002 / 0.003 / 0.004 (120 trials each) | 0 / 0.41% / 2.36% worst drift | 0 / 0 / 0 |

  It helps, but it is not the old code's 30-50 ms: the first ~3% of a slow eased move is still slack, and an eased start takes ~400 ms to cover it. **Trade-off taken:** leaning toward or away from the camera mid-pinch now leaks a one-off 3.5-5% scale (0.8x to 1.25x leans; was 0). A fully frozen palm length leaked the whole lean (24% for a 25% lean), so it is not used.
- **Regression check:** `test.html` group "Scale responsiveness (BUGS #31)": mean start under 500 ms, reversal under 700 ms, at least 85% reached, zero drift for still hands 1.8 palms apart at jitter 0.004, and a 25% lean leaking under 8%. The old code gives 533 ms / 817 ms / 77% / 5 of 6 drifting, so the first four checks fail on it. The simulator is in Cody's scratchpad (`s31/`).
- **Possible next step (not built):** sliding the slack window back onto the hands after they rest 150 ms cut the reversal from 583 to 433 ms in the simulator with zero drift. The cost is that carrying on in the same direction after a pause would also cost one deadzone width. Needs the owner's decision.
- **Still to confirm:** on the webcam, a slow small pinch-spread should now start sooner and pause less at each reversal, still hands should hold the size exactly, and leaning in or out mid-pinch should change it only slightly. If the owner feels it mostly on *large* fast moves instead, the cause is something else (real pinch loosening at full arm span, which synthetic hands can't show).

## 32. [A] A pointer (finger gun) is read as a grabbing fist on every frame

**Status: FIXED (verified offline)** (2026-10-01: found by the owner's gun-lab probe on the webcam; fixed by Cody).
- **Symptom:** a pointer pose (index out, middle/ring/pinky curled; side-on or aimed at the camera) made `isFistLike` say "grab" on 100% of frames. Wiring the pointer would have dragged the model whenever you aimed, and the pointing hand's own pinch was blocked as `'fist'`.
- **Root cause:** `gestures.js` `isFistLike` falls back to `isFistShape` when MediaPipe's label is `None`, and `isFistShape` counts curled fingertips in 2D. A pointer has three curled fingers, which is enough. Aimed at the camera the index also foreshortens and counts as a fourth. A 2D image cannot tell the two poses apart.
- **Fix:** per-hand arbitration. `gestures.js` gains `pointerState(worldLandmarks, gesture)` (gunPose.js `isGun` on the 3D world landmarks) and `annotateHand(hand, aspect)`. `hologram.js` calls `annotateHand` once per hand per frame, which sets `hand.pointer = { gun, rejectedBy }` and passes it to `isFistLike` / `pinch` through a new optional `{ pointer, worldLandmarks }` argument. A pointer is never a fist. `Closed_Fist` still wins, and `isGun` vetoes that label anyway. Callers that pass neither argument (hands.js, labs, older tests) keep the exact old rule. A real fist cannot pass as a pointer: on the owner's hand a fist's index bends 97-109° (reach 0.60-0.88), against a pointer's ≤ 25° / ≥ 1.81 and limits of 45° / 1.35. `manipulator.js` now reads fists through `hand.pointer` (`fistOf`) and adds two rules:
  - **Post-pointer gap:** `POINTER_GAP_MS` = 300. Curling the index to leave the pointer *is* a fist, so for 300 ms after the pointer ends, from rest, no gesture may start. This is a timer only. It deliberately does not reuse the neutral gap's 100 ms relaxed-hands rule, which would stop "point, then hold a fist" from ever grabbing without opening the hand first.
  - **A pointer is not an open hand:** it no longer counts toward explode or clap. Without this, "pointer + relaxed other hand" turned from a false grab into a false explode.
- **Measured** (`test.html` replay: owner-shaped world + image hands, 50 fps, through smoothLandmarks → annotateHand → manipulator; old code vs new):

  | case | old | new |
  |---|---|---|
  | pointer side-on, label None: read as fist / in grab | 100% / 97% | 0% / 0% |
  | pointer at the camera, label None: read as fist / in grab | 100% / 97% | 0% / 0% |
  | real fist (palm, side, camera, label None; palm, Closed_Fist): fist / grab after 100 ms | 100% / 100% | 100% / 100% |
  | pointing hand's pinch rejected as `'fist'` | 100% | 0% |
  | other hand's pinch while the pointer aims | 100% | 100% |
  | pointer + open other hand, moving apart: not idle | 96% (grab) | 0% |
  | grab, then extend the index and sweep 0.15: model moves | 0.384 | 0 |
  | pointer → fist: first grab after the pointer ends | 0 ms | 360 ms |
  | rest → fist (control): first grab | 60 ms | 60 ms |
  | pointer with a misread (fist) frame every 200 ms: in grab | 97% | 0% |

- **Regression check:** `test.html` group "Pointer is never a grab (live probe 2026-10-01)", 21 checks. On the pre-fix gestures.js/manipulator.js/hologram.js, 10 of them fail and nothing else does. Gesture lab and smoothing lab output is byte-identical before and after. gun-lab self-test 45/0.
- **Still to confirm (live):** on hologram.html (Everything on or the Move drill), hold the pointer side-on and then aimed at the camera: the chair must not move. Make a fist: it must grab. Point, then curl the index into a fist and hold: it grabs after a short beat (~⅓ s), not instantly.
- **Not changed (next round):** while a pointer is held, the *other* hand's fist still grabs, and the pointing hand then works as the tilt hand. The cursor and click wiring is a later round.

## 33. [Library] An edit followed at once by opening another project is lost

**Status: FIXED (verified offline)** (2026-10-01). Debbie's Library ring break-test.
- **Symptom:** move a part, then choose another project within the 2 s autosave debounce: the move is gone when you come back.
- **Root cause:** `openProject` set `lib.opening` before flushing, and `saveWorkingNow` skips saves while opening, so the pending edit was dropped (`platform/main.js` flushAutosave/saveWorkingNow).
- **Fix:** `flushAutosave({ whileOpening: true })` from openProject (`platform/main.js` ~870).
- **Regression check:** `platform/library-test.html` B22.

## 34. [Library] Two copies of the same file in one scene reopen as one

**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Symptom:** a scene with the same scan twice (or the same bytes under another name) reopened with fewer items and lost one copy's edits.
- **Root cause:** sources were deduplicated by sha, so the saved list had one entry for both items.
- **Fix:** `currentSources()` keeps one entry per item's main file; only shared sidecars are deduped (`platform/main.js:620`).
- **Regression check:** library-test B24.

## 35. [Library] An edit made while another project is loading is lost
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Symptom:** during load-then-swap the old scene stays interactive; an edit made then vanished.
- **Root cause:** nothing saved the old scene between the start of the load and the swap.
- **Fix:** `replaceScene(..., beforeClear)` saves the old project just before the swap clears it (`platform/main.js:798-817`, called from openProject).
- **Regression check:** library-test B23.

## 36. [Library] Two tabs on one project overwrite each other
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Symptom:** the same project open in two tabs: the staler tab's autosave silently replaced the other tab's work.
- **Root cause:** working-copy writes had no revision check.
- **Fix:** `store.js` working copy carries `rev`; `saveWorking`/`saveVersion` take `baseRev` and throw code `conflict` (or `gone` if deleted elsewhere). `main.js` `keepConflictAsCopy()` (:686) continues the stale tab's scene as a new project titled "... (edits from another tab)".
- **Regression check:** library-test A34-A36, B28.

## 37. [Library] An edit made just before a reload is lost
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Symptom:** edit, then reload within the 2 s debounce: the edit is gone.
- **Root cause:** IndexedDB writes started in `pagehide` don't reliably finish before the page goes.
- **Fix:** `stashForUnload()` (`platform/main.js:1154`) writes a synchronous localStorage rescue copy; it is replayed on the next start and dropped once a save lands (`dropRescue`).
- **Regression check:** library-test B29.

## 38. [Library] Storage full: autosave fails silently and switching projects throws the edits away
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Symptom:** with the disk/quota full, edits weren't saved and opening another project cleared them without warning.
- **Root cause:** a failed save cleared `pending`; openProject then cleared the scene.
- **Fix:** `store.js` throws `StoreQuotaError` (code `quota`, readable message); `saveWorkingNow` keeps `pending`/`saveFailed`; openProject/closeProject refuse once (`discardOk`, `main.js:873`, `:947`) and say so; the next flush retries. See #43 for the follow-up button.
- **Regression check:** library-test B26.

## 39. [Library ring] A refresh during a fling skips the rest of the glide
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Symptom:** thumbnails arriving (or a rename) mid-fling made the ring jump, passing several cards in one frame.
- **Root cause:** `setProjects` reset the glide target instead of keeping the remaining motion.
- **Fix:** `platform/ring.js` ~485 keeps the remaining glide across a refresh.
- **Regression check:** `platform/ring-test.html` "#39" (fails on the old ring.js, passes now; ≤ 3 cards/s, never 2 in one frame).

## 40. [Library ring] A long project title pushes the actions button off the panel
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Root cause:** an `auto` grid track grew to the title's full width (`platform/index.html` ~218).
- **Fix:** `grid-template-columns: minmax(0, 1fr)` + ellipsis.
- **Regression check:** ring-test "#40" (fails on the old index.html, passes now).
- **Still to confirm:** on a phone-width window, a long title shows "…" and the ⋯ button stays visible.

## 41. [Library] Cmd+S pressed again (or held) makes duplicate versions
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Root cause:** key repeat and repeat presses each saved a version even with nothing changed.
- **Fix:** `lib.changedSinceVersion` (`main.js:535/706/751`): no changes → "no changes since the last saved version".
- **Regression check:** library-test B25 (5 presses → exactly one version).

## 42. [Library] Opening a project without a thumbnail hangs in a hidden tab
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Root cause:** the thumbnail step waited for an animation frame, which a hidden tab never runs.
- **Fix:** wait for a frame or 100 ms, whichever comes first (`main.js:913`).
- **Regression check:** library-test B27.

## 43. [Library] Storage full leaves no way to free space from the page
**Status: FIXED (verified offline)** (2026-10-01). Owner decision after #38: "Free space now".
- **Symptom:** after #38 the visitor is told storage is full, but deleted projects stay in the trash for 30 days and keep using the space.
- **Fix:** a "Hold: free space now" button appears in the status bar on a quota error (`platform/index.html` #freeSpace; `platform/main.js` freeSpaceNow ~563). Holding it `HOLD_GATE.ringMs` (650 ms; a short press or click does nothing) permanently removes already-deleted projects and unreferenced files at once — `store.purgeExpired(0, { orphanMs: 0, keep })` (`platform/store.js:525`) — then retries the failed save. Samples are never purged. `keep` spares files the open scene uses but hasn't referenced yet (a save that failed after storing its file), because the retry would otherwise reference a missing blob (`store.js` addRefs throws, :175). The button hides on the next successful save.
- **Regression check:** library-test B30 (button shows, 200 ms press does nothing, 800 ms hold purges the trashed project + its file + an orphan, scene files kept, edit saved, button hidden) and B31 (keep).
- **Still to confirm:** on the real page with a nearly full disk is not practical; check by eye that the button reads clearly and fills while held (simulated quota only).

## 44. [Library] A second open during the first one's thumbnail step runs unguarded
**Status: FIXED (verified offline)** (2026-10-01). Break-test.
- **Symptom:** open A (no thumbnail yet), then B straight away: B started loading, and when A finished it cleared "opening" and the busy state in the middle of B's load, so edits during B's load could autosave and a third open could start; A's thumbnail could be taken of B's scene.
- **Reproduction:** library-test B32 starts B from the very frame A's thumbnail step waits on. Before the fix: `A true B true opening/busy when A finished false/false` (1/1, deterministic).
- **Root cause:** `openProject` set `lib.opening = false` before the thumbnail capture (`platform/main.js`, old line ~904).
- **Fix:** `lib.opening` stays true until the thumbnail is stored; edits made meanwhile are handed to autosave afterwards; a thumbnail failure no longer counts as a failed open (`main.js` ~905-924).
- **Regression check:** library-test B32 (after: B refused, A opened with a thumbnail).

## 45. [A-v1] With everything armed, two-hand scale never starts if the hands come up open first
**Status: FIXED (needs live confirm)** (2026-10-01). Owner live report ("Everything on" drill: scale "really difficult").
- **Symptom:** raise both hands, then pinch both: mode goes explode → idle and stays idle while both hands pinch; scale never changes. Owner session 03-31-18: transform 2 entries / 2.6 s vs explode 8 entries in the drills.
- **Reproduction:** realistic synthetic hands through annotateHand → createEngagement → manipulator (30 fps): open hands 400 ms, then pinch + spread. Before: TRANSFORM 0/10 runs (76 of 90 frames both-pinching, scale 1.000); Scale-only channels: TRANSFORM at 533 ms. Same after grab → open 150 ms → pinch (0/10 at 15 fps).
- **Root cause:** two open hands are explode's pose, so explode engages in 50 ms; pinching ends it after its 220 ms exit, which starts the #26 neutral gap (`manipulator.js` `startGap`/`updateGap`). The gap needs 100 ms of "no gesture pose", which a held pinch never gives, so `allowed(TRANSFORM)` stays false until the hands drop. Not pinch flicker (noisy pinch around 0.22 still engages at 200 ms), not the pointer, not the engage band.
- **Fix:** `manipulator.js` `allowed`: TRANSFORM is exempt from the neutral gap (a two-hand pinch is never another gesture's leftover pose); the pointer gap and 50 ms entry still apply. After: TRANSFORM 10/10 at 733 ms (open→pinch), 10/10 at 933 ms (grab→pinch); #26 release chain still never explodes.
- **Regression check:** test.js group "Two-hand scale starts with everything armed (BUGS #45)" (snippet in docs/team-log/reports/2026-10-01-debbie-scale-45-test-snippet.js; Cody-C to append): fails 3/4 on old code, 0/4 on new. test.html 218/0.
- **Still to confirm:** Everything-on drill on the webcam: hands up open, pinch both, pull apart → scale within ~0.3 s; release → no explode.

## 46. [A] Polygon mode looked unchanged on the sample chair: "still the original hologram"

**Status: FIXED (needs live confirm)** (2026-10-01). Owner live report; session-platform 2026-10-01_04-40-04 (sample Chair, 304k tris, 8 parts; #polyBtn 4×, P 1×, 0 errors).
- **Symptom:** with Polygon on, the hologram looked exactly the same; only a faint lens ring appeared. Real page: lens read "27,862 faces" inside a 70 px circle, but no lines were drawn. Polygon also stayed disabled until a part was selected in object mode, with no hint.
- **Reproduction:** platform/index.html?db=…: open the sample Chair from the ring → Object mode → click seat → Polygon → hover. 100% on this chair.
- **Root cause:** (1) `look.js` lens density fade removes lines on triangles < 4 px; the chair's real triangles are ~0.6 px (LOD: 1.4 px median), so the lens drew nothing. Depth/LOD was ruled out (depthTest off changed nothing). (2) The mode changed nothing outside the lens: no whole-model view, skin at full brightness. (3) `main.js` `syncPolygonBtn` required a selection.
- **Fix:** `polygon.js`: a full wire over the whole target (selected item, or whole scene if nothing is selected) from a per-part simplification ladder, choosing the finest level with ~8 px triangles, capped at 120k (4.7k at the default view, 45k zoomed in, then the real triangles); it has its own depth so hidden lines stay hidden, dashed/dimmer on inferred faces, and leaves out hidden faces. The hologram eases (900 ms) to a faint skin (`look.setSkin`, 0.3×). One-line coach text + wire count in the read-out; status line on entering. The lens is unchanged and still selects patches. `look.js`: `createLensMaterial({ full })`, `createWireDepthMaterial`, `setSkin`. `main.js`/`index.html`: whole-scene entry, `getItems`/`onSkin` wiring, tooltip.
- **Regression check:** polygon-test group F (10 checks on the real 8-part chair): pixel diff with the pointer off the model 99% of model px changed (0% with the wire disabled in a scratch copy, so the check fails on the old behaviour); faint skin + lines; every part within budget; finer when zooming in; lens hits the right part 8/8; hidden faces leave the wire; whole scene; exit restores exactly (max diff 0); on/off toggling ≤ 2 flashes/s. polygon-test 42/0.
- **Still to confirm:** owner: open Chair, press P with nothing selected → within ~1 s the chair turns into a faint skin with a calm triangle wire; zoom in → the wire gets finer; hover → lens; click → amber patch. Say whether 0.9 s feels too slow, and whether the coarse wire at the default view reads as "its real triangle form" (it is a simplification until you zoom in; the read-out says "N of 304,000 triangles · zoom in for finer").

## 47. [A-v1] A held same-hand pinch on the pointing hand could start a grab

**Status: FIXED (verified offline; needs live confirm)** (2026-10-01; found by Cody-I wiring one-hand selection, fix applied by the overseer). With synthetic hands, a same-hand pinch held over ~300 ms whose hand read as a fist (index curled with the others, or MediaPipe "Closed_Fist") started a GRAB at 367 ms and moved the model up to 0.04. **Fix (manipulator.js):** an aiming hand that pinches stays latched as a pointer until the pinch opens or the hand leaves, so it never counts as a fist; the post-pointer gap starts at the release. Cody-I's patched-copy check: 0 grab frames in all 12 held-pinch cases, and pointer → fist with no pinch still grabs at 367 ms. test.html 304/0 after the fix. **Live check:** if a real fist brings the thumb within 0.25 palm lengths of the index tip, pointer → fist would stay latched until the hand opens.

## 48. [B] Poisson refuses real scans with back-to-back folded faces

**Status: FIXED (verified offline)** (2026-10-01, found by Debbie on the Redwood Bedroom reconstruction; fixed by Debbie).
- **Symptom:** `poisson` and `complete` FAILED on the real room (2/2 scenarios each, `PyMeshLabException ... screened_poisson`).
- **Reproduction:** `.venv/bin/python completion/redwood.py --methods poisson complete`; minimal: `docs/team-log/reports/2026-10-01-debbie-bug48-poisson-fold-check.py` (a sphere plus one flap and its reversed copy) fails 1/1 on the old code.
- **Root cause:** ~100-150 vertices where two faces fold back-to-back get null normals; `fill.poisson` (completion/fill.py, the screened-Poisson call) ran without `preclean`, and MeshLab refuses null-normal vertices.
- **Fix:** `fill.poisson(..., preclean=None)` now passes `preclean=True` by default (`fill.POISSON_PRECLEAN`; env `HW_POISSON_PRECLEAN=0` restores the old call). **On by default** because it changes nothing on clean meshes: Poisson output bitwise identical with/without on chair/stool/lamp/sofa partials (same time, ~2 s); `complete` benchmark rows identical to 4 decimals on all 24 object rows (chair underside 97.5% @2cm / 98.4% real); synthetic room_bench poisson rows identical.
- **Real room after:** occlusion poisson 66% @2cm / 25% real, complete 67% / 33% (F@5cm 72%); holes poisson 58% / 13%, complete 49% / 15%. They run now, but add a lot of invented surface (57-88 m2): plane_extend stays the room method.
- **Regression check:** the fold-check script above (PASS; `preclean=False` still fails, so the check bites).

## 49. [B] plane_extend over-extends small parallel shell planes on real rooms

**Status: FIXED (verified offline)** (2026-10-01, Debbie, `completion/redwood.py`; fixed by Debbie).
- **Symptom:** a real floor varies by ~8 cm, so RANSAC split it; a piece 6.6 cm lower became a "shell" and was extended across the room (21.8 m2 added from 1.8 m2 measured); same for a wall piece 14 cm behind the main wall. Real room plane_extend: 31% (occlusion) / 21% (holes) of added surface real; synthetic 100%.
- **Root cause:** `planes.find_planes` shell test judged each plane alone, so a parallel RANSAC fragment of the same uneven floor/wall also passed.
- **Fix (completion/planes.py):** after the shell test, a shell plane with a larger shell plane of the same orientation (within 10 deg) within `DUP_GAP` = 25 cm is demoted to a surface and flagged `shell_fragment=True`. `fill.slab_fill` excludes `shell or shell_fragment` faces, so its #25 room-shell exclusion is unchanged (face mask identical old vs new on both rooms). Auto-mode now counts a split floor once (Redwood 8 -> 7 shells; still room mode).
- **Real room after (cov@2cm / real@2cm / F@2cm):** occlusion 52/31/39 -> 50/43/46 (added 55.5 -> 31.7 m2); holes 50/21/29 -> 51/35/42 (70.3 -> 27.8 m2). Recall @2cm -2 pts on occlusion, F@5cm 69 -> 67 (occlusion), 56 -> 61 (holes).
- **Synthetic room_bench:** all rows for none/poisson/5 plane_extend variants/plane+poisson identical before vs after (no fragments found there).
- **Regression check:** `docs/team-log/reports/2026-10-01-debbie-bug49-shell-fragment-check.py` (synthetic 6 shells / 0 fragments; Redwood 7 shells / 1 fragment of 0.93 m2).
- **Still open:** real-room precision is 35-43%, not the synthetic 100%; the remaining invented area is not diagnosed.


## 50. [A] Platform top bar overflows at 1400 px and below

**Status: FIXED, needs a live check** (2026-10-01, Tony; CSS only in platform/index.html). Top bar now tightens at <=1600 px and turns buttons into icons (titles kept) at <=1520 px. Measured offline at 14 widths from 800 to 1700 px with the longest labels: 0 overlaps, no overflow. Not yet seen in a real browser. Original report (Timmy console sweep + owner guided run PL1): At 1400 px the bar content is 1441 px wide and "Inspector" is clipped; on smaller windows the owner sees boxes overlap, taking over half the screen, with features hidden. hologram.html and index.html fit.

## 51. [A] Autosave restore is not exactly where the owner left off

**Status: FIXED (needs live confirm)** (2026-10-01, owner guided run PL2 FAIL). All three causes fixed and verified offline (Debbie).
- **Symptom:** after a reload the edits came back but the camera, Scene/Object mode and selection did not; projects with a polygon edit lost their face edits and undo history.
- **Reproduction:** `?db=debbie-51`, sample chair: edit, wait 3 s, orbit, select a part in Object mode, reload -> camera back at the last *edit's* framing, Scene mode, nothing selected (in the app, and in library-test on the old code). Add a polygon I-mark + reload -> "opened Chair" with 1 `importLayout` edit instead of 7, marks gone (2/2). Moves, rotates, hand-style grouped/twisting edits, scale, pins and an edit 300 ms before reload all restored exactly (rescue stash works).
- **Root cause:** (1) main.js `noteEdits` only saved when the edit log changed, and `stashForUnload` skipped when no edit was pending: camera moves were never saved by themselves. (2) Mode and selection were never in the saved layout/extras. (3) export.js:182-183 `remapHistory` returns null for entries without `changes`/`before`/`after`; polyHide/polyInfer have neither, so the whole history is dropped and importLayout re-applies transforms only.
- **Fix:** (1+2) main.js: camera (`controls` change), mode and selection saved as a view-only autosave (same 2 s debounce + unload stash), stored in `extras.view` and restored on open; view-only saves pass `dirty:false` (store.js `saveWorking`), so they never count as "changed since version". (3) export.js `remapHistory` remaps polygon entries (item + polys[].part) instead of rejecting them; main.js `openProject` awaits the polygon module before adopting the history (it loaded in parallel, so its ops could be unregistered).
- **Regression check:** library-test B33 (camera autosave, not dirty), B34 (reload restores camera + mode + selection); B35 (polygon I-mark + hide and the full history survive a reload). All three FAIL on the old code (scratch copy; B35 old: 4 edits -> 1 importLayout, marks lost); library-test 72/0 now.
- **Still to confirm:** owner re-run of PL2 (orbit, select a part in Object mode, mark a patch inferred, reload).

## 52. [A-v1] Selection practice has no way to turn it off

**Status: FIXED, needs a live check** (2026-10-01, Cody; `calibrate.js`, `hologram.js`, `hologram.html`). Owner guided run MT1; session-hologram 2026-10-01_13-18-30.
- **Symptom:** once Selection practice started, the owner could not leave it to start the tape.
- **Root cause:** Esc already cancelled practice, but nothing on screen said so: the practice card is click-through with no button, and the owner pressed P (2×; Esc 0×), which only toggled the Tools tab. Practice also takes every hand click (`handsRuntime.route`), so the tape got none until all 7 rounds ended (both runs finished all 7, 0 cancelled).
- **Fix:** the practice card has a `✕ Stop (Esc)` button (`[data-role="practice-stop"]`, the only part of the card that takes clicks). Esc **or P** stops it. The 🎯 button toggles to `■ Stop selection practice` while it runs (synced every frame). Practice also ends when the tape or notes go on, on C (calibrate), or when a drill button is pressed. Help row updated.
- **Regression check:** test.html group "Selection practice always has a way out" (12 checks on the real page): Stop button visible and clickable; practice stops with each of Stop, 🎯 again, Esc, P, T, Notes, C, a drill; button label both ways.
- **Still to confirm:** owner: start practice, then press P (or the card's Stop) → the card and rings go away and the status line reads "Selection practice stopped"; then T → the tape takes pinch clicks.

## 53. [A-v1] Mouse movement spins the chair on hologram.html

**Status: FIXED, needs a live check** (2026-10-01, Cody; new `orbitGuard.js`, `hologram.js`). Owner guided run MT2: "Struggling to use the mouse because the chair keeps spinning when moving the mouse", so mouse tape points are hard to place. Session-hologram 2026-10-01_13-18-30.
- **Root cause:** three.js r161 OrbitControls stuck mid-drag. It was not auto-rotate (never turned on) and not the hands (the mode timeline shows no grab or explode during the mouse-tape stretch, 1540-1600 s). The run logged 16 console errors, all `OrbitControls.js:1071 Cannot read properties of undefined (reading 'x')`; six of them come ~0.2 s before mouse tape points. Line 1071 is only reached when the controls think two pointers are down, which happens after one pointerup never reached them. From then on they keep their pointermove listener and stay in ROTATE, so every plain mouse move (no button) spins the model. Each later click adds a duplicate pointer and throws again, so it stays stuck. The first error was at 407 s. What swallowed that first pointerup cannot be told from the data, so the fix does not depend on it.
- **Fix:** `orbitGuard.js` (`createOrbitGuard({ controls })`, no dependencies) follows the controls' own start/end events. While a drag is open it ends the drag (a synthetic pointercancel, which OrbitControls treats as pointerup) on a mouse/pen move with no button held, or on a new canvas pointerdown before the controls see it. Touch is left alone. Wired in `hologram.js` (`window.hologram.orbitGuard.repairs`). A real drag still orbits in every mode, tape and notes included (owner/overseer decision). `platform/main.js` has the same r161 controls and can import it (not wired this round).
- **Regression check:** test.html group "Orbit guard" (10 checks, real OrbitControls): unguarded, a lost pointerup makes plain moves spin the view 2.513 rad over 120 px (the bug); guarded, a real drag still orbits (2.513 rad), plain moves after a lost pointerup turn it 0 rad, a click straight after a lost pointerup is repaired first, wheel leaves no drag open, 0 errors. Live page (headless hologram.html): after a lost pointerup, 300 px of plain moves = 0 rad with the tape off and on; a real 100 px drag = 1.864 rad; 0 console errors.
- **Still to confirm:** owner: with the tape on, move the mouse around without clicking → the chair stays still; drag → it turns; click two points → the length shows, with no console errors.

## 54. [A] Patch marked inferred, then moved, shows a dark spot

**Status: NOT A BUG** (2026-10-01, owner guided run PO3; Debbie). The dark spot is the inferred mark itself, seen once the yellow patch highlight is gone.
- **Evidence:** sample chair, whole-scene polygon mode, patch on the seat -> I -> move part 1.1 by 0.35 m. Every face is still drawn (shown + relabelled overlay = all faces, both parts), each overlay's world matrix follows its part through the move, an item rotate and undo. The same spot is equally dark with no move and outside polygon mode. Measured brightness 0.61x the unmarked surface = the designed inferred look (look.js INFERRED_DIM 0.5 + hatch, P5 photosafety). Cmd+Z undoes the I-mark, so it vanishes.
- **Regression check:** polygon-test "#54 marked-inferred faces stay drawn and follow their part through a move and its undo" (43/0).
- **Owner decision (polish, Tony):** a user-marked patch on a bright scan reads as a hole. A lighter or differently tinted "marked by you" look would need the P5 photosafety check re-run.

## 55. [A-v1] Pointer pose loses hand tracking

**Status: OPEN** (2026-10-01, owner guided runs GD3/GD4). Open hand tracks well; switching to the pointer pose (index out, three curled) makes the hand drop out of tracking, hurting accuracy. Clap reset sometimes needs several claps (GD10); fast model switching stutters (GD12).

## 56. [A-v1] Holding the tilt hand up tips the model past 90° (lab read "spin 180")

**Status: FIXED (needs live confirm)** (2026-10-01). Found by Timmy's commit-gate pass 4 (gesture-lab tilt row).
- **Symptom:** gesture-lab tilt read p−79.3°/r180° and "also fired spin 180°" (p−42.3°/r0 at ad941bc). In fact this is one pure −100.7° pitch (the quaternions are 0.000° apart), so the Euler readout flipped. An 8 s hold reached ~180°.
- **Reproduction:** `docs/lab/gestures/gesture-lab.html?only=tilt`; test.js #G3b without the limit: max 177–180° at 10/30/60 fps.
- **Root cause:** manipulator.js commandGrab, hybrid tilt rate term (`rate()` → `s.ch.pitch.cmd +=`). It had no bound, so it kept turning while the hand stayed beyond TILT_RATE_ZONE. Spin was never driven.
- **Fix:** manipulator.js `TILT_LIMIT` 75°/`easeTilt`. Pitch and roll are each held within ±75° of the grab start, easing from 45° (exponential approach, low-fps safe). Moving back is never slowed.
- **Regression check:** test.js #G3b (10 s full-rate hold at 10/30/60 fps: max 75.0°, roll/spin 0.0, eased, tilts back). #G3 windows moved below the limit.
- **Still to confirm:** live webcam check that the 45–75° ease feels smooth, not sticky. Momentum coast after release is not limited (small near the limit).

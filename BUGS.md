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

**Status: OPEN** (2026-09-30). Found by Debbie on non-slab truths (`completion/truths.py`). A
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

**Status: OPEN** (2026-09-30). Found by Debbie on the vase and lamp truths.
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

**Status: MITIGATED (verified offline)** (2026-09-30). Found by Cody on the synthetic room
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

**Status: OPEN** (2026-09-30, found by Cody-2 building P5; the mechanism was confirmed by the overseer reading the code).
- **Symptom:** two stacked scanned planes add their brightness, 16,129,203 alone → 32,255,255 stacked (Cody-2's measurement). #14's "draw only the front layer" guard isn't taking effect.
- **Cause:** `scene.js:9` sets a `THREE.Color` `scene.background`. In three r161 a Color background makes WebGLBackground **force-clear** colour and depth at the start of every `renderer.render()`, even with `autoClear = false`. `hologramLook.renderSingleLayer` (hologramLook.js ~:59-69) and `platform/lod.js` (~:176-189) render a depth pre-pass and then a colour pass, and the second render's forced clear erases the pre-pass depth.
- **Likely fix:** keep `autoClearDepth` false (or null the background and clear to the colour manually) for the colour pass. Re-run `safety-test.html` and the P5 photosafety check afterwards. `platform/p5-test.js` section B works around this with a null background.
- **Risk until fixed:** inferred and scanned layers glow additively where they overlap. It was still measured at 0 flashes/s on the P5 check, so this is brightness stacking, not flashing.

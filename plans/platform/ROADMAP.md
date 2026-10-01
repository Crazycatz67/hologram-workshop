# Track A — Hologram Platform — Roadmap

**Vision:** an architectural hologram website. **Upload any LiDAR scan**, a whole room or a single object, and it becomes an interactive hologram. **Controls work the same on everything**, with no hand-prepared parts: the site finds the objects and parts itself. From there:
- **colour individual objects or parts**
- **redecorate**: select, move, rotate, hide or restore furniture, snapping to floor and walls
- **measure**
- **see what the scanner missed**, filled in by Track B and always marked as inferred

The chair and chess set from v1 are **test assets**, not the product. Everything v1 built (hologram shader, gesture engine, measurement, per-part explode) is this track's foundation; its history is in [`../object-hologram/ROADMAP.md`](../object-hologram/ROADMAP.md).

**Positioning (from [`../scan-completion/RESEARCH.md`](../scan-completion/RESEARCH.md) §3–4): honest, open, local.**
- IKEA Kreativ only erases in 2D and only places IKEA products.
- Matterport's defurnishing is paid and cloud-based.
- Polycam's free tier exports GLTF only.
- RoomPlan knows 16 box classes.
- Existing gesture demos handle a single object.

Nobody offers free, in-browser, gesture-controlled interaction with *your own segmented room*, with honestly marked filled-in geometry.

## Revision History

- **2026-10-01 (3):** **Owner's first full live test → redesign of selection and UI** (Ricky's reports; owner decisions):
  - Calibration "works really well"; the absolute cursor is kept.
  - **Selection (other-hand pinch) was too hard** (needs both hands in view; distance-sensitive). New: **bubble targeting** (nearest part highlights, with hysteresis) + **hold still ~0.65 s to select** (holdGate ring, invisible for the first 200 ms) + a **quick same-hand pinch** with aim freeze and rewind for speed. Exploded parts get an outline, a name chip and "spread to fit"; **hold again to cycle** through overlapping parts. A/B'd in calibration practice.
  - **UI declutter:** the gesture demo moves to the Platform layout (right-hand Tools panel with Practice / Measure / Look tabs, one priority coach box for every prompt, a clean top bar). Instructions follow a writing standard (icon, verb first, ≤2 lines, "✓ success looks like…"). Measure is ordered Size → Tape (toggle, key T) → Notes, with Weight & shipping and Will-it-fit folded under "Report".
  - Built on the shared `handsRuntime.js` (P1 design step 1).
- **2026-10-01 (2):** **Finger-gun probe run by the owner (webcam, 49 fps): the click is the OTHER HAND'S PINCH.** The aiming hand's palm moved 8 px (median) per one-hand pinch versus 13–25 px per thumb drop (max 48 px), and the thumb drop failed every shift check. Other findings:
  - **The gun pose was recognised on 0% of real frames.** `gunPose.js` thresholds came from a synthetic hand. Being re-fitted from per-check diagnostics, with the thumb condition dropped since it no longer triggers anything.
  - **Canned labels can't find it:** pointing at the camera reads as Thumb_Up 100% of the time; side-on is mostly None.
  - **Grab collision confirmed live:** the current fist check read the gun as a grab on 33–47% of frames during thumb movement. A per-hand gun veto is required before wiring.
  - The lab's 31–44 px "jitter" was 5 s drift, not per-frame noise; a true per-frame measure is being added.
- **2026-10-01:** **Library ring (hologram selector) decided and in build.** Design: Ricky's report `docs/team-log/reports/2026-09-30-library-ring-selector.md`. Owner decisions: **one card = a whole workbench scene** (several items can be arranged together); **autosave a working copy + explicit "Save version"** (Ctrl/Cmd+S), versions stacking under their project; **the ring is the landing screen** (3 chair samples + "Drop your own scan"); versions stay **edit logs replayed on the original files** (non-destructive, matching the polygon-mode decision). Storage is IndexedDB in the visitor's browser (`platform/store.js`); the ring is `platform/ring.js`. Mouse/keyboard/touch first; hand control follows once the Platform has hands (aim + click, fist-drag spin, ✌ wheel → Library).
- **2026-09-30 (2):** **P5 built, and v1 gesture bugs #26–#29 fixed.**
  - **P5 "Show What Was Filled In":** a Track B completed scan (OBJ + `.json` sidecar, dropped together or `?model=`) shows its inferred faces as ghosted, still, low-contrast hatched meshes. **View: Completed / As scanned** button + **I** key; the library row shows % inferred (cross-checked against the faces), method and licence; Measure shows "(includes inferred)". Scanned faces are unchanged (count, area, position checksum). 0 flashes/s. `platform/p5-test.html` 20/0. Needs the owner's look check. Caveats: disconnected Poisson patches become their own parts; measurements include inferred geometry even in "As scanned" (tagged); BUGS #30 means overlapping layers add up until the depth pre-pass is fixed.
  - **Built, not wired yet:** `holdGate.js` (the confirmation ring, lab 19/0) and `gunPose.js` + `docs/lab/gestures/gun-lab.html` (the 2-minute finger-gun probe that decides the click).
- **2026-09-30:** **Interaction design decided by the owner** (from Ricky's research and Debbie's gesture audit, reports in `docs/team-log/reports/`).
  - **Gesture scheme "Engage → Aim → Act":**
    - Hands count only when raised (lower them = rest, nothing fires).
    - What you point at decides the target: a fist over an object grabs it, over empty space orbits.
    - A ~400 ms neutral gap after any gesture before a different one can start; commands only from idle.
    - Three confirmation tiers: **instant** (grab, spin, tilt, scale, aim, drag), **short** 150–250 ms (select, click, explode start), **ring** ~650 ms for commands (undo, tool wheel, reset, hide). The ring is ported from the ASL project, stays invisible for the first 200 ms, pauses while the hand moves, and repeats within 2 s drop to the short tier.
    - Six poses or fewer. Either hand can do anything.
  - **Pointer = "finger gun":** index out, other fingers curled (thumb anywhere, since 2026-10-01) switches aim mode on. A remote-style cursor moves with the palm (slows down for precision), with a beam from the ghost hand to a snapping crosshair. **The click (thumb drop vs the other hand's pinch) is decided by a live probe** (`docs/lab/gestures/gun-lab.html`).
  - **One-hand pinch is retired for selecting.** Pinch now means two-hand scale only.
  - **✌ held ~0.65 s opens a tool wheel** (Measure, Polygon, pin, hide, redo, units, exit); keys and buttons also work. **Thumbs-down held = undo.**
  - **Clap reset kept**, but only from idle, outside the neutral gap, and undoable.
  - **Pins act against edits only:** a pinned item or part never moves; the item and camera hold still while one part is edited.
  - **Measuring keeps its tapes** (a new click starts the next; thumbs-down undoes). The crosshair turns amber over inferred surface.
  - **Polygon mode = a "polygon lens":** see and select the scan's real triangles. **Non-destructive only** (hide, select, relabel, mark as inferred); hand edits never move measured geometry.
  - **Open:** a carousel/selector for choosing holograms and saved versions (research running).
- **2026-09-29 (5):** **Rendering performance: display LOD + a cheaper single-layer pass (`platform/lod.js`, `platform/perf-test.html`).**
  - **Measured first:** `perf-test.html` times `render()` directly with a readPixels sync (rAF-throttled fps counters lie in background tabs). On this Mac the 304k-tri chair costs ~0.74 ms/frame pipelined at pr 1 (0.94 at pr 2), so it's not a bottleneck here; the work is headroom for weaker laptops and room scans.
  - **Display LOD:** meshoptimizer simplifies dense scenes to ≤120k displayed tris (chair_detail 304k → 120k at 0.02–0.06 mm error; chess 233k → 120k at 0.05 mm). The LOD shares the scan's vertex buffers (only a new index) and is swapped in only inside `render()`, so measurements, exports, raycasts and splitting always read the full scan (Measure tab verified identical). Full detail returns when zoomed so close the error would exceed ~1.5 px, when Realism > 0.5, and always in Plain mode.
  - **Single-layer pass:** the depth pre-pass now covers only additive-blended meshes and is skipped entirely in Plain mode. Same geometry in both passes, so no z-fighting.
  - **Result:** pipelined ms/frame −35–45% on chair_detail and chess; Photosafety on the platform path is 0 flashes/s even when the LOD is forced on and off every 10 frames. The PNG export now uses the same render path as the screen.
- **2026-09-29 (4):** **Photosafe look, realism blend, multi-file library, exports, photo → hologram.**
  - **Photosafety (BUGS.md #14):**
    - The v1 look strobed at **27 flashes/s** (WCAG limit: 3). Every configuration now measures 0–1 (`safety-test.html`).
    - Additive bloom is stopped by a single-layer depth pre-pass (chess: 2.69% → 0.81% blown-out pixels).
    - Rough scans get smoothed shading, with no vertex moved.
    - The OS "reduce motion" setting is honoured.
  - **`platform/look.js`:** a Realism slider (0 = hologram, 1 = the scan's real texture / photo colours / clay shade for geometry-only scans, with a faint rim kept), a Motion slider, an optional gentle glow pulse, and a Calm preset. Settings persist per browser. Per-mesh variants share every look uniform, so one slider drives the whole scene. Verified on the textured `chair.glb` (real wood and floor texture at 100%) and a photo relief.
  - **Library (`library.js`, `upload.js`, agent-built, reviewed):** drop many files or a folder. OBJ+MTL+textures and .gltf+.bin are matched by name so detail survives. Each file becomes a library item (hide / focus / remove), with "Arrange all" and object mode across every item.
  - **Exports (`export.js`):**
    - A GLB of the edited scene using the original materials, with `extras` recording the source and inferred share.
    - Layout JSON with a sha256 per item, plus re-import (verified to restore moves and hides exactly).
    - A printable floor-plan SVG with hulls, W×D labels and a scale bar.
    - A PNG screenshot.
  - **Photos (`photo.js`):** Depth Anything V2 small (Apache-2.0) in the browser via Transformers.js 4.3.0 on WebGPU (WASM fallback). A photo becomes a 2.5D relief with real colours in ~1.5 s warm. It's honestly labelled front-only, with estimated depth.
  - **Known:** crowded layout in narrow windows (the Library panel covers the view); drag-drop from the OS and the folder picker are coded but only exercised programmatically.
- **2026-09-29 (3):** **P1 first slice built (mouse and keyboard; gestures next).**
  - **Splitting:** `platform/segment.js` `splitComponents` welds vertices at 1 mm, runs union-find over triangles, and makes each connected component above 2% of the scan's diagonal its own selectable part. It's a placeholder until P2's plane-peel segmentation.
  - **Object mode:** `platform/objectmode.js`. Toggle with Tab or the button. Hover highlights before commit, click selects, drag moves on the floor plane with the camera locked while dragging, Shift+wheel rotates about the part's own centre, Delete hides, H shows all, Esc deselects, Cmd/Ctrl+Z undoes.
  - **Edit log:** every edit goes to a JSON log (`window.hologram.edits`), the SceneScript-style list from the roadmap. Undo restores exact transforms.
  - **Action API for gestures:** `beginMove`/`moveBy`/`endMove`, `rotateSelected`, `hideSelected`, `showAll`, `undo`. Gestures must call these rather than touch the log.
  - **Verified in Chrome** on a synthetic multi-part scene (5 components → 4 parts, 7 ms). The chair and the raw chess scan are each **one** connected blob (the pieces touch the board), so connectivity alone can't split real scans. That confirms P2's plane-peel is needed.
  - **Caveats:** splitting takes ~0.6 s synchronously at 76k–233k tris, so large rooms need a Worker. Shift+wheel steps are coarse (~0.5 rad per notch). A real Tab keypress from the automation tool didn't toggle mode; dispatched events and the button did, and the key still needs a hands-on check.
- **2026-09-29 (2):** **P0 built** in `platform/` (`index.html`, `main.js`, `upload.js`, `framing.js`).
  - **What it does:** drag-drop or pick GLB/GLTF/OBJ(+MTL)/PLY, parsed in the browser. `detectFloorY` finds the lowest large up-facing surface: a histogram of vertices with upward normals, trusted only in the bottom 15% of the height, otherwise it falls back to the 1st percentile of height, so a floorless chair's seat is never taken for the floor. Every scan is placed with its floor at y=0, and scans wider than 2.5 m get the dollhouse framing. It shows a stats readout, a plain-material toggle and a "Load sample" button.
  - **Deviation from v1:** framing never moves the scan (v1's `frameObject` re-centres it). The Platform needs one consistent floor for snapping, and pivots belong to the selected object.
  - **Verified in Chrome:** the chair loads, standing on y=0, 76,000 tris, 0.61 × 0.67 × 0.80 m, no console errors. Room framing was checked only on a synthetic 6×5 m floor.
  - **Not yet exercised:** a real room scan, actual drag-drop / file picker, PLY files, error paths.
  - **Known gaps:** W×D is the axis-aligned box, not the oriented footprint (`measure.js` has the oriented version, due in P4). Point clouds render with a plain points material. The capture-tips panel overlaps the model in narrow windows.
- **2026-09-29:** Track created as a main focus, alongside Scan Completion (Track B). It absorbs the short-lived "Room Hologram" track, whose useful content is merged below (capture notes, touching-objects and clutter risks, room-scale camera, size budget).

## Constraints (this track)

- **Browser-only, no build step, free.** This carries over from v1. New libraries come from the CDN import map: `three-mesh-bvh` (MIT) and `meshoptimizer` WASM (MIT), plus `manifold-3d` WASM (Apache-2.0) if needed.
- **Uploads are processed in the visitor's browser**, with no server: file → Web Worker → labels → IndexedDB / exported GLB. Nothing is uploaded anywhere, which is a privacy selling point for scans of people's homes.
- **Live v1 pages stay working.** New work lives in `platform/` until it deliberately replaces `hologram.html`, and `test.html` stays at 0 failures after any change to a shared root module.
- **three.js is pinned at r161.** Upgrading unlocks the newer `USDLoader` (RoomPlan USDZ) and Spark (Gaussian splats, needs ≥0.180), but it touches everything `test.html` covers. It's a deliberate, separate step (P6), never a side effect.

## Phases

### P0 — Upload Any Scan
Drag-drop or file picker for GLB / OBJ(+MTL) / PLY, parsed locally. Then:
- **Auto-detect the up axis and floor.** Port the "floor = large plane that touches the capture boundary" rule from `clean_scan.py` to JS.
- **Auto-frame by scale.** Object-scale scans get today's orbit framing (`frameObject`). Room-scale scans get a dollhouse overview.
- Reuse `scene.js`, `loadModel.js` and `HolographicMaterial.js` unchanged. Room-specific framing is a new function, not a change to `frameObject`'s defaults.
- Decimate large uploads with meshoptimizer so a room stays smooth on the M5 Air.

**Capture guidance shown on the page:**
- Scaniverse **Object** mode for single items and **Area** mode for rooms.
- Take one phone photo per important object, which Track B uses.
- For best room results, a RoomPlan export from 3d Scanner App (once P6 lands).

**Size budget:** GitHub rejects files over 100 MB. Uploaded scans never touch the repo. Demo scans committed to `assets/` must be decimated/compressed first.

**Done looks like:** the chair, a chess piece and a real room scan all load by drag-drop, framed sensibly, as holograms. Triangle count and frame time are recorded here.

### P1 — Universal Controls
Two modes, following Quest/visionOS practice:
- **Scene mode:** gestures and mouse move the *camera* (dollhouse orbit, zoom, optional walk-through).
- **Object mode:** a ray (the finger-gun pointer or mouse) **highlights before committing**, and a pointer click selects (one-hand pinch is retired for selecting, 2026-09-30). Then v1's gesture set applies to the selection: move, spin, tilt, scale, under the Engage → Aim → Act rules above. Floor/wall snapping, with a transform gizmo for mouse users.

Reuse `manipulator.js`, `gestures.js`, `stabilizer.js`, `smoothLandmarks.js` and `handTracker.js` **per selected segment** instead of per `o` group. The v1 practice mode and gesture-isolation lessons apply directly: room-level and object-level gestures must not bleed into each other.

**Done looks like:** on a real webcam, switch to object mode, aim at one item in a room, grab it, move it and set it down, without the camera or other objects moving.

### P2 — Automatic Segmentation (no parts needed)
Runs in a Web Worker on upload:
1. Decimate.
2. **RANSAC plane peel:** floor, walls, ceiling.
3. **Connected components / voxel DBSCAN** on the remainder, giving objects.
4. Per object, **dihedral-angle / concavity region growing**, giving parts (legs, seat, back).

The result is stored as a per-face **`segmentId`** (objects and parts as a two-level hierarchy). **three-mesh-bvh** powers picking plus brush/lasso tools to **merge, split, relabel**. Automatic splits will be wrong sometimes, and a fast fix-up tool is part of the design, not a patch.

**Known risks (carried over from the room plan and v1's chess lesson):**
- **Touching objects** (a chair tucked under a desk) won't separate by connectivity alone, so the manual split tool handles it.
- **Small clutter fragments** (v1's chess scan split into 376 fragments). v1 rule: clutter below a size threshold stays part of the room shell.

**Optional upgrades:**
- **SAM 2 on WebGPU** (Transformers.js), lifting 2D masks from rendered views onto faces, for touching objects.
- **CoACD** parts via Track B's Python tooling.
- **RoomPlan USDZ** uses its own wall/furniture labels directly (after P6).

**Done looks like:** a real room splits into floor, walls and at least 3 correct furniture objects with no manual work, and the chair splits into sensible parts. Any failures can be fixed in under a minute with the brush tool.

### P3 — Colour Each Object and Part
Add a `segmentId` vertex attribute and a palette uniform to `HolographicMaterial`. The fragment shader picks `palette[segmentId]`, with scanlines and fresnel on top. A `selectedId` uniform drives the selection glow. Include a colour picker per object/part, plus preset palettes. Existing single-colour behaviour stays the default when a mesh has no `segmentId`.

### P4 — Room Decor
- Move and rotate furniture with snapping.
- Hide or restore individual items, with **Hide All / Show All** (IKEA's pattern).
- Removal levels: *erase one*, *declutter* (small items), *defurnish* (everything but the shell). This is Matterport's pattern, done locally.
- Measure and fit-check using `measure.js`: "does this couch fit against that wall / through that door".
- **Layout saved as a list of edit commands** (SceneScript's idea), which gives undo, diffs, share-as-file and later language-driven editing.

Hiding furniture reveals holes in the floor and walls behind it. That's exactly where Track B's plane completion fills in, so hiding also needs P5.

### P5 — Show What Was Filled In
Load Track B output: `scanned` / `inferred` materials plus a sidecar. Inferred surfaces render in a distinct hologram style (ghosted/dashed, dimmer). A toggle switches between "as scanned" and "completed". The measurement panel shows **"N% inferred"** and warns when a dimension depends on inferred geometry.

### P6 — three.js Upgrade → RoomPlan USDZ + Gaussian Splats
Upgrade r161 → current (≥0.180), fix whatever `test.html` catches, then:
- the `USDLoader` fast path for RoomPlan USDZ (labelled walls, doors, windows, furniture boxes)
- **Spark** for Scaniverse SPZ splats (photoreal holograms; per-object recolour/move via `SplatEdit` regions, or by splitting splats by the nearest labelled mesh face)

### Later / Stretch
- 2D floor plan ↔ 3D sync (Polycam's pattern).
- Voice commands (v1's standing Phase 5 idea).
- Pepper's Ghost display rig (v1, gated on a cost check).
- Multi-scan "before/after" comparisons.

## Out of Scope

- A server or cloud processing of user scans.
- Paid APIs.
- Native apps / Apple RoomPlan *capture* (we accept its exports, we don't build an iOS app).
- AR headset passthrough.
- Multi-room / whole-building scans (for now).

## Open Questions — Ask, Don't Assume

- **Which room is the showcase room?** Smaller and less cluttered is easier for P2 (a bedroom or office with a few big pieces is ideal).
- **Does the Platform eventually *replace* `hologram.html`** at the main URL, or live beside it?
- **Timing of the P6 three.js upgrade.** Early would unlock RoomPlan USDZ for P2; late keeps risk low.
- **Showcase scans:** the accidental 2026-09-04 Area-mode room capture (`assets/plush/`, 21 MB, git-ignored, probably on the Windows desktop) is a free first room test file.

## Next Concrete Action

1. **Finish P0 with a real room:** load the accidental Area-mode room scan (or a fresh Area scan) at `platform/index.html`, check the dollhouse framing, and record triangle count and frame time on the M5 Air. If it's heavy, add meshoptimizer decimation.
2. **P1:** scene mode vs object mode, plus ray-select of whole connected components (a first "universal selection" before P2's real segmentation).

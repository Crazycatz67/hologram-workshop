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
- **Object mode:** a ray (hand pointer or mouse) **highlights before committing**, and a pinch or click selects. Then v1's gesture set applies to the selection: move, spin, tilt, scale. Floor/wall snapping, with a transform gizmo for mouse users.

Reuse `manipulator.js`, `gestures.js`, `stabilizer.js`, `smoothLandmarks.js` and `handTracker.js` **per selected segment** instead of per `o` group. The v1 practice mode and gesture-isolation lessons apply directly: room-level and object-level gestures must not bleed into each other.

**Done looks like:** on a real webcam, switch to object mode, grab one item in a room, move it and set it down, without the camera or other objects moving.

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

1. **P0:** `platform/index.html` with drag-drop upload (GLB/OBJ/PLY), floor/up-axis detection, and scale-aware framing, reusing the v1 modules by import.
2. Load the accidental Area-mode room scan (or a fresh Area scan) and record triangle count and frame time on the M5 Air.

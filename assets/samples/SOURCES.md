# Sample objects: sources and licences

Small, optimised GLBs for the gesture demo carousel (`models.js`) and the Platform's sample
library (`samples.js`). Built by `build_samples.py` in this folder (Y up, metres, floor at
y = 0, one named mesh per part, base-colour texture only, each ≤ ~1.5 MB). The big originals
are never committed: the reused five sit in the git-ignored `assets/benchmark/` (see its
`SOURCES.md`), the Poly Haven ones are fetched with `build_samples.py --fetch <scratch-dir>`.

**These are stock models, not scans.** They exist so there is more to play with (explode,
select, part-move, scan fill) than the one chair. The in-app credit string for each is the
`credit` field in `models.js` / `samples.js`; keep the three in step.

| File | Source (URL) | Author | Licence | Changes |
| --- | --- | --- | --- | --- |
| barrel-chair.glb | Amazon Berkeley Objects, `3dmodels/original/Y/B07DBGWFGY.glb` — https://amazon-berkeley-objects.s3.amazonaws.com/index.html | Amazon.com (ABO, Collins et al., CVPR 2022) | CC BY 4.0 | re-centred; split into 6 parts by connected pieces; texture 2048→1024 px JPEG |
| bar-stool.glb | ABO `3dmodels/original/N/B07B78M4DN.glb` (same index) | Amazon.com (ABO) | CC BY 4.0 | 10 parts; texture 1024 px |
| pedestal-table.glb | ABO `3dmodels/original/9/B07Y5VWF19.glb` (same index) | Amazon.com (ABO) | CC BY 4.0 | 13 parts; texture 4096→1024 px |
| teapot.glb | Google Scanned Objects, Threshold_Porcelain_Teapot_White — https://fuel.gazebosim.org/1.0/GoogleResearch/models/Threshold_Porcelain_Teapot_White | Google LLC (GSO, Downs et al., ICRA 2022) | CC BY 4.0 | rotated −90° about X (Z-up → Y-up); one part (a real scan, no separate meshes) |
| sofa.glb | Poly Haven, Sofa 01 — https://polyhaven.com/a/Sofa_01 | Kirill Sannikov | CC0 1.0 | 9 parts (frame, upholstery, seat cushion, 6 feet); diffuse map only |
| tool-chest.glb | Poly Haven, Metal Tool Chest — https://polyhaven.com/a/metal_tool_chest | John Hutcheson (model), Yann Kervran (rig) | CC0 1.0 | 7 parts from the source's own meshes; rig dropped |
| cabinet.glb | Poly Haven, Painted Wooden Cabinet — https://polyhaven.com/a/painted_wooden_cabinet | Kirill Sannikov | CC0 1.0 | 5 parts (body, 2 doors, 2 drawers) from the source's own meshes |
| vase.glb | Poly Haven, Ceramic Vase 01 — https://polyhaven.com/a/ceramic_vase_01 | James Ray Cock | CC0 1.0 | one part; hollow (open top), for the scan fill |
| lantern.glb | Poly Haven, Lantern 01 — https://polyhaven.com/a/Lantern_01 | Rajil Jose Macatangay | CC0 1.0 | 2 parts (body, glass); glass given a flat pale tint (its source map is brass + opacity) |
| desk-lamp.glb | Poly Haven, Desk Lamp Arm 01 — https://polyhaven.com/a/desk_lamp_arm_01 | Kuutti Siitonen (model), Yann Kervran (rig) | CC0 1.0 | 10 parts by connected pieces; rig dropped |

Licence checks (2026-10-01): ABO's licence is stated on its index page (CC BY 4.0); the GSO
teapot's `metadata.pbtxt` says "Creative Commons Attribution 4.0 International, Copyright 2020
Google LLC"; every Poly Haven asset is CC0 (https://polyhaven.com/license). CC BY needs the
credit shown wherever the model is shown: that is what the `credit` strings are for.

Part names follow `completion/bake_parts.py` ("noun · where", e.g. `leg · front left`).
Where a model is one mesh, the names come from shape + position; a few were checked by eye
or by the part's texture colour and overridden in `build_samples.py` (`names` / `rename`).

## Playful demos (Hands v2 Phase 5)

Built procedurally by `build_playful.py` in this folder (`.venv/bin/python
assets/samples/build_playful.py`, about 2 s, byte-identical on every run). Nothing is
downloaded: every shape is made from lathes, sweeps, boxes and convex hulls in that script, so
these four are **our own work, released as CC0 1.0**. Same contract as above, except colour is
stored as **vertex colours** (the hologram look reads a texture map or vertex colours, never a
flat material colour).

| File | Parts | Licence | Notes |
| --- | --- | --- | --- |
| fruit-bowl.glb | 10: bowl, apple · red, apple · inside, apple · green, orange, lemon, pear, peach, banana, grapes | CC0 1.0 (procedural, this project) | 0.29 × 0.21 × 0.31 m. `apple · inside` (flesh, core, seeds) sits just inside the red apple's skin, for slicing it open later; it explodes along with the apple. No fruit sits on the bowl's axis, so explode scatters every fruit out of the bowl |
| gears.glb | 5: frame (base, back plate, axle pins), gear · big/small/medium/top | CC0 1.0 (procedural, this project) | 0.41 × 0.33 × 0.11 m. 36/12/24/16 teeth, meshing with 0.6 mm backlash; even tooth counts, so each gear's bounding-box centre is its axle (a twist spins it in place) |
| layered-building.glb | 5: floor · ground/1st/2nd/3rd, roof | CC0 1.0 (procedural, this project) | 0.43 × 0.50 × 0.28 m (an architectural model, ~1:25). Floors step sideways so explode sends each one its own way (explode pushes every part the same 0.6 m from the centre, so a straight stack would move as two blocks) |
| lowpoly-fox.glb | 1: fox | CC0 1.0 (procedural, this project) | 0.94 × 0.56 × 0.20 m, 370 faceted triangles (unshared vertices, flat normals) for the polygon lens |

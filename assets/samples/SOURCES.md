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

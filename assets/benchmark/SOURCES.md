# Benchmark ground truths (downloaded, not committed)

Everything in this folder except this file is git-ignored. Fetched 2026-09-30 for the
Track B completion benchmark (`completion/benchmark.py --truth <name>/<name>.obj`).
Each `<name>.obj` is the source converted with trimesh: metres, Y-up, floor at y=0,
materials dropped. None of these is a phone scan; they are complete meshes used as truth.

| Folder | Source | Licence (put in the sidecar) |
| --- | --- | --- |
| abo_barrel_chair | ABO `3dmodels/original/Y/B07DBGWFGY.glb` (rounded barrel chair) | CC BY 4.0 — Amazon Berkeley Objects (Collins et al., CVPR 2022), © Amazon.com |
| abo_bar_stool | ABO `3dmodels/original/N/B07B78M4DN.glb` (wood bar stool) | CC BY 4.0 — Amazon Berkeley Objects |
| abo_pedestal_table | ABO `3dmodels/original/9/B07Y5VWF19.glb` (round pedestal table) | CC BY 4.0 — Amazon Berkeley Objects |
| ph_sofa_01 | Poly Haven Sofa_01 (glTF 1k + `.bin`) | CC0 1.0 — Poly Haven, Sofa_01 |
| gso_teapot | Google Scanned Objects, Threshold_Porcelain_Teapot_White (rotated −90° about X, Z-up → Y-up) | CC BY 4.0 — Google Scanned Objects (Downs et al., ICRA 2022), Google LLC |
| redwood_bedroom | Downloaded by the owner 2026-09-30 from http://redwood-data.org/indoor_lidar_rgbd/download.html (Bedroom row). `laser_bedroom.ply` = FARO laser scan, merged & resampled (zip `aligned_low_bedroom.zip`, 16.9M coloured points, no faces). `recon_bedroom.ply` = their Xtion depth-camera reconstruction (zip `ours_bedroom.zip`, 5.3M vertices, 10.2M faces). **The two are NOT in the same coordinate frame** (laser z ≈ −55…−51, recon z ≈ −4…3; median gap 50 m): register (FPFH+RANSAC → ICP) before scoring. Zips kept because the Drive link is quota-limited. | Public domain (attribution requested) — Park, Zhou, Koltun, ICCV 2017 |

ABO base URL: https://amazon-berkeley-objects.s3.amazonaws.com/ (licence confirmed CC BY 4.0 on its index page, 2026-09-30).

Caveats: all five meshes are non-watertight, and the four CAD models have hidden faces
between parts that no scanner could see. Filter by visibility before hiding regions.
Face counts (4k–38k) are lower than the chair's 76k.

# Track B — Scan Completion — Roadmap

**Goal:** submit one basic scan of anything (a room, a piece of furniture) and have the blanks and flaws filled in: undersides, backs against walls, holes, noise. Then hand the result to the Platform (Track A) as a hologram. **It must run free on a MacBook Air M5 (16 GB)** or a basic computer, with no paid subscription or API.

**Fill policy (owner decision, 2026-09-29): keep every real scanned surface, fill only the gaps, and mark the filled parts.** Measured geometry always wins. Inferred geometry is always visible as inferred, both in the hologram and in the measurements.

The research behind every choice here is in [`RESEARCH.md`](RESEARCH.md).

## Revision History

- **2026-09-29:** Track created as a main focus, alongside the Platform. Design based on a three-part research pass (completion algorithms, segmentation, prior art). Key finding: on a 16 GB Mac, **classical geometry + primitive fitting does most of the real work**. Generative completion of hidden sides is borderline on the Mac today (SPAR3D, Hunyuan3D-2mini forks), and the strongest scan-conditioned models still need CUDA or 24 GB+.

## Constraints (this track)

- **Free only.** No paid APIs, subscriptions or credit-metered services. Every model and dataset used has its **licence recorded** in the output sidecar (e.g. Hunyuan excludes the EU/UK/South Korea, ABO is non-commercial, PyMeshLab is GPL).
- **Mac first.** Scripts take `--device mps|cpu|cuda`. The M5 Air is the target: it's fanless, so run one object at a time and write down real timings. The RTX 2070 (8 GB) desktop is an allowed fallback for the same scripts. Free cloud (Colab / HF Spaces) is the last resort, only for experiments.
- **Offline Python tooling**, the same pattern as `clean_scan.py`: it produces assets, and the browser only displays them. The Platform site stays no-build. Code lives in `completion/`. Reuse `clean_scan.py` functions by import, don't fork them.
- **Honest evaluation.** No method is adopted on screenshots alone (see B0).

## Output Contract (what Track A consumes)

- One GLB/OBJ per scan. Every object keeps its scanned surfaces and adds inferred surfaces as a **separate material (`scanned` / `inferred`)** inside the same object/segment, so it stays one selectable, movable thing. If a method produces a per-vertex confidence value instead of a hard split, carry it as a vertex attribute.
- A JSON sidecar per object: the method/tier used, the source (model ID or URL), the licence, the fit score, and the % of surface inferred.

## The Cascade (most faithful → most generated)

Each object tries tiers in order and keeps the best-fitting result above a threshold:

| Tier | Method | Runs on |
| --- | --- | --- |
| 0 | **Scan as-is**, cleaned (`clean_scan.py`) | CPU |
| 1 | **Primitive / plane completion:** extend walls, floor, tabletops and cabinet sides to their intersections; close furniture backs and undersides with fitted planes and boxes (pyRANSAC-3D / Open3D) | CPU |
| 2 | **Symmetry mirror** (existing, `clean_scan.py:256-319`) | CPU |
| 3 | **Surface repair:** capped close-holes → screened Poisson / RIMLS with density trim → Taubin smoothing (existing FILL/SMOOTH stages) | CPU |
| 4 | **Retrieve and align:** CLIP on a photo/renders → ABO (real product dimensions) / Objaverse (CC-BY filter) → scale from the oriented box → Open3D FPFH+RANSAC → ICP | MPS/CPU |
| 5 | **Generate:** SPAR3D (can be conditioned on the scan's own points) / Hunyuan3D-2mini shape → same scale + registration as tier 4 | MPS (experimental) → 2070 fallback |

**Merge rule for every tier:** keep all real scan geometry, and add candidate geometry **only where the scan has no surface within ~1–2 cm**. Everything added is tagged `inferred`.

## Phases

### B0 — Honest Benchmark (do first)
Take the best-covered real scan (the chair) and **delete its underside/back on purpose**, keeping the removed part as ground truth. Score every tier by **Chamfer distance on the held-out region**, plus runtime and peak memory on the M5. This turns "which method is best" into numbers, and it makes a strong portfolio chart. Add a room case once a room scan exists.

**Done looks like:** `completion/benchmark.py` prints one table (method × error × time × memory), and the first row (tier 0/3, today's pipeline) is recorded here as the baseline.

### B1 — Classical v1 (any computer)
Tiers 1–3 plus the merge rule and the output contract. New code: plane/box completion, the "keep only what's missing" distance filter, the scanned/inferred material split, and the sidecar. Port `measure.js`'s `minimalFootprint` (:100) to Python for oriented boxes.

**Done looks like:** beats the B0 baseline on held-out error, runs in minutes on the M5, and the chair renders in the Platform with its underside marked as inferred.

### B2 — Retrieve and Align
Tier 4. Keep a small local index of CLIP embeddings over a licence-filtered furniture subset (ABO first, since it has real dimensions). Registration uses Open3D 0.20 (arm64 wheels, Python 3.10–3.14). Encourage a **phone photo per object at scan time**, because a photo is a far better query than a render of a holey scan.

### B3 — Generative Spike (Mac first)
Tier 5. Install SPAR3D (MPS / low-VRAM mode) and a Hunyuan3D-2mini Mac fork on the M5, run the chair through each, and write down time, peak memory and B0 error. Try SPAR3D's point-cloud conditioning with the scan's own points. If the M5 can't cope, run the same scripts on the 2070. **Record the honest outcome either way.**

### B4 — Multi-Scan Fusion
If the user scans again after moving furniture, fuse the scans: the moved object reveals **real** hidden geometry (the RecurGS idea), which beats any guess.

### B5 — Rooms
Run the cascade per object after the Platform's segmentation (P2) has split a room. Use RoomPlan USDZ layout (walls + furniture boxes) as a prior when the user provides one.

## Watch List (not usable on a 16 GB Mac today; re-check periodically)

- Hunyuan3D-Omni (point-cloud / box conditioning, CUDA hard-coded)
- LaS-Comp (training-free, TRELLIS-based)
- TRELLIS.2 (Mac port wants 24 GB+; can texture filled regions)
- SAM 3D Objects (MLX port wants 48 GB)
- Amodal3R
- CAOA (completion + CAD alignment, Jun 2026)
- GSComplete (no code yet)
- SpatialLM (would give room layout + furniture boxes, CUDA)

## Out of Scope

- Paid services (Meshy, Tripo, commercial search APIs, Matterport).
- Filling clutter-sized objects in v1.
- Pretending inferred geometry is measured: measurements always report the inferred %.

## Next Concrete Action

1. **B0:** write `completion/benchmark.py` against `assets/chair/chair_clean.obj`, which needs a held-out underside cut, and record today's pipeline as the baseline.
2. **B3 spike** (can run in parallel since it's just installs + one run): SPAR3D + Hunyuan3D-2mini on the M5, recording time and peak memory.

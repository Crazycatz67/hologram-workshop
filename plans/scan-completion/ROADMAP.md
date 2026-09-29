# Track B — Scan Completion — Roadmap

**Goal:** submit one basic scan of anything (a room, a piece of furniture) and have the blanks and flaws filled in: undersides, backs against walls, holes, noise. Then hand the result to the Platform (Track A) as a hologram. **It must run free on a MacBook Air M5 (16 GB)** or a basic computer, with no paid subscription or API.

**Fill policy (owner decision, 2026-09-29): keep every real scanned surface, fill only the gaps, and mark the filled parts.** Measured geometry always wins. Inferred geometry is always visible as inferred, both in the hologram and in the measurements.

The research behind every choice here is in [`RESEARCH.md`](RESEARCH.md).

## Revision History

- **2026-09-29 (3):** **B1 first method: `thickness_fill` closes the underside gap** (`completion/fill.py`, which now holds all methods; the benchmark imports it).
  - **The idea:** panels are slabs. For each upward face with nothing scanned below it (probed straight down to 8 cm), take the drop to the nearest open scan boundary in plan view as the local thickness, and copy the face down by that amount. Then apply the merge rule. It uses measured geometry moved by a measured distance, with no model involved.
  - **Result:** the chain `mirror_gaps → thickness_fill → poisson` takes the **underside from 75% → 99% coverage @2 cm, with 99% of added surface real (up from 63%)**. Wall and holes rows are unchanged (89% / 100%). Runtime is 4.5 s and peak memory 0.37 GB on the M5 Air.
  - **Robustness check:** the benchmark hides faces with n.y < −0.35, the mirror of the method's own "upward" test, which could flatter it. Re-run with other cuts:

    | Cut | Plain Poisson (coverage / real) | New chain (coverage / real) |
    | --- | --- | --- |
    | n.y < −0.10 (47% hidden) | 64% / 42% | 82% / 70% |
    | n.y < −0.60 | 72% / 62% | 100% / 100% |
    | Ragged ±0.25 per face | 79% / 63% | 100% / 99% |

    It holds up. Its weak spot is when very large regions are hidden.
  - **Caveats:** one object (a sled chair with slab parts). The ground truth is itself a cleaned mesh. It needs a room case and a non-slab object (e.g. a round stool or a sofa) before calling B1 done.
- **2026-09-29 (2):** **B0 benchmark built and baselined** (`completion/benchmark.py`, run with `.venv/bin/python completion/benchmark.py`).
  - **Setup:** hides the chair's underside, the side against a wall (4 walls, averaged) and 10 random 5 cm holes, then scores each method.
  - **Scores:** *coverage* is the share of hidden surface recovered within 1/2 cm. *Added real* is the share of invented surface that lies within 2 cm of real geometry, which catches methods that "fill" by wrapping the object in a blob.
  - **Isolation:** every method runs in its own process, so time and peak memory are per-method, and native crashes become FAILED rows.
  - **Found and fixed a v1 bug on the way:** multi-threaded Poisson randomly aborted *with exit status 0* (BUGS.md #8). It's now single-threaded everywhere.
  - **New method:** `mirror_gaps` (mirror across the symmetry plane, but keep only mirrored faces that land where the scan has nothing). It never invents surface that isn't real, and it replaces the old full-copy mirror that crashed Poisson on coincident surfaces.

**Baseline** (2026-09-29, chair, M5 Air, all methods under 6 s and 0.5 GB; the ground-truth caveat in the script applies):

| Scenario | Best current method | Coverage @2 cm | Added surface that's real | Verdict |
| --- | --- | --- | --- | --- |
| Random holes | mirror_gaps + Poisson | 100% (1 mm mean) | 100% | **Solved** |
| Against a wall | mirror_gaps + Poisson | 88% | 79% | Good. close_holes covers 95% but only 44% of what it adds is real |
| **Underside** | any Poisson variant | **75%** (baseline without filling: 64%) | **~63%** | **The open problem.** Mirroring can't help (the symmetry plane is vertical), so this is where plane/thickness priors (B1) and retrieval/generation (B2/B3) must earn their place |
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

**Install findings (2026-09-29 research, nothing installed yet; verify each step when running it):**
- **Order:** TripoSR first (MIT, weights not gated, safest environment check), then SPAR3D, then a Hunyuan fork. Use a **separate Python 3.11/3.12 environment per model** (`uv venv --python 3.12`). Their pinned dependencies (e.g. SPAR3D pins numpy 1.26.4 and transformers 4.42.3) would break the benchmark's 3.13 `.venv`.
- **SPAR3D** ([repo](https://github.com/Stability-AI/stable-point-aware-3d)):
  - **Mac:** needs macOS 15.2+ and `PYTORCH_ENABLE_MPS_FALLBACK=1`. `--low-vram-mode` brings it to ~7 GB on CUDA; MPS memory is unconfirmed. The README says MPS "consumes more memory" and recommends CPU below 32 GB.
  - **Builds and access:** it compiles two local extensions (`texture_baker`, `uv_unwrapper`; needs `brew install libomp cmake`), and there's an open Mac build issue (#20). **Weights are gated**: it's free, but you need a Hugging Face account, to accept the licence, and a login token.
  - **Point-cloud conditioning only exists in `gradio_app.py`, not `run.py`.** It takes a `.ply` **with vertex RGB**, forced to exactly **512 points**, passed as `batch["pc_cond"]` (`[1, 512, 6]`: xyz + rgb in 0–1). The coordinate frame is undocumented. Plan: export the cloud the demo generates for a chair photo, study its frame and scale, then map our scan's points into it. To script it, copy `run_model()` from `gradio_app.py`.
- **Hunyuan3D-2.1 Mac fork** ([VladimirTalyzin/hunyuan3d-2.1-mac-rocm](https://github.com/VladimirTalyzin/hunyuan3d-2.1-mac-rocm)): `./install.sh --shape-only`, Python 3.10–3.12, 5.7 min shape generation on an M4 Pro 24 GB, up to ~26 GB of weights for the full install. One secondary source claims 24 GB of RAM is needed for shape generation, so it's risky on 16 GB. **Licence excludes the EU, UK and South Korea.**
- **SF3D:** it works on a Mac, but it takes no point-cloud input, so it's only useful as a second baseline.

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

1. **B1 next:** validate `mirror → thickness → poisson` on a second, non-slab object and on a room once one is scanned; then add *plane extension* for wall-side gaps (the wall row is still 89% / 79% real). *(Done: thickness prior for undersides, see revision 3.)* Original target: a *thickness prior* (panels like a seat are slabs: where the top is scanned and the bottom isn't, offset the top by the thickness measured at the panel's scanned edges) and *plane extension* (extend fitted planes to their intersections). Beat 75% coverage / 63% real on the underside row without losing the other rows.
2. **B3 spike** (can run in parallel since it's just installs + one run): SPAR3D + Hunyuan3D-2mini on the M5, recording time and peak memory.

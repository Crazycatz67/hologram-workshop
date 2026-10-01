# Track B — Scan Completion — Roadmap

**Goal:** submit one basic scan of anything (a room, a piece of furniture) and have the blanks and flaws filled in: undersides, backs against walls, holes, noise. Then hand the result to the Platform (Track A) as a hologram. **It must run free on a MacBook Air M5 (16 GB)** or a basic computer, with no paid subscription or API.

**Fill policy (owner decision, 2026-09-29): keep every real scanned surface, fill only the gaps, and mark the filled parts.** Measured geometry always wins. Inferred geometry is always visible as inferred, both in the hologram and in the measurements.

The research behind every choice here is in [`RESEARCH.md`](RESEARCH.md).

## Revision History

- **2026-09-30 (5):** **B1 tested beyond the chair, and a room path added.** Team round: Debbie stress-tested the object chain, Cody built the room case, Ricky found free ground truths; all numbers re-checked by the overseer.
  - **Non-slab objects** (`completion/truths.py`, synthetic, noise-free, so upper bounds). Cells are coverage @2 cm / added surface that's real, for `complete`:

    | Object | Underside | Wall | Holes |
    | --- | --- | --- | --- |
    | Chair (regression, unchanged) | 98% / 96% | 99% / 96% | 100% / 100% |
    | Stool (thin round parts) | 100% / 100% | 100% / 100% | 93% / 100% |
    | Vase (5 mm shell) | 100% / 24% | 100% / 15% | 73% / 100% |
    | Lamp (open shade on spokes) | 94% / 79% | 100% / 14% | 86% / 83% |
    | Sofa (2.1 m, 30 cm base) | 24% / 13% | 74% / 35% | 96% / 12% |

    **Verdict:** holds on thin round parts; fails on thin shells (Poisson balloons them, BUGS #24) and on big thick furniture (thicker than the 8 cm probe, and the symmetry search misses planes on objects over ~1 m, #22). Sanity: 0.0% inferred on every complete truth.
  - **Metric blind spot:** coverage@2cm can't see thin parts ("none" scores 100% on vase walls). A normal-aware coverage gives 36% there. Not yet in the benchmark.
  - **Bug fixed:** #21, a fixed 250k sample count made every absolute threshold wrong on large objects (`fill.sample_count()`; chair unchanged). Logged open: #22, #23 (slab_fill measures thickness to another part's edge; a tested variant trades chair 98→96% for sofa 24→39%), #24, #25.
  - **Rooms: tier 1 `plane_extend` (`completion/planes.py`) and a synthetic room benchmark (`completion/room_bench.py`).** 4.2 × 3.6 m room with sofa, table, cabinet and doorway; what the scanner misses comes from exact sight lines from 8 phone positions. Coverage @2 cm / added real:

    | Scenario | poisson | complete (object chain) | **plane_extend** |
    | --- | --- | --- | --- |
    | Occlusion (13% hidden) | 7% / 41% | 13% / 19% | **54% / 100%** |
    | Sofa hidden (A-P4), sofa passed as `occluders` | 43% / 41% | 51% / 21% | **100% / 100%** |
    | Holes | 86% / 53% | 84% / 18% | **100% / 100%** |

    Occlusion stops at 54% because the rest (sofa back, cabinet top, table underside) is surface no plane can produce. Doorways are left open. ~1.8 s and 0.5 GB. The synthetic room is perfectly planar, so these are upper bounds. F@5cm (the Atlas / SG-NN tolerance) is reported too.
  - **`complete.py` now picks a pipeline:** `--mode auto` (default) runs `plane_extend` when it finds ≥3 shell planes and the object chain otherwise, because the object chain invents walls on rooms (#25). The sidecar records the mode.
  - **Free ground truths fetched** (`assets/benchmark/`, git-ignored; sources and licences in `assets/benchmark/SOURCES.md`): 3 ABO models, a Poly Haven sofa, a Google Scanned Objects teapot, and the Redwood Bedroom laser scan + depth-camera reconstruction (public domain). **ABO is CC BY 4.0, not non-commercial** (checked on its index page 2026-09-30). The Redwood pair is not in a shared frame (~50 m apart) and needs registration first.
- **2026-09-29 (4):** **`slab_fill` generalises the thickness prior to every direction and closes the wall gap too.**
  - **The idea:** a backrest against a wall is the same problem as a seat underside, turned on its side. Faces are grouped by the nearest of 26 sphere directions, and each group probes, measures thickness and copies along its own direction.
  - **Chain `mirror_gaps → slab_fill → poisson` (coverage @2 cm / added surface that's real):**

    | Scenario | Before (best chain) | New chain |
    | --- | --- | --- |
    | Underside | 99% / 99% (thickness chain) | 98% / 97% (within noise) |
    | **Wall** | 89% / 79% | **99% / 97%** |
    | Holes | 100% / 100% | 100% / 100% |

  - **Stress cuts:** underside with 47% of the chair hidden goes 64% / 42% (Poisson) → **95% / 91%**. Ragged underside cut: 99% / 97%. Wall ragged or with a 60%-deep band: 100% / 100%.
  - **Cost:** ~5 s and ~0.39 GB on the M5 Air.
  - **Shipped as `completion/complete.py`**, which writes the output contract: one `o <name>` with `usemtl scanned` / `usemtl inferred` groups, plus a JSON sidecar.
    - **Default output:** the scan's faces exactly as measured, plus Poisson surface *only* in the gaps. This scores the same as the full chain (underside 98% / 96% real, wall 99% / 96%, holes 100% / 100%) while adding less surface.
    - **`--watertight`:** the single sealed Poisson surface, labelled by distance.
    - **Sanity check:** on the complete chair it infers **0.0%**. Nothing missing, nothing invented.
  - **This is now the recommended B1 pipeline.** The next honest test is a *different* object and a room, since everything so far is one chair.
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

- **Free only.** No paid APIs, subscriptions or credit-metered services. Every model and dataset used has its **licence recorded** in the output sidecar (e.g. Hunyuan excludes the EU/UK/South Korea, ABO is CC BY 4.0 (attribution), PyMeshLab is GPL).
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

**B3 step 1 done (2026-09-29): TripoSR runs on the M5 Air.**
- **Result:** image → mesh (84k faces, vertex colours) in **~13–14 s warm** on either CPU or MPS. Peak memory is **~4.4 GB**, which fits 16 GB comfortably.
- **Why MPS gives no speedup:** mesh extraction (`torchmcubes`, the biggest stage at ~5.8 s) runs on the CPU either way. Model inference is only 3.3 s.
- **Setup:**
  - Isolated install in `.models/triposr/` (git-ignored, 1.4 GB). Weights are cached in `~/.cache/huggingface` (1.6 GB).
  - Python 3.11 via `uv`; `brew install uv cmake`.
  - Build fixes: unpinned `xatlas` (0.0.11), `torchmcubes` built with `--no-build-isolation` plus scikit-build-core/pybind11/ninja, and `onnxruntime` added for rembg.
  - The copy-paste recipe is in `.models/triposr/NOTES.md`.
- **Gotchas:**
  - The first run downloads rembg's `u2net.onnx` (176 MB) from GitHub (slow), or pass `--no-remove-bg`.
  - Higher marching-cubes resolution and `--bake-texture` are untested.
- **Next:**
  - Run TripoSR on a *photo of our own chair*.
  - Scale and register the output to the scan (Open3D FPFH+ICP).
  - Add it as a benchmark method, where it has to beat `complete` (98–100%) to earn a place.

  **Honest expectation:** for slab furniture the geometric pipeline is already near the ceiling. Generation matters for objects with no slab or symmetry structure, and for regions *nothing* in the scan hints at.

**Install findings (2026-09-29 research; SPAR3D and Hunyuan still unverified):**
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

1. **Real data before more tuning** (everything so far is one real chair plus synthetic truths):
   - **Redwood Bedroom:** register the depth-camera reconstruction onto the laser scan (FPFH+RANSAC → ICP), then score `plane_extend` against laser points in the hidden region (`room_bench.evaluate()` already takes point truths).
   - **Benchmark objects** in `assets/benchmark/`: run them through `benchmark.py --truth`, after a visibility filter (the CAD models have faces between parts that no scanner could see).
   - **The owner's flip-scan chair** (scan it upside down in Scaniverse and register it to the upright scan) would be the most honest underside truth of all.
2. **Close the object-chain failures:** density trim for Poisson (#24, thin shells), the `slab_fill` shell-plane skip (#25), and a better fix for #23 (the owner declined the tested variant on 2026-09-30 because it costs the chair 2%; look for one without the trade-off, ideally checked on real scans). Add normal-aware coverage to the benchmark. *(#22 finer symmetry search: done 2026-09-30, `e8c50f4`; the sofa now finds its plane but still scores low, so #23/#24 are the bottleneck.)*
3. **B1 "done" is still the Platform showing it:** P5 renders `usemtl inferred` distinctly (Track A).
4. **B3 spike** (independent): TripoSR is done; SPAR3D and Hunyuan3D-2mini on the M5, recording time and peak memory.

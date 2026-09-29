# Research: Filling the Blanks, Universal Segmentation, and Prior Art

**Compiled 2026-09-29** from three web-research passes (completion algorithms; segmentation and in-browser delivery; commercial and academic prior art). The question behind it: *how do we take one basic LiDAR scan of a room or object, fill in what the scanner missed, split it into objects without hand-made parts, and do it all for free on a MacBook Air M5 (16 GB)?* The fallback is an RTX 2070 (8 GB) desktop, which isn't the preferred machine.

> **Verify before relying.** Some hardware figures come from secondary sites, not official READMEs: SAM 3D at ~32 GB, Step1X-3D at ~27 GB, the Hunyuan-mini VRAM numbers, and Mac-port timings measured on M4 Pro machines with 24 GB+ of memory. Pricing figures come from third-party aggregators and conflict in places. Re-check any number before building a decision on it, and record the real M5 number in the roadmap once measured.

---

## 1. Filling Missing Geometry: Every Approach Family

### 1.1 Classical geometry repair. Runs on any Mac, on the CPU.
| Tool | What it's good for | Notes |
| --- | --- | --- |
| PyMeshLab 2025.07 `meshing_close_holes` (Liepa-style) | Small and medium holes | macOS arm64 wheels, GPL. Already a project dependency |
| Screened Poisson (PyMeshLab) | Making the whole surface watertight | Already used in `clean_scan.py`. Trim low-density surface against the original, or it balloons |
| APSS / RIMLS (PyMeshLab) | Re-surfacing *noisy* regions | Not for large gaps |
| Ball pivoting | Keeps sharp edges | Leaves holes, so it's not a completion tool |
| PyMeshFix (MeshFix) | Repairs a single closed solid | GPLv3. Suits one furniture piece, not a room |
| `manifold3d` (pip) / ManifoldPlus | Watertight re-meshing, booleans | ManifoldPlus needs compiling. Avoid `trimesh.repair.fill_holes` (fan fill, fails on non-convex holes) |
| **Primitive fitting**: pyRANSAC-3D (planes/cuboids/cylinders), CGAL Efficient RANSAC, Open3D `segment_plane` | **The biggest single win for rooms and furniture** | Walls, floors, ceilings, tabletops, cabinet sides and furniture backs are mostly planes. Extending fitted planes to their intersections fills big gaps better than any learned model |
| Symmetry mirror (ours, `clean_scan.py:256-319`) | Filling one side from the other | Already built. Measured on the chair: 88.3% overlap at 164° |

**Verdict:** primitives for large planar gaps → capped close-holes for small ones → screened Poisson (RIMLS for noisy pieces) → Taubin smoothing.

Sources: [PyMeshLab](https://github.com/cnr-isti-vclab/PyMeshLab), [pymeshfix](https://pymeshfix.pyvista.org/), [trimesh](https://pypi.org/project/trimesh/), [pyRANSAC-3D](https://github.com/leomariga/pyRANSAC-3D), [CGAL shape detection](https://doc.cgal.org/latest/Shape_detection/index.html)

### 1.2 Learned point-cloud / shape completion. Research-grade, CUDA.
- **PoinTr / AdaPoinTr** ([code](https://github.com/yuxumin/PoinTr)), **SeedFormer** ([code](https://github.com/hrzhou2/seedformer)) and SnowflakeNet all have public weights but depend on custom CUDA ops (Chamfer, pointnet2). They're trained on synthetic ShapeNet partial scans in a normalised pose and scale. They transfer poorly to real noisy scans, and [ScaleBlind (2026)](https://arxiv.org/html/2609.23404) shows they implicitly assume a known scale.
- **Diffusion-based:** [DiffComplete](https://github.com/JIA-Lab-research/DiffComplete), SDFusion, PVD and LION are all per-category ShapeNet models, and all need CUDA.
- **Zero-shot / category-agnostic:** [ComPC](https://github.com/Tianxinhuang/ComPC) (ICLR'25, CUDA 11.6) and [LaS-Comp](https://github.com/DavidYan2001/LaS-Comp) (CVPR 2026, training-free on TRELLIS, MIT, strict CUDA 12.1 + spconv + flash-attn + nvdiffrast).
- **Verdict:** not viable for v1 on a Mac. Watch list.

### 1.3 Scene-level completion
- **NKSR** ([code](https://github.com/nv-tlabs/NKSR)): CUDA, RTX 3090-class memory, NVIDIA non-commercial licence. No Mac path.
- **SG-NN / SPSG** (CVPR 2020/21): dated sparse-conv CUDA code. [Seen2Scene](https://arxiv.org/abs/2603.28548) (Mar 2026): no code.
- **SpatialLM 1.1** ([code](https://github.com/manycore-research/SpatialLM)): point cloud → walls/doors/windows + oriented furniture boxes in 59 categories, which would be ideal. But it needs CUDA 12.4, TorchSparse and flash-attn, and its Sonata encoder weights are CC-BY-NC.
- **Apple RoomPlan** ([Apple ML](https://machinelearning.apple.com/research/roomplan), [WWDC22](https://developer.apple.com/videos/play/wwdc2022/10127/)) is the practical option. It's a free iOS API producing parametric walls/doors/windows + furniture cuboids as USDZ. Use it as a *layout prior* when a user uploads one.

### 1.4 Retrieve a real model and align it (Scan2CAD-style replacement)
- **Research code:** [Scan2CAD](https://arxiv.org/abs/1811.11187), [ROCA](https://github.com/cangumeli/ROCA), [DiffCAD](https://github.com/DaoyiG/DiffCAD), [FastCAD](https://arxiv.org/pdf/2403.15161) and [HOC-Search](https://arxiv.org/pdf/2309.06107) are all CUDA and trained on ScanNet/ShapeNet. It's better to build a small version of our own. **Newest:** [CAOA (Jun 2026)](https://arxiv.org/abs/2606.18429), which completes the point cloud first, then aligns a CAD model with symmetry priors; it reports +17% on Scan2CAD and its code is released.
- **Free model libraries:**
  - **[ABO, Amazon Berkeley Objects](https://amazon-berkeley-objects.s3.amazonaws.com/index.html):** 7,953 real product GLBs *with real dimensions*. CC BY-NC 4.0, which is fine for a non-commercial student project.
  - **[Objaverse](https://huggingface.co/datasets/allenai/objaverse):** licence per object, with ~721K CC-BY. Filter the metadata by licence and category.
  - **3D-FUTURE:** custom Alibaba agreement ([terms](https://terms.aliyun.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud202004171628_60052.html)).
- **Retrieval:** CLIP (open_clip) on a photo or rendered views runs on MPS. [OpenShape](https://colin97.github.io/OpenShape/) does point-cloud → shape nearest-neighbour search.
- **Verdict:** a strong middle path. The result is complete and clean but only *approximately* the user's object, so keep it only where the scan has nothing.

### 1.5 Image-to-3D and generation conditioned on a partial scan
| Model | Licence | Hardware | Mac? |
| --- | --- | --- | --- |
| **[SPAR3D](https://github.com/Stability-AI/stable-point-aware-3d)** | Stability Community (free under $1M revenue) | 10.5 GB VRAM, ~7 GB low-VRAM mode | Experimental MPS (macOS 15.2+, 32 GB recommended), CPU fallback |
| SF3D / TripoSR | Stability Community / MIT | Light | MPS works, lower quality |
| **[Hunyuan3D-2mini (Turbo)](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)** | Tencent community (**excludes EU/UK/South Korea**) | ~5 GB for shape | Community forks, shape only |
| Hunyuan3D-2.1 | same | ~6 GB shape, ~12 GB shape+texture | [Mac fork](https://github.com/VladimirTalyzin/hunyuan3d-2.1-mac-rocm): ~5.7 min shape on an M4 Pro 24 GB |
| **[Hunyuan3D-Omni](https://github.com/Tencent-Hunyuan/Hunyuan3D-Omni)** | same | ~10 GB | CUDA hard-coded |
| [TRELLIS.2](https://github.com/microsoft/TRELLIS.2) (4B) | MIT (some dependencies non-commercial) | ≥24 GB NVIDIA | [trellis-mac](https://github.com/shivampkumar/trellis-mac): ~18 GB peak, ~5 min on an M4 Pro; [MLX port](https://github.com/lyonsno/trellis2mlx). Risky on 16 GB |
| TripoSG | MIT | >8 GB CUDA | No port |
| Step1X-3D | Open | ~27 GB | No |
| [SAM 3D Objects](https://github.com/facebookresearch/sam-3d-objects) | SAM Licence | ~32 GB NVIDIA (reported) | [MLX port](https://github.com/ZimengXiong/Sam3D-Objects-MLX): geometry only, targets 48 GB |
| [Amodal3R](https://sm0kywu.github.io/Amodal3R/) (ICCV'25) | Research | CUDA (TRELLIS-based) | No |

What matters for us:
- **SPAR3D accepts an uploaded point cloud as conditioning.** We can feed it the scan's own partial points plus a photo and let it fill the back. Catch: the points must be in SPAR3D's camera-normalised frame, and there's no documented API for that, so it needs experiments.
- **Hunyuan3D-Omni** (point-cloud / voxel / bounding-box conditioning) is the most on-target model, but it's CUDA-only.
- **TRELLIS.2 can texture an existing mesh** (`example_texturing.py`). That's useful for texturing filled regions, but only on a borrowed 24 GB+ CUDA GPU.
- **Honest caveat:** generated output is *plausible, not your object*. It must be scaled and registered to the scan, and we keep only the regions the scan is missing.

### 1.6 Gaussian-splat / NeRF inpainting
- SPIn-NeRF, GScream, InFusion and [Inpaint360GS](https://arxiv.org/abs/2511.06457) (see also [G4Splat](https://arxiv.org/html/2510.12099), [RePaintGS](https://arxiv.org/pdf/2507.08434)) remove an object and fill what was behind it. They need CUDA and per-scene optimisation.
- [GSComplete (Sep 2026)](https://arxiv.org/abs/2609.08449): no code yet.
- **Low relevance.** Complete the *mesh*, then re-texture or leave the fill untextured.

### 1.7 Registration (aligning a retrieved or generated model to the scan)
- **[Open3D 0.20.0](https://pypi.org/project/open3d/)** (2026-09-16): macOS arm64 wheels for Python 3.10–3.14. Use FPFH + RANSAC for global alignment, then point-to-plane or coloured ICP. CPU on a Mac, fast enough.
- **[KISS-Matcher](https://pypi.org/project/kiss-matcher/):** pip-installable, faster than FPFH, better outlier rejection.
- **TEASER++:** must be built from source on arm64 ([docs](https://teaser.readthedocs.io/en/latest/installation.html)).
- **Tip:** fix scale from the oriented bounding box first (RoomPlan's box, or our own footprint fit from `measure.js`), because generated meshes come out at an arbitrary scale.

---

## 2. Universal Segmentation: Splitting Any Scan Without Hand-Made Parts

### 2.1 Capture apps (free tiers, 2026)
| App | Free exports | Free per-object labels? |
| --- | --- | --- |
| **Scaniverse** | Mesh (OBJ/FBX/GLB/USDZ/STL/PLY/LAS) + splats (PLY/**SPZ**). On-device stays free | No |
| **3d Scanner App** | USDZ/OBJ/GLTF/GLB/DAE/STL, point clouds, DXF. **Has a RoomPlan mode** | Yes, via RoomPlan. *Confirm in the app which exports are free* |
| KIRI Engine | OBJ/STL/FBX/GLTF/USDZ | No |
| SiteScape | Unlimited exports (point-cloud focus) | No |
| Polycam | **GLTF only** on free | No |

**RoomPlan USDZ** hierarchy: `Parametric_grp/Arch_grp/{Wall0…}` and `Object_grp/{Chair_grp, Table_grp…}`. Three's built-in [`USDLoader`](https://threejs.org/docs/pages/USDLoader.html) reads USDA/USDC/USDZ, so nodes can be found by name and turned into furniture boxes and walls immediately. Test against real RoomPlan files; [three-usdz-loader](https://github.com/ponahoum/three-usdz-loader) / TinyUSDZ-WASM are fallbacks.

Sources: [Scaniverse](https://apps.apple.com/us/app/scaniverse-3d-scanner/id1541433223), [Polycam exports](https://learn.poly.cam/hc/en-us/articles/27756102599572-What-File-Types-Can-Polycam-Export), [3d Scanner App](https://apps.apple.com/us/app/3d-scanner-app/id1419913995), [Laan on RoomPlan](https://labs.laan.com/blogs/semantic-geometry-apple-roomplan), [KIRI pricing](https://www.kiriengine.app/pricing)

### 2.2 Room → objects
- **Classic (free; runs on a Mac, portable to JS):** RANSAC plane peel (floor/walls/ceiling), then connected components / DBSCAN on the remainder, gives furniture blobs. This is exactly the Open3D pipeline (`segment_plane`, `cluster_dbscan`) and is simple enough to write in JS inside a Web Worker (there's no maintained Open3D WASM build). **It fails when objects touch** (a chair pushed into a table), so users need a quick manual split/merge tool.
- **Learned: almost all CUDA.** [SpatialLM](https://github.com/manycore-research/SpatialLM), [Sonata/PTv3](https://github.com/facebookresearch/sonata) (weights CC-BY-NC), [OpenMask3D](https://openmask3d.github.io/), [Open3DIS](https://github.com/VinAIResearch/Open3DIS), [SAI3D](https://arxiv.org/pdf/2312.11557) and [SNAP](https://arxiv.org/pdf/2510.11565). Mask3D / OneFormer3D need MinkowskiEngine/spconv. Not Mac-friendly.
- **2D → 3D lifting (feasible on a Mac):** render ~20–60 views with a per-face ID buffer, run **SAM / SAM 2** on each, and vote the masks back onto faces (the [SAMesh](https://github.com/gtangg12/samesh) / SAI3D idea).
  - SAM 2 runs on PyTorch MPS or CPU.
  - **In the browser**, SAM 2 runs on WebGPU via [Transformers.js v4](https://huggingface.co/blog/transformersjs-v4) / ONNX Runtime Web ([webgpu-sam2](https://github.com/lucasgelfond/webgpu-sam2)), at roughly 1 s encode per view on M-series, so minutes for a full lift.
  - **SAM 3** (text prompts like "chair") **won't run on Apple Silicon**, because it depends on Triton ([discussion](https://huggingface.co/facebook/sam3/discussions/11)).

### 2.3 Object → parts
- Learned options ([SAMPart3D](https://github.com/Pointcept/SAMPart3D), [PartField](https://github.com/nv-tlabs/PartField), [PartSAM](https://github.com/czvvd/PartSAM), GeoSAM2, PartSLIP) are CUDA-bound.
- **Mac/browser-viable:**
  - **[CoACD](https://github.com/SarahWeiii/CoACD)** (MIT, `pip install coacd`, macOS wheels). Approximate convex pieces; merge small hulls to get legs/seat/back.
  - **Geometric JS methods:** shape-diameter function, dihedral-angle/concavity region growing, and spectral clustering on the face graph.

### 2.4 In-browser stack (no build step, all CDN-loadable)
- **[three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh)** (MIT). Fast raycast, lasso/brush triangle selection, spatial queries. The backbone for picking, painting segments and gesture ray-select.
- **[meshoptimizer](https://www.npmjs.com/package/meshoptimizer)** WASM for simplification and compression, and **[manifold-3d](https://www.npmjs.com/package/manifold-3d)** WASM for booleans and splitting.
- **`BatchedMesh`** for many movable objects.
- **Gaussian splats: [Spark](https://github.com/sparkjsdev/spark)** (World Labs, MIT; reads PLY/**SPZ**/SPLAT/KSPLAT/SOG). Region recolour/move via `SplatEdit` ([docs](https://sparkjs.dev/docs/splat-editing/)). **Requires three ≥0.180; the project is on r161.** GaussianSplats3D is no longer developed.
- **Serverless upload pattern:** file input or drag-drop → Web Worker (JS/WASM) → labels as a per-face `Uint16Array` → IndexedDB, or export as a GLB with a custom `_SEGMENT_ID` attribute.

### 2.5 Per-object colour in the hologram shader
A `segmentId` vertex attribute and a small palette (uniform array or texture): the fragment shader picks `palette[segmentId]` and scanlines and fresnel stay on top. A `selectedId` uniform drives the highlight and glow. To *move* an object, extract its triangles into its own geometry or `BatchedMesh` instance rather than updating vertices every frame.

---

## 3. Prior Art: Who Is Already Doing This

| Product | What it does | Completion / segmentation | Paywall / limits |
| --- | --- | --- | --- |
| [IKEA Kreativ](https://www.ikea.com/us/en/newsroom/corporate-news/ikea-launches-new-ai-powered-digital-experience-empowering-customers-to-create-lifelike-room-designs-pub58c94890/) | Scan a room, **erase** furniture (yellow outlines, Hide All / Show All), place IKEA products | Erasing is **2D photo inpainting**, not 3D | Free, but IKEA catalogue only, no export |
| [Matterport Cortex / Genesis](https://matterport.com/cortex-ai) | Defurnish, declutter, erase one item, AI redesign | Cloud AI | Starter ~$10/mo → Business $309+/mo |
| [Polycam](https://www.prnewswire.com/news-releases/polycam-makes-adjustable-ai-floor-plans-native-to-reality-capture-302702948.html) | RoomPlan room mode, live 2D↔3D floor-plan editor | RoomPlan | Free = GLTF only, ~150 images |
| [Apple RoomPlan](https://machinelearning.apple.com/research/roomplan) | Parametric walls + boxes for 16 furniture classes | Boxes, not real shapes | Free API, iOS only |
| Magicplan / Hover | Floor plans, dollhouse views, measurement | Walls/doors/windows | Contractor-focused, paid tiers |
| Houzz / Planner 5D / RoomGPT | Place catalogue products, restyle 2D images | Don't edit *your* scanned geometry | Paid / watermarked |
| [World Labs Marble](https://www.worldlabs.ai/blog/marble-world-model) | Generated 3D worlds; remove/swap/restyle; mesh import | Generative | Hi-res mesh export is Pro |
| Luma Genie | Discontinued 2026-01-01 | — | Shows how unstable "free AI 3D" is |
| [Meta Hyperscape](https://www.uploadvr.com/meta-horizon-hyperscape-photorealistic-scene-capture-quest-3/) | Quest room → photoreal splat | View-only | — |
| [Meta SceneScript](https://www.projectaria.com/scenescript/) | Room as a language of commands (`make_wall`, `make_bbox`) | Research | Non-commercial weights |
| [Google Shopping 3D](https://research.google/blog/bringing-3d-shoppable-products-online-with-generative-ai/) / [`<model-viewer>`](https://modelviewer.dev/examples/annotations/) | 360° product spins from 1–3 photos; hotspots, dimension lines, interaction prompt | — | — |

**Academic threads:**
- **Diminished reality / defurnishing:** [PanoDR](https://vcl3d.github.io/PanoDR/), ["An Empty Room is All We Want"](https://www.alphaxiv.org/abs/2405.03682).
- **Amodal completion:** [Amodal3R](https://arxiv.org/abs/2503.13439), [DeOcc-1-to-3](https://arxiv.org/pdf/2506.21544), [3D-RE-GEN](https://github.com/cgtuebingen/3D-RE-GEN), [SceneReGen](https://arxiv.org/abs/2608.23930).
- **Language-driven scene editing:** [Instruct-NeRF2NeRF](https://instruct-nerf2nerf.github.io/), [GaussianEditor](https://arxiv.org/abs/2311.14521).
- **Object rearrangement:** [RecurGS](https://arxiv.org/pdf/2512.18386) (fuses re-scans so moved objects reveal hidden geometry), [ObjectSplat](https://arxiv.org/pdf/2608.30423).

**Open-source neighbours:**
- **Gesture viewers:** [3d-model-playground](https://github.com/collidingScopes/3d-model-playground) and [gesture-3d-viewer](https://github.com/k1l000/gesture-3d-viewer). **Single objects only.**
- **Room tools:** [OpenPlan3D](https://openplan3d.com/) (RoomPlan + browser editor), [ai-interior-designer](https://github.com/utsapoddar/ai-interior-designer), [blueprint3d](https://github.com/furnishup/blueprint3d) / [modern fork](https://github.com/khalid3314/blueprint3d-modern), Sweet Home 3D.

**Interaction design for rooms and objects:**
- [visionOS](https://stepinto.vision/articles/deep-dive-into-manipulation-on-visionos/): look + pinch, with depth "telescoping".
- [Meta hands](https://developers.meta.com/horizon/design/hands-ui-best-practices/): a **ray for far targets, direct grab when near**, hands resting near the hips.
- Google `<model-viewer>`: idle prompt, normal-aware hotspots, dimension lines.
- For rooms that means a **scene mode** (dollhouse orbit / walk) and an **object mode** (ray-select → pinch-drag with floor/wall snapping, gizmo for mouse), with a visible hover highlight *before* commit.

---

## 4. Where This Project Can Stand Out

Nobody combines these, and none of them requires a paid service:
1. **Free, local completion with honest marking.** No product shows which surfaces are *inferred* vs *scanned*. Confidence-coded hologram rendering (scanned = solid glow, inferred = ghosted/dashed) is new, and it's easy to explain in an interview.
2. **Universal segmentation** with no fixed class list (unlike RoomPlan's 16 classes or Matterport's cloud).
3. **Hand-gesture control of whole segmented rooms** in a browser (existing gesture demos stop at one object).
4. **No catalogue lock-in.** Rearrange and recolour *your own* furniture, not IKEA's.
5. **Open export** (GLB, later splats), where competitors paywall formats.

**Borrow list:**
- **IKEA:** hover outline + Hide All / Show All.
- **Matterport:** three removal levels (defurnish / declutter / erase one).
- **Polycam:** 2D plan ↔ 3D sync + measure.
- **SceneScript:** store edits as a command list (undo, diffs, later language editing).
- **CAOA / Scan2CAD:** complete first, then optionally snap to a template.
- **RecurGS:** a second scan after moving furniture reveals *real* hidden geometry.
- **Quest / visionOS:** ray-aim + pinch-commit, near/far switch, comfortable arm range.

---

## 5. Recommended Pipeline (feeds `ROADMAP.md` in this folder)

- **v1, free, any computer, CPU:**
  1. Open3D cleanup (RANSAC floor + statistical outliers).
  2. Room planes, or RoomPlan's layout, to rebuild the shell.
  3. Per-furniture oriented boxes and planes to close backs and undersides.
  4. Symmetry mirror.
  5. Capped close-holes → screened Poisson / RIMLS with density trim → Taubin smoothing.
  6. Keep only geometry more than ~1–2 cm from the real scan, tagged *inferred*.
- **v2, stronger:**
  1. Retrieve (CLIP → ABO/Objaverse) or generate (SPAR3D on M5 MPS/low-VRAM; Hunyuan3D-2mini via Mac fork; the 2070 as fallback).
  2. Scale by oriented box.
  3. Open3D FPFH+RANSAC → ICP (or KISS-Matcher).
  4. Merge only the missing regions, then Poisson-fuse.

**Limitations to state honestly:**
- Nothing that truly conditions on the partial scan runs well on 16 GB Apple Silicon *today*.
- Mac ports are community-maintained and fragile.
- Generated or retrieved objects are approximate.
- Licences carry restrictions (Hunyuan territory exclusions, ABO non-commercial, PyMeshLab GPL).
- **Most of the real gain will come from planes, primitives and Poisson.**

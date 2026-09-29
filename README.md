# hologram-workshop

A browser-based "hologram" demo: a real object is LiDAR-scanned on an iPhone, rendered in
Three.js with a holographic shader, and manipulated live by hand gestures tracked through
the webcam. Screen-based Tony-Stark-workshop aesthetic — not AR passthrough.

What makes it different from the usual hand-tracking demo: every comparable project
manipulates a *downloaded* model. This one manipulates a scan of an object you actually own.

## Project tracks

Where this is heading: an **architectural hologram platform**. Upload a LiDAR scan of any room or object, interact with it through universal gesture and mouse controls (no hand-made parts), colour individual objects, rearrange furniture, and see what the scanner missed, filled in by a free, local algorithm and always marked as inferred. Everything on this page today is **v1**, the engine that platform is built on.

| Track | Plan |
| --- | --- |
| **A — Hologram Platform** ★ upload any scan, segment it, control, colour, decorate | [plans/platform/ROADMAP.md](plans/platform/ROADMAP.md) |
| **B — Scan Completion** ★ fill in undersides, backs and holes, free and Mac-runnable | [plans/scan-completion/ROADMAP.md](plans/scan-completion/ROADMAP.md) ([research](plans/scan-completion/RESEARCH.md)) |
| **C — Neurotech Bionic Arm** (parked) | [plans/neurotech-arm/ROADMAP.md](plans/neurotech-arm/ROADMAP.md) |
| *v1 history* — the object hologram below | [plans/object-hologram/ROADMAP.md](plans/object-hologram/ROADMAP.md) |

The index and the isolation rules are in [ROADMAP.md](ROADMAP.md).

## Live

No install, no server — every page runs entirely in the browser:

- **[Hologram + gestures](https://crazycatz67.github.io/hologram-workshop/hologram.html)** — the full experience. Includes a **practice mode** that arms one gesture at a time (move, spin, tilt, push/pull, scale, explode, clap) so each can be learned and tuned without the others firing, plus live sensitivity / trigger-delay / momentum controls. `D` shows the camera and tracking overlay, `P` toggles the panel
- **[Model viewer](https://crazycatz67.github.io/hologram-workshop/)** — the hologram alone, drag to orbit, no camera needed. `?model=<path>` loads a different mesh and `?plain=1` swaps in an opaque material, both for judging a `clean_scan.py` result
- **[Hand tracking](https://crazycatz67.github.io/hologram-workshop/hands.html)** — tracking on its own, with the raw pinch/gesture numbers on screen

The gesture page carries an always-visible **gesture reference** (what each hand shape does) and a live status line naming which gestures are currently locked out by whichever one is active — mode-switching itself needs sustained, deliberate confirmation to interrupt an in-progress gesture, not just a brief flicker, so a misread frame can't hijack an active grab into something else.

Both pages carry a **measurement panel**: real dimensions, detected key heights (seat height and the like, found rather than assumed), an estimated weight and shipping carton, a tape measure between any two points you pick, a will-it-fit check against an opening, and notes you can pin to the object and export as a report. **Calibrate** against one hand measurement to correct the whole scan — LiDAR carries real scale but is typically a few percent out, and the report says whether it was calibrated. The scan carries true real-world scale, so these are measurements rather than decoration — and scaling the hologram never changes them, since resizing a hologram does not resize the real object. `M` hides the panel.

Gesture pages need camera permission. On macOS you may have to allow it twice: once in the
browser, and once in System Settings → Privacy & Security → Camera.

## Status (v1)

| Phase | State |
| --- | --- |
| 0 — Capture the object | Done. Raw scan `assets/chair/chair.glb`, cleaned to `chair_clean.obj` by `clean_scan.py` |
| 1 — Hand tracking foundation | Done, confirmed on a real webcam |
| 2 — Static model in the browser | Done. Three.js + OrbitControls, no build step |
| 3 — Hologram shader | Done. Fresnel glow + scanlines, tunable live |
| 4 — Gesture-driven manipulation | All v1 gestures built and confirmed on a real webcam once; every rate limit and hysteresis check rewritten to be frame-rate independent after that first session |
| 5 — Polish and stretch | Measurement tools built (dimensions, tape measure, fit check) |

Full breakdown in [plans/object-hologram/ROADMAP.md](plans/object-hologram/ROADMAP.md); working conventions in [CLAUDE.md](CLAUDE.md).

**Regression tests:** open [`test.html`](test.html) locally and read the page — 37 checks covering gesture isolation, tracking-noise robustness, and every measurement figure against the shipped chair scan. No framework, no build step; a run is opening the page.

## Running locally

Needs a static server — `GLTFLoader` uses `fetch()`, which browsers block on `file://`
URLs, and the camera API needs a secure context (localhost counts as one).

```
python serve.py        # python3 on macOS
```

Then open <http://localhost:8080>.

## Layout

| File | Role |
| --- | --- |
| `hologram.html`, `hologram.js` | The combined page: hologram + gesture control |
| `index.html`, `main.js` | Model viewer only (no camera) |
| `hands.html`, `hands.js` | Hand tracking only, with raw gesture numbers on screen |
| `scene.js` | Renderer, camera, lights, controls, render loop |
| `loadModel.js` | Model loader (GLB, or OBJ with or without MTL) and camera framing |
| `measure.js` | Real-world measurement: oriented footprint, volume, detected surface heights, weight, shipping, fit check |
| `annotations.js` | Notes pinned to points on the object, persisted, and the exported report |
| `measurePanel.js` | The measurement UI (size, key heights, weight, tape, fit, notes), shared by both pages |
| `trimGeometry.js` | Cylinder crop, kept for reference — no longer used by either page now that cleanup happens offline |
| `HolographicMaterial.js` | The hologram shader (vendored MIT source, not an npm package) |
| `camera.js` | Webcam setup and teardown |
| `handTracker.js` | MediaPipe `GestureRecognizer`, two hands |
| `gestures.js` | Pinch, two-hand span and angle |
| `overlay.js` | Canvas skeleton and labels |
| `stabilizer.js` | Hysteresis so a gesture needs a few consistent frames to start or stop |
| `manipulator.js` | Maps stabilised gestures onto the model. Each channel (move/spin/tilt/push/scale/explode/clap) is individually armable, which is what practice mode drives |
| `ghostHands.js` | Renders tracked hands as real 3D geometry in the scene, not a flat overlay |
| `smoothLandmarks.js` | Exponential smoothing on raw landmark positions, matched frame-to-frame by nearest wrist position |
| `serve.py` | Static server that sends `no-store` |
| `test.html`, `test.js` | Regression suite — open the page, read pass/fail. Synthetic hand geometry and the shipped chair scan; no build step, no framework |
| `analyze_scan.py` | Suggests crop parameters for a new raw scan (see v1 roadmap) |
| `clean_scan.py` | **Raw scan → clean object.** Detects and removes the ground plane (without deleting the object's base), rebuilds missing structure by mirroring, fills gaps, welds watertight, decimates for the web |
| `repair_scan.py` | Lower-level mesh repair (PyMeshLab, no GUI) — see v1 roadmap for what worked and what didn't |
| `ROADMAP.md`, `plans/` | Track index + isolation rules; one roadmap per track under `plans/` |
| `platform/`, `completion/`, `neurotech/` *(not created yet)* | Where Platform (browser), Scan Completion (Python) and Arm code will live, kept apart from the v1 files above |

No bundler and no dependencies to install for the site itself — Three.js and MediaPipe
both load from a CDN via an import map. `analyze_scan.py` needs `numpy`; `clean_scan.py`
needs both; `repair_scan.py` needs `pymeshlab`. All three are local dev tools, not part of
what ships to the browser.

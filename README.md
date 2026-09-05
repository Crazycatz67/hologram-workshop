# hologram-workshop

A browser-based "hologram" demo: a real object is LiDAR-scanned on an iPhone, rendered in
Three.js with a holographic shader, and manipulated live by hand gestures tracked through
the webcam. Screen-based Tony-Stark-workshop aesthetic — not AR passthrough.

What makes it different from the usual hand-tracking demo: every comparable project
manipulates a *downloaded* model. This one manipulates a scan of an object you actually own.

## Live

No install, no server — every page runs entirely in the browser:

- **[Hologram + gestures](https://crazycatz67.github.io/hologram-workshop/hologram.html)** — the full experience: closed fist to grab and move it or twist your wrist to spin it, two-hand pinch to scale it, clap open hands to reset it (press `D` to reveal the camera/tracking view, hidden by default — real 3D "ghost hands" in the scene are the normal feedback instead)
- **[Model viewer](https://crazycatz67.github.io/hologram-workshop/)** — the hologram alone, drag to orbit, no camera needed
- **[Hand tracking](https://crazycatz67.github.io/hologram-workshop/hands.html)** — tracking on its own, with the raw pinch/gesture numbers on screen

Gesture pages need camera permission. On macOS you may have to allow it twice: once in the
browser, and once in System Settings → Privacy & Security → Camera.

## Status

| Phase | State |
| --- | --- |
| 0 — Capture the object | Done. `assets/chair/chair.glb`, cropped to just the chair |
| 1 — Hand tracking foundation | Done, confirmed on a real webcam |
| 2 — Static model in the browser | Done. Three.js + OrbitControls, no build step |
| 3 — Hologram shader | Done. Fresnel glow + scanlines, tunable live |
| 4 — Gesture-driven manipulation | Core done — grab/move, two-hand scale/rotate. Push/pull and explode not built yet |
| 5 — Polish and stretch | Not started |

Full breakdown in [ROADMAP.md](ROADMAP.md); working conventions in [CLAUDE.md](CLAUDE.md).

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
| `loadModel.js` | GLB loader with OBJ+MTL fallback, and camera framing |
| `trimGeometry.js` | Crops scan geometry to a cylinder — removes whatever else got scanned around the object |
| `HolographicMaterial.js` | The hologram shader (vendored MIT source, not an npm package) |
| `camera.js` | Webcam setup and teardown |
| `handTracker.js` | MediaPipe `GestureRecognizer`, two hands |
| `gestures.js` | Pinch, two-hand span and angle |
| `overlay.js` | Canvas skeleton and labels |
| `stabilizer.js` | Hysteresis so a gesture needs a few consistent frames to start or stop |
| `manipulator.js` | Maps stabilised gestures onto the model (grab/move/rotate with momentum, scale, clap-reset) |
| `ghostHands.js` | Renders tracked hands as real 3D geometry in the scene, not a flat overlay |
| `smoothLandmarks.js` | Exponential smoothing on raw landmark positions, keyed by handedness |
| `serve.py` | Static server that sends `no-store` |
| `analyze_scan.py` | Suggests crop parameters for a new raw scan (see ROADMAP.md) |
| `repair_scan.py` | Scriptable mesh repair (PyMeshLab, no GUI) — see ROADMAP.md for what worked and what didn't |

No bundler and no dependencies to install for the site itself — Three.js and MediaPipe
both load from a CDN via an import map. `analyze_scan.py` needs `numpy`; `repair_scan.py`
needs `pymeshlab`. Both are local dev tools, not part of what ships to the browser.

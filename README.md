# hologram-workshop

A browser-based "hologram" demo: a real object is LiDAR-scanned on an iPhone, rendered in
Three.js with a holographic shader, and manipulated live by hand gestures tracked through
the webcam. Screen-based Tony-Stark-workshop aesthetic — not AR passthrough.

What makes it different from the usual hand-tracking demo: every comparable project
manipulates a *downloaded* model. This one manipulates a scan of an object you actually own.

## Live

No install, no server — both pages run entirely in the browser:

- **[Model viewer](https://crazycatz67.github.io/hologram-workshop/)** — the scanned chair, drag to orbit
- **[Hand tracking](https://crazycatz67.github.io/hologram-workshop/hands.html)** — click "start camera", then hold your hands up

The hand tracking needs camera permission. On macOS you may have to allow it twice: once in
the browser, and once in System Settings → Privacy & Security → Camera.

## Status

| Phase | State |
| --- | --- |
| 0 — Capture the object | Done. `assets/chair/chair.glb`, 76k triangles, one draw call |
| 1 — Hand tracking foundation | Built; awaiting a live webcam check |
| 2 — Static model in the browser | Done. Three.js + OrbitControls, no build step |
| 3 — Hologram shader | Not started |
| 4 — Gesture-driven manipulation | Not started |
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
| `index.html`, `main.js` | Model viewer page and its bootstrap |
| `scene.js` | Renderer, camera, lights, controls, render loop |
| `loadModel.js` | GLB loader with OBJ+MTL fallback, and camera framing |
| `hands.html`, `hands.js` | Hand tracking page and its loop |
| `camera.js` | Webcam setup and teardown |
| `handTracker.js` | MediaPipe `GestureRecognizer`, two hands |
| `gestures.js` | Pinch, two-hand span and angle |
| `overlay.js` | Canvas skeleton and labels |
| `serve.py` | Static server that sends `no-store` |

No bundler and no dependencies to install — Three.js and MediaPipe both load from a CDN
via an import map.

# Hologram Project — Instructions

## Revision History

- **2026-09-05 (3):** **Phase 1 built, awaiting a live webcam check.** MediaPipe `GestureRecognizer` pinned at `@mediapipe/tasks-vision@1.0.1` (verified reachable, 8.4MB model + 3.1MB wasm), on a standalone `hands.html` page. Everything testable without a camera passes (init 615ms, inference 14.4ms, pinch maths proven scale-invariant, overlay + mirroring, error paths); the live half is untested because this machine has no webcam. Four things need real hands — see `ROADMAP.md` Phase 1. Also added `serve.py` (no-store dev server) after stale cached files caused a misdiagnosis.
- **2026-09-05 (2):** **Phase 2 complete.** Chair renders in a real Three.js scene with OrbitControls, split into `scene.js` / `loadModel.js` / `main.js` so Phase 3 and 4 extend rather than rewrite. Scan measured at 76,210 triangles / 1 draw call / ~0.07ms per frame — performance is a non-issue at this size, and the scan is confirmed to be a **single mesh node** (so literal explode still needs a separate multi-part object). New task surfaced: trim the floor patch/wall sliver off the scan before Phase 3, since they'd glow as part of the hologram.
- **2026-09-05:** **Phase 0 complete.** Clean, isolated chair scan captured (Mesh / Medium Object / Detail settings in Scaniverse) and confirmed loading correctly — `assets/chair/chair.glb`. Ready to move into Phase 1 and/or Phase 2.
- **2026-09-04 (3):** Object changed from toy plush → **chair**, after the plush proved hard to scan cleanly. A first export also came back as a whole-room capture because Scaniverse was set to **Area** (room-scale) mode rather than **Object** mode — a capture-mode mistake, not evidence that self-scanning doesn't work. Re-scanning the chair in Object mode is the next concrete action. Also found: this Scaniverse export was OBJ+MTL+JPG, not GLB as the stack rationale assumed — open item to confirm whether GLB is available from the free tier or whether OBJ is the actual default export.
- **2026-09-04 (2):** Object to scan chosen (toy plush). Leap Motion Controller reconfirmed shelved (cost, not capability — no new info reopens it). Draco vs. Meshopt framing changed: don't presuppose Meshopt as default, benchmark both against the real scan and combine what each reveals. Pepper's Ghost physical rig moved from undecided to provisionally in scope, contingent on Phase 4 working first plus a deliberate cost check. Explode-gesture-on-a-single-mesh-object and voice-layer-scope questions remain open — see `ROADMAP.md`.
- **2026-09-04:** Initial version, generated from `hologram-project-research.md` (sessions 1–5) and the kickoff brief. Companion doc `ROADMAP.md` created same day.

## Repo

`github.com/Crazycatz67/hologram-workshop` (public, created 2026-09-05). Development happens on the Windows desktop, but **the webcam testing has to happen on the Mac laptop — the desktop has no camera.** Push from one, pull on the other; that split is the reason this is on GitHub at all.

Running it locally (`python` on Windows, `python3` on macOS):

```
python serve.py          # then open http://localhost:8080
```

A static server is required — `GLTFLoader` uses `fetch()`, which browsers block on `file://` URLs, and `getUserMedia` needs a secure context (localhost counts).

## What This Is

A browser-based "hologram" demo: a real object is LiDAR-scanned on an iPhone, rendered in Three.js with a holographic shader, and manipulated live by hand gestures tracked through the webcam (pinch to scale, closed fist to grab/move, two-hand motion to rotate). Screen-based, Tony-Stark-workshop-monitor aesthetic — not AR passthrough, not a Vision Pro app. It directly extends the existing ASL fingerspelling project's hand-tracking pipeline rather than starting one from scratch.

**What it isn't:** not a stock-model viewer (every reference project found controls a *downloaded* model — this project's whole point is scan-your-own-object → manipulate-its-own-hologram); not a native/Unity app; not glasses-based AR.

Full phase breakdown lives in [`ROADMAP.md`](ROADMAP.md) — read that for what's currently being built. Don't propose work that conflicts with a later phase's plan without flagging it (see "Flag deviations" below).

## Hard Constraints

- **No purchased hardware.** Established in Session 5 specifically to shelve the Ultraleap Leap Motion Controller option (true 3D hand tracking, ~$100–130) — good interaction quality, but ruled out purely on cost, not capability. Everything must run on the webcam + iPhone already on hand.
- **Browser-based, no build step preferred.** Matches the ASL project's existing philosophy and mirrors how `3d-model-playground` ships (Three.js r161 via a `unpkg.com` CDN import map, tiny bootstrap file, no bundler). Don't introduce a build/bundler step unless a specific need forces it — ask first (see scope-creep rule).
- **Stack is chosen, not open for casual swapping:**
  - **Scaniverse** for capture — the only one of the three apps compared (vs. Polycam, KIRI Engine) with a genuinely unlimited, no-subscription free tier that exports GLB directly, meaning zero cost and zero conversion step into the Three.js pipeline. **Resolved 2026-09-04:** confirmed GLB export works on the free tier (the first export was just OBJ because that's what was picked in Scaniverse's export menu, not a format limitation). The test loader (`main.js`) tries GLB first and falls back to OBJ+MTL, so either export format works either way.
  - **MediaPipe `GestureRecognizer`** (not raw `HandLandmarker`) — gives `Closed_Fist` and other gestures pre-classified for free, runs `numHands: 2` out of the box for two-hand gestures, and still exposes raw landmarks for the custom pinch-distance logic that has to be hand-rolled (pinch isn't in the canned gesture set).
  - **`threejs-vanilla-holographic-material`** (MIT, drop-in) for the hologram look — chosen over hand-writing GLSL because it's free, tested, and fully tunable; only drop to custom shader code if its exposed properties genuinely can't produce a needed effect.

## Reusing the ASL Project

Repo: `github.com/Crazycatz67/asl-recognizer`
Pipeline there: `camera.js` → `handTracker.js` → `normalize.js` → `knn.js` → `stabilizer.js` → `overlay.js`.

**Reuse directly:**
- `stabilizer.js`'s hysteresis logic — prevents jittery gesture misfires on grab/rotate/scale, same problem it solved for letter confirmation.
- `overlay.js`'s canvas-drawing approach — same pattern, now drawing hologram + skeleton together instead of skeleton + letter.
- The overall pipeline shape (capture → normalize → interpret → stabilize → render) — the structure carries over even though the middle steps change.

**Does not port:**
- `knn.js` and the labeled letter dataset — this project's gestures are geometric (pinch distance, hand-vector deltas), not classification against a fixed label set.
- `handTracker.js` as-is — still MediaPipe under the hood, but swapped from raw `HandLandmarker` to `GestureRecognizer` (see Hard Constraints above) feeding a gesture interpreter instead of a letter classifier.

## Reference Projects, by Build Phase

**Capture → static model (Phase 0–1):**
- Scaniverse vs. Polycam vs. KIRI Engine comparison — Session 5 of the research doc.
- `gltf-transform` CLI — mesh optimization/compression, only if the real scan needs it.

**Hologram shader (Phase 2):**
- [ektogamat/threejs-vanilla-holographic-material](https://github.com/ektogamat/threejs-vanilla-holographic-material) — primary choice.
- [OtanoStudio/Hologram-Material](https://github.com/OtanoStudio/Hologram-Material) — raw-GLSL fallback for more manual control.

**Hand tracking foundation (Phase 3):**
- Google MediaPipe `GestureRecognizer` docs (developers.google.com/mediapipe/solutions/vision/gesture_recognizer).
- Rahmawati, Andrean & Kustanto (2026), *Jurnal Ilmiah SINUS* 24(2), 35–48 — FPS/confidence benchmarks and optimal camera distance. CC BY-NC-SA 4.0.

**Gesture manipulation (Phase 4):**
- [collidingScopes/3d-model-playground](https://github.com/collidingScopes/3d-model-playground) — closest interaction-model match.
- [collidingScopes/threejs-handtracking-101](https://github.com/collidingScopes/threejs-handtracking-101) — simpler boilerplate starting point.
- [heeelol/jester](https://github.com/heeelol/jester) — validates two-hand scale/rotate mapping.
- [DareDev256/hand-playground](https://github.com/DareDev256/hand-playground) — gesture-exercise catalog.
- Microsoft MixedReality-UXTools `TwoHandManipulationRotateLogic` — platform-agnostic rotate math.
- [ishaan1013/jarvis](https://github.com/ishaan1013/jarvis) — closest overall project to this exact vision; also flags its own resource-intensity limitation.
- [akgupta1337/IronHands](https://github.com/akgupta1337/IronHands) — adjacent (Blender-target) reference for the same gesture vocabulary.
- [TonyViT/HybridHandInteractions](https://github.com/TonyViT/HybridHandInteractions) — cautionary reference on tracking reliability while gripping.

**Stretch / polish (Phase 5):**
- [longmanngithub/AI-Hand-Interaction-System](https://github.com/longmanngithub/AI-Hand-Interaction-System) — bloom/afterimage visual-style reference.
- Pepper's Ghost angle calculator: riatto.ovh/tools/crafts/peppers-ghost.
- egjs-view3d Draco/Meshopt compression benchmarks (Lucy model) — reference numbers only, not our numbers yet.

## Open Questions — Ask the User, Don't Assume

- **Explode gesture on a single-mesh object:** explode was designed for multi-part objects (pull pieces apart), but the chosen v1 object (a plush toy) is one continuous mesh with nothing to separate. Asked 2026-09-04, not yet answered — don't guess at a behavior (e.g. repurpose as stretch/expand vs. keep literal vs. drop from v1) until this is resolved.
- Is a voice-command layer in scope for v1, or purely Phase 5 stretch? Asked 2026-09-04, not yet answered.

**Resolved 2026-09-04:** object to scan (toy plush); push-pull/explode gesture *set* is in v1 scope (exact explode behavior still open, above); Draco/Meshopt approach (combine both benchmarks' findings rather than defaulting to Meshopt); Pepper's Ghost (provisionally in scope, gated on Phase 4 completion + cost check); Leap Motion Controller (stays shelved).

## How to Work on This Project (Standing Conventions)

- **Session recaps.** Start each session with a short "here's what we last did and where that puts us on the roadmap" before starting new work.
- **Teach, don't vibe-code.** Explain technical concepts in plain, non-jargon terms. Keep explanations short and in-chat by default. Only produce a diagram/visual for genuinely big or tangled ideas — not routinely.
- **Track the full roadmap, not just the current step.** Advice on the current phase should stay consistent with later phases in `ROADMAP.md` — don't build something in an early phase that conflicts with or duplicates what a later phase already plans to build.
- **Keep living docs current.** Update `ROADMAP.md` (and this file) the moment a new idea, research finding, or decision comes up in conversation — don't batch it for later. Every substantive change gets a dated entry in that doc's Revision History section at the top, describing what changed and why (not just "updated Phase 3").
- **Flag deviations before acting.** If something discovered during implementation suggests a prior decision should change, say so explicitly — "this should probably work differently because X" — rather than silently doing it differently.
- **Ask before scope creep.** Get a go-ahead before adding a new dependency, tool, or expanding scope beyond what's currently agreed. Anything deliberately out of scope gets its own visible "out of scope" note in the relevant doc, not silently dropped or silently absorbed.

**Reusable problem-solving passes to apply at natural checkpoints:**

- **Backward-reasoning pass** — before implementing a phase, trace each decision forward to how it'll actually be tested/used; does it still hold up?
- **Human-variation pass** — since this project involves live webcam hand tracking, explicitly sort concerns (lighting conditions, hand size, one- vs. two-handed use, skin tone via the upstream hand-detector) into "solved by current architecture," "needs an explicit test," or "matters later — log it," rather than assuming the pipeline is neutral by default.
- **Efficiency gut-check** — before scaling any resource (mesh density, compression, dependency weight), ask whether the specific technique in use actually benefits from more of it, or just gets heavier for no real gain (this is why compression isn't applied by default in Phase 1 — see `ROADMAP.md`).
- **Reuse-across-phases check** — when a later phase seems to need new capability, check whether it's actually just a new interface onto something an earlier phase already built, before building it twice.

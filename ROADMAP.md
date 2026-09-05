# Hologram Project — Roadmap

## Revision History

- **2026-09-05 (3):** **Phase 1 built, pending a live webcam check.** Added `camera.js`, `handTracker.js` (MediaPipe `GestureRecognizer`, pinned `@mediapipe/tasks-vision@1.0.1`, `numHands: 2`), `gestures.js` (custom pinch + two-hand span/angle), `overlay.js` (canvas skeleton + labels), and a standalone `hands.html`/`hands.js` page — kept separate from the 3D scene so Phase 4 is the thing that merges them. **Verified without a webcam** (this machine reports 0 cameras): model init 615ms, inference 14.4ms/frame (~69fps ceiling, well clear of the 25–30fps target), monotonic-timestamp guard, pinch math incl. proven scale-invariance across 0.25×–2× hand size, aspect correction, overlay rendering and mirroring, and the camera-denied error path. **Still needs your real hands to confirm:** live FPS end-to-end, `Closed_Fist` reliability, the pinch threshold (0.4 is an untested guess), and whether MediaPipe's handedness labels come out inverted against the mirrored view. Also fixed three things testing surfaced in Phase 2 — canvas resize is now self-correcting per frame instead of depending on the `resize` event, both loader errors are reported instead of the OBJ one masking the GLB one, and a new `serve.py` sends `no-store` so stale cached files stop looking like bugs.
- **2026-09-05 (2):** **Phase 2 complete.** Chair loads into a proper Three.js scene with OrbitControls, real texture, HUD (status + live FPS + controls hint), and `R` to toggle auto-rotate. Code split into `scene.js` (renderer/camera/lights/controls/render loop with an `onFrame` hook) + `loadModel.js` (format-detecting loader + origin-centering auto-frame) + a thin `main.js` bootstrap, so Phase 3 can swap the material and Phase 4 can hook per-frame gesture updates without a rewrite. A `window.hologram` handle exposes scene/camera/renderer/controls/model for live tuning — directly serves Phase 3's "confirm fresnel/color/brightness tunable live" requirement. **Measured on the real scan:** 76,210 triangles, **1 mesh node, 1 material, 1 texture, 1 draw call**, ~0.07ms/frame to submit — comfortably interactive, and it empirically confirms the roadmap's prediction that a Scaniverse scan arrives as a single continuous mesh (so literal explode really does need a separate multi-part object). Object measures 2.00 × 0.90 × 1.91 m — the 0.90m is the chair height; the rest is the floor patch. **New finding:** the floor patch and wall sliver are more visually prominent than they looked in the Phase 0 check and will read badly once the hologram shader is applied in Phase 3 (a glowing slab of floor). Trimming is now worth doing deliberately rather than deferring — see Phase 3 notes.
- **2026-09-05:** **Phase 0 complete.** A clean, isolated chair scan (`assets/chair/chair.glb`, Mesh capture / Medium Object / Detail mode) loads correctly in the bare-bones test page — real upholstery and wood texture, minor floor/wall bleed at the edges (cosmetic, not blocking). Two earlier attempts were whole-room captures (Area mode, then still too wide a physical area even with better settings); this one finally isolated just the chair. Next up: Phase 1 (hand tracking foundation) can start; Phase 2 can also start now that a real asset exists.
- **2026-09-04 (3):** Object changed from toy plush → **chair**. The plush proved hard to scan cleanly (fuzzy/fabric surfaces are a genuinely hard LiDAR case, as flagged in revision (2)); a first export came back as a whole-room capture because Scaniverse was set to **Area** (room-scale) mode rather than **Object** mode — not a plush-specific failure, but wrong capture mode. Chair is a hard-surface object, which should scan far more cleanly in Object mode. Test-loader scaffold (`index.html`/`main.js`) tries GLB first and falls back to OBJ+MTL+JPG, with auto-framing so any scan can be previewed regardless of scale. **Resolved:** re-exporting the same capture as GLB confirmed Scaniverse's free tier does export GLB directly (the first export was just OBJ because that's what was picked in the export menu) — CLAUDE.md's original stack rationale holds. That GLB re-export was still the same whole-room capture though, just a different file format — it did not fix the Area-vs-Object mode issue above. Still waiting on an actual Object-mode rescan.
- **2026-09-04 (2):** Object to scan chosen (toy plush, Phase 0). Explode gesture promoted to v1 scope (Phase 4, moved out of Phase 5) as a dual-mode gesture: literal explode for multi-part meshes + stretch/expand for single-mesh objects, auto-detected from the loaded GLB's mesh count with a manual override and an on-screen mode indicator. Push/pull depth gesture also confirmed in v1. Flagged: literal explode can't be validated end-to-end until a second, genuinely multi-part object is scanned (the plush is single-mesh) — open question on when to schedule that second scan. Draco vs. Meshopt framing changed: don't presuppose Meshopt as default, benchmark both against the real scan and combine what each reveals. Pepper's Ghost physical rig moved from undecided to provisionally in scope, contingent on Phase 4 working first plus a deliberate cost check. Leap Motion Controller reconfirmed shelved.
- **2026-09-04:** Initial version, generated from `hologram-project-research.md` (sessions 1–5). Six phases, each independently demoable. Companion doc `CLAUDE.md` created same day.

---

## Phase 0 — Capture the Object ✅ Done (2026-09-05)

**What got built:** Nothing in-browser — the deliverable was the scan itself. Scanned the chair with Scaniverse (Mesh capture, Medium Object size, Detail resolution), exported as GLB, sitting at `assets/chair/chair.glb`.

**Object: a chair.** (Originally a toy plush — switched after the plush proved hard to scan cleanly; see Revision History.)

**Done looks like:** A scan file on disk that loads without errors in a bare-bones Three.js test page, showing an isolated chair — not the surrounding room. **Confirmed 2026-09-05:** `assets/chair/chair.glb` (~15MB uncompressed) loads cleanly via `GLTFLoader`, shows real upholstery/wood texture, with a small cosmetic floor/wall patch bleeding in at the edges (not blocking).

**Sources to reference:**
- Session 5's app comparison table (Scaniverse vs. Polycam vs. KIRI Engine) — Scaniverse chosen for its unlimited free tier + direct GLB export.

**Known risks / unknowns (resolved or carried forward):**
- ~~Capture mode matters~~ — **resolved.** Two earlier attempts came back as whole-room scans (Scaniverse was set to Area/Large-Object mode). Mesh + Medium Object + Detail settings, scanned close to just the chair, finally isolated it correctly.
- Real scan geometry (noise, non-manifold edges typical of LiDAR) vs. the Phase 2 hologram shader — **still untested**, carries forward into Phase 3 as the original risk from the research doc.
- Mesh file size is now known (~15MB uncompressed) — unblocks the Phase 5 compression decision whenever that phase comes up.
- A single Scaniverse scan produces one continuous mesh regardless of how many visually distinct parts the object has (legs, seat, back won't come through as separate mesh nodes) — so the chair can only exercise the "stretch/expand" branch of Phase 4's explode gesture, not the literal multi-part branch. **Open question, still needs your input:** when to schedule a second, genuinely multi-part object scan so literal explode can be validated against real data — now, or deferred until later.

---

## Phase 1 — Hand Tracking Foundation 🟡 Built 2026-09-05, awaiting a live webcam check

**What got built:** A standalone page (`hands.html` + `hands.js`) — deliberately separate from the 3D viewer, since Phase 4 is where the two merge. Modules mirror the ASL project's pipeline shape:
- `camera.js` — `getUserMedia` setup, teardown, and human-readable messages for the denied/missing/in-use cases.
- `handTracker.js` — MediaPipe `GestureRecognizer` (pinned `@mediapipe/tasks-vision@1.0.1`, `numHands: 2`, GPU delegate, VIDEO mode). `toHands()` flattens MediaPipe's parallel arrays into one object per hand — the normalization seam Phase 4 consumes. Also guards the timestamp: `recognizeForVideo()` throws on any non-increasing timestamp, which would otherwise kill the loop on a repeated frame.
- `gestures.js` — pinch (not a canned gesture, so hand-rolled), plus `handSpan`/`handAngle` for Phase 4's two-hand scale and rotate.
- `overlay.js` — canvas skeleton, fingertip emphasis, and per-hand labels.

**Done looks like:** Hand skeleton + a live gesture label render over the webcam feed, holding a stable frame rate in the neighborhood of the SINUS paper's benchmark (25–30 FPS), tested at the paper's validated sweet spot of 0.5–1.0m from the camera. **Not yet confirmed — this machine has no webcam (0 video inputs), so the live half of this is untested.**

**Verified 2026-09-05 without a camera** (by feeding a blank canvas to the recognizer and synthetic landmarks to the maths/overlay):
- Model init 615ms; inference 14.4ms/frame ≈ 69fps ceiling, comfortably above the 25–30fps target.
- Timestamp guard holds against repeated and backwards timestamps.
- Pinch ratio 0.05 pinched / 1.16 open, and **provably scale-invariant** — identical ratios at 0.25×, 0.5×, 1×, 2× hand size.
- Aspect correction confirmed (equal horizontal and vertical gaps measure equal).
- Overlay draws correct skeleton topology, mirrors landmark x correctly, and keeps label text readable.
- Camera-denied/missing path shows a friendly message and re-enables retry.

**Sources to reference:**
- Google MediaPipe `GestureRecognizer` docs — canned gestures, `numHands` config, exact z-coordinate semantics (depth relative to wrist origin, same scale as x).
- Rahmawati, Andrean & Kustanto (2026), *Jurnal Ilmiah SINUS* 24(2) — FPS and confidence benchmarks, optimal distance.
- ASL project's `handTracker.js` (structure only — the classifier underneath is being replaced) and `overlay.js` (canvas drawing pattern, reused as-is).

**First live webcam test — 2026-09-05, on the Mac laptop via GitHub Pages:**
- **FPS: ~60 with one hand, dropping to ~40 or lower with two.** Above the 25–30 target either way. The two-hand cost is expected — it is a second inference pass per frame.
- **Handedness is correct**, and the two hands track independently with separate gestures. The suspected mirror inversion was wrong — that question is closed.
- **A real pinch reads ~0.15**, so the original `PINCH_THRESHOLD = 0.4` was far too loose. Tightened to **0.25**.
- **Bug found: a closed fist registered as a pinch**, especially with the back of the hand to the camera, and sometimes fired `Closed_Fist` and pinch simultaneously. Cause: pinch is measured in 2D projection, and in a fist the thumb and index tips collapse close together on screen. Measured on synthetic fist geometry, the gap ratio comes out at **0.178 — below even the tightened 0.25 threshold**, so tuning the threshold alone could not have fixed it. Fixed two ways: `Closed_Fist` from the recognizer now vetoes pinch outright, and a geometric guard (`MIN_PINCH_REACH`) rejects any pinch whose midpoint sits too close to the wrist, since a real pinch happens out at the fingertips while a fist curls everything back toward the palm. Synthetic separation is 1.67 (pinch) vs 0.70 (fist) against a 1.15 cutoff — **still needs confirming against a real hand**, which is why the live readout now prints `gap`, `reach` and per-fingertip distances.
- **Landmark accuracy degrades under fast motion, worst at the thumb.** Inherent to MediaPipe rather than something this code causes; the thumb is its least stable joint. Phase 4's stabilizer addresses the resulting action misfires, though not the landmark drift itself.
- **Open question:** only thumb-to-index counts as a pinch right now. Thumb-to-middle/ring/pinky do not light up. Whether those should be separate gestures or all count as "pinch" is a Phase 4 vocabulary decision, not yet made.

**Known risks / unknowns:**
- `MIN_PINCH_REACH = 1.15` is calibrated against synthetic geometry only — the on-screen `reach` readout exists so it can be set from real hands.
- Pinch is exposed as a raw per-frame threshold with **no hysteresis**, so it will chatter when held near the boundary. That is deliberate — Phase 4 inserts the ASL project's `stabilizer.js` between this and any action, and duplicating it here would pre-empt that.
- Detection/tracking confidence (80–95%) is validated under good lighting only — accuracy is known to drop at 1.5m+, in low light, and under occlusion. Treat this as a documented limitation, not a Phase 1 blocker.

---

## Phase 2 — Static Model in the Browser ✅ Done (2026-09-05)

**What got built:** `assets/chair/chair.glb` loaded into a Three.js scene (r161 via CDN import map, no bundler — matching `3d-model-playground`'s approach) with OrbitControls. Files:
- `scene.js` — renderer/camera/lights/controls setup, resize handling, and a render loop exposing an `onFrame` hook (Phase 4 will hang per-frame gesture updates off it).
- `loadModel.js` — tries GLB, falls back to OBJ+MTL; `frameObject()` centers the model on the origin (so later rotate/scale gestures pivot on the object itself) and fits the camera to it.
- `main.js` — thin bootstrap wiring the two together, plus a `window.hologram` handle for live console tuning.
- `index.html` — page shell, import map, HUD (status + FPS + controls hint).

**Done looks like:** The scanned object renders in-browser with its real material/texture, orbitable by mouse, at an interactive frame rate, in a page with zero build step. **All confirmed 2026-09-05:** texture renders correctly from every angle (front/back/underside all checked — no holes in the chair itself), orbit verified preserving camera-to-target distance, and performance measured at ~0.07ms/frame to submit with 76,210 triangles / 1 draw call.

**Sources to reference:**
- `collidingScopes/3d-model-playground`'s `index.html` — confirmed CDN import-map pattern (`unpkg.com/three@0.161.0`), tiny bootstrap `main.js`.
- `openlidarviewer` (Aurtechmx) — reference for client-side rendering of scanned data with no upload step.

**Known risks / unknowns (resolved or carried forward):**
- ~~`jarvis`'s "3D models can be resource-intensive" warning~~ — **not a concern at this mesh size.** 76K triangles, 1 draw call, 1 texture. Revisit only if Phase 4's per-frame gesture work adds cost, since the model itself clearly isn't the bottleneck.
- ~~Possible need for mesh decimation before compression~~ — **not needed.** The scan is already light; decimation would be solving a problem that doesn't exist (efficiency gut-check applies).
- **Serving note:** the page needs a static server, not `file://` — `GLTFLoader` uses `fetch()`, which browsers block on local files. `.claude/launch.json` runs `python -m http.server 8080` for this.
- **Carried into Phase 3:** the floor patch (2m across) and wall sliver surrounding the chair are cosmetically fine on a textured model but will read badly as a hologram. Needs trimming — see Phase 3.

---

## Phase 3 — Make It Look Like a Hologram

**What gets built:** Swap the model's material for `threejs-vanilla-holographic-material` (MIT, drop-in `HolographicMaterial`), tuning its exposed properties (fresnel rim glow, scanline size, hologram color, brightness, blink).

**Done looks like:** The same Phase 2 model renders with a visible Fresnel rim-glow and animated scanline/signal effect instead of its default material, with at least fresnel amount, color, and brightness confirmed tunable live.

**Sources to reference:**
- [ektogamat/threejs-vanilla-holographic-material](https://github.com/ektogamat/threejs-vanilla-holographic-material) — primary drop-in material; live demo at threejs-vanilla-holographic-material.vercel.app.
- [OtanoStudio/Hologram-Material](https://github.com/OtanoStudio/Hologram-Material) — fallback raw-GLSL reference if the drop-in material's properties can't produce a needed effect.
- Three.js Journey's "Hologram Shader" lesson / Matt Park's Medium walkthrough — for understanding the underlying Fresnel technique, even if not hand-writing GLSL.

**Known risks / unknowns:**
- **Trim the floor/wall first (new, 2026-09-05).** The scan includes a ~2m floor patch and a wall sliver around the chair. Harmless with the real texture on, but as a hologram they'd glow like a floating slab of ground. Cheapest fix is Scaniverse's own built-in crop tool before re-exporting (no new dependency, no code); alternatives are cropping in Blender, or filtering triangles by bounding box at load time in `loadModel.js`. **Needs a decision before Phase 3 tuning starts.**
- Explicitly flagged as untested in the research doc: the shader has only been verified against clean primitive geometry, not real scanned meshes with LiDAR noise/non-manifold edges (carried over from Phase 0's risk).
- Bloom post-processing is noted as pairing well with this material but is not required for "done" — treat it as a Phase 5 polish item, not a Phase 3 blocker.

---

## Phase 4 — Gesture-Driven Manipulation

**What gets built:** Wire the Phase 1 gesture interpreter to the Phase 3 hologram: pinch (custom distance logic) scales it, `Closed_Fist` + hand movement grabs/moves it, two-hand angle-delta rotates it (Microsoft's `TwoHandManipulationRotateLogic` math pattern), depth-based hand movement drives push/pull, and a two-hand pull-apart gesture drives **explode — promoted to v1 scope, dual-mode (2026-09-04):**
- *Literal explode* (multi-part meshes): each part translates outward from the object's centroid along its own centroid-to-part vector, scaled by hand-distance.
- *Stretch/expand* (single-mesh objects, e.g. the chair): the same pull-apart motion instead applies a scale/stretch transform to the whole hologram, since there's no separate geometry to pull apart.
- *Mode selection:* auto-detected at GLB load time from the model's mesh count (>1 distinct mesh node → literal explode available; 1 → stretch/expand only), plus a manual override toggle for edge cases (e.g. scan noise welding multi-part geometry into one mesh). An on-screen HUD indicator (same pattern as the Phase 1 gesture-label overlay) shows which mode is currently active and updates on load or toggle.

Port the ASL project's `stabilizer.js` hysteresis so gestures don't misfire on single noisy frames.

**Done looks like:** All v1 gestures (pinch-scale, fist-grab-move, two-hand-rotate, push/pull, dual-mode explode) work live on the actual hologram from Phase 3, holding up under the same 25–30 FPS / 0.5–1.0m conditions validated in Phase 1, with no visible single-frame jitter thanks to the stabilizer. Literal explode's "done" is partial until a multi-part object is scanned — see Known risks.

**Sources to reference:**
- `collidingScopes/3d-model-playground` and `threejs-handtracking-101` — closest interaction-model matches.
- `heeelol/jester` — validates the two-hand pinch-to-scale / angle-to-rotate mapping specifically.
- `DareDev256/hand-playground` — "3D Cube" and "Grab & Toss" exercises as close templates for grab/rotate/scale state machines.
- Microsoft MixedReality-UXTools `TwoHandManipulationRotateLogic` — reusable, platform-agnostic rotate math.
- ASL project's `stabilizer.js` — hysteresis logic ported directly.
- Codrops/Hackaday DIY hand controller — middle-finger + wrist landmarks for depth/positioning, closed-fist for grab, plus collision detection for interactivity.

**Known risks / unknowns:**
- `TonyViT/HybridHandInteractions` flags that hand tracking gets *less* reliable specifically while gripping something — a real failure mode to design around during grab/move, not just scale/rotate.
- MediaPipe's landmark depth (z) is relative and less reliable than x/y — adequate for a push/pull gesture, but not true 3D position. This is where the project's stated edge over prior art applies: because Phase 0's asset is a real LiDAR scan with true geometry, depth interaction can be designed against real mesh geometry rather than the landmark-distance proxy every reference project relies on — worth deciding explicitly in this phase rather than defaulting to the proxy purely out of habit.
- **Literal explode is unverified until a second, multi-part object exists.** The chair (Phase 0's chosen object) is a single continuous mesh, so it only exercises the stretch/expand branch. Literal explode's mesh-separation logic can be built and unit-tested against a synthetic multi-mesh GLB, but "done" for that branch specifically means scanning a second, genuinely multi-part object. **Open question, needs your input:** schedule that second scan now, or defer it.

---

## Phase 5 — Polish & Stretch Features

**What gets built (pick from, don't assume all are in scope — see Open Questions):**
- Voice + gesture combo (e.g., say "explode" to trigger the Phase 4 gesture), validated as a pattern by `3d-model-playground`.
- Bloom/afterimage post-processing for a more polished glow, as used in `AI-Hand-Interaction-System`.
- Mesh compression — see updated framing below (2026-09-04) — only if Phase 0's actual file size warrants it.
- Pepper's Ghost physical rig prep (true-black background render mode, and four synchronized camera angles if going with the pyramid version) — provisionally in scope (2026-09-04), gated on Phase 4 being fully working first plus a deliberate cost check on the ~$5–10 acrylic before committing. Not a rebuild of the software layer, just an additive rig on top of it.

*(Explode moved to Phase 4/v1 scope on 2026-09-04 — see that section; no longer built here.)*

**Done looks like:** Whichever subset is chosen (see Open Questions) works as an additive layer on top of the Phase 4 build without breaking core gesture manipulation.

**Sources to reference:**
- `longmanngithub/AI-Hand-Interaction-System` — bloom/afterimage visual-style reference.
- Pepper's Ghost angle calculator (riatto.ovh/tools/crafts/peppers-ghost) — computes the ~19–20°-from-vertical angle for the single-screen version; smartphone-pyramid version needs four mirrored camera angles instead.
- egjs-view3d Draco/Meshopt benchmarks (Lucy model: Draco −95.9% to 1.24MB, Meshopt −91.0% to 3.5MB) — reference numbers only, not our numbers yet.
- `gltf-transform` CLI (`--compress draco` / `--compress meshopt`) — practical compression toolchain if needed.

**Known risks / unknowns:**
- Compression approach updated (2026-09-04): don't presuppose Meshopt as the default. A Three.js tutorial (sbcode.net) warns Draco's decode cost can make a compressed file render *later* than the uncompressed original once client-side decode time is factored in, while Meshopt is lighter to decode — but rather than picking one up front, benchmark both against the real Phase 0 scan once compression is actually warranted, and combine what each reveals (e.g. Draco's ratio advantage vs. Meshopt's decode-speed advantage) into the final call, including whether layering both is worthwhile for this file specifically. Still blocked on a real scan file size, which doesn't exist yet.
- Pepper's Ghost requires ~$5–10 of acrylic — brushes against the no-purchase-hardware constraint. Provisionally in scope as of 2026-09-04 (see above), but the actual purchase still needs an explicit go-ahead once Phase 4 is done and the cost/benefit is real rather than hypothetical.
- **Open question, needs your input:** is a voice-command layer in scope for v1, or purely here in Phase 5? Asked 2026-09-04, not yet answered.

---

## Out of Scope

- AR/passthrough glasses-style interaction (ruled out in Session 1 — no Vision Pro, and iPhone has no first-party 3D hand-joint API).
- Multi-room / building-scale scanning (`RoomPlan`/`StructureBuilder`) — not relevant to a single scanned object.
- Ultraleap Leap Motion Controller hardware path — shelved on cost grounds (no-purchase constraint), not capability. Logged as a known future option if webcam-only tracking quality proves insufficient.
- Physical object reassembly / broken-pottery concept — abandoned in Session 5 as research-grade difficulty for a portfolio timeline.

---

## Next Concrete Action

**Open `hands.html` on a machine with a webcam and check the four unknowns listed under Phase 1** — live FPS, `Closed_Fist` reliability, the pinch threshold, and whether the handedness labels are inverted. That is the only thing blocking Phase 1 from being marked done, and it needs real hands rather than more code.

Then either:
- **Phase 3 (hologram shader)** — first decide how to trim the floor patch / wall sliver off the scan (Scaniverse's own crop tool is the cheapest option).
- **Phase 4 (gesture manipulation)** — needs Phase 1 confirmed first, since it builds directly on the gesture readings.

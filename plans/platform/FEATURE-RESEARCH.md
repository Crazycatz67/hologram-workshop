# Research: Practical Features for the Hologram Platform

**Compiled 2026-09-29** from a web-research pass: what users of room-scan, interior and 3D-viewer tools actually use and ask for, mapped onto this codebase. The evidence is thin in places (7 searches, no full-page reads). Items marked *judgement* are opinion, not sourced.

## Evidence that shapes the priorities

- **Auto floor plans and CAD-friendly export** are what Polycam and Magicplan get judged on (layered DXF; DXF/OBJ/IFC/CSV). [Polycam comparison](https://poly.cam/blog/best-floor-plan-software-compared-accuracy-speed-and-cost-for-every-budget), [Magicplan](https://blog.magicplan.app/floor-plan-sketching-software-restoration)
- **IKEA Kreativ has no measurement and no undo/redo**, and its scans fail without explanation. We already beat it on both. [toolworthy](https://www.toolworthy.ai/tool/ikea-home-design), [Pratt IxD critique](https://www.ixd.prattsi.org/2024/02/design-critique-ikea-kreativ-ios-app/)
- **Matterport's measurement mode can't save measurements**; ours can (`annotations.js`). [Matterport](https://support.matterport.com/hc/en-us/articles/360040198493-Measurement-Mode-Settings)
- **Sketchfab's annotations and camera "autopilot" tours** are a core viewer feature. [Sketchfab](https://help.sketchfab.com/hc/en-us/articles/202512456-Annotations)
- **AR hand-off:** model-viewer auto-generates USDZ for Quick Look and supports WebXR / Scene Viewer. Three has `GLTFExporter` and `USDZExporter`, but USDZ colours are a known problem. [model-viewer FAQ](https://modelviewer.dev/docs/faq.html), [discussion](https://github.com/google/model-viewer/discussions/3192)
- **"Gorilla arm":** mid-air gestures are tiring. Supported, elbow-anchored postures bring the effort close to keyboard level. [Springer](https://link.springer.com/chapter/10.1007/978-3-319-57987-0_41)
- **ADA clearance numbers** for a checker: 32″ door opening, 36″ route, 60″ turning circle. [Ironwood](https://ironwood-mfg.com/blog/ada-compliant-bathroom-design-turning-space-clear-floor-space-and-clearances/), [ada.gov](https://www.ada.gov/law-and-regs/design-standards/1991-design-standards/)

## Ranked top 10

| # | Feature | Effort | Phase | Builds on |
| --- | --- | --- | --- | --- |
| 1 | **Keyboard/mouse parity + gizmo + first-run tour.** No feature gesture-only (WCAG 2.5.1-style), `TransformControls` gizmo (bundled with three), guided tour reusing the v1 practice drills, a "rest your elbows" hint. The biggest adoption lever: recruiters and reviewers often have no webcam | S–M | P1 | `objectmode.js`, v1 practice mode |
| 2 | **Snapping + alignment guides + duplicate + import an object from a second scan.** Wall/floor snap, 90° rotate snap, distance to the nearest wall while dragging. Imported objects land at true scale on the shared y=0 floor. This is the main gap vs IKEA Kreativ (catalogue-locked) | M | P1/P4 | `objectmode.js`, `upload.js`, `detectFloorY` |
| 3 | **Save/load scene state as JSON** (edits, colours, notes, camera), tied to the scan by a file hash. Optionally a URL-hash share via lz-string (MIT). A link can't carry the scan itself, so the recipient loads the same file | M | P4 | `window.hologram.edits`, `annotations.js` |
| 4 | **Export the edited room as GLB, plus a PNG.** `GLTFExporter` with hidden parts excluded; inferred geometry flagged in glTF `extras` (an honesty feature). Export the original materials plus the palette, since the hologram ShaderMaterial won't export | S | P4 | three r161 addons |
| 5 | **Fit-through-path and clearance checker.** Pick a door or gap, test the selected object's oriented box in every orientation ("fits if tilted 40°"), ADA preset overlays, violations in red. Label it "guidance, not certification" | M | P4 | `measure.js` fit check, `measurePanel.js` |
| 6 | **Turntable / tour video export.** `canvas.captureStream(0)` + `requestFrame()` + `MediaRecorder` (WebM, native, free), with a fixed-step render mode. Cheap portfolio win | S–M | any | `scene.js` render loop |
| 7 | **Auto floor plan + area + volume.** Slice the P2 wall/floor shell at ~1 m, get a 2D outline with dimension labels, export SVG (and a small DXF writer). Wording: "approximate, from scan", plus the inferred % from P5 | M–L | after P2 | `measure.js`, segmentation output |
| 8 | **Note tour autopilot.** Each note saves a camera view, and "play tour" flies between them (Sketchfab's pattern) | S | P4 | `annotations.js` |
| 9 | **Before/after compare.** Slider or split screen between as-scanned and edited/completed, using a scissor-test double render | M | P5 | P5 scanned/inferred toggle |
| 10 | **AR hand-off.** A "View in your room" button using `<model-viewer>` (Apache-2.0) with the exported GLB | S–M | after #4 | #4 |

**Also worth doing:**
- **Visible privacy statement:** "your scan never leaves this tab" (S). It's already true, so say so.
- **Touch support:** OrbitControls pinch/pan (S). Shared links get opened on phones.
- **meshoptimizer LOD/decimation** (M).
- **Lighting / time-of-day and a realistic-texture mode** (M). Mostly for screenshots.

**Not recommended now:**
- **Real-time collaboration.** Needs a server, which breaks the free/private constraint.
- **Web Speech voice commands.** Chrome sends audio to Google, which conflicts with the privacy stance. Use a local Whisper via Transformers.js if voice ever matters.
- **Pepper's Ghost / Looking Glass.** Hardware-gated.

**Best portfolio differentiators (*judgement*): #5 and #7.** They tie our existing measurement code to real architecture rules that IKEA Kreativ and Matterport's free tier don't offer, all in a private browser tab.

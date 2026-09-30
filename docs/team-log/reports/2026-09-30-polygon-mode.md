# Polygon mode: a "polygon lens" on the scan's real triangles

**Date:** 2026-09-30 · **Author:** Ricky (research), code claims spot-checked by the overseer · **Status:** recommendation, awaiting the owner

## Summary

Recommendation: build a **polygon lens**. In a new Polygon mode on a selected object, the scan's real triangles glow as a wireframe inside a circle that follows the pointer (or later the hand ray). Inferred faces are drawn dashed. Click or pinch selects a patch of triangles. The first actions are: **info** (face count, area, % inferred), **hide** (undoable), and **mark / unmark as inferred**. Later: **push/pull with falloff**, tagged "hand-edited".

It needs one new library, **three-mesh-bvh 0.9.15** (MIT; statically checked as compatible with three.js r161; **not yet loaded in a browser**). The smallest useful slice is 1-2 days of work, mouse only, on a test page `platform/polygon-test.html` using the chair.

## Why it is feasible: measured speed (M5 Air, CPU, V8)

| Measure | Result |
| --- | --- |
| Brush query (find triangles under the circle) | ~0.5 ms, even at 10M triangles |
| BVH build, 1M triangles | 0.25 s |
| BVH build, 10M triangles | 2.4 s, 371 MB |
| Plain three.js raycast, 1M triangles | 23.6 ms |
| Raycast with BVH, 1M triangles | ~0.003 ms |

Consequence: build the BVH once per object in a **Worker** so the page never freezes; after that the lens is effectively free per frame.

## Design

- **Lens:** barycentric wireframe drawn only inside the circle, so the rest of the hologram stays calm.
- **Real vs inferred:** real triangles solid-glow; inferred (`usemtl inferred` group from `complete.py`) dashed. This keeps the project rule that inferred geometry is always visible as inferred.
- **Actions, in order:** info, hide (undoable), mark/unmark inferred, then push/pull with falloff (tagged "hand-edited").
- **Input:** mouse first for fine work; hand ray later, using the gesture budget in the [gestures report](2026-09-30-gestures-audit-anchors-measure.md).

## Limits

- three-mesh-bvh compatibility with r161 is a static check, not a browser test.
- Timings are CPU/V8 numbers on the M5, not measured inside the platform page.
- Memory: 371 MB at 10M triangles is significant on a 16 GB fanless machine; real scans are likely far smaller.

## Open questions for the owner

1. Which reading of "polygon mode" do you mean: **see** the polygons, **reshape** them, or **place your own** polygons? (The recommendation covers "see" plus light editing.)
2. May hand edits change **measured** geometry? (Fill policy says measured geometry always wins; edits would be tagged "hand-edited".)
3. Is **mouse-first** for fine work OK, with hands added later?
4. OK to add the dependency three-mesh-bvh (project rule: ask before new dependencies)?

## Sources
- three-mesh-bvh 0.9.15 (MIT) — the library recommended; compatibility with r161 checked statically by Ricky/overseer, 2026-09-30.
- Timings — measured on the M5 Air 2026-09-30 (Ricky's benchmark; overseer spot-checked code claims, not re-timed unless stated here).

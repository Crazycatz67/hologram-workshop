# P1 · Hands on the Platform: design (overseer, 2026-10-01)

**Goal.** The Platform (`platform/index.html`) gets the same hand control as the gesture demo:
- engage
- aim with the pointer
- click by pinching with the other hand
- grab, tilt, scale
- reset
- calibration

It also gets the decided Platform features: pins, pointer measuring, and hand control of the Library ring. Everything stays one system, with no second copy of the gesture code.

## 1. Architecture: one shared hands runtime
Pull everything hologram.js wires around the camera into a reusable **`handsRuntime.js`** (root):
- camera
- tracker
- landmark smoothing
- `annotateHand`
- engagement
- pointer
- reticle
- calibration
- reset gate
- tracking monitor
- ghost hands

```
createHandsRuntime({ THREE, scene, camera, renderer, canvas, overlay, pickTargets, onAction })
  → { start(), stop(), update(now), hands, pointer, calibrate(), profile, dispose() }
  emits: aim(ndc, hit), click({ndc, hit}), grab/transform/explode deltas (from manipulator
         logic), reset(), rest(handId)
```
- **hologram.js** becomes a thin consumer: its behaviour doesn't change, and test.html must stay green.
- **platform/main.js** creates the same runtime, with its own `pickTargets` (item and part meshes) and its own action adapter.

## 2. Platform action adapter (gestures → the objectmode edit API)
The Platform must never move objects directly; every change goes through `objectmode` so that undo, autosave and versions keep working.

| Gesture | Scene mode | Object mode |
| --- | --- | --- |
| Aim (pointer) | hover highlight | hover highlight (item or part) |
| Click (other-hand pinch) | select item | select part; with measure on, place tape points |
| Fist over a selection | — | `beginMove` / `moveBy` / `endMove` on the floor plane (wrist x → x, push/pull depth → z) |
| Fist over empty space | orbit camera | orbit camera |
| Tilt / two-hand scale | — | `rotateTarget` / `scaleTarget` (Y rotation first; tilt becomes a world-axis rotation) |
| Lower both hands 1 s | reset tracking | reset tracking |
| ✌ (later) | tool wheel | tool wheel |

- **Pins:** `objectmode` gains `pinned` in `snapshot`/`applyState`, and `beginMove`/`rotateTarget`/`scaleTarget` refuse a pinned target. Grabbing a part of a pinned item edits only that part; the item and camera hold still. Toggled with **P** or a pin chip; undoable; saved with versions.
- **Library ring by hand:**
  - aim + click a card → bring it to the centre
  - click the centre card → open
  - fist-drag over the ring → spin, with the speed cap already built in

## 3. Order of work (each step its own commit; Timmy gates each one)
1. **Extract `handsRuntime.js`** from hologram.js after Cody-C lands, with no behaviour change. test.html, the gesture labs and sessionrec must stay unchanged. *(Cody)*
2. **Platform: start the camera** and show ghost hands, pointer and reticle over items; click = select; calibration reused. *(Cody)*
3. **Action adapter:** grab/move/rotate/scale through objectmode, plus pins. *(Cody, then Debbie breaks it)*
4. **Hand control of the Library ring,** plus pointer measuring on the Platform (`platform/measurements.js` tape). *(Cody)*
5. **Session recorder:** log Platform hand events. *(Cody-L pattern)*

## 4. Risks
- **Two render loops:** the runtime must use the Platform's loop, not start its own.
- **Raycast cost on big scans:** reuse the polygon lens's three-mesh-bvh per item.
- **Mode errors:** scene vs object mode for hands. Recommendation: hover decides the target (the decided scheme), so hands never need Tab.
- **"Everything on" interactions:** re-run the #45-style checks with the adapter.

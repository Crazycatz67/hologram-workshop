# Track B — Room Hologram — Roadmap

**Vision:** scan an entire room and turn it into a hologram where *every object is interactive*: point at the couch, pull it out of the room, spin it, measure it, check whether it fits through the door, put it back. It's the chair experience from Track A, applied to everything in a room at once.

**Relationship to Track A:** B builds on A. Each object in the room goes through A's pipeline (cleanup, hologram shader, gestures, measurement), and "pick one object out of many" is A's per-part explode/selection work, which is being built and proven on the chess set. B's code lives in `room/`, its assets live in `assets/rooms/`, and it follows the isolation rules in the root [`ROADMAP.md`](../../ROADMAP.md).

## Revision History

- **2026-09-29:** Track created. Phases, risks and open questions drafted from the Track A codebase and its recorded lessons. No code yet, and no decisions beyond what's written as "proposed".

## Parameters (What Carries Over, What Changes)

| | Track A (object) | Track B (room) |
| --- | --- | --- |
| Scaniverse mode | Object / Mesh, Medium Object, Detail | **Area** mode. Track A's history treats this as "the wrong mode"; for B it's the right one |
| What's in the scan | One object, floor and walls cut away | Floor, walls and ceiling are *part of the scene*. Objects are separated *from* them rather than deleted |
| Camera | Orbits around the object | Also needs an overview ("dollhouse") view and possibly a look-around view from inside the room |
| Mesh size | ~76k triangles, 23 MB folder, performance a non-issue | Likely far larger. Performance, compression and GitHub file limits become real (Track A's Phase 5 compression question finally gets real data here) |
| Unit of interaction | The whole model, or one part after explode | One object selected out of many, with the room as context |
| Measurement | Object dimensions, fit check against an opening | Same per object, plus room-level: "does this couch fit against that wall", "would it fit through this door" |
| Constraints | No purchased hardware, browser-only, no build step, fixed stack | **Proposed: identical to A.** iPhone + Scaniverse + webcam + browser. See Out of Scope for what that rules out |

## Phases

### Phase B0 — Capture a Room

**What gets built:** one Area-mode Scaniverse scan of a real room, exported as GLB (or OBJ). Record triangle count, file size and texture sizes on day one, since every later decision depends on them.

**Capture approach (proposed): room shell + separate key furniture.** This comes straight from the chess lesson in Track A. Splitting one dense scan into many objects failed there, while simple single-object scans succeed reliably. So:
1. One Area scan of the whole room gives the shell and the layout. Every object's *position* comes from this.
2. Separate Object-mode scans of the 3–5 pieces that matter most (e.g. chair, desk, couch) give clean, high-detail geometry, cleaned with the existing, unmodified `clean_scan.py`.
3. The detailed scans replace their rough counterparts inside the room, the same "assemble from clean parts" idea as `assemble_chess_set.py`.

Try the plain version first (one Area scan, segmented in B2). Fall back to shell + separate scans only for objects that come out badly.

**Note:** a whole-room Area-mode capture already exists from 2026-09-04, taken by accident while scanning the plush (`assets/plush/`, 21 MB, git-ignored, so probably only on the Windows desktop). It's a free first test asset for B1/B2 before capturing a room deliberately.

**Done looks like:** a room scan on disk that loads in a bare Three.js page, with its size numbers written down here.

### Phase B1 — Load and Look Around the Room

**What gets built:** `room/index.html` loads the room with the existing `scene.js` / `loadModel.js` / `HolographicMaterial.js`, imported rather than copied. It adds an overview camera and a way to move around at room scale.

**Watch for:** Track A's camera framing (`frameObject`) assumes one object in the middle. A room needs different framing. Per isolation rule 4, that's a new function in `room/`, not a change to `frameObject`'s defaults.

**Done looks like:** the room renders as a hologram at a smooth frame rate on the Mac, with measured triangle count and frame time written down.

### Phase B2 — Split the Room into Objects (the hard part)

**What gets built:** a script (proposed `room/segment_room.py`, or new flags on `clean_scan.py` whose defaults leave today's behaviour untouched) that turns one room mesh into a **grouped OBJ**: `o floor`, `o wall_1`, …, `o chair`, `o desk`. That's the same `o <name>` convention the chess pipeline and `findExplodeParts` already consume, so the browser side needs no new loading code.

**Approach, built on what Track A already measured:** A's key cleanup finding was that you separate floor from object **by surface identity, not height**, because a floor is a large flat plane that touches the capture boundary. In a room the same test finds the floor, the walls and the ceiling (large planes at the boundary). Once they're removed, what's left falls apart into connected clusters, and each cluster is a candidate object.

**Known risks:**
- **Objects touching walls or each other** (a desk against a wall, a chair tucked under a desk) won't separate cleanly by connectivity alone. v1 needs a manual assist: let the user draw or pick a split, or name the clusters.
- **Small clutter will fragment** (books, cables, things on shelves): the chess failure mode. Proposed v1 answer: don't make clutter interactive. Leave it as part of the room shell and only make furniture-sized clusters grabbable.
- **Occluded surfaces** (the underside of a table, the back of a couch against a wall) will be missing. Track A's symmetry-mirror fill may help some furniture. A pulled-out object will simply show holes where the scanner couldn't see, and that's acceptable for v1.
- **Automatic labelling** ("this is a chair") would need an ML model and is not in v1. Objects get generic names or names the user types.

**Done looks like:** the test room splits into floor/walls plus at least 3 correctly separated furniture objects, with the results checked visually via `?plain=1` the same way Track A checks cleanup.

### Phase B3 — Interact with Any Object in the Room

**What gets built:** select an object in the room (point/pinch, or click as a fallback), lift it out of the room, then apply Track A's full gesture set to *that object*: move, spin, tilt, scale, and its measurement panel. Put it back / reset returns it to its scanned position.

**Reuse check:** most of this should be Track A's per-part explode + `selectPartAtScreenPoint` + `createManipulator` + `measureObject`, pointed at one group of the room. **The part-selection UI glue is still unbuilt in Track A too** (A's Next Concrete Action, item 5). Decide deliberately whether it gets built once in A and imported by B, which the root isolation rules favour, rather than building it twice.

**Done looks like:** on a real webcam, pull the chair out of the room hologram, rotate it, read its dimensions, and put it back, without other objects moving.

### Phase B4 — Room-Level Features (stretch, pick from)

- Rearrange furniture and save/load a layout.
- Room-scale fit checks: will this object fit in that gap or through that door. This extends `measure.js`'s `fitCheck` to use real openings found in the scan.
- Whole-room gestures: rotate or scale the entire dollhouse view. These must not conflict with per-object gestures, since Track A's gesture-isolation work shows how easily gestures bleed into each other.
- Floor-plan export (top-down outline with measurements).

## Out of Scope (for now)

- **Apple RoomPlan.** It gives excellent automatic room + furniture detection, but it's a native iOS (Swift) API. That breaks the browser-only / no-native-app constraint and would mean writing an iPhone app. It's recorded as the strongest known option if B2's own segmentation proves too weak. Reopening it is an explicit decision, not a default.
- Multi-room or whole-building scans.
- AR passthrough (placing the hologram *in* the real room through a headset). Still ruled out project-wide.
- ML object recognition/labelling in v1.
- Making small clutter individually interactive in v1.

## Open Questions — Ask, Don't Assume

- **Which room gets scanned first?** Smaller and less cluttered is much easier for B2. A bedroom or office with a few big pieces of furniture is ideal.
- **Start before or after Track A's chess work?** B3 depends on the part-selection glue that A was going to build against the chess set.
- **Is "shell + separate furniture scans" acceptable,** or does it have to be one scan, no extra captures, for the demo to feel right?
- **Size budget:** how large a room scan are we willing to commit to the repo and serve on GitHub Pages? Compression (Draco/Meshopt), Git LFS, or hosting big scans outside the repo?

## Next Concrete Action

1. Answer the open questions above (at minimum: which room, and start now or after chess).
2. **B0:** find the accidental 2026-09-04 Area-mode room scan (`assets/plush/`, on the Windows desktop?) and record its triangle count and size here. It's a free first test asset.
3. Capture one deliberate Area-mode scan of the chosen room and record its size numbers.

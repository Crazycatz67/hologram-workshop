# HANDS-UX-SPEC — hands-only interaction grammar (hologram.html + Platform)
*Ricky, 2026-10-01 (saved by the overseer). Implements the approved plan `~/.claude/plans/lovely-mapping-zebra.md`. Confidence: **C** confirmed, **L** likely, **U** design choice still to be measured.*
*Pending owner OK: lens radius set by pinch-hold drag (not finger spread); fixed wheel slots; the aim→grab confidence bypass.*

## 1. Pose → meaning (one meaning per pose, site-wide)
| Pose | Meaning | Conflict it avoids |
|---|---|---|
| Rest: below the engage line, out of frame, or no pose for 400 ms | Cursor fades; nothing fires; tracking reset | Accidents while talking or typing |
| Engage: hand above the calibrated `engageY` | Hand model + idle cursor appear | — |
| Aim ☝: index out, three fingers curled (`gunPose`) | Moves the cursor; the first hand to aim owns it | Thumb_Up misread of pointing (**C**) |
| Click: OTHER hand pinches | Click at the snapped target | Heisenberg drift; other-pinch drifts least (3.6 px median, **C**) |
| Thumb-tap (trial, behind a setting) | Click; must win the A/B in Selection practice | Rewind to the tap onset (Linburg–Comstock coupling) (**L**) |
| Fist ✊ | Grab focus: selection → model → view (Platform orbit) / ring spin | A pin blocks it; a recent pointer blocks it |
| Second hand (any shape) while the first is fisted | Tilt (hybrid position/rate) | — |
| Two-hand pinch | Scale (vertical span weighted) | Aim + other-pinch is a click |
| Two open hands spreading | Explode | — |
| Clap (approach then merge) | Reset (undoable); allowed during explode; a blocked clap doesn't spend the arm | — |
| ✌ held 650 ms | Tool wheel | Ring tier hidden for the first 200 ms (`holdGate.js`) (**C**) |
| 👎 held 650 ms | Undo (a repeat within 2 s uses the short tier) | 👎 never grabs (`gestures.js:124`) (**C**) |
| Open palm | Release / coast | — |
| Pinch-hold + move | Drag a value: slider, scroll, lens radius, tape line | One "drag" meaning everywhere |
| Thumb_Up, ILoveYou | Reserved (both are common misreads) | — |

### Transitions (target = pose onset → visible effect)
| From → to | Target | How |
|---|---|---|
| rest → engage | ≤300 ms | 150 ms eased fade-in |
| engage → aim | ≤100 ms | Sticky pointer: holds through wobble until a clear palm, fist or ✌, or 350 ms |
| aim → click | ≤150 ms | `createPinchEdge`; snap point taken from 100 ms before onset |
| aim → grab | **≤250 ms** (now ~350) | Skip POINTER_GAP when Closed_Fist confidence ≥0.8 AND the pinch distance is above threshold; keeps the #47 guard |
| grab → release | 220 ms | unchanged |
| grab ↔ scale/tilt | ≤250 ms | Exempt from the 400 ms neutral gap (as TRANSFORM, #45) |
| → wheel / undo | 650 ms (200 ms on repeat) | holdGate tiers |
| clap | ≤100 ms after contact | — |

## 2. Hand → DOM (`handUI.js`)
- **Hit test:** `elementFromPoint`. Interactive means `button, a, input, select, [role=button], [data-hand]`.
- **Magnetism:**
  - Snap to the nearest interactive element whose rect, grown by 24 px (**U**), contains the cursor.
  - Switch only when the new target is 1.3× closer.
  - Click at the element's centre.
  - Eased hover ring.
- **Minimum target:** 48×48 CSS px in hands mode, as a padded hit area under `body.hands-on`. Wheel sectors are 96 px.
  - Microsoft's ray minimum is 1° ≈ 9.6 mm at 55 cm ≈ 48 px on the Air (**L**).
  - Webcam thumb drift reaches up to 48 px (**C**).
- **Slider:**
  - Pinch-hold, then move; fire `input` while moving and `change` on release.
  - Precision: below 5 cm/s, gain is halved (PRISM, **U**).
- **Scroll:** pinch-hold and move (touch-like, with momentum). Never scroll by dwell.
- **Text fields:** a pinch focuses the field and shows "type (optional)". Core flows get automatic names or preset chips. No voice (Web Speech sends audio to Google, **L**).
- **Library ring:** aim + other-pinch opens a card; fist-drag spins the ring; a flick coasts.
- **Polygon lens:**
  - The lens follows the cursor; un-gate `platform/main.js:1362` and `platform/hands.js:190,361,382`.
  - Other-pinch selects.
  - Pinch-hold + vertical move sets the radius (12–400 px) with a readout.
  - `[` / `]` keys.

## 3. Camera start (the only non-hand step)
- **First time:** a big 📷 button; one click → `getUserMedia`; store `hands.rememberCamera=1` (checkbox, default on, also in Help).
- **Later:**
  - If remember is on, run `navigator.permissions.query({name:'camera'})`: granted → auto-start; prompt → pulse the button; denied → "Unblock in the address bar".
  - Supported in Chrome 64+, Safari 16+, Firefox 132+ (**C**). Safari may re-prompt each session (**U**).
  - The Help panel offers "Camera off".

## 4. ✌ tool wheel
- **Slots are the same on both pages** (muscle memory):
  - ↑ Undo · ↓ Reset view · centre Help.
  - The other four slots differ by page:

| Slot | Platform | hologram.html |
|---|---|---|
| ↗ | Measure | Tape (notes stay in the panel) |
| ↘ | Polygon lens | Explode/Parts |
| ↙ | Library ring | Models carousel |
| ↖ | Pin / unpin | Practice |

- **Open:** ✌ held 650 ms. The wheel opens at the cursor and stays world-fixed.
- **Pick:** marking menu. Moving past 40% of the radius highlights a sector; other-pinch confirms (Kurtenbach 1993, **C**).
- **Cancel:** ✌ again, rest, Esc, or 5 s idle.
- **Centre + pinch:** opens Help.

## 5. Hand asset and retarget
- **Asset:** WebXR Input Profiles `generic-hand`.
  - Source: `https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0.20/dist/profiles/generic-hand/{left,right}.glb`.
  - About 94 KB each: one SkinnedMesh, 1,360 vertices, 25 joints.
  - **MIT, © 2019 Amazon** (packages/assets/LICENSE.md) (**C**).
  - Vendor it into `assets/hand/` together with its LICENSE.
- **Bones:** 25, all flat children of `Armature`:
  - `wrist`
  - `thumb-{metacarpal,phalanx-proximal,phalanx-distal,tip}`
  - `{index,middle,ring,pinky}-finger-{metacarpal,phalanx-proximal,phalanx-intermediate,phalanx-distal,tip}`
  - three r161 `XRHandMeshModel` sets each bone's position and quaternion directly (**C**).
- **Retarget** (after One Euro smoothing on worldLandmarks):
  1. **Axes:** MediaPipe world coordinates are metres, hand-centred. In three.js use (x, −y, −z); negate x when the video is mirrored.
  2. **Joint map:**
     - wrist ← 0
     - thumb 1–4 → metacarpal / proximal / distal / tip
     - fingers: proximal ← MCP (5/9/13/17), intermediate ← PIP, distal ← DIP, tip ← TIP
     - metacarpal ← lerp(lm0, MCP, r), with r taken from the bind pose
  3. **Rotation**, using the WebXR convention (−Z along the bone, −Y out of the palm):
     - z = −normalize(child − joint)
     - palm normal n = normalize((lm5−lm0)×(lm17−lm0)), sign flipped for the left hand
     - y₀ = −n for the wrist, metacarpals and proximals; intermediate and distal joints use the parent's y (parallel transport)
     - thumb: use the plane of (0,1,2)
     - y = normalize(y₀ − (y₀·z)z), x = y×z → `makeBasis` → quaternion
     - wrist −Z points to the mean of 0/5/9/13/17
  4. **Positions:** straight from the landmarks (your real proportions).
  - **Fallback:** Kalidokit palm plane + 1-DOF flex (MIT).
- **Constant size:**
  - Draw the hand in an overlay pass (depth cleared), as a camera child at a fixed depth with a fixed scale.
  - Place it at the image wrist mapped through the video's `object-fit: cover` crop: s = max(W/vw, H/vh), px = x·vw·s − (vw·s−W)/2.
  - Test: <10% size change between 0.4 m and 0.8 m.
- Remove `ghostOffset`; draw a beam from the real fingertip to the cursor.

## 6. First-use tours
Each line: icon · verb-first instruction · ✓ success · [clip].
- 📷 Click Camera once; raise a hand. ✓ The hand appears. [engage]
- ☝ Point your index, curl three. ✓ The ring follows. [aim-sweep]
- 🤏 Aim, pinch your OTHER hand. ✓ The button lights. [click-other]
- ✊ Fist, move or twist; open to let go. ✓ The model follows. [grab-move, grab-twist, grab-push]
- 🖐 While fisted, raise or lower your other hand. ✓ The front edge tips. [tilt]
- 🤏🤏 Pinch both hands, then spread. ✓ The size changes. [scale]
- 👐 Spread open hands. ✓ The parts separate. [explode]
- 👏 Clap once. ✓ The view resets; 👎 brings it back. [clap]
- ✌ Hold ✌, aim, pinch. ✓ The tool opens. [wheel-pick, wheel-cancel]
- 👎 Hold thumbs-down. ✓ The last change is undone. [undo]
- 📏 Pinch at A, hold, release at B. ✓ The distance shows. [tape-drag]
- 🎚 Pinch-hold and slide. ✓ The value moves. [slider, scroll]
- 🔷 Aim to move the lens; pinch-hold up or down to resize. ✓ The radius changes. [lens]
- 🎠 Fist-drag to spin; aim + pinch to open. ✓ The project loads. [ring-spin]
- 📌 Wheel ↖ Pin. ✓ A fist no longer moves it. [pin]

**First-run walkthrough** (~2:40, on the first camera start). Each other feature waits for its own first use.
1. Engage, 20 s
2. Aim, 20 s
3. Click a big button, 20 s
4. Grab, 25 s
5. Scale, 20 s
6. Wheel open / pick / cancel, 30 s
7. Undo, 15 s
8. Rest, 10 s

**Stuck hints:** one at a time in the coach slot, each at most once per 20 s and 3 times per session, never during a tour.
- Existing: flicker, edge, lost.
- New:
  - On a target for 4 s with no click → "Pinch your other hand"
  - 2 missed same-hand pinches in 10 s → same hint
  - Fist blocked by the gap twice in 5 s → "Open briefly, then fist"
  - Clap blocked → "Pause, then clap"
  - Wheel abandoned twice → "Hold still"
  - Grab on a pinned item → "Unpin: wheel ↖"
  - No hands for 20 s → "Raise a hand"
  - Poor light or fps

**Clips to record** (landmark JSON, 2–5 s, right hand; to mirror, negate x and swap the label):
- engage, rest-lower, aim-sweep, click-other, thumb-tap
- grab-move, grab-twist, grab-push, tilt, scale, explode, clap
- wheel-pick, wheel-cancel, undo
- tape-drag, slider, scroll, lens, ring-spin, pin

## Open / verify
- Magnetism of 24 px and the 48 px target size: tune from sessionrec misses.
- Whether world-landmark orientation is camera-aligned: test with a synthetic hand rotated 90°.
- Whether Safari re-prompts for the camera.

## Sources
- Asset: https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0.20/
- Asset licence: https://raw.githubusercontent.com/immersive-web/webxr-input-profiles/main/packages/assets/LICENSE.md
- three.js XRHandMeshModel: https://unpkg.com/three@0.161.0/examples/jsm/webxr/XRHandMeshModel.js
- WebXR Hand Input: https://www.w3.org/TR/webxr-hand-input-1/
- MediaPipe hand landmarker (web): https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/web_js
- MediaPipe hands: https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/hands.md
- Kalidokit: https://github.com/yeemachine/kalidokit
- Microsoft interactable objects: https://learn.microsoft.com/en-us/windows/mixed-reality/design/interactable-object
- MDN browser-compat-data: https://unpkg.com/@mdn/browser-compat-data/data.json
- Remaining sources: `docs/team-log/reports/2026-10-01-ricky-gesture-feedback.md`

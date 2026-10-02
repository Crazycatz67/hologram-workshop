# Phase 1 input core: starting numbers (Ricky, 2026-10-02)

*Saved by the overseer from Ricky's hand-back; Ricky's runs have no write tool.*

## Question
What concrete starting values and formulas should the Phase 1 input core use, in this codebase's units?
That covers the finger-gun aim, One Euro + CD gain, hammer click, pinch/fist/voting, clap/done/swipe and
two-hand quaternion tilt.

Constraints: browser only, MediaPipe HandLandmarker at about 49–50 fps (owner probe), 1280×720 webcam,
no shoulder in view, free, no build step, three.js r161.

## Short answer
On a webcam with no shoulder, a "finger ray" collapses into position control. Ultraleap's production
ray is anchored at the shoulder for exactly this reason, and finger raycasting has high error rates
(Vogel 2005: 22.5%). So:
- Aim with the **index-knuckle position in metres**, through **one One Euro stage** and a **sigmoid
  speed gain**, kept absolute with offset recovery.
- Click with a **thumb hammer drop measured against the index metacarpal**; freeze the cursor and
  rewind it to the drop's onset.

Every threshold below is a starting value for calibrate v2 to fit. Most are unconfirmed on the owner's
hands.

## Units used here
- **palm** = world distance from wrist (0) to middle MCP (9). gunPose's `palmM` is about 7–10 cm.
  Ratios and angles come from `worldLandmarks`. Positions come from image landmarks.
- **s (metres per image unit)** = `palmM / gestures.palmLength(landmarks, aspect)`. Image units are
  aspect-corrected (in image heights). **Smooth s heavily** (EMA, τ≈1 s) and only ever multiply
  *differences* by it, never absolute positions. Otherwise depth noise turns into position noise
  (my own derivation).
- **MediaPipe, confirmed (hands.md):**
  - World landmarks are metres, origin at the hand's approximate geometric centre.
  - Image z uses the wrist as origin, "roughly the same scale as x".
  - Handedness labels assume a mirrored input image. `handTracker.js` feeds the raw, unmirrored webcam,
    so the labels are probably swapped (likely; verify on a clip).

## 1. Finger-gun aim (no shoulder)

**Findings**
- **Ultraleap `WristShoulderHandRay.cs`** (UnityPlugin develop branch, confirmed in source):
  - origin = `Lerp(wristOffset, shoulder, 0.532)`; direction = origin → *stable pinch position*;
  - `pinchWristOffset` = (0.0425, 0.0652, 0) m;
  - One Euro on both points: `minCutoff 5`, `beta 100`, freq 30, units are Unity metres;
  - shoulder = neck ±0.10 m; neck = head −0.10 m (`InferredBodyPositions.cs`).
  - So the ray is driven by position. Ultraleap's blog says a wrist-based ray "gets magnified over
    distance" (jitter).
- **Vogel & Balakrishnan, UIST'05:** finger RayCasting gave 22.5% errors vs 3.5% for Relative
  (confirmed earlier, primary).
- **Virtual pivot (derived, unconfirmed):** with a fixed pivot at distance Lp behind the hand and the
  screen at the camera plane, the cursor works out to `H·(1 + z_H/Lp) − const`. That is position
  control with a depth-dependent gain, so the pivot adds depth noise and nothing else. Drop it.

**Formula (recommended)**
- `A_img = landmarks[5]` (index MCP). The MCP is rigid with the palm. It captures wrist rotation
  (10° ≈ 1.5 cm at the MCP) and is the joint least dragged by the thumb's tendon coupling.
- `ΔA_m = ((ΔA.x·aspect), ΔA.y) · s̄`. Cursor mirroring: reuse the `pointer.js mapReach` conventions
  (x mirrored).

**Optional finger term (off by default)**
- `d = normalize(0.6·û(5→6) + 0.4·û(5→8))` in world coordinates.
- `yaw = atan2(d.x, −d.z)`, `pitch = atan2(−d.y, −d.z)` (MediaPipe z grows away from the camera).
- `Δpx = −K·(yaw − yaw0)` for x (because of the mirror), with weight ≤0.2 and its own filter
  (minCutoff 0.5 Hz).
- Why 5→6 dominates: FDP inserts on the distal phalanx, so thumb-tendon coupling bends the tip more
  than the proximal bone.
- Confidence: unconfirmed. A 4 cm bone with mm-level noise gives about 2–4° of jitter, which is about
  40–90 px at a useful gain.

## 2. One Euro + CD gain

**Filter**
- One stage on `A_m`: **minCutoff 1.0 Hz, beta 40 Hz per (m/s), dCutoff 1.0 Hz**.
- Calibration range: minCutoff 0.6–1.5, beta 20–80.
- Resulting cutoff: 1.8 Hz at 2 cm/s; 13 Hz at 0.3 m/s (lag about 12 ms).
- Comparison: the current pointer (`SMOOTHING.responsive`, beta 3 per NDC/s) is about 11 Hz per m/s.
  `smoothLandmarks` (BETA 25 per frame-unit/s) is about 26 Hz per m/s. Both assume a frame width of
  about 0.95 m at 60 cm (unconfirmed).
- Casiez's tuning procedure (confirmed, gery.casiez.net/1euro): set beta to 0, lower minCutoff until a
  still hand stops jittering, then raise beta in ×10 steps until fast moves stop lagging.
- **To make it truly single-stage:** have `smoothLandmarks.js` keep `hand.rawLandmarks` before it
  overwrites, and feed the pointer from those. Today the pointer filters already-filtered data.

**Gain**
- Sigmoid from Nancel et al. (secondary source, via the arXiv 2511.01826 summary):
  `G(v) = Gmin + (Gmax−Gmin)/(1+exp(−λ(v−Vinf)))`, in px per mm, with v in m/s from the filtered `A_m`.
- **Gmin 1.5, Gmax 6.0, Vinf 0.08, λ 40.**
- Simulated on minimum-jerk moves (25 cm):

  | Move time (s) | 0.5 | 0.8 | 1.2 | 2.0 | 4.0 |
  | --- | --- | --- | --- | --- | --- |
  | Cursor travel (px) | 1488 | 1475 | 1452 | 1380 | 1038 |

  Small moves: 2 cm in 0.4 s → 69 px; 5 mm in 0.3 s → 10 px.
- Scale both gains by `canvasWidth/1460`. Note: gun-lab recorded a 1710-px screen.

**Keeping it absolute (owner's 2026-10-01 decision)**
- `abs = centre + (A_m − A0_m)·5.84 px/mm`, where A0 is the calibrated centre.
- `offset = cursor − abs`.
- When v > 0.15 m/s and the hand is moving toward abs, add `min(|offset|, 0.5·|Δcursor|)` toward abs.
  This is PRISM's offset recovery (Frees 2007, from memory; the primary was blocked).
- Edge clamps also update the offset.

## 3. Hammer-drop click

**Feature (world landmarks)**
- `θh = angle(2→4, 0→5)`. The metacarpal is rigid, unlike the 5→6 bone that `gunPose.thumbAngleDeg`
  uses now.
- Plus the existing `thumbGap`.

**Thresholds (starting values, unconfirmed)**
- Cocked: θh > 50° **or** gap > 0.50.
- Dropped: θh < 30° **and** gap < 0.30.
- No real thumb data exists yet (`docs/testing/runs/gun-lab` holds self-tests only).
- Calibrate as cock = p20 of cocked-hold frames and drop = p80 of dropped frames. Warn if the two are
  less than 15° / 0.15 apart.

**Timing**
- The thumb must be cocked for ≥100 ms first (today 120 ms).
- Leaving the cock band → entering the drop band must take ≤300 ms.
- The click fires on entering the drop band.
- Re-arm after re-cocking for ≥100 ms. Refractory 250 ms (existing).
- 3-frame median on θh (+20 ms).

**Onset and rewind**
- `t_on` = the earlier of the last frame above cock and the first frame where `dθh/dt < −150°/s`.
- Rewind to `t_on − 1 frame`, capped at 200 ms. Expect about 80–150 ms, which matches the plan's 120 ms.
- Freeze the cursor output from `t_on`. On abort (300 ms), ease back over 100 ms.
- Why: the owner's probe saw a 13–25 px palm shift per thumb drop (max 48) at about 2.75 px/mm, i.e.
  about 5–9 mm of hand motion. Rewinding/freezing removes that (approach per Wolf CHI'20 and Vogel'05).

## 4. Pinch, fist, voting

**Pinch**
- `r = |w4 − w8| / palm`. Enter **<0.20**, exit **>0.30**, minimum 40 ms (2 frames) in state.
- Supporting numbers:
  - MRTK3 defaults are closed 0.25 / open 0.75 *index-finger lengths* (confirmed,
    `MRTKHandsAggregatorConfig.asset`); 0.25 index lengths ≈ 0.2 palm (estimate).
  - Meta "Touching" is about 1.5 cm, roughly 0.17 palm (confirmed, Meta docs).
  - Ultraleap uses 0.8/0.7 strength hysteresis (confirmed earlier, from memory).

**Fist**
- Per-finger PIP bend (exists in `gunFeatures`). Closed: enter ≥60°, exit ≤45°.
- Owner's hand: open 21–22°; curled others 66–81°; fist index 97–109°.
- Fist = all four fingers closed (the index separates it from the pointer) **and** thumbGap < 0.6
  (rejects thumbs-up; unconfirmed).
- Meta curl defaults, from a search snippet only (likely): 195/185 and 210/200, with 22 ms minimum time
  in state.

**Voting (poses only)**
- 120 ms window (6 frames at 50 fps): enter at ≥2/3 of frames, exit at ≤1/3.
- Never vote on click edges: rewind handles them.

## 5. Clap, Done, swipe

**Clap (no speed floor, unconfirmed)**
- Arm when span ≥2.0 palms in the last 1.2 s.
- Fire when span ≤1.2 **or** the existing merge rule triggers (`CLAP_MERGE_*`).
- Both hands not pinching/fisting (existing 100 ms glitch rule).
- **Palms facing:** dot(n_L, n_R) < −0.5 and |n.x| > 0.6. This replaces `CLAP_MIN_CLOSING_SPEED` 8.0.
- The arbiter blocks it during explode/assemble.
- Measured context: explode spreads at 14–18 palms/s; clap jitter ≤1.1 palms.

**Done**
- Open palm facing the camera: dot(n, toCamera) > 0.55 (Ultraleap `facingCamMinDotProd`, confirmed).
- All PIP bends <35°, one hand only.
- Stillness: <0.10 palm of displacement and peak speed <0.4 palm/s over 600 ms (reuse holdGate's 650 ms
  ring).
- Speed separates it from swipe and explode.

**Swipe**
- ≥2.0 palms horizontal within ≤400 ms, peak ≥6 palms/s (about 0.5 m/s), |dx| ≥ 2|dy|, open hand.
- 500 ms cooldown; ignore the opposite direction for 600 ms (the return stroke).
- References:
  - Leap v2: MinLength 150 mm, MinVelocity 1000 mm/s (search result citing Leap docs, likely).
  - Kinect Toolbox: length 0.4 m, max height 0.2 m, ≥250 ms (secondary snippet).

## 6. Two-hand quaternion tilt

**Frame**
- `ŷ = norm(mean(5,9,13,17) − 0)`, `x' = 5 − 17`, `n̂ = norm(x' × ŷ)`, `x̂ = ŷ × n̂`.
- Basis `[x̂ ŷ n̂]` → `Matrix4.makeBasis` → quaternion.
- World landmarks only, from the rigid palm points.

**Control**
- Per hand: `Δq_h = q_h·q_h0⁻¹`. Fix the hemisphere sign, then `Δq = slerp(Δq_L, Δq_R, 0.5)`.
- Because `R·R0ᵀ` does not depend on the hand-local basis, handedness labels don't matter. Identify
  hands by image x if needed.
- Mapping to three.js with the mirrored display: the y/z flip (`diag(1,−1,−1)`) times the x mirror
  equals `−I`. Rotation axes are pseudovectors, so the quaternion components carry over unchanged (my
  own maths). **Add a synthetic test.**

**Smoothing:** slerp with `α = 1 − exp(−2π·fc·dt)`, `fc = 1.0 + 2.0·ω` Hz, where ω is angular speed in
rad/s.

**Dead-zone:** soft 4° (subtract 4° from the angle, keep the axis). Set it to 2× the measured p90 jitter
of a still hand once that is measured.

**Gain:** 1.75 × angle into the existing `easeTilt` ±75° limit.
- Ryu 1991: daily-living wrist motion is about ±40° flexion/extension and 40° of combined deviation
  (likely, from the abstract).
- Optionally drop twist about the view axis (swing-twist), since spin is its own channel.
- *(Overseer note: the owner chose **1.5×** and a soft ~80° pitch limit on 2026-10-02. Use 1.5, tunable.)*

## Options
| Option | Fits | Effort | Risk |
| --- | --- | --- | --- |
| A. MCP position + 1€ + sigmoid gain + offset recovery (recommended) | yes | M | the gain curve needs owner tuning |
| B. A + finger yaw/pitch term | yes | M | jitter ×K; Vogel's error rate |
| C. Pure finger ray / virtual pivot | yes | S | high error rate, depth-coupled gain |

## Recommendation
Option A, with the hammer click, the 3D pinch/fist and the relative-quaternion tilt as specified.

What would change it: replays of the owner's clips showing MCP rest jitter above about 1 mm, or offset
recovery that feels like drift. In that case, fall back to the absolute mapping at 5.84 px/mm.

## Open questions
- Real thumb θh/gap distributions: none recorded yet.
- World-palm angular jitter.
- MacBook webcam field of view.
- Whether MediaPipe world scale is per-person or normalised to an average hand.
- Swapped handedness labels on unmirrored input.
- Owner sign-off: speed gain vs. pure absolute.

## Sources
- Ultraleap `WristShoulderHandRay.cs` / `InferredBodyPositions.cs` / `EulerAngleDeadzone.cs`:
  https://github.com/ultraleap/UnityPlugin/tree/develop/Packages/Tracking%20Preview/HandRays (develop
  branch, read 2026-10-02)
- Ultraleap far-field ray blog: https://docs.ultraleap.com/ultralab/far-field-ray-blog.html
- 1€ filter: https://gery.casiez.net/1euro/
- MRTK3 pinch defaults: https://github.com/MixedRealityToolkit/MixedRealityToolkit-Unity
- Meta pose detection: https://developers.meta.com/horizon/documentation/unity/unity-isdk-hand-pose-detection/
- MediaPipe hands: https://github.com/google-ai-edge/mediapipe/blob/master/docs/solutions/hands.md
- Sigmoid gain (secondary): https://arxiv.org/html/2511.01826
- Nancel TOCHI'15: https://inria.hal.science/hal-01184544 (blocked)
- Leap swipe: https://developer-archive.leapmotion.com/documentation/v2/python/api/Leap.SwipeGesture.html
- Kinect swipe: https://www.eternalcoding.com/gestures-and-tools-for-kinect/
- Ryu 1991: https://pure.johnshopkins.edu/en/publications/functional-ranges-of-motion-of-the-wrist-joint/
- Vogel'05, Wolf CHI'20, PRISM: from Ricky's memory, verified 2026-09-30.

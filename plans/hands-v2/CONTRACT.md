# Hands v2 — input core contract (Phase 1)

Owner: overseer. Builders follow this; numbers marked `[R]` come from Ricky's
`docs/team-log/reports/2026-10-02-ricky-input-params.md` and are tuned on the owner's clips
(`assets/gesture-clips/*-t<k>.json`, Phase 0). Everything ships behind a switch:
`?hands=v2` or `localStorage['hands.v2']='1'`. With the switch off, the old pipeline runs
unchanged, so test.html, the labs and the games stay green while v2 is built. When v2 passes the gate,
the switch defaults on and the old path is deleted one round later.

## 0. Pipeline (per camera frame)

```
tracker.read → [v2: NO landmark One Euro on the cursor path; light filter only for the drawn hand]
  → handFeatures.update(hands, t, profile)   // hand.f = features + voted pose (§1)
  → legacy annotateHand(hand) derived from hand.f   // back-compat fields (§1.4)
  → inputArbiter.update(hands, t)            // who owns the hands this frame (§2)
  → consumers get ONLY what the arbiter routes them:
       pointer.update(route.pointer)   manipulator.update(route.manip)   wheel.feed(route.wheel)
       events (clap / done / undo / swipe) → host + manipulator
```

`handsRuntime.processFrame` (`handsRuntime.js:527-560`) is the only place that changes in the
runtime: it calls the arbiter and passes `route.*` instead of `hands` to each consumer.
`injectFrame` and `replay.js` go through the same function, so the labs measure exactly what ships.

## 1. `handFeatures.js` (new, pure, no three.js import)

### 1.1 API
```
createHandFeatures({ profile? }) -> hf
hf.update(hands, tMs) -> hands      // sets hand.f on each hand; keeps per-hand history by id
hf.setProfile(profile)              // from calibration v2 (§4)
hf.reset()
```
A hand's id is its MediaPipe handedness. If both hands report the same label, the nearest
previous wrist wins. The history survives up to `LOST_GRACE_MS` [R ≈150] of dropout.

### 1.2 `hand.f`
```
{
  sizeM,            // palm length in metres: |world[0]-world[9]|, median of the last 30 frames
  palmPx,           // 2D palm length (aspect-corrected), for screen-space gains
  frame: { q: [x,y,z,w], normal: [x,y,z], facing },   // palm frame from world 0,5,17; facing = dot(normal, toCamera)
  curl:  { thumb, index, middle, ring, pinky },       // degrees, sum of PIP+DIP flexion (3D)
  pinch: { ratio, on, strength },                     // ratio = |w4-w8| / sizeM; on uses hysteresis [R on≈0.30 off≈0.45] + ≥40 ms hold
  hammer:{ angleDeg, state: 'cocked'|'dropped'|'unknown', dropT },  // thumb vs index metacarpal, 3D
  aim:   { dir: [x,y,z], origin: [x,y], ok },         // finger-gun ray (§3.1); ok=false when the index is bent
  vel:   { wrist: [vx,vy] /s in palm units, speed },  // from RAW image landmarks (clap/swipe need speed, not smoothing)
  pose:  { label, conf, stableMs },                   // voted (§1.3)
  mp:    { gesture, score }                           // MediaPipe label: a hint only, never a veto
}
```

### 1.3 Pose voting
Labels: `fist | open | gun | point | pinch | victory | thumbDown | none`.
- Per frame, classify from `curl` + `pinch` + `hammer` + `facing` (rules in Ricky's report).
  The MediaPipe label adds +1 vote when it agrees and nothing when it disagrees.
- `pose.label` = the majority of the last `VOTE_N` [R 5–8] frames, with a separate enter/exit:
  entering needs `ENTER_VOTES`, leaving needs `EXIT_VOTES` (sticky). `stableMs` = time since the label changed.
- `gun` = index straight + middle/ring/pinky curled, regardless of the thumb (the thumb is the trigger).

### 1.4 Back-compat (`gestures.js` stays the import point)
In v2, `annotateHand` fills the legacy fields from `hand.f`:
- `hand.pointer.gun` comes from `pose.label === 'gun'`.
- `hand.pinch.pinching` comes from `pinch.on`, and `hand.pinch.ratio` from `pinch.ratio`.
- `hand.fistLike` comes from `pose.label === 'fist'`.

That means games, `platform/hands.js`, `ring.js` and `playground.js` work unchanged on day one.

## 2. `inputArbiter.js` (new): one owner at a time

### 2.1 States
```
IDLE ─gun stable ≥ AIM_ENTER_MS──▶ AIM       (pointer + hammer click; other hand free for nothing but ✌/events)
IDLE ─fist stable ≥ GRAB_ENTER_MS─▶ MANIP    (grab; + 2nd hand: tilt / scale / explode / assemble)
IDLE ─two open hands spreading────▶ MANIP(explode)
IDLE ─✌ held (holdGate) ─────────▶ TOOL      (wheel; wheel owns aim + click until it closes)
any  ─hands lost > LOST_GRACE_MS──▶ IDLE
owner releases only when its pose has been gone for RELEASE_MS [R ≈150]; it can't be stolen
mid-gesture (replaces neutral gap / SWITCH_AWAY / post-pointer gap in manipulator.js)
```

### 2.2 Events (instant, only from the states listed)
| event | detector | allowed in | effect |
|---|---|---|---|
| `click` | hammer drop on the AIM hand (§3.2) | AIM | host click at the **rewound** aim |
| `clap` | §3.4 | IDLE, MANIP(explode) | IDLE: reset view · explode: snap to **original** model |
| `done` | ONE open palm, facing camera, wrist speed < `STILL` for `DONE_MS` [≈600], other hand absent/down | IDLE, AIM, any scoped tool | leave the scoped tool / close the wheel / snap upright |
| `undo` | thumbDown held `UNDO_MS` [≈500] | IDLE | host undo (multi-step) |
| `swipe` | open hand, speed > `SWIPE_V` over ≥ `SWIPE_D`, then cooldown | scope `ring` (and games that opt in) | ring scroll / versions |

### 2.3 Scopes
`arbiter.setScope(name, { allow: [...] })` is called by the host when a tool turns on (`tape`,
`polygon`, `ring`, `game:<id>`, `default`). A gesture that isn't in `allow` is never routed.
Examples:
- `tape`: AIM + click + done + undo, **no MANIP** (the model is frozen).
- `ring`: swipe + AIM + click + done.

### 2.4 Feedback contract
`arbiter.state = { owner, scope, pose per hand, arming: { gesture, progress 0..1 } }`. Every
frame it's emitted as a `'intent'` event. The host draws the hand-outline colour and the chip
from it, and the Done ring from `arming`.

## 3. Behaviours

### 3.1 Cursor (pointer.js, v2 path)
**Owner 2026-10-02 (overrides the bullets below where they differ):**
- Aim = **index-knuckle (landmark 5) position** in metres, plus a **finger-direction nudge, weight ≈0.2**, with its own filter at minCutoff 0.5 Hz.
- Crosshair + scope line drawn from the fingertip to the target.
- **Speed gain + re-centring** (sigmoid Gmin 1.5 / Gmax 6.0 px/mm, Vinf 0.08 m/s, λ 40, scaled by canvasWidth/1460; PRISM offset recovery) replaces the 2026-10-01 strict absolute rule.
- One One Euro: minCutoff 1.0 Hz, beta 40 /(m/s), dCutoff 1.0, on raw (pre-smoothLandmarks) points.
- See Ricky's report §1–3.
- Aim source: the finger-gun ray (index MCP→tip blended toward wrist→index MCP, world → screen via
  the image landmarks of the MCP), `[R]` blend weight.
- Filtering: exactly **one** One Euro stage on the aim output, `[R]` (mincutoff, beta, dcutoff).
- Gain: speed-based CD gain, `gain(v) = lerp(G_LOW, G_HIGH, smoothstep(V_LOW, V_HIGH, v))` `[R]`.
  It's relative motion on top of an absolute anchor that re-centres slowly, so the cursor never drifts off the hand.
- No STICKY freeze and no pinch freeze. During a hammer drop, the click uses the rewind buffer (§3.2), not a freeze.
- Engage: any `gun` pose in the frame engages. The old wrist-y engage line only applies in IDLE.

### 3.2 Hammer click
`cocked` (thumb angle > `COCK_DEG` for ≥ 80 ms) → `dropped` (angle < `DROP_DEG` within
`DROP_WINDOW_MS`). The click fires at the drop and lands at the aim from `REWIND_MS` [R 100–150]
**before the cock→drop transition started**. Refractory 250 ms. The thumb must re-cock before the next click.
Off-hand pinch and hold-to-select stay in pointer.js behind settings `hands.clickAlt = 'pinch'|'hold'|null` (default null).

### 3.3 Two-hand manipulation (manipulator.js)
- **Tilt**: on the 2nd hand engaging (open), store `q0 = frame.q`. Each frame, `Δ = q · q0⁻¹`, mirrored for
  handedness. Apply `slerp(identity, Δ, 1)` raised to the gain **1.5** (axis-angle × 1.5), with a dead-zone
  `[R ≈3°]` and no gain below `[R ≈8°]`. The object's rotation = `rotAtGrab · boosted Δ` (absolute, never
  accumulated). Pitch clamp ±80° (soft); yaw/roll free.
  - **Ratchet**: the 2nd hand closing → re-baseline (`rotAtGrab` = current, `q0` = next open frame).
  - **Flick**: on release, if the angular velocity over the last 100 ms is above `[R]`, coast with the existing
    momentum damping (`DAMPING_HALFLIFE`). Any grab stops it.
- **Scale**: horizontal spread = uniform. Vertical spread = Y-only stretch (`object.scale.y`), with a height
  readout. Split by the angle of the hand-to-hand vector (|angle from horizontal| > 55° = vertical, sticky
  for the whole gesture).
- **Explode / assemble**: `explode = f(span / span0)` both ways for the whole time the state is EXPLODE, with no
  "pulled" flag. A slow close down to `span0` gives explode 0 with part edits kept. Clap during explode
  restores the original part transforms (snapshot taken at the first explode). Both push undo entries.
- **Grab**: `pose.label === 'fist'`. Move uses dx **and** dy everywhere (including the Platform).

### 3.4 Clap
Arm when both hands are present with span > `ARM_SPAN` [R ≈2 palms]. Fire when span < `CONTACT_SPAN` [R ≈1 palm]
**or** (one hand lost within 150 ms of span < 1.6 palms), with closing speed > `CLAP_V_MIN` [R, low:
slow claps must pass], measured on RAW wrists. Survives ≤2 dropped frames. Cooldown 600 ms. A pinch misread
doesn't disarm it.

## 4. Calibration v2 (calibrate.js)
1. **Hand**: open hand 2 s, giving `sizeM`, finger lengths, `palmPx` at a comfortable distance, fps and light.
2. **Reach**: a relaxed sweep (elbow may rest), giving the anchor box and `V_HIGH`.
3. **Drills**: 10 hammer clicks on targets + 5 pinches + 3 claps + 3 fists. Fit
   `COCK_DEG/DROP_DEG` (midpoint of the measured cocked/dropped distributions), pinch on/off (each person's
   closed/open ratio), `G_LOW` (from overshoot) and `CLAP_V_MIN` (from their slowest clap × 0.6).
   Show "before → after" hit rate.
4. Profile `hands.profile.v2` = `{ sizeM, reach, thresholds{...}, gains{...}, at }`. "Quick tune-up" = step 3 only.

## 5. Acceptance gate (Phase 1)
- test.html, gesture/gun/holdgate/smoothing labs: green on the v1 path (unchanged) **and** on the v2 path
  (v2 expectations may differ; differences are listed).
- (Owner 2026-10-02: owner clips are recorded only at the END of Hands v2, so until then the gate uses the synthetic + semi-real replay sets and live owner checks; the owner clip set becomes the final tuning/acceptance pass.)
- replay.js with v2 (synthetic + semi-real now; owner clips at the end): per gesture ≥ 95% recall, ≤ 2% false fires, `null-*` clips
  fire nothing, confusion ≤ 5% between any pair.
- Cursor: smoothing-lab latency at slow speed ≤ 40 ms (today ≈65–130 ms); jitter at rest ≤ 1 px median.
- An owner live check (≤10 min script from Timmy).

## 6. File ownership (Phase 1 build)
| Owner | Files |
|---|---|
| Cody-F | `handFeatures.js` (new), `gestures.js` (v2 wrapper), `handFeatures-test` cases in `test.js` |
| Cody-A | `inputArbiter.js` (new), `handsRuntime.js` (processFrame routing only) |
| Cody-P | `pointer.js` (v2 cursor + hammer click), `gunPose.js` |
| Debbie | `manipulator.js` (tilt / scale / explode / clap per §3.3–3.4), then a break-it pass on everything |
| Cody-C | `calibrate.js` v2 |
| Timmy | runs the gate; labs updated for v2 by their owners above |

Order: Cody-F first (everything reads `hand.f`), then Cody-A ∥ Cody-P ∥ Debbie in parallel, then Cody-C.

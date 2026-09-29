# Track C — Neurotech Bionic Arm — Roadmap

**Vision:** the Neurotechnology Exploration Club's bionic arm, plus the places where this project's existing work can plug into it: webcam hand tracking as a way to control the arm, and the hologram renderer as a live 3D "digital twin" of the arm.

**Relationship to Track A:** C *borrows* from A but doesn't depend on it, and A never depends on C. The arm itself (hardware, electronics, firmware) is a separate engineering project. Its browser-side tools live in `neurotech/`, its assets in `assets/arm/`, and it follows the isolation rules in the root [`ROADMAP.md`](../../ROADMAP.md).

> **Status: scaffold.** Most of the arm's basics haven't been discussed yet (see "Parameters to confirm"). Everything below marked *assumed* or *proposed* is a placeholder to confirm or correct, not a decision.

## Revision History

- **2026-09-29:** Track created. Structure, likely integration points with Tracks A/B, constraints that differ from A, and a list of basics to confirm. No decisions yet on hardware, control method or scope.

## Parameters to Confirm First

These decide almost everything else, so they come before any phase work:

| Question | Why it matters |
| --- | --- |
| **Your role in the club and on the arm:** lead, one of a team, or your own sub-part? | Decides what this plan should cover vs. what belongs to the club |
| **How is the arm controlled?** *Assumed:* muscle signals (EMG sensor on the forearm). Alternatives: EEG, webcam hand tracking, buttons | EMG vs. EEG vs. vision are completely different signal pipelines |
| **What hardware exists or is planned?** (microcontroller e.g. Arduino/ESP32, sensor e.g. MyoWare, servos, 3D-printed hand e.g. InMoov/e-NABLE-style) | Sets what the browser tools talk to, and the cost |
| **Who pays for hardware?** Club budget vs. personal | Track A has a *no purchased hardware* rule. C needs its own rule |
| **What does "done" look like?** A demo at a club event? A competition? A portfolio piece? Dates? | Sets scope and phase order |
| **Is the hologram part wanted,** or is this track mainly to keep the arm's planning organised alongside this project? | Decides whether Phases C3–C4 exist at all |

## Parameters That Differ From Track A (proposed)

- **Hardware is allowed in this track.** An arm can't be built without it. Track A's no-purchase rule stays in force for A. C records each purchase decision here (what, cost, who pays).
- **Not everything is browser-only.** Arm firmware (Arduino C++/MicroPython) can't run in a browser. *Proposed:* browser tools stay no-build-step like A and talk to the arm over **Web Serial** (a Chrome built-in, no install, works on GitHub Pages because it's a secure context). Firmware lives in **its own repo** once code starts, since it isn't a web page and doesn't belong on this Pages site.
- **Safety rules apply that A never needed.** For anything with electrodes on skin (EMG/EEG), the body-connected electronics run **on battery power only**, never from a laptop that's plugged into the wall and never from a mains supply. Servos get their own supply, not the microcontroller's 5 V pin. Confirm the club's own safety guidance and follow it where it's stricter.

## Where Tracks A/B Plug In (candidate integration points)

| Idea | What's reused | Effort |
| --- | --- | --- |
| **Mirror-your-hand control:** the arm copies your real hand, seen by the webcam | `handTracker.js` + `smoothLandmarks.js` + `gestures.js` already give finger positions (e.g. `fingerReach`) at ~30 fps. Map finger curl → servo angles → Web Serial | Low–medium. The strongest, cheapest link |
| **Holographic digital twin:** a hologram of the arm that moves with the real one | Scan the arm with Scaniverse (Track A's pipeline), split it into finger parts (Track A's grouped-OBJ / multi-part idea), and drive each part's rotation from servo or sensor data | Medium |
| **Signal visualiser:** live EMG waveform and detected grip type shown in the holographic UI | `scene.js`, `HolographicMaterial.js`, the overlay canvas | Low |
| **Grip classification from muscle signals** | ASL project's `knn.js` pattern: record labelled samples, classify new ones. Ruled out for A because A's gestures are geometric, but a real fit for EMG patterns (fist / pinch / open / point) | Medium. Also a nice story linking all three projects |

## Phases (proposed, to be reordered once the parameters above are confirmed)

### Phase C0 — Pin Down the Arm
Fill in "Parameters to Confirm" above: control method, hardware list, who owns what, the target date, and whether the hologram side is wanted. **Done looks like:** that table has answers, and this roadmap is revised to match.

### Phase C1 — Webcam → Arm (no body sensors needed)
`neurotech/teleop.html`: webcam hand tracking → per-finger curl values → Web Serial → servos. It reuses Track A's tracker unchanged (imported, not copied). This is the safest first milestone because nothing touches skin, and it proves the whole chain (browser → serial → firmware → servo). **Done looks like:** closing your real hand closes the arm's hand, with visible latency measured and written down.

### Phase C2 — Body Signals (EMG, if that's the control method)
Stream sensor readings over Web Serial into a live plot, then record labelled samples and classify grip types (kNN first, as in ASL). **Done looks like:** 3–4 grips recognised reliably from the forearm sensor, measured as accuracy on held-out samples rather than eyeballed.

### Phase C3 — Holographic Digital Twin (if wanted)
Scan the arm, split it into parts, and render it as a hologram whose fingers follow the live servo or sensor state.

### Phase C4 — Showcase Integration (if wanted)
One page that shows your hand → the arm moving → its hologram twin moving in sync, the full "three projects, one pipeline" demo.

## Out of Scope (for now)

- Invasive or medical-grade anything. Surface sensors only, and it's a club/educational build, not a medical device.
- Pushing arm code into the root-level Track A files, or adding arm modes to `hologram.html` (isolation rules 2–3).
- EEG, unless C0 says that's the actual plan. It's much harder than EMG for controlling individual fingers.

## Next Concrete Action

1. **You:** answer the "Parameters to Confirm First" table (a quick chat is enough, and it gets written in here).
2. Based on the answers, reorder or trim phases C1–C4 and decide whether firmware gets its own repo now.

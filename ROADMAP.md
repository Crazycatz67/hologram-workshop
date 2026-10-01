# Hologram Project — Master Roadmap (Track Index)

This file is the **index**, not a plan. Each track has its own roadmap, Next Concrete Action and open questions. Read this first, then only the track you're working on.

## Revision History

- **2026-09-30 (2):** **Gesture scheme decided; P5 built.** The owner chose the Engage → Aim → Act scheme (neutral gap between different gestures, clap only from rest and undoable, click a part to select once exploded); BUGS #26-#29 fixed. Platform P5 (show what was filled in) is built. A hold-to-confirm gate and a finger-gun probe exist as lab pages but are not wired into the live gestures. Live webcam confirmation of the new scheme is still pending. Details in `plans/platform/ROADMAP.md`.
- **2026-09-30:** **Track B moved from research to built.** B0 (benchmark) is done; B1 (classical completion) ships for objects and, via `plane_extend`, for room planes; the B3 TripoSR spike is done. `complete.py --mode auto` picks the room or object pipeline. Free ground truths are in `assets/benchmark/` (git-ignored). Limits: thin shells and big thick furniture still fail, and the room numbers come from a perfectly planar synthetic room. Details and numbers in `plans/scan-completion/ROADMAP.md` (revision 2026-09-30 (5)).
- **2026-09-29 (2):** **Re-focused around an architectural hologram platform.** The owner clarified that the project was always meant for interacting with objects in general, and the chair was only a test asset. Two main-focus tracks:
  - **Hologram Platform:** upload any room or object scan → hologram, universal controls with no hand-made parts, per-object colours, room decor.
  - **Scan Completion:** a free, Mac-runnable algorithm that fills in what the scanner missed, always marked as inferred. Backed by a research pass recorded in `plans/scan-completion/RESEARCH.md`.

  The short-lived Room track is merged into the Platform. The original object plan is kept as **v1 history**. The bionic arm is parked.
- **2026-09-29:** First split into tracks (object / room / bionic arm) with isolation rules. Superseded by the entry above the same day, but the isolation rules carry over.

## The Tracks

| Track | What it is | Plan | Status |
| --- | --- | --- | --- |
| **A — Hologram Platform** ★ | The website. Upload any LiDAR scan (room or object) → hologram → universal gesture + mouse controls → automatic object/part segmentation → per-object colours → room decor (move, hide/restore, snap, measure) | [`plans/platform/ROADMAP.md`](plans/platform/ROADMAP.md) | Planned. Built on the live v1 engine |
| **B — Scan Completion** ★ | The fill-in-the-blanks algorithm: undersides, backs, holes, noise. Free, runs on a MacBook Air M5, inferred parts always marked | [`plans/scan-completion/ROADMAP.md`](plans/scan-completion/ROADMAP.md) + [`RESEARCH.md`](plans/scan-completion/RESEARCH.md) | **B0 done. B1 shipped** for objects and room planes. B3 TripoSR spike done. Limits: thin shells, big thick furniture |
| **C — Neurotech Bionic Arm** | The Neurotechnology Exploration Club's arm, and its hand-tracking / hologram tie-ins | [`plans/neurotech-arm/ROADMAP.md`](plans/neurotech-arm/ROADMAP.md) | **Parked.** Basics still to confirm |
| *v1 history* | What's already built: one scanned object (chair, chess) → hologram → gestures, measurement, per-part explode | [`plans/object-hologram/ROADMAP.md`](plans/object-hologram/ROADMAP.md) | Live on GitHub Pages. Open items continue as Platform maintenance |

**How they fit together:**

```
  v1 engine (live: shader, gestures, measure, per-part explode, clean_scan.py)
        │  reused by import
        ▼
  A  Hologram Platform  ◄───────  B  Scan Completion
     (browser: upload,            (offline Python on the Mac:
      segment, control,             fills gaps → GLB with
      colour, decorate)             scanned / inferred parts)

  C  Bionic Arm (parked) ── borrows the hand tracker / hologram renderer only
```

B produces files, A displays and interacts with them. Their only coupling is the **output contract** in B's roadmap: `scanned` / `inferred` materials per object plus a JSON sidecar.

## Isolation Rules

1. **One track per session, named up front.** Update only that track's roadmap, Revision History and Next Concrete Action. Cross-track findings go in "Cross-track notes" below.
2. **The live v1 pages keep working.** Root-level JS/HTML files and their URLs (`hologram.html`, `index.html`, `hands.html`) are not moved or renamed. Platform code lives in `platform/` until it *deliberately* replaces the main page. Completion code lives in `completion/`, and arm code in `neurotech/`.
3. **Shared modules are read-only by default.** New code imports the v1 modules. If one needs to behave differently, add an option whose default is today's behaviour, or copy the function into the track's folder.
4. **`test.html` is the contract.** Any commit touching a shared root file leaves it at 0 failures (`hologram-verify`). New tracks add their own tests (`platform/test.html`, `completion/benchmark.py`).
5. **Constraints are per track.** Platform: browser-only, no build step, free, processing stays in the visitor's browser. Completion: offline Python, free only, Mac first, licences tracked. Arm: hardware allowed, recorded in its plan. No exception spreads to another track.
6. **Bugs are tagged** `[A]`, `[B]` or `[C]` in `BUGS.md`. Items #1–7 predate the split and are `[A-v1]`.
7. **Big assets are checked before committing.** GitHub rejects files over 100 MB. User uploads never touch the repo, and demo scans are decimated/compressed first.

## Priority

**A and B are the joint main focus.** Suggested order, since each step unblocks the next:
1. ~~B0 (the completion benchmark)~~ done; A-P0 (upload any scan) is independent of B.
2. A-P1/P2 (controls, segmentation) alongside the B1 follow-ups (thin shells, big furniture, real-scan room test).
3. A-P5 shows B's output.

v1 maintenance (chess captures, live confirmations of the new Engage → Aim → Act gesture scheme on a real webcam) continues when convenient. C is parked until its basics are answered.

## Cross-track Notes

- **Hiding furniture (A-P4) exposes holes** in the floor and walls behind it, which is exactly what B's plane completion fills. P4 and B1 should be demoed together.
- **The v1 chess lesson applies to both tracks:** splitting one dense scan into many small objects fragments badly (33 pieces → 376 fragments), while large single objects work. Platform segmentation leaves clutter as part of the room shell, and Completion doesn't fill clutter in v1.
- **The three.js version is a shared decision.** r161 today. Upgrading (A-P6) unlocks RoomPlan USDZ and Gaussian splats but must pass `test.html`.
- **The ASL project's `knn.js`** may be reused for grip classification in C (see its plan).

## Open Questions (Project-Level)

- **Does the Platform replace `hologram.html` at the main URL once it's ready,** or live beside it?
- **Does C's firmware get its own repo** when it un-parks? (Recommended: yes.)

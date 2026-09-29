# Hologram Project — Master Roadmap (Track Index)

This file is the **index**, not a plan. Each track has its own roadmap, its own Next Concrete Action and its own open questions. Read this file first, then only the track you are working on.

## Revision History

- **2026-09-29:** **Project split into three tracks.** Two big new directions were added: scanning and interacting with an entire room (Track B), and the Neurotechnology Exploration Club's bionic arm (Track C). The original plan (one scanned object, e.g. the chair and the chess set) became Track A and moved, unchanged, to `plans/object-hologram/ROADMAP.md`. The goal of the split is that the new work can't quietly break or reshape the object hologram, which is live on GitHub Pages and has a 37-check regression suite behind it. The isolation rules below spell out how.

## The Three Tracks

| Track | What it is | Plan | Status |
| --- | --- | --- | --- |
| **A — Object Hologram** | Scan one real object (chair, chess set), render it as a hologram, manipulate it with webcam hand gestures. The original project. | [`plans/object-hologram/ROADMAP.md`](plans/object-hologram/ROADMAP.md) | Live. Phases 0–4 built; chess multi-part scans pending (blocked on capture) |
| **B — Room Hologram** | Scan a whole room, turn it into a hologram, and interact with *every object in it* the way the chair works today: pick any piece of furniture out of the room, move, rotate, measure, put it back. | [`plans/room-hologram/ROADMAP.md`](plans/room-hologram/ROADMAP.md) | New, planning only. No code yet |
| **C — Neurotech Bionic Arm** | The Neurotechnology Exploration Club's bionic arm project, and where it connects to this project's hand tracking and hologram rendering. | [`plans/neurotech-arm/ROADMAP.md`](plans/neurotech-arm/ROADMAP.md) | New, planning only. Several basics still to be confirmed with you |

**How the tracks relate.** B builds *on top of* A: a room is a scene full of objects, and each object reuses A's pipeline (cleanup, hologram shader, gestures, measurement, per-part selection). C *borrows from* A without depending on it: the webcam hand tracker and the hologram renderer are both useful to an arm project, but the arm itself is hardware and firmware that A knows nothing about. A never depends on B or C.

```
        Track A (object)  ── stable base, live site, test suite
          ▲         ▲
   builds │         │ borrows hand tracking / hologram rendering
     on   │         │
   Track B (room)   Track C (bionic arm)
```

## Isolation Rules — How New Work Stays Out of Track A's Way

These rules are the point of the reorganisation. They apply to every session.

1. **One track per session, named up front.** Say which track a session is on at the start. Update only that track's roadmap, its Revision History and its Next Concrete Action. Cross-track findings go in this file's "Cross-track notes" section, not inside another track's plan.
2. **Track A's files stay where they are.** The root-level JS/HTML/Python files are Track A, and the live URLs (`hologram.html`, `index.html`, `hands.html`) depend on those paths. They are not moved or renamed for B or C.
3. **New code lives in its own folder.** Track B code goes in `room/`, Track C browser code goes in `neurotech/`, and their assets go in `assets/rooms/` and `assets/arm/`. New tracks get their own pages (e.g. `room/index.html`), never extra modes bolted onto `hologram.html`.
4. **Shared modules are read-only by default.** B and C may *import* Track A modules (`handTracker.js`, `gestures.js`, `smoothLandmarks.js`, `stabilizer.js`, `scene.js`, `loadModel.js`, `HolographicMaterial.js`, `manipulator.js`, `measure.js`, `clean_scan.py`, …). If a new track needs one to behave differently:
   - add an option whose **default is today's behaviour**, or
   - copy the function into the track's folder and change the copy.
   Never change a shared default for the new track's sake.
5. **Track A's `test.html` is the contract.** Any commit that touches a shared root file has to leave `test.html` at 0 failures (the `hologram-verify` ritual). New tracks add their own test pages (`room/test.html`, …) rather than growing `test.js`.
6. **Hard constraints are per track.** Track A's constraints (no purchased hardware, browser-only, fixed stack) stay exactly as they are for A. A new track that needs to break one, as C almost certainly does with hardware, records that as a decision in *its own* plan. The exception never spreads back to A.
7. **Bugs are tagged by track.** `BUGS.md` stays one file, but each new item's heading starts with `[A]`, `[B]` or `[C]`. Existing items #1–7 are all Track A.
8. **Big assets are checked before committing.** Room scans can be far larger than the chair (23 MB) or chess (13 MB) folders, and GitHub rejects any single file over 100 MB. Check the size before committing a room scan, and decide on compression or Git LFS *before* the first one lands, not after.

## Priority Between Tracks

Not yet decided. See Open Questions. Until you say otherwise: B and C are the new focus. A is in **maintenance** (bugs, live confirmations, finishing the chess scans when the captures exist), and none of its work is dropped.

## Cross-track Notes

- **Track A's chess pipeline is Track B's first building block.** Per-part explode, `findExplodeParts`, grouped-OBJ (`o <name>`) loading and part selection are exactly what "interact with every object in a room" needs. Getting chess working live in A de-risks B directly. Keep those APIs stable.
- **Track A's segmentation lesson carries into Track B.** Splitting one dense scan into parts failed on the chess set (33 objects came back as 376 fragments; see `assemble_chess_set.py`), but worked on a large single object (the chair). Room furniture is closer to the chair case and room clutter is closer to the chess case. Track B's plan is built around that.
- **The ASL project's `knn.js` may have a second life in Track C.** It was ruled out for A (A's gestures are geometric, not classified), but classifying muscle-signal patterns into grip types is a classification problem. See Track C's plan.

## Open Questions (Project-Level)

- **Priority and time split between A, B and C.** Especially: does finishing Track A's chess work come before starting Track B, since B reuses it?
- **Does Track C live in this repo long-term?** Recommendation in Track C's plan: planning and browser tools live here, and arm firmware gets its own repo once code starts.

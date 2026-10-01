# Agent brief: hologram-workshop  (read this first; ~1 page; Tony keeps it current)

**What it is:** a browser hologram platform. Upload a LiDAR scan → hologram → gesture + mouse
control, plus offline Python that fills in what the scan missed (always marked "inferred").
Owner-facing docs: `CLAUDE.md` (project rules), `ROADMAP.md` (track index). Read only the section
you need.

## Tracks and where the code lives
| Track | Code | Plan |
| --- | --- | --- |
| A Platform (browser) | `platform/` (main.js, objectmode.js, ring.js, store.js, look.js, upload.js, export.js, measurements.js) | `plans/platform/ROADMAP.md` |
| v1 gesture engine (shared) | root: `gestures.js`, `manipulator.js`, `hologram.js`, `gunPose.js`, `holdGate.js`, `smoothLandmarks.js`, `stabilizer.js`, `ghostHands.js` | `plans/object-hologram/ROADMAP.md` (history) |
| B Scan completion (Python) | `completion/` (fill.py, complete.py, planes.py, benchmark.py, room_bench.py, truths.py); `.venv/bin/python` | `plans/scan-completion/ROADMAP.md` |

## Run and test
- Dev server: `python3 serve.py` on **:8080** (shared; never restart it unless you're the overseer).
  Use another port for experiments (`python3 serve.py 8099`).
- Suites and their last results: `docs/testing/LEDGER.md`. Recorded runs: `docs/testing/runs/`
  (`FLAGS.md` = auto-flagged issues; see `docs/testing/README.md`).
- Main suite: `http://localhost:8080/test.html` (read `#summary`). Others: `platform/*-test.html`,
  `docs/lab/gestures/*-lab.html`, `safety-test.html` (photosafety).
- Node is not installed. For pure JS modules use
  `ELECTRON_RUN_AS_NODE=1 '/Applications/Visual Studio Code.app/Contents/MacOS/Code' script.mjs`.
- Platform tests use a separate IndexedDB via `?db=<name>`; never touch the real `hologram-library`.
- Browsers hidden from view throttle animation frames; say so if a timing result depends on it.

## Standing rules (short)
- One owner per file. Claims, mid-edit warnings and "done" go on `docs/team-log/BOARD.md`.
- `test.html` stays at 0 failures after any change to a shared root file.
- **Photosafety:** nothing flashes (BUGS #14); ≤3 flashes/s; eased transitions.
- Inferred geometry is always visibly marked; the measured scan is never altered.
- Free and local only: no paid APIs, no build step, three.js r161 pinned.
- Bugs go in `BUGS.md` with track tags `[A]`/`[B]`/`[A-v1]`; never renumber.
- Never commit, push or send. The overseer commits after Timmy's GREEN.

## Current state (2026-10-01; update each round)
- Last commit `f439528`. Uncommitted: tilt reversed, scale #31, gunPose calibrated + pointer veto
  #32, Library ring + store (Debbie fixing #33–#44), test recorder (`testrec.js` + serve.py
  endpoints; :8080 needs a restart to pick them up).
- Owner decisions: Engage→Aim→Act gestures; pointer = index out + 3 curled (side-on or at camera);
  click = other hand's pinch; ✌ tool wheel; pins against edits; polygon lens non-destructive;
  Library ring is the landing screen.

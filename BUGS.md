# hologram-workshop — Bug Tracker

A durable task-clipboard for known issues, separate from `ROADMAP.md`'s
narrative revision history — that file records what changed and why, this
one tracks what's currently open at a glance. Treat it as a living document:
read it, update it in place, never spawn a parallel tracking file. See the
`hologram-bugwatch` skill for how to work through it.

Each item's status line is one of:
- `OPEN` — confirmed or reported, not yet resolved.
- `FIXED (verified offline)` — fixed and confirmed via `test.html` or direct
  execution (e.g. running `clean_scan.py` for real), no live camera needed.
- `FIXED (needs live confirm)` — fixed and reasoned through / code-reviewed,
  but not yet confirmed against a real browser, real webcam, or real asset.
- `NOT A BUG` — investigated and found to already work correctly.
- `DEFERRED` — real, not a bug in this project's code, blocked on something
  outside it (a re-scan, a design decision, etc).

---

## 1. Carousel model-swap — never run in a browser this session

**Status: FIXED (needs live confirm)**

`loadModelById()` in `hologram.js`, `carousel.js`, `models.js` — built
2026-09-23, code-reviewed and balance-checked, but this session had no
Node and no browser automation available, so none of it has actually
executed. Needs: open `hologram.html`, swap between the two `MODELS`
entries via the carousel UI and via arrow keys, 5+ times, confirm no
console errors and no growing count of orphaned `requestAnimationFrame`
loops (each `createMeasurePanel`/`.dispose()` pair should net to zero).

## 2. Per-part explode retargeting — never run in a browser, and no real multi-part asset yet

**Status: FIXED (needs live confirm)**

`manipulator.js`'s per-target state map, `selectPartAtScreenPoint`, and the
extended `performReset` — built 2026-09-23, same "unexecuted this session"
caveat as #1. Additionally blocked on item #4 below: there is no real
multi-part model in the app yet to actually select/grab a part of, so even
a real browser check can only confirm the synthetic `test.js` coverage, not
a genuine live-hands feel.

## 3. New `test.js` group ('Literal explode + per-part retargeting') — never actually run

**Status: FIXED (needs live confirm)**

Written 2026-09-23 to close the real gap described in item #5. Needs
`test.html` opened in a real browser to confirm it actually passes as
written — the assertions are reasoned through carefully (including explicit
`updateMatrixWorld()` calls for the raycasting checks) but never executed.

## 4. Chess scan is too fragmented for `clean_scan.py --multi-part`

**Status: DEFERRED — blocked on a re-scan, not a code bug**

`assets/chess/chess.glb` (2026-09-23 capture) splits into 376 disconnected
components instead of ~33 real objects (board + pieces) — confirmed via
`clean_scan.py --multi-part --dry-run`, and confirmed the pipeline itself is
sound by testing a synthetic welded board+2-pieces scan successfully
end-to-end. Root cause is scan-capture quality (thin/detailed/reflective
geometry breaking apart under phone LiDAR, same class of issue as the
chair's undersampled legs), not a pipeline defect. User decided to re-scan
with slower, more thorough passes rather than build fragment-merging logic.
See `ROADMAP.md`'s 2026-09-23 entry for the full investigation. Re-run
`clean_scan.py --multi-part --dry-run` on the new scan and check the
reported component count before committing to a full run.

## 5. Pitch, push/pull, and stretch-explode — still not confirmed on real hands

**Status: OPEN — needs live camera confirm**

Carried forward from `ROADMAP.md`'s 2026-09-08 entry: these three gestures
have only ever been exercised by synthetic `test.js` sequences, never a real
webcam session. Not touched this session.

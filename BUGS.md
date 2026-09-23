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

**Status: DEFERRED — superseded by a capture-strategy change, not a code fix**

`assets/chess/chess.glb` (2026-09-23 capture) splits into 376 disconnected
components instead of ~33 real objects. Confirmed this is not fixable by
any pipeline change, not just `--multi-part`: a direct test of reconstructing
the whole scan as ONE combined object (abandoning per-piece splitting
entirely) crashes Poisson reconstruction outright. The whole-set-scan
approach is abandoned — see item #6 and `ROADMAP.md`'s 2026-09-23(2) entry.
`clean_scan.py --multi-part` itself is not deleted (still correct against
synthetic data, might be useful for a smaller future multi-object scan) but
is no longer the path to the chess hologram.

## 5. Pitch, push/pull, and stretch-explode — still not confirmed on real hands

**Status: OPEN — needs live camera confirm**

Carried forward from `ROADMAP.md`'s 2026-09-08 entry: these three gestures
have only ever been exercised by synthetic `test.js` sequences, never a real
webcam session. Not touched this session.

## 6. Chess pipeline rebuilt around per-piece-type scans + `assemble_chess_set.py`

**Status: FIXED (verified offline) for the script; blocked on the user for real scans**

New capture plan (see `ROADMAP.md` 2026-09-23(2)): scan the board once plus
one example of each of the 6 unique piece types, clean each individually
with the existing unmodified `clean_scan.py`, then run the new
`assemble_chess_set.py` to lay them onto a standard starting position and
write one combined `o`-grouped OBJ. The script itself was actually executed
(not just reasoned through) against synthetic board+piece meshes and
verified correct: every placed piece's bottom lands exactly at the board's
detected top surface, and mirrored squares land at the expected symmetric
coordinates. One real bug found and fixed during that run — the dry-run's
board-diagram printout abbreviated King and Knight both as "K"; now uses
standard algebraic notation. **Still needs**: the actual 7 scans (blocked on
the user), then a run against real data and the same visual/live-app
verification the chair went through.

## 7. `findExplodeParts` didn't work on real OBJ-loaded multi-part meshes

**Status: FIXED (needs live confirm)**

`manipulator.js`'s `findExplodeParts` read `part.position` for centroid/
explode-direction/home, which is meaningless for a real OBJ file with
multiple `o`-named groups — OBJLoader gives every part `.position` at the
default `(0,0,0)`, with real location baked into geometry vertex data. Every
part's centroid would have read as `(0,0,0)` and every explode direction
would collapse to the same degenerate fallback. Fixed by recentering each
part's geometry around its own local bounding-box center and folding that
into `.position`, composed with whatever position already existed rather
than overwritten. A new `test.js` group builds parts the way a real
multi-group OBJ actually loads and confirms explode/select/grab/reset all
work correctly against that representation — this is reasoned through very
carefully and the synthetic test is designed specifically to catch a
regression here, but per items #1-3, `test.html` still hasn't actually been
run in a browser this session to confirm it passes as written.

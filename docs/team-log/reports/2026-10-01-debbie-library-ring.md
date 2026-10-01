# Library ring break-test: final round (Debbie, 2026-10-01)

## Summary
Library + ring break-test finished. Twelve bugs logged (BUGS.md #33-#44), all FIXED (verified offline).
This resume added #43 ("Free space now", owner decision) and #44 (overlapping opens, proven then fixed).
Every suite is at 0 failures.

## Suite counts (tree on 2026-10-01, uncommitted)
| Suite | Before this resume | After |
| --- | --- | --- |
| platform/library-test.html | 66/0 | 69/0 (+B30, B31 #43; +B32 #44) |
| platform/ring-test.html | 73/0 | 73/0 |
| platform/p5-test.html | 20/0 | 20/0 |
| test.html (read only) | 183/0 | 183/0 |
App page (`platform/index.html?db=debbie-a1`) loads, no console errors, the new button is hidden.

## Steps
1. **Restore check.** ring.js / index.html are byte-identical to the scratchpad `.fixed` copies (the overseer's restore). All four suites green before any new edit.
2. **#43 Free space now (build, owner decision).**
   - `store.js` `purgeExpired(days = 30, { orphanMs = ORPHAN_MS, keep = null })`. Defaults unchanged, so the start-up 30-day purge behaves as before.
   - Hazard found while designing: a save that stored its file (`putBlob`, refCount 0) and then hit the quota leaves a blob the scene needs but nothing references. An immediate orphan purge would delete it and the retry would throw (`store.js:175`, addRefs: "blob ... is not in the library"). Fix: `keep` = shas of the open scene's `sourceRefs`; checked by B31.
   - `index.html`: `#freeSpace` button in the status bar (hidden), fill animation while held (CSS `--hold-ms`).
   - `main.js`: shown by `reportStoreError` on code `quota`; pointer or Enter/Space hold of `HOLD_GATE.ringMs` (650 ms, imported from holdGate.js like ring.js); release, leave, cancel, blur abort; a keyboard click without a hold shows "hold the button". On fire: wait for the save chain, purge (days 0, orphans now, keep), retry the failed working save, report "freed space: removed N deleted projects and M unused files; your edits are saved". Still full → the error and the button come back. A successful save hides it.
   - B30: simulated quota (readwrite transactions throw until the purge starts). Shown true, a 200 ms press purges nothing, an 800 ms hold removed the trashed project, its file and an orphan, kept the scene's files, saved the edit, hid the button.
3. **#44 overlapping opens (debug).**
   - Reproduce: B32 starts open(B) from the animation frame A's thumbnail step waits on (deterministic). Before: `A true B true opening/busy when A finished false/false` → FAIL.
   - Root cause: `openProject` cleared `lib.opening` before the no-thumbnail capture, and A's `finally` cleared it and the busy flag again in the middle of B's load.
   - Fix: `lib.opening` stays true until the thumbnail is stored, edits made during that ~100 ms go to autosave afterwards (compared with a snapshot, since noteEdits updates `lib.sig` while opening), and a thumbnail failure is caught (it no longer turns into "could not open" and a reopen of the previous project).
   - After: `A true B false ... thumbA true` → PASS. B27 (#42 hidden tab) still passes.
4. **BUGS.md #33-#44** written. For #33-#42 the entries were rebuilt from the code comments and the checks added earlier (my earlier notes were not on disk). Root causes match the fixes in the code, but the earlier fail-before runs (except ring #39/#40) are not re-shown here.
5. **Cleanup.** IndexedDB debbie-a1, debbie-a2 deleted; localStorage `dbgH` and `hologram-platform-lastProject:debbie-a1/a2` removed (no rescue keys were left); tab 1664481083 closed. `hologram-library` (the real DB) untouched.

## Not verified / owner live checks
- #43 with a really full disk: not practical; quota is simulated. By eye: the button is readable in the status bar and fills while held, and a quick click does nothing.
- #40 at phone width (long title shows "…", the ⋯ button stays visible).
- library-test was run once after the final change (69/0) plus earlier runs; it was not repeated 10× for flakiness. B32 does not depend on timing.

## Files changed this resume
platform/store.js, platform/main.js, platform/index.html, platform/library-test.js, BUGS.md.

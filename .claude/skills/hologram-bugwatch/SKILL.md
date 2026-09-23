---
name: hologram-bugwatch
description: Maintain and work through BUGS.md, this project's persistent bug tracker, and regression-check changes against it. Use when asked to check for bugs/regressions before or after a change, update the bug list, see what's still open, pick the next bug to work on, or fold new testing feedback into the tracker.
---

# hologram-workshop bug tracking

`BUGS.md` is the durable task-clipboard for known issues — not a one-off
report that goes stale. Treat it as a living document: read it, update it in
place, never spawn a parallel tracking file. It's a companion to
`ROADMAP.md`, not a replacement for it: `ROADMAP.md`'s Revision History is
the narrative record of what changed and why; `BUGS.md` is the at-a-glance
"what's currently open" list.

## Picking the next item to work

If asked "what's next" / "check the bug list" with no specific item named:
read `BUGS.md` and propose the highest-priority still-open item, in this
order:
1. A `FIXED (needs live confirm)` item that can actually be confirmed right
   now (a local dev server + browser tools are available) — closing these
   out is cheap and turns "probably works" into "verified."
2. A confirmed `OPEN` bug with an offline-verifiable fix (no camera needed).
3. A confirmed architecture gap that needs a real design decision from the
   owner before touching code.
4. Something that needs live camera/device data before any fix is safe to
   attempt (say so explicitly — don't guess-fix these).
5. A `DEFERRED` item — lowest priority here, it's already blocked on
   something outside the code (a re-scan, an open question in `CLAUDE.md`).

## Investigating an item

Before writing any fix: read the actual code the item implicates — don't
guess a root cause from the symptom description alone. Prefer a fork/subagent
for broad investigation across many files so raw exploration doesn't fill the
main conversation; only the root-cause finding + file:line evidence needs to
come back.

If a claimed bug turns out to already be handled correctly in code, mark it
`NOT A BUG` with the evidence, don't leave it open indefinitely just because
it was reported.

## Verifying a fix (before marking anything FIXED)

Run the same regression discipline as `hologram-verify` — `test.html`'s full
suite passing, with zero new failures. Add a new regression check to
`test.js` for the specific bug when the root cause is a logic/threshold
mismatch (see the 2026-09-23 `clean_scan.py` dry-run-gating fix or the
literal-explode test-coverage gap for the pattern: reproduce the failure as
a case first, then fix it, then confirm the case now passes) — a fix without
a regression check can silently regress again later.

**Never mark an item plain `FIXED` if it touches live-camera-only behavior**
(anything gated by real hand tracking, frame rate/timing, or a real scan
asset). Use `FIXED (needs live confirm)` instead, and say explicitly what
the owner needs to check on a real device/browser.

## Updating the tracker

After investigating or fixing an item, edit its entry in place in `BUGS.md`:
- Status line (`OPEN` → `FIXED (verified offline)` / `FIXED (needs live
  confirm)` / `NOT A BUG` / `DEFERRED`).
- One or two sentences of evidence: root cause with file:line, what was
  checked, and the commit hash once it's actually committed.
- Keep entries terse — this is a checklist, not a narrative. Long
  investigation detail belongs in the `ROADMAP.md` revision-history entry or
  the commit message, not here.

## Folding in new testing feedback

When the user reports something broken (live-hands testing, a browser
check, anything), don't leave it as a one-off note in conversation — add it
to `BUGS.md` in the right place, or update an existing item if it's the same
underlying issue rather than creating a duplicate line for it.

## Token discipline

Don't paste the full `BUGS.md` file into the conversation on every check-in
— summarize only the item(s) relevant to the current question (e.g. "here's
what's still open" → list titles + status only, not the full evidence text).

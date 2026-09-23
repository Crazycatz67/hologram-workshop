---
name: hologram-resume
description: Reconstruct exactly where the hologram-workshop project was left off — reads ROADMAP.md's Revision History and Next Concrete Action, CLAUDE.md's Revision History, project memory, and uncommitted git state. Use at the start of a session on this project, after a crash/interruption, or when the user asks "where did we leave off" / "catch me up" / "resume".
---

# hologram-workshop resume

A prior session on this repo may have ended abruptly (crash, closed terminal,
interruption, or just the end of a working day) with work mid-flight.
Reconstruct state from durable sources — never assume anything from
conversation memory alone, since a fresh session has none. Do all of the
following, then synthesize one summary; don't just dump raw output.

This project has no separate stage-plan-file convention the way some
projects do — `ROADMAP.md`'s own "Next Concrete Action" section at the
bottom already fills that role directly, so there's no extra pointer file to
chase.

## 1. Read the sources of truth, in this order

1. `ROADMAP.md`'s **Revision History** (top of the file, most recent entries
   first) and its **Next Concrete Action** section (bottom of the file) —
   the direct record of what actually shipped and what's next.
2. `CLAUDE.md`'s Revision History (also top-of-file, newest first) for any
   standing decisions, scope calls, or hard constraints that changed.
3. This project's own memory directory (`MEMORY.md` and whatever it links
   to) — the same durable-context mechanism used elsewhere, already active
   for this project.

## 2. Cross-check against live repo state

- `git log --oneline -15` — does the last commit match what `ROADMAP.md`'s
  Revision History says was last shipped? If not, the docs are stale —
  trust git.
- `git status` and `git diff --stat` — any uncommitted changes at all?
- If there's an uncommitted diff: read it in full and identify which open
  item from `ROADMAP.md`'s Next Concrete Action (or a recently-discussed
  feature) it implements — don't just describe the diff mechanically, name
  *what it's for*. Read the diff to understand it, but never quote it
  verbatim back to the user — the final summary describes what it does in
  prose, not as pasted code/diff.
- Check whether the local dev server (`python serve.py 8080`, or the
  `.claude/launch.json` config) is already running:
  `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/` — useful
  context for whether picking back up needs a server start first.

## 3. Report back

One concise summary covering:
- What was last shipped (commit + one line on what it did).
- What's currently uncommitted, if anything, and whether it looks complete
  (would pass `hologram-verify`) or half-built.
- What `ROADMAP.md`'s Next Concrete Action says is next.
- Any standing open questions from `CLAUDE.md` (the "Ask the User, Don't
  Assume" section) still unresolved.

Do not start making changes — this skill only reconstructs context. Suggest
running `hologram-verify` next if there's finished-looking uncommitted work,
or offer to pick up the Next Concrete Action item directly.

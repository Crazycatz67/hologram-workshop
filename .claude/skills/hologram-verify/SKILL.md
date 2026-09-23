---
name: hologram-verify
description: Run this project's verify-and-ship ritual (start the dev server, run test.html's regression suite, commit, push, optionally confirm the live GitHub Pages URLs) after any JS/HTML/Python change in hologram-workshop. Use when the user asks to verify, test, ship, or deploy a change, or before ending a work session with uncommitted changes.
---

# hologram-workshop verify-and-ship

This project's test surface is `test.html` / `test.js` — a dependency-free
regression suite (see `CLAUDE.md`'s hard constraints: no build step, no
extra dependencies), currently dozens of checks covering gesture isolation,
tracking-noise robustness, explode/scale/tilt/clap, and measurement against
the real shipped chair scan. There is no `ci-check.mjs`-style static check
and no `VERSION` constant to bump — cache-busting is already handled
per-load via a `?v=timestamp` query param on every module import, plus
`serve.py`'s `no-store` response headers. Skip those steps entirely; they
don't apply here.

Run every step below in order. Stop and report if any step fails — do not
proceed to commit/push on a failure.

**Token discipline:** don't paste the full pass/fail listing into the
conversation. Report only the pass count, whether it's all-passing, and the
full text of any FAIL lines (there should be none).

## 1. Start the dev server if it isn't already running

```
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/
```

If not `200`, start it in the background: `python serve.py 8080` (macOS) or
`python serve.py 8080` (Windows — same script either way, see
`.claude/launch.json`). Wait a moment, then re-check.

## 2. Run the live suite

1. Load the Chrome tools if not already loaded (`ToolSearch` for
   `mcp__claude-in-chrome__tabs_context_mcp,navigate,get_page_text,tabs_create_mcp,tabs_close_mcp`)
   — if browser tools aren't enabled this session, say so explicitly and
   ask the user to check `test.html` themselves rather than guessing at the
   result.
2. Open a tab, navigate to `http://localhost:8080/test.html`,
   `get_page_text`, and read the summary line (`N passed, N failed`).
3. If anything failed, quote the failing case name(s) and their detail text
   verbatim, and stop — do not guess a fix blindly; this suite is the real
   regression net for everything that doesn't need a live camera.
4. Close the tab when done.

If the change touches anything gesture/camera-related, say explicitly that
this suite only proves the code does what it's supposed to given known
synthetic inputs — it is not a substitute for a real webcam session, per
this project's own repeated caveat in `ROADMAP.md`.

## 3. Commit

- `git status` / `git diff --stat` to see exactly what changed.
- Stage only the files actually part of this change (never a blanket
  `git add -A` without checking what it picked up — this project has
  previously had large raw scan files show up as untracked; don't
  accidentally commit a multi-megabyte asset that wasn't meant to ship).
- Write a commit message in this repo's established style: a one-line
  present/imperative summary, then a body explaining *why* and, for bug
  fixes, the *root cause* — see recent commits (`git log -5`) for tone. Do
  not add the Co-Authored-By line yourself; the harness appends it
  automatically from the system reminder.

## 4. Push and confirm

Only after explicit user confirmation to push — this skill does not waive
that standing rule. This machine may not have GitHub credentials configured
non-interactively (no `gh` CLI, HTTPS remote); if `git push` fails with a
credential error, tell the user to run it themselves via `! git push origin
main` in their own terminal, where an interactive/browser login can work.

Once pushed, there is no CI to confirm here (no GitHub Actions workflow —
GitHub Pages serves `main` directly with no build step). Instead, optionally
confirm the live pages actually respond, since that's the real "did this
ship" signal for this project:

```
curl -s -o /dev/null -w "%{http_code}" https://crazycatz67.github.io/hologram-workshop/
curl -s -o /dev/null -w "%{http_code}" https://crazycatz67.github.io/hologram-workshop/hands.html
```

Pages can take a minute or two to redeploy after a push — a `200` on an
unchanged page doesn't prove the new content is live yet, just that the site
is up.

## Notes

- This project's dev server is cross-platform (`python serve.py`, no
  PowerShell-specific step) — no shell-specific adaptation needed unlike
  some other projects.
- `test.html` is the only verification surface right now. If a future
  change needs a static/offline check (e.g. for `clean_scan.py`, which is
  Python and untestable via the browser suite), verify it by actually
  running it (this project already has `pymeshlab`/`numpy` installable via
  `pip3 install pymeshlab numpy` — not a new project dependency, just what
  `clean_scan.py` itself has always required to run) rather than skipping
  verification.

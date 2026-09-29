---
name: hologram-livelab
description: Run the hologram-workshop lab loop. Exercise every test surface (the v1 pages plus the test.html suite, the Platform pages under platform/, and the Python scan tools), hunt for real bugs, log findings in BUGS.md with track tags, fix what is small and verifiable, re-verify, then hand off to hologram-verify to ship. Use when the owner says "run the lab", "test everything", "test run each of the code", "find what's broken", "look for bugs", or asks for a test → fix loop on this project.
---

# hologram-workshop lab: test → find → fix → verify → ship

This is the hologram analogue of the ASL project's `asl-livelab`, adapted to how this repo
actually works:
- There is no shadow branch or worktree server. One static server (`serve.py`, no-store
  headers) serves the working tree.
- There is no issues.json store. **`BUGS.md` is the only tracker.** Never create a parallel
  findings file (see `hologram-bugwatch`).
- There is no `ci-check.mjs` and no sw.js VERSION. `test.html` is the contract for the root
  modules. `completion/benchmark.py` is Track B's check.

Run a cycle when asked, not continuously. Report mode (find and log only) is the default when
another agent owns the code, and step 0 decides that.

**Honest boundary:** nothing here uses a real webcam. "Tested" means the shipped code was
driven by synthetic hands (test.js, `gesture-tester`), real scan files, and real page loads
without camera permission. Anything gated on live hand tracking, the real frame rate, or feel
stays `FIXED (needs live confirm)` / `OPEN, needs live camera confirm` until the owner tries it
on the Mac.

## 0. Scope and ownership (before touching anything)

- Read the root `ROADMAP.md` isolation rules and `BUGS.md`. Items already listed, including
  FIXED ones, are not re-logged. Update the existing entry instead.
- Ask, or read from the brief, which folders another agent is actively editing. The usual case:
  `platform/` belongs to the Platform agent, and `completion/fill.py` + `completion/benchmark.py`
  belong to the Track B lead. Findings there are **logged only**, never edited.
- Never touch `.gitignore`, `plans/`, `CLAUDE.md` or `ROADMAP.md` from the lab. No commits or
  pushes from the lab; shipping is `hologram-verify`'s job, with the owner's go-ahead.

## 1. Dev server

```
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/
```
If the result is not `200`, run `python3 serve.py 8080` in the background and re-check.

## 2. Browser surfaces (Chrome extension)

Load the tools in ONE ToolSearch call: `tabs_context_mcp, tabs_create_mcp, navigate,
get_page_text, javascript_tool, read_console_messages, computer, tabs_close_mcp`. If they are
not available this session, say so and list which checks were skipped. Never guess at a page
result.

Open your **own** tab and close it when done. Call `read_console_messages` once before the
first navigation, because tracking only starts on the first call. Then reload each page and read
it with `onlyErrors`. The automation tab is usually backgrounded (`visibilityState: hidden`), so
rAF does not tick: fps shows "—" and rAF-count checks cannot be done this way. Say so rather
than reporting a leak or a pass.

| Page | What to check | Must not do |
|---|---|---|
| `test.html` | Wait ~5s. Read `#summary` (`N passed, N failed`) and every `.case.fail` text **verbatim** | — |
| `index.html` | Status shows the model path and dims; no console errors; measure panel filled in | — |
| `hologram.html` | Status "…loaded · start the camera"; `#start` enabled; carousel not stuck `busy`; ArrowLeft/Right swaps several times with no errors | Click "start camera" (triggers a permission dialog) |
| `hands.html` | Loads, "idle", no errors | Start the camera |
| `platform/index.html` | Click "Load sample"; read the status line (tris, dims, split time, parts); no errors. Run `platform/test.html` too if it exists | Edit anything in `platform/` |

State-dependent paths hide bugs that a clean profile never hits. Seed localStorage (for example
`hologram-notes:<modelKey>`) and reload. **Save the original value first and restore or remove
it afterwards.** This is how the notes crash (BUGS #9) was found.

## 3. Python surfaces (`.venv/bin/python`, outputs to the scratchpad, never over `assets/`)

1. `--help` for `clean_scan.py`, `analyze_scan.py`, `repair_scan.py`, `assemble_chess_set.py`,
   `completion/benchmark.py`. `completion/fill.py` is a library with no CLI, so an empty
   `--help` from it is expected.
2. Smoke benchmark: `completion/benchmark.py --methods none thickness --scenarios holes`
   (~3s). Record the table rows.
3. The documented chair command, written to the scratchpad:
   `clean_scan.py assets/chair/chair.glb --crop-center-x -0.02 --crop-center-z -0.14 --crop-radius 0.60 --symmetrize -o <scratch>/chair.obj`.
   Expected: symmetry 164.3° / 88.3%, rebase ≈ 75.5k verts, 1 component, manifold, ~6s. Also
   run `--dry-run`.
4. `analyze_scan.py assets/chair/chair.glb`, and check that the flags it prints actually work
   with a `clean_scan.py --dry-run`.
5. `repair_scan.py … --close-holes` and `--poisson` (the usage-block command) to the scratchpad.
6. **Anything that can fail natively gets run several times.** PyMeshLab's multi-threaded
   Poisson exits with status 0 and writes nothing about 1 run in 3 (BUGS #8, #13). Check that
   the output file exists; the exit code proves nothing.

## 4. Code read → reproduce → only then log

Read the root JS modules and Python tools for logic errors, unit mismatches (palm-lengths vs
screen fractions), **frame-rate dependence** (any fixed per-call blend or per-call cap; the
project rule is per-second rates with real `dt`), off-by-one errors, unhandled errors, init-order
problems (TDZ), and teardown that has side effects (a dispose that saves).

**Reproduce every suspect before logging it**, with a `javascript_tool` call that imports the
module with `?v=Date.now()`, or a short Python snippet. False positives waste the owner's time.
If a check is your own measurement artefact (for example, raw camera distance grows when the
object slides sideways), fix the measurement and do not log it.

Gesture behaviour (thresholds, bleed, fps) is measured by the `gesture-tester` skill, not
eyeballed here.

## 5. Log in BUGS.md (the single tracker)

Add each new item as `## N. [tag] title`, continuing the numbering. Tags: `[A]` Platform code,
`[B]` Scan Completion, `[C]` Arm, `[A-v1]` root v1 modules and tools (say which track found it).
Status is one of `OPEN` / `OPEN, needs live camera confirm` / `FIXED (verified offline)` /
`FIXED (needs live confirm)` / `NOT A BUG` / `DEFERRED`. Each entry holds 2–6 sentences: the
root cause with file and function, the reproduction, the numbers before and after, and a
fix direction if it is still open. When an existing item is advanced (for example, the lab
exercised a "needs live confirm" path), add a dated line to that item rather than a new entry.

## 6. Fix (only when all of these hold)

- The file is not owned by another active agent (step 0).
- The fix is small and clearly correct, and it doesn't need a real camera to judge (a crash, a
  lost save, a missing `threads=1`). **Thresholds and feel are not guess-fixed.** Log them with
  the numbers.
- Add a regression check: a test.js group for JS, following the pattern "reproduce the failure
  as a case → fix → case passes". For Python, repeated runs with the before/after counts in the
  BUGS.md entry.
- Re-run `test.html` afterwards. It must be **0 failed**, and the new cases must be listed.

## 7. Verify and report

Re-run whatever touched the change: test.html, the affected page load, and the Python command
N times. Then report to the owner or the main session in a few lines:
- test.html count
- per-page console status
- Python results
- each new BUGS.md item with its tag and status
- the gesture-tester headline, if it was run
- what still needs the real webcam

No raw logs.

## 8. Ship (main session, via `hologram-verify`)

Stage only the files the fix touched, commit with the root cause in the body, and push **only**
after the owner confirms. Then update the BUGS.md statuses with the commit hash.

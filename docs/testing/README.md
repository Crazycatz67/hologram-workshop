# Test recorder

Every wired test, lab and probe page saves each run automatically, so nobody has to
copy-paste results into chat, and `serve.py` flags anything that got worse without anyone
asking. The pattern is the team's `test-recorder` skill; this file covers this project.

## What is recorded, and where

| Page | Run folder (`docs/testing/runs/…`) | What goes in |
| --- | --- | --- |
| `test.html` | `test/` | every case as `<group> › <case>` (pass/fail + detail) |
| `safety-test.html` | `safety-test/` | one check per scene (verdict PASS), flashes/s as the value; full results attached |
| `docs/lab/gestures/holdgate-lab.html` | `holdgate-lab/` | the 19 scripted scenarios |
| `docs/lab/gestures/gesture-lab.html` | `gesture-lab/` (`gesture-lab-only/` with `?only=`) | "fires isolated" per gesture, "no false fire" per null probe, `bleed.<gesture>` counts as metrics; report attached |
| `docs/lab/gestures/smoothing-lab.html` | `smoothing-lab/` | every number of the shipped (`after`) pipeline as a metric (±1%); report attached |
| `docs/lab/gestures/gun-lab.html` | `gun-lab/` | the synthetic self-test (info rows have no pass/fail) |
| same page, live guided probe | `gun-lab-probe/` | fps (floor 20), phase summaries, calibration, verdict: numbers only |
| `platform/p5-test.html` | `p5-test/` | the 20 checks |
| `platform/perf-test.html` | `perf-test/` (`perf-test-<scan>/` with `?scan=`) | `<mode>@pr<n>.median/p95/gpuMedian/triangles/calls` metrics (±50%), photosafety verdicts as checks, LOD swap as info |
| `platform/parts-test.html` | `parts-test/` (`parts-test-glb/` with `?model=glb`) | match vs the Python reference + per-part rows; `parts` (any change flagged) and `ms` (±100%) |
| `platform/photo-test.html` | `photo-test/` | one run per photo: timings, triangle/vertex counts, size. Never the file name or the image |

`ring-test.html` and `library-test.html` are **not wired yet** (they were mid-edit by Debbie);
the snippet is below.

Each run is `docs/testing/runs/<page>/<YYYY-MM-DD_HH-MM-SS>.json` (server local time) plus a
copy in `latest.json`. The record schema is in the header of `testrec.js`.

## Privacy scope

- Only test/lab/probe pages import `testrec.js`. Production pages (`index.html`,
  `hologram.html`, `hands.html`, `platform/index.html`) never do; check with
  `grep -l testrec index.html hologram.html hands.html platform/index.html` (no output = good).
  The normal pages record sessions with `sessionrec.js` instead, on this machine only (next section).
- Only on `localhost` / `127.0.0.1` / `[::1]` does the recorder talk to the server. On GitHub
  Pages it makes no request at all and shows a "download run" button instead.
- Numbers only: images, video, canvases and blobs are refused; raw typed arrays need
  `rawStreams: true`.
- `docs/testing/runs/` is git-ignored (raw runs and FLAGS.md). What matters gets curated into
  the committed `docs/testing/LEDGER.md`.
- The server endpoints answer only requests from this machine with a localhost `Host` and,
  when present, a localhost `Origin` (a site you visit can't post runs into the repo).

## Shadow site vs public site (session recorder)

Owner-approved 2026-10-01: normal pages record on localhost only. The same files are two sites:

| | Public site (GitHub Pages, `crazycatz67.github.io/hologram-workshop`) | Shadow site (`http://localhost:8080` or `127.0.0.1:8080`) |
| --- | --- | --- |
| Session recorder | never downloaded, never runs, saves nothing | every session of `hologram.html`, `hands.html`, `platform/index.html` is recorded |
| Badge | none | small static "SHADOW · recording" at the bottom centre; click it for the last saved session's flags |
| Opt out | n/a | add `?rec=off` to the URL (e.g. for automated checks that should not leave sessions) |

How it is enforced: each of the three pages has one inline module script that checks
`location.hostname === 'localhost' || location.hostname === '127.0.0.1'` and only then
dynamic-imports `sessionrec.js`; `startSession()` checks the hostname again. Verified by loading
`hologram.html` under another hostname (Chrome `--host-resolver-rules`, `shadow.test` -> 127.0.0.1):
0 requests for `sessionrec.js`, no badge, no `window.__sessionrec`.

**What a session records** (numbers and events only; never camera frames, canvases, images,
typed text, or the names of your files / projects): page, commit (filled in by serve.py),
duration and visible time, fps median / 5th percentile / min, camera start / stop / errors and
camera-on time, model and project loads (repo model ids; for your own scans only triangle/part
counts and timings), the gesture/mode timeline with entries and time per mode (hologram: the
manipulator mode; hands: per-hand MediaPipe gesture + pinch; platform: scene/object mode),
resets and undos, edits, Library ring open/close and project open/close (short id), unit
changes, click counts per element id, shortcut-key counts (never keys typed into a field),
console errors / warnings, uncaught errors, visibility changes.
Run folder: `docs/testing/runs/session-<hologram|hands|platform>/`, the record is in
`attachments.session` and `metrics`.

**When it is saved:** on `pagehide` (closing the tab, reloading, navigating away) with
`sendBeacon`. If the beacon is refused the record waits in localStorage and is sent by the next
shadow page you open. If the tab crashed (no pagehide), its last 5-second checkpoint is sent by
the next shadow page with status `crashed` (so up to 5 s at the end of a crashed session is lost).
Known edge: if the whole browser is force-killed within about a second of closing a tab, that
session can also arrive a second time as `crashed` (the deletion of its checkpoint was lost).

**Session flags** (in FLAGS.md like any run):

| Kind | Means |
| --- | --- |
| `console-error` | console errors / uncaught errors / unhandled rejections (MediaPipe's "INFO: Created TensorFlow Lite XNNPACK delegate" line is filed as a warning, not an error) |
| `low-fps` | the visible tab ran below 20 fps for more than 2 s (a freeze counts) |
| `mode-flicker` | more than 4 gesture/mode changes within 1 s |
| `hidden-tab` | the tab was hidden and came back, or was hidden over 1 s before closing (the moment of hiding while you close a tab is not flagged) |
| `ended-early` | status `crashed`: the tab died without closing normally |

Agents: sessions from automated tabs are recorded too (a background tab shows `hidden-tab`);
use `?rec=off` when a session record would only be noise.

## Reading FLAGS.md

`docs/testing/runs/FLAGS.md`, newest first, one line per flag:

```
- 2026-10-01 14:03:22 · holdgate-lab · f439528+dirty · fail · <check name>: <value>
```

| Kind | Means |
| --- | --- |
| `fail` | a check failed |
| `disappeared` / `count-dropped` | checks that were in the previous run are gone / fewer checks than last time |
| `tolerance` | a declared metric moved beyond its tolerance vs the previous run |
| `console-error` | console errors / uncaught errors / unhandled rejections during the run |
| `ended-early` | the run ended with a status other than `done` (crashed, cancelled, incomplete, timeout) |
| `low-fps` | fps below the page's `fpsFloor` |
| `hidden-tab` | the tab was hidden during a timing-sensitive run: its timings are not comparable |
| anything else | raised by the page itself (`rec.flag`) |

"Previous run" means that page's `latest.json` before this run was saved. A tab driven by
browser automation in the background is hidden, so perf-test and the gun-lab probe will show
`hidden-tab` there; that is correct.

## Running it

`python3 serve.py` (port 8080) serves the endpoints. **A server started before the recorder
existed must be restarted** to get them; until then pages fall back to `localStorage` (last 5
runs, `window.__testrec.pending()`) and the "download run" button. Any other static server
behaves the same way.

## Adding the recorder to a new test page

In the page's bootstrap module (path to `testrec.js` relative to the page):

```html
<script type="module">
  // Test recorder: saves this run to docs/testing/runs/ on localhost (docs/testing/README.md).
  // If it can't load, the test runs exactly as before.
  const rec = await import('../testrec.js').then((m) => m.startRun({ page: 'my-test' })).catch(() => null);
  import('./my-test.js?v=' + Date.now()).then(() => {
    for (const r of window.myResults?.results ?? []) rec?.result(r.name, r.detail ?? '', { pass: !!r.ok });
    rec?.end();
  }).catch((e) => { console.error(e); rec?.end('crashed'); });
</script>
```

Pending for `platform/ring-test.html` (results in `window.ringResults.results`) and
`platform/library-test.html` (`window.__libraryTest.results`): the same snippet with
`page: 'ring-test'` / `'library-test'` and that results object; rows are `{ name, ok, detail }`.

Options for `startRun` (full contract in `testrec.js`):

- `tolerances: { name | '*': rel | { abs, rel } }` flags a metric (or a numeric result value)
  that moved more than `max(abs, rel × |previous|)`. Undeclared numbers are never flagged.
- `fpsFloor` flags a run whose `fps` metric is below it.
- `timingSensitive: true` flags runs during which the tab was hidden.
- `timeoutMs` (default 10 min; 0 = never) ends a forgotten run as `timeout`.
- Use one page id per comparable variant (e.g. `parts-test-glb`) so history compares like with like.

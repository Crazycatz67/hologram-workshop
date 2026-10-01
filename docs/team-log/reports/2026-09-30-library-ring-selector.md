# Library ring selector (research)

Date: 2026-09-30. Research by Ricky; written up by Randy. Nothing is built yet.

## Summary

Ricky recommends a **Library ring**: a console-menu-style (XMB) arc where left/right moves between projects and up/down between versions of a project. Only the centre card is live (one full model in memory). A first slice is about 2-3 days of work, mouse first, using the 3 chair samples. Four owner questions decide the scope (below).

## How it works

- Arc layout: ← → projects, ↑ ↓ versions.
- Only the centre card is a live model; the others are thumbnails.
- Fist-drag spins the ring with friction and a snap to the nearest card.
- Aim plus click selects. Delete sits behind the ring tier (about 650 ms hold).
- Accessibility: a page listbox mirrors the ring.
- Scaling: filter chips past about 12 items; grid plus search past about 30.

## Data model

Stored in IndexedDB database `hologram-library`:
- **blobs** by sha256 (the original scans);
- **projects**;
- **versions** = `buildLayout v2` edit logs replayed on the original;
- **thumbs**.

Behaviour: autosaved working copy plus an explicit "Save version"; fork; soft delete kept 30 days; `persist()` requested; backup export.

## Risks

| Risk | Note |
| --- | --- |
| Safari 7-day eviction of script-written storage | `persist()` and backup export mitigate |
| Grip (fist) reliability for spinning | gesture must be tested live; mouse first |
| Large blobs in IndexedDB | needs measuring with real scans |
| Replay breaks if segmentation changes | store a segmentation version with each edit log |

## Smallest slice

2-3 days, mouse first, with the 3 chair samples. Needs two things elsewhere:
- Track B sidecar `source_sha256` (to link a completed scan to its original);
- `upload.js` to pick up the JSON.

## Limits

Research only: no code, no timing measured. The 2-3 day estimate is Ricky's; the overseer did not verify it.

## Open questions for the owner

1. Is a library entry one scan or a whole scene?
2. Autosave plus "Save version", or explicit save only?
3. Should the ring be the landing screen?
4. May versions later hold changed geometry (not just edit logs)?

## Sources

Ricky's Library ring report (source of all content above). Exact URLs were not included in the material handed to me.

# Debbie-G host snippets (overseer routes; files owned by Cody)

## handsRuntime.js: selected-part outline (#7)
```js
// import: const { createReticle, probe, createPartHighlight, SELECTED_OUTLINE } = await import('./reticle.js' + V);
const selectedHighlight = createPartHighlight(scene, SELECTED_OUTLINE); // next to `highlight` (~line 117)
// every frame in the tick, not only while aiming:
selectedHighlight.update({ part: manip?.activePart ?? null, nowMs });
// dispose(): selectedHighlight.dispose();
```

## hologram.js: thumb-tap setting + practice A/B (#9)
```js
// ⚙ Pointer & feel checkbox "Thumb-tap click (trial)", default off:
thumbTapBox.checked = runtime.pointer.thumbTap;
thumbTapBox.onchange = () => runtime.pointer.setThumbTap(thumbTapBox.checked, { persist: true });
// Selection practice with the A/B rounds:
const { PRACTICE_ROUNDS_THUMB } = await import('./calibrate.js' + V);
runtime.startPractice({ rounds: PRACTICE_ROUNDS_THUMB }); // e.g. Shift+P or a second button
// hand click handler: treat click.via === 'thumb-tap' like 'pinch'
```

## hologram.js: tape takes other-hand pinch only (Ricky (b))
```js
// in the hand-click handler, before placing a tape point:
if (measurePanel.mode === 'tape' && click.source === 'hand' && click.via !== 'other-pinch') return;
```

## hologram.js: drag to measure (Ricky (f))
```js
// pinch onset (other-pinch) while the tape is on = point A; while the pinch holds, a live line
// follows the cursor; release = point B. Needs a pinch-release event from pointer.js (not yet
// exposed: add `onPinchEnd` / click.phase in a follow-up job). Coach line:
// '📏 Pinch to start · hold and move · let go to finish'
```

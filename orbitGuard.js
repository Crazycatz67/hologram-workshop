// orbitGuard.js — stops three.js r161 OrbitControls getting stuck in a drag (BUGS #53).
//
// Why: OrbitControls only ends a drag when ITS pointerup listener sees the button come up. If
// that one event is lost (a native menu or permission bubble, focus loss, a listener that stops
// it), the controls keep `pointers=[id]`, keep their pointermove listener and stay in ROTATE, so
// every plain mouse move — no button held — spins the model. The next click then pushes a second
// copy of the same id, and its pointerup throws at OrbitControls.js:1071 ("reading 'x'") and the
// drag stays stuck. The owner's guided run hit this: 16 of those errors, six of them right before
// mouse tape points, and "the chair keeps spinning when moving the mouse".
//
// The guard does not need to know what swallowed the pointerup. It watches the controls' own
// 'start'/'end' events, and while they say a drag is open it ends the drag (a synthetic
// pointercancel on the canvas, which OrbitControls handles exactly like pointerup) when:
//   (a) a mouse/pen moves with no button held (e.buttons === 0), or
//   (b) a new mouse/pen pointerdown reaches the canvas — repaired before the controls see it,
//       so their pointer list never holds a duplicate (no 1071 throw).
// Touch is left alone: two fingers down is a real pinch, not a stale drag.
// Listeners are window capture-phase, so they run before the canvas's own listeners.
//
// Contract:
//   createOrbitGuard({ controls, canvas = controls.domElement, win = window, onRepair? })
//     -> { dragging, repairs, repair(why), dispose() }
//   dragging: true between the controls' 'start' and 'end' events (a wheel step is start+end).
//   repairs:  how many stuck drags were ended (sessionrec / tests can read it).
//   onRepair({ why: 'buttonless-move'|'stale-down'|<caller's why>, t }) after each repair.
//   repair(why) ends an open drag now (no-op when none is open); returns true if it did.
// No dependencies: platform/main.js can reuse it as-is.

export function createOrbitGuard({ controls, canvas = controls.domElement, win = window, onRepair = () => {} } = {}) {
  let dragging = false;
  let repairs = 0;
  // 'start' carries no event, so remember the id of the last canvas pointerdown
  // (mouse is 1 in Chrome/Safari).
  let lastId = 1;
  const onStart = () => { dragging = true; };
  const onEnd = () => { dragging = false; };
  controls.addEventListener('start', onStart);
  controls.addEventListener('end', onEnd);

  const isPointerTool = (e) => e.pointerType !== 'touch';

  function repair(why = 'manual', pointerId = lastId) {
    if (!dragging) return false;
    // One cancel removes one pointer entry; a list that already holds a duplicate needs two.
    // Bounded so a controls build that never fires 'end' cannot loop.
    for (let i = 0; i < 3 && dragging; i++) {
      canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerId, pointerType: 'mouse', bubbles: true }));
    }
    // Belt and braces: if 'end' still didn't fire, stop trusting our flag rather than repeat forever.
    dragging = false;
    repairs++;
    onRepair({ why, t: performance.now() });
    return true;
  }

  const onMove = (e) => {
    if (dragging && isPointerTool(e) && e.buttons === 0) repair('buttonless-move', e.pointerId);
  };
  const onDown = (e) => {
    if (e.target !== canvas || !isPointerTool(e)) return;
    if (dragging) repair('stale-down', e.pointerId);
    lastId = e.pointerId;
  };
  win.addEventListener('pointermove', onMove, true);
  win.addEventListener('pointerdown', onDown, true);

  return {
    get dragging() { return dragging; },
    get repairs() { return repairs; },
    repair,
    dispose() {
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
      win.removeEventListener('pointermove', onMove, true);
      win.removeEventListener('pointerdown', onDown, true);
    }
  };
}

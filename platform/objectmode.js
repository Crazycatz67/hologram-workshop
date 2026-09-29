import * as THREE from 'three';

// Scene mode / object mode, following Quest/visionOS practice: in scene mode input moves the
// camera; in object mode a ray highlights the part under the pointer BEFORE anything is
// committed, a click selects, and edits then apply to the selection only.
//
// Everything that changes the scene goes through the small action API returned below
// (select, beginMove/moveBy/endMove, rotateSelected, hideSelected, showAll, undo). The mouse
// handlers are just one caller of it, so hand gestures can drive the same actions later
// without touching the edit log or undo logic.
//
// Edits are appended to `edits` as plain JSON (SceneScript-style command list):
//   {op:'move', part, dx, dz} {op:'rotate', part, dy} {op:'hide', part} {op:'showAll'}
// `undoStack` is parallel to it and holds closures that restore the exact previous state.

const ROTATE_PER_WHEEL_UNIT = 0.005; // radians per wheel delta unit: one notch (~100) is ~0.5 rad
const ROTATE_COALESCE_MS = 600;      // wheel ticks within this window are one rotate edit
const DRAG_THRESHOLD_PX = 3;         // below this a press is a click, not a move

export function createObjectMode({ camera, canvas, controls, materialFor, edits, onChange }) {
  let parts = [];              // [{id, mesh}]
  let mode = 'scene';
  let hoverId = null;
  let selectedId = null;
  const undoStack = [];
  let drag = null;             // {id, startPos, plane, startHit, moved}
  let lastRotate = null;       // {id, edit, time} for coalescing wheel ticks
  let pendingMove = null;      // latest pointer position awaiting the per-frame hover pick
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const byId = (id) => parts.find((p) => p.id === id)?.mesh ?? null;
  // Visible means the part AND every ancestor (a hidden library item hides all its parts).
  const shown = (m) => { for (let o = m; o; o = o.parent) if (!o.visible) return false; return true; };
  const visibleMeshes = () => parts.filter((p) => shown(p.mesh)).map((p) => p.mesh);
  const hiddenCount = () => parts.filter((p) => !p.mesh.visible).length;

  function paint() {
    for (const { id, mesh } of parts) {
      mesh.material = materialFor(id === selectedId ? 'selected' : id === hoverId ? 'hover' : 'base', mesh);
    }
  }

  function notify() {
    paint();
    canvas.style.cursor = drag ? 'grabbing' : mode === 'object' ? (hoverId ? 'pointer' : 'crosshair') : '';
    onChange?.(api.state());
  }

  function record(edit, undo) {
    // Multi-model: every part edit carries the id of the library item it belongs to.
    if (edit.part != null && edit.item == null) edit.item = byId(edit.part)?.userData.itemId ?? null;
    edits.push(edit);
    undoStack.push(undo);
    notify();
  }

  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // Only visible parts: Raycaster ignores .visible, and a hidden part must not be grabbable.
    const hit = raycaster.intersectObjects(visibleMeshes(), false)[0];
    return hit ? hit.object.userData.partId : null;
  }

  const worldBox = (mesh) => new THREE.Box3().setFromObject(mesh);

  const api = {
    edits,

    // Called by main when a new scan replaces the old one.
    setParts(newParts) {
      parts = newParts;
      hoverId = selectedId = drag = lastRotate = null;
      edits.length = 0;
      undoStack.length = 0;
      notify();
    },

    // Multi-model support: parts are added/removed per library item without clearing the log.
    addParts(list) { parts = parts.concat(list); notify(); },
    removeItem(itemId) {
      const gone = new Set(parts.filter((p) => p.mesh.userData.itemId === itemId).map((p) => p.id));
      parts = parts.filter((p) => !gone.has(p.id));
      for (let i = edits.length - 1; i >= 0; i--) {
        if (edits[i].item === itemId) { edits.splice(i, 1); undoStack.splice(i, 1); }
      }
      if (gone.has(hoverId)) hoverId = null;
      if (gone.has(selectedId)) selectedId = null;
      lastRotate = null;
      notify();
    },
    record(edit, undo) { lastRotate = null; record(edit, undo); },

    setMode(m) {
      if (m === mode) return;
      mode = m;
      hoverId = selectedId = null;
      if (drag) api.endMove();
      notify();
    },
    toggleMode() { api.setMode(mode === 'scene' ? 'object' : 'scene'); },

    hover(id) { if (id !== hoverId) { hoverId = id; notify(); } },
    select(id) {
      if (id != null && !shown(byId(id) ?? { visible: false })) id = null;
      if (id !== selectedId) { selectedId = id; lastRotate = null; notify(); }
    },
    pick,

    // Move: live while dragging, committed as ONE edit with the total offset on endMove.
    // Y is never touched, so the part keeps its original height. `plane` is horizontal at the
    // part's bbox centre so the cursor stays glued to the point that was grabbed.
    beginMove(id, plane, startHit) {
      const mesh = byId(id);
      if (!mesh) return false;
      drag = { id, startPos: mesh.position.clone(), plane, startHit, dx: 0, dz: 0 };
      controls.enabled = false;   // orbit must not fight the drag
      notify();
      return true;
    },
    moveBy(dx, dz) {
      if (!drag) return;
      drag.dx = dx; drag.dz = dz;
      const mesh = byId(drag.id);
      mesh.position.x = drag.startPos.x + dx;
      mesh.position.z = drag.startPos.z + dz;
    },
    endMove() {
      if (!drag) return;
      const { id, startPos, dx, dz } = drag;
      drag = null;
      controls.enabled = true;
      if (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6) {
        record({ op: 'move', part: id, dx, dz }, () => byId(id).position.copy(startPos));
      } else notify();
    },

    // Rotate about the part's own vertical axis through its bbox centre.
    rotateSelected(dy) {
      const id = selectedId;
      const mesh = byId(id);
      if (!mesh || !dy) return;
      const now = performance.now();
      // A wheel spin is dozens of ticks; log it as one edit and undo it as one.
      const same = lastRotate && lastRotate.id === id && now - lastRotate.time < ROTATE_COALESCE_MS
        && edits[edits.length - 1] === lastRotate.edit;
      const before = same ? null : { pos: mesh.position.clone(), rotY: mesh.rotation.y };

      // Pivot in the parent's frame: mesh.position is parent-local and the scan root is offset.
      const c = mesh.parent.worldToLocal(worldBox(mesh).getCenter(new THREE.Vector3()));
      const dx = mesh.position.x - c.x, dz = mesh.position.z - c.z;
      const cos = Math.cos(dy), sin = Math.sin(dy);
      // Rotation about +Y by dy maps (x,z) -> (x cos + z sin, -x sin + z cos).
      mesh.position.x = c.x + dx * cos + dz * sin;
      mesh.position.z = c.z - dx * sin + dz * cos;
      mesh.rotation.y += dy;

      if (same) {
        lastRotate.edit.dy += dy;
        lastRotate.time = now;
        notify();
      } else {
        const edit = { op: 'rotate', part: id, dy };
        lastRotate = { id, edit, time: now };
        record(edit, () => { mesh.position.copy(before.pos); mesh.rotation.y = before.rotY; });
      }
    },

    hideSelected() {
      const id = selectedId;
      const mesh = byId(id);
      if (!mesh) return;
      mesh.visible = false;
      selectedId = hoverId = null;
      record({ op: 'hide', part: id }, () => { mesh.visible = true; });
    },

    showAll() {
      const hidden = parts.filter((p) => !p.mesh.visible);
      if (!hidden.length) return;
      hidden.forEach((p) => { p.mesh.visible = true; });
      record({ op: 'showAll' }, () => hidden.forEach((p) => { p.mesh.visible = false; }));
    },

    undo() {
      if (drag) return;
      const fn = undoStack.pop();
      if (!fn) return;
      edits.pop();
      lastRotate = null;
      fn();
      // Undoing a hide/move may leave the selection pointing at something now hidden.
      if (selectedId != null && !byId(selectedId)?.visible) selectedId = null;
      notify();
    },

    state() {
      const sel = byId(selectedId);
      let selection = null;
      if (sel) {
        const s = worldBox(sel).getSize(new THREE.Vector3());
        selection = { id: selectedId, size: [s.x, s.z, s.y] }; // W x D x H, axis-aligned
      }
      return { mode, parts: parts.length, hidden: hiddenCount(), selection, edits: edits.length };
    },
    get mode() { return mode; },
    get selectedId() { return selectedId; },
    get hoverId() { return hoverId; },
    get dragging() { return !!drag; },

    // Per frame: at most one raycast, however many pointermoves arrived.
    tick() {
      if (mode !== 'object' || drag || !pendingMove) return;
      const { x, y } = pendingMove;
      pendingMove = null;
      api.hover(pick(x, y));
    },
    refresh: notify
  };

  // ---- mouse wiring -------------------------------------------------------------------
  // Capture phase so we can switch controls off BEFORE OrbitControls' own pointerdown runs.
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'object' || e.button !== 0) return;
    const id = pick(e.clientX, e.clientY);
    api.select(id);
    if (id == null) return; // empty space: orbit still works
    const mesh = byId(id);
    const centre = worldBox(mesh).getCenter(new THREE.Vector3());
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -centre.y);
    const start = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(plane, start)) return;
    api.beginMove(id, plane, start);
    drag.px = e.clientX; drag.py = e.clientY; drag.armed = false;
    canvas.setPointerCapture(e.pointerId);
  }, true);

  canvas.addEventListener('pointermove', (e) => {
    if (mode !== 'object') return;
    if (!drag) { pendingMove = { x: e.clientX, y: e.clientY }; return; }
    // Ignore jitter so a plain click never nudges the part or logs an edit.
    if (!drag.armed) {
      if (Math.hypot(e.clientX - drag.px, e.clientY - drag.py) < DRAG_THRESHOLD_PX) return;
      drag.armed = true;
    }
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(drag.plane, hit)) {
      api.moveBy(hit.x - drag.startHit.x, hit.z - drag.startHit.z);
    }
  });

  const release = () => api.endMove();
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { pendingMove = null; if (!drag) api.hover(null); });

  // Shift+wheel rotates the selection. macOS turns Shift+wheel into a horizontal scroll
  // (deltaX), so read whichever axis carries the motion. Capture + stop so it never zooms.
  canvas.addEventListener('wheel', (e) => {
    if (mode !== 'object' || !e.shiftKey || selectedId == null) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    api.rotateSelected((e.deltaY || e.deltaX) * ROTATE_PER_WHEEL_UNIT);
  }, { capture: true, passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input, textarea')) return;
    const k = e.key;
    if (k === 'Tab') { e.preventDefault(); api.toggleMode(); return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); api.undo(); return; }
    if (mode !== 'object') return;
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); api.hideSelected(); }
    else if (k.toLowerCase() === 'h') api.showAll();
    else if (k === 'Escape') api.select(null);
  });

  return api;
}

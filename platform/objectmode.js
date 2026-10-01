import * as THREE from 'three';

// Scene mode / object mode, following Quest/visionOS practice: in scene mode input moves the
// camera; in object mode a ray highlights the part under the pointer BEFORE anything is
// committed, a click selects, and edits then apply to the selection only.
//
// Everything that changes the scene goes through the small action API returned below
// (select, beginMove/moveBy/endMove, rotateSelected, scaleTarget, hideSelected, showAll,
// undo). The mouse handlers are just one caller of it, so hand gestures can drive the same
// actions later without touching the edit log or undo logic.
//
// TARGETS. A target is either a part (its id, e.g. '3.2') or a whole library item
// ('item:3', see itemKey). Parts sit under their item's root, so editing an item moves,
// rotates or scales all of its parts together.
//
// HISTORY. `edits` is the complete, replayable history (a SceneScript-style command list).
// Every entry is self-contained JSON:
//   { seq, t, at, op, item, part, before:{position,quaternion,scale,visible}, after:{...}, ... }
//     seq  increasing id, unique for the session
//     t    ms since this session started; at: the ISO wall-clock time
//     op   move | rotate | scale | hide | show | showAll | arrange | importLayout
//     part the part id, or null when the edit targets the whole item
//   Edits touching several targets at once (showAll, arrange, importLayout) carry
//   `changes: [{ item, part, before, after }]` instead of one top-level before/after.
//   Human-readable extras ride along (dx/dz for move, dy for rotate, factor for scale).
//   Other modules may add their own ops (polygon.js: polyHide, polyInfer) whose entries carry
//   no transform states; they register an applier with registerOp(op, fn(entry, 'before'|
//   'after')) and undo / replayTo / adoptHistory call it instead of applying states.
// Undo applies `before`, so it is exact, and replayTo(seq) rebuilds any point of the
// history from the states alone. That is what a later timelapse plays back.

// Wheel steps, per 100 px of normalised wheel delta (one mouse-wheel notch in Chrome/Safari).
// Were 0.5 rad (29°) and ×1.1 per notch, too coarse to line anything up. A trackpad sends
// the same total as many small deltas, so a two-finger swipe of one notch's length turns
// exactly as far as one notch does.
const ROTATE_PER_NOTCH = Math.PI / 24;  // 7.5° per notch
const SCALE_PER_NOTCH = 0.05;           // ×1.05 per notch (exp(0.05) = 1.051)
const NOTCH_PX = 100;
const LINE_PX = 40;                     // deltaMode 1 (Firefox mouse wheels report lines)
const PAGE_PX = 800;                    // deltaMode 2
const MAX_WHEEL_PX = 2 * NOTCH_PX;      // one event never turns more than two notches' worth
const COALESCE_MS = 600;             // wheel ticks within this window are one rotate/scale edit
const DRAG_THRESHOLD_PX = 3;         // below this a press is a click, not a move
// Drag follow: the part eases toward the cursor with this time constant, applied once per
// display frame from the newest pointer position. Trackpads and high-DPI mice deliver
// pointermoves unevenly (0, 1 or 3 per frame), which made the dragged part step unevenly;
// 25 ms evens that out without a visible lag, and release always lands exactly on the cursor.
const DRAG_TAU_S = 0.025;
// A drag ray within this angle (sin) of the horizontal drag plane is ignored: near the
// horizon the plane hit runs off toward infinity and one pixel flung the part metres away.
const MIN_RAY_PLANE_SIN = Math.sin((3 * Math.PI) / 180);

// Wheel delta in pixels, whatever unit the browser reported it in.
export function wheelPixels(e) {
  const k = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
  // macOS turns Shift+wheel into a horizontal scroll, so take whichever axis carries it.
  const d = (Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * k;
  return Math.max(-MAX_WHEEL_PX, Math.min(MAX_WHEEL_PX, d || 0));
}
const SCALE_MIN = 0.05, SCALE_MAX = 20; // absolute scale limits, so a slip can't make a part vanish

export const itemKey = (itemId) => `item:${itemId}`;
export const isItemKey = (k) => typeof k === 'string' && k.startsWith('item:');

// Full precision on purpose: replay must land on the exact same numbers, not rounded ones.
export const snapshot = (o) => ({
  position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray(), visible: o.visible
});
function applyState(o, s) {
  if (!o || !s) return;
  o.position.fromArray(s.position);
  o.quaternion.fromArray(s.quaternion);
  o.scale.fromArray(s.scale);
  o.visible = s.visible;
  o.updateMatrixWorld(true);
}
export const changesOf = (e) => e.changes
  ?? (e.before || e.after ? [{ item: e.item, part: e.part ?? null, before: e.before, after: e.after }] : []);
const sameState = (a, b, eps = 1e-6) => a.visible === b.visible
  && ['position', 'quaternion', 'scale'].every((k) => a[k].every((v, i) => Math.abs(v - b[k][i]) <= eps));

export function createObjectMode({ camera, canvas, controls, materialFor, edits, onChange }) {
  let parts = [];              // [{id, mesh}]
  const roots = new Map();     // String(itemId) -> item root (Group)
  const rootIds = new Map();   // String(itemId) -> the item id as main gave it (number today)
  let mode = 'scene';
  let hoverId = null;          // part id or itemKey
  let selectedId = null;       // part id or itemKey
  const legacyUndo = new WeakMap(); // entry -> closure, only for callers that pass one without states
  const opAppliers = new Map();     // op -> fn(entry, 'before'|'after'), for ops other modules own
  let seq = 0;
  const T0 = performance.now();
  let drag = null;             // {id, startPos, before, plane, startHit, dx, dz}
  let lastWheel = null;        // {kind, id, edit, time} for coalescing wheel ticks
  let replayCursor = null;     // seq the scene is scrubbed to by replayTo, or null when live
  let pendingMove = null;      // latest pointer position awaiting the per-frame hover pick
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const byId = (id) => parts.find((p) => p.id === id)?.mesh ?? null;
  const target = (key) => (isItemKey(key) ? roots.get(key.slice(5)) ?? null : byId(key));
  const resolve = (item, part) => (part != null ? byId(part) : roots.get(String(item)) ?? null);
  const itemOf = (key) => (isItemKey(key) ? rootIds.get(key.slice(5)) ?? key.slice(5) : byId(key)?.userData.itemId ?? null);
  // Visible means the target AND every ancestor (a hidden library item hides all its parts).
  const shown = (m) => { for (let o = m; o; o = o.parent) if (!o.visible) return false; return true; };
  const visibleMeshes = () => parts.filter((p) => shown(p.mesh)).map((p) => p.mesh);
  const hiddenCount = () => parts.filter((p) => !p.mesh.visible).length + [...roots.values()].filter((r) => !r.visible).length;
  const lastSeq = () => (edits.length ? edits[edits.length - 1].seq ?? 0 : 0);

  function paint() {
    const selItem = isItemKey(selectedId) ? selectedId.slice(5) : null;
    const hovItem = isItemKey(hoverId) ? hoverId.slice(5) : null;
    for (const { id, mesh } of parts) {
      const it = String(mesh.userData.itemId);
      const kind = id === selectedId || it === selItem ? 'selected' : id === hoverId || it === hovItem ? 'hover' : 'base';
      mesh.material = materialFor(kind, mesh);
    }
  }

  function notify() {
    paint();
    canvas.style.cursor = drag ? 'grabbing' : mode === 'object' ? (hoverId && !isItemKey(hoverId) ? 'pointer' : 'crosshair') : '';
    onChange?.(api.state());
  }

  // Appends one history entry. `edit` should carry before/after (or changes); a legacy
  // `undo` closure is still accepted for callers that have no states to give.
  function record(edit, undo) {
    // Multi-model: every part edit carries the id of the library item it belongs to.
    if (edit.part != null && edit.item == null) edit.item = byId(edit.part)?.userData.itemId ?? null;
    const now = performance.now();
    const entry = { seq: ++seq, t: Math.round(now - T0), at: new Date().toISOString(), ...edit };
    edits.push(entry);
    if (undo && !edit.before && !edit.changes) legacyUndo.set(entry, undo);
    replayCursor = null;
    notify();
    return entry;
  }

  function applyEntry(e, which) {
    const own = opAppliers.get(e.op);
    if (own) { own(e, which); return; }
    const list = changesOf(e);
    const ordered = which === 'before' ? [...list].reverse() : list;
    for (const c of ordered) applyState(resolve(c.item, c.part), c[which]);
  }

  // Replaying leaves the scene scrubbed; any new edit first snaps back to the live state so
  // the history stays one unbroken chain.
  function ensureLive() {
    if (replayCursor != null && replayCursor < lastSeq()) api.replayTo(Infinity);
    replayCursor = null;
  }

  function pick(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    // Only visible parts: Raycaster ignores .visible, and a hidden part must not be grabbable.
    const hit = raycaster.intersectObjects(visibleMeshes(), false)[0];
    return hit ? hit.object.userData.partId : null;
  }

  // Box of what is drawn under `o` (hidden parts of an item don't count).
  function worldBox(o) {
    o.updateWorldMatrix(true, true);
    if (o.isMesh) return new THREE.Box3().setFromObject(o);
    const box = new THREE.Box3(), b = new THREE.Box3();
    o.traverse((c) => { if ((c.isMesh || c.isPoints) && shown(c)) box.union(b.setFromObject(c)); });
    return box.isEmpty() ? box.setFromObject(o) : box;
  }

  // Coalesces wheel ticks on the same target into one entry (and one undo step).
  function wheelEdit(kind, key, now) {
    const same = lastWheel && lastWheel.kind === kind && lastWheel.id === key && now - lastWheel.time < COALESCE_MS
      && edits[edits.length - 1] === lastWheel.edit;
    return same ? lastWheel.edit : null;
  }

  const api = {
    edits,
    snapshot,
    changesOf,
    itemKey,
    isItemKey,

    // Called by main when a new scan replaces the old one.
    setParts(newParts) {
      parts = newParts;
      hoverId = selectedId = drag = lastWheel = null;
      edits.length = 0;
      notify();
    },

    // Multi-model support: parts are added/removed per library item without clearing the log.
    addParts(list) { parts = parts.concat(list); notify(); },
    // The item root is a target too (whole-object move / rotate / scale / hide).
    addItem(itemId, root) { roots.set(String(itemId), root); rootIds.set(String(itemId), itemId); notify(); },
    removeItem(itemId) {
      const key = String(itemId);
      const gone = new Set(parts.filter((p) => String(p.mesh.userData.itemId) === key).map((p) => p.id));
      parts = parts.filter((p) => !gone.has(p.id));
      roots.delete(key);
      rootIds.delete(key);
      for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i];
        if (e.changes) {
          e.changes = e.changes.filter((c) => String(c.item) !== key);
          if (e.items) e.items = e.items.filter((x) => String(x.item ?? x) !== key);
          if (!e.changes.length) edits.splice(i, 1);
        } else if (String(e.item) === key) edits.splice(i, 1);
      }
      const drop = (k) => k != null && (gone.has(k) || k === itemKey(key));
      if (drop(hoverId)) hoverId = null;
      if (drop(selectedId)) selectedId = null;
      lastWheel = null;
      notify();
    },
    record(edit, undo) { ensureLive(); lastWheel = null; return record(edit, undo); },
    ensureLive,
    // Lets another module own an op in the shared log (see HISTORY above). The applier must
    // be idempotent: replayTo calls it with 'before' for every entry, then 'after' forward.
    registerOp(op, fn) { opAppliers.set(op, fn); },
    resolve,
    target,

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
      if (id != null && !shown(target(id) ?? { visible: false })) id = null;
      if (id !== selectedId) { selectedId = id; lastWheel = null; notify(); }
    },
    selectItem(itemId) { api.select(itemId == null ? null : itemKey(itemId)); },
    pick,

    // Move: live while dragging, committed as ONE edit with the total offset on endMove.
    // Y is never touched, so the target keeps its height. `plane` is horizontal at the
    // target's bbox centre so the cursor stays glued to the point that was grabbed.
    beginMove(id, plane, startHit) {
      ensureLive();
      const obj = target(id);
      if (!obj) return false;
      drag = { id, startPos: obj.position.clone(), before: snapshot(obj), plane, startHit, dx: 0, dz: 0 };
      controls.enabled = false;   // orbit must not fight the drag
      notify();
      return true;
    },
    moveBy(dx, dz) {
      if (!drag) return;
      drag.dx = dx; drag.dz = dz;
      const obj = target(drag.id);
      // dx/dz are world offsets; convert through the parent in case it is scaled/rotated.
      const w = obj.parent.localToWorld(drag.startPos.clone());
      w.x += dx; w.z += dz;
      obj.position.copy(obj.parent.worldToLocal(w));
      obj.updateMatrixWorld(true);
    },
    endMove() {
      if (!drag) return;
      // Finish any easing still in flight so the edit records where the cursor actually was.
      if (drag.armed && drag.goal && (drag.goal.dx !== drag.dx || drag.goal.dz !== drag.dz)) api.moveBy(drag.goal.dx, drag.goal.dz);
      const { id, dx, dz, before } = drag;
      drag = null;
      controls.enabled = true;
      const obj = target(id);
      if (obj && (Math.abs(dx) > 1e-6 || Math.abs(dz) > 1e-6)) {
        lastWheel = null;
        record({ op: 'move', item: itemOf(id), part: isItemKey(id) ? null : id, dx, dz, before, after: snapshot(obj) });
      } else notify();
    },

    // Rotate about the target's own vertical axis through its bbox centre.
    rotateTarget(id, dy) {
      const obj = target(id);
      if (!obj || !dy) return;
      ensureLive();
      const now = performance.now();
      const merge = wheelEdit('rotate', id, now);
      const before = merge ? null : snapshot(obj);

      // Pivot in the parent's frame: position is parent-local and the scan root is offset.
      const c = obj.parent.worldToLocal(worldBox(obj).getCenter(new THREE.Vector3()));
      const dx = obj.position.x - c.x, dz = obj.position.z - c.z;
      const cos = Math.cos(dy), sin = Math.sin(dy);
      // Rotation about +Y by dy maps (x,z) -> (x cos + z sin, -x sin + z cos).
      obj.position.x = c.x + dx * cos + dz * sin;
      obj.position.z = c.z - dx * sin + dz * cos;
      obj.rotation.y += dy;
      obj.updateMatrixWorld(true);

      if (merge) {
        merge.dy += dy;
        merge.after = snapshot(obj);
        lastWheel.time = now;
        notify();
      } else {
        const edit = record({ op: 'rotate', item: itemOf(id), part: isItemKey(id) ? null : id, dy, before, after: snapshot(obj) });
        lastWheel = { kind: 'rotate', id, edit, time: now };
      }
    },
    rotateSelected(dy) { api.rotateTarget(selectedId, dy); },

    // Scale = redesign. Uniform, about the part's own bbox centre; a whole item scales about
    // its bottom centre so it keeps standing on the floor. `coalesce` merges wheel ticks.
    scaleTarget(id, factor, { coalesce = false } = {}) {
      const obj = target(id);
      if (!obj || !(factor > 0) || !Number.isFinite(factor)) return null;
      ensureLive();
      const cur = obj.scale.x;
      const next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, cur * factor));
      const f = next / cur;
      if (Math.abs(f - 1) < 1e-9) return null;
      const now = performance.now();
      const merge = coalesce ? wheelEdit('scale', id, now) : null;
      const before = merge ? null : snapshot(obj);

      const box = worldBox(obj);
      const pivot = box.getCenter(new THREE.Vector3());
      if (isItemKey(id)) pivot.y = box.min.y;
      // Keep the pivot fixed: p' = c + f (p - c), all in the parent's frame.
      const c = obj.parent.worldToLocal(pivot);
      obj.position.sub(c).multiplyScalar(f).add(c);
      obj.scale.multiplyScalar(f);
      obj.updateMatrixWorld(true);

      if (merge) {
        merge.factor *= f;
        merge.after = snapshot(obj);
        lastWheel.time = now;
        notify();
        return merge;
      }
      const edit = record({ op: 'scale', item: itemOf(id), part: isItemKey(id) ? null : id, factor: f, before, after: snapshot(obj) });
      lastWheel = coalesce ? { kind: 'scale', id, edit, time: now } : null;
      return edit;
    },
    scaleSelected(factor, opts) { return api.scaleTarget(selectedId, factor, opts); },

    hideSelected() {
      const id = selectedId;
      const obj = target(id);
      if (!obj) return;
      api.setVisible(id, false);
      selectedId = hoverId = null;
      notify();
    },
    // Hide/show one target as a recorded edit (library Hide/Show goes through here too).
    setVisible(id, visible) {
      const obj = target(id);
      if (!obj || obj.visible === visible) return;
      ensureLive();
      lastWheel = null;
      const before = snapshot(obj);
      obj.visible = visible;
      if (!visible && selectedId != null && !shown(target(selectedId) ?? { visible: false })) selectedId = null;
      record({ op: visible ? 'show' : 'hide', item: itemOf(id), part: isItemKey(id) ? null : id, before, after: snapshot(obj) });
    },

    showAll() {
      ensureLive();
      const hiddenParts = parts.filter((p) => !p.mesh.visible);
      const hiddenRoots = [...roots.entries()].filter(([, r]) => !r.visible);
      if (!hiddenParts.length && !hiddenRoots.length) return;
      const changes = [];
      const change = (item, part, obj) => {
        const before = snapshot(obj);
        obj.visible = true;
        changes.push({ item, part, before, after: snapshot(obj) });
      };
      for (const [k, r] of hiddenRoots) change(rootIds.get(k) ?? k, null, r);
      for (const p of hiddenParts) change(p.mesh.userData.itemId ?? null, p.id, p.mesh);
      lastWheel = null;
      record({ op: 'showAll', changes });
    },

    undo() {
      if (drag) return;
      ensureLive();
      const e = edits.pop();
      if (!e) return;
      lastWheel = null;
      const fn = legacyUndo.get(e);
      if (fn) fn(); else applyEntry(e, 'before');
      // Undoing a hide/move may leave the selection pointing at something now hidden.
      if (selectedId != null && !shown(target(selectedId) ?? { visible: false })) selectedId = null;
      notify();
    },

    // Rebuild the scene as it was right after edit `toSeq` (0 = as loaded, Infinity = now):
    // unwind every entry's `before` back to the original, then apply `after` forward up to
    // toSeq. Uses only the states in the log, so an exported history replays the same way.
    replayTo(toSeq = Infinity) {
      if (drag) api.endMove();
      lastWheel = null;
      for (let i = edits.length - 1; i >= 0; i--) applyEntry(edits[i], 'before');
      let applied = 0;
      for (const e of edits) {
        if ((e.seq ?? 0) > toSeq) break;
        applyEntry(e, 'after');
        applied++;
      }
      replayCursor = applied === edits.length ? null : (edits[applied - 1]?.seq ?? 0);
      if (selectedId != null && !shown(target(selectedId) ?? { visible: false })) selectedId = null;
      notify();
      return applied;
    },
    get replayCursor() { return replayCursor; },

    // Adopt a history exported from an earlier session (entries already remapped to the
    // loaded ids). Only onto an unedited session whose objects are exactly where that
    // history started, so the chain stays true. Returns false when it can't be adopted.
    adoptHistory(list) {
      if (edits.length || !list.length) return false;
      const first = new Map();
      for (const e of list) {
        if (opAppliers.has(e.op)) continue;   // the owning module checks its own entries
        const ch = changesOf(e);
        if (!ch.length || ch.some((c) => !c.before || !c.after || !resolve(c.item, c.part))) return false;
        for (const c of ch) { const k = `${c.item}|${c.part}`; if (!first.has(k)) first.set(k, c); }
      }
      for (const c of first.values()) if (!sameState(snapshot(resolve(c.item, c.part)), c.before)) return false;
      for (const e of list) {
        edits.push(e);
        seq = Math.max(seq, e.seq ?? 0);
        applyEntry(e, 'after');
      }
      replayCursor = null;
      lastWheel = null;
      notify();
      return true;
    },

    state() {
      const sel = target(selectedId);
      let selection = null;
      if (sel) {
        const s = worldBox(sel).getSize(new THREE.Vector3());
        selection = { id: selectedId, kind: isItemKey(selectedId) ? 'item' : 'part', size: [s.x, s.z, s.y] }; // W x D x H, axis-aligned
      }
      return { mode, parts: parts.length, hidden: hiddenCount(), selection, edits: edits.length };
    },
    get mode() { return mode; },
    get selectedId() { return selectedId; },
    get hoverId() { return hoverId; },
    get dragging() { return !!drag; },
    get sessionStart() { return T0; },

    // Per frame: at most one raycast, however many pointermoves arrived.
    tick(now = performance.now()) {
      if (drag) { stepDrag(now); return; }
      if (mode !== 'object' || !pendingMove) return;
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
    // With a whole item selected, grabbing any of its parts drags the whole item.
    const wholeItem = id != null && isItemKey(selectedId) && String(byId(id)?.userData.itemId) === selectedId.slice(5);
    const moveId = wholeItem ? selectedId : id;
    if (!wholeItem) api.select(id);
    if (id == null) return; // empty space: orbit still works
    const centre = worldBox(target(moveId)).getCenter(new THREE.Vector3());
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -centre.y);
    const start = new THREE.Vector3();
    // Grazing the drag plane (camera near the part's own height): the hit is unreliable and
    // would fling the part, so leave this press to orbit instead of starting a drag.
    if (Math.abs(raycaster.ray.direction.dot(plane.normal)) < MIN_RAY_PLANE_SIN) return;
    if (!raycaster.ray.intersectPlane(plane, start)) return;
    api.beginMove(moveId, plane, start);
    drag.px = e.clientX; drag.py = e.clientY; drag.armed = false; drag.goal = null; drag.lastStep = null;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
  }, true);

  // Where the cursor's ray meets the drag plane, as a world offset from the grab point, or
  // null when the ray is (nearly) parallel to the plane or points away from it.
  function dragOffsetAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (Math.abs(raycaster.ray.direction.dot(drag.plane.normal)) < MIN_RAY_PLANE_SIN) return null;
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(drag.plane, hit)) return null;
    return { dx: hit.x - drag.startHit.x, dz: hit.z - drag.startHit.z };
  }

  // Once per display frame while dragging: ease toward the newest cursor offset.
  function stepDrag(now) {
    if (!drag || !drag.armed || !drag.goal) return;
    const dt = drag.lastStep == null ? 1 / 60 : Math.min(0.1, Math.max(0, (now - drag.lastStep) / 1000));
    drag.lastStep = now;
    const a = 1 - Math.exp(-dt / DRAG_TAU_S);
    let dx = drag.dx + (drag.goal.dx - drag.dx) * a;
    let dz = drag.dz + (drag.goal.dz - drag.dz) * a;
    if (Math.hypot(drag.goal.dx - dx, drag.goal.dz - dz) < 1e-5) { dx = drag.goal.dx; dz = drag.goal.dz; }
    if (dx !== drag.dx || dz !== drag.dz) api.moveBy(dx, dz);
  }

  canvas.addEventListener('pointermove', (e) => {
    if (mode !== 'object') return;
    if (!drag) { pendingMove = { x: e.clientX, y: e.clientY }; return; }
    // Ignore jitter so a plain click never nudges the part or logs an edit.
    if (!drag.armed) {
      if (Math.hypot(e.clientX - drag.px, e.clientY - drag.py) < DRAG_THRESHOLD_PX) return;
      drag.armed = true;
    }
    const off = dragOffsetAt(e.clientX, e.clientY);
    if (off) drag.goal = off;
  });

  // Release lands exactly where the cursor is (not wherever the easing had got to), so the
  // recorded edit is the true drop point.
  canvas.addEventListener('pointerup', (e) => {
    if (drag?.armed) {
      const off = dragOffsetAt(e.clientX, e.clientY);
      if (off) drag.goal = off;
    }
    api.endMove();
  });
  // A cancelled pointer has no trustworthy position: keep the last one seen.
  canvas.addEventListener('pointercancel', () => api.endMove());
  canvas.addEventListener('pointerleave', () => { pendingMove = null; if (!drag) api.hover(null); });

  // Shift+wheel rotates the selection, Alt/Option+wheel scales it. Deltas are normalised to
  // pixels (wheelPixels) so wheels, trackpads and line-mode browsers turn the same amount for
  // the same gesture. Capture + stop so it never zooms the camera.
  canvas.addEventListener('wheel', (e) => {
    if (mode !== 'object' || selectedId == null || !(e.shiftKey || e.altKey)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const notches = wheelPixels(e) / NOTCH_PX;
    if (!notches) return;
    if (e.shiftKey) api.rotateSelected(notches * ROTATE_PER_NOTCH);
    else api.scaleSelected(Math.exp(-notches * SCALE_PER_NOTCH), { coalesce: true });
  }, { capture: true, passive: false });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches?.('input, textarea, select')) return;
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

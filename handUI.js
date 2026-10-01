// Hands on the page (plans/platform/HANDS-UX-SPEC.md section 2): the hand cursor works the
// page's own buttons, sliders, lists and scroll areas, not only the 3D scene. The hands runtime
// (handsRuntime.js) owns the pointer and the clicks; this module only answers "what DOM element
// is the hand on, and what does a pinch there do", and draws the hover ring. Also the camera
// "remember + auto-start" helpers both pages share (spec section 3).
//
// CONTRACT
//   createHandUI({ canvas, doc?, win?, magnetPx?, switchRatio?, minTargetPx?, onAction? }) -> ui
//     canvas: the 3D canvas. A cursor over it (or over a bare canvas / video / its stage box) is
//       "in the scene"; anything else the page draws there is "over the UI".
//     magnetPx (24): an interactive element whose rect, grown by this much, holds the cursor
//       becomes the target. switchRatio (1.3): the target only changes to another candidate
//       that is this many times closer (edge distance; 0 inside). minTargetPx (48): while
//       body.hands-on is set, every target's rect is first grown to at least this size around
//       its centre (a padded hit area: no layout changes, the top bar stays as it is).
//     onAction(type, detail): 'click' | 'drag-start' | 'drag-end' | 'scroll' | 'type' (see below).
//   ui.update({ px, pinchHeld, nowMs }) -> { overUi, target, surface }   every display frame.
//     px: { x, y } page (client) px of the hand cursor, or null (no hand cursor: hides the ring,
//     ends a drag as a release). pinchHeld: the clicking hand is still pinched (handsRuntime
//     pinchHeld); a false after a press is the release.
//   ui.overUiAt(px) -> bool   would a click at px go to the page (not the 3D pick)?
//   ui.press({ px, tap? }) -> 'click' | 'drag' | 'scroll' | 'surface' | 'type' | 'none'
//     A hand click while over the UI (the other hand's pinch onset). Buttons and links click at
//     their CENTRE at once (pointerdown, mousedown, click; pointerup / mouseup follow on release,
//     so press-and-hold buttons work). A range input starts a slider drag (input events while
//     moving, change on release; gain halves below 5 cm/s). Inside a scroll area the click waits
//     for the release: moved > SCROLL_SLOP_PX = a touch-like scroll with momentum, else a click.
//     A [data-hand="surface"] element gets raw pointer events at the cursor (the Library ring).
//     A select steps to its next option (change event); a text field is focused ('type').
//     tap: true (a same-hand pinch) releases straight away.
//   ui.release()   the pinch opened (also called by update() when pinchHeld goes false).
//   ui.setEnabled(on)  toggles body.hands-on and the ring/cursor layer.
//   ui.target (Element | null), ui.overUi, ui.dragging, ui.stats = { clicks, drags, scrolls,
//     surfaces, types }, ui.dispose().
//   Failure: never throws on a detached target (it just drops it); off-page px = not over the UI.
//
//   Camera start (spec section 3), shared by hologram.html and the Platform:
//   REMEMBER_KEY = 'hands.rememberCamera'   '1' (default when missing) | '0'
//   rememberCamera(storage?) -> bool;  setRememberCamera(on, storage?)
//   autoStartCamera({ start, button?, setStatus?, storage?, permissions? }) -> Promise<state>
//     state = 'started' | 'prompt' | 'denied' | 'off' (remember unchecked) | 'unsupported' | 'failed'
//     granted + remember on -> start(); prompt -> the button pulses (class hand-pulse) until
//     clicked; denied -> a status line saying how to unblock it.
//   mountRememberToggle(container, { storage? }) -> the <label> (checkbox, default on)
//
// PHOTOSAFETY (BUGS #14): the ring and the cursor only ever fade (>= 120 ms eases) and slide;
// the camera-button pulse is a 2.4 s glow (0.4 cycles/s, far under 3 flashes/s).

export const INTERACTIVE = [
  'button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
  '[role=button]', '[role=option]', '[role=tab]', '[role=menuitem]', '[role=checkbox]',
  '[data-hand]:not([data-hand=surface]):not([data-hand=off])'
].join(',');
export const MAGNET_PX = 24;
export const SWITCH_RATIO = 1.3;
export const MIN_TARGET_PX = 48;
const SCROLL_SLOP_PX = 10;        // a press inside a scroll area that moves less is a click
const CACHE_MS = 250;             // the candidate list is re-read at most this often
const SLOW_PX_PER_S = 190;        // 5 cm/s at ~38 px/cm (96 dpi): PRISM precision below this
const COAST_TAU_MS = 325;         // scroll momentum decay (iOS-like)
const POINTER_ID = 7731;          // synthetic pointerId for raw surface presses

const isRange = (el) => el?.tagName === 'INPUT' && el.type === 'range';
const isText = (el) => (el?.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number|)$/.test(el.type)) || el?.tagName === 'TEXTAREA' || el?.isContentEditable;
const disabled = (el) => !!(el.disabled || el.closest?.('[inert],[aria-disabled=true],[data-hand=off]'));

function edgeDist(r, x, y) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

export function createHandUI({
  canvas, doc = document, win = window,
  magnetPx = MAGNET_PX, switchRatio = SWITCH_RATIO, minTargetPx = MIN_TARGET_PX, onAction = null
} = {}) {
  const stats = { clicks: 0, drags: 0, scrolls: 0, surfaces: 0, types: 0 };
  let enabled = false;
  let target = null;          // the snapped interactive element
  let overUi = false;
  let surface = null;         // [data-hand=surface] under the cursor
  let lastPx = null;
  let press = null;           // the running press (see press())
  let coast = null;           // { el, vx, vy, t }
  let cache = { at: -Infinity, list: [] };

  // ---- the layer: hover ring + a small cursor while over the UI ------------------------------
  const style = doc.createElement('style');
  style.textContent = `
.hand-ui-ring{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483600;box-sizing:border-box;
  border:2px solid rgba(140,225,255,.85);border-radius:10px;box-shadow:0 0 10px rgba(110,210,255,.35);opacity:0;
  transition:opacity .15s ease,left .12s ease-out,top .12s ease-out,width .12s ease-out,height .12s ease-out,transform .12s ease-out}
.hand-ui-ring.on{opacity:1}.hand-ui-ring.down{transform:scale(.96)}
.hand-ui-cursor{position:fixed;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;pointer-events:none;z-index:2147483601;
  border:2px solid rgba(200,246,255,.9);border-radius:50%;opacity:0;transition:opacity .15s ease}
.hand-ui-cursor.on{opacity:1}
@keyframes hand-pulse{0%,100%{box-shadow:0 0 0 0 rgba(120,220,255,0)}50%{box-shadow:0 0 0 6px rgba(120,220,255,.45)}}
.hand-pulse{animation:hand-pulse 2.4s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.hand-ui-ring{transition:opacity .15s ease}.hand-pulse{animation:none;outline:2px solid rgba(120,220,255,.7)}}`;
  const ring = doc.createElement('div');
  ring.className = 'hand-ui-ring';
  const dot = doc.createElement('div');
  dot.className = 'hand-ui-cursor';
  for (const el of [ring, dot]) el.setAttribute('aria-hidden', 'true');
  doc.head.append(style);
  doc.body.append(ring, dot);

  const emit = (type, detail) => { try { onAction?.(type, detail); } catch (err) { console.warn('handUI: onAction threw', err); } };
  const handsOn = () => doc.body.classList.contains('hands-on');

  // The top element at a point that can be SEEN: an invisible layer that still takes pointer
  // events (a faded-out card at opacity 0) must not swallow the hand cursor.
  function hitAt(x, y) {
    const all = doc.elementsFromPoint ? doc.elementsFromPoint(x, y) : [doc.elementFromPoint(x, y)];
    for (const el of all) {
      if (!el || el === ring || el === dot) continue;
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      return el;
    }
    return null;
  }

  // Is this element "the scene" (3D pick territory) rather than page UI?
  function isScene(el) {
    if (!el || el === canvas) return true;
    const stage = canvas?.parentElement;
    if (!stage) return false;
    return el === stage || (stage.contains(el) && (el.tagName === 'CANVAS' || el.tagName === 'VIDEO'));
  }

  // The hit rect of an element: padded to minTargetPx in hands mode, then grown by magnetPx.
  function hitRect(el) {
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    if (handsOn()) {
      const padX = Math.max(0, (minTargetPx - r.width) / 2), padY = Math.max(0, (minTargetPx - r.height) / 2);
      left -= padX; right += padX; top -= padY; bottom += padY;
    }
    return { el, box: { left, top, right, bottom }, r };
  }

  // Interactive elements that can be seen and are not covered (re-read every CACHE_MS).
  function candidates(nowMs) {
    if (nowMs - cache.at < CACHE_MS) return cache.list;
    const list = [];
    const vw = win.innerWidth, vh = win.innerHeight;
    for (const el of doc.querySelectorAll(INTERACTIVE)) {
      if (el === ring || el === dot || disabled(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      // Covered by something else (a dialog, the ring overlay): the hit at its centre must be it.
      const cx = Math.min(vw - 1, Math.max(0, (r.left + r.right) / 2)), cy = Math.min(vh - 1, Math.max(0, (r.top + r.bottom) / 2));
      const top = hitAt(cx, cy);
      if (!top || !(top === el || el.contains(top) || top.closest?.(INTERACTIVE) === el)) continue;
      list.push(el);
    }
    cache = { at: nowMs, list };
    return list;
  }

  // The interactive element a cursor at px means, with magnetism and switch hysteresis.
  function resolve(px, nowMs, keep = target) {
    if (!px) return { el: null, hit: null };
    const hit = hitAt(px.x, px.y);
    const direct = hit?.closest?.(INTERACTIVE);
    if (direct && !disabled(direct) && direct !== ring && direct !== dot) return { el: direct, hit };
    let best = null, bestD = Infinity;
    for (const el of candidates(nowMs)) {
      const { box } = hitRect(el);
      const d = edgeDist(box, px.x, px.y);
      if (d > magnetPx || d >= bestD) continue;
      best = el; bestD = d;
    }
    if (keep && keep !== best && keep.isConnected) {
      const dk = edgeDist(hitRect(keep).box, px.x, px.y);
      // Keep the current target unless the new one is switchRatio times closer.
      if (dk <= magnetPx && !(bestD * switchRatio < dk)) return { el: keep, hit };
    }
    return { el: best, hit };
  }

  function centreOf(el) {
    const r = el.getBoundingClientRect();
    return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  }

  function fire(el, type, at, extra = {}) {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y, button: 0, buttons: type.endsWith('down') || type.endsWith('move') ? 1 : 0, view: win, ...extra };
    const Ctor = type.startsWith('pointer') && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
    const ev = type.startsWith('pointer') ? new Ctor(type, { pointerId: POINTER_ID, pointerType: 'pen', isPrimary: true, ...init }) : new Ctor(type, init);
    el.dispatchEvent(ev);
    return ev;
  }

  function scrollerOf(el) {
    for (let e = el; e && e !== doc.body && e !== doc.documentElement; e = e.parentElement) {
      const cs = win.getComputedStyle(e);
      const y = /(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1;
      const x = /(auto|scroll)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1;
      if (x || y) return e;
    }
    return null;
  }

  function showRing(el, down = false) {
    if (!el) { ring.classList.remove('on', 'down'); return; }
    const r = el.getBoundingClientRect();
    ring.style.left = `${r.left - 4}px`;
    ring.style.top = `${r.top - 4}px`;
    ring.style.width = `${r.width + 8}px`;
    ring.style.height = `${r.height + 8}px`;
    ring.classList.add('on');
    ring.classList.toggle('down', down);
  }

  function clickAt(el) {
    const at = centreOf(el);
    fire(el, 'pointerdown', at);
    fire(el, 'mousedown', at);
    if (typeof el.focus === 'function') { try { el.focus({ preventScroll: true }); } catch { /* not focusable */ } }
    // A dispatched click still runs the element's activation (checkbox toggles, links, submit)
    // and, unlike el.click(), carries the centre point for handlers that read clientX / Y.
    fire(el, 'click', at, { detail: 1 });
    stats.clicks++;
    emit('click', { el, label: labelOf(el) });
    return at;
  }

  const labelOf = (el) => (el.getAttribute?.('aria-label') || el.title || el.textContent || el.id || el.tagName).trim().slice(0, 60);

  function setRange(el, v) {
    const before = el.value;
    el.value = String(v);
    if (el.value !== before) el.dispatchEvent(new win.Event('input', { bubbles: true }));
  }

  function pressAt(px, { tap = false } = {}) {
    if (press) release();
    const nowMs = performance.now();
    const { el, hit } = resolve(px, nowMs);
    let kind = 'none';
    if (el && isRange(el)) {
      press = { kind: 'drag', el, x: px.x, v: Number(el.value), t: nowMs, lastX: px.x, lastT: nowMs };
      stats.drags++;
      emit('drag-start', { el, label: labelOf(el) });
      kind = 'drag';
    } else if (el && isText(el)) {
      el.focus?.({ preventScroll: true });
      stats.types++;
      emit('type', { el, label: labelOf(el) });
      kind = 'type';
    } else if (el?.tagName === 'SELECT') {
      const n = el.options.length;
      if (n) { el.selectedIndex = (el.selectedIndex + 1) % n; el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); }
      stats.clicks++;
      emit('click', { el, label: labelOf(el) });
      kind = 'click';
    } else if (el && scrollerOf(el)) {
      // In a list: wait for the release to tell a click from a scroll.
      press = { kind: 'pending', el, scroller: scrollerOf(el), x0: px.x, y0: px.y, sl: 0, st: 0, samples: [] };
      press.sl = press.scroller.scrollLeft; press.st = press.scroller.scrollTop;
      kind = 'scroll';
    } else if (el) {
      const at = clickAt(el);
      press = { kind: 'button', el, at };
      kind = 'click';
    } else {
      const surf = hit?.closest?.('[data-hand=surface]');
      const scroller = !surf && hit && !isScene(hit) ? scrollerOf(hit) : null;
      if (surf) {
        fire(surf, 'pointerdown', px);
        press = { kind: 'surface', el: surf, at: px };
        stats.surfaces++;
        kind = 'surface';
      } else if (scroller) {
        press = { kind: 'pending', el: null, scroller, x0: px.x, y0: px.y, sl: scroller.scrollLeft, st: scroller.scrollTop, samples: [] };
        kind = 'scroll';
      }
    }
    if (press) showRing(press.el ?? null, true);
    if (tap) release();
    return kind;
  }

  function movePress(px, nowMs) {
    if (!press || !px) return;
    if (press.kind === 'drag') {
      const el = press.el;
      const r = el.getBoundingClientRect();
      const min = Number(el.min || 0), max = Number(el.max || 100);
      const dt = Math.max(1, nowMs - press.lastT);
      const speed = Math.abs(px.x - press.lastX) / (dt / 1000);
      const gain = speed < SLOW_PX_PER_S ? 0.5 : 1;
      press.v += ((px.x - press.lastX) / Math.max(1, r.width)) * (max - min) * gain;
      press.v = Math.max(min, Math.min(max, press.v));
      press.lastX = px.x; press.lastT = nowMs;
      setRange(el, press.v);
    } else if (press.kind === 'pending' || press.kind === 'scrolling') {
      const dx = px.x - press.x0, dy = px.y - press.y0;
      if (press.kind === 'pending' && Math.hypot(dx, dy) > SCROLL_SLOP_PX) { press.kind = 'scrolling'; stats.scrolls++; emit('scroll', { el: press.scroller }); }
      if (press.kind === 'scrolling') {
        // Touch-like: the content follows the hand.
        press.scroller.scrollLeft = press.sl - dx;
        press.scroller.scrollTop = press.st - dy;
        press.samples.push({ t: nowMs, x: px.x, y: px.y });
        while (press.samples.length > 2 && nowMs - press.samples[0].t > 100) press.samples.shift();
      }
    } else if (press.kind === 'surface') {
      press.at = px;
      fire(press.el, 'pointermove', px);
    }
  }

  function release() {
    const p = press;
    press = null;
    ring.classList.remove('down');
    if (!p) return;
    if (p.kind === 'drag') {
      if (p.el.isConnected) p.el.dispatchEvent(new win.Event('change', { bubbles: true }));
      emit('drag-end', { el: p.el, value: p.el.value });
    } else if (p.kind === 'pending') {
      if (p.el?.isConnected) clickAt(p.el);
    } else if (p.kind === 'scrolling') {
      const a = p.samples[0], b = p.samples.at(-1);
      if (a && b && b.t > a.t) coast = { el: p.scroller, vx: -(b.x - a.x) / (b.t - a.t), vy: -(b.y - a.y) / (b.t - a.t), t: lastNow };
    } else if (p.kind === 'button') {
      if (p.el.isConnected) { fire(p.el, 'pointerup', p.at); fire(p.el, 'mouseup', p.at); }
    } else if (p.kind === 'surface') {
      if (p.el.isConnected) fire(p.el, 'pointerup', p.at);
    }
  }

  function stepCoast(nowMs) {
    if (!coast) return;
    const dt = Math.min(50, nowMs - coast.t);
    coast.t = nowMs;
    if (dt <= 0) return;
    coast.el.scrollLeft += coast.vx * dt;
    coast.el.scrollTop += coast.vy * dt;
    const k = Math.exp(-dt / COAST_TAU_MS);
    coast.vx *= k; coast.vy *= k;
    if (Math.hypot(coast.vx, coast.vy) < 0.02) coast = null;   // < 20 px/s
  }

  let lastNow = performance.now();   // the caller's clock (camera frame time in tests)
  function update({ px = null, pinchHeld = false, nowMs = performance.now() } = {}) {
    lastNow = nowMs;
    stepCoast(nowMs);
    lastPx = px;
    if (!enabled || !px) {
      if (press) release();
      target = null; overUi = false; surface = null;
      showRing(null);
      dot.classList.remove('on');
      return { overUi, target, surface };
    }
    if (press) {
      movePress(px, nowMs);
      if (!pinchHeld) release();
    }
    // During a press the target is locked (a slider keeps its thumb even if the hand drifts off).
    const res = press?.el ? { el: press.el, hit: hitAt(px.x, px.y) } : resolve(px, nowMs);
    target = res.el ?? null;
    surface = target ? null : res.hit?.closest?.('[data-hand=surface]') ?? null;
    overUi = !!target || !!press || (!!res.hit && !isScene(res.hit));
    showRing(target, !!press);
    dot.style.left = `${px.x}px`;
    dot.style.top = `${px.y}px`;
    dot.classList.toggle('on', overUi && !target);
    return { overUi, target, surface };
  }

  function overUiAt(px) {
    if (!enabled || !px) return false;
    const { el, hit } = resolve(px, performance.now());
    return !!el || (!!hit && !isScene(hit));
  }

  function setEnabled(on) {
    enabled = !!on;
    doc.body.classList.toggle('hands-on', enabled);
    cache.at = -Infinity;
    if (!enabled) update({ px: null });
  }

  return {
    update, press: (o = {}) => pressAt(o.px, o), release, overUiAt, setEnabled, resolve: (px) => resolve(px, performance.now(), null).el,
    get target() { return target; },
    get overUi() { return overUi; },
    get surface() { return surface; },
    get dragging() { return press?.kind ?? null; },
    get enabled() { return enabled; },
    get lastPx() { return lastPx; },
    stats,
    dispose() { setEnabled(false); ring.remove(); dot.remove(); style.remove(); }
  };
}

// ---- camera: remember + auto-start (spec section 3) ------------------------------------------
export const REMEMBER_KEY = 'hands.rememberCamera';
const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
export function rememberCamera(storage = store()) {
  try { return storage?.getItem(REMEMBER_KEY) !== '0'; } catch { return true; }
}
export function setRememberCamera(on, storage = store()) {
  try { storage?.setItem(REMEMBER_KEY, on ? '1' : '0'); } catch { /* private mode */ }
}

// The one non-hand step: the browser asks for camera permission once. After that, a page load
// starts the camera on its own (remember on + permission granted).
export async function autoStartCamera({ start, button = null, setStatus = () => {}, storage = store(), permissions = globalThis.navigator?.permissions } = {}) {
  if (!rememberCamera(storage)) return 'off';
  let state = null;
  try { state = (await permissions?.query?.({ name: 'camera' }))?.state ?? null; } catch { state = null; }   // Firefox < 132: no 'camera' name
  if (!state) return 'unsupported';
  if (state === 'granted') {
    try { return (await start()) === false ? 'failed' : 'started'; } catch { return 'failed'; }
  }
  if (state === 'prompt' && button) {
    button.classList.add('hand-pulse');
    button.addEventListener('click', () => button.classList.remove('hand-pulse'), { once: true });
    return 'prompt';
  }
  if (state === 'denied') setStatus('📷 The camera is blocked for this page · allow it in the address bar, then press Camera');
  return state;
}

export function mountRememberToggle(container, { storage = store() } = {}) {
  if (!container) return null;
  const label = document.createElement('label');
  label.className = 'hand-remember';
  label.style.cssText = 'display:flex;gap:6px;align-items:center;margin:8px 0;cursor:pointer';
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: rememberCamera(storage) });
  box.id = 'rememberCamera';
  box.addEventListener('change', () => setRememberCamera(box.checked, storage));
  label.append(box, document.createTextNode(' 📷 Remember the camera: turn it on when the page opens'));
  container.append(label);
  return label;
}

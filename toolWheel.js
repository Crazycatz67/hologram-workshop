// The ✌ tool wheel (HANDS-UX-SPEC section 4): hold ✌ for 650 ms and a six-slot marking menu
// opens where the hand cursor is, then stays put (it never follows the hand). Aim past 40% of
// its radius and that slot lights; pinch with the OTHER hand to run it. The centre is Help.
// Slots are fixed directions on every page, so they become muscle memory.
//
// CONTRACT
//   const wheel = createToolWheel({ items, parent?, radiusPx?, gate? })
//     items: [{ dir, icon, label, run(), enabled?() }]   dir is one of DIRS' keys or 'center'.
//       A missing direction draws an empty slot that can't be picked.
//     parent: where the wheel's element goes (default document.body).
//     gate: a holdGate.js gate to share; default makes its own ({ toolWheel: 'ring' }).
//   wheel.feed(hands, nowMs) -> { opened, closed, progress }   once per CAMERA frame, with the
//     runtime's annotated hands. ✌ (MediaPipe 'Victory') held through the hold gate opens the
//     wheel; ✌ again closes it. progress = the gate's visibleProgress while ✌ charges (draw it).
//   wheel.point(px | null, nowMs)   once per DISPLAY frame: the hand cursor in page px (null = no
//     cursor). Lights the slot it points into. Also runs the timeouts (5 s idle; rest = no raised
//     hand in feed() for restMs).
//   wheel.click() -> boolean   a click while the wheel is open: runs the lit slot (or Help in
//     the centre) and closes. Returns true when the wheel took the click, so the host must not
//     route it anywhere else. Returns false when closed.
//   wheel.open(px?, nowMs?) / wheel.close(why)   also for keys and the mouse (W opens at centre).
//   wheel.isOpen, wheel.lit ('center' | dir | null), wheel.el, wheel.on(type, fn), wheel.dispose()
//   Events: 'open' { x, y }, 'close' { why: 'pick'|'toggle'|'idle'|'rest'|'esc'|'api' },
//     'pick' { dir, label }.
//   Pure helper: sectorAt(dx, dy, radiusPx, deadFrac?) -> 'center' | dir   (screen px, y down)
//
// Photosafety (BUGS #14): the wheel fades in/out over 160 ms and a lit slot eases its fill over
// 120 ms; nothing blinks. Mouse users can click a slot directly.

import { createHoldGate } from './holdGate.js';

export const WHEEL = {
  radiusPx: 120,   // outer radius; slots are >= 96 px across (spec section 2)
  deadFrac: 0.4,   // inside 40% of the radius = centre (Help)
  idleMs: 5000,    // no new slot lit for this long -> close
  restMs: 700      // no raised hand for this long -> close (hands lowered). A missing cursor
                   // alone never closes it: the ✌ hand has no cursor until it points again.
};

// Slot centres in degrees, screen space (0 = right, 90 = down).
export const DIRS = { up: -90, upRight: -30, downRight: 30, down: 90, downLeft: 150, upLeft: -150 };

export function sectorAt(dx, dy, radiusPx, deadFrac = WHEEL.deadFrac) {
  if (Math.hypot(dx, dy) < radiusPx * deadFrac) return 'center';
  const a = (Math.atan2(dy, dx) * 180) / Math.PI;
  let best = null, bestD = Infinity;
  for (const [dir, c] of Object.entries(DIRS)) {
    const d = Math.abs(((a - c + 540) % 360) - 180);
    if (d < bestD) { bestD = d; best = dir; }
  }
  return best;
}

const CSS = `
.tool-wheel { position: fixed; z-index: 60; pointer-events: none; opacity: 0; transform: translate(-50%, -50%) scale(.92);
  transition: opacity 160ms ease-out, transform 160ms ease-out; }
.tool-wheel.open { opacity: 1; transform: translate(-50%, -50%) scale(1); pointer-events: auto; }
.tool-wheel svg { display: block; overflow: visible; }
.tool-wheel .tw-slot path { fill: rgba(14, 40, 56, .82); stroke: rgba(120, 220, 255, .45); stroke-width: 1.5; transition: fill 120ms ease-out, stroke 120ms ease-out; cursor: pointer; }
.tool-wheel .tw-slot.lit path { fill: rgba(40, 120, 160, .9); stroke: rgba(160, 235, 255, .95); }
.tool-wheel .tw-slot.off path { fill: rgba(14, 30, 40, .55); cursor: default; }
.tool-wheel .tw-slot.off text { opacity: .4; }
.tool-wheel text { fill: #dff6ff; font: 600 13px system-ui, sans-serif; text-anchor: middle; pointer-events: none; }
.tool-wheel text.tw-icon { font-size: 20px; }
.tool-wheel .tw-hint { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 10px); white-space: nowrap;
  font: 12px system-ui, sans-serif; color: #bfe9ff; background: rgba(8, 24, 34, .8); padding: 3px 8px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { .tool-wheel, .tool-wheel .tw-slot path { transition: none; } }
`;

function arcPath(cx, cy, r0, r1, a0, a1) {
  const rad = (d) => (d * Math.PI) / 180;
  const p = (r, a) => `${(cx + r * Math.cos(rad(a))).toFixed(2)} ${(cy + r * Math.sin(rad(a))).toFixed(2)}`;
  return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
}

export function createToolWheel({ items = [], parent = document.body, radiusPx = WHEEL.radiusPx, gate = null } = {}) {
  if (!document.getElementById('tool-wheel-css')) {
    const style = document.createElement('style');
    style.id = 'tool-wheel-css';
    style.textContent = CSS;
    document.head.append(style);
  }
  const byDir = new Map(items.map((it) => [it.dir, it]));
  const hold = gate ?? createHoldGate({ tiers: { toolWheel: 'ring' } });
  const listeners = new Map();
  const emit = (type, detail) => (listeners.get(type) ?? []).forEach((fn) => fn(detail));

  // ---- DOM ----------------------------------------------------------------------------------
  const R = radiusPx, R0 = R * WHEEL.deadFrac, size = R * 2 + 8, c = size / 2;
  const el = document.createElement('div');
  el.className = 'tool-wheel';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Tool wheel');
  el.setAttribute('aria-hidden', 'true');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const slots = new Map();
  const addSlot = (dir, d, tx, ty) => {
    const it = byDir.get(dir);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'tw-slot' + (it ? '' : ' off'));
    g.setAttribute('role', 'menuitem');
    g.dataset.dir = dir;
    if (it) g.setAttribute('aria-label', it.label);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    g.append(path);
    if (it) {
      const icon = document.createElementNS(NS, 'text');
      icon.setAttribute('class', 'tw-icon');
      icon.setAttribute('x', tx); icon.setAttribute('y', ty - 4);
      icon.textContent = it.icon ?? '';
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', tx); label.setAttribute('y', ty + 14);
      label.textContent = it.label;
      g.append(icon, label);
    }
    g.addEventListener('click', (e) => { e.stopPropagation(); pick(dir); });
    svg.append(g);
    slots.set(dir, g);
  };
  const GAP = 2;
  for (const [dir, a] of Object.entries(DIRS)) {
    const mid = (R0 + R) / 2, rad = (a * Math.PI) / 180;
    addSlot(dir, arcPath(c, c, R0 + GAP, R, a - 30 + GAP / 2, a + 30 - GAP / 2), c + mid * Math.cos(rad), c + mid * Math.sin(rad));
  }
  addSlot('center', `M ${c - R0} ${c} A ${R0} ${R0} 0 1 1 ${c + R0} ${c} A ${R0} ${R0} 0 1 1 ${c - R0} ${c} Z`, c, c);
  const hint = document.createElement('div');
  hint.className = 'tw-hint';
  hint.textContent = '☝ Aim at a tool · 🤏 pinch your other hand · ✌ again to close';
  el.append(svg, hint);
  parent.append(el);

  // ---- state --------------------------------------------------------------------------------
  let open = false, byHand = false, at = null, lit = null, litAt = 0, lastHandsAt = 0, lastCursor = null;
  const enabled = (dir) => { const it = byDir.get(dir); return !!it && (it.enabled ? it.enabled() !== false : true); };
  function setLit(dir, now) {
    if (dir === lit) return;
    if (lit) slots.get(lit)?.classList.remove('lit');
    lit = dir;
    litAt = now;
    if (lit) slots.get(lit)?.classList.add('lit');
  }
  function refreshEnabled() {
    for (const [dir, g] of slots) g.classList.toggle('off', !enabled(dir));
  }
  const onKey = (e) => { if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close('esc'); } };

  // byHand: opened by ✌ (rest / idle timeouts apply). W or the mouse: stays until a pick, Esc or W.
  function openWheel(px, now = performance.now(), hand = false) {
    byHand = hand;
    const p = px ?? lastCursor ?? { x: innerWidth / 2, y: innerHeight / 2 };
    // Keep the whole wheel on screen.
    at = { x: Math.min(innerWidth - R - 8, Math.max(R + 8, p.x)), y: Math.min(innerHeight - R - 40, Math.max(R + 8, p.y)) };
    el.style.left = at.x + 'px';
    el.style.top = at.y + 'px';
    refreshEnabled();
    open = true;
    lastHandsAt = now;
    setLit(null, now);
    litAt = now;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    addEventListener('keydown', onKey, true);
    emit('open', { x: at.x, y: at.y });
  }
  function close(why = 'api') {
    if (!open) return;
    open = false;
    setLit(null, 0);
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    removeEventListener('keydown', onKey, true);
    emit('close', { why });
  }
  function pick(dir) {
    if (!open || !dir || !enabled(dir)) return false;
    const it = byDir.get(dir);
    close('pick');
    emit('pick', { dir, label: it.label });
    try { it.run?.(); } catch (err) { console.warn('tool wheel item failed:', err); }
    return true;
  }

  return {
    feed(hands = [], now = performance.now()) {
      const engaged = hands.filter((h) => h.engaged !== false);
      if (engaged.length) lastHandsAt = now;
      const h = engaged.find((x) => x.gesture === 'Victory') ?? engaged[0];
      const s = hold.update({
        pose: h ? (h.gesture === 'Victory' ? 'toolWheel' : 'other') : null,
        confidence: h?.score ?? 0,
        wristPos: h ? { x: h.landmarks[0].x, y: h.landmarks[0].y } : null,
        spanPx: h ? Math.hypot(h.landmarks[9].x - h.landmarks[0].x, h.landmarks[9].y - h.landmarks[0].y) || 0.1 : 1,
        timestampMs: now
      });
      let opened = false, closed = false;
      if (s.fired === 'toolWheel') {
        if (open) { close('toggle'); closed = true; } else { openWheel(null, now, true); opened = true; }
      }
      return { opened, closed, progress: s.pose === 'toolWheel' ? s.visibleProgress : 0 };
    },
    point(px, now = performance.now()) {
      if (px) lastCursor = px;
      if (!open) return;
      if (byHand && now - lastHandsAt > WHEEL.restMs) { close('rest'); return; }
      if (!px) { if (byHand && now - litAt > WHEEL.idleMs) close('idle'); return; }
      const dir = sectorAt(px.x - at.x, px.y - at.y, R);
      setLit(enabled(dir) ? dir : null, now);
      if (byHand && now - litAt > WHEEL.idleMs) close('idle');
    },
    click() {
      if (!open) return false;
      if (!pick(lit ?? 'center')) close('pick');
      return true;
    },
    open: openWheel,
    close,
    get isOpen() { return open; },
    get lit() { return lit; },
    el,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
      return () => listeners.set(type, listeners.get(type).filter((f) => f !== fn));
    },
    dispose() { close('api'); el.remove(); }
  };
}

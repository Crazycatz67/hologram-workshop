// guideHand/player.js — the animated guide player: solid mannequin hands acting out a gesture.
//
// CONTRACT
//   createGuidePlayer(canvas, {
//     gesture = 'aim-sweep',   // a GESTURES name (guideHand/gestures.js) or a spec object
//                              // { T, still, at(t) -> frame, hint?, aspect? }
//     loop = true,             // false: plays once, then holds the last frame (playing -> false)
//     speed = 1,               // time multiplier
//     autoplay = true,         // ignored (treated as false) under prefers-reduced-motion
//     scene = null,            // optional host drawing: { under(ctx, S, f), over(ctx, S, f) }
//     reducedMotion,           // override for tests; default = the OS setting, live
//     cueFilter,                 // optional (cue) -> bool: drop cues a host draws its own way
//     fps = 30                 // frame cap
//   }) -> player
//   player.play() / pause() / setGesture(nameOrSpec) -> bool / dispose()
//   player.playing, player.gesture (spec), player.reduced, player.speed (get/set),
//   player.stats { frames }
//   player.renderAt(tMs) -> frame   draw that moment now (tests, paused previews)
//   player.frameAt(tMs) -> { hands: [{ handedness, landmarks: 21 [X, Y, z] }], fx }
//       landmarks in stage HEIGHT units (X 0..aspect, Y 0..1, y down), as drawn (mirrored).
//   S (scene helper, the stage fitted into the canvas, "contain"): { x(X), y(Y), w, h,
//       aspect, dpr, lw } — x() takes stage height units (0..aspect), y() takes 0..1.
//   f (scene frame): { t, fx, hands: [{ side, px: 21 [x, y], lm }] }.
//
// Behaviour: draws only while the canvas is on screen and the tab is visible, at <= fps;
// prefers-reduced-motion shows the gesture's key pose (spec.still) plus its static hint arrows
// and never animates unless play() is called (an explicit user request). A gesture name that
// doesn't exist: setGesture returns false and the canvas is cleared (no throw).
// Photosafety: nothing here changes brightness on its own; every cue's alpha comes eased from
// the gesture spec (gestures.js), so the player adds no flashes.

import { drawHandShape, handSpan } from './skeleton.js';
import { GESTURES, POSES, STAGE_ASPECT } from './gestures.js';
import { catmullRom2D } from './strokekin.js';

const CYAN = '79,209,255';
const WARM = '255,209,102';
const OPEN_SPAN = handSpan(POSES.open);   // pose units: a fist keeps the open hand's finger width
const DEG = Math.PI / 180;

function resolveSpec(g) {
  if (g && typeof g === 'object' && typeof g.at === 'function') return g;
  return (typeof g === 'string' && GESTURES[g]) || null;
}

// A frame's hands -> stage height units (X, Y) + pose-unit z, mirrored like a selfie for 'R'.
function placeHands(hands, A) {
  return hands.map((h) => {
    if (h.lm) return { side: h.side || 'R', lm: h.lm, zs: h.lm.map((p) => p[2] || 0), span: null, alpha: h.alpha ?? 1, face: h.face ?? null };
    const sx = h.side === 'L' ? 1 : -1;
    const [pvx, pvy] = h.pivot || [0, 0];
    const r = (h.roll || 0) * DEG, c = Math.cos(r), s = Math.sin(r);
    const lm = h.pose.map(([x, y, z]) => {
      // relative to the pivot, mirrored (canonical poses are the viewer's-eye right hand), then
      // rolled in screen space so a positive roll is clockwise for either hand
      const mx = sx * (x - pvx), ly = y - pvy;
      const rx = mx * c - ly * s, ry = mx * s + ly * c;
      return [h.x * A + rx * h.s, h.y + ry * h.s, (z || 0) * h.s];
    });
    return { side: h.side, lm, zs: h.pose.map((p) => p[2] || 0), span: OPEN_SPAN * h.s, alpha: h.alpha ?? 1, face: h.face ?? 0.6 };
  });
}

export function createGuidePlayer(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduce = opts.reducedMotion ?? !!(mq && mq.matches);
  const onMq = (e) => { if (opts.reducedMotion === undefined) { reduce = e.matches; if (reduce) pause(); else redrawStill(); } };
  mq?.addEventListener?.('change', onMq);

  const loop = opts.loop !== false;
  const fpsCap = opts.fps || 30;
  const scene = opts.scene || null;
  let speed = opts.speed || 1;
  let spec = null;
  let playing = false, visible = true, raf = 0, last = 0, t0 = 0, tPaused = 0, disposed = false;
  const stats = { frames: 0 };

  // Stage fit, cached per canvas size + aspect (makeFit's lesson: never refit per frame).
  let fitKey = '', S = null;
  function stage() {
    const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    if (canvas.clientWidth && opts.autoSize !== false) {
      const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
      if (W && H && (canvas.width !== W || canvas.height !== H)) { canvas.width = W; canvas.height = H; }
    }
    const W = canvas.width, H = canvas.height, A = (spec && spec.aspect) || STAGE_ASPECT;
    const key = `${W}x${H}@${A}`;
    if (key !== fitKey) {
      fitKey = key;
      const fh = Math.min(H, W / A), fw = fh * A;
      const ox = (W - fw) / 2, oy = (H - fh) / 2;
      const d = canvas.clientWidth ? W / canvas.clientWidth : dpr;
      S = { w: fw, h: fh, aspect: A, dpr: d, lw: 1.4 * d, x: (X) => ox + X * fh, y: (Y) => oy + Y * fh };
    }
    return S;
  }

  const toPx = (St, lm) => lm.map(([X, Y]) => [St.x(X), St.y(Y)]);
  function anchor(St, at, hands) {
    if (!at) return null;
    if ('u' in at) return [St.x(at.u * St.aspect), St.y(at.v)];
    const h = hands[at.hand];
    if (!h) return null;
    const p = h.px[at.joint ?? 9];
    return [p[0] + (at.dx || 0) * St.h, p[1] + (at.dy || 0) * St.h];
  }

  function drawCue(St, c, hands, t) {
    const a = Math.max(0, Math.min(1, c.a ?? 1));
    if (a <= 0.01) return;
    const rgb = c.warm ? WARM : CYAN;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (c.type === 'arrow') {
      const P = c.pts.map(([u, v]) => [St.x(u * St.aspect), St.y(v)]);
      const pts = [];
      for (let k = 0; k <= 20; k++) pts.push(catmullRom2D(P, k / 20));
      if (c.flip) pts.reverse();
      ctx.strokeStyle = `rgba(${rgb},${0.75 * a})`;
      ctx.lineWidth = St.lw * 1.8;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      const [x1, y1] = pts[pts.length - 1], [x0, y0] = pts[pts.length - 3];
      const ang = Math.atan2(y1 - y0, x1 - x0), hl = St.h * 0.045;
      ctx.beginPath();
      ctx.moveTo(x1 - Math.cos(ang - 0.5) * hl, y1 - Math.sin(ang - 0.5) * hl);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x1 - Math.cos(ang + 0.5) * hl, y1 - Math.sin(ang + 0.5) * hl);
      ctx.stroke();
    } else if (c.type === 'trail') {
      if (reduce || !spec) { ctx.restore(); return; }
      const n = 7, pts = [];
      for (let k = n; k >= 0; k--) {
        const tk = t - (c.ms * k) / n;
        if (tk < 0) continue;
        const f = placeHands(spec.at(tk).hands || [], St.aspect)[c.hand];
        if (f) { const [X, Y] = f.lm[c.joint]; pts.push([St.x(X), St.y(Y)]); }
      }
      ctx.lineWidth = St.lw * 3;
      for (let i = 1; i < pts.length; i++) {
        ctx.strokeStyle = `rgba(${rgb},${(0.6 * a * i) / pts.length})`;
        ctx.beginPath(); ctx.moveTo(...pts[i - 1]); ctx.lineTo(...pts[i]); ctx.stroke();
      }
    } else if (c.type === 'ring' || c.type === 'cursor') {
      const p = anchor(St, c.at, hands);
      if (p) {
        const r = (c.r || 0.04) * St.h;
        if (c.type === 'cursor' || c.cyan) {
          ctx.strokeStyle = `rgba(${CYAN},${a})`;
          ctx.lineWidth = St.lw * 1.5;
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.stroke();
        } else {
          // hold ring: a faint track, and an amber arc that only ever fills (holdGate's ring)
          ctx.strokeStyle = `rgba(${CYAN},${0.25 * a})`;
          ctx.lineWidth = St.lw * 2;
          ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.stroke();
          const fill = Math.max(0, Math.min(1, c.fill ?? 1));
          if (fill > 0.005) {
            ctx.strokeStyle = `rgba(${WARM},${0.95 * a})`;
            ctx.lineWidth = St.lw * 2.4;
            ctx.beginPath(); ctx.arc(p[0], p[1], r, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2); ctx.stroke();
          }
        }
      }
    } else if (c.type === 'label') {
      const p = anchor(St, c.at, hands);
      if (p) {
        ctx.font = `${Math.round(11 * St.dpr)}px ui-monospace, Menlo, monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(${rgb},${a})`;
        ctx.fillText(c.text, p[0], p[1]);
      }
    } else if (c.type === 'track') {
      const A = anchor(St, c.from, hands), B = anchor(St, c.to, hands);
      ctx.strokeStyle = `rgba(${CYAN},${0.6 * a})`;
      ctx.lineWidth = St.lw * 2;
      ctx.beginPath(); ctx.moveTo(...A); ctx.lineTo(...B); ctx.stroke();
      const k = Math.max(0, Math.min(1, c.knob || 0));
      ctx.fillStyle = `rgba(${WARM},${a})`;
      ctx.beginPath(); ctx.arc(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, St.h * 0.022, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function renderAt(t) {
    const St = stage();
    ctx.clearRect(0, 0, canvas.width, canvas.height);   // full clear: no after-image
    if (!spec || !canvas.width || !canvas.height) return null;
    const fr = spec.at(t) || {};
    const placed = placeHands(fr.hands || [], St.aspect);
    const hands = placed.map((h) => ({ ...h, px: toPx(St, h.lm) }));
    const f = { t, fx: fr.fx || {}, hands };
    const cues = (fr.cues || []).concat(reduce ? spec.hint || [] : []).filter(opts.cueFilter || (() => true));
    if (scene && scene.under) scene.under(ctx, St, f);
    for (const c of cues) if (c.type === 'trail') drawCue(St, c, hands, t);
    for (const h of hands) {
      if (h.alpha <= 0.01) continue;
      drawHandShape(ctx, h.px, {
        alpha: h.alpha,
        depth: { z: h.zs },
        face: h.face,
        span: h.span ? h.span * St.h : null
      });
    }
    for (const c of cues) if (c.type !== 'trail') drawCue(St, c, hands, t);
    if (scene && scene.over) scene.over(ctx, St, f);
    stats.frames++;
    return f;
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const elapsed = () => (now() - t0) * speed;
  function timeOf(ms) { return loop ? ms % spec.T : Math.min(ms, spec.T); }

  function tick(ts) {
    raf = 0;
    if (disposed || !playing || !visible || (typeof document !== 'undefined' && document.hidden) || !spec) return;
    raf = requestAnimationFrame(tick);
    if (ts - last < 1000 / fpsCap - 2) return;
    last = ts;
    const ms = elapsed();
    if (!loop && ms >= spec.T) { renderAt(spec.T); playing = false; tPaused = spec.T; cancelAnimationFrame(raf); raf = 0; return; }
    renderAt(timeOf(ms));
  }
  function kick() {
    if (disposed) return;
    if (playing && visible && !(typeof document !== 'undefined' && document.hidden) && !raf && spec) raf = requestAnimationFrame(tick);
  }
  function redrawStill() { if (spec && !playing) renderAt(reduce ? spec.still : tPaused); }

  function play() {
    if (!spec || disposed) return;
    if (!loop && tPaused >= spec.T) tPaused = 0;
    playing = true;
    t0 = now() - tPaused / speed;
    kick();
  }
  function pause() {
    if (playing && spec) tPaused = timeOf(elapsed());
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (spec) renderAt(reduce && tPaused === 0 ? spec.still : tPaused);
  }
  function setGesture(g) {
    spec = resolveSpec(g);
    fitKey = '';
    tPaused = spec && reduce ? spec.still : 0;
    t0 = now();
    if (!spec) { stage(); ctx.clearRect(0, 0, canvas.width, canvas.height); return false; }
    if (!playing) renderAt(tPaused);
    return true;
  }

  // Draw only while on screen and the tab is visible.
  let io = null, ro = null;
  if (typeof IntersectionObserver === 'function') {
    visible = false;
    io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }, { rootMargin: '80px' });
    io.observe(canvas);
  }
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => { if (!playing || !visible) redrawStill(); });
    ro.observe(canvas);
  }
  const onVis = () => kick();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);

  setGesture('gesture' in opts ? opts.gesture : 'aim-sweep');
  if (opts.autoplay !== false && !reduce) play();

  return {
    play, pause, setGesture, renderAt,
    frameAt(t) {
      if (!spec) return { hands: [], fx: {} };
      const fr = spec.at(t) || {};
      const placed = placeHands(fr.hands || [], (spec.aspect) || STAGE_ASPECT);
      return { hands: placed.map((h) => ({ handedness: h.side === 'L' ? 'Left' : 'Right', landmarks: h.lm })), fx: fr.fx || {} };
    },
    dispose() {
      disposed = true;
      playing = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      io?.disconnect();
      ro?.disconnect();
      mq?.removeEventListener?.('change', onMq);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    },
    get playing() { return playing; },
    get gesture() { return spec; },
    get reduced() { return reduce; },
    get speed() { return speed; },
    set speed(v) { if (v > 0) { const ms = playing ? elapsed() : tPaused; speed = v; t0 = now() - ms / speed; } },
    stats
  };
}

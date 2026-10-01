// Demo slots for the landing page's feature cards: a small looping animation of the gesture.
//
// Contract (for tour.js / demoHand.js later, plan E):
//   <figure class="demo" data-feature="grab" data-clip="grab-move" aria-label="…">
//     <canvas></canvas>
//   </figure>
//   mountDemo(figure, { clipBase }) -> slot
//     slot.source   'clip' | 'placeholder'   which one is playing
//     slot.play() / slot.pause() / slot.playing / slot.destroy()
//     slot.frameAt(tMs) -> { hands: [{ handedness, landmarks: [[x,y,z]×21] }] }   display space
//       (x 0..1.6 and y 0..1 of the 16:10 stage, y down, mirrored like a selfie)
//   mountAll(root = document, opts) -> slot[]   every figure.demo under root
//   loadClipIndex(clipBase) -> Promise<Set<name>>   names listed in <clipBase>index.json
//   FEATURES   the data-feature names this file knows
//
// The hands are the guide hand (guideHand/): the solid "mannequin hand" ported from the owner's
// ASL project, posed by its anatomical interpolator and moved by guideHand/gestures.js. This
// file only adds each card's scene (the chair, the wheel, the tape…), driven by the gesture's
// fx channels so the object moves in step with the hand. It used to draw stick-figure hands
// from a few joint-curl numbers; the owner asked for the ASL guide look instead (2026-10-01).
//
// Source of the motion. If assets/gesture-clips/index.json (schema gesture-clip-index/1) lists
// the figure's data-clip, the recorded clip (schema gesture-clip/1, docs/lab/gestures/
// clip-lab.js) is fetched and its IMAGE landmarks are replayed through the same player and
// renderer, mirrored like a selfie (the clip stores the unmirrored camera image). So swapping
// in the owner's real clips needs no code change: record them in clip-lab and they appear.
//
// Photosafety (BUGS #14, safety-test.html): every brightness change is eased over >= 250 ms and
// happens at most once per loop (loops are >= 4 s), so far under 3 flashes/s; colours never
// invert. prefers-reduced-motion: the player shows the gesture's key pose plus a still hint
// arrow; ▶ plays. WCAG 2.2.2: every slot has a pause button. The player draws only while the
// slot is on screen and the tab is visible, at <= 30 fps.

import { createGuidePlayer } from '../../guideHand/player.js';
import { K } from '../../guideHand/gestures.js';

const CYAN = '79,209,255';
const WARM = '255,209,102';
const DEG = Math.PI / 180;
const mix = (a, b, u) => a + (b - a) * u;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- props
// A small wireframe chair (seat, back, four legs), so the cards show the same object as the hero.
const CHAIR_PARTS = [
  { c: [0, 0, 0], h: [0.5, 0.06, 0.5] },        // seat
  { c: [0, -0.5, 0.45], h: [0.5, 0.44, 0.05] }, // back
  { c: [-0.42, 0.42, -0.42], h: [0.05, 0.36, 0.05] },
  { c: [0.42, 0.42, -0.42], h: [0.05, 0.36, 0.05] },
  { c: [-0.42, 0.42, 0.42], h: [0.05, 0.36, 0.05] },
  { c: [0.42, 0.42, 0.42], h: [0.05, 0.36, 0.05] }
];
const BOX_EDGES = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

function drawChair(g, F, ch) {
  const { x, y, size = 0.3, yaw = 30, tilt = 0, explode = 0, a = 0.8, hl = 0, inferred = 0 } = ch;
  const cy = Math.cos(yaw * DEG), sy = Math.sin(yaw * DEG);
  const pitch = (18 + tilt) * DEG, cp = Math.cos(pitch), sp = Math.sin(pitch);
  const proj = ([px, py, pz]) => {
    const x1 = px * cy + pz * sy, z1 = -px * sy + pz * cy;
    const y2 = py * cp - z1 * sp, z2 = py * sp + z1 * cp;
    const k = 1 / (1 + z2 * 0.18);
    return [F.x(x * F.aspect + x1 * size * k), F.y(y + y2 * size * k)];
  };
  g.lineWidth = F.lw * (1 + hl * 0.6);
  g.strokeStyle = `rgba(${CYAN},${a * (0.7 + 0.3 * hl)})`;
  CHAIR_PARTS.forEach((part, i) => {
    // Explode pushes each part out along its own offset from the seat; the seat lifts a little.
    const c = part.c.map((v) => v * (1 + explode * 0.9));
    if (i === 0) c[1] -= explode * 0.25;
    const v = [];
    for (let n = 0; n < 8; n++) v.push(proj([c[0] + (n & 1 ? 1 : -1) * part.h[0], c[1] + (n & 2 ? 1 : -1) * part.h[1], c[2] + (n & 4 ? 1 : -1) * part.h[2]]));
    g.beginPath();
    for (const [i0, i1] of BOX_EDGES) { g.moveTo(...v[i0]); g.lineTo(...v[i1]); }
    g.stroke();
    // Seat underside marked as inferred (amber hatch): what scan completion adds.
    if (i === 0 && inferred > 0) {
      g.save();
      g.beginPath(); g.moveTo(...v[2]); g.lineTo(...v[3]); g.lineTo(...v[7]); g.lineTo(...v[6]); g.closePath();
      g.fillStyle = `rgba(${WARM},${0.18 * inferred})`; g.fill();
      g.clip();
      g.strokeStyle = `rgba(${WARM},${0.75 * inferred})`; g.lineWidth = F.lw * 0.8;
      g.beginPath();
      const [ax, ay] = v[2], span = Math.hypot(v[7][0] - ax, v[7][1] - ay) * 1.5;
      for (let d = -span; d < span; d += 7 * F.dpr) { g.moveTo(ax + d, ay - span); g.lineTo(ax + d + span, ay + span); }
      g.stroke();
      g.restore();
    }
  });
}

function label(g, F, text, x, y, rgb = CYAN, a = 1) {
  if (a <= 0.01) return;
  g.font = `${11 * F.dpr}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center';
  g.fillStyle = `rgba(${rgb},${a})`;
  g.fillText(text, F.x(x * F.aspect), F.y(y));
}

function ring(g, F, x, y, r, a, rgb = CYAN, lw = 1.5) {
  if (a <= 0.01) return;
  g.beginPath();
  g.arc(F.x(x * F.aspect), F.y(y), r * F.h, 0, Math.PI * 2);
  g.strokeStyle = `rgba(${rgb},${a})`;
  g.lineWidth = F.lw * lw;
  g.stroke();
}

// ---------------------------------------------------------------- feature cards
// Each card: { gesture: a guideHand GESTURES name or a spec, under?(g, F, f), over?(g, F, f),
// cues?(cue) -> keep? }. F = the player's stage helper (x() takes 0..aspect, y() 0..1);
// f = { t, fx, hands: [{ side, px, lm }] }. Scenes read only fx, so they stay in step.
const tipLm = (f, i = 0) => f.hands[i] && f.hands[i].lm[8];
const noHands = (T, still) => ({ T, still, hint: [], at: () => ({ hands: [], cues: [], fx: {} }) });

const CARDS = {
  aim: {
    gesture: 'aim-sweep',
    under: (g, F, f) => drawChair(g, F, { x: 0.62, y: 0.36, size: 0.2, hl: f.fx.aim > 0.4 && f.fx.aim < 0.9 ? 0.6 : 0 })
  },
  click: {
    gesture: 'click',
    under: (g, F, f) => drawChair(g, F, { x: 0.68, y: 0.34, size: 0.2, hl: f.fx.hl || 0 })
  },
  grab: {
    gesture: 'grab-move',
    under: (g, F, f) => {
      const c = f.fx.carry || 0;
      drawChair(g, F, { x: 0.42 + 0.26 * c, y: 0.36 - 0.06 * c, size: 0.2, yaw: 30 + 40 * c, hl: f.fx.grip || 0 });
    }
  },
  tilt: {
    gesture: 'tilt',
    under: (g, F, f) => drawChair(g, F, { x: 0.5, y: 0.38, size: 0.22, tilt: 22 * (f.fx.tilt || 0), hl: f.fx.grip || 0 })
  },
  scale: {
    gesture: 'scale',
    under: (g, F, f) => drawChair(g, F, { x: 0.5, y: 0.34, size: 0.15 + 0.1 * (f.fx.spread || 0) })
  },
  explode: {
    gesture: 'explode',
    under: (g, F, f) => drawChair(g, F, { x: 0.5, y: 0.34, size: 0.17, explode: f.fx.spread || 0 })
  },
  clap: {
    gesture: 'clap',
    under: (g, F, f) => {
      const home = f.fx.reset || 0;
      drawChair(g, F, { x: mix(0.7, 0.5, home), y: mix(0.3, 0.36, home), size: mix(0.14, 0.2, home), yaw: mix(80, 30, home), tilt: mix(-15, 0, home) });
      label(g, F, '↺ reset', 0.5, 0.1, CYAN, Math.sin(Math.PI * Math.min(1, home * 1.6)) * 0.9);
    }
  },
  wheel: {
    gesture: 'wheel',
    over: (g, F, f) => {
      const { wheel: wheelA = 0, aim = 0, pick = 0 } = f.fx;
      if (wheelA <= 0.01) return;
      const cx = F.x(0.5 * F.aspect), cy = F.y(0.33), r = 0.2 * F.h;
      const names = ['↶', '↗', '↘', '↓', '↙', '↖'];
      for (let k = 0; k < 6; k++) {
        const a0 = (-90 - 30 + k * 60) * DEG, a1 = a0 + 60 * DEG;
        const sel = k === 1 ? aim : 0;
        g.beginPath(); g.arc(cx, cy, r, a0 + 0.04, a1 - 0.04); g.arc(cx, cy, r * 0.45, a1 - 0.08, a0 + 0.08, true); g.closePath();
        g.fillStyle = `rgba(${sel > 0.5 ? WARM : CYAN},${wheelA * (0.10 + 0.25 * sel)})`; g.fill();
        g.strokeStyle = `rgba(${CYAN},${wheelA * 0.6})`; g.lineWidth = F.lw; g.stroke();
        const am = (a0 + a1) / 2;
        g.font = `${12 * F.dpr}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = `rgba(214,228,239,${wheelA})`; g.fillText(names[k], cx + Math.cos(am) * r * 0.73, cy + Math.sin(am) * r * 0.73);
      }
      g.textBaseline = 'alphabetic';
      label(g, F, 'tape', 0.5, 0.35, WARM, wheelA * pick);
    }
  },
  undo: {
    gesture: 'undo',
    under: (g, F, f) => {
      const back = f.fx.undone || 0;
      drawChair(g, F, { x: mix(0.5, 0.32, back), y: 0.38, size: 0.2, yaw: mix(75, 30, back) });
      label(g, F, '↶ undo', 0.32, 0.12, CYAN, 0.9 * back);
    }
  },
  tape: {
    gesture: 'drag',
    cues: (c) => c.type !== 'track',          // the tape itself is the slider here
    under: (g, F) => drawChair(g, F, { x: 0.58, y: 0.36, size: 0.24, yaw: 20, a: 0.55 }),
    over: (g, F, f) => {
      const tip = tipLm(f);
      if (!tip) return;
      const { press = 0, drag = 0, shown = 0 } = f.fx;
      const B = [tip[0], tip[1] - 0.12];
      const A = [B[0] - 0.28 * drag * F.aspect, B[1]];     // where the drag began (the pointer only slid sideways)
      const a = Math.max(press, shown);
      if (a > 0.05) {
        g.beginPath(); g.moveTo(F.x(A[0]), F.y(A[1])); g.lineTo(F.x(B[0]), F.y(B[1]));
        g.strokeStyle = `rgba(${WARM},${0.9 * a})`; g.lineWidth = F.lw * 1.6; g.stroke();
        for (const P of [A, B]) { g.beginPath(); g.arc(F.x(P[0]), F.y(P[1]), 3.5 * F.dpr, 0, Math.PI * 2); g.fillStyle = `rgba(${WARM},${a})`; g.fill(); }
        label(g, F, '45.2 cm', (A[0] + B[0]) / 2 / F.aspect, A[1] - 0.05, WARM, shown);
      }
    }
  },
  lens: {
    gesture: 'lens',
    under: (g, F) => drawChair(g, F, { x: 0.6, y: 0.36, size: 0.24, a: 0.5 }),
    over: (g, F, f) => {
      const tip = tipLm(f);
      if (!tip) return;
      const { grow = 0, press = 0 } = f.fx;
      const cx = F.x(tip[0]), cy = F.y(tip[1] - 0.14), r = (0.07 + 0.06 * grow) * F.h;
      g.save();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
      g.strokeStyle = `rgba(${CYAN},0.55)`; g.lineWidth = F.lw * 0.7;
      g.beginPath();
      const step = 9 * F.dpr;
      for (let gx = -r; gx <= r; gx += step) { g.moveTo(cx + gx, cy - r); g.lineTo(cx + gx, cy + r); g.moveTo(cx + gx - r, cy - r); g.lineTo(cx + gx + r, cy + r); }
      for (let gy = -r; gy <= r; gy += step) { g.moveTo(cx - r, cy + gy); g.lineTo(cx + r, cy + gy); }
      g.stroke();
      g.restore();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.strokeStyle = `rgba(${CYAN},0.95)`; g.lineWidth = F.lw * 1.4; g.stroke();
      label(g, F, `r ${Math.round(40 + 60 * grow)} px`, tip[0] / F.aspect, tip[1] - 0.14 - 0.07 - 0.06 * grow - 0.02, WARM, press);
    }
  },
  ring: {
    gesture: 'ring-spin',
    under: (g, F, f) => {
      const { spin = 0, open = 0 } = f.fx;
      const n = 7, ph = -spin * (2 * Math.PI / n) * 2;
      const items = [];
      for (let k = 0; k < n; k++) {
        const a = ph + k * 2 * Math.PI / n;
        items.push({ k, x: 0.5 + Math.sin(a) * 0.32, y: 0.36 - Math.cos(a) * 0.05, z: Math.cos(a) });
      }
      items.sort((p, q) => p.z - q.z);
      for (const it of items) {
        const front = it.z > 0.95 ? open : 0;
        const sc = (0.55 + 0.45 * (it.z + 1) / 2) * (1 + 0.35 * front);
        const w = 0.12 * sc * F.h, hh = 0.15 * sc * F.h;
        const cx = F.x(it.x * F.aspect), cy = F.y(it.y);
        g.fillStyle = 'rgba(16,22,29,0.85)';
        g.strokeStyle = `rgba(${front > 0.5 ? WARM : CYAN},${0.25 + 0.6 * (it.z + 1) / 2})`;
        g.lineWidth = F.lw;
        g.beginPath(); g.rect(cx - w / 2, cy - hh / 2, w, hh); g.fill(); g.stroke();
      }
    }
  },
  pin: {
    gesture: 'pin',
    under: (g, F, f) => {
      const { tug = 0, lock = 0.5 } = f.fx;
      drawChair(g, F, { x: 0.5 + 0.01 * tug, y: 0.38, size: 0.2 });
      g.font = `${18 * F.dpr}px system-ui`; g.textAlign = 'center';
      g.globalAlpha = lock; g.fillText('📌', F.x(0.5 * F.aspect), F.y(0.14)); g.globalAlpha = 1;
      label(g, F, 'pinned · stays put', 0.5, 0.08, WARM, (lock - 0.5) * 2);
    }
  },
  upload: {
    gesture: noHands(4400, 3000),
    under: (g, F, { t }) => {
      const drop = K([[0, 0], [400, 0], [1500, 1]])(t);
      const build = K([[0, 0], [1500, 0], [2600, 1], [3700, 1], [4300, 0]])(t);
      const fileA = K([[0, 0], [300, 1], [1600, 1], [1900, 0], [4000, 0], [4300, 0]])(t);
      drawChair(g, F, { x: 0.5, y: 0.42, size: 0.2, a: 0.85 * build, yaw: 30 + 40 * build });
      const u = mix(0.15, 0.5, drop), v = mix(0.18, 0.42, drop);
      const x = F.x(u * F.aspect), y = F.y(v);
      const w = 0.16 * F.h, h = 0.2 * F.h;
      g.globalAlpha = fileA;
      g.fillStyle = 'rgba(16,22,29,0.9)'; g.strokeStyle = `rgba(${CYAN},0.9)`; g.lineWidth = F.lw;
      g.beginPath(); g.rect(x - w / 2, y - h / 2, w, h); g.fill(); g.stroke();
      g.globalAlpha = 1;
      label(g, F, 'scan.glb', u, v + 0.02, CYAN, fileA);
      label(g, F, 'GLB · glTF · OBJ · PLY', 0.5, 0.94, CYAN, 0.8);
    }
  },
  completion: {
    gesture: noHands(6000, 3200),
    under: (g, F, { t }) => {
      const wipe = K([[0, 0], [600, 0], [2600, 1], [4000, 1], [5600, 0]])(t);
      drawChair(g, F, { x: 0.5, y: 0.42, size: 0.26, yaw: 25, tilt: -28, inferred: wipe });
      label(g, F, 'measured', 0.3, 0.1, CYAN, 0.9);
      label(g, F, 'inferred', 0.72, 0.1, WARM, 0.3 + 0.6 * wipe);
      label(g, F, wipe > 0.5 ? 'after: underside filled' : 'before: underside missing', 0.5, 0.94, wipe > 0.5 ? WARM : CYAN, 0.85);
    }
  },
  photo3d: {
    gesture: noHands(5200, 3400),
    under: (g, F, { t }) => {
      const go = K([[0, 0], [900, 0], [2400, 1], [4200, 1], [5000, 0]])(t);
      drawChair(g, F, { x: 0.68, y: 0.42, size: 0.18, yaw: 20 + 90 * go, a: 0.85 * go, inferred: go });
      const x = F.x(0.24 * F.aspect), y = F.y(0.45), w = 0.32 * F.h, h = 0.4 * F.h;
      g.save(); g.translate(x, y); g.rotate(-0.06);
      g.fillStyle = 'rgba(16,22,29,0.9)'; g.strokeStyle = 'rgba(214,228,239,0.8)'; g.lineWidth = F.lw;
      g.beginPath(); g.rect(-w / 2, -h / 2, w, h); g.fill(); g.stroke();
      g.strokeStyle = `rgba(${CYAN},0.7)`; g.beginPath();   // a chair silhouette in the photo
      g.moveTo(-w * 0.2, -h * 0.3); g.lineTo(-w * 0.2, h * 0.3); g.moveTo(-w * 0.2, 0); g.lineTo(w * 0.2, 0); g.lineTo(w * 0.2, h * 0.3);
      g.stroke(); g.restore();
      label(g, F, 'photo', 0.24, 0.8, CYAN, 0.85);
      label(g, F, '→', 0.45, 0.47, CYAN, 0.5 + 0.5 * go);
      label(g, F, '3D · 100% inferred', 0.68, 0.8, WARM, go);
    }
  }
};

export const FEATURES = Object.keys(CARDS);

// ---------------------------------------------------------------- clips
const indexCache = new Map();
export function loadClipIndex(clipBase) {
  if (!indexCache.has(clipBase)) {
    indexCache.set(clipBase, fetch(`${clipBase}index.json`)
      .then((r) => (r.ok ? r.json() : { clips: [] }))
      .then((j) => new Set((j.clips || []).filter((c) => c && c.name && c.frames > 0).map((c) => c.name)))
      .catch(() => new Set()));
  }
  return indexCache.get(clipBase);
}

// Recorded clip -> a guide-player spec. Image landmarks are 0..1 of the camera frame; we mirror
// x (selfie view) and keep the camera's aspect so the hand isn't stretched. MediaPipe's
// handedness label is for the unmirrored image, so 'Left' there is the user's right hand.
function clipSpec(clip) {
  const aspect = clip.video && clip.video.width && clip.video.height ? clip.video.width / clip.video.height : 4 / 3;
  const frames = clip.frames || [];
  const T = Math.max(1, clip.durationMs || (frames.length ? frames[frames.length - 1].t : 1));
  return {
    T: T + 600, still: T * 0.5, aspect, hint: [],
    at: (t) => {
      let i = 0;
      while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
      const f = frames[i] || { hands: [] };
      return {
        hands: (f.hands || []).filter((h) => (h.landmarks || []).length === 21).map((h) => ({
          side: h.handedness === 'Left' ? 'R' : 'L',
          lm: h.landmarks.map(([x, y, z]) => [(1 - x) * aspect, y, z || 0])
        })),
        cues: [], fx: {}
      };
    }
  };
}

// ---------------------------------------------------------------- slot
export function mountDemo(fig, { clipBase = 'assets/gesture-clips/' } = {}) {
  const canvas = fig.querySelector('canvas') || fig.appendChild(document.createElement('canvas'));
  const feature = fig.dataset.feature;
  const card = CARDS[feature] || null;
  let clipMode = false;                     // a recorded clip replaces the whole card (no scene)
  const scene = {
    under: (g, F, f) => card && card.under && !clipMode && card.under(g, F, f),
    over: (g, F, f) => card && card.over && !clipMode && card.over(g, F, f)
  };
  const player = createGuidePlayer(canvas, {
    gesture: card ? card.gesture : null,
    scene,
    autoplay: !REDUCED,
    cueFilter: card && card.cues
  });

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp';
  fig.append(btn);
  const syncBtn = () => {
    btn.textContent = player.playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', `${player.playing ? 'Pause' : 'Play'} the ${fig.dataset.name || feature} animation`);
  };
  syncBtn();
  btn.addEventListener('click', () => (player.playing ? slot.pause() : slot.play()));

  const slot = {
    source: 'placeholder',
    player,
    get playing() { return player.playing; },
    play() { player.play(); syncBtn(); },
    pause() { player.pause(); syncBtn(); },
    frameAt(t) { const fr = player.frameAt(t); return { hands: fr.hands }; },
    destroy() { player.dispose(); btn.remove(); }
  };

  // Upgrade to the owner's recorded clip when one exists (never blocks the placeholder).
  const clipName = fig.dataset.clip;
  if (clipName) {
    loadClipIndex(clipBase).then((names) => {
      if (!names.has(clipName)) return null;
      return fetch(`${clipBase}${clipName}.json`).then((r) => (r.ok ? r.json() : null));
    }).then((clip) => {
      if (!clip || clip.schema !== 'gesture-clip/1') return;
      clipMode = true;
      const wasPlaying = player.playing;
      player.pause();
      player.setGesture(clipSpec(clip));
      if (wasPlaying || !REDUCED) player.play();
      slot.source = 'clip';
      fig.classList.add('has-clip');
      const tag = document.createElement('span');
      tag.className = 'src';
      tag.textContent = 'recorded hand';
      fig.append(tag);
      syncBtn();
    }).catch(() => { /* keep the placeholder */ });
  }
  return slot;
}

export function mountAll(root = document, opts) {
  return [...root.querySelectorAll('figure.demo')].map((fig) => mountDemo(fig, opts));
}

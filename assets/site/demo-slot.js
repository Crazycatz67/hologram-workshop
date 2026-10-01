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
//   mountAll(root = document, opts) -> slot[]   every figure.demo under root
//   loadClipIndex(clipBase) -> Promise<Set<name>>   names listed in <clipBase>index.json
//
// Source of the motion. If assets/gesture-clips/index.json (schema gesture-clip-index/1) lists
// the figure's data-clip, the recorded clip (schema gesture-clip/1, docs/lab/gestures/
// clip-lab.js) is fetched and its IMAGE landmarks are replayed, mirrored like a selfie (the clip
// stores the unmirrored camera image). Otherwise a built-in placeholder plays: a synthetic hand
// built from a few joint-curl numbers per pose, drawn by the same renderer. So swapping in the
// owner's real clips needs no code change: record them in clip-lab and they appear.
//
// Photosafety (BUGS #14, safety-test.html): every brightness change is eased over >= 250 ms and
// happens at most once per loop (loops are >= 3.6 s), so far under 3 flashes/s; colours never
// invert. prefers-reduced-motion: slots start paused on a representative frame; ▶ plays.
// WCAG 2.2.2: every slot has a pause button. Drawing runs only while the slot is on screen and
// the tab is visible, at <= 30 fps.

const CYAN = '79,209,255';
const WARM = '255,209,102';
const FPS_CAP = 30;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- easing / keyframes
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const ease = (u) => { u = clamp01(u); return u * u * (3 - 2 * u); };   // smoothstep
const mix = (a, b, u) => a + (b - a) * u;
function mixVal(a, b, u) {
  if (typeof a === 'number') return mix(a, b, u);
  if (Array.isArray(a)) return a.map((v, i) => mixVal(v, b[i], u));
  if (a && typeof a === 'object') {
    const o = {};
    for (const k of Object.keys(a)) o[k] = k in b ? mixVal(a[k], b[k], u) : a[k];
    return o;
  }
  return u < 0.5 ? a : b;
}
// K([[t0, v0], [t1, v1], …])(t): eased hold-then-move between keys; holds the ends.
function K(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const [t0, v0] = keys[i - 1];
        const [t1, v1] = keys[i];
        return mixVal(v0, v1, ease((t - t0) / (t1 - t0)));
      }
    }
    return keys[keys.length - 1][1];
  };
}

// ---------------------------------------------------------------- synthetic hand
// Right hand, palm to the viewer, fingers up, in "hand units" (wrist→middle knuckle ≈ 1),
// display space (x right, y down). Curl c (0 open .. 1 fist) per finger: [thumb, index,
// middle, ring, pinky]. Bent segments tip toward the camera; their screen length shrinks
// with cos(angle) and a little of the depth shows as a downward shift, which is enough for a
// fist and a pointing hand to read at card size.
const FINGERS = [
  { base: [-0.30, -0.95], ang: -10, seg: [0.42, 0.25, 0.20] },
  { base: [-0.08, -1.00], ang: -2, seg: [0.46, 0.28, 0.21] },
  { base: [0.14, -0.96], ang: 6, seg: [0.42, 0.26, 0.20] },
  { base: [0.33, -0.85], ang: 14, seg: [0.33, 0.20, 0.18] }
];
const FLEX = [85, 105, 65];         // degrees at MCP, PIP, DIP for a full curl
const THUMB = { base: [-0.25, -0.22], ang: -52, seg: [0.34, 0.28, 0.24], tuck: [42, 72, 92] };
const DEG = Math.PI / 180;
const DEPTH_SHOW = 0.32;

export const POSES = {
  open: { c: [0, 0, 0, 0, 0], pinch: 0 },
  point: { c: [0.35, 0, 1, 1, 1], pinch: 0 },
  ready: { c: [0.15, 0.2, 0.15, 0.15, 0.15], pinch: 0 },
  pinch: { c: [0.3, 0.32, 0.18, 0.18, 0.18], pinch: 1 },
  fist: { c: [1, 1, 1, 1, 1], pinch: 0 },
  peace: { c: [0.9, 0, 0, 1, 1], pinch: 0 },
  thumb: { c: [0, 1, 1, 1, 1], pinch: 0 }
};

// pose: { c, pinch, x, y (wrist, 0..1 of the frame), s (hand size, frame heights), roll (deg),
// left (bool) } -> 21 [x, y, z] in frame units (x in 0..aspect, y in 0..1).
function poseToLandmarks(p, aspect) {
  const pts = new Array(21);
  pts[0] = [0, 0, 0];
  // thumb
  {
    const ct = p.c[0];
    let [x, y] = THUMB.base, z = 0;
    pts[1] = [x, y, z];
    for (let k = 0; k < 3; k++) {
      const a = (THUMB.ang + ct * THUMB.tuck[k]) * DEG;
      const len = THUMB.seg[k] * (1 - 0.2 * ct);
      x += Math.sin(a) * len; y -= Math.cos(a) * len; z -= ct * 0.08;
      pts[2 + k] = [x, y, z];
    }
  }
  // fingers
  FINGERS.forEach((f, i) => {
    const cf = p.c[i + 1];
    let [x, y] = f.base, z = 0, cum = 0;
    const dx = Math.sin(f.ang * DEG), dy = -Math.cos(f.ang * DEG);
    const at = 5 + i * 4;
    pts[at] = [x, y, z];
    for (let k = 0; k < 3; k++) {
      cum += cf * FLEX[k] * DEG;
      const along = Math.cos(cum) * f.seg[k];
      const toward = Math.sin(cum) * f.seg[k];
      x += dx * along; y += dy * along + toward * DEPTH_SHOW; z -= toward;
      pts[at + 1 + k] = [x, y, z];
    }
  });
  // pinch: pull the thumb and index tips together along their chains
  if (p.pinch > 0) {
    const m = [(pts[4][0] + pts[8][0]) / 2, (pts[4][1] + pts[8][1]) / 2];
    const w = [0.25, 0.6, 1];
    [[2, 3, 4], [6, 7, 8]].forEach((chain, ci) => {
      const tip = pts[ci ? 8 : 4];
      const d = [m[0] - tip[0], m[1] - tip[1]];
      chain.forEach((j, k) => { pts[j] = [pts[j][0] + d[0] * w[k] * p.pinch, pts[j][1] + d[1] * w[k] * p.pinch, pts[j][2]]; });
    });
  }
  const r = (p.roll || 0) * DEG, cr = Math.cos(r), sr = Math.sin(r);
  const sx = p.left ? -1 : 1;
  return pts.map(([x, y, z]) => {
    const rx = x * cr - y * sr, ry = x * sr + y * cr;
    return [p.x * aspect + sx * rx * p.s, p.y + ry * p.s, z * p.s];
  });
}

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

// Hold progress (✌ / 👎 hold-to-confirm) as an eased arc, like holdGate's ring.
function arc(g, F, x, y, r, u, a = 0.9) {
  if (u <= 0.01) return;
  g.beginPath();
  g.arc(F.x(x * F.aspect), F.y(y), r * F.h, -Math.PI / 2, -Math.PI / 2 + u * Math.PI * 2);
  g.strokeStyle = `rgba(${WARM},${a})`;
  g.lineWidth = F.lw * 2;
  g.stroke();
}

function drawHand(g, F, pts, a = 1, rgb = CYAN) {
  const P = pts.map(([x, y, z]) => [F.x(x), F.y(y), z]);
  // palm
  g.beginPath();
  [0, 1, 5, 9, 13, 17].forEach((j, k) => (k ? g.lineTo(P[j][0], P[j][1]) : g.moveTo(P[j][0], P[j][1])));
  g.closePath();
  g.fillStyle = `rgba(${rgb},${0.10 * a})`;
  g.fill();
  const bones = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  g.lineCap = 'round';
  for (const [w, al] of [[5, 0.16], [2, 0.85]]) {     // soft glow, then the core line
    g.lineWidth = F.lw * w;
    g.strokeStyle = `rgba(${rgb},${al * a})`;
    g.beginPath();
    for (const [i, j] of bones) { g.moveTo(P[i][0], P[i][1]); g.lineTo(P[j][0], P[j][1]); }
    g.stroke();
  }
  g.fillStyle = `rgba(${rgb},${0.95 * a})`;
  for (const [x, y, z] of P) {
    g.beginPath();
    g.arc(x, y, F.lw * 1.6 * Math.max(0.6, Math.min(1.5, 1 - z * 2.5)), 0, Math.PI * 2);   // nearer joints (z < 0) a bit bigger
    g.fill();
  }
}

// ---------------------------------------------------------------- feature scripts
// Each script: { T (ms), still (ms, the frame shown when paused), at(t) -> scene }.
// scene = { hands: [pose], chair?, draw?(g, F, t, hands) } ; poses are POSES + {x, y, s, roll, left}.
const R = (pose, x, y, extra = {}) => ({ ...POSES[pose], x, y, s: 0.25, roll: 0, ...extra });
const L = (pose, x, y, extra = {}) => R(pose, x, y, { left: true, ...extra });
const tipOf = (hands, i = 0) => hands[i] && hands[i].lm[8];

const SCRIPTS = {
  aim: {
    T: 4000, still: 1800,
    at: (t) => {
      const h = K([[0, R('point', 0.42, 0.95)], [1600, R('point', 0.62, 0.9, { roll: 8 })], [3000, R('point', 0.42, 0.95)]])(t);
      return {
        hands: [h], chair: { x: 0.68, y: 0.38, size: 0.2 },
        draw: (g, F, _t, hands) => {
          const [x, y] = tipOf(hands);
          const cx = x / F.aspect, cy = y - 0.14;
          g.setLineDash([3 * F.dpr, 4 * F.dpr]);
          g.beginPath(); g.moveTo(F.x(x), F.y(y)); g.lineTo(F.x(cx * F.aspect), F.y(cy));
          g.strokeStyle = `rgba(${CYAN},0.45)`; g.lineWidth = F.lw; g.stroke(); g.setLineDash([]);
          ring(g, F, cx, cy, 0.035, 0.95);
        }
      };
    }
  },
  click: {
    T: 4000, still: 1900,
    at: (t) => {
      const press = K([[0, 0], [1300, 0], [1600, 1], [2300, 1], [2600, 0]])(t);
      const hl = K([[0, 0], [1500, 0], [1900, 1], [3300, 1], [3800, 0]])(t);
      return {
        hands: [R('point', 0.6, 0.95), L(press > 0.5 ? 'pinch' : 'ready', 0.2, 0.95, { pinch: press })],
        chair: { x: 0.66, y: 0.36, size: 0.2, hl },
        draw: (g, F, _t, hands) => {
          const [x, y] = tipOf(hands);
          ring(g, F, x / F.aspect, y - 0.14, 0.035 + 0.02 * hl, 0.95);
          label(g, F, 'other hand pinches', 0.28, 0.12, WARM, 0.9 * K([[0, 0.4], [1300, 0.4], [1600, 1], [2600, 1], [3000, 0.4]])(t));
        }
      };
    }
  },
  grab: {
    T: 4400, still: 2000,
    at: (t) => {
      const move = K([[0, 0], [1100, 0], [2500, 1], [3400, 1], [4300, 0]])(t);
      const fist = K([[0, 0], [500, 0], [900, 1], [2700, 1], [3000, 0]])(t);
      const h = mixVal(POSES.open, POSES.fist, fist);
      const x = 0.42 + 0.22 * move, y = 0.92 - 0.06 * move;
      const carry = K([[0, 0], [1100, 0], [2500, 1], [3400, 1], [4300, 0]])(t);
      return { hands: [{ ...h, x, y, s: 0.25, roll: 20 * move }], chair: { x: 0.42 + 0.22 * carry, y: 0.36 - 0.06 * carry, size: 0.2, yaw: 30 + 40 * carry, hl: fist } };
    }
  },
  tilt: {
    T: 4400, still: 1500,
    at: (t) => {
      const up = K([[0, 0], [600, 0], [1500, 1], [2400, 1], [3300, -1], [3800, -1], [4300, 0]])(t);
      return { hands: [L('fist', 0.24, 0.95), R('open', 0.78, 0.92 - 0.12 * up)], chair: { x: 0.5, y: 0.38, size: 0.22, tilt: 22 * up, hl: 1 } };
    }
  },
  scale: {
    T: 4400, still: 2200,
    at: (t) => {
      const sp = K([[0, 0], [900, 0], [2300, 1], [3200, 1], [4300, 0]])(t);
      return {
        hands: [R('pinch', 0.58 + 0.2 * sp, 0.95), L('pinch', 0.42 - 0.2 * sp, 0.95)],
        chair: { x: 0.5, y: 0.36, size: 0.15 + 0.1 * sp }
      };
    }
  },
  explode: {
    T: 4400, still: 2300,
    at: (t) => {
      const sp = K([[0, 0], [800, 0], [2200, 1], [3300, 1], [4300, 0]])(t);
      return { hands: [R('open', 0.58 + 0.2 * sp, 0.97), L('open', 0.42 - 0.2 * sp, 0.97)], chair: { x: 0.5, y: 0.36, size: 0.17, explode: sp } };
    }
  },
  clap: {
    T: 4400, still: 1600,
    at: (t) => {
      const close = K([[0, 0], [700, 0], [1400, 1], [1800, 1], [2500, 0]])(t);
      const home = K([[0, 0], [1400, 0], [2400, 1], [3500, 1], [4300, 0]])(t);
      const flash = K([[0, 0], [1350, 0], [1700, 0.9], [2600, 0]])(t);   // eased ring, once per loop
      return {
        hands: [R('open', 0.75 - 0.22 * close, 0.97), L('open', 0.25 + 0.22 * close, 0.97)],
        chair: { x: mix(0.7, 0.5, home), y: mix(0.3, 0.38, home), size: mix(0.14, 0.2, home), yaw: mix(80, 30, home), tilt: mix(-15, 0, home) },
        draw: (g, F) => { ring(g, F, 0.5, 0.38, 0.1 + 0.08 * (1 - flash), flash * 0.7); label(g, F, '↺ reset', 0.5, 0.12, CYAN, flash); }
      };
    }
  },
  wheel: {
    T: 5200, still: 2600,
    at: (t) => {
      const hold = K([[0, 0], [300, 0], [1300, 1]])(t);
      const wheelA = K([[0, 0], [1200, 0], [1500, 1], [3400, 1], [3900, 0]])(t);
      const aim = K([[0, 0], [1500, 0], [2200, 1], [3600, 1], [4200, 0]])(t);
      const pick = K([[0, 0], [2500, 0], [2800, 1], [3300, 1], [3600, 0]])(t);
      const pose = t < 1500 ? POSES.peace : POSES.point;
      return {
        hands: [{ ...pose, x: 0.6 + 0.1 * aim, y: 0.98 - 0.05 * aim, s: 0.25, roll: 0 }, L(pick > 0.5 ? 'pinch' : 'ready', 0.18, 0.97, { pinch: pick })],
        draw: (g, F) => {
          arc(g, F, 0.6, 0.62, 0.06, t < 1500 ? hold : 0, 0.9);
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
          label(g, F, 'tape', 0.5, 0.33 + 0.02, WARM, wheelA * pick);
        }
      };
    }
  },
  undo: {
    T: 4400, still: 1500,
    at: (t) => {
      const hold = K([[0, 0], [300, 0], [1300, 1], [1500, 0]])(t);
      const back = K([[0, 0], [1300, 0], [2200, 1], [3500, 1], [4300, 0]])(t);
      const open = K([[0, 0], [2000, 0], [2400, 1], [3700, 1], [4100, 0]])(t);
      const h = mixVal(POSES.thumb, POSES.open, open);
      return {
        hands: [{ ...h, x: 0.76, y: mix(0.78, 0.95, open), s: 0.25, roll: mix(-130, 0, open) }],
        chair: { x: mix(0.56, 0.36, back), y: 0.38, size: 0.2, yaw: mix(75, 30, back) },
        draw: (g, F) => { arc(g, F, 0.76, 0.68, 0.07, hold); label(g, F, '↶ undo', 0.36, 0.13, CYAN, K([[0, 0], [1300, 0], [1600, 1], [2800, 1], [3300, 0]])(t)); }
      };
    }
  },
  tape: {
    T: 5000, still: 2600,
    at: (t) => {
      const drag = K([[0, 0], [1100, 0], [2500, 1], [3800, 1], [4600, 0]])(t);
      const press = K([[0, 0], [700, 0], [1000, 1], [2600, 1], [2900, 0]])(t);
      const shown = K([[0, 0], [2700, 0], [3000, 1], [3900, 1], [4300, 0]])(t);
      return {
        hands: [R('point', 0.42 + 0.3 * drag, 0.96), L(press > 0.5 ? 'pinch' : 'ready', 0.16, 0.96, { pinch: press })],
        chair: { x: 0.55, y: 0.4, size: 0.24, yaw: 20, a: 0.55 },
        draw: (g, F, _t, hands) => {
          const [x, y] = tipOf(hands);
          const a0 = poseToLandmarks(R('point', 0.42, 0.96), F.aspect)[8];   // the cursor where the drag began
          const A = [a0[0], a0[1] - 0.14];
          const B = [x, y - 0.14];
          ring(g, F, B[0] / F.aspect, B[1], 0.03, 0.95);
          if (press > 0.05 || shown > 0.05) {
            const a = Math.max(press, shown);
            g.beginPath(); g.moveTo(F.x(A[0]), F.y(A[1])); g.lineTo(F.x(B[0]), F.y(B[1]));
            g.strokeStyle = `rgba(${WARM},${0.9 * a})`; g.lineWidth = F.lw * 1.6; g.stroke();
            for (const P of [A, B]) { g.beginPath(); g.arc(F.x(P[0]), F.y(P[1]), 3.5 * F.dpr, 0, Math.PI * 2); g.fillStyle = `rgba(${WARM},${a})`; g.fill(); }
            label(g, F, '45.2 cm', (A[0] + B[0]) / 2 / F.aspect, (A[1] + B[1]) / 2 - 0.05, WARM, shown);
          }
        }
      };
    }
  },
  lens: {
    T: 5000, still: 2600,
    at: (t) => {
      const mv = K([[0, 0], [1600, 1], [3400, 1], [4800, 0]])(t);
      const grow = K([[0, 0], [1700, 0], [2800, 1], [3800, 1], [4600, 0]])(t);
      const press = K([[0, 0], [1500, 0], [1700, 1], [3000, 1], [3200, 0]])(t);
      return {
        hands: [R('point', 0.45 + 0.18 * mv, 0.96), L(press > 0.5 ? 'pinch' : 'ready', 0.16, 0.96 - 0.1 * grow, { pinch: press })],
        chair: { x: 0.58, y: 0.38, size: 0.24, a: 0.5 },
        draw: (g, F, _t, hands) => {
          const [x, y] = tipOf(hands);
          const cx = F.x(x), cy = F.y(y - 0.14), r = (0.07 + 0.06 * grow) * F.h;
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
          label(g, F, `r ${Math.round(40 + 60 * grow)} px`, x / F.aspect, y - 0.14 - 0.07 - 0.06 * grow - 0.02, WARM, press);
        }
      };
    }
  },
  ring: {
    T: 5200, still: 1800,
    at: (t) => {
      const spin = K([[0, 0], [800, 0], [2400, 1]])(t);
      const grip = K([[0, 0], [600, 0], [900, 1], [2400, 1], [2700, 0]])(t);
      const open = K([[0, 0], [3000, 0], [3400, 1], [4500, 1], [5000, 0]])(t);
      const h = t < 2900 ? { ...mixVal(POSES.open, POSES.fist, grip), x: 0.35 + 0.3 * spin, y: 0.96, s: 0.25, roll: 0 } : R('point', 0.55, 0.96);
      return {
        hands: t < 2900 ? [h] : [h, L(open > 0.5 ? 'pinch' : 'ready', 0.18, 0.96, { pinch: Math.min(1, open * 2) })],
        draw: (g, F) => {
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
            g.fillStyle = `rgba(16,22,29,${0.85})`;
            g.strokeStyle = `rgba(${front > 0.5 ? WARM : CYAN},${0.25 + 0.6 * (it.z + 1) / 2})`;
            g.lineWidth = F.lw;
            g.beginPath(); g.rect(cx - w / 2, cy - hh / 2, w, hh); g.fill(); g.stroke();
          }
        }
      };
    }
  },
  pin: {
    T: 4400, still: 1900,
    at: (t) => {
      const fist = K([[0, 0], [600, 0], [1000, 1], [2800, 1], [3200, 0]])(t);
      const tug = K([[0, 0], [1100, 0], [2400, 1], [3400, 1], [4200, 0]])(t);
      const h = mixVal(POSES.open, POSES.fist, fist);
      const lock = K([[0, 0.5], [1100, 0.5], [1500, 1], [2800, 1], [3300, 0.5]])(t);
      return {
        hands: [{ ...h, x: 0.5 + 0.2 * tug, y: 0.95, s: 0.25, roll: 0 }],
        chair: { x: 0.5 + 0.01 * tug, y: 0.38, size: 0.2 },
        draw: (g, F) => {
          g.font = `${18 * F.dpr}px system-ui`; g.textAlign = 'center';
          g.globalAlpha = lock; g.fillText('📌', F.x(0.5 * F.aspect), F.y(0.14)); g.globalAlpha = 1;
          label(g, F, 'pinned · stays put', 0.5, 0.06 + 0.02, WARM, (lock - 0.5) * 2);
        }
      };
    }
  },
  upload: {
    T: 4400, still: 3000,
    at: (t) => {
      const drop = K([[0, 0], [400, 0], [1500, 1]])(t);
      const build = K([[0, 0], [1500, 0], [2600, 1], [3700, 1], [4300, 0]])(t);
      const fileA = K([[0, 0], [300, 1], [1600, 1], [1900, 0], [4000, 0], [4300, 0]])(t);
      return {
        hands: [],
        chair: { x: 0.5, y: 0.42, size: 0.2, a: 0.85 * build, yaw: 30 + 40 * build },
        draw: (g, F) => {
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
      };
    }
  },
  completion: {
    T: 6000, still: 3200,
    at: (t) => {
      const wipe = K([[0, 0], [600, 0], [2600, 1], [4000, 1], [5600, 0]])(t);
      return {
        hands: [],
        chair: { x: 0.5, y: 0.42, size: 0.26, yaw: 25, tilt: -28, inferred: wipe },
        after: (g, F) => {
          label(g, F, 'measured', 0.3, 0.1, CYAN, 0.9);
          label(g, F, 'inferred', 0.72, 0.1, WARM, 0.3 + 0.6 * wipe);
          label(g, F, wipe > 0.5 ? 'after: underside filled' : 'before: underside missing', 0.5, 0.94, wipe > 0.5 ? WARM : CYAN, 0.85);
        }
      };
    }
  },
  photo3d: {
    T: 5200, still: 3400,
    at: (t) => {
      const go = K([[0, 0], [900, 0], [2400, 1], [4200, 1], [5000, 0]])(t);
      return {
        hands: [],
        chair: { x: 0.68, y: 0.42, size: 0.18, yaw: 20 + 90 * go, a: 0.85 * go, inferred: go },
        after: (g, F) => {
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
      };
    }
  }
};

export const FEATURES = Object.keys(SCRIPTS);

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

// Recorded clip -> the slot's frame source. Image landmarks are 0..1 of the camera frame; we
// mirror x (selfie view) and keep the camera's aspect so the hand isn't stretched.
function clipSource(clip) {
  const aspect = clip.video && clip.video.width && clip.video.height ? clip.video.width / clip.video.height : 4 / 3;
  const frames = clip.frames || [];
  const T = Math.max(1, clip.durationMs || (frames.length ? frames[frames.length - 1].t : 1));
  return {
    T: T + 600, still: T * 0.5, aspect,
    at: (t) => {
      let i = 0;
      while (i < frames.length - 1 && frames[i + 1].t <= t) i++;
      const f = frames[i] || { hands: [] };
      return { lmHands: f.hands.map((h) => ({ handedness: h.handedness, lm: (h.landmarks || []).map(([x, y, z]) => [(1 - x) * aspect, y, z || 0]) })) };
    }
  };
}

// ---------------------------------------------------------------- slot
export function mountDemo(fig, { clipBase = 'assets/gesture-clips/' } = {}) {
  const canvas = fig.querySelector('canvas') || fig.appendChild(document.createElement('canvas'));
  const g = canvas.getContext('2d');
  const feature = fig.dataset.feature;
  let src = SCRIPTS[feature] ? { ...SCRIPTS[feature], aspect: 1.6 } : null;
  let playing = !REDUCED, visible = false, raf = 0, t0 = performance.now(), tPaused = src ? src.still : 0, last = 0;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp';
  fig.append(btn);
  const syncBtn = () => {
    btn.textContent = playing ? '❚❚' : '▶';
    btn.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} the ${fig.dataset.name || feature} animation`);
  };
  syncBtn();
  btn.addEventListener('click', () => (playing ? slot.pause() : slot.play()));

  function sceneAt(t) {
    const sc = src.at(t);
    const aspect = src.aspect;
    const hands = sc.lmHands || (sc.hands || []).map((p) => ({ handedness: p.left ? 'Left' : 'Right', lm: poseToLandmarks(p, aspect) }));
    return { sc, hands };
  }

  function draw(t) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    g.clearRect(0, 0, W, H);
    if (!src) return;
    // Fit the source frame (aspect) inside the canvas, centred: "contain".
    const fh = Math.min(H, W / src.aspect), fw = fh * src.aspect;
    const ox = (W - fw) / 2, oy = (H - fh) / 2;
    const F = { w: fw, h: fh, aspect: src.aspect, dpr, lw: 1.4 * dpr, x: (u) => ox + (u / src.aspect) * fw, y: (v) => oy + v * fh };
    const { sc, hands } = sceneAt(t);
    if (sc.chair) drawChair(g, F, sc.chair);
    if (sc.draw) sc.draw(g, F, t, hands);
    hands.forEach((h) => drawHand(g, F, h.lm, 1));
    if (sc.after) sc.after(g, F, t);
  }

  function loop(now) {
    raf = 0;
    if (!playing || !visible || document.hidden) return;
    raf = requestAnimationFrame(loop);
    if (now - last < 1000 / FPS_CAP - 2) return;
    last = now;
    draw((now - t0) % src.T);
  }
  function kick() {
    if (playing && visible && !document.hidden && !raf && src) raf = requestAnimationFrame(loop);
    if (!playing) draw(tPaused);
  }

  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; kick(); }, { rootMargin: '80px' });
  io.observe(fig);
  const ro = new ResizeObserver(() => { if (!playing || !visible) draw(tPaused); });
  ro.observe(canvas);
  const onVis = () => kick();
  document.addEventListener('visibilitychange', onVis);

  const slot = {
    source: 'placeholder',
    get playing() { return playing; },
    play() { playing = true; t0 = performance.now() - tPaused; syncBtn(); kick(); },
    pause() { tPaused = (performance.now() - t0) % (src ? src.T : 1); playing = false; syncBtn(); if (raf) cancelAnimationFrame(raf); raf = 0; draw(tPaused); },
    frameAt(t) { return src ? { hands: sceneAt(t).hands.map((h) => ({ handedness: h.handedness, landmarks: h.lm })) } : { hands: [] }; },
    destroy() { io.disconnect(); ro.disconnect(); document.removeEventListener('visibilitychange', onVis); if (raf) cancelAnimationFrame(raf); btn.remove(); }
  };

  // Upgrade to the owner's recorded clip when one exists (never blocks the placeholder).
  const clipName = fig.dataset.clip;
  if (clipName) {
    loadClipIndex(clipBase).then((names) => {
      if (!names.has(clipName)) return null;
      return fetch(`${clipBase}${clipName}.json`).then((r) => (r.ok ? r.json() : null));
    }).then((clip) => {
      if (!clip || clip.schema !== 'gesture-clip/1') return;
      src = clipSource(clip);
      tPaused = src.still;
      slot.source = 'clip';
      fig.classList.add('has-clip');
      const tag = document.createElement('span');
      tag.className = 'src';
      tag.textContent = 'recorded hand';
      fig.append(tag);
      t0 = performance.now();
      kick();
    }).catch(() => { /* keep the placeholder */ });
  }
  kick();
  return slot;
}

export function mountAll(root = document, opts) {
  return [...root.querySelectorAll('figure.demo')].map((fig) => mountDemo(fig, opts));
}

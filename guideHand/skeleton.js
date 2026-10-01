// guideHand/skeleton.js — the solid "mannequin hand" renderer for guide animations.
//
// PROVENANCE. Ported from the owner's ASL project, asl-recognizer/js/skeleton.js
// (handSpan, drawHandShape and its helpers, makeFit), unchanged apart from this header, one
// backward-compatible option (drawHandShape opts.span) and dropping the stick-figure
// drawSkeleton / vectorToPixels, which the guides don't use.
// Why the solid hand: asl-recognizer/docs/CHANGELOG.md, 2026-09-04 "Demo hand is now a solid
// mannequin hand, not a stick figure" — thin lines + dots were hard to read; a filled palm,
// fat rounded digits each outlined separately (so neighbours show a seam), knuckle creases
// and nails on a soft gradient read at a glance, and fists read as fists.
//
// Contract: pure canvas, no DOM lookups. pts = 21 [x, y] in canvas pixels (MediaPipe hand
// topology). drawHandShape(ctx, pts, opts) never throws on junk (bad input draws nothing).

// span of the point cloud (bbox diagonal) — used to size strokes to the hand
export function handSpan(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY) || 1;
}


// ---------------------------------------------------------------------------
// drawHandShape — the same 21 points, but rendered as a SOLID mannequin hand
// (filled palm + fat rounded fingers + little nails) instead of a stick figure.
// Much easier to read in the demo panels. Pure canvas; pts = 21 [x,y] in px.
// ---------------------------------------------------------------------------

const FINGERS = [
  [5, 6, 7, 8],     // index
  [9, 10, 11, 12],  // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];
const THUMB = [1, 2, 3, 4];
const TIP_IDX = [8, 12, 16, 20];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]) || 1;
const norm = (a) => mul(a, 1 / len(a));

// B22 palm/back gradient stops [light end, shaded end]
const FACE_PALM = ["#fbf5ee", "#d8c9b8"];
const FACE_BACK = ["#8693a6", "#56637a"];
function mixHex(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(", ")})`;
}

// The palm/back PATTERN, drawn on the palm blob only (fingers paint over it).
// Palm side: two soft creases (heart + life line) — what a real palm shows.
// Back side: diagonal hatching. Both fade with |face| so edge-on is plain.
// Both are laid out in the hand's own frame (centre/up/side), not screen
// space, so the lines ride with a moving hand instead of swimming across it.
function facePattern(ctx, palm, f, { centre, up, side, span, halfW }) {
  const at = (u, s) => add(centre, add(mul(up, u), mul(side, s)));
  ctx.save();
  blobPath(ctx, palm);
  ctx.clip();
  if (f > 0.05) {
    ctx.strokeStyle = `rgba(120, 92, 70, ${(0.45 * f).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, span * 0.012);
    // heart line: across the upper palm, under the knuckles
    let a = at(-span * 0.02, -halfW * 0.85), c = at(-span * 0.08, 0), b = at(-span * 0.03, halfW * 0.75);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke();
    // life line: arcs round the thumb mound toward the wrist
    a = at(-span * 0.09, halfW * 0.55); c = at(-span * 0.2, halfW * 0.05); b = at(-span * 0.34, halfW * 0.35);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke();
  } else if (f < -0.05) {
    ctx.strokeStyle = `rgba(15, 23, 42, ${(0.5 * -f).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, span * 0.01);
    const gap = Math.max(4, span * 0.055);
    const d = norm(add(up, side)); // 45° to the palm axis
    const n = [-d[1], d[0]];
    const reach = span * 0.8;
    ctx.beginPath();
    for (let k = -reach; k <= reach; k += gap) {
      const o = add(centre, mul(n, k));
      ctx.moveTo(o[0] - d[0] * reach, o[1] - d[1] * reach);
      ctx.lineTo(o[0] + d[0] * reach, o[1] + d[1] * reach);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// closed path smoothed through `poly` (quadratics via midpoints)
function blobPath(ctx, poly) {
  ctx.beginPath();
  const n = poly.length;
  let mid = mul(add(poly[n - 1], poly[0]), 0.5);
  ctx.moveTo(mid[0], mid[1]);
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const m = mul(add(cur, nxt), 0.5);
    ctx.quadraticCurveTo(cur[0], cur[1], m[0], m[1]);
  }
  ctx.closePath();
}

export function drawHandShape(ctx, pts, {
  fill,
  outline = "#1f2b3d",
  outlineWidth,
  alpha = 1,
  nails = true,
  // optional: { z: number[21] } of per-landmark relative depth (MediaPipe
  // convention: smaller z = closer to the camera). Rendering-only — never
  // changes geometry, only paint order, stroke width, nail visibility, and
  // the light gradient's axis. null reproduces exactly today's behavior.
  depth = null,
  // optional (B22): which side of the hand faces the viewer, -1..1 —
  // +1 palm toward the viewer, 0 edge-on ("palm to the side"), -1 the back
  // of the hand toward the viewer. Drives a light, plain-creased palm vs a
  // darker, hatched back (brightness + pattern, never hue alone — 7c), blended
  // continuously so a hand turning over shades smoothly instead of popping.
  // null reproduces exactly today's look. Ignored for colour when `fill` is
  // given (the hero hand keeps its accent), but the pattern still applies.
  face = null,
  // (hologram addition) size reference in px. Default = this frame's bbox diagonal, as in ASL;
  // the guide player passes the OPEN hand's span so a hand closing into a fist keeps the same
  // finger width instead of thinning as its bbox shrinks.
  span: spanRef = null,
} = {}) {
  if (!pts || pts.length < 21) return;
  for (const p of pts) if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;

  const z = depth && depth.z;
  const f = face === null || face === undefined || !isFinite(face) ? null : Math.max(-1, Math.min(1, face));
  const span = spanRef > 0 ? spanRef : handSpan(pts);
  const fingerW = span * 0.115;
  const thumbW = span * 0.15;
  const ol = outlineWidth ?? Math.max(2, span * 0.02);

  const knuckles = [0, 5, 9, 13, 17].map((i) => pts[i]);
  const centre = mul(knuckles.reduce(add), 1 / knuckles.length);
  const up = norm(sub(pts[9], pts[0]));       // wrist -> middle knuckle
  const side = [-up[1], up[0]];
  const halfW = len(sub(pts[5], pts[17])) * 0.5;

  // palm perimeter: wrist (pinky side) -> knuckles (nudged out to meet fingers)
  // -> thumb mound -> wrist (thumb side). No wrist stub — keeps it clean.
  const pad = fingerW * 0.6;
  const out = (i, extra = 0) => add(pts[i], mul(norm(sub(pts[i], centre)), pad + extra));
  const wrist = add(pts[0], mul(up, span * 0.03)); // a hair below the wrist point
  const palm = [
    add(wrist, mul(side, -halfW * 0.8)),
    out(17, fingerW * 0.2),
    out(13),
    out(9),
    out(5),
    add(pts[1], mul(norm(sub(pts[1], centre)), pad * 1.3)), // thumb mound
    add(wrist, mul(side, halfW * 0.8)),
  ];

  const grad =
    fill ||
    (() => {
      let minY = Infinity, maxY = -Infinity;
      for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      let x0 = 0, y0 = minY - span * 0.15, x1 = 0, y1 = maxY + span * 0.15;
      // With depth, tilt the "light from above" axis to follow the palm
      // normal's 2D projection instead of staying screen-locked vertical —
      // as the hand turns, the shading turns with it.
      if (z) {
        const v1 = [pts[5][0] - pts[0][0], pts[5][1] - pts[0][1], z[5] - z[0]];
        const v2 = [pts[17][0] - pts[0][0], pts[17][1] - pts[0][1], z[17] - z[0]];
        const nx = v1[1] * v2[2] - v1[2] * v2[1];
        const ny = v1[2] * v2[0] - v1[0] * v2[2];
        const nlen = Math.hypot(nx, ny);
        if (nlen > 1e-6) {
          const dx = nx / nlen, dy = ny / nlen;
          x0 = centre[0] - dx * span * 0.5; y0 = centre[1] - dy * span * 0.5;
          x1 = centre[0] + dx * span * 0.5; y1 = centre[1] + dy * span * 0.5;
        }
      }
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      if (f === null) {
        g.addColorStop(0, "#f1f4f8");
        g.addColorStop(1, "#bcc7d6");
      } else {
        // palm: light and faintly warm; back: a clearly darker slate. The
        // luminance gap (~95 levels) is the cue; the warmth is only a bonus.
        const b = (1 - f) / 2; // 0 = palm, 1 = back
        g.addColorStop(0, mixHex(FACE_PALM[0], FACE_BACK[0], b));
        g.addColorStop(1, mixHex(FACE_PALM[1], FACE_BACK[1], b));
      }
      return g;
    })();

  const digit = (chain, w) => {
    ctx.beginPath();
    ctx.moveTo(pts[chain[0]][0], pts[chain[0]][1]);
    for (let i = 1; i < chain.length; i++) ctx.lineTo(pts[chain[i]][0], pts[chain[i]][1]);
    ctx.lineWidth = w + ol * 2;
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.strokeStyle = grad;
    ctx.stroke();
  };

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // palm first (outline then fill), then each digit as its own outlined shape
  // so neighbours always show a seam.
  blobPath(ctx, palm);
  ctx.lineWidth = ol * 2;
  ctx.strokeStyle = outline;
  ctx.stroke();
  ctx.fillStyle = grad;
  ctx.fill();
  if (f !== null) facePattern(ctx, palm, f, { centre, up, side, span, halfW });

  // Digit paint order: without depth, the old fixed pinky -> ring -> middle
  // -> index -> thumb (thumb always reads on top). With depth, sort
  // back-to-front by each digit's own mean z instead, so a nearer finger
  // correctly occludes one crossing behind it — occlusion is the depth cue
  // people actually read, more than any shading trick.
  const meanZ = (idxs) => idxs.reduce((s, i) => s + z[i], 0) / idxs.length;
  const digits = [
    { chain: FINGERS[3], w: fingerW },
    { chain: FINGERS[2], w: fingerW },
    { chain: FINGERS[1], w: fingerW },
    { chain: FINGERS[0], w: fingerW },
    { chain: THUMB, w: thumbW },
  ];
  let zAvg = 0;
  if (z) {
    for (const d of digits) d.z = meanZ(d.chain);
    zAvg = meanZ([...Array(21).keys()]);
    digits.sort((a, b) => b.z - a.z); // larger z = farther (MediaPipe convention) -> drawn first
  }
  for (const d of digits) {
    // Perspective width: a digit nearer than the hand's average depth reads
    // a touch fatter, one farther a touch thinner — real perspective, not
    // just occlusion order.
    const w = z ? d.w * (1 + 0.25 * (zAvg - d.z)) : d.w;
    digit(d.chain, w);
  }

  // knuckle creases — a short darker line across each finger base
  ctx.strokeStyle = "rgba(31, 43, 61, 0.35)";
  ctx.lineWidth = Math.max(1, span * 0.008);
  for (const f of FINGERS) {
    const a = pts[f[0]], b = pts[f[1]];
    const d = norm(sub(b, a));
    const perp = [-d[1], d[0]];
    const m = add(a, mul(sub(b, a), 0.12));
    ctx.beginPath();
    ctx.moveTo(m[0] - perp[0] * fingerW * 0.42, m[1] - perp[1] * fingerW * 0.42);
    ctx.lineTo(m[0] + perp[0] * fingerW * 0.42, m[1] + perp[1] * fingerW * 0.42);
    ctx.stroke();
  }

  if (nails) {
    for (const t of TIP_IDX) {
      const dir = norm(sub(pts[t], pts[t - 1]));
      const c = add(pts[t], mul(dir, -fingerW * 0.28));
      // Conditional nails: draw a nail only when the tip reads farther from
      // camera than its own DIP joint (the finger's back is toward you) —
      // otherwise the pad faces the camera, so a nail would be wrong; draw a
      // soft crease instead. This is the honest, per-finger, data-derived
      // answer to "can't tell front from back of hand": the project already
      // proved a single global front/back label isn't derivable from this
      // dataset, but a *local* cue per finger, from real z, is.
      const showNail = z ? z[t] > z[t - 1] : true;
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate(Math.atan2(dir[1], dir[0]));
      if (showNail) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
        ctx.beginPath();
        ctx.ellipse(0, 0, fingerW * 0.3, fingerW * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = "rgba(31, 43, 61, 0.28)";
        ctx.lineWidth = Math.max(1, span * 0.006);
        ctx.beginPath();
        ctx.moveTo(-fingerW * 0.22, 0);
        ctx.lineTo(fingerW * 0.22, 0);
        ctx.stroke();
      }
      ctx.restore();
    }
  }
  ctx.restore();
}

// A fit computed ONCE from a set of bounds points, returned as a closure that
// maps further [x,y] pairs the same way — instead of vectorToPixels' approach
// of refitting a bbox to every single frame's current pose. That per-frame
// refit is why the animated reference hand used to swell/shrink/drift as
// fingers moved: each frame's bbox is a different size, and nothing anchors
// the wrist, so the whole hand appears to breathe rather than stay put.
//
// `boundsPts` should be the UNION of everything that will ever be drawn
// through the returned closure (e.g. the neutral pose + the target pose) so
// the scale never has to change mid-animation. `anchorAt` pins the point at
// `boundsPts[anchorIdx]` (default: the first pose's wrist, which is always
// [0,0] in this normalized frame) to that fraction of the canvas, rather than
// centering the bbox — so the wrist stays visually planted instead of the
// whole hand drifting as its silhouette changes shape.
//
// `contain` (optional, a canvas fraction): if anchoring would push any bounds
// point closer than that to an edge, slide the whole fit back inside (the
// anchor moves; the scale doesn't). A hand pointing DOWN from a wrist pinned
// at 82% height went off the bottom (checklist #58: Q, N; T off the right).
export function makeFit(boundsPts, w, h, { pad = 0.16, mirror = false, anchorIdx = 0, anchorAt = [0.5, 0.82], contain = null } = {}) {
  const sx = mirror ? -1 : 1;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of boundsPts) {
    const px = x * sx;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = (maxX - minX) || 1e-6;
  const spanY = (maxY - minY) || 1e-6;
  const scale = Math.min((w * (1 - 2 * pad)) / spanX, (h * (1 - 2 * pad)) / spanY);
  const anchor = boundsPts[anchorIdx] || [0, 0];
  const ax = anchor[0] * sx;
  const ay = anchor[1];
  let ox = w * anchorAt[0] - ax * scale;
  let oy = h * anchorAt[1] - ay * scale;
  if (typeof contain === "number") {
    // the scaled span always fits inside pad (scale above), so with
    // contain <= pad this range is never empty
    const clamp = (o, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, o)));
    ox = clamp(ox, w * contain - minX * scale, w * (1 - contain) - maxX * scale);
    oy = clamp(oy, h * contain - minY * scale, h * (1 - contain) - maxY * scale);
  }
  return ([x, y]) => [x * sx * scale + ox, y * scale + oy];
}

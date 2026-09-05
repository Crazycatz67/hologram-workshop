const STYLE = {
  bone: 'rgba(110, 214, 255, 0.85)',
  joint: 'rgba(232, 252, 255, 0.95)',
  tip: '#4fd1ff',
  pinching: '#7fe3a1',
  labelText: '#dff6ff',
  labelBg: 'rgba(3, 12, 20, 0.72)'
};

const TIPS = new Set([4, 8, 12, 16, 20]);

// The video is shown mirrored so it behaves like a mirror. The canvas itself is NOT
// CSS-mirrored — that would reverse the text too — so x is flipped here instead.
function toPixels(landmark, width, height, mirror) {
  return {
    x: (mirror ? 1 - landmark.x : landmark.x) * width,
    y: landmark.y * height
  };
}

export function sizeOverlayTo(canvas, video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return false;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return true;
}

export function drawHands(ctx, hands, connections, { mirror = true } = {}) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  for (const hand of hands) {
    const points = hand.landmarks.map((lm) => toPixels(lm, width, height, mirror));
    drawSkeleton(ctx, points, connections, hand);
    drawLabel(ctx, points, hand, width);
  }
}

function drawSkeleton(ctx, points, connections, hand) {
  ctx.lineWidth = Math.max(2, ctx.canvas.width / 480);
  ctx.strokeStyle = hand.pinch?.pinching ? STYLE.pinching : STYLE.bone;
  ctx.beginPath();
  for (const { start, end } of connections) {
    ctx.moveTo(points[start].x, points[start].y);
    ctx.lineTo(points[end].x, points[end].y);
  }
  ctx.stroke();

  const r = Math.max(3, ctx.canvas.width / 320);
  points.forEach((p, i) => {
    ctx.fillStyle = TIPS.has(i) ? STYLE.tip : STYLE.joint;
    ctx.beginPath();
    ctx.arc(p.x, p.y, TIPS.has(i) ? r * 1.3 : r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawLabel(ctx, points, hand, width) {
  const wrist = points[0];
  const parts = [hand.handedness, hand.gesture !== 'None' ? hand.gesture : null];
  if (hand.pinch) parts.push(hand.pinch.pinching ? 'PINCH' : `pinch ${hand.pinch.ratio.toFixed(2)}`);
  const text = parts.filter(Boolean).join('  ·  ');

  const size = Math.max(14, width / 48);
  ctx.font = `${size}px ui-monospace, Menlo, Consolas, monospace`;
  const metrics = ctx.measureText(text);
  const padX = size * 0.5;
  const padY = size * 0.35;
  const boxW = metrics.width + padX * 2;
  const boxH = size + padY * 2;
  const x = Math.min(Math.max(wrist.x - boxW / 2, 4), width - boxW - 4);
  const y = wrist.y + size * 1.2;

  ctx.fillStyle = STYLE.labelBg;
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = hand.pinch?.pinching ? STYLE.pinching : STYLE.labelText;
  ctx.textBaseline = 'top';
  ctx.fillText(text, x + padX, y + padY);
}

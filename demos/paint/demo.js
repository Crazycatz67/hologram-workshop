// Light painting: pinch-hold (or mouse-drag) to draw glowing lines in the air in front of the
// chair hologram. Goal: light all six sparks, each with a stroke of ITS colour, so the palette
// matters and there is a time to beat. Free painting carries on after the win.
// Framework contract: demos/playground.js (CONTRACT).
//
// Photosafety (BUGS #14): strokes never change colour once drawn, the palette only changes on a
// deliberate press (no cycling), and a spark lights with an eased 400 ms rise to a steady glow.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const V = new URL(import.meta.url).search;
const { easeTo } = await import('../playground.js' + V);

export const PALETTE = [
  { name: 'cyan', hex: 0x4fd1ff },
  { name: 'magenta', hex: 0xff5fd2 },
  { name: 'amber', hex: 0xffb040 },
  { name: 'lime', hex: 0x9dff6a },
  { name: 'white', hex: 0xeef6ff }
];
// Sparks: [x, y] as fractions of the chair's half-size on the paint plane, and a palette index.
const SPARKS = [[-1.05, 0.55, 0], [-0.25, 1.15, 1], [0.75, 0.75, 2], [1.05, -0.2, 0], [0.2, -0.95, 1], [-0.9, -0.55, 2]];
const SPARK_HIT_PX = 30;      // a stroke point this close (screen px) to a spark lights it
const MIN_STEP_PX = 3;        // new stroke point only after this much cursor travel
const MAX_POINTS = 1500;
const MAX_STROKES = 200;

let ctx = null;
let chair = null;
let planePoint = null;        // a point on the paint plane (in front of the chair)
let strokes = [];             // { colour, pts: Vector3[], px: {x,y}[], core, halo, lit: Set }
let active = null;
let colour = 0;
let sparks = [];              // { mesh, ring, colour, lit, glow }
let buttons = [];
const resolution = new THREE.Vector2(1, 1);

function lineMaterials(hex) {
  const core = new LineMaterial({ color: hex, linewidth: 4, transparent: true, opacity: 0.95, depthWrite: false });
  const halo = new LineMaterial({ color: hex, linewidth: 14, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
  return [core, halo];
}

function newStroke() {
  const hex = PALETTE[colour].hex;
  const [cm, hm] = lineMaterials(hex);
  const s = { colour, pts: [], px: [], core: new Line2(new LineGeometry(), cm), halo: new Line2(new LineGeometry(), hm), lit: new Set() };
  s.core.renderOrder = 3;
  s.halo.renderOrder = 2;
  s.core.visible = s.halo.visible = false;   // until it has two points
  ctx.root.add(s.halo, s.core);
  return s;
}

function addPoint(s, ndc) {
  const p = ctx.ndcToPlane(ndc, planePoint);
  if (!p || s.pts.length >= MAX_POINTS) return;
  const px = ctx.toScreen(p);
  const last = s.px[s.px.length - 1];
  if (last && Math.hypot(px.x - last.x, px.y - last.y) < MIN_STEP_PX) return;
  s.pts.push(p);
  s.px.push(px);
  if (s.pts.length >= 2) {
    const flat = s.pts.flatMap((v) => [v.x, v.y, v.z]);
    // LineGeometry can't grow in place; a fresh one per point is cheap at these sizes.
    for (const line of [s.core, s.halo]) {
      line.geometry.dispose();
      line.geometry = new LineGeometry();
      line.geometry.setPositions(flat);
      line.computeLineDistances();
      line.visible = true;
    }
  }
  for (const sp of sparks) {
    if (sp.colour !== s.colour || s.lit.has(sp)) continue;
    const c = ctx.toScreen(sp.mesh.position);
    if (Math.hypot(c.x - px.x, c.y - px.y) <= SPARK_HIT_PX) s.lit.add(sp);
  }
  relight();
}

function removeStroke(s) {
  for (const line of [s.core, s.halo]) {
    ctx.root.remove(line);
    line.geometry.dispose();
    line.material.dispose();
  }
}

// Which sparks are lit = the union over the strokes that still exist (so undo/clear unlight).
function relight() {
  const lit = new Set();
  for (const s of strokes) for (const sp of s.lit) lit.add(sp);
  if (active) for (const sp of active.lit) lit.add(sp);
  for (const sp of sparks) {
    if (!sp.lit && lit.has(sp)) ctx.sfx('spark');
    sp.lit = lit.has(sp);
  }
}

function setColour(i) {
  colour = i;
  buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
  ctx.setStatus(`Colour: ${PALETTE[i].name}`);
}

function endStroke() {
  if (!active) return;
  if (active.pts.length < 2) removeStroke(active);
  else {
    strokes.push(active);
    while (strokes.length > MAX_STROKES) removeStroke(strokes.shift());
    ctx.sfx('stroke');
  }
  active = null;
  relight();
}

function undo() {
  if (active) { removeStroke(active); active = null; }
  const s = strokes.pop();
  if (s) { removeStroke(s); ctx.sfx('undo'); }
  relight();
  ctx.setStatus(s ? 'Stroke undone' : 'Nothing to undo');
}

function clearAll() {
  if (active) { removeStroke(active); active = null; }
  for (const s of strokes) removeStroke(s);
  strokes = [];
  relight();
  ctx.setStatus('Cleared');
}

export default {
  id: 'paint',
  title: 'Light painting',
  thumb: '🖌️',
  tutorial: [
    { icon: '🤏', text: 'Aim, then pinch-hold your other hand to paint', keys: 'mouse drag' },
    { icon: '🎨', text: 'Pick a colour; light each spark in its colour', keys: '1-5' },
    { icon: '👎', text: 'Thumbs-down undoes a stroke; clap clears', keys: 'U · C' }
  ],

  async load(c) {
    ctx = c;
    chair = await ctx.loadGLB('../assets/chair/chair_detail.glb');
    // A dim, steady backdrop: the paint is the bright thing on screen.
    chair.traverse((o) => {
      if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: 0x2a6a88, transparent: true, opacity: 0.35, depthWrite: false });
    });
    const box = new THREE.Box3().setFromObject(chair);
    chair.position.sub(box.getCenter(new THREE.Vector3()));
    ctx.root.add(chair);
    const size = box.getSize(new THREE.Vector3());
    const half = Math.max(size.x, size.y) / 2;
    ctx.frameView(new THREE.Box3(new THREE.Vector3(-half * 1.5, -half * 1.4, -half), new THREE.Vector3(half * 1.5, half * 1.4, half)));
    planePoint = new THREE.Vector3(0, 0, size.z / 2 + 0.08);

    for (const [fx, fy, ci] of SPARKS) {
      const hex = PALETTE[ci].hex;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.25 }));
      mesh.position.set(fx * half, fy * half, planePoint.z);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.04, 0.048, 32), new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
      ring.position.copy(mesh.position);
      ctx.root.add(mesh, ring);
      sparks.push({ mesh, ring, colour: ci, lit: false, glow: 0 });
    }

    buttons = PALETTE.map((p, i) => {
      const b = document.createElement('button');
      b.dataset.hand = '';
      b.title = `${p.name} (${i + 1})`;
      b.setAttribute('aria-label', `Colour ${p.name}`);
      b.style.cssText = `background:#${p.hex.toString(16).padStart(6, '0')};border:2px solid transparent;border-radius:50%;width:48px;height:48px;padding:0`;
      b.addEventListener('click', () => setColour(i));
      ctx.panel.append(b);
      return b;
    });
    // The pressed swatch gets a white rim (static style; no animation).
    const style = document.createElement('style');
    style.textContent = '#panel button[aria-pressed="true"]{border-color:#fff!important;box-shadow:0 0 0 2px #0a0d11 inset}';
    ctx.panel.append(style);
    this._onKey = (e) => { const n = Number(e.key); if (n >= 1 && n <= PALETTE.length && !e.ctrlKey && !e.metaKey) setColour(n - 1); };
    window.addEventListener('keydown', this._onKey);
    setColour(0);
  },

  onGesture(evt) {
    if (evt.type === 'drag') {
      if (evt.phase === 'start') { endStroke(); active = newStroke(); addPoint(active, evt.ndc); } else if (evt.phase === 'move' && active) addPoint(active, evt.ndc);
      else if (evt.phase === 'end') { if (active && evt.ndc) addPoint(active, evt.ndc); endStroke(); }
    } else if (evt.type === 'undo') undo();
    else if (evt.type === 'clap') clearAll();
  },

  tick(dt) {
    ctx.renderer.getSize(resolution);
    for (const s of active ? [...strokes, active] : strokes) {
      s.core.material.resolution.copy(resolution);
      s.halo.material.resolution.copy(resolution);
    }
    // Spark glow eases to its target (tau 130 ms: ~400 ms to settle). Steady once lit.
    for (const sp of sparks) {
      sp.glow = easeTo(sp.glow, sp.lit ? 1 : 0, dt, 0.13);
      sp.mesh.material.opacity = 0.25 + 0.75 * sp.glow;
      sp.mesh.scale.setScalar(1 + 0.6 * sp.glow);
      sp.ring.material.opacity = 0.45 * (1 - sp.glow);
    }
  },

  reset() {
    clearAll();
    setColour(0);
  },

  isWon() {
    return sparks.length > 0 && sparks.every((s) => s.lit);
  },

  winText(t) { return `All sparks lit in ${t}`; },

  dispose() {
    clearAll();
    window.removeEventListener('keydown', this._onKey);
  },

  // Test hook: spark screen positions (canvas px) + colours, stroke count, current colour.
  debug() {
    return {
      colour, strokes: strokes.length,
      sparks: sparks.map((s) => ({ ...ctx.toScreen(s.mesh.position), colour: s.colour, lit: s.lit }))
    };
  }
};

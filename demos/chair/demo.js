// Rebuild the chair: the 8 named parts of assets/chair/chair_detail.glb start scrambled
// (pushed outward and spun about the vertical). Fist-move and twist a part (or mouse-drag it
// and wheel / Q / E to twist); released within SNAP_DIST of home and SNAP_DEG of its home
// rotation, it eases into place with one soft glow. All 8 placed = win.
// Framework contract: demos/playground.js (CONTRACT).
//
// Depth is locked: parts only move in the plane of their home depth, because webcam depth
// (palm size) is the noisiest hand signal (Ricky's playground report) and the mouse has none.
// Scramble is yaw-only for the same reason: wrist twist maps to spin, which is reliable;
// a small accidental tilt still fits inside the 25 deg tolerance.
import * as THREE from 'three';

const V = new URL(import.meta.url).search;
const { easeTo, glowPulse } = await import('../playground.js' + V);

export const SNAP_DIST = 0.04;                          // metres (the GLB is in metres)
export const SNAP_DEG = 25;
const SNAP_MS = 260;                                    // ease into place
const GLOW_MS = 900;                                    // one smooth glow pulse on a snap
const NEAR_FACTOR = 2;                                  // ghost brightens within 2x the tolerance
const SEED = Number(new URLSearchParams(location.search).get('seed')) || 0;

let ctx = null;
let assembly = null;          // Group holding the parts (identity rotation, so local = world axes)
let parts = [];               // { mesh, ghost, name, homePos, homeQuat, placed, snap, glowT, sel, near }
let held = null;              // part being dragged / grabbed
let selected = null;          // last part touched (twist target)
let dragOffset = new THREE.Vector3();
let undoStack = [];
let rand = Math.random;

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AXIS_Y = new THREE.Vector3(0, 1, 0);
function scramble(seed = SEED) {
  rand = seed ? mulberry32(seed) : Math.random;
  const n = parts.length;
  parts.forEach((p, i) => {
    // Spread on a ring around the chair, in order of the part's own angle, so nothing stacks.
    const a = (i / n) * Math.PI * 2 + rand() * 0.4;
    const r = 0.55 + rand() * 0.08;
    p.mesh.position.set(Math.cos(a) * r, Math.sin(a) * r * 0.62, p.homePos.z);
    const deg = (50 + rand() * 100) * (rand() < 0.5 ? -1 : 1);
    p.mesh.quaternion.copy(p.homeQuat).premultiply(new THREE.Quaternion().setFromAxisAngle(AXIS_Y, THREE.MathUtils.degToRad(deg)));
    p.placed = false;
    p.snap = null;
    p.glowT = null;
    p.ghost.material.opacity = 0.1;
    p.ghost.visible = true;
  });
  held = null;
  selected = null;
  undoStack = [];
}

const pickable = () => parts.filter((p) => !p.placed).map((p) => p.mesh);
const partOf = (mesh) => parts.find((p) => p.mesh === mesh) ?? null;

function pickAt(ndc) {
  const hit = ctx.raycast(ndc, pickable())[0];
  return hit ? { part: partOf(hit.object), point: hit.point } : null;
}

// The unplaced part whose screen centre is nearest a screen point (hand grab with no selection).
function nearestPart(ndc) {
  const r = ctx.canvas.getBoundingClientRect();
  const px = { x: ((ndc.x + 1) / 2) * r.width, y: ((1 - ndc.y) / 2) * r.height };
  let best = null;
  for (const p of parts) {
    if (p.placed) continue;
    const s = ctx.toScreen(p.mesh.getWorldPosition(new THREE.Vector3()));
    const d = Math.hypot(s.x - px.x, s.y - px.y);
    if (!best || d < best.d) best = { p, d };
  }
  return best?.p ?? null;
}

function remember(p) {
  undoStack.push({ p, pos: p.mesh.position.clone(), quat: p.mesh.quaternion.clone(), placed: p.placed });
  if (undoStack.length > 50) undoStack.shift();
}

function errorOf(p) {
  return { dist: p.mesh.position.distanceTo(p.homePos), deg: THREE.MathUtils.radToDeg(p.mesh.quaternion.angleTo(p.homeQuat)) };
}

function trySnap(p) {
  if (!p || p.placed) return false;
  const { dist, deg } = errorOf(p);
  if (dist > SNAP_DIST || deg > SNAP_DEG) return false;
  p.placed = true;
  p.snap = { t: 0, pos: p.mesh.position.clone(), quat: p.mesh.quaternion.clone() };
  p.glowT = 0;
  if (held === p) held = null;
  if (selected === p) selected = null;
  ctx.sfx('snap');
  const left = parts.filter((q) => !q.placed).length;
  ctx.setStatus(left ? `${p.name} placed · ${left} to go` : 'Chair rebuilt!');
  return true;
}

function select(p) {
  selected = p;
  if (p) ctx.setStatus(`Holding ${p.name} · twist: wheel / Q / E`);
}

// Moves keep the part at its home depth (see header).
function moveBy(p, d) {
  p.mesh.position.x += d.x;
  p.mesh.position.y += d.y;
}

export default {
  id: 'chair',
  title: 'Rebuild the chair',
  thumb: '🪑',
  tutorial: [
    { icon: '✊', text: 'Fist to grab a part; move it onto its outline', keys: 'mouse drag' },
    { icon: '🔄', text: 'Twist your fist to turn it until it snaps', keys: 'wheel · Q / E' },
    { icon: '👎', text: 'Thumbs-down undoes the last move', keys: 'U' }
  ],

  async load(c) {
    ctx = c;
    const scene = await ctx.loadGLB('../assets/chair/chair_detail.glb');
    assembly = new THREE.Group();
    const box = new THREE.Box3().setFromObject(scene);
    const centre = box.getCenter(new THREE.Vector3());
    const meshes = [];
    scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const mesh of meshes) {
      // Pivot each part on its own centre (so a twist turns it in place), and its home is that
      // centre relative to the chair's centre.
      mesh.updateWorldMatrix(true, false);
      mesh.geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      mesh.geometry.computeBoundingBox();
      const c0 = mesh.geometry.boundingBox.getCenter(new THREE.Vector3());
      mesh.geometry.translate(-c0.x, -c0.y, -c0.z);
      // The scan GLB ships no normals (lit materials would render black without them).
      if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
      mesh.position.copy(c0).sub(centre);
      mesh.quaternion.identity();
      mesh.scale.set(1, 1, 1);
      const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      mesh.material = new THREE.MeshStandardMaterial({ color: src?.color ?? 0xffffff, map: src?.map ?? null, vertexColors: !!mesh.geometry.attributes.color, roughness: 0.8, emissive: 0x4fd1ff, emissiveIntensity: 0 });
      const ghost = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.1, depthWrite: false }));
      ghost.position.copy(mesh.position);
      ghost.renderOrder = -1;
      assembly.add(mesh, ghost);
      parts.push({ mesh, ghost, name: mesh.name || mesh.parent?.name || `part ${parts.length + 1}`, homePos: mesh.position.clone(), homeQuat: new THREE.Quaternion(), placed: false, snap: null, glowT: null, sel: 0, near: 0 });
    }
    // The GLB's node names ("seat cushion", "leg · front right", ...).
    for (const p of parts) p.name = p.mesh.name.replace(/_/g, ' ');
    ctx.root.add(assembly);
    const size = box.getSize(new THREE.Vector3());
    ctx.frameView(new THREE.Box3(new THREE.Vector3(-0.68, -0.4 - size.y * 0.1, -size.z / 2), new THREE.Vector3(0.68, 0.4 + size.y * 0.1, size.z / 2)), 1.35);
    scramble();
  },

  onGesture(evt) {
    const t = evt.type;
    if (t === 'click') {
      const hit = pickAt(evt.ndc);
      select(hit?.part ?? null);
    } else if (t === 'drag') {
      if (evt.phase === 'start') {
        const hit = pickAt(evt.ndc);
        if (!hit) return;
        held = hit.part;
        select(held);
        remember(held);
        const onPlane = ctx.ndcToPlane(evt.ndc, held.mesh.position, new THREE.Vector3(0, 0, 1));
        dragOffset = onPlane ? held.mesh.position.clone().sub(onPlane) : new THREE.Vector3();
      } else if (evt.phase === 'move' && held) {
        const onPlane = ctx.ndcToPlane(evt.ndc, held.homePos, new THREE.Vector3(0, 0, 1));
        if (onPlane) { const want = onPlane.add(dragOffset); moveBy(held, want.sub(held.mesh.position)); }
      } else if (evt.phase === 'end' && held) {
        const p = held;
        held = null;
        trySnap(p);
      }
    } else if (t === 'grab') {
      if (evt.phase === 'start') {
        const target = (selected && !selected.placed ? selected : null) ?? (evt.ndc ? pickAt(evt.ndc)?.part ?? nearestPart(evt.ndc) : null);
        if (!target) return;
        held = target;
        select(held);
        remember(held);
      } else if (evt.phase === 'move') {
        const p = held ?? (selected && !selected.placed ? selected : null) ?? (evt.ndc ? pickAt(evt.ndc)?.part : null);
        if (!p) return;
        if (!held) { remember(p); select(p); }
        if (evt.dPos) moveBy(p, evt.dPos);
        if (evt.dQuat) p.mesh.quaternion.premultiply(evt.dQuat);
        if (!held) trySnap(p);   // a wheel / key twist on a resting part can complete it
      }
    } else if (t === 'release') {
      const p = held;
      held = null;
      trySnap(p);
    } else if (t === 'tilt') {
      const p = held ?? selected;
      if (p && !p.placed && evt.dQuat) { p.mesh.quaternion.premultiply(evt.dQuat); if (!held) trySnap(p); }
    } else if (t === 'undo') {
      const u = undoStack.pop();
      if (!u) { ctx.setStatus('Nothing to undo'); return; }
      u.p.mesh.position.copy(u.pos);
      u.p.mesh.quaternion.copy(u.quat);
      u.p.placed = u.placed;
      u.p.snap = null;
      u.p.ghost.visible = true;
      ctx.sfx('undo');
      ctx.setStatus(`Undid ${u.p.name}`);
    }
    // clap: the framework puts the view back; the parts stay where they are.
  },

  tick(dt) {
    for (const p of parts) {
      if (p.snap) {
        p.snap.t += dt * 1000;
        const u = Math.min(1, p.snap.t / SNAP_MS);
        const e = 1 - (1 - u) ** 3;
        p.mesh.position.lerpVectors(p.snap.pos, p.homePos, e);
        p.mesh.quaternion.slerpQuaternions(p.snap.quat, p.homeQuat, e);
        if (u >= 1) p.snap = null;
      }
      let glow = 0;
      if (p.glowT !== null) {
        p.glowT += dt * 1000;
        glow = glowPulse(p.glowT, GLOW_MS) * 0.55;
        if (p.glowT >= GLOW_MS) p.glowT = null;
      }
      // Selected: a steady low glow, eased in and out.
      p.sel = easeTo(p.sel, !p.placed && (p === selected || p === held) ? 0.18 : 0, dt);
      p.mesh.material.emissiveIntensity = Math.max(glow, p.sel);
      // Ghost: brighter while the held part is near home; gone once placed (eased).
      const { dist, deg } = errorOf(p);
      const close = !p.placed && dist < SNAP_DIST * NEAR_FACTOR && deg < SNAP_DEG * NEAR_FACTOR;
      p.near = easeTo(p.near, p.placed ? -0.1 : close ? 0.3 : 0.1, dt, 0.2);
      p.ghost.material.opacity = Math.max(0, p.near);
      p.ghost.visible = p.near > 0.005;
    }
  },

  reset() { scramble(); },

  // Two players: each rebuilds the same scramble (the match seed); fastest time wins.
  turnMode: 'timeTrial',
  onTurnStart(player, info) { scramble(SEED || info.seed); },

  isWon() { return parts.length > 0 && parts.every((p) => p.placed); },

  winText(t) { return `Chair rebuilt in ${t}`; },

  dispose() { parts = []; },

  // Test hook: per part, a screen point ON the part (a ray there hits it first), its home on
  // screen (same offset), and the yaw error in 15 deg twist steps.
  debug() {
    return parts.map((p) => {
      const grip = gripPoint(p);
      const { dist, deg } = errorOf(p);
      const q = p.homeQuat.clone().multiply(p.mesh.quaternion.clone().invert());
      const yaw = THREE.MathUtils.radToDeg(2 * Math.atan2(q.y, q.w));
      // Where to release the grip so the part lands home: the drag moves the part's centre
      // in the plane z = home depth, so map the grip onto that plane and shift it by the error.
      let home = null;
      if (grip) {
        const gs = ctx.toScreen(grip);
        const r = ctx.canvas.getBoundingClientRect();
        const onPlane = ctx.ndcToPlane({ x: (gs.x / r.width) * 2 - 1, y: 1 - (gs.y / r.height) * 2 }, p.homePos, new THREE.Vector3(0, 0, 1));
        home = onPlane ? ctx.toScreen(onPlane.add(p.homePos).sub(p.mesh.position)) : null;
      }
      return { name: p.name, placed: p.placed, dist, deg, yawToHome: yaw, errX: p.homePos.x - p.mesh.position.x, errY: p.homePos.y - p.mesh.position.y, grip: grip ? ctx.toScreen(grip) : null, home };
    });
  }
};

// A world point on the part's surface that is the front-most hit from the camera, so a click
// there lands on this part (tests only).
function gripPoint(p) {
  if (p.placed) return null;
  // Triangle centroids lie on the surface (a scaled vertex can miss a thin, curved runner).
  const g = p.mesh.geometry;
  const pos = g.attributes.position;
  const idx = g.index;
  const tris = (idx ? idx.count : pos.count) / 3;
  const r = ctx.canvas.getBoundingClientRect();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const step = Math.max(1, Math.floor(tris / 300));
  for (let t = 0; t < tris; t += step) {
    const at = (k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    a.fromBufferAttribute(pos, at(0)); b.fromBufferAttribute(pos, at(1)); c.fromBufferAttribute(pos, at(2));
    const w = a.add(b).add(c).divideScalar(3).applyMatrix4(p.mesh.matrixWorld);
    const s = ctx.toScreen(w);
    const ndc = { x: (s.x / r.width) * 2 - 1, y: 1 - (s.y / r.height) * 2 };
    const hit = ctx.raycast(ndc, pickable())[0];
    if (hit?.object === p.mesh) return hit.point.clone();
  }
  return null;
}

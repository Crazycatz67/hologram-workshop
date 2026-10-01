// Block tower (Jenga-lite): a 15-block wall tower, 7 layers (rows of three short blocks
// alternating with one long beam). Grab a block with a fist (or mouse drag), pull it out
// sideways and set it on the top; three blocks from below the top row resting on top = win.
// If a block you never touched hits the floor (or tips past 30 deg) the tower has fallen:
// the physics eases into slow motion (no shake, no flash) and a clap / C rebuilds it.
// Framework contract: demos/playground.js (CONTRACT).
//
// Why "pull out N" and not "rebuild a target height": choosing WHICH block is safe to take
// is the tension that makes Jenga fun, and it starts from the tower the player sees. A
// rebuild goal is the chair game again (carry pieces to a spot) with gravity added.
//
// Why a flat (2D) tower: webcam depth is the noisiest hand signal, so every body is locked
// to the camera-facing plane (cannon-es linearFactor / angularFactor). Held blocks are
// KINEMATIC and driven by velocity toward the hand target, so they push neighbours
// physically instead of teleporting through them; on release the throw speed is capped.
import * as THREE from 'three';
import * as CANNON from '../lib/cannon-es.js';

const V = new URL(import.meta.url).search;
const { easeTo, glowPulse } = await import('../playground.js' + V);

// Units: 1 = one short block's width (~2.5 cm at Jenga scale). Gravity is lower than "real"
// at that scale so a fall is readable rather than instant.
export const BLOCK_H = 0.6;
export const SHORT_W = 1;
export const LONG_W = 3.1;
export const DEPTH = 1;
export const LAYERS = 7;                 // S L S L S L S -> 4*3 + 3 = 15 blocks
export const GOAL = 3;                   // blocks to move onto the top
const HELD_SLIM = 0.04;                  // held block's half-height shrink
const GAP = 0.04;                        // between short blocks in a row
const GRAVITY = -18;
const MAX_HOLD_SPEED = 6;                // units/s the kinematic block may chase the hand
const MAX_THROW = 2.5;                   // units/s cap on the release velocity
const FALL_TILT_DEG = 30;
const SLOWMO = 0.35;                     // physics time scale while a collapse plays out
const SETTLE_MS = 600;                   // goal blocks must rest this long to count

let ctx = null;
let world = null;
let blocks = [];      // { mesh, body, layer, kind, startPos, touched, glowT, sel }
let held = null;      // { b, target: Vector3, offset, vel: Vector3, lastTarget }
let selected = null;
let collapsed = false;
let collapseWhy = null;    // first block that tripped the fall rule (debug only)
let collapseT = 0;
let timeScale = 1;
let settleMs = 0;
let topY0 = 0;
let won = false;
let floorMesh = null;
// Two players (real Jenga turns): each turn = pull ONE block from below the top row and set it
// on top; whoever topples the tower loses. turn = { block, rest: [{x,y}], topY, settleMs, done }.
let multi = false;
let turn = null;
const TURN_SETTLE_MS = 900;    // the placed block (and so the turn) must rest this long
const towerTop = () => Math.max(...blocks.map((b) => b.body.position.y + BLOCK_H / 2));

const matStd = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05, emissive: 0x4fd1ff, emissiveIntensity: 0 });

function layout() {
  // Bottom-up rows; even rows = three short blocks, odd rows = one long beam.
  const out = [];
  for (let l = 0; l < LAYERS; l++) {
    const y = l * BLOCK_H + BLOCK_H / 2;
    if (l % 2 === 0) for (const i of [-1, 0, 1]) out.push({ layer: l, kind: 'short', x: i * (SHORT_W + GAP), y, w: SHORT_W });
    else out.push({ layer: l, kind: 'long', x: 0, y, w: LONG_W });
  }
  return out;
}

function build() {
  for (const b of blocks) { world.removeBody(b.body); ctx.root.remove(b.mesh); b.mesh.geometry.dispose(); }
  blocks = [];
  // Mid-tone wood: a carried block sweeping across the dark backdrop must stay under the
  // photosafety luminance step (BUGS #14), so no near-white blocks.
  const woods = [0x9c7a50, 0x8f6f47, 0xa5845a];
  layout().forEach((s, i) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, BLOCK_H, DEPTH), matStd(woods[i % 3]));
    const full = new CANNON.Box(new CANNON.Vec3(s.w / 2, BLOCK_H / 2 - 0.001, DEPTH / 2));
    const slim = new CANNON.Box(new CANNON.Vec3(s.w / 2, BLOCK_H / 2 - HELD_SLIM, DEPTH / 2));
    const body = new CANNON.Body({ mass: s.kind === 'long' ? 3 : 1, shape: full, material: blockMat });
    body.position.set(s.x, s.y, 0);
    body.linearFactor.set(1, 1, 0);
    body.angularFactor.set(0, 0, 1);
    body.linearDamping = 0.05;
    body.angularDamping = 0.1;
    body.allowSleep = true;
    body.sleepSpeedLimit = 0.05;
    body.sleepTimeLimit = 0.4;
    world.addBody(body);
    ctx.root.add(mesh);
    blocks.push({ mesh, body, full, slim, layer: s.layer, kind: s.kind, startPos: body.position.clone(), touched: false, glowT: null, sel: 0, idx: i });
  });
  // Start asleep so a perfectly stacked tower doesn't creep before the first touch.
  for (const b of blocks) b.body.sleep();
  topY0 = LAYERS * BLOCK_H;
  held = null;
  selected = null;
  collapsed = false;
  collapseWhy = null;
  collapseT = 0;
  timeScale = 1;
  settleMs = 0;
  won = false;
  sync();
}

function sync() {
  for (const b of blocks) {
    b.mesh.position.copy(b.body.position);
    b.mesh.quaternion.copy(b.body.quaternion);
  }
}

const tiltDeg = (b) => { const q = b.body.quaternion; return Math.abs(THREE.MathUtils.radToDeg(2 * Math.atan2(q.z, q.w))) % 180; };
const blockOf = (mesh) => blocks.find((b) => b.mesh === mesh) ?? null;

function pickAt(ndc) {
  const hit = ctx.raycast(ndc, blocks.map((b) => b.mesh))[0];
  return hit ? { b: blockOf(hit.object), point: hit.point } : null;
}
// Hand grab with nothing under the cursor: the block nearest the cursor on screen, within
// 140 px (a webcam cursor is a few blocks wide of wobble; further than that is a miss).
function nearest(ndc) {
  const r = ctx.canvas.getBoundingClientRect();
  const px = { x: ((ndc.x + 1) / 2) * r.width, y: ((1 - ndc.y) / 2) * r.height };
  let best = null;
  for (const b of blocks) {
    const s = ctx.toScreen(b.mesh.position);
    const d = Math.hypot(s.x - px.x, s.y - px.y);
    if (d < 140 && (!best || d < best.d)) best = { b, d };
  }
  return best?.b ?? null;
}

function grab(b, grabPoint) {
  if (!b || collapsed) return;
  if (multi && turn) {
    if (turn.done) return;
    if (turn.block && turn.block !== b) { ctx.setStatus('One block per turn · set yours on top'); return; }
    if (!turn.block && turn.rest[b.idx].y + BLOCK_H / 2 > turn.topY - BLOCK_H * 0.5) { ctx.setStatus('Top-row blocks stay put · pull one from lower down'); return; }
    turn.block = b;
  }
  held = { b, target: new THREE.Vector3().copy(b.body.position), offset: grabPoint ? new THREE.Vector3().copy(b.body.position).sub(grabPoint) : new THREE.Vector3(), vel: new THREE.Vector3() };
  held.target.z = 0;
  held.offset.z = 0;
  b.touched = true;
  selected = b;
  b.body.type = CANNON.Body.KINEMATIC;
  b.body.allowSleep = false;   // a still hand must not put the held block to sleep
  // A held block slides almost frictionless (a waxed Jenga block): with normal friction a
  // kinematic (infinite-mass) block drags the whole row above it along and every pull topples.
  b.body.material = heldMat;
  // ...and is a hair thinner than its slot, so sliding it out doesn't catch the corners of the
  // rows above and below (box-box corner contacts kicked the top row off in tests).
  setShape(b, b.slim);
  b.body.angularVelocity.set(0, 0, 0);
  b.body.wakeUp();
  // Neighbours must react to the kinematic push.
  for (const o of blocks) o.body.wakeUp();
  ctx.setStatus(b.layer === LAYERS - 1 ? 'That is a top-row block: it won\'t count. Pull from lower down.' : 'Slide it out sideways, then set it on top');
}

function setShape(b, shape) {
  if (b.body.shapes[0] === shape) return;
  b.body.removeShape(b.body.shapes[0]);
  b.body.addShape(shape);
}

function release() {
  if (!held) return;
  const { b, vel } = held;
  held = null;
  selected = null;   // a selection is used up by one grab (else the next fist re-grabs it)
  b.body.type = CANNON.Body.DYNAMIC;
  b.body.allowSleep = true;
  b.body.material = blockMat;
  setShape(b, b.full);
  b.body.mass = b.kind === 'long' ? 3 : 1;
  b.body.updateMassProperties();
  if (vel.length() > MAX_THROW) vel.setLength(MAX_THROW);
  b.body.velocity.set(vel.x, vel.y, 0);
  b.body.angularVelocity.set(0, 0, 0);
  b.body.wakeUp();
}

function fallen() {
  if (multi && turn) {
    // 2 players: every block except this turn's must stay where the turn found it.
    for (const b of blocks) {
      if (b === turn.block) continue;
      const r = turn.rest[b.idx];
      const dropped = r.y - b.body.position.y > BLOCK_H * 0.75;
      const t = tiltDeg(b);
      if (dropped || (t > FALL_TILT_DEG && t < 180 - FALL_TILT_DEG)) { collapseWhy = { block: b.idx, dropped, tilt: Math.round(t) }; return true; }
    }
    return false;
  }
  for (const b of blocks) {
    if (b.touched || (held && held.b === b)) continue;
    const dropped = b.startPos.y - b.body.position.y > BLOCK_H * 0.75;
    const t = tiltDeg(b);
    if (dropped || (t > FALL_TILT_DEG && t < 180 - FALL_TILT_DEG)) { collapseWhy = { block: b.idx, dropped, tilt: Math.round(t) }; return true; }
  }
  return false;
}

// Blocks that count: from below the top row, touched, resting above the original top.
function onTop() {
  return blocks.filter((b) => b.touched && b.layer < LAYERS - 1 && (!held || held.b !== b) && b.body.position.y > topY0 && b.body.velocity.length() < 0.15);
}

function tickGlow(dt) {
  for (const b of blocks) {
    let glow = 0;
    if (b.glowT !== null) { b.glowT += dt * 1000; glow = glowPulse(b.glowT, 900) * 0.5; if (b.glowT >= 900) b.glowT = null; }
    b.sel = easeTo(b.sel, (held?.b === b) ? 0.1 : selected === b ? 0.05 : 0, dt);
    b.mesh.material.emissiveIntensity = Math.max(glow, b.sel);
  }
}

// 2 players: the turn is done once this turn's block rests in the top row or above (a block
// may only be taken from lower down, so reaching that height means it was moved up).
function tickTurn(dt) {
  if (!turn || turn.done || collapsed) return;
  const b = turn.block;
  const onTopNow = b && (!held || held.b !== b) && b.body.position.y - BLOCK_H / 2 >= turn.topY - BLOCK_H - 0.08;
  // "At rest" = stayed within 0.05 of where it settled: a woken stack's contacts jitter the
  // instantaneous velocity above any small threshold now and then (seen in headless runs).
  const p = b?.body.position;
  if (!onTopNow || !turn.anchor || Math.hypot(p.x - turn.anchor.x, p.y - turn.anchor.y) > 0.05) {
    turn.anchor = onTopNow ? { x: p.x, y: p.y } : null;
    turn.settleMs = 0;
  } else turn.settleMs += dt * 1000;
  if (turn.settleMs >= TURN_SETTLE_MS) {
    turn.done = true;
    b.glowT = 0;
    ctx.sfx('snap');
  }
}

let blockMat = null;
let heldMat = null;

export default {
  id: 'tower',
  title: 'Block tower',
  thumb: '🧱',
  tutorial: [
    { icon: '✊', text: 'Fist on a block to grab it; slide it out sideways', keys: 'mouse drag' },
    { icon: '🖐', text: `Open your hand to let go. Stack ${GOAL} on top`, keys: 'release' },
    { icon: '👏', text: 'Clap to rebuild the tower', keys: 'C' }
  ],

  async load(c) {
    ctx = c;
    world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0), allowSleep: true });
    world.solver.iterations = 20;
    world.broadphase = new CANNON.SAPBroadphase(world);
    blockMat = new CANNON.Material('block');
    world.addContactMaterial(new CANNON.ContactMaterial(blockMat, blockMat, { friction: 0.5, restitution: 0.02 }));
    heldMat = new CANNON.Material('held');
    world.addContactMaterial(new CANNON.ContactMaterial(heldMat, blockMat, { friction: 0.03, restitution: 0 }));
    const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: blockMat });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(ground);
    floorMesh = new THREE.Mesh(new THREE.CircleGeometry(9, 48), new THREE.MeshStandardMaterial({ color: 0x1a2a36, roughness: 0.95, transparent: true, opacity: 0.85 }));
    floorMesh.rotation.x = -Math.PI / 2;
    ctx.root.add(floorMesh);
    // A faint line at the original top: "stack above this".
    const line = new THREE.Mesh(new THREE.PlaneGeometry(LONG_W + 1.2, 0.03), new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.35, depthWrite: false }));
    line.position.set(0, LAYERS * BLOCK_H + 0.002, DEPTH / 2 + 0.01);
    ctx.root.add(line);
    const light = new THREE.DirectionalLight(0xffffff, 1.1);
    light.position.set(3, 8, 6);
    ctx.root.add(light, new THREE.AmbientLight(0xffffff, 0.35));
    build();
    ctx.frameView(new THREE.Box3(new THREE.Vector3(-4.5, 0, -1), new THREE.Vector3(4.5, LAYERS * BLOCK_H + 2.4, 1)), 1.15);
    ctx.setStatus(`Pull ${GOAL} blocks from below the top row and stack them on top`);
  },

  onGesture(evt) {
    const t = evt.type;
    if (t === 'click') {
      const hit = pickAt(evt.ndc);
      selected = hit?.b ?? null;
    } else if (t === 'drag' || (t === 'grab' && evt.ndc && evt.phase === 'start')) {
      // Mouse drag (and hand pinch-drag) = grab by the point under the cursor.
      if (evt.phase === 'start') {
        if (t === 'grab') {
          // A block picked with a click (pinch) first: the hand cursor wobbles while the hand
          // closes into a fist. Then the block under the cursor, then the nearest one.
          const b = selected ?? pickAt(evt.ndc)?.b ?? nearest(evt.ndc);
          grab(b, null);
          return;
        }
        const hit = pickAt(evt.ndc);
        // Offset measured on the z = 0 plane the moves use (the ray hits the FRONT face, and
        // in perspective that point maps elsewhere on z = 0: the block would dip on grab).
        if (hit) grab(hit.b, ctx.ndcToPlane(evt.ndc, new THREE.Vector3(), new THREE.Vector3(0, 0, 1)));
      } else if (evt.phase === 'move' && held) {
        const p = ctx.ndcToPlane(evt.ndc, new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
        if (p) { held.target.copy(p).add(held.offset); held.target.z = 0; }
      } else if (evt.phase === 'end') release();
    } else if (t === 'grab' && evt.phase === 'move') {
      if (!held) return;   // a wheel / Q / E twist with nothing held does nothing here
      if (evt.dPos) { held.target.x += evt.dPos.x; held.target.y += evt.dPos.y; }
    } else if (t === 'release') release();
    else if (t === 'clap') ctx.restart();   // rebuild + timer back to 0 (framework resets view)
  },

  tick(dt) {
    if (!world) return;
    // Ease the time scale: slow motion while a collapse plays out, back to normal after.
    if (collapsed) collapseT += dt;
    timeScale = easeTo(timeScale, collapsed && collapseT < 2.5 ? SLOWMO : 1, dt, 0.35);
    if (held) {
      const b = held.b.body;
      held.target.y = Math.max(held.target.y, BLOCK_H / 2);
      const want = new THREE.Vector3(held.target.x - b.position.x, held.target.y - b.position.y, 0).divideScalar(Math.max(dt, 1 / 120) * 2);
      if (want.length() > MAX_HOLD_SPEED) want.setLength(MAX_HOLD_SPEED);
      b.velocity.set(want.x, want.y, 0);
      held.vel.lerp(want, 0.3);
    }
    if (dt > 0) world.step(1 / 120, dt * timeScale, 6);
    sync();
    if (!collapsed && fallen()) {
      collapsed = true;
      collapseT = 0;
      release();
      ctx.setStatus(multi ? 'The tower fell' : 'The tower fell · clap or press C to rebuild');
    }
    if (multi) { tickTurn(dt); tickGlow(dt); return; }
    const top = collapsed ? [] : onTop();
    settleMs = top.length >= GOAL ? settleMs + dt * 1000 : 0;
    if (!won && settleMs >= SETTLE_MS) {
      won = true;
      for (const b of top) b.glowT = 0;
      ctx.setStatus('Tower stands!');
    } else if (!won && !collapsed && !held && top.length && top.length < GOAL) ctx.setStatus(`${top.length} of ${GOAL} on top`);
    tickGlow(dt);
  },

  // ---- two players (see playground CONTRACT, TWO PLAYERS) ----
  turnMode: 'alternate',
  turnHint: 'Pull one block from below the top row and set it on top. Topple the tower and you lose.',
  onTurnStart(player, info) {
    multi = true;
    if (info.first) build();
    turn = { block: null, rest: blocks.map((b) => ({ x: b.body.position.x, y: b.body.position.y })), topY: towerTop(), settleMs: 0, anchor: null, done: false };
    ctx.setStatus(`${player.name}: pull one block from below the top row and set it on top`);
  },
  turnResult() {
    if (collapsed) return { lost: true };
    return turn?.done ? { score: 1 } : null;
  },
  scoreText(total) { return `${total} ✓`; },
  lostText(name) { return `${name} toppled the tower`; },

  reset() { build(); ctx.setStatus(`Pull ${GOAL} blocks from below the top row and stack them on top`); },

  isWon() { return won; },

  winText(t) { return `${GOAL} blocks moved in ${t} · the tower stands`; },

  dispose() {
    for (const b of blocks) world?.removeBody(b.body);
    blocks = [];
    world = null;
  },

  // Test hook: per block, its screen centre, layer, whether it counts; plus game state.
  debug() {
    return {
      multi, turn: turn && { block: turn.block?.idx ?? null, topY: turn.topY, done: turn.done, settleMs: turn.settleMs }, collapsed, collapseWhy, won, held: held ? held.b.idx : null, topY0, onTop: collapsed ? 0 : onTop().length, timeScale,
      blocks: blocks.map((b) => ({ i: b.idx, layer: b.layer, kind: b.kind, x: b.body.position.x, y: b.body.position.y, tilt: tiltDeg(b), touched: b.touched, screen: ctx.toScreen(b.mesh.position), asleep: b.body.sleepState === CANNON.Body.SLEEPING }))
    };
  },
  // Test hook: canvas px of a world point (x, y on the tower plane).
  screenOf(x, y) { return ctx.toScreen(new THREE.Vector3(x, y, 0)); }
};

// Marble maze: tilt a 9x9 board to roll the marble from S to the glowing goal ring.
// Three short levels (each about 20-60 s for a first try; well inside the 60-90 s arm-fatigue
// budget); level 2 and 3 add holes. Falling in fades the marble out and back in at the start.
// Best time is kept per level (playground bestKey hook). Framework contract: demos/playground.js.
//
// Input, three ways, one tilt:
//   hand  - the hybrid tilt (fist + second hand) sends world-space dQuat in 'grab' moves; they
//           accumulate and STAY (lower your arms, the board keeps its angle); clap levels it.
//   keys  - hold the arrow keys; release and the board eases back to level.
//   mouse - left-drag is a joystick: the offset from where you pressed sets the tilt.
// The tilt is clamped to MAX_TILT and eased (tau 0.12 s), so no input can snap the board.
//
// Physics trick: the board never moves in the physics world. Gravity is rotated into the
// board's frame instead, so contacts stay exact (a rotating kinematic floor in cannon-es
// tunnels and jitters). The visible board is rotated by the same tilt.
// Procedural walls on purpose: Kenney's Marble Kit is marble-RUN track pieces (ramps,
// funnels), not maze tiles, and a grid of boxes makes level data a 9-line string.
import * as THREE from 'three';
import * as CANNON from '../lib/cannon-es.js';

const V = new URL(import.meta.url).search;
const { easeTo, glowPulse } = await import('../playground.js' + V);

// '#' wall, '.' floor, 'o' hole, 'S' start, 'G' goal. Units: 1 = one cell.
export const LEVELS = [
  ['#########',
   '#S....#.#',
   '###.#.#.#',
   '#...#...#',
   '#.#####.#',
   '#.....#.#',
   '#####.#.#',
   '#G......#',
   '#########'],
  ['#########',
   '#S..o...#',
   '#.#.#.#.#',
   '#.#...#o#',
   '#.#####.#',
   '#...o...#',
   '#.#.#.#.#',
   '#o....#G#',
   '#########'],
  ['#########',
   '#S...o#G#',
   '###.###.#',
   '#o..#...#',
   '#.#.#.###',
   '#...o...#',
   '###.###.#',
   '#o......#',
   '#########']
];
export const MAX_TILT = THREE.MathUtils.degToRad(11);
const N = 9;
const R = 0.3;                 // marble radius
const WALL_H = 0.8;
const G = 30;                  // cells/s^2: brisk but catchable at 11 deg
const HOLE_R = 0.4;            // marble centre this close to a hole's centre drops in
const GOAL_R = 0.38;
const VIEW_TILT = 0.95;        // rad: the board leans toward the camera so it reads as a table
const FADE_OUT = 0.5;          // s
const FADE_IN = 0.45;          // s
const SWAP_S = 0.25;           // s each way, level change fade
// The shared manipulator tilts PI rad per frame-width of hand travel (tuned for turning a model
// to look at it). A marble needs finer control: the board gets HAND_GAIN of that, so full tilt
// is ~0.2 frame widths of hand travel. Synthetic guess; tune from a live probe.
const HAND_GAIN = 0.35;
const MOUSE_FULL = 0.35;       // NDC drag offset that gives full tilt

let ctx = null;
let world = null;
let display = null;            // Group, leaned toward the camera (fixed)
let board = null;              // Group inside display, rotated by the tilt
let levelObjs = [];            // meshes of the current level
let levelBodies = [];
let marble = null;             // { mesh, body }
let level = 0;
let pendingLevel = null;
let grid = [];
let start = { r: 1, c: 1 };
let goal = { r: 1, c: 1 };
let tilt = { x: 0, z: 0 };     // current (eased), radians about board X / Z
let handTilt = { x: 0, z: 0 };   // = handRaw * HAND_GAIN, what the board follows
let handRaw = { x: 0, z: 0 };    // the hand's accumulated tilt (manipulator units)
let manual = null;             // { x, z } while keys or mouse steer, else null
const keys = new Set();
let mouseStart = null;
let state = 'play';            // 'play' | 'falling' | 'fadein' | 'won'
let fadeT = 0;
let falls = 0;
let won = false;
let goalRing = null;
let goalGlowT = null;
let wallMat = null;
let matchLevel = 0;            // 2 players: the level both run
let carriedFalls = 0;          // falls before a mid-turn restart still cost time
const FALL_PENALTY_MS = 5000;
let swap = null;               // { to, t } level change fading out (t < SWAP_S) then in
let marbleMat = null;

const cellX = (c) => c - (N - 1) / 2;
const cellZ = (r) => r - (N - 1) / 2;
const clampT = (v) => Math.max(-MAX_TILT, Math.min(MAX_TILT, v));

function find(ch) {
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (grid[r][c] === ch) return { r, c };
  return null;
}

function clearLevel() {
  for (const o of levelObjs) { board.remove(o); o.geometry?.dispose(); }
  for (const b of levelBodies) world.removeBody(b);
  levelObjs = [];
  levelBodies = [];
}

function buildLevel(n) {
  clearLevel();
  level = n;
  grid = LEVELS[n];
  start = find('S');
  goal = find('G');
  // Floor: one slab (holes are handled by the drop rule, not by gaps in the physics floor).
  const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(N / 2, 0.25, N / 2)), material: wallMat });
  floor.position.set(0, -0.25, 0);
  world.addBody(floor);
  levelBodies.push(floor);
  const floorMesh = new THREE.Mesh(new THREE.BoxGeometry(N, 0.5, N), new THREE.MeshStandardMaterial({ color: 0x18303d, roughness: 0.85 }));
  floorMesh.position.y = -0.25;
  add(floorMesh);
  // Walls: merge each row's runs of '#' into one box (fewer seams, fewer bodies).
  // Mid-dark walls: the board's edge sweeps across the dark backdrop as it tilts, and bright
  // wall tops made that sweep read as a luminance flash in the screencast check (BUGS #14).
  const wallLook = new THREE.MeshStandardMaterial({ color: 0x3a5566, roughness: 0.7, emissive: 0x4fd1ff, emissiveIntensity: 0.03 });
  for (let r = 0; r < N; r++) {
    let c = 0;
    while (c < N) {
      if (grid[r][c] !== '#') { c++; continue; }
      let e = c;
      while (e + 1 < N && grid[r][e + 1] === '#') e++;
      const w = e - c + 1;
      const x = (cellX(c) + cellX(e)) / 2;
      const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(w / 2, WALL_H / 2, 0.5)), material: wallMat });
      body.position.set(x, WALL_H / 2, cellZ(r));
      world.addBody(body);
      levelBodies.push(body);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, 1), wallLook);
      m.position.copy(body.position);
      add(m);
      c = e + 1;
    }
  }
  // Holes: dark discs with a soft rim, so they read as "drop" without any flashing.
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (grid[r][c] !== 'o') continue;
    const hole = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ color: 0x020406 }));
    hole.rotation.x = -Math.PI / 2;
    hole.position.set(cellX(c), 0.005, cellZ(r));
    const rim = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.47, 32), new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.5 }));
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(cellX(c), 0.006, cellZ(r));
    add(hole);
    add(rim);
  }
  const startPad = new THREE.Mesh(new THREE.CircleGeometry(0.32, 32), new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.18 }));
  startPad.rotation.x = -Math.PI / 2;
  startPad.position.set(cellX(start.c), 0.004, cellZ(start.r));
  add(startPad);
  goalRing = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 12, 40), new THREE.MeshStandardMaterial({ color: 0x4fd1ff, emissive: 0x4fd1ff, emissiveIntensity: 0.5 }));
  goalRing.rotation.x = -Math.PI / 2;
  goalRing.position.set(cellX(goal.c), 0.06, cellZ(goal.r));
  add(goalRing);
  goalGlowT = null;
  respawn(false);
  handTilt = { x: 0, z: 0 };
  handRaw = { x: 0, z: 0 };
  tilt = { x: 0, z: 0 };
  won = false;
  falls = 0;
  ctx.setStatus(`Level ${n + 1} of ${LEVELS.length}${n ? ' · mind the holes' : ''}`);
  highlightLevelButtons();
}

function add(o) { board.add(o); levelObjs.push(o); }

function respawn(fade = true) {
  const b = marble.body;
  b.position.set(cellX(start.c), R + 0.001, cellZ(start.r));
  b.velocity.setZero();
  b.angularVelocity.setZero();
  b.quaternion.set(0, 0, 0, 1);
  if (!world.bodies.includes(b)) world.addBody(b);
  state = fade ? 'fadein' : 'play';
  fadeT = 0;
  marbleMat.opacity = fade ? 0 : 1;
}

function cellOf(x, z) { return { r: Math.round(z + (N - 1) / 2), c: Math.round(x + (N - 1) / 2) }; }

// Board orientation from the tilt (board-local X then Z).
const tiltQuat = (t) => new THREE.Quaternion().setFromEuler(new THREE.Euler(t.x, 0, t.z, 'XYZ'));

function onKey(e) {
  if (!e.key.startsWith('Arrow')) return;
  if (e.type === 'keydown') keys.add(e.key); else keys.delete(e.key);
}
function onBlur() { keys.clear(); }

let levelBtns = [];
function highlightLevelButtons() {
  levelBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === level)); b.style.borderColor = i === level ? 'var(--accent)' : ''; });
}

export default {
  id: 'maze',
  title: 'Marble maze',
  thumb: '🔮',
  tutorial: [
    { icon: '✊', text: 'Fist one hand, move the other to tilt the board', keys: 'arrows · drag' },
    { icon: '🎯', text: 'Roll the marble into the glowing ring; avoid the holes', keys: '' },
    { icon: '👏', text: 'Clap to level the board and restart the marble', keys: 'C' }
  ],

  async load(c) {
    ctx = c;
    world = new CANNON.World({ gravity: new CANNON.Vec3(0, -G, 0) });
    world.solver.iterations = 10;
    wallMat = new CANNON.Material('wall');
    const ballMat = new CANNON.Material('ball');
    world.addContactMaterial(new CANNON.ContactMaterial(wallMat, ballMat, { friction: 0.3, restitution: 0.25 }));
    display = new THREE.Group();
    display.rotation.x = VIEW_TILT;
    board = new THREE.Group();
    display.add(board);
    // A fixed table under the board, close to the walls' brightness: as the board tilts its
    // edges sweep over this instead of the black backdrop, which read as a dip-and-return
    // flash in the screencast check (BUGS #14).
    const table = new THREE.Mesh(new THREE.BoxGeometry(N + 4, 0.3, N + 4), new THREE.MeshStandardMaterial({ color: 0x31495a, roughness: 0.9 }));
    table.position.y = -1.6;
    display.add(table);
    ctx.root.add(display);
    marbleMat = new THREE.MeshStandardMaterial({ color: 0xdff6ff, roughness: 0.15, metalness: 0.3, emissive: 0x4fd1ff, emissiveIntensity: 0.25, transparent: true, opacity: 1 });
    const body = new CANNON.Body({ mass: 1, shape: new CANNON.Sphere(R), material: ballMat, linearDamping: 0.12, angularDamping: 0.3 });
    marble = { mesh: new THREE.Mesh(new THREE.SphereGeometry(R, 32, 16), marbleMat), body };
    // A darker band so the roll is visible.
    const band = new THREE.Mesh(new THREE.TorusGeometry(R * 0.995, 0.03, 8, 32), new THREE.MeshStandardMaterial({ color: 0x2a6f8f, transparent: true }));
    marble.mesh.add(band);
    marble.band = band;
    board.add(marble.mesh);
    const light = new THREE.DirectionalLight(0xffffff, 1.0);
    light.position.set(2, 8, 6);
    ctx.root.add(light, new THREE.AmbientLight(0xffffff, 0.45));
    // Level buttons (hand cursor presses them like any other button).
    for (let i = 0; i < LEVELS.length; i++) {
      const btn = document.createElement('button');
      btn.textContent = `${i + 1}`;
      btn.title = `Level ${i + 1}`;
      btn.dataset.hand = '';
      btn.addEventListener('click', () => { pendingLevel = i; ctx.restart(); btn.blur(); });
      ctx.panel.append(btn);
      levelBtns.push(btn);
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    buildLevel(0);
    display.updateMatrixWorld(true);
    ctx.frameView(new THREE.Box3().setFromObject(display), 1.12);
  },

  onGesture(evt) {
    const t = evt.type;
    // The hybrid tilt arrives inside 'grab' moves (fist + second hand = the manipulator's GRAB
    // mode; its dQuat carries the tilt), two-hand TRANSFORM sends 'tilt'. Both feed the board;
    // the fist's own motion (dPos) and twist (yaw) are dropped by the up-vector projection.
    if ((t === 'tilt' || (t === 'grab' && evt.phase === 'move')) && evt.dQuat) {
      if (evt.source === 'key') return;   // arrows are read as held keys (continuous) instead
      // World-space rotation -> board frame: D*T' = dQ*D*T  =>  T' = D^-1 dQ D T.
      const D = display.quaternion;
      const T = tiltQuat(handRaw);
      const T2 = D.clone().invert().multiply(evt.dQuat).multiply(D).multiply(T);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(T2);
      const lim = MAX_TILT / HAND_GAIN;
      const cl = (v) => Math.max(-lim, Math.min(lim, v));
      handRaw = { x: cl(Math.asin(THREE.MathUtils.clamp(up.z, -1, 1))), z: cl(Math.asin(THREE.MathUtils.clamp(-up.x, -1, 1))) };
      handTilt = { x: handRaw.x * HAND_GAIN, z: handRaw.z * HAND_GAIN };
    } else if (t === 'drag') {
      if (evt.phase === 'start') mouseStart = evt.ndc;
      else if (evt.phase === 'move' && mouseStart) {
        const dx = evt.ndc.x - mouseStart.x;
        const dy = evt.ndc.y - mouseStart.y;
        manual = { x: clampT((-dy / MOUSE_FULL) * MAX_TILT), z: clampT((-dx / MOUSE_FULL) * MAX_TILT) };
      } else if (evt.phase === 'end') { mouseStart = null; manual = null; }
    } else if (t === 'clap') {
      handTilt = { x: 0, z: 0 };
      handRaw = { x: 0, z: 0 };
      if (state === 'play') respawn(true);
    }
  },

  tick(dt) {
    if (!world) return;
    if (swap) {
      swap.t += dt;
      if (swap.t >= SWAP_S && swap.to !== null) { buildLevel(swap.to); swap.to = null; }
      const u = Math.min(1, Math.abs(swap.t - SWAP_S) / SWAP_S);
      const ss = u * u * (3 - 2 * u);
      // Dim to 45%, not to black: a full dip-and-return inside 1 s counts as a flash itself.
      ctx.canvas.style.opacity = String(0.45 + 0.55 * ss);
      if (swap.t >= 2 * SWAP_S) { swap = null; ctx.canvas.style.opacity = ''; }
    }
    // Keys win over the hand while held; the mouse joystick sets `manual` directly.
    if (keys.size) {
      manual = {
        x: keys.has('ArrowUp') ? -MAX_TILT : keys.has('ArrowDown') ? MAX_TILT : 0,
        z: keys.has('ArrowLeft') ? MAX_TILT : keys.has('ArrowRight') ? -MAX_TILT : 0
      };
      manual.fromKeys = true;
    } else if (manual?.fromKeys) manual = null;
    const want = manual ?? handTilt;
    tilt.x = easeTo(tilt.x, want.x, dt, 0.12);
    tilt.z = easeTo(tilt.z, want.z, dt, 0.12);
    const q = tiltQuat(tilt);
    board.quaternion.copy(q);
    const g = new THREE.Vector3(0, -G, 0).applyQuaternion(q.clone().invert());
    world.gravity.set(g.x, g.y, g.z);

    const b = marble.body;
    if (state === 'falling') {
      fadeT += dt;
      marble.mesh.position.y -= dt * 1.2;
      marbleMat.opacity = Math.max(0, 1 - fadeT / FADE_OUT);
      if (fadeT >= FADE_OUT) respawn(true);
    } else {
      if (dt > 0) world.step(1 / 120, dt, 6);
      marble.mesh.position.copy(b.position);
      marble.mesh.quaternion.copy(b.quaternion);
      if (state === 'fadein') {
        fadeT += dt;
        marbleMat.opacity = Math.min(1, fadeT / FADE_IN);
        if (fadeT >= FADE_IN) state = 'play';
      }
      const cell = cellOf(b.position.x, b.position.z);
      const ch = grid[cell.r]?.[cell.c];
      const off = Math.hypot(b.position.x - cellX(cell.c), b.position.z - cellZ(cell.r));
      if (state !== 'won' && ch === 'o' && off < HOLE_R) {
        state = 'falling';
        fadeT = 0;
        falls++;
        world.removeBody(b);
        marble.mesh.position.set(cellX(cell.c), marble.mesh.position.y, cellZ(cell.r));
        ctx.setStatus(`Dropped in · back to the start (${falls})`);
      } else if (state !== 'won' && ch === 'G' && off < GOAL_R) {
        state = 'won';
        won = true;
        goalGlowT = 0;
        ctx.sfx('win');
        ctx.setStatus(`Level ${level + 1} done!`);
      }
    }
    marble.band.material.opacity = marbleMat.opacity;
    // Goal: steady glow, one eased pulse on arrival.
    let glow = 0;
    if (goalGlowT !== null) { goalGlowT += dt * 1000; glow = glowPulse(goalGlowT, 1100); if (goalGlowT > 1100) goalGlowT = null; }
    goalRing.material.emissiveIntensity = 0.5 + glow * 0.6;
  },

  // A level change dims the canvas (0.25 s), swaps the layout, brightens again: an instant
  // swap was a 0.14 single-frame luminance step in the screencast check (BUGS #14).
  reset() {
    const next = pendingLevel ?? (won ? (level + 1) % LEVELS.length : level);
    pendingLevel = null;
    won = false;
    if (next === level) { buildLevel(next); return; }
    swap = { to: next, t: 0 };
  },

  isWon() { return won; },

  // Two players: both run the same level (the one showing, or a level button pressed before
  // the first turn); each fall adds FALL_PENALTY_MS to that player's time; fastest wins.
  turnMode: 'timeTrial',
  turnHint: `Same level for both. Fastest time wins; a fall adds ${FALL_PENALTY_MS / 1000} s.`,
  onTurnStart(player, info) {
    if (info.first && !info.restart) matchLevel = pendingLevel ?? level;
    carriedFalls = info.restart ? carriedFalls + falls : 0;
    pendingLevel = null;
    won = false;
    if (matchLevel !== level) swap = { to: matchLevel, t: 0 };
    else buildLevel(level);
    ctx.setStatus(`${player.name}: level ${matchLevel + 1} · a fall costs ${FALL_PENALTY_MS / 1000} s`);
  },
  penaltyMs() { return (carriedFalls + falls) * FALL_PENALTY_MS; },
  bestKey() { return `level${level + 1}`; },
  winText(t) { return `Level ${level + 1} in ${t}`; },
  againText() { return level + 1 < LEVELS.length ? `→ Level ${level + 2}` : '↻ Back to level 1'; },

  dispose() {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    window.removeEventListener('blur', onBlur);
    world = null;
  },

  // Test hook: marble cell/position/velocity (board frame), tilt, state, and the shortest
  // hole-free path of cells from the marble to the goal (for the autopilot in tests).
  debug() {
    const b = marble.body;
    const from = cellOf(b.position.x, b.position.z);
    return {
      level, state, won, falls, tilt: { ...tilt },
      pos: { x: b.position.x, z: b.position.z }, vel: { x: b.velocity.x, z: b.velocity.z }, cell: from,
      path: bfs(from).map(({ r, c }) => ({ r, c, x: cellX(c), z: cellZ(r) }))
    };
  }
};

function bfs(from) {
  const key = (p) => p.r * N + p.c;
  const prev = new Map([[key(from), null]]);
  const q = [from];
  while (q.length) {
    const p = q.shift();
    if (p.r === goal.r && p.c === goal.c) break;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { r: p.r + dr, c: p.c + dc };
      const ch = grid[n.r]?.[n.c];
      if (!ch || ch === '#' || ch === 'o' || prev.has(key(n))) continue;
      prev.set(key(n), p);
      q.push(n);
    }
  }
  const out = [];
  for (let p = prev.has(key(goal)) ? goal : null; p; p = prev.get(key(p))) out.push(p);
  return out.reverse();
}

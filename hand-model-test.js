// Hand model checks (handModel.js, Phase 2 track A).
//
//   A. Asset: both .glb files load, mode 'model', 25 bones per rig, shaders compile.
//   B. Constant size: the same hand at 0.4 m and 0.8 m from the webcam draws within 10% of
//      the same size (world landmarks, and the image-only fallback). ghostHands.js is measured
//      on the same input as the "before" number.
//   C. No distortion: the drawn hand's shape (knuckle width / hand length) and size (fraction of
//      the view's height) are the same at 4:3 and 21:9 viewports and 4:3 / 16:9 videos.
//   D. Pose: every finger bone points where the tracked bone points (open, curled, fist,
//      turned); landmarkOf(hand, 8) is the index tip bone; position follows the image wrist.
//   E. Handedness: the label picks the rig; a clearly curled hand's shape overrides a wrong label.
//   F. Photosafety: appearing, disappearing and resting fade (no frame-to-frame step).
//   G. Fallback: an asset that can't load gives ghostHands (mode 'ghost'), no throw.
//   H. Runtime: handsRuntime draws handModel; with ?camera=1 the hidden debug overlay is not
//      redrawn every frame (and is while visible).
//   Z. 0 console errors.
//
// Synthetic hands: the hand model's own rest skeleton, posed by forward kinematics in the test,
// turned into MediaPipe worldLandmarks (metres, hand-centred, x right / y down / z away,
// unmirrored) and image landmarks through a pinhole webcam at a chosen distance.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const V = new URL(import.meta.url).search;
const { createHandModel, MP_TO_JOINT, HAND_FRAC } = await import('./handModel.js' + V);
const { createGhostHands } = await import('./ghostHands.js' + V);

const out = document.getElementById('out');
out.textContent = '';
const log = (s) => { out.textContent += s + '\n'; };
const results = [], metrics = {};
const consoleErrors = [];
window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));
const origError = console.error;
const MEDIAPIPE_INFO = /^INFO: /;
console.error = (...a) => { const m = a.map(String).join(' '); if (!MEDIAPIPE_INFO.test(m)) consoleErrors.push(m); origError(...a); };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
const params = new URLSearchParams(location.search);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const f3 = (x) => x.toFixed(3);

// ---- synthetic hands --------------------------------------------------------------------------
const loader = new GLTFLoader();
async function restOf(side) {
  const g = await loader.loadAsync(`./assets/hand/${side}.glb`);
  const bones = {};
  g.scene.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  return MP_TO_JOINT.map((n) => bones[n].position.clone());
}
const REST = { left: await restOf('left'), right: await restOf('right') };

function frameOf(P) {
  const a = P[9].clone().sub(P[0]).normalize();
  const s = P[5].clone().sub(P[17]);
  s.addScaledVector(a, -s.dot(a)).normalize();
  const n = new THREE.Vector3().crossVectors(s, a);
  return { s, a, n, q: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(s, a, n)) };
}
// Which way the palm faces along frameOf().n (fingers curl toward the palm): measured on the
// rest pose, whose fingers are slightly bent.
function palmSign(P) {
  const { n } = frameOf(P);
  let sum = 0;
  for (const [t, b] of [[8, 5], [12, 9], [16, 13], [20, 17]]) sum += n.dot(P[t].clone().sub(P[b]));
  return Math.sign(sum);
}
const FINGER_CHAINS = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];

// Pose the rest skeleton: curl (radians at each finger joint, toward the palm), then turn the
// whole hand so it stands fingers-up facing the camera, then yaw / pitch it.
function posed(side, { curl = 0, curlThumb = 0, yaw = 0, pitch = 0, roll = 0 } = {}) {
  const P = REST[side].map((p) => p.clone());
  const { s } = frameOf(P);
  const sign = palmSign(REST[side]);
  const axis = s.clone().multiplyScalar(sign);   // right-hand rule: positive angle bends palm-ward
  for (const ch of FINGER_CHAINS) {
    for (let k = 0; k < 3; k++) {
      const pivot = P[ch[k]].clone();
      const q = new THREE.Quaternion().setFromAxisAngle(axis, curl);
      for (let j = k + 1; j < 4; j++) P[ch[j]].sub(pivot).applyQuaternion(q).add(pivot);
    }
  }
  if (curlThumb) {
    const ch = [1, 2, 3, 4];
    for (let k = 1; k < 3; k++) {
      const pivot = P[ch[k]].clone();
      const q = new THREE.Quaternion().setFromAxisAngle(frameOf(P).a, curlThumb * sign);
      for (let j = k + 1; j < 4; j++) P[ch[j]].sub(pivot).applyQuaternion(q).add(pivot);
    }
  }
  // Rest frame -> fingers up, knuckle line along x.
  const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)));
  const R = want.multiply(frameOf(REST[side]).q.clone().invert());
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
  R.premultiply(turn);
  const c = new THREE.Vector3();
  P.forEach((p) => c.add(p));
  c.divideScalar(P.length);
  return P.map((p) => p.sub(c).applyQuaternion(R)); // view space (x right, y up, z to viewer), metres
}

// View-space metric points -> a MediaPipe hand seen by an unmirrored webcam at distance D, with
// the wrist at image point (u, v). handedness: MediaPipe labels as if the image were mirrored,
// so a hand that LOOKS left on the mirrored display is labelled 'Left'.
const WEBCAM_VFOV = 45;
function mpHand(view, { D = 0.6, u = 0.5, v = 0.6, videoAspect = 4 / 3, label = 'Left', world = true } = {}) {
  const fh = 1 / (2 * Math.tan((WEBCAM_VFOV * Math.PI) / 360));
  const mp = view.map((p) => ({ x: -p.x, y: -p.y, z: -p.z })); // display is mirrored
  const w = mp[0];
  const cx = ((1 - u) - 0.5) * (w.z + D) * videoAspect / fh - w.x; // displayed u is mirrored
  const cy = (v - 0.5) * (w.z + D) / fh - w.y;
  const zw = w.z + D;
  const landmarks = mp.map((p) => {
    const X = p.x + cx, Y = p.y + cy, Z = p.z + D;
    return { x: 0.5 + (fh * X) / (Z * videoAspect), y: 0.5 + (fh * Y) / Z, z: ((Z - zw) * fh) / (zw * videoAspect) };
  });
  return {
    landmarks,
    worldLandmarks: world ? mp.map((p) => ({ ...p })) : null,
    handedness: label, gesture: 'None', score: 0.9, pinch: { pinching: false }, engaged: true
  };
}

// ---- measuring rig ----------------------------------------------------------------------------
const scene = new THREE.Scene();
const anchor = new THREE.Object3D();
scene.add(anchor);
function cameraFor(aspect) {
  const cam = new THREE.PerspectiveCamera(50, aspect, 0.01, 100);
  cam.position.set(0, 0.3, 3);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}
let clock = 1e6;
// Draw one hand fresh (> 500 ms since the last update, so the filter passes it through) and
// read the drawn joints back in view-height units (y up), plus the view-space directions.
function drawn(model, hand, cam, videoAspect) {
  clock += 1000;
  model.update([hand], { camera: cam, object: anchor, aspect: videoAspect, nowMs: clock });
  const px = [];
  const world = [];
  for (let i = 0; i < 21; i++) {
    const p = model.landmarkOf(hand, i);
    if (!p) return null;
    world.push(p.clone());
    const n = p.clone().project(cam);
    px.push(new THREE.Vector2(n.x * cam.aspect, n.y).multiplyScalar(0.5)); // view-height units
  }
  return { px, world };
}
const lenOf = (d) => d.px[0].distanceTo(d.px[12]);
const shapeOf = (d) => d.px[5].distanceTo(d.px[17]) / lenOf(d);
const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / (xs.reduce((a, b) => a + b, 0) / xs.length);

const hm = createHandModel(scene, []);
const mode = await hm.ready;

// ---- A. asset ---------------------------------------------------------------------------------
check('A1 hand asset loads: mode "model"', mode === 'model', `mode ${mode}`);
const camA = cameraFor(16 / 9);
const open = posed('left');
const hA = mpHand(open);
const dA = drawn(hm, hA, camA, 4 / 3);
check('A2 a drawn hand exposes all 21 MediaPipe joints (landmarkOf)', !!dA && hm.debug()[0].side === 'left', JSON.stringify(hm.debug()[0]));
const boneCount = (() => { let n = 0; scene.getObjectByName('handModel').children[0].children[0].traverse((o) => { if (o.isBone) n++; }); return n; })();
check('A3 rig has the 25 WebXR hand bones', boneCount === 25, `${boneCount} bones`);
// Render once with a real renderer: the patched skinned hologram shader must compile.
const glCanvas = document.createElement('canvas');
const glr = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
glr.setSize(320, 180, false);
glr.debug.checkShaderErrors = true;
const errsBefore = consoleErrors.length;
glr.render(scene, camA);
const progs = glr.info.programs?.length ?? 0;
check('A4 hologram hand shader compiles (skinned, patched rim normal)', consoleErrors.length === errsBefore && progs > 0, `${progs} programs, ${consoleErrors.length - errsBefore} errors`);
hm.clear();

// ---- B. constant size -------------------------------------------------------------------------
{
  const cam = cameraFor(16 / 9);
  const ghost = createGhostHands(scene, []);
  const rows = {};
  for (const world of [true, false]) {
    const sizes = [];
    for (const D of [0.4, 0.8]) {
      const h = mpHand(open, { D, world });
      sizes.push(lenOf(drawn(hm, h, cam, 4 / 3)));
      hm.clear();
    }
    rows[world ? 'world' : 'image'] = sizes;
  }
  const ghostSizes = [0.4, 0.8].map((D) => {
    const h = mpHand(open, { D, world: false });
    clock += 1000;
    ghost.update([h], { camera: cam, object: anchor, aspect: 4 / 3, nowMs: clock });
    const p0 = ghost.landmarkOf(h, 0).project(cam), p12 = ghost.landmarkOf(h, 12).project(cam);
    return Math.hypot((p0.x - p12.x) * cam.aspect, p0.y - p12.y) * 0.5;
  });
  ghost.update([], { camera: cam, object: anchor, aspect: 1 });
  ghost.dispose();
  const vW = Math.abs(rows.world[0] / rows.world[1] - 1);
  const vI = Math.abs(rows.image[0] / rows.image[1] - 1);
  const vG = Math.abs(ghostSizes[0] / ghostSizes[1] - 1);
  metrics.sizeVarWorld = vW; metrics.sizeVarImage = vI; metrics.sizeVarGhostBefore = vG;
  check('B1 same hand at 0.4 m and 0.8 m: drawn size within 10% (worldLandmarks)', vW < 0.10,
    `hand length ${f3(rows.world[0])} vs ${f3(rows.world[1])} view heights, ${(vW * 100).toFixed(2)}% (before, ghostHands: ${(vG * 100).toFixed(0)}%)`);
  check('B2 ... and within 10% from image landmarks only (no worldLandmarks)', vI < 0.10,
    `${f3(rows.image[0])} vs ${f3(rows.image[1])}, ${(vI * 100).toFixed(2)}%`);
  check('B3 open hand spans HAND_FRAC of the view height (head-on)', Math.abs(rows.world[0] - HAND_FRAC) < 0.01,
    `${f3(rows.world[0])} vs HAND_FRAC ${HAND_FRAC}`);
}

// ---- C. no distortion across viewport and video aspects ----------------------------------------
{
  const combos = [];
  for (const viewAspect of [4 / 3, 21 / 9]) for (const videoAspect of [4 / 3, 16 / 9]) combos.push({ viewAspect, videoAspect });
  const shapes = [], sizes = [], imgShapes = [];
  for (const { viewAspect, videoAspect } of combos) {
    const cam = cameraFor(viewAspect);
    const d = drawn(hm, mpHand(open, { videoAspect }), cam, videoAspect);
    shapes.push(shapeOf(d)); sizes.push(lenOf(d));
    hm.clear();
    const di = drawn(hm, mpHand(open, { videoAspect, world: false }), cam, videoAspect);
    imgShapes.push(shapeOf(di));
    hm.clear();
  }
  // Before: ghostHands at the same four combos (image landmarks, stretched to camera.aspect).
  const ghost = createGhostHands(scene, []);
  const ghostShapes = combos.map(({ viewAspect, videoAspect }) => {
    const cam = cameraFor(viewAspect);
    const h = mpHand(open, { videoAspect, world: false });
    clock += 1000;
    ghost.update([h], { camera: cam, object: anchor, aspect: videoAspect, nowMs: clock });
    const p = [0, 5, 12, 17].map((i) => ghost.landmarkOf(h, i).project(cam)).map((n) => new THREE.Vector2(n.x * cam.aspect, n.y));
    return p[1].distanceTo(p[3]) / p[0].distanceTo(p[2]);
  });
  ghost.update([], { camera: cameraFor(1), object: anchor, aspect: 1 });
  ghost.dispose();
  metrics.shapeSpread = spread(shapes); metrics.sizeSpreadAspect = spread(sizes); metrics.shapeSpreadGhostBefore = spread(ghostShapes);
  check('C1 hand shape identical at 4:3 / 21:9 views x 4:3 / 16:9 videos (world)', spread(shapes) < 0.01,
    `knuckles/length ${shapes.map(f3).join(' ')} (spread ${(spread(shapes) * 100).toFixed(2)}%; before, ghostHands: ${(spread(ghostShapes) * 100).toFixed(0)}%)`);
  check('C2 hand size (fraction of view height) identical across the same 4 combos', spread(sizes) < 0.01,
    `${sizes.map(f3).join(' ')} (spread ${(spread(sizes) * 100).toFixed(2)}%)`);
  check('C3 image-only fallback: shape within 3% across the 4 combos (video aspect undone)', spread(imgShapes) < 0.03,
    `${imgShapes.map(f3).join(' ')} (spread ${(spread(imgShapes) * 100).toFixed(2)}%)`);
}

// ---- D. pose follows the tracked bones --------------------------------------------------------
{
  const cam = cameraFor(16 / 9);
  const camQ = cam.getWorldQuaternion(new THREE.Quaternion());
  const bones = [[1, 2], [2, 3], [3, 4], ...FINGER_CHAINS.flatMap((c) => [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]]])];
  const poses = {
    open: {}, curled: { curl: 0.6, curlThumb: 0.4 }, fist: { curl: 1.45, curlThumb: 0.9 },
    'turned + curled': { curl: 0.8, yaw: 0.9, pitch: -0.4, roll: 0.5 }, 'back to camera': { curl: 0.3, yaw: Math.PI }
  };
  let worstAll = 0;
  const per = [];
  for (const [name, opt] of Object.entries(poses)) {
    const view = posed('left', opt);
    const d = drawn(hm, mpHand(view), cam, 4 / 3);
    let worst = 0;
    for (const [a, b] of bones) {
      const want = view[b].clone().sub(view[a]).normalize().applyQuaternion(camQ);
      const got = d.world[b].clone().sub(d.world[a]).normalize();
      worst = Math.max(worst, THREE.MathUtils.radToDeg(want.angleTo(got)));
    }
    per.push(`${name} ${worst.toFixed(2)}°`);
    worstAll = Math.max(worstAll, worst);
    hm.clear();
  }
  metrics.poseWorstDeg = worstAll;
  check('D1 all 15 finger bones point along the tracked bones (5 poses incl. fist, turned, back)', worstAll < 1, per.join(', '));

  // Palm orientation too: the drawn palm frame equals the tracked one.
  const view = posed('left', { yaw: 0.7, pitch: 0.3, roll: -0.4, curl: 0.3 });
  const d = drawn(hm, mpHand(view), cam, 4 / 3);
  const fw = frameOf(d.world), fv = frameOf(view.map((p) => p.clone().applyQuaternion(camQ)));
  const palmErr = THREE.MathUtils.radToDeg(fw.q.angleTo(fv.q));
  check('D2 palm orientation matches the tracked palm', palmErr < 1, `${palmErr.toFixed(2)}° off`);
  const hv = mpHand(view);
  drawn(hm, hv, cam, 4 / 3);
  const holder = scene.getObjectByName('handModel').children.find((c) => c.visible);
  const rig = holder?.children.find((c) => c.visible);
  const bone = rig?.getObjectByName('index-finger-tip')?.getWorldPosition(new THREE.Vector3());
  const tip = hm.landmarkOf(hv, 8);
  const undrawn = hm.landmarkOf(mpHand(view), 8);
  check('D3 landmarkOf(hand, 8) = the shown rig\'s index-finger-tip bone; a hand not drawn -> null', !!bone && !!tip && tip.distanceTo(bone) < 1e-9 && undrawn === null,
    `beam start = handModel.landmarkOf(aimHand, 8); ${bone && tip ? tip.distanceTo(bone).toExponential(1) : 'missing'}`);
  hm.clear();

  // Position: the wrist lands under the image wrist (object-fit: cover at the video aspect).
  const errs = [];
  for (const [u, v] of [[0.5, 0.5], [0.2, 0.3], [0.85, 0.75]]) {
    for (const [va, vid] of [[16 / 9, 4 / 3], [21 / 9, 16 / 9], [4 / 3, 16 / 9]]) {
      const c = cameraFor(va);
      const h = mpHand(open, { u, v, videoAspect: vid });
      const dd = drawn(hm, h, c, vid);
      const n = dd.world[0].clone().project(c);
      // Where CSS object-fit: cover would show that image point, in NDC.
      const s = Math.max(va / vid, 1);           // image height / view height
      const ix = (h.landmarks[0].x * -1 + 1 - 0.5) * s * vid / va * 2;
      const iy = -(h.landmarks[0].y - 0.5) * s * 2;
      errs.push(Math.hypot(n.x - ix, n.y - iy));
      hm.clear();
    }
  }
  check('D4 drawn wrist sits on the image wrist as the cover-fitted video shows it (9 cases)', Math.max(...errs) < 0.01,
    `worst ${Math.max(...errs).toExponential(1)} NDC`);
}

// ---- E. handedness ----------------------------------------------------------------------------
{
  const cam = cameraFor(16 / 9);
  const side = (view, label) => { drawn(hm, mpHand(view, { label }), cam, 4 / 3); const s = hm.debug()[0].side; hm.clear(); return s; };
  const flat = posed('left', { curl: 0 });
  const flatR = posed('right', { curl: 0 });
  check('E1 label picks the rig (open hands): Left -> left, Right -> right', side(flat, 'Left') === 'left' && side(flatR, 'Right') === 'right',
    `${side(flat, 'Left')} / ${side(flatR, 'Right')}`);
  const curledL = posed('left', { curl: 1.2 });
  const curledR = posed('right', { curl: 1.2 });
  check('E2 a clearly curled hand with the WRONG label still gets its own rig', side(curledL, 'Right') === 'left' && side(curledR, 'Left') === 'right',
    `${side(curledL, 'Right')} / ${side(curledR, 'Left')}`);
  // Sticky: one frame of the wrong shape doesn't swap the rig.
  let t = clock += 1000;
  const run = (view, label, n) => { for (let i = 0; i < n; i++) hm.update([mpHand(view, { label })], { camera: cam, object: anchor, aspect: 4 / 3, nowMs: (t += 33) }); return hm.debug()[0].side; };
  run(curledL, 'Left', 5);
  const afterOne = run(curledR, 'Left', 1);
  const afterFour = run(curledR, 'Left', 4);
  check('E3 rig swap needs 3 frames in a row (no flicker)', afterOne === 'left' && afterFour === 'right', `${afterOne} then ${afterFour}`);
  hm.clear();
}

// ---- F. photosafety: eased fades --------------------------------------------------------------
{
  const cam = cameraFor(16 / 9);
  const h = mpHand(open);
  let t = clock += 1000;
  const op = [];
  for (let i = 0; i < 60; i++) { hm.update([h], { camera: cam, object: anchor, aspect: 4 / 3, nowMs: (t += 16.7) }); op.push(hm.debug()[0].opacity); }
  const peak = op[op.length - 1];
  const rest = { ...h, engaged: false };
  const dimOp = [];
  for (let i = 0; i < 60; i++) { hm.update([rest], { camera: cam, object: anchor, aspect: 4 / 3, nowMs: (t += 16.7) }); dimOp.push(hm.debug()[0].opacity); }
  const goneOp = [];
  let goneTip = 'x';
  for (let i = 0; i < 60; i++) {
    hm.update([], { camera: cam, object: anchor, aspect: 4 / 3, nowMs: (t += 16.7) });
    if (i === 0) goneTip = hm.landmarkOf(rest, 8);
    goneOp.push(hm.debug()[0].visible ? hm.debug()[0].opacity : 0);
  }
  const all = [0, ...op, ...dimOp, ...goneOp];
  let maxStep = 0;
  for (let i = 1; i < all.length; i++) maxStep = Math.max(maxStep, Math.abs(all[i] - all[i - 1]));
  metrics.fadeMaxStep = maxStep / peak;
  check('F1 appear: eases in over ~0.2 s (first frame < 15% of full, full after 1 s)', op[0] < 0.15 * peak && op[59] > 0.95 * peak && peak > 0.3,
    `frame 1 ${f3(op[0])}, 1 s ${f3(peak)}`);
  check('F2 resting hand dims gradually to ~35%', Math.abs(dimOp[59] / peak - 0.35) < 0.05 && dimOp[0] > 0.8 * peak, `${f3(dimOp[0])} -> ${f3(dimOp[59])}`);
  check('F3 lost hand fades out (no beam start once gone) and is hidden after 1 s', goneOp[0] > 0 && goneOp[0] < dimOp[59] && goneOp[59] === 0 && goneTip === null,
    `${f3(goneOp[0])} -> ${f3(goneOp[59])}`);
  check('F4 no frame-to-frame opacity step above 10% of full (60 fps)', maxStep / peak < 0.10, `max step ${(100 * maxStep / peak).toFixed(1)}% of full`);
  hm.clear();
}

// ---- G. fallback --------------------------------------------------------------------------------
{
  const warns = [];
  const ow = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  const bad = createHandModel(scene, [], { assetBase: 'data:,' }); // no valid .glb URL: fails without a network error
  const m = await bad.ready;
  console.warn = ow;
  const cam = cameraFor(16 / 9);
  const h = mpHand(open);
  bad.update([h], { camera: cam, object: anchor, aspect: 4 / 3, nowMs: (clock += 1000) });
  const tip = bad.landmarkOf(h, 8);
  check('G1 asset fails -> ghostHands fallback draws the hand (warn, not error)', m === 'ghost' && !!tip && warns.length === 1,
    `mode ${m}, tip ${tip ? 'ok' : 'null'}, ${warns.length} warn`);
  bad.clear();
  bad.dispose();
}

// ---- H. runtime wiring ------------------------------------------------------------------------
{
  const { createHandsRuntime } = await import('./handsRuntime.js' + V);
  const cv = document.createElement('canvas');
  Object.assign(cv.style, { position: 'fixed', left: '-4000px', top: '0', width: '640px', height: '360px' });
  document.body.append(cv);
  const overlay = document.createElement('canvas');
  const video = Object.assign(document.createElement('video'), { playsInline: true, muted: true });
  const mount = document.createElement('div');
  mount.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:120px;visibility:hidden;pointer-events:none';
  mount.append(video, overlay);
  document.body.append(mount);
  const rscene = new THREE.Scene();
  const target = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
  rscene.add(target);
  const rt = createHandsRuntime({ scene: rscene, camera: cameraFor(16 / 9), renderer: { domElement: cv }, overlay, video, pickTargets: () => target });
  const rm = await rt.handModel.ready;
  check('H1 handsRuntime draws handModel (mode "model")', rm === 'model' && !!rt.handModel.landmarkOf, `mode ${rm}`);

  if (params.get('camera') === '1') {
    const ctx = overlay.getContext('2d');
    let clears = 0;
    const orig = ctx.clearRect.bind(ctx);
    ctx.clearRect = (...a) => { clears++; orig(...a); };
    let err = null;
    try { await rt.start(); } catch (e) { err = e; }
    if (err) {
      check('H2 camera started (fake camera in headless runs)', false, String(err?.message ?? err));
    } else {
      const frames = async (ms) => {
        const until = performance.now() + ms;
        let n = 0;
        while (performance.now() < until) { await new Promise((r) => requestAnimationFrame(r)); rt.update(performance.now()); n++; }
        return n;
      };
      await frames(600); // camera warm-up
      clears = 0;
      const nHidden = await frames(1200);
      const hiddenClears = clears;
      mount.style.visibility = 'visible';
      await frames(300);
      clears = 0;
      const nShown = await frames(1200);
      const shownClears = clears;
      metrics.overlayDrawsHidden = hiddenClears;
      check('H2 hidden debug overlay is not redrawn every frame; visible one is', hiddenClears <= 1 && shownClears >= Math.min(10, nShown / 2),
        `hidden: ${hiddenClears} draws in ${nHidden} frames; visible: ${shownClears} draws in ${nShown} frames`);
      rt.stop();
    }
  } else {
    log('(skip) H2 overlay draw gate: needs ?camera=1');
  }
  rt.dispose();
  cv.remove();
  mount.remove();
}

// ---- demo views (for eyes; slow eased curl) ---------------------------------------------------
const views = document.getElementById('views');
const demoH = Math.min(720, Math.max(120, +params.get('demoH') || 240)); // ?demoH= for a closer look
const demos = [[4 / 3, demoH], [21 / 9, demoH]].map(([aspect, h]) => {
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true });
  r.setPixelRatio(Math.min(2, devicePixelRatio));
  r.setSize(Math.round(h * aspect), h);
  r.setClearColor(0x05080c);
  views.append(canvas);
  const sc = new THREE.Scene();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.01, 8, 64), new THREE.MeshBasicMaterial({ color: 0x1d4050 }));
  sc.add(ring);
  const cam = cameraFor(aspect);
  return { r, sc, cam, model: createHandModel(sc, []), aspect };
});
await Promise.all(demos.map((d) => d.model.ready));
const t0 = performance.now();
function frame(now) {
  const k = 0.5 - 0.5 * Math.cos(((now - t0) / 4000) * Math.PI * 2); // 0..1, 4 s period
  const left = posed('left', { curl: 1.3 * k, curlThumb: 0.6 * k, yaw: 0.35, pitch: -0.15 });
  const right = posed('right', { curl: 0.2, yaw: -0.5 });
  for (const d of demos) {
    const hands = [mpHand(left, { u: 0.33, v: 0.62 }), mpHand(right, { u: 0.7, v: 0.66, label: 'Right' })];
    d.model.update(hands, { camera: d.cam, object: anchor, aspect: 4 / 3, nowMs: now });
    d.r.render(d.sc, d.cam);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
await wait(300);

// ---- Z. console -------------------------------------------------------------------------------
check('Z1 0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

const passed = results.filter((r) => r.ok).length;
log(`\n${passed} passed, ${results.length - passed} failed`);
window.handModelResults = { results, metrics, passed, failed: results.length - passed };
document.title = `Hand model test: ${passed}/${results.length}`;

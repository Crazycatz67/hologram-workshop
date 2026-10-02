import * as THREE from 'three';

// The tracked hands drawn as a rigged 3D hand in the hologram style (Phase 2 track A,
// plans: lovely-mapping-zebra). Replaces ghostHands.js's bead-and-stick skeleton, which the
// owner found cluttered and which changed size with distance: it was drawn from IMAGE
// landmarks spread across the view frustum, so a hand twice as far from the webcam was drawn
// half as big, and the viewport aspect stretched it sideways.
//
// HOW IT IS POSED
//   Shape comes from MediaPipe's metric worldLandmarks (hand-centred, in metres, the same
//   numbers at 0.4 m and 0.8 m from the camera), smoothed by this module's own One Euro pass.
//   Only bone DIRECTIONS are taken from them: bone lengths are the model's own, so the hand
//   is always the same size and tracking noise in bone length never shows. (HANDS-UX-SPEC 5
//   suggests real-proportion positions; the model's lengths are kept so the skinned mesh is
//   never stretched and the size invariant is exact.) The palm is rigid (one rotation from
//   wrist / index / middle / pinky knuckles); each finger bone is carried by its parent and
//   swung onto the tracked direction (parallel transport, no flips in a fist).
//   Position: the wrist sits under the IMAGE wrist landmark, on a plane facing the camera at
//   the anchor's distance (as ghostHands did), with the camera image fitted to the view the
//   way the debug video shows it (object-fit: cover at the VIDEO's aspect, HANDS-UX-SPEC 5).
//   ghostHands stretched the image to the viewport's aspect instead.
//   Size: wrist to middle fingertip of an open hand spans HAND_FRAC of the view's height,
//   whatever the hand's distance, the viewport or the video aspect.
//   Drawn on top (no depth test, no depth write, renderOrder just under the reticle): a cursor
//   hand that sinks into the model would hide what it points at.
//   No worldLandmarks (synthetic hands in labs/tests): directions come from the image
//   landmarks with x and z un-stretched by the video aspect, so the shape still isn't distorted.
//
// CONTRACT (same calls as ghostHands.js, so handsRuntime.js swaps one import)
//   createHandModel(scene, connections, { assetBase? }) -> handModel
//     connections: HAND_CONNECTIONS, only used by the ghostHands fallback.
//     assetBase: URL of the folder holding left.glb / right.glb (default ./assets/hand/ next
//       to this file). Loading starts immediately; nothing is drawn until it finishes.
//   handModel.update(hands, { camera, object, aspect, mirror = true, isFist, nowMs })
//     hands: this frame's annotated hands (0-2): landmarks (image, smoothed), worldLandmarks
//       (metres, or null), handedness, pinch, engaged. object: what sets the depth plane.
//       aspect: the VIDEO's aspect (width / height), not camera.aspect. Call every display
//       frame; the landmark filter only advances when a hand's landmark array changes.
//   handModel.landmarkOf(hand, index = 8) -> THREE.Vector3 | null   world position of a
//     drawn hand's joint (MediaPipe numbering; 8 = index tip, where the pointer beam starts),
//     from the last update(). null while that hand isn't drawn.
//   handModel.setTint(fn | null)   Hands v2 owner colour (CONTRACT section 2.4): fn(hand) -> a
//     THREE.Color, a colour number / string, or null for the default look. While set, it is the
//     hand's base colour instead of the cyan + fist amber (a pinch still tints it halfway green);
//     it eases like the fist tint (TINT_MS), never a step. null (default) = v1 look, unchanged.
//     Not drawn in the ghostHands fallback (mode 'ghost'): ignored there.
//   handModel.clear()     hide everything now and forget the filters (camera stopped).
//   handModel.dispose()   remove from the scene.
//   handModel.mode        'loading' | 'model' | 'ghost'; handModel.ready -> Promise<mode>.
//   Failure: if three's GLTFLoader or either .glb fails to load, a console.warn is logged and
//     every call is passed to ghostHands.js instead (mode 'ghost'). Never throws.
//   Photosafety (BUGS #14): appearing, disappearing, resting (dim) and the fist / pinch tint
//     all ease (no step change); the material is HolographicMaterial's photosafe shader with
//     its breathing turned off.

const V = new URL(import.meta.url).search;
const DEFAULT_ASSET_BASE = new URL('./assets/hand/', import.meta.url).href;

// Open-hand length (wrist -> middle tip) as a fraction of the view's height.
// A real hand at arm's length fills roughly a quarter of a webcam frame; a little less keeps
// the scene uncluttered.
export const HAND_FRAC = 0.22;

const COLOR = new THREE.Color(0x4fd1ff);
const PINCH_COLOR = new THREE.Color(0x7fe3a1);
const FIST_COLOR = new THREE.Color(0xffd166);
const PINCH_TINT = 0.5;          // a pinch tints the hand halfway: feedback, not a second colour
const OPACITY = 0.6;
const REST_OPACITY = 0.35;       // x OPACITY while the hand is lowered (pointer.js createEngagement)
const FADE_MS = 160;             // appear / disappear / rest dim
const TINT_MS = 120;             // fist / pinch colour
// Handedness: a geometric read wins over MediaPipe's label only when the fingers clearly curl
// one way (|score| in hand lengths), and a switch needs this many camera frames in a row.
const CURL_STRONG = 0.35;
const SIDE_SWITCH_FRAMES = 3;

// One Euro on the metric landmarks (same filter as smoothLandmarks.js; units here are metres,
// a hand is ~0.18 m, close to its size in image units, so similar constants apply).
const MIN_CUTOFF = 1.2;          // Hz, a still hand
const BETA = 15;                 // Hz per m/s
const D_CUTOFF = 1.0;
const MAX_GAP_MS = 500;          // older history is stale: restart the filter

// MediaPipe landmark index -> WebXR hand joint (the bone names in the .glb).
const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
export const MP_TO_JOINT = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  ...FINGERS.flatMap((f) => [`${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`])
];
// Bones whose rotation follows a tracked direction: [joint, from MP, to MP, child joint].
const CHAIN = [
  [1, 2], [2, 3], [3, 4],
  ...[5, 9, 13, 17].flatMap((b) => [[b, b + 1], [b + 1, b + 2], [b + 2, b + 3]])
].map(([a, b]) => ({ joint: MP_TO_JOINT[a], child: MP_TO_JOINT[b], from: a, to: b, first: [1, 5, 9, 13, 17].includes(a) }));
// Bones carried rigidly by the palm (no MediaPipe landmark of their own, or the palm itself).
const RIGID = ['wrist', ...FINGERS.map((f) => `${f}-metacarpal`)];
// Joints whose POSITION is rigid with the palm; every other position is chained from these.
const RIGID_POS = ['wrist', 'thumb-metacarpal', ...FINGERS.flatMap((f) => [`${f}-metacarpal`, `${f}-phalanx-proximal`])];

// ---- asset loading (once per page, shared by every handModel) ----------------------------

const assetCache = new Map(); // base -> Promise<{ left, right, clone }>
function loadAssets(base) {
  if (!assetCache.has(base)) {
    assetCache.set(base, (async () => {
      const [{ GLTFLoader }, SkeletonUtils] = await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/utils/SkeletonUtils.js')
      ]);
      const loader = new GLTFLoader();
      const [left, right] = await Promise.all(['left', 'right'].map((s) => loader.loadAsync(new URL(`${s}.glb`, base).href)));
      return { left: left.scene, right: right.scene, clone: SkeletonUtils.clone };
    })());
  }
  return assetCache.get(base);
}

// ---- pure helpers -------------------------------------------------------------------------

// MediaPipe (x right, y down, z away from the camera, unmirrored image) -> view space (x right,
// y up, z toward the viewer), mirrored like the display. pts: [{x,y,z}] already in one metric.
function toView(p, mirror) {
  return new THREE.Vector3(mirror ? -p.x : p.x, -p.y, -(p.z ?? 0));
}

// Image landmarks as a stand-in for world ones: x (width units) and z (same scale as x) are
// put into height units, so the hand's shape doesn't depend on the video's aspect.
function imageAsWorld(landmarks, aspect) {
  const w = landmarks[0];
  return landmarks.map((p) => ({ x: (p.x - w.x) * aspect, y: p.y - w.y, z: (p.z ?? 0) * aspect }));
}

// Palm frame from wrist, index / middle / pinky knuckles: columns (side, up, normal).
const _s = new THREE.Vector3(), _a = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Matrix4();
function palmQuat(wrist, index, middle, pinky, out = new THREE.Quaternion()) {
  _a.subVectors(middle, wrist).normalize();
  _s.subVectors(index, pinky);
  _s.addScaledVector(_a, -_s.dot(_a)).normalize();
  _n.crossVectors(_s, _a);
  return out.setFromRotationMatrix(_m.makeBasis(_s, _a, _n));
}

// How far the fingertips sit off the palm plane, along the frame's normal, in hand lengths.
// Fingers curl toward the palm, and the frame's normal points palm-ward on one hand and
// back-ward on the other, so the sign says which hand this is (when the hand isn't flat).
function curlScore(P) {
  _a.subVectors(P[9], P[0]);
  const len = _a.length() || 1;
  _a.divideScalar(len);
  _s.subVectors(P[5], P[17]);
  _s.addScaledVector(_a, -_s.dot(_a)).normalize();
  _n.crossVectors(_s, _a);
  let sum = 0;
  for (const [tip, base] of [[8, 5], [12, 9], [16, 13], [20, 17]]) sum += _n.dot(new THREE.Vector3().subVectors(P[tip], P[base]));
  return sum / len;
}

function createOneEuro() {
  let prev = null, deriv = null, lastT = null;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  return {
    filter(pts, t) {
      if (!prev || !(t > lastT) || t - lastT > MAX_GAP_MS) {
        prev = pts.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
        deriv = pts.map(() => ({ x: 0, y: 0, z: 0 }));
        lastT = t;
        return prev;
      }
      const dt = (t - lastT) / 1000;
      lastT = t;
      const aD = alpha(D_CUTOFF, dt);
      prev = pts.map((p, i) => {
        const q = prev[i], d = deriv[i], z = p.z ?? 0;
        d.x += ((p.x - q.x) / dt - d.x) * aD;
        d.y += ((p.y - q.y) / dt - d.y) * aD;
        d.z += ((z - q.z) / dt - d.z) * aD;
        const a = alpha(MIN_CUTOFF + BETA * Math.hypot(d.x, d.y, d.z), dt);
        return { x: q.x + (p.x - q.x) * a, y: q.y + (p.y - q.y) * a, z: q.z + (z - q.z) * a };
      });
      return prev;
    },
    reset() { prev = null; }
  };
}

// HolographicMaterial's vendored vertex shader builds its rim normal from the UNSKINNED normal
// and multiplies by modelMatrix transposed (vec4 * mat4): fine for its static, unrotated scans,
// wrong for a posed, rotated, scaled hand (the rim would stay glued to the bind pose). This
// patch is local to the hand's material instances; the shared file is untouched.
function patchSkinnedRim(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('vPositionW = vec3( vec4( transformed, 1.0 ) * modelMatrix);',
        'vPositionW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')
      .replace('vNormalW = normalize( vec3( vec4( normal, 0.0 ) * modelMatrix ) );',
        '#ifdef USE_SKINNING\n vNormalW = normalize( mat3( modelMatrix ) * objectNormal );\n#else\n vNormalW = normalize( mat3( modelMatrix ) * normal );\n#endif');
  };
  material.customProgramCacheKey = () => 'handModel-skinned-rim';
}

// ---- one drawn hand (a left and a right rig; one is shown) ---------------------------------

function buildRig(source, clone, material) {
  const root = clone(source);
  const bones = {};
  const rest = {};
  let mesh = null;
  root.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isSkinnedMesh) mesh = o;
  });
  for (const name of new Set(MP_TO_JOINT.concat(RIGID))) {
    const b = bones[name];
    if (!b) throw new Error(`hand model is missing bone "${name}"`);
    rest[name] = { pos: b.position.clone(), quat: b.quaternion.clone() };
  }
  // The trigger helper nodes from the WebXR profile are not part of the hand.
  root.traverse((o) => { if (o.name.startsWith('xr_standard')) o.visible = false; });
  mesh.material = material;
  mesh.frustumCulled = false;     // bones move far from the bind-pose bounding sphere
  mesh.renderOrder = 998;         // just under the reticle (999)

  const P = (i) => rest[MP_TO_JOINT[i]].pos;
  const restPalm = palmQuat(P(0), P(5), P(9), P(17));
  const restLen = P(0).distanceTo(P(12));
  const restDir = {};
  for (const c of CHAIN) restDir[c.joint] = new THREE.Vector3().subVectors(rest[c.child].pos, rest[c.joint].pos).normalize();
  const restCurl = curlScore(MP_TO_JOINT.map((n) => rest[n].pos));
  return { root, bones, rest, restPalm, restLen, restDir, restCurl };
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _d = new THREE.Vector3(), _v = new THREE.Vector3();

// Pose a rig (bone transforms in armature space, wrist at the origin) from view-space points.
// Each finger bone is carried by its parent (the palm for the first one), then swung onto the
// tracked direction: parallel transport, so a curled finger never flips its twist. Swinging
// every bone from the PALM instead fails in a fist, where a fingertip turns ~200 degrees and
// the shortest swing to an almost-opposite direction has no stable axis.
function poseRig(rig, P) {
  const qPalm = palmQuat(P[0], P[5], P[9], P[17], new THREE.Quaternion()).multiply(_q.copy(rig.restPalm).invert());
  const w = rig.rest.wrist.pos;
  for (const name of RIGID_POS) rig.bones[name].position.subVectors(rig.rest[name].pos, w).applyQuaternion(qPalm);
  for (const name of RIGID) rig.bones[name].quaternion.multiplyQuaternions(qPalm, rig.rest[name].quat);
  const carry = new THREE.Quaternion();
  for (const c of CHAIN) {
    if (c.first) carry.copy(qPalm);
    const bone = rig.bones[c.joint];
    const from = _v.copy(rig.restDir[c.joint]).applyQuaternion(carry);
    _d.subVectors(P[c.to], P[c.from]);
    if (_d.lengthSq() < 1e-12) _d.copy(from); else _d.normalize();
    carry.premultiply(_q2.setFromUnitVectors(from, _d));
    bone.quaternion.multiplyQuaternions(carry, rig.rest[c.joint].quat);
    const len = rig.rest[c.child].pos.distanceTo(rig.rest[c.joint].pos);
    rig.bones[c.child].position.copy(bone.position).addScaledVector(_d, len);
    // Tips have no bone after them: they take the distal bone's rotation.
    if (c.child.endsWith('-tip')) rig.bones[c.child].quaternion.copy(bone.quaternion);
  }
}

export function createHandModel(scene, connections, { assetBase = DEFAULT_ASSET_BASE } = {}) {
  let mode = 'loading';
  let ghost = null;
  let disposed = false;
  let lastT = null;
  const pools = [];
  const group = new THREE.Group();
  group.name = 'handModel';
  scene.add(group);

  function makePool(assets) {
    const material = new (assets.Holo)({
      hologramColor: COLOR, hologramOpacity: 0, fresnelAmount: 0.85, fresnelOpacity: 1,
      hologramBrightness: 0.3, scanlinePeriod: 5, signalSpeed: 0.6, blinkAmount: 0,
      blendMode: THREE.AdditiveBlending, side: THREE.FrontSide, depthTest: false
    });
    material.depthWrite = false;
    patchSkinnedRim(material);
    const holder = new THREE.Group();
    holder.visible = false;
    group.add(holder);
    const rigs = {
      left: buildRig(assets.left, assets.clone, material),
      right: buildRig(assets.right, assets.clone, material)
    };
    for (const r of Object.values(rigs)) { r.root.visible = false; holder.add(r.root); }
    return {
      holder, material, rigs, side: null, pendingSide: null, pendingCount: 0,
      filter: createOneEuro(), src: null, hand: null, wrist: null,
      vis: 0, dim: 1, color: COLOR.clone(), points: null
    };
  }

  const ready = (async () => {
    try {
      const [assets, { default: Holo }] = await Promise.all([
        loadAssets(assetBase),
        import('./HolographicMaterial.js' + V)
      ]);
      if (disposed) return mode;
      const a = { ...assets, Holo };
      pools.push(makePool(a), makePool(a));
      mode = 'model';
    } catch (err) {
      console.warn('handModel: hand asset failed to load, using ghostHands instead.', err?.message ?? err);
      if (disposed) return mode;
      const { createGhostHands } = await import('./ghostHands.js' + V);
      ghost = createGhostHands(scene, connections);
      mode = 'ghost';
    }
    return mode;
  })();

  // Hands v2 owner colour (setTint): null = the v1 look.
  let tintFn = null;
  const ownerColor = new THREE.Color();
  function tintOf(hand) {
    if (!tintFn) return null;
    let c = null;
    try { c = tintFn(hand); } catch { return null; }
    if (c == null) return null;
    return c.isColor ? c : ownerColor.set(c);
  }

  // Which pool a hand goes to: the one whose last wrist is nearest (MediaPipe reorders hands
  // and can label both the same, see smoothLandmarks.js), else a free one.
  function assign(hands) {
    const out = new Map();
    const free = new Set(pools.keys());
    const pairs = [];
    hands.forEach((h, hi) => pools.forEach((p, pi) => {
      if (p.wrist) pairs.push({ hi, pi, d: Math.hypot(h.landmarks[0].x - p.wrist.x, h.landmarks[0].y - p.wrist.y) });
    }));
    pairs.sort((a, b) => a.d - b.d);
    for (const { hi, pi, d } of pairs) {
      if (d > 0.35 || out.has(hi) || !free.has(pi)) continue;
      out.set(hi, pi);
      free.delete(pi);
    }
    hands.forEach((h, hi) => {
      if (out.has(hi)) return;
      // Prefer a pool that has faded out, so a new hand doesn't steal one still fading.
      const pi = [...free].sort((a, b) => pools[a].vis - pools[b].vis)[0];
      if (pi === undefined) return;
      out.set(hi, pi);
      free.delete(pi);
      pools[pi].filter.reset();
      pools[pi].side = null;
    });
    return out;
  }

  function chooseSide(pool, hand, P, mirror) {
    // MediaPipe labels as if the image were mirrored (its docs), and our input is not; shown
    // mirrored, a hand labelled 'Left' therefore has a left hand's shape on screen.
    const label = hand.handedness === 'Left' || hand.handedness === 'Right'
      ? ((hand.handedness === 'Left') === mirror ? 'left' : 'right') : null;
    const score = curlScore(P);
    let want = label ?? pool.side ?? 'right';
    if (Math.abs(score) > CURL_STRONG) {
      want = Math.sign(score) === Math.sign(pool.rigs.left.restCurl) ? 'left' : 'right';
    }
    if (pool.side === null) { pool.side = want; pool.pendingCount = 0; return; }
    if (want === pool.side) { pool.pendingCount = 0; return; }
    pool.pendingCount = pool.pendingSide === want ? pool.pendingCount + 1 : 1;
    pool.pendingSide = want;
    if (pool.pendingCount >= SIDE_SWITCH_FRAMES) { pool.side = want; pool.pendingCount = 0; }
  }

  function place(pool, hand, { camera, depth, aspect, mirror }) {
    const viewH = 2 * depth * Math.tan((camera.fov * Math.PI) / 360);
    const viewW = viewH * camera.aspect;
    // The camera image as the debug view shows it (object-fit: cover, HANDS-UX-SPEC 5): scaled
    // at its OWN aspect until it fills the view, the overflow cropped. So the drawn wrist sits
    // over your real wrist in the video, and moving 10 cm right or up moves it equally.
    const imgH = Math.max(viewH, viewW / aspect);
    const w = hand.landmarks[0];
    const x = ((mirror ? 1 - w.x : w.x) - 0.5) * imgH * aspect;
    const y = (0.5 - w.y) * imgH;
    camera.updateMatrixWorld();
    const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld)
      .addScaledVector(camera.getWorldDirection(_d), depth)
      .addScaledVector(_v.setFromMatrixColumn(camera.matrixWorld, 0).normalize(), x);
    pos.addScaledVector(_v.setFromMatrixColumn(camera.matrixWorld, 1).normalize(), y);
    pool.holder.position.copy(pos);
    camera.getWorldQuaternion(pool.holder.quaternion);
    // Size is a fraction of the VIEW's height, so it is the same on every screen and video.
    pool.holder.scale.setScalar((HAND_FRAC * viewH) / pool.rigs[pool.side].restLen);
  }

  function hidePool(pool) {
    pool.holder.visible = false;
    pool.hand = null;
    pool.vis = 0;
    pool.wrist = null;
    pool.src = null;
    pool.filter.reset();
  }

  return {
    get mode() { return mode; },
    ready,

    update(hands, { camera, object, aspect, mirror = true, isFist = () => false, nowMs = performance.now() } = {}) {
      if (mode === 'ghost') return ghost.update(hands, { camera, object, aspect, mirror, isFist, nowMs });
      if (mode !== 'model') return;
      const dtMs = lastT === null ? 16 : Math.max(0, nowMs - lastT);
      lastT = nowMs;
      const kFade = 1 - Math.exp(-dtMs / FADE_MS);
      const kTint = 1 - Math.exp(-dtMs / TINT_MS);
      const depth = camera.position.distanceTo(object.position);
      const vAspect = aspect > 0 ? aspect : camera.aspect;
      const map = assign(hands.filter((h) => h?.landmarks?.length >= 21));
      const valid = hands.filter((h) => h?.landmarks?.length >= 21);
      const used = new Set();

      valid.forEach((hand, hi) => {
        const pi = map.get(hi);
        if (pi === undefined) return;
        used.add(pi);
        const pool = pools[pi];
        pool.hand = hand;
        pool.wrist = { x: hand.landmarks[0].x, y: hand.landmarks[0].y };
        const world = hand.worldLandmarks?.length >= 21 ? hand.worldLandmarks : null;
        const src = world ?? hand.landmarks;
        if (src !== pool.src || !pool.points) {
          pool.src = src;
          const pts = pool.filter.filter(world ?? imageAsWorld(hand.landmarks, vAspect), nowMs);
          pool.points = pts.map((p) => toView(p, mirror));
          chooseSide(pool, hand, pool.points, mirror);
        }
        const rig = pool.rigs[pool.side];
        for (const s of ['left', 'right']) pool.rigs[s].root.visible = s === pool.side;
        poseRig(rig, pool.points);
        place(pool, hand, { camera, depth, aspect: vAspect, mirror });

        pool.vis += (1 - pool.vis) * kFade;
        pool.dim += ((hand.engaged === false ? REST_OPACITY : 1) - pool.dim) * kFade;
        const owner = tintOf(hand);
        const target = owner ? (hand.pinch?.pinching ? _tint.copy(owner).lerp(PINCH_COLOR, PINCH_TINT) : owner)
          : isFist(hand) ? FIST_COLOR
          : hand.pinch?.pinching ? _tint.copy(COLOR).lerp(PINCH_COLOR, PINCH_TINT) : COLOR;
        pool.color.lerp(target, kTint);
      });

      for (let i = 0; i < pools.length; i++) {
        const pool = pools[i];
        if (!used.has(i)) {
          // Gone: keep the last pose and fade out (a hand that blinks out of tracking for a
          // frame or two dips instead of blinking, BUGS #14).
          pool.hand = null;
          pool.vis += (0 - pool.vis) * kFade;
          if (pool.vis < 0.01) { hidePool(pool); continue; }
        }
        if (!pool.side) continue;
        pool.holder.visible = true;
        pool.material.uniforms.hologramOpacity.value = OPACITY * pool.vis * pool.dim;
        pool.material.uniforms.hologramColor.value.copy(pool.color);
        pool.material.update(nowMs / 1000);
      }
      group.updateMatrixWorld(true);
    },

    setTint(fn) { tintFn = typeof fn === 'function' ? fn : null; },

    landmarkOf(hand, index = 8) {
      if (mode === 'ghost') return ghost.landmarkOf(hand, index);
      const pool = pools.find((p) => p.hand === hand && p.side);
      if (!pool) return null;
      const bone = pool.rigs[pool.side].bones[MP_TO_JOINT[index]];
      return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
    },

    clear() {
      if (mode === 'ghost') return ghost.update([], { camera: new THREE.PerspectiveCamera(), object: scene, aspect: 1 });
      pools.forEach(hidePool);
      lastT = null;
    },

    // For tests and the session recorder: what each drawn hand is doing.
    debug() {
      return pools.map((p) => ({ side: p.side, visible: p.holder.visible, opacity: p.material.uniforms.hologramOpacity.value, drawing: !!p.hand, color: '#' + p.color.getHexString() }));
    },

    dispose() {
      disposed = true;
      ghost?.dispose();
      scene.remove(group);
      for (const p of pools) p.material.dispose();
    }
  };
}

const _tint = new THREE.Color();

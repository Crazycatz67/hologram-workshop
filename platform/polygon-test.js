// Polygon lens checks (platform/polygon.js), on the completed chair (real scanned + inferred faces).
//
//   A. Library: three-mesh-bvh 0.9.15 loads on three r161 and its BVH agrees with three's own
//      raycast, face for face (so face numbers in the edit log mean the real triangles).
//   B. Lens: the faces it reports are exactly the brute-force "triangles within the lens sphere";
//      wheel changes the lens size and does not zoom the camera; Shift-click adds.
//   C. Non-destructive edits: Delete hides the patch without touching mesh.geometry; I marks /
//      unmarks inferred; both undo, replay and survive a JSON round trip (adoptHistory); the
//      polygon keys beat the page's own Delete / I handlers only while a patch exists.
//   D. Display: hidden faces vanish from the render, relabelled faces draw with the other look,
//      lod.js keeps its LOD (no rebuild every frame).
//   E. Photosafety: the lens sweeping and edits toggling stay <= 3 flashes/s (same measure as
//      safety-test.html); dense triangles fade out instead of drawing a moire of lines.
//   F. BUGS #46 (owner: "still showed the original hologram"): on the real 8-part sample chair
//      (304k tris) entering the mode visibly changes the WHOLE model (faint skin + full wire, by
//      pixel diff, pointer off the model), the wire covers every part within budget, the lens
//      attaches to the part under it, whole-scene mode, exit restores, on/off toggling is photosafe.

import * as THREE from 'three';
import * as BVHLIB from 'three-mesh-bvh';

const V = new URL(import.meta.url).search;
const { parseGroup, separateInferred } = await import('./upload.js' + V);
const { splitComponents } = await import('./segment.js' + V);
const { createLook } = await import('./look.js' + V);
const { createDisplayLod, PREPASS_LAYER } = await import('./lod.js' + V);
const { createObjectMode } = await import('./objectmode.js' + V);
const { createPolygonMode, RADIUS_MIN, RADIUS_MAX, WIRE_BUDGET } = await import('./polygon.js' + V);
const { SKIN_FAINT } = await import('./look.js' + V);

const out = document.getElementById('out');
out.textContent = '';
const log = (s) => { out.textContent += s + '\n'; };
const results = [], metrics = {};
const consoleErrors = [];
window.addEventListener('error', (e) => consoleErrors.push(String(e.message)));
const origError = console.error;
console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); origError(...a); };
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
const tick = () => new Promise((r) => setTimeout(r));

// ---- scene, as the Platform builds it ---------------------------------------------------------
const W = 480, H = 360, FPS = 60;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
const view = document.getElementById('view');
view.append(renderer.domElement);
const canvas = renderer.domElement;
const gl = renderer.getContext();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(45, W / H, 0.01, 50);
const look = createLook({ scene, mount: null });
for (const p of Object.values(look.parents)) { p.uniforms.realism.value = 0; p.uniforms.blinkAmount.value = 0; p.motion = 0; }
// A small budget so the chair (98k faces) really gets LODs: D checks polygon edits don't fight them.
const lod = createDisplayLod({ scene, camera, renderer, look, budget: 20000 });

const res = await fetch('../completion/out/chair_underside_completed.obj');
if (!res.ok) throw new Error('completion/out/chair_underside_completed.obj missing (Track B output; see the P5 report)');
const file = new File([await res.blob()], 'chair_underside_completed.obj');
const scan = await parseGroup({ kind: 'scan', name: file.name, main: file, sidecars: [] });
const seg = splitComponents(scan.object);
separateInferred(seg.root);
const root = seg.root;
root.traverse((c) => { if (c.isMesh && !c.userData.original) c.userData.original = c.material; });
look.prepare(root);
const box0 = new THREE.Box3().setFromObject(root);
root.position.sub(box0.getCenter(new THREE.Vector3()));
scene.add(root);
root.updateMatrixWorld(true);
lod.add(root);

// Every mesh under the root is a part here (separateInferred adds inferred child patches).
const ITEM = 1;
const parts = [];
root.traverse((m) => { if (m.isMesh) parts.push(m); });
parts.forEach((m, i) => { m.userData.itemId = ITEM; m.userData.partId = `${ITEM}.${i + 1}`; m.material = look.materialFor(m, 'base'); });
const edits = [];
const objectMode = createObjectMode({
  camera, canvas, controls: { enabled: true }, edits,
  materialFor: (kind, mesh) => look.materialFor(mesh, kind)
});
objectMode.addParts(parts.map((mesh) => ({ id: mesh.userData.partId, mesh })));
objectMode.addItem(ITEM, root);
const item = { id: ITEM, name: 'chair (completed)', root, parts: parts.map((mesh) => ({ id: mesh.userData.partId, mesh })) };
const testItems = [item];   // F adds the 8-part sample chair
const poly = createPolygonMode({
  scene, camera, canvas, objectMode, getItem: (id) => testItems.find((i) => i.id === id) ?? null, getItems: () => testItems,
  materialFor: (m) => look.materialFor(m, 'base'), prepassLayer: PREPASS_LAYER, onSkin: (k) => look.setSkin(k)
});
// The wire / skin ease over ~0.4 s: tick until they rest (on: fully in; off: fully out).
async function settle() {
  for (let i = 0; i < 200; i++) {
    poly.tick();
    const st = poly.state();
    if (st.active ? st.wire.fade === 1 : st.wire.fade === 0 && st.skin === 1) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}
const render = poly.wrapRender((r, s, c) => lod.render(r, s, c));
const draw = () => { poly.tick(); render(renderer, scene, camera); };
// The same frame without the full wire (BUGS #46): isolates the lens / the skin.
const drawNoWire = (skin = null) => { poly.tick(); const { wireMesh, wireDepth } = poly.objects; wireMesh.visible = wireDepth.visible = false; if (skin != null) look.setSkin(skin); render(renderer, scene, camera); if (skin != null) look.setSkin(poly.state().skin); };
const readPx = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const LUT = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const lumAt = (px, x, y) => { const p = ((H - 1 - y) * W + x) * 4; return 0.2126 * LUT[px[p]] + 0.7152 * LUT[px[p + 1]] + 0.0722 * LUT[px[p + 2]]; };
const meanL = (px, cx, cy, r) => { let s = 0, n = 0; for (let y = cy - r; y < cy + r; y++) for (let x = cx - r; x < cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) { s += lumAt(px, x, y); n++; } return s / n; };

const size = box0.getSize(new THREE.Vector3()).length();
function viewFrom(dist = 1.0) {
  camera.position.set(0, -size * 0.45 * dist, size * 0.9 * dist);   // from below: the inferred underside shows
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
}
viewFrom();
const rect = () => canvas.getBoundingClientRect();
const at = (fx, fy) => { const r = rect(); return [r.left + fx * W, r.top + fy * H]; };

// A pointer position over the chair: the first grid point whose ray hits a part.
function findHit(wantInferred, want = () => true) {
  const rc = new THREE.Raycaster();
  for (let gy = 0.3; gy <= 0.8; gy += 0.05) for (let gx = 0.3; gx <= 0.7; gx += 0.05) {
    rc.setFromCamera(new THREE.Vector2(gx * 2 - 1, -(gy * 2 - 1)), camera);
    const h = rc.intersectObjects(parts, false)[0];
    if (h && (wantInferred == null || !!h.object.userData.inferred === wantInferred) && want(h.object)) return at(gx, gy);
  }
  return null;
}

// ---- A. library --------------------------------------------------------------------------------
check('three-mesh-bvh loads from the import map on three r161', typeof BVHLIB.MeshBVH === 'function' && THREE.REVISION === '161',
  `REVISION ${THREE.REVISION}`);
const totalFaces = parts.reduce((n, m) => n + poly.faceState(m).faces, 0);
const infFaces = parts.filter((m) => m.userData.inferred).reduce((n, m) => n + poly.faceState(m).faces, 0);
check('enter(item) builds the BVHs lazily and turns the mode on', poly.enter(ITEM) && poly.active,
  `${parts.length} meshes, ${totalFaces.toLocaleString()} faces (${infFaces.toLocaleString()} inferred), BVH build ${poly.state().bvhMs.toFixed(0)} ms`);
metrics.bvhMs = Math.round(poly.state().bvhMs);
metrics.faces = totalFaces;
{
  // BVH (indirect) raycast vs three's plain raycast, 200 rays through the chair's box.
  const big = parts.reduce((a, b) => (poly.faceState(a).faces >= poly.faceState(b).faces ? a : b));
  const { MeshBVH } = BVHLIB;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', big.geometry.attributes.position);
  geo.setIndex(big.geometry.index ?? null);
  if (!geo.index) geo.setIndex([...Array(big.geometry.attributes.position.count).keys()]);
  const bvh = new MeshBVH(geo, { indirect: true });
  const rc = new THREE.Raycaster();
  let agree = 0, hits = 0;
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let i = 0; i < 200; i++) {
    rc.setFromCamera(new THREE.Vector2(rnd() * 1.2 - 0.6, rnd() * 1.2 - 0.6), camera);
    const ref = rc.intersectObject(big, false).filter((h) => h.face)[0];
    const inv = big.matrixWorld.clone().invert();
    const h = bvh.raycastFirst(rc.ray.clone().applyMatrix4(inv), big.material.side);   // same culling as three's raycast
    if (!ref && !h) continue;
    hits++;
    // Same face, or a tie on a shared edge (same distance to 1e-6 m).
    if (ref && h && (ref.faceIndex === h.faceIndex || Math.abs(ref.distance - h.distance * big.matrixWorld.getMaxScaleOnAxis()) < 1e-6)) agree++;
  }
  check('BVH face numbers = three.js face numbers (200 rays)', hits > 20 && agree === hits, `${agree}/${hits} hits agree`);
  check('BVH leaves the scan\'s index untouched (indirect build)', !big.geometry.index || geo.index === big.geometry.index);
}

// ---- B. lens ------------------------------------------------------------------------------------
const p0 = findHit(false);
poly.setPointer(...p0);
const lens0 = poly.lensFaces();
const st0 = poly.state();
check('lens under the pointer finds the item\'s faces and reports faces / area / % inferred',
  st0.lens && st0.lens.faces > 0 && st0.lens.area > 0 && st0.lens.inferredPct >= 0 && st0.lens.inferredPct <= 100,
  st0.lens ? `${st0.lens.faces} faces, ${(st0.lens.area * 1e4).toFixed(1)} cm², ${st0.lens.inferredPct.toFixed(1)}% inferred, radius ${poly.radius} px` : 'no lens');
{
  // Brute force: every visible face of every part within the lens sphere. Rebuild the sphere
  // from the same hit + px->m rule polygon.js documents.
  const rc = new THREE.Raycaster(); const r = rect();
  rc.setFromCamera(new THREE.Vector2(((p0[0] - r.left) / r.width) * 2 - 1, -((p0[1] - r.top) / r.height) * 2 + 1), camera);
  const hit = rc.intersectObjects(parts, false)[0];
  const depth = -hit.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
  const rad = poly.radius * (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / r.height;
  let same = true, nBrute = 0;
  const t = new THREE.Triangle(), c = new THREE.Vector3();
  for (const m of parts) {
    const pos = m.geometry.attributes.position, idx = m.geometry.index;
    const found = new Set();
    const n = (idx ? idx.count : pos.count) / 3;
    for (let f = 0; f < n; f++) {
      const vi = (k) => (idx ? idx.getX(f * 3 + k) : f * 3 + k);
      t.a.fromBufferAttribute(pos, vi(0)).applyMatrix4(m.matrixWorld);
      t.b.fromBufferAttribute(pos, vi(1)).applyMatrix4(m.matrixWorld);
      t.c.fromBufferAttribute(pos, vi(2)).applyMatrix4(m.matrixWorld);
      if (t.closestPointToPoint(hit.point, c).distanceTo(hit.point) <= rad * 0.999) found.add(f);
    }
    const got = new Set(lens0.get(m.userData.partId) ?? []);
    nBrute += found.size;
    for (const f of found) if (!got.has(f)) same = false;
    for (const f of got) {   // allow faces right at the rim (float noise)
      if (found.has(f)) continue;
      const vi = (k) => (idx ? idx.getX(f * 3 + k) : f * 3 + k);
      t.a.fromBufferAttribute(pos, vi(0)).applyMatrix4(m.matrixWorld); t.b.fromBufferAttribute(pos, vi(1)).applyMatrix4(m.matrixWorld); t.c.fromBufferAttribute(pos, vi(2)).applyMatrix4(m.matrixWorld);
      if (t.closestPointToPoint(hit.point, c).distanceTo(hit.point) > rad * 1.001) same = false;
    }
  }
  check('lens faces = brute-force faces inside the lens sphere', same, `${nBrute} brute-force vs ${st0.lens?.faces} lens`);
}
{
  const camBefore = camera.position.clone();
  const r0 = poly.radius;
  let zoomSeen = 0;
  const spy = () => zoomSeen++;
  canvas.addEventListener('wheel', spy);   // a bubbling listener (where OrbitControls listens)
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: p0[0], clientY: p0[1], bubbles: true, cancelable: true }));
  const r1 = poly.radius;
  poly.tick();
  const bigger = poly.state().lens.faces;
  canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, clientX: p0[0], clientY: p0[1], bubbles: true, cancelable: true }));
  poly.tick();
  const smaller = poly.state().lens.faces;
  canvas.removeEventListener('wheel', spy);
  check('wheel over the item grows / shrinks the lens and never reaches the camera zoom',
    r1 > r0 && poly.radius < r1 && bigger > st0.lens.faces && smaller < bigger && zoomSeen === 0 && camera.position.equals(camBefore),
    `radius ${r0} -> ${r1.toFixed(1)} -> ${poly.radius.toFixed(1)} px; faces ${st0.lens.faces} -> ${bigger} -> ${smaller}; zoom listener calls ${zoomSeen}`);
  poly.radius = 1e9; const hi = poly.radius; poly.radius = 0; const lo = poly.radius;
  check('lens radius is clamped', hi === RADIUS_MAX && lo === RADIUS_MIN, `${lo}..${hi} px`);
  poly.radius = r0;
  poly.tick();
}

// ---- C. select, hide, mark inferred, undo / replay ---------------------------------------------
const full = new Map(parts.map((m) => [m, { geometry: m.geometry, index: m.geometry.index?.array.slice() ?? null, posVersion: m.geometry.attributes.position.version }]));
const geomUntouched = () => parts.every((m) => {
  const f = full.get(m);
  if (m.geometry !== f.geometry || m.geometry.attributes.position.version !== f.posVersion) return false;
  if (!f.index) return !m.geometry.index;
  const a = m.geometry.index.array; if (a.length !== f.index.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== f.index[i]) return false;
  return true;
});
const hiddenCount = () => parts.reduce((n, m) => n + poly.faceState(m).hidden.reduce((s, x) => s + x, 0), 0);
const inferredCount = () => parts.reduce((n, m) => { const fs = poly.faceState(m); let k = 0; for (let f = 0; f < fs.faces; f++) if (fs.inferred(f)) k++; return n + k; }, 0);

const [cx, cy] = p0;
canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, button: 0, bubbles: true }));
canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: cx + 1, clientY: cy, button: 0, bubbles: true }));
const patch1 = poly.state().patch;
check('click selects the patch = the faces in the lens', patch1 && patch1.faces === poly.state().lens.faces, `${patch1?.faces} faces`);
{
  const p1 = at(0.5, 0.5);
  const other = findHit(true) ?? p1;
  poly.setPointer(...other);
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: other[0], clientY: other[1], button: 0, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: other[0], clientY: other[1], button: 0, shiftKey: true, bubbles: true }));
  const patch2 = poly.state().patch;
  check('Shift-click adds the new lens to the patch', patch2.faces > patch1.faces, `${patch1.faces} -> ${patch2.faces} faces (${patch2.inferredPct.toFixed(0)}% inferred)`);
  canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: other[0], clientY: other[1], button: 0, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: other[0] + 20, clientY: other[1], button: 0, bubbles: true }));
  check('a drag (orbit) does not change the patch', poly.state().patch.faces === patch2.faces);
  poly.setPointer(...p0);
  poly.select({ add: false });
}
const patchFaces = poly.state().patch.faces;
// The page's own handlers (main.js I = show inferred; objectmode Delete = hide part) listen in
// the bubble phase on window; they must not see the key while a patch exists.
let pageKeys = 0;
const pageSpy = (e) => { if (['Delete', 'i'].includes(e.key)) pageKeys++; };
window.addEventListener('keydown', pageSpy);
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
const hideEntry = edits[edits.length - 1];
check('Delete hides the patch as ONE edit-log entry (polyHide)', hideEntry?.op === 'polyHide' && hideEntry.faces === patchFaces && hiddenCount() === patchFaces,
  `${hideEntry?.op} seq ${hideEntry?.seq}, ${hideEntry?.faces} faces; hidden ${hiddenCount()}`);
check('the scan is not altered: mesh.geometry, its index and positions unchanged', geomUntouched());
check('the hidden faces leave the lens and the patch', !poly.state().patch && [...poly.lensFaces().values()].every((l) => l.length) && (poly.tick(), true)
  && parts.every((m) => (poly.lensFaces().get(m.userData.partId) ?? []).every((f) => !poly.faceState(m).hidden[f])));
check('hide entry is plain JSON (replayable / exportable)', JSON.stringify(JSON.parse(JSON.stringify(hideEntry))) === JSON.stringify(hideEntry));

objectMode.undo();
check('Ctrl+Z undoes the hide exactly', hiddenCount() === 0 && parts.every((m) => !poly.faceState(m).display), `hidden ${hiddenCount()}`);

// Mark inferred: pick a scanned-only patch, I marks it, I again unmarks it.
poly.setPointer(...p0); poly.select();
const inf0 = inferredCount();
const pf = poly.state().patch.faces, pPct = poly.state().patch.inferredPct;
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }));
const infEntry = edits[edits.length - 1];
const markedPct = poly.state().patch.inferredPct;
const overlays = parts.map((m) => poly.faceState(m).overlay).filter(Boolean);
check('I marks the patch inferred (one polyInfer entry, patch reads 100% inferred)', infEntry?.op === 'polyInfer' && infEntry.to === 1 && Math.abs(markedPct - 100) < 1e-9,
  `patch ${pf} faces ${pPct.toFixed(0)}% -> ${markedPct.toFixed(0)}% inferred; inferred faces ${inf0} -> ${inferredCount()}`);
check('marked faces draw with the inferred (hatched) look via an overlay; the scan is untouched',
  overlays.length > 0 && overlays.every((o) => o.userData.inferred && o.material?.userData?.inferred) && geomUntouched(), `${overlays.length} overlay meshes`);
const afterMark = inferredCount(), wasInf = pf - (afterMark - inf0);   // patch faces already inferred before I
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }));
check('I again unmarks the whole patch (it was all inferred), incl. faces that came inferred',
  edits[edits.length - 1].to === 0 && inferredCount() === inf0 - wasInf, `inferred faces ${inferredCount()} (expected ${inf0} - ${wasInf})`);
objectMode.undo();
check('undo the unmark -> marked again', inferredCount() === afterMark, `inferred ${inferredCount()} (expected ${afterMark})`);
objectMode.undo();
check('undo the mark -> labels back as scanned', inferredCount() === inf0 && parts.every((m) => !poly.faceState(m).overlay));
check('the page\'s own Delete / I handlers never saw the keys while a patch existed', pageKeys === 0, `${pageKeys} calls`);
poly.clearPatch();
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true, cancelable: true }));
check('with no patch, I falls through to the page (show / hide inferred)', pageKeys === 1 && edits.length === 0, `${pageKeys} page calls, ${edits.length} edits`);
window.removeEventListener('keydown', pageSpy);

// Replay + adopt: hide one patch, mark another, then replayTo(0) / replayTo(Infinity) and a
// JSON round trip into an unedited session.
poly.setPointer(...p0); poly.select(); poly.hidePatch();
const pB = findHit(true) ?? at(0.5, 0.6);
poly.setPointer(...pB); poly.select(); poly.toggleInferredPatch();
const afterH = hiddenCount(), afterI = inferredCount();
objectMode.replayTo(0);
const atZero = [hiddenCount(), inferredCount()];
objectMode.replayTo(Infinity);
check('replayTo(0) / replayTo(Infinity) rebuild the polygon edits from the log', atZero[0] === 0 && atZero[1] === inf0 && hiddenCount() === afterH && inferredCount() === afterI,
  `hidden 0/${afterH}, inferred ${atZero[1]}/${afterI}`);
const saved = JSON.parse(JSON.stringify(edits));
objectMode.undo(); objectMode.undo();
const adopted = objectMode.adoptHistory(saved);
check('a saved history (JSON) is adopted by an unedited session and re-applies the faces', adopted && hiddenCount() === afterH && inferredCount() === afterI,
  `adopted ${adopted}, hidden ${hiddenCount()}, inferred ${inferredCount()}`);

// BUGS #54 (owner: mark a patch inferred, move it -> "deleted mesh / dark spot"): every face of
// the part is still drawn (shown + relabelled overlay + hidden = all) and the overlay follows its
// part through the move and its undo. The darker look is the inferred mark (look.js P5), not a hole.
{
  const m = parts.find((x) => poly.faceState(x).overlay);
  const whole = () => {
    const f = poly.faceState(m);
    const shown = f.display ? f.display.index.count / 3 : f.faces;
    return shown + (f.overlay ? f.overlay.geometry.index.count / 3 : 0) + f.hidden.reduce((n, v) => n + v, 0) === f.faces;
  };
  const follows = () => {
    poly.tick();
    const o = poly.faceState(m).overlay;
    o.updateMatrixWorld();
    return o.visible && o.matrixWorld.elements.every((v, i) => Math.abs(v - m.matrixWorld.elements[i]) < 1e-9);
  };
  const n0 = edits.length, p0 = m.position.clone();
  objectMode.beginMove(m.userData.partId, null, null); objectMode.moveBy(0.2, -0.1, 0.4); objectMode.endMove();
  const moved = !!m && m.position.distanceTo(p0) > 0.1 && whole() && follows() && edits.length === n0 + 1 && inferredCount() === afterI;
  objectMode.undo();
  check('#54 marked-inferred faces stay drawn and follow their part through a move and its undo',
    moved && m.position.distanceTo(p0) < 1e-9 && whole() && follows() && inferredCount() === afterI && hiddenCount() === afterH,
    `moved ${moved}, inferred ${inferredCount()}/${afterI}, hidden ${hiddenCount()}/${afterH}`);
}

// ---- D. display ---------------------------------------------------------------------------------
{
  // Fresh state: one hide, then compare the pixels where it was against the unedited render.
  while (edits.length) objectMode.undo();
  poly.exit(); await settle();
  viewFrom();
  draw(); const before = readPx();
  poly.enter(ITEM); poly.setPointer(...p0); poly.select(); poly.hidePatch(); poly.exit(); await settle();
  draw(); const after = readPx();
  const r = rect();
  const px = Math.round(p0[0] - r.left), py = Math.round(p0[1] - r.top);
  const Lb = meanL(before, px, py, 12), La = meanL(after, px, py, 12);
  check('hidden faces are gone from the render (the hologram behind shows through / goes dark)', Math.abs(Lb - La) > 0.002 && geomUntouched(),
    `L ${Lb.toFixed(4)} -> ${La.toFixed(4)} at the hidden patch; geometry untouched ${geomUntouched()}`);
  objectMode.undo();
  // The simplifier is async (wasm + one mesh per task): wait until the LOD set stops changing.
  let nLod = -1, stable = 0;
  for (let i = 0; i < 400 && stable < 25; i++) {
    draw(); await new Promise((r) => setTimeout(r, 20));
    const n = parts.filter((m) => m.userData.lod).length;
    stable = n === nLod && n > 0 ? stable + 1 : 0; nLod = n;
  }
  const pL = findHit(null, (m) => !!m.userData.lod);
  if (pL) { poly.enter(ITEM); poly.setPointer(...pL); poly.select(); poly.hidePatch(); poly.exit(); }
  const lodMeshes = parts.filter((m) => m.userData.lod);
  const editedLod = lodMeshes.filter((m) => poly.faceState(m).display).length;
  const lodBefore = lodMeshes.map((m) => m.userData.lod);
  for (let i = 0; i < 5; i++) draw();
  await tick(); await tick();
  check('lod.js keeps its LODs across renders of an edited mesh (no rebuild loop)',
    lodMeshes.length > 0 && editedLod > 0 && lodMeshes.every((m, i) => m.userData.lod === lodBefore[i]) && parts.every((m) => m.geometry === full.get(m).geometry),
    `${lodMeshes.length} meshes with a LOD, ${editedLod} of them edited; same LOD objects after 5 frames`);
  objectMode.undo();
}

// ---- E. photosafety -----------------------------------------------------------------------------
const TILE_W = 80, TILE_H = 60, FLASH_DELTA = 0.10, DARK_LIMIT = 0.80;
function flashes(frames) {
  const tilesX = W / TILE_W, tilesY = H / TILE_H, n = frames.length;
  const tileL = Array.from({ length: tilesX * tilesY }, () => new Float32Array(n));
  frames.forEach((px, f) => {
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
      let s = 0;
      for (let y = ty * TILE_H; y < (ty + 1) * TILE_H; y++) for (let x = tx * TILE_W; x < (tx + 1) * TILE_W; x++) {
        const p = (y * W + x) * 4; s += 0.2126 * LUT[px[p]] + 0.7152 * LUT[px[p + 1]] + 0.0722 * LUT[px[p + 2]];
      }
      tileL[ty * tilesX + tx][f] = s / (TILE_W * TILE_H);
    }
  });
  let worst = 0;
  for (const L of tileL) {
    const tr = [];
    let ext = L[0], dir = 0;
    for (let f = 1; f < n; f++) {
      const d = L[f] - ext;
      if (dir >= 0 && L[f] > ext) { ext = L[f]; dir = 1; continue; }
      if (dir <= 0 && L[f] < ext) { ext = L[f]; dir = -1; continue; }
      if (Math.abs(d) >= FLASH_DELTA && Math.min(L[f], ext) < DARK_LIMIT) { tr.push(f); dir = d > 0 ? 1 : -1; ext = L[f]; }
    }
    for (let i = 0; i < tr.length; i++) { let j = i; while (j < tr.length && tr[j] - tr[i] < FPS) j++; worst = Math.max(worst, Math.floor((j - i) / 2)); }
  }
  return worst;
}
async function sweep(label, everyS) {
  poly.enter(ITEM);
  const frames = [];
  for (let f = 0; f < FPS * 3; f++) {
    const t = f / FPS;
    poly.setPointer(...at(0.3 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.1)), 0.4 + 0.25 * (0.5 + 0.5 * Math.sin(t * 1.3))));
    if (everyS && f % Math.round(everyS * FPS) === 0) {
      if (edits.length) objectMode.undo(); else { poly.select(); poly.hidePatch(); }
    }
    draw();
    frames.push(readPx());
    if (f % 30 === 0) await tick();
  }
  while (edits.length) objectMode.undo();
  const fl = flashes(frames);
  metrics[`flashes_${everyS ? 'toggle' : 'sweep'}`] = fl;
  check(`photosafe: ${label}`, fl <= 3, `${fl} flashes/s (limit 3)`);
}
await sweep('lens sweeping over the chair', 0);
await sweep('lens sweeping + hide / undo every 0.4 s', 0.4);
{
  // Density fade: the same lens over the chair from close and from far away. Far away the
  // triangles are a few px across, so the lines must fade to almost nothing.
  const lensGain = async (dist) => {
    viewFrom(dist);
    poly.enter(ITEM); poly.radius = 60;
    const p = findHit(null) ?? at(0.5, 0.5);
    poly.setPointer(...p);
    for (let i = 0; i < 20; i++) { poly.tick(); await new Promise((r) => setTimeout(r, 12)); }   // let the fade-in finish
    await settle();
    drawNoWire(1); const on = readPx();   // full skin: the same background the lens was tuned on
    poly.clearPointer();   // the lens alone fades out (the full wire, BUGS #46, is hidden in both frames)
    for (let i = 0; i < 20; i++) { poly.tick(); await new Promise((r) => setTimeout(r, 12)); }
    drawNoWire(1); const off = readPx();
    poly.exit(); await settle();
    const r = rect(); const x = Math.round(p[0] - r.left), y = Math.round(p[1] - r.top);
    return meanL(on, x, y, 40) - meanL(off, x, y, 40);
  };
  const near = await lensGain(0.35), far = await lensGain(4.0);
  metrics.lensGainNear = +near.toFixed(4); metrics.lensGainFar = +far.toFixed(4);
  check('lens wire is visible on big triangles (near view)', near > 0.003, `+${near.toFixed(4)} mean luminance in the lens`);
  check('dense triangles fade instead of drawing a line moire (far view)', far < near * 0.5 && far < 0.01, `+${far.toFixed(4)} far vs +${near.toFixed(4)} near`);
  viewFrom();
}

// ---- F. BUGS #46: the mode visibly turns the whole model into triangles --------------------------
{
  poly.exit(); await settle();
  while (edits.length) objectMode.undo();
  root.visible = false;
  const r2 = await fetch('../assets/chair/chair_detail.glb');
  const scan2 = await parseGroup({ kind: 'scan', name: 'chair_detail.glb', main: new File([await r2.blob()], 'chair_detail.glb'), sidecars: [] });
  const seg2 = splitComponents(scan2.object);
  const root2 = seg2.root;
  root2.traverse((c) => { if (c.isMesh && !c.userData.original) c.userData.original = c.material; });
  look.prepare(root2);
  const bx = new THREE.Box3().setFromObject(root2);
  root2.position.sub(bx.getCenter(new THREE.Vector3()));
  scene.add(root2); root2.updateMatrixWorld(true); lod.add(root2);
  const ITEM2 = 2, parts2 = [];
  root2.traverse((m) => { if (m.isMesh) parts2.push(m); });
  parts2.forEach((m, i) => { m.userData.itemId = ITEM2; m.userData.partId = `${ITEM2}.${i + 1}`; m.material = look.materialFor(m, 'base'); });
  objectMode.addParts(parts2.map((mesh) => ({ id: mesh.userData.partId, mesh })));
  objectMode.addItem(ITEM2, root2);
  const item2 = { id: ITEM2, name: 'chair_detail.glb', root: root2, parts: parts2.map((mesh) => ({ id: mesh.userData.partId, mesh })) };
  testItems.push(item2);
  const tris2 = parts2.reduce((n, m) => n + poly.faceState(m).faces, 0);
  const s2 = bx.getSize(new THREE.Vector3()).length();
  const frame = (d) => { camera.position.set(s2 * 0.35 * d, s2 * 0.25 * d, s2 * 0.75 * d); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true); };
  frame(1);
  // Let lod.js build its LODs (async) so the hologram draws what the page draws.
  for (let i = 0, n = -1, st = 0; i < 300 && st < 20; i++) { draw(); await new Promise((r) => setTimeout(r, 15)); const k = parts2.filter((m) => m.userData.lod).length; st = k === n ? st + 1 : 0; n = k; }
  check('F: sample chair loads as a multi-part item (8 parts, ~304k tris)', parts2.length >= 8 && tris2 > 250000, `${parts2.length} parts, ${tris2.toLocaleString()} tris`);

  // Pixel diff, pointer OFF the model (so this is the mode itself, not the lens).
  poly.clearPointer();
  draw(); const before = readPx();
  const ok = poly.enter(ITEM2); poly.clearPointer(); const settled = await settle();
  draw(); const after = readPx();
  drawNoWire(); const skinOnly = readPx();
  let model = 0, changed = 0, darker = 0, brighter = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const Lb = lumAt(before, x, y), La = lumAt(after, x, y), Ls = lumAt(skinOnly, x, y);
    if (Lb < 0.01 && La < 0.01) continue;
    model++;
    if (Math.abs(La - Lb) > 0.01) changed++;
    if (Ls < Lb - 0.01) darker++;      // the skin faded
    if (La > Ls + 0.01) brighter++;    // a wire line on the faded skin
  }
  const st = poly.state();
  metrics.f_changedPct = +(100 * changed / Math.max(1, model)).toFixed(1);
  metrics.f_wireTris = st.wire.shown;
  check('F: entering Polygon visibly changes the whole model (pixel diff, no lens)', ok && settled && model > 2000 && changed / model > 0.5,
    `${(100 * changed / Math.max(1, model)).toFixed(0)}% of ${model} model px changed`);
  check('F: the hologram fades to a faint skin and wire lines draw on it', Math.abs(st.skin - SKIN_FAINT) < 1e-6 && darker > model * 0.3 && brighter > model * 0.02,
    `skin ${st.skin.toFixed(2)}, ${darker} px darker, ${brighter} px brighter (lines)`);
  check('F: the wire covers every part of the item, within the budget', st.wire.shown > 500 && st.wire.shown <= WIRE_BUDGET && st.wire.total === tris2
    && parts2.every((m) => poly.faceState(m) && m.visible),
    `${st.wire.shown.toLocaleString()} of ${st.wire.total.toLocaleString()} triangles drawn`);
  // Zoom in: finer level, still in budget; out: coarser.
  frame(0.25); poly.tick(); const near = poly.state().wire.shown;
  frame(4); poly.tick(); const far = poly.state().wire.shown;
  frame(1); poly.tick();
  check('F: the wire gets finer as you zoom in and never exceeds the budget', near > st.wire.shown && far <= st.wire.shown && near <= WIRE_BUDGET,
    `far ${far.toLocaleString()} · default ${st.wire.shown.toLocaleString()} · near ${near.toLocaleString()}`);
  metrics.f_wireNear = near; metrics.f_wireFar = far;

  // The lens attaches to the part under the pointer, for several parts.
  const rc = new THREE.Raycaster();
  let tried = 0, right = 0;
  for (let gy = 0.2; gy <= 0.85 && tried < 8; gy += 0.05) for (let gx = 0.2; gx <= 0.8 && tried < 8; gx += 0.1) {
    rc.setFromCamera(new THREE.Vector2(gx * 2 - 1, -(gy * 2 - 1)), camera);
    const h = rc.intersectObjects(parts2, false)[0];
    if (!h) continue;
    tried++;
    poly.radius = RADIUS_MIN; poly.setPointer(...at(gx, gy));
    const lf = poly.lensFaces();
    if (lf.has(h.object.userData.partId) && lf.get(h.object.userData.partId).includes(h.faceIndex)) right++;
  }
  poly.radius = 70; poly.clearPointer();
  check('F: on a multi-part item the lens finds the face under the pointer on the right part', tried >= 4 && right === tried, `${right}/${tried} points`);

  // Hidden faces leave the wire.
  let pH = null;
  for (let gy = 0.3; gy <= 0.7 && !pH; gy += 0.05) { rc.setFromCamera(new THREE.Vector2(0, -(gy * 2 - 1)), camera); if (rc.intersectObjects(parts2, false).length) pH = at(0.5, gy); }
  poly.setPointer(...pH); poly.select(); const hid = poly.hidePatch()?.faces ?? 0; poly.clearPointer(); poly.tick();
  check('F: hidden faces leave the wire', hid > 0 && poly.state().wire.total === tris2 - hid, `${hid} hidden, wire total ${poly.state().wire.total}`);
  objectMode.undo(); poly.tick();

  // Whole scene: nothing selected -> every item.
  root.visible = true;
  poly.exit(); await settle();
  const okS = poly.enter(null); await settle();
  const sS = poly.state();
  check('F: with nothing selected, Polygon covers the whole scene', okS && /whole scene \(2 items\)/.test(sS.name) && sS.wire.total === tris2 + totalFaces,
    `${sS.name}: wire over ${sS.wire.total.toLocaleString()} triangles`);
  root.visible = false;

  // Exit restores the look exactly.
  poly.exit(); await settle();
  draw(); const back = readPx();
  let maxD = 0; for (let i = 0; i < back.length; i += 4) maxD = Math.max(maxD, Math.abs(back[i] - before[i]), Math.abs(back[i + 1] - before[i + 1]), Math.abs(back[i + 2] - before[i + 2]));
  check('F: leaving Polygon restores the hologram exactly', poly.state().skin === 1 && maxD <= 2, `max channel diff ${maxD}`);

  // Photosafety: toggling the mode on/off fast (the owner pressed it 5x) and once.
  // The ease is driven by real time (dt), so each frame advances the clock by exactly 1/FPS.
  const realNow = performance.now.bind(performance);
  let worst = 0; const per = [];
  for (const every of [0.15, 0.3, 0.5]) {
    const frames = []; let clock = realNow();
    performance.now = () => clock;
    for (let f = 0; f < FPS * 3; f++) {
      if (f % Math.round(every * FPS) === 0) { if (poly.active) poly.exit(); else poly.enter(ITEM2); }
      clock += 1000 / FPS;
      poly.tick(); render(renderer, scene, camera); frames.push(readPx());
      if (f % 30 === 0) await tick();
    }
    performance.now = realNow;
    poly.exit(); await settle();
    const fl = flashes(frames); per.push(`${every}s: ${fl}`); worst = Math.max(worst, fl);
  }
  metrics.flashes_polyToggle = worst;
  check('F: photosafe: Polygon on/off every 0.15 / 0.3 / 0.5 s', worst <= 2, `${per.join(' · ')} flashes/s (limit 3; asked <= 2 for margin)`);
  testItems.pop(); scene.remove(root2); root.visible = true;
}

check('0 console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
const failed = results.filter((r) => !r.ok).length;
log(`\n${results.length - failed} passed, ${failed} failed`);
window.polygonResults = { passed: results.length - failed, failed, results, metrics };

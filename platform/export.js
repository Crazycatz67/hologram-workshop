import * as THREE from 'three';

// Client-side exports. Every function returns { blob, filename } and never touches the DOM
// except through `ctx`, so main.js decides how to download it (and tests can read the Blob).
//
// ctx = {
//   items(): ready library items  { id, name, sourceFile, fileSize, sha256, kind, root, parts:[{id, local, mesh}] }
//   renderer, scene, camera, controls, edits, objectMode
// }
// Contract with the material layer (look.js): every Mesh/Points that is ever given a hologram
// material keeps its LOADED material on `userData.original`. GLB export uses that, never the shader.

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const round = (n, d = 5) => Math.round(n * 10 ** d) / 10 ** d;
const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };

// ---------------------------------------------------------------- GLB
export async function exportGLB(ctx) {
  const items = ctx.items().filter((i) => i.root.visible);
  if (!items.length) throw new Error('nothing visible to export');
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');

  const stash = [];
  for (const it of items) {
    stash.push({ o: it.root, userData: it.root.userData });
    it.root.userData = { sourceFile: it.sourceFile, itemId: it.id, kind: it.kind };
    it.root.traverse((o) => {
      if (o === it.root || !(o.isMesh || o.isPoints)) return;
      stash.push({ o, material: o.material, userData: o.userData });
      const orig = o.userData.original;
      const hasColor = !!o.geometry.attributes.color;
      o.material = orig ?? (o.isPoints
        ? new THREE.PointsMaterial({ size: 0.01, vertexColors: hasColor })
        : new THREE.MeshStandardMaterial({ color: 0xcccccc, vertexColors: hasColor }));
      // userData becomes glTF `extras`; the original material object must not be in there.
      const extras = { sourceFile: it.sourceFile, itemId: it.id };
      if (o.userData.inferredShare != null) extras.inferredShare = o.userData.inferredShare;
      o.userData = extras;
    });
  }
  try {
    const buf = await new Promise((res, rej) => new GLTFExporter().parse(
      items.map((i) => i.root), res, rej, { binary: true, onlyVisible: true, maxTextureSize: 4096 }
    ));
    return { blob: new Blob([buf], { type: 'model/gltf-binary' }), filename: `hologram-scene-${stamp()}.glb` };
  } finally {
    for (const s of stash) {
      s.o.userData = s.userData;
      if (s.material) s.o.material = s.material;
    }
    ctx.restoreMaterials?.();
  }
}

// ---------------------------------------------------------------- Layout JSON
const xform = (o) => ({
  position: o.position.toArray().map((n) => round(n)),
  rotation: [o.rotation.x, o.rotation.y, o.rotation.z].map((n) => round(n)),
  scale: o.scale.toArray().map((n) => round(n))
});
function applyXform(o, t) {
  if (!t) return;
  o.position.fromArray(t.position);
  o.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2]);
  o.scale.fromArray(t.scale);
}

export function buildLayout(ctx) {
  const items = ctx.items().map((it) => ({
    id: it.id, name: it.name, kind: it.kind, sourceFile: it.sourceFile, fileSize: it.fileSize, sha256: it.sha256,
    transform: xform(it.root), hidden: !it.root.visible, pinned: !!it.root.userData.pinned,
    parts: it.parts.map((p) => ({ id: p.local, transform: xform(p.mesh), hidden: !p.mesh.visible, pinned: !!p.mesh.userData.pinned }))
  }));
  return {
    version: 2, createdAt: new Date().toISOString(), items,
    edits: JSON.parse(JSON.stringify(ctx.edits)),
    camera: { position: ctx.camera.position.toArray().map((n) => round(n)), target: ctx.controls.target.toArray().map((n) => round(n)) }
  };
}

export function exportLayout(ctx) {
  const json = JSON.stringify(buildLayout(ctx), null, 2);
  return { blob: new Blob([json], { type: 'application/json' }), filename: `hologram-layout-${stamp()}.json` };
}

// Re-applies a layout onto the currently loaded items: match by sha256, else by name.
// Returns { applied, mismatches:[string], historyRestored }.
//
// History: a layout carries the full edit history (objectmode.js entries with before/after
// states). When this session is unedited and the loaded objects sit exactly where that
// history started, the history itself is adopted (ids remapped), so undo and replay keep
// working across sessions. Otherwise the layout is applied as ONE undoable edit whose
// before/after states are recorded like any other.
export function importLayout(ctx, layout) {
  if (!layout || !Array.isArray(layout.items)) throw new Error('not a hologram layout file (no items[])');
  const om = ctx.objectMode;
  om.ensureLive?.();
  const loaded = ctx.items();
  const used = new Set();
  const idMap = new Map(); // layout item id -> loaded item
  const mismatches = [];
  const changes = [];
  const track = (it, part, obj, fn) => {
    const before = om.snapshot(obj);
    fn();
    obj.updateMatrixWorld(true);
    changes.push({ item: it.id, part: part ? part.id : null, before, after: om.snapshot(obj) });
  };
  let applied = 0;

  for (const li of layout.items) {
    let it = li.sha256 && loaded.find((x) => !used.has(x.id) && x.sha256 === li.sha256);
    let how = 'sha256';
    if (!it) { it = loaded.find((x) => !used.has(x.id) && x.name === li.name); how = 'name'; }
    if (!it) { mismatches.push(`no loaded item for "${li.name}"`); continue; }
    used.add(it.id);
    idMap.set(String(li.id), it);
    if (how === 'name' && li.sha256 && it.sha256) mismatches.push(`"${li.name}" matched by name only (file contents differ)`);
    // Pins too (objectmode.js PINS); layouts from before pins carry none and leave them alone.
    const pin = (o, l) => { if (typeof l.pinned === 'boolean') o.userData.pinned = l.pinned; };
    track(it, null, it.root, () => { applyXform(it.root, li.transform); it.root.visible = !li.hidden; pin(it.root, li); });
    for (const lp of li.parts ?? []) {
      const p = it.parts.find((x) => x.local === lp.id);
      if (!p) { mismatches.push(`"${li.name}" has no part #${lp.id}`); continue; }
      track(it, p, p.mesh, () => { applyXform(p.mesh, lp.transform); p.mesh.visible = !lp.hidden; pin(p.mesh, lp); });
    }
    applied++;
  }
  for (const x of loaded) if (!used.has(x.id)) mismatches.push(`loaded item "${x.name}" is not in the layout (left unchanged)`);

  if (layout.camera?.position && layout.camera?.target) {
    ctx.camera.position.fromArray(layout.camera.position);
    ctx.controls.target.fromArray(layout.camera.target);
    ctx.controls.update();
  }
  let historyRestored = 0;
  if (applied) {
    const history = remapHistory(layout.edits, idMap);
    let adopted = false;
    if (history?.length && om.adoptHistory) {
      // Adoption checks the chain's first `before` states against the scene as loaded, so
      // step back to that state first; the history's final `after` states (full precision)
      // then replace the rounded layout transforms.
      for (let i = changes.length - 1; i >= 0; i--) {
        const c = changes[i];
        const obj = om.resolve(c.item, c.part);
        const s = c.before;
        obj.position.fromArray(s.position); obj.quaternion.fromArray(s.quaternion); obj.scale.fromArray(s.scale);
        obj.visible = s.visible; obj.userData.pinned = !!s.pinned; obj.updateMatrixWorld(true);
      }
      adopted = om.adoptHistory(history);
      if (adopted) historyRestored = history.length;
      else for (const c of changes) { // put the layout back on
        const obj = om.resolve(c.item, c.part);
        const s = c.after;
        obj.position.fromArray(s.position); obj.quaternion.fromArray(s.quaternion); obj.scale.fromArray(s.scale);
        obj.visible = s.visible; obj.userData.pinned = !!s.pinned; obj.updateMatrixWorld(true);
      }
    }
    if (!adopted) {
      const moved = changes.filter((c) => JSON.stringify(c.before) !== JSON.stringify(c.after));
      om.record({ op: 'importLayout', items: [...used], changes: moved.length ? moved : changes, importedEdits: layout.edits?.length ?? 0 });
    }
  }
  return { applied, mismatches, historyRestored };
}

// Maps a layout's edit history onto the loaded items (layout item id -> loaded item id, part
// '<old>.<local>' -> the loaded part with the same local number). Returns null if any entry
// can't be mapped or predates replayable history (no before/after states).
function remapHistory(list, idMap) {
  if (!Array.isArray(list) || !list.length) return null;
  const mapItem = (id) => idMap.get(String(id))?.id;
  const mapPart = (item, part) => {
    if (part == null) return null;
    const it = idMap.get(String(item));
    const local = Number(String(part).split('.').pop());
    return it?.parts.find((p) => p.local === local)?.id;
  };
  const out = [];
  for (const e of list) {
    // Face-level ops (polygon.js polyHide / polyInfer, BUGS #51) carry no transform states:
    // their item and each polys[].part are remapped instead.
    if (Array.isArray(e.polys)) {
      const item = mapItem(e.item);
      const polys = e.polys.map((p) => ({ ...p, part: mapPart(e.item, p.part) }));
      if (item == null || polys.some((p) => p.part == null)) return null;
      out.push({ ...JSON.parse(JSON.stringify(e)), item, polys });
      continue;
    }
    const ch = e.changes ?? (e.before && e.after ? [{ item: e.item, part: e.part ?? null, before: e.before, after: e.after }] : null);
    if (!ch) return null;
    const mapped = [];
    for (const c of ch) {
      const item = mapItem(c.item);
      const part = mapPart(c.item, c.part);
      if (item == null || part === undefined) return null;
      mapped.push({ ...c, item, part });
    }
    const n = JSON.parse(JSON.stringify(e));
    if (e.changes) n.changes = mapped;
    else { n.item = mapped[0].item; n.part = mapped[0].part; }
    if (Array.isArray(n.items)) n.items = n.items.map((x) => (typeof x === 'object' && x ? { ...x, item: mapItem(x.item) ?? x.item } : mapItem(x) ?? x));
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- Floor plan SVG
function hull2(pts) { // Andrew monotone chain over [x,z]
  if (pts.length < 3) return pts.slice();
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

function worldXZ(objs, cap = 8000) {
  const pts = [], v = new THREE.Vector3();
  for (const o of objs) {
    const pos = o.geometry?.attributes.position;
    if (!pos) continue;
    o.updateWorldMatrix(true, false);
    const stride = Math.max(1, Math.floor(pos.count / cap));
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pts.push([v.x, v.z]);
    }
  }
  return pts;
}
const bboxOf = (pts) => pts.reduce((b, [x, z]) => ({ x0: Math.min(b.x0, x), x1: Math.max(b.x1, x), z0: Math.min(b.z0, z), z1: Math.max(b.z1, z) }),
  { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const dims = (b) => {
  const w = b.x1 - b.x0, d = b.z1 - b.z0;
  return `${w.toFixed(2)} × ${d.toFixed(2)} m (${Math.round(w * 100)} × ${Math.round(d * 100)} cm)`;
};

export function buildFloorPlan(ctx) {
  const items = ctx.items().filter((i) => i.root.visible);
  const shapes = [];
  for (const it of items) {
    const drawn = [];
    it.root.traverse((o) => { if ((o.isMesh || o.isPoints) && shown(o)) drawn.push(o); });
    const all = worldXZ(drawn);
    if (!all.length) continue;
    const partShapes = [];
    if (it.parts.length > 1) {
      for (const p of it.parts) {
        if (!shown(p.mesh)) continue;
        const pp = worldXZ([p.mesh]);
        if (pp.length) partShapes.push({ id: p.local, box: bboxOf(pp), hull: hull2(pp) });
      }
    }
    shapes.push({ item: it, box: bboxOf(all), hull: hull2(all), parts: partShapes });
  }
  if (!shapes.length) throw new Error('nothing visible to plan');

  const room = shapes.reduce((b, s) => ({ x0: Math.min(b.x0, s.box.x0), x1: Math.max(b.x1, s.box.x1), z0: Math.min(b.z0, s.box.z0), z1: Math.max(b.z1, s.box.z1) }),
    { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity });
  const rw = room.x1 - room.x0, rd = room.z1 - room.z0;
  const S = Math.max(40, Math.min(600, 900 / Math.max(rw, 0.5))); // px per metre
  const pad = 90;                                                 // px margin for dimension lines
  const W = Math.round(rw * S + pad * 2), H = Math.round(rd * S + pad * 2 + 40);
  const X = (x) => round((x - room.x0) * S + pad, 1), Y = (z) => round((z - room.z0) * S + pad, 1);
  const poly = (h) => h.map(([x, z]) => `${X(x)},${Y(z)}`).join(' ');

  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" data-items="${shapes.length}">`);
  o.push(`<title>Floor plan - ${shapes.length} item(s), ${rw.toFixed(2)} x ${rd.toFixed(2)} m</title>`);
  o.push(`<rect width="${W}" height="${H}" fill="#fff"/>`);
  o.push(`<text x="${pad}" y="26" font-size="15" font-weight="bold" fill="#000">Floor plan (top-down, scene axes)</text>`);
  // room bbox (dashed) + dimension lines
  o.push(`<rect x="${X(room.x0)}" y="${Y(room.z0)}" width="${round(rw * S, 1)}" height="${round(rd * S, 1)}" fill="none" stroke="#000" stroke-width="0.8" stroke-dasharray="6 4"/>`);
  const dimLine = (x1, y1, x2, y2, label, rot) => {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    return `<g stroke="#000" stroke-width="1" fill="#000"><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` +
      (rot ? `<line x1="${x1 - 5}" y1="${y1}" x2="${x1 + 5}" y2="${y1}"/><line x1="${x2 - 5}" y1="${y2}" x2="${x2 + 5}" y2="${y2}"/>`
        : `<line x1="${x1}" y1="${y1 - 5}" x2="${x1}" y2="${y1 + 5}"/><line x1="${x2}" y1="${y2 - 5}" x2="${x2}" y2="${y2 + 5}"/>`) +
      `<text stroke="none" font-size="12" text-anchor="middle" x="${rot ? mx - 8 : mx}" y="${rot ? my : my - 6}"${rot ? ` transform="rotate(-90 ${mx - 8} ${my})"` : ''}>${esc(label)}</text></g>`;
  };
  o.push(dimLine(X(room.x0), Y(room.z1) + 28, X(room.x1), Y(room.z1) + 28, `${rw.toFixed(2)} m (${Math.round(rw * 100)} cm)`, false));
  o.push(dimLine(X(room.x0) - 28, Y(room.z0), X(room.x0) - 28, Y(room.z1), `${rd.toFixed(2)} m (${Math.round(rd * 100)} cm)`, true));

  for (const s of shapes) {
    o.push(`<g data-item="${esc(s.item.id)}" data-name="${esc(s.item.name)}">`);
    for (const p of s.parts) {
      o.push(`<polygon points="${poly(p.hull)}" fill="#f2f2f2" stroke="#666" stroke-width="0.8" data-part="${esc(p.id)}"/>`);
      if (Math.max(p.box.x1 - p.box.x0, p.box.z1 - p.box.z0) >= 0.25) {
        o.push(`<text x="${X((p.box.x0 + p.box.x1) / 2)}" y="${Y((p.box.z0 + p.box.z1) / 2)}" font-size="9" text-anchor="middle" fill="#444">#${esc(p.id)} ${(p.box.x1 - p.box.x0).toFixed(2)}×${(p.box.z1 - p.box.z0).toFixed(2)}</text>`);
      }
    }
    o.push(`<polygon points="${poly(s.hull)}" fill="${s.parts.length ? 'none' : '#f2f2f2'}" stroke="#000" stroke-width="2"/>`);
    const cx = X((s.box.x0 + s.box.x1) / 2), top = Y(s.box.z0) - 16;
    o.push(`<text x="${cx}" y="${top}" font-size="12" font-weight="bold" text-anchor="middle" fill="#000">${esc(s.item.name)}</text>`);
    o.push(`<text x="${cx}" y="${top + 13}" font-size="10" text-anchor="middle" fill="#000">${esc(dims(s.box))}</text>`);
    o.push('</g>');
  }

  // scale bar
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20].filter((n) => n <= Math.max(rw / 2, 0.1)).pop() ?? 0.1;
  const sy = H - 22, sx = pad;
  o.push(`<g stroke="#000" stroke-width="2" fill="#000"><line x1="${sx}" y1="${sy}" x2="${round(sx + nice * S, 1)}" y2="${sy}"/><line x1="${sx}" y1="${sy - 5}" x2="${sx}" y2="${sy + 5}"/><line x1="${round(sx + nice * S, 1)}" y1="${sy - 5}" x2="${round(sx + nice * S, 1)}" y2="${sy + 5}"/><text stroke="none" x="${round(sx + nice * S + 8, 1)}" y="${sy + 4}" font-size="11">${nice} m</text></g>`);
  // north / axes arrow (scene -Z is "up" on the sheet)
  const ax = W - 50, ay = 60;
  o.push(`<g stroke="#000" stroke-width="1.5" fill="#000"><line x1="${ax}" y1="${ay + 30}" x2="${ax}" y2="${ay}"/><polygon points="${ax},${ay - 6} ${ax - 5},${ay + 6} ${ax + 5},${ay + 6}"/><text stroke="none" x="${ax}" y="${ay - 12}" font-size="12" font-weight="bold" text-anchor="middle">N (-Z)</text><text stroke="none" x="${ax + 10}" y="${ay + 44}" font-size="9">+X right, +Z down</text></g>`);
  o.push(`<text x="${W - pad}" y="${H - 10}" font-size="9" text-anchor="end" fill="#444">Axis-aligned extents; outlines are convex hulls. ${new Date().toISOString().slice(0, 10)}</text>`);
  o.push('</svg>');
  return o.join('\n');
}

export function exportPlan(ctx) {
  return { blob: new Blob([buildFloorPlan(ctx)], { type: 'image/svg+xml' }), filename: `hologram-plan-${stamp()}.svg` };
}

// ---------------------------------------------------------------- Screenshot
// three's WebGL canvas clears after compositing, so render and call toBlob in the SAME task:
// the snapshot is taken synchronously at the toBlob call.
export function exportPNG(ctx) {
  const { renderer, scene, camera } = ctx;
  // Same path as the live view (single-layer pass + display LOD), so the PNG matches the
  // screen instead of showing the additive bloom a plain render() would.
  if (scene.userData.renderSingleLayer) scene.userData.renderSingleLayer(renderer, scene, camera);
  else renderer.render(scene, camera);
  return new Promise((res, rej) => renderer.domElement.toBlob(
    (blob) => (blob ? res({ blob, filename: `hologram-${stamp()}.png` }) : rej(new Error('screenshot failed'))), 'image/png'));
}

// ---------------------------------------------------------------- Thumbnail (library cards)
// renderThumbnail(ctx, size = 256, { scene?, camera?, quality? }) -> Promise<Blob> (JPEG)
//
// Shoots `scene` through a square copy of `camera` (defaults: the live view in ctx) with the
// EXISTING renderer -- never a second WebGL context. Why not a WebGLRenderTarget: in r161 a
// render target gets LINEAR output from three's built-in materials but the raw values from
// HolographicMaterial (a ShaderMaterial with no colour-space step), so no single correction
// makes the thumbnail match the screen. Instead it renders into a scissored square in the
// corner of the live canvas, copies that square out in the same task (the buffer is still
// valid then), and re-renders the normal frame before returning, so the screen never shows
// the thumbnail pass (photosafe: no one-frame flash). JPEG, because Safari's toBlob silently
// falls back to PNG for WebP.
export async function renderThumbnail(ctx, size = 256, { scene, camera, quality = 0.82 } = {}) {
  const { renderer } = ctx;
  const liveScene = ctx.scene, liveCam = ctx.camera;
  const shotScene = scene ?? liveScene, shotCam = camera ?? liveCam;
  const canvas = renderer.domElement;
  const pr = renderer.getPixelRatio();
  // Square side in CSS px: `size` device px, or as much as a small canvas allows.
  const side = Math.max(1, Math.floor(Math.min(size / pr, canvas.width / pr, canvas.height / pr)));
  const px = Math.max(1, Math.floor(side * pr));
  const cam = shotCam.clone();
  if (cam.isPerspectiveCamera) { cam.aspect = 1; cam.updateProjectionMatrix(); }

  const draw = (s, c) => (s.userData.renderSingleLayer ? s.userData.renderSingleLayer(renderer, s, c) : renderer.render(s, c));
  const vp = renderer.getViewport(new THREE.Vector4());
  const sc = renderer.getScissor(new THREE.Vector4());
  const scTest = renderer.getScissorTest();
  const out = document.createElement('canvas');
  out.width = out.height = size;
  try {
    renderer.setViewport(0, 0, side, side);
    renderer.setScissor(0, 0, side, side);
    renderer.setScissorTest(true);   // the clear stays inside the square too
    draw(shotScene, cam);
    // Viewport (0,0) is the bottom-left corner; canvas image rows start at the top.
    out.getContext('2d').drawImage(canvas, 0, canvas.height - px, px, px, 0, 0, size, size);
  } finally {
    renderer.setViewport(vp);
    renderer.setScissor(sc);
    renderer.setScissorTest(scTest);
    draw(liveScene, liveCam);
  }
  return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('thumbnail failed'))), 'image/jpeg', quality));
}

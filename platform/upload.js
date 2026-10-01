import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

export const MODEL_EXTS = ['glb', 'gltf', 'obj', 'ply'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
export const ACCEPT = '.glb,.gltf,.bin,.obj,.mtl,.ply,.json,.jpg,.jpeg,.png,.webp';

const extOf = (f) => (f.name.split('.').pop() || '').toLowerCase();
const stemOf = (n) => n.replace(/\.[^.]+$/, '').toLowerCase();
const baseOf = (p) => { try { p = decodeURIComponent(p); } catch { /* keep raw */ } return p.split(/[\\/]/).pop().toLowerCase(); };
const pathOf = (f) => f._path || f.webkitRelativePath || f.name;
const dirOf = (f) => pathOf(f).split('/').slice(0, -1).join('/');

// Pick the file with this basename, preferring one that sits in the same folder as `near`.
function findByBase(pool, base, near) {
  const hits = pool.filter((f) => f.name.toLowerCase() === base);
  return hits.find((f) => dirOf(f) === dirOf(near)) ?? hits[0] ?? null;
}

// Turns a flat pile of dropped files into items. One item per model (OBJ + its MTL + the
// textures the MTL names; .gltf + .bin + textures; GLB / PLY alone) and one per loose image
// (a photo). A `<model stem>.json` dropped alongside is the Track B completion sidecar.
// Returns { groups:[{kind, name, main, sidecars:[File], completionFile?:File}], ignored:[name] }.
export async function groupFiles(files) {
  const list = [...files];
  const of = (exts) => list.filter((f) => exts.includes(extOf(f)));
  const models = of(MODEL_EXTS);
  const mtls = of(['mtl']);
  const bins = of(['bin']);
  const images = of(IMAGE_EXTS);
  const jsons = of(['json']);
  const claimed = new Set();
  const groups = [];
  const nObj = models.filter((f) => extOf(f) === 'obj').length;

  for (const main of models) {
    const ext = extOf(main);
    const g = { kind: 'scan', name: main.name, main, sidecars: [] };
    if (ext === 'obj') {
      let mtl = mtls.find((f) => stemOf(f.name) === stemOf(main.name) && dirOf(f) === dirOf(main))
        ?? mtls.find((f) => stemOf(f.name) === stemOf(main.name))
        ?? (nObj === 1 && mtls.length === 1 ? mtls[0] : null);
      if (mtl) {
        g.sidecars.push(mtl); claimed.add(mtl);
        const text = await mtl.text();
        for (const line of text.split(/\r?\n/)) {
          if (!/^\s*(map_\w+|bump|disp|decal|refl)\b/i.test(line)) continue;
          const tok = line.trim().split(/\s+/).pop();
          const img = findByBase(images, baseOf(tok), main);
          if (img && !g.sidecars.includes(img)) { g.sidecars.push(img); claimed.add(img); }
        }
      }
    } else if (ext === 'gltf') {
      try {
        const json = JSON.parse(await main.text());
        const uris = [...(json.buffers ?? []), ...(json.images ?? [])].map((x) => x.uri).filter((u) => u && !u.startsWith('data:'));
        for (const u of uris) {
          const f = findByBase([...bins, ...images], baseOf(u), main);
          if (f && !g.sidecars.includes(f)) { g.sidecars.push(f); claimed.add(f); }
        }
      } catch { /* parseGroup reports the real error */ }
    }
    const side = jsons.find((f) => stemOf(f.name) === stemOf(main.name) && dirOf(f) === dirOf(main))
      ?? jsons.find((f) => stemOf(f.name) === stemOf(main.name));
    if (side && !claimed.has(side)) { g.completionFile = side; claimed.add(side); }
    groups.push(g);
  }
  for (const img of images) if (!claimed.has(img)) groups.push({ kind: 'photo', name: img.name, main: img, sidecars: [] });
  // Sidecars claimed by any model are not "ignored"; stray .mtl / .bin are.
  const ignored = list.filter((f) => !models.includes(f) && !claimed.has(f) && !images.includes(f)).map((f) => f.name);
  return { groups, ignored };
}

// Parses one scan group. Everything runs in the visitor's browser (File -> buffer -> parse).
// Sidecar files (textures, .bin) reach the loaders through LoadingManager.setURLModifier,
// which maps a relative filename to a blob: URL, so external textures load with no server.
export async function parseGroup(group) {
  const { main, sidecars } = group;
  const t0 = performance.now();
  const ext = extOf(main);
  const urls = new Map(); // basename -> blob URL
  for (const f of sidecars) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((u) => urls.get(baseOf(u)) ?? u);
  let started = false;
  const texturesDone = new Promise((res) => { manager.onLoad = res; setTimeout(res, 15000); });
  manager.onStart = () => { started = true; };

  let object;
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const data = ext === 'glb' ? await main.arrayBuffer() : await main.text();
      const gltf = await new Promise((res, rej) => new GLTFLoader(manager).parse(data, '', res, rej));
      object = gltf.scene;
    } else if (ext === 'obj') {
      const loader = new OBJLoader(manager);
      const mtl = sidecars.find((f) => extOf(f) === 'mtl');
      if (mtl) {
        try { loader.setMaterials(new MTLLoader(manager).parse(await mtl.text(), '')); } catch { /* falls back to default material */ }
      }
      object = loader.parse(await main.text());
    } else {
      const geo = new PLYLoader().parse(await main.arrayBuffer());
      if (geo.index) {
        if (!geo.attributes.normal) geo.computeVertexNormals();
        object = new THREE.Mesh(geo);
      } else object = new THREE.Points(geo);
    }
    if (started) await texturesDone;
  } catch (err) {
    const hint = ext === 'gltf' ? ' (a .gltf needs its .bin and textures dropped with it)' : '';
    throw new Error(`could not parse ${main.name}: ${err.message ?? err}${hint}`);
  } finally {
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000);
  }

  let meshes = 0;
  object.traverse((c) => {
    if (!c.isMesh) return;
    meshes++;
    if (!c.geometry.attributes.normal) c.geometry.computeVertexNormals();
  });
  if (!meshes && !object.isPoints) throw new Error(`${main.name} parsed but contains no geometry`);
  // Track B output: turn `usemtl inferred` groups into a per-triangle flag before anything
  // splits the mesh (segment.js / parts.js carry vertex attributes through, not groups).
  const completion = tagInferred(object);
  return { object, name: main.name, parseMs: performance.now() - t0, completion };
}

// Back-compat single-scan entry: first model in the pile.
export async function parseScanFiles(files) {
  const { groups } = await groupFiles(files);
  const g = groups.find((x) => x.kind === 'scan');
  if (!g) throw new Error(`unsupported file type (${[...files].map((f) => f.name).join(', ') || 'nothing'}) -- use .glb, .gltf, .obj or .ply`);
  return parseGroup(g);
}

// Recursively reads dropped folders. webkitGetAsEntry must be called synchronously inside the
// drop event, so callers pass the DataTransfer straight in and we snapshot entries first.
export async function filesFromDrop(dt) {
  const entries = [...(dt.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const readAll = (reader) => new Promise((res, rej) => {
    const acc = [];
    const next = () => reader.readEntries((b) => (b.length ? (acc.push(...b), next()) : res(acc)), rej);
    next();
  });
  async function walk(e) {
    if (e.isFile) {
      const f = await new Promise((res, rej) => e.file(res, rej));
      Object.defineProperty(f, '_path', { value: e.fullPath.replace(/^\//, '') });
      out.push(f);
    } else if (e.isDirectory) for (const c of await readAll(e.createReader())) await walk(c);
  }
  for (const e of entries) await walk(e);
  return out;
}

export function countTriangles(object) {
  let tris = 0, points = 0;
  object.traverse((c) => {
    const g = c.geometry;
    if (!g) return;
    if (c.isMesh) tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    else if (c.isPoints) points += g.attributes.position.count;
  });
  return { tris: Math.round(tris), points };
}

export async function sha256Hex(file) {
  try {
    const d = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

// ---- Track B completion output (P5: show what was filled in) ------------------------------
// The contract (plans/scan-completion/ROADMAP.md, "Output Contract"): one object per scan,
// its measured faces under material `scanned` and the filled-in faces under `inferred`, plus
// a JSON sidecar (<stem>.json: method, inferred_area_share, licence, ...).
//
//   tagInferred(object)      after parsing, before splitting. Every mesh with inferred faces
//                            gets a Float32 vertex attribute `inferred` (0/1, constant per
//                            triangle) and a single material (the scanned one) in place of
//                            the material array. Returns { isCompletion, inferredTris,
//                            totalTris, inferredArea, totalArea } (areas in model units^2).
//   separateInferred(root)   after splitting. Each mesh's inferred triangles move into a
//                            child mesh with userData.inferred = true (look.js draws it
//                            ghosted; the toggle hides it); a mesh that is ALL inferred is
//                            flagged itself. Every such mesh gets userData.inferredShare
//                            (area share, 0..1), which measurements.js reads for its
//                            "(includes inferred)" tag. The attribute is dropped afterwards.
//   readSidecar(text, name)  parses + normalises the sidecar; throws on malformed JSON.
//
// Why a flag and then a child mesh, not two materials on one mesh: the splitters drop
// geometry groups, and the display LOD / single-layer pre-pass (lod.js) only handle one
// material per mesh -- a material array silently loses the photosafe depth pre-pass. The
// scanned vertices are never moved or edited: the scanned part keeps exactly its measured
// triangles, the child holds exactly the inferred ones.

const COMPLETION_NAME = /^(scanned|inferred)$/i;
const isInferredMat = (m) => /^inferred$/i.test(m?.name ?? '');

function triArea(pos, a, b, c, va, vb, vc) {
  va.fromBufferAttribute(pos, a); vb.fromBufferAttribute(pos, b).sub(va); vc.fromBufferAttribute(pos, c).sub(va);
  return vb.cross(vc).length() / 2;
}

export function tagInferred(object) {
  const out = { isCompletion: false, inferredTris: 0, totalTris: 0, inferredArea: 0, totalArea: 0 };
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  object.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const mats = [mesh.material].flat();
    if (mats.some((m) => COMPLETION_NAME.test(m?.name ?? ''))) out.isCompletion = true;
    const anyInferred = mats.some(isInferredMat);
    let geo = mesh.geometry;
    const tris = Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3);
    out.totalTris += tris;
    // Which triangles are inferred? From groups (OBJ usemtl) or the mesh's only material (GLB primitive).
    const flags = new Uint8Array(tris);
    if (anyInferred) {
      if (Array.isArray(mesh.material) && geo.groups.length) {
        for (const g of geo.groups) {
          if (!isInferredMat(mesh.material[g.materialIndex])) continue;
          const end = Math.min(tris, Math.floor((g.start + g.count) / 3));
          for (let t = Math.floor(g.start / 3); t < end; t++) flags[t] = 1;
        }
      } else if (isInferredMat(mats[0])) flags.fill(1);
    }
    // Shared vertices can't carry a per-triangle flag: de-index when a mesh mixes both.
    if (geo.index && flags.includes(1) && flags.includes(0)) {
      const plain = geo.toNonIndexed();
      geo.dispose();
      mesh.geometry = geo = plain;
    }
    const pos = geo.attributes.position, idx = geo.index;
    const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    for (let t = 0; t < tris; t++) {
      const area = triArea(pos, vi(t, 0), vi(t, 1), vi(t, 2), va, vb, vc);
      out.totalArea += area;
      if (flags[t]) { out.inferredArea += area; out.inferredTris++; }
    }
    if (anyInferred) {
      const attr = new Float32Array(pos.count);
      for (let t = 0; t < tris; t++) if (flags[t]) for (let k = 0; k < 3; k++) attr[vi(t, k)] = 1;
      geo.setAttribute('inferred', new THREE.BufferAttribute(attr, 1));
    }
    if (Array.isArray(mesh.material)) {
      // One material from here on (the scanned one keeps its texture for the realism blend).
      mesh.material = mesh.material.find((m) => !isInferredMat(m)) ?? mesh.material[0];
      geo.clearGroups();
    }
  });
  return out;
}

// Copy triangles `tris` of an indexed or non-indexed geometry into a compact new one
// (only the vertices those triangles use, so bounding boxes and measurements see exactly them).
function subset(geo, tris) {
  const idx = geo.index;
  const remap = new Map(), src = [];
  const index = new Uint32Array(tris.length * 3);
  let q = 0;
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const old = idx ? idx.getX(t * 3 + k) : t * 3 + k;
    let n = remap.get(old);
    if (n === undefined) { n = src.length; remap.set(old, n); src.push(old); }
    index[q++] = n;
  }
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) {
    if (name === 'inferred') continue;
    const s = a.itemSize, arr = new Float32Array(src.length * s);
    const get = [a.getX, a.getY, a.getZ, a.getW].slice(0, s).map((f) => f.bind(a));   // interleaved-safe
    for (let i = 0; i < src.length; i++) for (let c = 0; c < s; c++) arr[i * s + c] = get[c](src[i]);
    g.setAttribute(name, new THREE.BufferAttribute(arr, s, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute(src.length > 65535 ? index : Uint16Array.from(index), 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Inferred patches are often their own connected pieces, so they become selectable parts.
// "As scanned" hides them by material (look.js), which Raycaster ignores -- without this an
// invisible patch could still be hovered, clicked and dragged.
function raycastWhenDrawn(raycaster, hits) {
  const m = this.material;
  if (m && !Array.isArray(m) && m.visible === false) return;
  THREE.Mesh.prototype.raycast.call(this, raycaster, hits);
}

export function separateInferred(root) {
  const stats = { meshesWithInferred: 0, wholeInferred: 0, inferredTris: 0 };
  const meshes = [];
  root.traverse((c) => { if (c.isMesh && c.geometry.attributes.inferred) meshes.push(c); });
  const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
  for (const mesh of meshes) {
    const geo = mesh.geometry, flag = geo.attributes.inferred, pos = geo.attributes.position, idx = geo.index;
    const tris = Math.floor((idx ? idx.count : pos.count) / 3);
    const vi = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    const scanned = [], inferred = [];
    let aS = 0, aI = 0;
    for (let t = 0; t < tris; t++) {
      const area = triArea(pos, vi(t, 0), vi(t, 1), vi(t, 2), va, vb, vc);
      if (flag.getX(vi(t, 0)) > 0.5) { inferred.push(t); aI += area; } else { scanned.push(t); aS += area; }
    }
    geo.deleteAttribute('inferred');
    if (!inferred.length) continue;
    stats.meshesWithInferred++;
    stats.inferredTris += inferred.length;
    if (!scanned.length) {
      mesh.userData.inferred = true;
      mesh.raycast = raycastWhenDrawn;
      mesh.userData.inferredShare = 1;
      stats.wholeInferred++;
      continue;
    }
    const child = new THREE.Mesh(subset(geo, inferred), mesh.material);
    mesh.geometry = subset(geo, scanned);
    geo.dispose();
    child.name = `${mesh.name || 'mesh'}:inferred`;
    child.userData.inferred = true;
    child.userData.inferredShare = 1;
    child.raycast = raycastWhenDrawn;
    mesh.userData.inferredShare = aI / (aI + aS);
    mesh.add(child);   // identity transform: moves, rotates and hides with its part
  }
  return stats;
}

export function readSidecar(text, name = 'sidecar') {
  let j;
  try { j = JSON.parse(text); } catch (err) { throw new Error(`${name}: not valid JSON (${err.message})`); }
  if (!j || typeof j !== 'object') throw new Error(`${name}: expected a JSON object`);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  let share = num(j.inferred_area_share ?? j.inferredAreaShare);
  if (share != null && (share < 0 || share > 1)) share = null;
  const str = (v) => (v == null ? null : String(v));
  return {
    fileName: name, method: str(j.method ?? j.tier), mode: str(j.mode), licence: str(j.licence ?? j.license),
    source: str(j.source), inferredShare: share, inferredFaces: num(j.inferred_faces), totalFaces: num(j.total_faces),
    seconds: num(j.seconds)
  };
}

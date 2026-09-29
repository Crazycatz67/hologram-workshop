import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

export const MODEL_EXTS = ['glb', 'gltf', 'obj', 'ply'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
export const ACCEPT = '.glb,.gltf,.bin,.obj,.mtl,.ply,.jpg,.jpeg,.png,.webp';

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
// (a photo). Returns { groups:[{kind, name, main, sidecars:[File]}], ignored:[name] }.
export async function groupFiles(files) {
  const list = [...files];
  const of = (exts) => list.filter((f) => exts.includes(extOf(f)));
  const models = of(MODEL_EXTS);
  const mtls = of(['mtl']);
  const bins = of(['bin']);
  const images = of(IMAGE_EXTS);
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
  return { object, name: main.name, parseMs: performance.now() - t0 };
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

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

const EXTS = ['glb', 'gltf', 'obj', 'ply'];
const extOf = (f) => f.name.split('.').pop().toLowerCase();

// Everything runs in the visitor's browser: File -> ArrayBuffer/text -> parse. Nothing is
// sent anywhere, which matters for scans of people's homes.
// `files` is a FileList/array; a .mtl dropped beside an .obj is used as its material.
export async function parseScanFiles(files) {
  const list = [...files];
  const main = list.find((f) => EXTS.includes(extOf(f)));
  if (!main) {
    const got = list.map((f) => f.name).join(', ') || 'nothing';
    throw new Error(`unsupported file type (${got}) -- use .glb, .gltf, .obj or .ply`);
  }
  const t0 = performance.now();
  const ext = extOf(main);
  let object;
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const buf = await main.arrayBuffer();
      // Path '' so a self-contained .gltf works; one that points at an external .bin will
      // fail here, and the error below says so.
      const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
      object = gltf.scene;
    } else if (ext === 'obj') {
      const loader = new OBJLoader();
      const mtl = list.find((f) => extOf(f) === 'mtl');
      if (mtl) {
        try { loader.setMaterials(new MTLLoader().parse(await mtl.text(), '')); } catch { /* material is replaced anyway */ }
      }
      object = loader.parse(await main.text());
    } else {
      const geo = new PLYLoader().parse(await main.arrayBuffer());
      // PLYLoader sets an index only when the file has faces, so no index = point cloud.
      if (geo.index) {
        if (!geo.attributes.normal) geo.computeVertexNormals();
        object = new THREE.Mesh(geo);
      } else {
        object = new THREE.Points(geo);
      }
    }
  } catch (err) {
    const hint = ext === 'gltf' ? ' (a .gltf with external .bin/textures cannot load -- export as .glb)' : '';
    throw new Error(`could not parse ${main.name}: ${err.message ?? err}${hint}`);
  }

  let meshes = 0;
  object.traverse((c) => {
    if (!c.isMesh) return;
    meshes++;
    // HolographicMaterial's fresnel needs normals; OBJs from some exporters have none.
    if (!c.geometry.attributes.normal) c.geometry.computeVertexNormals();
  });
  if (!meshes && !object.isPoints) throw new Error(`${main.name} parsed but contains no geometry`);

  return { object, name: main.name, parseMs: performance.now() - t0 };
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

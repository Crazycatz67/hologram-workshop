import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

function loadGLB(path) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(path, (gltf) => resolve(gltf.scene), undefined, reject);
  });
}

function loadOBJ(objPath, mtlPath) {
  return new Promise((resolve, reject) => {
    // No MTL is a normal case, not a degraded one: clean_scan.py writes plain geometry
    // with no material, because every page here replaces the material with the hologram
    // shader anyway. Asking MTLLoader for a file that was never written would just 404.
    if (!mtlPath) {
      new OBJLoader().load(objPath, resolve, undefined, reject);
      return;
    }
    new MTLLoader().load(
      mtlPath,
      (materials) => {
        materials.preload();
        new OBJLoader().setMaterials(materials).load(objPath, resolve, undefined, reject);
      },
      undefined,
      reject
    );
  });
}

// Scaniverse can export either format, and clean_scan.py writes OBJ, so try whichever
// paths were actually given — GLB first when there is one. Failures are reported
// together, otherwise the OBJ error masks the GLB one and the message points at the
// wrong file.
export async function loadModel({ glbPath, objPath, mtlPath }) {
  let glbError;
  if (glbPath) {
    try {
      return { object: await loadGLB(glbPath), path: glbPath };
    } catch (err) {
      glbError = err;
    }
  }

  try {
    return { object: await loadOBJ(objPath, mtlPath), path: objPath };
  } catch (objError) {
    if (glbPath) console.error(`${glbPath} failed:`, glbError);
    console.error(`${objPath} failed:`, objError);
    throw new Error(`no model found — tried ${[glbPath, objPath].filter(Boolean).join(' and ')}`);
  }
}

// Centers the object on the origin so later gesture rotation/scaling pivots on the
// object itself, then pulls the camera back far enough to fit it in frame.
export function frameObject(object, camera, controls) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  object.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fitDist = (maxDim / 2) / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.6;

  camera.position.set(0, maxDim * 0.2, fitDist);
  camera.near = fitDist / 100;
  camera.far = fitDist * 100;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.minDistance = maxDim * 0.2;
  controls.maxDistance = fitDist * 4;
  controls.update();

  return { size, maxDim };
}

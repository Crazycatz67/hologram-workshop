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

// Scaniverse can export either format, so try GLB first and fall back to OBJ+MTL.
// Both failures are reported together — otherwise the OBJ error masks the GLB one and
// the message points at the wrong file.
export async function loadModel({ glbPath, objPath, mtlPath }) {
  let glbError;
  try {
    return { object: await loadGLB(glbPath), path: glbPath };
  } catch (err) {
    glbError = err;
  }

  try {
    return { object: await loadOBJ(objPath, mtlPath), path: objPath };
  } catch (objError) {
    console.error(`${glbPath} failed:`, glbError);
    console.error(`${objPath} failed:`, objError);
    throw new Error(`no model found — tried ${glbPath} and ${objPath}`);
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

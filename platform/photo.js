// photo.js -- turn a dropped PHOTO into a FLAT 2.5D relief preview, entirely in the browser.
// It is not a 3D object: one depth map pushed out of the picture plane, no sides, no back.
// Real 3D from a photo is the Mac tool completion/photo3d.py (TripoSR), whose output loads
// as a completed scan with every surface marked inferred. Owner decision 2026-10-01: label
// this result so it is never mistaken for a scan or for 3D (FLAT_PREVIEW below).
// No server, no account, free. The image never leaves the visitor's machine (only the model
// weights are downloaded, once, from the Hugging Face CDN, then cached by the browser).
//
// Sources used / verified:
//  - Model: onnx-community/depth-anything-v2-small (ONNX port of depth-anything/Depth-Anything-V2-Small).
//    Verified with the HF API: public, ungated, licence apache-2.0 (Small is the only Apache-2.0
//    Depth Anything V2 size; Base/Large/Giant are CC-BY-NC). HF card points to a newer
//    "-ONNX" repo; this id still works and is what the Transformers.js docs use.
//  - Runtime: @huggingface/transformers 4.3.0 (Apache-2.0), pinned, from jsDelivr.
//    pipeline('depth-estimation', ...) with device 'webgpu', falling back to 'wasm'.
//    Weights: fp32 (~99 MB) on WebGPU, 8-bit quantised (~27 MB) on WASM.
//  - three r161: vertex colours are read as LINEAR by the shader, so photo sRGB is converted
//    to linear here (otherwise the result looks washed out).
//
// Depth choice: Depth Anything V2 outputs RELATIVE INVERSE DEPTH (disparity: bigger = nearer),
// with unknown scale/shift. We normalise it to 0..1 with a 2nd..98th percentile stretch, and map
// it to a relief depth of RELIEF (0.35) x the image width: enough to read as 3D from the side,
// not so much that a face becomes a snout. It is an artistic bound, not a measurement.
// Size: the longest image side maps to 1.0 m (there is no scale information in a photo);
// stated in mesh.userData.sizeNote. Front surface only; the back is empty.

import * as THREE from 'three';

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0';
const MODEL_ID = 'onnx-community/depth-anything-v2-small';
const MAX_SIDE = 256;        // grid resolution on the long side (triangle budget ~130k max)
const RELIEF = 0.35;         // relief depth as a fraction of image width
const EDGE_CUT = 0.10;       // drop quads whose normalised depth range exceeds this (silhouettes)
const BG_CUT = 0.04;         // drop the farthest pixels (normalised depth below this)
const LONGEST_M = 1.0;

// What the UI shows for a photo result. Consumers read mesh.userData.flatPreview /
// .label / .badge / .hint (measurements.js already shows userData.label as the part name).
export const FLAT_PREVIEW = Object.freeze({
  label: 'Flat photo preview (2.5D)',
  badge: '2.5D preview',
  hint: 'Flat photo preview (2.5D) \u2014 for real 3D run completion/photo3d.py'
});

let pipePromise = null;
let pipeDevice = null;
let lastModelMs = 0;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function report(cb, stage, progress, message) {
  try { cb?.({ stage, progress: clamp01(progress), message }); } catch { /* UI errors must not break us */ }
}

async function getPipeline(onProgress) {
  if (pipePromise) return pipePromise;
  pipePromise = (async () => {
    const t0 = performance.now();
    report(onProgress, 'model', 0, 'loading depth model');
    const { pipeline, env } = await import(/* @vite-ignore */ TRANSFORMERS_URL);
    env.allowLocalModels = false;
    const files = {};
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.file) {
        files[p.file] = p;
        const list = Object.values(files);
        const loaded = list.reduce((a, f) => a + (f.loaded || 0), 0);
        const total = list.reduce((a, f) => a + (f.total || 0), 0) || 1;
        report(onProgress, 'model', loaded / total, `downloading depth model ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
      }
    };
    let pipe;
    let hasGpu = false;
    try { hasGpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch { /* none */ }
    if (hasGpu) {
      try {
        pipe = await pipeline('depth-estimation', MODEL_ID, { device: 'webgpu', dtype: 'fp32', progress_callback });
        pipeDevice = 'webgpu';
      } catch (e) {
        console.warn('[photo] WebGPU failed, falling back to WASM:', e);
      }
    }
    if (!pipe) {
      pipe = await pipeline('depth-estimation', MODEL_ID, { device: 'wasm', dtype: 'q8', progress_callback });
      pipeDevice = 'wasm';
    }
    lastModelMs = performance.now() - t0;
    report(onProgress, 'model', 1, `depth model ready (${pipeDevice})`);
    return pipe;
  })();
  pipePromise.catch(() => { pipePromise = null; }); // allow retry after a failed download
  return pipePromise;
}

async function decode(file) {
  const name = (file?.name || '').toLowerCase();
  if (/\.(heic|heif)$/.test(name) || /image\/hei[cf]/.test(file?.type || '')) {
    throw new Error('HEIC/HEIF photos cannot be read by most browsers -- please export or convert it to JPG or PNG and drop it again.');
  }
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`could not read ${file?.name || 'that file'} as an image -- use a JPG, PNG or WebP photo.`);
  }
}

// sRGB byte -> linear float lookup
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export async function photoToMesh(file, { onProgress } = {}) {
  const bmp = await decode(file);
  const pipe = await getPipeline(onProgress);

  // Orientation-corrected copy as a blob URL for the pipeline (EXIF already applied by bitmap).
  report(onProgress, 'depth', 0, 'estimating depth');
  const tDepth = performance.now();
  const full = document.createElement('canvas');
  full.width = bmp.width; full.height = bmp.height;
  full.getContext('2d').drawImage(bmp, 0, 0);
  const blob = await new Promise((res) => full.toBlob(res, 'image/png'));
  const url = URL.createObjectURL(blob);
  let depthImg;
  try {
    const out = await pipe(url);
    depthImg = out.depth; // RawImage, 1 channel uint8, same size as input
  } finally { URL.revokeObjectURL(url); }
  const depthMs = performance.now() - tDepth;
  report(onProgress, 'depth', 1, `depth done in ${(depthMs / 1000).toFixed(1)} s`);

  report(onProgress, 'mesh', 0, 'building mesh');
  const tMesh = performance.now();
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const W = Math.max(2, Math.round(bmp.width * scale));
  const H = Math.max(2, Math.round(bmp.height * scale));

  // Colour + alpha at grid resolution.
  const cc = document.createElement('canvas');
  cc.width = W; cc.height = H;
  const cx = cc.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, W, H);
  const px = cx.getImageData(0, 0, W, H).data;

  // Depth resampled (bilinear) to the grid.
  const dw = depthImg.width, dh = depthImg.height, dch = depthImg.channels || 1, dd = depthImg.data;
  const raw = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const fy = (j / (H - 1)) * (dh - 1), y0 = Math.floor(fy), y1 = Math.min(dh - 1, y0 + 1), ty = fy - y0;
    for (let i = 0; i < W; i++) {
      const fx = (i / (W - 1)) * (dw - 1), x0 = Math.floor(fx), x1 = Math.min(dw - 1, x0 + 1), tx = fx - x0;
      const a = dd[(y0 * dw + x0) * dch], b = dd[(y0 * dw + x1) * dch];
      const c = dd[(y1 * dw + x0) * dch], d = dd[(y1 * dw + x1) * dch];
      raw[j * W + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  // Light 3x3 box blur to calm 8-bit banding.
  const blur = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let s = 0, n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di, y = j + dj;
      if (x >= 0 && y >= 0 && x < W && y < H) { s += raw[y * W + x]; n++; }
    }
    blur[j * W + i] = s / n;
  }
  // Percentile stretch (2%..98%) over opaque pixels -> 0 (far) .. 1 (near).
  const vals = [];
  for (let k = 0; k < W * H; k++) if (px[k * 4 + 3] > 127) vals.push(blur[k]);
  if (vals.length < 16) throw new Error('image is (almost) fully transparent');
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)];
  const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))];
  const span = Math.max(1e-6, hi - lo);
  const nd = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) nd[k] = clamp01((blur[k] - lo) / span);

  // Which pixels exist: opaque and not the far background.
  const keep = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) keep[k] = px[k * 4 + 3] > 127 && nd[k] >= BG_CUT ? 1 : 0;

  // Quads -> triangles, dropping any across a depth discontinuity or missing a corner.
  const idxList = [];
  const used = new Int32Array(W * H).fill(-1);
  let nv = 0;
  const use = (k) => (used[k] < 0 ? (used[k] = nv++) : used[k]);
  for (let j = 0; j < H - 1; j++) for (let i = 0; i < W - 1; i++) {
    const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
    if (!(keep[a] && keep[b] && keep[c] && keep[d])) continue;
    const mn = Math.min(nd[a], nd[b], nd[c], nd[d]), mx = Math.max(nd[a], nd[b], nd[c], nd[d]);
    if (mx - mn > EDGE_CUT) continue;
    idxList.push(use(a), use(c), use(b), use(b), use(c), use(d)); // CCW seen from +Z
  }
  if (!idxList.length) throw new Error('could not build a surface from this photo (no usable depth)');

  const longest = Math.max(W, H) - 1;
  const unit = LONGEST_M / longest;           // metres per grid step
  const widthM = (W - 1) * unit;
  const reliefM = RELIEF * widthM;
  const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  let minY = Infinity;
  for (let k = 0; k < W * H; k++) {
    const v = used[k];
    if (v < 0) continue;
    const i = k % W, j = (k / W) | 0;
    const y = (H - 1 - j) * unit;
    pos[v * 3] = (i - (W - 1) / 2) * unit;
    pos[v * 3 + 1] = y;
    pos[v * 3 + 2] = nd[k] * reliefM;
    if (y < minY) minY = y;
    col[v * 3] = LIN[px[k * 4]]; col[v * 3 + 1] = LIN[px[k * 4 + 1]]; col[v * 3 + 2] = LIN[px[k * 4 + 2]];
    uv[v * 2] = i / (W - 1); uv[v * 2 + 1] = 1 - j / (H - 1);
  }
  for (let v = 0; v < nv; v++) pos[v * 3 + 1] -= minY; // bottom at y = 0

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(idxList) : new Uint16Array(idxList), 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox(); geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = file.name || 'photo';
  const meshMs = performance.now() - tMesh;
  mesh.userData.original = mat;
  mesh.userData.kind = 'photo-relief';
  mesh.userData.flatPreview = true;
  mesh.userData.label = FLAT_PREVIEW.label;
  mesh.userData.badge = FLAT_PREVIEW.badge;
  mesh.userData.hint = FLAT_PREVIEW.hint;
  mesh.userData.provenance = {
    method: 'flat 2.5D preview: monocular depth (Depth Anything V2 small)',
    note: 'not a scan and not 3D: front surface only; depth is estimated, not measured; no sides or back. ' +
      'For real 3D run completion/photo3d.py',
  };
  mesh.userData.sizeNote = `photo has no real scale: longest side set to ${LONGEST_M} m, relief depth ${Math.round(RELIEF * 100)}% of width`;
  mesh.userData.device = pipeDevice;
  mesh.userData.timings = { modelMs: lastModelMs, depthMs, meshMs };
  mesh.userData.source = { width: bmp.width, height: bmp.height, grid: [W, H] };
  report(onProgress, 'mesh', 1, `${FLAT_PREVIEW.label}: ${idxList.length / 3} triangles`);
  bmp.close?.();
  return mesh;
}

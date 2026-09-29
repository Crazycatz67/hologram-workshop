import * as THREE from 'three';

// Part splitter: cuts ONE connected object (a chair) into its physical parts (seat, backrest,
// legs, runners, posts). A browser port of completion/parts_proto.py, which is the reference
// (its output on assets/chair/chair_clean.obj is the known-good answer). Same steps, same
// defaults, in the same order:
//
//   1. thickness: probe inward from each vertex until the far side of the object is hit
//      (a poor man's shape diameter), smoothed by a 5 cm median, split thin/thick by Otsu;
//   2. local shape: eigenvalues of the 3.5 cm neighbourhood's point spread say tube (one
//      long axis), panel (two) or joint (none); thick vertices are "body";
//   3. seeded region growth: tubes against the region's MEAN axis (a bent tube splits at the
//      bend), panels against the neighbour (a curved panel stays whole), bodies freely;
//      joints are absorbed breadth-first afterwards;
//   4. clean-up: tiny regions merge into the neighbour they share most edges with, patches
//      mostly surrounded by one neighbour are absorbed, and neighbouring non-tube regions
//      whose union is still one flat sheet are merged.
//
// No dependencies beyond three (only for splitMeshIntoParts): spatial queries use a uniform
// hash grid, the 3x3 eigenproblems use Jacobi rotations, and sampling uses a seeded PRNG so
// a given mesh always splits the same way. Synchronous; a Worker wrapper comes later.

export const PART_DEFAULTS = {
  radius: 0.035,       // m, neighbourhood for the tube/panel/joint descriptor
  angle: 25,           // degrees a region may turn before growth stops
  minShare: 0.01,      // regions under 1% of the surface area are merged away
  thickMax: 0.20,      // m, thickness probe: furthest probe depth
  thickStep: 0.004,    // m, probe step (first probe at 3 steps)
  thickHit: 0.004,     // m, a surface sample this close to the probe point is a hit
  samples: 300000,     // surface samples the probes look for
  smoothRadius: 0.05,  // m, median smoothing of log-thickness
  flatRatio: 0.06,     // union of two regions is "one flat panel" if lam3/lam2 < this
  islandShare: 0.70,   // a region with >= 70% of its border on one neighbour is absorbed
  // Kept for API compatibility only: sampling is now a deterministic lattice (see the
  // thickness section), so results no longer depend on a seed.
  seed: 0,
  weld: 0.001,         // m, splitMeshIntoParts only: vertex weld quantum (as segment.js)
  proxyTarget: 40000,  // splitMeshIntoParts only: analyse denser meshes on a ~40k-vertex proxy
};

export const KINDS = ['tube', 'panel', 'joint', 'body'];
const TUBE = 0, PANEL = 1, JOINT = 2, BODY = 3;

// ---------------------------------------------------------------- small utilities

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform grid over points, cells hashed into a power-of-two table (works for a chair or a
// whole room without allocating the full 3D array). Hash collisions only add candidates;
// every query checks real distances.
class HashGrid {
  constructor(pts, count, cell) {
    this.pts = pts; this.cell = cell; this.inv = 1 / cell;
    let size = 1024; while (size < count * 2) size <<= 1;
    this.mask = size - 1;
    const start = new Int32Array(size + 1);
    const key = new Int32Array(count);
    const inv = this.inv;
    for (let i = 0; i < count; i++) {
      const h = this.hash(Math.floor(pts[3 * i] * inv), Math.floor(pts[3 * i + 1] * inv), Math.floor(pts[3 * i + 2] * inv));
      key[i] = h; start[h + 1]++;
    }
    for (let h = 0; h < size; h++) start[h + 1] += start[h];
    const fill = start.slice(0, size);
    const order = new Int32Array(count);
    for (let i = 0; i < count; i++) order[fill[key[i]]++] = i;
    this.start = start; this.order = order;
    this.hbuf = new Int32Array(8);
  }
  hash(ix, iy, iz) {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & this.mask;
  }
  // Distinct buckets covering the box [q-r, q+r]. With cell >= r this is at most 8 cells.
  buckets(x, y, z, r) {
    const inv = this.inv, hb = this.hbuf;
    const x0 = Math.floor((x - r) * inv), x1 = Math.floor((x + r) * inv);
    const y0 = Math.floor((y - r) * inv), y1 = Math.floor((y + r) * inv);
    const z0 = Math.floor((z - r) * inv), z1 = Math.floor((z + r) * inv);
    let n = 0;
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
      const h = this.hash(ix, iy, iz);
      let dup = false;
      for (let k = 0; k < n; k++) if (hb[k] === h) { dup = true; break; }
      if (!dup) {
        if (n === hb.length) { const nb = new Int32Array(n * 2); nb.set(hb); this.hbuf = nb; return this.buckets(x, y, z, r); }
        hb[n++] = h;
      }
    }
    return n;
  }
  // Indices of points within r (inclusive, like cKDTree.query_ball_point) into out; returns count.
  ball(x, y, z, r, out) {
    const nb = this.buckets(x, y, z, r), hb = this.hbuf, P = this.pts, r2 = r * r;
    let n = 0;
    for (let b = 0; b < nb; b++) {
      const h = hb[b];
      for (let k = this.start[h], e = this.start[h + 1]; k < e; k++) {
        const i = this.order[k];
        const dx = P[3 * i] - x, dy = P[3 * i + 1] - y, dz = P[3 * i + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= r2) out[n++] = i;
      }
    }
    return n;
  }
  // Nearest point strictly closer than r, or -1.
  nearestWithin(x, y, z, r) {
    const nb = this.buckets(x, y, z, r), hb = this.hbuf, P = this.pts;
    let best = -1, bd = r * r;
    for (let b = 0; b < nb; b++) {
      const h = hb[b];
      for (let k = this.start[h], e = this.start[h + 1]; k < e; k++) {
        const i = this.order[k];
        const dx = P[3 * i] - x, dy = P[3 * i + 1] - y, dz = P[3 * i + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }
  // Nearest point, unbounded: expanding shells of cells. Anything outside shell r is at
  // least r*cell away, so stop once the best found is that close.
  nearest(x, y, z) {
    const inv = this.inv, P = this.pts;
    const cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
    let best = -1, bd = Infinity;
    for (let r = 0; r < 256; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const h = this.hash(cx + dx, cy + dy, cz + dz);
        for (let k = this.start[h], e = this.start[h + 1]; k < e; k++) {
          const i = this.order[k];
          const ex = P[3 * i] - x, ey = P[3 * i + 1] - y, ez = P[3 * i + 2] - z;
          const d = ex * ex + ey * ey + ez * ez;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 && Math.sqrt(bd) <= r * this.cell) break;
    }
    return best;
  }
}

// Symmetric 3x3 eigen-decomposition by cyclic Jacobi. A = [a00,a01,a02,a11,a12,a22].
// Writes eigenvalues ascending into w[0..2] and eigenvector k into V[3k..3k+2].
const _A = new Float64Array(9), _V = new Float64Array(9), _ord = [0, 1, 2];
function eigSym3(a00, a01, a02, a11, a12, a22, w, V) {
  const A = _A, Q = _V;
  A[0] = a00; A[1] = a01; A[2] = a02; A[3] = a01; A[4] = a11; A[5] = a12; A[6] = a02; A[7] = a12; A[8] = a22;
  Q.fill(0); Q[0] = Q[4] = Q[8] = 1;
  const scale = Math.abs(a00) + Math.abs(a11) + Math.abs(a22) + 1e-300;
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]);
    if (off <= 1e-15 * scale) break;
    for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
      const apq = A[3 * p + q];
      if (Math.abs(apq) <= 1e-18 * scale) continue;
      const theta = (A[3 * q + q] - A[3 * p + p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A <- A P
        const akp = A[3 * k + p], akq = A[3 * k + q];
        A[3 * k + p] = c * akp - s * akq; A[3 * k + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // A <- P^T A
        const apk = A[3 * p + k], aqk = A[3 * q + k];
        A[3 * p + k] = c * apk - s * aqk; A[3 * q + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) { // V <- V P  (columns are eigenvectors)
        const vkp = Q[3 * k + p], vkq = Q[3 * k + q];
        Q[3 * k + p] = c * vkp - s * vkq; Q[3 * k + q] = s * vkp + c * vkq;
      }
    }
  }
  const d = [A[0], A[4], A[8]];
  const o = _ord; o[0] = 0; o[1] = 1; o[2] = 2;
  o.sort((i, j) => d[i] - d[j]);
  for (let k = 0; k < 3; k++) {
    const c = o[k];
    w[k] = d[c];
    if (V) { V[3 * k] = Q[c]; V[3 * k + 1] = Q[3 + c]; V[3 * k + 2] = Q[6 + c]; }
  }
}

// k-th smallest of a[0..n) (in place, Hoare quickselect).
function select(a, n, k) {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}
function median(a, n) {
  if (n === 0) return NaN;
  const hi = select(a, n, n >> 1);
  if (n & 1) return hi;
  let lo = -Infinity; // largest of the lower half (select partitioned a around n>>1)
  for (let i = 0; i < (n >> 1); i++) if (a[i] > lo) lo = a[i];
  return (lo + hi) / 2;
}

function otsu(x) {
  let lo = Infinity, hi = -Infinity;
  for (const v of x) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) return lo;
  const B = 64, h = new Float64Array(B), w = (hi - lo) / B;
  for (const v of x) if (Number.isFinite(v)) h[Math.min(B - 1, Math.floor((v - lo) / w))]++;
  const c = new Float64Array(B); for (let i = 0; i < B; i++) c[i] = lo + (i + 0.5) * w;
  const w0 = new Float64Array(B), m0 = new Float64Array(B);
  let sw = 0, sm = 0;
  for (let i = 0; i < B; i++) { sw += h[i]; sm += h[i] * c[i]; w0[i] = sw; m0[i] = sm; }
  const tot = sw, mt = sm;
  let best = -Infinity, bi = 0;
  for (let i = 0; i < B; i++) {
    const w1 = tot - w0[i];
    const between = (mt * w0[i] / tot - m0[i]) ** 2 / (w0[i] * w1);
    if (Number.isFinite(between) && between > best) { best = between; bi = i; }
  }
  return c[bi];
}

// Binary min-heap of (key, id), ties by smaller id.
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  less(i, j) { return this.k[i] < this.k[j] || (this.k[i] === this.k[j] && this.v[i] < this.v[j]); }
  swap(i, j) { [this.k[i], this.k[j]] = [this.k[j], this.k[i]]; [this.v[i], this.v[j]] = [this.v[j], this.v[i]]; }
  push(key, id) {
    this.k.push(key); this.v.push(id);
    let i = this.k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  pop() {
    const key = this.k[0], id = this.v[0], lk = this.k.pop(), lv = this.v.pop();
    if (this.k.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0; const n = this.k.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < n && this.less(l, m)) m = l;
        if (r < n && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return [key, id];
  }
}

// ---------------------------------------------------------------- the splitter

export function splitParts(positions, index, opts = {}) {
  const o = { ...PART_DEFAULTS, ...opts };
  const T = {}; let tick = performance.now(); const t0 = tick;
  const lap = (name) => { const now = performance.now(); T[name] = +(now - tick).toFixed(1); tick = now; };
  const P = positions, nv = (P.length / 3) | 0, nf = (index.length / 3) | 0, F = index;

  // --- mesh topology: unique undirected edges (as the prototype), CSR adjacency with each
  // vertex's neighbours in ascending order, which is also the prototype's BFS order.
  const ekeys = new Float64Array(nf * 3); let ne = 0;
  for (let t = 0; t < nf; t++) for (let k = 0; k < 3; k++) {
    const a = F[3 * t + k], b = F[3 * t + (k + 1) % 3];
    if (a !== b) ekeys[ne++] = a < b ? a * nv + b : b * nv + a;
  }
  const sorted = ekeys.subarray(0, ne).sort();
  let nu = 0;
  for (let i = 0; i < ne; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[nu++] = sorted[i];
  const EA = new Int32Array(nu), EB = new Int32Array(nu);
  const deg = new Int32Array(nv + 1);
  for (let i = 0; i < nu; i++) {
    const a = Math.floor(sorted[i] / nv), b = sorted[i] - a * nv;
    EA[i] = a; EB[i] = b; deg[a + 1]++; deg[b + 1]++;
  }
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const adj = new Int32Array(2 * nu), cur = deg.slice(0, nv);
  for (let i = 0; i < nu; i++) { adj[cur[EA[i]]++] = EB[i]; adj[cur[EB[i]]++] = EA[i]; }

  // --- area-weighted vertex normals, per-vertex area (a third of each face)
  const vn = new Float64Array(nv * 3), varea = new Float64Array(nv), farea = new Float64Array(nf);
  let totalArea = 0;
  for (let t = 0; t < nf; t++) {
    const a = 3 * F[3 * t], b = 3 * F[3 * t + 1], c = 3 * F[3 * t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const area = Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    farea[t] = area; totalArea += area;
    // unit normal * area = cross / 2
    for (const v of [a, b, c]) { vn[v] += cx / 2; vn[v + 1] += cy / 2; vn[v + 2] += cz / 2; varea[v / 3] += area / 3; }
  }
  for (let i = 0; i < nv; i++) {
    const l = Math.max(Math.hypot(vn[3 * i], vn[3 * i + 1], vn[3 * i + 2]), 1e-12);
    vn[3 * i] /= l; vn[3 * i + 1] /= l; vn[3 * i + 2] /= l;
  }
  lap('topology');

  // --- thickness: surface samples on a DETERMINISTIC barycentric lattice per triangle, no
  // random numbers. Random samples made borderline vertices flip thin/thick between runs, so
  // a region sitting near minShare appeared or vanished by seed (8-10 chair parts across
  // seeds, 2026-09-29). Lattice spacing <= thickHit, so every probe that lands on the surface
  // finds a sample, and the same mesh always gives the same parts. Each sample's normal is
  // its nearest vertex's normal (computed lazily, only for samples a probe actually hits).
  const spacing = o.thickHit;
  const lat = new Int32Array(nf);
  let NS = 0;
  for (let t = 0; t < nf; t++) {
    const a = 3 * F[3 * t], b = 3 * F[3 * t + 1], c = 3 * F[3 * t + 2];
    const e = Math.max(
      Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]),
      Math.hypot(P[b] - P[c], P[b + 1] - P[c + 1], P[b + 2] - P[c + 2]),
      Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]));
    lat[t] = Math.max(1, Math.ceil(e / spacing));
    NS += ((lat[t] + 1) * (lat[t] + 2)) / 2;
  }
  const S = new Float32Array(NS * 3);
  for (let t = 0, i = 0; t < nf; t++) {
    const n = lat[t], a = 3 * F[3 * t], b = 3 * F[3 * t + 1], c = 3 * F[3 * t + 2];
    for (let p = 0; p <= n; p++) for (let q = 0; p + q <= n; q++, i++) {
      const wb = p / n, wc = q / n, wa = 1 - wb - wc;
      for (let k = 0; k < 3; k++) S[3 * i + k] = wa * P[a + k] + wb * P[b + k] + wc * P[c + k];
    }
  }
  lap('sampling');
  const sGrid = new HashGrid(S, NS, o.thickHit);
  const nGrid = new HashGrid(P, nv, Math.max(o.thickHit * 2, 0.01));
  const sNear = new Int32Array(NS).fill(-1);
  const thick = new Float64Array(nv).fill(NaN);
  const nSteps = Math.max(0, Math.ceil((o.thickMax - 3 * o.thickStep) / o.thickStep - 1e-9));
  for (let i = 0; i < nv; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    const nx = vn[3 * i], ny = vn[3 * i + 1], nz = vn[3 * i + 2];
    for (let k = 0; k < nSteps; k++) {
      const d = 3 * o.thickStep + k * o.thickStep;
      const j = sGrid.nearestWithin(x - nx * d, y - ny * d, z - nz * d, o.thickHit);
      if (j < 0) continue;
      let v = sNear[j];
      if (v < 0) v = sNear[j] = nGrid.nearest(S[3 * j], S[3 * j + 1], S[3 * j + 2]);
      if (vn[3 * v] * nx + vn[3 * v + 1] * ny + vn[3 * v + 2] * nz < -0.2) { thick[i] = d; break; }
    }
  }
  lap('thickness');

  // --- 5 cm median of log-thickness, Otsu split
  const logt = new Float64Array(nv);
  for (let i = 0; i < nv; i++) logt[i] = Math.log(Number.isFinite(thick[i]) ? thick[i] : 0.2);
  const buf = new Int32Array(nv), vals = new Float64Array(nv);
  const mGrid = new HashGrid(P, nv, o.smoothRadius);
  const logs = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const n = mGrid.ball(P[3 * i], P[3 * i + 1], P[3 * i + 2], o.smoothRadius, buf);
    for (let k = 0; k < n; k++) vals[k] = logt[buf[k]];
    logs[i] = median(vals, n);
  }
  const cut = otsu(logs);
  const thicknessSplit = Math.exp(cut);
  lap('smoothing');

  // --- local shape descriptors
  const lin = new Float64Array(nv), pla = new Float64Array(nv), sca = new Float64Array(nv);
  const dir = new Float64Array(nv * 3);
  const label = new Uint8Array(nv);
  const dGrid = new HashGrid(P, nv, o.radius);
  const w = new Float64Array(3), V = new Float64Array(9);
  for (let i = 0; i < nv; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    const n = dGrid.ball(x, y, z, o.radius, buf);
    if (n < 6) { sca[i] = 1; label[i] = JOINT; continue; }
    let sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
    for (let k = 0; k < n; k++) {
      const j = 3 * buf[k];
      const px = P[j] - x, py = P[j + 1] - y, pz = P[j + 2] - z;
      sx += px; sy += py; sz += pz;
      sxx += px * px; sxy += px * py; sxz += px * pz; syy += py * py; syz += py * pz; szz += pz * pz;
    }
    const mx = sx / n, my = sy / n, mz = sz / n, dn = n - 1;
    eigSym3((sxx - n * mx * mx) / dn, (sxy - n * mx * my) / dn, (sxz - n * mx * mz) / dn,
      (syy - n * my * my) / dn, (syz - n * my * mz) / dn, (szz - n * mz * mz) / dn, w, V);
    const l3 = Math.max(w[0], 1e-12), l2 = Math.max(w[1], 1e-12), l1 = Math.max(w[2], 1e-12);
    lin[i] = (l1 - l2) / l1; pla[i] = (l2 - l3) / l1; sca[i] = l3 / l1;
    const lab = lin[i] >= Math.max(pla[i], sca[i]) ? TUBE : pla[i] >= sca[i] ? PANEL : JOINT;
    label[i] = logs[i] > cut ? BODY : lab;
    const e = label[i] === TUBE ? 6 : 0; // axis = largest eigenvector, else normal = smallest
    dir[3 * i] = V[e]; dir[3 * i + 1] = V[e + 1]; dir[3 * i + 2] = V[e + 2];
  }
  // the prototype marks thick vertices as body even when their descriptor had < 6 points
  for (let i = 0; i < nv; i++) if (logs[i] > cut && label[i] !== BODY) { label[i] = BODY; }
  lap('descriptors');

  // --- seeded region growth, strongest seeds first
  const cosmax = Math.cos(o.angle * Math.PI / 180);
  const strength = new Float64Array(nv);
  for (let i = 0; i < nv; i++) strength[i] = label[i] === TUBE ? lin[i] : pla[i];
  const order = Array.from({ length: nv }, (_, i) => i).sort((a, b) => strength[b] - strength[a]);
  const reg = new Int32Array(nv).fill(-1);
  const queue = new Int32Array(nv);
  const isolated = (i) => deg[i + 1] === deg[i];
  let rid = 0;
  for (const s of order) {
    if (reg[s] !== -1 || label[s] === JOINT || isolated(s)) continue;
    const ls = label[s];
    reg[s] = rid;
    let ax = dir[3 * s], ay = dir[3 * s + 1], az = dir[3 * s + 2];
    let head = 0, tail = 0; queue[tail++] = s;
    while (head < tail) {
      const i = queue[head++];
      const l = Math.hypot(ax, ay, az) || 1;
      const mx = ax / l, my = ay / l, mz = az / l;
      for (let k = deg[i]; k < deg[i + 1]; k++) {
        const j = adj[k];
        if (reg[j] !== -1 || label[j] !== ls) continue;
        const djx = dir[3 * j], djy = dir[3 * j + 1], djz = dir[3 * j + 2];
        const dp = djx * mx + djy * my + djz * mz;
        if (ls === TUBE && Math.abs(dp) < cosmax) continue;
        if (ls === PANEL && Math.abs(djx * dir[3 * i] + djy * dir[3 * i + 1] + djz * dir[3 * i + 2]) < cosmax) continue;
        reg[j] = rid;
        if (dp > 0) { ax += djx; ay += djy; az += djz; } else { ax -= djx; ay -= djy; az -= djz; }
        queue[tail++] = j;
      }
    }
    rid++;
  }
  // joints: breadth-first, each round takes the most common assigned neighbour (ties: lowest id)
  let un = [];
  for (let i = 0; i < nv; i++) if (reg[i] === -1 && !isolated(i)) un.push(i);
  const cr = [], cc = [];
  for (let round = 0; round < 200 && un.length; round++) {
    const upd = [];
    for (const i of un) {
      cr.length = 0; cc.length = 0;
      for (let k = deg[i]; k < deg[i + 1]; k++) {
        const r = reg[adj[k]]; if (r === -1) continue;
        const at = cr.indexOf(r);
        if (at < 0) { cr.push(r); cc.push(1); } else cc[at]++;
      }
      if (!cr.length) continue;
      let b = 0;
      for (let q = 1; q < cr.length; q++) if (cc[q] > cc[b] || (cc[q] === cc[b] && cr[q] < cr[b])) b = q;
      upd.push(i, cr[b]);
    }
    if (!upd.length) break;
    for (let q = 0; q < upd.length; q += 2) reg[upd[q]] = upd[q + 1];
    un = un.filter((i) => reg[i] === -1);
  }
  lap('growth');

  // --- region graph. Region id = grown id + 1; 0 holds any vertex still unassigned (the
  // prototype's -1, which sorts first there too). Per region: area, label histogram,
  // point sums for O(1) covariance of a union, and a map neighbour -> shared edge count.
  const R = rid + 1;
  const vr = new Int32Array(nv);
  for (let i = 0; i < nv; i++) vr[i] = reg[i] + 1;
  let gx = 0, gy = 0, gz = 0;
  for (let i = 0; i < nv; i++) { gx += P[3 * i]; gy += P[3 * i + 1]; gz += P[3 * i + 2]; }
  gx /= nv || 1; gy /= nv || 1; gz /= nv || 1;
  const rArea = new Float64Array(R), rLab = new Int32Array(R * 4), rSum = new Float64Array(R * 10);
  const alive = new Uint8Array(R), into = new Int32Array(R).fill(-1);
  for (let i = 0; i < nv; i++) {
    if (isolated(i)) continue;
    const r = vr[i]; alive[r] = 1;
    rArea[r] += varea[i]; rLab[4 * r + label[i]]++;
    const x = P[3 * i] - gx, y = P[3 * i + 1] - gy, z = P[3 * i + 2] - gz, b = 10 * r;
    rSum[b] += 1; rSum[b + 1] += x; rSum[b + 2] += y; rSum[b + 3] += z;
    rSum[b + 4] += x * x; rSum[b + 5] += x * y; rSum[b + 6] += x * z; rSum[b + 7] += y * y; rSum[b + 8] += y * z; rSum[b + 9] += z * z;
  }
  const nbr = Array.from({ length: R }, () => new Map());
  for (let e = 0; e < nu; e++) {
    const a = vr[EA[e]], b = vr[EB[e]];
    if (a === b) continue;
    nbr[a].set(b, (nbr[a].get(b) || 0) + 1);
    nbr[b].set(a, (nbr[b].get(a) || 0) + 1);
  }
  const merge = (s, t) => { // region t absorbs region s
    rArea[t] += rArea[s];
    for (let k = 0; k < 4; k++) rLab[4 * t + k] += rLab[4 * s + k];
    for (let k = 0; k < 10; k++) rSum[10 * t + k] += rSum[10 * s + k];
    for (const [r2, c] of nbr[s]) {
      if (r2 === t) { nbr[t].delete(s); continue; }
      nbr[t].set(r2, (nbr[t].get(r2) || 0) + c);
      const m = nbr[r2]; m.delete(s); m.set(t, (m.get(t) || 0) + c);
    }
    nbr[s] = new Map(); alive[s] = 0; into[s] = t;
  };
  const resolve = (r) => { while (into[r] >= 0) r = into[r]; return r; };
  const dbg = o.debug ? { logs, label, cut } : null;
  const snap = (name) => { if (dbg) dbg[name] = Int32Array.from(vr, (r) => resolve(r)); };
  snap('grow');
  const kindOf = (r) => { let b = 0; for (let k = 1; k < 4; k++) if (rLab[4 * r + k] > rLab[4 * r + b]) b = k; return b; };

  // Small regions (< minShare of the area) merge away, smallest first, into the neighbour
  // sharing most edges -- but ONLY into a neighbour that is not itself small, when one
  // exists. Without that rule, two adjacent slivers each just under minShare could merge
  // into each other first, cross the threshold together and survive as a fake part; which
  // happened depended on sampling noise (10 vs 11 chair parts by seed, 2026-09-29). With it
  // every sliver joins a real part and the result no longer depends on merge order.
  // A small region with no neighbour at all is a separate small object and is kept.
  const heap = new MinHeap();
  for (let r = 0; r < R; r++) if (alive[r]) heap.push(rArea[r], r);
  while (heap.size) {
    const [a, s] = heap.pop();
    if (!alive[s] || a !== rArea[s]) continue;
    if (a / totalArea >= o.minShare) break;
    if (nbr[s].size === 0) continue;
    let best = -1, bc = -1, bigBest = -1, bigBc = -1;
    for (const [r2, c] of nbr[s]) {
      if (c > bc || (c === bc && r2 < best)) { bc = c; best = r2; }
      if (rArea[r2] / totalArea >= o.minShare && (c > bigBc || (c === bigBc && r2 < bigBest))) { bigBc = c; bigBest = r2; }
    }
    if (bigBest >= 0) { best = bigBest; bc = bigBc; }
    if (dbg) (dbg.smallMerges ||= []).push([s - 1, best - 1, +(a / totalArea * 100).toFixed(4), bc]);
    merge(s, best);
    heap.push(rArea[best], best);
  }
  snap('small');

  const absorbIslands = () => {
    for (let it = 0; it < 100; it++) {
      let cRatio = -1, c1 = -1, c2 = -1;
      for (let r = 0; r < R; r++) {
        if (!alive[r] || nbr[r].size === 0) continue;
        let border = 0, bc = 0, b2 = -1;
        for (const [r2, c] of nbr[r]) { border += c; if (c > bc || (c === bc && r2 < b2)) { bc = c; b2 = r2; } }
        const ratio = bc / border;
        if (ratio < o.islandShare) continue;
        if (ratio > cRatio || (ratio === cRatio && (r > c1 || (r === c1 && b2 > c2)))) { cRatio = ratio; c1 = r; c2 = b2; }
      }
      if (c1 < 0) break;
      merge(c1, c2);
    }
  };
  absorbIslands();
  snap('isl');

  // neighbouring non-tube regions whose union is still one flat sheet become one region
  const cw = new Float64Array(3);
  for (let it = 0; it < 100; it++) {
    const pairs = [];
    for (let r = 0; r < R; r++) if (alive[r]) for (const [r2, c] of nbr[r]) if (r < r2) pairs.push([r, r2, c]);
    pairs.sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
    let done = false;
    for (const [r1, r2] of pairs) {
      if (kindOf(r1) === TUBE || kindOf(r2) === TUBE) continue;
      const s = new Float64Array(10);
      for (let k = 0; k < 10; k++) s[k] = rSum[10 * r1 + k] + rSum[10 * r2 + k];
      const n = s[0]; if (n < 2) continue;
      const mx = s[1] / n, my = s[2] / n, mz = s[3] / n, dn = n - 1;
      eigSym3((s[4] - n * mx * mx) / dn, (s[5] - n * mx * my) / dn, (s[6] - n * mx * mz) / dn,
        (s[7] - n * my * my) / dn, (s[8] - n * my * mz) / dn, (s[9] - n * mz * mz) / dn, cw, null);
      if (cw[0] / Math.max(cw[1], 1e-12) < o.flatRatio) { merge(r2, r1); done = true; break; }
    }
    if (!done) break;
  }
  absorbIslands();
  lap('merge');

  // --- compact labels (ascending region id, as np.unique), faces by vertex majority
  const final = new Int32Array(R).fill(-1);
  let k = 0;
  for (let r = 0; r < R; r++) if (alive[r]) final[r] = k++;
  const vertexLabels = new Int32Array(nv);
  for (let i = 0; i < nv; i++) vertexLabels[i] = isolated(i) ? 0 : final[resolve(vr[i])];
  const faceLabels = new Int32Array(nf);
  for (let t = 0; t < nf; t++) {
    const a = vertexLabels[F[3 * t]], b = vertexLabels[F[3 * t + 1]], c = vertexLabels[F[3 * t + 2]];
    faceLabels[t] = (b === c && a !== b) ? b : a;
  }
  const parts = [];
  for (let r = 0; r < R; r++) if (alive[r]) {
    parts.push({ id: final[r], kind: KINDS[kindOf(r)], vertexCount: 0, faceCount: 0,
      bbox: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } });
  }
  for (let i = 0; i < nv; i++) {
    const p = parts[vertexLabels[i]]; if (!p) continue;
    p.vertexCount++;
    for (let a = 0; a < 3; a++) {
      const v = P[3 * i + a];
      if (v < p.bbox.min[a]) p.bbox.min[a] = v;
      if (v > p.bbox.max[a]) p.bbox.max[a] = v;
    }
  }
  for (let t = 0; t < nf; t++) parts[faceLabels[t]].faceCount++;
  lap('labels');
  T.total = +(performance.now() - t0).toFixed(1);
  T.regionsGrown = rid;

  const res = { faceLabels, vertexLabels, parts, timings: T, thicknessSplit };
  if (dbg) res.debug = dbg;
  return res;
}

// ---------------------------------------------------------------- THREE.Mesh wrapper

// Copy the given triangles of `geo` into a new indexed geometry with `matrix` baked into
// positions/normals (same as segment.js's extract), so each part has an identity transform.
function extract(geo, tris, matrix, normalMatrix) {
  const idx = geo.index;
  const attrs = Object.entries(geo.attributes);
  const remap = new Map();
  const src = [];
  const index = new Uint32Array(tris.length * 3);
  let q = 0;
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const old = idx ? idx.getX(t * 3 + k) : t * 3 + k;
    let n = remap.get(old);
    if (n === undefined) { n = remap.size; remap.set(old, n); src.push(old); }
    index[q++] = n;
  }
  const g = new THREE.BufferGeometry();
  const v = new THREE.Vector3();
  for (const [name, a] of attrs) {
    const s = a.itemSize, out = new Float32Array(src.length * s);
    for (let i = 0; i < src.length; i++) {
      const old = src[i];
      if (name === 'position' || name === 'normal') {
        v.fromBufferAttribute(a, old);
        if (name === 'position') v.applyMatrix4(matrix); else v.applyMatrix3(normalMatrix).normalize();
        out[3 * i] = v.x; out[3 * i + 1] = v.y; out[3 * i + 2] = v.z;
      } else {
        out[i * s] = a.getX(old);
        if (s > 1) out[i * s + 1] = a.getY(old);
        if (s > 2) out[i * s + 2] = a.getZ(old);
        if (s > 3) out[i * s + 3] = a.getW(old);
      }
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, s, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Split one mesh into its parts. Welds by quantised world position (1 mm, as segment.js)
// so UV seams / non-indexed triangles don't cut the surface apart, runs splitParts, and
// returns one mesh per part with the world transform baked in. The returned array also
// carries `.split` (the splitParts result, plus weld timing) for callers that want labels.
// meshoptimizer (MIT, WASM, no build step) builds the analysis proxy for dense meshes: it
// simplifies while keeping the surface a proper surface. The simple grid-clustering fallback
// folds surfaces together (it split the detailed chair's backrest into front and back
// halves), so it is only used if the CDN can't be reached. Call once before splitting.
const MESHOPT_URL = 'https://cdn.jsdelivr.net/npm/meshoptimizer@1.3.0/meshopt_simplifier.js';
let simplifier = null;
export async function loadSimplifier() {
  if (!simplifier) {
    try {
      const { MeshoptSimplifier } = await import(MESHOPT_URL);
      await MeshoptSimplifier.ready;
      simplifier = MeshoptSimplifier;
    } catch (err) {
      console.warn('meshoptimizer unavailable; dense meshes use grid clustering', err);
    }
  }
  return simplifier;
}

export function splitMeshIntoParts(mesh, opts = {}) {
  const o = { ...PART_DEFAULTS, ...opts };
  const t0 = performance.now();
  mesh.updateWorldMatrix(true, false);
  const matrix = opts.matrix ?? mesh.matrixWorld;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  const triCount = Math.floor((idx ? idx.count : pos.count) / 3);

  const weldId = new Int32Array(pos.count);
  const seen = new Map();
  const wpos = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    const key = `${Math.round(p.x / o.weld)},${Math.round(p.y / o.weld)},${Math.round(p.z / o.weld)}`;
    let w = seen.get(key);
    if (w === undefined) { w = seen.size; seen.set(key, w); wpos.push(p.x, p.y, p.z); }
    weldId[i] = w;
  }
  const positions = new Float32Array(wpos);
  const index = new Uint32Array(triCount * 3);
  for (let t = 0; t < triCount * 3; t++) index[t] = weldId[idx ? idx.getX(t) : t];
  const weldMs = performance.now() - t0;

  // Dense meshes are analysed on a PROXY: vertex clustering on a grid sized to ~proxyTarget
  // vertices, then each full-resolution vertex takes its cell's label. Parts are centimetre
  // things, so millimetre density adds nothing but time (the 152k-vertex detailed chair took
  // 29 s at full density) -- and a fixed analysis density means the same object gives the
  // same parts however finely it was scanned.
  let res;
  const nWelded = seen.size;
  if (nWelded > o.proxyTarget && simplifier) {
    const target = Math.min(index.length, o.proxyTarget * 2 * 3);   // ~2 triangles per vertex
    const [simp] = simplifier.simplify(index, positions, 3, target, 0.02, ['Permissive']);
    const used = new Int32Array(nWelded).fill(-1);
    const keep = [];
    for (const v of simp) if (used[v] < 0) { used[v] = keep.length; keep.push(v); }
    const proxyPos = new Float32Array(keep.length * 3);
    keep.forEach((v, i) => { for (let k = 0; k < 3; k++) proxyPos[3 * i + k] = positions[3 * v + k]; });
    const proxyIdx = Uint32Array.from(simp, (v) => used[v]);
    const pres = splitParts(proxyPos, proxyIdx, o);
    // Every full-resolution vertex takes the label of the nearest kept vertex.
    const grid = new HashGrid(proxyPos, keep.length, 0.01);
    const vLab = new Int32Array(nWelded);
    for (let i = 0; i < nWelded; i++) {
      const j = used[i] >= 0 ? used[i] : grid.nearest(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
      vLab[i] = pres.vertexLabels[j];
    }
    const faceLabels = new Int32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const la = vLab[index[3 * t]], lb = vLab[index[3 * t + 1]], lc = vLab[index[3 * t + 2]];
      faceLabels[t] = (lb === lc) ? lb : la;
    }
    res = { ...pres, faceLabels, proxy: { method: 'meshoptimizer', vertices: keep.length, triangles: simp.length / 3 } };
  } else if (nWelded > o.proxyTarget) {
    let area = 0;
    for (let t = 0; t < triCount; t++) {
      const a3 = 3 * index[3 * t], b3 = 3 * index[3 * t + 1], c3 = 3 * index[3 * t + 2];
      const ux = positions[b3] - positions[a3], uy = positions[b3 + 1] - positions[a3 + 1], uz = positions[b3 + 2] - positions[a3 + 2];
      const vx = positions[c3] - positions[a3], vy = positions[c3 + 1] - positions[a3 + 1], vz = positions[c3 + 2] - positions[a3 + 2];
      area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    }
    // A clustered surface keeps roughly one vertex per cell face-area: cell ~ sqrt(area / N).
    const cell = Math.sqrt(area / o.proxyTarget);
    const cellOf = new Int32Array(nWelded);
    const cells = new Map();
    const sum = [];
    for (let i = 0; i < nWelded; i++) {
      const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
      const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
      let c = cells.get(key);
      if (c === undefined) { c = cells.size; cells.set(key, c); sum.push(0, 0, 0, 0); }
      cellOf[i] = c;
      sum[4 * c] += x; sum[4 * c + 1] += y; sum[4 * c + 2] += z; sum[4 * c + 3]++;
    }
    const proxyPos = new Float32Array(cells.size * 3);
    for (let c = 0; c < cells.size; c++) for (let k = 0; k < 3; k++) proxyPos[3 * c + k] = sum[4 * c + k] / sum[4 * c + 3];
    const proxyIdx = [];
    for (let t = 0; t < triCount; t++) {
      const a1 = cellOf[index[3 * t]], b1 = cellOf[index[3 * t + 1]], c1 = cellOf[index[3 * t + 2]];
      if (a1 !== b1 && b1 !== c1 && a1 !== c1) proxyIdx.push(a1, b1, c1);   // drop collapsed triangles
    }
    const pres = splitParts(proxyPos, new Uint32Array(proxyIdx), o);
    // Full-resolution labels: vertex <- its cell; triangle <- majority of its vertices.
    const faceLabels = new Int32Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const la = pres.vertexLabels[cellOf[index[3 * t]]], lb = pres.vertexLabels[cellOf[index[3 * t + 1]]], lc = pres.vertexLabels[cellOf[index[3 * t + 2]]];
      faceLabels[t] = (lb === lc) ? lb : la;
    }
    res = { ...pres, faceLabels, proxy: { method: 'grid', cell, vertices: cells.size, triangles: proxyIdx.length / 3 } };
  } else {
    res = splitParts(positions, index, o);
  }

  const t1 = performance.now();
  const tris = res.parts.map(() => []);
  for (let t = 0; t < triCount; t++) tris[res.faceLabels[t]].push(t);
  const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const perKind = {};
  const meshes = [];
  res.parts.forEach((part, i) => {
    if (!tris[i].length) return;
    const m = new THREE.Mesh(extract(geo, tris[i], matrix, normalMatrix), material);
    perKind[part.kind] = (perKind[part.kind] || 0) + 1;
    m.name = `${part.kind} ${perKind[part.kind]}`;
    m.userData.original = mesh.userData.original;
    m.userData.partId = part.id;
    m.userData.partKind = part.kind;
    meshes.push(m);
  });
  res.timings.weld = +weldMs.toFixed(1);
  res.timings.extract = +(performance.now() - t1).toFixed(1);
  res.timings.all = +(performance.now() - t0).toFixed(1);
  res.weldedVertices = seen.size;
  meshes.split = res;
  return meshes;
}


// Readable names from shape and position (mirrors completion/bake_parts.py describe()):
// long vertical -> "leg"/"post", long horizontal touching the floor -> "runner", otherwise
// "rail", thick and flat -> "cushion", wide and high -> "backrest", plus front/back/left/right.
// Names describe geometry, not a guess at what the object is; the user can rename.
export function describePart(box, scanBox, kind) {
  const size = scanBox.getSize(new THREE.Vector3());
  const centre = scanBox.getCenter(new THREE.Vector3());
  const ext = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3()).sub(centre);
  const where = [];
  if (Math.abs(c.z) > 0.12 * size.z) where.push(c.z > 0 ? 'front' : 'back');
  if (Math.abs(c.x) > 0.12 * size.x) where.push(c.x < 0 ? 'left' : 'right');
  const tall = ext.y, wide = ext.x, deep = ext.z, flat = Math.max(wide, deep);
  let name;
  if (kind === 'body' && tall < 0.5 * flat) name = c.y < 0.25 * size.y ? 'seat cushion' : 'cushion';
  else if (flat > 2.0 * tall && Math.min(wide, deep) < 0.35 * flat)
    name = box.min.y - scanBox.min.y < 0.05 * size.y ? 'runner' : 'rail';
  else if (tall > 1.8 * flat || (tall > flat && Math.min(wide, deep) < 0.1))
    name = c.y < 0 && tall < 0.6 * size.y ? 'leg' : 'post';
  else if (wide > 0.6 * size.x && c.y > 0.2 * size.y) name = 'backrest';
  else name = kind === 'body' ? 'body' : 'panel';
  return where.length ? `${name} · ${where.join(' ')}` : name;
}

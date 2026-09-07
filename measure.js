// Real measurements of the scanned object.
//
// This is what turns the project from "spin a model around" into something with a use: an
// iPhone LiDAR scan carries true real-world scale, so the mesh on screen is a dimensioned
// record of an actual object. Everything here reads that scale honestly and says where it
// is uncertain.
//
// WHY THE OBVIOUS BOUNDING BOX IS WRONG
// A plain axis-aligned bounding box measures the object's alignment to the SCAN's
// coordinate frame, not the object. Nothing makes you place an object square to the
// scanner, and the chair here sits rotated about 16 degrees off axis (found independently
// when locating its symmetry plane, which came out at 164 degrees). An axis-aligned box
// around a rotated object is inflated on both horizontal axes — it reports the diagonal of
// the footprint, not its width. So footprint is measured as the minimum-area rectangle over
// rotation about the vertical axis, which is the object's own width and depth.
//
// Height is left on the world Y axis deliberately: a handheld scan is gravity-aligned, so
// "up" is genuinely known, and re-deriving it from the geometry would be less reliable than
// the sensor already is.

const RAD = Math.PI / 180;

function collectVertices(object) {
  const points = [];
  object.updateWorldMatrix(true, true);
  object.traverse((child) => {
    if (!child.isMesh) return;
    const position = child.geometry?.getAttribute('position');
    if (!position) return;
    for (let i = 0; i < position.count; i++) {
      points.push([position.getX(i), position.getY(i), position.getZ(i)]);
    }
  });
  return points;
}

// Minimum-area footprint rectangle, by rotating about the vertical axis. Brute force at one
// degree then refined at a tenth: a footprint's area as a function of angle is smooth and
// has few minima, so a search is both simpler and more predictable here than rotating
// calipers, and 900 cheap passes over the vertex list costs nothing at load time.
function minimalFootprint(points) {
  let best = null;
  const evaluate = (deg) => {
    const t = deg * RAD;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of points) {
      const u = p[0] * cos - p[2] * sin;
      const v = p[0] * sin + p[2] * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const d = maxV - minV;
    const area = w * d;
    if (!best || area < best.area) best = { area, w, d, deg };
  };

  for (let deg = 0; deg < 90; deg += 1) evaluate(deg);
  const coarse = best.deg;
  for (let deg = coarse - 1; deg <= coarse + 1; deg += 0.1) evaluate(deg);

  // Report the longer horizontal side as width, so width/depth don't swap between scans
  // purely because the search landed on the perpendicular angle.
  const width = Math.max(best.w, best.d);
  const depth = Math.min(best.w, best.d);
  return { width, depth, angleDeg: best.deg };
}

// Signed-tetrahedron volume and triangle-area sum. Volume is only meaningful on a closed
// surface — clean_scan.py's fill stage is what makes this a real number rather than an
// artefact, so it is reported alongside whether the mesh actually is closed.
function volumeAndArea(object) {
  let volume = 0;
  let area = 0;
  const ax = [0, 0, 0];
  const bx = [0, 0, 0];
  const cx = [0, 0, 0];

  object.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry;
    const position = geometry?.getAttribute('position');
    if (!position) return;
    const index = geometry.getIndex();
    const triangles = index ? index.count / 3 : position.count / 3;

    for (let t = 0; t < triangles; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      ax[0] = position.getX(i0); ax[1] = position.getY(i0); ax[2] = position.getZ(i0);
      bx[0] = position.getX(i1); bx[1] = position.getY(i1); bx[2] = position.getZ(i1);
      cx[0] = position.getX(i2); cx[1] = position.getY(i2); cx[2] = position.getZ(i2);

      volume += (
        ax[0] * (bx[1] * cx[2] - bx[2] * cx[1]) -
        ax[1] * (bx[0] * cx[2] - bx[2] * cx[0]) +
        ax[2] * (bx[0] * cx[1] - bx[1] * cx[0])
      ) / 6;

      const e1 = [bx[0] - ax[0], bx[1] - ax[1], bx[2] - ax[2]];
      const e2 = [cx[0] - ax[0], cx[1] - ax[1], cx[2] - ax[2]];
      const cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0]
      ];
      area += Math.hypot(cross[0], cross[1], cross[2]) / 2;
    }
  });

  return { volume: Math.abs(volume), area };
}

// Measured once at load, in metres, for the object at its scanned size. Gesture scaling is
// applied on top of this by scaleDimensions() rather than re-measuring, so the "as scanned"
// figures stay visible next to whatever the model has been stretched to.
export function measureObject(object) {
  const points = collectVertices(object);
  if (points.length === 0) return null;

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }

  const footprint = minimalFootprint(points);
  const { volume, area } = volumeAndArea(object);

  return {
    width: footprint.width,
    depth: footprint.depth,
    height: maxY - minY,
    footprintAngleDeg: footprint.angleDeg,
    volume,
    surfaceArea: area,
    vertexCount: points.length
  };
}

// Current on-screen size, i.e. after pinch-scale and explode-stretch. Non-uniform scaling is
// respected per axis, since stretch deliberately changes only one of them.
export function scaleDimensions(base, scale) {
  return {
    width: base.width * scale.x,
    depth: base.depth * scale.z,
    height: base.height * scale.y,
    volume: base.volume * scale.x * scale.y * scale.z
  };
}

export function formatLength(metres, unit) {
  if (unit === 'in') {
    const inches = metres * 39.3701;
    if (inches >= 12) {
      const feet = Math.floor(inches / 12);
      return `${feet}' ${(inches - feet * 12).toFixed(1)}"`;
    }
    return `${inches.toFixed(1)}"`;
  }
  const cm = metres * 100;
  return cm >= 100 ? `${(cm / 100).toFixed(2)} m` : `${cm.toFixed(1)} cm`;
}

export function formatVolume(cubicMetres, unit) {
  if (unit === 'in') return `${(cubicMetres * 61023.7).toFixed(0)} in³`;
  const litres = cubicMetres * 1000;
  return litres >= 1000 ? `${cubicMetres.toFixed(2)} m³` : `${litres.toFixed(1)} L`;
}

// Will it go through? Checks the object's footprint against a rectangular opening, trying it
// in both horizontal orientations and also on its side, since "does the sofa fit through the
// door" in practice means "in ANY orientation I can physically manage".
//
// Deliberately compares the object's own minimal footprint rather than its axis-aligned box:
// carrying something through a doorway, you turn it to its narrow side, which is exactly
// what the minimum-area rectangle measures.
export function fitCheck(dims, openingWidth, openingHeight) {
  const orientations = [
    { label: 'upright, facing through', across: dims.width, up: dims.height, deep: dims.depth },
    { label: 'upright, turned sideways', across: dims.depth, up: dims.height, deep: dims.width },
    { label: 'tipped on its side', across: dims.width, up: dims.depth, deep: dims.height },
    { label: 'tipped and turned', across: dims.depth, up: dims.width, deep: dims.height }
  ];

  const results = orientations.map((o) => {
    const clearanceW = openingWidth - o.across;
    const clearanceH = openingHeight - o.up;
    return { ...o, clearanceW, clearanceH, fits: clearanceW >= 0 && clearanceH >= 0 };
  });

  const passing = results.filter((r) => r.fits);
  // Best = the one with the most room to spare on its tightest side, which is what actually
  // makes a real move easy rather than technically possible.
  passing.sort((a, b) => Math.min(b.clearanceW, b.clearanceH) - Math.min(a.clearanceW, a.clearanceH));

  return {
    fits: passing.length > 0,
    best: passing[0] ?? null,
    tightest: results.reduce((worst, r) =>
      Math.min(r.clearanceW, r.clearanceH) > Math.min(worst.clearanceW, worst.clearanceH) ? r : worst
    ),
    all: results
  };
}

// ---------------------------------------------------------------------------------------
// Horizontal surfaces: seat height, table top, shelf levels.
//
// The useful dimension of a chair is not its bounding box, it is how high the seat is — and
// that is the kind of number a spec sheet carries. Detected rather than assumed, so this
// works on whatever gets scanned next instead of hard-coding "chair".
//
// The signal is the area of UPWARD-FACING triangles at each height. A seat, a table top or a
// shelf is a large horizontal surface concentrated in a narrow band of heights; legs, posts
// and sides are vertical and contribute almost nothing however tall they are. Two weaker
// signals were considered and rejected against the real scan: cross-section bounding-box
// area barely moves between the legs and the seat (the box spans the splayed legs the whole
// way up), and raw vertex count works but is a proxy that drifts with mesh density rather
// than measuring anything physical.
const SURFACE_BANDS = 120;
const SURFACE_UPNESS = 0.7;        // |normal.y| above this counts as horizontal, ~45 degrees
const SURFACE_PEAK_SHARE = 0.25;   // a band must hold this share of the strongest band to count

export function horizontalSurfaces(object) {
  const points = collectVertices(object);
  if (points.length === 0) return [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const height = maxY - minY;
  if (height <= 0) return [];

  const area = new Float64Array(SURFACE_BANDS);
  const extent = Array.from({ length: SURFACE_BANDS }, () => ({
    minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity
  }));

  object.traverse((child) => {
    if (!child.isMesh) return;
    const position = child.geometry?.getAttribute('position');
    if (!position) return;
    const index = child.geometry.getIndex();
    const count = index ? index.count / 3 : position.count / 3;

    for (let t = 0; t < count; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const ax = position.getX(i0), ay = position.getY(i0), az = position.getZ(i0);
      const bx = position.getX(i1), by = position.getY(i1), bz = position.getZ(i1);
      const cx = position.getX(i2), cy = position.getY(i2), cz = position.getZ(i2);

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const length = Math.hypot(nx, ny, nz);
      if (length === 0) continue;
      if (Math.abs(ny / length) < SURFACE_UPNESS) continue;

      const centreY = (ay + by + cy) / 3;
      let band = Math.floor(((centreY - minY) / height) * SURFACE_BANDS);
      if (band < 0) band = 0;
      if (band >= SURFACE_BANDS) band = SURFACE_BANDS - 1;

      area[band] += length / 2;
      const e = extent[band];
      e.minX = Math.min(e.minX, ax, bx, cx);
      e.maxX = Math.max(e.maxX, ax, bx, cx);
      e.minZ = Math.min(e.minZ, az, bz, cz);
      e.maxZ = Math.max(e.maxZ, az, bz, cz);
    }
  });

  const peak = Math.max(...area);
  if (peak <= 0) return [];
  const threshold = peak * SURFACE_PEAK_SHARE;

  // Group contiguous strong bands into one surface each, so a seat several centimetres thick
  // is reported once rather than as a stack of slices.
  const surfaces = [];
  let run = null;
  for (let b = 0; b < SURFACE_BANDS; b++) {
    if (area[b] >= threshold) {
      if (!run) run = { from: b, to: b, best: b };
      else {
        run.to = b;
        if (area[b] > area[run.best]) run.best = b;
      }
    } else if (run) {
      surfaces.push(run);
      run = null;
    }
  }
  if (run) surfaces.push(run);

  return surfaces.map((s) => {
    const e = extent[s.best];
    let total = 0;
    for (let b = s.from; b <= s.to; b++) total += area[b];
    return {
      // The strongest band is the surface people actually meet — the top face of the seat.
      height: minY + ((s.best + 0.5) / SURFACE_BANDS) * height - minY,
      heightFromBase: minY + ((s.best + 0.5) / SURFACE_BANDS) * height - minY,
      area: total,
      width: Number.isFinite(e.maxX) ? e.maxX - e.minX : 0,
      depth: Number.isFinite(e.maxZ) ? e.maxZ - e.minZ : 0,
      share: total / area.reduce((sum, v) => sum + v, 0)
    };
  }).sort((a, b) => b.area - a.area);
}

// ---------------------------------------------------------------------------------------
// Weight and shipping.
//
// Both numbers come with a caveat that has to travel with them, so it is stated in the UI
// rather than buried: the mesh volume is the volume ENCLOSED by the scanned surface, which
// equals the material volume only for a solid object. A tubular steel frame is mostly air
// inside its own surface, so treating it as solid steel overestimates badly. It is a fair
// estimate for a solid wooden or foam-filled object and an upper bound otherwise.
export const MATERIALS = [
  { name: 'upholstered / foam', density: 90 },
  { name: 'softwood (pine)', density: 500 },
  { name: 'plywood / MDF', density: 650 },
  { name: 'hardwood (oak)', density: 700 },
  { name: 'ABS plastic', density: 1050 },
  { name: 'glass', density: 2500 },
  { name: 'aluminium', density: 2700 },
  { name: 'steel', density: 7850 }
];

export function estimateWeight(volume, density) {
  return volume * density; // m³ × kg/m³ = kg
}

// Carriers bill the greater of real weight and "volumetric" weight — the space the parcel
// occupies — so a light bulky object like a chair is almost always billed on its size. The
// 5000 divisor is the usual air/courier convention for centimetres.
const VOLUMETRIC_DIVISOR = 5000;

export function shippingBox(dims, paddingMetres = 0.03) {
  const w = (dims.width + paddingMetres * 2) * 100;
  const d = (dims.depth + paddingMetres * 2) * 100;
  const h = (dims.height + paddingMetres * 2) * 100;
  return {
    widthCm: w,
    depthCm: d,
    heightCm: h,
    volumetricKg: (w * d * h) / VOLUMETRIC_DIVISOR
  };
}

export function formatWeight(kg, unit) {
  if (unit === 'in') return `${(kg * 2.20462).toFixed(1)} lb`;
  return kg >= 1 ? `${kg.toFixed(1)} kg` : `${(kg * 1000).toFixed(0)} g`;
}

// ---------------------------------------------------------------------------------------
// Calibration.
//
// A LiDAR scan carries real scale, but not perfect scale — phone LiDAR typically lands
// within a few percent, and that error is a single scale factor across the whole scan
// rather than random per-dimension noise. So one hand measurement of any known feature is
// enough to correct everything: measure the seat height with a tape, tell the app what it
// really is, and every other number moves with it.
//
// This is the difference between numbers that look plausible and numbers someone else can
// act on. Without it the honest description of every figure here is "about".
//
// Note the exponents — these are the easy thing to get wrong. A length scales by f, an area
// by f², a volume by f³, so a 3% length error is a 9% volume error and therefore a 9% weight
// error. Getting that wrong would make the weight estimate quietly worse the more precisely
// someone calibrated.
export function calibrate(base, factor) {
  if (!(factor > 0) || factor === 1) return base;
  return {
    ...base,
    width: base.width * factor,
    depth: base.depth * factor,
    height: base.height * factor,
    volume: base.volume * factor ** 3,
    surfaceArea: base.surfaceArea * factor ** 2
  };
}

export function calibrateSurfaces(surfaces, factor) {
  if (!(factor > 0) || factor === 1) return surfaces;
  return surfaces.map((s) => ({
    ...s,
    height: s.height * factor,
    width: s.width * factor,
    depth: s.depth * factor,
    area: s.area * factor ** 2
  }));
}

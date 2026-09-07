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

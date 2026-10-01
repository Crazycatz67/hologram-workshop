"""Tier-1 plane completion: find the big flat surfaces a scan is made of, extend them, and
fill ONLY where the scan has nothing.

Track B, Cascade tier 1 (plans/scan-completion/ROADMAP.md). Rooms are mostly planes --
floor, walls, ceiling, table tops, cabinet sides -- and what a room scan misses is mostly
the parts of those planes hidden behind or under furniture, plus the floor and wall that
appear when the Platform hides a piece of furniture (A-P4). A plane measured over metres
of real scan is a far better guess for its hidden 30 cm than any smooth-surface fill.

CONTRACT
--------
  plane_extend(v, f, **options) -> (v_out, f_out)
      Same shape as the fill.py methods, so it chains with them:
          v, f = plane_extend(v, f); v, f = fill.poisson(v, f)
      v_out[:len(v)] == v and f_out[:len(f)] == f exactly (the scan is never moved or
      re-meshed); every face at index >= len(f) is inferred. Patch vertices are appended
      after the scan's. Units: metres (thresholds below assume it). Any orientation: no
      "up" axis is assumed. Returns the input unchanged if no plane qualifies.

  find_planes(v, f, ...) -> list[Plane]
  plane_patches(v, f, planes=None, gap=GAP, cell=CELL, surface_mode="span",
                shells_only=False, openings=True, occluders=None) -> (patch_v, patch_f, report)
      The two halves of plane_extend, for inspection. `report` has one dict per plane:
      kind ("shell" / "surface"), measured area, added area, area left open as an opening.
      plane_extend(v, f, **options) passes the same options through.

HOW
---
  1. Planes by RANSAC over face centroids + normals (orientation-aware, so the wall and
     the sofa back 5 cm in front of it stay two planes), each refined by area-weighted
     least squares, largest first.
  2. Each plane is a SHELL plane (floor, wall, ceiling) if almost nothing in the scan
     lies behind it -- the room's outer hull. That test needs no "up" axis, no Manhattan
     assumption and no labels. Everything else is a SURFACE (furniture faces). A shell
     plane with a larger parallel shell plane within DUP_GAP is a RANSAC fragment of the
     same uneven real floor/wall and is demoted to a surface (BUGS #49).
  3. Shell planes are extended to their intersections with the other shell planes (the
     room is the intersection of their half-spaces) and to the scan's own extent.
     Surface planes are split into connected pieces. Each piece fills the holes it
     encloses, plus bites out of its edge where the face lies on both sides within
     MAX_SPAN (surface_mode="span", default: on the room bench, 3 hole seeds, it covers
     86-100% with 100% of the added surface real). "holes" fills enclosed holes only
     (80-99%); "rect" fills the whole bounding rectangle and invents surface on L-shaped
     faces (97-100% coverage but only 56-58% real).
  4. The candidate region is gridded into CELL-sized squares and the MERGE RULE drops
     every cell with scan geometry within GAP.
  5. OPENINGS: a large leftover gap in a shell plane that the middle of the room can see
     with nothing in the way is left open -- the scanner looked and got nothing back, so
     it is a doorway or window, not a shadow. Shadows have something in front of them.
     When the Platform hides furniture (A-P4), pass that furniture as `occluders=(v, f)`:
     it then still counts as "in the way", so the floor it stood on is filled. Without
     it, that floor looks clear-sighted and is (safely) left open.
  What is left is appended as inferred.

KNOWN LIMITS (measured or reasoned in completion/room_bench.py)
---------------------------------------------------------------
  * Openings are judged from ONE assumed viewpoint (the middle of the scan's bounding
    box), because a mesh does not record the real scanner path. A doorway seen only
    from a corner, or a dropout on a wall in plain view, can be misjudged. A doorway
    with something in front of it (a chair) is walled up. Openings smaller than
    OPENING_MIN_AREA are always filled, like any dropout.
  * Non-convex rooms (L-shapes): the inner-corner walls have scan geometry behind them,
    so they are treated as surfaces, not shell, and are not extended.
  * Surfaces the scan never saw at all (the back of a sofa against a wall, a cabinet top
    above the phone) produce no plane, so nothing is filled there; that is tier 3's job
    (fill.complete).
  * Curved furniture is out of scope for this tier by design.
"""

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage
from scipy.spatial import ConvexHull, cKDTree

from fill import append, face_geometry, sample_surface, submesh

GAP = 0.015              # metres; the merge rule: scan geometry this close means "not a gap"
CELL = 0.02              # metres; grid spacing of the added surface
DIST_TOL = 0.02          # metres; a face within this of a plane (and aligned) is an inlier
ANGLE_TOL = np.cos(np.radians(20))
MIN_PLANE_AREA = 0.15    # m^2 of measured surface before a plane is trusted
MIN_SHELL_AREA = 0.5     # m^2; a room's floor/wall/ceiling is always at least this
# A shell plane has (almost) nothing behind it. Real walls have noise, and a doorway
# can show a little of the next room, hence a margin and a small allowance.
BEHIND_MARGIN = 0.05     # metres
SHELL_BEHIND_MAX = 0.03  # share of scan area allowed behind a shell plane
# A real floor/wall is not one exact plane (the Redwood bedroom floor spans ~8 cm), so
# RANSAC at DIST_TOL splits it into parallel fragments, and a small fragment passed the
# shell test and was extended room-wide 5-15 cm off the real surface (BUGS #49). A shell
# plane with a LARGER shell plane of the same orientation within DUP_GAP is only a surface.
DUP_COS = np.cos(np.radians(10))
DUP_GAP = 0.25           # metres
CLOSING = 0.05           # metres; cracks narrower than ~2x this join one surface piece
RANSAC_TRIALS = 200
RANSAC_SUBSAMPLE = 5000
MAX_PLANES = 40
SAMPLE_DENSITY = 20_000  # samples per m^2 for merge-rule and rasterising (~7 mm spacing)


@dataclass
class Plane:
    normal: np.ndarray          # unit, pointing out of the surface (same side as its faces)
    offset: float               # plane is {x : normal . x == offset}
    faces: np.ndarray           # indices of inlier faces in the input mesh
    area: float                 # measured (inlier) area, m^2
    shell: bool = False
    shell_fragment: bool = False  # a shell plane demoted as a near-duplicate (BUGS #49): still room hull
    u: np.ndarray = field(default=None)   # in-plane axes, aligned with the plane's own
    w: np.ndarray = field(default=None)   # min-area rectangle so the grid follows walls


# ---------------------------------------------------------------- detection

def _refine(centroids, normals, areas, idx, normal):
    """Area-weighted least-squares plane through the inliers, oriented like `normal`."""
    wts = areas[idx] / areas[idx].sum()
    mean = wts @ centroids[idx]
    d = centroids[idx] - mean
    _, vecs = np.linalg.eigh((d * wts[:, None]).T @ d)
    n = vecs[:, 0]
    if n @ normal < 0:
        n = -n
    return n, float(n @ mean)


def _inliers(centroids, normals, cand, n, off):
    return cand[(normals[cand] @ n > ANGLE_TOL) & (np.abs(centroids[cand] @ n - off) < DIST_TOL)]


def find_planes(v, f, rng=None, min_area=MIN_PLANE_AREA):
    """Dominant planes, largest first, each with its inlier faces and shell/surface kind."""
    rng = rng or np.random.default_rng(0)
    centroids, normals, areas = face_geometry(v, f)
    remaining = np.arange(len(f))
    planes = []
    while len(planes) < MAX_PLANES and len(remaining) and areas[remaining].sum() >= min_area:
        # Score hypotheses on a subsample; area-weighted seeds find big planes first.
        p = areas[remaining] / areas[remaining].sum()
        sub = rng.choice(remaining, min(RANSAC_SUBSAMPLE, len(remaining)), replace=False)
        seeds = rng.choice(remaining, RANSAC_TRIALS, p=p)
        best, best_score = None, 0.0
        for s in seeds:
            n, off = normals[s], centroids[s] @ normals[s]
            score = areas[_inliers(centroids, normals, sub, n, off)].sum()
            if score > best_score:
                best, best_score = s, score
        if best is None:
            break
        n, off = normals[best], float(centroids[best] @ normals[best])
        idx = _inliers(centroids, normals, remaining, n, off)
        for _ in range(2):
            n, off = _refine(centroids, normals, areas, idx, n)
            idx = _inliers(centroids, normals, remaining, n, off)
        area = float(areas[idx].sum())
        if area < min_area or len(idx) < 3:
            break
        planes.append(Plane(n, off, idx, area))
        remaining = np.setdiff1d(remaining, idx, assume_unique=True)

    # Shell test: the room's hull planes have ~nothing behind them.
    total = areas.sum()
    for pl in planes:
        behind = areas[centroids @ pl.normal - pl.offset < -BEHIND_MARGIN].sum()
        pl.shell = pl.area >= MIN_SHELL_AREA and behind / total < SHELL_BEHIND_MAX
        pl.u, pl.w = _plane_axes(v, f, pl)
    shells = [p for p in planes if p.shell]
    for p in shells:
        if any(q is not p and q.area > p.area and q.normal @ p.normal > DUP_COS
               and abs(q.offset - p.offset) < DUP_GAP for q in shells):
            p.shell, p.shell_fragment = False, True
    return planes


def _plane_axes(v, f, pl):
    """In-plane axes aligned with the min-area rectangle around the plane's inliers, so a
    wall's grid runs along the wall and the staircase edge of a patch is minimal."""
    n = pl.normal
    a = np.cross(n, [1.0, 0.0, 0.0] if abs(n[0]) < 0.9 else [0.0, 1.0, 0.0])
    a /= np.linalg.norm(a)
    b = np.cross(n, a)
    pts = v[np.unique(f[pl.faces])]
    xy = np.stack([pts @ a, pts @ b], axis=1)
    angle = _min_area_rect_angle(xy)
    u = np.cos(angle) * a + np.sin(angle) * b
    return u, np.cross(n, u)   # (u, w, n) right-handed, so cross(u, w) == n


def _min_area_rect_angle(xy):
    """Rotating calipers: the angle of the hull edge whose bounding box is smallest."""
    try:
        hull = xy[ConvexHull(xy).vertices]
    except Exception:  # degenerate (collinear) input -- any axes will do
        return 0.0
    edges = np.roll(hull, -1, axis=0) - hull
    angles = np.unique(np.mod(np.arctan2(edges[:, 1], edges[:, 0]), np.pi / 2))
    best, best_area = 0.0, np.inf
    for t in angles:
        c, s = np.cos(t), np.sin(t)
        r = hull @ np.array([[c, -s], [s, c]])
        area = np.prod(r.max(axis=0) - r.min(axis=0))
        if area < best_area:
            best, best_area = t, area
    return best


# ---------------------------------------------------------------- candidate regions

def _clip(poly, a, c):
    """Sutherland-Hodgman: keep the part of convex polygon `poly` where a . p >= c."""
    out = []
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        fp, fq = a @ p - c, a @ q - c
        if fp >= 0:
            out.append(p)
        if (fp >= 0) != (fq >= 0):
            out.append(p + (q - p) * fp / (fp - fq))
    return np.array(out) if out else np.empty((0, 2))


def _shell_polygon(pl, shells, all_pts):
    """The plane clipped by every other (non-parallel) shell half-space and the scan's
    extent: 'extend the wall until it meets the floor, ceiling and the next wall'."""
    o = pl.normal * pl.offset
    xy = np.stack([(all_pts - o) @ pl.u, (all_pts - o) @ pl.w], axis=1)
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    poly = np.array([[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]])
    for other in shells:
        if other is pl or abs(other.normal @ pl.normal) > 0.9:
            continue
        # other half-space: n_j . (o + x u + y w) >= d_j - tol
        a = np.array([other.normal @ pl.u, other.normal @ pl.w])
        if np.linalg.norm(a) < 1e-6:
            continue
        poly = _clip(poly, a, other.offset - other.normal @ o - DIST_TOL)
        if len(poly) < 3:
            break
    return poly, o


def _inside_convex(poly, pts):
    """Points inside a convex polygon (either winding)."""
    if len(poly) < 3:
        return np.zeros(len(pts), dtype=bool)
    sign = None
    inside = np.ones(len(pts), dtype=bool)
    for i in range(len(poly)):
        p, q = poly[i], poly[(i + 1) % len(poly)]
        cross = (q[0] - p[0]) * (pts[:, 1] - p[1]) - (q[1] - p[1]) * (pts[:, 0] - p[0])
        if sign is None:
            area2 = sum((poly[k][0] * poly[(k + 1) % len(poly)][1] - poly[(k + 1) % len(poly)][0] * poly[k][1])
                        for k in range(len(poly)))
            sign = 1.0 if area2 > 0 else -1.0
        inside &= sign * cross >= -1e-9
    return inside


def _dense_samples(v, f, faces, rng):
    """Samples on the given faces at SAMPLE_DENSITY (at least one per face)."""
    if len(faces) == 0:
        return np.empty((0, 3))
    sv, sf = submesh(v, f, np.isin(np.arange(len(f)), faces))
    _, _, area = face_geometry(sv, sf)
    n = max(int(area.sum() * SAMPLE_DENSITY), len(sf))
    return sample_surface(sv, sf, n, rng)


def _grid(lo, hi, cell):
    nu = max(int(np.ceil((hi[0] - lo[0]) / cell)), 1)
    nw = max(int(np.ceil((hi[1] - lo[1]) / cell)), 1)
    cu = lo[0] + (np.arange(nu) + 0.5) * cell
    cw = lo[1] + (np.arange(nw) + 0.5) * cell
    return nu, nw, np.stack(np.meshgrid(cu, cw, indexing="ij"), axis=-1)


def _cells_to_mesh(keep, lo, cell, o, u, w):
    """Two triangles per kept grid cell, sharing grid vertices, wound so the normal is
    cross(u, w) -- the plane's own normal."""
    nu, nw = keep.shape
    iu, iw = np.nonzero(keep)
    if len(iu) == 0:
        return np.empty((0, 3)), np.empty((0, 3), dtype=np.int64)
    vid = lambda a, b: a * (nw + 1) + b
    v00, v10, v11, v01 = vid(iu, iw), vid(iu + 1, iw), vid(iu + 1, iw + 1), vid(iu, iw + 1)
    faces = np.concatenate([np.stack([v00, v10, v11], 1), np.stack([v00, v11, v01], 1)])
    gu, gw = np.meshgrid(lo[0] + np.arange(nu + 1) * cell, lo[1] + np.arange(nw + 1) * cell, indexing="ij")
    verts = o + gu.reshape(-1, 1) * u + gw.reshape(-1, 1) * w
    return submesh(verts, faces, np.ones(len(faces), dtype=bool))


MAX_SPAN = 0.5           # metres; "span" mode bridges gaps up to this long


def _spanned(comp, max_cells):
    """Cells with the surface on BOTH sides along a grid axis, across a gap of at most
    max_cells. Fills a bite out of a face's edge (a hole the edge cut open) without filling
    the open notch of an L-shaped face -- but it will bridge a U (e.g. between a sofa's
    arms) when the U is narrower than max_cells."""
    out = np.zeros_like(comp)
    for axis in (0, 1):
        n = comp.shape[axis]
        idx = np.arange(n).reshape((-1, 1) if axis == 0 else (1, -1))
        idx = np.broadcast_to(idx, comp.shape)
        left = np.maximum.accumulate(np.where(comp, idx, -1), axis=axis)
        right = np.flip(np.minimum.accumulate(np.flip(np.where(comp, idx, n), axis=axis), axis=axis), axis=axis)
        gap = right - left - 1
        out |= ~comp & (left >= 0) & (right < n) & (gap <= max_cells)
    return out


def _viewpoint(v):
    """Where the scanner most plausibly was: the middle of the scan's bounding box. A room
    is scanned by walking its middle; the mesh does not record the real path."""
    return (v.min(axis=0) + v.max(axis=0)) / 2.0


def _line_of_sight_clear(starts, target, tree, step=0.02, hit=0.02, skip=0.05):
    """For each start point, True if the segment to `target` passes no sampled geometry
    (ray-marching against a KD-tree of surface samples; no ray-tracing dependency)."""
    clear = np.ones(len(starts), dtype=bool)
    for i, a in enumerate(starts):
        d = target - a
        length = np.linalg.norm(d)
        ts = np.arange(skip, length - skip, step)
        if len(ts) == 0:
            continue
        probes = a + (ts / length)[:, None] * d
        dist, _ = tree.query(probes, distance_upper_bound=hit)
        clear[i] = not np.isfinite(dist).any()
    return clear


OPENING_MIN_AREA = 0.5   # m^2; a clear-sighted empty gap this big is a doorway or window
OPENING_CLEAR = 0.5      # share of its sampled cells that must see the room's middle
OPENING_PROBES = 40


def plane_patches(v, f, planes=None, gap=GAP, cell=CELL, surface_mode="span", shells_only=False,
                  openings=True, occluders=None, rng=None):
    """Candidate surface for every plane, after the merge rule. See module docstring.

    openings    leave a large gap in a shell plane open when the middle of the room has a
                clear line of sight to it: the scanner looked there and got nothing back,
                which is a doorway or a window, not a shadow. Shadows have furniture (or
                other scan geometry) in front of them.
    occluders   (v, f) of geometry that blocks sight lines but is NOT scan surface for the
                merge rule -- the furniture the Platform has hidden (A-P4). Without it, the
                floor a hidden sofa stood on looks clear-sighted and is left open.
    """
    rng = rng or np.random.default_rng(0)
    planes = find_planes(v, f) if planes is None else planes
    shells = [p for p in planes if p.shell]
    pieces_v, pieces_f, report = [], [], []
    sight = view = None
    if openings and shells:
        pts = _dense_samples(v, f, np.arange(len(f)), rng)
        if occluders is not None and len(occluders[1]):
            ov, of = occluders
            pts = np.vstack([pts, _dense_samples(ov, of, np.arange(len(of)), rng)])
        sight, view = cKDTree(pts), _viewpoint(v)

    for pl in planes:
        if shells_only and not pl.shell:
            continue
        o = pl.normal * pl.offset
        to2d = lambda p: np.stack([(p - o) @ pl.u, (p - o) @ pl.w], axis=1)

        if pl.shell:
            poly, _ = _shell_polygon(pl, shells, v)
            if len(poly) < 3:
                continue
            lo, hi = poly.min(axis=0), poly.max(axis=0)
            nu, nw, centres = _grid(lo, hi, cell)
            cand = _inside_convex(poly, centres.reshape(-1, 2)).reshape(nu, nw)
        else:
            xy = to2d(_dense_samples(v, f, pl.faces, rng))
            lo, hi = xy.min(axis=0) - cell, xy.max(axis=0) + cell
            nu, nw, centres = _grid(lo, hi, cell)
            occ = np.zeros((nu, nw), dtype=bool)
            ij = np.clip(((xy - lo) / cell).astype(int), 0, [nu - 1, nw - 1])
            occ[ij[:, 0], ij[:, 1]] = True
            r = max(int(round(CLOSING / cell)), 1)
            disk = np.hypot(*np.mgrid[-r:r + 1, -r:r + 1]) <= r
            closed = ndimage.binary_closing(np.pad(occ, r), structure=disk)[r:-r, r:-r] | occ
            labels, count = ndimage.label(closed)
            cand = np.zeros_like(occ)
            for k in range(1, count + 1):
                comp = labels == k
                if comp.sum() * cell * cell < MIN_PLANE_AREA / 3:
                    continue  # a sliver that happens to share the plane
                if surface_mode == "rect":
                    ii, jj = np.nonzero(comp)
                    cand[ii.min():ii.max() + 1, jj.min():jj.max() + 1] = True
                elif surface_mode == "span":
                    cand |= ndimage.binary_fill_holes(comp) | _spanned(comp, MAX_SPAN / cell)
                else:
                    cand |= ndimage.binary_fill_holes(comp)

        # The merge rule, per cell centre, against every scan face near this plane (not
        # just its inliers: a perpendicular face crossing the plane counts as geometry
        # too). "Near" = the face's vertex span reaches the +-2*gap slab, any face size.
        sd = v[f] @ pl.normal - pl.offset
        near = np.flatnonzero((sd.min(axis=1) < 2 * gap) & (sd.max(axis=1) > -2 * gap))
        scan_pts = _dense_samples(v, f, near, rng)
        scan_pts = scan_pts[np.abs(scan_pts @ pl.normal - pl.offset) < gap * 2]
        if cand.any() and len(scan_pts):
            c3 = o + centres[cand][:, :1] * pl.u + centres[cand][:, 1:] * pl.w
            d, _ = cKDTree(scan_pts).query(c3)
            cand[cand] = d > gap

        opened = 0.0
        if pl.shell and sight is not None and cand.any():
            labels, count = ndimage.label(cand)
            for k in range(1, count + 1):
                comp = labels == k
                if comp.sum() * cell * cell < OPENING_MIN_AREA:
                    continue
                cells = np.argwhere(comp)
                pick = cells[rng.choice(len(cells), min(OPENING_PROBES, len(cells)), replace=False)]
                c2 = centres[pick[:, 0], pick[:, 1]]
                starts = o + c2[:, :1] * pl.u + c2[:, 1:] * pl.w
                if _line_of_sight_clear(starts, view, sight).mean() > OPENING_CLEAR:
                    cand &= ~comp
                    opened += comp.sum() * cell * cell

        pv, pf = _cells_to_mesh(cand, lo, cell, o, pl.u, pl.w)
        _, _, pa = face_geometry(pv, pf)
        report.append({"kind": "shell" if pl.shell else "surface",
                       "normal": np.round(pl.normal, 3).tolist(), "offset": round(pl.offset, 3),
                       "measured_m2": round(pl.area, 3), "added_m2": round(float(pa.sum()), 3),
                       "left_open_m2": round(float(opened), 3)})
        if len(pf):
            pieces_v.append(pv)
            pieces_f.append(pf)

    if not pieces_f:
        return np.empty((0, 3)), np.empty((0, 3), dtype=np.int64), report
    out_v, out_f = pieces_v[0], pieces_f[0]
    for pv, pf in zip(pieces_v[1:], pieces_f[1:]):
        out_v, out_f = append(out_v, out_f, pv, pf)
    return out_v, out_f, report


def plane_extend(v, f, **options):
    """The scan unchanged + plane patches in its gaps. See CONTRACT in the module docstring."""
    pv, pf, _ = plane_patches(v, f, **options)
    if len(pf) == 0:
        return v, f
    return append(v, f, pv, pf)

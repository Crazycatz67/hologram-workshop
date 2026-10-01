"""Scan-completion building blocks: fill what the scanner missed, keep what it measured.

Track B (plans/scan-completion/ROADMAP.md). Every function here obeys the track's merge
rule: real scanned geometry is never moved or replaced, and new geometry is only added
where the scan has no surface nearby. Methods are scored by completion/benchmark.py --
change one, re-run it, and compare against the baseline table in the roadmap.

Meshes are passed around as plain (vertices, faces) numpy arrays so methods compose. The
recommended B1 chain (what complete() runs):
    v, f = mirror_gaps(v, f)
    v, f = slab_fill(v, f)
    v, f = poisson(v, f)
"""

import os
import sys
from pathlib import Path

import numpy as np
import pymeshlab
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clean_scan  # noqa: E402  -- reuse the shipped symmetry search, never fork it

# Screened Poisson's preclean drops unreferenced and null-normal vertices first. Real scans
# have back-to-back folded faces whose normals cancel to zero, and MeshLab refuses those
# (BUGS #48). On clean meshes it is a no-op; env HW_POISSON_PRECLEAN=0 restores the old call.
POISSON_PRECLEAN = os.environ.get("HW_POISSON_PRECLEAN", "1") != "0"
DENSITY_TRIM = float(os.environ.get("HW_DENSITY_TRIM", 3.0))  # log-depth below the supported median; 3.0 keeps the chair >=97% (#24); env override for experiments
GAP = 0.01               # metres; new geometry closer than this to the scan is redundant
SAMPLES = 250_000        # surface samples for nearest-surface queries (~3 mm on a chair)...
SAMPLES_PER_M2 = 210_000  # ...and never sparser than the chair's density (1.18 m2), so the
                          # absolute thresholds below (PROBE_HIT, GAP) mean the same thing on a
                          # sofa as on a chair. A fixed count left 21% of an 8 m2 sofa's own
                          # surface more than 4 mm from the nearest sample (BUGS.md #21).


# ---------------------------------------------------------------- mesh helpers

def face_geometry(v, f):
    """Per-face centroids, unit normals, areas."""
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    return (a + b + c) / 3.0, cross / np.maximum(area2, 1e-12)[:, None], area2 / 2.0


def sample_surface(v, f, n, rng, normals=False):
    """Area-weighted uniform points on a triangle mesh (and their face normals if asked)."""
    if len(f) == 0:
        return (np.empty((0, 3)), np.empty((0, 3))) if normals else np.empty((0, 3))
    _, nrm, area = face_geometry(v, f)
    idx = rng.choice(len(f), n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    a, b, c = v[f[idx, 0]], v[f[idx, 1]], v[f[idx, 2]]
    pts = (1 - s)[:, None] * a + (s * (1 - r2))[:, None] * b + (s * r2)[:, None] * c
    return (pts, nrm[idx]) if normals else pts


def sample_count(v, f, minimum=SAMPLES):
    """Samples needed to cover this mesh at least as densely as SAMPLES covers the chair."""
    _, _, area = face_geometry(v, f)
    return max(minimum, int(area.sum() * SAMPLES_PER_M2))


def submesh(v, f, keep):
    """Faces where keep is True, with unreferenced vertices dropped and reindexed."""
    f = f[keep]
    used, inverse = np.unique(f, return_inverse=True)
    return v[used], inverse.reshape(f.shape)


def append(v, f, v2, f2):
    return np.vstack([v, v2]), np.vstack([f, f2 + len(v)])


def boundary_vertices(v, f):
    """Vertices on open edges (edges used by exactly one face): where the scan stops."""
    edges = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    uniq, counts = np.unique(edges, axis=0, return_counts=True)
    return v[np.unique(uniq[counts == 1])]


def keep_only_gaps(v, f, new_v, new_f, gap=GAP, normal_aware=False):
    """The merge rule: of the candidate faces, keep those the scan doesn't already cover.

    Plain: a candidate within `gap` of any scan surface is redundant. normal_aware: it is
    redundant only if a scan sample within `gap` also FACES THE SAME WAY (dot > 0.5). On a
    thin wall the missing outer skin lies within 1 cm of the scanned inner skin but faces
    the other way; the plain rule always discarded it (BUGS.md #24, Ricky's 2026-10-01 runs).
    """
    if len(new_f) == 0:
        return np.empty((0, 3)), np.empty((0, 3), dtype=np.int64)
    centroids, cnorm, _ = face_geometry(new_v, new_f)
    if not normal_aware:
        dist, _ = cKDTree(sample_surface(v, f, sample_count(v, f), np.random.default_rng(0))).query(centroids)
        return submesh(new_v, new_f, dist > gap)
    pts, pn = sample_surface(v, f, sample_count(v, f), np.random.default_rng(0), normals=True)
    dk, ik = cKDTree(pts).query(centroids, k=16, distance_upper_bound=gap)
    near = np.isfinite(dk)
    same = (near & (np.einsum("nkj,nj->nk", pn[np.where(near, ik, 0)], cnorm) > 0.5)).any(axis=1)
    return submesh(new_v, new_f, ~same)


def to_meshset(v, f):
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=v, face_matrix=f.astype(np.int32)), "input")
    ms.compute_normal_per_vertex()
    return ms


def from_meshset(ms):
    m = ms.current_mesh()
    return m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)


# ---------------------------------------------------------------- methods

def mirror_gaps(v, f):
    """Mirror the object across its symmetry plane, keeping ONLY mirrored faces that land
    where the scan has nothing. Everything the scanner saw stays exactly as measured.
    Returns the input unchanged if the object isn't symmetric enough to trust.

    Replaces clean_scan.py's full-copy mirror for completion work: that one lays a whole
    second copy over the first, and on a near-symmetric object the coincident surfaces
    are exactly what made Poisson abort (BUGS.md #8)."""
    normal, offset, overlap = clean_scan.find_symmetry_plane(v, np.random.default_rng(0))
    if overlap < clean_scan.SYMMETRY_MIN_OVERLAP:
        return v, f
    mv = v - 2.0 * ((v @ normal) - offset)[:, None] * normal[None, :]
    gv, gf = keep_only_gaps(v, f, mv, f[:, ::-1])  # mirroring flips winding; flip it back
    return append(v, f, gv, gf)


# A panel thinner than this is noise; thicker than this is not a panel (a probe that
# long starts hitting other parts of the object, e.g. from a seat down to the runners).
MIN_THICKNESS = 0.004
MAX_THICKNESS = 0.08
UPWARD = 0.35            # a face this upward-facing can be the scanned top of a slab
PROBE_STEP = 0.005
PROBE_HIT = 0.004
# Thin shells (BUGS #24): a vase wall is one sheet with two skins 5 mm apart. Where one skin is
# hidden, the visible skin is copied by the wall thickness measured where BOTH skins were
# scanned (an opposite-facing sample behind the face), but only where most captured faces
# nearby are that thin, so a slab (chair seat) never borrows a thin part's thickness.
SHELL_MAX_THICKNESS = 0.012   # a back skin closer than this makes the face part of a thin shell
SHELL_STEP = 0.001            # fine probe for measuring that thickness
SHELL_NEIGHBOURS = 64         # captured faces that vote on "is this region a thin shell?"
SHELL_RADIUS = 0.15           # ...within this distance
SHELL_VOTE = 0.5              # share of voters that must be thin


def thickness_fill(v, f):
    """Rebuild missing undersides of slab-like parts (seats, shelves, rails, runners).

    A phone held above furniture sees the top of a seat but never its bottom. The bottom
    is, to a very good approximation, the top pushed down by the panel's thickness -- and
    the thickness is measurable from the scan itself: where the scan stops at the panel's
    sides, the open boundary sits at the bottom edge of those sides, so the drop from the
    top surface to the nearest boundary is the local thickness. So, per upward face:

      1. probe straight down up to MAX_THICKNESS; if scanned surface is
         already there, the bottom was captured -- skip;
      2. otherwise take the nearest boundary vertex (horizontally) and use its drop below
         the face as the thickness, if it is a plausible panel thickness;
      3. copy the face that far down, reversed so it faces down.

    Then the merge rule drops any copy that lands on real surface. This is measured
    geometry moved by a measured amount -- no model, no guess about what the object is.
    """
    centroids, normals, _ = face_geometry(v, f)
    boundary = boundary_vertices(v, f)
    top = np.flatnonzero(normals[:, 1] > UPWARD)
    if len(top) == 0 or len(boundary) == 0:
        return v, f

    # 1. Is the bottom already there? Probe points below each top face; a scan sample
    #    within PROBE_HIT of any probe (past the face's own thickness band) means yes.
    surface = cKDTree(sample_surface(v, f, sample_count(v, f), np.random.default_rng(1)))
    depths = np.arange(2 * PROBE_STEP, MAX_THICKNESS + 1e-9, PROBE_STEP)
    # Straight down, not along the normal: thickness is measured vertically (step 2) and the
    # copy moves vertically (step 3), so the check that the bottom is missing must agree.
    probes = centroids[top, None, :] - depths[None, :, None] * np.array([0.0, 1.0, 0.0])
    hit, _ = surface.query(probes.reshape(-1, 3), distance_upper_bound=PROBE_HIT)
    captured = np.isfinite(hit).reshape(len(top), len(depths)).any(axis=1)
    top = top[~captured]

    # 2. Local thickness = drop from the face to the nearest open boundary (in plan view).
    _, nearest = cKDTree(boundary[:, [0, 2]]).query(centroids[top][:, [0, 2]])
    thickness = centroids[top, 1] - boundary[nearest, 1]
    plausible = (thickness > MIN_THICKNESS) & (thickness < MAX_THICKNESS)
    top, thickness = top[plausible], thickness[plausible]
    if len(top) == 0:
        return v, f

    # 3. Copy each face down by its thickness, per vertex (faces are duplicated so
    #    neighbouring faces with different thickness don't fight over shared vertices).
    tri = v[f[top]] - np.array([0.0, 1.0, 0.0]) * thickness[:, None, None]
    new_v = tri.reshape(-1, 3)
    new_f = np.arange(len(new_v)).reshape(-1, 3)[:, ::-1]
    gv, gf = keep_only_gaps(v, f, new_v, new_f, normal_aware=True)
    return append(v, f, gv, gf)


SLAB_DIRECTIONS = 26     # directions sampled on the sphere; faces are grouped by the nearest
# Experimental (BUGS.md #23, default off): when the planar-nearest boundary gives an implausible
# drop (it often belongs to another part: stool seat -> rung, lamp base -> shade), fall back to
# the boundary nearest ALONG THE SURFACE -- but only if the face's own -d probe stays empty out
# to 2x that drop, so a wall or thin shell (open behind, far side somewhere else) gets no slab.
SLAB_GEO_FALLBACK = os.environ.get("HW_SLAB_GEO", "0") == "1"


def _sphere_directions(n):
    """n roughly evenly spaced unit vectors (Fibonacci sphere)."""
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    theta = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(theta) * np.sin(phi), np.cos(phi), np.sin(theta) * np.sin(phi)], axis=1)


def _geodesic_boundary(v, f):
    """Per face: index of the open-boundary vertex nearest along the mesh edges (-1 if the
    face's component has no boundary), via one multi-source Dijkstra from every boundary vertex."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import dijkstra
    edges = np.sort(np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]]), axis=1)
    uniq, counts = np.unique(edges, axis=0, return_counts=True)
    bidx = np.unique(uniq[counts == 1])
    face_b = np.full(len(f), -1)
    if len(bidx) == 0:
        return face_b
    w = np.linalg.norm(v[uniq[:, 0]] - v[uniq[:, 1]], axis=1)
    graph = coo_matrix((w, (uniq[:, 0], uniq[:, 1])), shape=(len(v), len(v))).tocsr()
    dist, _, src = dijkstra(graph, directed=False, indices=bidx, min_only=True, return_predecessors=True)
    corner = f[np.arange(len(f)), np.argmin(dist[f], axis=1)]  # the face's corner nearest a boundary
    face_b = np.where(np.isfinite(dist[corner]), src[corner], -1)
    return face_b


def slab_fill(v, f, geo_fallback=None):
    """thickness_fill in every direction: rebuild the missing far side of any slab.

    The underside of a seat is one case; the back of a backrest pushed against a wall is
    the same case turned on its side. Faces are grouped by the nearest of a set of
    directions d; for each group the three steps of thickness_fill run along d instead of
    along vertical: probe along -d for existing surface, measure the drop along d to the
    nearest open boundary (nearest in the plane perpendicular to d), copy the face by that
    drop. Grouping keeps it vectorised -- one boundary KD-tree per direction, not per face.

    geo_fallback (None = SLAB_GEO_FALLBACK): see that constant; experimental, BUGS.md #23.
    """
    if geo_fallback is None:
        geo_fallback = SLAB_GEO_FALLBACK
    centroids, normals, _ = face_geometry(v, f)
    boundary = boundary_vertices(v, f)
    if len(boundary) == 0:
        return v, f
    spts, snrm = sample_surface(v, f, sample_count(v, f), np.random.default_rng(1), normals=True)
    surface = cKDTree(spts)
    dirs = _sphere_directions(SLAB_DIRECTIONS)
    group = np.argmax(normals @ dirs.T, axis=1)
    # From one step, not two: a 5 mm wall's far skin sat inside the old 10 mm dead band, so
    # every thin-shell face read as an open slab and was copied into the cavity (BUGS #24).
    depths = np.arange(PROBE_STEP, MAX_THICKNESS + 1e-9, PROBE_STEP)
    fine = np.arange(2 * SHELL_STEP, SHELL_MAX_THICKNESS + 1e-9, SHELL_STEP)
    pieces, meas_f, meas_t, open_f, open_d = [], [], [], [], []

    # Room shell (floor, walls, ceiling: planes with nothing behind them) is not a slab. Probing
    # behind a wall finds nothing, so without this every wall face was copied to a fake
    # "thickness" offset: 5.64 m2 invented, 25% real on the synthetic room (BUGS.md #25).
    # Objects have no shell planes, so they are unaffected.
    from planes import find_planes  # local import: planes imports from this module
    shell = np.zeros(len(f), dtype=bool)
    for pl in find_planes(v, f, rng=np.random.default_rng(0)):
        if pl.shell or pl.shell_fragment:   # a demoted floor fragment is still floor (#49)
            shell[pl.faces] = True

    geo_b = _geodesic_boundary(v, f) if geo_fallback else None

    for g, d in enumerate(dirs):
        faces = np.flatnonzero((group == g) & (normals @ d > UPWARD) & ~shell)
        if len(faces) == 0:
            continue
        probes = centroids[faces, None, :] - depths[None, :, None] * d
        hit, _ = surface.query(probes.reshape(-1, 3), distance_upper_bound=PROBE_HIT)
        captured = np.isfinite(hit).reshape(len(faces), len(depths)).any(axis=1)
        if captured.any():  # measure wall thickness: first opposite-facing sample behind the face
            cf = faces[captured]
            pr = centroids[cf, None, :] - fine[None, :, None] * d
            dd, ii = surface.query(pr.reshape(-1, 3), distance_upper_bound=2 * SHELL_STEP)
            back = np.isfinite(dd)
            back[back] = (snrm[ii[back]] @ d) < -0.5
            back = back.reshape(len(cf), len(fine))
            meas_f.append(cf)
            meas_t.append(np.where(back.any(axis=1), fine[np.argmax(back, axis=1)], np.inf))
        faces = faces[~captured]
        if len(faces) == 0:
            continue

        # Coordinates in the plane perpendicular to d: any two axes orthogonal to it.
        a = np.cross(d, [1.0, 0.0, 0.0] if abs(d[0]) < 0.9 else [0.0, 1.0, 0.0])
        a /= np.linalg.norm(a)
        b = np.cross(d, a)
        plane = lambda p: np.stack([p @ a, p @ b], axis=1)
        _, nearest = cKDTree(plane(boundary)).query(plane(centroids[faces]))
        thickness = (centroids[faces] - boundary[nearest]) @ d
        ok = (thickness > MIN_THICKNESS) & (thickness < MAX_THICKNESS)
        if geo_b is not None:
            fb = (~ok) & (geo_b[faces] >= 0)
            drop = (centroids[faces] - v[np.maximum(geo_b[faces], 0)]) @ d
            fb &= (drop > MIN_THICKNESS) & (drop < MAX_THICKNESS)
            # The usual probe stops at MAX_THICKNESS; a drop over half that needs the empty
            # check extended to 2x drop before we trust it is a slab and not an open shell.
            long = np.flatnonzero(fb & (2 * drop > MAX_THICKNESS))
            if len(long):
                far = np.arange(MAX_THICKNESS + PROBE_STEP, 2 * MAX_THICKNESS + 1e-9, PROBE_STEP)
                pr = centroids[faces[long], None, :] - far[None, :, None] * d
                h, _ = surface.query(pr.reshape(-1, 3), distance_upper_bound=PROBE_HIT)
                h = np.isfinite(h).reshape(len(long), len(far)) & (far[None, :] <= 2 * drop[long, None])
                fb[long[h.any(axis=1)]] = False
            thickness = np.where(fb, drop, thickness)
            ok |= fb
        if (~ok).any():  # no plausible slab drop: a thin-shell candidate
            open_f.append(faces[~ok])
            open_d.append(np.repeat(d[None], (~ok).sum(), axis=0))
        faces, thickness = faces[ok], thickness[ok]
        if len(faces):
            pieces.append(v[f[faces]] - d * thickness[:, None, None])

    gv, gf = np.empty((0, 3)), np.empty((0, 3), dtype=np.int64)
    if pieces:
        new_v = np.concatenate(pieces).reshape(-1, 3)
        new_f = np.arange(len(new_v)).reshape(-1, 3)[:, ::-1]
        gv, gf = keep_only_gaps(v, f, new_v, new_f)
    sv, sf = _shell_offsets(v, f, centroids, normals, meas_f, meas_t, open_f, open_d)
    gv, gf = append(gv, gf, sv, sf)
    if len(gf) == 0:
        return v, f
    return append(v, f, gv, gf)


def _shell_offsets(v, f, centroids, normals, meas_f, meas_t, open_f, open_d):
    """Copy open thin-shell faces by the nearby measured wall thickness (see SHELL_*).
    Merged normal-aware: the new skin lies within GAP of the old one but faces the other way."""
    empty = np.empty((0, 3)), np.empty((0, 3), dtype=np.int64)
    if not meas_f or not open_f:
        return empty
    mf, mt = np.concatenate(meas_f), np.concatenate(meas_t)
    of, od = np.concatenate(open_f), np.concatenate(open_d)
    thin = mt <= SHELL_MAX_THICKNESS
    if not thin.any():
        return empty
    k = min(SHELL_NEIGHBOURS, len(mf))
    dk, ik = cKDTree(centroids[mf]).query(centroids[of], k=k, distance_upper_bound=SHELL_RADIUS)
    dk, ik = dk.reshape(len(of), k), ik.reshape(len(of), k)
    near = np.isfinite(dk)
    ik = np.where(near, ik, 0)
    thin_near = near & thin[ik]
    alike = thin_near & (np.einsum("nkj,nj->nk", normals[mf][ik], normals[of]) > 0.7)
    use = alike.any(axis=1) & (thin_near.sum(axis=1) >= SHELL_VOTE * near.sum(axis=1))
    if not use.any():
        return empty
    t = mt[ik[np.arange(len(of)), np.argmax(alike, axis=1)]][use]
    of, od = of[use], od[use]
    new_v = (v[f[of]] - od[:, None, :] * t[:, None, None]).reshape(-1, 3)
    new_f = np.arange(len(new_v)).reshape(-1, 3)[:, ::-1]
    return keep_only_gaps(v, f, new_v, new_f, normal_aware=True)


def complete(v, f, watertight=False):
    """The recommended B1 pipeline, returning (vertices, faces, inferred_mask).

    Default: the original scan faces EXACTLY as measured, plus the reconstructed surface
    only where the scan has nothing within GAP -- the track's fill policy ("keep every real
    scanned surface, fill only the gaps"). Poisson re-meshes everything, smoothing real
    detail too, so its output is used only as the source of the gap patches. The seams
    between scan and patch are not welded; for a single closed surface pass
    watertight=True and every face is labelled by its distance to the scan instead.
    """
    rebuilt_v, rebuilt_f = poisson(*slab_fill(*mirror_gaps(v, f)), density_trim=DENSITY_TRIM)
    if watertight:
        centroids, _, _ = face_geometry(rebuilt_v, rebuilt_f)
        dist, _ = cKDTree(sample_surface(v, f, sample_count(v, f), np.random.default_rng(0))).query(centroids)
        return rebuilt_v, rebuilt_f, dist > GAP
    pv, pf = keep_only_gaps(v, f, rebuilt_v, rebuilt_f, normal_aware=True)
    out_v, out_f = append(v, f, pv, pf)
    inferred = np.zeros(len(out_f), dtype=bool)
    inferred[len(f):] = True
    return out_v, out_f, inferred


def close_holes(v, f):
    ms = to_meshset(v, f)
    ms.meshing_repair_non_manifold_edges()
    ms.meshing_close_holes(maxholesize=100_000, selfintersection=False)
    return from_meshset(ms)


def poisson(v, f, density_trim=None, preclean=None):
    """Screened Poisson with clean_scan.py's shipped parameters, single-threaded
    (multi-threaded aborts at random -- clean_scan.POISSON_THREADS_NOTE).

    density_trim (log-depth units, e.g. DENSITY_TRIM): drop faces with any vertex whose
    Poisson density is that far below the median density of vertices the input supports
    (within GAP of it). Unsupported surface -- the balloon over an open side -- has low
    density (PyMeshLab stores it in vertex_scalar_array). None = no trim (the baseline).

    preclean (default POISSON_PRECLEAN, on): let MeshLab drop null-normal vertices before
    solving; without it a folded face pair on a real scan fails the whole run (BUGS #48)."""
    ms = to_meshset(v, f)
    before = ms.current_mesh_id()
    ms.generate_surface_reconstruction_screened_poisson(
        depth=9, samplespernode=1.5, pointweight=4.0, threads=1,
        preclean=POISSON_PRECLEAN if preclean is None else bool(preclean),
    )
    if ms.current_mesh_id() == before:
        raise RuntimeError("Poisson produced no mesh")
    if density_trim is not None:
        m = ms.current_mesh()
        pv, pf = m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)
        q = m.vertex_scalar_array()
        d, _ = cKDTree(sample_surface(v, f, sample_count(v, f), np.random.default_rng(0))).query(pv)
        if (d < GAP).any():
            keep = q >= np.median(q[d < GAP]) - density_trim
            pv, pf = submesh(pv, pf, keep[pf].all(axis=1))
        ms = to_meshset(pv, pf)
    ms.meshing_remove_connected_component_by_diameter(
        mincomponentdiag=pymeshlab.PercentageValue(5.0)
    )
    return from_meshset(ms)

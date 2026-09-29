"""Scan-completion building blocks: fill what the scanner missed, keep what it measured.

Track B (plans/scan-completion/ROADMAP.md). Every function here obeys the track's merge
rule: real scanned geometry is never moved or replaced, and new geometry is only added
where the scan has no surface nearby. Methods are scored by completion/benchmark.py --
change one, re-run it, and compare against the baseline table in the roadmap.

Meshes are passed around as plain (vertices, faces) numpy arrays so methods compose:
    v, f = mirror_gaps(v, f)
    v, f = thickness_fill(v, f)
    v, f = poisson(v, f)
"""

import sys
from pathlib import Path

import numpy as np
import pymeshlab
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import clean_scan  # noqa: E402  -- reuse the shipped symmetry search, never fork it

GAP = 0.01               # metres; new geometry closer than this to the scan is redundant
SAMPLES = 250_000        # surface samples for nearest-surface queries (~3 mm on a chair)


# ---------------------------------------------------------------- mesh helpers

def face_geometry(v, f):
    """Per-face centroids, unit normals, areas."""
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    return (a + b + c) / 3.0, cross / np.maximum(area2, 1e-12)[:, None], area2 / 2.0


def sample_surface(v, f, n, rng):
    """Area-weighted uniform points on a triangle mesh."""
    if len(f) == 0:
        return np.empty((0, 3))
    _, _, area = face_geometry(v, f)
    idx = rng.choice(len(f), n, p=area / area.sum())
    r1, r2 = rng.random(n), rng.random(n)
    s = np.sqrt(r1)
    a, b, c = v[f[idx, 0]], v[f[idx, 1]], v[f[idx, 2]]
    return (1 - s)[:, None] * a + (s * (1 - r2))[:, None] * b + (s * r2)[:, None] * c


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


def keep_only_gaps(v, f, new_v, new_f, gap=GAP):
    """The merge rule: of the candidate faces, keep those farther than `gap` from the scan."""
    if len(new_f) == 0:
        return np.empty((0, 3)), np.empty((0, 3), dtype=np.int64)
    centroids, _, _ = face_geometry(new_v, new_f)
    dist, _ = cKDTree(sample_surface(v, f, SAMPLES, np.random.default_rng(0))).query(centroids)
    return submesh(new_v, new_f, dist > gap)


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
    surface = cKDTree(sample_surface(v, f, SAMPLES, np.random.default_rng(1)))
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
    gv, gf = keep_only_gaps(v, f, new_v, new_f)
    return append(v, f, gv, gf)


SLAB_DIRECTIONS = 26     # directions sampled on the sphere; faces are grouped by the nearest


def _sphere_directions(n):
    """n roughly evenly spaced unit vectors (Fibonacci sphere)."""
    i = np.arange(n) + 0.5
    phi = np.arccos(1 - 2 * i / n)
    theta = np.pi * (1 + 5 ** 0.5) * i
    return np.stack([np.cos(theta) * np.sin(phi), np.cos(phi), np.sin(theta) * np.sin(phi)], axis=1)


def slab_fill(v, f):
    """thickness_fill in every direction: rebuild the missing far side of any slab.

    The underside of a seat is one case; the back of a backrest pushed against a wall is
    the same case turned on its side. Faces are grouped by the nearest of a set of
    directions d; for each group the three steps of thickness_fill run along d instead of
    along vertical: probe along -d for existing surface, measure the drop along d to the
    nearest open boundary (nearest in the plane perpendicular to d), copy the face by that
    drop. Grouping keeps it vectorised -- one boundary KD-tree per direction, not per face.
    """
    centroids, normals, _ = face_geometry(v, f)
    boundary = boundary_vertices(v, f)
    if len(boundary) == 0:
        return v, f
    surface = cKDTree(sample_surface(v, f, SAMPLES, np.random.default_rng(1)))
    dirs = _sphere_directions(SLAB_DIRECTIONS)
    group = np.argmax(normals @ dirs.T, axis=1)
    depths = np.arange(2 * PROBE_STEP, MAX_THICKNESS + 1e-9, PROBE_STEP)
    pieces = []

    for g, d in enumerate(dirs):
        faces = np.flatnonzero((group == g) & (normals @ d > UPWARD))
        if len(faces) == 0:
            continue
        probes = centroids[faces, None, :] - depths[None, :, None] * d
        hit, _ = surface.query(probes.reshape(-1, 3), distance_upper_bound=PROBE_HIT)
        faces = faces[~np.isfinite(hit).reshape(len(faces), len(depths)).any(axis=1)]
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
        faces, thickness = faces[ok], thickness[ok]
        if len(faces):
            pieces.append(v[f[faces]] - d * thickness[:, None, None])

    if not pieces:
        return v, f
    new_v = np.concatenate(pieces).reshape(-1, 3)
    new_f = np.arange(len(new_v)).reshape(-1, 3)[:, ::-1]
    gv, gf = keep_only_gaps(v, f, new_v, new_f)
    return append(v, f, gv, gf)


def complete(v, f, watertight=False):
    """The recommended B1 pipeline, returning (vertices, faces, inferred_mask).

    Default: the original scan faces EXACTLY as measured, plus the reconstructed surface
    only where the scan has nothing within GAP -- the track's fill policy ("keep every real
    scanned surface, fill only the gaps"). Poisson re-meshes everything, smoothing real
    detail too, so its output is used only as the source of the gap patches. The seams
    between scan and patch are not welded; for a single closed surface pass
    watertight=True and every face is labelled by its distance to the scan instead.
    """
    rebuilt_v, rebuilt_f = poisson(*slab_fill(*mirror_gaps(v, f)))
    if watertight:
        centroids, _, _ = face_geometry(rebuilt_v, rebuilt_f)
        dist, _ = cKDTree(sample_surface(v, f, SAMPLES, np.random.default_rng(0))).query(centroids)
        return rebuilt_v, rebuilt_f, dist > GAP
    pv, pf = keep_only_gaps(v, f, rebuilt_v, rebuilt_f)
    out_v, out_f = append(v, f, pv, pf)
    inferred = np.zeros(len(out_f), dtype=bool)
    inferred[len(f):] = True
    return out_v, out_f, inferred


def close_holes(v, f):
    ms = to_meshset(v, f)
    ms.meshing_repair_non_manifold_edges()
    ms.meshing_close_holes(maxholesize=100_000, selfintersection=False)
    return from_meshset(ms)


def poisson(v, f):
    """Screened Poisson with clean_scan.py's shipped parameters, single-threaded
    (multi-threaded aborts at random -- clean_scan.POISSON_THREADS_NOTE)."""
    ms = to_meshset(v, f)
    before = ms.current_mesh_id()
    ms.generate_surface_reconstruction_screened_poisson(
        depth=9, samplespernode=1.5, pointweight=4.0, threads=1
    )
    if ms.current_mesh_id() == before:
        raise RuntimeError("Poisson produced no mesh")
    ms.meshing_remove_connected_component_by_diameter(
        mincomponentdiag=pymeshlab.PercentageValue(5.0)
    )
    return from_meshset(ms)

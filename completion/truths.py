"""Synthetic ground truths for the completion benchmark: objects B1 was NOT tuned on.

Every B1 number so far comes from one slab chair. These are deliberately different shapes,
built at real scale in metres (Y up, resting on y = 0) so completion/benchmark.py can hide
parts of them and score the fill-in:

  stool   round seat on four splayed round legs with a ring stretcher -- no flat slabs
          except the seat, thin round parts everywhere else
  vase    thin-walled (5 mm) surface of revolution, open top: the inside is real surface
  lamp    disc base, thin pole, open 5 mm cone shade on three thin spokes
  sofa    lumpy rounded boxes (base, arms, tilted back, three seat cushions) on short feet

Each is ONE closed surface: the shape is a signed-distance function (primitives combined
with min/max), sampled on a voxel grid and meshed with naive surface nets, then decimated
to about the chair's face count (~65k). Meshing a union of SDFs, rather than stacking
primitive meshes, means there are no buried faces inside other parts -- a real scan could
never see those, so leaving them in would score methods on impossible surface.

Each object is then yawed to an arbitrary angle and shifted off the origin, because a real
scan never arrives axis-aligned (the v1 chair's symmetry plane sits at 164 degrees).

WHAT THESE TRUTHS DO AND DON'T REPRESENT: they are exact geometry with no scan noise, no
holes and perfect symmetry. So they test whether the algorithm's assumptions (slabs,
symmetry, thickness limits, scale constants) hold on a new shape, not how it copes with
real scanner noise. Scores here are an upper bound on what the same shapes would get from
a real scan.

Regression check -- build every truth, then score each (one run at a time on the M5 Air):
    .venv/bin/python completion/truths.py                     # writes completion/out/truths/*.obj
    .venv/bin/python completion/truths.py --only vase         # one object
    .venv/bin/python completion/benchmark.py --truth completion/out/truths/stool.obj --methods none poisson mirror+slab+poisson complete
    .venv/bin/python completion/benchmark.py --truth completion/out/truths/vase.obj  --methods none poisson mirror+slab+poisson complete
    .venv/bin/python completion/benchmark.py --truth completion/out/truths/lamp.obj  --methods none poisson mirror+slab+poisson complete
    .venv/bin/python completion/benchmark.py --truth completion/out/truths/sofa.obj  --methods none poisson mirror+slab+poisson complete
    # sanity: a complete object must come back with ~0% inferred
    .venv/bin/python completion/complete.py completion/out/truths/stool.obj -o completion/out/truths/sanity/stool.obj
The meshes are deterministic (no randomness), so a re-run rebuilds identical files.
"""

import argparse
import time
from pathlib import Path

import numpy as np
import pymeshlab
from scipy.ndimage import map_coordinates

OUT = Path(__file__).resolve().parent / "out" / "truths"
TARGET_FACES = 65_000     # the v1 chair truth has 76k
F32 = np.float32


# ---------------------------------------------------------------- SDF primitives
# All take grid coordinate arrays X, Y, Z (float32, same shape) and return distances.

def round_cylinder(X, Y, Z, c, r, half_h, round_r):
    """Vertical cylinder with rounded rims."""
    dr = np.sqrt((X - c[0]) ** 2 + (Z - c[2]) ** 2) - r + round_r
    dy = np.abs(Y - c[1]) - half_h + round_r
    return (np.minimum(np.maximum(dr, dy), 0) + np.sqrt(np.maximum(dr, 0) ** 2 + np.maximum(dy, 0) ** 2)
            - round_r)


def capsule(X, Y, Z, a, b, r):
    a, b = np.asarray(a, F32), np.asarray(b, F32)
    ba = b - a
    px, py, pz = X - a[0], Y - a[1], Z - a[2]
    h = np.clip((px * ba[0] + py * ba[1] + pz * ba[2]) / float(ba @ ba), 0, 1)
    return np.sqrt((px - ba[0] * h) ** 2 + (py - ba[1] * h) ** 2 + (pz - ba[2] * h) ** 2) - r


def torus(X, Y, Z, c, R, r):
    """Ring lying flat (in the XZ plane)."""
    q = np.sqrt((X - c[0]) ** 2 + (Z - c[2]) ** 2) - R
    return np.sqrt(q ** 2 + (Y - c[1]) ** 2) - r


def round_box(X, Y, Z, c, half, round_r, tilt_x=0.0):
    """Box with rounded edges, optionally tilted about the X axis (radians)."""
    px, py, pz = X - c[0], Y - c[1], Z - c[2]
    if tilt_x:
        cs, sn = np.cos(tilt_x), np.sin(tilt_x)
        py, pz = cs * py + sn * pz, -sn * py + cs * pz
    qx = np.abs(px) - half[0] + round_r
    qy = np.abs(py) - half[1] + round_r
    qz = np.abs(pz) - half[2] + round_r
    outside = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2)
    return outside + np.minimum(np.maximum(np.maximum(qx, qy), qz), 0) - round_r


def revolved_shell(X, Y, Z, profile, half_thickness, step=0.00025):
    """Thin shell swept around the Y axis. profile: (n, 2) polyline of (radius, height).
    The 2D distance to the polyline is tabulated on a fine (r, y) grid once, then looked up
    per voxel, so the cost does not scale with voxels x segments."""
    profile = np.asarray(profile, np.float64)
    r_max = profile[:, 0].max() + 0.02
    y_lo, y_hi = profile[:, 1].min() - 0.02, profile[:, 1].max() + 0.02
    rr, yy = np.meshgrid(np.arange(0, r_max, step), np.arange(y_lo, y_hi, step), indexing="ij")
    d = np.full(rr.shape, np.inf)
    for (r0, y0), (r1, y1) in zip(profile[:-1], profile[1:]):
        br, by = r1 - r0, y1 - y0
        t = np.clip(((rr - r0) * br + (yy - y0) * by) / (br * br + by * by), 0, 1)
        d = np.minimum(d, np.hypot(rr - r0 - br * t, yy - y0 - by * t))
    r3 = np.sqrt(X ** 2 + Z ** 2)
    coords = np.stack([r3.ravel() / step, (Y.ravel() - y_lo) / step])
    look = map_coordinates(d.astype(F32), coords, order=1, mode="nearest").reshape(X.shape)
    return look - half_thickness


# ---------------------------------------------------------------- objects
# Each returns (sdf_function, (lo, hi) bounds in metres, voxel size in metres).

def stool():
    seat_y, top_r, foot_r = 0.46, 0.11, 0.19
    legs = [(np.cos(a), np.sin(a)) for a in np.radians([45, 135, 225, 315])]
    rung_y = 0.17
    rung_R = foot_r - (foot_r - top_r) * rung_y / 0.445

    def sdf(X, Y, Z):
        d = round_cylinder(X, Y, Z, (0, seat_y, 0), 0.18, 0.02, 0.008)
        for cx, cz in legs:
            leg = capsule(X, Y, Z, (top_r * cx, 0.445, top_r * cz), (foot_r * cx * 1.03, -0.02, foot_r * cz * 1.03), 0.016)
            d = np.minimum(d, leg)
        d = np.minimum(d, torus(X, Y, Z, (0, rung_y, 0), rung_R, 0.009))
        return np.maximum(d, -Y)  # legs cut flat where they meet the floor
    return sdf, ((-0.23, -0.01, -0.23), (0.23, 0.50, 0.23)), 0.002


def vase_profile():
    H = 0.34
    y = np.linspace(0.004, H, 120)
    r = 0.05 + 0.05 * np.exp(-(((y - 0.12) / 0.08) ** 2)) + 0.02 * (y / H) ** 2
    return np.vstack([[-0.01, 0.004], np.stack([r, y], axis=1)])  # base disc, then the wall


def vase():
    profile = vase_profile()

    def sdf(X, Y, Z):
        return revolved_shell(X, Y, Z, profile, 0.0025)  # 5 mm wall
    return sdf, ((-0.13, -0.01, -0.13), (0.13, 0.36, 0.13)), 0.0012


def lamp():
    spokes = [(np.cos(a), np.sin(a)) for a in np.radians([90, 210, 330])]
    shade = [(0.14, 0.30), (0.085, 0.47)]

    def sdf(X, Y, Z):
        d = round_cylinder(X, Y, Z, (0, 0.0125, 0), 0.09, 0.0125, 0.006)
        d = np.minimum(d, capsule(X, Y, Z, (0, 0.02, 0), (0, 0.44, 0), 0.008))
        d = np.minimum(d, revolved_shell(X, Y, Z, shade, 0.0025))  # 5 mm open cone
        for cx, cz in spokes:
            d = np.minimum(d, capsule(X, Y, Z, (0, 0.44, 0), (0.085 * cx, 0.468, 0.085 * cz), 0.004))
        return d
    return sdf, ((-0.16, -0.01, -0.16), (0.16, 0.49, 0.16)), 0.0015


def sofa():
    def sdf(X, Y, Z):
        d = np.full(X.shape, np.inf, F32)
        for sx in (-0.9, 0.9):
            for sz in (-0.37, 0.37):
                d = np.minimum(d, round_cylinder(X, Y, Z, (sx, 0.04, sz), 0.025, 0.04, 0.005))
        d = np.minimum(d, round_box(X, Y, Z, (0, 0.23, 0), (0.98, 0.15, 0.44), 0.03))           # base
        for sx in (-0.89, 0.89):
            d = np.minimum(d, round_box(X, Y, Z, (sx, 0.37, 0), (0.09, 0.29, 0.44), 0.06))      # arms
        d = np.minimum(d, round_box(X, Y, Z, (0, 0.61, -0.33), (0.8, 0.25, 0.1), 0.06,
                                    tilt_x=np.radians(10)))                                     # back
        for sx in (-0.535, 0.0, 0.535):
            d = np.minimum(d, round_box(X, Y, Z, (sx, 0.44, 0.07), (0.262, 0.07, 0.33), 0.05))  # cushions
        return d
    return sdf, ((-1.02, -0.01, -0.48), (1.02, 0.90, 0.48)), 0.006


# Arbitrary yaw + offset per object: a real scan never arrives axis-aligned at the origin.
OBJECTS = {
    "stool": (stool, 23.0, (0.31, 0.0, -0.17)),
    "vase": (vase, 117.0, (-0.42, 0.0, 0.26)),
    "lamp": (lamp, 71.0, (0.12, 0.0, 0.55)),
    "sofa": (sofa, 208.0, (1.4, 0.0, -0.6)),
}


# ---------------------------------------------------------------- meshing

def surface_nets(F, lo, h):
    """Naive surface nets on grid F (negative inside). One vertex per cell the surface
    crosses (mean of its edge crossings), one quad per crossed grid edge. Closed input
    gives a closed mesh; winding is fixed afterwards by the sign of the volume."""
    inside = F < 0
    n = np.array(F.shape)
    cnt = np.zeros(tuple(n - 1), np.int8)
    for o in np.ndindex(2, 2, 2):
        cnt += inside[o[0]:n[0] - 1 + o[0], o[1]:n[1] - 1 + o[1], o[2]:n[2] - 1 + o[2]]
    active = (cnt > 0) & (cnt < 8)
    cells = np.argwhere(active)
    index = np.full(cnt.shape, -1, np.int64)
    index[tuple(cells.T)] = np.arange(len(cells))

    acc, num = np.zeros((len(cells), 3)), np.zeros(len(cells))
    for axis in range(3):
        e = np.eye(3, dtype=int)[axis]
        for o in np.ndindex(2, 2):
            off = np.insert(np.array(o), axis, 0)
            p = cells + off
            q = p + e
            fp, fq = F[tuple(p.T)].astype(np.float64), F[tuple(q.T)].astype(np.float64)
            cross = (fp < 0) != (fq < 0)
            t = np.where(cross, fp / np.where(cross, fp - fq, 1.0), 0.0)
            acc[cross] += p[cross] + t[cross, None] * e
            num[cross] += 1
    verts = lo + h * acc / num[:, None]

    quads = []
    for axis in range(3):
        b, c = (axis + 1) % 3, (axis + 2) % 3
        sl_p = [slice(None)] * 3
        sl_q = [slice(None)] * 3
        sl_p[axis], sl_q[axis] = slice(0, n[axis] - 1), slice(1, n[axis])
        edge = inside[tuple(sl_p)] != inside[tuple(sl_q)]
        start_in = inside[tuple(sl_p)]
        pts = np.argwhere(edge)
        # the four cells around the edge need indices >= 1 in the two other axes
        ok = (pts[:, b] >= 1) & (pts[:, c] >= 1) & (pts[:, b] < n[b] - 1) & (pts[:, c] < n[c] - 1)
        pts = pts[ok]
        flip = start_in[tuple(pts.T)]
        ring = []
        for db, dc in ((0, 0), (1, 0), (1, 1), (0, 1)):
            cell = pts.copy()
            cell[:, b] += db - 1
            cell[:, c] += dc - 1
            ring.append(index[tuple(cell.T)])
        ring = np.stack(ring, axis=1)
        ring[flip] = ring[flip][:, ::-1]
        quads.append(ring)
    quads = np.concatenate(quads)
    faces = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
    return verts, faces


def signed_volume(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def build(name):
    make, yaw_deg, offset = OBJECTS[name]
    sdf, (lo, hi), h = make()
    lo, hi = np.array(lo), np.array(hi)
    axes = [np.arange(lo[i], hi[i] + h, h, dtype=F32) for i in range(3)]
    X, Y, Z = np.meshgrid(*axes, indexing="ij")
    F = sdf(X, Y, Z).astype(F32)
    del X, Y, Z
    v, f = surface_nets(F, lo, h)
    if signed_volume(v, f) < 0:
        f = f[:, ::-1]

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=v, face_matrix=f.astype(np.int32)), name)
    ms.meshing_remove_duplicate_vertices()
    # Two passes with planar quadrics: a single aggressive pass folds a few dozen triangles
    # inside-out (measured: stool 57 -> 0, sofa 88 -> ~22), and even 3 folded faces on a
    # top surface become a fake "unseen" patch once the benchmark hides downward faces.
    for target in (4 * TARGET_FACES, TARGET_FACES):
        ms.meshing_decimation_quadric_edge_collapse(targetfacenum=target, preservenormal=True,
                                                    preservetopology=True, qualitythr=1.0,
                                                    planarquadric=True)
    m = ms.current_mesh()
    v, f = m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)
    folded = inward_faces(sdf, v, f)

    a = np.radians(yaw_deg)
    rot = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    v = v @ rot.T + np.array(offset)
    return v, f, F.shape, folded


def inward_faces(sdf, v, f, eps=0.0015):
    """Faces whose normal points INTO the solid (decimation folds), checked against the SDF."""
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    n = np.cross(b - a, c - a)
    n /= np.maximum(np.linalg.norm(n, axis=1), 1e-15)[:, None]
    cen = (a + b + c) / 3.0
    at = lambda p: sdf(*p.astype(F32).T)
    return int(np.sum(at(cen + eps * n) < at(cen - eps * n)))


def write_obj(path, v, f):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in v))
        fh.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="+", choices=list(OBJECTS), default=list(OBJECTS))
    args = ap.parse_args()
    for name in args.only:
        start = time.perf_counter()
        v, f, grid, folded = build(name)
        path = OUT / f"{name}.obj"
        write_obj(path, v, f)
        ms = pymeshlab.MeshSet()
        ms.load_new_mesh(str(path))
        topo = ms.get_topological_measures()
        geo = ms.get_geometric_measures()
        size = v.max(axis=0) - v.min(axis=0)
        print(f"{name:<6} {len(f):>6} faces  {size[0]:.2f} x {size[1]:.2f} x {size[2]:.2f} m  "
              f"area {geo['surface_area']:.3f} m2  grid {grid}  "
              f"boundary edges {topo['boundary_edges']}  non-manifold edges {topo['non_two_manifold_edges']}  "
              f"inward faces {folded}  "
              f"{time.perf_counter() - start:.1f}s -> {path}")


if __name__ == "__main__":
    main()

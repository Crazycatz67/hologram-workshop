"""Score completion methods on a REAL room: the Redwood Bedroom (Park, Zhou, Koltun 2017).

Track B, the real-data test of room_bench.py. The synthetic room is all exact planes; this
asks the same question of a depth-camera reconstruction scored against a laser scan.

DATA (assets/benchmark/redwood_bedroom/, see assets/benchmark/SOURCES.md)
------------------------------------------------------------------------
  laser_bedroom.ply  FARO laser scan, 16.9M coloured points, no faces       = TRUTH
  recon_bedroom.ply  Xtion depth-camera reconstruction, 5.3M verts, 10.2M faces = INPUT
  The two are in different frames (~50 m apart). Both are binary PLYs and are memory-mapped.

PIPELINE (each stage is cached in completion/out/redwood/)
----------------------------------------------------------
  prep      laser -> 1 cm voxel grid (mean per voxel); recon -> quadric decimation to
            <= 1M faces (pymeshlab), like a decimated phone room mesh.
  register  recon -> laser. Coarse: FPFH features (numpy re-implementation of Rusu 2009 /
            Open3D's) on 5 cm voxel clouds, mutual feature matches, RANSAC over 3-point
            Kabsch hypotheses, best by full-cloud fitness. Fine: point-to-plane ICP on a
            2 cm laser grid, 20 -> 2 cm correspondence radii; then a uniform-scale
            (Umeyama) ICP, because the recon is ~2% larger than the laser (rigid-only
            plateaus at ~50% fitness@2cm), and a last point-to-plane pass. Reports fitness (share of recon
            points with a laser point within 2 / 5 cm) and inlier RMSE. Open3D was tried
            (0.20.0 pip-installs on arm64 py3.13 but fails to import: it links Homebrew's
            libusb), so this is scipy/numpy only.
  bench     Hide regions of the registered recon, run the methods, score against the LASER.
            occlusion  faces a single scanner at the room's free-space centre could not
                       see (spherical z-buffer over dense surface samples) or saw at a
                       grazing angle (|cos| < MIN_COS): under the bed, behind furniture.
            holes      HOLE_COUNT round dropouts of HOLE_RADIUS on random surface.
            Hidden truth (recall) = laser points nearer the hidden recon surface than the
            kept recon, within HIDDEN_BAND of it: i.e. only surface the laser really saw
            (SG-NN's convention: never score truth no scanner observed). Precision of
            added surface is against all laser points. Metrics are room_bench.evaluate()'s:
            recall @1/2/5 cm, precision ("real") of the added surface @2/5 cm, F-scores.

CAVEATS
  * The laser and the recon disagree by the registration residual (reported) plus Xtion
    depth noise, so even the scan itself is not 100% "real" at 2 cm; read @5 cm too.
  * The laser saw from a few tripod stations: real surface it missed counts as invented
    when a method fills it. Precision is therefore a lower bound.
  * Hidden regions are simulated on a reconstruction that was itself captured from many
    viewpoints; a real phone sweep's occlusions differ in shape.

Usage:
    .venv/bin/python completion/redwood.py                      # all stages, cached
    .venv/bin/python completion/redwood.py --stage register     # stop after registration
    .venv/bin/python completion/redwood.py --methods none plane_extend --scenarios holes
"""

import argparse
import json
import resource
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark  # noqa: E402
import fill  # noqa: E402
import planes  # noqa: E402
import room_bench  # noqa: E402  -- registers plane_extend etc. in benchmark.METHODS
from fill import face_geometry, sample_surface, submesh  # noqa: E402

DATA = benchmark.REPO / "assets" / "benchmark" / "redwood_bedroom"
OUT = benchmark.OUT / "redwood"

LASER_VOXEL = 0.01        # metres; the truth grid
MAX_FACES = 1_000_000     # recon decimation target (16 GB laptop)
REG_VOXEL = 0.05          # coarse registration grid
FPFH_RADIUS = 0.25
NORMAL_K = 20
RANSAC_ITERS = 100_000
ICP_GRID = 0.02
ICP_RADII = (0.20, 0.10, 0.05, 0.03, 0.02)
ICP_SOURCE_POINTS = 300_000

VIEW_HEIGHT_NOTE = "viewpoint = free-space point nearest the bounding-box centre"
ZBUF_DEG = 0.35           # angular bin of the occlusion z-buffer
ZBUF_DENSITY = 15_000     # samples per m^2 that paint the z-buffer
ZBUF_TOL = 0.03           # metres (+1% of range) a face may lie behind the nearest surface
MIN_COS = 0.10
HOLE_COUNT = 20
HOLE_RADIUS = 0.20
HIDDEN_BAND = 0.03        # laser point must be this close to the hidden recon surface
MAX_HIDDEN_PTS = 50_000
# room_bench's sampling densities are kept: a lighter partial tree (40k/m^2, ~5 mm spacing)
# made "none" report 3.3 m^2 of ADDED surface on the synthetic room, because the scan's own
# samples were farther apart than benchmark.ADDED_THRESHOLD (5 mm).

ROOM_SHELL_PLANES = 3     # complete.py's auto-mode threshold (kept in sync by hand)


def peak_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6  # bytes on macOS


# ---------------------------------------------------------------- loading

def _ply_header(path):
    with open(path, "rb") as fh:
        head = b""
        while not head.endswith(b"end_header\n"):
            line = fh.readline()
            if not line:
                raise ValueError(f"{path}: no end_header")
            head += line
    return head.decode("ascii"), len(head)


def load_laser(path):
    head, off = _ply_header(path)
    n = int(next(l.split()[2] for l in head.splitlines() if l.startswith("element vertex")))
    dt = np.dtype([("x", "<f8"), ("y", "<f8"), ("z", "<f8"), ("r", "u1"), ("g", "u1"), ("b", "u1")])
    return np.memmap(path, dtype=dt, mode="r", offset=off, shape=(n,))


def load_recon(path):
    head, off = _ply_header(path)
    lines = head.splitlines()
    nv = int(next(l.split()[2] for l in lines if l.startswith("element vertex")))
    nf = int(next(l.split()[2] for l in lines if l.startswith("element face")))
    v = np.memmap(path, dtype="<f8", mode="r", offset=off, shape=(nv, 3))
    fdt = np.dtype([("n", "u1"), ("i", "<u4", (3,))])
    fr = np.memmap(path, dtype=fdt, mode="r", offset=off + nv * 24, shape=(nf,))
    if not np.all(fr["n"][:: max(1, nf // 100_000)] == 3):
        raise ValueError("recon has non-triangle faces")
    return np.asarray(v), fr["i"].astype(np.int64)


def voxel_mean(pts, voxel, extra=None):
    """Mean of the points in each voxel (and of `extra` columns, e.g. colour)."""
    key = np.floor((pts - pts.min(axis=0)) / voxel).astype(np.int64)
    dims = key.max(axis=0) + 1
    lin = (key[:, 0] * dims[1] + key[:, 1]) * dims[2] + key[:, 2]
    _, inv, cnt = np.unique(lin, return_inverse=True, return_counts=True)
    out = np.stack([np.bincount(inv, pts[:, i]) for i in range(3)], axis=1) / cnt[:, None]
    if extra is None:
        return out
    ex = np.stack([np.bincount(inv, extra[:, i]) for i in range(extra.shape[1])], axis=1) / cnt[:, None]
    return out, ex


def prep():
    OUT.mkdir(parents=True, exist_ok=True)
    cache = OUT / "prep.npz"
    if cache.exists():
        d = np.load(cache)
        return d["laser"], d["laser_rgb"], d["rv"], d["rf"]
    t = time.perf_counter()
    raw = load_laser(DATA / "laser_bedroom.ply")
    pts = np.stack([raw["x"], raw["y"], raw["z"]], axis=1)
    rgb = np.stack([raw["r"], raw["g"], raw["b"]], axis=1).astype(np.float32)
    laser, laser_rgb = voxel_mean(pts, LASER_VOXEL, rgb)
    print(f"laser: {len(raw):,} points -> {len(laser):,} at {LASER_VOXEL * 100:.0f} cm  "
          f"extent {np.ptp(laser, axis=0).round(2)} m  ({time.perf_counter() - t:.0f}s)")
    del pts, rgb, raw

    import pymeshlab
    t = time.perf_counter()
    v, f = load_recon(DATA / "recon_bedroom.ply")
    print(f"recon: {len(v):,} verts {len(f):,} faces  extent {np.ptp(v, axis=0).round(2)} m")
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=v, face_matrix=f.astype(np.int32)))
    del v, f
    ms.meshing_remove_duplicate_vertices()
    ms.meshing_remove_unreferenced_vertices()
    ms.meshing_decimation_quadric_edge_collapse(targetfacenum=MAX_FACES, preservenormal=True,
                                                 planarquadric=True, qualitythr=0.3)
    ms.meshing_remove_unreferenced_vertices()
    m = ms.current_mesh()
    rv, rf = m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)
    del ms
    print(f"recon decimated: {len(rv):,} verts {len(rf):,} faces ({time.perf_counter() - t:.0f}s)")
    np.savez(cache, laser=laser, laser_rgb=laser_rgb.astype(np.uint8), rv=rv, rf=rf)
    return laser, laser_rgb, rv, rf


# ---------------------------------------------------------------- registration

def pca_normals(pts, k=NORMAL_K, toward=None, chunk=200_000):
    tree = cKDTree(pts)
    nrm = np.empty_like(pts)
    for s in range(0, len(pts), chunk):
        _, idx = tree.query(pts[s:s + chunk], k=k)
        nb = pts[idx] - pts[idx].mean(axis=1, keepdims=True)
        cov = np.einsum("nki,nkj->nij", nb, nb)
        nrm[s:s + chunk] = np.linalg.eigh(cov)[1][:, :, 0]
    if toward is not None:   # orient into the room, so source and target agree on sign
        flip = np.einsum("ij,ij->i", nrm, toward - pts) < 0
        nrm[flip] *= -1
    return nrm


def fpfh(pts, nrm, radius=FPFH_RADIUS, kmax=60):
    """Fast Point Feature Histograms, 33-D (11 bins x 3 angles), as in Open3D."""
    tree = cKDTree(pts)
    d, idx = tree.query(pts, k=kmax + 1, distance_upper_bound=radius)
    d, idx = d[:, 1:], idx[:, 1:]
    valid = np.isfinite(d)
    idx = np.where(valid, idx, 0)
    n = len(pts)
    p1, n1 = pts[:, None, :], nrm[:, None, :]
    p2, n2 = pts[idx], nrm[idx]
    dp = p2 - p1
    dist = np.linalg.norm(dp, axis=2)
    dist_safe = np.where(dist > 0, dist, 1.0)
    dpn = dp / dist_safe[..., None]
    a1 = np.einsum("nki,nki->nk", np.broadcast_to(n1, dp.shape), dpn)
    a2 = np.einsum("nki,nki->nk", n2, dpn)
    swap = np.arccos(np.clip(np.abs(a1), 0, 1)) > np.arccos(np.clip(np.abs(a2), 0, 1))
    u = np.where(swap[..., None], n2, np.broadcast_to(n1, dp.shape))
    w2 = np.where(swap[..., None], np.broadcast_to(n1, dp.shape), n2)
    dpn = np.where(swap[..., None], -dpn, dpn)
    f3 = np.where(swap, -a2, a1)
    vv = np.cross(dpn, u)
    vn = np.linalg.norm(vv, axis=2)
    ok = valid & (dist > 0) & (vn > 1e-9)
    vv = vv / np.where(vn > 0, vn, 1.0)[..., None]
    ww = np.cross(u, vv)
    f2 = np.einsum("nki,nki->nk", vv, w2)
    f1 = np.arctan2(np.einsum("nki,nki->nk", ww, w2), np.einsum("nki,nki->nk", u, w2))
    bins = [np.clip((11 * (f1 + np.pi) / (2 * np.pi)).astype(int), 0, 10),
            np.clip((11 * (f2 + 1) * 0.5).astype(int), 0, 10),
            np.clip((11 * (f3 + 1) * 0.5).astype(int), 0, 10)]
    cnt = np.maximum(ok.sum(axis=1), 1)
    spfh = np.zeros((n, 33))
    rows = np.repeat(np.arange(n)[:, None], idx.shape[1], axis=1)
    for b, h in enumerate(bins):
        np.add.at(spfh, (rows[ok], b * 11 + h[ok]), (100.0 / cnt[:, None] * np.ones_like(d))[ok])
    wgt = np.where(ok, 1.0 / dist_safe, 0.0)
    nb = np.einsum("nk,nkj->nj", wgt, spfh[idx])
    for b in range(3):
        s = nb[:, b * 11:(b + 1) * 11].sum(axis=1, keepdims=True)
        nb[:, b * 11:(b + 1) * 11] *= 100.0 / np.where(s > 0, s, 1.0)
    return spfh + nb


def kabsch(a, b):
    """Batched rigid fit a -> b; a, b: (B, k, 3). Returns R (B,3,3), t (B,3)."""
    ca, cb = a.mean(axis=1), b.mean(axis=1)
    h = np.einsum("bki,bkj->bij", a - ca[:, None], b - cb[:, None])
    u, _, vt = np.linalg.svd(h)
    dd = np.sign(np.linalg.det(np.einsum("bij,bjk->bik", vt.transpose(0, 2, 1), u.transpose(0, 2, 1))))
    vt[:, 2, :] *= dd[:, None]
    r = np.einsum("bij,bjk->bik", vt.transpose(0, 2, 1), u.transpose(0, 2, 1))
    return r, cb - np.einsum("bij,bj->bi", r, ca)


def ransac(src, dst, fs, fd, rng, thr=1.5 * REG_VOXEL, iters=RANSAC_ITERS, batch=500):
    _, s2d = cKDTree(fd).query(fs)
    _, d2s = cKDTree(fs).query(fd)
    mutual = d2s[s2d] == np.arange(len(fs))
    ci = np.nonzero(mutual)[0] if mutual.sum() >= 1000 else np.arange(len(fs))
    cs, cd = src[ci], dst[s2d[ci]]
    print(f"  correspondences: {len(ci):,} ({'mutual' if mutual.sum() >= 1000 else 'one-way'})")
    best = []
    for _ in range(iters // batch):
        tri = rng.integers(0, len(ci), size=(batch, 3))
        a, b = cs[tri], cd[tri]
        ea = np.linalg.norm(a - np.roll(a, 1, axis=1), axis=2)
        eb = np.linalg.norm(b - np.roll(b, 1, axis=1), axis=2)
        good = np.all((np.minimum(ea, eb) > 0.9 * np.maximum(ea, eb)) & (ea > 0.3), axis=1)
        if not good.any():
            continue
        r, t = kabsch(a[good], b[good])
        moved = np.einsum("bij,nj->bni", r, cs) + t[:, None]
        inl = (np.linalg.norm(moved - cd[None], axis=2) < thr).sum(axis=1)
        best += [(int(c), ri, ti) for c, ri, ti in zip(inl, r, t)]
        best = sorted(best, key=lambda x: -x[0])[:30]
    tree = cKDTree(dst)
    scored = []
    for c, r, t in best:
        d, _ = tree.query(src @ r.T + t, distance_upper_bound=thr)
        scored.append((float(np.mean(d < thr)), c, r, t))
    fit, c, r, t = max(scored, key=lambda x: x[0])
    print(f"  RANSAC best: {c} corr inliers, fitness@{thr * 100:.1f}cm {fit:.1%} "
          f"(runner-up {sorted(s[0] for s in scored)[-2]:.1%})")
    return r, t


def _rot(w):
    th = np.linalg.norm(w)
    if th < 1e-12:
        return np.eye(3)
    k = w / th
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * kx + (1 - np.cos(th)) * kx @ kx


def icp_point_to_plane(src, dst, dst_n, r, t, radii=ICP_RADII, iters=15):
    tree = cKDTree(dst)
    for rad in radii:
        for _ in range(iters):
            s = src @ r.T + t
            d, i = tree.query(s, distance_upper_bound=rad)
            m = np.isfinite(d)
            s, q, n = s[m], dst[i[m]], dst_n[i[m]]
            a = np.hstack([np.cross(s, n), n])
            b = np.einsum("ij,ij->i", q - s, n)
            x = np.linalg.solve(a.T @ a, a.T @ b)
            dr = _rot(x[:3])
            r, t = dr @ r, dr @ t + x[3:]
            if np.linalg.norm(x) < 1e-6:
                break
    return r, t


def similarity_icp(src, tree, dst, scale, r, t, radii=(0.10, 0.05, 0.03), iters=10):
    """Point-to-point ICP with a uniform scale (Umeyama 1991). x -> scale * r @ x + t.
    Needed because the Xtion recon is ~2% larger than the laser: rigid ICP plateaus at
    ~50% fitness@2cm, a single scale factor takes it to ~77% (measured 2026-10-01)."""
    for rad in radii:
        for _ in range(iters):
            moved = scale * src @ r.T + t
            d, i = tree.query(moved, distance_upper_bound=rad)
            m = np.isfinite(d)
            a, b = moved[m], dst[i[m]]
            ma, mb = a.mean(0), b.mean(0)
            u, sv, vt = np.linalg.svd((b - mb).T @ (a - ma) / len(a))
            dd = np.eye(3)
            dd[2, 2] = np.sign(np.linalg.det(u @ vt))
            rs = u @ dd @ vt
            sc = np.trace(np.diag(sv) @ dd) / (a - ma).var(0).sum()
            scale, r, t = sc * scale, rs @ r, sc * rs @ (t - ma) + mb
    return scale, r, t


def fitness(src, tree, thr):
    d, _ = tree.query(src, distance_upper_bound=thr)
    m = d < thr
    return float(m.mean()), float(np.sqrt(np.mean(d[m] ** 2))) if m.any() else float("nan")


def register(laser, rv, rf, rng):
    cache = OUT / "register.json"
    if cache.exists():
        d = json.loads(cache.read_text())
        print(f"registration (cached): {d['report']}")
        return d["scale"], np.array(d["R"]), np.array(d["t"]), d["report"]
    t0 = time.perf_counter()
    src_pts = sample_surface(rv, rf, 3_000_000, rng)
    src = voxel_mean(src_pts, REG_VOXEL)
    dst = voxel_mean(laser, REG_VOXEL)
    print(f"  coarse clouds: recon {len(src):,}  laser {len(dst):,} at {REG_VOXEL * 100:.0f} cm")
    ns = pca_normals(src, toward=(src.min(0) + src.max(0)) / 2)
    nd = pca_normals(dst, toward=(dst.min(0) + dst.max(0)) / 2)
    fs, fd = fpfh(src, ns), fpfh(dst, nd)
    r, t = ransac(src, dst, fs, fd, rng)
    t_coarse = time.perf_counter() - t0
    fine = voxel_mean(laser, ICP_GRID)
    fine_n = pca_normals(fine)
    sub = src_pts[rng.choice(len(src_pts), ICP_SOURCE_POINTS, replace=False)]
    coarse_fit = fitness(sub @ r.T + t, cKDTree(fine), 0.05)
    r, t = icp_point_to_plane(sub, fine, fine_n, r, t)
    full_tree = cKDTree(laser)
    rigid_fit = fitness(sub @ r.T + t, full_tree, 0.02)
    scale, r, t = similarity_icp(sub, full_tree, laser, 1.0, r, t)
    r, t = icp_point_to_plane(scale * sub, fine, fine_n, r, t, radii=(0.03, 0.02))
    moved = scale * sub @ r.T + t
    report = {
        "coarse_fitness5cm": round(coarse_fit[0], 4), "coarse_rmse5cm_mm": round(coarse_fit[1] * 1000, 1),
        "fitness2cm": None, "rmse2cm_mm": None, "fitness5cm": None, "rmse5cm_mm": None,
        "rigid_only_fitness2cm": round(rigid_fit[0], 4), "scale": round(float(scale), 5),
        "coarse_seconds": round(t_coarse, 1), "seconds": round(time.perf_counter() - t0, 1),
        "rotation_deg": round(float(np.degrees(np.arccos(np.clip((np.trace(r) - 1) / 2, -1, 1)))), 2),
        "translation_m": round(float(np.linalg.norm(t)), 2),
    }
    for thr in (0.02, 0.05):
        fi, rm = fitness(moved, full_tree, thr)
        report[f"fitness{int(thr * 100)}cm"] = round(fi, 4)
        report[f"rmse{int(thr * 100)}cm_mm"] = round(rm * 1000, 1)
    # Laser -> recon too: how much of the laser the recon covers (the recon's own gaps).
    rtree = cKDTree(moved)
    lsub = laser[rng.choice(len(laser), min(len(laser), 500_000), replace=False)]
    report["laser_covered_by_recon5cm"] = round(fitness(lsub, rtree, 0.05)[0], 4)
    cache.write_text(json.dumps({"scale": scale, "R": r.tolist(), "t": t.tolist(), "report": report}, indent=2))
    print(f"registration: {report}")
    return scale, r, t, report


# ---------------------------------------------------------------- hiding

def free_viewpoint(v, tree):
    """Free-space point nearest the bounding-box centre (planes._viewpoint is the bare
    centre; in a bedroom that can sit inside the bed)."""
    c = (v.min(0) + v.max(0)) / 2
    g = np.stack(np.meshgrid(*[np.linspace(-0.6, 0.6, 7)] * 3, indexing="ij"), -1).reshape(-1, 3) + c
    clear, _ = tree.query(g)
    ok = clear > 0.5
    cand = g[ok] if ok.any() else g[[np.argmax(clear)]]
    return cand[np.argmin(np.linalg.norm(cand - c, axis=1))]


def occluded_faces(v, f, eye, rng):
    """Faces a scanner at `eye` cannot see: behind nearer surface in a spherical z-buffer
    painted by dense samples, or at a grazing angle."""
    _, _, area = face_geometry(v, f)
    pts = sample_surface(v, f, int(area.sum() * ZBUF_DENSITY), rng)
    nb = int(round(360 / ZBUF_DEG))

    def bins(p):
        d = p - eye
        rng_ = np.linalg.norm(d, axis=1)
        az = np.arctan2(d[:, 1], d[:, 0])
        el = np.arccos(np.clip(d[:, 2] / rng_, -1, 1))
        b = (np.clip((el / np.pi * (nb // 2)).astype(int), 0, nb // 2 - 1) * nb
             + np.clip(((az + np.pi) / (2 * np.pi) * nb).astype(int), 0, nb - 1))
        return b, rng_
    b, r = bins(pts)
    zbuf = np.full(nb * (nb // 2), np.inf)
    np.minimum.at(zbuf, b, r)
    cen = v[f].mean(axis=1)
    fb, fr = bins(cen)
    behind = fr > zbuf[fb] + ZBUF_TOL + 0.01 * fr
    nrm = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    cosv = np.abs(np.einsum("ij,ij->i", nrm, (eye - cen) / fr[:, None]))
    return behind | (cosv < MIN_COS)


def hole_faces(v, f, rng):
    _, _, area = face_geometry(v, f)
    cen = v[f].mean(axis=1)
    seeds = cen[rng.choice(len(f), HOLE_COUNT, replace=False, p=area / area.sum())]
    d, _ = cKDTree(seeds).query(cen)
    return d < HOLE_RADIUS


def hidden_truth(laser, v, f, hide, rng):
    """Laser points the hidden recon surface stood for: nearer the hidden surface than the
    kept scan, and within HIDDEN_BAND of it. Only surface the laser actually saw."""
    hv, hf = submesh(v, f, hide)
    kv, kf = submesh(v, f, ~hide)
    hs = sample_surface(hv, hf, int(face_geometry(hv, hf)[2].sum() * 20_000), rng)
    ks = sample_surface(kv, kf, int(face_geometry(kv, kf)[2].sum() * 20_000), rng)
    dh, _ = cKDTree(hs).query(laser, distance_upper_bound=HIDDEN_BAND)
    cand = np.isfinite(dh)
    dk, _ = cKDTree(ks).query(laser[cand], distance_upper_bound=HIDDEN_BAND)
    sel = laser[cand][dh[cand] < dk]
    if len(sel) > MAX_HIDDEN_PTS:
        sel = sel[rng.choice(len(sel), MAX_HIDDEN_PTS, replace=False)]
    return sel, (kv, kf), (hv, hf), int(cand.sum())


# ---------------------------------------------------------------- methods

def auto(v, f):
    """complete.py --mode auto, as a benchmark method."""
    shells = int(sum(bool(pl.shell) for pl in planes.find_planes(v, f, rng=np.random.default_rng(0))))
    mode = "room" if shells >= ROOM_SHELL_PLANES else "object"
    print(f"      [auto] {shells} shell planes -> {mode} mode", flush=True)
    if mode == "room":
        return planes.plane_extend(v, f)
    return fill.complete(v, f)[:2]


def poisson_preclean(v, f):
    """fill.poisson's exact parameters plus pymeshlab's preclean=True. PROTOTYPE of a
    proposed fill.py fix: the real recon has ~100-150 vertices whose faces are back-to-back
    folds (normals cancel to zero), and screened Poisson refuses null vertex normals."""
    import pymeshlab
    ms = fill.to_meshset(v, f)
    before = ms.current_mesh_id()
    ms.generate_surface_reconstruction_screened_poisson(
        depth=9, samplespernode=1.5, pointweight=4.0, threads=1, preclean=True)
    if ms.current_mesh_id() == before:
        raise RuntimeError("Poisson produced no mesh")
    ms.meshing_remove_connected_component_by_diameter(mincomponentdiag=pymeshlab.PercentageValue(5.0))
    return fill.from_meshset(ms)


DUP_COS = np.cos(np.radians(10))
DUP_GAP = 0.25   # metres


def merged_shells(v, f):
    """plane_extend with near-duplicate shell planes demoted to surfaces. PROTOTYPE of a
    proposed planes.py fix: a real floor/wall is not one exact plane (this bedroom's floor
    spans ~8 cm in the laser too), so RANSAC at DIST_TOL splits it into parallel fragments;
    a small fragment passes the shell test and is extended over the whole room, 5-15 cm
    off the real surface. Rule: a shell plane with a LARGER shell plane of the same
    orientation within DUP_GAP is only a surface (it still fills its own holes)."""
    pls = planes.find_planes(v, f, rng=np.random.default_rng(0))
    shells = [p for p in pls if p.shell]
    for p in shells:
        if any(q is not p and q.area > p.area and q.normal @ p.normal > DUP_COS
               and abs(q.offset - p.offset) < DUP_GAP for q in shells):
            p.shell = False
    return planes.plane_extend(v, f, planes=pls)


benchmark.METHODS["auto"] = auto   # registered at import: the spawned child re-imports this file
benchmark.METHODS["poisson[preclean]"] = poisson_preclean
benchmark.METHODS["plane_extend[merged-shells]"] = merged_shells
METHODS = ["none", "poisson", "poisson[preclean]", "plane_extend", "auto", "plane_extend[merged-shells]"]


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", choices=["prep", "register", "bench"], default="bench",
                    help="run up to and including this stage (earlier stages are cached)")
    ap.add_argument("--methods", nargs="+", default=METHODS, choices=list(benchmark.METHODS))
    ap.add_argument("--scenarios", nargs="+", default=["occlusion", "holes"], choices=["occlusion", "holes"])
    ap.add_argument("--save-meshes", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    t0 = time.perf_counter()

    laser, _, rv, rf = prep()
    print(f"[prep] laser {len(laser):,} pts, recon {len(rf):,} faces; peak {peak_mb():.0f} MB")
    if args.stage == "prep":
        return
    scale, r, t, report = register(laser, rv, rf, rng)
    print(f"[register] peak {peak_mb():.0f} MB")
    if args.stage == "register":
        return

    # Recon into the laser frame. Rigid + one uniform scale (the recon's ~2% depth-scale
    # error); its shape is otherwise unchanged. Scoring happens in metres of the laser.
    v = scale * rv @ r.T + t
    lo, hi = v.min(0) - 0.3, v.max(0) + 0.3
    laser = laser[np.all((laser > lo) & (laser < hi), axis=1)]
    rtree = cKDTree(v)
    eye = free_viewpoint(v, rtree)
    del rtree
    _, _, area = face_geometry(v, rf)
    # Sampling residue of the scan itself scales with its area: 0.03 m^2 of "added" on a
    # 70 m^2 partial gave the do-nothing baseline a fake precision. 0.1% of the area.
    room_bench.MIN_ADDED = 0.001 * area.sum()
    print(f"[bench] recon area {area.sum():.1f} m2; laser in its box {len(laser):,} pts; "
          f"viewpoint {eye.round(2)}")
    hides = {}
    if "occlusion" in args.scenarios:
        hides["occlusion"] = occluded_faces(v, rf, eye, rng)
    if "holes" in args.scenarios:
        hides["holes"] = hole_faces(v, rf, rng)
    rows, info = [], {"registration": report, "viewpoint": eye.tolist()}
    for name, hide in hides.items():
        pts, partial, hidden, band = hidden_truth(laser, v, rf, hide, rng)
        h_area = face_geometry(*hidden)[2].sum()
        print(f"[{name}] hid {hide.sum():,} faces, {h_area:.2f} m2 ({h_area / area.sum():.1%}); "
              f"{band:,} laser pts in band, {len(pts):,} scored as hidden truth")
        info[name] = {"hidden_faces": int(hide.sum()), "hidden_m2": round(float(h_area), 2),
                      "hidden_share": round(float(h_area / area.sum()), 4), "truth_pts": len(pts)}
        if args.save_meshes:
            benchmark.write_obj(OUT / name / "partial.obj", *partial)
            benchmark.write_obj(OUT / name / "hidden.obj", *hidden)
        rows += room_bench.evaluate(name, partial, pts, laser, args.methods, rng, save=False)
    benchmark.summarize(rows, args.methods)
    room_bench.summarize_lit(rows, args.methods)
    info["parent_peak_mb"] = round(peak_mb())
    info["wall_seconds"] = round(time.perf_counter() - t0, 1)
    (OUT / "results.json").write_text(json.dumps({"info": info, "rows": rows}, indent=2))
    print(f"\nparent peak {peak_mb():.0f} MB, wall {time.perf_counter() - t0:.0f}s -> {OUT / 'results.json'}")


if __name__ == "__main__":
    main()

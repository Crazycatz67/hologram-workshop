"""Score scan-completion methods against geometry we deliberately hid from them.

Phase B0 of plans/scan-completion/ROADMAP.md. The question every completion method has to
answer is "how close is what you filled in to what was really there?", and a screenshot
cannot answer it. So: take the most complete mesh we have, cut away the regions a real
scan typically misses, give each method only what is left, and measure its output against
the part that was cut.

SCENARIOS (what gets hidden)
----------------------------
  underside   Downward-facing surfaces. A phone held above the object never sees them.
  wall        The side of the object pushed against a wall: faces pointing toward the
              wall AND lying in the band of the object nearest to it. Run once per
              direction along the footprint's two principal axes (4 walls) and averaged,
              so the result does not depend on which way the chair happened to face.
  holes       Scattered round patches, the ordinary dropouts of a handheld scan.

METRICS
-------
  completeness   How much of the hidden surface the method recovered: for points sampled on
                 the hidden region, the distance to the method's output. Reported as mean
                 (mm) and as coverage -- share of hidden points within 1 cm / 2 cm.
  invention      How trustworthy the geometry the method ADDED is: output points more than
                 5 mm from the partial input count as added; each is measured against the
                 full ground truth. Reported as added area and the share of added points
                 within 2 cm of real surface. A method can score perfect completeness by
                 wrapping everything in a blob; this is the number that catches it.
  time / memory  Wall time and peak resident memory of the method alone, each method run
                 in its own process so one method's memory cannot be billed to another.
                 The target machine is a fanless MacBook Air M5 16 GB, so these matter.

CAVEAT ON GROUND TRUTH
----------------------
The default ground truth is assets/chair/chair_clean.obj, which is itself the output of
clean_scan.py (mirrored + Poisson-filled). It is the most complete chair geometry we have,
not a perfect one, so treat scores as comparisons BETWEEN methods rather than absolute
accuracy. A better ground truth (a scan with the chair flipped to capture its underside,
registered to the upright scan) would tighten this.

Usage:
    .venv/bin/python completion/benchmark.py                      # all methods, all scenarios
    .venv/bin/python completion/benchmark.py --methods none poisson --scenarios underside
    .venv/bin/python completion/benchmark.py --save-meshes        # write OBJs for viewing

Saved meshes land in completion/out/ and open in the v1 viewer, e.g.
    http://localhost:8080/index.html?model=completion/out/underside/poisson.obj&plain=1
"""

import argparse
import json
import multiprocessing as mp
import os
import resource
import sys
import time
from pathlib import Path

import numpy as np
import pymeshlab
from scipy.spatial import cKDTree

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
import clean_scan  # noqa: E402  -- reuse the shipped symmetry search, never fork it

OUT = REPO / "completion" / "out"

TRUTH_SAMPLES = 20_000     # points on the hidden region
OUTPUT_SAMPLES = 250_000   # points on a method's output; ~3 mm spacing on a chair-sized mesh
ADDED_THRESHOLD = 0.005    # metres; output farther than this from the input counts as added

# Faces count as "facing" a direction when dot(face normal, direction) exceeds this --
# about 70 degrees, generous enough to include the rounded edges a scanner also misses.
FACING = 0.35
WALL_BAND = 0.35           # share of the object's depth nearest the wall that is hidden
HOLE_COUNT = 10
HOLE_RADIUS = 0.05         # metres


# ---------------------------------------------------------------- mesh helpers

def load_vf(path):
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(str(path))
    m = ms.current_mesh()
    return m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)


def face_geometry(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    cross = np.cross(b - a, c - a)
    area2 = np.linalg.norm(cross, axis=1)
    normals = cross / np.maximum(area2, 1e-12)[:, None]
    return (a + b + c) / 3.0, normals, area2 / 2.0


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


def to_meshset(v, f):
    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=v, face_matrix=f.astype(np.int32)), "input")
    ms.compute_normal_per_vertex()
    return ms


def from_meshset(ms):
    m = ms.current_mesh()
    return m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)


def write_obj(path, v, f):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in v))
        fh.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f))


# ---------------------------------------------------------------- scenarios

def footprint_axes(v):
    """The object's two principal horizontal directions. A chair scan sits at whatever
    angle it was captured at (the v1 chair's symmetry plane is at 164 degrees), so walls
    are placed along the object's own axes, not the file's X and Z."""
    xz = v[:, [0, 2]] - v[:, [0, 2]].mean(axis=0)
    _, vecs = np.linalg.eigh(np.cov(xz.T))
    return [np.array([vecs[0, i], 0.0, vecs[1, i]]) for i in (1, 0)]


def hidden_masks(v, f, rng):
    """name -> boolean face mask of what the scanner 'missed'."""
    centroids, normals, _ = face_geometry(v, f)
    masks = {"underside": normals[:, 1] < -FACING}

    for i, axis in enumerate(footprint_axes(v)):
        for sign, label in ((1, "+"), (-1, "-")):
            d = sign * axis
            depth = centroids @ d
            near_wall = depth > depth.max() - WALL_BAND * (depth.max() - depth.min())
            masks[f"wall{label}{'uv'[i]}"] = (normals @ d > FACING) & near_wall

    seeds = centroids[rng.choice(len(f), HOLE_COUNT, replace=False)]
    dist = np.min(np.linalg.norm(centroids[:, None, :] - seeds[None, :, :], axis=2), axis=1)
    masks["holes"] = dist < HOLE_RADIUS
    return masks


def scenario_group(name):
    return "wall" if name.startswith("wall") else name


# ---------------------------------------------------------------- methods
# Each takes the partial mesh and returns a completed one. Parameters mirror
# clean_scan.py's shipped defaults so the baseline is "what the pipeline does today".

def m_none(v, f):
    return v, f


def m_close_holes(v, f):
    ms = to_meshset(v, f)
    ms.meshing_repair_non_manifold_edges()
    ms.meshing_close_holes(maxholesize=100_000, selfintersection=False)
    return from_meshset(ms)


def _poisson(ms):
    before = ms.current_mesh_id()
    # threads=1: multi-threaded Poisson aborts at random -- see clean_scan.POISSON_THREADS_NOTE
    ms.generate_surface_reconstruction_screened_poisson(depth=9, samplespernode=1.5, pointweight=4.0, threads=1)
    if ms.current_mesh_id() == before:
        raise RuntimeError("Poisson produced no mesh")
    ms.meshing_remove_connected_component_by_diameter(
        mincomponentdiag=pymeshlab.PercentageValue(5.0)
    )
    return from_meshset(ms)


def m_poisson(v, f):
    return _poisson(to_meshset(v, f))


def m_symmetry_poisson(v, f):
    """clean_scan.py's shipped COMPLETE stage: merge a FULL mirrored copy, then Poisson.
    Kept as the baseline because it is what the pipeline does today -- but on an object
    that is already close to symmetric the copy lands almost exactly on the original, and
    Poisson can crash natively on the coincident surfaces (seen on chair_clean.obj:
    "Failed to close loop"). m_mirror_gaps is the fix."""
    ms = to_meshset(v, f)
    normal, offset, overlap = clean_scan.find_symmetry_plane(v, np.random.default_rng(0))
    if overlap >= clean_scan.SYMMETRY_MIN_OVERLAP:
        clean_scan.symmetrize(ms, normal, offset)
    return _poisson(ms)


MIRROR_GAP = 0.01  # metres; a mirrored face farther than this from the scan fills a real gap


def mirror_gaps(v, f):
    """Mirror the object across its symmetry plane, but keep ONLY the mirrored faces that
    land where the scan has no surface. Everything the scanner did see stays exactly as
    measured; the mirror contributes geometry only to the gaps. Returns the partial mesh
    with those faces appended, or the input unchanged if the object isn't symmetric."""
    normal, offset, overlap = clean_scan.find_symmetry_plane(v, np.random.default_rng(0))
    if overlap < clean_scan.SYMMETRY_MIN_OVERLAP:
        return v, f
    mv = v - 2.0 * ((v @ normal) - offset)[:, None] * normal[None, :]
    mf = f[:, ::-1]  # mirroring flips winding; flip back so normals stay outward
    centroids, _, _ = face_geometry(mv, mf)
    dist, _ = cKDTree(sample_surface(v, f, OUTPUT_SAMPLES, np.random.default_rng(0))).query(centroids)
    gv, gf = submesh(mv, mf, dist > MIRROR_GAP)
    return np.vstack([v, gv]), np.vstack([f, gf + len(v)])


def m_mirror_gaps(v, f):
    return mirror_gaps(v, f)


def m_mirror_gaps_poisson(v, f):
    return _poisson(to_meshset(*mirror_gaps(v, f)))


METHODS = {
    "none": m_none,
    "close_holes": m_close_holes,
    "poisson": m_poisson,
    "symmetry+poisson": m_symmetry_poisson,
    "mirror_gaps": m_mirror_gaps,
    "mirror_gaps+poisson": m_mirror_gaps_poisson,
}

METHOD_TIMEOUT = 600  # seconds; a native hang must become a FAILED row, not a stuck run


def _run_in_child(method, v, f, queue):
    start = time.perf_counter()
    try:
        out_v, out_f = METHODS[method](v, f)
        err = None
    except Exception as e:  # report the failure as a result row, don't abort the run
        out_v, out_f, err = np.empty((0, 3)), np.empty((0, 3), dtype=np.int64), repr(e)
    elapsed = time.perf_counter() - start
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_mb = peak / 1e6 if sys.platform == "darwin" else peak / 1e3  # bytes on macOS, KiB on Linux
    queue.put((out_v, out_f, elapsed, peak_mb, err))


def run_method(method, v, f):
    """Run one method in its own process. PyMeshLab's native code can abort the whole
    process (Poisson does, on coincident surfaces) or hang, so the parent never blocks
    on a child that has died: it polls, and a crash or timeout becomes an error row."""
    ctx = mp.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=_run_in_child, args=(method, v, f, queue))
    proc.start()
    start = time.perf_counter()
    while True:
        try:
            result = queue.get(timeout=1.0)
            proc.join()
            return result
        except Exception:  # queue.Empty
            elapsed = time.perf_counter() - start
            if not proc.is_alive():
                # A child that exited cleanly may still be flushing its (large) result
                # through the pipe; wait for it before calling anything a crash.
                try:
                    result = queue.get(timeout=30.0)
                    proc.join()
                    return result
                except Exception:
                    err = f"crashed in native code (exit code {proc.exitcode})"
            elif elapsed > METHOD_TIMEOUT:
                proc.kill()
                err = f"timed out after {METHOD_TIMEOUT}s"
            else:
                continue
            proc.join()
            return np.empty((0, 3)), np.empty((0, 3), dtype=np.int64), elapsed, 0.0, err


# ---------------------------------------------------------------- scoring

def score(out_v, out_f, partial_tree, truth_tree, hidden_pts, rng):
    if len(out_f) == 0:
        return None
    out_pts = sample_surface(out_v, out_f, OUTPUT_SAMPLES, rng)
    d_hidden, _ = cKDTree(out_pts).query(hidden_pts)

    d_input, _ = partial_tree.query(out_pts)
    added = out_pts[d_input > ADDED_THRESHOLD]
    _, _, out_area = face_geometry(out_v, out_f)
    added_area = out_area.sum() * len(added) / len(out_pts)
    if len(added):
        d_added, _ = truth_tree.query(added)
        added_ok = float(np.mean(d_added < 0.02))
    else:
        added_ok = float("nan")

    return {
        "mean_mm": float(d_hidden.mean() * 1000),
        "cov1cm": float(np.mean(d_hidden < 0.01)),
        "cov2cm": float(np.mean(d_hidden < 0.02)),
        "added_m2": float(added_area),
        "added_ok2cm": added_ok,
    }


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--truth", default=str(REPO / "assets/chair/chair_clean.obj"))
    ap.add_argument("--methods", nargs="+", default=list(METHODS), choices=list(METHODS))
    ap.add_argument("--scenarios", nargs="+", default=["underside", "wall", "holes"],
                    choices=["underside", "wall", "holes"])
    ap.add_argument("--save-meshes", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    v, f = load_vf(args.truth)
    _, _, area = face_geometry(v, f)
    size = v.max(axis=0) - v.min(axis=0)
    print(f"ground truth: {Path(args.truth).name}  {len(v)} verts  {len(f)} faces  "
          f"{size[0]:.2f} x {size[1]:.2f} x {size[2]:.2f} m  area {area.sum():.2f} m2\n")

    truth_tree = cKDTree(sample_surface(v, f, OUTPUT_SAMPLES, rng))
    rows = []
    for name, mask in hidden_masks(v, f, rng).items():
        group = scenario_group(name)
        if group not in args.scenarios:
            continue
        pv, pf = submesh(v, f, ~mask)
        hv, hf = submesh(v, f, mask)
        hidden_pts = sample_surface(hv, hf, TRUTH_SAMPLES, rng)
        partial_tree = cKDTree(sample_surface(pv, pf, OUTPUT_SAMPLES, rng))
        share = area[mask].sum() / area.sum()
        print(f"[{name}] hid {mask.sum()} faces ({share:.1%} of surface)")
        if args.save_meshes:
            write_obj(OUT / name / "partial.obj", pv, pf)

        for method in args.methods:
            out_v, out_f, elapsed, peak_mb, err = run_method(method, pv, pf)
            s = score(out_v, out_f, partial_tree, truth_tree, hidden_pts, rng)
            row = {"scenario": name, "group": group, "method": method, "hidden_share": share,
                   "seconds": elapsed, "peak_mb": peak_mb, "error": err, **(s or {})}
            rows.append(row)
            status = err or (f"cov@2cm {s['cov2cm']:.0%}  mean {s['mean_mm']:.0f} mm  "
                             f"added {s['added_m2']:.3f} m2 ({s['added_ok2cm']:.0%} real)")
            print(f"    {method:<18} {elapsed:6.1f}s {peak_mb:6.0f} MB   {status}")
            if args.save_meshes and not err:
                write_obj(OUT / name / f"{method.replace('+', '_')}.obj", out_v, out_f)

    summarize(rows, args.methods)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps(rows, indent=2))
    print(f"\nraw results: {OUT / 'results.json'}")


def summarize(rows, methods):
    """One line per (scenario group, method), averaging the four walls into one."""
    print("\n" + "=" * 96)
    print(f"{'scenario':<11}{'method':<19}{'cov@1cm':>9}{'cov@2cm':>9}{'mean mm':>9}"
          f"{'added m2':>10}{'added real':>12}{'time s':>8}{'peak MB':>9}")
    print("-" * 96)
    groups = list(dict.fromkeys(r["group"] for r in rows))
    for g in groups:
        for m in methods:
            rs = [r for r in rows if r["group"] == g and r["method"] == m]
            ok = [r for r in rs if not r["error"]]
            if not ok:
                print(f"{g:<11}{m:<19}  FAILED: {rs[0]['error'] if rs else 'not run'}")
                continue
            def avg(k):
                vals = [r[k] for r in ok if not np.isnan(r[k])]
                return float(np.mean(vals)) if vals else float("nan")
            print(f"{g:<11}{m:<19}{avg('cov1cm'):>9.0%}{avg('cov2cm'):>9.0%}{avg('mean_mm'):>9.0f}"
                  f"{avg('added_m2'):>10.3f}{avg('added_ok2cm'):>12.0%}{avg('seconds'):>8.1f}"
                  f"{max(r['peak_mb'] for r in ok):>9.0f}")
    print("=" * 96)


if __name__ == "__main__":
    main()

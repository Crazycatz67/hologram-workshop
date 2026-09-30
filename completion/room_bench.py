"""Score completion methods on a synthetic room, until a real room scan exists.

Track B, the room case of B0/B5 (plans/scan-completion/ROADMAP.md). Same question as
benchmark.py -- "how close is what you filled in to what was really there?" -- asked of a
room instead of a chair. The metrics, the per-method process isolation and the summary
table are benchmark.py's, used BY IMPORT; this file only builds the room and decides what
a scanner would have missed.

THE ROOM (metres, y up, origin at a floor corner)
-------------------------------------------------
  4.2 x 3.6 m floor, 2.5 m ceiling (--no-ceiling drops it), a 0.9 x 2.05 m doorway in the
  x=0 wall with nothing behind it. Furniture, all axis-aligned boxes:
    sofa     2.0 x 0.9 m, seat 0.45 m, back 0.85 m, arms 0.65 m; 5 cm off the z=0 wall
    table    1.2 x 0.8 m top at 0.72-0.76 m on four 5 cm legs, mid-room
    cabinet  0.5 x 0.4 x 1.8 m in the far corner, 2 cm off both walls
  Everything is meshed on a 5 cm grid and welded, like a decimated LiDAR mesh. Faces in
  contact (a sofa's bottom on the floor, a leg's top under the table) are not surfaces and
  are left out; the floor UNDER the sofa and the wall BEHIND it are real and are kept.

THE SCANNER
-----------
  Eight phone positions at 1.4 m on a loop around the table -- a person walking the middle
  of the room. A face is seen if at least one position has a clear line of sight to it
  (exact ray-box tests against every furniture box), within 5 m, and not at a grazing
  angle (cos > 0.15). Visibility is decided per 5 cm face, so shadow edges are jagged at
  that scale.

SCENARIOS
---------
  occlusion   What that scanner path really misses: floor under the table and sofa, wall
              behind sofa and cabinet, the table's underside, the cabinet's top and back.
  exposed     The A-P4 case: the Platform hides the sofa. Input = the occlusion scan minus
              the sofa; scored on what hiding it exposes (floor under it, wall behind it,
              its floor shadow); the truth no longer has a sofa, so re-inventing one counts
              as invented surface.
  holes       The full room with 12 round dropouts of 15 cm radius (dark or shiny patches).

METRICS
-------
  benchmark.py's, by import: coverage @1/2 cm (recall on the hidden region), added area
  and "added real" (precision on the added surface), time and peak memory per method in
  its own process. A second table gives the same at tau = 5 cm plus F-scores, the
  tolerance room-completion papers report (Atlas, Murez et al. 2020; SG-NN) -- but ours
  are restricted to the hidden region / added surface, so they are NOT directly
  comparable to those papers' whole-scene numbers.

  By default the hidden set is every real surface the scan lacks, including surface no
  scanner could ever see (the floor under the sofa, the back of the sofa in its 5 cm gap
  to the wall). --seeable-only scores coverage only on hidden surface that some viewpoint
  in the room's free space could see (a 0.4 m grid of positions at five heights, same
  exact ray-box test) -- SG-NN's convention of scoring only truth a scanner could observe,
  where their "could observe" is a denser real scan and ours is geometric. evaluate()
  takes the truth and hidden region as POINTS, so a real room with a point-cloud ground
  truth (e.g. Redwood's laser scans) can be scored by the same code.

CAVEAT: THIS TRUTH FLATTERS PLANE METHODS
-----------------------------------------
Every surface here is an exact plane, every corner is a clean right angle, and the scan
has no noise, no drift, no clutter and no curved furniture. A plane-fitting method is being
tested on the one world where its prior is perfectly true, so plane_extend's numbers here
are an UPPER BOUND on what it will do on a real room. Compare methods against each other;
do not read the absolute coverage as what a real Scaniverse room will get. The doorway is
the one deliberate trap: a hole that must NOT be filled. A real room adds many more
(windows, mirrors, open shelving, cushions, rugs). Rerun on a real room scan the moment
one exists.

Usage:
    .venv/bin/python completion/room_bench.py
    .venv/bin/python completion/room_bench.py --methods none plane_extend --scenarios holes
    .venv/bin/python completion/room_bench.py --save-meshes   # OBJs in completion/out/room/
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark  # noqa: E402  -- metrics, isolation, summary: reused, never forked
import fill  # noqa: E402
import planes  # noqa: E402
from fill import face_geometry, sample_surface, submesh  # noqa: E402

OUT = benchmark.OUT / "room"

STEP = 0.05                   # metres; mesh resolution of the synthetic room
ROOM = np.array([4.2, 2.5, 3.6])
DOOR = (0.0, (2.4, 3.3), (0.0, 2.05))   # on the x=0 wall: z range, y range
SCANNER_HEIGHT = 1.4
SCANNER_LOOP = ((2.2, 1.9), (1.2, 0.8), 8)   # centre (x, z), radii (x, z), positions
MAX_RANGE = 5.0
MIN_COS = 0.15                # ~81 degrees: LiDAR returns fade at grazing angles
HOLE_COUNT = 12
HOLE_RADIUS = 0.15

# Sampling density for scoring, per m^2 of truth. benchmark.py's fixed 250k points give
# ~3 mm spacing on a 2 m^2 chair but ~2 cm on a 70 m^2 room, which would make the 1 cm
# coverage and the 5 mm "added" test measure sampling noise instead of the method.
OUTPUT_DENSITY = 40_000       # method output: ~2.5 mm mean nearest-sample distance
PARTIAL_DENSITY = 120_000     # the input tree for the "added" test: P(false added) ~ 0

# name -> list of (lo, hi) boxes
FURNITURE = {
    "sofa": [((1.0, 0.0, 0.05), (3.0, 0.45, 0.95)),     # seat base
             ((1.0, 0.45, 0.05), (3.0, 0.85, 0.30)),    # back
             ((1.0, 0.45, 0.30), (1.2, 0.65, 0.95)),    # arms
             ((2.8, 0.45, 0.30), (3.0, 0.65, 0.95))],
    "table": [((1.6, 0.72, 1.5), (2.8, 0.76, 2.3))] + [
             ((x, 0.0, z), (x + 0.05, 0.72, z + 0.05)) for x in (1.65, 2.70) for z in (1.55, 2.20)],
    "cabinet": [((3.68, 0.0, 3.18), (4.18, 1.8, 3.58))],
}


# ---------------------------------------------------------------- the room

def _rect(origin, du, dw, step=STEP):
    """A grid of triangles over the parallelogram origin + [0,1]du + [0,1]dw, normal along
    cross(du, dw). Returns vertices, faces, and each face's cell centre."""
    nu = max(int(np.ceil(np.linalg.norm(du) / step - 1e-9)), 1)
    nw = max(int(np.ceil(np.linalg.norm(dw) / step - 1e-9)), 1)
    a, b = np.meshgrid(np.linspace(0, 1, nu + 1), np.linspace(0, 1, nw + 1), indexing="ij")
    v = np.asarray(origin) + a.reshape(-1, 1) * du + b.reshape(-1, 1) * dw
    i, j = np.meshgrid(np.arange(nu), np.arange(nw), indexing="ij")
    i, j = i.ravel(), j.ravel()
    vid = lambda p, q: p * (nw + 1) + q
    f = np.concatenate([np.stack([vid(i, j), vid(i + 1, j), vid(i + 1, j + 1)], 1),
                        np.stack([vid(i, j), vid(i + 1, j + 1), vid(i, j + 1)], 1)])
    return v, f


def _box_faces(lo, hi, inward=False):
    """Six rectangles of an axis-aligned box, normals outward (inward for the room)."""
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    s = hi - lo
    X, Y, Z = np.diag(s)
    rects = [  # (origin, du, dw) with cross(du, dw) pointing OUT of the box
        (lo, Z, Y), (lo + X, Y, Z),          # -x, +x
        (lo, X, Z), (lo + Y, Z, X),          # -y, +y
        (lo, Y, X), (lo + Z, X, Y),          # -z, +z
    ]
    names = ["-x", "+x", "-y", "+y", "-z", "+z"]
    return [(n, *((o, dw, du) if inward else (o, du, dw))) for n, (o, du, dw) in zip(names, rects)]


def _inside(p, lo, hi, eps=0.0):
    return np.all((p > np.asarray(lo) + eps) & (p < np.asarray(hi) - eps), axis=1)


def build_room(ceiling=True):
    """(vertices, faces, face_object_names). Welded, 5 cm grid, see module docstring."""
    verts, faces, labels = [], [], []
    count = 0

    def add(v, f, name, keep=None):
        nonlocal count
        if keep is not None:
            v, f = submesh(v, f, keep)
        verts.append(v)
        faces.append(f + count)
        labels.extend([name] * len(f))
        count += len(v)

    shell_names = {"-x": "wall_x0", "+x": "wall_x1", "-y": "floor", "+y": "ceiling",
                   "-z": "wall_z0", "+z": "wall_z1"}
    for side, o, du, dw in _box_faces((0, 0, 0), ROOM, inward=True):
        if side == "+y" and not ceiling:
            continue
        v, f = _rect(o, du, dw)
        keep = None
        if side == "-x":   # the doorway: cells inside it are simply not there
            c = v[f].mean(axis=1)
            (z0, z1), (y0, y1) = DOOR[1], DOOR[2]
            keep = ~((c[:, 2] > z0) & (c[:, 2] < z1) & (c[:, 1] > y0) & (c[:, 1] < y1))
        add(v, f, shell_names[side], keep)

    all_boxes = [b for boxes in FURNITURE.values() for b in boxes]
    for name, boxes in FURNITURE.items():
        for lo, hi in boxes:
            for side, o, du, dw in _box_faces(lo, hi):
                v, f = _rect(o, du, dw)
                c, n, _ = face_geometry(v, f)
                p = c + 0.002 * n
                # Contact faces are not surfaces: pushed 2 mm outward they end up inside
                # another box, or outside the room (under the floor, in a wall).
                gone = ~_inside(p, (0, 0, 0), ROOM)
                for blo, bhi in all_boxes:
                    gone |= _inside(p, blo, bhi)
                add(v, f, name, ~gone)

    v, f = np.vstack(verts), np.vstack(faces)
    # Weld coincident vertices (grid edges shared between rectangles), as a scan mesh is.
    key = np.round(v / 1e-4).astype(np.int64)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return v[first], inverse.reshape(-1)[f], np.array(labels)


def scanner_positions():
    (cx, cz), (rx, rz), n = SCANNER_LOOP
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return np.stack([cx + rx * np.cos(t), np.full(n, SCANNER_HEIGHT), cz + rz * np.sin(t)], axis=1)


def visible_faces(v, f, occluders, scanners=None, max_range=MAX_RANGE):
    """Faces at least one scanner position sees: facing it, in range, not grazing, and
    with a clear segment to it through every occluder box (slab test). The room shell is
    convex around the scanners, so it never occludes and is not tested."""
    scanners = scanner_positions() if scanners is None else scanners
    c, n, _ = face_geometry(v, f)
    p = c + 0.002 * n   # just off the surface, so a box does not shadow its own face
    seen = np.zeros(len(f), dtype=bool)
    for s in scanners:
        d = p - s
        dist = np.linalg.norm(d, axis=1)
        ok = (-(n * d).sum(axis=1) / dist > MIN_COS) & (dist < max_range)
        with np.errstate(divide="ignore", invalid="ignore"):
            inv = 1.0 / d
        for lo, hi in occluders:
            t1 = (np.asarray(lo) - s) * inv
            t2 = (np.asarray(hi) - s) * inv
            t_enter = np.nanmax(np.minimum(t1, t2), axis=1)
            t_exit = np.nanmin(np.maximum(t1, t2), axis=1)
            ok &= ~((t_enter < t_exit) & (t_enter < 1.0) & (t_exit > 0.0))
        seen |= ok
    return seen


def seeable_faces(v, f, occluders):
    """Faces that SOME free-space viewpoint could see: a 0.4 m grid of positions filling
    the room at five heights (skipping any inside furniture). The floor under a sofa or
    the back of a sofa 5 cm from a wall fail this; no scanner could ever measure them."""
    xs, zs = np.arange(0.2, ROOM[0], 0.4), np.arange(0.2, ROOM[2], 0.4)
    ys = np.array([0.15, 0.6, 1.2, 1.8, 2.35])
    grid = np.stack(np.meshgrid(xs, ys, zs, indexing="ij"), axis=-1).reshape(-1, 3)
    free = np.ones(len(grid), dtype=bool)
    for lo, hi in occluders:
        free &= ~_inside(grid, np.asarray(lo) - 0.02, np.asarray(hi) + 0.02)
    return visible_faces(v, f, occluders, scanners=grid[free], max_range=np.inf)


def scenarios(v, f, labels, rng, seeable_only=False):
    """name -> (partial v, f), (hidden v, f), (truth v, f).

    seeable_only restricts the HIDDEN (scored-for-coverage) set to surface some viewpoint
    in the room could have seen -- the SG-NN evaluation convention. The truth used for
    "is the added surface real" stays complete: the floor under a sofa is still real."""
    boxes = lambda names: [b for k in names for b in FURNITURE[k]]
    seen = visible_faces(v, f, boxes(FURNITURE))
    seeable = seeable_faces(v, f, boxes(FURNITURE)) if seeable_only else np.ones(len(f), dtype=bool)
    out = {"occlusion": (submesh(v, f, seen), submesh(v, f, ~seen & seeable), (v, f))}

    no_sofa = labels != "sofa"
    seen_without = visible_faces(v, f, boxes(["table", "cabinet"]))
    if seeable_only:
        seeable = seeable_faces(v, f, boxes(["table", "cabinet"]))
    exposed = no_sofa & seen_without & ~seen & seeable
    out["exposed"] = (submesh(v, f, seen & no_sofa), submesh(v, f, exposed), submesh(v, f, no_sofa))

    c, _, _ = face_geometry(v, f)
    seeds = c[rng.choice(len(f), HOLE_COUNT, replace=False)]
    holes = np.min(np.linalg.norm(c[:, None, :] - seeds[None, :, :], axis=2), axis=1) < HOLE_RADIUS
    out["holes"] = (submesh(v, f, ~holes), submesh(v, f, holes), (v, f))
    return out


# ---------------------------------------------------------------- methods

_hidden_cache = {}


def _hidden_sofa():
    """The sofa's own mesh, for the A-P4 case: the Platform hides an object, it does not
    delete it, so the completion step can be told what was standing there."""
    if "sofa" not in _hidden_cache:
        v, f, labels = build_room()
        _hidden_cache["sofa"] = submesh(v, f, labels == "sofa")
    return _hidden_cache["sofa"]


def _plane_hidden(v, f):
    # In "occlusion" and "holes" the sofa is still in the scan, so passing it as an
    # occluder changes nothing there; it matters only in "exposed".
    return planes.plane_extend(v, f, occluders=_hidden_sofa())


ROOM_METHODS = {
    "plane_extend": planes.plane_extend,
    "plane_extend[+hidden]": _plane_hidden,
    "plane_extend[no-openings]": lambda v, f: planes.plane_extend(v, f, openings=False),
    "plane_extend[rect]": lambda v, f: planes.plane_extend(v, f, surface_mode="rect",
                                                           occluders=_hidden_sofa()),
    "plane_extend[holes]": lambda v, f: planes.plane_extend(v, f, surface_mode="holes",
                                                            occluders=_hidden_sofa()),
    "plane+poisson": lambda v, f: fill.poisson(*_plane_hidden(v, f)),
    "plane+complete": lambda v, f: fill.complete(*_plane_hidden(v, f))[:2],
}
# benchmark.run_method looks methods up in benchmark.METHODS inside a spawned child. The
# child re-imports this file as __mp_main__ before unpickling its task, so registering at
# import time makes these visible there too -- reusing benchmark.py's crash/timeout
# isolation instead of writing a second copy of it.
benchmark.METHODS.update(ROOM_METHODS)
DEFAULT_METHODS = ["none", "poisson", "complete", *ROOM_METHODS]


# ---------------------------------------------------------------- scoring

TAU_LIT = 0.05   # metres; the tolerance room-completion papers report (Atlas, SG-NN)
MIN_ADDED = 0.01 # m^2; below this a method added nothing, and its precision is undefined


def score_at(out_v, out_f, partial_tree, truth_tree, hidden_pts, rng, tau=TAU_LIT):
    """benchmark.score's two numbers at the literature's tolerance. cov = recall on the
    hidden region; real = precision on the ADDED surface; F = their harmonic mean. A
    5 cm tolerance does not need benchmark.py's dense sampling, so this samples lighter."""
    out_pts = sample_surface(out_v, out_f, max(int(len(hidden_pts) * 20), 200_000), rng)
    d_hidden, _ = cKDTree(out_pts).query(hidden_pts)
    d_input, _ = partial_tree.query(out_pts)
    added = out_pts[d_input > benchmark.ADDED_THRESHOLD]
    cov = float(np.mean(d_hidden < tau))
    _, _, out_area = face_geometry(out_v, out_f)
    added_m2 = out_area.sum() * len(added) / len(out_pts)
    # Precision of "nothing added" is undefined, not 100%: sampling residue (~0.01 m2 of
    # the scan itself) would otherwise give the do-nothing baseline a perfect score.
    real = float(np.mean(truth_tree.query(added)[0] < tau)) if added_m2 >= MIN_ADDED else float("nan")
    return {"cov5cm": cov, "real5cm": real, "f5cm": _f(cov, real)}


def _f(p, r):
    return float("nan") if not (p + r > 0) else 2 * p * r / (p + r)


def evaluate(name, partial, hidden_pts, truth_pts, methods, rng, save=False):
    """Score every method on one scenario. Truth and hidden region are POINTS, so a real
    room with a point-cloud ground truth (e.g. a laser scan) drops straight in; only the
    partial input has to be a mesh, because the methods take meshes."""
    pv, pf = partial
    _, _, p_area = face_geometry(pv, pf)
    # score() samples every output with benchmark.OUTPUT_SAMPLES (sized for a chair); size
    # it by area instead. The input is most of any output, so its area is the yardstick.
    benchmark.OUTPUT_SAMPLES = int(p_area.sum() * 1.2 * OUTPUT_DENSITY)
    truth_tree = cKDTree(truth_pts)
    partial_tree = cKDTree(sample_surface(pv, pf, int(p_area.sum() * PARTIAL_DENSITY), rng))
    rows = []
    for method in methods:
        out_v, out_f, elapsed, peak_mb, err = benchmark.run_method(method, pv, pf)
        s = benchmark.score(out_v, out_f, partial_tree, truth_tree, hidden_pts, rng)
        if s:
            s.update(score_at(out_v, out_f, partial_tree, truth_tree, hidden_pts, rng))
            s["f2cm"] = _f(s["cov2cm"], s["added_ok2cm"] if s["added_m2"] >= MIN_ADDED else float("nan"))
        rows.append({"scenario": name, "group": name, "method": method, "seconds": elapsed,
                     "peak_mb": peak_mb, "error": err, **(s or {})})
        status = err or (f"cov@2cm {s['cov2cm']:.0%}  mean {s['mean_mm']:.0f} mm  "
                         f"added {s['added_m2']:.2f} m2 ({s['added_ok2cm']:.0%} real)")
        print(f"    {method:<26} {elapsed:6.1f}s {peak_mb:6.0f} MB   {status}")
        if save and not err:
            safe = method.replace("+", "_").replace("[", "_").replace("]", "")
            benchmark.write_obj(OUT / name / f"{safe}.obj", out_v, out_f)
    return rows


def summarize_lit(rows, methods):
    """The same runs at the literature's tolerance: recall (coverage) and precision
    (added real) at 5 cm, F-score at 5 cm and 2 cm."""
    print(f"\nAt the literature's tolerance (Atlas / SG-NN report tau = 5 cm):")
    print(f"{'scenario':<11}{'method':<27}{'cov@5cm':>9}{'real@5cm':>10}{'F@5cm':>8}{'F@2cm':>8}")
    pct = lambda x: f"{x:>8.0%}" if np.isfinite(x) else f"{'-':>8}"
    for g in dict.fromkeys(r["group"] for r in rows):
        for m in methods:
            rs = [r for r in rows if r["group"] == g and r["method"] == m and not r["error"]]
            for r in rs:
                print(f"{g:<11}{m:<27}{r['cov5cm']:>9.0%} {pct(r['real5cm'])}{pct(r['f5cm'])}{pct(r['f2cm'])}")


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--methods", nargs="+", default=DEFAULT_METHODS, choices=list(benchmark.METHODS))
    ap.add_argument("--scenarios", nargs="+", default=["occlusion", "exposed", "holes"],
                    choices=["occlusion", "exposed", "holes"])
    ap.add_argument("--no-ceiling", action="store_true")
    ap.add_argument("--seeable-only", action="store_true",
                    help="score coverage only on hidden surface some viewpoint could see (SG-NN)")
    ap.add_argument("--save-meshes", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    v, f, labels = build_room(ceiling=not args.no_ceiling)
    _, _, area = face_geometry(v, f)
    print(f"synthetic room: {len(v)} verts  {len(f)} faces  area {area.sum():.1f} m2  "
          f"({', '.join(f'{k} {area[labels == k].sum():.1f}' for k in FURNITURE)} m2 furniture)\n")
    if args.save_meshes:
        benchmark.write_obj(OUT / "truth.obj", v, f)

    rows = []
    for name, (partial, (hv, hf), (tv, tf)) in scenarios(v, f, labels, rng, args.seeable_only).items():
        if name not in args.scenarios:
            continue
        _, _, t_area = face_geometry(tv, tf)
        _, _, h_area = face_geometry(hv, hf)
        print(f"[{name}] hid {len(hf)} faces, {h_area.sum():.2f} m2 "
              f"({h_area.sum() / t_area.sum():.1%} of the room)")
        if args.save_meshes:
            benchmark.write_obj(OUT / name / "partial.obj", *partial)
            benchmark.write_obj(OUT / name / "hidden.obj", hv, hf)
        truth_pts = sample_surface(tv, tf, int(t_area.sum() * OUTPUT_DENSITY), rng)
        hidden_pts = sample_surface(hv, hf, benchmark.TRUTH_SAMPLES, rng)
        rows += evaluate(name, partial, hidden_pts, truth_pts, args.methods, rng, args.save_meshes)

    benchmark.summarize(rows, args.methods)
    summarize_lit(rows, args.methods)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "results.json").write_text(json.dumps(rows, indent=2))
    print(f"\nraw results: {OUT / 'results.json'}")


if __name__ == "__main__":
    main()

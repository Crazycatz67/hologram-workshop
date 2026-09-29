"""Surface detail: remove scanner bumps without falsifying the object, and carry the real
colour onto the cleaned mesh.

Owner report (2026-09-29): the hologram is "too bumpy and the texture is uneven", and it
matters most for detailed holograms. Two separate causes, two fixes:

  BUMPS    LiDAR noise baked into the geometry. The shipped chair measured a surface noise
           of 0.098 (mean 1 - cos between each face and its 1.2 cm neighbourhood -- faces
           tilted ~25 deg off their own surface on average). The browser's shading-normal
           smoothing (hologramLook.js) only hides this; this fixes the mesh itself.
  TEXTURE  clean_scan.py's Poisson rebuild drops the scan's colour entirely, so the cleaned
           chair had none to show. The raw scan's texture is transferred onto the cleaned
           mesh as vertex colours (closest-point), so Realism in the platform shows the
           real upholstery on the clean shape.

Denoising must not change what the object IS: every method is scored on noise removed
AND on how far the surface moved and how much the measurements changed, and the chosen
default is the one that removes the most noise while staying inside the fidelity budget
(mean drift <= 1 mm, worst 1% <= 4 mm, dimensions <= 2 mm, volume <= 1%).

Usage:
    .venv/bin/python completion/detail.py assets/chair/chair_clean.obj --compare
    .venv/bin/python completion/detail.py assets/chair/chair_clean.obj \\
        --colors-from assets/chair/chair.glb -o assets/chair/chair_detail.ply
"""

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pymeshlab
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fill  # noqa: E402

NOISE_RADIUS = 0.012  # metres, same neighbourhood as hologramLook.js
BUDGET = {"drift_mean_mm": 1.0, "drift_p99_mm": 4.0, "dims_mm": 2.0, "volume_pct": 1.0}

METHODS = {
    # name: (pymeshlab filter, kwargs)
    "taubin x10": ("apply_coord_taubin_smoothing", dict(stepsmoothnum=10)),
    "taubin x30": ("apply_coord_taubin_smoothing", dict(stepsmoothnum=30)),
    "taubin x60": ("apply_coord_taubin_smoothing", dict(stepsmoothnum=60)),
    "taubin x120": ("apply_coord_taubin_smoothing", dict(stepsmoothnum=120)),
    "taubin x250": ("apply_coord_taubin_smoothing", dict(stepsmoothnum=250)),
    "hc-laplacian x3": ("apply_coord_hc_laplacian_smoothing", None),
    "surface-preserving 1deg x3": ("apply_coord_laplacian_smoothing_surface_preserving", dict(angledeg=1.0, iterations=3)),
    "two-step 20deg x3": ("apply_coord_two_steps_smoothing", dict(stepsmoothnum=3, normalthr=20, stepnormalnum=20, stepfitnum=20)),
    "two-step 30deg x3": ("apply_coord_two_steps_smoothing", dict(stepsmoothnum=3, normalthr=30, stepnormalnum=20, stepfitnum=20)),
    "two-step 30deg x6": ("apply_coord_two_steps_smoothing", dict(stepsmoothnum=6, normalthr=30, stepnormalnum=20, stepfitnum=20)),
    "two-step 45deg x6": ("apply_coord_two_steps_smoothing", dict(stepsmoothnum=6, normalthr=45, stepnormalnum=20, stepfitnum=20)),
}
DEFAULT_METHOD = "taubin x30"   # best noise reduction inside the fidelity budget (--compare, 2026-09-29)


def load(path):
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(str(path))
    return ms


def vf(ms):
    m = ms.current_mesh()
    return m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)


def surface_noise(v, f):
    """Mean (1 - cos) between each face normal and the area-weighted normal of all faces
    within NOISE_RADIUS -- 0 for a perfectly smooth surface."""
    c, n, a = fill.face_geometry(v, f)
    tree = cKDTree(c)
    w = n * a[:, None]
    out = np.empty(len(f))
    for i, nb in enumerate(tree.query_ball_point(c, NOISE_RADIUS)):
        s = w[nb].sum(0)
        out[i] = 1 - float(n[i] @ (s / (np.linalg.norm(s) + 1e-12)))
    return float(np.average(out, weights=a))


def volume(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    return abs(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)


def score(v0, f0, v, f):
    """Drift is point-to-PLANE: distance from the new surface to the original surface's
    tangent plane at the nearest original sample. Point-to-point would report ~1 mm of
    'drift' for an unchanged mesh, just from the spacing between samples."""
    rng = np.random.default_rng(0)
    c0, n0, a0 = fill.face_geometry(v0, f0)
    idx = rng.choice(len(f0), 400_000, p=a0 / a0.sum())
    r1, r2 = rng.random(len(idx)), rng.random(len(idx)); sq = np.sqrt(r1)
    pts0 = ((1 - sq)[:, None] * v0[f0[idx, 0]] + (sq * (1 - r2))[:, None] * v0[f0[idx, 1]]
            + (sq * r2)[:, None] * v0[f0[idx, 2]])
    nrm0 = n0[idx]
    q = fill.sample_surface(v, f, 100_000, rng)
    _, j = cKDTree(pts0).query(q)
    d = np.abs(np.einsum("ij,ij->i", q - pts0[j], nrm0[j]))
    dims = np.abs((v.max(0) - v.min(0)) - (v0.max(0) - v0.min(0))).max() * 1000
    vol = abs(volume(v, f) / volume(v0, f0) - 1) * 100
    return {
        "noise": surface_noise(v, f),
        "drift_mean_mm": float(d.mean() * 1000),
        "drift_p99_mm": float(np.percentile(d, 99) * 1000),
        "dims_mm": float(dims),
        "volume_pct": float(vol),
    }


def within_budget(s):
    return all(s[k] <= BUDGET[k] for k in BUDGET)


def denoise(ms, method=DEFAULT_METHOD):
    name, kwargs = METHODS[method]
    if kwargs is None:
        for _ in range(3):
            getattr(ms, name)()
    else:
        getattr(ms, name)(**kwargs)
    ms.compute_normal_per_vertex()


def glb_texture(path):
    """The first embedded image of a .glb as a Pillow image (PyMeshLab loads the mesh and its
    UVs but not the embedded image, so its own texture->colour filters see nothing)."""
    import io, json, struct
    from PIL import Image
    data = Path(path).read_bytes()
    json_len = struct.unpack("<I", data[12:16])[0]
    gltf = json.loads(data[20:20 + json_len])
    bin_start = 20 + json_len + 8
    view = gltf["bufferViews"][gltf["images"][0]["bufferView"]]
    off = bin_start + view.get("byteOffset", 0)
    return Image.open(io.BytesIO(data[off:off + view["byteLength"]])).convert("RGB")


def transfer_colors(ms, raw_path, samples=3_000_000):
    """Give the cleaned mesh the raw scan's real colour, per vertex.

    Dense samples on the raw surface each carry an interpolated UV; every cleaned vertex
    takes the UV of its nearest raw sample (~1 mm apart at 3M samples on a chair) and reads
    the texture there. Raises if the raw scan has no texture -- never silently white."""
    raw = pymeshlab.MeshSet()
    raw.load_new_mesh(str(raw_path))
    m = raw.current_mesh()
    if not m.has_wedge_tex_coord():
        raise SystemExit(f"{raw_path} has no texture coordinates -- nothing to take colour from")
    rv, rf = m.vertex_matrix(), m.face_matrix()
    uv = m.wedge_tex_coord_matrix().reshape(len(rf), 3, 2)
    tex = glb_texture(raw_path)
    img = np.asarray(tex, dtype=np.float32) / 255.0

    rng = np.random.default_rng(0)
    _, _, area = fill.face_geometry(rv, rf)
    idx = rng.choice(len(rf), samples, p=area / area.sum())
    r1, r2 = rng.random(samples), rng.random(samples)
    sq = np.sqrt(r1)
    w = np.stack([1 - sq, sq * (1 - r2), sq * r2], 1)
    pts = np.einsum("ij,ijk->ik", w, rv[rf[idx]])
    suv = np.einsum("ij,ijk->ik", w, uv[idx])

    target = ms.current_mesh()
    tv = target.vertex_matrix()
    dist, j = cKDTree(pts).query(tv)
    u = np.clip(suv[j, 0] % 1.0, 0, 1) * (img.shape[1] - 1)
    vv = np.clip(1.0 - (suv[j, 1] % 1.0), 0, 1) * (img.shape[0] - 1)   # UV origin is bottom-left
    x0, y0 = np.floor(u).astype(int), np.floor(vv).astype(int)
    x1, y1 = np.minimum(x0 + 1, img.shape[1] - 1), np.minimum(y0 + 1, img.shape[0] - 1)
    fx, fy = (u - x0)[:, None], (vv - y0)[:, None]
    col = (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
           + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)
    rgba = np.concatenate([col, np.ones((len(col), 1))], 1)
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=tv, face_matrix=target.face_matrix(), v_color_matrix=rgba), "coloured")
    far = float(np.mean(dist > 0.01))
    print(f"colour: {len(tv)} vertices from {tex.size[0]}x{tex.size[1]} texture, "
          f"median distance to raw surface {np.median(dist)*1000:.1f} mm, {far:.1%} farther than 1 cm "
          f"(filled-in regions -- coloured from the nearest real surface)")


def compare(path):
    ms = load(path)
    v0, f0 = vf(ms)
    base = score(v0, f0, v0, f0)
    print(f"{'method':<22}{'noise':>8}{'drift mm':>10}{'p99 mm':>9}{'dims mm':>9}{'vol %':>8}{'time s':>8}  budget")
    print(f"{'(original)':<22}{base['noise']:>8.3f}{0:>10.2f}{0:>9.2f}{0:>9.2f}{0:>8.2f}{'':>8}")
    best = None
    for method in METHODS:
        ms = load(path)
        t = time.perf_counter()
        denoise(ms, method)
        dt = time.perf_counter() - t
        v, f = vf(ms)
        s = score(v0, f0, v, f)
        ok = within_budget(s)
        print(f"{method:<22}{s['noise']:>8.3f}{s['drift_mean_mm']:>10.2f}{s['drift_p99_mm']:>9.2f}"
              f"{s['dims_mm']:>9.2f}{s['volume_pct']:>8.2f}{dt:>8.1f}  {'ok' if ok else 'OVER'}")
        if ok and (best is None or s["noise"] < best[1]):
            best = (method, s["noise"])
    print(f"\nbest within budget: {best[0] if best else 'none'}"
          f"  (noise {base['noise']:.3f} -> {best[1]:.3f})" if best else "")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("-o", "--output")
    ap.add_argument("--method", default=DEFAULT_METHOD, choices=list(METHODS))
    ap.add_argument("--colors-from", help="raw textured scan to take real colours from")
    ap.add_argument("--compare", action="store_true", help="score every method against the fidelity budget")
    ap.add_argument("--color-detail", type=int, default=1, metavar="N",
                    help="midpoint-subdivision levels before colour transfer (each ~4x faces, 2x colour resolution)")
    args = ap.parse_args()
    if args.compare:
        return compare(args.input)
    ms = load(args.input)
    v0, f0 = vf(ms)
    denoise(ms, args.method)
    v, f = vf(ms)
    s = score(v0, f0, v, f)
    print(f"{args.method}: noise {surface_noise(v0, f0):.3f} -> {s['noise']:.3f}, drift {s['drift_mean_mm']:.2f} mm "
          f"(p99 {s['drift_p99_mm']:.2f}), dims {s['dims_mm']:.2f} mm, volume {s['volume_pct']:.2f}%"
          f"  {'within budget' if within_budget(s) else 'OVER BUDGET'}")
    if args.colors_from:
        # Colour lives on vertices, so its resolution is the vertex spacing (~6 mm on the
        # chair -- upholstery came out blotchy). Midpoint subdivision adds vertices WITHOUT
        # moving the surface (it only splits edges at their midpoints), so each level doubles
        # colour resolution with zero geometric change.
        for _ in range(args.color_detail):
            ms.meshing_surface_subdivision_midpoint(iterations=1, threshold=pymeshlab.PercentageValue(0))
        transfer_colors(ms, args.colors_from)
    if args.output:
        ms.save_current_mesh(args.output, save_vertex_color=bool(args.colors_from), save_vertex_normal=False,
                             **({"binary": True} if args.output.endswith(".ply") else {}))
        print("wrote", args.output)


if __name__ == "__main__":
    main()

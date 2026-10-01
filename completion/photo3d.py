"""Photo -> real 3D object with TripoSR, written in the Track B output contract.

The Platform's in-browser photo upload (platform/photo.js) only makes a flat 2.5D relief: a
depth map pushed out of the picture plane, with no sides and no back. This is the real-3D
path: TripoSR (VAST-AI / Stability AI, MIT) predicts a whole closed object from ONE photo.
It runs on the Mac in its own isolated Python 3.11 environment (.models/triposr/, recipe in
.models/triposr/NOTES.md), so it is called as a subprocess, never imported into .venv: its
pinned torch/transformers/numpy<2 would break the benchmark environment.

Contract (what the Platform and later tools rely on):

  <out>.obj   one `o <name>` object, `usemtl inferred` on EVERY face, vertex colours
              (`v x y z r g b`, 0..1 sRGB as TripoSR exports them). Units: metres.
              Frame: Y up, the camera-facing side towards +Z, centred on x = z = 0,
              lowest point on the floor (y = 0).
  <out>.glb   (--format glb) same mesh, one primitive whose material is named `inferred`.
  <out>.json  sidecar: method "TripoSR single-image", model, licence, inferred_area_share
              1.0 (100%), source photo + its sha256, scale and how it was set, size_m,
              seconds, peak memory, warnings.

Why the whole mesh is `inferred`: a single photo never measures depth. At best the
camera-facing surface is "seen", but even its shape is the network's guess, so the honest
v1 marks everything inferred (the Platform shows it hatched). Nothing here is a scan.

Scale: a photo has no scale. --height-cm sets the real height (rough; the object's true
height in the photo, e.g. measured with a tape). Without it the object is 1 m tall and the
sidecar + console say so.

Orientation: TripoSR's raw frame is Z up with the photo's camera on +X; we rotate it to Y up
with the camera-facing side towards +Z (verified on a photo: the pieces nearest the camera
end up at the larger z). TripoSR builds the object in the camera's frame, so a photo taken from above
leaves it tipped; level_on_floor() stands it on its largest downward-facing convex-hull face
(--no-level to skip; corrections up to 40 deg).

Several photos: each photo becomes its own object (TripoSR is single-image; it does not
fuse views). The model is loaded once for the batch.

Usage (repo root):
    .venv/bin/python completion/photo3d.py completion/out/chess-photos/IMG_1979.JPG --height-cm 8
    .venv/bin/python completion/photo3d.py chair.jpg -o completion/out/photo3d/chair.obj --height-cm 82
    .venv/bin/python completion/photo3d.py a.jpg b.jpg -o completion/out/photo3d/      # one object each
    .venv/bin/python completion/photo3d.py cutout.png --no-remove-bg   # already on a grey background

View it:  http://localhost:8080/platform/index.html?model=/completion/out/photo3d/IMG_1979.obj

Failure behaviour: exits non-zero with a one-line reason if the TripoSR environment is
missing, the photo can't be read, or TripoSR fails (its last log lines are printed).
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
TRIPOSR_DIR = ROOT / ".models" / "triposr"
TRIPOSR_PY = TRIPOSR_DIR / ".venv" / "bin" / "python"
TRIPOSR_REPO = TRIPOSR_DIR / "TripoSR"
DEFAULT_OUT = ROOT / "completion" / "out" / "photo3d"

# TripoSR works at 512 px internally; a 24 MP phone photo only makes rembg slow and hungry.
# 1024 keeps enough detail for the background cut-out.
MAX_SIDE = 1024
RAW_TO_CONTRACT = np.array([[0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 0, 0], [0, 0, 0, 1]], dtype=float)
LEVEL_MAX_DEG = 40   # steepest photo elevation we correct; beyond this we'd risk tipping objects over
LEVEL_CLUSTER_DEG = 5  # hull triangles within this angle count as one resting face
LICENCE = ("TripoSR code and weights: MIT (stabilityai/TripoSR). Background removal: rembg (MIT) "
           "with the U^2-Net model (Apache-2.0). Image encoder: DINO ViT-B/16 (Apache-2.0).")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def prepare_photo(src, dst, max_side=MAX_SIDE):
    """Upright (EXIF), RGB(A), at most max_side px. Phone JPGs store rotation in EXIF only,
    and TripoSR's PIL loader ignores it -- a portrait shot would go in sideways."""
    img = ImageOps.exif_transpose(Image.open(src))
    img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    img.save(dst)
    return img.size


def run_triposr(images, work, args):
    """Runs TripoSR's run.py once for all images. Returns (wall_s, peak_bytes|None, stage_ms)."""
    cmd = [str(TRIPOSR_PY), "run.py", *map(str, images), "--output-dir", str(work),
           "--device", args.device, "--mc-resolution", str(args.mc_resolution),
           "--model-save-format", "obj"]
    if args.no_remove_bg:
        cmd.append("--no-remove-bg")
    else:
        cmd += ["--foreground-ratio", str(args.foreground_ratio)]
    # /usr/bin/time -l (macOS) reports "peak memory footprint", the number Activity Monitor
    # calls memory; ru_maxrss under-counts on Apple silicon (3.9 vs 4.4 GB in the B3 spike).
    timed = Path("/usr/bin/time").exists() and sys.platform == "darwin"
    if timed:
        cmd = ["/usr/bin/time", "-l", *cmd]
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, cwd=TRIPOSR_REPO, capture_output=True, text=True,
                          env={**os.environ, "PYTORCH_ENABLE_MPS_FALLBACK": "1"})
    wall = time.perf_counter() - t0
    log = proc.stdout + proc.stderr
    if proc.returncode != 0:
        tail = "\n".join(log.strip().splitlines()[-12:])
        sys.exit(f"photo3d: TripoSR failed (exit {proc.returncode}):\n{tail}")
    peak = None
    m = re.search(r"(\d+)\s+peak memory footprint", log) or re.search(r"(\d+)\s+maximum resident set size", log)
    if m:
        peak = int(m.group(1))
    stages = {}
    for name, ms in re.findall(r"INFO - (.+?) finished in ([\d.]+)ms", log):
        stages[name] = stages.get(name, 0.0) + float(ms)
    return wall, peak, stages


def to_contract_frame(mesh, height_m, level=True):
    """TripoSR frame -> metres, Y up, camera side +Z, centred, standing on y = 0."""
    # TripoSR's frame (tsr/utils.py get_spherical_cameras): "x back, y right, z up", and the
    # input photo's camera sits on +X. (x, y, z) -> (y, z, x) is a proper rotation (no mirror)
    # that puts the camera on +Z, up on +Y and the photo's right on +X. Its Gradio demo's
    # to_gradio_3d_orientation gives the same up axis but turns the camera side to -Z.
    mesh.apply_transform(RAW_TO_CONTRACT)
    if level:
        tilt = level_on_floor(mesh)
    else:
        tilt = 0.0
    lo, hi = mesh.bounds
    mesh.apply_translation([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    mesh.apply_scale(height_m / max(hi[1] - lo[1], 1e-9))
    return mesh, tilt


def level_on_floor(mesh, max_deg=LEVEL_MAX_DEG):
    """Stand the object on its resting face. Returns the correction in degrees (0 = none).

    TripoSR builds the object in the photo camera's frame, so a photo taken from above (most
    of them) leaves it tipped towards the viewer by roughly the camera's elevation. The face an
    object rests on is the largest flat face of its convex hull (a chair's four feet, a board's underside); we rotate the biggest one that
    already faces roughly down (within max_deg) to face straight down. The limit stops a
    tall thin object being laid on its side because its side face is bigger."""
    # Hull triangles grouped by normal, not trimesh's facets: a chair's feet are four
    # separate points, so its resting face is many near-coplanar hull triangles that facets
    # (exactly coplanar + adjacent) never merge -- facets picked a 34 deg side face there.
    hull = mesh.convex_hull
    normals, areas = hull.face_normals, hull.area_faces
    cand = np.where(normals @ np.array([0.0, -1.0, 0.0]) > np.cos(np.radians(max_deg)))[0]
    if not len(cand):
        return 0.0
    near = (normals[cand] @ normals.T) > np.cos(np.radians(LEVEL_CLUSTER_DEG))
    best = near[np.argmax(near @ areas)]
    n = (normals[best] * areas[best, None]).sum(0)
    n /= np.linalg.norm(n)
    deg = float(np.degrees(np.arccos(np.clip(-n[1], -1, 1))))
    mesh.apply_transform(trimesh.geometry.align_vectors(n, [0.0, -1.0, 0.0]))
    return deg


def write_obj(path, name, v, f, rgb):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        fh.write("# photo3d.py (TripoSR single-image): every face is usemtl inferred -- generated from a photo, not measured\n")
        fh.write(f"o {name}\n")
        fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f} {r:.4f} {g:.4f} {b:.4f}\n"
                         for (x, y, z), (r, g, b) in zip(v, rgb)))
        fh.write("usemtl inferred\n")
        fh.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f))


def write_glb(path, name, v, f, rgb):
    path.parent.mkdir(parents=True, exist_ok=True)
    rgba = np.hstack([np.clip(rgb * 255, 0, 255), np.full((len(rgb), 1), 255)]).astype(np.uint8)
    m = trimesh.Trimesh(v, f, vertex_colors=rgba, process=False)
    # The Platform marks a GLB primitive inferred by its material name; trimesh's default
    # material for vertex-coloured meshes is unnamed, so give it one that keeps COLOR_0.
    m.visual.material = trimesh.visual.material.PBRMaterial(name="inferred", baseColorFactor=[255, 255, 255, 255])
    scene = trimesh.Scene()
    scene.add_geometry(m, node_name=name, geom_name=name)
    path.write_bytes(scene.export(file_type="glb"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("photos", nargs="+", help="photo(s) of one object each (JPG/PNG/HEIC that PIL reads)")
    ap.add_argument("-o", "--output", default=None,
                    help=f"output .obj/.glb for one photo, or a directory (default: {DEFAULT_OUT.relative_to(ROOT)}/)")
    ap.add_argument("--height-cm", type=float, default=None,
                    help="real height of the object in cm (sets the scale; default: 1 m tall, with a warning)")
    ap.add_argument("--format", choices=["obj", "glb"], default="obj", help="output format (default obj)")
    ap.add_argument("--name", default=None, help="object name (default: photo file stem)")
    ap.add_argument("--no-remove-bg", action="store_true",
                    help="passed to TripoSR: skip background removal (photo must already be the object on grey)")
    ap.add_argument("--foreground-ratio", type=float, default=0.85, help="TripoSR: object size in the frame (default 0.85)")
    ap.add_argument("--mc-resolution", type=int, default=256, help="TripoSR marching-cubes grid (default 256)")
    ap.add_argument("--device", default="cpu",
                    help="passed to TripoSR. Note: its run.py falls back to CPU whenever CUDA is absent, so on the Mac "
                         "this is always CPU (MPS gave no speedup in the B3 spike anyway)")
    ap.add_argument("--no-level", action="store_true",
                    help="don't stand the object on its largest downward-facing hull face (keep TripoSR's camera tilt)")
    ap.add_argument("--keep-work", action="store_true", help="keep TripoSR's raw output folder (printed)")
    args = ap.parse_args()

    if not TRIPOSR_PY.exists() or not (TRIPOSR_REPO / "run.py").exists():
        sys.exit(f"photo3d: TripoSR environment not found at {TRIPOSR_DIR} -- set it up with .models/triposr/NOTES.md")
    if args.height_cm is not None and not args.height_cm > 0:
        ap.error("--height-cm must be > 0")
    photos = [Path(p) for p in args.photos]
    for p in photos:
        if not p.is_file():
            sys.exit(f"photo3d: no such photo: {p}")
    if args.name and len(photos) > 1:
        ap.error("--name only works with one photo")

    out_arg = Path(args.output) if args.output else DEFAULT_OUT
    if out_arg.suffix.lower() in (".obj", ".glb"):
        if len(photos) > 1:
            ap.error("with several photos, -o must be a directory")
        outs = [out_arg.with_suffix("." + args.format)]
    else:
        outs = [out_arg / f"{p.stem}.{args.format}" for p in photos]

    warnings = []
    if args.height_cm is None:
        warnings.append("no --height-cm given: scale is NOT real, the object is set to 1 m tall")
    height_m = args.height_cm / 100 if args.height_cm else 1.0

    work = Path(tempfile.mkdtemp(prefix="photo3d-"))
    try:
        prepped = []
        for i, p in enumerate(photos):
            dst = work / f"in_{i}.png"
            try:
                size = prepare_photo(p, dst)
            except Exception as err:  # PIL raises many types; the reason is what matters
                sys.exit(f"photo3d: can't read {p}: {err}")
            prepped.append((dst, size))
        print(f"photo3d: running TripoSR on {len(photos)} photo(s) (first run downloads weights; ~15 s each warm)...")
        wall, peak, stages = run_triposr([d for d, _ in prepped], work / "tsr", args)

        for i, (p, out) in enumerate(zip(photos, outs)):
            raw = work / "tsr" / str(i) / "mesh.obj"
            mesh = trimesh.load(raw, process=False, force="mesh")
            mesh, tilt = to_contract_frame(mesh, height_m, level=not args.no_level)
            v = np.asarray(mesh.vertices, dtype=np.float64)
            f = np.asarray(mesh.faces, dtype=np.int64)
            cols = getattr(mesh.visual, "vertex_colors", None)
            rgb = (np.asarray(cols)[:, :3] / 255.0) if cols is not None and len(cols) == len(v) else np.full((len(v), 3), 0.7)
            name = args.name or p.stem
            (write_glb if args.format == "glb" else write_obj)(out, name, v, f, rgb)

            size_m = (v.max(0) - v.min(0)).tolist()
            sidecar = {
                "source": str(p),
                "source_sha256": sha256_of(p),
                "mode": "photo",
                "method": "TripoSR single-image",
                "model": "stabilityai/TripoSR (huggingface), run via .models/triposr/TripoSR/run.py",
                "licence": LICENCE,
                "inferred_area_share": 1.0,
                "percent_inferred": 100,
                "inferred_faces": int(len(f)),
                "total_faces": int(len(f)),
                "why_all_inferred": "a single photo measures no depth; every surface is the network's guess",
                "units": "metres; Y up; camera-facing side +Z; floor at y=0",
                "levelled_deg": round(tilt, 1),
                "scale": {"height_m": round(height_m, 4),
                          "set_from": "--height-cm" if args.height_cm else "none (unit height 1 m, NOT real scale)"},
                "size_m": {"x": round(size_m[0], 4), "y": round(size_m[1], 4), "z": round(size_m[2], 4)},
                "photo_px": list(prepped[i][1]),
                "remove_bg": not args.no_remove_bg,
                "mc_resolution": args.mc_resolution,
                "device": "cpu (run.py uses CUDA or CPU only)",
                "seconds": round(wall / len(photos), 2),
                "batch_seconds_wall": round(wall, 2),
                "stage_ms": {k: round(v_, 1) for k, v_ in stages.items()},
                "peak_memory_gb": round(peak / 1e9, 2) if peak else None,
                "warnings": warnings,
            }
            out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2))
            print(f"{name}: {len(f)} faces, 100% inferred, {size_m[0]:.3f} x {size_m[1]:.3f} x {size_m[2]:.3f} m "
                  f"(W x H x D), levelled {tilt:.1f} deg -> {out}")
        mem = f", peak memory {peak / 1e9:.2f} GB" if peak else ""
        print(f"photo3d: TripoSR {wall:.1f} s wall for {len(photos)} photo(s){mem}")
        for w in warnings:
            print(f"WARNING: {w}")
    finally:
        if args.keep_work:
            print(f"photo3d: TripoSR raw output kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

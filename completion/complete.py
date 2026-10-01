"""Fill in what the scanner missed, and write it out marked as inferred.

The command-line end of Track B (plans/scan-completion/ROADMAP.md). It picks a pipeline by
what the scan is, then writes the output contract the Platform reads:

  object  fill.complete(): mirror the gaps, rebuild slab back-sides, Poisson for whatever
          is left. Tuned on furniture.
  room    planes.plane_extend(): extend floor, walls and ceiling to where they meet and fill
          only where the scan has nothing. The object chain is NOT used on rooms: its
          slab_fill treats walls as slabs and invents surface (room benchmark: 22-27 m2
          added, 18-21% real).
  auto    (default) room if find_planes() sees at least ROOM_SHELL_PLANES shell planes
          (planes with almost nothing behind them), otherwise object.

Output:

  <out>.obj   one `o <name>` object with two material groups, `usemtl scanned` and
              `usemtl inferred`, so the object stays ONE selectable part while its
              filled-in surface can be rendered differently (P5).
  <out>.json  sidecar: method, how much surface was inferred, timings, licence.

Input is one isolated object (clean_scan.py's output, or one part of a segmented room),
or a whole room scan. Units are whatever the scan uses; the pipeline assumes metres.

Usage:
    .venv/bin/python completion/complete.py assets/chair/chair_clean.obj -o completion/out/chair_completed.obj
    .venv/bin/python completion/complete.py scan.obj -o out.obj --watertight
    .venv/bin/python completion/complete.py room.obj -o room_completed.obj --mode room

Check the result in the v1 viewer:
    http://localhost:8080/viewer.html?model=completion/out/chair_completed.obj&plain=1
"""

import argparse
import json
import time
from pathlib import Path

import numpy as np
import pymeshlab

import fill
import planes

ROOM_SHELL_PLANES = 3   # floor + two walls is already a room corner


def write_contract_obj(path, name, v, f, inferred):
    """OBJ with the scanned and inferred faces as two material groups of one object."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as fh:
        fh.write("# scan completion output: usemtl scanned = measured, usemtl inferred = filled in\n")
        fh.write(f"o {name}\n")
        fh.write("".join(f"v {x:.5f} {y:.5f} {z:.5f}\n" for x, y, z in v))
        for label, mask in (("scanned", ~inferred), ("inferred", inferred)):
            if mask.any():
                fh.write(f"usemtl {label}\n")
                fh.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f[mask]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="mesh file (OBJ/PLY/GLB...) of one isolated object")
    ap.add_argument("-o", "--output", required=True, help="output .obj (a .json sidecar is written next to it)")
    ap.add_argument("--name", default=None, help="object name in the OBJ (default: input file stem)")
    ap.add_argument("--watertight", action="store_true",
                    help="object mode only: output the single Poisson surface instead of scan + gap patches")
    ap.add_argument("--mode", choices=["auto", "object", "room"], default="auto",
                    help="which pipeline to run (default: auto-detect from the scan's planes)")
    args = ap.parse_args()

    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(args.input)
    m = ms.current_mesh()
    v, f = m.vertex_matrix().astype(np.float64), m.face_matrix().astype(np.int64)

    start = time.perf_counter()
    mode = args.mode
    shell_planes = None
    if mode == "auto":
        shell_planes = int(sum(bool(pl.shell) for pl in planes.find_planes(v, f, rng=np.random.default_rng(0))))
        mode = "room" if shell_planes >= ROOM_SHELL_PLANES else "object"
    if mode == "room":
        if args.watertight:
            ap.error("--watertight is object mode only")
        out_v, out_f = planes.plane_extend(v, f)
        inferred = np.arange(len(out_f)) >= len(f)   # plane_extend only appends
        method = "plane_extend (scan + plane patches)"
    else:
        out_v, out_f, inferred = fill.complete(v, f, watertight=args.watertight)
        method = "mirror_gaps -> slab_fill -> poisson" + (" (watertight)" if args.watertight else " (scan + gap patches)")
    seconds = time.perf_counter() - start

    _, _, area = fill.face_geometry(out_v, out_f)
    share = float(area[inferred].sum() / area.sum())
    out = Path(args.output)
    name = args.name or Path(args.input).stem
    write_contract_obj(out, name, out_v, out_f, inferred)

    sidecar = {
        "source": str(args.input),
        "mode": mode,
        "mode_detected_from_shell_planes": shell_planes,
        "method": method,
        "inferred_area_share": round(share, 4),
        "inferred_faces": int(inferred.sum()),
        "total_faces": int(len(out_f)),
        "seconds": round(seconds, 2),
        "licence": "measured geometry only -- no third-party model or dataset used",
        "benchmark": "plans/scan-completion/ROADMAP.md (see its Revision History for the current numbers)",
    }
    out.with_suffix(".json").write_text(json.dumps(sidecar, indent=2))
    print(f"{name} [{mode}]: {len(out_f)} faces, {share:.1%} of surface inferred, {seconds:.1f}s -> {out}")


if __name__ == "__main__":
    main()

"""Repair topology problems in a raw scan: disconnected fragments and boundary gaps.

Wraps PyMeshLab (scriptable MeshLab, MIT-licensed) so this never requires opening a GUI
app. Two genuinely different operations, because they solve different problems:

  --close-holes   Patches small gaps in an otherwise-connected surface. Cheap, keeps the
                   original mesh and its texture intact. Weak against a scan fragmented
                   into many separate disconnected islands, since a "hole" here means a
                   boundary loop in one continuous surface, not a gap between two
                   unrelated pieces — closing holes cannot weld separate islands together.

  --poisson       Screened Poisson Surface Reconstruction. Rebuilds ONE new watertight
                   surface directly from point positions and normals, ignoring whatever
                   the original connectivity was. Fixes fragmentation completely (tested
                   on the chair scan: 2134 disconnected pieces -> 6, fully 2-manifold) —
                   but it has two real costs, found by testing, not assumed:

                   1. It discards all texture/color. Only safe to use when the target
                      material won't be sampling the original texture anyway (true for
                      this project's HolographicMaterial, which is fully procedural).
                   2. It smooths PAST a hard crop boundary rather than respecting it —
                      tested on the chair, and the floor patch left under it came out
                      BIGGER and more solid than the simple radius crop alone produces,
                      not smaller. A boundary Poisson has to close off (e.g. where a leg
                      was cut from the floor) can also come out visibly rounded/bulging
                      compared to the original.

                   Requires a crop center + radius, the same numbers analyze_scan.py
                   suggests, because reconstructing the raw scan whole would fuse the
                   wall/floor and the object into one blob.

Always render and look at the result before trusting either one. Neither of these is a
one-click fix — see ROADMAP.md for the chair scan's actual before/after findings.

Usage:
    python repair_scan.py assets/chair/chair.glb                  # just report topology
    python repair_scan.py assets/chair/chair.glb --close-holes -o cleaned.obj
    python repair_scan.py assets/chair/chair.glb --poisson \\
        --crop-center-x -0.02 --crop-center-z -0.14 --crop-radius 0.65 -o cleaned.obj
"""

import argparse

import pymeshlab


def report_topology(ms, label):
    t = ms.get_topological_measures()
    print(f"--- topology: {label} ---")
    print(f"  vertices: {t['vertices_number']}   faces: {t['faces_number']}")
    print(f"  connected components: {t['connected_components_number']}")
    print(f"  boundary edges: {t['boundary_edges']}")
    print(f"  non-manifold vertices: {t['non_two_manifold_vertices']}   "
          f"non-manifold edges: {t['non_two_manifold_edges']}")
    print(f"  is 2-manifold: {t['is_mesh_two_manifold']}")
    print()
    return t


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("glb_path")
    ap.add_argument("-o", "--output", help="Where to save the repaired mesh (required with --close-holes/--poisson).")
    ap.add_argument("--close-holes", action="store_true", help="Patch boundary gaps. Keeps texture.")
    ap.add_argument("--max-hole-size", type=int, default=1000,
                     help="Largest hole (in edges) --close-holes will patch (default 1000). Tested on the "
                          "chair scan this only helped modestly (29654 -> 22168 boundary edges, components "
                          "barely moved) because most of its problem is fragmentation, not small gaps.")
    ap.add_argument("--poisson", action="store_true",
                     help="Full surface reconstruction. Fixes fragmentation completely but discards texture "
                          "and can smear past crop boundaries -- see this file's module docstring before using.")
    # Separate x/z floats rather than one "x,z" string: argparse's negative-number
    # detection only recognizes a single bare "-0.02"-shaped token, not one embedding a
    # comma and a second sign, so "-0.02,-0.14" as one argument gets misread as a flag.
    ap.add_argument("--crop-center-x", type=float, help="Required with --poisson. From analyze_scan.py.")
    ap.add_argument("--crop-center-z", type=float, help="Required with --poisson. From analyze_scan.py.")
    ap.add_argument("--crop-radius", type=float, help="Required with --poisson. From analyze_scan.py.")
    args = ap.parse_args()

    if args.poisson and (args.crop_center_x is None or args.crop_center_z is None or args.crop_radius is None):
        ap.error("--poisson needs --crop-center-x, --crop-center-z and --crop-radius (run analyze_scan.py first)")
    if (args.close_holes or args.poisson) and not args.output:
        ap.error("--close-holes/--poisson need -o/--output")

    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(args.glb_path)
    report_topology(ms, "original")

    if args.close_holes:
        ms.meshing_close_holes(maxholesize=args.max_hole_size)
        report_topology(ms, f"after close-holes (max size {args.max_hole_size})")
        # save_textures=False: this build of PyMeshLab can't re-export a GLB's embedded
        # texture when writing OBJ (its internal name has no file extension to infer a
        # format from -- a real limitation, confirmed by testing, not a guess). Moot for
        # this project anyway since HolographicMaterial never samples texture.
        ms.save_current_mesh(args.output, save_textures=False)
        print(f"saved {args.output} (without texture -- see comment above)")

    elif args.poisson:
        cx, cz = args.crop_center_x, args.crop_center_z
        ms.compute_selection_by_condition_per_vertex(
            condselect=f"sqrt((x-({cx}))^2 + (z-({cz}))^2) >= {args.crop_radius}"
        )
        ms.meshing_remove_selected_vertices()
        print(f"cropped to radius {args.crop_radius} around ({cx}, {cz}): "
              f"{ms.current_mesh().vertex_number()} vertices remain")

        ms.generate_surface_reconstruction_screened_poisson()
        ms.set_current_mesh(ms.mesh_number() - 1)
        report_topology(ms, "after Poisson reconstruction")

        print("NOTE: this mesh has no texture or vertex color -- only usable with a material")
        print("that doesn't sample the original scan's color, like HolographicMaterial.")
        print()
        ms.save_current_mesh(args.output, save_textures=False)
        print(f"saved {args.output} -- render it before deciding to use it. See this file's")
        print("docstring: on the chair scan this made the cropped floor boundary MORE visible,")
        print("not less, despite fixing every topology number.")

    else:
        print("(pass --close-holes or --poisson to actually repair something; showed topology only)")


if __name__ == "__main__":
    main()

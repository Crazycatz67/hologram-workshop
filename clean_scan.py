"""Turn a raw LiDAR scan into a clean, watertight, isolated object mesh.

This is the "give it the messy scan, get back just the object" pipeline. It exists
because doing these steps by hand (or by eyeballed constants) went wrong in a specific,
instructive way on the chair scan — see WHY THE OBVIOUS APPROACH FAILS below.

Stages, in order. Each can be skipped; each reports what it did so a bad stage is
visible rather than silent:

  1. ISOLATE    Radius crop around the object, to drop far-away walls and furniture.
                Same numbers analyze_scan.py suggests.
  2. DEFLOOR    Find the floor (and walls) as PLANES and delete only the plane surface
                itself, keeping anything resting on it.
  3. SPECKLE    Drop only truly tiny isolated fragments, before anything else can weld
                them into the surface.
  4. COMPLETE   Optional. Fill missing structure by mirroring the object across its own
                symmetry plane, so a leg the scanner missed is rebuilt from the matching
                leg it did capture.
  5. FILL       Screened Poisson reconstruction: one watertight surface, gaps closed.
  6. DEBRIS     Drop leftover disconnected pieces. This runs AFTER the fill, not before:
                a raw scan is fragmented into hundreds of small pieces that are all real
                surface, and size-filtering them first deletes the object. Measured on
                the chair: running debris removal before Poisson cut 17420 vertices down
                to 4935 -- 71% of the chair thrown away as "debris". After Poisson has
                welded the fragments into one surface, anything still disconnected really
                is junk, and the same filter is safe.
  7. REBASE     Shave Poisson's overshoot back to the real floor plane and cap it flat,
                so feet end in a clean edge instead of a melted dome.
  8. SMOOTH     Remove the bumpy, orange-peel surface noise a handheld scan always carries.
                Uses Taubin smoothing specifically, not plain Laplacian: Laplacian pulls
                every vertex toward its neighbours' average, which shrinks the whole model
                a little more with every step (thin parts like chair legs suffer worst).
                Taubin alternates a smoothing step with a slight outward step, so noise
                averages away while overall volume stays put. Reconstructed regions show
                the noise most, because Poisson interpolates through sparse data.
  9. SIMPLIFY   Optional. Decimate to a target face count so the result is web-loadable.
                Reconstruction roughly doubles the triangle count of the original scan
                and those extra triangles carry no extra detail -- they are subdivision of
                a smooth interpolated surface, not measurements.

WHY THE OBVIOUS APPROACH FAILS
------------------------------
The intuitive way to remove a floor is "delete everything below height H". On the chair
scan this destroyed the chair. It is a sled-base chair: two runners lie flat ON the floor
connecting the front and back legs. Measured, not guessed — in the 8cm band above the
floor there were 2742 vertices, and 1456 of them had non-horizontal normals, i.e. were
chair structure, not floor. A height cut cannot tell them apart, because at floor level
the chair and the floor occupy the same heights. It deleted both runners and left a
chair standing on stumps.

The same failure would hit a bed frame, a Lego baseplate, a wheelchair, or anything else
whose base touches the ground — which is most things worth scanning.

What actually separates them is not height but SURFACE IDENTITY: a floor is one large
flat plane whose normals all point the same way and which runs off past the edge of the
capture. A runner sitting on that floor is at the same height but its sides face
sideways, and it stays inside the capture. So this detects the plane and removes points
lying in it, and everything else survives regardless of how low it sits.

The bounded/unbounded test matters too, and is why this won't eat a bed's mattress top or
a Lego baseplate: an object's own flat face is bounded well inside the crop, while floors
and walls extend to the crop boundary. A plane is only treated as environment if it is
both large AND reaches the edge.

WHAT THIS CANNOT DO
-------------------
It does not invent detail that was never scanned. Poisson closes gaps by smoothly
interpolating across them, which is honest for a small hole and a guess for a large one;
--symmetrize is the only stage that fills a gap with real measured geometry, and it only
works on objects that are actually symmetric. True generative 3D inpainting (describe the
missing part, have a model synthesise it) is a different, paid, research-grade problem —
deliberately out of scope here, see ROADMAP.md.

Always render the result and look at it. Every constant below has a tested default, not
a correct one.

Usage:
    # inspect only -- what planes does it find, what would it remove?
    python clean_scan.py assets/chair/chair.glb --crop-center-x -0.02 \\
        --crop-center-z -0.14 --crop-radius 0.60 --dry-run

    # the full pipeline
    python clean_scan.py assets/chair/chair.glb --crop-center-x -0.02 \\
        --crop-center-z -0.14 --crop-radius 0.60 --symmetrize -o assets/chair/chair_clean.obj
"""

import argparse

import numpy as np
import pymeshlab


# A vertex counts as lying "in" a plane if it is within this distance of it AND its normal
# agrees with the plane's to within this angle. Both are needed: distance alone catches
# the runners resting on the floor, normal agreement is what lets them survive.
PLANE_DISTANCE = 0.012          # metres
PLANE_NORMAL_AGREEMENT = 0.80   # |dot(vertex normal, plane normal)|, so ~37 degrees

# A detected plane counts as ground only if it WRAPS THE CAPTURE BOUNDARY: the ring at the
# edge of the crop is cut into 24 sectors, and the plane must reach the edge in at least
# this many of them. This is the test that works, arrived at by measuring the alternatives
# on the chair scan:
#
#   the real floor          22/24 sectors
#   the chair's own side     1/24
#   scattered near-planar noise across the chair   2/24
#
# An earlier version scored planes by their in-plane extent instead. That failed: an
# infinite plane collects scattered points from all over the mesh that happen to lie near
# it, so noise scored a 130%-of-crop "extent" and the classifier tried to delete the
# backrest. Extent measures the spread of coincidence; boundary wrap measures whether the
# surface actually runs off the edge of the world, which is what being a floor means.
#
# This is also why an object's own big flat face is safe: a mattress top, a Lego baseplate
# or a table surface sits bounded inside the crop and cannot wrap its boundary. If one
# genuinely does span the whole crop, the crop radius is set too tight -- fix that instead.
ENV_MIN_INLIER_SHARE = 0.03
BOUNDARY_SECTORS = 24
ENV_MIN_BOUNDARY_SECTORS = 12
BOUNDARY_ANNULUS = 0.80  # "at the edge" means beyond this fraction of the crop radius

RANSAC_ITERATIONS = 400


def load(path):
    ms = pymeshlab.MeshSet()
    ms.load_new_mesh(path)
    ms.compute_normal_per_vertex()
    return ms


def describe(ms, label):
    m = ms.current_mesh()
    t = ms.get_topological_measures()
    print(
        f"  {label:<22} {m.vertex_number():>7} verts  {m.face_number():>7} faces  "
        f"{t['connected_components_number']:>5} components  "
        f"{'manifold' if t['is_mesh_two_manifold'] else 'NON-manifold'}"
    )


def isolate(ms, cx, cz, radius):
    """Drop everything outside a vertical cylinder around the object."""
    ms.compute_selection_by_condition_per_vertex(
        condselect=f"(sqrt((x-({cx}))^2 + (z-({cz}))^2) >= {radius})"
    )
    ms.meshing_remove_selected_vertices()


def detect_environment_planes(v, n, cx, cz, radius, max_planes, rng):
    """Find large flat planes that run to the edge of the capture: floors and walls.

    Returns a list of (point_on_plane, unit_normal, inlier_count, extent). Deliberately
    returns the diagnostics too, because whether a plane is environment or object is the
    judgement call in this whole file and it should be inspectable with --dry-run.
    """
    planes = []
    remaining = np.ones(len(v), dtype=bool)
    crop_diameter = 2.0 * radius

    for _ in range(max_planes):
        idx = np.flatnonzero(remaining)
        if len(idx) < 50:
            break

        vr, nr = v[idx], n[idx]
        best = None

        for _ in range(RANSAC_ITERATIONS):
            pick = rng.choice(len(vr), 3, replace=False)
            p0, p1, p2 = vr[pick]
            normal = np.cross(p1 - p0, p2 - p0)
            norm = np.linalg.norm(normal)
            if norm < 1e-9:
                continue
            normal = normal / norm

            dist = np.abs((vr - p0) @ normal)
            aligned = np.abs(nr @ normal) > PLANE_NORMAL_AGREEMENT
            inliers = (dist < PLANE_DISTANCE) & aligned
            count = int(inliers.sum())
            if best is None or count > best[0]:
                best = (count, p0, normal, inliers)

        if best is None:
            break
        count, p0, normal, inliers = best
        if count < 50:
            break

        # How much of the capture boundary this plane reaches: see BOUNDARY_SECTORS above.
        pts = vr[inliers]
        pr = np.hypot(pts[:, 0] - cx, pts[:, 2] - cz)
        edge = pts[pr > BOUNDARY_ANNULUS * radius]
        if len(edge):
            ang = np.degrees(np.arctan2(edge[:, 2] - cz, edge[:, 0] - cx))
            sector_width = 360.0 / BOUNDARY_SECTORS
            sectors = len(np.unique(((ang + 180.0) // sector_width).astype(int)))
        else:
            sectors = 0

        planes.append((p0, normal, count, sectors))
        remaining[idx[inliers]] = False

        if count / len(v) < ENV_MIN_INLIER_SHARE:
            break

    classified = []
    for p0, normal, count, sectors in planes:
        is_env = (
            count / len(v) >= ENV_MIN_INLIER_SHARE
            and sectors >= ENV_MIN_BOUNDARY_SECTORS
        )
        classified.append((p0, normal, count, sectors, is_env))
    return classified


def remove_plane(ms, p0, normal):
    """Delete vertices lying in a given plane (position AND normal must both match)."""
    a, b, c = normal
    d = -float(np.dot(normal, p0))
    ms.compute_selection_by_condition_per_vertex(
        condselect=(
            f"(abs({a}*x + {b}*y + {c}*z + ({d})) < {PLANE_DISTANCE}) && "
            f"(abs({a}*nx + {b}*ny + {c}*nz) > {PLANE_NORMAL_AGREEMENT})"
        )
    )
    removed = ms.current_mesh().selected_vertex_number()
    ms.meshing_remove_selected_vertices()
    return removed


SYMMETRY_VOXEL = 0.02          # metres; also the tolerance of the overlap test
SYMMETRY_MIN_OVERLAP = 0.60    # below this, refuse to mirror


def _overlap(sample, occupied, normal, offset):
    """Fraction of mirrored sample points that land on geometry the scan actually has."""
    mirrored = sample - 2.0 * ((sample @ normal) - offset)[:, None] * normal[None, :]
    keys = np.floor(mirrored / SYMMETRY_VOXEL).astype(int)
    return sum(1 for k in map(tuple, keys) if k in occupied) / len(keys)


def find_symmetry_plane(v, rng):
    """Find the object's mirror plane, searching VERTICAL planes at any orientation.

    Returns (unit_normal, offset, overlap). Overlap is the share of the object that lands
    back on itself when mirrored — near 1.0 for a symmetric object, low for an asymmetric
    one, so it doubles as the trust signal for whether mirroring is safe at all.

    Searching arbitrary orientations rather than just x=const / z=const is not a refinement,
    it is the difference between working and not. Measured on the chair scan, which sits
    rotated in the capture like any hand-held scan will:

        best plane at 164 degrees azimuth   88.4% overlap
        axis-aligned X                      23.8%
        axis-aligned Z                      18.2%

    Scored by voxel occupancy rather than nearest-neighbour distance: it needs no spatial
    index, is O(1) per point, and the voxel size doubles as the match tolerance.
    """
    sample = v[rng.choice(len(v), min(6000, len(v)), replace=False)]
    occupied = set(map(tuple, np.floor(v / SYMMETRY_VOXEL).astype(int)))

    def search(angles, offsets_for):
        best = None
        for theta in angles:
            normal = np.array([np.cos(theta), 0.0, np.sin(theta)])
            for offset in offsets_for(normal):
                s = _overlap(sample, occupied, normal, offset)
                if best is None or s > best[2]:
                    best = (theta, float(offset), s)
        return best

    proj_range = lambda normal: np.linspace((v @ normal).min() + 0.1, (v @ normal).max() - 0.1, 30)
    theta, offset, overlap = search(np.linspace(0, np.pi, 46, endpoint=False), proj_range)

    # refine locally around the coarse winner
    fine = search(
        np.linspace(theta - 0.08, theta + 0.08, 9),
        lambda normal: np.linspace(offset - 0.03, offset + 0.03, 13),
    )
    if fine[2] >= overlap:
        theta, offset, overlap = fine

    return np.array([np.cos(theta), 0.0, np.sin(theta)]), offset, overlap


def symmetrize(ms, normal, offset):
    """Add a mirrored copy of the mesh so gaps on one side are filled by the other side.

    This does not blend or invent: it puts real, measured geometry where the scanner saw
    nothing, and lets the fill stage fuse the two copies into one surface. That is the
    difference between rebuilding a missing leg from the leg opposite it and hallucinating
    one. It only works on genuinely symmetric objects, which is why the caller checks the
    overlap score first.
    """
    m = ms.current_mesh()
    v = m.vertex_matrix().copy()
    f = m.face_matrix().copy()

    v = v - 2.0 * ((v @ normal) - offset)[:, None] * normal[None, :]
    f = f[:, ::-1]  # mirroring flips winding order; flip it back so normals stay outward

    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=v, face_matrix=f), "mirrored")
    ms.generate_by_merging_visible_meshes()
    ms.compute_normal_per_vertex()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scan_path")
    ap.add_argument("-o", "--output", help="Where to write the cleaned mesh.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report the planes found and stop, changing nothing.")

    ap.add_argument("--crop-center-x", type=float, required=True, help="From analyze_scan.py.")
    ap.add_argument("--crop-center-z", type=float, required=True, help="From analyze_scan.py.")
    ap.add_argument("--crop-radius", type=float, required=True, help="From analyze_scan.py.")

    ap.add_argument("--max-planes", type=int, default=4,
                    help="How many planes to look for (floor plus up to three walls).")
    ap.add_argument("--keep-floor", action="store_true", help="Skip the DEFLOOR stage.")
    ap.add_argument("--speckle-percent", type=float, default=1.0,
                    help="Pre-fill pass: drop only tiny isolated fragments, as %% of bbox diagonal. "
                         "Keep this small -- a raw scan's real surface is fragmented.")
    ap.add_argument("--debris-percent", type=float, default=20.0,
                    help="Post-fill pass: drop disconnected pieces smaller than this %% of the "
                         "bounding-box diagonal. Safe here because Poisson has already welded "
                         "genuine surface into one piece.")
    ap.add_argument("--symmetrize", action="store_true",
                    help="Rebuild missing structure by mirroring across the object's symmetry plane.")
    ap.add_argument("--symmetry-axis", choices=["auto", "x", "z"], default="auto")
    ap.add_argument("--no-fill", action="store_true", help="Skip Poisson reconstruction.")
    ap.add_argument("--poisson-depth", type=int, default=9)
    ap.add_argument("--no-rebase", action="store_true",
                    help="Leave Poisson's rounded overshoot below the floor instead of cutting it flat.")
    ap.add_argument("--smooth", type=int, default=0, metavar="STEPS",
                    help="Taubin smoothing steps, to remove scan surface noise. Volume-preserving, "
                         "so it will not thin out legs. Try 10-20; too high erases real detail "
                         "(upholstery seams) along with the noise. 0 disables.")
    ap.add_argument("--target-faces", type=int,
                    help="Decimate to about this many faces so the mesh is web-loadable. "
                         "The chair scan ships at ~76k, measured at 0.07ms/frame in Phase 2.")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    if not args.dry_run and not args.output:
        ap.error("-o/--output is required unless --dry-run is given")

    rng = np.random.default_rng(args.seed)

    print(f"\nreading {args.scan_path}")
    ms = load(args.scan_path)
    describe(ms, "raw")

    isolate(ms, args.crop_center_x, args.crop_center_z, args.crop_radius)
    describe(ms, "1. isolate")

    m = ms.current_mesh()
    planes = detect_environment_planes(
        m.vertex_matrix(), m.vertex_normal_matrix(),
        args.crop_center_x, args.crop_center_z, args.crop_radius,
        args.max_planes, rng,
    )

    print("\n  planes found (normal / share of vertices / boundary wrap / verdict):")
    for p0, normal, count, sectors, is_env in planes:
        share = count / m.vertex_number()
        print(
            f"    n=({normal[0]:+.2f},{normal[1]:+.2f},{normal[2]:+.2f}) at y={p0[1]:+.3f}  "
            f"{share:5.1%}  {sectors:2d}/{BOUNDARY_SECTORS} sectors  "
            f"{'GROUND -> remove' if is_env else 'object -> keep'}"
        )

    floor_y = None
    for p0, normal, _, _, is_env in planes:
        if is_env and abs(normal[1]) > 0.85:
            floor_y = float(p0[1])
            break
    if floor_y is not None:
        print(f"\n  floor plane detected at y = {floor_y:.4f}")

    if args.dry_run:
        print("\n(dry run -- nothing written)\n")
        return

    if not args.keep_floor:
        total = 0
        for p0, normal, _, _, is_env in planes:
            if is_env:
                total += remove_plane(ms, p0, normal)
        print(f"\n  removed {total} vertices lying in the ground plane")

        # The one height cut that is always safe: strictly BELOW the detected floor is
        # underground, so nothing there can be part of an object standing on it. This
        # mops up second/drifted floor layers the plane pass did not claim. Note the
        # direction -- cutting below a *measured* floor is safe; cutting below a *guessed*
        # height is what destroyed the chair's runners.
        if floor_y is not None:
            ms.compute_selection_by_condition_per_vertex(condselect=f"y < {floor_y}")
            under = ms.current_mesh().selected_vertex_number()
            ms.meshing_remove_selected_vertices()
            print(f"  removed {under} vertices below the floor plane")

        describe(ms, "2. defloor")

    ms.meshing_remove_connected_component_by_diameter(
        mincomponentdiag=pymeshlab.PercentageValue(args.speckle_percent)
    )
    describe(ms, "3. speckle")

    if args.symmetrize:
        m = ms.current_mesh()
        normal, offset, overlap = find_symmetry_plane(m.vertex_matrix(), rng)
        azimuth = np.degrees(np.arctan2(normal[2], normal[0]))
        print(f"\n  symmetry plane: azimuth {azimuth:.1f} deg, offset {offset:+.4f}  "
              f"-- {overlap:.1%} of the object mirrors onto itself")
        if overlap < SYMMETRY_MIN_OVERLAP:
            print(f"  SKIPPED: below the {SYMMETRY_MIN_OVERLAP:.0%} threshold, this object is not "
                  f"symmetric enough to mirror safely.")
        else:
            symmetrize(ms, normal, offset)
            describe(ms, "4. complete")

    if not args.no_fill:
        # Poisson writes its result into a NEW mesh and makes it current. Do not try to
        # select it by index: PyMeshLab mesh IDs are not array indices, and after the
        # symmetrize stage's merge the surviving mesh has ID 2 while mesh_number() is 1,
        # so set_current_mesh(mesh_number()-1) selects a deleted mesh and everything after
        # it fails with "MeshSet has no current Mesh".
        before_id = ms.current_mesh_id()
        ms.generate_surface_reconstruction_screened_poisson(depth=args.poisson_depth)
        if ms.current_mesh_id() == before_id:
            raise SystemExit("Poisson reconstruction produced no new mesh -- input too sparse, "
                             "or vertex normals are missing.")
        describe(ms, "5. fill")

        ms.meshing_remove_connected_component_by_diameter(
            mincomponentdiag=pymeshlab.PercentageValue(args.debris_percent)
        )
        describe(ms, "6. debris")

        if not args.no_rebase and floor_y is not None:
            # Poisson rounds a hard cut into a dome that overshoots past where the real
            # geometry ended, which is what makes scanned feet look melted. Cut back to
            # the measured floor and cap flat.
            ms.compute_selection_by_condition_per_vertex(condselect=f"y < {floor_y}")
            ms.meshing_remove_selected_vertices()
            ms.meshing_remove_connected_component_by_diameter(
                mincomponentdiag=pymeshlab.PercentageValue(args.debris_percent)
            )
            ms.meshing_close_holes(maxholesize=300)
            describe(ms, "7. rebase")

    if args.smooth:
        # Runs before decimation, not after: smoothing a dense mesh then simplifying gives
        # the decimator a cleaner surface to approximate, whereas smoothing afterwards has
        # far fewer vertices to work with and blurs the silhouette instead of the noise.
        ms.apply_coord_taubin_smoothing(stepsmoothnum=args.smooth)
        describe(ms, "8. smooth")

    if args.target_faces:
        if ms.current_mesh().face_number() > args.target_faces:
            # preservetopology matters: without it, quadric collapse happily creates
            # non-manifold edges and silently undoes the watertightness the fill stage
            # just established.
            ms.meshing_decimation_quadric_edge_collapse(
                targetfacenum=args.target_faces,
                preserveboundary=True,
                preservenormal=True,
                preservetopology=True,
                planarquadric=True,
            )
            describe(ms, "9. simplify")

    ms.save_current_mesh(args.output, save_textures=False)
    print(f"\nwrote {args.output}\n")


if __name__ == "__main__":
    main()

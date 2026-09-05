"""Suggest crop parameters for a raw Scaniverse GLB scan.

Turns the by-hand analysis done for the chair scan (see ROADMAP.md Phase 2/3) into a
repeatable tool: histograms the real vertex data, looks for a genuine empty gap between
"the object" and "everything else the scan happened to pick up," and reports a center +
radius ready to paste into trimGeometry.js's trimByCylinder().

This tool only RECOMMENDS parameters - it does not modify the GLB or apply the crop
itself. The actual cropping logic already exists and is tested in trimGeometry.js;
duplicating it here in Python would mean two implementations to keep in sync for no
reason. Always look at the printed histogram before trusting the suggestion: a real gap
looks like a run of near-zero bins between two populated regions, not a guess.

Assumes Y is up, matching glTF/Scaniverse convention.

Usage:
    python analyze_scan.py assets/chair/chair.glb
    python analyze_scan.py assets/chair/chair.glb --floor-fraction 0.15 --bins 40
"""

import argparse
import json
import struct
import sys

import numpy as np

COMPONENT_DTYPES = {5121: "u1", 5123: "<u2", 5125: "<u4"}


def load_positions(glb_path):
    with open(glb_path, "rb") as f:
        f.read(12)  # magic, version, total length
        chunk_len, _ = struct.unpack("<II", f.read(8))
        gltf = json.loads(f.read(chunk_len).decode("utf-8"))
        chunk_len, _ = struct.unpack("<II", f.read(8))
        binary = f.read(chunk_len)

    all_pos = []
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            bv = gltf["bufferViews"][acc["bufferView"]]
            offset = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
            count = acc["count"]
            data = binary[offset : offset + count * 12]
            all_pos.append(np.frombuffer(data, dtype="<f4").reshape(count, 3))

    if not all_pos:
        raise ValueError(f"no POSITION accessor found in {glb_path}")
    return np.concatenate(all_pos, axis=0)


def ascii_hist(values, bins, width=60, label=""):
    hist, edges = np.histogram(values, bins=bins)
    total = max(hist.sum(), 1)
    print(f"--- {label} ---")
    for h, e0, e1 in zip(hist, edges[:-1], edges[1:]):
        bar = "#" * min(width, int(width * 2 * h / total))
        print(f"  [{e0:7.3f},{e1:7.3f}) {h:6d} {bar}")
    print()
    return hist, edges


def find_widest_gap(r, bins, search_from_fraction, noise_fraction):
    """Finds the widest run of near-empty bins in the radius histogram, after skipping
    past the point where `search_from_fraction` of all vertices have already appeared -
    a gap right next to the center isn't a real object/clutter boundary, just the empty
    middle every radial histogram has."""
    hist, edges = np.histogram(r, bins=bins, range=(0, np.percentile(r, 99)))
    total = hist.sum()
    cumulative = np.cumsum(hist)
    start_bin = np.searchsorted(cumulative, search_from_fraction * total)
    noise_floor = noise_fraction * total

    best = None  # (run_length, start_idx, end_idx)
    run_start = None
    for i in range(start_bin, len(hist)):
        if hist[i] <= noise_floor:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                run_len = i - run_start
                if best is None or run_len > best[0]:
                    best = (run_len, run_start, i)
                run_start = None
    if run_start is not None:
        run_len = len(hist) - run_start
        if best is None or run_len > best[0]:
            best = (run_len, run_start, len(hist))

    if best is None:
        return None
    _, i0, i1 = best
    gap_start, gap_end = edges[i0], edges[i1]
    return gap_start, gap_end


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("glb_path")
    ap.add_argument("--floor-fraction", type=float, default=0.15,
                    help="Fraction of the Y range treated as 'near the ground' and excluded before "
                         "estimating the object's XZ center (default 0.15 - worked for the chair).")
    ap.add_argument("--bins", type=int, default=40, help="Histogram resolution (default 40).")
    ap.add_argument("--search-from-fraction", type=float, default=0.25,
                    help="Skip this fraction of cumulative vertices before looking for a gap, so the "
                         "empty middle of the radial histogram isn't mistaken for a real boundary.")
    ap.add_argument("--noise-fraction", type=float, default=0.005,
                    help="A histogram bin below this fraction of total vertices counts as 'empty' "
                         "rather than requiring exactly zero, to tolerate a few stray noise points.")
    args = ap.parse_args()

    pos = load_positions(args.glb_path)
    print(f"vertices: {len(pos)}")
    print(f"bbox min: {pos.min(axis=0).round(3)}  max: {pos.max(axis=0).round(3)}")
    print()

    y_lo, y_hi = np.percentile(pos[:, 1], [1, 99])
    floor_cutoff = y_lo + args.floor_fraction * (y_hi - y_lo)
    above_floor = pos[pos[:, 1] > floor_cutoff]
    print(f"Y range (1st-99th pct): {y_lo:.3f} to {y_hi:.3f}")
    print(f"floor cutoff (bottom {args.floor_fraction:.0%} of that range): Y > {floor_cutoff:.3f}")
    print(f"vertices above floor cutoff: {len(above_floor)} of {len(pos)}")
    print()

    if len(above_floor) < 100:
        print("WARNING: almost nothing is above the floor cutoff - --floor-fraction is probably too "
              "high for this scan, or Y isn't actually the up axis here. Check the bbox above.")
        sys.exit(1)

    cx, cz = np.median(above_floor[:, 0]), np.median(above_floor[:, 2])
    print(f"candidate center (median XZ of above-floor points): x={cx:.3f} z={cz:.3f}")
    print()

    r_all = np.hypot(pos[:, 0] - cx, pos[:, 2] - cz)
    ascii_hist(r_all, args.bins, label="radius from candidate center, ALL vertices")

    gap = find_widest_gap(r_all, args.bins, args.search_from_fraction, args.noise_fraction)

    print("=" * 60)
    if gap is None:
        fallback = float(np.percentile(r_all, 90))
        print("No clear empty gap found in the radius histogram - this scan may not have")
        print("separable clutter, or the object fills most of the capture volume.")
        print(f"Falling back to the 90th percentile radius as a loose outlier cut: {fallback:.3f}")
        print()
        print("Look at the histogram above yourself before using this. It is a guess, not a")
        print("measurement, unlike the gap-based result below.")
        radius = fallback
    else:
        gap_start, gap_end = gap
        radius = (gap_start + gap_end) / 2
        kept = (r_all < radius).sum()
        print(f"Found an empty gap in the data: radius {gap_start:.3f} to {gap_end:.3f}")
        print(f"Suggested cutoff (gap midpoint): {radius:.3f}")
        print(f"Vertices inside cutoff: {kept} of {len(pos)} ({100*kept/len(pos):.1f}%)")
        print()
        print("Sensitivity check - this should barely move within the gap, confirming it's a")
        print("real seam and not a coin flip:")
        for frac in (0.2, 0.4, 0.6, 0.8):
            r_test = gap_start + frac * (gap_end - gap_start)
            k = (r_all < r_test).sum()
            print(f"  radius={r_test:.3f}: {k} kept ({100*k/len(pos):.1f}%)")

    print()
    print("Paste into main.js / hologram.js (or wherever trimByCylinder is called):")
    print(f"  const CHAIR_TRIM = {{ center: {{ x: {cx:.3f}, z: {cz:.3f} }}, radius: {radius:.3f} }};")
    print()
    print("This is a suggestion, not a guarantee - check the histogram above matches what you'd")
    print("expect (one populated region near the center, a gap, then whatever else got scanned)")
    print("before trusting it on an object this script has never seen.")


if __name__ == "__main__":
    main()

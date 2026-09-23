"""Assemble a board + one scan of each piece TYPE into one combined, multi-part chess hologram.

WHY THIS EXISTS INSTEAD OF SCANNING THE WHOLE SET AT ONCE
-----------------------------------------------------------
The first attempt was to scan the whole board+32-piece set in one capture and split it into
parts with clean_scan.py's --multi-part mode. That mode works correctly (verified against
synthetic data) but the real capture defeated it: 33 real objects came back as 376
disconnected fragments, and even abandoning the split-into-parts idea and reconstructing the
whole scan as ONE object crashed Poisson reconstruction outright. Thin, small, detailed
objects -- exactly what chess pieces are -- are close to a worst case for phone LiDAR
resolution, and having 33 of them close together in one sweep made it worse, not just harder.

The fix is a capture-granularity change, not a code workaround. A standard chess set has only
SIX unique piece shapes (pawn/rook/knight/bishop/queen/king), each duplicated per
square/color -- and since the hologram shader recolors every mesh regardless of its scanned
material (see hologram.js), piece color is irrelevant to the final render. So: scan the board
once, and one example of each of the six piece types -- seven small, simple, reliable
single-object captures, each already provable through clean_scan.py's existing, UNMODIFIED
single-object pipeline (no --multi-part needed for any of them, since each capture only ever
has one real object in it -- the same class of input the chair pipeline is already proven on).

This script does the one new piece of work: take those seven already-cleaned meshes and lay
them out onto a standard starting position, duplicating each piece type onto every square it
occupies, and writing one combined OBJ with `o <square>` group headers -- the same grouped-OBJ
convention clean_scan.py's --multi-part mode already produces, so hologram.js/manipulator.js
need no changes to load and explode the result.

WHAT THIS DOES NOT DO
----------------------
No chess rules, no legality, no turn order. It places pieces at their STARTING squares purely
as a display arrangement -- the resulting hologram is exactly as interactive as any other
literal-explode object (grab/move/rotate any part once exploded), nothing more.

Board orientation is whatever the scan's own X/Z axes happen to be -- the script doesn't know
or need to know which physical edge is "White's side"; it lays out two back ranks of major
pieces flanking two ranks of pawns with the center empty, which is a correct STARTING
POSITION regardless of which way it's facing. Rotate the hologram in the viewer as needed.

Usage:
    python assemble_chess_set.py \\
        --board assets/chess/board_clean.obj \\
        --pawn assets/chess/pieces/pawn_clean.obj \\
        --rook assets/chess/pieces/rook_clean.obj \\
        --knight assets/chess/pieces/knight_clean.obj \\
        --bishop assets/chess/pieces/bishop_clean.obj \\
        --queen assets/chess/pieces/queen_clean.obj \\
        --king assets/chess/pieces/king_clean.obj \\
        -o assets/chess/chess_assembled.obj

    # inspect the computed layout without writing anything
    ... --dry-run
"""

import argparse

import numpy as np
import pymeshlab

from clean_scan import load, write_multi_part_obj

# Standard chess starting position, expressed as an 8x8 grid of piece-type names (None = empty
# square). Row 0 and row 7 are the two back ranks; rows 1 and 6 are the two pawn ranks. Which
# physical row ends up which color/side is arbitrary here -- see the module docstring.
BACK_RANK = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"]
FILES = "abcdefgh"

STARTING_LAYOUT = {}
for col, piece in enumerate(BACK_RANK):
    STARTING_LAYOUT[f"{FILES[col]}1"] = piece
    STARTING_LAYOUT[f"{FILES[col]}8"] = piece
for col in range(8):
    STARTING_LAYOUT[f"{FILES[col]}2"] = "pawn"
    STARTING_LAYOUT[f"{FILES[col]}7"] = "pawn"

# Top-surface detection: rather than trusting the single highest vertex (which could be one
# noisy outlier), take the median Y among the top slice of vertices by height -- robust to a
# few spikes, the same reasoning behind percentile-based measurements elsewhere in this
# project's tools.
BOARD_TOP_PERCENTILE = 97.0


def board_top_y(v):
    threshold = np.percentile(v[:, 1], BOARD_TOP_PERCENTILE)
    top_slice = v[v[:, 1] >= threshold, 1]
    return float(np.median(top_slice))


def board_footprint(v, border_fraction):
    """The board's usable XZ play area, shrunk in from its full scanned extent by
    border_fraction on each side -- a real board typically has a decorative border around the
    8x8 area, and this is a simple, tunable first-pass approximation of it, not a detected
    measurement. Always check the result visually (see the module docstring and the plan's
    manual verification step)."""
    min_x, max_x = float(v[:, 0].min()), float(v[:, 0].max())
    min_z, max_z = float(v[:, 2].min()), float(v[:, 2].max())
    shrink_x = (max_x - min_x) * border_fraction
    shrink_z = (max_z - min_z) * border_fraction
    return min_x + shrink_x, max_x - shrink_x, min_z + shrink_z, max_z - shrink_z


def square_center(row, col, min_x, max_x, min_z, max_z):
    x = min_x + (max_x - min_x) * (col + 0.5) / 8.0
    z = min_z + (max_z - min_z) * (row + 0.5) / 8.0
    return x, z


def place_piece(v, target_x, target_y, target_z):
    """Returns a NEW vertex matrix for one piece instance, translated so its own XZ center
    sits at the target square and its own bottom rests at the target Y -- the piece's OWN
    geometry, not the board's origin, so pieces of different heights (a pawn vs a queen) each
    rest correctly on the surface rather than being centered through it or floating above it.
    """
    center_x = (v[:, 0].max() + v[:, 0].min()) / 2.0
    center_z = (v[:, 2].max() + v[:, 2].min()) / 2.0
    bottom_y = v[:, 1].min()
    offset = np.array([target_x - center_x, target_y - bottom_y, target_z - center_z])
    return v + offset


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--board", required=True, help="Cleaned board-only OBJ (from clean_scan.py).")
    ap.add_argument("--pawn", required=True)
    ap.add_argument("--rook", required=True)
    ap.add_argument("--knight", required=True)
    ap.add_argument("--bishop", required=True)
    ap.add_argument("--queen", required=True)
    ap.add_argument("--king", required=True)
    ap.add_argument("-o", "--output", help="Where to write the combined OBJ.")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report the computed board top/footprint and the layout, write nothing.")
    ap.add_argument("--border-fraction", type=float, default=0.08,
                    help="Fraction of the board's scanned width/depth to treat as a non-playable "
                         "border on each side, shrinking the 8x8 grid inward. Default 0.08. "
                         "Always check the result visually -- this is an approximation, not a "
                         "detected measurement.")
    args = ap.parse_args()

    if not args.dry_run and not args.output:
        ap.error("-o/--output is required unless --dry-run is given")

    piece_paths = {
        "pawn": args.pawn, "rook": args.rook, "knight": args.knight,
        "bishop": args.bishop, "queen": args.queen, "king": args.king,
    }

    print(f"\nreading board: {args.board}")
    board_ms = load(args.board)
    board_mesh = board_ms.current_mesh()
    board_v = board_mesh.vertex_matrix()
    board_f = board_mesh.face_matrix()
    top_y = board_top_y(board_v)
    min_x, max_x, min_z, max_z = board_footprint(board_v, args.border_fraction)
    print(f"  {len(board_v)} verts  {len(board_f)} faces")
    print(f"  board top surface  y = {top_y:.4f}")
    print(f"  play area  x [{min_x:.4f}, {max_x:.4f}]  z [{min_z:.4f}, {max_z:.4f}]  "
          f"(border {args.border_fraction:.0%} shrunk in from scanned extent)")

    print("\nreading piece types:")
    piece_v, piece_f = {}, {}
    for name, path in piece_paths.items():
        pms = load(path)
        pm = pms.current_mesh()
        piece_v[name] = pm.vertex_matrix()
        piece_f[name] = pm.face_matrix()
        height = float(piece_v[name][:, 1].max() - piece_v[name][:, 1].min())
        print(f"  {name:<8} {path}  {len(piece_v[name]):>6} verts  height {height * 100:.1f}cm")

    # Standard algebraic single-letter abbreviations -- N for knight specifically, since a
    # plain first-letter abbreviation collides King/Knight (both start with K).
    LETTER = {"pawn": "P", "rook": "R", "knight": "N", "bishop": "B", "queen": "Q", "king": "K"}
    print(f"\nstarting layout: {len(STARTING_LAYOUT)} occupied squares of 64")
    for row in range(7, -1, -1):
        line = [LETTER.get(STARTING_LAYOUT.get(f"{FILES[col]}{row + 1}"), ".") for col in range(8)]
        print("  " + " ".join(line))

    if args.dry_run:
        print("\n(dry run -- nothing written)\n")
        return

    ms = pymeshlab.MeshSet()
    ms.add_mesh(pymeshlab.Mesh(vertex_matrix=board_v, face_matrix=board_f), "board")
    named_ids = [("board", ms.current_mesh_id())]

    for square, piece_type in STARTING_LAYOUT.items():
        col = FILES.index(square[0])
        row = int(square[1]) - 1
        x, z = square_center(row, col, min_x, max_x, min_z, max_z)
        placed_v = place_piece(piece_v[piece_type], x, top_y, z)
        ms.add_mesh(pymeshlab.Mesh(vertex_matrix=placed_v, face_matrix=piece_f[piece_type]), square)
        named_ids.append((square, ms.current_mesh_id()))

    write_multi_part_obj(ms, named_ids, args.output)
    print(f"\nwrote {args.output}  ({len(named_ids)} parts: board + {len(named_ids) - 1} pieces)\n")


if __name__ == "__main__":
    main()

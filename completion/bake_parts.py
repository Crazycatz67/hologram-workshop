"""Bake named parts into a detailed scan so the platform shows real parts without having to
guess them at load time.

The part splitter (parts_proto.py / platform/parts.js) is right on chair_clean.obj (8 parts)
but is a heuristic: on other densities or smoothing it can merge or split differently. So
for a shipped asset, parts are computed ONCE on the mesh they are known-good on and
transferred onto the detailed version by nearest vertex (chair_detail is a subdivision of
chair_clean, so every detailed vertex sits on the source surface). Output: one GLB with one
named mesh per part, vertex colours kept -- the platform's loader treats each mesh as a part.

Names come from shape and position, not from a model of what a chair is: the part's long
axis (vertical -> "leg"/"post", horizontal -> "rail"/"runner"), thick bodies -> "cushion",
wide flat ones -> "panel"/"backrest", plus front/back/left/right from where it sits.

Usage:
    .venv/bin/python completion/bake_parts.py assets/chair/chair_clean.obj assets/chair/chair_detail.ply \\
        -o assets/chair/chair_detail.glb
"""
import argparse, sys
from pathlib import Path
import numpy as np
import pymeshlab, trimesh
from scipy.spatial import cKDTree
sys.path.insert(0, str(Path(__file__).resolve().parent))
import parts_proto

def describe(p, centre, size, kind):
    ext = p.max(0) - p.min(0)
    c = (p.max(0) + p.min(0)) / 2 - centre
    horiz = []
    if abs(c[2]) > 0.12 * size[2]: horiz.append('front' if c[2] > 0 else 'back')
    if abs(c[0]) > 0.12 * size[0]: horiz.append('left' if c[0] < 0 else 'right')
    where = ' '.join(horiz)
    tall, wide, deep = ext[1], ext[0], ext[2]
    if kind == 3 and tall < 0.5 * max(wide, deep):
        name = 'seat cushion' if c[1] < 0.25 * size[1] else 'cushion'
    elif max(wide, deep) > 2.0 * tall and min(wide, deep) < 0.35 * max(wide, deep):
        # touches the floor -> runner (a sled runner can rise at one end, so test its lowest
        # point, not its centre); otherwise a rail
        name = 'runner' if p[:, 1].min() - (centre[1] - size[1] / 2) < 0.05 * size[1] else 'rail'
    elif tall > 1.8 * max(wide, deep) or (tall > max(wide, deep) and min(wide, deep) < 0.1):
        name = 'leg' if c[1] < 0 and tall < 0.6 * size[1] else 'post'
    elif wide > 0.6 * size[0] and c[1] > 0.2 * size[1]:
        name = 'backrest'
    else:
        name = 'panel' if kind != 3 else 'body'
    return f"{name} · {where}" if where else name

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source'); ap.add_argument('detailed'); ap.add_argument('-o', required=True)
    a = ap.parse_args()
    ms = pymeshlab.MeshSet(); ms.load_new_mesh(a.source); m = ms.current_mesh()
    sv, sf = m.vertex_matrix().astype(float), m.face_matrix().astype(np.int64)
    reg, label = parts_proto.segment(sv, sf)
    ms.load_new_mesh(a.detailed); d = ms.current_mesh()
    dv, df = d.vertex_matrix().astype(float), d.face_matrix().astype(np.int64)
    dc = (d.vertex_color_matrix() * 255).astype(np.uint8) if d.has_vertex_color() else None
    dist, j = cKDTree(sv).query(dv)
    vlab = reg[j]
    fl = vlab[df]; flab = np.where(fl[:, 1] == fl[:, 2], fl[:, 1], fl[:, 0])
    centre = (dv.max(0) + dv.min(0)) / 2; size = dv.max(0) - dv.min(0)
    scene = trimesh.Scene(); names = {}
    for k in range(reg.max() + 1):
        faces = df[flab == k]
        if not len(faces): continue
        used, inv = np.unique(faces, return_inverse=True)
        kind = np.bincount(label[reg == k], minlength=4).argmax()
        name = describe(dv[used], centre, size, kind)
        n = names.get(name, 0) + 1; names[name] = n
        if n > 1: name = f"{name} {n}"
        mesh = trimesh.Trimesh(dv[used], inv.reshape(-1, 3), vertex_colors=dc[used] if dc is not None else None, process=False)
        scene.add_geometry(mesh, node_name=name, geom_name=name)
        ext = dv[used].max(0) - dv[used].min(0)
        print(f"  {name:<28} {len(faces):7d} faces  {ext[0]*100:5.1f} x {ext[1]*100:5.1f} x {ext[2]*100:5.1f} cm")
    print(f"max transfer distance {dist.max()*1000:.2f} mm")
    scene.export(a.o); print('wrote', a.o)

if __name__ == '__main__': main()

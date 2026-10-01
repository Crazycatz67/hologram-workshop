"""Build the sample objects in assets/samples/ from their licensed originals.

The originals (ABO / GSO / Poly Haven downloads) are big and are NEVER committed: the five
reused ones live in the git-ignored assets/benchmark/ (see its SOURCES.md), the Poly Haven
ones are fetched to a scratch folder with --fetch. Only the small GLBs this writes, this
script and SOURCES.md are meant to be committed.

Every output GLB follows one contract, so hologram.html and the Platform can load any of them
with no per-model code:
  - Y up, metres, resting on y = 0, centred on x = z = 0 (bounding box centre)
  - one named mesh per part (the loaders treat each mesh as a part: explode / select /
    part-move). Names follow bake_parts.py: a plain noun, optionally "noun · where"
    ("leg · front left"); duplicates get " 2", " 3"
  - base colour only (a ≤1024 px JPEG map or a flat colour): the hologram look only reads
    `map` / vertex colours, so normal and roughness maps would be dead weight
  - ≤ ~1.5 MB per file (checked at the end; a model over budget fails the run)

Parts come from the source when it has separate meshes (Poly Haven node names), otherwise
from connected components: tiny pieces (screws, caps) are folded into the nearest real part
so explode moves whole legs and tops, not 40 loose bolts.

Usage (each step well under 2 minutes):
    .venv/bin/python assets/samples/build_samples.py --fetch <scratch-dir>   # Poly Haven originals
    .venv/bin/python assets/samples/build_samples.py --src <scratch-dir>     # all GLBs
    .venv/bin/python assets/samples/build_samples.py --src <scratch-dir> --only vase
"""
import argparse, io, json, subprocess, sys
from pathlib import Path
import numpy as np
import trimesh
from PIL import Image
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets' / 'samples'
BENCH = ROOT / 'assets' / 'benchmark'
MAX_BYTES = 1_550_000
TEX_PX = 1024

# Poly Haven assets fetched with --fetch (CC0). Key = Poly Haven asset id.
POLYHAVEN = ['metal_tool_chest', 'painted_wooden_cabinet', 'ceramic_vase_01', 'Lantern_01', 'desk_lamp_arm_01']

# Part names for Poly Haven node names, by suffix after the asset prefix. Unlisted nodes keep
# their own suffix with '_' -> ' '.
NODE_NAMES = {
    'chest': 'chest', 'hinge_chest': 'hinge · back', 'lid': 'lid', 'handle_left': 'handle · left',
    'handle_right': 'handle · right', 'lock': 'lock · front', 'hinge_lid': 'hinge · lid',
    '': 'body', 'door_01': 'door · front left', 'door_02': 'door · front right',
    'drawer_01': 'drawer · front left', 'drawer_02': 'drawer · front right',
    'glass': 'glass',
}

def S(**kw): return kw

# id -> how to build it. `src` is resolved at run time; `parts` is 'nodes', 'components' or
# 'single'; `names` (components only) renames parts in order of size, largest first, after
# the automatic naming, when the automatic names would read wrong for this object.
SPECS = {
    'barrel-chair': S(src=lambda s: BENCH / 'abo_barrel_chair' / 'B07DBGWFGY.glb', parts='components', title='Barrel chair',
                         names=['backrest', 'seat cushion']),
    'bar-stool': S(src=lambda s: BENCH / 'abo_bar_stool' / 'B07B78M4DN.glb', parts='components', title='Bar stool',
                      rename={'top': 'seat', 'back': 'seat frame', 'post': 'leg', 'rail': 'stretcher'}),
    'pedestal-table': S(src=lambda s: BENCH / 'abo_pedestal_table' / 'B07Y5VWF19.glb', parts='components', title='Pedestal table', min_part=0.3,
                          rename={'top · front': 'apron · front', 'top · back': 'apron · back', 'body': 'pedestal',
                                  'post': 'pedestal', 'runner': 'foot'}),
    'teapot': S(src=lambda s: BENCH / 'gso_teapot' / 'meshes' / 'model.obj', parts='single', title='Teapot',
                rotate_x=-90, single_name='teapot',
                # The OBJ's .mtl points at texture.png beside it; GSO keeps it in materials/textures/.
                texture=BENCH / 'gso_teapot' / 'materials' / 'textures' / 'texture.png'),
    'sofa': S(src=lambda s: s / 'Sofa_01' / 'Sofa_01.gltf', parts='components', title='Sofa', min_part=0.08, join_iou=None,
                names=['frame', 'upholstery', 'seat cushion'], rename={'leg': 'foot'}),
    'tool-chest': S(src=lambda s: s / 'metal_tool_chest' / 'metal_tool_chest.gltf', parts='nodes', title='Tool chest'),
    'cabinet': S(src=lambda s: s / 'painted_wooden_cabinet' / 'painted_wooden_cabinet.gltf', parts='nodes', title='Cabinet'),
    'vase': S(src=lambda s: s / 'ceramic_vase_01' / 'ceramic_vase_01.gltf', parts='single', title='Vase', single_name='vase'),
    'lantern': S(src=lambda s: s / 'Lantern_01' / 'Lantern_01.gltf', parts='nodes', title='Lantern',
                   # The source glass is the brass map with an opacity mask; opaque, that reads as
                   # solid brass, so it gets a pale glass tint instead.
                   flat={'glass': [205, 225, 235, 255]}),
    'desk-lamp': S(src=lambda s: s / 'desk_lamp_arm_01' / 'desk_lamp_arm_01.gltf', parts='components', title='Desk lamp',
                     names=['shade', 'base + lower arm', 'bulb', 'elbow', 'upper arm', 'lower arm rod', 'elbow plate',
                            'spring', 'spring', 'lower arm rod']),
}

def fetch(dest):
    """Poly Haven 1k glTF + base-colour texture only (normal/ARM maps are never used)."""
    for a in POLYHAVEN + ['Sofa_01']:
        d = dest / a; (d / 'textures').mkdir(parents=True, exist_ok=True)
        files = json.loads(subprocess.run(['curl', '-sf', '-m', '30', f'https://api.polyhaven.com/files/{a}'],
                                          capture_output=True, check=True).stdout)
        g = files['gltf']['1k']['gltf']
        gl = json.loads(subprocess.run(['curl', '-sf', '-m', '30', g['url']], capture_output=True, check=True).stdout)
        keep = {im['uri'] for im in gl.get('images', []) if '_diff' in im['uri']}
        for k, v in g['include'].items():
            if k.endswith('.bin') or k in keep:
                subprocess.run(['curl', '-sf', '-m', '60', '-o', str(d / k), v['url']], check=True)
        # Drop the unused maps from the glTF so trimesh doesn't look for files we skipped.
        for m in gl.get('materials', []):
            for key in ('normalTexture', 'occlusionTexture'): m.pop(key, None)
            m.get('pbrMetallicRoughness', {}).pop('metallicRoughnessTexture', None)
        (d / f'{a}.gltf').write_text(json.dumps(gl))
        print('fetched', a)

def face_components(m):
    """Connected components by position (UV seams split vertices, so merge a copy first)."""
    c = m.copy(); c.merge_vertices(merge_tex=True, merge_norm=True)
    f = c.faces; n = len(c.vertices)
    e = np.vstack([f[:, [0, 1]], f[:, [1, 2]]])
    _, lab = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)), directed=False)
    return lab[f[:, 0]]

def group_components(m, min_part=0.12, join_iou=0.6, diag=None):
    """Face labels: components, with small ones folded into the nearest big one, and big
    ones that overlap almost entirely (an inner + outer shell of one upholstered back) joined."""
    lab = face_components(m)
    ids, cnt = np.unique(lab, return_counts=True)
    diag = diag or np.linalg.norm(m.extents)
    boxes = {}
    for i in ids:
        p = m.vertices[m.faces[lab == i].ravel()]
        boxes[i] = (p.min(0), p.max(0))
    big = [i for i, c in zip(ids, cnt) if np.linalg.norm(boxes[i][1] - boxes[i][0]) > min_part * diag and c >= 8]
    big.sort(key=lambda i: -cnt[ids == i][0])
    # Join near-duplicate shells into the larger one (bbox IoU).
    def iou(a, b):
        lo, hi = np.maximum(a[0], b[0]), np.minimum(a[1], b[1])
        inter = np.prod(np.clip(hi - lo, 0, None)); va, vb = np.prod(a[1] - a[0]), np.prod(b[1] - b[0])
        return inter / (va + vb - inter + 1e-12)
    keep = []
    for i in big:
        host = next((k for k in keep if join_iou and iou(boxes[i], boxes[k]) > join_iou), None)
        if host is None: keep.append(i)
        else: lab[lab == i] = host
    # Fold everything else into the nearest kept part (by vertex distance).
    pts, owner = [], []
    for k in keep:
        v = np.unique(m.faces[lab == k].ravel()); pts.append(m.vertices[v]); owner.append(np.full(len(v), k))
    tree, owner = cKDTree(np.vstack(pts)), np.concatenate(owner)
    for i in ids:
        if i in keep or not np.any(lab == i): continue
        fi = lab == i
        _, j = tree.query(m.vertices[m.faces[fi].ravel()])
        lab[fi] = np.bincount(owner[j]).argmax()
    return lab

def describe(p, centre, size):
    """Name from shape + position, the same vocabulary as completion/bake_parts.py."""
    ext = p.max(0) - p.min(0); c = (p.max(0) + p.min(0)) / 2 - centre
    horiz = []
    if abs(c[2]) > 0.12 * size[2]: horiz.append('front' if c[2] > 0 else 'back')
    if abs(c[0]) > 0.12 * size[0]: horiz.append('left' if c[0] < 0 else 'right')
    tall, wide, deep = ext[1], ext[0], ext[2]
    if max(wide, deep) > 0.7 * max(size[0], size[2]) and tall < 0.25 * size[1] and c[1] > 0.3 * size[1]:
        name = 'top'
    elif max(wide, deep) > 2.0 * tall and min(wide, deep) < 0.35 * max(wide, deep):
        name = 'runner' if p[:, 1].min() - (centre[1] - size[1] / 2) < 0.05 * size[1] else 'rail'
    elif tall > 1.8 * max(wide, deep) or (tall > max(wide, deep) and min(wide, deep) < 0.1):
        name = 'leg' if c[1] < 0 and tall < 0.6 * size[1] else 'post'
    elif min(ext) > 0.25 * max(ext) and c[1] < 0.15 * size[1] and wide > 0.5 * size[0]:
        name = 'seat'
    elif wide > 0.6 * size[0] and c[1] > 0.1 * size[1]:
        name = 'back'
    elif c[1] < -0.3 * size[1] and ext[1] < 0.3 * size[1]:
        name = 'foot'
    else:
        name = 'body'
    where = ' '.join(horiz)
    return f'{name} · {where}' if where else name

def base_colour(mesh):
    """(PIL image or None, rgba factor) from whatever material the loader produced."""
    v = mesh.visual
    mat = getattr(v, 'material', None)
    if mat is None: return None, np.array([200, 200, 200, 255], np.uint8)
    if isinstance(mat, trimesh.visual.material.SimpleMaterial):
        mat = mat.to_pbr()
    img = getattr(mat, 'baseColorTexture', None)
    fac = getattr(mat, 'baseColorFactor', None)
    fac = np.array([255, 255, 255, 255] if fac is None else fac, np.uint8)
    return img, fac

def shrink(img):
    img = img.convert('RGB')
    if max(img.size) > TEX_PX: img = img.resize((TEX_PX, TEX_PX * img.size[1] // img.size[0]), Image.LANCZOS)
    buf = io.BytesIO(); img.save(buf, 'JPEG', quality=85); buf.seek(0)
    return Image.open(buf)

def to_part(mesh, cache, flat=None):
    """Copy of `mesh` with a lean PBR material (shared per source image, so the GLB stores
    each texture once)."""
    img, fac = base_colour(mesh)
    if flat is not None: img, fac = None, np.array(flat, np.uint8)
    uv = getattr(mesh.visual, 'uv', None)
    if img is not None and uv is not None and len(uv) == len(mesh.vertices):
        key = id(img)
        if key not in cache: cache[key] = trimesh.visual.material.PBRMaterial(
            baseColorTexture=shrink(img), baseColorFactor=fac, metallicFactor=0.0, roughnessFactor=0.8)
        vis = trimesh.visual.TextureVisuals(uv=uv, material=cache[key])
    else:
        key = ('flat',) + tuple(fac)
        if key not in cache: cache[key] = trimesh.visual.material.PBRMaterial(baseColorFactor=fac, metallicFactor=0.0, roughnessFactor=0.8)
        vis = trimesh.visual.TextureVisuals(material=cache[key])
    return trimesh.Trimesh(mesh.vertices.copy(), mesh.faces.copy(), visual=vis, process=False)

def load_parts(spec, src):
    """[(name, Trimesh)] in source units/frame, before normalising."""
    path = spec['src'](src)
    if not path.exists(): raise SystemExit(f'missing source {path} (run --fetch, see SOURCES.md)')
    scene = trimesh.load(path, force='scene')
    if spec['parts'] == 'nodes':
        out = []
        for node in scene.graph.nodes_geometry:
            T, g = scene.graph[node]
            m = scene.geometry[g].copy(); m.apply_transform(T)
            prefix = path.stem
            suffix = node[len(prefix):].lstrip('_') if node.startswith(prefix) else node
            out.append((NODE_NAMES.get(suffix, suffix.replace('_', ' ') or 'body'), m))
        return out
    meshes = []
    for node in scene.graph.nodes_geometry:
        T, g = scene.graph[node]
        m = scene.geometry[g].copy(); m.apply_transform(T); meshes.append(m)
    if spec.get('texture'):
        for m in meshes:
            m.visual = trimesh.visual.TextureVisuals(uv=m.visual.uv, material=trimesh.visual.material.PBRMaterial(
                baseColorTexture=Image.open(spec['texture'])))
    if spec['parts'] == 'single' and len(meshes) != 1: raise SystemExit(f'{path}: expected one mesh, got {len(meshes)}')
    return [(spec.get('single_name', 'body'), m) for m in meshes]

def normalise(parts, spec):
    R = np.eye(4)
    if spec.get('rotate_x'): R = trimesh.transformations.rotation_matrix(np.radians(spec['rotate_x']), [1, 0, 0])
    for _, m in parts: m.apply_transform(R)
    allv = np.vstack([m.vertices for _, m in parts])
    lo, hi = allv.min(0), allv.max(0)
    t = np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    for _, m in parts: m.apply_translation(t)
    return hi - lo

def build(key, spec, src):
    parts = load_parts(spec, src)
    size = normalise(parts, spec)
    if spec['parts'] == 'components':
        centre = np.array([0, size[1] / 2, 0])
        found = []
        # Per source mesh (one per material), so each part keeps a single texture.
        for _, m in parts:
            lab = group_components(m, spec.get('min_part', 0.12), spec.get('join_iou', 0.6), np.linalg.norm(size))
            for k in np.unique(lab):
                sub = m.submesh([np.nonzero(lab == k)[0]], append=True)
                found.append((describe(sub.vertices, centre, size), sub))
        found.sort(key=lambda x: -len(x[1].faces))
        # Swap the generic noun for what this object calls it (stool 'top' -> 'seat').
        ren = spec.get('rename', {})
        # A full auto name ('top · front') can be renamed too, before the noun-only rule.
        found = [(ren[n] if n in ren else ' · '.join([ren.get(n.split(' · ')[0], n.split(' · ')[0])] + n.split(' · ')[1:]), m)
                 for n, m in found]
        for i, n in enumerate(spec.get('names', [])):
            if i < len(found): found[i] = (n, found[i][1])
        parts = found
    scene, cache, seen = trimesh.Scene(), {}, {}
    rows = []
    for name, m in parts:
        n = seen.get(name, 0) + 1; seen[name] = n
        if n > 1: name = f'{name} {n}'
        scene.add_geometry(to_part(m, cache, spec.get('flat', {}).get(name)), node_name=name, geom_name=name)
        rows.append(f'{name} ({len(m.faces)})')
    out = OUT / f'{key}.glb'
    out.write_bytes(scene.export(file_type='glb'))
    nb = out.stat().st_size
    faces = sum(len(m.faces) for _, m in parts)
    print(f'{key:<15} {nb/1e6:5.2f} MB  {faces:6d} faces  {size[0]:.2f} x {size[1]:.2f} x {size[2]:.2f} m  '
          f'{len(parts)} parts: {", ".join(rows)}')
    return nb <= MAX_BYTES

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--fetch', type=Path, help='download the Poly Haven originals into this folder')
    ap.add_argument('--src', type=Path, help='folder --fetch wrote to')
    ap.add_argument('--only', help='one id from SPECS')
    a = ap.parse_args()
    if a.fetch: fetch(a.fetch); return
    if not a.src: ap.error('--src is required (or --fetch first)')
    ok = True
    for key, spec in SPECS.items():
        if a.only and key != a.only: continue
        ok &= build(key, spec, a.src)
    if not ok: sys.exit('a model is over the size budget')

if __name__ == '__main__': main()

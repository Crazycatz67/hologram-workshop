"""Prototype of the part splitter (platform/parts.js is the shipping JS port).
Run: .venv/bin/python completion/parts_proto.py assets/chair/chair_clean.obj [--radius 0.035]
Writes completion/out/parts.ply (vertex colour per part) for viewing in the platform."""
import argparse, sys
from pathlib import Path
import numpy as np
from scipy.spatial import cKDTree
sys.path.insert(0, str(Path(__file__).parent))
import fill

def neighbours(f, n):
    e = np.concatenate([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    return e

def descriptors(v, radius):
    tree = cKDTree(v)
    lin = np.zeros(len(v)); pla = np.zeros(len(v)); sca = np.zeros(len(v))
    axis = np.zeros((len(v), 3)); normal = np.zeros((len(v), 3))
    for i, nb in enumerate(tree.query_ball_point(v, radius)):
        p = v[nb]
        if len(p) < 6:
            sca[i] = 1; continue
        c = np.cov((p - p.mean(0)).T)
        w, e = np.linalg.eigh(c)            # ascending
        l3, l2, l1 = np.maximum(w, 1e-12)
        lin[i] = (l1 - l2) / l1; pla[i] = (l2 - l3) / l1; sca[i] = l3 / l1
        axis[i] = e[:, 2]; normal[i] = e[:, 0]
    return lin, pla, sca, axis, normal

class DSU:
    def __init__(s, n): s.p = np.arange(n)
    def find(s, a):
        r = a
        while s.p[r] != r: r = s.p[r]
        while s.p[a] != r: s.p[a], a = r, s.p[a]
        return r
    def union(s, a, b):
        a, b = s.find(a), s.find(b)
        if a != b: s.p[b] = a

def vertex_normals(v, f):
    _, fn, area = fill.face_geometry(v, f)
    n = np.zeros_like(v)
    for k in range(3): np.add.at(n, f[:, k], fn * area[:, None])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)

def thickness(v, f, max_t=0.20, step=0.004, hit=0.004):
    """Distance through the object at each vertex: probe inward along -normal until a
    surface sample facing the other way is reached (a poor man's shape diameter)."""
    vn = vertex_normals(v, f)
    pts = fill.sample_surface(v, f, 300_000, np.random.default_rng(0))
    tree = cKDTree(pts)
    # normals of samples: nearest vertex normal is good enough
    _, nv = cKDTree(v).query(pts); pn = vn[nv]
    t = np.full(len(v), np.nan)
    todo = np.arange(len(v))
    for d in np.arange(3 * step, max_t, step):
        if len(todo) == 0: break
        q = v[todo] - vn[todo] * d
        dist, idx = tree.query(q, distance_upper_bound=hit)
        ok = np.isfinite(dist)
        ok[ok] &= np.sum(pn[idx[ok]] * vn[todo[ok]], 1) < -0.2
        t[todo[ok]] = d
        todo = todo[~ok]
    return t, vn

def otsu(x):
    x = x[np.isfinite(x)]; h, e = np.histogram(x, 64); c = (e[:-1] + e[1:]) / 2
    w0 = np.cumsum(h); w1 = w0[-1] - w0; m0 = np.cumsum(h * c); mt = m0[-1]
    with np.errstate(divide='ignore', invalid='ignore'):
        between = (mt * w0 / w0[-1] - m0) ** 2 / (w0 * w1)
    return c[np.nanargmax(between)]

def segment(v, f, radius=0.035, angle=25, min_share=0.01):
    t, _ = thickness(v, f)
    logt = np.log(np.where(np.isfinite(t), t, 0.2))
    # Median over a 5 cm neighbourhood: single probes scatter on soft/curved panels, and a
    # panel whose readings straddle the cut-off otherwise shatters into patches.
    nbrs = cKDTree(v).query_ball_point(v, 0.05)
    logt = np.array([np.median(logt[n]) for n in nbrs])
    thr = np.exp(otsu(logt))
    thick = logt > np.log(thr)
    print(f"  thickness: median {np.nanmedian(t)*100:.1f} cm, split at {thr*100:.1f} cm -> {thick.mean():.0%} thick")
    lin, pla, sca, axis, normal = descriptors(v, radius)
    label = np.where(lin >= np.maximum(pla, sca), 0, np.where(pla >= sca, 1, 2))  # 0 tube,1 slab,2 joint
    label[thick] = 3                                                               # 3 thick body
    dirv = np.where(label[:, None] == 0, axis, normal)
    cosmax = np.cos(np.radians(angle))
    edges = neighbours(f, len(v))
    a, b = edges[:, 0], edges[:, 1]
    adj = [[] for _ in range(len(v))]
    for x, y in edges: adj[x].append(y); adj[y].append(x)
    # Seeded growth against the REGION's mean direction (not neighbour-to-neighbour), so a
    # bent tube stops growing where it has turned > angle from where it started: a sled
    # chair's continuous frame becomes leg / runner / post instead of one loop.
    strength = np.where(label == 0, lin, pla)
    reg = np.full(len(v), -1)
    order = np.argsort(-strength)
    from collections import deque
    rid = 0
    for s in order:
        if reg[s] != -1 or label[s] == 2: continue
        reg[s] = rid; acc = dirv[s].copy(); q = deque([s])
        while q:
            i = q.popleft()
            mean = acc / np.linalg.norm(acc)
            for j in adj[i]:
                if reg[j] != -1 or label[j] != label[s]: continue
                dj = dirv[j]
                dp = float(dj @ mean)
                # Tubes: compare with the region's mean axis, so a bent tube splits at the bend
                # (leg vs runner). Panels: compare with the neighbour, so a smoothly curved
                # panel (a backrest) stays one part. Thick bodies grow freely.
                if label[s] == 0 and abs(dp) < cosmax: continue
                if label[s] == 1 and abs(float(dj @ dirv[i])) < cosmax: continue
                reg[j] = rid; acc += dj if dp > 0 else -dj; q.append(j)
        rid += 1
    for _ in range(200):
        un = np.flatnonzero(reg == -1)
        if len(un) == 0: break
        new = reg.copy()
        for i in un:
            cand = [reg[j] for j in adj[i] if reg[j] != -1]
            if cand:
                vals, cnt = np.unique(cand, return_counts=True); new[i] = vals[np.argmax(cnt)]
        if (new == reg).all(): break
        reg = new
    # merge small regions by area into the neighbour they share most edges with
    _, _, area = fill.face_geometry(v, f)
    varea = np.zeros(len(v)); np.add.at(varea, f.ravel(), np.repeat(area / 3, 3))
    total = varea.sum()
    while True:
        ids, inv = np.unique(reg, return_inverse=True)
        share = np.bincount(inv, weights=varea) / total
        small = ids[share < min_share]
        if len(small) == 0: break
        s = small[np.argmin(share[np.searchsorted(ids, small)])]
        m = (reg[a] == s) ^ (reg[b] == s)
        other = np.where(reg[a[m]] == s, reg[b[m]], reg[a[m]])
        if len(other) == 0: reg[reg == s] = -2; continue
        vals, cnt = np.unique(other, return_counts=True)
        reg[reg == s] = vals[np.argmax(cnt)]
    def absorb_islands(reg):
        return _absorb_islands(reg, a, b)
    reg = absorb_islands(reg)
    # Merge neighbouring NON-tube regions when their union is still one flat panel: its
    # thinnest extent is small relative to its middle one (lam3/lam2 of the union's point
    # spread). Backrest patches pass; seat + backrest (an L shape) does not; tubes are
    # never merged here, so legs stay separate.
    def kind(r):
        return np.bincount(label[reg == r], minlength=4).argmax()
    for _ in range(100):
        cross = reg[a] != reg[b]
        pairs, cnt = np.unique(np.sort(np.stack([reg[a][cross], reg[b][cross]], 1), axis=1), axis=0, return_counts=True)
        done = False
        for (r1, r2), c in sorted(zip(map(tuple, pairs), cnt), key=lambda x: -x[1]):
            if kind(r1) == 0 or kind(r2) == 0: continue
            p = v[(reg == r1) | (reg == r2)]
            w = np.linalg.eigvalsh(np.cov((p - p.mean(0)).T))
            if w[0] / max(w[1], 1e-12) < 0.06:
                reg[reg == r2] = r1; done = True; break
        if not done: break
    reg = absorb_islands(reg)
    ids, reg = np.unique(reg, return_inverse=True)
    return reg, label


def _absorb_islands(reg, a, b, share=0.70):
    """A region whose border is >= 70% shared with ONE neighbour is a patch of that
    neighbour (a cushion split at the thin/thick threshold, a lump misread as a tube).
    A leg touches the seat and the runner at two separate ends, so it never qualifies."""
    reg = reg.copy()
    for _ in range(100):
        cross = reg[a] != reg[b]
        pa, pb = reg[a][cross], reg[b][cross]
        pairs = np.concatenate([np.stack([pa, pb], 1), np.stack([pb, pa], 1)])
        keys, cnt = np.unique(pairs, axis=0, return_counts=True)
        border = {}
        for (r1, _), c in zip(keys, cnt): border[r1] = border.get(r1, 0) + c
        best = {}
        for (r1, r2), c in zip(keys, cnt):
            if c > best.get(r1, (0, None))[0]: best[r1] = (c, r2)
        cand = [(c / border[r1], r1, r2) for r1, (c, r2) in best.items() if c / border[r1] >= share]
        if not cand: break
        _, r1, r2 = max(cand)
        reg[reg == r1] = r2
    return reg

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('mesh'); ap.add_argument('--radius', type=float, default=0.035)
    ap.add_argument('--angle', type=float, default=25); ap.add_argument('--min-share', type=float, default=0.01)
    ap.add_argument('-o', default='completion/out/parts.ply'); args = ap.parse_args()
    import pymeshlab, time
    ms = pymeshlab.MeshSet(); ms.load_new_mesh(args.mesh); m = ms.current_mesh()
    v, f = m.vertex_matrix().astype(float), m.face_matrix().astype(np.int64)
    t = time.time(); reg, label = segment(v, f, args.radius, args.angle, args.min_share)
    print(f"{len(v)} verts -> {reg.max()+1} parts in {time.time()-t:.1f}s  (tube {np.mean(label==0):.0%} slab {np.mean(label==1):.0%} joint {np.mean(label==2):.0%} body {np.mean(label==3):.0%})")
    rng = np.random.default_rng(3); pal = (rng.random((reg.max()+1, 3)) * 200 + 55).astype(np.uint8)
    for k in range(reg.max()+1):
        p = v[reg == k]; ext = p.max(0) - p.min(0)
        print(f"  part {k:2d}: {len(p):6d} verts  bbox {ext[0]*100:5.1f} x {ext[1]*100:5.1f} x {ext[2]*100:5.1f} cm  kind {['tube','slab','joint','body'][np.bincount(label[reg==k], minlength=4).argmax()]}")
    out = Path(args.o); out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, 'w') as fh:
        fh.write(f"ply\nformat ascii 1.0\nelement vertex {len(v)}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face {len(f)}\nproperty list uchar int vertex_indices\nend_header\n")
        for (x, y, z), c in zip(v, pal[reg]): fh.write(f"{x:.5f} {y:.5f} {z:.5f} {c[0]} {c[1]} {c[2]}\n")
        for a_, b_, c_ in f: fh.write(f"3 {a_} {b_} {c_}\n")
    print('wrote', out)

if __name__ == '__main__': main()

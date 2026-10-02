"""Build the playful demo holograms (Hands v2 Phase 5) in assets/samples/, procedurally.

Nothing is downloaded: every shape is made here from lathes, sweeps, boxes and convex hulls,
so the models are ours (CC0). Same output contract as build_samples.py:
  - Y up, metres, resting on y = 0, centred on x = z = 0 (bounding box centre)
  - one named mesh per part, vertices baked (no node transforms); names "noun · where"
  - base colour only. Colour is stored as VERTEX colours, not a flat material colour: the
    hologram look (hologram.js / platform/look.js) only reads `map` or vertex colours, so a
    flat baseColorFactor would show as plain hologram blue.
  - ≤ ~1.5 MB per file (a model over budget fails the run)

Explode in manipulator.js pushes every part the SAME distance (0.6) along the unit vector
from the average of the part centres to its own centre. Parts that sit on one line on the
same side of that average move together and never separate, so the layouts below avoid it:
no fruit on the bowl's axis, gears fanned around the frame, building floors staggered
sideways. `explode_check()` replays that rule and prints how many part pairs still overlap.

Models (id: parts)
  fruit-bowl        bowl + 8 fruit + 'apple · inside' (flesh, core and seeds inside the red
                    apple, for slicing it open with the polygon lens later)
  gears             frame (base, back plate, axle pins) + 4 meshing gears, each centred on its
                    axle (even tooth counts, so the bounding-box centre IS the spin axis)
  layered-building  4 floors (slab + walls + windows each) + roof
  lowpoly-fox       one faceted mesh (unshared vertices, flat normals), for the polygon lens

Usage:
    .venv/bin/python assets/samples/build_playful.py              # all four
    .venv/bin/python assets/samples/build_playful.py --only gears
"""
import argparse, sys
from pathlib import Path
import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_samples import OUT, MAX_BYTES, normalise  # noqa: E402  (shared contract + budget)

EXPLODE = 0.6   # manipulator.js MAX_EXPLODE_OFFSET (metres, model space)

# ---------------------------------------------------------------------------- helpers

def rgb(h, a=255):
    h = h.lstrip('#'); return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)] + [a], float)

def mix(a, b, t):
    t = np.clip(np.asarray(t, float), 0, 1)[..., None]
    return a * (1 - t) + b * t

def mesh(v, f, col):
    """Trimesh with per-vertex RGBA colours (col: (4,) or (n,4))."""
    m = trimesh.Trimesh(np.asarray(v, float), np.asarray(f, np.int64), process=False)
    c = np.broadcast_to(np.asarray(col, float), (len(m.vertices), 4))
    m.visual = trimesh.visual.ColorVisuals(m, vertex_colors=np.clip(c, 0, 255).astype(np.uint8))
    return m

def faceted(m, face_col):
    """Unshare vertices so every triangle has its own flat normal and colour."""
    v = m.vertices[m.faces].reshape(-1, 3)
    f = np.arange(len(v)).reshape(-1, 3)
    return mesh(v, f, np.repeat(np.asarray(face_col, float), 3, axis=0))

def orient(m):
    """Outward winding for a closed, consistently wound mesh (trimesh's fix_normals needs
    networkx, which the venv doesn't have): flip every face if the signed volume is negative."""
    t = m.vertices[m.faces]
    if np.einsum('ij,ij->i', t[:, 0], np.cross(t[:, 1], t[:, 2])).sum() < 0: m.faces = m.faces[:, ::-1]
    return m

def join(ms):
    return trimesh.util.concatenate(ms)

def catmull(pts, n):
    """Smooth open curve through pts (k,d), n samples, ends kept."""
    p = np.asarray(pts, float); p = np.vstack([p[:1], p, p[-1:]])
    segs = len(p) - 3; out = []
    for t in np.linspace(0, segs, n):
        i = min(int(t), segs - 1); u = t - i
        a, b, c, d = p[i:i + 4]
        out.append(0.5 * ((2 * b) + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (-a + 3 * b - 3 * c + d) * u ** 3))
    return np.array(out)

def lathe(profile, segs, colour):
    """Surface of revolution about +Y. profile: (k,2) of (r, y) from bottom to top; an end
    with r == 0 becomes a single pole vertex (closed), otherwise the end stays open.
    colour(y_frac, theta, r) -> (n,4) RGBA. Seamless (no duplicated seam vertices)."""
    prof = np.asarray(profile, float)
    th = np.linspace(0, 2 * np.pi, segs, endpoint=False)
    verts, rings = [], []
    for r, y in prof:
        if r <= 1e-9:
            rings.append([len(verts)]); verts.append((0, y, 0, 0, r))
        else:
            rings.append(list(range(len(verts), len(verts) + segs)))
            verts += [(r * np.cos(t), y, r * np.sin(t), t, r) for t in th]
    faces = []
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1: continue
        for i in range(segs):
            j = (i + 1) % segs
            if len(a) == 1: faces.append((a[0], b[j], b[i]))
            elif len(b) == 1: faces.append((a[i], a[j], b[0]))
            else: faces += [(a[i], a[j], b[j]), (a[i], b[j], b[i])]
    V = np.array(verts)
    y0, y1 = prof[:, 1].min(), prof[:, 1].max()
    col = colour((V[:, 1] - y0) / max(y1 - y0, 1e-9), V[:, 3], V[:, 4])
    m = mesh(V[:, :3], faces, col)
    orient(m)   # outward winding whatever the profile direction
    return m

def tube(path, radius, sides, colour, cap=True):
    """Sweep a polygon of `sides` along path (k,3); radius (k,) per sample. colour(s, k_side)."""
    path = np.asarray(path, float); radius = np.broadcast_to(np.asarray(radius, float), (len(path),))
    T = np.gradient(path, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    up = np.array([0, 1, 0.]) if abs(T[0, 1]) < 0.9 else np.array([1, 0, 0.])
    N = np.cross(up, T[0]); N /= np.linalg.norm(N)
    verts, cols, ang = [], [], np.linspace(0, 2 * np.pi, sides, endpoint=False)
    s = np.linspace(0, 1, len(path))
    for k, (p, t) in enumerate(zip(path, T)):
        N = N - t * (N @ t); N /= np.linalg.norm(N); B = np.cross(t, N)   # parallel transport
        for j, a in enumerate(ang):
            verts.append(p + radius[k] * (np.cos(a) * N + np.sin(a) * B)); cols.append(colour(s[k], j))
    faces = []
    for k in range(len(path) - 1):
        for j in range(sides):
            a, b = k * sides + j, k * sides + (j + 1) % sides
            faces += [(a, b, b + sides), (a, b + sides, a + sides)]
    if cap:
        for k, end in ((0, 0), (len(path) - 1, 1)):
            c = len(verts); verts.append(path[k]); cols.append(colour(s[k], 0))
            for j in range(sides):
                a, b = k * sides + j, k * sides + (j + 1) % sides
                faces.append((c, b, a) if end == 0 else (c, a, b))
    m = mesh(verts, faces, np.array(cols))
    orient(m)
    return m

def sphere(c, r, col, sub=2):
    m = trimesh.creation.icosphere(subdivisions=sub, radius=r); m.apply_translation(c)
    return mesh(m.vertices, m.faces, col)

def box(lo, hi, col):
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    m = trimesh.creation.box(extents=hi - lo); m.apply_translation((lo + hi) / 2)
    return faceted(m, np.tile(np.asarray(col, float), (len(m.faces), 1)))

def noise(*xs):
    """Cheap deterministic 0..1 value noise from a few sines (no extra dependency)."""
    s = 0
    for k, x in enumerate(xs): s = s + np.sin(np.asarray(x) * (12.9898 + 7.1 * k) + 3.7 * k)
    return 0.5 + 0.5 * np.sin(s * 43.758)

def place(m, R=np.eye(3), t=(0, 0, 0)):
    """Bake a rotation + translation into the vertices (parts stay untransformed nodes)."""
    m = m.copy(); m.vertices = m.vertices @ np.asarray(R).T + np.asarray(t, float)
    return m

def rot(axis, deg):
    return trimesh.transformations.rotation_matrix(np.radians(deg), axis)[:3, :3]

# ---------------------------------------------------------------------------- fruit bowl

BOWL_C, BOWL_R = np.array([0, 0.17, 0.]), 0.16   # inner surface = sphere; rim at y = 0.09

def resting(r_fruit, polar, azim, lift=0.0):
    """Centre of a ball of radius r_fruit touching the bowl's inner sphere."""
    p, a = np.radians(polar), np.radians(azim)
    d = np.array([np.sin(p) * np.cos(a), -np.cos(p), np.sin(p) * np.sin(a)])
    return BOWL_C + (BOWL_R - r_fruit) * d + [0, lift, 0]

def bowl():
    # Profile from the outer foot up to the rim, then back down the inside to the centre.
    outer = [(0, 0.0), (0.065, 0.0), (0.07, 0.012)]   # solid foot: the inner bottom (y = 0.01) must stay inside
    ang = np.linspace(np.radians(64), np.radians(30), 9)          # outer wall, sphere R+0.008
    outer += [((BOWL_R + 0.008) * np.cos(a), BOWL_C[1] - (BOWL_R + 0.008) * np.sin(a)) for a in ang]
    rim_r = np.sqrt(BOWL_R ** 2 - (BOWL_C[1] - 0.09) ** 2)
    outer += [(rim_r + 0.008, 0.094), (rim_r + 0.002, 0.098), (rim_r - 0.002, 0.094)]
    inner_a = np.linspace(np.arcsin((BOWL_C[1] - 0.09) / BOWL_R), np.pi / 2, 12)
    inner = [(BOWL_R * np.cos(a), BOWL_C[1] - BOWL_R * np.sin(a)) for a in inner_a]
    inner[-1] = (0, BOWL_C[1] - BOWL_R)
    prof = outer + inner
    out_c, in_c, rim_c = rgb('#2f6fb3'), rgb('#f4ead8'), rgb('#e9c46a')
    n_out = len(outer)
    # Outside glazed blue, inside cream, gold rim. Coloured per profile ring afterwards: the
    # lathe callback only sees y/theta/r, which can't tell inside from outside at one height.
    m = lathe(prof, 48, lambda yf, th, r: np.tile(out_c, (len(yf), 1)))
    ring_of = np.repeat(np.arange(len(prof)), [1 if p[0] <= 1e-9 else 48 for p in prof])
    c = np.where((ring_of < n_out - 3)[:, None], out_c, in_c)
    c[(ring_of >= n_out - 3) & (ring_of < n_out)] = rim_c
    c = mix(c, c * 0.85, noise(m.vertices[:, 0] * 40, m.vertices[:, 2] * 40) * 0.4)
    m.visual = trimesh.visual.ColorVisuals(m, vertex_colors=np.clip(c, 0, 255).astype(np.uint8))
    return m

def stem(base, direction, length, r=0.0022, colour='#6b4423'):
    d = np.asarray(direction, float); d /= np.linalg.norm(d)
    bend = np.cross(d, [0, 0, 1.]); bend = bend / (np.linalg.norm(bend) + 1e-9)
    path = [base + d * length * s + bend * 0.15 * length * s * s for s in np.linspace(0, 1, 5)]
    return tube(path, np.linspace(r, r * 0.8, 5), 6, lambda s, j: rgb(colour) * (0.9 + 0.1 * (j % 2)))

def leaf(base, direction, size, colour='#4c9a2a'):
    d = np.asarray(direction, float); d /= np.linalg.norm(d)
    m = trimesh.creation.icosphere(subdivisions=2, radius=1.0)
    m.vertices *= [size, size * 0.12, size * 0.42]
    m.vertices[:, 0] += size
    v = m.vertices
    c = mix(rgb(colour), rgb('#8cc63f'), (v[:, 1] > 0) * 0.5)
    lm = mesh(v, m.faces, c)
    a = np.arctan2(d[2], d[0])
    return place(lm, rot([0, 1, 0], -np.degrees(a)) @ rot([0, 0, 1], 25), base)

def apple_profile(r):
    pts = [(0, 0.12), (0.30, 0.04), (0.62, 0.10), (0.92, 0.32), (1.0, 0.55), (0.93, 0.80),
           (0.70, 0.97), (0.40, 1.0), (0.18, 0.90), (0, 0.84)]
    p = catmull(pts, 26) * [r, 2 * r * 0.92]
    p[0, 0] = 0; p[-1, 0] = 0
    return p

def apple(r, base, streak, seed):
    def col(yf, th, rr):
        n = noise(th * 3 + seed, yf * 5)
        c = mix(base, streak, 0.55 * n * (0.4 + 0.6 * yf))
        return mix(c, rgb('#c9b458'), np.clip((0.15 - yf) * 4, 0, 0.6))   # paler underneath
    return lathe(apple_profile(r), 32, col)

def apple_inside(r):
    """Flesh, core and seeds sitting just inside the red apple's skin (same frame)."""
    # Scaled about the apple's own mid-height so the flesh stays ~3 mm inside the skin.
    flesh = lathe(apple_profile(r * 0.90) + [0, r * 0.092], 28,
                  lambda yf, th, rr: mix(rgb('#f6eccb'), rgb('#efe0a8'), noise(th, yf * 3) * 0.5))
    core = lathe(catmull([(0, 0.25), (0.6, 0.35), (0.75, 0.58), (0.5, 0.74), (0, 0.78)], 14) * [r * 0.45, 2 * r * 0.92], 14,
                 lambda yf, th, rr: np.tile(rgb('#d9c48a'), (len(yf), 1)))
    seeds = []
    for k in range(5):
        a = 2 * np.pi * k / 5
        s = sphere([0, 0, 0], 1.0, rgb('#4a2a12'), sub=1)
        s.vertices *= [0.006, 0.010, 0.004]
        seeds.append(place(s, rot([0, 1, 0], -np.degrees(a)) @ rot([0, 0, 1], 20),
                           [r * 0.22 * np.cos(a), r * 1.0, r * 0.22 * np.sin(a)]))
    return join([flesh, core] + seeds)

def citrus(r, ax_ratio, base, dark, tip, seed):
    """Orange (ax_ratio ~0.95) or lemon (ax_ratio ~1.35, with nubs). Axis along +Y."""
    t = np.linspace(0, np.pi, 24)
    rr = r * np.sin(t)
    yy = r * ax_ratio * (1 - np.cos(t))
    if tip:   # lemon nubs: pull both poles out and pinch the ring next to them
        yy[0] -= r * 0.18; yy[-1] += r * 0.18
        rr[1] *= 0.7; rr[-2] *= 0.7
    prof = np.c_[rr, yy]
    def col(yf, th, r_):
        c = mix(base, dark, noise(th * 9 + seed, yf * 13) * 0.35)
        return mix(c, rgb('#7a8a2a'), (yf > 0.985) * 0.8)
    return lathe(prof, 30, col)

def pear(r):
    pts = [(0, 0.0), (0.55, 0.03), (0.92, 0.22), (0.96, 0.42), (0.70, 0.66), (0.48, 0.84),
           (0.38, 1.02), (0.22, 1.16), (0, 1.20)]
    p = catmull(pts, 28) * [r, 2 * r]
    p[0, 0] = 0; p[-1, 0] = 0
    def col(yf, th, rr):
        c = mix(rgb('#b5c43a'), rgb('#e0cf53'), noise(th * 4, yf * 6) * 0.6)
        return mix(c, rgb('#d9733a'), 0.45 * np.clip(np.cos(th - 0.5), 0, 1) * (1 - abs(yf - 0.35) * 2).clip(0, 1))
    return lathe(p, 30, col)

def peach(r):
    t = np.linspace(0, np.pi, 22)
    prof = np.c_[r * np.sin(t) * (1 + 0.05 * np.sin(t)), r * 0.95 * (1 - np.cos(t))]
    def col(yf, th, rr):
        blush = np.clip(np.cos(th - 2.0), 0, 1) * (0.3 + 0.7 * yf)
        return mix(rgb('#f2b25c'), rgb('#d9483b'), 0.85 * blush)
    m = lathe(prof, 30, col)
    # The crease: pinch the vertices near theta = 0 a little inwards.
    v = m.vertices; th = np.arctan2(v[:, 2], v[:, 0])
    k = np.exp(-(th / 0.18) ** 2) * 0.12
    v[:, 0] *= 1 - k; v[:, 2] *= 1 - k
    m.vertices = v
    return m

def banana(length=0.19, r=0.018):
    s = np.linspace(0, 1, 26)
    ang = (s - 0.5) * np.radians(80)
    R = length / np.radians(80)
    path = np.c_[R * np.sin(ang), R * (1 - np.cos(ang)), np.zeros_like(s)]
    rad = r * np.clip(np.sin(np.pi * s) ** 0.45, 0.18, 1)
    rad[-3:] = [r * 0.30, r * 0.28, r * 0.26]          # the stalk end stays thick-ish
    def col(sv, j):
        c = rgb('#f5d63d') * (0.92 + 0.08 * (j % 2))    # 5 ridges, alternate shade
        c = mix(c, rgb('#9bb83a'), np.clip((sv - 0.8) * 4, 0, 0.6))
        return mix(c, rgb('#4a3520'), float(sv < 0.04 or sv > 0.97))
    return tube(path, rad, 5, col)

def grapes(r=0.0115):
    rng = np.random.default_rng(7)
    parts, k = [], 0
    rows = [(5, 0.040), (5, 0.034), (4, 0.027), (3, 0.019), (2, 0.011), (1, 0.0)]
    for i, (n, rad) in enumerate(rows):
        for j in range(n):
            a = 2 * np.pi * (j / n) + i * 0.6
            c = [rad * np.cos(a), -i * r * 1.55, rad * np.sin(a)]
            shade = mix(rgb('#5b2a6e'), rgb('#8e4a9e'), rng.random() * 0.8)
            g = sphere(c, r * (0.95 + 0.1 * rng.random()), shade)
            g.vertices[:, 1] = c[1] + (g.vertices[:, 1] - c[1]) * 1.15   # slightly oval
            parts.append(g); k += 1
    parts.append(tube([[0, r * 0.5, 0], [0.004, r * 2.2, 0.002], [0.012, r * 3.0, 0.0]], 0.0022, 6,
                      lambda s, j: rgb('#6b5a2a')))
    return join(parts)

def fruit_bowl():
    P = {}
    P['bowl'] = bowl()
    ring = [  # (name, maker, rest radius = clearance from the bowl's inner sphere, polar°, azimuth°)
        ('apple · red', lambda: apple(0.040, rgb('#c8202b'), rgb('#f2c14e'), 1.3), 0.040, 46, 20),
        ('orange', lambda: citrus(0.042, 0.95, rgb('#f28c1b'), rgb('#e0700d'), False, 0.2), 0.042, 46, 82),
        ('apple · green', lambda: apple(0.038, rgb('#8cc63f'), rgb('#e8e05a'), 4.1), 0.038, 46, 145),
        ('peach', lambda: peach(0.037), 0.037, 46, 205),
        ('pear', lambda: pear(0.036), 0.045, 44, 265),
        ('lemon', lambda: citrus(0.030, 1.35, rgb('#f7e03c'), rgb('#e6c720'), True, 2.0), 0.041, 46, 322),
    ]
    tilt_of = {'apple · red': (8, 0), 'orange': (0, 0), 'apple · green': (-12, 30), 'peach': (10, 0),
               'pear': (-18, 0), 'lemon': (90, 30)}
    for name, make, r, polar, azim in ring:
        c = resting(r, polar, azim)
        m = make()
        h = m.vertices[:, 1].max() - m.vertices[:, 1].min()
        m.apply_translation([0, -h / 2, 0])             # lathe frame: centre at origin
        tx, ty = tilt_of[name]
        R = rot([0, 1, 0], ty) @ rot([0, 0, 1], tx)
        extras = []
        if name.startswith('apple'):
            extras.append(stem(np.array([0, h * 0.40, 0]), [0.15, 1, 0], 0.022))
            if name == 'apple · green': extras.append(leaf(np.array([0.002, h * 0.47, 0]), [1, 0, 0.4], 0.022))
        if name == 'pear': extras.append(stem(np.array([0, h / 2 - 0.002, 0]), [-0.3, 1, 0], 0.02))
        if name == 'orange': extras.append(leaf(np.array([0, h / 2 - 0.002, 0]), [-1, 0, 0.3], 0.018))
        if extras: m = join([m] + extras)
        P[name] = place(m, R, c)
        if name == 'apple · red':
            ins = apple_inside(0.040); ins.apply_translation([0, -h / 2, 0])
            P['apple · inside'] = place(ins, R, c)
    # Top layer: grapes spilling over one side, banana lying across the front.
    g = grapes()
    gc = resting(0.04, 52, 122, lift=0.072)
    P['grapes'] = place(g, rot([0, 1, 0], -20) @ rot([1, 0, 0], -55), gc)
    b = banana()
    bc = resting(0.03, 30, 240, lift=0.053)
    P['banana'] = place(b, rot([0, 1, 0], 135) @ rot([1, 0, 0], 25), bc)
    return list(P.items())

# ---------------------------------------------------------------------------- gears

GEAR_M = 0.005          # module (metres per tooth of pitch diameter)
GEAR_T = 0.012          # gear thickness
FACE_Z = 0.0            # gears' back face (the frame's back plate sits behind)

def gear_outline(N, phase):
    p = 2 * np.pi / N
    r = GEAR_M * N / 2; rt, rr = r + GEAR_M, r - 1.25 * GEAR_M
    pts = []
    for k in range(N):
        a = phase + k * p
        for da, rad in ((-0.5, rr), (-0.30, rr), (-0.15, rt), (0.15, rt), (0.30, rr)):
            pts.append((rad, a + da * p))
    return np.array(pts), r, rr

def gear(N, phase, rim, web):
    """Extruded spur gear in the XY plane, axis +Z from FACE_Z, centred on the origin."""
    out, r, rr = gear_outline(N, phase)
    ang = out[:, 1]
    hole = 0.006
    rings = [out[:, 0], np.full_like(ang, rr - 1.2 * GEAR_M), np.full_like(ang, rr - 1.2 * GEAR_M - 0.0005),
             np.full_like(ang, hole + 0.007), np.full_like(ang, hole)]
    cols = [rim, rim, web, web * 0.9, web * 0.8]
    M = len(ang); verts, vc, faces = [], [], []
    for z in (FACE_Z, FACE_Z + GEAR_T):
        for rad, c in zip(rings, cols):
            verts += list(np.c_[rad * np.cos(ang), rad * np.sin(ang), np.full(M, z)]); vc += [c] * M
    nr = len(rings)
    def idx(side, ring, i): return side * nr * M + ring * M + i % M
    for i in range(M):
        for k in range(nr - 1):                     # caps (front and back)
            a, b, c, d = idx(1, k, i), idx(1, k, i + 1), idx(1, k + 1, i + 1), idx(1, k + 1, i)
            faces += [(a, b, c), (a, c, d)]
            a, b, c, d = idx(0, k, i), idx(0, k, i + 1), idx(0, k + 1, i + 1), idx(0, k + 1, i)
            faces += [(a, c, b), (a, d, c)]
        for k in (0, nr - 1):                       # outer teeth wall, axle-hole wall
            a, b, c, d = idx(0, k, i), idx(0, k, i + 1), idx(1, k, i + 1), idx(1, k, i)
            faces += [(a, b, c), (a, c, d)]
    g = mesh(verts, faces, np.array(vc))
    orient(g)
    # Raised hub collar around the axle (same mesh): reads as "this spins about here".
    hub = lathe([(hole, 0), (hole + 0.008, 0), (hole + 0.008, 0.006), (hole, 0.006)], 24,
                lambda yf, th, rr_: np.tile(web * 0.75, (len(yf), 1)))
    hub = place(hub, rot([1, 0, 0], 90), [0, 0, FACE_Z + GEAR_T + 0.006])
    return join([g, hub]), r

def gears():
    # Each gear meshes with the previous one at angle `dir` (degrees) from it. Even tooth
    # counts keep each gear point-symmetric, so its bounding-box centre is exactly its axle.
    spec = [('gear · big', 36, None, '#d4a017', '#a87b0c'),
            ('gear · small', 12, 20, '#c0c6cc', '#8a9299'),
            ('gear · medium', 24, -50, '#c8743a', '#9a5326'),
            ('gear · top', 16, 125, '#4f9d8f', '#36756a')]
    centres, phases, radii, P = [], [], [], []
    for i, (name, N, d, rim, web) in enumerate(spec):
        r = GEAR_M * N / 2
        if i == 0:
            c, ph = np.array([-0.035, 0.16]), 0.0
        else:
            j = {1: 0, 2: 1, 3: 0}[i]                 # which gear it meshes with
            th = np.radians(d)
            c = centres[j] + (radii[j] + r + 0.0006) * np.array([np.cos(th), np.sin(th)])   # + backlash: straight flanks would clip
            pa = 2 * np.pi / spec[j][1]
            # Tooth of gear j pointing at th  <=>  gap of this gear pointing back at th + pi.
            k = np.round((th - phases[j]) / pa)
            ph_j_tooth = phases[j] + k * pa            # nearest tooth of j to the contact line
            # Pitch circles roll without slip: j's tooth offset from the contact line shows up
            # on this gear scaled by Nj/N (and mirrored, the tangents point opposite ways).
            ph = (th + np.pi) - np.pi / N + (th - ph_j_tooth) * (spec[j][1] / N)
        centres.append(c); phases.append(ph); radii.append(r)
        gm, _ = gear(N, ph, rgb(rim), rgb(web))
        P.append((name, place(gm, np.eye(3), [c[0], c[1], 0])))
    # Frame: base slab, upright back plate, one steel pin per gear.
    lo_x, hi_x = min(c[0] - r for c, r in zip(centres, radii)) - 0.02, max(c[0] + r for c, r in zip(centres, radii)) + 0.02
    top = max(c[1] + r for c, r in zip(centres, radii)) + 0.02
    wood, plate, steel = rgb('#7a4b2a'), rgb('#3a3f4b'), rgb('#d9dde2')
    fr = [box([lo_x - 0.01, 0, -0.06], [hi_x + 0.01, 0.02, 0.05], wood),
          box([lo_x, 0.02, -0.022], [hi_x, top, -0.01], plate)]
    for c in centres:
        pin = lathe([(0, -0.012), (0.0055, -0.012), (0.0055, GEAR_T + 0.014), (0.009, GEAR_T + 0.014),
                     (0.009, GEAR_T + 0.018), (0, GEAR_T + 0.018)], 18,
                    lambda yf, th, rr_: np.tile(steel, (len(yf), 1)))
        fr.append(place(pin, rot([1, 0, 0], 90), [c[0], c[1], 0]))
    return [('frame', join(fr))] + P

# ---------------------------------------------------------------------------- building

FLOOR_H, SLAB = 0.11, 0.012

def windows(x0, x1, z, y0, y1, n, face, glass, frame):
    """n windows on a wall at depth z (face = +1 front / -1 back), spanning x0..x1."""
    out, w = [], (x1 - x0) / n
    for k in range(n):
        a, b = x0 + w * (k + 0.18), x0 + w * (k + 0.82)
        out.append(box([a - 0.003, y0 - 0.003, z - 0.002 * (face < 0)], [b + 0.003, y1 + 0.003, z + 0.002 * (face > 0)], frame))
        out.append(box([a, y0, z - 0.003 * (face < 0)], [b, y1, z + 0.003 * (face > 0)], glass))
    return out

def floor_part(y, sx, sz, off, wall, accent, ground=False):
    """Slab + four walls + windows of one storey, footprint sx x sz centred at off (x, z)."""
    ox, oz = off; t = 0.008
    x0, x1, z0, z1 = ox - sx / 2, ox + sx / 2, oz - sz / 2, oz + sz / 2
    slab, glass, frame = rgb('#9aa0a6'), rgb('#3d6e9e'), accent
    ms = [box([x0 - 0.006, y, z0 - 0.006], [x1 + 0.006, y + SLAB, z1 + 0.006], slab)]
    yw0, yw1 = y + SLAB, y + FLOOR_H - 0.005
    # Own ceiling: the floors are staggered, so the next slab never covers all of this one;
    # the uncovered strip reads as a terrace instead of an open-topped box.
    ms.append(box([x0, yw1, z0], [x1, y + FLOOR_H, z1], rgb('#b8bcc2')))
    ms += [box([x0, yw0, z1 - t], [x1, yw1, z1], wall), box([x0, yw0, z0], [x1, yw1, z0 + t], wall),
           box([x0, yw0, z0], [x0 + t, yw1, z1], wall), box([x1 - t, yw0, z0], [x1, yw1, z1], wall)]
    wy0, wy1 = (yw0 + 0.012, yw1 - 0.01) if ground else (yw0 + 0.03, yw1 - 0.02)
    n = 3 if ground else 4
    ms += windows(x0 + 0.01, x1 - 0.01, z1, wy0, wy1, n, +1, glass, frame)
    ms += windows(x0 + 0.01, x1 - 0.01, z0, wy0, wy1, n, -1, glass, frame)
    # Side windows (on the x walls): rotate a front-style row about Y.
    for side, xw in ((+1, x1), (-1, x0)):
        row = windows(-sz / 2 + 0.01, sz / 2 - 0.01, 0, wy0, wy1, 2, +1, glass, frame)
        ms += [place(m, rot([0, 1, 0], -90 * side), [xw, 0, oz]) for m in row]
    if ground:   # entrance canopy
        ms.append(box([ox - 0.04, yw1 - 0.03, z1], [ox + 0.04, yw1 - 0.024, z1 + 0.03], accent))
    else:        # a balcony on the front
        ms.append(box([ox - 0.05, y, z1], [ox + 0.05, y + 0.008, z1 + 0.035], slab))
        ms.append(box([ox - 0.05, y + 0.008, z1 + 0.031], [ox + 0.05, y + 0.04, z1 + 0.035], accent))
    return join(ms)

def layered_building():
    # Floors step sideways (a "stacked boxes" block): besides looking like real modern
    # architecture, it gives each floor its own explode direction (see the module note).
    sx, sz = 0.30, 0.20
    offs = [(-0.05, 0.0), (0.06, 0.03), (-0.06, -0.01), (0.06, 0.03)]
    roof_off = (-0.03, 0.0)   # the roof cantilevers back the other way (own explode direction)
    walls = [(rgb('#55595f'), rgb('#e9c46a')), (rgb('#efe6d2'), rgb('#e76f51')),
             (rgb('#c96f4a'), rgb('#f4f1de')), (rgb('#efe6d2'), rgb('#2a9d8f'))]
    names = ['floor · ground', 'floor · 1st', 'floor · 2nd', 'floor · 3rd']
    P = []
    for i, (name, off, (w, a)) in enumerate(zip(names, offs, walls)):
        P.append((name, floor_part(i * FLOOR_H, sx, sz, off, w, a, ground=(i == 0))))
    y = 4 * FLOOR_H; ox, oz = roof_off
    x0, x1, z0, z1 = ox - sx / 2, ox + sx / 2, oz - sz / 2, oz + sz / 2
    grey, green, panel = rgb('#8d939a'), rgb('#6a994e'), rgb('#22334d')
    roof = [box([x0 - 0.008, y, z0 - 0.008], [x1 + 0.008, y + SLAB, z1 + 0.008], grey),
            box([x0 - 0.008, y + SLAB, z0 - 0.008], [x1 + 0.008, y + SLAB + 0.02, z0], grey),
            box([x0 - 0.008, y + SLAB, z1], [x1 + 0.008, y + SLAB + 0.02, z1 + 0.008], grey),
            box([x0 - 0.008, y + SLAB, z0], [x0, y + SLAB + 0.02, z1], grey),
            box([x1, y + SLAB, z0], [x1 + 0.008, y + SLAB + 0.02, z1], grey),
            box([x0 + 0.01, y + SLAB, z0 + 0.01], [ox - 0.01, y + SLAB + 0.006, z1 - 0.01], green),   # green roof
            box([ox + 0.03, y + SLAB, z0 + 0.02], [x1 - 0.02, y + SLAB + 0.05, oz], rgb('#d8d2c4'))]  # stair core
    for k in range(3):   # solar panels, tilted toward the front
        pz = oz + 0.01 + k * 0.025
        p = box([-0.035, -0.002, -0.009], [0.035, 0.002, 0.009], panel)
        roof.append(place(p, rot([1, 0, 0], 25), [ox + 0.075, y + SLAB + 0.02, pz]))
    P.append(('roof', join(roof)))
    return P

# ---------------------------------------------------------------------------- fox

def hull(points, rng, jitter):
    p = np.asarray(points, float)
    p = p + rng.normal(0, jitter, p.shape)
    return trimesh.convex.convex_hull(p)

def ellipsoid_pts(c, r, n_lat=4, n_lon=7, rng=None):
    pts = []
    for i in range(1, n_lat + 1):
        la = np.pi * i / (n_lat + 1) - np.pi / 2
        for j in range(n_lon):
            lo = 2 * np.pi * (j + 0.5 * (i % 2)) / n_lon
            pts.append([np.cos(la) * np.cos(lo), np.sin(la), np.cos(la) * np.sin(lo)])
    pts += [[0, 1, 0], [0, -1, 0]]
    return np.asarray(c) + np.asarray(pts) * r

def lowpoly_fox():
    """A sitting-up, standing fox made of overlapping jittered convex hulls, coloured per
    face (orange coat, white chest/muzzle/tail tip, black socks/ears/nose)."""
    rng = np.random.default_rng(11)
    orange, white, black, dark = rgb('#e8732c'), rgb('#f6efe6'), rgb('#2b2421'), rgb('#b5531c')
    pieces = []   # (mesh, colour rule)
    # Body (long axis = X; head at +X), neck, head, snout.
    pieces.append((hull(ellipsoid_pts([0, 0.25, 0], [0.20, 0.09, 0.085]), rng, 0.008), 'body'))
    pieces.append((hull(ellipsoid_pts([0.15, 0.30, 0], [0.09, 0.09, 0.075], 3, 6), rng, 0.006), 'chest'))
    pieces.append((hull(np.vstack([ellipsoid_pts([0.17, 0.33, 0], [0.05, 0.05, 0.05], 2, 5),
                                   ellipsoid_pts([0.24, 0.39, 0], [0.05, 0.05, 0.05], 2, 5)]), rng, 0.004), 'chest'))
    head = ellipsoid_pts([0.26, 0.41, 0], [0.075, 0.065, 0.07], 3, 6)
    snout = [[0.39, 0.385, 0], [0.385, 0.40, 0.012], [0.385, 0.40, -0.012], [0.33, 0.43, 0.03], [0.33, 0.43, -0.03],
             [0.32, 0.375, 0.03], [0.32, 0.375, -0.03]]
    pieces.append((hull(np.vstack([head, snout]), rng, 0.004), 'head'))
    for s in (1, -1):   # ears
        pieces.append((hull([[0.22, 0.45, 0.035 * s], [0.27, 0.45, 0.045 * s], [0.24, 0.45, 0.065 * s],
                             [0.235, 0.56, 0.055 * s], [0.245, 0.47, 0.05 * s]], rng, 0.002), 'ear'))
    pieces.append((hull([[0.395, 0.39, 0], [0.38, 0.40, 0.011], [0.38, 0.40, -0.011], [0.385, 0.375, 0],
                         [0.372, 0.39, 0]], rng, 0.0), 'nose'))
    for s in (1, -1):   # eyes
        pieces.append((hull([[0.31, 0.43, 0.04 * s], [0.30, 0.44, 0.045 * s], [0.295, 0.425, 0.047 * s],
                             [0.30, 0.43, 0.03 * s]], rng, 0.0), 'eye'))
    for x in (0.14, -0.13):   # legs: a front pair and a back pair
        for s in (1, -1):
            top = [[x - 0.03, 0.26, 0.045 * s], [x + 0.03, 0.26, 0.045 * s], [x, 0.24, 0.07 * s], [x, 0.25, 0.02 * s]]
            foot = [[x - 0.015, 0.0, 0.05 * s], [x + 0.035, 0.0, 0.05 * s], [x - 0.012, 0.0, 0.07 * s],
                    [x + 0.03, 0.0, 0.07 * s], [x + 0.005, 0.03, 0.045 * s], [x + 0.005, 0.03, 0.075 * s]]
            mid = [[x - 0.012, 0.12, 0.052 * s], [x + 0.016, 0.12, 0.052 * s], [x, 0.12, 0.068 * s]]
            pieces.append((hull(top + mid, rng, 0.003), 'leg'))
            pieces.append((hull(mid + foot, rng, 0.002), 'sock'))
    # Tail: a bushy hull along a curve, plus a white tip.
    tpath = [[-0.18, 0.27, 0], [-0.30, 0.22, 0.02], [-0.40, 0.18, 0.05], [-0.48, 0.17, 0.08]]
    trad = [0.035, 0.06, 0.065, 0.05]
    tail = np.vstack([ellipsoid_pts(c, r_, 2, 6) for c, r_ in zip(tpath[:3], trad[:3])])
    pieces.append((hull(tail, rng, 0.006), 'body'))
    pieces.append((hull(np.vstack([ellipsoid_pts(tpath[2], 0.045, 2, 5), ellipsoid_pts(tpath[3], 0.045, 2, 5),
                                   [[-0.55, 0.17, 0.10]]]), rng, 0.005), 'tip'))
    out = []
    for m, kind in pieces:
        n = m.face_normals; ctr = m.triangles_center
        if kind in ('nose', 'eye', 'sock'): col = np.tile(black, (len(n), 1))
        elif kind == 'tip': col = np.tile(white, (len(n), 1))
        elif kind == 'ear':
            col = np.where((ctr[:, 1] > 0.50)[:, None], black, np.where((n[:, 0] > 0.3)[:, None], dark, orange))
        elif kind == 'head':   # white cheeks / underside of the muzzle
            col = np.where(((n[:, 1] < -0.2) | ((ctr[:, 1] < 0.40) & (ctr[:, 0] > 0.28)))[:, None], white, orange)
        elif kind == 'chest': col = np.where((n[:, 0] > 0.2)[:, None] | (n[:, 1] < -0.3)[:, None], white, orange)
        elif kind == 'body': col = np.where((n[:, 1] < -0.55)[:, None], white, orange)
        else: col = np.tile(orange, (len(n), 1))
        # Alternate facets a touch lighter/darker so the triangles read even before lighting.
        col = col * (0.92 + 0.12 * rng.random((len(n), 1)))
        col[:, 3] = 255
        out.append(faceted(m, col))
    return [('fox', join(out))]

# ---------------------------------------------------------------------------- build + checks

MODELS = {'fruit-bowl': fruit_bowl, 'gears': gears, 'layered-building': layered_building, 'lowpoly-fox': lowpoly_fox}

def explode_check(parts):
    """Replay manipulator.js explode (unit dir from mean of part bbox centres, fixed 0.6 m)
    and count part pairs whose bounding boxes overlap before / after. Returns (before, after,
    [pairs still overlapping after])."""
    boxes = [m.bounds.copy() for _, m in parts]
    ctr = np.array([b.mean(0) for b in boxes]); mean = ctr.mean(0)
    d = ctr - mean; n = np.linalg.norm(d, axis=1, keepdims=True)
    d = np.where(n > 1e-4, d / np.maximum(n, 1e-9), [0, 1, 0])
    def overlaps(bs):
        out = []
        for i in range(len(bs)):
            for j in range(i + 1, len(bs)):
                if np.all(bs[i][0] < bs[j][1]) and np.all(bs[j][0] < bs[i][1]): out.append((parts[i][0], parts[j][0]))
        return out
    after = [b + EXPLODE * d[i] for i, b in enumerate(boxes)]
    return len(overlaps(boxes)), overlaps(after)

def build(key):
    parts = MODELS[key]()
    size = normalise(parts, {})
    scene, seen, rows = trimesh.Scene(), {}, []
    for name, m in parts:
        n = seen.get(name, 0) + 1; seen[name] = n
        if n > 1: name = f'{name} {n}'
        m.vertex_normals   # computed now so the GLB carries NORMAL (else three.js falls back to flat)
        scene.add_geometry(m, node_name=name, geom_name=name)
        rows.append(f'{name} ({len(m.faces)})')
    out = OUT / f'{key}.glb'
    out.write_bytes(scene.export(file_type='glb'))
    nb = out.stat().st_size
    faces = sum(len(m.faces) for _, m in parts)
    before, after = explode_check(parts) if len(parts) > 1 else (0, [])
    print(f'{key:<17} {nb/1e6:5.2f} MB  {faces:6d} faces  {size[0]:.2f} x {size[1]:.2f} x {size[2]:.2f} m  '
          f'{len(parts)} parts: {", ".join(rows)}')
    if len(parts) > 1:
        print(f'{"":<17} explode: {before} overlapping part pairs at rest -> {len(after)} after'
              + (f' ({"; ".join(" / ".join(p) for p in after)})' if after else ''))
    return nb <= MAX_BYTES

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', choices=list(MODELS), help='build one model')
    a = ap.parse_args()
    ok = True
    for key in MODELS:
        if a.only and key != a.only: continue
        ok &= build(key)
    if not ok: sys.exit('a model is over the size budget')

if __name__ == '__main__': main()

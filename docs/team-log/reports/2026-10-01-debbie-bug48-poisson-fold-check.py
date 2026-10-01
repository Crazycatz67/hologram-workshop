"""BUGS #48 regression: Poisson must survive back-to-back folded faces (null vertex normals).
Run from the repo root: .venv/bin/python docs/team-log/reports/2026-10-01-debbie-bug48-poisson-fold-check.py
Before the fix: FAIL (PyMeshLabException). After: PASS. preclean=False still fails (proves the check bites)."""
import sys, numpy as np, pymeshlab
sys.path.insert(0, "completion"); import fill
ms = pymeshlab.MeshSet(); ms.create_sphere(subdiv=4)
v = ms.current_mesh().vertex_matrix().astype(float); f = ms.current_mesh().face_matrix().astype(np.int64)
base = len(v); v = np.vstack([v, [[0, 0, 1.3], [0.1, 0, 1.3], [0, 0.1, 1.3], [0.1, 0.1, 1.3]]])
flap = np.array([[0, 1, 2], [1, 3, 2]]) + base
f = np.vstack([f, flap, flap[:, ::-1]])          # a flap and its reversed copy: normals cancel
ok = True
try:
    print("default  PASS", len(fill.poisson(v, f)[1]), "faces")
except Exception as e:
    ok = False; print("default  FAIL", type(e).__name__)
try:
    fill.poisson(v, f, preclean=False); ok = False; print("preclean=False unexpectedly passed")
except Exception:
    print("preclean=False fails as expected")
sys.exit(0 if ok else 1)

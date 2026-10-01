"""BUGS #24 regression: thin shells (5 mm vase wall) get their hidden skin rebuilt at the measured
wall thickness instead of a Poisson balloon, and the chair underside is unharmed.
Run from the repo root (needs completion/out/truths/vase.obj):
  .venv/bin/python docs/team-log/reports/2026-10-01-debbie-bug24-thin-shell-check.py
  ... --fill-dir <folder with an old fill.py>   # prove the check bites on old code
Expected after the fix: vase wall+u added-real ~73% (bar 40%); chair underside cov@2cm and
added-real >= 97%. Before the fix: vase wall+u ~33% -> FAIL. ~40 s."""
import sys, argparse
ap = argparse.ArgumentParser(); ap.add_argument("--fill-dir"); args = ap.parse_args()
sys.path.insert(0, "."); sys.path.insert(0, "completion")
if args.fill_dir:
    sys.path.insert(0, args.fill_dir)
import numpy as np
import fill
import benchmark as B
from scipy.spatial import cKDTree
print("fill:", fill.__file__)


def run(truth, scenario):
    rng = np.random.default_rng(0)
    v, f = B.load_vf(truth)
    truth_tree = cKDTree(B.sample_surface(v, f, B.sample_count(v, f, B.OUTPUT_SAMPLES), rng))
    mask = B.hidden_masks(v, f, rng)[scenario]
    pv, pf = B.submesh(v, f, ~mask)
    hv, hf = B.submesh(v, f, mask)
    hidden = B.sample_surface(hv, hf, B.TRUTH_SAMPLES, rng)
    ptree = cKDTree(B.sample_surface(pv, pf, B.sample_count(pv, pf, B.OUTPUT_SAMPLES), rng))
    ov, of, _ = fill.complete(pv, pf)
    return B.score(ov, of, ptree, truth_tree, hidden, rng)


vase = run("completion/out/truths/vase.obj", "wall+u")
chair = run("assets/chair/chair_clean.obj", "underside")
print(f"vase wall+u: added {vase['added_m2']:.3f} m2, {vase['added_ok2cm']:.1%} real (bar 40%)")
print(f"chair underside: cov@2cm {chair['cov2cm']:.1%}, added {chair['added_ok2cm']:.1%} real (bar 97%)")
ok = vase["added_ok2cm"] >= 0.40 and chair["cov2cm"] >= 0.97 and chair["added_ok2cm"] >= 0.97
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)

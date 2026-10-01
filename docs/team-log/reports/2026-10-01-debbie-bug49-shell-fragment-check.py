"""BUGS #49 regression: a small shell plane parallel to a larger one within planes.DUP_GAP is
demoted (shell_fragment=True), and slab_fill still treats it as room hull.
Run from the repo root (needs the cached completion/out/redwood/ prep+register):
  .venv/bin/python docs/team-log/reports/2026-10-01-debbie-bug49-shell-fragment-check.py
Expected after the fix: synthetic room 6 shells / 0 fragments; Redwood 7 shells / 1 fragment
(0.93 m2). Before the fix: Redwood 8 shells, no shell_fragment attribute."""
import sys, numpy as np
sys.path.insert(0, "completion")
import planes, room_bench, redwood
def count(v, f):
    pl = planes.find_planes(v, f, rng=np.random.default_rng(0))
    return sum(p.shell for p in pl), [round(p.area, 2) for p in pl if p.shell_fragment]
s1, fr1 = count(*room_bench.build_room()[:2])
laser, _, rv, rf = redwood.prep(); sc, r, t, _ = redwood.register(laser, rv, rf, np.random.default_rng(0))
s2, fr2 = count(sc * rv @ r.T + t, rf)
print(f"synthetic: {s1} shells, fragments {fr1}; redwood: {s2} shells, fragments {fr2}")
ok = s1 == 6 and not fr1 and s2 == 7 and len(fr2) == 1
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)

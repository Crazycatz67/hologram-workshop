# BUGS #46 polygon mode: next steps (Debbie, 2026-10-01)
State: fixed offline, polygon-test 42/0 (group F, 10 new checks), library 69/0, ring 74/0, p5 24/0, safety 5/5.
1. Owner live check (BUGS #46 "Still to confirm"): open Chair, press P with nothing selected. Expect a faint skin + triangle wire within ~1 s; zooming in makes the wire finer; hover shows the lens; click selects an amber patch.
2. Owner decisions: is the 0.9 s ease too slow (the photosafety margin needs >= ~0.9 s at a 0.3x skin)? Does the coarse wire at the default view (4.7k of 304k triangles, labelled "zoom in for finer") read as the "real triangle form"?
3. Known limits: realism > 0 weakens the skin fade (hologramOpacity blends toward 1); Plain mode has no skin fade (wire drawn over opaque clay).
4. Optional (Cody): sessionrec could log whole-scene enters and wire counts.

import { SAMPLES } from './samples.js';

// The list of holograms the carousel can switch between. `id` is the stable key used for
// per-model localStorage (measurement calibration, notes) -- see measurePanel.js/annotations.js --
// instead of deriving one from the file path, so two models can never collide on a shared name.
export const MODELS = [
  // The detailed chair (completion/detail.py + bake_parts.py): denoised within a measured
  // fidelity budget, the scan's real colours carried over, and 8 named parts -- so explode
  // pulls the real legs/runners/seat/backrest apart. Its own id: notes and calibration saved
  // on the clean mesh stay with that mesh.
  { id: 'chair-detail', name: 'Chair', glbPath: 'assets/chair/chair_detail.glb' },
  { id: 'chair', name: 'Chair (clean mesh)', objPath: 'assets/chair/chair_clean.obj' },
  // Temporary stand-in second entry, purely to prove the carousel's dispose/reload/rebind
  // sequence end-to-end before the real chess asset exists (see ROADMAP.md). Exercises the
  // glbPath loading path too, which nothing in the app has used until now. Swap this out for
  // the real `chess` entry once assets/chess/chess_clean.obj is cleaned and verified.
  { id: 'chair-raw', name: 'Chair (raw scan)', glbPath: 'assets/chair/chair.glb' },
  // Stock sample objects (samples.js; licences in assets/samples/SOURCES.md), after the chair
  // so the scan stays the default. `credit` is the attribution line the page should show.
  ...SAMPLES.map((s) => ({ id: s.id, name: s.title, glbPath: s.path, credit: s.credit }))
];

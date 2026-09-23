// The list of holograms the carousel can switch between. `id` is the stable key used for
// per-model localStorage (measurement calibration, notes) -- see measurePanel.js/annotations.js --
// instead of deriving one from the file path, so two models can never collide on a shared name.
export const MODELS = [
  { id: 'chair', name: 'Chair', objPath: 'assets/chair/chair_clean.obj' },
  // Temporary stand-in second entry, purely to prove the carousel's dispose/reload/rebind
  // sequence end-to-end before the real chess asset exists (see ROADMAP.md). Exercises the
  // glbPath loading path too, which nothing in the app has used until now. Swap this out for
  // the real `chess` entry once assets/chess/chess_clean.obj is cleaned and verified.
  { id: 'chair-raw', name: 'Chair (raw scan)', glbPath: 'assets/chair/chair.glb' }
];

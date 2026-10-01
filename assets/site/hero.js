// Landing-page hero: the sample chair as a live hologram, loaded lazily.
//
// Contract
//   startHero(stage, { modelPath, onReady }) -> Promise<{ stop(), start(), renderer }>
//     stage: the .stage element holding the poster <img>. A canvas is added; when the first
//     frame has rendered, stage gets class "live" (CSS cross-fades poster -> canvas).
//   Same look as hologram.html / viewer.html: HolographicMaterial with the viewer's settings
//   (the ones safety-test.html measures), smoothed shading and the single-layer pass.
//   Rendering pauses while the stage is off screen or the tab is hidden.
//   Controls: drag to turn on fine pointers only; no zoom or pan, so the wheel and touch
//   scrolling keep scrolling the page. Auto-rotate, except under prefers-reduced-motion.
// Paths resolve against the site root (two levels above this file).

const ROOT = new URL('../../', import.meta.url);

export async function startHero(stage, { modelPath = 'assets/chair/chair_detail.glb', onReady } = {}) {
  const THREE = await import('three');
  const { createScene } = await import(new URL('scene.js', ROOT).href);
  const { loadModel, frameObject } = await import(new URL('loadModel.js', ROOT).href);
  const { default: HolographicMaterial } = await import(new URL('HolographicMaterial.js', ROOT).href);
  const { prepareHologram, enableSingleLayer } = await import(new URL('hologramLook.js', ROOT).href);

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;

  // Transparent canvas: the stage's own dark gradient is the background in both themes.
  const { scene, camera, renderer, controls } = createScene(stage, { transparentBackground: true });
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');   // the stage itself carries role="img" + label
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 1.2;
  controls.enabled = fine;
  // OrbitControls sets touch-action:none, which would trap a phone's scroll on the hero.
  if (!fine) { canvas.style.touchAction = 'pan-y'; canvas.style.pointerEvents = 'none'; }

  const material = new HolographicMaterial({
    hologramColor: '#4fd1ff',
    hologramBrightness: 1.25,
    fresnelAmount: 0.45,
    fresnelOpacity: 1.0,
    scanlineSize: 40.0,
    signalSpeed: 0.6,
    hologramOpacity: 1.0,
    enableBlinking: true,
    blinkFresnelOnly: true
  });

  const { object } = await loadModel({ glbPath: new URL(modelPath, ROOT).href, objPath: new URL('assets/chair/chair_clean.obj', ROOT).href });
  object.traverse((m) => { if (m.isMesh) m.material = material; });
  prepareHologram(object);
  enableSingleLayer(scene, [material]);
  scene.add(object);
  frameObject(object, camera, controls);

  let running = false, visible = true, first = true;
  function frame() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w && h && (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio()))) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    material.update();
    controls.update();
    if (scene.userData.renderSingleLayer) scene.userData.renderSingleLayer(renderer, scene, camera);
    else renderer.render(scene, camera);
    if (first) { first = false; stage.classList.add('live'); onReady?.(); }
  }
  const api = {
    renderer,
    start() { if (!running && visible && !document.hidden) { running = true; renderer.setAnimationLoop(frame); } },
    stop() { running = false; renderer.setAnimationLoop(null); }
  };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? api.start() : api.stop(); }).observe(stage);
  document.addEventListener('visibilitychange', () => (document.hidden ? api.stop() : api.start()));
  api.start();
  return api;
}

// The measurement UI, shared by the viewer and the gesture page so neither grows its own
// copy. Three tools, chosen because each answers a question you would actually ask about a
// real object rather than demonstrating that the app knows a number:
//
//   Dimensions   how big is it, and how big is it NOW if you have scaled it
//   Tape         the distance between any two points you pick on it
//   Fit          will it go through an opening, and in which orientation
//
// One distinction runs through all of it: the SCANNED size never changes, no matter what
// the gestures do to the model on screen. Pinch-scaling a chair does not resize the real
// chair. So measurements are always reported against the scan, and the on-screen size is
// shown separately and only when it differs — otherwise the panel would confidently report
// a made-up number the moment anyone stretched anything.

import * as THREE from 'three';
import { measureObject, scaleDimensions, formatLength, formatVolume, fitCheck } from './measure.js';

const MARKER_COLOR = 0xffd166;
const LINE_COLOR = 0xffd166;
const DRAG_TOLERANCE = 5; // px of mouse travel still counted as a click, not an orbit drag

export function createMeasurePanel({ mount, object, camera, renderer, scene }) {
  const base = measureObject(object);
  if (!base) return null;

  let unit = 'cm';
  let tapeActive = false;
  const picks = [];          // local-space points on the object
  const markers = [];
  let line = null;

  // ---- markup ---------------------------------------------------------------------------
  mount.innerHTML = '';
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const title = el('div', 'panel-title');
  title.append(el('span', null, 'Measurements'));
  const unitBtn = el('button', 'unit', 'cm');
  unitBtn.title = 'switch between centimetres and inches';
  title.append(unitBtn);
  mount.append(title);

  const dims = el('div', 'measure-dims');
  mount.append(dims);

  const scaledNote = el('div', 'measure-scaled');
  mount.append(scaledNote);

  const stats = el('div', 'measure-stats');
  mount.append(stats);

  const tapeBtn = el('button', 'ghost wide', 'tape measure: off');
  mount.append(tapeBtn);
  const tapeOut = el('div', 'measure-tape', 'pick two points on the model');
  mount.append(tapeOut);

  mount.append(el('div', 'panel-title', 'Will it fit?'));
  const fitRow = el('div', 'fit-row');
  const wIn = el('input');
  const hIn = el('input');
  for (const [input, ph] of [[wIn, 'width'], [hIn, 'height']]) {
    input.type = 'number';
    input.min = '1';
    input.placeholder = ph;
    input.className = 'fit-input';
  }
  const fitUnit = el('span', 'fit-unit', 'cm');
  fitRow.append(wIn, el('span', 'fit-x', '×'), hIn, fitUnit);
  mount.append(fitRow);
  const fitOut = el('div', 'measure-fit', 'enter an opening to check');
  mount.append(fitOut);

  // ---- rendering the numbers ------------------------------------------------------------
  function currentScale() {
    return { x: object.scale.x, y: object.scale.y, z: object.scale.z };
  }

  function renderDims() {
    const L = (m) => formatLength(m, unit);
    dims.innerHTML = '';
    for (const [label, value] of [['W', base.width], ['D', base.depth], ['H', base.height]]) {
      const cell = el('div', 'dim');
      cell.append(el('span', 'dim-k', label), el('span', 'dim-v', L(value)));
      dims.append(cell);
    }

    const s = currentScale();
    const scaled = Math.abs(s.x - 1) > 0.01 || Math.abs(s.y - 1) > 0.01 || Math.abs(s.z - 1) > 0.01;
    if (scaled) {
      const d = scaleDimensions(base, s);
      scaledNote.textContent =
        `on screen: ${L(d.width)} × ${L(d.depth)} × ${L(d.height)}  (${s.y.toFixed(2)}× tall)`;
      scaledNote.style.display = '';
    } else {
      scaledNote.style.display = 'none';
    }

    stats.textContent =
      `volume ${formatVolume(base.volume, unit)} · surface ${base.surfaceArea.toFixed(2)} m² · ` +
      `footprint ${(base.width * base.depth * 10000).toFixed(0)} cm²`;
  }

  // ---- tape measure ---------------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  function clearTape() {
    for (const marker of markers) scene.remove(marker);
    markers.length = 0;
    picks.length = 0;
    if (line) {
      scene.remove(line);
      line.geometry.dispose();
      line = null;
    }
    tapeOut.textContent = 'pick two points on the model';
  }

  function addMarker(worldPoint) {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 12, 12),
      new THREE.MeshBasicMaterial({ color: MARKER_COLOR })
    );
    marker.position.copy(worldPoint);
    scene.add(marker);
    markers.push(marker);
  }

  function refreshTapeGeometry() {
    if (picks.length === 0) return;
    // Points are stored in the object's LOCAL space, so they stay stuck to the same spot on
    // the chair while gestures move, spin and scale it. World positions are recomputed each
    // frame rather than parenting the markers to the object, which would scale the markers
    // and the line thickness along with it.
    const world = picks.map((p) => object.localToWorld(p.clone()));
    world.forEach((w, i) => markers[i]?.position.copy(w));
    if (world.length === 2) {
      const positions = new Float32Array([
        world[0].x, world[0].y, world[0].z,
        world[1].x, world[1].y, world[1].z
      ]);
      if (!line) {
        line = new THREE.Line(
          new THREE.BufferGeometry(),
          new THREE.LineBasicMaterial({ color: LINE_COLOR })
        );
        scene.add(line);
      }
      line.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
  }

  function reportTape() {
    if (picks.length < 2) {
      tapeOut.textContent = `point ${picks.length} of 2 placed`;
      return;
    }
    // Distance in LOCAL space is the real distance on the scanned object, independent of
    // whatever the model has been scaled to on screen.
    const real = picks[0].distanceTo(picks[1]);
    tapeOut.textContent = `${formatLength(real, unit)} apart on the real object`;
  }

  let downAt = null;
  const onDown = (e) => { downAt = { x: e.clientX, y: e.clientY }; };
  const onUp = (e) => {
    if (!tapeActive || !downAt) return;
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_TOLERANCE) return; // orbiting
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(object, true)[0];
    if (!hit) return;
    if (picks.length === 2) clearTape();
    picks.push(object.worldToLocal(hit.point.clone()));
    addMarker(hit.point.clone());
    refreshTapeGeometry();
    reportTape();
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);

  tapeBtn.addEventListener('click', () => {
    tapeActive = !tapeActive;
    tapeBtn.textContent = `tape measure: ${tapeActive ? 'on' : 'off'}`;
    tapeBtn.classList.toggle('active', tapeActive);
    if (!tapeActive) clearTape();
  });

  // ---- fit check ------------------------------------------------------------------------
  function runFit() {
    const toMetres = (v) => (unit === 'in' ? v * 0.0254 : v / 100);
    const w = parseFloat(wIn.value);
    const h = parseFloat(hIn.value);
    if (!(w > 0) || !(h > 0)) {
      fitOut.textContent = 'enter an opening to check';
      fitOut.className = 'measure-fit';
      return;
    }
    const result = fitCheck(base, toMetres(w), toMetres(h));
    if (result.fits) {
      const b = result.best;
      const tight = Math.min(b.clearanceW, b.clearanceH);
      fitOut.textContent = `fits — ${b.label}, ${formatLength(tight, unit)} to spare at the tightest point`;
      fitOut.className = 'measure-fit ok';
    } else {
      const t = result.tightest;
      const over = Math.max(-t.clearanceW, -t.clearanceH);
      fitOut.textContent = `will not fit — short by ${formatLength(over, unit)} even ${t.label}`;
      fitOut.className = 'measure-fit bad';
    }
  }
  wIn.addEventListener('input', runFit);
  hIn.addEventListener('input', runFit);

  unitBtn.addEventListener('click', () => {
    unit = unit === 'cm' ? 'in' : 'cm';
    unitBtn.textContent = unit;
    fitUnit.textContent = unit;
    renderDims();
    reportTape();
    runFit();
  });

  // ---- keep it live ---------------------------------------------------------------------
  // Own animation frame rather than hooking each page's render loop, so both pages get this
  // by constructing the panel and nothing else. Text is only rewritten when a value actually
  // changes, so this costs a comparison per frame.
  let lastKey = '';
  function tick() {
    const s = currentScale();
    const key = `${s.x.toFixed(3)}|${s.y.toFixed(3)}|${s.z.toFixed(3)}|${unit}`;
    if (key !== lastKey) {
      lastKey = key;
      renderDims();
    }
    refreshTapeGeometry();
    requestAnimationFrame(tick);
  }
  renderDims();
  runFit();
  tick();

  return {
    base,
    dispose() {
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      clearTape();
    }
  };
}

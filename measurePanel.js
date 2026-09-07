// The measurement UI, shared by the viewer and the gesture page so neither grows its own
// copy. Everything here answers a question you would actually ask about a real object rather
// than demonstrating that the app knows a number:
//
//   Dimensions   how big is it, and how big is it NOW if you have scaled it
//   Surfaces     how high is the seat / table top / shelf, detected not assumed
//   Weight       roughly what does it weigh, and what will it cost to ship
//   Tape         the distance between any two points you pick on it
//   Fit          will it go through an opening, and in which orientation
//   Notes        pinned observations, exportable as a report
//
// One distinction runs through all of it: the SCANNED size never changes, no matter what the
// gestures do to the model on screen. Pinch-scaling a chair does not resize the real chair.
// So measurements are always reported against the scan, and the on-screen size is shown
// separately and only when it differs — otherwise the panel would confidently report a
// made-up number the moment anyone stretched anything.

import * as THREE from 'three';
import {
  measureObject, scaleDimensions, formatLength, formatVolume, formatWeight,
  fitCheck, horizontalSurfaces, MATERIALS, estimateWeight, shippingBox,
  calibrate, calibrateSurfaces
} from './measure.js';
import { createAnnotations, buildReport } from './annotations.js';

const MARKER_COLOR = 0xffd166;
const DRAG_TOLERANCE = 5;    // px of mouse travel still counted as a click, not an orbit drag
const SURFACE_MIN_SHARE = 0.10; // below this a "surface" is a foot pad, not something to report
const CAL_STORAGE_PREFIX = 'hologram-cal:';
// Phone LiDAR normally lands within a few percent. A correction much larger than this is far
// more likely to be a typo or the wrong reference picked than a genuinely bad scan, so it is
// flagged rather than silently applied to everything.
const CAL_SUSPICIOUS = 0.10;

export function createMeasurePanel({ mount, object, camera, renderer, scene, modelName = 'Scanned object' }) {
  const rawBase = measureObject(object);
  if (!rawBase) return null;
  const rawSurfaces = horizontalSurfaces(object).filter((s) => s.share >= SURFACE_MIN_SHARE);

  // Everything downstream reads `base` and `surfaces`, which are the calibrated views. The
  // raw measurements are kept so re-calibrating is always computed against the scan itself
  // and never compounds a previous correction.
  let factor = loadFactor();
  let base = calibrate(rawBase, factor);
  let surfaces = calibrateSurfaces(rawSurfaces, factor);

  // Sections that need re-rendering when the unit changes register here. Per panel, not
  // module-level: two panels on one page would otherwise share and double up handlers.
  const onUnitChange = [];

  let unit = 'cm';
  let mode = 'off';          // 'off' | 'tape' | 'note'
  const picks = [];
  const markers = [];
  let line = null;

  function calKey() {
    return CAL_STORAGE_PREFIX + modelName;
  }

  function loadFactor() {
    try {
      const stored = parseFloat(localStorage.getItem(CAL_STORAGE_PREFIX + modelName));
      return stored > 0 ? stored : 1;
    } catch {
      return 1;
    }
  }

  function setFactor(next) {
    factor = next > 0 ? next : 1;
    base = calibrate(rawBase, factor);
    surfaces = calibrateSurfaces(rawSurfaces, factor);
    try {
      if (factor === 1) localStorage.removeItem(calKey());
      else localStorage.setItem(calKey(), String(factor));
    } catch {
      // Private windows throw; losing persistence is not worth breaking the tool over.
    }
    lastKey = '';           // force the dimensions to redraw
    renderDims();
    renderWeight();
    reportTape();
    runFit();
    for (const fn of onUnitChange) fn();
    renderCalibration();
  }

  // ---- markup helpers -------------------------------------------------------------------
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function section(titleText, startOpen = true) {
    const wrap = el('div', 'sec');
    const head = el('button', 'sec-head');
    head.append(el('span', null, titleText), el('span', 'sec-caret', startOpen ? '−' : '+'));
    const body = el('div', 'sec-body');
    if (!startOpen) body.style.display = 'none';
    head.addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      head.lastChild.textContent = open ? '+' : '−';
    });
    wrap.append(head, body);
    mount.append(wrap);
    return body;
  }

  mount.innerHTML = '';

  // A layer for the note labels, over the canvas but not stealing clicks from it.
  const labelLayer = el('div', 'note-layer');
  document.body.appendChild(labelLayer);

  const head = el('div', 'measure-head');
  head.append(el('span', 'measure-title', 'Measurements'));
  const unitBtn = el('button', 'unit', 'cm');
  unitBtn.title = 'switch between centimetres and inches';
  head.append(unitBtn);
  mount.append(head);

  // ---- dimensions -----------------------------------------------------------------------
  const dimsBody = section('Size');
  const dims = el('div', 'measure-dims');
  const scaledNote = el('div', 'measure-scaled');
  const stats = el('div', 'measure-stats');
  dimsBody.append(dims, scaledNote, stats);

  // ---- calibration ----------------------------------------------------------------------
  const calBody = section('Calibrate', false);
  const calIntro = el('div', 'measure-stats',
    'Measure one feature on the real object by hand, then tell it the true value. Everything else is corrected with it.');
  const calRef = el('select', 'fit-input');
  const calRow = el('div', 'fit-row');
  const calValue = el('input');
  calValue.type = 'number';
  calValue.min = '0.1';
  calValue.step = 'any';
  calValue.placeholder = 'true value';
  calValue.className = 'fit-input';
  const calUnit = el('span', 'fit-unit', 'cm');
  const calApply = el('button', 'ghost', 'apply');
  calRow.append(calValue, calUnit, calApply);
  const calStatus = el('div', 'measure-stats');
  const calReset = el('button', 'ghost wide', 'clear calibration');
  calBody.append(calIntro, calRef, calRow, calStatus, calReset);

  // References are always the RAW measurements: calibrating against an already-corrected
  // number would fold the old correction into the new one.
  function calibrationReferences() {
    const refs = [
      { id: 'width', label: 'Width', metres: rawBase.width },
      { id: 'depth', label: 'Depth', metres: rawBase.depth },
      { id: 'height', label: 'Overall height', metres: rawBase.height }
    ];
    rawSurfaces.forEach((srf, i) => {
      refs.push({
        id: 'surface' + i,
        label: `${i === 0 ? 'Main surface' : 'Surface ' + (i + 1)} height`,
        metres: srf.height
      });
    });
    if (picks.length === 2) {
      refs.push({ id: 'tape', label: 'Current tape measurement', metres: picks[0].distanceTo(picks[1]) });
    }
    return refs;
  }

  function renderCalibration() {
    const refs = calibrationReferences();
    const previous = calRef.value;
    calRef.innerHTML = '';
    for (const r of refs) {
      const opt = el('option', null, `${r.label} — scan says ${formatLength(r.metres * factor, unit)}`);
      opt.value = r.id;
      calRef.append(opt);
    }
    if (refs.some((r) => r.id === previous)) calRef.value = previous;

    if (factor === 1) {
      calStatus.textContent = 'not calibrated — figures are straight from the scan';
      calStatus.className = 'measure-stats';
      calReset.style.display = 'none';
    } else {
      const pct = (factor - 1) * 100;
      const text = `calibrated ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% (×${factor.toFixed(4)})`;
      calReset.style.display = '';
      if (Math.abs(factor - 1) > CAL_SUSPICIOUS) {
        calStatus.textContent = `${text} — that is a big correction for a LiDAR scan. Check the reference and the units.`;
        calStatus.className = 'measure-fit bad';
      } else {
        calStatus.textContent = text;
        calStatus.className = 'measure-fit ok';
      }
    }
  }

  calApply.addEventListener('click', () => {
    const refs = calibrationReferences();
    const ref = refs.find((r) => r.id === calRef.value) ?? refs[0];
    const entered = parseFloat(calValue.value);
    if (!(entered > 0) || !(ref.metres > 0)) {
      calStatus.textContent = 'enter the measured value first';
      calStatus.className = 'measure-fit bad';
      return;
    }
    const trueMetres = unit === 'in' ? entered * 0.0254 : entered / 100;
    setFactor(trueMetres / ref.metres);
  });

  calReset.addEventListener('click', () => {
    calValue.value = '';
    setFactor(1);
  });

  // ---- detected surfaces ----------------------------------------------------------------
  if (surfaces.length) {
    const body = section('Key heights');
    const list = el('div', 'measure-stats');
    body.append(list);
    const renderSurfaces = () => {
      list.innerHTML = '';
      surfaces.forEach((s, i) => {
        const row = el('div', 'surface-row');
        row.append(
          el('span', 'surface-h', formatLength(s.height, unit)),
          el('span', 'surface-d', `${formatLength(s.width, unit)} × ${formatLength(s.depth, unit)}${i === 0 ? '  (main surface)' : ''}`)
        );
        list.append(row);
      });
    };
    renderSurfaces();
    onUnitChange.push(renderSurfaces);
  }

  // ---- weight and shipping --------------------------------------------------------------
  const weightBody = section('Weight & shipping', false);
  const matSel = el('select', 'fit-input');
  for (const m of MATERIALS) {
    const opt = el('option', null, m.name);
    opt.value = String(m.density);
    matSel.append(opt);
  }
  matSel.value = String(MATERIALS[1].density); // softwood: a fair default for furniture
  const weightOut = el('div', 'measure-stats');
  const shipOut = el('div', 'measure-stats');
  const caveat = el('div', 'measure-caveat',
    'Assumes solid throughout. For a hollow or tube-framed object this is an upper bound, not an estimate.');
  weightBody.append(matSel, weightOut, shipOut, caveat);

  function renderWeight() {
    const density = Number(matSel.value);
    const kg = estimateWeight(base.volume, density);
    const box = shippingBox(base);
    weightOut.textContent = `≈ ${formatWeight(kg, unit)} at ${MATERIALS.find((m) => m.density === density).name}`;
    shipOut.textContent =
      `carton ${box.widthCm.toFixed(0)} × ${box.depthCm.toFixed(0)} × ${box.heightCm.toFixed(0)} cm · ` +
      `volumetric ${box.volumetricKg.toFixed(1)} kg (carriers bill the greater of this and actual)`;
  }
  matSel.addEventListener('change', renderWeight);

  // ---- tape measure ---------------------------------------------------------------------
  const tapeBody = section('Tape measure', false);
  const tapeBtn = el('button', 'ghost wide', 'pick two points: off');
  const tapeOut = el('div', 'measure-tape', 'measures the real object, whatever the model is scaled to');
  tapeBody.append(tapeBtn, tapeOut);

  // ---- fit check ------------------------------------------------------------------------
  const fitBody = section('Will it fit?', false);
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
  const fitOut = el('div', 'measure-fit', 'enter an opening to check');
  fitBody.append(fitRow, fitOut);

  // ---- notes ----------------------------------------------------------------------------
  const notesBody = section('Notes', false);
  const noteBtn = el('button', 'ghost wide', 'pin a note: off');
  const noteList = el('div', 'note-list');
  const exportRow = el('div', 'fit-row');
  const copyBtn = el('button', 'ghost', 'copy report');
  const dlBtn = el('button', 'ghost', 'download');
  exportRow.append(copyBtn, dlBtn);
  const exportOut = el('div', 'measure-stats');
  notesBody.append(noteBtn, noteList, exportRow, exportOut);

  const annotations = createAnnotations({
    object, camera, renderer, scene, labelLayer,
    modelKey: modelName,
    onChange: () => renderNotes()
  });

  function renderNotes() {
    noteList.innerHTML = '';
    if (!annotations.all.length) {
      noteList.append(el('div', 'measure-stats', 'no notes yet — pin one to record a mark, a fault, a measurement point'));
      return;
    }
    for (const note of annotations.all) {
      const row = el('div', 'note-row');
      const input = el('input', 'fit-input');
      input.value = note.text;
      input.addEventListener('input', () => annotations.setText(note.id, input.value));
      const del = el('button', 'ghost note-del', '×');
      del.title = 'delete this note';
      del.addEventListener('click', () => annotations.remove(note.id));
      row.append(input, del);
      noteList.append(row);
    }
  }

  function currentReport() {
    const density = Number(matSel.value);
    return buildReport({
      modelName,
      dims: base,
      surfaces,
      weight: { material: MATERIALS.find((m) => m.density === density).name, kg: estimateWeight(base.volume, density) },
      shipping: shippingBox(base),
      notes: annotations.all,
      calibration: factor,
      unit, formatLength, formatVolume, formatWeight
    });
  }

  copyBtn.addEventListener('click', async () => {
    const text = currentReport();
    try {
      await navigator.clipboard.writeText(text);
      exportOut.textContent = 'report copied to the clipboard';
    } catch {
      // Clipboard permission can be refused; falling back to a selectable box beats failing.
      const area = el('textarea', 'fit-input');
      area.value = text;
      area.rows = 6;
      exportOut.innerHTML = '';
      exportOut.append('copy failed — select and copy from here:', area);
    }
  });

  dlBtn.addEventListener('click', () => {
    const blob = new Blob([currentReport()], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `${modelName.replace(/[^\w.-]+/g, '_')}-report.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    exportOut.textContent = 'report downloaded';
  });

  // ---- shared picking (tape and notes both place points on the model) --------------------
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
    tapeOut.textContent = 'measures the real object, whatever the model is scaled to';
  }

  function refreshTapeGeometry() {
    if (picks.length === 0) return;
    // Points are stored in the object's LOCAL space, so they stay stuck to the same spot on
    // the object while gestures move, spin and scale it. World positions are recomputed each
    // frame rather than parenting the markers to the object, which would scale the markers
    // and the line along with it.
    const world = picks.map((p) => object.localToWorld(p.clone()));
    world.forEach((w, i) => markers[i]?.position.copy(w));
    if (world.length === 2) {
      const positions = new Float32Array([
        world[0].x, world[0].y, world[0].z, world[1].x, world[1].y, world[1].z
      ]);
      if (!line) {
        line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: MARKER_COLOR }));
        scene.add(line);
      }
      line.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      line.geometry.attributes.position.needsUpdate = true;
      line.geometry.computeBoundingSphere();
    }
  }

  function pickAt(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObject(object, true)[0] ?? null;
  }

  let downAt = null;
  const onDown = (e) => { downAt = { x: e.clientX, y: e.clientY }; };
  const onUp = (e) => {
    if (mode === 'off' || !downAt) return;
    if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > DRAG_TOLERANCE) return; // orbiting
    const hit = pickAt(e.clientX, e.clientY);
    if (!hit) return;
    const local = object.worldToLocal(hit.point.clone());

    if (mode === 'note') {
      annotations.add(local, '');
      const inputs = noteList.querySelectorAll('input');
      inputs[inputs.length - 1]?.focus();
      return;
    }

    if (picks.length === 2) clearTape();
    picks.push(local);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 12, 12),
      new THREE.MeshBasicMaterial({ color: MARKER_COLOR })
    );
    marker.position.copy(hit.point);
    scene.add(marker);
    markers.push(marker);
    refreshTapeGeometry();
    reportTape();
    renderCalibration();
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);

  function reportTape() {
    if (picks.length < 2) {
      tapeOut.textContent = `point ${picks.length} of 2 placed`;
      return;
    }
    // Distance in LOCAL space is the real distance on the scanned object, independent of
    // whatever the model has been scaled to on screen.
    tapeOut.textContent = `${formatLength(picks[0].distanceTo(picks[1]) * factor, unit)} apart on the real object`;
  }

  function setMode(next) {
    mode = mode === next ? 'off' : next;
    tapeBtn.textContent = `pick two points: ${mode === 'tape' ? 'on' : 'off'}`;
    tapeBtn.classList.toggle('active', mode === 'tape');
    noteBtn.textContent = `pin a note: ${mode === 'note' ? 'on' : 'off'}`;
    noteBtn.classList.toggle('active', mode === 'note');
    if (mode !== 'tape') clearTape();
  }
  tapeBtn.addEventListener('click', () => setMode('tape'));
  noteBtn.addEventListener('click', () => setMode('note'));

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

  // ---- dimensions rendering -------------------------------------------------------------
  function renderDims() {
    const L = (m) => formatLength(m, unit);
    dims.innerHTML = '';
    for (const [label, value] of [['W', base.width], ['D', base.depth], ['H', base.height]]) {
      const cell = el('div', 'dim');
      cell.append(el('span', 'dim-k', label), el('span', 'dim-v', L(value)));
      dims.append(cell);
    }
    const s = object.scale;
    const isScaled = Math.abs(s.x - 1) > 0.01 || Math.abs(s.y - 1) > 0.01 || Math.abs(s.z - 1) > 0.01;
    if (isScaled) {
      const d = scaleDimensions(base, s);
      scaledNote.textContent = `on screen: ${L(d.width)} × ${L(d.depth)} × ${L(d.height)}  (${s.y.toFixed(2)}× tall)`;
      scaledNote.style.display = '';
    } else {
      scaledNote.style.display = 'none';
    }
    stats.textContent =
      `volume ${formatVolume(base.volume, unit)} · surface ${base.surfaceArea.toFixed(2)} m² · ` +
      `footprint ${(base.width * base.depth * 10000).toFixed(0)} cm²`;
  }

  unitBtn.addEventListener('click', () => {
    unit = unit === 'cm' ? 'in' : 'cm';
    unitBtn.textContent = unit;
    fitUnit.textContent = unit;
    calUnit.textContent = unit;
    renderCalibration();
    renderDims();
    renderWeight();
    reportTape();
    runFit();
    for (const fn of onUnitChange) fn();
  });

  // ---- keep it live ---------------------------------------------------------------------
  // Own animation frame rather than hooking each page's render loop, so both pages get this
  // by constructing the panel and nothing else. Text is only rewritten when a value actually
  // changes, so the steady-state cost is a string comparison per frame.
  let lastKey = '';
  function tick() {
    const s = object.scale;
    const key = `${s.x.toFixed(3)}|${s.y.toFixed(3)}|${s.z.toFixed(3)}|${unit}`;
    if (key !== lastKey) {
      lastKey = key;
      renderDims();
    }
    refreshTapeGeometry();
    annotations.update();
    requestAnimationFrame(tick);
  }

  renderDims();
  renderWeight();
  renderNotes();
  renderCalibration();
  runFit();
  tick();

  return {
    base,
    surfaces,
    report: currentReport,
    dispose() {
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      clearTape();
      annotations.clear();
      labelLayer.remove();
    }
  };
}

// Pinned notes on the scanned object, and the report they turn into.
//
// This is the part that makes the scan a RECORD rather than a readout. A dimensioned model
// you can write on — "cracked here", "M6 bolt, 40mm", "veneer lifting" — is a condition
// report, a repair note, an insurance record or a handover document, and none of those work
// if the observation is separated from the place on the object it refers to.
//
// Pins are stored in the object's LOCAL space, for the same reason the tape measure is: the
// gestures move, spin and stretch the model constantly, and a note that drifts off the thing
// it describes is worse than no note. Local space means a pin stays on the chipped leg no
// matter what anyone does to the view.
//
// Notes persist in localStorage against the model's path, so closing the tab doesn't discard
// them. That is deliberately per-browser and not shared anywhere — see the export button for
// getting them out.

import * as THREE from 'three';

const PIN_COLOR = 0x7fe3a1;
const PIN_RADIUS = 0.011;
const STORAGE_PREFIX = 'hologram-notes:';

export function createAnnotations({ object, camera, renderer, scene, labelLayer, modelKey, onChange }) {
  const notes = [];   // { id, local: Vector3, text, marker, label }
  let nextId = 1;

  function storageKey() {
    return STORAGE_PREFIX + modelKey;
  }

  function save() {
    try {
      const plain = notes.map((n) => ({
        x: n.local.x, y: n.local.y, z: n.local.z, text: n.text
      }));
      localStorage.setItem(storageKey(), JSON.stringify(plain));
    } catch {
      // Private windows and blocked site data throw here. Losing persistence is not worth
      // breaking the tool over — the notes still work for this session.
    }
  }

  function makeMarker() {
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(PIN_RADIUS, 12, 12),
      new THREE.MeshBasicMaterial({ color: PIN_COLOR })
    );
    scene.add(marker);
    return marker;
  }

  function makeLabel(text) {
    const el = document.createElement('div');
    el.className = 'note-label';
    el.textContent = text;
    labelLayer.appendChild(el);
    return el;
  }

  function add(localPoint, text) {
    const note = {
      id: nextId++,
      local: localPoint.clone(),
      text,
      marker: makeMarker(),
      label: makeLabel(text)
    };
    notes.push(note);
    save();
    onChange?.();
    return note;
  }

  function remove(id) {
    const i = notes.findIndex((n) => n.id === id);
    if (i === -1) return;
    const [note] = notes.splice(i, 1);
    scene.remove(note.marker);
    note.marker.geometry.dispose();
    note.marker.material.dispose();
    note.label.remove();
    save();
    onChange?.();
  }

  function setText(id, text) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    note.text = text;
    note.label.textContent = text;
    save();
    onChange?.();
  }

  function load() {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(storageKey()) || 'null');
    } catch {
      stored = null;
    }
    if (!Array.isArray(stored)) return;
    for (const s of stored) {
      if (typeof s?.x !== 'number') continue;
      add(new THREE.Vector3(s.x, s.y, s.z), String(s.text ?? ''));
    }
  }

  // Labels are HTML rather than sprites so the text stays crisp at any zoom and can be
  // styled with the rest of the UI. Positions are projected each frame; a label behind the
  // camera projects to a nonsense coordinate, so those are hidden rather than drawn.
  const projected = new THREE.Vector3();
  function update() {
    if (notes.length === 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    for (const note of notes) {
      const world = object.localToWorld(note.local.clone());
      note.marker.position.copy(world);
      projected.copy(world).project(camera);
      if (projected.z > 1) {
        note.label.style.display = 'none';
        continue;
      }
      note.label.style.display = '';
      note.label.style.left = `${(projected.x * 0.5 + 0.5) * rect.width}px`;
      note.label.style.top = `${(-projected.y * 0.5 + 0.5) * rect.height}px`;
    }
  }

  load();

  return {
    get all() { return notes; },
    add,
    remove,
    setText,
    update,
    clear() {
      for (const note of [...notes]) remove(note.id);
    }
  };
}

// A plain-text report, because the point of writing notes down is being able to send them to
// someone. Markdown so it stays readable as-is but pastes into anything.
export function buildReport({ modelName, dims, surfaces, weight, shipping, notes, calibration = 1, unit, formatLength, formatVolume, formatWeight }) {
  const L = (m) => formatLength(m, unit);
  const lines = [];
  lines.push(`# ${modelName}`);
  lines.push('');
  lines.push(`_Measured from a LiDAR scan on ${new Date().toISOString().slice(0, 10)}._`);
  lines.push('');
  // Whether the figures were checked against a hand measurement is exactly what a reader
  // needs to know before trusting them, so it goes at the top rather than in a footnote.
  lines.push(calibration === 1
    ? '_Uncalibrated — taken directly from the scan, so treat these as approximate._'
    : `_Calibrated against a hand measurement (${(calibration - 1) * 100 >= 0 ? '+' : ''}${((calibration - 1) * 100).toFixed(1)}% correction applied)._`);
  lines.push('');
  lines.push('## Dimensions');
  lines.push('');
  lines.push(`| | |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Width | ${L(dims.width)} |`);
  lines.push(`| Depth | ${L(dims.depth)} |`);
  lines.push(`| Height | ${L(dims.height)} |`);
  lines.push(`| Footprint | ${(dims.width * dims.depth * 10000).toFixed(0)} cm² |`);
  lines.push(`| Volume | ${formatVolume(dims.volume, unit)} |`);
  lines.push(`| Surface area | ${dims.surfaceArea.toFixed(2)} m² |`);
  lines.push('');

  if (surfaces?.length) {
    lines.push('## Horizontal surfaces');
    lines.push('');
    for (const s of surfaces) {
      lines.push(`- ${L(s.height)} from the floor — ${L(s.width)} × ${L(s.depth)}`);
    }
    lines.push('');
  }

  if (weight) {
    lines.push('## Weight and shipping');
    lines.push('');
    lines.push(`- Estimated weight as ${weight.material}: **${formatWeight(weight.kg, unit)}**`);
    lines.push(`  (assumes solid throughout — an upper bound for anything hollow or framed)`);
    lines.push(`- Carton needed: ${shipping.widthCm.toFixed(0)} × ${shipping.depthCm.toFixed(0)} × ${shipping.heightCm.toFixed(0)} cm`);
    lines.push(`- Volumetric weight: ${shipping.volumetricKg.toFixed(1)} kg — carriers bill the greater of this and actual weight`);
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  if (!notes.length) {
    lines.push('_None recorded._');
  } else {
    notes.forEach((n, i) => {
      lines.push(`${i + 1}. ${n.text || '(no text)'}`);
    });
  }
  lines.push('');
  return lines.join('\n');
}

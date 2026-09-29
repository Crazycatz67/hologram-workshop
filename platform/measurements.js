// The Measurements tab: every library item, its whole-object size, and every one of its
// parts, measured for real and kept live as parts are moved, rotated and scaled.
//
// Scaling a part is REDESIGNING it: its new size becomes that part's current measurement.
// The size it had when it was loaded stays on screen as the ORIGINAL, with the change, so
// "leg 2 L 44.1 → 52.9 cm (+8.8)" is always visible and nothing pretends the scan changed.
//
// Numbers come from v1's measure.js (measureObject: minimum-area footprint, height on world
// Y, volume, area), unchanged. measureObject reads raw geometry and ignores transforms, so
// each part is handed to it through a small proxy whose positions are the part's vertices in
// their CURRENT world transform: a part scaled x1.2 measures x1.2.
//
// Cost: re-measuring is only done for targets whose shape-relevant transform changed. A move,
// or a spin about the vertical, can't change an oriented size, so those never re-measure a
// part (see shapeKey); the whole-object row re-measures when its parts move relative to each
// other. Nothing is measured while the tab is closed except the one-time originals.
//
// Parts come from item.parts, whatever produced them (segment.js connected components
// today, a real part splitter later). Consumed per part: { id, local, mesh, name? }.

const V = new URL(import.meta.url).search;
const { measureObject, formatLength, formatVolume } = await import('../measure.js' + V);

const ELONGATED = 2.5;        // one dimension this many times the others = a leg, a rail, a rod
const CHANGED_M = 0.0005;     // a size differing by more than 0.5 mm counts as changed
const CLOSED_OPEN_FRAC = 0.002; // at most this share of open edges and volume is meaningful
const PART_THROTTLE_MS = 90;  // live re-measure rate for a part being scaled
const WHOLE_SETTLE_MS = 160;  // the whole object waits for its parts to settle first
const HISTORY_SHOWN = 200;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };

// ---- measuring --------------------------------------------------------------------------
// World-space copy of each mesh's positions, shaped like what measureObject traverses.
function worldProxy(meshes, matrices) {
  const children = [];
  meshes.forEach((m, k) => {
    const src = m.geometry?.attributes?.position;
    if (!src) return;
    const e = (matrices?.[k] ?? m.matrixWorld).elements;
    const n = src.count;
    const a = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = src.getX(i), y = src.getY(i), z = src.getZ(i);
      a[i * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      a[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      a[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    const attr = { count: n, getX: (i) => a[i * 3], getY: (i) => a[i * 3 + 1], getZ: (i) => a[i * 3 + 2] };
    const index = m.geometry.index;
    children.push({ isMesh: true, pos: a, geometry: { getAttribute: (name) => (name === 'position' ? attr : undefined), getIndex: () => index } });
  });
  return { children, updateWorldMatrix() {}, traverse(fn) { children.forEach(fn); } };
}

// Principal axes (PCA) of the vertices, for "length along its long axis" and thickness.
// Rotation-invariant and scales with the part, like the rest of the numbers.
function principalExtents(proxy) {
  let n = 0;
  for (const c of proxy.children) n += c.pos.length / 3;
  if (n < 4) return null;
  const stride = Math.max(1, Math.floor(n / 30000));
  let cnt = 0, mx = 0, my = 0, mz = 0;
  for (const c of proxy.children) for (let i = 0; i < c.pos.length; i += 3 * stride) { mx += c.pos[i]; my += c.pos[i + 1]; mz += c.pos[i + 2]; cnt++; }
  mx /= cnt; my /= cnt; mz /= cnt;
  const C = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (const c of proxy.children) for (let i = 0; i < c.pos.length; i += 3 * stride) {
    const x = c.pos[i] - mx, y = c.pos[i + 1] - my, z = c.pos[i + 2] - mz;
    C[0] += x * x; C[1] += x * y; C[2] += x * z; C[3] += y * y; C[4] += y * z; C[5] += z * z;
  }
  const axes = jacobiEigen([[C[0], C[1], C[2]], [C[1], C[3], C[4]], [C[2], C[4], C[5]]]);
  const ext = axes.map((ax) => {
    let lo = Infinity, hi = -Infinity;
    for (const c of proxy.children) for (let i = 0; i < c.pos.length; i += 3) {
      const d = c.pos[i] * ax[0] + c.pos[i + 1] * ax[1] + c.pos[i + 2] * ax[2];
      if (d < lo) lo = d; if (d > hi) hi = d;
    }
    return hi - lo;
  }).sort((a, b) => b - a);
  return { length: ext[0], thick: ext[1], thin: ext[2] };
}

// Eigenvectors of a symmetric 3x3 matrix (cyclic Jacobi); returns them as unit vectors.
function jacobiEigen(A) {
  const a = A.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A = J^T A J
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]);
}

// Share of open (boundary) edges after welding at 0.1 mm. Topology doesn't change with a
// transform, so this runs once per target. Volume is only reported for closed surfaces.
function openEdgeShare(meshes) {
  let edges = 0, open = 0;
  for (const m of meshes) {
    const pos = m.geometry?.attributes?.position;
    if (!pos) continue;
    const idx = m.geometry.index;
    const weld = new Int32Array(pos.count);
    const seen = new Map();
    for (let i = 0; i < pos.count; i++) {
      const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
      let w = seen.get(k);
      if (w === undefined) { w = seen.size; seen.set(k, w); }
      weld[i] = w;
    }
    const N = seen.size;
    const count = new Map();
    const tris = Math.floor((idx ? idx.count : pos.count) / 3);
    for (let t = 0; t < tris; t++) {
      const v = [0, 1, 2].map((k) => weld[idx ? idx.getX(t * 3 + k) : t * 3 + k]);
      for (let k = 0; k < 3; k++) {
        const a = v[k], b = v[(k + 1) % 3];
        if (a === b) continue;
        const key = a < b ? a * N + b : b * N + a;
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
    edges += count.size;
    for (const c of count.values()) if (c === 1) open++;
  }
  return edges ? open / edges : 1;
}

function measureTargets(meshes, matrices) {
  const proxy = worldProxy(meshes, matrices);
  if (!proxy.children.length) return null;
  const m = measureObject(proxy);
  if (!m) return null;
  const out = { L: m.width, W: m.depth, H: m.height, volume: m.volume, area: m.surfaceArea };
  const dims = [out.L, out.W, out.H].sort((a, b) => b - a);
  out.elongated = dims[1] > 0 && dims[0] > ELONGATED * dims[1];
  if (out.elongated) {
    const p = principalExtents(proxy);
    if (p) { out.length = p.length; out.thick = p.thick; out.thin = p.thin; }
  }
  return out;
}

// What an oriented size depends on: the transform's shape (Gram matrix M^T M) and how it
// tilts relative to world up (M's Y row). Moving, or spinning about world Y, changes
// neither, so neither triggers a re-measure.
function shapeKey(e) {
  const c = [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]]; // columns
  const g = [];
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) g.push(c[i][0] * c[j][0] + c[i][1] * c[j][1] + c[i][2] * c[j][2]);
  return [...g, e[1], e[5], e[9]];
}
const keysDiffer = (a, b) => !a || a.length !== b.length || a.some((x, i) => Math.abs(x - b[i]) > 1e-9);

export function includesInferred(mesh) {
  if (!mesh) return false;
  if (mesh.userData?.inferredShare > 0) return true;
  if (mesh.userData?.materialGroup === 'inferred' || mesh.userData?.group === 'inferred') return true;
  const mats = [mesh.userData?.original ?? mesh.material].flat();
  return mats.some((m) => /(^|[^a-z])inferred/i.test(m?.name ?? ''));
}

// ---- the tab ------------------------------------------------------------------------------
export function createMeasurements({ mount, toggleBtn, objectMode, getItems }) {
  const { itemKey, isItemKey, changesOf } = objectMode;
  let unit = 'cm';
  let open = true;
  const sections = new Map(); // itemId -> section state
  const recs = new Map();     // target key (part id or itemKey) -> rec
  let historyKey = '';

  mount.innerHTML = '';
  const head = el('div', 'mt-head');
  const title = el('button', 'mt-title', 'Measurements');
  title.title = 'collapse / expand';
  const unitBtn = el('button', 'mt-unit', 'cm');
  unitBtn.title = 'switch between centimetres and inches';
  head.append(title, unitBtn);
  const body = el('div', 'mt-body');
  const empty = el('div', 'mt-empty', 'Load a scan to see the size of every part.');
  const itemsWrap = el('div');
  const histWrap = el('div', 'mt-sec');
  const histHead = el('button', 'mt-sechead');
  const histTitle = el('span', null, 'History');
  const histCaret = el('span', 'mt-caret', '+');
  histHead.append(histTitle, histCaret);
  const histBody = el('div', 'mt-hist');
  histBody.style.display = 'none';
  histHead.addEventListener('click', () => {
    const o = histBody.style.display === 'none';
    histBody.style.display = o ? '' : 'none';
    histCaret.textContent = o ? '−' : '+';
    if (o) renderHistory(true);
  });
  histWrap.append(histHead, histBody);
  body.append(empty, itemsWrap, histWrap);
  mount.append(head, body);

  function setOpen(v) {
    open = v;
    body.style.display = open ? '' : 'none';
    mount.classList.toggle('collapsed', !open);
    document.body.classList.toggle('mt-open', open);
    toggleBtn?.classList.toggle('active', open);
    if (open) { flush(true); renderHistory(true); }
  }
  title.addEventListener('click', () => setOpen(!open));
  toggleBtn?.addEventListener('click', () => setOpen(!open));
  unitBtn.addEventListener('click', () => {
    unit = unit === 'cm' ? 'in' : 'cm';
    unitBtn.textContent = unit;
    for (const r of recs.values()) render(r);
    renderRedesign();
  });

  const fmt = (m) => formatLength(m, unit);
  const fmtDelta = (d) => `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;

  // ---- records ----------------------------------------------------------------------------
  function partLabel(p) {
    return p.name || p.label || p.mesh.userData?.label || (/^part-\d+$/.test(p.mesh.name) || !p.mesh.name ? `part ${p.local ?? p.id}` : p.mesh.name);
  }
  function wholeMeshes(item) {
    const list = [];
    item.root.updateWorldMatrix(true, true);
    item.root.traverse((c) => { if (c.isMesh && shown(c)) list.push(c); });
    return list;
  }
  // The whole object's shape key: every drawn mesh relative to the item root, plus the root's
  // own shape key, so moving the whole item doesn't re-measure it but moving one leg does.
  function wholeKey(item) {
    const out = [...shapeKey(item.root.matrixWorld.elements)];
    const inv = item.root.matrixWorld.clone().invert();
    item.root.traverse((c) => {
      if (!c.isMesh) return;
      const rel = inv.clone().multiply(c.matrixWorld).elements;
      out.push(shown(c) ? 1 : 0, ...rel.slice(0, 15));
    });
    return out;
  }
  function makeRec(key, kind, item, part) {
    const meshes = kind === 'item' ? wholeMeshes(item) : [part.mesh];
    const rec = {
      key, kind, item, part, label: kind === 'item' ? 'Whole object' : partLabel(part),
      inferred: meshes.some(includesInferred),
      // Originals are measured from the transforms at first sight (load), captured now.
      originalMatrices: meshes.map((m) => m.matrixWorld.clone()), originalMeshes: meshes,
      original: null, current: null, closed: null,
      shape: null, dirty: true, changedAt: 0, measuredAt: 0, row: null
    };
    rec.shape = kind === 'item' ? wholeKey(item) : shapeKey(part.mesh.matrixWorld.elements);
    recs.set(key, rec);
    return rec;
  }
  function ensureOriginal(rec) {
    if (rec.original) return;
    rec.original = measureTargets(rec.originalMeshes, rec.originalMatrices);
    rec.closed = openEdgeShare(rec.originalMeshes) <= CLOSED_OPEN_FRAC;
    rec.originalMatrices = rec.originalMeshes = null;
  }
  function measure(rec) {
    ensureOriginal(rec);
    const meshes = rec.kind === 'item' ? wholeMeshes(rec.item) : [rec.part.mesh];
    rec.part?.mesh.updateWorldMatrix(true, false);
    rec.current = meshes.length ? measureTargets(meshes) : null;
    rec.dirty = false;
    rec.measuredAt = performance.now();
    render(rec);
  }

  // ---- DOM ----------------------------------------------------------------------------------
  function addItem(item) {
    if (sections.has(item.id) || item.status !== 'ready') return;
    item.root.updateWorldMatrix(true, true);
    const sec = { item, partsRef: item.parts, partsLen: item.parts.length, wrap: el('div', 'mt-sec'), list: el('div', 'mt-list'), open: true };
    const h = el('button', 'mt-sechead');
    const name = el('span', 'mt-itemname', item.name);
    name.title = item.name;
    const count = el('span', 'mt-count', `${item.parts.length} part${item.parts.length === 1 ? '' : 's'}`);
    const caret = el('span', 'mt-caret', '−');
    h.append(name, count, caret);
    h.addEventListener('click', () => {
      sec.open = !sec.open;
      sec.list.style.display = sec.open ? '' : 'none';
      caret.textContent = sec.open ? '−' : '+';
      if (sec.open) flush(true);
    });
    sec.count = count;
    sec.wrap.append(h, sec.list);
    itemsWrap.append(sec.wrap);
    sections.set(item.id, sec);
    buildRows(sec);
    empty.style.display = 'none';
    if (open) flush(true);
  }

  function buildRows(sec) {
    const { item } = sec;
    for (const [k, r] of recs) if (String(r.item.id) === String(item.id)) recs.delete(k);
    sec.list.innerHTML = '';
    const whole = makeRec(itemKey(item.id), 'item', item, null);
    sec.list.append(rowFor(whole));
    for (const p of item.parts) sec.list.append(rowFor(makeRec(p.id, 'part', item, p)));
    sec.partsRef = item.parts; sec.partsLen = item.parts.length;
    sec.count.textContent = `${item.parts.length} part${item.parts.length === 1 ? '' : 's'}`;
  }

  function rowFor(rec) {
    const row = el('div', `mt-row${rec.kind === 'item' ? ' mt-whole' : ''}`);
    row.dataset.key = rec.key;
    const top = el('div', 'mt-rowtop');
    const name = el('span', 'mt-name', rec.label);
    const tags = el('span', 'mt-tags');
    top.append(name, tags);
    const dims = el('div', 'mt-dims', 'measuring…');
    const extra = el('div', 'mt-extra');
    row.append(top, dims, extra);
    rec.row = row; rec.tagsEl = tags; rec.dimsEl = dims; rec.extraEl = extra;
    row.addEventListener('mouseenter', () => objectMode.hover(rec.key));
    row.addEventListener('mouseleave', () => { if (objectMode.hoverId === rec.key) objectMode.hover(null); });
    row.addEventListener('click', (e) => {
      if (e.target.closest('.mt-redesign')) return;
      selectKey(rec.key);
    });
    return row;
  }

  function selectKey(key) {
    if (objectMode.mode !== 'object') objectMode.setMode('object');
    objectMode.select(key);
  }

  function dimChip(label, cur, orig) {
    const s = el('span', 'mt-dim');
    s.append(el('b', null, label + ' '));
    if (orig != null && Math.abs(cur - orig) > CHANGED_M) {
      s.classList.add('changed');
      s.append(el('span', 'mt-was', fmt(orig)), ` → ${fmt(cur)} `, el('i', null, `(${fmtDelta(cur - orig)})`));
    } else s.append(fmt(cur));
    return s;
  }

  function render(rec) {
    if (!rec.row) return;
    const hiddenNow = rec.kind === 'item' ? !rec.item.root.visible : !shown(rec.part.mesh);
    const tags = [];
    if (rec.inferred) tags.push('(includes inferred)');
    if (hiddenNow) tags.push('hidden');
    rec.tagsEl.textContent = tags.join(' · ');
    rec.row.classList.toggle('is-hidden', hiddenNow);
    const c = rec.current, o = rec.original;
    rec.dimsEl.innerHTML = '';
    rec.extraEl.innerHTML = '';
    if (!c) { rec.dimsEl.textContent = hiddenNow ? 'hidden' : 'measuring…'; return; }
    rec.dimsEl.append(dimChip('L', c.L, o?.L), dimChip('W', c.W, o?.W), dimChip('H', c.H, o?.H));
    const changed = o && ['L', 'W', 'H'].some((k) => Math.abs(c[k] - o[k]) > CHANGED_M);
    rec.row.classList.toggle('changed', !!changed);
    const extras = [];
    if (c.elongated && c.length != null) {
      const ol = o?.length;
      const lenTxt = ol != null && Math.abs(c.length - ol) > CHANGED_M
        ? `length ${fmt(ol)} → ${fmt(c.length)} (${fmtDelta(c.length - ol)})` : `length ${fmt(c.length)}`;
      const th = c.thin < c.thick * 0.7 ? `${fmt(c.thick)} × ${fmt(c.thin)}` : fmt(c.thick);
      extras.push(lenTxt, `thickness ${th}`);
    }
    if (rec.closed) {
      const ov = o?.volume;
      extras.push(ov != null && Math.abs(c.volume - ov) > ov * 0.001
        ? `vol ${formatVolume(ov, unit)} → ${formatVolume(c.volume, unit)}` : `vol ${formatVolume(c.volume, unit)}`);
    }
    rec.extraEl.textContent = extras.join('  ·  ');
    rec.extraEl.style.display = extras.length ? '' : 'none';
    if (objectMode.selectedId === rec.key) renderRedesign();
  }

  // ---- redesign (set size) -----------------------------------------------------------------
  const redesign = el('div', 'mt-redesign');
  const rdSel = el('select');
  const rdIn = el('input');
  rdIn.type = 'number'; rdIn.min = '0.1'; rdIn.step = 'any';
  const rdUnit = el('span', 'mt-rdunit', 'cm');
  const rdSet = el('button', null, 'Set size');
  const rdReset = el('button', null, 'Original size');
  const rdMsg = el('div', 'mt-rdmsg');
  const rdRow = el('div', 'mt-rdrow');
  rdRow.append(rdSel, rdIn, rdUnit, rdSet);
  redesign.append(el('div', 'mt-rdtitle', 'Redesign: set size (uniform scale)'), rdRow, rdReset, rdMsg);
  let rdFor = null;

  function renderRedesign() {
    const key = objectMode.selectedId;
    const rec = key != null ? recs.get(key) : null;
    if (!rec || !rec.row || !rec.current) { redesign.remove(); rdFor = null; return; }
    if (redesign.parentNode !== rec.row) { rec.row.append(redesign); rdMsg.textContent = ''; }
    const c = rec.current;
    const opts = [['L', 'length L'], ['W', 'width W'], ['H', 'height H']];
    if (c.elongated && c.length != null) opts.unshift(['length', 'long axis']);
    const prev = rdFor === key ? rdSel.value : (c.elongated && c.length != null ? 'length' : 'H');
    const sig = opts.map((o) => o[0]).join();
    if (rdSel.dataset.sig !== sig) {
      rdSel.innerHTML = '';
      for (const [v, t] of opts) { const op = el('option', null, t); op.value = v; rdSel.append(op); }
      rdSel.dataset.sig = sig;
    }
    rdSel.value = opts.some((o) => o[0] === prev) ? prev : 'H';
    rdUnit.textContent = unit;
    const o = rec.original;
    rdReset.disabled = !o || ['L', 'W', 'H'].every((k) => Math.abs(c[k] - o[k]) <= CHANGED_M);
    if (rdFor !== key || document.activeElement !== rdIn) rdIn.placeholder = (unit === 'in' ? c[rdSel.value] * 39.3701 : c[rdSel.value] * 100).toFixed(1);
    rdFor = key;
  }
  rdSel.addEventListener('change', () => renderRedesign());
  const applyFactor = (rec, f, what) => {
    const e = objectMode.scaleTarget(rec.key, f);
    measure(rec); // live and exact, straight away
    const whole = rec.kind === 'part' ? recs.get(itemKey(rec.item.id)) : null;
    if (whole) { whole.dirty = true; whole.changedAt = performance.now(); }
    rdMsg.textContent = e ? `${what}: scaled ×${e.factor.toFixed(3)}` : 'no change (limit reached or same size)';
  };
  rdSet.addEventListener('click', () => {
    const rec = recs.get(objectMode.selectedId);
    if (!rec) return;
    const v = parseFloat(rdIn.value);
    if (!(v > 0)) { rdMsg.textContent = 'enter a size first'; return; }
    if (rec.dirty || !rec.current) measure(rec);
    const cur = rec.current?.[rdSel.value];
    if (!(cur > 0)) return;
    const metres = unit === 'in' ? v * 0.0254 : v / 100;
    applyFactor(rec, metres / cur, 'set');
    rdIn.value = '';
  });
  rdIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') rdSet.click(); e.stopPropagation(); });
  rdReset.addEventListener('click', () => {
    const rec = recs.get(objectMode.selectedId);
    if (!rec) return;
    if (rec.dirty || !rec.current) measure(rec);
    const k = rec.current.elongated && rec.original?.length ? 'length' : 'H';
    if (rec.original?.[k] > 0 && rec.current[k] > 0) applyFactor(rec, rec.original[k] / rec.current[k], 'reset');
  });

  // ---- history ------------------------------------------------------------------------------
  function nameOf(item, part) {
    if (part != null) return recs.get(part)?.label ?? `part ${String(part).split('.').pop()}`;
    const it = getItems().find((i) => String(i.id) === String(item));
    return it ? it.name : `item ${item}`;
  }
  function describe(e) {
    const who = nameOf(e.item, e.part);
    const n = changesOf(e).length;
    switch (e.op) {
      case 'move': return `moved ${who} ${fmt(Math.hypot(e.dx ?? 0, e.dz ?? 0))}`;
      case 'rotate': return `rotated ${who} ${Math.round(((e.dy ?? 0) * 180) / Math.PI)}°`;
      case 'scale': return `scaled ${who} ×${(e.factor ?? 1).toFixed(2)}`;
      case 'hide': return `hid ${who}`;
      case 'show': return `showed ${who}`;
      case 'showAll': return `showed all (${n})`;
      case 'arrange': return `arranged ${e.items?.length ?? n} item${(e.items?.length ?? n) === 1 ? '' : 's'}`;
      case 'importLayout': return `imported a layout (${n} change${n === 1 ? '' : 's'})`;
      default: return `${e.op ?? 'edit'} ${e.part != null || e.item != null ? who : ''}`.trim();
    }
  }
  const clock = (e) => {
    const d = e.at ? new Date(e.at) : null;
    return d && !isNaN(d) ? d.toTimeString().slice(0, 8) : '--:--:--';
  };
  function renderHistory(force = false) {
    const edits = objectMode.edits;
    const last = edits[edits.length - 1];
    const key = `${edits.length}|${last?.seq}|${last?.factor ?? ''}|${last?.dy ?? ''}|${unit}`;
    histTitle.textContent = `History (${edits.length})`;
    if (!force && key === historyKey) return;
    historyKey = key;
    if (histBody.style.display === 'none' || !open) return;
    histBody.innerHTML = '';
    if (!edits.length) { histBody.append(el('div', 'mt-empty', 'No changes yet. Every move, turn, resize and hide is listed here, and can be replayed.')); return; }
    const from = Math.max(0, edits.length - HISTORY_SHOWN);
    for (let i = edits.length - 1; i >= from; i--) {
      const e = edits[i];
      const row = el('div', 'mt-hrow');
      row.append(el('span', 'mt-htime', clock(e)), el('span', null, describe(e)));
      const single = !e.changes && (e.part != null || e.item != null);
      if (single) {
        row.classList.add('clickable');
        row.title = 'select it';
        row.addEventListener('click', () => selectKey(e.part != null ? e.part : itemKey(e.item)));
      }
      histBody.append(row);
    }
    if (from > 0) histBody.append(el('div', 'mt-empty', `… ${from} older`));
  }

  // ---- per-frame ----------------------------------------------------------------------------
  // Cheap checks every frame; the actual measuring is throttled and limited to what changed.
  function flush(force = false) {
    const now = performance.now();
    for (const rec of recs.values()) {
      if (rec.kind === 'part') {
        const k = shapeKey(rec.part.mesh.matrixWorld.elements);
        if (keysDiffer(rec.shape, k)) { rec.shape = k; rec.dirty = true; rec.changedAt = now; }
      } else {
        const k = wholeKey(rec.item);
        if (keysDiffer(rec.shape, k)) { rec.shape = k; rec.dirty = true; rec.changedAt = now; }
      }
      if (!open || !rec.dirty) continue;
      const sec = sections.get(rec.item.id);
      if (sec && !sec.open) continue;
      if (force || !rec.current) { measure(rec); continue; }
      if (rec.kind === 'part' ? now - rec.measuredAt >= PART_THROTTLE_MS : now - rec.changedAt >= WHOLE_SETTLE_MS) measure(rec);
    }
  }
  let lastVis = '';
  function tick() {
    // A new part list (a re-split) rebuilds that item's rows.
    for (const sec of sections.values()) {
      if (sec.item.parts !== sec.partsRef || sec.item.parts.length !== sec.partsLen) buildRows(sec);
    }
    flush(false);
    // Visibility only changes the tags; recheck it cheaply.
    const vis = [...recs.values()].map((r) => (r.kind === 'item' ? r.item.root.visible : shown(r.part.mesh)) ? 1 : 0).join('');
    if (vis !== lastVis) { lastVis = vis; for (const r of recs.values()) if (r.current || r.row) render(r); }
  }

  // Called with object mode's state on every change (selection, hover, edits).
  function onState() {
    for (const r of recs.values()) {
      r.row?.classList.toggle('selected', objectMode.selectedId === r.key);
      r.row?.classList.toggle('hovered', objectMode.hoverId === r.key);
    }
    renderRedesign();
    renderHistory();
  }

  function removeItem(id) {
    const sec = sections.get(id);
    if (!sec) return;
    sec.wrap.remove();
    sections.delete(id);
    for (const [k, r] of recs) if (String(r.item.id) === String(id)) recs.delete(k);
    empty.style.display = sections.size ? 'none' : '';
    renderRedesign();
  }

  // Numbers for tests and the lead's tooling: { [key]: {label, current, original, closed, inferred} }.
  function data(itemId) {
    flush(true);
    const out = {};
    for (const [k, r] of recs) {
      if (itemId != null && String(r.item.id) !== String(itemId)) continue;
      if (r.dirty || !r.current) measure(r);
      out[k] = { label: r.label, current: r.current, original: r.original, closed: r.closed, inferred: r.inferred };
    }
    return out;
  }

  setOpen(true);
  return { addItem, removeItem, tick, onState, data, setOpen, get unit() { return unit; }, setUnit(u) { if (u !== unit) unitBtn.click(); } };
}

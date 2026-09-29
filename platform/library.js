// Library side panel: one row per dropped item. UI only; main.js owns the scene objects and
// passes handlers. All text goes through textContent, since names come from user files.
export function createLibrary(panel, { onToggle, onFocus, onRemove }) {
  const list = panel.querySelector('#libList');
  const countEl = panel.querySelector('#libCount');
  const empty = panel.querySelector('#libEmpty');
  const rows = new Map();

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function refreshCount() {
    countEl.textContent = rows.size ? `(${rows.size})` : '';
    empty.style.display = rows.size ? 'none' : '';
  }

  function add(id, { name, kind }) {
    const row = el('div', 'libRow');
    row.dataset.id = id;
    const top = el('div', 'libName', name);
    top.title = name;
    const meta = el('div', 'libMeta');
    const bar = el('div', 'libBar'); const fill = el('div'); bar.append(fill);
    const btns = el('div', 'libBtns');
    const mk = (label, fn) => { const b = el('button', null, label); b.addEventListener('click', () => fn(id)); btns.append(b); return b; };
    const toggle = mk('Hide', () => onToggle(id));
    const focus = mk('Focus', onFocus);
    mk('Remove', onRemove);
    row.append(top, meta, bar, btns);
    list.append(row);
    rows.set(id, { row, meta, bar, fill, toggle, focus, data: { name, kind, status: 'queued', message: '', tris: null, visible: true } });
    update(id, {});
    refreshCount();
  }

  function update(id, patch) {
    const r = rows.get(id);
    if (!r) return;
    Object.assign(r.data, patch);
    const d = r.data;
    const parts = [d.kind];
    if (d.tris != null) parts.push(d.points ? `${d.points.toLocaleString()} pts` : `${d.tris.toLocaleString()} tris`);
    parts.push(d.status === 'error' ? `error: ${d.message}` : d.message ? `${d.status} - ${d.message}` : d.status);
    r.meta.textContent = parts.join('  ·  ');
    r.row.dataset.status = d.status;
    r.bar.style.display = d.status === 'loading' ? '' : 'none';
    r.fill.style.width = `${Math.round((d.progress ?? 0) * 100)}%`;
    r.toggle.textContent = d.visible ? 'Hide' : 'Show';
    const ready = d.status === 'ready';
    r.toggle.disabled = r.focus.disabled = !ready;
  }

  function remove(id) {
    rows.get(id)?.row.remove();
    rows.delete(id);
    refreshCount();
  }

  return { add, update, remove, get size() { return rows.size; } };
}

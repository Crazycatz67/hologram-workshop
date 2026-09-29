// Page shell behaviour for the 2026-09-29 layout (index.html): side panels that collapse
// (drawers on narrow screens), the inspector's tabs, the help popover, the empty-state card
// and the export menu's placement. Pure UI -- no scene logic lives here. Layout choices are
// remembered per browser (best effort: private windows just start with the defaults).

const STORE_KEY = 'hologram-platform-shell';
const $ = (id) => document.getElementById(id);
const narrow = () => matchMedia('(max-width: 960px)').matches;

export function createShell() {
  let state = { left: true, right: true, tab: 'measure' };
  try { state = { ...state, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ } };
  const body = document.body;

  // Side panels: on wide screens they are grid columns that collapse; on narrow screens
  // they are drawers over the view, closed until asked for.
  function applyPanels() {
    body.classList.toggle('left-closed', !state.left);
    body.classList.toggle('right-closed', !state.right);
    $('toggleLeft').classList.toggle('active', narrow() ? body.classList.contains('left-open') : state.left);
    $('toggleRight').classList.toggle('active', narrow() ? body.classList.contains('right-open') : state.right);
    // The canvas cell changed size; the render loop resizes on the next frame.
  }
  function toggle(side) {
    if (narrow()) {
      const cls = `${side}-open`;
      const opening = !body.classList.contains(cls);
      body.classList.remove('left-open', 'right-open');   // one drawer at a time
      body.classList.toggle(cls, opening);
    } else {
      state[side] = !state[side];
      save();
    }
    applyPanels();
  }
  $('toggleLeft').addEventListener('click', () => toggle('left'));
  $('toggleRight').addEventListener('click', () => toggle('right'));
  matchMedia('(max-width: 960px)').addEventListener('change', () => {
    body.classList.remove('left-open', 'right-open');
    applyPanels();
  });

  // Inspector tabs.
  const tabs = { measure: ['measureBtn', 'measurements'], look: ['lookTab', 'lookPanel'] };
  function showTab(name) {
    state.tab = tabs[name] ? name : 'measure';
    for (const [key, [btnId, panelId]] of Object.entries(tabs)) {
      const on = key === state.tab;
      $(btnId).setAttribute('aria-selected', String(on));
      $(panelId).hidden = !on;
    }
    save();
  }
  $('measureBtn').addEventListener('click', () => showTab('measure'));
  $('lookTab').addEventListener('click', () => showTab('look'));

  // Help popover: "?" button or key, closes on Esc or a click elsewhere.
  const guide = $('guide');
  const setHelp = (open) => { guide.hidden = !open; $('help').classList.toggle('active', open); };
  $('help').addEventListener('click', (e) => { e.stopPropagation(); setHelp(guide.hidden); });
  document.addEventListener('click', (e) => { if (!guide.hidden && !guide.contains(e.target)) setHelp(false); });
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
    if (e.key === 'Escape') setHelp(false);
    if (e.key === '?' && !typing) setHelp(guide.hidden);
  });

  // Export menu: fixed-positioned under its button so the top bar's overflow can't clip it.
  const menu = $('exportMenu');
  new MutationObserver(() => {
    if (menu.hidden) return;
    const r = $('exportBtn').getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
  }).observe(menu, { attributes: true, attributeFilter: ['hidden'] });

  // Empty-state card: shown until something is in the library; its buttons proxy the
  // real top-bar buttons so there is one code path per action.
  const empty = $('empty');
  for (const b of empty.querySelectorAll('[data-proxy]')) b.addEventListener('click', () => $(b.dataset.proxy).click());
  const syncEmpty = () => { empty.hidden = $('libList').children.length > 0; };
  new MutationObserver(syncEmpty).observe($('libList'), { childList: true });
  syncEmpty();

  applyPanels();
  showTab(state.tab);
  return { showTab, toggle };
}

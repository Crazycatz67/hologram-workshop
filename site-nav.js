// Shared site navigation for the public demo site. Any page includes it with ONE line:
//
//   <script type="module" src="site-nav.js"></script>          (root pages)
//   <script type="module" src="../site-nav.js"></script>       (platform/ pages)
//
// Contract
//   - FULL mode (no #site-nav element on the page): prepends a <header class="snav"> to <body>
//     with the brand, the page links, a light/dark toggle and the source link. Below 900 px the
//     links fold into a "Menu" disclosure button. Used by index.html and about.html.
//   - COMPACT mode (the page has <span id="site-nav"></span>, e.g. inside an app's own top bar):
//     renders only a small "Menu ▾" button whose dropdown lists the same pages. App pages keep
//     their own layout, theme and height; nothing else on the page moves. Used by viewer.html.
//   - Links resolve against this file's own URL, so the same file works from / and /platform/.
//     The current page gets aria-current="page".
//   - Theme: <html data-theme="dark|light">, stored in localStorage 'hw.site.theme', dark by
//     default (dark-first). Only FULL mode shows the toggle: the app pages are dark-only.
//   - Keyboard: Tab reaches every link; Esc closes an open menu and returns focus to its button.
//   - Styles are injected once (<style id="snav-style">) and fall back to theme.css's tokens,
//     so a page doesn't need site.css to include the nav.
//   - Loads nothing else and sends nothing: no recorder, no analytics (public-site rule).
//   - Exposes window.siteNav = { mode, pages, setTheme(name) } for tests.

const ROOT = new URL('./', import.meta.url);
const THEME_KEY = 'hw.site.theme';
const SOURCE = 'https://github.com/Crazycatz67/hologram-workshop';

// href is relative to the site root; `match` decides aria-current (the Practice link shares
// hologram.html with the Gesture demo, so only an exact hash match marks it).
export const PAGES = [
  { id: 'home', label: 'Home', href: 'index.html' },
  { id: 'gesture', label: 'Gesture demo', href: 'hologram.html' },
  { id: 'platform', label: 'Platform', href: 'platform/index.html' },
  { id: 'practice', label: 'Practice', href: 'hologram.html#try=practice' },
  { id: 'viewer', label: 'Viewer', href: 'viewer.html' },
  { id: 'about', label: 'About', href: 'about.html' }
];

function readTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

export function setTheme(name) {
  const t = name === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode: still applies for this page */ }
  const btn = document.querySelector('.snav-theme');
  if (btn) {
    btn.textContent = t === 'light' ? '☾' : '☀';
    btn.setAttribute('aria-label', t === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    btn.title = btn.getAttribute('aria-label');
  }
}

function isCurrent(page) {
  const here = new URL(location.href);
  const target = new URL(page.href, ROOT);
  const norm = (p) => p.replace(/\/index\.html$/, '/');
  if (norm(here.pathname) !== norm(target.pathname)) return false;
  // Same file: the hash decides between Gesture demo and Practice.
  return target.hash ? here.hash === target.hash : !/^#try=practice/.test(here.hash);
}

function linkList(cls) {
  const ul = document.createElement('ul');
  ul.className = cls;
  for (const p of PAGES) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = new URL(p.href, ROOT).href;
    a.textContent = p.label;
    a.dataset.page = p.id;
    if (isCurrent(p)) a.setAttribute('aria-current', 'page');
    li.append(a);
    ul.append(li);
  }
  return ul;
}

// One disclosure pattern for both modes: a button toggling aria-expanded + a panel.
function disclosure(button, panel, onOpen) {
  const open = (on) => {
    if (on && onOpen) onOpen();
    button.setAttribute('aria-expanded', String(on));
    panel.classList.toggle('open', on);
  };
  button.addEventListener('click', () => open(button.getAttribute('aria-expanded') !== 'true'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && button.getAttribute('aria-expanded') === 'true') { open(false); button.focus(); }
  });
  document.addEventListener('click', (e) => {
    if (!button.contains(e.target) && !panel.contains(e.target)) open(false);
  });
  // Moving focus out of the panel by Tab closes it, so it never hides content behind it.
  panel.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !panel.contains(e.relatedTarget) && e.relatedTarget !== button) open(false);
  });
}

function injectStyle() {
  if (document.getElementById('snav-style')) return;
  const s = document.createElement('style');
  s.id = 'snav-style';
  s.textContent = `
.snav { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; gap: 12px;
  min-height: 56px; padding: 0 max(16px, env(safe-area-inset-left)); background: var(--nav-bg, rgba(10,13,17,.86));
  border-bottom: 1px solid var(--line, #1d2935); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  font: 15px/1.4 var(--sans, system-ui, sans-serif); }
.snav-brand { font-weight: 700; letter-spacing: .02em; color: var(--text, #d6e4ef); text-decoration: none; white-space: nowrap; }
.snav-brand span { color: var(--accent, #4fd1ff); }
.snav-links { display: flex; gap: 4px; margin: 0 0 0 auto; padding: 0; list-style: none; }
.snav a { color: var(--muted, #8196a8); text-decoration: none; }
.snav-links a, .snav-drop a { display: block; white-space: nowrap; padding: 8px 10px; border-radius: 6px; }
.snav a:hover, .snav-drop a:hover { color: var(--text, #d6e4ef); background: var(--accent-soft, rgba(79,209,255,.12)); }
.snav a[aria-current="page"], .snav-drop a[aria-current="page"] { color: var(--text, #d6e4ef); box-shadow: inset 0 -2px 0 var(--accent, #4fd1ff); }
.snav button, .snav-c > button { height: 36px; min-width: 36px; padding: 0 10px; border-radius: 6px; cursor: pointer;
  color: var(--text, #d6e4ef); background: transparent; border: 1px solid var(--line-2, #2a3a4a); font: inherit; }
.snav a:focus-visible, .snav button:focus-visible, .snav-c > button:focus-visible, .snav-drop a:focus-visible {
  outline: 2px solid var(--accent, #4fd1ff); outline-offset: 2px; }
.snav-src { white-space: nowrap; }
.snav-menu { display: none; }
.snav-drop { display: none; position: absolute; right: 0; top: calc(100% + 6px); min-width: 200px; margin: 0; padding: 6px;
  list-style: none; background: var(--panel, #10161d); border: 1px solid var(--line-2, #2a3a4a); border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0,0,0,.35); z-index: 60; }
.snav-drop.open { display: block; }
.snav-drop a { color: var(--text, #d6e4ef); text-decoration: none; font: 14px/1.4 var(--sans, system-ui, sans-serif); }
.snav-c { position: relative; display: inline-flex; }
.snav-c > button { height: 30px; font-size: 13px; }
.snav-wrap { position: relative; display: flex; align-items: center; gap: 8px; margin-left: auto; }
@media (max-width: 900px) {
  .snav-links, .snav-src { display: none; }
  .snav-menu { display: inline-flex; align-items: center; }
}
@media (min-width: 901px) { .snav-wrap > .snav-drop { display: none !important; } }
@media (prefers-reduced-motion: no-preference) { .snav a, .snav button { transition: background .15s, color .15s; } }
`;
  document.head.append(s);
}

function mountFull() {
  const header = document.createElement('header');
  header.className = 'snav';
  const brand = document.createElement('a');
  brand.className = 'snav-brand';
  brand.href = new URL('index.html', ROOT).href;
  brand.innerHTML = 'Hologram <span>Workshop</span>';
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Site');
  nav.style.cssText = 'display:contents';
  nav.append(linkList('snav-links'));

  const wrap = document.createElement('div');
  wrap.className = 'snav-wrap';
  const src = document.createElement('a');
  src.className = 'snav-src';
  src.href = SOURCE;
  src.rel = 'noopener';
  src.textContent = 'Source';
  const theme = document.createElement('button');
  theme.className = 'snav-theme';
  theme.type = 'button';
  theme.addEventListener('click', () => setTheme(readTheme() === 'light' ? 'dark' : 'light'));
  const menu = document.createElement('button');
  menu.className = 'snav-menu';
  menu.type = 'button';
  menu.textContent = 'Menu';
  menu.setAttribute('aria-expanded', 'false');
  const drop = linkList('snav-drop');
  drop.id = 'snav-drop';
  menu.setAttribute('aria-controls', drop.id);
  wrap.append(src, theme, menu, drop);
  disclosure(menu, drop);

  header.append(brand, nav, wrap);
  document.body.prepend(header);
  setTheme(readTheme());
}

function mountCompact(slot) {
  slot.classList.add('snav-c');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost';
  btn.textContent = 'Menu ▾';
  btn.title = 'Other pages of the site';
  btn.setAttribute('aria-expanded', 'false');
  const drop = linkList('snav-drop');
  drop.id = 'snav-drop';
  btn.setAttribute('aria-controls', drop.id);
  slot.append(btn, drop);
  // App top bars scroll sideways (overflow-x: auto), which would clip an absolute dropdown,
  // so the compact menu is fixed and placed under its button each time it opens.
  disclosure(btn, drop, () => {
    const r = btn.getBoundingClientRect();
    drop.style.position = 'fixed';
    drop.style.top = `${Math.round(r.bottom + 6)}px`;
    drop.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - 216)))}px`;
    drop.style.right = 'auto';
  });
}

injectStyle();
const slot = document.getElementById('site-nav');
if (slot) mountCompact(slot); else mountFull();
window.siteNav = { mode: slot ? 'compact' : 'full', pages: PAGES, setTheme };

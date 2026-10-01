// testguide.js — the guided-test dock on the page under test (shadow site only).
//
// Why: the owner asked for a guided way to run through every function, with a prompt per
// step and a line on how to tell "working" from "the known bug". The hub (guide.html) lists
// the steps; this dock shows the current one on the page itself, so he never has to switch
// windows to read what to do next. Steps and saved progress live in testguide-steps.js.
//
// SCOPE: loaded only by sessionrec.js (itself loaded only on localhost / 127.0.0.1), and
// only while a guided run is active (started from guide.html). The public site never
// downloads it; mountGuide() re-checks the hostname anyway. It edits no app module.
//
// ---------------------------------------------------------------------------------------
// CONTRACT
//   mountGuide({ page }) -> { el, refresh(), destroy() } | null
//     page  'hologram' | 'platform' | 'hands' (testguide-steps.js PAGES key) or null.
//     Returns null off-localhost, inside an iframe, when no guided run is active, or when a
//     dock is already mounted in this document.
//   Events (window): 'testguide:verdict' { id, verdict 'pass'|'fail'|'unsure'|null, kind,
//     stepPage, onPage, t } on every Pass / Fail / Unsure press (null = cleared). The note
//     text is NOT in the event: sessionrec.js never stores typed text; notes stay in
//     localStorage and go into the guide run saved from guide.html.
//   window.__testguide = { dock, state() }  for checks.
//
// Rules kept here: static UI, no animation or blinking (photosafety, BUGS #14); plain words;
// keys typed into the note box never reach the page's shortcuts; pointer events on the dock
// never reach the page (ring dismiss, canvas picking).
// ---------------------------------------------------------------------------------------

import {
  PAGES, KINDS, SECTIONS, TOUR_SECTIONS, RUN_STEPS, STATE_KEY, stepById, loadState, saveState, setVerdict, setAnswer, move, counts
} from './testguide-steps.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const NOTE_SAVE_MS = 400;

const CSS = `
#testguide { position: fixed; left: 10px; bottom: calc(var(--status-h, 28px) + 10px); z-index: 99997;
  width: min(340px, calc(100vw - 20px)); max-height: min(70vh, 560px); overflow: auto; box-sizing: border-box;
  font: 12.5px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #d6e4ef;
  background: rgba(12, 17, 23, 0.96); border: 1px solid #2a3a4a; border-radius: 6px; padding: 10px 12px; }
#testguide * { box-sizing: border-box; }
#testguide .tg-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
#testguide .tg-head strong { flex: 1; font-size: 12px; color: #8196a8; font-weight: 600; }
#testguide button { font: inherit; color: #d6e4ef; background: #0c1117; border: 1px solid #2a3a4a; border-radius: 5px;
  padding: 3px 9px; cursor: pointer; }
#testguide button:hover { border-color: #4fd1ff; }
#testguide button[aria-pressed="true"] { border-color: #4fd1ff; background: rgba(79, 209, 255, 0.16); }
#testguide button.tg-pass[aria-pressed="true"] { border-color: #7fd6a1; background: rgba(127, 214, 161, 0.18); }
#testguide button.tg-fail[aria-pressed="true"] { border-color: #ff7a7a; background: rgba(255, 122, 122, 0.18); }
#testguide button.tg-unsure[aria-pressed="true"] { border-color: #ffd166; background: rgba(255, 209, 102, 0.16); }
#testguide .tg-chip { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 4px; border: 1px solid #2a3a4a; color: #8196a8; }
#testguide .tg-chip.k-known { color: #ffd166; border-color: #6b5a2a; }
#testguide .tg-chip.k-live { color: #4fd1ff; border-color: #24576b; }
#testguide .tg-chip.k-regress { color: #7fd6a1; border-color: #2c5a3e; }
#testguide h3 { margin: 6px 0 6px; font-size: 14px; }
#testguide dl { margin: 0; }
#testguide dt { font-weight: 600; margin-top: 6px; font-size: 11.5px; color: #8196a8; }
#testguide dd { margin: 1px 0 0; }
#testguide dd.tg-correct { color: #bfe9cf; }
#testguide dd.tg-bug { color: #ffc2c2; }
#testguide .tg-away { margin: 8px 0 0; padding: 6px 8px; border: 1px dashed #6b5a2a; border-radius: 5px; color: #ffd166; }
#testguide .tg-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
#testguide textarea { width: 100%; min-height: 44px; margin-top: 8px; resize: vertical; font: inherit; color: #d6e4ef;
  background: #0c1117; border: 1px solid #2a3a4a; border-radius: 5px; padding: 5px 7px; }
#testguide .tg-foot { margin-top: 8px; font-size: 11px; color: #56687a; }
#testguide a { color: #4fd1ff; }
#testguide.tg-min { width: auto; padding: 4px 6px; overflow: visible; }
`;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
}

export function mountGuide({ page = null } = {}) {
  if (typeof window === 'undefined' || !LOCAL_HOSTS.includes(location.hostname)) return null;
  if (window.top !== window) return null;
  if (document.getElementById('testguide')) return null;
  let state = loadState(localStorage);
  if (!state.active) return null;

  const root = new URL('./', import.meta.url);   // repo root: step urls are relative to it
  const hubUrl = new URL('guide.html', root).href;
  const style = el('style', { id: 'testguide-style', text: CSS });
  const dock = el('section', { id: 'testguide', role: 'complementary', 'aria-label': 'Guided test' });
  document.head.append(style);
  document.body.append(dock);

  // The dock is part of the test, not of the app: keep its pointer events away from the
  // page's own handlers (ring dismiss, canvas picks), like the SHADOW badge does.
  for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'click', 'wheel', 'dblclick']) dock.addEventListener(ev, (e) => e.stopPropagation());
  // Typing a note must not fire P / T / Delete / I on the page. The pages already ignore keys
  // from text fields; stopping here as well covers any handler that forgets to.
  for (const ev of ['keydown', 'keyup', 'keypress']) dock.addEventListener(ev, (e) => { if (e.target.matches?.('textarea')) e.stopPropagation(); });

  // 'testguide:changed' lets a host page that shows the same answers (guide.html in tour mode) refresh.
  const persist = () => { const ok = saveState(localStorage, state); window.dispatchEvent(new CustomEvent('testguide:changed')); return ok; };
  let noteTimer = 0;

  function announce(id, verdict) {
    const s = stepById(id);
    window.dispatchEvent(new CustomEvent('testguide:verdict', {
      detail: { id, verdict, kind: s.kind, stepPage: s.page, onPage: page, t: Date.now() }
    }));
  }

  // Buttons give the focus back to the page after a press, so the next shortcut key the
  // owner presses (P, T, Delete) goes to the app, not to a focused dock button.
  const act = (fn) => (e) => { fn(e); e.currentTarget?.blur?.(); };

  function render() {
    clearTimeout(noteTimer);
    dock.replaceChildren();
    const c = counts(state);
    const idx = Math.max(0, RUN_STEPS.findIndex((s) => s.id === state.cursor));
    const step = RUN_STEPS[idx];
    const res = state.results[step.id];
    dock.classList.toggle('tg-min', !!state.minimised);

    if (state.minimised) {
      dock.append(el('button', {
        title: 'Show the guided test', 'aria-expanded': 'false',
        onclick: act(() => { state = { ...state, minimised: false }; persist(); render(); })
      }, `Guide ${idx + 1}/${RUN_STEPS.length} · ${step.id} ▸`));
      return;
    }

    const tourMode = state.mode === 'tour';
    const section = (tourMode ? TOUR_SECTIONS : SECTIONS).find((s) => s.id === step.section)?.label || '';
    dock.append(el('div', { class: 'tg-head' },
      el('strong', { text: `${tourMode ? 'Tester tour' : 'Guided test'} · step ${idx + 1} of ${RUN_STEPS.length} · ${section}` }),
      el('a', { href: hubUrl, title: 'All steps and the end summary' }, 'Hub'),
      el('button', {
        title: 'Make the guide small', 'aria-expanded': 'true',
        onclick: act(() => { state = { ...state, minimised: true }; persist(); render(); })
      }, '–')
    ));

    dock.append(el('div', {},
      el('span', { class: `tg-chip k-${step.kind}`, title: KINDS[step.kind].hint }, KINDS[step.kind].label),
      ' ', el('span', { class: 'tg-chip', title: 'Where this comes from' }, `${step.id} · ${step.ref}`)
    ));
    dock.append(el('h3', { text: step.title }));
    const rows = tourMode
      ? [['What to do', step.action], ['✓ You should see', step.correct, 'tg-correct'], ["Tip if it doesn't work", step.tell]]
      : [['Do this', step.action], ['✓ Correct looks like', step.correct, 'tg-correct'], ['✗ The bug looks like', step.bug, 'tg-bug'], ['How to tell them apart', step.tell]];
    dock.append(el('dl', {}, ...rows.filter((r) => r[1]).flatMap(([dt, dd, cls]) => [el('dt', { text: dt }), el('dd', { class: cls, text: dd })])));

    if (step.page && step.page !== page) {
      const target = PAGES[step.page];
      dock.append(el('div', { class: 'tg-away' },
        `This step is on the ${target.label} page. `,
        el('a', { href: new URL(target.url, root).href, target: target.dock === false ? '_blank' : null, rel: target.dock === false ? 'noopener' : null }, `Open ${target.label}${target.dock === false ? ' in a new tab' : ''}`)
      ));
    }

    const note = el('textarea', { placeholder: step.kind === 'free' ? 'What was confusing? What did you love?' : 'Note (optional): what you saw, numbers, how it felt', 'aria-label': `Note for ${step.id}` });
    if (step.kind === 'rate') {
      // One tap, 1 (hard) to 5 (easy). Pressing the chosen number again clears it.
      dock.append(el('div', { class: 'tg-row' }, ...[1, 2, 3, 4, 5].map((n) => el('button', {
        'aria-pressed': String(res?.rating === n), title: `${n} of 5`,
        onclick: act(() => { state = setAnswer(state, step.id, { rating: res?.rating === n ? null : n }); persist(); render(); })
      }, String(n)))));
      dock.append(el('div', { class: 'tg-foot', text: '1 = very hard · 5 = very easy' }));
    } else {
      note.value = res?.note || state.drafts?.[step.id] || '';
      const verdictBtn = (v, label, cls) => el('button', {
        class: cls, 'aria-pressed': String(res?.verdict === v),
        title: res?.verdict === v ? 'Press again to clear' : `Mark ${step.id} as ${label}`,
        onclick: act(() => {
          const next = res?.verdict === v ? null : v;
          state = setVerdict(state, step.id, next, note.value);
          persist(); announce(step.id, next); render();
        })
      }, label);
      if (step.kind !== 'free') dock.append(el('div', { class: 'tg-row' },
        verdictBtn('pass', 'Pass', 'tg-pass'), verdictBtn('fail', 'Fail', 'tg-fail'), verdictBtn('unsure', 'Unsure', 'tg-unsure')));
      // Notes are saved as you type (a draft until a verdict is pressed), so a reload or a page
      // hop never loses them. The closing free-text answer is saved as the answer itself.
      note.addEventListener('input', () => {
        clearTimeout(noteTimer);
        noteTimer = setTimeout(() => {
          const r = state.results[step.id];
          if (step.kind === 'free') state = setAnswer(state, step.id, { note: note.value });
          else state = r ? { ...state, results: { ...state.results, [step.id]: { ...r, note: note.value.slice(0, 1000) } } }
            : { ...state, drafts: { ...(state.drafts || {}), [step.id]: note.value.slice(0, 1000) } };
          persist();
        }, NOTE_SAVE_MS);
      });
      dock.append(note);
    }

    const last = idx === RUN_STEPS.length - 1;
    dock.append(el('div', { class: 'tg-row' },
      el('button', { disabled: idx === 0 ? '' : null, onclick: act(() => { state = move(state, -1); persist(); render(); }) }, '◂ Previous'),
      last ? el('a', { href: hubUrl }, 'Finish: open the summary')
        : el('button', { onclick: act(() => { state = move(state, 1); persist(); render(); }) }, 'Next ▸')
    ));
    dock.append(el('div', { class: 'tg-foot', text: `Pass ${c.pass} · Fail ${c.fail} · Unsure ${c.unsure} · Not run ${c.notRun}. Saved on this computer as you go.` }));
  }
  // Another tab (the hub, or this page in a second window) changed the run: follow it.
  const onStorage = (e) => {
    if (e.key !== STATE_KEY) return;
    state = loadState(localStorage);
    if (!state.active) { api.destroy(); return; }
    render();
  };
  window.addEventListener('storage', onStorage);

  const api = {
    el: dock,
    refresh() { state = loadState(localStorage); render(); },
    destroy() { window.removeEventListener('storage', onStorage); dock.remove(); style.remove(); if (window.__testguide?.dock === api) window.__testguide = null; }
  };
  window.__testguide = { dock: api, state: () => state };
  render();
  return api;
}

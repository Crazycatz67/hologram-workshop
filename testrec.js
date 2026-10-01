// testrec.js — automatic run recorder for TEST / LAB / PROBE pages only.
//
// Why: the owner was copy-pasting lab results into chat, and regressions (a check that
// silently disappeared, a console error nobody looked at) were only noticed when someone
// asked. Every run of a wired test page now saves its full record to
// docs/testing/runs/<page>/ through serve.py, and serve.py flags what changed.
//
// SCOPE (non-negotiable, see docs/testing/README.md): production pages (index.html, viewer.html,
// hologram.html, hands.html, platform/index.html) must never import this file. On any host
// other than localhost / 127.0.0.1 / [::1] the recorder makes NO network request at all; it
// keeps the record in memory and offers a "download run" button. No images, video or camera
// frames are ever stored; typed arrays (raw streams) only when the page passes rawStreams:true.
//
// ---------------------------------------------------------------------------------------
// CONTRACT
//   startRun({ page, title, tolerances?, fpsFloor?, rawStreams = false, timingSensitive = false,
//              settings?, timeoutMs = 600000 }) -> rec
//     page        id for the run folder: [A-Za-z0-9._-], 1..80 chars, no leading dot
//                 (anything else is slugified). Use one id per comparable variant, e.g.
//                 'parts-test-glb', so history comparisons compare like with like.
//     tolerances  { metricName | '*': rel | { abs?, rel? } } — a metric (or numeric result
//                 value) that moves more than max(abs, rel*|previous|) vs the previous run
//                 is flagged by the server. Undeclared metrics are never flagged.
//     fpsFloor    flag when the recorded fps (metric 'fps') is below this.
//     timingSensitive  flag when the tab was hidden at any point of the run (browsers
//                 throttle timers/rAF in hidden tabs, so timings are not comparable).
//     timeoutMs   a run not ended by then is ended with status 'timeout' (0 = never).
//   rec.result(name, value, { pass?, expect? })  one check. pass omitted + expect given ->
//                 pass = (JSON of value === JSON of expect). pass omitted, no expect -> info row.
//   rec.metric(name, number)   a number to track over runs; 'fps' also sets record.fps.
//   rec.flag(kind, message)    a page-raised flag (kept as-is by the server).
//   rec.attach(key, data)      JSON-able extra data (report objects, tables). Refuses images /
//                 video / Blobs always, typed arrays unless rawStreams.
//   rec.end(status = 'done')   finishes the run ('done' | 'failed' | 'crashed' | any string;
//                 anything but 'done' is flagged "ended early"). Returns a Promise of
//                 { saved: 'server' | 'local' | 'memory', path?, flags }. Idempotent.
//   window.__testrec = { current, last, download(), pending() }
//
// RECORD (schema 1) — what end() sends to POST /__testrun:
//   { schema, page, title, url (path+query, no host), status, startedAt, endedAt, durationMs,
//     commit, dirty, browser, platform, screen {w,h,dpr}, viewport {w,h}, fps, fpsFloor,
//     timingSensitive, rawStreams, settings, tolerances, results [{name,value,pass?,expect?}],
//     metrics {name:number}, summary {checks,passed,failed,info}, consoleErrors [{t,msg}],
//     warnings [{t,msg}], visibility [{t,state}], attachments {}, flags [{kind,message,source}] }
//   flags with source 'recorder' are the ones computable without history; serve.py recomputes
//   all automatic flags (it alone knows the previous run) and keeps only source 'page' ones.
// ---------------------------------------------------------------------------------------

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MAX_LOG = 200;          // console entries kept per run; a runaway loop must not blow the body cap
const MAX_MSG = 2000;         // chars per console entry
const MAX_BODY = 4.5e6;       // stay under serve.py's 5 MB cap, with room for its added flags
const PENDING_KEY = 'testrec:pending';
const PENDING_MAX = 5;

const hasWindow = typeof window !== 'undefined' && typeof document !== 'undefined';
export const isLocal = hasWindow && LOCAL_HOSTS.has(location.hostname);

function slug(s) {
  const out = String(s ?? 'page').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
  return out || 'page';
}

function textOf(args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || String(a);
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, MAX_MSG);
}

// Images, video and camera frames never go into a record (privacy scope); typed arrays are
// "raw streams" and need the page's explicit opt-in.
function refusal(data, rawStreams) {
  const isA = (name) => typeof globalThis[name] === 'function' && data instanceof globalThis[name];
  if (['Blob', 'ImageData', 'ImageBitmap', 'HTMLCanvasElement', 'HTMLVideoElement', 'HTMLImageElement',
    'OffscreenCanvas', 'MediaStream', 'VideoFrame'].some(isA)) return 'images/video/blobs are never recorded';
  if (!rawStreams && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) return 'raw streams need startRun({ rawStreams: true })';
  return null;
}

const timeout = (ms) => new Promise((r) => setTimeout(r, ms));

function readPending() {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; }
}
function keepLocally(record) {
  try {
    const list = [record, ...readPending()].slice(0, PENDING_MAX);
    localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    return true;
  } catch { return false; } // private window / quota / blocked storage: memory + download only
}

function download(record) {
  if (!record || !hasWindow) return false;
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${record.page}_${(record.startedAt || '').replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

function showDownloadButton(why) {
  if (!hasWindow || !document.body || document.getElementById('testrec-download')) return;
  const b = document.createElement('button');
  b.id = 'testrec-download';
  b.textContent = 'download run';
  b.title = why;
  b.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:99999;font:12px ui-monospace,monospace;' +
    'color:#dff6ff;background:#123;border:1px solid #2a4a66;border-radius:4px;padding:4px 10px;cursor:pointer';
  b.addEventListener('click', () => download(window.__testrec?.last));
  document.body.appendChild(b);
}

// Flags that need no history. serve.py computes the same ones (plus history flags) and is
// authoritative for saved runs; these make downloaded / localStorage records useful too.
function localFlags(r) {
  const f = [];
  for (const x of r.results) if (x.pass === false) f.push({ kind: 'fail', message: `${x.name}: ${short(x.value)}` });
  if (r.consoleErrors.length) f.push({ kind: 'console-error', message: `${r.consoleErrors.length} console error(s); first: ${r.consoleErrors[0].msg.split('\n')[0].slice(0, 200)}` });
  if (r.status !== 'done') f.push({ kind: 'ended-early', message: `run ended with status '${r.status}'` });
  if (r.fpsFloor != null && typeof r.fps === 'number' && r.fps < r.fpsFloor) f.push({ kind: 'low-fps', message: `fps ${r.fps} < floor ${r.fpsFloor}` });
  if (r.timingSensitive && r.visibility.some((v) => v.state === 'hidden')) f.push({ kind: 'hidden-tab', message: 'tab hidden during a timing-sensitive run' });
  return f.map((x) => ({ ...x, source: 'recorder' }));
}
function short(v) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  return s === undefined ? '' : s.length > 160 ? s.slice(0, 157) + '...' : s;
}

let commitPromise = null;
function fetchCommit() {
  if (!isLocal) return Promise.resolve(null);
  commitPromise ??= fetch('/__commit', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return commitPromise;
}

export function startRun({
  page, title = '', tolerances = {}, fpsFloor = null, rawStreams = false, timingSensitive = false,
  settings = {}, timeoutMs = 600000
} = {}) {
  const t0 = hasWindow ? performance.now() : Date.now();
  const rel = () => Math.round((hasWindow ? performance.now() : Date.now()) - t0);
  const record = {
    schema: 1,
    page: slug(page),
    title: String(title || (hasWindow ? document.title : '')),
    url: hasWindow ? location.pathname + location.search : '',
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null, durationMs: null,
    commit: null, dirty: null,
    browser: hasWindow ? navigator.userAgent : '',
    platform: hasWindow ? (navigator.userAgentData?.platform || navigator.platform || '') : '',
    screen: hasWindow ? { w: screen.width, h: screen.height, dpr: devicePixelRatio } : null,
    viewport: hasWindow ? { w: innerWidth, h: innerHeight } : null,
    fps: null, fpsFloor, timingSensitive: !!timingSensitive, rawStreams: !!rawStreams,
    settings, tolerances,
    results: [], metrics: {}, summary: null,
    consoleErrors: [], warnings: [],
    visibility: hasWindow ? [{ t: 0, state: document.visibilityState }] : [],
    attachments: {}, flags: []
  };
  const commit = fetchCommit();
  let ended = null;

  // ---- automatic capture (undone in end()) -------------------------------------------
  const undo = [];
  if (hasWindow) {
    const origError = console.error, origWarn = console.warn;
    const push = (list, args) => { if (list.length < MAX_LOG) list.push({ t: rel(), msg: textOf(args) }); };
    const ourError = function (...args) { push(record.consoleErrors, args); return origError.apply(this, args); };
    const ourWarn = function (...args) { push(record.warnings, args); return origWarn.apply(this, args); };
    console.error = ourError;
    console.warn = ourWarn;
    const onError = (e) => push(record.consoleErrors, [`uncaught: ${e.message || e.type}${e.filename ? ` (${e.filename.split('?')[0]}:${e.lineno})` : ''}`]);
    const onRejection = (e) => push(record.consoleErrors, ['unhandled rejection:', e.reason]);
    const onVis = () => { if (record.visibility.length < MAX_LOG) record.visibility.push({ t: rel(), state: document.visibilityState }); };
    // A page closed or navigated before end(): send what we have, marked incomplete. Beacon
    // because a normal fetch is cancelled during unload.
    const onHide = () => {
      if (ended) return;
      finalize('incomplete');
      if (isLocal) {
        const body = JSON.stringify(record);
        if (body.length > MAX_BODY || !navigator.sendBeacon('/__testrun', new Blob([body], { type: 'application/json' }))) keepLocally(record);
      }
    };
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onRejection);
    document.addEventListener('visibilitychange', onVis);
    addEventListener('pagehide', onHide);
    undo.push(() => {
      // Only restore if nobody wrapped console after us; otherwise leave their wrapper intact.
      if (console.error === ourError) console.error = origError;
      if (console.warn === ourWarn) console.warn = origWarn;
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onRejection);
      document.removeEventListener('visibilitychange', onVis);
      removeEventListener('pagehide', onHide);
    });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => { if (!ended) rec.end('timeout'); }, timeoutMs) : null;

  function finalize(status) {
    record.status = String(status || 'done');
    record.endedAt = new Date().toISOString();
    record.durationMs = rel();
    const checks = record.results.filter((r) => typeof r.pass === 'boolean');
    const failed = checks.filter((r) => !r.pass).length;
    record.summary = { checks: checks.length, passed: checks.length - failed, failed, info: record.results.length - checks.length };
    record.flags = [...record.flags.filter((f) => f.source === 'page'), ...localFlags(record)];
  }

  const rec = {
    record,
    result(name, value, { pass, expect } = {}) {
      if (ended) return rec;
      const row = { name: String(name), value };
      if (expect !== undefined) row.expect = expect;
      if (typeof pass === 'boolean') row.pass = pass;
      else if (expect !== undefined) row.pass = short(value) === short(expect);
      record.results.push(row);
      return rec;
    },
    metric(name, n) {
      if (ended) return rec;
      const v = Number(n);
      if (!Number.isFinite(v)) { record.warnings.push({ t: rel(), msg: `testrec: metric ${name} is not a finite number (${n})` }); return rec; }
      record.metrics[String(name)] = v;
      if (name === 'fps') record.fps = v;
      return rec;
    },
    flag(kind, message) {
      if (!ended) record.flags.push({ kind: String(kind), message: String(message), source: 'page' });
      return rec;
    },
    attach(key, data) {
      if (ended) return rec;
      const why = refusal(data, record.rawStreams);
      if (why) { record.warnings.push({ t: rel(), msg: `testrec: attachment '${key}' refused: ${why}` }); return rec; }
      try { record.attachments[String(key)] = JSON.parse(JSON.stringify(data)); }
      catch (e) { record.warnings.push({ t: rel(), msg: `testrec: attachment '${key}' not JSON-able: ${e.message}` }); }
      return rec;
    },
    end(status = 'done') {
      if (ended) return ended;
      if (timer) clearTimeout(timer);
      finalize(status);
      undo.forEach((fn) => fn());
      ended = (async () => {
        const c = await Promise.race([commit, timeout(1500).then(() => null)]);
        if (c) { record.commit = c.commit; record.dirty = c.dirty; }
        let body = JSON.stringify(record);
        if (body.length > MAX_BODY) {
          record.attachments = { dropped: `attachments removed: record was ${body.length} bytes (> ${MAX_BODY})` };
          record.flags.push({ kind: 'oversize', message: 'attachments dropped to fit the 5 MB cap', source: 'recorder' });
          body = JSON.stringify(record);
        }
        if (hasWindow) window.__testrec.last = record;
        if (!isLocal) { showDownloadButton('Not on localhost: this run was kept in memory only.'); return { saved: 'memory', flags: record.flags }; }
        try {
          const res = await fetch('/__testrun', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const out = await res.json();
          record.flags = out.flags ?? record.flags;
          return { saved: 'server', path: out.path, flags: record.flags };
        } catch (e) {
          // Endpoint missing (an old serve.py, or a different static server): keep it locally.
          const kept = keepLocally(record);
          showDownloadButton(`Could not save to the dev server (${e.message}); ${kept ? 'kept in localStorage' : 'kept in memory'}.`);
          return { saved: kept ? 'local' : 'memory', flags: record.flags };
        }
      })();
      return ended;
    }
  };
  if (hasWindow) {
    window.__testrec ??= { last: null, download: () => download(window.__testrec.last ?? window.__testrec.current?.record), pending: readPending };
    window.__testrec.current = rec;
  }
  return rec;
}

// Project library checks.
//
//   A. store.js on its own (DB hologram-library-test-unit, a fake clock): CRUD, sha256 dedupe,
//      refCount freeing, soft delete / restore / 30-day purge, the version chain, checkout,
//      fork, thumbnails + object-URL revoking, the quota error path (simulated full disk),
//      idempotent sample seeding.
//   B. The real app (index.html in an iframe, DB hologram-library-test-app, a recording stub
//      ring): first-visit landing, sample thumbnails, upload -> project, debounced autosave,
//      Ctrl/Cmd+S, the round trip (save -> switch away -> reopen -> same transforms + undo
//      works), opening an older version, a failed open keeping the current project, delete /
//      restore through ring actions, and 0 console errors.
//
// Both databases (and the test's localStorage key) are deleted at the end.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const V = new URL(import.meta.url).search;
const { openStore, deleteStore, StoreQuotaError } = await import('./store.js' + V);

const out = document.getElementById('out');
out.textContent = '';
const log = (s) => { out.textContent += s + '\n'; };
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
async function throwsLike(fn, test) {
  try { await fn(); return false; } catch (e) { return test(e); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 50) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');

const UNIT_DB = 'hologram-library-test-unit';
const APP_DB = 'hologram-library-test-app';
await deleteStore(UNIT_DB);
await deleteStore(APP_DB);

// ---- A. store.js -----------------------------------------------------------------------------
log('-- A. store.js');
let clock = Date.UTC(2026, 9, 1);
let fault = null;
const store = await openStore({ name: UNIT_DB, now: () => clock, autoPersist: false, faults: { beforeWrite: () => { if (fault) throw fault; } } });

const bytesA = new Blob(['abc'], { type: 'text/plain' });
const shaA = await store.putBlob(bytesA, { name: 'a.txt' });
check('A1 putBlob returns the sha256 hex of the bytes', shaA === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', shaA.slice(0, 16));
const shaA2 = await store.putBlob(new Blob(['abc']), { name: 'copy.txt' });
const infoA = await store.getBlobInfo(shaA);
check('A2 same bytes are stored once (dedupe)', shaA2 === shaA && infoA.name === 'a.txt' && infoA.refCount === 0, `refCount ${infoA.refCount}`);
check('A3 getBlob returns the same bytes', await (await store.getBlob(shaA)).text() === 'abc');
const shaB = await store.putBlob(new Blob(['only-in-p1']), { name: 'b.bin' });

const layout0 = { version: 2, items: [{ id: 1, name: 'a.txt', transform: { position: [0, 0, 0] } }], edits: [] };
const p1 = await store.createProject({ title: 'Room', kind: 'scene', sources: [{ sha: shaA, name: 'a.txt' }, { sha: shaB, name: 'b.bin' }], layout: layout0 });
let list = await store.listProjects();
const e1 = list.find((x) => x.project.id === p1.id);
check('A4 createProject makes an original + a working copy (working last)',
  e1 && e1.versions.length === 2 && e1.versions[0].type === 'original' && e1.versions[1].type === 'working' && e1.versions[1].parentId === e1.versions[0].id,
  e1?.versions.map((v) => v.type).join(','));
check('A5 summaries carry no layout', e1 && !('layout' in e1.versions[0]) && e1.versions[0].items === 1);
check('A6 refCount counts version records (2 after create)', (await store.getBlobInfo(shaA)).refCount === 2 && (await store.getBlobInfo(shaB)).refCount === 2);

clock += 1000;
const layout1 = { ...layout0, edits: [{ seq: 1, op: 'move' }] };
await store.saveWorking(p1.id, { layout: layout1, stats: { tris: 10 } });
let w = await store.getVersion(p1.workingVersionId);
check('A7 saveWorking overwrites the working copy and marks it unsaved', w.layout.edits.length === 1 && w.dirty === true && w.stats.tris === 10);

clock += 1000;
const v1 = await store.saveVersion(p1.id, { layout: layout1, provenance: { app: 'test' } });
w = await store.getVersion(p1.workingVersionId);
check('A8 saveVersion: default label, parent = working\'s old parent, working continues from it',
  v1.label === 'Version 1' && v1.parentId === p1.originalVersionId && w.parentId === v1.id && w.dirty === false && v1.type === 'edited',
  `${v1.label}, parent ok ${v1.parentId === p1.originalVersionId}`);
clock += 1000;
const layout2 = { ...layout0, edits: [{ seq: 1 }, { seq: 2 }] };
await store.saveWorking(p1.id, { layout: layout2 });
const shaC = await store.putBlob(new Blob(['only-in-p1-v2']), { name: 'c.bin' });
const v2 = await store.saveVersion(p1.id, { label: 'Moved sofa', sources: [{ sha: shaA, name: 'a.txt' }, { sha: shaB, name: 'b.bin' }, { sha: shaC, name: 'c.bin' }] });
check('A9 a second version chains on the first and keeps the working layout', v2.parentId === v1.id && v2.label === 'Moved sofa' && (await store.getVersion(v2.id)).layout.edits.length === 2);
check('A10 every version record references the blobs (original, v1, v2, working = 4)', (await store.getBlobInfo(shaA)).refCount === 4);

clock += 1000;
await store.saveWorking(p1.id, { layout: { ...layout0, edits: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] } });
const wc = await store.checkout(p1.id, p1.originalVersionId);
list = await store.listProjects();
const autoKept = list.find((x) => x.project.id === p1.id).versions.find((v) => v.provenance?.auto);
check('A11 checkout keeps unsaved working edits as a version first, then resets the working copy',
  !!autoKept && autoKept.edits === 3 && wc.parentId === p1.originalVersionId && wc.edits === 0 && wc.dirty === false,
  `kept "${autoKept?.label}" (${autoKept?.edits} edits)`);

// Working copy drops a file: its reference goes, the blob stays (other versions still list it).
await store.saveWorking(p1.id, { sources: [{ sha: shaA, name: 'a.txt' }] });
check('A12 saveWorking sources: dropped file loses one ref, still stored', (await store.getBlobInfo(shaB))?.refCount === 4);

const p2 = await store.fork(p1.id, v1.id);
const w2 = await store.getVersion(p2.workingVersionId);
const base2 = await store.getVersion(w2.parentId);
check('A13 fork: new project, working copy starts from that version, provenance recorded',
  p2.id !== p1.id && p2.title === 'Room (copy)' && w2.layout.edits.length === 1 && base2.provenance.forkedFrom.versionId === v1.id && !p2.sample);
check('A14 fork adds refs (2 more records)', (await store.getBlobInfo(shaA)).refCount === 7, `refCount ${(await store.getBlobInfo(shaA)).refCount}`);

await store.rename(p2.id, '  Studio  ');
check('A15 rename trims; an empty name is refused', (await store.getProject(p2.id)).title === 'Studio' && await throwsLike(() => store.rename(p2.id, '   '), (e) => /name/.test(e.message)));

// Thumbnails
const thumb1 = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
await store.saveWorking(p2.id, { thumbBlob: thumb1 });
const t1 = (await store.getVersion(p2.workingVersionId)).thumbId;
const url1 = await store.thumbUrl(t1);
const url1b = await store.thumbUrl(t1);
const bytes1 = new Uint8Array(await (await fetch(url1)).arrayBuffer());
check('A16 thumbUrl: object URL of the stored thumb, cached', url1.startsWith('blob:') && url1 === url1b && bytes1.join() === '1,2,3');
await store.saveWorking(p2.id, { thumbBlob: new Blob([new Uint8Array([9])], { type: 'image/jpeg' }) });
await sleep(20);
const t2 = (await store.getVersion(p2.workingVersionId)).thumbId;
const revoked = await fetch(url1).then(() => false, () => true);
check('A17 replacing a thumb gives a new id and revokes the old URL', t2 !== t1 && revoked && (await store.thumbUrl(t1)) === null);

// Quota: a simulated full disk on the next write.
const before = await store.getVersion(p2.workingVersionId);
fault = new DOMException('The quota has been exceeded.', 'QuotaExceededError');
let qErr = null;
try { await store.saveWorking(p2.id, { layout: { version: 2, items: [], edits: [{ seq: 99 }] } }); } catch (e) { qErr = e; }
fault = null;
const after = await store.getVersion(p2.workingVersionId);
check('A18 a full disk throws StoreQuotaError (code "quota", says export and remove)',
  qErr instanceof StoreQuotaError && qErr.code === 'quota' && /export/i.test(qErr.message) && /remove/i.test(qErr.message), qErr?.name);
check('A19 the failed write left the working copy unchanged', JSON.stringify(after.layout) === JSON.stringify(before.layout) && after.updatedAt === before.updatedAt);
// A request-level failure inside the transaction is classified the same way.
let qErr2 = null;
try { await store.putBlob(new Blob(['x']), { name: 'x' }); fault = null; } catch (e) { qErr2 = e; }
check('A20 writes succeed again once space is back', qErr2 === null);

// Soft delete / restore / purge
await store.softDelete(p1.id);
list = await store.listProjects();
const listAll = await store.listProjects({ includeDeleted: true });
check('A21 softDelete hides from the list; includeDeleted shows it', !list.some((x) => x.project.id === p1.id) && listAll.some((x) => x.project.id === p1.id && x.project.deletedAt));
check('A22 a deleted project refuses saves', await throwsLike(() => store.saveWorking(p1.id, { layout: layout0 }), (e) => /deleted/.test(e.message)));
await store.restore(p1.id);
check('A23 restore brings it back', (await store.listProjects()).some((x) => x.project.id === p1.id));
await store.softDelete(p1.id);
clock += 29 * 864e5;
let purged = await store.purgeExpired(30);
check('A24 purge keeps projects deleted < 30 days ago', purged.projects === 0 && !!(await store.getProject(p1.id)));
clock += 2 * 864e5;
const shaOrphan = await store.putBlob(new Blob(['orphan']), { name: 'orphan' });
purged = await store.purgeExpired(30);
const infoAAfter = await store.getBlobInfo(shaA);
check('A25 purge after 30 days removes the project and its versions', purged.projects === 1 && purged.versions >= 5 && !(await store.getProject(p1.id)), JSON.stringify(purged));
check('A26 refCount-aware freeing: blob only p1 used is freed; blobs the fork shares stay (2 refs each)',
  !(await store.getBlobInfo(shaC)) && infoAAfter?.refCount === 2 && (await store.getBlobInfo(shaB))?.refCount === 2, `shaA refCount ${infoAAfter?.refCount}`);
check('A27 a fresh unreferenced blob survives the purge', !!(await store.getBlobInfo(shaOrphan)));
clock += 2 * 864e5;
await store.purgeExpired(30);
check('A28 an orphan blob (never referenced) is freed after a day', !(await store.getBlobInfo(shaOrphan)));

// Samples
const seedArgs = { key: 'chair', title: 'Chair', versions: [
  { label: 'Raw', type: 'original', sources: [{ url: '../assets/chair/chair.glb', name: 'chair.glb' }] },
  { label: 'Clean', type: 'edited', sources: [{ url: '../assets/chair/chair_clean.obj', name: 'chair_clean.obj' }] }] };
const s1 = await store.seedSample(seedArgs);
const s2 = await store.seedSample(seedArgs);
const samples = (await store.listProjects({ includeDeleted: true })).filter((x) => x.project.sample);
check('A29 seedSample is idempotent (one project, created once)', s1.created && !s2.created && samples.length === 1 && samples[0].versions.length === 3);
const sv = samples[0].versions;
check('A30 sample versions chain raw -> clean -> working, sources are URLs', sv[0].label === 'Raw' && sv[1].parentId === sv[0].id && sv[2].type === 'working' && sv[2].parentId === sv[1].id && !!sv[2].sources[0].url);
check('A31 a sample is hidden, never deleted', (await store.softDelete(s1.project.id)) === 'hidden');
clock += 400 * 864e5;
await store.purgeExpired(30);
check('A32 purge never removes a sample', !!(await store.getProject(s1.project.id)));
await store.restore(s1.project.id);
check('A33 restore unhides it', (await store.listProjects()).some((x) => x.project.sample));
// BUGS #36: two tabs on one project. The working copy carries a revision; a write based on a
// stale one is refused (nothing written) instead of silently overwriting the other tab's edits.
{
  const shaR = await store.putBlob(new Blob(['rev']), { name: 'r.bin' });
  const pr = await store.createProject({ title: 'Revs', sources: [{ sha: shaR, name: 'r.bin' }], layout: layout0 });
  const wa = await store.saveWorking(pr.id, { layout: layout1, baseRev: 0 });
  const wb = await store.saveWorking(pr.id, { layout: { ...layout1, edits: [{ seq: 9, op: 'tab B' }] }, baseRev: wa.rev });
  const stale = await throwsLike(() => store.saveWorking(pr.id, { layout: layout0, baseRev: wa.rev }), (e) => e.code === 'conflict');
  const kept = await store.getVersion(pr.workingVersionId);
  check('A34 #36 saveWorking: each write bumps rev; a stale baseRev throws code "conflict" and writes nothing',
    wa.rev === 1 && wb.rev === 2 && stale && kept.layout.edits[0].op === 'tab B' && kept.rev === 2, `revs ${wa.rev}, ${wb.rev}`);
  const staleV = await throwsLike(() => store.saveVersion(pr.id, { baseRev: 1 }), (e) => e.code === 'conflict');
  const v = await store.saveVersion(pr.id, { baseRev: 2 });
  check('A35 #36 saveVersion checks the same revision and reports the working copy\'s new one', staleV && v.workingRev === 3);
  await store.softDelete(pr.id);
  check('A36 #36 writing to a project deleted elsewhere throws code "gone"', await throwsLike(() => store.saveWorking(pr.id, { layout: layout0, baseRev: 3 }), (e) => e.code === 'gone'));
}
store.close();
await deleteStore(UNIT_DB);

// ---- B. the app ------------------------------------------------------------------------------
log('-- B. app wiring (index.html in an iframe, stub ring)');
const ringLog = { opened: 0, closed: 0, cards: null, setCount: 0, focus: [], handlers: {} };
window.__hologramRingStub = (opts) => {
  ringLog.opts = opts;
  let open = false;
  return {
    setProjects(cards) { ringLog.cards = cards; ringLog.setCount++; },
    open() { open = true; ringLog.opened++; }, close() { if (open) ringLog.closed++; open = false; },
    toggle() { open = !open; }, isOpen: () => open, focus: (p, v) => ringLog.focus.push([p, v]),
    update() {}, dispose() {},
    on(evt, fn) { (ringLog.handlers[evt] ??= []).push(fn); }
  };
};
const emit = (evt, payload) => Promise.all((ringLog.handlers[evt] ?? []).map((fn) => fn(payload)));
try { localStorage.removeItem(`hologram-platform-lastProject:${APP_DB}`); } catch { /* */ }

const frame = document.createElement('iframe');
document.getElementById('frame').append(frame);
const errors = [];
frame.src = `./index.html?db=${APP_DB}&ring=stub&v=${Date.now()}`;
const fw = await until(() => frame.contentWindow?.hologram?.library?.ready && frame.contentWindow, 30000);
fw.addEventListener('error', (e) => errors.push(`error: ${e.message}`));
fw.addEventListener('unhandledrejection', (e) => errors.push(`rejection: ${e.reason?.message ?? e.reason}`));
const origErr = fw.console.error.bind(fw.console);
fw.console.error = (...a) => { errors.push(a.map(String).join(' ')); origErr(...a); };
const H = fw.hologram, L = H.library;
await L.ready;
const S = L.store;

check('B1 first visit lands on the ring', ringLog.opened === 1 && L.state().projectId === null, `opened ${ringLog.opened}`);
const sampleCard = ringLog.cards?.find((c) => c.id === 'sample-chair');
check('B2 ring cards: "Drop your own scan" first, then the sample with 3 versions + working copy',
  ringLog.cards?.[0]?.id === '__new__' && sampleCard?.sample && sampleCard.versions.length === 4 && sampleCard.currentVersionId === sampleCard.versions[3].id,
  `${ringLog.cards?.length} cards`);
check('B3 ring got the contract options', ringLog.opts?.THREE && ringLog.opts.scene && ringLog.opts.camera && ringLog.opts.renderer && ringLog.opts.controls);

const tThumbs = performance.now();
await L.thumbsDone;
const thumbMs = performance.now() - tThumbs + 1500;
const sampleEntry = (await S.listProjects({ includeDeleted: true })).find((x) => x.project.id === 'sample-chair');
const thumbIds = sampleEntry.versions.map((v) => v.thumbId);
let thumbOk = thumbIds.every(Boolean), dims = '';
if (thumbOk) {
  const blob = await (await fetch(await S.thumbUrl(thumbIds[2]))).blob();
  const bmp = await createImageBitmap(blob);
  dims = `${bmp.width}x${bmp.height} ${blob.type} ${(blob.size / 1024).toFixed(1)} KB`;
  // Not a blank frame: some pixels brighter than the background.
  const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
  let lit = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 120) lit++;
  thumbOk = blob.type === 'image/jpeg' && bmp.width === 256 && bmp.height === 256 && lit > 200;
  dims += `, ${lit} lit px`;
}
check('B4 sample thumbnails generated lazily (all 4, 256 px JPEG, not blank)', thumbOk, `${dims}; ~${Math.round(thumbMs)} ms after landing`);

// Upload: two synthetic GLBs (two boxes each, so each splits into two parts).
async function glbFile(name, x, realm = window) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc });
  for (const dx of [0, 0.5]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), mat); m.position.set(x + dx, 0.15, 0); g.add(m); }
  const buf = await new Promise((res, rej) => new GLTFExporter().parse(g, res, rej, { binary: true }));
  // Built in the app's own realm: GLTFLoader's `instanceof ArrayBuffer` fails on another window's buffer.
  return new realm.File([new realm.Uint8Array(new Uint8Array(buf))], name, { type: 'model/gltf-binary' });
}
const files = [await glbFile('boxes-a.glb', 0, fw), await glbFile('boxes-b.glb', 2, fw)];
await fw.loadScanFiles(files);
await until(() => L.state().projectId);
const projId = L.state().projectId;
const proj = projId && await S.getProject(projId);
const shaFileA = await hex(files[0]);
check('B5 an upload creates a project whose files are stored by sha256', !!proj && !proj.sample && (await S.getBlobInfo(shaFileA))?.refCount === 2 && /boxes-a/.test(proj.title), proj?.title);
check('B5b cards carry kind (two 0.8 m box pairs side by side -> object; the sample -> object)',
  await until(() => ringLog.cards?.find((c) => c.id === projId)?.kind === 'object', 4000) && ringLog.cards.find((c) => c.id === 'sample-chair')?.kind === 'object');
check('B6 ring closed on upload and its cards refreshed with the new project', !ringLog.cards || await until(() => ringLog.cards.some((c) => c.id === projId), 3000));

const items = () => [...H.items.values()].filter((i) => i.status === 'ready');
const om = H.objectMode;
const snap = () => items().map((it) => ({ name: it.name, root: om.snapshot(it.root), parts: it.parts.map((p) => om.snapshot(p.mesh)) }));
const maxDiff = (a, b) => {
  let d = 0;
  const cmp = (x, y) => { for (const k of ['position', 'quaternion', 'scale']) for (let i = 0; i < x[k].length; i++) d = Math.max(d, Math.abs(x[k][i] - y[k][i])); if (x.visible !== y.visible) d = Infinity; };
  if (a.length !== b.length) return Infinity;
  a.forEach((x, i) => { const y = b.find((z) => z.name === x.name); if (!y) { d = Infinity; return; } cmp(x.root, y.root); x.parts.forEach((p, j) => cmp(p, y.parts[j])); });
  return d;
};

const [ia, ib] = items();
om.rotateTarget(om.itemKey(ia.id), 0.6);
await sleep(400);   // past the wheel-merge window, so the next one is its own edit
fw.arrangeAll();
await sleep(100);
const beforeLast = snap();
om.setVisible(ib.parts[1].id, false);
const nEdits = H.edits.length;
await sleep(300);
const wEarly = await S.getVersion(proj.workingVersionId);
check('B7 autosave waits for the debounce (not saved 0.3 s after the last edit)', (wEarly.layout?.edits?.length ?? 0) === 0, `${wEarly.layout?.edits?.length ?? 0} edits saved`);
const wSaved = await until(async () => { const v = await S.getVersion(proj.workingVersionId); return v.layout?.edits?.length === nEdits && v; }, 6000);
check('B8 ~2 s later the working copy holds the whole edit log (+ stats, thumbnail)', !!wSaved && wSaved.dirty && wSaved.stats?.items === 2 && !!wSaved.thumbId, `${nEdits} edits`);

fw.dispatchEvent(new fw.KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
const vSaved = await until(async () => (await S.listProjects()).find((x) => x.project.id === projId)?.versions.find((v) => v.label === 'Version 1'), 5000);
check('B9 Ctrl+S saves "Version 1" with a thumbnail; working copy is clean again', !!vSaved && !!vSaved.thumbId && !(await S.getVersion(proj.workingVersionId)).dirty);

const savedState = snap();
// Switch away (the sample), then reopen through the ring's 'choose' event.
await emit('choose', { projectId: 'sample-chair' });
const onSample = L.state().projectId === 'sample-chair' && items().length === 1;
check('B10 choosing the sample swaps the scene to it', onSample, `${items().map((i) => i.name).join(', ')}`);
await emit('choose', { projectId: projId });
const reopened = snap();
const d = maxDiff(savedState, reopened);
check('B11 round trip: reopened scene has the same transforms and hidden parts', L.state().projectId === projId && d < 1e-6, `max diff ${d}`);
check('B12 round trip: the full undo history came back', H.edits.length === nEdits, `${H.edits.length}/${nEdits}`);
om.undo();
const dUndo = maxDiff(beforeLast, snap());
check('B13 undo after reopening steps back exactly one edit', H.edits.length === nEdits - 1 && dUndo < 1e-6, `max diff ${dUndo}`);
await sleep(2600);   // the undo autosaves like any edit

// Open the original version: the working copy (dirty after the undo) is kept as a version first.
await emit('choose', { projectId: projId, versionId: proj.originalVersionId });
const entry = (await S.listProjects()).find((x) => x.project.id === projId);
check('B14 opening an older version: scene back as uploaded, unsaved work kept as a version',
  H.edits.length === 0 && entry.versions.some((v) => v.provenance?.auto) && items().every((it) => it.root.visible && it.parts.every((p) => p.mesh.visible)),
  entry.versions.map((v) => v.label).join(' | '));

// A project whose file can't be fetched: the open fails and the current project stays.
const broken = await S.createProject({ title: 'Broken', sources: [{ url: '../assets/does-not-exist.glb', name: 'does-not-exist.glb' }] });
const keep = snap();
await emit('choose', { projectId: broken.id });
check('B15 a failed open leaves the current project and scene untouched', L.state().projectId === projId && maxDiff(keep, snap()) === 0 && /could not open/.test(fw.document.getElementById('status').textContent));

await emit('action', { type: 'delete', projectId: broken.id });
check('B16 ring delete: soft-deleted, card kept last with a "deleted" badge', ringLog.cards.at(-1).id === broken.id && ringLog.cards.at(-1).badges.includes('deleted'));
await emit('action', { type: 'restore', projectId: broken.id });
check('B17 ring restore', !(await S.getProject(broken.id)).deletedAt);
await emit('action', { type: 'rename', projectId: projId, title: 'Two box scene' });
check('B18 ring rename', (await S.getProject(projId)).title === 'Two box scene' && ringLog.cards.find((c) => c.id === projId)?.title === 'Two box scene');
await emit('action', { type: 'delete', projectId: 'sample-chair' });
check('B19 deleting the sample only hides it', (await S.getProject('sample-chair')).hidden && !(await S.getProject('sample-chair')).deletedAt);
await emit('action', { type: 'restore', projectId: 'sample-chair' });

// ---- data-safety regressions (BUGS #33-#38, #41, #42) ------------------------------------------
const workingOf = async (pid) => S.getVersion((await S.getProject(pid)).workingVersionId);
const snapAll = () => items().map((it) => ({ name: it.name, root: om.snapshot(it.root), parts: it.parts.map((p) => om.snapshot(p.mesh)) }));
const diffByIndex = (a, b) => {   // like maxDiff, but by position: two items may share a name
  if (a.length !== b.length) return Infinity;
  let d = 0;
  const cmp = (x, y) => { for (const k of ['position', 'quaternion', 'scale']) for (let i = 0; i < x[k].length; i++) d = Math.max(d, Math.abs(x[k][i] - y[k][i])); if (x.visible !== y.visible) d = Infinity; };
  a.forEach((x, i) => { if (x.name !== b[i].name) d = Infinity; else { cmp(x.root, b[i].root); x.parts.forEach((p, j) => cmp(p, b[i].parts[j])); } });
  return d;
};
await emit('choose', { projectId: projId });

// #33: an edit, then another project chosen inside the 2 s autosave debounce.
{
  const n0 = (await workingOf(projId)).layout.edits.length;
  om.rotateTarget(om.itemKey(items()[0].id), 0.25);
  const n1 = H.edits.length;
  await emit('choose', { projectId: 'sample-chair' });
  check('B22 #33 an edit followed at once by opening another project is saved first', (await workingOf(projId)).layout.edits.length === n1 && n1 === n0 + 1, `${n0} -> ${(await workingOf(projId)).layout.edits.length} (scene had ${n1})`);
  await emit('choose', { projectId: projId });
}

// #35: an edit to the old scene while the next project is still loading (load-then-swap).
{
  const p = emit('choose', { projectId: 'sample-chair' });
  await until(() => L.state().opening, 2000, 5);
  om.rotateTarget(om.itemKey(items()[0].id), 0.3);
  const n1 = H.edits.length;
  await p;
  check('B23 #35 an edit made while another project loads is saved to the old project', L.state().projectId === 'sample-chair' && (await workingOf(projId)).layout.edits.length === n1, `scene had ${n1}, saved ${(await workingOf(projId)).layout.edits.length}`);
  await emit('choose', { projectId: projId });
}

// #34: two copies of the same file (and the same bytes under another name) in one scene.
{
  await fw.loadScanFiles([await glbFile('boxes-a.glb', 0, fw)]);
  await fw.loadScanFiles([await glbFile('renamed-a.glb', 0, fw)]);
  await until(() => items().length === 4, 5000);
  om.rotateTarget(om.itemKey(items()[2].id), 0.7);
  await sleep(400);
  om.setVisible(items()[3].parts[0].id, false);
  const want = snapAll();
  await L.flush();
  await emit('choose', { projectId: 'sample-chair' });
  await emit('choose', { projectId: projId });
  const d = diffByIndex(want, snapAll());
  check('B24 #34 two copies of one file (and a renamed copy) all come back, each with its own edits', items().length === 4 && d < 1e-6,
    `${items().map((i) => i.name).join(', ')}; max diff ${d}`);
}

// #41: Cmd+S pressed again (or held) with nothing changed makes no duplicate version.
{
  const nv = async () => (await S.listProjects()).find((x) => x.project.id === projId).versions.length;
  const ctrlS = (repeat = false) => fw.dispatchEvent(new fw.KeyboardEvent('keydown', { key: 's', ctrlKey: true, repeat, cancelable: true }));
  ctrlS();
  await L.flush();
  const v1 = await nv();
  for (let i = 0; i < 5; i++) ctrlS(i > 0);
  await L.flush();
  const v2 = await nv();
  om.rotateTarget(om.itemKey(items()[1].id), 0.1);
  for (let i = 0; i < 5; i++) ctrlS(i > 0);   // one press + key repeat
  await L.flush();
  const v3 = await nv();
  check('B25 #41 Cmd+S with no changes adds no version; held down after an edit adds exactly one', v2 === v1 && v3 === v1 + 1, `${v1} -> ${v2} -> ${v3}`);
}

// #38: storage full. The failed autosave stays pending: switching away is refused once (the
// visitor is told), and the retry saves the edit once space is back.
{
  const IDB = fw.IDBDatabase.prototype, origTx = IDB.transaction;
  let full = true;
  IDB.transaction = function (n, m, ...x) { if (full && m === 'readwrite') throw new fw.DOMException('The quota has been exceeded.', 'QuotaExceededError'); return origTx.call(this, n, m, ...x); };
  try {
    om.rotateTarget(om.itemKey(items()[0].id), 0.2);
    const n1 = H.edits.length;
    await L.flush();
    const msg = fw.document.getElementById('status').textContent;
    const ok1 = await L.open('sample-chair');
    const stayed = L.state().projectId === projId && H.edits.length === n1;
    full = false;
    const ok2 = await L.open('sample-chair');
    check('B26 #38 storage full: the message shows, the switch is refused, and the edit is saved once space is back',
      /storage is full/i.test(msg) && !ok1 && stayed && ok2 && (await workingOf(projId)).layout.edits.length === n1, `open ${ok1}/${ok2}`);
  } finally { IDB.transaction = origTx; }
  await emit('choose', { projectId: projId });
}

// #43 (owner decision): storage full -> "Free space now". A short press does nothing; holding it
// HOLD_GATE.ringMs purges the trash and unused files at once (sparing the open scene's files)
// and retries the failed save. "Full" here lasts until the purge starts, as if it freed the space.
{
  const junkSha = await S.putBlob(new Blob([`deleted project bytes ${Date.now()}`]), { name: 'junk.bin', mime: 'application/octet-stream' });
  const orphanSha = await S.putBlob(new Blob([`orphan bytes ${Date.now()}`]), { name: 'orphan.bin', mime: 'application/octet-stream' });
  const trashed = await S.createProject({ title: 'Trashed', sources: [{ sha: junkSha, name: 'junk.bin' }] });
  await S.softDelete(trashed.id);
  const sceneShas = (await workingOf(projId)).sources.map((r) => r.sha).filter(Boolean);
  const btn = fw.document.getElementById('freeSpace');
  const hiddenBefore = btn.hidden;
  const IDB = fw.IDBDatabase.prototype, origTx = IDB.transaction, origPurge = S.purgeExpired;
  let full = true;
  IDB.transaction = function (n, m, ...x) { if (full && m === 'readwrite') throw new fw.DOMException('The quota has been exceeded.', 'QuotaExceededError'); return origTx.call(this, n, m, ...x); };
  S.purgeExpired = (...a) => { full = false; return origPurge.apply(S, a); };
  const press = async (ms) => {
    btn.dispatchEvent(new fw.PointerEvent('pointerdown', { bubbles: true }));
    await sleep(ms);
    btn.dispatchEvent(new fw.PointerEvent('pointerup', { bubbles: true }));
  };
  try {
    om.rotateTarget(om.itemKey(items()[0].id), 0.25);
    const n1 = H.edits.length;
    await L.flush();
    const shown = !btn.hidden && /storage is full/i.test(fw.document.getElementById('status').textContent);
    await press(200);   // a short press must not purge
    await sleep(100);
    const shortOk = full && !!(await S.getProject(trashed.id));
    await press(800);
    await until(() => btn.hidden && !L.state().pending && /freed space/.test(fw.document.getElementById('status').textContent) && true, 5000);
    await L.flush();
    const sceneKept = (await Promise.all(sceneShas.map((h) => S.getBlob(h)))).every(Boolean);
    check('B30 #43 storage full: "Free space now" shows, a short press does nothing, a hold purges the trash + unused files (not the scene\'s) and saves the edit',
      hiddenBefore && shown && shortOk && !(await S.getProject(trashed.id)) && !(await S.getBlob(junkSha)) && !(await S.getBlob(orphanSha))
      && sceneKept && (await workingOf(projId)).layout.edits.length === n1 && btn.hidden,
      `shown ${shown} short ${shortOk} sceneKept ${sceneKept} status "${fw.document.getElementById('status').textContent}"`);
  } finally { IDB.transaction = origTx; S.purgeExpired = origPurge; }
  // A file stored for the scene whose save then failed has refCount 0: the immediate purge must
  // spare it (keep), or the retry would reference a missing blob (store addRefs throws).
  const pendingSha = await S.putBlob(new Blob([`scene bytes not yet saved ${Date.now()}`]), { name: 'new.bin', mime: 'application/octet-stream' });
  await S.purgeExpired(0, { orphanMs: 0, keep: new Set([pendingSha]) });
  const spared = !!(await S.getBlob(pendingSha));
  await S.purgeExpired(0, { orphanMs: 0 });
  check('B31 #43 the immediate purge spares unreferenced files the open scene still needs (keep)', spared && !(await S.getBlob(pendingSha)));
}

// #42: a hidden tab runs no animation frames; opening a project without a thumbnail must not hang.
{
  const noThumb = await S.createProject({ title: 'No thumb', sources: (await workingOf(projId)).sources });
  const origRaf = fw.requestAnimationFrame;
  fw.requestAnimationFrame = () => 0;
  let opened;
  try { opened = await Promise.race([L.open(noThumb.id), sleep(15000).then(() => 'hung')]); } finally { fw.requestAnimationFrame = origRaf; }
  check('B27 #42 opening a project with no thumbnail finishes without animation frames (hidden tab)', opened === true && !fw.document.body.hasAttribute('data-library-busy'), String(opened));
  await emit('choose', { projectId: projId });
  await emit('action', { type: 'delete', projectId: noThumb.id });
}

// #44: opening A (no thumbnail yet), then B during A's thumbnail step. A's open must still be
// "opening" there (B is refused), or A's finally clears the busy state in the middle of B's load
// and A's thumbnail can be taken of B's scene. B is started from the frame A's thumbnail waits on.
{
  const A = await S.createProject({ title: 'No thumb A', sources: (await workingOf(projId)).sources });
  const origRaf = fw.requestAnimationFrame;
  let pB = null, bDone = false, openingWhenADone = null, busyWhenADone = null;
  fw.requestAnimationFrame = (cb) => {
    if (!pB && L.state().projectId === A.id) { pB = L.open(projId); pB.then(() => { bDone = true; }); }
    return origRaf.call(fw, cb);
  };
  let okA;
  try { okA = await L.open(A.id); } finally { fw.requestAnimationFrame = origRaf; }
  if (pB && !bDone) { openingWhenADone = L.state().opening; busyWhenADone = fw.document.body.hasAttribute('data-library-busy'); }
  const okB = pB ? await pB : 'not started';
  const thumbA = (await S.getVersion((await S.getProject(A.id)).workingVersionId)).thumbId;
  check('B32 #44 a second open during the first one\'s thumbnail step is refused (never runs unguarded)',
    okA === true && okB === false && L.state().projectId === A.id && !!thumbA && !L.state().opening && !fw.document.body.hasAttribute('data-library-busy'),
    `A ${okA} B ${okB} opening/busy when A finished ${openingWhenADone}/${busyWhenADone} thumbA ${!!thumbA}`);
  await emit('choose', { projectId: projId });
  await emit('action', { type: 'delete', projectId: A.id });
}

// #36: another tab wrote this project's working copy: this tab's next autosave must not
// overwrite it; its scene continues as a new project.
{
  const other = { ...(await workingOf(projId)).layout, edits: [{ seq: 999, op: 'other tab' }] };
  await S.saveWorking(projId, { layout: other });   // as another tab would (bumps the revision)
  om.rotateTarget(om.itemKey(items()[0].id), 0.15);
  await L.flush();
  const kept = await workingOf(projId);
  const now = L.state();
  check('B28 #36 a stale tab never overwrites the other tab\'s save; its edits continue in a new project',
    kept.layout.edits.length === 1 && kept.layout.edits[0].op === 'other tab' && now.projectId !== projId && /another tab/.test(now.title)
    && (await workingOf(now.projectId)).layout.edits.length === H.edits.length, now.title);
  await emit('action', { type: 'delete', projectId: now.projectId });
  await emit('choose', { projectId: projId });
}

// #51: a camera move is saved on its own (debounced) and does not count as a change since the
// last version (no "kept" version on checkout, Cmd+S still a no-op).
{
  await L.flush();
  fw.dispatchEvent(new fw.KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
  await L.flush(); await sleep(50); await L.flush();
  const v0 = (await S.getProject(projId)).versionCount;
  H.camera.position.set(1.234, 0.987, 2.345); H.controls.target.set(0.012, 0.345, -0.021); H.controls.update();
  const saved = await until(async () => { const w = await workingOf(projId); return w.layout?.camera?.position?.[0] === 1.234 && w; }, 6000);
  fw.dispatchEvent(new fw.KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }));
  await L.flush(); await sleep(50); await L.flush();
  const v1 = (await S.getProject(projId)).versionCount;
  check('B33 #51 a camera move autosaves by itself and is not a change since the version', !!saved && saved.dirty === false && v1 === v0,
    `camera saved ${!!saved}, dirty ${saved?.dirty}, versions ${v0} -> ${v1}`);
}

// Reload: the last project reopens (not the ring). #37: an edit made just before the reload
// (inside the autosave debounce) must survive it. #51: so must the camera, the Scene/Object
// mode and the selection, changed just before the reload too.
const ringOpensBefore = ringLog.opened;
await L.flush();
om.rotateTarget(om.itemKey(items()[1].id), 0.33);
// #51 cause 3: polygon face edits (I-mark, Delete-hide) must survive the reload too.
const polyFaces = (Hx) => {
  const out = [];
  for (const it of [...Hx.items.values()].filter((i) => i.status === 'ready')) for (const p of it.parts) {
    const f = Hx.polygon.faceState(p.mesh);
    let hid = 0, inf = 0;
    if (f) for (let k = 0; k < f.faces; k++) { hid += f.hidden[k]; if (f.inferred(k)) inf++; }
    out.push(`${it.name}#${p.local}:${hid}/${inf}`);
  }
  return out.join(',');
};
{
  await until(() => H.polygon, 10000);
  const P = H.polygon, m = items()[0].parts[0].mesh;
  m.geometry.computeBoundingBox();
  const c = m.geometry.boundingBox.getCenter(H.camera.position.clone()).applyMatrix4(m.matrixWorld).project(H.camera);
  const r = fw.document.querySelector('#stage canvas').getBoundingClientRect();
  const at = (dx) => [r.left + (c.x + 1) / 2 * r.width + dx, r.top + (1 - c.y) / 2 * r.height];
  P.enter(null); P.radius = 40;
  P.setPointer(...at(0)); P.select(); P.toggleInferredPatch(); P.clearPatch();
  P.setPointer(...at(25)); P.select(); P.hidePatch(); P.clearPatch(); P.exit();
}
const polyBefore = polyFaces(H), polyOpsBefore = H.edits.map((e) => e.op).join();
const editsBeforeReload = H.edits.length;
om.setMode('object');
const selPart = items()[1].parts[0];
om.select(selPart.id);
H.camera.position.set(1.5, 1.1, 2.0); H.controls.target.set(0.05, 0.35, 0.02); H.controls.update();
const r4 = (v) => v.toArray().map((n) => n.toFixed(4)).join();
const viewBefore = { cam: r4(H.camera.position), tgt: r4(H.controls.target), mode: 'object', sel: `${items()[1].name}#${selPart.local}` };
frame.src = `./index.html?db=${APP_DB}&ring=stub&v=${Date.now()}`;
await sleep(300);
const fw2 = await until(() => frame.contentWindow?.hologram?.library?.ready && frame.contentWindow, 30000);
fw2.addEventListener('error', (e) => errors.push(`error: ${e.message}`));
const origErr2 = fw2.console.error.bind(fw2.console);
fw2.console.error = (...a) => { errors.push(a.map(String).join(' ')); origErr2(...a); };
await fw2.hologram.library.ready;
check('B20 a return visit reopens the last project instead of the ring', fw2.hologram.library.state().projectId === projId && ringLog.opened === ringOpensBefore);
check('B29 #37 an edit inside the autosave debounce survives a reload', fw2.hologram.edits.length === editsBeforeReload
  && (await fw2.hologram.library.store.getVersion((await fw2.hologram.library.store.getProject(projId)).workingVersionId)).layout.edits.length === editsBeforeReload
  && !Object.keys(localStorage).some((k) => k.startsWith(`hologram-platform-rescue:${APP_DB}:`)), `${fw2.hologram.edits.length}/${editsBeforeReload}`);
{
  const H2 = fw2.hologram, om2 = H2.objectMode, sid = om2.selectedId;
  const it2 = [...H2.items.values()].find((i) => i.parts.some((p) => p.id === sid));
  const viewAfter = { cam: r4(H2.camera.position), tgt: r4(H2.controls.target), mode: om2.mode, sel: it2 ? `${it2.name}#${it2.parts.find((p) => p.id === sid).local}` : String(sid) };
  check('B34 #51 a reload restores the camera, the Scene/Object mode and the selection exactly', JSON.stringify(viewAfter) === JSON.stringify(viewBefore),
    `${JSON.stringify(viewAfter)} vs ${JSON.stringify(viewBefore)}`);
  const polyAfter = polyFaces(H2), polyOpsAfter = H2.edits.map((e) => e.op).join();
  check('B35 #51 polygon edits (I-mark, hide) and the full undo history survive a reload',
    /polyInfer/.test(polyOpsBefore) && /polyHide/.test(polyOpsBefore) && /\/[1-9]/.test(polyBefore) && polyAfter === polyBefore && polyOpsAfter === polyOpsBefore,
    `ops ${polyOpsAfter} vs ${polyOpsBefore}; faces ${polyAfter === polyBefore ? 'same' : `${polyAfter} vs ${polyBefore}`}`);
}
await fw2.hologram.library.thumbsDone;
check('B21 no console errors in the app during all of the above', errors.length === 0, errors.slice(0, 3).join(' | '));

// ---- cleanup ---------------------------------------------------------------------------------
frame.remove();
await sleep(100);
const gone = await deleteStore(APP_DB);
try { localStorage.removeItem(`hologram-platform-lastProject:${APP_DB}`); } catch { /* */ }
log(`(test databases deleted: ${gone ? 'yes' : 'blocked, close other tabs of this page'})`);

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
document.title = failed.length ? `FAIL ${failed.length}` : `ALL PASS ${results.length}`;
window.__libraryTest = { results, failed: failed.length };

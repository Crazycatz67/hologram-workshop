// The project library's storage: IndexedDB in the visitor's browser, nothing uploaded.
//
// A PROJECT is a whole workbench scene (one or many scans). Each project has a chain of
// immutable VERSIONS plus one mutable WORKING copy that autosave keeps overwriting. A version
// is NOT baked geometry: it is the list of source files (by sha256 or URL) plus the
// buildLayout() v2 edit log replayed on them, so the original scans are never changed.
//
// Database `hologram-library` v1, object stores:
//   blobs     { sha, blob, name, mime, size, refCount, createdAt }          key: sha
//             refCount = how many version records (working copies included) list this sha.
//   projects  { id, title, kind, sample, sampleKey?, createdAt, updatedAt, deletedAt|null,
//               hidden, workingVersionId, originalVersionId, versionCount }  key: id
//   versions  { id, projectId, parentId|null, type, label, createdAt, updatedAt,
//               sources:[{sha?|url?, name}], layout|null, extras|null, thumbId|null,
//               provenance|null, stats|null, dirty?, rev? }                   key: id, index byProject
//             rev (working copy only): bumped by every write to its contents (missing = 0).
//             type: 'original' | 'completed' | 'edited' | 'imported' | 'working'
//   thumbs    { id, blob, createdAt }                                       key: id (one per version)
//
// API (all async unless noted):
//   openStore({ name?, now?, autoPersist?, faults? }) -> store
//   store.persist() -> bool       navigator.storage.persist(); also called once, automatically,
//                                 on the first user save (autoPersist) -- Safari otherwise may
//                                 evict script-written storage after 7 days without a visit.
//   store.estimate() -> { usage, quota } | null
//   store.putBlob(blob, { name, mime }) -> sha        dedupes by sha256 (refCount starts at 0)
//   store.getBlob(sha) -> Blob | null
//   store.createProject({ title, kind, sources, sample, layout?, extras?, stats?, thumbBlob? })
//         -> project      makes an immutable 'original' version + a working copy on top of it
//   store.seedSample({ key, title, versions:[{label, type, sources, provenance?, stats?}] })
//         -> { project, created }   idempotent (fixed ids); the working copy starts from the last version
//   store.listProjects({ includeDeleted=false }) -> [{ project, versions:[summary] }]
//         newest first; versions oldest first with the working copy last; summaries have no layout
//   store.getProject(id) / store.getVersion(id) -> full record | null
//   store.saveWorking(projectId, { layout, extras?, thumbBlob?, stats?, sources?, baseRev?, dirty=true }) -> summary
//         dirty:false = a view-only save (camera / mode / selection): the dirty flag is left as it was
//         baseRev: the working copy's `rev` this tab last loaded or wrote. If another tab wrote
//         the working copy since, nothing is written and StoreConflictError (code 'conflict')
//         is thrown, so two tabs on one project never silently overwrite each other.
//   store.saveVersion(projectId, { label?, type='edited', layout, extras?, thumbBlob?, provenance?,
//         stats?, sources?, baseRev? }) -> summary (+ workingRev)   new immutable version whose
//         parent is the working copy's parent; the working copy then continues from it (dirty = false)
//   store.checkout(projectId, versionId) -> working summary   reset the working copy to a version;
//         unsaved working edits are first kept as an automatic version, so nothing is lost
//   store.fork(projectId, versionId) -> project       new project starting from that version
//   store.setThumb(versionId, blob)                   (lazy thumbnails for seeded samples)
//   store.rename(projectId, title)
//   store.softDelete(projectId) -> 'deleted' | 'hidden'   samples are only hidden, never deleted
//   store.restore(projectId)
//   store.purgeExpired(days=30, { orphanMs, keep }) -> { projects, versions, thumbs, blobs }
//         frees blobs at refCount 0. "Free space now" (#43) passes days 0 and orphanMs 0; keep
//         (a Set of shas) spares blobs the open scene uses but has not referenced yet
//   store.thumbUrl(thumbId) -> object URL | null      cached; revoked when its thumb is replaced
//   store.close()
//   deleteStore(name)                                 (tests)
//
// Failure behaviour: a write that runs out of space throws StoreQuotaError (code 'quota',
// a message the UI can show as-is); every other IndexedDB error is rethrown unchanged.
// Writes are single transactions, so a failed write leaves the previous state intact.

export const DB_NAME = 'hologram-library';
const DB_VERSION = 1;
const DAY_MS = 864e5;
const ORPHAN_MS = DAY_MS;   // a blob put but never referenced (e.g. its load failed) is freed after a day

export class StoreQuotaError extends Error {
  constructor(cause) {
    super('Browser storage is full. Export your work (Export menu: layout or GLB), remove old projects, then try again.');
    this.name = 'StoreQuotaError';
    this.code = 'quota';
    this.cause = cause;
  }
}

export class StoreConflictError extends Error {
  constructor(title) {
    super(`"${title}" was changed in another tab`);
    this.name = 'StoreConflictError';
    this.code = 'conflict';
  }
}
// Optimistic concurrency on the working copy (see saveWorking's baseRev).
function checkRev(w, baseRev, title) {
  if (baseRev !== undefined && baseRev !== null && (w.rev ?? 0) !== baseRev) throw new StoreConflictError(title);
  w.rev = (w.rev ?? 0) + 1;
}

const isQuota = (e) => e?.name === 'QuotaExceededError' || e?.name === 'StoreQuotaError'
  || /quota/i.test(e?.message ?? '');
const classify = (e) => (e instanceof StoreQuotaError ? e : isQuota(e) ? new StoreQuotaError(e) : e);

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const shasOf = (sources) => [...new Set((sources ?? []).map((s) => s.sha).filter(Boolean))];
const cleanSources = (sources) => (sources ?? []).map((s) => {
  const o = { name: String(s.name ?? s.url?.split('/').pop() ?? s.sha ?? 'file') };
  if (s.sha) o.sha = s.sha;
  if (s.url) o.url = s.url;
  return o;
});

// Hashing lives here (not imported from upload.js) so the store doesn't pull three.js and
// its loaders into the test page; same digest, same hex.
async function digest(blob) {
  const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function summary(v) {
  if (!v) return null;
  const { layout, extras, ...rest } = v;   // layouts can be large; the ring only needs the header
  return { ...rest, edits: layout?.edits?.length ?? 0, items: layout?.items?.length ?? null };
}

export function deleteStore(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = () => res(true); r.onerror = () => rej(r.error); r.onblocked = () => res(false);
  });
}

export async function openStore({ name = DB_NAME, now = () => Date.now(), autoPersist = true, faults = null } = {}) {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open(name, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'sha' });
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('versions')) d.createObjectStore('versions', { keyPath: 'id' }).createIndex('byProject', 'projectId');
      if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(classify(r.error));
    r.onblocked = () => rej(new Error('library storage is open in an older tab; close it and reload'));
  });
  // Another tab upgrading the schema later: let it, rather than blocking it forever.
  db.onversionchange = () => db.close();

  const urls = new Map();   // thumbId -> Promise<objectURL|null>
  let persistAsked = false;
  let persisted = null;

  // One transaction per operation. Only IndexedDB requests are awaited inside `fn` (anything
  // else would let the transaction auto-commit half way); hashing etc. happens before.
  async function run(names, mode, fn) {
    let tx;
    try {
      if (mode === 'readwrite') faults?.beforeWrite?.(names);   // test hook: simulate a full disk
      tx = db.transaction(names, mode);
    } catch (e) { throw classify(e); }
    const done = new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = () => rej(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
    });
    let result;
    try {
      result = await fn(tx);
    } catch (e) {
      try { tx.abort(); } catch { /* already finished */ }
      await done.catch(() => {});
      throw classify(e);
    }
    try { await done; } catch (e) { throw classify(e); }
    return result;
  }

  const os = (tx, n) => tx.objectStore(n);
  const get = (tx, n, key) => req(os(tx, n).get(key));
  const put = (tx, n, v) => req(os(tx, n).put(v));
  const del = (tx, n, key) => req(os(tx, n).delete(key));
  const versionsOf = (tx, projectId) => req(os(tx, 'versions').index('byProject').getAll(projectId));

  async function addRefs(tx, shas, delta) {
    const freed = [];
    for (const sha of shas) {
      const b = await get(tx, 'blobs', sha);
      if (!b) { if (delta > 0) throw new Error(`blob ${sha.slice(0, 12)}… is not in the library (putBlob it first)`); continue; }
      b.refCount = Math.max(0, (b.refCount ?? 0) + delta);
      if (b.refCount === 0 && delta < 0) { await del(tx, 'blobs', sha); freed.push(sha); }
      else await put(tx, 'blobs', b);
    }
    return freed;
  }
  // Move a version's references from `before` to `after` without touching shared shas.
  async function swapRefs(tx, before, after) {
    const a = new Set(shasOf(before)), b = new Set(shasOf(after));
    await addRefs(tx, [...b].filter((s) => !a.has(s)), +1);
    return addRefs(tx, [...a].filter((s) => !b.has(s)), -1);
  }
  async function putThumb(tx, blob) {
    if (!blob) return null;
    const id = uid();
    await put(tx, 'thumbs', { id, blob, createdAt: now() });
    return id;
  }
  function forgetUrl(thumbId) {
    const p = urls.get(thumbId);
    if (!p) return;
    urls.delete(thumbId);
    p.then((u) => u && URL.revokeObjectURL(u));
  }
  async function liveProject(tx, id) {
    const p = await get(tx, 'projects', id);
    // code 'gone': deleted (maybe from another tab) -- callers can keep their edits elsewhere.
    if (!p) throw Object.assign(new Error(`no project ${id}`), { code: 'gone' });
    if (p.deletedAt) throw Object.assign(new Error(`project "${p.title}" is deleted (restore it first)`), { code: 'gone' });
    return p;
  }
  function maybePersist(sample) {
    if (!autoPersist || sample || persistAsked) return;
    persistAsked = true;
    store.persist().catch(() => {});
  }
  function newVersion(fields) {
    const t = now();
    return {
      id: uid(), parentId: null, type: 'edited', label: '', createdAt: t, updatedAt: t,
      sources: [], layout: null, extras: null, thumbId: null, provenance: null, stats: null, ...fields
    };
  }

  const store = {
    name,
    get persisted() { return persisted; },

    async persist() {
      try { persisted = (await navigator.storage?.persist?.()) ?? false; } catch { persisted = false; }
      return persisted;
    },
    async estimate() {
      try { return (await navigator.storage?.estimate?.()) ?? null; } catch { return null; }
    },

    async putBlob(blob, { name: fileName, mime } = {}) {
      // Duck-typed: a Blob from another window (iframe) fails instanceof but stores fine.
      if (typeof blob?.arrayBuffer !== 'function') throw new TypeError('putBlob needs a Blob or File');
      const sha = await digest(blob);
      await run(['blobs'], 'readwrite', async (tx) => {
        if (await get(tx, 'blobs', sha)) return;   // dedupe: same bytes are stored once
        await put(tx, 'blobs', {
          sha, blob, name: fileName ?? blob.name ?? sha.slice(0, 12), mime: mime ?? blob.type ?? '',
          size: blob.size, refCount: 0, createdAt: now()
        });
      });
      return sha;
    },
    async getBlob(sha) {
      const b = await run(['blobs'], 'readonly', (tx) => get(tx, 'blobs', sha));
      return b?.blob ?? null;
    },
    async getBlobInfo(sha) {
      const b = await run(['blobs'], 'readonly', (tx) => get(tx, 'blobs', sha));
      if (!b) return null;
      const { blob, ...info } = b;
      return info;
    },

    async createProject({ title, kind = 'scene', sources = [], sample = false, layout = null, extras = null, stats = null, thumbBlob = null, provenance = null } = {}) {
      const src = cleanSources(sources);
      const t = now();
      const project = {
        id: uid(), title: String(title || 'Untitled scene').slice(0, 120), kind, sample: !!sample,
        createdAt: t, updatedAt: t, deletedAt: null, hidden: false, versionCount: 0,
        workingVersionId: null, originalVersionId: null
      };
      await run(['projects', 'versions', 'thumbs', 'blobs'], 'readwrite', async (tx) => {
        const original = newVersion({ projectId: project.id, type: 'original', label: 'Original', sources: src, layout, extras, stats, provenance });
        original.thumbId = await putThumb(tx, thumbBlob);
        const working = newVersion({ projectId: project.id, type: 'working', label: 'Working copy', parentId: original.id, sources: src, layout, extras, stats, dirty: false });
        working.thumbId = await putThumb(tx, thumbBlob);
        project.originalVersionId = original.id;
        project.workingVersionId = working.id;
        await addRefs(tx, shasOf(src), +2);   // two version records list them
        await put(tx, 'versions', original);
        await put(tx, 'versions', working);
        await put(tx, 'projects', project);
      });
      maybePersist(sample);
      return project;
    },

    async seedSample({ key, title, kind = 'scene', versions }) {
      if (!key || !versions?.length) throw new Error('seedSample needs a key and at least one version');
      const id = `sample-${key}`;
      const existing = await store.getProject(id);
      if (existing) return { project: existing, created: false };
      try {
        const project = await run(['projects', 'versions', 'blobs'], 'readwrite', async (tx) => {
          if (await get(tx, 'projects', id)) return null;
          const t = now();
          const p = {
            id, title, kind, sample: true, sampleKey: key, createdAt: t, updatedAt: t, deletedAt: null, hidden: false,
            versionCount: 0, workingVersionId: `${id}:working`, originalVersionId: `${id}:v1`
          };
          let parentId = null;
          for (let i = 0; i < versions.length; i++) {
            const v = versions[i];
            const rec = newVersion({
              id: `${id}:v${i + 1}`, projectId: id, parentId, type: v.type ?? (i ? 'edited' : 'original'),
              label: v.label ?? `Version ${i + 1}`, sources: cleanSources(v.sources), provenance: v.provenance ?? null,
              stats: v.stats ?? null, createdAt: t + i, updatedAt: t + i
            });
            await addRefs(tx, shasOf(rec.sources), +1);
            await put(tx, 'versions', rec);
            parentId = rec.id;
          }
          const last = versions[versions.length - 1];
          const working = newVersion({
            id: p.workingVersionId, projectId: id, parentId, type: 'working', label: 'Working copy',
            sources: cleanSources(last.sources), stats: last.stats ?? null, dirty: false, createdAt: t + versions.length, updatedAt: t + versions.length
          });
          await addRefs(tx, shasOf(working.sources), +1);
          await put(tx, 'versions', working);
          // add(), not put(): two tabs seeding at once -> the second fails here and reads the first's.
          await req(os(tx, 'projects').add(p));
          return p;
        });
        if (project) return { project, created: true };
      } catch (e) {
        if (e?.name !== 'ConstraintError') throw e;
      }
      return { project: await store.getProject(id), created: false };
    },

    async getProject(id) { return (await run(['projects'], 'readonly', (tx) => get(tx, 'projects', id))) ?? null; },
    async getVersion(id) { return (await run(['versions'], 'readonly', (tx) => get(tx, 'versions', id))) ?? null; },

    async listProjects({ includeDeleted = false } = {}) {
      return run(['projects', 'versions'], 'readonly', async (tx) => {
        const all = await req(os(tx, 'projects').getAll());
        const out = [];
        for (const project of all) {
          if (!includeDeleted && (project.deletedAt || project.hidden)) continue;
          const vs = (await versionsOf(tx, project.id)).map(summary);
          vs.sort((a, b) => (a.type === 'working') - (b.type === 'working') || a.createdAt - b.createdAt);
          out.push({ project, versions: vs });
        }
        out.sort((a, b) => b.project.updatedAt - a.project.updatedAt);
        return out;
      });
    },

    // dirty:false = only the view changed (camera / mode / selection, BUGS #51): the copy keeps
    // its "changed since version" flag as it was, so checkout makes no version of a camera move.
    async saveWorking(projectId, { layout, extras, thumbBlob = null, stats, sources, baseRev, dirty = true } = {}) {
      let oldThumb = null, sample = false;
      const res = await run(['projects', 'versions', 'thumbs', 'blobs'], 'readwrite', async (tx) => {
        const p = await liveProject(tx, projectId);
        sample = p.sample;
        const w = await get(tx, 'versions', p.workingVersionId);
        checkRev(w, baseRev, p.title);
        if (sources) {
          const next = cleanSources(sources);
          await swapRefs(tx, w.sources, next);
          w.sources = next;
        }
        if (layout !== undefined) w.layout = layout;
        if (extras !== undefined) w.extras = extras;
        if (stats !== undefined) w.stats = stats;
        if (thumbBlob) {
          oldThumb = w.thumbId;
          if (oldThumb) await del(tx, 'thumbs', oldThumb);
          w.thumbId = await putThumb(tx, thumbBlob);
        }
        w.updatedAt = p.updatedAt = now();
        if (dirty) w.dirty = true;
        await put(tx, 'versions', w);
        await put(tx, 'projects', p);
        return summary(w);
      });
      if (oldThumb) forgetUrl(oldThumb);
      maybePersist(sample);
      return res;
    },

    async saveVersion(projectId, { label, type = 'edited', layout, extras, thumbBlob = null, provenance = null, stats, sources, baseRev } = {}) {
      let oldThumb = null, sample = false;
      const res = await run(['projects', 'versions', 'thumbs', 'blobs'], 'readwrite', async (tx) => {
        const p = await liveProject(tx, projectId);
        sample = p.sample;
        const w = await get(tx, 'versions', p.workingVersionId);
        checkRev(w, baseRev, p.title);
        const src = sources ? cleanSources(sources) : w.sources;
        p.versionCount = (p.versionCount ?? 0) + 1;
        const v = newVersion({
          projectId, parentId: w.parentId, type, label: String(label || `Version ${p.versionCount}`).slice(0, 80),
          sources: src, layout: layout ?? w.layout, extras: extras ?? w.extras, stats: stats ?? w.stats,
          provenance: { ...(provenance ?? {}), savedFromWorking: w.id }
        });
        v.thumbId = await putThumb(tx, thumbBlob);
        await addRefs(tx, shasOf(src), +1);
        await swapRefs(tx, w.sources, src);
        // The working copy now continues from the version just saved.
        w.parentId = v.id;
        w.sources = src;
        w.layout = v.layout; w.extras = v.extras; w.stats = v.stats;
        w.dirty = false;
        if (thumbBlob) {
          oldThumb = w.thumbId;
          if (oldThumb) await del(tx, 'thumbs', oldThumb);
          w.thumbId = await putThumb(tx, thumbBlob);
        }
        w.updatedAt = p.updatedAt = v.createdAt;
        await put(tx, 'versions', v);
        await put(tx, 'versions', w);
        await put(tx, 'projects', p);
        return { ...summary(v), workingRev: w.rev };
      });
      if (oldThumb) forgetUrl(oldThumb);
      maybePersist(sample);
      return res;
    },

    async checkout(projectId, versionId) {
      const p = await store.getProject(projectId);
      if (!p) throw new Error(`no project ${projectId}`);
      if (!versionId || versionId === p.workingVersionId) return summary(await store.getVersion(p.workingVersionId));
      const target = await store.getVersion(versionId);
      if (!target || target.projectId !== projectId) throw new Error(`version ${versionId} is not in "${p.title}"`);
      const w0 = await store.getVersion(p.workingVersionId);
      // Unsaved working edits would be overwritten: keep them as a version first.
      if (w0?.dirty) await store.saveVersion(projectId, { label: `Unsaved work (kept before opening ${target.label})`, type: 'edited', provenance: { auto: true } });
      let oldThumb = null;
      const res = await run(['projects', 'versions', 'thumbs', 'blobs'], 'readwrite', async (tx) => {
        const pp = await liveProject(tx, projectId);
        const w = await get(tx, 'versions', pp.workingVersionId);
        const t = await get(tx, 'versions', versionId);
        await swapRefs(tx, w.sources, t.sources);
        oldThumb = w.thumbId;
        if (oldThumb) await del(tx, 'thumbs', oldThumb);
        const tb = t.thumbId ? await get(tx, 'thumbs', t.thumbId) : null;
        w.thumbId = await putThumb(tx, tb?.blob ?? null);
        Object.assign(w, { parentId: t.id, sources: t.sources, layout: t.layout, extras: t.extras, stats: t.stats, dirty: false });
        w.rev = (w.rev ?? 0) + 1;
        w.updatedAt = pp.updatedAt = now();
        await put(tx, 'versions', w);
        await put(tx, 'projects', pp);
        return summary(w);
      });
      if (oldThumb) forgetUrl(oldThumb);
      return res;
    },

    async fork(projectId, versionId) {
      const t = now();
      const project = await run(['projects', 'versions', 'thumbs', 'blobs'], 'readwrite', async (tx) => {
        const src = await get(tx, 'projects', projectId);
        if (!src) throw new Error(`no project ${projectId}`);
        const v = await get(tx, 'versions', versionId ?? src.workingVersionId);
        if (!v || v.projectId !== projectId) throw new Error(`version ${versionId} is not in "${src.title}"`);
        const p = {
          id: uid(), title: `${src.title} (copy)`.slice(0, 120), kind: src.kind, sample: false,
          createdAt: t, updatedAt: t, deletedAt: null, hidden: false, versionCount: 0,
          workingVersionId: null, originalVersionId: null
        };
        const tb = v.thumbId ? await get(tx, 'thumbs', v.thumbId) : null;
        const base = newVersion({
          projectId: p.id, type: v.type === 'working' ? 'edited' : v.type, label: `From ${src.title}: ${v.label}`.slice(0, 80),
          sources: v.sources, layout: v.layout, extras: v.extras, stats: v.stats,
          provenance: { forkedFrom: { projectId, versionId: v.id, title: src.title, label: v.label } }
        });
        base.thumbId = await putThumb(tx, tb?.blob ?? null);
        const working = newVersion({
          projectId: p.id, type: 'working', label: 'Working copy', parentId: base.id,
          sources: v.sources, layout: v.layout, extras: v.extras, stats: v.stats, dirty: false
        });
        working.thumbId = await putThumb(tx, tb?.blob ?? null);
        p.originalVersionId = base.id;
        p.workingVersionId = working.id;
        await addRefs(tx, shasOf(v.sources), +2);
        await put(tx, 'versions', base);
        await put(tx, 'versions', working);
        await put(tx, 'projects', p);
        return p;
      });
      maybePersist(false);
      return project;
    },

    async setThumb(versionId, blob) {
      let oldThumb = null;
      await run(['versions', 'thumbs'], 'readwrite', async (tx) => {
        const v = await get(tx, 'versions', versionId);
        if (!v) throw new Error(`no version ${versionId}`);
        oldThumb = v.thumbId;
        if (oldThumb) await del(tx, 'thumbs', oldThumb);
        v.thumbId = await putThumb(tx, blob);
        await put(tx, 'versions', v);
      });
      if (oldThumb) forgetUrl(oldThumb);
    },

    async rename(projectId, title) {
      const clean = String(title ?? '').trim().slice(0, 120);
      if (!clean) throw new Error('a project needs a name');
      return run(['projects'], 'readwrite', async (tx) => {
        const p = await get(tx, 'projects', projectId);
        if (!p) throw new Error(`no project ${projectId}`);
        p.title = clean;
        p.updatedAt = now();
        await put(tx, 'projects', p);
        return p;
      });
    },

    async softDelete(projectId) {
      return run(['projects'], 'readwrite', async (tx) => {
        const p = await get(tx, 'projects', projectId);
        if (!p) throw new Error(`no project ${projectId}`);
        // Samples are part of the app, not the visitor's data: hide them, never delete.
        if (p.sample) p.hidden = true; else p.deletedAt = now();
        await put(tx, 'projects', p);
        return p.sample ? 'hidden' : 'deleted';
      });
    },
    async restore(projectId) {
      return run(['projects'], 'readwrite', async (tx) => {
        const p = await get(tx, 'projects', projectId);
        if (!p) throw new Error(`no project ${projectId}`);
        p.deletedAt = null;
        p.hidden = false;
        await put(tx, 'projects', p);
        return p;
      });
    },

    async purgeExpired(days = 30, { orphanMs = ORPHAN_MS, keep = null } = {}) {
      const t = now();
      const cutoff = t - days * DAY_MS;
      const out = { projects: 0, versions: 0, thumbs: 0, blobs: 0 };
      const goneThumbs = [];
      await run(['projects', 'versions', 'thumbs', 'blobs'], 'readwrite', async (tx) => {
        for (const p of await req(os(tx, 'projects').getAll())) {
          if (p.sample || !p.deletedAt || p.deletedAt > cutoff) continue;
          for (const v of await versionsOf(tx, p.id)) {
            out.blobs += (await addRefs(tx, shasOf(v.sources), -1)).length;
            if (v.thumbId) { await del(tx, 'thumbs', v.thumbId); goneThumbs.push(v.thumbId); out.thumbs++; }
            await del(tx, 'versions', v.id);
            out.versions++;
          }
          await del(tx, 'projects', p.id);
          out.projects++;
        }
        for (const b of await req(os(tx, 'blobs').getAll())) {
          if ((b.refCount ?? 0) <= 0 && b.createdAt <= t - orphanMs && !keep?.has(b.sha)) { await del(tx, 'blobs', b.sha); out.blobs++; }
        }
      });
      goneThumbs.forEach(forgetUrl);
      return out;
    },

    thumbUrl(thumbId) {
      if (!thumbId) return Promise.resolve(null);
      if (!urls.has(thumbId)) {
        urls.set(thumbId, run(['thumbs'], 'readonly', (tx) => get(tx, 'thumbs', thumbId))
          .then((r) => (r?.blob ? URL.createObjectURL(r.blob) : null))
          .catch(() => null));
      }
      return urls.get(thumbId);
    },

    close() {
      for (const id of [...urls.keys()]) forgetUrl(id);
      db.close();
    }
  };
  return store;
}

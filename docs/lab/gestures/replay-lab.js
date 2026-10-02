// Replay lab page: replays every recorded clip (assets/gesture-clips/index.json) and every
// fixture (fixtures/index.json) through the shipped pipeline via replay.js, under every stress
// variant, and shows the per-gesture report + confusion matrix + gate.
//
// Output: window.__replayReport (JSON, schema replay.js SCHEMA), window.__replayReportMd, and
// #status = 'done: PASS' | 'done: FAIL' | 'error: …'. On localhost the run is saved through
// testrec.js -> serve.py (docs/testing/runs/replay-lab/), with the report attached; then
// `replay.js --write` turns that run into docs/lab/gestures/report.json + REPORT.md.
// ?compare=1 also diffs against the saved report.json in the page. ?clips=a,b limits the clips (records under page id 'replay-lab-only' so it never compares
// against a full run); ?variants=base,mirror limits the variants; ?sets=owner limits the
// clip sets (owner | real | semi-real | synthetic).
//
// assets/gesture-clips/ holds two kinds of clip-lab clip: ground-truth takes
// (purpose 'ground-truth', '<gesture>-t<k>') score as set 'owner'; the demo-hand clips score
// as 'real'. A take the owner marked ✗ (verdict 'bad') is left out and counted.

const V = `?v=${Date.now()}`;
const R = await import(`./replay.js${V}`);
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const onlyClips = q.get('clips')?.split(',') ?? null;
const onlyVariants = q.get('variants')?.split(',') ?? null;
const onlySets = q.get('sets')?.split(',') ?? null;
const scoped = !!(onlyClips || onlyVariants || onlySets);

const rec = await import(`../../../testrec.js${V}`)
  .then((m) => m.startRun({
    page: scoped ? 'replay-lab-only' : 'replay-lab',
    title: 'Gesture replay report',
    settings: { clips: onlyClips, variants: onlyVariants, seed: R.SEED },
    tolerances: { '*': { abs: 0 } }
  }))
  .catch(() => null);

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// Real clips first, then fixtures. A missing listing is not an error (fixtures may be absent
// on a static host; real clips are absent until the owner records them).
let setInfo = {};
let excludedTakes = 0;
async function loadClips() {
  const list = [];
  const real = await getJson('../../../assets/gesture-clips/index.json').catch(() => ({ clips: [] }));
  for (const e of real.clips ?? []) {
    const name = typeof e === 'string' ? e : e.name;
    // The set is read from the clip itself (index.json is written by serve.py and doesn't carry it).
    if (name) list.push({ url: `../../../assets/gesture-clips/${name}.json`, set: (c) => (c.purpose === 'ground-truth' ? 'owner' : 'real') });
  }
  const fx = await getJson('./fixtures/index.json').catch(() => ({ clips: [] }));
  setInfo = fx.sets ?? {};
  for (const e of fx.clips ?? []) list.push({ url: `./fixtures/${e.file}`, set: e.set ?? (e.synthetic ? 'synthetic' : 'semi-real') });
  const clips = [];
  for (const it of list) {
    if (onlySets && typeof it.set === 'string' && !onlySets.includes(it.set)) continue;
    const c = await getJson(it.url);
    const set = typeof it.set === 'function' ? it.set(c) : it.set;
    if (onlySets && !onlySets.includes(set)) continue;
    if (onlyClips && !onlyClips.includes(c.name) && !onlyClips.includes(c.gesture)) continue;
    if (c.verdict === 'bad') { excludedTakes++; continue; }
    clips.push({ clip: c, set, synthetic: set === 'synthetic', url: it.url });
  }
  return clips;
}

try {
  $('status').textContent = 'loading pipeline…';
  const P = await R.loadPipeline('../../../', V);
  const clips = await loadClips();
  const variants = R.VARIANTS.filter((v) => !onlyVariants || onlyVariants.includes(v.id));
  const wheelParent = $('wheel-host');
  const runs = [];
  const t0 = performance.now();
  for (const { clip, set, synthetic } of clips) {
    const exp = R.expectedOf(clip.gesture ?? clip.name);
    for (const v of variants) {
      $('status').textContent = `replaying ${clip.name} [${v.id}]…`;
      const pc = R.perturbClip(clip, v, R.SEED + R.hashStr(`${clip.name}|${v.id}`));
      const out = R.replayClip(pc, P, { wheelParent });
      runs.push({ clip: clip.name, set, synthetic, variant: v.id, expected: exp.expected, allowed: exp.allowed, pending: exp.pending, fired: out.fired, channels: out.channels, clicks: out.clicks, wheel: out.wheel, frames: out.frames });
    }
  }
  // One score block per set: real owner clips, semi-real, synthetic never pool together.
  const LABELS = {
    owner: 'the owner\'s ground-truth takes (clip-lab Run all; ✗ takes left out)',
    real: 'the owner\'s demo-hand clips (clip-lab)',
    ...Object.fromEntries(Object.entries(setInfo).map(([k, v]) => [k, v.label]))
  };
  const sets = {};
  for (const name of ['owner', 'real', 'semi-real', 'synthetic']) {
    const rs = runs.filter((r) => r.set === name);
    if (!rs.length) continue;
    sets[name] = { label: LABELS[name] ?? name, clips: [...new Set(rs.map((r) => r.clip))], ...R.scoreRuns(rs), poseReadings: setInfo[name]?.poseReadings, motion: setInfo[name]?.motion };
  }
  const failures = Object.entries(sets).flatMap(([n, s]) => s.gate.failures.map((f) => `[${n}] ${f}`));
  const commit = await getJson('/__commit').catch(() => ({}));
  const report = {
    schema: R.SCHEMA,
    generated: new Date().toISOString(),
    commit: commit.commit ?? null, dirty: commit.dirty ?? null,
    seed: R.SEED,
    realClips: clips.filter((c) => c.set === 'real').length,
    ownerClips: clips.filter((c) => c.set === 'owner').length,
    excludedTakes,
    modelled: R.MODELLED,
    pending: R.PENDING,
    clips: clips.map(({ clip, set, synthetic, url }) => ({ name: clip.name, url, set, synthetic, frames: clip.frames?.length ?? 0, durationMs: clip.durationMs ?? null, ...R.expectedOf(clip.gesture ?? clip.name) })),
    variants: variants.map((v) => v.id),
    sets,
    gate: { pass: failures.length === 0, failures },
    runs,
    runtimeMs: Math.round(performance.now() - t0)
  };
  // ?compare=1: diff against the saved docs/lab/gestures/report.json in the page too. Off by
  // default because the first run has no report.json and the 404 lands in the console; the
  // CLI (replay.js --write) always compares on disk.
  const prev = q.get('compare') && !scoped ? await getJson(`./report.json${V}`).catch(() => null) : null;
  const diff = q.get('compare') ? R.diffReports(prev, report) : null;
  report.comparedTo = prev ? `docs/lab/gestures/report.json (${prev.generated})` : null;
  const md = R.renderMd(report, diff);
  window.__replayReport = report;
  window.__replayReportMd = md;
  $('out').textContent = md;
  if (rec) {
    for (const [n, S] of Object.entries(sets)) {
      for (const [g, s] of Object.entries(S.perGesture)) {
        // A pending class can't fire yet: an info row, not a failed check.
        const pend = R.PENDING.includes(g) || g.endsWith(' (pending)');
        if (g !== 'none') rec.result(`[${n}] ${g} fires${pend && !g.endsWith(')') ? ' (pending)' : ''}`, `${s.fires}/${s.runs}`, pend ? {} : { pass: s.misses === 0 });
        rec.metric(`${n}.fires.${g}`, s.fires);
        rec.metric(`${n}.falseFireRuns.${g}`, s.falseFireRuns);
      }
      rec.result(`[${n}] confusion gate`, S.gate.failures.length, { pass: S.gate.pass });
    }
    for (const r of runs.filter((x) => x.variant === 'base')) rec.result(`${r.clip} base`, Object.keys(r.fired), r.pending ? {} : { pass: r.pass });
    if (!report.realClips && !report.ownerClips) rec.flag('no-real-clips', 'fixtures only (semi-real + synthetic): no owner clips recorded yet');
    rec.attach('report', report);
    const saved = await rec.end('done');
    report.savedTo = saved?.path ?? saved?.saved ?? null;
  }
  $('status').textContent = `done: ${report.gate.pass ? 'PASS' : 'FAIL'} · ${runs.length} runs in ${report.runtimeMs} ms${report.ownerClips ? ` · ${report.ownerClips} owner takes${excludedTakes ? ` (${excludedTakes} ✗ left out)` : ''}` : ''}${report.realClips || report.ownerClips ? '' : ' · NO REAL CLIPS'} · ${Object.entries(sets).map(([n, s]) => `${n} ${s.gate.pass ? 'PASS' : 'FAIL'}`).join(', ')}`;
} catch (err) {
  console.error(err);
  $('status').textContent = `error: ${err?.message ?? err}`;
  rec?.end('crashed');
}

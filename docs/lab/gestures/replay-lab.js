// Replay lab page: replays every recorded clip (assets/gesture-clips/index.json) and every
// fixture (fixtures/index.json) through the shipped pipeline via replay.js, under every stress
// variant, and shows the per-gesture report + confusion matrix + gate.
//
// Output: window.__replayReport (JSON, schema replay.js SCHEMA), window.__replayReportMd, and
// #status = 'done: PASS' | 'done: FAIL' | 'error: …'. On localhost the run is saved through
// testrec.js -> serve.py (docs/testing/runs/replay-lab/), with the report attached; then
// `replay.js --write` turns that run into docs/lab/gestures/report.json + REPORT.md.
// ?compare=1 also diffs against the saved report.json in the page. ?clips=a,b limits the clips (records under page id 'replay-lab-only' so it never compares
// against a full run); ?variants=base,mirror limits the variants.

const V = `?v=${Date.now()}`;
const R = await import(`./replay.js${V}`);
const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const onlyClips = q.get('clips')?.split(',') ?? null;
const onlyVariants = q.get('variants')?.split(',') ?? null;
const scoped = !!(onlyClips || onlyVariants);

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
async function loadClips() {
  const list = [];
  const real = await getJson('../../../assets/gesture-clips/index.json').catch(() => ({ clips: [] }));
  for (const e of real.clips ?? []) {
    const name = typeof e === 'string' ? e : e.name;
    if (name) list.push({ url: `../../../assets/gesture-clips/${name}.json`, set: 'real' });
  }
  const fx = await getJson('./fixtures/index.json').catch(() => ({ clips: [] }));
  setInfo = fx.sets ?? {};
  for (const e of fx.clips ?? []) list.push({ url: `./fixtures/${e.file}`, set: e.set ?? (e.synthetic ? 'synthetic' : 'semi-real') });
  const clips = [];
  for (const it of list) {
    const c = await getJson(it.url);
    if (onlyClips && !onlyClips.includes(c.name)) continue;
    clips.push({ clip: c, set: it.set, synthetic: it.set === 'synthetic', url: it.url });
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
      runs.push({ clip: clip.name, set, synthetic, variant: v.id, expected: exp.expected, allowed: exp.allowed, fired: out.fired, channels: out.channels, clicks: out.clicks, wheel: out.wheel, frames: out.frames });
    }
  }
  // One score block per set: real owner clips, semi-real, synthetic never pool together.
  const LABELS = { real: 'the owner\'s recorded clips (clip-lab)', ...Object.fromEntries(Object.entries(setInfo).map(([k, v]) => [k, v.label])) };
  const sets = {};
  for (const name of ['real', 'semi-real', 'synthetic']) {
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
    modelled: R.MODELLED,
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
        if (g !== 'none') rec.result(`[${n}] ${g} fires`, `${s.fires}/${s.runs}`, { pass: s.misses === 0 });
        rec.metric(`${n}.fires.${g}`, s.fires);
        rec.metric(`${n}.falseFireRuns.${g}`, s.falseFireRuns);
      }
      rec.result(`[${n}] confusion gate`, S.gate.failures.length, { pass: S.gate.pass });
    }
    for (const r of runs.filter((x) => x.variant === 'base')) rec.result(`${r.clip} base`, Object.keys(r.fired), { pass: r.pass });
    if (!report.realClips) rec.flag('no-real-clips', 'fixtures only (semi-real + synthetic): no owner clips recorded yet');
    rec.attach('report', report);
    const saved = await rec.end('done');
    report.savedTo = saved?.path ?? saved?.saved ?? null;
  }
  $('status').textContent = `done: ${report.gate.pass ? 'PASS' : 'FAIL'} · ${runs.length} runs in ${report.runtimeMs} ms${report.realClips ? '' : ' · NO REAL CLIPS'} · ${Object.entries(sets).map(([n, s]) => `${n} ${s.gate.pass ? 'PASS' : 'FAIL'}`).join(', ')}`;
} catch (err) {
  console.error(err);
  $('status').textContent = `error: ${err?.message ?? err}`;
  rec?.end('crashed');
}

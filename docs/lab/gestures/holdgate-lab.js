// Hold gate lab: scripted frames through holdGate.js, PASS/FAIL per scenario.
//
// No camera and no hands: each scenario is a function of time returning exactly what
// hologram.js would pass to gate.update() (pose, confidence, wrist, span). That makes it a
// test of the gate's TIMING RULES, not of pose recognition or of how the ring feels on a real
// webcam. Deterministic: fixed timestamps and a seeded RNG.
//
// These checks belong in test.js eventually (test.js was owned by another agent when this was
// written); runScenarios() is exported so test.js can import and assert on it directly.
//
// Browser: http://localhost:8080/docs/lab/gestures/holdgate-lab.html
// Node-ish: import this file from any ESM runner; with no `document` it prints to the console
//           and sets a non-zero exit code on failure.

const V = typeof location !== 'undefined' ? `?v=${Date.now()}` : '';
const { createHoldGate, HOLD_GATE } = await import(`../../../holdGate.js${V}`);

const T0 = 1000; // non-zero start so a 0 timestamp can't hide a sentinel bug
const SPAN = 100; // hand span, px
const HOME = { x: 320, y: 240 };

// frame input: pose or null; hand:false means no hand tracked at all
const frame = (pose, { conf = 0.95, x = HOME.x, y = HOME.y, hand = true } = {}) =>
  ({ pose, confidence: conf, wristPos: hand ? { x, y } : null, spanPx: SPAN });
const gone = () => frame(null, { hand: false });
const other = () => frame(null); // hand visible, no command pose (open hand)

// Runs script(tRel) at a fixed fps (or at explicit relative times) for durationMs.
// Returns [{ t, out }] with t relative to the run start.
function drive(script, { fps = 30, durationMs = 1500, times = null, gate = createHoldGate() } = {}) {
  const ts = times ?? Array.from({ length: Math.floor((durationMs * fps) / 1000) + 1 }, (_, i) => (i * 1000) / fps);
  return ts.map((t) => ({ t, out: gate.update({ ...script(t), timestampMs: T0 + t }) }));
}
const fires = (rows) => rows.filter((r) => r.out.fired);
const firstFire = (rows, pose) => rows.find((r) => r.out.fired && (!pose || r.out.fired === pose));
const ms = (t) => (t == null ? 'never' : `${Math.round(t)} ms`);

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// Each scenario returns { pass, detail }. Tolerance for "fires at X" is one frame interval:
// the gate can only fire on a frame, and a frame's dt is only known when it arrives.
const RING = HOLD_GATE.ringMs;
const SHORT = HOLD_GATE.shortMs;
const within = (t, target, frameMs) => t != null && t >= target && t <= target + frameMs + 1e-6;

const scenarios = [
  ['steady undo fires at ~650 ms, exactly once', () => {
    const rows = drive(() => frame('undo'));
    const f = firstFire(rows)?.t;
    return { pass: within(f, RING, 1000 / 30) && fires(rows).length === 1, detail: `fired at ${ms(f)}, ${fires(rows).length} fire(s) in 1.5 s` };
  }],

  ['ring invisible for the first 200 ms of charge, then fills to 1 at the fire', () => {
    const rows = drive(() => frame('undo'), { durationMs: 700 });
    const early = rows.filter((r) => r.t <= HOLD_GATE.graceVisibleMs && r.out.visibleProgress > 0);
    const firstVisible = rows.find((r) => r.out.visibleProgress > 0)?.t;
    const f = firstFire(rows);
    let mono = true;
    for (let i = 1; i < rows.length && rows[i] !== f; i++) if (rows[i].out.visibleProgress < rows[i - 1].out.visibleProgress) mono = false;
    return {
      pass: early.length === 0 && firstVisible > HOLD_GATE.graceVisibleMs && f?.out.visibleProgress === 1 && mono,
      detail: `first visible at ${ms(firstVisible)}, visibleProgress at fire ${f?.out.visibleProgress}, monotonic ${mono}`,
    };
  }],

  ['wrist motion pauses the ring (no reset, no fire while moving)', () => {
    // still 300 ms, then slide sideways at 3 spans/s for 400 ms, then still again
    const xAt = (t) => HOME.x + (t < 300 ? 0 : Math.min(t - 300, 400) * 0.3);
    const rows = drive((t) => frame('undo', { x: xAt(t) }), { durationMs: 2000 });
    // steadiness is wrist travel over the last 200 ms, so 3 spans/s trips 0.35 spans after
    // ~117 ms of motion; check from 450 ms on
    const moving = rows.filter((r) => r.t > 450 && r.t < 700);
    const f = firstFire(rows)?.t;
    const pausedSeen = moving.every((r) => r.out.phase === 'paused');
    const kept = moving.every((r) => r.out.progress > 0.3);
    // resumes once the 200 ms steadiness window is clear of motion: ~650 + 400 + <=200
    return { pass: pausedSeen && kept && f > 700 && f <= RING + 400 + 200 + 34, detail: `paused while moving ${pausedSeen}, progress kept ${kept}, fired at ${ms(f)}` };
  }],

  ['1-2 frame tracking dropout pauses, does not reset', () => {
    const rows = drive((t) => (t > 390 && t < 460 ? gone() : frame('undo')), { durationMs: 1200 }); // 2 frames at 30 fps
    const before = rows.filter((r) => r.t <= 390).at(-1).out.progress;
    const after = rows.find((r) => r.t >= 460).out.progress;
    const f = firstFire(rows)?.t;
    return { pass: after >= before && f <= RING + 67 + 34, detail: `progress ${before.toFixed(2)} -> ${after.toFixed(2)} across dropout, fired at ${ms(f)}` };
  }],

  ['1 low-confidence frame and a 150 ms blip both only pause', () => {
    const lowConf = drive((t) => frame('undo', { conf: Math.abs(t - 300) < 10 ? 0.5 : 0.95 }));
    const blip = drive((t) => (t >= 300 && t < 450 ? gone() : frame('undo')));
    const a = firstFire(lowConf)?.t;
    const b = firstFire(blip)?.t;
    return { pass: a <= RING + 34 + 34 && b <= RING + 150 + 34, detail: `low-conf frame: fired at ${ms(a)}; 150 ms blip: fired at ${ms(b)}` };
  }],

  ['300 ms of bad frames resets the ring', () => {
    const rows = drive((t) => (t >= 400 && t < 750 ? gone() : frame('undo')), { durationMs: 2000 });
    const resumed = rows.find((r) => r.t >= 750);
    const f = firstFire(rows)?.t;
    return { pass: resumed.out.progress === 0 && within(f, resumed.t + RING, 34), detail: `progress on return ${resumed.out.progress}, fired at ${ms(f)} (reset => >= ${ms(resumed.t + RING)})` };
  }],

  ['no double fire while held (3 s hold, plus a 500 ms blip mid-hold)', () => {
    const hold = drive(() => frame('undo'), { durationMs: 3000 });
    const blip = drive((t) => (t >= 1200 && t < 1700 ? gone() : frame('undo')), { durationMs: 3000 });
    const heldAfter = hold.filter((r) => r.t > 700).every((r) => r.out.phase === 'held');
    return { pass: fires(hold).length === 1 && fires(blip).length === 1 && heldAfter, detail: `fires: steady ${fires(hold).length}, with blip ${fires(blip).length}; phase 'held' after fire ${heldAfter}` };
  }],

  ['release (open hand 300 ms) then re-pose fires again', () => {
    // hide: undo would drop to the short tier here, which is the next scenario's job
    const rows = drive((t) => (t >= 1000 && t < 1300 ? other() : frame('hide')), { durationMs: 2500 });
    const f = fires(rows).map((r) => r.t);
    return { pass: f.length === 2 && f[1] >= 1300 + SHORT && f[1] <= 1300 + SHORT + 34, detail: `fires at ${f.map(ms).join(', ')} (repeat within 2 s => short tier)` };
  }],

  ['a 150 ms look-away is NOT a release; hand gone 800 ms IS', () => {
    const brief = drive((t) => (t >= 1000 && t < 1150 ? other() : frame('hide')), { durationMs: 2500 });
    const left = drive((t) => (t >= 1000 && t < 1800 ? gone() : frame('hide')), { durationMs: 2800 });
    return { pass: fires(brief).length === 1 && fires(left).length === 2, detail: `fires: 150 ms other ${fires(brief).length}, 800 ms gone ${fires(left).length}` };
  }],

  ['repeat window: second undo within 2 s is short-tier and never shows a ring', () => {
    const inWin = drive((t) => (t >= 800 && t < 1100 ? other() : frame('undo')), { durationMs: 1600 });
    const outWin = drive((t) => (t >= 800 && t < 2800 ? other() : frame('undo')), { durationMs: 3800 });
    const second = fires(inWin)[1];
    const late = fires(outWin)[1];
    const hidden = inWin.filter((r) => r.t >= 1100).every((r) => r.out.visibleProgress === 0);
    return {
      pass: second && second.t - 1100 <= SHORT + 34 && second.out.tier === 'short' && hidden && late && late.t - 2800 >= RING && late.out.tier === 'ring',
      detail: `in window: +${ms(second && second.t - 1100)} (${second?.out.tier}, ring hidden ${hidden}); after window: +${ms(late && late.t - 2800)} (${late?.out.tier})`,
    };
  }],

  ['different pose mid-charge restarts (early: at once; late: after the 300 ms grace)', () => {
    const early = drive((t) => frame(t < 150 ? 'undo' : 'hide'), { durationMs: 1500 });
    const late = drive((t) => frame(t < 400 ? 'undo' : 'hide'), { durationMs: 2000 });
    const e = firstFire(early);
    const l = firstFire(late);
    return {
      pass: fires(early).length === 1 && e.out.fired === 'hide' && within(e.t, 150 + RING, 34) &&
        fires(late).length === 1 && l.out.fired === 'hide' && l.t >= 400 + 300 + RING - 34 && l.t <= 400 + 300 + RING + 34,
      detail: `switch at 150 ms: ${e?.out.fired} at ${ms(e?.t)}; switch at 400 ms: ${l?.out.fired} at ${ms(l?.t)} (undo never fired)`,
    };
  }],

  ['short-tier select fires at ~200 ms, no visible ring', () => {
    const rows = drive(() => frame('select'), { durationMs: 800 });
    const f = firstFire(rows);
    const hidden = rows.every((r) => r.out.visibleProgress === 0);
    return { pass: within(f?.t, SHORT, 34) && f.out.tier === 'short' && fires(rows).length === 1 && hidden, detail: `fired at ${ms(f?.t)}, tier ${f?.out.tier}, ring hidden ${hidden}` };
  }],

  ['frame-rate independence at 10 / 15 / 30 / 60 fps (undo and select)', () => {
    const res = [10, 15, 30, 60].map((fps) => {
      const u = firstFire(drive(() => frame('undo'), { fps }))?.t;
      const s = firstFire(drive(() => frame('select'), { fps }))?.t;
      return { fps, u, s, ok: within(u, RING, 1000 / fps) && within(s, SHORT, 1000 / fps) };
    });
    return { pass: res.every((r) => r.ok), detail: res.map((r) => `${r.fps}fps undo ${ms(r.u)} select ${ms(r.s)}`).join(' · ') };
  }],

  ['irregular frame timing (16-100 ms gaps, seeded) still fires within one frame of 650', () => {
    const times = [0];
    const gaps = [];
    while (times.at(-1) < 1500) { const g = 16 + rnd() * 84; gaps.push(g); times.push(times.at(-1) + g); }
    const rows = drive(() => frame('undo'), { times });
    const f = firstFire(rows)?.t;
    return { pass: f >= RING && f <= RING + 100, detail: `fired at ${ms(f)}` };
  }],

  ['stalled tab: a 2 s gap adds at most 100 ms of charge', () => {
    const rows = drive(() => frame('undo'), { times: [0, 33, 2033, 2066] });
    const p = rows[2].out.progress;
    return { pass: !fires(rows).length && p <= (33 + 100) / RING + 1e-9, detail: `progress after the gap ${p.toFixed(3)}, fires ${fires(rows).length}` };
  }],

  ['wiggle after firing does not release (no accidental second undo)', () => {
    const xAt = (t) => HOME.x + (t > 800 ? Math.sin(t / 40) * 60 : 0); // +-0.6 span shake
    const rows = drive((t) => frame('undo', { x: xAt(t) }), { durationMs: 2500 });
    const asl = drive((t) => frame('undo', { x: xAt(t) }), { durationMs: 2500, gate: createHoldGate({ releaseSpans: 0.6 }) });
    return { pass: fires(rows).length === 1, detail: `fires: default ${fires(rows).length}; with ASL motion release (releaseSpans 0.6) ${fires(asl).length}` };
  }],

  ['low confidence (0.7) and unknown poses never charge', () => {
    const low = drive(() => frame('undo', { conf: 0.7 }));
    const unk = drive(() => frame('grab'));
    const idle = [...low, ...unk].every((r) => r.out.phase === 'idle' && r.out.progress === 0);
    return { pass: !fires(low).length && !fires(unk).length && idle, detail: `fires ${fires(low).length}/${fires(unk).length}, all idle ${idle}` };
  }],

  ['reset() forgets the held pose and the repeat window', () => {
    const gate = createHoldGate();
    const a = drive(() => frame('undo'), { gate, durationMs: 700 });
    gate.reset();
    const b = drive(() => frame('undo'), { gate, durationMs: 1000 });
    const f = firstFire(b);
    return { pass: fires(a).length === 1 && within(f?.t, RING, 34) && f.out.tier === 'ring', detail: `after reset: fired at ${ms(f?.t)} (${f?.out.tier})` };
  }],

  ['bad input never throws; bad tier config does', () => {
    const gate = createHoldGate();
    let threw = false;
    try {
      for (const x of [undefined, {}, { timestampMs: NaN }, { pose: 5, timestampMs: 1 }, { pose: 'undo', wristPos: { x: NaN }, timestampMs: 2 }, { pose: 'undo', confidence: 'hi', spanPx: -1, timestampMs: 3 }]) gate.update(x);
    } catch { threw = true; }
    let cfgThrew = false;
    try { createHoldGate({ tiers: { undo: 'rng' } }); } catch (e) { cfgThrew = e instanceof TypeError; }
    return { pass: !threw && cfgThrew, detail: `update threw ${threw}, typo'd tier threw TypeError ${cfgThrew}` };
  }],
];

export function runScenarios() {
  return scenarios.map(([name, fn]) => {
    seed = 7;
    try { return { name, ...fn() }; } catch (e) { return { name, pass: false, detail: `crashed: ${e && e.stack || e}` }; }
  });
}

const results = runScenarios();
const passed = results.filter((r) => r.pass).length;
const lines = [
  `Hold gate lab — ${passed}/${results.length} PASS  (ringMs ${RING}, shortMs ${SHORT}, graceVisibleMs ${HOLD_GATE.graceVisibleMs}, graceMs ${HOLD_GATE.graceMs}, repeatWindowMs ${HOLD_GATE.repeatWindowMs})`,
  'Scripted frames, not a webcam: this proves the timing rules, not how the ring feels.',
  '',
  ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`),
];

if (typeof document !== 'undefined') {
  window.__holdGateReport = results;
  const status = document.getElementById('status');
  status.textContent = passed === results.length ? `done — all ${passed} PASS` : `done — ${results.length - passed} FAIL`;
  status.classList.toggle('fail', passed !== results.length);
  document.getElementById('out').textContent = lines.join('\n');
} else {
  console.log(lines.join('\n'));
  if (passed !== results.length && typeof process !== 'undefined') process.exitCode = 1;
}

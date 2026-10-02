// Hands v2 calibration checks (calibrate.js createCalibration({ v2: true }) + its pure fitters).
// Plans: plans/hands-v2/CONTRACT.md §4, Ricky's report §2-5.
//
// CONTRACT
//   run(check) -> Promise<{ passed, failed }>
//     check(name, pass, detail): one result row (test.js checkTrue has this shape). Runs in Node
//     (a tiny DOM stub stands in for the card) and in a page; never touches real localStorage
//     (the flow saves into an in-memory storage).
//
// The flow check drives the same calls as handsRuntime.processFrameV2's calibrating branch:
// handFeatures.update on the raw hands -> gestures.annotateHand (v2) -> pointer v2 update ->
// calibration.onClick(click) -> calibration.onFrame(hands). Hands are built in gun-lab's world
// model (test.js handFeatures group) and projected orthographically; a closed-loop "user" steers
// the cursor onto each target, then drops the thumb.

const V = typeof location !== 'undefined' ? `?v=${Date.now()}` : '';
const A = 16 / 9;
const FR = 1000 / 30;
const VIEW = { left: 0, top: 0, width: 1460, height: 821 };

// ---- synthetic hands (copy of test.js's handFeatures builder) ----
const MCP = { index: [0.03, 0.085, 0], middle: [0.008, 0.09, 0], ring: [-0.012, 0.085, 0], pinky: [-0.03, 0.075, 0] };
const BONES = { index: [0.04, 0.025, 0.02], middle: [0.045, 0.028, 0.02], ring: [0.042, 0.026, 0.02], pinky: [0.032, 0.02, 0.018] };
const FLEX = { straight: [0, 0, 0], curled: [80, 100, 60] };
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const WRAP = [0.05, 0.085, -0.03];
export function mk({ fingers = {}, thumb = fingers.index === 'curled' ? { tip: WRAP } : { deg: 50 }, hand = 'Right', x = 0.5, y = 0.55, label = 'None' } = {}) {
  const w = Array.from({ length: 21 }, () => [0, 0, 0]);
  ['index', 'middle', 'ring', 'pinky'].forEach((name, f) => {
    const flex = FLEX[fingers[name] ?? 'straight'];
    let p = MCP[name].slice();
    w[5 + f * 4] = p;
    let th = 0;
    for (let b = 0; b < 3; b++) {
      th += (flex[b] * Math.PI) / 180;
      p = [p[0], p[1] + BONES[name][b] * Math.cos(th), p[2] - BONES[name][b] * Math.sin(th)];
      w[6 + f * 4 + b] = p;
    }
  });
  w[1] = [0.012, 0.02, -0.003];
  w[2] = [0.022, 0.035, -0.004];
  const palm = Math.hypot(...w[9]);
  if (thumb.tip) {
    w[4] = thumb.tip.slice();
    w[3] = add(w[2], add(w[4], w[2], -1), 0.5);
  } else if (thumb.pinchGap != null) {
    w[4] = add(w[8], [0, 0, -1], thumb.pinchGap * palm);
    w[3] = add(w[2], add(w[4], w[2], -1), 0.5);
  } else {
    const u = [0.03 / 0.0901, 0.085 / 0.0901, 0], perp = [u[1], -u[0], 0], t = (thumb.deg * Math.PI) / 180;
    const d = [u[0] * Math.cos(t) + perp[0] * Math.sin(t), u[1] * Math.cos(t) + perp[1] * Math.sin(t), 0];
    w[3] = add(w[2], d, 0.033);
    w[4] = add(w[2], d, 0.06);
  }
  const k = 0.12 / 0.09;
  const mir = hand === 'Left' ? -1 : 1; // a left hand is the mirror image (thumb on the other side)
  return {
    handedness: hand, gesture: label, score: 0.9,
    landmarks: w.map(([px, py, pz]) => ({ x: x + (mir * px * k) / A, y: y - py * k, z: pz * k })),
    worldLandmarks: w.map(([px, py, pz]) => ({ x: mir * px, y: py, z: pz }))
  };
}
const GUN = { middle: 'curled', ring: 'curled', pinky: 'curled' };
const FIST = { index: 'curled', middle: 'curled', ring: 'curled', pinky: 'curled' };

// ---- a DOM just big enough for the card (Node has none) ----
function stubDoc() {
  const mkEl = () => {
    const e = { style: {}, dataset: {}, textContent: '', children: [], listeners: {} };
    e.append = (...c) => e.children.push(...c);
    e.remove = () => {};
    e.addEventListener = (type, fn) => { (e.listeners[type] ??= []).push(fn); };
    return e;
  };
  return { createElement: mkEl, body: mkEl() };
}
function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

let seed = 3;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const gauss = (mu, sd) => mu + sd * (rnd() + rnd() + rnd() - 1.5) * 1.41;

// The synthetic "user" for the v2 flow: open hand, reach ellipse, aim + thumb drops (cocked 46°,
// dropped 26°), 5 pinches, 3 claps, 3 fists. frame(hands) feeds one camera frame and returns the
// pointer's click; cursor() = pointer.state; target() = the hammer target element. Shared by the
// Node check below and the in-page runtime check (scratch), so both play the same person.
export function playUser({ c, frame, cursor, target, view = VIEW }) {
  for (let n = 0; c.step === 'hand' && n < 200; n++) frame([mk({ x: 0.5, y: 0.6 })]);
  // Reach: a relaxed ellipse with the finger-gun (index MCP sweeps ±0.18 x, ±0.13 y).
  let k = 0;
  for (let n = 0; c.step === 'reach' && n < 500; n++) {
    const a = (k++ / 90) * 2 * Math.PI;
    frame([mk({ fingers: GUN, thumb: { deg: 60 }, x: 0.48 + 0.18 * Math.cos(a), y: 0.62 + 0.13 * Math.sin(a) })]);
  }
  // Hammer: this "person" cocks to 46° and drops to 26°, with a thumb gap that hovers near the
  // default bands, so how many clicks the defaults catch is whatever the default rules say.
  let hx = 0.48, hy = 0.62, phase = 'aim', ph = 0, deg = 46;
  const UP = 46, DOWN = 26;
  let liveClicks = 0;
  for (let n = 0; c.step === 'hammer' && n < 1800; n++) {
    const cur = cursor();
    // Steer: cursor px from NDC, err toward the visible target (its element's left/top).
    const tEl = target();
    const tx = parseFloat(tEl.style.left), ty = parseFloat(tEl.style.top);
    const cx = view.left + ((cur.x + 1) / 2) * view.width, cy = view.top + ((1 - cur.y) / 2) * view.height;
    const ex = tx - cx, ey = ty - cy;
    if (phase === 'aim') {
      hx += Math.max(-0.006, Math.min(0.006, -ex * 0.00004));
      hy += Math.max(-0.006, Math.min(0.006, ey * 0.00004));
      if (tEl.style.opacity === '1' && Math.hypot(ex, ey) < 8 && cur.mode === 'aim') { if (++ph > 8) { phase = 'drop'; ph = 0; } } else ph = 0;
    } else if (phase === 'drop') {
      deg = Math.max(DOWN, deg - 8);
      if (deg === DOWN && ++ph > 6) { phase = 'up'; ph = 0; }
    } else if (phase === 'up') {
      deg = Math.min(UP, deg + 5);
      if (deg === UP && ++ph > 8) { phase = 'aim'; ph = 0; }
    }
    if (frame([mk({ fingers: GUN, thumb: { deg }, x: hx + gauss(0, 0.0005), y: hy + gauss(0, 0.0005) })])) liveClicks++;
  }
  const hammerDone = !!c.drill || c.step !== 'hammer';
  // Pinch x5.
  for (let n = 0; n < 8 && c.step === 'pinch'; n++) {
    for (let i = 0; i < 10; i++) frame([mk({ thumb: { pinchGap: 0.05 } })]);
    for (let i = 0; i < 12; i++) frame([mk({ thumb: { deg: 50 } })]);
  }
  for (let i = 0; i < 30 && c.step === 'pinch'; i++) frame([mk({ thumb: { deg: 50 } })]);
  // Clap x3: two open hands from 0.40 apart to 0.03, ~0.4 s each way.
  for (let n = 0; n < 6 && c.step === 'clap'; n++) {
    const at = (d) => [mk({ hand: 'Right', x: 0.5 - d / 2 }), mk({ hand: 'Left', x: 0.5 + d / 2 })];
    for (let i = 0; i < 12; i++) frame(at(0.4));
    for (let i = 0; i <= 12; i++) frame(at(0.4 - (0.37 * i) / 12));
    for (let i = 0; i <= 12; i++) frame(at(0.03 + (0.37 * i) / 12));
  }
  for (let i = 0; i < 30 && c.step === 'clap'; i++) frame([]);
  // Fist x3.
  for (let n = 0; n < 6 && c.step === 'fist'; n++) {
    for (let i = 0; i < 12; i++) frame([mk({ fingers: FIST })]);
    for (let i = 0; i < 12; i++) frame([mk()]);
  }
  for (let i = 0; i < 150 && c.active; i++) frame([]);
  return { liveClicks, hammerDone };
}

export async function run(check) {
  let passed = 0;
  let failed = 0;
  const ok = (name, pass, detail = '') => { check(name, !!pass, detail); pass ? passed++ : failed++; };
  const cal = await import(`./calibrate.js${V}`);
  const { createHandFeatures, HF } = await import(`./handFeatures.js${V}`);
  const ges = await import(`./gestures.js${V}`);
  const ptr = await import(`./pointer.js${V}`);

  // 1. Hammer fit: clean bands -> p20 / p80, both features; overlap -> kept + warned.
  {
    seed = 3;
    const fr = [];
    for (let i = 0; i < 200; i++) fr.push({ deg: gauss(62, 5), gap: gauss(0.75, 0.06) });
    for (let i = 0; i < 60; i++) fr.push({ deg: gauss(18, 4), gap: gauss(0.2, 0.04) });
    const f = cal.fitHammer(fr, { drops: 8 });
    const T = f.thresholds;
    ok('fitHammer: cock = p20 of cocked, drop = p80 of dropped, ≥15° apart, gap fitted too',
      T.COCK_DEG > 50 && T.COCK_DEG < 62 && T.DROP_DEG > 18 && T.DROP_DEG < 26 && T.COCK_GAP > 0.6 && T.DROP_GAP < 0.3 && !f.warnings.length,
      JSON.stringify(T));
    const leak = fr.map((x) => (x.deg < 30 ? { ...x, gap: gauss(0.7, 0.05) } : x));
    const g = cal.fitHammer(leak, { drops: 8 });
    ok('fitHammer: a gap that doesn\'t separate is switched off (angle alone decides) + warned',
      g.thresholds.COCK_GAP === 9 && g.thresholds.DROP_GAP === 9 && Number.isFinite(g.thresholds.COCK_DEG) && g.warnings.some((w) => /gap/.test(w)),
      JSON.stringify(g.thresholds));
    const flat = cal.fitHammer(fr.map((x) => ({ ...x, deg: gauss(40, 3) })), { drops: 8 });
    const few = cal.fitHammer(fr, { drops: 1 });
    ok('fitHammer: no thumb movement or <3 drops -> no thresholds, a warning',
      !Object.keys(flat.thresholds).length && !Object.keys(few.thresholds).length && flat.warnings.length && few.warnings.length);
    const close = cal.fitHammer([...Array(80)].map((_, i) => ({ deg: i < 50 ? gauss(42, 2) : gauss(30, 2), gap: 0.5 })), { drops: 5 });
    ok('fitHammer: bands <15° apart are applied but warned', Number.isFinite(close.thresholds.COCK_DEG) && close.warnings.some((w) => /apart/.test(w)),
      `${close.thresholds.COCK_DEG}/${close.thresholds.DROP_DEG}`);
  }

  // 2. Pinch / clap / fist / gains fitters.
  {
    const p = cal.fitPinch([0.05, 0.06, 0.08, 0.07, 0.09], [0.6, 0.7, 0.65, 0.8, 0.55], { pinches: 5 });
    ok('fitPinch: on/off between this person\'s closed and open ratios, on < off',
      p.thresholds.PINCH_ON > 0.08 && p.thresholds.PINCH_ON < p.thresholds.PINCH_OFF && p.thresholds.PINCH_OFF < 0.55, JSON.stringify(p.thresholds));
    const same = cal.fitPinch([0.3, 0.32], [0.33, 0.35], { pinches: 5 });
    ok('fitPinch: closed ≈ open -> kept + warned', !Object.keys(same.thresholds).length && same.warnings.length);
    const c = cal.fitClap([{ preMax: 4, minSpan: 0.5, peakV: 9 }, { preMax: 3, minSpan: 0.7, peakV: 5 }, { preMax: 5, minSpan: 0.4, peakV: 12 }]);
    ok('fitClap: arm below the narrowest start, contact above the widest touch, V_MIN = slowest × 0.6',
      c.thresholds.CLAP_ARM_SPAN === 2.4 && c.thresholds.CLAP_CONTACT_SPAN > 0.7 && c.thresholds.CLAP_CONTACT_SPAN < c.thresholds.CLAP_ARM_SPAN && c.thresholds.CLAP_V_MIN === 3,
      JSON.stringify(c.thresholds));
    const f1 = cal.fitFist([90, 95, 100], [10, 20], { fists: 3 });
    const f2 = cal.fitFist([52, 55, 58], [10, 20], { fists: 3 });
    ok('fitFist: a fist the default reads is left alone; a looser one lowers CLOSED_ENTER (≥15° above open)',
      !Object.keys(f1.thresholds).length && f2.thresholds.CLOSED_ENTER_DEG < HF.CLOSED_ENTER_DEG && f2.thresholds.CLOSED_ENTER_DEG >= 35 && f2.thresholds.CLOSED_EXIT_DEG < f2.thresholds.CLOSED_ENTER_DEG,
      JSON.stringify(f2.thresholds));
    const hi = cal.fitGains({ overshootRate: 0.8 });
    const lo = cal.fitGains({ overshootRate: 0, acquireMedianMs: 2500 });
    const r = cal.fitGains({ vHigh: 0.3, reachHalfM: 0.1 });
    ok('fitGains: overshoot lowers Gmin, slow acquisition raises it; V_HIGH -> vinf; reach -> absGain',
      hi.gmin < 1.5 && lo.gmin > 1.5 && r.vinf === 0.12 && Math.abs(r.absGain - 7.3) < 0.01, `${hi.gmin} ${lo.gmin} ${r.vinf} ${r.absGain}`);
  }

  // 3. Storage + apply: round trip, never throws, v2 goes to features + pointer via applyProfile.
  {
    const st = memStorage();
    const prof = { v: 2, reach: { x0: 0.3, x1: 0.7, y0: 0.3, y1: 0.7 }, thresholds: { COCK_DEG: 44, PINCH_ON: 0.15, CLAP_V_MIN: 3 }, gains: { gmin: 1.2 } };
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const okSave = cal.saveProfileV2(prof, st);
    ok('profile v2: saved under hands.profile.v2, loads back, blocked storage -> null/false',
      okSave && st.map.has('hands.profile.v2') && cal.loadProfileV2(st)?.thresholds.COCK_DEG === 44 && cal.loadProfileV2(throwing) === null && cal.saveProfileV2(prof, throwing) === false && cal.loadProfile(st) === null);
    const hf = createHandFeatures();
    const p = ptr.createPointer({ v2: true, clickAlt: null });
    cal.applyProfile(prof, { pointer: p, features: hf });
    ok('applyProfile(v: 2): hf thresholds + pointer reach/gmin set; unknown keys ignored by hf',
      hf.thresholds.COCK_DEG === 44 && hf.thresholds.PINCH_ON === 0.15 && !('CLAP_V_MIN' in hf.thresholds) && p.profile.reach.x0 === 0.3 && p.profile.cursor.gmin === 1.2);
  }

  // 4. replayHammer: a thumb that never leaves the default "cocked" band only clicks after the fit.
  {
    const target = { x: 100, y: 100, r: 30 };
    const trialsOf = (up, down) => [...Array(5)].map(() => {
      const frames = [];
      let t = 0;
      for (let i = 0; i < 15; i++) frames.push({ t: (t += FR), deg: up, gap: 0.45, cx: 100, cy: 100 });
      for (let i = 0; i < 6; i++) frames.push({ t: (t += FR), deg: down, gap: 0.45, cx: 100, cy: 100 });
      return { target, frames };
    });
    const tr = trialsOf(45, 34);
    const before = cal.replayHammer(tr, {});
    const after = cal.replayHammer(tr, { COCK_DEG: 42, DROP_DEG: 37, COCK_GAP: 9, DROP_GAP: 9 });
    ok('replayHammer: same frames, old vs fitted thresholds (0/5 -> 5/5)', before.hits === 0 && after.hits === 5 && after.falseClicks === 0, `${before.hits} -> ${after.hits}`);
  }

  // 5. The whole flow on synthetic hands through the v2 pipeline (features -> annotate -> pointer).
  {
    const wasV2 = ges.handsV2Enabled();
    ges.setHandsV2(true);
    try {
      seed = 5;
      const doc = stubDoc();
      const st = memStorage();
      const hf = createHandFeatures();
      const p = ptr.createPointer({ v2: true, clickAlt: null });
      p.setView(VIEW.width / VIEW.height);
      let done = null;
      const c = cal.createCalibration({ v2: true, pointer: p, features: hf, rect: () => VIEW, doc, parent: doc.body, storage: st, aspect: A, onDone: (pr) => (done = pr) });
      let t = 1000;
      const steps = [];
      const frame = (hands) => {
        t += FR;
        hf.update(hands, t, { aspect: A });
        for (const h of hands) ges.annotateHand(h, A);
        const click = p.update(hands, A, t);
        c.onClick(click);
        c.onFrame(hands, t);
        if (steps[steps.length - 1] !== c.step) steps.push(c.step);
        return click;
      };
      c.start(t);
      ok('v2 calibration starts at the hand step; the card is marked v2', c.v2 === true && c.step === 'hand' && doc.body.children[0]?.dataset.v === '2');
      const { liveClicks, hammerDone } = playUser({ c, frame, cursor: () => p.state, target: () => doc.body.children[1] });
      const s = done?.score;
      ok('v2 flow visits hand → reach → hammer → pinch → clap → fist → summary → done',
        steps.join(',') === 'hand,reach,hammer,pinch,clap,fist,summary,done', steps.join(','));
      ok('v2 hand step: sizeM, finger lengths, palmPx measured',
        Math.abs(done?.sizeM - 0.09) < 0.005 && done?.fingersM?.index > 0.08 && done?.palmPx > 0.1, `sizeM ${done?.sizeM} index ${done?.fingersM?.index} palmPx ${done?.palmPx}`);
      ok('v2 reach: anchor box around the sweep + V_HIGH + absGain',
        done?.reach && done.reach.x1 - done.reach.x0 > 0.25 && done.reach.y1 - done.reach.y0 > 0.18 && done.vHigh > 0 && done.gains?.absGain > 0,
        `${JSON.stringify(done?.reach)} vHigh ${done?.vHigh} absGain ${done?.gains?.absGain}`);
      ok('v2 drills: 10 hammer ✓, 5 pinches, 3 claps, 3 fists',
        hammerDone && s?.hammer && s.pinch >= 5 && s.clap >= 3 && s.fist >= 3, `hammer trials ${s?.hammer?.after?.n} pinch ${s?.pinch} clap ${s?.clap} fist ${s?.fist} live clicks ${liveClicks}`);
      const T = done?.thresholds ?? {};
      ok('v2 fit: COCK/DROP between this thumb\'s 46°/26°, gap fitted or switched off, pinch + clap fitted',
        T.COCK_DEG > 36 && T.COCK_DEG <= 46 && T.DROP_DEG >= 26 && T.DROP_DEG < T.COCK_DEG && Number.isFinite(T.COCK_GAP) && T.PINCH_ON < T.PINCH_OFF && T.CLAP_ARM_SPAN > T.CLAP_CONTACT_SPAN && T.CLAP_V_MIN > 0,
        JSON.stringify(T));
      ok('v2 before → after hit rate shown, after ≥ before and ≥ 8/10',
        s?.hammer?.after.hits >= s?.hammer?.before.hits && s?.hammer?.after.hits >= 8,
        `clicks ${s?.hammer?.before.hits}/${s?.hammer?.before.n} → ${s?.hammer?.after.hits}/${s?.hammer?.after.n}; false ${s?.hammer?.before.falseClicks} → ${s?.hammer?.after.falseClicks}; warnings: ${(done?.warnings ?? []).join(' | ')}`);
      ok('v2 profile saved + applied to hf and pointer',
        cal.loadProfileV2(st)?.at === done?.at && hf.thresholds.COCK_DEG === T.COCK_DEG && hf.thresholds.PINCH_ON === T.PINCH_ON && p.profile.cursor.gmin === done?.gains?.gmin && p.profile.reach.x0 === done?.reach?.x0);

      // Live after the fit: the same thumb (46° -> 26°) now clicks through hf + pointer v2.
      {
        let clicks = 0;
        let d = 46;
        for (let n = 0; n < 3; n++) {
          for (let i = 0; i < 10; i++) if (frame([mk({ fingers: GUN, thumb: { deg: 46 }, x: 0.5, y: 0.62 })])?.via === 'hammer') clicks++;
          for (d = 46; d > 26; d -= 8) if (frame([mk({ fingers: GUN, thumb: { deg: Math.max(26, d - 8) }, x: 0.5, y: 0.62 })])?.via === 'hammer') clicks++;
          for (let i = 0; i < 8; i++) if (frame([mk({ fingers: GUN, thumb: { deg: 26 }, x: 0.5, y: 0.62 })])?.via === 'hammer') clicks++;
        }
        ok('after calibration the live pointer clicks on this thumb (3 drops -> 3 hammer clicks; 0 live before)', clicks === 3 && liveClicks === 0, `${clicks} clicks, ${liveClicks} during the drill`);
      }

      // Quick tune-up: drills only, hand + reach kept from the saved profile.
      c.start(t, { quick: true });
      const quickFirst = c.step;
      c.cancel();
      const kept = cal.loadProfileV2(st);
      ok('quick tune-up starts at the drills; Skip keeps the saved profile untouched',
        quickFirst === 'hammer' && c.quick === true && kept?.at === done?.at && !kept.skipped && hf.thresholds.COCK_DEG === T.COCK_DEG);
      ok('instructions: one line each, icon + verb first, a ✓ success line',
        Object.values(cal.V2_STEP_TEXT ?? {}).every(([, line, okLine]) => line.length <= 90 && /^\P{L}+ [A-Z]/u.test(line) && (okLine === '' || okLine.startsWith('✓'))) && Object.keys(cal.V2_STEP_TEXT ?? {}).length === 7);
    } finally {
      ges.setHandsV2(wasV2);
    }
  }

  // 6. v1 untouched: createCalibration without v2 is the old 3-step flow.
  {
    const doc = globalThis.document;
    if (doc) {
      const c = cal.createCalibration({ pointer: ptr.createPointer({ v2: false }), engagement: ptr.createEngagement(), rect: () => VIEW, storage: memStorage() });
      c.start(0);
      ok('v1 by default: createCalibration() without v2 starts the old hand step', c.v2 === undefined && c.step === 'hand');
      c.abort();
      c.dispose();
    } else {
      ok('v1 by default: createCalibration dispatches on opts.v2 only', cal.createCalibration.length === 1);
    }
  }

  return { passed, failed };
}

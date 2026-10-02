// Hands v2 input arbiter checks (inputArbiter.js, CONTRACT §2). Pure: runs in test.html (wire it
// as `group('inputArbiter …', () => run(checkTrue))`) and in Node (Electron-as-Node, see
// docs/team-log/AGENT-BRIEF.md). Two kinds of hands:
//   stub(): a hand with a hand-written hand.f, to drive the state machine exactly;
//   real(): replay.js's synthetic hand through handFeatures.update, so the pose vote, facing and
//           palm units are the shipped ones (break-it cases: swipe / explode never fire done).
//
// export run(check)   check(name, pass: boolean, detail?: string), test.js checkTrue's signature.

import { createInputArbiter, AR } from './inputArbiter.js';
import { createHandFeatures } from './handFeatures.js';
import { synthHand } from './docs/lab/gestures/replay.js';

const FR = 1000 / 30;
const A = 16 / 9;

// A stub hand: wrist at image (x, y), palmPx 0.2, voted pose `label`.
function stub({ label = 'open', x = 0.5, y = 0.6, id = 'Right', facing = 0.9, pip = 10, speed = 0, engaged = true } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  return {
    handedness: id, engaged, landmarks: lm,
    f: {
      id, palmPx: 0.2, frame: { facing }, pip: { index: pip, middle: pip, ring: pip, pinky: pip },
      vel: { wrist: [0, 0], speed }, pose: { label, conf: 1, stableMs: 1000 }
    }
  };
}

// Feed `frames` frames from t0; spec(i, t) -> hands. Collects every event and the last state.
function feed(arb, frames, spec, { t0 = 0, opts = () => ({}) } = {}) {
  const events = [];
  let out = null;
  for (let i = 0; i < frames; i++) {
    const t = t0 + i * FR;
    out = arb.update(spec(i, t), t, opts(i, t));
    events.push(...out.events);
  }
  return { events, out, tEnd: t0 + frames * FR, types: events.map((e) => e.type) };
}

// Real synthetic hands through handFeatures (fresh per sequence).
function realFeed(arb, frames, specs, { t0 = 0 } = {}) {
  const hf = createHandFeatures();
  return feed(arb, frames, (i, t) => {
    const hands = specs(i, t).map((s) => {
      const h = synthHand(s);
      return { ...h, landmarks: h.landmarks.map(([x, y, z]) => ({ x, y, z })), worldLandmarks: h.worldLandmarks.map(([x, y, z]) => ({ x, y, z })) };
    });
    hf.update(hands, t, { aspect: A });
    return hands;
  }, { t0, opts: () => ({ aspect: A }) });
}

export function run(check) {
  // ---- ownership ----
  {
    const arb = createInputArbiter();
    let r = arb.update([stub({ label: 'gun' })], 0);
    check('gun -> AIM; pointer sees the hands, manipulator sees none', r.state.owner === 'AIM' && r.route.pointer.length === 1 && r.route.manip.length === 0, JSON.stringify(r.state));
    r = arb.update([stub({ label: 'gun' }), stub({ label: 'fist', id: 'Left', x: 0.3 })], FR);
    check('AIM: a fist on the other hand cannot steal the hands', r.state.owner === 'AIM' && r.route.manip.length === 0);
    r = arb.update([stub({ label: 'fist' })], 2 * FR);
    check('owner keeps the hands for RELEASE_MS after its pose goes', r.state.owner === 'AIM' && r.route.manip.length === 0);
    r = arb.update([stub({ label: 'fist' })], 2 * FR + AR.RELEASE_MS);
    check('after RELEASE_MS the fist takes MANIP; pointer gets nothing', r.state.owner === 'MANIP' && r.route.pointer.length === 0 && r.route.manip.length === 1, r.state.owner);
    r = arb.update([stub({ label: 'gun' })], 2 * FR + AR.RELEASE_MS + FR);
    check('MANIP: a gun mid-grab is not an aim', r.state.owner === 'MANIP' && r.route.pointer.length === 0);
  }
  {
    const arb = createInputArbiter();
    arb.update([stub({ label: 'fist' })], 0);
    let r = arb.update([], 100);
    check('lost hand inside LOST_GRACE_MS keeps the owner', r.state.owner === 'MANIP');
    r = arb.update([], 100 + AR.LOST_GRACE_MS + 1);
    check('hands lost > LOST_GRACE_MS -> IDLE', r.state.owner === 'IDLE');
    r = arb.update([stub({ label: 'open' })], 400, { manipMode: 'transform' });
    check('manipulator mode (previous frame) claims MANIP from IDLE', r.state.owner === 'MANIP');
    r = arb.update([stub({ label: 'open' })], 400 + FR, { manipMode: 'idle' });
    r = arb.update([stub({ label: 'open' })], 400 + FR + AR.RELEASE_MS, { manipMode: 'idle' });
    check('… and lets go RELEASE_MS after the manipulator idles', r.state.owner === 'IDLE');
  }
  {
    const arb = createInputArbiter();
    const r = feed(arb, 20, (i) => [stub({ label: 'open', x: 0.45 - i * 0.01 }), stub({ label: 'open', id: 'Left', x: 0.55 + i * 0.01 })]);
    check('two open hands spreading -> MANIP(explode); clap allowed there', r.out.state.owner === 'MANIP' && r.out.state.sub === 'explode' && arb.allows('clap'), JSON.stringify(r.out.state));
    check('explode never fires done', !r.types.includes('done'));
  }
  {
    const arb = createInputArbiter();
    arb.update([stub({ label: 'gun' })], 0);
    check('clap is not allowed while aiming', !arb.allows('clap'));
    const r = arb.update([stub({ label: 'gun' })], FR, { wheelOpen: true });
    check('wheel open -> TOOL; pointer + wheel see the hands, manip none', r.state.owner === 'TOOL' && r.route.wheel.length === 1 && r.route.pointer.length === 1 && r.route.manip.length === 0);
    const c = arb.click({ type: 'click' });
    check('click passes through in TOOL', c && c.type === 'click');
  }

  // ---- scopes ----
  {
    const arb = createInputArbiter();
    arb.setScope('tape');
    let r = arb.update([stub({ label: 'fist' })], 0);
    check("scope 'tape': a fist never grabs (model frozen)", r.state.owner === 'IDLE' && r.route.manip.length === 0);
    arb.setScope('x', { allow: ['manip'] });
    r = arb.update([stub({ label: 'gun' })], FR);
    check('scope without aim: pointer gets nothing; click blocked', r.route.pointer.length === 0 && arb.click({ type: 'click' }) === null);
    arb.update([stub({ label: 'fist' })], 2 * FR);
    arb.setScope('tape');
    check('setScope drops a forbidden owner at once', arb.state.owner === 'IDLE' && arb.state.scope === 'tape');
  }

  // ---- done ----
  {
    const arb = createInputArbiter();
    const r = feed(arb, 25, () => [stub({ label: 'open' })]);
    const d = r.events.find((e) => e.type === 'done');
    check('done: one still open palm fires once at ~DONE_MS', d && Math.abs(d.t - AR.DONE_MS) <= FR + 1 && r.types.filter((x) => x === 'done').length === 1, d ? `t=${d.t.toFixed(0)}` : 'none');
    const mid = createInputArbiter();
    const m = feed(mid, 10, () => [stub({ label: 'open' })]);
    check('done arming progress rises 0..1 for the ring', m.out.state.arming?.gesture === 'done' && m.out.state.arming.progress > 0.4 && m.out.state.arming.progress < 0.6, JSON.stringify(m.out.state.arming));
  }
  const noDone = (name, spec, frames = 30) => {
    const r = feed(createInputArbiter(), frames, spec);
    check(`no done: ${name}`, !r.types.includes('done'), r.types.join(','));
  };
  noDone('palm facing away', () => [stub({ label: 'open', facing: 0.3 })]);
  noDone('fingers bent (PIP 40°)', () => [stub({ label: 'open', pip: 40 })]);
  noDone('second hand up', () => [stub({ label: 'open' }), stub({ label: 'none', id: 'Left', x: 0.2 })]);
  noDone('slow drift 0.3 palm/s', (i) => [stub({ label: 'open', x: 0.5 + i * (0.3 * 0.2 / A) / 30 })]);
  noDone('resting (lowered) hand', () => [stub({ label: 'open', engaged: false })]);
  {
    // Jitter ±0.003 image units (the replay stress level) must still allow a done.
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const r = feed(createInputArbiter(), 30, () => [stub({ label: 'open', x: 0.5 + rnd() * 0.003, y: 0.6 + rnd() * 0.003 })]);
    check('done survives ±0.003 landmark jitter', r.types.includes('done'));
  }

  // ---- undo ----
  {
    const r = feed(createInputArbiter(), 25, () => [stub({ label: 'thumbDown' })]);
    const u = r.events.filter((e) => e.type === 'undo');
    check('undo: thumbDown held UNDO_MS fires once', u.length === 1 && Math.abs(u[0].t - AR.UNDO_MS) <= FR + 1, u.map((e) => e.t.toFixed(0)).join(','));
    const s = feed(createInputArbiter(), 12, () => [stub({ label: 'thumbDown' })]);
    check('undo: a 400 ms thumbDown does nothing', !s.types.includes('undo'));
  }

  // ---- swipe ----
  {
    const arb = createInputArbiter();
    arb.setScope('ring');
    // 3 palms (0.6 image-height units ⇒ x span 0.6/A) in ~200 ms, peak speed stubbed 12 palm/s.
    const r = feed(arb, 8, (i) => [stub({ label: 'open', x: 0.6 - i * (0.6 / A) / 6, speed: 12 })]);
    const sw = r.events.filter((e) => e.type === 'swipe');
    check("swipe in scope 'ring': fires once, user's right for image -x", sw.length === 1 && sw[0].dir === 'right', JSON.stringify(sw));
    check('a swipe never fires done', !r.types.includes('done'));
    const back = feed(arb, 8, (i) => [stub({ label: 'open', x: 0.6 - (0.6 / A) + i * (0.6 / A) / 6, speed: 12 })], { t0: r.tEnd });
    check('the return stroke inside SWIPE_RETURN_MS is ignored', !back.types.includes('swipe'), back.types.join(','));
    const def = feed(createInputArbiter(), 8, (i) => [stub({ label: 'open', x: 0.6 - i * (0.6 / A) / 6, speed: 12 })]);
    check("no swipe in the default scope", !def.types.includes('swipe'));
    const slow = createInputArbiter(); slow.setScope('ring');
    const sl = feed(slow, 30, (i) => [stub({ label: 'open', x: 0.6 - i * (0.6 / A) / 28, speed: 3 })]);
    check('slow slide (3 palm/s) is no swipe', !sl.types.includes('swipe'));
    // Vertical swipes (ring versions): same rules with |dy| ≥ 2|dx|; image -y is up.
    const va = createInputArbiter(); va.setScope('ring');
    const up = feed(va, 8, (i) => [stub({ label: 'open', y: 0.8 - i * 0.6 / 6, speed: 12 })]);
    const su = up.events.filter((e) => e.type === 'swipe');
    check("vertical swipe in scope 'ring': image -y fires once as 'up'", su.length === 1 && su[0].dir === 'up', JSON.stringify(su));
    const down = feed(va, 8, (i) => [stub({ label: 'open', y: 0.2 + i * 0.6 / 6, speed: 12 })], { t0: up.tEnd });
    check("vertical return stroke inside SWIPE_RETURN_MS is ignored", !down.types.includes('swipe'), down.types.join(','));
    const down2 = feed(va, 8, (i) => [stub({ label: 'open', y: 0.2 + i * 0.6 / 6, speed: 12 })], { t0: up.tEnd + AR.SWIPE_RETURN_MS + 100 });
    const sd = down2.events.filter((e) => e.type === 'swipe');
    check("vertical swipe image +y (after the return window) fires 'down'", sd.length === 1 && sd[0].dir === 'down', JSON.stringify(sd));
    const diag = createInputArbiter(); diag.setScope('ring');
    const dg = feed(diag, 8, (i) => [stub({ label: 'open', x: 0.6 - i * (0.6 / A) / 6, y: 0.8 - i * 0.6 / 6, speed: 12 })]);
    check('diagonal stroke (|dx| = |dy|) is no swipe', !dg.types.includes('swipe'), dg.types.join(','));
    // Ring scope allows MANIP: a fist reaches the manipulator (spins the ring; platform/hands.js
    // picks a card only if that fist stayed still).
    const rf = createInputArbiter(); rf.setScope('ring');
    const rr = feed(rf, 3, () => [stub({ label: 'fist' })]);
    check("ring scope: a fist is routed to the manipulator (ring spin)", rr.out.route.manip.length === 1 && rf.allows('manip'), JSON.stringify(rr.out.state));
    const vdef = feed(createInputArbiter(), 8, (i) => [stub({ label: 'open', y: 0.8 - i * 0.6 / 6, speed: 12 })]);
    check('no vertical swipe in the default scope', !vdef.types.includes('swipe'));
  }

  // ---- real synthetic hands (handFeatures) ----
  {
    const r = realFeed(createInputArbiter(), 30, () => [{ x: 0.5, y: 0.6, shape: 'open' }]);
    check('real open hand held still: done fires', r.types.includes('done'), r.types.join(',') || 'none');
    const rest = realFeed(createInputArbiter(), 60, () => [{ x: 0.5, y: 0.6, shape: 'fist', label: 'None' }]);
    check('real resting fist: no done/undo/swipe', rest.events.length === 0, rest.types.join(','));
    const td = realFeed(createInputArbiter(), 25, () => [{ x: 0.5, y: 0.6, shape: 'thumbdown' }]);
    check('real thumbs-down: undo fires', td.types.includes('undo'), td.types.join(',') || 'none');
    const arb = createInputArbiter(); arb.setScope('ring', { allow: ['swipe', 'done'] });
    const sw = realFeed(arb, 12, (i) => [{ x: Math.max(0.2, 0.7 - i * 0.06), y: 0.6, shape: 'open' }]);
    check('real fast swipe: exactly one swipe, no done', sw.types.filter((x) => x === 'swipe').length === 1 && !sw.types.includes('done'), sw.types.join(','));
    const ex = realFeed(createInputArbiter(), 30, (i) => [{ x: 0.45 - Math.min(i, 12) * 0.02, y: 0.6, shape: 'open', hand: 'Right' }, { x: 0.55 + Math.min(i, 12) * 0.02, y: 0.6, shape: 'open', hand: 'Left' }]);
    const sw2 = realFeed((() => { const a = createInputArbiter(); a.setScope('ring', { allow: ['swipe', 'done'] }); return a; })(), 40, (i) => [{ x: Math.max(0.2, 0.7 - i * 0.06), y: 0.6, shape: 'open' }]);
    check('real swipe then a still hand: the stroke does not re-fire when the cooldown ends', sw2.types.filter((x) => x === 'swipe').length === 1, sw2.types.join(','));
    check('real explode (then held apart): no done', !ex.types.includes('done'), ex.types.join(','));
    const va = createInputArbiter(); va.setScope('ring', { allow: ['swipe', 'done'] });
    const vs = realFeed(va, 12, (i) => [{ x: 0.5, y: Math.max(0.2, 0.85 - i * 0.07), shape: 'open' }]);
    const vsw = vs.events.filter((e) => e.type === 'swipe');
    check("real fast upward swipe: exactly one 'up' swipe, no done", vsw.length === 1 && vsw[0].dir === 'up' && !vs.types.includes('done'), JSON.stringify(vsw));
  }
}

// Node: run directly and print a summary.
if (typeof window === 'undefined' && typeof process !== 'undefined' && /test-v2-arbiter\.js$/.test(process.argv?.[1] ?? '')) {
  let pass = 0, fail = 0;
  run((name, ok, detail = '') => { ok ? pass++ : fail++; if (!ok) console.log('FAIL', name, detail); });
  console.log(`test-v2-arbiter: ${pass} passed, ${fail} failed`);
}

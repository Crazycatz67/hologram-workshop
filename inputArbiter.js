// Hands v2 input arbiter (plans/hands-v2/CONTRACT.md §2): one owner of the hands at a time.
//
// Why: in v1 every consumer (pointer, manipulator, tool wheel) saw every hand and guarded itself
// with its own gaps (manipulator NEUTRAL_GAP / SWITCH_AWAY, the post-pointer gap), so a grab
// could start mid-aim and a pinch could be read as two things at once. Here one small state
// machine decides who owns the hands this frame and routes them; a consumer that isn't the
// owner gets an empty list, so it can't fire. Command gestures (done / undo / swipe) are
// detected here, once, from hand.f (handFeatures.js). Pure: no DOM, no three.js.
//
// CONTRACT
//   createInputArbiter(options?) -> arb      options override AR (any key)
//   arb.update(hands, tMs, { wheelOpen?, manipMode?, aspect? }) -> { route, events, state }
//     hands     this camera frame's hands AFTER handFeatures.update (hand.f) and engagement
//               (hand.engaged; a hand with engaged === false counts as down/absent). A hand
//               without hand.f reads as pose 'none'.
//     wheelOpen the tool wheel is open (previous frame): TOOL owns the hands while it is.
//     manipMode the manipulator's mode from the PREVIOUS frame ('idle' | 'grab' | 'transform' |
//               'explode'): a non-idle mode from IDLE enters MANIP, and keeps it while active,
//               so a two-hand gesture the manipulator started can't be stolen by the pointer.
//     route = { pointer: hand[], manip: hand[], wheel: hand[] }   what each consumer may see:
//       IDLE  everyone sees every hand (each consumer arms on its own pose)
//       AIM   pointer + wheel; manip []                (a fist on the other hand doesn't grab)
//       MANIP manip only                               (no cursor, no wheel mid-grab)
//       TOOL  pointer + wheel (aim + click on the open wheel); manip []
//       A scope without 'aim' / 'manip' / 'tool' empties that list in every state.
//     events: [{ type: 'done' | 'undo' | 'swipe', t, hand (f.id), ...}]   this frame only
//       done  { progress: 1 }                 swipe { dir: 'left' | 'right' | 'up' | 'down' (USER's
//             view: x mirrored like the cursor, y as seen), dxPalms, dyPalms, peakSpeed (palm/s) }
//     state = arb.state (below)
//   arb.click(click) -> click | null   pass a pointer click through: null in MANIP or when the
//               scope doesn't allow 'click'.
//   arb.allows(name) -> boolean   'click' | 'clap' | 'done' | 'undo' | 'swipe' | 'aim' |
//               'manip' | 'tool' in the CURRENT state and scope (clap: IDLE, or MANIP while the
//               manipulator explodes; the manipulator detects it, the host only routes hands).
//   arb.setScope(name, { allow }?)   allow = list of the names above. No allow = SCOPES[name]
//               or SCOPES.default. Resets any arming (a scope change is a new context).
//   arb.reset()                     back to IDLE, forget all history (camera restart).
//   arb.state = { owner: 'IDLE'|'AIM'|'MANIP'|'TOOL', ownerHand: id|null, sub: 'explode'|null,
//               scope, allow: [...], poses: { [id]: label }, hands: n,
//               arming: { gesture: 'done'|'undo', progress 0..1 } | null }
//
// FAILURE BEHAVIOUR: never throws on hand content; non-finite or backwards time resets the
// command detectors (a replay restart) but keeps the scope. Units: ms; positions in palm
// lengths (image wrist / f.palmPx, x aspect-corrected); speeds in palm lengths per second.

export const STATES = Object.freeze({ IDLE: 'IDLE', AIM: 'AIM', MANIP: 'MANIP', TOOL: 'TOOL' });

export const AR = Object.freeze({
  LOST_GRACE_MS: 150,   // [contract] no hands this long -> IDLE (a tracking blip keeps the owner)
  RELEASE_MS: 150,      // [R ≈150] the owner's pose must be gone this long before it lets go
  // The pose vote (handFeatures VOTE_WINDOW_MS 120 + 2/3 enter) already debounces a label, so a
  // second wait here would only add latency to the first aim / grab frame.
  AIM_ENTER_MS: 0,
  GRAB_ENTER_MS: 0,
  // Two open hands whose span grows this much (palm lengths) beyond the narrowest span since
  // both opened claim the hands for an explode. Below the manipulator's own deliberate-spread
  // rule (EXPLODE_START_SPREAD 2.5): the arbiter only claims ownership, the manipulator decides.
  EXPLODE_CLAIM_PALMS: 1.5,
  // Done [R §5]: one open palm facing the camera, every PIP < 35°, held still for 600 ms.
  DONE_MS: 600,
  DONE_FACING_MIN: 0.55,
  DONE_PIP_MAX_DEG: 35,
  DONE_DISP_PALMS: 0.10,  // [R] max wrist excursion over the window (bounding-box diagonal)
  // [R] peak speed < 0.4 palm/s. Measured over STILL_SPEED_SPAN_MS, not frame to frame: raw
  // per-frame velocity carries landmark jitter (±0.003 image units at 30 fps is ~0.5 palm/s),
  // which would fail every real hold. Over 200 ms the replay's ±0.003 stress jitter peaks at
  // ~0.27 palm/s (100 ms was still ~0.53: test-v2-arbiter's jitter case failed). A slow drift is
  // still caught by DONE_DISP_PALMS (0.3 palm/s over 600 ms = 0.18 palm).
  DONE_SPEED_MAX: 0.4,
  STILL_SPEED_SPAN_MS: 200,
  // Undo: thumbDown voted and held [contract UNDO_MS ≈500].
  UNDO_MS: 500,
  // Swipe [R §5]: ≥2 palms horizontal within ≤400 ms, peak ≥6 palm/s, |dx| ≥ 2|dy|, open hand.
  // Vertical swipes (up/down) use the same numbers with the axes swapped (|dy| ≥ 2|dx|).
  SWIPE_PALMS: 2.0,
  SWIPE_WINDOW_MS: 400,
  SWIPE_PEAK_V: 6.0,
  SWIPE_STRAIGHTNESS: 2.0,
  SWIPE_OPEN_SHARE: 0.5,
  // The hand must still be moving on the firing frame (palm/s): otherwise a stroke that ended
  // inside the window fires late, once the cooldown runs out, while the hand is already still.
  SWIPE_END_V: 2.0,     // share of the stroke's frames voted 'open' (motion blur flips some)
  SWIPE_COOLDOWN_MS: 500,
  SWIPE_RETURN_MS: 600       // the opposite direction is ignored this long (the return stroke)
});

const ALL = ['aim', 'click', 'manip', 'tool', 'clap', 'done', 'undo', 'swipe'];
// Contract §2.3 examples. 'default' = everything except swipe (swipe is opt-in: an open hand
// moving fast is also a wave or the start of an explode).
export const SCOPES = Object.freeze({
  default: ['aim', 'click', 'manip', 'tool', 'clap', 'done', 'undo'],
  tape: ['aim', 'click', 'done', 'undo'],
  polygon: ['aim', 'click', 'done', 'undo'],
  // ring: a fist spins it (MANIP); a still fist picks a card (platform/hands.js FIST_PICK_*).
  ring: ['swipe', 'aim', 'click', 'manip', 'done']
});

const poseOf = (h) => h?.f?.pose?.label ?? 'none';
const idOf = (h, i) => h?.f?.id ?? h?.handedness ?? `#${i}`;
const ptsOf = (h) => h?.rawLandmarks ?? h?.landmarks;
const pt = (p) => (Array.isArray(p) ? p : p ? [p.x, p.y] : null);

export function createInputArbiter(options = {}) {
  const A = { ...AR, ...options };
  let scope = 'default';
  let allow = new Set(SCOPES.default);

  let owner = STATES.IDLE, ownerHand = null, sub = null;
  let ownerSeenT = -Infinity;   // last frame the owner's pose was present
  let lastHandsT = -Infinity;   // last frame with any engaged hand
  let lastT = -Infinity;
  let explode = null;           // { minSpan } while two open hands are up in IDLE
  let done = null;              // { id, startT, samples: [{ t, x, y }], latched }
  let undo = null;              // { id, startT, latched }
  const swipeTracks = new Map(); // id -> [{ t, x, y, open, speed }]
  let lastSwipe = null;          // { t, dir }
  let arming = null;
  let poses = {};
  let nHands = 0;

  function resetDetectors() {
    explode = null; done = null; undo = null; swipeTracks.clear(); lastSwipe = null; arming = null;
  }
  function reset() {
    owner = STATES.IDLE; ownerHand = null; sub = null;
    ownerSeenT = -Infinity; lastHandsT = -Infinity; lastT = -Infinity;
    poses = {}; nHands = 0;
    resetDetectors();
  }

  function setScope(name = 'default', { allow: list } = {}) {
    scope = name;
    allow = new Set((list ?? SCOPES[name] ?? SCOPES.default).filter((k) => ALL.includes(k)));
    arming = null; done = null; undo = null;
    // A scope that forbids the current owner drops it at once (tape freezes the model mid-grab).
    if ((owner === STATES.MANIP && !allow.has('manip')) || (owner === STATES.AIM && !allow.has('aim')) ||
        (owner === STATES.TOOL && !allow.has('tool'))) setOwner(STATES.IDLE);
  }

  function setOwner(next, hand = null, t = lastT) {
    owner = next; ownerHand = hand; ownerSeenT = t;
    if (next !== STATES.MANIP) sub = null;
  }

  // Wrist in palm lengths (x aspect-corrected). Differences only: palmPx changes with depth.
  function wristPalms(h, aspect) {
    const p = pt(ptsOf(h)?.[0]);
    const palm = h?.f?.palmPx;
    if (!p || !(palm > 0)) return null;
    return [(p[0] * aspect) / palm, p[1] / palm];
  }

  // ---- ownership ---------------------------------------------------------------------------
  function updateOwner(up, t, wheelOpen, manipMode) {
    const manipActive = manipMode != null && manipMode !== 'idle';
    if (up.length) lastHandsT = t;
    else if (t - lastHandsT > A.LOST_GRACE_MS) { if (owner !== STATES.IDLE) setOwner(STATES.IDLE, null, t); return; }
    else return; // inside the lost-hand grace: keep the owner, route nothing new

    const gun = up.find((h) => poseOf(h) === 'gun' && (h.f?.pose?.stableMs ?? 0) >= A.AIM_ENTER_MS);
    const fist = up.find((h) => poseOf(h) === 'fist' && (h.f?.pose?.stableMs ?? 0) >= A.GRAB_ENTER_MS);

    // Two open hands spreading apart (IDLE only): track the narrowest span since both opened.
    let spreading = false;
    if (up.length === 2 && up.every((h) => poseOf(h) === 'open')) {
      const a = up[0].f, b = up[1].f;
      const wa = pt(ptsOf(up[0])?.[0]), wb = pt(ptsOf(up[1])?.[0]);
      const palm = ((a?.palmPx ?? 0) + (b?.palmPx ?? 0)) / 2;
      if (wa && wb && palm > 0) {
        const span = Math.hypot((wa[0] - wb[0]) * aspectNow, wa[1] - wb[1]) / palm;
        explode = explode ? { minSpan: Math.min(explode.minSpan, span) } : { minSpan: span };
        spreading = span - explode.minSpan >= A.EXPLODE_CLAIM_PALMS;
      }
    } else explode = null;

    if (owner === STATES.TOOL) {
      if (wheelOpen) { ownerSeenT = t; return; }
      setOwner(STATES.IDLE, null, t); // the wheel closed (pick, done, timeout): back to free
    } else if (owner === STATES.AIM) {
      const still = up.find((h) => idOf(h) === ownerHand && poseOf(h) === 'gun') ?? (ownerHand == null ? gun : null);
      if (still) ownerSeenT = t;
      else if (t - ownerSeenT >= A.RELEASE_MS) setOwner(STATES.IDLE, null, t);
      if (owner === STATES.AIM && wheelOpen && allow.has('tool')) setOwner(STATES.TOOL, ownerHand, t);
      if (owner !== STATES.IDLE) return;
    } else if (owner === STATES.MANIP) {
      const holding = fist || manipActive || (sub === 'explode' && up.length === 2);
      if (holding) ownerSeenT = t;
      else if (t - ownerSeenT >= A.RELEASE_MS) setOwner(STATES.IDLE, null, t);
      if (manipMode === 'explode') sub = 'explode';
      if (owner !== STATES.IDLE) return;
    }

    // IDLE: who claims the hands this frame?
    if (wheelOpen && allow.has('tool')) { setOwner(STATES.TOOL, null, t); return; }
    if (allow.has('manip') && (fist || spreading || manipActive)) {
      setOwner(STATES.MANIP, fist ? idOf(fist) : null, t);
      sub = spreading || manipMode === 'explode' ? 'explode' : null;
      return;
    }
    if (gun && allow.has('aim')) setOwner(STATES.AIM, idOf(gun), t);
  }

  // ---- done: one open palm, facing the camera, still --------------------------------------
  function doneCandidate(up) {
    if (up.length !== 1) return null;
    const h = up[0], f = h.f;
    if (!f || poseOf(h) !== 'open') return null;
    if (!(f.frame?.facing > A.DONE_FACING_MIN)) return null;
    const pips = Object.values(f.pip ?? {});
    if (pips.length < 4 || !pips.every((d) => d != null && d < A.DONE_PIP_MAX_DEG)) return null;
    return h;
  }

  function stillEnough(samples) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of samples) { x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x); y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y); }
    if (Math.hypot(x1 - x0, y1 - y0) >= A.DONE_DISP_PALMS) return false;
    // Peak speed over >= STILL_SPEED_SPAN_MS: the newest sample against the latest one at least
    // that old (checked every frame, so this sweeps the whole window).
    const last = samples[samples.length - 1];
    for (let i = samples.length - 2; i >= 0; i--) {
      const s = samples[i], dt = last.t - s.t;
      if (dt >= A.STILL_SPEED_SPAN_MS) return (Math.hypot(last.x - s.x, last.y - s.y) * 1000) / dt < A.DONE_SPEED_MAX;
    }
    return true;
  }

  function updateDone(up, t, aspect, events) {
    const h = allow.has('done') && owner !== STATES.MANIP ? doneCandidate(up) : null;
    const p = h ? wristPalms(h, aspect) : null;
    if (!h || !p) { done = null; return; }
    const id = idOf(h);
    if (!done || done.id !== id) done = { id, startT: t, samples: [], latched: false };
    if (done.latched) return; // fired: the palm has to leave the pose before it can fire again
    done.samples.push({ t, x: p[0], y: p[1] });
    while (done.samples.length > 1 && t - done.samples[1].t >= A.DONE_MS) done.samples.shift();
    if (!stillEnough(done.samples)) { done.startT = t; done.samples = [{ t, x: p[0], y: p[1] }]; }
    const progress = Math.min(1, (t - done.startT) / A.DONE_MS);
    arm('done', progress);
    if (progress >= 1) {
      done.latched = true;
      events.push({ type: 'done', t, hand: id, progress: 1 });
    }
  }

  // ---- undo: thumbDown held ------------------------------------------------------------------
  function updateUndo(up, t, events) {
    const h = allow.has('undo') && owner === STATES.IDLE ? up.find((x) => poseOf(x) === 'thumbDown') : null;
    if (!h) { undo = null; return; }
    const id = idOf(h);
    if (!undo || undo.id !== id) undo = { id, startT: t, latched: false };
    if (undo.latched) return;
    const progress = Math.min(1, (t - undo.startT) / A.UNDO_MS);
    arm('undo', progress);
    if (progress >= 1) { undo.latched = true; events.push({ type: 'undo', t, hand: id }); }
  }

  // ---- swipe: a fast straight open-hand stroke (left/right/up/down) ----------------------------------------------
  function updateSwipe(up, t, aspect, events) {
    const seen = new Set();
    for (const h of up) {
      const id = idOf(h);
      const p = wristPalms(h, aspect);
      if (!p) continue;
      seen.add(id);
      const tr = swipeTracks.get(id) ?? [];
      tr.push({ t, x: p[0], y: p[1], open: poseOf(h) === 'open', speed: h.f?.vel?.speed ?? 0 });
      while (tr.length && t - tr[0].t > A.SWIPE_WINDOW_MS) tr.shift();
      swipeTracks.set(id, tr);
      if (!allow.has('swipe') || owner !== STATES.IDLE || up.length !== 1) continue;
      if (lastSwipe && t - lastSwipe.t < A.SWIPE_COOLDOWN_MS) continue;
      const last = tr[tr.length - 1];
      if (last.speed < A.SWIPE_END_V) continue;
      // Oldest start first: the longest qualifying stroke inside the window.
      for (let i = 0; i < tr.length - 1; i++) {
        const seg = tr.slice(i);
        const dx = last.x - tr[i].x, dy = last.y - tr[i].y;
        // Horizontal (|dx| ≥ 2|dy|) or vertical (|dy| ≥ 2|dx|): same length / speed rules.
        const horiz = Math.abs(dx) >= A.SWIPE_PALMS && Math.abs(dx) >= A.SWIPE_STRAIGHTNESS * Math.abs(dy);
        const vert = Math.abs(dy) >= A.SWIPE_PALMS && Math.abs(dy) >= A.SWIPE_STRAIGHTNESS * Math.abs(dx);
        if (!horiz && !vert) continue;
        if (seg.filter((s) => s.open).length < A.SWIPE_OPEN_SHARE * seg.length || !last.open) continue;
        const peak = Math.max(...seg.slice(1).map((s) => s.speed));
        if (peak < A.SWIPE_PEAK_V) continue;
        // Image x is the UNmirrored camera; the user sees a mirror, so image -x is their right.
        // Image y grows downward and isn't mirrored: -y is up.
        const dir = horiz ? (dx < 0 ? 'right' : 'left') : (dy < 0 ? 'up' : 'down');
        const OPP = { left: 'right', right: 'left', up: 'down', down: 'up' };
        if (lastSwipe && OPP[lastSwipe.dir] === dir && t - lastSwipe.t < A.SWIPE_RETURN_MS) break;
        lastSwipe = { t, dir };
        events.push({ type: 'swipe', t, hand: id, dir, dxPalms: Math.round(Math.abs(dx) * 100) / 100, dyPalms: Math.round(Math.abs(dy) * 100) / 100, peakSpeed: Math.round(peak * 10) / 10 });
        tr.length = 0;
        break;
      }
    }
    for (const id of swipeTracks.keys()) if (!seen.has(id)) swipeTracks.delete(id);
  }

  function arm(gesture, progress) {
    if (!arming || progress > arming.progress) arming = { gesture, progress };
  }

  let aspectNow = 16 / 9;
  function update(hands, tMs, { wheelOpen = false, manipMode = null, aspect = 16 / 9 } = {}) {
    const all = Array.isArray(hands) ? hands.filter(Boolean) : [];
    const t = Number(tMs);
    if (!Number.isFinite(t) || t < lastT) resetDetectors();
    lastT = Number.isFinite(t) ? t : lastT;
    aspectNow = aspect;
    const up = all.filter((h) => h.engaged !== false);
    const events = [];
    arming = null;

    updateOwner(up, lastT, wheelOpen, manipMode);
    updateDone(up, lastT, aspect, events);
    updateUndo(up, lastT, events);
    updateSwipe(up, lastT, aspect, events);

    poses = {};
    all.forEach((h, i) => { poses[idOf(h, i)] = poseOf(h); });
    nHands = up.length;

    const see = (k, states) => (allow.has(k) && states.includes(owner) ? all : []);
    const route = {
      pointer: see('aim', [STATES.IDLE, STATES.AIM, STATES.TOOL]),
      manip: see('manip', [STATES.IDLE, STATES.MANIP]),
      wheel: see('tool', [STATES.IDLE, STATES.AIM, STATES.TOOL])
    };
    return { route, events, state: getState() };
  }

  function allows(name) {
    if (!allow.has(name)) return false;
    switch (name) {
      case 'click': return owner !== STATES.MANIP;
      case 'clap': return owner === STATES.IDLE || (owner === STATES.MANIP && sub === 'explode');
      case 'done': return owner !== STATES.MANIP;
      case 'undo': case 'swipe': return owner === STATES.IDLE;
      case 'aim': return owner !== STATES.MANIP;
      case 'manip': return owner === STATES.IDLE || owner === STATES.MANIP;
      case 'tool': return owner !== STATES.MANIP;
      default: return false;
    }
  }

  function getState() {
    return { owner, ownerHand, sub, scope, allow: [...allow], poses: { ...poses }, hands: nHands, arming: arming ? { ...arming } : null };
  }

  return {
    update, setScope, reset, allows,
    click: (c) => (c && allows('click') ? c : null),
    get state() { return getState(); },
    get thresholds() { return A; }
  };
}

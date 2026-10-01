// Hold gate: the confirmation ring for COMMAND gestures (undo, tool wheel, reset, hide) and
// the short confirm for select/click. Pure and DOM-free: feed it one frame at a time, draw
// whatever it returns. Grab/scale are the instant tier and never go through here.
//
// PROVENANCE. Ported from the ASL project's Spell "circle lock"
// (asl-recognizer/js/spellgate.js, SPELL_GATE), which was measured before it shipped. The
// ASL changelog entry "2026-09-25 (Spell: circle lock per letter + word window)" in
// asl-recognizer/docs/CHANGELOG.md records the tuning, on a Node harness of every letter,
// held-out real hands, jitter and 1-in-3 tracking dropouts:
//   - confirm 650 ms: 500 ms raised wrong entries 5% -> 8%; 800 ms gained nothing. So 650 is
//     the shortest hold that doesn't let a passing look-alike through.
//   - grace 300 ms: at 100 ms, ordinary 110-200 ms tracking blips reset the ring and steady
//     holds lost 13 points. A blip must only PAUSE the ring; 300 ms of bad frames resets it.
//   - minConf 0.8: 0.6 missed less but entered more wrong letters.
// The owner's hologram scheme (2026-09-30) adds on top: the ring stays invisible for its
// first 200 ms (so a pose you pass through never flashes a ring), select/click confirm at the
// short tier (~200 ms), and a repeat of the same command within ~2 s drops to the short tier
// (undo-undo-undo shouldn't cost 650 ms each).
//
// What was kept from spellgate: charge only on steady, confident frames; wrist motion pauses
// the charge; bad frames pause, a run of graceMs of them resets; a fired pose is "held" and
// can't fire again until released (releaseMs of something else, or leaveMs of no hand); a
// different pose only takes over a well-started ring after graceMs, so a one-frame
// look-alike can't steal it. Dropped: letters, J/Z strokes, the word window and spaces.
//
// DEVIATION from spellgate: a visible wrist move does NOT release the held pose by default
// (spellgate releases on a bounce or a 0.6-span slide, which is how ASL types doubled
// letters). For commands that is a hazard: the hand drifts after an undo, the pose is
// released, and with the repeat window a second undo fires 200 ms later. Set
// `releaseSpans: 0.6` to get the ASL behaviour back.
//
// CONTRACT
//   const gate = createHoldGate(options?)   // options override HOLD_GATE; `tiers` replaces
//                                            // HOLD_TIERS ({ poseName: 'ring' | 'short' })
//   const s = gate.update({ pose, confidence, wristPos, spanPx, timestampMs })
//     pose         string command name this frame, or null. A name not in `tiers` counts as
//                  "hand showing something else" (never charges, releases a held pose).
//     confidence   0..1 for that pose; below minConf the frame is a bad frame.
//     wristPos     { x, y } wrist position, or null when no hand is tracked (null = hand gone,
//                  which is what leaveMs measures).
//     spanPx       hand span in the SAME units as wristPos; motion thresholds are in spans,
//                  so any consistent unit (px, normalised) works.
//     timestampMs  frame time in ms (performance.now()). Non-finite -> ignored frame.
//                  Backwards time is treated as no time passing.
//   s = { phase, pose, tier, progress, visibleProgress, fired, held }
//     phase            'idle' | 'charging' | 'paused' | 'fired' | 'held'
//                      charging = this frame added charge; paused = a ring exists but this
//                      frame didn't add to it (moving wrist, or bad frames inside the grace).
//                      'fired' lasts exactly one frame; afterwards 'held' until released.
//     pose             the pose the phase is about (candidate / fired / held), else null
//     tier             'ring' | 'short' for the candidate as it will actually fire (a repeat
//                      inside repeatWindowMs reports 'short'), else null
//     progress         0..1 true charge / holdMs (for logic and tests)
//     visibleProgress  0..1 what to DRAW: 0 until graceVisibleMs of charge, then rescaled so
//                      the ring appears empty and is full on the frame it fires. Always 0
//                      for the short tier (it fires before the ring would show).
//     fired            the pose name on the frame it fires, else null. Act on this only.
//     held             the pose that must be released before it can fire again, or null
//   gate.reset()       forget everything (mode switch, tracking restart)
//
// FAILURE BEHAVIOUR: never throws from update(); a bad frame is just a bad frame. Throws a
// TypeError at creation if a tier value isn't 'ring' or 'short' (a config typo would
// otherwise silently disable that command). Frame gaps are clamped to maxDtMs so a stalled
// tab can't dump seconds of charge in one frame; below ~10 fps the ring fills proportionally
// slower rather than skipping ahead.

export const HOLD_GATE = {
  ringMs: 650, // command hold that fills the ring (ASL-measured, see above)
  shortMs: 200, // select/click, and repeats inside the repeat window
  graceVisibleMs: 200, // ring stays invisible for this much charge
  minConf: 0.8, // a frame needs this confidence to charge
  graceMs: 300, // consecutive bad frames that reset (not just pause) the ring
  releaseMs: 250, // showing something else this long releases the held pose
  leaveMs: 700, // hand gone this long releases it too (a tracking blip isn't a release)
  releaseSpans: null, // null = motion never releases (see DEVIATION); 0.6 = ASL behaviour
  steadySpans: 0.35, // wrist travel per steadyWindowMs above which the ring pauses
  steadyWindowMs: 200,
  repeatWindowMs: 2000, // same command again this soon after it fired -> short tier
  maxDtMs: 100, // per-frame charge cap (10 fps and up charge in real time)
};

// The owner's approved scheme (2026-09-30). Names are placeholders until hologram.js wiring
// settles the pose names; pass `tiers` to override.
export const HOLD_TIERS = {
  undo: 'ring',
  toolWheel: 'ring',
  reset: 'ring',
  hide: 'ring',
  select: 'short',
  click: 'short',
};

export function createHoldGate(options = {}) {
  const { tiers = HOLD_TIERS, ...rest } = options;
  const o = { ...HOLD_GATE, ...rest };
  for (const [name, tier] of Object.entries(tiers)) {
    if (tier !== 'ring' && tier !== 'short') {
      throw new TypeError(`holdGate: tier for "${name}" must be 'ring' or 'short', got ${JSON.stringify(tier)}`);
    }
  }
  const tierOf = (p) => (typeof p === 'string' && Object.hasOwn(tiers, p) ? tiers[p] : null);

  let lastT = null;
  let cand = null; // pose charging the ring
  let candMs = 0; // its hold time, fixed when it starts (so the repeat window can't expire mid-ring)
  let charge = 0; // ms of steady, confident hold accumulated for cand
  let badSince = null; // start of the current run of bad frames
  let held = null; // last fired pose, blocked until released
  let anchor = null; // wrist at the fire, for the optional motion release
  let otherSince = null; // start of "showing something other than held"
  let goneSince = null; // start of "no hand"
  let lastFire = null;
  let lastFireAt = -Infinity;
  let hist = []; // { t, x, y, span } for steadiness

  const release = () => { held = null; anchor = null; otherSince = null; goneSince = null; };

  // The short tier is also how a repeat is confirmed: inside the window the user has already
  // shown intent once, so the long ring would only add friction.
  const holdMsFor = (p, now) =>
    tierOf(p) === 'short' || (p === lastFire && now - lastFireAt < o.repeatWindowMs) ? o.shortMs : o.ringMs;

  function steadyNow(now, pos, span) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !(span > 0)) { hist = []; return false; }
    hist.push({ t: now, x: pos.x, y: pos.y, span });
    while (hist.length > 1 && now - hist[0].t > o.steadyWindowMs) hist.shift();
    if (hist.length < 2) return true; // no evidence of motion yet
    const a = hist[0];
    const b = hist[hist.length - 1];
    return Math.hypot(b.x - a.x, b.y - a.y) / ((a.span + b.span) / 2) <= o.steadySpans;
  }

  function visible(ch, ms) {
    const g = o.graceVisibleMs;
    if (!(ms > g) || ch <= g) return 0;
    return Math.min(1, (ch - g) / (ms - g));
  }

  function snapshot(phase, extra = {}) {
    const pose = cand ?? held;
    return {
      phase,
      pose: phase === 'idle' ? null : pose,
      tier: cand ? (candMs < o.ringMs ? 'short' : 'ring') : null,
      progress: cand ? Math.min(1, charge / candMs) : 0,
      visibleProgress: cand ? visible(charge, candMs) : 0,
      fired: null,
      held,
      ...extra,
    };
  }

  return {
    get held() { return held; },

    reset() {
      lastT = null; cand = null; candMs = 0; charge = 0; badSince = null; release();
      lastFire = null; lastFireAt = -Infinity; hist = [];
    },

    update({ pose = null, confidence = 0, wristPos = null, spanPx = 0, timestampMs } = {}) {
      if (!Number.isFinite(timestampMs)) return snapshot(cand ? 'paused' : held ? 'held' : 'idle');
      const now = lastT == null ? timestampMs : Math.max(lastT, timestampMs);
      const dt = lastT == null ? 0 : Math.min(o.maxDtMs, now - lastT);
      lastT = now;
      const P = tierOf(pose) ? pose : null;
      const conf = Number.isFinite(confidence) ? confidence : 0;
      const hand = !!wristPos && Number.isFinite(wristPos.x) && Number.isFinite(wristPos.y);
      const steady = steadyNow(now, hand ? wristPos : null, spanPx);

      // ---- release of the held pose ----
      if (held) {
        if (!hand) {
          otherSince = null;
          if (goneSince == null) goneSince = now;
          if (now - goneSince >= o.leaveMs) release();
        } else {
          goneSince = null;
          const moved = o.releaseSpans != null && anchor && spanPx > 0 &&
            (!steady || Math.hypot(wristPos.x - anchor.x, wristPos.y - anchor.y) / ((anchor.span + spanPx) / 2) >= o.releaseSpans);
          if (moved) {
            release();
          } else if (P !== held) {
            if (otherSince == null) otherSince = now;
            if (now - otherSince >= o.releaseMs) release();
          } else {
            otherSince = null;
          }
        }
      }

      // ---- the ring ----
      let charged = false;
      const valid = P != null && conf >= o.minConf && P !== held;
      if (valid && (P === cand || !cand || charge < o.graceMs)) {
        // same pose (or a fresh / barely-started ring): charge it
        // A new pose starts at 0 WITHOUT this frame's dt: the pose wasn't there during the
        // interval before this frame, so crediting it fired repeats and post-gap rings a
        // frame early (a 200 ms repeat fired at 167 ms at 30 fps).
        const fresh = P !== cand;
        if (fresh) { cand = P; charge = 0; candMs = holdMsFor(P, now); }
        badSince = null;
        if (steady) { if (!fresh) charge += dt; charged = true; }
        if (charge >= candMs) {
          const fired = cand;
          const firedMs = candMs;
          const out = {
            phase: 'fired', pose: fired, tier: firedMs < o.ringMs ? 'short' : 'ring',
            progress: 1, visibleProgress: visible(charge, firedMs), fired,
          };
          lastFire = fired; lastFireAt = now;
          held = fired;
          anchor = hand && spanPx > 0 ? { x: wristPos.x, y: wristPos.y, span: spanPx } : null;
          otherSince = null; goneSince = null;
          cand = null; charge = 0; candMs = 0; badSince = null;
          return { ...out, held };
        }
      } else {
        // bad frame: pause; a run of them reaching graceMs resets the ring
        if (badSince == null) badSince = now;
        if (now - badSince >= o.graceMs) {
          cand = null; charge = 0; candMs = 0;
          // a different pose that outlasted the grace starts its own ring
          if (valid) { cand = P; candMs = holdMsFor(P, now); badSince = null; charged = true; }
        }
        if (held && P === held) { cand = null; charge = 0; candMs = 0; } // back on the held pose
      }

      return snapshot(cand ? (charged ? 'charging' : 'paused') : held ? 'held' : 'idle');
    },
  };
}

// testguide-steps.js — the guided owner test: the step list and its saved progress.
//
// Why: the owner tests the app by hand on the shadow site (localhost) and asked for a guide
// that walks him through each function, saying what to do, what correct looks like and what
// the known bug looks like, so he can tell "working" from "the bug" without reading the
// ledger. The content comes from docs/testing/LEDGER.md (Owner live checklist G/H/I, the
// needs-live rows of Features and Features (pass 2)) and the open items in BUGS.md.
// Keep it in step with those docs: when a bug closes or a feature is live-confirmed, change
// its row here (kind, wording) rather than adding a second copy elsewhere.
//
// Shared by guide.html (the hub) and testguide.js (the dock on the page under test).
// No DOM here, so it also runs in Node (ELECTRON_RUN_AS_NODE) for the checks in
// docs/testing/README.md "Guided test mode".
//
// ---------------------------------------------------------------------------------------
// CONTRACT
//   PAGES    { hologram | platform | hands: { label, url } }  url is relative to the repo root.
//   KINDS    { live | known | regress | info: { label, hint } }
//            live = needs a live look (never confirmed on real hands / eyes)
//            known = a known issue: say whether you still see it
//            regress = worked before; check it still does
//            info = nothing to click (Python side); listed on the hub, skipped by the run
//   SECTIONS [{ id, label }]  hub grouping and run order.
//   STEPS    [{ id, section, page, kind, title, action, correct, bug, tell, ref }]
//            page is a PAGES key (null for info rows). All text is plain words, no markup.
//   RUN_STEPS  STEPS without the info rows: the sequence the dock walks through.
//   pageOf(pathname) -> PAGES key | null     which page a location.pathname is.
//   loadState(storage) / saveState(storage, state)   localStorage key STATE_KEY; a broken or
//            missing value loads as freshState(). Never throws (private mode, quota).
//   STATE    { v: 1, active, startedAt, endedAt, cursor (step id), minimised,
//              results: { [stepId]: { verdict: 'pass'|'fail'|'unsure', note, at, page } },
//              savedAt, savedPath }
//   setVerdict(state, id, verdict, note, now) -> state   (verdict null clears it)
//   move(state, delta) -> state     cursor to the next / previous RUN_STEPS entry (clamped).
//   counts(state) -> { pass, fail, unsure, notRun, total }
//   summaryText(state, now) -> string   the copyable end summary (fails first, with notes).
//
// TESTER TOUR (added 2026-10-01; additions only, the dev contract above is unchanged)
//   A second run mode for an outside tester: plain words, no bug numbers. Chosen at Start in
//   guide.html and kept in state.mode ('dev' | 'tour', default 'dev').
//   TOUR_SECTIONS / TOUR_STEPS   same shape as SECTIONS / STEPS. Step kinds: 'tour' (a step:
//            action = what to do, correct = what you should see, tell = tip if it doesn't
//            work, bug = ''), 'rate' (one 1-5 "how easy was this?" per section) and 'free'
//            (the closing free-text question). A step with optional:true is "if available".
//   RUN_STEPS (live binding) follows the mode: dev = STEPS minus info rows, tour = TOUR_STEPS.
//            setMode(state, mode) switches it; loadState() restores it from the saved state.
//   setAnswer(state, id, { rating, note }, now)  stores a 1-5 rating or the free text for a
//            'rate' / 'free' step as results[id] = { rating?, note, at, page }.
//   counts() only tallies Pass/Fail/Unsure steps (not rate/free); answered rating/free steps are
//            listed in summaryText. stepsFor(mode) / sectionsFor(mode) give the lists by mode.
//   PAGES landing + demos have dock:false (no guide box there): the hub opens them in a new tab.
// ---------------------------------------------------------------------------------------

export const STATE_KEY = 'testguide:v1';

export const PAGES = {
  hologram: { label: 'Gesture demo', url: 'hologram.html' },
  platform: { label: 'Platform', url: 'platform/index.html' },
  hands: { label: 'Hands page', url: 'hands.html' },
  // Tester tour only: pages that do not load the guide box.
  landing: { label: 'Landing page', url: 'index.html', dock: false },
  demos: { label: 'Games hub', url: 'demos/index.html', dock: false }
};

export const KINDS = {
  live: { label: 'needs live', hint: 'Never confirmed with real hands or eyes. Your answer is the first real result.' },
  known: { label: 'known issue', hint: 'A known problem. Tell us whether you still see it.' },
  regress: { label: 'regression check', hint: 'This worked before. Check it still does.' },
  tour: { label: 'tour step', hint: 'Do what it says, then say whether it worked.' },
  rate: { label: 'rating', hint: 'One tap: how easy was this part, 1 (hard) to 5 (easy).' },
  free: { label: 'your words', hint: 'Free text, a sentence or two is plenty.' },
  info: { label: 'info only', hint: 'Python side, nothing to click. Listed so you know it is still open.' }
};

// Run order groups the pages so the run hops between pages as little as possible:
// gesture demo -> measure (same page) -> hands -> Platform pages.
export const SECTIONS = [
  { id: 'gesture', label: 'Gesture demo' },
  { id: 'measure', label: 'Measure and tape' },
  { id: 'hands', label: 'Hands (camera)' },
  { id: 'platform', label: 'Platform' },
  { id: 'polygon', label: 'Polygon mode' },
  { id: 'ring', label: 'Library ring' },
  { id: 'upload', label: 'Upload' },
  { id: 'info', label: 'Open Python issues (info only)' }
];

export const STEPS = [
  // ---- Gesture demo (hologram.html) ----
  { id: 'GD1', section: 'gesture', page: 'hologram', kind: 'regress', ref: 'LEDGER G1',
    title: 'Page layout',
    action: 'Without starting the camera, look over the page.',
    correct: 'One Tools panel with three tabs (Practice, Measure, Look), one coach line, and nothing covering the top bar.',
    bug: 'Two panels, text printed on top of other text, or part of the top bar hidden.',
    tell: 'On a narrow window the Tools panel starts closed on purpose (the gear button opens it). Overlap on a full-width window is the bug.' },
  { id: 'GD2', section: 'gesture', page: 'hologram', kind: 'regress', ref: 'LEDGER G2',
    title: 'Help',
    action: 'Press the ? key, then press it again (or Esc).',
    correct: 'A help panel opens, then closes.',
    bug: 'Nothing opens, or it will not close, or keys stop working afterwards.',
    tell: 'If ? does nothing, click the ? button in the top bar. If the button works but the key does not, write "key only" in the note.' },
  { id: 'GD3', section: 'gesture', page: 'hologram', kind: 'live', ref: 'LEDGER G3',
    title: 'Camera and calibration card',
    action: 'Start the camera, allow it, and follow the calibration card (3 short steps).',
    correct: 'The card sits just under the top bar, the wording is plain, and a bar fills at each step.',
    bug: 'The card covers the top bar, or a bar stays empty even though your hand is clearly in view.',
    tell: 'A bar that fills slowly while you hold still is fine. Empty for about 10 seconds with your hand well lit is the bug.' },
  { id: 'GD4', section: 'gesture', page: 'hologram', kind: 'live', ref: 'LEDGER G4',
    title: 'Select by holding still',
    action: 'Point (index finger out, other three curled) at a chair part and hold still for about a second.',
    correct: 'A small ring fills around the pointer, then that part is selected.',
    bug: 'No ring appears, or a part is selected with no ring, or the wrong part is selected.',
    tell: 'If the pointer shakes between two parts, write "jitter" in the note. That is a different problem from the hold not working.' },
  { id: 'GD5', section: 'gesture', page: 'hologram', kind: 'live', ref: 'LEDGER G5',
    title: 'Select with the other hand',
    action: 'Point at a different part and pinch with your OTHER hand.',
    correct: 'That part is selected straight away.',
    bug: 'Nothing is selected, or the model starts moving.',
    tell: 'A short delay (under half a second) is fine. Needing several pinches is a Fail.' },
  { id: 'GD6', section: 'gesture', page: 'hologram', kind: 'known', ref: 'BUGS #47 (live confirm)',
    title: 'Same-hand pinch must not grab',
    action: 'Point at a part and pinch with the SAME hand. Keep the pinch held for about 2 seconds.',
    correct: 'The part is selected and the model stays still while you keep pinching.',
    bug: 'The model starts moving while you are only pinching (the pinch turned into a grab).',
    tell: 'Moving because you closed your whole hand into a fist is a normal grab. Moving while you only pinch is the bug. Also note it if a real fist does not grab until you open your hand fully first.' },
  { id: 'GD7', section: 'gesture', page: 'hologram', kind: 'live', ref: 'Features: v1 tilt',
    title: 'Tilt direction',
    action: 'Make a fist with one hand, then raise your other open hand about 20 cm, then lower it.',
    correct: 'Raising tilts the front edge of the model up; lowering tilts it down.',
    bug: 'It tilts the opposite way, or not at all.',
    tell: 'This direction was reversed on your request. If it feels backwards to you, mark Fail and say so.' },
  { id: 'GD8', section: 'gesture', page: 'hologram', kind: 'live', ref: 'BUGS #31',
    title: 'Two-hand scale is smooth',
    action: 'Pinch with both hands. Spread them a little (about 10 cm), back, and a little again.',
    correct: 'The size follows your hands promptly, including at each change of direction.',
    bug: 'Nothing happens at first, or the size pauses each time you change direction.',
    tell: 'A tiny lag (under a quarter second) is smoothing. Sticking until you move much further is the bug. One line in the note on how it feels helps.' },
  { id: 'GD9', section: 'gesture', page: 'hologram', kind: 'regress', ref: 'BUGS #26 / #28',
    title: 'Explode, click a leg, move only the leg',
    action: 'Pull two open hands apart to explode the chair. Click one leg with the mouse, then grab with a fist.',
    correct: 'Only the leg moves.',
    bug: 'The whole chair moves, or the click selects nothing.',
    tell: 'If the chair explodes when you only meant to relax after a tilt, write "accidental explode" in the note (BUGS #26).' },
  { id: 'GD10', section: 'gesture', page: 'hologram', kind: 'regress', ref: 'BUGS #27',
    title: 'Clap reset, and undo',
    action: 'Explode, then bring the open hands together fast. Then rest your hands, clap once, and press U.',
    correct: 'The fast close does NOT reset. The clap from rest resets. U brings back the view from before the reset.',
    bug: 'The fast close resets everything, or the clap does nothing, or U does not undo.',
    tell: 'Count claps: if fewer than 4 of 5 claps register, write the count in the note.' },
  { id: 'GD11', section: 'gesture', page: 'hologram', kind: 'live', ref: 'LEDGER G7',
    title: 'Selection practice',
    action: 'Press P (Practice tab opens), then press the 🎯 Selection practice button and follow it.',
    correct: 'It ends with a score line.',
    bug: 'It never ends, or no score appears.',
    tell: 'In the note, write which way felt easier: hold or pinch.' },
  { id: 'GD12', section: 'gesture', page: 'hologram', kind: 'live', ref: 'BUGS #1',
    title: 'Switch models',
    action: 'Use the model picker arrows to switch models about 6 times.',
    correct: 'Each press shows the next model, and the page stays smooth.',
    bug: 'A model does not appear, or the page freezes or slows down more with each switch.',
    tell: 'The first load of a model can take a second. Getting slower every time is the bug.' },

  // ---- Measure and tape (hologram.html) ----
  { id: 'MT1', section: 'measure', page: 'hologram', kind: 'live', ref: 'LEDGER G8',
    title: 'Tape with pinch clicks',
    action: 'Press T (tape on). Point at two spots on the model and pinch your other hand at each.',
    correct: 'Two points appear and a length shows ("... apart on the real object").',
    bug: 'No point is placed, or the length is 0 or clearly wrong.',
    tell: 'Compare with the Size line: seat to floor on a chair should be less than the full height. A number many times too big is a units bug.' },
  { id: 'MT2', section: 'measure', page: 'hologram', kind: 'regress', ref: 'Cody-U layout',
    title: 'Measure tab order and mouse tape',
    action: 'Open the Measure tab. Turn the tape on and click two points with the mouse.',
    correct: 'Sections read Size, Tape, Notes, Report (top to bottom), and the mouse tape shows a length.',
    bug: 'Sections out of order or missing, or mouse clicks do not place points.',
    tell: 'If pinch tape (MT1) failed but the mouse works, the problem is the hand click, not the tape.' },
  { id: 'MT3', section: 'measure', page: 'hologram', kind: 'regress', ref: 'measurePanel',
    title: 'Report copy',
    action: 'Open Report and press copy.',
    correct: 'A short confirmation, and the report text is on your clipboard (paste it anywhere to check).',
    bug: 'Nothing is copied, or the text is empty.',
    tell: 'The browser may ask for clipboard permission once; allowing it is normal.' },

  // ---- Hands (hands.html, Platform camera) ----
  { id: 'HA1', section: 'hands', page: 'hands', kind: 'known', ref: 'BUGS #29 (live confirm)',
    title: 'Camera stop/start does not leak memory',
    action: 'Open Activity Monitor (Memory), find this Chrome tab. Note the number. Start and stop the camera 5 times (about 5 s each). Read the number again.',
    correct: 'Each restart is quick, and memory ends within about 50 MB of where it started.',
    bug: 'Each restart reloads slowly, and memory climbs by 50 to 100 MB per restart.',
    tell: 'Memory goes up a bit on the first start and then levels off: that is fine. Put "before / after" numbers in the note.' },
  { id: 'HA2', section: 'hands', page: 'platform', kind: 'live', ref: 'LEDGER H4',
    title: 'Platform camera: hover and select',
    action: 'Open the chair, press the camera button (📷) and allow. Point at the chair, then pinch with your other hand.',
    correct: 'A hand cursor appears; the part under it highlights; the pinch selects it.',
    bug: 'No cursor, the highlight lands on the wrong part, or the pinch does nothing.',
    tell: 'A cursor that lags a little is fine. A highlight on a part the cursor is not over is the bug.' },

  { id: 'HA3', section: 'hands', page: 'platform', kind: 'live', ref: 'P1 step 3 (grab / move)',
    title: 'Platform: fist slides the selected part',
    action: 'Camera on. Point at one chair part and select it (pinch your other hand). Then make a fist with one hand and move it left, right, and toward and away from the screen. Open your hand. Press Cmd+Z once.',
    correct: 'The selected part slides along the floor, following your fist, and never goes up or down. Opening the hand drops it where it is. One Cmd+Z puts it back where it started.',
    bug: 'The camera orbits instead of the part moving, the part lifts off the floor, or it takes several Cmd+Z to undo one grab.',
    tell: 'With nothing selected, a fist orbits the camera on purpose: select a part first.' },
  { id: 'HA4', section: 'hands', page: 'platform', kind: 'live', ref: 'P1 step 3 (twist)',
    title: 'Platform: wrist twist turns the part',
    action: 'With a part selected, make a fist and twist your wrist like turning a door handle, then open your hand. Press Cmd+Z once.',
    correct: 'The part turns about its upright axis as you twist, staying in place. One Cmd+Z undoes the whole turn.',
    bug: 'Nothing turns, the part tips over instead of turning flat, or the undo needs several presses.',
    tell: 'Sliding and turning in the same grab is normal. Note it if the turn feels backwards.' },
  { id: 'HA5', section: 'hands', page: 'platform', kind: 'live', ref: 'P1 step 3 (scale)',
    title: 'Platform: two-hand pinch resizes the part',
    action: 'With a part selected, pinch with BOTH hands and move them apart, then together. Release. Press Cmd+Z once.',
    correct: 'The part grows as your hands move apart and shrinks as they come together. One Cmd+Z returns it to its starting size.',
    bug: 'Nothing resizes, the whole scene resizes instead, or it takes several Cmd+Z to undo.',
    tell: 'If the second pinch also selects something, note it with the word "extra select".' },
  { id: 'HA6', section: 'hands', page: 'platform', kind: 'live', ref: 'P1 step 3 (pins)',
    title: 'Platform: K pins a part and it refuses to move',
    action: 'Select a part and press K. Try the fist slide, the wrist twist and the two-hand pinch on it. Press K again, then try the fist slide once more.',
    correct: 'While pinned, nothing moves, turns or resizes, the camera holds still, and the status line says it is pinned. After the second K the part moves again.',
    bug: 'The pinned part still moves, or the camera orbits while it is pinned.',
    tell: 'Pinning an item does not pin its parts: grabbing a part of a pinned item moves only that part. That is on purpose.' },
  { id: 'HA7', section: 'hands', page: 'platform', kind: 'live', ref: 'P1 step 3 (click-pinch)',
    title: 'Platform: the other hand\'s click-pinch never drags',
    action: 'Select a part. Make a fist with one hand to hold it, then pinch with your OTHER hand once, quickly, as a click. Release both.',
    correct: 'The click-pinch only selects what you are pointing at. The selected part is never dragged by that pinch.',
    bug: 'The part jumps or drags when the other hand pinches, or the pinch starts a resize.',
    tell: 'A deliberate pinch with BOTH hands held for a moment is the resize gesture, not a click: pinch fast and let go.' },
  // Hands on the page (Track B, Cody-2 / Cody-2b, 2026-10-01): synthetic checks pass
  // (handui-test, platform/hands-test section I); none of these has been seen on real hands yet.
  { id: 'HA8', section: 'hands', page: 'platform', kind: 'live', ref: 'Track B: hands on the page (handUI.js)',
    title: 'Platform: the hand cursor works the top bar and side panels',
    action: 'Camera on. Point at a top-bar button (for example Help) and pinch with your OTHER hand. Then point at the Items list, pinch and hold, and move your hand up and down to scroll it.',
    correct: 'The button presses as if clicked. Holding the pinch over a list scrolls it. While the cursor is over a panel nothing in the 3D view lights up.',
    bug: 'The cursor stops at the edge of the 3D view, the pinch does nothing on a button, or a part behind the panel gets selected.',
    tell: 'A same-hand pinch or holding still also clicks, but the other-hand pinch is the most reliable.' },
  { id: 'HA9', section: 'hands', page: 'platform', kind: 'live', ref: 'Track B: ring by hand',
    title: 'Platform: spin the Library ring with a fist, open a card with a pinch',
    action: 'Open the Library ring. Make a fist and slide it left and right, then open your hand. Point at a card and pinch with your other hand.',
    correct: 'The ring follows your fist card by card and coasts a little after a quick flick. The pinch opens the card you point at. Nothing in the scene behind moves.',
    bug: 'The ring does not move, spins the opposite way to your hand, or the scene behind it orbits.',
    tell: 'The Chair card should be first, and each stock sample card names its maker (the credit line).' },
  { id: 'HA10', section: 'hands', page: 'platform', kind: 'live', ref: 'Track B: polygon lens by hand',
    title: 'Platform: the polygon lens follows your hand and resizes',
    action: 'Turn on Polygon mode. Point around the model. Pinch with your other hand and keep holding, move your hand up, then down, then let go. Then pinch once quickly.',
    correct: 'The lens circle follows your pointing finger. Pinch-hold and up makes it bigger, down makes it smaller. A quick pinch selects the faces inside it.',
    bug: 'The lens stays where the mouse left it, jumps when you pinch, or a resize also selects faces.',
    tell: 'Moving about one hand-width up doubles the lens.' },
  { id: 'HA11', section: 'hands', page: 'platform', kind: 'live', ref: 'Track B: push-zoom, tilt, clap',
    title: 'Platform: fist zoom and tilt with nothing selected, clap resets the view',
    action: 'Click empty space so nothing is selected. Make a fist and push it slowly away from you, then pull it back. Raise your other open hand while the fist holds. Open both hands, pause, then clap once.',
    correct: 'Pushing away zooms in, pulling back zooms out. Raising the second hand tips the view. The clap puts the view back to show everything, and the status line says View reset.',
    bug: 'The zoom goes the wrong way for you, the view jumps, or the clap does nothing (or moves an item).',
    tell: 'If push = zoom in feels backwards, mark Fail and say so: the direction is a design choice we can flip.' },
  { id: 'HA12', section: 'hands', page: 'platform', kind: 'live', ref: 'Track B: camera remember / auto-start',
    title: 'Platform and Gesture demo: the camera comes back on by itself',
    action: 'Turn the camera on, then reload the page. Then open Help, untick "Remember the camera", and reload again.',
    correct: 'After the first reload the camera starts by itself (no extra click). After unticking, it stays off until you press Camera.',
    bug: 'You have to press Camera every time even with the box ticked, or it starts even when unticked.',
    tell: 'The browser must already allow the camera for this site; the first time it always asks.' },
  { id: 'GD13', section: 'gesture', page: 'hologram', kind: 'live', ref: 'Debbie-G #7 / #9 (host wiring)',
    title: 'Gesture demo: selected part outline, thumb-tap trial, tape by other-hand pinch',
    action: 'Select a part with the other-hand pinch. Then in Tools, open Pointer & feel and tick "Thumb-tap click (trial)" and press Shift+P to practise. Finally turn on the tape and place two points.',
    correct: 'The selected part keeps a steady outline. Shift+P starts the thumb-tap practice rounds and 🎯 reads Stop while it runs. Tape points are placed only by the other hand\'s pinch.',
    bug: 'No outline on the selected part, Shift+P does nothing, or a same-hand pinch or thumb tap drops a tape point.',
    tell: 'Thumb-tap is a trial, off by default; untick it after the test if you did not like it.' },
  { id: 'GD14', section: 'gesture', page: 'hologram', kind: 'regress', ref: 'calibration card click-through fix',
    title: 'Gesture demo: nothing invisible blocks the mouse at the top centre',
    action: 'Without starting calibration, drag the model with the mouse starting just under the top bar in the middle of the page.',
    correct: 'The model orbits as anywhere else.',
    bug: 'The drag does nothing there (an invisible calibration card used to sit on that spot).',
    tell: '' },
  { id: 'GD5b', section: 'gesture', page: 'hologram', kind: 'live', ref: 'GD5/GD6 re-test (owner marked unsure, no notes)',
    title: 'Re-test: other-hand select, then same-hand pinch (short note please)',
    action: 'Point at a part and pinch with your OTHER hand. Then point at a different part and pinch with the SAME hand, holding about 2 seconds. Then press Unsure, Pass or Fail and type one short note.',
    correct: 'The other-hand pinch selects at once. The same-hand pinch selects and the model stays still.',
    bug: 'Nothing is selected, or the model moves while you only pinch.',
    tell: 'Your last answers on GD5 and GD6 were Unsure with no note. Whatever you pick, write one line saying what you saw (for example "selected, model still" or "model moved"); that is what we need.' },

  // ---- Platform (platform/index.html) ----
  { id: 'PL1', section: 'platform', page: 'platform', kind: 'regress', ref: 'BUGS #50 (fixed, live confirm)',
    title: 'Top bar fits at 1400 px and narrower',
    action: 'Make the browser window about 1400 px wide, then drag it narrower, down to about 800 px. Look along the top bar.',
    correct: 'Nothing is cut off or overlapping. Below about 1500 px the buttons shrink to icons; hovering one shows its name. Inspector stays reachable.',
    bug: 'A button is cut in half at the edge, two buttons overlap, or a button disappears.',
    tell: 'Icons instead of words on a narrower window is intended, not a bug.' },
  { id: 'PL2', section: 'platform', page: 'platform', kind: 'regress', ref: 'LEDGER D2',
    title: 'Autosave survives a reload',
    action: 'Open the chair, move one part, then reload the page (Cmd+R).',
    correct: 'After the reload the part is still where you moved it.',
    bug: 'The part is back where it started.',
    tell: 'Wait about 2 seconds after the move before reloading. If it only fails when you reload instantly, write "instant reload" in the note (BUGS #37).' },
  { id: 'PL3', section: 'platform', page: 'platform', kind: 'regress', ref: 'LEDGER D3',
    title: 'Save a version',
    action: 'Make a small change (move a part), then press Cmd+S once.',
    correct: 'The status line says saved "…" of <project>, and the new version shows under this project on the Library ring.',
    bug: 'No message, or the version is missing on the ring.',
    tell: '"No changes since the last saved version" means nothing had changed: move a part and try again. Press it once only. Two versions from one press is a different bug (BUGS #41): write "duplicate" in the note.' },

  // ---- Polygon mode (platform) ----
  { id: 'PO1', section: 'polygon', page: 'platform', kind: 'live', ref: 'BUGS #46 / LEDGER H2',
    title: 'Whole chair turns to wire',
    action: 'Open the chair and press P.',
    correct: 'The WHOLE chair becomes a wire mesh over a faint skin.',
    bug: 'It looks unchanged, or only one part turns to wire.',
    tell: 'If you had a part selected first, only that part may turn to wire: press Esc, click empty space, and press P again before judging.' },
  { id: 'PO2', section: 'polygon', page: 'platform', kind: 'regress', ref: 'LEDGER H3',
    title: 'Hide a patch and undo',
    action: 'In polygon mode, click a patch, press Delete, then Cmd+Z.',
    correct: 'The patch hides, then comes back.',
    bug: 'Nothing hides, the wrong area hides, or undo does not bring it back.',
    tell: 'The mouse wheel changes the lens size; a bigger lens hides a bigger patch. That is expected.' },
  { id: 'PO3', section: 'polygon', page: 'platform', kind: 'live', ref: 'LEDGER H5 / L3',
    title: 'Mark a patch as inferred',
    action: 'Select a patch, press I, press I again, then Cmd+Z.',
    correct: 'The first I marks it inferred (hatched), the second I unmarks it, and undo reverses the last change.',
    bug: 'No hatching, or I toggles the whole view instead of the patch.',
    tell: 'Outside polygon mode, I switches the whole view (Completed / As scanned). If that happens here, polygon mode was not on.' },

  // ---- Library ring (platform) ----
  { id: 'LR1', section: 'ring', page: 'platform', kind: 'regress', ref: 'LEDGER H1',
    title: 'Ring is the landing screen',
    action: 'Open the Platform page fresh (or press L).',
    correct: 'The ring shows the sample card(s) (Chair) and a "Drop your own scan" card, readable and smooth.',
    bug: 'No cards at all, a card missing, or an error message.',
    tell: 'Cards fading in over a moment is the intended easing; still no cards after 5 seconds is the bug.' },
  { id: 'LR2', section: 'ring', page: 'platform', kind: 'live', ref: 'LEDGER I1 / photosafety',
    title: 'Spinning the ring is comfortable',
    action: 'Spin the ring with the mouse (drag or wheel), slowly and then fast.',
    correct: 'Movement eases in and out, and nothing blinks or flashes.',
    bug: 'Anything that blinks or pulses in brightness, or a jerky stop.',
    tell: 'Brightness that changes smoothly as a card turns is fine. Anything that flashes: stop, look away, and mark Fail.' },

  // ---- Upload (platform) ----
  { id: 'UP1', section: 'upload', page: 'platform', kind: 'live', ref: 'LEDGER D4',
    title: 'Drop your own scan',
    action: 'Drag a scan file from Finder onto the page.',
    correct: 'A new project appears with your scan.',
    bug: 'Nothing happens, or an error.',
    tell: 'A large scan can take a few seconds. Nothing at all after 20 seconds is the bug.' },
  { id: 'UP2', section: 'upload', page: 'platform', kind: 'live', ref: 'LEDGER D5 / BUGS #30',
    title: 'Filled-in surfaces look different and still',
    action: 'In Finder, open completion/out. Select chair_underside_completed.obj AND chair_underside_completed.json together and drag both onto the Platform page. When the chair appears, look under the seat and legs, then click the "View: Completed" button in the top bar (or press I) once, then once more.',
    correct: 'Filled-in faces under the chair look ghosted with a hatched pattern, clearly different from the solid scanned faces. The first press changes the button to "View: As scanned" and the hatched faces disappear; the second brings them back. Nothing flashes.',
    bug: 'Filled-in and scanned faces look the same, there is no "View" button, or see-through areas get brighter where they stack.',
    tell: 'Faint, even ghosting is right. Bright patches where two see-through layers overlap is BUGS #30 coming back. If you dropped only the .obj, there is nothing to hatch and no View button: drop both files.' },
  { id: 'UP3', section: 'upload', page: 'platform', kind: 'live', ref: 'photo upload',
    title: 'Photo upload shows a flat preview',
    action: 'Drag a photo (jpg/png) onto the page.',
    correct: 'A flat preview marked "2.5D preview" with the hint "Flat photo preview (2.5D)", not a real 3D model.',
    bug: 'No label, or it pretends to be a full 3D model.',
    tell: 'Real 3D from a photo is made offline (completion/photo3d.py), so a flat preview is the intended result here.' },

  // ---- Info only (Python) ----
  { id: 'IN24', section: 'info', page: null, kind: 'info', ref: 'BUGS #24',
    title: 'Thin walls are still mostly invented',
    action: 'Nothing to do on the site.',
    correct: 'n/a',
    bug: 'On thin shells (a vase wall) about 66% of the filled-in wall is invented.',
    tell: 'If you ever load a completed vase, expect a large hatched area. That is this open issue, not a new bug.' },
  { id: 'IN48', section: 'info', page: null, kind: 'info', ref: 'BUGS #48',
    title: 'Real room scans can fail to fill',
    action: 'Nothing to do on the site.',
    correct: 'n/a',
    bug: 'Completion fails on real rooms where faces fold back to back. Debbie is on it.',
    tell: 'Only seen when running the Python tools on a real room scan.' },
  { id: 'IN49', section: 'info', page: null, kind: 'info', ref: 'BUGS #49',
    title: 'Real rooms get extra walls and floors',
    action: 'Nothing to do on the site.',
    correct: 'n/a',
    bug: 'Small floor or wall pieces get stretched across the room (only 31% of added surface is real).',
    tell: 'Only seen in Python room completion output.' }
];

// ---- Tester tour (plain words for someone who has never seen the project) ----------------
export const TOUR_SECTIONS = [
  { id: 'landing', label: '1. The landing page' },
  { id: 'camera', label: '2. Camera and calibration' },
  { id: 'gesture', label: '3. Gesture demo' },
  { id: 'platform', label: '4. The platform' },
  { id: 'games', label: '5. Games' },
  { id: 'upload', label: '6. Your own photo or scan' },
  { id: 'end', label: 'Last: your thoughts' }
];

const tour = (id, section, page, title, action, correct, tell, extra = {}) =>
  ({ id, section, page, kind: 'tour', ref: 'Tester tour', title, action, correct, bug: '', tell, ...extra });
const rate = (id, section, label) =>
  ({ id, section, page: null, kind: 'rate', ref: 'Tester tour', title: `How easy was ${label}?`, action: 'Tap a number: 1 = very hard, 5 = very easy.', correct: '', bug: '', tell: 'There is no wrong answer. Go with your first feeling.' });

export const TOUR_STEPS = [
  // 1. Landing page
  tour('TL1', 'landing', 'landing', 'Look around the home page',
    'Open the home page (new tab) and scroll down slowly. Read the first screen, then glance at the feature cards.',
    'A 3D chair at the top that you can drag to turn, then cards that explain what you can do.',
    'If the chair stays blank, wait a few seconds for it to load, then refresh the page.'),
  tour('TL2', 'landing', 'landing', 'Find the two big buttons',
    'Find the buttons that open the gesture demo and the platform. Do not click them yet.',
    'You can tell, in your own words, what each one is for.',
    'Not sure what a button does? Say so in the note. That is useful to hear.'),
  rate('TLR', 'landing', 'the home page'),
  // 2. Camera + calibration
  tour('TC1', 'camera', 'hologram', 'Open the gesture demo',
    'Open the gesture demo. Do not start the camera yet. Look at the 3D object in the middle.',
    'A glowing blue chair, and a bar of buttons across the top.',
    'Blank screen? Refresh once. If it is still blank, mark Fail and say what you see.'),
  tour('TC2', 'camera', 'hologram', 'Turn the camera on',
    'Press the Camera button (top bar) and click Allow when your browser asks. Hold one hand up where the camera can see it.',
    'You see a see-through glowing hand following your real hand.',
    'No permission box? Check the camera icon in the address bar. The picture stays on this Mac; nothing is sent anywhere.'),
  tour('TC3', 'camera', 'hologram', 'Follow the setup card',
    'A small card walks you through 3 short steps (open hand, trace a rectangle with your pointing finger, aim at rings). Follow it.',
    'A bar fills at each step, then the card goes away.',
    'Bar not filling? Hold your hand a bit further from the camera and make sure the room is well lit. You can press Esc to skip.'),
  rate('TCR', 'camera', 'turning on the camera and setting up'),
  // 3. Gesture demo
  tour('TG1', 'gesture', 'hologram', 'Point at a part',
    'Point with your index finger (other three fingers curled) at the chair. Move your finger around.',
    'A small dot or ring follows your finger and the part under it lights up.',
    'Dot jumps around? Keep your hand steady and a little closer to the camera.'),
  tour('TG2', 'gesture', 'hologram', 'Select a part',
    'Point at one part and hold still for about a second. Then try again by pointing and pinching with your OTHER hand.',
    'A ring fills up and the part is selected. The pinch selects it straight away.',
    'Nothing selected? Move more slowly and hold really still. The mouse works too: just click the part.'),
  tour('TG3', 'gesture', 'hologram', 'Grab and move',
    'Make a fist and move it slowly across the screen.',
    'The chair follows your fist. Opening your hand lets go.',
    'It does not grab? Open your hand fully for a moment, then close it again.'),
  tour('TG4', 'gesture', 'hologram', 'Tilt',
    'Fist with one hand, then raise your other open hand about 20 cm and lower it again.',
    'The chair leans forward and back as your other hand goes up and down.',
    'No tilt? Make sure both hands are in view of the camera.'),
  tour('TG5', 'gesture', 'hologram', 'Make it bigger and smaller',
    'Pinch with both hands, then move your hands apart, then together.',
    'The chair grows as your hands move apart and shrinks as they come together.',
    'Nothing happens? Pinch more firmly (thumb and index tips touching) with both hands.'),
  tour('TG6', 'gesture', 'hologram', 'Explode it',
    'Hold both hands open, side by side, and pull them slowly apart.',
    'The chair slides apart into its separate parts so you can see inside.',
    'Not exploding? Pull slowly and keep your palms toward the camera.'),
  tour('TG7', 'gesture', 'hologram', 'Clap to put it back',
    'Rest your hands for a moment, then clap once, gently.',
    'The chair snaps back together and returns to where it started.',
    'Clap not seen? Bring your hands in a little closer to the camera, or press the Reset button (R).'),
  tour('TG8', 'gesture', 'hologram', 'Measure with the tape',
    'Press T on the keyboard, then click two points on the chair (point and pinch with the other hand also works).',
    'A line appears between the points with a length in centimetres or inches.',
    'No line? Press T again to turn the tape on, then try two clicks.'),
  tour('TG9', 'gesture', 'hologram', 'Try other objects',
    'Use the picker in the top bar (the name with ◂ ▸ arrows) to switch to the Tool chest, the Desk lamp and the Teapot. Explode the tool chest.',
    'Each object appears; the tool chest and lamp split into several parts.',
    'An object is missing? Tell us which one in the note.'),
  tour('TG10', 'gesture', 'hologram', 'Press the buttons with your hand',
    'With the camera on, point at a button in the top bar and pinch with your other hand, like a mouse click.',
    'The button works the same as if you had clicked it.',
    'Buttons are small. Point slowly and wait for the highlight before you pinch.'),
  tour('TG11', 'gesture', 'hologram', 'Open the tool wheel',
    'Hold up a peace sign (✌) for about a second. A ring of tools appears. Point at "Next model" (bottom left) and pinch your other hand.',
    'The wheel opens where your hand was, the tool you point at lights up, and the pinch switches to the next object.',
    'Hold the ✌ still until the wheel shows. To close it without picking, show ✌ again or press Esc. Keyboard: W opens it.'),
  rate('TGR', 'gesture', 'moving the objects with your hands'),
  // 4. Platform
  tour('TP1', 'platform', 'platform', 'Open the platform and the Library',
    'Open the platform. Press the Library button (or L). Move through the cards with the arrow keys, the mouse wheel, or by pointing and moving your hand.',
    'A ring of saved scenes you can turn like a TV menu.',
    'The ring is empty? Close it and add a sample object in the next step.'),
  tour('TP2', 'platform', 'platform', 'Open a sample',
    'Pick one of the sample objects and open it.',
    'It appears on the workbench as a glowing hologram.',
    'Nothing opens? Press Enter on the highlighted card, or double-click it.'),
  tour('TP3', 'platform', 'platform', 'Grab, twist and resize',
    'Select a piece of it, then move it, turn it and make it bigger or smaller (by hand or with mouse and keys).',
    'The piece follows you. Everything else stays where it was.',
    'Piece will not move? Click it first so it is selected. The U key (or Ctrl+Z) takes a move back.'),
  tour('TP4', 'platform', 'platform', 'Pin a piece',
    'Select a piece you moved and press K.',
    'A small pin mark shows. Later changes leave that piece alone.',
    'No mark? Click the piece first so it is selected, then press K again.'),
  tour('TP5', 'platform', 'platform', 'Polygon lens',
    'Press the Polygon button. The model turns into a wire of triangles. Move the mouse over it and scroll to change the lens size.',
    'A circular lens follows the mouse and highlights faces. Esc leaves the mode.',
    'Button greyed out? Open an object first.'),
  tour('TP6', 'platform', 'platform', 'Reload and see it all come back',
    'Refresh the page (Cmd+R).',
    'Your moved pieces, pins and view are all as you left them.',
    'Something is missing? Tell us what in the note. That matters a lot.'),
  rate('TPR', 'platform', 'the platform'),
  // 5. Games
  tour('TA1', 'games', 'demos', 'Open the games hub',
    'Open the games hub (new tab).',
    'A few game cards, each with a short description.',
    'Page looks empty? Refresh it once.'),
  tour('TA2', 'games', 'demos', 'Light painting',
    'Open Light painting and draw glowing light in the air (point with your finger, or use the mouse). Light the sparks in their colours.',
    'Glowing lines follow your finger or mouse. Sparks light up as you touch them.',
    'Not drawing? Make sure the camera is on, or use the mouse.'),
  tour('TA3', 'games', 'demos', 'Rebuild the chair',
    'Open Rebuild the chair. Move and twist each scrambled part until it snaps into place.',
    'A part clicks home when it is close and the right way round.',
    'Part will not snap? Turn it a little and move it closer to its faint outline.'),
  tour('TA4', 'games', 'demos', 'Block tower (if available)',
    'If the Block tower card is there, open it and stack three blocks.',
    'The blocks stack and wobble like real ones.',
    'No such card? Just mark this Pass and move on.', { optional: true }),
  tour('TA5', 'games', 'demos', 'Marble maze (if available)',
    'If the Marble maze card is there, tilt the board to roll the marble home.',
    'The marble rolls as you tilt the board.',
    'No such card? Just mark this Pass and move on.', { optional: true }),
  rate('TAR', 'games', 'the games'),
  // 6. Upload
  tour('TU1', 'upload', 'platform', 'Add a photo or a scan',
    'On the platform, drop a photo (JPG or PNG) or a scan file (GLB, OBJ or PLY) onto the page, or press Add files.',
    'Your file shows up in the library. A photo is a flat preview, marked as such; a scan appears as a hologram.',
    'Nothing happened? Try a different file. If it still fails, tell us the file type in the note.'),
  rate('TUR', 'upload', 'adding your own file'),
  // Last
  { id: 'TFREE', section: 'end', page: null, kind: 'free', ref: 'Tester tour',
    title: 'What was confusing? What did you love?',
    action: 'Type a few lines in the note box below. Anything at all.', correct: '', bug: '',
    tell: 'Short is fine. There are no wrong answers.' }
];

export const MODES = ['dev', 'tour'];
export const stepsFor = (mode) => (mode === 'tour' ? TOUR_STEPS : STEPS);
export const sectionsFor = (mode) => (mode === 'tour' ? TOUR_SECTIONS : SECTIONS);
const RATED_KINDS = ['rate', 'free'];
const isVerdictStep = (s) => !RATED_KINDS.includes(s.kind);

// RUN_STEPS follows the run mode (live binding; testguide.js and guide.html import it by name).
// Pages that load this file fresh pick the mode up from the saved state in loadState().
export let RUN_STEPS = STEPS.filter((s) => s.kind !== 'info');
const ALL = [...STEPS, ...TOUR_STEPS];
const byId = new Map(ALL.map((s) => [s.id, s]));
export const stepById = (id) => byId.get(id) || null;
export function setMode(state, mode) {
  const m = mode === 'tour' ? 'tour' : 'dev';
  RUN_STEPS = stepsFor(m).filter((s) => s.kind !== 'info');
  return { ...state, mode: m };
}

export function pageOf(pathname = '') {
  const p = String(pathname);
  if (/\/platform\/(index\.html)?$/.test(p)) return 'platform';
  if (/\/hologram\.html$/.test(p)) return 'hologram';
  if (/\/hands\.html$/.test(p)) return 'hands';
  return null;
}

export function freshState() {
  return { v: 1, mode: 'dev', active: false, startedAt: null, endedAt: null, cursor: RUN_STEPS[0].id, minimised: false, results: {}, savedAt: null, savedPath: null };
}

export function loadState(storage) {
  try {
    const s = JSON.parse(storage.getItem(STATE_KEY) || 'null');
    if (!s || s.v !== 1 || typeof s.results !== 'object' || !s.results) return freshState();
    setMode(s, s.mode);   // sets RUN_STEPS for this page
    if (!RUN_STEPS.some((x) => x.id === s.cursor)) s.cursor = RUN_STEPS[0].id;
    return { ...freshState(), ...s, mode: s.mode === 'tour' ? 'tour' : 'dev' };
  } catch { return freshState(); }
}

export function saveState(storage, state) {
  try { storage.setItem(STATE_KEY, JSON.stringify(state)); return true; } catch { return false; }
}

const VERDICTS = ['pass', 'fail', 'unsure'];

export function setVerdict(state, id, verdict, note = '', now = new Date()) {
  const step = stepById(id);
  if (!step || step.kind === 'info' || !isVerdictStep(step)) return state;
  const results = { ...state.results };
  if (verdict === null) delete results[id];
  else if (VERDICTS.includes(verdict)) results[id] = { verdict, note: String(note || '').slice(0, 1000), at: now.toISOString(), page: step.page };
  return { ...state, results };
}

// Rating (1-5) for a 'rate' step, or free text for a 'free' step. rating null/undefined clears a rating.
export function setAnswer(state, id, { rating = null, note = '' } = {}, now = new Date()) {
  const step = stepById(id);
  if (!step || !RATED_KINDS.includes(step.kind)) return state;
  const results = { ...state.results };
  const r = Number(rating);
  const text = String(note || '').slice(0, 2000);
  if (step.kind === 'rate') {
    if (Number.isInteger(r) && r >= 1 && r <= 5) results[id] = { rating: r, note: '', at: now.toISOString(), page: step.page };
    else delete results[id];
  } else if (text.trim()) results[id] = { note: text, at: now.toISOString(), page: step.page };
  else delete results[id];
  return { ...state, results };
}

export function move(state, delta) {
  const i = Math.max(0, RUN_STEPS.findIndex((s) => s.id === state.cursor));
  const j = Math.min(RUN_STEPS.length - 1, Math.max(0, i + delta));
  return { ...state, cursor: RUN_STEPS[j].id };
}

export function counts(state) {
  const c = { pass: 0, fail: 0, unsure: 0, notRun: 0, total: RUN_STEPS.length };
  c.total = RUN_STEPS.filter(isVerdictStep).length;
  for (const s of RUN_STEPS.filter(isVerdictStep)) {
    const v = state.results[s.id]?.verdict;
    if (v) c[v]++; else c.notRun++;
  }
  return c;
}

// Local time, like the run file names serve.py writes (docs/testing/runs/<page>/<local time>).
function stamp(iso) {
  if (!iso) return '?';
  const d = new Date(iso), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function summaryText(state, now = new Date()) {
  const c = counts(state);
  const line = (s) => {
    const r = state.results[s.id];
    const note = r?.note ? ` — note: ${r.note.replace(/\s+/g, ' ').trim()}` : '';
    return `  ${s.id} ${s.title} [${KINDS[s.kind].label}; ${s.ref}]${note}`;
  };
  const group = (v) => RUN_STEPS.filter(isVerdictStep).filter((s) => (state.results[s.id]?.verdict || 'not run') === v);
  const tourMode = state.mode === 'tour';
  const out = [
    `${tourMode ? 'Tester tour' : 'Guided test run'}, shadow site (localhost), ${stamp(state.startedAt)} to ${stamp(state.endedAt || now.toISOString())} (local time)`,
    `Pass ${c.pass} · Fail ${c.fail} · Unsure ${c.unsure} · Not run ${c.notRun} (of ${c.total})`
  ];
  for (const [v, label] of [['fail', 'FAIL'], ['unsure', 'UNSURE'], ['pass', 'PASS'], ['not run', 'NOT RUN']]) {
    const g = group(v);
    if (!g.length) continue;
    out.push('', `${label} (${g.length})`);
    // Passes and not-run steps only need ids unless the owner left a note.
    if (v === 'pass' || v === 'not run') {
      const withNotes = g.filter((s) => state.results[s.id]?.note);
      out.push('  ' + g.map((s) => s.id).join(', '));
      withNotes.forEach((s) => out.push(line(s)));
    } else g.forEach((s) => out.push(line(s)));
  }
  if (tourMode) {
    out.push('', 'RATINGS (1 hard - 5 easy)');
    for (const s of RUN_STEPS.filter((x) => x.kind === 'rate')) {
      const sec = TOUR_SECTIONS.find((x) => x.id === s.section)?.label || s.section;
      out.push(`  ${sec}: ${state.results[s.id]?.rating ?? 'not rated'}`);
    }
    const free = state.results.TFREE?.note;
    out.push('', 'WHAT WAS CONFUSING / WHAT DID YOU LOVE?', '  ' + (free ? free.replace(/\s+/g, ' ').trim() : '(nothing written)'));
  }
  if (state.savedPath) out.push('', `Saved run: ${state.savedPath}`);
  return out.join('\n');
}

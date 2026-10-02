# Phase 3: Teach by doing (spec)

*Drafted by Ricky on 2026-10-02 and saved by the overseer. Builders: Cody-GH (registry + lessons), Tony
(wording), Timmy (retiring the old test-guide steps).*

## Summary
`gestureRegistry.js` is the only list of gestures. It is plain data. Help, the tool wheel, landing
cards, game cards and lessons all read from it, so they can't drift apart.

Each mode or game gets a mini lesson of 10 seconds or less, with at most 3 gestures:
- the guide hand loops the gesture;
- your ghost hand sits next to it;
- a real event gives the ✓.

**Onboarding:** first run means calibration, then 3 core lessons (aim+click, grab, Done), then free
play. Free play shows one "next thing to try" hint at a time. A hint disappears after you do that
gesture twice and comes back after 10 s of doing nothing.

**Instructions:** they collapse to a "?" tab that a hand can't close. Each game waits for your first
success. All on-screen text is one line, icon and verb first, then ✓.

This follows three published guides:
- Apple: "teach through interactivity", one step at a time, replayable.
- Meta: "teach one core interaction, use it everywhere".
- Ultraleap TouchFree: guidance hides after 2 successes and returns after 10 s idle.

## 1. Registry (`gestureRegistry.js`, data only, no imports)
Fields: `id, icon, name, how, modes, success, clip`.
- `clip` is a key into `guideHand/gestures.js`. *new* means the clip has to be made.
- Mode codes: F free, T tape, N pins, P polygon, E explode, R ring, W wheel, C calibration, G games.

| id | icon | name | how (≤8 words) | modes | success (event / value) | clip |
|---|---|---|---|---|---|---|
| aim | 🔫 | Finger-gun aim | Point index, thumb up, three curled | F T N P E R W C G | `arbiter.state.owner==='AIM'` ≥300 ms with the crosshair on a target | pose:pointer + new aim |
| click | 👍⤵ | Thumb hammer click | Drop your thumb onto your knuckle | F T N P E R W C G | `hologram:click` (hand source) | click (re-key, §4) |
| grab | ✊ | Fist grab move | Close fist, move, open to drop | F E R G | manip mode `grab`, object moves ≥3 cm | drag→fist (new grab) |
| tilt | ✊🖐 | Fist-palm tilt | Fist holds; other open hand tilts | F G(maze, chair) | mode `transform`, rotation Δ ≥20° | tilt |
| ratchet | ✊✊ | Ratchet turn more | Close other hand, reopen, tilt again | F | 2 re-baselines in one grab | new |
| flick | 💨 | Flick to spin | Tilt fast, then open both hands | F | coasting angular velocity >0 after release | new |
| scale | 🤏↔🤏 | Pinch-spread scale | Pinch both hands, pull apart sideways | F | uniform scale ×1.3 or ÷1.3 | scale |
| stretch | 🤏↕🤏 | Pinch-spread height | Pinch both hands, pull apart vertically | F | `m.height.stretch` off 1 by ≥0.2 | new |
| explode | 🙌↔ | Open-hands explode | Two open hands, spread apart | F E | mode `explode`, amount ≥0.5 | explode |
| assemble | 🙌→← | Open-hands assemble | Bring open hands slowly together | E | explode amount back to 0, edits kept | new |
| clap | 👏 | Clap to reset | Clap once | F E G | `clap` event; in explode, original transforms come back | clap |
| done | ✋ | Palm hold Done | One open palm, hold still | every scoped tool, W | `done` event (arming ring reaches 1) | new |
| undo | 👎 | Thumbs-down undo | Thumb down, hold half a second | F T N P G | `undo` event | undo (the thumbsDown pose needs mirroring) |
| wheel | ✌ | Peace sign wheel | Hold a peace sign | F (any idle) | wheel `open` | wheel |
| swipe | 👋 | Open-hand swipe | Flat hand, sweep left or right | R (up/down = versions) | `swipe {dir}` | new |

## 2. Mini lessons (watch → copy → ✓, ≤10 s each, ≤3 gestures)

| Mode | Copy | Success | Text |
|---|---|---|---|
| Free move | grab · tilt · clap | grab moves ≥3 cm → transform Δ ≥20° → clap | ✊ Grab it, move it ✓ |
| Tape | aim · click ×2 · undo | 2 points, `panel.tapeDistance` > 0 | 📏 Drop thumb at A, then B ✓ |
| Pins | wheel ↖ · click | a pin on the target | 📌 Wheel ↖, then click to pin ✓ |
| Polygon lens | aim · click · done | faces selected > 0, then done | 🔷 Aim, drop thumb to select faces ✓ |
| Explode | explode · click a part · assemble | amount ≥0.5 → activePart → amount 0 | 🙌 Spread hands to open it ✓ |
| Ring | swipe · aim+click | ring.swipe → ring.pick | 👋 Swipe to browse, click to open ✓ |
| Calibration | existing v2 steps | V2_ORDER complete | (already icon + ✓ text) |
| Chair | grab · tilt · undo | first part placed | ✊ Grab a part onto its outline ✓ |
| Maze | tilt · clap | board tilt ≥5° → marble moves ≥1 cell | ✊🖐 Fist + open hand tilts the board ✓ |
| Tower | grab · release | a block leaves its slot ≥½ block | ✊ Grab a block, slide it out ✓ |
| Paint | aim · thumb held down | first stroke ≥10 points (OQ1) | 🔫 Hold your thumb down to paint ✓ |

**Lesson rules**
- **While watching:** the guide clip loops. Your ghost hand is tinted by `arbiter.state.pose`, and its
  outline turns green when your pose matches.
- **On ✓:** an eased green tick and a soft chime (600 ms, no flash, BUGS #14), then it moves on
  automatically.
- **If stuck:**
  - at 10 s, "▶ watch again" appears along with the mouse/key equivalent;
  - at 20 s, "Skip" appears (button or Esc).
  - Skipping never uses a gesture, so a Done palm can't skip by accident.
- **Gating:** each lesson calls `arbiter.setScope(lessonScope)`, so only the gesture being taught can
  fire.

## 3. Onboarding flow
1. **First run** (no `hands.profile.v2`): Camera → calibration v2. The hammer drill doubles as click
   practice.
2. **3 core lessons** on the real model:
   - aim+click: 1 click, since calibration already did 10;
   - grab;
   - Done.

   Progress shows as ●●○ and there's no other text.
3. **Free play with hints:**
   - `hands.learned` (in localStorage) records each gesture id once it succeeds.
   - After 8–10 s idle in a mode, one chip shows, e.g. "Next: ✊ fist to grab", with a looping mini clip.
   - The chip hides after 2 successes.
   - Only one hint shows at a time, and only for gestures in the current scope.
4. **First tool use** runs that tool's lesson automatically, once. After that, a ▶ / ? tab on the tool
   chip replays it.
5. **`#try=<id>`** opens hologram.html and runs that registry lesson. This makes the 9 dead links in
   index.html work.
6. **Games:**
   - `#howto` collapses into a "?" tab and never goes away.
   - The × is mouse/keyboard only; the card gets `data-hand="ignore"`, so a stray hand click does nothing.
   - The card collapses on its own after the first success.
   - The timer and challenge start only after that first success.

## 4. Rewrite list (v2 text)
| Where | New text |
|---|---|
| hologram.js:188 | `💥 Exploded · 🔫 drop thumb to pick a part · 🙌 close hands to assemble` |
| hologram.js:202 | `✌ Wheel · 🔫 aim at a tool, drop thumb · ✋ hold palm to close` |
| hologram.js:234 | `✓ Calibrated` / `🔫 Aim, drop your thumb to click · ✓ ring follows your finger` |
| hologram.js:412 | `📏 Drop thumb at A, then B · ✓ distance by the chip` |
| hologram.js:981 | `row('Click', '🔫 drop your thumb')`. Generate the whole Help table from the registry. |
| platform/index.html:418 | Registry list. Fallback: `🔫 aim · drop thumb selects · ✊ move · 🤏🤏 resize · 👏 reset` |
| platform/polygon.js:388 | `🔷 Drop thumb (or click) selects faces in the lens · [ ] sizes · ✋ Done leaves` |
| platform/hands.js:534 | `✓ Calibrated · 🔫 aim at an item, drop thumb to select` |
| platform/hands.js:635 | `Camera on · 🔫 aim at an item, drop thumb to select` |
| measurePanel.js:176 | `📏 Drop thumb (or click) at A, then B · model holds still · ✓ live distance` |
| about.html:37 | `aim with a finger-gun, drop your thumb to click, fist to grab, fist + open hand to tilt, two hands to scale or explode, clap to reset, palm to finish.` |
| guideHand/gestures.js:204, 216 | `'pinch'` / `'other hand pinches'` → `'drop thumb'`. Re-key the `click` clip so the aiming hand's thumb goes cocked → dropped. Line 359 `'hold pinch'` → `'hold thumb down'` (if OQ1 is approved). |
| testguide-steps.js:116, 166, 192, 199, 237, 243 | Change "pinch your other hand" to "drop your thumb". |
| testguide-steps.js:222–225, 260–262 | Retire. These steps test v1 click semantics. |
| testguide-steps.js:231, 272 | Retire, or rewrite once the v2 scroll gesture is decided. |
| Also stale | demos/play.html:114 `other-hand pinch · Enter · click` → `drop thumb · Enter · click`; paint `tutorial[0]`; calibrate.js:217 (v1 path, can stay while v1 lives) |

## 5. Prior art
1. **Apple, *Onboarding for Games*.**
   - What it says: teach one step at a time with short, clear instructions; let players demonstrate
     competency before moving on; let them skip and replay.
   - Applied as: the 3-step lessons, Skip, ▶ replay. (confirmed)
2. **Apple HIG onboarding.**
   - What it says: teach through interactivity, and prefer context-specific tips over one long flow.
   - Applied as: hints in free play. (likely; secondary summary)
3. **Meta, Hands best practices.**
   - What it says: teach one core interaction and use it everywhere; gestures must be taught and
     memorized; audio or visual feedback is critical.
   - Applied as: the hammer click is the only click everywhere, plus the ✓ tick and chime. (confirmed)
4. **Ultraleap TouchFree guidance.**
   - What it says: guidance appears when a hand is detected, hides after 2 confirmed interactions and
     returns after 10 s of inactivity; the attract loop is a 5–8 s animation users can copy.
   - Applied as: the hint timing and the lesson length. (confirmed)
5. **Apple visionOS guidance.**
   - What it says: be careful with two-handed gestures and always give a non-gesture alternative.
   - Applied as: every lesson shows the mouse/key equivalent. (likely; secondary summary)

## Owner decisions (2026-10-02)
- **OQ1 → hold thumb down = drag.** Drop the hammer thumb and keep it down to draw or drag; lift it to stop. This is the same gesture family as click, and it applies to paint and any drag.
- **OQ2 → open-hand swipe.** A flat hand sweeping up or down scrolls lists. In the polygon lens, swipe up grows the lens and swipe down shrinks it. It's the same motion as the library ring.

## Open questions (owner) — original
- **OQ1, paint pen-down:** should "hammer held down" mean drag? `gunPose` keeps `dropped` until the thumb
  re-cocks, so it's feasible. The alternative is a fist-drag.
- **OQ2, scrolling:** v2 has nothing to replace the old pinch-hold scroll for lists and the polygon lens
  size.
- **Done vs explode:** both start from open hands. Done requires the other hand to be absent, so check
  it in clip-lab.

## Sources
- https://developer.apple.com/app-store/onboarding-for-games/ (read 2026-10-02)
- https://developers.meta.com/horizon/design/hands-best-practices/ (read 2026-10-02)
- https://docs.ultraleap.com/TouchFree/touchless-interfaces/guidance.html (read 2026-10-02)
- https://developerguidelines.com/human-interface-guidelines/version/9/onboarding/index.html (search summary only)
- https://github.com/yue1123/apple-hig-skills/blob/master/apple-hig/references/platforms/visionos.md (secondary)

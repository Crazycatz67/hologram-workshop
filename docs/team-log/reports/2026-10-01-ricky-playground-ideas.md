# Playground: fun hologram demos (Ricky, 2026-10-01; saved by the overseer)

## Recommended first 5
These use existing gestures only, and every library they need has a free licence.
1. **Light painting** (S): pinch-hold drag draws; ✌ wheel picks a colour; 👎 undoes; a clap clears. It is fun within 5 s and needs almost no precision.
2. **Rebuild the chair** (S–M): explode the chair, then fist-move and twist the parts until they snap back into place. Use generous snap angles.
3. **Block tower / Jenga-lite** (M): fist = kinematic grab, open palm = release or throw, clap = reset. Moves stay in a fixed plane because webcam depth is weak. Physics: cannon-es (MIT).
4. **Chess vs AI** (M–L):
   - Click-click with legal moves lit.
   - Rules: chess.js (BSD-2). AI: js-chess-engine (MIT). Avoid Stockfish (GPLv3).
   - **assets/chess/chess.glb is one fused 13.9 MB scan mesh, so the pieces can't be separated.** New pieces are needed: LatheGeometry or a CC0 set.
5. **Marble maze** (M): uses the existing hybrid tilt. Levels last 60–90 s because of arm fatigue. Track pieces: Kenney Marble Kit (CC0).

## Later
- Small (S): theremin, Tower of Hanoi or sliding puzzle, solar system or globe.
- Medium (M): bowling or dominoes, which depend on release velocity, a noisy signal on a webcam.
- Large (L): Rubik's cube or tangram (rotation precision); pottery, LEGO building, hologram pet.

## Architecture
Each game is a module in `demos/<id>/demo.js`:
```
{ id, title, thumb, tutorial:[clip names], load(ctx), onGesture(evt), tick(dt), reset(), isWon(), dispose() }
```
- **ctx** holds the scene, camera and runtime, plus `createManipulator`, `createSelector`, `holdGate`, sfx and the win banner.
- **evt** is one of `aim | click | grab | release | tilt | scale | explode | clap | wheel | undo | drag`.
- **Hub:** the ring.js card ring becomes the landing arcade. Each card has a 3 s looping preview, a row of gesture icons and a "≈60 s" badge.

## Photosafety
- Win effects use an eased glow or confetti.
- Light painting never cycles colours rapidly.
- A collapse never shakes the screen or flashes.
- Every page goes through safety-test.

## Open questions
- Do js-chess-engine and Rapier load without a build step?
- Is the marble maze tilt comfortable for 90 s?

## Sources
- chess.js · js-chess-engine · stockfish.js (GPLv3) · cannon-es · rapier.js
- Kenney Marble, Minigolf and Board Game kits (CC0)
- Leap Motion Blocks deep-dive
- Meta First Hand
- Hincapié-Ramos et al., "Consumed Endurance", CHI 2014

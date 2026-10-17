# Board logic tests (headless)

`run.mjs` drives the **real** `../js/board3d.js` in Node with a stubbed
`three` module (`../node_modules/three` — minimal API surface, no rendering)
and stubbed DOM. It verifies:

1. Token placement math (track/yard/home-column/center/tray coordinates, stacking offsets)
2. Hop animations land on the right squares (frames are simulated at 60fps)
3. Capture animation (token sent back to yard)
4. Interaction gating (dice/token taps only when allowed → `onUserRoll`/`onTokenPick`)
5. Highlight-ring visibility + tracking
6. `animateDice()` promise timing (not resolved mid-tumble, resolved after settle)
7. Rapid `setState()` queueing (no overlap, final state correct)
8. `showWinner()` confetti + banner without crashing
9. Finished-tray (pos 57) placement

Run: `node run.mjs` → expect `26 passed, 0 failed`.

Note: this tests logic/geometry, not visuals. For visual verification use
`../board-test.html` served over http (e.g. `python3 -m http.server` in `client/`).

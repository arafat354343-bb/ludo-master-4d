# LudoBoard — 3D board module (`js/board3d.js`)

Three.js **0.160.0** 3D Ludo board, loaded as an ES module via importmap from the unpkg CDN.
No build step. Exposes `window.LudoBoard` for `js/app.js`.

## Interface (exact — do not change)

```js
window.LudoBoard = {
  init(containerEl)        // Promise<void> — builds renderer/scene/board, starts loop
  setState(pubState, myColor) // diff token positions, queue hop animations, update highlights
  animateDice(value)       // Promise<void> — tumble ~1s, settle with `value` up, then resolve
  onUserRoll               // null | (() => void)   — set by app.js
  onTokenPick              // null | ((tokenIndex: number) => void) — set by app.js
  showWinner(color)        // confetti burst + "WINNER" banner sprite
}
```

Server public state shape:

```js
{ roomId, mode, entry,
  players: [{ id, name, color, isBot, tokens: [p0, p1, p2, p3] }],
  turnColor,                       // 'red' | 'green' | 'yellow' | 'blue'
  phase: 'awaitingRoll' | 'awaitingMove' | 'over',
  dice, movableTokens: [idx...], winner }
```

Interaction rules enforced by the module (raycast on pointerdown):
- 3D dice tappable **only** when `phase === 'awaitingRoll' && turnColor === myColor` → `onUserRoll()`.
  A glowing pulsing ring + "TAP TO ROLL" label appears under the dice in that case.
- Token tappable **only** when `phase === 'awaitingMove' && turnColor === myColor`
  and its index is in `movableTokens` → `onTokenPick(tokenIndex)`.
  Movable tokens get a pulsing gold ring at their base.
- Non-interactive at all other times.

## Coordinate mapping

Unit = 1 cell. 15×15 grid centered at origin: `x = col − 7`, `z = row − 7`
(row 0 = far/top edge, `z = −7`).

**Main track — 52 absolute squares (row, col):**

| idx | coord | idx | coord | idx | coord | idx | coord |
|-----|-------|-----|-------|-----|-------|-----|-------|
| 0 | (6,1) | 13 | (1,8) | 26 | (8,13) | 39 | (13,6) |
| 1 | (6,2) | 14 | (2,8) | 27 | (8,12) | 40 | (12,6) |
| 2 | (6,3) | 15 | (3,8) | 28 | (8,11) | 41 | (11,6) |
| 3 | (6,4) | 16 | (4,8) | 29 | (8,10) | 42 | (10,6) |
| 4 | (6,5) | 17 | (5,8) | 30 | (8,9)  | 43 | (9,6)  |
| 5 | (5,6) | 18 | (6,9) | 31 | (9,8)  | 44 | (8,5)  |
| 6 | (4,6) | 19 | (6,10)| 32 | (10,8) | 45 | (8,4)  |
| 7 | (3,6) | 20 | (6,11)| 33 | (11,8) | 46 | (8,3)  |
| 8 | (2,6) | 21 | (6,12)| 34 | (12,8) | 47 | (8,2)  |
| 9 | (1,6) | 22 | (6,13)| 35 | (13,8) | 48 | (8,1)  |
| 10| (0,6) | 23 | (6,14)| 36 | (14,8) | 49 | (8,0)  |
| 11| (0,7) | 24 | (7,14)| 37 | (14,7) | 50 | (7,0)  |
| 12| (0,8) | 25 | (8,14)| 38 | (14,6) | 51 | (6,0)  |

Start offsets: red 0, green 13, yellow 26, blue 39.
Token at track pos `p` (0–50) → absolute square `(offset + p) % 52`.
Note: links 4→5, 17→18, 30→31, 43→44 are diagonal corner-cuts (standard Ludo cross shape).

**Safe squares** (star markers): absolute `[0, 8, 13, 21, 26, 34, 39, 47]`.

**Home columns** (pos 51–55):
- red: `(7,1) (7,2) (7,3) (7,4) (7,5)`
- green: `(1,7) (2,7) (3,7) (4,7) (5,7)`
- yellow: `(7,13) (7,12) (7,11) (7,10) (7,9)`
- blue: `(13,7) (12,7) (11,7) (10,7) (9,7)`

**pos 56** → center `(7,7)` + per-color offset (red −0.42x, green −0.42z, yellow +0.42x, blue +0.42z).

**pos 57** → finished tray: 4 slots per color just outside the grid near that color's corner
(red top edge `z=−8.3`, green top, yellow bottom, blue bottom).

**Yards** (pos −1), 4 slots each:
- red: `(2,2) (2,3) (3,2) (3,3)` — top-left 6×6 base
- green: `(2,11) (2,12) (3,11) (3,12)` — top-right base
- yellow: `(11,11) (11,12) (12,11) (12,12)` — bottom-right base
- blue: `(11,2) (11,3) (12,2) (12,3)` — bottom-left base

## Implementation notes

- Board top is a single 1600px canvas texture (track cells, stars, yard circles, home
  triangles) on a cream slab + wooden trim; tokens/dice are real 3D meshes with shadows.
- Tokens: pawn = cylinder base + tapered body + sphere head, glossy player color + white
  base ring. Geometries/materials shared; stacked tokens on one square get 2×2 mini-offsets.
- Dice: box with canvas pip textures (faces sum to 7 opposite). `animateDice(v)` tumbles
  0.65s then slerps 0.35s so face `v` lands up with random yaw. Dice + wooden pedestal
  slide to the current player's corner on turn change.
- Movement: `setState` diffs token positions vs the last fully-applied state, animates each
  moved token with hop arcs cell-by-cell (~120ms/cell). All animations go through one FIFO
  queue — rapid `setState` calls never overlap or glitch. Captured tokens hop back to yard.
- Camera: fixed direction ≈ (0,16,11); distance auto-fits board + pedestals per aspect
  (portrait phones included). Pixel ratio capped at 2. Draw calls well under 300.
- `showWinner(color)`: 340-particle confetti burst in the winner's color (+gold/white),
  then a pop-in "🏆 WINNER — COLOR" banner sprite that auto-fades after ~6s.
- WebGL unavailable → friendly 2D message div instead of a crash; all API calls no-op.

## Test page

`board-test.html` — buttons: init 4-player mid-game · simulate dice roll · highlight movable
tokens · move a token (+6 hop) · capture demo · my-turn (tap dice) · show winner · reset.
Interaction callbacks are logged to the on-page console.

Run: `cd ~/workspace/ludo/client && python3 -m http.server 8080`, then open
`http://localhost:8080/board-test.html` (ES modules + CDN importmap require http, not `file://`).

## Deviations from spec

None — coordinates, interface shape, and interaction rules implemented exactly as specified.

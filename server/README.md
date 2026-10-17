# Ludo Game Server

Real-time Ludo (Ludo King rules) game server: Express REST API + Socket.IO.
**Virtual coins only** — coins are an in-game score with no cash value. There is
no add-money, no cash-out, no withdraw-to-money and no payment feature anywhere
in this codebase.

The authoritative rules engine lives at `../shared/ludo-engine.js` (written by a
teammate). The server requires it at boot and **fails fast with a clear error**
if the file is missing or does not expose the expected API.

## Requirements

- Node.js 20+
- PostgreSQL (optional — without `DATABASE_URL` the server runs on a loud,
  transparent in-memory database; data is lost on restart)

## Setup

```bash
cd ~/workspace/ludo/server
npm install
cp .env.example .env   # then edit JWT_SECRET (required)
```

### Environment variables

| Var            | Required | Description                                              |
|----------------|----------|----------------------------------------------------------|
| `PORT`         | no       | HTTP port (default `3000`)                               |
| `JWT_SECRET`   | **yes**  | Secret for signing JWTs (7-day expiry). Server refuses to boot without it. |
| `DATABASE_URL` | no       | Postgres connection string. If unset → in-memory dev DB. |
| `BOT_DELAY_MS` | no       | Base ms before a bot acts (default `1200`). Useful in tests. |

### Database

```bash
psql "$DATABASE_URL" -f migrations.sql
npm start
```

### Run

```bash
npm start   # → node src/index.js, listens on $PORT
```

## REST API (JSON)

Auth: `Authorization: Bearer <token>` (JWT, 7-day expiry). Password hashes are
never returned by any endpoint.

| Method | Path                 | Auth | Body / Notes |
|--------|----------------------|------|--------------|
| POST   | `/api/auth/signup`   | –    | `{name, email, password}` (password ≥ 6). → `201 {token, user}`. Duplicate email → `409`. New users start with **5410** coins. |
| POST   | `/api/auth/login`    | –    | `{email, password}` → `{token, user}`. Wrong credentials → `401`. |
| GET    | `/api/me`            | yes  | → `{id, name, email, coins}` |
| PUT    | `/api/me`            | yes  | `{name}` → updated user |
| GET    | `/api/stats`         | yes  | → `{gamesPlayed, gamesWon, winRate, wins2p, wins4p, totalEarned, coins}` |
| GET    | `/api/rooms`         | –    | → `{twoPlayer: [{entry, win}], fourPlayer: [{entry, win}]}`. Entries `[40, 50, 60, 80, 300]`; 2P win = `round(entry*1.6)`, 4P win = `round(entry*3.2)`. |
| POST   | `/api/wallet/daily`  | yes  | Daily bonus: +500 coins once per calendar day → `{granted, coins}` |

## Socket.IO

Connect with `auth: { token }` (`socket.handshake.auth.token`). Sockets without
a valid token are disconnected immediately.

Client → server:

| Event          | Payload                        |
|----------------|--------------------------------|
| `queue:join`   | `{mode: '2p' \| '4p', entry}`  |
| `queue:leave`  | –                              |
| `game:roll`    | –                              |
| `game:move`    | `{token}` (0–3)                |

Server → client:

| Event           | Payload |
|-----------------|---------|
| `queue:status`  | `{waiting, mode, entry}` |
| `game:start`    | `{roomId, state}` |
| `game:state`    | `{state}` — public state (see below) |
| `game:dice`     | `{color, value}` |
| `game:timer`    | `{secondsLeft}` — 15s countdown ticks each turn |
| `game:over`     | `{rankings: [{color, name, isBot, score}], coinDelta, winnerColor}` — `coinDelta` is the net wallet change for that player (`win - entry` for the winner, `-entry` otherwise) |
| `wallet:update` | `{coins}` — current balance |
| `error`         | `{message}` |

Public state shape:

```json
{
  "roomId": "…", "mode": "2p", "entry": 40,
  "players": [{"id": "…", "name": "…", "color": "red", "isBot": false,
               "tokens": [-1,-1,-1,-1], "finishedCount": 0}],
  "turnColor": "red", "phase": "awaitingRoll", "dice": null,
  "movableTokens": [], "winner": null
}
```

### Matchmaking & turn rules

- Queues are keyed by `mode:entry`. 2P starts at 2 humans; if 1 human waits
  >20s, a bot is added and the game starts. 4P starts at 4 humans; if ≥1 human
  waits >25s, bots fill the seats to 4.
- On start every human must hold ≥ entry coins (else they are dropped from the
  queue with an `error`); the entry is deducted up front. Colors: 2P →
  `['red','yellow']`, 4P → `['red','green','yellow','blue']`.
- 15s per turn with countdown ticks. Human timeout on roll → server auto-rolls;
  timeout on move → server auto-picks via `Engine.chooseBotMove`. Bots act after
  ~1.2s.
- On game over the human winner is paid the win amount; `recordGame` +
  `incrementStats` run for every human; each connected human gets `game:over`
  (with their own `coinDelta`) and `wallet:update`.
- If a human disconnects mid-game, their turns convert to bot control
  immediately; the game continues and they are still credited if their side wins.

## Project layout

```
server/
  src/index.js   # Express app, REST routes, Socket.IO wiring, boot
  src/db.js      # storage abstraction (PostgreSQL ⇄ in-memory fallback)
  src/auth.js    # JWT sign/verify + Express middleware
  src/game.js    # GameManager: rooms, matchmaking, turn loop, timers, payouts
  src/bot.js     # bot naming + action-delay wrapper
  migrations.sql # PostgreSQL schema
  .env.example
```

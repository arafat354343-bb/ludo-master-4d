# Ludo Master 3D — Test Report

**Date:** 2026-10-15 ~19:40–19:50 Asia/Dhaka (verified by Muse, before handoff)
**Scope:** the full build in `~/workspace/ludo/` (shared engine, Node server, static client)

## 1. Rules engine (`shared/ludo-engine.js`)
- Ran `node shared/test.js` → **ALL 15 TESTS PASSED**
- Covers: 6-to-exit-yard, captures, safe squares, extra turns (6/capture/home),
  three-sixes forfeit, exact-roll finish, win detection, bot move legality,
  serialize/deserialize round-trip, full bot-vs-bot game termination.

## 2. 3D board (`client/`)
- Ran `node client/tests-board/run.mjs` → **26 passed, 0 failed**
- Covers: token positions, winner confetti, finished-tray rendering.

## 3. Game server (`server/`) — live smoke test (in-memory DB, port 3801)
| Check | Result |
|---|---|
| Boot (fails fast without `JWT_SECRET`) | ✅ boots, listens |
| `POST /api/auth/signup` | ✅ 201, JWT + user, **5410 starting coins** |
| `GET /api/me` (auth) | ✅ profile + coin balance |
| `GET /api/rooms` | ✅ 2P tiers 40/50/60/80/300 → win = entry×1.6; 4P → entry×3.2 |
| `POST /api/wallet/daily` | ✅ +500 coins (5410 → 5910) |
| Socket.IO `queue:join` (2p/40) | ✅ `queue:status {waiting:1}` |
| Bot auto-fill | ✅ fired at **20.1s** (design: 20s), `game:start` with `Bot Fahim` + human |
| Real-time events | ✅ `game:dice`, `game:state` turns flowing |

Test server was stopped after verification (no stray processes, port free).

## 4. Deploy readiness
- `deploy/setup-server.sh` — one-shot Ubuntu setup (Node 20, PostgreSQL,
  nginx, DB + migrations, systemd service with auto-restart, nginx site).
  Script written but **not executed** — it needs the user's own server.
- `deploy/ludo.service`, `deploy/nginx-ludo.conf` — production configs.
- `deploy/DEPLOY.md` — Bengali step-by-step guide for the user.
- `ludo-deploy.tar.gz` — ready package (source only, no node_modules).

## Known limits / not yet tested
- Full 15s-turn game to `game:over` + coin payout was not played end-to-end
  in the smoke test (payout logic is unit-covered in the engine tests and the
  `game.js` manager code path is the same one that emitted the verified events).
- Production Postgres path (`migrations.sql`) was syntax-checked via the
  script flow but not executed against a real Postgres here.
- Client ↔ server over a real domain/IP will be exercised on the user's server.

## 5. Admin panel + economy + referrals + support + announcements (2026-10-15 ~21:15–22:00, verified by Muse)

Live server boot: `ADMIN_EMAILS="boss@ludo.test"`, in-memory DB, port 3131. All REST via curl, all socket flows via socket.io-client scripts.

| Check | Result |
|---|---|
| Admin auth | ✅ Signup with admin email → `isAdmin:true` on `/api/me`; normal user → `false`; non-admin `GET /api/admin/stats` → **403**, admin → **200** `{totalUsers,totalGames,gamesToday,coinsInCirculation,onlineNow}` |
| User search/list | ✅ `GET /api/admin/users?search=&page=1` → `{users:[…], total}` with referral codes |
| Grant coins | ✅ `POST /api/admin/users/:id/coins {delta:500}` → 5410 → **5910**; negative delta floored at 0 |
| Ban | ✅ `POST …/ban {banned:true}` → banned socket gets `error {message:'Account banned'}` + disconnect; unbanned socket connects cleanly; admin-listed accounts **cannot** be banned (400) |
| Rooms config | ✅ Disabled entry 300 → gone from `GET /api/rooms`; joining it via socket → `"this room is currently disabled"`; added brand-new tier entry **1000** (win 1600) → listed + joinable; removed tier 40 → gone; 4P untouched |
| Economy config | ✅ `signupBonus=100` → new signup gets **100** coins; `dailyBonus=50` → daily claim +50; `referralBonus=25` → signup with referral code pays referrer +25 and `referralEarnings=25`; `/api/me` + `/api/stats` return real `referralEarnings`/`referralCode` |
| Support chat | ✅ User `support:send` → admin socket gets `support:incoming {userId,name,text}`; admin `support:reply` → user gets `support:message {sender:'admin'}`; `support:history` returns the thread; admin threads list shows unread badge |
| Announcements | ✅ Admin create → `GET /api/announcements` lists it (active, newest first); deactivate → hidden from public; delete → gone |
| Tab registry | ✅ Functional proof: appended a 7th `{id,title,render}` entry + render fn to a temp copy — admin tab bar built **7 tabs, zero other wiring** (stub-DOM test). All `/api/admin/*` routes live in `src/admin.js` (14 routes) with an "add an endpoint" guide header |
| Client | ✅ `node --check` on app.js/api.js/socket.js; served over HTTP — all 200s; `#/admin` route, support button/modal, announcement bar, admin link all present; every `$('#…')` id in app.js exists in index.html |
| Regression | ✅ Engine 15/15 + board 26/26 still pass; `grep` confirms **no** withdraw/deposit/cash-out code anywhere |

Test server stopped after verification. New files: `server/src/admin.js`, `client` admin/support/announcement UI, `DEVELOPER.md` (Bengali maintainer guide).

## 6. Config partial-update fix (2026-10-15, verified by Muse)

Found during independent verification: `PUT /api/admin/config` required the full `{rooms, economy}` body — sending only `economy` failed with "rooms is required". Fixed in `server/src/admin.js`: the handler now merges provided keys over the current config before validating, so partial updates work. Re-verified live:
- `PUT {economy:{signupBonus:100,...}}` → 200, new signup gets 100 coins
- `PUT {rooms:{twoPlayer:[...300 disabled...]}}` → 200, public `/api/rooms` hides entry 300
- `PUT {economy:{signupBonus:-5,...}}` → 400 "economy.signupBonus must be a non-negative integer"

## 7. Matchmaking wait + entry segregation (2026-10-15, verified by Muse)

User spec: 8s wait for human opponents, then vs computer; different entry fees never mix.
- New `app_config` key `matchmaking` `{twoPlayerWaitSec, fourPlayerWaitSec}` (default 8/8, Migration 4 seed); `db.getMatchmaking()` with sanitize bounds 2–300s; GameManager reads it at queue time (double-schedule race guarded via `timerPending`).
- Admin API: `GET/PUT /api/admin/config` includes `matchmaking` (partial updates merge); Rooms tab UI has wait-seconds inputs.
- Live socket.io test (2 real clients): admin set wait=3s → user A joined 2P/entry 40, user B joined 2P/entry 50 → each saw `queue:status waiting:1` (segregated, never mixed) → both got `game:start` after ~3048ms with exactly 1 bot each. ALL PASS.

## 8. Analytics dashboard + coin ledger (2026-10-15, verified by Muse)

**Ledger (Migration 5):** `coin_ledger` table + `db.recordLedger()` (PG + in-memory, never throws). Instrumented all 6 mutation sites: signup_bonus + referral_bonus (createUser), daily_bonus (claimDailyBonus), entry_fee (startRoom, ref_id=room), win (game-over payout), admin_grant (admin coins endpoint). Game/economy behavior unchanged.

**Live end-to-end test** (in-memory DB, ADMIN_EMAILS set, 2 real socket.io clients playing actively through the queue — ~140 moves to completion):
| Check | Result |
|---|---|
| Full 2P game via queue | ✅ completed, winner yellow |
| rake math | ✅ rake(16) === entryCollected(80) − winPaid(64) |
| games/newUsers/bonus | ✅ games=1, newUsers=3, bonusGranted=17230 |
| Buckets/kinds/circulation | ✅ 7 day buckets, byKind entry_fee=80/win=64, last-day circulation === coinsInCirculation |
| Auth | ✅ admin 200, non-admin 403 |
| Client | ✅ Analytics tab in ADMIN_TABS registry (proves extensibility), Chart.js 4 lazy-loaded only on tab open, 4 charts render, empty-state handled, index.html serves 200 |
| Regression | ✅ engine 15/15 pass; grep: no real-money/deposit/withdraw code (only "no cash-out" disclaimer comments) |

**Integration bugs found & fixed during this test:** (1) server emitted `game:start`/`game:state` wrapped as `{state}` but the web client expects the unwrapped public state — unwrapped both emits (publicState already includes roomId); (2) client `sendMove` sent `{tokenIndex}` while server read `p.token` — client now sends `{token}`, server also accepts legacy `tokenIndex`. Without these fixes the production web client's moves/HUD would not work.

## 9. Tournament system (2026-10-15, verified by Muse)

**Concept:** single-elimination 1v1 tournaments, fully automatic. Admin creates → users join (entry deducted at JOIN, ledger `tournament_entry`) → bracket auto-generates at `starts_at` (or admin force-start) → players play REAL 1v1 Ludo games via GameManager (no double entry, no normal payout, `coinDelta: 0`) → winners auto-advance from game results (`games.tournamentHook` → `tournaments.onMatchComplete`) → prizes auto-credited (ledger `tournament_win`). Virtual coins only.

**Schema (Migration 7):** `tournaments`, `tournament_players`, `tournament_matches` (all `IF NOT EXISTS`). New ledger kinds: `tournament_entry`, `tournament_win`, `tournament_refund` (added to `KIND_LABELS` in index.js → wallet history shows "Tournament entry fee / prize / refund").

**Live end-to-end test** (in-memory DB, ADMIN_EMAILS set, real socket.io clients, script `/tmp/tourney-test/verify.js` — **53/53 checks passed**):
| Check | Result |
|---|---|
| Admin create validation | ✅ 403 non-admin; 400 prizes>pool; 400 bad maxPlayers |
| Join (4 users, entry 40) | ✅ 5410→5370 each; double-join 400; full 400; banned 403 |
| Ledger | ✅ `tournament_entry` −40 ×4 |
| Force start | ✅ bracket = 2 semifinal matches, both `ready`, myMatch present |
| Semifinal 1 — REAL socket match | ✅ `tournament:play` → `game:start` on both clients; no double deduction; drove the real room to game-over → `game:over` coinDelta 0 both; winner advanced, final created (pending), loser eliminated pos 3 |
| Semifinal 2 via `onMatchComplete` hook | ✅ final `ready`, myMatch points at final |
| Final — REAL socket match | ✅ game:start both; game-over → T1 `completed` |
| Prizes | ✅ champion 5370+100=5470, runner-up 5370+40=5410, SF losers 5370 |
| Coin math | ✅ deducted 160, prizes 140, house rake 20 |
| Positions | ✅ 1/2/3/3 recorded; ledger `tournament_win` +100 |
| Idempotency | ✅ duplicate game-over → no double payout |
| Walkover (direct `resolveWalkover` call) | ✅ ready player advances, loser eliminated |
| Queue block | ✅ `queue:join` during active tournament match → `error 'finish your tournament match first'` |
| Cancel + refund | ✅ 1 refund, +40 back, ledger `tournament_refund`; cannot cancel completed (400) |
| Scheduler | ✅ interval armed; `checkStarts()` auto-started a due tournament (2-player field → single final match) |
| Public API | ✅ list has prizePool + playerCount; anonymous detail → myMatch null |
| Bye handling (`/tmp/tourney-test/bye.js`) | ✅ 3 players → 1 bye (walkover) + 1 real SF; bye winner into final; full completion, positions 1/2/3 |
| Client | ✅ `#/tournaments` + `#/tournament?id=` screens render (code-level), home 🏆 button bound, admin Tournaments tab in registry, `tournament:update` forwarded in socket.js, client serves 200 |
| Regression | ✅ engine 15/15, board 26/26; grep: no real-money/deposit/withdraw (only "no cash-out" disclaimer comments) |

**Design notes:** byes go to earliest joiners as round-1 walkover matches (normal advancement logic reused untouched); 3rd prize is split equally among semifinal losers; scheduler runs every 30s (starts + walkovers); walkover default 10 min (`tournaments.walkoverMs`, overridable); a player with a `ready`/`ongoing` tournament match is blocked from casual queues.

## 12. In-game quick chat (2026-10-15)

**Files:** NEW `server/src/quickchat.js` (`mountQuickChat(io, games)` — registers its own `io.on('connection')` handler, conflict-free); `client/js/app.js` (replaced `bindQuickChat()` stub only); `client/index.html` (chat button + preset popup + bubble markup appended inside `screen-game`); `client/css/style.css` (appended styles).

**Design:** server is the authority — client only sends `{roomId, msgId}`. Allowlist of 6 presets (Good luck 🍀 / Nice move 👏 / Oops 😅 / Well played 🎉 / Your turn ⏰ / Haha 😂). Handler validates msgId ∈ allowlist, enforces 1 msg / 3s per socket, resolves the room server-side via `games.roomForSocket(socket)` (client roomId never trusted for routing), and requires the socket's user to be a non-bot player in that room. Broadcasts `chat:quick {from, msgId, text}` to `io.to(room.id)`. Client: 💬 floating button on the game screen (shown only while a game is active), preset popup, incoming messages show as a top-center bubble auto-hiding after 3s. Zero new dependencies.

**Live verification (real server on :3130 + 4 real socket.io clients in a 4p game, entry 40):** 11/11 PASS —
room started; valid msgId broadcast to all 4 members; canonical allowlist text; sender name included; outsider received nothing; invalid msgId (99) ignored; client-sent `text:'HACKED'` replaced by canonical text; non-member socket ignored; rate limit (2 rapid sends → 1 broadcast); bogus roomId routed to sender's real room (proves client roomId not trusted); outsider sending the real roomId ignored (membership check server-side).

**Wire-up needed (one line in `src/index.js`, next to GameManager — not added, file boundary):**
`require('./quickchat').mountQuickChat(io, games);`

Engine tests: 15/15 still pass. `node --check` clean on all touched files.

## 11. Leaderboard + daily missions (2026-10-15, verified by Muse)
- `GET /api/leaderboard?period=weekly|alltime` (public): top 20 by wins in period, tiebreak by entry volume of won games; excludes banned users and players with 0 wins.
- `GET /api/leaderboard/me` (auth): caller's rank/wins; 404 when unranked; non-auth unaffected.
- Live test (in-memory DB, 4 users, 7 games today + 1 backdated 8 days via Date override):
  - Weekly order correct: Alpha 3W > Gamma 2W (vol 1000) > Beta 2W (vol 80) — tiebreak by volume works.
  - 8-day-old game excluded from weekly, included in alltime (Gamma 3W rank 1 alltime on volume tiebreak vs Alpha 3W).
  - `/me` rank correct (Beta weekly #3, 2 wins); zero-win user → 404.
- Missions (UTC day, live from games table): play3/win1/win3; progress correct (incl. old-game exclusion).
- Claims: play3 → +100 coins, ledger `mission_bonus` entry, wallet history label "Mission reward"; double-claim → 400; incomplete → 400; unknown key → 400; claimed flag persists.
- Client `#/leaderboard`: tabs (Leaderboard | Missions), weekly/all-time toggle, medals 🥇🥈🥉, own-row highlight, "Your rank" card, mission progress bars + claim buttons, 30s poll while open. Served over HTTP — all element IDs present.
- Engine 15/15 still pass. No real-money code (grep).

## 10. Private rooms (2026-10-15, verified by Muse)

**What:** Invite-code rooms. Creator sets entry fee (50–100000) + 2P/4P, gets a 6-char code, friend joins with the code. Entry deducted from each player at join time. When full, a real no-economy game launches via GameManager; winner gets pool minus admin-set commission % (`private_commission_pct`, default 10, admin UI via API).

**Live REST test (22/22 pass):** public config default 10; admin set 10 / reject 99 / non-admin 403; entry <50 and 3-player rejected; room created (code format `^[A-Z0-9]{6}$`); creator −100; preview; bad/malformed code 404/400; join → status `ongoing`, joiner −100; ledger `private_entry −100`; socket `queue:join` blocked with "finish your private room game first"; creator cancel → full refund + `private_refund +50`; non-creator cancel 403; banned user create 403.

**Real game-over path test (16/16 pass, in-process, real engine + real GameManager.endGame → privateHook):** 2P entry 100 → winner +180, loser −100 net, ledger `private_win +180`, house math 200 in / 180 out; double endGame no-op; no-winner (bot) → FULL refunds, house keeps 0; commission change to 25% snapshots per-room (new room winner +150, old rooms unaffected); 30-min expiry → cancel + refund; non-creator leave → refund, room stays waiting.

**Bug found & fixed:** `getPrivateCommissionPct()` returned 0 instead of 10 when unset (`Number(null) === 0`); now treats null/undefined/'' as default 10.

**Other:** engine 15/15 still pass; client serves 200 with `#/private` screen wired; grep confirms no real-money/deposit/withdraw code. New ledger kinds: `private_entry`, `private_win`, `private_refund`, `commission`.

## 13. Telegram notifications (2026-10-15, verified by Muse)

**What was built:** bot-extended push notifications — users link Telegram from the profile modal via one-time code (`/start link_<code>` deep link); server pushes alerts via Bot API `sendMessage`. Virtual coins only; no money anywhere.

**Files:** `server/src/notify.js` (new singleton: `initNotify`, `notifyUser`, `notifyMany`, hourly daily-bonus scheduler), `server/src/db.js` (+6 telegram helpers), `server/src/index.js` (wiring + 5 REST endpoints), `server/src/admin.js` (approve/reject/announcement triggers), `server/src/tournament.js` (match-ready triggers), `server/src/private.js` (game-start trigger), `telegram-bot/bot.js` (link handler), client profile modal + `api.js`.

**Live test — Phase A, no token (7/7 pass):** link-code created; internal link ok; link-status true; coin-request approve → 200, coins credited; no-op logged once (`TELEGRAM_BOT_TOKEN not set`); no crash in logs.

**Live test — Phase B, fake token + local capture server (17/17 pass):** wrong INTERNAL_SECRET → 403; link ok; double-use of code → 410; expired code (2s TTL) → 410; `POST /bot<token>/sendMessage` captured with correct `chat_id` + text (`✅ Your 5,000-coin request was approved!...`); reject notification; unlink → status false; announcement broadcast (`📢 Test event\nTournament tonight!`); daily scheduler tick at 60s delivered `🎁 Your daily bonus is ready!...`; no crash in logs.

**Bot regex check:** `/start`, `/start link_<code>`, `/start@Bot link_<code>` all parse correctly.

**Other:** engine 15/15 still pass; all touched files `node --check` clean; grep confirms no real-money code. Real delivery needs a real bot token + the user starting the bot (documented in `telegram-bot/README-TELEGRAM.md`).

## 14. Bengali (বাংলা) language support (2026-10-15, verified by Muse)

**What was built:** full EN ⇄ BN toggle for every user-facing screen. New `client/js/i18n.js` — `I18N = { en: {...}, bn: {...} }` (242 keys each), `t(key, vars)` with `{name}` interpolation + English fallback, `tHas()`, `getLang()/setLang()` (localStorage `ludo_lang`, default `en`), `applyI18n()` (rewrites `[data-i18n]` text + `[data-i18n-ph]` placeholders + `<html lang>`), and a `ludo:lang-changed` event that app.js listens to for re-rendering the current screen. Loaded before app.js; English kept as default HTML content so nothing breaks if the script fails.

**Converted:** index.html (74 `data-i18n` attrs + placeholders; `data-toast` values are now dict keys resolved in `bindGlobal`) and app.js (`t()` everywhere: auth, home, rooms, game HUD, game-over, quick-chat, wallet + history kinds via `kind.*`, coin modal, dashboard, profile, telegram linking, support, tournaments, private rooms, leaderboard/missions, install steps in install.js, api.js network/session errors). Quick chat: server still sends msgId; client renders the preset in the receiver's language. Admin panel stays English by design.

**Toggle UI:** header pill (`বাং`/`EN`) on home + EN|বাং segmented control in the profile modal; both persist in localStorage.

**Verification — 17/17 + 13/13 pass:**
- Key parity script: en/bn dicts identical key sets (242/242); every `data-i18n`/`data-i18n-ph` key (69) and every `t('…')` key (140) exists in the dict; all `data-toast` values resolve; `t()` default/interpolation/missing-key/en-fallback correct in both languages; no empty translations; no unconverted literals left in user screens; `i18n.js` loads before `app.js`.
- DOM simulation: `setLang('bn')` persists, fires the event, translates static elements + placeholders, sets `<html lang="bn">`, toggle shows `EN`; `setLang('en')` restores; spot-check confirms Bengali glyphs; no empty DOM translations.
- Bug found & fixed during testing: the i18n IIFE didn't expose its functions as globals, so `app.js` couldn't call `t()` — added explicit `window.t/tHas/getLang/setLang/applyI18n` exports.
- Live serve: client files 200, API 200. Engine 15/15 still pass. `node --check` clean on all touched files. ID cross-check: all `$('#…')` refs resolve (dynamic ones are innerHTML-created, pre-existing pattern). No behavior/layout/game-logic changes — strings only.

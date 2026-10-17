# 🛠️ DEVELOPER.md — Ludo Master 3D মেইনটেইনার গাইড

এই ফাইলটা তোমার জন্য — গেমে নিজে পরিবর্তন/ফিক্স করতে চাইলে এখান থেকে শুরু করো।
Virtual coins only — কোথাও টাকার (deposit/cash-out) ফিচার যোগ করবে না।

---

## ১. প্রজেক্ট ম্যাপ

```
~/workspace/ludo/
├── shared/
│   ├── ludo-engine.js   # গেমের নিয়ম (pure JS, কোনো dependency নেই)
│   └── test.js          # ইঞ্জিনের unit test
├── server/
│   ├── src/
│   │   ├── index.js     # Express REST API + Socket.IO বুট (এন্ট্রি পয়েন্ট)
│   │   ├── admin.js     # ★ সব /api/admin/* রুট — নতুন admin endpoint এখানেই
│   │   ├── db.js        # স্টোরেজ: PostgreSQL (DATABASE_URL থাকলে) / in-memory
│   │   ├── auth.js      # JWT sign/verify + requireAuth middleware
│   │   ├── game.js      # GameManager: matchmaking, রুম, turn loop, bot
│   │   └── bot.js       # Bot-এর নাম/ডিলে
│   ├── migrations.sql   # DB schema — শুধু APPEND করবে, পুরনো বদলাবে না
│   └── .env.example     # PORT, JWT_SECRET, DATABASE_URL, ADMIN_EMAILS
├── client/
│   ├── index.html       # সব স্ক্রিনের HTML
│   ├── css/style.css    # dark maroon + gold থিম
│   └── js/
│       ├── config.js    # API_BASE / SOCKET_URL
│       ├── api.js       # REST wrapper (Api.xxx ফাংশন)
│       ├── socket.js    # Socket.IO ক্লায়েন্ট (emit/on)
│       ├── app.js       # ★ hash router + সব স্ক্রিন লজিক + ADMIN_TABS registry
│       └── board3d.js   # Three.js 3D বোর্ড
├── deploy/
│   ├── DEPLOY.md        # সার্ভারে বসানোর বাংলা গাইড
│   └── setup-server.sh  # Ubuntu one-shot setup স্ক্রিপ্ট
└── TEST-REPORT.md       # কী কী টেস্ট করা হয়েছে
```

---

## ২. নতুন Admin Tab যোগ করা (১ মিনিট)

`client/js/app.js`-এ `ADMIN_TABS` array-টা খুঁজো:

```js
const ADMIN_TABS = [
  { id: 'overview', title: 'Overview', render: renderAdminOverview },
  // ...
];
```

নতুন অপশন যোগ = **একটা entry + একটা render ফাংশন**, আর কিছু না:

```js
// ১. registry-তে entry:
{ id: 'my-tab', title: 'My Tab', render: renderMyTab },

// ২. render ফাংশন (tab খুললেই কল হয়; paneEl-এর ভেতরে UI বানাও):
async function renderMyTab(paneEl) {
  paneEl.innerHTML = '<div class="loading">Loading…</div>';
  const data = await Api.adminMyThing();   // api.js-এ নতুন ফাংশন লাগলে যোগ করো
  paneEl.innerHTML = '<p>' + esc(data.foo) + '</p>';
}
```

Tab বাটন, pane তৈরি, switching — সব registry থেকে automatic হয়।

---

## ৩. নতুন REST Endpoint যোগ করা

**Admin endpoint** → `server/src/admin.js`-এর `mountAdmin()`-এর ভেতরে:

```js
app.get('/api/admin/my-thing', requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json(await db.myHelper());   // db.js-এ helper লাগলে আগে যোগ করো
  } catch (e) {
    res.status(500).json({ error: 'my-thing failed' });
  }
});
```

**Public endpoint** → `server/src/index.js`-এ (admin.js-এর বাইরে) যোগ করো।

> `requireAuth` → `req.userId` দেয়। `requireAdmin` → শুধু admin ঢুকতে পারে।

---

## ৪. নতুন Socket Event যোগ করা

**Server** (`server/src/index.js`, `io.on('connection', ...)` ব্লকের ভেতরে):

```js
socket.on('my:event', (p) => handleMyEvent(socket, p || {}));
// নিচে handler ফাংশন লেখো; reply পাঠাতে: socket.emit('my:reply', {...})
// সবাইকে পাঠাতে: io.emit(...); শুধু admin-দের: io.to('admins').emit(...)
```

**Client** (`client/js/socket.js`): server থেকে আসা event-এর নাম forward list-এ যোগ করো:

```js
['queue:update', /* ... */ 'my:reply'].forEach((ev) => { sio.on(ev, (d) => fire(ev, d)); });
```

তারপর `app.js`-এ: পাঠাতে `Socket.send('my:event', {...})`, শুনতে `Socket.on('my:reply', (d) => {...})`।

---

## ৫. নতুন Client Screen/Route যোগ করা

১. `index.html`-এ `<section id="screen-NAME" class="screen">…</section>` যোগ করো (`#app`-এর ভেতরে)।
২. `app.js`-এ `SCREENS` array-তে `'NAME'` যোগ করো।
৩. `ENTER.NAME = () => { … }` ফাংশন লেখো (screen খুললে চলে)।
৪. যাওয়ার জন্য: `location.hash = '#/NAME'`।

> Login ছাড়া ঢোকা যাবে না এমন screen হলে `navigate()`-এর auth-guard লিস্টে নামটা যোগ করো।

---

## ৬. Config কীভাবে কাজ করে

`app_config` টেবিলে (বা in-memory `memConfig`) দুটো key:

| key | কাজ | বদলায় |
|---|---|---|
| `rooms` | `{twoPlayer:[{entry,win,enabled}], fourPlayer:[...]}` — রুমের tier, win amount, on/off | Admin panel → Rooms tab |
| `economy` | `{signupBonus, dailyBonus, referralBonus}` — সব বোনাসের পরিমাণ (virtual coin) | Admin panel → Bonuses tab |
| `matchmaking` | `{twoPlayerWaitSec, fourPlayerWaitSec}` — human opponent-এর জন্য অপেক্ষা (সেকেন্ড); সময় শেষ হলে bot ভরে যায় | Admin panel → Rooms tab |

**Server সবসময় runtime-এ পড়ে** (`db.getRoomsConfig()` / `db.getEconomy()`) — কোথাও hardcode নেই।
তাই admin বদলালেই পরের signup/claim/matchmaking-এ সাথে সাথে কার্যকর হয়।

**Migration pattern:** `server/migrations.sql` append-only — নতুন টেবিল/কলাম লাগলে
ফাইলের শেষে `-- Migration N` ব্লক যোগ করো (`IF NOT EXISTS` ব্যবহার করো, যেন
পুরনো সার্ভারে আবার চালালেও ভাঙে না)। তারপর `db.js`-এ দুটো পথেই (PostgreSQL +
in-memory) helper লেখো।

---

## ৭. সার্ভারে আপডেট Deploy করা

**ছোট ফিক্স** (সরাসরি সার্ভারে):

```bash
ssh root@YOUR_SERVER
# ফাইল এডিট করো: /opt/ludo/server/... , /var/www/ludo/...
sudo systemctl restart ludo        # server রিস্টার্ট
sudo systemctl reload nginx        # nginx config বদলালে
sudo journalctl -u ludo -f         # লাইভ লগ দেখো
```

**বড় আপডেট** (এই VM থেকে):

```bash
cd ~/workspace
tar -czf ludo-deploy.tar.gz --exclude=node_modules --exclude=tests-board ludo/
scp ludo-deploy.tar.gz root@YOUR_SERVER:/tmp/
ssh root@YOUR_SERVER
cd /tmp && tar -xzf ludo-deploy.tar.gz
sudo cp -r ludo/server/* /opt/ludo/server/
sudo cp -r ludo/client/* /var/www/ludo/
# DB schema বদলে থাকলে: psql "$DATABASE_URL" -f ludo/server/migrations.sql
sudo systemctl restart ludo
```

> `.env` (`/opt/ludo/server/.env`) হাত দেবে না — JWT_SECRET আর DB পাসওয়ার্ড ওখানে থাকে।

---

## ৮. টেস্ট চালানো

```bash
# Rules engine (15 tests)
node ~/workspace/ludo/shared/test.js

# 3D board headless test (26 tests)
cd ~/workspace/ludo/client/tests-board && npm install --silent && node run.mjs

# Server smoke test (in-memory DB)
cd ~/workspace/ludo/server
JWT_SECRET=devsecret PORT=3131 node src/index.js &
curl -s -X POST localhost:3131/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"name":"T","email":"t@t.com","password":"secret123"}'
curl -s localhost:3131/api/rooms
kill %1

# Client syntax check
node --check ~/workspace/ludo/client/js/app.js && \
node --check ~/workspace/ludo/client/js/api.js && \
node --check ~/workspace/ludo/client/js/socket.js && echo OK
```

---

## ৯. দরকারি Admin কাজ (মনে রাখার মতো)

- **Admin বানানো:** সার্ভারের `.env`-এ `ADMIN_EMAILS=you@mail.com` দাও → রিস্টার্ট।
  ওই ইমেইলে login/signup করলেই `isAdmin: true`।
- **Ban:** Admin panel → Users → Ban। Socket সাথে সাথে কেটে যায়, REST login চালু থাকে।
- **Support chat:** Home-এর headset বাটন → user লিখলে admin-দের Support tab-এ live আসে।
- **Notice:** Admin → Support → Notices → Publish → home-এ gold banner আসে।

## ৭. Coin ledger + Analytics (virtual-coin income)

**Ledger:** `coin_ledger` টেবিলে (Migration 5) প্রতিটা coin movement রেকর্ড হয় —
`{user_id, amount (+credit / -debit), kind, ref_id, created_at}`। Kind গুলো:

| kind | কখন লেখা হয় |
|---|---|
| `signup_bonus` | নতুন signup-এ (`db.createUser`) |
| `daily_bonus` | daily claim-এ (`db.claimDailyBonus`) |
| `referral_bonus` | referral-এ referrer-কে (`db.createUser`) |
| `entry_fee` | room start-এ entry কাটা (`game.startRoom`, ref_id = room id) |
| `win` | জয়ীকে payout (`game` game-over, ref_id = room id) |
| `admin_grant` | admin coin adjust (`POST /api/admin/users/:id/coins`) |

লেখা হয় `db.recordLedger()` দিয়ে — এটা **কখনো throw করে না** (ভেতরে try/catch);
ledger fail করলেও আসল coin operation-এ কোনো প্রভাব পড়ে না। নতুন coin
mutation যোগ করলে সেখানেও `recordLedger` ডাকতে ভুলো না।

**Analytics endpoint:** `GET /api/admin/analytics?days=7|30` (default 30, 1–90) →
`{days: [{date, games, newUsers, entryCollected, winPaid, rake, bonusGranted, circulation}], totals: {...}, byKind: {...}}`।
"Income" = house rake = entryCollected − winPaid (সব virtual coin)। খালি দিন
শূন্য দিয়ে আসে; data না থাকলেও 200 + zero-filled, কখনো 500 না।

**নতুন chart যোগ করা:** Admin panel-এর Analytics tab-ই extensibility-র প্রমাণ —
`ADMIN_TABS`-এ একটা entry + একটা render function। Chart যোগ করতে:
1. `Api`-তে নতুন `admin*` helper (প্রয়োজনে),
2. `paintAnalytics`-এ নতুন `<canvas>` + `new Chart(...)` push করো `adminCharts`-এ
   (range বদলালে `destroyAdminCharts()` পুরনোগুলো মুছে দেয়),
3. Chart.js lazy-load হয় শুধু এই tab খুললে (`ensureChartJs()`) — game page-এ
   কোনো খরচ নেই।

## ১০. Tournament System (single-elimination 1v1)

**ধারণা:** Admin তৈরি করে → user join করে (entry fee JOIN-এর সময়ই কাটা হয়) →
`starts_at` এলে বা admin "Start now" চাপলে bracket auto-generate হয় → খেলোয়াড়রা
আসল 1v1 Ludo game খেলে (`tournament:play` socket event) → game-এর result থেকে
winner auto-advance করে → prize auto-credit হয়। কোনো manual result upload নেই।
সব virtual coin।

**ফাইল:**
- `server/src/tournament.js` — `TournamentManager` (bracket, scheduler, walkover, payout)।
  `index.js`-এ wire করা: `games.tournamentHook` (game-over → `onMatchComplete`),
  `games.tournamentManager` (queue double-play block), `tournaments.startScheduler()`।
- `server/src/game.js` — `startRoom(humans, mode, entry, {tournamentMatchId})` দিলে
  room economy পুরো skip হয় (balance check, deduction, entry ledger নেই) এবং
  `endGame`-এ normal payout নেই (`coinDelta: 0`); বদলে tournament hook চলে।
- DB helper-রা `server/src/db.js`-এ (PG + in-memory দুটোতেই)।
- Admin route-গুলো `server/src/admin.js`-এ (নিয়ম অনুযায়ী সব `/api/admin/*` এক ফাইলে)।

**টেবিল (Migration 7):** `tournaments` (name, entry_fee, max_players ∈ {4,8,16,32},
prize_1st/2nd/3rd, status ∈ upcoming/filling/ongoing/completed/cancelled, starts_at),
`tournament_players` (joined_at order = seeding, eliminated, final_position),
`tournament_matches` (round, match_no, player1/2_id, winner_id,
status ∈ pending/ready/ongoing/completed/walkover, ready_at, p1/p2_ready_at)।

**Endpoint:**
- `GET /api/tournaments` (public) — list + playerCount + prizePool।
- `GET /api/tournaments/:id` — detail: bracket (round অনুযায়ী), players, `myMatch`
  (login থাকলে আমার পরের খেলার match)।
- `POST /api/tournaments/:id/join` (auth) — entry deduct + ledger `tournament_entry`।
- `POST /api/tournaments/:id/ready` (auth) — walkover logic-এর জন্য "আমি ready" mark।
- Socket: client `tournament:play {matchId}` emit করে → server 1v1 room বানায়;
  server `tournament:update` emit করে (bracket বদলালে client auto-refresh করে)।
- Admin: `POST /api/admin/tournaments` (prize sum ≤ maxPlayers×entryFee না হলে 400),
  `POST /api/admin/tournaments/:id/start`, `/cancel` (refund + ledger `tournament_refund`),
  `GET /api/admin/tournaments`।

**নিয়ম (মনে রাখার মতো):**
- Bye: player সংখ্যা power-of-2 না হলে (যেমন 3 জন) সবচেয়ে আগে join করা
  খেলোয়াড়রা round-1 walkover (bye) পেয়ে round 2-এ যায়।
- Walkover: `ready` match-এ 10 মিনিট (`tournaments.walkoverMs`) কেউ খেলা শুরু না
  করলে — যে "ready" চাপে সে এগোয়, কেউ না চাপলে আগে join করা জন এগোয়।
- Scheduler প্রতি 30s-এ চলে: `starts_at` পার হওয়া tournament শুরু করে (2 জনের কম
  হলে cancel + refund), পুরনো `ready` match-এ walkover দেয়।
- 3rd prize semifinal-এ হারা দুজনের মধ্যে সমান ভাগ হয়।
- `ready`/`ongoing` tournament match থাকা অবস্থায় casual `queue:join` block হয়
  (`finish your tournament match first`)।
- Position: champion 1, runner-up 2, semifinal loser 3।

**Client:** Home-এ 🏆 Tournaments বাটন → `#/tournaments` (card list, 15s poll) →
`#/tournament?id=` (bracket, players, Join / ▶ Play My Match)। Admin panel-এ
Tournaments tab (`ADMIN_TABS` registry) — create form + Start now / Cancel।

## ১২. Leaderboard + Daily Missions

**Leaderboard (`#/leaderboard`):**
- Public endpoint `GET /api/leaderboard?period=weekly|alltime` — top 20, win সংখ্যা
  দিয়ে rank, tie হলে জেতা game-এর মোট entry volume দিয়ে tiebreak। `games` টেবিল
  থেকেই হিসাব (winner_id, player_ids, played_at) — নতুন migration লাগেনি।
  Weekly = শেষ ৭ দিন (rolling), ban হওয়া user বাদ।
- `GET /api/leaderboard/me` (auth) — নিজের rank/wins; rank না থাকলে 404।
- Client-এ tab আছে: 🏅 Leaderboard | 🎯 Missions; Weekly/All Time toggle।

**Daily Missions (প্রতিদিন UTC রাতে reset):**
- ৩টা mission: `play3` (৩টা game খেলো → +100), `win1` (১টা জেতো → +150),
  `win3` (৩টা জেতো → +500)। Progress `games` টেবিল থেকে live হিসাব হয়।
- `GET /api/missions` (auth) → `{key, title, target, progress, reward, claimed}`।
- `POST /api/missions/claim` `{key}` → target পূর্ণ ও আগে claim না হলে coin credit
  + ledger-এ `mission_bonus` entry (wallet history-তে "Mission reward")।
  Double-claim / অসম্পূর্ণ claim → 400।
- Claim record `mission_claims` টেবিলে (Migration 8b): `(user_id, day, mission_key)` PK —
  এক user একদিনে এক mission একবারই claim করতে পারে (race-safe)।
- **নতুন mission যোগ করা:** `server/src/db.js`-এর `MISSION_DEFS` array-তে একটা
  entry যোগ করলেই হয় — `{key, title, target, reward}`; progress `play3` হলে
  "played", বাকিগুলো "won" দিয়ে মাপা হয়। Client/endpoint বদলাতে হয় না।

**ফাইল:** DB helper-রা `server/src/db.js`-এর শেষে append করা
(`Object.assign(module.exports, …)` দিয়ে export); REST endpoint-গুলো
`server/src/index.js`-এ Socket.IO সেকশনের ঠিক আগে; client screen
`client/index.html`-এর `#screen-leaderboard` সেকশন + `app.js`-এর
`ENTER.leaderboard`/`bindLeaderboard` (stub replace করা)।

## ১১. Private Rooms (ইনভাইট কোড রুম)

**ধারণা:** Creator নিজে entry fee (৫০–১০০০০০) আর ২/৪ প্লেয়ার সেট করে → ৬ অক্ষরের invite code পায় → বন্ধু code দিয়ে join করে। Join-এর সময়ই সবার entry কেটে নেওয়া হয়। রুম full হলেই আসল game শুরু (GameManager, no-economy room — tournament-এর মতো)। Winner পায় **pool − commission%**, commission যায় house-এর কাছে।

**ফাইল:**
- `server/src/private.js` — পুরো logic (class `PrivateRooms`): `createRoom`, `joinRoom`, `leaveRoom`, `cancelRoom`, `startRoomGame`, `onGameOver`, ৩০ সেকেন্ডের expiry scheduler, REST + admin routes।
- `server/src/game.js` — tournament-এর মতোই hook: `opts.privateRoomId` → no-economy room; `endGame`-এ `privateHook` → winner-কে prize।
- `server/src/index.js` — wiring (tournament wiring-এর ঠিক পরে)।

**ডাটাবেজ (Migration 8):** `private_rooms` (code unique, entry_fee, max_players 2/4, status waiting/ongoing/completed/cancelled, commission_pct, expires_at), `private_room_players`। `db.js`-এর শেষে function-গুলো append করা।

**Commission:** `app_config` key `private_commission_pct` (default ১০)। Admin API: `GET/PUT /api/admin/private-config` (০–৫০)। প্রতিটা রুম তৈরির সময় তখনকার % snapshot নেয় — পরে % বদলালে পুরনো রুমে প্রভাব পড়ে না।

**নিরাপত্তা নিয়ম:**
- Bot জিতলে বা game ভেঙে গেলে (কোনো human winner নেই) → সবাইকে **full refund**, house কিছু রাখে না।
- Waiting রুম ৩০ মিনিটে expire → auto refund।
- Private রুম চলাকালীন casual queue-তে ঢোকা যায় না (game.js-এ block); tournament match চললে private রুম খোলা/যোগ দেওয়া যায় না।
- Ban হওয়া user রুম খুলতে/যোগ দিতে পারে না।

**Client:** `#/private` screen — Create card (entry input + chip 100/500/1000/5000, 2P/4P toggle), Join card (code input, `#/private?code=ABC123` deep link সাপোর্ট), waiting view (বড় code + Copy + Telegram Share, player list, creator Cancel)। Game শুরু হলে স্বয়ংক্রিয়ভাবে `#/game`-এ যায়।

**Ledger kind:** `private_entry` (−join), `private_win` (+winner), `private_refund` (+refund), `commission` (house cut, user_id null)। Wallet history-তে বাংলা/English label দেখায়।

## ১৪. Telegram Notifications (push alerts)

**ধারণা:** User app-এর Profile → **🔗 Link Telegram** চাপে → সার্ভার one-time code বানায় (১০ মিনিট মেয়াদ, single-use) → `https://t.me/<bot>?start=link_<code>` খোলে → বট code-টা সার্ভারের internal endpoint-এ forward করে → সার্ভার validate করে `telegram_links`-এ telegram_id ↔ user_id ম্যাপ সেভ করে। এরপর গেমের গুরুত্বপূর্ণ ঘটনায় বট API দিয়ে push notification যায়।

**ফাইল:**
- `server/src/notify.js` — singleton: `initNotify({db})`, `notifyUser(userId, text)`, `notifyMany(userIds, text)` (৫০ms gap), `startDailyScheduler()` (প্রতি ঘণ্টায় tick; claimable daily bonus আছে এমন linked user-দের দিনে ১ বার "🎁 Your daily bonus is ready!" পাঠায়)। সব method **never throws** — notification fail হলেও গেম চলতে থাকে। Token না থাকলে silent no-op (একবার log)।
- `server/src/db.js` (শেষে append): `createTelegramLinkCode`, `consumeTelegramLinkCode` (expiry + single-use চেক), `getTelegramLink`, `unlinkTelegram`, `listTelegramLinkedUserIds`, `listLinkedUsersWithClaimableDaily` — PG + in-memory দুটোতেই।
- `server/src/index.js` — wiring + REST: `POST /api/telegram/link-code` → `{code, url}`, `GET /api/telegram/link-status`, `POST /api/telegram/unlink`, `GET /api/telegram/bot-info` → `{username}`, `POST /api/internal/telegram-link` (INTERNAL_SECRET guarded — বট এটা call করে)।
- `server/src/admin.js` — coin request approve/reject-এ user-কে notify; announcement publish-এ সব linked user-কে broadcast।
- `server/src/tournament.js` — match `ready` হলেই দুই player-কে "⚔️ Your tournament match is ready"।
- `server/src/private.js` — private room-এর game শুরু হলে সবাইকে "🎮 Your private room game started!"।
- `telegram-bot/bot.js` — `/start link_<code>` handler; `SERVER_URL` + `INTERNAL_SECRET` env লাগে।
- Client: Profile modal-এ Telegram row (`refreshTelegramRow()`), `api.js`-এ ৪টা helper।

**ডাটাবেজ (Migration 9):** `telegram_links` (user_id PK, telegram_id unique), `telegram_link_codes` (code PK, used flag)।

**Env (সার্ভার):** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (@ ছাড়া), `INTERNAL_SECRET`। **বট host:** `BOT_TOKEN`, `GAME_URL`, `SERVER_URL`, `INTERNAL_SECRET` (সার্ভারেরটার সাথে একই)। বিস্তারিত: `telegram-bot/README-TELEGRAM.md`।

**কেন বট সরাসরি DB-তে ঢোকে না:** (১) সার্ভার in-memory fallback-এ চললে বটের আলাদা DB connection কাজ করতো না; (২) code validation এক জায়গায় (সার্ভারে) থাকে।

**টেস্ট:** `TELEGRAM_API_BASE` env দিয়ে sendMessage কল local capture server-এর দিকে ঘুরিয়ে shape যাচাই করা যায়; `TELEGRAM_LINK_TTL_MS` দিয়ে expiry টেস্ট করা যায়। দেখো TEST-REPORT.md §13।

## ১৫. বাংলা ভাষা সাপোর্ট (i18n)

**ধারণা:** পুরো user app-এ English ⇄ বাংলা টগল। `client/js/i18n.js`-এ দুটো dictionary (`en`, `bn`), flat key (যেমন `home.buyCoin`, `wallet.history`)। Static HTML-এ `data-i18n="key"` attribute (ভেতরে English text-ই থাকে — JS fail করলেও পেজ পড়া যায়); placeholder-এর জন্য `data-i18n-ph="key"`। JS-এ `t('key')` বা `t('key', { n: 5 })` (interpolation)। `data-toast`-এর value এখন key (যেমন `toast.whatsappSoon`) — `bindGlobal()` নিজে resolve করে।

**নতুন string যোগ করার নিয়ম:**
1. `i18n.js`-এর `en` **ও** `bn` দুটোতেই একই key যোগ করো (parity ভাঙলে verify script ধরবে)।
2. Static HTML হলে `data-i18n="key"` দাও; JS-rendered হলে `t('key')` ব্যবহার করো।
3. Verify: `/tmp/i18n-verify.cjs` চালাও (key parity + সব ব্যবহৃত key dict-এ আছে কিনা + engine test)।

**টগল:** Home header-এ `বাং`/`EN` pill + Profile modal-এ EN|বাং segmented control। `localStorage 'ludo_lang'`-এ save থাকে। `setLang()` → `applyI18n()` → `ludo:lang-changed` event → app.js বর্তমান screen re-render করে (dynamic string refresh হয়)।

**ইচ্ছাকৃত সিদ্ধান্ত:**
- **Admin panel English-ই থাকবে** — admin (তুমি) technical, আর admin string-গুলো user কখনো দেখে না।
- Quick chat: সার্ভার শুধু `msgId` পাঠায়; client receiver-এর ভাষায় preset render করে (`qc.m1`…`qc.m6`)।
- Announcement/custom-option-এর text admin যা লেখে তাই দেখায় (translate হয় না)।
- সংখ্যা Western digit-এই থাকে (গেমে বাংলা user-রা এটাই পড়ে)।
- `shared/ludo-engine.js`-এ হাত দেওয়া হয়নি (logic, UI নয়)।

**টেস্ট:** TEST-REPORT.md §14 দেখো।

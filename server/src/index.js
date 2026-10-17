'use strict';

/**
 * Ludo game server — Express REST API + Socket.IO real-time play.
 *
 * VIRTUAL COINS ONLY. Coins are an in-game score with no cash value:
 * no add-money, no cash-out, no withdraw-to-money, no payment features.
 */

const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { signToken, verifyToken, requireAuth } = require('./auth');
const GameManager = require('./game'); // fails fast if the shared engine is missing
const TournamentManager = require('./tournament');

const PORT = Number(process.env.PORT || 3000);

// Admin emails (comma-separated). Any user with one of these emails is
// granted is_admin=true on boot and on every login.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const isAdminEmail = (email) => ADMIN_EMAILS.includes(String(email || '').toLowerCase());

/** Grant admin to every ADMIN_EMAILS user that already exists. Runs at boot. */
async function syncAdmins() {
  if (ADMIN_EMAILS.length === 0) return;
  for (const email of ADMIN_EMAILS) {
    try {
      const u = await db.findUserByEmail(email);
      if (u && !u.is_admin) {
        await db.setAdmin(u.id, true);
        console.log(`[admin] granted admin to ${email}`);
      }
    } catch (e) {
      console.error(`[admin] sync failed for ${email}:`, e.message);
    }
  }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve the web client from the same process (used on Render / single-service
// deploys). Skipped when the client directory isn't packaged alongside.
const CLIENT_DIR = path.join(__dirname, '..', '..', 'client');
if (fs.existsSync(path.join(CLIENT_DIR, 'index.html'))) {
  app.use(express.static(CLIENT_DIR));
  console.log('[server] serving client from', CLIENT_DIR);
}

// Never expose password hashes: pick only the public fields.
const publicUser = (u) => (u ? {
  id: u.id, name: u.name, email: u.email, coins: u.coins,
  isAdmin: !!u.is_admin,
} : null);

// Full profile for /api/me: public fields + referral info.
const fullUser = (u) => (u ? {
  ...publicUser(u),
  referralCode: u.referral_code || null,
  referralEarnings: Number(u.referral_earnings || 0),
} : null);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, phone, password, referralCode } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const cleanEmail = email ? String(email).trim() : null;
  const cleanPhone = phone ? String(phone).replace(/[^0-9+]/g, '') : null;
  if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }
  if (cleanPhone && cleanPhone.replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'a valid phone number is required' });
  }
  if (!cleanEmail && !cleanPhone) {
    return res.status(400).json({ error: 'email or phone is required' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  try {
    // Bonus amounts come from the admin-controlled economy config at runtime.
    const economy = await db.getEconomy();
    const passwordHash = await bcrypt.hash(String(password), 10);
    let user = await db.createUser({
      name: name.trim(),
      email: cleanEmail,
      phone: cleanPhone,
      passwordHash,
      startingCoins: economy.signupBonus,
      referralCode: referralCode || null,
      referralBonus: economy.referralBonus,
    });
    if (user.email && isAdminEmail(user.email)) {
      await db.setAdmin(user.id, true);
      user = await db.getUserById(user.id);
    }
    res.status(201).json({ token: signToken(user.id), user: publicUser(user) });
  } catch (e) {
    if (e.code === 'DUPLICATE_EMAIL') return res.status(409).json({ error: 'email already registered' });
    if (e.code === 'DUPLICATE_PHONE') return res.status(409).json({ error: 'phone already registered' });
    console.error('[api] signup failed:', e);
    res.status(500).json({ error: 'signup failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, phone, login, password } = req.body || {};
  const loginId = login || email || phone;
  if (!loginId || !password) return res.status(400).json({ error: 'email/phone and password are required' });
  try {
    let user = await db.findUserByLogin(String(loginId));
    if (!user) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    // ADMIN_EMAILS members are (re)granted admin on every login.
    if (user.email && isAdminEmail(user.email) && !user.is_admin) {
      await db.setAdmin(user.id, true);
      user = await db.getUserById(user.id);
    }
    res.json({ token: signToken(user.id), user: publicUser(user) });
  } catch (e) {
    console.error('[api] login failed:', e);
    res.status(500).json({ error: 'login failed' });
  }
});

/* Forgot password: 6-digit code (10 min). Demo returns the code in the
 * response; production should send it via SMS/email instead. */
app.post('/api/auth/forgot', async (req, res) => {
  const { email, phone, login } = req.body || {};
  const loginId = login || email || phone;
  if (!loginId) return res.status(400).json({ error: 'email or phone is required' });
  try {
    const user = await db.findUserByLogin(String(loginId));
    // Always return success to avoid leaking which accounts exist.
    if (!user) return res.json({ ok: true });
    const code = await db.createPasswordReset(user.id);
    res.json({ ok: true, code, hint: 'demo: code returned in response; send via SMS/email in production' });
  } catch (e) {
    console.error('[api] forgot failed:', e);
    res.status(500).json({ error: 'request failed' });
  }
});

app.post('/api/auth/reset', async (req, res) => {
  const { email, phone, login, code, newPassword } = req.body || {};
  const loginId = login || email || phone;
  if (!loginId || !code) return res.status(400).json({ error: 'email/phone and code are required' });
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  try {
    const user = await db.findUserByLogin(String(loginId));
    if (!user) return res.status(400).json({ error: 'invalid code' });
    const reset = await db.verifyPasswordReset(user.id, code);
    if (!reset) return res.status(400).json({ error: 'invalid or expired code' });
    const passwordHash = await bcrypt.hash(String(newPassword), 10);
    await db.consumePasswordReset(reset.id, user.id, passwordHash);
    res.json({ ok: true });
  } catch (e) {
    console.error('[api] reset failed:', e);
    res.status(500).json({ error: 'reset failed' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json(fullUser(user));
  } catch (e) {
    res.status(500).json({ error: 'failed to load profile' });
  }
});

app.put('/api/me', requireAuth, async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const user = await db.updateUserName(req.userId, name.trim());
    res.json(publicUser(user));
  } catch (e) {
    if (e.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'user not found' });
    res.status(500).json({ error: 'update failed' });
  }
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const stats = await db.getStats(req.userId);
    const user = await db.getUserById(req.userId);
    res.json({
      ...stats,
      coins: user ? user.coins : 0,
      referralEarnings: user ? Number(user.referral_earnings || 0) : 0,
      referralCode: user ? user.referral_code || null : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'stats failed' });
  }
});

/** Room tiers come from the admin-controlled config; only enabled entries are listed. */
app.get('/api/rooms', async (req, res) => {
  try {
    const cfg = await db.getRoomsConfig();
    const pick = (arr) => arr.filter((r) => r.enabled).map((r) => ({ entry: r.entry, win: r.win }));
    res.json({ twoPlayer: pick(cfg.twoPlayer), fourPlayer: pick(cfg.fourPlayer) });
  } catch (e) {
    console.error('[api] /api/rooms failed:', e);
    res.status(500).json({ error: 'rooms failed' });
  }
});

app.post('/api/wallet/daily', requireAuth, async (req, res) => {
  try {
    res.json(await db.claimDailyBonus(req.userId));
  } catch (e) {
    res.status(500).json({ error: 'daily bonus failed' });
  }
});

/* ---------------- coin store: FREE daily packs (no payment anywhere) ---------------- */

app.get('/api/coin-store/status', requireAuth, async (req, res) => {
  try {
    res.json({ amounts: db.COIN_STORE_AMOUNTS, claimed: await db.coinStoreStatus(req.userId) });
  } catch (e) {
    res.status(500).json({ error: 'coin store status failed' });
  }
});

app.post('/api/coin-store/claim', requireAuth, async (req, res) => {
  try {
    res.json(await db.claimCoinStore(req.userId, req.body && req.body.amount));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'claim failed' });
  }
});

/* ---------------- redeem rewards: admin promo codes ---------------- */

app.post('/api/redeem', requireAuth, async (req, res) => {
  try {
    res.json(await db.redeemCode(req.userId, req.body && req.body.code));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'redeem failed' });
  }
});

/* ---------------- wallet: history + coin requests ---------------- */

const KIND_LABELS = {
  signup_bonus: 'Signup bonus', daily_bonus: 'Daily bonus', referral_bonus: 'Referral bonus',
  entry_fee: 'Game entry fee', win: 'Game winnings', admin_grant: 'Admin credit',
  tournament_entry: 'Tournament entry fee', tournament_win: 'Tournament prize',
  tournament_refund: 'Tournament refund', mission_bonus: 'Mission reward',
  private_entry: 'Private room entry', private_win: 'Private room winnings',
  private_refund: 'Private room refund', commission: 'House commission',
  coin_store: 'Free coin pack', redeem_code: 'Reward code',
};

app.get('/api/wallet/history', requireAuth, async (req, res) => {
  try {
    const rows = await db.getLedger(req.userId, req.query.limit, req.query.offset);
    res.json({
      history: rows.map((r) => ({
        id: r.id, amount: r.amount, kind: r.kind,
        label: KIND_LABELS[r.kind] || r.kind,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'history failed' });
  }
});

app.post('/api/wallet/request', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const row = await db.createCoinRequest(req.userId, b.packCoins, b.paymentMethod, b.transactionId);
    res.json({ request: row });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'request failed' });
  }
});

app.get('/api/wallet/requests', requireAuth, async (req, res) => {
  try {
    res.json({ requests: await db.listUserCoinRequests(req.userId) });
  } catch (e) {
    res.status(500).json({ error: 'requests failed' });
  }
});

/* ---------------- custom options (public, enabled only) ---------------- */

app.get('/api/custom-options', async (req, res) => {
  try {
    res.json({ options: (await db.getCustomOptions()).filter((o) => o.enabled) });
  } catch (e) {
    res.json({ options: [] });
  }
});

/* ---------------- telegram linking + bot info ----------------
 * Users link Telegram via a one-time code: app -> POST /api/telegram/link-code
 * -> opens https://t.me/<bot_username>?start=link_<code> -> the bot calls
 * POST /api/internal/telegram-link (shared-secret guarded) to complete linking.
 */

const notify = require('./notify');
notify.initNotify({ db });

const botUsername = () => (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim() || null;

app.get('/api/telegram/bot-info', async (req, res) => {
  res.json({ username: botUsername() });
});

app.post('/api/telegram/link-code', requireAuth, async (req, res) => {
  try {
    const { code, expiresInSec } = await db.createTelegramLinkCode(req.userId);
    const u = botUsername();
    res.json({ code, expiresInSec, url: u ? `https://t.me/${u}?start=link_${code}` : null });
  } catch (e) {
    res.status(500).json({ error: 'could not create link code' });
  }
});

app.get('/api/telegram/link-status', requireAuth, async (req, res) => {
  try {
    res.json({ linked: !!(await db.getTelegramLink(req.userId)) });
  } catch (e) {
    res.json({ linked: false });
  }
});

app.post('/api/telegram/unlink', requireAuth, async (req, res) => {
  try {
    res.json(await db.unlinkTelegram(req.userId));
  } catch (e) {
    res.status(500).json({ error: 'unlink failed' });
  }
});

/* Internal endpoint for the telegram bot (NOT part of the public API).
 * Guarded by INTERNAL_SECRET shared with the bot host. Lets the bot complete
 * a link without direct DB access (works with the in-memory DB fallback too). */
app.post('/api/internal/telegram-link', async (req, res) => {
  try {
    const secret = process.env.INTERNAL_SECRET || '';
    if (!secret || req.body.secret !== secret) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const { code, telegram_id, first_name } = req.body || {};
    res.json(await db.consumeTelegramLinkCode(code, telegram_id, first_name));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'link failed' });
  }
});

/* ---------------- tournaments (public) ---------------- */

/** Optional auth: attaches req.userId when a valid Bearer <redacted> present, else null. */
function optionalAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    if (m) {
      const { sub } = verifyToken(m[1]);
      req.userId = sub;
    }
  } catch (e) { /* anonymous */ }
  next();
}

app.get('/api/tournaments', async (req, res) => {
  try {
    const rows = await db.listTournamentRows();
    res.json({
      tournaments: rows.map((t) => ({
        id: t.id, name: t.name, entryFee: t.entry_fee, maxPlayers: t.max_players,
        prize1st: t.prize_1st, prize2nd: t.prize_2nd, prize3rd: t.prize_3rd,
        status: t.status, startsAt: t.starts_at,
        playerCount: t.player_count,
        prizePool: t.prize_1st + t.prize_2nd + t.prize_3rd,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'tournaments failed' });
  }
});

app.get('/api/tournaments/:id', optionalAuth, async (req, res) => {
  try {
    res.json(await tournaments.getDetail(req.params.id, req.userId || null));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'tournament failed' });
  }
});

app.post('/api/tournaments/:id/join', requireAuth, async (req, res) => {
  try {
    res.json(await tournaments.joinTournament(req.params.id, req.userId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'join failed' });
  }
});

app.post('/api/tournaments/:id/ready', requireAuth, async (req, res) => {
  try {
    res.json(await tournaments.markReady(req.params.id, req.userId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'ready failed' });
  }
});

/* ---------------- leaderboard + daily missions ---------------- */

app.get('/api/leaderboard', async (req, res) => {
  try {
    const period = req.query.period === 'alltime' ? 'alltime' : 'weekly';
    res.json({ period, board: await db.getLeaderboard(period) });
  } catch (e) {
    console.error('[api] leaderboard failed:', e);
    res.status(500).json({ error: 'leaderboard failed' });
  }
});

app.get('/api/leaderboard/me', requireAuth, async (req, res) => {
  try {
    const period = req.query.period === 'alltime' ? 'alltime' : 'weekly';
    const r = await db.getUserLeaderboardRank(req.userId, period);
    if (!r) return res.status(404).json({ error: 'unranked' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'rank failed' });
  }
});

app.get('/api/missions', requireAuth, async (req, res) => {
  try {
    res.json({ day: db.todayUtc(), missions: await db.getMissions(req.userId) });
  } catch (e) {
    console.error('[api] missions failed:', e);
    res.status(500).json({ error: 'missions failed' });
  }
});

app.post('/api/missions/claim', requireAuth, async (req, res) => {
  try {
    res.json(await db.claimMission(req.userId, req.body && req.body.key));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'claim failed' });
  }
});

/* ---------------- Socket.IO ---------------- */

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const games = new GameManager(io, db);

// Tournaments: single-elimination 1v1, fully automatic (virtual coins only).
const tournaments = new TournamentManager(io, db, games);
games.tournamentHook = (matchId, winnerId) => tournaments.onMatchComplete(matchId, winnerId);
games.tournamentManager = tournaments; // lets joinQueue block double-play
tournaments.startScheduler();

// In-game quick chat (preset messages, server-authoritative).
require('./quickchat').mountQuickChat(io, games);

// Private rooms: invite-code rooms, creator-set entry, admin commission (virtual coins only).
const PrivateRooms = require('./private');
const privateRooms = new PrivateRooms(io, db, games);
games.privateHook = (roomId, winnerId) => privateRooms.onGameOver(roomId, winnerId);
games.privateRooms = privateRooms; // lets joinQueue block double-play
privateRooms.mountRoutes(app, { requireAuth });
privateRooms.mountPrivateAdmin(app, { requireAuth, isAdminEmail });
privateRooms.startScheduler();

// Telegram push notifications (no-op unless TELEGRAM_BOT_TOKEN is set).
notify.startDailyScheduler();

// All /api/admin/* routes (see src/admin.js for the "how to add an endpoint" guide).
const { mountAdmin } = require('./admin');
mountAdmin(app, { db, io, requireAuth, isAdminEmail, tournaments });

/* ---------------- public announcements ---------------- */

// Active announcements, newest first — shown as a banner on the home screen.
app.get('/api/announcements', async (req, res) => {
  try {
    res.json(await db.listAnnouncements(true));
  } catch (e) {
    res.status(500).json({ error: 'announcements failed' });
  }
});

app.get('/api/coin-packs', async (req, res) => {
  try {
    res.json({ packs: await db.getCoinPacks() });
  } catch (e) {
    res.status(500).json({ error: 'coin packs failed' });
  }
});

// Authenticate every socket via handshake.auth.token; drop unauthenticated ones.
// Banned users are told exactly why: they get `error {message:'Account banned'}`
// and are disconnected immediately, so they can never join queues.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('unauthorized: missing token'));
    const { sub } = verifyToken(token);
    const user = await db.getUserById(sub);
    if (!user) return next(new Error('unauthorized: unknown user'));
    socket.user = { id: user.id, name: user.name, email: user.email };
    socket.banned = !!user.banned;
    socket.isAdmin = !!user.is_admin;
    return next();
  } catch (e) {
    return next(new Error('unauthorized: invalid token'));
  }
});

io.on('connection', (socket) => {
  if (socket.banned) {
    socket.emit('error', { message: 'Account banned' });
    socket.disconnect(true);
    return;
  }
  // Per-user room (for support replies) + admins room (for incoming chats).
  socket.join('user:' + socket.user.id);
  if (socket.isAdmin) socket.join('admins');

  socket.on('queue:join', (p) => {
    games.joinQueue(socket, p || {}).catch((e) => {
      console.error('[socket] joinQueue failed:', e.message);
      socket.emit('error', { message: 'could not join queue' });
    });
  });
  socket.on('queue:leave', () => games.leaveQueue(socket));
  socket.on('tournament:play', (p) => {
    tournaments.playMatch(socket, p && p.matchId).catch((e) => {
      socket.emit('error', { message: (e && e.message) || 'could not start tournament match' });
    });
  });
  socket.on('game:roll', () => games.handleRoll(socket));
  socket.on('game:move', (p) => games.handleMove(socket, p && (p.token !== undefined ? p.token : p.tokenIndex)));
  socket.on('support:send', (p) => handleSupportSend(socket, p));
  socket.on('support:reply', (p) => handleSupportReply(socket, p));
  socket.on('support:history', () => handleSupportHistory(socket));
  socket.on('disconnect', () => games.handleDisconnect(socket));
});

/* ---------------- live support chat ---------------- */

async function handleSupportSend(socket, p) {
  try {
    if (socket.banned) {
      socket.emit('error', { message: 'Account banned' });
      return;
    }
    const text = String((p || {}).text || '').trim().slice(0, 1000);
    if (!text) return;
    const msg = await db.saveSupportMessage({ userId: socket.user.id, sender: 'user', text });
    // Echo back to the sender so their chat updates instantly.
    socket.emit('support:message', { sender: 'user', text: msg.text, createdAt: msg.created_at, mine: true });
    // Notify every connected admin.
    io.to('admins').emit('support:incoming', {
      userId: socket.user.id,
      name: socket.user.name,
      email: socket.user.email,
      sender: 'user',
      text: msg.text,
      createdAt: msg.created_at,
    });
  } catch (e) {
    console.error('[socket] support:send failed:', e.message);
  }
}

async function handleSupportReply(socket, p) {
  try {
    if (!socket.isAdmin) {
      socket.emit('error', { message: 'admin only' });
      return;
    }
    const userId = (p || {}).userId;
    const text = String((p || {}).text || '').trim().slice(0, 1000);
    if (!userId || !text) return;
    const msg = await db.saveSupportMessage({ userId, sender: 'admin', text });
    // Deliver to the user (all their open sockets).
    io.to('user:' + userId).emit('support:message', {
      sender: 'admin', text: msg.text, createdAt: msg.created_at,
    });
    // Keep every admin's conversation list in sync.
    const u = await db.getUserById(userId);
    io.to('admins').emit('support:incoming', {
      userId,
      name: u ? u.name : 'Unknown',
      email: u ? u.email : '',
      sender: 'admin',
      text: msg.text,
      createdAt: msg.created_at,
    });
  } catch (e) {
    console.error('[socket] support:reply failed:', e.message);
  }
}

async function handleSupportHistory(socket) {
  try {
    const messages = await db.getSupportThread(socket.user.id, 100);
    socket.emit('support:history', {
      messages: messages.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })),
    });
  } catch (e) {
    console.error('[socket] support:history failed:', e.message);
  }
}

/* ---------------- boot ---------------- */

function shutdown() {
  console.log('[server] shutting down…');
  server.close(() => {
    db.close().then(() => process.exit(0)).catch(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  try {
    await db.pgReady();
  } catch (e) {
    console.error('FATAL: DATABASE_URL is set but PostgreSQL is unreachable:', e.message);
    process.exit(1);
  }
  await syncAdmins();
  server.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
})();

// Test hook (used by the automated verification script): exposes the managers
// so tests can drive tournament matches without playing full games by hand.
module.exports = { app, io, db, games, tournaments };

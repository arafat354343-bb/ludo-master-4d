'use strict';

/**
 * Admin API — EVERY /api/admin/* route lives in this file and nowhere else.
 *
 * VIRTUAL COINS ONLY. No real-money, deposit, cash-out or payment features
 * may ever be added here (or anywhere in this project).
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD A NEW ADMIN ENDPOINT (3 steps, no other wiring):
 *   1. If you need storage, add + export a helper in src/db.js
 *      (support BOTH the PostgreSQL path and the in-memory fallback).
 *   2. Add the route inside mountAdmin() below, e.g.:
 *
 *        app.get('/api/admin/my-thing', requireAuth, requireAdmin, async (req, res) => {
 *          try {
 *            res.json(await db.myHelper());
 *          } catch (e) {
 *            res.status(500).json({ error: 'my-thing failed' });
 *          }
 *        });
 *
 *      `requireAuth` gives you req.userId; `requireAdmin` (defined in this
 *      file) guarantees the caller is an admin and gives you req.adminUser.
 *   3. If the admin UI needs it, add an `adminXxx` function in
 *      client/js/api.js and call it from an admin tab's render function in
 *      client/js/app.js (see the ADMIN_TABS registry there).
 *
 * That's it — this file is mounted once from src/index.js via mountAdmin().
 * ---------------------------------------------------------------------------
 */

function mountAdmin(app, { db, io, requireAuth, isAdminEmail, tournaments }) {
  const notify = require('./notify'); // singleton, initialized in src/index.js
  /** Admin-only gate. Must run after requireAuth (needs req.userId). */
  async function requireAdmin(req, res, next) {
    try {
      const user = await db.getUserById(req.userId);
      if (!user) return res.status(404).json({ error: 'user not found' });
      if (!user.is_admin) return res.status(403).json({ error: 'admin only' });
      req.adminUser = user;
      return next();
    } catch (e) {
      console.error('[api] requireAdmin failed:', e);
      return res.status(500).json({ error: 'admin check failed' });
    }
  }

  /* ---------------- overview ---------------- */

  app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
      const [totalUsers, totalGames, gamesToday, coinsInCirculation] = await Promise.all([
        db.countUsers(),
        db.countGames(),
        db.countGamesToday(),
        db.sumCoins(),
      ]);
      res.json({
        totalUsers,
        totalGames,
        gamesToday,
        coinsInCirculation,
        onlineNow: io.sockets.sockets.size,
      });
    } catch (e) {
      console.error('[api] /api/admin/stats failed:', e);
      res.status(500).json({ error: 'admin stats failed' });
    }
  });

  /* ---------------- analytics (graphs + virtual-coin income) ----------------
   * "Income" = house rake in VIRTUAL coins: entry fees collected minus
   * winnings paid. No real money anywhere.
   */
  app.get('/api/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
    const days = Math.min(90, Math.max(1, Math.floor(Number(req.query.days) || 30)));
    try {
      res.json(await db.getAnalytics(days));
    } catch (e) {
      console.error('[api] /api/admin/analytics failed:', e);
      res.json(db.zeroAnalytics(days)); // zero-filled, never 500 for no-data
    }
  });

  /* ---------------- users ---------------- */

  app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { search = '', page = 1, limit = 20 } = req.query || {};
      res.json(await db.listUsers({ search, page, limit }));
    } catch (e) {
      console.error('[api] /api/admin/users failed:', e);
      res.status(500).json({ error: 'user list failed' });
    }
  });

  app.post('/api/admin/users/:id/coins', requireAuth, requireAdmin, async (req, res) => {
    const delta = Number((req.body || {}).delta);
    if (!Number.isInteger(delta)) return res.status(400).json({ error: 'delta must be an integer' });
    try {
      const coins = await db.addCoins(req.params.id, delta);
      await db.recordLedger(req.params.id, delta, 'admin_grant', null);
      res.json({ coins });
    } catch (e) {
      if (e.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'user not found' });
      if (e.code === 'INSUFFICIENT_COINS') return res.status(400).json({ error: 'balance cannot go below 0' });
      console.error('[api] grant coins failed:', e);
      res.status(500).json({ error: 'grant failed' });
    }
  });

  app.post('/api/admin/users/:id/ban', requireAuth, requireAdmin, async (req, res) => {
    const banned = !!(req.body || {}).banned;
    try {
      const target = await db.getUserById(req.params.id);
      if (!target) return res.status(404).json({ error: 'user not found' });
      if (isAdminEmail(target.email) && banned) {
        return res.status(400).json({ error: 'cannot ban an admin-listed account' });
      }
      const user = await db.setBanned(req.params.id, banned);
      // Kick their live sockets immediately.
      for (const [, s] of io.sockets.sockets) {
        if (s.user && s.user.id === req.params.id) {
          s.emit('error', { message: 'Account banned' });
          s.disconnect(true);
        }
      }
      res.json({ banned: user.banned });
    } catch (e) {
      if (e.code === 'USER_NOT_FOUND') return res.status(404).json({ error: 'user not found' });
      console.error('[api] ban failed:', e);
      res.status(500).json({ error: 'ban failed' });
    }
  });

  /* ---------------- matches ---------------- */

  app.get('/api/admin/games', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await db.getRecentGames((req.query || {}).limit || 20));
    } catch (e) {
      console.error('[api] /api/admin/games failed:', e);
      res.status(500).json({ error: 'games list failed' });
    }
  });

  /* ---------------- rooms + economy config ---------------- */

  app.get('/api/admin/config', requireAuth, requireAdmin, async (req, res) => {
    try {
      const [rooms, economy, matchmaking, coin_packs] = await Promise.all([
        db.getRoomsConfig(), db.getEconomy(), db.getMatchmaking(), db.getCoinPacks(),
      ]);
      res.json({ rooms, economy, matchmaking, coin_packs });
    } catch (e) {
      console.error('[api] /api/admin/config failed:', e);
      res.status(500).json({ error: 'config failed' });
    }
  });

  app.put('/api/admin/config', requireAuth, requireAdmin, async (req, res) => {
    try {
      // Partial updates allowed: merge provided keys over the current config.
      const [curRooms, curEconomy, curMm, curPacks] = await Promise.all([
        db.getRoomsConfig(), db.getEconomy(), db.getMatchmaking(), db.getCoinPacks(),
      ]);
      const body = req.body || {};
      const v = validateAdminConfig({
        rooms: body.rooms !== undefined ? body.rooms : curRooms,
        economy: body.economy !== undefined ? body.economy : curEconomy,
        matchmaking: body.matchmaking !== undefined ? body.matchmaking : curMm,
        coin_packs: body.coin_packs !== undefined ? body.coin_packs : curPacks,
      });
      if (!v.ok) return res.status(400).json({ error: v.error });
      await db.setConfig('rooms', v.rooms);
      await db.setConfig('economy', v.economy);
      await db.setConfig('matchmaking', v.matchmaking);
      await db.setConfig('coin_packs', v.coin_packs);
      res.json({ rooms: v.rooms, economy: v.economy, matchmaking: v.matchmaking, coin_packs: v.coin_packs });
    } catch (e) {
      console.error('[api] save config failed:', e);
      res.status(500).json({ error: 'save config failed' });
    }
  });

  /* ---------------- reward codes (free-coin promo codes; virtual coins only) ---------------- */

  app.get('/api/admin/redeem-codes', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json({ codes: await db.listRedeemCodes() });
    } catch (e) {
      res.status(500).json({ error: 'reward codes failed' });
    }
  });

  app.post('/api/admin/redeem-codes', requireAuth, requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const row = await db.createRedeemCode(req.adminUser.id, body.code, body.coins, body.max_uses);
      res.json({ code: row });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'create code failed' });
    }
  });

  app.delete('/api/admin/redeem-codes/:code', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await db.deleteRedeemCode(req.params.code));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'delete code failed' });
    }
  });

  /* ---------------- support chat ---------------- */

  // Conversation list for the admin Support tab (newest activity first).
  app.get('/api/admin/support/threads', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await db.getSupportThreads());
    } catch (e) {
      console.error('[api] support threads failed:', e);
      res.status(500).json({ error: 'support threads failed' });
    }
  });

  // Full thread with one user; opening it marks their messages as read.
  app.get('/api/admin/support/thread/:userId', requireAuth, requireAdmin, async (req, res) => {
    try {
      const messages = await db.getSupportThread(req.params.userId, 100);
      await db.markSupportReadByAdmin(req.params.userId);
      res.json({ messages });
    } catch (e) {
      console.error('[api] support thread failed:', e);
      res.status(500).json({ error: 'support thread failed' });
    }
  });

  /* ---------------- announcements ---------------- */

  app.get('/api/admin/announcements', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await db.listAnnouncements(false));
    } catch (e) {
      console.error('[api] list announcements failed:', e);
      res.status(500).json({ error: 'announcements failed' });
    }
  });

  app.post('/api/admin/announcements', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { title, body } = req.body || {};
      const created = await db.createAnnouncement({ title, body });
      // Telegram: broadcast the announcement to all linked users (no-op without token).
      notify.notifyMany(await db.listTelegramLinkedUserIds(),
        '📢 ' + String(title || 'New announcement') + '\n' + String(body || '').slice(0, 500));
      res.status(201).json(created);
    } catch (e) {
      if (e.code === 'BAD_ANNOUNCEMENT') return res.status(400).json({ error: e.message });
      console.error('[api] create announcement failed:', e);
      res.status(500).json({ error: 'create failed' });
    }
  });

  app.put('/api/admin/announcements/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { title, body, active } = req.body || {};
      res.json(await db.updateAnnouncement(req.params.id, { title, body, active }));
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'announcement not found' });
      if (e.code === 'BAD_ANNOUNCEMENT') return res.status(400).json({ error: e.message });
      console.error('[api] update announcement failed:', e);
      res.status(500).json({ error: 'update failed' });
    }
  });

  app.delete('/api/admin/announcements/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const ok = await db.deleteAnnouncement(req.params.id);
      if (!ok) return res.status(404).json({ error: 'announcement not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('[api] delete announcement failed:', e);
      res.status(500).json({ error: 'delete failed' });
    }
  });

  /* ---------------- coin requests (approve / reject) ---------------- */

  app.get('/api/admin/requests', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json({ requests: await db.listCoinRequests(req.query.status) });
    } catch (e) {
      res.status(500).json({ error: 'requests failed' });
    }
  });

  app.post('/api/admin/requests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
    try {
      const request = await db.decideCoinRequest(req.params.id, true, req.userId);
      // Telegram: tell the user their coins were credited (no-op without token / not linked).
      notify.notifyUser(request.user_id,
        '✅ Your ' + Number(request.pack_coins).toLocaleString() + '-coin request was approved! Coins added to your wallet.');
      res.json({ request });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'approve failed' });
    }
  });

  app.post('/api/admin/requests/:id/reject', requireAuth, requireAdmin, async (req, res) => {
    try {
      const request = await db.decideCoinRequest(req.params.id, false, req.userId);
      // Telegram: tell the user (no-op without token / not linked).
      notify.notifyUser(request.user_id,
        '❌ Your ' + Number(request.pack_coins).toLocaleString() + '-coin request was rejected. Contact support if you have questions.');
      res.json({ request });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'reject failed' });
    }
  });

  /* ---------------- tournaments ---------------- */

  app.get('/api/admin/tournaments', requireAuth, requireAdmin, async (req, res) => {
    try {
      const rows = await db.listTournamentRows();
      res.json({
        tournaments: rows.map((t) => ({
          id: t.id, name: t.name, entryFee: t.entry_fee, maxPlayers: t.max_players,
          prize1st: t.prize_1st, prize2nd: t.prize_2nd, prize3rd: t.prize_3rd,
          status: t.status, startsAt: t.starts_at, createdAt: t.created_at,
          playerCount: t.player_count,
          prizePool: t.prize_1st + t.prize_2nd + t.prize_3rd,
        })),
      });
    } catch (e) {
      console.error('[api] admin tournaments failed:', e);
      res.status(500).json({ error: 'tournaments failed' });
    }
  });

  app.post('/api/admin/tournaments', requireAuth, requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const t = await tournaments.createTournament({
        name: b.name, entryFee: b.entryFee, maxPlayers: b.maxPlayers,
        prize1st: b.prize1st, prize2nd: b.prize2nd, prize3rd: b.prize3rd,
        startsAt: b.startsAt, adminId: req.userId,
      });
      res.status(201).json({ tournament: t });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'create failed' });
    }
  });

  app.post('/api/admin/tournaments/:id/start', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await tournaments.forceStart(req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'start failed' });
    }
  });

  app.post('/api/admin/tournaments/:id/cancel', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json(await tournaments.cancelTournament(req.params.id));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'cancel failed' });
    }
  });

  /* ---------------- custom options (home-screen link buttons) ---------------- */

  app.get('/api/admin/options', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json({ options: await db.getCustomOptions() });
    } catch (e) {
      res.status(500).json({ error: 'options failed' });
    }
  });

  app.put('/api/admin/options', requireAuth, requireAdmin, async (req, res) => {
    try {
      res.json({ options: await db.setCustomOptions(req.body && req.body.options) });
    } catch (e) {
      res.status(500).json({ error: 'save options failed' });
    }
  });
}

/**
 * Validate a full rooms+economy config payload. Admins have FULL control:
 * arbitrary entry tiers may be added, edited, disabled or removed per mode.
 * Returns { ok, rooms, economy } or { ok:false, error }.
 */
function validateAdminConfig(body) {
  const rooms = body && body.rooms;
  const economy = body && body.economy;
  const matchmaking = body && body.matchmaking;
  const coin_packs = body && body.coin_packs;
  if (!rooms || typeof rooms !== 'object') return { ok: false, error: 'rooms is required' };
  if (!economy || typeof economy !== 'object') return { ok: false, error: 'economy is required' };
  if (!matchmaking || typeof matchmaking !== 'object') return { ok: false, error: 'matchmaking is required' };
  const out = {};
  for (const mode of ['twoPlayer', 'fourPlayer']) {
    const arr = rooms[mode];
    if (!Array.isArray(arr) || arr.length === 0) {
      return { ok: false, error: mode + ' must be a non-empty array' };
    }
    if (arr.length > 20) return { ok: false, error: mode + ' may have at most 20 tiers' };
    const seen = new Set();
    const list = [];
    for (const r of arr) {
      const entry = Number(r && r.entry);
      const win = Number(r && r.win);
      if (!Number.isInteger(entry) || entry <= 0) {
        return { ok: false, error: `${mode}: entry must be a positive integer` };
      }
      if (seen.has(entry)) return { ok: false, error: `${mode}: duplicate entry ${entry}` };
      seen.add(entry);
      if (!Number.isInteger(win) || win < 0) {
        return { ok: false, error: `${mode}: win for entry ${entry} must be a non-negative integer` };
      }
      list.push({ entry, win, enabled: !r || r.enabled !== false });
    }
    list.sort((a, b) => a.entry - b.entry);
    out[mode] = list;
  }
  const eco = {};
  for (const k of ['signupBonus', 'dailyBonus', 'referralBonus']) {
    const v = Number(economy[k]);
    if (!Number.isInteger(v) || v < 0) {
      return { ok: false, error: `economy.${k} must be a non-negative integer` };
    }
    eco[k] = v;
  }
  const mm = {};
  for (const k of ['twoPlayerWaitSec', 'fourPlayerWaitSec']) {
    const v = Number(matchmaking[k]);
    if (!Number.isInteger(v) || v < 2 || v > 300) {
      return { ok: false, error: `matchmaking.${k} must be an integer between 2 and 300 seconds` };
    }
    mm[k] = v;
  }
  // Coin packs: 1–20 positive integers, deduplicated, sorted.
  let packs = [1000, 5000, 20000];
  if (coin_packs !== undefined) {
    if (!Array.isArray(coin_packs) || coin_packs.length === 0) {
      return { ok: false, error: 'coin_packs must be a non-empty array' };
    }
    if (coin_packs.length > 20) return { ok: false, error: 'coin_packs may have at most 20 packs' };
    const clean = [];
    for (const p of coin_packs) {
      const n = Number(p);
      if (!Number.isInteger(n) || n <= 0 || n > 1000000) {
        return { ok: false, error: 'each coin pack must be a positive integer (max 1,000,000)' };
      }
      if (!clean.includes(n)) clean.push(n);
    }
    clean.sort((a, b) => a - b);
    packs = clean;
  }
  return { ok: true, rooms: out, economy: eco, matchmaking: mm, coin_packs: packs };
}

module.exports = { mountAdmin };

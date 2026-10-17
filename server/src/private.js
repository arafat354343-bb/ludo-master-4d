'use strict';

/**
 * Private rooms: invite-code Ludo rooms (VIRTUAL COINS ONLY).
 *
 * Flow: creator sets the entry fee + player count (2 or 4) → gets a 6-char
 * invite code → friend joins with the code → entry is deducted from each
 * player at JOIN time → when full, a real game launches via GameManager
 * (no-economy room, like tournaments) → winner gets pool minus the
 * admin-set commission % (app_config `private_commission_pct`).
 *
 * Safety: if the game ends with no human winner (bot won / broken game),
 * every player is REFUNDED — the house never keeps player money on a
 * broken game. Waiting rooms expire after 30 minutes with full refunds.
 */

const { randomUUID } = require('crypto');
const notify = require('./notify'); // singleton, initialized in src/index.js

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const ROOM_TTL_MS = 30 * 60 * 1000;
const MIN_ENTRY = 50;
const MAX_ENTRY = 100000;

function perr(status, message) {
  return Object.assign(new Error(message), { status });
}

function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

class PrivateRooms {
  constructor(io, db, games) {
    this.io = io;
    this.db = db;
    this.games = games;
    this.sched = null;
  }

  /* ---------------- helpers ---------------- */

  async roomPayload(room) {
    const players = await this.db.listPrivateRoomPlayers(room.id);
    return {
      id: room.id,
      code: room.code,
      entryFee: room.entry_fee,
      maxPlayers: room.max_players,
      status: room.status,
      commissionPct: room.commission_pct,
      creatorId: room.creator_id,
      playerCount: players.length,
      players: players.map((p) => ({
        userId: p.user_id, name: p.name, joinedAt: p.joined_at,
        isCreator: p.user_id === room.creator_id,
      })),
      expiresAt: room.expires_at,
    };
  }

  async assertCanPlay(userId) {
    const u = await this.db.getUserById(userId);
    if (!u) throw perr(404, 'user not found');
    if (u.banned) throw perr(403, 'account banned');
    const active = await this.db.getUserActivePrivateRoom(userId);
    if (active) throw perr(400, 'finish your current private room first');
    if (this.games.tournamentManager) {
      try {
        if (await this.games.tournamentManager.userHasActiveMatch(userId)) {
          throw perr(400, 'finish your tournament match first');
        }
      } catch (e) {
        if (e.status) throw e;
        console.error('[private] tournament check failed:', e.message);
      }
    }
    return u;
  }

  /* ---------------- room lifecycle ---------------- */

  async createRoom(creatorId, entryFee, maxPlayers) {
    const entry = Math.floor(Number(entryFee));
    const seats = Number(maxPlayers);
    if (!Number.isInteger(entry) || entry < MIN_ENTRY || entry > MAX_ENTRY) {
      throw perr(400, `entry fee must be between ${MIN_ENTRY} and ${MAX_ENTRY} coins`);
    }
    if (seats !== 2 && seats !== 4) throw perr(400, 'players must be 2 or 4');

    const u = await this.assertCanPlay(creatorId);
    if (u.coins < entry) throw perr(400, 'not enough coins for this entry fee');

    let code = null;
    for (let i = 0; i < 25; i++) {
      const c = makeCode();
      if (!(await this.db.getPrivateRoomByCode(c))) { code = c; break; }
    }
    if (!code) throw perr(500, 'could not generate a room code');

    const pct = await this.db.getPrivateCommissionPct();
    const room = await this.db.createPrivateRoomRow({
      code, creatorId, entryFee: entry, maxPlayers: seats, commissionPct: pct,
      expiresAt: new Date(Date.now() + ROOM_TTL_MS).toISOString(),
    });
    await this.db.addCoins(creatorId, -entry);
    await this.db.recordLedger(creatorId, -entry, 'private_entry', room.id);
    await this.db.addPrivateRoomPlayer(room.id, creatorId);
    console.log(`[private] room ${code} created by ${creatorId} (entry ${entry}, ${seats}P)`);
    return this.roomPayload({ ...room, commission_pct: pct });
  }

  async joinRoom(rawCode, userId) {
    const code = String(rawCode || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw perr(400, 'invalid invite code');
    let room = await this.db.getPrivateRoomByCode(code);
    if (!room) throw perr(404, 'room not found — check the code');
    if (new Date(room.expires_at).getTime() < Date.now() && room.status === 'waiting') {
      await this.expireRoom(room);
      room = await this.db.getPrivateRoomById(room.id);
    }
    if (room.status !== 'waiting') throw perr(400, 'this room is no longer open');

    const players = await this.db.listPrivateRoomPlayers(room.id);
    if (players.some((p) => p.user_id === userId)) return this.roomPayload(room); // idempotent

    const u = await this.assertCanPlay(userId);
    if (players.length >= room.max_players) throw perr(400, 'room is full');
    if (u.coins < room.entry_fee) throw perr(400, 'not enough coins for this entry fee');

    await this.db.addCoins(userId, -room.entry_fee);
    await this.db.recordLedger(userId, -room.entry_fee, 'private_entry', room.id);
    await this.db.addPrivateRoomPlayer(room.id, userId);
    console.log(`[private] ${userId} joined room ${code} (${players.length + 1}/${room.max_players})`);
    this.emitUpdate(room.id);

    const now = players.length + 1;
    if (now >= room.max_players) {
      await this.startRoomGame(room.id);
      room = await this.db.getPrivateRoomById(room.id);
    }
    return this.roomPayload(room);
  }

  async getRoomInfo(code, userId) {
    const room = await this.db.getPrivateRoomByCode(String(code || '').toUpperCase().trim());
    if (!room) throw perr(404, 'room not found');
    return this.roomPayload(room);
  }

  async leaveRoom(roomId, userId) {
    const room = await this.db.getPrivateRoomById(roomId);
    if (!room) throw perr(404, 'room not found');
    if (room.status !== 'waiting') throw perr(400, 'game already started');
    const players = await this.db.listPrivateRoomPlayers(roomId);
    if (!players.some((p) => p.user_id === userId)) throw perr(400, 'you are not in this room');
    if (room.creator_id === userId) return this.cancelRoom(roomId, userId); // creator leaving = cancel
    await this.db.removePrivateRoomPlayer(roomId, userId);
    await this.db.addCoins(userId, room.entry_fee);
    await this.db.recordLedger(userId, room.entry_fee, 'private_refund', roomId);
    this.emitUpdate(roomId);
    return this.roomPayload({ ...room });
  }

  async cancelRoom(roomId, userId) {
    const room = await this.db.getPrivateRoomById(roomId);
    if (!room) throw perr(404, 'room not found');
    if (room.creator_id !== userId) throw perr(403, 'only the creator can cancel');
    if (room.status !== 'waiting') throw perr(400, 'game already started');
    await this.refundRoom(room, 'cancelled by creator');
    return { ok: true };
  }

  async refundRoom(room, reason) {
    const players = await this.db.listPrivateRoomPlayers(room.id);
    for (const p of players) {
      try {
        await this.db.addCoins(p.user_id, room.entry_fee);
        await this.db.recordLedger(p.user_id, room.entry_fee, 'private_refund', room.id);
      } catch (e) { console.error('[private] refund failed:', e.message); }
    }
    await this.db.setPrivateRoomStatus(room.id, 'cancelled');
    console.log(`[private] room ${room.code} cancelled (${reason}) — ${players.length} refunded`);
    this.emitUpdate(room.id, 'cancelled');
  }

  async expireRoom(room) {
    await this.refundRoom(room, 'expired');
  }

  async userHasActiveRoom(userId) {
    return !!(await this.db.getUserActivePrivateRoom(userId));
  }

  /* ---------------- game launch + game over ---------------- */

  /**
   * All entries were collected at join time → launch a no-economy room
   * (same pattern as tournaments) and let the game screen take over.
   */
  async startRoomGame(roomId) {
    const room = await this.db.getPrivateRoomById(roomId);
    if (!room || room.status !== 'waiting') return null;
    const players = await this.db.listPrivateRoomPlayers(roomId);
    if (players.length < 2) return null;

    await this.db.setPrivateRoomStatus(roomId, 'ongoing');
    const mode = room.max_players === 4 ? '4p' : '2p';
    const humans = [];
    for (const p of players) {
      let sock = null;
      for (const [, s] of this.io.sockets.sockets) {
        if (s.user && s.user.id === p.user_id && !s.banned) { sock = s; break; }
      }
      if (sock) {
        try { this.games.leaveQueue(sock); } catch (e) { /* ignore */ }
        humans.push({ userId: p.user_id, name: p.name, socketId: sock.id, isBot: false, disconnected: false, finishedCount: 0 });
      } else {
        // Offline at start: stays in the game, a bot plays their turns.
        humans.push({ userId: p.user_id, name: p.name, socketId: null, isBot: false, disconnected: true, finishedCount: 0 });
      }
    }
    const gameRoom = await this.games.startRoom(humans, mode, room.entry_fee, { privateRoomId: roomId });
    if (!gameRoom) {
      await this.db.setPrivateRoomStatus(roomId, 'waiting'); // retry when someone rejoins/polls
      return null;
    }
    console.log(`[private] room ${room.code} game started (${gameRoom.id})`);
    this.emitUpdate(roomId, 'ongoing');
    // Telegram: tell every player their private room game started.
    notify.notifyMany(players.map((p) => p.user_id), '🎮 Your private room game started! Good luck 🎲');
    return gameRoom;
  }

  /**
   * Called by GameManager.endGame via games.privateHook.
   * Winner gets pool minus commission; house cut is ledgered as 'commission'.
   * No human winner (bot won / broken game) → FULL refunds, house keeps 0.
   */
  async onGameOver(roomId, winnerUserId) {
    const room = await this.db.getPrivateRoomById(roomId);
    if (!room || room.status === 'completed' || room.status === 'cancelled') return;
    const players = await this.db.listPrivateRoomPlayers(roomId);
    if (!players.length) {
      await this.db.setPrivateRoomStatus(roomId, 'completed');
      return;
    }
    const pool = room.entry_fee * players.length;
    const commission = Math.round((pool * room.commission_pct) / 100);
    const prize = pool - commission;
    const winner = winnerUserId && players.find((p) => p.user_id === winnerUserId);

    if (winner) {
      const bal = await this.db.addCoins(winner.user_id, prize);
      await this.db.recordLedger(winner.user_id, prize, 'private_win', roomId);
      if (commission > 0) await this.db.recordLedger(null, commission, 'commission', roomId);
      for (const [, s] of this.io.sockets.sockets) {
        if (s.user && s.user.id === winner.user_id) s.emit('wallet:update', { coins: bal });
      }
      console.log(`[private] room ${room.code} over — winner ${winner.user_id} +${prize} (commission ${commission})`);
    } else {
      // No human winner: refund everyone, house keeps nothing.
      for (const p of players) {
        try {
          await this.db.addCoins(p.user_id, room.entry_fee);
          await this.db.recordLedger(p.user_id, room.entry_fee, 'private_refund', roomId);
        } catch (e) { console.error('[private] game-over refund failed:', e.message); }
      }
      console.log(`[private] room ${room.code} over with no human winner — all refunded`);
    }
    await this.db.setPrivateRoomStatus(roomId, 'completed');
    this.emitUpdate(roomId, 'completed');
  }

  emitUpdate(roomId, status) {
    this.io.to('private:' + roomId).emit('private:update', { roomId, status: status || 'waiting' });
  }

  /* ---------------- scheduler ---------------- */

  startScheduler() {
    if (this.sched) return;
    this.sched = setInterval(async () => {
      try {
        const expired = await this.db.listExpiredPrivateRooms();
        for (const room of expired) await this.expireRoom(room);
      } catch (e) {
        console.error('[private] scheduler failed:', e.message);
      }
    }, 30 * 1000);
    console.log('[private] expiry scheduler started (30s)');
  }

  /* ---------------- REST ---------------- */

  mountRoutes(app, { requireAuth }) {
    this.io.on('connection', (socket) => {
      socket.on('private:watch', (p) => {
        const id = p && p.roomId;
        if (typeof id === 'string' && id.length < 64) socket.join('private:' + id);
      });
      socket.on('private:unwatch', (p) => {
        const id = p && p.roomId;
        if (typeof id === 'string' && id.length < 64) socket.leave('private:' + id);
      });
    });

    app.get('/api/private/config', async (req, res) => {
      try {
        res.json({ commissionPct: await this.db.getPrivateCommissionPct() });
      } catch (e) {
        res.json({ commissionPct: 10 });
      }
    });

    app.post('/api/private/create', requireAuth, async (req, res) => {
      try {
        const b = req.body || {};
        res.json({ room: await this.createRoom(req.userId, b.entryFee, b.maxPlayers) });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message || 'create failed' });
      }
    });

    app.post('/api/private/join', requireAuth, async (req, res) => {
      try {
        res.json({ room: await this.joinRoom(req.body && req.body.code, req.userId) });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message || 'join failed' });
      }
    });

    app.get('/api/private/:code', requireAuth, async (req, res) => {
      try {
        res.json({ room: await this.getRoomInfo(req.params.code, req.userId) });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message || 'room failed' });
      }
    });

    app.post('/api/private/:id/leave', requireAuth, async (req, res) => {
      try {
        res.json({ room: await this.leaveRoom(req.params.id, req.userId) });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message || 'leave failed' });
      }
    });

    app.post('/api/private/:id/cancel', requireAuth, async (req, res) => {
      try {
        res.json(await this.cancelRoom(req.params.id, req.userId));
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message || 'cancel failed' });
      }
    });
  }

  mountPrivateAdmin(app, { requireAuth }) {
    const requireAdmin = async (req, res, next) => {
      try {
        const user = await this.db.getUserById(req.userId);
        if (!user) return res.status(404).json({ error: 'user not found' });
        if (!user.is_admin) return res.status(403).json({ error: 'admin only' });
        return next();
      } catch (e) {
        console.error('[api] private requireAdmin failed:', e);
        return res.status(500).json({ error: 'auth failed' });
      }
    };

    app.get('/api/admin/private-config', requireAuth, requireAdmin, async (req, res) => {
      try {
        res.json({ pct: await this.db.getPrivateCommissionPct() });
      } catch (e) {
        res.status(500).json({ error: 'config failed' });
      }
    });

    app.put('/api/admin/private-config', requireAuth, requireAdmin, async (req, res) => {
      try {
        const pct = await this.db.setPrivateCommissionPct(req.body && req.body.pct);
        res.json({ pct });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message || 'save failed' });
      }
    });
  }
}

module.exports = PrivateRooms;

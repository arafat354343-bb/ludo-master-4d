'use strict';

/**
 * GameManager — rooms, matchmaking, turn loop, timers, payouts.
 *
 * VIRTUAL COINS ONLY. Entry fees and winnings are virtual coins with no cash
 * value. There is no cash-out, no withdraw-to-money, no payment feature.
 *
 * Requires the shared engine at ../shared/ludo-engine.js (relative to server/)
 * and fails fast with a clear error when it is missing or incomplete.
 */

const path = require('path');
const { randomUUID } = require('crypto');

const ENGINE_PATH = path.resolve(__dirname, '../../shared/ludo-engine.js');
let Engine = null;
try {
  Engine = require(ENGINE_PATH);
} catch (err) {
  console.error('');
  console.error('FATAL: shared Ludo engine not found.');
  console.error(`  Looked for: ${ENGINE_PATH}`);
  console.error('  (i.e. <project-root>/shared/ludo-engine.js — required as ../shared/ludo-engine.js from server/)');
  console.error('  The engine module is written by a teammate; the game server cannot start without it.');
  console.error('');
  process.exit(1);
}
for (const fn of ['createGame', 'setRoll', 'legalMoves', 'applyMove', 'chooseBotMove', 'rollDice']) {
  if (typeof Engine[fn] !== 'function') {
    console.error(`FATAL: shared Ludo engine at ${ENGINE_PATH} is missing required function Engine.${fn}()`);
    process.exit(1);
  }
}

const { createBot, botDelayMs } = require('./bot');

// Fallback tiers if the config cannot be read (normally from app_config).
const DEFAULT_ENTRIES = [40, 50, 60, 80, 300];
const MODES = {
  '2p': { seats: 2, colors: ['red', 'yellow'], winMult: 1.6, fillAfterMs: 8_000 },
  '4p': { seats: 4, colors: ['red', 'green', 'yellow', 'blue'], winMult: 3.2, fillAfterMs: 8_000 },
};
const TURN_SECONDS = 15;

function winAmount(mode, entry) {
  return Math.round(entry * MODES[mode].winMult);
}

class GameManager {
  constructor(io, db) {
    this.io = io;
    this.db = db;
    this.queues = new Map();     // queueKey -> { mode, entry, players: [], timer }
    this.rooms = new Map();      // roomId -> room
    this.socketRoom = new Map(); // socketId -> roomId
    this.socketQueue = new Map();// socketId -> queueKey
  }

  /* ---------------- matchmaking ---------------- */

  /** Room tiers from the admin-controlled config (with sane fallback). */
  async roomsConfig() {
    try {
      return await this.db.getRoomsConfig();
    } catch (e) {
      console.error('[game] getRoomsConfig failed, using defaults:', e.message);
      const d = (mult) => DEFAULT_ENTRIES.map((entry) => ({ entry, win: Math.round(entry * mult), enabled: true }));
      return { twoPlayer: d(1.6), fourPlayer: d(3.2) };
    }
  }

  /** Win payout for a tier: the admin-configured win, falling back to the multiplier math. */
  async winFor(mode, entry) {
    const cfg = await this.roomsConfig();
    const list = mode === '2p' ? cfg.twoPlayer : cfg.fourPlayer;
    const tier = list.find((r) => r.entry === entry);
    if (tier) return tier.win;
    return Math.round(entry * MODES[mode].winMult);
  }

  async joinQueue(socket, payload) {
    payload = payload || {};
    const mode = payload.mode;
    const entry = Number(payload.entry);
    if (!MODES[mode] || !Number.isInteger(entry) || entry <= 0) {
      socket.emit('error', { message: 'invalid mode or entry' });
      return;
    }
    // A live tournament match comes first: no double-play in casual queues.
    try {
      if (this.tournamentManager && await this.tournamentManager.userHasActiveMatch(socket.user.id)) {
        socket.emit('error', { message: 'finish your tournament match first' });
        return;
      }
    } catch (e) {
      console.error('[queue] tournament check failed:', e.message);
    }
    // A live private room comes first: no double-play in casual queues.
    try {
      if (this.privateRooms && await this.privateRooms.userHasActiveRoom(socket.user.id)) {
        socket.emit('error', { message: 'finish your private room game first' });
        return;
      }
    } catch (e) {
      console.error('[queue] private-room check failed:', e.message);
    }
    const cfg = await this.roomsConfig();
    const list = mode === '2p' ? cfg.twoPlayer : cfg.fourPlayer;
    const tier = list.find((r) => r.entry === entry);
    if (!tier) {
      socket.emit('error', { message: 'invalid mode or entry' });
      return;
    }
    if (!tier.enabled) {
      socket.emit('error', { message: 'this room is currently disabled' });
      return;
    }
    this.leaveQueue(socket); // one queue per socket
    const key = `${mode}:${entry}`;
    let q = this.queues.get(key);
    if (!q) {
      q = { mode, entry, players: [], timer: null };
      this.queues.set(key, q);
    }
    if (q.players.some((p) => p.userId === socket.user.id)) return; // already queued
    q.players.push({
      socketId: socket.id,
      userId: socket.user.id,
      name: socket.user.name,
      joinedAt: Date.now(),
    });
    this.socketQueue.set(socket.id, key);
    this.emitQueueStatus(key);

    if (q.players.length >= MODES[mode].seats) {
      this.startRoomFromQueue(key);
    } else if (!q.timer && !q.timerPending) {
      // Wait for human opponents; if the queue is still short after the
      // admin-configured wait, bots fill the empty seats (vs computer).
      // Queues are keyed `${mode}:${entry}`, so different entry fees NEVER mix.
      q.timerPending = true;
      this.db.getMatchmaking().then((mm) => {
        const sec = mode === '2p' ? mm.twoPlayerWaitSec : mm.fourPlayerWaitSec;
        const queue = this.queues.get(key);
        queue.timerPending = false;
        if (!queue || queue.players.length >= MODES[mode].seats) return;
        queue.timer = setTimeout(() => this.fillWithBots(key), sec * 1000);
      }).catch((e) => {
        console.error('[queue] matchmaking config read failed, using default:', e.message);
        const queue = this.queues.get(key);
        queue.timerPending = false;
        if (!queue || queue.players.length >= MODES[mode].seats) return;
        queue.timer = setTimeout(() => this.fillWithBots(key), MODES[mode].fillAfterMs);
      });
    }
  }

  leaveQueue(socket) {
    const key = this.socketQueue.get(socket.id);
    if (!key) return;
    this.socketQueue.delete(socket.id);
    const q = this.queues.get(key);
    if (!q) return;
    q.players = q.players.filter((p) => p.socketId !== socket.id);
    if (q.players.length === 0) {
      if (q.timer) clearTimeout(q.timer);
      this.queues.delete(key);
      return;
    }
    this.emitQueueStatus(key);
  }

  emitQueueStatus(key) {
    const q = this.queues.get(key);
    if (!q) return;
    for (const p of q.players) {
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) s.emit('queue:status', { waiting: q.players.length, mode: q.mode, entry: q.entry });
    }
  }

  drainQueue(key) {
    const q = this.queues.get(key);
    if (!q) return null;
    if (q.timer) clearTimeout(q.timer);
    this.queues.delete(key);
    const humans = q.players.map((p) => ({
      userId: p.userId,
      name: p.name,
      socketId: p.socketId,
      isBot: false,
      disconnected: false,
      finishedCount: 0,
    }));
    for (const h of humans) this.socketQueue.delete(h.socketId);
    return { mode: q.mode, entry: q.entry, humans };
  }

  async startRoomFromQueue(key) {
    const d = this.drainQueue(key);
    if (!d || d.humans.length === 0) return;
    await this.startRoom(d.humans, d.mode, d.entry);
  }

  async fillWithBots(key) {
    const d = this.drainQueue(key);
    if (!d || d.humans.length === 0) return; // everyone left; nothing to start
    await this.startRoom(d.humans, d.mode, d.entry);
  }

  /* ---------------- room lifecycle ---------------- */

  /**
   * Create a room from human players (+ bots to fill seats), deduct entry
   * fees, and kick off the turn loop.
   *
   * opts.tournamentMatchId — tournament game: entry was already collected at
   * join time, so ALL room economy (balance gate, deduction, entry ledger)
   * is skipped and no normal win payout happens at game over.
   * opts.privateRoomId — private game: same treatment; the PrivateRooms
   * manager pays the winner (pool minus commission) via its own hook.
   */
  async startRoom(humans, mode, entry, opts = {}) {
    const seats = MODES[mode].seats;
    const noEconomy = !!opts.tournamentMatchId || !!opts.privateRoomId;

    // Verify balance and deduct the entry fee up front (casual rooms only).
    const kept = [];
    for (const h of humans) {
      const sock = this.io.sockets.sockets.get(h.socketId);
      try {
        if (!noEconomy) {
          const u = await this.db.getUserById(h.userId);
          if (!u) throw new Error('no such user');
          if (u.coins < entry) {
            if (sock) sock.emit('error', { message: 'not enough coins for this room' });
            continue;
          }
          await this.db.addCoins(h.userId, -entry);
        }
        kept.push(h);
      } catch (err) {
        if (sock) sock.emit('error', { message: 'could not join room' });
      }
    }
    if (kept.length === 0) return null;

    const usedNames = new Set(kept.map((h) => h.name));
    const players = [...kept];
    while (players.length < seats) players.push(createBot(null, usedNames));
    // Shuffle seating, then assign colors in order so engine turn order matches.
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [players[i], players[j]] = [players[j], players[i]];
    }
    const colors = MODES[mode].colors;
    players.forEach((p, i) => { p.color = colors[i]; });

    const room = {
      id: randomUUID(),
      mode,
      entry,
      players,
      state: Engine.createGame(colors),
      turnGen: 0, // bumped on every timer reset; stale timeouts check it
      over: false,
      tickInterval: null,
      botTimeout: null,
      tournamentMatchId: opts.tournamentMatchId || null,
      privateRoomId: opts.privateRoomId || null,
    };
    this.rooms.set(room.id, room);

    for (const p of players) {
      if (p.isBot) continue;
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) {
        await sock.join(room.id);
        this.socketRoom.set(sock.id, room.id);
      } else {
        p.disconnected = true; // socket vanished already: bot plays for them
      }
    }

    // Push fresh balances after the entry deduction.
    for (const p of players) {
      if (p.isBot || p.disconnected) continue;
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (!sock) continue;
      try {
        const u = await this.db.getUserById(p.userId);
        if (u) sock.emit('wallet:update', { coins: u.coins });
      } catch (e) { /* non-fatal */ }
    }

    // Ledger: entry fees collected (never throws). Skipped for tournaments —
    // their entry was already collected (and ledgered) at join time.
    if (!noEconomy) {
      for (const h of kept) {
        await this.db.recordLedger(h.userId, -entry, 'entry_fee', room.id);
      }
    }

    this.io.to(room.id).emit('game:start', this.publicState(room));
    this.beginTurn(room);
    return room;
  }

  currentPlayer(room) {
    return room.players[room.state.turnIndex] || null;
  }

  publicState(room) {
    const s = room.state;
    const byColor = new Map(s.players.map((p) => [p.color, p]));
    let movableTokens = [];
    if (s.phase === 'awaitingMove') {
      try {
        movableTokens = Engine.legalMoves(s).map((m) => m.token);
      } catch (e) {
        movableTokens = [];
      }
    }
    return {
      roomId: room.id,
      mode: room.mode,
      entry: room.entry,
      players: room.players.map((p) => ({
        id: p.isBot ? p.botId : p.userId,
        name: p.name,
        color: p.color,
        isBot: p.isBot,
        tokens: [...((byColor.get(p.color) || {}).tokens || [-1, -1, -1, -1])],
        finishedCount: p.finishedCount,
      })),
      turnColor: (s.players[s.turnIndex] || {}).color || null,
      phase: s.phase,
      dice: s.dice == null ? null : s.dice,
      movableTokens,
      winner: s.winner || null,
    };
  }

  broadcastState(room) {
    this.io.to(room.id).emit('game:state', this.publicState(room));
  }

  /* ---------------- turn loop ---------------- */

  clearTurnTimers(room) {
    room.turnGen += 1;
    if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
    if (room.botTimeout) { clearTimeout(room.botTimeout); room.botTimeout = null; }
  }

  beginTurn(room) {
    if (room.over) return;
    this.clearTurnTimers(room);
    const gen = room.turnGen;
    const player = this.currentPlayer(room);
    if (!player) return;
    this.broadcastState(room);

    let secondsLeft = TURN_SECONDS;
    this.io.to(room.id).emit('game:timer', { secondsLeft });
    room.tickInterval = setInterval(() => {
      if (room.over || gen !== room.turnGen) {
        clearInterval(room.tickInterval);
        room.tickInterval = null;
        return;
      }
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(room.tickInterval);
        room.tickInterval = null;
        this.onTurnTimeout(room, player, gen);
      } else {
        this.io.to(room.id).emit('game:timer', { secondsLeft });
      }
    }, 1000);

    this.maybeScheduleBot(room, player, gen);
  }

  maybeScheduleBot(room, player, gen) {
    if (!player.isBot && !player.disconnected) return;
    room.botTimeout = setTimeout(() => {
      if (room.over || gen !== room.turnGen) return;
      if (this.currentPlayer(room) !== player) return;
      const s = room.state;
      if (s.phase === 'awaitingRoll') {
        this.doRoll(room, player, Engine.rollDice());
        this.afterOp(room);
      } else if (s.phase === 'awaitingMove') {
        const token = this.pickAutoToken(s);
        if (token == null) return;
        this.doMove(room, player, token);
        this.afterOp(room);
      }
    }, botDelayMs());
  }

  onTurnTimeout(room, player, gen) {
    if (room.over || gen !== room.turnGen) return;
    if (this.currentPlayer(room) !== player) return;
    const s = room.state;
    if (s.phase === 'awaitingRoll') {
      // Human timed out on the roll → server auto-rolls.
      this.doRoll(room, player, Engine.rollDice());
      this.afterOp(room);
    } else if (s.phase === 'awaitingMove') {
      // Human timed out on the move → server auto-picks.
      const token = this.pickAutoToken(s);
      if (token == null) return;
      this.doMove(room, player, token);
      this.afterOp(room);
    }
  }

  pickAutoToken(state) {
    try {
      const t = Engine.chooseBotMove(state);
      if (t != null) return t;
    } catch (e) { /* fall through to first legal move */ }
    try {
      const legal = Engine.legalMoves(state);
      return legal.length ? legal[0].token : null;
    } catch (e) {
      return null;
    }
  }

  doRoll(room, player, value) {
    const res = Engine.setRoll(room.state, value);
    room.state = res.state;
    this.io.to(room.id).emit('game:dice', { color: player.color, value });
  }

  doMove(room, player, tokenIndex) {
    const legal = Engine.legalMoves(room.state);
    const mv = legal.find((m) => m.token === tokenIndex);
    if (!mv) throw new Error('illegal move');
    if (mv.finishesToken) player.finishedCount += 1;
    const res = Engine.applyMove(room.state, tokenIndex);
    room.state = res.state;
  }

  afterOp(room) {
    if (room.over) return;
    if (room.state.phase === 'over') {
      this.endGame(room).catch((e) => console.error('[game] endGame failed:', e.message));
      return;
    }
    this.beginTurn(room);
  }

  /* ---------------- player actions ---------------- */

  roomForSocket(socket) {
    const roomId = this.socketRoom.get(socket.id);
    return roomId ? this.rooms.get(roomId) || null : null;
  }

  handleRoll(socket) {
    const room = this.roomForSocket(socket);
    if (!room || room.over) return;
    const player = this.currentPlayer(room);
    if (!player || player.isBot || player.userId !== socket.user.id) {
      socket.emit('error', { message: 'not your turn' });
      return;
    }
    if (room.state.phase !== 'awaitingRoll') {
      socket.emit('error', { message: 'not awaiting roll' });
      return;
    }
    try {
      this.doRoll(room, player, Engine.rollDice());
    } catch (e) {
      socket.emit('error', { message: 'roll failed' });
      return;
    }
    this.afterOp(room);
  }

  handleMove(socket, tokenIndex) {
    const room = this.roomForSocket(socket);
    if (!room || room.over) return;
    const player = this.currentPlayer(room);
    if (!player || player.isBot || player.userId !== socket.user.id) {
      socket.emit('error', { message: 'not your turn' });
      return;
    }
    if (room.state.phase !== 'awaitingMove') {
      socket.emit('error', { message: 'not awaiting move' });
      return;
    }
    if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 3) {
      socket.emit('error', { message: 'invalid token' });
      return;
    }
    try {
      this.doMove(room, player, tokenIndex);
    } catch (e) {
      socket.emit('error', { message: 'illegal move' });
      return;
    }
    this.afterOp(room);
  }

  handleDisconnect(socket) {
    this.leaveQueue(socket);
    const userId = socket.user && socket.user.id;
    const room = this.roomForSocket(socket);
    this.socketRoom.delete(socket.id);
    if (!room || room.over || !userId) return;
    const player = room.players.find((p) => !p.isBot && p.userId === userId);
    if (!player || player.disconnected) return;
    // Convert their turns to bot control immediately; the game continues and
    // they are still credited (coins/stats) if their side wins.
    player.disconnected = true;
    console.log(`[game] ${player.name} disconnected mid-game — bot takes over their turns`);
    if (this.currentPlayer(room) === player) {
      this.beginTurn(room); // restarts the timer and schedules the bot action
    }
  }

  /* ---------------- game over ---------------- */

  async endGame(room) {
    if (room.over) return;
    room.over = true;
    this.clearTurnTimers(room);

    // Tournament games: no normal payout (prizes come from the tournament),
    // no entry ledger (already collected at join). The winner is reported
    // back to the TournamentManager instead.
    const isTourney = !!room.tournamentMatchId;
    const isPrivate = !!room.privateRoomId;
    // Private rooms: entries were collected at join time; the PrivateRooms
    // manager pays the winner (pool minus commission) via its own hook.
    const noPayout = isTourney || isPrivate;
    const winnerColor = room.state.winner || null;
    const win = noPayout ? 0 : await this.winFor(room.mode, room.entry);
    const rankings = [...room.players]
      .sort((a, b) => b.finishedCount - a.finishedCount)
      .map((p) => ({ color: p.color, name: p.name, isBot: p.isBot, score: p.finishedCount }));

    const humans = room.players.filter((p) => !p.isBot);
    const winnerHuman = humans.find((p) => p.color === winnerColor) || null;

    try {
      await this.db.recordGame({
        mode: room.mode,
        entry: room.entry,
        winnerId: winnerHuman ? winnerHuman.userId : null,
        playerIds: humans.map((p) => p.userId),
      });
    } catch (e) {
      console.error('[game] recordGame failed:', e.message);
    }

    for (const p of humans) {
      const won = !!winnerHuman && winnerHuman.userId === p.userId;
      let balance = null;
      try {
        if (won && !noPayout) {
          balance = await this.db.addCoins(p.userId, win); // pay the win amount
          await this.db.recordLedger(p.userId, win, 'win', room.id);
        } else {
          const u = await this.db.getUserById(p.userId);
          balance = u ? u.coins : null;
        }
        await this.db.incrementStats(p.userId, {
          played: 1,
          won: won ? 1 : 0,
          mode: room.mode,
          earned: won ? win : 0,
        });
      } catch (e) {
        console.error('[game] payout/stats failed:', e.message);
      }
      const sock = this.io.sockets.sockets.get(p.socketId);
      if (sock) {
        // coinDelta is the net wallet change from this game:
        // winner → win - entry (entry was deducted at start), loser → -entry.
        // Tournament/private games move no coins here: prizes are paid by
        // the tournament / private-room manager after game over.
        sock.emit('game:over', {
          rankings,
          coinDelta: noPayout ? 0 : (won ? win - room.entry : -room.entry),
          winnerColor,
        });
        if (balance != null) sock.emit('wallet:update', { coins: balance });
      }
      this.socketRoom.delete(p.socketId);
    }

    this.rooms.delete(room.id);
    console.log(`[game] room ${room.id} over — winner: ${winnerColor}`);

    // Tournament hookup: the winner auto-advances in the bracket.
    if (isTourney && typeof this.tournamentHook === 'function') {
      try {
        await this.tournamentHook(room.tournamentMatchId, winnerHuman ? winnerHuman.userId : null);
      } catch (e) {
        console.error('[game] tournament hook failed:', e.message);
      }
    }
    // Private-room hookup: the winner is paid pool-minus-commission.
    if (isPrivate && typeof this.privateHook === 'function') {
      try {
        await this.privateHook(room.privateRoomId, winnerHuman ? winnerHuman.userId : null);
      } catch (e) {
        console.error('[game] private-room hook failed:', e.message);
      }
    }
  }
}

module.exports = GameManager;
module.exports.ENTRIES = DEFAULT_ENTRIES; // legacy export; tiers now come from app_config
module.exports.MODES = MODES;
module.exports.winAmount = winAmount;

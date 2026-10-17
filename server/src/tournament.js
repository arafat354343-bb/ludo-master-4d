'use strict';

/**
 * TournamentManager — single-elimination 1v1 tournaments, fully automatic.
 *
 * VIRTUAL COINS ONLY. Entry fees and prizes are virtual coins with no cash
 * value. There is no cash-out, no withdraw-to-money, no payment feature.
 *
 * Flow: admin creates → users join (entry deducted at JOIN) → bracket
 * auto-generates at starts_at (or admin force-start) → players play real 1v1
 * Ludo games via GameManager (no double entry, no normal payout) → winners
 * auto-advance from game results → prizes auto-credited.
 *
 * Wiring (in src/index.js):
 *   const tournaments = new TournamentManager(io, db, games);
 *   games.tournamentHook = (matchId, winnerId) => tournaments.onMatchComplete(matchId, winnerId);
 *   games.tournamentManager = tournaments;   // lets joinQueue block double-play
 *   tournaments.startScheduler();
 */

const notify = require('./notify'); // singleton, initialized in src/index.js

function terr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function nextPow2(n) {
  if (n <= 2) return 2;
  if (n <= 4) return 4;
  if (n <= 8) return 8;
  if (n <= 16) return 16;
  return 32;
}

class TournamentManager {
  constructor(io, db, games) {
    this.io = io;
    this.db = db;
    this.games = games;
    // Ready-match → walkover if no game started within this window.
    // Overridable in tests (tournaments.walkoverMs = 50).
    this.walkoverMs = 10 * 60 * 1000;
    this.schedulerStarted = false;
  }

  /* ---------------- admin: create / start / cancel ---------------- */

  async createTournament({ name, entryFee, maxPlayers, prize1st, prize2nd, prize3rd, startsAt, adminId }) {
    name = String(name || '').trim().slice(0, 60);
    if (name.length < 3) throw terr(400, 'name must be at least 3 characters');
    entryFee = Number(entryFee);
    if (!Number.isInteger(entryFee) || entryFee <= 0) throw terr(400, 'entryFee must be a positive integer');
    maxPlayers = Number(maxPlayers);
    if (![4, 8, 16, 32].includes(maxPlayers)) throw terr(400, 'maxPlayers must be 4, 8, 16 or 32');
    const prizes = {};
    for (const [k, v] of [['prize1st', prize1st], ['prize2nd', prize2nd], ['prize3rd', prize3rd]]) {
      const n = Number(v || 0);
      if (!Number.isInteger(n) || n < 0) throw terr(400, k + ' must be a non-negative integer');
      prizes[k] = n;
    }
    const prizeSum = prizes.prize1st + prizes.prize2nd + prizes.prize3rd;
    if (prizeSum > maxPlayers * entryFee) {
      throw terr(400, `prizes (${prizeSum}) exceed max pool (${maxPlayers * entryFee}) — the house must never lose`);
    }
    let startsAtIso = null;
    if (startsAt) {
      const d = new Date(startsAt);
      if (Number.isNaN(d.getTime())) throw terr(400, 'startsAt must be a valid date');
      startsAtIso = d.toISOString();
    }
    return this.db.createTournamentRow({
      name, entryFee, maxPlayers,
      prize1st: prizes.prize1st, prize2nd: prizes.prize2nd, prize3rd: prizes.prize3rd,
      startsAt: startsAtIso, adminId: adminId || null,
    });
  }

  async forceStart(tournamentId) {
    const t = await this.db.getTournamentRow(tournamentId);
    if (!t) throw terr(404, 'tournament not found');
    if (t.status !== 'upcoming' && t.status !== 'filling') throw terr(400, 'tournament cannot be started');
    const n = await this.db.countTournamentPlayers(tournamentId);
    if (n < 2) throw terr(400, 'need at least 2 players to start');
    await this.generateBracket(t.id);
    return this.getDetail(t.id, null);
  }

  async cancelTournament(tournamentId) {
    const t = await this.db.getTournamentRow(tournamentId);
    if (!t) throw terr(404, 'tournament not found');
    if (t.status !== 'upcoming' && t.status !== 'filling') {
      throw terr(400, 'only upcoming tournaments can be cancelled');
    }
    const players = await this.db.getTournamentPlayers(t.id);
    for (const p of players) {
      await this.db.addCoins(p.user_id, t.entry_fee);
      await this.db.recordLedger(p.user_id, t.entry_fee, 'tournament_refund', t.id);
    }
    await this.db.setTournamentStatus(t.id, 'cancelled');
    this.notifyTournament(t.id, 'Tournament cancelled — entry fees refunded.');
    return { cancelled: true, refunded: players.length };
  }

  /* ---------------- player: join / ready ---------------- */

  async joinTournament(tournamentId, userId) {
    const t = await this.db.getTournamentRow(tournamentId);
    if (!t) throw terr(404, 'tournament not found');
    if (t.status !== 'upcoming' && t.status !== 'filling') {
      throw terr(400, 'this tournament is not open for joining');
    }
    const user = await this.db.getUserById(userId);
    if (!user) throw terr(404, 'user not found');
    if (user.banned) throw terr(403, 'banned users cannot join tournaments');
    if (await this.db.hasJoinedTournament(tournamentId, userId)) {
      throw terr(400, 'you have already joined this tournament');
    }
    const count = await this.db.countTournamentPlayers(tournamentId);
    if (count >= t.max_players) throw terr(400, 'tournament is full');
    if (user.coins < t.entry_fee) throw terr(400, 'not enough coins for the entry fee');
    // Entry is deducted at JOIN time, never again.
    await this.db.addCoins(userId, -t.entry_fee);
    await this.db.recordLedger(userId, -t.entry_fee, 'tournament_entry', t.id);
    await this.db.addTournamentPlayer(tournamentId, userId);
    const now = await this.db.countTournamentPlayers(tournamentId);
    if (now >= t.max_players) await this.db.setTournamentStatus(tournamentId, 'filling');
    return { joined: true, players: now, maxPlayers: t.max_players };
  }

  /** Mark the caller ready for their current 'ready' match (feeds walkover logic). */
  async markReady(tournamentId, userId) {
    const matches = await this.db.getTournamentMatches(tournamentId);
    const m = matches.find((x) => x.status === 'ready'
      && (x.player1_id === userId || x.player2_id === userId));
    if (!m) throw terr(400, 'you have no upcoming match in this tournament');
    await this.db.markTournamentPlayerReady(m.id, userId);
    return { ready: true, matchId: m.id };
  }

  /* ---------------- bracket ---------------- */

  /** Build round 1 (with byes for non-power-of-2 fields) and flip status to ongoing. */
  async generateBracket(tournamentId) {
    // Atomic transition: only one caller (scheduler or admin) wins the race.
    const won = await this.db.tryBeginTournament(tournamentId);
    if (!won) return;
    const t = await this.db.getTournamentRow(tournamentId);
    const players = await this.db.getTournamentPlayers(t.id); // join order
    const n = players.length;
    const size = nextPow2(n);
    const byes = size - n;
    let matchNo = 1;
    // Byes: earliest joiners get a walkover straight into round 2.
    const byeAdvancers = [];
    for (let i = 0; i < byes; i++) {
      const m = await this.db.createTournamentMatch({
        tournamentId: t.id, round: 1, matchNo: matchNo++,
        player1Id: players[i].user_id, player2Id: null,
        status: 'walkover', winnerId: players[i].user_id,
      });
      byeAdvancers.push({ playerId: players[i].user_id, matchNo: m.match_no });
    }
    // Real round-1 matches, seeded by join order.
    const rest = players.slice(byes);
    const round1Pairs = [];
    for (let i = 0; i < rest.length; i += 2) {
      await this.db.createTournamentMatch({
        tournamentId: t.id, round: 1, matchNo: matchNo++,
        player1Id: rest[i].user_id, player2Id: rest[i + 1].user_id, status: 'ready',
      });
      round1Pairs.push(rest[i].user_id, rest[i + 1].user_id);
    }
    for (const b of byeAdvancers) {
      await this.advanceWinner(
        { tournament_id: t.id, round: 1, match_no: b.matchNo, player1_id: b.playerId, player2_id: null },
        b.playerId
      );
    }
    this.notifyTournament(t.id, 'Tournament started! Check your first match and tap Play.');
    // Telegram: every round-1 player gets a "match ready" push (no-op without token).
    notify.notifyMany(round1Pairs, '⚔️ Your tournament match is ready — open the app and tap Play!');
    console.log(`[tournament] ${t.id} started — ${n} players, ${byes} byes`);
  }

  totalRounds(playerCount) {
    return Math.log2(nextPow2(playerCount));
  }

  /** Move a winner into the next round (create the match or fill its empty slot). */
  async advanceWinner(match, winnerId) {
    const t = await this.db.getTournamentRow(match.tournament_id);
    if (!t || t.status !== 'ongoing') return;
    const n = await this.db.countTournamentPlayers(t.id);
    const rounds = this.totalRounds(n);
    if (match.round >= rounds) return; // final is handled by resolveMatch
    const nextNo = Math.ceil(match.match_no / 2);
    const existing = (await this.db.getTournamentMatches(t.id))
      .find((m) => m.round === match.round + 1 && m.match_no === nextNo);
    if (existing) {
      await this.db.fillTournamentMatchSlot(existing.id, winnerId);
      const upd = await this.db.getTournamentMatch(existing.id);
      if (upd && upd.status === 'ready') {
        this.notifyPlayers(t.id, [upd.player1_id, upd.player2_id],
          { tournamentId: t.id, event: 'match_ready', matchId: upd.id });
        // Telegram: next-round match is ready for both players.
        notify.notifyMany([upd.player1_id, upd.player2_id],
          '⚔️ Your tournament match is ready — open the app and tap Play!');
      }
    } else {
      await this.db.createTournamentMatch({
        tournamentId: t.id, round: match.round + 1, matchNo: nextNo,
        player1Id: winnerId, player2Id: null, status: 'pending',
      });
    }
  }

  /**
   * Resolve a match from a real game result (or a walkover). Idempotent:
   * already-resolved matches are ignored so a duplicate game-over can't
   * double-advance anyone.
   */
  async resolveMatch(matchId, winnerUserId, via) {
    const match = await this.db.getTournamentMatch(matchId);
    if (!match || match.status === 'completed' || match.status === 'walkover') return null;
    const t = await this.db.getTournamentRow(match.tournament_id);
    if (!t || t.status !== 'ongoing') return null;

    let winner = winnerUserId;
    if (!winner || (winner !== match.player1_id && winner !== match.player2_id)) {
      // Defensive: no usable winner reported — earlier joiner advances.
      const players = await this.db.getTournamentPlayers(t.id);
      const order = new Map(players.map((p, i) => [p.user_id, i]));
      const cands = [match.player1_id, match.player2_id].filter(Boolean)
        .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
      winner = cands[0] || null;
      if (!winner) return null;
    }

    await this.db.setTournamentMatch(matchId, {
      status: via === 'walkover' ? 'walkover' : 'completed',
      winner_id: winner,
    });

    const n = await this.db.countTournamentPlayers(t.id);
    const rounds = this.totalRounds(n);
    const loser = winner === match.player1_id ? match.player2_id : match.player1_id;
    if (loser) {
      const pos = match.round >= rounds ? 2 : (match.round === rounds - 1 ? 3 : null);
      await this.db.setPlayerEliminated(t.id, loser, pos);
    }

    if (match.round >= rounds) {
      await this.finishTournament(t, winner);
    } else {
      await this.advanceWinner({ ...match, status: 'completed' }, winner);
    }
    this.notifyPlayers(t.id, [winner, loser].filter(Boolean),
      { tournamentId: t.id, event: via === 'walkover' ? 'walkover' : 'match_done', matchId });
    return winner;
  }

  /** Called by GameManager when a tournament room's game ends. */
  async onMatchComplete(matchId, winnerUserId) {
    try {
      await this.resolveMatch(matchId, winnerUserId, 'completed');
    } catch (e) {
      console.error('[tournament] onMatchComplete failed:', e.message);
    }
  }

  async finishTournament(t, championId) {
    const players = await this.db.getTournamentPlayers(t.id);
    await this.db.setPlayerPosition(t.id, championId, 1);
    const pay = async (userId, amount) => {
      if (!userId || amount <= 0) return;
      await this.db.addCoins(userId, amount);
      await this.db.recordLedger(userId, amount, 'tournament_win', t.id);
    };
    await pay(championId, t.prize_1st);
    // Runner-up = the other finalist (final_position 2 was set at resolve time).
    const runnerUp = players.find((p) => p.final_position === 2);
    await pay(runnerUp && runnerUp.user_id, t.prize_2nd);
    // 3rd place is shared by the semifinal losers (if any prize).
    const thirds = players.filter((p) => p.final_position === 3);
    if (thirds.length > 0 && t.prize_3rd > 0) {
      const share = Math.floor(t.prize_3rd / thirds.length);
      for (const p of thirds) await pay(p.user_id, share);
    }
    await this.db.setTournamentStatus(t.id, 'completed');
    this.notifyTournament(t.id, `Tournament complete! Champion: ${(players.find((p) => p.user_id === championId) || {}).name || '—'}`);
    console.log(`[tournament] ${t.id} completed — champion ${championId}`);
  }

  /* ---------------- match play (socket) ---------------- */

  /**
   * A player taps "Play My Match": validate, claim the match atomically,
   * and launch a real 1v1 room with NO entry deduction and NO normal payout.
   */
  async playMatch(socket, matchId) {
    const match = await this.db.getTournamentMatch(matchId);
    if (!match) throw terr(404, 'match not found');
    const t = await this.db.getTournamentRow(match.tournament_id);
    if (!t || t.status !== 'ongoing') throw terr(400, 'tournament is not running');
    const uid = socket.user.id;
    if (uid !== match.player1_id && uid !== match.player2_id) throw terr(403, 'this is not your match');

    const claimed = await this.db.claimTournamentMatch(matchId);
    if (!claimed) throw terr(400, 'match already started or finished');
    await this.db.markTournamentPlayerReady(matchId, uid);

    const oppId = uid === match.player1_id ? match.player2_id : match.player1_id;
    let oppSocket = null;
    for (const [, s] of this.io.sockets.sockets) {
      if (s.user && s.user.id === oppId && !s.banned) { oppSocket = s; break; }
    }
    if (!oppSocket) {
      // Opponent offline: release the claim so the player can retry, and
      // nudge the opponent. The ready-mark counts toward walkover logic.
      await this.db.setTournamentMatch(matchId, { status: 'ready' });
      this.io.to('user:' + oppId).emit('tournament:update', { tournamentId: t.id });
      throw terr(400, 'opponent is not online right now — try again shortly');
    }

    const humans = [
      { userId: uid, name: socket.user.name, socketId: socket.id, isBot: false, disconnected: false, finishedCount: 0 },
      { userId: oppId, name: oppSocket.user.name, socketId: oppSocket.id, isBot: false, disconnected: false, finishedCount: 0 },
    ];
    const room = await this.games.startRoom(humans, '2p', t.entry_fee, { tournamentMatchId: matchId });
    if (!room) {
      await this.db.setTournamentMatch(matchId, { status: 'ready' });
      throw terr(500, 'could not start the game');
    }
    await this.db.setTournamentMatch(matchId, { game_room_id: room.id });
    return { roomId: room.id };
  }

  /** True when the user has a live ('ready'/'ongoing') tournament match — blocks queues. */
  async userHasActiveMatch(userId) {
    return !!(await this.db.getActiveTournamentMatchForUser(userId));
  }

  /* ---------------- scheduler ---------------- */

  startScheduler() {
    if (this.schedulerStarted) return;
    this.schedulerStarted = true;
    const tick = async () => {
      try { await this.checkStarts(); } catch (e) { console.error('[tournament] checkStarts:', e.message); }
      try { await this.checkWalkovers(); } catch (e) { console.error('[tournament] checkWalkovers:', e.message); }
    };
    setInterval(tick, 30_000);
    // Run once shortly after boot so a restart picks up due tournaments.
    setTimeout(tick, 5_000);
  }

  /** Start tournaments whose starts_at has passed; refund+cancel empty ones. */
  async checkStarts() {
    const now = Date.now();
    const rows = await this.db.listTournamentRows();
    for (const t of rows) {
      if ((t.status !== 'upcoming' && t.status !== 'filling') || !t.starts_at) continue;
      if (new Date(t.starts_at).getTime() > now) continue;
      try {
        const n = await this.db.countTournamentPlayers(t.id);
        if (n >= 2) {
          await this.generateBracket(t.id);
        } else {
          // Not enough players: cancel and refund whatever was collected.
          const players = await this.db.getTournamentPlayers(t.id);
          for (const p of players) {
            await this.db.addCoins(p.user_id, t.entry_fee);
            await this.db.recordLedger(p.user_id, t.entry_fee, 'tournament_refund', t.id);
          }
          await this.db.setTournamentStatus(t.id, 'cancelled');
          console.log(`[tournament] ${t.id} cancelled (only ${n} players) — refunded`);
        }
      } catch (e) {
        console.error(`[tournament] auto-start ${t.id} failed:`, e.message);
      }
    }
  }

  /** 'ready' matches idle too long → walkover to whoever showed up (or earlier joiner). */
  async checkWalkovers() {
    const cutoff = Date.now() - this.walkoverMs;
    const rows = await this.db.listTournamentRows();
    for (const t of rows) {
      if (t.status !== 'ongoing') continue;
      const matches = await this.db.getTournamentMatches(t.id);
      for (const m of matches) {
        if (m.status !== 'ready' || !m.player1_id || !m.player2_id) continue;
        if (!m.ready_at || new Date(m.ready_at).getTime() > cutoff) continue;
        try {
          await this.resolveWalkover(t, m);
        } catch (e) {
          console.error(`[tournament] walkover ${m.id} failed:`, e.message);
        }
      }
    }
  }

  async resolveWalkover(t, m) {
    let winner = null;
    let presentPlayer = null; // the one who showed up while the opponent no-showed
    if (m.p1_ready_at && !m.p2_ready_at) { winner = m.player1_id; presentPlayer = m.player1_id; }
    else if (m.p2_ready_at && !m.p1_ready_at) { winner = m.player2_id; presentPlayer = m.player2_id; }
    else {
      const players = await this.db.getTournamentPlayers(t.id);
      const order = new Map(players.map((p, i) => [p.user_id, i]));
      winner = [m.player1_id, m.player2_id]
        .sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99))[0];
    }
    // No-show refund: exactly one player joined within the window → refund their
    // entry fee (they still advance by walkover so the bracket keeps moving).
    if (presentPlayer) {
      await this.db.addCoins(presentPlayer, t.entry_fee);
      await this.db.recordLedger(presentPlayer, t.entry_fee, 'tournament_refund', t.id);
      console.log(`[tournament] walkover ${m.id}: refunded entry to ${presentPlayer} (opponent no-show)`);
    }
    console.log(`[tournament] walkover ${m.id} → ${winner}`);
    await this.resolveMatch(m.id, winner, 'walkover');
  }

  /* ---------------- read models ---------------- */

  async getDetail(tournamentId, userId) {
    const t = await this.db.getTournamentRow(tournamentId);
    if (!t) throw terr(404, 'tournament not found');
    const [players, matches] = await Promise.all([
      this.db.getTournamentPlayers(t.id),
      this.db.getTournamentMatches(t.id),
    ]);
    const nameOf = (id) => {
      if (!id) return null;
      const p = players.find((x) => x.user_id === id);
      return p ? p.name : 'Player';
    };
    let myMatch = null;
    if (userId) {
      const m = matches.find((x) => x.status === 'ready'
        && (x.player1_id === userId || x.player2_id === userId));
      if (m) {
        const oppId = m.player1_id === userId ? m.player2_id : m.player1_id;
        myMatch = {
          matchId: m.id, round: m.round, matchNo: m.match_no,
          opponent: oppId ? { id: oppId, name: nameOf(oppId) } : null,
          readyAt: m.ready_at || null,
        };
      }
    }
    return {
      tournament: {
        id: t.id, name: t.name, entryFee: t.entry_fee, maxPlayers: t.max_players,
        prize1st: t.prize_1st, prize2nd: t.prize_2nd, prize3rd: t.prize_3rd,
        status: t.status, startsAt: t.starts_at, createdAt: t.created_at,
        playerCount: players.length,
        prizePool: t.prize_1st + t.prize_2nd + t.prize_3rd,
        joined: userId ? players.some((p) => p.user_id === userId) : false,
      },
      players: players.map((p) => ({
        id: p.user_id, name: p.name, eliminated: p.eliminated,
        finalPosition: p.final_position, joinedAt: p.joined_at,
      })),
      matches: matches.map((m) => ({
        id: m.id, round: m.round, matchNo: m.match_no, status: m.status,
        player1: m.player1_id ? { id: m.player1_id, name: nameOf(m.player1_id) } : null,
        player2: m.player2_id ? { id: m.player2_id, name: nameOf(m.player2_id) } : null,
        winnerId: m.winner_id,
      })),
      myMatch,
    };
  }

  /* ---------------- notifications ---------------- */

  notifyTournament(tournamentId, text) {
    this.io.emit('tournament:update', { tournamentId, text });
  }

  notifyPlayers(tournamentId, userIds, payload) {
    for (const id of (userIds || []).filter(Boolean)) {
      this.io.to('user:' + id).emit('tournament:update', { tournamentId, ...payload });
    }
  }
}

module.exports = TournamentManager;

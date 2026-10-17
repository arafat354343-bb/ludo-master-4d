'use strict';

/**
 * Storage abstraction.
 *
 * - If process.env.DATABASE_URL is set → PostgreSQL via pg (migrations.sql).
 * - Otherwise → transparent in-memory fallback (Maps). Data is lost on restart.
 *
 * The rest of the codebase must not know which backend is active.
 *
 * VIRTUAL COINS ONLY. Coins have no cash value and cannot be withdrawn.
 */

const { randomUUID, randomInt } = require('crypto');
const path = require('path');
const fs = require('fs');

const USE_PG = !!process.env.DATABASE_URL;
const STARTING_COINS = 5410;
const DAILY_BONUS_COINS = 500;

/* ---------------- app_config defaults ---------------- */

const DEFAULT_ROOMS = {
  twoPlayer: [40, 50, 60, 80, 300].map((entry) => ({ entry, win: Math.round(entry * 1.6), enabled: true })),
  fourPlayer: [40, 50, 60, 80, 300].map((entry) => ({ entry, win: Math.round(entry * 3.2), enabled: true })),
};
const DEFAULT_ECONOMY = { signupBonus: 5410, dailyBonus: 500, referralBonus: 200 };
const DEFAULT_MATCHMAKING = { twoPlayerWaitSec: 8, fourPlayerWaitSec: 8 };
const DEFAULT_COIN_PACKS = [1000, 5000, 20000];

// In-memory config store (seeded with defaults; PostgreSQL uses app_config).
const memConfig = new Map([
  ['rooms', JSON.parse(JSON.stringify(DEFAULT_ROOMS))],
  ['economy', { ...DEFAULT_ECONOMY }],
  ['matchmaking', { ...DEFAULT_MATCHMAKING }],
  ['coin_packs', [...DEFAULT_COIN_PACKS]],
  ['custom_options', []],
]);

function deepCopy(v) { return JSON.parse(JSON.stringify(v)); }

async function getConfig(key) {
  if (USE_PG) {
    const r = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
    return r.rows[0] ? r.rows[0].value : null;
  }
  const v = memConfig.get(key);
  return v === undefined ? null : deepCopy(v);
}

async function setConfig(key, value) {
  if (USE_PG) {
    await pool.query(
      `INSERT INTO app_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)]
    );
    return;
  }
  memConfig.set(key, deepCopy(value));
}

/** Stored rooms config is authoritative; defaults fill in only when missing/empty. */
function sanitizeRooms(raw) {
  if (!raw || typeof raw !== 'object') return deepCopy(DEFAULT_ROOMS);
  const out = {};
  for (const mode of ['twoPlayer', 'fourPlayer']) {
    const mult = mode === 'twoPlayer' ? 1.6 : 3.2;
    const arr = Array.isArray(raw[mode]) ? raw[mode] : DEFAULT_ROOMS[mode];
    const seen = new Set();
    const list = [];
    for (const r of arr) {
      const entry = Number(r && r.entry);
      if (!Number.isInteger(entry) || entry <= 0 || seen.has(entry)) continue;
      seen.add(entry);
      const win = Number(r.win);
      list.push({
        entry,
        win: Number.isFinite(win) && win >= 0 ? Math.round(win) : Math.round(entry * mult),
        enabled: !r || r.enabled !== false,
      });
    }
    out[mode] = list.length ? list : deepCopy(DEFAULT_ROOMS[mode]);
  }
  return out;
}

async function getRoomsConfig() {
  return sanitizeRooms(await getConfig('rooms'));
}

function sanitizeEconomy(raw) {
  const out = { ...DEFAULT_ECONOMY };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(out)) {
      const v = Number(raw[k]);
      if (Number.isInteger(v) && v >= 0) out[k] = v;
    }
  }
  return out;
}

async function getEconomy() {
  return sanitizeEconomy(await getConfig('economy'));
}

/** Coin packs shown on the wallet Buy tab (admin-editable). */
function sanitizeCoinPacks(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_COIN_PACKS];
  const out = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 1000000);
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : [...DEFAULT_COIN_PACKS];
}

async function getCoinPacks() {
  return sanitizeCoinPacks(await getConfig('coin_packs'));
}

/** How long a queue waits for humans before bots fill the empty seats. */
function sanitizeMatchmaking(raw) {
  const out = { ...DEFAULT_MATCHMAKING };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(out)) {
      const v = Number(raw[k]);
      if (Number.isInteger(v) && v >= 2 && v <= 300) out[k] = v;
    }
  }
  return out;
}

async function getMatchmaking() {
  return sanitizeMatchmaking(await getConfig('matchmaking'));
}

/* ---------------- wallet: transaction history ---------------- */

async function getLedger(userId, limit = 50, offset = 0) {
  limit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  if (USE_PG) {
    const r = await pool.query(
      `SELECT id, amount, kind, ref_id, created_at FROM coin_ledger
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
    return r.rows;
  }
  return memLedger
    .filter((e) => e.user_id === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(offset, offset + limit)
    .map((e) => ({ id: e.id, amount: e.amount, kind: e.kind, ref_id: e.ref_id, created_at: e.created_at }));
}

/* ---------------- coin requests (user asks, admin approves) ---------------- */

const memCoinRequests = []; // {id, user_id, pack_coins, payment_method, transaction_id, status, created_at, decided_at, decided_by}

async function createCoinRequest(userId, packCoins, paymentMethod, transactionId) {
  const pack = Number(packCoins);
  const validPacks = await getCoinPacks();
  if (!validPacks.includes(pack)) throw Object.assign(new Error('Invalid pack'), { status: 400 });
  const pm = String(paymentMethod || '').trim().slice(0, 30);
  const txid = String(transactionId || '').trim().slice(0, 50);
  if (!pm) throw Object.assign(new Error('Payment method is required'), { status: 400 });
  if (!txid) throw Object.assign(new Error('Transaction ID is required'), { status: 400 });
  if (USE_PG) {
    const pending = await pool.query(
      "SELECT COUNT(*)::int AS c FROM coin_requests WHERE user_id = $1 AND status = 'pending'", [userId]);
    if (pending.rows[0].c >= 5) throw Object.assign(new Error('Too many pending requests'), { status: 400 });
    const r = await pool.query(
      `INSERT INTO coin_requests (id, user_id, pack_coins, payment_method, transaction_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), userId, pack, pm, txid]);
    return r.rows[0];
  }
  const pending = memCoinRequests.filter((r) => r.user_id === userId && r.status === 'pending').length;
  if (pending >= 5) throw Object.assign(new Error('Too many pending requests'), { status: 400 });
  const row = { id: randomUUID(), user_id: userId, pack_coins: pack, payment_method: pm, transaction_id: txid, status: 'pending', created_at: new Date().toISOString(), decided_at: null, decided_by: null };
  memCoinRequests.push(row);
  return { ...row };
}

async function listUserCoinRequests(userId) {
  if (USE_PG) {
    const r = await pool.query(
      'SELECT * FROM coin_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
    return r.rows;
  }
  return memCoinRequests
    .filter((r) => r.user_id === userId)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 20).map((r) => ({ ...r }));
}

async function listCoinRequests(status = 'pending') {
  const s = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
  if (USE_PG) {
    const r = await pool.query(
      `SELECT cr.*, u.name AS user_name, u.email AS user_email FROM coin_requests cr
       JOIN users u ON u.id = cr.user_id
       WHERE cr.status = $1 ORDER BY cr.created_at DESC LIMIT 100`, [s]);
    return r.rows;
  }
  return memCoinRequests
    .filter((r) => r.status === s)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 100)
    .map((r) => {
      const u = memUsers.get(r.user_id) || {};
      return { ...r, user_name: u.name, user_email: u.email };
    });
}

async function decideCoinRequest(id, approve, adminId) {
  const grant = async (userId, pack) => {
    await addCoins(userId, pack);
    await recordLedger(userId, pack, 'admin_grant', 'request:' + id);
  };
  if (USE_PG) {
    const r = await pool.query("SELECT * FROM coin_requests WHERE id = $1 AND status = 'pending'", [id]);
    if (!r.rows.length) throw Object.assign(new Error('Request not found or already decided'), { status: 404 });
    const row = r.rows[0];
    await pool.query(
      "UPDATE coin_requests SET status = $1, decided_at = now(), decided_by = $2 WHERE id = $3",
      [approve ? 'approved' : 'rejected', adminId, id]);
    if (approve) await grant(row.user_id, row.pack_coins);
    return { ...row, status: approve ? 'approved' : 'rejected' };
  }
  const row = memCoinRequests.find((r) => r.id === id && r.status === 'pending');
  if (!row) throw Object.assign(new Error('Request not found or already decided'), { status: 404 });
  row.status = approve ? 'approved' : 'rejected';
  row.decided_at = new Date().toISOString();
  row.decided_by = adminId;
  if (approve) await grant(row.user_id, row.pack_coins);
  return { ...row };
}

/* ---------------- custom options (admin-managed home buttons) ---------------- */

function sanitizeCustomOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw.slice(0, 12)) {
    const title = String((o && o.title) || '').trim().slice(0, 40);
    const url = String((o && o.url) || '').trim().slice(0, 300);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ id: String(o.id || randomUUID()), title, url, enabled: o.enabled !== false });
  }
  return out;
}

async function getCustomOptions() {
  return sanitizeCustomOptions(await getConfig('custom_options'));
}

async function setCustomOptions(list) {
  const clean = sanitizeCustomOptions(list);
  await setConfig('custom_options', clean);
  return clean;
}
/* ---------------- coin ledger (analytics) ----------------
 * Every virtual-coin movement is recorded here. Kinds:
 *   signup_bonus | daily_bonus | referral_bonus | entry_fee | win | admin_grant
 * amount is signed (+credit / -debit). This function NEVER throws: a failed
 * ledger write is logged and the original coin operation is unaffected.
 */
async function recordLedger(userId, amount, kind, refId = null) {
  try {
    if (USE_PG) {
      await pool.query(
        'INSERT INTO coin_ledger (id, user_id, amount, kind, ref_id) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), userId || null, amount, kind, refId]
      );
      return;
    }
    memLedger.push({
      id: randomUUID(),
      user_id: userId || null,
      amount,
      kind,
      ref_id: refId,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[ledger] write failed (operation unaffected):', e.message);
  }
}

/** Analytics rollup for the last `days` days (admin dashboard). */
async function getAnalytics(days) {
  const n = Math.min(90, Math.max(1, Math.floor(Number(days) || 30)));
  const series = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    series.push(d.toISOString().slice(0, 10));
  }
  const byDate = {};
  for (const d of series) {
    byDate[d] = { date: d, games: 0, newUsers: 0, entryCollected: 0, winPaid: 0, bonusGranted: 0 };
  }

  if (USE_PG) {
    const since = series[0];
    const g = await pool.query(
      `SELECT to_char(played_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, COUNT(*)::int AS c
         FROM games WHERE played_at >= ($1 || 'T00:00:00Z')::timestamptz GROUP BY d`, [since]);
    for (const r of g.rows) if (byDate[r.d]) byDate[r.d].games = r.c;
    const u = await pool.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, COUNT(*)::int AS c
         FROM users WHERE created_at >= ($1 || 'T00:00:00Z')::timestamptz GROUP BY d`, [since]);
    for (const r of u.rows) if (byDate[r.d]) byDate[r.d].newUsers = r.c;
    const l = await pool.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d, kind,
              COALESCE(SUM(amount), 0)::bigint AS s
         FROM coin_ledger WHERE created_at >= ($1 || 'T00:00:00Z')::timestamptz
         GROUP BY d, kind`, [since]);
    for (const r of l.rows) applyLedgerRow(byDate, r.d, r.kind, Number(r.s));
  } else {
    for (const g of memGames) {
      const d = String(g.played_at || '').slice(0, 10);
      if (byDate[d]) byDate[d].games++;
    }
    for (const u of memUsers.values()) {
      const d = String(u.created_at || '').slice(0, 10);
      if (byDate[d]) byDate[d].newUsers++;
    }
    for (const e of memLedger) {
      applyLedgerRow(byDate, String(e.created_at || '').slice(0, 10), e.kind, Number(e.amount) || 0);
    }
  }

  const dayList = series.map((d) => {
    const r = byDate[d];
    r.rake = r.entryCollected - r.winPaid;
    return r;
  });

  // Cumulative coins in circulation, anchored so the last day == current total.
  let netAfter = 0;
  const netByDay = {};
  if (USE_PG) {
    const r = await pool.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d,
              COALESCE(SUM(amount), 0)::bigint AS s
         FROM coin_ledger GROUP BY d`);
    for (const row of r.rows) netByDay[row.d] = Number(row.s);
  } else {
    for (const e of memLedger) {
      const d = String(e.created_at || '').slice(0, 10);
      netByDay[d] = (netByDay[d] || 0) + (Number(e.amount) || 0);
    }
  }
  const circulationNow = await sumCoins();
  let running = circulationNow;
  for (let i = dayList.length - 1; i >= 0; i--) {
    dayList[i].circulation = running;
    running -= (netByDay[dayList[i].date] || 0);
  }

  const totals = { games: 0, newUsers: 0, entryCollected: 0, winPaid: 0, bonusGranted: 0 };
  const byKind = { entry_fee: 0, win: 0, signup_bonus: 0, daily_bonus: 0, referral_bonus: 0, admin_grant: 0 };
  for (const d of dayList) {
    totals.games += d.games;
    totals.newUsers += d.newUsers;
    totals.entryCollected += d.entryCollected;
    totals.winPaid += d.winPaid;
    totals.bonusGranted += d.bonusGranted;
  }
  totals.rake = totals.entryCollected - totals.winPaid;
  totals.coinsInCirculation = circulationNow;
  if (USE_PG) {
    const r = await pool.query(
      `SELECT kind, COALESCE(SUM(ABS(amount)), 0)::bigint AS s FROM coin_ledger
        WHERE created_at >= ($1 || 'T00:00:00Z')::timestamptz GROUP BY kind`,
      [series[0]]);
    for (const row of r.rows) if (byKind[row.kind] !== undefined) byKind[row.kind] = Number(row.s);
  } else {
    for (const e of memLedger) {
      const d = String(e.created_at || '').slice(0, 10);
      if (d >= series[0] && byKind[e.kind] !== undefined) byKind[e.kind] += Math.abs(Number(e.amount) || 0);
    }
  }

  return { days: dayList, totals, byKind };
}

/** Fold one ledger aggregate into a day bucket. entry_fee amounts are stored
 *  negative (debits), so entryCollected accumulates the positive magnitude. */
function applyLedgerRow(byDate, d, kind, sum) {
  const row = byDate[d];
  if (!row) return;
  if (kind === 'entry_fee') row.entryCollected += -sum;
  else if (kind === 'win') row.winPaid += sum;
  else if (kind === 'signup_bonus' || kind === 'daily_bonus' || kind === 'referral_bonus') row.bonusGranted += sum;
}

/** Zero-filled analytics structure (used when there is no data / on error). */
function zeroAnalytics(days) {
  const n = Math.min(90, Math.max(1, Math.floor(Number(days) || 30)));
  const today = new Date();
  const list = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    list.push({
      date: d.toISOString().slice(0, 10), games: 0, newUsers: 0,
      entryCollected: 0, winPaid: 0, rake: 0, bonusGranted: 0, circulation: 0,
    });
  }
  return {
    days: list,
    totals: { games: 0, newUsers: 0, entryCollected: 0, winPaid: 0, rake: 0, bonusGranted: 0, coinsInCirculation: 0 },
    byKind: { entry_fee: 0, win: 0, signup_bonus: 0, daily_bonus: 0, referral_bonus: 0, admin_grant: 0 },
  };
}

/* ---------------- referrals ---------------- */

const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomRefCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return s;
}

async function findUserByReferralCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE referral_code = $1', [c]);
    return r.rows[0] || null;
  }
  for (const u of memUsers.values()) {
    if (u.referral_code === c) return { ...u };
  }
  return null;
}

async function uniqueReferralCode() {
  for (let i = 0; i < 25; i++) {
    const c = randomRefCode();
    if (!(await findUserByReferralCode(c))) return c;
  }
  // Practically unreachable; deterministic fallback keeps uniqueness.
  return ('U' + randomUUID().replace(/-/g, '').slice(0, 7)).toUpperCase();
}

let pool = null;
if (USE_PG) {
  // Required lazily so the in-memory path never needs the pg package.
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('[db] PostgreSQL backend active');
} else {
  console.log('================================================================');
  console.log('[db] *** DEV in-memory DB *** — DATABASE_URL is not set.');
  console.log('[db] *** DEV in-memory DB *** — all data lives in process memory');
  console.log('[db] *** DEV in-memory DB *** — and is LOST when the server stops.');
  console.log('================================================================');
}

/** Fail fast at boot when DATABASE_URL is set but unreachable. */
async function pgReady() {
  if (!USE_PG) return;
  await pool.query('SELECT 1');
  // Auto-apply migrations on boot (idempotent — safe for Render/single-service deploys).
  try {
    const migPath = path.join(__dirname, '..', 'migrations.sql');
    if (fs.existsSync(migPath)) {
      await pool.query(fs.readFileSync(migPath, 'utf8'));
      console.log('[db] migrations applied');
    }
  } catch (e) {
    console.error('[db] migration failed:', e.message);
    throw e;
  }
}

// ---------------- in-memory stores ----------------
const memUsers = new Map();     // id -> user row
const memEmailToId = new Map(); // lowercased email -> id
const memPhoneToId = new Map(); // normalized phone -> id
const memPasswordResets = [];   // {id, user_id, code, expires_at, used, created_at}
const memGames = [];            // game records
const memLedger = [];           // {id, user_id, amount, kind, ref_id, created_at}

function dupEmailError() {
  const e = new Error('email already registered');
  e.code = 'DUPLICATE_EMAIL';
  return e;
}
function dupPhoneError() {
  const e = new Error('phone already registered');
  e.code = 'DUPLICATE_PHONE';
  return e;
}
function insufficientCoinsError() {
  const e = new Error('insufficient coins');
  e.code = 'INSUFFICIENT_COINS';
  return e;
}
function userNotFoundError() {
  const e = new Error('user not found');
  e.code = 'USER_NOT_FOUND';
  return e;
}

function toStats(row) {
  const played = row.games_played || 0;
  const won = row.games_won || 0;
  return {
    gamesPlayed: played,
    gamesWon: won,
    winRate: played > 0 ? Math.round((won / played) * 100) : 0,
    wins2p: row.wins_2p || 0,
    wins4p: row.wins_4p || 0,
    totalEarned: Number(row.total_earned || 0),
  };
}

async function createUser({ name, email, phone, passwordHash, startingCoins = STARTING_COINS, referralCode = null, referralBonus = 0 }) {
  const cleanEmail = email ? String(email).toLowerCase() : null;
  const cleanPhone = phone ? String(phone).replace(/[^0-9+]/g, '') : null;
  const code = await uniqueReferralCode();
  if (USE_PG) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let referredBy = null;
      if (referralCode) {
        const rr = await client.query(
          'SELECT id FROM users WHERE referral_code = $1',
          [String(referralCode).trim().toUpperCase()]
        );
        if (rr.rows[0]) referredBy = rr.rows[0].id;
      }
      let row;
      try {
        const r = await client.query(
          `INSERT INTO users (id, name, email, phone, password_hash, coins, referral_code, referred_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [randomUUID(), name, cleanEmail, cleanPhone, passwordHash, startingCoins, code, referredBy]
        );
        row = r.rows[0];
      } catch (e) {
        if (e && e.code === '23505') {
          const msg = String(e.constraint || '');
          if (msg.includes('phone')) throw dupPhoneError();
          throw dupEmailError();
        }
        throw e;
      }
      if (referredBy && referralBonus > 0) {
        await client.query(
          'UPDATE users SET coins = coins + $2, referral_earnings = referral_earnings + $2 WHERE id = $1',
          [referredBy, referralBonus]
        );
      }
      await client.query('COMMIT');
      // Ledger: every coin movement is recorded (never throws).
      await recordLedger(row.id, startingCoins, 'signup_bonus', null);
      if (referredBy && referralBonus > 0) {
        await recordLedger(referredBy, referralBonus, 'referral_bonus', row.id);
      }
      return row;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  if (cleanEmail && memEmailToId.has(cleanEmail)) throw dupEmailError();
  if (cleanPhone && memPhoneToId.has(cleanPhone)) throw dupPhoneError();
  const referrer = referralCode ? await findUserByReferralCode(referralCode) : null;
  const now = new Date().toISOString();
  const u = {
    id: randomUUID(),
    name,
    email: cleanEmail,
    phone: cleanPhone,
    password_hash: passwordHash,
    coins: startingCoins,
    games_played: 0,
    games_won: 0,
    wins_2p: 0,
    wins_4p: 0,
    total_earned: 0,
    last_daily_bonus: null, // 'YYYY-MM-DD'
    created_at: now,
    is_admin: false,
    banned: false,
    referral_code: code,
    referred_by: referrer ? referrer.id : null,
    referral_earnings: 0,
  };
  memUsers.set(u.id, u);
  if (cleanEmail) memEmailToId.set(cleanEmail, u.id);
  if (cleanPhone) memPhoneToId.set(cleanPhone, u.id);
  if (referrer && referralBonus > 0) {
    const r2 = memUsers.get(referrer.id);
    r2.coins += referralBonus;
    r2.referral_earnings += referralBonus;
  }
  await recordLedger(u.id, startingCoins, 'signup_bonus', null);
  if (referrer && referralBonus > 0) {
    await recordLedger(referrer.id, referralBonus, 'referral_bonus', u.id);
  }
  return { ...u };
}

async function findUserByEmail(email) {
  const cleanEmail = String(email).toLowerCase();
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    return r.rows[0] || null;
  }
  const id = memEmailToId.get(cleanEmail);
  return id ? { ...memUsers.get(id) } : null;
}

async function findUserByPhone(phone) {
  const cleanPhone = String(phone).replace(/[^0-9+]/g, '');
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE phone = $1', [cleanPhone]);
    return r.rows[0] || null;
  }
  const id = memPhoneToId.get(cleanPhone);
  return id ? { ...memUsers.get(id) } : null;
}

/* Find by email OR phone (login accepts either). */
async function findUserByLogin(login) {
  const s = String(login).trim();
  if (s.includes('@')) return findUserByEmail(s);
  return findUserByPhone(s);
}

/* Password reset: 6-digit code, 10-minute expiry, single use. */
async function createPasswordReset(userId) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  if (USE_PG) {
    await pool.query(
      `INSERT INTO password_resets (user_id, code, expires_at) VALUES ($1, $2, $3)`,
      [userId, code, expiresAt]
    );
  } else {
    // Invalidate older unused codes for this user.
    for (const r of memPasswordResets) if (r.user_id === userId && !r.used) r.used = true;
    memPasswordResets.push({
      id: randomUUID(), user_id: userId, code,
      expires_at: expiresAt, used: false, created_at: new Date().toISOString(),
    });
  }
  return code;
}

async function verifyPasswordReset(userId, code) {
  const now = new Date().toISOString();
  if (USE_PG) {
    const r = await pool.query(
      `SELECT * FROM password_resets WHERE user_id = $1 AND code = $2 AND used = false AND expires_at > $3
       ORDER BY created_at DESC LIMIT 1`,
      [userId, String(code).trim(), now]
    );
    return r.rows[0] || null;
  }
  const r = memPasswordResets.find((x) =>
    x.user_id === userId && x.code === String(code).trim() && !x.used && x.expires_at > now);
  return r || null;
}

async function consumePasswordReset(resetId, userId, passwordHash) {
  if (USE_PG) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE password_resets SET used = true WHERE id = $1', [resetId]);
      await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } else {
    const r = memPasswordResets.find((x) => x.id === resetId);
    if (r) r.used = true;
    const u = memUsers.get(userId);
    if (u) u.password_hash = passwordHash;
  }
}

async function getUserById(id) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  const u = memUsers.get(id);
  return u ? { ...u } : null;
}

async function updateUserName(id, name) {
  if (USE_PG) {
    const r = await pool.query('UPDATE users SET name = $2 WHERE id = $1 RETURNING *', [id, name]);
    if (r.rows.length === 0) throw userNotFoundError();
    return r.rows[0];
  }
  const u = memUsers.get(id);
  if (!u) throw userNotFoundError();
  u.name = name;
  return { ...u };
}

/**
 * Add delta to a user's balance (delta may be negative).
 * Rejects with INSUFFICIENT_COINS when the balance would go below 0.
 * Returns the new balance.
 */
async function addCoins(id, delta) {
  if (USE_PG) {
    const r = await pool.query(
      'UPDATE users SET coins = coins + $2 WHERE id = $1 AND coins + $2 >= 0 RETURNING coins',
      [id, delta]
    );
    if (r.rows.length === 0) {
      const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
      throw exists.rows.length === 0 ? userNotFoundError() : insufficientCoinsError();
    }
    return r.rows[0].coins;
  }
  const u = memUsers.get(id);
  if (!u) throw userNotFoundError();
  if (u.coins + delta < 0) throw insufficientCoinsError();
  u.coins += delta;
  return u.coins;
}

async function recordGame({ mode, entry, winnerId, playerIds }) {
  const rec = {
    id: randomUUID(),
    mode,
    entry,
    winner_id: winnerId || null,
    player_ids: playerIds || [],
    played_at: new Date().toISOString(),
  };
  if (USE_PG) {
    await pool.query(
      'INSERT INTO games (id, mode, entry, winner_id, player_ids) VALUES ($1, $2, $3, $4, $5)',
      [rec.id, rec.mode, rec.entry, rec.winner_id, JSON.stringify(rec.player_ids)]
    );
    return rec;
  }
  memGames.push(rec);
  return { ...rec };
}

async function incrementStats(userId, { played = 0, won = 0, mode = null, earned = 0 } = {}) {
  if (USE_PG) {
    await pool.query(
      `UPDATE users SET
         games_played = games_played + $2,
         games_won    = games_won + $3,
         wins_2p      = wins_2p + CASE WHEN $4 = '2p' THEN $3 ELSE 0 END,
         wins_4p      = wins_4p + CASE WHEN $4 = '4p' THEN $3 ELSE 0 END,
         total_earned = total_earned + $5
       WHERE id = $1`,
      [userId, played, won, mode, earned]
    );
    return;
  }
  const u = memUsers.get(userId);
  if (!u) throw userNotFoundError();
  u.games_played += played;
  u.games_won += won;
  if (mode === '2p') u.wins_2p += won;
  if (mode === '4p') u.wins_4p += won;
  u.total_earned += earned;
}

/**
 * Daily bonus: +economy.dailyBonus virtual coins, claimable once per calendar day.
 * The amount is read from app_config at runtime so admin changes apply immediately.
 * Returns { granted: bool, coins: <balance after> }.
 */
async function claimDailyBonus(id) {
  const { dailyBonus } = await getEconomy();
  if (USE_PG) {
    const r = await pool.query(
      `UPDATE users
         SET coins = coins + $2, last_daily_bonus = CURRENT_DATE
       WHERE id = $1
         AND (last_daily_bonus IS NULL OR last_daily_bonus < CURRENT_DATE)
       RETURNING coins`,
      [id, dailyBonus]
    );
    if (r.rows.length > 0) {
      await recordLedger(id, dailyBonus, 'daily_bonus', null);
      return { granted: true, coins: r.rows[0].coins };
    }
    const u = await pool.query('SELECT coins FROM users WHERE id = $1', [id]);
    if (u.rows.length === 0) throw userNotFoundError();
    return { granted: false, coins: u.rows[0].coins };
  }
  const u = memUsers.get(id);
  if (!u) throw userNotFoundError();
  const today = new Date().toISOString().slice(0, 10);
  if (u.last_daily_bonus === today) return { granted: false, coins: u.coins };
  u.last_daily_bonus = today;
  u.coins += dailyBonus;
  await recordLedger(id, dailyBonus, 'daily_bonus', null);
  return { granted: true, coins: u.coins };
}

async function getStats(userId) {
  const u = await getUserById(userId);
  if (!u) throw userNotFoundError();
  return toStats(u);
}

/* ---------------- admin ---------------- */

/** Public admin-facing user row (never includes password_hash). */
function publicUserRow(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    coins: u.coins,
    gamesPlayed: u.games_played || 0,
    gamesWon: u.games_won || 0,
    banned: !!u.banned,
    isAdmin: !!u.is_admin,
    referralCode: u.referral_code || null,
    referralEarnings: Number(u.referral_earnings || 0),
    createdAt: u.created_at || null,
  };
}

async function setAdmin(id, flag) {
  if (USE_PG) {
    const r = await pool.query('UPDATE users SET is_admin = $2 WHERE id = $1 RETURNING *', [id, !!flag]);
    if (r.rows.length === 0) throw userNotFoundError();
    return publicUserRow(r.rows[0]);
  }
  const u = memUsers.get(id);
  if (!u) throw userNotFoundError();
  u.is_admin = !!flag;
  return publicUserRow(u);
}

async function setBanned(id, flag) {
  if (USE_PG) {
    const r = await pool.query('UPDATE users SET banned = $2 WHERE id = $1 RETURNING *', [id, !!flag]);
    if (r.rows.length === 0) throw userNotFoundError();
    return publicUserRow(r.rows[0]);
  }
  const u = memUsers.get(id);
  if (!u) throw userNotFoundError();
  u.banned = !!flag;
  return publicUserRow(u);
}

async function listUsers({ search = '', page = 1, limit = 20 } = {}) {
  page = Math.max(1, parseInt(page, 10) || 1);
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const offset = (page - 1) * limit;
  const cols = 'id, name, email, coins, games_played, games_won, banned, is_admin, referral_code, referral_earnings, created_at';
  if (USE_PG) {
    const hasSearch = String(search).trim() !== '';
    const where = hasSearch ? 'WHERE name ILIKE $1 OR email ILIKE $1' : '';
    const params = hasSearch ? [`%${String(search).trim()}%`] : [];
    const totalR = await pool.query(`SELECT COUNT(*)::int AS c FROM users ${where}`, params);
    const r = await pool.query(
      `SELECT ${cols} FROM users ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return { users: r.rows.map(publicUserRow), total: totalR.rows[0].c };
  }
  let arr = [...memUsers.values()];
  const s = String(search).trim().toLowerCase();
  if (s) arr = arr.filter((u) => u.name.toLowerCase().includes(s) || u.email.includes(s));
  const total = arr.length;
  arr.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { users: arr.slice(offset, offset + limit).map(publicUserRow), total };
}

async function getRecentGames(limit = 20) {
  limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  if (USE_PG) {
    const r = await pool.query(
      `SELECT g.id, g.mode, g.entry, g.played_at, g.player_ids, u.name AS winner_name
         FROM games g LEFT JOIN users u ON u.id = g.winner_id
        ORDER BY g.played_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows.map((x) => ({
      id: x.id,
      mode: x.mode,
      entry: x.entry,
      winnerName: x.winner_name || null,
      playerCount: Array.isArray(x.player_ids) ? x.player_ids.length : 0,
      playedAt: x.played_at,
    }));
  }
  return [...memGames]
    .sort((a, b) => String(b.played_at || '').localeCompare(String(a.played_at || '')))
    .slice(0, limit)
    .map((g) => {
      const w = g.winner_id ? memUsers.get(g.winner_id) : null;
      return {
        id: g.id,
        mode: g.mode,
        entry: g.entry,
        winnerName: w ? w.name : null,
        playerCount: (g.player_ids || []).length,
        playedAt: g.played_at,
      };
    });
}

async function countUsers() {
  if (USE_PG) {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    return r.rows[0].c;
  }
  return memUsers.size;
}

async function countGames() {
  if (USE_PG) {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM games');
    return r.rows[0].c;
  }
  return memGames.length;
}

async function countGamesToday() {
  if (USE_PG) {
    const r = await pool.query("SELECT COUNT(*)::int AS c FROM games WHERE played_at >= CURRENT_DATE");
    return r.rows[0].c;
  }
  const today = new Date().toISOString().slice(0, 10);
  return memGames.filter((g) => String(g.played_at || '').slice(0, 10) === today).length;
}

async function sumCoins() {
  if (USE_PG) {
    const r = await pool.query('SELECT COALESCE(SUM(coins), 0)::bigint AS s FROM users');
    return Number(r.rows[0].s);
  }
  let s = 0;
  for (const u of memUsers.values()) s += u.coins || 0;
  return s;
}

/* ---------------- support chat ---------------- */

const memSupport = []; // {id, user_id, sender, text, read_by_admin, created_at}

async function saveSupportMessage({ userId, sender, text }) {
  const clean = String(text || '').trim().slice(0, 1000);
  if (!clean) throw new Error('empty message');
  if (sender !== 'user' && sender !== 'admin') throw new Error('bad sender');
  if (USE_PG) {
    const r = await pool.query(
      `INSERT INTO support_messages (id, user_id, sender, text, read_by_admin)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), userId, sender, clean, sender !== 'user']
    );
    return r.rows[0];
  }
  const m = {
    id: randomUUID(), user_id: userId, sender, text: clean,
    read_by_admin: sender !== 'user', created_at: new Date().toISOString(),
  };
  memSupport.push(m);
  return { ...m };
}

async function getSupportThread(userId, limit = 100) {
  limit = Math.min(200, Math.max(1, parseInt(limit, 10) || 100));
  if (USE_PG) {
    const r = await pool.query(
      `SELECT id, sender, text, created_at FROM support_messages
        WHERE user_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [userId, limit]
    );
    return r.rows;
  }
  return memSupport
    .filter((m) => m.user_id === userId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit)
    .map((m) => ({ id: m.id, sender: m.sender, text: m.text, created_at: m.created_at }));
}

async function getSupportThreads() {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT DISTINCT ON (m.user_id)
         m.user_id AS "userId", u.name, u.email,
         m.text AS "lastText", m.sender AS "lastSender", m.created_at AS "lastAt",
         (SELECT COUNT(*)::int FROM support_messages sm
            WHERE sm.user_id = m.user_id AND sm.sender = 'user' AND sm.read_by_admin = false) AS "unreadCount"
         FROM support_messages m JOIN users u ON u.id = m.user_id
        ORDER BY m.user_id, m.created_at DESC`
    );
    return r.rows.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
  }
  const byUser = new Map();
  for (const m of memSupport) {
    const cur = byUser.get(m.user_id);
    if (!cur || String(m.created_at) >= String(cur.lastAt)) {
      const u = memUsers.get(m.user_id) || {};
      byUser.set(m.user_id, {
        userId: m.user_id, name: u.name || 'Unknown', email: u.email || '',
        lastText: m.text, lastSender: m.sender, lastAt: m.created_at,
        unreadCount: memSupport.filter((x) => x.user_id === m.user_id && x.sender === 'user' && !x.read_by_admin).length,
      });
    }
  }
  return [...byUser.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
}

async function markSupportReadByAdmin(userId) {
  if (USE_PG) {
    await pool.query(
      "UPDATE support_messages SET read_by_admin = true WHERE user_id = $1 AND sender = 'user'",
      [userId]
    );
    return;
  }
  for (const m of memSupport) {
    if (m.user_id === userId && m.sender === 'user') m.read_by_admin = true;
  }
}

/* ---------------- announcements ---------------- */

const memAnnouncements = []; // {id, title, body, active, created_at}

function annRow(a) {
  return { id: a.id, title: a.title, body: a.body, active: !!a.active, createdAt: a.created_at };
}

async function listAnnouncements(activeOnly) {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT * FROM announcements ${activeOnly ? 'WHERE active = true' : ''}
        ORDER BY created_at DESC`
    );
    return r.rows.map(annRow);
  }
  return memAnnouncements
    .filter((a) => !activeOnly || a.active)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(annRow);
}

async function createAnnouncement({ title, body }) {
  const t = String(title || '').trim().slice(0, 120);
  const b = String(body || '').trim().slice(0, 2000);
  if (!t || !b) {
    const e = new Error('title and body are required');
    e.code = 'BAD_ANNOUNCEMENT';
    throw e;
  }
  if (USE_PG) {
    const r = await pool.query(
      'INSERT INTO announcements (id, title, body, active) VALUES ($1, $2, $3, true) RETURNING *',
      [randomUUID(), t, b]
    );
    return annRow(r.rows[0]);
  }
  const a = { id: randomUUID(), title: t, body: b, active: true, created_at: new Date().toISOString() };
  memAnnouncements.push(a);
  return annRow(a);
}

async function updateAnnouncement(id, { title, body, active }) {
  if (USE_PG) {
    const sets = [];
    const params = [id];
    if (title !== undefined) { params.push(String(title).trim().slice(0, 120)); sets.push(`title = $${params.length}`); }
    if (body !== undefined) { params.push(String(body).trim().slice(0, 2000)); sets.push(`body = $${params.length}`); }
    if (active !== undefined) { params.push(!!active); sets.push(`active = $${params.length}`); }
    if (!sets.length) {
      const e = new Error('nothing to update');
      e.code = 'BAD_ANNOUNCEMENT';
      throw e;
    }
    const r = await pool.query(`UPDATE announcements SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!r.rows.length) {
      const e = new Error('announcement not found');
      e.code = 'NOT_FOUND';
      throw e;
    }
    return annRow(r.rows[0]);
  }
  const a = memAnnouncements.find((x) => x.id === id);
  if (!a) {
    const e = new Error('announcement not found');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (title !== undefined) a.title = String(title).trim().slice(0, 120);
  if (body !== undefined) a.body = String(body).trim().slice(0, 2000);
  if (active !== undefined) a.active = !!active;
  return annRow(a);
}

async function deleteAnnouncement(id) {
  if (USE_PG) {
    const r = await pool.query('DELETE FROM announcements WHERE id = $1', [id]);
    return r.rowCount > 0;
  }
  const ix = memAnnouncements.findIndex((x) => x.id === id);
  if (ix < 0) return false;
  memAnnouncements.splice(ix, 1);
  return true;
}

async function close() {
  if (pool) await pool.end();
}

/* ---------------- tournaments (single-elimination 1v1, virtual coins) ----------------
 * Tables: tournaments, tournament_players, tournament_matches.
 * Every helper below supports BOTH PostgreSQL and the in-memory fallback.
 */

const memTournaments = new Map();   // id -> tournament row
const memTPlayers = [];             // {tournament_id, user_id, joined_at, eliminated, final_position}
const memTMatches = [];             // {id, tournament_id, round, match_no, player1_id, player2_id, winner_id, status, game_room_id, ready_at, p1_ready_at, p2_ready_at, created_at}

function tRow(t) {
  return {
    id: t.id, name: t.name, entry_fee: t.entry_fee, max_players: t.max_players,
    prize_1st: t.prize_1st, prize_2nd: t.prize_2nd, prize_3rd: t.prize_3rd,
    status: t.status, starts_at: t.starts_at, created_by: t.created_by, created_at: t.created_at,
  };
}

async function createTournamentRow({ name, entryFee, maxPlayers, prize1st, prize2nd, prize3rd, startsAt, adminId }) {
  const row = {
    id: randomUUID(), name, entry_fee: entryFee, max_players: maxPlayers,
    prize_1st: prize1st || 0, prize_2nd: prize2nd || 0, prize_3rd: prize3rd || 0,
    status: 'upcoming', starts_at: startsAt || null, created_by: adminId || null,
    created_at: new Date().toISOString(),
  };
  if (USE_PG) {
    const r = await pool.query(
      `INSERT INTO tournaments (id, name, entry_fee, max_players, prize_1st, prize_2nd, prize_3rd, status, starts_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'upcoming',$8,$9) RETURNING *`,
      [row.id, row.name, row.entry_fee, row.max_players, row.prize_1st, row.prize_2nd, row.prize_3rd, row.starts_at, row.created_by]
    );
    return tRow(r.rows[0]);
  }
  memTournaments.set(row.id, { ...row });
  return tRow(row);
}

async function getTournamentRow(id) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM tournaments WHERE id = $1', [id]);
    return r.rows.length ? tRow(r.rows[0]) : null;
  }
  const t = memTournaments.get(id);
  return t ? tRow(t) : null;
}

/** Public list: newest first, with player counts. */
async function listTournamentRows() {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT t.*, (SELECT COUNT(*)::int FROM tournament_players p WHERE p.tournament_id = t.id) AS player_count
       FROM tournaments t ORDER BY t.created_at DESC LIMIT 50`
    );
    return r.rows.map((t) => ({ ...tRow(t), player_count: t.player_count }));
  }
  return [...memTournaments.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 50)
    .map((t) => ({ ...tRow(t), player_count: memTPlayers.filter((p) => p.tournament_id === t.id).length }));
}

async function setTournamentStatus(id, status) {
  if (USE_PG) {
    await pool.query('UPDATE tournaments SET status = $1 WHERE id = $2', [status, id]);
    return;
  }
  const t = memTournaments.get(id);
  if (t) t.status = status;
}

async function countTournamentPlayers(tournamentId) {
  if (USE_PG) {
    const r = await pool.query('SELECT COUNT(*)::int AS c FROM tournament_players WHERE tournament_id = $1', [tournamentId]);
    return r.rows[0].c;
  }
  return memTPlayers.filter((p) => p.tournament_id === tournamentId).length;
}

async function hasJoinedTournament(tournamentId, userId) {
  if (USE_PG) {
    const r = await pool.query(
      'SELECT 1 FROM tournament_players WHERE tournament_id = $1 AND user_id = $2', [tournamentId, userId]);
    return r.rows.length > 0;
  }
  return memTPlayers.some((p) => p.tournament_id === tournamentId && p.user_id === userId);
}

async function addTournamentPlayer(tournamentId, userId) {
  const rec = {
    tournament_id: tournamentId, user_id: userId,
    joined_at: new Date().toISOString(), eliminated: false, final_position: null,
  };
  if (USE_PG) {
    await pool.query(
      'INSERT INTO tournament_players (tournament_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [tournamentId, userId]
    );
    return;
  }
  if (!memTPlayers.some((p) => p.tournament_id === tournamentId && p.user_id === userId)) {
    memTPlayers.push({ ...rec });
  }
}

/** Players with names, in join order. */
async function getTournamentPlayers(tournamentId) {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT p.user_id, p.joined_at, p.eliminated, p.final_position, u.name
       FROM tournament_players p JOIN users u ON u.id = p.user_id
       WHERE p.tournament_id = $1 ORDER BY p.joined_at ASC`, [tournamentId]);
    return r.rows;
  }
  return memTPlayers
    .filter((p) => p.tournament_id === tournamentId)
    .sort((a, b) => (a.joined_at < b.joined_at ? -1 : 1))
    .map((p) => ({
      user_id: p.user_id, joined_at: p.joined_at, eliminated: p.eliminated,
      final_position: p.final_position, name: (memUsers.get(p.user_id) || {}).name || 'Player',
    }));
}

async function setPlayerEliminated(tournamentId, userId, position) {
  if (USE_PG) {
    await pool.query(
      'UPDATE tournament_players SET eliminated = true, final_position = $1 WHERE tournament_id = $2 AND user_id = $3',
      [position, tournamentId, userId]
    );
    return;
  }
  const p = memTPlayers.find((x) => x.tournament_id === tournamentId && x.user_id === userId);
  if (p) { p.eliminated = true; p.final_position = position; }
}

/** Set final position without eliminating (used for the champion). */
async function setPlayerPosition(tournamentId, userId, position) {
  if (USE_PG) {
    await pool.query(
      'UPDATE tournament_players SET final_position = $1 WHERE tournament_id = $2 AND user_id = $3',
      [position, tournamentId, userId]
    );
    return;
  }
  const p = memTPlayers.find((x) => x.tournament_id === tournamentId && x.user_id === userId);
  if (p) p.final_position = position;
}

/** Atomic upcoming/filling → ongoing transition. Returns true if we won the race. */
async function tryBeginTournament(id) {
  if (USE_PG) {
    const r = await pool.query(
      `UPDATE tournaments SET status = 'ongoing' WHERE id = $1
       AND status IN ('upcoming', 'filling') RETURNING id`,
      [id]
    );
    return r.rows.length > 0;
  }
  const t = memTournaments.get(id);
  if (!t || (t.status !== 'upcoming' && t.status !== 'filling')) return false;
  t.status = 'ongoing';
  return true;
}

function mRow(m) {
  return {
    id: m.id, tournament_id: m.tournament_id, round: m.round, match_no: m.match_no,
    player1_id: m.player1_id, player2_id: m.player2_id, winner_id: m.winner_id,
    status: m.status, game_room_id: m.game_room_id, ready_at: m.ready_at,
    p1_ready_at: m.p1_ready_at, p2_ready_at: m.p2_ready_at, created_at: m.created_at,
  };
}

async function createTournamentMatch({ tournamentId, round, matchNo, player1Id, player2Id, status, winnerId }) {
  const rec = {
    id: randomUUID(), tournament_id: tournamentId, round, match_no: matchNo,
    player1_id: player1Id || null, player2_id: player2Id || null, winner_id: winnerId || null,
    status: status || 'pending', game_room_id: null,
    ready_at: status === 'ready' ? new Date().toISOString() : null,
    p1_ready_at: null, p2_ready_at: null, created_at: new Date().toISOString(),
  };
  if (USE_PG) {
    const r = await pool.query(
      `INSERT INTO tournament_matches
         (id, tournament_id, round, match_no, player1_id, player2_id, winner_id, status, ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [rec.id, rec.tournament_id, rec.round, rec.match_no, rec.player1_id, rec.player2_id,
       rec.winner_id, rec.status, rec.ready_at]
    );
    return mRow(r.rows[0]);
  }
  memTMatches.push({ ...rec });
  return mRow(rec);
}

async function getTournamentMatch(id) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM tournament_matches WHERE id = $1', [id]);
    return r.rows.length ? mRow(r.rows[0]) : null;
  }
  const m = memTMatches.find((x) => x.id === id);
  return m ? mRow(m) : null;
}

async function getTournamentMatches(tournamentId) {
  if (USE_PG) {
    const r = await pool.query(
      'SELECT * FROM tournament_matches WHERE tournament_id = $1 ORDER BY round ASC, match_no ASC',
      [tournamentId]
    );
    return r.rows.map(mRow);
  }
  return memTMatches
    .filter((m) => m.tournament_id === tournamentId)
    .sort((a, b) => (a.round - b.round) || (a.match_no - b.match_no))
    .map(mRow);
}

/** Fill the empty player2 slot of a pending next-round match → becomes 'ready'. */
async function fillTournamentMatchSlot(matchId, playerId) {
  if (USE_PG) {
    const r = await pool.query(
      `UPDATE tournament_matches
          SET player2_id = $2, status = 'ready', ready_at = COALESCE(ready_at, NOW())
        WHERE id = $1 AND player2_id IS NULL AND player1_id IS NOT NULL AND player1_id <> $2
        RETURNING *`,
      [matchId, playerId]
    );
    return r.rows.length ? mRow(r.rows[0]) : null;
  }
  const m = memTMatches.find((x) => x.id === matchId);
  if (!m) return null;
  if (!m.player1_id) m.player1_id = playerId;
  else if (!m.player2_id && m.player2_id !== playerId && m.player1_id !== playerId) m.player2_id = playerId;
  if (m.player1_id && m.player2_id && m.status === 'pending') {
    m.status = 'ready';
    m.ready_at = m.ready_at || new Date().toISOString();
  }
  return mRow(m);
}

async function setTournamentMatch(id, patch) {
  if (USE_PG) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      sets.push(k + ' = $' + (i++));
      vals.push(v);
    }
    vals.push(id);
    const r = await pool.query(
      `UPDATE tournament_matches SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return r.rows.length ? mRow(r.rows[0]) : null;
  }
  const m = memTMatches.find((x) => x.id === id);
  if (!m) return null;
  Object.assign(m, patch);
  return mRow(m);
}

/** Atomically claim a 'ready' match for play (prevents double-start races). */
async function claimTournamentMatch(id) {
  if (USE_PG) {
    const r = await pool.query(
      "UPDATE tournament_matches SET status = 'ongoing' WHERE id = $1 AND status = 'ready' RETURNING *",
      [id]
    );
    return r.rows.length ? mRow(r.rows[0]) : null;
  }
  const m = memTMatches.find((x) => x.id === id);
  if (!m || m.status !== 'ready') return null;
  m.status = 'ongoing';
  return mRow(m);
}

async function markTournamentPlayerReady(matchId, userId) {
  const m = await getTournamentMatch(matchId);
  if (!m) return null;
  const patch = {};
  if (m.player1_id === userId) patch.p1_ready_at = new Date().toISOString();
  else if (m.player2_id === userId) patch.p2_ready_at = new Date().toISOString();
  else return null;
  return setTournamentMatch(matchId, patch);
}

/** The user's latest non-completed match in an ongoing tournament (queue-block + myMatch). */
async function getActiveTournamentMatchForUser(userId) {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT m.* FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id
       WHERE t.status = 'ongoing' AND m.status IN ('ready', 'ongoing')
         AND (m.player1_id = $1 OR m.player2_id = $1)
       ORDER BY m.created_at DESC LIMIT 1`, [userId]);
    return r.rows.length ? mRow(r.rows[0]) : null;
  }
  const ongoingIds = new Set(
    [...memTournaments.values()].filter((t) => t.status === 'ongoing').map((t) => t.id));
  const cands = memTMatches
    .filter((m) => ongoingIds.has(m.tournament_id)
      && (m.status === 'ready' || m.status === 'ongoing')
      && (m.player1_id === userId || m.player2_id === userId))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return cands.length ? mRow(cands[0]) : null;
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  createUser,
  findUserByEmail,
  findUserByPhone,
  findUserByLogin,
  createPasswordReset,
  verifyPasswordReset,
  consumePasswordReset,
  findUserByReferralCode,
  getUserById,
  updateUserName,
  addCoins,
  recordGame,
  incrementStats,
  getStats,
  claimDailyBonus,
  getConfig,
  setConfig,
  getRoomsConfig,
  getEconomy,
  getCoinPacks,
  getMatchmaking,
  setAdmin,
  setBanned,
  listUsers,
  getRecentGames,
  countUsers,
  countGames,
  countGamesToday,
  sumCoins,
  publicUserRow,
  saveSupportMessage,
  getSupportThread,
  getSupportThreads,
  markSupportReadByAdmin,
  recordLedger,
  getLedger,
  createCoinRequest,
  listUserCoinRequests,
  listCoinRequests,
  decideCoinRequest,
  getCustomOptions,
  setCustomOptions,
  createTournamentRow,
  getTournamentRow,
  listTournamentRows,
  setTournamentStatus,
  countTournamentPlayers,
  hasJoinedTournament,
  addTournamentPlayer,
  getTournamentPlayers,
  setPlayerEliminated,
  setPlayerPosition,
  tryBeginTournament,
  createTournamentMatch,
  getTournamentMatch,
  getTournamentMatches,
  fillTournamentMatchSlot,
  setTournamentMatch,
  claimTournamentMatch,
  markTournamentPlayerReady,
  getActiveTournamentMatchForUser,
  getAnalytics,
  zeroAnalytics,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  pgReady,
  close,
  STARTING_COINS,
  DAILY_BONUS_COINS,
};

/* ---------------- leaderboard + daily missions (appended; exports extended below) ---------------- */

const MISSION_DEFS = [
  { key: 'play3', title: 'Play 3 games', target: 3, reward: 100 },
  { key: 'win1',  title: 'Win 1 game',   target: 1, reward: 150 },
  { key: 'win3',  title: 'Win 3 games',  target: 3, reward: 500 },
];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function weekAgoIso() {
  return new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
}

/* Leaderboard: rank by wins in period, tiebreak by entry volume of won games.
 * period: 'weekly' (last 7 days rolling) | 'alltime'. Returns top 20. */
async function getLeaderboard(period = 'weekly') {
  if (USE_PG) {
    const since = period === 'alltime' ? '1970-01-01T00:00:00Z' : weekAgoIso();
    const r = await pool.query(
      `SELECT u.id AS user_id, u.name,
              COALESCE(w.wins, 0) AS wins,
              COALESCE(p.played, 0) AS played
         FROM users u
         LEFT JOIN (
           SELECT winner_id, COUNT(*)::int AS wins, COALESCE(SUM(entry), 0)::int AS vol
             FROM games
            WHERE played_at >= ($1)::timestamptz AND winner_id IS NOT NULL
            GROUP BY winner_id
         ) w ON w.winner_id = u.id
         LEFT JOIN (
           SELECT t.uid, COUNT(*)::int AS played
             FROM games g, jsonb_array_elements_text(g.player_ids) AS t(uid)
            WHERE g.played_at >= ($1)::timestamptz
            GROUP BY t.uid
         ) p ON p.uid = u.id
        WHERE COALESCE(w.wins, 0) > 0 AND (u.banned IS NOT TRUE)
        ORDER BY wins DESC, vol DESC, u.name ASC
        LIMIT 20`,
      [since]
    );
    return r.rows.map((row, i) => ({
      rank: i + 1, userId: row.user_id, name: row.name,
      wins: Number(row.wins), played: Number(row.played),
    }));
  }
  const since = period === 'alltime' ? '' : weekAgoIso();
  const agg = new Map(); // userId -> {wins, vol, played}
  const bump = (uid, field, by) => {
    if (!uid) return;
    let a = agg.get(uid);
    if (!a) { a = { wins: 0, vol: 0, played: 0 }; agg.set(uid, a); }
    a[field] += by;
  };
  for (const g of memGames) {
    if (since && g.played_at < since) continue;
    for (const pid of g.player_ids || []) bump(pid, 'played', 1);
    if (g.winner_id) { bump(g.winner_id, 'wins', 1); bump(g.winner_id, 'vol', g.entry || 0); }
  }
  const rows = [];
  for (const [uid, a] of agg) {
    const u = memUsers.get(uid);
    if (!u || a.wins <= 0 || u.banned) continue;
    rows.push({ userId: uid, name: u.name, wins: a.wins, played: a.played, vol: a.vol });
  }
  rows.sort((a, b) => b.wins - a.wins || b.vol - a.vol || String(a.name).localeCompare(String(b.name)));
  return rows.slice(0, 20).map((r, i) => ({ rank: i + 1, userId: r.userId, name: r.name, wins: r.wins, played: r.played }));
}

async function getUserLeaderboardRank(userId, period = 'weekly') {
  // Small scale: reuse the ordered query without the top-20 cut.
  if (USE_PG) {
    const since = period === 'alltime' ? '1970-01-01T00:00:00Z' : weekAgoIso();
    const r = await pool.query(
      `SELECT u.id AS user_id,
              COALESCE(w.wins, 0) AS wins,
              COALESCE(p.played, 0) AS played
         FROM users u
         LEFT JOIN (
           SELECT winner_id, COUNT(*)::int AS wins, COALESCE(SUM(entry), 0)::int AS vol
             FROM games
            WHERE played_at >= ($1)::timestamptz AND winner_id IS NOT NULL
            GROUP BY winner_id
         ) w ON w.winner_id = u.id
         LEFT JOIN (
           SELECT t.uid, COUNT(*)::int AS played
             FROM games g, jsonb_array_elements_text(g.player_ids) AS t(uid)
            WHERE g.played_at >= ($1)::timestamptz
            GROUP BY t.uid
         ) p ON p.uid = u.id
        WHERE COALESCE(w.wins, 0) > 0 AND (u.banned IS NOT TRUE)
        ORDER BY wins DESC, vol DESC, u.name ASC`,
      [since]
    );
    const idx = r.rows.findIndex((row) => String(row.user_id) === String(userId));
    if (idx < 0) return null;
    return { rank: idx + 1, wins: Number(r.rows[idx].wins), played: Number(r.rows[idx].played) };
  }
  // Full ordered list (no top-20 cut) so ranks beyond 20 are correct.
  const since = period === 'alltime' ? '' : weekAgoIso();
  const agg = new Map();
  const bump = (uid, field, by) => {
    if (!uid) return;
    let a = agg.get(uid);
    if (!a) { a = { wins: 0, vol: 0, played: 0 }; agg.set(uid, a); }
    a[field] += by;
  };
  for (const g of memGames) {
    if (since && g.played_at < since) continue;
    for (const pid of g.player_ids || []) bump(pid, 'played', 1);
    if (g.winner_id) { bump(g.winner_id, 'wins', 1); bump(g.winner_id, 'vol', g.entry || 0); }
  }
  const rows = [];
  for (const [uid, a] of agg) {
    const u = memUsers.get(uid);
    if (!u || a.wins <= 0 || u.banned) continue;
    rows.push({ userId: uid, wins: a.wins, played: a.played, vol: a.vol, name: u.name });
  }
  rows.sort((a, b) => b.wins - a.wins || b.vol - a.vol || String(a.name).localeCompare(String(b.name)));
  const idx = rows.findIndex((r) => String(r.userId) === String(userId));
  if (idx < 0) return null;
  return { rank: idx + 1, wins: rows[idx].wins, played: rows[idx].played };
}

/* Daily missions: progress is computed live from the games table (UTC day). */
async function missionProgress(userId, day) {
  const start = day + 'T00:00:00.000Z';
  if (USE_PG) {
    const p = await pool.query(
      `SELECT COUNT(*)::int AS c FROM games
        WHERE played_at >= ($1)::timestamptz AND player_ids @> to_jsonb($2::text)`,
      [start, String(userId)]
    );
    const w = await pool.query(
      `SELECT COUNT(*)::int AS c FROM games
        WHERE played_at >= ($1)::timestamptz AND winner_id = $2`,
      [start, userId]
    );
    return { played: p.rows[0].c, won: w.rows[0].c };
  }
  let played = 0, won = 0;
  for (const g of memGames) {
    if (g.played_at < start) continue;
    if ((g.player_ids || []).includes(userId)) played++;
    if (String(g.winner_id) === String(userId)) won++;
  }
  return { played, won };
}

async function getMissionClaims(userId, day) {
  if (USE_PG) {
    const r = await pool.query(
      'SELECT mission_key FROM mission_claims WHERE user_id = $1 AND day = $2', [userId, day]);
    return new Set(r.rows.map((x) => x.mission_key));
  }
  return new Set(
    (memMissionClaims || []).filter((c) => String(c.user_id) === String(userId) && c.day === day)
      .map((c) => c.mission_key)
  );
}

async function getMissions(userId) {
  const day = todayUtc();
  const [prog, claimed] = await Promise.all([missionProgress(userId, day), getMissionClaims(userId, day)]);
  return MISSION_DEFS.map((m) => {
    const progress = m.key === 'play3' ? prog.played : prog.won;
    return {
      key: m.key, title: m.title, target: m.target, reward: m.reward,
      progress: Math.min(progress, m.target * 3),
      claimed: claimed.has(m.key),
      complete: progress >= m.target,
    };
  });
}

async function claimMission(userId, key) {
  const def = MISSION_DEFS.find((m) => m.key === key);
  if (!def) throw Object.assign(new Error('Unknown mission'), { status: 400 });
  const day = todayUtc();
  const [prog, claimed] = await Promise.all([missionProgress(userId, day), getMissionClaims(userId, day)]);
  const progress = def.key === 'play3' ? prog.played : prog.won;
  if (claimed.has(key)) throw Object.assign(new Error('Already claimed'), { status: 400 });
  if (progress < def.target) throw Object.assign(new Error('Mission not complete yet'), { status: 400 });
  if (USE_PG) {
    try {
      await pool.query(
        'INSERT INTO mission_claims (user_id, day, mission_key) VALUES ($1, $2, $3)',
        [userId, day, key]
      );
    } catch (e) {
      // Unique violation = raced double-claim.
      throw Object.assign(new Error('Already claimed'), { status: 400 });
    }
  } else {
    if (!globalThis.__memMissionClaims) globalThis.__memMissionClaims = [];
    const arr = globalThis.__memMissionClaims;
    if (arr.some((c) => String(c.user_id) === String(userId) && c.day === day && c.mission_key === key)) {
      throw Object.assign(new Error('Already claimed'), { status: 400 });
    }
    arr.push({ user_id: userId, day, mission_key: key, claimed_at: new Date().toISOString() });
  }
  await addCoins(userId, def.reward);
  await recordLedger(userId, def.reward, 'mission_bonus', key + ':' + day);
  return { claimed: true, reward: def.reward, key };
}

const memMissionClaims = globalThis.__memMissionClaims || (globalThis.__memMissionClaims = []);

Object.assign(module.exports, {
  getLeaderboard,
  getUserLeaderboardRank,
  getMissions,
  claimMission,
  missionProgress,
  todayUtc,
  MISSION_DEFS,
});

/* ================= private rooms (appended; do not reorder) ================= */

const memPrivateRooms = new Map();   // id -> {id, code, creator_id, entry_fee, max_players, status, commission_pct, created_at, expires_at}
const memPrivateRoomPlayers = [];    // {room_id, user_id, joined_at}

async function getPrivateCommissionPct() {
  const v = await getConfig('private_commission_pct');
  if (v === null || v === undefined || v === '') return 10;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 50 ? n : 10;
}

async function setPrivateCommissionPct(pct) {
  const n = Math.floor(Number(pct));
  if (!Number.isInteger(n) || n < 0 || n > 50) throw Object.assign(new Error('pct must be 0..50'), { status: 400 });
  await setConfig('private_commission_pct', n);
  return n;
}

async function createPrivateRoomRow({ code, creatorId, entryFee, maxPlayers, commissionPct, expiresAt }) {
  const row = {
    id: randomUUID(), code, creator_id: creatorId, entry_fee: entryFee,
    max_players: maxPlayers, status: 'waiting', commission_pct: commissionPct,
    created_at: new Date().toISOString(), expires_at: expiresAt,
  };
  if (USE_PG) {
    const r = await pool.query(
      `INSERT INTO private_rooms (id, code, creator_id, entry_fee, max_players, status, commission_pct, expires_at)
       VALUES ($1,$2,$3,$4,$5,'waiting',$6,$7) RETURNING *`,
      [row.id, code, creatorId, entryFee, maxPlayers, commissionPct, expiresAt]
    );
    return r.rows[0];
  }
  memPrivateRooms.set(row.id, row);
  return { ...row };
}

async function getPrivateRoomByCode(code) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM private_rooms WHERE code = $1', [code]);
    return r.rows[0] || null;
  }
  for (const row of memPrivateRooms.values()) if (row.code === code) return { ...row };
  return null;
}

async function getPrivateRoomById(id) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM private_rooms WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  const row = memPrivateRooms.get(id);
  return row ? { ...row } : null;
}

async function listPrivateRoomPlayers(roomId) {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT p.user_id, p.joined_at, u.name FROM private_room_players p
       JOIN users u ON u.id = p.user_id WHERE p.room_id = $1 ORDER BY p.joined_at ASC`, [roomId]);
    return r.rows;
  }
  return memPrivateRoomPlayers
    .filter((p) => p.room_id === roomId)
    .sort((a, b) => (a.joined_at < b.joined_at ? -1 : 1))
    .map((p) => ({ user_id: p.user_id, joined_at: p.joined_at, name: (memUsers.get(p.user_id) || {}).name || 'Player' }));
}

async function countPrivateRoomPlayers(roomId) {
  return (await listPrivateRoomPlayers(roomId)).length;
}

async function addPrivateRoomPlayer(roomId, userId) {
  if (USE_PG) {
    await pool.query(
      'INSERT INTO private_room_players (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [roomId, userId]);
    return;
  }
  if (!memPrivateRoomPlayers.some((p) => p.room_id === roomId && p.user_id === userId)) {
    memPrivateRoomPlayers.push({ room_id: roomId, user_id: userId, joined_at: new Date().toISOString() });
  }
}

async function removePrivateRoomPlayer(roomId, userId) {
  if (USE_PG) {
    await pool.query('DELETE FROM private_room_players WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    return;
  }
  for (let i = memPrivateRoomPlayers.length - 1; i >= 0; i--) {
    if (memPrivateRoomPlayers[i].room_id === roomId && memPrivateRoomPlayers[i].user_id === userId) {
      memPrivateRoomPlayers.splice(i, 1);
    }
  }
}

async function setPrivateRoomStatus(id, status) {
  if (USE_PG) {
    await pool.query('UPDATE private_rooms SET status = $1 WHERE id = $2', [status, id]);
    return;
  }
  const row = memPrivateRooms.get(id);
  if (row) row.status = status;
}

async function getUserActivePrivateRoom(userId) {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT r.* FROM private_rooms r JOIN private_room_players p ON p.room_id = r.id
       WHERE p.user_id = $1 AND r.status IN ('waiting','ongoing') LIMIT 1`, [userId]);
    return r.rows[0] || null;
  }
  for (const p of memPrivateRoomPlayers) {
    if (p.user_id === userId) {
      const row = memPrivateRooms.get(p.room_id);
      if (row && (row.status === 'waiting' || row.status === 'ongoing')) return { ...row };
    }
  }
  return null;
}

async function listExpiredPrivateRooms() {
  const nowIso = new Date().toISOString();
  if (USE_PG) {
    const r = await pool.query(
      "SELECT * FROM private_rooms WHERE status = 'waiting' AND expires_at < now()");
    return r.rows;
  }
  const out = [];
  for (const row of memPrivateRooms.values()) {
    if (row.status === 'waiting' && row.expires_at < nowIso) out.push({ ...row });
  }
  return out;
}

Object.assign(module.exports, {
  getPrivateCommissionPct,
  setPrivateCommissionPct,
  createPrivateRoomRow,
  getPrivateRoomByCode,
  getPrivateRoomById,
  listPrivateRoomPlayers,
  countPrivateRoomPlayers,
  addPrivateRoomPlayer,
  removePrivateRoomPlayer,
  setPrivateRoomStatus,
  getUserActivePrivateRoom,
  listExpiredPrivateRooms,
});

/* ================= telegram notifications (appended; do not reorder) =================
 * Link codes: one-time, 10-minute expiry (TELEGRAM_LINK_TTL_MS env override for tests).
 * telegram_links: user_id <-> telegram chat id mapping for push notifications.
 */

const { randomBytes } = require('crypto');

function telegramLinkTtlMs() {
  const v = Number(process.env.TELEGRAM_LINK_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : 10 * 60 * 1000;
}

function newLinkCode() {
  return randomBytes(9).toString('base64url'); // 12 URL-safe chars
}

const memTelegramLinks = new Map(); // user_id -> {user_id, telegram_id, first_name, linked_at}
const memTelegramLinksByTg = new Map(); // telegram_id -> user_id
const memLinkCodes = new Map(); // code -> {code, user_id, created_at, used}

async function createTelegramLinkCode(userId) {
  const code = newLinkCode();
  const row = { code, user_id: userId, created_at: new Date().toISOString(), used: false };
  if (USE_PG) {
    await pool.query(
      'INSERT INTO telegram_link_codes (code, user_id) VALUES ($1, $2)',
      [code, userId]
    );
  } else {
    memLinkCodes.set(code, row);
  }
  return { code, expiresInSec: Math.round(telegramLinkTtlMs() / 1000) };
}

/** Validate a one-time code and create the telegram link. Throws with .status on failure. */
async function consumeTelegramLinkCode(code, telegramId, firstName) {
  const clean = String(code || '').trim();
  if (!clean) throw Object.assign(new Error('missing code'), { status: 400 });
  const tgId = Number(telegramId);
  if (!Number.isFinite(tgId)) throw Object.assign(new Error('missing telegram id'), { status: 400 });

  let row;
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM telegram_link_codes WHERE code = $1', [clean]);
    row = r.rows[0] || null;
  } else {
    row = memLinkCodes.get(clean) || null;
  }
  if (!row) throw Object.assign(new Error('invalid link code'), { status: 404 });
  if (row.used) throw Object.assign(new Error('link code already used'), { status: 410 });
  if (Date.now() - new Date(row.created_at).getTime() > telegramLinkTtlMs()) {
    throw Object.assign(new Error('link code expired'), { status: 410 });
  }

  const link = {
    user_id: row.user_id,
    telegram_id: tgId,
    first_name: String(firstName || '').slice(0, 100) || null,
    linked_at: new Date().toISOString(),
  };
  if (USE_PG) {
    await pool.query('UPDATE telegram_link_codes SET used = true WHERE code = $1', [clean]);
    await pool.query(
      `INSERT INTO telegram_links (user_id, telegram_id, first_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id,
         first_name = EXCLUDED.first_name, linked_at = now()`,
      [link.user_id, link.telegram_id, link.first_name]
    );
  } else {
    row.used = true;
    const prev = memTelegramLinks.get(row.user_id);
    if (prev) memTelegramLinksByTg.delete(prev.telegram_id);
    memTelegramLinks.set(row.user_id, link);
    memTelegramLinksByTg.set(tgId, row.user_id);
  }
  return { ok: true, userId: row.user_id };
}

async function getTelegramLink(userId) {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM telegram_links WHERE user_id = $1', [userId]);
    return r.rows[0] || null;
  }
  return memTelegramLinks.get(userId) || null;
}

async function unlinkTelegram(userId) {
  if (USE_PG) {
    await pool.query('DELETE FROM telegram_links WHERE user_id = $1', [userId]);
  } else {
    const prev = memTelegramLinks.get(userId);
    if (prev) memTelegramLinksByTg.delete(prev.telegram_id);
    memTelegramLinks.delete(userId);
  }
  return { ok: true };
}

/** All linked user ids (for admin broadcasts). */
async function listTelegramLinkedUserIds() {
  if (USE_PG) {
    const r = await pool.query('SELECT user_id FROM telegram_links');
    return r.rows.map((x) => x.user_id);
  }
  return [...memTelegramLinks.keys()];
}

/** Linked users whose daily bonus is claimable right now (last_daily_bonus < today UTC). */
async function listLinkedUsersWithClaimableDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (USE_PG) {
    const r = await pool.query(
      `SELECT l.user_id FROM telegram_links l
       JOIN users u ON u.id = l.user_id
       WHERE u.last_daily_bonus IS NULL OR u.last_daily_bonus < CURRENT_DATE`
    );
    return r.rows.map((x) => x.user_id);
  }
  const out = [];
  for (const [userId] of memTelegramLinks) {
    const u = memUsers.get(userId);
    if (u && !u.banned && (u.last_daily_bonus || '') < today) out.push(userId);
  }
  return out;
}

Object.assign(module.exports, {
  createTelegramLinkCode,
  consumeTelegramLinkCode,
  getTelegramLink,
  unlinkTelegram,
  listTelegramLinkedUserIds,
  listLinkedUsersWithClaimableDaily,
});

/* ================= coin store + redeem codes (appended; do not reorder) =================
 * VIRTUAL COINS ONLY. Free daily packs and admin reward codes — no payment,
 * no cash-out, no real money anywhere.
 */

const COIN_STORE_AMOUNTS = [10, 50, 100, 500];
const memCoinStoreClaims = [];       // {user_id, amount, claimed_at}
const memRedeemCodes = new Map();    // code -> {code, coins, max_uses, used_count, active, created_by, created_at}
const memRedeemCodeUses = [];        // {code, user_id, used_at}

function utcDayStartMs() {
  const n = Date.now();
  return n - (n % 86400000);
}

function err400(msg) { return Object.assign(new Error(msg), { status: 400 }); }
function err404(msg) { return Object.assign(new Error(msg), { status: 404 }); }
function err409(msg) { return Object.assign(new Error(msg), { status: 409 }); }

/** Claim a FREE coin-store pack. Each amount is claimable once per UTC day per user. */
async function claimCoinStore(userId, amount) {
  const amt = Number(amount);
  if (!COIN_STORE_AMOUNTS.includes(amt)) throw err400('Invalid pack amount');
  if (USE_PG) {
    // Atomic: insert only when this user hasn't claimed this amount today (UTC).
    const r = await pool.query(
      `INSERT INTO coin_store_claims (user_id, amount)
       SELECT $1, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM coin_store_claims
         WHERE user_id = $1 AND amount = $2
           AND claimed_at >= date_trunc('day', now())
           AND claimed_at <  date_trunc('day', now()) + interval '1 day'
       )
       RETURNING *`,
      [userId, amt]
    );
    if (r.rows.length === 0) throw err409('Already claimed today');
    const coins = await addCoins(userId, amt);
    await recordLedger(userId, amt, 'coin_store', null);
    return { granted: true, amount: amt, coins };
  }
  const start = utcDayStartMs();
  const dup = memCoinStoreClaims.some(
    (c) => c.user_id === userId && c.amount === amt && new Date(c.claimed_at).getTime() >= start
  );
  if (dup) throw err409('Already claimed today');
  memCoinStoreClaims.push({ user_id: userId, amount: amt, claimed_at: new Date().toISOString() });
  const coins = await addCoins(userId, amt);
  await recordLedger(userId, amt, 'coin_store', null);
  return { granted: true, amount: amt, coins };
}

/** Amounts this user has already claimed today (UTC). */
async function coinStoreStatus(userId) {
  if (USE_PG) {
    const r = await pool.query(
      `SELECT amount FROM coin_store_claims
       WHERE user_id = $1
         AND claimed_at >= date_trunc('day', now())
         AND claimed_at <  date_trunc('day', now()) + interval '1 day'`,
      [userId]
    );
    return r.rows.map((x) => x.amount);
  }
  const start = utcDayStartMs();
  return memCoinStoreClaims
    .filter((c) => c.user_id === userId && new Date(c.claimed_at).getTime() >= start)
    .map((c) => c.amount);
}

function normalizeRedeemCode(code) {
  return String(code || '').trim().toUpperCase();
}

async function createRedeemCode(adminId, code, coins, maxUses) {
  const c = normalizeRedeemCode(code);
  if (!/^[A-Z0-9]{4,24}$/.test(c)) throw err400('Code must be 4-24 characters A-Z0-9');
  const n = Number(coins), m = Number(maxUses);
  if (!Number.isInteger(n) || n < 1 || n > 100000) throw err400('Coins must be 1..100000');
  if (!Number.isInteger(m) || m < 1 || m > 100000) throw err400('Max uses must be 1..100000');
  if (USE_PG) {
    try {
      const r = await pool.query(
        'INSERT INTO redeem_codes (code, coins, max_uses, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
        [c, n, m, adminId]
      );
      return r.rows[0];
    } catch (e) {
      if (e.code === '23505') throw err409('Code already exists');
      throw e;
    }
  }
  if (memRedeemCodes.has(c)) throw err409('Code already exists');
  const row = { code: c, coins: n, max_uses: m, used_count: 0, active: 1, created_by: adminId, created_at: new Date().toISOString() };
  memRedeemCodes.set(c, row);
  return { ...row };
}

async function listRedeemCodes() {
  if (USE_PG) {
    const r = await pool.query('SELECT * FROM redeem_codes ORDER BY created_at DESC');
    return r.rows;
  }
  return [...memRedeemCodes.values()]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .map((r) => ({ ...r }));
}

async function deleteRedeemCode(code) {
  const c = normalizeRedeemCode(code);
  if (USE_PG) {
    const r = await pool.query('DELETE FROM redeem_codes WHERE code = $1', [c]);
    if (r.rowCount === 0) throw err404('Code not found');
    return { deleted: true };
  }
  if (!memRedeemCodes.has(c)) throw err404('Code not found');
  memRedeemCodes.delete(c);
  for (let i = memRedeemCodeUses.length - 1; i >= 0; i--) {
    if (memRedeemCodeUses[i].code === c) memRedeemCodeUses.splice(i, 1);
  }
  return { deleted: true };
}

/** Redeem a reward code for free coins. One use per user; global cap = max_uses. */
async function redeemCode(userId, code) {
  const c = normalizeRedeemCode(code);
  if (!c) throw err400('Code is required');
  if (USE_PG) {
    const row = (await pool.query('SELECT * FROM redeem_codes WHERE code = $1', [c])).rows[0];
    if (!row || !row.active) throw err404('Invalid code');
    const used = (await pool.query(
      'SELECT 1 FROM redeem_code_uses WHERE code = $1 AND user_id = $2', [c, userId]
    )).rows.length > 0;
    if (used) throw err409('Code already used');
    // Atomic global-use increment; fails when the cap is reached.
    const upd = await pool.query(
      `UPDATE redeem_codes SET used_count = used_count + 1
       WHERE code = $1 AND active = 1 AND used_count < max_uses
       RETURNING coins`,
      [c]
    );
    if (upd.rows.length === 0) throw err409('Code exhausted');
    try {
      await pool.query('INSERT INTO redeem_code_uses (code, user_id) VALUES ($1, $2)', [c, userId]);
    } catch (e) {
      // Lost a same-user race: give the global use back.
      await pool.query('UPDATE redeem_codes SET used_count = used_count - 1 WHERE code = $1', [c]);
      throw err409('Code already used');
    }
    const coins = await addCoins(userId, upd.rows[0].coins);
    await recordLedger(userId, upd.rows[0].coins, 'redeem_code', c);
    return { granted: true, amount: upd.rows[0].coins, coins };
  }
  const row = memRedeemCodes.get(c);
  if (!row || !row.active) throw err404('Invalid code');
  if (memRedeemCodeUses.some((u) => u.code === c && u.user_id === userId)) throw err409('Code already used');
  if (row.used_count >= row.max_uses) throw err409('Code exhausted');
  row.used_count += 1;
  memRedeemCodeUses.push({ code: c, user_id: userId, used_at: new Date().toISOString() });
  const coins = await addCoins(userId, row.coins);
  await recordLedger(userId, row.coins, 'redeem_code', c);
  return { granted: true, amount: row.coins, coins };
}

Object.assign(module.exports, {
  COIN_STORE_AMOUNTS,
  claimCoinStore,
  coinStoreStatus,
  createRedeemCode,
  listRedeemCodes,
  deleteRedeemCode,
  redeemCode,
});

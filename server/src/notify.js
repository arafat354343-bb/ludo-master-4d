'use strict';

/**
 * Telegram push notifications — singleton.
 *
 * VIRTUAL COINS ONLY. Notifications are plain text game alerts (bonus ready,
 * request approved, match ready...). No money, no payments, no cash-out.
 *
 * Design:
 * - initNotify({ db }) must be called once at server boot (server/src/index.js).
 * - Every public method NEVER throws: notification failure must not break gameplay.
 * - Without TELEGRAM_BOT_TOKEN everything is a silent no-op (one log line).
 * - TELEGRAM_API_BASE env override exists only so tests can point at a local
 *   capture server and prove the sendMessage call shape.
 * - Daily-bonus reminders: startDailyScheduler() runs an hourly tick that finds
 *   linked users whose bonus is claimable and nudges them once per UTC day.
 *   Dupe guard is an in-memory Set keyed "userId:YYYY-MM-DD" — a server restart
 *   may resend that day's reminder once; harmless for a reminder nudge.
 */

let db = null;
let warnedNoToken = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

function apiBase() {
  return (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
}

function initNotify(deps) {
  db = deps && deps.db ? deps.db : null;
}

async function postToTelegram(telegramId, text) {
  const token = getToken();
  if (!token) {
    if (!warnedNoToken) {
      warnedNoToken = true;
      console.log('[notify] TELEGRAM_BOT_TOKEN not set — telegram notifications disabled (no-op)');
    }
    return false;
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res;
    try {
      res = await fetch(`${apiBase()}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: Number(telegramId), text: String(text).slice(0, 4000) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) console.error('[notify] telegram API error:', res.status);
    return res.ok;
  } catch (e) {
    console.error('[notify] send failed:', e.message);
    return false;
  }
}

/** Send a text notification to one user (looks up their linked telegram id). Never throws. */
async function notifyUser(userId, text) {
  try {
    if (!db || !userId) return false;
    const link = await db.getTelegramLink(userId);
    if (!link || !link.telegram_id) return false;
    return await postToTelegram(link.telegram_id, text);
  } catch (e) {
    console.error('[notify] notifyUser failed:', e.message);
    return false;
  }
}

/** Send to many users, 50ms apart (Telegram rate-limit friendly). Never throws. */
async function notifyMany(userIds, text) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  for (const id of ids) {
    await notifyUser(id, text);
    await sleep(50);
  }
}

/* ---------------- daily bonus reminder scheduler ---------------- */

const dailySent = new Set(); // "userId:YYYY-MM-DD"
let dailyTimer = null;

async function checkDailyBonusReminders() {
  try {
    if (!getToken() || !db) return 0;
    const today = new Date().toISOString().slice(0, 10);
    const userIds = await db.listLinkedUsersWithClaimableDaily();
    let sent = 0;
    for (const id of userIds) {
      const key = id + ':' + today;
      if (dailySent.has(key)) continue;
      dailySent.add(key);
      const ok = await notifyUser(id, '🎁 Your daily bonus is ready! Open Ludo Master 3D and claim your free coins.');
      if (ok) sent++;
      await sleep(50);
    }
    if (sent) console.log(`[notify] daily-bonus reminders sent: ${sent}`);
    return sent;
  } catch (e) {
    console.error('[notify] daily tick failed:', e.message);
    return 0;
  }
}

function startDailyScheduler() {
  if (dailyTimer) return;
  // First tick after 60s (lets boot finish), then hourly. unref() so tests can exit.
  const tick = () => { checkDailyBonusReminders(); };
  setTimeout(tick, 60 * 1000).unref?.();
  dailyTimer = setInterval(tick, 60 * 60 * 1000);
  if (dailyTimer.unref) dailyTimer.unref();
  console.log('[notify] daily-bonus scheduler started (hourly)');
}

module.exports = {
  initNotify,
  notifyUser,
  notifyMany,
  startDailyScheduler,
  checkDailyBonusReminders,
  // exposed for tests only
  _dailySent: dailySent,
};

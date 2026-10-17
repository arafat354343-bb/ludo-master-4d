'use strict';

/**
 * Bot naming + behavior wrapper.
 * Move choice itself comes from Engine.chooseBotMove(state); this module only
 * gives bots an identity and a human-like action delay.
 */

const { randomUUID } = require('crypto');

const BOT_NAMES = [
  'Bot Ariful', 'Bot Riya', 'Bot Sakib', 'Bot Nila',
  'Bot Tanvir', 'Bot Mim', 'Bot Rakib', 'Bot Tania',
  'Bot Fahim', 'Bot Keya', 'Bot Nabil', 'Bot Sathi',
];

function createBot(color, usedNames) {
  usedNames = usedNames || new Set();
  const free = BOT_NAMES.filter((n) => !usedNames.has(n));
  const pool = free.length > 0 ? free : BOT_NAMES;
  const name = pool[Math.floor(Math.random() * pool.length)];
  usedNames.add(name);
  return {
    botId: `bot-${randomUUID()}`,
    userId: null, // bots have no user row; never touch the DB for them
    name,
    color: color || null, // assigned by GameManager after shuffle
    isBot: true,
    disconnected: false,
    finishedCount: 0,
    socketId: null,
  };
}

/** ~1.2s human-like delay before a bot acts (override with BOT_DELAY_MS, e.g. in tests). */
function botDelayMs() {
  const base = Number(process.env.BOT_DELAY_MS || 1200);
  return base + Math.random() * 400;
}

module.exports = { createBot, botDelayMs };

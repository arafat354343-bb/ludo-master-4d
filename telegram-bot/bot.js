/* Ludo Master 3D — Telegram bot (WebApp launcher).
 *
 * This bot does ONE job: it gives players a "Play" button that opens the
 * game inside Telegram (like the tap-mining games). The game itself is the
 * existing web client — no game logic lives here.
 *
 * Setup:
 *   1. Talk to @BotFather on Telegram: /newbot -> copy the BOT_TOKEN.
 *   2. In @BotFather: /mybots -> your bot -> Menu Button -> Configure menu
 *      button -> set the Web App URL to https://YOUR_DOMAIN (HTTPS required).
 *   3. On your server: cd telegram-bot && npm install
 *      BOT_TOKEN=<token> GAME_URL=https://YOUR_DOMAIN node bot.js
 *      (or install telegram-bot.service with systemd — see README-TELEGRAM.md)
 *
 * Account linking (for push notifications):
 *   Set SERVER_URL=https://YOUR_DOMAIN (game server base URL, same as GAME_URL
 *   works) and INTERNAL_SECRET=<same value as the game server's INTERNAL_SECRET>.
 *   The app generates a one-time code; the user opens
 *   https://t.me/<bot>?start=link_<code>; this bot forwards it to the game
 *   server's /api/internal/telegram-link endpoint to complete the link.
 *   Without SERVER_URL/INTERNAL_SECRET, linking replies "not configured".
 */
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const gameUrl = (process.env.GAME_URL || '').replace(/\/$/, '');
const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
const internalSecret = process.env.INTERNAL_SECRET || '';

if (!token || !gameUrl) {
  console.error('ERROR: set BOT_TOKEN and GAME_URL env vars.');
  console.error('Example: BOT_TOKEN=123:ABC GAME_URL=https://ludo.example.com node bot.js');
  process.exit(1);
}
if (!gameUrl.startsWith('https://')) {
  console.error('ERROR: Telegram WebApps require HTTPS. GAME_URL must start with https://');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const PLAY_BUTTON = {
  reply_markup: {
    inline_keyboard: [[{ text: '▶️ Play Ludo Now', web_app: { url: gameUrl } }]],
  },
};

bot.onText(/\/start(?:@\w+)?(?:\s+(.*))?$/, (msg, match) => {
  const param = ((match && match[1]) || '').trim();
  if (param.startsWith('link_')) {
    handleLinkStart(msg, param.slice('link_'.length));
    return;
  }
  bot.sendMessage(
    msg.chat.id,
    '🎲 *Welcome to Ludo Master 3D!*\n\n' +
      'Play Ludo online against real players or the computer.\n' +
      'You start with *5410 virtual coins* — coins are just game score, ' +
      'no real money involved.\n\n' +
      'Tap below to open the game:',
    { parse_mode: 'Markdown', ...PLAY_BUTTON }
  );
});

/**
 * Complete an account link: the app gave the user a one-time code, the user
 * tapped https://t.me/<bot>?start=link_<code>, Telegram delivered it here.
 * We forward it to the game server, which validates (10-min expiry,
 * single-use) and stores the telegram_id <-> user_id mapping.
 */
async function handleLinkStart(msg, code) {
  const chatId = msg.chat.id;
  if (!serverUrl || !internalSecret) {
    bot.sendMessage(chatId,
      '⚠️ Account linking is not configured on this bot yet.\nPlease contact the game admin.');
    return;
  }
  if (!code) {
    bot.sendMessage(chatId, '❌ Missing link code. Generate a fresh one: app → Profile → Link Telegram.');
    return;
  }
  try {
    const res = await fetch(serverUrl + '/api/internal/telegram-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: internalSecret,
        code,
        telegram_id: chatId,
        first_name: (msg.from && msg.from.first_name) || '',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok) {
      bot.sendMessage(chatId,
        '✅ *Account linked!* You will get game notifications here:\n\n' +
          '🎁 daily bonus reminders\n' +
          '✅ coin request approvals\n' +
          '⚔️ tournament match alerts\n' +
          '🎮 private room game starts\n' +
          '📢 announcements',
        { parse_mode: 'Markdown', ...PLAY_BUTTON });
    } else {
      bot.sendMessage(chatId,
        '❌ *Link failed:* ' + (data.error || 'unknown error') + '\n\n' +
          'The code may have expired (codes last 10 minutes) or already been used. ' +
          'Generate a fresh code: app → Profile → Link Telegram.',
        { parse_mode: 'Markdown' });
    }
  } catch (e) {
    console.error('[link] server call failed:', e.message);
    bot.sendMessage(chatId, '❌ Could not reach the game server. Please try again in a moment.');
  }
}

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '🎲 *Ludo Master 3D*\n\n' +
      '/start — open the game\n' +
      '/help — this message\n\n' +
      'Or tap the Menu button to launch the game anytime.',
    { parse_mode: 'Markdown', ...PLAY_BUTTON }
  );
});

bot.on('polling_error', (err) => console.error('[polling_error]', err.message));

console.log('Ludo bot running. Game URL:', gameUrl);

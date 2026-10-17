# 🤖 Telegram Bot Setup — Ludo Master 3D

তোমার বট: **[@Lodu_Mastar_bot](https://t.me/Lodu_Mastar_bot)** ✅ (token verified, description সেট)

তোমার গেমকে Telegram-এর ভেতরে চালাও — tap-mining গেমগুলোর মতো।
ইউজার বটে `/start` দিলেই **Play** বাটন, তাতে ট্যাপ করলে গেম Telegram-এর
ভেতরেই খুলবে (WebApp)।

> ⚠️ Telegram WebApp-এর জন্য **HTTPS বাধ্যতামূলক** — আগে DEPLOY.md-এর
> certbot ধাপ শেষ করো, যেন গেম `https://YOUR_DOMAIN`-এ চলে।

## ধাপ ১ — BotFather থেকে বট বানাও (২ মিনিট, ফোন থেকেই)

1. Telegram-এ **@BotFather**-কে মেসেজ দাও
2. `/newbot` → নাম দাও (যেমন `Ludo Master 3D`) → username দাও (যেমন `ludo_master_3d_bot`)
3. BotFather যে **token** দেবে (যেমন `123456:ABC-DEF...`) সেটা কপি করে রাখো
4. `/mybots` → তোমার বট → **Menu Button** → **Configure menu button** →
   Web App URL বসাও: `https://YOUR_DOMAIN`
   (এতে বটের নিচে সবসময় একটা Menu বাটন থাকবে, তাতে ট্যাপ করলেই গেম খুলবে)

## ধাপ ২ — সার্ভারে বট চালাও

```bash
# সার্ভারে:
cd /opt/ludo/telegram-bot
npm install
cat > .env <<EOF
BOT_TOKEN=তোমার_BotFather_token
GAME_URL=https://YOUR_DOMAIN
EOF
chmod 600 .env

# systemd দিয়ে চালাও (reboot-এও নিজে উঠবে):
sudo cp telegram-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bot
sudo journalctl -u telegram-bot -f   # log দেখো
```

## ধাপ ৩ — টেস্ট করো

1. Telegram-এ তোমার বট খোলো → `/start`
2. **▶️ Play Ludo Now** বাটনে ট্যাপ করো → গেম Telegram-এর ভেতরেই খুলবে
3. Sign up / login করে খেলো — সব ফিচার (rooms, AI opponent, coins) কাজ করবে

## নোট

- বটটা শুধু launcher — গেমের কোনো লজিক এখানে নেই, সব আগের সার্ভারেই।
- Virtual coins only — বটে বা গেমে কোথাও টাকা লেনদেন নেই।
- একাধিক বট চাইলে (যেমন আলাদা ভাষার) একই GAME_URL দিয়ে একাধিক বট বানাতে পারো।

---

## 🔔 Telegram Notifications (Push Alerts) — সেটআপ

বট এখন শুধু launcher না — user-এর অ্যাকাউন্টের সাথে link করে Telegram-এ **push notification** পাঠাতে পারে। Virtual coins only — কোথাও টাকা লেনদেন নেই।

### কী কী notification যায়

| ঘটনা | মেসেজ |
|---|---|
| Coin request approve | ✅ Your 5000-coin request was approved! |
| Coin request reject | ❌ Your 5000-coin request was rejected. |
| Daily bonus claimable (প্রতি ঘণ্টায় চেক, দিনে ১ বার) | 🎁 Your daily bonus is ready! |
| Tournament match ready | ⚔️ Your tournament match is ready — open the app and tap Play! |
| Private room game শুরু | 🎮 Your private room game started! |
| Admin announcement publish | 📢 <title> + body (সব linked user-কে) |

### সেটআপ (৩টা env)

**Game server-এ** (`/opt/ludo/server/.env`-তে যোগ করো):

```bash
TELEGRAM_BOT_TOKEN=<BotFather থেকে পাওয়া token>
TELEGRAM_BOT_USERNAME=<তোমার বটের username, @ ছাড়া>   # যেমন: ludo_master_3d_bot
INTERNAL_SECRET=<নিজে বানানো লম্বা random string>      # বট আর সার্ভারের মধ্যে shared secret
```

**Bot host-এ** (`/opt/ludo/telegram-bot/.env`-তে যোগ করো):

```bash
BOT_TOKEN=<একই token>
GAME_URL=https://YOUR_DOMAIN
SERVER_URL=https://YOUR_DOMAIN      # game server-এর base URL (GAME_URL-ই চলবে)
INTERNAL_SECRET=<সার্ভারেরটার সাথে হুবহু একই>
```

তারপর দুটো service-ই restart করো:
```bash
sudo systemctl restart ludo telegram-bot
```

### Linking কীভাবে কাজ করে (user-এর দিক থেকে)

1. App → Profile → **🔗 Link Telegram** বাটনে ট্যাপ
2. `https://t.me/<bot>?start=link_<code>` লিংক খোলে (one-time code, ১০ মিনিট মেয়াদ)
3. বট `/start link_<code>` পায় → সার্ভারের `/api/internal/telegram-link`-এ পাঠায় (INTERNAL_SECRET দিয়ে guarded)
4. সার্ভার code validate করে (মেয়াদ + single-use চেক) → `telegram_links` টেবিলে telegram_id ↔ user_id ম্যাপ সেভ করে
5. বট রিপ্লাই দেয়: "✅ Linked! You'll get game notifications here."

Profile-এ link হয়ে গেলে **✅ Linked** + Unlink বাটন দেখায়।

### কেন internal endpoint? (technical নোট)

বট সরাসরি DB-তে ঢোকে না — দুটো কারণে:
1. সার্ভার in-memory DB fallback-এ চললে বটের আলাদা DB connection কাজ করতো না; internal endpoint সবসময় কাজ করে।
2. Code validation (expiry, single-use) এক জায়গায় (সার্ভারে) থাকে — বট শুধু forward করে।

### Token না থাকলে কী হয়

`TELEGRAM_BOT_TOKEN` সেট না থাকলে সব notification **নীরবে no-op** — গেমের কোথাও crash/error হবে না, শুধু একবার log-এ লাইন আসবে। Linking UI তখন "bot not configured" দেখাবে।

### টেস্ট

```bash
# সার্ভার টেস্টে TELEGRAM_API_BASE=http://localhost:PORT দিয়ে local capture server-এর দিকে
# ঘুরিয়ে sendMessage কলের shape যাচাই করা যায় (দেখো TEST-REPORT.md §13)।
```

# 🚀 Render-এ Deploy — Ludo Master 3D (বাংলা গাইড)

তোমার $50 credit দিয়ে ~৩ মাস hosting চলবে। এই গাইড follow করো।

## খরচ (তোমার $50 থেকে কাটবে)

| Service | Plan | খরচ/মাস |
|---|---|---|
| ludo-game (web) | Starter | $7 |
| ludo-db (PostgreSQL) | Starter | $7 |
| ludo-telegram-bot (worker) | Starter | $7 |
| **মোট** | | **~$21/মাস → ~২.৫ মাস** |

💡 Bot আপাতত না চালালে $14/মাস → ~৩.৫ মাস যাবে। Bot পরে add করা যাবে।

## ধাপ ১ — Code GitHub-এ তোলো

Render GitHub থেকে deploy করে।

```bash
cd ~/ludo-deploy-extracted   # tarball extract করা folder
git init
git add .
git commit -m "Ludo Master 3D v3.3"
# GitHub-এ নতুন private repo বানাও, তারপর:
git remote add origin https://github.com/TOMAR-USERNAME/ludo.git
git push -u origin main
```

> ⚠️ `.env` ফাইলে secret থাকে — repo **private** রাখো। এই package-এ কোনো `.env` নেই, তাই safe।

## ধাপ ২ — Render-এ Blueprint দিয়ে deploy

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
2. তোমার GitHub repo select করো (`render.yaml` auto-detect হবে)
3. **Apply** চাপ দাও — ৩টা service + database একসাথে তৈরি হবে
4. প্রথম build-এ ৩-৫ মিনিট লাগবে

## ধাপ ৩ — Env variables বসাও

**ludo-game** service → Environment:

| Key | Value |
|---|---|
| `ADMIN_EMAILS` | তোমার login email (যেমন `tumi@gmail.com`) |
| `JWT_SECRET` | auto-generated (বদলানোর দরকার নেই) |
| `DATABASE_URL` | auto (database থেকে আসে) |

**ludo-telegram-bot** service → Environment (bot চালাতে চাইলে):

| Key | Value |
|---|---|
| `BOT_TOKEN` | @BotFather-এর দেওয়া token |
| `GAME_URL` | `https://ludo-game-xxxx.onrender.com` (তোমার web service-এর URL) |

> Bot আপাতত skip করতে চাইলে: blueprint apply-এর সময় worker-টা **uncheck** করে দাও, বা পরে dashboard থেকে suspend করো।

## ধাপ ৪ — Database migration (automatic!)

Server প্রথমবার চালু হলে `migrations.sql` **নিজে নিজে** apply করে। কিছু করতে হবে না। Logs-এ দেখবা:
```
[db] migrations applied
[server] listening on :10000
```

## ধাপ ৫ — Test করো

1. `https://ludo-game-xxxx.onrender.com` খোলো → game আসবে
2. Sign up করো (ADMIN_EMAILS-এর email দিয়ে) → তুমি admin
3. `https://ludo-game-xxxx.onrender.com/#/admin` → Admin Panel

## 🔄 Update (নতুন version এলে)

```bash
# নতুন code push করো:
git add . && git commit -m "update" && git push
```
Render **auto-redeploy** করবে। Database-এর data safe থাকবে (migration idempotent)।

## ⚠️ mone rakho

- Render-এর free web tier **ঘুমিয়ে যায়** (15 min idle) — তাই Starter ($7) নিতেই হবে, নইলে game মাঝখানে বন্ধ হবে
- Free PostgreSQL **৩০ দিনে expire** হয় — Starter database নাও
- $50 শেষ হলে Render কার্ড থেকে কাটবে — Billing → Payment-এ limit/alert সেট করে রাখো

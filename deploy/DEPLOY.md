# 🎮 Ludo Master 3D — Cloud Server-এ বসানোর গাইড

তোমার গেম পুরোপুরি তৈরি আর টেস্ট করা ✅ — নিচের ধাপগুলো অনুসরণ করলেই
তোমার cloud server-এ লাইভ হয়ে যাবে। মোট সময়: **১৫–২০ মিনিট**।

> ⚠️ Virtual coin only — গেমে কোথাও টাকা ঢোকানো/তোলার সিস্টেম নেই,
> কয়েন শুধুই গেমের স্কোর।

---

## যা যা লাগবে

- Ubuntu 20.04 / 22.04 / 24.04 cloud server (root বা sudo access)
- সার্ভারের public IP বা domain নাম (যেমন `123.45.67.89` বা `ludo.example.com`)

## ধাপ ১ — ফাইল সার্ভারে তোলো

তোমার কম্পিউটার থেকে `ludo-deploy.tar.gz` ফাইলটা সার্ভারে আপলোড করো
(scp / SFTP / control panel-এর file manager — যেটা সুবিধা):

```bash
# তোমার কম্পিউটার থেকে:
scp ludo-deploy.tar.gz root@YOUR_SERVER_IP:/tmp/
```

তারপর সার্ভারে ঢুকে extract করো:

```bash
ssh root@YOUR_SERVER_IP
cd /tmp && tar -xzf ludo-deploy.tar.gz
ls /tmp/ludo   # server/  shared/  client/  deploy/  থাকবে
```

## ধাপ ২ — এক কমান্ডে সব সেটআপ

```bash
cd /tmp/ludo
sudo ./deploy/setup-server.sh YOUR_DOMAIN_OR_IP
```

`YOUR_DOMAIN_OR_IP`-এর জায়গায় তোমার সার্ভারের **domain বা public IP** বসাও।
যেমন:

```bash
sudo ./deploy/setup-server.sh 123.45.67.89
```

এই একটা কমান্ড যা যা করে দেবে:
1. Node.js 20, PostgreSQL, nginx ইনস্টল
2. `ludo` database + user তৈরি, সব table বানানো
3. গেম সার্ভার চালু (auto-restart সহ — সার্ভার reboot হলেও নিজে চালু হবে)
4. ওয়েবসাইট (client) nginx দিয়ে serve করা
5. `http://YOUR_DOMAIN_OR_IP` — এই ঠিকানায় গেম লাইভ!

## ধাপ ৩ — টেস্ট করো

1. ফোন/ব্রাউজারে যাও: `http://YOUR_DOMAIN_OR_IP`
2. **Sign up** করো → শুরুতেই পাবে **5410 virtual coins** 🎁
3. 2-player রুমে join করো → ~২০ সেকেন্ডে computer opponent (AI) চলে আসবে
4. খেলে জিতলে coin বাড়বে, প্রতিদিন login-এ **+500 bonus coins**

## ঐচ্ছিক: ফ্রি HTTPS (recommended)

Domain থাকলে বিনামূল্যে HTTPS নাও:

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d YOUR_DOMAIN
```

তারপর `/var/www/ludo/js/config.js`-এ `http://` → `https://` করে দাও।

## সমস্যা হলে

```bash
sudo journalctl -u ludo -e     # সার্ভারের log দেখো
sudo systemctl restart ludo     # সার্ভার restart
sudo nginx -t                   # nginx config ঠিক আছে কিনা
curl http://127.0.0.1:3000/api/health   # API বেঁচে আছে কিনা → {"ok":true}
```

---

**টেস্ট রিপোর্ট** (যা যা verify করা হয়েছে): `TEST-REPORT.md` দেখো।

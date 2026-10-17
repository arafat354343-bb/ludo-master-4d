/* Ludo Master 3D — i18n (English / বাংলা).
 * ---------------------------------------------------------------------------
 * HOW TO ADD A NEW USER-FACING STRING:
 *   1. Add the key to BOTH `en` and `bn` below (flat keys, e.g. `home.play`).
 *   2a. Static HTML  -> <span data-i18n="home.play">Play</span>
 *       (keep the English text as content so the page still reads fine if
 *       this script fails to load). Placeholders: data-i18n-ph="key".
 *   2b. JS-rendered  -> t('home.play')  (use {name} for interpolation:
 *       t('game.rolled', { n: v }))
 *   3. Admin panel stays English on purpose — the admin is the technical
 *      owner (see DEVELOPER.md).
 *
 * t(key, vars): current-language string, English fallback, then the key.
 * applyI18n(): rewrites every [data-i18n] / [data-i18n-ph] element.
 * setLang('en'|'bn'): persists to localStorage ('ludo_lang') and fires a
 *   'ludo:lang-changed' event — app.js listens and re-renders the screen.
 * ------------------------------------------------------------------------ */
(function () {
'use strict';

var LANG_KEY = 'ludo_lang';

var I18N = {
en: {
  /* splash */
  'splash.tag': 'Virtual coins only · Just for fun',

  /* auth */
  'auth.login': 'Login',
  'auth.signup': 'Sign Up',
  'auth.email': 'Email',
  'auth.emailOrPhone': 'Email or Phone',
  'auth.emailOrPhonePh': 'you@email.com or 01XXXXXXXXX',
  'auth.phone': 'Phone',
  'auth.phonePh': '01XXXXXXXXX',
  'auth.or': 'or',
  'auth.password': 'Password',
  'auth.name': 'Name',
  'auth.passwordPh': 'Your password',
  'auth.namePh': 'Your name',
  'auth.passwordMinPh': 'Min. 6 characters',
  'auth.createAccount': 'Create Account',
  'auth.note': 'Play with virtual coins. No real money involved.',
  'auth.forgot': 'Forgot password?',
  'auth.forgotNote': 'Enter your email or phone — we\'ll send a 6-digit reset code.',
  'auth.sendCode': 'Send Code',
  'auth.backToLogin': '← Back to login',
  'auth.resetNote': 'Enter the 6-digit code and choose a new password.',
  'auth.code': 'Reset Code',
  'auth.newPassword': 'New Password',
  'auth.resetPassword': 'Reset Password',
  'auth.errEmail': 'Enter a valid email address.',
  'auth.errLoginId': 'Enter a valid email or phone number.',
  'auth.errPhone': 'Enter a valid phone number.',
  'auth.errEmailOrPhone': 'Email or phone is required.',
  'auth.errCode': 'Enter the 6-digit code.',
  'auth.errPassword': 'Enter your password.',
  'auth.errName': 'Name must be at least 2 characters.',
  'auth.errPwLen': 'Password must be at least 6 characters.',
  'auth.errNoToken': 'Server did not return a token.',
  'auth.demoCode': 'Demo code: {code}',
  'auth.resetDone': 'Password reset! Please login with your new password.',
  'auth.welcomeBack': 'Welcome Back!',
  'auth.joinTitle': 'Join the Game!',
  'auth.loginSecure': 'LOGIN SECURELY',
  'auth.newTo': 'New here?',
  'auth.haveAccount': 'Have an account?',
  'auth.forgotTitle': 'Reset Password',

  /* home */
  'home.p2': '2 Player',
  'home.p4': '4 Player',
  'home.online': 'Online Player - ',
  'home.private': 'PRIVATE',
  'home.passPlay': 'Pass & Play',
  'home.buyCoin': 'Buy Coin',
  'home.tournaments': 'Tournaments',
  'home.live': 'LIVE',
  'home.privateRoom': '🔑 Private Room',
  'home.leaderboard': '🏅 Leaderboard',
  'home.downloadApp': 'Download App',
  'home.adminPanel': 'Admin Panel',

  /* landing + nav */
  'lp.badge': 'THE #1 GAMING PLATFORM',
  'lp.playLudo': 'PLAY LUDO',
  'lp.winPrizes': 'WIN BIG PRIZES',
  'lp.sub': 'Join thousands of players on the most exciting Ludo platform. Daily tournaments, fair gameplay, and huge coin prizes waiting for you.',
  'lp.playNow': 'PLAY NOW',
  'lp.players': 'PLAYERS',
  'lp.coinsWon': 'COINS WON',
  'lp.support': 'SUPPORT',
  'lp.tagline': 'Play, Win & Earn Coins',
  'nav.home': 'Home',
  'nav.events': 'Events',
  'nav.wallet': 'Wallet',
  'nav.profile': 'Profile',
  'home.newTag': 'NEW',
  'home.megaTournament': 'Mega Tournament',
  'home.megaSub': 'Join & win big coin prize pools!',
  'home.joinNow': 'Join Now',
  'home.totalBalance': 'TOTAL BALANCE',
  'home.earnCoins': 'EARN COINS',
  'home.playEarn': 'PLAY & EARN',
  'home.referEarn': 'Refer & Earn',
  'home.referEarnSub': 'Get bonus coins',
  'home.tournament': 'Tournament',
  'home.tournamentSub': 'Big Rewards',
  'home.quickPlay': 'QUICK PLAY',
  'home.private': 'PRIVATE',
  'home.leaderboard': 'Leaderboard',

  /* toasts (data-toast keys) */
  'toast.whatsappSoon': 'WhatsApp share — Coming soon',
  'toast.telegramSoon': 'Telegram share — Coming soon',
  'toast.noNotifications': 'No new notifications',
  'toast.settingsSoon': 'Settings — Coming soon',
  'toast.privSoon': 'Private rooms — Coming soon',
  'toast.passPlaySoon': 'Pass & Play — Coming soon',
  'toast.paymentsSoon': 'Payments — Coming soon',

  /* rooms */
  'rooms.twoPlayers': 'Two Players',
  'rooms.fourPlayers': 'Four Players',
  'rooms.loading': 'Loading rooms…',
  'rooms.empty': 'No rooms available right now.',
  'rooms.err': 'Could not load rooms.',
  'rooms.entry': 'Entry : ',
  'rooms.win': 'Win : ',
  'rooms.entryWord': 'Entry',
  'rooms.connecting': 'Connecting to server…',

  /* game HUD */
  'game.players2': '2 Players',
  'game.players4': '4 Players',
  'game.you': 'You',
  'game.yourTurn': 'YOUR TURN',
  'game.turnOf': "{name}'s turn",
  'game.token': 'Token {n}',
  'game.yourMove': 'Your move — tap a glowing token',
  'game.rolled': 'Rolled {n}',
  'game.youWin': 'You Win!',
  'game.gameOver': 'Game Over',
  'game.winner': 'Winner: ',
  'game.wonCoins': 'You won +{n} coins',
  'game.betterLuck': 'Better luck next time',
  'game.deltaCoins': ' ({sign}{n} coins)',
  'go.home': 'Home',

  /* quick chat presets (server sends msgId; client renders in user lang) */
  'qc.m1': 'Good luck! 🍀',
  'qc.m2': 'Nice move! 👏',
  'qc.m3': 'Oops! 😅',
  'qc.m4': 'Well played! 🎉',
  'qc.m5': 'Your turn! ⏰',
  'qc.m6': 'Haha! 😂',

  /* waiting overlay */
  'wait.title': 'Finding players…',
  'wait.cancel': 'Cancel',
  'wait.waiting': 'Waiting:',

  /* dashboard */
  'dash.title': 'Dashboard',
  'dash.played': 'Games Played',
  'dash.won': 'Games Won',
  'dash.winRate': 'Win Rate',
  'dash.coins': 'Coins',
  'dash.earned': 'Total Earned',
  'dash.wins2p': '2P Wins',
  'dash.wins4p': '4P Wins',
  'dash.loading': 'Loading stats…',
  'dash.err': 'Could not load stats.',

  /* wallet */
  'wallet.title': 'Wallet',
  'wallet.coins': 'coins',
  'wallet.dailyBonus': 'Daily Bonus',
  'wallet.addCash': 'ADD CASH',
  'wallet.withdraw': 'WITHDRAW',
  'wallet.soon': 'SOON',
  'wallet.comingSoon': 'Coming soon!',
  'wallet.history': 'History',
  'wallet.buyCoins': 'Buy Coins',
  'wallet.referral': 'Referral',
  'wallet.emptyHistory': 'No transactions yet. Play a game or claim your daily bonus!',
  'wallet.buyHint': 'Choose a pack — your request goes to the admin for approval. Coins are credited after approval.',
  'wallet.myRequests': 'MY REQUESTS',
  'wallet.packReq': '{n} coins pack',
  'wallet.noRequests': 'No requests yet.',
  'wallet.requestSent': 'Request sent — pending admin approval',
  'wallet.payTitle': 'Payment Proof',
  'wallet.payNote': 'Send money via bKash/Nagad/Rocket, then enter the details below. The admin will verify and approve.',
  'wallet.payMethod': 'Payment Method',
  'wallet.payTxid': 'Transaction ID',
  'wallet.payTxidPh': 'e.g. 9HX7K2LM4P',
  'wallet.paySubmit': 'Submit Request',
  'wallet.errTxid': 'Enter the transaction ID from your payment.',
  'wallet.refHint': 'Share your code — when a friend signs up with it, you both earn bonus coins.',
  'wallet.refEarnings': 'Total referral earnings: +{n} coins',
  'wallet.refCopied': 'Referral code copied',

  /* coin modal */
  'coin.title': 'Buy Coin',
  'coin.daily': 'Claim Daily Bonus',
  'coin.claiming': 'Claiming…',
  'coin.claimedAmt': 'Bonus claimed: +{n} coins!',
  'coin.claimed': 'Daily bonus claimed!',
  'coin.toastAmt': 'Daily bonus: +{n} coins',
  'coin.packs': 'COIN PACKS',
  'coin.demoNote': 'Demo build — no payments. Packs are disabled.',

  /* profile */
  'prof.title': 'My Profile',
  'prof.matches': 'MATCHES',
  'prof.won': 'WON',
  'prof.winRate': 'WIN RATE',
  'prof.accountInfo': 'ACCOUNT INFO',
  'prof.email': 'EMAIL',
  'prof.phone': 'PHONE',
  'prof.editDetails': 'EDIT DETAILS',
  'prof.viewStats': 'View Statistics',
  'prof.sound': 'SOUND',
  'prof.soundOn': 'Sound ON',
  'prof.soundOff': 'Sound OFF',
  'prof.earning': 'Current Earning :',
  'prof.money': 'Current money:',
  'prof.stats': 'STATISTICS',
  'prof.won': 'Games won:',
  'prof.played': 'Games played:',
  'prof.winRate': 'Win rate:',
  'prof.wins2p': '2 players wins:',
  'prof.wins4p': '4 players wins:',
  'prof.refEarnings': 'Referral Earnings:',
  'prof.refCode': 'My referral code:',
  'prof.telegram': 'Telegram alerts:',
  'prof.payment': 'Payment',
  'prof.logout': 'Logout',
  'prof.copied': 'Referral code copied',
  'prof.codeIs': 'Code: {code}',
  'prof.editHint': 'Edit your name, then tap the pencil again to save',
  'prof.nameUpdated': 'Name updated',
  'prof.lang': 'Language / ভাষা:',

  /* telegram linking */
  'tg.linkTelegram': '🔗 Link Telegram',
  'tg.unlink': 'Unlink',
  'tg.linkedBadge': '✅ Linked',
  'tg.unlinked': 'Telegram unlinked',
  'tg.finishLinking': 'Finish linking in Telegram, then come back',
  'tg.noBot': 'Telegram bot not configured yet — ask the admin',
  'tg.linked': '✅ Telegram linked!',

  /* support */
  'sup.title': 'Support Chat',
  'sup.placeholder': 'Type your message…',
  'sup.send': 'Send',
  'sup.empty': 'No messages yet — say hello!',
  'sup.newReply': 'New reply from support',
  'sup.notConnected': 'Not connected — try again in a moment',
  'sup.loading': 'Loading…',
  'sup.connecting': 'Connecting…',

  /* tournaments */
  'tour.title': '🏆 Tournaments',
  'tour.detailTitle': 'Tournament',
  'tour.loading': 'Loading tournaments…',
  'tour.empty': 'No tournaments yet. Check back soon! 🏆',
  'tour.full': 'Full',
  'tour.view': 'View',
  'tour.all': 'All',
  'tour.tournamentsWord': 'Tournaments',
  'tour.tabAll': 'All Match',
  'tour.tabLive': 'Live Now',
  'tour.tabUpcoming': 'Upcoming',
  'tour.feeFilter': 'All Entry Fees',
  'tour.map': 'MAP',
  'tour.classic': 'Classic',
  'tour.prizePool': 'PRIZE POOL',
  'tour.entryFee': 'ENTRY FEE',
  'tour.joinedPlayers': 'Joined Players',
  'tour.joinMatch': 'JOIN MATCH',
  'tour.prizePool': 'Prize pool',
  'tour.stUpcoming': 'Upcoming',
  'tour.stFilling': 'Filling fast',
  'tour.stLive': 'LIVE',
  'tour.stCompleted': 'Completed',
  'tour.stCancelled': 'Cancelled',
  'tour.tba': 'Start date TBA',
  'tour.startingSoon': 'Starting soon…',
  'tour.startsInM': 'Starts in {m}m',
  'tour.startsInH': 'Starts in {h}h {m}m',
  'tour.startsOn': 'Starts {date}',
  'tour.joinClosesIn': 'Joining closes in {mmss}',
  'tour.joinWindowOver': 'Join window expired',
  'wallet.txHistory': 'Transaction History',
  'wallet.colDate': 'Date',
  'wallet.colDetails': 'Details',
  'wallet.colCoins': 'Coins',
  'tour.joinCoins': 'Join — {n} coins',
  'tour.joined': "✅ You're in! The bracket appears when the tournament starts.",
  'tour.matchReady': '⚔️ Your match is ready — {opp}',
  'tour.playMatch': '▶ Play My Match',
  'tour.imReady': "I'm ready",
  'tour.bracket': 'BRACKET',
  'tour.players': 'PLAYERS ({n})',
  'tour.noPlayers': 'No players yet.',
  'tour.walkover': 'bye → advances',
  'tour.final': 'Final',
  'tour.semifinal': 'Semifinal',
  'tour.round': 'Round {n}',
  'tour.vs': 'vs',
  'tour.joinedToast': 'Joined! Entry fee deducted.',
  'tour.startingMatch': 'Starting your match…',
  'tour.connecting': 'Connecting… tap Play again in a moment.',
  'tour.markedReady': 'Marked ready — your opponent has been notified.',

  /* private rooms */
  'priv.title': 'Private Room',
  'priv.createTitle': '🔑 Create Room',
  'priv.createHint': 'Set your own entry fee. Share the invite code — the game starts automatically when the room is full.',
  'priv.entryLabel': 'Entry fee (coins, 50–100000)',
  'priv.seats2': '2 Players',
  'priv.seats4': '4 Players',
  'priv.create': 'Create Room',
  'priv.joinTitle': '📩 Join Room',
  'priv.joinHint': 'Enter the 6-character invite code from your friend.',
  'priv.join': 'Join Room',
  'priv.commNote': 'Winner gets the pool minus {n}% commission.',
  'priv.created': 'Room created — share the code!',
  'priv.badCode': 'Enter a valid 6-character code',
  'priv.started': 'Game started!',
  'priv.shareCode': 'Share this code with your friends',
  'priv.copyCode': 'Copy code',
  'priv.prizeNote': 'Prize pool {pool} − {pct}% commission → winner gets {prize} coins',
  'priv.waiting': 'Waiting for players… game starts automatically when full.',
  'priv.cancel': 'Cancel Room (refunds everyone)',
  'priv.leave': 'Leave Room (refund)',
  'priv.codeCopied': 'Code copied',
  'priv.cancelled': 'Room cancelled — everyone refunded',
  'priv.left': 'Left the room — entry refunded',
  'priv.closed': 'Room closed',

  /* leaderboard + missions */
  'lb.title': 'Leaderboard',
  'lb.tabBoard': '🏅 Leaderboard',
  'lb.tabMissions': '🎯 Missions',
  'lb.weekly': 'Weekly',
  'lb.allTime': 'All Time',
  'lb.loading': 'Loading leaderboard…',
  'lb.yourRank': 'Your rank: #{rank} · {wins} wins',
  'lb.unranked': 'Unranked — win games to appear on the board!',
  'lb.empty': 'No winners yet this {period}. Be the first! 🏆',
  'lb.week': 'week',
  'lb.periodWord': 'period',
  'lb.playedGames': '{n} played',
  'lb.missionsHint': 'New missions every day (UTC). Complete them to earn bonus coins!',
  'lb.claimed': 'Claimed ✓',
  'lb.claim': 'Claim +{n}',
  'lb.reward': '+{n}',
  'lb.rewardToast': 'Mission reward: +{n} coins 🎉',
  'lb.missionsLoading': 'Loading missions…',

  /* wallet history kinds (server KIND_LABELS fallback) */
  'kind.signup_bonus': 'Signup bonus',
  'kind.daily_bonus': 'Daily bonus',
  'kind.referral_bonus': 'Referral bonus',
  'kind.entry_fee': 'Game entry fee',
  'kind.win': 'Game winnings',
  'kind.admin_grant': 'Admin credit',
  'kind.commission': 'House commission',
  'kind.mission_bonus': 'Mission reward',
  'kind.private_entry': 'Private room entry',
  'kind.private_refund': 'Private room refund',
  'kind.private_win': 'Private room winnings',
  'kind.tournament_entry': 'Tournament entry fee',
  'kind.tournament_refund': 'Tournament refund',
  'kind.tournament_win': 'Tournament prize',
  'kind.coin_store': 'Free coin pack',
  'kind.redeem_code': 'Reward code',

  /* coin store */
  'store.title': 'Coin Store',
  'store.sub': 'Free coin packs — claim each pack once a day. No payment, ever.',
  'store.free': 'FREE',
  'store.claim': 'Claim',
  'store.claimed': 'Claimed — back tomorrow',
  'store.addCoins': 'Add Coins',
  'store.claimedToast': '+{n} coins claimed! 🎉',

  /* redeem rewards */
  'redeem.title': 'Redeem Rewards',
  'redeem.redeem': 'Redeem',
  'redeem.balance': 'Wallet Balance',
  'redeem.codeLabel': 'Reward code',
  'redeem.codePh': 'e.g. WELCOME50',
  'redeem.submit': 'Submit',
  'redeem.hint': 'Got a reward code from an event or announcement? Enter it above for free coins.',
  'redeem.successToast': '+{n} coins redeemed! 🎉',
  'redeem.errEmpty': 'Enter your reward code.',
  'redeem.errInvalid': 'Invalid code. Check and try again.',
  'redeem.errUsed': 'You have already used this code.',
  'redeem.errExhausted': 'This code has reached its usage limit.',

  /* install modal */
  'install.title': 'Download App',
  'install.note': 'Install Ludo Master 3D on your phone — it will appear on your home screen like a real app, no Play Store needed.',
  'install.ios1': 'Tap the <b>Share</b> button in Safari (square with arrow).',
  'install.ios2': 'Scroll down and tap <b>Add to Home Screen</b>.',
  'install.ios3': 'Tap <b>Add</b> — the game icon appears on your home screen.',
  'install.and1': 'Tap the <b>⋮</b> menu in Chrome (top-right corner).',
  'install.and2': 'Tap <b>Install app</b> or <b>Add to Home screen</b>.',
  'install.and3': 'Confirm — the game icon appears on your home screen.',

  /* shared */
  'common.ok': 'OK',
  'common.loading': 'Loading…',
  'common.connecting': 'Connecting…',
  'common.join': 'Join',
  'common.copy': 'Copy',
  'common.share': 'Share',
  'common.cancel': 'Cancel',
  'common.home': 'Home',
  'common.coins': 'coins',
  'common.view': 'View',
  'err.network': 'Network error — is the server running?',
  'err.session': 'Session expired — please log in again.'
},
bn: {
  /* splash */
  'splash.tag': 'শুধু ভার্চুয়াল কয়েন · মজার জন্য খেলো',

  /* auth */
  'auth.login': 'লগইন',
  'auth.signup': 'সাইন আপ',
  'auth.email': 'ইমেইল',
  'auth.emailOrPhone': 'ইমেইল বা ফোন',
  'auth.emailOrPhonePh': 'you@email.com বা 01XXXXXXXXX',
  'auth.phone': 'ফোন',
  'auth.phonePh': '01XXXXXXXXX',
  'auth.or': 'বা',
  'auth.password': 'পাসওয়ার্ড',
  'auth.name': 'নাম',
  'auth.passwordPh': 'তোমার পাসওয়ার্ড',
  'auth.namePh': 'তোমার নাম',
  'auth.passwordMinPh': 'কমপক্ষে ৬ অক্ষর',
  'auth.createAccount': 'অ্যাকাউন্ট খোলো',
  'auth.note': 'ভার্চুয়াল কয়েন দিয়ে খেলো। আসল টাকার কোনো ব্যাপার নেই।',
  'auth.forgot': 'পাসওয়ার্ড ভুলে গেছো?',
  'auth.forgotNote': 'তোমার ইমেইল বা ফোন দাও — ৬ সংখ্যার রিসেট কোড পাঠাবো।',
  'auth.sendCode': 'কোড পাঠাও',
  'auth.backToLogin': '← লগইনে ফিরে যাও',
  'auth.resetNote': '৬ সংখ্যার কোড দাও ও নতুন পাসওয়ার্ড বেছে নাও।',
  'auth.code': 'রিসেট কোড',
  'auth.newPassword': 'নতুন পাসওয়ার্ড',
  'auth.resetPassword': 'পাসওয়ার্ড রিসেট করো',
  'auth.errEmail': 'সঠিক ইমেইল ঠিকানা দাও।',
  'auth.errLoginId': 'সঠিক ইমেইল বা ফোন নম্বর দাও।',
  'auth.errPhone': 'সঠিক ফোন নম্বর দাও।',
  'auth.errEmailOrPhone': 'ইমেইল বা ফোন আবশ্যক।',
  'auth.errCode': '৬ সংখ্যার কোড দাও।',
  'auth.errPassword': 'তোমার পাসওয়ার্ড দাও।',
  'auth.errName': 'নাম কমপক্ষে ২ অক্ষরের হতে হবে।',
  'auth.errPwLen': 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।',
  'auth.errNoToken': 'সার্ভার থেকে টোকেন আসেনি।',
  'auth.demoCode': 'ডেমো কোড: {code}',
  'auth.resetDone': 'পাসওয়ার্ড রিসেট হয়েছে! নতুন পাসওয়ার্ড দিয়ে লগইন করো।',
  'auth.welcomeBack': 'ফিরে আসায় স্বাগতম!',
  'auth.joinTitle': 'গেমে যোগ দাও!',
  'auth.loginSecure': 'নিরাপদে লগইন',
  'auth.newTo': 'নতুন?',
  'auth.haveAccount': 'অ্যাকাউন্ট আছে?',
  'auth.forgotTitle': 'পাসওয়ার্ড রিসেট',

  /* home */
  'home.p2': '2 প্লেয়ার',
  'home.p4': '4 প্লেয়ার',
  'home.online': 'অনলাইন প্লেয়ার - ',
  'home.private': 'প্রাইভেট',
  'home.passPlay': 'পাস অ্যান্ড প্লে',
  'home.buyCoin': 'কয়েন কিনো',
  'home.tournaments': 'টুর্নামেন্ট',
  'home.live': 'লাইভ',
  'home.privateRoom': '🔑 প্রাইভেট রুম',
  'home.leaderboard': '🏅 লিডারবোর্ড',
  'home.downloadApp': 'অ্যাপ ডাউনলোড',
  'home.adminPanel': 'অ্যাডমিন প্যানেল',

  'lp.badge': '#১ গেমিং প্ল্যাটফর্ম',
  'lp.playLudo': 'লুডো খেলো',
  'lp.winPrizes': 'বড় পুরস্কার জিতো',
  'lp.sub': 'হাজারো খেলোয়াড়ের সাথে সবচেয়ে মজার লুডো প্ল্যাটফর্মে যোগ দাও। ডেইলি টুর্নামেন্ট, ফেয়ার গেমপ্লে আর বিশাল কয়েন পুরস্কার তোমার অপেক্ষায়।',
  'lp.playNow': 'এখনই খেলো',
  'lp.players': 'খেলোয়াড়',
  'lp.coinsWon': 'কয়েন জয়',
  'lp.support': 'সাপোর্ট',
  'lp.tagline': 'খেলো, জিতো ও কয়েন আয় করো',
  'nav.home': 'হোম',
  'nav.events': 'ইভেন্ট',
  'nav.wallet': 'ওয়ালেট',
  'nav.profile': 'প্রোফাইল',
  'home.newTag': 'নতুন',
  'home.megaTournament': 'মেগা টুর্নামেন্ট',
  'home.megaSub': 'যোগ দাও ও বড় কয়েন প্রাইজ পুল জিতো!',
  'home.joinNow': 'যোগ দাও',
  'home.totalBalance': 'মোট ব্যালেন্স',
  'home.earnCoins': 'কয়েন আয় করো',
  'home.playEarn': 'খেলো ও আয় করো',
  'home.referEarn': 'রেফার করো',
  'home.referEarnSub': 'বোনাস কয়েন পাও',
  'home.tournament': 'টুর্নামেন্ট',
  'home.tournamentSub': 'বড় পুরস্কার',
  'home.quickPlay': 'কুইক প্লে',
  'home.private': 'প্রাইভেট',
  'home.leaderboard': 'লিডারবোর্ড',

  /* toasts */
  'toast.whatsappSoon': 'হোয়াটসঅ্যাপ শেয়ার — শীঘ্রই আসছে',
  'toast.telegramSoon': 'টেলিগ্রাম শেয়ার — শীঘ্রই আসছে',
  'toast.noNotifications': 'নতুন কোনো নোটিফিকেশন নেই',
  'toast.settingsSoon': 'সেটিংস — শীঘ্রই আসছে',
  'toast.privSoon': 'প্রাইভেট রুম — শীঘ্রই আসছে',
  'toast.passPlaySoon': 'পাস অ্যান্ড প্লে — শীঘ্রই আসছে',
  'toast.paymentsSoon': 'পেমেন্ট — শীঘ্রই আসছে',

  /* rooms */
  'rooms.twoPlayers': '2 প্লেয়ার',
  'rooms.fourPlayers': '4 প্লেয়ার',
  'rooms.loading': 'রুম লোড হচ্ছে…',
  'rooms.empty': 'এখন কোনো রুম নেই।',
  'rooms.err': 'রুম লোড করা যায়নি।',
  'rooms.entry': 'এন্ট্রি : ',
  'rooms.win': 'উইন : ',
  'rooms.entryWord': 'এন্ট্রি',
  'rooms.connecting': 'সার্ভারে কানেক্ট হচ্ছে…',

  /* game HUD */
  'game.players2': '2 প্লেয়ার',
  'game.players4': '4 প্লেয়ার',
  'game.you': 'তুমি',
  'game.yourTurn': 'তোমার চাল',
  'game.turnOf': '{name}-এর চাল',
  'game.token': 'গুটি {n}',
  'game.yourMove': 'তোমার চাল — জ্বলজ্বলে গুটিতে ট্যাপ করো',
  'game.rolled': '{n} পড়েছে',
  'game.youWin': 'তুমি জিতেছো! 🎉',
  'game.gameOver': 'খেলা শেষ',
  'game.winner': 'বিজয়ী: ',
  'game.wonCoins': 'তুমি +{n} কয়েন জিতেছো',
  'game.betterLuck': 'পরের বার ভালো হবে',
  'game.deltaCoins': ' ({sign}{n} কয়েন)',
  'go.home': 'হোম',

  /* quick chat presets */
  'qc.m1': 'শুভকামনা! 🍀',
  'qc.m2': 'দারুণ চাল! 👏',
  'qc.m3': 'উফ! 😅',
  'qc.m4': 'দারুণ খেলেছো! 🎉',
  'qc.m5': 'তোমার পালা! ⏰',
  'qc.m6': 'হাহা! 😂',

  /* waiting overlay */
  'wait.title': 'প্লেয়ার খোঁজা হচ্ছে…',
  'wait.cancel': 'বাতিল',
  'wait.waiting': 'অপেক্ষা:',

  /* dashboard */
  'dash.title': 'ড্যাশবোর্ড',
  'dash.played': 'মোট খেলা',
  'dash.won': 'জয়',
  'dash.winRate': 'জয়ের হার',
  'dash.coins': 'কয়েন',
  'dash.earned': 'মোট আয়',
  'dash.wins2p': '2P জয়',
  'dash.wins4p': '4P জয়',
  'dash.loading': 'পরিসংখ্যান লোড হচ্ছে…',
  'dash.err': 'পরিসংখ্যান লোড করা যায়নি।',

  /* wallet */
  'wallet.title': 'ওয়ালেট',
  'wallet.coins': 'কয়েন',
  'wallet.dailyBonus': 'ডেইলি বোনাস',
  'wallet.addCash': 'অ্যাড ক্যাশ',
  'wallet.withdraw': 'উইথড্র',
  'wallet.soon': 'শীঘ্রই',
  'wallet.comingSoon': 'শীঘ্রই আসছে!',
  'wallet.history': 'হিস্টরি',
  'wallet.buyCoins': 'কয়েন কিনো',
  'wallet.referral': 'রেফারেল',
  'wallet.emptyHistory': 'এখনো কোনো লেনদেন নেই। গেম খেলো বা ডেইলি বোনাস নাও!',
  'wallet.buyHint': 'প্যাক বেছে নাও — তোমার রিকোয়েস্ট অ্যাডমিনের কাছে যাবে। অনুমোদনের পর কয়েন যোগ হবে।',
  'wallet.myRequests': 'আমার রিকোয়েস্ট',
  'wallet.packReq': '{n} কয়েনের প্যাক',
  'wallet.noRequests': 'এখনো কোনো রিকোয়েস্ট নেই।',
  'wallet.requestSent': 'রিকোয়েস্ট পাঠানো হয়েছে — অ্যাডমিনের অনুমোদনের অপেক্ষায়',
  'wallet.payTitle': 'পেমেন্ট প্রমাণ',
  'wallet.payNote': 'বিকাশ/নগদ/রকেটে টাকা পাঠাও, তারপর নিচে তথ্য দাও। অ্যাডমিন যাচাই করে অনুমোদন দেবে।',
  'wallet.payMethod': 'পেমেন্ট মাধ্যম',
  'wallet.payTxid': 'ট্রানজেকশন আইডি',
  'wallet.payTxidPh': 'যেমন: 9HX7K2LM4P',
  'wallet.paySubmit': 'রিকোয়েস্ট পাঠাও',
  'wallet.errTxid': 'তোমার পেমেন্টের ট্রানজেকশন আইডি দাও।',
  'wallet.refHint': 'তোমার কোড শেয়ার করো — বন্ধু এই কোডে সাইন আপ করলে দুজনেই বোনাস পাবে।',
  'wallet.refEarnings': 'মোট রেফারেল আয়: +{n} কয়েন',
  'wallet.refCopied': 'রেফারেল কোড কপি হয়েছে',

  /* coin modal */
  'coin.title': 'কয়েন কিনো',
  'coin.daily': 'ডেইলি বোনাস নাও',
  'coin.claiming': 'নেওয়া হচ্ছে…',
  'coin.claimedAmt': 'বোনাস পেয়েছো: +{n} কয়েন!',
  'coin.claimed': 'ডেইলি বোনাস নেওয়া হয়েছে!',
  'coin.toastAmt': 'ডেইলি বোনাস: +{n} কয়েন',
  'coin.packs': 'কয়েন প্যাক',
  'coin.demoNote': 'ডেমো ভার্সন — কোনো পেমেন্ট নেই। প্যাক বন্ধ আছে।',

  /* profile */
  'prof.title': 'আমার প্রোফাইল',
  'prof.matches': 'ম্যাচ',
  'prof.won': 'জয়',
  'prof.winRate': 'জয়ের হার',
  'prof.accountInfo': 'অ্যাকাউন্ট তথ্য',
  'prof.email': 'ইমেইল',
  'prof.phone': 'ফোন',
  'prof.editDetails': 'এডিট করো',
  'prof.viewStats': 'পরিসংখ্যান দেখো',
  'prof.sound': 'সাউন্ড',
  'prof.soundOn': 'সাউন্ড চালু',
  'prof.soundOff': 'সাউন্ড বন্ধ',
  'prof.earning': 'বর্তমান আয় :',
  'prof.money': 'বর্তমান কয়েন:',
  'prof.stats': 'পরিসংখ্যান',
  'prof.won': 'জিতেছো:',
  'prof.played': 'খেলেছো:',
  'prof.winRate': 'জয়ের হার:',
  'prof.wins2p': '2 প্লেয়ার জয়:',
  'prof.wins4p': '4 প্লেয়ার জয়:',
  'prof.refEarnings': 'রেফারেল আয়:',
  'prof.refCode': 'আমার রেফারেল কোড:',
  'prof.telegram': 'টেলিগ্রাম অ্যালার্ট:',
  'prof.payment': 'পেমেন্ট',
  'prof.logout': 'লগআউট',
  'prof.copied': 'রেফারেল কোড কপি হয়েছে',
  'prof.codeIs': 'কোড: {code}',
  'prof.editHint': 'নাম বদলে আবার পেন্সিলে ট্যাপ করো',
  'prof.nameUpdated': 'নাম বদলে গেছে',
  'prof.lang': 'ভাষা / Language:',

  /* telegram linking */
  'tg.linkTelegram': '🔗 টেলিগ্রাম লিংক করো',
  'tg.unlink': 'আনলিংক',
  'tg.linkedBadge': '✅ লিংকড',
  'tg.unlinked': 'টেলিগ্রাম আনলিংক হয়েছে',
  'tg.finishLinking': 'টেলিগ্রামে লিংক শেষ করে ফিরে এসো',
  'tg.noBot': 'টেলিগ্রাম বট এখনো সেট হয়নি — অ্যাডমিনকে বলো',
  'tg.linked': '✅ টেলিগ্রাম লিংক হয়েছে!',

  /* support */
  'sup.title': 'সাপোর্ট চ্যাট',
  'sup.placeholder': 'তোমার মেসেজ লেখো…',
  'sup.send': 'পাঠাও',
  'sup.empty': 'এখনো মেসেজ নেই — হ্যালো বলো!',
  'sup.newReply': 'সাপোর্ট থেকে নতুন উত্তর এসেছে',
  'sup.notConnected': 'কানেক্ট হয়নি — একটু পরে আবার চেষ্টা করো',
  'sup.loading': 'লোড হচ্ছে…',
  'sup.connecting': 'কানেক্ট হচ্ছে…',

  /* tournaments */
  'tour.title': '🏆 টুর্নামেন্ট',
  'tour.detailTitle': 'টুর্নামেন্ট',
  'tour.loading': 'টুর্নামেন্ট লোড হচ্ছে…',
  'tour.empty': 'এখনো কোনো টুর্নামেন্ট নেই। পরে আবার দেখো! 🏆',
  'tour.full': 'ভর্তি',
  'tour.view': 'দেখো',
  'tour.all': 'সব',
  'tour.tournamentsWord': 'টুর্নামেন্ট',
  'tour.tabAll': 'সব ম্যাচ',
  'tour.tabLive': 'লাইভ',
  'tour.tabUpcoming': 'আসন্ন',
  'tour.feeFilter': 'সব এন্ট্রি ফি',
  'tour.map': 'ম্যাপ',
  'tour.classic': 'ক্লাসিক',
  'tour.prizePool': 'পুরস্কার',
  'tour.entryFee': 'এন্ট্রি ফি',
  'tour.joinedPlayers': 'যোগ দিয়েছে',
  'tour.joinMatch': 'যোগ দাও',
  'tour.prizePool': 'প্রাইজ পুল',
  'tour.stUpcoming': 'আসছে',
  'tour.stFilling': 'ভরছে',
  'tour.stLive': 'লাইভ',
  'tour.stCompleted': 'শেষ',
  'tour.stCancelled': 'বাতিল',
  'tour.tba': 'শুরুর তারিখ জানানো হবে',
  'tour.startingSoon': 'শীঘ্রই শুরু হচ্ছে…',
  'tour.startsInM': '{m} মিনিট পর শুরু',
  'tour.startsInH': '{h} ঘণ্টা {m} মিনিট পর শুরু',
  'tour.startsOn': '{date}-এ শুরু',
  'tour.joinClosesIn': 'যোগদান বন্ধ হতে {mmss}',
  'tour.joinWindowOver': 'যোগদানের সময় শেষ',
  'wallet.txHistory': 'লেনদেনের ইতিহাস',
  'wallet.colDate': 'তারিখ',
  'wallet.colDetails': 'বিবরণ',
  'wallet.colCoins': 'কয়েন',
  'tour.joinCoins': 'যোগ দাও — {n} কয়েন',
  'tour.joined': '✅ তুমি ভেতরে! টুর্নামেন্ট শুরু হলে ব্র্যাকেট দেখা যাবে।',
  'tour.matchReady': '⚔️ তোমার ম্যাচ রেডি — {opp}',
  'tour.playMatch': '▶ আমার ম্যাচ খেলো',
  'tour.imReady': 'আমি রেডি',
  'tour.bracket': 'ব্র্যাকেট',
  'tour.players': 'প্লেয়ার ({n})',
  'tour.noPlayers': 'এখনো কোনো প্লেয়ার নেই।',
  'tour.walkover': 'বাই → এগিয়ে গেল',
  'tour.final': 'ফাইনাল',
  'tour.semifinal': 'সেমিফাইনাল',
  'tour.round': 'রাউন্ড {n}',
  'tour.vs': 'বনাম',
  'tour.joinedToast': 'যোগ দিয়েছো! এন্ট্রি ফি কাটা হয়েছে।',
  'tour.startingMatch': 'তোমার ম্যাচ শুরু হচ্ছে…',
  'tour.connecting': 'কানেক্ট হচ্ছে… একটু পরে আবার প্লে চাপো।',
  'tour.markedReady': 'রেডি চিহ্নিত — প্রতিপক্ষকে জানানো হয়েছে।',

  /* private rooms */
  'priv.title': 'প্রাইভেট রুম',
  'priv.createTitle': '🔑 রুম খোলো',
  'priv.createHint': 'নিজের এন্ট্রি ফি ঠিক করো। ইনভাইট কোড শেয়ার করো — রুম ভরলেই খেলা নিজে নিজে শুরু হবে।',
  'priv.entryLabel': 'এন্ট্রি ফি (কয়েন, 50–100000)',
  'priv.seats2': '2 প্লেয়ার',
  'priv.seats4': '4 প্লেয়ার',
  'priv.create': 'রুম খোলো',
  'priv.joinTitle': '📩 রুমে যোগ দাও',
  'priv.joinHint': 'বন্ধুর দেওয়া ৬ অক্ষরের ইনভাইট কোড দাও।',
  'priv.join': 'যোগ দাও',
  'priv.commNote': 'বিজয়ী পাবে মোট পুল থেকে {n}% কমিশন বাদে।',
  'priv.created': 'রুম খোলা হয়েছে — কোড শেয়ার করো!',
  'priv.badCode': 'সঠিক ৬ অক্ষরের কোড দাও',
  'priv.started': 'খেলা শুরু!',
  'priv.shareCode': 'বন্ধুদের সাথে এই কোড শেয়ার করো',
  'priv.copyCode': 'কোড কপি',
  'priv.prizeNote': 'মোট পুল {pool} − {pct}% কমিশন → বিজয়ী পাবে {prize} কয়েন',
  'priv.waiting': 'প্লেয়ারের অপেক্ষায়… রুম ভরলেই খেলা শুরু হবে।',
  'priv.cancel': 'রুম বাতিল (সবার কয়েন ফেরত)',
  'priv.leave': 'রুম ছাড়ো (ফেরত পাবে)',
  'priv.codeCopied': 'কোড কপি হয়েছে',
  'priv.cancelled': 'রুম বাতিল — সবার কয়েন ফেরত',
  'priv.left': 'রুম ছেড়েছো — এন্ট্রি ফেরত',
  'priv.closed': 'রুম বন্ধ',

  /* leaderboard + missions */
  'lb.title': 'লিডারবোর্ড',
  'lb.tabBoard': '🏅 লিডারবোর্ড',
  'lb.tabMissions': '🎯 মিশন',
  'lb.weekly': 'সাপ্তাহিক',
  'lb.allTime': 'সব সময়',
  'lb.loading': 'লিডারবোর্ড লোড হচ্ছে…',
  'lb.yourRank': 'তোমার র‍্যাংক: #{rank} · {wins} জয়',
  'lb.unranked': 'র‍্যাংক নেই — বোর্ডে আসতে গেম জেতো!',
  'lb.empty': 'এই {period} এখনো কেউ জেতেনি। প্রথম হও! 🏆',
  'lb.week': 'সপ্তাহে',
  'lb.periodWord': 'সময়ে',
  'lb.playedGames': '{n}টি খেলা',
  'lb.missionsHint': 'প্রতিদিন নতুন মিশন (UTC)। শেষ করে বোনাস কয়েন জেতো!',
  'lb.claimed': 'নেওয়া হয়েছে ✓',
  'lb.claim': '+{n} নাও',
  'lb.reward': '+{n}',
  'lb.rewardToast': 'মিশন পুরস্কার: +{n} কয়েন 🎉',
  'lb.missionsLoading': 'মিশন লোড হচ্ছে…',

  /* wallet history kinds */
  'kind.signup_bonus': 'সাইনআপ বোনাস',
  'kind.daily_bonus': 'ডেইলি বোনাস',
  'kind.referral_bonus': 'রেফারেল বোনাস',
  'kind.entry_fee': 'গেম এন্ট্রি ফি',
  'kind.win': 'গেম জয়',
  'kind.admin_grant': 'অ্যাডমিন ক্রেডিট',
  'kind.commission': 'হাউস কমিশন',
  'kind.mission_bonus': 'মিশন পুরস্কার',
  'kind.private_entry': 'প্রাইভেট রুম এন্ট্রি',
  'kind.private_refund': 'প্রাইভেট রুম ফেরত',
  'kind.private_win': 'প্রাইভেট রুম জয়',
  'kind.tournament_entry': 'টুর্নামেন্ট এন্ট্রি ফি',
  'kind.tournament_refund': 'টুর্নামেন্ট রিফান্ড',
  'kind.tournament_win': 'টুর্নামেন্ট পুরস্কার',
  'kind.coin_store': 'ফ্রি কয়েন প্যাক',
  'kind.redeem_code': 'রিওয়ার্ড কোড',

  /* coin store */
  'store.title': 'কয়েন স্টোর',
  'store.sub': 'ফ্রি কয়েন প্যাক — প্রতিটি প্যাক দিনে একবার নাও। কোনো পেমেন্ট নেই।',
  'store.free': 'ফ্রি',
  'store.claim': 'নাও',
  'store.claimed': 'নেওয়া হয়েছে — আগামীকাল আবার',
  'store.addCoins': 'কয়েন নাও',
  'store.claimedToast': '+{n} কয়েন পেয়েছো! 🎉',

  /* redeem rewards */
  'redeem.title': 'রিওয়ার্ড রিডিম',
  'redeem.redeem': 'রিডিম',
  'redeem.balance': 'ওয়ালেট ব্যালেন্স',
  'redeem.codeLabel': 'রিওয়ার্ড কোড',
  'redeem.codePh': 'যেমন: WELCOME50',
  'redeem.submit': 'সাবমিট',
  'redeem.hint': 'ইভেন্ট বা ঘোষণা থেকে রিওয়ার্ড কোড পেয়েছো? উপরে লিখে ফ্রি কয়েন নাও।',
  'redeem.successToast': '+{n} কয়েন রিডিম হয়েছে! 🎉',
  'redeem.errEmpty': 'তোমার রিওয়ার্ড কোড লেখো।',
  'redeem.errInvalid': 'ভুল কোড। দেখে আবার চেষ্টা করো।',
  'redeem.errUsed': 'এই কোড তুমি আগেই ব্যবহার করেছো।',
  'redeem.errExhausted': 'এই কোডের ব্যবহার সীমা শেষ।',

  /* install modal */
  'install.title': 'অ্যাপ ডাউনলোড',
  'install.note': 'তোমার ফোনে Ludo Master 3D ইনস্টল করো — আসল অ্যাপের মতো হোম স্ক্রিনে আসবে, প্লে স্টোর লাগবে না।',
  'install.ios1': 'Safari-তে <b>Share</b> বোতামে ট্যাপ করো (তীর চিহ্নওয়ালা)।',
  'install.ios2': 'নিচে গিয়ে <b>Add to Home Screen</b>-এ ট্যাপ করো।',
  'install.ios3': '<b>Add</b> চাপো — হোম স্ক্রিনে গেমের আইকন আসবে।',
  'install.and1': 'Chrome-এ <b>⋮</b> মেনুতে ট্যাপ করো (উপরে ডানে)।',
  'install.and2': '<b>Install app</b> বা <b>Add to Home screen</b>-এ ট্যাপ করো।',
  'install.and3': 'কনফার্ম করো — হোম স্ক্রিনে গেমের আইকন আসবে।',

  /* shared */
  'common.ok': 'ঠিক আছে',
  'common.loading': 'লোড হচ্ছে…',
  'common.connecting': 'কানেক্ট হচ্ছে…',
  'common.join': 'যোগ দাও',
  'common.copy': 'কপি',
  'common.share': 'শেয়ার',
  'common.cancel': 'বাতিল',
  'common.home': 'হোম',
  'common.coins': 'কয়েন',
  'common.view': 'দেখো',
  'err.network': 'নেটওয়ার্ক সমস্যা — সার্ভার কি চলছে?',
  'err.session': 'সেশন শেষ — আবার লগইন করো।'
}
};

function getLang() {
  try {
    return localStorage.getItem(LANG_KEY) === 'bn' ? 'bn' : 'en';
  } catch (e) { return 'en'; }
}

function t(key, vars) {
  var lang = getLang();
  var s = (I18N[lang] && I18N[lang][key] !== undefined) ? I18N[lang][key] : I18N.en[key];
  if (s === undefined) return key;
  if (vars) {
    Object.keys(vars).forEach(function (k) {
      s = s.split('{' + k + '}').join(String(vars[k]));
    });
  }
  return s;
}

function tHas(key) {
  var lang = getLang();
  return !!((I18N[lang] && I18N[lang][key] !== undefined) || I18N.en[key] !== undefined);
}

function updateLangToggles() {
  var lang = getLang();
  document.querySelectorAll('[data-lang-toggle]').forEach(function (el) {
    el.textContent = lang === 'bn' ? 'EN' : 'বাং';
    el.setAttribute('aria-label', lang === 'bn' ? 'Switch to English' : 'বাংলায় বদলাও');
  });
}

function applyI18n() {
  try { document.documentElement.lang = getLang(); } catch (e) {}
  document.querySelectorAll('[data-i18n]').forEach(function (el) {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
  });
  updateLangToggles();
}

function setLang(l) {
  var lang = l === 'bn' ? 'bn' : 'en';
  try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
  applyI18n();
  document.dispatchEvent(new CustomEvent('ludo:lang-changed'));
}

/* Public API — exposed as globals for app.js / install.js / api.js. */
window.t = t;
window.tHas = tHas;
window.getLang = getLang;
window.setLang = setLang;
window.applyI18n = applyI18n;

/* Run once on load so static HTML is translated before app.js boots. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyI18n);
} else {
  applyI18n();
}
})();

/* Ludo Master 3D — app shell: hash router, screens, modals, game-flow glue.
 * ---------------------------------------------------------------------------
 * 3D BOARD INTEGRATION CONTRACT (implemented by a teammate):
 *   window.LudoBoard = {
 *     init(containerEl) : Promise,          // mount the 3D board once
 *     setState(pubState, myColor),           // render authoritative state
 *     animateDice(value) : Promise,          // play dice roll animation
 *     onUserRoll: null | fn,                 // board calls it when its own dice UI is tapped
 *     onTokenPick: null | fn,                // board calls it with token index 0..3
 *     showWinner(color)                      // celebration for the winning color
 *   }
 * Every LudoBoard call below is guarded with `hasBoard()` so this UI works
 * before the board module lands (a minimal 2D fallback covers dice + moves).
 * ---------------------------------------------------------------------------
 * SERVER INTEGRATION POINTS expected by this file:
 *   REST (js/api.js): POST /api/auth/signup {name,email,password} -> {token,user}
 *                     POST /api/auth/login {email,password}        -> {token,user}
 *                     GET  /api/me                                 -> user | {user}
 *                     PUT  /api/me {name}                          -> user
 *                     GET  /api/stats                              -> {gamesPlayed,gamesWon,winRate,totalEarned,coins,wins2p,wins4p}
 *                     GET  /api/rooms                              -> [{mode:'2p'|'4p',entry,win,online}]
 *                     POST /api/wallet/daily                       -> {amount|coins|bonus}
 *   SOCKET (js/socket.js): see the wire contract comment at its top.
 * ------------------------------------------------------------------------ */
(function () {
'use strict';

/* ---------------- helpers ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const TOKEN_KEY = 'ludo_token';
const USER_KEY = 'ludo_user';

function esc(v) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmt(n) {
  n = Number(n);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : '0';
}

let toastTimer = null;
function toast(msg, ms) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

function openModal(sel) { $(sel).classList.add('open'); }
function closeModal(sel) { $(sel).classList.remove('open'); }
function closeAllModals() { $$('.modal-overlay.open').forEach((m) => m.classList.remove('open')); }

/* ---------------- store ---------------- */
const store = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); },
  get user() { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; } },
  set user(u) { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY); }
};

function coinsOf(u) {
  if (!u) return 0;
  const v = u.coins !== undefined ? u.coins : (u.balance !== undefined ? u.balance : u.money);
  return Number(v) || 0;
}
function avatarLetter(name) {
  name = (name || '').trim();
  return name ? name[0].toUpperCase() : '?';
}

/* ---------------- router ---------------- */
const SCREENS = ['splash', 'landing', 'auth', 'home', 'rooms', 'game', 'dashboard', 'admin', 'wallet', 'store', 'redeem', 'private', 'leaderboard', 'tournaments', 'tournament'];
const ENTER = {};
let tourneyPoll = null; // 15s refresh timer for the tournament screens

function parseHash() {
  const h = (location.hash || '#/splash').replace(/^#\/?/, '');
  const qi = h.indexOf('?');
  return {
    name: qi < 0 ? h : h.slice(0, qi),
    query: new URLSearchParams(qi < 0 ? '' : h.slice(qi + 1))
  };
}

function show(name) {
  SCREENS.forEach((s) => $('#screen-' + s).classList.toggle('active', s === name));
  window.scrollTo(0, 0);
}

function navigate() {
  const parsed = parseHash();
  const target = SCREENS.indexOf(parsed.name) >= 0 ? parsed.name : 'home';
  const authed = !!store.token;
  if (!authed && (target === 'home' || target === 'rooms' || target === 'game' || target === 'dashboard' || target === 'admin' || target === 'wallet' || target === 'store' || target === 'redeem' || target === 'private' || target === 'leaderboard' || target === 'tournaments' || target === 'tournament')) {
    if (location.hash !== '#/landing') location.hash = '#/landing';
    return;
  }
  if (target === 'admin' && !(store.user && store.user.isAdmin)) {
    // Non-admins (including direct navigation) are bounced to home.
    if (location.hash !== '#/home') location.hash = '#/home';
    return;
  }
  if (target === 'game' && !G.state) {
    if (location.hash !== '#/home') location.hash = '#/home';
    return;
  }
  closeAllModals();
  show(target);
  // Stop tournament polling when leaving those screens.
  if (target !== 'tournaments' && target !== 'tournament' && tourneyPoll) {
    clearInterval(tourneyPoll);
    tourneyPoll = null;
  }
  if (ENTER[target]) {
    try { ENTER[target](parsed.query); } catch (e) { console.error('[app]', e); }
  }
}
window.addEventListener('hashchange', navigate);

/* ---------------- socket wiring ---------------- */
let socketWired = false;
function ensureSocket() {
  if (!store.token) return;
  Socket.connect(store.token);
  if (socketWired) return;
  socketWired = true;

  Socket.on('queue:update', (d) => {
    if (d && typeof d.waiting === 'number') $('#waiting-count').textContent = d.waiting;
  });
  Socket.on('game:start', (state) => {
    closeModal('#overlay-waiting');
    G.myColor = null;
    G.state = state;
    if ((location.hash || '').indexOf('#/game') === 0) { ENTER.game(); }
    else { location.hash = '#/game'; }
  });
  Socket.on('game:state', (state) => { applyState(state); });
  Socket.on('game:dice', onDiceRolled);
  Socket.on('game:over', onGameOver);
  Socket.on('tournament:update', (d) => {
    const h = location.hash || '';
    if (h.indexOf('#/tournaments') === 0) {
      if (h.indexOf('#/tournament?id=') === 0) {
        const id = new URLSearchParams(h.split('?')[1] || '').get('id');
        if (id) loadTournamentDetail(id, true);
      } else {
        loadTournamentList(true);
      }
    }
    if (d && d.text) toast(d.text);
  });
  Socket.on('error', (d) => { toast((d && d.message) || 'Server error'); });
}

/* ---------------- game glue ---------------- */
const COLOR_HEX = { red: '#e63946', green: '#2fbf71', yellow: '#f4b400', blue: '#3b82f6' };
const G = {
  state: null,
  myColor: null,
  boardReady: false,
  rolling: false,
  timerId: null
};

function hasBoard() {
  return typeof window.LudoBoard !== 'undefined' && !!window.LudoBoard;
}

function myPlayerId() {
  const u = store.user;
  return u ? (u.id || u._id || u.userId || null) : null;
}

function myColorFrom(state) {
  if (!state || !Array.isArray(state.players)) return null;
  const pid = myPlayerId();
  let p = null;
  if (pid !== null && pid !== undefined) {
    p = state.players.find((x) => !x.isBot && String(x.id) === String(pid)) || null;
  }
  if (!p) p = state.players.find((x) => !x.isBot) || state.players[0] || null;
  return p ? p.color : null;
}

async function ensureBoard() {
  const B = hasBoard();
  if (!B) return false;
  if (!G.boardReady) {
    try {
      await B.init($('#board-container'));
      G.boardReady = true;
    } catch (e) {
      console.error('[app] LudoBoard.init failed:', e);
      return false;
    }
  }
  return true;
}

function isMyTurn(state) {
  return !!state && state.turnColor === G.myColor;
}

async function applyState(state) {
  if (!state) return;
  const prev = G.state;
  G.state = state;
  if (!G.myColor) G.myColor = myColorFrom(state);
  if (window.Sound && prev && prev.turnColor !== state.turnColor) {
    if (state.turnColor === G.myColor && state.phase !== 'gameover') Sound.play('turn');
  }
  if (window.Sound && prev && detectCapture(prev, state)) Sound.play('capture');
  renderHud();
  const B = hasBoard();
  if (B) {
    const ok = await ensureBoard();
    if (ok) {
      try { B.onUserRoll = doRoll; } catch (e) {}
      try { B.setState(state, G.myColor); } catch (e) { console.error('[app] setState failed:', e); }
    }
  }
  resetTimer();
  updateDiceButton();
  maybePromptMove();
}

function renderHud() {
  const s = G.state;
  if (!s) return;
  $('#hud-mode').textContent = s.mode === '4p' ? t('game.players4') : t('game.players2');
  $('#hud-entry').textContent = fmt(s.entry);

  const chips = $('#chips');
  chips.innerHTML = '';
  (s.players || []).forEach((p) => {
    const el = document.createElement('div');
    el.className = 'chip' + (p.color === s.turnColor ? ' active' : '') + (p.color === G.myColor ? ' me' : '');
    const label = p.color === G.myColor ? t('game.you') : (p.name || p.color);
    const fin = p.finishedCount !== undefined ? p.finishedCount
      : (Array.isArray(p.tokens) ? p.tokens.filter((t) => t === 57).length : 0);
    el.innerHTML =
      '<span class="cdot" style="background:' + (COLOR_HEX[p.color] || '#999') + '"></span>' +
      '<span class="cname">' + esc(label) + '</span>' +
      '<span class="cstar">★ ' + fin + '/4</span>';
    chips.appendChild(el);
  });

  // Turn banner: "YOUR TURN" with dice, or whose turn it is.
  const tb = $('#turn-banner');
  if (tb) {
    const over = !s || s.phase === 'gameover';
    tb.classList.toggle('hidden', over);
    if (!over) {
      const mine = isMyTurn(s);
      const turnP = (s.players || []).find((p) => p.color === s.turnColor);
      const who = mine ? t('game.you') : (turnP ? (turnP.name || turnP.color) : '');
      $('#turn-text').textContent = mine ? t('game.yourTurn') : t('game.turnOf', { name: who });
    }
  }

  // 2D fallback: show movable token buttons when the 3D board is absent.
  const fb = $('#move-fallback');
  fb.innerHTML = '';
  if (!hasBoard() && s.phase === 'awaitingMove' && isMyTurn(s) && Array.isArray(s.movableTokens)) {
    fb.classList.remove('hidden');
    s.movableTokens.forEach((i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t('game.token', { n: i + 1 });
      b.addEventListener('click', () => doMove(i));
      fb.appendChild(b);
    });
  } else {
    fb.classList.add('hidden');
  }
}

function resetTimer() {
  clearInterval(G.timerId);
  const fill = $('#timer-fill');
  const text = $('#timer-text');
  if (!fill || !text) return;
  const secs = CONFIG.TURN_SECONDS || 15;
  let left = secs;
  text.textContent = left + 's';
  fill.style.transition = 'none';
  fill.style.width = '100%';
  // force reflow so the transition restarts
  void fill.offsetWidth;
  fill.style.transition = 'width ' + secs + 's linear';
  fill.style.width = '0%';
  G.timerId = setInterval(() => {
    left -= 1;
    if (left <= 0) { left = 0; clearInterval(G.timerId); }
    text.textContent = left + 's';
  }, 1000);
}

function updateDiceButton() {
  const btn = $('#dice-btn');
  const s = G.state;
  const canRoll = !!s && s.phase === 'awaitingRoll' && isMyTurn(s) && !G.rolling;
  btn.disabled = !canRoll;
  btn.classList.toggle('ready', canRoll);
}

async function doRoll() {
  const s = G.state;
  if (G.rolling || !s || s.phase !== 'awaitingRoll' || !isMyTurn(s)) return;
  G.rolling = true;
  updateDiceButton();
  hideHint();
  Socket.rollDice();
}

function doMove(i) {
  const s = G.state;
  if (!s || s.phase !== 'awaitingMove' || !isMyTurn(s)) return;
  hideHint();
  if (window.Sound) Sound.play('move');
  const B = hasBoard();
  if (B) { try { B.onTokenPick = null; } catch (e) {} }
  Socket.sendMove(i);
}

function maybePromptMove() {
  const s = G.state;
  const B = hasBoard();
  if (s && s.phase === 'awaitingMove' && isMyTurn(s)) {
    showHint(t('game.yourMove'));
    if (B && Array.isArray(s.movableTokens) && s.movableTokens.length) {
      try {
        B.onTokenPick = (i) => { doMove(i); };
      } catch (e) {}
    }
  } else {
    hideHint();
    if (B) { try { B.onTokenPick = null; } catch (e) {} }
  }
}

async function onDiceRolled(d) {
  G.rolling = false;
  const B = hasBoard();
  if (B && typeof B.animateDice === 'function') {
    try { await B.animateDice(d && d.value); } catch (e) { console.error('[app] animateDice failed:', e); }
  } else {
    flashDiceValue(d && d.value);
  }
  updateDiceButton();
}

function flashDiceValue(v) {
  const btn = $('#dice-btn');
  if (v) {
    btn.style.transform = 'scale(1.12)';
    setTimeout(() => { btn.style.transform = ''; }, 220);
  }
  showHint(v ? t('game.rolled', { n: v }) : '');
  setTimeout(hideHint, 1200);
}

function showHint(msg) {
  const h = $('#hud-hint');
  h.textContent = msg;
  h.classList.remove('hidden');
}
function hideHint() { $('#hud-hint').classList.add('hidden'); }

/* ---------------- win celebration (lightweight canvas confetti) ---------------- */
let confettiRAF = null;
function stopConfetti() {
  if (confettiRAF) { cancelAnimationFrame(confettiRAF); confettiRAF = null; }
  const cv = $('#confetti-canvas');
  if (cv) { const c = cv.getContext('2d'); if (c) c.clearRect(0, 0, cv.width, cv.height); }
}
function startConfetti() {
  const cv = $('#confetti-canvas');
  if (!cv) return;
  stopConfetti();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = cv.width = Math.floor(cv.clientWidth * dpr);
  const H = cv.height = Math.floor(cv.clientHeight * dpr);
  const c = cv.getContext('2d');
  const colors = ['#fbbf24', '#3b82f6', '#8b5cf6', '#ec4899', '#22c55e', '#ffffff'];
  const parts = [];
  // confetti burst from bottom + a few firework bursts
  for (let i = 0; i < 130; i++) {
    parts.push({
      x: Math.random() * W, y: H + Math.random() * H * 0.2,
      vx: (Math.random() - 0.5) * 3 * dpr, vy: -(4 + Math.random() * 7) * dpr,
      w: (5 + Math.random() * 7) * dpr, h: (8 + Math.random() * 10) * dpr,
      rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.25,
      color: colors[(Math.random() * colors.length) | 0], shape: 0, life: 1
    });
  }
  for (let b = 0; b < 4; b++) {
    const bx = W * (0.2 + 0.2 * b), by = H * (0.2 + Math.random() * 0.15);
    const col = colors[(Math.random() * colors.length) | 0];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2, sp = (2 + Math.random() * 4) * dpr;
      parts.push({
        x: bx, y: by, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        w: 4 * dpr, h: 4 * dpr, rot: 0, vr: 0,
        color: col, shape: 1, life: 1
      });
    }
  }
  const grav = 0.12 * dpr;
  const t0 = performance.now(), DUR = 4500;
  (function frame(now) {
    const el = now - t0;
    c.clearRect(0, 0, W, H);
    const fade = el > DUR - 900 ? Math.max(0, 1 - (el - (DUR - 900)) / 900) : 1;
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.vy += grav * 0.55; p.rot += p.vr;
      if (p.shape === 1) { p.vx *= 0.985; p.vy *= 0.985; }
      c.save();
      c.globalAlpha = fade;
      c.translate(p.x, p.y); c.rotate(p.rot);
      c.fillStyle = p.color;
      if (p.shape === 0) c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * (0.4 + 0.6 * Math.abs(Math.sin(p.rot * 2))));
      else { c.beginPath(); c.arc(0, 0, p.w / 2, 0, 7); c.fill(); }
      c.restore();
    }
    if (el < DUR) confettiRAF = requestAnimationFrame(frame);
    else stopConfetti();
  })(t0);
}
function celebrateWin(coins, done) {
  $('#celebrate-coins').textContent = fmt(coins);
  openModal('#overlay-celebrate');
  startConfetti();
  if (window.Sound) Sound.play('win');
  const finish = () => {
    stopConfetti();
    closeModal('#overlay-celebrate');
    if (typeof done === 'function') done();
  };
  $('#celebrate-dismiss').onclick = finish;
  $('#overlay-celebrate').onclick = (e) => { if (e.target.id === 'overlay-celebrate' || e.target.id === 'confetti-canvas') finish(); };
  setTimeout(() => { if ($('#overlay-celebrate').classList.contains('open')) finish(); }, 6000);
}

function onGameOver(d) {
  d = d || {};
  clearInterval(G.timerId);
  const B = hasBoard();
  if (B && typeof B.showWinner === 'function') {
    try { B.showWinner(d.winner); } catch (e) {}
  }
  const won = d.isWinner !== undefined ? !!d.isWinner : (d.winner === G.myColor);
  const delta = Number(d.delta !== undefined ? d.delta : (d.coins !== undefined ? d.coins : 0)) || 0;
  $('#go-title').textContent = won ? t('game.youWin') : t('game.gameOver');
  $('#go-winner').textContent = t('game.winner') + (d.winnerName || d.winner || '—');
  const gd = $('#go-delta');
  if (won) {
    gd.textContent = t('game.wonCoins', { n: fmt(delta) });
    gd.classList.add('win');
  } else {
    gd.textContent = t('game.betterLuck') + (delta ? t('game.deltaCoins', { sign: delta > 0 ? '+' : '', n: fmt(Math.abs(delta)) }) : '');
    gd.classList.remove('win');
  }
  // Winners get the celebration first; the summary modal follows on dismiss.
  if (won) {
    celebrateWin(delta, () => { openModal('#modal-gameover'); refreshMe(); });
    return;
  }
  openModal('#modal-gameover');
  refreshMe();
}

function leaveGame() {
  clearInterval(G.timerId);
  try { Socket.leaveQueue(); } catch (e) {}
  G.state = null;
  G.myColor = null;
  G.rolling = false;
  hideHint();
  location.hash = '#/home';
}

/* ---------------- splash ---------------- */
ENTER.splash = () => {
  setTimeout(() => {
    location.hash = store.token ? '#/home' : '#/landing';
  }, 1200);
};

/* ---------------- auth ---------------- */
function setTab(which) {
  $('#tab-login').classList.toggle('active', which === 'login');
  $('#tab-signup').classList.toggle('active', which === 'signup');
  $('#form-login').classList.toggle('hidden', which !== 'login');
  $('#form-signup').classList.toggle('hidden', which !== 'signup');
  $('#form-forgot').classList.add('hidden');
  $('#form-reset').classList.add('hidden');
}
function showAuthForm(id) {
  ['form-login', 'form-signup', 'form-forgot', 'form-reset'].forEach((f) => {
    $('#' + f).classList.toggle('hidden', f !== id);
  });
}
function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function phoneOk(v) { return String(v).replace(/\D/g, '').length >= 7; }
function loginIdOk(v) { return emailOk(v) || phoneOk(v); }

async function handleAuthSuccess(data) {
  const token = data && (data.token || data.accessToken);
  if (!token) throw new Error(t('auth.errNoToken'));
  store.token = token;
  let user = data.user || data.player || null;
  if (!user) {
    try { const me = await Api.me(); user = me.user || me; } catch (e) {}
  }
  if (user) store.user = user;
  ensureSocket();
  location.hash = '#/home';
}

ENTER.auth = () => {
  if (store.token) { location.hash = '#/home'; return; }
  const q = parseHash().query;
  setTab(q.get('tab') === 'signup' ? 'signup' : 'login');
};

/* ---------------- landing ---------------- */
ENTER.landing = () => {
  if (store.token) { location.hash = '#/home'; }
};

function bindLanding() {
  const go = (tab) => { location.hash = '#/auth?tab=' + tab; };
  $('#lp-login').addEventListener('click', () => go('login'));
  $('#lp-signup').addEventListener('click', () => go('signup'));
  $('#lp-playnow').addEventListener('click', () => go('signup'));
  const dl = $('#lp-download');
  if (dl) dl.addEventListener('click', () => openModal('#modal-install'));
}

/* ---------------- bottom nav (shared) ---------------- */
function bindBottomNav() {
  document.querySelectorAll('.bottom-nav').forEach((nav) => {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-nav]');
      if (!btn) return;
      const which = btn.getAttribute('data-nav');
      nav.querySelectorAll('.bn-btn').forEach((b) => b.classList.toggle('active', b === btn));
      if (which === 'home') location.hash = '#/home';
      else if (which === 'events') location.hash = '#/tournaments';
      else if (which === 'play') location.hash = '#/rooms?mode=2p';
      else if (which === 'wallet') location.hash = '#/wallet';
      else if (which === 'profile') openProfileModal();
    });
  });
}

function bindAuth() {
  $('#tab-login').addEventListener('click', () => setTab('login'));
  $('#tab-signup').addEventListener('click', () => setTab('signup'));
  const gs = $('#goto-signup');
  if (gs) gs.addEventListener('click', () => setTab('signup'));
  const gl = $('#goto-login');
  if (gl) gl.addEventListener('click', () => setTab('login'));

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginId = $('#login-email').value.trim();
    const pw = $('#login-password').value;
    const err = $('#login-err');
    if (!loginIdOk(loginId)) { err.textContent = t('auth.errLoginId'); return; }
    if (!pw) { err.textContent = t('auth.errPassword'); return; }
    err.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await handleAuthSuccess(await Api.login(loginId, pw));
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false;
  });

  $('#form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#signup-name').value.trim();
    const email = $('#signup-email').value.trim();
    const phone = $('#signup-phone').value.trim();
    const pw = $('#signup-password').value;
    const err = $('#signup-err');
    if (name.length < 2) { err.textContent = t('auth.errName'); return; }
    if (email && !emailOk(email)) { err.textContent = t('auth.errEmail'); return; }
    if (phone && !phoneOk(phone)) { err.textContent = t('auth.errPhone'); return; }
    if (!email && !phone) { err.textContent = t('auth.errEmailOrPhone'); return; }
    if (pw.length < 6) { err.textContent = t('auth.errPwLen'); return; }
    err.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await handleAuthSuccess(await Api.signup(name, email || null, phone || null, pw));
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false;
  });

  // Forgot password flow.
  $('#forgot-link').addEventListener('click', () => showAuthForm('form-forgot'));
  $('#forgot-back').addEventListener('click', () => showAuthForm('form-login'));
  $('#reset-back').addEventListener('click', () => showAuthForm('form-login'));

  let forgotLoginId = '';
  $('#form-forgot').addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginId = $('#forgot-login').value.trim();
    const err = $('#forgot-err');
    if (!loginIdOk(loginId)) { err.textContent = t('auth.errLoginId'); return; }
    err.textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await Api.forgot(loginId);
      forgotLoginId = loginId;
      // Demo: the code comes back in the response. Production: send via SMS/email.
      if (res && res.code) {
        $('#reset-ok').textContent = t('auth.demoCode', { code: res.code });
      }
      showAuthForm('form-reset');
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false;
  });

  $('#form-reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('#reset-code').value.trim();
    const pw = $('#reset-password').value;
    const err = $('#reset-err');
    if (!/^\d{6}$/.test(code)) { err.textContent = t('auth.errCode'); return; }
    if (pw.length < 6) { err.textContent = t('auth.errPwLen'); return; }
    err.textContent = '';
    $('#reset-ok').textContent = '';
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await Api.resetPassword(forgotLoginId, code, pw);
      $('#reset-ok').textContent = t('auth.resetDone');
      setTimeout(() => showAuthForm('form-login'), 1500);
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false;
  });
}

/* ---------------- home ---------------- */
function renderHeader() {
  const u = store.user || {};
  const name = u.name || 'Player';
  $('#home-name').textContent = name;
  $('#home-avatar').textContent = avatarLetter(name);
  $('#home-balance').textContent = fmt(coinsOf(u));
  const adminLink = $('#admin-link');
  if (adminLink) adminLink.classList.toggle('hidden', !u.isAdmin);
}

async function refreshMe() {
  try {
    const me = await Api.me();
    const user = me.user || me;
    if (user && (user.id || user._id || user.email || user.name)) {
      store.user = user;
      renderHeader();
    }
  } catch (e) { /* offline or expired — api.js already redirects on 401 */ }
}

async function loadOnlineCounts() {
  const el2 = $('#online-2p');
  const el4 = $('#online-4p');
  try {
    const res = await Api.rooms();
    const arr = Array.isArray(res) ? res : (res.rooms || []);
    let n2 = 0, n4 = 0, seen2 = false, seen4 = false;
    arr.forEach((r) => {
      const n = Number(r.online) || 0;
      if ((r.mode || '2p') === '2p') { n2 += n; seen2 = true; }
      else { n4 += n; seen4 = true; }
    });
    el2.textContent = t('home.online') + (seen2 ? fmt(n2) : '—');
    el4.textContent = t('home.online') + (seen4 ? fmt(n4) : '—');
  } catch (e) {
    el2.textContent = t('home.online') + '—';
    el4.textContent = t('home.online') + '—';
  }
}

ENTER.home = () => {
  ensureSocket();
  renderHeader();
  refreshMe();
  loadOnlineCounts();
  loadAnnouncements();
  loadCustomOptions();
};

function bindHome() {
  $('#mode-2p').addEventListener('click', () => { location.hash = '#/rooms?mode=2p'; });
  $('#mode-4p').addEventListener('click', () => { location.hash = '#/rooms?mode=4p'; });
  const openProfile = () => openProfileModal();
  $('#avatar-btn').addEventListener('click', openProfile);
  $('#avatar-btn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openProfile(); }
  });
  const earnBtn = $('#earn-coins-btn');
  if (earnBtn) earnBtn.addEventListener('click', () => { location.hash = '#/wallet'; });
  const refBtn = $('#refer-earn-btn');
  if (refBtn) refBtn.addEventListener('click', () => { walletTab = 'referral'; location.hash = '#/wallet'; });
  const promoJoin = $('#promo-join');
  if (promoJoin) promoJoin.addEventListener('click', () => { location.hash = '#/tournaments'; });
  const privBtn = $('#private-btn');
  if (privBtn) privBtn.addEventListener('click', () => { location.hash = '#/private'; });
  const lbBtn = $('#leaderboard-btn');
  if (lbBtn) lbBtn.addEventListener('click', () => { location.hash = '#/leaderboard'; });
  const adminLink = $('#admin-link');
  if (adminLink) adminLink.addEventListener('click', () => { location.hash = '#/admin'; });
}

/* ---------------- rooms ---------------- */
function roomModeLabel(mode) { return mode === '4p' ? '1 vs 1 vs 1 vs 1' : '1 vs 1'; }

ENTER.rooms = async (query) => {
  const mode = query.get('mode') === '4p' ? '4p' : '2p';
  $('#rooms-title').textContent = mode === '4p' ? t('rooms.fourPlayers') : t('rooms.twoPlayers');
  const list = $('#rooms-list');
  list.innerHTML = '<div class="loading">' + esc(t('rooms.loading')) + '</div>';
  ensureSocket();
  try {
    const res = await Api.rooms();
    // Server shape: { twoPlayer:[{entry,win}], fourPlayer:[{entry,win}] }.
    // Also tolerate legacy shapes (array or {rooms:[...]} with r.mode).
    const arr = [];
    if (res && !Array.isArray(res)) {
      (res.twoPlayer || []).forEach((r) => arr.push({ ...r, mode: '2p' }));
      (res.fourPlayer || []).forEach((r) => arr.push({ ...r, mode: '4p' }));
      if (Array.isArray(res.rooms)) arr.push(...res.rooms);
    } else if (Array.isArray(res)) {
      arr.push(...res);
    }
    const mine = arr.filter((r) => (r.mode || '2p') === mode);
    renderRooms(mine, mode);
  } catch (e) {
    list.innerHTML = '<div class="error-box">' + esc(t('rooms.err')) + '<br>' + esc(e.message) + '</div>';
  }
};

function renderRooms(rooms, mode) {
  const list = $('#rooms-list');
  if (!rooms.length) {
    list.innerHTML = '<div class="loading">' + esc(t('rooms.empty')) + '</div>';
    return;
  }
  list.innerHTML = '';
  rooms.forEach((r) => {
    const entry = Number(r.entry) || 0;
    const win = Number(r.win) || Math.round(entry * (mode === '4p' ? 3.2 : 1.6));
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML =
      '<div class="room-badge">' + esc(roomModeLabel(mode)) + '</div>' +
      '<div class="room-amounts"><span>' + esc(t('rooms.entry')) + '<b>' + fmt(entry) + '</b></span>' +
      '<span>' + esc(t('rooms.win')) + '<b>' + fmt(win) + '</b></span></div>';
    const btn = document.createElement('button');
    btn.className = 'btn-gold';
    btn.type = 'button';
    btn.textContent = t('common.join');
    btn.addEventListener('click', () => joinRoom(mode, entry));
    card.appendChild(btn);
    list.appendChild(card);
  });
}

function joinRoom(mode, entry) {
  ensureSocket();
  if (!Socket.isConnected()) {
    toast(t('rooms.connecting'));
    Socket.connect(store.token);
  }
  Socket.joinQueue(mode, entry);
  $('#waiting-sub').textContent = (mode === '4p' ? t('rooms.fourPlayers') : t('rooms.twoPlayers')) + ' · ' + t('rooms.entryWord') + ' ' + fmt(entry);
  $('#waiting-count').textContent = '1';
  openModal('#overlay-waiting');
}

function bindRooms() {
  $('#rooms-close').addEventListener('click', () => { location.hash = '#/home'; });
  $('#waiting-cancel').addEventListener('click', () => {
    try { Socket.leaveQueue(); } catch (e) {}
    closeModal('#overlay-waiting');
  });
}

/* ---------------- sounds wiring ---------------- */
function bindSounds() {
  if (!window.Sound) return;
  // Subtle click on any button tap (data-sound overrides the default click).
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-sound], button');
    if (!el || el.disabled) return;
    const name = el.getAttribute && el.getAttribute('data-sound');
    Sound.play(name || 'click');
  }, { passive: true });
  // Sound toggle in profile
  const tg = $('#sound-toggle');
  const paint = () => { if (tg) tg.textContent = Sound.muted() ? '🔇 ' + t('prof.soundOff') : '🔊 ' + t('prof.soundOn'); };
  if (tg) {
    paint();
    tg.setAttribute('data-sound', 'click');
    tg.addEventListener('click', () => { Sound.toggleMuted(); paint(); });
    document.addEventListener('ludo:lang-changed', paint);
  }
  // Coin Store + Redeem: active buttons on home and wallet balance cards.
  [['add-coins-btn', '#/store'], ['redeem-btn', '#/redeem'],
   ['wallet-store-btn', '#/store'], ['wallet-redeem-btn', '#/redeem']].forEach(([id, hash]) => {
    const b = document.getElementById(id);
    if (b) b.addEventListener('click', () => { location.hash = hash; });
  });
}

function detectCapture(prev, next) {
  // A token sent back to base (pos 0) was captured.
  try {
    if (!prev || !next || !prev.players || !next.players) return false;
    for (const p of next.players) {
      const pp = prev.players.find((q) => q.color === p.color);
      if (!pp || !Array.isArray(pp.tokens) || !Array.isArray(p.tokens)) continue;
      for (let i = 0; i < p.tokens.length; i++) {
        const a = Number(pp.tokens[i]), b = Number(p.tokens[i]);
        if (a > 0 && a < 57 && b === 0) return true;
      }
    }
  } catch (e) {}
  return false;
}

/* ---------------- game screen ---------------- */
ENTER.game = async () => {
  if (!G.state) { location.hash = '#/home'; return; }
  const B = hasBoard();
  if (B) {
    await ensureBoard();
    try { B.onUserRoll = doRoll; B.onTokenPick = null; } catch (e) {}
  } else {
    const bc = $('#board-container');
    if (!bc.querySelector('.board-placeholder')) {
      bc.innerHTML = '<div class="board-placeholder">3D board loads here<br>(board module not attached yet)</div>';
    }
  }
  applyState(G.state);
};

function bindGame() {
  $('#dice-btn').addEventListener('click', doRoll);
  $('#game-leave').addEventListener('click', leaveGame);
  $('#go-home').addEventListener('click', () => {
    closeModal('#modal-gameover');
    leaveGame();
  });
}

/* ---------------- profile modal ---------------- */
let editingName = false;

function fillProfile(u) {
  u = u || {};
  const name = u.name || 'Player';
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('profile-avatar', avatarLetter(name));
  if (!editingName) set('profile-name', name);
  const handle = '@' + String(u.referralCode || u.referral_code || name).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  set('profile-handle', handle);
  set('pf-email', u.email || '—');
  set('pf-phone', u.phone || '—');
  const s = u.stats || {};
  const played = Number(s.gamesPlayed !== undefined ? s.gamesPlayed : (u.gamesPlayed || 0)) || 0;
  const won = Number(s.gamesWon !== undefined ? s.gamesWon : (u.gamesWon || 0)) || 0;
  set('st-played', fmt(played));
  set('st-won', fmt(won));
  const rate = s.winRate !== undefined ? s.winRate : (played ? Math.round((won / played) * 100) : 0);
  set('st-rate', rate + '%');
  set('st-2p', fmt(s.wins2p !== undefined ? s.wins2p : (u.wins2p || 0)));
  set('st-4p', fmt(s.wins4p !== undefined ? s.wins4p : (u.wins4p || 0)));
  const refEarn = u.referralEarnings !== undefined ? u.referralEarnings : (u.referral_earnings || 0);
  set('st-ref-earn', fmt(refEarn));
  set('st-ref-code', u.referralCode || u.referral_code || '—');
}

function openProfileModal() {
  editingName = false;
  fillProfile(store.user);
  openModal('#modal-profile');
  refreshMe().then(() => fillProfile(store.user));
  refreshTelegramRow();
}

/* ---------------- telegram linking (profile) ----------------
 * "🔗 Link Telegram" -> server creates a one-time code -> opens
 * https://t.me/<bot>?start=link_<code> -> bot completes the link.
 * Polls link-status for ~60s so the UI flips to "linked" when the user
 * comes back from Telegram. Compact: one row in the profile modal.
 */
function refreshTelegramRow() {
  const wrap = $('#tg-link-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<span class="tg-loading">…</span>';
  Api.telegramLinkStatus().then((st) => {
    if (st && st.linked) {
      wrap.innerHTML = '<span class="tg-linked">' + esc(t('tg.linkedBadge')) + '</span> ' +
        '<button class="btn-outline sm" id="tg-unlink-btn" type="button">' + esc(t('tg.unlink')) + '</button>';
      $('#tg-unlink-btn').addEventListener('click', async () => {
        try {
          await Api.telegramUnlink();
          toast(t('tg.unlinked'));
        } catch (e) { toast(e.message); }
        refreshTelegramRow();
      });
      return;
    }
    wrap.innerHTML = '<button class="btn-outline sm" id="tg-link-btn" type="button">' + esc(t('tg.linkTelegram')) + '</button>';
    $('#tg-link-btn').addEventListener('click', async () => {
      const btn = $('#tg-link-btn');
      btn.disabled = true;
      try {
        const r = await Api.telegramLinkCode();
        if (r && r.url) {
          window.open(r.url, '_blank');
          toast(t('tg.finishLinking'));
          let tries = 0;
          const iv = setInterval(async () => {
            tries++;
            try {
              const s = await Api.telegramLinkStatus();
              if ((s && s.linked) || tries >= 12) {
                clearInterval(iv);
                if (s && s.linked) { toast(t('tg.linked')); refreshTelegramRow(); }
                else btn.disabled = false;
              }
            } catch (e) { clearInterval(iv); btn.disabled = false; }
          }, 5000);
        } else {
          toast(t('tg.noBot'));
          btn.disabled = false;
        }
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    });
  }).catch(() => {
    wrap.innerHTML = '<span class="tg-loading">—</span>';
  });
}

function bindProfile() {
  const copyRefCode = () => {
    const code = ($('#st-ref-code') || {}).textContent;
    if (!code || code === '—') return;
    const done = () => toast(t('prof.copied'));
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, () => toast(t('prof.codeIs', { code })));
    } else {
      toast(t('prof.codeIs', { code }));
    }
  };
  const rcEl = $('#st-ref-code');
  if (rcEl) {
    rcEl.addEventListener('click', copyRefCode);
    rcEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyRefCode(); }
    });
  }
  $('#name-edit').addEventListener('click', async () => {
    const nameEl = $('#profile-name');
    if (!editingName) {
      editingName = true;
      const cur = (store.user && store.user.name) || '';
      const input = document.createElement('input');
      input.className = 'profile-name-input';
      input.id = 'profile-name';
      input.value = cur;
      input.maxLength = 30;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      toast(t('prof.editHint'));
      return;
    }
    const input = $('#profile-name');
    const next = (input.value || '').trim();
    if (next.length < 2) { toast(t('auth.errName')); return; }
    $('#name-edit').disabled = true;
    try {
      const res = await Api.updateMe({ name: next });
      const user = res.user || res;
      if (user && (user.name || user.id || user._id)) store.user = user;
      else if (store.user) { store.user.name = next; store.user = store.user; }
      const span = document.createElement('span');
      span.className = 'profile-name';
      span.id = 'profile-name';
      input.replaceWith(span);
      editingName = false;
      fillProfile(store.user);
      renderHeader();
      toast(t('prof.nameUpdated'));
    } catch (e) {
      toast(e.message);
    }
    $('#name-edit').disabled = false;
  });

  $('#logout-btn').addEventListener('click', () => {
    try { Socket.disconnect(); } catch (e) {}
    socketWired = false;
    store.token = null;
    store.user = null;
    G.state = null;
    G.myColor = null;
    closeAllModals();
    location.hash = '#/landing';
  });
  const pfEdit = $('#pf-edit-btn');
  if (pfEdit) pfEdit.addEventListener('click', () => $('#name-edit').click());
  const pfStats = $('#pf-stats-btn');
  if (pfStats) pfStats.addEventListener('click', () => { closeAllModals(); location.hash = '#/dashboard'; });
}

/* ---------------- dashboard ---------------- */
ENTER.dashboard = async () => {
  const grid = $('#stat-grid');
  grid.innerHTML = '<div class="loading">' + esc(t('dash.loading')) + '</div>';
  try {
    const res = await Api.stats();
    const s = res.stats || res;
    const played = Number(s.gamesPlayed) || 0;
    const won = Number(s.gamesWon) || 0;
    const rate = s.winRate !== undefined ? s.winRate : (played ? Math.round((won / played) * 100) : 0);
    const cards = [
      { v: fmt(played), l: t('dash.played') },
      { v: fmt(won), l: t('dash.won') },
      { v: rate + '%', l: t('dash.winRate') },
      { v: fmt(s.coins !== undefined ? s.coins : coinsOf(store.user)), l: t('dash.coins') },
      { v: fmt(s.totalEarned || 0), l: t('dash.earned') },
      { v: fmt(s.wins2p || 0), l: t('dash.wins2p') },
      { v: fmt(s.wins4p || 0), l: t('dash.wins4p') }
    ];
    grid.innerHTML = '';
    cards.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'stat-card' + (i === 4 ? ' wide' : '');
      el.innerHTML = '<div class="sv">' + esc(c.v) + '</div><div class="sl">' + esc(c.l) + '</div>';
      grid.appendChild(el);
    });
  } catch (e) {
    grid.innerHTML = '<div class="error-box">' + esc(t('dash.err')) + '<br>' + esc(e.message) + '</div>';
  }
};

function bindDashboard() {
  $('#dash-back').addEventListener('click', () => { location.hash = '#/home'; });
}

/* ---------------- wallet ---------------- */
let walletTab = 'history';

ENTER.wallet = async () => {
  await refreshMe();
  $('#wallet-balance').textContent = fmt(coinsOf(store.user));
  document.querySelectorAll('.wallet-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.wtab === walletTab);
  });
  renderWalletPane();
};

/* ---------------- coin store (free daily packs) ---------------- */
ENTER.store = async () => {
  await refreshMe();
  const box = $('#store-packs');
  box.innerHTML = '<div class="loading">' + esc(t('common.loading')) + '</div>';
  try {
    const res = await Api.coinStoreStatus();
    const amounts = res.amounts || [10, 50, 100, 500];
    const claimed = new Set(res.claimed || []);
    box.innerHTML = '';
    amounts.forEach((amt) => {
      const done = claimed.has(amt);
      const card = document.createElement('div');
      card.className = 'store-pack' + (done ? ' is-claimed' : '');
      card.innerHTML =
        '<span class="store-free">' + esc(t('store.free')) + '</span>' +
        '<div class="store-amt"><svg class="ic"><use href="#icon-coin"/></svg><b>' + fmt(amt) + '</b></div>' +
        '<span class="store-coins">' + esc(t('wallet.coins')) + '</span>' +
        '<button class="btn-grad sm" type="button"' + (done ? ' disabled' : '') + '>' +
          esc(done ? t('store.claimed') : t('store.claim')) + '</button>';
      if (!done) {
        card.querySelector('button').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            const r = await Api.claimCoinStore(amt);
            await refreshMe();
            updateBalanceLabels();
            startConfetti();
            setTimeout(stopConfetti, 2200);
            toast(t('store.claimedToast', { n: fmt(r.amount) }));
            Sound.play('win');
            ENTER.store(); // re-render: this pack now shows claimed
          } catch (err) {
            toast(err.message);
            btn.disabled = false;
          }
        });
      }
      box.appendChild(card);
    });
  } catch (e) {
    box.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
};

function bindStore() {
  $('#store-back').addEventListener('click', () => { location.hash = '#/home'; });
}

/* ---------------- redeem rewards (promo codes) ---------------- */
ENTER.redeem = async () => {
  await refreshMe();
  $('#redeem-balance').textContent = fmt(coinsOf(store.user));
  $('#redeem-err').textContent = '';
  const input = $('#redeem-code');
  if (input && !input.value) input.value = '';
};

function bindRedeem() {
  $('#redeem-back').addEventListener('click', () => { location.hash = '#/home'; });
  $('#redeem-submit').addEventListener('click', async () => {
    const errEl = $('#redeem-err');
    const btn = $('#redeem-submit');
    const code = $('#redeem-code').value;
    if (!code.trim()) { errEl.textContent = t('redeem.errEmpty'); return; }
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const r = await Api.redeemCode(code);
      await refreshMe();
      updateBalanceLabels();
      $('#redeem-balance').textContent = fmt(coinsOf(store.user));
      $('#redeem-code').value = '';
      startConfetti();
      setTimeout(stopConfetti, 2200);
      toast(t('redeem.successToast', { n: fmt(r.amount) }));
      Sound.play('win');
    } catch (e) {
      errEl.textContent = mapRedeemError(e.message);
    }
    btn.disabled = false;
  });
}

/** Map server redeem errors to friendly localized messages. */
function mapRedeemError(msg) {
  const m = String(msg || '');
  if (/already used/i.test(m)) return t('redeem.errUsed');
  if (/exhausted/i.test(m)) return t('redeem.errExhausted');
  if (/invalid code/i.test(m)) return t('redeem.errInvalid');
  return m;
}

/** Refresh every balance label on the visible screens after a coin change. */
function updateBalanceLabels() {
  const b = fmt(coinsOf(store.user));
  ['home-balance', 'wallet-balance', 'redeem-balance'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = b;
  });
}

function bindWallet() {
  $('#wallet-back').addEventListener('click', () => { location.hash = '#/home'; });
  document.querySelectorAll('.wallet-tab').forEach((b) => {
    b.addEventListener('click', () => { walletTab = b.dataset.wtab; ENTER.wallet(); });
  });
  $('#wallet-daily-btn').addEventListener('click', async () => {
    const btn = $('#wallet-daily-btn');
    btn.disabled = true;
    try {
      const res = await Api.dailyBonus();
      const amt = Number(res.amount !== undefined ? res.amount : res.bonus) || 0;
      toast(amt ? t('coin.toastAmt', { n: fmt(amt) }) : t('coin.claimed'));
      await refreshMe();
      $('#wallet-balance').textContent = fmt(coinsOf(store.user));
      renderWalletPane();
    } catch (e) { toast(e.message); }
    btn.disabled = false;
  });
}

async function renderWalletPane() {
  const pane = $('#wallet-pane');
  if (walletTab === 'referral') return renderWalletReferral(pane);
  walletTab = 'history';
  return renderWalletHistory(pane);
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}

async function renderWalletHistory(pane) {
  pane.innerHTML = '<div class="loading">' + esc(t('common.loading')) + '</div>';
  try {
    const res = await Api.walletHistory(50);
    const rows = res.history || [];
    if (!rows.length) {
      pane.innerHTML = '<p class="empty-note">' + esc(t('wallet.emptyHistory')) + '</p>';
      return;
    }
    const body = rows.map((r) => {
      const pos = Number(r.amount) >= 0;
      const kindKey = 'kind.' + r.kind;
      const label = tHas(kindKey) ? t(kindKey) : (r.label || r.kind);
      return '<tr><td>' + esc(fmtDate(r.createdAt)) + '</td>' +
        '<td class="tx-desc"><b>' + esc(label) + '</b></td>' +
        '<td class="r ' + (pos ? 'pos' : 'neg') + '">' + (pos ? '+' : '') + fmt(r.amount) + '</td></tr>';
    }).join('');
    pane.innerHTML = '<h3 class="stats-title">' + esc(t('wallet.txHistory')) + '</h3>' +
      '<table class="tx-table"><thead><tr><th>' + esc(t('wallet.colDate')) + '</th><th>' +
      esc(t('wallet.colDetails')) + '</th><th class="r">' + esc(t('wallet.colCoins')) + '</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table>';
  } catch (e) {
    pane.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

async function renderWalletReferral(pane) {
  const me = store.user || {};
  const code = me.referralCode || '';
  const earn = Number(me.referralEarnings) || 0;
  pane.innerHTML =
    '<div class="ref-card"><p class="admin-hint">' + esc(t('wallet.refHint')) + '</p>' +
    '<div class="ref-code-row"><code id="ref-code">' + esc(code) + '</code>' +
    '<button class="btn-outline sm" id="ref-copy" type="button">' + esc(t('common.copy')) + '</button></div>' +
    '<p class="ref-earn"><b>' + esc(t('wallet.refEarnings', { n: '+' + fmt(earn) })) + '</b></p></div>';
  const cp = $('#ref-copy');
  if (cp) cp.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(code); toast(t('wallet.refCopied')); }
    catch (e) { toast(code); }
  });
}

/* ---------------- custom options (home links) ---------------- */
async function loadCustomOptions() {
  const box = $('#custom-links');
  if (!box) return;
  try {
    const res = await Api.customOptions();
    const opts = (res.options || []).filter((o) => o.enabled !== false);
    box.innerHTML = opts.map((o) =>
      '<a class="custom-link" href="' + esc(o.url) + '" target="_blank" rel="noopener">' + esc(o.title) + '</a>'
    ).join('');
    box.style.display = opts.length ? '' : 'none';
  } catch (e) { /* silent */ }
}

/* ---------------- tournaments ---------------- */
let tourneyTab = 'all';   // all | live | upcoming
let tourneyFee = '';      // '' = all fees
let tourneyCache = [];

function bindTournament() {
  $('#tournaments-back').addEventListener('click', () => { location.hash = '#/home'; });
  $('#tournament-back').addEventListener('click', () => { location.hash = '#/tournaments'; });
  const tb = $('#tournaments-btn');
  if (tb) tb.addEventListener('click', () => { location.hash = '#/tournaments'; });
  document.querySelectorAll('.ttab').forEach((b) => {
    b.addEventListener('click', () => {
      tourneyTab = b.dataset.ttab;
      document.querySelectorAll('.ttab').forEach((x) => x.classList.toggle('active', x === b));
      renderTournamentCards();
    });
  });
  const feeSel = $('#tour-fee-filter');
  if (feeSel) feeSel.addEventListener('change', () => {
    tourneyFee = feeSel.value;
    renderTournamentCards();
  });
}

function tourneyMatchesTab(tour) {
  if (tourneyTab === 'live') return tour.status === 'ongoing' || tour.status === 'filling';
  if (tourneyTab === 'upcoming') return tour.status === 'upcoming' || tour.status === 'filling';
  return true;
}

function tourneyCardHTML(tour) {
  const pct = tour.maxPlayers ? Math.min(100, Math.round((tour.playerCount / tour.maxPlayers) * 100)) : 0;
  const full = tour.maxPlayers && tour.playerCount >= tour.maxPlayers;
  const joinable = tour.status === 'upcoming' || tour.status === 'filling';
  const idLabel = String(tour.id || '').slice(-4).padStart(4, '0');
  return '<div class="tcard-art"><span class="tcard-id">ID: #' + esc(idLabel) + '</span>' +
    '<span class="tstatus tstatus-' + esc(tour.status) + ' tcard-status">' + esc(tourneyStatusLabel(tour.status)) + '</span></div>' +
    '<div class="tcard-body">' +
    '<div class="tcard-namerow"><b>' + esc(tour.name) + '</b>' +
    '<div class="tcard-map"><span>' + esc(t('tour.map')) + '</span><b>' + esc(tour.map || t('tour.classic')) + '</b></div></div>' +
    '<div class="tcard-date"><svg class="ic"><use href="#icon-cal"/></svg><span>' + esc(fmtDate(tour.startsAt)) + '</span></div>' +
    ((tour.status === 'completed' || tour.status === 'cancelled') ? '' :
      '<div class="tcard-countdown" data-countdown data-starts-at="' + esc(tour.startsAt || '') + '">' + esc(fmtStartsIn(tour.startsAt)) + '</div>') +
    '<div class="tcard-boxes">' +
    '<div class="tbox"><span>' + esc(t('tour.prizePool')) + '</span><b class="gold">' + fmt(tour.prizePool) + '</b></div>' +
    '<div class="tbox"><span>' + esc(t('tour.entryFee')) + '</span><b class="green">' + fmt(tour.entryFee) + '</b></div></div>' +
    '<div class="tcard-joined"><span>' + esc(t('tour.joinedPlayers')) + '</span><b>' + tour.playerCount + '/' + tour.maxPlayers + '</b></div>' +
    '<div class="tcard-bar"><div class="tcard-fill" style="width:' + pct + '%"></div></div>' +
    (joinable
      ? '<button class="btn-grad block" type="button" data-join="' + esc(tour.id) + '"' + (full ? ' disabled' : '') + '>' + esc(full ? t('tour.full') : t('tour.joinMatch')) + ' →</button>'
      : '<button class="btn-outline block" type="button" data-view="' + esc(tour.id) + '">' + esc(t('tour.view')) + '</button>') +
    '</div>';
}

function renderTournamentCards() {
  const box = $('#tournament-list');
  if (!box) return;
  const list = tourneyCache.filter(tourneyMatchesTab).filter((tour) =>
    tourneyFee === '' || String(tour.entryFee) === tourneyFee);
  if (!list.length) {
    box.innerHTML = '<p class="empty-note">' + esc(t('tour.empty')) + '</p>';
    return;
  }
  box.innerHTML = '';
  list.forEach((tour) => {
    const card = document.createElement('div');
    card.className = 'tcard';
    card.innerHTML = tourneyCardHTML(tour);
    const joinBtn = card.querySelector('[data-join]');
    if (joinBtn) joinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      location.hash = '#/tournament?id=' + encodeURIComponent(tour.id);
    });
    const viewBtn = card.querySelector('[data-view]');
    if (viewBtn) viewBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      location.hash = '#/tournament?id=' + encodeURIComponent(tour.id);
    });
    card.addEventListener('click', () => {
      location.hash = '#/tournament?id=' + encodeURIComponent(tour.id);
    });
    box.appendChild(card);
  });
  tickCountdowns();
}

function fillFeeFilter() {
  const sel = $('#tour-fee-filter');
  if (!sel) return;
  const fees = Array.from(new Set(tourneyCache.map((tour) => Number(tour.entryFee) || 0))).sort((a, b) => a - b);
  const cur = tourneyFee;
  sel.innerHTML = '<option value="">' + esc(t('tour.feeFilter')) + '</option>' +
    fees.map((f) => '<option value="' + f + '"' + (String(f) === cur ? ' selected' : '') + '>' + fmt(f) + ' ' + esc(t('wallet.coins')) + '</option>').join('');
}

const TOURNEY_STATUS_LABEL = {
  upcoming: 'Upcoming', filling: 'Filling fast', ongoing: 'LIVE',
  completed: 'Completed', cancelled: 'Cancelled',
};

/* User-facing tournament status labels (translated). The English
 * TOURNEY_STATUS_LABEL const (used by the admin tab) stays English by design. */
function tourneyStatusLabel(s) {
  const map = {
    upcoming: 'tour.stUpcoming', filling: 'tour.stFilling', ongoing: 'tour.stLive',
    completed: 'tour.stCompleted', cancelled: 'tour.stCancelled',
  };
  return map[s] ? t(map[s]) : s;
}

/* Live countdown: one 1s interval updates every [data-countdown] element's text.
 * data-starts-at -> "Starts in 2h 15m"; data-ready-at -> "Joining closes in 05:00". */
function fmtStartsIn(startsAt) {
  if (!startsAt) return t('tour.tba');
  const ms = new Date(startsAt).getTime() - Date.now();
  if (ms <= 0) return t('tour.startingSoon');
  const m = Math.floor(ms / 60000);
  if (m < 60) return t('tour.startsInM', { m });
  const h = Math.floor(m / 60);
  if (h < 48) return t('tour.startsInH', { h, m: m % 60 });
  return t('tour.startsOn', { date: new Date(startsAt).toLocaleDateString() });
}

/* Mirrors server walkoverMs (server/src/tournament.js): the window in which a
 * ready match must start before the no-show walkover+refund resolves it. */
const MATCH_JOIN_WINDOW_MS = 10 * 60 * 1000;

function fmtJoinCloses(readyAt) {
  if (!readyAt) return '';
  const ms = new Date(readyAt).getTime() + MATCH_JOIN_WINDOW_MS - Date.now();
  if (ms <= 0) return t('tour.joinWindowOver');
  const s = Math.ceil(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return t('tour.joinClosesIn', { mmss: mm + ':' + ss });
}

function tickCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    let txt = '';
    if (el.hasAttribute('data-ready-at')) {
      txt = fmtJoinCloses(el.getAttribute('data-ready-at'));
      const ms = new Date(el.getAttribute('data-ready-at')).getTime() + MATCH_JOIN_WINDOW_MS - Date.now();
      el.classList.toggle('urgent', ms > 0 && ms < 60000);
    } else if (el.hasAttribute('data-starts-at')) {
      txt = fmtStartsIn(el.getAttribute('data-starts-at'));
    }
    if (txt && el.textContent !== txt) el.textContent = txt;
  });
}

function tourneyCountdown(startsAt) {
  return fmtStartsIn(startsAt);
}

function bindTournament() {
  $('#tournaments-back').addEventListener('click', () => { location.hash = '#/home'; });
  $('#tournament-back').addEventListener('click', () => { location.hash = '#/tournaments'; });
  const tb = $('#tournaments-btn');
  if (tb) tb.addEventListener('click', () => { location.hash = '#/tournaments'; });
}

ENTER.tournaments = async () => {
  await loadTournamentList();
  if (tourneyPoll) clearInterval(tourneyPoll);
  tourneyPoll = setInterval(() => {
    if ((location.hash || '').indexOf('#/tournaments') === 0 && location.hash.indexOf('#/tournament?') !== 0) {
      loadTournamentList(true);
    }
  }, 15000);
};

async function loadTournamentList(quiet) {
  const box = $('#tournament-list');
  if (!box) return;
  if (!quiet) box.innerHTML = '<div class="loading">' + esc(t('tour.loading')) + '</div>';
  try {
    const res = await Api.tournaments();
    const list = res.tournaments || [];
    tourneyCache = list;
    const live = list.some((t) => t.status === 'ongoing' || t.status === 'filling');
    const liveBadge = $('#tournaments-live');
    if (liveBadge) liveBadge.classList.toggle('hidden', !live);
    fillFeeFilter();
    renderTournamentCards();
  } catch (e) {
    if (!quiet) box.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

ENTER.tournament = async (query) => {
  const id = query && query.get('id');
  if (!id) { location.hash = '#/tournaments'; return; }
  await loadTournamentDetail(id, false);
  if (tourneyPoll) clearInterval(tourneyPoll);
  tourneyPoll = setInterval(() => {
    if ((location.hash || '').indexOf('#/tournament?id=' + encodeURIComponent(id)) === 0) {
      loadTournamentDetail(id, true);
    }
  }, 15000);
};

function roundLabel(round, totalRounds) {
  if (round === totalRounds) return t('tour.final');
  if (round === totalRounds - 1) return t('tour.semifinal');
  return t('tour.round', { n: round });
}

async function loadTournamentDetail(id, quiet) {
  const box = $('#tournament-detail');
  if (!box) return;
  if (!quiet) box.innerHTML = '<div class="loading">' + esc(t('common.loading')) + '</div>';
  try {
    const d = await Api.tournamentDetail(id);
    const tour = d.tournament;
    $('#tournament-title').textContent = tour.name;
    const totalRounds = Math.max(1, ...d.matches.map((m) => m.round), 1);

    let html = '<div class="tourney-card"><div class="tourney-head"><b>' + esc(tour.name) + '</b>' +
      '<span class="tstatus tstatus-' + esc(tour.status) + '">' + esc(tourneyStatusLabel(tour.status)) + '</span></div>' +
      '<div class="tourney-meta"><span>🎟️ ' + esc(t('rooms.entryWord')) + ' ' + fmt(tour.entryFee) + '</span>' +
      '<span>👥 ' + tour.playerCount + '/' + tour.maxPlayers + '</span>' +
      '<span>🏆 ' + fmt(tour.prizePool) + '</span></div>' +
      '<div class="tourney-prizes">🥇 ' + fmt(tour.prize1st) + ' &nbsp; 🥈 ' + fmt(tour.prize2nd) +
      (tour.prize3rd > 0 ? ' &nbsp; 🥉 ' + fmt(tour.prize3rd) : '') + '</div>' +
      '<div class="tourney-when" data-countdown data-starts-at="' + esc(tour.startsAt || '') + '">' + esc(fmtStartsIn(tour.startsAt)) + '</div></div>';

    // Join / Play CTA
    if ((tour.status === 'upcoming' || tour.status === 'filling') && !tour.joined) {
      html += '<button class="btn-gold big block" id="td-join" type="button">' + esc(t('tour.joinCoins', { n: fmt(tour.entryFee) })) + '</button>';
    } else if (tour.joined && (tour.status === 'upcoming' || tour.status === 'filling')) {
      html += '<p class="joined-note">' + esc(t('tour.joined')) + '</p>';
    }
    if (d.myMatch) {
      const opp = d.myMatch.opponent ? d.myMatch.opponent.name : 'TBD';
      const jc = d.myMatch.readyAt
        ? '<div><span class="join-closes" data-countdown data-ready-at="' + esc(d.myMatch.readyAt) + '">' + esc(fmtJoinCloses(d.myMatch.readyAt)) + '</span></div>'
        : '';
      html += '<div class="play-match-card"><p>' + t('tour.matchReady', { opp: '<b>' + esc(opp) + '</b>' }) + '</p>' + jc +
        '<button class="btn-gold big block" id="td-play" type="button">' + esc(t('tour.playMatch')) + '</button>' +
        '<button class="btn-outline sm" id="td-ready" type="button">' + esc(t('tour.imReady')) + '</button></div>';
    }

    // Bracket
    if (d.matches.length) {
      html += '<h3 class="stats-title">' + esc(t('tour.bracket')) + '</h3>';
      const byRound = {};
      d.matches.forEach((m) => { (byRound[m.round] = byRound[m.round] || []).push(m); });
      Object.keys(byRound).sort((a, b) => a - b).forEach((r) => {
        html += '<div class="bracket-round"><h4>' + esc(roundLabel(Number(r), totalRounds)) + '</h4>';
        byRound[r].forEach((m) => {
          html += '<div class="bracket-match bm-' + esc(m.status) + '">' +
            bracketPlayerHTML(m.player1, m.winnerId) +
            '<div class="bm-vs">' + esc(t('tour.vs')) + '</div>' +
            bracketPlayerHTML(m.player2, m.winnerId) +
            (m.status === 'walkover' ? '<div class="bm-tag">' + esc(t('tour.walkover')) + '</div>' : '') +
            '</div>';
        });
        html += '</div>';
      });
    }

    // Players
    html += '<h3 class="stats-title">' + esc(t('tour.players', { n: d.players.length })) + '</h3><div class="tourney-players">';
    if (!d.players.length) html += '<p class="empty-note">' + esc(t('tour.noPlayers')) + '</p>';
    d.players.forEach((p) => {
      html += '<div class="tplayer' + (p.eliminated ? ' out' : '') + '"><span>' + esc(p.name) + '</span>' +
        (p.finalPosition === 1 ? '<b class="medal">🥇</b>' : p.finalPosition === 2 ? '<b class="medal">🥈</b>' : p.finalPosition === 3 ? '<b class="medal">🥉</b>' : '') +
        '</div>';
    });
    html += '</div>';

    box.innerHTML = html;
    tickCountdowns();

    const joinBtn = $('#td-join');
    if (joinBtn) joinBtn.addEventListener('click', async () => {
      joinBtn.disabled = true;
      try {
        await Api.tournamentJoin(id);
        toast(t('tour.joinedToast'));
        await refreshMe();
        loadTournamentDetail(id, true);
      } catch (e) { toast(e.message); }
      joinBtn.disabled = false;
    });
    const playBtn = $('#td-play');
    if (playBtn) playBtn.addEventListener('click', () => {
      ensureSocket();
      if (!Socket.playTournamentMatch(d.myMatch.matchId)) {
        toast(t('tour.connecting'));
      } else {
        toast(t('tour.startingMatch'));
      }
    });
    const readyBtn = $('#td-ready');
    if (readyBtn) readyBtn.addEventListener('click', async () => {
      try {
        await Api.tournamentReady(id);
        toast(t('tour.markedReady'));
      } catch (e) { toast(e.message); }
    });
  } catch (e) {
    if (!quiet) box.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

function bracketPlayerHTML(p, winnerId) {
  if (!p) return '<div class="bm-player empty">—</div>';
  const won = winnerId && String(winnerId) === String(p.id);
  return '<div class="bm-player' + (won ? ' winner' : '') + '">' + esc(p.name) + (won ? ' ✓' : '') + '</div>';
}

/* ----- admin: tournaments ----- */
async function renderAdminTournamentsTab(pane) {
  pane.innerHTML =
    '<p class="admin-hint">Single-elimination 1v1 tournaments. Entry is deducted at join; winners auto-advance from real game results; prizes auto-credit. Virtual coins only.</p>' +
    '<h3 class="stats-title">CREATE TOURNAMENT</h3>' +
    '<div class="admin-form">' +
    '<label>Name<input type="text" id="at-name" maxlength="60" placeholder="Weekend Cup"></label>' +
    '<label>Entry fee (coins)<input type="number" id="at-entry" min="1" value="40"></label>' +
    '<label>Max players<select id="at-max"><option>4</option><option>8</option><option>16</option><option>32</option></select></label>' +
    '<label>🥇 1st prize<input type="number" id="at-p1" min="0" value="100"></label>' +
    '<label>🥈 2nd prize<input type="number" id="at-p2" min="0" value="40"></label>' +
    '<label>🥉 3rd prize<input type="number" id="at-p3" min="0" value="0"></label>' +
    '<label>Starts at (optional)<input type="datetime-local" id="at-starts"></label>' +
    '<button class="btn-gold" id="at-create" type="button">Create tournament</button></div>' +
    '<h3 class="stats-title">ALL TOURNAMENTS</h3>' +
    '<div id="at-list" class="admin-list"><div class="loading">Loading…</div></div>';

  pane.querySelector('#at-create').addEventListener('click', async () => {
    const btn = pane.querySelector('#at-create');
    btn.disabled = true;
    try {
      const startsRaw = pane.querySelector('#at-starts').value;
      await Api.adminCreateTournament({
        name: pane.querySelector('#at-name').value,
        entryFee: Number(pane.querySelector('#at-entry').value),
        maxPlayers: Number(pane.querySelector('#at-max').value),
        prize1st: Number(pane.querySelector('#at-p1').value),
        prize2nd: Number(pane.querySelector('#at-p2').value),
        prize3rd: Number(pane.querySelector('#at-p3').value),
        startsAt: startsRaw ? new Date(startsRaw).toISOString() : null,
      });
      toast('Tournament created');
      pane.querySelector('#at-name').value = '';
      loadAdminTournaments(pane);
    } catch (e) { toast(e.message); }
    btn.disabled = false;
  });

  await loadAdminTournaments(pane);
}

async function loadAdminTournaments(pane) {
  const list = pane.querySelector('#at-list');
  try {
    const res = await Api.adminTournaments();
    const rows = res.tournaments || [];
    if (!rows.length) { list.innerHTML = '<p class="empty-note">No tournaments yet.</p>'; return; }
    list.innerHTML = '';
    rows.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'tx-row';
      row.innerHTML =
        '<div class="tx-info"><b>' + esc(t.name) + '</b><span>Entry ' + fmt(t.entryFee) +
        ' · ' + t.playerCount + '/' + t.maxPlayers + ' players · Pool ' + fmt(t.prizePool) +
        ' · <span class="tstatus tstatus-' + esc(t.status) + '">' + esc(TOURNEY_STATUS_LABEL[t.status] || t.status) + '</span></span></div>';
      const wrap = document.createElement('div');
      wrap.style.display = 'flex'; wrap.style.gap = '8px';
      if (t.status === 'upcoming' || t.status === 'filling') {
        const startB = document.createElement('button');
        startB.className = 'btn-gold sm'; startB.type = 'button'; startB.textContent = 'Start now';
        startB.addEventListener('click', async () => {
          try { await Api.adminStartTournament(t.id); toast('Tournament started'); loadAdminTournaments(pane); }
          catch (e) { toast(e.message); }
        });
        const cancelB = document.createElement('button');
        cancelB.className = 'btn-outline sm danger'; cancelB.type = 'button'; cancelB.textContent = 'Cancel';
        cancelB.addEventListener('click', async () => {
          if (!confirm('Cancel this tournament and refund all entries?')) return;
          try { await Api.adminCancelTournament(t.id); toast('Cancelled — entries refunded'); loadAdminTournaments(pane); }
          catch (e) { toast(e.message); }
        });
        wrap.appendChild(startB); wrap.appendChild(cancelB);
      } else {
        const viewB = document.createElement('button');
        viewB.className = 'btn-outline sm'; viewB.type = 'button'; viewB.textContent = 'View';
        viewB.addEventListener('click', () => { location.hash = '#/tournament?id=' + encodeURIComponent(t.id); });
        wrap.appendChild(viewB);
      }
      row.appendChild(wrap);
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* ---------------- admin panel ----------------
 * EXTENSIBLE TAB REGISTRY — to add a new admin option later, append ONE entry
 * to ADMIN_TABS and write its render function. Nothing else to wire: tab
 * buttons, panes and switching are all driven by this array.
 *
 *   { id: 'my-tab', title: 'My Tab', render: renderMyTab }
 *
 * render(paneEl) runs every time the tab is opened. Build the tab's UI inside
 * paneEl (it is emptied first). Use the Api.admin* helpers from js/api.js and
 * the esc()/fmt() helpers below for safe HTML.
 * ------------------------------------------------------------------------ */
const ADMIN_TABS = [
  { id: 'overview', title: 'Overview', render: renderAdminOverview },
  { id: 'analytics', title: 'Analytics', render: renderAdminAnalyticsTab },
  { id: 'users',    title: 'Users',    render: renderAdminUsersTab },
  { id: 'matches',  title: 'Matches',  render: renderAdminMatchesTab },
  { id: 'rooms',    title: 'Rooms',    render: renderAdminRoomsTab },
  { id: 'bonuses',  title: 'Bonuses',  render: renderAdminBonusesTab },
  { id: 'support',  title: 'Support',  render: renderAdminSupportTab },
  { id: 'requests', title: 'Requests', render: renderAdminRequestsTab },
  { id: 'options',  title: 'Options',  render: renderAdminOptionsTab },
  { id: 'tournaments', title: 'Tournaments', render: renderAdminTournamentsTab },
  { id: 'private', title: 'Private', render: renderAdminPrivateTab },
];

const ADMIN = {
  cfg: null,               // { rooms, economy } from /api/admin/config
  users: [], usersTotal: 0, usersPage: 1, usersSearch: '',
  coinsUser: null,
  supportThreads: [],      // [{userId,name,email,lastText,lastSender,lastAt,unreadCount}]
  supportOpenUser: null,   // userId whose thread is open in the admin UI
  supportSub: 'chats',     // 'chats' | 'notices'
  notices: [],
  editingNotice: null,
};
let adminTabsBuilt = false;
let adminCurrentTab = null;

function buildAdminTabs() {
  if (adminTabsBuilt) return;
  adminTabsBuilt = true;
  const bar = $('#admin-tabs');
  bar.innerHTML = '';
  ADMIN_TABS.forEach((t) => {
    const b = document.createElement('button');
    b.className = 'admin-tab';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.dataset.atab = t.id;
    b.textContent = t.title;
    b.addEventListener('click', () => switchAdminTab(t.id));
    bar.appendChild(b);
  });
}

function switchAdminTab(id) {
  const tab = ADMIN_TABS.find((t) => t.id === id) || ADMIN_TABS[0];
  adminCurrentTab = tab.id;
  $$('#admin-tabs .admin-tab').forEach((b) => b.classList.toggle('active', b.dataset.atab === tab.id));
  const panes = $('#admin-panes');
  panes.innerHTML = '';
  const pane = document.createElement('div');
  pane.className = 'admin-pane';
  pane.id = 'apane-' + tab.id;
  panes.appendChild(pane);
  try {
    tab.render(pane);
  } catch (e) {
    console.error('[admin]', e);
    pane.innerHTML = '<div class="error-box">Failed to load this tab.</div>';
  }
}

ENTER.admin = async () => {
  if (!(store.user && store.user.isAdmin)) { location.hash = '#/home'; return; }
  buildAdminTabs();
  switchAdminTab(adminCurrentTab || 'overview');
};

function statCardsHTML(cards) {
  return cards.map((c) =>
    '<div class="stat-card"><div class="sv">' + esc(c.v) + '</div><div class="sl">' + esc(c.l) + '</div></div>'
  ).join('');
}

/* ----- overview ----- */
async function renderAdminOverview(pane) {
  pane.innerHTML = '<div class="stat-grid"><div class="loading">Loading…</div></div>';
  const grid = pane.querySelector('.stat-grid');
  try {
    const s = await Api.adminStats();
    grid.innerHTML = statCardsHTML([
      { v: fmt(s.totalUsers), l: 'Total Users' },
      { v: fmt(s.totalGames), l: 'Total Games' },
      { v: fmt(s.gamesToday), l: 'Games Today' },
      { v: fmt(s.coinsInCirculation), l: 'Coins in Circulation' },
      { v: fmt(s.onlineNow), l: 'Online Now' },
    ]);
  } catch (e) {
    grid.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* ----- analytics (graphs + virtual-coin income) -----
 * EXTENSIBILITY DEMO: this whole tab was added as ONE registry entry above
 * ({id:'analytics', ...}) + this one render function. To add another chart:
 * 1) fetch data via a new Api.admin* helper, 2) push a new Chart into
 * adminCharts below, 3) add a <canvas> block in the HTML string.
 * Chart.js loads lazily ONLY when this tab opens — the game page never pays
 * for it.
 */
let adminCharts = [];
let adminAnalyticsDays = 30;
let chartJsLoading = null;

function ensureChartJs() {
  if (window.Chart) return Promise.resolve();
  if (!chartJsLoading) {
    chartJsLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load Chart.js — check connection and reopen the tab.'));
      document.head.appendChild(s);
    });
  }
  return chartJsLoading;
}

function destroyAdminCharts() {
  for (const c of adminCharts) { try { c.destroy(); } catch (e) { /* gone */ } }
  adminCharts = [];
}

async function renderAdminAnalyticsTab(pane) {
  pane.innerHTML =
    '<div class="admin-range-row">' +
      '<span class="admin-hint" style="margin:0">Virtual-coin income = house rake (entry fees − winnings paid).</span>' +
      '<div class="range-btns">' +
        '<button class="btn-outline sm" data-days="7" type="button">7 days</button>' +
        '<button class="btn-outline sm" data-days="30" type="button">30 days</button>' +
      '</div>' +
    '</div>' +
    '<div id="an-kpis" class="stat-grid"><div class="loading">Loading…</div></div>' +
    '<div id="an-empty"></div>' +
    '<h3 class="stats-title">GAMES &amp; NEW USERS</h3><div class="chart-wrap"><canvas id="an-ch-activity"></canvas></div>' +
    '<h3 class="stats-title">ENTRY COLLECTED VS WINNINGS PAID</h3><div class="chart-wrap"><canvas id="an-ch-money"></canvas></div>' +
    '<h3 class="stats-title">COINS IN CIRCULATION (CUMULATIVE)</h3><div class="chart-wrap"><canvas id="an-ch-circ"></canvas></div>' +
    '<h3 class="stats-title">COIN FLOW BY KIND</h3><div class="chart-wrap chart-narrow"><canvas id="an-ch-kinds"></canvas></div>';
  pane.querySelectorAll('.range-btns button').forEach((b) => {
    b.addEventListener('click', () => {
      adminAnalyticsDays = Number(b.dataset.days);
      paintAnalytics(pane);
    });
  });
  await paintAnalytics(pane);
}

async function paintAnalytics(pane) {
  destroyAdminCharts();
  const kpis = pane.querySelector('#an-kpis');
  const emptyBox = pane.querySelector('#an-empty');
  if (kpis) kpis.innerHTML = '<div class="loading">Loading…</div>';
  if (emptyBox) emptyBox.innerHTML = '';
  let data;
  try {
    data = await Api.adminAnalytics(adminAnalyticsDays);
  } catch (e) {
    if (kpis) kpis.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    return;
  }
  const t = data.totals || {};
  if (kpis) {
    kpis.innerHTML = statCardsHTML([
      { v: fmt(t.rake), l: 'House Income (rake)' },
      { v: fmt(t.entryCollected), l: 'Entry Volume' },
      { v: fmt(t.winPaid), l: 'Winnings Paid' },
      { v: fmt(t.bonusGranted), l: 'Bonuses Granted' },
      { v: fmt(t.newUsers), l: 'New Users' },
      { v: fmt(t.games), l: 'Games Played' },
    ]);
  }
  if (emptyBox && (t.games || 0) === 0 && (t.newUsers || 0) === 0) {
    emptyBox.innerHTML = '<div class="admin-hint">No activity in this range yet — charts show zeros.</div>';
  }
  try {
    await ensureChartJs();
  } catch (e) {
    if (emptyBox) emptyBox.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    return;
  }
  const labels = (data.days || []).map((d) => String(d.date).slice(5));
  const gold = '#f7c948', green = '#2fbf71', red = '#e63946', blue = '#3b82f6', dim = '#e8cfae';
  const axes = {
    x: { ticks: { color: dim, font: { size: 10 }, maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,.06)' } },
    y: { ticks: { color: dim, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.06)' }, beginAtZero: true },
  };
  const legend = { labels: { color: dim, boxWidth: 12, font: { size: 11 } } };
  const val = (k) => (data.days || []).map((d) => d[k] || 0);

  adminCharts.push(new Chart(pane.querySelector('#an-ch-activity'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Games', data: val('games'), borderColor: gold, backgroundColor: gold, tension: 0.3, pointRadius: 2 },
      { label: 'New users', data: val('newUsers'), borderColor: blue, backgroundColor: blue, tension: 0.3, pointRadius: 2 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend }, scales: axes },
  }));
  adminCharts.push(new Chart(pane.querySelector('#an-ch-money'), {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Entry collected', data: val('entryCollected'), backgroundColor: green },
      { label: 'Winnings paid', data: val('winPaid'), backgroundColor: red },
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend }, scales: axes },
  }));
  adminCharts.push(new Chart(pane.querySelector('#an-ch-circ'), {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Coins in circulation', data: val('circulation'), borderColor: gold,
        backgroundColor: 'rgba(247,201,72,.15)', fill: true, tension: 0.3, pointRadius: 0 },
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend }, scales: axes },
  }));
  const bk = data.byKind || {};
  adminCharts.push(new Chart(pane.querySelector('#an-ch-kinds'), {
    type: 'doughnut',
    data: {
      labels: ['Entry fees', 'Winnings', 'Signup bonus', 'Daily bonus', 'Referral bonus', 'Admin grant'],
      datasets: [{ data: [bk.entry_fee || 0, bk.win || 0, bk.signup_bonus || 0, bk.daily_bonus || 0, bk.referral_bonus || 0, bk.admin_grant || 0],
        backgroundColor: [green, red, gold, blue, '#a06ee1', dim] }],
    },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: dim, boxWidth: 12, font: { size: 11 } } } } },
  }));
}

/* ----- users ----- */
async function renderAdminUsersTab(pane) {
  pane.innerHTML =
    '<div class="admin-search-row">' +
      '<input id="au-search" type="search" placeholder="Search name or email…" autocomplete="off">' +
      '<button class="btn-gold sm" id="au-search-btn" type="button">Search</button>' +
    '</div>' +
    '<div id="au-list" class="admin-list"><div class="loading">Loading users…</div></div>' +
    '<div class="admin-pager">' +
      '<button class="btn-outline sm" id="au-prev" type="button">‹ Prev</button>' +
      '<span id="au-pageinfo"></span>' +
      '<button class="btn-outline sm" id="au-next" type="button">Next ›</button>' +
    '</div>';
  pane.querySelector('#au-search').value = ADMIN.usersSearch;
  const doSearch = () => {
    ADMIN.usersSearch = pane.querySelector('#au-search').value.trim();
    ADMIN.usersPage = 1;
    loadAdminUsers(pane);
  };
  pane.querySelector('#au-search-btn').addEventListener('click', doSearch);
  pane.querySelector('#au-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  pane.querySelector('#au-prev').addEventListener('click', () => {
    if (ADMIN.usersPage > 1) { ADMIN.usersPage -= 1; loadAdminUsers(pane); }
  });
  pane.querySelector('#au-next').addEventListener('click', () => {
    if (ADMIN.usersPage * 20 < ADMIN.usersTotal) { ADMIN.usersPage += 1; loadAdminUsers(pane); }
  });
  await loadAdminUsers(pane);
}

async function loadAdminUsers(pane) {
  const list = pane.querySelector('#au-list');
  list.innerHTML = '<div class="loading">Loading users…</div>';
  try {
    const res = await Api.adminUsers(ADMIN.usersSearch, ADMIN.usersPage);
    ADMIN.users = res.users || [];
    ADMIN.usersTotal = res.total || 0;
    pane.querySelector('#au-pageinfo').textContent =
      'Page ' + ADMIN.usersPage + ' · ' + fmt(ADMIN.usersTotal) + ' users';
    if (!ADMIN.users.length) {
      list.innerHTML = '<div class="loading">No users found.</div>';
      return;
    }
    list.innerHTML = '';
    ADMIN.users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'admin-user-row' + (u.banned ? ' banned' : '');
      row.innerHTML =
        '<div class="au-main">' +
          '<div class="au-name">' + esc(u.name) +
            (u.isAdmin ? ' <span class="admin-badge">ADMIN</span>' : '') +
            (u.banned ? ' <span class="ban-badge">BANNED</span>' : '') + '</div>' +
          '<div class="au-email">' + esc(u.email) + '</div>' +
          '<div class="au-meta">Coins <b>' + fmt(u.coins) + '</b> · Played ' + fmt(u.gamesPlayed) +
          ' / Won ' + fmt(u.gamesWon) + ' · Ref <b class="mono">' + esc(u.referralCode || '—') +
          '</b> (+' + fmt(u.referralEarnings) + ')</div>' +
        '</div><div class="au-actions"></div>';
      const actions = row.querySelector('.au-actions');
      const coinsBtn = document.createElement('button');
      coinsBtn.className = 'btn-outline sm';
      coinsBtn.type = 'button';
      coinsBtn.textContent = '± Coins';
      coinsBtn.addEventListener('click', () => openAdminCoinsModal(u));
      const banBtn = document.createElement('button');
      banBtn.className = 'btn-outline sm' + (u.banned ? ' danger-active' : '');
      banBtn.type = 'button';
      banBtn.textContent = u.banned ? 'Unban' : 'Ban';
      banBtn.addEventListener('click', async () => {
        try {
          const r = await Api.adminBan(u.id, !u.banned);
          u.banned = r.banned;
          toast((u.banned ? 'Banned ' : 'Unbanned ') + u.name);
          loadAdminUsers(pane);
        } catch (e) { toast(e.message); }
      });
      actions.appendChild(coinsBtn);
      actions.appendChild(banBtn);
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

function openAdminCoinsModal(u) {
  ADMIN.coinsUser = u;
  $('#admin-coins-user').textContent = u.name + ' · ' + fmt(u.coins) + ' coins';
  $('#admin-coins-amount').value = '';
  $('#admin-coins-err').textContent = '';
  openModal('#modal-admin-coins');
}

async function adminAdjustCoins(sign) {
  const u = ADMIN.coinsUser;
  const errEl = $('#admin-coins-err');
  if (!u) return;
  const amount = Number($('#admin-coins-amount').value);
  if (!Number.isInteger(amount) || amount <= 0) {
    errEl.textContent = 'Enter a positive whole number.';
    return;
  }
  errEl.textContent = '';
  try {
    const res = await Api.adminGrantCoins(u.id, sign * amount);
    u.coins = res.coins;
    $('#admin-coins-user').textContent = u.name + ' · ' + fmt(u.coins) + ' coins';
    $('#admin-coins-amount').value = '';
    toast((sign > 0 ? 'Gave ' : 'Took ') + fmt(amount) + ' coins ' + (sign > 0 ? 'to ' : 'from ') + u.name);
    if (adminCurrentTab === 'users') switchAdminTab('users'); // refresh list
  } catch (e) {
    errEl.textContent = e.message;
  }
}

/* ----- matches ----- */
async function renderAdminMatchesTab(pane) {
  pane.innerHTML = '<div id="am-list" class="admin-list"><div class="loading">Loading matches…</div></div>';
  const list = pane.querySelector('#am-list');
  try {
    const games = await Api.adminGames(30);
    if (!games.length) {
      list.innerHTML = '<div class="loading">No matches played yet.</div>';
      return;
    }
    list.innerHTML = '';
    games.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'admin-match-row';
      const when = g.playedAt ? new Date(g.playedAt).toLocaleString() : '—';
      row.innerHTML =
        '<div class="am-mode">' + esc(String(g.mode).toUpperCase()) + ' · Entry ' + fmt(g.entry) + '</div>' +
        '<div class="am-winner">Winner: <b>' + esc(g.winnerName || 'Bot') + '</b> (' + fmt(g.playerCount) + ' players)</div>' +
        '<div class="am-when">' + esc(when) + '</div>';
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* ----- rooms ----- */
async function renderAdminRoomsTab(pane) {
  pane.innerHTML = '<div class="loading">Loading room config…</div>';
  try {
    if (!ADMIN.cfg) ADMIN.cfg = await Api.adminConfig();
  } catch (e) {
    pane.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    return;
  }
  pane.innerHTML =
    '<p class="admin-hint">Toggle tiers on/off, edit win amounts, add brand-new entry tiers or remove them. Changes apply immediately after saving.</p>' +
    '<h3 class="stats-title">2 PLAYERS</h3><div id="ar-2p" class="admin-list"></div>' +
    '<button class="btn-outline sm" id="ar-add-2p" type="button">+ Add entry tier</button>' +
    '<h3 class="stats-title">4 PLAYERS</h3><div id="ar-4p" class="admin-list"></div>' +
    '<button class="btn-outline sm" id="ar-add-4p" type="button">+ Add entry tier</button>' +
    '<h3 class="stats-title">MATCHMAKING WAIT</h3>' +
    '<p class="admin-hint">Seconds to wait for human opponents before bots fill the empty seats (vs computer). Queues are per entry fee — different entries never mix.</p>' +
    '<div class="admin-tier-row">' +
    '<label>2 Players (sec)<input type="number" min="2" max="300" step="1" id="ar-wait-2p" value="' + esc((ADMIN.cfg.matchmaking && ADMIN.cfg.matchmaking.twoPlayerWaitSec) || 8) + '"></label>' +
    '<label>4 Players (sec)<input type="number" min="2" max="300" step="1" id="ar-wait-4p" value="' + esc((ADMIN.cfg.matchmaking && ADMIN.cfg.matchmaking.fourPlayerWaitSec) || 8) + '"></label>' +
    '</div>' +
    '<div class="admin-save-row"><button class="btn-gold" id="ar-save" type="button">Save room config</button></div>';
  const paint = () => {
    const c2 = pane.querySelector('#ar-2p');
    const c4 = pane.querySelector('#ar-4p');
    c2.innerHTML = '';
    c4.innerHTML = '';
    ADMIN.cfg.rooms.twoPlayer.forEach((t) => c2.appendChild(adminTierRow(t, '2p', paint)));
    ADMIN.cfg.rooms.fourPlayer.forEach((t) => c4.appendChild(adminTierRow(t, '4p', paint)));
  };
  pane.querySelector('#ar-add-2p').addEventListener('click', () => {
    ADMIN.cfg.rooms.twoPlayer.push({ entry: '', win: '', enabled: true });
    paint();
  });
  pane.querySelector('#ar-add-4p').addEventListener('click', () => {
    ADMIN.cfg.rooms.fourPlayer.push({ entry: '', win: '', enabled: true });
    paint();
  });
  pane.querySelector('#ar-save').addEventListener('click', async () => {
    const rooms = readAdminRoomsFromUI(pane);
    const economy = (ADMIN.cfg && ADMIN.cfg.economy) || { signupBonus: 5410, dailyBonus: 500, referralBonus: 200 };
    const matchmaking = {
      twoPlayerWaitSec: Math.min(300, Math.max(2, Number(pane.querySelector('#ar-wait-2p').value) || 8)),
      fourPlayerWaitSec: Math.min(300, Math.max(2, Number(pane.querySelector('#ar-wait-4p').value) || 8)),
    };
    try {
      const res = await Api.adminSaveConfig({ rooms, economy, matchmaking });
      ADMIN.cfg = res;
      paint();
      toast('Room config saved');
    } catch (e) { toast(e.message); }
  });
  paint();
}

function adminTierRow(tier, mode, repaint) {
  const row = document.createElement('div');
  row.className = 'admin-tier-row' + (tier.enabled === false ? ' disabled' : '');
  const entryVal = tier.entry === '' ? '' : tier.entry;
  const winVal = tier.win === '' ? '' : tier.win;
  row.innerHTML =
    '<label>Entry<input type="number" min="1" step="1" class="tier-entry" value="' + esc(entryVal) + '"></label>' +
    '<label>Win<input type="number" min="0" step="1" class="tier-win" value="' + esc(winVal) + '"></label>' +
    '<label class="tier-enabled"><input type="checkbox" class="tier-check"' + (tier.enabled === false ? '' : ' checked') + '> Enabled</label>' +
    '<button class="btn-outline sm danger" type="button">Remove</button>';
  row.querySelector('.tier-entry').addEventListener('input', (e) => { tier.entry = e.target.value === '' ? '' : Number(e.target.value); });
  row.querySelector('.tier-win').addEventListener('input', (e) => { tier.win = e.target.value === '' ? '' : Number(e.target.value); });
  row.querySelector('.tier-check').addEventListener('change', (e) => {
    tier.enabled = e.target.checked;
    row.classList.toggle('disabled', !tier.enabled);
  });
  row.querySelector('button').addEventListener('click', () => {
    const list = mode === '2p' ? ADMIN.cfg.rooms.twoPlayer : ADMIN.cfg.rooms.fourPlayer;
    const ix = list.indexOf(tier);
    if (ix >= 0) list.splice(ix, 1);
    repaint();
  });
  return row;
}

/** Read tier rows from the DOM (used by both save buttons so neither clobbers the other). */
function readAdminRoomsFromUI(pane) {
  const readList = (sel) =>
    Array.from(pane.querySelectorAll(sel + ' .admin-tier-row')).map((row) => ({
      entry: Number(row.querySelector('.tier-entry').value),
      win: Number(row.querySelector('.tier-win').value),
      enabled: row.querySelector('.tier-check').checked,
    }));
  return { twoPlayer: readList('#ar-2p'), fourPlayer: readList('#ar-4p') };
}

/* ----- bonuses ----- */
async function renderAdminBonusesTab(pane) {
  pane.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (!ADMIN.cfg) ADMIN.cfg = await Api.adminConfig();
  } catch (e) {
    pane.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    return;
  }
  const eco = ADMIN.cfg.economy;
  pane.innerHTML =
    '<p class="admin-hint">All bonus amounts are virtual coins. New values apply to signups and claims made after saving.</p>' +
    '<div class="bonus-form">' +
      '<label>Signup bonus (coins)<input id="ab-signup" type="number" min="0" step="1" inputmode="numeric" value="' + esc(eco.signupBonus) + '"></label>' +
      '<label>Daily bonus (coins)<input id="ab-daily" type="number" min="0" step="1" inputmode="numeric" value="' + esc(eco.dailyBonus) + '"></label>' +
      '<label>Referral bonus (coins, paid to referrer)<input id="ab-referral" type="number" min="0" step="1" inputmode="numeric" value="' + esc(eco.referralBonus) + '"></label>' +
      '<button class="btn-gold" id="ab-save" type="button">Save bonuses</button>' +
      '<p class="form-err" id="ab-err"></p>' +
    '</div>';
  pane.querySelector('#ab-save').addEventListener('click', async () => {
    const errEl = pane.querySelector('#ab-err');
    const economy = {
      signupBonus: Number(pane.querySelector('#ab-signup').value),
      dailyBonus: Number(pane.querySelector('#ab-daily').value),
      referralBonus: Number(pane.querySelector('#ab-referral').value),
    };
    for (const k of Object.keys(economy)) {
      if (!Number.isInteger(economy[k]) || economy[k] < 0) {
        errEl.textContent = 'All bonus amounts must be non-negative whole numbers.';
        return;
      }
    }
    errEl.textContent = '';
    try {
      const res = await Api.adminSaveConfig({ rooms: ADMIN.cfg.rooms, economy });
      ADMIN.cfg = res;
      toast('Bonuses saved');
    } catch (e) { errEl.textContent = e.message; }
  });

  // ---- coin packs manager ----
  const packs = Array.isArray(ADMIN.cfg.coin_packs) ? [...ADMIN.cfg.coin_packs] : [1000, 5000, 20000];
  const packBox = document.createElement('div');
  packBox.innerHTML =
    '<h3 class="stats-title">COIN PACKS</h3>' +
    '<p class="admin-hint">Coin packs shown on the wallet Buy tab. Add, edit or remove packs — changes apply immediately after saving.</p>' +
    '<div id="ab-packs" class="admin-list"></div>' +
    '<button class="btn-outline sm" id="ab-add-pack" type="button">+ Add pack</button>' +
    '<div class="admin-save-row"><button class="btn-gold" id="ab-save-packs" type="button">Save coin packs</button></div>' +
    '<p class="form-err" id="ab-pack-err"></p>';
  pane.appendChild(packBox);
  const paintPacks = () => {
    const box = packBox.querySelector('#ab-packs');
    box.innerHTML = '';
    packs.forEach((p, ix) => {
      const row = document.createElement('div');
      row.className = 'admin-tier-row';
      row.innerHTML =
        '<label>Coins<input type="number" min="1" max="1000000" step="1" value="' + esc(p) + '"></label>' +
        '<button class="btn-outline sm danger" type="button">Remove</button>';
      row.querySelector('input').addEventListener('input', (e) => {
        packs[ix] = e.target.value === '' ? '' : Number(e.target.value);
      });
      row.querySelector('button').addEventListener('click', () => {
        packs.splice(ix, 1);
        paintPacks();
      });
      box.appendChild(row);
    });
  };
  packBox.querySelector('#ab-add-pack').addEventListener('click', () => {
    if (packs.length >= 20) { toast('Maximum 20 packs'); return; }
    packs.push('');
    paintPacks();
  });
  packBox.querySelector('#ab-save-packs').addEventListener('click', async () => {
    const errEl = packBox.querySelector('#ab-pack-err');
    const clean = packs.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 1000000);
    if (!clean.length) { errEl.textContent = 'Add at least one valid pack.'; return; }
    errEl.textContent = '';
    try {
      const res = await Api.adminSaveConfig({ coin_packs: [...new Set(clean)].sort((a, b) => a - b) });
      ADMIN.cfg = res;
      toast('Coin packs saved');
    } catch (e) { errEl.textContent = e.message; }
  });
  paintPacks();

  // ---- reward codes manager (free-coin promo codes) ----
  const rcBox = document.createElement('div');
  rcBox.innerHTML =
    '<h3 class="stats-title">REWARD CODES</h3>' +
    '<p class="admin-hint">Create promo codes players redeem for free coins. Each player can use a code once; total uses are capped.</p>' +
    '<div class="bonus-form">' +
      '<label>Code (4-24 chars, A-Z 0-9)<input id="arc-code" type="text" autocapitalize="characters" autocomplete="off" placeholder="WELCOME50"></label>' +
      '<label>Coins (1-100000)<input id="arc-coins" type="number" min="1" max="100000" step="1" inputmode="numeric" value="50"></label>' +
      '<label>Max uses (1-100000)<input id="arc-max" type="number" min="1" max="100000" step="1" inputmode="numeric" value="100"></label>' +
      '<button class="btn-gold" id="arc-create" type="button">Create code</button>' +
      '<p class="form-err" id="arc-err"></p>' +
    '</div>' +
    '<div id="arc-list" class="admin-list"></div>';
  pane.appendChild(rcBox);
  const paintCodes = async () => {
    const box = rcBox.querySelector('#arc-list');
    box.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const res = await Api.adminRedeemCodes();
      const codes = res.codes || [];
      if (!codes.length) { box.innerHTML = '<p class="empty-note">No reward codes yet.</p>'; return; }
      box.innerHTML = '';
      codes.forEach((c) => {
        const row = document.createElement('div');
        row.className = 'admin-tier-row';
        row.innerHTML =
          '<div class="arc-info"><b>' + esc(c.code) + '</b>' +
          '<span>' + esc(String(c.coins)) + ' coins · ' + esc(String(c.used_count)) + '/' + esc(String(c.max_uses)) + ' used</span></div>' +
          '<button class="btn-outline sm danger" type="button">Delete</button>';
        row.querySelector('button').addEventListener('click', async () => {
          if (!confirm('Delete code ' + c.code + '?')) return;
          try {
            await Api.adminDeleteRedeemCode(c.code);
            toast('Code deleted');
            paintCodes();
          } catch (e) { toast(e.message); }
        });
        box.appendChild(row);
      });
    } catch (e) {
      box.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    }
  };
  rcBox.querySelector('#arc-create').addEventListener('click', async () => {
    const errEl = rcBox.querySelector('#arc-err');
    errEl.textContent = '';
    try {
      await Api.adminCreateRedeemCode(
        rcBox.querySelector('#arc-code').value,
        Number(rcBox.querySelector('#arc-coins').value),
        Number(rcBox.querySelector('#arc-max').value)
      );
      rcBox.querySelector('#arc-code').value = '';
      toast('Reward code created');
      paintCodes();
    } catch (e) { errEl.textContent = e.message; }
  });
  paintCodes();
}

/* ----- support (chats + notices) ----- */
async function renderAdminSupportTab(pane) {
  pane.innerHTML =
    '<div class="admin-tabs sub">' +
      '<button class="admin-tab active" data-sub="chats" type="button">Chats</button>' +
      '<button class="admin-tab" data-sub="notices" type="button">Notices</button>' +
    '</div>' +
    '<div id="asub-body"></div>';
  const body = pane.querySelector('#asub-body');
  const tabs = Array.from(pane.querySelectorAll('[data-sub]'));
  const show = (which) => {
    ADMIN.supportSub = which;
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.sub === which));
    if (which === 'chats') renderSupportChats(body);
    else renderSupportNotices(body);
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.sub)));
  show('chats');
}

/* --- admin: support chats --- */
async function renderSupportChats(body) {
  body.innerHTML = '<div class="admin-list" id="sch-list"><div class="loading">Loading conversations…</div></div>';
  await refreshSupportThreads(body);
}

async function refreshSupportThreads(body) {
  // If a thread is open, keep the thread view (just refresh its messages).
  if (ADMIN.supportOpenUser) {
    await openSupportThread(body, ADMIN.supportOpenUser, true);
    return;
  }
  const list = body.querySelector('#sch-list');
  if (!list) return;
  try {
    ADMIN.supportThreads = await Api.adminSupportThreads();
    if (!ADMIN.supportThreads.length) {
      list.innerHTML = '<div class="loading">No support conversations yet.</div>';
      return;
    }
    list.innerHTML = '';
    ADMIN.supportThreads.forEach((t) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'admin-user-row support-thread-row';
      const when = t.lastAt ? new Date(t.lastAt).toLocaleString() : '';
      row.innerHTML =
        '<div class="au-main">' +
          '<div class="au-name">' + esc(t.name) +
            (t.unreadCount > 0 ? ' <span class="ban-badge">' + t.unreadCount + ' new</span>' : '') + '</div>' +
          '<div class="au-email">' + esc(t.email) + ' · ' + esc(when) + '</div>' +
          '<div class="au-meta">' + (t.lastSender === 'admin' ? 'You: ' : '') + esc((t.lastText || '').slice(0, 80)) + '</div>' +
        '</div>';
      row.addEventListener('click', () => openSupportThread(body, t.userId, false));
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

async function openSupportThread(body, userId, keepOpen) {
  if (!keepOpen) ADMIN.supportOpenUser = userId;
  body.innerHTML =
    '<button class="btn-outline sm" id="sthread-back" type="button">‹ All chats</button>' +
    '<div class="support-messages admin-thread" id="sthread-msgs"><div class="loading">Loading…</div></div>' +
    '<div class="support-input-row">' +
      '<input id="sthread-input" type="text" placeholder="Reply…" maxlength="1000" autocomplete="off">' +
      '<button class="btn-gold sm" id="sthread-send" type="button">Send</button>' +
    '</div>';
  body.querySelector('#sthread-back').addEventListener('click', () => {
    ADMIN.supportOpenUser = null;
    renderSupportChats(body);
  });
  const sendReply = () => {
    const input = body.querySelector('#sthread-input');
    const text = input.value.trim();
    if (!text) return;
    ensureSocket();
    if (!Socket.send('support:reply', { userId, text })) {
      toast('Not connected — try again in a moment');
      return;
    }
    appendSupportMsg(body.querySelector('#sthread-msgs'), { sender: 'admin', text, mine: true });
    input.value = '';
  };
  body.querySelector('#sthread-send').addEventListener('click', sendReply);
  body.querySelector('#sthread-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendReply(); }
  });
  try {
    const res = await Api.adminSupportThread(userId);
    const box = body.querySelector('#sthread-msgs');
    box.innerHTML = '';
    (res.messages || []).forEach((m) => appendSupportMsg(box, m));
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    body.querySelector('#sthread-msgs').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* --- admin: notices (announcements) --- */
async function renderSupportNotices(body) {
  body.innerHTML =
    '<div class="admin-list" id="sno-list"><div class="loading">Loading notices…</div></div>' +
    '<h3 class="stats-title" id="sno-form-title">New notice</h3>' +
    '<div class="bonus-form">' +
      '<label>Title<input id="sno-title" type="text" maxlength="120" placeholder="Notice title"></label>' +
      '<label>Body<textarea id="sno-body" rows="3" maxlength="2000" placeholder="Notice text shown on the home screen"></textarea></label>' +
      '<div class="profile-actions">' +
        '<button class="btn-gold" id="sno-save" type="button">Publish</button>' +
        '<button class="btn-outline hidden" id="sno-cancel" type="button">Cancel</button>' +
      '</div>' +
      '<p class="form-err" id="sno-err"></p>' +
    '</div>';
  await refreshNotices(body);
  body.querySelector('#sno-save').addEventListener('click', () => saveNotice(body));
  body.querySelector('#sno-cancel').addEventListener('click', () => {
    ADMIN.editingNotice = null;
    renderSupportNotices(body);
  });
}

async function refreshNotices(body) {
  const list = body.querySelector('#sno-list');
  try {
    ADMIN.notices = await Api.adminAnnouncements();
    if (!ADMIN.notices.length) {
      list.innerHTML = '<div class="loading">No notices yet.</div>';
      return;
    }
    list.innerHTML = '';
    ADMIN.notices.forEach((n) => {
      const row = document.createElement('div');
      row.className = 'admin-user-row' + (n.active ? '' : ' disabled');
      row.innerHTML =
        '<div class="au-main">' +
          '<div class="au-name">' + esc(n.title) + (n.active ? '' : ' <span class="ban-badge">OFF</span>') + '</div>' +
          '<div class="au-meta">' + esc(n.body.slice(0, 120)) + '</div>' +
        '</div><div class="au-actions"></div>';
      const actions = row.querySelector('.au-actions');
      const mk = (label, fn, cls) => {
        const b = document.createElement('button');
        b.className = 'btn-outline sm' + (cls ? ' ' + cls : '');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => fn(n));
        actions.appendChild(b);
        return b;
      };
      mk(n.active ? 'Hide' : 'Show', async (x) => {
        try { await Api.adminUpdateAnnouncement(x.id, { active: !x.active }); refreshNotices(body); }
        catch (e) { toast(e.message); }
      });
      mk('Edit', (x) => {
        ADMIN.editingNotice = x;
        body.querySelector('#sno-form-title').textContent = 'Edit notice';
        body.querySelector('#sno-title').value = x.title;
        body.querySelector('#sno-body').value = x.body;
        body.querySelector('#sno-save').textContent = 'Save';
        body.querySelector('#sno-cancel').classList.remove('hidden');
      });
      mk('Delete', async (x) => {
        try { await Api.adminDeleteAnnouncement(x.id); refreshNotices(body); toast('Notice deleted'); }
        catch (e) { toast(e.message); }
      }, 'danger');
      list.appendChild(row);
    });
  } catch (e) {
    list.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

async function saveNotice(body) {
  const errEl = body.querySelector('#sno-err');
  const title = body.querySelector('#sno-title').value.trim();
  const nbody = body.querySelector('#sno-body').value.trim();
  if (!title || !nbody) { errEl.textContent = 'Title and body are required.'; return; }
  errEl.textContent = '';
  try {
    if (ADMIN.editingNotice) {
      await Api.adminUpdateAnnouncement(ADMIN.editingNotice.id, { title, body: nbody });
      ADMIN.editingNotice = null;
      toast('Notice updated');
    } else {
      await Api.adminCreateAnnouncement(title, nbody);
      toast('Notice published');
    }
    renderSupportNotices(body);
  } catch (e) { errEl.textContent = e.message; }
}

function bindAdmin() {
  $('#admin-back').addEventListener('click', () => { location.hash = '#/home'; });
  $('#admin-coins-give').addEventListener('click', () => adminAdjustCoins(1));
  $('#admin-coins-take').addEventListener('click', () => adminAdjustCoins(-1));
}

/* ---------------- user support chat ---------------- */
function supportMsgHTML(m) {
  const who = m.sender === 'admin' ? 'admin' : 'user';
  return '<div class="smsg ' + who + (m.mine ? ' mine' : '') + '"><div class="smsg-bubble">' +
    esc(m.text) + '</div></div>';
}

function appendSupportMsg(box, m) {
  const tmp = document.createElement('div');
  tmp.innerHTML = supportMsgHTML(m);
  box.appendChild(tmp.firstChild);
  box.scrollTop = box.scrollHeight;
}

function openSupportSheet() {
  const box = $('#support-messages');
  box.innerHTML = '<div class="loading">' + esc(t('sup.loading')) + '</div>';
  openModal('#modal-support');
  ensureSocket();
  if (!Socket.send('support:history', {})) {
    box.innerHTML = '<div class="loading">' + esc(t('sup.connecting')) + '</div>';
    const iv = setInterval(() => {
      if (Socket.isConnected()) {
        clearInterval(iv);
        Socket.send('support:history', {});
      }
    }, 800);
    setTimeout(() => clearInterval(iv), 10000);
  }
}

function sendSupportMessage() {
  const input = $('#support-input');
  const text = input.value.trim();
  if (!text) return;
  ensureSocket();
  if (!Socket.send('support:send', { text })) {
    toast(t('sup.notConnected'));
    return;
  }
  input.value = '';
  // The server echoes the message back via 'support:message' (mine:true).
}

function bindSupport() {
  $('#support-btn').addEventListener('click', openSupportSheet);
  $('#support-send').addEventListener('click', sendSupportMessage);
  $('#support-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendSupportMessage(); }
  });
  Socket.on('support:history', (d) => {
    const box = $('#support-messages');
    const msgs = (d && d.messages) || [];
    box.innerHTML = '';
    if (!msgs.length) box.innerHTML = '<div class="loading">' + esc(t('sup.empty')) + '</div>';
    msgs.forEach((m) => appendSupportMsg(box, m));
  });
  Socket.on('support:message', (m) => {
    if (!m) return;
    if ($('#modal-support').classList.contains('open')) {
      appendSupportMsg($('#support-messages'), m);
    } else if (m.sender === 'admin') {
      toast(t('sup.newReply'));
    }
  });
  // Admin side: a new/updated conversation arrives live.
  Socket.on('support:incoming', (d) => {
    if (!(store.user && store.user.isAdmin)) return;
    if (adminCurrentTab === 'support' && ADMIN.supportSub !== 'notices') {
      const body = document.querySelector('#apane-support');
      if (body) {
        if (ADMIN.supportOpenUser && d && d.userId === ADMIN.supportOpenUser && d.sender === 'user') {
          appendSupportMsg(body.querySelector('#sthread-msgs'), { sender: 'user', text: d.text });
        } else {
          ADMIN.supportOpenUser = null;
          refreshSupportThreads(body);
        }
      }
    }
  });
}

/* ---------------- announcements (home banner) ---------------- */
let announceItems = [];
let announceIdx = 0;
let announceTimer = null;
let announceDismissed = false;

async function loadAnnouncements() {
  const bar = $('#announce-bar');
  if (!bar || announceDismissed) return;
  clearInterval(announceTimer);
  try {
    const items = await Api.announcements();
    announceItems = (items || []).slice(0, 5);
    if (!announceItems.length) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const fb = $('#promo-fallback');
    if (fb) fb.classList.add('hidden');
    announceIdx = 0;
    renderAnnounce();
    if (announceItems.length > 1) {
      announceTimer = setInterval(() => {
        announceIdx = (announceIdx + 1) % announceItems.length;
        renderAnnounce();
      }, 6000);
    }
  } catch (e) { /* announcements are best-effort; never block home */ }
}

function renderAnnounce() {
  const bar = $('#announce-bar');
  const a = announceItems[announceIdx];
  if (!a) return;
  bar.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'announce-title';
  title.textContent = a.title;
  const body = document.createElement('div');
  body.className = 'announce-body';
  body.textContent = a.body;
  const x = document.createElement('button');
  x.className = 'announce-x';
  x.type = 'button';
  x.setAttribute('aria-label', 'Dismiss announcements');
  x.innerHTML = '<svg class="ic"><use href="#icon-x"/></svg>';
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    announceDismissed = true;
    clearInterval(announceTimer);
    bar.classList.add('hidden');
  });
  bar.appendChild(title);
  bar.appendChild(body);
  bar.appendChild(x);
  if (announceItems.length > 1) {
    const dots = document.createElement('div');
    dots.className = 'announce-dots';
    announceItems.forEach((_, j) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = 'adot' + (j === announceIdx ? ' active' : '');
      d.setAttribute('aria-label', 'Announcement ' + (j + 1));
      d.addEventListener('click', () => { announceIdx = j; renderAnnounce(); });
      dots.appendChild(d);
    });
    bar.appendChild(dots);
  }
}

/* ---------------- global bindings ---------------- */
function updateLangSeg() {
  const lang = getLang();
  document.querySelectorAll('[data-lang-set]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-lang-set') === lang);
  });
}

/* Re-render the current screen after a language switch so JS-rendered
 * strings refresh. Static [data-i18n] elements are already handled by
 * applyI18n() (it runs before this event fires). */
function rerenderForLang() {
  updateLangSeg();
  try {
    const parsed = parseHash();
    // Skip splash (its enter handler schedules a redirect).
    if (parsed.name && parsed.name !== 'splash' && ENTER[parsed.name]) ENTER[parsed.name](parsed.query);
  } catch (e) { /* best effort */ }
}
document.addEventListener('ludo:lang-changed', rerenderForLang);

function bindGlobal() {
  document.addEventListener('click', (e) => {
    const tEl = e.target.closest('[data-toast]');
    if (tEl) {
      const key = tEl.getAttribute('data-toast');
      toast(tHas(key) ? t(key) : key);
      return;
    }
    const c = e.target.closest('[data-close]');
    if (c) {
      const ov = c.closest('.modal-overlay');
      if (ov) ov.classList.remove('open');
    }
  });
  // Language toggles: header pill [data-lang-toggle] + profile [data-lang-set].
  document.querySelectorAll('[data-lang-toggle]').forEach((b) => {
    b.addEventListener('click', () => setLang(getLang() === 'bn' ? 'en' : 'bn'));
  });
  document.querySelectorAll('[data-lang-set]').forEach((b) => {
    b.addEventListener('click', () => setLang(b.getAttribute('data-lang-set')));
  });
  updateLangSeg();
  // One global 1s interval drives all live countdowns (tournaments, match join window).
  if (!window.__ludoCountdownTick) {
    window.__ludoCountdownTick = setInterval(tickCountdowns, 1000);
  }
}

/* ----- coin requests ----- */
async function renderAdminRequestsTab(pane) {
  pane.innerHTML =
    '<p class="admin-hint">Users request coin packs from their wallet — each request includes the payment method and transaction ID so you can verify the payment before approving. Approve to credit the coins, reject to decline.</p>' +
    '<div class="wallet-tabs" role="tablist">' +
    '<button class="wallet-tab active" data-rf="pending" type="button">Pending</button>' +
    '<button class="wallet-tab" data-rf="approved" type="button">Approved</button>' +
    '<button class="wallet-tab" data-rf="rejected" type="button">Rejected</button></div>' +
    '<div id="ar-req-list" class="admin-list"><div class="loading">Loading…</div></div>';
  let filter = 'pending';
  const list = pane.querySelector('#ar-req-list');
  const load = async () => {
    list.innerHTML = '<div class="loading">Loading…</div>';
    try {
      const res = await Api.adminRequests(filter);
      const rows = res.requests || [];
      if (!rows.length) { list.innerHTML = '<p class="empty-note">No ' + esc(filter) + ' requests.</p>'; return; }
      list.innerHTML = '';
      rows.forEach((r) => {
        const row = document.createElement('div');
        row.className = 'tx-row';
        const proof = (r.payment_method || r.transaction_id)
          ? '<span class="tx-proof">💳 ' + esc(r.payment_method || '') + ' · TxID: <b>' + esc(r.transaction_id || '') + '</b></span>'
          : '';
        row.innerHTML =
          '<div class="tx-info"><b>' + fmt(r.pack_coins) + ' coins</b><span>' +
          esc(r.user_name || r.user_id) + ' · ' + esc(fmtDate(r.created_at)) + '</span>' + proof + '</div>';
        if (filter === 'pending') {
          const wrap = document.createElement('div');
          wrap.style.display = 'flex'; wrap.style.gap = '8px';
          const okB = document.createElement('button');
          okB.className = 'btn-gold sm'; okB.type = 'button'; okB.textContent = 'Approve';
          const noB = document.createElement('button');
          noB.className = 'btn-outline sm danger'; noB.type = 'button'; noB.textContent = 'Reject';
          okB.addEventListener('click', () => decide(r.id, true, row));
          noB.addEventListener('click', () => decide(r.id, false, row));
          wrap.appendChild(okB); wrap.appendChild(noB);
          row.appendChild(wrap);
        } else {
          const badge = document.createElement('div');
          badge.className = 'req-badge ' + esc(r.status);
          badge.textContent = r.status;
          row.appendChild(badge);
        }
        list.appendChild(row);
      });
    } catch (e) { list.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>'; }
  };
  const decide = async (id, approve, row) => {
    try {
      await Api.adminDecideRequest(id, approve);
      toast(approve ? 'Coins credited' : 'Request rejected');
      row.remove();
    } catch (e) { toast(e.message); }
  };
  pane.querySelectorAll('[data-rf]').forEach((b) => {
    b.addEventListener('click', () => {
      filter = b.dataset.rf;
      pane.querySelectorAll('[data-rf]').forEach((x) => x.classList.toggle('active', x === b));
      load();
    });
  });
  load();
}

/* ----- custom options ----- */
async function renderAdminOptionsTab(pane) {
  pane.innerHTML =
    '<p class="admin-hint">Add link buttons to the app home screen — no code needed. Example: Facebook page, YouTube channel, rules page.</p>' +
    '<div id="ao-list" class="admin-list"><div class="loading">Loading…</div></div>' +
    '<button class="btn-outline sm" id="ao-add" type="button">+ Add option</button>' +
    '<div class="admin-save-row"><button class="btn-gold" id="ao-save" type="button">Save options</button></div>';
  let opts = [];
  const list = pane.querySelector('#ao-list');
  const paint = () => {
    list.innerHTML = '';
    if (!opts.length) list.innerHTML = '<p class="empty-note">No custom options yet.</p>';
    opts.forEach((o) => {
      const row = document.createElement('div');
      row.className = 'admin-tier-row';
      row.innerHTML =
        '<label>Title<input type="text" maxlength="40" class="opt-title" value="' + esc(o.title) + '"></label>' +
        '<label>URL<input type="url" class="opt-url" value="' + esc(o.url) + '" placeholder="https://…"></label>' +
        '<label class="tier-enabled"><input type="checkbox" class="opt-check"' + (o.enabled === false ? '' : ' checked') + '> Enabled</label>' +
        '<button class="btn-outline sm danger" type="button">Remove</button>';
      row.querySelector('.opt-title').addEventListener('input', (e) => { o.title = e.target.value; });
      row.querySelector('.opt-url').addEventListener('input', (e) => { o.url = e.target.value; });
      row.querySelector('.opt-check').addEventListener('change', (e) => { o.enabled = e.target.checked; });
      row.querySelector('button').addEventListener('click', () => {
        opts.splice(opts.indexOf(o), 1); paint();
      });
      list.appendChild(row);
    });
  };
  try {
    const res = await Api.adminOptions();
    opts = res.options || [];
  } catch (e) {
    list.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    return;
  }
  pane.querySelector('#ao-add').addEventListener('click', () => {
    if (opts.length >= 12) { toast('Maximum 12 options'); return; }
    opts.push({ id: 'new-' + Date.now(), title: '', url: '', enabled: true });
    paint();
  });
  pane.querySelector('#ao-save').addEventListener('click', async () => {
    try {
      const res = await Api.adminSaveOptions(opts);
      opts = res.options || [];
      paint();
      toast('Options saved');
    } catch (e) { toast(e.message); }
  });
  paint();
}

/* ----- private rooms ----- */
const PRIV = { poll: null, room: null, seats: 2, commissionPct: 10 };

/* Local REST helper for private rooms (kept here so js/api.js stays untouched). */
async function papi(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = localStorage.getItem('ludo_token');
  if (t) headers['Authorization'] = 'Bearer ' + t;
  const res = await fetch(CONFIG.API_BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    localStorage.removeItem('ludo_token');
    localStorage.removeItem('ludo_user');
    if (location.hash !== '#/auth') location.hash = '#/auth';
    throw new Error(t('err.session'));
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || 'Request failed');
  return data;
}

ENTER.private = async () => {
  renderPrivateHome();
  try {
    const cfg = await papi('GET', '/api/private/config');
    PRIV.commissionPct = Number(cfg.commissionPct);
    if (!Number.isInteger(PRIV.commissionPct)) PRIV.commissionPct = 10;
    const note = $('#priv-comm-note');
    if (note) note.textContent = t('priv.commNote', { n: PRIV.commissionPct });
  } catch (e) { /* keep default */ }
  // Deep link: #/private?code=ABC123 → pre-fill and join.
  const q = new URLSearchParams((location.hash.split('?')[1] || ''));
  const code = (q.get('code') || '').toUpperCase().trim();
  if (/^[A-Z0-9]{6}$/.test(code)) {
    const inp = $('#priv-join-code');
    if (inp) inp.value = code;
    joinPrivateRoom(code);
  }
  if (PRIV.poll) clearInterval(PRIV.poll);
  PRIV.poll = setInterval(() => {
    if ((location.hash || '').indexOf('#/private') === 0 && PRIV.room && PRIV.room.status === 'waiting') {
      refreshPrivateRoom(true);
    }
  }, 5000);
};

function bindPrivateRoom() {
  $('#private-back').addEventListener('click', () => { location.hash = '#/home'; });
  const pb = $('#private-btn');
  if (pb) pb.addEventListener('click', () => { location.hash = '#/private'; });
  Socket.on('private:update', (d) => {
    if ((location.hash || '').indexOf('#/private') === 0 && d && PRIV.room && d.roomId === PRIV.room.id) {
      refreshPrivateRoom(true);
    }
  });
}

function renderPrivateHome() {
  PRIV.room = null;
  const body = $('#private-body');
  body.innerHTML =
    '<div class="priv-card">' +
    '<h3>' + esc(t('priv.createTitle')) + '</h3>' +
    '<p class="admin-hint">' + esc(t('priv.createHint')) + '</p>' +
    '<label class="priv-label">' + esc(t('priv.entryLabel')) +
    '<input type="number" id="priv-entry" min="50" max="100000" value="100"></label>' +
    '<div class="chips">' + [100, 500, 1000, 5000].map((c) =>
      '<button class="chip" data-c="' + c + '" type="button">' + fmt(c) + '</button>').join('') + '</div>' +
    '<div class="seg" id="priv-seats">' +
    '<button class="seg-btn active" data-s="2" type="button">' + esc(t('priv.seats2')) + '</button>' +
    '<button class="seg-btn" data-s="4" type="button">' + esc(t('priv.seats4')) + '</button></div>' +
    '<p class="priv-comm" id="priv-comm-note"></p>' +
    '<button class="btn-gold wide" id="priv-create-btn" type="button">' + esc(t('priv.create')) + '</button>' +
    '</div>' +
    '<div class="priv-card">' +
    '<h3>' + esc(t('priv.joinTitle')) + '</h3>' +
    '<p class="admin-hint">' + esc(t('priv.joinHint')) + '</p>' +
    '<input type="text" id="priv-join-code" maxlength="6" placeholder="ABC123" autocomplete="off">' +
    '<button class="btn-outline wide" id="priv-join-btn" type="button">' + esc(t('priv.join')) + '</button>' +
    '</div>';

  body.querySelectorAll('.chip').forEach((ch) => {
    ch.addEventListener('click', () => { $('#priv-entry').value = ch.dataset.c; });
  });
  body.querySelectorAll('#priv-seats .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      PRIV.seats = Number(b.dataset.s);
      body.querySelectorAll('#priv-seats .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  $('#priv-create-btn').addEventListener('click', createPrivateRoom);
  $('#priv-join-btn').addEventListener('click', () => joinPrivateRoom());
  const ji = $('#priv-join-code');
  ji.addEventListener('input', () => { ji.value = ji.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  ji.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinPrivateRoom(); });
}

async function createPrivateRoom() {
  const entry = Math.floor(Number(($('#priv-entry') || {}).value));
  const btn = $('#priv-create-btn');
  btn.disabled = true;
  try {
    const res = await papi('POST', '/api/private/create', { entryFee: entry, maxPlayers: PRIV.seats });
    PRIV.room = res.room;
    await refreshMe();
    renderPrivateWaiting();
    toast(t('priv.created'));
  } catch (e) { toast(e.message); }
  btn.disabled = false;
}

async function joinPrivateRoom(code) {
  code = (code || ((($('#priv-join-code') || {}).value) || '')).toUpperCase().trim();
  if (!/^[A-Z0-9]{6}$/.test(code)) { toast(t('priv.badCode')); return; }
  try {
    const res = await papi('POST', '/api/private/join', { code });
    PRIV.room = res.room;
    await refreshMe();
    if (PRIV.room.status === 'ongoing') {
      toast(t('priv.started')); // game:start arrives via socket → #/game
      return;
    }
    renderPrivateWaiting();
  } catch (e) { toast(e.message); }
}

function renderPrivateWaiting() {
  const r = PRIV.room;
  const body = $('#private-body');
  const me = store.user || {};
  const isCreator = r.creatorId === me.id;
  const pool = r.entryFee * r.maxPlayers;
  const prize = Math.round((pool * (100 - r.commissionPct)) / 100);
  const shareUrl = 'https://t.me/share/url?url=' +
    encodeURIComponent(location.origin + location.pathname + '#/private?code=' + r.code) +
    '&text=' + encodeURIComponent('Join my Ludo private room! Entry ' + r.entryFee + ' coins. Code: ' + r.code);
  body.innerHTML =
    '<div class="priv-card priv-waiting">' +
    '<p class="admin-hint">' + esc(t('priv.shareCode')) + '</p>' +
    '<div class="priv-code">' + esc(r.code) + '</div>' +
    '<div class="priv-actions">' +
    '<button class="btn-outline sm" id="priv-copy" type="button">' + esc(t('priv.copyCode')) + '</button>' +
    '<a class="btn-outline sm priv-share" href="' + shareUrl + '" target="_blank" rel="noopener">' + esc(t('common.share')) + '</a>' +
    '</div>' +
    '<div class="priv-meta"><span>🎟️ ' + esc(t('rooms.entryWord')) + ' ' + fmt(r.entryFee) + '</span>' +
    '<span>👥 <b id="priv-count">' + r.playerCount + '</b>/' + r.maxPlayers + '</span></div>' +
    '<p class="priv-comm">' + t('priv.prizeNote', { pool: fmt(pool), pct: r.commissionPct, prize: fmt(prize) }) + '</p>' +
    '<div id="priv-players"></div>' +
    '<p class="waiting-note"><span class="pulse"></span> ' + esc(t('priv.waiting')) + '</p>' +
    (isCreator
      ? '<button class="btn-outline sm danger wide" id="priv-cancel" type="button">' + esc(t('priv.cancel')) + '</button>'
      : '<button class="btn-outline sm wide" id="priv-leave" type="button">' + esc(t('priv.leave')) + '</button>') +
    '</div>';
  paintPrivatePlayers(r);
  $('#priv-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(r.code); toast(t('priv.codeCopied')); }
    catch (e) { toast(r.code); }
  });
  const cancelBtn = $('#priv-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    try {
      await papi('POST', '/api/private/' + encodeURIComponent(r.id) + '/cancel', {});
      PRIV.room = null;
      renderPrivateHome();
      toast(t('priv.cancelled'));
    } catch (e) { toast(e.message); }
  });
  const leaveBtn = $('#priv-leave');
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    try {
      await papi('POST', '/api/private/' + encodeURIComponent(r.id) + '/leave', {});
      PRIV.room = null;
      await refreshMe();
      renderPrivateHome();
      toast(t('priv.left'));
    } catch (e) { toast(e.message); }
  });
  try { Socket.emit('private:watch', { roomId: r.id }); } catch (e) { /* offline */ }
}

function paintPrivatePlayers(r) {
  const box = $('#priv-players');
  if (!box) return;
  box.innerHTML = (r.players || []).map((p) =>
    '<div class="priv-player"><span class="priv-avatar">' + esc((p.name || '?').slice(0, 1).toUpperCase()) + '</span>' +
    '<b>' + esc(p.name || 'Player') + '</b>' +
    (p.isCreator ? '<span class="priv-crown">👑 host</span>' : '') + '</div>'
  ).join('');
}

async function refreshPrivateRoom(quiet) {
  if (!PRIV.room) return;
  try {
    const res = await papi('GET', '/api/private/' + encodeURIComponent(PRIV.room.code));
    PRIV.room = res.room;
    if (PRIV.room.status === 'ongoing') {
      // game:start arrives via socket and moves us to #/game.
      if (PRIV.poll) { clearInterval(PRIV.poll); PRIV.poll = null; }
      return;
    }
    if (PRIV.room.status !== 'waiting') {
      PRIV.room = null;
      renderPrivateHome();
      if (!quiet) toast(t('priv.closed'));
      return;
    }
    const c = $('#priv-count');
    if (c) c.textContent = PRIV.room.playerCount;
    paintPrivatePlayers(PRIV.room);
  } catch (e) { if (!quiet) toast(e.message); }
}

/* ----- leaderboard + missions ----- */
let lbPeriod = 'weekly';
let lbTab = 'board';
let lbPoll = null;

function lbFetch(path, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  const t = localStorage.getItem('ludo_token');
  if (t) headers['Authorization'] = 'Bearer ' + t;
  return fetch(CONFIG.API_BASE + path, {
    method: method || 'GET',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data && (data.message || data.error)) || 'Request failed');
    return data;
  });
}

ENTER.leaderboard = async () => {
  document.querySelectorAll('.lb-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.lbtab === lbTab);
  });
  document.querySelectorAll('.lb-period').forEach((b) => {
    b.classList.toggle('active', b.dataset.period === lbPeriod);
  });
  paintLbTab();
  if (lbPoll) clearInterval(lbPoll);
  lbPoll = setInterval(() => {
    if (parseHash().name === 'leaderboard') paintLbTab();
    else { clearInterval(lbPoll); lbPoll = null; }
  }, 30000);
};

function bindLeaderboard() {
  const back = document.getElementById('lb-back');
  if (back) back.addEventListener('click', () => { location.hash = '#/home'; });
  document.querySelectorAll('.lb-tab').forEach((b) => {
    b.addEventListener('click', () => { lbTab = b.dataset.lbtab; ENTER.leaderboard(); });
  });
  document.querySelectorAll('.lb-period').forEach((b) => {
    b.addEventListener('click', () => { lbPeriod = b.dataset.period; paintLbTab(); });
  });
}

function lbMedal(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return '#' + rank;
}

async function paintLbTab() {
  const pane = document.getElementById('lb-pane');
  const meBox = document.getElementById('lb-me-rank');
  const periodRow = document.getElementById('lb-period-row');
  if (!pane) return;
  if (periodRow) periodRow.style.display = lbTab === 'board' ? '' : 'none';
  if (meBox && lbTab !== 'board') meBox.innerHTML = '';
  if (lbTab === 'missions') return paintMissions(pane);
  pane.innerHTML = '<div class="loading">' + esc(t('lb.loading')) + '</div>';
  try {
    const [res, me] = await Promise.all([
      lbFetch('/api/leaderboard?period=' + lbPeriod),
      store.token ? lbFetch('/api/leaderboard/me?period=' + lbPeriod).catch(() => null) : Promise.resolve(null),
    ]);
    const board = res.board || [];
    const myId = store.user && store.user.id;
    if (meBox) {
      meBox.innerHTML = me
        ? '<div class="lb-me-card">' + esc(t('lb.yourRank', { rank: me.rank, wins: fmt(me.wins) })) + '</div>'
        : '<div class="lb-me-card dim">' + esc(t('lb.unranked')) + '</div>';
    }
    if (!board.length) {
      pane.innerHTML = '<p class="empty-note">' + esc(t('lb.empty', { period: t(lbPeriod === 'weekly' ? 'lb.week' : 'lb.periodWord') })) + '</p>';
      return;
    }
    pane.innerHTML = board.map((r) =>
      '<div class="tx-row lb-row' + (myId && String(r.userId) === String(myId) ? ' lb-me' : '') + '">' +
      '<div class="lb-rank">' + lbMedal(r.rank) + '</div>' +
      '<div class="tx-info"><b>' + esc(r.name) + '</b><span>' + esc(t('lb.playedGames', { n: fmt(r.played) })) + '</span></div>' +
      '<div class="lb-wins">' + fmt(r.wins) + ' 🏆</div>' +
      '</div>'
    ).join('');
  } catch (e) {
    pane.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

async function paintMissions(pane) {
  pane.innerHTML = '<div class="loading">' + esc(t('lb.missionsLoading')) + '</div>';
  try {
    const res = await lbFetch('/api/missions');
    const list = res.missions || [];
    pane.innerHTML = '<p class="admin-hint">' + esc(t('lb.missionsHint')) + '</p>' +
      list.map((m) => {
        const pct = Math.min(100, Math.round((m.progress / m.target) * 100));
        const btn = m.claimed
          ? '<button class="btn-outline sm" disabled type="button">' + esc(t('lb.claimed')) + '</button>'
          : m.complete
            ? '<button class="btn-gold sm lb-claim" data-key="' + esc(m.key) + '" type="button">' + esc(t('lb.claim', { n: fmt(m.reward) })) + '</button>'
            : '<button class="btn-outline sm" disabled type="button">' + esc(t('lb.reward', { n: fmt(m.reward) })) + '</button>';
        return '<div class="mission-card">' +
          '<div class="mission-head"><b>' + esc(m.title) + '</b>' + btn + '</div>' +
          '<div class="mission-bar"><div class="mission-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="mission-prog">' + fmt(Math.min(m.progress, m.target)) + '/' + m.target + '</div>' +
          '</div>';
      }).join('');
    pane.querySelectorAll('.lb-claim').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const r = await lbFetch('/api/missions/claim', 'POST', { key: b.dataset.key });
          toast(t('lb.rewardToast', { n: fmt(r.reward) }));
          await refreshMe();
          paintMissions(pane);
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      });
    });
  } catch (e) {
    pane.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* ----- quick chat (feature build replaces this stub) ----- */
function bindQuickChat() {
  const screen = document.getElementById('screen-game');
  const btn = document.getElementById('qc-btn');
  const popup = document.getElementById('qc-popup');
  const bubble = document.getElementById('qc-bubble');
  if (!screen || !btn || !popup || !bubble) return;
  let bubbleTimer = null;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    popup.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (popup.classList.contains('open') && !popup.contains(e.target) && e.target !== btn) {
      popup.classList.remove('open');
    }
  });
  popup.querySelectorAll('[data-msg]').forEach((b) => {
    b.addEventListener('click', () => {
      const roomId = G.state && G.state.roomId;
      if (roomId) Socket.emit('chat:quick', { roomId, msgId: Number(b.dataset.msg) });
      popup.classList.remove('open');
    });
  });

  Socket.on('chat:quick', (d) => {
    if (!d) return;
    const msgKey = d.msgId ? 'qc.m' + d.msgId : null;
    const text = (msgKey && tHas(msgKey)) ? t(msgKey) : d.text;
    if (!text) return;
    bubble.textContent = (d.from ? d.from + ': ' : '') + text;
    bubble.classList.add('show');
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), 3000);
  });

  // Only show the button while an active game is on screen.
  const refresh = () => {
    const active = screen.classList.contains('active') && !!G.state;
    btn.classList.toggle('hidden', !active);
    if (!active) popup.classList.remove('open');
  };
  new MutationObserver(refresh).observe(screen, { attributes: true, attributeFilter: ['class'] });
  refresh();
}

/* ----- private rooms commission ----- */
async function renderAdminPrivateTab(pane) {
  pane.innerHTML =
    '<p class="admin-hint">Commission taken from every private-room prize pool. Set once, update anytime — rooms already created keep the rate they started with.</p>' +
    '<div class="admin-form-row"><label>Commission %<input type="number" id="ap-pct" min="0" max="50" step="1"></label>' +
    '<button class="btn-gold sm" id="ap-save" type="button">Save</button></div>' +
    '<p class="admin-hint" id="ap-note"></p>';
  try {
    const res = await Api.adminPrivateConfig();
    pane.querySelector('#ap-pct').value = res.pct !== undefined ? res.pct : 10;
  } catch (e) {
    pane.querySelector('#ap-note').textContent = e.message;
  }
  pane.querySelector('#ap-save').addEventListener('click', async () => {
    const pct = Number(pane.querySelector('#ap-pct').value);
    try {
      const res = await Api.adminSavePrivateConfig(pct);
      pane.querySelector('#ap-note').textContent = 'Saved — commission is now ' + res.pct + '%.';
      toast('Private commission: ' + res.pct + '%');
    } catch (e) { toast(e.message); }
  });
}

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  bindGlobal();
  bindSounds();
  bindAuth();
  bindHome();
  bindLanding();
  bindBottomNav();
  bindRooms();
  bindGame();
  bindProfile();
  bindDashboard();
  bindWallet();
  bindStore();
  bindRedeem();
  bindTournament();
  bindPrivateRoom();
  bindLeaderboard();
  bindQuickChat();
  bindAdmin();
  bindSupport();
  if (!location.hash) location.hash = '#/splash';
  navigate();
});

})();

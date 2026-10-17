/* Ludo Master 3D — REST API client.
 * Vanilla fetch wrapper. Attaches the stored JWT as a Bearer token.
 * On 401 the token is cleared and the user is sent back to #/auth. */
const Api = (() => {
  const TOKEN_KEY = 'ludo_token';

  function token() {
    return localStorage.getItem(TOKEN_KEY);
  }

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;

    let res;
    try {
      res = await fetch(CONFIG.API_BASE + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error(t('err.network'));
    }

    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem('ludo_user');
      if (location.hash !== '#/auth') location.hash = '#/auth';
      throw new Error(t('err.session'));
    }

    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }

    if (!res.ok) {
      throw new Error((data && (data.message || data.error)) || ('Request failed (' + res.status + ')'));
    }
    return data;
  }

  return {
    signup: (name, email, phone, password) =>
      request('POST', '/api/auth/signup', { name, email, phone, password }),
    login: (login, password) =>
      request('POST', '/api/auth/login', { login, password }),
    forgot: (login) =>
      request('POST', '/api/auth/forgot', { login }),
    resetPassword: (login, code, newPassword) =>
      request('POST', '/api/auth/reset', { login, code, newPassword }),
    me: () =>
      request('GET', '/api/me'),
    updateMe: (patch) =>
      request('PUT', '/api/me', patch),
    stats: () =>
      request('GET', '/api/stats'),
    rooms: () =>
      request('GET', '/api/rooms'),
    dailyBonus: () =>
      request('POST', '/api/wallet/daily', {}),
    announcements: () =>
      request('GET', '/api/announcements'),

    /* ---- wallet ---- */
    walletHistory: (limit) =>
      request('GET', '/api/wallet/history?limit=' + (limit || 50)),
    requestCoins: (packCoins, paymentMethod, transactionId) =>
      request('POST', '/api/wallet/request', { packCoins, paymentMethod, transactionId }),
    myRequests: () =>
      request('GET', '/api/wallet/requests'),
    coinPacks: () =>
      request('GET', '/api/coin-packs'),
    customOptions: () =>
      request('GET', '/api/custom-options'),

    /* ---- coin store (free daily packs) ---- */
    coinStoreStatus: () =>
      request('GET', '/api/coin-store/status'),
    claimCoinStore: (amount) =>
      request('POST', '/api/coin-store/claim', { amount }),

    /* ---- redeem rewards (promo codes) ---- */
    redeemCode: (code) =>
      request('POST', '/api/redeem', { code }),
    adminRedeemCodes: () =>
      request('GET', '/api/admin/redeem-codes'),
    adminCreateRedeemCode: (code, coins, max_uses) =>
      request('POST', '/api/admin/redeem-codes', { code, coins, max_uses }),
    adminDeleteRedeemCode: (code) =>
      request('DELETE', '/api/admin/redeem-codes/' + encodeURIComponent(code)),

    /* ---- telegram ---- */
    telegramBotInfo: () =>
      request('GET', '/api/telegram/bot-info'),
    telegramLinkCode: () =>
      request('POST', '/api/telegram/link-code', {}),
    telegramLinkStatus: () =>
      request('GET', '/api/telegram/link-status'),
    telegramUnlink: () =>
      request('POST', '/api/telegram/unlink', {}),

    /* ---- tournaments ---- */
    tournaments: () =>
      request('GET', '/api/tournaments'),
    tournamentDetail: (id) =>
      request('GET', '/api/tournaments/' + encodeURIComponent(id)),
    tournamentJoin: (id) =>
      request('POST', '/api/tournaments/' + encodeURIComponent(id) + '/join', {}),
    tournamentReady: (id) =>
      request('POST', '/api/tournaments/' + encodeURIComponent(id) + '/ready', {}),

    /* ---- admin (requires isAdmin) ---- */
    adminStats: () =>
      request('GET', '/api/admin/stats'),
    adminAnalytics: (days) =>
      request('GET', '/api/admin/analytics?days=' + (days || 30)),
    adminUsers: (search, page) =>
      request('GET', '/api/admin/users?search=' + encodeURIComponent(search || '') + '&page=' + (page || 1)),
    adminGrantCoins: (id, delta) =>
      request('POST', '/api/admin/users/' + encodeURIComponent(id) + '/coins', { delta }),
    adminBan: (id, banned) =>
      request('POST', '/api/admin/users/' + encodeURIComponent(id) + '/ban', { banned }),
    adminGames: (limit) =>
      request('GET', '/api/admin/games?limit=' + (limit || 20)),
    adminConfig: () =>
      request('GET', '/api/admin/config'),
    adminSaveConfig: (cfg) =>
      request('PUT', '/api/admin/config', cfg),
    adminSupportThreads: () =>
      request('GET', '/api/admin/support/threads'),
    adminSupportThread: (userId) =>
      request('GET', '/api/admin/support/thread/' + encodeURIComponent(userId)),
    adminAnnouncements: () =>
      request('GET', '/api/admin/announcements'),
    adminCreateAnnouncement: (title, body) =>
      request('POST', '/api/admin/announcements', { title, body }),
    adminUpdateAnnouncement: (id, patch) =>
      request('PUT', '/api/admin/announcements/' + encodeURIComponent(id), patch),
    adminDeleteAnnouncement: (id) =>
      request('DELETE', '/api/admin/announcements/' + encodeURIComponent(id)),
    adminRequests: (status) =>
      request('GET', '/api/admin/requests?status=' + (status || 'pending')),
    adminDecideRequest: (id, approve) =>
      request('POST', '/api/admin/requests/' + encodeURIComponent(id) + '/' + (approve ? 'approve' : 'reject'), {}),
    adminOptions: () =>
      request('GET', '/api/admin/options'),
    adminSaveOptions: (options) =>
      request('PUT', '/api/admin/options', { options }),
    adminPrivateConfig: () =>
      request('GET', '/api/admin/private-config'),
    adminSavePrivateConfig: (pct) =>
      request('PUT', '/api/admin/private-config', { pct }),
    adminTournaments: () =>
      request('GET', '/api/admin/tournaments'),
    adminCreateTournament: (t) =>
      request('POST', '/api/admin/tournaments', t),
    adminStartTournament: (id) =>
      request('POST', '/api/admin/tournaments/' + encodeURIComponent(id) + '/start', {}),
    adminCancelTournament: (id) =>
      request('POST', '/api/admin/tournaments/' + encodeURIComponent(id) + '/cancel', {})
  };
})();

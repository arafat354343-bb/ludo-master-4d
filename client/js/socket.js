/* Ludo Master 3D — realtime client.
 * ---------------------------------------------------------------------------
 * TRANSPORT: prefers Socket.IO when the CDN client (window.io) is present,
 * otherwise falls back to a native WebSocket speaking JSON frames:
 *     client -> server : {"event":"<name>","data":{...}}
 *     server -> client : {"event":"<name>","data":{...}}
 * AUTH: Socket.IO uses the `auth: { token }` handshake option.
 *       Native WS passes ?token= in the query string AND sends an
 *       {"event":"auth","data":{"token":...}} frame right after open.
 * RECONNECT: automatic with exponential backoff (Socket.IO handles its own
 * when that transport is used; the native fallback implements it manually).
 * ---------------------------------------------------------------------------
 * WIRE CONTRACT (both transports use these event names):
 *   emit 'queue:join'  {mode:'2p'|'4p', entry:Number}
 *   emit 'queue:leave' {}
 *   emit 'game:roll'   {}
 *   emit 'game:move'   {tokenIndex:0..3}
 *   on   'queue:update' {mode, waiting:Number}
 *   on   'game:start'   <public state>
 *   on   'game:state'   <public state>
 *   on   'game:dice'    {value:1..6, color}
 *   on   'game:over'    {winner, winnerName, delta, isWinner, ...}
 *   on   'game:timer'   {seconds}            (optional, cosmetic)
 *   on   'error'        {message}
 * Public state shape:
 *   {roomId, mode, entry, players:[{id,name,color,isBot,tokens:[4],finishedCount}],
 *    turnColor, phase:'awaitingRoll'|'awaitingMove'|'over', dice,
 *    movableTokens:[], winner}
 * ------------------------------------------------------------------------ */
const Socket = (() => {
  const handlers = {};
  let token = null;
  let sio = null;
  let ws = null;
  let manualClose = false;
  let retryCount = 0;
  let retryTimer = null;
  let connected = false;
  // Outbox: user actions tapped while the socket is still connecting are
  // queued and flushed on connect (server stays authoritative and may
  // reject anything stale).
  const outbox = [];
  const OUTBOX_MAX = 20;
  function flushOutbox() {
    while (outbox.length) {
      const m = outbox.shift();
      emitNow(m.event, m.data);
    }
  }

  function on(event, cb) {
    (handlers[event] = handlers[event] || []).push(cb);
  }

  function fire(event, data) {
    (handlers[event] || []).forEach((cb) => {
      try { cb(data); } catch (e) { console.error('[socket] handler error:', e); }
    });
  }

  function useSocketIO() {
    return typeof window.io !== 'undefined';
  }

  function wsUrl() {
    let u = CONFIG.SOCKET_URL.replace(/^http/, 'ws');
    u += (u.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token || '');
    return u;
  }

  function connect(tok) {
    token = tok || localStorage.getItem('ludo_token') || null;
    manualClose = false;
    retryCount = 0;
    _open();
  }

  function _open() {
    clearTimeout(retryTimer);
    if (useSocketIO()) {
      try {
        sio = window.io(CONFIG.SOCKET_URL, {
          auth: { token: token },
          transports: ['websocket', 'polling'],
          reconnection: true,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 10000
        });
      } catch (e) {
        _scheduleNativeRetry();
        return;
      }
      sio.on('connect', () => { connected = true; retryCount = 0; flushOutbox(); fire('connect', {}); });
      sio.on('disconnect', () => { connected = false; fire('disconnect', {}); });
      ['queue:update', 'game:start', 'game:state', 'game:dice',
       'game:over', 'game:timer', 'error',
       'tournament:update',
       'support:message', 'support:history', 'support:incoming'].forEach((ev) => {
        sio.on(ev, (d) => fire(ev, d));
      });
      // Socket.IO client reconnects on its own; nothing else to do.
    } else {
      _openNative();
    }
  }

  function _openNative() {
    let sock;
    try {
      sock = new WebSocket(wsUrl());
    } catch (e) {
      _scheduleNativeRetry();
      return;
    }
    ws = sock;
    ws.onopen = () => {
      connected = true;
      retryCount = 0;
      try { ws.send(JSON.stringify({ event: 'auth', data: { token: token } })); } catch (e) {}
      flushOutbox();
      fire('connect', {});
    };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      if (msg && msg.event) fire(msg.event, msg.data);
    };
    ws.onclose = () => {
      connected = false;
      ws = null;
      fire('disconnect', {});
      if (!manualClose) _scheduleNativeRetry();
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  function _scheduleNativeRetry() {
    if (manualClose) return;
    retryCount++;
    const delay = Math.min(1000 * Math.pow(1.5, retryCount), 10000);
    retryTimer = setTimeout(_openNative, delay);
  }

  function emitNow(event, data) {
    if (sio && sio.connected) { sio.emit(event, data || {}); return true; }
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ event: event, data: data || {} }));
      return true;
    }
    return false;
  }

  function emit(event, data) {
    if (emitNow(event, data)) return true;
    // Not connected yet: buffer user actions, flush on connect.
    if (['queue:join', 'queue:leave', 'game:roll', 'game:move'].indexOf(event) >= 0) {
      if (outbox.length >= OUTBOX_MAX) outbox.shift();
      outbox.push({ event: event, data: data || {} });
      return true;
    }
    return false;
  }

  function joinQueue(mode, entry) { return emit('queue:join', { mode: mode, entry: entry }); }
  function leaveQueue() { return emit('queue:leave', {}); }
  function rollDice() { return emit('game:roll', {}); }
  function sendMove(tokenIndex) { return emit('game:move', { token: tokenIndex }); }
  function playTournamentMatch(matchId) { return emitNow('tournament:play', { matchId: matchId }); }

  // Generic send for non-game events (support chat, …). Returns false when
  // offline — callers should surface that instead of silently dropping.
  function send(event, data) { return emitNow(event, data); }

  function disconnect() {
    manualClose = true;
    clearTimeout(retryTimer);
    try { if (sio) sio.disconnect(); } catch (e) {}
    try { if (ws) ws.close(); } catch (e) {}
    sio = null;
    ws = null;
    connected = false;
  }

  function isConnected() { return connected; }

  return {
    connect, disconnect, isConnected, on, send,
    joinQueue, leaveQueue, rollDice, sendMove, playTournamentMatch
  };
})();

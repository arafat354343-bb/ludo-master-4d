/* Ludo Master 3D — client configuration.
 * Served as a plain static site (no build step). Point these at the game server.
 * The Socket.IO client library is loaded from CDN in index.html; if it is
 * unavailable, js/socket.js falls back to a native WebSocket connection.
 * NOTE: when the page is served from anywhere other than localhost, the API
 * and socket automatically use the same origin (works on Render, tunnels,
 * and single-service deploys with no extra config). */
const CONFIG = (() => {
  const sameOrigin = window.location.protocol + '//' + window.location.host;
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  const base = isLocal ? 'http://localhost:3000' : sameOrigin;
  return {
    API_BASE: base,
    SOCKET_URL: base,
    APP_NAME: 'Ludo Master 3D',
    TURN_SECONDS: 15
  };
})();

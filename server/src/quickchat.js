/* Ludo Master 3D — in-game quick chat.
 * ---------------------------------------------------------------------------
 * Preset fun messages (Ludo King style). The server is the authority:
 * clients only send a message id; the server validates the id against an
 * allowlist, verifies the socket is actually a player in the room,
 * rate-limits, and broadcasts the canonical text. Client-supplied text is
 * NEVER trusted or relayed.
 *
 * Wire-up (one line in src/index.js, next to the GameManager):
 *   require('./quickchat').mountQuickChat(io, games);
 * socket.io supports multiple io.on('connection') handlers, so this is
 * conflict-free with the handlers in index.js / game.js.
 * ---------------------------------------------------------------------------
 */

const MESSAGES = {
  1: 'Good luck! 🍀',
  2: 'Nice move! 👏',
  3: 'Oops! 😅',
  4: 'Well played! 🎉',
  5: 'Your turn! ⏰',
  6: 'Haha! 😂',
};

const RATE_LIMIT_MS = 3000;
const lastSent = new Map(); // socketId -> timestamp of last accepted message

function mountQuickChat(io, games) {
  io.on('connection', (socket) => {
    socket.on('chat:quick', (payload) => {
      try {
        const msgId = Number(payload && payload.msgId);
        if (!MESSAGES[msgId]) return; // not on the allowlist — ignore

        const now = Date.now();
        if (now - (lastSent.get(socket.id) || 0) < RATE_LIMIT_MS) return; // rate-limited

        const room = games && typeof games.roomForSocket === 'function'
          ? games.roomForSocket(socket)
          : null;
        if (!room || room.over) return;

        const userId = socket.user && socket.user.id;
        if (!userId) return;
        const player = room.players.find(
          (p) => !p.isBot && String(p.userId) === String(userId)
        );
        if (!player) return; // socket is not a player in this room — ignore

        lastSent.set(socket.id, now);
        io.to(room.id).emit('chat:quick', {
          from: player.name,
          msgId,
          text: MESSAGES[msgId],
        });
      } catch (e) {
        // Chat must never crash the socket — swallow and move on.
      }
    });

    socket.on('disconnect', () => {
      lastSent.delete(socket.id);
    });
  });
}

module.exports = { mountQuickChat, MESSAGES, RATE_LIMIT_MS };

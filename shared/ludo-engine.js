/* LudoEngine — shared, server-authoritative Ludo (Ludo King) rules engine.
 * Pure JavaScript, zero dependencies. Runs in Node.js and browsers (UMD).
 * All state functions are pure: they never mutate inputs, they return fresh state.
 */
(function(root, factory){
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.LudoEngine = factory();
})(typeof self !== 'undefined' ? self : this, function(){
'use strict';

var COLORS = ['red', 'green', 'yellow', 'blue'];
var START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
var SAFE_SQUARES = [0, 8, 13, 21, 26, 34, 39, 47];
var YARD = -1;      // token position: in the yard
var FINISHED = 57;  // token position: finished (home)
var TRACK_LEN = 52;

/** Absolute board square (0..51) for a token at track position 0..50. null otherwise. */
function posToAbsolute(color, pos){
  if (pos === null || pos === undefined) return null;
  if (typeof pos !== 'number' || pos < 0 || pos > 50) return null;
  return (START_OFFSET[color] + pos) % TRACK_LEN;
}

function isSafeAbsolute(abs){
  return SAFE_SQUARES.indexOf(abs) !== -1;
}

function cloneState(state){
  return JSON.parse(JSON.stringify(state));
}

function createGame(colors){
  if (!Array.isArray(colors) || colors.length < 2 || colors.length > 4){
    throw new Error('createGame: colors must be an array of 2-4 color names');
  }
  var seen = {};
  colors.forEach(function(c){
    if (COLORS.indexOf(c) === -1) throw new Error('createGame: invalid color "' + c + '"');
    if (seen[c]) throw new Error('createGame: duplicate color "' + c + '"');
    seen[c] = true;
  });
  return {
    players: colors.map(function(c){ return { color: c, tokens: [YARD, YARD, YARD, YARD] }; }),
    turnIndex: 0,
    phase: 'awaitingRoll',   // 'awaitingRoll' | 'awaitingMove' | 'over'
    dice: null,              // null | 1..6
    consecutiveSixes: 0,
    winner: null,            // null | color
    moveCount: 0
  };
}

function rollDice(){
  return 1 + Math.floor(Math.random() * 6);
}

/* Compute the move descriptor for the current player's token, or null if illegal. */
function computeMove(state, tokenIndex){
  var me = state.turnIndex;
  var player = state.players[me];
  var dice = state.dice;
  if (!player || dice === null || dice === undefined) return null;
  if (tokenIndex < 0 || tokenIndex > 3) return null;
  var from = player.tokens[tokenIndex];
  if (from === FINISHED) return null;

  var to;
  if (from === YARD){
    if (dice !== 6) return null;   // a 6 is required to leave the yard
    to = 0;
  } else {
    to = from + dice;
    if (to > FINISHED) return null; // exact roll required to finish
  }

  var captures = [];
  if (to <= 50){
    var abs = posToAbsolute(player.color, to);
    if (!isSafeAbsolute(abs)){
      state.players.forEach(function(p, pi){
        if (pi === me) return;      // own tokens stack freely, never captured
        p.tokens.forEach(function(tpos, ti){
          if (tpos >= 0 && tpos <= 50 && posToAbsolute(p.color, tpos) === abs){
            captures.push({ player: pi, token: ti });
          }
        });
      });
    }
  }

  var finishesToken = (to === FINISHED);
  var winsGame = false;
  if (finishesToken){
    winsGame = true;
    for (var i = 0; i < 4; i++){
      var after = (i === tokenIndex) ? FINISHED : player.tokens[i];
      if (after !== FINISHED){ winsGame = false; break; }
    }
  }

  return {
    token: tokenIndex,
    from: from,
    to: to,
    captures: captures,
    finishesToken: finishesToken,
    grantsExtraTurn: (dice === 6) || captures.length > 0 || finishesToken,
    winsGame: winsGame
  };
}

function legalMoves(state){
  if (!state || state.phase !== 'awaitingMove' || state.dice === null || state.dice === undefined) return [];
  var moves = [];
  for (var i = 0; i < 4; i++){
    var m = computeMove(state, i);
    if (m) moves.push(m);
  }
  return moves;
}

function setRoll(state, value){
  if (!state || state.phase !== 'awaitingRoll'){
    throw new Error('setRoll: can only roll when phase is "awaitingRoll"');
  }
  if (typeof value !== 'number' || Math.floor(value) !== value || value < 1 || value > 6){
    throw new Error('setRoll: value must be an integer 1..6');
  }
  var s = cloneState(state);
  var events = [];
  var n = s.players.length;

  if (value === 6 && s.consecutiveSixes >= 2){
    // Three consecutive sixes: the third 6 is forfeited — no move, turn passes.
    events.push('threeSixesForfeit');
    s.dice = null;
    s.phase = 'awaitingRoll';
    s.consecutiveSixes = 0;
    s.turnIndex = (s.turnIndex + 1) % n;
    return { state: s, events: events };
  }

  s.dice = value;
  s.consecutiveSixes = (value === 6) ? s.consecutiveSixes + 1 : 0;
  s.phase = 'awaitingMove';

  if (legalMoves(s).length === 0){
    // No legal moves: turn passes automatically.
    events.push('noMove');
    s.dice = null;
    s.phase = 'awaitingRoll';
    s.consecutiveSixes = 0;
    s.turnIndex = (s.turnIndex + 1) % n;
  }
  return { state: s, events: events };
}

function applyMove(state, tokenIndex){
  if (!state || state.phase !== 'awaitingMove'){
    throw new Error('applyMove: can only move when phase is "awaitingMove"');
  }
  if (typeof tokenIndex !== 'number' || Math.floor(tokenIndex) !== tokenIndex || tokenIndex < 0 || tokenIndex > 3){
    throw new Error('applyMove: tokenIndex must be an integer 0..3');
  }
  var move = computeMove(state, tokenIndex);
  if (!move) throw new Error('applyMove: illegal move for token ' + tokenIndex);

  var s = cloneState(state);
  var events = [];
  var n = s.players.length;
  var player = s.players[s.turnIndex];

  player.tokens[tokenIndex] = move.to;
  if (move.from === YARD) events.push('leftYard');
  move.captures.forEach(function(c){
    s.players[c.player].tokens[c.token] = YARD;
  });
  if (move.captures.length > 0) events.push('capture');
  if (move.finishesToken) events.push('tokenHome');
  s.moveCount += 1;

  if (move.winsGame){
    events.push('win');
    s.phase = 'over';
    s.winner = player.color;
    s.dice = null;
    s.consecutiveSixes = 0;
  } else if (move.grantsExtraTurn){
    events.push('extraTurn');
    s.phase = 'awaitingRoll';
    if (s.dice !== 6) s.consecutiveSixes = 0; // capture/token-home breaks a six streak
    s.dice = null;
  } else {
    s.phase = 'awaitingRoll';
    s.dice = null;
    s.consecutiveSixes = 0;
    s.turnIndex = (s.turnIndex + 1) % n;
  }
  return { state: s, events: events };
}

function isOver(state){ return !!state && state.phase === 'over'; }
function getWinner(state){ return state ? state.winner : null; }

function serialize(state){ return JSON.stringify(state); }

function deserialize(json){
  var s = (typeof json === 'string') ? JSON.parse(json) : json;
  if (!s || typeof s !== 'object') throw new Error('deserialize: invalid game state');
  if (!Array.isArray(s.players) || s.players.length < 2 || s.players.length > 4){
    throw new Error('deserialize: invalid players');
  }
  s.players.forEach(function(p){
    if (!p || COLORS.indexOf(p.color) === -1) throw new Error('deserialize: invalid player color');
    if (!Array.isArray(p.tokens) || p.tokens.length !== 4) throw new Error('deserialize: invalid tokens');
    p.tokens.forEach(function(t){
      if (typeof t !== 'number' || Math.floor(t) !== t || t < YARD || t > FINISHED){
        throw new Error('deserialize: invalid token position');
      }
    });
  });
  if (typeof s.turnIndex !== 'number' || s.turnIndex < 0 || s.turnIndex >= s.players.length){
    throw new Error('deserialize: invalid turnIndex');
  }
  if (s.phase !== 'awaitingRoll' && s.phase !== 'awaitingMove' && s.phase !== 'over'){
    throw new Error('deserialize: invalid phase');
  }
  if (s.dice !== null && (typeof s.dice !== 'number' || Math.floor(s.dice) !== s.dice || s.dice < 1 || s.dice > 6)){
    throw new Error('deserialize: invalid dice');
  }
  if (typeof s.consecutiveSixes !== 'number' || s.consecutiveSixes < 0){
    throw new Error('deserialize: invalid consecutiveSixes');
  }
  if (s.winner !== null && COLORS.indexOf(s.winner) === -1){
    throw new Error('deserialize: invalid winner');
  }
  if (typeof s.moveCount !== 'number' || s.moveCount < 0){
    throw new Error('deserialize: invalid moveCount');
  }
  return cloneState(s);
}

/* Heuristic bot: returns the tokenIndex of the best legal move, or null. */
function chooseBotMove(state){
  var moves = legalMoves(state);
  if (moves.length === 0) return null;
  var me = state.turnIndex;
  var myColor = state.players[me].color;
  var best = null;
  var bestScore = -Infinity;
  moves.forEach(function(m){
    var score = 0;
    if (m.captures.length > 0) score += 100;  // capture an opponent
    if (m.from === YARD) score += 40;           // bring a token out of the yard
    if (m.finishesToken) score += 80;          // finish a token
    if (m.to >= 51) score += 30;               // enter the home column
    if (m.to <= 50){
      var abs = posToAbsolute(myColor, m.to);
      if (isSafeAbsolute(abs)){
        score += 15;                            // land on a safe square
      } else {
        // small penalty for each opponent token within 6 squares behind
        state.players.forEach(function(p, pi){
          if (pi === me) return;
          p.tokens.forEach(function(tpos){
            if (tpos >= 0 && tpos <= 50){
              var tabs = posToAbsolute(p.color, tpos);
              var behind = (abs - tabs + TRACK_LEN) % TRACK_LEN;
              if (behind >= 1 && behind <= 6) score -= 10;
            }
          });
        });
      }
    }
    score += Math.max(0, m.from) * 0.5;         // prefer the most-advanced token
    score += Math.random() * 0.01;              // tiny random tiebreak
    if (score > bestScore){ bestScore = score; best = m; }
  });
  return best.token;
}

return {
  COLORS: COLORS,
  START_OFFSET: START_OFFSET,
  SAFE_SQUARES: SAFE_SQUARES,
  posToAbsolute: posToAbsolute,
  isSafeAbsolute: isSafeAbsolute,
  createGame: createGame,
  rollDice: rollDice,
  setRoll: setRoll,
  legalMoves: legalMoves,
  applyMove: applyMove,
  isOver: isOver,
  getWinner: getWinner,
  serialize: serialize,
  deserialize: deserialize,
  chooseBotMove: chooseBotMove
};
});

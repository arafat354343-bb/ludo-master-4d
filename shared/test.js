/* Tests for ludo-engine.js — run with: node test.js */
const assert = require('node:assert');
const E = require('./ludo-engine.js');

let passed = 0;
function test(name, fn){
  fn();
  passed++;
  console.log('ok - ' + name);
}
function snap(o){ return JSON.parse(JSON.stringify(o)); }

/* Craft a full state object directly (bypasses roll flow) for targeted scenarios. */
function craft(players, opts){
  return Object.assign({
    players: players,
    turnIndex: 0,
    phase: 'awaitingMove',
    dice: 1,
    consecutiveSixes: 0,
    winner: null,
    moveCount: 0
  }, opts || {});
}
function P(color, tokens){ return { color: color, tokens: tokens }; }

test('constants and helpers', () => {
  assert.deepEqual(E.COLORS, ['red', 'green', 'yellow', 'blue']);
  assert.deepEqual(E.START_OFFSET, { red: 0, green: 13, yellow: 26, blue: 39 });
  assert.deepEqual(E.SAFE_SQUARES, [0, 8, 13, 21, 26, 34, 39, 47]);
  assert.equal(E.posToAbsolute('red', 0), 0);
  assert.equal(E.posToAbsolute('green', 0), 13);
  assert.equal(E.posToAbsolute('yellow', 0), 26);
  assert.equal(E.posToAbsolute('blue', 0), 39);
  assert.equal(E.posToAbsolute('blue', 50), 37); // (39+50)%52
  assert.equal(E.posToAbsolute('red', -1), null);
  assert.equal(E.posToAbsolute('red', 51), null);
  assert.equal(E.posToAbsolute('red', 57), null);
  assert.ok(E.isSafeAbsolute(0));
  assert.ok(E.isSafeAbsolute(47));
  assert.ok(!E.isSafeAbsolute(1));
});

test('createGame validates input and follows colors order', () => {
  const g = E.createGame(['blue', 'red']);
  assert.equal(g.players.length, 2);
  assert.equal(g.players[g.turnIndex].color, 'blue'); // turn order = colors order
  assert.deepEqual(g.players[0].tokens, [-1, -1, -1, -1]);
  assert.equal(g.phase, 'awaitingRoll');
  assert.equal(g.dice, null);
  assert.equal(g.consecutiveSixes, 0);
  assert.equal(g.winner, null);
  assert.equal(g.moveCount, 0);
  assert.throws(() => E.createGame(['red']), /2-4/);
  assert.throws(() => E.createGame(['red', 'red']), /duplicate/);
  assert.throws(() => E.createGame(['pink', 'red']), /invalid color/);
  assert.throws(() => E.createGame('red'), /2-4/);
});

test('rollDice returns integers 1..6', () => {
  for (let i = 0; i < 300; i++){
    const v = E.rollDice();
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 6, 'bad roll: ' + v);
  }
});

test('yard exit requires a 6; a no-move roll passes the turn (pure)', () => {
  const g = E.createGame(['red', 'green']);
  const before = snap(g);
  let r = E.setRoll(g, 3);
  assert.ok(r.events.includes('noMove'));
  assert.equal(r.state.turnIndex, 1);
  assert.equal(r.state.phase, 'awaitingRoll');
  assert.equal(r.state.dice, null);
  assert.equal(r.state.consecutiveSixes, 0);
  assert.deepEqual(r.state.players[0].tokens, [-1, -1, -1, -1]);
  assert.deepEqual(g, before); // input not mutated

  r = E.setRoll(g, 6);
  assert.deepEqual(r.events, []);
  const moves = E.legalMoves(r.state);
  assert.equal(moves.length, 4);
  assert.ok(moves.every(m => m.from === -1 && m.to === 0));

  const m2 = E.applyMove(r.state, 2);
  assert.ok(m2.events.includes('leftYard'));
  assert.ok(m2.events.includes('extraTurn'));
  assert.equal(m2.state.players[0].tokens[2], 0);
  assert.equal(m2.state.turnIndex, 0); // extra turn: same player
  assert.equal(m2.state.phase, 'awaitingRoll');
  assert.equal(m2.state.consecutiveSixes, 1);
  assert.equal(m2.state.moveCount, 1);
});

test('setRoll validates phase and value', () => {
  const g = E.createGame(['red', 'green']);
  assert.throws(() => E.setRoll(g, 0), /1\.\.6/);
  assert.throws(() => E.setRoll(g, 7), /1\.\.6/);
  assert.throws(() => E.setRoll(g, 2.5), /1\.\.6/);
  const r = E.setRoll(g, 6);
  assert.throws(() => E.setRoll(r.state, 3), /awaitingRoll/); // already rolled
  assert.throws(() => E.applyMove(g, 0), /awaitingMove/);     // not rolled yet
  assert.throws(() => E.applyMove(r.state, 9), /0\.\.3/);
});

test('capture on unsafe square sends opponent token(s) back to yard', () => {
  // red token1 at abs 0 -> rolls 1 -> lands abs 1 (unsafe), where green sits (pos 40 -> abs 1)
  const s = craft([P('red', [1, 0, -1, -1]), P('green', [40, -1, -1, -1])], { moveCount: 5 });
  const before = snap(s);
  const cap = E.legalMoves(s).find(m => m.token === 1);
  assert.ok(cap);
  assert.equal(cap.to, 1);
  assert.equal(cap.captures.length, 1);
  assert.deepEqual(cap.captures[0], { player: 1, token: 0 });
  assert.ok(cap.grantsExtraTurn);

  const r = E.applyMove(s, 1);
  assert.ok(r.events.includes('capture'));
  assert.ok(r.events.includes('extraTurn'));
  assert.equal(r.state.players[1].tokens[0], -1);
  assert.equal(r.state.players[0].tokens[1], 1);
  assert.equal(r.state.turnIndex, 0); // extra turn keeps the turn
  assert.deepEqual(s, before);       // input not mutated
});

test('no capture on safe square', () => {
  // red token0 at abs 7 -> rolls 1 -> lands abs 8 (safe), where green sits (pos 47 -> abs 8)
  assert.ok(E.isSafeAbsolute(E.posToAbsolute('red', 8)));
  const s = craft([P('red', [7, -1, -1, -1]), P('green', [47, -1, -1, -1])]);
  const m = E.legalMoves(s).find(x => x.token === 0);
  assert.ok(m);
  assert.equal(m.to, 8);
  assert.equal(m.captures.length, 0);
  const r = E.applyMove(s, 0);
  assert.ok(!r.events.includes('capture'));
  assert.equal(r.state.players[1].tokens[0], 47); // green untouched
  assert.equal(r.state.players[0].tokens[0], 8);
});

test('own tokens stack freely (no block rule)', () => {
  const s = craft([P('red', [4, 5, -1, -1]), P('green', [-1, -1, -1, -1])]);
  const m = E.legalMoves(s).find(x => x.token === 0);
  assert.ok(m);
  assert.equal(m.to, 5);
  assert.equal(m.captures.length, 0);
  const r = E.applyMove(s, 0);
  assert.deepEqual(r.state.players[0].tokens.slice(0, 2), [5, 5]);
});

test('extra turn on 6, on capture, and on token home', () => {
  // 1) rolling a 6
  let g = E.createGame(['red', 'green']);
  let r = E.setRoll(g, 6);
  r = E.applyMove(r.state, 0);
  assert.ok(r.events.includes('extraTurn'));
  assert.equal(r.state.turnIndex, 0);
  assert.equal(r.state.consecutiveSixes, 1);

  // 2) capturing
  const s = craft([P('red', [1, 0, -1, -1]), P('green', [40, -1, -1, -1])]);
  const rc = E.applyMove(s, 1);
  assert.ok(rc.events.includes('capture'));
  assert.ok(rc.events.includes('extraTurn'));
  assert.equal(rc.state.turnIndex, 0);

  // 3) bringing a token home (without winning)
  const s2 = craft([P('red', [57, 57, 10, 54]), P('green', [-1, -1, -1, -1])], { dice: 3 });
  const fin = E.legalMoves(s2).find(m => m.token === 3);
  assert.ok(fin.finishesToken);
  assert.ok(!fin.winsGame);
  assert.ok(fin.grantsExtraTurn);
  const rh = E.applyMove(s2, 3);
  assert.ok(rh.events.includes('tokenHome'));
  assert.ok(rh.events.includes('extraTurn'));
  assert.ok(!rh.events.includes('win'));
  assert.equal(rh.state.turnIndex, 0);
  assert.equal(rh.state.phase, 'awaitingRoll');

  // 4) a plain move passes the turn
  const s3 = craft([P('red', [10, -1, -1, -1]), P('green', [-1, -1, -1, -1])], { dice: 2 });
  const rp = E.applyMove(s3, 0);
  assert.ok(!rp.events.includes('extraTurn'));
  assert.equal(rp.state.turnIndex, 1);
});

test('three consecutive sixes forfeit the third', () => {
  let g = E.createGame(['red', 'green']);
  let r = E.setRoll(g, 6);
  r = E.applyMove(r.state, 0); // token0: -1 -> 0
  assert.equal(r.state.consecutiveSixes, 1);
  r = E.setRoll(r.state, 6);
  r = E.applyMove(r.state, 0); // token0: 0 -> 6
  assert.equal(r.state.consecutiveSixes, 2);
  assert.equal(r.state.players[0].tokens[0], 6);

  r = E.setRoll(r.state, 6); // third 6 -> forfeited
  assert.ok(r.events.includes('threeSixesForfeit'));
  assert.equal(r.state.turnIndex, 1); // turn passes to green
  assert.equal(r.state.phase, 'awaitingRoll');
  assert.equal(r.state.dice, null);
  assert.equal(r.state.consecutiveSixes, 0);
  assert.equal(r.state.players[0].tokens[0], 6); // no move happened
  assert.deepEqual(E.legalMoves(r.state), []);
});

test('exact roll required to finish; overshoot is blocked', () => {
  const s = craft([P('red', [54, -1, -1, -1]), P('green', [-1, -1, -1, -1])], { dice: 4 });
  assert.deepEqual(E.legalMoves(s).filter(m => m.token === 0), []);
  assert.throws(() => E.applyMove(s, 0), /illegal move/);

  const s2 = craft([P('red', [54, -1, -1, -1]), P('green', [-1, -1, -1, -1])], { dice: 3 });
  const fin = E.legalMoves(s2).find(m => m.token === 0);
  assert.ok(fin);
  assert.equal(fin.to, 57);
  assert.ok(fin.finishesToken);
  const r = E.applyMove(s2, 0);
  assert.equal(r.state.players[0].tokens[0], 57);
  assert.ok(r.events.includes('tokenHome'));

  // finished tokens can never move again
  const s3 = craft([P('red', [57, -1, -1, -1]), P('green', [-1, -1, -1, -1])], { dice: 6 });
  assert.deepEqual(E.legalMoves(s3).filter(m => m.token === 0), []);
});

test('win ends the game immediately', () => {
  const s = craft(
    [P('red', [57, 57, 57, 54]), P('green', [10, -1, -1, -1])],
    { dice: 3, moveCount: 12 }
  );
  assert.ok(!E.isOver(s));
  assert.equal(E.getWinner(s), null);
  const fin = E.legalMoves(s).find(m => m.token === 3);
  assert.ok(fin.winsGame);
  const r = E.applyMove(s, 3);
  assert.ok(r.events.includes('win'));
  assert.ok(r.events.includes('tokenHome'));
  assert.ok(E.isOver(r.state));
  assert.equal(E.getWinner(r.state), 'red');
  assert.equal(r.state.phase, 'over');
  assert.deepEqual(r.state.players[0].tokens, [57, 57, 57, 57]);
  assert.throws(() => E.setRoll(r.state, 4), /awaitingRoll/); // game over: no more rolls
});

test('bot returns a legal move, prefers capture, null when none', () => {
  // no legal moves -> null
  const s = craft([P('red', [-1, -1, -1, -1]), P('green', [-1, -1, -1, -1])], { dice: 3 });
  assert.equal(E.chooseBotMove(s), null);

  // capture available -> bot takes it (token 1 captures, +100 dominates)
  const s2 = craft([P('red', [1, 0, -1, -1]), P('green', [40, -1, -1, -1])]);
  assert.equal(E.chooseBotMove(s2), 1);

  // general case: the pick is always one of the legal moves
  const g = E.createGame(['red', 'green', 'yellow']);
  const st = E.setRoll(g, 6).state;
  const pick = E.chooseBotMove(st);
  assert.ok([0, 1, 2, 3].includes(pick));
  const legalTokens = E.legalMoves(st).map(m => m.token);
  assert.ok(legalTokens.includes(pick));
});

test('serialize/deserialize round-trip (deep, independent copy)', () => {
  let g = E.createGame(['blue', 'red', 'green']);
  let r = E.setRoll(g, 6);
  r = E.applyMove(r.state, 1);
  const json = E.serialize(r.state);
  assert.equal(typeof json, 'string');
  const back = E.deserialize(json);
  assert.deepEqual(back, r.state);
  back.players[0].tokens[1] = 50; // mutating the copy (50 is a valid position)...
  assert.notEqual(r.state.players[0].tokens[1], 50); // ...must not affect the original
  const again = E.deserialize(E.serialize(back));
  assert.equal(again.players[0].tokens[1], 50);
  assert.throws(() => E.deserialize('{"bogus":true}'), /invalid/);
  assert.throws(() => E.deserialize('not json'), /Unexpected token/);
});

test('bot-vs-bot full game terminates with a winner', () => {
  let state = E.createGame(['red', 'green']);
  let plies = 0;
  while (!E.isOver(state) && plies < 10000){
    plies++;
    const rolled = E.setRoll(state, E.rollDice());
    state = rolled.state;
    if (state.phase === 'awaitingMove'){
      const pick = E.chooseBotMove(state);
      assert.ok(pick !== null, 'bot must find a move when legalMoves is non-empty');
      state = E.applyMove(state, pick).state;
    }
  }
  assert.ok(E.isOver(state), 'game should terminate');
  const w = E.getWinner(state);
  assert.ok(['red', 'green'].includes(w));
  const winnerTokens = state.players.find(p => p.color === w).tokens;
  assert.deepEqual(winnerTokens, [57, 57, 57, 57]);
  console.log('    (full game finished in ' + plies + ' plies, winner: ' + w + ')');
});

console.log('\nALL ' + passed + ' TESTS PASSED');

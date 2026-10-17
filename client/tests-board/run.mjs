// Headless logic test for the REAL js/board3d.js (with stubbed THREE + DOM).
// Verifies: geometry math, setState diffing/queue, interaction gating,
// animateDice promise, showWinner, highlight visibility.

/* ---------- DOM / browser stubs ---------- */
function makeCtx2d() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get(t, p) {
      if (p === 'createRadialGradient') return () => grad;
      if (typeof p === 'string') return (...a) => ctx;
      return undefined;
    },
    set() { return true; },
  });
}
let ctx; // lazy (proxy references itself)
function makeCanvas() {
  ctx = makeCtx2d();
  return { width: 0, height: 0, style: {}, getContext: () => ctx };
}
globalThis.window = globalThis;
globalThis.devicePixelRatio = 1;
globalThis.WebGLRenderingContext = function () {};
globalThis.addEventListener = () => {};
// ResizeObserver intentionally undefined (module guards it)
let rafQ = [];
globalThis.requestAnimationFrame = cb => { rafQ.push(cb); return rafQ.length; };
globalThis.document = { createElement: tag => (tag === 'canvas' ? makeCanvas() : { style: {} }) };

const B = (await import('../js/board3d.js')).default;
if (!B || typeof B.init !== 'function') throw new Error('window.LudoBoard missing');

/* ---------- helpers ---------- */
const container = { clientWidth: 390, clientHeight: 600, style: {}, appendChild() {} };
function frames(n) {
  for (let i = 0; i < n; i++) {
    const q = rafQ; rafQ = [];
    for (const cb of q) cb();
  }
}
// find a token group's position via its hit-mesh child (userData.type==='token')
function tokenPos(color, idx) {
  for (const g of globalThis.__groups) {
    for (const c of g.children) {
      const ud = c.userData;
      if (ud && ud.type === 'token' && ud.color === color && ud.index === idx) {
        return { x: g.position.x, y: g.position.y, z: g.position.z };
      }
    }
  }
  return null;
}
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const clone = o => JSON.parse(JSON.stringify(o));
function freshState() {
  return {
    roomId: 'r', mode: '4P', entry: 100,
    players: [
      { id: 'p1', name: 'A', color: 'red', isBot: false, tokens: [-1, -1, -1, -1] },
      { id: 'p2', name: 'B', color: 'green', isBot: true, tokens: [-1, -1, -1, -1] },
      { id: 'p3', name: 'C', color: 'yellow', isBot: false, tokens: [-1, -1, -1, -1] },
      { id: 'p4', name: 'D', color: 'blue', isBot: true, tokens: [-1, -1, -1, -1] },
    ],
    turnColor: 'red', phase: 'awaitingRoll', dice: null, movableTokens: [], winner: null,
  };
}

/* ---------- 1. init + first setState placement ---------- */
console.log('1. init + mid-game placement');
const pInit = B.init(container);
frames(3);
await pInit;
let s = freshState();
s.players[0].tokens = [12, -1, 50, 53];
s.players[1].tokens = [-1, -1, 3, -1];
s.players[2].tokens = [20, 20, -1, 56];
s.players[3].tokens = [-1, 5, 5, -1];
B.setState(clone(s), 'red');
frames(5);

let t = tokenPos('red', 0);   // pos12 -> abs12 (0,8) -> world (1,-7)
check('red t0 at (1,-7)', t && near(t.x, 1) && near(t.z, -7), JSON.stringify(t));
t = tokenPos('red', 2);       // pos50 -> abs50 (7,0) -> world (-7,0)
check('red t2 at (-7,0)', t && near(t.x, -7) && near(t.z, 0), JSON.stringify(t));
t = tokenPos('red', 3);       // pos53 -> home (7,3) -> world (-4,0)
check('red t3 at home (-4,0)', t && near(t.x, -4) && near(t.z, 0), JSON.stringify(t));
t = tokenPos('red', 1);       // yard slot idx1 (2,3) -> world (-4,-5)
check('red t1 in yard (-4,-5)', t && near(t.x, -4) && near(t.z, -5), JSON.stringify(t));
t = tokenPos('green', 2);     // pos3 -> abs16 (4,8) -> world (1,-3)
check('green t2 at (1,-3)', t && near(t.x, 1) && near(t.z, -3), JSON.stringify(t));
const y0 = tokenPos('yellow', 0), y1 = tokenPos('yellow', 1); // stacked on abs46 (8,3)->(-4,1)
check('yellow stacked pair split', y0 && y1 && near(y0.z, 1) && near(y1.z, 1) &&
  near(Math.abs(y0.x - y1.x), 0.42, 0.02), JSON.stringify([y0, y1]));
t = tokenPos('yellow', 3);    // pos56 -> center + yellow offset (0.42,0)
check('yellow t3 at center (0.42,0)', t && near(t.x, 0.42) && near(t.z, 0), JSON.stringify(t));
const b1 = tokenPos('blue', 1), b2 = tokenPos('blue', 2);     // stacked pair
check('blue stacked pair split', b1 && b2 && near(Math.abs(b1.x - b2.x), 0.42, 0.02));

/* ---------- 2. move animation via setState ---------- */
console.log('2. token hop animation (red t0: 12 -> 18)');
const s2 = clone(s);
s2.players[0].tokens[0] = 18; // abs18 = TRACK[18] (6,9) -> world (2,-1)
s2.turnColor = 'green'; s2.phase = 'awaitingRoll'; s2.movableTokens = [];
B.setState(s2, 'red');
frames(45); // 0.72s: pedestal slide (0.55s) done, token hop (0.72s) in flight
t = tokenPos('red', 0);
const midFlight = t && (Math.abs(t.x - 1) > 0.05 || t.y > 0.01);
check('token mid-flight after 45 frames', midFlight, JSON.stringify(t));
frames(150); // drain queue (pedestal 0.55s + 6 hops*0.12s)
t = tokenPos('red', 0);
check('red t0 landed at (2,-1)', t && near(t.x, 2) && near(t.z, -1) && near(t.y, 0), JSON.stringify(t));

/* ---------- 3. capture animation ---------- */
console.log('3. capture (green t2 -> yard)');
const s3 = clone(s2);
// green t2 at pos3 (abs16); move red t1 out then capture: put red t1 at pos4 (abs4)? use red t0: 18->? 
// simpler: red t0 (pos18, abs30) captures blue t1 (pos5, abs44)? no.
// direct: set green t2 pos3, red t0 to abs16 => red pos16
s3.players[0].tokens[0] = 16; // abs16 — lands on green t2 (pos3->abs16)
s3.players[1].tokens[2] = -1; // captured
s3.turnColor = 'red';
B.setState(s3, 'red');
frames(150);
t = tokenPos('green', 2);
// yard slot green idx2 = (3,11) -> world (4,-4)
check('green t2 at yard (4,-4)', t && near(t.x, 4) && near(t.z, -4), JSON.stringify(t));
t = tokenPos('red', 0); // abs16 (4,8) -> world (1,-3)
check('red t0 at capture square (1,-3)', t && near(t.x, 1) && near(t.z, -3), JSON.stringify(t));

/* ---------- 4. interaction gating ---------- */
console.log('4. interaction gating');
const events = [];
B.onUserRoll = () => events.push('roll');
B.onTokenPick = i => events.push('pick' + i);
const down = globalThis.__domListeners.pointerdown;
const s4 = clone(s3);
s4.phase = 'awaitingMove'; s4.turnColor = 'red'; s4.movableTokens = [1, 3];
B.setState(s4, 'red'); frames(5);

globalThis.__rayMode = 'dice';
down({ clientX: 195, clientY: 300 });
check('dice tap ignored in awaitingMove', events.length === 0, JSON.stringify(events));

globalThis.__rayMode = 'token';
globalThis.__rayToken = { type: 'token', color: 'red', index: 3 };
down({ clientX: 195, clientY: 300 });
check('onTokenPick(3) fired', events.join() === 'pick3', JSON.stringify(events));

events.length = 0;
globalThis.__rayToken = { type: 'token', color: 'red', index: 2 }; // not movable
down({ clientX: 195, clientY: 300 });
check('non-movable token ignored', events.length === 0, JSON.stringify(events));

const s5 = clone(s4);
s5.phase = 'awaitingRoll'; s5.movableTokens = [];
B.setState(s5, 'red'); frames(5);
globalThis.__rayMode = 'dice';
down({ clientX: 195, clientY: 300 });
check('onUserRoll fired on my roll turn', events.join() === 'roll', JSON.stringify(events));

events.length = 0;
const s6 = clone(s5);
s6.turnColor = 'green'; // not my turn
B.setState(s6, 'red'); frames(5);
down({ clientX: 195, clientY: 300 });
check('dice tap ignored when not my turn', events.length === 0, JSON.stringify(events));
globalThis.__rayMode = null;

/* ---------- 5. highlight rings ---------- */
console.log('5. highlight rings');
// find scene-level additive meshes (highlight rings)
function visibleHlRings() {
  const out = [];
  const walk = o => { for (const c of o.children) { walk(c); } };
  for (const g of globalThis.__groups) {
    // scene is a Group too; rings are direct children of scene with additive material
  }
  // rings: meshes with material.blending===2 parented to a Group that is not a token group
  for (const m of globalThis.__meshes) {
    if (m.material && m.material.blending === 2 && m.visible && m.parent &&
        !(m.parent.children.some(c => c.userData && c.userData.type === 'token'))) {
      // exclude tapRing (child of pedestal group, which also holds dice)
      const sib = m.parent.children.some(c => c.userData && c.userData.type === 'dice');
      if (!sib) out.push(m);
    }
  }
  return out;
}
const s7 = clone(s6);
s7.phase = 'awaitingMove'; s7.turnColor = 'red'; s7.movableTokens = [0, 2];
B.setState(s7, 'red'); frames(5);
const rings = visibleHlRings();
check('2 highlight rings visible', rings.length === 2, `found ${rings.length}`);
const rp0 = tokenPos('red', 0);
const ringNearT0 = rings.some(r => near(r.position.x, rp0.x, 0.3) && near(r.position.z, rp0.z, 0.3));
check('ring follows red token 0', ringNearT0);

/* ---------- 6. animateDice resolves, dice settles ---------- */
console.log('6. animateDice');
let resolved = false;
const dp = B.animateDice(5).then(() => { resolved = true; });
frames(30);
check('not resolved mid-tumble', !resolved);
frames(120);
await dp;
check('resolved after settle', resolved);

/* ---------- 7. rapid setState queueing ---------- */
console.log('7. rapid setState queue (no overlap)');
const q0 = clone(s7);
q0.players[0].tokens = [16, -1, 50, 53];
const q1 = clone(q0); q1.players[0].tokens[1] = 0;   // second token leaves yard
const q2 = clone(q1); q2.players[0].tokens[0] = 22;  // first token advances
B.setState(q0, 'red'); B.setState(q1, 'red'); B.setState(q2, 'red');
frames(400);
t = tokenPos('red', 0); // pos22 -> abs22 (6,13) -> world (6,-1)
check('final pos red t0 (6,-1)', t && near(t.x, 6) && near(t.z, -1), JSON.stringify(t));
t = tokenPos('red', 1); // pos0 -> abs0 (6,1) -> world (-6,-1)
check('final pos red t1 (-6,-1)', t && near(t.x, -6) && near(t.z, -1), JSON.stringify(t));

/* ---------- 8. showWinner ---------- */
console.log('8. showWinner');
const meshesBefore = globalThis.__meshes.length;
B.showWinner('red');
frames(5);
check('confetti points added', globalThis.__meshes.length > meshesBefore);
frames(300); // confetti life 3s
check('confetti cleaned up', true); // no crash = pass

/* ---------- 9. finished tray (pos 57) ---------- */
console.log('9. finished tray');
const s9 = clone(q2);
s9.players[0].tokens[3] = 57;
B.setState(s9, 'red'); frames(120);
t = tokenPos('red', 3);
// tray slot red idx3 = (-5.5,-8.3), y=-0.82
check('red t3 in tray (-5.5,-8.3)', t && near(t.x, -5.5) && near(t.z, -8.3) && near(t.y, -0.82, 0.05), JSON.stringify(t));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

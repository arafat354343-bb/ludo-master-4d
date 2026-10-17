/*
 * LudoBoard — 3D Ludo board module (Three.js 0.160.0, no build step).
 *
 * Loaded via <script type="module"> (importmap provides `three`).
 * Exposes:
 *   window.LudoBoard = {
 *     init(containerEl): Promise<void>,
 *     setState(pubState, myColor): void,
 *     animateDice(value): Promise<void>,
 *     onUserRoll: null | (() => void),
 *     onTokenPick: null | ((tokenIndex: number) => void),
 *     showWinner(color): void,
 *   }
 *
 * Server public state shape:
 *   { roomId, mode, entry,
 *     players: [{ id, name, color, isBot, tokens: [p0,p1,p2,p3] }],
 *     turnColor, phase: 'awaitingRoll'|'awaitingMove'|'over',
 *     dice, movableTokens: [idx...], winner }
 *
 * Token positions: -1 = yard, 0..50 = main track, 51..55 = home column,
 *                  56 = center home, 57 = finished tray.
 *
 * BOARD GEOMETRY — unit = 1 cell, 15x15 grid centered at origin.
 *   world: x = col - 7, z = row - 7   (row 0 is far/top, z = -7)
 */
import * as THREE from 'three';

/* ============================== constants ============================== */

// Main track: 52 absolute squares, EXACT (row, col) per spec.
const TRACK = [
  [6,1],[6,2],[6,3],[6,4],[6,5],
  [5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],
  [6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],
  [9,8],[10,8],[11,8],[12,8],[13,8],[14,8],[14,7],[14,6],
  [13,6],[12,6],[11,6],[10,6],[9,6],
  [8,5],[8,4],[8,3],[8,2],[8,1],[8,0],[7,0],[6,0],
];
console.assert(TRACK.length === 52, 'TRACK must have 52 squares');
console.assert(TRACK[13][0] === 1 && TRACK[13][1] === 8, 'abs 13 = (1,8) green start');
console.assert(TRACK[26][0] === 8 && TRACK[26][1] === 13, 'abs 26 = (8,13) yellow start');
console.assert(TRACK[39][0] === 13 && TRACK[39][1] === 6, 'abs 39 = (13,6) blue start');

const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
const START_ABS    = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

// Home columns, pos 51..55 -> 5 cells each (row, col).
const HOME_COLS = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7]],
};

// Yards, pos -1 -> 4 slots each (row, col).
const YARDS = {
  red:    [[2,2],[2,3],[3,2],[3,3]],
  green:  [[2,11],[2,12],[3,11],[3,12]],
  yellow: [[11,11],[11,12],[12,11],[12,12]],
  blue:   [[11,2],[11,3],[12,2],[12,3]],
};

// pos 56 -> center (7,7) plus per-color offset so 4 tokens don't overlap.
const CENTER_OFF = { red: [-0.42, 0], green: [0, -0.42], yellow: [0.42, 0], blue: [0, 0.42] };

// pos 57 -> finished tray slots near the color's corner, outside the 15x15 grid.
const TRAY = {
  red:    [[-7.6,-8.3],[-6.9,-8.3],[-6.2,-8.3],[-5.5,-8.3]],
  green:  [[7.6,-8.3],[6.9,-8.3],[6.2,-8.3],[5.5,-8.3]],
  yellow: [[7.6,8.3],[6.9,8.3],[6.2,8.3],[5.5,8.3]],
  blue:   [[-7.6,8.3],[-6.9,8.3],[-6.2,8.3],[-5.5,8.3]],
};
const TRAY_Y = -0.82;

// Dice pedestal anchors (x, z) per side — just outside the board corners.
const PEDESTAL_POS = { red: [-9.0, -9.0], green: [9.0, -9.0], yellow: [9.0, 9.0], blue: [-9.0, 9.0] };

const COLORS = { red: 0xe53935, green: 0x43a047, yellow: 0xf2b90d, blue: 0x1e88e5 };
const COLOR_CSS = { red: '#e53935', green: '#43a047', yellow: '#f2b90d', blue: '#1e88e5' };
const PLAY_ORDER = ['red', 'green', 'yellow', 'blue'];

const cellXZ = (row, col) => ({ x: col - 7, z: row - 7 });

/* ============================ module state ============================= */

let container = null;
let renderer = null, scene = null, camera = null, clock = null;
let ready = false, inited = false;
let state = null;            // latest pubState passed to setState
let myColor = null;
let committedState = null;   // state the animation queue has fully applied
let lastQueuedState = null;  // target of the last queued job (diff baseline)

let tokenGroup = null;
const tokenMeshes = new Map();   // "color:idx" -> THREE.Group
const tokenHitMeshes = [];
const highlightRings = new Map(); // "color:idx" -> THREE.Mesh (scene-level)

let pedestal = null, diceMesh = null, tapRing = null, tapLabel = null;
const DICE_LOCAL_Y = 0.825;

let banner = null, bannerState = null; // {t, phase}
const confettis = [];

// shared geometries / materials
let GEO = null, MAT = null;

// animation queue: jobs {start?, update(dt)->done, finish?}
const queue = [];
let current = null;
function enqueue(job) { queue.push(job); }
function pump() {
  if (!current && queue.length) {
    current = queue.shift();
    try { if (current.start) current.start(); }
    catch (e) { console.error('[LudoBoard] job start failed', e); current = null; }
  }
}

/* ======================= token position mapping ======================== */

// Raw (unstacked) world position for a token, including y.
function tokenCellCenter(color, pos, idx) {
  if (pos === -1) {
    const [r, c] = YARDS[color][idx];
    return { ...cellXZ(r, c), y: 0 };
  }
  if (pos <= 50) {
    const abs = (START_OFFSET[color] + pos) % 52;
    const [r, c] = TRACK[abs];
    return { ...cellXZ(r, c), y: 0 };
  }
  if (pos <= 55) {
    const [r, c] = HOME_COLS[color][pos - 51];
    return { ...cellXZ(r, c), y: 0 };
  }
  if (pos === 56) {
    const [ox, oz] = CENTER_OFF[color];
    return { x: ox, z: oz, y: 0 };
  }
  // pos 57 — finished tray
  const [tx, tz] = TRAY[color][idx];
  return { x: tx, z: tz, y: TRAY_Y };
}

function cellKeyFor(color, pos, idx) {
  if (pos === -1) return `y${color}${idx}`;
  if (pos <= 50) return `t${(START_OFFSET[color] + pos) % 52}`;
  if (pos <= 55) return `h${color}${pos}`;
  if (pos === 56) return `c${color}`;
  return `f${color}${idx}`;
}

// Rest positions for every token in a state, with 2x2 mini-offsets when stacked.
function computeRest(pub) {
  const items = [];
  for (const p of pub.players) {
    for (let i = 0; i < 4; i++) {
      const pos = p.tokens[i];
      const c = tokenCellCenter(p.color, pos, i);
      items.push({ color: p.color, idx: i, ...c, key: cellKeyFor(p.color, pos, i), stackable: pos >= 0 && pos <= 56 });
    }
  }
  const out = new Map();
  for (const it of items) out.set(`${it.color}:${it.idx}`, { x: it.x, y: it.y, z: it.z });
  const groups = new Map();
  for (const it of items) {
    if (!it.stackable) continue;
    if (!groups.has(it.key)) groups.set(it.key, []);
    groups.get(it.key).push(it);
  }
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    const n = g.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const sp = 0.42;
    g.forEach((it, k) => {
      const ox = (k % cols - (cols - 1) / 2) * sp;
      const oz = (Math.floor(k / cols) - (rows - 1) / 2) * sp;
      out.set(`${it.color}:${it.idx}`, { x: it.x + ox, y: it.y, z: it.z + oz });
    });
  }
  return out;
}

/* ============================ board texture ============================ */

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function star(g, cx, cy, r, color) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

function makeBoardTexture() {
  const PX = 1600, S = PX / 15;
  const cv = document.createElement('canvas');
  cv.width = cv.height = PX;
  const g = cv.getContext('2d');
  const X = col => col * S, Y = row => row * S;

  // cream base
  g.fillStyle = '#f4ead3';
  g.fillRect(0, 0, PX, PX);

  // corner bases (6x6): red TL, green TR, yellow BR, blue BL
  const bases = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };
  for (const color of PLAY_ORDER) {
    const [br, bc] = bases[color];
    g.fillStyle = COLOR_CSS[color];
    roundRectPath(g, X(bc) + 3, Y(br) + 3, 6 * S - 6, 6 * S - 6, S * 0.4);
    g.fill();
    // inner white panel
    g.fillStyle = 'rgba(255,255,255,0.94)';
    roundRectPath(g, X(bc) + 0.75 * S, Y(br) + 0.75 * S, 4.5 * S, 4.5 * S, S * 0.5);
    g.fill();
    // white yard circle
    g.beginPath();
    g.arc(X(bc + 3), Y(br + 3), 2.0 * S, 0, Math.PI * 2);
    g.fillStyle = '#ffffff';
    g.fill();
    g.lineWidth = S * 0.07;
    g.strokeStyle = COLOR_CSS[color];
    g.stroke();
    // 4 yard slots
    for (const [r, c] of YARDS[color]) {
      g.beginPath();
      g.arc(X(c + 0.5), Y(r + 0.5), 0.40 * S, 0, Math.PI * 2);
      g.fillStyle = COLOR_CSS[color];
      g.fill();
      g.lineWidth = S * 0.05;
      g.strokeStyle = '#ffffff';
      g.stroke();
    }
  }

  // main track cells
  TRACK.forEach(([r, c], abs) => {
    const x = X(c), y = Y(r);
    let startColor = null;
    for (const col of PLAY_ORDER) if (START_ABS[col] === abs) startColor = col;
    g.fillStyle = startColor ? COLOR_CSS[startColor] : '#fffdf6';
    g.fillRect(x + 1.5, y + 1.5, S - 3, S - 3);
    g.strokeStyle = 'rgba(120,90,60,0.35)';
    g.lineWidth = 2;
    g.strokeRect(x + 1.5, y + 1.5, S - 3, S - 3);
    if (startColor) star(g, x + S / 2, y + S / 2, S * 0.30, '#ffffff');
    else if (SAFE.has(abs)) star(g, x + S / 2, y + S / 2, S * 0.26, '#d4a017');
  });

  // home columns
  for (const color of PLAY_ORDER) {
    HOME_COLS[color].forEach(([r, c]) => {
      const x = X(c), y = Y(r);
      g.fillStyle = COLOR_CSS[color];
      g.fillRect(x + 1.5, y + 1.5, S - 3, S - 3);
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 3;
      g.strokeRect(x + 7, y + 7, S - 14, S - 14);
    });
  }

  // center 3x3: four home triangles (red left, green top, yellow right, blue bottom)
  const cx0 = X(6), cy0 = Y(6), cw = 3 * S, midx = X(7.5), midy = Y(7.5);
  g.fillStyle = '#fffdf6';
  g.fillRect(cx0, cy0, cw, cw);
  const tri = (pts, color) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    g.lineTo(pts[1][0], pts[1][1]);
    g.lineTo(pts[2][0], pts[2][1]);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = '#ffffff';
    g.stroke();
  };
  tri([[cx0, cy0], [cx0, cy0 + cw], [midx, midy]], COLOR_CSS.red);
  tri([[cx0, cy0], [cx0 + cw, cy0], [midx, midy]], COLOR_CSS.green);
  tri([[cx0 + cw, cy0], [cx0 + cw, cy0 + cw], [midx, midy]], COLOR_CSS.yellow);
  tri([[cx0, cy0 + cw], [cx0 + cw, cy0 + cw], [midx, midy]], COLOR_CSS.blue);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* ============================ dice textures ============================ */

function makePipTexture(value) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#fdfdfb';
  g.fillRect(0, 0, S, S);
  const T = 0.28 * S, C = 0.5 * S, B = 0.72 * S, R = 0.095 * S;
  let pts;
  switch (value) {
    case 1: pts = [[C, C]]; break;
    case 2: pts = [[B, T], [T, B]]; break;
    case 3: pts = [[B, T], [C, C], [T, B]]; break;
    case 4: pts = [[T, T], [B, T], [T, B], [B, B]]; break;
    case 5: pts = [[T, T], [B, T], [C, C], [T, B], [B, B]]; break;
    default: pts = [[T, T], [B, T], [T, C], [B, C], [T, B], [B, B]];
  }
  for (const [px, py] of pts) {
    const grad = g.createRadialGradient(px - R * 0.3, py - R * 0.3, R * 0.2, px, py, R);
    grad.addColorStop(0, '#3a3a3a');
    grad.addColorStop(1, '#101010');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(px, py, R, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// BoxGeometry material order: [+x, -x, +y, -y, +z, -z]
const DIE_FACE_VALUES = [3, 4, 1, 6, 2, 5];
const FACE_NORMAL = {
  1: new THREE.Vector3(0, 1, 0), 6: new THREE.Vector3(0, -1, 0),
  3: new THREE.Vector3(1, 0, 0), 4: new THREE.Vector3(-1, 0, 0),
  2: new THREE.Vector3(0, 0, 1), 5: new THREE.Vector3(0, 0, -1),
};

/* ============================ scene building =========================== */

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

function showFallback(el) {
  el.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:320px;' +
    'background:#2a1a12;color:#ffe9c4;font-family:sans-serif;text-align:center;padding:24px;border-radius:12px;">' +
    '<div><div style="font-size:40px;margin-bottom:12px">🎲</div>' +
    '<div style="font-size:18px;font-weight:bold;margin-bottom:8px">3D board needs WebGL</div>' +
    '<div style="font-size:14px;opacity:0.8">Your browser or device could not provide a WebGL context, ' +
    'so the 3D Ludo board cannot be displayed. Please try a browser with WebGL enabled.</div></div></div>';
}

function buildSharedAssets() {
  GEO = {
    tokenBase: new THREE.CylinderGeometry(0.30, 0.34, 0.14, 28),
    tokenBody: new THREE.CylinderGeometry(0.15, 0.27, 0.44, 28),
    tokenHead: new THREE.SphereGeometry(0.20, 28, 20),
    tokenRing: new THREE.RingGeometry(0.36, 0.44, 36),
    tokenHit: new THREE.CylinderGeometry(0.50, 0.50, 1.15, 10),
    hlRing: new THREE.RingGeometry(0.42, 0.56, 40),
    pedestal: new THREE.CylinderGeometry(1.15, 1.32, 0.35, 40),
    pedestalTrim: new THREE.TorusGeometry(1.15, 0.055, 12, 48),
    tapRing: new THREE.RingGeometry(1.38, 1.62, 48),
    die: new THREE.BoxGeometry(0.95, 0.95, 0.95),
  };
  MAT = {
    token: {},
    tokenRingWhite: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.05 }),
    hit: new THREE.MeshBasicMaterial(),
    hl: new THREE.MeshBasicMaterial({
      color: 0xffdf7e, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.7 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.35, metalness: 0.6 }),
    tapRing: new THREE.MeshBasicMaterial({
      color: 0xffc93c, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  };
  for (const color of PLAY_ORDER) {
    MAT.token[color] = new THREE.MeshStandardMaterial({
      color: COLORS[color], roughness: 0.28, metalness: 0.12,
    });
  }
}

function buildBoard() {
  // ground
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(34, 48),
    new THREE.MeshStandardMaterial({ color: 0x2e2320, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.0;
  ground.receiveShadow = true;
  scene.add(ground);

  // wooden trim under slab
  const trim = new THREE.Mesh(new THREE.BoxGeometry(16.6, 0.3, 16.6), MAT.wood);
  trim.position.y = -0.85;
  trim.castShadow = true;
  trim.receiveShadow = true;
  scene.add(trim);

  // cream slab
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(15.9, 0.7, 15.9),
    new THREE.MeshStandardMaterial({ color: 0xe9dcc0, roughness: 0.6 })
  );
  slab.position.y = -0.35;
  slab.castShadow = true;
  slab.receiveShadow = true;
  scene.add(slab);

  // board top with painted texture
  const top = new THREE.Mesh(
    new THREE.PlaneGeometry(15, 15),
    new THREE.MeshStandardMaterial({ map: makeBoardTexture(), roughness: 0.55, metalness: 0.02 })
  );
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.01;
  top.receiveShadow = true;
  scene.add(top);

  // finished trays (one per color, outside the grid)
  for (const color of PLAY_ORDER) {
    const slots = TRAY[color];
    const midX = (slots[0][0] + slots[3][0]) / 2, midZ = slots[0][1];
    const tray = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.18, 1.05), MAT.wood);
    tray.position.set(midX, -0.91, midZ);
    tray.castShadow = true;
    tray.receiveShadow = true;
    scene.add(tray);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.06, 1.05), MAT.gold);
    lip.position.set(midX, -0.80, midZ);
    scene.add(lip);
  }
}

function makeToken(color, idx) {
  const grp = new THREE.Group();
  const mat = MAT.token[color];
  const base = new THREE.Mesh(GEO.tokenBase, mat);
  base.position.y = 0.07;
  const body = new THREE.Mesh(GEO.tokenBody, mat);
  body.position.y = 0.36;
  const head = new THREE.Mesh(GEO.tokenHead, mat);
  head.position.y = 0.68;
  base.castShadow = body.castShadow = head.castShadow = true;
  const ring = new THREE.Mesh(GEO.tokenRing, MAT.tokenRingWhite);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  const hit = new THREE.Mesh(GEO.tokenHit, MAT.hit);
  hit.position.y = 0.55;
  hit.visible = false; // invisible but still raycastable
  hit.userData = { type: 'token', color, index: idx };
  grp.add(base, body, head, ring, hit);
  grp.userData = { color, index: idx };
  return grp;
}

function rebuildTokens(pub, rest) {
  // clear old
  while (tokenGroup.children.length) tokenGroup.remove(tokenGroup.children[0]);
  tokenMeshes.clear();
  tokenHitMeshes.length = 0;
  for (const m of highlightRings.values()) { scene.remove(m); }
  highlightRings.clear();

  for (const p of pub.players) {
    for (let i = 0; i < 4; i++) {
      const grp = makeToken(p.color, i);
      const key = `${p.color}:${i}`;
      tokenMeshes.set(key, grp);
      tokenGroup.add(grp);
      tokenHitMeshes.push(grp.children[4]); // the invisible hit proxy
      const hl = new THREE.Mesh(GEO.hlRing, MAT.hl);
      hl.rotation.x = -Math.PI / 2;
      hl.visible = false;
      scene.add(hl);
      highlightRings.set(key, hl);
    }
  }
  // Place tokens: `rest` (usually the previous state's rest positions, so a
  // follow-up move job can animate from there); fall back to the new state's
  // rest for tokens that have no previous position (e.g. newly joined players).
  const base = rest || computeRest(pub);
  const fallback = rest ? computeRest(pub) : null;
  for (const [key, m] of tokenMeshes) {
    const p = base.get(key) || (fallback && fallback.get(key));
    if (p) m.position.set(p.x, p.y, p.z);
  }
}

function makeTapLabel() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(30,16,8,0.88)';
  roundRectPath(g, 8, 14, 496, 100, 50);
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = '#ffc93c';
  g.stroke();
  g.fillStyle = '#ffd968';
  g.font = 'bold 56px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('TAP TO ROLL', 256, 66);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(3.6, 0.9, 1);
  return sp;
}

function buildDiceRig() {
  pedestal = new THREE.Group();
  const base = new THREE.Mesh(GEO.pedestal, MAT.wood);
  base.position.y = 0.175;
  base.castShadow = true;
  base.receiveShadow = true;
  const trim = new THREE.Mesh(GEO.pedestalTrim, MAT.gold);
  trim.rotation.x = Math.PI / 2;
  trim.position.y = 0.35;
  pedestal.add(base, trim);

  const dieMats = DIE_FACE_VALUES.map(v =>
    new THREE.MeshStandardMaterial({ map: makePipTexture(v), roughness: 0.22, metalness: 0.05 })
  );
  diceMesh = new THREE.Mesh(GEO.die, dieMats);
  diceMesh.position.y = DICE_LOCAL_Y;
  diceMesh.castShadow = true;
  diceMesh.userData = { type: 'dice' };
  pedestal.add(diceMesh);

  tapRing = new THREE.Mesh(GEO.tapRing, MAT.tapRing);
  tapRing.rotation.x = -Math.PI / 2;
  tapRing.position.y = 0.37;
  tapRing.visible = false;
  pedestal.add(tapRing);

  tapLabel = makeTapLabel();
  tapLabel.position.y = 2.45;
  tapLabel.visible = false;
  pedestal.add(tapLabel);

  pedestal.position.set(PEDESTAL_POS.red[0], -1.0, PEDESTAL_POS.red[1]);
  scene.add(pedestal);
}

/* ============================== camera ================================= */

function fitCamera() {
  if (!renderer || !camera || !container) return;
  const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // keep the (0,16,11) view direction; choose the nearest distance that fits
  // the board + dice pedestals for the current aspect (portrait phones included)
  const dir = new THREE.Vector3(0, 16, 11).normalize();
  const pts = [
    [-7.5, -7.5], [7.5, -7.5], [-7.5, 7.5], [7.5, 7.5],
    [-10.2, -10.2], [10.2, -10.2], [-10.2, 10.2], [10.2, 10.2],
  ].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const v = new THREE.Vector3();
  for (let d = 17; d <= 46; d += 0.5) {
    camera.position.copy(dir).multiplyScalar(d);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    let ok = true;
    for (const p of pts) {
      v.copy(p).project(camera);
      if (Math.abs(v.x) > 0.93 || Math.abs(v.y) > 0.93) { ok = false; break; }
    }
    if (ok) break;
  }
}

/* ============================ tween helpers ============================ */

const lerp = (a, b, k) => a + (b - a) * k;
const easeInOut = k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

// Hop a token along waypoints [{x,y,z}...]; `perLeg` seconds per cell, `arc` hop height.
function hopTween(token, points, perLeg, arc) {
  const pts = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i], q = pts[pts.length - 1];
    if (Math.abs(p.x - q.x) > 1e-3 || Math.abs(p.z - q.z) > 1e-3 || Math.abs(p.y - q.y) > 1e-3) pts.push(p);
  }
  const legs = pts.length - 1;
  return {
    t: 0, total: Math.max(legs * perLeg, 0.001),
    start() { this.t = 0; },
    update(dt) {
      this.t += dt;
      if (this.t >= this.total || legs < 1) {
        const f = pts[pts.length - 1];
        token.position.set(f.x, f.y, f.z);
        return true;
      }
      const leg = Math.min(Math.floor(this.t / perLeg), legs - 1);
      const lt = (this.t - leg * perLeg) / perLeg;
      const a = pts[leg], b = pts[leg + 1];
      token.position.set(
        lerp(a.x, b.x, lt),
        lerp(a.y, b.y, lt) + arc * 4 * lt * (1 - lt),
        lerp(a.z, b.z, lt)
      );
      return false;
    },
  };
}

function slideTween(getter, setter, from, to, dur) {
  return {
    t: 0,
    start() { this.t = 0; },
    update(dt) {
      this.t += dt;
      const k = easeInOut(Math.min(this.t / dur, 1));
      setter({ x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k), z: lerp(from.z, to.z, k) });
      void getter;
      return this.t >= dur;
    },
  };
}

// Waypoints (raw cell centers) for a token moving from pPos to nPos.
function moveWaypoints(color, idx, pPos, nPos, from, to) {
  const pts = [from];
  if (nPos === -1) { pts.push(to); return pts; } // captured -> yard
  if (pPos === -1) {
    for (let s = 0; s <= Math.min(nPos, 50); s++) pts.push(tokenCellCenter(color, s, idx));
  } else if (nPos > pPos) {
    for (let s = pPos + 1; s <= Math.min(nPos, 55); s++) {
      pts.push(tokenCellCenter(color, s, idx));
    }
    if (nPos === 56 || nPos === 57) pts.push(tokenCellCenter(color, nPos, idx));
  }
  pts.push(to); // final stacked rest position
  return pts;
}

function buildMoveJob(prevRest, nextRest, prevState, nextState) {
  const tweens = [];
  for (const p of nextState.players) {
    const prevP = prevState.players.find(q => q.color === p.color);
    for (let i = 0; i < 4; i++) {
      const key = `${p.color}:${i}`;
      const from = prevRest.get(key), to = nextRest.get(key);
      const token = tokenMeshes.get(key);
      if (!from || !to || !token) continue;
      if (Math.abs(from.x - to.x) < 1e-4 && Math.abs(from.z - to.z) < 1e-4 && Math.abs(from.y - to.y) < 1e-4) continue;
      const pPos = prevP ? prevP.tokens[i] : -1;
      const nPos = p.tokens[i];
      const logicalMoved = pPos !== nPos;
      if (logicalMoved && nPos !== -1) {
        const pts = moveWaypoints(p.color, i, pPos, nPos, from, to);
        tweens.push(hopTween(token, pts, 0.12, 0.55));
      } else if (logicalMoved && nPos === -1) {
        tweens.push(hopTween(token, [from, to], 0.38, 1.0)); // captured: high hop home
      } else {
        // same square, rest offset shifted (stacking) — quick slide
        tweens.push(slideTween(null, v => token.position.set(v.x, v.y, v.z), from, to, 0.18));
      }
    }
  }
  if (!tweens.length) return null;
  return {
    start() { for (const tw of tweens) tw.start(); },
    update(dt) {
      let all = true;
      for (const tw of tweens) { try { if (!tw.update(dt)) all = false; } catch (e) { console.error(e); } }
      return all;
    },
  };
}

function pedestalJob(color) {
  const [tx, tz] = PEDESTAL_POS[color] || PEDESTAL_POS.red;
  const from = { x: pedestal.position.x, z: pedestal.position.z };
  const to = { x: tx, z: tz };
  if (Math.abs(from.x - to.x) < 1e-3 && Math.abs(from.z - to.z) < 1e-3) return null;
  return {
    t: 0, dur: 0.55,
    start() { this.t = 0; },
    update(dt) {
      this.t += dt;
      const k = easeInOut(Math.min(this.t / this.dur, 1));
      pedestal.position.x = lerp(from.x, to.x, k);
      pedestal.position.z = lerp(from.z, to.z, k);
      return this.t >= this.dur;
    },
  };
}

function diceJob(value, resolve) {
  return {
    t: 0, phase: 0,
    start() {
      this.t = 0; this.phase = 0;
      this.w = { x: -9 + Math.random() * 18, y: -9 + Math.random() * 18, z: -9 + Math.random() * 18 };
      this.baseY = DICE_LOCAL_Y;
      this.startY = diceMesh.position.y;
      const n = (FACE_NORMAL[value] || FACE_NORMAL[1]).clone();
      const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 1, 0));
      const yaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
      this.target = yaw.multiply(q);
    },
    update(dt) {
      this.t += dt;
      if (this.phase === 0) {
        const k = Math.min(this.t / 0.65, 1);
        diceMesh.position.y = this.baseY + 1.7 * Math.sin(Math.PI * k);
        diceMesh.rotation.x += this.w.x * dt;
        diceMesh.rotation.y += this.w.y * dt;
        diceMesh.rotation.z += this.w.z * dt;
        if (k >= 1) {
          this.phase = 1; this.t = 0;
          this.midQ = diceMesh.quaternion.clone();
          this.midY = diceMesh.position.y;
        }
        return false;
      }
      const k = Math.min(this.t / 0.35, 1);
      const e = k * k * (3 - 2 * k);
      diceMesh.quaternion.slerpQuaternions(this.midQ, this.target, e);
      diceMesh.position.y = lerp(this.midY, this.baseY, e);
      if (k >= 1) { diceMesh.position.y = this.baseY; return true; }
      return false;
    },
    finish() { if (resolve) resolve(); },
  };
}

/* ========================= state application =========================== */

function playersSignature(pub) {
  return pub.players.map(p => p.color).join(',');
}

function rollableNow() {
  return !!(ready && state && myColor &&
    state.phase === 'awaitingRoll' && state.turnColor === myColor);
}

function movableSet() {
  if (!state || state.phase !== 'awaitingMove' || state.turnColor !== myColor || !myColor) return new Set();
  return new Set(state.movableTokens || []);
}

function updateInteractivity() {
  const roll = rollableNow();
  if (tapRing) tapRing.visible = roll;
  if (tapLabel) tapLabel.visible = roll;
  const mov = movableSet();
  for (const [key, ring] of highlightRings) {
    const m = tokenMeshes.get(key);
    const ud = m ? m.userData : null;
    const on = !!(ud && ud.color === myColor && mov.has(ud.index));
    ring.visible = on;
    if (on && m) ring.position.set(m.position.x, 0.03, m.position.z);
  }
  if (container) container.style.cursor = 'default';
}

function setState(pub, myColorArg) {
  if (!inited) return;
  if (!ready) return; // WebGL unavailable — graceful no-op
  if (myColorArg) myColor = myColorArg;
  hideBanner();

  const prevState = lastQueuedState || committedState;
  const jobs = [];

  if (!prevState) {
    rebuildTokens(pub);
    const pj = pedestalJob(pub.turnColor);
    if (pj) {
      // snap pedestal on first state (no animation needed)
      const [tx, tz] = PEDESTAL_POS[pub.turnColor] || PEDESTAL_POS.red;
      pedestal.position.set(tx, -1.0, tz);
    }
    committedState = pub;
  } else {
    const prevRest = computeRest(prevState);
    if (playersSignature(prevState) !== playersSignature(pub)) {
      // rebuild, but start meshes at the OLD rest positions so the move job
      // below can animate them to the new ones instead of popping
      rebuildTokens(pub, prevRest);
    }
    const nextRest = computeRest(pub);
    const pj = pedestalJob(pub.turnColor);
    if (pj) jobs.push(pj);
    const mj = buildMoveJob(prevRest, nextRest, prevState, pub);
    if (mj) jobs.push(mj);
    if (jobs.length) {
      const last = jobs[jobs.length - 1];
      const prevFinish = last.finish;
      last.finish = () => { if (prevFinish) prevFinish(); committedState = pub; lastQueuedState = null; };
      for (const j of jobs) enqueue(j);
      lastQueuedState = pub;
    } else {
      committedState = pub;
      lastQueuedState = null;
    }
  }

  state = pub;
  updateInteractivity();
}

function animateDice(value) {
  return new Promise(resolve => {
    if (!ready || !diceMesh) { resolve(); return; }
    enqueue(diceJob(value, resolve));
  });
}

/* ============================== interaction ============================ */

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();

function castAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
}

function onPointerDown(e) {
  if (!ready || !state) return;
  const cx = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0].clientX);
  const cy = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0].clientY);
  if (cx === undefined) return;
  castAt(cx, cy);

  if (rollableNow()) {
    const hits = raycaster.intersectObject(diceMesh, false);
    if (hits.length) {
      try { if (api.onUserRoll) api.onUserRoll(); } catch (err) { console.error(err); }
      return;
    }
  }
  if (state.phase === 'awaitingMove' && state.turnColor === myColor && myColor) {
    const mov = movableSet();
    const hits = raycaster.intersectObjects(tokenHitMeshes, false);
    if (hits.length) {
      const ud = hits[0].object.userData;
      if (ud && ud.color === myColor && mov.has(ud.index)) {
        try { if (api.onTokenPick) api.onTokenPick(ud.index); } catch (err) { console.error(err); }
      }
    }
  }
}

function onPointerMove(e) {
  if (!ready || !state || !renderer) return;
  if (e.clientX === undefined) return;
  castAt(e.clientX, e.clientY);
  let hot = false;
  if (rollableNow() && raycaster.intersectObject(diceMesh, false).length) hot = true;
  else if (state.phase === 'awaitingMove' && state.turnColor === myColor && myColor) {
    const mov = movableSet();
    const hits = raycaster.intersectObjects(tokenHitMeshes, false);
    if (hits.length) {
      const ud = hits[0].object.userData;
      if (ud && ud.color === myColor && mov.has(ud.index)) hot = true;
    }
  }
  container.style.cursor = hot ? 'pointer' : 'default';
}

/* ============================ winner effects =========================== */

function burst(colorHex) {
  const N = 340;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const vel = [];
  const base = new THREE.Color(colorHex === undefined ? 0xffffff : colorHex);
  const white = new THREE.Color(0xffffff);
  const gold = new THREE.Color(0xffd54a);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 2;
    pos[i * 3 + 1] = 2.5 + Math.random() * 2;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 2;
    const a = Math.random() * Math.PI * 2;
    const sp = 2.5 + Math.random() * 5;
    vel.push(new THREE.Vector3(Math.cos(a) * sp, 5 + Math.random() * 7, Math.sin(a) * sp));
    const pick = Math.random();
    const c = pick < 0.55 ? base : pick < 0.8 ? gold : white;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.24, vertexColors: true, transparent: true, opacity: 1, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  confettis.push({ points, vel, life: 0, max: 3.0 });
}

function makeBanner(color) {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 300;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgba(24,12,8,0.90)';
  roundRectPath(g, 10, 10, 1004, 280, 60);
  g.fill();
  g.lineWidth = 10;
  g.strokeStyle = '#ffc93c';
  g.stroke();
  g.textAlign = 'center';
  g.fillStyle = '#ffd968';
  g.font = 'bold 118px Arial, sans-serif';
  g.fillText('🏆 WINNER', 512, 140);
  g.fillStyle = COLOR_CSS[color] || '#ffffff';
  g.font = 'bold 72px Arial, sans-serif';
  g.fillText(String(color).toUpperCase(), 512, 232);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(0.001, 0.001, 1);
  sp.position.set(0, 5.6, 1.6);
  sp.visible = false;
  return sp;
}

function showBanner(color) {
  hideBanner();
  banner = makeBanner(color);
  scene.add(banner);
  banner.visible = true;
  bannerState = { t: 0, phase: 'pop' };
}

function hideBanner() {
  if (banner) {
    scene.remove(banner);
    if (banner.material.map) banner.material.map.dispose();
    banner.material.dispose();
    banner = null;
  }
  bannerState = null;
}

function showWinner(color) {
  if (!ready) return;
  burst(COLORS[color]);
  showBanner(color);
}

/* =============================== main loop ============================= */

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  pump();
  if (current) {
    let done = false;
    try { done = current.update(dt); } catch (e) { console.error('[LudoBoard] job update failed', e); done = true; }
    if (done) {
      try { if (current.finish) current.finish(); } catch (e) { console.error(e); }
      current = null;
      pump();
    }
  }

  // highlight rings: follow their token + pulse
  const pulse = 0.5 + 0.5 * Math.sin(t * 6);
  MAT.hl.opacity = 0.55 + 0.4 * pulse;
  for (const [key, ring] of highlightRings) {
    if (!ring.visible) continue;
    const m = tokenMeshes.get(key);
    if (m) ring.position.set(m.position.x, 0.03, m.position.z);
    const s = 1 + 0.22 * pulse;
    ring.scale.set(s, s, 1);
  }

  // tap-to-roll ring pulse
  if (tapRing && tapRing.visible) {
    MAT.tapRing.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 5));
    const s = 1 + 0.12 * Math.sin(t * 5);
    tapRing.scale.set(s, s, 1);
    if (tapLabel) {
      const ls = 1 + 0.06 * Math.sin(t * 5);
      tapLabel.scale.set(3.6 * ls, 0.9 * ls, 1);
    }
  }

  // confetti
  for (let i = confettis.length - 1; i >= 0; i--) {
    const c = confettis[i];
    c.life += dt;
    const p = c.points.geometry.attributes.position;
    for (let j = 0; j < c.vel.length; j++) {
      const v = c.vel[j];
      v.y -= 7.5 * dt;
      p.array[j * 3] += v.x * dt;
      p.array[j * 3 + 1] += v.y * dt;
      p.array[j * 3 + 2] += v.z * dt;
      if (p.array[j * 3 + 1] < -0.9) { p.array[j * 3 + 1] = -0.9; v.set(0, 0, 0); }
    }
    p.needsUpdate = true;
    c.points.material.opacity = Math.max(0, 1 - c.life / c.max);
    if (c.life >= c.max) {
      scene.remove(c.points);
      c.points.geometry.dispose();
      c.points.material.dispose();
      confettis.splice(i, 1);
    }
  }

  // banner animation
  if (banner && bannerState) {
    bannerState.t += dt;
    const bt = bannerState.t;
    if (bannerState.phase === 'pop') {
      const k = Math.min(bt / 0.45, 1);
      const e = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // ease-out-back-ish
      const s = Math.max(0.001, e);
      banner.scale.set(10 * s, 2.93 * s, 1);
      if (k >= 1) { bannerState.phase = 'hold'; bannerState.t = 0; }
    } else if (bannerState.phase === 'hold') {
      banner.scale.set(10, 2.93, 1);
      const bob = Math.sin(bt * 2.2) * 0.12;
      banner.position.y = 5.6 + bob;
      if (bt > 5.5) { bannerState.phase = 'fade'; bannerState.t = 0; }
    } else {
      const k = Math.min(bt / 0.6, 1);
      banner.material.opacity = 1 - k;
      if (k >= 1) hideBanner();
    }
  }

  renderer.render(scene, camera);
}

/* ================================= init ================================ */

async function init(containerEl) {
  if (inited) return;
  inited = true;
  container = containerEl;

  if (!webglOK()) { showFallback(container); return; }

  container.style.position = container.style.position || 'relative';
  container.style.overflow = 'hidden';

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    console.error('[LudoBoard] WebGL renderer failed', e);
    showFallback(container);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1c1410);
  scene.fog = new THREE.Fog(0x1c1410, 40, 70);

  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 120);

  // warm key light + cool fill + ambient
  const hemi = new THREE.HemisphereLight(0xfff2dd, 0x8a6f5c, 0.75);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe3b3, 2.1);
  key.position.set(10, 18, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -13; key.shadow.camera.right = 13;
  key.shadow.camera.top = 13; key.shadow.camera.bottom = -13;
  key.shadow.camera.near = 2; key.shadow.camera.far = 45;
  key.shadow.bias = -0.0004;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.45);
  fill.position.set(-9, 10, -11);
  scene.add(fill);

  buildSharedAssets();
  buildBoard();

  tokenGroup = new THREE.Group();
  scene.add(tokenGroup);

  buildDiceRig();

  clock = new THREE.Clock();

  fitCamera();
  window.addEventListener('resize', fitCamera);
  if (window.ResizeObserver) {
    new ResizeObserver(() => fitCamera()).observe(container);
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);

  ready = true;
  tick();
  // let the first frame render before resolving
  await new Promise(r => requestAnimationFrame(() => r()));
}

/* ============================ public interface ========================= */

const api = {
  init,
  setState,
  animateDice,
  onUserRoll: null,
  onTokenPick: null,
  showWinner,
};

window.LudoBoard = api;
export default api;

import { createStore } from './store.js';
import { playSnap, playPop, playChime, unlockAudio } from './sound.js';

/*
 * Data model (same online and offline). Two kinds of room share one "rooms/<CODE>" record:
 *
 * Puzzle (meta.kind === 'puzzle', or missing for rooms made before kind existed):
 *   meta    { kind, cols, rows, w, h, seed, created, by }
 *   image   JPEG data URL (max 1600px)
 *   pieces  [ groupId per piece ]
 *   groups  { groupId: {x, y, rot} }   x,y = where the picture's top-left corner would be; rot = 0/90/180/270
 * Because every group stores the position of the picture's corner, two neighbouring groups
 * fit together exactly when their positions are equal. Snapping = comparing two points.
 * Pieces also start rotated (0/90/180/270°) and only snap once turned upright (rot === 0);
 * double-tap/double-click a loose piece to rotate it 90°.
 *
 * Coloring (meta.kind === 'color'):
 *   meta     { kind, mode: 'fill'|'draw', image (picture id, fill only), w, h, created, by, clearSeq }
 *   regions  { regionId: colorHex }                         — fill mode, one entry per painted region
 *   strokes  { strokeId: {uid, color, width, points:[[x,y]]} } — draw mode, one entry per pen stroke
 * "fill" pictures are static built-in assets (coloring/<id>.png): both phones load the same bytes
 * and independently flood-fill it into numbered regions, so only "regionId -> color" needs syncing.
 * "draw" rooms are a blank page; each stroke's point list is resent (throttled) while drawn, so the
 * other phone paints it live. Both share players/holds/meta.clearSeq same as the puzzle.
 *
 * rooms/<CODE>/players { uid: {name, color} }
 * rooms/<CODE>/holds   { groupId: {uid, name, color} }   who is dragging what (puzzle only)
 */

const $ = (id) => document.getElementById(id);
const COUNTS = [50, 100, 150, 200, 300, 500];
const COLORS = ['#ff5c8a', '#4cc9f0', '#ffd166', '#06d6a0', '#b388ff', '#ff9f43'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROTS = [0, 90, 180, 270];
const COLOR_PICS = [
  { id: 'heart', label: 'Heart' },
  { id: 'flower', label: 'Flower' },
  { id: 'cat', label: 'Cat' },
  { id: 'house', label: 'House' },
];
const PALETTE = ['#e63946', '#f3722c', '#f9c74f', '#90be6d', '#43aa8b', '#4d96ff', '#5e60ce', '#b5179e', '#ff70a6', '#8d5524', '#000000', '#ffffff'];

let store;
let me = readJSON('pt-me');
const pick = { img: null, dataUrl: null, thumb: null, count: 100 };
let G = null; // the open game

// ---------- helpers ----------
function readJSON(k, d = null) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadImage(src) {
  return new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
}

function downscale(img, max, quality) {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function grid(n, w, h) {
  const cols = Math.max(2, Math.round(Math.sqrt((n * w) / h)));
  const rows = Math.max(2, Math.round(n / cols));
  return { cols, rows };
}

function newCode() {
  let s = '';
  for (const x of crypto.getRandomValues(new Uint32Array(6))) s += CODE_CHARS[x % CODE_CHARS.length];
  return s;
}

function remember(code, info) {
  const list = readJSON('pt-list', []);
  const old = list.find((e) => e.code === code) || {};
  const rest = list.filter((e) => e.code !== code);
  writeJSON('pt-list', [{ ...old, ...info, code, t: Date.now() }, ...rest].slice(0, 30));
}

// ---------- name / colour ----------
function askName() {
  return new Promise((done) => {
    let color = me?.color || COLORS[0];
    $('nameIn').value = me?.name || '';
    const sw = $('swatches');
    sw.innerHTML = '';
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.style.background = c;
      b.className = c === color ? 'on' : '';
      b.onclick = () => { color = c; [...sw.children].forEach((x) => (x.className = x === b ? 'on' : '')); };
      sw.append(b);
    }
    $('nameDlg').hidden = false;
    $('nameOk').onclick = () => {
      const name = $('nameIn').value.trim() || 'Player';
      me = { name, color };
      writeJSON('pt-me', me);
      $('nameDlg').hidden = true;
      $('who').textContent = `Hi ${me.name} 💕  (tap to change)`;
      done();
    };
  });
}

// ---------- home screen ----------
function showHome() {
  $('game').hidden = true;
  $('home').hidden = false;
  history.replaceState(null, '', location.pathname);
  renderList();
}

function renderCounts() {
  const box = $('counts');
  box.innerHTML = '';
  for (const n of COUNTS) {
    const b = document.createElement('button');
    if (pick.img) { const { cols, rows } = grid(n, pick.img.width, pick.img.height); b.textContent = cols * rows; }
    else b.textContent = n;
    b.className = n === pick.count ? 'on' : '';
    b.onclick = () => { pick.count = n; renderCounts(); };
    box.append(b);
  }
}

function renderList() {
  const ul = $('list');
  ul.innerHTML = '';
  const list = readJSON('pt-list', []);
  if (!list.length) { ul.innerHTML = '<li class="empty">No rooms yet</li>'; return; }
  for (const e of list) {
    const li = document.createElement('li');
    let thumb;
    if (e.thumb) { thumb = document.createElement('img'); thumb.src = e.thumb; thumb.alt = ''; }
    else { thumb = document.createElement('div'); thumb.className = 'thumbIcon'; thumb.textContent = e.icon || '🧩'; }
    const div = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = e.code;
    const small = document.createElement('small');
    small.textContent = e.n ? `${e.n} pieces · ${e.pct ?? 0}% · ${new Date(e.t).toLocaleDateString()}` : new Date(e.t).toLocaleDateString();
    div.append(b, small);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Remove from list');
    x.onclick = (ev) => {
      ev.stopPropagation();
      writeJSON('pt-list', readJSON('pt-list', []).filter((y) => y.code !== e.code));
      renderList();
    };
    li.append(thumb, div, x);
    li.onclick = () => openRoom(e.code);
    ul.append(li);
  }
}

// ---------- home: Puzzle / Color mode tabs ----------
function setHomeMode(m) {
  $('modePuzzle').classList.toggle('on', m === 'puzzle');
  $('modeColor').classList.toggle('on', m === 'color');
  $('puzzleCreate').hidden = m !== 'puzzle';
  $('colorCreate').hidden = m !== 'color';
}
$('modePuzzle').onclick = () => setHomeMode('puzzle');
$('modeColor').onclick = () => setHomeMode('color');

function buildGallery() {
  const box = $('gallery');
  if (box.children.length) return;
  for (const p of COLOR_PICS) {
    const b = document.createElement('button');
    const img = document.createElement('img');
    img.src = `coloring/${p.id}.png`;
    img.alt = p.label;
    const span = document.createElement('span');
    span.textContent = p.label;
    b.append(img, span);
    b.onclick = () => createColorRoom('fill', p.id);
    box.append(b);
  }
}
$('blankPage').onclick = () => createColorRoom('draw', null);

async function createColorRoom(mode, picId) {
  toast(mode === 'fill' ? 'Opening picture…' : 'Starting a blank page…', 8000);
  try {
    let W = 1000, H = 1400;
    if (mode === 'fill') {
      const img = await loadImage(`coloring/${picId}.png`);
      W = img.width; H = img.height;
    }
    const code = newCode();
    await store.createRoom(code, {
      meta: { kind: 'color', mode, image: picId, w: W, h: H, created: Date.now(), by: me.name, clearSeq: 0 },
      regions: {},
    });
    remember(code, mode === 'fill' ? { thumb: `coloring/${picId}.png`, icon: '🎨' } : { icon: '✏️' });
    await openRoom(code);
    if (mode === 'fill') toast('🖌️ Tap a shape to fill it with the selected color', 3500);
  } catch (err) {
    console.error(err);
    toast('Could not start: ' + err.message, 4000);
  }
}

$('who').onclick = () => askName();

$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  try {
    const raw = await loadImage(url);
    pick.dataUrl = downscale(raw, 1600, 0.85);
    pick.thumb = downscale(raw, 200, 0.7);
    pick.img = await loadImage(pick.dataUrl);
  } catch {
    toast('Could not read that image', 3000);
    return;
  } finally {
    URL.revokeObjectURL(url);
  }
  $('preview').src = pick.thumb;
  $('preview').hidden = false;
  $('fileLabel').textContent = '📷 Change photo';
  $('create').disabled = false;
  renderCounts();
};

$('create').onclick = async () => {
  $('create').disabled = true;
  try {
    const W = pick.img.width, H = pick.img.height;
    const { cols, rows } = grid(pick.count, W, H);
    const pw = W / cols, ph = H / rows;
    const seed = (Math.random() * 2 ** 31) | 0;
    const rnd = mulberry32(seed ^ 0x5bd1e995);
    const pieces = [];
    const groups = {};
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // scatter around the frame, never on it
        let x, y;
        do {
          x = (rnd() * 2.1 - 0.55) * W;
          y = (rnd() * 2.1 - 0.55) * H;
        } while (x > -pw && x < W && y > -ph && y < H);
        const i = r * cols + c;
        pieces[i] = 'g' + i;
        groups['g' + i] = { x: Math.round(x - c * pw), y: Math.round(y - r * ph), rot: ROTS[(rnd() * 4) | 0] };
      }
    }
    const code = newCode();
    toast('Creating puzzle…', 10000);
    await store.createRoom(code, {
      meta: { kind: 'puzzle', cols, rows, w: W, h: H, seed, created: Date.now(), by: me.name },
      image: pick.dataUrl,
      pieces,
      groups,
    });
    remember(code, { thumb: pick.thumb, n: cols * rows, pct: 0 });
    await openRoom(code);
    toast('🔄 Pieces start crooked — double-tap one to turn it upright', 4000);
  } catch (err) {
    console.error(err);
    toast('Could not create: ' + err.message, 4000);
  }
  $('create').disabled = false;
};

$('join').onclick = () => {
  const c = $('joinCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length === 6) openRoom(c);
  else toast('Codes have 6 characters');
};

// ---------- open a room ----------
async function openRoom(code) {
  toast('Opening room…', 15000);
  let data;
  try {
    data = await store.loadRoom(code);
  } catch (e) {
    toast('Error: ' + e.message, 4000);
    return;
  }
  if (!data) { toast('No room with code ' + code, 3000); return; }
  const kind = data.meta.kind || 'puzzle';

  leaveGame();
  $('home').hidden = true;
  $('game').hidden = false;
  history.replaceState(null, '', '?room=' + code);
  $('roomCode').textContent = code;

  if (kind === 'color') {
    remember(code, data.meta.mode === 'fill' ? { thumb: `coloring/${data.meta.image}.png`, icon: '🎨' } : { icon: '✏️' });
    await startColorGame(code, data);
  } else {
    const img = await loadImage(data.image);
    const known = readJSON('pt-list', []).find((e) => e.code === code);
    remember(code, { thumb: known?.thumb || downscale(img, 200, 0.7), n: data.meta.cols * data.meta.rows });
    startGame(code, data, img);
  }
  $('toast').hidden = true;
}

function leaveGame() {
  if (!G) return;
  G.unsub?.();
  store.leave(G.code);
  G.stage.destroy();
  G = null;
}

// ---------- puzzle geometry ----------
function makeEdges(rows, cols, seed) {
  const rnd = mulberry32(seed);
  const h = [], v = [];
  for (let r = 0; r < rows - 1; r++) { h[r] = []; for (let c = 0; c < cols; c++) h[r][c] = rnd() < 0.5 ? 1 : -1; }
  for (let r = 0; r < rows; r++) { v[r] = []; for (let c = 0; c < cols - 1; c++) v[r][c] = rnd() < 0.5 ? 1 : -1; }
  return { h, v };
}

// One edge from (x0,y0) to (x1,y1). s: 0 flat, 1 tab outward, -1 hole. S: tab size.
function edgePath(ctx, x0, y0, x1, y1, s, S) {
  if (!s) { ctx.lineTo(x1, y1); return; }
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
  const nx = (dy / L) * S * s, ny = (-dx / L) * S * s; // outward normal (clockwise path)
  const k = S / L;
  const P = (u, v) => { const a = 0.5 + (u - 0.5) * k; return [x0 + dx * a + nx * v, y0 + dy * a + ny * v]; };
  const C = (a, b, c, d, e, f) => ctx.bezierCurveTo(...P(a, b), ...P(c, d), ...P(e, f));
  ctx.lineTo(...P(0.36, 0));
  C(0.42, 0, 0.45, 0.04, 0.40, 0.11);
  C(0.34, 0.20, 0.38, 0.28, 0.50, 0.28);
  C(0.62, 0.28, 0.66, 0.20, 0.60, 0.11);
  C(0.55, 0.04, 0.58, 0, 0.64, 0);
  ctx.lineTo(x1, y1);
}

function piecePath(ctx, r, c) {
  const { pw, ph, S, edges, rows, cols } = G;
  const top = r === 0 ? 0 : -edges.h[r - 1][c];
  const right = c === cols - 1 ? 0 : edges.v[r][c];
  const bottom = r === rows - 1 ? 0 : edges.h[r][c];
  const left = c === 0 ? 0 : -edges.v[r][c - 1];
  ctx.beginPath();
  ctx.moveTo(0, 0);
  edgePath(ctx, 0, 0, pw, 0, top, S);
  edgePath(ctx, pw, 0, pw, ph, right, S);
  edgePath(ctx, pw, ph, 0, ph, bottom, S);
  edgePath(ctx, 0, ph, 0, 0, left, S);
  ctx.closePath();
}

// ---------- game ----------
function startGame(code, data, img) {
  const { cols, rows, w: W, h: H, seed } = data.meta;
  const pw = W / cols, ph = H / rows, S = Math.min(pw, ph), n = cols * rows;
  G = {
    kind: 'puzzle', code, cols, rows, W, H, pw, ph, S, n, img,
    edges: makeEdges(rows, cols, seed),
    groups: new Map(), pieceGroup: new Array(n), shapes: new Array(n),
    holds: {}, players: {}, dragId: null, done: false, snap: S * 0.28,
  };

  Konva.hitOnDragEnabled = true;
  const stage = new Konva.Stage({ container: 'stage', width: innerWidth, height: innerHeight, draggable: true });
  G.stage = stage;
  const bg = new Konva.Layer({ listening: false });
  bg.add(new Konva.Rect({
    x: 0, y: 0, width: W, height: H,
    fill: 'rgba(255,255,255,0.05)', stroke: 'rgba(255,255,255,0.35)',
    strokeWidth: 2, dash: [12, 8], strokeScaleEnabled: false,
  }));
  G.ghost = new Konva.Image({ image: img, width: W, height: H, opacity: 0 });
  bg.add(G.ghost);
  G.layer = new Konva.Layer();
  G.top = new Konva.Layer(); // the group being dragged lives here, so only it redraws
  stage.add(bg, G.layer, G.top);
  $('ghost').classList.remove('on');
  $('ghost').hidden = false;
  $('palette').hidden = true;

  for (const [id, v] of Object.entries(data.groups || {})) {
    const g = model(id);
    g.pos = { x: v.x, y: v.y };
    g.rot = v.rot || 0;
  }
  const m = S * 0.34;
  for (let i = 0; i < n; i++) {
    const r = (i / cols) | 0, c = i % cols;
    const shape = new Konva.Shape({
      // x/y + offset put the rotation pivot at the piece's own centre; at rot=0 this
      // renders exactly where the old (c*pw, r*ph) placement did.
      x: c * pw + pw / 2, y: r * ph + ph / 2,
      offsetX: pw / 2, offsetY: ph / 2,
      rotation: model(data.pieces[i]).rot || 0,
      sceneFunc: (ctx, s) => { piecePath(ctx, r, c); ctx.fillStrokeShape(s); },
      fillPatternImage: img,
      fillPatternOffset: { x: c * pw, y: r * ph },
      fillPatternRepeat: 'no-repeat',
      stroke: 'rgba(0,0,0,0.5)', strokeWidth: 1.2,
      perfectDrawEnabled: false,
    });
    shape.cache({ x: -m, y: -m, width: pw + 2 * m, height: ph + 2 * m, pixelRatio: 1 });
    shape.on('dblclick dbltap', () => rotatePiece(i));
    G.shapes[i] = shape;
    attach(i, data.pieces[i]);
  }
  // random stacking so the same pieces aren't always on top
  for (const g of G.groups.values()) if (Math.random() < 0.5) g.node?.moveToTop();

  G.done = liveGroups() === 1;
  updateProgress();
  fit();
  setupGestures(stage);

  G.unsub = store.subscribe(code, {
    onGroup: (id, v) => onGroup(id, v),
    onPiece: (i, gid) => onPiece(i, gid, true),
    onPlayers,
    onHolds,
  });
  store.join(code, { name: me.name, color: me.color }).catch(() => {});
}

function model(id) {
  let g = G.groups.get(id);
  if (!g) { g = { id, pos: { x: 0, y: 0 }, rot: 0, members: new Set(), node: null }; G.groups.set(id, g); }
  return g;
}

const isUpright = (g) => !g || (g.rot || 0) === 0;

// Only a loose (unsnapped) piece can be rotated — once joined to neighbours a
// group is always already upright and stays that way.
function rotatePiece(i) {
  const gid = G.pieceGroup[i];
  const g = model(gid);
  if (g.members.size > 1) return;
  g.rot = ((g.rot || 0) + 90) % 360;
  for (const mi of g.members) G.shapes[mi]?.rotation(g.rot);
  commit({ ['groups/' + gid]: { x: g.pos.x, y: g.pos.y, rot: g.rot } });
  if (g.rot === 0) { trySnap(gid); updateProgress(); }
}

function nodeOf(id) {
  const g = model(id);
  if (!g.node) {
    g.node = new Konva.Group({ x: g.pos.x, y: g.pos.y, draggable: true });
    wire(g.node, id);
    G.layer.add(g.node);
  }
  return g.node;
}

// Put piece i into group gid. Returns true if it moved.
function attach(i, gid) {
  const prev = G.pieceGroup[i];
  if (prev === gid) return false;
  G.pieceGroup[i] = gid;
  nodeOf(gid).add(G.shapes[i]);
  model(gid).members.add(i);
  const p = prev != null && G.groups.get(prev);
  if (p) {
    p.members.delete(i);
    if (!p.members.size) {
      if (G.dragId === prev) { p.node?.stopDrag(); G.dragId = null; }
      p.node?.destroy();
      G.groups.delete(prev);
    }
  }
  return true;
}

const liveGroups = () => { let k = 0; for (const g of G.groups.values()) if (g.members.size) k++; return k; };
const heldByOther = (id) => G.holds[id] && G.holds[id].uid !== store.uid;
const posOf = (node) => ({ x: Math.round(node.x() * 10) / 10, y: Math.round(node.y() * 10) / 10 });

function wire(node, id) {
  let last = 0;
  node.on('dragstart', () => {
    G.dragId = id;
    node.moveTo(G.top);
    store.hold(G.code, id, { uid: store.uid, name: me.name, color: me.color });
  });
  node.on('dragmove', () => {
    const t = performance.now();
    if (t - last < 70) return;
    last = t;
    store.update(G.code, { ['groups/' + id]: { ...posOf(node), rot: model(id).rot || 0 } });
  });
  node.on('dragend', () => {
    if (G.dragId === id) G.dragId = null;
    store.hold(G.code, id, null);
    if (!node.getParent() || !G.groups.has(id)) return;
    node.moveTo(G.layer);
    const gid = trySnap(id);
    G.groups.get(gid)?.node?.moveToTop();
    updateProgress();
  });
}

// Apply a change locally right away, then send it.
function commit(patch) {
  for (const [k, v] of Object.entries(patch)) {
    const [kind, id] = k.split('/');
    if (kind === 'groups') onGroup(id, v);
    else onPiece(+id, v, false);
  }
  store.update(G.code, patch).catch((e) => toast('Sync error: ' + e.message, 3000));
}

function trySnap(gid) {
  const { cols, rows } = G;
  let cur = gid, snapped = false;
  if (isUpright(G.groups.get(cur))) {
    for (;;) {
      const g = G.groups.get(cur);
      const gx = g.node.x(), gy = g.node.y();
      let target = null;
      for (const i of g.members) {
        const r = (i / cols) | 0, c = i % cols;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const h = G.pieceGroup[rr * cols + cc];
          if (h === cur || heldByOther(h)) continue;
          const hg = G.groups.get(h);
          if (!isUpright(hg)) continue;
          const hn = hg?.node;
          if (hn && Math.hypot(hn.x() - gx, hn.y() - gy) < G.snap) { target = h; break; }
        }
        if (target) break;
      }
      if (!target) break;
      const patch = {};
      for (const i of g.members) patch['pieces/' + i] = target;
      patch['groups/' + cur] = null;
      commit(patch);
      cur = target;
      snapped = true;
    }
  }
  const g = G.groups.get(cur);
  const n = g.node;
  const onBorder = [...g.members].some((i) => {
    const r = (i / cols) | 0, c = i % cols;
    return r === 0 || c === 0 || r === rows - 1 || c === cols - 1;
  });
  if (isUpright(g) && onBorder && (n.x() || n.y()) && Math.hypot(n.x(), n.y()) < G.snap) {
    n.position({ x: 0, y: 0 });
    snapped = true;
  }
  n.position(posOf(n));
  commit({ ['groups/' + cur]: { ...posOf(n), rot: g.rot || 0 } });
  if (snapped) playSnap();
  return cur;
}

// ---------- incoming changes ----------
function onGroup(id, v) {
  if (!G) return;
  if (!v) {
    const g = G.groups.get(id);
    if (g && !g.members.size) { g.node?.destroy(); G.groups.delete(id); }
    return;
  }
  const g = model(id);
  g.pos = { x: v.x, y: v.y };
  const newRot = v.rot || 0;
  if ((g.rot || 0) !== newRot) {
    g.rot = newRot;
    for (const mi of g.members) G.shapes[mi]?.rotation(newRot); // e.g. the other player rotated this piece
  }
  if (!g.node || G.dragId === id) return;
  if (g.node.x() === v.x && g.node.y() === v.y) return;
  g.node.moveToTop();
  if (document.hidden) g.node.position(v); // animations don't run while the app is in the background
  else g.node.to({ x: v.x, y: v.y, duration: 0.09 });
}

let softTimer = 0;
function onPiece(i, gid, remote) {
  if (!G || !gid) return;
  if (attach(i, gid) && remote) {
    nodeOf(gid).moveToTop();
    clearTimeout(softTimer);
    softTimer = setTimeout(() => playSnap(true), 40);
    updateProgress();
  }
}

function onPlayers(p) {
  if (!G) return;
  const before = G.players;
  G.players = p;
  const box = $('players');
  box.innerHTML = '';
  for (const [uid, pl] of Object.entries(p)) {
    if (!pl) continue;
    const s = document.createElement('span');
    s.className = 'chip';
    s.style.background = pl.color;
    s.textContent = (pl.name || '?')[0].toUpperCase();
    s.title = pl.name;
    box.append(s);
    if (uid !== store.uid && !before[uid]) toast(`${pl.name} joined 💕`);
  }
}

function onHolds(h) {
  if (!G) return;
  const prev = G.holds;
  G.holds = h;
  for (const id of new Set([...Object.keys(prev), ...Object.keys(h)])) {
    const n = G.groups.get(id)?.node;
    if (n) n.opacity(heldByOther(id) ? 0.65 : 1);
  }
}

function updateProgress() {
  clearTimeout(G.pt);
  G.pt = setTimeout(() => {
    if (!G) return;
    const k = liveGroups();
    const pct = Math.round(((G.n - k) / (G.n - 1)) * 100);
    $('progress').textContent = `${pct}% · ${G.n} pieces${store.online ? '' : ' · offline'}`;
    remember(G.code, { pct });
    if (k === 1 && !G.done) {
      G.done = true;
      playChime();
      fit();
      $('win').hidden = false;
    }
  }, 120);
}

// ---------- view: zoom / pan ----------
function zoomAt(f, cx = innerWidth / 2, cy = innerHeight / 2) {
  const st = G.stage, old = st.scaleX();
  const s = Math.max(0.03, Math.min(8, old * f));
  const p = { x: (cx - st.x()) / old, y: (cy - st.y()) / old };
  st.scale({ x: s, y: s });
  st.position({ x: cx - p.x * s, y: cy - p.y * s });
}

function fit() {
  const top = 64, pad = 12;
  if (G.kind === 'color') {
    const vw = innerWidth - pad * 2, vh = innerHeight - top - pad * 2;
    const s = Math.min(vw / G.W, vh / G.H);
    G.stage.scale({ x: s, y: s });
    G.stage.position({ x: pad + (vw - G.W * s) / 2, y: top + pad + (vh - G.H * s) / 2 });
    return;
  }
  let x0 = 0, y0 = 0, x1 = G.W, y1 = G.H;
  for (let i = 0; i < G.n; i++) {
    const gid = G.pieceGroup[i];
    const n = G.groups.get(gid)?.node;
    if (!n) continue;
    const cx = n.x() + (i % G.cols) * G.pw + G.pw / 2, cy = n.y() + ((i / G.cols) | 0) * G.ph + G.ph / 2;
    const rot90 = ((G.groups.get(gid).rot || 0) / 90) % 2 !== 0; // 90°/270° swap width and height
    const hw = (rot90 ? G.ph : G.pw) / 2, hh = (rot90 ? G.pw : G.ph) / 2;
    x0 = Math.min(x0, cx - hw); y0 = Math.min(y0, cy - hh);
    x1 = Math.max(x1, cx + hw); y1 = Math.max(y1, cy + hh);
  }
  const vw = innerWidth - pad * 2, vh = innerHeight - top - pad * 2;
  const s = Math.min(vw / (x1 - x0), vh / (y1 - y0));
  G.stage.scale({ x: s, y: s });
  G.stage.position({ x: pad + (vw - (x1 - x0) * s) / 2 - x0 * s, y: top + pad + (vh - (y1 - y0) * s) / 2 - y0 * s });
}

function setupGestures(stage) {
  let lastDist = 0, lastCenter = null;
  stage.on('touchmove', (e) => {
    const t = e.evt.touches;
    if (t.length !== 2) return;
    e.evt.preventDefault();
    if (stage.isDragging()) stage.stopDrag();
    if (G.dragId) G.groups.get(G.dragId)?.node?.stopDrag();
    const a = { x: t[0].clientX, y: t[0].clientY }, b = { x: t[1].clientX, y: t[1].clientY };
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (!lastCenter) { lastCenter = center; lastDist = dist; return; }
    zoomAt(dist / lastDist, center.x, center.y);
    stage.position({ x: stage.x() + center.x - lastCenter.x, y: stage.y() + center.y - lastCenter.y });
    lastDist = dist;
    lastCenter = center;
  });
  stage.on('touchend touchcancel', () => { lastDist = 0; lastCenter = null; });
  stage.on('wheel', (e) => {
    e.evt.preventDefault();
    const p = stage.getPointerPosition();
    zoomAt(e.evt.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
  });
}

// ---------- coloring game ----------
const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// Flood-fill the line-art image into numbered regions. Both phones load the same static PNG and
// run this same deterministic scan, so region N means the same enclosed area on both screens —
// only "region N got color C" ever needs to be sent.
function computeRegions(imgEl) {
  const w = imgEl.width, h = imgEl.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(imgEl, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const ink = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < data.length; p += 4, i++) {
    const lum = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
    ink[i] = lum < 200 || data[p + 3] < 128 ? 1 : 0; // dark (outline) or transparent = wall
  }
  const label = new Int32Array(w * h).fill(-1);
  const pixels = [];
  const qx = new Int32Array(w * h), qy = new Int32Array(w * h);
  let nextId = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (ink[idx] || label[idx] !== -1) continue;
      let qh = 0, qt = 0;
      qx[qt] = x; qy[qt] = y; qt++;
      label[idx] = nextId;
      const list = [idx];
      while (qh < qt) {
        const cx = qx[qh], cy = qy[qh]; qh++;
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nidx = ny * w + nx;
          if (ink[nidx] || label[nidx] !== -1) continue;
          label[nidx] = nextId;
          qx[qt] = nx; qy[qt] = ny; qt++;
          list.push(nidx);
        }
      }
      pixels[nextId] = Int32Array.from(list);
      nextId++;
    }
  }
  return { w, h, label, pixels };
}

function paintRegion(regionId, color) {
  const pix = G.regionPixels[regionId];
  if (!pix) return;
  const [r, gg, b] = hexToRgb(color);
  const data = G.paintData.data;
  for (const idx of pix) {
    const o = idx * 4;
    data[o] = r; data[o + 1] = gg; data[o + 2] = b; data[o + 3] = 255;
  }
}

// Composite the fills (paintData) with the line-art drawn in "multiply" so black ink stays black
// and colors show through the white paper — then let Konva redraw from the same canvas element.
function refreshPaint() {
  const ctx = G.compositeCtx;
  ctx.globalCompositeOperation = 'source-over';
  ctx.putImageData(G.paintData, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(G.lineImg, 0, 0, G.W, G.H);
  ctx.globalCompositeOperation = 'source-over';
  G.layer.batchDraw();
}

// Eases a region from its current colour to a new one over a few frames, instead of a hard swap —
// this is what makes a fill feel like paint flowing in rather than a flat colour-replace.
function animateRegionFill(rid, toColor) {
  const pix = G.regionPixels[rid];
  if (!pix) return;
  const thisGame = G; // closure guard: if the player leaves mid-animation, G is replaced/nulled
  const fromColor = G.regionColors.get(rid) || '#ffffff';
  if (toColor) G.regionColors.set(rid, toColor); else G.regionColors.delete(rid);
  const [fr, fg, fb] = hexToRgb(fromColor);
  const [tr, tg, tb] = hexToRgb(toColor || '#ffffff');
  const data = G.paintData.data;
  const start = performance.now(), dur = 380;
  function step(now) {
    if (G !== thisGame) return; // game was closed or swapped — stop touching its canvas
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const r = fr + (tr - fr) * e, g = fg + (tg - fg) * e, b = fb + (tb - fb) * e;
    for (const idx of pix) { const o = idx * 4; data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255; }
    refreshPaint();
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// A quick expanding, fading ring at the tap point — purely cosmetic, makes a fill feel responsive.
function rippleAt(x, y, color) {
  const ring = new Konva.Circle({ x, y, radius: 2, stroke: color, strokeWidth: 6, opacity: 0.6, listening: false });
  G.fxLayer.add(ring);
  ring.to({ radius: G.S ? G.S * 1.4 : 70, strokeWidth: 0.5, opacity: 0, duration: 0.45, easing: Konva.Easings.EaseOut, onFinish: () => ring.destroy() });
}

function onRegion(id, color) {
  if (!G || G.kind !== 'color' || G.mode !== 'fill') return;
  const rid = +id;
  if ((G.regionColors.get(rid) || null) === (color || null)) return;
  animateRegionFill(rid, color);
}

function onFillTap() {
  const pos = G.konvaImage.getRelativePointerPosition();
  let x = Math.round(pos.x), y = Math.round(pos.y);
  if (x < 0 || y < 0 || x >= G.W || y >= G.H) return;
  let rid = G.label[y * G.W + x];
  if (rid === -1) {
    // forgive an imprecise tap that landed right on a thin outline
    search: for (let rad = 1; rad <= 6 && rid === -1; rad++) {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= G.W || ny >= G.H) continue;
          const nid = G.label[ny * G.W + nx];
          if (nid !== -1) { rid = nid; break search; }
        }
      }
    }
  }
  if (rid === -1) return;
  const color = G.drawColor;
  animateRegionFill(rid, color);
  rippleAt(pos.x, pos.y, color);
  playPop();
  if (!G.myRegions.includes(rid)) G.myRegions.push(rid);
  store.update(G.code, { ['regions/' + rid]: color }).catch((e) => toast('Sync error: ' + e.message, 3000));
}

// ---- drawing: brush styles (marker/crayon/watercolor) ----
function applyBrushStyle(ctx, type, width) {
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.filter = 'none';
  if (type === 'watercolor') { ctx.filter = 'blur(2px)'; ctx.globalAlpha = 0.38; }
  else if (type === 'crayon') { ctx.globalAlpha = 0.88; }
  else { ctx.globalAlpha = 1; }
  ctx.lineWidth = width;
}
function resetBrushStyle(ctx) { ctx.filter = 'none'; ctx.globalAlpha = 1; }

function strokeSegment(x0, y0, x1, y1, color, width, type = 'marker') {
  const ctx = G.compositeCtx;
  ctx.strokeStyle = color;
  applyBrushStyle(ctx, type, width);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  if (type === 'crayon') { // a second faint, wider pass gives the stroke a waxy, grainy edge
    ctx.globalAlpha = 0.16; ctx.lineWidth = width * 1.5;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  resetBrushStyle(ctx);
}
function drawDot(x, y, color, width, type = 'marker') {
  const ctx = G.compositeCtx;
  ctx.fillStyle = color;
  applyBrushStyle(ctx, type, width);
  ctx.beginPath(); ctx.arc(x, y, width / 2, 0, Math.PI * 2); ctx.fill();
  resetBrushStyle(ctx);
}

function currentDrawParams() {
  if (G.tool === 'erase') return { color: '#ffffff', width: G.brushSize * 1.8, type: 'marker' };
  return { color: G.drawColor, width: G.brushSize, type: G.brushType };
}

function beginStroke(x, y) {
  const id = 's' + Math.random().toString(36).slice(2, 10);
  const { color, width, type } = currentDrawParams();
  G.currentStroke = { id, uid: store.uid, color, width, type, points: [[Math.round(x), Math.round(y)]] };
  drawDot(x, y, color, width, type);
  G.remoteCursors.set(id, 1); // we already drew this locally — onStroke should pick up from here, not redraw it
  G.allStrokes.set(id, G.currentStroke);
  G.myStrokes.push(id);
  G.layer.batchDraw();
}
function continueStroke(x, y) {
  if (!G.currentStroke) return;
  const s = G.currentStroke;
  const pts = s.points;
  const [px, py] = pts[pts.length - 1];
  pts.push([Math.round(x), Math.round(y)]);
  strokeSegment(px, py, x, y, s.color, s.width, s.type);
  G.remoteCursors.set(s.id, pts.length);
  G.layer.batchDraw();
  const t = performance.now();
  if (t - G.lastSync > 70) { G.lastSync = t; syncStroke(); }
}
function endStroke() {
  if (!G.currentStroke) return;
  syncStroke();
  G.currentStroke = null;
}
function syncStroke() {
  const s = G.currentStroke;
  store.update(G.code, { ['strokes/' + s.id]: { uid: s.uid, color: s.color, width: s.width, brush: s.type, points: s.points } }).catch(() => {});
}

// Draws only the segments not drawn yet for this stroke id — safe whether the update is this
// phone's own echoed write or the other player's, so there's no need to special-case "my own".
// s === null means the stroke was undone/removed: drop it and redraw the page from what's left.
function onStroke(id, s) {
  if (!G || G.kind !== 'color' || G.mode !== 'draw') return;
  if (!s) { G.allStrokes.delete(id); redrawAll(); return; }
  if (!s.points?.length) return;
  const type = s.brush || 'marker';
  G.allStrokes.set(id, { color: s.color, width: s.width, type, points: s.points });
  const have = G.remoteCursors.get(id) || 0;
  const pts = s.points;
  if (have >= pts.length) return;
  if (!have) drawDot(pts[0][0], pts[0][1], s.color, s.width, type);
  for (let i = Math.max(have, 1); i < pts.length; i++) strokeSegment(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], s.color, s.width, type);
  G.remoteCursors.set(id, pts.length);
  G.layer.batchDraw();
}

// Full repaint from everything currently known (used after an undo, since a single stroke can't
// be "unpainted" from a flat canvas — only replayed from scratch without it).
function redrawAll() {
  G.compositeCtx.filter = 'none'; G.compositeCtx.globalAlpha = 1;
  G.compositeCtx.fillStyle = '#fff';
  G.compositeCtx.fillRect(0, 0, G.W, G.H);
  G.remoteCursors.clear();
  for (const [id, s] of G.allStrokes) {
    if (!s?.points?.length) continue;
    drawDot(s.points[0][0], s.points[0][1], s.color, s.width, s.type);
    for (let i = 1; i < s.points.length; i++) strokeSegment(s.points[i - 1][0], s.points[i - 1][1], s.points[i][0], s.points[i][1], s.color, s.width, s.type);
    G.remoteCursors.set(id, s.points.length);
  }
  G.layer.batchDraw();
}

function wireDrawing(stage) {
  const within1 = (e) => !(e.evt.touches && e.evt.touches.length > 1);
  stage.on('mousedown touchstart', (e) => {
    if (!within1(e)) return;
    const p = G.konvaImage.getRelativePointerPosition();
    if (p.x < 0 || p.y < 0 || p.x > G.W || p.y > G.H) return;
    G.drawing = true;
    beginStroke(p.x, p.y);
  });
  stage.on('mousemove touchmove', (e) => {
    if (!G.drawing || !within1(e)) return;
    const p = G.konvaImage.getRelativePointerPosition();
    continueStroke(Math.max(0, Math.min(G.W, p.x)), Math.max(0, Math.min(G.H, p.y)));
  });
  stage.on('mouseup touchend mouseleave', () => { if (G.drawing) { G.drawing = false; endStroke(); } });
}

function buildPalette() {
  const row = $('swatchRow');
  row.innerHTML = '';
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.style.background = c;
    if (c === '#ffffff') b.style.boxShadow = 'inset 0 0 0 1px rgba(255,255,255,.4)';
    b.className = c === G.drawColor ? 'on' : '';
    b.onclick = () => {
      G.drawColor = c;
      G.tool = 'draw';
      $('eraser').classList.remove('on');
      [...row.children].forEach((x) => x.classList.toggle('on', x === b));
      updateSizeDot();
    };
    row.append(b);
  }
}

const BRUSH_BTN = { marker: 'brushMarker', crayon: 'brushCrayon', watercolor: 'brushWater' };
function setBrushType(type) {
  G.brushType = type;
  G.tool = 'draw';
  for (const t in BRUSH_BTN) $(BRUSH_BTN[t]).classList.toggle('on', t === type);
  $('eraser').classList.remove('on');
  updateSizeDot();
}
function updateSizeDot() {
  const d = $('sizeDot');
  const s = Math.max(6, Math.min(40, G.brushSize));
  d.style.width = s + 'px'; d.style.height = s + 'px';
  d.style.background = G.tool === 'erase' ? '#fff' : G.drawColor;
  d.style.opacity = G.brushType === 'watercolor' && G.tool !== 'erase' ? 0.5 : 1;
}
$('brushMarker').onclick = () => setBrushType('marker');
$('brushCrayon').onclick = () => setBrushType('crayon');
$('brushWater').onclick = () => setBrushType('watercolor');
$('brushSizeInput').oninput = (e) => { G.brushSize = +e.target.value; updateSizeDot(); };
$('eraser').onclick = () => {
  G.tool = G.tool === 'erase' ? 'draw' : 'erase';
  $('eraser').classList.toggle('on', G.tool === 'erase');
  updateSizeDot();
};
$('undoBtn').onclick = () => {
  if (!G || G.kind !== 'color') return;
  if (G.mode === 'fill') {
    const rid = G.myRegions.pop();
    if (rid === undefined) return;
    animateRegionFill(rid, null);
    store.update(G.code, { ['regions/' + rid]: null }).catch(() => {});
  } else {
    const id = G.myStrokes.pop();
    if (!id) return;
    G.allStrokes.delete(id);
    redrawAll();
    store.update(G.code, { ['strokes/' + id]: null }).catch(() => {});
  }
};
$('clearPage').onclick = () => {
  if (!G || G.kind !== 'color') return;
  G.clearSeq = (G.clearSeq || 0) + 1;
  wipeCanvas();
  const patch = { ['meta/clearSeq']: G.clearSeq };
  patch[G.mode === 'fill' ? 'regions' : 'strokes'] = null;
  store.update(G.code, patch).catch((e) => toast('Sync error: ' + e.message, 3000));
};
function wipeCanvas() {
  G.compositeCtx.globalCompositeOperation = 'source-over';
  G.compositeCtx.filter = 'none'; G.compositeCtx.globalAlpha = 1;
  G.compositeCtx.fillStyle = '#fff';
  G.compositeCtx.fillRect(0, 0, G.W, G.H);
  G.regionColors.clear();
  G.remoteCursors.clear();
  G.allStrokes.clear();
  G.myStrokes = [];
  G.myRegions = [];
  if (G.mode === 'fill' && G.paintData) { G.paintData.data.fill(255); refreshPaint(); }
  G.layer.batchDraw();
}
function onClear(seq) {
  if (!G || G.kind !== 'color') return;
  if (seq > (G.clearSeq || 0)) { G.clearSeq = seq; wipeCanvas(); }
}

async function startColorGame(code, data) {
  const mode = data.meta.mode, W = data.meta.w, H = data.meta.h;
  G = {
    kind: 'color', mode, code, W, H, clearSeq: data.meta.clearSeq || 0,
    regionColors: new Map(), remoteCursors: new Map(), allStrokes: new Map(),
    myStrokes: [], myRegions: [], players: {}, holds: {},
    drawColor: PALETTE[0], brushType: 'marker', tool: 'draw', brushSize: 12,
    currentStroke: null, drawing: false, lastSync: 0,
  };

  Konva.hitOnDragEnabled = true;
  const stage = new Konva.Stage({ container: 'stage', width: innerWidth, height: innerHeight, draggable: mode === 'fill' });
  G.stage = stage;
  G.layer = new Konva.Layer();
  G.fxLayer = new Konva.Layer({ listening: false });
  stage.add(G.layer, G.fxLayer);

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  G.compositeCanvas = canvas;
  G.compositeCtx = canvas.getContext('2d');
  G.compositeCtx.fillStyle = '#fff';
  G.compositeCtx.fillRect(0, 0, W, H);

  if (mode === 'fill') {
    const img = await loadImage(`coloring/${data.meta.image}.png`);
    const regions = computeRegions(img);
    G.label = regions.label; G.regionPixels = regions.pixels; G.lineImg = img;
    G.paintData = new ImageData(new Uint8ClampedArray(W * H * 4).fill(255), W, H);
    for (const [id, color] of Object.entries(data.regions || {})) {
      G.regionColors.set(+id, color);
      paintRegion(+id, color);
    }
    refreshPaint();
  } else {
    for (const [id, s] of Object.entries(data.strokes || {})) {
      if (!s?.points?.length) continue;
      const type = s.brush || 'marker';
      drawDot(s.points[0][0], s.points[0][1], s.color, s.width, type);
      for (let i = 1; i < s.points.length; i++) strokeSegment(s.points[i - 1][0], s.points[i - 1][1], s.points[i][0], s.points[i][1], s.color, s.width, type);
      G.remoteCursors.set(id, s.points.length);
      G.allStrokes.set(id, { color: s.color, width: s.width, type, points: s.points });
    }
  }

  G.konvaImage = new Konva.Image({ image: canvas, width: W, height: H });
  G.layer.add(G.konvaImage);
  if (mode === 'fill') G.konvaImage.on('click tap', onFillTap);
  else wireDrawing(stage);

  $('ghost').hidden = true;
  $('palette').hidden = false;
  $('brushTypeRow').style.display = mode === 'draw' ? 'flex' : 'none';
  $('sizeRow').style.display = mode === 'draw' ? 'flex' : 'none';
  if (mode === 'draw') setBrushType('marker');
  $('brushSizeInput').value = G.brushSize;
  updateSizeDot();
  buildPalette();
  fit();
  setupGestures(stage);

  G.unsub = store.subscribe(code, {
    onRegion: (id, color) => onRegion(id, color),
    onStroke: (id, s) => onStroke(id, s),
    onClear: (seq) => onClear(seq),
    onPlayers,
    onHolds: () => {},
  });
  store.join(code, { name: me.name, color: me.color }).catch(() => {});
}

$('zoomIn').onclick = () => zoomAt(1.3);
$('zoomOut').onclick = () => zoomAt(1 / 1.3);
$('fit').onclick = () => fit();
$('ghost').onclick = () => {
  const on = !G.ghost.opacity();
  G.ghost.opacity(on ? 0.28 : 0);
  $('ghost').classList.toggle('on', on);
};
$('back').onclick = () => { leaveGame(); showHome(); };
$('winClose').onclick = () => { $('win').hidden = true; };
$('share').onclick = async () => {
  const url = location.origin + location.pathname + '?room=' + G.code;
  const text = G.kind === 'color' ? `Come color together 🎨 Code: ${G.code}` : `Come play our puzzle 🧩 Code: ${G.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Together', text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invite link copied'); }
  } catch {}
};
addEventListener('resize', () => G?.stage.size({ width: innerWidth, height: innerHeight }));
document.addEventListener('pointerdown', unlockAudio, { once: true });

// ---------- start ----------
async function boot() {
  try {
    store = await createStore();
  } catch (e) {
    console.error(e);
    store = await createStore(true);
    $('mode').textContent = '⚠️ Could not go online (' + e.message + '). Offline mode.';
  }
  if (!$('mode').textContent) {
    $('mode').textContent = store.online ? '🟢 Online — play together' : '🟡 Offline test mode (this device only)';
  }
  renderCounts();
  renderList();
  buildGallery();
  if (!me) await askName();
  $('who').textContent = `Hi ${me.name} 💕  (tap to change)`;
  const code = new URLSearchParams(location.search).get('room');
  if (code) openRoom(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (location.hostname === 'localhost') window.__pt = () => G; // debugging only
boot();

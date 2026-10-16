import { createStore } from './store.js';
import { click, chime, unlockAudio } from './sound.js';

/*
 * Data model (same online and offline):
 *   rooms/<CODE>/meta    { cols, rows, w, h, seed, created, by }
 *   rooms/<CODE>/image   JPEG data URL (max 1600px)
 *   rooms/<CODE>/pieces  [ groupId per piece ]
 *   rooms/<CODE>/groups  { groupId: {x, y, rot} }   x,y = where the picture's top-left corner would be; rot = 0/90/180/270
 *   rooms/<CODE>/players { uid: {name, color} }
 *   rooms/<CODE>/holds   { groupId: {uid, name, color} }   who is dragging what
 *
 * Because every group stores the position of the picture's corner, two neighbouring
 * groups fit together exactly when their positions are equal. Snapping = comparing two points.
 * Pieces also start rotated (0/90/180/270°) and only snap once turned upright (rot === 0);
 * double-tap/double-click a loose piece to rotate it 90°.
 */

const $ = (id) => document.getElementById(id);
const COUNTS = [50, 100, 150, 200, 300, 500];
const COLORS = ['#ff5c8a', '#4cc9f0', '#ffd166', '#06d6a0', '#b388ff', '#ff9f43'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROTS = [0, 90, 180, 270];

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
  if (!list.length) { ul.innerHTML = '<li class="empty">No puzzles yet</li>'; return; }
  for (const e of list) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = e.thumb || '';
    img.alt = '';
    const div = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = e.code;
    const small = document.createElement('small');
    small.textContent = `${e.n || '?'} pieces · ${e.pct ?? 0}% · ${new Date(e.t).toLocaleDateString()}`;
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
    li.append(img, div, x);
    li.onclick = () => openRoom(e.code);
    ul.append(li);
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
      meta: { cols, rows, w: W, h: H, seed, created: Date.now(), by: me.name },
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
  toast('Opening puzzle…', 15000);
  let data;
  try {
    data = await store.loadRoom(code);
  } catch (e) {
    toast('Error: ' + e.message, 4000);
    return;
  }
  if (!data) { toast('No puzzle with code ' + code, 3000); return; }
  const img = await loadImage(data.image);
  const known = readJSON('pt-list', []).find((e) => e.code === code);
  remember(code, { thumb: known?.thumb || downscale(img, 200, 0.7), n: data.meta.cols * data.meta.rows });

  leaveGame();
  $('home').hidden = true;
  $('game').hidden = false;
  history.replaceState(null, '', '?room=' + code);
  $('roomCode').textContent = code;
  startGame(code, data, img);
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
    code, cols, rows, W, H, pw, ph, S, n, img,
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
  if (snapped) click();
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
    softTimer = setTimeout(() => click(true), 40);
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
      chime();
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
  const top = 64, pad = 12;
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
  const text = `Come play our puzzle 🧩 Code: ${G.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Puzzle Together', text, url });
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
  if (!me) await askName();
  $('who').textContent = `Hi ${me.name} 💕  (tap to change)`;
  const code = new URLSearchParams(location.search).get('room');
  if (code) openRoom(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (location.hostname === 'localhost') window.__pt = () => G; // debugging only
boot();

import { GUESS_WORDS } from './words.js';
import { QUIZ, QUIZ_CATS } from './quiz.js';
import { TOD, TOD_CATS, todId } from './tod.js';
import { createStore } from './store.js';
import { playSnap, playPop, playChime, playSfx, unlockAudio } from './sound.js';

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
const PALETTE = [
  '#e63946', '#f3722c', '#f8961e', '#f9c74f', '#90be6d', '#43aa8b',
  '#4d96ff', '#277da1', '#5e60ce', '#9d4edd', '#b5179e', '#ff70a6',
  '#ff9f1c', '#8d5524', '#495057', '#000000', '#ffffff',
];
const RECENTS_KEY = 'pt-recent-colors';

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
      $('who').textContent = `أهلًا ${me.name} 💕  (اضغط للتغيير)`;
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
  if (!list.length) { ul.innerHTML = '<li class="empty">لا توجد غرف بعد</li>'; return; }
  for (const e of list) {
    const li = document.createElement('li');
    let thumb;
    if (e.thumb) { thumb = document.createElement('img'); thumb.src = e.thumb; thumb.alt = ''; }
    else { thumb = document.createElement('div'); thumb.className = 'thumbIcon'; thumb.textContent = e.icon || '🧩'; }
    const div = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = e.code;
    const small = document.createElement('small');
    small.textContent = e.n ? `${e.n} قطعة · ${e.pct ?? 0}% · ${new Date(e.t).toLocaleDateString('en-GB')}` : new Date(e.t).toLocaleDateString('en-GB');
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
// m = null shows the game grid; otherwise that game's setup card.
function setHomeMode(m) {
  $('gameGrid').hidden = !!m;
  $('gamesTitle').hidden = !!m;
  $('backToGames').hidden = !m;
  $('puzzleCreate').hidden = m !== 'puzzle';
  $('colorCreate').hidden = m !== 'color';
  $('guessCreate').hidden = m !== 'guess';
  scrollTo({ top: 0, behavior: 'smooth' });
}
for (const card of document.querySelectorAll('.gameCard')) {
  card.onclick = () => (card.dataset.game === 'quiz' ? newQuizRoom('quiz')
    : card.dataset.game === 'tod' ? newQuizRoom('tod') : setHomeMode(card.dataset.game));
}
async function newQuizRoom(kind) {
  toast('جارٍ تجهيز اللعبة…', 8000);
  try {
    const code = newCode();
    await store.createRoom(code, { meta: { kind, created: Date.now(), by: me.name } });
    remember(code, { icon: kind === 'tod' ? '🍾' : '💞' });
    await openRoom(code);
  } catch (err) {
    console.error(err);
    toast('تعذّر البدء: ' + err.message, 4000);
  }
}
$('backToGames').onclick = () => setHomeMode(null);
$('newGuessGame').onclick = async () => {
  toast('جارٍ تجهيز اللعبة…', 8000);
  try {
    const code = newCode();
    await store.createRoom(code, { meta: { kind: 'color', mode: 'draw', game: 'guess', w: 1000, h: 1000, created: Date.now(), by: me.name, clearSeq: 0 } });
    remember(code, { icon: '🤔' });
    await openRoom(code);
  } catch (err) {
    console.error(err);
    toast('تعذّر البدء: ' + err.message, 4000);
  }
};

$('blankPage').onclick = () => createColorRoom('draw');

$('tracePhotoFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const label = $('tracePhotoLabel');
  label.textContent = '🖼️ جارٍ التحميل…';
  const url = URL.createObjectURL(f);
  try {
    const raw = await loadImage(url);
    const backdrop = downscale(raw, 1100, 0.85); // kept as a real photo — not converted to line art
    await createColorRoom('draw', null, backdrop);
  } catch (err) {
    console.error(err);
    toast('تعذّرت قراءة الصورة', 3000);
  } finally {
    URL.revokeObjectURL(url);
    label.textContent = '🖼️ أو ارسم بحرّية فوق صورة';
    e.target.value = '';
  }
};

$('photoFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const label = $('photoFileLabel');
  label.textContent = '🖍️ جارٍ تحويلها إلى صفحة تلوين…';
  const url = URL.createObjectURL(f);
  try {
    const raw = await loadImage(url);
    const lineArt = toLineArt(raw);
    await createColorRoom('fill', lineArt);
  } catch (err) {
    console.error(err);
    toast('تعذّرت قراءة الصورة', 3000);
  } finally {
    URL.revokeObjectURL(url);
    label.textContent = '📷 ارفع صورة للتلوين';
    e.target.value = '';
  }
};

// `imageSrc` is either a path to a built-in picture, or a line-art data URL from toLineArt().
// `backdrop` (draw mode only) is a photo data URL to trace freely over — kept as-is, not line-arted.
async function createColorRoom(mode, imageSrc, backdrop) {
  toast(mode === 'fill' ? 'Opening picture…' : 'Starting a blank page…', 8000);
  try {
    let image = null, W = 1000, H = 1400;
    if (mode === 'fill') {
      const img = await loadImage(imageSrc);
      W = img.width; H = img.height;
      image = imageToDataUrl(img); // embedded in the room so both phones draw identical pixels
    }
    const code = newCode();
    const data = { meta: { kind: 'color', mode, w: W, h: H, created: Date.now(), by: me.name, clearSeq: 0 }, regions: {} };
    if (image) data.image = image;
    if (backdrop) data.backdrop = backdrop;
    await store.createRoom(code, data);
    if (mode === 'fill') remember(code, { thumb: downscale(await loadImage(image), 200, 0.7), icon: '🎨' });
    else remember(code, backdrop ? { thumb: downscale(await loadImage(backdrop), 200, 0.7), icon: '🖼️' } : { icon: '✏️' });
    await openRoom(code);
    if (mode === 'fill') toast('🖌️ اضغط على أيّ شكل لتلوينه باللون المختار', 3500);
  } catch (err) {
    console.error(err);
    toast('تعذّر البدء: ' + err.message, 4000);
  }
}

function imageToDataUrl(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

// A real photo has lots of midtones; a coloring page/line-art image is almost entirely
// near-white paper and near-black ink. If nearly everything is already extreme, skip edge
// detection — running it on top of existing clean lines only adds noise and doubled outlines.
function looksLikeLineArt(data) {
  // Paper is measured, not assumed white: AI pages often sit on light-grey paper.
  const lums = [];
  let colourful = 0;
  for (let p = 0; p < data.length; p += 4 * 5) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    lums.push(r * 0.299 + g * 0.587 + b * 0.114);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colourful++;
  }
  if (colourful / lums.length > 0.05) return false;
  const paper = Float32Array.from(lums).sort()[Math.floor(lums.length * 0.75)];
  if (paper < 170) return false;
  let extreme = 0;
  for (const l of lums) if (l > paper - 30 || l < 90) extreme++;
  return extreme / lums.length > 0.85;
}

// Turns a photo into black-outline/white-paper line art, entirely in the browser (no AI call, no
// server): grayscale → blur to merge fine texture → Sobel edge strength → threshold to black/white.
// Works best on a simple, high-contrast subject; a busy photo makes a busier (but still usable) page.
// An image that's already line art (a downloaded coloring page, etc.) is just cleanly thresholded
// instead — sharpening its existing lines rather than re-detecting edges on top of them.
function toLineArt(img, maxSize = 1100) {
  const k = Math.min(1, maxSize / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Already clean line art (a downloaded coloring page, an AI-generated one, etc.) — keep every
  // pixel exactly as drawn, antialiasing and all, so it looks identical to what was uploaded.
  // computeRegions() gets its own, separate gap-closing pass purely for flood-fill purposes —
  // that's an invisible internal decision, never something baked into the picture you see.
  if (looksLikeLineArt(data)) return c.toDataURL('image/png');

  let gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
  gray = boxBlur(gray, w, h);
  gray = boxBlur(gray, w, h); // second pass merges small texture into clean, colourable regions

  const mag = new Float32Array(w * h);
  let maxMag = 1;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w - 1] + 2 * gray[i - 1] + gray[i + w - 1] - gray[i - w + 1] - 2 * gray[i + 1] - gray[i + w + 1];
      const gy = gray[i - w - 1] + 2 * gray[i - w] + gray[i - w + 1] - gray[i + w - 1] - 2 * gray[i + w] - gray[i + w + 1];
      const m = Math.hypot(gx, gy);
      mag[i] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  const thresh = maxMag * 0.17; // relative threshold: adapts to each photo's own contrast range
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < mag.length; i++) {
    const v = mag[i] > thresh ? 0 : 255;
    const o = i * 4;
    out.data[o] = v; out.data[o + 1] = v; out.data[o + 2] = v; out.data[o + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}
// Grows a 0/1 ink mask by 1 pixel (4-neighbour), bridging hairline breaks in an outline.
function dilateMask(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      out[i] = mask[i]
        || (x > 0 && mask[i - 1])
        || (x < w - 1 && mask[i + 1])
        || (y > 0 && mask[i - w])
        || (y < h - 1 && mask[i + w])
        ? 1 : 0;
    }
  }
  return out;
}
function boxBlur(src, w, h) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          sum += src[ny * w + nx]; n++;
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
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
    toast('تعذّرت قراءة الصورة', 3000);
    return;
  } finally {
    URL.revokeObjectURL(url);
  }
  $('preview').src = pick.thumb;
  $('preview').hidden = false;
  $('fileLabel').textContent = '📷 غيّر الصورة';
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
    toast('جارٍ إنشاء الأحجية…', 10000);
    await store.createRoom(code, {
      meta: { kind: 'puzzle', cols, rows, w: W, h: H, seed, created: Date.now(), by: me.name },
      image: pick.dataUrl,
      pieces,
      groups,
    });
    remember(code, { thumb: pick.thumb, n: cols * rows, pct: 0 });
    await openRoom(code);
    toast('🔄 القطع مائلة في البداية — اضغط مرّتين على القطعة لتعديلها', 4000);
  } catch (err) {
    console.error(err);
    toast('تعذّر الإنشاء: ' + err.message, 4000);
  }
  $('create').disabled = false;
};

$('join').onclick = () => {
  const c = $('joinCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length === 6) openRoom(c);
  else toast('الرمز من 6 أحرف');
};

// ---------- open a room ----------
async function openRoom(code) {
  toast('جارٍ فتح الغرفة…', 15000);
  let data;
  try {
    data = await store.loadRoom(code);
  } catch (e) {
    toast('خطأ: ' + e.message, 4000);
    return;
  }
  if (!data) { toast('لا توجد غرفة بالرمز ' + code, 3000); return; }
  const kind = data.meta.kind || 'puzzle';

  leaveGame();
  $('home').hidden = true;
  $('game').hidden = false;
  history.replaceState(null, '', '?room=' + code);
  $('roomCode').textContent = code;

  if (kind === 'tod') {
    remember(code, { icon: '🍾' });
    startTodGame(code);
  } else if (kind === 'quiz') {
    remember(code, { icon: '💞' });
    startQuizGame(code, data);
  } else if (kind === 'color') {
    if (data.meta.mode === 'fill') {
      const img = await loadImage(data.image);
      remember(code, { thumb: downscale(img, 200, 0.7), icon: '🎨' });
      await startColorGame(code, data, img);
    } else {
      remember(code, { icon: data.meta.game === 'guess' ? '🤔' : '✏️' });
      await startColorGame(code, data);
    }
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
  clearInterval(G.guessTimer);
  $('guessUI').hidden = true;
  store.leave(G.code);
  G.stage?.destroy();
  $('quizUI').hidden = true;
  $('todUI').hidden = true;
  $('puzzleBar').hidden = true;
  $('game').classList.remove('puzzleRoom');
  G.timers?.forEach(clearTimeout);
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
  $('game').classList.add('puzzleRoom');
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
  // The room picture lives inside the canvas, so it zooms and pans with the pieces.
  G.room = new Konva.Image({ opacity: 0 });
  bg.add(G.room);
  loadImage('games/table.jpg').then((roomImg) => { if (G?.room) { G.room.image(roomImg); placeRoom(); } }).catch(() => {});
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
  setupPanByDoubleTap(stage);

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
  store.update(G.code, patch).catch((e) => toast('خطأ في المزامنة: ' + e.message, 3000));
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
  if (snapped) {
    playSnap();
    const p = G.stage.getPointerPosition() || { x: innerWidth / 2, y: innerHeight / 2 };
    burstAt(p.x, p.y, undefined, [['✨', '💖', '🧩', '⭐'][Math.floor(Math.random() * 4)]]);
    updateProgress();
  }
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
    burstAt(...nodeCenter(nodeOf(gid)), ['#5ba8ff', '#a66bff', '#ffd166'], ['💫'], 10);
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
    if (uid !== store.uid && !before[uid]) toast(`${pl.name} انضمّ 💕`);
  }
  if (G.guessGame) renderGuess();
  if (G.kind === 'quiz') renderQuiz();
  if (G.kind === 'tod') renderTod();
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
    $('progress').textContent = `${pct}% · ${G.n} قطعة${store.online ? '' : ' · بلا اتصال'}`;
    remember(G.code, { pct });
    $('puzzleBar').hidden = false;
    $('puzzleFill').style.width = pct + '%';
    const step = [75, 50, 25].find((m) => pct >= m) || 0;
    if (G.lastStep !== undefined && step > G.lastStep && k > 1) {
      toast({ 25: 'ربع الطريق! كمّلو 💪', 50: 'النصف! برافو 🎉', 75: 'بقا غير شوية! 🔥' }[step], 2200);
      playSfx('cheer', 0.5);
      burstHearts();
    }
    G.lastStep = step;
    if (k === 1 && !G.done) {
      G.done = true;
      playChime();
      playSfx('cheer');
      confetti();
      burstHearts();
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
  const top = G.guessGame ? 150 : 64, bottom = G.guessGame ? 100 : 0, pad = 12;
  if (G.kind === 'color') {
    const vw = innerWidth - pad * 2, vh = innerHeight - top - bottom - pad * 2;
    const s = Math.min(vw / G.W, vh / G.H);
    G.stage.scale({ x: s, y: s });
    G.stage.position({ x: pad + (vw - G.W * s) / 2, y: top + pad + (vh - G.H * s) / 2 });
    return;
  }
  const [x0, y0, x1, y1] = puzzleBounds();
  const vw = innerWidth - pad * 2, vh = innerHeight - top - pad * 2;
  const s = Math.min(vw / (x1 - x0), vh / (y1 - y0));
  G.stage.scale({ x: s, y: s });
  G.stage.position({ x: pad + (vw - (x1 - x0) * s) / 2 - x0 * s, y: top + pad + (vh - (y1 - y0) * s) / 2 - y0 * s });
}

// Board plus every loose piece, in board coordinates.
function puzzleBounds() {
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
  return [x0, y0, x1, y1];
}

// table.jpg: the round tabletop is centred at (50%, 47.8%) and is ~77% of the picture's width.
// Size it so the tabletop covers all the pieces with a little margin.
function placeRoom() {
  const [x0, y0, x1, y1] = puzzleBounds();
  const img = G.room.image();
  const top = Math.max(x1 - x0, y1 - y0) * 1.25;
  const w = top / 0.77, h = w * (img.height / img.width);
  const off = readJSON('pt-room-off-' + G.code, { x: 0, y: 0 }); // where you slid the puzzle last time
  G.room.setAttrs({ x: (x0 + x1) / 2 - w * 0.5 + off.x, y: (y0 + y1) / 2 - h * 0.478 + off.y, width: w, height: h });
  G.roomBase = { x: G.room.x() - off.x, y: G.room.y() - off.y };
  G.room.to({ opacity: 1, duration: 0.4 });
}

// Dragging empty space pans the view (table and puzzle together). Double-tap an empty spot first and
// the next drag slides only the puzzle across the table: the room counter-moves so it stays put on screen.
function setupPanByDoubleTap(stage) {
  let armed = false, disarm = 0, start = null;
  stage.on('dblclick dbltap', (e) => {
    if (e.target !== stage) return; // on a piece that's the rotate gesture
    armed = true;
    toast('اسحب لتحريك الأحجية فوق الطاولة ✋', 1500);
    clearTimeout(disarm);
    disarm = setTimeout(() => { armed = false; }, 4000);
  });
  stage.on('dragstart', (e) => {
    if (e.target !== stage) return;
    clearTimeout(disarm);
    start = armed ? { sx: stage.x(), sy: stage.y(), rx: G.room.x(), ry: G.room.y() } : null;
  });
  stage.on('dragmove', (e) => {
    if (e.target !== stage || !start) return;
    const k = stage.scaleX();
    G.room.position({ x: start.rx - (stage.x() - start.sx) / k, y: start.ry - (stage.y() - start.sy) / k });
  });
  stage.on('dragend', (e) => {
    if (e.target !== stage) return;
    if (start && G.roomBase) writeJSON('pt-room-off-' + G.code, { x: G.room.x() - G.roomBase.x, y: G.room.y() - G.roomBase.y });
    start = null;
    armed = false;
  });
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
  let ink = new Uint8Array(w * h);
  const sample = [];
  for (let p = 0; p < data.length; p += 4 * 7) sample.push(data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114);
  const paper = Float32Array.from(sample).sort()[Math.floor(sample.length * 0.75)];
  const inkBelow = Math.min(235, paper - 20); // grey paper must not count as line
  for (let p = 0, i = 0; p < data.length; p += 4, i++) {
    const lum = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
    // Generously inclusive on purpose: this mask is only used to decide which side of a line a
    // colour belongs to (never shown — the real line art is drawn on top afterwards), so it's
    // fine to swallow the whole antialiased grey band around a curve into "wall" at the source,
    // rather than let it become its own sliver of paper that a fill can never actually reach.
    ink[i] = lum < inkBelow || data[p + 3] < 128 ? 1 : 0; // dark/greyish (outline + its AA halo) or transparent = wall
  }
  // This mask only decides which side of a line a colour belongs to — it's never shown; the
  // actual line art is drawn on top afterwards. So it's safe to close gaps here: a stray hairline
  // break (otherwise a fill could leak through it, e.g. a beard bleeding into the face), and the
  // fragments of antialiasing along a curve (a round hairline, glasses rim) that would otherwise
  // form tiny flecks of "paper" fully boxed in by ink on every side — those can never be reached
  // by any fill, so they'd always show as an uncoloured sliver no matter what you tap. Two passes
  // reliably swallow both without visibly thickening the line you actually see.
  ink = dilateMask(ink, w, h);
  ink = dilateMask(ink, w, h);
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
  return mergeSliverRegions(w, h, label, pixels);
}

// A decorative inner line (a shirt's fold, a rug's seam) still fully encloses its own sliver of
// paper on each side, so the flood fill above happily treats that sliver as its own region —
// then a tap on the big shape next to it leaves that thin strip unfilled. A real coloring book
// doesn't work that way: you'd just colour straight over a wrinkle line. So any region that's
// thin in its narrowest dimension (not a small round thing like an eye, which stays separate on
// purpose) gets folded into whichever neighbouring region borders it most.
function mergeSliverRegions(w, h, label, pixels) {
  const THIN_PX = 7;
  const parent = pixels.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };

  for (let id = 0; id < pixels.length; id++) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const idx of pixels[id]) {
      const x = idx % w, y = (idx / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (Math.min(maxX - minX + 1, maxY - minY + 1) > THIN_PX) continue; // a real shape, leave it alone

    const neighbourVotes = new Map();
    for (const idx of pixels[id]) {
      const x = idx % w, y = (idx / w) | 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nid = label[ny * w + nx];
        if (nid === -1 || nid === id) continue;
        const root = find(nid);
        neighbourVotes.set(root, (neighbourVotes.get(root) || 0) + 1);
      }
    }
    let best = -1, bestVotes = 0;
    for (const [root, votes] of neighbourVotes) if (votes > bestVotes) { best = root; bestVotes = votes; }
    if (best !== -1) parent[find(id)] = best;
  }

  const mergedPixels = [];
  const idOf = new Map();
  for (let i = 0; i < label.length; i++) {
    if (label[i] === -1) continue;
    const root = find(label[i]);
    let fid = idOf.get(root);
    if (fid === undefined) { fid = mergedPixels.length; mergedPixels.push([]); idOf.set(root, fid); }
    mergedPixels[fid].push(i);
    label[i] = fid;
  }
  return { w, h, label, pixels: mergedPixels.map((p) => Int32Array.from(p)) };
}

// Grow only into line/antialias pixels (and tiny specks) so colour reaches the dark line core
// without spilling into a real neighbouring region; multiply keeps the line itself black.
function dilatePixelSet(idxArray, w, h, label, tiny, steps = 4) {
  const grown = new Set(idxArray);
  let frontier = idxArray;
  for (let s = 0; s < steps; s++) {
    const next = [];
    for (const idx of frontier) {
      const x = idx % w, y = (idx / w) | 0;
      const nb = [x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1, y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1];
      for (const n of nb) {
        if (n >= 0 && (label[n] === -1 || tiny[label[n]]) && !grown.has(n)) { grown.add(n); next.push(n); }
      }
    }
    frontier = next;
  }
  return Int32Array.from(grown);
}

function paintRegion(regionId, color) {
  const pix = G.paintPixels[regionId];
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
  ctx.drawImage(G.brushCanvas, 0, 0); // free-brush paint sits under the line art too
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(G.lineImg, 0, 0, G.W, G.H);
  ctx.globalCompositeOperation = 'source-over';
  G.layer.batchDraw();
}

// Eases a region from its current colour to a new one over a few frames, instead of a hard swap —
// this is what makes a fill feel like paint flowing in rather than a flat colour-replace.
function animateRegionFill(rid, toColor) {
  const pix = G.paintPixels[rid];
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

// Particle burst at a screen point: little dots fly outward, plus an emoji or two floating up.
function burstAt(x, y, colors = ['#ff6fa5', '#a66bff', '#5ba8ff', '#ffd166'], emojis = ['✨'], n = 14) {
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    d.className = 'fxDot';
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4, r = 40 + Math.random() * 50;
    d.style.left = x + 'px'; d.style.top = y + 'px';
    d.style.background = colors[i % colors.length];
    d.style.setProperty('--dx', Math.cos(a) * r + 'px');
    d.style.setProperty('--dy', Math.sin(a) * r + 'px');
    document.body.append(d);
    setTimeout(() => d.remove(), 800);
  }
  for (const e of emojis) {
    const f = document.createElement('span');
    f.className = 'fxEmoji';
    f.textContent = e;
    f.style.left = x + (Math.random() * 40 - 20) + 'px'; f.style.top = y + 'px';
    document.body.append(f);
    setTimeout(() => f.remove(), 1100);
  }
}
const nodeCenter = (node) => { const r = node.getClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; };

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

// Eyedropper. In fill mode it reads the colour layer under the line art, so tapping right on a
// black outline still gives the fill colour beside it rather than black.
function pickColorAt(x, y) {
  x = Math.max(0, Math.min(G.W - 1, Math.round(x)));
  y = Math.max(0, Math.min(G.H - 1, Math.round(y)));
  let rgb;
  if (G.mode === 'fill') {
    const b = G.brushCtx.getImageData(x, y, 1, 1).data;
    const o = (y * G.W + x) * 4, p = G.paintData.data;
    const a = b[3] / 255;
    rgb = [0, 1, 2].map((i) => Math.round(b[i] * a + p[o + i] * (1 - a)));
  } else {
    rgb = [...G.compositeCtx.getImageData(x, y, 1, 1).data.slice(0, 3)];
  }
  const hex = '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  setPicking(false);
  setPick(hex);
  selectColor(hex);
  pushRecent(hex);
  renderSwatches();
  rippleAt(x, y, hex);
  toast('تمّ أخذ اللون 🎨', 1200);
}
function setPicking(on) {
  G.picking = on;
  $('pickerBtn').classList.toggle('on', on);
  if (G.mode === 'fill') G.stage.draggable(!on && G.fillTool === 'fill');
}
$('pickerBtn').onclick = () => { closePanels(); setPicking(!G.picking); if (G.picking) toast('اضغط على الصورة لأخذ لون منها', 1600); };

function onFillTap() {
  if (G.fillTool === 'brush' || G.picking) return;
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
  const prev = G.regionColors.get(rid) || null;
  animateRegionFill(rid, color);
  rippleAt(pos.x, pos.y, color);
  const sp = G.stage.getPointerPosition();
  if (sp) burstAt(sp.x, sp.y, [color, color, '#ffffff'], [['✨', '🎨', '💖'][Math.floor(Math.random() * 3)]], 16);
  playPop();
  G.history.push({ kind: 'region', id: rid, prev });
  store.update(G.code, { ['regions/' + rid]: color }).catch((e) => toast('خطأ في المزامنة: ' + e.message, 3000));
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

// In fill mode strokes go on their own layer (under the line art); the eraser cuts brush paint
// away there instead of painting white over the tap-fills.
function strokeCtx(type) {
  if (G.mode !== 'fill') return G.compositeCtx;
  G.brushCtx.globalCompositeOperation = type === 'erase' ? 'destination-out' : 'source-over';
  return G.brushCtx;
}
function showStrokes() {
  if (G.mode === 'fill') { G.brushCtx.globalCompositeOperation = 'source-over'; refreshPaint(); }
  else G.layer.batchDraw();
}

function strokeSegment(x0, y0, x1, y1, color, width, type = 'marker') {
  const ctx = strokeCtx(type);
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
  const ctx = strokeCtx(type);
  ctx.fillStyle = color;
  applyBrushStyle(ctx, type, width);
  ctx.beginPath(); ctx.arc(x, y, width / 2, 0, Math.PI * 2); ctx.fill();
  resetBrushStyle(ctx);
}

function currentDrawParams() {
  if (G.tool === 'erase') return { color: '#ffffff', width: G.brushSize * 1.8, type: 'erase' };
  return { color: G.drawColor, width: G.brushSize, type: G.brushType };
}

// ---- brush sensitivity: each point carries a width factor (3rd value, 1 = slider size) ----
// A pen reports real pressure; a finger can't, so speed stands in for it (slow = thick, fast = thin).
const lastPointer = { type: 'mouse', pressure: 0.5 };
for (const ev of ['pointerdown', 'pointermove']) {
  addEventListener(ev, (e) => { lastPointer.type = e.pointerType; lastPointer.pressure = e.pressure; }, { passive: true });
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function widthFactor(speedPxPerMs) {
  if (G.tool === 'erase') return 1;
  if (lastPointer.type === 'pen' && lastPointer.pressure > 0) return clamp(0.25 + lastPointer.pressure * 1.5, 0.25, 1.75);
  return clamp(1.4 - speedPxPerMs * 0.45, 0.35, 1.4);
}
const ptWidth = (s, p) => s.width * (p[2] ?? 1);
function replayStroke(s, type, from = 0) {
  const pts = s.points;
  if (from === 0) drawDot(pts[0][0], pts[0][1], s.color, ptWidth(s, pts[0]), type);
  for (let i = Math.max(from, 1); i < pts.length; i++) {
    strokeSegment(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], s.color, (ptWidth(s, pts[i - 1]) + ptWidth(s, pts[i])) / 2, type);
  }
}

function beginStroke(x, y) {
  const id = 's' + Math.random().toString(36).slice(2, 10);
  const { color, width, type } = currentDrawParams();
  const f = +widthFactor(0).toFixed(2);
  G.currentStroke = { id, uid: store.uid, color, width, type, points: [[Math.round(x), Math.round(y), f]] };
  G.lastPt = { t: performance.now(), f };
  drawDot(x, y, color, width * f, type);
  G.remoteCursors.set(id, 1); // we already drew this locally — onStroke should pick up from here, not redraw it
  G.allStrokes.set(id, G.currentStroke);
  G.history.push({ kind: 'stroke', id });
  showStrokes();
}
function continueStroke(x, y) {
  if (!G.currentStroke) return;
  const s = G.currentStroke;
  const pts = s.points;
  const prev = pts[pts.length - 1];
  const now = performance.now();
  const screenDist = Math.hypot(x - prev[0], y - prev[1]) * G.stage.scaleX();
  const speed = screenDist / Math.max(8, now - G.lastPt.t);
  const f = +(G.lastPt.f * 0.65 + widthFactor(speed) * 0.35).toFixed(2); // smoothed so width never jumps
  G.lastPt = { t: now, f };
  pts.push([Math.round(x), Math.round(y), f]);
  strokeSegment(prev[0], prev[1], x, y, s.color, (ptWidth(s, prev) + s.width * f) / 2, s.type);
  G.remoteCursors.set(s.id, pts.length);
  showStrokes();
  if (now - (G.lastSparkle || 0) > 220 && s.type !== 'erase') { // a few sparkles trail the brush
    G.lastSparkle = now;
    const sp = G.stage.getPointerPosition();
    if (sp) burstAt(sp.x, sp.y, [s.color, '#ffffff'], [], 5);
  }
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
  if (!G || G.kind !== 'color') return;
  if (!s) { G.allStrokes.delete(id); redrawAll(); return; }
  if (!s.points?.length) return;
  const type = s.brush || 'marker';
  G.allStrokes.set(id, { color: s.color, width: s.width, type, points: s.points });
  const have = G.remoteCursors.get(id) || 0;
  const pts = s.points;
  if (have >= pts.length) return;
  replayStroke(s, type, have);
  G.remoteCursors.set(id, pts.length);
  showStrokes();
}

// The drawing canvas's blank state: plain white, or — when tracing over a photo — white with
// that photo faded in underneath, so strokes painted on top always stay fully opaque and crisp.
function paintBase() {
  const ctx = G.compositeCtx;
  ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, G.W, G.H);
  if (G.mode === 'draw' && G.backdrop) {
    ctx.globalAlpha = 0.4;
    ctx.drawImage(G.backdrop, 0, 0, G.W, G.H);
    ctx.globalAlpha = 1;
  }
}

// Full repaint from everything currently known (used after an undo, since a single stroke can't
// be "unpainted" from a flat canvas — only replayed from scratch without it).
function redrawAll() {
  if (G.mode === 'fill') G.brushCtx.clearRect(0, 0, G.W, G.H);
  else paintBase();
  G.remoteCursors.clear();
  for (const [id, s] of G.allStrokes) {
    if (!s?.points?.length) continue;
    replayStroke(s, s.type);
    G.remoteCursors.set(id, s.points.length);
  }
  showStrokes();
}

function wireDrawing(stage) {
  const within1 = (e) => !(e.evt.touches && e.evt.touches.length > 1);
  const brushOn = () => G.mode === 'draw' || G.fillTool === 'brush';
  // Brush-size ring: white with a dark edge so it reads on any colour. Lives in image coordinates,
  // so it scales with zoom exactly like the paint does.
  const ring = new Konva.Circle({ stroke: '#fff', strokeWidth: 1.5, shadowColor: '#000', shadowBlur: 2, shadowOpacity: 0.9, listening: false, visible: false });
  G.fxLayer.add(ring);
  const moveRing = (p) => {
    if (!brushOn()) { ring.visible(false); G.fxLayer.batchDraw(); return; }
    const s = G.stage.scaleX();
    ring.setAttrs({ x: p.x, y: p.y, radius: currentDrawParams().width / 2, strokeWidth: 1.5 / s, visible: true });
    G.fxLayer.batchDraw();
  };
  const hideRing = () => { ring.visible(false); G.fxLayer.batchDraw(); };
  stage.on('mousedown touchstart', (e) => {
    if (!within1(e)) { hideRing(); return; }
    if (G.picking) {
      const q = G.konvaImage.getRelativePointerPosition();
      if (q.x >= 0 && q.y >= 0 && q.x <= G.W && q.y <= G.H) pickColorAt(q.x, q.y);
      return;
    }
    if (!brushOn()) return;
    if (G.guessGame && !(roundLive() && amDrawer() && !G.gs.doneDrawing)) return; // only the artist draws
    const p = G.konvaImage.getRelativePointerPosition();
    if (p.x < 0 || p.y < 0 || p.x > G.W || p.y > G.H) return;
    G.drawing = true;
    moveRing(p);
    beginStroke(p.x, p.y);
  });
  stage.on('mousemove touchmove', (e) => {
    if (!within1(e)) { hideRing(); return; }
    const p = G.konvaImage.getRelativePointerPosition();
    if (e.type === 'mousemove' || G.drawing) moveRing(p);
    if (!G.drawing) return;
    continueStroke(Math.max(0, Math.min(G.W, p.x)), Math.max(0, Math.min(G.H, p.y)));
  });
  stage.on('touchend', hideRing);
  stage.on('mouseleave', hideRing);
  stage.on('mouseup touchend mouseleave', () => { if (G.drawing) { G.drawing = false; endStroke(); } });
}

// ---- colour: palette + per-hue shade strip + unlimited custom colour (native picker) ----
function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}
function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (!s) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
function loadRecents() { return readJSON(RECENTS_KEY, []); }
function pushRecent(hex) {
  const r = [hex, ...loadRecents().filter((c) => c.toLowerCase() !== hex.toLowerCase())].slice(0, 6);
  writeJSON(RECENTS_KEY, r);
}

// ---- colour panel: hue ring + shade slider + swatch grid (modelled on Sketchbook-style pickers) ----
const PICK = { h: 0, s: 80, l: 55 };
function makeSwatch(hex) {
  const b = document.createElement('button');
  b.dataset.hex = hex;
  b.style.background = hex;
  b.onclick = () => { setPick(hex); selectColor(hex); };
  return b;
}
function renderSwatches() {
  $('swatchGrid').replaceChildren(...PALETTE.map(makeSwatch));
  const rec = loadRecents();
  $('recentGrid').replaceChildren(...rec.map(makeSwatch));
  $('recentLabel').hidden = !rec.length;
  markSelected();
}
function markSelected() {
  for (const x of document.querySelectorAll('#colorSheet [data-hex]')) x.classList.toggle('on', x.dataset.hex.toLowerCase() === G.drawColor.toLowerCase());
}
function setPick(hex) {
  const { h, s, l } = hexToHsl(hex);
  Object.assign(PICK, { h, s, l });
  drawPick();
}
function drawPick() {
  const a = (PICK.h - 90) * Math.PI / 180;
  const k = $('ringKnob');
  k.style.left = 50 + 41 * Math.cos(a) + '%';
  k.style.top = 50 + 41 * Math.sin(a) + '%';
  k.style.background = `hsl(${PICK.h} ${Math.max(PICK.s, 60)}% 55%)`;
  $('lightInput').value = PICK.l;
  $('lightInput').style.background = `linear-gradient(90deg, hsl(${PICK.h} ${PICK.s}% 8%), hsl(${PICK.h} ${PICK.s}% 50%), hsl(${PICK.h} ${PICK.s}% 92%))`;
  $('colorPreview').style.background = G?.drawColor || '#fff';
}
function pickFromRing(e) {
  const r = $('hueRing').getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  PICK.h = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  if (PICK.s < 35) PICK.s = 85;
  if (PICK.l < 15 || PICK.l > 85) PICK.l = 55;
  selectColor(hslToHex(PICK.h, PICK.s, PICK.l));
  drawPick();
}
$('hueRing').onpointerdown = (e) => { $('hueRing').setPointerCapture(e.pointerId); pickFromRing(e); };
$('hueRing').onpointermove = (e) => { if (e.buttons) pickFromRing(e); };
$('lightInput').oninput = (e) => { PICK.l = +e.target.value; selectColor(hslToHex(PICK.h, PICK.s, PICK.l)); drawPick(); };

function selectColor(hex) {
  G.drawColor = hex;
  if (G.tool === 'erase') setTool(G.mode === 'fill' ? 'fill' : 'brush');
  $('colorChip').style.background = hex;
  markSelected();
  updateSizeDot();
  $('colorPreview').style.background = hex;
}
function buildPalette() {
  renderSwatches();
  setPick(G.drawColor);
  $('colorChip').style.background = G.drawColor;
}

// ---- panels + tools ----
const PANELS = ['colorSheet', 'brushPop'];
function togglePanel(id) { for (const p of PANELS) $(p).hidden = p !== id || !$(p).hidden; }
function closePanels() {
  if (!$('colorSheet').hidden) { pushRecent(G.drawColor); renderSwatches(); }
  for (const p of PANELS) $(p).hidden = true;
}
$('colorBtn').onclick = () => {
  if ($('colorSheet').hidden) { setPick(G.drawColor); togglePanel('colorSheet'); } else closePanels();
};
$('closeColor').onclick = closePanels;

// 'fill' = tap a shape; 'brush' = paint freely (under the lines in fill mode); 'erase'.
// Painting tools stop one-finger panning; pinch still zooms.
function setTool(t) {
  G.picking = false;
  $('pickerBtn').classList.remove('on');
  G.fillTool = t === 'fill' ? 'fill' : 'brush';
  G.tool = t === 'erase' ? 'erase' : 'draw';
  $('toolFill').classList.toggle('on', t === 'fill');
  $('toolBrush').classList.toggle('on', t === 'brush');
  $('eraser').classList.toggle('on', t === 'erase');
  $('brushTypeRow').hidden = t === 'erase';
  $('brushPopTitle').textContent = t === 'erase' ? 'حجم الممحاة' : 'حجم الفرشاة';
  if (G.mode === 'fill') G.stage.draggable(t === 'fill');
  updateSizeDot();
}
const activeTool = () => (G.tool === 'erase' ? 'erase' : G.fillTool === 'fill' && G.mode === 'fill' ? 'fill' : 'brush');
$('toolFill').onclick = () => { closePanels(); setTool('fill'); };
$('toolBrush').onclick = () => { if (activeTool() === 'brush') togglePanel('brushPop'); else { closePanels(); setTool('brush'); } };
$('eraser').onclick = () => { if (activeTool() === 'erase') togglePanel('brushPop'); else { closePanels(); setTool('erase'); } };

const BRUSH_BTN = { marker: 'brushMarker', crayon: 'brushCrayon', watercolor: 'brushWater' };
function setBrushType(type) {
  G.brushType = type;
  for (const t in BRUSH_BTN) $(BRUSH_BTN[t]).classList.toggle('on', t === type);
  updateSizeDot();
}
function updateSizeDot() {
  const d = $('sizeDot');
  const s = Math.max(4, Math.min(44, G.brushSize * (G.tool === 'erase' ? 1.1 : 1)));
  d.style.width = s + 'px'; d.style.height = s + 'px';
  d.classList.toggle('erase', G.tool === 'erase');
  d.style.background = G.tool === 'erase' ? '#fff' : G.drawColor;
  d.style.opacity = G.brushType === 'watercolor' && G.tool !== 'erase' ? 0.5 : 1;
}
$('brushMarker').onclick = () => setBrushType('marker');
$('brushCrayon').onclick = () => setBrushType('crayon');
$('brushWater').onclick = () => setBrushType('watercolor');
$('brushSizeInput').oninput = (e) => { G.brushSize = +e.target.value; updateSizeDot(); };
$('undoBtn').onclick = () => {
  if (!G || G.kind !== 'color') return;
  const last = G.history.pop();
  if (!last) return;
  if (last.kind === 'region') {
    animateRegionFill(last.id, last.prev);
    store.update(G.code, { ['regions/' + last.id]: last.prev }).catch(() => {});
  } else {
    G.allStrokes.delete(last.id);
    redrawAll();
    store.update(G.code, { ['strokes/' + last.id]: null }).catch(() => {});
  }
};
$('clearPage').onclick = () => {
  if (!G || G.kind !== 'color') return;
  G.clearSeq = (G.clearSeq || 0) + 1;
  wipeCanvas();
  const patch = { ['meta/clearSeq']: G.clearSeq, strokes: null };
  if (G.mode === 'fill') patch.regions = null;
  store.update(G.code, patch).catch((e) => toast('خطأ في المزامنة: ' + e.message, 3000));
};
function wipeCanvas() {
  paintBase();
  G.regionColors.clear();
  G.remoteCursors.clear();
  G.allStrokes.clear();
  G.history = [];
  if (G.mode === 'fill' && G.paintData) { G.brushCtx.clearRect(0, 0, G.W, G.H); G.paintData.data.fill(255); refreshPaint(); }
  G.layer.batchDraw();
}
function onClear(seq) {
  if (!G || G.kind !== 'color') return;
  if (seq > (G.clearSeq || 0)) { G.clearSeq = seq; wipeCanvas(); }
}

async function startColorGame(code, data, preloadedImg) {
  const mode = data.meta.mode, W = data.meta.w, H = data.meta.h;
  G = {
    kind: 'color', mode, code, W, H, clearSeq: data.meta.clearSeq || 0,
    regionColors: new Map(), remoteCursors: new Map(), allStrokes: new Map(),
    history: [], fillTool: 'fill', players: {}, holds: {},
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
  G.backdrop = mode === 'draw' && data.backdrop ? await loadImage(data.backdrop) : null;
  paintBase();

  if (mode === 'fill') {
    const img = preloadedImg || await loadImage(data.image);
    const regions = computeRegions(img);
    G.label = regions.label; G.regionPixels = regions.pixels; G.lineImg = img;
    const tiny = regions.pixels.map((p) => p.length < 30);
    G.paintPixels = regions.pixels.map((p) => dilatePixelSet(p, W, H, regions.label, tiny));
    G.paintData = new ImageData(new Uint8ClampedArray(W * H * 4).fill(255), W, H);
    G.brushCanvas = document.createElement('canvas');
    G.brushCanvas.width = W; G.brushCanvas.height = H;
    G.brushCtx = G.brushCanvas.getContext('2d');
    for (const [id, color] of Object.entries(data.regions || {})) {
      G.regionColors.set(+id, color);
      paintRegion(+id, color);
    }
  }
  for (const [id, s] of Object.entries(data.strokes || {})) {
    if (!s?.points?.length) continue;
    const type = s.brush || 'marker';
    replayStroke(s, type);
    G.remoteCursors.set(id, s.points.length);
    G.allStrokes.set(id, { color: s.color, width: s.width, type, points: s.points });
  }
  if (mode === 'fill') { G.brushCtx.globalCompositeOperation = 'source-over'; refreshPaint(); }

  G.konvaImage = new Konva.Image({ image: canvas, width: W, height: H });
  G.layer.add(G.konvaImage);
  if (mode === 'fill') G.konvaImage.on('click tap', onFillTap);
  wireDrawing(stage);

  $('ghost').hidden = true;
  $('palette').hidden = false;
  $('toolFill').hidden = mode !== 'fill';
  closePanels();
  setBrushType('marker');
  setTool(mode === 'fill' ? 'fill' : 'brush');
  stage.on('mousedown touchstart', () => { if (PANELS.some((p) => !$(p).hidden)) closePanels(); });
  $('brushSizeInput').value = G.brushSize;
  updateSizeDot();
  buildPalette();
  fit();
  setupGestures(stage);

  if (data.meta.game === 'guess') setupGuessGame();
  G.unsub = store.subscribe(code, {
    onRegion: (id, color) => onRegion(id, color),
    onStroke: (id, s) => onStroke(id, s),
    onClear: (seq) => onClear(seq),
    onGame: (gs) => onGame(gs),
    onGuess: (id, g) => onGuess(id, g),
    onPlayers,
    onHolds: () => {},
  });
  store.join(code, { name: me.name, color: me.color }).catch(() => {});
}

// ---------- Draw & Guess (ارسم وخمّن) ----------
// One player draws a secret فصحى word, the other types guesses. Round state lives in `game/`
// (both phones render from it); guesses are append-only under `guesses/`, tagged with their round.
const ROUND_MS = 90000;

const normAr = (s) => s.trim()
  .replace(/[ً-ٰٟـ]/g, '') // tashkeel + tatweel
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .split(/\s+/).map((w) => w.replace(/^ال/, '')).join(' ');
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
const arNum = (n) => String(n); // Western digits (1, 2, 3) on purpose
const amDrawer = () => G?.gs?.drawer === store.uid;
const roundLive = () => G?.gs && !G.gs.solved;

function setupGuessGame() {
  G.guessGame = true;
  G.gs = null;
  G.guesses = [];
  $('guessUI').hidden = false;
  G.guessTimer = setInterval(tickGuess, 250);
  renderGuess();
}

// Every word ever played is remembered online (a fixed 6-letter room, so existing database rules
// allow it) and never offered again, across all games.
const WORDS_ROOM = 'HNWRDS';
const wordKey = (w) => normAr(w).replace(/[.#$\[\]\/]/g, '');
async function pickFreshWord() {
  let used = {};
  try { used = (await store.loadRoom(WORDS_ROOM))?.used || {}; } catch {}
  const left = GUESS_WORDS.filter((w) => !used[wordKey(w)]);
  if (!left.length) return null;
  const word = left[Math.floor(Math.random() * left.length)];
  if (!store.online && !(await store.loadRoom(WORDS_ROOM))) await store.createRoom(WORDS_ROOM, { used: {} });
  await store.update(WORDS_ROOM, { ['used/' + wordKey(word)]: Date.now() });
  if (left.length - 1 <= 30) toast(`تبقّت ${left.length - 1} كلمة جديدة فقط`, 2500);
  return word;
}

async function startRound() {
  if (G.startingRound) return;
  G.startingRound = true;
  try {
    const prev = G.gs;
    const others = Object.keys(G.players || {}).filter((u) => G.players[u]);
    // take turns: whoever didn't draw last time draws now
    const drawer = prev ? (others.find((u) => u !== prev.drawer) || store.uid) : store.uid;
    const names = { ...(prev?.names || {}) };
    for (const u of others) names[u] = G.players[u].name;
    names[store.uid] = me.name;
    const word = await pickFreshWord();
    if (!word) { toast('لعبتما كل الكلمات! اطلب إضافة كلمات جديدة 🎉', 4000); return; }
    const game = {
      round: (prev?.round || 0) + 1, drawer, word, endsAt: Date.now() + ROUND_MS,
      solved: null, doneDrawing: false, scores: prev?.scores || {}, names,
    };
    G.clearSeq = (G.clearSeq || 0) + 1;
    wipeCanvas();
    await store.update(G.code, { game, strokes: null, ['meta/clearSeq']: G.clearSeq });
  } catch (e) {
    toast('خطأ: ' + e.message, 3000);
  } finally {
    G.startingRound = false;
  }
}

// The artist says "I'm done": drawing locks and the guesser gets at most 30 more seconds.
function finishDrawing() {
  const gs = G.gs;
  if (!roundLive() || !amDrawer() || gs.doneDrawing) return;
  closePanels();
  store.update(G.code, { game: { ...gs, doneDrawing: true, endsAt: Math.min(gs.endsAt, Date.now() + 30000) } }).catch(() => {});
}
$('doneDrawing').onclick = finishDrawing;

function endRound(solved) {
  const gs = G.gs;
  if (!gs || gs.solved) return;
  const scores = { ...(gs.scores || {}) };
  if (solved !== 'timeout') {
    scores[solved.uid] = (scores[solved.uid] || 0) + 2; // the one who guessed
    scores[gs.drawer] = (scores[gs.drawer] || 0) + 1;   // and the artist, for a drawing that worked
  }
  store.update(G.code, { game: { ...gs, solved, scores } }).catch(() => {});
}

function onGame(gs) {
  if (!G?.guessGame) return;
  const before = G.gs;
  G.gs = gs;
  if (gs && before?.round !== gs.round) {
    if (before) playPop();
    if (!amDrawer()) closePanels();
  }
  if (gs?.doneDrawing && !before?.doneDrawing && before?.round === gs.round && !amDrawer()) {
    toast('انتهى الرسم! خمّن الآن ⏳', 2500);
    playPop();
  }
  if (gs?.solved && !before?.solved && before?.round === gs.round) {
    if (gs.solved !== 'timeout') { playChime(); burstHearts(); } else playPop();
  }
  renderGuess();
}

function onGuess(id, g) {
  if (!G?.guessGame || !g) return;
  if (G.guesses.some((x) => x.id === id)) return;
  G.guesses.push({ id, ...g });
  if (g.uid !== store.uid && G.gs && g.round === G.gs.round && !g.ok) playPop();
  renderFeed();
}

function submitGuess(e) {
  e?.preventDefault();
  const inp = $('guessInput');
  const text = inp.value.trim();
  if (!text || !roundLive() || amDrawer()) return;
  inp.value = '';
  const ok = normAr(text) === normAr(G.gs.word);
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  store.update(G.code, { ['guesses/' + id]: { uid: store.uid, name: me.name, text, round: G.gs.round, ok, t: Date.now() } }).catch(() => {});
  if (ok) endRound({ uid: store.uid, name: me.name });
  else {
    const a = normAr(text), b = normAr(G.gs.word);
    if (b.length > 3 && editDistance(a, b) === 1) toast('قريب جدًا! 🔥', 1500);
  }
}
$('guessForm').onsubmit = submitGuess;

function tickGuess() {
  if (!G?.guessGame || !G.gs) return;
  const left = Math.max(0, G.gs.endsAt - Date.now());
  const t = $('guessTimer');
  t.textContent = arNum(Math.ceil(left / 1000));
  t.classList.toggle('hurry', left < 15000 && !G.gs.solved);
  // the drawer ends a timed-out round; the guesser steps in if the drawer has gone quiet
  if (!left && roundLive() && (amDrawer() || Date.now() - G.gs.endsAt > 3000)) endRound('timeout');
}

function wordHint(w) {
  return [...w].map((c) => (c === ' ' ? '　' : '●')).join(' ');
}

function renderGuess() {
  const gs = G.gs;
  const live = roundLive();
  const drawing = live && amDrawer();
  $('guessBanner').hidden = !gs;
  $('palette').hidden = !drawing || gs.doneDrawing;
  $('doneDrawing').hidden = !drawing || gs.doneDrawing;
  $('guessForm').hidden = !(live && !amDrawer());
  if (gs) {
    const drawerName = gs.names?.[gs.drawer] || 'شريكك';
    $('guessWho').textContent = !live ? 'انتهت الجولة'
      : drawing ? (gs.doneDrawing ? 'أنهيت الرسم، انتظر التخمين…' : 'ارسم الكلمة:')
      : gs.doneDrawing ? `أنهى ${drawerName} الرسم… خمّن!` : `دور ${drawerName} في الرسم… خمّن!`;
    $('guessWord').textContent = drawing || !live ? gs.word : wordHint(gs.word);
    $('guessWord').classList.toggle('hint', live && !drawing);
    $('guessLetters').textContent = live && !drawing ? `${arNum([...gs.word].filter((c) => c !== ' ').length)} أحرف` : '';
    $('guessScores').replaceChildren(...Object.entries(gs.names || {}).map(([u, n]) => {
      const s = document.createElement('span');
      s.className = 'gScore' + (u === gs.drawer && live ? ' drawing' : '');
      s.textContent = `${n} ${arNum(gs.scores?.[u] || 0)}`;
      return s;
    }));
  }
  // centre card: before the first round, or between rounds
  const card = $('guessCard');
  card.hidden = live;
  if (!live) {
    if (!gs) {
      $('gcEmoji').textContent = '🎨';
      $('gcTitle').textContent = 'رسم وقلع';
      $('gcText').textContent = 'أحدكما يرسم كلمة سرّية، والآخر يحاول أن يخمّنها قبل انتهاء الوقت. التخمين الصحيح يمنح نقطتين، والرسّام نقطة.';
    } else if (gs.solved === 'timeout') {
      $('gcEmoji').textContent = '⏰';
      $('gcTitle').textContent = 'انتهى الوقت!';
      $('gcText').textContent = `الكلمة كانت: «${gs.word}»`;
    } else {
      $('gcEmoji').textContent = '🎉';
      $('gcTitle').textContent = `أحسنت يا ${gs.solved.name}!`;
      $('gcText').textContent = `الكلمة كانت: «${gs.word}»`;
    }
    const others = Object.keys(G.players || {}).filter((u) => G.players[u] && u !== store.uid);
    const nextIsMe = !gs || !others.length || gs.drawer !== store.uid;
    $('gcStart').textContent = !gs ? 'ابدأ اللعب ✏️' : nextIsMe ? 'دوري في الرسم ✏️' : 'الجولة التالية ▶';
  }
  renderFeed();
  tickGuess();
}

function renderFeed() {
  const box = $('guessFeed');
  const round = G.gs?.round;
  const items = G.guesses.filter((g) => g.round === round).slice(-4);
  box.replaceChildren(...items.map((g) => {
    const b = document.createElement('div');
    b.className = 'gBubble' + (g.ok ? ' ok' : '') + (g.uid === store.uid ? ' mine' : '');
    b.textContent = g.ok ? `✓ ${g.name} خمّن الكلمة!` : `${g.name}: ${g.text}`;
    return b;
  }));
}

function burstHearts() {
  for (let i = 0; i < 14; i++) {
    const h = document.createElement('span');
    h.className = 'heartFx';
    h.textContent = ['💖', '💕', '✨', '🎉'][i % 4];
    h.style.left = 10 + Math.random() * 80 + '%';
    h.style.animationDelay = Math.random() * 0.4 + 's';
    document.body.append(h);
    setTimeout(() => h.remove(), 2200);
  }
}
$('gcStart').onclick = () => startRound();

// ---------- «من يعرف الآخر أكثر؟» (Love Quiz) ----------
// Each round one player (the subject) answers about themselves and the other guesses; roles swap
// every question. Round state lives in `game/`; answers are append-only under `guesses/`.
const QUIZ_LEN = 10;
const QUIZ_ROOM = 'HNQUIZ'; // remembers asked questions so they don't come back until all are used

const QUIZ_CATS_KEY = 'pt-quiz-cats';
const loadCats = () => readJSON(QUIZ_CATS_KEY, QUIZ_CATS.filter((c) => c.on).map((c) => c.id));

async function pickFreshQuestion(cats) {
  let used = {};
  try { used = (await store.loadRoom(QUIZ_ROOM))?.used || {}; } catch {}
  const pool = QUIZ.map((q, i) => (cats.includes(q.c) ? i : -1)).filter((i) => i >= 0);
  let left = pool.filter((i) => !used['q' + i]);
  if (!left.length) {
    const reset = {};
    for (const i of pool) reset['used/q' + i] = null; // start these categories over
    await store.update(QUIZ_ROOM, reset).catch(() => {});
    left = pool;
    toast('أنهيتما كل الأسئلة! نبدأ من جديد 💞', 2500);
  }
  const qi = left[Math.floor(Math.random() * left.length)];
  if (!store.online && !(await store.loadRoom(QUIZ_ROOM))) await store.createRoom(QUIZ_ROOM, { used: {} });
  await store.update(QUIZ_ROOM, { ['used/q' + qi]: Date.now() });
  return qi;
}

async function startQuizGame(code) {
  G = { kind: 'quiz', code, players: {}, holds: {}, qs: null, answers: [], shownRound: null };
  $('quizUI').hidden = false;
  $('palette').hidden = true;
  $('ghost').hidden = true;
  $('progress').textContent = 'شكون فينا كيعرف لاخر كثر؟';
  renderQuiz();
  G.unsub = store.subscribe(code, {
    onGroup() {}, onPiece() {}, onHolds() {}, onPlayers,
    onGame: (qs) => onQuizState(qs),
    onGuess: (id, a) => onQuizAnswer(id, a),
  });
  store.join(code, { name: me.name, color: me.color }).catch(() => {});
}

const quizOthers = () => Object.keys(G.players || {}).filter((u) => G.players[u] && u !== store.uid);
const ansFor = (qs, uid) => G.answers.find((a) => a.game === qs.game && a.round === qs.round && a.uid === uid);
const otherAns = (qs) => G.answers.find((a) => a.game === qs.game && a.round === qs.round && a.uid !== qs.subject);

async function nextQuizRound() {
  if (G.busy) return;
  G.busy = true;
  try {
    const prev = G.qs;
    if (prev && !prev.finished && prev.round >= prev.total && prev.revealed) {
      await store.update(G.code, { game: { ...prev, finished: true } });
      return;
    }
    const newGame = !prev || prev.finished;
    const names = { ...(prev?.names || {}) };
    for (const u of quizOthers()) names[u] = G.players[u].name;
    names[store.uid] = me.name;
    const cats = newGame ? loadCats() : prev.cats || loadCats();
    if (!cats.length) { toast('اختر فئة واحدة على الأقل', 2500); return; }
    const qi = await pickFreshQuestion(cats);
    // roles swap every question; a new game starts with whoever pressed the button
    const subject = newGame ? store.uid : (prev.subject === store.uid ? (quizOthers()[0] || store.uid) : store.uid);
    const base = newGame
      ? { game: (prev?.game || 0) + 1, round: 1, total: QUIZ_LEN, scores: {}, asked: {} }
      : { ...prev, round: prev.round + 1 };
    const qs = { ...base, qi, subject, names, cats, revealed: false, finished: false, lastMatch: null };
    qs.asked = { ...(qs.asked || {}), [subject]: ((qs.asked || {})[subject] || 0) + 1 }; // questions asked ABOUT this person
    await store.update(G.code, { game: qs });
  } catch (e) {
    toast('خطأ: ' + e.message, 3000);
  } finally {
    G.busy = false;
  }
}

function answerQuiz(choice) {
  const qs = G.qs;
  if (!qs || qs.revealed || ansFor(qs, store.uid)) return;
  const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const a = { uid: store.uid, game: qs.game, round: qs.round, choice };
  onQuizAnswer(id, a); // show the pick immediately; the store's echo is de-duplicated by id
  store.update(G.code, { ['guesses/' + id]: a }).catch(() => {});
  playPop();
}

function onQuizState(qs) {
  if (G?.kind !== 'quiz') return;
  const before = G.qs;
  G.qs = qs;
  const newlyRevealed = qs?.revealed && before && !(before.revealed && before.round === qs.round && before.game === qs.game);
  if (newlyRevealed) { if (qs.lastMatch) { playChime(); burstHearts(); } else playPop(); }
  if (qs?.finished && before && !before.finished) burstHearts();
  renderQuiz();
  maybeReveal();
}

function onQuizAnswer(id, a) {
  if (G?.kind !== 'quiz' || !a || G.answers.some((x) => x.id === id)) return;
  G.answers.push({ id, ...a });
  renderQuiz();
  maybeReveal();
}

// Both answers in → the subject's phone scores it (one writer, so points never double-count).
function maybeReveal() {
  const qs = G.qs;
  if (!qs || qs.revealed || qs.subject !== store.uid) return;
  const mine = ansFor(qs, qs.subject);
  const theirs = otherAns(qs);
  if (!mine || !theirs) return;
  const match = mine.choice === theirs.choice;
  const scores = { ...(qs.scores || {}) };
  if (match) scores[theirs.uid] = (scores[theirs.uid] || 0) + 1; // the point goes to whoever guessed right
  store.update(G.code, { game: { ...qs, revealed: true, lastMatch: match, scores } }).catch(() => {});
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderQuiz() {
  const box = $('quizStage');
  const qs = G.qs;
  const nm = (u) => qs?.names?.[u] || G.players?.[u]?.name || 'شريكك';
  box.replaceChildren();

  if (!qs || qs.finished) {
    const card = el('div', 'qPanel deal');
    if (!qs) {
      const img = el('img', 'qCover');
      img.src = 'games/quiz.jpg';
      img.alt = '';
      card.append(img, el('h2', null, 'شكون فينا كيعرف لاخر كثر؟'),
        el('p', null, `${QUIZ_LEN} أسئلة. في كل سؤال يجيب أحدكما عن نفسه، ويخمّن الآخر إجابته. كل تخمين صحيح بنقطة!`));
    } else {
      const ids = Object.keys(qs.names);
      card.append(el('div', 'qBig', '🏆'), el('h2', null, 'النتيجة النهائية'));
      const rows = el('div', 'qScores');
      for (const u of ids) {
        const other = ids.find((x) => x !== u);
        const row = el('div', 'qScoreRow');
        row.append(el('b', null, nm(u)), el('span', null, `${qs.scores?.[u] || 0} / ${other ? qs.asked?.[other] || 0 : 0}`));
        rows.append(row);
      }
      card.append(rows);
      const [a, b] = ids;
      const sa = qs.scores?.[a] || 0, sb = qs.scores?.[b] || 0;
      if (b) card.append(el('p', null, sa === sb ? 'تعادل! كلاكما يعرف الآخر جيدًا 💞' : `الفائز: ${nm(sa > sb ? a : b)} 🎉`));
    }
    card.append(el('small', 'qCatsTitle', 'اختر الفئات:'));
    const chips = el('div', 'qCats');
    const chosen = loadCats();
    for (const c of QUIZ_CATS) {
      const n = QUIZ.filter((q) => q.c === c.id).length;
      const chip = el('button', 'qChip' + (chosen.includes(c.id) ? ' on' : '') + (c.id === 'intimate' ? ' adult' : ''), `${c.label} · ${n}`);
      chip.onclick = () => {
        const cur = loadCats();
        writeJSON(QUIZ_CATS_KEY, cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]);
        renderQuiz();
      };
      chips.append(chip);
    }
    card.append(chips);
    const btn = el('button', 'primary', !qs ? 'ابدأ اللعب 💞' : 'لعبة جديدة 🔄');
    btn.onclick = nextQuizRound;
    card.append(btn);
    if (!quizOthers().length) card.append(el('small', 'qWait', 'أرسل رمز الغرفة لشريكك من زر 💌'));
    box.append(card);
    return;
  }

  const q = QUIZ[qs.qi];
  const iAmSubject = qs.subject === store.uid;
  const myAns = ansFor(qs, store.uid);
  const subjAns = ansFor(qs, qs.subject);
  const guessAns = otherAns(qs);
  const key = `${qs.game}:${qs.round}`;
  const freshRound = G.shownRound !== key;
  G.shownRound = key;

  const top = el('div', 'qTop');
  top.append(el('span', 'qPill', `السؤال ${qs.round} من ${qs.total}`));
  top.append(el('span', 'qPill', Object.keys(qs.names).map((u) => `${nm(u)} ${qs.scores?.[u] || 0}`).join('  ·  ')));
  box.append(top);

  const card = el('div', 'qCard' + (freshRound ? ' flipIn' : ''));
  const face = el('div', 'qFace');
  face.append(el('small', 'qCatTag', QUIZ_CATS.find((c) => c.id === q.c)?.label || ''));
  face.append(el('span', 'qRole', iAmSubject ? 'أجب عن نفسك 💭' : `خمّن إجابة ${nm(qs.subject)} 🔮`));
  face.append(el('h2', 'qText', iAmSubject ? q.me : q.them.replace('{n}', nm(qs.subject))));
  card.append(face, el('div', 'qBack'));
  box.append(card);

  const grid = el('div', 'qOptions');
  q.o.forEach((text, i) => {
    const b = el('button', 'qOpt' + (freshRound ? ' dealIn' : ''));
    b.style.setProperty('--i', i);
    b.append(el('span', 'qOptText', text));
    if (qs.revealed) {
      b.classList.add('reveal');
      if (subjAns?.choice === i) { b.classList.add('truth'); b.append(el('small', 'qTag', `✔ إجابة ${nm(qs.subject)}`)); }
      if (guessAns?.choice === i) {
        b.classList.add(subjAns?.choice === i ? 'hit' : 'miss');
        b.append(el('small', 'qTag', `🔮 تخمين ${nm(guessAns.uid)}`));
      }
    } else if (myAns) {
      b.classList.add(myAns.choice === i ? 'picked' : 'dim');
    }
    b.disabled = !!myAns || qs.revealed;
    b.onclick = () => answerQuiz(i);
    grid.append(b);
  });
  box.append(grid);

  const foot = el('div', 'qFoot');
  if (qs.revealed) {
    foot.append(el('div', 'qResult ' + (qs.lastMatch ? 'yes' : 'no'),
      qs.lastMatch ? `🎉 أصاب ${nm(guessAns?.uid)}!` : '😅 ليس هذه المرّة'));
    const btn = el('button', 'primary', qs.round >= qs.total ? 'النتيجة النهائية 🏆' : 'السؤال التالي ←');
    btn.onclick = nextQuizRound;
    foot.append(btn);
  } else if (myAns) {
    const waitFor = iAmSubject ? quizOthers()[0] : qs.subject;
    foot.append(el('div', 'qWait', waitFor ? `بانتظار ${nm(waitFor)}… ⏳` : 'بانتظار شريكك… ⏳'));
  }
  box.append(foot);
}

// ---------- «حقيقة أم تحدٍّ» (Truth or Dare) ----------
// State in `game/`: phase spin → pick → card → result, then the turn passes. Emoji reactions are
// append-only under `guesses/`. The bottle points down at "me" and up at the partner on each phone.
const TOD_ROOM = 'HNTODX'; // remembers used truths/dares so none repeats until a category runs out
const TOD_CATS_KEY = 'pt-tod-cats';
const SPIN_MS = 3200;
const DRUM_MS = 1100;
const loadTodCats = () => readJSON(TOD_CATS_KEY, TOD_CATS.filter((c) => c.on).map((c) => c.id));
const todOthers = () => Object.keys(G.players || {}).filter((u) => G.players[u] && u !== store.uid);

// New truths/dares arrive weekly in tod-extra.json on the live site (fetched from there even inside
// the APK, so no rebuild is needed). Merged once per session, de-duplicated by id.
const TOD_EXTRA_URL = 'https://nourddine90-lab.github.io/puzzle-together/tod-extra.json';
let todAll = TOD;
async function loadTodExtras() {
  for (const url of [TOD_EXTRA_URL + '?v=' + Date.now(), 'tod-extra.json']) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const extra = await r.json();
      const seen = new Set(TOD.map((x) => x.id));
      const add = extra.filter((x) => x?.t && x.kind && x.c).map((x) => ({ ...x, id: todId(x.kind, x.t) })).filter((x) => !seen.has(x.id) && seen.add(x.id));
      todAll = [...TOD, ...add];
      return;
    } catch {}
  }
}
const todExtrasReady = loadTodExtras();

// Never repeats: a played item is remembered forever. When a pool is empty, wait for next week's batch.
async function pickFreshTod(kind, cats) {
  await todExtrasReady;
  let used = {};
  try { used = (await store.loadRoom(TOD_ROOM))?.used || {}; } catch {}
  const left = todAll.filter((x) => x.kind === kind && cats.includes(x.c) && !used['u' + x.id]);
  if (!left.length) return null;
  const item = left[Math.floor(Math.random() * left.length)];
  if (!store.online && !(await store.loadRoom(TOD_ROOM))) await store.createRoom(TOD_ROOM, { used: {} });
  await store.update(TOD_ROOM, { ['used/u' + item.id]: Date.now() });
  if (left.length <= 5) toast(`تبقّى ${left.length - 1} فقط في هذه الفئات، الجديد يصل كل أسبوع ✨`, 3000);
  return { kind: item.kind, c: item.c, t: item.t };
}

function startTodGame(code) {
  G = { kind: 'tod', code, players: {}, holds: {}, ts: null, seen: new Set(), lastKey: null, timers: [] };
  $('todUI').hidden = false;
  $('palette').hidden = true;
  $('ghost').hidden = true;
  $('progress').textContent = 'الصراحة ولا التحدي';
  renderTod();
  todExtrasReady.then(() => { if (G?.kind === 'tod' && !G.ts) renderTod(); }); // refresh the counts
  G.unsub = store.subscribe(code, {
    onGroup() {}, onPiece() {}, onHolds() {}, onPlayers,
    onGame: (ts) => onTodState(ts),
    onGuess: (id, r) => onTodReaction(id, r),
  });
  store.join(code, { name: me.name, color: me.color }).catch(() => {});
}

function todNames(prev) {
  const names = { ...(prev?.names || {}) };
  for (const u of todOthers()) names[u] = G.players[u].name;
  names[store.uid] = me.name;
  return names;
}

function spinBottle() {
  const prev = G.ts;
  const cats = prev?.cats || loadTodCats();
  if (!cats.length) { toast('اختر فئة واحدة على الأقل', 2500); return; }
  const names = todNames(prev);
  // two players → the 8 slots alternate their names; alone, the other slots wait for the partner
  const ids = Object.keys(names).sort().slice(0, 2);
  if (ids.length < 2) ids.push('');
  const slot = Math.floor(Math.random() * TOD_SLOTS);
  const ts = {
    round: (prev?.round || 0) + 1, phase: 'spin', slot, ids, turn: ids[slot % 2] || null, spinAt: Date.now(),
    turns: 4 + Math.floor(Math.random() * 3), wobble: Math.round(Math.random() * 16 - 8), names, hearts: prev?.hearts || {}, cats,
  };
  store.update(G.code, { game: ts }).catch((e) => toast('خطأ: ' + e.message, 3000));
}

async function chooseTod(kind) {
  const ts = G.ts;
  if (!ts || ts.turn !== store.uid || G.picking) return;
  G.picking = true;
  try {
    const item = await pickFreshTod(kind, ts.cats || loadTodCats());
    if (!item) { toast(kind === 'truth' ? 'لعبتما كل الحقائق في هذه الفئات! جرّبا «تحدٍّ» أو فئة أخرى، والجديد يصل الأسبوع القادم ✨' : 'لعبتما كل التحدّيات في هذه الفئات! جرّبا «حقيقة» أو فئة أخرى، والجديد يصل الأسبوع القادم ✨', 4500); return; }
    await store.update(G.code, { game: { ...ts, phase: 'card', kind, item, cardAt: Date.now() } });
  } catch (e) {
    toast('خطأ: ' + e.message, 3000);
  } finally {
    G.picking = false;
  }
}

function finishTod(outcome) {
  const ts = G.ts;
  if (!ts || ts.phase !== 'card') return;
  const hearts = { ...(ts.hearts || {}) };
  if (outcome === 'done') hearts[ts.turn] = (hearts[ts.turn] || 0) + 1;
  store.update(G.code, { game: { ...ts, phase: 'result', outcome, hearts } }).catch(() => {});
}

function nextTodTurn() {
  const ts = G.ts;
  const other = Object.keys(ts.names).find((u) => u !== ts.turn) || store.uid;
    const ids = ts.ids || Object.keys(ts.names).sort();
  // keep the bottle pointing at a tag of whoever's turn it is now
  const slot = ids.indexOf(other) >= 0 ? ids.indexOf(other) : 0;
  store.update(G.code, {
    game: { ...ts, round: ts.round + 1, phase: 'pick', turn: other, slot, turns: 0, wobble: 0, names: todNames(ts), kind: null, item: null, outcome: null },
  }).catch(() => {});
}

function sendReaction(emoji) {
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  store.update(G.code, { ['guesses/' + id]: { uid: store.uid, emoji, t: Date.now() } }).catch(() => {});
}

function onTodReaction(id, r) {
  if (G?.kind !== 'tod' || !r?.emoji || G.seen.has(id)) return;
  G.seen.add(id);
  if (Date.now() - r.t > 6000) return; // old reactions from before we joined: don't replay
  playPop();
  for (let i = 0; i < 6; i++) {
    const f = el('span', 'todFloat', r.emoji);
    f.style.left = (r.uid === store.uid ? 55 : 15) + Math.random() * 30 + '%';
    f.style.animationDelay = i * 0.08 + 's';
    f.style.fontSize = 28 + Math.random() * 18 + 'px';
    document.body.append(f);
    setTimeout(() => f.remove(), 2600);
  }
}

function confetti() {
  const colors = ['#ff6fa5', '#a66bff', '#5ba8ff', '#ffd166', '#06d6a0'];
  for (let i = 0; i < 70; i++) {
    const c = el('span', 'confetti');
    c.style.left = Math.random() * 100 + '%';
    c.style.background = colors[i % colors.length];
    c.style.setProperty('--dx', Math.random() * 200 - 100 + 'px');
    c.style.setProperty('--rot', Math.random() * 720 - 360 + 'deg');
    c.style.animationDelay = Math.random() * 0.3 + 's';
    c.style.animationDuration = 1.6 + Math.random() * 1.2 + 's';
    document.body.append(c);
    setTimeout(() => c.remove(), 3400);
  }
}

function onTodState(ts) {
  if (G?.kind !== 'tod') return;
  const before = G.ts;
  G.ts = ts;
  const key = ts ? `${ts.round}:${ts.phase}` : null;
  const changed = key !== G.lastKey;
  G.lastKey = key;
  if (changed && ts && before) {
    if (ts.phase === 'spin') playSfx('spin');
    if (ts.phase === 'card') playSfx('drumroll', 0.7);
    if (ts.phase === 'result') {
      if (ts.outcome === 'done') { playSfx('cheer'); confetti(); burstHearts(); } else playSfx('fail');
    }
    if (ts.phase === 'pick' && ts.turn === store.uid) toast('دورك! 🎯', 1500);
  }
  renderTod();
}

const TOD_SLOTS = 8;
const seatAngle = (ts) => ts.turns * 360 + (ts.slot ?? 0) * (360 / TOD_SLOTS) + ts.wobble;

// Name tags around the table, the same on both phones (slot 0 at the top, clockwise).
function nameRing(ts, nm, lit) {
  const ids = ts.ids || Object.keys(ts.names).sort();
  return Array.from({ length: TOD_SLOTS }, (_, i) => {
    const u = ids[i % 2];
    const a = (i * 360 / TOD_SLOTS) * Math.PI / 180;
    const tag = el('div', 'todSlot' + (u === store.uid ? ' me' : '') + (lit && i === ts.slot ? ' lit' : ''), u ? nm(u) : 'شريكك');
    tag.style.left = 50 + 50 * Math.sin(a) + '%';
    tag.style.top = 50 - 50 * Math.cos(a) + '%';
    return tag;
  });
}

function renderTod() {
  G.timers.forEach(clearTimeout);
  G.timers = [];
  const box = $('todStage');
  const ts = G.ts;
  const nm = (u) => ts?.names?.[u] || G.players?.[u]?.name || 'شريكك';
  box.replaceChildren();

  if (!ts) {
    const card = el('div', 'qPanel deal');
    const img = el('img', 'qCover');
    img.src = 'games/tod.jpg';
    img.alt = '';
    card.append(img, el('h2', null, 'الصراحة ولا التحدي'),
      el('p', null, 'لفّا القارورة! من تشير إليه يختار: حقيقة يجيب عنها بصدق، أو تحدٍّ ينفّذه. كل مهمّة تُنجز = ❤️'));
    card.append(el('small', 'qCatsTitle', 'اختر الفئات:'));
    const chips = el('div', 'qCats');
    const chosen = loadTodCats();
    for (const c of TOD_CATS) {
      const n = todAll.filter((x) => x.c === c.id).length;
      const chip = el('button', 'qChip' + (chosen.includes(c.id) ? ' on' : '') + (c.id === 'spicy' ? ' adult' : ''), `${c.label} · ${n}`);
      chip.onclick = () => {
        const cur = loadTodCats();
        writeJSON(TOD_CATS_KEY, cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]);
        renderTod();
      };
      chips.append(chip);
    }
    card.append(chips);
    const btn = el('button', 'primary', 'لفّ القارورة 🍾');
    btn.onclick = spinBottle;
    card.append(btn);
    if (!todOthers().length) card.append(el('small', 'qWait', 'أرسل رمز الغرفة لشريكك من زر 💌'));
    box.append(card);
    return;
  }

  // scoreboard
  const top = el('div', 'qTop');
  top.append(el('span', 'qPill', `الجولة ${ts.round}`));
  top.append(el('span', 'qPill', Object.keys(ts.names).map((u) => `${nm(u)} ❤️ ${ts.hearts?.[u] || 0}`).join('  ·  ')));
  box.append(top);

  const myTurn = ts.turn === store.uid;
  const spinning = ts.phase === 'spin' && Date.now() - ts.spinAt < SPIN_MS;

  if (ts.phase === 'spin' || ts.phase === 'pick') {
    const table = el('div', 'todTable');
    const ring = ts.phase === 'spin' ? nameRing(ts, nm, !spinning) : [];
    const bottle = el('img', 'todBottle');
    bottle.src = 'games/bottle.png';
    bottle.alt = '';
    const end = seatAngle(ts);
    if (spinning) {
      const elapsed = Date.now() - ts.spinAt;
      bottle.style.transform = 'rotate(0deg)';
      table.append(...ring, bottle);
      box.append(table);
      requestAnimationFrame(() => {
        bottle.style.transition = `transform ${Math.max(200, SPIN_MS - elapsed)}ms cubic-bezier(.12, .7, .15, 1)`;
        bottle.style.transform = `rotate(${end}deg)`;
      });
      box.append(el('div', 'todHint', 'القارورة تدور… 🍾'));
      G.timers.push(setTimeout(() => {
        if (G?.ts === ts) { if (ts.turn === store.uid) toast('دورك! 🎯', 1500); renderTod(); }
      }, SPIN_MS - elapsed + 50));
      return;
    }
    bottle.style.transform = `rotate(${end % 360}deg)`;
    table.append(...(ring.length ? ring : nameRing({ ...ts, slot: ts.slot ?? 0 }, nm, true)), bottle);
    box.append(table);

    if (!ts.turn) {
      box.append(el('div', 'todHint big', 'وقعت على شريكك! أرسل له الرمز من 💌'));
    } else if (myTurn) {
      box.append(el('div', 'todHint big', 'دورك! اختر 👇'));
      const pick = el('div', 'todPick');
      for (const [kind, label, img] of [['truth', 'حقيقة', 'games/truth.jpg'], ['dare', 'تحدٍّ', 'games/dare.jpg']]) {
        const b = el('button', 'todChoice ' + kind);
        b.style.backgroundImage = `url(${img})`;
        b.append(el('span', null, label));
        b.onclick = () => chooseTod(kind);
        pick.append(b);
      }
      box.append(pick);
    } else {
      box.append(el('div', 'todHint big', `بانتظار اختيار ${nm(ts.turn)} ⏳`));
    }
    const again = el('button', 'todLink', '🍾 لفّ القارورة من جديد');
    again.onclick = spinBottle;
    box.append(again);
    return;
  }

  // card / result
  const item = ts.item;
  if (!item) { // a round saved by an older version: just move on
    const next = el('button', 'primary', 'الدور التالي ←');
    next.onclick = nextTodTurn;
    box.append(next);
    return;
  }
  const drumming = ts.phase === 'card' && Date.now() - ts.cardAt < DRUM_MS;
  const card = el('div', 'todCard ' + item.kind + (drumming ? ' shaking' : ' flipped'));
  const back = el('div', 'todCardBack');
  back.style.backgroundImage = `url(games/${item.kind}.jpg)`;
  back.append(el('span', null, item.kind === 'truth' ? 'حقيقة' : 'تحدٍّ'));
  const face = el('div', 'todCardFace');
  face.append(el('small', 'todKind', `${item.kind === 'truth' ? '💗 حقيقة' : '⚡ تحدٍّ'} · ${TOD_CATS.find((c) => c.id === item.c)?.label || ''}`));
  face.append(el('h2', 'todText', item.t.replaceAll('{n}', nm(Object.keys(ts.names).find((u) => u !== ts.turn) || ''))));
  face.append(el('small', 'todWho', `🎯 ${nm(ts.turn)}`));
  card.append(back, face);
  box.append(card);
  if (drumming) {
    G.timers.push(setTimeout(() => { if (G?.ts === ts) { playSfx('flip'); renderTod(); } }, DRUM_MS - (Date.now() - ts.cardAt)));
    return;
  }

  if (ts.phase === 'card') {
    if (myTurn) {
      const row = el('div', 'todActions');
      const done = el('button', 'todDone', '✓ تمّ!');
      done.onclick = () => finishTod('done');
      const skip = el('button', 'todSkip', '😅 تخطٍّ');
      skip.onclick = () => finishTod('skip');
      row.append(skip, done);
      box.append(row);
    } else {
      box.append(el('div', 'todHint', `حان دور ${nm(ts.turn)}… التشجيع مسموح! 👇`));
    }
  } else {
    box.append(el('div', 'qResult ' + (ts.outcome === 'done' ? 'yes' : 'no'),
      ts.outcome === 'done' ? `🎉 برافو يا ${nm(ts.turn)}! +❤️` : '😅 تمّ التخطّي هذه المرّة'));
    const next = el('button', 'primary', 'الدور التالي ←');
    next.onclick = nextTodTurn;
    box.append(next);
  }

  const reacts = el('div', 'todReacts');
  for (const e of ['😂', '😍', '🔥', '😳', '👏', '❤️']) {
    const b = el('button', null, e);
    b.onclick = () => sendReaction(e);
    reacts.append(b);
  }
  box.append(reacts);
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
  const text = G.kind === 'tod' ? `تعال نلعب «حقيقة أم تحدٍّ» 🍾 الرمز: ${G.code}`
    : G.kind === 'quiz' ? `تعال نلعب «من يعرف الآخر أكثر؟» 💞 الرمز: ${G.code}`
    : G.guessGame ? `تعال نلعب «ارسم وخمّن» 🎨 الرمز: ${G.code}`
    : G.kind === 'color' ? `تعال نلوّن معًا 🎨 الرمز: ${G.code}` : `تعال نركّب الأحجية 🧩 الرمز: ${G.code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Hajour Together', text, url });
    else { await navigator.clipboard.writeText(`${text}\n${url}`); toast('تمّ نسخ رابط الدعوة'); }
  } catch {}
};
addEventListener('resize', () => G?.stage?.size({ width: innerWidth, height: innerHeight }));
document.addEventListener('pointerdown', unlockAudio, { once: true });

// ---------- start ----------
async function boot() {
  try {
    store = await createStore();
  } catch (e) {
    console.error(e);
    store = await createStore(true);
    $('mode').textContent = '⚠️ تعذّر الاتصال (' + e.message + '). وضع بلا اتصال.';
  }
  if (!$('mode').textContent) {
    $('mode').textContent = store.online ? '🟢 متّصل — العبا معًا' : '🟡 وضع تجريبي بلا اتصال (هذا الجهاز فقط)';
  }
  renderCounts();
  renderList();
  if (!me) await askName();
  $('who').textContent = `أهلًا ${me.name} 💕  (اضغط للتغيير)`;
  const code = new URLSearchParams(location.search).get('room');
  if (code) openRoom(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (location.hostname === 'localhost') { window.__pt = () => G; window.__store = () => store; } // debugging only
boot();

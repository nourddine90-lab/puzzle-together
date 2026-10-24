// Network first, cache as fallback, so updates show up right away but the app still opens offline.
const CACHE = 'pt-v10';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'store.js', 'sound.js', 'firebase-config.js',
  'manifest.webmanifest', 'konva.min.js', 'icon-192.png', 'icon-512.png', 'words.js',
  'games/puzzle.jpg', 'games/color.jpg', 'games/guess.jpg', 'games/quiz.jpg', 'games/cardback.jpg', 'quiz.js',
  'tod.js', 'tod-extra.json', 'games/tod.jpg', 'games/truth.jpg', 'games/dare.jpg', 'games/bottle.png', 'games/table.jpg',
  'sfx/spin.mp3', 'sfx/flip.mp3', 'sfx/cheer.mp3', 'sfx/drumroll.mp3', 'sfx/fail.mp3',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

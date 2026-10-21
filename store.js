// Two backends with the same API:
//   Firebase Realtime Database (online, shared between phones)
//   localStorage (offline test mode; syncs between tabs of one browser)
//
// Patch keys are always "<kind>/<id>" (e.g. "groups/g12", "pieces/40").
import { firebaseConfig } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';

export async function createStore(forceLocal = false) {
  if (!forceLocal && firebaseConfig?.apiKey) return firebaseStore(firebaseConfig);
  return localStore();
}

async function firebaseStore(cfg) {
  const [{ initializeApp }, A, D] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-database.js`),
  ]);
  const app = initializeApp(cfg);
  const cred = await A.signInAnonymously(A.getAuth(app));
  const db = D.getDatabase(app);
  const uid = cred.user.uid;
  const ref = (code, path = '') => D.ref(db, `rooms/${code}${path ? '/' + path : ''}`);

  return {
    online: true,
    uid,
    async createRoom(code, data) { await D.set(ref(code), data); },
    async loadRoom(code) {
      const s = await D.get(ref(code));
      return s.exists() ? s.val() : null;
    },
    update(code, patch) { return D.update(ref(code), patch); },
    subscribe(code, h) {
      const g = ref(code, 'groups');
      const offs = [
        D.onChildAdded(g, (s) => h.onGroup(s.key, s.val())),
        D.onChildChanged(g, (s) => h.onGroup(s.key, s.val())),
        D.onChildRemoved(g, (s) => h.onGroup(s.key, null)),
        D.onChildChanged(ref(code, 'pieces'), (s) => h.onPiece(+s.key, s.val())),
        D.onValue(ref(code, 'players'), (s) => h.onPlayers(s.val() || {})),
        D.onValue(ref(code, 'holds'), (s) => h.onHolds(s.val() || {})),
      ];
      // Coloring game only: both players painting the same picture or page at once.
      if (h.onRegion) {
        const r = ref(code, 'regions');
        offs.push(
          D.onChildAdded(r, (s) => h.onRegion(s.key, s.val())),
          D.onChildChanged(r, (s) => h.onRegion(s.key, s.val())),
        );
      }
      if (h.onStroke) {
        const st = ref(code, 'strokes');
        offs.push(
          D.onChildAdded(st, (s) => h.onStroke(s.key, s.val())),
          D.onChildChanged(st, (s) => h.onStroke(s.key, s.val())),
        );
      }
      if (h.onClear) offs.push(D.onValue(ref(code, 'meta/clearSeq'), (s) => h.onClear(s.val() || 0)));
      return () => offs.forEach((off) => off());
    },
    async join(code, me) {
      const p = ref(code, 'players/' + uid);
      await D.onDisconnect(p).remove();
      await D.set(p, me);
    },
    leave(code) { D.remove(ref(code, 'players/' + uid)); },
    hold(code, gid, me) {
      const p = ref(code, 'holds/' + gid);
      if (me) { D.onDisconnect(p).remove(); D.set(p, me); }
      else { D.onDisconnect(p).cancel(); D.remove(p); }
    },
  };
}

function localStore() {
  let uid = localStorage.getItem('pt-uid');
  if (!uid) { uid = 'u' + Math.random().toString(36).slice(2, 10); localStorage.setItem('pt-uid', uid); }
  const key = (code) => 'pt-room-' + code;
  const read = (code) => { try { return JSON.parse(localStorage.getItem(key(code))); } catch { return null; } };
  const write = (code, d) => localStorage.setItem(key(code), JSON.stringify(d));
  const subs = new Map();
  let me = null;

  const emit = (code, patch) => {
    const h = subs.get(code);
    if (!h) return;
    for (const [k, v] of Object.entries(patch)) {
      const [kind, id] = k.split('/');
      if (kind === 'groups') h.onGroup(id, v);
      else if (kind === 'pieces') h.onPiece(+id, v);
      else if (kind === 'regions' && h.onRegion) h.onRegion(id, v);
      else if (kind === 'strokes' && h.onStroke) h.onStroke(id, v);
      else if (kind === 'meta' && id === 'clearSeq' && h.onClear) h.onClear(v);
    }
  };
  const bc = 'BroadcastChannel' in self ? new BroadcastChannel('puzzle-together') : null;
  if (bc) bc.onmessage = (e) => emit(e.data.code, e.data.patch);

  return {
    online: false,
    uid,
    async createRoom(code, data) { write(code, data); },
    async loadRoom(code) { return read(code); },
    async update(code, patch) {
      const d = read(code);
      if (!d) return;
      for (const [k, v] of Object.entries(patch)) {
        const [kind, id] = k.split('/');
        d[kind] ??= {};
        if (v === null) delete d[kind][id];
        else d[kind][id] = v;
      }
      write(code, d);
      bc?.postMessage({ code, patch });
    },
    subscribe(code, h) {
      subs.set(code, h);
      h.onPlayers({ [uid]: me });
      return () => subs.delete(code);
    },
    async join(code, m) { me = m; },
    leave() {},
    hold() {},
  };
}

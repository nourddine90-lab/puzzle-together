// Three real recorded sounds (ElevenLabs), each preloaded into a small pool of <audio>
// elements so two triggers close together don't cut each other off.
const FILES = {
  snap: 'sfx/snap.mp3', pop: 'sfx/pop.mp3', chime: 'sfx/chime.mp3',
  spin: 'sfx/spin.mp3', flip: 'sfx/flip.mp3', cheer: 'sfx/cheer.mp3', drumroll: 'sfx/drumroll.mp3', fail: 'sfx/fail.mp3',
};
const POOL_SIZE = 4;

let pools = null;

function makePool(src) {
  const els = Array.from({ length: POOL_SIZE }, () => {
    const a = new Audio(src);
    a.preload = 'auto';
    return a;
  });
  let i = 0;
  return (volume) => {
    i = (i + 1) % els.length;
    const a = els[i];
    a.currentTime = 0;
    a.volume = volume;
    a.play().catch(() => {});
  };
}

// Call on the first user gesture: creates the pools and "arms" each element so later,
// gesture-free play() calls (e.g. from a remote event) aren't blocked by autoplay rules.
export function unlockAudio() {
  if (pools) return;
  pools = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, makePool(f)]));
  for (const name of Object.values(FILES)) {
    const a = new Audio(name);
    a.volume = 0;
    a.play().then(() => a.pause()).catch(() => {});
  }
}

// Puzzle piece clicking into place. soft = partner's snap, played at lower volume.
export function playSnap(soft = false) {
  unlockAudio();
  pools?.snap(soft ? 0.45 : 0.9);
  navigator.vibrate?.(soft ? 6 : 12);
}

// A coloring-book region getting filled.
export function playPop() {
  unlockAudio();
  pools?.pop(0.85);
  navigator.vibrate?.(8);
}

// Any named effect from FILES (Truth or Dare uses spin/flip/cheer/drumroll/fail).
export function playSfx(name, volume = 0.9) {
  unlockAudio();
  pools?.[name]?.(volume);
}

// Puzzle finished.
export function playChime() {
  unlockAudio();
  pools?.chime(1);
  navigator.vibrate?.([30, 60, 30, 60, 80]);
}

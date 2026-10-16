// Sounds are synthesized with WebAudio, so there are no audio files to load.
let ac = null;

export function unlockAudio() {
  try {
    ac ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch {}
}

// Wooden "click" when two pieces lock together. soft = partner's snap.
export function click(soft = false) {
  unlockAudio();
  if (!ac) return;
  const t = ac.currentTime;

  const len = 0.045;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * len), ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 6);
  const noise = ac.createBufferSource();
  noise.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1.1;
  const ng = ac.createGain();
  ng.gain.value = soft ? 0.35 : 0.9;
  noise.connect(bp).connect(ng).connect(ac.destination);
  noise.start(t);

  const o = ac.createOscillator();
  const og = ac.createGain();
  o.frequency.setValueAtTime(240, t);
  o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
  og.gain.setValueAtTime(soft ? 0.12 : 0.35, t);
  og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  o.connect(og).connect(ac.destination);
  o.start(t); o.stop(t + 0.09);

  if (!soft) navigator.vibrate?.(12);
}

// Little arpeggio when the puzzle is complete.
export function chime() {
  unlockAudio();
  if (!ac) return;
  const t = ac.currentTime;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + i * 0.12);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.6);
    o.connect(g).connect(ac.destination);
    o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.65);
  });
  navigator.vibrate?.([30, 60, 30, 60, 80]);
}

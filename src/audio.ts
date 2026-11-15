// Tiny Web Audio sound effects: no asset files, no licensing. The context starts on the first user gesture.
// The music for an open memory is made from its photo in music.ts.
let ctx: AudioContext | undefined;
export const ac = () => { ctx ??= new AudioContext(); if (ctx.state === 'suspended') void ctx.resume(); return ctx; };

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.15, delay = 0, slideTo = freq) {
  try {
    const c = ac(), t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur);
  } catch {} // audio is optional
}

const note = (n: number) => 261.63 * 2 ** (n / 12); // C4 + n semitones

/** A short burst of paper noise (tearing). */
function tearNoise() {
  try {
    const c = ac(), len = Math.floor(c.sampleRate * 0.35), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 1 : 0.35) * (1 - i / len); // crackly, fading
    const src = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
    src.buffer = buf; bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.8; g.gain.value = 0.35;
    src.connect(bp).connect(g).connect(c.destination);
    src.start();
  } catch {}
}

export const sfx = {
  tap: () => tone(note(19), 0.04, 'triangle', 0.06),
  pick: () => tone(note(12), 0.06, 'triangle', 0.08),
  page: () => tone(note(7), 0.12, 'sine', 0.08, 0, note(14)),
  open: () => [0, 4, 7, 12].forEach((n, i) => tone(note(n + 12), 0.5, 'sine', 0.07, i * 0.06)),
  close: () => tone(note(12), 0.3, 'sine', 0.08, 0, note(0)),
  drop: () => tone(note(16), 0.2, 'sine', 0.1, 0, note(24)),
  done: () => [12, 16, 19, 24].forEach((n, i) => tone(note(n), 0.35, 'triangle', 0.09, i * 0.09)),
  no: () => tone(note(4), 0.18, 'sine', 0.08, 0, note(0)),
  tear: tearNoise,
};

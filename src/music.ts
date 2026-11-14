// Music made from a photo, in the browser: no files, no server, no licences.
// The photo's colour picks the key, its warmth and the mood pick major or minor, saturation sets the tempo,
// brightness opens the filter and lifts the melody, busy detail adds notes, and a deep depth map adds space.
// The same photo always plays the same tune (the RNG is seeded from its pixels).

export type Look = { bright: number; warm: number; sat: number; hue: number; busy: number; deep: number; seed: number };
export type Tune = { root: number; minor: boolean; bpm: number; density: number; cutoff: number; wet: number; lift: number; seed: number; label: string };

const ROOTS = ['C', 'D', 'E', 'F', 'G', 'A'], ROOT_ST = [0, 2, 4, 5, 7, 9];
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const PENTA_MAJ = [0, 2, 4, 7, 9], PENTA_MIN = [0, 3, 5, 7, 10];
const PROG_MAJ = [0, 5, 3, 4], PROG_MIN = [0, 5, 2, 6]; // I vi IV V / i VI III VII (scale degrees)
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Read a photo (and its depth map) down to a few numbers. */
export function look(photo: CanvasImageSource, depth?: CanvasImageSource): Look {
  const N = 24, c = new OffscreenCanvas(N, N), g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(photo, 0, 0, N, N);
  const px = g.getImageData(0, 0, N, N).data, lum = new Float32Array(N * N);
  let L = 0, W = 0, S = 0, hx = 0, hy = 0, seed = 7;
  for (let i = 0, k = 0; i < px.length; i += 4, k++) {
    const r = px[i] / 255, gr = px[i + 1] / 255, b = px[i + 2] / 255, mx = Math.max(r, gr, b), mn = Math.min(r, gr, b), s = mx - mn;
    lum[k] = (mx + mn) / 2; L += lum[k]; W += r - b; S += s;
    if (s > 0.08) { // hue of the coloured pixels, weighted by how colourful they are
      const h = mx === r ? ((gr - b) / s) % 6 : mx === gr ? (b - r) / s + 2 : (r - gr) / s + 4;
      hx += Math.cos((h * Math.PI) / 3) * s; hy += Math.sin((h * Math.PI) / 3) * s;
    }
    seed = (Math.imul(seed, 31) + px[i] + px[i + 1] * 7 + px[i + 2] * 13) >>> 0;
  }
  const n = N * N;
  let busy = 0;
  for (let y = 0; y < N; y++) for (let x = 1; x < N; x++) busy += Math.abs(lum[y * N + x] - lum[y * N + x - 1]);
  let deep = 0.5;
  if (depth) {
    g.drawImage(depth, 0, 0, N, N);
    const d = g.getImageData(0, 0, N, N).data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
    deep = (hi - lo) / 255;
  }
  return { bright: L / n, warm: W / n, sat: S / n, hue: (Math.atan2(hy, hx) + 2 * Math.PI) % (2 * Math.PI), busy: clamp((busy / (N * (N - 1))) * 8), deep, seed };
}

/** A photo's look plus the day's mood (0 Joy 1 Excited 2 Calm 3 Sad 4 Tired) -> the tune's settings. */
export function tune(l: Look, mood: number): Tune {
  const r = Math.floor((l.hue / (2 * Math.PI)) * 12) % ROOTS.length; // neighbouring colours land on different keys
  const minor = mood === 3 || mood === 4 || (mood === 2 && l.warm < -0.03 && l.bright < 0.45);
  const bpm = Math.round(clamp(56 + l.sat * 70 + [8, 20, 0, -6, -10][mood], 48, 104));
  return {
    root: ROOT_ST[r], minor, bpm,
    density: clamp(0.28 + l.busy * 0.45 + (mood === 1 ? 0.12 : 0) - (mood === 4 ? 0.1 : 0), 0.15, 0.8),
    cutoff: 700 + l.bright * 2600,
    wet: clamp(0.25 + l.deep * 0.45, 0.2, 0.7),
    lift: l.bright > 0.58 ? 12 : 0,
    seed: l.seed,
    label: `${ROOTS[r]} ${minor ? 'minor' : 'major'} · ${bpm} bpm`,
  };
}

const rng = (s: number) => () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/** The graph one tune plays into: master -> (dry + reverb) -> out. */
function graph(c: BaseAudioContext, t: Tune, out: AudioNode) {
  const master = c.createGain(), dry = c.createGain(), wet = c.createGain(), verb = c.createConvolver();
  const len = Math.floor(c.sampleRate * 2.8), ir = c.createBuffer(2, len, c.sampleRate);
  const noise = rng(t.seed ^ 0x9e3779b9);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (noise() * 2 - 1) * (1 - i / len) ** 3; }
  verb.buffer = ir;
  dry.gain.value = 1 - t.wet * 0.5; wet.gain.value = t.wet;
  master.connect(dry).connect(out);
  master.connect(verb).connect(wet).connect(out);
  return master;
}

/** Schedule every note that starts in [from, to) seconds of the tune. Pure timing: works live and offline. */
function play(c: BaseAudioContext, t: Tune, dest: AudioNode, state: { step: number; idx: number; rnd: () => number }, start: number, from: number, to: number) {
  const eighth = 60 / t.bpm / 2, scale = t.minor ? MINOR : MAJOR, penta = t.minor ? PENTA_MIN : PENTA_MAJ, prog = t.minor ? PROG_MIN : PROG_MAJ;
  const base = 52 + t.root; // E3..A3: high enough for small headset speakers
  for (;;) {
    const at = start + state.step * eighth;
    if (at >= to) return;
    if (at >= from) {
      if (state.step % 16 === 0) { // a new chord every two bars: soft detuned pad through a low-pass
        const deg = prog[(state.step / 16) % prog.length], dur = eighth * 16;
        const lp = c.createBiquadFilter(), g = c.createGain();
        lp.type = 'lowpass'; lp.Q.value = 0.5;
        lp.frequency.setValueAtTime(t.cutoff * 0.6, at);
        lp.frequency.linearRampToValueAtTime(t.cutoff, at + dur / 2);
        lp.frequency.linearRampToValueAtTime(t.cutoff * 0.6, at + dur);
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.085, at + 1.2);
        g.gain.setValueAtTime(0.085, at + dur - 0.2);
        g.gain.linearRampToValueAtTime(0, at + dur + 1.2);
        lp.connect(g).connect(dest);
        for (const k of [0, 2, 4]) {
          const i = deg + k, midi = base + scale[i % 7] + 12 * Math.floor(i / 7);
          for (const [type, cents] of [['triangle', -5], ['sawtooth', 5]] as const) {
            const o = c.createOscillator();
            o.type = type; o.frequency.value = hz(midi); o.detune.value = cents;
            const v = c.createGain(); v.gain.value = type === 'sawtooth' ? 0.25 : 1;
            o.connect(v).connect(lp);
            o.start(at); o.stop(at + dur + 1.4);
          }
        }
      }
      if (state.step % 16 !== 15 && state.rnd() < t.density) { // the melody: a bell that wanders the pentatonic scale
        state.idx = Math.max(0, Math.min(9, state.idx + [-2, -1, -1, 1, 1, 2][Math.floor(state.rnd() * 6)]));
        const midi = base + 12 + t.lift + penta[state.idx % 5] + 12 * Math.floor(state.idx / 5);
        const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), g2 = c.createGain();
        o.type = 'sine'; o.frequency.value = hz(midi);
        o2.type = 'sine'; o2.frequency.value = hz(midi) * 3; g2.gain.value = 0.12; // a little shimmer
        const peak = 0.12 + state.rnd() * 0.07;
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(peak, at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0005, at + 1.8);
        o.connect(g); o2.connect(g2).connect(g); g.connect(dest);
        o.start(at); o2.start(at); o.stop(at + 1.9); o2.stop(at + 1.9);
      }
    }
    state.step++;
  }
}

let live: { c: AudioContext; master: GainNode; timer: number } | null = null;

/** Start the photo's music on the shared context (fades in). */
export function musicOn(c: AudioContext, t: Tune) {
  musicOff();
  const master = graph(c, t, c.destination), start = c.currentTime + 0.1;
  master.gain.setValueAtTime(0, start);
  master.gain.linearRampToValueAtTime(1, start + 2.5);
  const state = { step: 0, idx: 4, rnd: rng(t.seed) };
  let until = start;
  const tick = () => { const to = c.currentTime + 0.4; play(c, t, master, state, start, until, to); until = to; };
  tick();
  live = { c, master, timer: window.setInterval(tick, 100) };
}

export function musicOff() {
  if (!live) return;
  const { c, master, timer } = live, t = c.currentTime;
  live = null;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.linearRampToValueAtTime(0, t + 1.2);
  window.setTimeout(() => { clearInterval(timer); master.disconnect(); }, 1400);
}

/** Turn the music down while a voice memo plays. */
export function duck(on: boolean) {
  if (!live) return;
  const g = live.master.gain, t = live.c.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(on ? 0.2 : 1, t + 0.4);
}

/** Render `seconds` of a tune offline (dev: listen to what a photo sounds like). */
export async function render(t: Tune, seconds = 24, rate = 44100) {
  const c = new OfflineAudioContext(2, Math.floor(seconds * rate), rate), master = graph(c, t, c.destination);
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(1, 2.5);
  master.gain.setValueAtTime(1, seconds - 2);
  master.gain.linearRampToValueAtTime(0, seconds);
  play(c, t, master, { step: 0, idx: 4, rnd: rng(t.seed) }, 0.1, 0, seconds - 1.5);
  return c.startRendering();
}

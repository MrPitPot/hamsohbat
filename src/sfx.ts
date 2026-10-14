// Small synthesized interface sounds (no audio files to download). Each sound is a few soft
// "bell" notes: a sine with quieter overtones, a quick attack and a smooth exponential decay,
// sent through a light echo so they feel less clinical.

type Note = [freq: number, start: number, dur: number, gain?: number];

const C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880, B5 = 987.77;
const C6 = 1046.5, D6 = 1174.66, E6 = 1318.51, G6 = 1567.98, A4 = 440, G4 = 392, E4 = 329.63;

const SOUNDS: Record<string, Note[]> = {
  // you
  join: [[G5, 0, 0.16], [C6, 0.09, 0.3]],
  leave: [[C6, 0, 0.16], [G5, 0.09, 0.32]],
  disconnected: [[E5, 0, 0.12, 0.8], [C5, 0.1, 0.12, 0.8], [G4, 0.2, 0.35, 0.8]],
  mute: [[E5, 0, 0.09, 0.7], [A4, 0.06, 0.14, 0.7]],
  unmute: [[A4, 0, 0.09, 0.7], [E5, 0.06, 0.14, 0.7]],
  deafen: [[G5, 0, 0.08, 0.7], [D5, 0.06, 0.08, 0.7], [G4, 0.12, 0.18, 0.7]],
  undeafen: [[G4, 0, 0.08, 0.7], [D5, 0.06, 0.08, 0.7], [G5, 0.12, 0.18, 0.7]],
  pttOn: [[B5, 0, 0.05, 0.35]],
  pttOff: [[G5, 0, 0.05, 0.3]],
  streamStart: [[C5, 0, 0.1, 0.8], [E5, 0.07, 0.1, 0.8], [G5, 0.14, 0.1, 0.8], [C6, 0.21, 0.28, 0.8]],
  streamStop: [[C6, 0, 0.1, 0.7], [G5, 0.07, 0.1, 0.7], [E5, 0.14, 0.24, 0.7]],
  // other people
  userJoin: [[E5, 0, 0.12, 0.75], [A5, 0.08, 0.24, 0.75]],
  userLeave: [[A5, 0, 0.12, 0.75], [E5, 0.08, 0.26, 0.75]],
  userStream: [[G5, 0, 0.1, 0.6], [D6, 0.08, 0.22, 0.6]],
  // messages
  message: [[E6, 0, 0.12, 0.55], [B5, 0.07, 0.22, 0.55]],
  mention: [[A5, 0, 0.1, 0.7], [D6, 0.07, 0.1, 0.7], [G6, 0.14, 0.26, 0.7]],
  friend: [[C6, 0, 0.12, 0.6], [E6, 0.1, 0.12, 0.6], [G6, 0.2, 0.3, 0.6]],
  // calls
  ring: [[E5, 0, 0.18], [G5, 0.2, 0.18], [E5, 0.4, 0.18], [C6, 0.6, 0.4]],
  outgoing: [[A4, 0, 0.35, 0.6], [A4, 0.45, 0.35, 0.6]],
  callEnd: [[G5, 0, 0.12, 0.8], [E5, 0.1, 0.12, 0.8], [C5, 0.2, 0.3, 0.8]],
  error: [[E4, 0, 0.12, 0.6], [E4, 0.14, 0.18, 0.6]],
};
export const SOUND_NAMES = Object.keys(SOUNDS);

let ac: AudioContext | null = null;
let out: GainNode | null = null;
let volume = 0.6;

export function audioCtx() {
  if (!ac) {
    ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    out = ac.createGain();
    out.gain.value = volume;
    // A short echo adds a little space to the dry tones.
    const delay = ac.createDelay(1);
    delay.delayTime.value = 0.11;
    const fb = ac.createGain();
    fb.gain.value = 0.18;
    const wet = ac.createGain();
    wet.gain.value = 0.22;
    out.connect(ac.destination);
    out.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  return ac;
}

export function setSoundVolume(v: number) {
  volume = Math.max(0, Math.min(1, v));
  if (out) out.gain.value = volume;
}

export function playSound(name: string) {
  const notes = SOUNDS[name];
  if (!notes || volume <= 0) return;
  try {
    const ctx = audioCtx();
    const now = ctx.currentTime + 0.01;
    for (const [freq, at, dur, g = 1] of notes) {
      const t0 = now + at;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(0.16 * g, t0 + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      env.connect(out!);
      // Fundamental plus two quiet overtones gives a soft bell-like timbre.
      for (const [mult, amp] of [
        [1, 1],
        [2, 0.18],
        [3, 0.06],
      ]) {
        const osc = ctx.createOscillator();
        const og = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        og.gain.value = amp;
        osc.connect(og).connect(env);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
      }
    }
  } catch {}
}

// ---------- built-in soundboard ----------
// Short synthesized clips everybody has, so a fresh server already has a soundboard.
export const BUILTIN_SOUNDS = ['airhorn', 'quack', 'cricket', 'clap', 'trombone', 'rimshot', 'bell', 'drumroll', 'wow', 'boing'];
export const BUILTIN_EMOJI: Record<string, string> = {
  'builtin:airhorn': '📯',
  'builtin:quack': '🦆',
  'builtin:cricket': '🦗',
  'builtin:clap': '👏',
  'builtin:trombone': '😢',
  'builtin:rimshot': '🥁',
  'builtin:bell': '🔔',
  'builtin:drumroll': '🎶',
  'builtin:wow': '😮',
  'builtin:boing': '🤪',
};
export const soundCtx = () => audioCtx();

function tone(ctx: AudioContext, dest: AudioNode, type: OscillatorType, f0: number, f1: number, t0: number, dur: number, gain: number) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.setValueAtTime(gain, t0 + Math.max(0.01, dur - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(dest);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}
function noise(ctx: AudioContext, dest: AudioNode, t0: number, dur: number, gain: number, hp = 1000) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = ctx.createBufferSource();
  const f = ctx.createBiquadFilter();
  const g = ctx.createGain();
  f.type = 'highpass';
  f.frequency.value = hp;
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(f).connect(g).connect(dest);
  src.start(t0);
}

export function playBuiltin(name: string, vol = 0.8) {
  try {
    const ctx = audioCtx();
    const dest = ctx.createGain();
    dest.gain.value = Math.max(0, Math.min(1, vol)) * 0.5;
    dest.connect(ctx.destination);
    const n = ctx.currentTime + 0.02;
    switch (name) {
      case 'airhorn':
        for (const [at, d] of [[0, 0.18], [0.22, 0.18], [0.44, 0.7]]) for (const f of [440, 554, 659]) tone(ctx, dest, 'sawtooth', f, f * 0.98, n + at, d, 0.12);
        break;
      case 'quack':
        for (const at of [0, 0.22]) tone(ctx, dest, 'sawtooth', 700, 380, n + at, 0.16, 0.25);
        break;
      case 'cricket':
        for (let i = 0; i < 9; i++) tone(ctx, dest, 'sine', 4200, 4300, n + i * 0.06 + (i > 3 ? 0.3 : 0), 0.04, 0.15);
        break;
      case 'clap':
        for (let i = 0; i < 6; i++) noise(ctx, dest, n + i * 0.32 + Math.random() * 0.03, 0.12, 0.9, 900);
        break;
      case 'trombone':
        [[392, 0], [370, 0.4], [349, 0.8]].forEach(([f, at]) => tone(ctx, dest, 'sawtooth', f, f * 0.99, n + at, 0.36, 0.15));
        tone(ctx, dest, 'sawtooth', 330, 300, n + 1.2, 1.0, 0.15);
        break;
      case 'rimshot':
        noise(ctx, dest, n, 0.08, 0.9, 200);
        tone(ctx, dest, 'triangle', 180, 60, n, 0.15, 0.5);
        noise(ctx, dest, n + 0.18, 0.08, 0.9, 200);
        tone(ctx, dest, 'triangle', 180, 60, n + 0.18, 0.15, 0.5);
        noise(ctx, dest, n + 0.42, 0.6, 0.6, 6000);
        break;
      case 'bell':
        for (const [m, a] of [[1, 0.3], [2.76, 0.12], [5.4, 0.05]]) tone(ctx, dest, 'sine', 880 * m, 880 * m, n, 1.6, a);
        break;
      case 'drumroll':
        for (let i = 0; i < 24; i++) noise(ctx, dest, n + i * 0.05, 0.06, 0.3 + i * 0.02, 300);
        noise(ctx, dest, n + 1.25, 0.9, 0.9, 4000);
        break;
      case 'wow':
        tone(ctx, dest, 'sawtooth', 220, 440, n, 0.35, 0.2);
        tone(ctx, dest, 'sawtooth', 440, 200, n + 0.35, 0.5, 0.2);
        break;
      case 'boing':
        tone(ctx, dest, 'sine', 150, 600, n, 0.12, 0.4);
        tone(ctx, dest, 'sine', 600, 200, n + 0.12, 0.4, 0.3);
        break;
    }
  } catch {}
}

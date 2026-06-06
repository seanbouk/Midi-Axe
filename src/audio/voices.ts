// Low-level synth voices, all built on a small pool of PERSISTENT nodes per
// track (started once, retuned per note) so offline render stays fast and live
// playback light. Sound fonts (fonts.ts) compose these into selectable patches.

export interface Voice {
  trigger(midi: number, durSec: number, time: number, velocity: number): void;
  dispose(): void;
}

export interface MasterBus {
  input: AudioNode;
  dispose(): void;
}

// --- master bus: tanh soft-clip ceiling (output can never reach full scale) --
const DRIVE = 2.5;
function makeSaturationCurve(n = 8192) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(DRIVE * ((i / (n - 1)) * 2 - 1));
  return c;
}
export function createMasterBus(ctx: BaseAudioContext): MasterBus {
  const input = ctx.createGain();
  input.gain.value = 1 / DRIVE;
  const shaper = ctx.createWaveShaper();
  shaper.curve = makeSaturationCurve();
  shaper.oversample = "2x";
  input.connect(shaper);
  shaper.connect(ctx.destination);
  return {
    input,
    dispose() {
      input.disconnect();
      shaper.disconnect();
    },
  };
}

// --- helpers ----------------------------------------------------------------
function midiToFreq(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Fourier coefficients for a bipolar rectangular pulse of the given duty cycle.
function pulseWave(ctx: BaseAudioContext, duty: number, harmonics = 48): PeriodicWave {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    const t = 2 * Math.PI * n * duty;
    real[n] = (2 * Math.sin(t)) / (Math.PI * n);
    imag[n] = (2 * (1 - Math.cos(t))) / (Math.PI * n);
  }
  return ctx.createPeriodicWave(real, imag);
}

export type OscSpec =
  | { kind: "pulse"; duty: number }
  | { kind: "native"; type: OscillatorType }
  | { kind: "wave"; real: Float32Array; imag: Float32Array };

function resolveWave(ctx: BaseAudioContext, spec: OscSpec): {
  wave: PeriodicWave | null;
  type: OscillatorType;
} {
  if (spec.kind === "pulse") return { wave: pulseWave(ctx, spec.duty), type: "square" };
  if (spec.kind === "wave") return { wave: ctx.createPeriodicWave(spec.real, spec.imag), type: "square" };
  return { wave: null, type: spec.type };
}

function applyOsc(osc: OscillatorNode, w: { wave: PeriodicWave | null; type: OscillatorType }) {
  if (w.wave) osc.setPeriodicWave(w.wave);
  else osc.type = w.type;
}

// --- oscillator voice (NES pulse/triangle, TurboGrafx wavetables) ------------
const POOL = 4;

class OscPoolVoice implements Voice {
  private pool: { osc: OscillatorNode; gain: GainNode }[] = [];
  private rr = 0;
  constructor(ctx: BaseAudioContext, output: AudioNode, spec: OscSpec, private level: number) {
    const w = resolveWave(ctx, spec);
    for (let i = 0; i < POOL; i++) {
      const osc = ctx.createOscillator();
      applyOsc(osc, w);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(output);
      osc.start(ctx.currentTime);
      this.pool.push({ osc, gain });
    }
  }
  trigger(midi: number, durSec: number, time: number, velocity: number) {
    const slot = this.pool[this.rr];
    this.rr = (this.rr + 1) % this.pool.length;
    slot.osc.frequency.setValueAtTime(midiToFreq(midi), time);
    const g = slot.gain.gain;
    const peak = Math.max(0.0001, velocity * this.level);
    const atkEnd = time + 0.005;
    const relStart = Math.max(atkEnd, time + durSec);
    const relEnd = relStart + 0.05;
    g.setValueAtTime(0, time);
    g.linearRampToValueAtTime(peak, atkEnd);
    g.setValueAtTime(peak, relStart);
    g.linearRampToValueAtTime(0, relEnd);
  }
  dispose() {
    for (const s of this.pool) {
      try { s.osc.stop(); } catch { /* already stopped */ }
      s.osc.disconnect();
      s.gain.disconnect();
    }
    this.pool = [];
  }
}

// --- SID-style voice: oscillator -> resonant lowpass -> ADSR (C64) -----------
class SidPoolVoice implements Voice {
  private pool: { osc: OscillatorNode; filter: BiquadFilterNode; gain: GainNode }[] = [];
  private rr = 0;
  constructor(ctx: BaseAudioContext, output: AudioNode, spec: OscSpec, private level: number) {
    const w = resolveWave(ctx, spec);
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      applyOsc(osc, w);
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 2600;
      filter.Q.value = 7; // resonance gives the SID "round" character
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(output);
      osc.start(ctx.currentTime);
      this.pool.push({ osc, filter, gain });
    }
  }
  trigger(midi: number, durSec: number, time: number, velocity: number) {
    const slot = this.pool[this.rr];
    this.rr = (this.rr + 1) % this.pool.length;
    slot.osc.frequency.setValueAtTime(midiToFreq(midi), time);
    const g = slot.gain.gain;
    const peak = Math.max(0.0001, velocity * this.level);
    const a = 0.005, d = 0.09, s = 0.6, r = 0.09;
    const sus = peak * s;
    const atkEnd = time + a;
    const decEnd = atkEnd + d;
    const relStart = Math.max(decEnd, time + durSec);
    const relEnd = relStart + r;
    g.setValueAtTime(0, time);
    g.linearRampToValueAtTime(peak, atkEnd);
    g.linearRampToValueAtTime(sus, decEnd);
    g.setValueAtTime(sus, relStart);
    g.linearRampToValueAtTime(0, relEnd);
  }
  dispose() {
    for (const s of this.pool) {
      try { s.osc.stop(); } catch { /* already stopped */ }
      s.osc.disconnect();
      s.filter.disconnect();
      s.gain.disconnect();
    }
    this.pool = [];
  }
}

// --- noise voice (drums / PSG-style noise) ----------------------------------
class NoiseVoice implements Voice {
  private pool: { src: AudioBufferSourceNode; hp: BiquadFilterNode; gain: GainNode }[] = [];
  private rr = 0;
  constructor(ctx: BaseAudioContext, output: AudioNode) {
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (let i = 0; i < 3; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(hp).connect(gain).connect(output);
      src.start(ctx.currentTime);
      this.pool.push({ src, hp, gain });
    }
  }
  trigger(midi: number, _durSec: number, time: number, velocity: number) {
    const slot = this.pool[this.rr];
    this.rr = (this.rr + 1) % this.pool.length;
    slot.hp.frequency.setValueAtTime(midi >= 60 ? 4000 : midi >= 48 ? 2000 : 600, time);
    const decay = midi >= 60 ? 0.05 : midi >= 48 ? 0.1 : 0.2;
    const peak = Math.max(0.0001, velocity * 0.5);
    const g = slot.gain.gain;
    g.setValueAtTime(peak, time);
    g.exponentialRampToValueAtTime(0.0001, time + decay);
    g.setValueAtTime(0, time + decay + 0.005);
  }
  dispose() {
    for (const s of this.pool) {
      try { s.src.stop(); } catch { /* already stopped */ }
      s.src.disconnect();
      s.hp.disconnect();
      s.gain.disconnect();
    }
    this.pool = [];
  }
}

// --- 4-operator FM voice (X68000 YM2151 / Mega Drive YM2612) ----------------
// Each operator is a sine oscillator with its own ADSR-gated gain. Modulator
// gains feed carrier frequency params (phase/FM); carrier gains sum to output.
// An algorithm is the set of modulation edges + which ops are carriers. All
// nodes persist in a small pool and are retuned/re-enveloped per note.
export interface FmOp {
  ratio: number; // frequency multiple of the played note
  level: number; // carriers: output amplitude; modulators: modulation index
  a: number;
  d: number;
  s: number;
  r: number;
}
export interface FmAlgo {
  ops: FmOp[];
  edges: [number, number][]; // [modulatorIndex, carrierIndex]
  carriers: number[];
}

function adsr(
  p: AudioParam, time: number, peak: number,
  a: number, d: number, s: number, r: number, end: number,
) {
  const atkEnd = time + a;
  const decEnd = atkEnd + d;
  const relStart = Math.max(decEnd, end);
  const relEnd = relStart + r;
  p.setValueAtTime(0, time);
  p.linearRampToValueAtTime(peak, atkEnd);
  p.linearRampToValueAtTime(peak * s, decEnd);
  p.setValueAtTime(peak * s, relStart);
  p.linearRampToValueAtTime(0, relEnd);
}

class FmPoolVoice implements Voice {
  private pool: { osc: OscillatorNode[]; env: GainNode[] }[] = [];
  private rr = 0;
  private carrierSet: Set<number>;
  constructor(ctx: BaseAudioContext, output: AudioNode, private algo: FmAlgo, private level: number) {
    this.carrierSet = new Set(algo.carriers);
    for (let p = 0; p < 3; p++) {
      const osc: OscillatorNode[] = [];
      const env: GainNode[] = [];
      for (let i = 0; i < algo.ops.length; i++) {
        const o = ctx.createOscillator();
        o.type = "sine";
        const g = ctx.createGain();
        g.gain.value = 0;
        o.connect(g);
        o.start(ctx.currentTime);
        osc.push(o);
        env.push(g);
      }
      for (const [m, c] of algo.edges) env[m].connect(osc[c].frequency);
      for (const c of algo.carriers) env[c].connect(output);
      this.pool.push({ osc, env });
    }
  }
  trigger(midi: number, durSec: number, time: number, velocity: number) {
    const slot = this.pool[this.rr];
    this.rr = (this.rr + 1) % this.pool.length;
    const base = midiToFreq(midi);
    const end = time + durSec;
    const mix = this.level / Math.max(1, this.algo.carriers.length);
    this.algo.ops.forEach((op, i) => {
      const f = op.ratio * base;
      slot.osc[i].frequency.setValueAtTime(f, time);
      // carriers: amplitude; modulators: frequency deviation = index * modFreq
      const peak = this.carrierSet.has(i)
        ? Math.max(0.0001, velocity * op.level * mix)
        : op.level * f;
      adsr(slot.env[i].gain, time, peak, op.a, op.d, op.s, op.r, end);
    });
  }
  dispose() {
    for (const s of this.pool) {
      s.osc.forEach((o) => { try { o.stop(); } catch { /* stopped */ } o.disconnect(); });
      s.env.forEach((g) => g.disconnect());
    }
    this.pool = [];
  }
}

export function fmVoice(ctx: BaseAudioContext, output: AudioNode, algo: FmAlgo, level: number): Voice {
  return new FmPoolVoice(ctx, output, algo, level);
}

export function oscVoice(ctx: BaseAudioContext, output: AudioNode, spec: OscSpec, level: number): Voice {
  return new OscPoolVoice(ctx, output, spec, level);
}
export function sidVoice(ctx: BaseAudioContext, output: AudioNode, spec: OscSpec, level: number): Voice {
  return new SidPoolVoice(ctx, output, spec, level);
}
export function noiseVoice(ctx: BaseAudioContext, output: AudioNode): Voice {
  return new NoiseVoice(ctx, output);
}

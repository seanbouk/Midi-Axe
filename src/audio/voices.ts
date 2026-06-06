// Low-level synth voices, all built on a small pool of PERSISTENT nodes per
// track (started once, retuned per note) so offline render stays fast and live
// playback light. Sound fonts (fonts.ts) compose these into selectable patches.
import fmWorkletUrl from "./worklets/fm-processor.js?url";
import sidWorkletUrl from "./worklets/sid-processor.js?url";

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

// --- SID voice (C64) — runs in the sid-processor AudioWorklet ----------------
// A patch is waveform + amplitude ADSR + a resonant multimode filter with its
// own ADSR (cutoff sweep) + optional PWM. Sample-accurate, so the envelopes and
// resonant filter behave like the real SID.
export interface Env {
  a: number; d: number; s: number; r: number;
}
export interface SidConfig {
  wave: "saw" | "triangle" | "pulse" | "noise";
  pulseWidth?: number; // for "pulse"
  pwmRate?: number;
  pwmDepth?: number;
  amp: Env;
  filter: { type: "lp" | "bp" | "hp"; cutoff: number; resonance: number };
  fenv?: Env & { amount: number }; // filter-cutoff envelope (Hz sweep)
  level: number;
}

class SidWorkletVoice implements Voice {
  private node: AudioWorkletNode;
  constructor(ctx: BaseAudioContext, output: AudioNode, config: SidConfig) {
    this.node = new AudioWorkletNode(ctx as AudioContext, "sid-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { config },
    });
    this.node.connect(output);
  }
  trigger(midi: number, durSec: number, time: number, velocity: number) {
    this.node.port.postMessage({ type: "note", midi, dur: durSec, time, vel: velocity });
  }
  dispose() {
    try { this.node.port.postMessage({ type: "stopAll" }); } catch { /* ignore */ }
    this.node.disconnect();
  }
}

export function sidVoice(ctx: BaseAudioContext, output: AudioNode, config: SidConfig): Voice {
  return new SidWorkletVoice(ctx, output, config);
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
  feedback?: { op: number; amount: number }; // operator self-modulation (grit/saw)
}

// The FM operators run in an AudioWorklet (fm-processor.js) for sample-accurate
// feedback — the node graph couldn't do a zero-delay loop. The module must be
// loaded into the context before any fmVoice is created; ensureFmModule (called
// by the FM fonts' prepare()) handles that, once per context.
const moduleCache = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
function ensureModule(ctx: BaseAudioContext, url: string): Promise<void> {
  let m = moduleCache.get(ctx);
  if (!m) { m = new Map(); moduleCache.set(ctx, m); }
  let p = m.get(url);
  if (!p) { p = ctx.audioWorklet.addModule(url); m.set(url, p); }
  return p;
}
export const ensureFmModule = (ctx: BaseAudioContext) => ensureModule(ctx, fmWorkletUrl);
export const ensureSidModule = (ctx: BaseAudioContext) => ensureModule(ctx, sidWorkletUrl);

class FmWorkletVoice implements Voice {
  private node: AudioWorkletNode;
  constructor(ctx: BaseAudioContext, output: AudioNode, algo: FmAlgo, level: number) {
    this.node = new AudioWorkletNode(ctx as AudioContext, "fm-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { algo, level },
    });
    this.node.connect(output);
  }
  trigger(midi: number, durSec: number, time: number, velocity: number) {
    this.node.port.postMessage({ type: "note", midi, dur: durSec, time, vel: velocity });
  }
  dispose() {
    try { this.node.port.postMessage({ type: "stopAll" }); } catch { /* ignore */ }
    this.node.disconnect();
  }
}

export function fmVoice(ctx: BaseAudioContext, output: AudioNode, algo: FmAlgo, level: number): Voice {
  return new FmWorkletVoice(ctx, output, algo, level);
}

// --- wavetable voice (TurboGrafx / PC Engine HuC6280) -----------------------
// Loops a tiny single-cycle buffer (the chip's 32-sample, 5-bit waveform RAM),
// pitched via playbackRate — so it keeps the raw, slightly-aliased lo-fi
// character a band-limited oscillator would smooth away. Optional LFO vibrato
// (the PC Engine's channel-2-modulates-channel-1 trick) via a shared oscillator
// feeding each voice's detune (cents), so the depth is pitch-independent.
export interface LfoSpec {
  rate: number; // Hz
  cents: number; // vibrato depth
}

class WavetableVoice implements Voice {
  private pool: { src: AudioBufferSourceNode; gain: GainNode; depth?: GainNode }[] = [];
  private rr = 0;
  private base: number; // playbackRate-1 frequency = sampleRate / tableLength
  private lfo?: OscillatorNode;
  private lfoFrac = 0; // vibrato depth as a fraction of playbackRate
  constructor(ctx: BaseAudioContext, output: AudioNode, wave: Float32Array, private level: number, lfo?: LfoSpec) {
    this.base = ctx.sampleRate / wave.length;
    const buf = ctx.createBuffer(1, wave.length, ctx.sampleRate);
    buf.getChannelData(0).set(wave);
    if (lfo) {
      this.lfo = ctx.createOscillator();
      this.lfo.type = "sine";
      this.lfo.frequency.value = lfo.rate;
      this.lfo.start(ctx.currentTime);
      this.lfoFrac = Math.pow(2, lfo.cents / 1200) - 1; // cents -> playbackRate fraction
    }
    for (let i = 0; i < 4; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(output);
      src.start(ctx.currentTime);
      let depth: GainNode | undefined;
      if (lfo && this.lfo) {
        // vibrato via playbackRate (detune is absent on the buffer source in
        // Tone's wrapped live context); depth is set per note to track pitch.
        depth = ctx.createGain();
        depth.gain.value = 0;
        this.lfo.connect(depth);
        depth.connect(src.playbackRate);
      }
      this.pool.push({ src, gain, depth });
    }
  }
  trigger(midi: number, durSec: number, time: number, velocity: number) {
    const slot = this.pool[this.rr];
    this.rr = (this.rr + 1) % this.pool.length;
    const rate = midiToFreq(midi) / this.base;
    slot.src.playbackRate.setValueAtTime(rate, time);
    if (slot.depth) slot.depth.gain.setValueAtTime(rate * this.lfoFrac, time);
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
      try { s.src.stop(); } catch { /* stopped */ }
      s.src.disconnect();
      s.gain.disconnect();
      s.depth?.disconnect();
    }
    try { this.lfo?.stop(); } catch { /* stopped */ }
    this.lfo?.disconnect();
    this.pool = [];
  }
}

export function wavetableVoice(
  ctx: BaseAudioContext, output: AudioNode, wave: Float32Array, level: number, lfo?: LfoSpec,
): Voice {
  return new WavetableVoice(ctx, output, wave, level, lfo);
}

export function oscVoice(ctx: BaseAudioContext, output: AudioNode, spec: OscSpec, level: number): Voice {
  return new OscPoolVoice(ctx, output, spec, level);
}
export function noiseVoice(ctx: BaseAudioContext, output: AudioNode): Voice {
  return new NoiseVoice(ctx, output);
}

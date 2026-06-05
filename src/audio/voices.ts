import type { VoiceId } from "../model/song";

// Lightweight raw Web Audio voices. Each note spins up a couple of plain nodes
// (oscillator + gain) that auto-disconnect on end — far cheaper to render than
// Tone's PolySynth/PulseOscillator, so offline export runs many times faster
// than real time and live playback stays light. Everything is context-agnostic:
// the same code drives the live AudioContext and the export OfflineAudioContext.

export interface Voice {
  trigger(midi: number, durSec: number, time: number, velocity: number): void;
  dispose(): void;
}

export interface MasterBus {
  input: AudioNode;
  dispose(): void;
}

// --- master bus: tanh soft-clip ceiling -------------------------------------
// A WaveShaper maps its [-1, 1] input domain across the curve and CLAMPS inputs
// beyond that range. So to soft-clip a summed signal that can exceed 1, we scale
// the input down by 1/DRIVE first and bake DRIVE into the curve: the chain then
// computes tanh(input) for |input| <= DRIVE and saturates smoothly toward ±1
// beyond it — genuine soft clipping, not a hard clamp. Output can never reach
// full scale, so neither live playback nor export can ever hard-clip.
const DRIVE = 2.5;

function makeSaturationCurve(n = 8192) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(DRIVE * u);
  }
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
const PULSE_DUTY: Record<string, number> = {
  pulse12: 0.125,
  pulse25: 0.25,
  pulse50: 0.5,
};

function midiToFreq(midi: number) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// Fourier coefficients for a bipolar rectangular pulse of the given duty cycle,
// used as a PeriodicWave so one oscillator node produces the NES pulse timbre.
function makePulseWave(ctx: BaseAudioContext, duty: number, harmonics = 48): PeriodicWave {
  const real = new Float32Array(harmonics + 1);
  const imag = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    const t = 2 * Math.PI * n * duty;
    real[n] = (2 * Math.sin(t)) / (Math.PI * n);
    imag[n] = (2 * (1 - Math.cos(t))) / (Math.PI * n);
  }
  return ctx.createPeriodicWave(real, imag);
}

// --- tonal voice (pulse / triangle) -----------------------------------------
// A small pool of PERSISTENT oscillators (started once, run for the whole
// render). Each note reuses a pool slot via round-robin, rescheduling its pitch
// and gain envelope. This avoids creating thousands of short-lived nodes — the
// real cost in offline rendering — making export ~20x faster, and it mirrors
// how a real NES channel works (one oscillator whose pitch is retuned per note).
// The pool size is the per-track polyphony.
const TONAL_POOL = 4;
const NOISE_POOL = 3;

class TonalVoice implements Voice {
  private pool: { osc: OscillatorNode; gain: GainNode }[] = [];
  private rr = 0;

  constructor(ctx: BaseAudioContext, output: AudioNode, duty: number | null, private level: number) {
    const wave = duty === null ? null : makePulseWave(ctx, duty);
    for (let i = 0; i < TONAL_POOL; i++) {
      const osc = ctx.createOscillator();
      if (wave) osc.setPeriodicWave(wave);
      else osc.type = "triangle";
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

    // Trapezoidal envelope (fast attack, hold, short release), always monotonic
    // in time so it is robust for very short notes.
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
      try {
        s.osc.stop();
      } catch {
        /* already stopped */
      }
      s.osc.disconnect();
      s.gain.disconnect();
    }
    this.pool = [];
  }
}

// --- noise voice (drums) ----------------------------------------------------
// Same persistent-pool idea: a few looping noise sources, each gated per hit.
class NoiseVoice implements Voice {
  private pool: { src: AudioBufferSourceNode; hp: BiquadFilterNode; gain: GainNode }[] = [];
  private rr = 0;

  constructor(ctx: BaseAudioContext, output: AudioNode) {
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    for (let i = 0; i < NOISE_POOL; i++) {
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
    // higher notes => brighter/snappier (hats), low => boomier (kick)
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
      try {
        s.src.stop();
      } catch {
        /* already stopped */
      }
      s.src.disconnect();
      s.hp.disconnect();
      s.gain.disconnect();
    }
    this.pool = [];
  }
}

export function createVoice(voice: VoiceId, ctx: BaseAudioContext, output: AudioNode): Voice {
  switch (voice) {
    case "pulse12":
      return new TonalVoice(ctx, output, PULSE_DUTY.pulse12, 0.25);
    case "pulse25":
      return new TonalVoice(ctx, output, PULSE_DUTY.pulse25, 0.25);
    case "pulse50":
      return new TonalVoice(ctx, output, PULSE_DUTY.pulse50, 0.22);
    case "triangle":
      return new TonalVoice(ctx, output, null, 0.34);
    case "noise":
      return new NoiseVoice(ctx, output);
  }
}

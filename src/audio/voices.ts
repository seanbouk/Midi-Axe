import * as Tone from "tone";
import type { VoiceId } from "../model/song";

// A Voice is a self-contained instrument that can play a MIDI note for a
// duration. We keep a tiny uniform interface so the engine can treat tonal
// (pulse/triangle) and percussive (noise) voices the same way, and so the same
// code path works for live playback and offline export.
export interface Voice {
  trigger(midi: number, durSec: number, time: number, velocity: number): void;
  dispose(): void;
}

// Shared output chain that every voice connects to instead of the raw output.
// The headroom gain pulls the summed signal down so a full arrangement has room
// to add up, and the limiter catches any remaining peaks so the mix can never
// hard-clip. Created per render context (global for live, offline for export).
export interface MasterBus {
  input: Tone.ToneAudioNode;
  dispose(): void;
}

export function createMasterBus(): MasterBus {
  // A tanh soft-clipper is the ceiling: tanh asymptotes to ±1, so no sum of
  // voices can ever push the output past full scale — it saturates smoothly
  // (musical, chiptune-friendly) instead of hard-clipping. Quiet material stays
  // near-linear; only loud peaks get rounded off. This guarantees no clipping
  // for both live playback and offline export.
  const shaper = new Tone.WaveShaper((x: number) => Math.tanh(x), 4096).toDestination();
  const gain = new Tone.Gain(0.85).connect(shaper);
  return {
    input: gain,
    dispose() {
      gain.dispose();
      shaper.dispose();
    },
  };
}

// Tone's PulseOscillator "width" runs -1..1, where 0 == 50% duty (square).
// Map the classic NES duty cycles onto that range.
const PULSE_WIDTH: Record<string, number> = {
  pulse12: -0.75, // 12.5%
  pulse25: -0.5, // 25%
  pulse50: 0, // 50% (square)
};

class TonalVoice implements Voice {
  private synth: Tone.PolySynth;

  constructor(
    oscillator: Partial<Tone.OmniOscillatorOptions>,
    gain: number,
    output: Tone.ToneAudioNode,
  ) {
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: oscillator as Tone.OmniOscillatorOptions,
      envelope: { attack: 0.005, decay: 0.05, sustain: 0.85, release: 0.06 },
      volume: Tone.gainToDb(gain),
    }).connect(output);
    this.synth.maxPolyphony = 16;
  }

  trigger(midi: number, durSec: number, time: number, velocity: number) {
    const freq = Tone.Frequency(midi, "midi").toFrequency();
    this.synth.triggerAttackRelease(freq, durSec, time, velocity);
  }

  dispose() {
    this.synth.dispose();
  }
}

// Noise drums: a small pool of NoiseSynths so simultaneous hits (kick + hat)
// don't cut each other off. Higher MIDI notes => brighter/shorter hit.
class NoiseVoice implements Voice {
  private pool: Tone.NoiseSynth[] = [];
  private filters: Tone.Filter[] = [];
  private next = 0;

  constructor(output: Tone.ToneAudioNode, poolSize = 4) {
    for (let i = 0; i < poolSize; i++) {
      const filter = new Tone.Filter(1000, "highpass").connect(output);
      const synth = new Tone.NoiseSynth({
        noise: { type: "white" },
        envelope: { attack: 0.001, decay: 0.12, sustain: 0 },
        volume: -6,
      }).connect(filter);
      this.pool.push(synth);
      this.filters.push(filter);
    }
  }

  trigger(midi: number, _durSec: number, time: number, velocity: number) {
    const synth = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    // brighter, snappier for higher notes (hats), boomier for low (kick)
    const decay = midi >= 60 ? 0.05 : midi >= 48 ? 0.1 : 0.2;
    synth.envelope.decay = decay;
    synth.triggerAttackRelease(decay, time, velocity);
  }

  dispose() {
    this.pool.forEach((s) => s.dispose());
    this.filters.forEach((f) => f.dispose());
  }
}

export function createVoice(voice: VoiceId, output: Tone.ToneAudioNode): Voice {
  switch (voice) {
    case "pulse12":
    case "pulse25":
    case "pulse50":
      return new TonalVoice(
        { type: "pulse", width: PULSE_WIDTH[voice] },
        0.5,
        output,
      );
    case "triangle":
      return new TonalVoice({ type: "triangle" }, 0.7, output);
    case "noise":
      return new NoiseVoice(output);
  }
}

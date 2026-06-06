import { Soundfont } from "smplr";
import type { Track } from "../model/song";
import { noiseVoice, oscVoice, type Voice } from "./voices";
import type { SoundFont } from "./fonts";

// MIDI font: plays each track with a real General MIDI sampled instrument from
// smplr (Benjamin Gleitzman's free FluidR3_GM soundfont, loaded from a CDN).
// Sample loading is async; voices register their load promise and the engine
// awaits midiReady() before starting. If a load fails, the voice falls back to
// a simple oscillator so playback/export never breaks.

// General MIDI program -> smplr/gleitz instrument name (index = GM program).
const GM_NAMES = [
  "acoustic_grand_piano", "bright_acoustic_piano", "electric_grand_piano", "honkytonk_piano",
  "electric_piano_1", "electric_piano_2", "harpsichord", "clavinet",
  "celesta", "glockenspiel", "music_box", "vibraphone",
  "marimba", "xylophone", "tubular_bells", "dulcimer",
  "drawbar_organ", "percussive_organ", "rock_organ", "church_organ",
  "reed_organ", "accordion", "harmonica", "tango_accordion",
  "acoustic_guitar_nylon", "acoustic_guitar_steel", "electric_guitar_jazz", "electric_guitar_clean",
  "electric_guitar_muted", "overdriven_guitar", "distortion_guitar", "guitar_harmonics",
  "acoustic_bass", "electric_bass_finger", "electric_bass_pick", "fretless_bass",
  "slap_bass_1", "slap_bass_2", "synth_bass_1", "synth_bass_2",
  "violin", "viola", "cello", "contrabass",
  "tremolo_strings", "pizzicato_strings", "orchestral_harp", "timpani",
  "string_ensemble_1", "string_ensemble_2", "synth_strings_1", "synth_strings_2",
  "choir_aahs", "voice_oohs", "synth_choir", "orchestra_hit",
  "trumpet", "trombone", "tuba", "muted_trumpet",
  "french_horn", "brass_section", "synth_brass_1", "synth_brass_2",
  "soprano_sax", "alto_sax", "tenor_sax", "baritone_sax",
  "oboe", "english_horn", "bassoon", "clarinet",
  "piccolo", "flute", "recorder", "pan_flute",
  "blown_bottle", "shakuhachi", "whistle", "ocarina",
  "lead_1_square", "lead_2_sawtooth", "lead_3_calliope", "lead_4_chiff",
  "lead_5_charang", "lead_6_voice", "lead_7_fifths", "lead_8_bass__lead",
  "pad_1_new_age", "pad_2_warm", "pad_3_polysynth", "pad_4_choir",
  "pad_5_bowed", "pad_6_metallic", "pad_7_halo", "pad_8_sweep",
  "fx_1_rain", "fx_2_soundtrack", "fx_3_crystal", "fx_4_atmosphere",
  "fx_5_brightness", "fx_6_goblins", "fx_7_echoes", "fx_8_scifi",
  "sitar", "banjo", "shamisen", "koto",
  "kalimba", "bagpipe", "fiddle", "shanai",
  "tinkle_bell", "agogo", "steel_drums", "woodblock",
  "taiko_drum", "melodic_tom", "synth_drum", "reverse_cymbal",
  "guitar_fret_noise", "breath_noise", "seashore", "bird_tweet",
  "telephone_ring", "helicopter", "applause", "gunshot",
];

const prettify = (name: string) =>
  name.replace(/_+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

// Load promises for the voices built in the current play/export pass.
let pending: Promise<unknown>[] = [];

export async function midiReady(): Promise<void> {
  const all = Promise.allSettled(pending);
  pending = [];
  // don't hang forever if the CDN is slow/unreachable; voices fall back anyway
  await Promise.race([all, new Promise((res) => setTimeout(res, 20000))]);
}

class SampleVoice implements Voice {
  private inst: ReturnType<typeof Soundfont>;
  private failed = false;
  private fallback: Voice | null = null;
  constructor(ctx: BaseAudioContext, output: AudioNode, instrument: string) {
    this.inst = Soundfont(ctx as AudioContext, {
      instrument,
      destination: output as AudioNode,
      kit: "FluidR3_GM",
    });
    pending.push(
      this.inst.ready.catch(() => {
        this.failed = true;
        this.fallback = oscVoice(ctx, output, { kind: "native", type: "triangle" }, 0.3);
      }),
    );
  }
  trigger(midi: number, durSec: number, time: number, velocity: number) {
    if (this.failed) {
      this.fallback?.trigger(midi, durSec, time, velocity);
      return;
    }
    try {
      this.inst.start({
        note: midi,
        time,
        duration: durSec,
        velocity: Math.max(1, Math.round(velocity * 127)),
      });
    } catch {
      /* not ready yet — note dropped */
    }
  }
  dispose() {
    try { this.inst.stop(); } catch { /* ignore */ }
    this.fallback?.dispose();
  }
}

export const MIDI_FONT: SoundFont = {
  id: "midi",
  label: "MIDI (GM)",
  patches: [{ id: "drums", label: "Drums" }, ...GM_NAMES.map((n) => ({ id: n, label: prettify(n) }))],
  theme: {
    bg: "#1d2026", panel: "#272b33", panel2: "#333944", ink: "#eef1f6", muted: "#828b9c",
    accent: "#6ca8ff", row: "#23262e", rowbeat: "#2b2f39", rowbar: "#39404e", grid: "#424a5a",
    gutter: "#15171c", skipRail: "#0f1115",
  },
  autoAssign: (t: Track) => (t.isDrum ? "drums" : GM_NAMES[Math.max(0, Math.min(127, t.gmProgram))]),
  createVoice(id, ctx, out) {
    return id === "drums" ? noiseVoice(ctx, out) : new SampleVoice(ctx, out, id);
  },
  ready: midiReady,
};

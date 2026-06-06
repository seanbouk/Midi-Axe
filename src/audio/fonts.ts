import type { Track } from "../model/song";
import { applyTheme, type Theme } from "./theme";
import { ensureFmModule, fmVoice, noiseVoice, oscVoice, sidVoice, wavetableVoice, type Voice } from "./voices";
import { FM_BANK, FM_LABELS, FM_MAP } from "./fmbank";
import { PCE_WAVES } from "./pcewaves";
import { MIDI_FONT } from "./midifont";

// A SoundFont is a synthesis engine: a set of selectable per-track patches, an
// auto-assign heuristic (drums/pitch-range based), a createVoice factory, and a
// colour theme. Switching fonts re-runs auto-assign for every track (no per-
// track memory — kept deliberately stateless and light).

export interface Patch {
  id: string;
  label: string;
}

export interface SoundFont {
  id: string;
  label: string;
  patches: Patch[];
  theme: Theme;
  autoAssign(track: Track, index: number): string;
  createVoice(patchId: string, ctx: BaseAudioContext, output: AudioNode): Voice;
  // optional async setup that must finish BEFORE voices are created in a
  // context (e.g. loading the FM AudioWorklet module)
  prepare?(ctx: BaseAudioContext): Promise<void>;
  // optional async asset preload awaited AFTER voices are created, before
  // playback/scheduling (MIDI samples)
  ready?(): Promise<void>;
}

// Shared heuristic: drums -> the noise patch, low average pitch -> a bass patch,
// everything else cycles through the remaining patches to stay distinct.
function assign(track: Track, index: number, noise: string, bass: string, rotation: string[]): string {
  if (track.isDrum) return noise;
  if (track.avgMidi > 0 && track.avgMidi < 52) return bass;
  return rotation[index % rotation.length];
}

const NES: SoundFont = {
  id: "nes",
  label: "NES",
  patches: [
    { id: "pulse12", label: "Pulse 12.5%" },
    { id: "pulse25", label: "Pulse 25%" },
    { id: "pulse50", label: "Pulse 50%" },
    { id: "triangle", label: "Triangle" },
    { id: "noise", label: "Noise" },
  ],
  theme: {
    bg: "#1c1c1c", panel: "#282828", panel2: "#353535", ink: "#f2f2f2", muted: "#8a8a8a",
    accent: "#e5362a", row: "#242424", rowbeat: "#2e2e2e", rowbar: "#3c3c3c", grid: "#454545",
    gutter: "#181818", skipRail: "#101010",
  },
  autoAssign: (t, i) => assign(t, i, "noise", "triangle", ["pulse50", "pulse25", "pulse12"]),
  createVoice(id, ctx, out) {
    switch (id) {
      case "pulse12": return oscVoice(ctx, out, { kind: "pulse", duty: 0.125 }, 0.25);
      case "pulse25": return oscVoice(ctx, out, { kind: "pulse", duty: 0.25 }, 0.25);
      case "triangle": return oscVoice(ctx, out, { kind: "native", type: "triangle" }, 0.34);
      case "noise": return noiseVoice(ctx, out);
      default: return oscVoice(ctx, out, { kind: "pulse", duty: 0.5 }, 0.22);
    }
  },
};

// TurboGrafx / PC Engine: looped 32-sample 5-bit wavetables (id -> wave, level)
// plus a vibrato lead (LFO) and channel-5 noise.
const TG_PATCHES: { id: string; label: string; wave: string; level: number; lfo?: { rate: number; cents: number } }[] = [
  { id: "tg_square", label: "Square", wave: "square", level: 0.26 },
  { id: "tg_pulse", label: "Pulse 25%", wave: "pulse25", level: 0.26 },
  { id: "tg_saw", label: "Saw", wave: "saw", level: 0.24 },
  { id: "tg_tri", label: "Triangle", wave: "triangle", level: 0.32 },
  { id: "tg_sine", label: "Sine", wave: "sine", level: 0.46 },
  { id: "tg_organ", label: "Organ", wave: "organ", level: 0.42 },
  { id: "tg_spike", label: "Spike", wave: "spike", level: 0.3 },
  { id: "tg_buzz", label: "Buzz", wave: "buzz", level: 0.24 },
  { id: "tg_lead", label: "Lead ~vib", wave: "spike", level: 0.3, lfo: { rate: 5.5, cents: 28 } },
];
const TG_MAP = Object.fromEntries(TG_PATCHES.map((p) => [p.id, p]));

const TURBOGRAFX: SoundFont = {
  id: "turbografx",
  label: "TurboGrafx",
  patches: [...TG_PATCHES.map((p) => ({ id: p.id, label: p.label })), { id: "tg_noise", label: "Noise" }],
  theme: {
    bg: "#15171b", panel: "#20242b", panel2: "#2c313a", ink: "#eef1f4", muted: "#7e8794",
    accent: "#ff8a2a", row: "#1c1f25", rowbeat: "#24282f", rowbar: "#313742", grid: "#3c4350",
    gutter: "#121419", skipRail: "#0d0f12",
  },
  autoAssign: (t, i) => assign(t, i, "tg_noise", "tg_sine", ["tg_square", "tg_organ", "tg_spike", "tg_saw", "tg_lead"]),
  createVoice(id, ctx, out) {
    if (id === "tg_noise") return noiseVoice(ctx, out);
    const p = TG_MAP[id] ?? TG_PATCHES[0];
    return wavetableVoice(ctx, out, PCE_WAVES[p.wave], p.level, p.lfo);
  },
};

const C64: SoundFont = {
  id: "c64",
  label: "C64",
  patches: [
    { id: "sid_pulse", label: "Pulse" },
    { id: "sid_saw", label: "Saw" },
    { id: "sid_tri", label: "Triangle" },
    { id: "sid_noise", label: "Noise" },
  ],
  theme: {
    bg: "#c7b88f", panel: "#bcac7e", panel2: "#ac9c6c", ink: "#2a2742", muted: "#6d6446",
    accent: "#4a40c4", row: "#c1b184", rowbeat: "#b9a875", rowbar: "#ab9a66", grid: "#978a5c",
    gutter: "#b1a06f", skipRail: "#8a7d52",
  },
  autoAssign: (t, i) => assign(t, i, "sid_noise", "sid_saw", ["sid_pulse", "sid_tri", "sid_saw"]),
  createVoice(id, ctx, out) {
    switch (id) {
      case "sid_saw": return sidVoice(ctx, out, { kind: "native", type: "sawtooth" }, 0.22);
      case "sid_tri": return sidVoice(ctx, out, { kind: "native", type: "triangle" }, 0.34);
      case "sid_noise": return noiseVoice(ctx, out);
      default: return sidVoice(ctx, out, { kind: "pulse", duty: 0.5 }, 0.28);
    }
  },
};

// FM voice from a bank patch id (falls back to the first patch if unknown).
function fmFromBank(id: string, ctx: BaseAudioContext, out: AudioNode): Voice {
  const p = FM_MAP[id] ?? FM_BANK[0];
  return fmVoice(ctx, out, p.algo, p.level);
}

const X68000: SoundFont = {
  id: "x68000",
  label: "X68000",
  // full FM bank (DX9-style 4-op) + a noise voice for drums
  patches: [...FM_BANK.map((p) => ({ id: p.id, label: p.label })), { id: "fm_noise", label: "Noise" }],
  theme: {
    bg: "#151a24", panel: "#1f2633", panel2: "#2b3444", ink: "#e8edf5", muted: "#7f8aa0",
    accent: "#2bd1c4", row: "#1b212c", rowbeat: "#232b38", rowbar: "#313c4e", grid: "#3a4658",
    gutter: "#11151c", skipRail: "#0c0f15",
  },
  autoAssign: (t, i) =>
    assign(t, i, "fm_noise", "fm_bass", ["fm_synbrass", "fm_lead_saw", "fm_ep", "fm_brass", "fm_pad", "fm_bell"]),
  prepare: (ctx) => ensureFmModule(ctx),
  createVoice(id, ctx, out) {
    return id === "fm_noise" ? noiseVoice(ctx, out) : fmFromBank(id, ctx, out);
  },
};

// Mega Drive / GEMS: a curated FM subset + SN76489-style PSG (square + noise).
const MD_FM = ["fm_synbrass", "fm_bass_fb", "fm_lead_saw", "fm_ep", "fm_organ", "fm_bell"];
const MEGADRIVE: SoundFont = {
  id: "megadrive",
  label: "Mega Drive",
  patches: [
    ...MD_FM.map((id) => ({ id, label: FM_LABELS[id] })),
    { id: "psg_square", label: "PSG Square" },
    { id: "psg_noise", label: "PSG Noise" },
  ],
  theme: {
    bg: "#15161b", panel: "#202129", panel2: "#2c2e3a", ink: "#eef0f6", muted: "#828799",
    accent: "#3f7ff0", row: "#1b1c23", rowbeat: "#23252e", rowbar: "#31333f", grid: "#3b3e4c",
    gutter: "#111218", skipRail: "#0c0d11",
  },
  autoAssign: (t, i) => assign(t, i, "psg_noise", "fm_bass_fb", ["fm_synbrass", "fm_lead_saw", "psg_square", "fm_ep"]),
  prepare: (ctx) => ensureFmModule(ctx),
  createVoice(id, ctx, out) {
    if (id === "psg_square") return oscVoice(ctx, out, { kind: "native", type: "square" }, 0.24);
    if (id === "psg_noise") return noiseVoice(ctx, out);
    return fmFromBank(id, ctx, out);
  },
};

const FONTS: SoundFont[] = [MIDI_FONT, NES, TURBOGRAFX, C64, X68000, MEGADRIVE];

let currentId = "midi";
try {
  const saved = localStorage.getItem("midiaxe.font");
  if (saved && FONTS.some((f) => f.id === saved)) currentId = saved;
} catch { /* localStorage unavailable */ }

export function listFonts(): SoundFont[] {
  return FONTS;
}
export function getCurrentFont(): SoundFont {
  return FONTS.find((f) => f.id === currentId) ?? NES;
}
export function setCurrentFont(id: string) {
  if (!FONTS.some((f) => f.id === id)) return;
  currentId = id;
  try { localStorage.setItem("midiaxe.font", id); } catch { /* ignore */ }
  applyTheme(getCurrentFont().theme);
}
export function assignPatches(song: { tracks: Track[] }) {
  const f = getCurrentFont();
  song.tracks.forEach((t, i) => (t.patch = f.autoAssign(t, i)));
}
export function patchLabel(patchId: string): string {
  return getCurrentFont().patches.find((p) => p.id === patchId)?.label ?? patchId;
}
export function nextPatch(patchId: string): string {
  const ps = getCurrentFont().patches;
  const i = ps.findIndex((p) => p.id === patchId);
  return ps[(i + 1) % ps.length].id;
}
export function createVoice(patchId: string, ctx: BaseAudioContext, output: AudioNode): Voice {
  return getCurrentFont().createVoice(patchId, ctx, output);
}

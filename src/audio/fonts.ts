import type { Track } from "../model/song";
import { applyTheme, type Theme } from "./theme";
import { fmVoice, noiseVoice, oscVoice, sidVoice, type FmAlgo, type Voice } from "./voices";
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
  // optional async asset preload (MIDI samples); awaited before play/export
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

const TURBOGRAFX: SoundFont = {
  id: "turbografx",
  label: "TurboGrafx",
  patches: [
    { id: "tg_square", label: "Square" },
    { id: "tg_saw", label: "Saw" },
    { id: "tg_sine", label: "Sine" },
    { id: "tg_tri", label: "Triangle" },
    { id: "tg_noise", label: "Noise" },
  ],
  theme: {
    bg: "#15171b", panel: "#20242b", panel2: "#2c313a", ink: "#eef1f4", muted: "#7e8794",
    accent: "#ff8a2a", row: "#1c1f25", rowbeat: "#24282f", rowbar: "#313742", grid: "#3c4350",
    gutter: "#121419", skipRail: "#0d0f12",
  },
  autoAssign: (t, i) => assign(t, i, "tg_noise", "tg_tri", ["tg_square", "tg_saw", "tg_sine"]),
  createVoice(id, ctx, out) {
    switch (id) {
      case "tg_saw": return oscVoice(ctx, out, { kind: "native", type: "sawtooth" }, 0.2);
      case "tg_sine": return oscVoice(ctx, out, { kind: "native", type: "sine" }, 0.5);
      case "tg_tri": return oscVoice(ctx, out, { kind: "native", type: "triangle" }, 0.34);
      case "tg_noise": return noiseVoice(ctx, out);
      default: return oscVoice(ctx, out, { kind: "native", type: "square" }, 0.26);
    }
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

// Shared FM patches (used by X68000 and Mega Drive). For modulator ops `level`
// is the modulation index; for carrier ops it is output amplitude.
const FM: Record<string, FmAlgo> = {
  bass: { ops: [
    { ratio: 1, level: 2.4, a: 0.001, d: 0.12, s: 0.4, r: 0.12 },
    { ratio: 1, level: 0.9, a: 0.001, d: 0.10, s: 0.8, r: 0.12 },
  ], edges: [[0, 1]], carriers: [1] },
  lead: { ops: [
    { ratio: 2, level: 3.0, a: 0.004, d: 0.2, s: 0.6, r: 0.16 },
    { ratio: 1, level: 0.9, a: 0.004, d: 0.2, s: 0.8, r: 0.16 },
  ], edges: [[0, 1]], carriers: [1] },
  bell: { ops: [
    { ratio: 3.5, level: 4.0, a: 0.001, d: 0.6, s: 0.1, r: 0.5 },
    { ratio: 1, level: 0.9, a: 0.001, d: 0.5, s: 0.2, r: 0.5 },
  ], edges: [[0, 1]], carriers: [1] },
  brass: { ops: [
    { ratio: 1, level: 1.6, a: 0.03, d: 0.2, s: 0.7, r: 0.2 },
    { ratio: 1, level: 1.4, a: 0.03, d: 0.2, s: 0.7, r: 0.2 },
    { ratio: 1, level: 0.9, a: 0.03, d: 0.2, s: 0.8, r: 0.2 },
  ], edges: [[0, 1], [1, 2]], carriers: [2] },
};

const X68000: SoundFont = {
  id: "x68000",
  label: "X68000",
  patches: [
    { id: "fm_lead", label: "FM Lead" },
    { id: "fm_bass", label: "FM Bass" },
    { id: "fm_brass", label: "FM Brass" },
    { id: "fm_bell", label: "FM Bell" },
    { id: "fm_noise", label: "Noise" },
  ],
  theme: {
    bg: "#151a24", panel: "#1f2633", panel2: "#2b3444", ink: "#e8edf5", muted: "#7f8aa0",
    accent: "#2bd1c4", row: "#1b212c", rowbeat: "#232b38", rowbar: "#313c4e", grid: "#3a4658",
    gutter: "#11151c", skipRail: "#0c0f15",
  },
  autoAssign: (t, i) => assign(t, i, "fm_noise", "fm_bass", ["fm_lead", "fm_brass", "fm_bell"]),
  createVoice(id, ctx, out) {
    switch (id) {
      case "fm_bass": return fmVoice(ctx, out, FM.bass, 0.34);
      case "fm_brass": return fmVoice(ctx, out, FM.brass, 0.3);
      case "fm_bell": return fmVoice(ctx, out, FM.bell, 0.3);
      case "fm_noise": return noiseVoice(ctx, out);
      default: return fmVoice(ctx, out, FM.lead, 0.3);
    }
  },
};

const MEGADRIVE: SoundFont = {
  id: "megadrive",
  label: "Mega Drive",
  patches: [
    { id: "md_lead", label: "FM Lead" },
    { id: "md_bass", label: "FM Bass" },
    { id: "md_brass", label: "FM Brass" },
    { id: "psg_square", label: "PSG Square" },
    { id: "psg_noise", label: "PSG Noise" },
  ],
  theme: {
    bg: "#15161b", panel: "#202129", panel2: "#2c2e3a", ink: "#eef0f6", muted: "#828799",
    accent: "#3f7ff0", row: "#1b1c23", rowbeat: "#23252e", rowbar: "#31333f", grid: "#3b3e4c",
    gutter: "#111218", skipRail: "#0c0d11",
  },
  autoAssign: (t, i) => assign(t, i, "psg_noise", "md_bass", ["md_lead", "psg_square", "md_brass"]),
  createVoice(id, ctx, out) {
    switch (id) {
      case "md_bass": return fmVoice(ctx, out, FM.bass, 0.34);
      case "md_brass": return fmVoice(ctx, out, FM.brass, 0.3);
      case "psg_square": return oscVoice(ctx, out, { kind: "native", type: "square" }, 0.24);
      case "psg_noise": return noiseVoice(ctx, out);
      default: return fmVoice(ctx, out, FM.lead, 0.3);
    }
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

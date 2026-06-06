import type { Track } from "../model/song";
import { applyTheme, type Theme } from "./theme";
import { noiseVoice, oscVoice, sidVoice, type Voice } from "./voices";

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

const FONTS: SoundFont[] = [NES, TURBOGRAFX, C64];

let currentId = "nes";
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

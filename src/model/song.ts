// The internal song model: the single source of truth that the tracker view,
// the audio engine, and the exporter all read from. MIDI is parsed once into
// this shape (quantized to tracker rows); everything downstream works on it.

export type VoiceId =
  | "pulse12"
  | "pulse25"
  | "pulse50"
  | "triangle"
  | "noise";

export const VOICE_LABELS: Record<VoiceId, string> = {
  pulse12: "Pulse 12.5%",
  pulse25: "Pulse 25%",
  pulse50: "Pulse 50%",
  triangle: "Triangle",
  noise: "Noise",
};

export const VOICE_ORDER: VoiceId[] = [
  "pulse12",
  "pulse25",
  "pulse50",
  "triangle",
  "noise",
];

export interface Note {
  row: number; // quantized start row
  lenRows: number; // quantized length in rows (>= 1)
  midi: number; // MIDI note number
  velocity: number; // 0..1
}

export interface Track {
  name: string;
  gmProgram: number; // original General MIDI program number
  isDrum: boolean; // came from MIDI channel 10
  muted: boolean;
  solo: boolean;
  voice: VoiceId;
  color: string;
  notes: Note[];
}

export interface Song {
  name: string;
  bpm: number;
  rowsPerBeat: number;
  lengthRows: number;
  tracks: Track[];
  // selected crop range in rows; null means the whole song
  cropStart: number;
  cropEnd: number;
}

// Seconds-per-row at the song tempo. One beat = 60/bpm seconds.
export function secondsPerRow(song: Song): number {
  return 60 / song.bpm / song.rowsPerBeat;
}

// Tracks that should actually sound, honoring solo (solo wins over mute).
export function audibleTracks(song: Song): Track[] {
  const anySolo = song.tracks.some((t) => t.solo);
  return song.tracks.filter((t) => (anySolo ? t.solo : !t.muted));
}

const PITCH_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

// MIDI number -> tracker-style note name, e.g. 60 -> "C-4".
export function noteName(midi: number): string {
  const name = PITCH_NAMES[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return (name.length === 1 ? name + "-" : name) + octave;
}

// The internal song model: the single source of truth that the tracker view,
// the audio engine, and the exporter all read from. MIDI is parsed once into
// this shape (quantized to tracker rows); everything downstream works on it.

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
  avgMidi: number; // average note pitch (drives font auto-assign)
  muted: boolean;
  solo: boolean; // momentary: true only while the Solo button is held
  patch: string; // current sound-font patch id (font-scoped)
  volume: number; // 0..1 per-track level
  color: string;
  notes: Note[];
}

export interface Song {
  name: string;
  bpm: number;
  rowsPerBeat: number;
  lengthRows: number;
  tracks: Track[];
  // Per-row enable mask. skipped[r] === true means row r is removed from the
  // timeline entirely (playback and export jump over it). Drives crop + segment
  // removal via the leftmost toggle strip.
  skipped: boolean[];
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

// --- schedule: compact the skipped rows out of the timeline -----------------
export interface SchedNote {
  time: number; // seconds, in the compacted timeline
  durSec: number;
  midi: number;
  velocity: number;
}

export interface Schedule {
  tracks: SchedNote[][]; // aligned 1:1 with song.tracks
  activeRows: number[]; // original row index for each compacted row, in order
  newIndexOf: Int32Array; // original row -> compacted index, or -1 if skipped
  totalSec: number; // length of the compacted timeline
}

// Build the playable/exportable schedule: enabled rows are renumbered
// consecutively (so skipped segments vanish and the song closes the gap), note
// start times are remapped onto that compacted timeline, and a note's duration
// is capped so it never rings across a cut into following material.
export function buildSchedule(song: Song): Schedule {
  const spr = secondsPerRow(song);
  const n = song.lengthRows;

  const newIndexOf = new Int32Array(n).fill(-1);
  const activeRows: number[] = [];
  for (let r = 0; r < n; r++) {
    if (!song.skipped[r]) {
      newIndexOf[r] = activeRows.length;
      activeRows.push(r);
    }
  }

  // skipAtOrAfter[k] = smallest s >= k that is skipped (n if none)
  const skipAtOrAfter = new Int32Array(n + 1);
  skipAtOrAfter[n] = n;
  for (let r = n - 1; r >= 0; r--)
    skipAtOrAfter[r] = song.skipped[r] ? r : skipAtOrAfter[r + 1];

  const tracks: SchedNote[][] = song.tracks.map((track) => {
    const out: SchedNote[] = [];
    for (const note of track.notes) {
      const r = note.row;
      if (r >= n || song.skipped[r]) continue; // note starts on a removed row
      const capRow = Math.min(r + note.lenRows, skipAtOrAfter[r + 1]);
      const effLen = Math.max(1, capRow - r);
      out.push({
        time: newIndexOf[r] * spr,
        durSec: Math.max(0.03, effLen * spr * 0.95),
        midi: note.midi,
        velocity: note.velocity,
      });
    }
    return out;
  });

  return { tracks, activeRows, newIndexOf, totalSec: activeRows.length * spr };
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

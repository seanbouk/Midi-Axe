import { Midi } from "@tonejs/midi";
import type { Song, Track } from "../model/song";

const TRACK_COLORS = [
  "#7df0a0",
  "#f07d9e",
  "#7db8f0",
  "#f0d77d",
  "#c77df0",
  "#7df0e6",
  "#f0a87d",
  "#a8f07d",
];

// Parse a MIDI ArrayBuffer into our quantized Song model. The MIDI bytes live
// only here and in the browser's memory — never serialized elsewhere.
export function parseMidi(
  buffer: ArrayBuffer,
  fileName: string,
  rowsPerBeat: number,
): Song {
  const midi = new Midi(buffer);
  const bpm = midi.header.tempos[0]?.bpm ?? 120;
  const secondsPerRow = 60 / bpm / rowsPerBeat;

  let lengthRows = 1;
  const tracks: Track[] = [];

  midi.tracks.forEach((mt, i) => {
    if (mt.notes.length === 0) return;

    const isDrum = mt.channel === 9; // channel 10 (0-indexed 9) = GM percussion
    let pitchSum = 0;

    const notes = mt.notes.map((n) => {
      pitchSum += n.midi;
      const row = Math.round(n.time / secondsPerRow);
      const lenRows = Math.max(1, Math.round(n.duration / secondsPerRow));
      lengthRows = Math.max(lengthRows, row + lenRows);
      return { row, lenRows, midi: n.midi, velocity: n.velocity };
    });

    const avgMidi = pitchSum / notes.length;
    const name =
      mt.name?.trim() ||
      (isDrum ? "Drums" : mt.instrument.name) ||
      `Track ${i + 1}`;

    tracks.push({
      name,
      gmProgram: mt.instrument.number,
      isDrum,
      avgMidi,
      muted: false,
      solo: false,
      patch: "", // assigned by the current sound font after parse
      volume: 0.85,
      color: TRACK_COLORS[tracks.length % TRACK_COLORS.length],
      notes,
    });
  });

  return {
    name: fileName.replace(/\.midi?$/i, ""),
    bpm,
    rowsPerBeat,
    lengthRows,
    tracks,
    skipped: new Array(lengthRows).fill(false),
  };
}

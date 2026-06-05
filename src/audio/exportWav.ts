import * as Tone from "tone";
import { audibleTracks, secondsPerRow, type Song } from "../model/song";
import { createVoice } from "./voices";

// Render the filtered + voiced song offline (faster than real time) into an
// audio buffer, then encode it as a 16-bit PCM WAV. WAV imports directly into
// Unity, so this is the Unity-ready export path.

export async function renderWav(song: Song): Promise<Blob> {
  const spr = secondsPerRow(song);
  const start = song.cropStart;
  const end = song.cropEnd;
  const durationSec = (end - start) * spr + 0.5; // tail for release

  // Inside Tone.Offline the "current context" is the offline one, so any
  // synths created here (via createVoice) render into that offline buffer.
  const buffer = await Tone.Offline(({ transport }) => {
    for (const track of audibleTracks(song)) {
      const voice = createVoice(track.voice);
      for (const note of track.notes) {
        if (note.row < start || note.row >= end) continue;
        const t = (note.row - start) * spr;
        const durSec = Math.max(0.03, note.lenRows * spr * 0.95);
        transport.schedule((time) => {
          voice.trigger(note.midi, durSec, time, note.velocity);
        }, t);
      }
    }
    transport.start();
  }, durationSec, 2, 44100);

  return encodeWav(buffer.get() as AudioBuffer);
}

function encodeWav(audioBuffer: AudioBuffer): Blob {
  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;

  // interleave channels
  const channels: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) channels.push(audioBuffer.getChannelData(c));

  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      let sample = channels[c][i];
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

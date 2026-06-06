import { buildSchedule, type Song } from "../model/song";
import { createMasterBus } from "./voices";
import { createVoice } from "./fonts";

// Render the song (skipped rows compacted out, per-track volumes applied) into a
// WAV on a plain OfflineAudioContext. Always rendered as a seamless loop: we
// render an extra tail past the end and fold it back onto the start, so the clip
// loops cleanly in Unity with no trailing silence. Progress + cancel are driven
// by OfflineAudioContext.suspend()/resume() points.

const TAIL_SEC = 0.6;

export interface ExportOptions {
  onProgress?: (p: number) => void; // 0..1
  signal?: AbortSignal;
}

export async function renderWav(song: Song, opts: ExportOptions = {}): Promise<Blob> {
  const schedule = buildSchedule(song);
  const loopSec = schedule.totalSec;
  const totalSec = loopSec + TAIL_SEC;
  const sampleRate = 44100;
  const channels = 2;
  const totalFrames = Math.max(1, Math.ceil(totalSec * sampleRate));

  const ctx = new OfflineAudioContext(channels, totalFrames, sampleRate);
  const master = createMasterBus(ctx);
  schedule.tracks.forEach((notes, i) => {
    const track = song.tracks[i];
    const anySolo = song.tracks.some((t) => t.solo);
    const audible = anySolo ? track.solo : !track.muted;
    if (!audible) return;
    const gate = ctx.createGain();
    gate.gain.value = track.volume;
    gate.connect(master.input);
    const voice = createVoice(track.patch, ctx, gate);
    for (const note of notes) voice.trigger(note.midi, note.durSec, note.time, note.velocity);
  });

  // Progress + cancel via suspend/resume checkpoints.
  const steps = 20;
  for (let i = 1; i < steps; i++) {
    const at = (totalSec * i) / steps;
    ctx.suspend(at).then(() => {
      opts.onProgress?.(i / steps);
      if (!opts.signal?.aborted) ctx.resume();
    });
  }

  const rendered = await new Promise<AudioBuffer | null>((resolve, reject) => {
    if (opts.signal?.aborted) return resolve(null);
    opts.signal?.addEventListener("abort", () => resolve(null), { once: true });
    ctx.startRendering().then(resolve, reject);
  });
  if (!rendered) throw new DOMException("Export cancelled", "AbortError");
  opts.onProgress?.(1);

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(rendered.getChannelData(c).slice());

  // Seamless loop: keep exactly the loop body and fold the overflow tail (notes
  // still ringing past the end) back onto the start, so end->start wraps cleanly.
  const outFrames = Math.max(1, Math.floor(loopSec * sampleRate));
  for (const ch of data) {
    const tailFrames = Math.min(ch.length - outFrames, outFrames);
    for (let i = 0; i < tailFrames; i++) ch[i] += ch[outFrames + i];
  }

  return encodeWav(data, outFrames, sampleRate);
}

function encodeWav(channels: Float32Array[], numFrames: number, sampleRate: number): Blob {
  const numCh = channels.length;

  // Peak-normalize to -0.3 dBFS (synthesized silence is true zero — no floor).
  let peak = 0;
  for (const ch of channels)
    for (let i = 0; i < numFrames; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  const gain = peak > 1e-4 ? 0.97 / peak : 1;

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
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
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
      let sample = channels[c][i] * gain;
      sample = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

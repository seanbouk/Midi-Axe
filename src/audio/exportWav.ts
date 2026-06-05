import { audibleTracks, secondsPerRow, type Song } from "../model/song";
import { createMasterBus, createVoice } from "./voices";

// Render the filtered + voiced song into a WAV using a plain OfflineAudioContext
// (no Tone here): every note is scheduled up front via the raw voices, which
// renders far faster than real time. We drive a progress bar and support cancel
// by scheduling OfflineAudioContext.suspend() points across the timeline.

const TAIL_SEC = 0.6; // captures note release/decay past the last/loop boundary

export interface ExportOptions {
  loop?: boolean; // seamless loop: fold the tail back onto the start, no trailing silence
  onProgress?: (p: number) => void; // 0..1
  signal?: AbortSignal;
}

export async function renderWav(song: Song, opts: ExportOptions = {}): Promise<Blob> {
  const spr = secondsPerRow(song);
  const start = song.cropStart;
  const end = song.cropEnd;
  const loopSec = (end - start) * spr;
  const totalSec = loopSec + TAIL_SEC;
  const sampleRate = 44100;
  const channels = 2;
  const totalFrames = Math.ceil(totalSec * sampleRate);

  const ctx = new OfflineAudioContext(channels, totalFrames, sampleRate);
  const master = createMasterBus(ctx);
  for (const track of audibleTracks(song)) {
    const voice = createVoice(track.voice, ctx, master.input);
    for (const note of track.notes) {
      if (note.row < start || note.row >= end) continue;
      const t = (note.row - start) * spr;
      const durSec = Math.max(0.03, note.lenRows * spr * 0.95);
      voice.trigger(note.midi, durSec, t, note.velocity);
    }
  }

  // Progress + cancel: suspend at evenly-spaced points, report progress, and
  // either resume or (if cancelled) bail out leaving the context paused.
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

  // Pull channel data out so we can fold/trim before encoding.
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(rendered.getChannelData(c).slice());

  let outFrames: number;
  if (opts.loop) {
    // Seamless loop: keep exactly the loop body, and add the overflow tail
    // (notes still ringing past the loop end) back onto the start — so when the
    // clip wraps end->start in Unity, decaying voices continue uninterrupted.
    outFrames = Math.floor(loopSec * sampleRate);
    for (const ch of data) {
      const tailFrames = Math.min(ch.length - outFrames, outFrames);
      for (let i = 0; i < tailFrames; i++) ch[i] += ch[outFrames + i];
    }
  } else {
    // One-shot: keep the full render including the natural decay tail.
    outFrames = rendered.length;
  }

  return encodeWav(data, outFrames, sampleRate);
}

function encodeWav(channels: Float32Array[], numFrames: number, sampleRate: number): Blob {
  const numCh = channels.length;

  // Peak-normalize to -0.3 dBFS over the frames we are keeping. (Synthesized
  // silence is true zero, so there is no noise floor to amplify.)
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

import * as Tone from "tone";
import { secondsPerRow, type Song } from "../model/song";
import { createMasterBus, createVoice, type MasterBus, type Voice } from "./voices";

// Live playback engine. Builds one Voice per track (every track, not just the
// audible ones) behind a per-track gain "gate", schedules the cropped notes on
// Tone's Transport, and reports the playhead row via requestAnimationFrame.
// Building all tracks up front means Mute/Solo can take effect instantly —
// toggling just ramps a gate's gain rather than rescheduling.

type TransportState = "stopped" | "playing" | "paused";

interface TrackNode {
  voice: Voice;
  gate: Tone.Gain;
}

let nodes: TrackNode[] = [];
let masterBus: MasterBus | null = null;
let rafId = 0;
let state: TransportState = "stopped";

// Held so resume() can restart the playhead loop with the original callback.
let ctx: { song: Song; spr: number; start: number; onRow: (row: number) => void } | null = null;

export function isPlaying() {
  return state === "playing";
}
export function isPaused() {
  return state === "paused";
}

// Audible = soloed tracks if any are soloed, otherwise all non-muted tracks.
function applyMix(song: Song) {
  const anySolo = song.tracks.some((t) => t.solo);
  song.tracks.forEach((t, i) => {
    const audible = anySolo ? t.solo : !t.muted;
    nodes[i]?.gate.gain.rampTo(audible ? 1 : 0, 0.02);
  });
}

// Live update of Mute/Solo while playing or paused.
export function updateMix(song: Song) {
  if (state !== "stopped") applyMix(song);
}

export async function play(
  song: Song,
  onRow: (row: number) => void,
  onEnd: () => void,
  loop: boolean,
): Promise<void> {
  await Tone.start();
  stop();

  const transport = Tone.getTransport();
  const spr = secondsPerRow(song);
  const start = song.cropStart;
  const end = song.cropEnd;
  const spanSec = (end - start) * spr;
  ctx = { song, spr, start, onRow };

  masterBus = createMasterBus();
  nodes = song.tracks.map((track) => {
    const gate = new Tone.Gain(0).connect(masterBus!.input);
    const voice = createVoice(track.voice, gate);
    return { voice, gate };
  });

  song.tracks.forEach((track, i) => {
    const { voice } = nodes[i];
    for (const note of track.notes) {
      if (note.row < start || note.row >= end) continue;
      const t = (note.row - start) * spr;
      const durSec = Math.max(0.03, note.lenRows * spr * 0.95);
      transport.schedule((time) => {
        voice.trigger(note.midi, durSec, time, note.velocity);
      }, t);
    }
  });
  applyMix(song);

  transport.loop = loop;
  transport.loopStart = 0;
  transport.loopEnd = spanSec;
  transport.position = 0;
  state = "playing";

  if (!loop) {
    transport.schedule(() => {
      Tone.getDraw().schedule(() => stopInternal(onEnd), Tone.now());
    }, spanSec + 0.05);
  }

  transport.start();
  startTick();
}

function startTick() {
  const tick = () => {
    if (state !== "playing" || !ctx) return;
    const transport = Tone.getTransport();
    ctx.onRow(ctx.start + transport.seconds / ctx.spr);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

export function pause() {
  if (state !== "playing") return;
  Tone.getTransport().pause();
  state = "paused";
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

export function resume() {
  if (state !== "paused") return;
  Tone.getTransport().start();
  state = "playing";
  startTick();
}

function clearNodes() {
  nodes.forEach((n) => {
    n.voice.dispose();
    n.gate.dispose();
  });
  nodes = [];
  masterBus?.dispose();
  masterBus = null;
}

function stopInternal(onEnd?: () => void) {
  const transport = Tone.getTransport();
  transport.stop();
  transport.cancel();
  transport.loop = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  state = "stopped";
  ctx = null;
  clearNodes();
  onEnd?.();
}

export function stop() {
  stopInternal();
}

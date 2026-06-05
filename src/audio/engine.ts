import * as Tone from "tone";
import { secondsPerRow, type Song } from "../model/song";
import { createMasterBus, createVoice, type MasterBus, type Voice } from "./voices";

// Live playback engine. Builds one raw-Web-Audio Voice per track behind a
// per-track gain "gate", scheduled on Tone's Transport (kept for its tidy
// pause/resume/loop). Building all tracks up front means Mute/Solo take effect
// instantly — toggling just ramps a gate's gain instead of rescheduling.

type TransportState = "stopped" | "playing" | "paused";

interface TrackNode {
  voice: Voice;
  gate: GainNode;
}

let nodes: TrackNode[] = [];
let masterBus: MasterBus | null = null;
let audioCtx: BaseAudioContext | null = null;
let rafId = 0;
let state: TransportState = "stopped";

let ctx: { song: Song; spr: number; start: number; onRow: (row: number) => void } | null = null;

export function isPlaying() {
  return state === "playing";
}
export function isPaused() {
  return state === "paused";
}

function applyMix(song: Song) {
  const anySolo = song.tracks.some((t) => t.solo);
  const now = audioCtx?.currentTime ?? 0;
  song.tracks.forEach((t, i) => {
    const audible = anySolo ? t.solo : !t.muted;
    nodes[i]?.gate.gain.setTargetAtTime(audible ? 1 : 0, now, 0.012);
  });
}

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
  const rawCtx = Tone.getContext().rawContext as BaseAudioContext;
  audioCtx = rawCtx;
  const spr = secondsPerRow(song);
  const start = song.cropStart;
  const end = song.cropEnd;
  const spanSec = (end - start) * spr;
  ctx = { song, spr, start, onRow };

  masterBus = createMasterBus(rawCtx);
  nodes = song.tracks.map((track) => {
    const gate = rawCtx.createGain();
    gate.gain.value = 0;
    gate.connect(masterBus!.input);
    const voice = createVoice(track.voice, rawCtx, gate);
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
    n.gate.disconnect();
  });
  nodes = [];
  masterBus?.dispose();
  masterBus = null;
  audioCtx = null;
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

import * as Tone from "tone";
import { buildSchedule, secondsPerRow, type Schedule, type Song } from "../model/song";
import { createMasterBus, type MasterBus, type Voice } from "./voices";
import { createVoice } from "./fonts";

// Live playback engine. One raw-Web-Audio Voice per track behind a per-track
// gain "gate" (whose level is the track volume, or 0 when muted/un-soloed), all
// scheduled on Tone's Transport. Playback always loops over the compacted
// timeline (skipped rows removed). Mute/Solo/volume take effect instantly by
// ramping the gates; the minimap can seek by moving the transport.

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

let ctx:
  | { song: Song; spr: number; schedule: Schedule; onRow: (row: number) => void }
  | null = null;

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
    nodes[i]?.gate.gain.setTargetAtTime(audible ? t.volume : 0, now, 0.012);
  });
}

// Live update of Mute / Solo / volume while playing or paused.
export function updateMix(song: Song) {
  if (state !== "stopped") applyMix(song);
}

export async function play(song: Song, onRow: (row: number) => void): Promise<void> {
  await Tone.start();
  stop();

  const transport = Tone.getTransport();
  const rawCtx = Tone.getContext().rawContext as BaseAudioContext;
  audioCtx = rawCtx;
  const spr = secondsPerRow(song);
  const schedule = buildSchedule(song);
  ctx = { song, spr, schedule, onRow };

  masterBus = createMasterBus(rawCtx);
  nodes = song.tracks.map((track) => {
    const gate = rawCtx.createGain();
    gate.gain.value = 0;
    gate.connect(masterBus!.input);
    const voice = createVoice(track.patch, rawCtx, gate);
    return { voice, gate };
  });

  scheduleAll();
  applyMix(song);

  transport.loop = true; // always loop the compacted timeline
  transport.loopStart = 0;
  transport.loopEnd = Math.max(spr, schedule.totalSec);
  transport.position = 0;
  state = "playing";

  transport.start();
  startTick();
}

// Arm the transport with the current schedule. Callbacks read nodes[i].voice
// dynamically so a live voice swap (refreshVoice) affects subsequent notes.
function scheduleAll() {
  if (!ctx) return;
  const transport = Tone.getTransport();
  ctx.schedule.tracks.forEach((notes, i) => {
    for (const note of notes) {
      transport.schedule((time) => {
        nodes[i]?.voice.trigger(note.midi, note.durSec, time, note.velocity);
      }, note.time);
    }
  });
}

// Live swap a track's voice (timbre) without stopping playback. The persistent
// oscillator pool is rebuilt on the same gate; in-flight notes from the old
// voice cut off, subsequent notes use the new timbre.
export function refreshVoice(trackIndex: number) {
  if (state === "stopped" || !ctx || !audioCtx) return;
  const node = nodes[trackIndex];
  if (!node) return;
  node.voice.dispose();
  node.voice = createVoice(ctx.song.tracks[trackIndex].patch, audioCtx, node.gate);
}

// Live rebuild of the timeline after a skip-rail edit: recompute the compacted
// schedule, re-arm the transport, and re-place the playhead on the same content.
export function reschedule(song: Song) {
  if (state === "stopped" || !ctx) return;
  const transport = Tone.getTransport();
  const currentRow = compactedToRow(ctx);
  ctx.song = song;
  ctx.schedule = buildSchedule(song);
  transport.cancel();
  scheduleAll();
  transport.loopEnd = Math.max(ctx.spr, ctx.schedule.totalSec);
  seek(currentRow);
}

// Map the transport's compacted-timeline position back to an original row for
// the playhead/minimap (which display the un-compacted song).
function compactedToRow(c: { spr: number; schedule: Schedule }): number {
  const rows = c.schedule.activeRows;
  if (rows.length === 0) return 0;
  const pos = Tone.getTransport().seconds / c.spr;
  const idx = Math.min(rows.length - 1, Math.max(0, Math.floor(pos)));
  return rows[idx] + (pos - idx);
}

function startTick() {
  const tick = () => {
    if (state !== "playing" || !ctx) return;
    ctx.onRow(compactedToRow(ctx));
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// Seek to (the nearest enabled row to) an original row index. Used by the
// minimap scrubber; moves the transport so it works while playing or paused.
export function seek(originalRow: number) {
  if (!ctx) return;
  const { schedule, spr } = ctx;
  const n = schedule.newIndexOf.length;
  let r = Math.max(0, Math.min(n - 1, Math.round(originalRow)));
  let idx = schedule.newIndexOf[r];
  if (idx < 0) {
    for (let d = 1; d < n; d++) {
      if (r + d < n && schedule.newIndexOf[r + d] >= 0) { idx = schedule.newIndexOf[r + d]; break; }
      if (r - d >= 0 && schedule.newIndexOf[r - d] >= 0) { idx = schedule.newIndexOf[r - d]; break; }
    }
  }
  if (idx < 0) return;
  Tone.getTransport().seconds = idx * spr;
  ctx.onRow(compactedToRow(ctx));
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

export function stop() {
  const transport = Tone.getTransport();
  transport.stop();
  transport.cancel();
  transport.loop = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  state = "stopped";
  ctx = null;
  clearNodes();
}

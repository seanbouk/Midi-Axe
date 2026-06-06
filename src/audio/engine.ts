import { buildSchedule, secondsPerRow, type Schedule, type Song } from "../model/song";
import { createMasterBus, type MasterBus, type Voice } from "./voices";
import { createVoice, getCurrentFont } from "./fonts";

// Live playback engine on a plain native AudioContext (NOT Tone — Tone wraps the
// context with standardized-audio-context, whose nodes lack `detune` and reject
// the native AudioWorkletNode constructor; the FM worklet needs a real context).
// One Voice per track behind a per-track gain "gate"; playback always loops the
// compacted timeline. A lookahead scheduler arms notes ~120ms ahead, which keeps
// seeking cheap (only that window is ever pre-scheduled).

type TransportState = "stopped" | "playing" | "paused";
type Ev = { track: number; time: number; dur: number; midi: number; vel: number };

let ac: AudioContext | null = null;
let nodes: { voice: Voice; gate: GainNode }[] = [];
let masterBus: MasterBus | null = null;
let state: TransportState = "stopped";

let events: Ev[] = [];
let evIndex = 0;
let loopDur = 0;
let iterStart = 0; // ac time of the current loop iteration's logical 0 (advances)
let playStart = 0; // ac time of logical 0 for the playhead (fixed while playing)
let schedTimer = 0;
let rafId = 0;

let ctx: { song: Song; spr: number; schedule: Schedule; onRow: (row: number) => void } | null = null;

const LOOKAHEAD = 0.12; // seconds scheduled ahead
const SCHED_MS = 25;

function getAC(): AudioContext {
  if (!ac) ac = new AudioContext();
  return ac;
}

export function isPlaying() {
  return state === "playing";
}
export function isPaused() {
  return state === "paused";
}

function applyMix(song: Song) {
  const now = getAC().currentTime;
  const anySolo = song.tracks.some((t) => t.solo);
  song.tracks.forEach((t, i) => {
    const audible = anySolo ? t.solo : !t.muted;
    nodes[i]?.gate.gain.setTargetAtTime(audible ? t.volume : 0, now, 0.012);
  });
}

export function updateMix(song: Song) {
  if (state !== "stopped") applyMix(song);
}

function buildEvents(schedule: Schedule) {
  events = [];
  schedule.tracks.forEach((notes, i) => {
    for (const n of notes) events.push({ track: i, time: n.time, dur: n.durSec, midi: n.midi, vel: n.velocity });
  });
  events.sort((a, b) => a.time - b.time);
  loopDur = Math.max(ctx!.spr, schedule.totalSec);
}

// schedule everything due before the lookahead horizon, wrapping at the loop end
function scheduleAhead() {
  if (state !== "playing" || !ctx || events.length === 0) return;
  const horizon = getAC().currentTime + LOOKAHEAD;
  for (let guard = 0; guard < events.length * 2 + 4; guard++) {
    if (evIndex >= events.length) {
      iterStart += loopDur;
      evIndex = 0;
    }
    const e = events[evIndex];
    const at = iterStart + e.time;
    if (at > horizon) break;
    nodes[e.track]?.voice.trigger(e.midi, e.dur, Math.max(at, getAC().currentTime), e.vel);
    evIndex++;
  }
}

function firstEventAtOrAfter(t: number) {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function play(song: Song, onRow: (row: number) => void): Promise<void> {
  stop();
  const cur = getAC();
  await cur.resume();
  const spr = secondsPerRow(song);
  const schedule = buildSchedule(song);
  ctx = { song, spr, schedule, onRow };

  // FM AudioWorklet module must be loaded before its voices are created
  await getCurrentFont().prepare?.(cur);

  masterBus = createMasterBus(cur);
  nodes = song.tracks.map((track) => {
    const gate = cur.createGain();
    gate.gain.value = 0;
    gate.connect(masterBus!.input);
    return { voice: createVoice(track.patch, cur, gate), gate };
  });
  applyMix(song);

  buildEvents(schedule);
  state = "playing";

  await getCurrentFont().ready?.(); // MIDI sample loads
  if (state !== "playing") return;

  iterStart = playStart = cur.currentTime + 0.08;
  evIndex = 0;
  scheduleAhead();
  schedTimer = window.setInterval(scheduleAhead, SCHED_MS);
  startTick();
}

// compacted-timeline position (seconds) -> original row for the playhead
function rowAt(posSec: number): number {
  const rows = ctx!.schedule.activeRows;
  if (rows.length === 0) return 0;
  const pos = posSec / ctx!.spr;
  const idx = Math.min(rows.length - 1, Math.max(0, Math.floor(pos)));
  return rows[idx] + (pos - idx);
}

function startTick() {
  const tick = () => {
    if (state !== "playing" || !ctx) return;
    let elapsed = getAC().currentTime - playStart;
    if (elapsed < 0) elapsed = 0;
    ctx.onRow(rowAt(elapsed % loopDur));
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

// Live swap a track's voice (timbre) without stopping playback.
export function refreshVoice(trackIndex: number) {
  if (state === "stopped" || !ctx || !ac) return;
  const node = nodes[trackIndex];
  if (!node) return;
  node.voice.dispose();
  node.voice = createVoice(ctx.song.tracks[trackIndex].patch, ac, node.gate);
}

// Live rebuild of the timeline after a skip-rail edit; keeps the playhead in place.
export function reschedule(song: Song) {
  if (state === "stopped" || !ctx) return;
  const pos = ((getAC().currentTime - playStart) % loopDur) || 0;
  ctx.song = song;
  ctx.schedule = buildSchedule(song);
  buildEvents(ctx.schedule);
  const clamped = Math.min(pos, loopDur);
  iterStart = playStart = getAC().currentTime - clamped;
  evIndex = firstEventAtOrAfter(clamped);
}

// Seek to the nearest enabled row; works while playing or paused.
export function seek(originalRow: number) {
  if (!ctx) return;
  const { schedule, spr } = ctx;
  const n = schedule.newIndexOf.length;
  const r = Math.max(0, Math.min(n - 1, Math.round(originalRow)));
  let idx = schedule.newIndexOf[r];
  if (idx < 0) {
    for (let d = 1; d < n; d++) {
      if (r + d < n && schedule.newIndexOf[r + d] >= 0) { idx = schedule.newIndexOf[r + d]; break; }
      if (r - d >= 0 && schedule.newIndexOf[r - d] >= 0) { idx = schedule.newIndexOf[r - d]; break; }
    }
  }
  if (idx < 0) return;
  const target = idx * spr;
  iterStart = playStart = getAC().currentTime - target;
  evIndex = firstEventAtOrAfter(target);
  ctx.onRow(rowAt(target));
}

export function pause() {
  if (state !== "playing") return;
  void getAC().suspend();
  state = "paused";
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

export function resume() {
  if (state !== "paused") return;
  void getAC().resume();
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
}

export function stop() {
  if (schedTimer) { clearInterval(schedTimer); schedTimer = 0; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (ac && ac.state === "suspended") void ac.resume(); // un-suspend for next play
  state = "stopped";
  ctx = null;
  events = [];
  evIndex = 0;
  clearNodes();
}

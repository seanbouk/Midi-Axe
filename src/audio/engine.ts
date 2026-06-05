import * as Tone from "tone";
import { audibleTracks, secondsPerRow, type Song } from "../model/song";
import { createMasterBus, createVoice, type MasterBus, type Voice } from "./voices";

// Live playback engine. Builds one Voice per audible track, schedules the
// (cropped) notes on Tone's Transport, and reports the current playhead row via
// requestAnimationFrame so the tracker view can scroll/highlight in time.

let voices: Voice[] = [];
let masterBus: MasterBus | null = null;
let rafId = 0;
let playing = false;

function clearVoices() {
  voices.forEach((v) => v.dispose());
  voices = [];
  masterBus?.dispose();
  masterBus = null;
}

export function isPlaying() {
  return playing;
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

  masterBus = createMasterBus();
  const tracks = audibleTracks(song);
  for (const track of tracks) {
    const voice = createVoice(track.voice, masterBus.input);
    voices.push(voice);
    for (const note of track.notes) {
      if (note.row < start || note.row >= end) continue;
      const t = (note.row - start) * spr;
      const durSec = Math.max(0.03, note.lenRows * spr * 0.95);
      transport.schedule((time) => {
        voice.trigger(note.midi, durSec, time, note.velocity);
      }, t);
    }
  }

  transport.loop = loop;
  transport.loopStart = 0;
  transport.loopEnd = spanSec;
  transport.position = 0;
  playing = true;

  if (!loop) {
    transport.schedule(() => {
      Tone.getDraw().schedule(() => stopInternal(onEnd), Tone.now());
    }, spanSec + 0.05);
  }

  const tick = () => {
    if (!playing) return;
    const row = start + transport.seconds / spr;
    onRow(row);
    rafId = requestAnimationFrame(tick);
  };

  transport.start();
  rafId = requestAnimationFrame(tick);
}

function stopInternal(onEnd?: () => void) {
  const transport = Tone.getTransport();
  transport.stop();
  transport.cancel();
  transport.loop = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  playing = false;
  clearVoices();
  onEnd?.();
}

export function stop() {
  stopInternal();
}

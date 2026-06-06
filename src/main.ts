import "./style.css";
import { parseMidi } from "./midi/parse";
import { VOICE_ORDER, type Song } from "./model/song";
import { TrackerView, GUTTER_W, COL_W } from "./tracker/render";
import { Minimap } from "./tracker/minimap";
import { isPaused, isPlaying, pause, play, refreshVoice, reschedule, resume, seek, stop, updateMix } from "./audio/engine";
import { renderWav } from "./audio/exportWav";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $("tracker") as HTMLCanvasElement;
const view = new TrackerView(canvas);
const minimap = new Minimap($("minimap") as HTMLCanvasElement);

const fileInput = $("file") as HTMLInputElement;
const songInfo = $("songinfo");
const playBtn = $("play") as HTMLButtonElement;
const pauseBtn = $("pause") as HTMLButtonElement;
const stopBtn = $("stop") as HTMLButtonElement;
const exportBtn = $("export") as HTMLButtonElement;
const rpbSelect = $("rpb") as HTMLSelectElement;
const wrap = $("tracker-wrap");

let song: Song | null = null;
let lastBuffer: ArrayBuffer | null = null;
let lastName = "song";

// Redraw both the tracker and the minimap (minimap mirrors the visible window
// and playhead, so they must stay in sync).
function drawAll() {
  view.draw();
  minimap.draw(view.scrollRow, view.visibleRows(), view.playRow);
}

// ---- loading ----
function loadBuffer(buffer: ArrayBuffer, name: string) {
  lastBuffer = buffer;
  lastName = name;
  const rpb = parseInt(rpbSelect.value, 10);
  song = parseMidi(buffer, name, rpb);
  view.song = song;
  view.scrollRow = 0;
  view.scrollX = 0;
  view.playRow = -1;
  minimap.setSong(song);
  drawAll();
  songInfo.textContent = `${song.name} — ${song.tracks.length} tracks, ${song.bpm.toFixed(0)} bpm, ${song.lengthRows} rows`;
  songInfo.classList.remove("muted");
  exportBtn.disabled = false;
  setTransport("stopped");
}

// Enable/disable transport buttons for the current state. Play doubles as the
// resume control when paused.
function setTransport(s: "stopped" | "playing" | "paused") {
  if (!song) return;
  playBtn.disabled = s === "playing";
  pauseBtn.disabled = s !== "playing";
  stopBtn.disabled = s === "stopped";
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  loadBuffer(await file.arrayBuffer(), file.name);
});

// drag & drop
wrap.addEventListener("dragover", (e) => {
  e.preventDefault();
  wrap.classList.add("dragover");
});
wrap.addEventListener("dragleave", () => wrap.classList.remove("dragover"));
wrap.addEventListener("drop", async (e) => {
  e.preventDefault();
  wrap.classList.remove("dragover");
  const file = e.dataTransfer?.files?.[0];
  if (file) loadBuffer(await file.arrayBuffer(), file.name);
});

rpbSelect.addEventListener("change", () => {
  if (lastBuffer) {
    stopPlayback();
    loadBuffer(lastBuffer, lastName);
  }
});

// ---- scrolling ----
wrap.addEventListener(
  "wheel",
  (e) => {
    if (!song) return;
    e.preventDefault();
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horizontal) {
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      view.scrollX = Math.max(0, Math.min(view.maxScrollX(), view.scrollX + d));
    } else {
      view.scrollRow = Math.max(0, Math.min(view.maxScroll(), view.scrollRow + e.deltaY / 16));
    }
    drawAll();
  },
  { passive: false },
);

// ---- pointer interaction on the tracker -----------------------------------
type Drag = "none" | "skip" | "volume" | "minimap";
let drag: Drag = "none";
let paintSkip = false; // value the skip-paint drag is applying
let lastSkipRow = -1;
let dragTrack = -1; // track whose volume is being dragged
let soloTrack = -1; // track held for momentary solo

function localXY(e: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function clampRow(r: number) {
  if (!song) return 0;
  return Math.max(0, Math.min(song.lengthRows - 1, r));
}

function volumeFracAt(x: number, trackIndex: number) {
  const localX = x - GUTTER_W + view.scrollX - trackIndex * COL_W;
  return Math.max(0, Math.min(1, (localX - 6) / (COL_W - 12)));
}

canvas.addEventListener("mousedown", (e) => {
  if (!song) return;
  const { x, y } = localXY(e);
  const hit = view.headerHit(x, y);
  if (hit) {
    const t = song.tracks[hit.track];
    if (hit.type === "mute") {
      t.muted = !t.muted;
      updateMix(song);
    } else if (hit.type === "solo") {
      // momentary: solo only while held
      t.solo = true;
      soloTrack = hit.track;
      updateMix(song);
    } else if (hit.type === "voice") {
      const i = VOICE_ORDER.indexOf(t.voice);
      t.voice = VOICE_ORDER[(i + 1) % VOICE_ORDER.length];
      refreshVoice(hit.track); // apply the new timbre live
    } else if (hit.type === "volume") {
      t.volume = hit.frac;
      drag = "volume";
      dragTrack = hit.track;
      updateMix(song);
    }
    drawAll();
    return;
  }
  // skip rail: paint rows enabled/disabled
  if (view.inSkipRail(x, y)) {
    const row = clampRow(view.rowAtY(y));
    paintSkip = !song.skipped[row]; // toggle target
    song.skipped[row] = paintSkip;
    lastSkipRow = row;
    drag = "skip";
    drawAll();
  }
});

window.addEventListener("mousemove", (e) => {
  if (!song) return;
  if (drag === "skip") {
    const { y } = localXY(e);
    const row = clampRow(view.rowAtY(y));
    // fill every row between the last painted one and here
    const lo = Math.min(lastSkipRow, row);
    const hi = Math.max(lastSkipRow, row);
    for (let r = lo; r <= hi; r++) song.skipped[r] = paintSkip;
    lastSkipRow = row;
    drawAll();
  } else if (drag === "volume") {
    const { x } = localXY(e);
    song.tracks[dragTrack].volume = volumeFracAt(x, dragTrack);
    updateMix(song);
    drawAll();
  } else if (drag === "minimap") {
    scrubTo(e.clientX);
  }
});

window.addEventListener("mouseup", () => {
  const wasSkip = drag === "skip";
  drag = "none";
  // apply skip-rail edits to the running playback once the drag ends
  if (wasSkip && song) reschedule(song);
  if (soloTrack >= 0 && song) {
    song.tracks[soloTrack].solo = false;
    soloTrack = -1;
    updateMix(song);
    drawAll();
  }
});

// ---- minimap scrub ----------------------------------------------------------
function scrubTo(clientX: number) {
  if (!song) return;
  const row = minimap.rowAtX(clientX);
  view.scrollRow = Math.max(0, Math.min(view.maxScroll(), row - view.visibleRows() / 2));
  if (isPlaying() || isPaused()) {
    seek(row);
    view.playRow = row;
  }
  drawAll();
}
minimap.canvas.addEventListener("mousedown", (e) => {
  if (!song) return;
  drag = "minimap";
  scrubTo(e.clientX);
});

// ---- transport ----
playBtn.addEventListener("click", async () => {
  if (!song || isPlaying()) return;
  if (isPaused()) {
    resume();
    setTransport("playing");
    return;
  }
  setTransport("playing");
  await play(song, (row) => {
    view.playRow = row;
    view.ensureRowVisible(row);
    drawAll();
  });
});

pauseBtn.addEventListener("click", () => {
  if (!isPlaying()) return;
  pause();
  setTransport("paused");
});

function stopPlayback() {
  stop();
  view.playRow = -1;
  setTransport("stopped");
  drawAll();
}
stopBtn.addEventListener("click", stopPlayback);

// While rendering, the Export button doubles as a Cancel button.
let exportAbort: AbortController | null = null;

exportBtn.addEventListener("click", async () => {
  if (!song) return;
  if (exportAbort) {
    exportAbort.abort();
    return;
  }
  exportAbort = new AbortController();
  exportBtn.textContent = "✕ Cancel (0%)";
  try {
    const blob = await renderWav(song, {
      signal: exportAbort.signal,
      onProgress: (p) => {
        exportBtn.textContent = `✕ Cancel (${Math.round(p * 100)}%)`;
      },
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${song.name}-chiptune.wav`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "AbortError")) throw e;
  } finally {
    exportAbort = null;
    exportBtn.textContent = "⬇ Export WAV";
  }
});

// ---- resize ----
window.addEventListener("resize", () => {
  view.resize();
  minimap.resize();
  drawAll();
});
view.resize();
minimap.resize();

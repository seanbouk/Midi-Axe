import "./style.css";
import { parseMidi } from "./midi/parse";
import { VOICE_ORDER, type Song } from "./model/song";
import { TrackerView, GUTTER_W, HEADER_H } from "./tracker/render";
import { isPaused, isPlaying, pause, play, resume, stop, updateMix } from "./audio/engine";
import { renderWav } from "./audio/exportWav";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $("tracker") as HTMLCanvasElement;
const view = new TrackerView(canvas);

const fileInput = $("file") as HTMLInputElement;
const songInfo = $("songinfo");
const playBtn = $("play") as HTMLButtonElement;
const pauseBtn = $("pause") as HTMLButtonElement;
const stopBtn = $("stop") as HTMLButtonElement;
const exportBtn = $("export") as HTMLButtonElement;
const rpbSelect = $("rpb") as HTMLSelectElement;
const loopCheck = $("loop") as HTMLInputElement;
const loopExportCheck = $("loopexport") as HTMLInputElement;
const wrap = $("tracker-wrap");

let song: Song | null = null;
let lastBuffer: ArrayBuffer | null = null;
let lastName = "song";

// ---- loading ----
function loadBuffer(buffer: ArrayBuffer, name: string) {
  lastBuffer = buffer;
  lastName = name;
  const rpb = parseInt(rpbSelect.value, 10);
  song = parseMidi(buffer, name, rpb);
  view.song = song;
  view.scrollRow = 0;
  view.playRow = -1;
  view.draw();
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
    // shift+wheel or horizontal trackpad => scroll columns; otherwise rows
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horizontal) {
      const d = e.shiftKey ? e.deltaY : e.deltaX;
      view.scrollX = Math.max(0, Math.min(view.maxScrollX(), view.scrollX + d));
    } else {
      view.scrollRow = Math.max(
        0,
        Math.min(view.maxScroll(), view.scrollRow + e.deltaY / 16),
      );
    }
    view.draw();
  },
  { passive: false },
);

// ---- header clicks (mute / solo / voice) + crop drag in gutter ----
let dragging = false;
let dragAnchor = 0;

canvas.addEventListener("mousedown", (e) => {
  if (!song) return;
  const { x, y } = localXY(e);
  const hit = view.headerHit(x, y);
  if (hit) {
    const t = song.tracks[hit.track];
    if (hit.type === "mute") {
      t.muted = !t.muted;
      updateMix(song); // takes effect immediately during playback
    } else if (hit.type === "solo") {
      t.solo = !t.solo;
      updateMix(song);
    } else if (hit.type === "voice") {
      const idx = VOICE_ORDER.indexOf(t.voice);
      t.voice = VOICE_ORDER[(idx + 1) % VOICE_ORDER.length];
      // voice timbre is bound when playback starts; a restart applies the change
    }
    view.draw();
    return;
  }
  // crop drag starts in the row-number gutter
  if (x < GUTTER_W && y > HEADER_H) {
    dragging = true;
    dragAnchor = clampRow(view.rowAtY(y));
    song.cropStart = dragAnchor;
    song.cropEnd = dragAnchor;
    view.draw();
  }
});

window.addEventListener("mousemove", (e) => {
  if (!dragging || !song) return;
  const { y } = localXY(e);
  const row = clampRow(view.rowAtY(y));
  song.cropStart = Math.min(dragAnchor, row);
  song.cropEnd = Math.max(dragAnchor, row) + 1;
  view.draw();
});

window.addEventListener("mouseup", () => {
  if (!dragging || !song) return;
  dragging = false;
  // a click with no drag clears the crop back to the whole song
  if (song.cropEnd - song.cropStart <= 1) {
    song.cropStart = 0;
    song.cropEnd = song.lengthRows;
  }
  view.draw();
});

function clampRow(r: number) {
  if (!song) return 0;
  return Math.max(0, Math.min(song.lengthRows, r));
}

function localXY(e: MouseEvent) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

// ---- transport ----
playBtn.addEventListener("click", async () => {
  if (!song || isPlaying()) return;
  if (isPaused()) {
    resume();
    setTransport("playing");
    return;
  }
  setTransport("playing");
  await play(
    song,
    (row) => {
      view.playRow = row;
      view.ensureRowVisible(row);
      view.draw();
    },
    () => {
      view.playRow = -1;
      setTransport("stopped");
      view.draw();
    },
    loopCheck.checked,
  );
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
  view.draw();
}
stopBtn.addEventListener("click", stopPlayback);

// While rendering, the Export button doubles as a Cancel button (clicking it
// aborts the in-progress render) and shows live progress.
let exportAbort: AbortController | null = null;

exportBtn.addEventListener("click", async () => {
  if (!song) return;
  if (exportAbort) {
    exportAbort.abort();
    return;
  }
  exportAbort = new AbortController();
  const loop = loopExportCheck.checked;
  exportBtn.textContent = "✕ Cancel (0%)";
  try {
    const blob = await renderWav(song, {
      loop,
      signal: exportAbort.signal,
      onProgress: (p) => {
        exportBtn.textContent = `✕ Cancel (${Math.round(p * 100)}%)`;
      },
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${song.name}-chiptune${loop ? "-loop" : ""}.wav`;
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
window.addEventListener("resize", () => view.resize());
view.resize();

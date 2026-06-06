// Standalone sound-debug page (/debug.html). Audition every patch of every
// sound font at a range of notes, see the waveform/spectrum, measure raw
// per-patch levels, and copy a structured report to paste back as feedback.
// Not linked from the main app — open /debug.html directly.

import { noteName } from "./model/song";
import { createMasterBus, type Voice } from "./audio/voices";
import { createVoice, getCurrentFont, listFonts, patchLabel, setCurrentFont } from "./audio/fonts";
import { applyTheme } from "./audio/theme";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fontSel = $("font") as HTMLSelectElement;
const holdSel = $("hold") as HTMLSelectElement;
const grid = $("grid");
const levelsEl = $("levels");
const scope = $("scope") as HTMLCanvasElement;
const spec = $("spec") as HTMLCanvasElement;

const NOTES = [48, 52, 55, 60, 64, 67, 72]; // C3 E3 G3 C4 E4 G4 C5
// A representative subset for the (huge) MIDI font; other fonts show all patches.
const MIDI_SHOWCASE = [
  "acoustic_grand_piano", "electric_piano_1", "drawbar_organ", "acoustic_guitar_steel",
  "electric_bass_finger", "string_ensemble_1", "brass_section", "alto_sax",
  "flute", "lead_2_sawtooth", "pad_2_warm", "drums",
];

function displayedPatches(): string[] {
  const f = getCurrentFont();
  return f.id === "midi" ? MIDI_SHOWCASE : f.patches.map((p) => p.id);
}

// --- live audio ----------------------------------------------------------
let ctx: AudioContext | null = null;
let mon: GainNode;
let analyser: AnalyserNode;
const voices = new Map<string, Voice>();

function ensureAudio() {
  if (ctx) return;
  ctx = new AudioContext();
  mon = ctx.createGain();
  mon.gain.value = 0.9;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  mon.connect(analyser);
  analyser.connect(ctx.destination);
  requestAnimationFrame(drawScope);
  void preloadAll();
}

function getVoice(patchId: string): Voice {
  if (!voices.has(patchId)) voices.set(patchId, createVoice(patchId, ctx!, mon));
  return voices.get(patchId)!;
}

function status(msg: string) {
  $("status").textContent = msg;
}

// Build every displayed patch's voice up front so sample-based (MIDI) patches
// download in the background — auditions then fire instantly on press.
async function preloadAll() {
  if (!ctx) return;
  status("loading…");
  await getCurrentFont().prepare?.(ctx); // FM AudioWorklet module
  displayedPatches().forEach(getVoice);
  await getCurrentFont().ready?.(); // MIDI samples
  status("");
}

function clearVoices() {
  voices.forEach((v) => v.dispose());
  voices.clear();
}

async function play(patchId: string, midi: number) {
  ensureAudio();
  await ctx!.resume();
  await getCurrentFont().prepare?.(ctx!); // ensure FM worklet module is loaded
  const v = getVoice(patchId);
  // wait only for THIS instrument's samples (oscillator voices have no .ready)
  await (v as { ready?: Promise<void> }).ready;
  const hold = parseFloat(holdSel.value);
  v.trigger(midi, hold, ctx!.currentTime + 0.02, 0.9);
}

// --- visualisation -------------------------------------------------------
function drawScope() {
  requestAnimationFrame(drawScope);
  if (!analyser) return;
  // oscilloscope
  const sc = scope.getContext("2d")!;
  const n = analyser.fftSize;
  const t = new Uint8Array(n);
  analyser.getByteTimeDomainData(t);
  sc.fillStyle = "#0c0c0c";
  sc.fillRect(0, 0, scope.width, scope.height);
  sc.strokeStyle = getVar("--accent");
  sc.lineWidth = 2;
  sc.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / n) * scope.width;
    const y = (t[i] / 255) * scope.height;
    i ? sc.lineTo(x, y) : sc.moveTo(x, y);
  }
  sc.stroke();
  // spectrum
  const sp = spec.getContext("2d")!;
  const f = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(f);
  sp.fillStyle = "#0c0c0c";
  sp.fillRect(0, 0, spec.width, spec.height);
  sp.fillStyle = getVar("--accent");
  const bins = 128; // only the lower, musically-relevant part
  const bw = spec.width / bins;
  for (let i = 0; i < bins; i++) {
    const h = (f[i] / 255) * spec.height;
    sp.fillRect(i * bw, spec.height - h, bw - 1, h);
  }
}

function getVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#e5362a";
}

// --- levels (offline render of C4 per patch) -----------------------------
const lastLevels: { id: string; label: string; peakDb: number; rmsDb: number }[] = [];

async function measurePatch(patchId: string): Promise<{ peak: number; rms: number }> {
  const dur = 0.8;
  const oc = new OfflineAudioContext(1, Math.ceil(44100 * dur), 44100);
  await getCurrentFont().prepare?.(oc); // FM/SID worklet module for this offline context
  const master = createMasterBus(oc);
  const v = createVoice(patchId, oc, master.input);
  await getCurrentFont().ready?.(); // MIDI samples must decode before triggering
  v.trigger(60, 0.5, 0.05, 0.9); // small offset so a t=0 note isn't missed
  // suspend/resume yields let worklet (FM/SID) voices receive their note message
  for (let i = 1; i < 8; i++) oc.suspend((dur * i) / 8).then(() => oc.resume());
  const buf = await oc.startRendering();
  const d = buf.getChannelData(0);
  let peak = 0, sumsq = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (a > peak) peak = a;
    sumsq += d[i] * d[i];
  }
  return { peak, rms: Math.sqrt(sumsq / d.length) };
}

const db = (x: number) => (x > 1e-5 ? 20 * Math.log10(x) : -Infinity);
const dbStr = (v: number) => (v === -Infinity ? "−∞" : v.toFixed(1));

async function measureLevels() {
  levelsEl.innerHTML = `<span class="muted">measuring…</span>`;
  lastLevels.length = 0;
  for (const id of displayedPatches()) {
    const { peak, rms } = await measurePatch(id);
    lastLevels.push({ id, label: patchLabel(id), peakDb: db(peak), rmsDb: db(rms) });
  }
  renderLevels();
}

function renderLevels() {
  levelsEl.innerHTML = "";
  for (const l of lastLevels) {
    const w = Math.max(0, Math.min(100, ((l.peakDb + 40) / 40) * 100)); // -40..0 dB -> 0..100%
    const row = document.createElement("div");
    row.className = "lv";
    row.innerHTML =
      `<span class="patch">${l.label}</span>` +
      `<span class="barbg"><span class="bar" style="width:${w}%"></span></span>` +
      `<span>${dbStr(l.peakDb)} · ${dbStr(l.rmsDb)} dB</span>`;
    levelsEl.appendChild(row);
  }
}

// --- grid ----------------------------------------------------------------
function buildGrid() {
  const table = document.createElement("table");
  const head = document.createElement("tr");
  head.innerHTML = `<th class="patch">patch \\ note</th>` + NOTES.map((m) => `<th>${noteName(m)}</th>`).join("");
  table.appendChild(head);
  for (const id of displayedPatches()) {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    name.className = "patch";
    name.textContent = patchLabel(id);
    tr.appendChild(name);
    for (const m of NOTES) {
      const td = document.createElement("td");
      const b = document.createElement("button");
      b.className = "cell";
      b.textContent = "▶";
      b.onpointerdown = () => play(id, m); // fire on press, not release
      td.appendChild(b);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  grid.innerHTML = "";
  grid.appendChild(table);
}

// --- wiring --------------------------------------------------------------
for (const f of listFonts()) {
  const o = document.createElement("option");
  o.value = f.id;
  o.textContent = f.label;
  fontSel.appendChild(o);
}
fontSel.value = getCurrentFont().id;
applyTheme(getCurrentFont().theme);
buildGrid();
// Start audio + preload samples on page load (context starts suspended; the
// first press just resumes it), so there's no slow first note.
ensureAudio();

fontSel.addEventListener("change", () => {
  setCurrentFont(fontSel.value); // swaps theme + current font
  clearVoices();
  buildGrid();
  levelsEl.innerHTML = `<span class="muted">click “Measure levels”.</span>`;
  lastLevels.length = 0;
  void preloadAll(); // warm up the new font's samples (no-op if audio not started)
});

$("measure").addEventListener("click", () => void measureLevels());

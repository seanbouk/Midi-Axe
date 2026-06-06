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
const notesEl = $("notes") as HTMLTextAreaElement;
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
}

function clearVoices() {
  voices.forEach((v) => v.dispose());
  voices.clear();
}

async function play(patchId: string, midi: number) {
  ensureAudio();
  await ctx!.resume();
  if (!voices.has(patchId)) voices.set(patchId, createVoice(patchId, ctx!, mon));
  await getCurrentFont().ready?.(); // load samples for MIDI patches
  const hold = parseFloat(holdSel.value);
  voices.get(patchId)!.trigger(midi, hold, ctx!.currentTime + 0.06, 0.9);
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
  const oc = new OfflineAudioContext(1, Math.ceil(44100 * 0.8), 44100);
  const master = createMasterBus(oc);
  const v = createVoice(patchId, oc, master.input);
  await getCurrentFont().ready?.(); // MIDI samples must decode before triggering
  v.trigger(60, 0.5, 0, 0.9);
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
      b.onclick = () => play(id, m);
      td.appendChild(b);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  grid.innerHTML = "";
  grid.appendChild(table);
}

// --- report --------------------------------------------------------------
function buildReport(): string {
  const f = getCurrentFont();
  const lines = [
    `MIDI Axe — sound report`,
    `Font: ${f.label} (${f.id})   note length: ${holdSel.options[holdSel.selectedIndex].text}`,
    ``,
    `Levels (raw render of C4 — peak / rms dB):`,
    ...(lastLevels.length
      ? lastLevels.map((l) => `  ${l.label.padEnd(20)} ${dbStr(l.peakDb)} / ${dbStr(l.rmsDb)} dB`)
      : ["  (not measured — click “Measure levels”)"]),
    ``,
    `Notes:`,
    notesEl.value.trim() || "  (none)",
  ];
  return lines.join("\n");
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

fontSel.addEventListener("change", () => {
  setCurrentFont(fontSel.value); // swaps theme + current font
  clearVoices();
  buildGrid();
  levelsEl.innerHTML = `<span class="muted">click “Measure levels”.</span>`;
  lastLevels.length = 0;
});

$("measure").addEventListener("click", () => void measureLevels());

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(buildReport());
    $("copied").textContent = "copied ✓";
  } catch {
    $("copied").textContent = "copy failed — select & copy the textarea";
  }
  setTimeout(() => ($("copied").textContent = ""), 2500);
});

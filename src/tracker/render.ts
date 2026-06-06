import { noteName, VOICE_LABELS, type Song } from "../model/song";

// Canvas-based FamiTracker-style grid. Left gutter has a per-row enable/skip
// rail plus row numbers; the header row per track carries name + Mute/Solo +
// voice + a volume slider; note cells flow top-to-bottom. Drawn imperatively
// because a DOM cell per note would be far too heavy for long songs.

export const ROW_H = 16;
export const HEADER_H = 74;
export const SKIP_W = 16; // leftmost enable/skip rail
export const GUTTER_W = 64; // skip rail + row numbers
export const COL_W = 132;

export type HeaderHit =
  | { type: "mute"; track: number }
  | { type: "solo"; track: number }
  | { type: "voice"; track: number }
  | { type: "volume"; track: number; frac: number };

export class TrackerView {
  ctx: CanvasRenderingContext2D;
  song: Song | null = null;
  scrollRow = 0;
  scrollX = 0; // horizontal scroll in pixels (columns slide under the gutter)
  playRow = -1;
  width = 0;
  height = 0;

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  visibleRows() {
    return Math.ceil((this.height - HEADER_H) / ROW_H);
  }

  maxScroll() {
    if (!this.song) return 0;
    return Math.max(0, this.song.lengthRows - this.visibleRows() + 2);
  }

  maxScrollX() {
    if (!this.song) return 0;
    const bodyW = this.width - GUTTER_W;
    return Math.max(0, this.song.tracks.length * COL_W - bodyW);
  }

  // y pixel -> row index in the body
  rowAtY(y: number) {
    return Math.floor((y - HEADER_H) / ROW_H + this.scrollRow);
  }

  // is the pointer over the leftmost enable/skip rail (in the body)?
  inSkipRail(x: number, y: number) {
    return y > HEADER_H && x >= 0 && x < SKIP_W;
  }

  headerHit(x: number, y: number): HeaderHit | null {
    if (!this.song || y > HEADER_H || x < GUTTER_W) return null;
    const cx = x - GUTTER_W + this.scrollX;
    const i = Math.floor(cx / COL_W);
    if (i < 0 || i >= this.song.tracks.length) return null;
    const localX = cx - i * COL_W;
    if (y >= 22 && y <= 38) {
      if (localX >= 6 && localX <= 24) return { type: "mute", track: i };
      if (localX >= 28 && localX <= 46) return { type: "solo", track: i };
      return null;
    }
    if (y >= 42 && y <= 56) return { type: "voice", track: i };
    if (y >= 58) {
      const frac = Math.max(0, Math.min(1, (localX - 6) / (COL_W - 12)));
      return { type: "volume", track: i, frac };
    }
    return null;
  }

  ensureRowVisible(row: number) {
    const vis = this.visibleRows();
    if (row < this.scrollRow + 1) this.scrollRow = Math.max(0, row - 1);
    else if (row > this.scrollRow + vis - 2)
      this.scrollRow = Math.min(this.maxScroll(), row - vis + 2);
  }

  draw() {
    const { ctx, song, width, height } = this;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#1c1c1c";
    ctx.fillRect(0, 0, width, height);
    if (!song) {
      ctx.fillStyle = "#9e9e9e";
      ctx.font = "bold 14px 'Courier New', monospace";
      ctx.fillText("Load a MIDI file to begin.", 20, HEADER_H + 30);
      return;
    }

    const rpb = song.rowsPerBeat;
    const barRows = rpb * 4;
    const startRow = Math.floor(this.scrollRow);
    const endRow = Math.min(song.lengthRows, startRow + this.visibleRows() + 1);
    const cols = song.tracks.length;
    const sx = this.scrollX;

    // --- row backgrounds (full body width) + gutter (skip rail + numbers) ---
    ctx.font = "bold 12px 'Courier New', monospace";
    for (let r = startRow; r < endRow; r++) {
      const y = HEADER_H + (r - this.scrollRow) * ROW_H;
      ctx.fillStyle =
        r % barRows === 0 ? "#3c3c3c" : r % rpb === 0 ? "#2e2e2e" : "#242424";
      ctx.fillRect(GUTTER_W, y, width - GUTTER_W, ROW_H);

      // gutter background
      ctx.fillStyle = r % barRows === 0 ? "#282828" : "#181818";
      ctx.fillRect(SKIP_W, y, GUTTER_W - SKIP_W, ROW_H);
      // skip rail: red block where the row is enabled, empty where skipped
      ctx.fillStyle = "#101010";
      ctx.fillRect(0, y, SKIP_W, ROW_H);
      if (!song.skipped[r]) {
        ctx.fillStyle = "#e5362a";
        ctx.fillRect(2, y + 2, SKIP_W - 4, ROW_H - 4);
      }
      // row number
      ctx.fillStyle = r % barRows === 0 ? "#f2f2f2" : "#8a8a8a";
      ctx.fillText(String(r).padStart(4, " "), SKIP_W + 4, y + 12);
    }

    // --- column content: clip to the body and slide horizontally ---
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER_W, HEADER_H, width - GUTTER_W, height - HEADER_H);
    ctx.clip();
    ctx.translate(GUTTER_W - sx, 0);

    const anySolo = song.tracks.some((t) => t.solo);
    song.tracks.forEach((track, i) => {
      const x = i * COL_W;
      const audible = anySolo ? track.solo : !track.muted;
      ctx.globalAlpha = audible ? 1 : 0.28;
      for (const note of track.notes) {
        if (note.row + note.lenRows < startRow || note.row > endRow) continue;
        const y = HEADER_H + (note.row - this.scrollRow) * ROW_H;
        const h = Math.max(ROW_H - 1, note.lenRows * ROW_H - 1);
        ctx.fillStyle = track.color;
        ctx.fillRect(x + 4, y + 1, COL_W - 8, h);
        ctx.fillStyle = "#111111";
        ctx.font = "bold 12px 'Courier New', monospace";
        ctx.fillText(noteName(note.midi), x + 10, y + 12);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#3a3a3a";
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H);
      ctx.lineTo(x, height);
      ctx.stroke();
    });
    ctx.restore();

    // --- dim skipped rows across the body ---
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    for (let r = startRow; r < endRow; r++) {
      if (!song.skipped[r]) continue;
      const y = HEADER_H + (r - this.scrollRow) * ROW_H;
      ctx.fillRect(GUTTER_W, y, width - GUTTER_W, ROW_H);
    }

    // --- playhead (fixed, spans gutter + body) ---
    if (this.playRow >= startRow - 1 && this.playRow <= endRow + 1) {
      const y = HEADER_H + (this.playRow - this.scrollRow) * ROW_H;
      ctx.strokeStyle = "#e5362a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    this.drawHeader(song, cols);
  }

  private drawHeader(song: Song, cols: number) {
    const { ctx } = this;
    ctx.fillStyle = "#282828";
    ctx.fillRect(0, 0, this.width, HEADER_H);
    ctx.strokeStyle = "#000";
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H);
    ctx.lineTo(this.width, HEADER_H);
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER_W, 0, this.width - GUTTER_W, HEADER_H);
    ctx.clip();
    ctx.translate(GUTTER_W - this.scrollX, 0);
    for (let i = 0; i < cols; i++) {
      const track = song.tracks[i];
      const x = i * COL_W;
      // color chip + name
      ctx.fillStyle = track.color;
      ctx.fillRect(x + 6, 6, 10, 10);
      ctx.fillStyle = "#f2f2f2";
      ctx.font = "bold 12px 'Courier New', monospace";
      ctx.fillText(this.fit(track.name, 13), x + 22, 15);

      // Mute / Solo toggles
      this.chip(x + 6, 22, "M", track.muted, "#e5362a");
      this.chip(x + 28, 22, "S", track.solo, "#f2f2f2");

      // voice label (click to cycle)
      ctx.fillStyle = "#353535";
      ctx.fillRect(x + 6, 42, COL_W - 12, 14);
      ctx.fillStyle = "#f2f2f2";
      ctx.font = "bold 11px 'Courier New', monospace";
      ctx.fillText("♪ " + VOICE_LABELS[track.voice], x + 10, 53);

      // volume slider
      const vx = x + 6;
      const vw = COL_W - 12;
      const vy = 60;
      const vh = 8;
      ctx.fillStyle = "#353535";
      ctx.fillRect(vx, vy, vw, vh);
      ctx.fillStyle = "#e5362a";
      ctx.fillRect(vx, vy, vw * track.volume, vh);
      ctx.fillStyle = "#f2f2f2";
      ctx.fillRect(vx + vw * track.volume - 1, vy - 1, 2, vh + 2);
    }
    ctx.restore();
  }

  private chip(x: number, y: number, label: string, on: boolean, color: string) {
    const { ctx } = this;
    ctx.fillStyle = on ? color : "#353535";
    ctx.fillRect(x, y, 18, 16);
    ctx.fillStyle = on ? "#111111" : "#9e9e9e";
    ctx.font = "bold 11px 'Courier New', monospace";
    ctx.fillText(label, x + 5, y + 12);
  }

  private fit(s: string, max: number) {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
}

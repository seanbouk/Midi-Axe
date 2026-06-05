import { noteName, VOICE_LABELS, type Song } from "../model/song";

// Canvas-based FamiTracker-style grid: a fixed header row of track columns
// (name + Mute/Solo toggles + clickable voice label), a left gutter of row
// numbers, and the note cells flowing top-to-bottom. Drawn imperatively because
// a DOM cell per note would be far too heavy for long songs.

export const ROW_H = 16;
export const HEADER_H = 54;
export const GUTTER_W = 56;
export const COL_W = 132;

export type HeaderHit =
  | { type: "mute"; track: number }
  | { type: "solo"; track: number }
  | { type: "voice"; track: number };

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

  headerHit(x: number, y: number): HeaderHit | null {
    if (!this.song || y > HEADER_H || x < GUTTER_W) return null;
    const cx = x - GUTTER_W + this.scrollX;
    const i = Math.floor(cx / COL_W);
    if (i < 0 || i >= this.song.tracks.length) return null;
    const localX = cx - i * COL_W;
    if (y >= 20 && y <= 36) {
      if (localX >= 6 && localX <= 24) return { type: "mute", track: i };
      if (localX >= 28 && localX <= 46) return { type: "solo", track: i };
    }
    if (y > 36) return { type: "voice", track: i };
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
    ctx.fillStyle = "#14131c";
    ctx.fillRect(0, 0, width, height);
    if (!song) {
      ctx.fillStyle = "#8983a8";
      ctx.font = "14px 'Courier New', monospace";
      ctx.fillText("Load a MIDI file to begin.", 20, HEADER_H + 30);
      return;
    }

    const rpb = song.rowsPerBeat;
    const barRows = rpb * 4;
    const startRow = Math.floor(this.scrollRow);
    const endRow = Math.min(song.lengthRows, startRow + this.visibleRows() + 1);
    const cols = song.tracks.length;
    const sx = this.scrollX;

    // --- row backgrounds (full body width) + gutter numbers (fixed) ---
    ctx.font = "12px 'Courier New', monospace";
    for (let r = startRow; r < endRow; r++) {
      const y = HEADER_H + (r - this.scrollRow) * ROW_H;
      ctx.fillStyle =
        r % barRows === 0 ? "#3a3658" : r % rpb === 0 ? "#2c2942" : "#211f30";
      ctx.fillRect(GUTTER_W, y, width - GUTTER_W, ROW_H);
      ctx.fillStyle = r % barRows === 0 ? "#1d1b2a" : "#181622";
      ctx.fillRect(0, y, GUTTER_W, ROW_H);
      ctx.fillStyle = r % barRows === 0 ? "#e8e6f0" : "#6f6a92";
      ctx.fillText(String(r).padStart(4, " "), 8, y + 12);
    }

    // --- column content: clip to the body and slide horizontally ---
    ctx.save();
    ctx.beginPath();
    ctx.rect(GUTTER_W, HEADER_H, width - GUTTER_W, height - HEADER_H);
    ctx.clip();
    ctx.translate(GUTTER_W - sx, 0);

    this.shadeOutsideCrop(startRow, endRow, cols);

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
        ctx.fillStyle = "#14131c";
        ctx.font = "bold 12px 'Courier New', monospace";
        ctx.fillText(noteName(note.midi), x + 10, y + 12);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#322e48";
      ctx.beginPath();
      ctx.moveTo(x, HEADER_H);
      ctx.lineTo(x, height);
      ctx.stroke();
    });
    ctx.restore();

    // --- playhead (fixed, spans gutter + body) ---
    if (this.playRow >= startRow - 1 && this.playRow <= endRow + 1) {
      const y = HEADER_H + (this.playRow - this.scrollRow) * ROW_H;
      ctx.strokeStyle = "#f07d9e";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    this.drawHeader(song, cols);
  }

  // Called inside the translated column space (origin at first column).
  private shadeOutsideCrop(startRow: number, endRow: number, cols: number) {
    const { ctx, song } = this;
    if (!song) return;
    if (song.cropStart <= 0 && song.cropEnd >= song.lengthRows) return;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    for (let r = startRow; r < endRow; r++) {
      if (r >= song.cropStart && r < song.cropEnd) continue;
      const y = HEADER_H + (r - this.scrollRow) * ROW_H;
      ctx.fillRect(0, y, cols * COL_W, ROW_H);
    }
  }

  private drawHeader(song: Song, cols: number) {
    const { ctx } = this;
    ctx.fillStyle = "#1d1b2a";
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
      ctx.fillStyle = "#e8e6f0";
      ctx.font = "bold 12px 'Courier New', monospace";
      ctx.fillText(this.fit(track.name, 13), x + 22, 15);

      // Mute / Solo toggles
      this.chip(x + 6, 20, "M", track.muted, "#f07d9e");
      this.chip(x + 28, 20, "S", track.solo, "#f0d77d");

      // voice label (click to cycle)
      ctx.fillStyle = "#262338";
      ctx.fillRect(x + 6, 38, COL_W - 12, 14);
      ctx.fillStyle = "#7df0a0";
      ctx.font = "11px 'Courier New', monospace";
      ctx.fillText("♪ " + VOICE_LABELS[track.voice], x + 10, 49);
    }
    ctx.restore();
  }

  private chip(x: number, y: number, label: string, on: boolean, color: string) {
    const { ctx } = this;
    ctx.fillStyle = on ? color : "#262338";
    ctx.fillRect(x, y, 18, 16);
    ctx.fillStyle = on ? "#14131c" : "#8983a8";
    ctx.font = "bold 11px 'Courier New', monospace";
    ctx.fillText(label, x + 5, y + 12);
  }

  private fit(s: string, max: number) {
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
}

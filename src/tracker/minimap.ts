import type { Song } from "../model/song";

// Horizontal whole-song overview in the top bar. Time runs left-to-right; each
// track gets a thin lane of note activity. Shows the currently-visible row
// window as a box, dims skipped regions, and marks the playhead. Click/drag
// anywhere on it seeks (handled by main, which calls rowAtX). The static note
// layer is cached to an offscreen canvas so per-frame redraws are cheap.

export class Minimap {
  ctx: CanvasRenderingContext2D;
  song: Song | null = null;
  w = 0;
  h = 0;
  private cache: HTMLCanvasElement;

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    this.cache = document.createElement("canvas");
  }

  setSong(song: Song | null) {
    this.song = song;
    this.buildCache();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.floor(rect.width));
    this.h = Math.max(1, Math.floor(rect.height));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.buildCache();
  }

  rowAtX(clientX: number): number {
    if (!this.song) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(this.song.lengthRows, (x / this.w) * this.song.lengthRows));
  }

  private buildCache() {
    const { song, w, h } = this;
    this.cache.width = w;
    this.cache.height = h;
    const c = this.cache.getContext("2d")!;
    c.clearRect(0, 0, w, h);
    c.fillStyle = "#141414";
    c.fillRect(0, 0, w, h);
    if (!song || song.lengthRows === 0) return;

    const len = song.lengthRows;
    const lane = h / song.tracks.length;
    song.tracks.forEach((track, i) => {
      c.fillStyle = track.color;
      const y = i * lane;
      const lh = Math.max(1, lane - 0.5);
      for (const note of track.notes) {
        const x = (note.row / len) * w;
        const nw = Math.max(1, (note.lenRows / len) * w);
        c.fillRect(x, y, nw, lh);
      }
    });
  }

  draw(scrollRow: number, visibleRows: number, playRow: number) {
    const { ctx, song, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.cache, 0, 0);
    if (!song || song.lengthRows === 0) return;
    const len = song.lengthRows;

    // dim skipped regions (collapse contiguous runs into rects)
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    let runStart = -1;
    for (let r = 0; r <= len; r++) {
      const skipped = r < len && song.skipped[r];
      if (skipped && runStart < 0) runStart = r;
      else if (!skipped && runStart >= 0) {
        const x0 = (runStart / len) * w;
        const x1 = (r / len) * w;
        ctx.fillRect(x0, 0, x1 - x0, h);
        runStart = -1;
      }
    }

    // visible-row window box
    const vx0 = (scrollRow / len) * w;
    const vx1 = ((scrollRow + visibleRows) / len) * w;
    ctx.fillStyle = "rgba(242,242,242,0.14)";
    ctx.fillRect(vx0, 0, Math.max(2, vx1 - vx0), h);
    ctx.strokeStyle = "#f2f2f2";
    ctx.lineWidth = 1;
    ctx.strokeRect(vx0 + 0.5, 0.5, Math.max(2, vx1 - vx0), h - 1);

    // playhead
    if (playRow >= 0) {
      const px = (playRow / len) * w;
      ctx.strokeStyle = "#e5362a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
}

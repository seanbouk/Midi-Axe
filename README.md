# MIDI Axe

A browser tool that turns MIDI files into NES-style chiptune. Load a `.mid`, view
it in a FamiTracker-style grid, pick which tracks/sections to keep, swap each part
for a chiptune voice (pulse / triangle / noise), preview it, and export a WAV for
Unity. Everything runs client-side — the MIDI never leaves your machine.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs static site to dist/
```

## How to use

1. **Load** a `.mid` (button or drag-drop onto the grid). Try `assets/KnightRider.mid`.
2. **Scroll** vertically with the wheel; **shift+wheel** (or trackpad sideways) scrolls
   across tracks.
3. In each track header: **M** = mute, **S** = solo, and click the **♪ voice** label to
   cycle its chiptune voice (Pulse 12.5/25/50%, Triangle, Noise).
4. **Crop** a section by dragging in the left row-number gutter; click once to clear.
5. **▶ Play** to preview, **⬇ Export WAV** to render the filtered/voiced result.

`Rows/beat` controls how finely notes snap to tracker rows (re-quantizes on change).

## Stack

Vanilla TS + [Vite] · [`@tonejs/midi`] parses MIDI · [Tone.js] synthesizes & schedules ·
canvas tracker grid · WAV encoded from an `OfflineAudioContext` render.

## Deploy

Pushing to `main` builds and publishes to GitHub Pages via `.github/workflows/deploy.yml`
(enable Pages → "GitHub Actions" in the repo settings once).

[Vite]: https://vitejs.dev
[`@tonejs/midi`]: https://github.com/Tonejs/Midi
[Tone.js]: https://tonejs.github.io

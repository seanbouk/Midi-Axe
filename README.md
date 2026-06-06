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
   across tracks. The **top-bar minimap** shows the whole song — click/drag it to seek.
3. Pick a **sound font** from the ♪ menu in the top bar — **MIDI (GM)** real
   instrument samples, or chiptune engines: **NES**, **TurboGrafx**, **C64** (SID),
   **X68000** (FM) and **Mega Drive** (FM + PSG). Each font carries its own theme.
   Switching re-assigns every track automatically and is remembered across loads.
4. In each track header: **M** = mute, **hold S** = solo (momentary), click the
   **♪ patch** label to cycle the voice within the current font, and drag the
   **volume** bar to set per-track level.
5. **Skip/keep rows** by dragging the red rail down the left edge — skipped rows are
   removed from the timeline (crop the start/end, or cut monotonous middle segments).
6. **▶ Play** loops the kept rows; **⬇ Export WAV** renders a seamless loop (click the
   button again mid-render to cancel).

## Stack

Vanilla TS + [Vite] · [`@tonejs/midi`] parses MIDI · [Tone.js] transport/scheduling ·
sound fonts are raw Web Audio (pulse/triangle/wavetable, SID-style filter, 4-op FM) plus
[`smplr`] for General MIDI samples ([FluidR3_GM] soundfont) · canvas tracker grid · WAV
encoded from an `OfflineAudioContext` render.

## Deploy

Pushing to `main` builds and publishes to GitHub Pages via `.github/workflows/deploy.yml`
(enable Pages → "GitHub Actions" in the repo settings once).

[Vite]: https://vitejs.dev
[`@tonejs/midi`]: https://github.com/Tonejs/Midi
[Tone.js]: https://tonejs.github.io
[`smplr`]: https://github.com/danigb/smplr
[FluidR3_GM]: https://github.com/gleitz/midi-js-soundfonts

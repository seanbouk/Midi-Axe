// Sample-accurate SID-style voice (Commodore 64 MOS 6581) on the audio thread.
// A "voice" here is waveform + amplitude ADSR + a resonant multimode filter that
// has its OWN ADSR (the cutoff sweep that gives SID so much of its expression),
// plus pulse-width modulation. One processor per track; 8-voice polyphonic.

const TAU = Math.PI * 2;

class Voice {
  constructor() {
    this.active = false;
    this.phase = 0;
    this.inc = 0;
    this.pwmPhase = 0;
    this.lfsr = 0x7ffff8;
    this.amp = 0; this.ampStage = 0; this.ampRel = 0;
    this.flt = 0; this.fltStage = 0; this.fltRel = 0;
    this.low = 0; this.band = 0; // state-variable filter state
    this.releaseFrame = Infinity;
    this.vel = 1;
  }
}

// linear ADSR stepper; stage 0 off,1 atk,2 dec,3 sus,4 rel. returns value.
function stepEnv(v, which, env, sr) {
  const valKey = which === "amp" ? "amp" : "flt";
  const stageKey = which === "amp" ? "ampStage" : "fltStage";
  const relKey = which === "amp" ? "ampRel" : "fltRel";
  let e = v[valKey];
  const st = v[stageKey];
  if (st === 1) { e += 1 / Math.max(1, env.a * sr); if (e >= 1) { e = 1; v[stageKey] = 2; } }
  else if (st === 2) { e -= (1 - env.s) / Math.max(1, env.d * sr); if (e <= env.s) { e = env.s; v[stageKey] = 3; } }
  else if (st === 3) { e = env.s; }
  else if (st === 4) { e -= v[relKey]; if (e <= 0) { e = 0; v[stageKey] = 0; } }
  else { e = 0; }
  v[valKey] = e;
  return e;
}

class SidProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const c = opts.processorOptions.config;
    this.c = c;
    this.hasFenv = !!c.fenv && c.fenv.amount > 0;
    this.sr = sampleRate;
    this.voices = [];
    for (let i = 0; i < 8; i++) this.voices.push(new Voice());
    this.rr = 0;
    this.queue = [];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "note") this.queue.push(m);
      else if (m.type === "stopAll") { this.queue.length = 0; for (const v of this.voices) v.active = false; }
    };
  }

  start(v, midi, vel, dur, atFrame) {
    v.active = true; v.vel = vel;
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    v.inc = freq / this.sr;
    v.phase = 0; v.pwmPhase = 0;
    v.amp = 0; v.ampStage = 1;
    v.flt = 0; v.fltStage = 1;
    v.low = 0; v.band = 0;
    if (!v.lfsr) v.lfsr = 0x7ffff8;
    v.releaseFrame = atFrame + Math.max(1, Math.round(dur * this.sr));
  }

  process(_in, outs) {
    const out = outs[0][0];
    const c = this.c;
    const sr = this.sr;
    const base = currentFrame;
    const pwmInc = (c.pwmRate || 0) / sr;
    const qd = 1.4 - (c.filter.resonance || 0) * 1.32; // damping (lower = more resonant)
    const q = Math.max(0.06, qd);
    const fcMax = sr / 6;

    for (let s = 0; s < out.length; s++) {
      const f = base + s;
      for (let qi = this.queue.length - 1; qi >= 0; qi--) {
        if (Math.round(this.queue[qi].time * sr) <= f) {
          const note = this.queue[qi];
          const v = this.voices[this.rr]; this.rr = (this.rr + 1) % this.voices.length;
          this.start(v, note.midi, note.vel, note.dur, f);
          this.queue.splice(qi, 1);
        }
      }

      let sample = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        if (f >= v.releaseFrame) {
          if (v.ampStage !== 0 && v.ampStage !== 4) { v.ampRel = v.amp / Math.max(1, c.amp.r * sr); v.ampStage = 4; }
          if (v.fltStage !== 0 && v.fltStage !== 4) { v.fltRel = v.flt / Math.max(1, (c.fenv ? c.fenv.r : 0.1) * sr); v.fltStage = 4; }
          v.releaseFrame = Infinity;
        }

        // oscillator
        let osc;
        if (c.wave === "saw") osc = 2 * v.phase - 1;
        else if (c.wave === "triangle") osc = 1 - 4 * Math.abs(v.phase - 0.5);
        else if (c.wave === "noise") {
          // 23-bit LFSR (taps 22,17) advanced per sample
          const bit = (((v.lfsr >> 22) ^ (v.lfsr >> 17)) & 1);
          v.lfsr = ((v.lfsr << 1) | bit) & 0x7fffff;
          osc = (v.lfsr & 1) ? 1 : -1;
        } else {
          // pulse with PWM
          let pw = c.pulseWidth ?? 0.5;
          if (c.pwmDepth) { pw += c.pwmDepth * Math.sin(TAU * v.pwmPhase); v.pwmPhase += pwmInc; if (v.pwmPhase > 1) v.pwmPhase -= 1; }
          osc = v.phase < pw ? 1 : -1;
        }
        v.phase += v.inc; if (v.phase >= 1) v.phase -= 1;

        // envelopes
        const ampE = stepEnv(v, "amp", c.amp, sr);
        let fc = c.filter.cutoff;
        if (this.hasFenv) fc += c.fenv.amount * stepEnv(v, "flt", c.fenv, sr);
        if (fc > fcMax) fc = fcMax; else if (fc < 20) fc = 20;

        // state-variable resonant filter
        const fco = 2 * Math.sin((Math.PI * fc) / sr);
        v.low += fco * v.band;
        const high = osc - v.low - q * v.band;
        v.band += fco * high;
        if (v.band > 4) v.band = 4; else if (v.band < -4) v.band = -4; // safety
        let filt = c.filter.type === "bp" ? v.band : c.filter.type === "hp" ? high : v.low;

        sample += filt * ampE * v.vel;
        if (v.ampStage === 0) v.active = false;
      }
      out[s] = sample * c.level;
    }
    return true;
  }
}

registerProcessor("sid-processor", SidProcessor);

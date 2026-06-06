// Sample-accurate 4-operator FM voice (YM2151/YM2612/DX9 style) running on the
// audio thread. True single-sample operator feedback (average of the last two
// outputs) — the thing the Web Audio node-graph approximation couldn't do, and
// the source of authentic FM grit/sawtooth character.
//
// One processor instance per track; internally 8-voice polyphonic. Patch comes
// in via processorOptions; note events arrive on the port carrying an absolute
// context time, started sample-accurately within the block.

const TAU = Math.PI * 2;

class Voice {
  constructor(n) {
    this.active = false;
    this.phase = new Float32Array(n);
    this.inc = new Float32Array(n);
    this.env = new Float32Array(n);
    this.stage = new Int8Array(n); // 0 off, 1 attack, 2 decay, 3 sustain, 4 release
    this.relRate = new Float32Array(n);
    this.out = new Float32Array(n); // last enveloped output per op (this sample)
    this.fb1 = 0;
    this.fb2 = 0;
    this.releaseFrame = Infinity;
    this.vel = 1;
  }
}

class FmProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.ops = o.algo.ops;
    this.edges = o.algo.edges;
    this.carriers = o.algo.carriers;
    this.fb = o.algo.feedback || null;
    this.level = o.level / Math.max(1, o.algo.carriers.length);
    this.n = this.ops.length;
    this.sr = sampleRate;
    this.voices = [];
    for (let i = 0; i < 8; i++) this.voices.push(new Voice(this.n));
    this.rr = 0;
    this.queue = [];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "note") this.queue.push(m);
      else if (m.type === "stopAll") {
        this.queue.length = 0;
        for (const v of this.voices) v.active = false;
      }
    };
  }

  startNote(v, midi, vel, dur, atFrame) {
    v.active = true;
    v.vel = vel;
    const base = 440 * Math.pow(2, (midi - 69) / 12);
    for (let i = 0; i < this.n; i++) {
      v.inc[i] = (TAU * this.ops[i].ratio * base) / this.sr;
      v.phase[i] = 0;
      v.env[i] = 0;
      v.stage[i] = 1; // attack
    }
    v.fb1 = 0;
    v.fb2 = 0;
    v.releaseFrame = atFrame + Math.max(1, Math.round(dur * this.sr));
  }

  stepEnv(v, i) {
    const op = this.ops[i];
    let e = v.env[i];
    const st = v.stage[i];
    if (st === 1) {
      e += 1 / Math.max(1, op.a * this.sr);
      if (e >= 1) { e = 1; v.stage[i] = 2; }
    } else if (st === 2) {
      e -= (1 - op.s) / Math.max(1, op.d * this.sr);
      if (e <= op.s) { e = op.s; v.stage[i] = 3; }
    } else if (st === 3) {
      e = op.s;
    } else if (st === 4) {
      e -= v.relRate[i];
      if (e <= 0) { e = 0; v.stage[i] = 0; }
    } else {
      e = 0;
    }
    v.env[i] = e;
    return e;
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    const block = out.length;
    const baseFrame = currentFrame;

    for (let s = 0; s < block; s++) {
      const f = baseFrame + s;

      // start any notes due at/just before this frame
      for (let q = this.queue.length - 1; q >= 0; q--) {
        if (Math.round(this.queue[q].time * this.sr) <= f) {
          const note = this.queue[q];
          const v = this.voices[this.rr];
          this.rr = (this.rr + 1) % this.voices.length;
          this.startNote(v, note.midi, note.vel, note.dur, f);
          this.queue.splice(q, 1);
        }
      }

      let sample = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        if (f >= v.releaseFrame) {
          for (let i = 0; i < this.n; i++) {
            if (v.stage[i] !== 0 && v.stage[i] !== 4) {
              v.relRate[i] = v.env[i] / Math.max(1, this.ops[i].r * this.sr);
              v.stage[i] = 4;
            }
          }
          v.releaseFrame = Infinity;
        }
        // operators in index order (modulators precede their carriers)
        for (let i = 0; i < this.n; i++) {
          let mod = 0;
          for (let k = 0; k < this.edges.length; k++) {
            const edge = this.edges[k];
            if (edge[1] === i) mod += this.ops[edge[0]].level * v.out[edge[0]];
          }
          if (this.fb && this.fb.op === i) mod += this.fb.amount * (v.fb1 + v.fb2) * 0.5;
          const raw = Math.sin(v.phase[i] + mod);
          const e = this.stepEnv(v, i);
          v.out[i] = e * raw;
          if (this.fb && this.fb.op === i) { v.fb2 = v.fb1; v.fb1 = raw; }
          v.phase[i] += v.inc[i];
          if (v.phase[i] > TAU) v.phase[i] -= TAU;
        }
        let cs = 0;
        let anyOn = false;
        for (let c = 0; c < this.carriers.length; c++) {
          const ci = this.carriers[c];
          cs += v.out[ci];
          if (v.stage[ci] !== 0) anyOn = true;
        }
        sample += cs * v.vel;
        if (!anyOn) v.active = false;
      }
      out[s] = sample * this.level;
    }
    return true;
  }
}

registerProcessor("fm-processor", FmProcessor);

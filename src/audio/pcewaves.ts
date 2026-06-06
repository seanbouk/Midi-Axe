// PC Engine / HuC6280 single-cycle waveforms: 32 samples each, quantized to
// 5-bit (32 amplitude levels) like the chip's waveform RAM. The lo-fi quantized
// loop is what gives TurboGrafx its character. Each is normalized then crushed
// to 5 bits.

const LEN = 32;

function build(fn: (t: number, i: number) => number): Float32Array {
  const a = new Float32Array(LEN);
  let peak = 0;
  for (let i = 0; i < LEN; i++) {
    a[i] = fn(i / LEN, i);
    peak = Math.max(peak, Math.abs(a[i]));
  }
  const norm = peak > 0 ? 1 / peak : 1;
  for (let i = 0; i < LEN; i++) {
    const v = a[i] * norm; // -1..1
    const level = Math.round(((v + 1) / 2) * 31); // 5-bit: 0..31
    a[i] = (level / 31) * 2 - 1;
  }
  return a;
}

const TAU = Math.PI * 2;

export const PCE_WAVES: Record<string, Float32Array> = {
  square: build((_, i) => (i < 16 ? 1 : -1)),
  pulse25: build((_, i) => (i < 8 ? 1 : -1)),
  saw: build((t) => 2 * t - 1),
  triangle: build((t) => 1 - 4 * Math.abs(t - 0.5)),
  sine: build((t) => Math.sin(TAU * t)),
  // stacked harmonics -> hollow drawbar/organ tone
  organ: build((t) => Math.sin(TAU * t) + 0.5 * Math.sin(2 * TAU * t) + 0.33 * Math.sin(3 * TAU * t) + 0.25 * Math.sin(4 * TAU * t)),
  // sharp asymmetric hump then dip -> bright reedy PCE lead
  spike: build((t, i) => (i < 8 ? Math.sin(Math.PI * (i / 8)) : -0.18 + 0.12 * Math.sin(TAU * t))),
  // saw with a high-harmonic ripple -> jagged lo-fi buzz
  buzz: build((t) => 0.7 * (2 * t - 1) + 0.3 * Math.sin(8 * TAU * t)),
};

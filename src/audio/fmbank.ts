import type { FmAlgo, FmOp } from "./voices";

// A bank of 4-operator FM patches for the X68000 (YM2151) and Mega Drive
// (YM2612) fonts, built on the eight standard 4-op algorithms shared by those
// chips and the Yamaha DX9. Operators are 0..3 (= chip operators 1..4).
//
// op(ratio, level, a, d, s, r): for a CARRIER, level is output amplitude; for a
// MODULATOR, level is the modulation index. Envelope is attack/decay/sustain/
// release in seconds + sustain fraction. These are hand-tuned starting points —
// audition on /debug.html and tweak.

const op = (ratio: number, level: number, a: number, d: number, s: number, r: number): FmOp =>
  ({ ratio, level, a, d, s, r });

// The 8 algorithms as edge lists + carriers (operators 0..3).
const ALG = {
  serial: { e: [[0, 1], [1, 2], [2, 3]], c: [3] }, // 0: 1→2→3→4
  twoMod3: { e: [[0, 2], [1, 2], [2, 3]], c: [3] }, // 1: (1+2)→3→4
  oneAnd23: { e: [[1, 2], [2, 3], [0, 3]], c: [3] }, // 2: 1→4, 2→3→4
  branch4: { e: [[0, 1], [1, 3], [2, 3]], c: [3] }, // 3: 1→2→4, 3→4
  twoStacks: { e: [[0, 1], [2, 3]], c: [1, 3] }, // 4: 1→2, 3→4
  oneToAll: { e: [[0, 1], [0, 2], [0, 3]], c: [1, 2, 3] }, // 5: 1→(2,3,4)
  oneToTwo: { e: [[0, 1]], c: [1, 2, 3] }, // 6: 1→2, +3,4
  additive: { e: [] as [number, number][], c: [0, 1, 2, 3] }, // 7: all carriers
  twoOp: { e: [[0, 1]], c: [1] }, // simple 2-op: 1→2 (single carrier, stable)
} as const;

type AlgKey = keyof typeof ALG;
function algo(k: AlgKey, ops: FmOp[], feedback?: { op: number; amount: number }): FmAlgo {
  return { ops, edges: ALG[k].e as [number, number][], carriers: [...ALG[k].c], feedback };
}

export interface FmPatch {
  id: string;
  label: string;
  algo: FmAlgo;
  level: number;
}

// silent filler op for algorithms that don't use all four
const OFF = op(1, 0, 0.001, 0.1, 0, 0.1);

export const FM_BANK: FmPatch[] = [
  // --- keys / mallets ---
  { id: "fm_ep", label: "E.Piano", level: 0.32,
    algo: algo("twoStacks", [op(14, 1.0, 0.001, 0.35, 0, 0.3), op(1, 0.8, 0.002, 1.4, 0.25, 0.4), op(1, 0.5, 0.001, 0.6, 0, 0.3), op(1, 0.8, 0.002, 1.2, 0.3, 0.4)]) },
  { id: "fm_marimba", label: "Marimba", level: 0.6,
    algo: algo("twoStacks", [op(4, 1.4, 0.001, 0.18, 0, 0.12), op(1, 0.9, 0.002, 0.4, 0, 0.15), OFF, OFF]) },
  { id: "fm_pluck", label: "FM Pluck", level: 0.32,
    algo: algo("serial", [op(2, 2.0, 0.001, 0.18, 0, 0.12), op(1, 1.0, 0.001, 0.2, 0, 0.12), op(1, 0.8, 0.001, 0.25, 0, 0.12), op(1, 0.9, 0.002, 0.3, 0, 0.14)]) },
  { id: "fm_clav", label: "Clav", level: 0.3,
    algo: algo("serial", [op(1, 1.2, 0.001, 0.2, 0.1, 0.1), op(1, 0.9, 0.001, 0.2, 0.2, 0.1), op(1, 0.8, 0.001, 0.2, 0.3, 0.1), op(1, 0.9, 0.002, 0.25, 0.2, 0.12)], { op: 0, amount: 0.9 }) },

  // --- bass ---
  { id: "fm_bass", label: "FM Bass", level: 0.36,
    algo: algo("serial", [op(1, 2.2, 0.001, 0.12, 0.3, 0.1), op(1, 1.0, 0.001, 0.1, 0.6, 0.1), op(1, 0.8, 0.001, 0.1, 0.7, 0.1), op(1, 0.9, 0.001, 0.1, 0.8, 0.12)]) },
  { id: "fm_bass_fb", label: "Grit Bass", level: 0.36,
    algo: algo("serial", [op(1, 0.8, 0.001, 0.18, 0.6, 0.1), op(1, 1.0, 0.001, 0.1, 0.7, 0.1), op(1, 0.8, 0.001, 0.1, 0.8, 0.1), op(1, 0.9, 0.001, 0.1, 0.85, 0.12)], { op: 0, amount: 2.6 }) },
  { id: "fm_synbass", label: "Syn Bass", level: 0.36,
    algo: algo("branch4", [op(1, 1.8, 0.001, 0.14, 0.2, 0.1), op(2, 1.2, 0.001, 0.12, 0.2, 0.1), op(1, 0.7, 0.001, 0.1, 0.7, 0.1), op(1, 0.9, 0.001, 0.12, 0.7, 0.12)]) },

  // --- brass / leads ---
  { id: "fm_brass", label: "Brass", level: 0.3,
    algo: algo("oneAnd23", [op(1, 1.4, 0.04, 0.2, 0.8, 0.2), op(1, 1.6, 0.05, 0.2, 0.8, 0.2), op(1, 1.0, 0.05, 0.2, 0.8, 0.2), op(1, 0.9, 0.04, 0.2, 0.9, 0.2)]) },
  // clean 2-op brass: modulator swells in for the brassy edge, single carrier
  // so it stays rock-steady at every pitch (no feedback, no detune beating)
  { id: "fm_synbrass", label: "Syn Brass", level: 0.34,
    algo: algo("twoOp", [op(1, 2.6, 0.03, 0.16, 0.55, 0.18), op(1, 1.0, 0.02, 0.15, 0.85, 0.18)]) },
  { id: "fm_lead_saw", label: "Saw Lead", level: 0.3,
    algo: algo("serial", [op(1, 1.0, 0.005, 0.15, 0.8, 0.12), op(1, 1.0, 0.005, 0.15, 0.85, 0.12), op(1, 0.9, 0.005, 0.15, 0.9, 0.12), op(1, 0.9, 0.005, 0.15, 0.95, 0.14)], { op: 0, amount: 1.8 }) },
  { id: "fm_lead_sq", label: "Sqr Lead", level: 0.3,
    algo: algo("twoStacks", [op(1, 1.5, 0.004, 0.15, 0.9, 0.12), op(1, 0.9, 0.004, 0.15, 0.95, 0.12), op(2, 1.0, 0.004, 0.15, 0.9, 0.12), op(1.001, 0.9, 0.004, 0.15, 0.95, 0.12)]) },

  // --- pads / ensemble ---
  { id: "fm_strings", label: "Strings", level: 0.4,
    algo: algo("twoStacks", [op(1, 0.7, 0.18, 0.4, 0.9, 0.4), op(1, 0.9, 0.2, 0.4, 0.95, 0.5), op(1, 0.6, 0.18, 0.4, 0.9, 0.4), op(1.006, 0.9, 0.2, 0.4, 0.95, 0.5)]) },
  { id: "fm_pad", label: "Warm Pad", level: 0.6,
    algo: algo("additive", [op(1, 0.7, 0.3, 0.6, 0.9, 0.6), op(2, 0.4, 0.35, 0.6, 0.85, 0.6), op(0.5, 0.5, 0.3, 0.6, 0.9, 0.6), op(3.01, 0.25, 0.4, 0.6, 0.8, 0.6)]) },
  { id: "fm_organ", label: "Organ", level: 0.55,
    algo: algo("additive", [op(1, 0.8, 0.01, 0.1, 1.0, 0.06), op(2, 0.6, 0.01, 0.1, 1.0, 0.06), op(3, 0.4, 0.01, 0.1, 1.0, 0.06), op(4, 0.3, 0.01, 0.1, 1.0, 0.06)]) },

  // --- bells ---
  { id: "fm_bell", label: "FM Bell", level: 0.3,
    algo: algo("twoStacks", [op(3.5, 1.2, 0.001, 0.8, 0.1, 0.6), op(1, 0.8, 0.001, 1.0, 0.1, 0.7), op(7, 0.6, 0.001, 0.6, 0, 0.5), op(1, 0.5, 0.001, 0.8, 0.05, 0.6)]) },
  { id: "fm_tubular", label: "Tubular", level: 0.3,
    algo: algo("oneAnd23", [op(1.41, 1.0, 0.001, 1.2, 0.1, 0.8), op(3.5, 0.8, 0.001, 1.0, 0.05, 0.7), op(1, 0.7, 0.001, 1.0, 0.1, 0.7), op(1, 0.6, 0.001, 1.2, 0.1, 0.8)]) },
];

export const FM_LABELS: Record<string, string> = Object.fromEntries(
  FM_BANK.map((p) => [p.id, p.label]),
);
export const FM_MAP: Record<string, FmPatch> = Object.fromEntries(
  FM_BANK.map((p) => [p.id, p]),
);

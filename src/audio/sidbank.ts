import type { SidConfig } from "./voices";

// C64 / SID instrument bank. Each patch is a combination of WAVEFORM + amplitude
// ENVELOPE + a resonant filter (often with its own envelope sweep) — which is
// where the SID gets its expressive range. Audition/tune on /debug.html.
//
// env(a,d,s,r): attack/decay seconds, sustain 0..1, release seconds.
// fenv adds `amount` (Hz the cutoff sweeps) on top of those.

const env = (a: number, d: number, s: number, r: number) => ({ a, d, s, r });

export interface SidPatch {
  id: string;
  label: string;
  config: SidConfig;
}

export const SID_BANK: SidPatch[] = [
  // --- basses ---
  { id: "sid_pluckbass", label: "Pluck Bass", config: {
    wave: "saw", amp: env(0.002, 0.18, 0.0, 0.12), level: 0.42,
    filter: { type: "lp", cutoff: 300, resonance: 0.5 }, fenv: { amount: 2200, ...env(0.001, 0.16, 0, 0.12) } } },
  { id: "sid_subbass", label: "Sub Bass", config: {
    wave: "triangle", amp: env(0.004, 0.1, 0.85, 0.12), level: 0.5,
    filter: { type: "lp", cutoff: 700, resonance: 0.2 } } },
  { id: "sid_reesebass", label: "Reso Bass", config: {
    wave: "pulse", pulseWidth: 0.5, amp: env(0.003, 0.12, 0.6, 0.1), level: 0.4,
    filter: { type: "lp", cutoff: 500, resonance: 0.7 }, fenv: { amount: 1500, ...env(0.001, 0.18, 0.1, 0.1) } } },

  // --- leads ---
  { id: "sid_resolead", label: "Reso Lead", config: {
    wave: "pulse", pulseWidth: 0.35, amp: env(0.005, 0.2, 0.7, 0.15), level: 0.34,
    filter: { type: "lp", cutoff: 900, resonance: 0.85 }, fenv: { amount: 2600, ...env(0.02, 0.3, 0.25, 0.2) } } },
  { id: "sid_sawlead", label: "Saw Lead", config: {
    wave: "saw", amp: env(0.006, 0.15, 0.8, 0.14), level: 0.32,
    filter: { type: "lp", cutoff: 2200, resonance: 0.4 } } },
  { id: "sid_pwmlead", label: "PWM Lead", config: {
    wave: "pulse", pulseWidth: 0.5, pwmRate: 1.2, pwmDepth: 0.35, amp: env(0.01, 0.2, 0.75, 0.18), level: 0.32,
    filter: { type: "lp", cutoff: 2600, resonance: 0.3 } } },

  // --- pads / strings ---
  { id: "sid_pwmstrings", label: "PWM Strings", config: {
    wave: "pulse", pulseWidth: 0.5, pwmRate: 0.5, pwmDepth: 0.42, amp: env(0.18, 0.4, 0.85, 0.4), level: 0.3,
    filter: { type: "lp", cutoff: 2200, resonance: 0.3 } } },
  { id: "sid_pad", label: "Sweep Pad", config: {
    wave: "saw", amp: env(0.3, 0.5, 0.8, 0.5), level: 0.3,
    filter: { type: "lp", cutoff: 400, resonance: 0.5 }, fenv: { amount: 2600, ...env(0.6, 0.8, 0.5, 0.6) } } },

  // --- keys / plucks / bells ---
  { id: "sid_organ", label: "Organ", config: {
    wave: "pulse", pulseWidth: 0.5, amp: env(0.005, 0.02, 1.0, 0.06), level: 0.3,
    filter: { type: "lp", cutoff: 3000, resonance: 0.15 } } },
  { id: "sid_harpsi", label: "Harpsi", config: {
    wave: "saw", amp: env(0.002, 0.3, 0.0, 0.2), level: 0.4,
    filter: { type: "lp", cutoff: 2600, resonance: 0.35 }, fenv: { amount: 1800, ...env(0.001, 0.25, 0, 0.2) } } },
  { id: "sid_bell", label: "Bell", config: {
    wave: "triangle", amp: env(0.002, 0.9, 0.1, 0.6), level: 0.75,
    filter: { type: "bp", cutoff: 2200, resonance: 0.6 } } },
  { id: "sid_blip", label: "Blip", config: {
    wave: "pulse", pulseWidth: 0.25, amp: env(0.001, 0.07, 0.0, 0.05), level: 0.4,
    filter: { type: "lp", cutoff: 3000, resonance: 0.4 } } },

  // --- effects / drums ---
  { id: "sid_zap", label: "Zap", config: {
    wave: "saw", amp: env(0.001, 0.25, 0.0, 0.1), level: 0.4,
    filter: { type: "lp", cutoff: 200, resonance: 0.85 }, fenv: { amount: 5000, ...env(0.001, 0.22, 0, 0.1) } } },
  { id: "sid_noise", label: "Noise Drum", config: {
    wave: "noise", amp: env(0.001, 0.14, 0.0, 0.08), level: 0.5,
    filter: { type: "bp", cutoff: 1800, resonance: 0.5 } } },
];

export const SID_LABELS: Record<string, string> = Object.fromEntries(SID_BANK.map((p) => [p.id, p.label]));
export const SID_MAP: Record<string, SidPatch> = Object.fromEntries(SID_BANK.map((p) => [p.id, p]));

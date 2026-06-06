// The active colour theme. Each sound font carries one; switching fonts swaps
// the whole "feel" (background shade + accents) while leaving the per-track
// instrument colours alone. The canvas renderers read this mutable object live;
// applyTheme also pushes the core values to CSS variables so the HTML chrome
// (top bar, buttons) themes too.

export interface Theme {
  bg: string;
  panel: string;
  panel2: string;
  ink: string;
  muted: string;
  accent: string;
  row: string;
  rowbeat: string;
  rowbar: string;
  grid: string;
  gutter: string;
  skipRail: string;
}

// Defaults match the NES theme so first paint is sensible before a font loads.
export const theme: Theme = {
  bg: "#1c1c1c",
  panel: "#282828",
  panel2: "#353535",
  ink: "#f2f2f2",
  muted: "#8a8a8a",
  accent: "#e5362a",
  row: "#242424",
  rowbeat: "#2e2e2e",
  rowbar: "#3c3c3c",
  grid: "#454545",
  gutter: "#181818",
  skipRail: "#101010",
};

export function applyTheme(t: Theme) {
  Object.assign(theme, t);
  const r = document.documentElement.style;
  r.setProperty("--bg", t.bg);
  r.setProperty("--panel", t.panel);
  r.setProperty("--panel2", t.panel2);
  r.setProperty("--ink", t.ink);
  r.setProperty("--muted", t.muted);
  r.setProperty("--accent", t.accent);
  r.setProperty("--grid", t.grid);
}

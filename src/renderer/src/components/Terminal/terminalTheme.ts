import type { ITheme } from "@xterm/xterm";
import { readAppTokens } from "../../lib/theme-tokens";

// xterm.js's ITheme is 18 colors: bg / fg / cursor / cursorAccent / selection
// + the 16 ANSI slots. We split the build:
//
//   - chrome (background/foreground/cursor/selection) is read from Spark's
//     CSS-variable design tokens via theme-tokens.ts. This guarantees the
//     terminal visually fuses with the surrounding panel chrome and tracks
//     named theme changes and accent color changes.
//
//   - the 16 ANSI slots switch between dark and light terminal palettes. The
//     design tokens are intentionally grayscale, so we keep the semantic
//     colors here and choose the variant that has readable contrast against
//     the active workbench theme.

const darkAnsi = {
  black: "#18181b",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#3b82f6",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#e4e4e7",

  brightBlack: "#52525b",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#facc15",
  brightBlue: "#60a5fa",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
} as const;

const lightAnsi = {
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",

  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#7d4e00",
  brightBlue: "#0550ae",
  brightMagenta: "#6639ba",
  brightCyan: "#0f6b73",
  brightWhite: "#24292f",
} as const;

// readAppTokens hands back resolved rgb()/rgba() strings. Pull the channels so
// we can judge background lightness and re-alpha the accent for selection.
function parseRgb(value: string): [number, number, number] | null {
  const m = value.match(/-?\d+(?:\.\d+)?/g);
  if (!m || m.length < 3) return null;
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

// Perceived luminance (sRGB-weighted), 0..1.
function luminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function withAlpha(value: string, alpha: number): string {
  const rgb = parseRgb(value);
  return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : value;
}

export function buildTerminalTheme(): ITheme {
  const t = readAppTokens();
  // Pick the ANSI variant from the ACTUAL terminal background rather than the
  // <html data-theme-mode> attribute. The attribute can read stale on the first
  // paint after a theme switch, which would leave a light surface painted with
  // the dark palette (light-on-light = the "terminal is unreadable in white
  // mode" report). Deriving from the resolved bg color makes the palette track
  // the surface it's literally drawn on.
  const bg = parseRgb(t.background);
  const isLight = bg
    ? luminance(bg) > 0.5
    : document.documentElement.dataset.themeMode === "light";
  const ansi = isLight ? lightAnsi : darkAnsi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.foreground,
    cursorAccent: t.background,
    // Translucent so selected glyphs stay legible: an opaque accent (especially
    // the bright workspace yellow over a light theme) buries the dark text
    // underneath it. xterm keeps the original foreground and washes the accent
    // over it.
    selectionBackground: withAlpha(t.accent, isLight ? 0.28 : 0.4),
    ...ansi,
  };
}

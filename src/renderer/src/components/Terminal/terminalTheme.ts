import type { ITheme } from "@xterm/xterm";
import { readAppTokens } from "../../lib/theme-tokens";

// xterm.js's ITheme is 18 colors: bg / fg / cursor / cursorAccent / selection
// + the 16 ANSI slots. We split the build:
//
//   - chrome (background/foreground/cursor/selection) is read from Spark's
//     CSS-variable design tokens via theme-tokens.ts. This guarantees the
//     terminal visually fuses with the surrounding panel chrome and tracks
//     light/dark mode flips and accent color changes.
//
//   - the 16 ANSI slots are a curated palette tuned for a dark surface. The
//     design tokens are intentionally grayscale, so we keep the semantic
//     palette here. (The exact values are ported verbatim from terax to
//     preserve visual continuity for users coming over.)

const ansi = {
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

export function buildTerminalTheme(): ITheme {
  const t = readAppTokens();
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.foreground,
    cursorAccent: t.background,
    selectionBackground: t.accent,
    ...ansi,
  };
}

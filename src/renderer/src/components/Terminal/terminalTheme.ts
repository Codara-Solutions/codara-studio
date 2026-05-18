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

export function buildTerminalTheme(): ITheme {
  const t = readAppTokens();
  const ansi = document.documentElement.dataset.themeMode === "light" ? lightAnsi : darkAnsi;
  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.foreground,
    cursorAccent: t.background,
    selectionBackground: t.accent,
    ...ansi,
  };
}

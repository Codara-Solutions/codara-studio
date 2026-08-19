"use strict";

// Terminal output helpers: Codara colors, the logo, and small formatters.
// Zero dependencies. Colors auto-disable when stdout is not a TTY.

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const wrap = (open, close) => (text) =>
  useColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);

const c = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  surface: wrap("48;5;235", "49"),
  surfaceStrong: wrap("48;5;237", "49"),
  violet: wrap("38;5;135", "39"),
  cyan: wrap("38;5;51", "39"),
  green: wrap("38;5;42", "39"),
  yellow: wrap("38;5;220", "39"),
  red: wrap("38;5;203", "39"),
  gray: wrap("38;5;245", "39"),
};

// The Codara "C" mark plus wordmark, in the brand violet→cyan sweep.
const LOGO_LINES = [
  "  ██████╗ ██████╗ ██████╗  █████╗ ",
  " ██╔════╝██╔═══██╗██╔══██╗██╔══██╗",
  " ██║     ██║   ██║██████╔╝███████║",
  " ██║     ██║   ██║██╔══██╗██╔══██║",
  " ╚██████╗╚██████╔╝██║  ██║██║  ██║",
  "  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝",
];

function logo() {
  if (!useColor) return LOGO_LINES.join("\n");
  // Sweep from violet to cyan across the rows.
  const sweep = [135, 141, 147, 87, 51, 51];
  return LOGO_LINES.map((line, i) => `\x1b[38;5;${sweep[i]}m${line}\x1b[39m`).join("\n");
}

function statusColor(status) {
  const s = String(status ?? "");
  if (["complete", "succeeded", "done"].includes(s)) return c.green(s);
  if (["failed", "error", "cancelled", "crashed"].includes(s)) return c.red(s);
  if (["blocked", "needs_review", "paused"].includes(s)) return c.yellow(s);
  if (["running", "working", "launching", "claimed"].includes(s)) return c.cyan(s);
  return c.gray(s || "?");
}

function pad(text, width) {
  const s = String(text ?? "");
  // Strip ANSI codes when measuring so colored cells still align.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  return visible.length >= width ? s : s + " ".repeat(width - visible.length);
}

/** Render rows as an aligned table. `rows` is an array of string arrays. */
function table(rows) {
  if (rows.length === 0) return "";
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      const len = String(cell ?? "").replace(/\x1b\[[0-9;]*m/g, "").length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    });
  }
  return rows
    .map((row) => row.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd())
    .join("\n");
}

function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function duration(fromIso, toIso) {
  if (!fromIso) return "";
  const ms = (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function fail(message) {
  console.error(c.red("cora: ") + message);
  process.exit(1);
}

module.exports = { c, logo, statusColor, pad, table, timeAgo, duration, fail };

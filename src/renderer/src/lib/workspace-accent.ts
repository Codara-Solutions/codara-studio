import {
  normalizeWorkspaceColor,
  readableWorkspaceAccent,
  workspaceAccentInk,
} from "@shared/workspace-colors";

export interface WorkspaceAccentTokens {
  raw: string;
  readable: string;
  ink: "#10100E" | "#FFFFFF";
}

/** Resolve one workspace color against the currently active theme palette. */
export function resolveWorkspaceAccent(color: string): WorkspaceAccentTokens {
  const root = document.documentElement;
  const tokens = getComputedStyle(root);
  const raw = normalizeWorkspaceColor(color) ?? "#2AA298";
  const surface = tokens.getPropertyValue("--panel-3").trim() || "#292724";
  const themeInk = tokens.getPropertyValue("--ink").trim() || "#F4F3F1";
  const readable = readableWorkspaceAccent(raw, surface, themeInk);
  return { raw, readable, ink: workspaceAccentInk(raw) };
}

/**
 * Apply the workspace identity verbatim. Fills, edges, glows, and diagrams use
 * `--accent`; small foregrounds use the contrast-safe `--accent-text`; text on
 * a solid accent fill uses `--accent-ink`. The selected identity never moves.
 */
export function applyWorkspaceAccent(color: string): void {
  const root = document.documentElement;
  const accent = resolveWorkspaceAccent(color);
  root.style.setProperty("--workspace-accent", accent.raw);
  root.style.setProperty("--accent", accent.raw);
  root.style.setProperty("--accent-text", accent.readable);
  root.style.setProperty("--accent-ink", accent.ink);
  root.style.setProperty("--on-accent", accent.ink);
}

// Per-launch auto-compact limits for the Claude Code and Codex terminals Cora
// opens. Codara never edits a CLI's own config for this: Codex takes a `-c`
// override on its command line, and Claude takes a `--settings` file that
// lives in Codara's home and carries this one environment variable on top of
// Codara's own hooks.

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  claudeAutoCompactPercentEnv,
  codexAutoCompactTokenLimit,
} from "@shared/context-compaction";

import { codaraHome } from "../codara-home";
import { writeFileAtomic } from "../fs-atomic";

export function claudeAutoCompactSettings(percent: number | null | undefined): Record<string, unknown> | null {
  const value = claudeAutoCompactPercentEnv(percent);
  return value === null ? null : { env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: value } };
}

/**
 * The `--settings` file for a Claude terminal at this limit, written on demand
 * and named by its content so concurrent launches share one immutable file.
 * Null when the limit is Auto.
 *
 * Claude keeps only the last `--settings` it is given, and a launch that
 * already carries one gets no hooks file from Codara, so this file must carry
 * the hooks itself or the pane never reports its state.
 */
export async function ensureClaudeAutoCompactSettingsFile(
  percent: number | null | undefined,
  home: string = codaraHome(),
): Promise<string | null> {
  const settings = claudeAutoCompactSettings(percent);
  if (!settings) return null;
  const hooks = await codaraClaudeHookSettings(home);
  const merged = hooks
    ? { ...hooks, env: { ...asRecord(hooks.env), ...(settings.env as Record<string, string>) } }
    : settings;
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  const value = claudeAutoCompactPercentEnv(percent);
  const name = hooks
    ? `claude-autocompact-${value}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.json`
    : `claude-autocompact-${value}.json`;
  const dir = join(home, "cli-launch");
  const file = join(dir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, text);
  return file;
}

// The `--settings` file writeIntegrationFiles keeps under <home>/integrations
// (hooks, and what "Keep agents in your Chrome" turns off); absent when it
// has neither, in which case only the limit is sent.
async function codaraClaudeHookSettings(home: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, "integrations", "claude", "settings.json"), "utf8"));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Everything buildStandingTerminalCommand needs for one batch of panes. */
export async function standingTerminalCompaction(
  percent: number | null | undefined,
  runtimes: readonly string[],
): Promise<{ codexTokenLimit: number | null; claudeSettingsPath: string | null }> {
  const claudeSettingsPath = runtimes.includes("claude")
    ? await ensureClaudeAutoCompactSettingsFile(percent).catch(() => null)
    : null;
  return { codexTokenLimit: codexAutoCompactTokenLimit(percent), claudeSettingsPath };
}

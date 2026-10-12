// Per-launch auto-compact limits for the Claude Code and Codex terminals Cora
// opens. Codara never edits a CLI's own config for this: Codex takes a `-c`
// override on its command line, and Claude takes a `--settings` file that
// lives in Codara's home and only carries this one environment variable.

import { mkdir } from "node:fs/promises";
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
 * and named by its value so concurrent launches share one immutable file.
 * Null when the limit is Auto.
 */
export async function ensureClaudeAutoCompactSettingsFile(
  percent: number | null | undefined,
  home: string = codaraHome(),
): Promise<string | null> {
  const settings = claudeAutoCompactSettings(percent);
  if (!settings) return null;
  const dir = join(home, "cli-launch");
  const file = join(dir, `claude-autocompact-${claudeAutoCompactPercentEnv(percent)}.json`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
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

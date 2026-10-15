// The Capability Center's skill origin channels: where each skill came from,
// whether its source moved, update and rollback, and the skills Claude Code
// plugins bring. The work modules load on first use, so none of this costs
// anything at startup.

import { join } from "node:path";
import type { AgentAssetDeleteResult, AgentAssetInstallResult } from "@shared/types";
import type { IpcHandle } from "./ipc";
import { claudeConfigDir } from "./orchestration/claude-paths";
import { codaraHomeDir } from "./orchestration/codara-managed-cli-roots";
import type { SkillUpdateOptions } from "./skill-updates";

/** Codara's record of where skills came from. */
export function skillOriginsDir(): string {
  return join(codaraHomeDir(), "skill-origins");
}

async function updateOptions(): Promise<SkillUpdateOptions> {
  // An update or rollback the user clicks may replace a skill folder they
  // copied into a CLI's skill folder (Add to Claude CLI). That is the same
  // explicit, user-requested write the Capability Center's skill install
  // makes, under the same capability.
  const { AGENT_CONFIG_EDIT } = await import("./agent-sync");
  return {
    stateDir: skillOriginsDir(),
    stagingDir: join(codaraHomeDir(), "tmp"),
    outsideWrite: AGENT_CONFIG_EDIT,
  };
}

function dirsFrom(input: unknown): string[] {
  const dirs = input && typeof input === "object" ? (input as { dirs?: unknown }).dirs : undefined;
  return Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string" && dir.length > 0).slice(0, 200) : [];
}

export function registerSkillUpdatesIpc(handle: IpcHandle): void {
  handle("skills:origins", async () => {
    const { listSkillOrigins } = await import("./skill-updates");
    return listSkillOrigins(await updateOptions());
  });
  handle("skills:checkUpdates", async (_event, input: unknown) => {
    const { checkSkillUpdates } = await import("./skill-updates");
    const force = Boolean(input && typeof input === "object" && (input as { force?: unknown }).force === true);
    return checkSkillUpdates({ ...(await updateOptions()), force });
  });
  handle("skills:update", async (_event, input: unknown) => {
    const { updateSkills } = await import("./skill-updates");
    return updateSkills({ dirs: dirsFrom(input) }, await updateOptions());
  });
  handle("skills:rollback", async (_event, input: unknown) => {
    const { rollbackSkills } = await import("./skill-updates");
    return rollbackSkills({ dirs: dirsFrom(input) }, await updateOptions());
  });
  handle("skills:pluginSkills", async (_event, input: unknown) => {
    const { listClaudePluginSkills } = await import("./claude-plugin-skills");
    const cwd = input && typeof input === "object" ? (input as { cwd?: unknown }).cwd : undefined;
    return listClaudePluginSkills({ claudeDir: claudeConfigDir(), cwd: typeof cwd === "string" ? cwd : null });
  });
}

/** A skill the user removed takes its origin record and kept version with it. */
export async function afterSkillAssetDeleted(result: AgentAssetDeleteResult): Promise<void> {
  if (!result.ok) return;
  // Skills report the folders they moved to the trash; MCP servers report
  // names, which never match a record.
  const dirs = result.deleted.filter((entry) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(entry));
  if (dirs.length === 0) return;
  try {
    const { forgetSkillOrigins } = await import("./skill-updates");
    await forgetSkillOrigins({ dirs }, await updateOptions());
  } catch {
    // The skill is gone either way; a stale record only names a folder that
    // no longer exists, which the list skips.
  }
}

/** A skill copied to a CLI (Add to Claude CLI) keeps knowing where it came from. */
export async function afterSkillAssetInstalled(id: string, result: AgentAssetInstallResult): Promise<void> {
  if (!result.ok || !result.path) return;
  let from: unknown;
  try {
    const parsed = JSON.parse(id) as { kind?: unknown; dir?: unknown };
    if (parsed.kind !== "skill") return;
    from = parsed.dir;
  } catch {
    return;
  }
  if (typeof from !== "string" || !from) return;
  try {
    const { copySkillOrigin } = await import("./skill-updates");
    await copySkillOrigin({ from, to: result.path }, await updateOptions());
  } catch {
    // The copy landed; it only lacks update tracking.
  }
}

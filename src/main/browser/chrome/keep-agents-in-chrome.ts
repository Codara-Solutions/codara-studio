// "Keep agents in your Chrome" (Settings > Browser > Chrome extension): the
// preference, where Codara looks for the browser tools it turns off, and
// putting the result on the launch flags of new sessions. Detection lives in
// separate-browser-tools.ts; the flags in agent-launch-integration.ts.

import { join } from "node:path";

import { setSeparateBrowserToolsGuard } from "../../agent-launch-integration";
import { claudeLiveConfigDir } from "../../orchestration/claude-cli-live-login";
import { claudeUserConfigFile, personalClaudeConfigDir } from "../../orchestration/claude-paths";
import { CODARA_CLAUDE_CLI_DIRNAME, codaraHomeDir } from "../../orchestration/codara-managed-cli-roots";
import { resolveCodexHomePaths } from "../../orchestration/codex-home";
import { getPreferenceCached, loadPreferences } from "../../preferences-store";
import {
  detectSeparateBrowserTools,
  separateBrowserToolsGuard,
  type DetectedSeparateBrowserTool,
  type SeparateBrowserTool,
  type SeparateBrowserToolsGuard,
} from "../../separate-browser-tools";
import { loadState } from "../../storage";

export function keepAgentsInChromeEnabled(): boolean {
  return getPreferenceCached("keepAgentsInYourChrome") !== false;
}

function codexConfigFile(): string[] {
  try {
    return [resolveCodexHomePaths().configPath];
  } catch {
    return [];
  }
}

/**
 * Every config a Codara session can read: the user's own Claude home and
 * Codara's live account slot (CLAUDE_CONFIG_DIR of managed accounts, whose
 * settings and plugins are links to the user's), Codex's home, and each
 * local workspace's project files.
 */
async function detect(): Promise<DetectedSeparateBrowserTool[]> {
  const live = claudeLiveConfigDir(join(codaraHomeDir(), CODARA_CLAUDE_CLI_DIRNAME));
  const workspaces = await loadState()
    .then((state) => state.workspaces.map((workspace) => workspace.cwd).filter((cwd) => !cwd.startsWith("ssh://")))
    .catch(() => [] as string[]);
  return detectSeparateBrowserTools({
    claudeConfigDirs: [personalClaudeConfigDir(), live],
    claudeUserConfigFiles: [claudeUserConfigFile(), join(live, ".claude.json")],
    codexConfigFiles: codexConfigFile(),
    workspaceDirs: workspaces,
  });
}

/** What new sessions get turned off, or null while the switch is off. */
export async function separateBrowserToolsGuardForLaunch(): Promise<SeparateBrowserToolsGuard | null> {
  await loadPreferences();
  if (!keepAgentsInChromeEnabled()) return null;
  return separateBrowserToolsGuard(await detect().catch(() => []));
}

let applying: Promise<unknown> = Promise.resolve();

/**
 * Re-read the user's tools and the switch, and rewrite the launch flags.
 * Returns what the user's configs hold, on or off, for Settings to list.
 */
export function applyKeepAgentsInChrome(): Promise<SeparateBrowserTool[]> {
  const run = applying.then(async () => {
    await loadPreferences();
    const tools = await detect().catch(() => []);
    await setSeparateBrowserToolsGuard(keepAgentsInChromeEnabled() ? separateBrowserToolsGuard(tools) : null);
    return tools.map(({ kind, name, launcher, source }) => ({ kind, name, launcher, source }));
  });
  applying = run.catch(() => undefined);
  return run;
}

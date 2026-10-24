import type {
  AppSettings,
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinRuntime,
} from "@shared/types";
import { writeShellArgsFiles } from "./agent-launch-integration";
import {
  installSparkBuiltin,
  installStudioToolsInOtherApps,
  removeStudioToolsFromOtherApps,
  uninstallSparkBuiltin,
} from "./mcp-installer";
import { loadSettings, onSettingsSaved } from "./storage";

// The Capability Center's per-CLI switch for the built-in server, shared by the
// desktop dialog and the phone remote. It decides whether Codara passes the
// server to the sessions it starts with that CLI; while "Codara tools in other
// apps" is on it also adds or removes the CLI's global entry.
export async function setSparkBuiltinInstalled(
  id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
  installed: boolean,
): Promise<SparkBuiltinActionResult> {
  const settings = await loadSettings();
  const options = { otherApps: settings.studioToolsInOtherApps === true };
  const result = await (installed ? installSparkBuiltin : uninstallSparkBuiltin)(id, runtime, options);
  // The pane functions read their flags from a file: rewrite it so the next
  // `claude` or `codex` typed in a pane follows the switch.
  await writeShellArgsFiles().catch(() => undefined);
  return result;
}

let lastOtherApps: boolean | null = null;
let otherAppsTail: Promise<unknown> = Promise.resolve();

/**
 * "Codara tools in other apps" acts when it is switched, from the desktop or
 * the phone, never at boot: turning it on adds the server to the user's own
 * CLI configs, turning it off removes exactly those entries.
 */
export function watchStudioToolsInOtherApps(initial: AppSettings): () => void {
  lastOtherApps = initial.studioToolsInOtherApps === true;
  return onSettingsSaved((settings) => {
    const next = settings.studioToolsInOtherApps === true;
    if (next === lastOtherApps) return;
    lastOtherApps = next;
    otherAppsTail = otherAppsTail.then(async () => {
      const result = next ? await installStudioToolsInOtherApps() : await removeStudioToolsFromOtherApps();
      if (!result.ok) console.warn("[builtin-mcp] Codara tools in other apps:", result.error);
    });
  });
}

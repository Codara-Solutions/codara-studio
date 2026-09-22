import type {
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinRuntime,
} from "@shared/types";
import { installSparkBuiltin, uninstallSparkBuiltin } from "./mcp-installer";
import { shareClaudeMcpServersNow } from "./orchestration/unified-account-migration";

// The Capability Center's per-CLI switch for the built-in server, shared by the
// desktop dialog and the phone remote. Claude sessions started from Codara read
// their account's copy of .claude.json, so a Claude change is shared straight
// away instead of waiting for the next launch.
export async function setSparkBuiltinInstalled(
  id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
  installed: boolean,
): Promise<SparkBuiltinActionResult> {
  const result = await (installed ? installSparkBuiltin : uninstallSparkBuiltin)(id, runtime);
  if (result.ok && runtime === "claude") {
    try {
      await shareClaudeMcpServersNow();
    } catch (err) {
      console.warn("[builtin-mcp] could not share the Claude MCP change with accounts:", err);
    }
  }
  return result;
}

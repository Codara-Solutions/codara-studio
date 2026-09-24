import type {
  SparkBuiltinActionResult,
  SparkBuiltinMcpId,
  SparkBuiltinRuntime,
} from "@shared/types";
import { installSparkBuiltin, uninstallSparkBuiltin } from "./mcp-installer";

// The Capability Center's per-CLI switch for the built-in server, shared by the
// desktop dialog and the phone remote. Every Claude account runs in the user's
// own Claude home, so the installer's edit already reaches every session.
export async function setSparkBuiltinInstalled(
  id: SparkBuiltinMcpId,
  runtime: SparkBuiltinRuntime,
  installed: boolean,
): Promise<SparkBuiltinActionResult> {
  return (installed ? installSparkBuiltin : uninstallSparkBuiltin)(id, runtime);
}

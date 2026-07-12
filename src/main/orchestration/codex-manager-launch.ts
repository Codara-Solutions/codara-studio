import type { ChatMode } from "@shared/types";

/** The spawn-time fields Cora's Codex manager consumes from chat config. */
export interface CodexManagerLaunchConfig {
  sessionUuid?: string | null;
  model?: string | null;
  effort?: string | null;
  fastMode: boolean;
  mode: ChatMode;
}

/**
 * Build the complete interactive Codex manager argv.
 *
 * Kept pure and separate from the Electron backend so the security/config
 * contract can be regression-tested without starting an app process.
 */
export function buildCodexManagerArgs(
  chat: CodexManagerLaunchConfig,
  promptPath: string,
  sparkHomeDir?: string,
): string[] {
  const args: string[] = [];
  if (chat.sessionUuid) {
    args.push("resume", chat.sessionUuid);
  }

  // Cora's manager must be able to invoke the trusted Codara MCP roster
  // without stopping at an interactive approval prompt. Keep this explicit:
  // `--yolo` is Codex's no-sandbox/no-approval launch contract.
  args.push("--yolo");
  if (chat.model) args.push("-m", chat.model);
  if (chat.effort) args.push("-c", `model_reasoning_effort=${chat.effort}`);

  // Make the composer's Fast choice authoritative regardless of config.toml.
  args.push(chat.fastMode ? "--enable" : "--disable", "fast_mode");
  args.push("-c", `model_instructions_file="${promptPath}"`);
  args.push("-c", "project_doc_max_bytes=0");

  // A hyphen is valid in a TOML bare key. Quoting only this middle segment in
  // a dotted CLI override (`mcp_servers."codara-studio".env...`) makes Codex
  // reject the configuration before it can create a rollout.
  if (chat.mode === "execute" || chat.mode === "auto") {
    args.push("-c", `mcp_servers.codara-studio.env.SPARK_MCP_MODE="execute"`);
  } else if (chat.mode === "automation") {
    args.push("-c", `mcp_servers.codara-studio.env.SPARK_MCP_MODE="automation"`);
  }
  // The globally-installed MCP block normally points at ~/.Codara. Tests,
  // portable installs, and explicit-home launches use a different handshake
  // directory, so make the live app's home authoritative per manager spawn.
  if (sparkHomeDir) {
    const escapedHome = sparkHomeDir.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    args.push("-c", `mcp_servers.codara-studio.env.SPARK_HOME_DIR="${escapedHome}"`);
  }

  return args;
}

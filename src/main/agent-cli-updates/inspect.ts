// What is installed for one agent CLI: where its binary is, its version and
// how it was installed. The probes come in as dependencies so the platform
// layouts and failure paths are tested with fake binaries.

import { parseCliVersion, type UpdatableAgentCliToolId } from "@shared/agent-cli-updates";

import { detectInstallPlan, spawnableCommand, type CliCommand, type InstallPlan } from "./install-plan";

export const VERSION_CHECK_TIMEOUT_MS = 15_000;

export interface InspectDependencies {
  platform: NodeJS.Platform;
  resolve: (name: string) => Promise<string | null>;
  realpath: (path: string) => Promise<string>;
  exists: (path: string) => Promise<boolean>;
  writable: (path: string) => Promise<boolean>;
  /** Runs a command and resolves with its output; rejects on a non-zero exit or a timeout. */
  run: (command: CliCommand & { verbatim: boolean }, timeoutMs: number) => Promise<string>;
}

export interface InstalledTool {
  tool: UpdatableAgentCliToolId;
  binaryPath: string;
  realPath: string;
  version: string | null;
  versionError: string | null;
  plan: InstallPlan;
}

export function versionCheckCommand(binary: string, platform: NodeJS.Platform) {
  return spawnableCommand({ executable: binary, args: ["--version"], display: "--version" }, platform);
}

/** The tool's version check: its `--version`, parsed. Throws when it fails or prints no version. */
export async function runVersionCheck(binary: string, deps: Pick<InspectDependencies, "platform" | "run">): Promise<string> {
  const output = await deps.run(versionCheckCommand(binary, deps.platform), VERSION_CHECK_TIMEOUT_MS);
  const version = parseCliVersion(output);
  if (!version) throw new Error(`The version check printed no version: ${output.trim().slice(0, 200) || "(nothing)"}`);
  return version;
}

export async function inspectInstalledTool(
  tool: UpdatableAgentCliToolId,
  deps: InspectDependencies,
): Promise<InstalledTool | null> {
  const binaryPath = await deps.resolve(tool);
  if (!binaryPath) return null;
  const realPath = await deps.realpath(binaryPath).catch(() => binaryPath);
  let version: string | null = null;
  let versionError: string | null = null;
  try {
    version = await runVersionCheck(binaryPath, deps);
  } catch (error) {
    versionError = (error as Error).message.slice(-400);
  }
  const plan = await detectInstallPlan({
    tool,
    platform: deps.platform,
    binaryPath,
    realPath,
    npmOnPath: await deps.resolve("npm"),
    exists: deps.exists,
    writable: deps.writable,
  });
  return { tool, binaryPath, realPath, version, versionError, plan };
}

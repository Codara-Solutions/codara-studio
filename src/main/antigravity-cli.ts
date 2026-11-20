// Google's Antigravity CLI (`agy`) as a terminal agent: the user's own
// binary and their own Google sign-in, started typed into a pane's shell like
// `pi`. Codara only asks whether the binary is there, so the new-tab menu can
// show the install command instead of a shell's "command not found". It never
// runs agy itself and never reads agy's own files.

import { runtimeFromProcessCommand } from "../shared/agent-patterns";
import { forgetResolvedBinary, resolveBinary } from "./binary-resolver";
import type { IpcHandle } from "./ipc";
import { descendantProcessesWithCommands } from "./owned-process-tree";
import { sessionPid } from "./pty-manager";

export const ANTIGRAVITY_BINARY = "agy";

/** Looked up afresh each time, so an install made while Codara runs is seen. */
export async function antigravityInstalled(): Promise<boolean> {
  forgetResolvedBinary(ANTIGRAVITY_BINARY);
  return (await resolveBinary(ANTIGRAVITY_BINARY)) !== null;
}

/**
 * Whether a real agy process runs under the pane's shell. A restore pointer
 * is saved only then: printed text that looks like a typed `agy` saves none.
 */
export async function antigravityRunsInPane(paneId: string): Promise<boolean> {
  const rootPid = sessionPid(paneId);
  if (rootPid === null) return false;
  const below = await descendantProcessesWithCommands(rootPid, 500).catch(() => null);
  return below?.some((proc) => runtimeFromProcessCommand(proc.command) === "antigravity") ?? false;
}

export function registerAntigravityIpc(handle: IpcHandle): void {
  handle("antigravity:installed", () => antigravityInstalled());
  handle("antigravity:runs-in-pane", (_e, paneId: unknown) =>
    typeof paneId === "string" ? antigravityRunsInPane(paneId) : false,
  );
}

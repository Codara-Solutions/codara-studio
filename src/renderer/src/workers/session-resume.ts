// Resuming a past agent session in a new terminal tab: which workspace it
// opens in and what the tab types. Pure, so scripts/test-session-search.cjs
// can check it without a renderer.

import { isSafeSessionId } from "@shared/session-search";
import type { TerminalAgentSession } from "../tabs/types";
import { buildAgentResumeCommand, type AgentSessionResumeRequest } from "./launch-commands";

function folderKey(value: string, platform: string): string {
  const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? path.toLowerCase() : path;
}

/** The local workspace of the session's folder, else the deepest local one holding it. */
export function workspaceForSessionFolder<T extends { cwd: string; remote?: unknown }>(
  workspaces: readonly T[],
  cwd: string,
  platform: string,
): T | null {
  const target = folderKey(cwd, platform);
  const local = workspaces.filter((item) => !item.remote);
  return (
    local.find((item) => folderKey(item.cwd, platform) === target) ??
    local
      .filter((item) => target.startsWith(`${folderKey(item.cwd, platform)}/`))
      .sort((a, b) => b.cwd.length - a.cwd.length)[0] ??
    null
  );
}

/** True when `cwd` is the folder of one of `workspaces`. */
export function hasWorkspaceFolder(workspaces: readonly { cwd: string }[], cwd: string, platform: string): boolean {
  const target = folderKey(cwd, platform);
  return workspaces.some((item) => folderKey(item.cwd, platform) === target);
}

/**
 * The command a resumed session's tab types and the pointer its pane keeps.
 * Null when the id is not one a CLI mints: it is typed into a shell.
 */
export function sessionResumeLaunch(
  request: AgentSessionResumeRequest,
  capturedAt: string,
): { command: string; pointer: TerminalAgentSession } | null {
  if (!isSafeSessionId(request.sessionId)) return null;
  const pointer: TerminalAgentSession = {
    runtime: request.runtime,
    nativeCodexProfileId: request.nativeCodexProfileId,
    nativeGrokProfileId: request.nativeGrokProfileId,
    sessionId: request.sessionId,
    cwd: request.cwd,
    transcriptPath: request.transcriptPath,
    capturedAt,
    active: false,
  };
  return { command: buildAgentResumeCommand(pointer), pointer };
}

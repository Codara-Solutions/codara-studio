// Resuming a past agent session in a new terminal tab: which workspace it
// opens in and what the tab types. Pure, so scripts/test-session-search.cjs
// can check it without a renderer.

import { isSafeSessionId } from "@shared/session-search";
import { collectLeaves } from "../tabs/paneTree";
import type { Tab, TerminalAgentSession } from "../tabs/types";
import {
  buildAgentForkCommand,
  buildAgentResumeCommand,
  type AgentSessionResumeRequest,
} from "./launch-commands";

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

/** The same for a fork; the pointer is null when the CLI mints the new id itself. */
export function sessionForkLaunch(
  request: AgentSessionResumeRequest,
  capturedAt: string,
): { command: string; pointer: TerminalAgentSession | null } | null {
  if (!isSafeSessionId(request.sessionId)) return null;
  const fork = buildAgentForkCommand(request.runtime, request.sessionId);
  if (!fork) return null;
  return {
    command: fork.command,
    pointer: fork.sessionId
      ? {
          runtime: request.runtime,
          nativeCodexProfileId: request.nativeCodexProfileId,
          nativeGrokProfileId: request.nativeGrokProfileId,
          sessionId: fork.sessionId,
          cwd: request.cwd,
          capturedAt,
          active: false,
        }
      : null,
  };
}

/**
 * The pane running this session now, asleep included, live layout first.
 * Resuming it again would put two agents on one transcript.
 */
export function findOpenSessionPane(
  layouts: readonly { workspaceId: string; tabs: readonly Tab[] }[],
  runtime: string,
  sessionId: string,
): { workspaceId: string; tabId: string; paneId: string } | null {
  for (const layout of [...layouts].reverse()) {
    for (const tab of layout.tabs) {
      if (tab.kind !== "terminal") continue;
      for (const leaf of collectLeaves(tab.root)) {
        const session = leaf.agentSession;
        if (session?.sessionId !== sessionId || session.runtime !== runtime) continue;
        const running = !!leaf.worker && leaf.worker.agentRunning !== false && leaf.worker.state !== "done";
        if (session.active === true || leaf.hibernation || running) {
          return { workspaceId: layout.workspaceId, tabId: tab.id, paneId: leaf.paneId };
        }
      }
    }
  }
  return null;
}

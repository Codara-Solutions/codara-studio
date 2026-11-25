// Resuming a past agent session in a new terminal tab: which workspace it
// opens in and what the tab types. Pure, so scripts/test-session-search.cjs
// can check it without a renderer.

import { isSafeSessionId } from "@shared/session-search";
import { collectLeaves } from "../tabs/paneTree";
import type { Tab, TerminalAgentSession } from "../tabs/types";
import {
  ANTIGRAVITY_CONTINUE_SESSION_ID,
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

/**
 * The Antigravity conversations panes other than `paneId` name by id. A new
 * pane must not take one of them as its own, and `agy --continue` must not
 * reopen one: two agy processes on one conversation would both write it.
 */
export function antigravityConversationsNamed(
  layouts: readonly { tabs: readonly Tab[] }[],
  paneId: string | null,
): string[] {
  const ids = new Set<string>();
  for (const layout of layouts) {
    for (const tab of layout.tabs) {
      if (tab.kind !== "terminal") continue;
      for (const leaf of collectLeaves(tab.root)) {
        const session = leaf.agentSession;
        if (leaf.paneId === paneId || session?.runtime !== "antigravity") continue;
        if (session.sessionId !== ANTIGRAVITY_CONTINUE_SESSION_ID && isSafeSessionId(session.sessionId)) {
          ids.add(session.sessionId);
        }
      }
    }
  }
  return [...ids];
}

/**
 * The pointer an Antigravity pane goes to sleep with: the one conversation
 * its agy holds open, which waking reopens with `agy --conversation <id>`.
 * A pane typed as `agy` or `agy --continue` names no id yet, and one whose
 * agy moved to another conversation names a stale one: both take the open
 * one, which only this pane's agy can hold. `skip` when it cannot be shown,
 * or when another pane names it: two agy processes must never share one.
 */
export function antigravitySleepPointer(
  session: TerminalAgentSession,
  open: string | null,
  namedElsewhere: readonly string[],
): { session: TerminalAgentSession } | { skip: string } {
  if (!open || !isSafeSessionId(open) || open === ANTIGRAVITY_CONTINUE_SESSION_ID) {
    return { skip: "agy's open conversation unknown" };
  }
  if (namedElsewhere.includes(open)) return { skip: "another pane names this conversation" };
  return { session: session.sessionId === open ? session : { ...session, sessionId: open } };
}

/**
 * Why a sleeping Antigravity pane must not run `agy --conversation <id>`
 * now, in the words its card shows; null when it may. `held`: some agy has
 * the conversation open or agy marks it working (null: unknown).
 */
export function antigravityWakeRefusal(
  sessionId: string | null | undefined,
  namedElsewhere: readonly string[],
  held: boolean | null,
): string | null {
  if (!sessionId || !isSafeSessionId(sessionId) || sessionId === ANTIGRAVITY_CONTINUE_SESSION_ID) {
    return "Codara does not know which Antigravity conversation this tab had. Close the tab and reopen the conversation from + > Antigravity worker.";
  }
  if (namedElsewhere.includes(sessionId)) return "Another tab has this Antigravity conversation. Close that tab, then try again.";
  if (held === true) return "Antigravity has this conversation open in another terminal. Close it there, then try again.";
  if (held === null) return "Codara could not check whether Antigravity has this conversation open elsewhere. Try again.";
  return null;
}

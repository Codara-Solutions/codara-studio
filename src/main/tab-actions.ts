// codara_tab: what an agent may do with a tab or group link. Pure, so the
// rules are testable without Electron (scripts/test-tab-actions.cjs).
//
// Focus is free: it shows the user a tab, as clicking the link would. Close,
// split and unsplit act at once on tabs the agent opened; any other tab, the
// user's or another agent's, needs the user's Allow on a card that lists
// exactly what changes. A link the user pasted is not that consent. Another
// workspace is never touched without the cross-workspace grant the user gave
// for terminals there, and an agent never closes the terminal it runs in.

import type { TabActionApprovalTab, TabActionKind } from "@shared/tab-actions";

export interface TabActionMember {
  tabId: string;
  kind: string;
  title: string;
  dirty?: boolean;
  paneIds?: string[];
  dockedIn?: string;
  mergedInto?: string;
  // Who opened a browser tab, as the renderer recorded it.
  openedBy?: { runId?: string | null; paneId?: string | null };
}

export interface TabActionTarget {
  workspaceId: string;
  loaded: boolean;
  kind: "tab" | "group";
  group?: { id: string; name: string };
  tabs: TabActionMember[];
}

export interface TabActionCaller {
  workspaceId: string;
  runId: string | null;
  paneId: string | null;
}

export interface TabActionDeps {
  ownsTerminalPane: (paneId: string, caller: TabActionCaller) => boolean;
  agentRunningIn: (paneId: string) => boolean;
  hasWorkspaceGrant: (callerWorkspaceId: string, targetWorkspaceId: string) => Promise<boolean>;
}

export type TabActionDecision =
  | { kind: "refuse"; code: string; reason: string }
  | {
      kind: "act";
      tabIds: string[];
      // Tabs the caller may not act on alone, with the card's rows; null
      // when every tab is the caller's own.
      approval: TabActionApprovalTab[] | null;
      skipped: Array<{ tabId: string; reason: string }>;
    };

function ownsTab(member: TabActionMember, caller: TabActionCaller, deps: TabActionDeps): boolean {
  if (member.kind === "terminal") {
    const panes = member.paneIds ?? [];
    return panes.length > 0 && panes.every((paneId) => deps.ownsTerminalPane(paneId, caller));
  }
  if (member.kind === "preview" && member.openedBy) {
    if (caller.runId) return member.openedBy.runId === caller.runId;
    return Boolean(caller.paneId) && !member.openedBy.runId && member.openedBy.paneId === caller.paneId;
  }
  return false;
}

function cardRow(member: TabActionMember, deps: TabActionDeps): TabActionApprovalTab {
  const agent = (member.paneIds ?? []).some((paneId) => deps.agentRunningIn(paneId));
  return {
    title: member.title || member.kind,
    kind: member.kind,
    ...(agent ? { warning: "agent" as const } : member.dirty ? { warning: "unsaved" as const } : {}),
  };
}

// What a background workspace's layout can close without being on screen.
function closableInBackground(member: TabActionMember): boolean {
  return member.kind === "terminal" || member.kind === "preview";
}

export async function decideTabAction(
  action: TabActionKind,
  target: TabActionTarget,
  caller: TabActionCaller,
  activeWorkspaceId: string | null,
  deps: TabActionDeps,
): Promise<TabActionDecision> {
  if (target.workspaceId !== caller.workspaceId && !(await deps.hasWorkspaceGrant(caller.workspaceId, target.workspaceId))) {
    return {
      kind: "refuse",
      code: "other_workspace",
      reason:
        "That tab is in another workspace, and the user has not allowed this workspace's agents to act there. Use focus to show it to the user, and ask them.",
    };
  }
  if (action !== "close") {
    if (target.kind === "group") {
      return { kind: "refuse", code: "needs_tab", reason: `${action} takes the link of one tab, not a group.` };
    }
    if (target.workspaceId !== activeWorkspaceId) {
      return {
        kind: "refuse",
        code: "not_on_screen",
        reason: `${action} works in the workspace on screen. Call focus with this link first, then ${action}.`,
      };
    }
  } else if (!target.loaded) {
    return {
      kind: "refuse",
      code: "not_loaded",
      reason: "That workspace has not been opened since Codara started, so its tabs are not running. Use focus to open it first.",
    };
  }

  const skipped: Array<{ tabId: string; reason: string }> = [];
  const acting: TabActionMember[] = [];
  for (const member of target.tabs) {
    if (action === "close" && caller.paneId && member.paneIds?.includes(caller.paneId)) {
      skipped.push({ tabId: member.tabId, reason: "it holds the terminal you run in" });
      continue;
    }
    if (action === "close" && target.workspaceId !== activeWorkspaceId && !closableInBackground(member)) {
      skipped.push({ tabId: member.tabId, reason: "only terminal and browser tabs close in a workspace that is not on screen" });
      continue;
    }
    acting.push(member);
  }
  if (acting.length === 0) {
    return {
      kind: "refuse",
      code: "nothing_to_do",
      reason: skipped.length > 0 ? `Nothing to ${action}: ${skipped.map((entry) => entry.reason).join("; ")}.` : `Nothing to ${action}.`,
    };
  }
  const needsApproval = acting.some((member) => !ownsTab(member, caller, deps));
  return {
    kind: "act",
    tabIds: acting.map((member) => member.tabId),
    approval: needsApproval ? acting.map((member) => cardRow(member, deps)) : null,
    skipped,
  };
}

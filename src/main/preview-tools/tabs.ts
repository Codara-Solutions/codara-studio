// codara_tab (socket tab.action): an agent acts on a tab or tab group by the
// link the user copied or a list tool returned (shared/tab-links.ts). The
// rules are in ../tab-actions.ts; the tabs themselves live in the renderer,
// reached through the terminal bridge's "tabs" and "tabAct" ops.

import { groupLink, parseTabLink, tabLink, type TabLinkRef } from "@shared/tab-links";
import type { TabActionKind } from "@shared/tab-actions";
import { hasCrossWorkspaceGrant } from "../cross-workspace-ipc";
import { askTabActionApproval, hasTabActionGrant } from "../tab-action-ipc";
import { decideTabAction, type TabActionCaller, type TabActionTarget } from "../tab-actions";
import { requestTerminalOp } from "../terminal-bridge";
import { loadState } from "../storage";
import { callerWorkspace } from "./workspace-status";
import { PreviewToolParamsError, type PreviewToolHost, type PreviewToolTable } from "./types";

const ACTIONS = ["info", "focus", "close", "split", "unsplit"] as const;
type Action = (typeof ACTIONS)[number];

const BARE_ID = /^[A-Za-z0-9_.:-]{1,120}$/;

// A codara:// link, or a tab id from codara_terminal_list or
// codara_preview_list, which means a tab of the caller's own workspace.
function readTarget(raw: unknown, workspaceId: string): TabLinkRef {
  const ref = parseTabLink(raw);
  if (ref) return ref;
  const text = typeof raw === "string" ? raw.trim().replace(/^preview:/, "") : "";
  if (BARE_ID.test(text)) return { kind: "tab", workspaceId, id: text };
  throw new PreviewToolParamsError("link must be a codara://tab/... or codara://group/... link, or a tabId from codara_terminal_list or codara_preview_list.");
}

function linkOf(ref: TabLinkRef): string {
  return ref.kind === "group" ? groupLink(ref.workspaceId, ref.id) : tabLink(ref.workspaceId, ref.id);
}

async function resolve(ref: TabLinkRef): Promise<{ target: TabActionTarget | null; activeWorkspaceId: string | null }> {
  const result = await requestTerminalOp<{ target: TabActionTarget | null; activeWorkspaceId: string | null }>("tabs", {
    link: linkOf(ref),
  });
  return { target: result?.target ?? null, activeWorkspaceId: result?.activeWorkspaceId ?? null };
}

function describeTabs(target: TabActionTarget, caller: TabActionCaller): Array<Record<string, unknown>> {
  return target.tabs.map((tab) => ({
    tabId: tab.tabId,
    link: tabLink(target.workspaceId, tab.tabId),
    kind: tab.kind,
    title: tab.title,
    ...(tab.paneIds?.length ? { paneIds: tab.paneIds } : {}),
    ...(tab.dockedIn ? { splitIn: tab.dockedIn } : {}),
    ...(tab.mergedInto ? { splitIn: tab.mergedInto } : {}),
    ...(tab.dirty ? { unsaved: true } : {}),
    ...(caller.paneId && tab.paneIds?.includes(caller.paneId) ? { isCaller: true } : {}),
  }));
}

async function workspaceName(workspaceId: string, host: PreviewToolHost): Promise<string> {
  if (host.workspaceName) return (await host.workspaceName(workspaceId)) ?? "this workspace";
  const state = await loadState();
  return state.workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "this workspace";
}

async function tabAction(params: Record<string, unknown>, _method: string, host: PreviewToolHost): Promise<unknown> {
  const action = params.action as Action;
  if (!ACTIONS.includes(action)) throw new PreviewToolParamsError(`action must be one of ${ACTIONS.join(", ")}.`);
  const direction = params.direction === undefined ? "right" : params.direction;
  if (direction !== "right" && direction !== "down") throw new PreviewToolParamsError("direction must be right or down.");
  const located = await callerWorkspace(params, host, "codara_tab");
  if ("refusal" in located) return { ok: false, ...located.refusal };
  const caller: TabActionCaller = {
    workspaceId: located.workspaceId,
    runId: typeof params.runId === "string" && params.runId ? params.runId : null,
    paneId: typeof params.callerPaneId === "string" && params.callerPaneId ? params.callerPaneId : null,
  };
  const ref = readTarget(params.link, caller.workspaceId);
  const link = linkOf(ref);
  const first = await resolve(ref);
  if (!first.target) {
    return {
      ok: false,
      reason: "closed",
      link,
      note: ref.kind === "group" ? "That tab group has no tabs left." : "That tab is closed.",
    };
  }
  const base = {
    link,
    workspaceId: first.target.workspaceId,
    ...(first.target.group ? { group: first.target.group.name, groupLink: groupLink(first.target.workspaceId, first.target.group.id) } : {}),
  };
  if (action === "info") {
    return { ok: true, action, ...base, onScreen: first.target.workspaceId === first.activeWorkspaceId, tabs: describeTabs(first.target, caller) };
  }
  if (action === "focus") {
    const focused = await requestTerminalOp<{ ok?: boolean }>("tabAct", { action: "focus", link });
    return focused?.ok ? { ok: true, action, ...base } : { ok: false, reason: "closed", link, note: "That tab is closed." };
  }

  const deps = {
    ownsTerminalPane: async (paneId: string) => (await host.ownsTerminalPane?.(paneId, params)) ?? false,
    agentRunningIn: (paneId: string) => host.agentRunningIn?.(paneId) ?? false,
    hasWorkspaceGrant: hasCrossWorkspaceGrant,
  };
  const decision = await decideTabAction(action as TabActionKind, first.target, caller, first.activeWorkspaceId, deps);
  if (decision.kind === "refuse") return { ok: false, reason: decision.code, ...base, note: decision.reason };
  let approved: "card" | "grant" | null = null;
  // A stored "Always allow" stands in for the card, except when closing
  // would stop an agent or drop unsaved edits: the user sees those every time.
  const losesWork = action === "close" && Boolean(decision.approval?.some((tab) => tab.warning));
  if (decision.approval && !losesWork && (await hasTabActionGrant(action as TabActionKind, caller.workspaceId, first.target.workspaceId))) {
    approved = "grant";
  } else if (decision.approval) {
    const answer = await askTabActionApproval({
      agent: located.by.label,
      action: action as TabActionKind,
      requester: caller.runId ? `run:${caller.runId}` : `pane:${caller.paneId ?? "none"}`,
      callerWorkspaceId: caller.workspaceId,
      callerName: await workspaceName(caller.workspaceId, host),
      workspaceId: first.target.workspaceId,
      workspaceName: await workspaceName(first.target.workspaceId, host),
      groupName: first.target.group ? first.target.group.name || "unnamed group" : null,
      tabs: decision.approval,
    });
    if (answer !== "once" && answer !== "always") {
      return {
        ok: false,
        reason: answer === "deny" ? "denied" : "no_answer",
        ...base,
        note: answer === "deny" ? "The user said no. Do not ask again for these tabs unless they tell you to." : "The user did not answer in time. Ask them in your reply.",
      };
    }
    approved = "card";
  }
  // The user may have closed or moved tabs while the card was open: act only
  // on what was asked for and is still there.
  const now = approved === "card" ? (await resolve(ref)).target : first.target;
  const still = new Set(now?.tabs.map((tab) => tab.tabId) ?? []);
  const tabIds = decision.tabIds.filter((tabId) => still.has(tabId));
  if (tabIds.length === 0) return { ok: false, reason: "closed", ...base, note: "Those tabs closed while the user was deciding." };
  const skipped = decision.skipped.length > 0 ? { skipped: decision.skipped } : {};
  if (action === "close") {
    const result = await requestTerminalOp<{ closed?: string[] }>("tabAct", { action, workspaceId: first.target.workspaceId, tabIds });
    return { ok: true, action, ...base, closed: result?.closed ?? [], ...(approved ? { approvedBy: approved } : {}), ...skipped };
  }
  const change = await requestTerminalOp<{ ok?: boolean; reason?: string }>("tabAct", { action, tabId: tabIds[0], direction });
  if (!change?.ok) return { ok: false, reason: "layout", ...base, note: change?.reason ?? `Codara could not ${action} that tab.` };
  return { ok: true, action, ...base, ...(action === "split" ? { direction } : {}), ...(approved ? { approvedBy: approved } : {}) };
}

export const tabTools: PreviewToolTable = {
  "tab.action": { run: tabAction, scope: "none", trustedRunsOnly: true },
};

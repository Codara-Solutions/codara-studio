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

const TAB_ACTION_BUDGET_MS = 55_000;
// Kept back from a card's wait for reading the tabs again and changing them.
const TAB_ACTION_WORK_RESERVE_MS = 10_000;
const TAB_ACTION_MIN_CARD_MS = 5_000;
const TAB_ACTION_MAX_CARDS = 3;

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

// One tab and what changing it would touch, as a card shows it: its panes
// and whether closing it stops an agent or drops unsaved edits.
function actingFingerprints(target: TabActionTarget, tabIds: string[], deps: { agentRunningIn(paneId: string): boolean }): string[] {
  return target.tabs
    .filter((tab) => tabIds.includes(tab.tabId))
    .map((tab) => {
      const panes = [...(tab.paneIds ?? [])].sort();
      const agent = panes.some((paneId) => deps.agentRunningIn(paneId));
      return JSON.stringify([tab.tabId, panes, agent, Boolean(tab.dirty)]);
    });
}

async function tabAction(params: Record<string, unknown>, _method: string, host: PreviewToolHost): Promise<unknown> {
  // The MCP server gives up on this call after 60 s: cards and the change
  // itself all fit inside this, so nothing happens after the agent left.
  const deadline = Date.now() + TAB_ACTION_BUDGET_MS;
  const action = params.action as Action;
  if (!ACTIONS.includes(action)) throw new PreviewToolParamsError(`action must be one of ${ACTIONS.join(", ")}.`);
  const direction = params.direction === undefined ? "right" : params.direction;
  if (direction !== "right" && direction !== "down") throw new PreviewToolParamsError("direction must be right or down.");
  const located = await callerWorkspace(params, host, "codara_tab");
  if ("refusal" in located) return { ok: false, ...located.refusal };
  const runId = typeof params.runId === "string" && params.runId ? params.runId : null;
  const caller: TabActionCaller = {
    workspaceId: located.workspaceId,
    runId,
    paneId: typeof params.callerPaneId === "string" && params.callerPaneId ? params.callerPaneId : null,
    // Stamped by the socket from the caller's verified pane.
    sessionId: !runId && typeof params.callerSessionId === "string" && params.callerSessionId ? params.callerSessionId : null,
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
  let decision = await decideTabAction(action as TabActionKind, first.target, caller, first.activeWorkspaceId, deps);
  if (decision.kind === "refuse") return { ok: false, reason: decision.code, ...base, note: decision.reason };
  let approved: "card" | "grant" | null = null;
  // A stored "Always allow" stands in for the card, except when closing
  // would stop an agent or drop unsaved edits: the user sees those every time.
  const losesWork = action === "close" && Boolean(decision.approval?.some((tab) => tab.warning));
  if (decision.approval && !losesWork && (await hasTabActionGrant(action as TabActionKind, caller.workspaceId, first.target.workspaceId))) {
    approved = "grant";
  } else if (decision.approval) {
    // What the user allowed: each tab with the panes inside it and what
    // closing it loses. The user may close, split or start agents while the
    // card is open, so after an Allow the tabs are read and decided again,
    // and anything not on an allowed card gets a card of its own.
    const allowed = new Set<string>();
    const names = {
      callerName: await workspaceName(caller.workspaceId, host),
      workspaceName: await workspaceName(first.target.workspaceId, host),
    };
    let target = first.target;
    for (let round = 0; ; round += 1) {
      if (decision.kind === "refuse") return { ok: false, reason: decision.code, ...base, note: decision.reason };
      const pending = actingFingerprints(target, decision.tabIds, deps).filter((print) => !allowed.has(print));
      if (pending.length === 0 || !decision.approval) break;
      const timeoutMs = deadline - Date.now() - TAB_ACTION_WORK_RESERVE_MS;
      if (round >= TAB_ACTION_MAX_CARDS || timeoutMs < TAB_ACTION_MIN_CARD_MS) {
        return { ok: false, reason: "no_answer", ...base, note: "The tabs kept changing while the user was deciding. Ask them in your reply." };
      }
      const answer = await askTabActionApproval(
        {
          agent: located.by.label,
          action: action as TabActionKind,
          requester: caller.runId ? `run:${caller.runId}` : `pane:${caller.paneId ?? "none"}`,
          callerWorkspaceId: caller.workspaceId,
          ...names,
          workspaceId: target.workspaceId,
          groupName: target.group ? target.group.name || "unnamed group" : null,
          tabs: decision.approval,
        },
        { timeoutMs, signal: host.signal },
      );
      // The agent stopped waiting: an Allow now would act for nobody.
      if (host.signal?.aborted) return { ok: false, reason: "no_answer", ...base, note: "You stopped waiting before the user answered." };
      if (answer !== "once" && answer !== "always") {
        return {
          ok: false,
          reason: answer === "deny" ? "denied" : "no_answer",
          ...base,
          note: answer === "deny" ? "The user said no. Do not ask again for these tabs unless they tell you to." : "The user did not answer in time. Ask them in your reply.",
        };
      }
      for (const print of actingFingerprints(target, decision.tabIds, deps)) allowed.add(print);
      approved = "card";
      const now = await resolve(ref);
      if (!now.target) return { ok: false, reason: "closed", ...base, note: "Those tabs closed while the user was deciding." };
      target = now.target;
      decision = await decideTabAction(action as TabActionKind, target, caller, now.activeWorkspaceId, deps);
    }
  }
  const tabIds = decision.tabIds;
  if (tabIds.length === 0) return { ok: false, reason: "closed", ...base, note: "Those tabs closed while the user was deciding." };
  const skipped = decision.skipped.length > 0 ? { skipped: decision.skipped } : {};
  const opTimeout = { timeoutMs: Math.max(1_000, deadline - Date.now()) };
  if (action === "close") {
    const result = await requestTerminalOp<{ closed?: string[] }>("tabAct", { action, workspaceId: first.target.workspaceId, tabIds }, opTimeout);
    return { ok: true, action, ...base, closed: result?.closed ?? [], ...(approved ? { approvedBy: approved } : {}), ...skipped };
  }
  const change = await requestTerminalOp<{ ok?: boolean; reason?: string }>("tabAct", { action, tabId: tabIds[0], direction }, opTimeout);
  if (!change?.ok) return { ok: false, reason: "layout", ...base, note: change?.reason ?? `Codara could not ${action} that tab.` };
  return { ok: true, action, ...base, ...(action === "split" ? { direction } : {}), ...(approved ? { approvedBy: approved } : {}) };
}

export const tabTools: PreviewToolTable = {
  "tab.action": { run: tabAction, scope: "none", trustedRunsOnly: true },
};

// The window half of codara_tab's approval (tab-actions.ts): the "Claude
// Code wants to close 3 tabs" card with Deny, Allow once and "Always allow
// <workspace> to close tabs here", and the grants Settings lists with Revoke.
// The queue and its rules are in tab-action-approvals.ts. Close and move
// grants live in their own files, in the cross-workspace grant format.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  TabActionAnswer,
  TabActionApprovalRequest,
  TabActionGrant,
  TabActionGrantKind,
  TabActionKind,
} from "@shared/tab-actions";
import { codaraHome } from "./codara-home";
import { fileGrantStore, type CrossWorkspaceGrantStore } from "./cross-workspace-terminals";
import type { IpcHandle } from "./ipc";
import { getTrustedMainWindow } from "./main-window-trust";
import { loadState } from "./storage";
import { TAB_ACTION_GRANT_KINDS, TabActionApprovals, type TabActionAsk } from "./tab-action-approvals";

export type { TabActionAsk } from "./tab-action-approvals";

export const TAB_ACTION_APPROVAL_TIMEOUT_MS = 40_000;
export const TAB_ACTION_GRANTS_FILES: Record<TabActionGrantKind, string> = {
  close: "tab-action-close-grants.json",
  move: "tab-action-move-grants.json",
};

const stores = new Map<TabActionGrantKind, CrossWorkspaceGrantStore>();

function sendToWindow(channel: string, payload: unknown): void {
  const win = getTrustedMainWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

// Settings lists the grants while it is open; tell it when they change.
function grantStore(kind: TabActionGrantKind): CrossWorkspaceGrantStore {
  let store = stores.get(kind);
  if (!store) {
    const file = fileGrantStore(join(codaraHome(), TAB_ACTION_GRANTS_FILES[kind]));
    store = {
      list: () => file.list(),
      has: (caller, target) => file.has(caller, target),
      async grant(entry) {
        await file.grant(entry);
        sendToWindow("tabAction:grantsChanged", null);
      },
      async revoke(caller, target) {
        const removed = await file.revoke(caller, target);
        if (removed) sendToWindow("tabAction:grantsChanged", null);
        return removed;
      },
    };
    stores.set(kind, store);
  }
  return store;
}

const approvals = new TabActionApprovals({
  grants: grantStore,
  show(request) {
    const win = getTrustedMainWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    win.webContents.send("tabAction:approval", request);
    if (!win.isFocused()) win.flashFrame(true);
    return true;
  },
  close: (payload) => sendToWindow("tabAction:approvalClosed", payload),
  newId: () => randomBytes(12).toString("hex"),
});

// Whether the user answered "Always allow" for agents of `callerWorkspaceId`
// to do this kind of action (close, or move) in `workspaceId`.
export function hasTabActionGrant(action: TabActionKind, callerWorkspaceId: string, workspaceId: string): Promise<boolean> {
  return approvals.hasGrant(action, callerWorkspaceId, workspaceId);
}

// Resolves the user's answer, or null when no window can ask, the user did
// not answer within `timeoutMs`, or `signal` fired because the agent stopped
// waiting.
export function askTabActionApproval(
  input: TabActionAsk,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TabActionAnswer | null> {
  return approvals.ask(input, {
    timeoutMs: Math.min(options.timeoutMs ?? TAB_ACTION_APPROVAL_TIMEOUT_MS, TAB_ACTION_APPROVAL_TIMEOUT_MS),
    signal: options.signal,
  });
}

function isAnswer(value: unknown): value is TabActionAnswer {
  return value === "once" || value === "always" || value === "deny";
}

function isGrantKind(value: unknown): value is TabActionGrantKind {
  return TAB_ACTION_GRANT_KINDS.includes(value as TabActionGrantKind);
}

export function registerTabActionIpc(handle: IpcHandle): void {
  handle("tabAction:pending", async (): Promise<TabActionApprovalRequest[]> => approvals.list());
  handle("tabAction:answer", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { id?: unknown; answer?: unknown } | null;
    if (!value || typeof value.id !== "string" || !isAnswer(value.answer)) return false;
    return approvals.answer(value.id, value.answer);
  });
  handle("tabAction:grants", async (): Promise<TabActionGrant[]> => {
    const grants = await approvals.listGrants();
    // A removed workspace's id never comes back, so its grants are dead weight.
    const live = new Set((await loadState()).workspaces.map((workspace) => workspace.id));
    const kept: TabActionGrant[] = [];
    for (const grant of grants) {
      if (live.has(grant.callerWorkspaceId) && live.has(grant.targetWorkspaceId)) kept.push(grant);
      else await approvals.revoke(grant.action, grant.callerWorkspaceId, grant.targetWorkspaceId).catch(() => false);
    }
    return kept;
  });
  handle("tabAction:revoke", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { action?: unknown; callerWorkspaceId?: unknown; targetWorkspaceId?: unknown } | null;
    if (!isGrantKind(value?.action) || typeof value.callerWorkspaceId !== "string" || typeof value.targetWorkspaceId !== "string") {
      return false;
    }
    return approvals.revoke(value.action, value.callerWorkspaceId, value.targetWorkspaceId);
  });
}

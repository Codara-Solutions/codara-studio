// The window half of codara_tab's approval (tab-actions.ts): the "Claude
// Code wants to close 3 tabs" card with Deny, Allow once and "Always allow
// <workspace> to close tabs here", and the grants Settings lists with Revoke.
// Grants live in their own file, in the cross-workspace grant format.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  TabActionAnswer,
  TabActionApprovalClosed,
  TabActionApprovalRequest,
  TabActionGrant,
} from "@shared/tab-actions";
import { codaraHome } from "./codara-home";
import { fileGrantStore, type CrossWorkspaceGrantStore } from "./cross-workspace-terminals";
import type { IpcHandle } from "./ipc";
import { getTrustedMainWindow } from "./main-window-trust";
import { loadState } from "./storage";

export const TAB_ACTION_APPROVAL_TIMEOUT_MS = 40_000;
export const TAB_ACTION_GRANTS_FILE = "tab-action-grants.json";

export interface TabActionAsk extends Omit<TabActionApprovalRequest, "id" | "expiresAt"> {
  callerWorkspaceId: string;
  workspaceId: string;
}

interface PendingAsk {
  request: TabActionApprovalRequest;
  pair: string;
  losesWork: boolean;
  answer(value: TabActionAnswer | null): void;
}

const pending = new Map<string, PendingAsk>();
let store: CrossWorkspaceGrantStore | null = null;

function sendToWindow(channel: string, payload: unknown): void {
  const win = getTrustedMainWindow();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function closeCard(payload: TabActionApprovalClosed): void {
  sendToWindow("tabAction:approvalClosed", payload);
}

// Settings lists the grants while it is open; tell it when they change.
function grantStore(): CrossWorkspaceGrantStore {
  if (!store) {
    const file = fileGrantStore(join(codaraHome(), TAB_ACTION_GRANTS_FILE));
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
  }
  return store;
}

// Whether the user answered "Always allow" for agents of `callerWorkspaceId`
// changing tabs in `workspaceId`. Only a stored grant or the card counts; an
// agent saying the user agreed never does.
export function hasTabActionGrant(callerWorkspaceId: string, workspaceId: string): Promise<boolean> {
  return grantStore().has(callerWorkspaceId, workspaceId);
}

// Resolves the user's answer ("always" is stored before it resolves), or null
// when no window can ask or the user did not answer in time.
export function askTabActionApproval(input: TabActionAsk): Promise<TabActionAnswer | null> {
  const win = getTrustedMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(null);
  const id = randomBytes(12).toString("hex");
  const { callerWorkspaceId, workspaceId, ...shown } = input;
  const request: TabActionApprovalRequest = { ...shown, id, expiresAt: Date.now() + TAB_ACTION_APPROVAL_TIMEOUT_MS };
  return new Promise<TabActionAnswer | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      closeCard({ id, reason: "expired" });
      resolve(null);
    }, TAB_ACTION_APPROVAL_TIMEOUT_MS);
    pending.set(id, {
      request,
      pair: JSON.stringify([callerWorkspaceId, workspaceId]),
      losesWork: input.action === "close" && input.tabs.some((tab) => tab.warning),
      answer: async (value) => {
        clearTimeout(timer);
        pending.delete(id);
        if (value === "always") {
          await grantStore()
            .grant({ callerWorkspaceId, callerName: input.callerName, targetWorkspaceId: workspaceId, targetName: input.workspaceName })
            .catch(() => undefined);
        }
        resolve(value);
      },
    });
    win.webContents.send("tabAction:approval", request);
    if (!win.isFocused()) win.flashFrame(true);
  });
}

function isAnswer(value: unknown): value is TabActionAnswer {
  return value === "once" || value === "always" || value === "deny";
}

export function registerTabActionIpc(handle: IpcHandle): void {
  handle("tabAction:pending", async (): Promise<TabActionApprovalRequest[]> =>
    [...pending.values()].map((entry) => entry.request),
  );
  handle("tabAction:answer", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { id?: unknown; answer?: unknown } | null;
    const entry = value && typeof value.id === "string" ? pending.get(value.id) : undefined;
    if (!entry || !isAnswer(value!.answer)) return false;
    entry.answer(value!.answer);
    // The grant covers the other cards of the same pair, except those where
    // closing loses an agent or unsaved edits: a grant never skips those.
    if (value!.answer === "always") {
      for (const [otherId, other] of [...pending]) {
        if (other.pair !== entry.pair || other.losesWork) continue;
        other.answer("always");
        closeCard({ id: otherId, reason: "answered" });
      }
    }
    return true;
  });
  handle("tabAction:grants", async (): Promise<TabActionGrant[]> => {
    const grants = await grantStore().list();
    // A removed workspace's id never comes back, so its grants are dead weight.
    const live = new Set((await loadState()).workspaces.map((workspace) => workspace.id));
    const kept: TabActionGrant[] = [];
    for (const grant of grants) {
      if (live.has(grant.callerWorkspaceId) && live.has(grant.targetWorkspaceId)) kept.push(grant);
      else await grantStore().revoke(grant.callerWorkspaceId, grant.targetWorkspaceId).catch(() => false);
    }
    return kept;
  });
  handle("tabAction:revoke", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { callerWorkspaceId?: unknown; targetWorkspaceId?: unknown } | null;
    if (typeof value?.callerWorkspaceId !== "string" || typeof value.targetWorkspaceId !== "string") return false;
    return grantStore().revoke(value.callerWorkspaceId, value.targetWorkspaceId);
  });
}

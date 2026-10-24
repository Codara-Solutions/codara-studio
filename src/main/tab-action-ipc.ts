// The window half of codara_tab's approval (tab-actions.ts): the "Claude
// Code wants to close 3 tabs" card. Unlike the cross-workspace card there is
// no Always: every close, split or unsplit of tabs the agent did not open is
// asked for on its own.

import { randomBytes } from "node:crypto";
import type {
  TabActionAnswer,
  TabActionApprovalClosed,
  TabActionApprovalRequest,
} from "@shared/tab-actions";
import type { IpcHandle } from "./ipc";
import { getTrustedMainWindow } from "./main-window-trust";

export const TAB_ACTION_APPROVAL_TIMEOUT_MS = 40_000;

interface PendingAsk {
  request: TabActionApprovalRequest;
  answer(value: TabActionAnswer | null): void;
}

const pending = new Map<string, PendingAsk>();

// Resolves "allow" or "deny", or null when no window can ask or the user did
// not answer in time.
export function askTabActionApproval(
  input: Omit<TabActionApprovalRequest, "id" | "expiresAt">,
): Promise<TabActionAnswer | null> {
  const win = getTrustedMainWindow();
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(null);
  const id = randomBytes(12).toString("hex");
  const request: TabActionApprovalRequest = { ...input, id, expiresAt: Date.now() + TAB_ACTION_APPROVAL_TIMEOUT_MS };
  return new Promise<TabActionAnswer | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const closed: TabActionApprovalClosed = { id, reason: "expired" };
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("tabAction:approvalClosed", closed);
      resolve(null);
    }, TAB_ACTION_APPROVAL_TIMEOUT_MS);
    pending.set(id, {
      request,
      answer: (value) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      },
    });
    win.webContents.send("tabAction:approval", request);
    if (!win.isFocused()) win.flashFrame(true);
  });
}

export function registerTabActionIpc(handle: IpcHandle): void {
  handle("tabAction:pending", async (): Promise<TabActionApprovalRequest[]> =>
    [...pending.values()].map((entry) => entry.request),
  );
  handle("tabAction:answer", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { id?: unknown; answer?: unknown } | null;
    const entry = value && typeof value.id === "string" ? pending.get(value.id) : undefined;
    if (!entry || (value!.answer !== "allow" && value!.answer !== "deny")) return false;
    entry.answer(value!.answer);
    return true;
  });
}

// The window half of cross-workspace terminals (cross-workspace-terminals.ts):
// the "Allow <caller> to open terminals in <target>?" card, and the grants
// list Settings shows with Revoke.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type {
  CrossWorkspaceAnswer,
  CrossWorkspaceApprovalRequest,
  CrossWorkspaceGrant,
} from "@shared/cross-workspace";
import { codaraHome } from "./codara-home";
import {
  CROSS_WORKSPACE_APPROVAL_TIMEOUT_MS,
  CROSS_WORKSPACE_GRANTS_FILE,
  createCrossWorkspaceApprover,
  fileGrantStore,
  type CrossWorkspaceApprover,
  type CrossWorkspaceAsk,
  type CrossWorkspaceGrantStore,
} from "./cross-workspace-terminals";
import type { IpcHandle } from "./ipc";
import { getTrustedMainWindow } from "./main-window-trust";

let store: CrossWorkspaceGrantStore | null = null;
let approver: CrossWorkspaceApprover | null = null;

interface PendingAsk {
  request: CrossWorkspaceApprovalRequest;
  answer(value: CrossWorkspaceAnswer | null): void;
}

const pending = new Map<string, PendingAsk>();

function grantStore(): CrossWorkspaceGrantStore {
  store ??= fileGrantStore(join(codaraHome(), CROSS_WORKSPACE_GRANTS_FILE));
  return store;
}

const askInWindow: CrossWorkspaceAsk = async ({ caller, target, agent }) => {
  const win = getTrustedMainWindow();
  if (!win || win.webContents.isDestroyed()) return null;
  const id = randomBytes(12).toString("hex");
  const request: CrossWorkspaceApprovalRequest = {
    id,
    callerName: caller.name,
    targetName: target.name,
    agent,
    expiresAt: Date.now() + CROSS_WORKSPACE_APPROVAL_TIMEOUT_MS,
  };
  return new Promise<CrossWorkspaceAnswer | null>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send("crossWorkspace:approvalClosed", { id });
      }
      resolve(null);
    }, CROSS_WORKSPACE_APPROVAL_TIMEOUT_MS);
    pending.set(id, {
      request,
      answer: (value) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      },
    });
    win.webContents.send("crossWorkspace:approval", request);
    if (!win.isFocused()) win.flashFrame(true);
  });
};

export function crossWorkspaceApprover(): CrossWorkspaceApprover {
  approver ??= createCrossWorkspaceApprover({ store: grantStore(), ask: askInWindow });
  return approver;
}

function isAnswer(value: unknown): value is CrossWorkspaceAnswer {
  return value === "once" || value === "always" || value === "deny";
}

export function registerCrossWorkspaceIpc(handle: IpcHandle): void {
  handle("crossWorkspace:pending", async (): Promise<CrossWorkspaceApprovalRequest[]> =>
    [...pending.values()].map((entry) => entry.request),
  );
  handle("crossWorkspace:answer", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { id?: unknown; answer?: unknown } | null;
    const entry = value && typeof value.id === "string" ? pending.get(value.id) : undefined;
    if (!entry || !isAnswer(value!.answer)) return false;
    entry.answer(value!.answer);
    return true;
  });
  handle("crossWorkspace:grants", async (): Promise<CrossWorkspaceGrant[]> => grantStore().list());
  handle("crossWorkspace:revoke", async (_event, raw: unknown): Promise<boolean> => {
    const value = raw as { callerWorkspaceId?: unknown; targetWorkspaceId?: unknown } | null;
    if (typeof value?.callerWorkspaceId !== "string" || typeof value.targetWorkspaceId !== "string") return false;
    return grantStore().revoke(value.callerWorkspaceId, value.targetWorkspaceId);
  });
}

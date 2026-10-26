// The cards codara_tab waits on (tab-actions.ts decides when one is needed)
// and the "Always allow" grants that stand in for them. Pure apart from the
// injected window and grant files, so scripts/test-tab-action-approvals.cjs
// drives it without Electron; tab-action-ipc.ts wires it to the window.

import type {
  TabActionAnswer,
  TabActionApprovalClosed,
  TabActionApprovalRequest,
  TabActionGrant,
  TabActionGrantKind,
  TabActionKind,
} from "@shared/tab-actions";
import type { CrossWorkspaceGrantStore } from "./cross-workspace-terminals";

export const TAB_ACTION_GRANT_KINDS: readonly TabActionGrantKind[] = ["close", "move"];

export function tabActionGrantKind(action: TabActionKind): TabActionGrantKind {
  return action === "close" ? "close" : "move";
}

export interface TabActionAsk extends Omit<TabActionApprovalRequest, "id" | "expiresAt"> {
  callerWorkspaceId: string;
  workspaceId: string;
  // `run:<id>` or `pane:<id>`: an Always answers only this caller's other cards.
  requester: string;
}

export interface TabActionApprovalsDeps {
  grants(kind: TabActionGrantKind): CrossWorkspaceGrantStore;
  // False when no window can show the card.
  show(request: TabActionApprovalRequest): boolean;
  close(payload: TabActionApprovalClosed): void;
  newId?(): string;
}

interface PendingAsk {
  request: TabActionApprovalRequest;
  // Caller workspace, target workspace, action kind and requester.
  scope: string;
  losesWork: boolean;
  answer(value: TabActionAnswer | null): Promise<void>;
}

export class TabActionApprovals {
  private readonly pending = new Map<string, PendingAsk>();
  private nextId = 0;

  constructor(private readonly deps: TabActionApprovalsDeps) {}

  // Only a stored grant or the card counts; an agent saying the user agreed
  // never does.
  hasGrant(action: TabActionKind, callerWorkspaceId: string, workspaceId: string): Promise<boolean> {
    return this.deps.grants(tabActionGrantKind(action)).has(callerWorkspaceId, workspaceId);
  }

  async listGrants(): Promise<TabActionGrant[]> {
    const all: TabActionGrant[] = [];
    for (const action of TAB_ACTION_GRANT_KINDS) {
      for (const grant of await this.deps.grants(action).list()) all.push({ ...grant, action });
    }
    return all;
  }

  revoke(action: TabActionGrantKind, callerWorkspaceId: string, workspaceId: string): Promise<boolean> {
    return this.deps.grants(action).revoke(callerWorkspaceId, workspaceId);
  }

  list(): TabActionApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.request);
  }

  // Resolves the user's answer ("always" is stored before it resolves), or
  // null when no window can ask, the user did not answer in time, or the
  // signal fired because the agent stopped waiting. The card closes then, so
  // a late Allow acts for nobody.
  ask(input: TabActionAsk, options: { timeoutMs: number; signal?: AbortSignal }): Promise<TabActionAnswer | null> {
    if (options.signal?.aborted) return Promise.resolve(null);
    const id = this.deps.newId?.() ?? `tab-action-${++this.nextId}`;
    const { callerWorkspaceId, workspaceId, requester, ...shown } = input;
    const request: TabActionApprovalRequest = { ...shown, id, expiresAt: Date.now() + options.timeoutMs };
    const kind = tabActionGrantKind(input.action);
    return new Promise<TabActionAnswer | null>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", withdraw);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        this.deps.close({ id, reason: "expired" });
        resolve(null);
      }, options.timeoutMs);
      const withdraw = () => {
        finish();
        this.deps.close({ id, reason: "withdrawn" });
        resolve(null);
      };
      options.signal?.addEventListener("abort", withdraw, { once: true });
      this.pending.set(id, {
        request,
        scope: JSON.stringify([callerWorkspaceId, workspaceId, kind, requester]),
        losesWork: input.action === "close" && input.tabs.some((tab) => tab.warning),
        answer: async (value) => {
          finish();
          if (value === "always") {
            await this.deps
              .grants(kind)
              .grant({ callerWorkspaceId, callerName: input.callerName, targetWorkspaceId: workspaceId, targetName: input.workspaceName })
              .catch(() => undefined);
          }
          resolve(value);
        },
      });
      if (!this.deps.show(request)) {
        finish();
        resolve(null);
      }
    });
  }

  // False when the card is no longer waited for. An Always also answers the
  // same caller's other cards for the same action and pair, except those
  // where closing loses an agent or unsaved edits: a grant never skips those.
  async answer(id: string, value: TabActionAnswer): Promise<boolean> {
    const entry = this.pending.get(id);
    if (!entry) return false;
    await entry.answer(value);
    if (value === "always") {
      for (const [otherId, other] of [...this.pending]) {
        if (other.scope !== entry.scope || other.losesWork) continue;
        await other.answer("always");
        this.deps.close({ id: otherId, reason: "answered" });
      }
    }
    return true;
  }
}

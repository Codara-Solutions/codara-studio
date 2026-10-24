// An agent asks to close, split or unsplit tabs it did not open
// (codara_tab). Main shows the user one card listing exactly which tabs, and
// acts only on an Allow there or on a grant the user stored with "Always
// allow"; see src/main/tab-actions.ts.

import type { CrossWorkspaceGrant } from "./cross-workspace";

export type TabActionKind = "close" | "split" | "unsplit";

export type TabActionAnswer = "once" | "always" | "deny";

// Agents of the caller workspace may change tabs they did not open in the
// target workspace without a card, unless something would be lost. Same
// record as a cross-workspace terminal grant; caller and target are often
// the same workspace.
export type TabActionGrant = CrossWorkspaceGrant;

export interface TabActionApprovalTab {
  title: string;
  kind: string;
  // Why closing it costs something: an agent is running in it, or an editor
  // has unsaved changes.
  warning?: "agent" | "unsaved";
}

export interface TabActionApprovalRequest {
  id: string;
  // The agent CLI or Cora; display only.
  agent: string;
  action: TabActionKind;
  // The agent's workspace, named on "Always allow".
  callerName: string;
  workspaceName: string;
  groupName: string | null;
  tabs: TabActionApprovalTab[];
  expiresAt: number;
}

// Main stopped waiting for a card: it timed out, or another card's Always
// answered it.
export interface TabActionApprovalClosed {
  id: string;
  reason: "expired" | "answered";
}

// An agent asks to close, split or unsplit tabs it did not open
// (codara_tab). Main shows the user one card listing exactly which tabs, and
// acts only on an Allow there or on a grant the user stored with "Always
// allow"; see src/main/tab-actions.ts.

import type { CrossWorkspaceGrant } from "./cross-workspace";

export type TabActionKind = "close" | "split" | "unsplit";

export type TabActionAnswer = "once" | "always" | "deny";

// What an "Always allow" covers: closing tabs, or moving them (split and
// unsplit). Allowing one never allows the other.
export type TabActionGrantKind = "close" | "move";

// Agents of the caller workspace may close, or move, tabs they did not open
// in the target workspace without a card, unless something would be lost.
// Same record as a cross-workspace terminal grant plus its action; caller
// and target are often the same workspace.
export type TabActionGrant = CrossWorkspaceGrant & { action: TabActionGrantKind };

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

// Main stopped waiting for a card: it timed out, another card's Always
// answered it, or the agent stopped waiting (its call timed out or it went
// away), so an Allow now would act for nobody.
export interface TabActionApprovalClosed {
  id: string;
  reason: "expired" | "answered" | "withdrawn";
}

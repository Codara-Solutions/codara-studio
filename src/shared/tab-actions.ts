// An agent asks to close, split or unsplit tabs it did not open
// (codara_tab). Main shows the user one card listing exactly which tabs, and
// acts only on Allow; see src/main/tab-actions.ts.

export type TabActionKind = "close" | "split" | "unsplit";

export type TabActionAnswer = "allow" | "deny";

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
  workspaceName: string;
  groupName: string | null;
  tabs: TabActionApprovalTab[];
  expiresAt: number;
}

export interface TabActionApprovalClosed {
  id: string;
  reason: "expired";
}

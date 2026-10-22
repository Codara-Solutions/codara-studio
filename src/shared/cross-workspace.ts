// An agent asks to open a terminal in a workspace other than its own
// (codara_terminal_create with `workspace`). Main asks the user once per
// caller and target workspace pair; see src/main/cross-workspace-terminals.ts.

export type CrossWorkspaceAnswer = "once" | "always" | "deny";

export interface CrossWorkspaceApprovalRequest {
  id: string;
  callerName: string;
  targetName: string;
  // The agent CLI or Cora, when Codara can tell; display only.
  agent: string | null;
  expiresAt: number;
}

export interface CrossWorkspaceGrant {
  callerWorkspaceId: string;
  callerName: string;
  targetWorkspaceId: string;
  targetName: string;
  grantedAt: string;
}

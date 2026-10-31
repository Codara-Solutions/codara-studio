// An agent asks to open a terminal in, or make a worktree of, a workspace
// other than its own (codara_terminal_create or codara_worktree_create with
// `workspace`). Main asks the user once per caller and target workspace
// pair, and one grant covers both; see src/main/cross-workspace-terminals.ts.

export type CrossWorkspaceAnswer = "once" | "always" | "deny";

export interface CrossWorkspaceApprovalRequest {
  id: string;
  callerName: string;
  targetName: string;
  // The agent CLI or Cora, when Codara can tell; display only.
  agent: string | null;
  // A terminal (absent) or a worktree of the target's repository.
  action?: "terminal" | "worktree";
  expiresAt: number;
}

// Main stopped waiting for a card: it timed out ("expired"), or another
// card's Always answered it ("answered").
export interface CrossWorkspaceApprovalClosed {
  id: string;
  reason: "expired" | "answered";
}

export interface CrossWorkspaceGrant {
  callerWorkspaceId: string;
  callerName: string;
  targetWorkspaceId: string;
  targetName: string;
  grantedAt: string;
}

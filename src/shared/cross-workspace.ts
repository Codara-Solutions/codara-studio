// An agent asks to open a terminal in, or make or remove a worktree of, a
// workspace other than its own (codara_terminal_create,
// codara_worktree_create or codara_worktree_remove with `workspace`). Main asks the user once per caller and target workspace
// pair, and one grant covers both; see src/main/cross-workspace-terminals.ts.

export type CrossWorkspaceAnswer = "once" | "always" | "all" | "deny";

export type CrossWorkspaceAction = "terminal" | "worktree" | "worktree-remove";

export interface CrossWorkspaceApprovalRequest {
  id: string;
  callerName: string;
  targetName: string;
  // The agent CLI or Cora, when Codara can tell; display only.
  agent: string | null;
  // A terminal (absent), a worktree of the target's repository, or the
  // removal of one.
  action?: CrossWorkspaceAction;
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

// Starts the repository's worktree setup for a worktree the user just made
// in the create dialog, and opens the terminals the setup file lists: right
// away, or once setup succeeded when the file asks to wait for it.

import type { Workspace } from "@shared/types";
import {
  isWorktreeSetupFinished,
  isWorktreeSetupStartError,
  type WorktreeSetupStatus,
  type WorktreeSetupTerminal,
} from "@shared/worktree-setup";
import { emitLocalToast } from "../../notifications/local-toast";

export async function startNewWorktreeSetup(input: {
  sourceCwd: string;
  workspace: Workspace;
  runCommands: boolean;
  // The repository command the create dialog showed, approved by creating.
  approveFingerprint?: string | null;
  openTerminal: (terminal: WorktreeSetupTerminal) => void;
}): Promise<WorktreeSetupStatus | null> {
  const { workspace } = input;
  let reply: Awaited<ReturnType<typeof window.spark.worktreeSetup.start>>;
  try {
    reply = await window.spark.worktreeSetup.start({
      sourceCwd: input.sourceCwd,
      worktreePath: workspace.cwd,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ...(workspace.copyBranch?.branch ? { branch: workspace.copyBranch.branch } : {}),
      ...(input.approveFingerprint ? { approveFingerprint: input.approveFingerprint } : {}),
      runCommands: input.runCommands,
    });
  } catch (cause) {
    reply = { error: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!reply) return null;
  if (isWorktreeSetupStartError(reply)) {
    emitLocalToast("Worktree setup could not start", reply.error, "danger", {
      type: "workspace",
      workspaceId: workspace.id,
    });
    return null;
  }
  const started = reply;
  // Terminals are commands too: turning setup commands off leaves them out.
  if (!input.runCommands || started.terminals.length === 0) return started;
  let opened = false;
  const open = (terminals: WorktreeSetupTerminal[]): void => {
    if (opened) return;
    opened = true;
    for (const terminal of terminals) input.openTerminal(terminal);
  };
  // A command waiting for the user's approval holds the terminals too: they
  // come from the same file, and open once the user ran its setup.
  if (!started.waitForSetup && !started.approval) {
    open(started.terminals);
    return started;
  }
  const settle = (status: WorktreeSetupStatus): boolean => {
    if (!isWorktreeSetupFinished(status.state)) return false;
    if (status.state === "succeeded") open(status.terminals);
    return true;
  };
  const off = window.spark.worktreeSetup.onChanged((status) => {
    if (status.id === started.id && settle(status)) off();
  });
  // It may have finished before the listener was in place.
  const now = await window.spark.worktreeSetup.get(started.id).catch(() => null);
  if (now && settle(now)) off();
  return started;
}

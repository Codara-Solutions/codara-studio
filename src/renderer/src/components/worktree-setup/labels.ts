// Plain words for a worktree setup's state, shared by the tray, the log
// dialog and the create dialog.

import type { WorktreeSetupCommand, WorktreeSetupStatus } from "@shared/worktree-setup";

export function setupName(status: Pick<WorktreeSetupStatus, "branch" | "worktreePath">): string {
  if (status.branch) return status.branch;
  const parts = status.worktreePath.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? status.worktreePath;
}

export function setupStateLabel(status: WorktreeSetupStatus): string {
  switch (status.state) {
    case "preparing":
      return "Copying files from the main checkout";
    case "awaiting-approval":
      return "Waiting for your approval to run its setup command";
    case "queued":
      return "Waiting for another setup to finish";
    case "running": {
      const running = status.commands.find((command) => command.state === "running");
      if (!running) return "Running setup";
      return running.kind === "repo" ? "Running the repository's setup command" : "Running your setup command";
    }
    case "succeeded":
      return "Ready";
    case "failed":
      return status.error ?? "Setup failed";
    case "stopped":
      return status.error ?? "Stopped";
  }
}

export function commandStateLabel(
  command: WorktreeSetupCommand,
  status?: Pick<WorktreeSetupStatus, "state">,
): string {
  switch (command.state) {
    case "pending":
      return status?.state === "awaiting-approval" ? "Waiting for your approval" : "Waiting";
    case "running":
      return "Running";
    case "succeeded":
      return "Done";
    case "failed":
      return typeof command.exitCode === "number" ? `Failed, code ${command.exitCode}` : "Failed";
    case "skipped":
      return "Skipped";
    case "stopped":
      return "Stopped";
  }
}

export function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

import type { AutomationOwnBranchState } from "@shared/types";

export function ownBranchNote(own: AutomationOwnBranchState): string {
  return `[Automation] You are in a separate copy of the repository on the branch ${own.branch}. Do your work here. Your changes are committed for you when the run ends, so you do not need to push or open a pull request.`;
}

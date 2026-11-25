// The agent's "Remove worktrees?" dialog (WorktreeCleanupApproval.tsx): the
// order and fold of its rows, what ticking each one does, and the answer it
// sends. Pure, and kept apart from worktree-cleanup-agent.ts so the main
// process does not carry dialog code.

import type {
  WorktreeCleanupApprovalAnswer,
  WorktreeCleanupApprovalItem,
} from "./worktree-cleanup-agent";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the dialog's badge says. A row that can be ticked never says keep. */
export type ApprovalBadge = "safe" | "check";

export const APPROVAL_BADGE_LABELS: Record<ApprovalBadge, string> = {
  safe: "Safe to remove",
  check: "Check first",
};

export function approvalBadge(item: Pick<WorktreeCleanupApprovalItem, "advice">): ApprovalBadge {
  return item.advice === "safe" ? "safe" : "check";
}

export interface ApprovalLayout<T> {
  /** Rows the user may tick: safe ones first, otherwise in the order given. */
  removable: T[];
  /** Rows that cannot be removed now, grouped by cause, the largest group first. */
  blocked: Array<{ label: string; items: T[] }>;
  blockedCount: number;
}

export function approvalLayout<T extends Pick<WorktreeCleanupApprovalItem, "advice" | "blocked" | "blockedGroup">>(
  items: readonly T[],
): ApprovalLayout<T> {
  const removable = items.filter((item) => item.blocked === null);
  const ordered = [...removable.filter((item) => item.advice === "safe"), ...removable.filter((item) => item.advice !== "safe")];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (item.blocked === null) continue;
    const label = item.blockedGroup ?? item.blocked;
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }
  const blocked = [...groups].map(([label, entries]) => ({ label, items: entries }));
  blocked.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  return { removable: ordered, blocked, blockedCount: items.length - removable.length };
}

export interface ApprovalChoice {
  remove: boolean;
  deleteRemoteBranch: boolean;
}

export function approvalKey(item: { repoRoot: string; path: string }): string {
  return `${item.repoRoot}\u0000${item.path}`;
}

/** Nothing starts ticked, remote branches included. */
export function initialApprovalChoices(items: readonly WorktreeCleanupApprovalItem[]): Record<string, ApprovalChoice> {
  return Object.fromEntries(items.map((item) => [approvalKey(item), { remove: false, deleteRemoteBranch: false }]));
}

/** Ticks every row that may go. A blocked row stays unticked; a remote branch stays as it was. */
export function tickAllApprovals(
  items: readonly WorktreeCleanupApprovalItem[],
  choices: Readonly<Record<string, ApprovalChoice>>,
): Record<string, ApprovalChoice> {
  const next: Record<string, ApprovalChoice> = { ...choices };
  for (const item of items) {
    const key = approvalKey(item);
    const current = choices[key] ?? { remove: false, deleteRemoteBranch: false };
    next[key] = item.blocked === null ? { ...current, remove: true } : { remove: false, deleteRemoteBranch: false };
  }
  return next;
}

export function untickAllApprovals(items: readonly WorktreeCleanupApprovalItem[]): Record<string, ApprovalChoice> {
  return initialApprovalChoices(items);
}

/** The answer's items: a blocked row is never sent as remove, nor a remote branch the dialog did not offer. */
export function approvalAnswerItems(
  items: readonly WorktreeCleanupApprovalItem[],
  choices: Readonly<Record<string, ApprovalChoice>>,
  approved: boolean,
): WorktreeCleanupApprovalAnswer["items"] {
  return items.map((item) => {
    const choice = choices[approvalKey(item)];
    const remove = approved && item.blocked === null && Boolean(choice?.remove);
    return {
      repoRoot: item.repoRoot,
      path: item.path,
      remove,
      deleteRemoteBranch: remove && item.remote.offered && Boolean(choice?.deleteRemoteBranch),
    };
  });
}

/**
 * One line in plain words: what ticking the row removes and what stays, in
 * three parts: the folder (or git's record of it when the folder is already
 * gone), the local branch, the remote branch. Each part follows what the
 * removal will do with the dialog's choices (the merged-branches toggle and
 * this row's own remote tick), and the remote is named as the checkbox that
 * deletes it names it, so the line never says something stays that goes.
 */
export function tickEffect(item: WorktreeCleanupApprovalItem, deleteMergedBranches: boolean, deleteRemoteBranch = false): string {
  const commits = item.unmergedCommits;
  const merged = item.merged && commits === 0;
  const localGoes = Boolean(item.branch) && merged && deleteMergedBranches && item.branchDeletable;
  const parts: string[] = [];
  if (item.missing) {
    parts.push(
      !item.branch || !merged
        ? "The folder is already gone; git's record of it goes."
        : localGoes
          ? "Merged. The folder is already gone; git's record of it and the local branch go."
          : "Merged. The folder is already gone; git's record of it goes, the local branch stays.",
    );
  } else if (item.branch && merged) {
    parts.push(localGoes ? "Merged: folder and local branch go." : "Merged: folder goes, the local branch stays.");
  } else {
    parts.push("Folder goes.");
  }
  if (!item.branch) {
    if (commits > 0) parts.push(`Its ${plural(commits, "commit")} ${commits === 1 ? "stays" : "stay"} recoverable for 30 days.`);
    return parts.join(" ");
  }
  const remote = item.remote.name ?? "the remote";
  const remoteGoes = item.remote.offered && deleteRemoteBranch;
  const onRemote = item.onRemote === true || item.remote.offered;
  const pr = item.pullRequest && (item.pullRequest.state === "open" || item.pullRequest.state === "draft") ? item.pullRequest : null;
  if (merged) {
    if (onRemote) {
      parts.push(
        remoteGoes
          ? `The branch on ${remote} goes too.`
          : item.remote.offered
            ? `The branch on ${remote} stays unless you tick it below.`
            : `The branch on ${remote} stays.`,
      );
    }
    return parts.join(" ");
  }
  const kept = commits > 0 ? `, with its ${plural(commits, "commit")} that ${commits === 1 ? "is" : "are"} not merged` : "";
  if (remoteGoes) parts.push(`The local branch stays${kept}; the branch on ${remote} goes.`);
  else if (onRemote) {
    parts.push(`The branch stays, here and on ${remote}${pr ? `, with pull request #${pr.number}` : ""}.`);
    if (item.remote.offered) parts.push("Tick below to delete it there.");
  } else if (item.onRemote === false) parts.push(`The branch stays on this computer only${kept}.`);
  else parts.push(`The branch stays${kept}.`);
  return parts.join(" ");
}

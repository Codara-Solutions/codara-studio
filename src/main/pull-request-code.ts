import type { Workspace } from "@shared/types";

// Which checkouts hold an imported pull request's code. Kept free of imports
// so the worktree and trust modules can share it without pulling each other.

/** A branch or ref that holds an imported pull request's code. */
export function isPullRequestRef(name: string | null | undefined): boolean {
  const ref = name?.trim();
  if (!ref) return false;
  if (ref.startsWith("refs/codara/pr-import/")) return true;
  const short = ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .replace(/^origin\//, "");
  return short.startsWith("codara/pr/");
}

/** A workspace whose checkout is pull-request code: imported, or a worktree made from one. */
export function holdsPullRequestCode(workspace: Pick<Workspace, "copyBranch">): boolean {
  const copy = workspace.copyBranch;
  if (!copy) return false;
  return (
    copy.origin?.kind === "github-pull-request" ||
    copy.pullRequestCode === true ||
    isPullRequestRef(copy.branch) ||
    isPullRequestRef(copy.baseBranch)
  );
}

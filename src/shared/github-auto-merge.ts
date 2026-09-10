import { validGitHubReviewTarget, type GitHubReviewTarget } from "./github-review";

export type GitHubAutoMergeStrategy = "squash" | "merge" | "rebase";
export interface GitHubAutoMergeStatus {
  revision: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headCommitOid: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  allowed: boolean;
  canEnable: boolean;
  canDisable: boolean;
  mergeQueue: boolean;
  queued: boolean;
  strategies: GitHubAutoMergeStrategy[];
  request: { strategy: GitHubAutoMergeStrategy; enabledAt: string | null; enabledBy: string | null } | null;
}

export interface GitHubAutoMergeInput {
  target: GitHubReviewTarget;
  expectedRevision: string;
  action: "enable" | "disable";
  strategy: GitHubAutoMergeStrategy;
}

export type GitHubAutoMergeResult =
  | { kind: "confirmed"; outcome: "enabled" | "disabled" | "merged" | "queued"; status: GitHubAutoMergeStatus }
  | { kind: "failed" | "unknown"; message: string };

export function validGitHubAutoMergeInput(value: unknown): value is GitHubAutoMergeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as GitHubAutoMergeInput;
  return validGitHubReviewTarget(input.target) && typeof input.expectedRevision === "string" && /^[a-f0-9]{64}$/.test(input.expectedRevision) &&
    (input.action === "enable" || input.action === "disable") && ["squash", "merge", "rebase"].includes(input.strategy);
}

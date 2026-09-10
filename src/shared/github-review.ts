export interface GitHubReviewTarget {
  repositoryUrl: string;
  pullRequestNumber: number;
  expectedHeadCommitOid: string;
  expectedBaseCommitOid?: string;
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export interface GitHubReviewInput extends GitHubReviewTarget {
  expectedBaseCommitOid: string;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  body: string;
  comments: GitHubReviewComment[];
}

export interface GitHubReviewFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
  incomplete: boolean;
}

export interface GitHubReviewPage {
  headCommitOid: string;
  baseCommitOid: string;
  files: GitHubReviewFile[];
  nextPage?: number;
  fileLimitReached?: boolean;
}

export interface GitHubReviewDiscussionComment {
  id: string;
  author: string;
  body: string;
  truncated: boolean;
  createdAt: string;
  url: string;
}

export interface GitHubReviewDiscussion {
  id: string;
  path: string;
  line: number | null;
  side: "LEFT" | "RIGHT";
  resolved: boolean;
  outdated: boolean;
  comments: GitHubReviewDiscussionComment[];
  nextCursor?: string;
}

export interface GitHubReviewDiscussionRequest {
  target: GitHubReviewTarget;
  cursor?: string;
  threadId?: string;
}

export interface GitHubReviewDiscussionPage {
  headCommitOid: string;
  baseCommitOid: string;
  threads: GitHubReviewDiscussion[];
  nextCursor?: string;
}

export function validGitHubReviewDiscussionRequest(value: unknown): value is GitHubReviewDiscussionRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as GitHubReviewDiscussionRequest;
  return validGitHubReviewTarget(input.target) && [input.cursor, input.threadId].every((part) =>
    part === undefined || typeof part === "string" && part.length > 0 && part.length <= 1024 && !/[\u0000-\u0020]/.test(part));
}

export type GitHubReviewResult =
  | { kind: "submitted"; url: string; headCommitOid: string }
  | { kind: "failed" | "unknown"; message: string };

export function validGitHubReviewTarget(value: unknown): value is GitHubReviewTarget {
  if (!value || typeof value !== "object") return false;
  const p = value as GitHubReviewTarget;
  if (typeof p.repositoryUrl !== "string" || p.repositoryUrl.length > 4096 ||
      !Number.isSafeInteger(p.pullRequestNumber) || p.pullRequestNumber < 1 ||
      typeof p.expectedHeadCommitOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(p.expectedHeadCommitOid)) return false;
  if (p.expectedBaseCommitOid !== undefined && (typeof p.expectedBaseCommitOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(p.expectedBaseCommitOid))) return false;
  try {
    const url = new URL(p.repositoryUrl);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash &&
      /^\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(url.pathname) && !url.pathname.split("/").some((part) => part === "." || part === "..");
  } catch { return false; }
}

export function validGitHubReviewInput(value: unknown): value is GitHubReviewInput {
  if (!validGitHubReviewTarget(value)) return false;
  const p = value as GitHubReviewInput;
  if (!p.expectedBaseCommitOid) return false;
  if (!["COMMENT", "APPROVE", "REQUEST_CHANGES"].includes(p.event) || typeof p.body !== "string" || p.body.length > 20000 ||
      (p.event !== "APPROVE" && !p.body.trim()) || !Array.isArray(p.comments) || p.comments.length > 30) return false;
  return p.comments.every((comment) => comment && typeof comment === "object" && typeof comment.path === "string" &&
    comment.path.length > 0 && comment.path.length <= 4096 && !/[\u0000-\u001f]/.test(comment.path) &&
    Number.isSafeInteger(comment.line) && comment.line > 0 && (comment.side === "LEFT" || comment.side === "RIGHT") &&
    typeof comment.body === "string" && comment.body.trim().length > 0 && comment.body.length <= 4000);
}

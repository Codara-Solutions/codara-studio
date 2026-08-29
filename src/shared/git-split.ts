// Shared contract for "Split into commits": the AI proposes grouping the
// working tree's changes into a few coherent commits; the user reviews the
// plan; the main process executes it file-by-file.
//
// The safety property the whole feature is built around:
//   a split can produce FEWER or UGLIER commits than ideal, but it can never
//   lose, duplicate, or half-commit a change.
// Everything here is pure so the validator can be exercised directly by
// scripts/test-git-split-commits.cjs with adversarial model output.

/** One proposed commit: a message plus the files that belong in it. */
export interface GitSplitGroup {
  /** Full commit message (subject line, optionally blank line + body). */
  message: string;
  /** Repo-relative forward-slash paths, as reported by git status. */
  files: string[];
  /** One plain-language sentence for the review dialog ("why these belong together"). */
  reason?: string;
}

export interface GitSplitPlan {
  ok: true;
  groups: GitSplitGroup[];
  /** "ai" when the model produced the grouping, "fallback" for the single-commit degradation. */
  source: "ai" | "fallback";
}

export interface GitSplitPlanError {
  ok: false;
  error: string;
}

export type GitSplitPlanResult = GitSplitPlan | GitSplitPlanError;

/** Result of executing a reviewed plan. Partial success is reported honestly. */
export interface GitSplitExecuteResult {
  ok: boolean;
  /** Commits that actually landed, in order. */
  committed: Array<{ hash: string; message: string; files: string[] }>;
  /** Set when ok is false: what stopped the run. Files never committed stay in the working tree. */
  error?: string;
}

export const GIT_SPLIT_MAX_GROUPS = 12;
export const GIT_SPLIT_MAX_MESSAGE_LENGTH = 4_000;

/**
 * Normalize and validate a proposed grouping against the real set of changed
 * paths. Tolerant by design — model output is untrusted:
 *  - unknown paths are dropped (the model hallucinated them);
 *  - a path claimed by several groups stays only in the FIRST (no duplicate commits);
 *  - empty groups (after cleaning) are removed;
 *  - changed paths the plan never mentions are returned in `leftover` so the
 *    caller can append a final catch-all group — a file must never be dropped.
 * Returns null only when nothing salvageable remains.
 */
export function normalizeSplitGroups(
  raw: unknown,
  changedPaths: readonly string[],
): { groups: GitSplitGroup[]; leftover: string[] } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const changed = new Set(changedPaths);
  const claimed = new Set<string>();
  const groups: GitSplitGroup[] = [];

  for (const entry of raw.slice(0, GIT_SPLIT_MAX_GROUPS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const g = entry as { message?: unknown; files?: unknown; reason?: unknown };
    const message = typeof g.message === "string" ? g.message.trim().slice(0, GIT_SPLIT_MAX_MESSAGE_LENGTH) : "";
    if (!message || !Array.isArray(g.files)) continue;
    const files: string[] = [];
    for (const f of g.files) {
      if (typeof f !== "string") continue;
      const path = f.trim();
      if (!path || !changed.has(path) || claimed.has(path)) continue;
      claimed.add(path);
      files.push(path);
    }
    if (files.length === 0) continue;
    groups.push({
      message,
      files,
      reason: typeof g.reason === "string" && g.reason.trim() ? g.reason.trim().slice(0, 300) : undefined,
    });
  }

  if (groups.length === 0) return null;
  const leftover = changedPaths.filter((p) => !claimed.has(p));
  return { groups, leftover };
}

/**
 * Final invariant check before anything touches git: every changed path in
 * exactly one group, no path that isn't changed, no empty group, no empty
 * message. Execution refuses plans that fail this — belt after the
 * normalizer's braces, because the renderer can edit plans too.
 */
export function splitPlanViolation(
  groups: readonly GitSplitGroup[],
  changedPaths: readonly string[],
): string | null {
  if (groups.length === 0) return "The plan has no commits.";
  if (groups.length > GIT_SPLIT_MAX_GROUPS) return "The plan has too many commits.";
  const changed = new Set(changedPaths);
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g.message?.trim()) return "A commit in the plan has no message.";
    if (!g.files?.length) return "A commit in the plan has no files.";
    for (const path of g.files) {
      if (!changed.has(path)) return `The plan references a file that has no changes: ${path}`;
      if (seen.has(path)) return `The plan lists the same file twice: ${path}`;
      seen.add(path);
    }
  }
  for (const path of changedPaths) {
    if (!seen.has(path)) return `The plan misses a changed file: ${path}`;
  }
  return null;
}

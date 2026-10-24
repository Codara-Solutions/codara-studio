// What the pull request watcher (src/main/github-ci-watch.ts) knows about
// each workspace's branch, for the rail row and the agent working there. No
// Electron, DOM or fs imports: unit suites bundle this file on its own.

export type PullRequestWatchPhase = "open" | "draft" | "merged" | "closed";

/** none: no checks reported yet. */
export type PullRequestChecks = "none" | "pending" | "passing" | "failing";

export interface PullRequestWatchState {
  workspaceId: string;
  /** owner/name, lowercase. */
  repository: string;
  number: number;
  url: string;
  title: string;
  phase: PullRequestWatchPhase;
  checks: PullRequestChecks;
  /** Names of the failing checks, cleaned for display. */
  failed: string[];
  headOid: string;
}

/** A workspace's watch: its pull request, or that its repository is switched off. */
export type PullRequestWatchEntry =
  | { workspaceId: string; repository: string; watching: true; pullRequest: PullRequestWatchState }
  | { workspaceId: string; repository: string; watching: false };

export interface PullRequestWatchChange {
  workspaceId: string;
  entry: PullRequestWatchEntry | null;
}

export const PULL_REQUEST_WATCH_CHANGED_CHANNEL = "pullRequestWatch:changed";

/** "acme/widgets", lowercase; null for anything that is not owner/name. */
export function normalizeRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

// A check's name is chosen by whoever writes the workflow, and it is typed
// into an agent as if the user said it. Only the characters a job or suite
// name needs survive, so a name cannot carry a line break, an escape
// sequence or a paste marker into the agent's prompt.
export function cleanCheckName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ._:/()+#@-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** The one line typed into an agent whose branch's checks failed. */
export function agentCiFailureLine(number: number, failed: readonly string[]): string {
  const names = failed.map(cleanCheckName).filter(Boolean);
  const shown = names.slice(0, 4).join(", ");
  const more = names.length > 4 ? ` and ${names.length - 4} more` : "";
  const what = shown ? `${shown}${more}` : "a check";
  return `CI failed on PR #${number}: ${what}. Fix it with the fix-ci skill, push, and watch the checks.`;
}

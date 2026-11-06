import { isAncestor } from "./git-worktrees";

// Merge proof through merged pull requests whose head moved past the
// worktree's tip, and through stacked pull requests: one merged into another
// pull request's branch, which was itself merged. Shared by the agent tools
// (agent-worktrees.ts) and the cleanup screen and rail (worktree-cleanup/).
//
// A tip counts as merged when:
// - it is a merged pull request's head, or an ancestor of it (the branch got
//   more commits after this worktree's last one, all merged), and
// - that pull request landed: its base is the default branch (or the target
//   the caller named), or its merge commit is in the default branch, or in
//   its base branch as the remote has it now, or in the head of a merged pull
//   request of its base branch that itself landed, following the stack up.
//
// It fails closed. A commit git does not have locally is no proof, a pull
// request merged into a branch that later lost that merge (force-pushed) or
// whose own pull request did not take it (merged before it, or never) is no
// proof, and a fork's pull request never counts.

export interface StackPullRequest {
  number: number;
  url: string;
  headRefName: string;
  headRefOid: string;
  baseRefName?: string;
  isCrossRepository: boolean;
  /** The commit the merge made on the base branch (merge, squash or last rebased commit). */
  mergeCommitOid?: string | null;
}

export interface StackProofInput {
  repo: string;
  tip: string;
  branch: string;
  /** Merged pull requests whose head branch is `head`. May reject; a lookup that fails proves nothing. */
  mergedFor(head: string): Promise<readonly StackPullRequest[]>;
  /** Short branch names a merge into which counts as landed: the default branch, or the target the caller named. */
  landedBases: ReadonlySet<string>;
  /** The default branch's commit, so a merge commit found in it counts as landed. */
  defaultCommit: string | null;
  /** A branch's commit on the remote now; null when it is gone or unknown. */
  remoteCommit?(branch: string): Promise<string | null>;
}

export interface StackProof {
  pullRequest: { number: number; url: string };
  /** The pull requests that carried it on, nearest first; empty when it was merged into a landed base. */
  via: number[];
  /**
   * Where it landed: "default" (a landed base, or a merge commit found in the
   * default branch) or "remote-base" (the named base, as the remote has it,
   * holds the merge).
   */
  landedIn: { kind: "default" } | { kind: "remote-base"; branch: string; commit: string };
}

/** How many pull requests up a stack is followed. */
export const MAX_STACK_DEPTH = 5;

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function sameRepo(pr: StackPullRequest, head: string): boolean {
  return pr.headRefName === head && !pr.isCrossRepository && OID.test(pr.headRefOid);
}

export async function proveByMergedPullRequestStack(input: StackProofInput): Promise<StackProof | null> {
  const tip = input.tip.toLowerCase();
  const lookups = new Map<string, Promise<readonly StackPullRequest[]>>();
  const mergedFor = (head: string): Promise<readonly StackPullRequest[]> => {
    let pending = lookups.get(head);
    if (!pending) {
      pending = input.mergedFor(head).then(
        (list) => list.filter((pr) => sameRepo(pr, head)),
        () => [] as StackPullRequest[],
      );
      lookups.set(head, pending);
    }
    return pending;
  };
  const contains = async (ancestor: string, descendant: string): Promise<boolean> =>
    ancestor.toLowerCase() === descendant.toLowerCase() || (await isAncestor(input.repo, ancestor, descendant));

  type Landed = { via: number[]; landedIn: StackProof["landedIn"] };
  const landed = async (pr: StackPullRequest, depth: number, seen: Set<number>): Promise<Landed | null> => {
    const base = pr.baseRefName;
    if (!base) return null;
    if (input.landedBases.has(base)) return { via: [], landedIn: { kind: "default" } };
    const merged = pr.mergeCommitOid && OID.test(pr.mergeCommitOid) ? pr.mergeCommitOid : null;
    if (!merged) return null;
    if (input.defaultCommit && (await contains(merged, input.defaultCommit))) return { via: [], landedIn: { kind: "default" } };
    // A base still on the remote that holds the merge.
    const live = await (input.remoteCommit?.(base) ?? Promise.resolve(null)).catch(() => null);
    if (live && OID.test(live) && (await contains(merged, live))) {
      return { via: [], landedIn: { kind: "remote-base", branch: base, commit: live.toLowerCase() } };
    }
    if (depth >= MAX_STACK_DEPTH || base === input.branch) return null;
    for (const parent of await mergedFor(base)) {
      if (seen.has(parent.number)) continue;
      // The parent's merge took this merge with it only when its head holds it.
      if (!(await contains(merged, parent.headRefOid))) continue;
      const rest = await landed(parent, depth + 1, new Set([...seen, parent.number]));
      if (rest) return { via: [parent.number, ...rest.via], landedIn: rest.landedIn };
    }
    return null;
  };

  for (const pr of await mergedFor(input.branch)) {
    if (!(await contains(tip, pr.headRefOid))) continue;
    const found = await landed(pr, 0, new Set([pr.number]));
    if (found) return { pullRequest: { number: pr.number, url: pr.url }, ...found };
  }
  return null;
}

import { useEffect, useState } from "react";
import { mergeNeedsConfirmation, pullRequestRef, settleAgent, type AgentInboxRow } from "@shared/agent-inbox";
import type { GitHubPullRequestSummary } from "@shared/github";
import type { PullRequestWatchState } from "@shared/pull-request-watch";
import { isRemotePath } from "@shared/remote";
import { emitLocalToast } from "../../notifications/local-toast";
import { unwrapIpcError } from "../../lib/ipc-error";
import { getAgentBoardSources } from "./agentBoardSources";
import { updateAgentInbox } from "./agentInboxStore";

// What the Agents tab's menu does beyond its own prefs: merge a pull request
// with the same guarded path the Git panel uses, copy its link, and delete a
// Cora chat or close an agent's terminal.

export interface MergeConfirmRequest {
  key: string;
  cwd: string;
  repository: string;
  pullRequest: GitHubPullRequestSummary;
}

function workspaceCwd(workspaceId: string): string | null {
  return getAgentBoardSources().workspaces.find((workspace) => workspace.id === workspaceId)?.cwd ?? null;
}

/** Settles a row after its pull request merged, with the footer's undo. */
export function settleMerged(key: string, number: number): void {
  updateAgentInbox((current) => settleAgent(current, key, Date.now()), { keys: [key], text: `Settled, #${number} merged` });
}

/**
 * Merges the row's pull request. GitHub is read again first; a pull request
 * into the repository's main line goes through the Git panel's confirmation
 * (`confirm`), any other base merges here with a squash, which main checks
 * again against the exact head commit before it writes anything.
 */
export async function mergeFromInbox(
  row: AgentInboxRow,
  confirm: (request: MergeConfirmRequest) => void,
): Promise<void> {
  const watched = row.pullRequest;
  const cwd = workspaceCwd(row.card.workspaceId);
  if (!watched || !cwd) return;
  if (isRemotePath(cwd)) {
    emitLocalToast("Merge it from its workspace", "Pull requests of SSH workspaces merge from the Git panel.", "warning");
    return;
  }
  try {
    const status = await window.spark.github.status(cwd, { refresh: true });
    if (status.kind !== "ready") {
      emitLocalToast("Could not reach GitHub", status.message, "danger");
      return;
    }
    const pullRequest = status.pullRequest;
    if (!pullRequest || pullRequest.number !== watched.number || pullRequest.state !== "OPEN") {
      emitLocalToast(
        `#${watched.number} changed`,
        "Its branch no longer points at this open pull request. Nothing was merged.",
        "warning",
      );
      return;
    }
    if (!pullRequest.headCommitOid) {
      emitLocalToast("Could not merge", "GitHub did not report the pull request's head commit.", "danger");
      return;
    }
    const repository = status.repository.nameWithOwner;
    if (mergeNeedsConfirmation(pullRequest.baseBranch, status.repository.defaultBranch)) {
      confirm({ key: row.key, cwd, repository, pullRequest });
      return;
    }
    const result = await window.spark.github.merge(cwd, {
      repository,
      pullRequestNumber: pullRequest.number,
      baseBranch: pullRequest.baseBranch,
      headBranch: pullRequest.headBranch,
      expectedHeadCommitOid: pullRequest.headCommitOid,
      strategy: "squash",
    });
    if (!result.ok) {
      emitLocalToast(`Could not merge #${pullRequest.number}`, result.message, "danger");
      return;
    }
    emitLocalToast(`Merged #${pullRequest.number}`, `Squashed into ${pullRequest.baseBranch}.`);
    settleMerged(row.key, pullRequest.number);
  } catch (cause) {
    emitLocalToast(`Could not merge #${watched.number}`, unwrapIpcError(cause), "danger");
  }
}

export function copyPullRequestLink(pr: PullRequestWatchState): void {
  void Promise.resolve(window.spark.clipboard.writeText(pr.url))
    .then(() => emitLocalToast("Link copied", `#${pr.number}`))
    .catch(() => emitLocalToast("Could not copy the link", "", "danger"));
}

/** Deletes a Cora chat, or closes a terminal agent's pane (the agent stops). */
export async function deleteFromInbox(row: AgentInboxRow): Promise<void> {
  const target = row.card.target;
  try {
    if (target.type === "terminal") {
      const close = getAgentBoardSources().closePane;
      if (!close || !target.tabId || !target.paneId) return;
      close(target.workspaceId, target.tabId, target.paneId);
      return;
    }
    if (target.type === "run") {
      await window.spark.orchestration.deleteRun(target.runId);
    }
  } catch (cause) {
    emitLocalToast("Could not delete it", unwrapIpcError(cause), "danger");
  }
}

// ---------------------------------------------------------------------------
// +/- line counts for a finished agent's pull request
// ---------------------------------------------------------------------------

type Diff = { additions: number; deletions: number } | null;
const diffs = new Map<string, Diff | Promise<Diff>>();

function loadDiff(cwd: string, pr: PullRequestWatchState): Promise<Diff> | Diff {
  const key = `${pullRequestRef(pr)}@${pr.headOid}`;
  const known = diffs.get(key);
  if (known !== undefined) return known;
  const pending = window.spark.github
    .pullRequestDetails(cwd, pr.number)
    .then((details) => ({ additions: details.additions, deletions: details.deletions }))
    .catch(() => null)
    .then((value) => {
      diffs.set(key, value);
      return value;
    });
  diffs.set(key, pending);
  return pending;
}

/** The pull request's +/- counts, read once per head commit; null until known. */
export function usePullRequestDiff(workspaceId: string, pr: PullRequestWatchState | null, wanted: boolean): Diff {
  const [diff, setDiff] = useState<Diff>(null);
  const ref = pr ? `${pullRequestRef(pr)}@${pr.headOid}` : null;
  useEffect(() => {
    setDiff(null);
    if (!wanted || !pr) return undefined;
    const cwd = workspaceCwd(workspaceId);
    if (!cwd || isRemotePath(cwd)) return undefined;
    const value = loadDiff(cwd, pr);
    if (!(value instanceof Promise)) {
      setDiff(value);
      return undefined;
    }
    let alive = true;
    void value.then((loaded) => {
      if (alive) setDiff(loaded);
    });
    return () => {
      alive = false;
    };
    // Keyed on `ref`, not `pr`: the watcher rebuilds the object on every
    // update, and only a new head commit can change the counts.
  }, [ref, wanted, workspaceId]);
  return diff;
}

import { randomUUID } from "node:crypto";
import type { GitHubCheckSummary, GitHubWorkQueueStatus } from "@shared/github";
import type { RemotePhoneNotification } from "./rpc";

export const GITHUB_CHECK_POLL_MS = 120_000;
const MAX_TRACKED_PULL_REQUESTS = 240;
const MAX_BACKOFF_MS = 15 * 60_000;
type CheckOutcome = "pending" | "passed" | "failed";

function checkOutcome(checks: GitHubCheckSummary): CheckOutcome | null {
  const counts = [checks.total, checks.successful, checks.failed, checks.pending];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      checks.total !== checks.successful + checks.failed + checks.pending) return null;
  if (checks.failed > 0) return "failed";
  if (checks.pending > 0 || checks.total === 0) return "pending";
  return "passed";
}

/** Baselines each PR before alerting; incomplete queue reads never erase a known head. */
export class GitHubCheckNotifications {
  private readonly observed = new Map<string, { head: string; outcome: CheckOutcome }>();
  private lastSnapshotAt = 0;

  reset(): void {
    this.observed.clear();
    this.lastSnapshotAt = 0;
  }

  update(snapshot: GitHubWorkQueueStatus, now = Date.now()): RemotePhoneNotification[] {
    if (snapshot.kind !== "ready") return [];
    const snapshotAt = Date.parse(snapshot.refreshedAt);
    if (!Number.isFinite(snapshotAt) || snapshotAt <= this.lastSnapshotAt) return [];
    this.lastSnapshotAt = snapshotAt;
    const notifications: RemotePhoneNotification[] = [];
    for (const item of snapshot.items) {
      if (item.kind !== "pull-request") continue;
      const pr = item.pullRequest;
      if (pr.state !== "OPEN" || !pr.headCommitOid || !/^[a-f0-9]{40}$/i.test(pr.headCommitOid)) continue;
      const outcome = checkOutcome(pr.checks);
      if (!outcome) continue;
      const key = JSON.stringify([item.repositoryUrl.toLowerCase().replace(/\/$/, ""), pr.number]);
      const previous = this.observed.get(key);
      const head = pr.headCommitOid.toLowerCase();
      this.observed.delete(key);
      this.observed.set(key, { head, outcome });
      if (!previous || outcome === "pending" || (previous.head === head && previous.outcome === outcome)) continue;
      notifications.push({
        id: `github-check:${randomUUID()}`,
        kind: "github",
        title: `PR #${pr.number}: checks ${outcome}`,
        body: `${item.repository}: ${pr.title}. ${outcome === "failed"
          ? `${pr.checks.failed} of ${pr.checks.total} checks failed${pr.checks.pending > 0 ? `; ${pr.checks.pending} still pending` : ""}`
          : `${pr.checks.successful} checks completed successfully`}.`,
        workspaceId: item.sourceWorkspaceId,
        sourceView: "queue",
        createdAt: new Date(now).toISOString(),
      });
    }
    while (this.observed.size > MAX_TRACKED_PULL_REQUESTS) {
      this.observed.delete(this.observed.keys().next().value!);
    }
    return notifications;
  }
}

export interface GitHubCheckWatchDependencies {
  enabled(): Promise<boolean>;
  read(): Promise<GitHubWorkQueueStatus>;
  muted(): boolean;
  deliver(notification: RemotePhoneNotification): Promise<void>;
  schedule(callback: () => void, delay: number): () => void;
  log(message: string): void;
}

/** Shares the queue cache and runs only while a paired phone requests GitHub activity. */
export function startGitHubCheckNotifications(deps: GitHubCheckWatchDependencies): () => void {
  const tracker = new GitHubCheckNotifications();
  let stopped = false;
  let cancel: (() => void) | null = null;
  let delay = GITHUB_CHECK_POLL_MS;
  const tick = async (): Promise<void> => {
    cancel = null;
    try {
      if (!await deps.enabled()) {
        tracker.reset();
        delay = GITHUB_CHECK_POLL_MS;
        return;
      }
      if (stopped) return;
      const snapshot = await deps.read();
      if (stopped) return;
      if (!await deps.enabled()) { tracker.reset(); return; }
      if (snapshot.kind !== "ready") {
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        return;
      }
      delay = GITHUB_CHECK_POLL_MS;
      const notifications = tracker.update(snapshot);
      for (const notification of notifications) {
        if (stopped) return;
        // Advance the baseline even when DND suppresses delivery, avoiding a replay later.
        if (!deps.muted()) await deps.deliver(notification);
      }
    } catch (error) {
      delay = Math.min(delay * 2, MAX_BACKOFF_MS);
      deps.log(`GitHub check notifications: ${(error as Error).message}`);
    } finally {
      if (!stopped) cancel = deps.schedule(() => { void tick(); }, delay);
    }
  };
  cancel = deps.schedule(() => { void tick(); }, 20_000);
  return () => { stopped = true; cancel?.(); tracker.reset(); };
}

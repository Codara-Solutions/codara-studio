import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  type GitHubCheckSummary,
  type GitHubMarkReadyResult,
  type GitHubMergeResult,
  type GitHubMergeStrategy,
  type GitHubPullRequestSummary,
  type GitHubPublishResult,
  type GitHubWorkQueueItem,
  type GitHubWorkspaceStatus,
} from "@shared/github";
import type { GitStatus } from "@shared/types";
import { ChevronIcon } from "../icons";
import GitHubWorkQueue from "./GitHubWorkQueue";
import { RefreshIcon, Spinner } from "./git-ui";

interface Props {
  cwd: string;
  gitStatus: GitStatus;
  /** Bumped by local git activity — re-reads GitHub silently (no spinner). */
  refreshKey: number;
  /** Bumped by the user (refresh button, publish, merge) — re-reads loudly. */
  userRefreshKey: number;
  /** Present for local workspaces: the repository-wide issue/PR list. */
  queue: {
    sourceWorkspaceId: string;
    refreshKey: number;
    onOpenItem: (item: GitHubWorkQueueItem) => Promise<void>;
  } | null;
  /** The block's one refresh affordance — re-reads status and queue. */
  onRefresh: () => void;
  onPublished: () => void;
}

interface Snapshot {
  cwd: string;
  status: GitHubWorkspaceStatus;
}

// GitHub is read through the `gh` CLI, so the block never polls hard. Focus,
// local git activity and the user's own actions carry the refresh; this slow
// fallback only covers a window left open and untouched.
const STATUS_FALLBACK_REFRESH_MS = 300_000;

// Focus fires on every alt-tab back, and each read is a `gh` subprocess tree.
// A read this recent is still good enough to skip the next one.
const RESUME_REFRESH_MIN_INTERVAL_MS = 60_000;

export default function GitHubSection({
  cwd,
  gitStatus,
  refreshKey,
  userRefreshKey,
  queue,
  onRefresh,
  onPublished,
}: Props): React.ReactElement {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [headerHover, setHeaderHover] = useState(false);
  const [refreshHover, setRefreshHover] = useState(false);
  // Background/initial reads are intentionally invisible in the header. Only
  // an explicit click earns a progress label; otherwise a slow `gh` command
  // looked like the section was stuck in a permanent refresh loop.
  const [manualRefresh, setManualRefresh] = useState(false);
  const [queueSummary, setQueueSummary] = useState<{
    loading: boolean;
    total: number | null;
  }>({ loading: false, total: null });
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishResult, setPublishResult] = useState<GitHubPublishResult | null>(null);
  const [markReadyResult, setMarkReadyResult] = useState<GitHubMarkReadyResult | null>(null);
  const [markingReady, setMarkingReady] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeResult, setMergeResult] = useState<GitHubMergeResult | null>(null);
  const requestId = useRef(0);
  const markReadyRequestId = useRef(0);
  // When the status was last read successfully — the focus throttle's clock.
  const lastReadAt = useRef(0);
  const { branch: currentBranch } = gitStatus;

  const handleQueueSummary = useCallback(
    (summary: { loading: boolean; total: number | null }): void => {
      setQueueSummary(summary);
    },
    [],
  );

  // A new workspace context starts the block fresh.
  useEffect(() => {
    setCollapsed(false);
    setHelpOpen(false);
    setQueueSummary({ loading: false, total: null });
  }, [cwd]);

  useEffect(() => {
    // A mark-ready response belongs to the exact workspace/branch that issued
    // it. Invalidate an in-flight response when the Source Control context
    // changes so it cannot update a newly selected worktree.
    markReadyRequestId.current += 1;
    setMarkingReady(false);
    setMarkReadyResult(null);
  }, [cwd, currentBranch, refreshKey, userRefreshKey]);

  // One read of the workspace's GitHub status. A silent read never raises the
  // spinner and never downgrades a good snapshot to an error — the user has
  // not asked for anything, so a background failure stays invisible.
  const loadStatus = useCallback(
    (silent: boolean): void => {
      const id = ++requestId.current;
      if (!silent) setLoading(true);
      void window.spark.github
        .status(cwd)
        .then((status) => {
          if (requestId.current !== id) return;
          lastReadAt.current = Date.now();
          setSnapshot({ cwd, status });
        })
        .catch(() => {
          if (requestId.current !== id) return;
          setSnapshot((current) => {
            if (silent && current?.cwd === cwd) return current;
            return {
              cwd,
              status: {
                kind: "error",
                message: "GitHub status could not be loaded. Try refreshing Source Control.",
              },
            };
          });
        })
        .finally(() => {
          if (requestId.current === id) setLoading(false);
        });
    },
    [cwd],
  );

  // A new workspace or branch has no snapshot yet, so that read is loud.
  useEffect(() => {
    loadStatus(false);
    return () => {
      requestId.current += 1;
    };
  }, [loadStatus, currentBranch]);

  // Both keys are watched together: the panel's own refresh bumps the user key
  // and the git version at once, and this must be one read, not two. A read the
  // user asked for (refresh button, publish, merge) is loud; one that only
  // follows local git activity — a commit, a push, a branch switch — is silent.
  const lastKeys = useRef({ refreshKey, userRefreshKey });
  useEffect(() => {
    const previous = lastKeys.current;
    if (previous.refreshKey === refreshKey && previous.userRefreshKey === userRefreshKey) {
      return;
    }
    const loud = previous.userRefreshKey !== userRefreshKey;
    lastKeys.current = { refreshKey, userRefreshKey };
    loadStatus(!loud);
  }, [loadStatus, refreshKey, userRefreshKey]);

  // Coming back to the window is the strongest signal that GitHub may have
  // moved on without us; the slow interval only covers a window left open.
  // Both stay quiet, and neither runs while the block is collapsed.
  useEffect(() => {
    if (collapsed) return;
    const silentRefresh = (): void => {
      if (document.visibilityState !== "visible") return;
      loadStatus(true);
    };
    // Focus and visibility usually fire together on one alt-tab, and every
    // read spawns a `gh` subprocess tree — so they share a clock, and a
    // status read this recent is left alone.
    const resume = (): void => {
      if (Date.now() - lastReadAt.current < RESUME_REFRESH_MIN_INTERVAL_MS) return;
      silentRefresh();
    };
    const timer = window.setInterval(silentRefresh, STATUS_FALLBACK_REFRESH_MS);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [collapsed, loadStatus]);

  const status = snapshot?.cwd === cwd ? snapshot.status : null;

  const markReady = async (): Promise<void> => {
    const readyStatus = status?.kind === "ready" ? status : null;
    const pullRequest = readyStatus?.pullRequest;
    if (
      markingReady ||
      !readyStatus ||
      !pullRequest ||
      !pullRequest.isDraft ||
      pullRequest.state !== "OPEN" ||
      !pullRequest.headCommitOid
    ) {
      return;
    }
    const id = ++markReadyRequestId.current;
    setMarkingReady(true);
    setMarkReadyResult(null);
    try {
      const result = await window.spark.github.markReady(cwd, {
        repository: readyStatus.repository.nameWithOwner,
        pullRequestNumber: pullRequest.number,
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
        expectedHeadCommitOid: pullRequest.headCommitOid,
      });
      if (markReadyRequestId.current !== id) return;
      setMarkReadyResult(result);
      if (result.ok) {
        setSnapshot((current) => {
          if (current?.cwd !== cwd || current.status.kind !== "ready") return current;
          return {
            cwd,
            status: { ...current.status, pullRequest: result.pullRequest },
          };
        });
        onPublished();
      }
    } catch (cause) {
      if (markReadyRequestId.current !== id) return;
      setMarkReadyResult({
        ok: false,
        receipts: [],
        phase: "inspect",
        code: "github-unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
        pullRequest,
      });
    } finally {
      if (markReadyRequestId.current === id) setMarkingReady(false);
    }
  };

  const busySignal = loading || queueSummary.loading;
  useEffect(() => {
    if (!manualRefresh || busySignal) return;
    const timer = window.setTimeout(() => setManualRefresh(false), 160);
    return () => window.clearTimeout(timer);
  }, [busySignal, manualRefresh]);
  const ready = status?.kind === "ready" ? status : null;
  // The queue count already includes this branch's PR; without a queue the
  // only countable item is that PR itself.
  const count = queue
    ? queueSummary.total
    : ready
      ? ready.pullRequest
        ? 1
        : 0
      : null;
  const nothingOpen = Boolean(
    ready && !ready.pullRequest && queue && queueSummary.total === 0,
  );
  const blockReason = ready
    ? publishBlockReason(gitStatus, ready.repository.defaultBranch)
    : null;
  const issuesUrl = ready
    ? `${ready.repository.url.replace(/\/+$/, "")}/issues`
    : null;

  return (
    <section
      aria-label="GitHub"
      style={{ borderBottom: "1px solid var(--rule-soft)" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          minHeight: 34,
          padding: "3px 8px",
          background: "color-mix(in oklab, var(--panel-raised, var(--panel)) 52%, transparent)",
        }}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          title={collapsed ? "Show GitHub issues and pull requests" : "Hide GitHub issues and pull requests"}
          onClick={() => setCollapsed((value) => !value)}
          onMouseEnter={() => setHeaderHover(true)}
          onMouseLeave={() => setHeaderHover(false)}
          style={{
            appearance: "none",
            minWidth: 0,
            flex: 1,
            height: 27,
            padding: "0 6px",
            border: "none",
            borderRadius: 6,
            background: headerHover ? "var(--hover)" : "transparent",
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "default",
            textAlign: "left",
            transition: "background var(--motion-fast) var(--ease-out)",
          }}
        >
          <ChevronIcon open={!collapsed} />
          <span
            style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            letterSpacing: "0.12em",
            fontWeight: 800,
            textTransform: "uppercase",
            color: "var(--ink-dim)",
            }}
          >
            GitHub
          </span>
          {count !== null && count > 0 ? (
            <span
              style={{
                minWidth: 17,
                padding: "1px 5px",
                borderRadius: 999,
                background: "var(--hover)",
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                fontVariantNumeric: "tabular-nums",
                textAlign: "center",
              }}
            >
              {count}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <span
            style={{
              color: "var(--muted-2)",
              fontFamily: "var(--font-sans)",
              fontSize: 9,
              fontWeight: 650,
            }}
          >
            {collapsed ? "Show" : "Hide"}
          </span>
        </button>
        <button
          type="button"
          title="Refresh GitHub issues and pull requests"
          aria-label="Refresh GitHub issues and pull requests"
          disabled={manualRefresh}
          onClick={() => {
            setManualRefresh(true);
            onRefresh();
          }}
          onMouseEnter={() => setRefreshHover(true)}
          onMouseLeave={() => setRefreshHover(false)}
          style={{
            appearance: "none",
            height: 27,
            minWidth: manualRefresh ? 76 : 65,
            padding: "0 7px",
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            background: refreshHover && !manualRefresh ? "var(--hover)" : "transparent",
            color: manualRefresh ? "var(--muted-2)" : "var(--muted)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            cursor: "default",
            fontFamily: "var(--font-sans)",
            fontSize: 9,
            fontWeight: 650,
            opacity: manualRefresh ? 0.78 : 1,
            transition:
              "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
          }}
        >
          {manualRefresh ? <Spinner size={10} /> : <RefreshIcon />}
          <span>{manualRefresh ? "Updating" : "Refresh"}</span>
        </button>
      </div>

      <div
        style={{
          // Hidden (not unmounted) when collapsed so the queue keeps its
          // cached snapshot and its visible-only refresh stays stopped.
          display: collapsed ? "none" : "flex",
          flexDirection: "column",
          gap: 7,
          padding: "8px 10px 10px",
        }}
      >
        {!status ? (
          <MutedText>Checking GitHub…</MutedText>
        ) : status.kind !== "ready" ? (
          <Guidance status={status} />
        ) : (
          <>
            {status.pullRequest ? (
              <PullRequestView
                status={status}
                markingReady={markingReady}
                markReadyResult={markReadyResult}
                onMarkReady={() => void markReady()}
                onMerge={() => {
                  setMergeResult(null);
                  setMergeOpen(true);
                }}
              />
            ) : (
              <>
                <div style={{ fontSize: 11, lineHeight: 1.45, color: "var(--ink-dim)" }}>
                  {nothingOpen ? (
                    "No open issues or pull requests for this repository."
                  ) : (
                    <>
                      No pull request for{" "}
                      <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>
                        {currentBranch ?? "this branch"}
                      </span>{" "}
                      yet.
                    </>
                  )}
                </div>
                {blockReason === null ? (
                  <ActionButton
                    label="Publish as PR"
                    title="Review, commit any working changes, push this branch, and create its GitHub pull request"
                    onClick={() => {
                      setPublishResult(null);
                      setPublishOpen(true);
                    }}
                  />
                ) : (
                  <MutedText>{blockReason}</MutedText>
                )}
              </>
            )}
            {queue ? (
              <GitHubWorkQueue
                key={queue.sourceWorkspaceId}
                sourceWorkspaceId={queue.sourceWorkspaceId}
                refreshKey={queue.refreshKey}
                onOpenItem={queue.onOpenItem}
                omitPullRequest={
                  status.pullRequest
                    ? {
                        repository: status.repository.nameWithOwner,
                        number: status.pullRequest.number,
                      }
                    : null
                }
                onSummary={handleQueueSummary}
              />
            ) : null}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                aria-expanded={helpOpen}
                onClick={() => setHelpOpen((value) => !value)}
                style={linkButtonStyle}
              >
                How this works
              </button>
              <span style={{ flex: 1 }} />
              {issuesUrl ? (
                <button
                  type="button"
                  title="Open this repository's issues on GitHub"
                  onClick={() => openInSystemBrowser(issuesUrl)}
                  style={linkButtonStyle}
                >
                  View all issues
                </button>
              ) : null}
            </div>
            {helpOpen ? (
              <MutedText>
                Pick an issue to start it in its own worktree. Publish the
                branch as a draft pull request, mark it ready for review, and
                merge it here once checks and reviews pass.
              </MutedText>
            ) : null}
          </>
        )}
      </div>
      {publishOpen && status?.kind === "ready" ? (
        <PublishPullRequestDialog
          cwd={cwd}
          gitStatus={gitStatus}
          repository={status.repository}
          previousResult={publishResult}
          onResult={setPublishResult}
          onClose={() => setPublishOpen(false)}
          onPublished={() => {
            setPublishOpen(false);
            setPublishResult(null);
            onPublished();
          }}
        />
      ) : null}
      {mergeOpen && status?.kind === "ready" && status.pullRequest ? (
        <MergePullRequestDialog
          cwd={cwd}
          repository={status.repository.nameWithOwner}
          pullRequest={status.pullRequest}
          previousResult={mergeResult}
          onResult={setMergeResult}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            setMergeOpen(false);
            setMergeResult(null);
            onPublished();
          }}
        />
      ) : null}
    </section>
  );
}

function publishBlockReason(
  status: GitStatus,
  defaultBranch: string | undefined,
): string | null {
  if (status.detached) return "Check out a topic branch before publishing a pull request.";
  if (!status.branch || !defaultBranch) {
    return "A default and current branch are required before publishing a pull request.";
  }
  if (status.branch === defaultBranch) {
    return "Create or switch to a topic branch before publishing a pull request.";
  }
  if (status.hasConflicts) return "Resolve merge conflicts before publishing this branch.";
  if (status.behind > 0) {
    return status.ahead > 0
      ? "This branch has diverged from its upstream. Pull or merge before publishing."
      : "Pull the upstream changes before publishing this branch.";
  }
  return null;
}

function PublishPullRequestDialog({
  cwd,
  gitStatus,
  repository,
  previousResult,
  onResult,
  onClose,
  onPublished,
}: {
  cwd: string;
  gitStatus: GitStatus;
  repository: Extract<GitHubWorkspaceStatus, { kind: "ready" }>["repository"];
  previousResult: GitHubPublishResult | null;
  onResult: (result: GitHubPublishResult | null) => void;
  onClose: () => void;
  onPublished: () => void;
}): React.ReactElement {
  const dirty = gitStatus.staged.length + gitStatus.unstaged.length;
  const [title, setTitle] = useState(() => pullRequestTitle(gitStatus.branch));
  const [body, setBody] = useState("");
  const [commitMessage, setCommitMessage] = useState(() => pullRequestTitle(gitStatus.branch));
  const [draft, setDraft] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  const submit = async () => {
    if (submitting || !title.trim() || (dirty > 0 && !commitMessage.trim())) return;
    setSubmitting(true);
    onResult(null);
    try {
      const result = await window.spark.github.publish(cwd, {
        title: title.trim(),
        body,
        draft,
        ...(dirty > 0 ? { commitMessage: commitMessage.trim() } : {}),
      });
      onResult(result);
      if (result.ok) onPublished();
    } catch (cause) {
      onResult({
        ok: false,
        receipts: [],
        phase: "validate",
        code: "github-unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
        branch: gitStatus.branch ?? "",
        base: repository.defaultBranch ?? "",
        committed: false,
        pushed: false,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !submitting) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "rgba(4, 5, 10, 0.68)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Publish branch as a GitHub pull request"
        style={{
          width: "min(560px, calc(100vw - 48px))",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          padding: 18,
          borderRadius: 12,
          border: "1px solid var(--rule-strong)",
          background: "var(--panel)",
          boxShadow: "0 20px 70px rgba(0, 0, 0, 0.45)",
          display: "grid",
          gap: 13,
        }}
      >
        <div>
          <div style={{ color: "var(--ink)", fontSize: 14, fontWeight: 700 }}>
            Publish this worktree
          </div>
          <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 11.5, lineHeight: 1.5 }}>
            {dirty > 0
              ? `Commit all ${dirty} changed ${dirty === 1 ? "file" : "files"}, then push `
              : "Push "}
            <code style={{ color: "var(--ink-dim)" }}>{gitStatus.branch}</code> and create a{" "}
            {draft ? "draft " : ""}pull request into{" "}
            <code style={{ color: "var(--ink-dim)" }}>
              {repository.defaultBranch ?? "the default branch"}
            </code>
            .
          </div>
        </div>

        <PublishField label="Pull request title">
          <input
            ref={titleRef}
            value={title}
            maxLength={256}
            disabled={submitting}
            onChange={(event) => setTitle(event.target.value)}
            style={publishInputStyle}
          />
        </PublishField>
        {dirty > 0 ? (
          <PublishField label={`Commit message · ${dirty} changed ${dirty === 1 ? "file" : "files"}`}>
            <input
              value={commitMessage}
              maxLength={512}
              disabled={submitting}
              onChange={(event) => setCommitMessage(event.target.value)}
              style={publishInputStyle}
            />
          </PublishField>
        ) : null}
        <PublishField label="Description">
          <textarea
            value={body}
            maxLength={32_768}
            rows={7}
            disabled={submitting}
            placeholder="What changed, and how was it verified?"
            onChange={(event) => setBody(event.target.value)}
            style={{ ...publishInputStyle, resize: "vertical", minHeight: 112 }}
          />
        </PublishField>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: "var(--ink-dim)",
            fontSize: 11.5,
          }}
        >
          <input
            type="checkbox"
            checked={draft}
            disabled={submitting}
            onChange={(event) => setDraft(event.target.checked)}
          />
          Create as draft
        </label>

        {previousResult && !previousResult.ok ? (
          <div
            role="alert"
            style={{
              padding: "8px 10px",
              borderRadius: 7,
              border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
              background: "color-mix(in srgb, var(--danger) 9%, transparent)",
              color: "var(--danger)",
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {previousResult.message}
            {previousResult.committed || previousResult.pushed ? (
              <div style={{ marginTop: 3, color: "var(--muted)" }}>
                Completed before the failure:{" "}
                {[previousResult.committed ? "commit" : "", previousResult.pushed ? "push" : ""]
                  .filter(Boolean)
                  .join(", ")}
                . Retry will reconcile the branch before creating a PR.
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <DialogButton label="Cancel" disabled={submitting} onClick={onClose} />
          <DialogButton
            primary
            label={submitting ? "Publishing…" : draft ? "Publish draft PR" : "Publish PR"}
            disabled={
              submitting || !title.trim() || (dirty > 0 && !commitMessage.trim())
            }
            onClick={() => void submit()}
          />
        </div>
      </div>
    </div>
  );
}

function PublishField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <span className="spark-eyebrow">{label}</span>
      {children}
    </label>
  );
}

function MergePullRequestDialog({
  cwd,
  repository,
  pullRequest,
  previousResult,
  onResult,
  onClose,
  onMerged,
}: {
  cwd: string;
  repository: string;
  pullRequest: GitHubPullRequestSummary;
  previousResult: GitHubMergeResult | null;
  onResult: (result: GitHubMergeResult | null) => void;
  onClose: () => void;
  onMerged: () => void;
}): React.ReactElement {
  const [strategy, setStrategy] = useState<GitHubMergeStrategy>("squash");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  const submit = async () => {
    if (submitting || !confirmed || !pullRequest.headCommitOid) return;
    setSubmitting(true);
    onResult(null);
    try {
      const result = await window.spark.github.merge(cwd, {
        repository,
        pullRequestNumber: pullRequest.number,
        baseBranch: pullRequest.baseBranch,
        headBranch: pullRequest.headBranch,
        expectedHeadCommitOid: pullRequest.headCommitOid,
        strategy,
      });
      onResult(result);
      if (result.ok) onMerged();
    } catch (cause) {
      onResult({
        ok: false,
        receipts: [],
        phase: "inspect",
        code: "github-unavailable",
        message: cause instanceof Error ? cause.message : String(cause),
        pullRequest,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !submitting) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "rgba(4, 5, 10, 0.68)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Merge pull request ${pullRequest.number}`}
        style={{
          width: "min(520px, calc(100vw - 48px))",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          padding: 18,
          borderRadius: 12,
          border: "1px solid var(--rule-strong)",
          background: "var(--panel)",
          boxShadow: "0 20px 70px rgba(0, 0, 0, 0.45)",
          display: "grid",
          gap: 13,
        }}
      >
        <div>
          <div style={{ color: "var(--ink)", fontSize: 14, fontWeight: 700 }}>
            Merge pull request #{pullRequest.number}
          </div>
          <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 11.5, lineHeight: 1.5 }}>
            Codara will refresh GitHub immediately before merging and require the exact reviewed
            head <code style={{ color: "var(--ink-dim)" }}>{pullRequest.headCommitOid?.slice(0, 12)}</code>.
            It will not delete the branch or this worktree.
          </div>
        </div>

        <PublishField label="Merge strategy">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 7 }}>
            {(["squash", "merge", "rebase"] as const).map((option) => (
              <button
                key={option}
                type="button"
                disabled={submitting}
                aria-pressed={strategy === option}
                onClick={() => {
                  setStrategy(option);
                  setConfirmed(false);
                  onResult(null);
                }}
                style={{
                  appearance: "none",
                  padding: "8px 6px",
                  borderRadius: 7,
                  border:
                    strategy === option
                      ? "1px solid var(--accent-edge)"
                      : "1px solid var(--rule-strong)",
                  background: strategy === option ? "var(--accent-soft)" : "var(--panel-2)",
                  color: strategy === option ? "var(--accent)" : "var(--ink-dim)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "capitalize",
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </PublishField>

        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 9,
            padding: "9px 10px",
            borderRadius: 8,
            border: "1px solid var(--rule-soft)",
            background: "var(--panel-2)",
            color: "var(--ink-dim)",
            fontSize: 11.5,
            lineHeight: 1.45,
          }}
        >
          <input
            type="checkbox"
            checked={confirmed}
            disabled={submitting}
            onChange={(event) => setConfirmed(event.target.checked)}
            style={{ marginTop: 2 }}
          />
          I reviewed #{pullRequest.number}, its checks and review state, and I want to {strategy}{" "}
          <code>{pullRequest.headBranch}</code> into <code>{pullRequest.baseBranch}</code>.
        </label>

        {previousResult && !previousResult.ok ? (
          <div
            role="alert"
            style={{
              padding: "8px 10px",
              borderRadius: 7,
              border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
              background: "color-mix(in srgb, var(--danger) 9%, transparent)",
              color: "var(--danger)",
              fontSize: 11,
              lineHeight: 1.5,
            }}
          >
            {previousResult.message}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <DialogButton label="Cancel" disabled={submitting} onClick={onClose} />
          <DialogButton
            primary
            label={submitting ? "Verifying and merging…" : `Confirm ${strategy} merge`}
            disabled={submitting || !confirmed || !pullRequest.headCommitOid}
            onClick={() => void submit()}
          />
        </div>
      </div>
    </div>
  );
}

function DialogButton({
  label,
  disabled,
  primary = false,
  onClick,
}: {
  label: string;
  disabled: boolean;
  primary?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        appearance: "none",
        border: `1px solid ${primary ? "var(--accent-edge)" : "var(--rule-strong)"}`,
        borderRadius: 7,
        padding: "7px 11px",
        background: primary ? "var(--accent-soft)" : "transparent",
        color: primary ? "var(--accent)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 650,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

const publishInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  borderRadius: 7,
  border: "1px solid var(--rule-strong)",
  padding: "8px 9px",
  background: "var(--panel-2)",
  color: "var(--ink)",
  fontFamily: "var(--font-sans)",
  fontSize: 11.5,
  lineHeight: 1.45,
  outline: "none",
};

function pullRequestTitle(branch: string | undefined): string {
  const leaf = (branch ?? "").split("/").filter(Boolean).pop() ?? "";
  const words = leaf
    .replace(/^(issue|feat|feature|fix|chore)[-_]?\d*[-_]?/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Publish changes";
}

const linkButtonStyle: React.CSSProperties = {
  appearance: "none",
  padding: 0,
  border: 0,
  background: "transparent",
  color: "var(--muted)",
  fontFamily: "var(--font-sans)",
  fontSize: 10.5,
  cursor: "default",
};

function Guidance({
  status,
}: {
  status: Exclude<GitHubWorkspaceStatus, { kind: "ready" }>;
}): React.ReactElement {
  return (
    <>
      <div style={{ fontSize: 11, lineHeight: 1.5, color: "var(--muted)" }}>
        {status.message}
      </div>
      {status.kind === "not-installed" && (
        <ActionButton
          label="GitHub CLI setup"
          title="Open the GitHub CLI installation guide"
          onClick={() => openInSystemBrowser("https://cli.github.com/")}
        />
      )}
    </>
  );
}

function PullRequestView({
  status,
  markingReady,
  markReadyResult,
  onMarkReady,
  onMerge,
}: {
  status: Extract<GitHubWorkspaceStatus, { kind: "ready" }>;
  markingReady: boolean;
  markReadyResult: GitHubMarkReadyResult | null;
  onMarkReady: () => void;
  onMerge: () => void;
}): React.ReactElement {
  const pullRequest = status.pullRequest!;
  const state = pullRequest.isDraft ? "DRAFT" : pullRequest.state;
  const stateColor =
    pullRequest.isDraft || pullRequest.state === "CLOSED"
      ? "var(--muted)"
      : pullRequest.state === "OPEN"
        ? "var(--ok)"
        : "var(--accent)";
  const checks = checkLabel(pullRequest.checks);
  const checkColor =
    pullRequest.checks.failed > 0
      ? "var(--danger)"
      : pullRequest.checks.pending > 0
        ? "var(--warn)"
        : pullRequest.checks.total > 0
          ? "var(--ok)"
          : "var(--muted)";
  const reviewLabel = pullRequest.reviewDecision
    ? pullRequest.reviewDecision.replace(/_/g, " ").toLowerCase()
    : "No review requirement";
  const readiness = mergeReadinessMessage(pullRequest);

  return (
    <>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
        <span
          style={{
            flex: "0 0 auto",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--accent)",
          }}
        >
          #{pullRequest.number}
        </span>
        <span
          title={pullRequest.title}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 11,
            fontWeight: 650,
            color: "var(--ink-dim)",
          }}
        >
          {pullRequest.title}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.06em",
            color: stateColor,
          }}
        >
          {state}
        </span>
        <span style={{ fontSize: 10.5, color: checkColor }}>{checks}</span>
      </div>
      <div style={{ fontSize: 10.5, color: "var(--muted)", lineHeight: 1.45 }}>
        <span style={{ textTransform: "capitalize" }}>{reviewLabel}</span>
        {pullRequest.mergeStateStatus ? ` · ${pullRequest.mergeStateStatus.toLowerCase()}` : ""}
        {pullRequest.headCommitOid ? ` · ${pullRequest.headCommitOid.slice(0, 8)}` : ""}
      </div>
      {readiness ? <MutedText>{readiness}</MutedText> : null}
      {markReadyResult && !markReadyResult.ok ? (
        <div
          role="alert"
          style={{
            color: "var(--danger)",
            fontSize: 10.5,
            lineHeight: 1.45,
          }}
        >
          {markReadyResult.message}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <ActionButton
          label="Open PR"
          title={`Open pull request #${pullRequest.number} in your browser`}
          onClick={() => openInSystemBrowser(pullRequest.url)}
        />
        {pullRequest.state === "OPEN" && pullRequest.isDraft ? (
          <ActionButton
            label={markingReady ? "Marking ready…" : "Mark ready"}
            title={`Mark the exact reviewed head of pull request #${pullRequest.number} ready for review`}
            disabled={markingReady || !pullRequest.headCommitOid}
            onClick={onMarkReady}
          />
        ) : null}
        {!readiness ? (
          <ActionButton
            label="Review merge"
            title={`Review safeguards before merging pull request #${pullRequest.number}`}
            onClick={onMerge}
          />
        ) : null}
      </div>
    </>
  );
}

function mergeReadinessMessage(pullRequest: GitHubPullRequestSummary): string | null {
  if (pullRequest.state === "MERGED") return "Merged on GitHub.";
  if (pullRequest.state === "CLOSED") return "This pull request is closed.";
  if (pullRequest.isDraft) return "Mark this draft ready for review before merging.";
  if (!pullRequest.headCommitOid) return "Refresh to load the exact head commit before merging.";
  if (pullRequest.checks.failed > 0) return "Resolve failing checks before merging.";
  if (pullRequest.checks.pending > 0) return "Wait for pending checks before merging.";
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") {
    return "Resolve requested changes before merging.";
  }
  if (pullRequest.reviewDecision === "REVIEW_REQUIRED") {
    return "An approving review is still required.";
  }
  if (
    pullRequest.mergeStateStatus !== "CLEAN" &&
    pullRequest.mergeStateStatus !== "HAS_HOOKS"
  ) {
    return pullRequest.mergeStateStatus
      ? `GitHub reports merge state ${pullRequest.mergeStateStatus}.`
      : "GitHub has not confirmed mergeability yet.";
  }
  return null;
}

function MutedText({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ fontSize: 10.5, lineHeight: 1.5, color: "var(--muted-2)" }}>
      {children}
    </div>
  );
}

function ActionButton({
  label,
  title,
  disabled = false,
  onClick,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => {
        if (!disabled) setHover(true);
      }}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        alignSelf: "flex-start",
        padding: "5px 8px",
        borderRadius: 6,
        border: hover && !disabled ? "1px solid var(--accent-edge)" : "1px solid var(--rule-strong)",
        background: hover && !disabled ? "var(--accent-soft)" : "transparent",
        color: hover && !disabled ? "var(--accent)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 10.5,
        fontWeight: 650,
        opacity: disabled ? 0.5 : 1,
        cursor: "default",
      }}
    >
      {label}
    </button>
  );
}

function checkLabel(checks: GitHubCheckSummary): string {
  if (checks.total === 0) return "No checks reported";
  const parts: string[] = [];
  if (checks.successful > 0) parts.push(`${checks.successful} passed`);
  if (checks.failed > 0) parts.push(`${checks.failed} failed`);
  if (checks.pending > 0) parts.push(`${checks.pending} pending`);
  return parts.join(" · ");
}

function openInSystemBrowser(url: string): void {
  // This preload method lands in ipc.ts's allowlisted shell.openExternal
  // handler. It is an explicit user click and never creates a PR by itself.
  const open = window.spark.openInSystemBrowser ?? window.spark.openExternal;
  void open(url);
}

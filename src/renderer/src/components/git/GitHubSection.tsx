import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  type GitHubCheckSummary,
  type GitHubMarkReadyResult,
  type GitHubMergeResult,
  type GitHubMergeStrategy,
  type GitHubPullRequestSummary,
  type GitHubPublishResult,
  type GitHubShareDraft,
  type GitHubShareResult,
  type GitHubWorkQueueItem,
  type GitHubWorkspaceStatus,
  isValidShareBranchName,
} from "@shared/github";
import type { GitStatus } from "@shared/types";
import { ChevronIcon } from "../icons";
import GitHubWorkQueue from "./GitHubWorkQueue";
import { RefreshIcon, SparkleIcon, Spinner } from "./git-ui";

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
  /**
   * The local sync + commit composer, rendered INSIDE this section's body so
   * everything Git lives under the one GITHUB header. Provided by GitPanel
   * (which owns all the composer state); null when the repo is not ready.
   */
  composer?: React.ReactNode;
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
  composer,
}: Props): React.ReactElement {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  // Expanded by default: the section now hosts the commit composer (the
  // panel's primary workflow), not just the secondary GitHub reads.
  const [collapsed, setCollapsed] = useState(false);
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
  const [queueMerge, setQueueMerge] = useState<{
    repository: string;
    pullRequest: GitHubPullRequestSummary;
  } | null>(null);
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

  // A new workspace context starts the block fresh — open, since the section
  // hosts the commit composer (the panel's primary workflow), with any
  // stale per-workspace state dropped.
  useEffect(() => {
    setCollapsed(false);
    setQueueMerge(null);
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
        // Loud reads bypass the main process's per-workspace status cache, so
        // a Refresh click, a publish/merge, and — critically — a branch change
        // always see GitHub as it is now. Branch changes are the reason main
        // cannot cache on branch identity: `git checkout` typed into a
        // terminal never reaches an IPC handler, but it does move
        // `gitStatus.branch`, which makes the read below loud.
        .status(cwd, { refresh: !silent })
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

  // A new workspace or branch has no snapshot yet, so that read is loud. The
  // block starts open, so this normally fires right away; if the user has
  // collapsed it, the read waits (each one is a `gh` subprocess tree) until
  // the section is expanded again — which is also what picks up a branch that
  // moved while the block was closed.
  useEffect(() => {
    if (collapsed) return;
    loadStatus(false);
    return () => {
      requestId.current += 1;
    };
  }, [collapsed, loadStatus, currentBranch]);

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
    // The git version bumps on every local mutation *and* every editor save,
    // and each read here is a `gh` subprocess tree — so a silent one shares the
    // resume path's clock instead of firing per save. Nothing is lost by
    // waiting: focus, the fallback timer, or the user's own refresh all catch
    // up, and a branch change is handled loudly by the effect above.
    // A collapsed block shows nothing a silent read could update, and opening
    // it reads loudly anyway — so only the user's own refresh gets through.
    if (
      !loud &&
      (collapsed || Date.now() - lastReadAt.current < RESUME_REFRESH_MIN_INTERVAL_MS)
    ) {
      return;
    }
    loadStatus(!loud);
  }, [collapsed, loadStatus, refreshKey, userRefreshKey]);

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

  // ── Two rooms (V2b): "Save" (local: sync, message, commit, split) and
  // "Review" (the journey timeline + everything on GitHub). The room bar is
  // the mental model: first save your work, then walk it through review.
  // Auto-pick: a PR or queue item pulls the user to Review when the working
  // tree is clean; otherwise Save. A manual click wins until the workspace
  // changes.
  const [room, setRoom] = useState<"save" | "review" | null>(null);
  useEffect(() => setRoom(null), [cwd]);
  const dirtyCount = gitStatus ? gitStatus.staged.length + gitStatus.unstaged.length : 0;
  const reviewCount = count ?? 0;
  const activeRoom: "save" | "review" =
    room ?? (dirtyCount === 0 && (ready?.pullRequest || reviewCount > 0) ? "review" : "save");

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
        {/* Room bar — the section's mental model: save work, then review it.
            Counts pull the eye to the room that has something waiting. */}
        <div
          role="tablist"
          aria-label="GitHub rooms"
          style={{
            display: "flex",
            gap: 2,
            padding: 3,
            borderRadius: 8,
            border: "1px solid var(--rule-soft)",
            background: "var(--bg)",
          }}
        >
          <RoomTab
            label="Save"
            title="Save your work locally — sync, commit, split"
            active={activeRoom === "save"}
            count={dirtyCount}
            onClick={() => setRoom("save")}
          />
          <RoomTab
            label="Review"
            title="Walk your work through review on GitHub"
            active={activeRoom === "review"}
            count={reviewCount}
            onClick={() => setRoom("review")}
          />
        </div>

        {/* ── Save room: local git. Rendered even while the gh CLI is
            unavailable, because local Git needs no GitHub. Hidden (not
            unmounted) so composer draft state survives room switches. */}
        <div
          style={{
            display: activeRoom === "save" ? "flex" : "none",
            flexDirection: "column",
            gap: 7,
          }}
        >
          {composer}
        </div>

        {/* ── Review room: the journey timeline + GitHub state. */}
        <div
          style={{
            display: activeRoom === "review" ? "flex" : "none",
            flexDirection: "column",
            gap: 7,
          }}
        >
        {!status ? (
          <MutedText>Checking GitHub…</MutedText>
        ) : status.kind !== "ready" ? (
          <Guidance status={status} />
        ) : (
          <>
            <JourneyTimeline
              gitStatus={gitStatus}
              pullRequest={status.pullRequest ?? null}
              blockReason={blockReason}
              onShare={() => {
                setPublishResult(null);
                setPublishOpen(true);
              }}
            />
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
            ) : nothingOpen && dirtyCount === 0 && gitStatus?.ahead === 0 ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 9px",
                  borderRadius: 7,
                  border: "1px dashed var(--rule)",
                  color: "var(--muted)",
                  fontSize: 10.5,
                  lineHeight: 1.4,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 999,
                    background: "var(--ok)",
                    opacity: 0.7,
                    flex: "0 0 auto",
                  }}
                />
                All clear — no open pull requests or issues.
              </div>
            ) : null}
            {queue ? (
              <GitHubWorkQueue
                key={queue.sourceWorkspaceId}
                cwd={cwd}
                sourceWorkspaceId={queue.sourceWorkspaceId}
                refreshKey={queue.refreshKey}
                onOpenItem={queue.onOpenItem}
                onReviewMerge={(repository, pullRequest) => {
                  setMergeResult(null);
                  setQueueMerge({ repository, pullRequest });
                }}
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
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
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
          </>
        )}
        </div>
      </div>
      {publishOpen && status?.kind === "ready" ? (
        <ShareForReviewDialog
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
      {queueMerge ? (
        <MergePullRequestDialog
          cwd={cwd}
          repository={queueMerge.repository}
          pullRequest={queueMerge.pullRequest}
          previousResult={mergeResult}
          onResult={setMergeResult}
          onClose={() => {
            setQueueMerge(null);
            setMergeResult(null);
          }}
          onMerged={() => {
            setQueueMerge(null);
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
  if (status.detached) return "Check out a branch before sharing your work.";
  if (!status.branch || !defaultBranch) {
    return "A default and current branch are required before sharing your work.";
  }
  if (status.hasConflicts) return "Resolve the merge conflicts before sharing this work.";
  if (status.behind > 0) {
    return status.ahead > 0
      ? "This branch has diverged from its upstream. Pull or merge before sharing."
      : "Pull the latest changes before sharing this work.";
  }
  // Sharing from the default branch is fine now — the share flow creates a
  // topic branch on the way — but only when there is actually work to share.
  if (
    status.branch === defaultBranch &&
    status.staged.length + status.unstaged.length === 0 &&
    status.ahead === 0
  ) {
    return "No new work to share yet — everything is already on GitHub.";
  }
  return null;
}

// The one-button "Share for review" flow. Opens on an AI-drafted proposal
// (branch, title, commit message, description) generated from the actual diff
// by the user's commit-message model; the user reviews plain-language fields
// and confirms. Behind the confirm, the reviewed host transaction creates the
// topic branch when needed, commits, pushes, and opens the PR. Technical
// detail (branch name, draft toggle) lives in a collapsed "Details"
// disclosure so the default surface stays approachable.
function ShareForReviewDialog({
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
  const onDefaultBranch = gitStatus.branch === repository.defaultBranch;
  const [drafting, setDrafting] = useState(true);
  const [draftSource, setDraftSource] = useState<GitHubShareDraft["source"] | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [branch, setBranch] = useState("");
  const [draft, setDraft] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Ask the backend for the AI proposal once, on open. A failure silently
  // falls back to deterministic drafts server-side, so this never errors the
  // dialog — the fields just fill in.
  useEffect(() => {
    let cancelled = false;
    window.spark.github
      .shareDraft(cwd)
      .then((proposal) => {
        if (cancelled) return;
        setTitle((current) => current || proposal.title);
        setCommitMessage((current) => current || proposal.commitMessage);
        setBody((current) => current || proposal.description);
        setBranch((current) => current || proposal.branch);
        setDraftSource(proposal.source);
      })
      .catch(() => {
        if (cancelled) return;
        setDraftSource("fallback");
        setBranch((current) => current || `share/changes-${Date.now().toString(36)}`);
      })
      .finally(() => {
        if (!cancelled) setDrafting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, submitting]);

  // Focus the title once drafting lands so review starts at the top field.
  useEffect(() => {
    if (!drafting) titleRef.current?.focus();
  }, [drafting]);

  const branchInvalid = onDefaultBranch && !isValidShareBranchName(branch.trim());
  const blocked =
    submitting ||
    drafting ||
    !title.trim() ||
    (dirty > 0 && !commitMessage.trim()) ||
    branchInvalid;

  const submit = async () => {
    if (blocked) return;
    setSubmitting(true);
    onResult(null);
    try {
      const result: GitHubShareResult = await window.spark.github.share(cwd, {
        title: title.trim(),
        body,
        draft,
        ...(dirty > 0 ? { commitMessage: commitMessage.trim() } : {}),
        ...(onDefaultBranch ? { branch: branch.trim() } : {}),
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
        aria-label="Share your work for review on GitHub"
        style={{
          width: "min(600px, calc(100vw - 48px))",
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: "var(--ink)",
              fontSize: 14,
              fontWeight: 700,
            }}
          >
            Share for review
            {drafting ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  color: "var(--accent-text)",
                  fontSize: 10.5,
                  fontWeight: 600,
                }}
              >
                <Spinner size={10} /> Drafting from your changes…
              </span>
            ) : draftSource === "ai" ? (
              <span
                title="Pre-filled by your commit-message model from the actual diff"
                style={{
                  padding: "2px 7px",
                  borderRadius: 999,
                  border: "1px solid color-mix(in oklch, var(--accent) 35%, transparent)",
                  background: "color-mix(in oklab, var(--accent) 10%, transparent)",
                  color: "var(--accent-text)",
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                }}
              >
                AI draft
              </span>
            ) : null}
          </div>
          <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 11.5, lineHeight: 1.5 }}>
            {dirty > 0
              ? `Save all ${dirty} changed ${dirty === 1 ? "file" : "files"} and send`
              : "Send"}{" "}
            your work to GitHub as a {draft ? "draft " : ""}pull request so it can be reviewed
            before it joins{" "}
            <code style={{ color: "var(--ink-dim)" }}>
              {repository.defaultBranch ?? "the main branch"}
            </code>
            . Nothing changes on{" "}
            <code style={{ color: "var(--ink-dim)" }}>
              {repository.defaultBranch ?? "main"}
            </code>{" "}
            until the review is approved.
          </div>
        </div>

        <PublishField label="What is this change?">
          <input
            ref={titleRef}
            value={title}
            maxLength={256}
            disabled={submitting}
            placeholder={drafting ? "Drafting…" : "A one-line summary"}
            onChange={(event) => setTitle(event.target.value)}
            style={publishInputStyle}
          />
        </PublishField>
        <PublishField label="Tell reviewers more (optional)">
          <textarea
            value={body}
            maxLength={32_768}
            rows={7}
            disabled={submitting}
            placeholder={drafting ? "Drafting…" : "What changed, and why?"}
            onChange={(event) => setBody(event.target.value)}
            style={{ ...publishInputStyle, resize: "vertical", minHeight: 112 }}
          />
        </PublishField>

        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen((value) => !value)}
          style={{
            appearance: "none",
            border: "none",
            background: "transparent",
            padding: 0,
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: "default",
          }}
        >
          <ChevronIcon open={detailsOpen} />
          Details
        </button>
        {detailsOpen ? (
          <div style={{ display: "grid", gap: 13 }}>
            {dirty > 0 ? (
              <PublishField
                label={`Save note (commit message) · ${dirty} changed ${dirty === 1 ? "file" : "files"}`}
              >
                <textarea
                  value={commitMessage}
                  maxLength={4096}
                  rows={3}
                  disabled={submitting}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  style={{ ...publishInputStyle, resize: "vertical", minHeight: 56 }}
                />
              </PublishField>
            ) : null}
            {onDefaultBranch ? (
              <PublishField label="New branch for this work">
                <input
                  value={branch}
                  maxLength={120}
                  disabled={submitting}
                  onChange={(event) => setBranch(event.target.value)}
                  style={{
                    ...publishInputStyle,
                    fontFamily: "var(--font-mono)",
                    ...(branchInvalid && branch.trim()
                      ? { borderColor: "color-mix(in srgb, var(--danger) 55%, transparent)" }
                      : {}),
                  }}
                />
                {branchInvalid && branch.trim() ? (
                  <span style={{ color: "var(--danger)", fontSize: 10.5 }}>
                    Branch names use letters, digits, dashes and at most one slash.
                  </span>
                ) : (
                  <span style={{ color: "var(--muted-2)", fontSize: 10.5 }}>
                    Your work moves onto this branch so{" "}
                    {repository.defaultBranch ?? "the main branch"} stays untouched.
                  </span>
                )}
              </PublishField>
            ) : null}
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
              Open as a draft (reviewers see it, merging stays off until it is ready)
            </label>
          </div>
        ) : null}

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
                {[previousResult.committed ? "save" : "", previousResult.pushed ? "upload" : ""]
                  .filter(Boolean)
                  .join(", ")}
                . Sharing again picks up where it left off.
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <DialogButton label="Cancel" disabled={submitting} onClick={onClose} />
          <DialogButton
            primary
            label={submitting ? "Sharing…" : "Share for review"}
            disabled={blocked}
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
                  color: strategy === option ? "var(--accent-text)" : "var(--ink-dim)",
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
        color: primary ? "var(--accent-text)" : "var(--ink-dim)",
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
      {(status.kind === "not-installed" || status.kind === "outdated-cli") && (
        <ActionButton
          label="GitHub CLI setup"
          title={
            status.kind === "outdated-cli"
              ? "Open the GitHub CLI download page to update `gh`"
              : "Open the GitHub CLI installation guide"
          }
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
            color: "var(--accent-text)",
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

// THE button of the section: one accent-filled action that runs the whole
// share ceremony. Deliberately the only filled button in Source Control so
// the panel keeps a single obvious next step.
// One tab of the room bar. The count badge only renders when something is
// actually waiting in that room.
function RoomTab({
  label,
  title,
  active,
  count,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  count: number;
  onClick: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: 24,
        border: "none",
        borderRadius: 6,
        cursor: "default",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 700,
        background: active
          ? "color-mix(in oklab, var(--panel-raised, var(--panel)) 88%, transparent)"
          : hover
            ? "var(--hover)"
            : "transparent",
        color: active ? "var(--ink)" : "var(--muted)",
        boxShadow: active ? "var(--lift-lo, 0 1px 4px rgba(0,0,0,.25))" : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span>{label}</span>
      {count > 0 ? (
        <span
          style={{
            minWidth: 15,
            padding: "0 4px",
            borderRadius: 999,
            border: "1px solid var(--accent-edge)",
            background: "var(--accent-soft)",
            color: "var(--accent-text)",
            fontFamily: "var(--font-mono)",
            fontSize: 8.5,
            fontWeight: 700,
            fontVariantNumeric: "tabular-nums",
            lineHeight: "13px",
            textAlign: "center",
          }}
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}

// The Review room's spine: the journey a change travels, drawn as a vertical
// timeline anyone can read — Saved → Shared → Checks → Merge. The current
// stage glows and carries its single action; everything else is context.
// Non-technical users see WHERE THEY ARE instead of a wall of git nouns.
function JourneyTimeline({
  gitStatus,
  pullRequest,
  blockReason,
  onShare,
}: {
  gitStatus: GitStatus | null;
  pullRequest: GitHubPullRequestSummary | null;
  blockReason: string | null;
  onShare: () => void;
}): React.ReactElement {
  const dirty = gitStatus ? gitStatus.staged.length + gitStatus.unstaged.length : 0;
  const ahead = gitStatus?.ahead ?? 0;

  type Step = {
    key: string;
    state: "done" | "now" | "idle";
    title: string;
    detail: string;
    action?: React.ReactNode;
  };

  let steps: Step[];
  if (pullRequest) {
    const checksDone =
      pullRequest.checks.total > 0 &&
      pullRequest.checks.pending === 0 &&
      pullRequest.checks.failed === 0;
    const checksFailed = pullRequest.checks.failed > 0;
    const checksRunning = pullRequest.checks.pending > 0;
    steps = [
      {
        key: "saved",
        state: dirty > 0 ? "now" : "done",
        title: dirty > 0 ? "New edits not shared yet" : "Work saved",
        detail:
          dirty > 0
            ? `${dirty} file${dirty === 1 ? "" : "s"} changed since sharing — save and push to update the PR`
            : "everything is committed",
      },
      {
        key: "shared",
        state: "done",
        title: `Shared as PR #${pullRequest.number}`,
        detail: pullRequest.isDraft ? "draft — mark it ready below" : "open for review",
      },
      {
        key: "checks",
        state: checksRunning ? "now" : checksDone || checksFailed ? "done" : "idle",
        title: checksFailed
          ? "Checks found problems"
          : checksRunning
            ? "GitHub is testing your changes"
            : checksDone
              ? "All checks passed"
              : "Checks",
        detail: checkLabel(pullRequest.checks),
      },
      {
        key: "merge",
        state: checksDone && !pullRequest.isDraft ? "now" : "idle",
        title: "Merge",
        detail:
          checksDone && !pullRequest.isDraft
            ? "ready — review and merge below"
            : "after checks pass",
      },
    ];
  } else if (dirty > 0 || ahead > 0) {
    steps = [
      {
        key: "saved",
        state: dirty > 0 ? "now" : "done",
        title: dirty > 0 ? "Save your work" : "Work saved",
        detail:
          dirty > 0
            ? `${dirty} file${dirty === 1 ? "" : "s"} changed — commit in the Save room`
            : `${ahead} commit${ahead === 1 ? "" : "s"} ready to share`,
      },
      {
        key: "share",
        state: dirty === 0 || blockReason === null ? "now" : "idle",
        title: "Share for review",
        detail: blockReason ?? "Codara drafts the summary for you",
        action:
          blockReason === null ? <ShareButton onClick={onShare} /> : undefined,
      },
      { key: "checks", state: "idle", title: "Checks", detail: "GitHub tests your changes" },
      { key: "merge", state: "idle", title: "Merge", detail: "the work lands in main" },
    ];
  } else {
    // Nothing in flight — the timeline collapses to a single quiet line
    // instead of parading four empty stages.
    return (
      <div style={{ fontSize: 11, lineHeight: 1.45, color: "var(--muted)" }}>
        Everything is shared. New edits will start the journey again.
      </div>
    );
  }

  return (
    <div role="list" aria-label="Review journey" style={{ display: "flex", flexDirection: "column" }}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const numberColor =
          step.state === "done" ? "var(--ok)" : step.state === "now" ? "var(--accent-text)" : "var(--muted-2)";
        return (
          <div key={step.key} role="listitem" style={{ display: "flex", gap: 9, minWidth: 0 }}>
            {/* rail */}
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 15, flex: "0 0 15px" }}>
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  flex: "0 0 14px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 8,
                  fontWeight: 800,
                  fontFamily: "var(--font-mono)",
                  color: step.state === "now" ? "var(--bg)" : numberColor,
                  background: step.state === "now" ? "var(--accent)" : "transparent",
                  border: `1.5px solid ${step.state === "now" ? "var(--accent)" : step.state === "done" ? "var(--ok)" : "var(--rule)"}`,
                }}
              >
                {step.state === "done" ? "✓" : index + 1}
              </span>
              {!last ? (
                <span
                  aria-hidden
                  style={{
                    width: 1.5,
                    flex: 1,
                    minHeight: 8,
                    background:
                      step.state === "done"
                        ? "color-mix(in oklab, var(--ok) 40%, transparent)"
                        : "var(--rule-soft)",
                  }}
                />
              ) : null}
            </div>
            {/* body */}
            <div style={{ flex: 1, minWidth: 0, paddingBottom: last ? 0 : 9 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 650,
                  color: step.state === "now" ? "var(--ink)" : step.state === "done" ? "var(--ink-dim)" : "var(--muted)",
                  lineHeight: 1.35,
                }}
              >
                {step.title}
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.4, marginTop: 1 }}>
                {step.detail}
              </div>
              {step.action ? <div style={{ marginTop: 7 }}>{step.action}</div> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ShareButton({ onClick }: { onClick: () => void }): React.ReactElement {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      type="button"
      title="Save your changes, send them to GitHub, and open a pull request for review — Codara drafts the summary for you"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        appearance: "none",
        alignSelf: "stretch",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        padding: "7px 12px",
        borderRadius: 7,
        border: "1px solid color-mix(in oklch, var(--accent) 55%, transparent)",
        background: pressed
          ? "color-mix(in oklab, var(--accent) 26%, var(--panel))"
          : hover
            ? "color-mix(in oklab, var(--accent) 20%, var(--panel))"
            : "color-mix(in oklab, var(--accent) 14%, var(--panel))",
        color: "var(--accent-text)",
        boxShadow: hover ? "0 0 14px color-mix(in oklab, var(--accent-glow, var(--accent)) 30%, transparent)" : "none",
        fontFamily: "var(--font-sans)",
        fontSize: 11.5,
        fontWeight: 700,
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <SparkleIcon />
      Share for review
    </button>
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
        color: hover && !disabled ? "var(--accent-text)" : "var(--ink-dim)",
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

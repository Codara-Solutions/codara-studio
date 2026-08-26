import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitHubPullRequestDetails,
  GitHubPullRequestSummary,
  GitHubWorkQueueItem,
  GitHubWorkQueueStatus,
} from "@shared/github";
import { Spinner } from "./git-ui";

interface Props {
  cwd: string;
  sourceWorkspaceId: string;
  refreshKey: number;
  onOpenItem: (item: GitHubWorkQueueItem) => Promise<void>;
  onReviewMerge: (
    repository: string,
    pullRequest: GitHubPullRequestSummary,
  ) => void;
  /** The branch's own PR is rendered above the list, so its row is omitted. */
  omitPullRequest: { repository: string; number: number } | null;
  /** Reports load state and the unfiltered item count to the section header. */
  onSummary: (summary: { loading: boolean; total: number | null }) => void;
}

// The queue reads github.com through `gh`, so it never refreshes on its own
// while the panel is closed, collapsed or scrolled out of view: the only
// automatic reads happen while the section is genuinely on screen. Those reads
// are event-driven (window focus, becoming visible, the user's own actions);
// this interval is the slow fallback for a window left open and untouched.
const QUEUE_FALLBACK_REFRESH_MS = 300_000;

// Focus fires on every alt-tab back, and each read is a `gh` subprocess tree.
// A read this recent is still good enough to skip the next one.
const RESUME_REFRESH_MIN_INTERVAL_MS = 60_000;

// The list body of the Source Control GitHub block: open issues and pull
// requests across the repository, each with its worktree/run action. The
// header, count, refresh control and block-wide empty state live in
// GitHubSection, so the panel shows exactly one GitHub area.
export default function GitHubWorkQueue({
  cwd,
  sourceWorkspaceId,
  refreshKey,
  onOpenItem,
  onReviewMerge,
  omitPullRequest,
  onSummary,
}: Props): React.ReactElement {
  const [status, setStatus] = useState<GitHubWorkQueueStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedPullRequest, setSelectedPullRequest] = useState<
    Extract<GitHubWorkQueueItem, { kind: "pull-request" }> | null
  >(null);
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const generation = useRef(0);
  const inFlight = useRef<{ generation: number; silent: boolean } | null>(null);
  // Lets a silent load decide whether it has a good list worth keeping.
  const statusRef = useRef<GitHubWorkQueueStatus | null>(status);
  statusRef.current = status;
  // When the list was last read successfully — the focus throttle's clock.
  const lastReadAt = useRef(0);

  // `silent` is a background read: it reports no load state to the section
  // header (so the spinner stays down) and leaves the last good list in place
  // if it fails, since the user never asked for it.
  const load = useCallback(
    async ({ refresh, silent }: { refresh: boolean; silent: boolean }) => {
      const active = inFlight.current;
      // One read at a time — except that a read the user asked for must never
      // be swallowed by a background poll that happens to be running. A focus
      // refresh takes seconds, which is exactly when the Refresh button would
      // otherwise look dead. The loud read supersedes it.
      if (active && !(active.silent && !silent)) return;
      const current = ++generation.current;
      inFlight.current = { generation: current, silent };
      if (!silent) {
        setLoading(true);
        setLoadError(null);
      }
      try {
        const next = await window.spark.github.workQueue(
          sourceWorkspaceId,
          refresh,
        );
        if (generation.current === current) {
          lastReadAt.current = Date.now();
          setStatus(next);
          setLoadError(null);
        }
      } catch {
        if (generation.current === current && !(silent && statusRef.current)) {
          setLoadError("The GitHub work queue could not be loaded.");
        }
      } finally {
        // A superseded read must not release the slot the read that displaced
        // it now holds.
        if (inFlight.current?.generation === current) inFlight.current = null;
        if (generation.current === current) setLoading(false);
      }
    },
    [sourceWorkspaceId],
  );

  useEffect(() => {
    // Mount is the first load, and a bumped key is the user's own refresh —
    // both are loud.
    void load({ refresh: refreshKey > 0, silent: false });
    return () => {
      generation.current += 1;
    };
  }, [load, refreshKey]);

  useEffect(() => {
    if (!surface) return;
    let onScreen = false;
    let observed = false;
    let timer: number | null = null;
    const shown = (): boolean =>
      onScreen && document.visibilityState === "visible";
    const stop = (): void => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    // Every automatic read here is silent — the list updates under the user
    // without the header ever flickering into a loading state. It also does not
    // ask main to drop its cached list: the throttle below already spaces these
    // reads further apart than that cache lives, so forcing a rebuild only
    // discarded a snapshot that was about to be rebuilt anyway. `refresh` stays
    // reserved for reads the user asked for.
    const refreshSilently = (): void => void load({ refresh: false, silent: true });
    const start = (): void => {
      if (timer !== null || !shown()) return;
      timer = window.setInterval(() => {
        if (shown()) refreshSilently();
        else stop();
      }, QUEUE_FALLBACK_REFRESH_MS);
    };
    const sync = (refresh: boolean): void => {
      if (!shown()) {
        stop();
        return;
      }
      if (refresh) refreshSilently();
      start();
    };
    // Coming back into view: read only if the list has had time to go stale,
    // but always re-arm the fallback timer. Focus and visibility fire together
    // on one alt-tab, and the surface goes off-screen every time a commit
    // detail is opened — none of which should cost a `gh` run on its own, so
    // they all share one clock.
    const resume = (): void =>
      sync(Date.now() - lastReadAt.current >= RESUME_REFRESH_MIN_INTERVAL_MS);
    const observer = new IntersectionObserver((entries) => {
      const next = entries.some((entry) => entry.isIntersecting);
      if (observed && next === onScreen) return;
      onScreen = next;
      // The mount effect already loaded the queue, so the first observation
      // only starts the timer; later ones are the surface coming back.
      if (observed) resume();
      else sync(false);
      observed = true;
    });
    observer.observe(surface);
    const handleVisibilityChange = resume;
    const handleFocus = resume;
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      stop();
    };
  }, [load, surface]);

  // The single section header owns the spinner and count for the whole block.
  useEffect(() => {
    onSummary({
      loading,
      total: status?.kind === "ready" ? status.items.length : null,
    });
  }, [onSummary, loading, status]);

  const open = useCallback(
    async (item: GitHubWorkQueueItem) => {
      if (busyKey) return;
      setBusyKey(item.key);
      setActionError(null);
      try {
        await onOpenItem(item);
        if (item.kind === "pull-request") setSelectedPullRequest(null);
      } catch (cause) {
        setActionError(
          cause instanceof Error
            ? cause.message
            : "This GitHub item could not be opened.",
        );
      } finally {
        setBusyKey(null);
        void load({ refresh: true, silent: false });
      }
    },
    [busyKey, load, onOpenItem],
  );

  const ready = status?.kind === "ready" ? status : null;
  const items = ready
    ? ready.items.filter(
        (item) =>
          !(
            omitPullRequest &&
            item.kind === "pull-request" &&
            item.repository === omitPullRequest.repository &&
            item.pullRequest.number === omitPullRequest.number
          ),
      )
    : [];
  const partial = ready
    ? ready.errors.length > 0 ||
      ready.truncated.errorsOmitted > 0 ||
      ready.truncated.sourceRootsOmitted > 0 ||
      ready.truncated.repositoriesOmitted > 0 ||
      ready.truncated.itemsOmitted > 0
    : false;
  const showsAnything = Boolean(
    actionError ||
      loadError ||
      (status && status.kind !== "ready") ||
      items.length > 0 ||
      partial,
  );

  return (
    <div
      ref={setSurface}
      aria-label="Open GitHub issues and pull requests"
      style={{
        display: "flex",
        flexDirection: "column",
        // An empty list still mounts (it anchors the visible-only refresh),
        // but must not occupy a slot in the section's gap-spaced column.
        ...(showsAnything ? {} : { marginTop: -7 }),
      }}
    >
      {actionError && !selectedPullRequest && (
        <QueueMessage tone="error" alert>
          {actionError}
        </QueueMessage>
      )}
      {loadError && <QueueMessage tone="error">{loadError}</QueueMessage>}
      {!loadError && status && status.kind !== "ready" && (
        <QueueMessage>{status.message}</QueueMessage>
      )}
      {items.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            borderTop: "1px solid var(--rule-soft)",
            marginTop: 1,
            paddingTop: 2,
          }}
        >
          {items.slice(0, 18).map((item, index) => {
            const summary =
              item.kind === "issue" ? item.issue : item.pullRequest;
            const action = actionLabel(item);
            return (
              <button
                key={item.key}
                type="button"
                disabled={busyKey !== null}
                aria-busy={busyKey === item.key}
                aria-haspopup={item.kind === "pull-request" ? "dialog" : undefined}
                onClick={() => {
                  if (item.kind === "pull-request") {
                    setActionError(null);
                    setSelectedPullRequest(item);
                  } else {
                    void open(item);
                  }
                }}
                title={actionDescription(item)}
                style={{
                  width: "100%",
                  minHeight: 42,
                  padding: "6px 0",
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  columnGap: 8,
                  alignItems: "center",
                  border: 0,
                  borderTop:
                    index > 0 ? "1px solid var(--rule-soft)" : "0",
                  background: "transparent",
                  color: "var(--ink-dim)",
                  textAlign: "left",
                  cursor: busyKey ? "default" : "pointer",
                  opacity: busyKey && busyKey !== item.key ? 0.55 : 1,
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {summary.title}
                  </span>
                  <span
                    style={{
                      display: "block",
                      marginTop: 2,
                      fontSize: 10,
                      color: "var(--muted)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.repository} · {item.kind === "issue" ? "Issue" : "PR"}{" "}
                    #{summary.number}
                    {item.link?.matchCount === 1
                      ? ` · ${item.link.workspaceName}`
                      : item.link && item.link.matchCount > 1
                        ? ` · ${item.link.matchCount} matches`
                        : ""}
                    {item.kind === "pull-request"
                      ? ` · ${queuePullRequestStatus(item.pullRequest)}`
                      : ""}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--accent-text)",
                    fontWeight: 650,
                    whiteSpace: "nowrap",
                  }}
                >
                  {busyKey === item.key ? busyLabel(item) : action}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {ready && items.length > 18 && (
        <QueueMessage>
          Showing 18 of {items.length}. Refresh after finishing an item.
        </QueueMessage>
      )}
      {ready && partial && (
        <QueueMessage>
          Partial snapshot: {ready.errors.length} source error
          {ready.errors.length === 1 ? "" : "s"}
          {ready.truncated.errorsOmitted > 0
            ? `, ${ready.truncated.errorsOmitted} additional error(s) omitted`
            : ""}
          {ready.truncated.itemsOmitted > 0
            ? `, ${ready.truncated.itemsOmitted} item(s) omitted`
            : ""}
          .
        </QueueMessage>
      )}
      {selectedPullRequest ? (
        <PullRequestDetailsDialog
          cwd={cwd}
          item={selectedPullRequest}
          busy={busyKey === selectedPullRequest.key}
          actionError={actionError}
          onClose={() => {
            if (busyKey !== selectedPullRequest.key) {
              setActionError(null);
              setSelectedPullRequest(null);
            }
          }}
          onOpenCopy={(item) => void open(item)}
          onReviewMerge={(pullRequest) => {
            setSelectedPullRequest(null);
            setActionError(null);
            onReviewMerge(selectedPullRequest.repository, pullRequest);
          }}
        />
      ) : null}
    </div>
  );
}

function PullRequestDetailsDialog({
  cwd,
  item,
  busy,
  actionError,
  onClose,
  onOpenCopy,
  onReviewMerge,
}: {
  cwd: string;
  item: Extract<GitHubWorkQueueItem, { kind: "pull-request" }>;
  busy: boolean;
  actionError: string | null;
  onClose: () => void;
  onOpenCopy: (
    item: Extract<GitHubWorkQueueItem, { kind: "pull-request" }>,
  ) => void;
  onReviewMerge: (pullRequest: GitHubPullRequestSummary) => void;
}): React.ReactElement {
  const [details, setDetails] = useState<GitHubPullRequestDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setDetails(null);
    setLoadError(null);
    setLoading(true);
    void window.spark.github
      .pullRequestDetails(cwd, item.pullRequest.number)
      .then((next) => {
        if (generation.current === current) setDetails(next);
      })
      .catch(() => {
        if (generation.current === current) {
          setLoadError(
            "The full review could not be loaded. The latest queue summary is still shown below.",
          );
        }
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      generation.current += 1;
    };
  }, [cwd, item.key, item.pullRequest.number]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const pullRequest = details?.pullRequest ?? item.pullRequest;
  const actionableItem = details
    ? { ...item, pullRequest: details.pullRequest }
    : item;
  const mergeBlockReason = pullRequestMergeBlockReason(pullRequest);
  const stateLabel = pullRequest.isDraft ? "Draft" : "Open";
  const workspaceAction = item.link?.run
    ? "Open Cora review"
    : item.link?.matchCount === 1
      ? "Open review workspace"
      : "Create review copy";
  const canOpenCopy = Boolean(
    item.link || isExactGitObjectId(pullRequest.headCommitOid),
  );

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "rgba(4, 5, 10, 0.72)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Review pull request ${pullRequest.number}`}
        style={{
          width: "min(680px, calc(100vw - 48px))",
          maxHeight: "calc(100vh - 48px)",
          overflowY: "auto",
          borderRadius: 12,
          border: "1px solid var(--rule-strong)",
          background: "var(--panel)",
          boxShadow: "0 24px 80px rgba(0, 0, 0, 0.5)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "17px 18px 14px",
            borderBottom: "1px solid var(--rule-soft)",
            background: "var(--panel)",
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                marginBottom: 6,
                color: "var(--muted)",
                fontSize: 10.5,
              }}
            >
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: 999,
                  background: pullRequest.isDraft
                    ? "var(--hover)"
                    : "color-mix(in srgb, var(--ok) 14%, transparent)",
                  color: pullRequest.isDraft ? "var(--muted)" : "var(--ok)",
                  fontWeight: 750,
                }}
              >
                {stateLabel}
              </span>
              <span>{item.repository}</span>
              <span style={{ fontFamily: "var(--font-mono)" }}>
                #{pullRequest.number}
              </span>
            </div>
            <div
              style={{
                color: "var(--ink)",
                fontSize: 15,
                fontWeight: 720,
                lineHeight: 1.35,
              }}
            >
              {pullRequest.title}
            </div>
            <div
              style={{
                marginTop: 6,
                color: "var(--muted)",
                fontSize: 10.5,
                lineHeight: 1.4,
              }}
            >
              {details?.author ? `Opened by @${details.author} · ` : ""}
              <code>{pullRequest.headBranch}</code> into{" "}
              <code>{pullRequest.baseBranch}</code>
              {pullRequest.updatedAt
                ? ` · updated ${formatRelativeTime(pullRequest.updatedAt)}`
                : ""}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close pull request review"
            title="Close"
            disabled={busy}
            onClick={onClose}
            style={{
              appearance: "none",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--rule-soft)",
              background: "transparent",
              color: "var(--muted)",
              fontSize: 17,
              lineHeight: 1,
              opacity: busy ? 0.5 : 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "grid", gap: 14, padding: 18 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 8,
            }}
          >
            <ReviewSignal
              label="Checks"
              value={checkSummaryLabel(pullRequest)}
              tone={
                pullRequest.checks.failed > 0
                  ? "danger"
                  : pullRequest.checks.pending > 0
                    ? "warn"
                    : pullRequest.checks.total > 0
                      ? "ok"
                      : "muted"
              }
            />
            <ReviewSignal
              label="Review"
              value={reviewDecisionLabel(pullRequest.reviewDecision)}
              tone={
                pullRequest.reviewDecision === "APPROVED"
                  ? "ok"
                  : pullRequest.reviewDecision === "CHANGES_REQUESTED"
                    ? "danger"
                    : "muted"
              }
            />
            <ReviewSignal
              label="Merge"
              value={mergeBlockReason ?? "Ready to merge"}
              tone={mergeBlockReason ? "warn" : "ok"}
            />
          </div>

          {loading ? (
            <div
              aria-live="polite"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                color: "var(--muted)",
                fontSize: 11,
              }}
            >
              <Spinner size={11} /> Loading description and changed files…
            </div>
          ) : null}
          {loadError ? (
            <div
              role="alert"
              style={{
                padding: "8px 10px",
                borderRadius: 7,
                border: "1px solid color-mix(in srgb, var(--warn) 35%, transparent)",
                background: "color-mix(in srgb, var(--warn) 8%, transparent)",
                color: "var(--ink-dim)",
                fontSize: 10.5,
                lineHeight: 1.45,
              }}
            >
              {loadError}
            </div>
          ) : null}

          {details ? (
            <>
              <ReviewSection title="Description">
                <div
                  style={{
                    color: details.body ? "var(--ink-dim)" : "var(--muted-2)",
                    fontSize: 11,
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {details.body || "No description was provided."}
                  {details.bodyTruncated ? "\n\nDescription shortened in Codara." : ""}
                </div>
                {details.labels.length > 0 ? (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: 5,
                      marginTop: 10,
                    }}
                  >
                    {details.labels.map((label) => (
                      <span
                        key={label}
                        style={{
                          padding: "2px 6px",
                          borderRadius: 999,
                          border: "1px solid var(--rule-soft)",
                          color: "var(--muted)",
                          fontSize: 9.5,
                        }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </ReviewSection>

              <ReviewSection
                title={`${details.changedFiles} changed ${details.changedFiles === 1 ? "file" : "files"}`}
                aside={
                  <span style={{ fontFamily: "var(--font-mono)" }}>
                    <span style={{ color: "var(--ok)" }}>+{details.additions}</span>{" "}
                    <span style={{ color: "var(--danger)" }}>−{details.deletions}</span>
                  </span>
                }
              >
                {details.files.length > 0 ? (
                  <div
                    style={{
                      border: "1px solid var(--rule-soft)",
                      borderRadius: 7,
                      overflow: "hidden",
                    }}
                  >
                    {details.files.map((file, index) => (
                      <div
                        key={`${file.path}:${index}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "minmax(0, 1fr) auto",
                          gap: 9,
                          padding: "6px 8px",
                          borderTop:
                            index > 0 ? "1px solid var(--rule-soft)" : undefined,
                          background: "var(--panel-2)",
                          fontSize: 10.5,
                        }}
                      >
                        <span
                          title={file.path}
                          style={{
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--ink-dim)",
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          {file.path}
                        </span>
                        <span style={{ fontFamily: "var(--font-mono)" }}>
                          <span style={{ color: "var(--ok)" }}>+{file.additions}</span>{" "}
                          <span style={{ color: "var(--danger)" }}>−{file.deletions}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ color: "var(--muted-2)", fontSize: 10.5 }}>
                    GitHub did not return a file list.
                  </div>
                )}
                {details.filesTruncated ? (
                  <div style={{ marginTop: 7, color: "var(--muted-2)", fontSize: 10 }}>
                    Showing the first {details.files.length} files. Open on GitHub for the complete diff.
                  </div>
                ) : null}
              </ReviewSection>
            </>
          ) : null}

          {actionError ? (
            <div
              role="alert"
              style={{
                padding: "9px 10px",
                borderRadius: 7,
                border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
                background: "color-mix(in srgb, var(--danger) 9%, transparent)",
                color: "var(--danger)",
                fontSize: 10.5,
                lineHeight: 1.5,
              }}
            >
              {actionError}
              <div style={{ marginTop: 3, color: "var(--muted)" }}>
                You can still inspect this PR here or open it on GitHub.
              </div>
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 8,
              paddingTop: 2,
            }}
          >
            <div
              style={{
                flex: 1,
                color: "var(--muted-2)",
                fontSize: 10,
                lineHeight: 1.4,
              }}
            >
              A review copy is an isolated local worktree. You and your agents can inspect and test it without changing your current branch.
            </div>
            <DialogAction
              label="Open on GitHub"
              disabled={busy}
              onClick={() => void window.spark.openExternal(pullRequest.url)}
            />
            {!mergeBlockReason ? (
              <DialogAction
                label="Review merge"
                disabled={busy}
                onClick={() => onReviewMerge(pullRequest)}
              />
            ) : null}
            <DialogAction
              primary
              label={busy ? "Preparing copy…" : workspaceAction}
              disabled={busy || !canOpenCopy}
              onClick={() => onOpenCopy(actionableItem)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewSignal({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "danger" | "muted";
}): React.ReactElement {
  const color =
    tone === "ok"
      ? "var(--ok)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "danger"
          ? "var(--danger)"
          : "var(--muted)";
  return (
    <div
      style={{
        minWidth: 0,
        padding: "8px 9px",
        borderRadius: 7,
        border: "1px solid var(--rule-soft)",
        background: "var(--panel-2)",
      }}
    >
      <div className="spark-eyebrow" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div
        title={value}
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          color,
          fontSize: 10.5,
          fontWeight: 650,
          lineHeight: 1.35,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ReviewSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 7,
          color: "var(--ink-dim)",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        <span>{title}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--muted)", fontSize: 10 }}>{aside}</span>
      </div>
      {children}
    </section>
  );
}

function DialogAction({
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
        flex: "0 0 auto",
        padding: "7px 10px",
        borderRadius: 7,
        border: `1px solid ${primary ? "var(--accent-edge)" : "var(--rule-strong)"}`,
        background: primary ? "var(--accent-soft)" : "transparent",
        color: primary ? "var(--accent-text)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 10.5,
        fontWeight: 680,
        opacity: disabled ? 0.5 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function checkSummaryLabel(pullRequest: GitHubPullRequestSummary): string {
  const checks = pullRequest.checks;
  if (checks.total === 0) return "No checks";
  if (checks.failed > 0) return `${checks.failed} failed`;
  if (checks.pending > 0) return `${checks.pending} pending`;
  return `${checks.successful} passed`;
}

function reviewDecisionLabel(value: string | undefined): string {
  if (value === "APPROVED") return "Approved";
  if (value === "CHANGES_REQUESTED") return "Changes requested";
  if (value === "REVIEW_REQUIRED") return "Review required";
  return "No review required";
}

function pullRequestMergeBlockReason(
  pullRequest: GitHubPullRequestSummary,
): string | null {
  if (pullRequest.state !== "OPEN") return "Not open";
  if (pullRequest.isDraft) return "Still a draft";
  if (!pullRequest.headCommitOid) return "Revision unavailable";
  if (pullRequest.checks.failed > 0) return "Checks failing";
  if (pullRequest.checks.pending > 0) return "Checks running";
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  if (pullRequest.reviewDecision === "REVIEW_REQUIRED") return "Approval required";
  if (
    pullRequest.mergeStateStatus !== "CLEAN" &&
    pullRequest.mergeStateStatus !== "HAS_HOOKS"
  ) {
    return pullRequest.mergeStateStatus
      ? pullRequest.mergeStateStatus.replace(/_/gu, " ").toLowerCase()
      : "Mergeability unknown";
  }
  return null;
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function actionLabel(item: GitHubWorkQueueItem): string {
  if (item.kind === "pull-request") return "Review";
  if (item.link?.run) {
    return isStalePinnedPullRequest(item) ? "Open pinned run" : "Open run";
  }
  if (item.link?.matchCount === 1) {
    return isStalePinnedPullRequest(item)
      ? "Open pinned worktree"
      : "Open worktree";
  }
  if (item.kind === "issue" && !item.link) return "Start worktree";
  return "View";
}

function actionDescription(item: GitHubWorkQueueItem): string {
  if (item.kind === "pull-request") {
    return "Inspect the description, changed files, checks and merge readiness.";
  }
  if (item.link?.run) return "Open the Cora run already linked to this GitHub item.";
  if (item.link?.matchCount === 1) {
    return "Switch to the existing isolated worktree for this GitHub item.";
  }
  if (item.kind === "issue" && !item.link) {
    return "Create an isolated worktree and linked Cora run for this issue.";
  }
  return "Open this item on GitHub.";
}

function queuePullRequestStatus(pullRequest: GitHubPullRequestSummary): string {
  if (pullRequest.isDraft) return "draft";
  if (pullRequest.checks.failed > 0) return `${pullRequest.checks.failed} failing`;
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (pullRequest.checks.pending > 0) return `${pullRequest.checks.pending} pending`;
  if (pullRequest.reviewDecision === "APPROVED") return "approved";
  if (pullRequest.checks.total > 0) return `${pullRequest.checks.successful} passed`;
  return "open";
}

function busyLabel(item: GitHubWorkQueueItem): string {
  if (!item.link && item.kind === "issue") return "Starting…";
  if (
    !item.link &&
    item.kind === "pull-request" &&
    isExactGitObjectId(item.pullRequest.headCommitOid)
  ) {
    return "Starting PR…";
  }
  return "Opening…";
}

function isExactGitObjectId(value: string | undefined): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value?.trim() ?? "");
}

function isStalePinnedPullRequest(item: GitHubWorkQueueItem): boolean {
  if (
    item.kind !== "pull-request" ||
    item.link?.origin?.kind !== "github-pull-request"
  ) {
    return false;
  }
  const currentHead = item.pullRequest.headCommitOid?.trim().toLowerCase();
  const importedHead =
    item.link.origin.importedHeadCommitOid.trim().toLowerCase();
  return (
    isExactGitObjectId(currentHead) &&
    isExactGitObjectId(importedHead) &&
    currentHead !== importedHead
  );
}

function QueueMessage({
  children,
  tone = "muted",
  alert = false,
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
  alert?: boolean;
}): React.ReactElement {
  return (
    <div
      role={alert ? "alert" : undefined}
      aria-live={alert ? "polite" : undefined}
      style={{
        padding: "2px 0",
        fontSize: 10.5,
        lineHeight: 1.45,
        color: tone === "error" ? "var(--danger)" : "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitHubWorkQueueItem,
  GitHubWorkQueueStatus,
} from "@shared/github";

interface Props {
  sourceWorkspaceId: string;
  refreshKey: number;
  onOpenItem: (item: GitHubWorkQueueItem) => Promise<void>;
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
  sourceWorkspaceId,
  refreshKey,
  onOpenItem,
  omitPullRequest,
  onSummary,
}: Props): React.ReactElement {
  const [status, setStatus] = useState<GitHubWorkQueueStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
      {actionError && (
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
                onClick={() => void open(item)}
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
    </div>
  );
}

function actionLabel(item: GitHubWorkQueueItem): string {
  if (item.link?.run) {
    return isStalePinnedPullRequest(item) ? "Open pinned run" : "Open run";
  }
  if (item.link?.matchCount === 1) {
    return isStalePinnedPullRequest(item)
      ? "Open pinned worktree"
      : "Open worktree";
  }
  if (item.kind === "issue" && !item.link) return "Start worktree";
  if (
    item.kind === "pull-request" &&
    !item.link &&
    isExactGitObjectId(item.pullRequest.headCommitOid)
  ) {
    return "Import PR";
  }
  return "View";
}

function actionDescription(item: GitHubWorkQueueItem): string {
  if (item.link?.run) return "Open the Cora run already linked to this GitHub item.";
  if (item.link?.matchCount === 1) {
    return "Switch to the existing isolated worktree for this GitHub item.";
  }
  if (item.kind === "issue" && !item.link) {
    return "Create an isolated worktree and linked Cora run for this issue.";
  }
  if (
    item.kind === "pull-request" &&
    !item.link &&
    isExactGitObjectId(item.pullRequest.headCommitOid)
  ) {
    return "Import the exact pull-request revision into an isolated worktree and linked Cora run.";
  }
  return "Open this item on GitHub.";
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

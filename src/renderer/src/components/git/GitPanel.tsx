import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GitDiffStats,
  GitFileChange,
  GitOpResult,
  GitStatus,
  Workspace,
} from "@shared/types";
import type { GitHubWorkQueueItem } from "@shared/github";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import ChangeTree from "./ChangeTree";
import ChangeSection from "./ChangeSection";
import BranchMenu from "./BranchMenu";
import CommitComposer from "./CommitComposer";
import CommitDetail from "./CommitDetail";
import SplitCommitsDialog from "./SplitCommitsDialog";
import CommitHistory from "./CommitHistory";
import GitHubSection from "./GitHubSection";
import StashSection from "./StashSection";
import type { SharedGitStatus } from "../../git/useSharedGitStatus";
import {
  CommitIcon,
  IconButton,
  InitRepoIcon,
  MinusGlyph,
  PlusGlyph,
  RefreshIcon,
  Spinner,
  UndoIcon,
} from "./git-ui";

// How long the scroll restore keeps re-applying itself while the list above
// History finishes loading. Long enough for a local git read, short enough that
// it can never feel like the panel is scrolling on its own.
const RESTORE_SETTLE_MS = 1_000;

interface Props {
  cwd: string | null;
  workspace: Workspace | null;
  /** Panel-level collapse, driven by the rail's section layout. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  headerDrag?: SectionHeaderDragProps;
  onOpenGitHubQueueItem: (item: GitHubWorkQueueItem) => Promise<void>;
  /** Shared status/log poll owned by App (one per active workspace). */
  git: SharedGitStatus;
  /** Opens a changed file's diff as a workbench tab (VS Code-style). */
  onOpenDiffTab: (file: GitFileChange, options?: { pin?: boolean }) => void;
  /** Opens a file's diff within a commit as a workbench tab (history rows). */
  onOpenCommitDiffTab: (path: string, hash: string, options?: { pin?: boolean }) => void;
  /** The diff tab currently focused, if any — highlights its ChangeRow. */
  activeDiffTarget: { path: string; staged: boolean } | null;
}

// The left-rail Source Control panel — branch + commit composer, staged /
// working change lists, and the commit-graph history, over the git backend in
// src/main/git-ops.ts. Slots into the rail's collapsible section layout.
export default function GitPanel({
  cwd,
  workspace,
  collapsed,
  onToggleCollapse,
  headerDrag,
  onOpenGitHubQueueItem,
  git,
  onOpenDiffTab,
  onOpenCommitDiffTab,
  activeDiffTarget,
}: Props): React.ReactElement {
  // Status/log/loading/gitVersion live in the App-owned shared hook
  // (useSharedGitStatus) so the explorer decorations and diff tabs read the
  // same snapshot this panel does. Everything below is panel-local UI state.
  const { status, log, loading, gitVersion, refresh, notifyChanged, readError } = git;
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sections, setSections] = useState({ staged: false, changes: false, history: false });
  const [githubRefreshNonce, setGitHubRefreshNonce] = useState(0);
  // A commit selected for inspection — when set, the body shows CommitDetail
  // (the history/inspection agent builds that view).
  const [detailHash, setDetailHash] = useState<string | null>(null);
  // "Split into commits" review dialog.
  const [splitOpen, setSplitOpen] = useState(false);
  // Per-file +added/−removed counts (Hermes-style). Re-read whenever the
  // shared status version bumps; a fetch failure just leaves rows without
  // numbers, so errors are swallowed.
  const [diffStats, setDiffStats] = useState<GitDiffStats | null>(null);
  // The commit the detail pane was showing when it closed. Its history row
  // flashes briefly so the eye re-anchors on return.
  const [returnHighlightHash, setReturnHighlightHash] = useState<string | null>(null);

  // Refs let action guards read live values without going stale.
  const busyRef = useRef<string | null>(busy);
  busyRef.current = busy;
  const statusRef = useRef<GitStatus | null>(status);
  statusRef.current = status;
  // The panel body's scroll position, parked while the detail pane is open.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const savedScrollRef = useRef<number | null>(null);

  // Reset panel-local state whenever the workspace changes.
  useEffect(() => {
    setOpError(null);
    setDetailHash(null);
    setReturnHighlightHash(null);
    savedScrollRef.current = null;
    setMessage("");
    setDiffStats(null);
    setSections({ staged: false, changes: false, history: false });
  }, [cwd]);

  // Per-file counts follow the shared status poll: every gitVersion bump
  // re-reads the cached numstat (same 2s TTL as status, so this coalesces
  // with the panel's normal polling instead of adding git traffic).
  useEffect(() => {
    if (!cwd || !status?.isRepo) {
      setDiffStats(null);
      return;
    }
    let cancelled = false;
    void window.spark.git.diffStats(cwd).then(
      (stats) => {
        if (!cancelled) setDiffStats(stats);
      },
      () => {
        /* decoration only — keep the previous stats on a failed read */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd, status?.isRepo, gitVersion]);

  // Run one git mutation: block re-entrancy, surface failures, refresh after.
  const runAction = useCallback(
    async (id: string, fn: () => Promise<GitOpResult>): Promise<void> => {
      if (busyRef.current) return;
      setBusy(id);
      setOpError(null);
      try {
        const result = await fn();
        if (!result.ok) setOpError(result.error);
      } catch (err) {
        setOpError((err as Error).message);
      } finally {
        setBusy(null);
        notifyChanged();
      }
    },
    [notifyChanged],
  );

  // Passed to the branch / stash sections so a mutation they perform refreshes
  // the whole panel (and bumps the version the other sections re-read on).
  const handleGitChanged = notifyChanged;

  const stageOne = useCallback(
    (file: GitFileChange) => {
      if (cwd) void runAction("stage", () => window.spark.git.stage(cwd, [file.path]));
    },
    [cwd, runAction],
  );
  const unstageOne = useCallback(
    (file: GitFileChange) => {
      if (cwd) void runAction("unstage", () => window.spark.git.unstage(cwd, [file.path]));
    },
    [cwd, runAction],
  );
  const discardOne = useCallback(
    (file: GitFileChange) => {
      if (cwd) void runAction("discard", () => window.spark.git.discard(cwd, [file]));
    },
    [cwd, runAction],
  );
  const stageAll = useCallback(() => {
    if (cwd) void runAction("stageAll", () => window.spark.git.stageAll(cwd));
  }, [cwd, runAction]);
  // Discard every working-tree change in one shot. The file list is read from
  // the live status ref rather than the render-time snapshot so a poll landing
  // between the hover and the click cannot make this act on stale paths.
  const discardAll = useCallback(() => {
    if (!cwd) return;
    void runAction("discardAll", () => {
      const files = statusRef.current?.unstaged ?? [];
      if (files.length === 0) return Promise.resolve<GitOpResult>({ ok: true });
      return window.spark.git.discard(cwd, files);
    });
  }, [cwd, runAction]);
  const unstageAll = useCallback(() => {
    if (cwd) void runAction("unstageAll", () => window.spark.git.unstageAll(cwd));
  }, [cwd, runAction]);
  // Push is the one action in this panel that changes what GitHub reports for
  // the branch — a new head commit, and with it the pull request's checks and
  // merge state. It therefore bumps the GitHub block's own key, exactly as
  // publish and merge do, so the next status read is loud and bypasses the
  // main-process cache. The generic `notifyChanged()` in `runAction` cannot
  // carry that signal: it also fires on every editor save, and reacting to it
  // per save is the `gh` subprocess storm this panel was fixed to stop.
  // Bumped after the action settles, success or not — a failed push can still
  // have reached the remote.
  const handlePush = useCallback(() => {
    if (!cwd) return;
    void runAction("push", () => window.spark.git.push(cwd)).then(() =>
      setGitHubRefreshNonce((value) => value + 1),
    );
  }, [cwd, runAction]);
  const handlePull = useCallback(() => {
    if (cwd) void runAction("pull", () => window.spark.git.pull(cwd));
  }, [cwd, runAction]);
  const handleFetch = useCallback(() => {
    if (cwd) void runAction("fetch", () => window.spark.git.fetch(cwd));
  }, [cwd, runAction]);
  const handleInit = useCallback(() => {
    if (cwd) void runAction("init", () => window.spark.git.init(cwd));
  }, [cwd, runAction]);
  const handleRefresh = useCallback(() => {
    setGitHubRefreshNonce((value) => value + 1);
    void refresh(false);
  }, [refresh]);

  // History actions can move HEAD or the working tree. Open diff tabs derive
  // their state from the shared status, so they refresh (or show "no
  // changes") on the version bump — no explicit teardown needed here.
  const handleCheckout = useCallback(
    (ref: string) => {
      if (!cwd) return;
      void runAction("checkout", () => window.spark.git.checkout(cwd, ref));
    },
    [cwd, runAction],
  );
  const handleRevert = useCallback(
    (hash: string) => {
      if (!cwd) return;
      void runAction("revert", () => window.spark.git.revert(cwd, hash));
    },
    [cwd, runAction],
  );
  const handleUndoLastCommit = useCallback(() => {
    if (!cwd) return;
    void runAction("undo", () => window.spark.git.undoLastCommit(cwd));
  }, [cwd, runAction]);

  const handleGenerateMessage = useCallback(async (): Promise<void> => {
    if (!cwd || busyRef.current) return;
    setBusy("generateMessage");
    setOpError(null);
    try {
      const result = await window.spark.git.generateCommitMessage(cwd);
      if (result.ok) setMessage(result.message);
      else setOpError(result.error);
    } catch (err) {
      setOpError((err as Error).message);
    } finally {
      setBusy(null);
      void refresh(true);
    }
  }, [cwd, refresh]);

  // Commit. For a normal commit with nothing staged, stage everything first so
  // the button doubles as "Commit All" (matching VS Code). For an amend, never
  // auto-stage — amend rewrites the last commit with exactly what's staged (or
  // a pure reword when nothing is staged).
  const handleCommit = useCallback(
    async (amend: boolean): Promise<void> => {
      if (!cwd || busyRef.current) return;
      const text = message.trim();
      if (!text) return;
      const nothingStaged = (statusRef.current?.staged.length ?? 0) === 0;
      setBusy("commit");
      setOpError(null);
      try {
        if (!amend && nothingStaged) {
          const staged = await window.spark.git.stageAll(cwd);
          if (!staged.ok) {
            setOpError(staged.error);
            return;
          }
        }
        const result = await window.spark.git.commit(cwd, text, amend);
        if (result.ok) setMessage("");
        else setOpError(result.error);
      } catch (err) {
        setOpError((err as Error).message);
      } finally {
        setBusy(null);
        notifyChanged();
      }
    },
    [cwd, message, notifyChanged],
  );

  // Clicking a changed row opens (or focuses) its diff as a preview tab;
  // double-clicking pins it so the next row click opens a fresh tab.
  const openDiff = useCallback(
    (file: GitFileChange) => {
      setDetailHash(null);
      onOpenDiffTab(file);
    },
    [onOpenDiffTab],
  );
  const pinDiff = useCallback(
    (file: GitFileChange) => {
      setDetailHash(null);
      onOpenDiffTab(file, { pin: true });
    },
    [onOpenDiffTab],
  );

  // Open a commit in the inspection view (built by the history/inspection
  // agent). The list keeps its scroll position for the trip back — hiding it
  // takes it out of layout, which zeroes scrollTop, so it has to be read
  // before the state change.
  const openCommitDetail = useCallback((hash: string) => {
    savedScrollRef.current = bodyRef.current?.scrollTop ?? null;
    setReturnHighlightHash(null);
    setDetailHash(hash);
  }, []);

  const closeCommitDetail = useCallback(() => {
    setReturnHighlightHash(detailHash);
    setDetailHash(null);
  }, [detailHash]);

  // Back to the list: put the scroll exactly where it was, then make sure the
  // commit the user ended on is actually on screen — after stepping through
  // prev/next it may be nowhere near the saved position, and seeing it beats
  // honouring a stale scrollTop.
  //
  // One pass is not enough. The sections above History (branch, GitHub, stash)
  // finish loading on their own schedule, so at the moment of the restore the
  // list can still be short enough to clamp the saved offset. The restore
  // re-applies as the list resizes until the anchor row is genuinely in view,
  // then stops — bounded by a deadline so it can never keep fighting the user,
  // and abandoned outright the moment the user scrolls for themselves.
  useLayoutEffect(() => {
    if (detailHash !== null) return;
    const body = bodyRef.current;
    const list = listRef.current;
    const saved = savedScrollRef.current;
    if (!body || saved === null) return;
    savedScrollRef.current = null;
    const anchorHash = returnHighlightHash;
    // Once the anchor row has had to pull the viewport off the saved offset,
    // the saved offset stops being re-applied — otherwise the two fight.
    let anchored = false;

    const apply = (): boolean => {
      if (!anchored) body.scrollTop = saved;
      // scrollTop is fractional on HiDPI, and a clamped restore lands short —
      // sub-pixel is landed, anything more means the list is still growing.
      const restored = Math.abs(body.scrollTop - saved) < 1;
      const row = anchorHash
        ? body.querySelector<HTMLElement>(`[data-commit-hash="${CSS.escape(anchorHash)}"]`)
        : null;
      // No row to anchor on (no highlight, history collapsed, log still
      // loading) — the saved offset landing exactly is all we can ask for.
      if (!row) return restored;
      const bodyBox = body.getBoundingClientRect();
      let rowBox = row.getBoundingClientRect();
      if (rowBox.top < bodyBox.top || rowBox.bottom > bodyBox.bottom) {
        row.scrollIntoView({ block: "nearest" });
        anchored = true;
        rowBox = row.getBoundingClientRect();
      }
      return rowBox.top >= bodyBox.top && rowBox.bottom <= bodyBox.bottom;
    };

    let observer: ResizeObserver | null = null;
    let timer = 0;
    const finish = (): void => {
      observer?.disconnect();
      observer = null;
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      body.removeEventListener("wheel", finish);
      body.removeEventListener("pointerdown", finish);
    };

    if (apply() || !list) return;
    // The scroll container's own box never changes, so the content wrapper is
    // what has to be watched for the sections above History settling.
    observer = new ResizeObserver(() => {
      if (apply()) finish();
    });
    observer.observe(list);
    timer = window.setTimeout(finish, RESTORE_SETTLE_MS);
    body.addEventListener("wheel", finish, { passive: true });
    body.addEventListener("pointerdown", finish);
    return finish;
  }, [detailHash, returnHighlightHash]);

  // The flash is a one-shot cue, not a selection — let it go once it has faded.
  useEffect(() => {
    if (!returnHighlightHash) return;
    const timer = window.setTimeout(() => setReturnHighlightHash(null), 1200);
    return () => window.clearTimeout(timer);
  }, [returnHighlightHash]);

  // History is newest-first, so the previous row is the newer commit.
  const commitHashes = useMemo(
    () => (log?.rows ?? []).map((row) => row.hash).filter((hash): hash is string => Boolean(hash)),
    [log],
  );
  const detailIndex = detailHash ? commitHashes.indexOf(detailHash) : -1;
  const showNewerCommit =
    detailIndex > 0 ? () => setDetailHash(commitHashes[detailIndex - 1]) : null;
  const showOlderCommit =
    detailIndex >= 0 && detailIndex < commitHashes.length - 1
      ? () => setDetailHash(commitHashes[detailIndex + 1])
      : null;

  const disabled = busy !== null;
  const displayError = opError ?? status?.error ?? log?.error ?? readError ?? null;
  const staged = status?.staged ?? [];
  const unstaged = status?.unstaged ?? [];
  const stagedCount = staged.length;
  const unstagedCount = unstaged.length;
  const changeCount = stagedCount + unstagedCount;
  const canCommit = message.trim().length > 0 && changeCount > 0;
  const canGenerateMessage = changeCount > 0;
  const commitLabel = stagedCount === 0 && unstagedCount > 0 ? "Commit All" : "Commit";

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <SectionHeader
        label="Source Control"
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        {...headerDrag}
        count={changeCount > 0 ? changeCount : undefined}
        meta={
          loading || busy ? (
            <span style={{ display: "inline-flex", paddingLeft: 2 }}>
              <Spinner size={11} />
            </span>
          ) : undefined
        }
        actions={
          <IconButton
            title="Refresh"
            onClick={handleRefresh}
            disabled={disabled}
            size={22}
          >
            <RefreshIcon />
          </IconButton>
        }
      />

      {!collapsed && (
        <div
          ref={bodyRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: detailHash ? "hidden" : "auto",
            overflowX: "hidden",
          }}
        >
          {!cwd ? (
            <PanelMessage text="No active workspace." />
          ) : (
            <>
              {detailHash && (
                <CommitDetail
                  cwd={cwd}
                  hash={detailHash}
                  onClose={closeCommitDetail}
                  onNewer={showNewerCommit}
                  onOlder={showOlderCommit}
                  onOpenFileDiff={onOpenCommitDiffTab}
                />
              )}
              {/* The list is hidden, never unmounted, while a commit is open.
                  Unmounting it would tear down the GitHub block and the work
                  queue on every inspection, so each trip back would re-run
                  `gh` and flash the spinner — the same reason the GitHub
                  section hides its own queue rather than dropping it. */}
              <div ref={listRef} style={{ display: detailHash ? "none" : "block" }}>
                {status === null ? (
                  <PanelMessage text="" />
                ) : !status.isRepo ? (
                  <NonRepoState busy={disabled} onInit={handleInit} />
                ) : (
                  <>
                    <BranchMenu
                      cwd={cwd}
                      onChanged={handleGitChanged}
                      refreshKey={gitVersion}
                      disabled={disabled}
                    />
                    <GitHubSection
                      cwd={cwd}
                      gitStatus={status}
                      refreshKey={gitVersion}
                      userRefreshKey={githubRefreshNonce}
                      queue={
                        workspace && !workspace.remote
                          ? {
                              sourceWorkspaceId: workspace.id,
                              refreshKey: githubRefreshNonce,
                              onOpenItem: onOpenGitHubQueueItem,
                            }
                          : null
                      }
                      onRefresh={() => setGitHubRefreshNonce((value) => value + 1)}
                      onPublished={() => {
                        setGitHubRefreshNonce((value) => value + 1);
                        notifyChanged();
                      }}
                      composer={
                        <>
                          {displayError && (
                            <ErrorStrip text={displayError} onDismiss={() => setOpError(null)} />
                          )}
                          <CommitComposer
                            message={message}
                            onMessageChange={setMessage}
                            onCommit={(amend) => void handleCommit(amend)}
                            onGenerateMessage={() => void handleGenerateMessage()}
                            canCommit={canCommit}
                            canGenerateMessage={canGenerateMessage}
                            commitLabel={commitLabel}
                            stagedCount={stagedCount}
                            busy={busy}
                            branch={status.branch}
                            detached={status.detached}
                            upstream={status.upstream}
                            ahead={status.ahead}
                            behind={status.behind}
                            onPush={handlePush}
                            onPull={handlePull}
                            onFetch={handleFetch}
                            onSplit={() => setSplitOpen(true)}
                            canSplit={
                              status.staged.length + status.unstaged.length >= 2 &&
                              !status.hasConflicts
                            }
                          />
                        </>
                      }
                    />

                    {stagedCount > 0 && (
                      <ChangeSection
                        title="Staged Changes"
                        count={stagedCount}
                        collapsed={sections.staged}
                        onToggle={() => setSections((s) => ({ ...s, staged: !s.staged }))}
                        disabled={disabled}
                        actions={[
                          {
                            key: "unstage-all",
                            title: "Unstage all changes",
                            icon: <MinusGlyph />,
                            onClick: unstageAll,
                          },
                        ]}
                      >
                        <ChangeTree
                          files={staged}
                          staged
                          disabled={disabled}
                          stats={diffStats?.staged}
                          selectedPath={
                            activeDiffTarget?.staged === true ? activeDiffTarget.path : null
                          }
                          onOpenDiff={openDiff}
                          onPinDiff={pinDiff}
                          onStage={stageOne}
                          onUnstage={unstageOne}
                          onDiscard={discardOne}
                        />
                      </ChangeSection>
                    )}

                    {unstagedCount > 0 && (
                      <ChangeSection
                        title="Changes"
                        count={unstagedCount}
                        collapsed={sections.changes}
                        onToggle={() => setSections((s) => ({ ...s, changes: !s.changes }))}
                        disabled={disabled}
                        actions={[
                          {
                            key: "discard-all",
                            title: "Discard all changes",
                            icon: <UndoIcon />,
                            onClick: discardAll,
                            danger: true,
                          },
                          {
                            key: "stage-all",
                            title: "Stage all changes",
                            icon: <PlusGlyph />,
                            onClick: stageAll,
                          },
                        ]}
                      >
                        <ChangeTree
                          files={unstaged}
                          staged={false}
                          disabled={disabled}
                          stats={diffStats?.unstaged}
                          selectedPath={
                            activeDiffTarget?.staged === false ? activeDiffTarget.path : null
                          }
                          onOpenDiff={openDiff}
                          onPinDiff={pinDiff}
                          onStage={stageOne}
                          onUnstage={unstageOne}
                          onDiscard={discardOne}
                        />
                      </ChangeSection>
                    )}

                    {changeCount === 0 && <CleanState />}

                    <StashSection
                      cwd={cwd}
                      onChanged={handleGitChanged}
                      refreshKey={gitVersion}
                      disabled={disabled}
                    />

                    <CommitHistory
                      cwd={cwd}
                      rows={log?.rows ?? []}
                      loading={loading && !log}
                      collapsed={sections.history}
                      onToggle={() => setSections((s) => ({ ...s, history: !s.history }))}
                      disabled={disabled}
                      onCheckout={handleCheckout}
                      onRevert={handleRevert}
                      onUndoLastCommit={handleUndoLastCommit}
                      onOpenCommit={openCommitDetail}
                      highlightHash={returnHighlightHash}
                    />
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {splitOpen && cwd ? (
        <SplitCommitsDialog
          cwd={cwd}
          onClose={() => setSplitOpen(false)}
          onDone={() => {
            // New commits exist and the working tree shrank — refresh both
            // the change lists and the history graph.
            notifyChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function PanelMessage({ text }: { text: string }): React.ReactElement {
  return (
    <div style={{ padding: "10px 14px", color: "var(--muted)", fontSize: 11 }}>{text}</div>
  );
}

// Working tree clean — a calm confirmation, not an error.
function CleanState(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "14px 14px",
        color: "var(--muted)",
        fontSize: 11,
      }}
    >
      <span style={{ color: "var(--ok)", display: "inline-flex" }}>
        <CommitIcon />
      </span>
      No changes — working tree clean.
    </div>
  );
}

// The folder is not a git repository — offer to initialize one.
function NonRepoState({
  busy,
  onInit,
}: {
  busy: boolean;
  onInit: () => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ padding: "16px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="spark-eyebrow">Source control</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-dim)" }}>
        Not a Git repository
      </div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6, lineHeight: 1.5 }}>
        This workspace is not version controlled yet.
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onInit}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          alignSelf: "flex-start",
          padding: "7px 12px",
          borderRadius: 7,
          cursor: "default",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 700,
          border: hover && !busy ? "1px solid var(--accent-edge)" : "1px solid var(--rule-strong)",
          background: hover && !busy ? "var(--accent-soft)" : "transparent",
          boxShadow: hover && !busy ? "var(--lift-hi)" : "none",
          color: busy ? "var(--muted-2)" : "var(--ink-dim)",
          opacity: busy ? 0.6 : 1,
          transition:
            "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
        }}
      >
        <InitRepoIcon />
        Initialize Repository
      </button>
    </div>
  );
}

// Dismissible inline strip for a git error (a failed op, or a status read).
function ErrorStrip({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        margin: "8px 8px 0",
        padding: "7px 9px",
        borderRadius: 7,
        border: "1px solid color-mix(in oklch, var(--danger) 42%, var(--rule-soft))",
        background: "var(--danger-soft)",
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          lineHeight: 1.5,
          color: "color-mix(in oklch, var(--danger) 80%, var(--ink))",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 96,
          overflow: "auto",
        }}
      >
        {text}
      </span>
      <button
        type="button"
        title="Dismiss"
        onClick={onDismiss}
        style={{
          appearance: "none",
          flex: "0 0 auto",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          borderRadius: 5,
          border: "none",
          background: "transparent",
          color: "var(--danger)",
          cursor: "default",
          fontSize: 12,
          lineHeight: 1,
          padding: 0,
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
      >
        ✕
      </button>
    </div>
  );
}

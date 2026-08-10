import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChatBackendKind,
  GitFileChange,
  GitOpResult,
  GitStatus,
  RunState,
  Workspace,
} from "@shared/types";
import type { GitHubWorkQueueItem } from "@shared/github";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import ChangeRow from "./ChangeRow";
import ChangeSection from "./ChangeSection";
import BranchMenu from "./BranchMenu";
import CommitComposer from "./CommitComposer";
import CommitDetail from "./CommitDetail";
import CommitHistory from "./CommitHistory";
import GitHubSection from "./GitHubSection";
import StashSection from "./StashSection";
import type { SharedGitStatus } from "../../git/useSharedGitStatus";
import { buildSmartMergePlan, requestPrepareSmartMerge, smartMergePlanTitle } from "./smart-merge";
import {
  CommitIcon,
  IconButton,
  InitRepoIcon,
  MinusGlyph,
  PlusGlyph,
  RefreshIcon,
  Spinner,
} from "./git-ui";

interface Props {
  cwd: string | null;
  workspace: Workspace | null;
  /** Panel-level collapse, driven by the rail's section layout. */
  collapsed: boolean;
  onToggleCollapse: () => void;
  headerDrag?: SectionHeaderDragProps;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  onOpenGitHubQueueItem: (item: GitHubWorkQueueItem) => Promise<void>;
  /** Shared status/log poll owned by App (one per active workspace). */
  git: SharedGitStatus;
  /** Opens a changed file's diff as a workbench tab (VS Code-style). */
  onOpenDiffTab: (file: GitFileChange) => void;
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
  onRunSnapshot,
  onOpenGitHubQueueItem,
  git,
  onOpenDiffTab,
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
  const savedScrollRef = useRef<number | null>(null);

  // Reset panel-local state whenever the workspace changes.
  useEffect(() => {
    setOpError(null);
    setDetailHash(null);
    setReturnHighlightHash(null);
    savedScrollRef.current = null;
    setMessage("");
    setSections({ staged: false, changes: false, history: false });
  }, [cwd]);

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
  const unstageAll = useCallback(() => {
    if (cwd) void runAction("unstageAll", () => window.spark.git.unstageAll(cwd));
  }, [cwd, runAction]);
  const handlePush = useCallback(() => {
    if (cwd) void runAction("push", () => window.spark.git.push(cwd));
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

  const handleSmartMerge = useCallback(
    async (backend?: ChatBackendKind): Promise<void> => {
      if (!workspace || busyRef.current) return;
      setBusy("smartMerge");
      setOpError(null);
      try {
        const result = await requestPrepareSmartMerge(workspace.cwd);
        if (!result.ok) {
          setOpError(result.error);
          return;
        }
        const run = await window.spark.orchestration.startAutopilot({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          cwd: workspace.cwd,
          planTitle: smartMergePlanTitle(result.context),
          planText: buildSmartMergePlan(result.context),
          // Hand the merge to the engine the user picked from the caret
          // (undefined is normalized to the bundled Cora · Pi manager).
          chatBackend: backend,
          initialUserNote:
            "This is a smart merge. Take a look at what's coming in from the upstream below, tell me in chat what you plan to do, and ask me if anything looks risky or ambiguous before you proceed — then carry out the merge yourself. You can run git directly. Protect my local work first (a recoverable stash is fine) and don't push, force-push, or reset --hard.",
        });
        onRunSnapshot(run, { select: true, focusRuns: true });
      } catch (err) {
        setOpError((err as Error).message);
      } finally {
        setBusy(null);
        void refresh(true);
      }
    },
    [workspace, onRunSnapshot, refresh],
  );

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

  // Clicking a changed row opens (or focuses) its diff as a workbench tab.
  const openDiff = useCallback(
    (file: GitFileChange) => {
      setDetailHash(null);
      onOpenDiffTab(file);
    },
    [onOpenDiffTab],
  );

  // Open a commit in the inspection view (built by the history/inspection
  // agent). The list keeps its scroll position for the trip back — the body
  // switches to `overflow: hidden` while the detail pane is up, which zeroes
  // scrollTop, so it has to be read before the state change.
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
  useLayoutEffect(() => {
    if (detailHash !== null) return;
    const body = bodyRef.current;
    const saved = savedScrollRef.current;
    if (!body || saved === null) return;
    savedScrollRef.current = null;
    body.scrollTop = saved;
    if (!returnHighlightHash) return;
    const row = body.querySelector<HTMLElement>(
      `[data-commit-hash="${CSS.escape(returnHighlightHash)}"]`,
    );
    if (!row) return;
    const rowBox = row.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    if (rowBox.top < bodyBox.top || rowBox.bottom > bodyBox.bottom) {
      row.scrollIntoView({ block: "nearest" });
    }
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
          ) : detailHash ? (
            <CommitDetail
              cwd={cwd}
              hash={detailHash}
              onClose={closeCommitDetail}
              onNewer={showNewerCommit}
              onOlder={showOlderCommit}
            />
          ) : status === null ? (
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
              />
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
                onSmartMerge={(backend) => void handleSmartMerge(backend)}
                canSmartMerge={Boolean(
                  workspace && status.isRepo && (status.behind > 0 || status.hasConflicts),
                )}
              />

              {stagedCount > 0 && (
                <ChangeSection
                  title="Staged Changes"
                  count={stagedCount}
                  collapsed={sections.staged}
                  onToggle={() => setSections((s) => ({ ...s, staged: !s.staged }))}
                  disabled={disabled}
                  action={{
                    title: "Unstage all changes",
                    icon: <MinusGlyph />,
                    onClick: unstageAll,
                  }}
                >
                  {staged.map((file) => (
                    <ChangeRow
                      key={`s:${file.path}`}
                      file={file}
                      staged
                      selected={activeDiffTarget?.staged === true && activeDiffTarget.path === file.path}
                      disabled={disabled}
                      onOpenDiff={openDiff}
                      onStage={stageOne}
                      onUnstage={unstageOne}
                      onDiscard={discardOne}
                    />
                  ))}
                </ChangeSection>
              )}

              {unstagedCount > 0 && (
                <ChangeSection
                  title="Changes"
                  count={unstagedCount}
                  collapsed={sections.changes}
                  onToggle={() => setSections((s) => ({ ...s, changes: !s.changes }))}
                  disabled={disabled}
                  action={{
                    title: "Stage all changes",
                    icon: <PlusGlyph />,
                    onClick: stageAll,
                  }}
                >
                  {unstaged.map((file) => (
                    <ChangeRow
                      key={`u:${file.path}`}
                      file={file}
                      staged={false}
                      selected={activeDiffTarget?.staged === false && activeDiffTarget.path === file.path}
                      disabled={disabled}
                      onOpenDiff={openDiff}
                      onStage={stageOne}
                      onUnstage={unstageOne}
                      onDiscard={discardOne}
                    />
                  ))}
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
      )}
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

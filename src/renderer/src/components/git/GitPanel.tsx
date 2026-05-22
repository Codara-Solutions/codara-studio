import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitDiff,
  GitFileChange,
  GitLog,
  GitOpResult,
  GitStatus,
  RunState,
  Workspace,
} from "@shared/types";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import ChangeRow from "./ChangeRow";
import ChangeSection from "./ChangeSection";
import CommitComposer from "./CommitComposer";
import CommitHistory from "./CommitHistory";
import DiffView from "./DiffView";
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
  /** Opens an absolute path as an editor tab (threaded from App). */
  onOpenFile: (absolutePath: string) => void;
}

interface DiffTarget {
  path: string;
  staged: boolean;
  untracked: boolean;
}

// How often the panel re-reads git state while it is on screen. The fs watcher
// drives most updates already — this poll is a safety net for changes the
// watcher misses (e.g. ref / index writes that bypass the worktree).
const POLL_MS = 10000;

// Cheap shallow equality on git status. Used to skip no-op setState calls so
// the change-row React.memo gates actually hold, instead of being defeated by
// fresh array identities arriving every poll.
function sameStatus(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.isRepo !== b.isRepo ||
    a.branch !== b.branch ||
    a.detached !== b.detached ||
    a.upstream !== b.upstream ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.hasConflicts !== b.hasConflicts ||
    a.error !== b.error ||
    a.staged.length !== b.staged.length ||
    a.unstaged.length !== b.unstaged.length
  ) {
    return false;
  }
  for (let i = 0; i < a.staged.length; i++) {
    const x = a.staged[i];
    const y = b.staged[i];
    if (
      x.path !== y.path ||
      x.status !== y.status ||
      x.staged !== y.staged ||
      x.untracked !== y.untracked ||
      x.oldPath !== y.oldPath
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.unstaged.length; i++) {
    const x = a.unstaged[i];
    const y = b.unstaged[i];
    if (
      x.path !== y.path ||
      x.status !== y.status ||
      x.staged !== y.staged ||
      x.untracked !== y.untracked ||
      x.oldPath !== y.oldPath
    ) {
      return false;
    }
  }
  return true;
}

// Cheap shallow equality on git log. Commit shas are the identity here — if
// every row hash + ref decoration is unchanged, the graph view models can be
// reused and the memoized commit rows skip re-rendering.
function sameLog(a: GitLog | null, b: GitLog | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.isRepo !== b.isRepo || a.error !== b.error || a.rows.length !== b.rows.length) {
    return false;
  }
  for (let i = 0; i < a.rows.length; i++) {
    const x = a.rows[i];
    const y = b.rows[i];
    if (
      x.hash !== y.hash ||
      x.subject !== y.subject ||
      x.isHead !== y.isHead ||
      x.graph !== y.graph
    ) {
      return false;
    }
    const xRefs = x.refs ?? [];
    const yRefs = y.refs ?? [];
    if (xRefs.length !== yRefs.length) return false;
    for (let j = 0; j < xRefs.length; j++) {
      if (xRefs[j] !== yRefs[j]) return false;
    }
  }
  return true;
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
  onOpenFile,
}: Props): React.ReactElement {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sections, setSections] = useState({ staged: false, changes: false, history: false });
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Refs let the timer / event callbacks and action guards read live values
  // without re-subscribing or going stale.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const busyRef = useRef<string | null>(busy);
  busyRef.current = busy;
  const statusRef = useRef<GitStatus | null>(status);
  statusRef.current = status;

  const logRef = useRef<GitLog | null>(log);
  logRef.current = log;

  const refresh = useCallback(async (silent = false): Promise<void> => {
    const target = cwdRef.current;
    if (!target) {
      setStatus(null);
      setLog(null);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const [nextStatus, nextLog] = await Promise.all([
        window.spark.git.status(target),
        window.spark.git.log(target),
      ]);
      if (cwdRef.current !== target) return;
      // Skip the setState when nothing changed — keeps row identities stable
      // so memoized children don't re-render on every poll tick.
      if (!sameStatus(statusRef.current, nextStatus)) setStatus(nextStatus);
      if (!sameLog(logRef.current, nextLog)) setLog(nextLog);
    } catch (err) {
      if (cwdRef.current === target) setOpError((err as Error).message);
    } finally {
      if (cwdRef.current === target) setLoading(false);
    }
  }, []);

  // Initial load + full reset whenever the workspace changes.
  useEffect(() => {
    setStatus(null);
    setLog(null);
    setOpError(null);
    setDiffTarget(null);
    setMessage("");
    setSections({ staged: false, changes: false, history: false });
    if (cwd) void refresh(false);
  }, [cwd, refresh]);

  // Lightweight poll so the panel tracks changes made from the terminal or
  // another tool. Skipped while the window is hidden or an op is running.
  useEffect(() => {
    if (!cwd) return undefined;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible" && !busyRef.current) {
        void refresh(true);
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [cwd, refresh]);

  // Snappier than the poll when the file watcher (driven by the file tree) is
  // live — a debounced refresh on any change under the workspace root.
  useEffect(() => {
    if (!cwd) return undefined;
    let timer: number | null = null;
    const unsub = window.spark.fs.onChanged((event) => {
      if (event.root !== cwd) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(true), 300);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsub();
    };
  }, [cwd, refresh]);

  // Load the diff whenever a file is opened in the diff view.
  useEffect(() => {
    if (!diffTarget || !cwd) {
      setDiff(null);
      return undefined;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiff(null);
    window.spark.git
      .diff(cwd, diffTarget.path, diffTarget.staged, diffTarget.untracked)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setDiff({ path: diffTarget.path, binary: false, lines: [], error: err.message });
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [diffTarget, cwd]);

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
        void refresh(true);
      }
    },
    [refresh],
  );

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

  const handleSmartMerge = useCallback(async (): Promise<void> => {
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
        initialUserNote:
          "Run this as an autonomous smart merge. Do not ask me to approve routine fetch, diff review, stash preservation, merge, conflict resolution, or verification steps. Pause only for the explicit pause rules in the plan.",
      });
      onRunSnapshot(run, { select: true, focusRuns: true });
    } catch (err) {
      setOpError((err as Error).message);
    } finally {
      setBusy(null);
      void refresh(true);
    }
  }, [workspace, onRunSnapshot, refresh]);

  // History actions can move HEAD or the working tree — drop any open diff so
  // the panel does not keep showing a now-stale one.
  const handleCheckout = useCallback(
    (ref: string) => {
      if (!cwd) return;
      setDiffTarget(null);
      void runAction("checkout", () => window.spark.git.checkout(cwd, ref));
    },
    [cwd, runAction],
  );
  const handleRevert = useCallback(
    (hash: string) => {
      if (!cwd) return;
      setDiffTarget(null);
      void runAction("revert", () => window.spark.git.revert(cwd, hash));
    },
    [cwd, runAction],
  );
  const handleUndoLastCommit = useCallback(() => {
    if (!cwd) return;
    setDiffTarget(null);
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

  // Commit. With nothing staged, stage everything first so the button can
  // double as "Commit All" — matching VS Code's behaviour.
  const handleCommit = useCallback(async (): Promise<void> => {
    if (!cwd || busyRef.current) return;
    const text = message.trim();
    if (!text) return;
    const nothingStaged = (statusRef.current?.staged.length ?? 0) === 0;
    setBusy("commit");
    setOpError(null);
    try {
      if (nothingStaged) {
        const staged = await window.spark.git.stageAll(cwd);
        if (!staged.ok) {
          setOpError(staged.error);
          return;
        }
      }
      const result = await window.spark.git.commit(cwd, text);
      if (result.ok) setMessage("");
      else setOpError(result.error);
    } catch (err) {
      setOpError((err as Error).message);
    } finally {
      setBusy(null);
      void refresh(true);
    }
  }, [cwd, message, refresh]);

  const openDiff = useCallback((file: GitFileChange) => {
    setDiffTarget({ path: file.path, staged: file.staged, untracked: file.untracked });
  }, []);

  const openDiffFileInEditor = useCallback(() => {
    if (!cwd || !diffTarget) return;
    const sep = cwd.includes("\\") ? "\\" : "/";
    const base = cwd.replace(/[\\/]+$/, "");
    onOpenFile(base + sep + diffTarget.path.replace(/\//g, sep));
  }, [cwd, diffTarget, onOpenFile]);

  const disabled = busy !== null;
  const displayError = opError ?? status?.error ?? log?.error ?? null;
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
            onClick={() => void refresh(false)}
            disabled={disabled}
            size={22}
          >
            <RefreshIcon />
          </IconButton>
        }
      />

      {!collapsed && (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: diffTarget ? "hidden" : "auto",
            overflowX: "hidden",
          }}
        >
          {!cwd ? (
            <PanelMessage text="No active workspace." />
          ) : diffTarget ? (
            <DiffView
              path={diffTarget.path}
              staged={diffTarget.staged}
              diff={diff}
              loading={diffLoading}
              onBack={() => setDiffTarget(null)}
              onOpenFile={openDiffFileInEditor}
            />
          ) : status === null ? (
            <PanelMessage text="" />
          ) : !status.isRepo ? (
            <NonRepoState busy={disabled} onInit={handleInit} />
          ) : (
            <>
              {displayError && (
                <ErrorStrip text={displayError} onDismiss={() => setOpError(null)} />
              )}
              <CommitComposer
                message={message}
                onMessageChange={setMessage}
                onCommit={() => void handleCommit()}
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
                onSmartMerge={() => void handleSmartMerge()}
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
                      selected={false}
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
                      selected={false}
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

              <CommitHistory
                rows={log?.rows ?? []}
                loading={loading && !log}
                collapsed={sections.history}
                onToggle={() => setSections((s) => ({ ...s, history: !s.history }))}
                disabled={disabled}
                onCheckout={handleCheckout}
                onRevert={handleRevert}
                onUndoLastCommit={handleUndoLastCommit}
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
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-dim)" }}>
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
          color: busy ? "var(--muted-2)" : "var(--ink-dim)",
          opacity: busy ? 0.6 : 1,
          transition:
            "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
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
          border: "none",
          background: "transparent",
          color: "var(--danger)",
          cursor: "default",
          fontSize: 13,
          lineHeight: 1,
          padding: 2,
        }}
      >
        ✕
      </button>
    </div>
  );
}

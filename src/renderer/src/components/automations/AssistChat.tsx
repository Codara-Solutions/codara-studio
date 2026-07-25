import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AddRunMessageAttachmentInput,
  AgentRuntimeDiagnostic,
  RunState,
} from "@shared/types";
import ChatConversation from "../chat/ChatConversation";
import ChatComposer, { type ChatComposerStartConfig } from "../chat/ChatComposer";
import { describeRunStatus, statusToneColor } from "../chat/timeline";
import { CloseIcon, HistoryIcon, PlusIcon } from "../icons";

// Stable short id for an assist chat: the tail segment of the run id, so
// "run-mr7vuzog-1l3h2v" reads as "#1l3h2v". Run ids are `run-<time>-<rand>`, and
// near-simultaneous sessions share the time segment — the tail (random) piece is
// what actually tells them apart, which is exactly why we surface it rather than
// the head-truncated full id.
function shortRunId(runId: string): string {
  const tail = runId.split("-").pop() || runId;
  return `#${tail}`;
}

// Compact "now / 5m / 3h / 2d / 1w" relative time for the session-history rows,
// mirroring the chat panel's own history formatter (kept local so this panel's
// UI stays self-contained).
function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  if (diffMs < 0) return "now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(day / 365)}y`;
}

// AssistChat — the Automations Hub's "Create with Cora" surface: a real Cora
// chat pinned to chatMode "automation" (the loom architect). It reuses the
// chat tab's ChatConversation + ChatComposer wholesale, so streaming, tool
// activity, ask_user answer buttons, attachments and the model chips all work
// exactly like the main chat — the composer is just locked to automation mode
// and this panel owns the run lifecycle instead of App's lifted runs state
// (architect runs are filtered OUT of the chat tab; their home is here).
//
// Session model: one workspace can accumulate several architect chats. The hub
// remembers the exact open session per workspace, so switching away and back —
// or reopening the Automations tab — returns to the same live conversation.
// `focusRunId` (the loom detail's "Open chat" back-pointer) can select a specific
// authoring run. "New session" (+) explicitly drops to the draft composer, and
// the history button switches between past sessions.

interface Props {
  workspaceId: string;
  workspaceName: string;
  cwd: string;
  runtimes: AgentRuntimeDiagnostic[];
  // Whether this panel is actually on screen (Automations tab active AND the
  // Looms sub-tab showing). The panel stays MOUNTED while hidden — same
  // keep-alive contract as the node-flow editor — so the composer draft and
  // session selection survive tab flips; `active` only gates the composer's
  // window-level listeners so a hidden assist composer never swallows
  // prefill/focus broadcasts aimed at the chat tab's composer.
  active: boolean;
  // When set (and it changes to a non-null value), select THAT run — the loom
  // detail's "Open chat" jumps back to the architect conversation that authored
  // a loom. It overrides the remembered initial selection; the user can still
  // switch sessions afterward.
  focusRunId?: string;
  // Workspace-scoped selection restored by AutomationsHub. Unlike focusRunId,
  // this is only an initial value and never yanks the user away after mount.
  initialRunId?: string | null;
  onSelectedRunIdChange?: (runId: string | null) => void;
  onClose: () => void;
}

const ASSIST_RUN_TITLE = "Loom assistant";
// Matches App.tsx's orchestration-event → listRuns debounce so a burst of
// chat.* stream events collapses into one refresh once it settles.
const REFRESH_DEBOUNCE_MS = 250;

function isAssistRun(run: RunState): boolean {
  // Architect chats are ordinary (non-loom-owned) runs in automation mode.
  // Loom-owned iteration runs also carry chatMode in some paths — the
  // automationId guard keeps them in the Workers/History surfaces only.
  return run.chatMode === "automation" && !run.automationId;
}

export default function AssistChat({
  workspaceId,
  workspaceName,
  cwd,
  runtimes,
  active,
  focusRunId,
  initialRunId,
  onSelectedRunIdChange,
  onClose,
}: Props): React.ReactElement {
  // null = not loaded yet; afterwards always the latest fetched list, newest
  // first. Kept fresh by the debounced orchestration-event refresh below.
  const [assistRuns, setAssistRuns] = useState<RunState[] | null>(null);
  // Restore the exact architect session that was open in this workspace. A
  // brand-new workspace still starts on the draft composer; the explicit +
  // action is how the user asks to leave a remembered session for a new one.
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId ?? null);
  const [error, setError] = useState<string | null>(null);

  const selectRun = useCallback(
    (runId: string | null) => {
      setSelectedId(runId);
      onSelectedRunIdChange?.(runId);
    },
    [onSelectedRunIdChange],
  );

  // Parent-driven focus: "Open chat" from a loom's detail sets focusRunId to the
  // authoring run — the one path that selects a run on mount (otherwise we open
  // on the draft composer). Guarded on the value so a plain re-render doesn't
  // yank the user off a session they switched to after the jump.
  const focusedRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusRunId || focusedRunRef.current === focusRunId) return;
    focusedRunRef.current = focusRunId;
    selectRun(focusRunId);
  }, [focusRunId, selectRun]);

  const refresh = useCallback(async () => {
    try {
      const list = await window.spark.orchestration.listRuns(workspaceId);
      const assist = list
        .filter(isAssistRun)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setAssistRuns(assist);
      // Deliberately no auto-resume: entering the hub always lands on the draft
      // composer (selectedId stays null). Past sessions keep running in the
      // background and are reachable from the history popover; only focusRunId
      // (loom "Open chat") selects a run on mount.
    } catch {
      /* best-effort: keep the last good list */
    }
  }, [workspaceId]);

  // Initial load + live refresh. ChatConversation streams the in-flight turn
  // itself from chat.* events; this subscription only keeps the PERSISTED run
  // snapshot (messages, status, workers) current, debounced like App's lifted
  // runs refresh so event bursts cost one listRuns each.
  useEffect(() => {
    void refresh();
    let timer: number | null = null;
    const unsubscribe = window.spark.orchestration.onEvent((event) => {
      if (event.workspaceId !== workspaceId) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh, workspaceId]);

  const activeRun = useMemo(
    () => assistRuns?.find((run) => run.id === selectedId) ?? null,
    [assistRuns, selectedId],
  );

  // A remembered run can have been deleted in another surface or before an
  // app restart. Once history has loaded, fall back honestly to a new draft
  // instead of showing an empty conversation under a stale session id.
  useEffect(() => {
    if (assistRuns === null || !selectedId) return;
    if (assistRuns.some((run) => run.id === selectedId)) return;
    selectRun(null);
  }, [assistRuns, selectedId, selectRun]);

  // Merge a fresh snapshot into the local list without waiting for the next
  // listRuns round-trip (used right after createRun/startAutopilot so the
  // conversation appears the instant the IPC resolves).
  const applySnapshot = useCallback((run: RunState) => {
    setAssistRuns((current) => {
      const rest = (current ?? []).filter((item) => item.id !== run.id);
      const next = [run, ...rest];
      next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return next;
    });
  }, []);

  // First message of a draft session: create the run with chatMode pinned to
  // "automation" (same createRun → startAutopilot pair the chat tab's
  // OrchestrationSidebar uses when the composer chips carry a config), then
  // select it. The composer's lockedMode guarantees chatConfig.mode is
  // "automation", but we pin it here too so this surface can never create a
  // non-architect run even if the composer contract drifts.
  const startChat = useCallback(
    async (
      message: string,
      clientMessageId: string,
      attachments?: AddRunMessageAttachmentInput[],
      chatConfig?: ChatComposerStartConfig,
    ) => {
      const created = await window.spark.orchestration.createRun({
        workspaceId,
        workspaceName,
        cwd,
        title: ASSIST_RUN_TITLE,
        chatBackend: chatConfig?.backend,
        chatModel: chatConfig?.model,
        chatMode: "automation",
        chatEffort: chatConfig?.effort,
        coraExecutionPolicy: chatConfig?.executionPolicy,
        chatFastMode: chatConfig?.fastMode,
        chat1mContext: chatConfig?.oneMillionContext,
      });
      const run = await window.spark.orchestration.startAutopilot({
        workspaceId,
        workspaceName,
        cwd,
        runId: created.id,
        initialUserNote: message,
        initialUserNoteClientMessageId: clientMessageId,
        initialAttachments: attachments,
      });
      applySnapshot(run);
      selectRun(run.id);
      return run;
    },
    [workspaceId, workspaceName, cwd, applySnapshot, selectRun],
  );

  // Stop is intentionally non-destructive: interrupt execution immediately
  // but preserve the automation conversation and every completed change.
  // Rewind remains an explicit Undo action, never a side effect of Stop.
  const forcePause = useCallback(() => {
    if (!activeRun) return;
    setError(null);
    void (async () => {
      try {
        const run = await window.spark.orchestration.forcePauseRun(activeRun.id);
        applySnapshot(run);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [activeRun, applySnapshot]);

  const deleteSession = useCallback(
    (runId: string) => {
      setError(null);
      void (async () => {
        try {
          await window.spark.orchestration.deleteRun(runId);
          setAssistRuns((current) => (current ?? []).filter((run) => run.id !== runId));
          if (selectedId === runId) selectRun(null);
        } catch (err) {
          setError((err as Error).message);
        }
      })();
    },
    [selectedId, selectRun],
  );

  const newSession = useCallback(() => {
    selectRun(null);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("spark:focus-composer"));
    });
  }, [selectRun]);

  // The architect drives the spark_*_automation MCP tools, which only the
  // Claude Code / Codex CLI backends carry. Setups without either CLI get a
  // heads-up here (the backend itself also short-circuits with a chat note).
  // Empty diagnostics = not loaded yet — stay quiet rather than flash a
  // false warning.
  const cliReady =
    runtimes.length === 0 ||
    runtimes.some(
      (r) => (r.kind === "claude" || r.kind === "codex") && r.installed === true,
    );

  const loading = assistRuns === null;

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--panel)",
      }}
    >
      {/* Header: title + live status of the active session, session controls */}
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          borderBottom: "1px solid var(--rule)",
          background: "var(--bg)",
        }}
      >
        <div
          aria-hidden
          style={{
            width: 30,
            height: 30,
            borderRadius: 9,
            display: "grid",
            placeItems: "center",
            color: "var(--accent)",
            background: "color-mix(in oklch, var(--accent) 11%, var(--panel))",
            border: "1px solid color-mix(in oklch, var(--accent) 28%, var(--rule-soft))",
            boxShadow: "0 0 18px color-mix(in oklch, var(--accent) 10%, transparent)",
            flex: "0 0 30px",
          }}
        >
          ✦
        </div>
        <div style={{ flex: "0 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap" }}>
            Cora · Automation architect
          </span>
          <span
            className="spark-mono"
            style={{
              fontSize: 10,
              color: "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {activeRun ? <SessionStatusLine run={activeRun} /> : "Describe a workflow and Cora will design it with you"}
          </span>
        </div>
        {/* + lives beside the title (it acts on "this session" context); history
            sits at the right; × is alone in the far corner with a gap — three
            separate homes on purpose, per user feedback (no button cluster). */}
        <button
          type="button"
          className="spark-icon-btn"
          aria-label="New session"
          onClick={newSession}
          title="Start a fresh architect session (past sessions stay in the history)"
        >
          <PlusIcon size={13} />
        </button>
        <span style={{ flex: 1 }} />
        <AssistHistoryButton
          runs={assistRuns ?? []}
          activeRunId={activeRun?.id ?? null}
          onSelect={selectRun}
          onDelete={deleteSession}
        />
        <button
          type="button"
          className="spark-icon-btn"
          aria-label="Done — back to the looms view"
          style={{ marginLeft: 14 }}
          onClick={onClose}
          title="Back to the looms view — the session keeps running"
        >
          <CloseIcon size={13} />
        </button>
      </div>

      {!cliReady && (
        <div
          role="alert"
          style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            padding: "8px 14px",
            borderBottom: "1px solid var(--rule-soft)",
            background: "var(--danger-soft)",
            fontSize: 11,
            color: "var(--ink)",
          }}
        >
          <span className="spark-badge is-danger">CLI needed</span>
          <span>
            The loom architect needs Claude Code or Codex, no other backend can manage
            automations. Install one, then pick it in the model chip below.
          </span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            flex: "0 0 auto",
            padding: "7px 14px",
            borderBottom: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontSize: 11,
            lineHeight: 1.4,
          }}
        >
          {error}
        </div>
      )}

      {activeRun ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ChatConversation key={`assist-conversation:${activeRun.id}`} run={activeRun} />
        </div>
      ) : (
        <AssistWelcome loading={loading} />
      )}

      <ChatComposer
        key={`assist-composer:${activeRun?.id ?? "draft"}`}
        run={activeRun}
        cwd={cwd}
        disabled={false}
        lockedMode="automation"
        suspendGlobalEvents={!active}
        onStartChat={startChat}
        onForcePauseRun={forcePause}
      />
    </section>
  );
}

function SessionStatusLine({ run }: { run: RunState }): React.ReactElement {
  const status = describeRunStatus(run);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: statusToneColor(status.tone),
          flex: "0 0 6px",
          animation: status.tone === "live" ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
        }}
      />
      <span>
        {run.title || ASSIST_RUN_TITLE}{" "}
        <span style={{ color: "var(--muted)" }} title={run.id}>
          {shortRunId(run.id)}
        </span>{" "}
        — {status.label}
        {status.detail ? ` ${status.detail}` : ""}
      </span>
    </span>
  );
}

function AssistWelcome({ loading }: { loading: boolean }): React.ReactElement {
  const suggestions = [
    {
      title: "Keep tests green",
      prompt:
        "Design an automation that runs the project's tests, diagnoses failures, fixes the root cause, and stops safely once the suite is green.",
    },
    {
      title: "Review every change",
      prompt:
        "Design an automation that reviews new code changes for correctness and regressions, then reports or applies only high-confidence fixes.",
    },
    {
      title: "Watch a folder",
      prompt:
        "Design a folder-watcher automation for this project. Help me choose the folder, events, debounce, worker, and safe action.",
    },
  ] as const;
  const prefill = (text: string) => {
    window.dispatchEvent(
      new CustomEvent("spark:prefill-composer", { detail: { text, replace: true } }),
    );
  };
  return (
    <div className="automation-assist-welcome">
      <div className="automation-assist-welcome__mark" aria-hidden>✦</div>
      <div className="spark-eyebrow">{loading ? "Loading…" : "Loom architect"}</div>
      {!loading && (
        <>
          <div className="automation-assist-welcome__title">Describe the outcome, not the plumbing</div>
          <div className="automation-assist-welcome__body">
            Cora inspects this project, proposes the trigger, safety caps, model,
            and worker flow, then creates and test-runs the loom with you.
          </div>
          <div className="automation-assist-welcome__suggestions">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.title}
                type="button"
                className="automation-assist-suggestion"
                onClick={() => prefill(suggestion.prompt)}
              >
                <span>{suggestion.title}</span>
                <span aria-hidden>↗</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Session-history dropdown for the architect chat. A local, self-contained
// twin of the chat panel's ChatHistoryButton — the difference is that each row
// carries the chat's short id (#tail) alongside its AI-generated title + relative
// time, so a workspace's several architect sessions are tellable apart even when
// they were created seconds apart (the shared row only shows a head-truncated id
// that collapses to the same prefix for near-simultaneous chats).
function AssistHistoryButton({
  runs,
  activeRunId,
  onSelect,
  onDelete,
}: {
  runs: RunState[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
  onDelete?: (runId: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const node = wrapperRef.current;
      if (node && e.target instanceof Node && node.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sortedRuns = useMemo(() => {
    const score = (run: RunState): number => {
      const candidate = run.updatedAt ?? run.completedAt ?? run.createdAt;
      const t = candidate ? Date.parse(candidate) : NaN;
      return Number.isFinite(t) ? t : 0;
    };
    return [...runs].sort((a, b) => score(b) - score(a));
  }, [runs]);

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className="spark-icon-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Session history"
        title="Past architect sessions in this workspace"
      >
        <HistoryIcon size={13} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Past architect sessions"
          className="spark-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 50,
            width: 300,
            maxHeight: "min(50vh, 420px)",
            overflowY: "auto",
            padding: 4,
          }}
        >
          <div className="spark-eyebrow" style={{ padding: "6px 8px 5px" }}>
            Past sessions
          </div>
          {sortedRuns.length === 0 ? (
            <div className="spark-empty" style={{ minHeight: 0, padding: "18px 8px" }}>
              <div className="spark-eyebrow">No sessions yet</div>
              <div className="spark-empty__body">Start one below to see it here.</div>
            </div>
          ) : (
            sortedRuns.map((run) => (
              <AssistHistoryRow
                key={run.id}
                run={run}
                active={run.id === activeRunId}
                onClick={() => {
                  setOpen(false);
                  onSelect(run.id);
                }}
                onDelete={onDelete}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function AssistHistoryRow({
  run,
  active,
  onClick,
  onDelete,
}: {
  run: RunState;
  active: boolean;
  onClick: () => void;
  onDelete?: (runId: string) => void;
}): React.ReactElement {
  const [hover, setHover] = useState(false);
  // Two-click delete: first click arms (button reads "Delete?"), a second within
  // ~2.6s removes it, and moving away or waiting disarms — so a stray click never
  // destroys a session.
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!armed) return;
    disarmTimer.current = window.setTimeout(() => setArmed(false), 2600);
    return () => {
      if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    };
  }, [armed]);

  const status = describeRunStatus(run);
  const dotColor = statusToneColor(status.tone);
  const ts = run.updatedAt ?? run.completedAt ?? run.createdAt;
  const relTime = ts ? formatRelativeTime(ts) : "";

  const handleDelete = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onDelete?.(run.id);
  };

  return (
    <div
      role="option"
      aria-selected={active}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setArmed(false);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        width: "100%",
        padding: "7px 8px",
        background: active ? "var(--accent-soft)" : hover ? "var(--hover)" : "transparent",
        border: active ? "1px solid var(--accent-edge)" : "1px solid transparent",
        borderRadius: "var(--radius-control, 7px)",
        textAlign: "left",
        cursor: "default",
        color: "var(--ink)",
        boxSizing: "border-box",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dotColor,
            flex: "0 0 6px",
            animation: status.tone === "live" ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            color: active ? "var(--accent)" : "var(--ink)",
          }}
        >
          {run.title || ASSIST_RUN_TITLE}
        </span>
        {relTime && (
          <span
            style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted)", flex: "0 0 auto" }}
          >
            {relTime}
          </span>
        )}
        {onDelete && (hover || armed) && (
          <button
            type="button"
            onClick={handleDelete}
            title={armed ? "Click again to delete permanently" : "Delete session"}
            aria-label={armed ? "Confirm delete session" : "Delete session"}
            style={{
              appearance: "none",
              height: 18,
              padding: armed ? "0 6px" : 0,
              width: armed ? "auto" : 18,
              border: "none",
              borderRadius: "var(--radius-control, 7px)",
              background: armed ? "var(--danger)" : "transparent",
              color: armed ? "var(--accent-ink)" : "var(--muted)",
              fontSize: 10,
              fontWeight: 600,
              whiteSpace: "nowrap",
              cursor: "default",
              flex: "0 0 auto",
            }}
          >
            {armed ? "Delete?" : "✕"}
          </button>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 12 }}>
        <span
          className="spark-mono"
          style={{ fontSize: 10, color: "var(--muted)", flex: "0 0 auto" }}
          title={run.id}
        >
          {shortRunId(run.id)}
        </span>
        <span
          className="spark-mono"
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 10,
            color: "var(--ink-dim)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {status.label}
          {status.detail ? ` ${status.detail}` : ""}
        </span>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AddRunMessageAttachmentInput,
  AgentRuntimeDiagnostic,
  RunState,
} from "@shared/types";
import ChatConversation from "../chat/ChatConversation";
import ChatComposer, { type ChatComposerStartConfig } from "../chat/ChatComposer";
import { ChatHistoryButton } from "../chat/ChatPanel";
import { describeRunStatus, statusToneColor } from "../chat/timeline";

// AssistChat — the Automations Hub's "Create with Cora" surface: a real Cora
// chat pinned to chatMode "automation" (the loom architect). It reuses the
// chat tab's ChatConversation + ChatComposer wholesale, so streaming, tool
// activity, ask_user answer buttons, attachments and the model chips all work
// exactly like the main chat — the composer is just locked to automation mode
// and this panel owns the run lifecycle instead of App's lifted runs state
// (architect runs are filtered OUT of the chat tab; their home is here).
//
// Session model: one workspace can accumulate several architect chats. On
// mount we resume the most recent one (a fresh hub visit continues where the
// user left off); "New session" drops back to the draft composer, and the
// history button switches between past sessions.

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
  onClose,
}: Props): React.ReactElement {
  // null = not loaded yet; afterwards always the latest fetched list, newest
  // first. Kept fresh by the debounced orchestration-event refresh below.
  const [assistRuns, setAssistRuns] = useState<RunState[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One-shot resume guard: only the FIRST load auto-selects the latest
  // session. After that the selection is the user's (including an explicit
  // "New session" null, which a refresh must not override).
  const autoResumed = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await window.spark.orchestration.listRuns(workspaceId);
      const assist = list
        .filter(isAssistRun)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setAssistRuns(assist);
      if (!autoResumed.current) {
        autoResumed.current = true;
        // Resume the latest architect session instead of always starting
        // fresh — runs are never "archived", so most-recent-first is the
        // whole heuristic. No session yet → stay on the draft composer.
        if (assist.length > 0) setSelectedId((current) => current ?? assist[0].id);
      }
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
      setSelectedId(run.id);
      return run;
    },
    [workspaceId, workspaceName, cwd, applySnapshot],
  );

  // Stop = "give me my message back", byte-for-byte the chat tab's behavior:
  // roll back to the pre-message checkpoint, interrupt the backend, and
  // prefill the composer with the recovered text. Only this panel's composer
  // is mounted while the Automations tab is active (ChatStack renders no
  // hidden chat panels), so the window-level prefill event lands here.
  const forcePause = useCallback(() => {
    if (!activeRun) return;
    setError(null);
    void (async () => {
      try {
        const result = await window.spark.orchestration.stopAndUndoPending(activeRun.id);
        applySnapshot(result.run);
        if (result.restoredText != null && result.restoredText.length > 0) {
          window.dispatchEvent(
            new CustomEvent("spark:prefill-composer", {
              detail: { text: result.restoredText, replace: true },
            }),
          );
        }
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
          setSelectedId((current) => (current === runId ? null : current));
        } catch (err) {
          setError((err as Error).message);
        }
      })();
    },
    [],
  );

  const newSession = useCallback(() => {
    setSelectedId(null);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("spark:focus-composer"));
    });
  }, []);

  // The architect drives the spark_*_automation MCP tools, which only the
  // Claude Code / Codex CLI backends carry. OpenRouter-only setups get a
  // heads-up here (the backend itself also short-circuits with a chat note).
  // Empty diagnostics = not loaded yet — stay quiet rather than flash a
  // false warning.
  const cliReady =
    runtimes.length === 0 ||
    runtimes.some(
      (r) =>
        (r.kind === "claude" || r.kind === "codex") &&
        r.installed === true &&
        r.disabledBySettings !== true,
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
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap" }}>
            Create with Cora
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
            {activeRun ? <SessionStatusLine run={activeRun} /> : "New architect session"}
          </span>
        </div>
        <ChatHistoryButton
          runs={assistRuns ?? []}
          activeRunId={activeRun?.id ?? null}
          onSelect={(runId) => setSelectedId(runId)}
          onDelete={deleteSession}
        />
        <button
          type="button"
          className="spark-btn"
          style={{ height: 24, padding: "0 10px", fontSize: 11 }}
          onClick={newSession}
          title="Start a fresh architect session (past sessions stay in the history)"
        >
          New session
        </button>
        <button
          type="button"
          className="spark-btn"
          style={{ height: 24, padding: "0 10px", fontSize: 11 }}
          onClick={onClose}
          title="Back to the loom detail view — the session keeps running"
        >
          Done
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
            The loom architect needs Claude Code or Codex — the OpenRouter backend can't manage
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
        // Keyed on the run so switching sessions remounts the stream cleanly
        // (same contract as ChatPanel's `conversation:${id}` key).
        <ChatConversation key={`assist-conversation:${activeRun.id}`} run={activeRun} />
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
        {run.title || ASSIST_RUN_TITLE} — {status.label}
        {status.detail ? ` ${status.detail}` : ""}
      </span>
    </span>
  );
}

function AssistWelcome({ loading }: { loading: boolean }): React.ReactElement {
  return (
    <div className="spark-empty" style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <div className="spark-eyebrow">{loading ? "Loading…" : "Loom architect"}</div>
      {!loading && (
        <div className="spark-empty__body" style={{ maxWidth: 300 }}>
          Tell Cora what you want automated — she designs the trigger, loop, and worker, then
          creates and test-runs the loom for you. It appears in the list on the left as she works.
        </div>
      )}
    </div>
  );
}

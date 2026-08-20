import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkerSessionMemoryScope,
  WorkerSessionRuntime,
  WorkerSessionSummary,
} from "@shared/types";

import { RuntimeMark } from "./BrandMarks";
import { CloseIcon, PlusIcon } from "./icons";
import {
  agentBrandCliLabel,
  agentBrandColor,
  agentBrandLabel,
} from "../lib/agent-brand";
import type { TerminalAgentSession } from "../tabs/types";
import {
  CLAUDE_LAUNCH_COMMAND,
  CODEX_LAUNCH_COMMAND,
  GROK_LAUNCH_COMMAND,
  buildAgentResumeCommand,
} from "../workers/launch-commands";

export interface WorkerSessionPickerRequest {
  runtime: WorkerSessionRuntime;
  cwd: string;
  launch: (command: string, session: TerminalAgentSession | null) => void;
}

interface WorkerSessionPickerProps {
  request: WorkerSessionPickerRequest | null;
  onClose: () => void;
}

const ROW_HEIGHT = 52;
const VISIBLE_ROWS = 6;

export default function WorkerSessionPicker({
  request,
  onClose,
}: WorkerSessionPickerProps) {
  const [sessions, setSessions] = useState<WorkerSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [launching, setLaunching] = useState(false);
  // Delete state. One row is armed at a time, mirroring the single
  // `pendingDelete` the Settings → Sessions tab keeps.
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const [deleteMemory, setDeleteMemory] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Set by the arrow keys only. Hover moves the highlight too, and scrolling
  // the list under a stationary cursor slides another row under it, which
  // fires mouseenter, moves the highlight again and scrolls again — a loop
  // that costs a forced layout per turn. Pointer moves never scroll.
  const keyboardMoveRef = useRef(false);
  // Enter means New session until the user deliberately enters history with
  // an arrow key. Pointer hover may preview a row but never steals that safe
  // default.
  const historyKeyboardArmedRef = useRef(false);
  // The request the current `sessions` belong to. A background re-list that
  // resolves after the picker was reopened for another runtime/cwd is dropped
  // instead of overwriting the newer list.
  const activeRequestRef = useRef<WorkerSessionPickerRequest | null>(null);

  useEffect(() => {
    activeRequestRef.current = request;
    if (!request) return;
    let cancelled = false;
    setSessions([]);
    setError(null);
    setSelectedIndex(-1);
    historyKeyboardArmedRef.current = false;
    setLoading(true);
    setLaunching(false);
    setPendingDeleteKey(null);
    setDeleteMemory(false);
    setDeletingKey(null);
    setRowError(null);
    setNotice(null);
    void window.spark.agentSession
      .list({ runtime: request.runtime, cwd: request.cwd })
      .then((items) => {
        if (!cancelled) setSessions(items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Session history could not be read.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    window.requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    if (!keyboardMoveRef.current) return;
    keyboardMoveRef.current = false;
    const selected = listRef.current?.querySelector<HTMLElement>(
      `[data-session-index="${selectedIndex}"]`,
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, sessions.length]);

  // Deleting the last row would leave the highlight past the end of the list.
  useEffect(() => {
    setSelectedIndex((index) =>
      sessions.length === 0 ? -1 : Math.min(index, sessions.length - 1),
    );
  }, [sessions.length]);

  const runtimeLabel = request ? agentBrandLabel(request.runtime) : "";
  const cliLabel = request ? agentBrandCliLabel(request.runtime) : "";
  const workspaceLabel = useMemo(
    () => (request ? compactPath(request.cwd) : ""),
    [request],
  );

  if (!request) return null;

  const tint = agentBrandColor(request.runtime);

  const prepareCodex = async (nativeCodexProfileId?: string) => {
    if (request.runtime === "codex") {
      await window.spark.agentSession
        .ensureCodexTrust(request.cwd, nativeCodexProfileId)
        .catch(() => undefined);
    }
  };

  const launchNew = async () => {
    if (launching) return;
    setLaunching(true);
    await prepareCodex();
    request.launch(
      request.runtime === "claude"
        ? CLAUDE_LAUNCH_COMMAND
        : request.runtime === "grok"
          ? GROK_LAUNCH_COMMAND
          : CODEX_LAUNCH_COMMAND,
      null,
    );
    onClose();
  };

  const resume = async (session: WorkerSessionSummary) => {
    if (launching) return;
    setLaunching(true);
    await prepareCodex(session.nativeCodexProfileId);
    const pointer: TerminalAgentSession = {
      runtime: session.runtime,
      nativeCodexProfileId: session.nativeCodexProfileId,
      nativeClaudeProfileId: session.nativeClaudeProfileId,
      nativeGrokProfileId: session.nativeGrokProfileId,
      sessionId: session.sessionId,
      cwd: request.cwd,
      transcriptPath: session.transcriptPath,
      capturedAt: new Date().toISOString(),
      active: false,
    };
    request.launch(buildAgentResumeCommand(pointer), pointer);
    onClose();
  };

  // Arming and disarming both hand focus back to the dialog: the control the
  // user clicked is swapped out by the state change, and without this the
  // focus would fall to <body> and take the arrow/Enter/Delete keys with it.
  const refocusDialog = () => {
    window.requestAnimationFrame(() => dialogRef.current?.focus());
  };

  const armDelete = (session: WorkerSessionSummary) => {
    if (launching || deletingKey) return;
    setPendingDeleteKey(sessionKey(session));
    setDeleteMemory(false);
    setRowError(null);
    setNotice(null);
    refocusDialog();
  };

  // Never while a delete is in flight: the row would drop out of its confirm
  // state and read as a cancel even though the session is still being removed.
  const disarmDelete = () => {
    if (deletingKey) return;
    setPendingDeleteKey(null);
    setDeleteMemory(false);
    setRowError(null);
    refocusDialog();
  };

  const confirmDelete = async (session: WorkerSessionSummary) => {
    const key = sessionKey(session);
    // The picker can be closed and reopened for another runtime/cwd while the
    // delete is in flight. Everything below the await is therefore gated on
    // this request still being the live one, so a resolved delete can't plant
    // its outcome in an unrelated picker.
    const target = request;
    if (launching || deletingKey) return;
    const deleteSession = (
      window.spark.agentSession as Partial<typeof window.spark.agentSession>
    ).delete;
    if (typeof deleteSession !== "function") {
      setRowError({ key, message: "Restart Codara once to enable session deletion." });
      return;
    }
    const memoryScope: WorkerSessionMemoryScope = deleteMemory
      ? session.runtime === "claude"
        ? "claude-project"
        : "codex-all"
      : "none";
    setDeletingKey(key);
    setRowError(null);
    setNotice(null);
    try {
      const result = await deleteSession({
        runtime: session.runtime,
        nativeCodexProfileId: session.nativeCodexProfileId,
        sessionId: session.sessionId,
        cwd: session.cwd || target.cwd,
        transcriptPath: session.transcriptPath,
        memoryScope,
      });
      if (activeRequestRef.current !== target) return;
      setSessions((items) => items.filter((item) => sessionKey(item) !== key));
      setPendingDeleteKey(null);
      setDeleteMemory(false);
      setNotice(
        result.warnings.length > 0
          ? result.warnings.join(" ")
          : result.memoryDeleted
            ? "Session and the selected local memory scope were deleted."
            : "Session deleted.",
      );
      void window.spark.agentSession
        .list({
          runtime: target.runtime,
          cwd: target.cwd,
          nativeCodexProfileId: session.nativeCodexProfileId,
        })
        .then((items) => {
          if (activeRequestRef.current === target) setSessions(items);
        })
        .catch(() => undefined);
      refocusDialog();
    } catch (reason: unknown) {
      if (activeRequestRef.current !== target) return;
      setRowError({
        key,
        message: reason instanceof Error ? reason.message : "Session could not be deleted.",
      });
    } finally {
      setDeletingKey(null);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // A delete already committed can't be taken back, so Escape must not
      // look like it cancelled one. The row stays busy until it resolves.
      if (deletingKey) return;
      if (pendingDeleteKey) {
        disarmDelete();
        return;
      }
      onClose();
      return;
    }
    // A focused control inside a row (the memory checkbox, the confirm
    // buttons) owns its own keys — handling them here too would fire the
    // action twice, or delete a session on a Backspace meant for the checkbox.
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "BUTTON")
    ) {
      return;
    }
    if (sessions.length === 0) {
      if (event.key === "Enter" && !event.repeat) {
        event.preventDefault();
        void launchNew();
      }
      return;
    }
    const session = selectedIndex >= 0 ? sessions[selectedIndex] : undefined;
    const armed = session ? sessionKey(session) === pendingDeleteKey : false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      keyboardMoveRef.current = true;
      historyKeyboardArmedRef.current = true;
      setSelectedIndex((index) => (index < 0 ? 0 : (index + 1) % sessions.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      keyboardMoveRef.current = true;
      historyKeyboardArmedRef.current = true;
      setSelectedIndex((index) =>
        index < 0 ? sessions.length - 1 : (index - 1 + sessions.length) % sessions.length,
      );
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      // Auto-repeat must never drive this branch. Held down, it would arm a
      // row, confirm it a beat later, then walk into whichever session slid
      // up into the highlight and delete that one too.
      if (event.repeat || !session) return;
      if (armed) void confirmDelete(session);
      else armDelete(session);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.repeat) return;
      if (!historyKeyboardArmedRef.current || !session) {
        void launchNew();
        return;
      }
      // On an armed row the whole row reads as a confirm prompt, so Enter
      // commits the delete rather than resuming.
      if (armed) void confirmDelete(session);
      else void resume(session);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 110,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "72px 22px 28px",
        fontFamily: "var(--font-sans)",
      }}
      className="spark-fade-in"
      onMouseDown={onClose}
    >
      <div className="spark-scrim worker-session-scrim" style={{ zIndex: 0 }} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${runtimeLabel} sessions`}
        tabIndex={-1}
        className="spark-glass--strong worker-session-surface"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          position: "relative",
          zIndex: 1,
          width: "min(440px, calc(100vw - 44px))",
          maxHeight: "calc(100vh - 108px)",
          display: "flex",
          flexDirection: "column",
          borderRadius: 16,
          overflow: "hidden",
          outline: "none",
          boxShadow: `var(--shadow-2), 0 0 0 1px color-mix(in oklch, ${tint} 22%, transparent)`,
        }}
      >
        <div
          aria-hidden
          style={{
            height: 3,
            background: `linear-gradient(90deg, ${tint}, color-mix(in oklch, ${tint} 35%, transparent))`,
          }}
        />
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "16px 16px 14px",
          }}
        >
          <RuntimeChip runtime={request.runtime} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                color: "var(--ink)",
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: "-0.03em",
                lineHeight: 1.2,
              }}
            >
              {runtimeLabel}
            </div>
            <div
              title={request.cwd}
              style={{
                marginTop: 3,
                color: "var(--muted)",
                fontSize: 11,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {workspaceLabel}
            </div>
          </div>
          <button
            type="button"
            className="spark-icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{ cursor: "default", flex: "0 0 auto" }}
          >
            <CloseIcon size={11} />
          </button>
        </header>

        <div
          style={{
            padding: "0 14px 14px",
            minHeight: 120,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <NewSessionButton
            tint={tint}
            cliLabel={cliLabel}
            disabled={launching}
            onClick={() => void launchNew()}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 2px",
              }}
            >
              <span
                style={{
                  color: "var(--muted)",
                  fontSize: 10.5,
                  fontWeight: 650,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                Recent
              </span>
              <span
                style={{ minWidth: 0, flex: 1, height: 1, background: "var(--rule-soft)" }}
                aria-hidden
              />
              {!loading && !error ? (
                <span
                  style={{
                    color: "var(--muted-2)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                  }}
                >
                  {sessions.length}
                </span>
              ) : null}
            </div>
            {loading ? (
              <QuietState text="Looking for previous sessions…" />
            ) : error ? (
              <QuietState text={error} danger />
            ) : sessions.length === 0 ? (
              <QuietState text="No previous sessions in this folder." />
            ) : (
              <div
                ref={listRef}
                role="list"
                aria-label={`${runtimeLabel} session history`}
                className="worker-session-list"
                style={{
                  maxHeight: ROW_HEIGHT * VISIBLE_ROWS,
                  overflowY: sessions.length > VISIBLE_ROWS ? "auto" : "hidden",
                  borderRadius: 12,
                  background: "color-mix(in oklab, var(--panel-2) 70%, transparent)",
                }}
              >
                {sessions.map((session, index) => {
                  const key = sessionKey(session);
                  return (
                    <SessionRow
                      key={key}
                      index={index}
                      session={session}
                      selected={index === selectedIndex}
                      armed={key === pendingDeleteKey}
                      deleting={key === deletingKey}
                      deleteMemory={deleteMemory}
                      error={rowError?.key === key ? rowError.message : null}
                      onHover={() => setSelectedIndex(index)}
                      onOpen={() => void resume(session)}
                      onArmDelete={() => armDelete(session)}
                      onDeleteMemoryChange={setDeleteMemory}
                      onCancelDelete={disarmDelete}
                      onConfirmDelete={() => void confirmDelete(session)}
                      disabled={launching || (deletingKey !== null && key !== deletingKey)}
                    />
                  );
                })}
              </div>
            )}
          </div>
          {notice ? (
            <div
              role="status"
              style={{
                color: "var(--muted)",
                fontSize: 10.5,
                lineHeight: 1.45,
              }}
            >
              {notice}
            </div>
          ) : null}
        </div>
        <footer
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 16px 12px",
            color: "var(--muted-2)",
            fontSize: 10,
          }}
        >
          <span>↵  new session</span>
          <span>↑↓  choose history</span>
          <span>⌫  delete</span>
        </footer>
      </section>
    </div>
  );
}

// The primary call to action, tinted with the runtime it will start rather
// than a flat accent so the Claude and Codex pickers read apart at a glance.
// Hover and focus live here because the button sets an inline box-shadow,
// which silently wins over the global :focus-visible ring — the ring has to
// be composed back into that same inline shadow for keyboard focus to show.
function NewSessionButton({
  tint,
  cliLabel,
  disabled,
  onClick,
}: {
  tint: string;
  cliLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const lift = "var(--lift-hi), inset 0 1px 0 color-mix(in oklab, white 8%, transparent)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) setFocus(true);
      }}
      onBlur={() => setFocus(false)}
      style={{
        appearance: "none",
        width: "100%",
        minHeight: 64,
        display: "grid",
        gridTemplateColumns: "36px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        textAlign: "left",
        color: "var(--ink)",
        border: `1px solid color-mix(in oklch, ${tint} ${hover ? 55 : 38}%, transparent)`,
        borderRadius: 12,
        background: `linear-gradient(160deg, color-mix(in oklch, ${tint} ${
          hover ? 22 : 15
        }%, var(--panel)), color-mix(in oklab, var(--panel) 88%, transparent))`,
        boxShadow: focus ? `var(--focus-ring), ${lift}` : lift,
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 36,
          height: 36,
          display: "grid",
          placeItems: "center",
          color: "var(--bg)",
          borderRadius: 10,
          background: tint,
          boxShadow: `0 0 0 1px color-mix(in oklch, ${tint} 55%, transparent)`,
        }}
      >
        <PlusIcon size={14} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 13.5,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          New session
        </span>
        <span
          style={{
            display: "block",
            marginTop: 2,
            color: "var(--muted)",
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          Start {cliLabel} in this folder
        </span>
      </span>
      <span aria-hidden style={{ color: tint, fontSize: 16, lineHeight: 1, paddingRight: 4 }}>
        →
      </span>
    </button>
  );
}

// The row is a container, not a control: it holds the open button and the
// delete affordance side by side. Keyboard navigation still lives on the
// dialog (arrows / Enter / Delete), so nothing inside the row is tab-focusable
// on its own account beyond the buttons themselves.
function SessionRow({
  index,
  session,
  selected,
  armed,
  deleting,
  deleteMemory,
  error,
  onHover,
  onOpen,
  onArmDelete,
  onDeleteMemoryChange,
  onCancelDelete,
  onConfirmDelete,
  disabled,
}: {
  index: number;
  session: WorkerSessionSummary;
  selected: boolean;
  armed: boolean;
  deleting: boolean;
  deleteMemory: boolean;
  error: string | null;
  onHover: () => void;
  onOpen: () => void;
  onArmDelete: () => void;
  onDeleteMemoryChange: (next: boolean) => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  disabled: boolean;
}) {
  // Quiet until pointed at, so a row of trash cans doesn't read as a row of
  // warnings. Hover also drives the row highlight, keeping the two in step.
  const [trashHover, setTrashHover] = useState(false);
  const tint = agentBrandColor(session.runtime);
  const shell: React.CSSProperties = {
    minHeight: ROW_HEIGHT,
    borderBottom: "1px solid var(--rule-soft)",
    background: armed
      ? "color-mix(in oklch, var(--danger) 8%, var(--panel))"
      : selected
        ? `color-mix(in oklch, ${tint} 11%, var(--panel))`
        : "transparent",
    color: "var(--ink)",
    boxShadow: armed
      ? "inset 2px 0 0 var(--danger)"
      : selected
        ? `inset 2px 0 0 ${tint}`
        : "none",
    transition:
      "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
  };

  if (armed) {
    return (
      <div
        data-session-index={index}
        role="listitem"
        aria-current={selected ? "true" : undefined}
        onMouseEnter={onHover}
        style={{ ...shell, display: "grid", gap: 7, padding: "10px 11px" }}
      >
        <div
          title={session.title}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          Permanently delete “{session.title}”?
        </div>
        <div style={{ color: "var(--muted)", fontSize: 9.5, lineHeight: 1.45 }}>
          This removes the local transcript and cannot be undone. Close a running copy of the
          session before deleting it.
        </div>
        <label
          title={memoryScopeDetail(session.runtime)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            color: deleteMemory ? "var(--danger)" : "var(--ink-dim)",
            fontSize: 9.5,
            lineHeight: 1.4,
          }}
        >
          <input
            type="checkbox"
            checked={deleteMemory}
            disabled={deleting}
            onChange={(event) => onDeleteMemoryChange(event.currentTarget.checked)}
          />
          <span>{memoryScopeLabel(session.runtime)}</span>
        </label>
        {error ? (
          <div role="alert" style={{ color: "var(--danger)", fontSize: 9.5, lineHeight: 1.45 }}>
            {error}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 7 }}>
          <button
            type="button"
            className="spark-btn"
            onClick={onCancelDelete}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="spark-btn is-danger"
            onClick={onConfirmDelete}
            disabled={deleting}
          >
            {deleting ? "Deleting…" : deleteMemory ? "Delete session + memory" : "Delete session"}
          </button>
        </div>
      </div>
    );
  }

  // The whole row resumes: the resume control spans everything left of the
  // trash, so there is no small target to aim for and no loud pill on every
  // line. The arrow fades in on the highlighted row instead — an opacity
  // change, so moving down the list never reflows the row.
  return (
    <div
      data-session-index={index}
      role="listitem"
      aria-current={selected ? "true" : undefined}
      className="worker-session-row"
      onMouseEnter={onHover}
      style={{
        ...shell,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "center",
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onFocus={onHover}
        onClick={onOpen}
        title={
          session.preview
            ? `Resume ${session.title}\n${session.preview}`
            : `Resume ${session.title}`
        }
        aria-label={`Resume ${session.title}`}
        style={{
          appearance: "none",
          width: "100%",
          minHeight: ROW_HEIGHT,
          border: "none",
          background: "transparent",
          color: "inherit",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 12px",
          gap: 8,
          alignItems: "center",
          padding: "8px 4px 8px 12px",
          textAlign: "left",
          cursor: "default",
        }}
      >
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12.5,
              fontWeight: 600,
              lineHeight: 1.3,
            }}
          >
            {session.title}
          </span>
          <span
            style={{
              display: "block",
              marginTop: 2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: error ? "var(--danger)" : "var(--muted)",
              fontFamily:
                error || session.preview ? "var(--font-sans)" : "var(--font-mono)",
              fontSize: error ? 9.5 : 10,
              lineHeight: 1.4,
            }}
          >
            {error ??
              `${relativeTime(session.updatedAt)} · ${
                session.preview ?? shortSessionId(session.sessionId)
              }`}
          </span>
        </span>
        <span
          aria-hidden
          style={{
            color: tint,
            fontSize: 13,
            lineHeight: 1,
            opacity: selected ? 1 : 0,
            transition: "opacity var(--motion-fast) var(--ease-out)",
          }}
        >
          →
        </span>
      </button>
      <span style={{ display: "flex", alignItems: "center", padding: "0 8px 0 2px" }}>
        <button
          type="button"
          className="spark-icon-btn"
          disabled={disabled || deleting}
          onMouseEnter={() => {
            setTrashHover(true);
            onHover();
          }}
          onMouseLeave={() => setTrashHover(false)}
          onFocus={onHover}
          onClick={onArmDelete}
          title="Delete session"
          aria-label={`Delete session ${session.title}`}
          style={{
            cursor: "default",
            color: trashHover ? "var(--danger)" : "var(--muted)",
            background: trashHover
              ? "color-mix(in oklch, var(--danger) 12%, transparent)"
              : "transparent",
          }}
        >
          <TrashIcon />
        </button>
      </span>
    </div>
  );
}

// Short forms of the Settings → Sessions memory copy. The row only has one
// line for it, so the full sentence rides along as the label's tooltip.
function memoryScopeLabel(runtime: WorkerSessionRuntime): string {
  return runtime === "claude"
    ? "Also delete this Claude project's auto-memory"
    : "Also delete ALL local Codex memories";
}

function memoryScopeDetail(runtime: WorkerSessionRuntime): string {
  return runtime === "claude"
    ? "Also delete this Claude project's auto-memory. This affects every Claude session sharing that project memory."
    : "Also delete ALL local Codex memories. This affects every Codex project and session on this machine.";
}

function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4.2h8" />
      <path d="M5.4 4.2V3.2a1 1 0 0 1 1-1h1.2a1 1 0 0 1 1 1v1" />
      <path d="M4 4.2 4.5 11a1 1 0 0 0 1 .9h3a1 1 0 0 0 1-.9L10 4.2" />
    </svg>
  );
}

function RuntimeChip({ runtime }: { runtime: WorkerSessionRuntime }) {
  const color = agentBrandColor(runtime);
  return (
    <span
      aria-hidden
      style={{
        width: 40,
        height: 40,
        borderRadius: 12,
        display: "grid",
        placeItems: "center",
        color,
        background: `color-mix(in oklch, ${color} 16%, var(--panel-2))`,
        border: `1px solid color-mix(in oklch, ${color} 38%, transparent)`,
        boxShadow: "var(--lift-hi)",
        flex: "0 0 40px",
      }}
    >
      <RuntimeMark runtime={runtime} size={18} />
    </span>
  );
}

function QuietState({
  text,
  danger = false,
}: {
  text: string;
  danger?: boolean;
}) {
  return (
    <div
      style={{
        padding: "14px 4px 6px",
        color: danger ? "var(--danger)" : "var(--muted)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      {text}
    </div>
  );
}

function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

function sessionKey(session: WorkerSessionSummary): string {
  return `${session.runtime}:${session.sessionId}`;
}

function shortSessionId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently";
  const deltaMinutes = Math.round((timestamp - Date.now()) / 60_000);
  const abs = Math.abs(deltaMinutes);
  if (abs < 1) return "Just now";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60) return formatter.format(deltaMinutes, "minute");
  const hours = Math.round(deltaMinutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp);
}

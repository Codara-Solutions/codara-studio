import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkerSessionMemoryScope,
  WorkerSessionRuntime,
  WorkerSessionSummary,
} from "@shared/types";

import { CloseIcon, PlusIcon } from "./icons";
import type { TerminalAgentSession } from "../tabs/types";
import {
  CLAUDE_LAUNCH_COMMAND,
  CODEX_LAUNCH_COMMAND,
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

const ROW_HEIGHT = 76;
const VISIBLE_ROWS = 5;

export default function WorkerSessionPicker({
  request,
  onClose,
}: WorkerSessionPickerProps) {
  const [sessions, setSessions] = useState<WorkerSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
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
    setSelectedIndex(0);
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
    const selected = listRef.current?.querySelector<HTMLElement>(
      `[data-session-index="${selectedIndex}"]`,
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, sessions.length]);

  // Deleting the last row would leave the highlight past the end of the list.
  useEffect(() => {
    setSelectedIndex((index) =>
      sessions.length === 0 ? 0 : Math.min(index, sessions.length - 1),
    );
  }, [sessions.length]);

  const runtimeLabel = request?.runtime === "claude" ? "Claude Code" : "Codex";
  const workspaceLabel = useMemo(
    () => (request ? compactPath(request.cwd) : ""),
    [request],
  );

  if (!request) return null;

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
      request.runtime === "claude" ? CLAUDE_LAUNCH_COMMAND : CODEX_LAUNCH_COMMAND,
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
    const session = sessions[selectedIndex];
    const armed = session ? sessionKey(session) === pendingDeleteKey : false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % sessions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => (index - 1 + sessions.length) % sessions.length);
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
      if (event.repeat || !session) return;
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
        padding: "58px 22px 24px",
        fontFamily: "var(--font-sans)",
      }}
      className="spark-fade-in"
      onMouseDown={onClose}
    >
      <div className="spark-scrim" style={{ zIndex: 0 }} />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${runtimeLabel} sessions`}
        tabIndex={-1}
        className="spark-glass--strong"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        style={{
          position: "relative",
          zIndex: 1,
          width: "min(640px, calc(100vw - 44px))",
          maxHeight: "calc(100vh - 88px)",
          display: "flex",
          flexDirection: "column",
          borderRadius: 14,
          overflow: "hidden",
          outline: "none",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "15px 16px",
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          <RuntimeMark runtime={request.runtime} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                color: "var(--ink)",
                fontSize: 15,
                fontWeight: 700,
                letterSpacing: "-0.01em",
              }}
            >
              Open {runtimeLabel} worker
            </div>
            <div
              title={request.cwd}
              style={{
                marginTop: 2,
                color: "var(--muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
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
            padding: "14px 15px 15px",
            minHeight: 176,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <button
            type="button"
            onClick={() => void launchNew()}
            disabled={launching}
            style={{
              appearance: "none",
              width: "100%",
              minHeight: 72,
              display: "grid",
              gridTemplateColumns: "42px minmax(0, 1fr) auto",
              alignItems: "center",
              gap: 12,
              padding: "11px 13px",
              textAlign: "left",
              color: "var(--ink)",
              border: "1px solid var(--accent-edge)",
              borderRadius: 11,
              background:
                "linear-gradient(135deg, color-mix(in oklch, var(--accent) 15%, transparent), color-mix(in oklab, var(--panel) 88%, transparent))",
              boxShadow: "var(--lift-hi), inset 0 1px 0 color-mix(in oklab, white 5%, transparent)",
              cursor: "default",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 42,
                height: 42,
                display: "grid",
                placeItems: "center",
                color: "var(--accent-ink)",
                borderRadius: 10,
                background: "var(--accent)",
                boxShadow: "0 8px 22px var(--accent-glow)",
              }}
            >
              <PlusIcon size={13} />
            </span>
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "-0.01em",
                }}
              >
                Start a new session
              </span>
              <span
                style={{
                  display: "block",
                  marginTop: 4,
                  color: "var(--muted)",
                  fontSize: 10.5,
                  lineHeight: 1.4,
                }}
              >
                Open a fresh {runtimeLabel} worker in this workspace.
              </span>
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "var(--accent)",
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              New
              <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
                →
              </span>
            </span>
          </button>

          <div
            style={{
              minHeight: 30,
              display: "flex",
              alignItems: "end",
              justifyContent: "space-between",
              gap: 12,
              padding: "0 3px",
            }}
          >
            <span>
              <span
                className="spark-eyebrow"
                style={{ display: "block", color: "var(--ink-dim)" }}
              >
                Continue working
              </span>
              <span
                style={{
                  display: "block",
                  marginTop: 3,
                  color: "var(--muted)",
                  fontSize: 10,
                }}
              >
                Recent sessions in this workspace
              </span>
            </span>
            {!loading && !error ? (
              <span
                style={{
                  minWidth: 24,
                  height: 20,
                  display: "grid",
                  placeItems: "center",
                  padding: "0 7px",
                  color: "var(--muted)",
                  border: "1px solid var(--rule-soft)",
                  borderRadius: 999,
                  background: "var(--panel-2)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 9,
                }}
              >
                {sessions.length}
              </span>
            ) : null}
          </div>
          {loading ? (
            <EmptyState title="Reading sessions" detail="Checking the local transcript history…" />
          ) : error ? (
            <EmptyState title="History unavailable" detail={error} danger />
          ) : sessions.length === 0 ? (
            <EmptyState
              title="No resumable sessions"
              detail={`Start a new ${runtimeLabel} session in this directory.`}
            />
          ) : (
            <div
              ref={listRef}
              // A list, not a listbox: each row carries its own open and
              // delete buttons, and role="option" may not contain interactive
              // children. Arrow / Enter / Delete keep working because the
              // whole picker's key handling lives on the dialog, not on a
              // roving-tabindex option list.
              role="list"
              aria-label={`${runtimeLabel} session history`}
              style={{
                maxHeight: ROW_HEIGHT * VISIBLE_ROWS,
                overflowY: sessions.length > VISIBLE_ROWS ? "auto" : "hidden",
                border: "1px solid var(--rule)",
                borderRadius: 11,
                background: "color-mix(in oklab, var(--panel) 88%, transparent)",
                boxShadow: "var(--well), inset 0 1px 0 color-mix(in oklab, white 3%, transparent)",
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
          {notice ? (
            <div
              role="status"
              style={{
                margin: "-6px 3px 0",
                color: "var(--muted)",
                fontSize: 10,
                lineHeight: 1.45,
              }}
            >
              {notice}
            </div>
          ) : null}
          {!loading && !error && sessions.length > VISIBLE_ROWS ? (
            <div
              style={{
                margin: "-6px 3px 0",
                color: "var(--muted)",
                fontSize: 10,
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>{sessions.length} sessions</span>
              <span>Scroll for more</span>
            </div>
          ) : null}
        </div>
      </section>
    </div>
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
  const shell: React.CSSProperties = {
    minHeight: ROW_HEIGHT,
    borderBottom: "1px solid var(--rule-soft)",
    background: armed
      ? "color-mix(in oklch, var(--danger) 8%, var(--panel))"
      : selected
        ? "color-mix(in oklch, var(--accent) 11%, var(--panel))"
        : "transparent",
    color: "var(--ink)",
    boxShadow: armed
      ? "inset 2px 0 0 var(--danger)"
      : selected
        ? "inset 2px 0 0 var(--accent)"
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
        style={{ ...shell, display: "grid", gap: 8, padding: "11px 12px" }}
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

  return (
    <div
      data-session-index={index}
      role="listitem"
      aria-current={selected ? "true" : undefined}
      onMouseEnter={onHover}
      style={{
        ...shell,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "stretch",
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onFocus={onHover}
        onClick={onOpen}
        title={`Resume ${session.title}`}
        style={{
          appearance: "none",
          width: "100%",
          minHeight: ROW_HEIGHT,
          border: "none",
          background: "transparent",
          color: "inherit",
          display: "grid",
          gridTemplateColumns: "18px minmax(0, 1fr) auto",
          gap: 11,
          alignItems: "center",
          padding: "10px 6px 10px 12px",
          textAlign: "left",
          cursor: "default",
        }}
      >
        <span
          aria-hidden
          style={{
            position: "relative",
            width: 18,
            alignSelf: "stretch",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 17,
              width: 8,
              height: 8,
              borderRadius: 999,
              background: selected ? "var(--accent)" : "var(--muted-2)",
              boxShadow: selected ? "0 0 0 3px var(--accent-soft)" : "none",
            }}
          />
          <span
            style={{
              position: "absolute",
              top: 29,
              bottom: -11,
              width: 1,
              background: "var(--rule)",
            }}
          />
        </span>
        <span style={{ minWidth: 0 }}>
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: 12.5,
              fontWeight: 650,
              lineHeight: 1.35,
            }}
          >
            {session.title}
          </span>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginTop: 6,
              color: error ? "var(--danger)" : "var(--muted)",
              fontSize: 9.5,
            }}
          >
            {error ? (
              <span
                style={{
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {error}
              </span>
            ) : (
              <>
                <span>{relativeTime(session.updatedAt)}</span>
                <span aria-hidden style={{ color: "var(--rule-strong)" }}>
                  •
                </span>
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    letterSpacing: "0.02em",
                  }}
                >
                  {shortSessionId(session.sessionId)}
                </span>
              </>
            )}
          </span>
        </span>
        <span
          style={{
            minHeight: 26,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            color: selected ? "var(--accent)" : "var(--ink-dim)",
            border: `1px solid ${selected ? "var(--accent-edge)" : "var(--rule-soft)"}`,
            borderRadius: 7,
            background: selected ? "var(--accent-soft)" : "var(--panel-2)",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          Resume
          <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
            →
          </span>
        </span>
      </button>
      <span style={{ display: "flex", alignItems: "center", padding: "0 10px 0 2px" }}>
        <button
          type="button"
          className="spark-icon-btn"
          disabled={disabled || deleting}
          onMouseEnter={onHover}
          onFocus={onHover}
          onClick={onArmDelete}
          title="Delete session"
          aria-label={`Delete session ${session.title}`}
          style={{ cursor: "default", color: "var(--muted)" }}
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

function RuntimeMark({ runtime }: { runtime: WorkerSessionRuntime }) {
  const codex = runtime === "codex";
  const color = codex ? "var(--info)" : "var(--accent)";
  return (
    <span
      aria-hidden
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        display: "grid",
        placeItems: "center",
        color,
        background: `color-mix(in oklch, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 34%, transparent)`,
        fontFamily: "var(--font-mono)",
        fontWeight: 800,
        fontSize: 14,
        boxShadow: `0 8px 22px color-mix(in oklch, ${color} 16%, transparent), var(--lift-hi)`,
        flex: "0 0 36px",
      }}
    >
      {codex ? "X" : "C"}
    </span>
  );
}

function EmptyState({
  title,
  detail,
  danger = false,
}: {
  title: string;
  detail: string;
  danger?: boolean;
}) {
  return (
    <div
      style={{
        minHeight: 112,
        border: "1px dashed var(--rule)",
        borderRadius: 11,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        padding: 20,
        background: "color-mix(in oklab, var(--panel) 74%, transparent)",
        textAlign: "center",
      }}
    >
      <span style={{ color: danger ? "var(--danger)" : "var(--ink)", fontSize: 12, fontWeight: 650 }}>
        {title}
      </span>
      <span style={{ color: "var(--muted)", fontSize: 10, lineHeight: 1.45 }}>{detail}</span>
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

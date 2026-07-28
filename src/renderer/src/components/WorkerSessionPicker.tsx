import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
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
  const dialogRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setSessions([]);
    setError(null);
    setSelectedIndex(0);
    setLoading(true);
    setLaunching(false);
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

  const runtimeLabel = request?.runtime === "claude" ? "Claude Code" : "Codex";
  const workspaceLabel = useMemo(
    () => (request ? compactPath(request.cwd) : ""),
    [request],
  );

  if (!request) return null;

  const prepareCodex = async () => {
    if (request.runtime === "codex") {
      await window.spark.agentSession.ensureCodexTrust(request.cwd).catch(() => undefined);
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
    await prepareCodex();
    const pointer: TerminalAgentSession = {
      runtime: session.runtime,
      sessionId: session.sessionId,
      cwd: request.cwd,
      transcriptPath: session.transcriptPath,
      capturedAt: new Date().toISOString(),
      active: false,
    };
    request.launch(buildAgentResumeCommand(pointer), pointer);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (sessions.length === 0) {
      if (event.key === "Enter") {
        event.preventDefault();
        void launchNew();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => (index + 1) % sessions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => (index - 1 + sessions.length) % sessions.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const session = sessions[selectedIndex];
      if (session) void resume(session);
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
              role="listbox"
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
              {sessions.map((session, index) => (
                <SessionRow
                  key={`${session.runtime}:${session.sessionId}`}
                  index={index}
                  session={session}
                  selected={index === selectedIndex}
                  onHover={() => setSelectedIndex(index)}
                  onOpen={() => void resume(session)}
                  disabled={launching}
                />
              ))}
            </div>
          )}
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

function SessionRow({
  index,
  session,
  selected,
  onHover,
  onOpen,
  disabled,
}: {
  index: number;
  session: WorkerSessionSummary;
  selected: boolean;
  onHover: () => void;
  onOpen: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      data-session-index={index}
      role="option"
      aria-selected={selected}
      disabled={disabled}
      onMouseEnter={onHover}
      onFocus={onHover}
      onClick={onOpen}
      style={{
        appearance: "none",
        width: "100%",
        height: ROW_HEIGHT,
        border: "none",
        borderBottom: "1px solid var(--rule-soft)",
        background: selected
          ? "color-mix(in oklch, var(--accent) 11%, var(--panel))"
          : "transparent",
        color: "var(--ink)",
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr) auto",
        gap: 11,
        alignItems: "center",
        padding: "10px 12px",
        textAlign: "left",
        cursor: "default",
        boxShadow: selected ? "inset 2px 0 0 var(--accent)" : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
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
            color: "var(--muted)",
            fontSize: 9.5,
          }}
        >
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState, ShellInfo, Workspace } from "@shared/types";
import { backendPtySessionId } from "@shared/backend-pty";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import { CloseIcon, HistoryIcon } from "../icons";
import ChatConversation from "./ChatConversation";
import ChatComposer, { type ChatComposerStartConfig } from "./ChatComposer";
import { TerminalPane } from "../Terminal/TerminalPane";
import { describeRunStatus, statusToneColor } from "./timeline";

// Placeholder ShellInfo passed to TerminalPane when the underlying PTY was
// already spawned by main-process backend code (claude-backend, codex-backend).
// pty-manager's existing-session branch (line 143) ignores the shell when an
// id is already registered — but the React prop is typed required. Using a
// no-op exe avoids any chance of an accidental spawn if id-matching ever
// breaks.
const BACKEND_TERMINAL_SHELL: ShellInfo = {
  id: "spark-backend-attached",
  label: "Backend PTY",
  exe: "noop",
  args: [],
  family: "other",
};

type ChatView = "chat" | "terminal";

// The Spark chat panel: the workspace's chats live here, one conversation at
// a time. The header carries the live status; a switcher bar swaps between
// chats and starts new ones; the conversation and composer fill the rest.
// Each chat is a RunState; its node-graph view lives in a workbench tab.

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRun: RunState | null;
  error: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsible?: boolean;
  headerDrag?: SectionHeaderDragProps;
  // Chat / backend-PTY view mode. Optional during the transition — when not
  // provided, ChatPanel keeps a local state fallback and renders its own
  // inline Chat | Terminal strip (legacy path). When the hoisted inner tab
  // strip drives the mode, the legacy strip stays hidden.
  chatView?: ChatView;
  onChatViewChange?: (view: ChatView) => void;
  onStartChat: (
    message: string,
    clientMessageId: string,
    attachments?: AddRunMessageAttachmentInput[],
    chatConfig?: ChatComposerStartConfig,
  ) => RunState | void | Promise<RunState | void>;
  onForcePauseRun: () => void;
  // Open a past chat from the history popover. The handler is expected to
  // both select the run (so the conversation switches) and surface the
  // chat tab in the top strip; OrchestrationSidebar's handleSelectRun
  // already does both via its onSelectRun → openChatTab plumbing.
  onSelectChat?: (runId: string) => void;
  // Delete a past chat from the history popover. Confirmed inline before
  // dispatching. If the deleted chat was active, the parent is responsible
  // for clearing the active selection (OrchestrationSidebar.handleDeleteRun
  // already does this).
  onDeleteChat?: (runId: string) => void;
}

export default function ChatPanel({
  workspace,
  runs,
  activeRun,
  error,
  collapsed,
  onToggleCollapse,
  collapsible = true,
  headerDrag,
  chatView: chatViewProp,
  onChatViewChange,
  onStartChat,
  onForcePauseRun,
  onSelectChat,
  onDeleteChat,
}: Props) {
  // Per-chat view toggle. "chat" → ChatConversation (default). "terminal" →
  // raw xterm pane attached to the headless CC/Codex PTY this chat is
  // driving. The hoisted inner tab strip is the source of truth when it
  // provides chatViewProp + onChatViewChange. Local state is the fallback
  // for callers that have not lifted the toggle (kept so the component
  // stays usable in isolation, e.g. tests).
  const [localChatView, setLocalChatView] = useState<ChatView>("chat");
  const chatView = chatViewProp ?? localChatView;
  const setChatView = useCallback(
    (next: ChatView) => {
      if (onChatViewChange) onChatViewChange(next);
      else setLocalChatView(next);
    },
    [onChatViewChange],
  );
  const usingHoistedChatView = chatViewProp !== undefined;
  // A new chat starts in the normal conversation view. Terminal-view state
  // should not leak between runs because their PTYs are run-scoped. When the
  // parent owns chatView, the parent is also responsible for the reset —
  // re-applying it here would race with the parent.
  useEffect(() => {
    if (!usingHoistedChatView) setLocalChatView("chat");
  }, [activeRun?.id, usingHoistedChatView]);

  // OpenRouter chats have no PTY to attach to — force back to Chat view if
  // the backend doesn't support the terminal tab.
  const backendSessionId = activeRun
    ? backendPtySessionId(activeRun.id, activeRun.chatBackend)
    : null;
  useEffect(() => {
    if (!backendSessionId && chatView === "terminal") setChatView("chat");
  }, [backendSessionId, chatView]);

  // Poll for the backend PTY's existence. Mounting TerminalPane before the
  // cli-session has spawned the PTY triggers a renderer-side pty.spawn for
  // the placeholder "noop" shell, which fails with "File not found". Three
  // common cases where this matters:
  //   1. Fresh chat with chip=Claude/Codex — PTY doesn't exist yet
  //   2. After Spark restart — chatSessionUuid is persisted but the actual
  //      in-memory PTY is gone until the next turn re-spawns it
  //   3. Mid-chat backend switch — old PTY may still be alive, new isn't
  // Once the PTY exists, render TerminalPane; otherwise show a placeholder.
  const [backendPtyExists, setBackendPtyExists] = useState(false);
  useEffect(() => {
    if (!backendSessionId || chatView !== "terminal") {
      setBackendPtyExists(false);
      return;
    }
    let disposed = false;
    const check = async () => {
      try {
        const exists = await window.spark.pty.exists(backendSessionId);
        if (!disposed) setBackendPtyExists(exists);
      } catch {
        if (!disposed) setBackendPtyExists(false);
      }
    };
    void check();
    // 1s poll is cheap (Map.has() in main) and covers the gap between user
    // sending the first message and the cli-session resolving its spawn.
    const interval = window.setInterval(check, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [backendSessionId, chatView]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        background: "var(--panel)",
        fontFamily: "var(--font-sans)",
      }}
    >
      <SectionHeader
        label="Spark"
        glyph={<SparkMark size={13} />}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        collapsible={collapsible}
        {...headerDrag}
        meta={activeRun ? <HeaderMeta run={activeRun} /> : null}
        actions={
          onSelectChat ? (
            <ChatHistoryButton
              runs={runs}
              activeRunId={activeRun?.id ?? null}
              onSelect={onSelectChat}
              onDelete={onDeleteChat}
            />
          ) : null
        }
      />
      {!collapsed && (
        <>
          {activeRun && backendSessionId && !usingHoistedChatView && (
            <ChatViewTabStrip view={chatView} onChange={setChatView} />
          )}
          {error && <ErrorBar message={error} />}
          {activeRun ? (
            // Both views stack absolutely so each ALWAYS has real
            // dimensions, even when "hidden". xterm's fit-addon measures
            // its container at mount and on every ResizeObserver fire — if
            // the container were display:none (or render-conditional, like
            // the post-2d63dca origin/main version) the measurements would
            // be 0 and CC's Ink REPL would render into a tiny dead frame
            // in the top-left, then need a re-fit + pty.resize round-trip
            // on tab switch. On Windows ConPTY absorbs this; on macOS/Linux
            // POSIX PTYs leave the chat Terminal sub-tab mostly black
            // until orchestration produces enough output to redraw the
            // alt-screen frame. Stacking with visibility keeps both at
            // full size at all times — this matches Spark's original (pre-
            // 2d63dca) layout that worked cross-platform.
            <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  flexDirection: "column",
                  visibility: chatView === "chat" ? "visible" : "hidden",
                  pointerEvents: chatView === "chat" ? "auto" : "none",
                }}
              >
                <ChatConversation
                  key={`conversation:${activeRun.id}`}
                  run={activeRun}
                />
              </div>
              {backendSessionId && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    padding: 4,
                    background: "var(--bg)",
                    visibility: chatView === "terminal" ? "visible" : "hidden",
                    pointerEvents: chatView === "terminal" ? "auto" : "none",
                  }}
                >
                  {backendPtyExists ? (
                    <TerminalPane
                      // Keyed on sessionId so a backend switch (which changes
                      // the id) remounts the pane cleanly against the new
                      // PTY and discards xterm state from the old backend.
                      key={`backend-term:${backendSessionId}`}
                      sessionId={backendSessionId}
                      shell={BACKEND_TERMINAL_SHELL}
                      visible={chatView === "terminal"}
                      initialCwd={workspace?.cwd}
                      // inputBlocked (not readOnly): no keystrokes forwarded
                      // so the user can't collide with our bracketed paste +
                      // submit Enter, but pty.resize IS allowed so CC's Ink
                      // REPL paints into the actual visible cols/rows.
                      inputBlocked
                    />
                  ) : (
                    <BackendTerminalPlaceholder
                      backend={activeRun.chatBackend ?? null}
                    />
                  )}
                </div>
              )}
            </div>
          ) : (
            <WelcomeState />
          )}
          {chatView !== "terminal" && (
            <ChatComposer
              key={`composer:${activeRun?.id ?? "new-chat"}`}
              run={activeRun}
              cwd={workspace?.cwd ?? null}
              // Only block input when there's genuinely nothing to send to:
              // no workspace AND no active run. A follow-up to an existing run
              // goes through addRunMessage({runId}) and needs no workspace, so
              // an open chat must stay typeable even if `workspace` momentarily
              // resolves to null (e.g. a transient activeWorkspace gap after
              // deleting another run from history). Only the draft/new-chat
              // path (run === null) truly requires a workspace to start.
              disabled={!workspace && !activeRun}
              onStartChat={onStartChat}
              onForcePauseRun={onForcePauseRun}
            />
          )}
        </>
      )}
    </div>
  );
}

function HeaderMeta({ run }: { run: RunState }) {
  // Status + cost + run-id share one row to keep the SectionHeader compact.
  // The cost pill hides itself until the run records a priced manager call;
  // the id chip is always shown so the user has something to copy and share
  // for support / debugging on every chat.
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        whiteSpace: "nowrap",
      }}
    >
      <StatusMeta run={run} />
      <CostPill run={run} />
      <RunIdChip runId={run.id} />
    </span>
  );
}

// Copyable run-id chip. Click → writes the full id to the clipboard and
// flips the label to "Copied" for ~1.2s. The displayed text is truncated to
// stay narrow in the header; the tooltip carries the full id so power users
// can still read it without copying.
function RunIdChip({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  const short = runId.length > 12 ? `${runId.slice(0, 12)}…` : runId;
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const writer = navigator.clipboard?.writeText?.(runId);
      const settle = () => {
        setCopied(true);
        if (timerRef.current != null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1200);
      };
      if (writer && typeof writer.then === "function") {
        writer.then(settle).catch(() => {
          /* clipboard blocked — silently no-op */
        });
      } else {
        settle();
      }
    },
    [runId],
  );
  return (
    <button
      type="button"
      onClick={handleClick}
      title={copied ? "Copied run ID to clipboard" : `Copy run ID: ${runId}`}
      aria-label="Copy run ID"
      style={{
        appearance: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 7px",
        borderRadius: 999,
        border: copied ? "1px solid var(--accent-edge)" : "1px solid var(--rule-soft)",
        background: copied ? "var(--accent-soft)" : "var(--panel-2)",
        color: copied ? "var(--accent)" : "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        whiteSpace: "nowrap",
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span aria-hidden style={{ color: "var(--muted)" }}>id</span>
      <span>{copied ? "copied" : short}</span>
    </button>
  );
}

// History popover: lists every persisted chat for this workspace, newest
// first, so the user can jump back into an old one. Clicking a row calls
// onSelect(runId) — the OrchestrationSidebar wires that to handleSelectRun,
// which both swaps the active chat AND opens (or focuses) its tab in the
// top strip. Resume happens implicitly: typing into the composer of the
// reopened chat invokes resumeRun on the next turn.
function ChatHistoryButton({
  runs,
  activeRunId,
  onSelect,
  onDelete,
}: {
  runs: RunState[];
  activeRunId: string | null;
  onSelect: (runId: string) => void;
  onDelete?: (runId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click or Escape — same pattern as TabBar's "+" picker.
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
    const score = (run: RunState) => {
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
        onClick={() => setOpen((v) => !v)}
        title="Chat history"
        aria-label="Open chat history"
        aria-expanded={open}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          appearance: "none",
          width: 22,
          height: 22,
          border: "none",
          borderRadius: 6,
          background: open
            ? "var(--accent-soft)"
            : hover
              ? "var(--hover)"
              : "transparent",
          color: open ? "var(--accent)" : hover ? "var(--ink)" : "var(--ink-dim)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <HistoryIcon size={12} />
      </button>
      {open && (
        <ChatHistoryPopover
          runs={sortedRuns}
          activeRunId={activeRunId}
          onPick={(id) => {
            setOpen(false);
            onSelect(id);
          }}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function ChatHistoryPopover({
  runs,
  activeRunId,
  onPick,
  onDelete,
}: {
  runs: RunState[];
  activeRunId: string | null;
  onPick: (runId: string) => void;
  onDelete?: (runId: string) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="Recent chats"
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        right: 0,
        zIndex: 50,
        width: 300,
        maxHeight: "min(50vh, 420px)",
        overflowY: "auto",
        background: "var(--panel-2, var(--panel))",
        border: "1px solid var(--rule-soft)",
        borderRadius: 9,
        boxShadow: "var(--shadow-2)",
        padding: 4,
      }}
    >
      <div
        style={{
          padding: "6px 8px 5px",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 700,
          color: "var(--muted)",
          textTransform: "uppercase",
          letterSpacing: "0.14em",
        }}
      >
        Recent chats
      </div>
      {runs.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 4,
            padding: "18px 8px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "var(--muted)",
            }}
          >
            No chats yet
          </div>
          <div style={{ fontSize: 11, color: "var(--muted-2)", lineHeight: 1.5 }}>
            Start one below to see it here.
          </div>
        </div>
      ) : (
        runs.map((run) => (
          <ChatHistoryRow
            key={run.id}
            run={run}
            active={run.id === activeRunId}
            onClick={() => onPick(run.id)}
            onDelete={onDelete}
          />
        ))
      )}
    </div>
  );
}

function ChatHistoryRow({
  run,
  active,
  onClick,
  onDelete,
}: {
  run: RunState;
  active: boolean;
  onClick: () => void;
  onDelete?: (runId: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const status = describeRunStatus(run);
  const dotColor = statusToneColor(status.tone);
  const ts = run.updatedAt ?? run.completedAt ?? run.createdAt;
  const relTime = ts ? formatRelativeTime(ts) : "";
  // No native confirm dialog — the DeleteChatButton arms on the first click
  // and only deletes on the second (in-app "double-click to delete"), so this
  // just performs the actual removal once confirmed.
  const confirmDelete = () => {
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
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: 3,
        width: "100%",
        padding: "7px 8px",
        background: active
          ? "var(--accent-soft)"
          : hover
            ? "var(--hover)"
            : "transparent",
        border: active
          ? "1px solid var(--accent-edge)"
          : "1px solid transparent",
        boxShadow: active ? "var(--shadow-glow)" : "none",
        borderRadius: 6,
        textAlign: "left",
        cursor: "default",
        color: "var(--ink)",
        outline: "none",
        boxSizing: "border-box",
        transition:
          "background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: dotColor,
            flex: "0 0 6px",
            animation:
              status.tone === "live" ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
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
          {run.title || "Untitled chat"}
        </span>
        {relTime && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted)",
              flex: "0 0 auto",
            }}
          >
            {relTime}
          </span>
        )}
        {onDelete && <DeleteChatButton visible={hover} onConfirm={confirmDelete} />}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: 12,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: "var(--font-mono)",
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
        <RunIdChip runId={run.id} />
      </div>
    </div>
  );
}

// In-app delete confirmation (no native OS dialog). First click arms the
// button — it turns red and reads "Delete?"; a second click within a few
// seconds performs the delete. Moving the pointer away or waiting disarms it,
// so an accidental single click never destroys anything.
function DeleteChatButton({
  visible,
  onConfirm,
}: {
  visible: boolean;
  onConfirm: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<number | null>(null);

  // Auto-disarm so a half-finished delete doesn't stay primed indefinitely.
  useEffect(() => {
    if (!armed) return;
    disarmTimer.current = window.setTimeout(() => setArmed(false), 2600);
    return () => {
      if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    };
  }, [armed]);

  const handleClick = (e: React.MouseEvent) => {
    // Never let the row's onClick (which opens the chat) fire from here.
    e.stopPropagation();
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onConfirm();
  };

  // Stay interactive while armed even if the row hover ended, so the second
  // (confirm) click is always reachable.
  const shown = visible || armed;
  return (
    <button
      type="button"
      title={armed ? "Click again to delete permanently" : "Delete chat"}
      aria-label={armed ? "Confirm delete chat" : "Delete chat"}
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setArmed(false);
      }}
      style={{
        appearance: "none",
        width: armed ? "auto" : 18,
        height: 18,
        border: "none",
        borderRadius: 4,
        background: armed
          ? "var(--danger)"
          : hover
            ? "var(--danger-soft)"
            : "transparent",
        color: armed ? "var(--accent-ink)" : hover ? "var(--danger)" : "var(--muted)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: armed ? "0 6px" : 0,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: "nowrap",
        cursor: "default",
        flex: "0 0 auto",
        opacity: shown ? 1 : 0,
        transition:
          "opacity 120ms ease, background 120ms ease, color 120ms ease",
        pointerEvents: shown ? "auto" : "none",
      }}
    >
      {armed ? "Delete?" : <CloseIcon size={11} />}
    </button>
  );
}

// Compact "5m / 3h / 2d / 1w" formatter for the history popover. We pick the
// largest unit that fits and drop everything below so the timestamp stays
// glanceable in a tight row.
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
  const yr = Math.floor(day / 365);
  return `${yr}y`;
}

function StatusMeta({ run }: { run: RunState }) {
  const status = describeRunStatus(run);
  const color = statusToneColor(status.tone);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        color: "var(--muted)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          flex: "0 0 6px",
          animation: status.tone === "live" ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
        }}
      />
      <span style={{ color: "var(--ink-dim)" }}>{status.label}</span>
      {status.detail && <span>{status.detail}</span>}
    </span>
  );
}

// Live total of every priced manager (OpenRouter) call on this run, sourced
// from the run-store `totalCostUsd` rollup that recomputes after each call.
// Worker-side LLM cost is not yet tracked — Spark only sees the manager's
// OpenRouter usage today. Hidden until at least one priced call has landed
// so chats that ran before the price-table existed don't surface a fake $0.
function CostPill({ run }: { run: RunState }) {
  const total = run.totalCostUsd;
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  return (
    <span
      title={`OpenRouter manager spend on this chat: ${formatCostUsd(total)}. Worker LLM cost is not tracked yet.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 18,
        padding: "0 7px",
        borderRadius: 999,
        border: "1px solid var(--rule-soft)",
        background: "var(--panel-2)",
        color: "var(--ink-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ color: "var(--muted)" }}>$</span>
      <span>{formatCostUsd(total, { stripDollar: true })}</span>
    </span>
  );
}

// Cost is sub-cent for cheap models and tens of dollars for big runs, so a
// single fixed precision feels wrong. The pill renders 2 decimals once a run
// crosses 1¢ and 4 decimals below, so users see real activity even on
// gemini-flash chats.
function formatCostUsd(value: number, opts: { stripDollar?: boolean } = {}): string {
  const abs = Math.abs(value);
  let formatted: string;
  if (abs >= 0.01) formatted = value.toFixed(2);
  else if (abs >= 0.0001) formatted = value.toFixed(4);
  else if (abs > 0) formatted = "<0.0001";
  else formatted = "0.00";
  if (opts.stripDollar) return formatted;
  return formatted.startsWith("<") ? `<$0.0001` : `$${formatted}`;
}



function WelcomeState() {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "28px 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--accent-soft)",
          border: "1px solid var(--accent-edge)",
          boxShadow: "var(--lift-hi)",
        }}
      >
        <SparkMark size={20} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.14em",
            color: "var(--muted)",
          }}
        >
          New chat
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>
          Start a chat with Spark
        </div>
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--muted)",
            maxWidth: 268,
          }}
        >
          Describe a task. Spark plans it, spawns Claude, Codex, and Cursor
          workers, and reports back. Or right-click a plan file in the explorer
          to run it.
        </div>
      </div>
    </div>
  );
}

function BackendTerminalPlaceholder({ backend }: { backend: string | null }) {
  const label = backend === "codex" ? "Codex" : "Claude Code";
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        color: "var(--muted)",
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        textAlign: "center",
        padding: 16,
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          color: "var(--muted)",
        }}
      >
        Terminal idle
      </div>
      <div style={{ color: "var(--muted-2)", maxWidth: 260 }}>
        {label} hasn't been spawned for this chat yet. Send a message to start
        the session — its terminal will appear here.
      </div>
    </div>
  );
}

function ChatViewTabStrip({
  view,
  onChange,
}: {
  view: ChatView;
  onChange: (view: ChatView) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        flex: "0 0 auto",
        display: "flex",
        gap: 2,
        padding: "4px 8px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "transparent",
      }}
    >
      <ChatViewTab label="Chat" active={view === "chat"} onClick={() => onChange("chat")} />
      <ChatViewTab
        label="Terminal"
        active={view === "terminal"}
        onClick={() => onChange("terminal")}
        title="Live xterm attached to the backend Claude/Codex PTY for this chat — read-only."
      />
    </div>
  );
}

function ChatViewTab({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title ?? label}
      style={{
        appearance: "none",
        padding: "4px 10px",
        fontSize: 11,
        fontWeight: active ? 600 : 500,
        fontFamily: "var(--font-sans)",
        background: active
          ? "var(--accent-soft)"
          : hover
            ? "var(--hover)"
            : "transparent",
        color: active ? "var(--accent)" : hover ? "var(--ink-dim)" : "var(--muted)",
        border: active ? "1px solid var(--accent-edge)" : "1px solid transparent",
        borderRadius: 6,
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      {label}
    </button>
  );
}

function ErrorBar({ message }: { message: string }) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        padding: "7px 12px",
        background: "var(--danger-soft)",
        borderBottom: "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
        color: "var(--danger)",
        fontSize: 11,
        lineHeight: 1.4,
      }}
    >
      {message}
    </div>
  );
}


function SparkMark({ size = 13 }: { size?: number }) {
  return (
    <span aria-hidden style={{ display: "inline-flex", color: "var(--accent)" }}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}


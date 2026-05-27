import React, { useEffect, useRef, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState, ShellInfo, Workspace } from "@shared/types";
import { backendPtySessionId } from "@shared/backend-pty";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import { GridIcon, PlusIcon } from "../icons";
import ChatConversation from "./ChatConversation";
import ChatComposer, { type ChatComposerStartConfig } from "./ChatComposer";
import SwarmView from "./SwarmView";
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
  busy: boolean;
  error: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  collapsible?: boolean;
  headerDrag?: SectionHeaderDragProps;
  onSelectRun: (id: string | null) => void;
  onDeleteRun: (id: string) => void;
  onStartChat: (
    message: string,
    clientMessageId: string,
    attachments?: AddRunMessageAttachmentInput[],
    chatConfig?: ChatComposerStartConfig,
  ) => RunState | void | Promise<RunState | void>;
  onForcePauseRun: () => void;
}

export default function ChatPanel({
  workspace,
  runs,
  activeRun,
  busy,
  error,
  collapsed,
  onToggleCollapse,
  collapsible = true,
  headerDrag,
  onSelectRun,
  onDeleteRun,
  onStartChat,
  onForcePauseRun,
}: Props) {
  // Swarm view toggle — flips the chat body from the normal
  // conversation+composer layout to a grid of live worker terminals. State
  // is scoped to this panel so the toggle survives switching tabs but
  // resets if the section is collapsed (the toolbar disappears anyway).
  // Per-chat keying via run.id means a chat that has no swarm-worthy
  // workers can still flip in/out without other chats inheriting the state.
  const [swarmActive, setSwarmActive] = useState(false);
  // Per-chat view toggle. "chat" → ChatConversation (default). "terminal" →
  // raw xterm pane attached to the headless CC/Codex PTY this chat is
  // driving. Lets you see exactly what the underlying CLI is rendering /
  // submitting / printing, useful for debugging hook fires, slash-command
  // responses, and weird interactive states.
  const [chatView, setChatView] = useState<ChatView>("chat");
  // Drop swarm mode when there is no active chat to render workers from —
  // the swarm grid needs a RunState. Also drop it when the section is
  // collapsed: the user can't see the toggle so the only way back out
  // would be expand + toggle.
  useEffect(() => {
    if (!activeRun) setSwarmActive(false);
  }, [activeRun]);
  useEffect(() => {
    if (collapsed) setSwarmActive(false);
  }, [collapsed]);
  // Reset to Chat view when switching to a different chat — the terminal
  // tab is per-chat (each chat's PTY is keyed by run.id) and a fresh chat
  // shouldn't inherit the previous one's view. Also reset when there's no
  // active chat at all.
  useEffect(() => {
    if (!activeRun) setChatView("chat");
  }, [activeRun?.id]);
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
    if (!backendSessionId) {
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
  }, [backendSessionId]);

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
          <>
            {activeRun && (
              <SwarmToggleButton
                active={swarmActive}
                onClick={() => setSwarmActive((value) => !value)}
              />
            )}
            <NewChatButton onClick={() => onSelectRun(null)} />
          </>
        }
      />
      {!collapsed && (
        <>
          <SwitcherBar
            runs={runs}
            activeRun={activeRun}
            onSelectRun={onSelectRun}
            onDeleteRun={onDeleteRun}
          />
          {activeRun && !swarmActive && backendSessionId && (
            <ChatViewTabStrip view={chatView} onChange={setChatView} />
          )}
          {error && <ErrorBar message={error} />}
          {swarmActive && activeRun ? (
            // Swarm grid is keyed on the run id so flipping between chats
            // remounts the grid (and its TerminalPane instances) for the
            // new chat's worker set. Toggling swarm off+on within the same
            // chat reuses the same key, so xterm state survives the round
            // trip — and the underlying PTYs stay alive regardless because
            // useTerminalSession only disposes the renderer-side Terminal.
            <SwarmView
              key={`swarm:${activeRun.id}`}
              run={activeRun}
              cwd={workspace?.cwd ?? null}
            />
          ) : activeRun ? (
            chatView === "chat" ? (
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                <ChatConversation
                  key={`conversation:${activeRun.id}`}
                  run={activeRun}
                />
              </div>
            ) : backendSessionId ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  background: "var(--bg-deep, #0b0b0c)",
                }}
              >
                <div style={{ flex: 1, minHeight: 0, padding: 4 }}>
                  {backendPtyExists ? (
                    <TerminalPane
                      key={`backend-term:${backendSessionId}`}
                      sessionId={backendSessionId}
                      shell={BACKEND_TERMINAL_SHELL}
                      visible={true}
                      initialCwd={workspace?.cwd}
                      inputBlocked
                    />
                  ) : (
                    <BackendTerminalPlaceholder
                      backend={activeRun.chatBackend ?? null}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                <ChatConversation
                  key={`conversation:${activeRun.id}`}
                  run={activeRun}
                />
              </div>
            )
          ) : (
            <WelcomeState />
          )}
          {!swarmActive && (
            <ChatComposer
              key={`composer:${activeRun?.id ?? "new-chat"}`}
              run={activeRun}
              cwd={workspace?.cwd ?? null}
              disabled={!workspace}
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
  // Status + cost share one row to keep the SectionHeader compact. The pill
  // hides itself when the run hasn't recorded any cost yet (priced
  // manager call hasn't completed).
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
    </span>
  );
}

function SwarmToggleButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={active ? "Hide swarm grid" : "Show swarm grid (live worker terminals)"}
      aria-label="Toggle swarm view"
      aria-pressed={active}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 22,
        height: 22,
        border: "none",
        borderRadius: 5,
        background: active
          ? "color-mix(in oklch, var(--accent) 22%, transparent)"
          : hover
            ? "var(--hover)"
            : "transparent",
        color: active ? "var(--accent)" : hover ? "var(--ink)" : "var(--ink-dim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
      }}
    >
      <GridIcon size={12} />
    </button>
  );
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

function SwitcherBar({
  runs,
  activeRun,
  onSelectRun,
  onDeleteRun,
}: {
  runs: RunState[];
  activeRun: RunState | null;
  onSelectRun: (id: string | null) => void;
  onDeleteRun: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const activeRunId = activeRun?.id ?? null;
  const runsKey = runs.map((run) => run.id).join("\0");

  useEffect(() => {
    setOpen(false);
    setConfirmingDeleteId(null);
  }, [activeRunId, runsKey]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        barRef.current &&
        event.target instanceof Node &&
        !barRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeTone = activeRun ? describeRunStatus(activeRun).tone : null;
  const triggerColor = activeTone ? statusToneColor(activeTone) : "var(--muted)";
  // Only true `live` tones pulse — blocked/done-unseen are urgent in their
  // own way but should read as steady-state, not motion. Derive from the
  // tone (not `activeRun.status`) so any future status-to-tone changes flow
  // through automatically.
  const pulseTrigger = activeTone === "live";
  const doneUnseen = activeTone === "done-unseen";

  const pick = (id: string | null) => {
    setOpen(false);
    setConfirmingDeleteId(null);
    onSelectRun(id);
  };
  const requestDeleteChat = (id: string) => {
    setConfirmingDeleteId(id);
  };
  const cancelDeleteChat = () => {
    setConfirmingDeleteId(null);
  };
  const deleteChat = (id: string) => {
    setOpen(false);
    setConfirmingDeleteId(null);
    onDeleteRun(id);
  };

  return (
    <div
      ref={barRef}
      style={{
        position: "relative",
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 10px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          appearance: "none",
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 28,
          padding: "0 8px",
          border: "none",
          borderRadius: 7,
          background: open ? "var(--hover-strong)" : "transparent",
          cursor: "default",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (!open) e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          if (!open) e.currentTarget.style.background = "transparent";
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: triggerColor,
            flex: "0 0 7px",
            animation: pulseTrigger ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            fontSize: 12.5,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: activeRun ? "var(--ink)" : "var(--ink-dim)",
          }}
        >
          {activeRun ? `Chat - ${activeRun.title}` : "New chat"}
        </span>
        {doneUnseen && <DoneUnseenPill />}
        <span aria-hidden style={{ flex: "0 0 auto", color: "var(--muted)", fontSize: 9 }}>
          ▾
        </span>
      </button>
      {activeRun && <RunIdCopyChip runId={activeRun.id} />}
      {open && (
        <ChatList
          runs={runs}
          activeRunId={activeRunId}
          confirmingDeleteId={confirmingDeleteId}
          onPick={pick}
          onRequestDelete={requestDeleteChat}
          onCancelDelete={cancelDeleteChat}
          onConfirmDelete={deleteChat}
        />
      )}
    </div>
  );
}

const DROPDOWN_STYLE: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  zIndex: 30,
  border: "1px solid var(--rule-strong)",
  borderRadius: 8,
  background: "var(--panel-2)",
  boxShadow: "var(--shadow-2)",
  padding: 5,
};

function ChatList({
  runs,
  activeRunId,
  confirmingDeleteId,
  onPick,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  runs: RunState[];
  activeRunId: string | null;
  confirmingDeleteId: string | null;
  onPick: (id: string | null) => void;
  onRequestDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}) {
  return (
    <div style={{ ...DROPDOWN_STYLE, left: 10, right: 10 }}>
      <MenuRow onClick={() => onPick(null)}>
        <span style={{ display: "inline-flex", color: "var(--accent)" }}>
          <PlusIcon size={12} />
        </span>
        <span style={{ color: "var(--ink)", fontWeight: 600 }}>New chat</span>
      </MenuRow>
      {runs.length > 0 && (
        <div style={{ height: 1, background: "var(--rule)", margin: "4px 2px" }} />
      )}
      <div style={{ maxHeight: 256, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
        {runs.map((run) => (
          <ChatRow
            key={run.id}
            run={run}
            active={run.id === activeRunId}
            confirmingDelete={run.id === confirmingDeleteId}
            onPick={onPick}
            onRequestDelete={onRequestDelete}
            onCancelDelete={onCancelDelete}
            onConfirmDelete={onConfirmDelete}
          />
        ))}
      </div>
    </div>
  );
}

function ChatRow({
  run,
  active,
  confirmingDelete,
  onPick,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  run: RunState;
  active: boolean;
  confirmingDelete: boolean;
  onPick: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [trashHover, setTrashHover] = useState(false);
  const color = statusToneColor(describeRunStatus(run).tone);
  if (confirmingDelete) {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto auto",
          alignItems: "center",
          gap: 6,
          borderRadius: 6,
          padding: "5px 5px 5px 8px",
          background: "var(--danger-soft)",
        }}
      >
        <span
          title={`Delete ${run.title}`}
          style={{
            minWidth: 0,
            color: "var(--danger)",
            fontSize: 11.5,
            fontWeight: 650,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          Delete this chat?
        </span>
        <MiniMenuButton onClick={onCancelDelete}>Cancel</MiniMenuButton>
        <MiniMenuButton danger onClick={() => onConfirmDelete(run.id)}>
          Delete
        </MiniMenuButton>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        borderRadius: 6,
        padding: "0 4px 0 8px",
        background: active
          ? "color-mix(in oklch, var(--accent) 20%, transparent)"
          : hover
            ? "var(--hover)"
            : "transparent",
      }}
    >
      <button
        type="button"
        onClick={() => onPick(run.id)}
        title={run.title}
        style={{
          appearance: "none",
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 30,
          border: "none",
          background: "transparent",
          color: "inherit",
          padding: 0,
          cursor: "default",
          textAlign: "left",
        }}
      >
        <span
          aria-hidden
          style={{ width: 6, height: 6, borderRadius: 999, background: color, flex: "0 0 6px" }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: active ? 600 : 500,
            color: active ? "var(--ink)" : "var(--ink-dim)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {run.title}
        </span>
      </button>
      <button
        type="button"
        title="Delete chat"
        onClick={(event) => {
          event.stopPropagation();
          onRequestDelete(run.id);
        }}
        onMouseEnter={() => setTrashHover(true)}
        onMouseLeave={() => setTrashHover(false)}
        style={{
          appearance: "none",
          width: 22,
          height: 22,
          flex: "0 0 22px",
          border: "none",
          borderRadius: 5,
          background: trashHover ? "var(--danger-soft)" : "transparent",
          color: trashHover ? "var(--danger)" : "var(--muted)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          opacity: hover ? 1 : 0,
          transition: "opacity var(--motion-fast) var(--ease-out)",
        }}
      >
        <TrashGlyph />
      </button>
    </div>
  );
}

// "done · unseen" pill rendered in the SwitcherBar trigger when the active
// chat just finished while the user was elsewhere. Disappears once they
// focus the chat (which fires markRunSeen → tone becomes "done").
function shortRunId(id: string): string {
  const tail = id.split("-").pop();
  if (!tail) return id.slice(-6);
  return tail.slice(-6);
}

function RunIdCopyChip({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(runId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* Clipboard API can fail in non-secure contexts; degrade silently. */
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Run id: ${runId}\nClick to copy.`}
      style={{
        appearance: "none",
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 22,
        padding: "0 7px",
        background: copied
          ? "color-mix(in oklch, var(--ok) 14%, transparent)"
          : hover
            ? "var(--hover)"
            : "color-mix(in oklch, var(--panel-2) 80%, transparent)",
        color: copied ? "var(--ok)" : "var(--muted)",
        border: `1px solid ${
          copied
            ? "color-mix(in oklch, var(--ok) 45%, transparent)"
            : hover
              ? "var(--rule-strong)"
              : "var(--rule-soft)"
        }`,
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: "0.04em",
        cursor: "default",
        transition:
          "color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    >
      <span style={{ opacity: 0.7 }}>id</span>
      <span style={{ color: copied ? "var(--ok)" : "var(--ink-dim)" }}>
        #{shortRunId(runId)}
      </span>
      <span
        aria-hidden
        style={{
          width: 11,
          height: 11,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {copied ? (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 6.5l2.5 2.5L10 3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <path d="M2.5 8.5V2.5h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        )}
      </span>
    </button>
  );
}

function DoneUnseenPill() {
  return (
    <span
      style={{
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 17,
        padding: "0 7px",
        borderRadius: 999,
        background: "color-mix(in oklch, var(--info) 18%, transparent)",
        border: "1px solid color-mix(in oklch, var(--info) 45%, transparent)",
        color: "var(--info)",
        fontFamily: "var(--font-mono)",
        fontSize: 9.5,
        fontWeight: 650,
        letterSpacing: "0.04em",
        textTransform: "lowercase",
        whiteSpace: "nowrap",
      }}
    >
      done · unseen
    </span>
  );
}

function MiniMenuButton({
  children,
  danger = false,
  onClick,
}: {
  children: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        height: 24,
        border: `1px solid ${
          danger
            ? "color-mix(in oklch, var(--danger) 45%, transparent)"
            : "var(--rule-soft)"
        }`,
        borderRadius: 6,
        background: hover
          ? danger
            ? "color-mix(in oklch, var(--danger) 18%, transparent)"
            : "var(--hover)"
          : "transparent",
        color: danger ? "var(--danger)" : "var(--ink-dim)",
        padding: "0 7px",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 650,
        cursor: "default",
      }}
    >
      {children}
    </button>
  );
}

function MenuRow({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 9,
        minHeight: 30,
        border: "none",
        borderRadius: 6,
        background: hover ? "var(--hover)" : "transparent",
        padding: "0 9px",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 500,
        cursor: "default",
        textAlign: "left",
      }}
    >
      {children}
    </button>
  );
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
          background: "color-mix(in oklch, var(--accent) 14%, transparent)",
          border: "1px solid var(--accent-edge)",
        }}
      >
        <SparkMark size={20} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted)",
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        textAlign: "center",
        padding: 16,
        lineHeight: 1.5,
      }}
    >
      <div>
        {label} hasn't been spawned for this chat yet.
        <br />
        Send a message to start the session — its terminal will appear here.
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
        borderBottom: "1px solid var(--border-soft, rgba(255,255,255,0.06))",
        background: "var(--panel-deep, transparent)",
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
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={title ?? label}
      style={{
        padding: "4px 10px",
        fontSize: 11,
        fontFamily: "var(--font-sans)",
        background: active
          ? "color-mix(in oklch, var(--accent) 14%, transparent)"
          : "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
        border: "1px solid transparent",
        borderRadius: 4,
        cursor: "pointer",
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

function NewChatButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title="New chat"
      aria-label="New chat"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: 22,
        height: 22,
        border: "none",
        borderRadius: 5,
        background: hover ? "var(--hover)" : "transparent",
        color: hover ? "var(--ink)" : "var(--ink-dim)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "default",
      }}
    >
      <PlusIcon size={13} />
    </button>
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

function TrashGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4h8" />
      <path d="M5.5 4V2.75h3V4" />
      <path d="M4 4l0.5 7.25a1 1 0 0 0 1 0.95h3a1 1 0 0 0 1-0.95L10 4" />
      <path d="M6 6.25v3.5" />
      <path d="M8 6.25v3.5" />
    </svg>
  );
}

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState, ShellInfo, Workspace } from "@shared/types";
import { backendPtySessionId } from "@shared/backend-pty";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import { GridIcon } from "../icons";
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
  // A new chat starts in the normal conversation view. Swarm/terminal state
  // should not leak between runs because their PTYs/workers are run-scoped.
  // When the parent owns chatView, the parent is also responsible for the
  // reset — re-applying it here would race with the parent.
  useEffect(() => {
    setSwarmActive(false);
    if (!usingHoistedChatView) setLocalChatView("chat");
  }, [activeRun?.id, usingHoistedChatView]);

  // Drop swarm mode when the section is collapsed: the user can't see the
  // toggle, so the only way back out would be expand + toggle.
  useEffect(() => {
    if (collapsed) setSwarmActive(false);
  }, [collapsed]);
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
          activeRun ? (
            <SwarmToggleButton
              active={swarmActive}
              onClick={() => setSwarmActive((value) => !value)}
            />
          ) : null
        }
      />
      {!collapsed && (
        <>
          {activeRun && !swarmActive && backendSessionId && !usingHoistedChatView && (
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
                    background: "var(--bg-deep, #0b0b0c)",
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
          {!swarmActive && chatView !== "terminal" && (
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


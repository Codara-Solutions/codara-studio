import React, { useEffect, useRef, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState, Workspace } from "@shared/types";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import { GridIcon, PlusIcon } from "../icons";
import ChatConversation from "./ChatConversation";
import ChatComposer from "./ChatComposer";
import SwarmView from "./SwarmView";
import { describeRunStatus, statusToneColor } from "./timeline";

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
  headerDrag?: SectionHeaderDragProps;
  onSelectRun: (id: string | null) => void;
  onDeleteRun: (id: string) => void;
  onStartChat: (
    message: string,
    clientMessageId: string,
    attachments?: AddRunMessageAttachmentInput[],
  ) => RunState | void | Promise<RunState | void>;
  onPauseRun: () => void;
  onPauseAfterWorkers: () => void;
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
  headerDrag,
  onSelectRun,
  onDeleteRun,
  onStartChat,
  onPauseRun,
  onPauseAfterWorkers,
  onForcePauseRun,
}: Props) {
  // Swarm view toggle — flips the chat body from the normal
  // conversation+composer layout to a grid of live worker terminals. State
  // is scoped to this panel so the toggle survives switching tabs but
  // resets if the section is collapsed (the toolbar disappears anyway).
  // Per-chat keying via run.id means a chat that has no swarm-worthy
  // workers can still flip in/out without other chats inheriting the state.
  const [swarmActive, setSwarmActive] = useState(false);
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
        {...headerDrag}
        meta={activeRun ? <StatusMeta run={activeRun} /> : null}
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
            busy={busy}
            onSelectRun={onSelectRun}
            onDeleteRun={onDeleteRun}
            onPauseRun={onPauseRun}
            onPauseAfterWorkers={onPauseAfterWorkers}
            onForcePauseRun={onForcePauseRun}
          />
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
            // Keyed by chat id so switching chats remounts the stream — fresh
            // scroll position, no step-card open states carried across.
            <ChatConversation
              key={`conversation:${activeRun.id}`}
              run={activeRun}
              cwd={workspace?.cwd ?? null}
            />
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
            />
          )}
        </>
      )}
    </div>
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

function SwitcherBar({
  runs,
  activeRun,
  busy,
  onSelectRun,
  onDeleteRun,
  onPauseRun,
  onPauseAfterWorkers,
  onForcePauseRun,
}: {
  runs: RunState[];
  activeRun: RunState | null;
  busy: boolean;
  onSelectRun: (id: string | null) => void;
  onDeleteRun: (id: string) => void;
  onPauseRun: () => void;
  onPauseAfterWorkers: () => void;
  onForcePauseRun: () => void;
}) {
  const [open, setOpen] = useState<null | "chats" | "controls">(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const activeRunId = activeRun?.id ?? null;
  const runsKey = runs.map((run) => run.id).join("\0");

  useEffect(() => {
    setOpen(null);
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
        setOpen(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
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
  const live =
    !!activeRun &&
    (activeRun.status === "running" ||
      activeRun.status === "planning" ||
      activeRun.status === "reviewing");
  const doneUnseen = activeTone === "done-unseen";
  const canForce =
    !!activeRun &&
    activeRun.status !== "complete" &&
    activeRun.status !== "failed" &&
    activeRun.status !== "cancelled";

  const pick = (id: string | null) => {
    setOpen(null);
    setConfirmingDeleteId(null);
    onSelectRun(id);
  };
  const runControl = (action: () => void) => {
    setOpen(null);
    setConfirmingDeleteId(null);
    action();
  };
  const requestDeleteChat = (id: string) => {
    setConfirmingDeleteId(id);
  };
  const cancelDeleteChat = () => {
    setConfirmingDeleteId(null);
  };
  const deleteChat = (id: string) => {
    setOpen(null);
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
        onClick={() => setOpen((value) => (value === "chats" ? null : "chats"))}
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
          background: open === "chats" ? "var(--hover-strong)" : "transparent",
          cursor: "default",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          if (open !== "chats") e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          if (open !== "chats") e.currentTarget.style.background = "transparent";
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
      {canForce && (
        <button
          type="button"
          title="Run controls"
          disabled={busy}
          onClick={() => setOpen((value) => (value === "controls" ? null : "controls"))}
          style={{
            appearance: "none",
            width: 28,
            height: 28,
            flex: "0 0 28px",
            border: "1px solid var(--rule-soft)",
            borderRadius: 7,
            background: open === "controls" ? "var(--hover-strong)" : "transparent",
            color: "var(--ink-dim)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "default",
            fontSize: 14,
          }}
        >
          <span aria-hidden>⋯</span>
        </button>
      )}
      {open === "chats" && (
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
      {open === "controls" && activeRun && (
        <ControlsMenu
          live={live}
          onPauseRun={() => runControl(onPauseRun)}
          onPauseAfterWorkers={() => runControl(onPauseAfterWorkers)}
          onForcePauseRun={() => runControl(onForcePauseRun)}
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

function ControlsMenu({
  live,
  onPauseRun,
  onPauseAfterWorkers,
  onForcePauseRun,
}: {
  live: boolean;
  onPauseRun: () => void;
  onPauseAfterWorkers: () => void;
  onForcePauseRun: () => void;
}) {
  return (
    <div style={{ ...DROPDOWN_STYLE, right: 10, minWidth: 196 }}>
      {live && (
        <>
          <MenuRow onClick={onPauseAfterWorkers}>
            <span style={{ color: "var(--ink-dim)" }}>Stop after workers</span>
          </MenuRow>
          <MenuRow onClick={onPauseRun}>
            <span style={{ color: "var(--ink-dim)" }}>Pause now</span>
          </MenuRow>
        </>
      )}
      <MenuRow onClick={onForcePauseRun}>
        <span style={{ color: "var(--danger)" }}>Force pause</span>
      </MenuRow>
    </div>
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

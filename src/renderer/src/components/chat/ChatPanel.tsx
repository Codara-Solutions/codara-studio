import React, { useEffect, useRef, useState } from "react";
import type { AddRunMessageAttachmentInput, RunState, Workspace } from "@shared/types";
import SectionHeader, { type SectionHeaderDragProps } from "../../panels/SectionHeader";
import { PlusIcon } from "../icons";
import ChatConversation from "./ChatConversation";
import ChatComposer from "./ChatComposer";
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
  ) => void | Promise<void>;
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
        actions={<NewChatButton onClick={() => onSelectRun(null)} />}
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
          {activeRun ? (
            // Keyed by chat id so switching chats remounts the stream — fresh
            // scroll position, no step-card open states carried across.
            <ChatConversation
              key={conversationKey(activeRun)}
              run={activeRun}
              cwd={workspace?.cwd ?? null}
            />
          ) : (
            <WelcomeState />
          )}
          <ChatComposer
            key={activeRun?.id ?? "new-chat"}
            run={activeRun}
            disabled={!workspace}
            onStartChat={onStartChat}
          />
        </>
      )}
    </div>
  );
}

function conversationKey(run: RunState): string {
  const lastMessage = run.humanMessages[run.humanMessages.length - 1];
  return [
    run.id,
    run.updatedAt,
    run.status,
    run.humanMessages.length,
    lastMessage?.id ?? "",
    lastMessage?.message ?? "",
  ].join(":");
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
  const barRef = useRef<HTMLDivElement>(null);

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

  const triggerColor = activeRun
    ? statusToneColor(describeRunStatus(activeRun).tone)
    : "var(--muted)";
  const live =
    !!activeRun &&
    (activeRun.status === "running" ||
      activeRun.status === "planning" ||
      activeRun.status === "reviewing");
  const canForce =
    !!activeRun &&
    activeRun.status !== "complete" &&
    activeRun.status !== "failed" &&
    activeRun.status !== "cancelled";

  const pick = (id: string | null) => {
    setOpen(null);
    onSelectRun(id);
  };
  const runControl = (action: () => void) => {
    setOpen(null);
    action();
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
            animation: live ? "spark-pulse 1.3s ease-in-out infinite" : undefined,
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
          {activeRun ? activeRun.title : "New chat"}
        </span>
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
          activeRunId={activeRun?.id ?? null}
          onPick={pick}
          onDelete={onDeleteRun}
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
  onPick,
  onDelete,
}: {
  runs: RunState[];
  activeRunId: string | null;
  onPick: (id: string | null) => void;
  onDelete: (id: string) => void;
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
            onPick={onPick}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

function ChatRow({
  run,
  active,
  onPick,
  onDelete,
}: {
  run: RunState;
  active: boolean;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [trashHover, setTrashHover] = useState(false);
  const color = statusToneColor(describeRunStatus(run).tone);
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
          onDelete(run.id);
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
          Describe a task. Spark plans it, spawns Claude and Codex workers, and
          reports back. Or right-click a plan file in the explorer to run it.
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

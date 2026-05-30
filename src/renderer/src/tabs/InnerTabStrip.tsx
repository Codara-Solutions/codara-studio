import React, { useEffect, useRef, useState } from "react";
import type { PreviewTab, RunsTab, TabId, TerminalTab } from "./types";

// The strip below the top TabBar that surfaces a chat's spawned tabs as
// inline pills: Chat | Terminal | Workers | Runs | preview entries.
//
// Sits at the workspace level (between TabBar and the Stack content area) so
// it stays visible when the user navigates from the chat view into a worker
// terminal or the Runs canvas — the chat panel itself loses the active-tab
// highlight as soon as activeId becomes a run-owned tab, but this strip
// keeps the "you are inside Chat X" anchor.
//
// Visibility is decided by the parent: the strip is only rendered when there
// is at least one entry worth showing (a backend PTY, a worker terminal, a
// Runs tab, or a tagged preview). When the user has not started the chat
// yet, the parent hides the whole strip so a brand-new chat is not visually
// noisy.

interface Props {
  // Currently active workspace tab id (effective, after stack-visibility
  // filtering). The strip uses it to decide which pill is highlighted.
  activeId: TabId | null;
  // The singleton chat tab id for the active workspace (today there is only
  // one chat tab — v2 will key it per run). Clicking Chat / Terminal pills
  // activates this tab and flips the chat view mode.
  activeChatTabId: TabId | null;
  // The chat view mode inside the chat panel — "chat" shows the conversation,
  // "terminal" shows the backend Claude/Codex PTY. Lifted from ChatPanel so
  // the strip can drive it without ChatPanel keeping a duplicate state.
  chatView: "chat" | "terminal";
  // True when the active run's backend PTY is actually alive (not just when
  // its deterministic session id is computable). The Terminal pill only
  // appears once this is true so xterm never mounts on a ghost session.
  backendPtyExists: boolean;
  workers: TerminalTab[];
  runsTab: RunsTab | null;
  previews: PreviewTab[];
  onChatClick: () => void;
  onTerminalClick: () => void;
  onSelectTab: (id: TabId) => void;
}

export default function InnerTabStrip({
  activeId,
  activeChatTabId,
  chatView,
  backendPtyExists,
  workers,
  runsTab,
  previews,
  onChatClick,
  onTerminalClick,
  onSelectTab,
}: Props) {
  const chatActive = activeId === activeChatTabId && chatView === "chat";
  const terminalActive = activeId === activeChatTabId && chatView === "terminal";
  const activeWorker = workers.find((w) => w.id === activeId) ?? null;
  const workersActive = activeWorker !== null;
  const runsActive = runsTab !== null && activeId === runsTab.id;

  return (
    <div
      role="tablist"
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px",
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
      }}
    >
      <Pill label="Chat" active={chatActive} onClick={onChatClick} />
      {backendPtyExists && (
        <Pill
          label="Terminal"
          active={terminalActive}
          onClick={onTerminalClick}
          title="Live xterm attached to the backend Claude/Codex PTY for this chat — read-only."
        />
      )}
      {workers.length > 0 && (
        <WorkersPill
          workers={workers}
          activeWorkerId={activeWorker?.id ?? null}
          active={workersActive}
          onSelect={onSelectTab}
        />
      )}
      {runsTab && (
        <Pill
          label="Runs"
          active={runsActive}
          onClick={() => onSelectTab(runsTab.id)}
        />
      )}
      {previews.map((preview) => (
        <Pill
          key={preview.id}
          label={preview.title || "preview"}
          active={activeId === preview.id}
          onClick={() => onSelectTab(preview.id)}
          title={preview.url}
        />
      ))}
    </div>
  );
}

function Pill({
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
        fontWeight: active ? 600 : 500,
        fontFamily: "var(--font-sans)",
        background: active
          ? "var(--accent-soft)"
          : "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
        border: active
          ? "1px solid var(--accent-edge)"
          : "1px solid transparent",
        borderRadius: 4,
        cursor: "default",
        whiteSpace: "nowrap",
        maxWidth: 200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.color = "var(--ink-dim)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--muted)";
        }
      }}
    >
      {label}
    </button>
  );
}

// Workers pill: behaves as a single pill that selects the only worker when
// there is exactly one, and as a dropdown when there are two or more. The
// dropdown lists each worker by title so the user can switch quickly without
// returning to the top tab strip.
function WorkersPill({
  workers,
  activeWorkerId,
  active,
  onSelect,
}: {
  workers: TerminalTab[];
  activeWorkerId: TabId | null;
  active: boolean;
  onSelect: (id: TabId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (
        ref.current &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
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

  if (workers.length === 1) {
    const worker = workers[0];
    return (
      <Pill
        label="Workers"
        active={active}
        onClick={() => onSelect(worker.id)}
        title={worker.title || "worker"}
      />
    );
  }

  // Multiple workers — render as a dropdown trigger. The "▾" hints at the
  // menu; the menu lists each worker and selects on click.
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Switch worker"
        style={{
          padding: "4px 10px",
          fontSize: 11,
          fontWeight: active ? 600 : 500,
          fontFamily: "var(--font-sans)",
          background: active
            ? "var(--accent-soft)"
            : open
              ? "var(--hover-strong)"
              : "transparent",
          color: active ? "var(--accent)" : "var(--muted)",
          border: active
            ? "1px solid var(--accent-edge)"
            : "1px solid transparent",
          borderRadius: 4,
          cursor: "default",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        }}
      >
        <span>Workers</span>
        <span
          aria-hidden
          style={{
            fontSize: 9,
            opacity: 0.7,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          ▾
        </span>
      </button>
      {open && (
        <div
          role="menu"
          className="spark-fade-in"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 30,
            minWidth: 180,
            border: "1px solid var(--rule-strong)",
            borderRadius: 9,
            background: "var(--panel-2)",
            boxShadow: "var(--shadow-2), var(--lift-hi)",
            padding: 5,
            display: "flex",
            flexDirection: "column",
            gap: 1,
          }}
        >
          {workers.map((worker) => {
            const isActive = worker.id === activeWorkerId;
            return (
              <button
                key={worker.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSelect(worker.id);
                }}
                title={worker.title || "worker"}
                style={{
                  appearance: "none",
                  textAlign: "left",
                  background: isActive ? "var(--accent-soft)" : "transparent",
                  border: isActive
                    ? "1px solid var(--accent-edge)"
                    : "1px solid transparent",
                  padding: "5px 9px",
                  color: isActive ? "var(--accent)" : "var(--ink)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11.5,
                  fontWeight: isActive ? 600 : 500,
                  borderRadius: 5,
                  cursor: "default",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  transition:
                    "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = "var(--hover)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = "transparent";
                }}
              >
                {worker.title || "worker"}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

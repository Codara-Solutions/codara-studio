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
        background: "var(--chrome-rail)",
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
        // Constant weight across active/inactive — selection is signalled by
        // accent text + a soft --accent-soft fill only (no border), so the pill
        // never reflows (and never nudges its neighbors) on activation, matching
        // the constant-weight .spark-segmented-item.
        fontWeight: 550,
        fontFamily: "var(--font-sans)",
        background: active
          ? "var(--accent-soft)"
          : "transparent",
        color: active ? "var(--accent)" : "var(--muted)",
        // No visible border in any state — the active pill reads as a gentle
        // tinted segment, not an outlined chip. Keep a 1px transparent border
        // so there is never a width shift between active/inactive/hover.
        border: "1px solid transparent",
        // Generously rounded (the softened control radius) so the segment row
        // reads calm and pill-like rather than boxy.
        borderRadius: "var(--radius-control, 7px)",
        cursor: "default",
        whiteSpace: "nowrap",
        maxWidth: 200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
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
      // Tactile press: a momentary darker fill (--press), no transform — pills
      // sit in a flush strip where a translate would jitter the row.
      onMouseDown={(e) => {
        if (!active) e.currentTarget.style.background = "var(--press)";
      }}
      onMouseUp={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
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

  // Multiple workers — render as a dropdown trigger. A chevron hints at the
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
          // Constant weight — same reflow-free rule as Pill above.
          fontWeight: 550,
          fontFamily: "var(--font-sans)",
          background: active
            ? "var(--accent-soft)"
            : open
              ? "var(--hover-strong)"
              : "transparent",
          color: active ? "var(--accent)" : "var(--muted)",
          // Borderless like Pill — active is a soft tinted fill, never an
          // outlined box. The 1px transparent border holds width constant
          // across active/inactive/open.
          border: "1px solid transparent",
          borderRadius: "var(--radius-control, 7px)",
          cursor: "default",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
      >
        <span>Workers</span>
        {/* Crisp SVG chevron at currentColor (replaces the unicode "▾", which
            sat on a text baseline and rendered heavier than the app's other
            glyphs). Rotates to point up while the menu is open. */}
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            opacity: 0.7,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--motion-fast) var(--ease-out)",
          }}
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 4.5 6 7.5 9 4.5" />
          </svg>
        </span>
      </button>
      {open && (
        // One popover language: .spark-menu (--panel-2 face, 9px radius, --rule
        // hairline, --shadow-2) + .spark-menu-item (--hover on hover,
        // .is-active = accent text + --accent-soft fill). Replaces the
        // hand-rolled menu (divergent --rule-strong border + extra --lift-hi)
        // and holds item weight constant so the active worker never reflows.
        <div
          role="menu"
          className="spark-menu spark-fade-in"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 30,
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
                className={isActive ? "spark-menu-item is-active" : "spark-menu-item"}
                onClick={() => {
                  setOpen(false);
                  onSelect(worker.id);
                }}
                title={worker.title || "worker"}
                style={{
                  color: isActive ? "var(--accent)" : "var(--ink)",
                  fontSize: 11.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
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

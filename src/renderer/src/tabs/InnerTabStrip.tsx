import React from "react";
import type { PreviewTab, RunsTab, TabId } from "./types";
import type { CoraView } from "../components/chat/cora-view";

// The strip below the top TabBar that gives every real Cora run a stable
// workbench: Chat | Runs | Board, plus the optional surfaces that exist for
// this run — the Whiteboard and agent-opened previews.
// Board is per-chat (each run owns its kanban; a draft chat shows an empty
// one whose first card mints the run), and its pill is unconditional — the
// surface always exists.
//
// Sits at the workspace level (between TabBar and the Stack content area) so
// it stays visible when the user navigates from the chat view into a worker
// terminal or the Runs canvas — the chat panel itself loses the active-tab
// highlight as soon as activeId becomes a run-owned tab, but this strip
// keeps the "you are inside Chat X" anchor.
//
// Visibility is decided by the parent: it renders for draft chats too (Chat +
// Board — a draft's board starts empty and local), and the run-scoped pills join
// as a draft becomes a real run. Chat and Runs never pop in late as planning
// or delegation advances. The Whiteboard pill shows once a board exists for
// this chat, and also whenever one COULD be created here — since the strip
// went icon-only the pill is itself the create affordance, which is why the
// separate "New whiteboard" button it replaced is gone. Unused it costs a bare
// icon rather than a labelled slot, so it no longer has to hide to stay out of
// the way.

interface Props {
  // Currently active workspace tab id (effective, after stack-visibility
  // filtering). The strip uses it to decide which pill is highlighted.
  activeId: TabId | null;
  // The singleton chat tab id for the active workspace (today there is only
  // one chat tab — v2 will key it per run). Clicking the Chat pill
  // activates this tab and flips the chat view mode.
  activeChatTabId: TabId | null;
  // The chat view mode inside the chat panel. Lifted from ChatPanel so
  // the strip can drive it without ChatPanel keeping a duplicate state.
  chatView: CoraView;
  // True when the active run has a persisted whiteboard, which is what makes
  // the pill a destination rather than a create affordance.
  whiteboardAvailable: boolean;
  // True when a whiteboard COULD be created here — i.e. the strip belongs to
  // a real run. Draft chats (no run yet) show the strip for the workspace
  // Board, but the run-scoped whiteboard can't exist for them, so the pill
  // hides entirely rather than offering a dead surface.
  whiteboardCreatable: boolean;
  // True when Cora updated the board while the user was looking elsewhere —
  // renders a small attention dot on the pill until the surface is visited.
  whiteboardAttention: boolean;
  runsTab: RunsTab | null;
  previews: PreviewTab[];
  onChatClick: () => void;
  onWhiteboardClick: () => void;
  // Flips the chat panel to this chat's Cora Board sub-view (chatView
  // "board"). Sits next to Runs — cards and their workers are one workflow.
  onBoardClick: () => void;
  onSelectTab: (id: TabId) => void;
}

export default function InnerTabStrip({
  activeId,
  activeChatTabId,
  chatView,
  whiteboardAvailable,
  whiteboardCreatable,
  whiteboardAttention,
  runsTab,
  previews,
  onChatClick,
  onWhiteboardClick,
  onBoardClick,
  onSelectTab,
}: Props) {
  const chatActive = activeId === activeChatTabId && chatView === "chat";
  const runsActive = runsTab !== null && activeId === runsTab.id;
  const boardActive = activeId === activeChatTabId && chatView === "board";
  const whiteboardActive = activeId === activeChatTabId && chatView === "whiteboard";
  // Keep the pill while the user is on the surface even before the first card
  // persists, so opening a fresh board doesn't leave the strip highlighting
  // nothing.
  const showWhiteboardPill = whiteboardAvailable || whiteboardActive;

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
      {runsTab && (
        <IconTab
          label="Runs"
          active={runsActive}
          onClick={() => onSelectTab(runsTab.id)}
          title="The runs canvas: this chat's Cora and every worker it spawned"
          icon={<RunsGlyph />}
        />
      )}
      <IconTab
        label="Kanban"
        active={boardActive}
        onClick={onBoardClick}
        title="This chat's Cora Board: queue cards and this chat's Cora works through them"
        icon={<KanbanGlyph />}
      />
      {(showWhiteboardPill || whiteboardCreatable) && (
        <IconTab
          label="Whiteboard"
          active={whiteboardActive}
          onClick={onWhiteboardClick}
          title="A persisted visual explanation Cora and you share"
          attention={whiteboardAttention && !whiteboardActive}
          icon={<WhiteboardGlyph />}
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
      {/* Right-aligned slot the worker terminal guard portals its controls
          into (TerminalStack). Docking them here uses the strip's empty right
          half instead of floating over the top-right pane's title. */}
      <div
        data-cora-guard-slot
        style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}
      />
    </div>
  );
}

function Pill({
  label,
  active,
  onClick,
  title,
  attention = false,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
  attention?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={attention ? `${title ?? label} (updated by Cora)` : title ?? label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
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
      {attention && (
        <span
          // aria-hidden (not aria-label): the dot must never pollute the tab's
          // accessible name — assistive tech gets the update via the title.
          aria-hidden
          style={{
            width: 5,
            height: 5,
            flex: "0 0 auto",
            borderRadius: 999,
            background: "var(--accent)",
          }}
        />
      )}
    </button>
  );
}

// An icon-first surface door: a bare glyph until it is the active surface,
// where it expands to carry its full name. Kanban and Whiteboard both use it
// so the strip stays quiet while inactive surfaces still stay one click away.
function IconTab({
  label,
  active,
  attention = false,
  onClick,
  title,
  icon,
}: {
  label: string;
  active: boolean;
  attention?: boolean;
  onClick: () => void;
  title?: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      aria-label={label}
      title={attention ? `${title ?? label} (updated by Cora)` : title ?? label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 24,
        minWidth: 24,
        padding: active ? "0 10px" : 0,
        border: "1px solid transparent",
        borderRadius: "var(--radius-control, 7px)",
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--muted-2)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 550,
        cursor: "default",
        whiteSpace: "nowrap",
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
          e.currentTarget.style.color = "var(--muted-2)";
        }
      }}
    >
      {icon}
      {active && <span>{label}</span>}
      {attention && (
        <span
          aria-hidden
          style={{
            width: 5,
            height: 5,
            flex: "0 0 auto",
            borderRadius: 999,
            background: "var(--accent)",
          }}
        />
      )}
    </button>
  );
}

// An activity pulse: work moving through the system — the runs canvas is
// where every live worker's heartbeat is visible.
function RunsGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.6 7h2.4l1.6-3.6 2.8 7.2L10 7h2.4" />
    </svg>
  );
}

// Three columns with cards at different heights: the universal kanban shape.
function KanbanGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.6" y="2" width="3" height="7.4" rx="1" />
      <rect x="5.5" y="2" width="3" height="10" rx="1" />
      <rect x="9.4" y="2" width="3" height="5.2" rx="1" />
    </svg>
  );
}

// A framed board with a hand-drawn stroke: a whiteboard being sketched on.
function WhiteboardGlyph() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="1.8" y="2.6" width="10.4" height="8.8" rx="1.6" />
      <path d="M4.2 8.7c1.1-2.2 2.2-3.1 3-2.4.8.7 1.7.3 2.6-1.2" />
    </svg>
  );
}

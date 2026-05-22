import React, { useEffect, useRef, useState } from "react";
import type { Tab, TabId } from "./types";
import { CloseIcon, FileIcon, PlusIcon } from "../components/icons";
import {
  TAB_REORDER_DRAG_MIME,
  TERMINAL_PANE_DRAG_MIME,
  parseTabReorderDrag,
  parseTerminalPaneDrag,
  type TerminalPaneDragPayload,
} from "./terminalDrag";

// Delay before a terminal-pane drag hovering over an inactive tab in the strip
// activates that tab. Long enough that brushing past a tab during a drag
// doesn't accidentally switch context; short enough to feel responsive when
// the user genuinely lingers to drop "into" the target tab.
const HOVER_ACTIVATE_MS = 350;

// TabBar is the strip at the top of the workspace pane. Visually similar
// to a code editor's tab strip but with a kind-icon-prefixed label so it's
// obvious at a glance that you're switching between an editor, a terminal,
// a preview window, and a runs canvas.
//
// Behavior worth calling out:
//   - Wheel-deltaY scrolls the strip horizontally (terax pattern). Allows
//     a single-axis wheel mouse to navigate when many tabs are open.
//   - The active tab is scrolled into view on every selection change.
//   - The "+" button opens a small dropdown with kinds the user can spawn.
//   - Closing the last tab is a no-op on the store side; we still render
//     the close button for kinds with len > 1.
//   - Middle-click closes a tab (mouseup button === 1).

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  onNewTerminal: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId?: TabId) => void;
  onReorderTab: (fromId: TabId, toId: TabId, position: "before" | "after") => void;
  onPinEditorTab: (id: TabId) => void;
}

// React.memo: TabBar's props from App.tsx are referentially stable (the
// callbacks are useCallback-backed and, since the useTabs API object is now
// memoized, `tabs`/`activeId` only change when the tab list actually does).
// So an unrelated App re-render no longer repaints the whole tab strip.
function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNewTerminal,
  onNewPreview,
  onNewEditor,
  onTerminalPaneDrop,
  onReorderTab,
  onPinEditorTab,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [terminalDropActive, setTerminalDropActive] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const acceptsTerminalPane = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(TERMINAL_PANE_DRAG_MIME);

  // Convert vertical wheel deltas to horizontal scroll on the tab strip,
  // but only when there's actually overflow to scroll. We register with
  // passive: false so preventDefault works.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab in view after a selection or open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${cssEscape(activeId)}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // Close the new-tab picker on outside click / Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        pickerRef.current &&
        e.target instanceof Node &&
        !pickerRef.current.contains(e.target)
      ) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  return (
    <div
      onDragEnter={(event) => {
        if (!acceptsTerminalPane(event)) return;
        event.preventDefault();
        setTerminalDropActive(true);
      }}
      onDragOver={(event) => {
        if (!acceptsTerminalPane(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setTerminalDropActive(true);
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setTerminalDropActive(false);
      }}
      onDrop={(event) => {
        const payload = parseTerminalPaneDrag(event.dataTransfer);
        if (!payload) return;
        event.preventDefault();
        setTerminalDropActive(false);
        onTerminalPaneDrop(payload);
      }}
      className={
        terminalDropActive ? "spark-tabbar spark-tabbar--drop-active" : "spark-tabbar"
      }
    >
      <div ref={scrollRef} className="spark-tabbar-scroll">
        {tabs.map((t) => (
          // onSelect/onClose are passed straight through (no per-tab inline
          // closure) so each TabItem's props stay referentially stable and
          // React.memo can skip the siblings of the one tab that changed.
          // TabItem calls onSelect(tab.id) itself.
          <TabItem
            key={t.id}
            tab={t}
            active={t.id === activeId}
            canClose={tabs.length > 1}
            onSelect={onSelect}
            onClose={onClose}
            onTerminalPaneDrop={onTerminalPaneDrop}
            onReorderTab={onReorderTab}
            onPinEditorTab={onPinEditorTab}
          />
        ))}
      </div>
      <div ref={pickerRef} style={{ position: "relative" }}>
        <button
          type="button"
          className="spark-tabbar-new"
          onClick={() => setPickerOpen((o) => !o)}
          title="New tab"
          aria-label="New tab"
        >
          <PlusIcon size={12} />
        </button>
        {pickerOpen && (
          <div className="spark-tabbar-picker">
            <PickerItem
              label="Terminal"
              hint="⌘T"
              onClick={() => {
                setPickerOpen(false);
                onNewTerminal();
              }}
            />
            <PickerItem
              label="Open file…"
              hint="⌘E"
              onClick={() => {
                setPickerOpen(false);
                onNewEditor();
              }}
            />
            <PickerItem
              label="Preview"
              hint="⌘P"
              onClick={() => {
                setPickerOpen(false);
                onNewPreview();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface TabItemProps {
  tab: Tab;
  active: boolean;
  canClose: boolean;
  // Take the tab id rather than a pre-bound closure: the parent can hand
  // down ONE stable callback for every row, which (together with React.memo
  // below) lets a single tab's change skip re-rendering its siblings.
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId: TabId) => void;
  onReorderTab: (fromId: TabId, toId: TabId, position: "before" | "after") => void;
  onPinEditorTab: (id: TabId) => void;
}

// React.memo so only the tab whose props actually changed (active flag
// flipping, dirty dot, title) re-renders — selecting tab B no longer
// repaints tabs A, C, D. Relies on the stable callbacks passed above.
const TabItem = React.memo(function TabItem({
  tab,
  active,
  canClose,
  onSelect,
  onClose,
  onTerminalPaneDrop,
  onReorderTab,
  onPinEditorTab,
}: TabItemProps) {
  const [closeHover, setCloseHover] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const isPreviewEditor = tab.kind === "editor" && Boolean(tab.preview);
  // "before" | "after" while a tab-reorder drag is hovering this item, used
  // to render the insertion indicator on the correct edge. Null otherwise.
  const [reorderEdge, setReorderEdge] = useState<"before" | "after" | null>(null);
  // While dragging this tab as a reorder source, dim it so the user gets
  // visual confirmation that the strip understood the gesture.
  const [dragging, setDragging] = useState(false);
  // Hover-activate timer: a terminal-pane drag that lingers over an
  // inactive tab flips the workbench to that tab so the user can drop on a
  // specific pane edge inside.
  const hoverActivateTimer = useRef<number | null>(null);
  const clearHoverActivate = () => {
    if (hoverActivateTimer.current !== null) {
      window.clearTimeout(hoverActivateTimer.current);
      hoverActivateTimer.current = null;
    }
  };
  useEffect(() => () => clearHoverActivate(), []);

  const acceptsPaneDrop = (event: React.DragEvent): boolean =>
    tab.kind === "terminal" &&
    Array.from(event.dataTransfer.types).includes(TERMINAL_PANE_DRAG_MIME);
  const acceptsReorderDrop = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(TAB_REORDER_DRAG_MIME);

  // Decide whether the pointer is on the left or right half of the tab —
  // that's the edge the reorder insertion line snaps to.
  const reorderPositionFor = (event: React.DragEvent): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

  const tabClass = [
    "spark-tab",
    active && "spark-tab--active",
    dragging && "spark-tab--dragging",
    dropActive && "spark-tab--drop-target",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      data-preview-editor={isPreviewEditor ? "true" : undefined}
      className={tabClass}
      draggable
      onDragStart={(event) => {
        // Use a tab-specific MIME so the strip's terminal-pane drop handler
        // ignores this drag — and so a pane drag from a TerminalPane drag
        // handle never collides with a tab reorder.
        event.dataTransfer.setData(
          TAB_REORDER_DRAG_MIME,
          JSON.stringify({ tabId: tab.id }),
        );
        event.dataTransfer.effectAllowed = "move";
        setDragging(true);
      }}
      onDragEnd={() => {
        setDragging(false);
        setReorderEdge(null);
        clearHoverActivate();
      }}
      onDragEnter={(event) => {
        if (acceptsReorderDrop(event)) {
          event.preventDefault();
          event.stopPropagation();
          setReorderEdge(reorderPositionFor(event));
          return;
        }
        if (!acceptsPaneDrop(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setDropActive(true);
        // Activate this tab after a short hover so the user can keep
        // dragging into the now-visible TerminalStack and pick an exact
        // pane edge. Don't bother if it's already active.
        if (!active && hoverActivateTimer.current === null) {
          hoverActivateTimer.current = window.setTimeout(() => {
            hoverActivateTimer.current = null;
            onSelect(tab.id);
          }, HOVER_ACTIVATE_MS);
        }
      }}
      onDragOver={(event) => {
        if (acceptsReorderDrop(event)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          const next = reorderPositionFor(event);
          setReorderEdge((curr) => (curr === next ? curr : next));
          return;
        }
        if (!acceptsPaneDrop(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setDropActive(false);
        setReorderEdge(null);
        clearHoverActivate();
      }}
      onDrop={(event) => {
        const reorder = parseTabReorderDrag(event.dataTransfer);
        if (reorder) {
          event.preventDefault();
          event.stopPropagation();
          const position = reorderPositionFor(event);
          setReorderEdge(null);
          setDropActive(false);
          clearHoverActivate();
          if (reorder.tabId !== tab.id) {
            onReorderTab(reorder.tabId, tab.id, position);
          }
          return;
        }
        const payload = parseTerminalPaneDrag(event.dataTransfer);
        if (!payload || tab.kind !== "terminal") return;
        event.preventDefault();
        event.stopPropagation();
        setDropActive(false);
        clearHoverActivate();
        onTerminalPaneDrop(payload, tab.id);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(tab.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (tab.kind === "editor") onPinEditorTab(tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && canClose) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tab.id);
        }
      }}
      title={titleFor(tab)}
    >
      {reorderEdge && (
        <span
          aria-hidden
          className={`spark-tab__reorder-edge spark-tab__reorder-edge--${reorderEdge}`}
        />
      )}
      <KindIcon tab={tab} />
      <span
        className={
          isPreviewEditor
            ? "spark-tab__label spark-tab__label--preview"
            : "spark-tab__label"
        }
      >
        {labelFor(tab)}
      </span>
      {tab.kind === "editor" && tab.dirty && !closeHover ? (
        <span
          aria-label="Unsaved changes"
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: "var(--ink-dim)",
            flex: "0 0 7px",
          }}
        />
      ) : null}
      {canClose && (
        <button
          type="button"
          className="spark-tab__close"
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
          onClick={(e) => {
            e.stopPropagation();
            onClose(tab.id);
          }}
          title="Close"
          aria-label="Close tab"
        >
          <CloseIcon size={10} />
        </button>
      )}
    </div>
  );
});

function KindIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "editor") {
    return (
      <span style={{ display: "inline-flex", flex: "0 0 14px" }}>
        <FileIcon ext={tab.entry.ext} />
      </span>
    );
  }
  if (tab.kind === "terminal") return <GlyphIcon glyph="❯" color="var(--accent)" />;
  if (tab.kind === "preview") return <GlyphIcon glyph="◉" color="var(--accent)" />;
  return <GlyphIcon glyph="◆" color="var(--accent)" />;
}

function GlyphIcon({ glyph, color }: { glyph: string; color: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        flex: "0 0 14px",
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      {glyph}
    </span>
  );
}

function labelFor(t: Tab): string {
  if (t.kind === "terminal") return t.title || "terminals";
  return t.title;
}

function titleFor(t: Tab): string {
  if (t.kind === "editor") return t.path;
  if (t.kind === "preview") return t.url;
  if (t.kind === "terminal") return t.title;
  return t.title;
}

function cssEscape(value: string): string {
  // Limited escape: tab ids are uid()-generated so this is mostly identity.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function PickerItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        padding: "8px 12px",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        cursor: "default",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover-strong)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ flex: 1 }}>{label}</span>
      {hint && (
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          {hint}
        </span>
      )}
    </button>
  );
}

// Memoized default export — see the comment on the inner TabBar function.
// Wrapping the export (rather than the declaration) keeps the named inner
// function readable in React DevTools while still gating re-renders on a
// shallow prop comparison.
export default React.memo(TabBar);

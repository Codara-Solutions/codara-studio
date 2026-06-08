import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatTab, Tab, TabId } from "./types";
import { CloseIcon, FileIcon, PlusIcon, SparkIcon } from "../components/icons";
import {
  TAB_REORDER_DRAG_MIME,
  TERMINAL_PANE_DRAG_MIME,
  parseTabReorderDrag,
  parseTerminalPaneDrag,
  peekTerminalPaneDrag,
  subscribeTerminalPaneDrag,
  type TerminalPaneDragPayload,
} from "./terminalDrag";

// Delay before a terminal-pane drag hovering over an inactive tab in the strip
// activates that tab. Long enough that brushing past a tab during a drag
// doesn't accidentally switch context; short enough to feel responsive when
// the user genuinely lingers to drop "into" the target tab.
const HOVER_ACTIVATE_MS = 350;

// TabBar is the strip at the top of the workspace pane. Visually similar
// to a code editor's tab strip but with a kind-icon-prefixed label so it's
// obvious at a glance that you're switching between Spark chat, an editor,
// a terminal, a preview window, and a runs canvas.
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
  // Top-level "+" button now spawns a new chat tab. Spawning a terminal /
  // editor / preview moved to keybinds (⌘T / ⌘E / ⌘P) — workspace tab kinds
  // are still appended through the existing onNew* callbacks for those
  // shortcuts. The strip never opens a kind picker anymore.
  onNewChat: () => void;
  // Opens (or focuses) the workspace's Automations tab from the "+" dropdown.
  onNewAutomations: () => void;
  // Chat-tab-specific affordances: hover-revealed rename and close. Generic
  // tabs continue to use the existing onClose path.
  onRenameChat: (id: TabId, title: string) => void;
  onCloseChat: (id: TabId) => void;
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
  onNewChat,
  onNewAutomations,
  onRenameChat,
  onCloseChat,
  onTerminalPaneDrop,
  onReorderTab,
  onPinEditorTab,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [terminalDropActive, setTerminalDropActive] = useState(false);

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
  // Tab id that a pointer-based pane drag is currently hovering over — drives
  // hover-activate (open the tab so the user can see where they're aiming)
  // and the drop-target outline on that TabItem.
  const [paneHoverTabId, setPaneHoverTabId] = useState<TabId | null>(null);
  // True while a pointer-based pane drag is over the strip in a spot that would
  // spawn a NEW terminal tab on release (empty strip space, a non-terminal tab,
  // or the pane's own source tab) rather than merge into a hovered terminal
  // tab. Drives the strip glow and the ghost "new tab" drop pill.
  const [newTabDropActive, setNewTabDropActive] = useState(false);

  // Latest onTerminalPaneDrop via a ref so the pointer-drag effect can fire it
  // without listing it as a dep — that would tear down and re-add the window
  // listeners (resetting the in-flight drag tracking) mid-gesture.
  const onTerminalPaneDropRef = useRef(onTerminalPaneDrop);
  onTerminalPaneDropRef.current = onTerminalPaneDrop;

  const acceptsTerminalPane = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(TERMINAL_PANE_DRAG_MIME);

  // The pane drag uses pointer events (see PaneDragHandle), so the HTML5
  // onDragEnter hover-activate on each TabItem never fires for it. We
  // subscribe to the module-level drag state instead, then run our own
  // pointermove hit-test against each tab's bounding rect. Two outcomes while
  // the pointer is over the strip:
  //   - over a different terminal tab → hover-activate it (so the user can
  //     keep dragging into the now-visible TerminalStack) and, on release,
  //     merge the pane into it;
  //   - over empty strip space / a non-terminal tab / the pane's own tab →
  //     show the "new tab" affordance and, on release, detach the pane into a
  //     brand-new terminal tab.
  useEffect(() => {
    let dragActive = false;
    let hoverTimer: number | null = null;
    let hoverTargetId: TabId | null = null;
    // Captured each pointermove so the pointerup handler can still fire the
    // drop after the visible TerminalTabPane's own finish handler has already
    // cleared the module-level drag via endTerminalPaneDrag().
    let dragPayload: TerminalPaneDragPayload | null = null;
    // Where a release right now would land: a terminal tab id to merge into,
    // or null while `overStrip` to detach into a new tab.
    let overStrip = false;
    let mergeTargetId: TabId | null = null;

    const clearPaneHoverActivate = () => {
      if (hoverTimer !== null) {
        window.clearTimeout(hoverTimer);
        hoverTimer = null;
      }
      hoverTargetId = null;
    };
    // Drop where-would-it-land tracking + the visual affordances back to rest.
    const resetDropTracking = () => {
      overStrip = false;
      mergeTargetId = null;
      setPaneHoverTabId((curr) => (curr === null ? curr : null));
      setNewTabDropActive((curr) => (curr ? false : curr));
    };

    // subscribeTerminalPaneDrag fires the listener synchronously on
    // registration with the current state, so the helpers above must be
    // declared first — otherwise we hit a TDZ error on the very first call.
    const unsubscribe = subscribeTerminalPaneDrag((state) => {
      dragActive = !!state;
      if (state) {
        dragPayload = state.payload;
      } else {
        clearPaneHoverActivate();
        resetDropTracking();
        dragPayload = null;
      }
    });

    const onPointerMove = (event: PointerEvent) => {
      if (!dragActive) return;
      const payload = peekTerminalPaneDrag();
      if (!payload) return;
      dragPayload = payload;
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;
      const stripRect = scrollEl.getBoundingClientRect();
      // Pointer not over the strip → cancel any pending activation and clear
      // every drop affordance; the pane's own area will pick up the drop.
      if (
        event.clientY < stripRect.top ||
        event.clientY > stripRect.bottom ||
        event.clientX < stripRect.left ||
        event.clientX > stripRect.right
      ) {
        clearPaneHoverActivate();
        resetDropTracking();
        return;
      }
      overStrip = true;
      let hoveredId: TabId | null = null;
      const tabEls = scrollEl.querySelectorAll<HTMLElement>("[data-tab-id]");
      for (const el of tabEls) {
        const r = el.getBoundingClientRect();
        if (
          event.clientX >= r.left &&
          event.clientX <= r.right &&
          event.clientY >= r.top &&
          event.clientY <= r.bottom
        ) {
          hoveredId = el.dataset.tabId ?? null;
          break;
        }
      }
      const hoveredTab = hoveredId ? tabs.find((t) => t.id === hoveredId) : null;
      // A different terminal tab under the pointer is a merge target: give it
      // the hover-activate + drop-target highlight. Anything else over the
      // strip (empty space, a non-terminal tab, or the pane's own source tab)
      // is the new-tab drop zone.
      if (
        hoveredTab &&
        hoveredTab.kind === "terminal" &&
        hoveredTab.id !== payload.tabId
      ) {
        const targetId = hoveredTab.id;
        mergeTargetId = targetId;
        setPaneHoverTabId((curr) => (curr === targetId ? curr : targetId));
        setNewTabDropActive((curr) => (curr ? false : curr));
        // Already the active tab — no need to schedule a switch.
        if (targetId === activeId) {
          clearPaneHoverActivate();
          return;
        }
        // Re-arm only if the target changed, so brushing past a tab doesn't
        // cancel an in-progress activation of the tab the user actually wants.
        if (hoverTargetId === targetId) return;
        clearPaneHoverActivate();
        hoverTargetId = targetId;
        hoverTimer = window.setTimeout(() => {
          hoverTimer = null;
          hoverTargetId = null;
          onSelect(targetId);
        }, HOVER_ACTIVATE_MS);
        return;
      }
      // New-tab drop zone.
      mergeTargetId = null;
      clearPaneHoverActivate();
      setPaneHoverTabId((curr) => (curr === null ? curr : null));
      setNewTabDropActive((curr) => (curr ? curr : true));
    };

    const onPointerUp = () => {
      if (!dragActive) return;
      const payload = dragPayload;
      const wasOverStrip = overStrip;
      const target = mergeTargetId;
      clearPaneHoverActivate();
      resetDropTracking();
      dragActive = false;
      dragPayload = null;
      if (!payload || !wasOverStrip) return;
      // target set → merge into that terminal tab; otherwise detach into a new
      // tab. onTerminalPaneDrop no-ops safely when the move isn't possible
      // (e.g. detaching the only pane of a single-pane tab).
      onTerminalPaneDropRef.current(payload, target ?? undefined);
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      clearPaneHoverActivate();
      unsubscribe();
    };
  }, [tabs, activeId, onSelect]);

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
        terminalDropActive || newTabDropActive
          ? "spark-tabbar spark-tabbar--drop-active"
          : "spark-tabbar"
      }
    >
      <div ref={scrollRef} className="spark-tabbar-scroll">
        {tabs.map((t) =>
          t.kind === "chat" ? (
            <ChatTabItem
              key={t.id}
              tab={t}
              active={t.id === activeId}
              onSelect={onSelect}
              onRename={onRenameChat}
              onClose={onCloseChat}
              onReorderTab={onReorderTab}
            />
          ) : (
            // onSelect/onClose are passed straight through (no per-tab inline
            // closure) so each TabItem's props stay referentially stable and
            // React.memo can skip the siblings of the one tab that changed.
            // TabItem calls onSelect(tab.id) itself.
            <TabItem
              key={t.id}
              tab={t}
              active={t.id === activeId}
              canClose={tabs.length > 1}
              paneDragHover={t.id === paneHoverTabId}
              onSelect={onSelect}
              onClose={onClose}
              onTerminalPaneDrop={onTerminalPaneDrop}
              onReorderTab={onReorderTab}
              onPinEditorTab={onPinEditorTab}
            />
          ),
        )}
        {newTabDropActive && <NewTabDropZone />}
      </div>
      <div ref={pickerRef} style={{ position: "relative" }}>
        <button
          type="button"
          className="spark-tabbar-new"
          onClick={() => setPickerOpen((open) => !open)}
          title="New tab"
          aria-label="New tab"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
        >
          <PlusIcon size={12} />
        </button>
        {pickerOpen && (
          <div className="spark-tabbar-picker">
            <PickerItem
              label="New chat"
              hint="⌘N"
              primary
              onClick={() => {
                setPickerOpen(false);
                onNewChat();
              }}
            />
            <div
              aria-hidden
              style={{ height: 1, background: "var(--rule)", margin: "4px 2px" }}
            />
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
            <PickerItem
              label="New automations"
              onClick={() => {
                setPickerOpen(false);
                onNewAutomations();
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
  // True while a pointer-based pane drag is hovering over this tab. The
  // pointer-event drag (PaneDragHandle) bypasses HTML5 dragenter/dragleave,
  // so the parent TabBar hit-tests pointer position against each tab and
  // feeds the result here so the row can still show drop-target styling.
  paneDragHover: boolean;
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
  paneDragHover,
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
    (dropActive || paneDragHover) && "spark-tab--drop-target",
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

// ChatTabItem: the top tab strip's chat-kind entry. Hover reveals a pencil
// (inline rename) and an × (close chat). Idle state shows just the title and
// kind dot so a strip of many chats reads as a clean list. Close is always
// available — the workspace re-seeds a fresh draft chat tab if the last one
// closes (see closeChatTabForRun).
interface ChatTabItemProps {
  tab: ChatTab;
  active: boolean;
  onSelect: (id: TabId) => void;
  onRename: (id: TabId, title: string) => void;
  onClose: (id: TabId) => void;
  onReorderTab: (fromId: TabId, toId: TabId, position: "before" | "after") => void;
}

const ChatTabItem = React.memo(function ChatTabItem({
  tab,
  active,
  onSelect,
  onRename,
  onClose,
  onReorderTab,
}: ChatTabItemProps) {
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [reorderEdge, setReorderEdge] = useState<"before" | "after" | null>(null);
  const [dragging, setDragging] = useState(false);

  // Mirror title updates from the run snapshot into the draft state when the
  // user is NOT in the middle of editing.
  useEffect(() => {
    if (!editing) setDraft(tab.title);
  }, [tab.title, editing]);

  // Focus + select the title text the moment the input mounts so the user
  // can immediately type a replacement.
  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === tab.title) {
      setDraft(tab.title);
      return;
    }
    onRename(tab.id, next);
  };
  const cancel = () => {
    setDraft(tab.title);
    setEditing(false);
  };

  const acceptsReorderDrop = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(TAB_REORDER_DRAG_MIME);
  const reorderPositionFor = (event: React.DragEvent): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

  const className = [
    "spark-tab",
    active && "spark-tab--active",
    dragging && "spark-tab--dragging",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      className={className}
      draggable={!editing}
      onDragStart={(event) => {
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
      }}
      onDragEnter={(event) => {
        if (!acceptsReorderDrop(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setReorderEdge(reorderPositionFor(event));
      }}
      onDragOver={(event) => {
        if (!acceptsReorderDrop(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const next = reorderPositionFor(event);
        setReorderEdge((curr) => (curr === next ? curr : next));
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setReorderEdge(null);
      }}
      onDrop={(event) => {
        const reorder = parseTabReorderDrag(event.dataTransfer);
        if (!reorder) return;
        event.preventDefault();
        event.stopPropagation();
        const position = reorderPositionFor(event);
        setReorderEdge(null);
        if (reorder.tabId !== tab.id) onReorderTab(reorder.tabId, tab.id, position);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        e.stopPropagation();
        if (!editing) onSelect(tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tab.id);
        }
      }}
      title={tab.title}
    >
      {reorderEdge && (
        <span
          aria-hidden
          className={`spark-tab__reorder-edge spark-tab__reorder-edge--${reorderEdge}`}
        />
      )}
      <span style={{ display: "inline-flex", flex: "0 0 14px", color: "var(--accent)" }}>
        <SparkIcon size={13} />
      </span>
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          // Stop the parent tab's onClick from intercepting a click inside
          // the input (which would otherwise re-trigger select).
          onClick={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            minWidth: 60,
            maxWidth: 180,
            background: "var(--bg)",
            color: "var(--ink)",
            border: "1px solid var(--accent-edge)",
            borderRadius: 4,
            padding: "1px 5px",
            font: "inherit",
            outline: "none",
            boxShadow: "var(--well), var(--shadow-glow)",
          }}
        />
      ) : (
        <span className="spark-tab__label">{tab.title}</span>
      )}
      {!editing && hover && (
        <>
          <button
            type="button"
            className="spark-tab__close"
            title="Rename chat"
            aria-label="Rename chat"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <PencilGlyph />
          </button>
          <button
            type="button"
            className="spark-tab__close"
            title="Close chat"
            aria-label="Close chat"
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
          >
            <CloseIcon size={10} />
          </button>
        </>
      )}
    </div>
  );
});

function PencilGlyph() {
  return (
    <svg
      aria-hidden
      width="10"
      height="10"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12l1-3 7-7 2 2-7 7-3 1z" />
      <path d="M9 3l2 2" />
    </svg>
  );
}

function KindIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "chat") {
    return (
      <span style={{ display: "inline-flex", flex: "0 0 14px", color: "var(--accent)" }}>
        <SparkIcon size={13} />
      </span>
    );
  }
  if (tab.kind === "editor") {
    return (
      <span style={{ display: "inline-flex", flex: "0 0 14px" }}>
        <FileIcon ext={tab.entry.ext} />
      </span>
    );
  }
  if (tab.kind === "terminal") return <GlyphIcon glyph="❯" color="var(--accent)" />;
  if (tab.kind === "preview") return <GlyphIcon glyph="◉" color="var(--accent)" />;
  if (tab.kind === "automations") return <GlyphIcon glyph="◷" color="var(--accent)" />;
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
  if (t.kind === "automations") return t.title || "Automations";
  return t.title;
}

function titleFor(t: Tab): string {
  if (t.kind === "chat") return t.title;
  if (t.kind === "editor") return t.path;
  if (t.kind === "preview") return t.url;
  if (t.kind === "terminal") return t.title;
  if (t.kind === "automations") return t.title;
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
  primary = false,
  onClick,
}: {
  label: string;
  hint?: string;
  primary?: boolean;
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
        color: primary ? "var(--accent)" : "var(--ink)",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: primary ? 600 : 500,
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

// Ghost pill shown at the end of the strip while a terminal-pane drag hovers
// the tab area in a spot that would spawn a new tab on release (empty space, a
// non-terminal tab, or the pane's own source tab). Pointer-events are off so it
// never interferes with the drag's own pointer hit-testing.
function NewTabDropZone() {
  return (
    <div
      aria-hidden
      className="spark-tab"
      style={{
        pointerEvents: "none",
        flex: "0 0 auto",
        color: "var(--accent)",
        border: "1px dashed color-mix(in oklch, var(--accent) 55%, transparent)",
        background: "color-mix(in oklch, var(--accent) 12%, transparent)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      <PlusIcon size={11} />
      <span>New tab</span>
    </div>
  );
}

// Memoized default export — see the comment on the inner TabBar function.
// Wrapping the export (rather than the declaration) keeps the named inner
// function readable in React DevTools while still gating re-renders on a
// shallow prop comparison.
export default React.memo(TabBar);

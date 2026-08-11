import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatTab, Tab, TabId, TerminalTab } from "./types";
import { CloseIcon, FileIcon, GlobeIcon, PhoneIcon, PlusIcon, SparkIcon } from "../components/icons";
import { AutomationsGlyph } from "../components/automations/AutomationsGlyph";
import { RuntimeMark, type BrandRuntime } from "../components/BrandMarks";
import { collectLeaves } from "./paneTree";
import {
  TAB_REORDER_DRAG_MIME,
  TERMINAL_PANE_DRAG_MIME,
  beginTabReorderDrag,
  endTabReorderDrag,
  parseTabReorderDrag,
  parseTerminalPaneDrag,
  peekTabReorderDrag,
  peekTerminalPaneDrag,
  subscribeTerminalPaneDrag,
  type TabReorderDragPayload,
  type TerminalPaneDragPayload,
} from "./terminalDrag";
import {
  edgeAutoScrollDelta,
  planTabReorder,
  reorderTargetFor,
  toStripContentX,
  type TabReorderTarget,
  type TabSlot,
} from "./tabReorder";

// Delay before a terminal-pane drag hovering over an inactive tab in the strip
// activates that tab. Long enough that brushing past a tab during a drag
// doesn't accidentally switch context; short enough to feel responsive when
// the user genuinely lingers to drop "into" the target tab.
const HOVER_ACTIVATE_MS = 350;

// TabBar is the strip at the top of the workspace pane. Visually similar
// to a code editor's tab strip but with a kind-icon-prefixed label so it's
// obvious at a glance that you're switching between Codara chat, an editor,
// a terminal, a preview window, and a runs canvas.
//
// Behavior worth calling out:
//   - Wheel-deltaY scrolls the strip horizontally (terax pattern). Allows
//     a single-axis wheel mouse to navigate when many tabs are open.
//   - The active tab is scrolled into view on every selection change.
//   - The "+" button opens a small dropdown with kinds the user can spawn.
//   - Every tab is closable down to zero: a workspace may end up with only
//     terminal tabs, or none at all (the content area then shows the
//     empty-workspace state). Chat tabs close-and-stick via closeChatTabForRun.
//   - Middle-click closes a tab (mouseup button === 1).

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  onNewTerminal: () => void;
  onNewPreview: () => void;
  // Open the worker session picker for a runtime: the picker lists this
  // workspace's Claude / Codex history so a "+" row either starts a fresh
  // worker or resumes (or deletes) an earlier session.
  onNewClaudeWorker: () => void;
  onNewCodexWorker: () => void;
  // Starts a new draft Cora chat — the ✦ Cora button's action (identical to
  // the chat.new chord). The new-chat welcome surface is Cora's landing page.
  onNewChat: () => void;
  // Chat-tab-specific affordances: hover-revealed rename and close. Generic
  // tabs continue to use the existing onClose path.
  onRenameChat: (id: TabId, title: string) => void;
  onCloseChat: (id: TabId) => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId?: TabId) => void;
  onReorderTab: (fromId: TabId, toId: TabId, position: "before" | "after") => void;
  onPinEditorTab: (id: TabId) => void;
  // Resolved keybinding hints for the "+" picker rows, derived in App from the
  // effective binding table so they reflect the user's actual (possibly
  // rebound) chords and the right platform glyphs. A field is undefined when
  // the corresponding command has no binding — the row then renders no hint.
  // Memoized upstream so it doesn't break TabBar's React.memo identity check.
  pickerHints?: PickerHints;
  // When true, a middle-click (mouse wheel button) anywhere on a tab closes
  // it. User-configurable via Settings → General (closeTabsOnMiddleClick pref).
  closeOnMiddleClick: boolean;
}

export interface PickerHints {
  terminal?: string;
  preview?: string;
}

// Live preview of where a reorder drag would land. Derived entirely from
// planTabReorder, so what the strip paints and what the drop commits come from
// the same math.
interface ReorderPreview {
  draggedId: TabId;
  // Index into the strip WITHOUT the dragged tab — the list the drop splices
  // into, which is what keeps rightward moves free of an off-by-one.
  insertIndex: number;
  // False for a "home" drop (releasing here changes nothing): the marker is
  // suppressed and no tab is displaced, so the strip never promises a move it
  // won't make.
  changed: boolean;
  // Strip content-space x of the insertion marker.
  markerX: number;
  // translateX px by tab id; absent means 0.
  offsets: Record<TabId, number>;
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
  onNewClaudeWorker,
  onNewCodexWorker,
  onNewChat,
  onRenameChat,
  onCloseChat,
  onTerminalPaneDrop,
  onReorderTab,
  onPinEditorTab,
  pickerHints,
  closeOnMiddleClick,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const [terminalDropActive, setTerminalDropActive] = useState(false);
  // Right-click context menu on a file-backed tab (editor). Stored by tab id
  // rather than the tab object so a stale menu over a just-closed tab simply
  // renders nothing instead of acting on a dead reference.
  const [tabMenu, setTabMenu] = useState<{ id: TabId; x: number; y: number } | null>(null);
  // Stable identity so the memoized TabItem rows never re-render because of it.
  const onTabContextMenu = useRef((id: TabId, x: number, y: number) => {
    setTabMenu({ id, x, y });
  }).current;

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
  // Close the tab context menu on any outside click, Escape, or a second
  // right-click elsewhere (the new contextmenu event replaces the state).
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [tabMenu]);

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
  const acceptsTabReorder = (event: React.DragEvent): boolean =>
    Array.from(event.dataTransfer.types).includes(TAB_REORDER_DRAG_MIME);

  // ── Tab reorder ──────────────────────────────────────────────────────────
  // The whole gesture is owned by the STRIP, not by the individual tabs: one
  // hit-test against one cached geometry, so there are no dead pixels in the
  // 4px gaps between tabs or in the empty space past the last one (dropping
  // there used to be a silent cancel), and no per-tab indicator that can get
  // stranded when a fast drag skips a dragleave.
  //
  // Geometry is measured ONCE at dragstart, in strip content coordinates.
  // Re-measuring during the drag would read the live transforms of the sliding
  // tabs, and moving boundaries make the insertion index oscillate whenever the
  // pointer rests near a midpoint. Content coordinates also survive the edge
  // auto-scroll below without a re-measure.
  const reorderSlotsRef = useRef<TabSlot[] | null>(null);
  const reorderPointerRef = useRef<number | null>(null);
  const autoScrollRef = useRef<number | null>(null);
  const reorderPlanRef = useRef<ReorderPreview | null>(null);
  const [reorderPlan, setReorderPlan] = useState<ReorderPreview | null>(null);
  // Applied one frame after dragstart: dimming the source synchronously can be
  // caught by the browser's drag-image snapshot, handing the user a ghost that
  // is already faded.
  const [draggingTabId, setDraggingTabId] = useState<TabId | null>(null);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current === null) return;
    cancelAnimationFrame(autoScrollRef.current);
    autoScrollRef.current = null;
  }, []);

  // Layout boxes of every tab, in strip content space. `offsets` (when given)
  // undoes the preview transforms so a mid-gesture re-measure still reads
  // layout positions.
  const measureSlots = useCallback(
    (offsets?: Record<TabId, number>): TabSlot[] => {
      const el = scrollRef.current;
      if (!el) return [];
      const stripLeft = el.getBoundingClientRect().left;
      const scrollLeft = el.scrollLeft;
      const slots: TabSlot[] = [];
      for (const node of el.querySelectorAll<HTMLElement>("[data-tab-id]")) {
        const id = node.dataset.tabId;
        if (!id) continue;
        const rect = node.getBoundingClientRect();
        const shift = offsets?.[id] ?? 0;
        slots.push({
          id,
          start: toStripContentX(rect.left, stripLeft, scrollLeft) - shift,
          end: toStripContentX(rect.right, stripLeft, scrollLeft) - shift,
        });
      }
      return slots;
    },
    [],
  );

  // Cached geometry, refreshed only when the strip's membership changed under
  // the drag (an agent opening or closing a tab mid-gesture).
  const ensureSlots = useCallback(
    (offsets?: Record<TabId, number>): TabSlot[] => {
      const el = scrollRef.current;
      const cached = reorderSlotsRef.current;
      if (el && cached) {
        const nodes = el.querySelectorAll<HTMLElement>("[data-tab-id]");
        if (nodes.length === cached.length) {
          let same = true;
          nodes.forEach((node, index) => {
            if (node.dataset.tabId !== cached[index].id) same = false;
          });
          if (same) return cached;
        }
      }
      const next = measureSlots(offsets);
      reorderSlotsRef.current = next;
      return next;
    },
    [measureSlots],
  );

  const clearReorderPreview = useCallback(() => {
    reorderPlanRef.current = null;
    setReorderPlan((curr) => (curr === null ? curr : null));
  }, []);

  const applyReorderPlan = useCallback(
    (clientX: number) => {
      const dragged = peekTabReorderDrag()?.tabId;
      const el = scrollRef.current;
      if (!dragged || !el) return;
      reorderPointerRef.current = clientX;
      const slots = ensureSlots(reorderPlanRef.current?.offsets);
      const plan = planTabReorder(
        slots,
        dragged,
        toStripContentX(clientX, el.getBoundingClientRect().left, el.scrollLeft),
      );
      // Dragged tab is not in this strip (another window, or it was closed
      // mid-gesture) — show nothing rather than guess a destination.
      if (!plan) {
        clearReorderPreview();
        return;
      }
      const prev = reorderPlanRef.current;
      if (
        prev &&
        prev.draggedId === plan.draggedId &&
        prev.insertIndex === plan.insertIndex &&
        prev.markerX === plan.markerX
      ) {
        return;
      }
      const offsets: Record<TabId, number> = {};
      plan.offsets.forEach((offset, index) => {
        if (offset !== 0) offsets[slots[index].id] = offset;
      });
      const next: ReorderPreview = {
        draggedId: plan.draggedId,
        insertIndex: plan.insertIndex,
        changed: plan.changed,
        markerX: plan.markerX,
        offsets,
      };
      reorderPlanRef.current = next;
      setReorderPlan(next);
    },
    [clearReorderPreview, ensureSlots],
  );

  // Edge auto-scroll: without it, an overflowing strip can only be reordered
  // inside the visible window — the slot the user wants is off-screen and
  // unreachable, because HTML5 drag events never scroll a container themselves.
  const startAutoScroll = useCallback(() => {
    if (autoScrollRef.current !== null) return;
    const step = () => {
      autoScrollRef.current = null;
      const el = scrollRef.current;
      // The gesture itself is over — stop burning frames.
      if (!el || !peekTabReorderDrag()) return;
      // Pointer is off the bar (it's cleared on dragleave): idle rather than
      // stop, otherwise a drag that wandered out near an edge would keep
      // scrolling the strip on a stale coordinate.
      const clientX = reorderPointerRef.current;
      if (clientX !== null) {
        const rect = el.getBoundingClientRect();
        const delta = edgeAutoScrollDelta(clientX, rect.left, rect.right);
        if (delta !== 0) {
          const limit = el.scrollWidth - el.clientWidth;
          const next = Math.max(0, Math.min(limit, el.scrollLeft + delta));
          if (next !== el.scrollLeft) {
            el.scrollLeft = next;
            // The pointer didn't move but the content under it did, so the
            // insertion index has to be recomputed against the new scroll.
            applyReorderPlan(clientX);
          }
        }
      }
      autoScrollRef.current = requestAnimationFrame(step);
    };
    autoScrollRef.current = requestAnimationFrame(step);
  }, [applyReorderPlan]);

  const endReorderDrag = useCallback(() => {
    stopAutoScroll();
    endTabReorderDrag();
    reorderSlotsRef.current = null;
    reorderPointerRef.current = null;
    clearReorderPreview();
    setDraggingTabId((curr) => (curr === null ? curr : null));
  }, [clearReorderPreview, stopAutoScroll]);

  const handleReorderDragStart = useCallback(
    (id: TabId, event: React.DragEvent) => {
      event.dataTransfer.setData(TAB_REORDER_DRAG_MIME, JSON.stringify({ tabId: id }));
      event.dataTransfer.effectAllowed = "move";
      // Mirror the payload module-side: DataTransfer.getData is empty during
      // dragover, and the strip needs the id on every move to place the marker.
      beginTabReorderDrag({ tabId: id });
      reorderSlotsRef.current = measureSlots();
      reorderPointerRef.current = event.clientX;
      window.requestAnimationFrame(() => {
        if (peekTabReorderDrag()?.tabId !== id) return;
        setDraggingTabId(id);
      });
      startAutoScroll();
    },
    [measureSlots, startAutoScroll],
  );

  // Resolve the drop from the release position rather than trusting the last
  // dragover: a fast flick can outrun the dragover stream, and the frame the
  // user released on is the one they aimed with.
  const handleReorderDrop = useCallback(
    (event: React.DragEvent, payload: TabReorderDragPayload) => {
      const el = scrollRef.current;
      let target: TabReorderTarget | null = null;
      if (el) {
        const slots = ensureSlots(reorderPlanRef.current?.offsets);
        const plan = planTabReorder(
          slots,
          payload.tabId,
          toStripContentX(event.clientX, el.getBoundingClientRect().left, el.scrollLeft),
        );
        if (plan) target = reorderTargetFor(slots, plan);
      }
      endReorderDrag();
      if (target) onReorderTab(payload.tabId, target.toId, target.position);
    },
    [endReorderDrag, ensureSlots, onReorderTab],
  );

  // A tab closed mid-drag (agents can close tabs) never fires dragend on its
  // own element, so the preview would stay frozen on screen. Drop it.
  useEffect(() => {
    if (!draggingTabId) return;
    if (tabs.some((tab) => tab.id === draggingTabId)) return;
    endReorderDrag();
  }, [tabs, draggingTabId, endReorderDrag]);

  // Unmount safety (workspace switch mid-drag): never leave the module-level
  // payload set or an auto-scroll frame scheduled behind us.
  useEffect(
    () => () => {
      stopAutoScroll();
      endTabReorderDrag();
    },
    [stopAutoScroll],
  );

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
      // The reorder branch lives on the WHOLE bar, not on the tabs: the gaps
      // between tabs, the strip's padding and the empty run past the last tab
      // are all valid drop ground, so there is no position the user can aim at
      // that silently cancels the drag.
      onDragEnter={(event) => {
        if (acceptsTabReorder(event)) {
          event.preventDefault();
          applyReorderPlan(event.clientX);
          return;
        }
        if (!acceptsTerminalPane(event)) return;
        event.preventDefault();
        setTerminalDropActive(true);
      }}
      onDragOver={(event) => {
        if (acceptsTabReorder(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          applyReorderPlan(event.clientX);
          return;
        }
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
        // Left the bar: no drop target out there accepts a tab, so the gesture
        // reverts. Drop the preview to say so — the tab slides back home and
        // the marker goes away — and forget the pointer so edge auto-scroll
        // stops chasing a coordinate the user has abandoned.
        reorderPointerRef.current = null;
        clearReorderPreview();
      }}
      // dragend bubbles from the source tab and fires for cancels (Escape,
      // release over a non-target) as well as completed drops, so it is the one
      // reliable teardown point for the whole gesture.
      onDragEnd={endReorderDrag}
      onDrop={(event) => {
        const reorder = parseTabReorderDrag(event.dataTransfer);
        if (reorder) {
          event.preventDefault();
          handleReorderDrop(event, reorder);
          return;
        }
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
      <div
        ref={scrollRef}
        // The --reordering modifier is what turns the transform transition on,
        // and it is removed in the SAME commit that applies the new order — so
        // the tabs slide while dragging and settle instantly on drop, with no
        // reverse animation from the preview offsets to the committed layout.
        className={
          draggingTabId || reorderPlan
            ? "spark-tabbar-scroll spark-tabbar-scroll--reordering"
            : "spark-tabbar-scroll"
        }
      >
        {reorderPlan?.changed && (
          <span
            aria-hidden
            className="spark-tab-reorder-marker"
            // Rounded to a whole CSS pixel: the plan's centre is fractional
            // (real tab widths are), and a 2px rule at a half-pixel offset
            // paints as three blurry columns.
            style={{ left: Math.round(reorderPlan.markerX) }}
          />
        )}
        {tabs.map((t) =>
          t.kind === "chat" ? (
            <ChatTabItem
              key={t.id}
              tab={t}
              active={t.id === activeId}
              dragging={t.id === draggingTabId}
              dragOffset={reorderPlan?.offsets[t.id] ?? 0}
              onSelect={onSelect}
              onRename={onRenameChat}
              onClose={onCloseChat}
              onReorderDragStart={handleReorderDragStart}
              closeOnMiddleClick={closeOnMiddleClick}
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
              // Always closable: a workspace is now allowed to empty to zero
              // tabs (→ the empty-workspace state with New chat / New terminal).
              // The old `tabs.length > 1` floor would hide the × / block
              // middle-click on the last top-strip tab, making the empty state
              // unreachable by clicking. closeTab no longer enforces a floor.
              canClose
              paneDragHover={t.id === paneHoverTabId}
              dragging={t.id === draggingTabId}
              dragOffset={reorderPlan?.offsets[t.id] ?? 0}
              onSelect={onSelect}
              onClose={onClose}
              onTerminalPaneDrop={onTerminalPaneDrop}
              onReorderDragStart={handleReorderDragStart}
              onPinEditorTab={onPinEditorTab}
              onContextMenu={onTabContextMenu}
              closeOnMiddleClick={closeOnMiddleClick}
            />
          ),
        )}
        {newTabDropActive && <NewTabDropZone />}
      </div>
      {tabMenu && (() => {
        const menuTab = tabs.find((t) => t.id === tabMenu.id);
        if (!menuTab || menuTab.kind !== "editor") return null;
        return (
          <TabContextMenu
            path={menuTab.path}
            x={tabMenu.x}
            y={tabMenu.y}
            onDismiss={() => setTabMenu(null)}
          />
        );
      })()}
      {/* ✦ Cora — starts a new chat: Cora's landing surface is the new-chat
          welcome (which also carries the door to Automations). */}
      <button
        type="button"
        className="spark-tabbar-new spark-tabbar-cora"
        onClick={onNewChat}
        title="Cora: start a new chat"
        aria-label="New Cora chat"
      >
        <SparkIcon size={11} />
        <span>Cora</span>
      </button>
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
          <div className="spark-tabbar-picker spark-glass">
            {/* Workspace tab kinds only — everything Cora (new chat,
                automations, older chats) lives in the Cora Hub tab, opened
                from the dedicated ✦ Cora button to the left. */}
            <PickerSectionLabel label="Workspace" />
            <PickerItem
              label="Terminal"
              hint={pickerHints?.terminal}
              glyph={<PlusIcon size={11} />}
              accent="shell"
              onClick={() => {
                setPickerOpen(false);
                onNewTerminal();
              }}
            />
            <PickerItem
              label="Browser"
              hint={pickerHints?.preview}
              glyph={<GlobeIcon size={11} />}
              accent="shell"
              onClick={() => {
                setPickerOpen(false);
                onNewPreview();
              }}
            />
            {/* Workers open the session picker rather than a bare terminal:
                the same surface that starts a fresh agent also lists this
                workspace's history so it can be resumed or deleted. */}
            <PickerSectionLabel label="Workers" />
            <PickerItem
              label="Claude worker"
              glyph={<RuntimeGlyph runtime="claude" />}
              accent="claude"
              onClick={() => {
                setPickerOpen(false);
                onNewClaudeWorker();
              }}
            />
            <PickerItem
              label="Codex worker"
              glyph={<RuntimeGlyph runtime="codex" />}
              accent="codex"
              onClick={() => {
                setPickerOpen(false);
                onNewCodexWorker();
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
  // True while THIS tab is the reorder drag's source. Owned by the strip (not
  // local state) so a drag that ends without a dragend on this element — the
  // tab was closed mid-gesture — can still be cleaned up.
  dragging: boolean;
  // translateX px the strip's reorder preview assigns this tab, so the row
  // slides out of the way of the incoming tab instead of the list reflowing in
  // one discrete jump at drop time. 0 at rest.
  dragOffset: number;
  // Take the tab id rather than a pre-bound closure: the parent can hand
  // down ONE stable callback for every row, which (together with React.memo
  // below) lets a single tab's change skip re-rendering its siblings.
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId: TabId) => void;
  // Hands the gesture to the strip, which owns all reorder hit-testing.
  onReorderDragStart: (id: TabId, event: React.DragEvent) => void;
  onPinEditorTab: (id: TabId) => void;
  // Right-click. Only file-backed tab kinds report it (currently editors);
  // the parent owns the menu state so one menu serves the whole strip.
  onContextMenu: (id: TabId, x: number, y: number) => void;
  closeOnMiddleClick: boolean;
}

// React.memo so only the tab whose props actually changed (active flag
// flipping, dirty dot, title) re-renders — selecting tab B no longer
// repaints tabs A, C, D. Relies on the stable callbacks passed above.
const TabItem = React.memo(function TabItem({
  tab,
  active,
  canClose,
  paneDragHover,
  dragging,
  dragOffset,
  onSelect,
  onClose,
  onTerminalPaneDrop,
  onReorderDragStart,
  onPinEditorTab,
  onContextMenu,
  closeOnMiddleClick,
}: TabItemProps) {
  const [closeHover, setCloseHover] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const isPreviewEditor = tab.kind === "editor" && Boolean(tab.preview);
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

  // Terminals a background agent spawned carry an opaque color token; tint the
  // pill edge + wash so the user can tell an agent owns the tab. The token is
  // fed to the CSS as a local custom property the .spark-tab--agent rules read.
  const agentColor = tab.kind === "terminal" ? tab.color : undefined;
  const tabClass = [
    "spark-tab",
    active && "spark-tab--active",
    dragging && "spark-tab--dragging",
    (dropActive || paneDragHover) && "spark-tab--drop-target",
    agentColor && "spark-tab--agent",
  ]
    .filter(Boolean)
    .join(" ");
  const tabStyle = tabStyleFor(agentColor, dragOffset);

  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      data-preview-editor={isPreviewEditor ? "true" : undefined}
      className={tabClass}
      style={tabStyle}
      draggable
      // The strip owns the gesture from here: it stamps the tab-specific MIME
      // (so the terminal-pane drop path ignores this drag) and takes its one
      // geometry measurement while the layout is still untransformed.
      onDragStart={(event) => onReorderDragStart(tab.id, event)}
      onDragEnd={clearHoverActivate}
      onDragEnter={(event) => {
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
        // Reorder drags are deliberately NOT handled here: they bubble to the
        // strip, which hit-tests them against one cached geometry. Handling
        // them per-tab is what left the 4px gaps between tabs (and the empty
        // run past the last one) as dead, drop-cancelling ground.
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
        clearHoverActivate();
      }}
      onDrop={(event) => {
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
        if (e.button === 1 && canClose && closeOnMiddleClick) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tab.id);
        }
      }}
      onContextMenu={(e) => {
        if (tab.kind !== "editor") return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(tab.id, e.clientX, e.clientY);
      }}
      title={titleFor(tab)}
    >
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
          // draggable={false} (plus -webkit-user-drag: none in the stylesheet)
          // so a press-and-wobble on the × closes the tab instead of dragging
          // the whole tab out from under the click.
          draggable={false}
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
// available and STICKS: closing the last chat tab does not re-seed one — the
// workspace can hold only terminal tabs, or none (the empty-workspace state
// then offers "New chat"). The run stays reachable via the history popover;
// see closeChatTabForRun + the closedChatRunIds dismissed set in useTabs.
interface ChatTabItemProps {
  tab: ChatTab;
  active: boolean;
  // Same strip-owned reorder contract as TabItem — see TabItemProps.
  dragging: boolean;
  dragOffset: number;
  onSelect: (id: TabId) => void;
  onRename: (id: TabId, title: string) => void;
  onClose: (id: TabId) => void;
  onReorderDragStart: (id: TabId, event: React.DragEvent) => void;
  closeOnMiddleClick: boolean;
}

const ChatTabItem = React.memo(function ChatTabItem({
  tab,
  active,
  dragging,
  dragOffset,
  onSelect,
  onRename,
  onClose,
  onReorderDragStart,
  closeOnMiddleClick,
}: ChatTabItemProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
      style={tabStyleFor(undefined, dragOffset)}
      // Not draggable while renaming: the text selection inside the input has
      // to win over the tab gesture.
      draggable={!editing}
      // Reorder drags are hit-tested by the strip (see TabItem) — this row only
      // starts the gesture and slides when the preview asks it to.
      onDragStart={(event) => onReorderDragStart(tab.id, event)}
      onClick={(e) => {
        e.stopPropagation();
        if (!editing) onSelect(tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && closeOnMiddleClick) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tab.id);
        }
      }}
      title={tab.title}
    >
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
            borderRadius: "var(--radius-control, 5px)",
            padding: "1px 5px",
            font: "inherit",
            outline: "none",
            boxShadow: "var(--well), var(--shadow-glow)",
          }}
        />
      ) : (
        <span className="spark-tab__label">{tab.title}</span>
      )}
      {/* Rename + close are always rendered (gated only by !editing) and revealed
          via the .spark-tab:hover .spark-tab__close opacity rule — so the tab's
          width never changes on hover, and a keyboard-focused rename button is
          no longer invisible (see .spark-tab__close:focus-visible).
          Both opt out of dragging so a press on either never yanks the tab. */}
      {!editing && (
        <>
          <button
            type="button"
            className="spark-tab__close"
            draggable={false}
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
            draggable={false}
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

// Inline style for a tab row: the agent tint (a CSS custom property the
// .spark-tab--agent rules consume) and the reorder preview's slide. translate3d
// keeps the slide on the compositor — the strip never reflows mid-drag, which
// is what makes the motion smooth instead of a per-frame layout pass.
// undefined (not an empty object) when neither applies, so the common case
// hands React the same "no style" it had before.
function tabStyleFor(
  agentColor: string | undefined,
  dragOffset: number,
): React.CSSProperties | undefined {
  if (!agentColor && !dragOffset) return undefined;
  const style: React.CSSProperties = {};
  if (agentColor) (style as Record<string, string>)["--agent-accent"] = agentColor;
  if (dragOffset) style.transform = `translate3d(${dragOffset}px, 0, 0)`;
  return style;
}

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
  if (tab.kind === "terminal") {
    if (phoneDeviceNames(tab).length > 0) {
      return (
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            flex: "0 0 14px",
            color: "var(--info)",
          }}
        >
          <PhoneIcon size={12} />
        </span>
      );
    }
    return <GlyphIcon glyph="❯" color={tab.color ?? "var(--accent)"} />;
  }
  if (tab.kind === "preview") return <GlyphIcon glyph="◉" color="var(--accent)" />;
  if (tab.kind === "automations") {
    return (
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          flex: "0 0 14px",
          color: "var(--accent)",
        }}
      >
        <AutomationsGlyph size={12} />
      </span>
    );
  }
  if (tab.kind === "usage") {
    return (
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          flex: "0 0 14px",
          color: "var(--accent)",
        }}
      >
        {/* Three ascending bars — the daily-usage chart in miniature. */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <path d="M3 11V8M7 11V5.5M11 11V3" />
        </svg>
      </span>
    );
  }
  if (tab.kind === "whiteboard") {
    return (
      <span style={{ display: "inline-flex", flex: "0 0 14px", color: "var(--accent)" }}>
        <svg
          aria-hidden
          width="12"
          height="12"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="1.5" y="2.5" width="11" height="9" rx="1.5" />
          <rect x="3.5" y="4.5" width="3" height="2.4" rx="0.6" />
          <path d="M6.5 5.7h2.2M8.7 5.7v2.2M7 7.9h1.7" />
        </svg>
      </span>
    );
  }
  if (tab.kind === "diff") return <GlyphIcon glyph="±" color="var(--accent)" />;
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
  if (t.kind === "usage") return t.title || "Usage";
  if (t.kind === "diff") return `${t.title} ${t.staged ? "(Staged)" : "(Working Tree)"}`;
  return t.title;
}

function titleFor(t: Tab): string {
  if (t.kind === "chat") return t.title;
  if (t.kind === "editor") return t.path;
  if (t.kind === "preview") return t.url;
  if (t.kind === "terminal") {
    const devices = phoneDeviceNames(t);
    if (devices.length === 1) return `${t.title} — opened from phone (${devices[0]})`;
    if (devices.length > 1) return `${t.title} — opened from phones (${devices.join(", ")})`;
    return t.title;
  }
  if (t.kind === "automations") return t.title;
  if (t.kind === "usage") return t.title;
  if (t.kind === "diff") return `${t.path} ${t.staged ? "(Staged)" : "(Working Tree)"}`;
  return t.title;
}

function phoneDeviceNames(tab: TerminalTab): string[] {
  const names = new Set<string>();
  for (const pane of collectLeaves(tab.root)) {
    if (pane.origin?.kind === "phone") names.add(pane.origin.deviceName);
  }
  return [...names];
}

function cssEscape(value: string): string {
  // Limited escape: tab ids are uid()-generated so this is mostly identity.
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

// Small muted uppercase section header inside the "+" picker — groups the
// Cora-owned surfaces apart from the plain workspace tab kinds.
function PickerSectionLabel({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      style={{
        padding: "6px 12px 2px",
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        userSelect: "none",
      }}
    >
      {label}
    </div>
  );
}

function PickerItem({
  label,
  hint,
  glyph,
  accent = "shell",
  primary = false,
  onClick,
}: {
  label: string;
  hint?: string;
  // Optional leading swatch. Rows that carry one share the pane toolbar's
  // add-pane menu vocabulary (22px tinted square, provider letter or icon);
  // rows without one — the file context menu — keep the plain text layout.
  glyph?: React.ReactNode;
  accent?: PickerAccent;
  primary?: boolean;
  onClick: () => void;
}) {
  const tone = glyph ? pickerItemTone(accent) : null;
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
      {tone && (
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            flex: "0 0 22px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--radius-control, 5px)",
            background: tone.background,
            color: tone.color,
            border: `1px solid ${tone.border}`,
          }}
        >
          {glyph}
        </span>
      )}
      <span style={{ flex: 1 }}>{label}</span>
      {hint && (
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          {hint}
        </span>
      )}
    </button>
  );
}

type PickerAccent = "shell" | "claude" | "codex";

// Same three tints the pane toolbar's add-pane menu uses, so a Claude row
// reads identically whether it is spawned from the strip or from a pane.
function pickerItemTone(accent: PickerAccent): {
  color: string;
  background: string;
  border: string;
} {
  if (accent === "claude") {
    return {
      color: "var(--accent)",
      background: "color-mix(in oklch, var(--accent) 14%, transparent)",
      border: "color-mix(in oklch, var(--accent) 30%, transparent)",
    };
  }
  if (accent === "codex") {
    return {
      color: "var(--info)",
      background: "color-mix(in oklch, var(--info) 14%, transparent)",
      border: "color-mix(in oklch, var(--info) 30%, transparent)",
    };
  }
  return {
    color: "var(--ink-dim)",
    background: "color-mix(in oklab, var(--ink) 7%, transparent)",
    border: "color-mix(in oklab, var(--rule-soft) 90%, transparent)",
  };
}

function RuntimeGlyph({ runtime }: { runtime: BrandRuntime }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <RuntimeMark runtime={runtime} size={13} />
    </span>
  );
}

// Right-click menu for a file-backed tab. Fixed-position glass panel at the
// cursor, clamped to the viewport's right edge (the strip sits at the top, so
// vertical clamping is moot). The parent closes it on outside mousedown /
// Escape / window blur; mousedown inside is stopped so a row click survives
// long enough to fire.
function TabContextMenu({
  path,
  x,
  y,
  onDismiss,
}: {
  path: string;
  x: number;
  y: number;
  onDismiss: () => void;
}) {
  const width = 200;
  return (
    <div
      className="spark-tabbar-picker spark-glass"
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        zIndex: 100,
        left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
        top: y,
        width,
      }}
    >
      <PickerItem
        label="Reveal in OS"
        onClick={() => {
          onDismiss();
          void window.spark.fs.revealInOS(path).catch(() => {});
        }}
      />
      <PickerItem
        label="Copy Path"
        onClick={() => {
          onDismiss();
          void navigator.clipboard.writeText(path).catch(() => {});
        }}
      />
    </div>
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
        border: "1px dashed var(--accent-edge)",
        background: "var(--accent-soft)",
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

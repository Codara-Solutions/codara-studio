import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatTab, Tab, TabGroup, TabGroupColor, TabId, TerminalTab } from "./types";
import { buildDockIndex, canDockTab, isDockLeaf } from "./dock";
import { CloseIcon, FileIcon, GlobeIcon, PhoneIcon, PlusIcon } from "../components/icons";
import { AutomationsGlyph } from "../components/automations/AutomationsGlyph";
import AutomationsStripButton from "../components/automations/AutomationsStripButton";
import QuickCommandsButton from "../quick-commands/QuickCommandsButton";
import { CodaraMark, RuntimeMark, type BrandRuntime } from "../components/BrandMarks";
import { agentBrandTone } from "../lib/agent-brand";
import { liveTerminalRuntime } from "./terminalAgentState";
import { collectLeaves } from "./paneTree";
import {
  TAB_DOCK_DRAG_MIME,
  TAB_REORDER_DRAG_MIME,
  beginTabDockDrag,
  endTabDockDrag,
  updateTabDockDragPosition,
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
  toStripContentX,
} from "./tabReorder";
import {
  TAB_GROUP_COLORS,
  resolveStripDrop,
  tabGroupsIn,
  tabStripEntries,
  type StripDrop,
  type StripDropSlot,
} from "./tabGroups";
import { TAB_GROUP_NAME_MAX } from "@shared/tab-group-name";
import { tabStripOverflow, type TabStripOverflow } from "./tabStripOverflow";

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
  // Each starts a new session of that agent in its own terminal tab.
  // Earlier sessions are resumed from the Sessions view of the rail.
  onNewClaudeWorker: () => void;
  onNewCodexWorker: () => void;
  onNewGrokWorker: () => void;
  onNewPiWorker: () => void;
  // Starts a new draft Cora chat — the ✦ Cora button's action (identical to
  // the chat.new chord). The new-chat welcome surface is Cora's landing page.
  onNewChat: () => void;
  // Chat-tab-specific affordances: hover-revealed rename and close. Generic
  // tabs continue to use the existing onClose path.
  onRenameChat: (id: TabId, title: string) => void;
  onCloseChat: (id: TabId) => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId?: TabId) => void;
  // Tab groups. A reorder drop goes through groupActions.moveTab, which also
  // sets the group the tab lands in. Memoized upstream like pickerHints.
  groupActions: TabGroupActions;
  onPinEditorTab: (id: TabId) => void;
  onPinDiffTab: (id: TabId) => void;
  // "Open in split" from a pill's context menu — the keyboard/menu route to
  // the same thing dragging a pill into the grid does. The host is resolved
  // downstream (useTabs.openTabInSplit): the strip knows which tab was picked,
  // not which grid should take it.
  onOpenInSplit: (tabId: TabId) => void;
  // Resolved keybinding hints for the "+" picker rows, derived in App from the
  // effective binding table so they reflect the user's actual (possibly
  // rebound) chords and the right platform glyphs. A field is undefined when
  // the corresponding command has no binding — the row then renders no hint.
  // Memoized upstream so it doesn't break TabBar's React.memo identity check.
  pickerHints?: PickerHints;
  // When true, a middle-click (mouse wheel button) anywhere on a tab closes
  // it. User-configurable via Settings → General (closeTabsOnMiddleClick pref).
  closeOnMiddleClick: boolean;
  // Active workspace id for the icon-only Automations door beside the ✦ Cora
  // button (its live cue is workspace-scoped). Null hides the affordance.
  workspaceId: string | null;
}

export interface PickerHints {
  terminal?: string;
  preview?: string;
}

export interface TabGroupActions {
  moveTab: (tabId: TabId, drop: StripDrop) => void;
  // A new, unnamed group holding the tab; returns its id.
  create: (tabId: TabId) => string;
  add: (tabId: TabId, groupId: string) => void;
  remove: (tabId: TabId) => void;
  rename: (groupId: string, name: string) => void;
  recolor: (groupId: string, color: TabGroupColor) => void;
  toggleCollapsed: (groupId: string) => void;
  ungroup: (groupId: string) => void;
  // Closes the group's tabs in this strip.
  close: (groupId: string) => void;
}

// Opens the group editor for a group in the strip on screen, for the
// keyboard commands that act on the selected tab's group.
export const TAB_GROUP_MENU_EVENT = "spark:tab-group-menu";

// Live preview of where a reorder drag would land. Derived entirely from
// planTabReorder, so what the strip paints and what the drop commits come from
// the same math.
interface ReorderPreview {
  draggedId: TabId;
  // Index into the strip WITHOUT the dragged tab — the list the drop splices
  // into, which is what keeps rightward moves free of an off-by-one.
  insertIndex: number;
  // False for a "home" drop (releasing here changes nothing): the ghost slot
  // fades out and no tab is displaced, so the strip never promises a move it
  // won't make.
  changed: boolean;
  // Strip content-space box of the ghost slot — the placeholder that fills the
  // hole the displaced tabs open, sized to the dragged tab.
  ghostStart: number;
  ghostWidth: number;
  // translateX px by tab id; absent means 0.
  offsets: Record<TabId, number>;
  // The group the tab would join here, which tints the ghost slot.
  groupColor: TabGroupColor | null;
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
  onNewGrokWorker,
  onNewPiWorker,
  onNewChat,
  onRenameChat,
  onCloseChat,
  onTerminalPaneDrop,
  groupActions,
  onPinEditorTab,
  onPinDiffTab,
  onOpenInSplit,
  pickerHints,
  closeOnMiddleClick,
  workspaceId,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const stripEntries = useMemo(() => tabStripEntries(tabs), [tabs]);
  const [stripOverflow, setStripOverflow] = useState<TabStripOverflow>({
    left: false,
    right: false,
  });
  const updateStripOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = tabStripOverflow(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setStripOverflow((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);
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
  // The group editor: name, color, ungroup, close. Opened from a chip's
  // context menu, from "Add to new group", or by the keyboard commands.
  const [groupMenu, setGroupMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const openGroupMenu = useRef((groupId: string, x: number, y: number) => {
    setTabMenu(null);
    setGroupMenu({ groupId, x, y });
  }).current;
  const groupMenuRef = useRef(groupMenu);
  groupMenuRef.current = groupMenu;
  const closeGroupMenu = useCallback((returnFocus: boolean) => {
    const current = groupMenuRef.current;
    setGroupMenu(null);
    if (current && returnFocus) {
      const chip = scrollRef.current?.querySelector<HTMLElement>(
        `[data-tab-group-chip="${cssEscape(current.groupId)}"]`,
      );
      window.requestAnimationFrame(() => chip?.focus());
    }
  }, []);
  // Anchored under the chip, which may only appear once the state that made
  // the group has rendered.
  const openGroupMenuAtChip = useCallback((groupId: string) => {
    let attempts = 0;
    const place = () => {
      const chip = scrollRef.current?.querySelector<HTMLElement>(
        `[data-tab-group-chip="${cssEscape(groupId)}"]`,
      );
      if (!chip) {
        attempts += 1;
        if (attempts < 10) window.requestAnimationFrame(place);
        return;
      }
      chip.scrollIntoView({ block: "nearest", inline: "nearest" });
      const rect = chip.getBoundingClientRect();
      openGroupMenu(groupId, rect.left, rect.bottom + 4);
    };
    window.requestAnimationFrame(place);
  }, [openGroupMenu]);
  useEffect(() => {
    const onRequest = (event: Event) => {
      const groupId = (event as CustomEvent<{ groupId?: unknown }>).detail?.groupId;
      if (typeof groupId === "string") openGroupMenuAtChip(groupId);
    };
    window.addEventListener(TAB_GROUP_MENU_EVENT, onRequest);
    return () => window.removeEventListener(TAB_GROUP_MENU_EVENT, onRequest);
  }, [openGroupMenuAtChip]);
  useEffect(() => {
    if (!groupMenu) return;
    const close = () => closeGroupMenu(false);
    document.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [groupMenu, closeGroupMenu]);
  // A group that lost its last tab in this strip takes its editor with it.
  useEffect(() => {
    if (groupMenu && !tabs.some((tab) => tab.group?.id === groupMenu.groupId)) setGroupMenu(null);
  }, [tabs, groupMenu]);

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
  const reorderSlotsRef = useRef<StripDropSlot[] | null>(null);
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

  // Layout boxes of every tab and group chip, in strip content space.
  // `offsets` (when given) undoes the preview transforms so a mid-gesture
  // re-measure still reads layout positions. Chips are slots too: they slide
  // out of the way like tabs, and landing just after one joins its group.
  const measureSlots = useCallback(
    (offsets?: Record<TabId, number>): StripDropSlot[] => {
      const el = scrollRef.current;
      if (!el) return [];
      const stripLeft = el.getBoundingClientRect().left;
      const scrollLeft = el.scrollLeft;
      const slots: StripDropSlot[] = [];
      for (const node of el.querySelectorAll<HTMLElement>(STRIP_SLOT_SELECTOR)) {
        const slot = stripSlotOf(node);
        if (!slot) continue;
        const rect = node.getBoundingClientRect();
        const shift = offsets?.[slot.id] ?? 0;
        slots.push({
          ...slot,
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
    (offsets?: Record<TabId, number>): StripDropSlot[] => {
      const el = scrollRef.current;
      const cached = reorderSlotsRef.current;
      if (el && cached) {
        const nodes = el.querySelectorAll<HTMLElement>(STRIP_SLOT_SELECTOR);
        if (nodes.length === cached.length) {
          let same = true;
          nodes.forEach((node, index) => {
            const slot = stripSlotOf(node);
            if (
              !slot ||
              slot.id !== cached[index].id ||
              slot.groupId !== cached[index].groupId ||
              slot.collapsed !== cached[index].collapsed
            ) {
              same = false;
            }
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
      const pointerX = toStripContentX(clientX, el.getBoundingClientRect().left, el.scrollLeft);
      const plan = planTabReorder(slots, dragged, pointerX);
      // Dragged tab is not in this strip (another window, or it was closed
      // mid-gesture) — show nothing rather than guess a destination.
      if (!plan) {
        clearReorderPreview();
        return;
      }
      const drop = resolveStripDrop({
        slots,
        draggedId: dragged,
        insertIndex: plan.insertIndex,
        pointerX,
        membersOf: (groupId) => groupMemberIds(tabsRef.current, groupId),
      });
      const landingGroupId = drop
        ? drop.groupId
        : slots.find((slot) => slot.id === dragged)?.groupId ?? null;
      const groupColor = landingGroupId
        ? tabsRef.current.find((tab) => tab.group?.id === landingGroupId)?.group?.color ?? null
        : null;
      const prev = reorderPlanRef.current;
      if (
        prev &&
        prev.draggedId === plan.draggedId &&
        prev.insertIndex === plan.insertIndex &&
        prev.ghostStart === plan.ghostStart &&
        prev.changed === (drop !== null) &&
        prev.groupColor === groupColor
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
        // A drop at the tab's own place still changes something when it
        // joins or leaves a group there.
        changed: drop !== null,
        ghostStart: plan.ghostStart,
        ghostWidth: plan.ghostWidth,
        offsets,
        groupColor,
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
            updateStripOverflow();
            // The pointer didn't move but the content under it did, so the
            // insertion index has to be recomputed against the new scroll.
            applyReorderPlan(clientX);
          }
        }
      }
      autoScrollRef.current = requestAnimationFrame(step);
    };
    autoScrollRef.current = requestAnimationFrame(step);
  }, [applyReorderPlan, updateStripOverflow]);

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
      let drop: StripDrop | null = null;
      if (el) {
        const slots = ensureSlots(reorderPlanRef.current?.offsets);
        const pointerX = toStripContentX(event.clientX, el.getBoundingClientRect().left, el.scrollLeft);
        const plan = planTabReorder(slots, payload.tabId, pointerX);
        if (plan) {
          drop = resolveStripDrop({
            slots,
            draggedId: payload.tabId,
            insertIndex: plan.insertIndex,
            pointerX,
            membersOf: (groupId) => groupMemberIds(tabsRef.current, groupId),
          });
        }
      }
      endReorderDrag();
      if (drop) groupActions.moveTab(payload.tabId, drop);
    },
    [endReorderDrag, ensureSlots, groupActions],
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
  //   - over a different splittable tab: hover-activate it so the user can
  //     choose an edge inside its content, or release on the tab to split;
  //   - over empty strip space / an unsupported tab / the pane's own tab:
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
      // A supported destination gets hover activation and a drop highlight.
      // Empty strip space and the source tab remain the new-tab drop zone.
      if (
        hoveredTab &&
        (hoveredTab.kind === "terminal" || canDockTab(hoveredTab)) &&
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

    const onPointerUp = (event: PointerEvent) => {
      if (!dragActive) return;
      const payload = dragPayload;
      const wasOverStrip = overStrip;
      const target = mergeTargetId;
      clearPaneHoverActivate();
      resetDropTracking();
      dragActive = false;
      dragPayload = null;
      if (event.type !== "pointerup" || !payload || !wasOverStrip) return;
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

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateStripOverflow();
    const resizeObserver = new ResizeObserver(updateStripOverflow);
    el.addEventListener("scroll", onScroll, { passive: true });
    resizeObserver.observe(el);
    for (const tab of el.querySelectorAll<HTMLElement>(STRIP_SLOT_SELECTOR)) {
      resizeObserver.observe(tab);
    }
    updateStripOverflow();
    const frame = window.requestAnimationFrame(updateStripOverflow);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [tabs, updateStripOverflow]);

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
      updateStripOverflow();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [updateStripOverflow]);

  // Keep the active tab in view after a selection or open.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${cssEscape(activeId)}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateStripOverflow();
    const frame = window.requestAnimationFrame(updateStripOverflow);
    return () => window.cancelAnimationFrame(frame);
  }, [activeId, tabs.length, updateStripOverflow]);

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
        className={[
          "spark-tabbar-scroll",
          stripOverflow.left && "spark-tabbar-scroll--overflow-left",
          stripOverflow.right && "spark-tabbar-scroll--overflow-right",
          (draggingTabId || reorderPlan) && "spark-tabbar-scroll--reordering",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {/* Ghost slot: a soft placeholder the exact size of the dragged tab,
            sitting in the hole its neighbours slid apart to open. Kept mounted
            for the whole drag and faded (not unmounted) on a home drop, so it
            glides between destinations instead of blinking in and out.
            Positioned by transform for the same compositor-only reason the
            tabs are. Whole-pixel so the hairline stays crisp. */}
        {reorderPlan && (
          <span
            aria-hidden
            className={
              reorderPlan.changed
                ? "spark-tab-reorder-ghost spark-tab-reorder-ghost--visible"
                : "spark-tab-reorder-ghost"
            }
            data-group-color={reorderPlan.groupColor ?? undefined}
            style={{
              width: Math.round(reorderPlan.ghostWidth),
              // -50% pairs with the rule's top: 50% to sit on the chips' own
              // centreline; x is whole-pixel so the hairline stays crisp.
              transform: `translate3d(${Math.round(reorderPlan.ghostStart)}px, -50%, 0)`,
              ...groupColorStyle(reorderPlan.groupColor),
            }}
          />
        )}
        {stripEntries.map((entry) => {
          if (entry.kind === "group") {
            return (
              <TabGroupChip
                key={chipSlotId(entry.group.id)}
                group={entry.group}
                count={entry.memberIds.length}
                dragOffset={reorderPlan?.offsets[chipSlotId(entry.group.id)] ?? 0}
                onToggle={groupActions.toggleCollapsed}
                onOpenMenu={openGroupMenu}
              />
            );
          }
          const t = entry.tab;
          return t.kind === "chat" ? (
            <ChatTabItem
              key={t.id}
              tab={t}
              active={t.id === activeId}
              dragging={t.id === draggingTabId}
              dragOffset={reorderPlan?.offsets[t.id] ?? 0}
              groupId={entry.group?.id ?? null}
              groupColor={entry.group?.color ?? null}
              groupLast={entry.lastInGroup}
              onSelect={onSelect}
              onRename={onRenameChat}
              onClose={onCloseChat}
              onReorderDragStart={handleReorderDragStart}
              onContextMenu={onTabContextMenu}
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
              groupId={entry.group?.id ?? null}
              groupColor={entry.group?.color ?? null}
              groupLast={entry.lastInGroup}
              onSelect={onSelect}
              onClose={onClose}
              onTerminalPaneDrop={onTerminalPaneDrop}
              onReorderDragStart={handleReorderDragStart}
              onPinEditorTab={onPinEditorTab}
              onPinDiffTab={onPinDiffTab}
              onContextMenu={onTabContextMenu}
              closeOnMiddleClick={closeOnMiddleClick}
            />
          );
        })}
        {newTabDropActive && <NewTabDropZone />}
      </div>
      {tabMenu && (() => {
        const menuTab = tabs.find((t) => t.id === tabMenu.id);
        if (!menuTab) return null;
        const path = menuTab.kind === "editor" ? menuTab.path : null;
        // No host lookup here: openTabInSplit finds (or mints) the grid. The
        // only thing the strip still decides is whether the entry is offered
        // at all — a second chat can't be docked while one already is, and an
        // item that silently does nothing is worse than no item.
        const chatDockTaken =
          menuTab.kind === "chat" &&
          [...buildDockIndex(tabs).keys()].some(
            (id) => id !== menuTab.id && tabs.find((t) => t.id === id)?.kind === "chat",
          );
        const canDock = canDockTab(menuTab) && !chatDockTaken;
        const browserTabId = menuTab.kind === "preview" ? menuTab.id : null;
        const ownGroupId = menuTab.group?.id ?? null;
        return (
          <TabContextMenu
            path={path}
            browserTabId={browserTabId}
            x={tabMenu.x}
            y={tabMenu.y}
            onOpenInSplit={canDock ? () => onOpenInSplit(menuTab.id) : undefined}
            otherGroups={tabGroupsIn(tabs).filter((group) => group.id !== ownGroupId)}
            grouped={ownGroupId !== null}
            onNewGroup={() => openGroupMenuAtChip(groupActions.create(menuTab.id))}
            onAddToGroup={(groupId) => groupActions.add(menuTab.id, groupId)}
            onRemoveFromGroup={() => groupActions.remove(menuTab.id)}
            onDismiss={() => setTabMenu(null)}
          />
        );
      })()}
      {groupMenu && (() => {
        const members = tabs.filter((tab) => tab.group?.id === groupMenu.groupId);
        const group = members[0]?.group;
        if (!group) return null;
        return (
          <TabGroupMenu
            key={group.id}
            group={group}
            terminalCount={members.reduce((count, tab) => count + runningTerminalCount(tab), 0)}
            x={groupMenu.x}
            y={groupMenu.y}
            onRename={(name) => groupActions.rename(group.id, name)}
            onRecolor={(color) => groupActions.recolor(group.id, color)}
            onUngroup={() => groupActions.ungroup(group.id)}
            onCloseGroup={() => groupActions.close(group.id)}
            onDismiss={closeGroupMenu}
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
        <CodaraMark size={11} />
        <span>Cora</span>
      </button>
      {/* Icon-only Automations door, a first-class neighbor of ✦ Cora rather
          than a sub-tab affordance. Quiet loop glyph when idle; live cue
          (spinner / needs-you dot + name) while an automation runs. */}
      {workspaceId && <AutomationsStripButton workspaceId={workspaceId} />}
      {/* Saved shell commands and agent prompts, one click away. */}
      {workspaceId && <QuickCommandsButton />}
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
            <PickerItem
              label="Grok worker"
              glyph={<RuntimeGlyph runtime="grok" />}
              accent="grok"
              onClick={() => {
                setPickerOpen(false);
                onNewGrokWorker();
              }}
            />
            <PickerItem
              label="Pi worker"
              glyph={<RuntimeGlyph runtime="pi" />}
              accent="pi"
              onClick={() => {
                setPickerOpen(false);
                onNewPiWorker();
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
  // The tab's group, as primitives so React.memo still compares cheaply.
  // groupLast ends the group's colored underline at this tab.
  groupId: string | null;
  groupColor: TabGroupColor | null;
  groupLast: boolean;
  // Take the tab id rather than a pre-bound closure: the parent can hand
  // down ONE stable callback for every row, which (together with React.memo
  // below) lets a single tab's change skip re-rendering its siblings.
  onSelect: (id: TabId) => void;
  onClose: (id: TabId) => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId: TabId) => void;
  // Hands the gesture to the strip, which owns all reorder hit-testing.
  onReorderDragStart: (id: TabId, event: React.DragEvent) => void;
  onPinEditorTab: (id: TabId) => void;
  onPinDiffTab: (id: TabId) => void;
  // Right-click. The parent owns the menu state so one menu serves the whole
  // strip.
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
  groupId,
  groupColor,
  groupLast,
  onSelect,
  onClose,
  onTerminalPaneDrop,
  onReorderDragStart,
  onPinEditorTab,
  onPinDiffTab,
  onContextMenu,
  closeOnMiddleClick,
}: TabItemProps) {
  const [closeHover, setCloseHover] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const isPreviewEditor =
    (tab.kind === "editor" && Boolean(tab.preview)) ||
    (tab.kind === "diff" && Boolean(tab.preview));
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
    (tab.kind === "terminal" || canDockTab(tab)) &&
    Array.from(event.dataTransfer.types).includes(TERMINAL_PANE_DRAG_MIME);

  const tabClass = [
    "spark-tab",
    active && "spark-tab--active",
    dragging && "spark-tab--dragging",
    (dropActive || paneDragHover) && "spark-tab--drop-target",
  ]
    .filter(Boolean)
    .join(" ");
  const tabStyle = tabStyleFor(dragOffset, groupColor);

  return (
    <div
      role="tab"
      aria-selected={active}
      aria-describedby={groupId ? groupNameDomId(groupId) : undefined}
      data-tab-id={tab.id}
      data-tab-group={groupId ?? undefined}
      data-group-last={groupLast ? "true" : undefined}
      data-preview-editor={isPreviewEditor ? "true" : undefined}
      className={tabClass}
      style={tabStyle}
      draggable
      // The strip owns the gesture from here: it stamps the tab-specific MIME
      // (so the terminal-pane drop path ignores this drag) and takes its one
      // geometry measurement while the layout is still untransformed.
      onDragStart={(event) => {
        onReorderDragStart(tab.id, event);
        // The same gesture doubles as "dock this tab": the strip reads the
        // reorder MIME, the split grid reads this one. dragover can't call
        // getData, so the grid tracks the payload through the module-level
        // channel and only uses the MIME to decide whether to accept a drop.
        if (canDockTab(tab)) {
          event.dataTransfer.setData(
            TAB_DOCK_DRAG_MIME,
            JSON.stringify({ tabId: tab.id, tabKind: tab.kind, title: tab.title }),
          );
          beginTabDockDrag(
            { tabId: tab.id, tabKind: tab.kind as "preview" | "editor" | "chat", title: tab.title },
            { clientX: event.clientX, clientY: event.clientY },
          );
        }
      }}
      onDrag={(event) => {
        // Native drag events carry the pointer; the grid needs it to hit-test
        // which cell edge the cursor is over.
        if (event.clientX === 0 && event.clientY === 0) return;
        updateTabDockDragPosition({ clientX: event.clientX, clientY: event.clientY });
      }}
      onDragEnd={() => {
        endTabDockDrag();
        clearHoverActivate();
      }}
      onDragEnter={(event) => {
        const reordered = peekTabReorderDrag();
        if (reordered && reordered.tabId !== tab.id) {
          if (!active && hoverActivateTimer.current === null) {
            hoverActivateTimer.current = window.setTimeout(() => {
              hoverActivateTimer.current = null;
              if (peekTabReorderDrag()?.tabId === reordered.tabId) onSelect(tab.id);
            }, HOVER_ACTIVATE_MS);
          }
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
        if (!payload || !acceptsPaneDrop(event)) return;
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
        else if (tab.kind === "diff" && tab.preview) onPinDiffTab(tab.id);
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && canClose && closeOnMiddleClick) {
          e.preventDefault();
          e.stopPropagation();
          onClose(tab.id);
        }
      }}
      onContextMenu={(e) => {
        // Every tab gets the group actions; editors add file actions and
        // dockable tabs "Open in split".
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
  // Same strip-owned reorder and group contract as TabItem; see TabItemProps.
  dragging: boolean;
  dragOffset: number;
  groupId: string | null;
  groupColor: TabGroupColor | null;
  groupLast: boolean;
  onSelect: (id: TabId) => void;
  onRename: (id: TabId, title: string) => void;
  onClose: (id: TabId) => void;
  onReorderDragStart: (id: TabId, event: React.DragEvent) => void;
  onContextMenu: (id: TabId, x: number, y: number) => void;
  closeOnMiddleClick: boolean;
}

const ChatTabItem = React.memo(function ChatTabItem({
  tab,
  active,
  dragging,
  dragOffset,
  groupId,
  groupColor,
  groupLast,
  onSelect,
  onRename,
  onClose,
  onReorderDragStart,
  onContextMenu,
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
      aria-describedby={groupId ? groupNameDomId(groupId) : undefined}
      data-tab-id={tab.id}
      data-tab-group={groupId ?? undefined}
      data-group-last={groupLast ? "true" : undefined}
      className={className}
      style={tabStyleFor(dragOffset, groupColor)}
      // Not draggable while renaming: the text selection inside the input has
      // to win over the tab gesture.
      draggable={!editing}
      onContextMenu={(e) => {
        if (editing) return;
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(tab.id, e.clientX, e.clientY);
      }}
      // Reorder drags are hit-tested by the strip (see TabItem) — this row only
      // starts the gesture and slides when the preview asks it to. The same
      // gesture doubles as "dock this tab" for the split grid.
      onDragStart={(event) => {
        onReorderDragStart(tab.id, event);
        if (canDockTab(tab)) {
          event.dataTransfer.setData(
            TAB_DOCK_DRAG_MIME,
            JSON.stringify({ tabId: tab.id, tabKind: tab.kind, title: tab.title }),
          );
          beginTabDockDrag(
            { tabId: tab.id, tabKind: "chat", title: tab.title },
            { clientX: event.clientX, clientY: event.clientY },
          );
        }
      }}
      onDrag={(event) => {
        if (event.clientX === 0 && event.clientY === 0) return;
        updateTabDockDragPosition({ clientX: event.clientX, clientY: event.clientY });
      }}
      onDragEnd={() => {
        endTabDockDrag();
      }}
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
      title={tab.tooltip ?? tab.title}
    >
      <span style={{ display: "inline-flex", flex: "0 0 14px", color: "var(--accent-text)" }}>
        <CodaraMark size={13} />
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

// Keep reorder motion on the compositor so the strip never reflows mid-drag.
// An ungrouped tab at rest gets no style object at all.
function tabStyleFor(
  dragOffset: number,
  groupColor: TabGroupColor | null = null,
): React.CSSProperties | undefined {
  if (!dragOffset && !groupColor) return undefined;
  return {
    ...(dragOffset ? { transform: `translate3d(${dragOffset}px, 0, 0)` } : {}),
    ...groupColorStyle(groupColor),
  };
}

// The strip paints a group in its color through one custom property, whose
// per-theme values (styles.css, --tab-group-*) keep it readable.
function groupColorStyle(color: TabGroupColor | null): React.CSSProperties {
  return color ? ({ "--tab-group-color": `var(--tab-group-${color})` } as React.CSSProperties) : {};
}

const STRIP_SLOT_SELECTOR = "[data-tab-id], [data-tab-group-chip]";

function chipSlotId(groupId: string): string {
  return `group:${groupId}`;
}

function groupNameDomId(groupId: string): string {
  return `spark-tab-group-name-${groupId}`;
}

// A strip element as a drag slot, read from the data attributes the tabs and
// chips render, so the geometry and the group of each box come from one read.
function stripSlotOf(node: HTMLElement): Omit<StripDropSlot, "start" | "end"> | null {
  const tabId = node.dataset.tabId;
  if (tabId) return { id: tabId, chip: false, groupId: node.dataset.tabGroup ?? null, collapsed: false };
  const groupId = node.dataset.tabGroupChip;
  if (groupId) {
    return { id: chipSlotId(groupId), chip: true, groupId, collapsed: node.dataset.collapsed === "true" };
  }
  return null;
}

function groupMemberIds(tabs: readonly Tab[], groupId: string): TabId[] {
  return tabs.filter((tab) => tab.group?.id === groupId).map((tab) => tab.id);
}

// Terminal panes a close would stop; a docked cell hosts another tab, not a
// shell.
function runningTerminalCount(tab: Tab): number {
  if (tab.kind !== "terminal") return 0;
  return collectLeaves(tab.root).filter((leaf) => !isDockLeaf(leaf)).length;
}

const TAB_GROUP_COLOR_LABELS: Record<TabGroupColor, string> = {
  grey: "Grey",
  blue: "Blue",
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  pink: "Pink",
  purple: "Purple",
  cyan: "Cyan",
  orange: "Orange",
};

interface TabGroupChipProps {
  group: TabGroup;
  count: number;
  dragOffset: number;
  onToggle: (groupId: string) => void;
  onOpenMenu: (groupId: string, x: number, y: number) => void;
}

// The group's handle in the strip: click folds or unfolds its tabs, the
// context menu (or Shift+F10 / the Menu key) opens the group editor. Solid
// like the tabs beside it; only the editor floats.
const TabGroupChip = React.memo(function TabGroupChip({
  group,
  count,
  dragOffset,
  onToggle,
  onOpenMenu,
}: TabGroupChipProps) {
  const collapsed = Boolean(group.collapsed);
  const tabsLabel = `${count} ${count === 1 ? "tab" : "tabs"}`;
  const label = group.name ? `Tab group ${group.name}` : "Unnamed tab group";
  return (
    <button
      type="button"
      className="spark-tab-group-chip"
      data-tab-group-chip={group.id}
      data-collapsed={collapsed ? "true" : "false"}
      data-unnamed={group.name ? undefined : "true"}
      aria-expanded={!collapsed}
      aria-haspopup="dialog"
      aria-label={`${label}, ${TAB_GROUP_COLOR_LABELS[group.color]}, ${tabsLabel}`}
      title={`${group.name || "Unnamed group"}: ${tabsLabel}. Click to ${collapsed ? "expand" : "collapse"}; right-click to edit.`}
      draggable={false}
      style={{
        ...groupColorStyle(group.color),
        ...(dragOffset ? { transform: `translate3d(${dragOffset}px, 0, 0)` } : {}),
      }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(group.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(group.id, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          onOpenMenu(group.id, rect.left, rect.bottom + 4);
        }
      }}
    >
      <span className="spark-tab-group-chip__dot" aria-hidden />
      {group.name && (
        <span className="spark-tab-group-chip__name" aria-hidden>
          {group.name}
        </span>
      )}
      {collapsed && (
        <span className="spark-tab-group-chip__count" aria-hidden>
          {count}
        </span>
      )}
      <span id={groupNameDomId(group.id)} className="spark-sr-only">
        {group.name ? `In tab group ${group.name}` : "In an unnamed tab group"}
      </span>
    </button>
  );
});

// The group editor, Chrome's bubble: name, color, ungroup, close. Edits apply
// as they are made. Enter or Escape closes it and returns focus to the chip.
function TabGroupMenu({
  group,
  terminalCount,
  x,
  y,
  onRename,
  onRecolor,
  onUngroup,
  onCloseGroup,
  onDismiss,
}: {
  group: TabGroup;
  terminalCount: number;
  x: number;
  y: number;
  onRename: (name: string) => void;
  onRecolor: (color: TabGroupColor) => void;
  onUngroup: () => void;
  onCloseGroup: () => void;
  onDismiss: (returnFocus: boolean) => void;
}) {
  const width = 236;
  const [draft, setDraft] = useState(group.name);
  const [confirmClose, setConfirmClose] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const moveColor = (delta: number) => {
    const index = TAB_GROUP_COLORS.indexOf(group.color);
    const next = TAB_GROUP_COLORS[(index + delta + TAB_GROUP_COLORS.length) % TAB_GROUP_COLORS.length];
    onRecolor(next);
    swatchRefs.current[TAB_GROUP_COLORS.indexOf(next)]?.focus();
  };
  const terminalsLabel = `${terminalCount} running terminal${terminalCount === 1 ? "" : "s"}`;
  return (
    <div
      className="spark-tabbar-picker spark-glass spark-tab-group-menu"
      role="dialog"
      aria-label={group.name ? `Tab group ${group.name}` : "Unnamed tab group"}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onDismiss(true);
        }
      }}
      style={{
        position: "fixed",
        zIndex: 100,
        left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
        top: y,
        width,
      }}
    >
      <div className="spark-tab-group-menu__field">
        <input
          ref={inputRef}
          value={draft}
          maxLength={TAB_GROUP_NAME_MAX}
          placeholder="Name this group"
          aria-label="Group name"
          spellCheck={false}
          onChange={(e) => {
            setDraft(e.target.value);
            onRename(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onDismiss(true);
            }
          }}
        />
      </div>
      <div
        role="radiogroup"
        aria-label="Group color"
        className="spark-tab-group-menu__colors"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            moveColor(1);
          } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            moveColor(-1);
          }
        }}
      >
        {TAB_GROUP_COLORS.map((color, index) => (
          <button
            key={color}
            ref={(node) => {
              swatchRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={color === group.color}
            aria-label={TAB_GROUP_COLOR_LABELS[color]}
            title={TAB_GROUP_COLOR_LABELS[color]}
            tabIndex={color === group.color ? 0 : -1}
            className="spark-tab-group-swatch"
            style={groupColorStyle(color)}
            onClick={() => onRecolor(color)}
          />
        ))}
      </div>
      <div className="spark-tab-group-menu__rule" role="separator" />
      <PickerItem
        label="Ungroup"
        hint="tabs stay"
        onClick={() => {
          onUngroup();
          onDismiss(false);
        }}
      />
      <PickerItem
        label={confirmClose ? `Close group and ${terminalsLabel}` : "Close group"}
        danger={confirmClose}
        onClick={() => {
          if (terminalCount > 0 && !confirmClose) {
            setConfirmClose(true);
            return;
          }
          onCloseGroup();
          onDismiss(false);
        }}
      />
      {confirmClose && (
        <div role="alert" className="spark-tab-group-menu__warning">
          This group has {terminalsLabel}. Choose Close group again to stop them and close its tabs.
        </div>
      )}
    </div>
  );
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
      <span style={{ display: "inline-flex", flex: "0 0 14px", color: "var(--accent-text)" }}>
        <CodaraMark size={13} />
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
    const workerRuntimes = terminalWorkerRuntimes(tab);
    if (workerRuntimes.length > 1) {
      return <SplitAgentsMark runtimes={workerRuntimes} />;
    }
    const workerRuntime = workerRuntimes[0];
    if (workerRuntime) {
      return (
        <span style={{ display: "inline-flex", flex: "0 0 14px", color: `var(--agent-${workerRuntime})` }}>
          <RuntimeMark runtime={workerRuntime} size={13} />
        </span>
      );
    }
    return <GlyphIcon glyph="❯" color={tab.color ?? "var(--accent-text)"} />;
  }
  if (tab.kind === "preview") return <GlyphIcon glyph="◉" color="var(--accent-text)" />;
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
          color: "var(--accent-text)",
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
          color: "var(--accent-text)",
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
      <span style={{ display: "inline-flex", flex: "0 0 14px", color: "var(--accent-text)" }}>
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
  if (tab.kind === "diff") return <GlyphIcon glyph="±" color="var(--accent-text)" />;
  return <GlyphIcon glyph="◆" color="var(--accent-text)" />;
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
  if (t.kind === "diff") {
    if (t.review) return t.title;
    // Commit tabs already carry "name @ hash" in the title; don't re-suffix.
    return t.commitHash ? t.title : `${t.title} ${t.staged ? "(Staged)" : "(Working Tree)"}`;
  }
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
  if (t.kind === "diff") {
    if (t.review) return "Review every change of the workspace and leave notes for an agent";
    return t.commitHash
      ? `${t.path} @ ${t.commitHash.slice(0, 7)} (Commit)`
      : `${t.path} ${t.staged ? "(Staged)" : "(Working Tree)"}`;
  }
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
  swatch,
  accent = "shell",
  primary = false,
  danger = false,
  onClick,
}: {
  label: string;
  hint?: string;
  // A tab group's color dot, for the rows that name a group.
  swatch?: TabGroupColor;
  danger?: boolean;
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
        color: danger ? "var(--danger)" : primary ? "var(--accent-text)" : "var(--ink)",
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
      {swatch && <span aria-hidden className="spark-tab-group-dot" style={groupColorStyle(swatch)} />}
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {hint && (
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={hint}>
          {hint}
        </span>
      )}
    </button>
  );
}

type PickerAccent = "shell" | "claude" | "codex" | "grok" | "pi";

// Same three tints the pane toolbar's add-pane menu uses, so a Claude row
// reads identically whether it is spawned from the strip or from a pane.
function pickerItemTone(accent: PickerAccent): {
  color: string;
  background: string;
  border: string;
} {
  return agentBrandTone(accent);
}

function terminalWorkerRuntimes(tab: TerminalTab): BrandRuntime[] {
  const runtimes: BrandRuntime[] = [];
  for (const leaf of collectLeaves(tab.root)) {
    // Only while the agent TUI is actually in the pane. A durable
    // agentSession pointer is kept for resume after Claude exits, and must
    // not keep the Claude mark on a shell tab.
    const runtime = liveTerminalRuntime(leaf.worker);
    if (runtime && !runtimes.includes(runtime)) runtimes.push(runtime);
  }
  return runtimes;
}

/** A tiny split-grid mark for a tab hosting more than one live agent family. */
function SplitAgentsMark({ runtimes }: { runtimes: BrandRuntime[] }) {
  return (
    <span
      aria-label={`${runtimes.length} agent types in split terminal`}
      title={runtimes.map((runtime) => runtime[0].toUpperCase() + runtime.slice(1)).join(" + ")}
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, 5px)",
        gridAutoRows: 5,
        gap: 1.5,
        width: 12,
        height: 12,
        flex: "0 0 14px",
        alignContent: "center",
      }}
    >
      {runtimes.slice(0, 4).map((runtime) => (
        <span
          key={runtime}
          aria-hidden
          style={{
            borderRadius: 1.5,
            background: `var(--agent-${runtime})`,
            boxShadow: "inset 0 0 0 1px color-mix(in oklch, white 22%, transparent)",
          }}
        />
      ))}
    </span>
  );
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
  browserTabId,
  x,
  y,
  onOpenInSplit,
  otherGroups,
  grouped,
  onNewGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onDismiss,
}: {
  path: string | null;
  // A browser tab's id, the one agents pass as tabId.
  browserTabId: string | null;
  x: number;
  y: number;
  onOpenInSplit?: () => void;
  // The strip's groups other than this tab's own.
  otherGroups: TabGroup[];
  grouped: boolean;
  onNewGroup: () => void;
  onAddToGroup: (groupId: string) => void;
  onRemoveFromGroup: () => void;
  onDismiss: () => void;
}) {
  const width = 220;
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
      {onOpenInSplit && (
        <PickerItem
          label="Open in split"
          hint="dock"
          onClick={() => {
            onDismiss();
            onOpenInSplit();
          }}
        />
      )}
      {path && (
        <PickerItem
          label="Reveal in OS"
          onClick={() => {
            onDismiss();
            void window.spark.fs.revealInOS(path).catch(() => {});
          }}
        />
      )}
      {browserTabId && (
        <PickerItem
          label="Copy tab id"
          hint={browserTabId}
          onClick={() => {
            onDismiss();
            void window.spark.clipboard.writeText(browserTabId).catch(() => {});
          }}
        />
      )}
      {path && (
        <PickerItem
          label="Copy Path"
          onClick={() => {
            onDismiss();
            void navigator.clipboard.writeText(path).catch(() => {});
          }}
        />
      )}
      <PickerItem
        label="Add to new group"
        onClick={() => {
          onDismiss();
          onNewGroup();
        }}
      />
      {otherGroups.map((group) => (
        <PickerItem
          key={group.id}
          label={`Add to ${group.name ? `"${group.name}"` : "unnamed group"}`}
          swatch={group.color}
          onClick={() => {
            onDismiss();
            onAddToGroup(group.id);
          }}
        />
      ))}
      {grouped && (
        <PickerItem
          label="Remove from group"
          onClick={() => {
            onDismiss();
            onRemoveFromGroup();
          }}
        />
      )}
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
        color: "var(--accent-text)",
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalPane, type TerminalPaneHandle } from "../components/Terminal/TerminalPane";
import type { ShellInfo } from "@shared/types";
import type { SparkOpenInput } from "../components/Terminal/useTerminalSession";
import {
  findLeaf,
  insertLeafAtLeaf,
  removeLeaf,
  smartAddTarget,
  type PanePath,
} from "./paneTree";
import type {
  PaneNode,
  Tab,
  TabId,
  TerminalLeaf,
  TerminalLeafWorker,
  TerminalSplit,
  TerminalTab,
} from "./types";
import { CloseIcon, DragHandleIcon, PlusIcon, SplitDownIcon, SplitRightIcon } from "../components/icons";
import {
  TERMINAL_PANE_DRAG_MIME,
  beginTerminalPaneDrag,
  endTerminalPaneDrag,
  parseTerminalPaneDrag,
  peekTerminalPaneDrag,
  peekTerminalPaneDragState,
  subscribeTerminalPaneDrag,
  updateTerminalPaneDragPosition,
  type TerminalPaneDragPoint,
  type TerminalPaneDragPayload,
  type TerminalPaneDragState,
} from "./terminalDrag";
import {
  CLAUDE_LAUNCH_COMMAND,
  CODEX_LAUNCH_COMMAND,
  CURSOR_LAUNCH_COMMAND,
} from "../workers/launch-commands";

// TerminalStack hosts every terminal tab in the workspace. Each tab carries a
// recursive PaneNode tree — leaves are PTY-backed panes, splits are
// horizontal/vertical pairs separated by a draggable handle.
//
// Panes must outlive both tab switches AND tree restructures (split / close),
// otherwise an xterm instance — and the PTY behind it — gets destroyed and
// respawned as a blank shell. Tab switches are handled by keeping every tab
// mounted (visibility:hidden). Tree restructures are handled by rendering the
// tree FLAT: layoutPanes turns it into an absolutely-positioned list of
// leaves keyed by paneId, so a split or close just adds/removes one key and
// every pane that stayed put keeps its scrollback. A recursive render can't
// do this — it changes the React component *type* at a tree position
// whenever a leaf becomes a split, which unmounts the pane.
//
// `onDetectedUrl` carries (tabId, paneId, url) so App.tsx can suppress repeat
// preview-tab spawns per pane (a chatty dev server shouldn't open ten
// previews if the user happens to scroll its log).

interface Props {
  tabs: Tab[];
  activeId: TabId | null;
  shell: ShellInfo | null;
  onDetectedUrl: (tabId: TabId, paneId: string, url: string) => void;
  onSparkOpen: (input: SparkOpenInput) => void;
  onPaneExit: (tabId: TabId, paneId: string, info: { exitCode: number; signal?: number }) => void;
  onActivatePane: (tabId: TabId, paneId: string) => void;
  onSplitRatioChange: (tabId: TabId, path: PanePath, ratio: number) => void;
  onSplitPane: (
    tabId: TabId,
    paneId: string,
    direction: TerminalSplit["direction"],
    autorun?: string,
  ) => void;
  onMovePane: (
    payload: TerminalPaneDragPayload,
    targetTabId: TabId,
    target: {
      paneId: string;
      direction: TerminalSplit["direction"];
      position: "before" | "after";
      mode: "split" | "line";
    },
  ) => void;
  onClosePane: (tabId: TabId, paneId: string) => void;
  onPaneCwd: (tabId: TabId, paneId: string, cwd: string) => void;
  onPaneActivity: (tabId: TabId, paneId: string) => void;
  onPaneScrollback: (tabId: TabId, paneId: string, scrollback: string) => void;
  onPaneAgentState: (
    tabId: TabId,
    paneId: string,
    state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean },
  ) => void;
}

// Per-pane bundle of stable callbacks. Cached per `tabId:paneId` so a
// TerminalPane never sees a fresh callback identity (which would make it
// destroy + respawn its xterm + PTY). Hoisted to module scope so the
// extracted TerminalTabPane child below can reference the type.
type Bundle = {
  onDetectedUrl: (url: string) => void;
  onSparkOpen: (input: SparkOpenInput) => void;
  onExit: (info: { exitCode: number; signal?: number }) => void;
  onActivate: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onSmartAdd: (autorun?: string) => void;
  onClose: () => void;
  onCwd: (cwd: string) => void;
  onActivity: () => void;
  onAgentState: (state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean }) => void;
};

// React.memo: with the useTabs API object now memoized, TerminalStack's
// props only change when the tab list / active id / callbacks genuinely
// change, so an unrelated App re-render no longer walks the whole terminal
// stack and re-runs layoutPanes for every tab.
function TerminalStack({
  tabs,
  activeId,
  shell,
  onDetectedUrl,
  onSparkOpen,
  onPaneExit,
  onActivatePane,
  onSplitRatioChange,
  onSplitPane,
  onMovePane,
  onClosePane,
  onPaneCwd,
  onPaneActivity,
  onPaneScrollback,
  onPaneAgentState,
}: Props) {
  // Memoize the filtered list so it keeps a stable identity when an
  // unrelated tab kind mutates, and so the bundle-GC effect (keyed on
  // `terminals`) only fires when the terminal set actually changes.
  const terminals = useMemo(
    () => tabs.filter((t): t is TerminalTab => t.kind === "terminal"),
    [tabs],
  );

  // Latest-callback refs so the per-pane closures stay stable across renders;
  // TerminalPane re-creates the xterm instance whenever its prop identities
  // change, so we hand it a stable bundle keyed by paneId.
  const detectedRef = useRef(onDetectedUrl);
  const sparkOpenRef = useRef(onSparkOpen);
  const exitRef = useRef(onPaneExit);
  const activateRef = useRef(onActivatePane);
  const ratioRef = useRef(onSplitRatioChange);
  const splitRef = useRef(onSplitPane);
  const moveRef = useRef(onMovePane);
  const closeRef = useRef(onClosePane);
  const cwdRef = useRef(onPaneCwd);
  const activityRef = useRef(onPaneActivity);
  const scrollbackRef = useRef(onPaneScrollback);
  const agentStateRef = useRef(onPaneAgentState);
  useEffect(() => {
    detectedRef.current = onDetectedUrl;
    sparkOpenRef.current = onSparkOpen;
    exitRef.current = onPaneExit;
    activateRef.current = onActivatePane;
    ratioRef.current = onSplitRatioChange;
    splitRef.current = onSplitPane;
    moveRef.current = onMovePane;
    closeRef.current = onClosePane;
    cwdRef.current = onPaneCwd;
    activityRef.current = onPaneActivity;
    scrollbackRef.current = onPaneScrollback;
    agentStateRef.current = onPaneAgentState;
  }, [onDetectedUrl, onSparkOpen, onPaneExit, onActivatePane, onSplitRatioChange, onSplitPane, onMovePane, onClosePane, onPaneCwd, onPaneActivity, onPaneScrollback, onPaneAgentState]);

  // Latest tab roots so the + smart-add button can read whichever PaneNode
  // tree is current at click time (a stale capture would split a tree that
  // no longer matches what the user sees).
  const tabsRef = useRef<TerminalTab[]>([]);
  useEffect(() => {
    tabsRef.current = terminals;
  }, [terminals]);

  // Map of tab id → its rendered root <div>, used to measure actual width
  // and height when deciding which leaf to smart-split. Without measurements
  // we'd have to assume an aspect ratio (the inner widthFrac/heightFrac are
  // unitless), and a wide-screen workspace would always pick the wrong axis.
  const tabRootsRef = useRef(new Map<TabId, HTMLDivElement | null>());
  // useCallback so the per-tab `ref` callback identity is stable — a fresh
  // identity would make React detach + re-run the ref on every render.
  const setTabRoot = useCallback((id: TabId, el: HTMLDivElement | null) => {
    if (el) tabRootsRef.current.set(id, el);
    else tabRootsRef.current.delete(id);
  }, []);

  // useCallback (reads only refs, so empty deps): the per-pane bundles
  // close over this, and the memoized TerminalTabPane below takes it as a
  // prop — both need it to be referentially stable.
  const smartAddInTab = useCallback((tabId: TabId, autorun?: string): void => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab) return;
    const el = tabRootsRef.current.get(tabId);
    const rect = el?.getBoundingClientRect();
    // Sensible fallback for the rare case where the ref hasn't attached yet
    // (immediately after mount); default to a 16:9 box so direction picking
    // still leans toward horizontal splits on wide workspaces.
    const W = rect && rect.width > 0 ? rect.width : 1600;
    const H = rect && rect.height > 0 ? rect.height : 900;
    const target = smartAddTarget(tab.root, W, H);
    if (!target) return;
    splitRef.current(tabId, target.paneId, target.direction, autorun);
  }, []);

  const handlesRef = useRef<Map<string, TerminalPaneHandle | null>>(new Map());
  const lastScrollbackSnapshotRef = useRef<Map<string, number>>(new Map());
  const snapshotScrollback = useCallback((tabId: TabId, paneId: string) => {
    const buffer = handlesRef.current.get(paneId)?.getBuffer(500);
    if (buffer && buffer.trim().length > 0) {
      scrollbackRef.current(tabId, paneId, buffer);
    }
  }, []);

  const bundles = useRef(new Map<string, Bundle>());
  // useCallback so the memoized TerminalTabPane gets a stable `getBundle`
  // prop. The bundles themselves are already cached per `tabId:paneId` and
  // route through latest-callback refs, so they never need to change.
  const getBundle = useCallback(
    (tabId: TabId, paneId: string): Bundle => {
      const key = `${tabId}:${paneId}`;
      let b = bundles.current.get(key);
      if (!b) {
        b = {
          onDetectedUrl: (url: string) => detectedRef.current(tabId, paneId, url),
          onSparkOpen: (input: SparkOpenInput) => sparkOpenRef.current(input),
          onExit: (info) => exitRef.current(tabId, paneId, info),
          onActivate: () => activateRef.current(tabId, paneId),
          onSplitRight: () => splitRef.current(tabId, paneId, "horizontal"),
          onSplitDown: () => splitRef.current(tabId, paneId, "vertical"),
          onSmartAdd: (autorun?: string) => smartAddInTab(tabId, autorun),
          onClose: () => closeRef.current(tabId, paneId),
          onCwd: (cwd: string) => cwdRef.current(tabId, paneId, cwd),
          onActivity: () => {
            activityRef.current(tabId, paneId);
            const now = Date.now();
            const last = lastScrollbackSnapshotRef.current.get(paneId) ?? 0;
            if (now - last >= 2_000) {
              lastScrollbackSnapshotRef.current.set(paneId, now);
              snapshotScrollback(tabId, paneId);
            }
          },
          onAgentState: (state) => agentStateRef.current(tabId, paneId, state),
        };
        bundles.current.set(key, b);
      }
      return b;
    },
    [smartAddInTab, snapshotScrollback],
  );

  // Garbage-collect bundles for panes that no longer exist anywhere.
  useEffect(() => {
    const live = new Set<string>();
    for (const t of terminals) {
      forEachLeaf(t.root, (l) => live.add(`${t.id}:${l.paneId}`));
    }
    for (const key of bundles.current.keys()) {
      if (!live.has(key)) bundles.current.delete(key);
    }
  }, [terminals]);

  // useCallback so the per-pane `ref` callback identity is stable across
  // renders (and so the memoized TerminalTabPane gets a stable prop).
  const setHandle = useCallback((paneId: string, h: TerminalPaneHandle | null) => {
    if (h) handlesRef.current.set(paneId, h);
    else handlesRef.current.delete(paneId);
  }, []);

  useEffect(() => {
    const flushAllScrollback = () => {
      for (const t of tabsRef.current) {
        forEachLeaf(t.root, (leaf) => snapshotScrollback(t.id, leaf.paneId));
      }
    };
    window.addEventListener("pagehide", flushAllScrollback);
    window.addEventListener("beforeunload", flushAllScrollback);
    return () => {
      flushAllScrollback();
      window.removeEventListener("pagehide", flushAllScrollback);
      window.removeEventListener("beforeunload", flushAllScrollback);
    };
  }, [snapshotScrollback]);

  // Stable split-ratio callback (routes through the latest-callback ref) so
  // TerminalTabPane can be memoized — it builds its own per-handle closures
  // from this without TerminalStack handing down a fresh function each
  // render. Reading container geometry stays the child's job.
  const onPaneRatioChange = useCallback(
    (tabId: TabId, path: PanePath, ratio: number) => {
      ratioRef.current(tabId, path, ratio);
    },
    [],
  );

  const onPaneDrop = useCallback(
    (
      payload: TerminalPaneDragPayload,
      targetTabId: TabId,
      target: {
        paneId: string;
        direction: TerminalSplit["direction"];
        position: "before" | "after";
        mode: "split" | "line";
      },
    ) => {
      moveRef.current(payload, targetTabId, target);
    },
    [],
  );

  // Stable container lookup for ResizeHandle drags — reads the live tab root
  // out of the ref map at drag time so a mid-drag re-render can't stale it.
  const getTabRoot = useCallback(
    (tabId: TabId): HTMLDivElement | null => tabRootsRef.current.get(tabId) ?? null,
    [],
  );

  useEffect(() => {
    const updatePosition = (event: DragEvent) => {
      if (!peekTerminalPaneDrag()) return;
      updateTerminalDragPositionFromPoint(event);
    };
    const finishTerminalDrag = () => {
      if (!peekTerminalPaneDrag()) return;
      window.setTimeout(() => endTerminalPaneDrag(), 0);
    };

    window.addEventListener("drag", updatePosition);
    window.addEventListener("dragover", updatePosition);
    window.addEventListener("drop", finishTerminalDrag);
    window.addEventListener("dragend", finishTerminalDrag);
    return () => {
      window.removeEventListener("drag", updatePosition);
      window.removeEventListener("dragover", updatePosition);
      window.removeEventListener("drop", finishTerminalDrag);
      window.removeEventListener("dragend", finishTerminalDrag);
    };
  }, []);

  if (terminals.length === 0) return null;
  if (!shell) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--muted)",
          fontSize: 12,
        }}
      >
        No shell detected.
      </div>
    );
  }

  return (
    // pointer-events:none on the outer so this stack's empty space doesn't
    // absorb clicks meant for whichever stack is paint-order below it. The
    // active inner wrapper re-enables pointer-events:auto for its own panes.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {terminals.map((t) => (
        // Each tab is its own memoized child: when one tab's pane tree
        // mutates (split / close / ratio drag) only that TerminalTabPane
        // re-renders, leaving sibling tabs — and crucially their layoutPanes
        // tree-walks — untouched. All callback/ref props handed in here are
        // referentially stable, which is what makes the React.memo bite.
        <TerminalTabPane
          key={t.id}
          tab={t}
          visible={t.id === activeId}
          shell={shell}
          getBundle={getBundle}
          setTabRoot={setTabRoot}
          setHandle={setHandle}
          getTabRoot={getTabRoot}
          onRatioChange={onPaneRatioChange}
          onPaneDrop={onPaneDrop}
        />
      ))}
    </div>
  );
}

export default React.memo(TerminalStack);

interface TerminalTabPaneProps {
  tab: TerminalTab;
  visible: boolean;
  shell: ShellInfo;
  getBundle: (tabId: TabId, paneId: string) => Bundle;
  setTabRoot: (id: TabId, el: HTMLDivElement | null) => void;
  setHandle: (paneId: string, h: TerminalPaneHandle | null) => void;
  getTabRoot: (tabId: TabId) => HTMLDivElement | null;
  onRatioChange: (tabId: TabId, path: PanePath, ratio: number) => void;
  onPaneDrop: (
    payload: TerminalPaneDragPayload,
    targetTabId: TabId,
    target: {
      paneId: string;
      direction: TerminalSplit["direction"];
      position: "before" | "after";
      mode: "split" | "line";
    },
  ) => void;
}

// One terminal tab's flattened pane area. Extracted from TerminalStack and
// wrapped in React.memo so a change to tab A's pane tree doesn't re-render
// tabs B/C/D (and doesn't re-run their layoutPanes walks). Every prop is
// referentially stable except `tab` and `visible`, so the memo only lets a
// render through when this specific tab actually changed.
const TerminalTabPane = React.memo(function TerminalTabPane({
  tab,
  visible,
  shell,
  getBundle,
  setTabRoot,
  setHandle,
  getTabRoot,
  onRatioChange,
  onPaneDrop,
}: TerminalTabPaneProps) {
  const tabRootRef = useRef<HTMLDivElement | null>(null);
  const [dropIntent, setDropIntent] = useState<DropIntent | null>(null);
  const dropIntentRef = useRef<DropIntent | null>(null);
  const [dragState, setDragState] = useState<TerminalPaneDragState | null>(() =>
    peekTerminalPaneDragState(),
  );
  const drag = dragState?.payload ?? null;
  const ghostPos = dragState ? dragGhostPosition(dragState) : null;

  useEffect(() => subscribeTerminalPaneDrag(setDragState), []);

  const setOwnTabRoot = useCallback(
    (el: HTMLDivElement | null) => {
      tabRootRef.current = el;
      setTabRoot(tab.id, el);
    },
    [setTabRoot, tab.id],
  );

  // The rendered base omits the dragged pane, but hit-testing uses the
  // original geometry so a same-tab drag still targets the row/cell the user
  // is pointing at instead of a sibling that expanded into the empty space.
  const layoutRoot = useMemo((): PaneNode | null => {
    if (!drag || drag.tabId !== tab.id) return tab.root;
    return removeLeaf(tab.root, drag.paneId);
  }, [tab.root, tab.id, drag]);

  const baseLayout = useMemo(() => layoutTree(tab.root), [tab.root]);

  const updateDropIntentAtPoint = useCallback(
    (pointLike: { clientX: number; clientY: number }): DropIntent | null => {
      const root = tabRootRef.current;
      const dragPayload = peekTerminalPaneDrag();
      const point = terminalDragPointFromClient(pointLike);
      if (!root || !dragPayload || !point) {
        dropIntentRef.current = null;
        setDropIntent(null);
        return null;
      }
      const next = dropIntentFromBaseLayout(
        root.getBoundingClientRect(),
        baseLayout.leaves,
        point,
        dragPayload,
        tab.id,
      );
      if (!next) {
        dropIntentRef.current = null;
        setDropIntent(null);
        return null;
      }
      dropIntentRef.current = next;
      setDropIntent((current) => {
        if (sameDropIntent(current, next)) return current;
        return next;
      });
      return next;
    },
    [baseLayout.leaves, tab.id],
  );

  useEffect(() => {
    if (!dragState || !visible) return;
    updateDropIntentAtPoint(dragState);
  }, [dragState, visible, updateDropIntentAtPoint]);

  useEffect(() => {
    if (!dragState || !visible) return;

    const onPointerMove = (event: PointerEvent) => {
      updateTerminalDragPositionFromPoint(event);
      updateDropIntentAtPoint(event);
    };
    const finish = (event: PointerEvent) => {
      updateTerminalDragPositionFromPoint(event);
      const intent = updateDropIntentAtPoint(event);
      const payload = peekTerminalPaneDrag();
      if (payload && intent) {
        onPaneDrop(payload, tab.id, intent);
      }
      setDropIntent(null);
      endTerminalPaneDrag();
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", finish, true);
    };
  }, [dragState, visible, updateDropIntentAtPoint, onPaneDrop, tab.id]);

  useEffect(() => {
    if (!dragState) {
      dropIntentRef.current = null;
      setDropIntent(null);
    }
  }, [dragState]);

  useEffect(() => {
    dropIntentRef.current = dropIntent;
  }, [dropIntent]);

  // Full post-drop tree when hovering a drop target — drives live reflow + slot.
  const dropPreviewRoot = useMemo(() => {
    if (!drag || !dropIntent) return null;
    const moving =
      findLeaf(tab.root, drag.paneId) ??
      ({ kind: "leaf", paneId: drag.paneId } satisfies TerminalLeaf);
    const base = drag.tabId === tab.id ? layoutRoot : tab.root;
    if (!base) return null;
    const next = insertLeafAtLeaf(
      base,
      dropIntent.paneId,
      dropIntent.direction,
      moving,
      dropIntent.position,
      { rebalanceLine: dropIntent.mode === "line" },
    );
    return next === base ? null : next;
  }, [drag, dropIntent, tab.root, tab.id, layoutRoot]);

  const displayRoot = dropPreviewRoot ?? layoutRoot;

  const { flowLeaves, flowHandles, dropSlotRect } = useMemo(() => {
    const ls: LeafBox[] = [];
    const hs: HandleBox[] = [];
    if (!displayRoot) {
      return { flowLeaves: ls, flowHandles: hs, dropSlotRect: null };
    }
    layoutPanes(displayRoot, [], FULL_RECT, ls, hs);
    const slot =
      drag && dropPreviewRoot
        ? (ls.find((box) => box.leaf.paneId === drag.paneId)?.rect ?? null)
        : null;
    return { flowLeaves: ls, flowHandles: hs, dropSlotRect: slot };
  }, [displayRoot, drag, dropPreviewRoot]);

  const resizeIntersections = useMemo(
    () => buildResizeIntersections(flowHandles),
    [flowHandles],
  );

  const hideDraggedPane = !!drag && (drag.tabId === tab.id || !!dropPreviewRoot);
  const layoutAnimating = !!drag && (drag.tabId === tab.id || !!dropPreviewRoot);

  const orderedFlowLeaves = useMemo(() => {
    const activeId = tab.activePaneId;
    return [...flowLeaves]
      .filter((box) => !(hideDraggedPane && drag && box.leaf.paneId === drag.paneId))
      .sort((a, b) => {
        if (a.leaf.paneId === activeId) return 1;
        if (b.leaf.paneId === activeId) return -1;
        return 0;
      });
  }, [flowLeaves, tab.activePaneId, hideDraggedPane, drag]);

  const draggedLeaf =
    drag?.tabId === tab.id ? findLeaf(tab.root, drag.paneId) : null;

  return (
    <div
      ref={setOwnTabRoot}
      aria-hidden={!visible}
      className="spark-terminal-tab"
      onDragOver={(event) => {
        if (!acceptsTerminalPane(event)) return;
        event.preventDefault();
        updateTerminalDragPositionFromPoint(event);
      }}
      onDragLeave={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        ) {
          return;
        }
        setDropIntent(null);
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: visible ? 2 : 1,
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
        boxSizing: "border-box",
        padding: "var(--terminal-pane-pad)",
        background: "var(--panel)",
      }}
    >
      {orderedFlowLeaves.map(({ leaf, rect }) => {
        const bundle = getBundle(tab.id, leaf.paneId);
        const isActive = tab.activePaneId === leaf.paneId;
        const workerChip = visibleWorkerChip(leaf.worker);
        return (
          <div
            key={leaf.paneId}
            data-terminal-pane-id={leaf.paneId}
            onMouseDown={bundle.onActivate}
            onDragEnter={(event) => {
              if (!acceptsTerminalPane(event)) return;
              event.preventDefault();
              event.stopPropagation();
              updateTerminalDragPositionFromPoint(event);
              if (isSelfDrop(tab.id, leaf.paneId)) {
                event.dataTransfer.dropEffect = "none";
                setDropIntent((current) =>
                  current?.paneId === leaf.paneId ? null : current,
                );
                return;
              }
              setDropIntent(dropIntentFromEvent(event, leaf.paneId));
            }}
            onDragOver={(event) => {
              if (!acceptsTerminalPane(event)) return;
              event.preventDefault();
              event.stopPropagation();
              updateTerminalDragPositionFromPoint(event);
              if (isSelfDrop(tab.id, leaf.paneId)) {
                event.dataTransfer.dropEffect = "none";
                setDropIntent((current) =>
                  current?.paneId === leaf.paneId ? null : current,
                );
                return;
              }
              event.dataTransfer.dropEffect = "move";
              setDropIntent(dropIntentFromEvent(event, leaf.paneId));
            }}
            onDragLeave={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ) {
                return;
              }
              setDropIntent((current) =>
                current?.paneId === leaf.paneId ? null : current,
              );
            }}
            onDrop={(event) => {
              const payload = parseTerminalPaneDrag(event.dataTransfer);
              if (!payload) return;
              event.preventDefault();
              event.stopPropagation();
              setDropIntent(null);
              endTerminalPaneDrag();
              // Dropping a pane onto itself is a no-op — short-circuit so the
              // move handler doesn't try to remove + reinsert the same leaf.
              if (payload.tabId === tab.id && payload.paneId === leaf.paneId) {
                return;
              }
              const intent = dropIntentFromEvent(event, leaf.paneId);
              onPaneDrop(payload, tab.id, intent);
            }}
            className="spark-terminal-pane"
            style={{
              position: "absolute",
              ...paneFrameStyle(rect),
              zIndex: isActive ? 5 : 1,
              opacity: layoutAnimating && drag?.paneId !== leaf.paneId ? 0.94 : 1,
              transition: layoutAnimating
                ? "left var(--motion) var(--ease-out), top var(--motion) var(--ease-out), width var(--motion) var(--ease-out), height var(--motion) var(--ease-out), opacity var(--motion-fast) var(--ease-out)"
                : undefined,
            }}
          >
            {isActive ? <PaneFocusRing /> : null}
            <TerminalPane
              ref={(h) => setHandle(leaf.paneId, h)}
              sessionId={leaf.paneId}
              shell={shell}
              initialCwd={leaf.cwd}
              initialScrollback={leaf.scrollback}
              initialCommand={leaf.autorun}
              visible={visible}
              onDetectedLocalUrl={bundle.onDetectedUrl}
              onSparkOpen={bundle.onSparkOpen}
              onExit={bundle.onExit}
              onCwd={bundle.onCwd}
              onActivity={bundle.onActivity}
              onAgentState={bundle.onAgentState}
            />
            {workerChip ? <WorkerChip worker={workerChip} /> : null}
            <PaneToolbar
              dragPayload={{ tabId: tab.id, paneId: leaf.paneId }}
              onSmartAdd={bundle.onSmartAdd}
              onSplitRight={bundle.onSplitRight}
              onSplitDown={bundle.onSplitDown}
              onClose={bundle.onClose}
            />
          </div>
        );
      })}
      {draggedLeaf && drag ? (
        <DraggedPaneMount
          tabId={tab.id}
          leaf={draggedLeaf}
          shell={shell}
          getBundle={getBundle}
          setHandle={setHandle}
        />
      ) : null}
      {dropSlotRect ? <PaneDropSlot rect={dropSlotRect} /> : null}
      {drag && ghostPos && visible ? (
        <TerminalDragGhost x={ghostPos.x} y={ghostPos.y} />
      ) : null}
      {flowHandles.map((handle) => (
        <ResizeHandle
          key={`h:${handle.path.join("/") || "root"}`}
          handle={handle}
          getContainer={() => getTabRoot(tab.id)}
          onRatioChange={(ratio) => onRatioChange(tab.id, handle.path, ratio)}
        />
      ))}
      {resizeIntersections.map((intersection) => (
        <ResizeIntersectionGrip
          key={intersection.key}
          intersection={intersection}
          getContainer={() => getTabRoot(tab.id)}
          onRatioChange={(path, ratio) => onRatioChange(tab.id, path, ratio)}
        />
      ))}
    </div>
  );
});

// A rectangle inside a tab's pane area, expressed as fractions (0..1) so the
// layout is resolution-independent and maps directly onto CSS percentages.
interface FracRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const FULL_RECT: FracRect = { left: 0, top: 0, width: 1, height: 1 };

interface LeafBox {
  leaf: TerminalLeaf;
  rect: FracRect;
}

interface HandleBox {
  // Path from the tab root to the split node this handle resizes — exactly
  // what setRatioAtPath expects ([] addresses the root split).
  path: PanePath;
  direction: TerminalSplit["direction"];
  ratio: number;
  // The split node's own rect. Kept so a drag can convert a pointer position
  // into a ratio relative to the split, not the whole tab.
  rect: FracRect;
}

interface ResizeIntersection {
  key: string;
  x: number;
  y: number;
  xHandles: HandleBox[];
  yHandles: HandleBox[];
}

interface DropIntent {
  paneId: string;
  direction: TerminalSplit["direction"];
  position: "before" | "after";
  mode: "split" | "line";
}

// Invisible at rest; a soft groove appears on hover, accent while dragging.
const HANDLE_HIT = 11;
const INTERSECTION_GRIP = 14;
const PANE_GAP_PX = 3;
const LINE_DROP_EDGE_PX = 12;
const RESIZE_SNAP_STEP = 1 / 24;
const RESIZE_SNAP_PX = 8;
const RESIZE_SNAP_RATIOS = [
  1 / 6,
  1 / 5,
  1 / 4,
  1 / 3,
  2 / 5,
  1 / 2,
  3 / 5,
  2 / 3,
  3 / 4,
  4 / 5,
  5 / 6,
];
const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

function pct(fraction: number): string {
  return `${fraction * 100}%`;
}

function terminalDragPointFromClient(pointLike: {
  clientX: number;
  clientY: number;
}): TerminalPaneDragPoint | null {
  const { clientX, clientY } = pointLike;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  // Chromium can report 0,0 on synthetic drag ticks while the pointer is
  // elsewhere. Ignoring that keeps the pickup card from snapping to the corner.
  if (clientX === 0 && clientY === 0) return null;
  return { clientX, clientY };
}

function updateTerminalDragPositionFromPoint(pointLike: {
  clientX: number;
  clientY: number;
}): void {
  const point = terminalDragPointFromClient(pointLike);
  if (!point) return;
  updateTerminalPaneDragPosition(point);
}

function dragGhostPosition(
  state: TerminalPaneDragState,
): { x: number; y: number } | null {
  const point = terminalDragPointFromClient(state);
  if (!point) return null;
  return { x: point.clientX, y: point.clientY };
}

function layoutTree(root: PaneNode | null): { leaves: LeafBox[]; handles: HandleBox[] } {
  const leaves: LeafBox[] = [];
  const handles: HandleBox[] = [];
  if (root) layoutPanes(root, [], FULL_RECT, leaves, handles);
  return { leaves, handles };
}

function buildResizeIntersections(handles: HandleBox[]): ResizeIntersection[] {
  const verticalLines = handles.filter((handle) => handle.direction === "horizontal");
  const horizontalLines = handles.filter((handle) => handle.direction === "vertical");
  const groups = new Map<string, ResizeIntersection>();
  for (const horizontalHandle of verticalLines) {
    const x = handleBoundary(horizontalHandle);
    const yStart = horizontalHandle.rect.top;
    const yEnd = horizontalHandle.rect.top + horizontalHandle.rect.height;
    for (const verticalHandle of horizontalLines) {
      const y = handleBoundary(verticalHandle);
      const xStart = verticalHandle.rect.left;
      const xEnd = verticalHandle.rect.left + verticalHandle.rect.width;
      if (
        x >= xStart - 0.001 &&
        x <= xEnd + 0.001 &&
        y >= yStart - 0.001 &&
        y <= yEnd + 0.001
      ) {
        const key = `${coordinateKey(x)}:${coordinateKey(y)}`;
        let intersection = groups.get(key);
        if (!intersection) {
          intersection = { key, x, y, xHandles: [], yHandles: [] };
          groups.set(key, intersection);
        }
        addUniqueHandle(intersection.xHandles, horizontalHandle);
        addUniqueHandle(intersection.yHandles, verticalHandle);
      }
    }
  }
  return [...groups.values()].map((intersection) => ({
    ...intersection,
    key: intersectionKey(intersection),
  }));
}

function handleBoundary(handle: HandleBox): number {
  return handle.direction === "horizontal"
    ? handle.rect.left + handle.rect.width * handle.ratio
    : handle.rect.top + handle.rect.height * handle.ratio;
}

function coordinateKey(value: number): string {
  return String(Math.round(value * 10000));
}

function addUniqueHandle(handles: HandleBox[], handle: HandleBox): void {
  const key = handlePathKey(handle);
  if (!handles.some((item) => handlePathKey(item) === key)) {
    handles.push(handle);
  }
}

function intersectionKey(intersection: Pick<ResizeIntersection, "xHandles" | "yHandles">): string {
  const xKeys = intersection.xHandles.map(handlePathKey).sort().join(",");
  const yKeys = intersection.yHandles.map(handlePathKey).sort().join(",");
  return `x:${xKeys}|y:${yKeys}`;
}

function handlePathKey(handle: HandleBox): string {
  return handle.path.join("/") || "root";
}

// Inset each pane slightly so rounded cards breathe (macOS split style).
function paneFrameStyle(rect: FracRect): React.CSSProperties {
  const g = PANE_GAP_PX;
  return {
    left: `calc(${pct(rect.left)} + ${g}px)`,
    top: `calc(${pct(rect.top)} + ${g}px)`,
    width: `calc(${pct(rect.width)} - ${g * 2}px)`,
    height: `calc(${pct(rect.height)} - ${g * 2}px)`,
  };
}

function paneFrameClientRect(container: DOMRect, rect: FracRect): DOMRect {
  const gap = PANE_GAP_PX;
  const left = container.left + rect.left * container.width + gap;
  const top = container.top + rect.top * container.height + gap;
  const width = Math.max(0, rect.width * container.width - gap * 2);
  const height = Math.max(0, rect.height * container.height - gap * 2);
  return new DOMRect(left, top, width, height);
}

function leafCellClientRect(container: DOMRect, rect: FracRect): DOMRect {
  return new DOMRect(
    container.left + rect.left * container.width,
    container.top + rect.top * container.height,
    rect.width * container.width,
    rect.height * container.height,
  );
}

function acceptsTerminalPane(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(TERMINAL_PANE_DRAG_MIME);
}

// True when the in-flight drag's source pane is the leaf we're hovering — used
// to suppress the drop preview so a pane dropped onto itself is a clear no-op
// rather than appearing to land in one of its own halves.
function isSelfDrop(tabId: TabId, paneId: string): boolean {
  const active = peekTerminalPaneDrag();
  return !!active && active.tabId === tabId && active.paneId === paneId;
}

function dropIntentFromEvent(
  event: React.DragEvent<HTMLElement>,
  paneId: string,
): DropIntent {
  return dropIntentFromRect(
    event.currentTarget.getBoundingClientRect(),
    event.clientX,
    event.clientY,
    paneId,
  );
}

function dropIntentFromBaseLayout(
  containerRect: DOMRect,
  leaves: LeafBox[],
  point: TerminalPaneDragPoint,
  dragPayload: TerminalPaneDragPayload,
  targetTabId: TabId,
): DropIntent | null {
  if (leaves.length === 0) return null;
  if (!pointInsideRect(point.clientX, point.clientY, containerRect)) return null;

  let best: { box: LeafBox; rect: DOMRect; distance: number; contains: boolean } | null = null;
  for (const box of leaves) {
    if (dragPayload.tabId === targetTabId && dragPayload.paneId === box.leaf.paneId) {
      continue;
    }
    const rect = leafCellClientRect(containerRect, box.rect);
    const contains = pointInsideRect(point.clientX, point.clientY, rect);
    const distance = contains ? -1 : distanceToRectSq(point.clientX, point.clientY, rect);
    if (!best || distance < best.distance) {
      best = { box, rect, distance, contains };
    }
  }
  if (!best) return null;
  const mode =
    best.contains && isNearInsertEdge(best.rect, point.clientX, point.clientY)
      ? "line"
      : "split";
  return dropIntentFromRect(
    best.rect,
    point.clientX,
    point.clientY,
    best.box.leaf.paneId,
    mode,
  );
}

function dropIntentFromRect(
  rect: DOMRect,
  clientX: number,
  clientY: number,
  paneId: string,
  mode: DropIntent["mode"] = "split",
): DropIntent {
  const x = rect.width > 0 ? (clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  const distances = [
    { edge: "left", value: x },
    { edge: "right", value: 1 - x },
    { edge: "top", value: y },
    { edge: "bottom", value: 1 - y },
  ].sort((a, b) => a.value - b.value);
  const edge = distances[0]?.edge ?? "right";
  if (edge === "left") {
    return { paneId, direction: "horizontal", position: "before", mode };
  }
  if (edge === "right") {
    return { paneId, direction: "horizontal", position: "after", mode };
  }
  if (edge === "top") {
    return { paneId, direction: "vertical", position: "before", mode };
  }
  return { paneId, direction: "vertical", position: "after", mode };
}

function sameDropIntent(a: DropIntent | null, b: DropIntent | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.paneId === b.paneId &&
    a.direction === b.direction &&
    a.position === b.position &&
    a.mode === b.mode
  );
}

function pointInsideRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function distanceToRectSq(x: number, y: number, rect: DOMRect): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return dx * dx + dy * dy;
}

function isNearInsertEdge(rect: DOMRect, clientX: number, clientY: number): boolean {
  const edgeDistance = Math.min(
    Math.abs(clientX - rect.left),
    Math.abs(rect.right - clientX),
    Math.abs(clientY - rect.top),
    Math.abs(rect.bottom - clientY),
  );
  return edgeDistance <= LINE_DROP_EDGE_PX;
}

// Accent frame drawn above the xterm canvas. Sits on a raised z-index pane so
// every edge — including splits against a sibling — stays visible.
function PaneFocusRing() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        pointerEvents: "none",
        border: "1px solid var(--accent)",
        borderRadius: "var(--terminal-pane-radius)",
        boxShadow: [
          "0 0 0 1px color-mix(in oklch, var(--accent) 24%, transparent)",
          "inset 0 0 36px color-mix(in oklch, var(--accent) 4%, transparent)",
        ].join(", "),
        transition: "box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    />
  );
}

// Exact footprint the dragged pane will occupy after drop (from preview layout).
function PaneDropSlot({ rect }: { rect: FracRect }) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        ...paneFrameStyle(rect),
        zIndex: 8,
        pointerEvents: "none",
        border: "2px dashed color-mix(in oklch, var(--accent) 58%, transparent)",
        borderRadius: "var(--terminal-pane-radius)",
        background: "color-mix(in oklch, var(--accent) 11%, transparent)",
        boxShadow: [
          "inset 0 0 0 1px color-mix(in oklch, var(--accent) 28%, transparent)",
          "inset 0 0 40px color-mix(in oklch, var(--accent) 7%, transparent)",
          "0 0 24px color-mix(in oklch, var(--accent) 16%, transparent)",
        ].join(", "),
        transition:
          "left var(--motion) var(--ease-out), top var(--motion) var(--ease-out), width var(--motion) var(--ease-out), height var(--motion) var(--ease-out)",
      }}
    />
  );
}

// Keeps the PTY mounted but off-screen while the visible layout omits this pane.
function DraggedPaneMount({
  tabId,
  leaf,
  shell,
  getBundle,
  setHandle,
}: {
  tabId: TabId;
  leaf: TerminalLeaf;
  shell: ShellInfo;
  getBundle: (tabId: TabId, paneId: string) => Bundle;
  setHandle: (paneId: string, h: TerminalPaneHandle | null) => void;
}) {
  const bundle = getBundle(tabId, leaf.paneId);
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: -10000,
        top: 0,
        width: 480,
        height: 320,
        overflow: "hidden",
        opacity: 0,
        pointerEvents: "none",
      }}
    >
      <TerminalPane
        ref={(h) => setHandle(leaf.paneId, h)}
        sessionId={leaf.paneId}
        shell={shell}
        initialCwd={leaf.cwd}
        initialScrollback={leaf.scrollback}
        initialCommand={leaf.autorun}
        visible={false}
        onDetectedLocalUrl={bundle.onDetectedUrl}
        onSparkOpen={bundle.onSparkOpen}
        onExit={bundle.onExit}
        onCwd={bundle.onCwd}
        onActivity={bundle.onActivity}
        onAgentState={bundle.onAgentState}
      />
    </div>
  );
}

function TerminalDragGhost({ x, y }: { x: number; y: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: x + 14,
        top: y + 14,
        width: 168,
        height: 108,
        zIndex: 10000,
        pointerEvents: "none",
        borderRadius: "var(--terminal-pane-radius)",
        border: "1px solid var(--accent)",
        background: "color-mix(in oklch, var(--panel) 88%, var(--accent) 12%)",
        boxShadow: [
          "0 0 0 1px color-mix(in oklch, var(--accent) 22%, transparent)",
          "0 14px 36px rgba(0, 0, 0, 0.38)",
          "0 0 28px color-mix(in oklch, var(--accent) 18%, transparent)",
        ].join(", "),
        transform: "rotate(-1.5deg) scale(1.02)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          background:
            "repeating-linear-gradient(0deg, color-mix(in oklch, var(--ink) 4%, transparent) 0 2px, transparent 2px 18px)",
          opacity: 0.55,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 10,
          bottom: 10,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          letterSpacing: "0.06em",
          color: "var(--accent)",
          fontWeight: 600,
        }}
      >
        &gt; terminal
      </div>
    </div>
  );
}

// Walk the pane tree once, appending a LeafBox for every leaf and a HandleBox
// for every split. `rect` is the area the current node occupies within the
// tab. The flat output is what lets TerminalStack render leaves as siblings
// keyed by paneId — see the file header for why that keeps PTYs alive.
function layoutPanes(
  node: PaneNode,
  path: PanePath,
  rect: FracRect,
  leaves: LeafBox[],
  handles: HandleBox[],
): void {
  if (node.kind === "leaf") {
    leaves.push({ leaf: node, rect });
    return;
  }
  handles.push({ path, direction: node.direction, ratio: node.ratio, rect });
  if (node.direction === "horizontal") {
    const aWidth = rect.width * node.ratio;
    layoutPanes(node.a, [...path, "a"], { ...rect, width: aWidth }, leaves, handles);
    layoutPanes(
      node.b,
      [...path, "b"],
      { ...rect, left: rect.left + aWidth, width: rect.width - aWidth },
      leaves,
      handles,
    );
  } else {
    const aHeight = rect.height * node.ratio;
    layoutPanes(node.a, [...path, "a"], { ...rect, height: aHeight }, leaves, handles);
    layoutPanes(
      node.b,
      [...path, "b"],
      { ...rect, top: rect.top + aHeight, height: rect.height - aHeight },
      leaves,
      handles,
    );
  }
}

interface ResizeHandleProps {
  handle: HandleBox;
  getContainer: () => HTMLDivElement | null;
  onRatioChange: (ratio: number) => void;
}

function ratioForHandle(
  handle: HandleBox,
  container: DOMRect,
  clientX: number,
  clientY: number,
): number | null {
  if (handle.direction === "horizontal") {
    const splitLeft = container.left + handle.rect.left * container.width;
    const splitWidth = handle.rect.width * container.width;
    if (splitWidth <= 0) return null;
    return snapResizeRatio((clientX - splitLeft) / splitWidth, splitWidth);
  }

  const splitTop = container.top + handle.rect.top * container.height;
  const splitHeight = handle.rect.height * container.height;
  if (splitHeight <= 0) return null;
  return snapResizeRatio((clientY - splitTop) / splitHeight, splitHeight);
}

function snapResizeRatio(rawRatio: number, splitPixels: number): number {
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, rawRatio));
  const snapDistance = splitPixels > 0 ? RESIZE_SNAP_PX / splitPixels : 0;
  const snappedMajor = nearestRatio(clamped, RESIZE_SNAP_RATIOS);
  if (Math.abs(clamped - snappedMajor) <= snapDistance) {
    return snappedMajor;
  }
  const gridRatio = Math.round(clamped / RESIZE_SNAP_STEP) * RESIZE_SNAP_STEP;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, gridRatio));
}

function nearestRatio(value: number, ratios: number[]): number {
  let best = ratios[0];
  let bestDistance = Math.abs(value - best);
  for (let i = 1; i < ratios.length; i++) {
    const distance = Math.abs(value - ratios[i]);
    if (distance < bestDistance) {
      best = ratios[i];
      bestDistance = distance;
    }
  }
  return best;
}

// A draggable divider between two panes. Invisible until hover; then a recessed
// groove that works on any theme. Accent only while actively resizing.
function ResizeHandle({ handle, getContainer, onRatioChange }: ResizeHandleProps) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const { rect, ratio } = handle;
  const isHorizontal = handle.direction === "horizontal";
  // Boundary as a fraction of the whole tab, derived from the split's own
  // rect so handles for nested splits land in the right place.
  const boundary = isHorizontal
    ? rect.left + rect.width * ratio
    : rect.top + rect.height * ratio;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    setDragging(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const container = getContainer();
    if (!container) return;
    const cr = container.getBoundingClientRect();
    const next = ratioForHandle(handle, cr, e.clientX, e.clientY);
    if (next !== null) onRatioChange(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const showLine = dragging || hover;
  const cursor = isHorizontal ? "col-resize" : "row-resize";
  const groove = isHorizontal
    ? `linear-gradient(to right,
        transparent 0%,
        color-mix(in oklch, var(--ink) 7%, transparent) 42%,
        color-mix(in oklch, var(--ink) 4%, transparent) 50%,
        color-mix(in oklch, var(--ink) 7%, transparent) 58%,
        transparent 100%)`
    : `linear-gradient(to bottom,
        transparent 0%,
        color-mix(in oklch, var(--ink) 7%, transparent) 42%,
        color-mix(in oklch, var(--ink) 4%, transparent) 50%,
        color-mix(in oklch, var(--ink) 7%, transparent) 58%,
        transparent 100%)`;

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-hidden
      style={{
        position: "absolute",
        zIndex: dragging ? 8 : hover ? 7 : 3,
        touchAction: "none",
        cursor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...(isHorizontal
          ? {
              left: `calc(${pct(boundary)} - ${HANDLE_HIT / 2}px)`,
              top: pct(rect.top),
              width: HANDLE_HIT,
              height: pct(rect.height),
            }
          : {
              top: `calc(${pct(boundary)} - ${HANDLE_HIT / 2}px)`,
              left: pct(rect.left),
              height: HANDLE_HIT,
              width: pct(rect.width),
            }),
      }}
    >
      <div
        style={{
          pointerEvents: "none",
          opacity: showLine ? 1 : 0,
          transition: "opacity var(--motion-fast) var(--ease-out)",
          ...(isHorizontal ? { width: dragging ? 2 : 3, height: "100%" } : { height: dragging ? 2 : 3, width: "100%" }),
          ...(dragging
            ? {
                background: "var(--accent)",
                boxShadow: "0 0 10px var(--accent-glow)",
              }
            : { background: groove }),
        }}
      />
      {dragging ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, cursor }} />
      ) : null}
    </div>
  );
}

interface ResizeIntersectionGripProps {
  intersection: ResizeIntersection;
  getContainer: () => HTMLDivElement | null;
  onRatioChange: (path: PanePath, ratio: number) => void;
}

function ResizeIntersectionGrip({
  intersection,
  getContainer,
  onRatioChange,
}: ResizeIntersectionGripProps) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);

  const updateBoth = (clientX: number, clientY: number) => {
    const container = getContainer();
    if (!container) return;
    const cr = container.getBoundingClientRect();
    for (const handle of intersection.xHandles) {
      const ratio = ratioForHandle(handle, cr, clientX, clientY);
      if (ratio !== null) onRatioChange(handle.path, ratio);
    }
    for (const handle of intersection.yHandles) {
      const ratio = ratioForHandle(handle, cr, clientX, clientY);
      if (ratio !== null) onRatioChange(handle.path, ratio);
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    setDragging(true);
    updateBoth(e.clientX, e.clientY);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    updateBoth(e.clientX, e.clientY);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    setDragging(false);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const active = dragging || hover;
  const dotColor = active ? "var(--accent)" : "var(--muted)";

  return (
    <div
      aria-hidden
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "absolute",
        zIndex: dragging ? 11 : hover ? 10 : 5,
        left: `calc(${pct(intersection.x)} - ${INTERSECTION_GRIP / 2}px)`,
        top: `calc(${pct(intersection.y)} - ${INTERSECTION_GRIP / 2}px)`,
        width: INTERSECTION_GRIP,
        height: INTERSECTION_GRIP,
        borderRadius: 4,
        touchAction: "none",
        cursor: dragging ? "grabbing" : "grab",
        display: "grid",
        gridTemplateColumns: "repeat(2, 3px)",
        gridTemplateRows: "repeat(2, 3px)",
        gap: 2,
        alignContent: "center",
        justifyContent: "center",
        background: active
          ? "color-mix(in oklch, var(--accent) 16%, var(--panel))"
          : "color-mix(in oklch, var(--panel) 82%, transparent)",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 58%, transparent)"
          : "1px solid color-mix(in oklch, var(--rule-strong) 74%, transparent)",
        boxShadow: dragging ? "0 0 12px var(--accent-glow)" : "none",
        opacity: active ? 1 : 0.58,
        transition:
          "opacity var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          style={{
            width: 3,
            height: 3,
            borderRadius: 999,
            background: dotColor,
            pointerEvents: "none",
          }}
        />
      ))}
      {dragging ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, cursor: "grabbing" }} />
      ) : null}
    </div>
  );
}

interface PaneToolbarProps {
  dragPayload: TerminalPaneDragPayload;
  onSmartAdd: (autorun?: string) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClose: () => void;
}

function PaneToolbar({ dragPayload, onSmartAdd, onSplitRight, onSplitDown, onClose }: PaneToolbarProps) {
  const stop = (e: React.MouseEvent | React.PointerEvent) => e.stopPropagation();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);

  // Close on outside click / Escape, matching the TabBar new-tab picker
  // pattern. Outside-click checks the toolbar wrapper so clicking the +
  // button itself (which toggles) doesn't immediately re-close the menu.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        wrapRef.current &&
        e.target instanceof Node &&
        !wrapRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      ref={wrapRef}
      onMouseDown={stop}
      onPointerDown={stop}
      style={{
        position: "absolute",
        top: 6,
        right: 8,
        display: "flex",
        gap: 2,
        padding: 2,
        borderRadius: 7,
        // Subtle pill background so the toolbar reads as a single grouped
        // affordance instead of three loose buttons floating over the
        // terminal canvas.
        background: "color-mix(in oklch, var(--panel) 78%, transparent)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        border: "1px solid color-mix(in oklch, var(--rule-soft) 70%, transparent)",
        opacity: menuOpen ? 1 : 0.55,
        transition:
          "opacity var(--motion-fast, 120ms) var(--ease-out, ease-out), transform var(--motion-fast, 120ms) var(--ease-out, ease-out)",
        zIndex: 5,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "1";
      }}
      onMouseLeave={(e) => {
        if (!menuOpen) e.currentTarget.style.opacity = "0.55";
      }}
    >
      <PaneDragHandle payload={dragPayload} />
      <span
        aria-hidden
        style={{
          width: 1,
          alignSelf: "stretch",
          margin: "2px 1px",
          background: "color-mix(in oklch, var(--rule-soft) 70%, transparent)",
        }}
      />
      <ToolbarButton
        ref={plusRef}
        title="Add pane…"
        onClick={() => setMenuOpen((o) => !o)}
        active={menuOpen}
      >
        <PlusIcon size={12} />
      </ToolbarButton>
      <span
        aria-hidden
        style={{
          width: 1,
          alignSelf: "stretch",
          margin: "2px 1px",
          background: "color-mix(in oklch, var(--rule-soft) 70%, transparent)",
        }}
      />
      <ToolbarButton title="Split right (Ctrl+\\)" onClick={onSplitRight}>
        <SplitRightIcon size={12} />
      </ToolbarButton>
      <ToolbarButton title="Split down (Ctrl+Shift+\\)" onClick={onSplitDown}>
        <SplitDownIcon size={12} />
      </ToolbarButton>
      <ToolbarButton title="Close pane" onClick={onClose} danger>
        <CloseIcon size={12} />
      </ToolbarButton>
      {menuOpen && (
        <AddPaneMenu
          onPick={(kind) => {
            setMenuOpen(false);
            if (kind === "shell") onSmartAdd();
            else if (kind === "claude") onSmartAdd(CLAUDE_LAUNCH_COMMAND);
            else if (kind === "codex") onSmartAdd(CODEX_LAUNCH_COMMAND);
            else if (kind === "cursor") onSmartAdd(CURSOR_LAUNCH_COMMAND);
          }}
        />
      )}
    </div>
  );
}

function PaneDragHandle({ payload }: { payload: TerminalPaneDragPayload }) {
  const [dragging, setDragging] = useState(false);
  const pointerIdRef = useRef<number | null>(null);

  const finishPointerDrag = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateTerminalDragPositionFromPoint(event);
    pointerIdRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    window.setTimeout(() => {
      if (peekTerminalPaneDrag()?.paneId === payload.paneId) endTerminalPaneDrag();
    }, 0);
  };

  return (
    <span
      role="button"
      tabIndex={-1}
      title="Drag pane"
      aria-label="Drag pane"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        pointerIdRef.current = event.pointerId;
        setDragging(true);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        beginTerminalPaneDrag(
          payload,
          terminalDragPointFromClient(event) ?? { clientX: 0, clientY: 0 },
        );
      }}
      onPointerMove={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        updateTerminalDragPositionFromPoint(event);
      }}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      style={{
        width: 20,
        height: 20,
        borderRadius: 5,
        color: dragging ? "var(--accent)" : "var(--ink-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: dragging ? "grabbing" : "grab",
        background: dragging ? "color-mix(in oklch, var(--accent) 18%, transparent)" : "transparent",
        touchAction: "none",
      }}
    >
      <DragHandleIcon size={12} />
    </span>
  );
}

type AddPaneKind = "shell" | "claude" | "codex" | "cursor";

// Polished popover anchored to the toolbar's + button. The shell entry is the
// default smart-add behavior (split the most spacious leaf); the two worker
// entries do the same split but seed the new leaf with an `autorun` so the
// shell auto-launches claude/codex once its prompt is ready.
function AddPaneMenu({ onPick }: { onPick: (kind: AddPaneKind) => void }) {
  const items: Array<{
    kind: AddPaneKind;
    title: string;
    hint: string;
    command?: string;
    accent: "shell" | "claude" | "codex" | "cursor";
    glyph: React.ReactNode;
  }> = [
    {
      kind: "shell",
      title: "New shell",
      hint: "default",
      accent: "shell",
      glyph: <PlusIcon size={11} />,
    },
    {
      kind: "claude",
      title: "Claude worker",
      hint: "worker",
      command: CLAUDE_LAUNCH_COMMAND,
      accent: "claude",
      glyph: <RuntimeGlyph letter="C" />,
    },
    {
      kind: "codex",
      title: "Codex worker",
      hint: "worker",
      command: CODEX_LAUNCH_COMMAND,
      accent: "codex",
      glyph: <RuntimeGlyph letter="X" />,
    },
    {
      kind: "cursor",
      title: "Cursor worker",
      hint: "worker",
      command: CURSOR_LAUNCH_COMMAND,
      accent: "cursor",
      glyph: <RuntimeGlyph letter="U" />,
    },
  ];

  return (
    <div
      role="menu"
      aria-label="Add terminal pane"
      style={{
        position: "absolute",
        top: "calc(100% + 6px)",
        right: 0,
        zIndex: 50,
        minWidth: 238,
        background: "color-mix(in oklch, var(--panel-2, var(--panel)) 94%, transparent)",
        border: "1px solid var(--rule-strong, var(--rule))",
        borderRadius: 7,
        boxShadow: "0 12px 30px rgba(0,0,0,0.36), 0 1px 4px rgba(0,0,0,0.22)",
        padding: 3,
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      <div style={{ display: "grid", gap: 1 }}>
        {items.map((item) => (
          <AddPaneMenuItem
            key={item.kind}
            title={item.title}
            hint={item.hint}
            command={item.command}
            accent={item.accent}
            glyph={item.glyph}
            onClick={() => onPick(item.kind)}
          />
        ))}
      </div>
    </div>
  );
}

function AddPaneMenuItem({
  title,
  hint,
  command,
  glyph,
  accent,
  onClick,
}: {
  title: string;
  hint: string;
  command?: string;
  glyph: React.ReactNode;
  accent: "shell" | "claude" | "codex" | "cursor";
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const active = hover || focus;
  const tone = menuItemTone(accent);
  const detail = command ?? "current workspace";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        appearance: "none",
        width: "100%",
        textAlign: "left",
        background: active
          ? "color-mix(in oklch, var(--ink) 6%, transparent)"
          : "transparent",
        border: "none",
        padding: "6px 7px",
        borderRadius: 5,
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 8,
        minHeight: 36,
        transition:
          "background var(--motion-fast, 120ms) var(--ease-out, ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 5,
          background: tone.background,
          color: tone.color,
          border: `1px solid ${tone.border}`,
        }}
      >
        {glyph}
      </span>
      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 650,
              lineHeight: 1.15,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </span>
          <span
            style={{
              color: "var(--muted)",
              fontSize: 10,
              fontWeight: 600,
              lineHeight: 1,
              textTransform: "uppercase",
              flex: "0 0 auto",
            }}
          >
            {hint}
          </span>
        </span>
        <span
          style={{
            fontSize: 10,
            color: "var(--muted)",
            fontFamily: command ? "var(--font-mono)" : "var(--font-sans)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginTop: 1,
          }}
        >
          {detail}
        </span>
      </span>
      <span
        aria-hidden
        style={{
          color: active ? "var(--ink-dim)" : "var(--muted-2)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        &gt;
      </span>
    </button>
  );
}

function menuItemTone(accent: "shell" | "claude" | "codex" | "cursor"): {
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
  if (accent === "cursor") {
    return {
      color: "var(--warn)",
      background: "color-mix(in oklch, var(--warn) 14%, transparent)",
      border: "color-mix(in oklch, var(--warn) 30%, transparent)",
    };
  }
  return {
    color: "var(--ink-dim)",
    background: "color-mix(in oklch, var(--ink) 7%, transparent)",
    border: "color-mix(in oklch, var(--rule-soft) 90%, transparent)",
  };
}

function RuntimeGlyph({ letter }: { letter: string }) {
  return (
    <span
      style={{
        fontSize: 13,
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        letterSpacing: 0,
      }}
    >
      {letter}
    </span>
  );
}

const ToolbarButton = React.forwardRef<
  HTMLButtonElement,
  {
    title: string;
    onClick: () => void;
    danger?: boolean;
    active?: boolean;
    children: React.ReactNode;
  }
>(function ToolbarButton({ title, onClick, danger = false, active = false, children }, ref) {
  const [hover, setHover] = useState(false);
  const baseColor = danger ? "var(--danger, #e06c75)" : "var(--ink-dim)";
  const hoverBg = danger
    ? "color-mix(in oklch, var(--danger, #e06c75) 18%, transparent)"
    : "color-mix(in oklch, var(--ink) 12%, transparent)";
  const activeBg = "color-mix(in oklch, var(--ink) 14%, transparent)";
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      aria-label={title}
      aria-haspopup={active !== undefined ? true : undefined}
      aria-expanded={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        background: active ? activeBg : hover ? hoverBg : "transparent",
        border: "none",
        color:
          active || hover
            ? danger
              ? "var(--danger, #e06c75)"
              : "var(--ink)"
            : baseColor,
        width: 20,
        height: 20,
        borderRadius: 5,
        cursor: "default",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        lineHeight: 1,
        transition: "background var(--motion-fast, 120ms) var(--ease-out, ease-out), color var(--motion-fast, 120ms) var(--ease-out, ease-out)",
      }}
    >
      {children}
    </button>
  );
});

function forEachLeaf(node: PaneNode, fn: (l: TerminalLeaf) => void): void {
  if (node.kind === "leaf") {
    fn(node);
    return;
  }
  forEachLeaf(node.a, fn);
  forEachLeaf(node.b, fn);
}

function visibleWorkerChip(worker: TerminalLeafWorker | null | undefined): TerminalLeafWorker | null {
  if (!worker) return null;
  if (worker.source === "spark") {
    if (worker.agentRunning === false) return null;
    if (worker.state === "done" && worker.agentRunning !== true) return null;
    return worker;
  }
  if (worker.source === "manual") return worker.state === "running" ? worker : null;
  return null;
}

// Small overlay chip rendered on a pane that's hosting a live manual agent or
// a Spark-owned worker attempt. Manual chips are visible only while running;
// Spark chips can go static as "done" after the attempt-finished event, then
// disappear once the foreground agent has returned to the shell prompt.
function WorkerChip({ worker }: { worker: TerminalLeafWorker }) {
  const label = worker.runtime ? worker.runtime.toUpperCase() : "WORKER";
  const running = worker.state === "running";
  const chipAccent = "color-mix(in oklch, var(--accent) 48%, white)";
  const chipAccentSoft = "color-mix(in oklch, var(--accent) 32%, white)";
  return (
    <div
      style={{
        position: "absolute",
        top: 6,
        left: 8,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        background: "color-mix(in oklch, var(--panel) 90%, black)",
        border: `1px solid ${chipAccent}`,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        color: chipAccent,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        textShadow: "0 1px 2px rgba(0, 0, 0, 0.72)",
        boxShadow: `0 0 0 1px rgba(0, 0, 0, 0.38), 0 0 14px color-mix(in oklch, var(--accent) 24%, transparent)`,
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: running ? chipAccent : chipAccentSoft,
          boxShadow: running ? `0 0 9px ${chipAccent}` : "none",
        }}
      />
      <span>{label}</span>
      <span style={{ opacity: 0.78, fontWeight: 500 }}>
        {running ? "running" : "done"}
      </span>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalPane, type TerminalPaneHandle } from "../components/Terminal/TerminalPane";
import type { ShellInfo } from "@shared/types";
import type { SparkOpenInput } from "../components/Terminal/useTerminalSession";
import { smartAddTarget, type PanePath } from "./paneTree";
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
import { TERMINAL_PANE_DRAG_MIME, parseTerminalPaneDrag, type TerminalPaneDragPayload } from "./terminalDrag";

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
  const [dropIntent, setDropIntent] = useState<DropIntent | null>(null);
  // Flatten the pane tree into a positioned leaf list + resize handles.
  // Every leaf is rendered as a sibling keyed by paneId, so splitting or
  // closing a pane only adds/removes keys — the panes that stay put keep
  // their xterm instance and PTY instead of being torn down and respawned
  // as blank shells.
  //
  // useMemo keyed on `tab.root`: the paneTree helpers preserve node
  // identity for untouched subtrees and only return a new root when the
  // tree actually changed, so `tab.root` is an exact cache key — this
  // recursive walk is skipped entirely on renders that didn't touch the
  // tree (e.g. a sibling pane's activity, or activePaneId flipping).
  const { leaves, handles } = useMemo(() => {
    const ls: LeafBox[] = [];
    const hs: HandleBox[] = [];
    layoutPanes(tab.root, [], FULL_RECT, ls, hs);
    return { leaves: ls, handles: hs };
  }, [tab.root]);

  return (
    <div
      ref={(el) => setTabRoot(tab.id, el)}
      aria-hidden={!visible}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: visible ? 2 : 1,
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {leaves.map(({ leaf, rect }) => {
        const bundle = getBundle(tab.id, leaf.paneId);
        const isActive = tab.activePaneId === leaf.paneId;
        const workerChip = visibleWorkerChip(leaf.worker);
        const activeDrop =
          dropIntent && dropIntent.paneId === leaf.paneId ? dropIntent : null;
        return (
          <div
            key={leaf.paneId}
            onMouseDown={bundle.onActivate}
            onDragEnter={(event) => {
              if (!acceptsTerminalPane(event)) return;
              event.preventDefault();
              event.stopPropagation();
              setDropIntent(dropIntentFromEvent(event, leaf.paneId));
            }}
            onDragOver={(event) => {
              if (!acceptsTerminalPane(event)) return;
              event.preventDefault();
              event.stopPropagation();
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
              const intent = dropIntentFromEvent(event, leaf.paneId);
              setDropIntent(null);
              onPaneDrop(payload, tab.id, intent);
            }}
            style={{
              position: "absolute",
              left: pct(rect.left),
              top: pct(rect.top),
              width: pct(rect.width),
              height: pct(rect.height),
              // 1px ring on the active leaf so users always know which
              // pane keyboard input goes to. Inset so it doesn't push
              // the xterm canvas inward on every focus toggle.
              boxShadow: isActive
                ? "inset 0 0 0 1px var(--accent)"
                : "inset 0 0 0 1px transparent",
              outline: activeDrop ? "1px solid var(--accent)" : "none",
              outlineOffset: -2,
              transition:
                "box-shadow var(--motion-fast, 120ms) var(--ease-out, ease-out)",
            }}
          >
            {activeDrop ? <PaneDropMarker intent={activeDrop} /> : null}
            <TerminalPane
              ref={(h) => setHandle(leaf.paneId, h)}
              sessionId={leaf.paneId}
              shell={shell}
              initialCwd={leaf.cwd}
              initialScrollback={leaf.scrollback}
              initialCommand={leaf.autorun}
              // A non-active TAB still mounts every pane (so PTYs
              // survive switches); only the active tab's panes take
              // pointer events. Within an active tab every pane is
              // visible — splits share the screen, they aren't tabs.
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
      {handles.map((handle) => (
        <ResizeHandle
          key={`h:${handle.path.join("/") || "root"}`}
          handle={handle}
          getContainer={() => getTabRoot(tab.id)}
          onRatioChange={(ratio) => onRatioChange(tab.id, handle.path, ratio)}
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

interface DropIntent {
  paneId: string;
  direction: TerminalSplit["direction"];
  position: "before" | "after";
}

// Visible divider thickness; the grab target is wider so the handle stays
// easy to hit without a chunky-looking rule.
const HANDLE_THICKNESS = 4;
const HANDLE_HIT = 11;
const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;

function pct(fraction: number): string {
  return `${fraction * 100}%`;
}

function acceptsTerminalPane(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(TERMINAL_PANE_DRAG_MIME);
}

function dropIntentFromEvent(
  event: React.DragEvent<HTMLElement>,
  paneId: string,
): DropIntent {
  const rect = event.currentTarget.getBoundingClientRect();
  const x = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5;
  const y = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
  const distances = [
    { edge: "left", value: x },
    { edge: "right", value: 1 - x },
    { edge: "top", value: y },
    { edge: "bottom", value: 1 - y },
  ].sort((a, b) => a.value - b.value);
  const edge = distances[0]?.edge ?? "right";
  if (edge === "left") {
    return { paneId, direction: "horizontal", position: "before" };
  }
  if (edge === "right") {
    return { paneId, direction: "horizontal", position: "after" };
  }
  if (edge === "top") {
    return { paneId, direction: "vertical", position: "before" };
  }
  return { paneId, direction: "vertical", position: "after" };
}

function PaneDropMarker({ intent }: { intent: DropIntent }) {
  const horizontal = intent.direction === "horizontal";
  const before = intent.position === "before";
  const previewStyle = horizontal
    ? {
        top: 0,
        bottom: 0,
        width: "50%",
        left: before ? 0 : undefined,
        right: before ? undefined : 0,
      }
    : {
        left: 0,
        right: 0,
        height: "50%",
        top: before ? 0 : undefined,
        bottom: before ? undefined : 0,
      };
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        zIndex: 7,
        pointerEvents: "none",
        border: "1px solid color-mix(in oklch, var(--accent) 42%, transparent)",
        background:
          "color-mix(in oklch, var(--accent) 10%, transparent)",
        boxShadow:
          "inset 0 0 0 1px color-mix(in oklch, var(--accent) 20%, transparent), inset 0 0 30px color-mix(in oklch, var(--accent) 13%, transparent), 0 0 20px color-mix(in oklch, var(--accent) 16%, transparent)",
        ...previewStyle,
      }}
    />
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

// A draggable divider between two panes. Rendered as a flat sibling of the
// leaf wrappers and positioned over the split boundary, with a wide invisible
// hit area centred on the thin visible rule.
function ResizeHandle({ handle, getContainer, onRatioChange }: ResizeHandleProps) {
  const draggingRef = useRef(false);
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
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const container = getContainer();
    if (!container) return;
    const cr = container.getBoundingClientRect();
    let next: number;
    if (isHorizontal) {
      const splitLeft = cr.left + rect.left * cr.width;
      const splitWidth = rect.width * cr.width;
      if (splitWidth <= 0) return;
      next = (e.clientX - splitLeft) / splitWidth;
    } else {
      const splitTop = cr.top + rect.top * cr.height;
      const splitHeight = rect.height * cr.height;
      if (splitHeight <= 0) return;
      next = (e.clientY - splitTop) / splitHeight;
    }
    onRatioChange(Math.min(MAX_RATIO, Math.max(MIN_RATIO, next)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-hidden
      style={{
        position: "absolute",
        zIndex: 4,
        touchAction: "none",
        cursor: isHorizontal ? "col-resize" : "row-resize",
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
          background: "var(--rule-soft)",
          pointerEvents: "none",
          ...(isHorizontal
            ? { width: HANDLE_THICKNESS, height: "100%" }
            : { height: HANDLE_THICKNESS, width: "100%" }),
        }}
      />
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

const CLAUDE_LAUNCH_COMMAND = "claude --dangerously-skip-permissions";
const CODEX_LAUNCH_COMMAND = "codex --yolo";
// Cursor's CLI worker — only the composer-2.5-fast model is supported, no flags.
const CURSOR_LAUNCH_COMMAND = "agent";

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
  return (
    <span
      role="button"
      tabIndex={-1}
      draggable
      title="Drag pane to tab bar"
      aria-label="Drag pane to tab bar"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onDragStart={(event) => {
        event.stopPropagation();
        setDragging(true);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(TERMINAL_PANE_DRAG_MIME, JSON.stringify(payload));
        event.dataTransfer.setData("text/plain", "Spark terminal pane");
      }}
      onDragEnd={(event) => {
        event.stopPropagation();
        setDragging(false);
      }}
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

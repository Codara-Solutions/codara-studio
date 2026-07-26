import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TerminalPane, type TerminalPaneHandle } from "../components/Terminal/TerminalPane";
import type {
  PtyExitInfo,
  RuntimeState,
  ShellInfo,
  TerminalAgentForegroundState,
  WorkerSessionRuntime,
} from "@shared/types";
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
  TerminalAgentSession,
  TerminalLeaf,
  TerminalLeafWorker,
  TerminalSplit,
  TerminalTab,
} from "./types";
import { BackIcon, CloseIcon, DragHandleIcon, HistoryIcon, LockIcon, PlusIcon, SplitDownIcon, SplitRightIcon, ZoomPaneIcon } from "../components/icons";
import { workerModelLabel } from "../components/runs/run-format";
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
  buildAgentResumeCommand,
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
  // False when this stack belongs to a workspace that is mounted-but-hidden
  // (kept alive across a workspace switch). Defaults to true. Gates the
  // window-level drag listeners so only the visible workspace's stack reacts to
  // a pane drag — N mounted stacks must not each handle the same global drag.
  workspaceVisible?: boolean;
  shell: ShellInfo | null;
  scrollbackLineLimit: number;
  onDetectedUrl: (tabId: TabId, paneId: string, url: string) => void;
  onSparkOpen: (input: SparkOpenInput) => void;
  onPaneExit: (tabId: TabId, paneId: string, info: PtyExitInfo) => void;
  onActivatePane: (tabId: TabId, paneId: string) => void;
  onSplitRatioChange: (tabId: TabId, path: PanePath, ratio: number) => void;
  onSplitPane: (
    tabId: TabId,
    paneId: string,
    direction: TerminalSplit["direction"],
    autorun?: string,
    agentSession?: TerminalAgentSession | null,
  ) => void;
  onOpenWorkerSessionPicker: (
    runtime: WorkerSessionRuntime,
    cwd: string | undefined,
    launch: (command: string, session: TerminalAgentSession | null) => void,
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
  // Toggle the named pane between zoom (full tab area) and normal (its
  // position in the BSP split). The state lives on the TerminalTab so it
  // survives tab switches; the consumer flips `zoomedPaneId` on/off.
  onTabZoomToggle: (tabId: TabId, paneId: string) => void;
  onPaneCwd: (tabId: TabId, paneId: string, cwd: string) => void;
  onPaneActivity: (tabId: TabId, paneId: string) => void;
  onPaneUserInput: (tabId: TabId, paneId: string) => void;
  onPaneScrollback: (tabId: TabId, paneId: string, scrollback: string) => void;
  // Synchronous quit-time persist: collect every pane's final buffer and write
  // it to localStorage in one call. Routed straight to useTabs.flushScrollbackNow.
  onFlushScrollback: (entries: Array<{ tabId: TabId; paneId: string; text: string }>) => void;
  onPaneAgentState: (
    tabId: TabId,
    paneId: string,
    state: TerminalAgentForegroundState,
  ) => void;
  // Finer live agent state (working / blocked / idle / done) from the
  // per-pane runtime poller, used to colour + label the worker chip. Distinct
  // from onPaneAgentState, which carries the binary running/runtime lifecycle.
  onPaneRuntimeState: (tabId: TabId, paneId: string, state: RuntimeState) => void;
  // A restored pane's `--resume` probe found no transcript on disk — clear the
  // stale session pointer so it stops trying to resume and can re-capture.
  onPaneResumeUnavailable: (tabId: TabId, paneId: string) => void;
  // A failed Claude restore self-healed into a fresh forced-id session —
  // persist the replacement pointer on the leaf.
  onPaneResumeFallback: (tabId: TabId, paneId: string, session: TerminalAgentSession) => void;
  // A restored pane's first mount made its boot-restore attempt — clear the
  // leaf's one-shot `bootResume` hydration marker.
  onPaneBootResumeConsumed: (tabId: TabId, paneId: string) => void;
  // Run-owned worker terminals are an observation surface by default. This
  // returns to the owning run canvas without tearing down the xterm or its PTY.
  onBackToRuns: () => void;
}

// Per-pane bundle of stable callbacks. Cached per `tabId:paneId` so a
// TerminalPane never sees a fresh callback identity (which would make it
// destroy + respawn its xterm + PTY). Hoisted to module scope so the
// extracted TerminalTabPane child below can reference the type.
type Bundle = {
  onDetectedUrl: (url: string) => void;
  onSparkOpen: (input: SparkOpenInput) => void;
  onExit: (info: PtyExitInfo) => void;
  onActivate: () => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onSmartAdd: (autorun?: string, agentSession?: TerminalAgentSession | null) => void;
  onOpenWorkerSessions: (runtime: WorkerSessionRuntime) => void;
  onClose: () => void;
  onToggleZoom: () => void;
  onCwd: (cwd: string) => void;
  onActivity: () => void;
  onUserInput: () => void;
  onAgentState: (state: TerminalAgentForegroundState) => void;
  onRuntimeState: (state: RuntimeState) => void;
  onResumeUnavailable: () => void;
  onResumeFallback: (session: TerminalAgentSession) => void;
  onBootResumeConsumed: () => void;
};

// React.memo: with the useTabs API object now memoized, TerminalStack's
// props only change when the tab list / active id / callbacks genuinely
// change, so an unrelated App re-render no longer walks the whole terminal
// stack and re-runs layoutPanes for every tab.
function TerminalStack({
  tabs,
  activeId,
  workspaceVisible = true,
  shell,
  scrollbackLineLimit,
  onDetectedUrl,
  onSparkOpen,
  onPaneExit,
  onActivatePane,
  onSplitRatioChange,
  onSplitPane,
  onOpenWorkerSessionPicker,
  onMovePane,
  onClosePane,
  onTabZoomToggle,
  onPaneCwd,
  onPaneActivity,
  onPaneUserInput,
  onPaneScrollback,
  onFlushScrollback,
  onPaneAgentState,
  onPaneRuntimeState,
  onPaneResumeUnavailable,
  onPaneResumeFallback,
  onPaneBootResumeConsumed,
  onBackToRuns,
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
  const openWorkerSessionPickerRef = useRef(onOpenWorkerSessionPicker);
  const moveRef = useRef(onMovePane);
  const closeRef = useRef(onClosePane);
  const zoomToggleRef = useRef(onTabZoomToggle);
  const cwdRef = useRef(onPaneCwd);
  const activityRef = useRef(onPaneActivity);
  const userInputRef = useRef(onPaneUserInput);
  const scrollbackRef = useRef(onPaneScrollback);
  const workspaceVisibleRef = useRef(workspaceVisible);
  const flushScrollbackRef = useRef(onFlushScrollback);
  const agentStateRef = useRef(onPaneAgentState);
  const runtimeStateRef = useRef(onPaneRuntimeState);
  const resumeUnavailableRef = useRef(onPaneResumeUnavailable);
  const resumeFallbackRef = useRef(onPaneResumeFallback);
  const bootResumeConsumedRef = useRef(onPaneBootResumeConsumed);
  useEffect(() => {
    detectedRef.current = onDetectedUrl;
    sparkOpenRef.current = onSparkOpen;
    exitRef.current = onPaneExit;
    activateRef.current = onActivatePane;
    ratioRef.current = onSplitRatioChange;
    splitRef.current = onSplitPane;
    openWorkerSessionPickerRef.current = onOpenWorkerSessionPicker;
    moveRef.current = onMovePane;
    closeRef.current = onClosePane;
    zoomToggleRef.current = onTabZoomToggle;
    cwdRef.current = onPaneCwd;
    activityRef.current = onPaneActivity;
    userInputRef.current = onPaneUserInput;
    scrollbackRef.current = onPaneScrollback;
    workspaceVisibleRef.current = workspaceVisible;
    flushScrollbackRef.current = onFlushScrollback;
    agentStateRef.current = onPaneAgentState;
    runtimeStateRef.current = onPaneRuntimeState;
    resumeUnavailableRef.current = onPaneResumeUnavailable;
    resumeFallbackRef.current = onPaneResumeFallback;
    bootResumeConsumedRef.current = onPaneBootResumeConsumed;
  }, [workspaceVisible, onDetectedUrl, onSparkOpen, onPaneExit, onActivatePane, onSplitRatioChange, onSplitPane, onOpenWorkerSessionPicker, onMovePane, onClosePane, onTabZoomToggle, onPaneCwd, onPaneActivity, onPaneUserInput, onPaneScrollback, onFlushScrollback, onPaneAgentState, onPaneRuntimeState, onPaneResumeUnavailable, onPaneResumeFallback, onPaneBootResumeConsumed]);

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
  const smartAddTargetInTab = useCallback((tabId: TabId) => {
    const tab = tabsRef.current.find((t) => t.id === tabId);
    if (!tab) return null;
    const el = tabRootsRef.current.get(tabId);
    const rect = el?.getBoundingClientRect();
    // Sensible fallback for the rare case where the ref hasn't attached yet
    // (immediately after mount); default to a 16:9 box so direction picking
    // still leans toward horizontal splits on wide workspaces.
    const W = rect && rect.width > 0 ? rect.width : 1600;
    const H = rect && rect.height > 0 ? rect.height : 900;
    return smartAddTarget(tab.root, W, H);
  }, []);

  const smartAddInTab = useCallback((
    tabId: TabId,
    autorun?: string,
    agentSession?: TerminalAgentSession | null,
  ): void => {
    const target = smartAddTargetInTab(tabId);
    if (!target) return;
    splitRef.current(tabId, target.paneId, target.direction, autorun, agentSession);
  }, [smartAddTargetInTab]);

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
          onSmartAdd: (autorun, agentSession) => smartAddInTab(tabId, autorun, agentSession),
          onOpenWorkerSessions: (runtime) => {
            const target = smartAddTargetInTab(tabId);
            if (!target) return;
            const tab = tabsRef.current.find((item) => item.id === tabId);
            const targetLeaf = tab ? findLeaf(tab.root, target.paneId) : null;
            openWorkerSessionPickerRef.current(
              runtime,
              targetLeaf?.cwd,
              (command, session) => {
                splitRef.current(
                  tabId,
                  target.paneId,
                  target.direction,
                  command,
                  session,
                );
              },
            );
          },
          onClose: () => closeRef.current(tabId, paneId),
          onToggleZoom: () => zoomToggleRef.current(tabId, paneId),
          onCwd: (cwd: string) => cwdRef.current(tabId, paneId, cwd),
          onActivity: () => {
            activityRef.current(tabId, paneId);
            const now = Date.now();
            const last = lastScrollbackSnapshotRef.current.get(paneId) ?? 0;
            if (workspaceVisibleRef.current && now - last >= 2_000) {
              lastScrollbackSnapshotRef.current.set(paneId, now);
              snapshotScrollback(tabId, paneId);
            }
          },
          onUserInput: () => userInputRef.current(tabId, paneId),
          onAgentState: (state) => agentStateRef.current(tabId, paneId, state),
          onRuntimeState: (state) => runtimeStateRef.current(tabId, paneId, state),
          onResumeUnavailable: () => resumeUnavailableRef.current(tabId, paneId),
          onResumeFallback: (session) => resumeFallbackRef.current(tabId, paneId, session),
          onBootResumeConsumed: () => bootResumeConsumedRef.current(tabId, paneId),
        };
        bundles.current.set(key, b);
      }
      return b;
    },
    [smartAddInTab, smartAddTargetInTab, snapshotScrollback],
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
    // Collect every pane's final buffer and persist them in ONE synchronous
    // write. The previous version called snapshotScrollback per pane, which
    // routed through setLeafScrollback's state updater — and React runs only
    // the first queued updater synchronously during teardown, so all but one
    // pane's final scrollback was lost on quit. flushScrollbackNow folds the
    // whole batch into the tab tree and writes localStorage once, outside any
    // updater.
    const flushAllScrollback = () => {
      const entries: Array<{ tabId: TabId; paneId: string; text: string }> = [];
      for (const t of tabsRef.current) {
        forEachLeaf(t.root, (leaf) => {
          const buffer = handlesRef.current.get(leaf.paneId)?.getBuffer(500);
          if (buffer && buffer.trim().length > 0) {
            entries.push({ tabId: t.id, paneId: leaf.paneId, text: buffer });
          }
        });
      }
      flushScrollbackRef.current(entries);
    };
    window.addEventListener("pagehide", flushAllScrollback);
    window.addEventListener("beforeunload", flushAllScrollback);
    // System-suspend checkpoint (main's powerMonitor 'suspend'): flush the same
    // batch so a process torn down DURING sleep — before any pagehide fires —
    // still persisted every pane's latest scrollback and its live agentSession
    // pointers. Reuses the identical builder so the two paths can't drift.
    const offCheckpoint = window.spark.app.onCheckpoint?.(flushAllScrollback);
    // Quit-start (main's app:before-quit, BEFORE it kills the PTYs): persist now,
    // while every running agent's pointer is still active:true (the pty:exit
    // deactivation is suppressed during teardown). Deterministic persist of the
    // resume-critical state at quit-start instead of racing the final pagehide.
    const offBeforeQuit = window.spark.app.onBeforeQuit?.(flushAllScrollback);
    return () => {
      flushAllScrollback();
      window.removeEventListener("pagehide", flushAllScrollback);
      window.removeEventListener("beforeunload", flushAllScrollback);
      offCheckpoint?.();
      offBeforeQuit?.();
    };
  }, []);

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
    // Only the visible workspace's stack owns the global drag listeners.
    // Hidden (kept-alive) workspace stacks skip them so a single pane drag
    // isn't processed once per mounted stack.
    if (!workspaceVisible) return;
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
  }, [workspaceVisible]);

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
          padding: "var(--terminal-pane-pad)",
          background: "var(--panel)",
        }}
      >
        {/* Idle pane reads as a deliberate rounded card (matching a live pane's
            10px radius + hairline well) rather than a blank void, with the
            calm .spark-empty hint centered inside. */}
        <div
          className="spark-fade-in"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            background: "var(--bg)",
            borderRadius: "var(--terminal-pane-radius)",
            boxShadow: "var(--lift-hi), 0 0 0 1px var(--rule-soft)",
          }}
        >
          <div className="spark-empty">
            <span className="spark-eyebrow">No shell</span>
            <span className="spark-empty__body">
              No shell detected on this system.
            </span>
          </div>
        </div>
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
          scrollbackLineLimit={scrollbackLineLimit}
          getBundle={getBundle}
          setTabRoot={setTabRoot}
          setHandle={setHandle}
          getTabRoot={getTabRoot}
          onRatioChange={onPaneRatioChange}
          onPaneDrop={onPaneDrop}
          onBackToRuns={onBackToRuns}
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
  scrollbackLineLimit: number;
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
  onBackToRuns: () => void;
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
  scrollbackLineLimit,
  getBundle,
  setTabRoot,
  setHandle,
  getTabRoot,
  onRatioChange,
  onPaneDrop,
  onBackToRuns,
}: TerminalTabPaneProps) {
  const tabRootRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [dropIntent, setDropIntent] = useState<DropIntent | null>(null);
  const dropIntentRef = useRef<DropIntent | null>(null);
  const [dragState, setDragState] = useState<TerminalPaneDragState | null>(() =>
    peekTerminalPaneDragState(),
  );
  const drag = dragState?.payload ?? null;
  const ghostPos = dragState ? dragGhostPosition(dragState) : null;
  const workerTerminal = tab.scope?.kind === "workers";
  // Worker terminals open in observation mode. Keep this renderer-local: it
  // is a safety latch for the current view, not durable run state, so every
  // fresh app/tab mount returns to protected input automatically.
  const [workerInputProtected, setWorkerInputProtected] = useState(true);
  const workerWasVisibleRef = useRef(false);
  // Where the guard controls dock: the inner tab strip's right-aligned slot,
  // so they sit in the strip's empty space instead of covering the top-right
  // pane's title. Null (strip not rendered) falls back to floating in-tab.
  const [guardSlot, setGuardSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!workerTerminal || !visible) return;
    setGuardSlot(document.querySelector<HTMLElement>("[data-cora-guard-slot]"));
  }, [workerTerminal, visible]);

  useLayoutEffect(() => {
    if (!workerTerminal) return;
    // Treat each navigation into the worker terminal as a fresh observation
    // visit. An explicit unlock lasts for the current visit only; returning
    // from Runs (or any other tab) restores the safe default.
    if (visible && !workerWasVisibleRef.current) setWorkerInputProtected(true);
    workerWasVisibleRef.current = visible;
  }, [visible, workerTerminal]);

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

  // Zoom is honored only when the named pane actually exists in this tab's
  // current tree. If the zoomed leaf was closed (which clears the id) we
  // fall back to the normal split layout automatically.
  const zoomedPaneId: string | null =
    tab.zoomedPaneId &&
    flowLeaves.some((box) => box.leaf.paneId === tab.zoomedPaneId)
      ? tab.zoomedPaneId
      : null;

  // paneId → current flow rect for this render. Built from `flowLeaves`
  // (which derives from displayRoot, i.e. layoutRoot or the live drop
  // preview), so a pane that's mid-reflow under a drag reads its animated
  // target rect here. A pane absent from the flow (the dragged-and-hidden
  // leaf, removed from layoutRoot so its siblings expand) has no entry and is
  // parked off-screen below instead.
  const flowRectById = useMemo(() => {
    const map = new Map<string, FracRect>();
    for (const box of flowLeaves) map.set(box.leaf.paneId, box.rect);
    return map;
  }, [flowLeaves]);

  // Stable render list: EVERY leaf in tab.root, in tree order, on every
  // render — including the one being dragged. This is what keeps a dragged
  // pane mounted in place: it never leaves the React tree (no re-parent into a
  // separate off-screen mount), so its <TerminalPane> instance — and the live
  // colored / alt-screen xterm behind it — survives the whole drag instead of
  // being disposed, lossily snapshotted, and replayed as monochrome stale
  // text. Active-pane stacking is handled by z-index below, so a fixed
  // tree-order keeps every pane's React key/position stable across the drag.
  const renderLeaves = baseLayout.leaves;

  // Size the off-screen park slot for the dragged pane to its LAST rendered
  // pixel box, not a hard-coded 480x320. A mismatched box forces the live PTY
  // to refit to a tiny ~60x16 grid on drag-start and back on drop — two
  // SIGWINCHes that visibly garble a running TUI. Matching the real size keeps
  // both refits a no-op (identical cols/rows). Derived from the dragged leaf's
  // fractional rect in the full tab layout × the live container's content box,
  // minus the same pane gap paneFrameStyle applies.
  const draggedPaneSize: { width: number; height: number } | null = (() => {
    if (!drag || drag.tabId !== tab.id) return null;
    const container = tabRootRef.current;
    if (!container) return null;
    const box = baseLayout.leaves.find((b) => b.leaf.paneId === drag.paneId);
    if (!box) return null;
    const gap = 3; // mirrors PANE_GAP fallback (--terminal-pane-gap)
    const width = box.rect.width * container.clientWidth - 2 * gap;
    const height = box.rect.height * container.clientHeight - 2 * gap;
    if (!(width > 0) || !(height > 0)) return null;
    return { width, height };
  })();

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
      {renderLeaves.map(({ leaf }) => {
        const bundle = getBundle(tab.id, leaf.paneId);
        const isActive = tab.activePaneId === leaf.paneId;
        const workerChip = visibleWorkerChip(leaf.worker);
        const isZoomed = zoomedPaneId === leaf.paneId;
        const isHiddenByZoom = zoomedPaneId !== null && !isZoomed;
        // This leaf is the one being dragged within THIS tab and the layout is
        // currently hiding it (siblings reflowed into its slot, or a drop
        // preview is showing). Instead of unmounting it into a separate
        // off-screen host — which would dispose + recreate its xterm and
        // reprint stale monochrome text — we keep it mounted right here and
        // just park its wrapper off-screen at its last on-screen pixel size.
        // The live colored / alt-screen buffer is untouched; a dashed
        // PaneDropSlot below marks where it will land.
        const isParkedDragged =
          hideDraggedPane &&
          !!drag &&
          drag.tabId === tab.id &&
          drag.paneId === leaf.paneId;
        const flowRect = flowRectById.get(leaf.paneId);
        // A non-dragged pane with no flow rect can't happen (every tab.root
        // leaf is in displayRoot unless it's the removed drag source); guard
        // anyway so a transient mismatch parks rather than throws.
        const placeOffScreen = isParkedDragged || (!flowRect && !isZoomed);
        // Zoomed pane occupies the full tab area; everything else stays
        // mounted but is hidden so its xterm/PTY survives the toggle.
        const renderRect = isZoomed ? FULL_RECT : (flowRect ?? FULL_RECT);
        const offScreenStyle: React.CSSProperties = {
          left: -10000,
          top: 0,
          width: draggedPaneSize ? Math.round(draggedPaneSize.width) : 480,
          height: draggedPaneSize ? Math.round(draggedPaneSize.height) : 320,
        };
        return (
          <div
            key={leaf.paneId}
            data-terminal-pane-id={leaf.paneId}
            aria-hidden={placeOffScreen ? true : undefined}
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
              // Worker panes stack a header row above the terminal; the
              // header is flex-static and TerminalPane (flex:1, minHeight:0)
              // absorbs the rest, so xterm reflows normally on resize. The
              // display value itself is set below (zoom hiding wins).
              flexDirection: workerTerminal ? "column" : undefined,
              // Parked dragged pane: pull the wrapper off-screen (kept mounted
              // so the live xterm survives) and suppress pointer/animation. A
              // normal pane positions to its flow rect.
              ...(placeOffScreen
                ? offScreenStyle
                : paneFrameStyle(renderRect)),
              overflow: placeOffScreen ? "hidden" : undefined,
              opacity: placeOffScreen
                ? 0
                : layoutAnimating && drag?.paneId !== leaf.paneId
                  ? 0.94
                  : 1,
              pointerEvents: placeOffScreen ? "none" : undefined,
              // display:none keeps the React subtree (and the xterm canvas /
              // PTY behind it) mounted while removing it from layout. When
              // the wrapper toggles back to "block"/"flex", the parent
              // ResizeObserver fires and xterm reflows to the new size.
              display: isHiddenByZoom ? "none" : workerTerminal ? "flex" : undefined,
              // Resting card depth: a hairline well-edge plus a 1px top
              // highlight so each pane reads as a deliberate macOS-like card
              // with clear seams against its neighbours. The accent focus /
              // zoom rings overlay this on a higher z-index.
              boxShadow: placeOffScreen
                ? undefined
                : "var(--lift-hi), 0 0 0 1px var(--rule-soft)",
              zIndex: isZoomed ? 6 : isActive ? 5 : 1,
              // Geometry tween while reflowing under a drag; suppressed under
              // prefers-reduced-motion so panes snap instead of sliding, and on
              // the parked pane itself so it doesn't slide off-screen visibly.
              transition:
                layoutAnimating && !reducedMotion && !placeOffScreen
                  ? "left var(--motion) var(--ease-out), top var(--motion) var(--ease-out), width var(--motion) var(--ease-out), height var(--motion) var(--ease-out), opacity var(--motion-fast) var(--ease-out)"
                  : undefined,
            }}
          >
            {!placeOffScreen && isActive ? <PaneFocusRing /> : null}
            {!placeOffScreen && isZoomed ? <PaneZoomedRing /> : null}
            {workerTerminal && leaf.worker ? (
              <WorkerPaneHeader
                worker={leaf.worker}
                // Only when the guard controls could not dock into the inner
                // tab strip do they float over the tab's top-right corner; the
                // pane rendered there then keeps its header meta clear of them.
                reserveControlsSpace={
                  guardSlot === null &&
                  renderRect.top < 0.001 &&
                  renderRect.left + renderRect.width > 0.999
                }
              />
            ) : null}
            <TerminalPane
              ref={(h) => setHandle(leaf.paneId, h)}
              sessionId={leaf.paneId}
              shell={shell}
              initialCwd={leaf.cwd}
              initialCommand={leaf.autorun}
              showCodaraIntro={
                !leaf.autorun &&
                !leaf.worker &&
                !leaf.agentSession &&
                tab.scope?.kind !== "workers" &&
                !tab.color
              }
              agentSession={leaf.agentSession}
              bootResume={leaf.bootResume === true}
              visible={visible && !placeOffScreen}
              // An opened workspace terminal is a live in-memory surface, even
              // while another tab or workspace is selected. Keep feeding its
              // xterm so returning reveals the existing buffer immediately.
              writeWhileHidden
              scrollbackLineLimit={scrollbackLineLimit}
              onDetectedLocalUrl={bundle.onDetectedUrl}
              onSparkOpen={bundle.onSparkOpen}
              onExit={bundle.onExit}
              onCwd={bundle.onCwd}
              onActivity={bundle.onActivity}
              onUserInput={bundle.onUserInput}
              onAgentState={bundle.onAgentState}
              onRuntimeState={bundle.onRuntimeState}
              onResumeUnavailable={bundle.onResumeUnavailable}
              onResumeFallback={bundle.onResumeFallback}
              onBootResumeConsumed={bundle.onBootResumeConsumed}
              inputBlocked={workerTerminal && workerInputProtected}
            />
            {!placeOffScreen && !workerTerminal && workerChip ? (
              <WorkerChip worker={workerChip} />
            ) : null}
            {!placeOffScreen && !workerTerminal ? (
              <PaneToolbar
                dragPayload={{ tabId: tab.id, paneId: leaf.paneId }}
                cwd={leaf.cwd}
                onSmartAdd={bundle.onSmartAdd}
                onOpenWorkerSessions={bundle.onOpenWorkerSessions}
                onSplitRight={bundle.onSplitRight}
                onSplitDown={bundle.onSplitDown}
                onClose={bundle.onClose}
                onToggleZoom={bundle.onToggleZoom}
                isZoomed={isZoomed}
                visible={visible && !placeOffScreen}
              />
            ) : null}
          </div>
        );
      })}
      {workerTerminal && visible ? (
        <WorkerTerminalGuard
          slot={guardSlot}
          protectedInput={workerInputProtected}
          onToggleProtection={() => setWorkerInputProtected((current) => !current)}
          onBackToRuns={() => {
            // Lock before leaving so the still-mounted xterm can never remain
            // writable behind the Runs surface or on the next visit.
            setWorkerInputProtected(true);
            onBackToRuns();
          }}
        />
      ) : null}
      {dropSlotRect ? (
        <PaneDropSlot rect={dropSlotRect} reducedMotion={reducedMotion} />
      ) : null}
      {drag && ghostPos && visible ? (
        <TerminalDragGhost x={ghostPos.x} y={ghostPos.y} />
      ) : null}
      {zoomedPaneId === null
        ? flowHandles.map((handle) => (
            <ResizeHandle
              key={`h:${handle.path.join("/") || "root"}`}
              handle={handle}
              getContainer={() => getTabRoot(tab.id)}
              onRatioChange={(ratio) => onRatioChange(tab.id, handle.path, ratio)}
            />
          ))
        : null}
      {zoomedPaneId === null
        ? resizeIntersections.map((intersection) => (
            <ResizeIntersectionGrip
              key={intersection.key}
              intersection={intersection}
              getContainer={() => getTabRoot(tab.id)}
              onRatioChange={(path, ratio) => onRatioChange(tab.id, path, ratio)}
            />
          ))
        : null}
    </div>
  );
});

function WorkerTerminalGuard({
  slot,
  protectedInput,
  onToggleProtection,
  onBackToRuns,
}: {
  // Inner tab strip slot to dock the controls into. Null floats them over
  // the tab's top-right corner instead (strip not rendered).
  slot: HTMLElement | null;
  protectedInput: boolean;
  onToggleProtection: () => void;
  onBackToRuns: () => void;
}) {
  const controls = (
    <div
      className={`cora-worker-terminal-controls${slot ? " is-docked" : ""}`}
      role="toolbar"
      aria-label="Worker terminal controls"
    >
        <button
          type="button"
          className="cora-worker-terminal-control"
          onClick={onBackToRuns}
          title="Return to the run graph"
        >
          <BackIcon size={12} />
          <span>Back to Runs</span>
        </button>
        <span className="cora-worker-terminal-control-divider" aria-hidden="true" />
        <button
          type="button"
          className={`cora-worker-terminal-control${protectedInput ? " is-protected" : ""}`}
          aria-pressed={protectedInput}
          onClick={onToggleProtection}
          title={
            protectedInput
              ? "Input is protected. Click to type in this worker terminal."
              : "Input is enabled. Click to protect this worker terminal."
          }
        >
          <LockIcon size={12} />
          <span>{protectedInput ? "Input protected" : "Input enabled"}</span>
        </button>
    </div>
  );
  return (
    <div
      className="cora-worker-terminal-guard"
      data-testid="cora-worker-terminal-guard"
      data-input-protected={protectedInput ? "true" : "false"}
    >
      {protectedInput ? (
        <div
          className="cora-worker-terminal-veil"
          data-testid="cora-worker-terminal-veil"
          aria-hidden="true"
        />
      ) : null}
      {slot ? createPortal(controls, slot) : controls}
    </div>
  );
}

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
// Pane inset gap, sourced from the Foundation token so the rounded cards
// breathe at exactly one value (matches --terminal-pane-gap in styles.css).
// Referenced as a CSS var in calc() below; the numeric fallback keeps the
// resize-snap math correct if the token is ever unresolved.
const PANE_GAP = "var(--terminal-pane-gap, 3px)";
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

// Read-only reduced-motion preference, used purely to drop the inline pane /
// drop-slot geometry transitions (those animate left/top/width/height, which a
// CSS media query can't reach from an inline style). Affects only which
// transition string is emitted — never any behavior, data flow, or DOM shape.
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return reduced;
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
// Inset comes from the shared --terminal-pane-gap token (PANE_GAP) so every
// pane card relates to one geometry source rather than a duplicated literal.
function paneFrameStyle(rect: FracRect): React.CSSProperties {
  return {
    left: `calc(${pct(rect.left)} + ${PANE_GAP})`,
    top: `calc(${pct(rect.top)} + ${PANE_GAP})`,
    width: `calc(${pct(rect.width)} - 2 * ${PANE_GAP})`,
    height: `calc(${pct(rect.height)} - 2 * ${PANE_GAP})`,
  };
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

// Subtle accent border that signals the pane is currently full-tab zoomed.
// Sits below PaneFocusRing's z-index so the focus ring still wins when this
// pane is also active. Pointer events are off so the canvas underneath stays
// interactive.
function PaneZoomedRing() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 19,
        pointerEvents: "none",
        // Two cues only — an accent-edge border + one soft glow — so the zoom
        // mark stays a quiet frame below the brighter active focus ring.
        border: "1px solid var(--accent-edge)",
        borderRadius: "var(--terminal-pane-radius)",
        boxShadow: "0 0 28px color-mix(in oklch, var(--accent) 12%, transparent)",
      }}
    />
  );
}

// Accent frame drawn above the xterm canvas. Sits on a raised z-index pane so
// every edge — including splits against a sibling — stays visible. Two cues
// only — an accent border plus one soft accent glow — instead of the former
// border + 1px ring + inset-wash stack, keeping the active-pane mark precise.
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
        boxShadow: "0 0 18px var(--accent-glow)",
        transition: "box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
      }}
    />
  );
}

// Exact footprint the dragged pane will occupy after drop (from preview layout).
// A transient drag affordance, so a touch of accent is allowed past the <10%
// ration — but toned to read as precise guidance (a dashed accent edge + one
// faint fill), not a light show: the outer glow and inset halo are dropped so
// only a single soft cue remains alongside the border.
function PaneDropSlot({
  rect,
  reducedMotion,
}: {
  rect: FracRect;
  reducedMotion: boolean;
}) {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        ...paneFrameStyle(rect),
        zIndex: 8,
        pointerEvents: "none",
        border: "1px dashed var(--accent-edge)",
        borderRadius: "var(--terminal-pane-radius)",
        background: "color-mix(in oklch, var(--accent) 8%, transparent)",
        boxShadow:
          "inset 0 0 0 1px color-mix(in oklch, var(--accent) 18%, transparent)",
        transition: reducedMotion
          ? undefined
          : "left var(--motion) var(--ease-out), top var(--motion) var(--ease-out), width var(--motion) var(--ease-out), height var(--motion) var(--ease-out)",
      }}
    />
  );
}

// NOTE: the dragged pane is no longer torn out into a separate off-screen
// mount. It now stays at its stable position in the per-leaf render map (see
// TerminalTabPane's renderLeaves loop) and is simply parked off-screen via the
// wrapper style during a drag, so its live xterm — colors, alt-screen TUI
// frame, scrollback — survives the drag instead of being disposed and replayed
// as monochrome stale text. The old DraggedPaneMount component lived here.

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
        background: "color-mix(in oklab, var(--panel) 88%, var(--accent) 12%)",
        boxShadow: [
          "0 0 0 1px color-mix(in oklch, var(--accent) 22%, transparent)",
          "var(--shadow-2)",
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
            "repeating-linear-gradient(0deg, color-mix(in oklab, var(--ink) 4%, transparent) 0 2px, transparent 2px 18px)",
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
  // Hairline groove built from the rule tokens (re-tints per theme) rather than
  // raw ink mixes: a soft --rule core feathered to transparent edges so it
  // reads as a recessed seam, not a hard line.
  const grooveAxis = isHorizontal ? "to right" : "to bottom";
  const groove = `linear-gradient(${grooveAxis},
        transparent 0%,
        var(--rule-soft) 40%,
        var(--rule) 50%,
        var(--rule-soft) 60%,
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
          // Borderless groove that signals state purely by color/glow, never by
          // changing size — the line holds a constant 3px so the seam doesn't
          // thin (or shift its neighbours) when a drag begins.
          transition:
            "opacity var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
          ...(isHorizontal ? { width: 3, height: "100%" } : { height: 3, width: "100%" }),
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
        // On the small-control rung (5px) so the grip nests with the toolbar
        // chrome instead of sitting at an off-ladder 4px.
        borderRadius: "var(--radius-control, 5px)",
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
          : "color-mix(in oklab, var(--panel) 82%, transparent)",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 58%, transparent)"
          : "1px solid color-mix(in oklab, var(--rule-strong) 74%, transparent)",
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
  // The pane's working directory — scopes the history menu's conversation
  // listing to this workspace. Undefined until the shell reports a cwd.
  cwd?: string;
  onSmartAdd: (autorun?: string, agentSession?: TerminalAgentSession | null) => void;
  onOpenWorkerSessions: (runtime: WorkerSessionRuntime) => void;
  onSplitRight: () => void;
  onSplitDown: () => void;
  onClose: () => void;
  onToggleZoom: () => void;
  isZoomed: boolean;
  visible: boolean;
}

function PaneToolbar({
  dragPayload,
  cwd,
  onSmartAdd,
  onOpenWorkerSessions,
  onSplitRight,
  onSplitDown,
  onClose,
  onToggleZoom,
  isZoomed,
  visible,
}: PaneToolbarProps) {
  const stop = (e: React.MouseEvent | React.PointerEvent) => e.stopPropagation();
  // One popover at a time: the add-pane picker or the conversation-history
  // list. Both portal to the same anchored position machinery below.
  const [openMenu, setOpenMenu] = useState<null | "add" | "history">(null);
  const menuOpen = openMenu !== null;
  // Declarative hover state drives the toolbar's rest/hover opacity from one
  // React-owned source, replacing the imperative e.currentTarget.style.opacity
  // mutation on mouseenter/leave (which bypassed React and could desync with
  // the menuOpen state).
  const [hovered, setHovered] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const historyRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!visible) setOpenMenu(null);
  }, [visible]);

  useEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null);
      return;
    }
    const updatePosition = () => {
      const anchorButton = openMenu === "history" ? historyRef.current : plusRef.current;
      const anchor = anchorButton?.getBoundingClientRect();
      if (!anchor) return;
      const menuWidth = menuRef.current?.offsetWidth ?? 238;
      const menuHeight = menuRef.current?.offsetHeight ?? 140;
      const gap = 6;
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - menuWidth - margin);
      const left = Math.min(Math.max(margin, anchor.right - menuWidth), maxLeft);
      const below = anchor.bottom + gap;
      const top = below + menuHeight <= window.innerHeight - margin
        ? below
        : Math.max(margin, anchor.top - menuHeight - gap);
      setMenuPosition({ top, left });
    };
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [openMenu]);

  // Close on outside click / Escape. The menu is portaled out of the filtered
  // toolbar, so both DOM islands count as inside.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        e.target instanceof Node &&
        !wrapRef.current?.contains(e.target) &&
        !menuRef.current?.contains(e.target)
      ) {
        setOpenMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenu(null);
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        top: 6,
        right: 8,
        display: "flex",
        gap: 2,
        padding: 2,
        // 8px pill, concentric with the 10px pane card and the 6px chrome
        // buttons it groups (an earned mild-glass cluster that overlays live
        // terminal canvas, per the toolbar-cluster reference).
        borderRadius: 8,
        // Subtle pill background so the toolbar reads as a single grouped
        // affordance instead of three loose buttons floating over the
        // terminal canvas.
        background: "color-mix(in oklab, var(--panel) 78%, transparent)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        border: "1px solid color-mix(in oklab, var(--rule-soft) 70%, transparent)",
        boxShadow: "var(--lift-hi)",
        // Single React-owned opacity source: dim at rest, full on hover or
        // while the add-pane menu is open. (No .spark-fade-in here — its
        // `both` fill would lock opacity at 1 and defeat the 0.55 rest dim.)
        opacity: hovered || menuOpen ? 1 : 0.55,
        transition:
          "opacity var(--motion-fast, 120ms) var(--ease-out, ease-out)",
        zIndex: 5,
      }}
    >
      <PaneDragHandle payload={dragPayload} />
      <span
        aria-hidden
        style={{
          width: 1,
          alignSelf: "stretch",
          margin: "2px 1px",
          background: "color-mix(in oklab, var(--rule-soft) 70%, transparent)",
        }}
      />
      <ToolbarButton
        ref={plusRef}
        title="Add pane…"
        onClick={() => setOpenMenu((o) => (o === "add" ? null : "add"))}
        active={openMenu === "add"}
        hasPopup
      >
        <PlusIcon size={12} />
      </ToolbarButton>
      <ToolbarButton
        ref={historyRef}
        title="Previous conversations…"
        onClick={() => setOpenMenu((o) => (o === "history" ? null : "history"))}
        active={openMenu === "history"}
        hasPopup
      >
        <HistoryIcon size={12} />
      </ToolbarButton>
      <span
        aria-hidden
        style={{
          width: 1,
          alignSelf: "stretch",
          margin: "2px 1px",
          background: "color-mix(in oklab, var(--rule-soft) 70%, transparent)",
        }}
      />
      <ToolbarButton title="Split right (Ctrl+\\)" onClick={onSplitRight}>
        <SplitRightIcon size={12} />
      </ToolbarButton>
      <ToolbarButton title="Split down (Ctrl+Shift+\\)" onClick={onSplitDown}>
        <SplitDownIcon size={12} />
      </ToolbarButton>
      <ToolbarButton
        title={isZoomed ? "Restore pane (Ctrl+Shift+Z)" : "Zoom pane (Ctrl+Shift+Z)"}
        onClick={onToggleZoom}
        active={isZoomed}
      >
        <ZoomPaneIcon size={12} zoomed={isZoomed} />
      </ToolbarButton>
      <ToolbarButton title="Close pane" onClick={onClose} danger>
        <CloseIcon size={12} />
      </ToolbarButton>
      {openMenu === "add" && menuPosition && createPortal(
        <AddPaneMenu
          ref={menuRef}
          position={menuPosition}
          onPick={(kind) => {
            setOpenMenu(null);
            if (kind === "shell") onSmartAdd();
            else onOpenWorkerSessions(kind);
          }}
        />,
        document.body,
      )}
      {openMenu === "history" && menuPosition && createPortal(
        <HistoryMenu
          ref={menuRef}
          position={menuPosition}
          cwd={cwd}
          onPick={(entry) => {
            setOpenMenu(null);
            // Resume in a pane via the same smart-add path as the worker
            // launchers: an untouched focused pane gets the command injected,
            // a busy one gets a fresh sibling pane. The command carries the
            // CLI's permission-skip flags (see launch-commands.ts).
            onSmartAdd(buildAgentResumeCommand(entry));
          }}
        />,
        document.body,
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
    // .spark-icon-btn supplies the shared rest/hover (ink-9%)/press (ink-13%)
    // backgrounds, the global :focus-visible accent ring, and disabled idiom;
    // the dragging state overlays the accent (color + accent-soft fill) and a
    // grabbing cursor. Kept as a role=button span with tabIndex -1 so the drag
    // gesture and focus semantics are unchanged.
    <span
      role="button"
      tabIndex={-1}
      className={`spark-icon-btn${dragging ? " is-active" : ""}`}
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
        // Match the 20px / 6px geometry of the sibling ToolbarButtons.
        ["--spark-icon-btn-size" as string]: "20px",
        borderRadius: "var(--terminal-control-radius, 6px)",
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
      }}
    >
      <DragHandleIcon size={12} />
    </span>
  );
}

type AddPaneKind = "shell" | "claude" | "codex";

// Polished popover anchored to the toolbar's + button. The shell entry is the
// default smart-add behavior (split the most spacious leaf); the two worker
// entries do the same split but seed the new leaf with an `autorun` so the
// shell auto-launches claude/codex once its prompt is ready.
const AddPaneMenu = React.forwardRef<
  HTMLDivElement,
  { onPick: (kind: AddPaneKind) => void; position: { top: number; left: number } }
>(function AddPaneMenu({ onPick, position }, ref) {
  const items: Array<{
    kind: AddPaneKind;
    title: string;
    hint: string;
    command?: string;
    accent: "shell" | "claude" | "codex";
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
  ];

  return (
    // The single popover language: .spark-menu (--panel-2 face, 9px radius, 1px
    // --rule border, --shadow-2). Opaque on the tint ramp — no backdrop blur,
    // since menus are solid surfaces, not floating-over-live chrome.
    <div
      ref={ref}
      role="menu"
      aria-label="Add terminal pane"
      className="spark-menu"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        zIndex: 50,
        minWidth: 238,
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
});

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
  accent: "shell" | "claude" | "codex";
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const active = hover || focus;
  const tone = menuItemTone(accent);
  const detail = command ?? "current workspace";
  return (
    // .spark-menu-item supplies the shared 5px radius, --hover (ink-5%) hover
    // fill, press beat, and the global :focus-visible accent ring; the inline
    // style only re-shapes it into the richer glyph/title/detail grid. Keyboard
    // focus also lights the --hover fill so focused and hovered rows read alike.
    <button
      type="button"
      role="menuitem"
      className="spark-menu-item"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        textAlign: "left",
        ...(focus ? { background: "var(--hover)" } : null),
        padding: "6px 7px",
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        gap: 8,
        minHeight: 36,
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
          // Swatch radius on the control rung (5px), nesting concentrically
          // inside the 9px menu.
          borderRadius: "var(--radius-control, 5px)",
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
              fontWeight: 600,
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

// One past conversation for this pane's cwd. Mirrors main's AgentHistoryEntry
// (src/main/agent-history.ts) via the preload contract.
interface PaneHistoryEntry {
  runtime: "claude" | "codex";
  sessionId: string;
  cwd: string;
  title: string;
  lastActivityAt: string;
  transcriptPath: string;
}

// Compact "3h" / "2d" age label for history rows (same scale as the chat
// panel's relative timestamps).
function formatHistoryAge(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diffMs = Date.now() - t;
  if (diffMs < 45_000) return "now";
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  const mo = Math.floor(day / 30);
  return mo < 12 ? `${mo}mo` : `${Math.floor(day / 365)}y`;
}

// Conversation-history popover for the pane toolbar's clock button: every
// resumable Claude/Codex session recorded for this pane's cwd, newest first.
// Picking one relaunches it via the CLI's own resume command (smart-add).
const HistoryMenu = React.forwardRef<
  HTMLDivElement,
  {
    position: { top: number; left: number };
    cwd?: string;
    onPick: (entry: PaneHistoryEntry) => void;
  }
>(function HistoryMenu({ position, cwd, onPick }, ref) {
  const [entries, setEntries] = useState<PaneHistoryEntry[] | null>(null);

  useEffect(() => {
    let disposed = false;
    if (!cwd) {
      setEntries([]);
      return;
    }
    window.spark.agentSession
      .history({ cwd, limit: 30 })
      .then((list) => {
        if (!disposed) setEntries(list);
      })
      .catch(() => {
        if (!disposed) setEntries([]);
      });
    return () => {
      disposed = true;
    };
  }, [cwd]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Previous conversations"
      className="spark-menu"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        zIndex: 50,
        minWidth: 300,
        maxWidth: 380,
        maxHeight: 380,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "5px 9px 4px",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        Previous conversations
      </div>
      <div style={{ display: "grid", gap: 1, overflowY: "auto", minHeight: 0 }}>
        {entries === null ? (
          <div style={{ padding: "8px 9px 10px", fontSize: 12, color: "var(--muted)" }}>
            Loading…
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: "8px 9px 10px", fontSize: 12, color: "var(--muted)" }}>
            No previous conversations in this workspace.
          </div>
        ) : (
          entries.map((entry) => (
            <HistoryMenuItem
              key={`${entry.runtime}:${entry.sessionId}`}
              entry={entry}
              onClick={() => onPick(entry)}
            />
          ))
        )}
      </div>
    </div>
  );
});

function HistoryMenuItem({
  entry,
  onClick,
}: {
  entry: PaneHistoryEntry;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const active = hover || focus;
  const tone = menuItemTone(entry.runtime);
  return (
    <button
      type="button"
      role="menuitem"
      className="spark-menu-item"
      title={`Resume this ${entry.runtime === "claude" ? "Claude" : "Codex"} conversation in a pane`}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        textAlign: "left",
        ...(focus ? { background: "var(--hover)" } : null),
        padding: "5px 7px",
        cursor: "default",
        display: "grid",
        gridTemplateColumns: "22px minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 8,
        minHeight: 32,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 6,
          color: tone.color,
          background: tone.background,
          border: `1px solid ${tone.border}`,
        }}
      >
        <RuntimeGlyph letter={entry.runtime === "claude" ? "C" : "X"} />
      </span>
      <span
        style={{
          fontSize: 12,
          lineHeight: 1.25,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.title}
      </span>
      <span
        style={{
          color: active ? "var(--ink-dim)" : "var(--muted)",
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          flex: "0 0 auto",
        }}
      >
        {formatHistoryAge(entry.lastActivityAt)}
      </span>
    </button>
  );
}

function menuItemTone(accent: "shell" | "claude" | "codex"): {
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

// Built on .spark-icon-btn so every pane-chrome glyph shares the app's
// transparent-rest / ink-9%-hover / ink-13%-press / accent-active idiom plus
// the global :focus-visible accent ring and pointer cursor — no per-button
// reimplementation. Sized to 20px and the 6px --terminal-control-radius so the
// buttons nest concentrically inside the 10px pane card. Danger (close) tints
// the close glyph with --danger, re-tinting per OKLCH theme.
const ToolbarButton = React.forwardRef<
  HTMLButtonElement,
  {
    title: string;
    onClick: () => void;
    danger?: boolean;
    active?: boolean;
    hasPopup?: boolean;
    children: React.ReactNode;
  }
>(function ToolbarButton({ title, onClick, danger = false, active = false, hasPopup = false, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={`spark-icon-btn${active ? " is-active" : ""}`}
      title={title}
      aria-label={title}
      aria-haspopup={hasPopup ? "menu" : undefined}
      aria-expanded={hasPopup ? active : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        // 20px target + 6px radius, overriding the class defaults (22/5) so the
        // pane toolbar stays compact and concentric with the 10px pane card.
        ["--spark-icon-btn-size" as string]: "20px",
        borderRadius: "var(--terminal-control-radius, 6px)",
        cursor: "default",
        // Danger close glyph reads red; its hover/press background still comes
        // from the class (ink-tint) so the press beat stays identical across
        // the cluster, and the color re-tints per theme via --danger.
        ...(danger ? { color: "var(--danger)" } : null),
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

// A runtimeState that means the agent's chip should stay visible in the pane
// (vs "done", which is the post-exit terminal state that lets the chip be torn
// down by lifecycle). Covers the live states (launching / working / blocked /
// idle) plus "error" — a crashed pane must keep showing its red "exited" chip
// until the user closes the pane, not silently drop the badge.
function isLiveRuntimeState(state: RuntimeState | undefined): boolean {
  return (
    state === "launching" ||
    state === "working" ||
    state === "blocked" ||
    state === "idle" ||
    state === "error"
  );
}

function visibleWorkerChip(worker: TerminalLeafWorker | null | undefined): TerminalLeafWorker | null {
  if (!worker) return null;
  if (worker.source === "spark") {
    if (worker.agentRunning === false) return null;
    if (worker.state === "done" && worker.agentRunning !== true) return null;
    return worker;
  }
  if (worker.source === "manual") {
    // Manual chips live for the duration of the foreground TUI. Show through
    // every live runtime tone (working / blocked / idle), not only the
    // lifecycle "running" flag — the poller can report idle while the attempt
    // lifecycle is still "running" and the user should still see the pane is
    // hosting an agent that's waiting on them.
    return worker.state === "running" || isLiveRuntimeState(worker.runtimeState)
      ? worker
      : null;
  }
  return null;
}

// Resolved visual treatment for a worker chip, derived from the finer
// runtimeState (working / blocked / idle / done) when the poller has reported
// one, falling back to the lifecycle `state` (running / done) before then.
interface ChipTone {
  // Secondary status eyebrow text.
  status: string;
  // Dot fill + halo, and whether the dot pulses. "blocked" deliberately uses a
  // STEADY amber dot (no pulse) so "waiting for you" reads as a calm, standing
  // request for input rather than busy motion. "ready" (a finished turn) uses a
  // calm GREEN dot so it reads as "your turn", distinct from the grey "done".
  dot: string;
  dotGlow: string;
  pulse: boolean;
  // Chip frame: accent for actively-working, amber for needs-you (blocked),
  // success for a finished/ready turn, danger for a crash, calm neutral for
  // launching / idle-pre-poll / done.
  frame: "accent" | "warn" | "success" | "danger" | "calm";
}

function deriveChipTone(worker: TerminalLeafWorker): ChipTone {
  const runtime = worker.runtimeState;
  if (runtime === "launching") {
    // Freshly detected agent, booting — calm/neutral steady dot, no pulse. Reads
    // as "starting" so a just-launched agent doesn't imply it's already busy.
    return {
      status: "starting",
      dot: "var(--muted-2)",
      dotGlow: "none",
      pulse: false,
      frame: "calm",
    };
  }
  if (runtime === "working") {
    return {
      status: "working",
      dot: "var(--accent)",
      dotGlow: "0 0 9px var(--accent-glow)",
      pulse: true,
      frame: "accent",
    };
  }
  if (runtime === "blocked") {
    return {
      status: "needs you",
      dot: "var(--warn)",
      dotGlow: "0 0 9px color-mix(in oklch, var(--warn) 45%, transparent)",
      pulse: false,
      frame: "warn",
    };
  }
  if (runtime === "idle") {
    // The WIRE "idle" means turn complete / your turn. Render it as a calm GREEN
    // "ready" — distinct from the grey "done" so a finished turn reads as "ready
    // for you", the key visual of the super-state-aware banner.
    return {
      status: "ready",
      dot: "var(--ok)",
      dotGlow: "0 0 9px color-mix(in oklch, var(--ok) 45%, transparent)",
      pulse: false,
      frame: "success",
    };
  }
  if (runtime === "error" && worker.state !== "done") {
    // Unsanctioned pty death / spawn failure: the agent CRASHED. Red danger
    // frame with a steady dot; the chip stays visible until the pane is closed.
    // Labelled "crashed", not "exited": only Cora is allowed to end a worker,
    // so "exited" read as a routine, sanctioned shutdown and hid the fact that
    // this pane died on its own. The word has to name the fault.
    //
    // Gated on the lifecycle: once the attempt reported done its outcome is
    // settled, and a late error write (a stale notifier snapshot, a wake-from-
    // sleep sweep of the already-disposed shell) must not rename a finished
    // worker. Crashed is reserved for a worker that died before it finished.
    return {
      status: "crashed",
      dot: "var(--danger)",
      dotGlow: "0 0 9px color-mix(in oklch, var(--danger) 45%, transparent)",
      pulse: false,
      frame: "danger",
    };
  }
  if (runtime === "done") {
    // Clean finish: the worker's foreground TUI ended after reporting. This is
    // the sanctioned end of a session, so it stays calm and grey.
    return {
      status: "done",
      dot: "var(--muted-2)",
      dotGlow: "none",
      pulse: false,
      frame: "calm",
    };
  }
  // No runtimeState yet — fall back to the attempt lifecycle.
  const running = worker.state === "running";
  // Manual chips (the user ran `claude`/`codex` in a shell): the pulsing accent
  // "working" look is reserved STRICTLY for a confirmed runtimeState==="working"
  // above. The binary `running` lifecycle flag controls only whether the chip
  // EXISTS, never whether it pulses — a freshly launched agent sitting at its
  // idle input box (nothing run yet) lands here before the poller's first
  // report, and must read CALM ("ready"), not imply the agent is busy. The
  // poller resolves it to a real working/idle/blocked tone within a tick or two.
  if (worker.source === "manual") {
    return {
      status: running ? "ready" : "done",
      dot: "var(--muted-2)",
      dotGlow: "none",
      pulse: false,
      frame: "calm",
    };
  }
  // Codara-owned attempts: a running attempt is genuinely working from the
  // moment it spawns (the orchestrator drove the launch), so keep the pulsing
  // "running" accent until the poller refines it — same as before.
  return running
    ? {
        status: "running",
        dot: "var(--accent)",
        dotGlow: "0 0 9px var(--accent-glow)",
        pulse: true,
        frame: "accent",
      }
    : {
        status: "done",
        dot: "var(--muted-2)",
        dotGlow: "none",
        pulse: false,
        frame: "calm",
      };
}

// Live "3m 12s" readout for a running worker. Ticks once a second while a
// start timestamp is provided; callers pass undefined once the attempt is done
// (no finish timestamp is carried on the leaf, so a frozen value would drift).
function useWorkerElapsed(startedAt: string | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;
  const totalSeconds = Math.max(0, Math.floor((now - startMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

// Per-pane header row for Cora worker terminals: names the worker (task
// title), shows attempt ordinal / runtime / live elapsed, and carries the
// status word that used to float on the WorkerChip overlay. Restrained on
// purpose — hairline bottom rule, muted metadata, tone color reserved for the
// status word — and it sits in normal flow above the terminal so it never
// covers output. Clicks bubble to the pane wrapper, so the header also
// selects its pane; the aria-label keeps the "… Cora <status>" phrasing the
// chip announced.
function WorkerPaneHeader({
  worker,
  reserveControlsSpace,
}: {
  worker: TerminalLeafWorker;
  reserveControlsSpace?: boolean;
}) {
  const tone = deriveChipTone(worker);
  const title = worker.title?.trim() || "Cora worker";
  const elapsed = useWorkerElapsed(worker.state === "running" ? worker.startedAt : undefined);
  const runtimeLabel =
    worker.runtime === "claude"
      ? "Claude"
      : worker.runtime === "codex"
        ? "Codex"
        : worker.runtime === "opencode"
          ? "OpenCode"
          : null;
  const harnessLabel =
    worker.harness === "pi" ? (runtimeLabel ? `Pi · ${runtimeLabel}` : "Pi") : runtimeLabel;
  // Name the MODEL, not the harness. Under Pi every worker runs the same
  // harness, so "Pi · Claude" told the user only which subscription was
  // authenticated, never which model was doing the work. The harness/provider
  // detail moves into the tooltip, and remains the label for older attempts
  // that predate the persisted model field.
  // Trim before testing: a whitespace-only model is the same "no model" state
  // as an absent one, and treating it as truthy would fall through to a
  // different fallback (the bare runtime) than the absent case (the harness
  // label) for what the user experiences as one situation.
  const paneModel = worker.model?.trim() || undefined;
  const engine = paneModel
    ? workerModelLabel(paneModel, worker.runtime ?? "claude")
    : harnessLabel;
  const engineTitle = paneModel
    ? `${paneModel}${harnessLabel ? `: ${harnessLabel}` : ""}`
    : undefined;
  const statusColor =
    tone.frame === "accent"
      ? "var(--accent)"
      : tone.frame === "warn"
        ? "var(--warn)"
        : tone.frame === "success"
          ? "var(--ok)"
          : tone.frame === "danger"
            ? "var(--danger)"
            : "var(--muted)";
  return (
    <div
      className="cora-worker-pane-header"
      style={{
        flex: "0 0 auto",
        display: "flex",
        alignItems: "center",
        gap: 8,
        minWidth: 0,
        height: 28,
        padding: "0 10px",
        paddingRight: reserveControlsSpace ? 236 : 10,
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        fontSize: 11,
        lineHeight: "16px",
        color: "var(--muted)",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flex: "0 0 auto",
          background: tone.dot,
          animation: tone.pulse ? "spark-pulse 1.8s var(--ease-out) infinite" : undefined,
        }}
      />
      <span
        title={title}
        style={{
          color: "var(--ink-dim)",
          fontWeight: 500,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </span>
      {typeof worker.attemptOrdinal === "number" && worker.attemptOrdinal > 1 ? (
        <span style={{ flex: "0 0 auto" }}>attempt {worker.attemptOrdinal}</span>
      ) : null}
      <span style={{ flex: 1 }} aria-hidden />
      {engine ? (
        <span style={{ flex: "0 0 auto" }} title={engineTitle}>
          {engine}
        </span>
      ) : null}
      {elapsed ? (
        <span style={{ flex: "0 0 auto", fontVariantNumeric: "tabular-nums" }}>{elapsed}</span>
      ) : null}
      {/* Only the status word is a live region — the ticking elapsed readout
          above must stay outside it, or it would be announced every second. */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`${title} — Cora ${tone.status}`}
        style={{ flex: "0 0 auto", color: statusColor }}
      >
        {tone.status}
      </span>
    </div>
  );
}

// Small overlay chip rendered on a pane that's hosting a live manual agent or
// a Codara-owned worker attempt. Manual chips are visible while the foreground
// agent is live (through working / blocked / idle); Codara chips can go static
// as "done" after the attempt-finished event, then disappear once the
// foreground agent has returned to the shell prompt.
function WorkerChip({ worker }: { worker: TerminalLeafWorker }) {
  // A Cora-owned PI pane is a Cora worker, not an interactive provider
  // session. Keep Claude/Codex labels only for terminals the user launched.
  const label = worker.source === "spark"
    ? "CORA"
    : worker.runtime
      ? worker.runtime.toUpperCase()
      : "WORKER";
  const tone = deriveChipTone(worker);
  const accent = tone.frame === "accent";
  const warn = tone.frame === "warn";
  const success = tone.frame === "success";
  const danger = tone.frame === "danger";
  // The eyebrow/status text inherits the frame colour on any toned frame
  // (accent / warn / success / danger) so the state word pops; a calm frame
  // keeps the muted eyebrow.
  const toned = accent || warn || success || danger;
  // Border / text colour by frame: accent (working), amber (needs-you), green
  // (ready/your turn), red (crashed), or a calm neutral (launching / idle-pre-
  // poll / done).
  const frameColor = accent
    ? "var(--accent)"
    : warn
      ? "var(--warn)"
      : success
        ? "var(--ok)"
        : danger
          ? "var(--danger)"
          : "var(--ink-dim)";
  const frameEdge = accent
    ? "var(--accent-edge)"
    : warn
      ? "color-mix(in oklch, var(--warn) 40%, transparent)"
      : success
        ? "color-mix(in oklch, var(--ok) 40%, transparent)"
        : danger
          ? "color-mix(in oklch, var(--danger) 40%, transparent)"
          : "var(--rule)";
  const frameGlow = accent
    ? "var(--lift-hi), 0 0 0 1px var(--rule-soft), 0 0 14px var(--accent-glow)"
    : warn
      ? "var(--lift-hi), 0 0 0 1px var(--rule-soft), 0 0 14px color-mix(in oklch, var(--warn) 30%, transparent)"
      : success
        ? "var(--lift-hi), 0 0 0 1px var(--rule-soft), 0 0 14px color-mix(in oklch, var(--ok) 30%, transparent)"
        : danger
          ? "var(--lift-hi), 0 0 0 1px var(--rule-soft), 0 0 14px color-mix(in oklch, var(--danger) 30%, transparent)"
          : "var(--lift-hi), 0 0 0 1px var(--rule-soft)";
  return (
    <div
      className="spark-fade-in"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${label} ${tone.status}`}
      style={{
        position: "absolute",
        top: 6,
        left: 8,
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        // Reserve the right-anchored toolbar's footprint so the chip can never
        // reach the toolbar at minimum pane width, with a max() floor so a very
        // narrow pane clamps the box to a sane minimum instead of 0 (which let
        // a nowrap label overflow into the toolbar). The label span — not this
        // container — owns the ellipsis, so the live dot's glow is never
        // clipped.
        maxWidth: "max(80px, calc(100% - 180px))",
        minWidth: 0,
        whiteSpace: "nowrap",
        // Earned mild-glass chip: a panel veil over the terminal canvas so
        // the label stays legible without baking white/black (which invert
        // on the light themes).
        background: "color-mix(in oklab, var(--panel-2) 82%, transparent)",
        // Glows live, calms when done: a working worker carries the accent
        // (edge + text + halo), a blocked one carries amber to flag it needs
        // you, and an idle / finished one drops to a neutral --rule border +
        // --ink-dim text + no glow so it stops reading as live.
        border: `1px solid ${frameEdge}`,
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        color: frameColor,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        boxShadow: frameGlow,
        pointerEvents: "none",
        zIndex: 5,
        animationDuration: "var(--motion-fast)",
        transition:
          "color var(--motion) var(--ease-out), border-color var(--motion) var(--ease-out), box-shadow var(--motion) var(--ease-out)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          flex: "0 0 auto",
          background: tone.dot,
          boxShadow: tone.dotGlow,
          animation: tone.pulse ? "spark-pulse 1.8s var(--ease-out) infinite" : undefined,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
        {label}
      </span>
      {/* Status word as a quieter eyebrow: smaller, more tracking so the
          runtime label leads and the state reads as a subordinate tag. Inherits
          the frame colour on accent / warn so "waiting for you" pops amber. */}
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.14em",
          color: toned ? "currentcolor" : "var(--muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {tone.status}
      </span>
    </div>
  );
}

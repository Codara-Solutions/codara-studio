import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AppState,
  FsEntry,
  RunState,
  ShellInfo,
  SparkEvent,
  Workspace,
} from "@shared/types";
import { makeId } from "@shared/ids";
import WindowChrome from "./components/WindowChrome";
import WorkspaceRail, { WORKSPACE_COLORS } from "./components/WorkspaceRail";
import StatusBar from "./components/StatusBar";
import SettingsDialog from "./components/SettingsDialog";
import SessionInspector from "./components/SessionInspector";
import AgentCapabilitiesDialog from "./components/AgentCapabilitiesDialog";
import UpdateBanner from "./components/UpdateBanner";
import SearchPanel from "./components/Search/SearchPanel";
import FileSearchPanel from "./components/Search/FileSearchPanel";
import ToastHost from "./components/Toast";
import { playNotificationSound } from "./components/notification-sounds";
import TabBar from "./tabs/TabBar";
import ChatStack from "./tabs/ChatStack";
import EditorStack from "./tabs/EditorStack";
import TerminalStack from "./tabs/TerminalStack";
import PreviewStack from "./tabs/PreviewStack";
import RunsStack from "./tabs/RunsStack";
import { useTabs } from "./tabs/useTabs";
import type { TerminalPaneDragPayload } from "./tabs/terminalDrag";
import type { PaneNode, Tab, TabId, TerminalLeaf } from "./tabs/types";
import { basename } from "./path-utils";
import ShortcutsDialog from "./shortcuts/ShortcutsDialog";
import { useGlobalShortcuts, type ShortcutHandlers } from "./shortcuts/useGlobalShortcuts";
import { buildBindingTable } from "./shortcuts/bindings";
import { isRecording } from "./shortcuts/recording";
import { usePreferences } from "./preferences/usePreferences";
import {
  CLAUDE_LAUNCH_COMMAND,
  CODEX_LAUNCH_COMMAND,
  CURSOR_LAUNCH_COMMAND,
} from "./workers/launch-commands";
import { usePanelLayout, type PanelSectionKey, type PanelSide } from "./panels/usePanelLayout";
import ResizeHandle from "./panels/ResizeHandle";
import {
  SelectionRoutingProvider,
  type RoutingDestination,
  type SelectionPayload,
  type SelectionRoutingApi,
} from "./routing/SelectionRoutingContext";
import {
  enumerateOpenWorkers,
  workerMenuLabel,
} from "./routing/enumerate-open-workers";

const DEFAULT_SETTINGS: AppSettings = {
  defaultShellId: null,
  openRouterApiKey: "",
  openRouterModel: "google/gemini-flash-latest",
  langSmithApiKey: "",
  langSmithProject: "spark-agent-dev",
  langSmithEndpoint: "https://api.smith.langchain.com",
  agentRuntimeSelection: "auto",
  agentMcpSyncEnabled: true,
  agentSkillSyncEnabled: true,
  agentDisabledMcpIds: [],
  agentDisabledSkillIds: [],
};

function resolveDefaultShell(
  shells: ShellInfo[],
  settings: AppSettings,
  detectedDefault: ShellInfo | null,
): ShellInfo | null {
  return shells.find((shell) => shell.id === settings.defaultShellId) ?? detectedDefault ?? shells[0] ?? null;
}

function entryFromPath(path: string): FsEntry {
  const segments = path.split(/[\\/]/);
  const name = segments[segments.length - 1] || path;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
  return { name, path, isDir: false, ext };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a === b;
  }
}

function isBrowserUrl(url: string): boolean {
  return /^(https?:|file:)/i.test(url);
}

function collectTerminalPaneIds(node: PaneNode, ids: Set<string>): void {
  if (node.kind === "leaf") {
    ids.add(node.paneId);
    return;
  }
  collectTerminalPaneIds(node.a, ids);
  collectTerminalPaneIds(node.b, ids);
}

function disposeTerminalPanesInTabs(tabs: Tab[]): void {
  const paneIds = new Set<string>();
  for (const tab of tabs) {
    if (tab.kind === "terminal") collectTerminalPaneIds(tab.root, paneIds);
  }
  for (const paneId of paneIds) {
    void window.spark.pty.dispose(paneId).catch(() => undefined);
  }
}

function disposePersistedWorkspaceTerminalPanes(workspaceId: string): void {
  try {
    const raw = window.localStorage.getItem(`spark.tabs:${workspaceId}`);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { tabs?: Tab[] };
    if (Array.isArray(parsed.tabs)) disposeTerminalPanesInTabs(parsed.tabs);
  } catch {
    /* best-effort cleanup only */
  }
}

function findLeafByPaneId(node: PaneNode, paneId: string): TerminalLeaf | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeafByPaneId(node.a, paneId) ?? findLeafByPaneId(node.b, paneId);
}

function countRunningWorkerLeaves(node: PaneNode): number {
  if (node.kind === "leaf") {
    return node.worker?.state === "running" && node.worker.agentRunning !== false ? 1 : 0;
  }
  return countRunningWorkerLeaves(node.a) + countRunningWorkerLeaves(node.b);
}

function countRunningTerminalWorkers(tabs: Tab[]): number {
  return tabs.reduce(
    (count, tab) => count + (tab.kind === "terminal" ? countRunningWorkerLeaves(tab.root) : 0),
    0,
  );
}

export default function App() {
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [runCountsByWorkspace, setRunCountsByWorkspace] = useState<Record<string, number>>({});
  // Runs for the currently active workspace, plus the user's selection. Lifted
  // here so the workbench RunsView and Spark chat tab both read from the same
  // source of truth: picking a chat updates the graph, deleting a chat removes
  // it everywhere.
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // Each workspace has its own Spark chat selection. The visible state stays
  // as a single activeRunId, but this map lets workspace switches restore the
  // previous chat instead of inheriting another workspace's draft/new-chat UI.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;
  const activeRunIdsByWorkspaceRef = useRef<Record<string, string | null>>({});
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [defaultShell, setDefaultShell] = useState<ShellInfo | null>(null);
  const [detectedDefaultShell, setDetectedDefaultShell] = useState<ShellInfo | null>(null);
  // Default shell augmented with the bundled OSC 7/133/633/8888 shell
  // integration. Used as the launch profile for terminal tabs so a fresh
  // interactive pane reports cwd/prompt/open-file events to the renderer.
  const [integratedShell, setIntegratedShell] = useState<ShellInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  // Pure renderer overlay — reads the active run, displays cost / events /
  // context-window / failure tabs. Toggled via the `session.openInspector`
  // shortcut (Mod+Shift+I).
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [platform, setPlatform] = useState<string>("");
  const [home, setHome] = useState<string>("");
  // Side-panel layout: outer widths, internal split ratios, per-section
  // collapse. Persisted globally. Mirrored through a ref so the resize-drag
  // callbacks can read the latest widths at drag start with a stable identity.
  const panels = usePanelLayout();
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const [draggingPanelSection, setDraggingPanelSection] = useState<PanelSectionKey | null>(null);
  const saveTimer = useRef<number | null>(null);
  // Trailing-debounce timer for the orchestration-event → listRuns refresh.
  // A single run emits a burst of events (planning → running → many worker
  // lifecycle events → reviewing → complete); refreshing on every one would
  // fire dozens of IPC round-trips. We coalesce a burst into one refresh.
  const runRefreshTimer = useRef<number | null>(null);
  const processedSpawnTerminalEventsRef = useRef<Set<string>>(new Set());
  // Set of workspace ids that received an orchestration event since the last
  // debounced flush — so the flush refreshes counts for exactly the affected
  // workspaces (not a blanket re-list of everything).
  const runRefreshPendingRef = useRef<Set<string>>(new Set());
  // Live state per terminal-tab leaf: most recent OSC 7 cwd and the timestamp
  // of the latest PTY activity. Used by the orchestration claim logic to
  // decide whether a user pane is "doing nothing" and therefore safe to take
  // over for a new worker. Held in a ref so per-byte activity callbacks
  // don't trigger React re-renders.
  const paneRuntimeRef = useRef<Map<string, { cwd?: string; lastActivityAt: number }>>(
    new Map(),
  );
  const handlePaneCwd = useCallback(
    (tabId: string, paneId: string, cwd: string) => {
      const entry = paneRuntimeRef.current.get(paneId) ?? { lastActivityAt: 0 };
      entry.cwd = cwd;
      paneRuntimeRef.current.set(paneId, entry);
      // Mirror into the persisted leaf state so a reload remembers the cwd
      // and the smart-add picker can read it without a live OSC 7 round-trip.
      tabsRef.current?.setLeafCwd(tabId, paneId, cwd);
    },
    [],
  );
  const handlePaneActivity = useCallback((_tabId: string, paneId: string) => {
    const entry = paneRuntimeRef.current.get(paneId) ?? { lastActivityAt: 0 };
    entry.lastActivityAt = Date.now();
    paneRuntimeRef.current.set(paneId, entry);
  }, []);

  const handlePaneScrollback = useCallback(
    (tabId: string, paneId: string, scrollback: string) => {
      tabsRef.current?.setLeafScrollback(tabId, paneId, scrollback);
    },
    [],
  );

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  // Tabs are scoped per-workspace so each workspace remembers its own layout.
  // useTabs internally swaps tab lists when the workspaceId argument changes.
  const tabs = useTabs(activeId, activeWorkspace?.cwd);
  const visibleWorkbenchTabs = useMemo(
    () => tabs.tabs.filter((tab) => isTabVisibleForRun(tab, activeRunId)),
    [tabs.tabs, activeRunId],
  );
  const activeVisibleTabId = useMemo(() => {
    if (tabs.activeId && visibleWorkbenchTabs.some((tab) => tab.id === tabs.activeId)) {
      return tabs.activeId;
    }
    return visibleWorkbenchTabs[0]?.id ?? null;
  }, [tabs.activeId, visibleWorkbenchTabs]);

  // useTabs returns a fresh object every render, which would force any
  // useCallback/useEffect that depends on `tabs` to re-run on every render.
  // We mirror it through a ref so the run-selection callbacks stay stable
  // and the auto-reopen effect only fires when its real input (runs)
  // actually changes.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Mirror the runs list through a ref so run-selection callbacks can read
  // the latest chat titles without taking `runs` as a dependency.
  const runsRef = useRef(runs);
  runsRef.current = runs;

  const handleRunSnapshot = useCallback(
    (
      run: RunState,
      options?: { select?: boolean; focusRuns?: boolean },
    ) => {
      setRuns((current) => {
        if (run.workspaceId !== activeIdRef.current) return current;
        const withoutRun = current.filter((item) => item.id !== run.id);
        const next = [run, ...withoutRun];
        next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return next;
      });

      if (!options?.select) return;
      const workspaceId = run.workspaceId;
      activeRunIdsByWorkspaceRef.current[workspaceId] = run.id;
      activeRunIdRef.current = run.id;
      setActiveRunId(run.id);
      if (workspaceId !== activeIdRef.current) return;
      const focusRuns = options.focusRuns ?? false;
      tabsRef.current.openRunsTab(run.id, "Runs", focusRuns);
      if (!focusRuns) tabsRef.current.openChatTab({ focus: true });
    },
    [],
  );

  const handleSelectRun = useCallback(
    (
      runId: string | null,
      workspaceId?: string | null,
      options?: { focus?: "chat" | "runs" | "none" },
    ) => {
      const targetWorkspaceId = workspaceId ?? activeIdRef.current;
      if (targetWorkspaceId) {
        activeRunIdsByWorkspaceRef.current[targetWorkspaceId] = runId;
      }
      activeRunIdRef.current = runId;
      setActiveRunId(runId);
      if (targetWorkspaceId !== activeIdRef.current) return;
      const focus = options?.focus ?? "chat";
      if (runId === null) {
        tabsRef.current.hideRunsTabs();
        if (focus === "chat") tabsRef.current.openChatTab({ focus: true });
        return;
      }
      tabsRef.current.openRunsTab(runId, "Runs", focus === "runs");
      if (focus === "chat") tabsRef.current.openChatTab({ focus: true });
    },
    [],
  );

  // Keep the active chat's node-graph tab in existence without stealing
  // focus — handleSelectRun focuses it on explicit navigation; this only
  // guarantees the tab survives a reload and keeps its label synced to the
  // run title. A live run emitting events therefore can't yank the user off
  // an editor tab.
  useEffect(() => {
    if (!activeRunId) {
      tabsRef.current.hideRunsTabs();
      return;
    }
    tabsRef.current.openRunsTab(activeRunId, "Runs", false);
  }, [activeRunId, runs]);

  // Mirror the workbench selection back into the active chat: clicking a
  // chat's node-graph tab makes the Spark chat tab follow along.
  useEffect(() => {
    const tab = tabs.activeTab;
    if (tab && tab.kind === "runs" && tab.runId) {
      const runId = tab.runId;
      const workspaceId = activeIdRef.current;
      if (workspaceId) activeRunIdsByWorkspaceRef.current[workspaceId] = runId;
      activeRunIdRef.current = runId;
      setActiveRunId((current) => (current === runId ? current : runId));
    }
  }, [tabs.activeTab]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [state, appSettings, sh, def, plat, hm] = await Promise.all([
          window.spark.state.load(),
          window.spark.settings.load(),
          window.spark.shells.list(),
          window.spark.shells.default(),
          window.spark.app.platform(),
          window.spark.app.home(),
        ]);
        if (cancelled) return;
        setWorkspaces(state.workspaces);
        setActiveId(state.activeWorkspaceId);
        setSettings(appSettings);
        setShells(sh);
        setDetectedDefaultShell(def);
        setDefaultShell(resolveDefaultShell(sh, appSettings, def));
        setPlatform(plat);
        setHome(hm);
        setBooted(true);
      } catch (err) {
        setBootError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Resolve the integrated-shell launch profile lazily. Materializing the
  // bundled scripts touches the user's home directory; no need to block
  // initial paint on it. A failure here just means the strip falls back to
  // the orchestration default shell, which still works (without inline
  // OSC 7/8888 from a Unix shell). Re-runs once `home` is known so the
  // call is gated on the main process having a usable HOME.
  useEffect(() => {
    if (!booted) return;
    let cancelled = false;
    (async () => {
      try {
        const shell = await window.spark.shells.integratedDefault();
        if (!cancelled) setIntegratedShell(shell);
      } catch {
        /* fall back to defaultShell */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [booted]);

  // Persist on change (debounced)
  useEffect(() => {
    if (!booted) return;
    if (saveTimer.current !== null) {
      window.clearTimeout(saveTimer.current);
    }
    saveTimer.current = window.setTimeout(() => {
      const state: AppState = { workspaces, activeWorkspaceId: activeId };
      void window.spark.state.save(state);
    }, 200);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [workspaces, activeId, booted]);

  // Close editor when rail hidden — kept for parity with old behaviour.
  useEffect(() => {
    if (!showLeft) setEditingId(null);
  }, [showLeft]);

  const workspaceIdsKey = useMemo(() => workspaces.map((w) => w.id).join("\0"), [workspaces]);
  // Comma-joined sorted list of workspace cwds. Used as a stable dep for the
  // setAllowedRoots push so we only re-send when the actual cwd set changes
  // (renaming a workspace's color, for instance, must not re-fire the IPC).
  const workspaceCwdsKey = useMemo(
    () =>
      workspaces
        .map((w) => w.cwd)
        .filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0)
        .slice()
        .sort()
        .join("\0"),
    [workspaces],
  );

  // Push the renderer's set of active workspace cwds to main so the fs:*
  // read handlers know which paths are in scope. Main treats this list as the
  // authoritative source of allowed workspace roots; if the renderer never
  // calls this, only the static CLI/config dirs in fs-sandbox.ts remain
  // reachable — that's the safe default for a fresh boot.
  useEffect(() => {
    if (!booted) return;
    const cwds = workspaceCwdsKey ? workspaceCwdsKey.split("\0").filter((c) => c.length > 0) : [];
    void window.spark.ui?.setAllowedRoots(cwds).catch(() => {
      /* sandbox push is best-effort; failures only restrict reachable reads */
    });
  }, [booted, workspaceCwdsKey]);

  const refreshRunCount = useCallback(async (workspaceId: string) => {
    try {
      const runs = await window.spark.orchestration.listRuns(workspaceId);
      setRunCountsByWorkspace((current) => ({
        ...current,
        [workspaceId]: runs.length,
      }));
    } catch {
      /* The Runs view will surface detailed orchestration errors. */
    }
  }, []);

  // Refresh the lifted runs list for whichever workspace is active right now.
  // Reads activeId via the closure, so wrap the body in a function that takes
  // the workspaceId explicitly to avoid stale-closure issues in subscriptions.
  const refreshRunsFor = useCallback(async (workspaceId: string | null) => {
    if (!workspaceId) {
      setRuns([]);
      return;
    }
    try {
      const next = await window.spark.orchestration.listRuns(workspaceId);
      setRuns(next);
    } catch {
      /* Surface details elsewhere; this is opportunistic. */
    }
  }, []);

  // Initial load + reload on workspace change. Run selection is scoped per
  // workspace, so coming back to a project restores the chat the user was
  // reading there instead of inheriting another workspace's draft/new-chat
  // state.
  useEffect(() => {
    if (!booted) return;
    const remembered =
      activeId && Object.prototype.hasOwnProperty.call(activeRunIdsByWorkspaceRef.current, activeId)
        ? activeRunIdsByWorkspaceRef.current[activeId]
        : null;
    activeRunIdRef.current = remembered;
    setActiveRunId((current) => (current === remembered ? current : remembered));
    void refreshRunsFor(activeId);
  }, [activeId, booted, refreshRunsFor]);

  // When the runs list changes, reconcile the active selection. A null
  // selection is intentional now (the draft/new-chat state), so don't jump
  // into the latest run unless the user actually had a selected chat that
  // disappeared.
  useEffect(() => {
    setActiveRunId((current) => {
      const workspaceId = activeIdRef.current;
      if (!workspaceId) {
        activeRunIdRef.current = null;
        return null;
      }
      if (!current) {
        activeRunIdsByWorkspaceRef.current[workspaceId] = null;
        activeRunIdRef.current = null;
        return null;
      }
      if (current && runs.some((run) => run.id === current)) {
        activeRunIdsByWorkspaceRef.current[workspaceId] = current;
        activeRunIdRef.current = current;
        return current;
      }
      const live = runs.find((run) =>
        ["planning", "running", "reviewing", "blocked", "paused"].includes(run.status),
      );
      const fallback = live?.id ?? runs[0]?.id ?? null;
      activeRunIdsByWorkspaceRef.current[workspaceId] = fallback;
      activeRunIdRef.current = fallback;
      return fallback;
    });
  }, [runs]);

  useEffect(() => {
    if (!booted) return;
    // Derive the id list from `workspaceIdsKey` (the only input that actually
    // matters here) rather than depending on the `workspaces` array itself —
    // `workspaces` gets a new reference on every color edit / worker update,
    // which would needlessly re-fire N listRuns IPC calls. The key changes
    // only when a workspace is added/removed/reordered, which is exactly when
    // the per-workspace run counts need a full refresh.
    const ids = workspaceIdsKey ? workspaceIdsKey.split("\0") : [];
    if (ids.length === 0) {
      setRunCountsByWorkspace({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      ids.map(async (id) => [id, (await window.spark.orchestration.listRuns(id)).length] as const),
    ).then((entries) => {
      if (cancelled) return;
      setRunCountsByWorkspace(Object.fromEntries(entries));
    }).catch(() => {
      /* Counts are only for tab visibility; failures should not block boot. */
    });
    return () => {
      cancelled = true;
    };
  }, [booted, workspaceIdsKey]);

  useEffect(() => {
    if (!booted) return undefined;

    // Trailing-debounce window. A burst of orchestration events (a run going
    // planning → running → N worker events → complete) collapses into a
    // single refresh once events stop arriving for this long.
    const RUN_REFRESH_DEBOUNCE_MS = 250;

    // Drain the pending-workspace set: refresh the run count for every
    // workspace that saw an event, and the lifted runs list if the currently
    // active workspace was among them. Reads activeId via the ref so this is
    // always against the workspace on screen *now*, not whenever the listener
    // was registered.
    const flushRunRefresh = (): void => {
      runRefreshTimer.current = null;
      const pending = runRefreshPendingRef.current;
      if (pending.size === 0) return;
      const workspaceIds = Array.from(pending);
      pending.clear();
      const currentActiveId = activeIdRef.current;
      for (const workspaceId of workspaceIds) {
        void refreshRunCount(workspaceId);
        if (workspaceId === currentActiveId) {
          void refreshRunsFor(workspaceId);
        }
      }
    };

    return window.spark.orchestration.onEvent((event) => {
      if (!event.workspaceId) return;
      // Record the affected workspace and (re)arm the trailing timer. The
      // active workspace's runs/counts still update — just batched into one
      // refresh per burst rather than one per event.
      runRefreshPendingRef.current.add(event.workspaceId);
      if (runRefreshTimer.current !== null) {
        window.clearTimeout(runRefreshTimer.current);
      }
      runRefreshTimer.current = window.setTimeout(flushRunRefresh, RUN_REFRESH_DEBOUNCE_MS);

      // A deletion can race with the orchestration runner still flushing the
      // run file; a delayed second pass picks up the settled state. We just
      // re-mark the workspace ~500ms later so the regular debounced flush
      // re-lists it once things have quiesced.
      if (event.type === "run.deleted") {
        if (event.runId) {
          tabsRef.current.closeRunsTabFor(event.runId);
          tabsRef.current.closeWorkerTerminalTabFor(event.runId);
        }
        const deletedWorkspaceId = event.workspaceId;
        window.setTimeout(() => {
          runRefreshPendingRef.current.add(deletedWorkspaceId);
          if (runRefreshTimer.current !== null) {
            window.clearTimeout(runRefreshTimer.current);
          }
          runRefreshTimer.current = window.setTimeout(flushRunRefresh, RUN_REFRESH_DEBOUNCE_MS);
        }, 500);
      }

      // A spawn_terminals decision: Spark opened interactive terminals for
      // the user to drive. Each request gets a fresh numbered terminal tab
      // so it doesn't disturb whatever terminal layout the user already has.
      if (event.type === "spark.spawn_terminals") {
        if (processedSpawnTerminalEventsRef.current.has(event.id)) return;
        processedSpawnTerminalEventsRef.current.add(event.id);
        const payload = event.payload as
          | { terminals?: Array<{ command?: unknown; runtime?: unknown }> }
          | undefined;
        const cwd = workspacesRef.current.find(
          (w) => w.id === event.workspaceId,
        )?.cwd;
        const specs = (payload?.terminals ?? [])
          .map((spec) => ({
            command: typeof spec.command === "string" ? spec.command : "",
            runtime: typeof spec.runtime === "string" ? spec.runtime : "",
          }))
          .filter((spec) => spec.command.length > 0);
        if (specs.length > 0) {
          window.setTimeout(() => {
            window.requestAnimationFrame(() => {
              tabsRef.current.newTerminalGrid(cwd, specs);
            });
          }, 0);
        }
      }
    });
  }, [booted, refreshRunCount, refreshRunsFor]);

  // Clear the run-refresh debounce timer on unmount so a pending flush can't
  // fire into an unmounted tree.
  useEffect(() => {
    return () => {
      if (runRefreshTimer.current !== null) {
        window.clearTimeout(runRefreshTimer.current);
        runRefreshTimer.current = null;
      }
    };
  }, []);

  // Subscribe to renderer-side notification channels. The toast channel is
  // owned by <ToastHost/> below; this effect handles the embedded-sound
  // channel by playing the right WAV clip whenever main fires
  // "notification:sound". The main process has already filtered against
  // the user's preferences before sending — by the time we get here, the
  // user has the sound channel enabled, so we just play.
  useEffect(() => {
    const off = window.spark.notifications.onNotificationSound(({ kind }) => {
      playNotificationSound(kind);
    });
    return () => off();
  }, []);

  // Theme the entire UI with the active workspace's color. Falls back to the
  // default yellow when nothing is active.
  useEffect(() => {
    const accent = activeWorkspace?.color || "#F0C419";
    document.documentElement.style.setProperty("--accent", accent);
  }, [activeWorkspace?.color]);

  // Open the unified in-app SettingsDialog when any part of the app
  // dispatches the `spark:open-settings` window event. Previously this
  // routed to a dedicated Settings BrowserWindow (still on disk under
  // src/renderer/settings); we fold both surfaces into the polished old
  // dialog so users only see one settings UI.
  useEffect(() => {
    const handler = () => {
      setSettingsOpen(true);
    };
    window.addEventListener("spark:open-settings", handler);
    return () => window.removeEventListener("spark:open-settings", handler);
  }, []);

  // Mirror the workspaces list through a ref so the orchestration listener
  // doesn't re-subscribe on every workspace state change (which is often
  // — runs trigger updates).
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;

  // When the orchestration runner emits `envelope_prepared`, the worker is
  // about to start and is waiting for a renderer-side PTY at sessionId =
  // attemptId. Spark workers live in one run-scoped terminal tab titled
  // "workers" instead of claiming arbitrary user shells. The tab stays mounted
  // across chat switches so PTYs continue running, but the tab strip only
  // reveals it while its run is the active chat.
  useEffect(() => {
    if (!booted) return;

    const handleEnvelopePrepared = async (event: SparkEvent) => {
      if (event.type !== "worker_task.envelope_prepared") return;
      if (!event.runId || !event.workerTaskId || !event.attemptId) return;
      if (!event.workspaceId) return;

      const ws = workspacesRef.current.find((w) => w.id === event.workspaceId);
      if (!ws) return;
      const workspaceCwd = ws.cwd;

      // Pull the runtime so the worker chip shows CLAUDE/CODEX/CURSOR. Best-effort —
      // the chip is decoration; the PTY claim itself doesn't depend on it.
      let runtime: "claude" | "codex" | "cursor" | undefined;
      try {
        const run = await window.spark.orchestration.getRun(event.runId);
        const task = run?.workerTasks.find((item) => item.id === event.workerTaskId);
        if (
          task?.runtimePreference === "claude" ||
          task?.runtimePreference === "codex" ||
          task?.runtimePreference === "cursor"
        ) {
          runtime = task.runtimePreference;
        }
      } catch {
        /* runtime is decorative */
      }

      const workerMeta = {
        runtime,
        runId: event.runId,
        workerTaskId: event.workerTaskId,
        attemptId: event.attemptId,
        source: "spark" as const,
        state: "running" as const,
      };

      const t = tabsRef.current;
      if (!t) return;
      const tabId = t.ensureWorkerTerminalTab(event.runId, workspaceCwd, event.attemptId, workerMeta, {
        focus: false,
      });
      t.setLeafCwd(tabId, event.attemptId, workspaceCwd);
      t.setActiveTerminalPane(tabId, event.attemptId);
    };

    // Mark the worker pane "done" on attempt finish — keeps the xterm
    // visible (so the user can read the report) but releases the leaf so
    // the next worker can claim it.
    const handleAttemptFinished = (event: SparkEvent) => {
      if (event.type !== "worker_attempt.finished") return;
      const attemptId = event.attemptId;
      if (!attemptId) return;
      const t = tabsRef.current;
      if (!t) return;
      for (const tab of t.tabs) {
        if (tab.kind !== "terminal") continue;
        const leaf = findLeafByPaneId(tab.root, attemptId);
        if (leaf) {
          const prior = leaf.worker;
          t.setLeafWorker(tab.id, attemptId, {
            runtime: prior?.runtime,
            runId: event.runId ?? prior?.runId ?? "",
            workerTaskId: event.workerTaskId ?? prior?.workerTaskId ?? "",
            attemptId,
            source: "spark",
            state: "done",
            agentRunning: prior?.agentRunning,
          });
          break;
        }
      }
    };

    return window.spark.orchestration.onEvent((event) => {
      void handleEnvelopePrepared(event);
      handleAttemptFinished(event);
    });
  }, [booted]);

  // WorkspaceRail prop callbacks. `setActiveId` / `setEditingId` are stable
  // React setters, so these can carry empty dep arrays and stay referentially
  // stable for the lifetime of the component — which lets the React.memo on
  // WorkspaceRail actually skip renders.
  const handleActivateWorkspace = useCallback((id: string) => {
    const currentWorkspaceId = activeIdRef.current;
    if (currentWorkspaceId) {
      activeRunIdsByWorkspaceRef.current[currentWorkspaceId] = activeRunIdRef.current;
    }
    setActiveId(id);
  }, []);

  const handleEditWorkspace = useCallback((id: string) => {
    setEditingId((prev) => (prev === id ? null : id));
  }, []);

  const handleCloseWorkspaceEditor = useCallback(() => {
    setEditingId(null);
  }, []);

  // WindowChrome prop callbacks — hoisted to stable references so the
  // React.memo on WindowChrome can skip re-renders triggered by unrelated
  // App state churn (color edits, orchestration events, run polls).
  const handleToggleLeft = useCallback(() => {
    setShowLeft((v) => !v);
  }, []);

  const handleToggleRight = useCallback(() => {
    setShowRight((v) => !v);
  }, []);

  // Panel resize: snapshot the panel's current width when a drag starts, then
  // translate the pointer delta the ResizeHandle reports into a new width.
  // usePanelLayout clamps, so an over-drag is harmless.
  const leftWidthAtDragStart = useRef(0);
  const rightWidthAtDragStart = useRef(0);
  const handleLeftWidthStart = useCallback(() => {
    leftWidthAtDragStart.current = panelsRef.current.leftWidth;
  }, []);
  const handleLeftWidthResize = useCallback((delta: number) => {
    panelsRef.current.setLeftWidth(leftWidthAtDragStart.current + delta);
  }, []);
  const handleRightWidthStart = useCallback(() => {
    rightWidthAtDragStart.current = panelsRef.current.rightWidth;
  }, []);
  const handleRightWidthResize = useCallback((delta: number) => {
    // The right handle sits on the panel's inner edge, so dragging left (a
    // negative delta) widens the panel.
    panelsRef.current.setRightWidth(rightWidthAtDragStart.current - delta);
  }, []);
  const togglePanelSection = useCallback((section: PanelSectionKey) => {
    panelsRef.current.toggleCollapse(section);
  }, []);
  const movePanelSection = useCallback((section: PanelSectionKey, side: PanelSide, index: number) => {
    panelsRef.current.moveSection(section, side, index);
  }, []);
  const handlePanelSectionDragStart = useCallback((section: PanelSectionKey) => {
    setDraggingPanelSection(section);
  }, []);
  const handlePanelSectionDragEnd = useCallback(() => {
    setDraggingPanelSection(null);
  }, []);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const handleOpenCapabilities = useCallback(() => {
    setCapabilitiesOpen(true);
  }, []);

  // Dialog onClose handlers hoisted to stable refs so the memoized dialog
  // components don't see a fresh arrow on every App render.
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);
  const closeCapabilities = useCallback(() => {
    setCapabilitiesOpen(false);
  }, []);
  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);
  const closeFileSearch = useCallback(() => {
    setFileSearchOpen(false);
  }, []);
  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
  }, []);

  // Dialog onSave / onOpenRun / onOpenFile handlers hoisted so the dialogs
  // and search panel keep stable prop identities across App renders.
  const handleSaveSettings = useCallback(
    async (nextSettings: AppSettings) => {
      const saved = await window.spark.settings.save(nextSettings);
      setSettings(saved);
      setDefaultShell(resolveDefaultShell(shells, saved, detectedDefaultShell));
    },
    [shells, detectedDefaultShell],
  );
  const handleSettingsOpenRun = useCallback(
    (runId: string, workspaceId: string) => {
      if (workspaces.some((w) => w.id === workspaceId)) {
        setActiveId(workspaceId);
      }
      handleSelectRun(runId, workspaceId);
      setSettingsOpen(false);
    },
    [workspaces, handleSelectRun],
  );

  useEffect(() => {
    window.addEventListener("spark:open-capabilities", handleOpenCapabilities);
    return () => window.removeEventListener("spark:open-capabilities", handleOpenCapabilities);
  }, [handleOpenCapabilities]);

  const updateWs = useCallback((id: string, patch: Partial<Workspace>) => {
    setWorkspaces((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }, []);

  const reorderWs = useCallback((fromIndex: number, toIndex: number) => {
    setWorkspaces((list) => {
      if (
        fromIndex < 0 ||
        fromIndex >= list.length ||
        toIndex < 0 ||
        toIndex > list.length
      ) {
        return list;
      }
      const next = list.slice();
      const [moved] = next.splice(fromIndex, 1);
      const adjusted = toIndex > fromIndex ? toIndex - 1 : toIndex;
      next.splice(adjusted, 0, moved);
      // No-op if nothing actually moved (preserve referential equality so memoized
      // children don't re-render).
      let changed = false;
      for (let i = 0; i < list.length; i += 1) {
        if (list[i].id !== next[i].id) {
          changed = true;
          break;
        }
      }
      return changed ? next : list;
    });
  }, []);

  const previewWsColor = useCallback((id: string, color: string) => {
    if (activeIdRef.current !== id) return;
    document.documentElement.style.setProperty("--accent", color);
  }, []);

  const deleteWs = useCallback((id: string) => {
    delete activeRunIdsByWorkspaceRef.current[id];
    if (activeIdRef.current === id) {
      disposeTerminalPanesInTabs(tabsRef.current.tabs);
    } else {
      disposePersistedWorkspaceTerminalPanes(id);
    }
    setWorkspaces((ws) => {
      const next = ws.filter((w) => w.id !== id);
      // dispose pty for any workers in deleted workspace
      const removed = ws.find((w) => w.id === id);
      if (removed) {
        for (const worker of removed.workers) {
          void window.spark.pty.dispose(worker.id);
        }
      }
      // Adjust active
      setActiveId((prev) => (prev === id ? next[0]?.id ?? null : prev));
      return next;
    });
    setEditingId(null);
  }, []);

  const createWs = useCallback(async () => {
    const path = await window.spark.dialog.openDirectory(activeWorkspace?.cwd || home);
    if (!path) return;
    const usedColors = new Set(workspaces.map((w) => w.color.toLowerCase()));
    const color = WORKSPACE_COLORS.find((c) => !usedColors.has(c.toLowerCase())) ?? WORKSPACE_COLORS[0];
    const ws: Workspace = {
      id: makeId("ws"),
      name: basename(path) || "workspace",
      cwd: path,
      color,
      workers: [],
    };
    setWorkspaces((list) => [...list, ws]);
    activeRunIdsByWorkspaceRef.current[ws.id] = null;
    setActiveId(ws.id);
    setEditingId(ws.id);
  }, [workspaces, activeWorkspace, home]);

  // ── File / editor tab integration ──────────────────────────────────────────

  const openEditorFile = useCallback(
    (entry: FsEntry, options?: { preview?: boolean }) => {
      tabs.openEditorTab(entry, options);
    },
    [tabs],
  );

  // File/search panels: open the picked file then dismiss the panel.
  // Hoisted to keep panel prop identities stable across App renders.
  const handleSearchOpenFile = useCallback(
    (entry: FsEntry) => {
      openEditorFile(entry);
      setSearchOpen(false);
      setFileSearchOpen(false);
    },
    [openEditorFile],
  );

  // Explorer prop callbacks. Hoisted to stable references (keyed on the
  // now-stable `tabs` object) so the memoized side panels can skip re-renders
  // when only unrelated App state changed.
  const handleDeleteFile = useCallback(
    (path: string) => {
      tabs.closeEditorByPath(path);
    },
    [tabs],
  );

  const handleRenameFile = useCallback(
    (oldPath: string, entry: FsEntry) => {
      tabs.setEditorEntry(oldPath, entry);
    },
    [tabs],
  );

  // Right-click "Run plan" in the explorer: read the file and hand it to the
  // orchestrator as the plan for a brand-new chat, then select that chat so
  // its conversation and node-graph tab come forward.
  const handleRunPlan = useCallback(
    async (entry: FsEntry) => {
      const ws = activeWorkspace;
      if (!ws) return;
      try {
        const file = await window.spark.fs.readText(entry.path);
        const run = await window.spark.orchestration.startAutopilot({
          workspaceId: ws.id,
          workspaceName: ws.name,
          cwd: ws.cwd,
          planPath: entry.path,
          planTitle: entry.name,
          planText: file.content,
        });
        handleSelectRun(run.id);
        void refreshRunsFor(ws.id);
      } catch (err) {
        // A pre-run failure here is rare (the file vanished between the
        // right-click and the read); planning failures instead surface on
        // the run itself as a failed status with events in the chat.
        console.error("Run plan failed:", err);
      }
    },
    [activeWorkspace, refreshRunsFor, handleSelectRun],
  );

  // Open a file by absolute path. Used by the terminal's OSC 8888 handler
  // (`tp <file>` / `spark_open <file>` from a shell) and the Source Control
  // panel's "open file" action. Reads `tabs` via the ref so the callback stays
  // referentially stable — WorkspaceRail's React.memo depends on it.
  const openFileByPath = useCallback((path: string) => {
    if (!path) return;
    tabsRef.current.openEditorTab(entryFromPath(path));
  }, []);

  // ── Detected URL → preview tab ─────────────────────────────────────────────

  // Ports we auto-spawn a preview tab for when a terminal sniffs the URL on
  // its stdout. Anything else just shows the detected-URL chip in the
  // status bar (or the user can open via the Ports preset dropdown).
  const AUTO_PREVIEW_PORTS = useMemo(
    () => new Set([3000, 3001, 4173, 4200, 4321, 5173, 5174, 6006, 8000, 8080, 8888]),
    [],
  );

  // Per-terminal-tab "last URL we already opened" cache so a chatty dev
  // server printing its URL on every change doesn't spam preview tabs.
  const lastOpenedUrlByTerminalRef = useRef<Map<string, string>>(new Map());

  const handleDetectedUrl = useCallback(
    (tabId: string, paneId: string, url: string) => {
      tabs.setDetectedUrl(tabId, paneId, url);
      // Re-broadcast so other listeners (status bar, agent bridge) can
      // react without coupling directly to the terminal stack.
      window.dispatchEvent(
        new CustomEvent("spark:detected-url", {
          detail: { url, sessionId: paneId },
        }),
      );

      let port: number | null = null;
      try {
        const u = new URL(url);
        if (u.port) port = Number(u.port);
      } catch {
        return;
      }
      if (port === null || !AUTO_PREVIEW_PORTS.has(port)) return;

      // Suppress repeats for this pane pointing at the same origin — keyed
      // by paneId, not tabId, so two split panes running different dev
      // servers each get their own auto-preview.
      const last = lastOpenedUrlByTerminalRef.current.get(paneId);
      if (last && sameOrigin(last, url)) return;
      lastOpenedUrlByTerminalRef.current.set(paneId, url);

      // If a preview tab already shows the same origin, focus it instead
      // of stacking a duplicate — multi-tab parity with how editors dedupe
      // open paths.
      const existing = tabs.tabs.find(
        (t) => t.kind === "preview" && sameOrigin(t.url, url),
      );
      if (existing) {
        tabs.setActiveTab(existing.id);
        return;
      }
      tabs.newPreviewTab(url);
    },
    [AUTO_PREVIEW_PORTS, tabs],
  );

  // ── Tab toolbar handlers ───────────────────────────────────────────────────

  const handleNewTerminalTab = useCallback(() => {
    tabs.newTerminalTab(activeWorkspace?.cwd ?? undefined);
  }, [tabs, activeWorkspace?.cwd]);

  const handleNewBalancedTerminalPane = useCallback(() => {
    const active = tabs.tabs.find((t) => t.id === tabs.activeId);
    const target =
      active?.kind === "terminal"
        ? active
        : tabs.tabs.find((t) => t.kind === "terminal");
    if (!target || target.kind !== "terminal") {
      tabs.newTerminalTab(activeWorkspace?.cwd ?? undefined);
      return;
    }

    const paneId = makeId("pane");
    const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
    const cwd =
      paneRuntimeRef.current.get(target.activePaneId)?.cwd ??
      activeLeaf?.cwd ??
      activeWorkspace?.cwd ??
      undefined;
    const added = tabs.addBalancedPaneToTab(target.id, paneId, { cwd });
    if (added) {
      tabs.setActiveTab(target.id);
      tabs.setActiveTerminalPane(target.id, paneId);
      return;
    }

    tabs.newTerminalTab(cwd);
  }, [tabs, activeWorkspace?.cwd]);

  // Add a terminal pane that auto-launches the given CLI worker once the
  // shell prompt is ready. Worker keybinds should keep the user's current
  // terminal tab together instead of creating a separate terminal tab.
  const handleNewWorkerTab = useCallback(
    (autorun: string) => {
      const active = tabs.tabs.find((t) => t.id === tabs.activeId);
      const target =
        active?.kind === "terminal"
          ? active
          : tabs.tabs.find((t) => t.kind === "terminal");
      if (!target || target.kind !== "terminal") {
        tabs.newTerminalTab(activeWorkspace?.cwd ?? undefined, autorun);
        return;
      }

      const paneId = makeId("pane");
      const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
      const cwd =
        paneRuntimeRef.current.get(target.activePaneId)?.cwd ??
        activeLeaf?.cwd ??
        activeWorkspace?.cwd ??
        undefined;
      const added = tabs.addPaneInTab(target.id, paneId, { cwd, autorun });
      if (added) {
        tabs.setActiveTab(target.id);
        tabs.setActiveTerminalPane(target.id, paneId);
        return;
      }

      tabs.newTerminalTab(cwd, autorun);
    },
    [tabs, activeWorkspace?.cwd],
  );

  const handleNewEditorTab = useCallback(() => {
    setSearchOpen(false);
    setFileSearchOpen(true);
  }, []);

  const handleNewPreviewTab = useCallback(() => {
    // window.prompt is disabled in Electron renderers (returns null silently
    // since Electron 4), which is why the previous prompt-based flow looked
    // like "click does nothing." Open the tab empty instead — BrowserPane's
    // EmptyState plus the address bar at the top of AddressBar (which
    // auto-focuses on mount when the URL is empty) gives the user a place
    // to type without any modal.
    tabs.newPreviewTab("");
  }, [tabs]);

  const openInSparkBrowser = useCallback(
    (url: string) => {
      if (!isBrowserUrl(url)) return;
      const existing = tabs.tabs.find(
        (t) => t.kind === "preview" && (t.url === url || sameOrigin(t.url, url)),
      );
      if (existing) {
        tabs.setPreviewUrl(existing.id, url);
        tabs.setActiveTab(existing.id);
        return;
      }
      tabs.newPreviewTab(url);
    },
    [tabs],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const url = (event as CustomEvent<{ url?: unknown }>).detail?.url;
      if (typeof url === "string") openInSparkBrowser(url);
    };
    window.addEventListener("spark:open-browser-url", handler);
    return () => window.removeEventListener("spark:open-browser-url", handler);
  }, [openInSparkBrowser]);

  const handleTerminalPaneDropToTab = useCallback(
    (payload: TerminalPaneDragPayload, targetTabId?: string) => {
      if (targetTabId) {
        tabs.moveTerminalPane(payload.tabId, payload.paneId, targetTabId);
        return;
      }
      tabs.detachTerminalPaneToNewTab(payload.tabId, payload.paneId);
    },
    [tabs],
  );

  const handlePreviewUrlChange = useCallback(
    (id: string, url: string) => {
      // Reflect navigation back into the persisted tab state so a reload
      // restores the user where they were.
      tabs.setPreviewUrl(id, url);
    },
    [tabs],
  );

  // ── Global keyboard shortcuts ──────────────────────────────────────────────

  // Capture-phase + stopImmediatePropagation in useGlobalShortcuts ensures
  // these chords win over xterm/CodeMirror panes that would otherwise eat
  // the keystroke. Cross-module side-effects (focus the chat composer, ask
  // other panels to toggle) are broadcast as `spark:*` CustomEvents so
  // listeners can wire up without prop drilling.
  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "shortcuts.open": () => setShortcutsOpen((open) => !open),
      "settings.open": () => {
        setSettingsOpen(true);
        window.dispatchEvent(new CustomEvent("spark:open-settings"));
      },
      "session.openInspector": () => setInspectorOpen((open) => !open),
      "composer.focus": () => {
        tabs.openChatTab({ focus: true });
        window.requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent("spark:focus-composer"));
        });
      },
      "sidebar.toggle": () => {
        setShowRight((visible) => !visible);
        window.dispatchEvent(new CustomEvent("spark:toggle-sidebar"));
      },
      "search.open": () => {
        setFileSearchOpen(false);
        setSearchOpen(true);
        window.dispatchEvent(new CustomEvent("spark:open-search"));
      },
      "terminal.toggle": () => {
        // Without the bottom strip the chord now spawns or focuses a
        // terminal tab. If a terminal tab already exists and is active,
        // fall back to cycling to the next one for parity with the
        // "toggle visible terminal" mental model.
        const existing = visibleWorkbenchTabs.find((t) => t.kind === "terminal");
        if (!existing) {
          handleNewTerminalTab();
          return;
        }
        if (activeVisibleTabId === existing.id) {
          // Find any other terminal to cycle to; otherwise leave the
          // current one selected.
          const others = visibleWorkbenchTabs.filter((t) => t.kind === "terminal" && t.id !== existing.id);
          if (others.length > 0) tabs.setActiveTab(others[0].id);
        } else {
          tabs.setActiveTab(existing.id);
        }
      },
      "view.zoomIn": () => window.spark.view.zoomBy(1),
      "view.zoomOut": () => window.spark.view.zoomBy(-1),
      "view.zoomReset": () => window.spark.view.setZoomLevel(0),
      "view.selectByIndex": (event) => {
        const index = Number.parseInt(event.key, 10);
        if (Number.isFinite(index) && index >= 1) {
          const target = visibleWorkbenchTabs[index - 1];
          if (target) tabs.setActiveTab(target.id);
        }
        // Keep the legacy event so any listener (e.g. right panel run
        // selector) can also respond.
        window.dispatchEvent(
          new CustomEvent("spark:select-view", { detail: { index } }),
        );
      },
      "tab.newTerminal": handleNewTerminalTab,
      "terminal.newBalancedPane": handleNewBalancedTerminalPane,
      "tab.newEditor": handleNewEditorTab,
      "tab.newPreview": handleNewPreviewTab,
      "worker.newClaude": () => handleNewWorkerTab(CLAUDE_LAUNCH_COMMAND),
      "worker.newCodex": () => handleNewWorkerTab(CODEX_LAUNCH_COMMAND),
      "worker.newCursor": () => handleNewWorkerTab(CURSOR_LAUNCH_COMMAND),
      "tab.close": () => {
        if (activeVisibleTabId) tabs.closeTab(activeVisibleTabId);
      },
      "tab.closeOthers": () => {
        if (activeVisibleTabId) tabs.closeOthers(activeVisibleTabId);
      },
      "tab.cycleNext": () => {
        if (!activeVisibleTabId || visibleWorkbenchTabs.length === 0) return;
        const idx = visibleWorkbenchTabs.findIndex((tab) => tab.id === activeVisibleTabId);
        const next = visibleWorkbenchTabs[(Math.max(0, idx) + 1) % visibleWorkbenchTabs.length];
        if (next) tabs.setActiveTab(next.id);
      },
      "tab.cyclePrev": () => {
        if (!activeVisibleTabId || visibleWorkbenchTabs.length === 0) return;
        const idx = visibleWorkbenchTabs.findIndex((tab) => tab.id === activeVisibleTabId);
        const prev =
          visibleWorkbenchTabs[
            (Math.max(0, idx) - 1 + visibleWorkbenchTabs.length) % visibleWorkbenchTabs.length
          ];
        if (prev) tabs.setActiveTab(prev.id);
      },
      "terminal.splitRight": () => {
        // The active workbench tab dictates which split happens — we only
        // act on terminal tabs so this chord is a no-op anywhere else.
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.splitTerminalPane(active.id, active.activePaneId, "horizontal");
      },
      "terminal.splitDown": () => {
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.splitTerminalPane(active.id, active.activePaneId, "vertical");
      },
      "terminal.closePane": () => {
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.closeTerminalPane(active.id, active.activePaneId);
      },
      "terminal.toggleZoom": () => {
        const active = visibleWorkbenchTabs.find((t) => t.id === activeVisibleTabId);
        if (!active || active.kind !== "terminal") return;
        tabs.toggleTerminalPaneZoom(active.id, active.activePaneId);
      },
    }),
    [
      handleNewBalancedTerminalPane,
      handleNewEditorTab,
      handleNewPreviewTab,
      handleNewTerminalTab,
      handleNewWorkerTab,
      activeVisibleTabId,
      tabs,
      visibleWorkbenchTabs,
    ],
  );

  const { preferences: shortcutPreferences } = usePreferences();
  const bindingTable = useMemo(
    () => buildBindingTable(shortcutPreferences.keybindings),
    [shortcutPreferences.keybindings],
  );
  useGlobalShortcuts(bindingTable, shortcutHandlers, {
    // While the Keybindings settings recorder is active, suppress all
    // shortcuts so chords like Ctrl+Tab can be captured for rebinding
    // instead of triggering their currently bound command.
    isDisabled: () => isRecording(),
  });

  // Dispose PTYs when terminal panes exit. The renderer-side TerminalPane
  // already calls pty.dispose on unmount, so this handler is intentionally
  // a no-op for unmount cases — but we keep the seam so future "exited
  // pane → auto-close" UX can hook in here without touching every call site.
  const onTerminalPaneExit = useCallback((tabId: string, paneId: string) => {
    paneRuntimeRef.current.delete(paneId);
    const t = tabsRef.current;
    const tab = t.tabs.find((item) => item.id === tabId);
    if (!tab || tab.kind !== "terminal") return;
    const leaf = findLeafByPaneId(tab.root, paneId);
    if (!leaf?.worker) return;
    // Manual chips (user-typed claude/codex, or AddPane menu launches) and
    // legacy chips without an explicit source have no lifecycle outside the
    // pane. Clear them outright when the PTY dies so an idle shell never keeps
    // displaying a stale "DONE" badge after the agent quits.
    if (leaf.worker.source !== "spark") {
      t.setLeafWorker(tabId, paneId, null);
      return;
    }
    // A PTY exit is not the worker completion signal. Spark-owned panes move
    // to "done" only when orchestration emits worker_attempt.finished.
    t.setLeafWorker(tabId, paneId, { ...leaf.worker, agentRunning: false });
  }, []);

  // useTerminalSession sniffs the PTY byte stream for the alt-screen toggle
  // every Ink TUI (claude / codex) emits and tells us when one enters or
  // leaves. We use it to add a "manual" worker chip the moment the user
  // types `codex`/`claude` in any shell pane, and to clear it again the
  // moment they Ctrl+C out — the chip means "an agent is live in this
  // pane" and nothing more, so once the agent quits the pane shows no chip
  // at all (rather than a lingering "DONE" badge).
  // Spark-orchestrated workers (source="spark") keep their completion
  // lifecycle in the run store, but the terminal chip still follows the
  // foreground process: when Claude/Codex returns to the shell prompt, the
  // pane stops advertising an active agent.
  const onTerminalPaneAgentState = useCallback(
    (
      tabId: string,
      paneId: string,
      state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean },
    ) => {
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      if (!leaf) return;
      const existing = leaf.worker;
      if (state.running) {
        if (existing && existing.source === "spark") {
          t.setLeafWorker(tabId, paneId, {
            ...existing,
            runtime: state.runtime ?? existing.runtime,
            agentRunning: true,
          });
          return;
        }
        if (existing && existing.source !== "manual") return;
        const runtime = state.runtime ?? existing?.runtime;
        t.setLeafWorker(tabId, paneId, {
          runtime,
          runId: "manual",
          workerTaskId: existing?.workerTaskId ?? `manual-${paneId}`,
          attemptId: existing?.attemptId ?? paneId,
          source: "manual",
          state: "running",
          agentRunning: true,
        });
        return;
      }
      // running=false: the agent's TUI closed — the user Ctrl+C'd out (or
      // the agent exited) and the shell prompt is back. Clear manual chips
      // outright; for Spark-owned panes, keep the run metadata but mark the
      // foreground agent inactive so the terminal no longer shows CLAUDE DONE.
      if (!existing) return;
      if (existing.source === "spark") {
        t.setLeafWorker(tabId, paneId, { ...existing, agentRunning: false });
        return;
      }
      if (existing.source !== "manual") return;
      t.setLeafWorker(tabId, paneId, null);
    },
    [],
  );

  // Total live worker count for the status bar. `countRunningTerminalWorkers`
  // is a recursive walk of every terminal tab's pane tree — memoize it so a
  // status-bar repaint isn't triggered (and the walk isn't re-run) on every
  // unrelated App re-render. `tabs.tabs` is referentially stable across
  // renders, so it changes only when the tab layout actually does.
  // Declared before the early returns below because hooks must run on every
  // render in the same order.
  const workerCount = useMemo(
    () => (activeWorkspace?.workers.length ?? 0) + countRunningTerminalWorkers(tabs.tabs),
    [tabs.tabs, activeWorkspace?.workers.length],
  );

  // ── Selection routing (preview overlays) ──────────────────────────────
  //
  // The browser pane's inspector + draw overlays each produce a
  // SelectionPayload (text prompt, optionally an annotated PNG path). The
  // SelectionRouteMenu calls route() with one of the destinations below to
  // ship that payload at:
  //   - a brand-new Spark chat (startAutopilot with the payload pre-filled)
  //   - the currently-focused Spark chat (addRunMessage)
  //   - a freshly-spawned Claude Code or Codex worker pane (new pane with
  //     autorun + delayed pty.inject once the agent REPL settles)
  //   - any currently-running CLI worker pane (pty.inject)
  //
  // Image attachments only travel on the chat destinations. PTYs are text
  // only, so worker routes embed the saved PNG's absolute path in the prompt
  // and the CLI agent reads the file off disk.

  // Spawn a fresh worker pane in the same way the keyboard shortcut does
  // (handleNewWorkerTab). Returns the new pane id so the caller can later
  // inject a prompt once the agent is up; null if no terminal tab exists
  // and we had to fall back to creating a whole new tab (no stable id).
  const spawnRoutedWorkerPane = useCallback(
    (autorun: string): string | null => {
      const t = tabsRef.current;
      const active = t.tabs.find((tab) => tab.id === t.activeId);
      const target =
        active?.kind === "terminal"
          ? active
          : t.tabs.find((tab) => tab.kind === "terminal");
      if (!target || target.kind !== "terminal") {
        t.newTerminalTab(activeWorkspace?.cwd ?? undefined, autorun);
        return null;
      }
      const paneId = makeId("pane");
      const activeLeaf = findLeafByPaneId(target.root, target.activePaneId);
      const cwd =
        paneRuntimeRef.current.get(target.activePaneId)?.cwd ??
        activeLeaf?.cwd ??
        activeWorkspace?.cwd ??
        undefined;
      const added = t.addPaneInTab(target.id, paneId, { cwd, autorun });
      if (!added) {
        t.newTerminalTab(cwd, autorun);
        return null;
      }
      t.setActiveTab(target.id);
      t.setActiveTerminalPane(target.id, paneId);
      return paneId;
    },
    [activeWorkspace?.cwd],
  );

  // Wait for a freshly-spawned worker pane's CLI agent to enter its REPL
  // before typing our prompt at it. We watch the leaf's `worker.agentRunning`
  // bit which `onTerminalPaneAgentState` flips on alt-screen detection. If
  // it never flips (very slow boot, agent crashed) we time out and inject
  // anyway — at worst the text lands at the shell, which is recoverable.
  const waitForAgentReady = useCallback(
    (paneId: string, timeoutMs = 30000): Promise<void> =>
      new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          for (const tab of tabsRef.current.tabs) {
            if (tab.kind !== "terminal") continue;
            const leaf = findLeafByPaneId(tab.root, paneId);
            if (leaf?.worker?.agentRunning) {
              resolve();
              return;
            }
          }
          if (Date.now() - start > timeoutMs) {
            resolve();
            return;
          }
          window.setTimeout(tick, 250);
        };
        tick();
      }),
    [],
  );

  const routingDestinations = useMemo<RoutingDestination[]>(() => {
    const list: RoutingDestination[] = [];
    list.push({
      id: "chat-new",
      kind: "chat-new",
      label: "New Spark chat",
      group: "chat",
      disabled: !activeWorkspace,
      disabledReason: activeWorkspace ? undefined : "Open a workspace first.",
    });
    const currentRun = activeRunId ? runs.find((r) => r.id === activeRunId) ?? null : null;
    list.push({
      id: "chat-current",
      kind: "chat-current",
      label: currentRun ? "Send to current chat" : "Send to current chat",
      sublabel: currentRun?.title,
      group: "chat",
      disabled: !currentRun,
      disabledReason: currentRun ? undefined : "No chat is currently focused.",
    });
    list.push({
      id: "worker-new-claude",
      kind: "worker-new-claude",
      label: "New Claude Code worker",
      group: "worker-new",
      disabled: !activeWorkspace,
      disabledReason: activeWorkspace ? undefined : "Open a workspace first.",
    });
    list.push({
      id: "worker-new-codex",
      kind: "worker-new-codex",
      label: "New Codex worker",
      group: "worker-new",
      disabled: !activeWorkspace,
      disabledReason: activeWorkspace ? undefined : "Open a workspace first.",
    });
    const openWorkers = enumerateOpenWorkers(visibleWorkbenchTabs, runs);
    for (const worker of openWorkers) {
      list.push({
        id: `worker-existing-${worker.injectId}`,
        kind: "worker-existing",
        label: workerMenuLabel(worker),
        sublabel: worker.source === "spark" ? undefined : "manual",
        group: "worker-existing",
      });
    }
    return list;
  }, [activeWorkspace, activeRunId, runs, visibleWorkbenchTabs]);

  const routeSelection = useCallback(
    async (payload: SelectionPayload, destinationId: string) => {
      if (destinationId === "chat-new") {
        const ws = activeWorkspace;
        if (!ws) throw new Error("No workspace.");
        const attachments = payload.imagePath
          ? [{ sourcePath: payload.imagePath, kind: "image" as const }]
          : undefined;
        const run = await window.spark.orchestration.startAutopilot({
          workspaceId: ws.id,
          workspaceName: ws.name,
          cwd: ws.cwd,
          initialUserNote: payload.text,
          initialUserNoteClientMessageId: makeId("client-msg"),
          initialAttachments: attachments,
        });
        handleSelectRun(run.id);
        void refreshRunsFor(ws.id);
        return;
      }
      if (destinationId === "chat-current") {
        const runId = activeRunIdRef.current;
        if (!runId) throw new Error("No active chat.");
        const attachments = payload.imagePath
          ? [{ sourcePath: payload.imagePath, kind: "image" as const }]
          : undefined;
        await window.spark.orchestration.addRunMessage({
          runId,
          clientMessageId: makeId("client-msg"),
          author: "user",
          kind: "note",
          message: payload.text,
          attachments,
        });
        return;
      }
      if (destinationId === "worker-new-claude" || destinationId === "worker-new-codex") {
        const autorun =
          destinationId === "worker-new-claude" ? CLAUDE_LAUNCH_COMMAND : CODEX_LAUNCH_COMMAND;
        const paneId = spawnRoutedWorkerPane(autorun);
        if (!paneId) {
          // Fell back to a fresh tab; the leaf was created internally and we
          // don't have a handle to inject into. Skip the auto-prompt — the
          // user can paste the text manually if they want.
          return;
        }
        // Fire-and-forget so the menu can close immediately; the agent boot
        // takes seconds and we don't want to block the UI on it.
        void (async () => {
          await waitForAgentReady(paneId);
          try {
            await window.spark.pty.inject(paneId, payload.text, { submit: true });
          } catch {
            /* pane may have been closed; nothing to recover */
          }
        })();
        return;
      }
      if (destinationId.startsWith("worker-existing-")) {
        const injectId = destinationId.slice("worker-existing-".length);
        await window.spark.pty.inject(injectId, payload.text, { submit: true });
        return;
      }
      throw new Error(`Unknown routing destination: ${destinationId}`);
    },
    [activeWorkspace, handleSelectRun, refreshRunsFor, spawnRoutedWorkerPane, waitForAgentReady],
  );

  const routingApi = useMemo<SelectionRoutingApi>(
    () => ({ destinations: routingDestinations, route: routeSelection }),
    [routingDestinations, routeSelection],
  );

  if (bootError) {
    return (
      <div style={{ padding: 20, color: "var(--danger)" }}>
        <div>Failed to start: {bootError}</div>
      </div>
    );
  }
  if (!booted) {
    return <div style={{ padding: 20, color: "var(--muted)" }}>Loading…</div>;
  }

  const terminalShell = integratedShell ?? defaultShell;

  return (
    <SelectionRoutingProvider value={routingApi}>
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
      {/* Auto-updater banner — position:fixed so the banner sits above
          WindowChrome without disturbing the existing flex layout. Renders
          nothing in the resting state, so it's a no-op outside of the
          packaged-app update lifecycle. */}
      <UpdateBanner />
      <WindowChrome
        platform={platform}
        leftOn={showLeft}
        rightOn={showRight}
        onToggleLeft={handleToggleLeft}
        onToggleRight={handleToggleRight}
        onOpenSettings={handleOpenSettings}
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {showLeft && (
          <WorkspaceRail
            side="left"
            sections={panels.sections.left}
            draggingSection={draggingPanelSection}
            workspaces={workspaces}
            activeId={activeId}
            activeWorkspace={activeWorkspace}
            editingId={editingId}
            width={panels.leftWidth}
            split={panels.leftSplit}
            collapsed={panels.collapsed}
            activePath={
              tabs.activeTab && tabs.activeTab.kind === "editor"
                ? tabs.activeTab.path
                : null
            }
            onActivate={handleActivateWorkspace}
            onEdit={handleEditWorkspace}
            onChange={updateWs}
            onPreviewColor={previewWsColor}
            onDelete={deleteWs}
            onReorder={reorderWs}
            onCloseEditor={handleCloseWorkspaceEditor}
            onCreate={createWs}
            onSplitChange={panels.setLeftSplit}
            onToggleSection={togglePanelSection}
            onMoveSection={movePanelSection}
            onSectionDragStart={handlePanelSectionDragStart}
            onSectionDragEnd={handlePanelSectionDragEnd}
            onRunSnapshot={handleRunSnapshot}
            onOpenFile={openFileByPath}
            onOpenFileEntry={openEditorFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onRunPlan={handleRunPlan}
          />
        )}
        {showLeft && (
          <ResizeHandle
            orientation="col"
            accent={activeWorkspace?.color}
            ariaLabel="Resize the workspaces panel"
            onResizeStart={handleLeftWidthStart}
            onResize={handleLeftWidthResize}
          />
        )}

        <main
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            position: "relative",
          }}
        >
          {workspaces.length === 0 ? (
            <NoWorkspace onCreate={createWs} />
          ) : (
            <Workspace
              tabs={tabs}
              workspace={activeWorkspace}
              shell={terminalShell}
              runs={runs}
              activeRunId={activeRunId}
              onSelectRun={handleSelectRun}
              onRunSnapshot={handleRunSnapshot}
              onDetectedUrl={handleDetectedUrl}
              onSparkOpenFile={openFileByPath}
              onTerminalPaneExit={onTerminalPaneExit}
              onPreviewUrlChange={handlePreviewUrlChange}
              onPaneCwd={handlePaneCwd}
              onPaneActivity={handlePaneActivity}
              onPaneScrollback={handlePaneScrollback}
              onTerminalPaneAgentState={onTerminalPaneAgentState}
              onNewTerminalTab={handleNewTerminalTab}
              onNewEditorTab={handleNewEditorTab}
              onNewPreviewTab={handleNewPreviewTab}
              onTerminalPaneDrop={handleTerminalPaneDropToTab}
              onReorderTab={tabs.reorderTab}
              onPinEditorTab={tabs.pinEditorTab}
            />
          )}
        </main>

        {showRight && (
          <ResizeHandle
            orientation="col"
            accent={activeWorkspace?.color}
            ariaLabel="Resize the right panel"
            onResizeStart={handleRightWidthStart}
            onResize={handleRightWidthResize}
          />
        )}
        {showRight && (
          <WorkspaceRail
            side="right"
            sections={panels.sections.right}
            draggingSection={draggingPanelSection}
            workspaces={workspaces}
            activeId={activeId}
            activeWorkspace={activeWorkspace}
            editingId={editingId}
            width={panels.rightWidth}
            split={panels.rightSplit}
            collapsed={panels.collapsed}
            activePath={
              tabs.activeTab && tabs.activeTab.kind === "editor"
                ? tabs.activeTab.path
                : null
            }
            onActivate={handleActivateWorkspace}
            onEdit={handleEditWorkspace}
            onChange={updateWs}
            onPreviewColor={previewWsColor}
            onDelete={deleteWs}
            onReorder={reorderWs}
            onCloseEditor={handleCloseWorkspaceEditor}
            onCreate={createWs}
            onSplitChange={panels.setRightSplit}
            onToggleSection={togglePanelSection}
            onMoveSection={movePanelSection}
            onSectionDragStart={handlePanelSectionDragStart}
            onSectionDragEnd={handlePanelSectionDragEnd}
            onRunSnapshot={handleRunSnapshot}
            onOpenFile={openFileByPath}
            onOpenFileEntry={openEditorFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onRunPlan={handleRunPlan}
          />
        )}

        {settingsOpen && (
          <SettingsDialog
            settings={settings}
            shells={shells}
            defaultShell={defaultShell}
            onClose={closeSettings}
            onSave={handleSaveSettings}
            onOpenRun={handleSettingsOpenRun}
          />
        )}

        {inspectorOpen && (
          <SessionInspector
            run={runs.find((r) => r.id === activeRunId) ?? null}
            onClose={closeInspector}
          />
        )}

        {capabilitiesOpen && (
          <AgentCapabilitiesDialog
            settings={settings}
            workspaceCwd={activeWorkspace?.cwd ?? null}
            onClose={closeCapabilities}
            onSave={handleSaveSettings}
          />
        )}

        <ShortcutsDialog
          open={shortcutsOpen}
          onClose={closeShortcuts}
        />

        <SearchPanel
          open={searchOpen}
          cwd={activeWorkspace?.cwd ?? null}
          onClose={closeSearch}
          onOpenFile={handleSearchOpenFile}
        />

        <FileSearchPanel
          open={fileSearchOpen}
          cwd={activeWorkspace?.cwd ?? null}
          onClose={closeFileSearch}
          onOpenFile={handleSearchOpenFile}
        />

        <ToastHost onSelectRun={handleSelectRun} />
      </div>

      <StatusBar
        workspace={activeWorkspace}
        defaultShell={defaultShell}
        platform={platform}
        workerCount={workerCount}
      />
    </div>
    </SelectionRoutingProvider>
  );
}

// ── Workspace pane (tab strip + stacks) ──────────────────────────────────────

function isTabVisibleForRun(tab: Tab, activeRunId: string | null): boolean {
  return !(
    tab.kind === "terminal" &&
    tab.scope?.kind === "workers" &&
    tab.scope.runId !== activeRunId
  );
}

interface WorkspaceProps {
  tabs: ReturnType<typeof useTabs>;
  workspace: Workspace | null;
  shell: ShellInfo | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onRunSnapshot: (
    run: RunState,
    options?: { select?: boolean; focusRuns?: boolean },
  ) => void;
  onDetectedUrl: (tabId: string, paneId: string, url: string) => void;
  onSparkOpenFile: (path: string) => void;
  onTerminalPaneExit: (tabId: string, paneId: string) => void;
  onPreviewUrlChange: (id: string, url: string) => void;
  onPaneCwd: (tabId: string, paneId: string, cwd: string) => void;
  onPaneActivity: (tabId: string, paneId: string) => void;
  onPaneScrollback: (tabId: string, paneId: string, scrollback: string) => void;
  onTerminalPaneAgentState: (
    tabId: string,
    paneId: string,
    state: { runtime: "claude" | "codex" | "cursor" | null; running: boolean },
  ) => void;
  onNewTerminalTab: () => void;
  onNewEditorTab: () => void;
  onNewPreviewTab: () => void;
  onTerminalPaneDrop: (payload: TerminalPaneDragPayload, targetTabId?: string) => void;
  onReorderTab: (fromId: string, toId: string, position: "before" | "after") => void;
  onPinEditorTab: (id: TabId) => void;
}

// Memoized: every prop is either referentially stable (the `tabs` object,
// all the hoisted useCallback handlers) or a value that genuinely changes
// (runs, the active run id). So the memo skips re-renders driven
// by unrelated App state — e.g. a live workspace-color drag.
const Workspace = React.memo(function Workspace({
  tabs,
  workspace,
  shell,
  runs,
  activeRunId,
  onSelectRun,
  onRunSnapshot,
  onDetectedUrl,
  onSparkOpenFile,
  onTerminalPaneExit,
  onPreviewUrlChange,
  onPaneCwd,
  onPaneActivity,
  onPaneScrollback,
  onTerminalPaneAgentState,
  onNewTerminalTab,
  onNewEditorTab,
  onNewPreviewTab,
  onTerminalPaneDrop,
  onReorderTab,
  onPinEditorTab,
}: WorkspaceProps) {
  // Destructure the tabs methods we need. useTabs returns a memoized API whose
  // methods are stable for the hook's lifetime, so destructuring here gives us
  // truly stable references — meaning the useCallback wrappers below also stay
  // stable and the memoized children (TabBar/EditorStack/TerminalStack) keep
  // their React.memo intact across App renders.
  const {
    setActiveTab,
    closeTab,
    setDirty,
    setActiveTerminalPane,
    setTerminalSplitRatio,
    splitTerminalPane,
    moveTerminalPane,
    closeTerminalPane,
    toggleTerminalPaneZoom,
  } = tabs;
  const visibleTabs = useMemo(
    () => tabs.tabs.filter((tab) => isTabVisibleForRun(tab, activeRunId)),
    [tabs.tabs, activeRunId],
  );
  const effectiveActiveId = useMemo(() => {
    if (tabs.activeId && visibleTabs.some((tab) => tab.id === tabs.activeId)) {
      return tabs.activeId;
    }
    return visibleTabs[0]?.id ?? null;
  }, [tabs.activeId, visibleTabs]);
  useEffect(() => {
    if (!effectiveActiveId || tabs.activeId === effectiveActiveId) return;
    setActiveTab(effectiveActiveId);
  }, [effectiveActiveId, tabs.activeId, setActiveTab]);

  const handleTabSelect = useCallback(
    (id: TabId) => setActiveTab(id),
    [setActiveTab],
  );
  const handleTabClose = useCallback(
    (id: TabId) => closeTab(id),
    [closeTab],
  );
  const handleEditorDirty = useCallback(
    (id: TabId, dirty: boolean) => setDirty(id, dirty),
    [setDirty],
  );
  const handleSparkOpen = useCallback(
    (input: { file: string }) => onSparkOpenFile(input.file),
    [onSparkOpenFile],
  );
  const handlePaneExit = useCallback(
    (tabId: string, paneId: string) => onTerminalPaneExit(tabId, paneId),
    [onTerminalPaneExit],
  );
  const handleActivatePane = useCallback(
    (tabId: string, paneId: string) => setActiveTerminalPane(tabId, paneId),
    [setActiveTerminalPane],
  );
  const handleSplitRatioChange = useCallback(
    (tabId: string, path: Parameters<typeof setTerminalSplitRatio>[1], ratio: number) =>
      setTerminalSplitRatio(tabId, path, ratio),
    [setTerminalSplitRatio],
  );
  const handleSplitPane = useCallback(
    (
      tabId: string,
      paneId: string,
      direction: Parameters<typeof splitTerminalPane>[2],
      autorun?: string,
    ) => splitTerminalPane(tabId, paneId, direction, autorun),
    [splitTerminalPane],
  );
  const handleMovePane = useCallback(
    (
      payload: TerminalPaneDragPayload,
      targetTabId: string,
      target?: Parameters<typeof moveTerminalPane>[3],
    ) => moveTerminalPane(payload.tabId, payload.paneId, targetTabId, target),
    [moveTerminalPane],
  );
  const handleClosePane = useCallback(
    (tabId: string, paneId: string) => closeTerminalPane(tabId, paneId),
    [closeTerminalPane],
  );
  const handlePaneZoomToggle = useCallback(
    (tabId: string, paneId: string) => toggleTerminalPaneZoom(tabId, paneId),
    [toggleTerminalPaneZoom],
  );

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <TabBar
        tabs={visibleTabs}
        activeId={effectiveActiveId}
        onSelect={handleTabSelect}
        onClose={handleTabClose}
        onNewTerminal={onNewTerminalTab}
        onNewEditor={onNewEditorTab}
        onNewPreview={onNewPreviewTab}
        onTerminalPaneDrop={onTerminalPaneDrop}
        onReorderTab={onReorderTab}
        onPinEditorTab={onPinEditorTab}
      />
      <div style={{ flex: 1, position: "relative", minWidth: 0, minHeight: 0 }}>
        <ChatStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          workspace={workspace}
          runs={runs}
          activeRunId={activeRunId}
          onSelectRun={onSelectRun}
          onRunSnapshot={onRunSnapshot}
        />
        <EditorStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          onDirtyChange={handleEditorDirty}
          onClose={handleTabClose}
        />
        <TerminalStack
          tabs={tabs.tabs}
          activeId={effectiveActiveId}
          shell={shell}
          onDetectedUrl={onDetectedUrl}
          onSparkOpen={handleSparkOpen}
          onPaneExit={handlePaneExit}
          onActivatePane={handleActivatePane}
          onSplitRatioChange={handleSplitRatioChange}
          onSplitPane={handleSplitPane}
          onMovePane={handleMovePane}
          onClosePane={handleClosePane}
          onTabZoomToggle={handlePaneZoomToggle}
          onPaneCwd={onPaneCwd}
          onPaneActivity={onPaneActivity}
          onPaneScrollback={onPaneScrollback}
          onPaneAgentState={onTerminalPaneAgentState}
        />
        <PreviewStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          onUrlChange={onPreviewUrlChange}
        />
        <RunsStack
          tabs={visibleTabs}
          activeId={effectiveActiveId}
          workspace={workspace}
          runs={runs}
          activeRunId={activeRunId}
          onSelectRun={onSelectRun}
        />
        {/* The legacy hidden orchestration TerminalGrid was removed: worker
            PTYs now spawn inside the user-visible TerminalStack via the
            envelope_prepared claim flow in App.tsx. This means worker
            output is watchable, and one PTY surface (TerminalStack) carries
            both user shells and worker shells. */}
      </div>
    </div>
  );
});

// Memoized: its sole prop `onCreate` is a stable useCallback, so this static
// empty-state view never re-renders once mounted.
const NoWorkspace = React.memo(function NoWorkspace({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        background: "var(--bg)",
        backgroundImage:
          "radial-gradient(circle, var(--rule-soft) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        color: "var(--muted)",
        padding: 32,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 24,
          fontWeight: 700,
          color: "var(--ink)",
          letterSpacing: "-0.005em",
        }}
      >
        Your workspace is empty
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 400,
          color: "var(--ink-dim)",
          marginBottom: 8,
        }}
      >
        Pick a folder to start orchestrating workers in it.
      </div>
      <button
        type="button"
        onClick={onCreate}
        style={{
          appearance: "none",
          background: "transparent",
          border: "1px solid var(--rule-strong)",
          color: "var(--ink-dim)",
          padding: "10px 18px",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          letterSpacing: "0.04em",
          fontWeight: 600,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--accent-soft)";
          e.currentTarget.style.borderColor = "var(--accent-edge)";
          e.currentTarget.style.color = "var(--ink)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.borderColor = "var(--rule-strong)";
          e.currentTarget.style.color = "var(--ink-dim)";
        }}
      >
        + Add a workspace
      </button>
      <div
        style={{
          marginTop: 12,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted)",
        }}
      >
        Spark stores its data in ~/.SparkAgent
      </div>
    </div>
  );
});

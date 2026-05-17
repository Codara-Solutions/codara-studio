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
import FileTree from "./components/FileTree";
import OrchestrationSidebar from "./components/OrchestrationSidebar";
import StatusBar from "./components/StatusBar";
import SettingsDialog from "./components/SettingsDialog";
import SearchPanel from "./components/Search/SearchPanel";
import TabBar from "./tabs/TabBar";
import EditorStack from "./tabs/EditorStack";
import TerminalStack from "./tabs/TerminalStack";
import PreviewStack from "./tabs/PreviewStack";
import RunsStack from "./tabs/RunsStack";
import { useTabs } from "./tabs/useTabs";
import type { PaneNode, Tab, TerminalLeaf } from "./tabs/types";
import { basename } from "./path-utils";
import ShortcutsDialog from "./shortcuts/ShortcutsDialog";
import { useGlobalShortcuts, type ShortcutHandlers } from "./shortcuts/useGlobalShortcuts";
import { usePanelLayout, sectionSlotStyles } from "./panels/usePanelLayout";
import ResizeHandle from "./panels/ResizeHandle";
import SectionHeader from "./panels/SectionHeader";

const DEFAULT_SETTINGS: AppSettings = {
  defaultShellId: null,
  openRouterApiKey: "",
  openRouterModel: "google/gemini-flash-latest",
  langSmithApiKey: "",
  langSmithProject: "spark-agent-dev",
  langSmithEndpoint: "https://api.smith.langchain.com",
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

// Compare two filesystem paths case-insensitively (Windows is the target
// platform; case-sensitive matching would split "C:\\Foo" and "c:\\foo").
// Trailing slashes / mixed separators are normalised before comparison.
function samePath(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

// Walk a pane tree and return the first leaf that:
//  - is currently idle (no PTY activity in the last `idleThresholdMs`);
//  - has a cwd that matches the workspace (per `cwdMatches`); and
//  - is free to reuse for an incoming worker on `incomingRunId`.
// The runtime map is read-only here; callers that mutate it should
// guard for the case where a leaf has no entry yet (e.g. a freshly-mounted
// pane that hasn't received any PTY data — treated as activity at "now").
function findIdleLeaf(
  node: PaneNode,
  runtime: Map<string, { cwd?: string; lastActivityAt: number }>,
  now: number,
  idleThresholdMs: number,
  cwdMatches: (cwd: string | undefined) => boolean,
  incomingRunId: string | undefined,
): TerminalLeaf | null {
  if (node.kind === "leaf") {
    // Worker-pane reuse rules:
    //  - state="running": always off-limits, the worker is mid-flight.
    //  - state="done" on the SAME run as the incoming worker: off-limits, so
    //    a verifier doesn't stomp the impl's output the user is still
    //    reading from this run.
    //  - state="done" on a DIFFERENT (or finished) run: reclaimable. Without
    //    this clause every run leaks a pane per worker forever — six workers
    //    in run A means six dead panes blocking run B from reusing any of
    //    them, even after run A is complete.
    if (node.worker) {
      if (node.worker.state === "running") return null;
      if (incomingRunId && node.worker.runId === incomingRunId) return null;
    }
    const entry = runtime.get(node.paneId);
    const liveCwd = entry?.cwd ?? node.cwd;
    if (!cwdMatches(liveCwd)) return null;
    const lastActivityAt = entry?.lastActivityAt ?? now;
    if (now - lastActivityAt < idleThresholdMs) return null;
    return node;
  }
  return (
    findIdleLeaf(node.a, runtime, now, idleThresholdMs, cwdMatches, incomingRunId) ??
    findIdleLeaf(node.b, runtime, now, idleThresholdMs, cwdMatches, incomingRunId)
  );
}

function anyLeafCwdMatches(
  node: PaneNode,
  runtime: Map<string, { cwd?: string; lastActivityAt: number }>,
  cwdMatches: (cwd: string | undefined) => boolean,
): boolean {
  if (node.kind === "leaf") {
    const entry = runtime.get(node.paneId);
    return cwdMatches(entry?.cwd ?? node.cwd);
  }
  return anyLeafCwdMatches(node.a, runtime, cwdMatches) || anyLeafCwdMatches(node.b, runtime, cwdMatches);
}

function findLeafByPaneId(node: PaneNode, paneId: string): TerminalLeaf | null {
  if (node.kind === "leaf") return node.paneId === paneId ? node : null;
  return findLeafByPaneId(node.a, paneId) ?? findLeafByPaneId(node.b, paneId);
}

function countRunningWorkerLeaves(node: PaneNode): number {
  if (node.kind === "leaf") return node.worker?.state === "running" ? 1 : 0;
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
  // here so the workbench RunsView and the right-panel SparkAgentPanel both
  // read from the same source of truth — picking a run on the right updates
  // the canvas in the centre, deleting a run on the right removes it
  // everywhere.
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [defaultShell, setDefaultShell] = useState<ShellInfo | null>(null);
  const [detectedDefaultShell, setDetectedDefaultShell] = useState<ShellInfo | null>(null);
  // Default shell augmented with the bundled OSC 7/133/633/8888 shell
  // integration. Used as the launch profile for terminal tabs so a fresh
  // interactive pane reports cwd/prompt/open-file events to the renderer.
  const [integratedShell, setIntegratedShell] = useState<ShellInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [platform, setPlatform] = useState<string>("");
  const [home, setHome] = useState<string>("");
  // Side-panel layout: outer widths, internal split ratios, per-section
  // collapse. Persisted globally. Mirrored through a ref so the resize-drag
  // callbacks can read the latest widths at drag start with a stable identity.
  const panels = usePanelLayout();
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const saveTimer = useRef<number | null>(null);
  // Trailing-debounce timer for the orchestration-event → listRuns refresh.
  // A single run emits a burst of events (planning → running → many worker
  // lifecycle events → reviewing → complete); refreshing on every one would
  // fire dozens of IPC round-trips. We coalesce a burst into one refresh.
  const runRefreshTimer = useRef<number | null>(null);
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

  // Tabs are scoped per-workspace so each workspace remembers its own layout.
  // useTabs internally swaps tab lists when the workspaceId argument changes.
  const tabs = useTabs(activeId);

  // useTabs returns a fresh object every render, which would force any
  // useCallback/useEffect that depends on `tabs` to re-run on every render.
  // We mirror it through a ref so the run-selection callbacks stay stable
  // and the auto-reopen effect only fires when its real input (runs)
  // actually changes.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Selecting a run must always be visible — if the user closed the Runs
  // tab earlier, we transparently re-open it and route them to the picked
  // run. Without this, picking a run row (or starting a new run) silently
  // updates state and the user sees no UI change.
  const handleSelectRun = useCallback((runId: string | null) => {
    setActiveRunId(runId);
    if (runId === null) return;
    const t = tabsRef.current;
    const existing = t.tabs.find((tab) => tab.kind === "runs");
    if (existing) {
      t.setActiveTab(existing.id);
    } else {
      t.newRunsTab(null);
    }
  }, []);

  // Auto-reopen a runs tab whenever a run is in flight and no tab is
  // currently showing it. Covers the "I closed Runs, then started a new
  // run" case — selectRun is called from the orchestration sidebar, but
  // the runs list itself drives this effect so even external triggers
  // (autopilot resume, headless run) will surface a tab.
  useEffect(() => {
    if (runs.length === 0) return;
    const live = runs.find((r) =>
      ["planning", "running", "reviewing", "blocked", "paused"].includes(r.status),
    );
    if (!live) return;
    const t = tabsRef.current;
    const hasRunsTab = t.tabs.some((tab) => tab.kind === "runs");
    if (!hasRunsTab) t.newRunsTab(null);
  }, [runs]);

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

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );
  const workspaceIdsKey = useMemo(() => workspaces.map((w) => w.id).join("\0"), [workspaces]);

  // Mirror the active workspace id through a ref so the orchestration event
  // listener (below) can read the *current* active id without listing it as
  // an effect dependency — depending on `activeId` would tear down and
  // re-register the IPC listener on every workspace switch.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

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

  // Initial load + reload on workspace change.
  useEffect(() => {
    if (!booted) return;
    void refreshRunsFor(activeId);
  }, [activeId, booted, refreshRunsFor]);

  // When the runs list changes, reconcile the active selection: keep the
  // current pick if it's still present, otherwise jump to the most live one,
  // otherwise the most recent, otherwise nothing.
  useEffect(() => {
    setActiveRunId((current) => {
      if (current && runs.some((run) => run.id === current)) return current;
      const live = runs.find((run) =>
        ["planning", "running", "reviewing", "blocked", "paused"].includes(run.status),
      );
      return live?.id ?? runs[0]?.id ?? null;
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
        const deletedWorkspaceId = event.workspaceId;
        window.setTimeout(() => {
          runRefreshPendingRef.current.add(deletedWorkspaceId);
          if (runRefreshTimer.current !== null) {
            window.clearTimeout(runRefreshTimer.current);
          }
          runRefreshTimer.current = window.setTimeout(flushRunRefresh, RUN_REFRESH_DEBOUNCE_MS);
        }, 500);
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
  // attemptId. We host that PTY inside the user's visible TerminalStack so
  // the agent's xterm output is watchable. Claim policy:
  //   1. Prefer reusing a leaf in a terminal tab that has the workspace
  //      cwd and no PTY activity in the last IDLE_THRESHOLD_MS.
  //   2. If none, smart-split a fresh leaf into the most appropriate
  //      terminal tab (active one if its cwd matches, else any terminal
  //      tab on the workspace, else create a new one).
  // Claiming a leaf disposes its existing PTY and renames the leaf's
  // paneId to attemptId; React re-mounts TerminalPane, which spawns a
  // fresh PTY at the new id, and run-store's `pty.waitForSpawn(attemptId)`
  // resolves.
  useEffect(() => {
    if (!booted) return;

    const IDLE_THRESHOLD_MS = 1500;

    const handleEnvelopePrepared = async (event: SparkEvent) => {
      if (event.type !== "worker_task.envelope_prepared") return;
      if (!event.runId || !event.workerTaskId || !event.attemptId) return;
      if (!event.workspaceId) return;

      const ws = workspacesRef.current.find((w) => w.id === event.workspaceId);
      if (!ws) return;
      const workspaceCwd = ws.cwd;

      // Pull the runtime so the worker chip shows CLAUDE/CODEX. Best-effort —
      // the chip is decoration; the PTY claim itself doesn't depend on it.
      let runtime: "claude" | "codex" | undefined;
      try {
        const run = await window.spark.orchestration.getRun(event.runId);
        const task = run?.workerTasks.find((item) => item.id === event.workerTaskId);
        if (task?.runtimePreference === "claude" || task?.runtimePreference === "codex") {
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
        state: "running" as const,
      };

      const t = tabsRef.current;
      if (!t) return;
      const now = Date.now();
      const cwdMatches = (leafCwd: string | undefined): boolean => {
        if (!leafCwd) return true; // unset cwd is treated as workspace root
        return samePath(leafCwd, workspaceCwd);
      };

      // 1. Find an idle leaf in any terminal tab whose cwd matches.
      let claimTabId: string | null = null;
      let claimPaneId: string | null = null;
      for (const tab of t.tabs) {
        if (tab.kind !== "terminal") continue;
        const idleLeaf = findIdleLeaf(tab.root, paneRuntimeRef.current, now, IDLE_THRESHOLD_MS, cwdMatches, event.runId ?? undefined);
        if (idleLeaf) {
          claimTabId = tab.id;
          claimPaneId = idleLeaf.paneId;
          break;
        }
      }

      if (claimTabId && claimPaneId) {
        // Reuse: dispose the user's PTY and rename the leaf to attemptId.
        // React unmounts the old TerminalPane (which already has its own
        // dispose-on-unmount path), then mounts a new one at the new id.
        void window.spark.pty.dispose(claimPaneId).catch(() => undefined);
        paneRuntimeRef.current.delete(claimPaneId);
        const renamed = t.renameLeaf(claimTabId, claimPaneId, event.attemptId);
        if (renamed) {
          t.setLeafWorker(claimTabId, event.attemptId, workerMeta);
          t.setLeafCwd(claimTabId, event.attemptId, workspaceCwd);
          t.setActiveTab(claimTabId);
          t.setActiveTerminalPane(claimTabId, event.attemptId);
          return;
        }
      }

      // 2. No idle leaf — find or create a terminal tab and smart-add a new
      //    leaf with paneId=attemptId. Prefer the currently-active terminal
      //    tab if it has the right cwd; otherwise the first terminal tab
      //    that does; otherwise create a fresh one.
      const activeTerminal = t.tabs.find(
        (tab) => tab.id === t.activeId && tab.kind === "terminal",
      );
      let targetTabId: string | null = null;
      if (
        activeTerminal &&
        activeTerminal.kind === "terminal" &&
        anyLeafCwdMatches(activeTerminal.root, paneRuntimeRef.current, cwdMatches)
      ) {
        targetTabId = activeTerminal.id;
      } else {
        const matching = t.tabs.find(
          (tab) =>
            tab.kind === "terminal" &&
            anyLeafCwdMatches(tab.root, paneRuntimeRef.current, cwdMatches),
        );
        targetTabId = matching ? matching.id : t.newTerminalTab(workspaceCwd);
      }

      const ok = t.addPaneInTab(targetTabId, event.attemptId, {
        cwd: workspaceCwd,
        worker: workerMeta,
      });
      if (ok) {
        t.setActiveTab(targetTabId);
        t.setActiveTerminalPane(targetTabId, event.attemptId);
      }
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
            state: "done",
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
  const toggleWorkspacesSection = useCallback(() => panelsRef.current.toggleCollapse("workspaces"), []);
  const toggleGraphSection = useCallback(() => panelsRef.current.toggleCollapse("graph"), []);
  const toggleAgentSection = useCallback(() => panelsRef.current.toggleCollapse("agent"), []);
  const toggleExplorerSection = useCallback(() => panelsRef.current.toggleCollapse("explorer"), []);

  const handleOpenSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  const updateWs = useCallback((id: string, patch: Partial<Workspace>) => {
    setWorkspaces((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }, []);

  const previewWsColor = useCallback((id: string, color: string) => {
    if (activeIdRef.current !== id) return;
    document.documentElement.style.setProperty("--accent", color);
  }, []);

  const deleteWs = useCallback((id: string) => {
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
    setActiveId(ws.id);
    setEditingId(ws.id);
  }, [workspaces, activeWorkspace, home]);

  // ── File / editor tab integration ──────────────────────────────────────────

  const openEditorFile = useCallback(
    (entry: FsEntry) => {
      tabs.openEditorTab(entry);
    },
    [tabs],
  );

  // RightPanel FileTree prop callbacks. Hoisted to stable references (keyed
  // on the now-stable `tabs` object) so the React.memo on RightPanel can skip
  // re-renders when only unrelated App state changed.
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

  const handleNewEditorTab = useCallback(() => {
    // No native "open file" dialog wired up yet; surface the search modal,
    // which is the existing path the user knows for picking a file.
    setSearchOpen(true);
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
      "composer.focus": () => {
        window.dispatchEvent(new CustomEvent("spark:focus-composer"));
      },
      "sidebar.toggle": () => {
        setShowRight((visible) => !visible);
        window.dispatchEvent(new CustomEvent("spark:toggle-sidebar"));
      },
      "search.open": () => {
        setSearchOpen(true);
        window.dispatchEvent(new CustomEvent("spark:open-search"));
      },
      "terminal.toggle": () => {
        // Without the bottom strip the chord now spawns or focuses a
        // terminal tab. If a terminal tab already exists and is active,
        // fall back to cycling to the next one for parity with the
        // "toggle visible terminal" mental model.
        const existing = tabs.tabs.find((t) => t.kind === "terminal");
        if (!existing) {
          handleNewTerminalTab();
          return;
        }
        if (tabs.activeId === existing.id) {
          // Find any other terminal to cycle to; otherwise leave the
          // current one selected.
          const others = tabs.tabs.filter((t) => t.kind === "terminal" && t.id !== existing.id);
          if (others.length > 0) tabs.setActiveTab(others[0].id);
        } else {
          tabs.setActiveTab(existing.id);
        }
      },
      "view.selectByIndex": (event) => {
        const index = Number.parseInt(event.key, 10);
        if (Number.isFinite(index) && index >= 1) {
          tabs.selectByIndex(index - 1);
        }
        // Keep the legacy event so any listener (e.g. right panel run
        // selector) can also respond.
        window.dispatchEvent(
          new CustomEvent("spark:select-view", { detail: { index } }),
        );
      },
      "tab.newTerminal": handleNewTerminalTab,
      "tab.newEditor": handleNewEditorTab,
      "tab.newPreview": handleNewPreviewTab,
      "tab.close": () => {
        if (tabs.activeId) tabs.closeTab(tabs.activeId);
      },
      "tab.closeOthers": () => {
        if (tabs.activeId) tabs.closeOthers(tabs.activeId);
      },
      "tab.cycleNext": () => tabs.cycleNext(),
      "tab.cyclePrev": () => tabs.cyclePrev(),
      "terminal.splitRight": () => {
        // The active workbench tab dictates which split happens — we only
        // act on terminal tabs so this chord is a no-op anywhere else.
        const active = tabs.tabs.find((t) => t.id === tabs.activeId);
        if (!active || active.kind !== "terminal") return;
        tabs.splitTerminalPane(active.id, active.activePaneId, "horizontal");
      },
      "terminal.splitDown": () => {
        const active = tabs.tabs.find((t) => t.id === tabs.activeId);
        if (!active || active.kind !== "terminal") return;
        tabs.splitTerminalPane(active.id, active.activePaneId, "vertical");
      },
      "terminal.closePane": () => {
        const active = tabs.tabs.find((t) => t.id === tabs.activeId);
        if (!active || active.kind !== "terminal") return;
        tabs.closeTerminalPane(active.id, active.activePaneId);
      },
    }),
    [handleNewEditorTab, handleNewPreviewTab, handleNewTerminalTab, tabs],
  );

  useGlobalShortcuts(shortcutHandlers);

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
    // Manual chips (user-typed claude/codex, or AddPane menu launches) have
    // no lifecycle outside the pane. Clear them outright when the PTY dies
    // so the pane doesn't keep displaying a stale "DONE" badge after the
    // agent quits. Spark-owned workers (source="spark") stay visible as
    // "done" so the run-bookkeeping / review flow can still surface them.
    if (leaf.worker.source === "manual") {
      t.setLeafWorker(tabId, paneId, null);
      return;
    }
    if (leaf.worker.state !== "running") return;
    t.setLeafWorker(tabId, paneId, { ...leaf.worker, state: "done" });
  }, []);

  // useTerminalSession sniffs the PTY byte stream for the alt-screen toggle
  // every Ink TUI (claude / codex) emits and tells us when one enters or
  // leaves. We use it to add a "manual" worker chip the moment the user
  // types `codex`/`claude` in any shell pane, and to clear it again the
  // moment they Ctrl+C out — the chip means "an agent is live in this
  // pane" and nothing more, so once the agent quits the pane shows no chip
  // at all (rather than a lingering "DONE" badge).
  // Spark-orchestrated workers (source="spark") have their own lifecycle
  // driven by IPC and must never be touched here — otherwise a Ctrl+C in a
  // worker pane would silently break the run's bookkeeping.
  const onTerminalPaneAgentState = useCallback(
    (
      tabId: string,
      paneId: string,
      state: { runtime: "claude" | "codex" | null; running: boolean },
    ) => {
      const t = tabsRef.current;
      const tab = t.tabs.find((item) => item.id === tabId);
      if (!tab || tab.kind !== "terminal") return;
      const leaf = findLeafByPaneId(tab.root, paneId);
      if (!leaf) return;
      const existing = leaf.worker;
      if (state.running) {
        if (existing && existing.source !== "manual") return;
        const runtime = state.runtime ?? existing?.runtime;
        t.setLeafWorker(tabId, paneId, {
          runtime,
          runId: "manual",
          workerTaskId: existing?.workerTaskId ?? `manual-${paneId}`,
          attemptId: existing?.attemptId ?? paneId,
          source: "manual",
          state: "running",
        });
        return;
      }
      // running=false: the agent's TUI closed — the user Ctrl+C'd out (or
      // the agent exited) and the shell prompt is back. Clear the manual
      // chip outright so the pane shows nothing once no agent is live; a
      // lingering "DONE" badge here is just noise. Only touch chips we own
      // (manual) — Spark-orchestrated workers keep their IPC-driven "done"
      // state for the run-bookkeeping / review flow.
      if (!existing || existing.source !== "manual") return;
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
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
      }}
    >
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
            workspaces={workspaces}
            activeId={activeId}
            activeWorkspace={activeWorkspace}
            editingId={editingId}
            width={panels.leftWidth}
            split={panels.leftSplit}
            workspacesCollapsed={panels.collapsed.workspaces}
            graphCollapsed={panels.collapsed.graph}
            onActivate={handleActivateWorkspace}
            onEdit={handleEditWorkspace}
            onChange={updateWs}
            onPreviewColor={previewWsColor}
            onDelete={deleteWs}
            onCloseEditor={handleCloseWorkspaceEditor}
            onCreate={createWs}
            onSplitChange={panels.setLeftSplit}
            onToggleWorkspaces={toggleWorkspacesSection}
            onToggleGraph={toggleGraphSection}
            onOpenFile={openFileByPath}
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
              onDetectedUrl={handleDetectedUrl}
              onSparkOpenFile={openFileByPath}
              onTerminalPaneExit={onTerminalPaneExit}
              onPreviewUrlChange={handlePreviewUrlChange}
              onPaneCwd={handlePaneCwd}
              onPaneActivity={handlePaneActivity}
              onTerminalPaneAgentState={onTerminalPaneAgentState}
              onNewTerminalTab={handleNewTerminalTab}
              onNewEditorTab={handleNewEditorTab}
              onNewPreviewTab={handleNewPreviewTab}
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
          <RightPanel
            workspace={activeWorkspace}
            activePath={
              tabs.activeTab && tabs.activeTab.kind === "editor"
                ? tabs.activeTab.path
                : null
            }
            runs={runs}
            activeRunId={activeRunId}
            width={panels.rightWidth}
            split={panels.rightSplit}
            agentCollapsed={panels.collapsed.agent}
            explorerCollapsed={panels.collapsed.explorer}
            onSelectRun={handleSelectRun}
            onOpenFile={openEditorFile}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onSplitChange={panels.setRightSplit}
            onToggleAgent={toggleAgentSection}
            onToggleExplorer={toggleExplorerSection}
          />
        )}

        {settingsOpen && (
          <SettingsDialog
            settings={settings}
            shells={shells}
            defaultShell={defaultShell}
            onClose={() => setSettingsOpen(false)}
            onSave={async (nextSettings) => {
              const saved = await window.spark.settings.save(nextSettings);
              setSettings(saved);
              setDefaultShell(resolveDefaultShell(shells, saved, detectedDefaultShell));
            }}
            onOpenRun={(runId, workspaceId) => {
              if (workspaces.some((w) => w.id === workspaceId)) {
                setActiveId(workspaceId);
              }
              handleSelectRun(runId);
              setSettingsOpen(false);
            }}
          />
        )}

        <ShortcutsDialog
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
        />

        <SearchPanel
          open={searchOpen}
          cwd={activeWorkspace?.cwd ?? null}
          onClose={() => setSearchOpen(false)}
          onOpenFile={(entry) => {
            openEditorFile(entry);
            setSearchOpen(false);
          }}
        />
      </div>

      <StatusBar
        workspace={activeWorkspace}
        defaultShell={defaultShell}
        platform={platform}
        workerCount={workerCount}
      />
    </div>
  );
}

// ── Workspace pane (tab strip + stacks) ──────────────────────────────────────

interface WorkspaceProps {
  tabs: ReturnType<typeof useTabs>;
  workspace: Workspace | null;
  shell: ShellInfo | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onDetectedUrl: (tabId: string, paneId: string, url: string) => void;
  onSparkOpenFile: (path: string) => void;
  onTerminalPaneExit: (tabId: string, paneId: string) => void;
  onPreviewUrlChange: (id: string, url: string) => void;
  onPaneCwd: (tabId: string, paneId: string, cwd: string) => void;
  onPaneActivity: (tabId: string, paneId: string) => void;
  onTerminalPaneAgentState: (
    tabId: string,
    paneId: string,
    state: { runtime: "claude" | "codex" | null; running: boolean },
  ) => void;
  onNewTerminalTab: () => void;
  onNewEditorTab: () => void;
  onNewPreviewTab: () => void;
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
  onDetectedUrl,
  onSparkOpenFile,
  onTerminalPaneExit,
  onPreviewUrlChange,
  onPaneCwd,
  onPaneActivity,
  onTerminalPaneAgentState,
  onNewTerminalTab,
  onNewEditorTab,
  onNewPreviewTab,
}: WorkspaceProps) {
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
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        onSelect={(id) => tabs.setActiveTab(id)}
        onClose={(id) => tabs.closeTab(id)}
        onNewTerminal={onNewTerminalTab}
        onNewEditor={onNewEditorTab}
        onNewPreview={onNewPreviewTab}
      />
      <div style={{ flex: 1, position: "relative", minWidth: 0, minHeight: 0 }}>
        <EditorStack
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          onDirtyChange={(id, dirty) => tabs.setDirty(id, dirty)}
          onClose={(id) => tabs.closeTab(id)}
        />
        <TerminalStack
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          shell={shell}
          onDetectedUrl={onDetectedUrl}
          onSparkOpen={(input) => onSparkOpenFile(input.file)}
          onPaneExit={(tabId, paneId) => onTerminalPaneExit(tabId, paneId)}
          onActivatePane={(tabId, paneId) => tabs.setActiveTerminalPane(tabId, paneId)}
          onSplitRatioChange={(tabId, path, ratio) =>
            tabs.setTerminalSplitRatio(tabId, path, ratio)
          }
          onSplitPane={(tabId, paneId, direction, autorun) =>
            tabs.splitTerminalPane(tabId, paneId, direction, autorun)
          }
          onClosePane={(tabId, paneId) => tabs.closeTerminalPane(tabId, paneId)}
          onPaneCwd={onPaneCwd}
          onPaneActivity={onPaneActivity}
          onPaneAgentState={onTerminalPaneAgentState}
        />
        <PreviewStack
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          onUrlChange={onPreviewUrlChange}
        />
        <RunsStack
          tabs={tabs.tabs}
          activeId={tabs.activeId}
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

// Memoized: `workspace` is the memoized activeWorkspace, `activePath` is a
// derived primitive, and every callback is a hoisted stable reference — so
// the memo skips re-renders from unrelated App state churn.
const RightPanel = React.memo(function RightPanel({
  workspace,
  activePath,
  runs,
  activeRunId,
  width,
  split,
  agentCollapsed,
  explorerCollapsed,
  onSelectRun,
  onOpenFile,
  onDeleteFile,
  onRenameFile,
  onSplitChange,
  onToggleAgent,
  onToggleExplorer,
}: {
  workspace: Workspace | null;
  activePath: string | null;
  runs: RunState[];
  activeRunId: string | null;
  width: number;
  split: number;
  agentCollapsed: boolean;
  explorerCollapsed: boolean;
  onSelectRun: (id: string | null) => void;
  onOpenFile: (entry: FsEntry) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, entry: FsEntry) => void;
  onSplitChange: (ratio: number) => void;
  onToggleAgent: () => void;
  onToggleExplorer: () => void;
}) {
  const cwd = workspace?.cwd ?? null;
  const accent = workspace?.color || "var(--accent)";

  // Section-divider drag: snapshot the split ratio and body height at drag
  // start, then translate a pointer delta into a ratio delta (same pattern
  // as WorkspaceRail).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const splitAtDragStart = useRef(split);
  const bodyHeightAtDragStart = useRef(1);

  const [agentSlot, explorerSlot] = sectionSlotStyles(split, agentCollapsed, explorerCollapsed);

  return (
    <aside
      style={{
        width,
        flex: `0 0 ${width}px`,
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        ref={bodyRef}
        style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
      >
        <section
          style={{
            ...agentSlot,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <OrchestrationSidebar
            workspace={workspace}
            runs={runs}
            activeRunId={activeRunId}
            onSelectRun={onSelectRun}
            collapsed={agentCollapsed}
            onToggleCollapse={onToggleAgent}
          />
        </section>

        <ResizeHandle
          orientation="row"
          disabled={agentCollapsed || explorerCollapsed}
          accent={accent}
          ariaLabel="Resize Spark and Explorer"
          onResizeStart={() => {
            splitAtDragStart.current = split;
            bodyHeightAtDragStart.current = bodyRef.current?.clientHeight ?? 1;
          }}
          onResize={(delta) => {
            onSplitChange(splitAtDragStart.current + delta / bodyHeightAtDragStart.current);
          }}
        />

        <section
          style={{
            ...explorerSlot,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {cwd ? (
            <FileTree
              cwd={cwd}
              activePath={activePath}
              onOpenFile={onOpenFile}
              onDeleteFile={onDeleteFile}
              onRenameFile={onRenameFile}
              collapsed={explorerCollapsed}
              onToggleCollapse={onToggleExplorer}
            />
          ) : (
            <>
              <SectionHeader
                label="Explorer"
                collapsed={explorerCollapsed}
                onToggleCollapse={onToggleExplorer}
              />
              {!explorerCollapsed && (
                <div style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 11 }}>
                  No active workspace.
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </aside>
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AppState,
  FsEntry,
  RunState,
  ShellInfo,
  SparkEvent,
  Worker,
  Workspace,
} from "@shared/types";
import WindowChrome from "./components/WindowChrome";
import WorkspaceRail, { WORKSPACE_COLORS } from "./components/WorkspaceRail";
import TerminalGrid from "./components/TerminalGrid";
import FileTree from "./components/FileTree";
import EditorWorkbench from "./components/EditorWorkbench";
import RunsView from "./components/RunsView";
import OrchestrationSidebar from "./components/OrchestrationSidebar";
import StatusBar from "./components/StatusBar";
import SettingsDialog from "./components/SettingsDialog";
import { PlusIcon } from "./components/icons";
import type { ShellIntegration } from "./terminal/shell-integration";
import { basename } from "./path-utils";
import { getWorkerGridLayout } from "./worker-grid-layout";
import ShortcutsDialog from "./shortcuts/ShortcutsDialog";
import { useGlobalShortcuts, type ShortcutHandlers } from "./shortcuts/useGlobalShortcuts";

const RAIL_WIDTH = 240;
const RIGHT_WIDTH = 360;
type WorkbenchTab = "workers" | "editor" | "runs";

const DEFAULT_SETTINGS: AppSettings = {
  defaultShellId: null,
  openRouterApiKey: "",
  openRouterModel: "google/gemini-flash-latest",
  langSmithApiKey: "",
  langSmithProject: "spark-agent-dev",
  langSmithEndpoint: "https://api.smith.langchain.com",
};

function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function resolveDefaultShell(
  shells: ShellInfo[],
  settings: AppSettings,
  detectedDefault: ShellInfo | null,
): ShellInfo | null {
  return shells.find((shell) => shell.id === settings.defaultShellId) ?? detectedDefault ?? shells[0] ?? null;
}

function isReusableWorkerSlot(
  worker: Worker,
  integrations: Map<string, ShellIntegration>,
): boolean {
  if (worker.kind === "autofill") return false;
  return integrations.get(worker.id)?.isReusablePrompt() === true;
}

export default function App() {
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [openFiles, setOpenFiles] = useState<FsEntry[]>([]);
  const [activeEditorPath, setActiveEditorPath] = useState<string | null>(null);
  const [activeWorkbenchTab, setActiveWorkbenchTab] = useState<WorkbenchTab>("workers");
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
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [platform, setPlatform] = useState<string>("");
  const [home, setHome] = useState<string>("");
  const saveTimer = useRef<number | null>(null);
  // Per-pane shell integrations registered as WorkerPanes mount. Used to ask
  // "is this terminal currently running a command or hosting a TUI?" before
  // pasting test prompts into it.
  const workerIntegrationsRef = useRef<Map<string, ShellIntegration>>(new Map());
  const registerWorkerIntegration = useCallback(
    (workerId: string, integration: ShellIntegration | null) => {
      if (integration) workerIntegrationsRef.current.set(workerId, integration);
      else workerIntegrationsRef.current.delete(workerId);
    },
    [],
  );

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

  // Close editor when rail hidden
  useEffect(() => {
    if (!showLeft) setEditingId(null);
  }, [showLeft]);

  useEffect(() => {
    setOpenFiles([]);
    setActiveEditorPath(null);
    setActiveWorkbenchTab("workers");
  }, [activeId]);

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );
  const workspaceIdsKey = useMemo(() => workspaces.map((w) => w.id).join("\0"), [workspaces]);

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
    const ids = workspaces.map((workspace) => workspace.id);
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
  }, [booted, workspaceIdsKey, workspaces]);

  useEffect(() => {
    if (!booted) return undefined;
    return window.spark.orchestration.onEvent((event) => {
      if (!event.workspaceId) return;
      void refreshRunCount(event.workspaceId);
      if (event.workspaceId === activeId) {
        void refreshRunsFor(event.workspaceId);
      }
      if (event.type === "run.deleted") {
        window.setTimeout(() => {
          void refreshRunCount(event.workspaceId);
          if (event.workspaceId === activeId) void refreshRunsFor(event.workspaceId);
        }, 500);
      }
    });
  }, [booted, refreshRunCount, refreshRunsFor, activeId]);

  useEffect(() => {
    if (activeWorkbenchTab !== "runs") return;
    if (!activeId || (runCountsByWorkspace[activeId] ?? 0) === 0) {
      setActiveWorkbenchTab("workers");
    }
  }, [activeId, activeWorkbenchTab, runCountsByWorkspace]);

  // Theme the entire UI with the active workspace's color. Falls back to the
  // default yellow when nothing is active.
  useEffect(() => {
    const accent = activeWorkspace?.color || "#F0C419";
    document.documentElement.style.setProperty("--accent", accent);
  }, [activeWorkspace?.color]);

  // Open the dedicated Settings BrowserWindow when any part of the app
  // dispatches the `spark:open-settings` window event. The keyboard
  // shortcuts agent in this same wave dispatches it for Mod+,; this handler
  // is the single subscriber so the binding stays decoupled.
  useEffect(() => {
    const handler = () => {
      void window.spark.settings.open();
    };
    window.addEventListener("spark:open-settings", handler);
    return () => window.removeEventListener("spark:open-settings", handler);
  }, []);

  useEffect(() => {
    if (!booted) return;
    const shellId = defaultShell?.id ?? shells[0]?.id;
    if (!shellId) return;

    const addSparkWorkerPane = async (event: SparkEvent) => {
      if (event.type !== "worker_task.envelope_prepared") return;
      if (!event.runId || !event.workerTaskId || !event.attemptId) return;

      let runtime: Worker["runtime"] = undefined;
      try {
        const run = await window.spark.orchestration.getRun(event.runId);
        const task = run?.workerTasks.find((item) => item.id === event.workerTaskId);
        if (task) {
          runtime = task.runtimePreference;
        }
      } catch {
        /* the event already has enough information to create a visible pane */
      }

      const pane: Worker = {
        id: event.attemptId,
        shellId,
        kind: "orchestration",
        runtime,
        runId: event.runId,
        workerTaskId: event.workerTaskId,
        attemptId: event.attemptId,
      };

      setWorkspaces((list) =>
        list.map((workspace) => {
          if (workspace.id !== event.workspaceId) return workspace;
          if (workspace.workers.some((worker) => worker.id === pane.id)) return workspace;
          // Sweep stale autofill panes from earlier versions of this code. We
          // no longer pad: the grid auto-sizes around actual panes. Before
          // appending, reuse a pane the user left at a fresh/cleared prompt.
          const real = workspace.workers.filter((w) => w.kind !== "autofill");
          for (const stale of workspace.workers) {
            if (stale.kind === "autofill") void window.spark.pty.dispose(stale.id);
          }
          const reusable = real.find((worker) =>
            isReusableWorkerSlot(worker, workerIntegrationsRef.current),
          );
          if (reusable) {
            void window.spark.pty.dispose(reusable.id);
            return {
              ...workspace,
              workers: real.map((worker) =>
                worker.id === reusable.id
                  ? { ...pane, shellId: reusable.shellId }
                  : worker,
              ),
            };
          }
          return { ...workspace, workers: [...real, pane] };
        }),
      );
    };

    return window.spark.orchestration.onEvent((event) => {
      void addSparkWorkerPane(event);
    });
  }, [activeId, booted, defaultShell?.id, shells]);

  const updateWs = useCallback((id: string, patch: Partial<Workspace>) => {
    setWorkspaces((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
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
      id: uid("ws"),
      name: basename(path) || "workspace",
      cwd: path,
      color,
      workers: [],
    };
    setWorkspaces((list) => [...list, ws]);
    setActiveId(ws.id);
    setEditingId(ws.id);
  }, [workspaces, activeWorkspace, home]);

  const addWorker = useCallback(
    (workspaceId: string, shellId: string) => {
      const shell = shells.find((s) => s.id === shellId);
      if (!shell) return;
      setWorkspaces((list) =>
        list.map((w) =>
          w.id === workspaceId
            ? { ...w, workers: [...w.workers, { id: uid("w"), shellId: shell.id }] }
            : w,
        ),
      );
    },
    [shells],
  );

  const removeWorker = useCallback((workspaceId: string, workerId: string) => {
    void window.spark.pty.dispose(workerId);
    setWorkspaces((list) =>
      list.map((w) =>
        w.id === workspaceId ? { ...w, workers: w.workers.filter((x) => x.id !== workerId) } : w,
      ),
    );
  }, []);

  const openEditorFile = useCallback((entry: FsEntry) => {
    setOpenFiles((files) =>
      files.some((file) => file.path === entry.path) ? files : [...files, entry],
    );
    setActiveEditorPath(entry.path);
    setActiveWorkbenchTab("editor");
  }, []);

  const closeEditorFile = useCallback((path: string) => {
    setOpenFiles((files) => {
      const next = files.filter((file) => file.path !== path);
      setActiveEditorPath((current) => {
        if (current !== path) return current;
        return next[next.length - 1]?.path ?? null;
      });
      if (next.length === 0) setActiveWorkbenchTab("workers");
      return next;
    });
  }, []);

  // Global keyboard shortcuts. Capture-phase + stopImmediatePropagation in
  // useGlobalShortcuts ensures these chords win over xterm/CodeMirror panes
  // that would otherwise eat the keystroke. Cross-module side-effects
  // (focus the chat composer, ask other panels to toggle) are broadcast as
  // `spark:*` CustomEvents so listeners can wire up without prop drilling.
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
      "view.selectByIndex": (event) => {
        const index = Number.parseInt(event.key, 10);
        window.dispatchEvent(
          new CustomEvent("spark:select-view", { detail: { index } }),
        );
      },
    }),
    [],
  );

  useGlobalShortcuts(shortcutHandlers);

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
        onToggleLeft={() => setShowLeft((v) => !v)}
        onToggleRight={() => setShowRight((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPreferences={() => {
          void window.spark.settings.open();
        }}
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {showLeft && (
          <WorkspaceRail
            workspaces={workspaces}
            activeId={activeId}
            activeWorkspace={activeWorkspace}
            editingId={editingId}
            width={RAIL_WIDTH}
            onActivate={(id) => {
              setOpenFiles([]);
              setActiveEditorPath(null);
              setActiveWorkbenchTab("workers");
              setActiveId(id);
            }}
            onEdit={(id) => setEditingId((prev) => (prev === id ? null : id))}
            onChange={updateWs}
            onDelete={deleteWs}
            onCloseEditor={() => setEditingId(null)}
            onCreate={createWs}
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
            // Keep every workspace's grid mounted so PTYs and xterm scrollback
            // survive workspace switches; hide inactive ones with display:none.
            workspaces.map((ws) => (
              <div
                key={ws.id}
                style={{
                  flex: 1,
                  display: ws.id === activeId ? "flex" : "none",
                  flexDirection: "column",
                  minWidth: 0,
                  minHeight: 0,
                }}
              >
                <WorkbenchTabs
                  active={activeWorkbenchTab}
                  workerCount={ws.workers.length}
                  fileCount={openFiles.length}
                  runCount={runCountsByWorkspace[ws.id] ?? 0}
                  shells={shells}
                  defaultShell={defaultShell}
                  onSelect={setActiveWorkbenchTab}
                  onAddWorker={(shellId) => addWorker(ws.id, shellId)}
                />
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: activeWorkbenchTab === "workers" ? "flex" : "none" }}>
                  <TerminalGrid
                    workspace={ws}
                    shells={shells}
                    defaultShell={defaultShell}
                    onAddWorker={(shellId) => addWorker(ws.id, shellId)}
                    onRemoveWorker={(workerId) => removeWorker(ws.id, workerId)}
                    onWorkerIntegration={registerWorkerIntegration}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: activeWorkbenchTab === "editor" ? "flex" : "none" }}>
                  <EditorWorkbench
                    files={openFiles}
                    activePath={activeEditorPath}
                    onActivateFile={setActiveEditorPath}
                    onCloseFile={closeEditorFile}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: activeWorkbenchTab === "runs" ? "flex" : "none" }}>
                  <RunsView
                    workspace={ws}
                    runs={ws.id === activeId ? runs : []}
                    activeRunId={ws.id === activeId ? activeRunId : null}
                    onSelectRun={setActiveRunId}
                  />
                </div>
              </div>
            ))
          )}
        </main>

        {showRight && (
          <RightPanel
            workspace={activeWorkspace}
            activePath={activeEditorPath}
            runs={runs}
            activeRunId={activeRunId}
            onSelectRun={setActiveRunId}
            onOpenFile={openEditorFile}
            onDeleteFile={closeEditorFile}
            onRenameFile={(oldPath, entry) => {
              setOpenFiles((files) =>
                files.map((file) => (file.path === oldPath ? entry : file)),
              );
              setActiveEditorPath((current) => (current === oldPath ? entry.path : current));
            }}
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
          />
        )}

        <ShortcutsDialog
          open={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
        />
      </div>

      <StatusBar
        workspace={activeWorkspace}
        defaultShell={defaultShell}
        platform={platform}
      />
    </div>
  );
}

function RightPanel({
  workspace,
  activePath,
  runs,
  activeRunId,
  onSelectRun,
  onOpenFile,
  onDeleteFile,
  onRenameFile,
}: {
  workspace: Workspace | null;
  activePath: string | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onOpenFile: (entry: FsEntry) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, entry: FsEntry) => void;
}) {
  const cwd = workspace?.cwd ?? null;
  return (
    <aside
      style={{
        width: RIGHT_WIDTH,
        flex: `0 0 ${RIGHT_WIDTH}px`,
        borderLeft: "1px solid var(--rule-soft)",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <OrchestrationSidebar
        workspace={workspace}
        runs={runs}
        activeRunId={activeRunId}
        onSelectRun={onSelectRun}
      />
      {cwd ? (
        <FileTree
          cwd={cwd}
          activePath={activePath}
          onOpenFile={onOpenFile}
          onDeleteFile={onDeleteFile}
          onRenameFile={onRenameFile}
        />
      ) : (
        <div style={{ padding: "12px 14px", color: "var(--muted)", fontSize: 11 }}>
          No active workspace.
        </div>
      )}
    </aside>
  );
}

function WorkbenchTabs({
  active,
  workerCount,
  fileCount,
  runCount,
  shells,
  defaultShell,
  onSelect,
  onAddWorker,
}: {
  active: WorkbenchTab;
  workerCount: number;
  fileCount: number;
  runCount: number;
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  onSelect: (tab: WorkbenchTab) => void;
  onAddWorker: (shellId: string) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const workerDims = getWorkerGridLayout(workerCount);
  const activeDims = workerDims;
  const showLayoutPill = active === "workers";

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && e.target instanceof Node && !pickerRef.current.contains(e.target)) {
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

  const handleAdd = () => {
    onSelect("workers");
    if (shells.length === 1 && defaultShell) {
      onAddWorker(defaultShell.id);
      return;
    }
    setPickerOpen((open) => !open);
  };

  return (
    <div
      style={{
        flex: "0 0 36px",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule-soft)",
        position: "relative",
      }}
    >
      <WorkbenchTabButton
        label="WORKERS"
        count={workerCount}
        active={active === "workers"}
        onClick={() => onSelect("workers")}
      />
      {runCount > 0 && (
        <WorkbenchTabButton
          label="RUNS"
          count={runCount}
          active={active === "runs"}
          onClick={() => onSelect("runs")}
        />
      )}
      {fileCount > 0 && (
        <WorkbenchTabButton
          label="EDITOR"
          count={fileCount}
          active={active === "editor"}
          onClick={() => onSelect("editor")}
        />
      )}
      <div style={{ flex: 1 }} />
      {active === "workers" && (
        <div ref={pickerRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <button
            type="button"
            onClick={handleAdd}
            disabled={shells.length === 0}
            title="New worker"
            style={{
              appearance: "none",
              width: 24,
              height: 24,
              border: "1px solid var(--rule-soft)",
              borderRadius: 5,
              background: "color-mix(in oklch, var(--ink) 2%, transparent)",
              color: shells.length > 0 ? "var(--ink-dim)" : "var(--muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              cursor: "default",
              transition:
                "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              if (shells.length > 0) {
                e.currentTarget.style.background = "var(--hover)";
                e.currentTarget.style.borderColor = "var(--rule-strong)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "color-mix(in oklch, var(--ink) 2%, transparent)";
              e.currentTarget.style.borderColor = "var(--rule-soft)";
            }}
          >
            <PlusIcon size={12} />
          </button>
          {pickerOpen && (
            <ShellPicker
              shells={shells}
              defaultShell={defaultShell}
              onPick={(shell) => {
                setPickerOpen(false);
                onAddWorker(shell.id);
              }}
            />
          )}
        </div>
      )}
      {showLayoutPill && (
        <div
          style={{
            height: 24,
            padding: "0 10px",
            display: "flex",
            alignItems: "center",
            gap: 7,
            border: "1px solid var(--rule-soft)",
            borderRadius: 999,
            background: "color-mix(in oklch, var(--ink) 2%, transparent)",
            color: "var(--muted)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 700,
              fontSize: 9,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            LAYOUT
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              fontVariantNumeric: "tabular-nums",
              color: "var(--ink-dim)",
            }}
          >
            {activeDims.cols}×{activeDims.rows}
          </span>
        </div>
      )}
    </div>
  );
}

function WorkbenchTabButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 54%, var(--rule-strong))"
          : hover
            ? "1px solid var(--rule-soft)"
            : "1px solid transparent",
        borderRadius: 7,
        background: active
          ? "color-mix(in oklch, var(--ink) 4%, var(--panel))"
          : hover
            ? "color-mix(in oklch, var(--ink) 4%, transparent)"
            : "transparent",
        color: active ? "var(--ink)" : hover ? "var(--ink-dim)" : "var(--muted)",
        minHeight: 26,
        padding: "0 9px 0 10px",
        display: "flex",
        alignItems: "center",
        gap: 7,
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        cursor: "default",
        position: "relative",
        boxShadow: active
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 16%, transparent), 0 8px 18px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.035)"
          : "none",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      {active && (
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: "var(--accent)",
            boxShadow: "0 0 9px var(--accent-glow)",
            flex: "0 0 7px",
          }}
        />
      )}
      <span>{label}</span>
      {count !== undefined && (
        <span
          style={{
            minWidth: 18,
            textAlign: "center",
            padding: "1px 5px",
            border: active
              ? "1px solid color-mix(in oklch, var(--accent) 34%, var(--rule-soft))"
              : "1px solid var(--rule-soft)",
            borderRadius: 4,
            background: "color-mix(in oklch, var(--ink) 3%, transparent)",
            color: active ? "var(--ink-dim)" : "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            fontVariantNumeric: "tabular-nums",
            letterSpacing: 0,
            textTransform: "none",
          }}
        >
          {String(count).padStart(2, "0")}
        </span>
      )}
    </button>
  );
}

function ShellPicker({
  shells,
  defaultShell,
  onPick,
}: {
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  onPick: (shell: ShellInfo) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 30,
        right: 0,
        zIndex: 50,
        background: "var(--panel-2)",
        border: "1px solid var(--rule-strong)",
        borderRadius: 8,
        boxShadow: "var(--shadow-2)",
        minWidth: 240,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          fontWeight: 600,
          color: "var(--muted)",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        SHELL
      </div>
      <div style={{ maxHeight: 320, overflow: "auto" }}>
        {shells.map((shell) => {
          const isDefault = defaultShell?.id === shell.id;
          return (
            <button
              key={shell.id}
              type="button"
              onClick={() => onPick(shell)}
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
                transition:
                  "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover-strong)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)", opacity: isDefault ? 1 : 0, flex: "0 0 6px" }} />
              <span style={{ flex: 1 }}>{shell.label}</span>
              <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>{shell.family}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NoWorkspace({ onCreate }: { onCreate: () => void }) {
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
}

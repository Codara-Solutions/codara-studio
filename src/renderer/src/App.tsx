import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, AppState, FsEntry, ShellInfo, SparkEvent, Worker, Workspace } from "@shared/types";
import WindowChrome from "./components/WindowChrome";
import WorkspaceRail, { WORKSPACE_COLORS } from "./components/WorkspaceRail";
import TerminalGrid from "./components/TerminalGrid";
import FileTree from "./components/FileTree";
import EditorGrid from "./components/EditorGrid";
import RunsView from "./components/RunsView";
import OrchestrationSidebar from "./components/OrchestrationSidebar";
import StatusBar from "./components/StatusBar";
import SettingsDialog from "./components/SettingsDialog";
import { PlusIcon } from "./components/icons";
import type { ShellIntegration } from "./terminal/shell-integration";
import { basename } from "./path-utils";

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

function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  // Match TerminalGrid: true square (side x side). The LAYOUT label in the
  // header has to agree with what the grid actually renders.
  const side = Math.ceil(Math.sqrt(n));
  return { cols: side, rows: side };
}

function resolveDefaultShell(
  shells: ShellInfo[],
  settings: AppSettings,
  detectedDefault: ShellInfo | null,
): ShellInfo | null {
  return shells.find((shell) => shell.id === settings.defaultShellId) ?? detectedDefault ?? shells[0] ?? null;
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
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [defaultShell, setDefaultShell] = useState<ShellInfo | null>(null);
  const [detectedDefaultShell, setDetectedDefaultShell] = useState<ShellInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      if (event.type === "run.deleted") {
        window.setTimeout(() => void refreshRunCount(event.workspaceId), 500);
      }
    });
  }, [booted, refreshRunCount]);

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
          // no longer pad — the grid auto-sizes around the actual worker
          // count, so 1 worker = 1 pane, 4 workers = 2x2, etc.
          const real = workspace.workers.filter((w) => w.kind !== "autofill");
          for (const stale of workspace.workers) {
            if (stale.kind === "autofill") void window.spark.pty.dispose(stale.id);
          }
          return { ...workspace, workers: [...real, pane] };
        }),
      );
      if (event.workspaceId === activeId) setActiveWorkbenchTab("workers");
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

  // Quick-test buttons: launch claude/codex in the first non-orchestration
  // worker pane, or spawn a new one if none exist. Mirrors what the user does
  // manually — types `claude --dangerously-skip-permissions ... ⏎`, waits for
  // the CLI to start, types the test prompt, presses Enter.
  const handleQuickTest = useCallback(
    async (runtime: "claude" | "codex") => {
      if (!activeWorkspace) return;
      const reusable = activeWorkspace.workers.find((w) => {
        if (w.kind === "orchestration") return false;
        // The integration's state flips to "running" the moment Enter is
        // pressed (spark.ps1 emits OSC 633;C live via PSReadLine), so a pane
        // hosting an active CLI is correctly skipped. Once the CLI exits and
        // pwsh re-prompts (633;D + 633;A), state goes idle and the pane is
        // up for grabs again.
        const integration = workerIntegrationsRef.current.get(w.id);
        if (integration?.isBusy()) return false;
        return true;
      });
      let workerId = reusable?.id;
      let waitForSpawnMs = 0;
      if (!workerId) {
        const shellId = defaultShell?.id ?? shells[0]?.id;
        if (!shellId) return;
        const id = uid("w");
        workerId = id;
        setWorkspaces((list) =>
          list.map((w) =>
            w.id === activeWorkspace.id
              ? { ...w, workers: [...w.workers, { id, shellId, kind: "terminal" }] }
              : w,
          ),
        );
        waitForSpawnMs = 1500;
      }
      setActiveWorkbenchTab("workers");
      if (waitForSpawnMs > 0) await new Promise((r) => setTimeout(r, waitForSpawnMs));
      const launch =
        runtime === "claude"
          ? "claude --dangerously-skip-permissions --model claude-opus-4-7 --effort medium\r"
          : "codex --yolo\r";
      await window.spark.pty.write(workerId, launch);
      const cliWarmupMs = runtime === "claude" ? 3500 : 4000;
      await new Promise((r) => setTimeout(r, cliWarmupMs));
      const promptBody = "make a one file html calculator";
      if (runtime === "codex") {
        // Codex's input box is in multi-line mode by default — a bare \r
        // inserts a newline, you have to lift it out of paste mode and then
        // press Enter to submit. Bracket the body as a paste, idle ~1.2s for
        // the TUI to commit it, then Enter twice (some codex builds need a
        // second to confirm).
        const PASTE_BEGIN = "\x1b[200~";
        const PASTE_END = "\x1b[201~";
        await window.spark.pty.write(workerId, `${PASTE_BEGIN}${promptBody}${PASTE_END}`);
        await new Promise((r) => setTimeout(r, 1200));
        await window.spark.pty.write(workerId, "\r");
        await new Promise((r) => setTimeout(r, 700));
        await window.spark.pty.write(workerId, "\r");
      } else {
        await window.spark.pty.write(workerId, `${promptBody}\r`);
      }
    },
    [activeWorkspace, defaultShell, shells],
  );

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
        leftOn={showLeft}
        rightOn={showRight}
        onToggleLeft={() => setShowLeft((v) => !v)}
        onToggleRight={() => setShowRight((v) => !v)}
        onOpenSettings={() => setSettingsOpen(true)}
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
                  <EditorGrid
                    files={openFiles}
                    activePath={activeEditorPath}
                    onActivateFile={setActiveEditorPath}
                    onCloseFile={closeEditorFile}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: activeWorkbenchTab === "runs" ? "flex" : "none" }}>
                  <RunsView workspace={ws} />
                </div>
              </div>
            ))
          )}
        </main>

        {showRight && (
          <RightPanel
            workspace={activeWorkspace}
            activePath={activeEditorPath}
            onOpenFile={openEditorFile}
            onDeleteFile={closeEditorFile}
            onRenameFile={(oldPath, entry) => {
              setOpenFiles((files) =>
                files.map((file) => (file.path === oldPath ? entry : file)),
              );
              setActiveEditorPath((current) => (current === oldPath ? entry.path : current));
            }}
            onQuickTest={handleQuickTest}
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
  onOpenFile,
  onDeleteFile,
  onRenameFile,
  onQuickTest,
}: {
  workspace: Workspace | null;
  activePath: string | null;
  onOpenFile: (entry: FsEntry) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, entry: FsEntry) => void;
  onQuickTest: (runtime: "claude" | "codex") => void;
}) {
  const cwd = workspace?.cwd ?? null;
  return (
    <aside
      style={{
        width: RIGHT_WIDTH,
        flex: `0 0 ${RIGHT_WIDTH}px`,
        borderLeft: "1px solid var(--rule)",
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <OrchestrationSidebar workspace={workspace} onQuickTest={onQuickTest} />
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
  const workerDims = gridDims(workerCount);
  const activeDims = active === "editor" ? gridDims(fileCount) : workerDims;

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
        flex: "0 0 34px",
        display: "flex",
        alignItems: "stretch",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule)",
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
        <div ref={pickerRef} style={{ position: "relative", display: "flex", alignItems: "center", padding: "0 8px" }}>
          <button
            type="button"
            onClick={handleAdd}
            disabled={shells.length === 0}
            title="New worker"
            style={{
              appearance: "none",
              width: 24,
              height: 24,
              border: "1px solid var(--rule-strong)",
              background: "var(--bg)",
              color: shells.length > 0 ? "var(--ink-dim)" : "var(--muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 0,
              cursor: "default",
            }}
          >
            <PlusIcon />
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
      <div
        style={{
          padding: "0 14px",
          display: "flex",
          alignItems: "center",
          color: "var(--muted)",
          fontSize: 10,
          letterSpacing: "0.08em",
        }}
      >
        LAYOUT&nbsp;<b style={{ color: "var(--ink-dim)" }}>{activeDims.cols}×{activeDims.rows}</b>
      </div>
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
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        border: "none",
        borderRight: "1px solid var(--rule)",
        background: active ? "var(--bg)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "0 16px",
        display: "flex",
        alignItems: "center",
        gap: 9,
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
        cursor: "default",
        position: "relative",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background: "var(--accent)",
          }}
        />
      )}
      <span>{label}</span>
      {count !== undefined && (
        <span
          style={{
            minWidth: 20,
            textAlign: "center",
            padding: "1px 5px",
            border: "1px solid var(--rule-strong)",
            color: active ? "var(--ink)" : "var(--muted)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
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
        top: 34,
        right: 0,
        zIndex: 50,
        background: "var(--panel-2)",
        border: "1px solid var(--rule-strong)",
        boxShadow: "0 6px 24px rgba(0,0,0,0.4)",
        minWidth: 240,
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          fontSize: 10,
          letterSpacing: "0.14em",
          fontWeight: 700,
          color: "var(--muted)",
          borderBottom: "1px solid var(--rule)",
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
                fontFamily: "inherit",
                fontSize: 12,
                cursor: "default",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ width: 8, height: 8, background: "var(--accent)", opacity: isDefault ? 1 : 0 }} />
              <span style={{ flex: 1 }}>{shell.label}</span>
              <span style={{ color: "var(--muted)", fontSize: 10 }}>{shell.family}</span>
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
        gap: 16,
        background: "var(--bg)",
        color: "var(--muted)",
      }}
    >
      <div style={{ fontSize: 12, letterSpacing: "0.18em", fontWeight: 700 }}>NO WORKSPACE</div>
      <button
        type="button"
        onClick={onCreate}
        style={{
          appearance: "none",
          background: "transparent",
          border: "1px solid var(--rule-strong)",
          color: "var(--ink-dim)",
          padding: "8px 14px",
          fontSize: 11,
          fontFamily: "inherit",
          letterSpacing: "0.1em",
          fontWeight: 700,
          cursor: "default",
        }}
      >
        + NEW WORKSPACE
      </button>
    </div>
  );
}

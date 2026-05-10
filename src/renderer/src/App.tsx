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
import FileTree from "./components/FileTree";
import OrchestrationSidebar from "./components/OrchestrationSidebar";
import StatusBar from "./components/StatusBar";
import SettingsDialog from "./components/SettingsDialog";
import SearchPanel from "./components/Search/SearchPanel";
import TerminalGrid from "./components/TerminalGrid";
import TabBar from "./tabs/TabBar";
import EditorStack from "./tabs/EditorStack";
import TerminalStack from "./tabs/TerminalStack";
import PreviewStack from "./tabs/PreviewStack";
import RunsStack from "./tabs/RunsStack";
import { useTabs } from "./tabs/useTabs";
import type { ShellIntegration } from "./terminal/shell-integration";
import { basename } from "./path-utils";
import ShortcutsDialog from "./shortcuts/ShortcutsDialog";
import { useGlobalShortcuts, type ShortcutHandlers } from "./shortcuts/useGlobalShortcuts";

const RAIL_WIDTH = 240;
const RIGHT_WIDTH = 360;

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
  const saveTimer = useRef<number | null>(null);
  // Per-pane shell integrations registered as orchestration worker panes
  // mount. Spark's orchestration runner uses this to ask "is this terminal
  // currently running a command or hosting a TUI?" before pasting prompts.
  // Worker panes themselves are no longer rendered in the workspace tab
  // strip — they live on the runs canvas only — but the orchestration
  // event flow that creates them still runs, so the registry is wired up.
  const workerIntegrationsRef = useRef<Map<string, ShellIntegration>>(new Map());
  const registerWorkerIntegration = useCallback(
    (workerId: string, integration: ShellIntegration | null) => {
      if (integration) workerIntegrationsRef.current.set(workerId, integration);
      else workerIntegrationsRef.current.delete(workerId);
    },
    [],
  );

  // Tabs are scoped per-workspace so each workspace remembers its own layout.
  // useTabs internally swaps tab lists when the workspaceId argument changes.
  const tabs = useTabs(activeId);

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
        w.id === workspaceId
          ? { ...w, workers: w.workers.filter((x) => x.id !== workerId) }
          : w,
      ),
    );
  }, []);

  // ── File / editor tab integration ──────────────────────────────────────────

  const openEditorFile = useCallback(
    (entry: FsEntry) => {
      tabs.openEditorTab(entry);
    },
    [tabs],
  );

  // Open a file by absolute path. Used by the terminal's OSC 8888 handler
  // (`tp <file>` / `spark_open <file>` from a shell). Falls back to a
  // synthesized FsEntry — opening a file is best-effort UX.
  const openFileByPath = useCallback(
    (path: string) => {
      if (!path) return;
      tabs.openEditorTab(entryFromPath(path));
    },
    [tabs],
  );

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
    (terminalId: string, url: string) => {
      tabs.setDetectedUrl(terminalId, url);
      // Re-broadcast so other listeners (status bar, agent bridge) can
      // react without coupling directly to the terminal stack.
      window.dispatchEvent(
        new CustomEvent("spark:detected-url", {
          detail: { url, sessionId: terminalId },
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

      // Suppress repeats for this terminal pointing at the same origin.
      const last = lastOpenedUrlByTerminalRef.current.get(terminalId);
      if (last && sameOrigin(last, url)) return;
      lastOpenedUrlByTerminalRef.current.set(terminalId, url);

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
    const raw = window.prompt("URL to preview", "http://localhost:3000");
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    tabs.newPreviewTab(url);
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
    }),
    [handleNewEditorTab, handleNewPreviewTab, handleNewTerminalTab, tabs],
  );

  useGlobalShortcuts(shortcutHandlers);

  // Dispose PTYs when terminal tabs close.
  const onTerminalExit = useCallback(
    (tabId: string) => {
      void window.spark.pty.dispose(tabId);
      // Reflect "exited" by closing the tab automatically would be too
      // aggressive — many users want to read the final stdout. We just
      // let it sit; closing the tab via the X disposes the pty.
      void tabId;
    },
    [],
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
            <Workspace
              tabs={tabs}
              workspace={activeWorkspace}
              shell={terminalShell}
              shells={shells}
              defaultShell={defaultShell}
              runs={runs}
              activeRunId={activeRunId}
              onSelectRun={setActiveRunId}
              onDetectedUrl={handleDetectedUrl}
              onSparkOpenFile={openFileByPath}
              onTerminalExit={onTerminalExit}
              onPreviewUrlChange={handlePreviewUrlChange}
              onAddWorker={(shellId) =>
                activeWorkspace && addWorker(activeWorkspace.id, shellId)
              }
              onRemoveWorker={(workerId) =>
                activeWorkspace && removeWorker(activeWorkspace.id, workerId)
              }
              onWorkerIntegration={registerWorkerIntegration}
              onNewTerminalTab={handleNewTerminalTab}
              onNewEditorTab={handleNewEditorTab}
              onNewPreviewTab={handleNewPreviewTab}
            />
          )}
        </main>

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
            onSelectRun={setActiveRunId}
            onOpenFile={openEditorFile}
            onDeleteFile={(path) => tabs.closeEditorByPath(path)}
            onRenameFile={(oldPath, entry) => tabs.setEditorEntry(oldPath, entry)}
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
      />
    </div>
  );
}

// ── Workspace pane (tab strip + stacks) ──────────────────────────────────────

interface WorkspaceProps {
  tabs: ReturnType<typeof useTabs>;
  workspace: Workspace | null;
  shell: ShellInfo | null;
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
  onDetectedUrl: (terminalId: string, url: string) => void;
  onSparkOpenFile: (path: string) => void;
  onTerminalExit: (terminalId: string) => void;
  onPreviewUrlChange: (id: string, url: string) => void;
  onAddWorker: (shellId: string) => void;
  onRemoveWorker: (workerId: string) => void;
  onWorkerIntegration: (id: string, integration: ShellIntegration | null) => void;
  onNewTerminalTab: () => void;
  onNewEditorTab: () => void;
  onNewPreviewTab: () => void;
}

function Workspace({
  tabs,
  workspace,
  shell,
  shells,
  defaultShell,
  runs,
  activeRunId,
  onSelectRun,
  onDetectedUrl,
  onSparkOpenFile,
  onTerminalExit,
  onPreviewUrlChange,
  onAddWorker,
  onRemoveWorker,
  onWorkerIntegration,
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
          onExit={(id) => onTerminalExit(id)}
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
        {/* Orchestration worker grid is mounted hidden so worker PTYs stay
            alive across tab switches and orchestration writes can target
            the right session. The user-facing surface is the runs canvas;
            the grid here is purely for keeping the underlying xterms
            attached and reporting integration state. Without this mount,
            the renderer would never call pty.spawn for orchestration
            workers, breaking every run. */}
        {workspace ? (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              visibility: "hidden",
              pointerEvents: "none",
              zIndex: 0,
            }}
          >
            <TerminalGrid
              workspace={workspace}
              shells={shells}
              defaultShell={defaultShell}
              onAddWorker={onAddWorker}
              onRemoveWorker={onRemoveWorker}
              onWorkerIntegration={onWorkerIntegration}
            />
          </div>
        ) : null}
      </div>
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

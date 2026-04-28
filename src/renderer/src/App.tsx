import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, ShellInfo, Workspace } from "@shared/types";
import WindowChrome from "./components/WindowChrome";
import WorkspaceRail, { WORKSPACE_COLORS } from "./components/WorkspaceRail";
import TerminalGrid from "./components/TerminalGrid";
import FileTree from "./components/FileTree";
import SparkAgentPanel from "./components/SparkAgentPanel";
import StatusBar from "./components/StatusBar";
import { basename } from "./path-utils";

const RAIL_WIDTH = 240;
const RIGHT_WIDTH = 360;

function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function App() {
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [defaultShell, setDefaultShell] = useState<ShellInfo | null>(null);
  const [platform, setPlatform] = useState<string>("");
  const [home, setHome] = useState<string>("");
  const saveTimer = useRef<number | null>(null);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [state, sh, def, plat, hm] = await Promise.all([
          window.spark.state.load(),
          window.spark.shells.list(),
          window.spark.shells.default(),
          window.spark.app.platform(),
          window.spark.app.home(),
        ]);
        if (cancelled) return;
        setWorkspaces(state.workspaces);
        setActiveId(state.activeWorkspaceId);
        setShells(sh);
        setDefaultShell(def);
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

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  // Theme the entire UI with the active workspace's color. Falls back to the
  // default yellow when nothing is active.
  useEffect(() => {
    const accent = activeWorkspace?.color || "#F0C419";
    document.documentElement.style.setProperty("--accent", accent);
  }, [activeWorkspace?.color]);

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
      />

      <div style={{ flex: 1, display: "flex", minHeight: 0, position: "relative" }}>
        {showLeft && (
          <WorkspaceRail
            workspaces={workspaces}
            activeId={activeId}
            editingId={editingId}
            width={RAIL_WIDTH}
            onActivate={(id) => setActiveId(id)}
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
          {activeWorkspace ? (
            <TerminalGrid
              key={activeWorkspace.id}
              workspace={activeWorkspace}
              shells={shells}
              defaultShell={defaultShell}
              onAddWorker={(shellId) => addWorker(activeWorkspace.id, shellId)}
              onRemoveWorker={(workerId) => removeWorker(activeWorkspace.id, workerId)}
            />
          ) : (
            <NoWorkspace onCreate={createWs} />
          )}
        </main>

        {showRight && (
          <RightPanel cwd={activeWorkspace?.cwd ?? null} />
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

function RightPanel({ cwd }: { cwd: string | null }) {
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
      <SparkAgentPanel />
      {cwd ? (
        <FileTree cwd={cwd} />
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

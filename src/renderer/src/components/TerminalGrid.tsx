import React, { useEffect, useState } from "react";
import type { ShellInfo, Worker, Workspace } from "@shared/types";
import TerminalView from "./Terminal";
import type { ShellIntegration, ShellIntegrationState } from "../terminal/shell-integration";
import { CloseIcon } from "./icons";
import { getWorkerGridLayout, type WorkerGridLayout } from "../worker-grid-layout";

interface Props {
  workspace: Workspace;
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  onAddWorker: (shellId: string) => void;
  onRemoveWorker: (workerId: string) => void;
  onWorkerIntegration?: (workerId: string, integration: ShellIntegration | null) => void;
  fontSize?: number;
}

export default function TerminalGrid({
  workspace,
  shells,
  defaultShell,
  onAddWorker,
  onRemoveWorker,
  onWorkerIntegration,
  fontSize,
}: Props) {
  const workers = workspace.workers;
  const [activeWorker, setActiveWorker] = useState<string | null>(workers[0]?.id ?? null);

  useEffect(() => {
    if (workers.length === 0) {
      setActiveWorker(null);
    } else if (!activeWorker || !workers.find((w) => w.id === activeWorker)) {
      setActiveWorker(workers[0].id);
    }
  }, [workers, activeWorker]);

  const layout = getWorkerGridLayout(workers.length);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        borderTop: "1px solid color-mix(in oklch, var(--rule-soft) 55%, transparent)",
      }}
    >
      {workers.length === 0 ? (
        <EmptyWorkers
          shells={shells}
          defaultShell={defaultShell}
          onAdd={(shellId) => onAddWorker(shellId)}
        />
      ) : (
        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
            gridAutoRows: "minmax(0, 1fr)",
            gap: 6,
            padding: 6,
            background: "color-mix(in oklch, var(--bg) 76%, var(--panel-3))",
            minHeight: 0,
          }}
        >
          {workers.map((w, index) => {
            const shell = shells.find((s) => s.id === w.shellId) ?? defaultShell;
            if (!shell) return null;
            return (
              <WorkerPane
                key={w.id}
                worker={w}
                shell={shell}
                cwd={workspace.cwd}
                active={activeWorker === w.id}
                onActivate={() => setActiveWorker(w.id)}
                onClose={() => onRemoveWorker(w.id)}
                onWorkerIntegration={onWorkerIntegration}
                fontSize={fontSize}
                gridStyle={workerPaneGridStyle(index, layout)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function workerPaneGridStyle(index: number, layout: WorkerGridLayout): React.CSSProperties | undefined {
  if (layout.featureFirst && index === 0) return { gridRow: "span 2" };
  return undefined;
}

interface WorkerPaneProps {
  worker: Worker;
  shell: ShellInfo;
  cwd: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onWorkerIntegration?: (workerId: string, integration: ShellIntegration | null) => void;
  fontSize?: number;
  gridStyle?: React.CSSProperties;
}

function WorkerPane({
  worker,
  shell,
  cwd,
  active,
  onActivate,
  onClose,
  onWorkerIntegration,
  fontSize,
  gridStyle,
}: WorkerPaneProps) {
  const [integration, setIntegration] = useState<ShellIntegration | null>(null);
  const [shellState, setShellState] = useState<ShellIntegrationState | null>(null);

  useEffect(() => {
    onWorkerIntegration?.(worker.id, integration);
    return () => {
      onWorkerIntegration?.(worker.id, null);
    };
  }, [worker.id, integration, onWorkerIntegration]);

  useEffect(() => {
    if (!integration) {
      setShellState(null);
      return undefined;
    }
    return integration.subscribe(setShellState);
  }, [integration]);

  const activity = paneActivity(worker, shellState);

  return (
    <div
      onMouseDown={onActivate}
      style={{
        ...gridStyle,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        border: active
          ? "1px solid color-mix(in oklch, var(--accent) 34%, var(--rule))"
          : "1px solid color-mix(in oklch, var(--rule) 62%, transparent)",
        borderRadius: 6,
        boxShadow: active
          ? "inset 0 0 0 1px color-mix(in oklch, var(--accent) 22%, transparent), 0 0 0 1px color-mix(in oklch, var(--accent) 26%, transparent), 0 14px 34px rgba(0,0,0,0.22)"
          : "inset 0 1px 0 rgba(255,255,255,0.02), 0 8px 20px rgba(0,0,0,0.14)",
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
        transition: "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      <PaneHeader
        active={active}
        title={activity.title}
        busy={activity.busy}
        onClose={onClose}
      />
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <TerminalView
          workerId={worker.id}
          shell={shell}
          cwd={cwd}
          active={active}
          onPid={() => undefined}
          fontSize={fontSize}
          runtime={worker.runtime}
          onShellIntegration={setIntegration}
        />
      </div>
    </div>
  );
}

function PaneHeader({
  active,
  title,
  busy,
  onClose,
}: {
  active: boolean;
  title: string;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minHeight: 24,
        padding: "4px 6px 0",
        borderBottom: "0",
        background: "transparent",
        flex: "0 0 auto",
        fontSize: 9,
        opacity: active ? 0.96 : 0.68,
        transition: "opacity var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
      }}
    >
      <span
        title={title}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: "min(42vw, 360px)",
          minWidth: 0,
          height: 17,
          padding: "0 9px",
          borderRadius: 999,
          border: "1px solid color-mix(in oklch, var(--rule-strong) 34%, transparent)",
          background: active
            ? "color-mix(in oklch, var(--panel-2) 58%, transparent)"
            : "color-mix(in oklch, var(--panel) 44%, transparent)",
          boxShadow: active
            ? "0 5px 18px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.035)"
            : "0 4px 14px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.02)",
        }}
      >
        <span
          style={{
            width: busy ? 5 : 4,
            height: busy ? 5 : 4,
            borderRadius: 999,
            background: busy
              ? "color-mix(in oklch, var(--accent) 82%, var(--ink))"
              : "color-mix(in oklch, var(--muted) 46%, transparent)",
            boxShadow: busy ? "0 0 10px var(--accent-glow)" : "none",
            flex: "0 0 auto",
          }}
        />
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: active ? "var(--ink-dim)" : "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: busy ? 600 : 500,
            lineHeight: "16px",
            letterSpacing: "0",
          }}
        >
          {title}
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close worker"
        style={{
          appearance: "none",
          background: active
            ? "color-mix(in oklch, var(--panel-2) 42%, transparent)"
            : "color-mix(in oklch, var(--panel) 28%, transparent)",
          border: "1px solid color-mix(in oklch, var(--rule-strong) 25%, transparent)",
          borderRadius: 999,
          color: "var(--muted)",
          width: 17,
          height: 17,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          opacity: active ? 0.52 : 0.34,
          transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--danger-soft)";
          e.currentTarget.style.color = "var(--ink-dim)";
          e.currentTarget.style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = active
            ? "color-mix(in oklch, var(--panel-2) 42%, transparent)"
            : "color-mix(in oklch, var(--panel) 28%, transparent)";
          e.currentTarget.style.color = "var(--muted)";
          e.currentTarget.style.opacity = active ? "0.52" : "0.34";
        }}
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}

function paneActivity(worker: Worker, state: ShellIntegrationState | null): { title: string; busy: boolean } {
  const running = state?.blocks
    .slice()
    .reverse()
    .find((block) => block.status === "running");

  if (running) {
    return {
      title: titleForCommand(running.command, worker) ?? runtimeTitle(worker.runtime) ?? "Running",
      busy: true,
    };
  }

  if (state?.altScreen) {
    return {
      title: runtimeTitle(worker.runtime) ?? "Running",
      busy: true,
    };
  }

  if (worker.kind === "orchestration" && worker.runtime && worker.runtime !== "shell" && worker.runtime !== "manual") {
    return {
      title: runtimeTitle(worker.runtime) ?? "Running",
      busy: true,
    };
  }

  return { title: worker.name?.trim() || "Ready", busy: false };
}

function titleForCommand(command: string, worker: Worker): string | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  const binary = commandBinaryName(normalized);
  if (binary === "claude") return "Claude Code";
  if (binary === "codex") return "Codex";

  const runtime = runtimeTitle(worker.runtime);
  if (runtime && (normalized.toLowerCase().startsWith(`${worker.runtime} `) || normalized.toLowerCase() === worker.runtime)) {
    return runtime;
  }

  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function commandBinaryName(command: string): string {
  let text = command.trim();
  if (text.startsWith("&")) text = text.slice(1).trim();

  let token = "";
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    const end = text.indexOf(quote, 1);
    token = end >= 0 ? text.slice(1, end) : text.slice(1);
  } else {
    token = text.split(/\s+/, 1)[0] ?? "";
  }

  return token
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(exe|cmd|bat|ps1|sh)$/i, "")
    .toLowerCase() ?? "";
}

function runtimeTitle(runtime: Worker["runtime"]): string | null {
  switch (runtime) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "shell":
    case "manual":
      return null;
    default:
      return null;
  }
}

function EmptyWorkers({
  shells,
  defaultShell,
  onAdd,
}: {
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  onAdd: (shellId: string) => void;
}) {
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
        color: "var(--muted)",
        padding: 24,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          fontWeight: 600,
          color: "var(--ink-dim)",
        }}
      >
        NO WORKERS
      </div>
      <div style={{ fontFamily: "var(--font-sans)", fontSize: 13, color: "var(--muted)" }}>
        Spawn a terminal in this workspace's directory.
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", maxWidth: 600, marginTop: 4 }}>
        {(defaultShell ? [defaultShell, ...shells.filter((s) => s.id !== defaultShell.id)] : shells).map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onAdd(s.id)}
            style={{
              appearance: "none",
              background: "transparent",
              border: "1px solid var(--rule-strong)",
              color: "var(--ink-dim)",
              padding: "8px 12px",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "default",
              letterSpacing: "0.02em",
              transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--hover)";
              e.currentTarget.style.color = "var(--ink)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--ink-dim)";
            }}
          >
            + {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

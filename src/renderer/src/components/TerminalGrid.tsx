import React, { useEffect, useState } from "react";
import type { ShellInfo, Worker, Workspace } from "@shared/types";
import TerminalView from "./Terminal";
import BlockStrip from "./BlockStrip";
import type { ShellIntegration } from "../terminal/shell-integration";
import { CloseIcon } from "./icons";

interface Props {
  workspace: Workspace;
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  onAddWorker: (shellId: string) => void;
  onRemoveWorker: (workerId: string) => void;
  fontSize?: number;
}

function gridDims(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  // True square grid: side = ceil(sqrt(n)) for both axes. 1 → 1×1, 2-4 → 2×2,
  // 5-9 → 3×3. Slots beyond `n` render as empty placeholders so the visible
  // pane sizes stay consistent as workers are added/removed.
  const side = Math.ceil(Math.sqrt(n));
  return { cols: side, rows: side };
}

function shellLabel(s: ShellInfo): string {
  return s.label;
}

export default function TerminalGrid({
  workspace,
  shells,
  defaultShell,
  onAddWorker,
  onRemoveWorker,
  fontSize,
}: Props) {
  const workers = workspace.workers;
  const [activeWorker, setActiveWorker] = useState<string | null>(workers[0]?.id ?? null);
  const [pids, setPids] = useState<Record<string, number>>({});

  useEffect(() => {
    if (workers.length === 0) {
      setActiveWorker(null);
    } else if (!activeWorker || !workers.find((w) => w.id === activeWorker)) {
      setActiveWorker(workers[0].id);
    }
  }, [workers, activeWorker]);

  const dims = gridDims(workers.length);
  const hasOrchestration = workers.some((w) => w.kind === "orchestration");

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        borderTop: "1px solid var(--rule)",
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
            gridTemplateColumns: `repeat(${dims.cols}, 1fr)`,
            gridAutoRows: "1fr",
            gap: 1,
            background: "var(--rule)",
            minHeight: 0,
          }}
        >
          {workers.map((w) => {
            const shell = shells.find((s) => s.id === w.shellId) ?? defaultShell;
            if (!shell) return null;
            return (
              <WorkerPane
                key={w.id}
                worker={w}
                shell={shell}
                cwd={workspace.cwd}
                active={activeWorker === w.id}
                pid={pids[w.id]}
                onActivate={() => setActiveWorker(w.id)}
                onClose={() => onRemoveWorker(w.id)}
                onPid={(pid) => setPids((m) => ({ ...m, [w.id]: pid }))}
                fontSize={fontSize}
              />
            );
          })}
          {Array.from({ length: Math.max(0, dims.cols * dims.rows - workers.length) }).map((_, i) => (
            <EmptyPane
              key={`empty-${i}`}
              shells={shells}
              defaultShell={defaultShell}
              onAdd={onAddWorker}
              orchestrationActive={hasOrchestration}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface WorkerPaneProps {
  worker: Worker;
  shell: ShellInfo;
  cwd: string;
  active: boolean;
  pid?: number;
  onActivate: () => void;
  onClose: () => void;
  onPid: (pid: number) => void;
  fontSize?: number;
}

function WorkerPane({
  worker,
  shell,
  cwd,
  active,
  pid,
  onActivate,
  onClose,
  onPid,
  fontSize,
}: WorkerPaneProps) {
  const [integration, setIntegration] = useState<ShellIntegration | null>(null);
  const isOrchestration = worker.kind === "orchestration";

  return (
    <div
      onMouseDown={onActivate}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        outline: active ? "1px solid var(--accent)" : "none",
        outlineOffset: -1,
        overflow: "hidden",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <PaneHeader
        worker={worker}
        shell={shell}
        active={active}
        pid={pid}
        onClose={onClose}
      />
      {!isOrchestration && (
        <BlockStrip
          integration={integration}
          onCopy={(text) => {
            void navigator.clipboard?.writeText(text);
          }}
        />
      )}
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <TerminalView
          workerId={worker.id}
          shell={shell}
          cwd={cwd}
          active={active}
          onPid={onPid}
          fontSize={fontSize}
          attachOnly={isOrchestration}
          onShellIntegration={isOrchestration ? undefined : setIntegration}
        />
      </div>
    </div>
  );
}

function PaneHeader({
  worker,
  shell,
  active,
  pid,
  onClose,
}: {
  worker: Worker;
  shell: ShellInfo;
  active: boolean;
  pid?: number;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        borderBottom: "1px solid var(--rule)",
        background: active ? "var(--panel-2)" : "var(--panel)",
        flex: "0 0 auto",
        fontSize: 11,
      }}
    >
      <ShellGlyph family={shell.family} />
      <span
        style={{
          fontWeight: 700,
          color: active ? "var(--ink)" : "var(--ink-dim)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        {shell.family}
      </span>
      <span style={{ color: "var(--muted)" }}>·</span>
      <span style={{ color: "var(--ink-dim)" }}>
        {worker.name || shellLabel(shell)}
      </span>
      <span style={{ flex: 1 }} />
      {pid !== undefined && (
        <span style={{ color: "var(--muted)", fontSize: 10 }}>pid {pid}</span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        title="Close worker"
        style={{
          appearance: "none",
          background: "transparent",
          border: "1px solid var(--rule)",
          color: "var(--muted)",
          width: 20,
          height: 20,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function EmptyPane({
  shells,
  defaultShell,
  onAdd,
  orchestrationActive,
}: {
  shells: ShellInfo[];
  defaultShell: ShellInfo | null;
  onAdd: (shellId: string) => void;
  orchestrationActive: boolean;
}) {
  // While an orchestration run is filling worker slots, the empty cells are
  // reserved for agents Spark will spawn itself. Showing a clickable "+" there
  // is a footgun — the user accidentally spawns an unrelated pwsh in the
  // middle of a run. Render an inert placeholder instead.
  if (orchestrationActive) {
    return (
      <div
        style={{
          background: "var(--bg)",
          minWidth: 0,
          minHeight: 0,
          opacity: 0.4,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--muted)",
          fontSize: 9,
          letterSpacing: "0.12em",
          fontWeight: 700,
          userSelect: "none",
        }}
      >
        AGENT&nbsp;SLOT
      </div>
    );
  }
  const target = defaultShell ?? shells[0] ?? null;
  return (
    <div
      onClick={() => target && onAdd(target.id)}
      style={{
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted)",
        fontSize: 22,
        fontWeight: 200,
        cursor: target ? "default" : "not-allowed",
        opacity: 0.35,
        minWidth: 0,
        minHeight: 0,
        userSelect: "none",
      }}
      title={target ? `New ${target.label}` : "No shells available"}
    >
      +
    </div>
  );
}

function ShellGlyph({ family }: { family: ShellInfo["family"] }) {
  const { text, color } = (() => {
    switch (family) {
      case "pwsh":
      case "powershell":
        return { text: ">_", color: "var(--info)" };
      case "cmd":
        return { text: "C:", color: "var(--ink-dim)" };
      case "wsl":
        return { text: "λ", color: "var(--accent)" };
      case "bash":
      case "zsh":
      case "fish":
      case "sh":
        return { text: "$", color: "var(--ok)" };
      default:
        return { text: "·", color: "var(--muted)" };
    }
  })();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 14,
        border: "1px solid var(--rule-strong)",
        fontSize: 9,
        fontWeight: 800,
        color,
      }}
    >
      {text}
    </span>
  );
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
        gap: 14,
        background: "var(--bg)",
        color: "var(--muted)",
      }}
    >
      <div style={{ fontSize: 11, letterSpacing: "0.14em", fontWeight: 700 }}>NO WORKERS</div>
      <div style={{ fontSize: 11, color: "var(--muted)" }}>
        Spawn a terminal in this workspace's directory.
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center", maxWidth: 600 }}>
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
              padding: "6px 10px",
              fontSize: 11,
              fontFamily: "inherit",
              cursor: "default",
              letterSpacing: "0.06em",
            }}
          >
            + {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

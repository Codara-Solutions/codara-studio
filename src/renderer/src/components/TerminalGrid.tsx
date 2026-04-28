import React, { useEffect, useRef, useState } from "react";
import type { ShellInfo, Worker, Workspace } from "@shared/types";
import TerminalView from "./Terminal";
import { CloseIcon, PlusIcon } from "./icons";

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
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols, rows };
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pids, setPids] = useState<Record<string, number>>({});
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (workers.length === 0) {
      setActiveWorker(null);
    } else if (!activeWorker || !workers.find((w) => w.id === activeWorker)) {
      setActiveWorker(workers[0].id);
    }
  }, [workers, activeWorker]);

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

  const dims = gridDims(workers.length);

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
      <PaneTabStrip
        count={workers.length}
        layout={`${dims.cols}×${dims.rows}`}
        onAdd={() => {
          if (shells.length === 1 && defaultShell) {
            onAddWorker(defaultShell.id);
            return;
          }
          setPickerOpen((v) => !v);
        }}
        canAdd={shells.length > 0}
      />
      {pickerOpen && (
        <ShellPicker
          ref={pickerRef}
          shells={shells}
          defaultShell={defaultShell}
          onPick={(s) => {
            setPickerOpen(false);
            onAddWorker(s.id);
          }}
        />
      )}

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
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <TerminalView
          workerId={worker.id}
          shell={shell}
          cwd={cwd}
          active={active}
          onPid={onPid}
          fontSize={fontSize}
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

function PaneTabStrip({
  count,
  layout,
  onAdd,
  canAdd,
}: {
  count: number;
  layout: string;
  onAdd: () => void;
  canAdd: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule)",
        flex: "0 0 auto",
        height: 36,
      }}
    >
      <div
        style={{
          padding: "0 18px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          borderRight: "1px solid var(--rule)",
          background: "var(--bg)",
          color: "var(--ink)",
          fontWeight: 700,
          fontSize: 12,
          letterSpacing: "0.04em",
          position: "relative",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: -1,
            left: 0,
            right: 0,
            height: 2,
            background: "var(--accent)",
          }}
        />
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="0.5" y="0.5" width="4" height="4" />
          <rect x="6.5" y="0.5" width="4" height="4" />
          <rect x="0.5" y="6.5" width="4" height="4" />
          <rect x="6.5" y="6.5" width="4" height="4" />
        </svg>
        <span style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>WORKERS</span>
        <span
          style={{
            fontSize: 10,
            padding: "1px 6px",
            border: "1px solid var(--rule-strong)",
            color: "var(--ink)",
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
          }}
        >
          {String(count).padStart(2, "0")}
        </span>
      </div>

      <button
        type="button"
        onClick={onAdd}
        disabled={!canAdd}
        title="Add worker"
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          borderRight: "1px solid var(--rule)",
          padding: "0 14px",
          color: canAdd ? "var(--ink-dim)" : "var(--muted)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "inherit",
          fontSize: 11,
          letterSpacing: "0.06em",
          fontWeight: 700,
          cursor: "default",
        }}
      >
        <PlusIcon />
        <span>NEW WORKER</span>
      </button>

      <div style={{ flex: 1 }} />

      <div
        style={{
          padding: "0 14px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontSize: 10,
          color: "var(--muted)",
          letterSpacing: "0.08em",
        }}
      >
        <span>
          LAYOUT&nbsp;<b style={{ color: "var(--ink-dim)" }}>{layout}</b>
        </span>
        <span>
          PANES&nbsp;<b style={{ color: "var(--ink-dim)" }}>{String(count).padStart(2, "0")}</b>
        </span>
      </div>
    </div>
  );
}

const ShellPicker = React.forwardRef<
  HTMLDivElement,
  {
    shells: ShellInfo[];
    defaultShell: ShellInfo | null;
    onPick: (s: ShellInfo) => void;
  }
>(function ShellPicker({ shells, defaultShell, onPick }, ref) {
  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        marginTop: 36,
        left: 230,
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
        {shells.map((s) => {
          const isDefault = defaultShell?.id === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s)}
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
              <span style={{ flex: 1 }}>{s.label}</span>
              <span style={{ color: "var(--muted)", fontSize: 10 }}>{s.family}</span>
            </button>
          );
        })}
        {shells.length === 0 && (
          <div style={{ padding: "12px", color: "var(--muted)", fontSize: 11 }}>
            No shells detected on this system.
          </div>
        )}
      </div>
    </div>
  );
});

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

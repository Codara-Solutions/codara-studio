import React, { useEffect, useState } from "react";
import type { RunState, RunStatus, Workspace } from "@shared/types";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRun: RunState | null;
  busy: boolean;
  error: string | null;
  onCreateRun: () => void;
  onAppendTestEvent: () => void;
  onSelectRun: (run: RunState) => void;
  onRefresh: () => void;
  onUpdateStatus: (status: RunStatus) => void;
  onCreateStep: () => void;
  onCreateWorkerTask: () => void;
  onDeleteRun: () => void;
}

export default function SparkAgentPanel({
  workspace,
  runs,
  activeRun,
  busy,
  error,
  onCreateRun,
  onAppendTestEvent,
  onSelectRun,
  onRefresh,
  onUpdateStatus,
  onCreateStep,
  onCreateWorkerTask,
  onDeleteRun,
}: Props) {
  const [deleteArmed, setDeleteArmed] = useState(false);

  useEffect(() => {
    setDeleteArmed(false);
  }, [activeRun?.id]);

  const handleDeleteRun = () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleteArmed(false);
    onDeleteRun();
  };

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "0 0 auto",
        borderBottom: "1px solid var(--rule)",
        background: "var(--panel)",
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--rule)",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            background: "var(--accent)",
            display: "inline-block",
            flex: "0 0 auto",
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1, minWidth: 0 }}>
          <span style={{ fontWeight: 800, letterSpacing: "0.04em" }}>SPARK&nbsp;AGENT</span>
          <span style={{ fontSize: 10, color: "var(--muted)" }}>
            {activeRun ? activeRun.status : "foundation"}
          </span>
        </div>
      </div>

      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--rule)" }}>
        <MetaRow label="WORKSPACE" value={workspace?.name ?? "none"} />
        <MetaRow label="RUNS" value={String(runs.length).padStart(2, "0")} />
        <MetaRow label="ACTIVE" value={activeRun?.id ?? "none"} />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr",
          gap: 6,
          padding: "10px 12px",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <PanelButton disabled={!workspace || busy} onClick={onCreateRun}>
          CREATE
        </PanelButton>
        <PanelButton disabled={!activeRun || busy} onClick={onAppendTestEvent}>
          TEST
        </PanelButton>
        <PanelButton disabled={!workspace || busy} onClick={onRefresh}>
          REFRESH
        </PanelButton>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          gap: 6,
          padding: "0 12px 10px",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <PanelButton disabled={!activeRun || busy} onClick={() => onUpdateStatus("running")}>
          RUN
        </PanelButton>
        <PanelButton disabled={!activeRun || busy} onClick={() => onUpdateStatus("complete")}>
          DONE
        </PanelButton>
        <PanelButton disabled={!activeRun || busy} onClick={onCreateStep}>
          STEP
        </PanelButton>
        <PanelButton disabled={!activeRun || busy} onClick={onCreateWorkerTask}>
          TASK
        </PanelButton>
        <PanelButton disabled={!activeRun || busy} onClick={handleDeleteRun} danger>
          {deleteArmed ? "SURE" : "DEL"}
        </PanelButton>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", color: "var(--danger)", fontSize: 11, borderBottom: "1px solid var(--rule)" }}>
          {error}
        </div>
      )}

      <div style={{ maxHeight: 92, overflow: "auto" }}>
        {runs.length === 0 ? (
          <div style={{ padding: "9px 12px", color: "var(--muted)", fontSize: 11 }}>
            {workspace ? "No runs yet." : "No active workspace."}
          </div>
        ) : (
          runs.slice(0, 5).map((run) => (
            <RunRow
              key={run.id}
              run={run}
              active={run.id === activeRun?.id}
              onClick={() => onSelectRun(run)}
            />
          ))
        )}
      </div>
    </section>
  );
}

function RunRow({
  run,
  active,
  onClick,
}: {
  run: RunState;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={run.id}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        borderTop: "1px solid var(--rule)",
        background: active ? "var(--panel-2)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 8,
        alignItems: "center",
        textAlign: "left",
        padding: "7px 12px",
        fontFamily: "inherit",
        cursor: "default",
      }}
    >
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 11,
          fontWeight: 800,
        }}
      >
        {run.title}
      </span>
      <span style={{ color: "var(--muted)", fontSize: 10 }}>{formatTime(run.updatedAt)}</span>
    </button>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "74px minmax(0, 1fr)",
        gap: 8,
        alignItems: "baseline",
        fontSize: 10,
        lineHeight: 1.7,
      }}
    >
      <span style={{ color: "var(--muted)", letterSpacing: "0.12em", fontWeight: 700 }}>
        {label}
      </span>
      <span
        title={value}
        style={{
          color: "var(--ink-dim)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PanelButton({
  disabled,
  onClick,
  danger,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        appearance: "none",
        background: "transparent",
        border: "1px solid var(--rule-strong)",
        color: disabled ? "var(--muted)" : danger ? "var(--danger)" : "var(--ink-dim)",
        minHeight: 28,
        padding: "5px 7px",
        fontFamily: "inherit",
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: "0.08em",
        cursor: "default",
      }}
    >
      {children}
    </button>
  );
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

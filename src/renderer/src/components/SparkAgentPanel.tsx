import React, { useState } from "react";
import type { PlanFile, RunState, Workspace } from "@shared/types";

interface Props {
  workspace: Workspace | null;
  runs: RunState[];
  activeRun: RunState | null;
  planFiles: PlanFile[];
  selectedPlanPath: string;
  busy: boolean;
  error: string | null;
  onStartAutopilot: () => void;
  onPauseRun: (reason: string) => void;
  onResumeRun: () => void;
  onAddUserMessage: (message: string) => void;
  onSelectPlan: (path: string) => void;
  onSelectRun: (run: RunState) => void;
  onRefresh: () => void;
}

export default function SparkAgentPanel({
  workspace,
  runs,
  activeRun,
  planFiles,
  selectedPlanPath,
  busy,
  error,
  onStartAutopilot,
  onPauseRun,
  onResumeRun,
  onAddUserMessage,
  onSelectPlan,
  onSelectRun,
  onRefresh,
}: Props) {
  const [humanInput, setHumanInput] = useState("");

  const sendHumanInput = () => {
    const message = humanInput.trim();
    if (!message) return;
    setHumanInput("");
    onAddUserMessage(message);
  };

  const stopRun = () => {
    const reason = humanInput.trim();
    onPauseRun(reason || "Paused by user");
  };

  const selectedPlan = planFiles.find((file) => file.path === selectedPlanPath);

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "0 1 auto",
        minHeight: 168,
        maxHeight: "52vh",
        overflow: "auto",
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

      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--rule)" }}>
        <MetaRow label="WORKSPACE" value={workspace?.name ?? "none"} />
        <MetaRow label="PLAN" value={selectedPlan?.relativePath ?? "none"} />
        <MetaRow label="RUN" value={activeRun ? activeRun.status : "idle"} />
        <MetaRow label="AUTO" value={activeRun?.autopilot?.status ?? "idle"} />
      </div>

      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--rule)" }}>
        <select
          value={selectedPlanPath}
          onChange={(event) => onSelectPlan(event.target.value)}
          disabled={!workspace || busy || planFiles.length === 0}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--panel-2)",
            color: "var(--ink)",
            border: "1px solid var(--rule-strong)",
            minHeight: 30,
            padding: "5px 7px",
            fontFamily: "inherit",
            fontSize: 11,
            outline: "none",
          }}
        >
          {planFiles.length === 0 ? (
            <option value="">No markdown plans found</option>
          ) : (
            planFiles.map((file) => (
              <option key={file.path} value={file.path}>
                {file.relativePath}
              </option>
            ))
          )}
        </select>
      </div>

      <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--rule)" }}>
        <textarea
          value={humanInput}
          onChange={(event) => setHumanInput(event.target.value)}
          placeholder="Plan, instruction, correction, or answer..."
          rows={3}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            minHeight: 44,
            maxHeight: 92,
            background: "var(--panel-2)",
            color: "var(--ink)",
            border: "1px solid var(--rule-strong)",
            padding: "7px 8px",
            fontFamily: "inherit",
            fontSize: 11,
            lineHeight: 1.35,
            outline: "none",
          }}
        />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 6,
          padding: "8px 12px",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <PanelButton disabled={!workspace || busy || !selectedPlanPath} onClick={onStartAutopilot}>
          RUN
        </PanelButton>
        <PanelButton disabled={!activeRun} onClick={stopRun}>
          STOP
        </PanelButton>
        <PanelButton disabled={!activeRun || busy} onClick={onResumeRun}>
          RESUME
        </PanelButton>
        <PanelButton disabled={!activeRun || busy || humanInput.trim().length === 0} onClick={sendHumanInput}>
          SEND
        </PanelButton>
      </div>

      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <button
          type="button"
          disabled={!workspace || busy}
          onClick={onRefresh}
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            color: !workspace || busy ? "var(--muted)" : "var(--ink-dim)",
            padding: 0,
            fontFamily: "inherit",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
            cursor: "default",
          }}
        >
          REFRESH PLANS
        </button>
      </div>

      {activeRun?.humanMessages && activeRun.humanMessages.length > 0 && (
        <div style={{ maxHeight: 76, overflow: "auto", borderBottom: "1px solid var(--rule)" }}>
          {activeRun.humanMessages.slice(-3).map((message) => (
            <div
              key={message.id}
              title={message.message}
              style={{
                display: "grid",
                gridTemplateColumns: "52px minmax(0, 1fr)",
                gap: 8,
                padding: "6px 12px",
                borderTop: "1px solid var(--rule)",
                fontSize: 10,
              }}
            >
              <span style={{ color: "var(--muted)", fontWeight: 800, letterSpacing: "0.08em" }}>
                {message.author}
              </span>
              <span
                style={{
                  color: "var(--ink-dim)",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {message.message}
              </span>
            </div>
          ))}
        </div>
      )}

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

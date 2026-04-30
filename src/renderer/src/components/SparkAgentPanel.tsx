import React, { useState } from "react";
import type {
  PlanFile,
  RunState,
  Workspace,
} from "@shared/types";

interface Props {
  workspace: Workspace | null;
  activeRun: RunState | null;
  planFiles: PlanFile[];
  selectedPlanPath: string;
  busy: boolean;
  error: string | null;
  onStartAutopilot: () => void;
  onPauseRun: (reason: string) => void;
  onResumeRun: () => void;
  onAddUserMessage: (message: string) => void;
  onDeleteRun: (run: RunState) => void;
  onSelectPlan: (path: string) => void;
  onRefresh: () => void;
  onQuickTest: (runtime: "claude" | "codex") => void;
}

export default function SparkAgentPanel({
  workspace,
  activeRun,
  planFiles,
  selectedPlanPath,
  busy,
  error,
  onStartAutopilot,
  onPauseRun,
  onResumeRun,
  onAddUserMessage,
  onDeleteRun,
  onSelectPlan,
  onRefresh,
  onQuickTest,
}: Props) {
  const [humanInput, setHumanInput] = useState("");
  const [deleteConfirmRunId, setDeleteConfirmRunId] = useState<string | null>(null);

  const sendHumanInput = () => {
    const message = humanInput.trim();
    if (!message) return;
    setHumanInput("");
    onAddUserMessage(message);
  };

  const stopRun = () => {
    const reason = humanInput.trim();
    if (reason) setHumanInput("");
    onPauseRun(reason || "Paused by user");
  };

  const selectedPlan = planFiles.find((file) => file.path === selectedPlanPath);
  const activeRunDeletePending = Boolean(activeRun && deleteConfirmRunId === activeRun.id);
  // "Open question": the most recent spark question with no later user reply.
  // Surfaced as its own block so the user can read the full text and knows
  // why the run is paused.
  const openQuestion = activeRun ? findOpenQuestion(activeRun) : null;

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "4 1 0",
        minHeight: 0,
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
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          padding: "8px 12px",
          borderBottom: "1px solid var(--rule)",
        }}
      >
        <PanelButton disabled={!workspace} onClick={() => onQuickTest("claude")}>
          TEST&nbsp;CLAUDE
        </PanelButton>
        <PanelButton disabled={!workspace} onClick={() => onQuickTest("codex")}>
          TEST&nbsp;CODEX
        </PanelButton>
      </div>

      <div
        style={{
          padding: "8px 12px",
          borderBottom: "1px solid var(--rule)",
          display: "flex",
          alignItems: "center",
          gap: 10,
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
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={!activeRun || busy}
          onClick={() => {
            if (!activeRun) return;
            if (activeRunDeletePending) {
              setDeleteConfirmRunId(null);
              onDeleteRun(activeRun);
              return;
            }
            setDeleteConfirmRunId(activeRun.id);
          }}
          style={{
            appearance: "none",
            background: "transparent",
            border: "none",
            color: !activeRun || busy ? "var(--muted)" : activeRunDeletePending ? "var(--danger)" : "var(--ink-dim)",
            padding: 0,
            fontFamily: "inherit",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
            cursor: "default",
          }}
        >
          {activeRunDeletePending ? "CONFIRM DELETE" : "DELETE RUN"}
        </button>
      </div>

      {openQuestion && (
        <div
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid var(--rule)",
            background: "var(--panel-2)",
            borderLeft: "3px solid var(--accent)",
          }}
        >
          <div
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: "0.14em",
              color: "var(--accent)",
              marginBottom: 6,
            }}
          >
            QUESTION&nbsp;FROM&nbsp;SPARK
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--ink)",
              lineHeight: 1.45,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {openQuestion.message}
          </div>
          <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 6 }}>
            Type your answer above and press SEND, then RESUME to continue the run.
          </div>
        </div>
      )}

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
    </section>
  );
}

// Latest spark question with no later user reply. Walks the message log
// backwards: any user message after the question means it's been answered.
function findOpenQuestion(run: RunState): RunState["humanMessages"][number] | null {
  const msgs = run.humanMessages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.author === "spark" && m.kind === "question") {
      const answeredLater = msgs.slice(i + 1).some((later) => later.author === "user");
      return answeredLater ? null : m;
    }
  }
  return null;
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

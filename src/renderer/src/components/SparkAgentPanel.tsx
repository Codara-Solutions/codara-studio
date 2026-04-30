import React, { useEffect, useState } from "react";
import type {
  PlanFile,
  RunState,
  Workspace,
} from "@shared/types";

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
  onSelectRun: (id: string | null) => void;
  onDeleteRun: (id: string) => void;
  onSelectPlan: (path: string) => void;
  onQuickTest: (runtime: "claude" | "codex") => void;
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
  onSelectRun,
  onDeleteRun,
  onSelectPlan,
  onQuickTest,
}: Props) {
  const [humanInput, setHumanInput] = useState("");
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  // Auto-clear the per-row delete confirmation after a short window so a
  // stale "Confirm?" affordance doesn't sit there indefinitely.
  useEffect(() => {
    if (!confirmingDeleteId) return undefined;
    const t = window.setTimeout(() => setConfirmingDeleteId(null), 3500);
    return () => window.clearTimeout(t);
  }, [confirmingDeleteId]);

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

  // "Open question": the most recent spark question with no later user reply.
  // Surfaced as its own block so the user can read the full text and knows
  // why the run is paused.
  const openQuestion = activeRun ? findOpenQuestion(activeRun) : null;

  const runStatus = activeRun ? activeRun.status : "idle";
  const runIsActive = Boolean(
    activeRun && (activeRun.status === "running" || activeRun.status === "planning"),
  );
  const runEnabled = Boolean(workspace) && !busy && Boolean(selectedPlanPath);
  const stopEnabled = Boolean(activeRun);
  const sendEnabled = Boolean(activeRun) && !busy && humanInput.trim().length > 0;

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
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Hero header */}
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--rule-soft)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <SparkGlyph />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            lineHeight: 1.2,
            minWidth: 0,
            gap: 2,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontWeight: 600,
              fontSize: 14,
              color: "var(--ink)",
            }}
          >
            Spark Agent
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--muted)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {runIsActive && <PulseDot />}
            {runStatus}
          </span>
        </div>
      </div>

      {/* Runs list */}
      <RunsList
        runs={runs}
        activeRunId={activeRun?.id ?? null}
        confirmingDeleteId={confirmingDeleteId}
        busy={busy}
        onSelect={onSelectRun}
        onRequestDelete={(runId) => {
          if (confirmingDeleteId === runId) {
            setConfirmingDeleteId(null);
            onDeleteRun(runId);
          } else {
            setConfirmingDeleteId(runId);
          }
        }}
      />

      {/* Composer surface (plan select + textarea) */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--rule-soft)" }}>
        <div
          style={{
            border: "1px solid var(--rule)",
            borderRadius: 4,
            background: "var(--panel-2)",
            overflow: "hidden",
            transition: "border-color var(--motion-fast) var(--ease-out)",
          }}
        >
          <select
            value={selectedPlanPath}
            onChange={(event) => onSelectPlan(event.target.value)}
            disabled={!workspace || busy || planFiles.length === 0}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: "transparent",
              color: "var(--ink)",
              border: "none",
              borderBottom: "1px solid var(--rule-soft)",
              height: 32,
              padding: "6px 10px",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
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
          <textarea
            value={humanInput}
            onChange={(event) => setHumanInput(event.target.value)}
            placeholder="Plan, instruction, correction, or answer"
            rows={3}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              minHeight: 56,
              maxHeight: 120,
              background: "transparent",
              color: "var(--ink)",
              border: "none",
              padding: "8px 10px",
              fontFamily: "var(--font-sans)",
              fontSize: 12,
              lineHeight: 1.5,
              outline: "none",
              display: "block",
            }}
          />
        </div>
      </div>

      {/* Primary actions */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 8,
          padding: "12px 16px",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <PanelButton
          disabled={!runEnabled}
          onClick={onStartAutopilot}
          styleOverride={
            runEnabled
              ? {
                  background: "var(--accent-soft)",
                  borderColor: "var(--accent-edge)",
                  color: "var(--ink)",
                }
              : undefined
          }
          hoverOverride={
            runEnabled
              ? {
                  background:
                    "color-mix(in oklch, var(--accent) 24%, transparent)",
                  borderColor: "var(--accent-edge)",
                }
              : undefined
          }
        >
          RUN
        </PanelButton>
        <PanelButton
          disabled={!stopEnabled}
          onClick={stopRun}
          styleOverride={
            stopEnabled && runIsActive ? { color: "var(--danger)" } : undefined
          }
        >
          STOP
        </PanelButton>
        <PanelButton disabled={!activeRun || busy} onClick={onResumeRun}>
          RESUME
        </PanelButton>
        <PanelButton disabled={!sendEnabled} onClick={sendHumanInput}>
          SEND
        </PanelButton>
      </div>

      {/* Diagnostics group */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--rule-soft)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--muted)",
            marginBottom: 8,
          }}
        >
          Diagnostics
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <PanelButton disabled={!workspace} onClick={() => onQuickTest("claude")} sentenceCase>
            Test Claude
          </PanelButton>
          <PanelButton disabled={!workspace} onClick={() => onQuickTest("codex")} sentenceCase>
            Test Codex
          </PanelButton>
        </div>
      </div>

      {/* Open question callout */}
      {openQuestion && (
        <div
          style={{
            margin: "12px 16px",
            padding: "12px 14px",
            background:
              "color-mix(in oklch, var(--accent) 10%, var(--panel-2))",
            border: "1px solid var(--accent-edge)",
            borderRadius: 6,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--accent)",
              marginBottom: 8,
            }}
          >
            Question from Spark
          </div>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              color: "var(--ink)",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {openQuestion.message}
          </div>
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: 11,
              color: "var(--muted)",
              marginTop: 8,
              lineHeight: 1.45,
            }}
          >
            Type your answer above and press SEND, then RESUME to continue.
          </div>
        </div>
      )}

      {/* Recent human messages */}
      {activeRun?.humanMessages && activeRun.humanMessages.length > 0 && (
        <div
          style={{
            maxHeight: 96,
            overflow: "auto",
            borderBottom: "1px solid var(--rule-soft)",
          }}
        >
          {activeRun.humanMessages.slice(-3).map((message, idx) => (
            <div
              key={message.id}
              title={message.message}
              style={{
                display: "grid",
                gridTemplateColumns: "64px minmax(0, 1fr)",
                gap: 12,
                padding: "8px 16px",
                borderTop: idx === 0 ? "none" : "1px solid var(--rule-soft)",
                alignItems: "baseline",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--muted)",
                }}
              >
                {message.author}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: 12,
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

      {/* Error toast */}
      {error && (
        <div
          style={{
            padding: "10px 16px",
            background: "var(--danger-soft)",
            borderTop:
              "1px solid color-mix(in oklch, var(--danger) 30%, transparent)",
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}

function RunsList({
  runs,
  activeRunId,
  confirmingDeleteId,
  busy,
  onSelect,
  onRequestDelete,
}: {
  runs: RunState[];
  activeRunId: string | null;
  confirmingDeleteId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onRequestDelete: (id: string) => void;
}) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--rule-soft)",
      }}
    >
      <div
        style={{
          padding: "10px 16px 4px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: "var(--muted)",
        }}
      >
        <span>Runs</span>
        <span style={{ flex: 1, height: 1, background: "var(--rule-soft)" }} />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontVariantNumeric: "tabular-nums",
            color: "var(--ink-dim)",
          }}
        >
          {String(runs.length).padStart(2, "0")}
        </span>
      </div>
      {runs.length === 0 ? (
        <div
          style={{
            padding: "8px 16px 14px",
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          No runs yet. Pick a plan below and press RUN.
        </div>
      ) : (
        <div style={{ padding: "4px 0 8px" }}>
          {runs.map((run, index) => (
            <RunRow
              key={run.id}
              run={run}
              index={index + 1}
              active={run.id === activeRunId}
              confirmingDelete={run.id === confirmingDeleteId}
              busy={busy}
              onSelect={() => onSelect(run.id)}
              onRequestDelete={() => onRequestDelete(run.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  index,
  active,
  confirmingDelete,
  busy,
  onSelect,
  onRequestDelete,
}: {
  run: RunState;
  index: number;
  active: boolean;
  confirmingDelete: boolean;
  busy: boolean;
  onSelect: () => void;
  onRequestDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [trashHover, setTrashHover] = useState(false);

  const background = active
    ? "color-mix(in oklch, var(--accent) 12%, var(--panel-2))"
    : hover
      ? "var(--hover)"
      : "transparent";
  const titleColor = active ? "var(--ink)" : "var(--ink-dim)";
  const indexColor = active ? "var(--ink)" : "var(--muted)";
  const dotColor = statusDotColor(run.status);

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: "12px 26px minmax(0, 1fr) 24px",
        alignItems: "center",
        gap: 10,
        padding: "0 14px 0 16px",
        height: 30,
        background,
        position: "relative",
        transition: "background var(--motion-fast) var(--ease-out)",
      }}
    >
      {active && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: 0,
            top: 6,
            bottom: 6,
            width: 2,
            background: "var(--accent)",
            borderRadius: "0 2px 2px 0",
            boxShadow: "0 0 8px var(--accent-glow)",
          }}
        />
      )}
      <span
        aria-hidden
        title={run.status}
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: dotColor,
          flex: "0 0 7px",
          animation: isLiveStatus(run.status) ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
        }}
      />
      <button
        type="button"
        onClick={onSelect}
        title={`${run.title} · ${run.status}`}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "default",
          minWidth: 0,
          height: "100%",
          display: "inline-flex",
          alignItems: "center",
          fontFamily: "var(--font-mono)",
          fontVariantNumeric: "tabular-nums",
          fontSize: 11,
          fontWeight: active ? 700 : 500,
          color: indexColor,
          letterSpacing: 0,
        }}
      >
        {String(index).padStart(2, "0")}
      </button>
      <button
        type="button"
        onClick={onSelect}
        title={`${run.title} · ${run.status}`}
        style={{
          appearance: "none",
          background: "transparent",
          border: "none",
          padding: 0,
          textAlign: "left",
          cursor: "default",
          minWidth: 0,
          height: "100%",
          display: "inline-flex",
          alignItems: "center",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: active ? 600 : 500,
          color: titleColor,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            display: "inline-block",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            width: "100%",
          }}
        >
          {run.title}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRequestDelete();
        }}
        onMouseEnter={() => setTrashHover(true)}
        onMouseLeave={() => setTrashHover(false)}
        disabled={busy}
        title={confirmingDelete ? "Click again to confirm" : "Delete run"}
        style={{
          appearance: "none",
          background: confirmingDelete
            ? "var(--danger-soft)"
            : trashHover
              ? "var(--hover-strong)"
              : "transparent",
          border: confirmingDelete ? "1px solid var(--danger)" : "1px solid transparent",
          borderRadius: 4,
          color: confirmingDelete
            ? "var(--danger)"
            : trashHover
              ? "var(--danger)"
              : "var(--muted)",
          width: 22,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "default",
          transition:
            "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
        }}
      >
        {confirmingDelete ? <ConfirmGlyph /> : <TrashGlyph />}
      </button>
    </div>
  );
}

function TrashGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 4h8" />
      <path d="M5.5 4V2.75h3V4" />
      <path d="M4 4l0.5 7.25a1 1 0 0 0 1 0.95h3a1 1 0 0 0 1-0.95L10 4" />
      <path d="M6 6.25v3.5" />
      <path d="M8 6.25v3.5" />
    </svg>
  );
}

function ConfirmGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7.5l2.5 2.5L11 4" />
    </svg>
  );
}

function statusDotColor(status: RunState["status"]): string {
  if (status === "running" || status === "reviewing" || status === "planning") return "var(--accent)";
  if (status === "complete") return "var(--ok)";
  if (status === "blocked" || status === "failed") return "var(--danger)";
  if (status === "paused") return "var(--info)";
  return "var(--muted)";
}

function isLiveStatus(status: RunState["status"]): boolean {
  return status === "running" || status === "reviewing" || status === "planning";
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

function PanelButton({
  disabled,
  onClick,
  danger,
  children,
  styleOverride,
  hoverOverride,
  sentenceCase,
}: {
  disabled: boolean;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
  styleOverride?: React.CSSProperties;
  hoverOverride?: React.CSSProperties;
  sentenceCase?: boolean;
}) {
  const [hover, setHover] = useState(false);
  const baseColor = disabled
    ? "var(--muted)"
    : danger
      ? "var(--danger)"
      : "var(--ink-dim)";

  const baseStyle: React.CSSProperties = {
    appearance: "none",
    background: "transparent",
    border: "1px solid var(--rule-strong)",
    color: baseColor,
    minHeight: 30,
    padding: "7px 10px",
    fontFamily: "var(--font-sans)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: sentenceCase ? "0.01em" : "0.04em",
    textTransform: sentenceCase ? "none" : undefined,
    cursor: "default",
    transition:
      "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
  };

  const merged: React.CSSProperties = { ...baseStyle, ...(styleOverride ?? {}) };

  if (hover && !disabled) {
    if (hoverOverride) {
      Object.assign(merged, hoverOverride);
    } else {
      merged.background = "var(--hover-strong)";
      merged.color = danger ? "var(--danger)" : "var(--ink)";
    }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={merged}
    >
      {children}
    </button>
  );
}

function SparkGlyph() {
  // 16x16 inline spark/star glyph using currentColor.
  return (
    <span
      aria-hidden="true"
      style={{
        width: 16,
        height: 16,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--accent)",
      }}
    >
      <svg
        width={16}
        height={16}
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M8 1.25L9.35 6.05L14.15 7.4L9.35 8.75L8 13.55L6.65 8.75L1.85 7.4L6.65 6.05L8 1.25Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

function PulseDot() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: "50%",
        background: "var(--accent)",
        boxShadow: "0 0 6px var(--accent-glow)",
        animation: "spark-fade-in var(--motion-slow) var(--ease-out) infinite alternate",
        flex: "0 0 auto",
      }}
    />
  );
}

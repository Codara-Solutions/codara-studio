import React, { useState } from "react";
import type { RunState, StepState, WorkerAttempt } from "@shared/types";
import {
  type AgentRow,
  deriveAgentStatus,
  isLiveStatus,
  runtimeTone,
  statusColor,
  stepStatusColor,
  stepStatusLabel,
} from "./run-format";
import { ElapsedTime } from "./elapsed";

// The graph's nodes: the SPARK origin, step nodes (with a checkpoint variant),
// worker nodes, and the COMPLETE terminal. Each is sized to fill the absolute
// wrapper RunGraph positions it in; the wire layer connects them by their
// laid-out edge ports.

// ── Icons ────────────────────────────────────────────────────────────────────

function SparkGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 1.6l2.1 6.6a4 4 0 0 0 2.6 2.6l6.6 2.1-6.6 2.1a4 4 0 0 0-2.6 2.6L12 24.4l-2.1-6.8a4 4 0 0 0-2.6-2.6L0.7 12.9l6.6-2.1a4 4 0 0 0 2.6-2.6z" />
    </svg>
  );
}

function CheckGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M2.6 7.4 5.6 10.4 11.4 3.8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M7 3v4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="7" cy="10.4" r="1.05" fill="currentColor" />
    </svg>
  );
}

function CheckpointGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 3.4v9.2M6.6 3.4v9.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M9.4 4.2 13.4 8l-4 3.8z" fill="currentColor" />
    </svg>
  );
}

function FlagGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 2.6v18.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M6 3.6h11.2l-2.4 3.4 2.4 3.4H6z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WorkersGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1 10.4c0-1.7 1.4-2.8 3-2.8s3 1.1 3 2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <path d="M8.2 2.6a2 2 0 0 1 0 3.5M9 10.4c0-1.5-.9-2.5-2-2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function FilesGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 1.6h3.6L9 4v6.4H3z"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinejoin="round"
      />
      <path d="M6.4 1.8V4.2H8.8" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
    </svg>
  );
}

// ── Status dot ───────────────────────────────────────────────────────────────

export const StatusDot = React.memo(function StatusDot({
  status,
  size = 7,
}: {
  status: RunState["status"] | StepState["status"];
  size?: number;
}) {
  const color = statusColor(status);
  const live = isLiveStatus(status);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        flex: "0 0 auto",
        boxShadow: live ? `0 0 8px ${color}` : "none",
        animation: live ? "spark-pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
});

// Small uppercase status word, tinted to the status tone.
function StatusTag({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      style={{
        color: tone,
        fontFamily: "var(--font-sans)",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.11em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        flex: "0 0 auto",
      }}
    >
      {label}
    </span>
  );
}

// ── SPARK origin node ────────────────────────────────────────────────────────

export const SparkNode = React.memo(function SparkNode({
  runStatus,
}: {
  runStatus: RunState["status"];
}) {
  const live = isLiveStatus(runStatus);
  const failed = runStatus === "failed" || runStatus === "blocked";
  const tone = failed ? "var(--danger)" : live ? "var(--accent)" : "var(--ink-dim)";
  return (
    <div
      title="Spark — the orchestration manager"
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 13,
        border: `1px solid ${live ? "var(--accent-edge)" : failed ? "var(--danger)" : "var(--rule-strong)"}`,
        background:
          "linear-gradient(150deg, color-mix(in oklch, var(--panel-2) 84%, var(--accent) 8%), color-mix(in oklch, var(--panel) 78%, black 14%))",
        boxShadow: live
          ? "inset 0 1px 0 color-mix(in oklch, white 8%, transparent), 0 0 24px var(--accent-glow), var(--shadow-2)"
          : "inset 0 1px 0 color-mix(in oklch, white 6%, transparent), var(--shadow-2)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        style={{
          color: failed ? "var(--danger)" : "var(--accent)",
          display: "inline-flex",
          filter: live ? "drop-shadow(0 0 7px var(--accent-glow))" : "none",
        }}
      >
        <SparkGlyph size={23} />
      </span>
      <span
        style={{
          color: "var(--ink)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.16em",
        }}
      >
        SPARK
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <StatusDot status={runStatus} size={6} />
        <span
          style={{
            color: tone,
            fontFamily: "var(--font-sans)",
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
          }}
        >
          {runStatus}
        </span>
      </span>
    </div>
  );
});

// ── Step node ────────────────────────────────────────────────────────────────

interface StepNodeProps {
  step: StepState;
  index: number;
  rows: readonly AgentRow[];
  fileCount: number;
  // The run's current / running step — earns the ambient accent treatment.
  active: boolean;
  selected: boolean;
  onSelect: () => void;
}

export const StepNode = React.memo(function StepNode(props: StepNodeProps) {
  if ((props.step.kind ?? "worker_batch") === "brake") {
    return <CheckpointNode {...props} />;
  }
  return <WorkerBatchNode {...props} />;
});

function WorkerBatchNode({ step, index, rows, fileCount, active, selected, onSelect }: StepNodeProps) {
  const [hover, setHover] = useState(false);
  const status = step.status;
  const tone = stepStatusColor(status);
  const complete = status === "complete" || status === "skipped";
  const attention = status === "blocked" || status === "failed";
  const live = active || status === "running" || status === "reviewing";

  const total = rows.length;
  const done = rows.filter(
    (row) => deriveAgentStatus(row.task, row.attempt, status) === "done",
  ).length;
  const progress = total > 0 ? done / total : complete ? 1 : 0;

  const attempts = rows
    .map((row) => row.attempt)
    .filter((attempt): attempt is WorkerAttempt => Boolean(attempt));
  const startedAt = attempts
    .map((attempt) => attempt.startedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const finishedAt =
    complete && attempts.length > 0 && attempts.every((attempt) => attempt.finishedAt)
      ? attempts
          .map((attempt) => attempt.finishedAt as string)
          .sort()
          .slice(-1)[0]
      : undefined;

  const border = selected
    ? "var(--accent)"
    : attention
      ? "var(--danger)"
      : live
        ? "var(--accent-edge)"
        : hover
          ? "var(--rule-strong)"
          : "var(--rule)";
  const background = attention
    ? "linear-gradient(150deg, color-mix(in oklch, var(--panel) 88%, var(--danger) 9%), color-mix(in oklch, var(--panel) 84%, black 8%))"
    : live
      ? "linear-gradient(150deg, color-mix(in oklch, var(--panel-2) 82%, var(--accent) 9%), color-mix(in oklch, var(--panel) 86%, transparent))"
      : "linear-gradient(150deg, color-mix(in oklch, var(--panel) 92%, white 2%), color-mix(in oklch, var(--panel) 84%, black 6%))";
  const shadow = [
    selected ? "0 0 0 1.5px var(--accent)" : null,
    selected || live ? "0 0 22px var(--accent-glow)" : null,
    attention ? "0 0 18px color-mix(in oklch, var(--danger) 30%, transparent)" : null,
    "inset 0 1px 0 color-mix(in oklch, white 5%, transparent)",
    "var(--shadow-2)",
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <article
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${step.goal || step.title}\n\nClick to ${selected ? "close the inspector" : "inspect this step"}.`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 12,
        border: `1px solid ${border}`,
        background,
        boxShadow: shadow,
        padding: "13px 15px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        cursor: "pointer",
        overflow: "hidden",
        fontFamily: "var(--font-sans)",
        transition:
          "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <header style={{ display: "grid", gridTemplateColumns: "32px minmax(0,1fr) auto", gap: 11, alignItems: "start" }}>
        <StepBadge index={index} status={status} />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.13em",
              textTransform: "uppercase",
            }}
          >
            Step {String(index).padStart(2, "0")}
          </span>
          <span
            style={{
              color: "var(--ink)",
              fontSize: 13.5,
              fontWeight: 600,
              lineHeight: 1.28,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              wordBreak: "break-word",
            }}
          >
            {step.title}
          </span>
        </div>
        <StatusTag label={stepStatusLabel(status)} tone={tone} />
      </header>

      <p
        style={{
          margin: 0,
          color: "var(--ink-dim)",
          fontSize: 11,
          lineHeight: 1.45,
          minHeight: 32,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {step.goal || "Worker activity for this step."}
      </p>

      <div
        style={{
          marginTop: "auto",
          paddingTop: 9,
          borderTop: "1px solid var(--rule-soft)",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <Stat
          icon={<WorkersGlyph />}
          label="Workers"
          value={total > 0 ? `${done}/${total}` : "—"}
          tone={total > 0 && done === total ? "var(--ok)" : "var(--ink-dim)"}
        />
        <Stat
          icon={<FilesGlyph />}
          label="Files"
          value={fileCount > 0 ? String(fileCount) : "—"}
          tone={fileCount > 0 ? "var(--ink-dim)" : "var(--muted)"}
        />
        <span style={{ flex: 1 }} />
        {startedAt && (
          <span
            style={{
              color: live ? "var(--accent)" : "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 10.5,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <ElapsedTime startedAt={startedAt} finishedAt={finishedAt} />
          </span>
        )}
      </div>

      {/* Worker-completion bar, flush along the node's bottom edge. */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: 3,
          background: "color-mix(in oklch, var(--ink) 8%, transparent)",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${Math.round(progress * 100)}%`,
            background: attention ? "var(--danger)" : complete ? "var(--ok)" : "var(--accent)",
            boxShadow: live ? "0 0 10px var(--accent-glow)" : "none",
            transition: "width var(--motion) var(--ease-out)",
          }}
        />
      </span>
    </article>
  );
}

// Brake / checkpoint step: a manager replanning pause, no workers. Lighter and
// dashed so it reads as a gate between worker batches rather than a work node.
function CheckpointNode({ step, index, active, selected, onSelect }: StepNodeProps) {
  const [hover, setHover] = useState(false);
  const status = step.status;
  const tone = stepStatusColor(status);
  const complete = status === "complete" || status === "skipped";
  const live = active || status === "running" || status === "reviewing";
  const border = selected
    ? "var(--accent)"
    : live
      ? "var(--accent-edge)"
      : hover
        ? "var(--rule-strong)"
        : "var(--rule)";
  return (
    <article
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${step.goal || step.title}\n\nCheckpoint — Spark replans here.`}
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 12,
        border: `1px dashed ${border}`,
        background:
          "linear-gradient(150deg, color-mix(in oklch, var(--panel) 84%, white 1%), color-mix(in oklch, var(--panel) 80%, black 7%))",
        boxShadow: selected
          ? "0 0 0 1.5px var(--accent), 0 0 20px var(--accent-glow), var(--shadow-1)"
          : live
            ? "0 0 16px var(--accent-glow), var(--shadow-1)"
            : "var(--shadow-1)",
        padding: "13px 15px",
        display: "flex",
        flexDirection: "column",
        gap: 9,
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        transition:
          "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            flex: "0 0 auto",
            border: `1px solid ${tone}`,
            background: complete ? "var(--ok-soft)" : "color-mix(in oklch, var(--ink) 4%, transparent)",
            color: tone,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CheckpointGlyph />
        </span>
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.13em",
              textTransform: "uppercase",
            }}
          >
            Step {String(index).padStart(2, "0")} · Checkpoint
          </span>
          <span
            style={{
              color: "var(--ink)",
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.25,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 1,
              WebkitBoxOrient: "vertical",
            }}
          >
            {step.title}
          </span>
        </div>
      </header>
      <p
        style={{
          margin: 0,
          color: "var(--ink-dim)",
          fontSize: 11,
          lineHeight: 1.45,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {step.goal || "Spark pauses here to replan downstream steps."}
      </p>
      <div style={{ marginTop: "auto", display: "flex", alignItems: "center", gap: 7 }}>
        <StatusDot status={status} size={6} />
        <StatusTag label={stepStatusLabel(status)} tone={tone} />
      </div>
    </article>
  );
}

function StepBadge({ index, status }: { index: number; status: StepState["status"] }) {
  const tone = stepStatusColor(status);
  const complete = status === "complete" || status === "skipped";
  const failed = status === "failed" || status === "blocked";
  return (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        border: `1px solid ${tone}`,
        background: complete
          ? "var(--ok-soft)"
          : failed
            ? "var(--danger-soft)"
            : "color-mix(in oklch, var(--accent) 8%, transparent)",
        color: tone,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 12.5,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {complete ? <CheckGlyph /> : failed ? <AlertGlyph /> : String(index).padStart(2, "0")}
    </span>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }} title={`${label}: ${value}`}>
      <span style={{ color: "var(--muted)", display: "inline-flex" }}>{icon}</span>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: tone,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </span>
  );
}

// ── Worker node ──────────────────────────────────────────────────────────────

interface WorkerNodeProps {
  row: AgentRow;
  stepStatus: StepState["status"];
  selected: boolean;
  onSelect: () => void;
}

export const WorkerNode = React.memo(function WorkerNode({
  row,
  stepStatus,
  selected,
  onSelect,
}: WorkerNodeProps) {
  const [hover, setHover] = useState(false);
  const { agent, task, attempt } = row;
  const queued = !task; // a planned agent Spark has not spawned yet
  const status = deriveAgentStatus(task, attempt, stepStatus);
  // The badge must reflect the runtime that actually ran the worker, not just
  // the manager's original plan. Manager rewrites and rerouteUnavailableAgent-
  // Runtimes can swap the runtime at spawn time (e.g. plan said claude but the
  // selection only enables cursor, so the worker actually spawns on cursor with
  // composer-2.5-fast). Reading agent.runtimePreference would render CLAUDE
  // while the terminal shows composer-2.5-fast — exactly the mismatch the user
  // reported in the runs graph. Prefer the live attempt.runtime, fall back to
  // the routed task.runtimePreference, and only use the planned-agent value
  // when nothing has spawned yet (queued).
  const liveRuntime = attempt?.runtime ?? task?.runtimePreference ?? agent.runtimePreference;
  const tone = runtimeTone(liveRuntime);
  const running = status === "running";
  const blocked = status === "blocked";

  const border = selected
    ? "var(--accent)"
    : blocked
      ? "var(--danger)"
      : running
        ? "var(--accent-edge)"
        : hover && !queued
          ? "var(--rule-strong)"
          : "var(--rule)";

  const label = task?.title || agent.label;
  const meta = [agent.label, task?.modelHint, task?.effortHint, attempt ? `try ${attempt.attemptNumber}` : null]
    .filter(Boolean)
    .join(" · ");
  const stateColor = statusColor(status);

  return (
    <button
      type="button"
      disabled={queued}
      onClick={(event) => {
        event.stopPropagation();
        if (!queued) onSelect();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        queued
          ? `${label}\n\nQueued — Spark has not spawned this worker yet.`
          : `${label}\n\nClick to inspect this worker.`
      }
      style={{
        appearance: "none",
        textAlign: "left",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 9,
        border: `1px solid ${border}`,
        background: blocked
          ? "linear-gradient(150deg, color-mix(in oklch, var(--panel) 88%, var(--danger) 8%), color-mix(in oklch, var(--panel) 82%, black 6%))"
          : running
            ? "linear-gradient(150deg, color-mix(in oklch, var(--panel-2) 84%, var(--accent) 7%), color-mix(in oklch, var(--panel) 86%, transparent))"
            : "linear-gradient(150deg, color-mix(in oklch, var(--panel) 90%, white 2%), color-mix(in oklch, var(--panel) 82%, black 6%))",
        boxShadow: selected
          ? "0 0 0 1.5px var(--accent), 0 0 16px var(--accent-glow), var(--shadow-1)"
          : running
            ? "0 0 14px var(--accent-glow), var(--shadow-1)"
            : "var(--shadow-1)",
        opacity: queued ? 0.62 : 1,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
        overflow: "hidden",
        cursor: queued ? "default" : "pointer",
        fontFamily: "var(--font-sans)",
        transition:
          "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0, 1fr) auto",
          alignItems: "center",
          gap: 7,
          minWidth: 0,
          width: "100%",
        }}
      >
        <span
          style={{
            color: tone.label,
            background: tone.bg,
            border: `1px solid ${tone.border}`,
            borderRadius: 4,
            padding: "2px 5px",
            fontFamily: "var(--font-mono)",
            fontSize: 8,
            fontWeight: 800,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          {liveRuntime}
        </span>
        <span
          style={{
            minWidth: 0,
            color: "var(--ink)",
            fontSize: 11,
            fontWeight: 600,
            lineHeight: 1.22,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflowWrap: "anywhere",
          }}
        >
          {label}
        </span>
        <StatusDot status={mapAgentToStepStatus(status)} size={6} />
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0, width: "100%" }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {meta || "queued"}
        </span>
        <span
          style={{
            flex: "0 0 auto",
            color: running ? "var(--accent)" : stateColor,
            fontFamily: "var(--font-mono)",
            fontSize: 9.5,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {attempt ? (
            <ElapsedTime startedAt={attempt.startedAt} finishedAt={attempt.finishedAt} placeholder="--:--" />
          ) : (
            "--:--"
          )}
        </span>
      </div>
    </button>
  );
});

// StatusDot speaks run/step statuses; map the agent kind onto the nearest one
// so a worker dot pulses while running and settles green/red when terminal.
function mapAgentToStepStatus(
  status: "queued" | "running" | "done" | "blocked",
): StepState["status"] {
  if (status === "running") return "running";
  if (status === "done") return "complete";
  if (status === "blocked") return "failed";
  return "queued";
}

// ── COMPLETE terminal node ───────────────────────────────────────────────────

export const EndNode = React.memo(function EndNode({
  runStatus,
}: {
  runStatus: RunState["status"];
}) {
  const complete = runStatus === "complete";
  const failed = runStatus === "failed" || runStatus === "blocked";
  const tone = complete ? "var(--ok)" : failed ? "var(--danger)" : "var(--muted)";
  const label = complete ? "complete" : failed ? runStatus : "pending";
  return (
    <div
      title={`Run outcome: ${runStatus}`}
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 14,
        border: `1px solid ${complete ? "var(--ok)" : failed ? "var(--danger)" : "var(--rule)"}`,
        background: complete
          ? "linear-gradient(150deg, color-mix(in oklch, var(--ok) 16%, var(--panel)), color-mix(in oklch, var(--panel) 86%, transparent))"
          : failed
            ? "linear-gradient(150deg, color-mix(in oklch, var(--danger) 14%, var(--panel)), color-mix(in oklch, var(--panel) 86%, transparent))"
            : "linear-gradient(150deg, color-mix(in oklch, var(--panel) 90%, white 1%), color-mix(in oklch, var(--panel) 82%, black 6%))",
        boxShadow: complete
          ? "0 0 22px color-mix(in oklch, var(--ok) 30%, transparent), var(--shadow-2)"
          : "inset 0 1px 0 color-mix(in oklch, white 5%, transparent), var(--shadow-1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontFamily: "var(--font-sans)",
      }}
    >
      <span style={{ color: tone, display: "inline-flex" }}>
        <FlagGlyph size={22} />
      </span>
      <span
        style={{
          color: tone,
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
    </div>
  );
});

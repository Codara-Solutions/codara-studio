import React, { useState } from "react";
import type { RunState, StepState, WorkerAttempt, WorkerReport, WorkerTask } from "@shared/types";
import {
  type AgentRow,
  deriveAgentStatus,
  isLiveStatus,
  runtimeTone,
  sentenceCase,
  statusColor,
  stepStatusColor,
  stepStatusLabel,
  WORKER_ATTEMPT_CAP,
  workerModelLabel,
} from "./run-format";
import { ElapsedTime } from "./elapsed";

// The graph's nodes: the Cora manager origin, step nodes (with a checkpoint
// variant), worker nodes, and the terminal end node. Each is sized to fill the
// absolute wrapper RunGraph positions it in; the wire layer connects them by
// their laid-out edge ports.
//
// Silhouette language (shared with the automations LiveBoard): the SHAPE tells
// the role. Capsules bookend the pipeline (manager origin / end terminal),
// steps are soft generous-radius cards, checkpoints are chamfered gates, and
// workers are small cards wearing a runtime-colored left edge. Shapes only —
// the wire/port geometry (box edges) is untouched, so GraphWires still lands
// exactly on every node.

// ── Icons ────────────────────────────────────────────────────────────────────

// Quiet circle-dot mark for the manager node — a plain product mark, no glow.
function SparkGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.4" fill="currentColor" />
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

// Check-circle for the end terminal — a completion mark, not a finish flag.
function CheckCircleGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8 12.2 10.8 15 16 8.9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 12px arrow-up-right — the worker card's open-in-terminal affordance.
function ArrowUpRightGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M4 3h5v5M9 3 3 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
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
  // The one canonical live indicator: an opacity-only pulse, no scale, no glow.
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        flex: "0 0 auto",
        animation: live ? "runs-pulse 1.6s ease-in-out infinite" : undefined,
      }}
    />
  );
});

// Small sentence-case status word, tinted to the status tone.
function StatusTag({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        color: tone,
        border: `1px solid color-mix(in oklch, ${tone} 38%, var(--rule))`,
        background: `color-mix(in oklch, ${tone} 8%, transparent)`,
        borderRadius: 999,
        padding: "2px 7px",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        flex: "0 0 auto",
      }}
    >
      {sentenceCase(label)}
    </span>
  );
}

// ── Verifier verdict (shared) ────────────────────────────────────────────────
// The one place that turns a step's worker reports into a single ground-truth
// verdict. Inspector and ChatConversation both import these so the cost+verdict
// surfaces agree byte-for-byte rather than each re-deriving the rule.

export type StepVerdictKind =
  | "perfect"
  | "verified"
  | "partial"
  | "feedback"
  | "failed"
  | "unverified-accepted"
  | "none";

// Confidence ladder, strongest first. A step's verdict is the WEAKEST verdict
// among its present verifier reports — one PARTIAL claim drags the whole step
// down to PARTIAL even if a peer said PERFECT.
const VERDICT_RANK: Record<VerifierConfidence, number> = {
  PERFECT: 0,
  VERIFIED: 1,
  PARTIAL: 2,
  FEEDBACK: 3,
  FAILED: 4,
};

type VerifierConfidence = "PERFECT" | "VERIFIED" | "PARTIAL" | "FEEDBACK" | "FAILED";

function confidenceToKind(confidence: VerifierConfidence): StepVerdictKind {
  switch (confidence) {
    case "PERFECT":
      return "perfect";
    case "VERIFIED":
      return "verified";
    case "PARTIAL":
      return "partial";
    case "FEEDBACK":
      return "feedback";
    case "FAILED":
      return "failed";
  }
}

// Walk a step's worker tasks → latest attempt → report.verifier; pick the lowest
// confidence among the present verdicts. With no verifier verdict at all, fall
// back to the force-accept flag (an owning task promoted past verification to
// break a deadlock) before settling on 'none'.
export function stepVerdict(
  step: StepState,
  attemptByTask: Map<string, WorkerAttempt>,
  reportByAttempt: ReadonlyMap<string, WorkerReport>,
  tasksById: Map<string, WorkerTask>,
): StepVerdictKind {
  let worst: VerifierConfidence | null = null;
  let forceAccepted = false;
  for (const taskId of step.workerTaskIds) {
    const task = tasksById.get(taskId);
    if (task?.forceAccepted) forceAccepted = true;
    const attempt = attemptByTask.get(taskId);
    if (!attempt) continue;
    const report = reportByAttempt.get(attempt.id);
    const confidence = report?.verifier?.confidence;
    if (!confidence) continue;
    if (worst === null || VERDICT_RANK[confidence] > VERDICT_RANK[worst]) {
      worst = confidence;
    }
  }
  if (worst !== null) return confidenceToKind(worst);
  if (forceAccepted) return "unverified-accepted";
  return "none";
}

// The run's verdict is the worst step verdict across its completed steps. An
// 'unverified-accepted' step counts only when no step carries a real (failed /
// partial) verdict — a genuine FAILED step should win the headline.
export function runVerdict(
  run: RunState,
  maps: { attemptByTask: Map<string, WorkerAttempt>; taskById: Map<string, WorkerTask> },
  reportByAttempt: ReadonlyMap<string, WorkerReport>,
): StepVerdictKind {
  let worst: StepVerdictKind = "none";
  let unverified = false;
  for (const step of run.steps) {
    if (step.status !== "complete" && step.status !== "skipped") continue;
    const kind = stepVerdict(step, maps.attemptByTask, reportByAttempt, maps.taskById);
    if (kind === "none") continue;
    if (kind === "unverified-accepted") {
      unverified = true;
      continue;
    }
    if (worst === "none" || VERDICT_RANK[kindToConfidence(kind)] > VERDICT_RANK[kindToConfidence(worst)]) {
      worst = kind;
    }
  }
  if (worst !== "none") return worst;
  return unverified ? "unverified-accepted" : "none";
}

// Inverse of confidenceToKind, for ranking real verdicts against each other.
// Only the five ladder kinds are valid inputs here (callers gate the rest).
function kindToConfidence(kind: StepVerdictKind): VerifierConfidence {
  switch (kind) {
    case "perfect":
      return "PERFECT";
    case "verified":
      return "VERIFIED";
    case "partial":
      return "PARTIAL";
    case "feedback":
      return "FEEDBACK";
    default:
      return "FAILED";
  }
}

export interface VerdictTone {
  color: string;
  label: string;
  title: string;
}

export function verdictTone(kind: StepVerdictKind): VerdictTone | null {
  switch (kind) {
    case "perfect":
      return { color: "var(--ok)", label: "Perfect", title: "Verifier confirmed: perfect" };
    case "verified":
      return { color: "var(--ok)", label: "Verified", title: "Verifier confirmed the work" };
    case "partial":
    case "feedback":
      return { color: "var(--warn)", label: "Partial", title: "Verifier found gaps — partial" };
    case "failed":
      return { color: "var(--danger)", label: "Failed", title: "Verifier rejected the work" };
    case "unverified-accepted":
      return {
        color: "var(--muted)",
        label: "Unverified",
        title: "Unverified — accepted to avoid deadlock",
      };
    case "none":
      return null;
  }
}

// A rounded, tinted pill speaking the verdict — same color-mix/border idiom as
// the run-graph status tags. Returns null for 'none' so callers can drop it
// in unconditionally.
export function VerdictPill({ kind, compact }: { kind: StepVerdictKind; compact?: boolean }) {
  const tone = verdictTone(kind);
  if (!tone) return null;
  return (
    <span
      title={tone.title}
      style={{
        color: tone.color,
        background: `color-mix(in oklch, ${tone.color} 14%, transparent)`,
        border: `1px solid color-mix(in oklch, ${tone.color} 38%, transparent)`,
        borderRadius: 999,
        padding: compact ? "1px 6px" : "2px 8px",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        flex: "0 0 auto",
        lineHeight: 1.5,
      }}
    >
      {tone.label}
    </span>
  );
}

// ── Cora (manager) origin node ───────────────────────────────────────────────

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
      title="Cora — the orchestration manager"
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        // Capsule — the origin's silhouette; ports still meet the box edges.
        borderRadius: 999,
        border: `1px solid ${live ? "var(--accent-edge)" : failed ? "var(--danger)" : "var(--rule-strong)"}`,
        background: failed
          ? "color-mix(in oklab, var(--danger) 5%, var(--panel))"
          : live
            ? "color-mix(in oklab, var(--accent) 5%, var(--panel))"
            : "var(--panel)",
        boxShadow: "var(--lift-hi), var(--shadow-2)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        style={{
          color: failed ? "var(--danger)" : "var(--accent)",
          display: "inline-flex",
        }}
      >
        <SparkGlyph size={18} />
      </span>
      <span
        style={{
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.01em",
        }}
      >
        Cora
      </span>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 500,
        }}
      >
        Manager
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <StatusDot status={runStatus} size={6} />
        <span
          style={{
            color: tone,
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          {sentenceCase(runStatus)}
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
  // Optional verdict inputs — when present, WorkerBatchNode renders the shared
  // <VerdictPill> in its header. Left optional so existing call-sites that don't
  // wire the maps yet keep compiling and simply omit the pill.
  reportByAttempt?: ReadonlyMap<string, WorkerReport>;
  attemptByTask?: Map<string, WorkerAttempt>;
  tasksById?: Map<string, WorkerTask>;
}

export const StepNode = React.memo(function StepNode(props: StepNodeProps) {
  if ((props.step.kind ?? "worker_batch") === "brake") {
    return <CheckpointNode {...props} />;
  }
  return <WorkerBatchNode {...props} />;
});

function WorkerBatchNode({
  step,
  index,
  rows,
  fileCount,
  active,
  selected,
  onSelect,
  reportByAttempt,
  attemptByTask,
  tasksById,
}: StepNodeProps) {
  const [hover, setHover] = useState(false);
  const status = step.status;
  const tone = stepStatusColor(status);
  const verdict =
    reportByAttempt && attemptByTask && tasksById
      ? stepVerdict(step, attemptByTask, reportByAttempt, tasksById)
      : "none";
  const complete = status === "complete" || status === "skipped";
  const attention = status === "blocked" || status === "failed";
  const live = active || status === "running" || status === "reviewing";

  const total = rows.length;
  const done = rows.filter(
    (row) => deriveAgentStatus(row.task, row.attempt, status) === "done",
  ).length;
  const progress = total > 0 ? done / total : complete ? 1 : 0;
  // Retries hide behind logical worker rows; surface the raw try count when
  // it outgrows the worker count so the step admits its rework.
  const spawned = rows.filter((row) => row.task).length;
  const attemptTotal = rows.reduce(
    (sum, row) => sum + (row.attemptCount ?? (row.attempt ? 1 : 0)),
    0,
  );

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
    ? "color-mix(in oklab, var(--danger) 5%, var(--panel))"
    : live
      ? "color-mix(in oklab, var(--accent) 5%, var(--panel))"
      : "var(--panel)";
  const shadow = [
    selected ? "0 0 0 1.5px var(--accent)" : null,
    "var(--lift-hi)",
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${step.goal || step.title}\n\nClick to ${selected ? "close the inspector" : "inspect this step"}.`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 18,
        border: `1px solid ${border}`,
        background,
        boxShadow: shadow,
        padding: "13px 15px 17px",
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
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            Step {index}
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
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
          <StatusTag label={stepStatusLabel(status)} tone={tone} />
          <VerdictPill kind={verdict} compact />
        </div>
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
        {attemptTotal > spawned && spawned > 0 && (
          <span
            title={`${spawned} workers ran ${attemptTotal} attempts, retries included`}
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            · {attemptTotal} attempts
          </span>
        )}
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
          background: "color-mix(in oklab, var(--ink) 8%, transparent)",
        }}
      >
        <span
          style={{
            display: "block",
            height: "100%",
            width: `${Math.round(progress * 100)}%`,
            background: attention ? "var(--danger)" : complete ? "var(--ok)" : "var(--accent)",
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${step.goal || step.title}\n\nCheckpoint — Cora replans here.`}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
        // A gate between worker batches: dashed border — quieter than a work
        // node, no clip-path theatrics.
        borderRadius: 14,
        border: `1px dashed ${border}`,
        background: live ? "color-mix(in oklab, var(--accent) 5%, var(--panel))" : "var(--panel)",
        boxShadow: selected ? "0 0 0 1.5px var(--accent), var(--shadow-1)" : "var(--shadow-1)",
        padding: "13px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 9,
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
            background: complete ? "var(--ok-soft)" : "color-mix(in oklab, var(--ink) 4%, transparent)",
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
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.04em",
            }}
          >
            Step {index} · Checkpoint
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
        {step.goal || "Cora pauses here to replan downstream steps."}
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
      {complete ? <CheckGlyph /> : failed ? <AlertGlyph /> : String(index)}
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
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.02em",
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
  onOpen: () => void;
}

export const WorkerNode = React.memo(function WorkerNode({
  row,
  stepStatus,
  selected,
  onSelect,
  onOpen,
}: WorkerNodeProps) {
  const [hover, setHover] = useState(false);
  const { agent, task, attempt } = row;
  const queued = !task; // a planned agent Cora has not spawned yet
  const status = deriveAgentStatus(task, attempt, stepStatus);
  // The badge must reflect the runtime that actually ran the worker, not just
  // the manager's original plan. Manager rewrites and rerouteUnavailableAgent-
  // Runtimes can swap the runtime at spawn time when the planned CLI is not
  // enabled. Prefer the live attempt.runtime, fall back to
  // the routed task.runtimePreference, and only use the planned-agent value
  // when nothing has spawned yet (queued).
  const liveRuntime = attempt?.runtime ?? task?.runtimePreference ?? agent.runtimePreference;
  const tone = runtimeTone(liveRuntime);
  const running = status === "running";
  const blocked = status === "blocked";
  const runtimeState = attempt?.runtimeState;
  const stateLabel = runtimeState
    ? runtimeState === "idle"
      ? "ready"
      : runtimeState === "working"
        ? "working"
        : runtimeState === "error"
          // Matches the terminal pane chip. The raw state name ("error") is
          // vaguer than what happened: the worker's process died on its own,
          // which is never a sanctioned end since only Cora may stop a worker.
          ? "crashed"
          : runtimeState
    : queued
      ? "queued"
      : attempt?.status === "succeeded"
        ? "complete"
        : attempt?.status === "finishing"
          ? "finishing"
          : status;

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
  const role = task?.taskClass ?? "worker";
  // Prefer the model the attempt actually launched on, the planner's hint can
  // be coerced onto the worker roster at spawn time, so the hint is a request
  // and the attempt's value is the truth.
  const liveModel = attempt?.model ?? task?.modelHint ?? agent.modelHint;
  const modelBadge = workerModelLabel(liveModel, liveRuntime);
  const effort = task?.effortHint ?? agent.effortHint;
  const modelLine = liveModel
    ? effort
      ? `${liveModel} · ${effort}`
      : liveModel
    : "model pending";
  const stateColor = statusColor(status);

  // Attempt lineage: ordinal counts every try across the task's supersedes
  // chain; the tooltip recounts the earlier tries so rework is inspectable
  // without opening the inspector.
  const attemptOrdinal = row.attemptCount ?? attempt?.attemptNumber ?? 0;
  const priorAttempts = (row.attempts ?? []).filter((entry) => entry.id !== attempt?.id);
  const attemptHistory =
    priorAttempts.length > 0
      ? priorAttempts
          .map((entry, i) => `Attempt ${i + 1} · ${entry.runtime} · ${sentenceCase(entry.status)}`)
          .join("\n")
      : undefined;

  return (
    <button
      type="button"
      disabled={queued}
      data-worker-task-id={task?.id}
      data-worker-state={task?.status}
      onClick={(event) => {
        event.stopPropagation();
        // Synthetic accessibility/test clicks use detail 0; real single
        // clicks use 1. Ignore the second click from a legacy double-click.
        if (!queued && event.detail <= 1) onSelect();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (!queued) onOpen();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={
        queued
          ? `${label}\n\nQueued — Cora has not spawned this worker yet.`
          : `${label}${row.retryNote ? `\n${row.retryNote}` : ""}\n\nClick to open this worker's terminal.`
      }
      style={{
        appearance: "none",
        textAlign: "left",
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 14,
        border: `1px solid ${border}`,
        background: blocked
          ? "color-mix(in oklab, var(--danger) 5%, var(--panel))"
          : running
            ? "color-mix(in oklab, var(--accent) 5%, var(--panel))"
            : "var(--panel)",
        // The colored top edge is the worker card's silhouette cue, set where
        // its tentacle enters from the step above. While the worker runs the
        // edge turns accent and the card lifts a level: the working lane must
        // be structural, not just a tint. Model identity stays on the chip.
        boxShadow: `${
          running
            ? "inset 0 2px 0 var(--accent)"
            : `inset 0 3px 0 color-mix(in oklch, ${tone.label} 78%, transparent)`
        }, ${
          selected
            ? "0 0 0 1.5px var(--accent), var(--shadow-1)"
            : running
              ? "var(--lift-hi), var(--shadow-2)"
              : "var(--lift-hi), var(--shadow-1)"
        }`,
        opacity: queued ? 0.62 : 1,
        padding: "11px 10px 8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 5,
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
          gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
          alignItems: "center",
          gap: 6,
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
            fontSize: 9,
            fontWeight: 650,
            letterSpacing: "0.04em",
            // Deliberately NOT uppercased, see ModelTag in Inspector.tsx. The
            // chip holds a model name with a version, not a runtime label, and
            // the same string renders un-uppercased in the run header.
            whiteSpace: "nowrap",
          }}
          title={`${liveModel ?? "model not resolved yet"}, running on the Pi harness, authenticated as ${liveRuntime}`}
        >
          {modelBadge}
        </span>
        <span
          style={{
            minWidth: 0,
            color: "var(--muted-2)",
            fontFamily: "var(--font-sans)",
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: "0.03em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {role}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            color: runtimeState === "error" || blocked ? "var(--danger)" : runtimeState === "idle" || runtimeState === "done" ? "var(--ok)" : stateColor,
            fontFamily: "var(--font-sans)",
            fontSize: 9.5,
            fontWeight: 600,
            letterSpacing: "0.02em",
            whiteSpace: "nowrap",
          }}
        >
          <StatusDot status={mapAgentToStepStatus(status)} size={5} />
          {sentenceCase(stateLabel)}
        </span>
        <span
          // Kept out of the a11y tree: a nested button is invalid inside the
          // card <button>. The inspector's "Open worker terminal" action is
          // the accessible route; this arrow is the pointer shortcut.
          aria-hidden
          title="Open terminal"
          onClick={(event) => {
            event.stopPropagation();
            if (!queued) onOpen();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          style={{
            display: "inline-flex",
            padding: 2,
            margin: -2,
            cursor: queued ? "default" : "pointer",
            color: queued ? "var(--muted-2)" : hover || selected ? "var(--accent)" : "var(--muted)",
            transition: "color var(--motion-fast) var(--ease-out)",
          }}
        >
          <ArrowUpRightGlyph />
        </span>
      </div>
      <span
        style={{
          minWidth: 0,
          width: "100%",
          color: "var(--ink)",
          fontSize: 11,
          fontWeight: 650,
          lineHeight: 1.2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0, width: "100%" }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {modelLine}
        </span>
        {attemptOrdinal > 1 && (
          <span
            title={
              attemptHistory ??
              `${attemptOrdinal - 1} earlier ${attemptOrdinal === 2 ? "attempt" : "attempts"}`
            }
            style={{
              flex: "0 0 auto",
              color: "var(--muted-2)",
              fontFamily: "var(--font-sans)",
              fontSize: 10,
            }}
          >
            attempt {attemptOrdinal} of {Math.max(WORKER_ATTEMPT_CAP, attemptOrdinal)}
          </span>
        )}
        <span
          style={{
            flex: "0 0 auto",
            minWidth: 34,
            textAlign: "right",
            color: running ? "var(--accent)" : stateColor,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontWeight: running ? 600 : undefined,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {attempt ? (
            <ElapsedTime startedAt={attempt.startedAt} finishedAt={attempt.finishedAt} placeholder="—" />
          ) : (
            "—"
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

// ── End terminal node ────────────────────────────────────────────────────────

export const EndNode = React.memo(function EndNode({
  runStatus,
}: {
  runStatus: RunState["status"];
}) {
  const complete = runStatus === "complete";
  const failed = runStatus === "failed" || runStatus === "blocked";
  const tone = complete ? "var(--ok)" : failed ? "var(--danger)" : "var(--muted)";
  const label = complete ? "Complete" : failed ? sentenceCase(runStatus) : "Pending";
  return (
    <div
      title={`Run outcome: ${runStatus}`}
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        // Capsule — the terminal's silhouette, matching the manager origin.
        borderRadius: 999,
        border: `1px solid ${complete ? "var(--ok)" : failed ? "var(--danger)" : "var(--rule)"}`,
        background: complete
          ? "color-mix(in oklab, var(--ok) 6%, var(--panel))"
          : failed
            ? "color-mix(in oklab, var(--danger) 5%, var(--panel))"
            : "var(--panel)",
        boxShadow: "var(--lift-hi), var(--shadow-1)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontFamily: "var(--font-sans)",
      }}
    >
      <span style={{ color: tone, display: "inline-flex" }}>
        <CheckCircleGlyph size={22} />
      </span>
      <span
        style={{
          color: tone,
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.02em",
        }}
      >
        {label}
      </span>
    </div>
  );
});

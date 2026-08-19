import React, { useState } from "react";
import type { RunState, StepState, WorkerAttempt, WorkerReport, WorkerTask } from "@shared/types";
import {
  type AgentRow,
  deriveAgentStatus,
  firstLine,
  formatCostUsd,
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

// The failure counterpart to CheckGlyph — a plain cross, drawn on the same
// 14-unit grid so the two badges swap without the header shifting.
function CrossGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M3.8 3.8 10.2 10.2M10.2 3.8 3.8 10.2"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
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

// 10px chevron for the collapse / expand toggle. Points down on an expanded
// step (fold this away) and right on a collapsed one (unfold it).
function ChevronGlyph({ size = 10, dir }: { size?: number; dir: "down" | "right" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      style={{
        transform: dir === "right" ? "rotate(-90deg)" : undefined,
        transition: "transform var(--motion-fast) var(--ease-out)",
      }}
    >
      <path
        d="M2.2 3.6 5 6.4l2.8-2.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

// ── Card primitives ──────────────────────────────────────────────────────────
// The three parts every work card wears, in the order the eye reads them: the
// header's live indicator, the one-line console readout of what the card is
// doing right now, and the hairline rail underneath. Step cards and worker
// cards share them so a batch and its workers read as one family.

// The live indicator: a two-lit-sides ring turning on itself. It replaces a
// wordy "Running" chip for the one state that needs no word — only the states
// a word can explain (paused, no response, crashed, queued) keep the chip.
// Never rendered while the run is paused; the class collapses under
// prefers-reduced-motion.
function ArcSpinner({ size = 14, tone = "var(--accent)" }: { size?: number; tone?: string }) {
  return (
    <span
      aria-hidden
      className="runs-arc-spin"
      style={{
        width: size,
        height: size,
        boxSizing: "border-box",
        borderRadius: 999,
        border: "1.5px solid transparent",
        borderTopColor: tone,
        borderRightColor: tone,
        flex: "0 0 auto",
      }}
    />
  );
}

// What the card is doing right now, in one ellipsized monospace line — the
// terminal readout the node would print if it had a terminal. Tinted by
// outcome: danger when the line is a failure, ok when it is a result.
function ConsoleLine({
  text,
  tone,
  title,
}: {
  text: string;
  tone: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: "block",
        minWidth: 0,
        width: "100%",
        color: tone,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: 1.35,
        letterSpacing: "-0.01em",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {text}
    </span>
  );
}

// The 2px rail above the footer. `indeterminate` is for work with no
// done/total to measure against (a single worker): the fill sweeps instead of
// growing, and settles to a plain accent rail under reduced motion. Paused
// cards always pass a static fill — nothing on a held run may travel.
function ProgressTrack({
  progress,
  tone,
  indeterminate = false,
}: {
  progress: number;
  tone: string;
  indeterminate?: boolean;
}) {
  const width = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        width: "100%",
        height: 2,
        flex: "0 0 auto",
        borderRadius: 999,
        background: "color-mix(in oklab, var(--ink) 9%, transparent)",
        overflow: "hidden",
      }}
    >
      <span
        className={indeterminate ? "runs-track-live" : undefined}
        style={{
          display: "block",
          height: "100%",
          width: indeterminate ? "100%" : `${width}%`,
          background: indeterminate ? undefined : tone,
          transition: "width var(--motion) var(--ease-out)",
        }}
      />
    </span>
  );
}

// The soft outer glow a card wears while it is the live one (accent) or has
// stopped on a failure (danger). Built with color-mix so it stays a whisper on
// light themes instead of the reference's flat rgba haze.
function glowShadow(color: string): string {
  return `0 0 14px color-mix(in oklch, ${color} 18%, transparent)`;
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

// The run headline reads only CURRENT verification. A verifier that began
// before a later implementation attempt finished describes an older workspace
// snapshot and is superseded history; keeping its FEEDBACK forever made a run
// stay "Partial" after corrective work and a fresh verifier both passed. Peer
// verdicts from the newest workspace generation still combine by weakest-wins.
export function runVerdict(
  run: RunState,
  maps: { attemptByTask: Map<string, WorkerAttempt>; taskById: Map<string, WorkerTask> },
  reportByAttempt: ReadonlyMap<string, WorkerReport>,
): StepVerdictKind {
  let worst: VerifierConfidence | null = null;
  let unverified = false;
  const implementationFinishedAt = run.workerAttempts
    .filter((attempt) => {
      if (maps.taskById.get(attempt.workerTaskId)?.taskClass === "verifier") return false;
      const report = reportByAttempt.get(attempt.id);
      // A failed/no-op attempt does not create a new workspace generation and
      // therefore must not erase the last meaningful verifier result. When an
      // older persisted attempt has no report, success is the best evidence we
      // have that its implementation may have changed the workspace.
      if (report) return (report.filesChanged?.length ?? 0) > 0;
      return attempt.status === "succeeded";
    })
    .map((attempt) => Date.parse(attempt.finishedAt ?? ""))
    .filter(Number.isFinite);
  for (const step of run.steps) {
    if (step.status === "completed_unverified") {
      unverified = true;
      continue;
    }
    if (step.status !== "complete" && step.status !== "skipped") continue;
    for (const taskId of step.workerTaskIds) {
      const task = maps.taskById.get(taskId);
      if (task?.forceAccepted) unverified = true;
      if (task?.taskClass !== "verifier") continue;
      const attempt = maps.attemptByTask.get(taskId);
      if (!attempt) continue;
      const beganAt = Date.parse(attempt.startedAt ?? task.createdAt);
      const superseded =
        Number.isFinite(beganAt) &&
        implementationFinishedAt.some((finishedAt) => finishedAt > beganAt);
      if (superseded) continue;
      const confidence = reportByAttempt.get(attempt.id)?.verifier?.confidence;
      if (!confidence) continue;
      if (worst === null || VERDICT_RANK[confidence] > VERDICT_RANK[worst]) {
        worst = confidence;
      }
    }
  }
  if (worst !== null) return confidenceToKind(worst);
  return unverified ? "unverified-accepted" : "none";
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
  const tone = failed
    ? "var(--danger)"
    : live
      ? "var(--accent)"
      : runStatus === "paused"
        ? "var(--info)"
        : "var(--ink-dim)";
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
        // The same soft outer glow the live step cards wear, so the origin
        // belongs to the lit path rather than sitting outside it. A paused run
        // is not live, so isLiveStatus already withholds it.
        boxShadow: [
          failed ? glowShadow("var(--danger)") : live ? glowShadow("var(--accent)") : null,
          "var(--lift-hi)",
          "var(--shadow-2)",
        ]
          .filter(Boolean)
          .join(", "),
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
  // True while the whole run is paused. A step's own status is not rewritten
  // when the user stops a run, so the node has to be told: without this it
  // would keep wearing the live accent and calling itself "Running" over work
  // that is not moving.
  runPaused?: boolean;
  selected: boolean;
  onSelect: () => void;
  // Optional verdict inputs — when present, WorkerBatchNode renders the shared
  // <VerdictPill> in its header. Left optional so existing call-sites that don't
  // wire the maps yet keep compiling and simply omit the pill.
  reportByAttempt?: ReadonlyMap<string, WorkerReport>;
  attemptByTask?: Map<string, WorkerAttempt>;
  tasksById?: Map<string, WorkerTask>;
  // Folded to the compact node — its worker fan is gone from the layout, so
  // the card must stand on its own summary.
  collapsed?: boolean;
  // Present only when this step may be folded (a terminal step). Absent means
  // no toggle is drawn at all, which is how a live step is kept open.
  onToggleCollapse?: () => void;
}

export const StepNode = React.memo(function StepNode(props: StepNodeProps) {
  if (props.collapsed) {
    return <CollapsedStepNode {...props} />;
  }
  if ((props.step.kind ?? "worker_batch") === "brake") {
    return <CheckpointNode {...props} />;
  }
  return <WorkerBatchNode {...props} />;
});

// The fold affordance on a terminal step. Quiet until hovered: it is a view
// control, not part of the run's story. A real <button> is fine here because
// the step cards are <article>s — the aria-hidden span dance in WorkerNode
// exists only because that card is itself a <button>.
function CollapseToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [hover, setHover] = useState(false);
  const label = collapsed ? "Expand step" : "Collapse step";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        flex: "0 0 auto",
        width: 17,
        height: 17,
        padding: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 5,
        border: "1px solid transparent",
        background: hover ? "color-mix(in oklab, var(--ink) 9%, transparent)" : "transparent",
        color: hover ? "var(--ink-dim)" : "var(--muted)",
        cursor: "pointer",
        transition:
          "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
      }}
    >
      <ChevronGlyph dir={collapsed ? "right" : "down"} />
    </button>
  );
}

// A finished step, folded. Everything the expanded card said is gone except
// what survives as a result: which step it was, what it was called, whether it
// landed, and what it cost in workers and wall time. Clicking it still opens
// the inspector — the chevron is the only part that unfolds it.
function CollapsedStepNode({
  step,
  index,
  rows,
  selected,
  onSelect,
  onToggleCollapse,
}: StepNodeProps) {
  const [hover, setHover] = useState(false);
  const status = step.status;
  const failed = status === "blocked" || status === "failed";
  const skipped = status === "skipped";
  const complete = status === "complete";

  const total = rows.length;
  const attempts = rows
    .map((row) => row.attempt)
    .filter((attempt): attempt is WorkerAttempt => Boolean(attempt));
  const startedAt = attempts
    .map((attempt) => attempt.startedAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const finishedAt =
    attempts.length > 0 && attempts.every((attempt) => attempt.finishedAt)
      ? attempts
          .map((attempt) => attempt.finishedAt as string)
          .sort()
          .slice(-1)[0]
      : undefined;

  const border = selected
    ? "var(--accent)"
    : failed
      ? "var(--danger)"
      : complete
        ? "color-mix(in oklch, var(--ok) 45%, var(--rule))"
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
      title={`${step.title}\n${step.goal || ""}\n\n${stepStatusLabel(status)} — collapsed. Click to inspect, or use the chevron to expand.`}
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 12,
        border: `1px solid ${border}`,
        background: failed
          ? "color-mix(in oklab, var(--danger) 5%, var(--panel))"
          : "var(--panel)",
        boxShadow: [
          selected ? "0 0 0 1.5px var(--accent)" : null,
          failed ? glowShadow("var(--danger)") : null,
          "var(--lift-hi)",
          "var(--shadow-1)",
        ]
          .filter(Boolean)
          .join(", "),
        opacity: skipped ? 0.45 : 1,
        padding: "9px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        cursor: "pointer",
        overflow: "hidden",
        fontFamily: "var(--font-sans)",
        transition:
          "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <StepBadge index={index} status={status} size={22} showIndex />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            color: "var(--ink)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {step.title}
        </span>
        {complete ? (
          <span title="Complete" style={{ color: "var(--ok)", display: "inline-flex" }}>
            <CheckGlyph size={12} />
          </span>
        ) : failed ? (
          <span title={stepStatusLabel(status)} style={{ color: "var(--danger)", display: "inline-flex" }}>
            <CrossGlyph size={12} />
          </span>
        ) : null}
        {onToggleCollapse && <CollapseToggle collapsed onToggle={onToggleCollapse} />}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 9.5,
          fontVariantNumeric: "tabular-nums",
          color: "var(--muted)",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {skipped
            ? "skipped"
            : total > 0
              ? `${total} ${total === 1 ? "worker" : "workers"}`
              : stepStatusLabel(status)}
        </span>
        {startedAt && (
          <span style={{ flex: "0 0 auto" }}>
            <ElapsedTime startedAt={startedAt} finishedAt={finishedAt} />
          </span>
        )}
      </div>
    </article>
  );
}

function WorkerBatchNode({
  step,
  index,
  rows,
  fileCount,
  active,
  runPaused = false,
  selected,
  onSelect,
  reportByAttempt,
  attemptByTask,
  tasksById,
  onToggleCollapse,
}: StepNodeProps) {
  const [hover, setHover] = useState(false);
  const status = step.status;
  const inMotion = status === "running" || status === "reviewing";
  const held = runPaused && (active || inMotion);
  const tone = held ? statusColor("paused") : stepStatusColor(status);
  const verdict =
    reportByAttempt && attemptByTask && tasksById
      ? stepVerdict(step, attemptByTask, reportByAttempt, tasksById)
      : "none";
  const complete = status === "complete" || status === "skipped";
  const attention = status === "blocked" || status === "failed";
  const live = !runPaused && (active || inMotion);

  // Only genuine motion earns the spinner. A step that is merely the run's
  // current one (queued, waiting for Cora to spawn it) keeps the accent edge
  // but says its word, so the header can never spin over work not started.
  const spinning = !runPaused && inMotion;

  const total = rows.length;
  const rowStatuses = rows.map((row) => deriveAgentStatus(row.task, row.attempt, status));
  const done = rowStatuses.filter((rowStatus) => rowStatus === "done").length;
  const runningCount = rowStatuses.filter((rowStatus) => rowStatus === "running").length;
  const progress = total > 0 ? done / total : complete ? 1 : 0;
  // Retries hide behind logical worker rows; surface the raw try count when
  // it outgrows the worker count so the step admits its rework.
  const spawned = rows.filter((row) => row.task).length;
  const attemptTotal = rows.reduce(
    (sum, row) => sum + (row.attemptCount ?? (row.attempt ? 1 : 0)),
    0,
  );
  // The deepest round any one worker has reached — what "attempt 3" on the
  // console line means, as opposed to the batch-wide attemptTotal.
  const attemptRound = rows.reduce(
    (max, row) => Math.max(max, row.attemptCount ?? row.attempt?.attemptNumber ?? 0),
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

  // Every try across every row's lineage, not just the surviving attempts —
  // a step that retried twice was billed for all three runs.
  const cost = formatCostUsd(
    rows.reduce((sum, row) => {
      const tries = row.attempts ?? (row.attempt ? [row.attempt] : []);
      return sum + tries.reduce((spend, attempt) => spend + (attempt.costUsd ?? 0), 0);
    }, 0),
  );

  // A stopped step's own words: the first blocked worker's error, which says
  // far more than repeating "failed" the badge already showed.
  const failureText = attention
    ? firstLine(rows.find((_, i) => rowStatuses[i] === "blocked")?.attempt?.error)
    : undefined;
  const readout = stepConsoleLine({
    status,
    held,
    done,
    total,
    fileCount,
    runningCount,
    attemptRound,
    failureText,
  });

  const border = selected
    ? "var(--accent)"
    : attention
      ? "var(--danger)"
      : live
        ? "var(--accent-edge)"
        : held
          ? "color-mix(in oklch, var(--info) 46%, var(--rule))"
          : status === "complete"
            ? "color-mix(in oklch, var(--ok) 45%, var(--rule))"
            : hover
              ? "var(--rule-strong)"
              : "var(--rule)";
  const background = attention
    ? "color-mix(in oklab, var(--danger) 5%, var(--panel))"
    : live
      ? "color-mix(in oklab, var(--accent) 5%, var(--panel))"
      : held
        ? "color-mix(in oklab, var(--info) 4%, var(--panel))"
        : "var(--panel)";
  // Glow only for the two states that earn it. `live` is already false while
  // the run is paused, so a held step keeps its quiet info edge and nothing
  // around it suggests the work is still burning.
  const shadow = [
    selected ? "0 0 0 1.5px var(--accent)" : null,
    attention ? glowShadow("var(--danger)") : live ? glowShadow("var(--accent)") : null,
    "var(--lift-hi)",
    "var(--shadow-2)",
  ]
    .filter(Boolean)
    .join(", ");

  const footerStats = [
    total > 0 ? `${done}/${total} workers` : null,
    fileCount > 0 ? `${fileCount} ${fileCount === 1 ? "file" : "files"}` : null,
    attemptTotal > spawned && spawned > 0 ? `${attemptTotal} attempts` : null,
  ].filter(Boolean) as string[];

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
        borderRadius: 14,
        border: `1px solid ${border}`,
        background,
        boxShadow: shadow,
        // A skipped step stays legible but steps back out of the reading
        // order — it is part of the plan that did not happen.
        opacity: status === "skipped" ? 0.45 : 1,
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 7,
        cursor: "pointer",
        overflow: "hidden",
        fontFamily: "var(--font-sans)",
        transition:
          "border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out)",
      }}
    >
      <header
        style={{
          display: "grid",
          gridTemplateColumns: "28px minmax(0,1fr) auto",
          gap: 9,
          alignItems: "start",
        }}
      >
        <StepBadge index={index} status={status} tone={held ? tone : undefined} />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <span
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 9.5,
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
              letterSpacing: "-0.01em",
              lineHeight: 1.25,
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
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            flex: "0 0 auto",
            // Sits on the title's first line rather than the block's top edge.
            marginTop: 2,
          }}
        >
          <VerdictPill kind={verdict} compact />
          {attention ? (
            <span
              title={stepStatusLabel(status)}
              style={{ color: "var(--danger)", display: "inline-flex" }}
            >
              {status === "blocked" ? <AlertGlyph /> : <CrossGlyph />}
            </span>
          ) : spinning ? (
            <ArcSpinner />
          ) : status === "complete" ? (
            <span title="Complete" style={{ color: "var(--ok)", display: "inline-flex" }}>
              <CheckGlyph />
            </span>
          ) : (
            <StatusTag label={held ? "paused" : stepStatusLabel(status)} tone={tone} />
          )}
          {onToggleCollapse && <CollapseToggle collapsed={false} onToggle={onToggleCollapse} />}
        </div>
      </header>

      <p
        style={{
          margin: 0,
          color: "var(--ink-dim)",
          fontSize: 11,
          lineHeight: 1.4,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 1,
          WebkitBoxOrient: "vertical",
        }}
      >
        {step.goal || "Worker activity for this step."}
      </p>

      <ConsoleLine text={readout.text} tone={readout.tone} />

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 7,
          minWidth: 0,
        }}
      >
        <ProgressTrack
          progress={progress}
          tone={
            attention
              ? "var(--danger)"
              : held
                ? "var(--info)"
                : complete
                  ? "var(--ok)"
                  : "var(--accent)"
          }
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span
            title={
              attemptTotal > spawned && spawned > 0
                ? `${done} of ${total} workers finished · ${fileCount} files touched · ${spawned} workers ran ${attemptTotal} attempts, retries included`
                : `${done} of ${total} workers finished · ${fileCount} files touched`
            }
            style={{
              flex: 1,
              minWidth: 0,
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {footerStats.length > 0 ? footerStats.join(" · ") : "no workers yet"}
          </span>
          {cost && (
            <span title="Measured spend across this step's attempts" style={{ flex: "0 0 auto", color: "var(--muted)" }}>
              {cost}
            </span>
          )}
          {startedAt && (
            <span
              style={{
                flex: "0 0 auto",
                color: live ? "var(--accent)" : "var(--muted)",
                fontWeight: live ? 600 : undefined,
              }}
            >
              <ElapsedTime startedAt={startedAt} finishedAt={finishedAt} />
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

// The step card's console readout. Every branch is synthesized from the same
// rows the footer counts, so the line can never claim something the numbers
// beside it contradict. Ordered by precedence, not by status enum: a held run
// and a stopped step both outrank "still running", because a paused or failed
// step whose last persisted status is `running` must never narrate motion.
function stepConsoleLine(input: {
  status: StepState["status"];
  held: boolean;
  done: number;
  total: number;
  fileCount: number;
  runningCount: number;
  attemptRound: number;
  failureText?: string;
}): { text: string; tone: string } {
  const { status, held, done, total, fileCount, runningCount, attemptRound, failureText } = input;
  const files = `${fileCount} ${fileCount === 1 ? "file" : "files"}`;

  if (held) {
    return {
      text: total > 0 ? `paused · ${done}/${total} workers` : "paused",
      tone: "var(--info)",
    };
  }
  if (status === "blocked" || status === "failed") {
    const detail = failureText ?? (total > 0 ? `${done}/${total} workers finished` : "no workers ran");
    return { text: `${status} · ${detail}`, tone: "var(--danger)" };
  }
  if (status === "skipped") {
    return { text: "skipped", tone: "var(--muted)" };
  }
  if (status === "complete") {
    const parts = ["done"];
    if (total > 0) parts.push(`${total} ${total === 1 ? "worker" : "workers"}`);
    if (fileCount > 0) parts.push(files);
    return { text: parts.join(" · "), tone: "var(--ok)" };
  }
  if (status === "completed_unverified") {
    return {
      text: fileCount > 0 ? `landed unverified · ${files}` : "landed unverified",
      tone: "var(--warn)",
    };
  }
  if (status === "running" || status === "reviewing") {
    const parts: string[] = [];
    if (status === "reviewing") parts.push("reviewing");
    parts.push(total > 0 ? `${done}/${total} workers` : "spawning workers");
    if (runningCount > 0) parts.push(`${runningCount} running`);
    if (attemptRound > 1) parts.push(`attempt ${attemptRound}`);
    return { text: parts.join(" · "), tone: "var(--ink-dim)" };
  }
  if (status === "planning") {
    return { text: "planning…", tone: "var(--muted)" };
  }
  return { text: "waiting…", tone: "var(--muted)" };
}

// Brake / checkpoint step: a manager replanning pause, no workers. Lighter and
// dashed so it reads as a gate between worker batches rather than a work node.
function CheckpointNode({
  step,
  index,
  active,
  runPaused = false,
  selected,
  onSelect,
  onToggleCollapse,
}: StepNodeProps) {
  const [hover, setHover] = useState(false);
  const status = step.status;
  const inMotion = status === "running" || status === "reviewing";
  const held = runPaused && (active || inMotion);
  const tone = held ? statusColor("paused") : stepStatusColor(status);
  const live = !runPaused && (active || inMotion);
  const border = selected
    ? "var(--accent)"
    : live
      ? "var(--accent-edge)"
      : held
        ? "color-mix(in oklch, var(--info) 46%, var(--rule))"
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
        boxShadow: [
          selected ? "0 0 0 1.5px var(--accent)" : null,
          live ? glowShadow("var(--accent)") : null,
          "var(--shadow-1)",
        ]
          .filter(Boolean)
          .join(", "),
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
            borderRadius: 7,
            flex: "0 0 auto",
            border: `1px solid color-mix(in oklch, ${tone} 28%, var(--rule))`,
            background: `color-mix(in oklch, ${tone} 12%, transparent)`,
            color: tone,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CheckpointGlyph />
        </span>
        <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
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
        {onToggleCollapse && <CollapseToggle collapsed={false} onToggle={onToggleCollapse} />}
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
        <StatusDot status={held ? "paused" : status} size={6} />
        <StatusTag label={held ? "paused" : stepStatusLabel(status)} tone={tone} />
      </div>
    </article>
  );
}

// The header's icon chip: a tinted rounded square carrying the step's ordinal,
// or its outcome mark once the step is terminal. Tint and edge are mixed from
// the step's own tone rather than painted solid, so the chip stays a quiet
// anchor on light themes instead of a filled block.
function StepBadge({
  index,
  status,
  tone: toneOverride,
  size = 28,
  showIndex = false,
}: {
  index: number;
  status: StepState["status"];
  // Set when the node paints the step in a tone its own status cannot express
  // (a running step held by a paused run), so the badge agrees with the chip.
  tone?: string;
  size?: number;
  // Keep the ordinal even on a terminal step. The collapsed card needs it:
  // it has no "Step N" eyebrow to fall back on, and it shows the outcome as a
  // separate mark, so the chip is free to stay the number.
  showIndex?: boolean;
}) {
  const tone = toneOverride ?? stepStatusColor(status);
  const complete = !showIndex && (status === "complete" || status === "skipped");
  const failed = !showIndex && (status === "failed" || status === "blocked");
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: "0 0 auto",
        borderRadius: 7,
        border: `1px solid color-mix(in oklch, ${tone} 28%, var(--rule))`,
        background: `color-mix(in oklch, ${tone} 12%, transparent)`,
        color: tone,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {complete ? <CheckGlyph /> : failed ? <AlertGlyph /> : String(index)}
    </span>
  );
}

// ── Worker node ──────────────────────────────────────────────────────────────

interface WorkerNodeProps {
  row: AgentRow;
  stepStatus: StepState["status"];
  // True while the whole run is paused. A stop kills the worker's process but
  // an attempt caught mid-launch can still read as running, so the card is told
  // the run is held rather than inferring aliveness from a stale attempt.
  runPaused?: boolean;
  // Attempt-id keyed worker reports, threaded down from RunGraph. Optional so
  // the card still renders before the lazy report loader has read anything off
  // disk; the console line falls back to a bare "complete" until it lands.
  reportByAttempt?: ReadonlyMap<string, WorkerReport>;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}

export const WorkerNode = React.memo(function WorkerNode({
  row,
  stepStatus,
  runPaused = false,
  reportByAttempt,
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
  // A paused run has no worker doing work, whatever the last persisted attempt
  // status says, so the card drops every live affordance: no accent edge, no
  // pulsing dot, no "Running" word over a process the stop already killed.
  const held = runPaused && status === "running";
  const running = status === "running" && !held;
  const blocked = status === "blocked";
  const runtimeState = attempt?.runtimeState;
  const stateLabel = held
    ? "paused"
    : runtimeState
      ? runtimeState === "idle"
        ? "ready"
        : runtimeState === "working"
          ? "working"
          : runtimeState === "stalled"
            // Names the absence, not a state of the agent: Cora has heard
            // nothing from it for long enough that "working" would be a guess.
            ? "no response"
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
        : held
          ? "color-mix(in oklch, var(--info) 46%, var(--rule))"
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
  const stateColor = held ? statusColor("paused") : statusColor(status);

  // Two runtime states outlive their word: "no response" and "crashed" say
  // something a glyph cannot, so they keep the dot-and-word chip while every
  // other terminal state collapses to a spinner / check / cross.
  const wordyRuntime = runtimeState === "stalled" || runtimeState === "error";
  const indicator: "word" | "spinner" | "check" | "cross" =
    held || wordyRuntime
      ? "word"
      : running
        ? "spinner"
        : status === "done"
          ? "check"
          : blocked
            ? "cross"
            : "word";

  // What this worker is doing, in the card's one console line. A finished
  // worker speaks its report's own summary — the thing it was spawned to
  // produce — rather than repeating the check mark beside it. While it RUNS,
  // the live activity readout (the tool line the worker is on right now,
  // stall/retry detail included) beats the bare state word; the word stays
  // the fallback until a writer has reported anything.
  const report = attempt ? reportByAttempt?.get(attempt.id) : undefined;
  const liveActivity = running ? attempt?.runtimeActivity?.trim() : undefined;
  const readout: { text: string; tone: string } = held
    ? { text: "paused", tone: "var(--info)" }
    : queued
      ? { text: "queued", tone: "var(--muted)" }
      : blocked
        ? { text: firstLine(attempt?.error) ?? stateLabel, tone: "var(--danger)" }
        : status === "done"
          ? { text: firstLine(report?.summary) ?? "complete", tone: "var(--ok)" }
          : {
              text: liveActivity || stateLabel,
              tone:
                runtimeState === "error"
                  ? "var(--danger)"
                  : runtimeState === "stalled"
                    ? "var(--warn)"
                    : "var(--ink-dim)",
            };

  // A single worker has no done/total to fill against, so its rail sweeps
  // while the work is open and settles to a full outcome-toned bar when it
  // lands. A held worker gets a static info bar: present, but not travelling.
  const track: { progress: number; tone: string; indeterminate?: boolean } = held
    ? { progress: 1, tone: "var(--info)" }
    : running
      ? { progress: 1, tone: "var(--accent)", indeterminate: true }
      : status === "done"
        ? { progress: 1, tone: "var(--ok)" }
        : blocked
          ? { progress: 1, tone: "var(--danger)" }
          : { progress: 0, tone: "var(--muted)" };

  const cost = formatCostUsd(attempt?.costUsd);

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
            : held
              ? "color-mix(in oklab, var(--info) 4%, var(--panel))"
              : "var(--panel)",
        // The colored top edge is the worker card's silhouette cue, the band
        // that separates one card from the one stacked above it. While the
        // worker runs the edge turns accent and the card lifts a level: the
        // working lane must be structural, not just a tint. Model identity
        // stays on the chip. The outer glow joins it for the two states that
        // earn one — never while held, which has neither.
        boxShadow: [
          running
            ? "inset 0 2px 0 var(--accent)"
            : `inset 0 3px 0 color-mix(in oklch, ${tone.label} 78%, transparent)`,
          selected ? "0 0 0 1.5px var(--accent)" : null,
          blocked ? glowShadow("var(--danger)") : running ? glowShadow("var(--accent)") : null,
          "var(--lift-hi)",
          running ? "var(--shadow-2)" : "var(--shadow-1)",
        ]
          .filter(Boolean)
          .join(", "),
        opacity: queued ? 0.62 : 1,
        // Four rows in 82px: the padding and the line-heights below are the
        // budget. Anything added here has to come out of something else.
        padding: "8px 10px",
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
            lineHeight: 1.2,
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
        {/* The card's title, in the reference's header slot: what this worker
            was actually asked to do, not the slot it occupies. */}
        <span
          style={{
            minWidth: 0,
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 650,
            letterSpacing: "-0.01em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        {indicator === "spinner" ? (
          <ArcSpinner size={12} />
        ) : indicator === "check" ? (
          <span title="Complete" style={{ color: "var(--ok)", display: "inline-flex" }}>
            <CheckGlyph size={12} />
          </span>
        ) : indicator === "cross" ? (
          <span title="Blocked" style={{ color: "var(--danger)", display: "inline-flex" }}>
            <CrossGlyph size={12} />
          </span>
        ) : (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              color: held
                ? stateColor
                : runtimeState === "error" || blocked
                  ? "var(--danger)"
                  : runtimeState === "stalled"
                    ? "var(--warn)"
                    : runtimeState === "idle" || runtimeState === "done"
                      ? "var(--ok)"
                      : stateColor,
              fontFamily: "var(--font-sans)",
              fontSize: 9.5,
              fontWeight: 600,
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}
          >
            <StatusDot status={held ? "paused" : mapAgentToStepStatus(status)} size={5} />
            {sentenceCase(stateLabel)}
          </span>
        )}
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
      <ConsoleLine text={readout.text} tone={readout.tone} title={readout.text} />

      <div
        style={{
          marginTop: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 5,
          minWidth: 0,
          width: "100%",
        }}
      >
        <ProgressTrack
          progress={track.progress}
          tone={track.tone}
          indeterminate={track.indeterminate}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            minWidth: 0,
            width: "100%",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            lineHeight: 1.2,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {/* Role joins the model line here now that the header carries the
              worker's title. Ellipsis eats the model id first — the chip above
              already names the model in its short human form. */}
          <span
            title={`${role} · ${modelLine}`}
            style={{
              flex: 1,
              minWidth: 0,
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {role} · {modelLine}
          </span>
          {attemptOrdinal > 1 && (
            <span
              title={
                attemptHistory ??
                `${attemptOrdinal - 1} earlier ${attemptOrdinal === 2 ? "attempt" : "attempts"}`
              }
              style={{ flex: "0 0 auto", color: "var(--muted-2)" }}
            >
              attempt {attemptOrdinal}/{Math.max(WORKER_ATTEMPT_CAP, attemptOrdinal)}
            </span>
          )}
          {cost && (
            <span title="Measured spend for this attempt" style={{ flex: "0 0 auto", color: "var(--muted-2)" }}>
              {cost}
            </span>
          )}
          <span
            style={{
              flex: "0 0 auto",
              minWidth: 30,
              textAlign: "right",
              color: running ? "var(--accent)" : stateColor,
              fontWeight: running ? 600 : undefined,
            }}
          >
            {attempt ? (
              <ElapsedTime startedAt={attempt.startedAt} finishedAt={attempt.finishedAt} placeholder="—" />
            ) : (
              "—"
            )}
          </span>
        </div>
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
        // The terminal earns its glow only once the run has actually landed —
        // the one moment the whole spine is finished.
        boxShadow: [
          complete ? glowShadow("var(--ok)") : failed ? glowShadow("var(--danger)") : null,
          "var(--lift-hi)",
          "var(--shadow-1)",
        ]
          .filter(Boolean)
          .join(", "),
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

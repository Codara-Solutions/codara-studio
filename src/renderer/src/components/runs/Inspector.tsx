import React, { useEffect, useMemo, useState } from "react";
import type {
  RunState,
  SparkCall,
  StepState,
  VerifierVerdict,
  WorkerAttempt,
  WorkerReport,
  WorkerTask,
} from "@shared/types";
import { contextWindowForModel } from "@shared/context-window";
import {
  attemptStatusColor,
  deriveAgentStatus,
  formatClock,
  formatDuration,
  isRunStillTicking,
  type RunMaps,
  runtimeTone,
  sentenceCase,
  sortSteps,
  statusColor,
  stepStatusColor,
  stepStatusLabel,
  WORKER_ATTEMPT_CAP,
  workerModelLabel,
} from "./run-format";
import { attemptsForTask, logicalWorkers, logicalWorkersForStep } from "../../lib/worker-identity";
import { ElapsedChip, ElapsedTime } from "./elapsed";
import { StatusDot } from "./GraphNodes";
import type { RunExecutionProjection } from "../../lib/useRunExecutionRecord";

// The docked inspector. One panel, selection-driven: the run summary when
// nothing is picked, a step's full detail when a step node is clicked, a
// worker's prompt + report when a worker node is clicked. It replaces the old
// always-on STEP / WORKERS panels and the slide-up detail strips both.

interface Props {
  run: RunState;
  maps: RunMaps;
  reportByAttempt: ReadonlyMap<string, WorkerReport>;
  execution: RunExecutionProjection;
  selectedStepId: string | null;
  selectedWorkerTaskId: string | null;
  onSelectStep: (id: string) => void;
  onSelectWorker: (id: string) => void;
  // Returns whether a terminal pane was actually focused. A finished worker's
  // pane may be gone (closed, app restart), so the button explains the miss
  // instead of silently doing nothing.
  onOpenWorkerTerminal?: (workerTaskId: string) => boolean;
  onClear: () => void;
}

export default function Inspector({
  run,
  maps,
  reportByAttempt,
  execution,
  selectedStepId,
  selectedWorkerTaskId,
  onSelectStep,
  onSelectWorker,
  onOpenWorkerTerminal,
  onClear,
}: Props) {
  const orderedSteps = useMemo(() => sortSteps(run.steps), [run.steps]);
  const stepIndex = useMemo(() => {
    const map = new Map<string, number>();
    orderedSteps.forEach((step, i) => map.set(step.id, i + 1));
    return map;
  }, [orderedSteps]);

  // Resolve the selection through the supersedes chain: a selection made
  // before a runtime-fallback clone points at the cancelled predecessor, which
  // the collapsed graph no longer renders — follow it to the surviving task
  // instead of opening a phantom worker.
  const selectedWorker = useMemo(() => {
    if (!selectedWorkerTaskId) return null;
    return (
      logicalWorkers(run).find(
        (worker) =>
          worker.task.id === selectedWorkerTaskId ||
          worker.supersededTasks.some((superseded) => superseded.id === selectedWorkerTaskId),
      ) ?? null
    );
  }, [run, selectedWorkerTaskId]);
  const selectedTask =
    selectedWorker?.task ??
    (selectedWorkerTaskId ? maps.taskById.get(selectedWorkerTaskId) ?? null : null);
  // Full attempt history for the selected worker — the detail pane shows every
  // try across the supersedes chain (predecessor attempts included), not just
  // the latest attempt the maps collapse to.
  const selectedAttempts = useMemo(
    () =>
      selectedWorker
        ? selectedWorker.attempts
        : selectedTask
          ? attemptsForTask(run, selectedTask.id)
          : [],
    [selectedWorker, run, selectedTask],
  );
  const selectedStep = selectedTask?.stepId
    ? run.steps.find((step) => step.id === selectedTask.stepId) ?? null
    : selectedStepId
      ? run.steps.find((step) => step.id === selectedStepId) ?? null
      : null;
  const mode: "run" | "step" | "worker" = selectedTask ? "worker" : selectedStepId ? "step" : "run";

  return (
    <aside
      style={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--panel)",
        borderLeft: "1px solid var(--rule)",
      }}
    >
      <Header
        mode={mode}
        stepLabel={selectedStep ? `Step ${pad(stepIndex.get(selectedStep.id) ?? 0)}` : "Step"}
        onStepCrumb={selectedStep ? () => onSelectStep(selectedStep.id) : undefined}
        workerLabel={selectedTask ? workerShortLabel(selectedTask, selectedStep, stepIndex) : ""}
        onClear={onClear}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {mode === "worker" && selectedTask ? (
          <WorkerDetail
            task={selectedTask}
            attempt={maps.attemptByTask.get(selectedTask.id) ?? null}
            attempts={selectedAttempts}
            step={selectedStep}
            reportByAttempt={reportByAttempt}
            onOpenTerminal={onOpenWorkerTerminal
              ? () => onOpenWorkerTerminal(selectedTask.id)
              : undefined}
          />
        ) : mode === "step" && selectedStep ? (
          <StepDetail
            run={run}
            step={selectedStep}
            index={stepIndex.get(selectedStep.id) ?? 0}
            maps={maps}
            reportByAttempt={reportByAttempt}
            onSelectWorker={onSelectWorker}
          />
        ) : (
          <RunSummary
            run={run}
            steps={orderedSteps}
            onSelectStep={onSelectStep}
            execution={execution}
          />
        )}
      </div>
    </aside>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

function Header({
  mode,
  stepLabel,
  onStepCrumb,
  workerLabel,
  onClear,
}: {
  mode: "run" | "step" | "worker";
  stepLabel: string;
  onStepCrumb?: () => void;
  workerLabel: string;
  onClear: () => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 42,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px 0 14px",
        minWidth: 0,
        borderBottom: "1px solid var(--rule-soft)",
        background: "var(--panel)",
        boxShadow: "var(--lift-hi)",
      }}
    >
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        Inspector
      </span>
      {mode !== "run" && <Caret />}
      {mode === "step" && <Crumb label={stepLabel} current />}
      {mode === "worker" && (
        <>
          <Crumb label={stepLabel} onClick={onStepCrumb} />
          <Caret />
          <Crumb label={workerLabel} current />
        </>
      )}
      <span style={{ flex: 1 }} />
      {mode !== "run" && (
        <button
          type="button"
          onClick={onClear}
          title="Clear selection"
          style={{
            appearance: "none",
            width: 24,
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--muted)",
            cursor: "default",
            transition: "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--hover)";
            e.currentTarget.style.color = "var(--ink-dim)";
            e.currentTarget.style.borderColor = "var(--rule)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--muted)";
            e.currentTarget.style.borderColor = "var(--rule-soft)";
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

function Caret() {
  return (
    <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden style={{ color: "var(--muted-2)" }}>
      <path d="M3 1.5 L5.5 4 L3 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Crumb({ label, current, onClick }: { label: string; current?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        appearance: "none",
        border: "none",
        background: "transparent",
        padding: 0,
        color: current ? "var(--ink)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 11.5,
        fontWeight: current ? 700 : 500,
        cursor: "default",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        minWidth: 0,
        maxWidth: current ? 140 : 84,
        transition: "color var(--motion-fast) var(--ease-out)",
      }}
      onMouseEnter={onClick ? (e) => (e.currentTarget.style.color = "var(--ink)") : undefined}
      onMouseLeave={onClick ? (e) => (e.currentTarget.style.color = "var(--ink-dim)") : undefined}
    >
      {label}
    </button>
  );
}

// ── Shared layout atoms ──────────────────────────────────────────────────────

function Section({
  title,
  meta,
  first,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        padding: "14px 16px",
        borderTop: first ? "none" : "1px solid var(--rule-soft)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {meta}
      </div>
      {children}
    </section>
  );
}

function SnapshotCard({
  title,
  subtitle,
  tone,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  tone: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid color-mix(in oklch, ${tone} 42%, var(--rule))`,
        borderRadius: 9,
        background: `color-mix(in oklch, ${tone} 6%, var(--panel))`,
        boxShadow: "var(--shadow-1)",
        padding: "12px 13px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 }}>
        <span
          style={{
            width: 9,
            height: 9,
            marginTop: 4,
            flex: "0 0 auto",
            borderRadius: 999,
            background: tone,
          }}
        />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <div style={{ color: "var(--ink)", fontSize: 13, fontWeight: 700, lineHeight: 1.3 }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ color: "var(--ink-dim)", fontSize: 11.5, lineHeight: 1.45 }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function QuickStats({ items }: { items: Array<{ label: string; value: React.ReactNode; tone?: string }> }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(3, Math.max(1, items.length))}, minmax(0, 1fr))`,
        gap: 1,
        background: "var(--rule-soft)",
        border: "1px solid var(--rule-soft)",
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {items.map((item) => (
        <MetricCell key={item.label} label={item.label} value={item.value} tone={item.tone} compact />
      ))}
    </div>
  );
}

function MetaCount({ value }: { value: number | string }) {
  return (
    <span
      style={{
        color: "var(--muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {typeof value === "number" ? pad(value) : value}
    </span>
  );
}

function MutedNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 11.5,
        lineHeight: 1.5,
      }}
    >
      {children}
    </p>
  );
}

function Bar({ value, tone }: { value: number; tone: string }) {
  return (
    <div style={{ height: 5, borderRadius: 999, background: "var(--rule-soft)", overflow: "hidden" }}>
      <div
        style={{
          width: `${Math.max(0, Math.min(100, value))}%`,
          height: "100%",
          borderRadius: 999,
          background: tone,
          transition: "width var(--motion) var(--ease-out)",
        }}
      />
    </div>
  );
}

// A small status mark — check / cross / live dot / hollow ring.
function Mark({ kind }: { kind: "done" | "failed" | "running" | "pending" }) {
  const color =
    kind === "done"
      ? "var(--ok)"
      : kind === "failed"
        ? "var(--danger)"
        : kind === "running"
          ? "var(--accent)"
          : "var(--muted)";
  return (
    <span
      style={{
        width: 15,
        height: 15,
        flex: "0 0 auto",
        borderRadius: 999,
        border: `1.4px solid ${color}`,
        background: kind === "done" ? "var(--ok-soft)" : kind === "failed" ? "var(--danger-soft)" : "transparent",
        color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {kind === "done" && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M2 5.2 4 7.2 8 2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
      {kind === "failed" && (
        <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden>
          <path d="M2 2l4 4M6 2l-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
      {kind === "running" && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: color,
          }}
        />
      )}
    </span>
  );
}

// Names the MODEL; the runtime only picks the chip's colour. Under Pi the
// provider is just which subscription was authenticated, so it belongs in the
// tooltip, not in the chip the eye lands on. Falls back to the runtime name
// for attempts recorded before the model was persisted.
function ModelTag({
  runtime,
  model,
}: {
  runtime: WorkerTask["runtimePreference"];
  model?: string;
}) {
  const tone = runtimeTone(runtime);
  return (
    <span
      title={model ? `${model}, Pi harness, authenticated as ${runtime}` : undefined}
      style={{
        flex: "0 0 auto",
        color: tone.label,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 4,
        padding: "2px 6px",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fontWeight: 650,
        letterSpacing: "0.04em",
        // No uppercase: this chip used to hold a bare runtime name ("claude"),
        // which reads as a label, but now holds a model name with a version in
        // it. "OPUS 4.8" is harder to read than "Opus 4.8", and the run header
        // renders the same string, they must not disagree.
      }}
    >
      {workerModelLabel(model, runtime)}
    </span>
  );
}

function ListItem({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <div
      style={{
        color: tone ?? "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        fontSize: 11.5,
        lineHeight: 1.5,
        display: "flex",
        gap: 8,
      }}
    >
      <span style={{ color: "var(--muted-2)", flex: "0 0 auto" }}>—</span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

// ── Run summary ──────────────────────────────────────────────────────────────

function RunSummary({
  run,
  steps,
  onSelectStep,
  execution,
}: {
  run: RunState;
  steps: StepState[];
  onSelectStep: (id: string) => void;
  execution: RunExecutionProjection;
}) {
  const liveStep =
    steps.find((step) => step.id === run.currentStepId) ??
    steps.find((step) => step.status === "running" || step.status === "reviewing");
  const completeCount = steps.filter((s) => s.status === "complete" || s.status === "skipped").length;
  const attention = collectAttention(run, steps, onSelectStep);
  const activity = recentActivity(run);
  const progress = steps.length > 0 ? Math.round((completeCount / steps.length) * 100) : 0;
  const runningWorkers = run.workerTasks.filter((task) => task.status === "running" || task.status === "claimed").length;
  const blockedWorkers = run.workerTasks.filter((task) => task.status === "blocked" || task.status === "failed").length;
  const runTone = statusColor(run.status);
  const context = latestContextSnapshot(run);

  return (
    <>
      <Section title="Overview" first>
        <SnapshotCard
          title={run.title || "Untitled run"}
          subtitle={friendlyRunLine(run, liveStep, attention.length)}
          tone={runTone}
        >
          <Bar value={progress} tone={run.status === "complete" ? "var(--ok)" : runTone} />
          <QuickStats
            items={[
              { label: "Done", value: `${completeCount}/${steps.length || 0}`, tone: run.status === "complete" ? "var(--ok)" : undefined },
              {
                label: "Elapsed",
                value: (
                  <ElapsedTime
                    startedAt={run.createdAt}
                    finishedAt={isRunStillTicking(run) ? undefined : (run.completedAt ?? run.updatedAt)}
                  />
                ),
              },
              {
                label: blockedWorkers > 0 ? "Blocked" : "Active",
                value: blockedWorkers > 0 ? String(blockedWorkers) : String(runningWorkers),
                tone: blockedWorkers > 0 ? "var(--danger)" : runningWorkers > 0 ? "var(--accent)" : "var(--ink)",
              },
            ]}
          />
        </SnapshotCard>
      </Section>

      {execution.result && (
        <Section
          title="Result evidence"
          meta={<MetaCount value={`${execution.result.workspaceDelta.length} files`} />}
        >
          <SnapshotCard
            title={execution.result.summary}
            subtitle={`${execution.result.checks.filter((check) => check.result === "passed").length} passed checks · ${execution.result.evidence.length} evidence items · ${execution.result.workspace.mode.replace("_", " ")}`}
            tone="var(--ok)"
          >
            <QuickStats
              items={[
                { label: "Files", value: execution.result.workspaceDelta.length },
                { label: "Checks", value: execution.result.checks.length },
                { label: "Risks", value: execution.result.risks.length, tone: execution.result.risks.length ? "var(--warn)" : undefined },
              ]}
            />
          </SnapshotCard>
        </Section>
      )}

      <Section title="Context" meta={context ? <MetaCount value={`${context.percent}%`} /> : undefined}>
        {context ? (
          <SnapshotCard
            title={`${formatTokens(context.used)} / ${formatTokens(context.total)}`}
            subtitle={`${context.mode.replace(/_/g, " ")} · ${context.model}${context.estimated ? " · est." : ""}`}
            tone={context.tone}
          >
            <Bar value={context.percent} tone={context.tone} />
            <QuickStats
              items={[
                { label: "Used", value: formatTokens(context.used), tone: context.tone },
                { label: "Window", value: formatTokens(context.total) },
                { label: "Calls", value: String(run.sparkCalls.length) },
              ]}
            />
          </SnapshotCard>
        ) : (
          <MutedNote>No manager calls yet.</MutedNote>
        )}
      </Section>

      <Section title="Now">
        {liveStep ? (
          <button
            type="button"
            onClick={() => onSelectStep(liveStep.id)}
            style={{
              appearance: "none",
              textAlign: "left",
              border: "1px solid var(--accent-edge)",
              borderRadius: 8,
              background: "color-mix(in oklch, var(--accent) 7%, var(--panel-2))",
              boxShadow: "var(--shadow-1)",
              padding: "11px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              cursor: "default",
              transition: "background var(--motion-fast) var(--ease-out)",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "color-mix(in oklch, var(--accent) 12%, var(--panel-2))")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "color-mix(in oklch, var(--accent) 7%, var(--panel-2))")
            }
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <StatusDot status={liveStep.status} size={6} />
              <span
                style={{
                  color: "var(--accent-text)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.03em",
                }}
              >
                Step {pad(steps.indexOf(liveStep) + 1)} · {sentenceCase(stepStatusLabel(liveStep.status))}
              </span>
            </div>
            <span style={{ color: "var(--ink)", fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>
              {liveStep.title}
            </span>
          </button>
        ) : (
          <MutedNote>
            {run.status === "complete"
              ? "Run complete. Every step finished."
              : run.status === "planning"
                ? "Cora is reading the plan and shaping the first steps."
                : run.status === "failed" || run.status === "blocked"
                  ? "Run stopped. See what needs you below."
                  : "No step is running right now."}
          </MutedNote>
        )}
      </Section>

      <Section title="Progress" meta={<MetaCount value={`${completeCount}/${steps.length || 0}`} />}>
        {steps.length === 0 ? (
          <MutedNote>Steps appear here once Cora plans them.</MutedNote>
        ) : (
          <div style={{ display: "flex", gap: 3 }}>
            {steps.map((step, i) => (
              <button
                type="button"
                key={step.id}
                title={`Step ${pad(i + 1)} · ${step.title}`}
                onClick={() => onSelectStep(step.id)}
                style={{
                  appearance: "none",
                  border: "none",
                  flex: 1,
                  height: 6,
                  borderRadius: 2,
                  cursor: "default",
                  padding: 0,
                  background:
                    step.status === "running" || step.status === "reviewing"
                      ? "var(--accent)"
                      : stepStatusColor(step.status),
                  transition: "opacity var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Needs attention" meta={attention.length > 0 ? <MetaCount value={attention.length} /> : undefined}>
        {attention.length === 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Mark kind="done" />
            <span style={{ color: "var(--ink-dim)", fontSize: 11.5 }}>Nothing needs attention.</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {attention.map((item, i) => (
              <div
                key={i}
                onClick={item.onClick}
                style={{
                  display: "flex",
                  gap: 9,
                  alignItems: "flex-start",
                  padding: "8px 10px",
                  borderRadius: 7,
                  border: `1px solid color-mix(in oklch, ${item.tone} 45%, var(--rule))`,
                  background: `color-mix(in oklch, ${item.tone} 9%, transparent)`,
                  cursor: "default",
                  transition: "background var(--motion-fast) var(--ease-out)",
                }}
                onMouseEnter={
                  item.onClick
                    ? (e) => (e.currentTarget.style.background = `color-mix(in oklch, ${item.tone} 15%, transparent)`)
                    : undefined
                }
                onMouseLeave={
                  item.onClick
                    ? (e) => (e.currentTarget.style.background = `color-mix(in oklch, ${item.tone} 9%, transparent)`)
                    : undefined
                }
              >
                <span style={{ marginTop: 1 }}>
                  <Mark kind={item.mark} />
                </span>
                <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ color: "var(--ink)", fontSize: 11.5, fontWeight: 600 }}>{item.title}</span>
                  {item.detail && (
                    <span style={{ color: "var(--ink-dim)", fontSize: 11, lineHeight: 1.45 }}>{item.detail}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent activity">
        {activity.length === 0 ? (
          <MutedNote>No worker or manager activity yet.</MutedNote>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {activity.map((item, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "62px minmax(0,1fr) auto",
                  gap: 9,
                  alignItems: "baseline",
                }}
              >
                <span
                  style={{
                    color: "var(--muted)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {item.when}
                </span>
                <span
                  style={{
                    color: "var(--ink-dim)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={item.label}
                >
                  {item.label}
                </span>
                <span
                  style={{
                    color: item.tone,
                    fontFamily: "var(--font-sans)",
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: "0.02em",
                  }}
                >
                  {sentenceCase(item.state)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Run">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1, background: "var(--rule-soft)", border: "1px solid var(--rule-soft)", borderRadius: 7, overflow: "hidden" }}>
          <MetricCell label="Steps" value={String(run.steps.length)} />
          {/* Workers counts logical workers (supersedes chains collapsed);
              the attempts cell owns the raw try count, retries included. */}
          <MetricCell
            label="Workers"
            value={String(logicalWorkers(run).length)}
            title="Logical workers — a retried or replaced task still counts once"
          />
          <MetricCell
            label="All attempts"
            value={String(run.workerAttempts.length)}
            title="Every attempt, retries included"
          />
          <MetricCell label="Autopilot" value={run.autopilot?.status ?? "idle"} />
          <MetricCell label="Complexity" value={run.taskComplexity ?? "—"} />
          <MetricCell
            label="Elapsed"
            value={
              <ElapsedTime
                startedAt={run.createdAt}
                finishedAt={isRunStillTicking(run) ? undefined : (run.completedAt ?? run.updatedAt)}
              />
            }
          />
        </div>
      </Section>
    </>
  );
}

function MetricCell({
  label,
  value,
  tone,
  compact,
  title,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
  compact?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      style={{
        background: "var(--panel)",
        padding: compact ? "8px 9px" : "9px 10px",
        display: "flex",
        flexDirection: "column",
        gap: compact ? 3 : 4,
        minWidth: 0,
      }}
    >
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: tone ?? "var(--ink)",
          fontFamily: "var(--font-mono)",
          fontSize: compact ? 11.5 : 12.5,
          fontWeight: 600,
          fontVariantNumeric: "tabular-nums",
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

// ── Step detail ──────────────────────────────────────────────────────────────

function StepDetail({
  run,
  step,
  index,
  maps,
  reportByAttempt,
  onSelectWorker,
}: {
  run: RunState;
  step: StepState;
  index: number;
  maps: RunMaps;
  reportByAttempt: ReadonlyMap<string, WorkerReport>;
  onSelectWorker: (id: string) => void;
}) {
  const tone = stepStatusColor(step.status);
  // Logical workers only: a task superseded by a runtime-fallback clone folds
  // into its replacement, matching the collapsed lanes the graph renders — the
  // list, counts and progress must not resurrect phantom cancelled tasks.
  const tasks = logicalWorkersForStep(run, step.id).map((worker) => worker.task);
  const done = tasks.filter(
    (task) => deriveAgentStatus(task, maps.attemptByTask.get(task.id), step.status) === "done",
  ).length;
  const progress = tasks.length > 0 ? (done / tasks.length) * 100 : step.status === "complete" ? 100 : 0;
  const markKind = stepMark(step.status);
  const activeWorkers = tasks.filter((task) => {
    const attempt = maps.attemptByTask.get(task.id);
    return deriveAgentStatus(task, attempt, step.status) === "running";
  }).length;

  const latestReport = pickLatestReport(tasks, maps.attemptByTask, reportByAttempt);

  return (
    <>
      <Section title={`Step ${pad(index)}`} meta={<StatusWord label={stepStatusLabel(step.status)} tone={tone} />} first>
        <SnapshotCard title={step.title} subtitle={friendlyStepLine(step, tasks.length, done)} tone={tone}>
          <Bar value={progress} tone={step.status === "complete" ? "var(--ok)" : tone} />
          <QuickStats
            items={[
              { label: "Workers", value: tasks.length > 0 ? `${done}/${tasks.length}` : "none" },
              { label: "Active", value: String(activeWorkers), tone: activeWorkers > 0 ? "var(--accent)" : undefined },
              { label: "Risk", value: step.riskLevel ?? "normal", tone: step.riskLevel === "high" ? "var(--danger)" : step.riskLevel === "medium" ? "var(--warn)" : undefined },
            ]}
          />
        </SnapshotCard>
      </Section>

      <Section title="Goal">
        <MutedNote>{step.goal || "No goal recorded for this step yet."}</MutedNote>
      </Section>

      {tasks.length > 0 && (
        <Section title="Worker progress" meta={<MetaCount value={`${done}/${tasks.length}`} />}>
          <Bar value={progress} tone={step.status === "complete" ? "var(--ok)" : "var(--accent)"} />
        </Section>
      )}

      {step.acceptanceCriteria.length > 0 && (
        <Section title="Acceptance" meta={<MetaCount value={step.acceptanceCriteria.length} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {step.acceptanceCriteria.map((text, i) => (
              <div key={i} style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                <span style={{ marginTop: 1 }}>
                  <Mark kind={markKind} />
                </span>
                <span style={{ color: "var(--ink-dim)", fontSize: 11.5, lineHeight: 1.5 }}>{text}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {step.verificationCommands.length > 0 && (
        <Section title="Verification" meta={<MetaCount value={step.verificationCommands.length} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {step.verificationCommands.map((cmd, i) => (
              <code
                key={i}
                style={{
                  display: "block",
                  padding: "7px 9px",
                  background: "color-mix(in oklab, var(--bg) 70%, transparent)",
                  border: "1px solid var(--rule-soft)",
                  borderRadius: 6,
                  color: "var(--ink-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  wordBreak: "break-word",
                }}
              >
                {cmd}
              </code>
            ))}
          </div>
        </Section>
      )}

      <Section title="Workers" meta={<MetaCount value={tasks.length} />}>
        {tasks.length === 0 ? (
          <MutedNote>No worker tasks yet. Cora queues them as the step runs.</MutedNote>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {tasks.map((task) => {
              const attempt = maps.attemptByTask.get(task.id);
              const status = deriveAgentStatus(task, attempt, step.status);
              const liveRuntime = attempt?.runtime ?? task.runtimePreference;
              const liveModel = attempt?.model ?? task.modelHint;
              return (
                <button
                  type="button"
                  key={task.id}
                  onClick={() => onSelectWorker(task.id)}
                  style={{
                    appearance: "none",
                    textAlign: "left",
                    border: "1px solid var(--rule-soft)",
                    borderRadius: 7,
                    background: "color-mix(in oklab, var(--ink) 2%, transparent)",
                    padding: "8px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 5,
                    cursor: "default",
                    transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--hover)";
                    e.currentTarget.style.borderColor = "var(--rule)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "color-mix(in oklab, var(--ink) 2%, transparent)";
                    e.currentTarget.style.borderColor = "var(--rule-soft)";
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <ModelTag runtime={liveRuntime} model={liveModel} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        color: "var(--ink)",
                        fontSize: 11.5,
                        fontWeight: 600,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {task.title}
                    </span>
                    <StatusDot status={status === "done" ? "complete" : status === "blocked" ? "failed" : status === "running" ? "running" : "queued"} size={6} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: 10 }}>
                      {sentenceCase(attempt?.status ?? task.status)}
                    </span>
                    <span
                      style={{
                        color: "var(--muted)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 10,
                        fontVariantNumeric: "tabular-nums",
                        minWidth: 34,
                        textAlign: "right",
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
            })}
          </div>
        )}
      </Section>

      {latestReport && (
        <Section title="Latest report">
          <ReportView report={latestReport} compact />
        </Section>
      )}

      {step.reviewSummary && (
        <Section title="Review">
          <MutedNote>{step.reviewSummary}</MutedNote>
        </Section>
      )}
    </>
  );
}

function StatusWord({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      style={{
        color: tone,
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      {sentenceCase(label)}
    </span>
  );
}

// ── Worker detail ────────────────────────────────────────────────────────────

function WorkerDetail({
  task,
  attempt,
  attempts,
  step,
  reportByAttempt,
  onOpenTerminal,
}: {
  task: WorkerTask;
  attempt: WorkerAttempt | null;
  // Every attempt across the worker's supersedes chain, oldest first — the
  // full retry lineage, predecessor tasks included.
  attempts: WorkerAttempt[];
  step: StepState | null;
  reportByAttempt: ReadonlyMap<string, WorkerReport>;
  // Returns whether a terminal pane was actually focused (App owns the panes).
  onOpenTerminal?: () => boolean;
}) {
  // Transient "no terminal to open" notice. A finished worker's pane does not
  // survive an app restart (and a Pi display session dies with its attempt),
  // so the button must say why nothing happened rather than being a dead
  // click. Cleared on a timer AND keyed to the task so a miss on one worker
  // never lingers onto another's detail view.
  const [terminalMissTaskId, setTerminalMissTaskId] = useState<string | null>(null);
  useEffect(() => {
    if (!terminalMissTaskId) return;
    const timer = window.setTimeout(() => setTerminalMissTaskId(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [terminalMissTaskId]);
  const terminalMiss = terminalMissTaskId === task.id;
  const status = deriveAgentStatus(task, attempt ?? undefined, step?.status ?? "running");
  const report = attempt ? reportByAttempt.get(attempt.id) : undefined;
  // Ordinal of the current attempt within the chain-wide lineage. Attempt
  // numbers restart at 1 on a fallback clone, so the raw attemptNumber would
  // contradict the graph card's chain-summed count.
  const attemptIndex = attempt ? attempts.findIndex((entry) => entry.id === attempt.id) : -1;
  const attemptOrdinal = attempt
    ? attemptIndex >= 0
      ? attemptIndex + 1
      : attempt.attemptNumber
    : 0;
  // The attempt's resolved model beats the task's hint, the hint can be
  // coerced onto the worker roster at spawn, and it is frequently unset, which
  // used to drop the model from this line entirely.
  const meta = [
    attempt?.model ?? task.modelHint,
    task.effortHint,
    task.taskClass,
    attempt ? `attempt ${attemptOrdinal}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const tone = statusColor(status);

  return (
    <>
      <Section title="Worker" first meta={<StatusWord label={attempt?.status ?? task.status} tone={tone} />}>
        <SnapshotCard title={task.title} subtitle={friendlyWorkerLine(task, attempt, status, report)} tone={tone}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <ModelTag
              runtime={attempt?.runtime ?? task.runtimePreference}
              model={attempt?.model ?? task.modelHint}
            />
            <ElapsedChip
              startedAt={attempt?.startedAt}
              finishedAt={attempt?.finishedAt}
              tone={status === "running" ? "var(--accent)" : "var(--ink-dim)"}
            />
            {onOpenTerminal && (
              <button
                type="button"
                aria-label="Open worker terminal"
                title={
                  terminalMiss
                    ? "This worker's terminal is no longer open — its pane closed or did not survive a restart."
                    : "Open this worker's terminal"
                }
                onClick={() => {
                  setTerminalMissTaskId(onOpenTerminal() ? null : task.id);
                }}
                style={{
                  marginLeft: "auto",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 9px",
                  border: `1px solid ${terminalMiss ? "color-mix(in oklch, var(--warn) 55%, var(--rule))" : "var(--rule)"}`,
                  borderRadius: 7,
                  background: "var(--bg)",
                  color: terminalMiss ? "var(--warn)" : "var(--ink-dim)",
                  fontSize: 10.5,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                {terminalMiss ? "No terminal open" : "Open terminal"}
                <svg width={10} height={10} viewBox="0 0 12 12" fill="none" aria-hidden>
                  <path
                    d="M4 3h5v5M9 3 3 9"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
          <QuickStats
            items={[
              { label: "Status", value: status, tone },
              {
                label: "Attempt",
                value: attempt
                  ? attempts.length > 1
                    ? `${attemptOrdinal} of ${Math.max(WORKER_ATTEMPT_CAP, attempts.length)}`
                    : String(attemptOrdinal)
                  : "none",
              },
              {
                label: "Report",
                value: report?.status ?? (status === "running" || attempt?.finalReportPath ? "pending" : "none"),
                tone: report ? tone : status === "running" ? "var(--info)" : undefined,
              },
            ]}
          />
          {meta && (
            <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.03em" }}>
              {meta}
            </span>
          )}
        </SnapshotCard>
      </Section>

      {attempts.length > 1 && (
        <Section title="Attempts" meta={<MetaCount value={attempts.length} />}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {attempts.map((entry, i) => {
              const verdict = reportByAttempt.get(entry.id)?.verifier?.confidence;
              const current = entry.id === attempt?.id;
              return (
                <div
                  key={entry.id}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                    padding: "6px 9px",
                    border: `1px solid ${current ? "var(--rule)" : "var(--rule-soft)"}`,
                    borderRadius: 6,
                    background: current
                      ? "color-mix(in oklab, var(--ink) 3%, transparent)"
                      : "transparent",
                    minWidth: 0,
                  }}
                >
                  <span
                    style={{
                      color: "var(--muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontVariantNumeric: "tabular-nums",
                      flex: "0 0 auto",
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    style={{
                      color: "var(--ink-dim)",
                      fontFamily: "var(--font-sans)",
                      fontSize: 11,
                      fontWeight: 600,
                      flex: "0 0 auto",
                    }}
                  >
                    {entry.runtime}
                  </span>
                  <span
                    style={{
                      color: attemptStatusColor(entry.status),
                      fontFamily: "var(--font-sans)",
                      fontSize: 10.5,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      minWidth: 0,
                    }}
                  >
                    {sentenceCase(entry.status)}
                  </span>
                  <span style={{ flex: 1 }} />
                  {verdict && (
                    <span
                      title="Verifier verdict for this attempt"
                      style={{
                        color: "var(--muted)",
                        fontFamily: "var(--font-sans)",
                        fontSize: 10,
                        flex: "0 0 auto",
                      }}
                    >
                      {sentenceCase(verdict)}
                    </span>
                  )}
                  <span
                    style={{
                      color: "var(--muted)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      fontVariantNumeric: "tabular-nums",
                      flex: "0 0 auto",
                    }}
                  >
                    {formatDuration(entry.startedAt, entry.finishedAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Report">
        {report ? (
          <ReportView report={report} />
        ) : status === "running" ? (
          <PendingReport attempt={attempt} />
        ) : attempt?.finalReportPath ? (
          <ReportSkeleton />
        ) : (
          <MutedNote>This worker has not filed a structured report.</MutedNote>
        )}
      </Section>

      {(task.allowedPaths.length > 0 || task.forbiddenPaths.length > 0 || task.expectedOutputs.length > 0) && (
        <Section title="Deliverables & scope">
          {task.allowedPaths.length > 0 && (
            <PathList label="allowed" tone="var(--ok)" paths={task.allowedPaths} />
          )}
          {task.forbiddenPaths.length > 0 && (
            <PathList label="forbidden" tone="var(--danger)" paths={task.forbiddenPaths} />
          )}
          {task.expectedOutputs.length > 0 && (
            <PathList label="expected" tone="var(--info)" paths={task.expectedOutputs} />
          )}
        </Section>
      )}

      {task.description && (
        <Section title="Task brief">
          <TaskBrief text={task.description} />
        </Section>
      )}

      {attempt && (attempt.command || attempt.error || typeof attempt.exitCode === "number") && (
        <Section title="Attempt">
          {attempt.command && <AttemptCommand command={attempt.command} />}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            {typeof attempt.exitCode === "number" && (
              <KeyVal label="exit code" value={String(attempt.exitCode)} tone={attempt.exitCode === 0 ? "var(--ok)" : "var(--danger)"} />
            )}
            {attempt.startedAt && <KeyVal label="started" value={formatClock(attempt.startedAt)} />}
            {attempt.finishedAt && <KeyVal label="finished" value={formatClock(attempt.finishedAt)} />}
          </div>
          {attempt.error && (
            <div
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid color-mix(in oklch, var(--danger) 45%, transparent)",
                background: "var(--danger-soft)",
                color: "var(--danger)",
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                lineHeight: 1.5,
                wordBreak: "break-word",
              }}
            >
              {attempt.error}
            </div>
          )}
        </Section>
      )}

      {attempt?.promptPath && (
        <Section title="Prompt">
          <PromptBlock
            key={`${task.runId}:${attempt.id}`}
            runId={task.runId}
            attemptId={attempt.id}
          />
        </Section>
      )}
    </>
  );
}

function PendingReport({ attempt }: { attempt: WorkerAttempt | null }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 11px",
        border: "1px solid color-mix(in oklch, var(--accent) 22%, var(--rule-soft))",
        borderRadius: 8,
        background: "color-mix(in oklch, var(--accent) 5%, transparent)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: "var(--accent)",
          flex: "0 0 7px",
        }}
      />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ color: "var(--ink)", fontSize: 11.5, fontWeight: 650 }}>
          Work is still in progress
        </span>
        <span style={{ color: "var(--muted)", fontSize: 10.5, lineHeight: 1.45 }}>
          The structured report and evidence will appear here when the worker finishes
          {attempt?.startedAt ? "." : " and starts its attempt."}
        </span>
      </div>
    </div>
  );
}

function TaskBrief({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const normalized = text.trim();
  const needsCollapse = normalized.length > 640 || normalized.split("\n").length > 7;
  const preview = needsCollapse
    ? `${normalized.slice(0, 620).replace(/\s+$/u, "")}…`
    : normalized;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          color: "var(--ink-dim)",
          fontSize: 11.5,
          lineHeight: 1.58,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: !expanded && needsCollapse ? 166 : undefined,
          overflow: "hidden",
          maskImage: !expanded && needsCollapse
            ? "linear-gradient(to bottom, black 72%, transparent 100%)"
            : undefined,
        }}
      >
        {expanded ? normalized : preview}
      </div>
      {needsCollapse && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          style={{
            appearance: "none",
            alignSelf: "flex-start",
            border: 0,
            background: "transparent",
            color: "var(--accent-text)",
            padding: 0,
            fontFamily: "var(--font-sans)",
            fontSize: 10.5,
            fontWeight: 650,
            cursor: "default",
          }}
        >
          {expanded ? "Show less" : "Show full brief"}
        </button>
      )}
    </div>
  );
}

function AttemptCommand({ command }: { command: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          appearance: "none",
          alignSelf: "flex-start",
          border: "1px solid var(--rule-soft)",
          borderRadius: 6,
          background: "transparent",
          color: "var(--ink-dim)",
          padding: "5px 9px",
          fontFamily: "var(--font-sans)",
          fontSize: 10.5,
          fontWeight: 600,
          cursor: "default",
        }}
      >
        {open ? "Hide launch command" : "Show launch command"}
      </button>
      {open && (
        <code
          style={{
            display: "block",
            padding: "8px 10px",
            background: "color-mix(in oklab, var(--bg) 70%, transparent)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 6,
            color: "var(--ink-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            lineHeight: 1.5,
            wordBreak: "break-word",
          }}
        >
          {command}
        </code>
      )}
    </div>
  );
}

function KeyVal({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
      <span style={{ color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ color: tone ?? "var(--ink-dim)", fontFamily: "var(--font-mono)", fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </span>
    </span>
  );
}

function PathList({ label, tone, paths }: { label: string; tone: string; paths: string[] }) {
  const shown = paths.slice(0, 8);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ color: tone, fontFamily: "var(--font-sans)", fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
        {label}
      </span>
      {shown.map((path, i) => (
        <span key={i} style={{ color: "var(--ink-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5, wordBreak: "break-word" }}>
          {path}
        </span>
      ))}
      {paths.length > shown.length && (
        <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          +{paths.length - shown.length} more
        </span>
      )}
    </div>
  );
}

// ── Worker report ────────────────────────────────────────────────────────────

function ReportView({ report, compact }: { report: WorkerReport; compact?: boolean }) {
  const tone =
    report.status === "complete"
      ? "var(--ok)"
      : report.status === "partial"
        ? "var(--warn)"
        : "var(--danger)";
  const fileCap = compact ? 5 : 16;
  const lineCap = compact ? 3 : 10;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            color: tone,
            background: `color-mix(in oklch, ${tone} 12%, transparent)`,
            border: `1px solid color-mix(in oklch, ${tone} 45%, var(--rule))`,
            borderRadius: 4,
            padding: "1px 6px",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
        >
          {sentenceCase(report.status)}
        </span>
        {report.verifier && <VerdictPill confidence={report.verifier.confidence} />}
      </div>
      {report.summary && (
        <p style={{ margin: 0, color: "var(--ink)", fontFamily: "var(--font-sans)", fontSize: 11.5, lineHeight: 1.55 }}>
          {report.summary}
        </p>
      )}
      {report.filesChanged.length > 0 && (
        <ReportGroup label={`Files changed · ${report.filesChanged.length}`}>
          {report.filesChanged.slice(0, fileCap).map((file, i) => (
            <div key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.5, wordBreak: "break-word" }}>
              <span style={{ color: "var(--accent-text)" }}>{file.path}</span>
              {file.reason && <span style={{ color: "var(--muted)" }}> — {file.reason}</span>}
            </div>
          ))}
          {report.filesChanged.length > fileCap && (
            <span style={{ color: "var(--muted)", fontSize: 10 }}>+{report.filesChanged.length - fileCap} more</span>
          )}
        </ReportGroup>
      )}
      {!compact && report.tests.length > 0 && (
        <ReportGroup label="Tests">
          {report.tests.map((test, i) => (
            <div key={i} style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
              <span
                style={{
                  color:
                    test.result === "passed" ? "var(--ok)" : test.result === "failed" ? "var(--danger)" : "var(--muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 10,
                  fontWeight: 600,
                  flex: "0 0 auto",
                }}
              >
                {sentenceCase(test.result)}
              </span>
              <span style={{ color: "var(--ink-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5, wordBreak: "break-word" }}>
                {test.command}
              </span>
            </div>
          ))}
        </ReportGroup>
      )}
      {!compact && report.commandsRun.length > 0 && (
        <ReportGroup label="Commands">
          {report.commandsRun.map((command, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <code
                style={{
                  color: "var(--ink-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  lineHeight: 1.45,
                  wordBreak: "break-word",
                }}
              >
                {command.command}
              </code>
              {command.summary && (
                <span style={{ color: "var(--muted)", fontSize: 10.5, lineHeight: 1.45 }}>
                  {command.summary}
                </span>
              )}
            </div>
          ))}
        </ReportGroup>
      )}
      {report.proof.length > 0 && (
        <ReportGroup label="Proof">
          {report.proof.slice(0, lineCap).map((line, i) => (
            <ListItem key={i}>{line}</ListItem>
          ))}
        </ReportGroup>
      )}
      {(report.risks.length > 0 || report.followups.length > 0) && (
        <ReportGroup label="Risks & follow-ups">
          {report.risks.slice(0, lineCap).map((line, i) => (
            <ListItem key={`r${i}`} tone="var(--warn)">
              {line}
            </ListItem>
          ))}
          {report.followups.slice(0, lineCap).map((line, i) => (
            <ListItem key={`f${i}`}>{line}</ListItem>
          ))}
        </ReportGroup>
      )}
    </div>
  );
}

// The verifier's 5-rung confidence ladder, shown as a pill beside the worker's
// status badge. PERFECT/VERIFIED read green, PARTIAL/FEEDBACK amber, FAILED red —
// the same tone treatment the step card's verdict pill uses, so a verified worker
// looks the same here in the inspector as it does on the graph node.
function verdictTone(confidence: VerifierVerdict["confidence"]): string {
  switch (confidence) {
    case "PERFECT":
    case "VERIFIED":
      return "var(--ok)";
    case "PARTIAL":
    case "FEEDBACK":
      return "var(--warn)";
    case "FAILED":
      return "var(--danger)";
  }
}

function VerdictPill({ confidence }: { confidence: VerifierVerdict["confidence"] }) {
  const tone = verdictTone(confidence);
  return (
    <span
      title={`Verifier verdict: ${confidence}`}
      style={{
        color: tone,
        background: `color-mix(in oklch, ${tone} 12%, transparent)`,
        border: `1px solid color-mix(in oklch, ${tone} 45%, var(--rule))`,
        borderRadius: 4,
        padding: "1px 6px",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.02em",
      }}
    >
      Verifier · {sentenceCase(confidence)}
    </span>
  );
}

function ReportGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {[88, 66, 74].map((w, i) => (
        <span
          key={i}
          style={{
            display: "block",
            width: `${w}%`,
            height: 9,
            borderRadius: 999,
            background:
              "linear-gradient(90deg, color-mix(in oklab, var(--ink) 5%, transparent), color-mix(in oklab, var(--ink) 12%, transparent), color-mix(in oklab, var(--ink) 5%, transparent))",
            backgroundSize: "220% 100%",
            animation: "spark-shimmer 2.1s ease-in-out infinite",
          }}
        />
      ))}
    </div>
  );
}

// ── Prompt block ─────────────────────────────────────────────────────────────

function PromptBlock({ runId, attemptId }: { runId: string; attemptId: string }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || content !== null || loading) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.spark.orchestration
      .readWorkerPrompt(runId, attemptId)
      .then((prompt) => {
        if (!cancelled) setContent(prompt);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, runId, attemptId, content, loading]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          appearance: "none",
          alignSelf: "flex-start",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          border: "1px solid var(--rule-soft)",
          borderRadius: 6,
          background: "transparent",
          color: "var(--ink-dim)",
          padding: "5px 9px",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 600,
          cursor: "default",
          transition: "background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--hover)";
          e.currentTarget.style.borderColor = "var(--rule)";
          e.currentTarget.style.color = "var(--ink)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.borderColor = "var(--rule-soft)";
          e.currentTarget.style.color = "var(--ink-dim)";
        }}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden
          style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform var(--motion-fast) var(--ease-out)" }}
        >
          <path d="M3 1.5 L7 5 L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {open ? "Hide prompt" : "Show prompt sent to worker"}
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: "11px 12px",
            background: "color-mix(in oklab, var(--bg) 72%, transparent)",
            border: "1px solid var(--rule-soft)",
            borderRadius: 7,
            color: "var(--ink-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {loading ? "Loading prompt…" : error ? `Failed to read prompt: ${error}` : content ?? ""}
        </pre>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

type FriendlyWorkerStatus = "queued" | "running" | "done" | "blocked";

function friendlyRunLine(run: RunState, liveStep: StepState | undefined, attentionCount: number): string {
  if (attentionCount > 0) {
    return attentionCount === 1
      ? "One item needs attention before the run can continue."
      : `${attentionCount} items need attention before the run can continue.`;
  }
  if (liveStep) {
    return `Working on ${liveStep.title}.`;
  }
  if (run.status === "complete") return "Everything finished. The reports below show what changed.";
  if (run.status === "planning") return "Cora is planning the next useful step.";
  if (run.status === "paused") return run.autopilot?.stopReason || "Paused until you resume it.";
  if (run.status === "cancelled") return "This run was cancelled.";
  if (run.status === "failed" || run.status === "blocked") return "The run stopped before completion.";
  return "No active step right now.";
}

function friendlyStepLine(step: StepState, totalWorkers: number, doneWorkers: number): string {
  if (step.status === "complete" || step.status === "skipped") {
    return totalWorkers > 0
      ? `Finished with ${doneWorkers} of ${totalWorkers} workers accepted.`
      : "Finished without worker tasks.";
  }
  if (step.status === "running" || step.status === "reviewing") {
    return totalWorkers > 0
      ? `${doneWorkers} of ${totalWorkers} workers are done; the rest are still moving.`
      : "Cora is preparing workers for this step.";
  }
  if (step.status === "blocked" || step.status === "failed") return "This step needs attention before the run continues.";
  if (step.status === "planning") return "Cora is shaping the worker tasks for this step.";
  return totalWorkers > 0 ? "Ready for workers to run." : "No workers have been queued yet.";
}

function friendlyWorkerLine(
  task: WorkerTask,
  attempt: WorkerAttempt | null,
  status: FriendlyWorkerStatus,
  report?: WorkerReport,
): string {
  if (status === "running") {
    // The live activity readout (what tool the worker is on right now) beats
    // the generic sentence whenever a writer has reported one.
    return (
      attempt?.runtimeActivity?.trim() ||
      "Currently running. The final report will appear when it finishes."
    );
  }
  if (status === "blocked") return attempt?.error || "This worker hit a problem and may need a retry or review.";
  if (status === "done") {
    if (report?.summary) return report.summary;
    return "Finished. Review the report and proof below for details.";
  }
  if (task.status === "retry_queued") return "Queued for another attempt.";
  return "Queued and waiting for Cora to launch it.";
}

// Plain unpadded index — "Step 1", queue count "2". Zero-padding read as
// cockpit decoration.
function pad(value: number): string {
  return String(Math.max(0, value));
}

function stepMark(status: StepState["status"]): "done" | "failed" | "running" | "pending" {
  if (status === "complete" || status === "skipped") return "done";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "running" || status === "reviewing") return "running";
  return "pending";
}

function workerShortLabel(
  task: WorkerTask,
  step: StepState | null,
  stepIndex: Map<string, number>,
): string {
  const stepNo = step ? stepIndex.get(step.id) ?? 0 : 0;
  // Worker tasks within a step are not numbered on the record, so derive a
  // "<step>.<n>" handle from the task's slot in its step.
  if (step) {
    const slot = step.workerTaskIds.indexOf(task.id);
    if (slot >= 0) return `worker ${stepNo}.${slot + 1}`;
  }
  return task.title;
}

interface AttentionItem {
  title: string;
  detail?: string;
  tone: string;
  mark: "done" | "failed" | "running" | "pending";
  onClick?: () => void;
}

function collectAttention(
  run: RunState,
  steps: StepState[],
  onSelectStep?: (id: string) => void,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (run.status === "paused") {
    items.push({
      title: "Run paused",
      detail: run.autopilot?.stopReason || "Resume it from the Cora tab.",
      tone: "var(--info)",
      mark: "pending",
    });
  }
  steps.forEach((step, i) => {
    if (step.status === "blocked" || step.status === "failed") {
      items.push({
        title: `Step ${pad(i + 1)} ${step.status}`,
        detail: step.title,
        tone: "var(--danger)",
        mark: "failed",
        onClick: onSelectStep ? () => onSelectStep(step.id) : undefined,
      });
    }
  });
  for (const task of run.workerTasks) {
    if (task.status === "blocked" || task.status === "failed") {
      items.push({
        title: `Worker ${task.status}`,
        detail: task.title,
        tone: "var(--danger)",
        mark: "failed",
      });
    }
  }
  const lastMessage = run.humanMessages[run.humanMessages.length - 1];
  if (lastMessage && lastMessage.author === "spark" && lastMessage.kind === "question") {
    items.push({
      title: "Cora asked a question",
      detail: lastMessage.message,
      tone: "var(--accent)",
      mark: "running",
    });
  }
  return items.slice(0, 6);
}

interface ActivityItem {
  when: string;
  label: string;
  state: string;
  tone: string;
}

interface ContextSnapshot {
  used: number;
  total: number;
  percent: number;
  model: string;
  mode: SparkCall["mode"];
  estimated: boolean;
  tone: string;
}

function latestContextSnapshot(run: RunState): ContextSnapshot | null {
  const call = [...run.sparkCalls]
    .reverse()
    .find((item) => item.promptTokens || item.promptTokenEstimate || item.status === "started");
  if (!call) return null;
  const fallback = contextWindowForModel(call.model);
  const total = call.contextWindowTokens ?? fallback.tokens;
  const used = call.promptTokens ?? call.promptTokenEstimate ?? 0;
  if (!total || used <= 0) return null;
  const percent = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
  const tone =
    percent >= 85
      ? "var(--danger)"
      : percent >= 65
        ? "var(--warn)"
        : percent >= 35
          ? "var(--accent)"
          : "var(--ok)";
  return {
    used,
    total,
    percent,
    model: call.model || "manager",
    mode: call.mode,
    estimated: !call.promptTokens || !call.contextWindowTokens || call.contextWindowSource === "default",
    tone,
  };
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${trimNumber(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimNumber(value / 1_000)}k`;
  return String(value);
}

function trimNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function recentActivity(run: RunState): ActivityItem[] {
  // One merged timeline of worker attempts + manager calls. The array is typed
  // up front so each status enum widens cleanly to ActivityItem's string field.
  const items: Array<ActivityItem & { sort: number }> = [];
  for (const attempt of run.workerAttempts) {
    const stamp = attempt.finishedAt ?? attempt.startedAt;
    if (!stamp) continue;
    items.push({
      when: formatClock(stamp),
      label: `${attempt.runtime} · attempt ${attempt.attemptNumber}`,
      state: attempt.status,
      tone: attemptStatusColor(attempt.status),
      sort: new Date(stamp).getTime(),
    });
  }
  for (const call of run.sparkCalls) {
    const stamp = call.completedAt ?? call.createdAt;
    items.push({
      when: formatClock(stamp),
      label: `Cora · ${call.mode.replace(/_/g, " ")}`,
      state: call.status,
      tone:
        call.status === "failed"
          ? "var(--danger)"
          : call.status === "completed"
            ? "var(--ok)"
            : "var(--accent)",
      sort: new Date(stamp).getTime(),
    });
  }
  return items
    .sort((a, b) => b.sort - a.sort)
    .slice(0, 8)
    .map(({ sort, ...item }) => item);
}

function pickLatestReport(
  tasks: WorkerTask[],
  attemptByTask: Map<string, WorkerAttempt>,
  reportByAttempt: ReadonlyMap<string, WorkerReport>,
): WorkerReport | null {
  let latest: { report: WorkerReport; at: number } | null = null;
  for (const task of tasks) {
    const attempt = attemptByTask.get(task.id);
    if (!attempt) continue;
    const report = reportByAttempt.get(attempt.id);
    if (!report) continue;
    const at = new Date(attempt.finishedAt ?? attempt.startedAt ?? 0).getTime();
    if (!latest || at >= latest.at) latest = { report, at };
  }
  return latest?.report ?? null;
}

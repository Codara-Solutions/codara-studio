/**
 * Shared, non-visual helpers for the run canvas (the runs/ node-graph view).
 *
 * Everything here is pure data shaping — status -> tone mapping, the
 * planned-agent / task / attempt row model the graph and inspector both walk,
 * the wall-clock formatters, and the two hooks that keep the canvas live
 * (a 1Hz tick and the lazy worker-report loader). RunsView's old in-file
 * helpers are consolidated here so the graph nodes, the wires and the
 * inspector all paint from one source of truth.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PlannedStepAgent,
  RunState,
  StepState,
  WorkerAttempt,
  WorkerReport,
  WorkerRuntime,
  WorkerTask,
} from "@shared/types";
import { isRunningStatus as isRunningRunStatus, runStatusColor } from "../../lib/run-status";

// ── Status model ────────────────────────────────────────────────────────────

// The four-state status the graph collapses a worker (task + attempt) into.
export type AgentStatusKind = "queued" | "running" | "done" | "blocked";

// statusColor / isLiveStatus are polymorphic over the three status flavours
// the canvas paints: run statuses, step statuses, and AgentStatusKind.
export type AnyStatus = RunState["status"] | StepState["status"] | AgentStatusKind;

export interface AgentRow {
  agent: PlannedStepAgent;
  task?: WorkerTask;
  attempt?: WorkerAttempt;
}

export interface RunMaps {
  taskById: Map<string, WorkerTask>;
  attemptByTask: Map<string, WorkerAttempt>;
}

export interface RuntimeTone {
  label: string;
  border: string;
  bg: string;
}

// The run-status subset is delegated to the shared runStatusColor so the
// `paused` -> info mapping stays in sync everywhere; the step/agent-only
// members narrow out first, leaving a clean RunStatus for the delegate.
export function statusColor(status: AnyStatus): string {
  if (status === "done") return "var(--ok)";
  // A force-landed-without-verification step reads as caution, not a clean
  // complete — it is terminal but flagged, so it must stay visually distinct.
  if (status === "completed_unverified") return "var(--warn)";
  if (status === "queued" || status === "ready" || status === "skipped") return "var(--muted)";
  return runStatusColor(status);
}

export function stepStatusColor(status: StepState["status"]): string {
  return statusColor(status);
}

export function attemptStatusColor(status: WorkerAttempt["status"]): string {
  if (["running", "launching", "preparing", "prompt_ready", "finishing"].includes(status)) {
    return "var(--accent)";
  }
  if (status === "succeeded") return "var(--ok)";
  if (status === "failed" || status === "timed_out" || status === "cancelled") return "var(--danger)";
  return "var(--muted)";
}

// True while a status is genuinely in motion. step/agent-only members can
// never be live, so they short-circuit before the RunStatus delegate.
export function isLiveStatus(status: AnyStatus): boolean {
  if (
    status === "done" ||
    status === "queued" ||
    status === "ready" ||
    status === "skipped" ||
    status === "completed_unverified"
  ) {
    return false;
  }
  return isRunningRunStatus(status);
}

// Compact, glanceable label for a step's status. reviewing folds into
// "running" because the operator reads them as the same "in flight" beat.
export function stepStatusLabel(status: StepState["status"]): string {
  switch (status) {
    case "running":
    case "reviewing":
      return "running";
    case "ready":
      return "ready";
    case "complete":
      return "complete";
    case "completed_unverified":
      return "unverified";
    case "blocked":
    case "failed":
      return status;
    case "planning":
      return "planning";
    case "skipped":
      return "skipped";
    default:
      return "queued";
  }
}

// Sentence-case a status word for display: "running" -> "Running",
// "retry_queued" -> "Retry queued". Status words render in quiet sentence-case
// chips rather than ALL-CAPS mono.
export function sentenceCase(value: string): string {
  const text = value.replace(/[_-]+/g, " ").trim();
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

// A step is "attention" when it has stalled in a state only the operator can
// clear. Drives the loud danger treatment on the node and the inspector list.
export function stepNeedsAttention(status: StepState["status"]): boolean {
  // completed_unverified is terminal but flagged — it landed without a
  // cross-provider verifier verdict, so the operator should still see it.
  return status === "blocked" || status === "failed" || status === "completed_unverified";
}

// Per-runtime accent — the app-wide engine identity tokens (claude wears
// coral, codex cyan; see the "Loom silhouettes" section in styles.css), so a
// worker's runtime reads the same on the run graph, the loom editor, and the
// LiveBoard. shell is ok-green; manual stays neutral.
export function runtimeTone(runtime: WorkerRuntime): RuntimeTone {
  switch (runtime) {
    case "claude":
      return {
        label: "var(--engine-claude)",
        border: "color-mix(in oklch, var(--engine-claude) 52%, transparent)",
        bg: "color-mix(in oklch, var(--engine-claude) 10%, transparent)",
      };
    case "codex":
      return {
        label: "var(--engine-codex)",
        border: "color-mix(in oklch, var(--engine-codex) 52%, transparent)",
        bg: "color-mix(in oklch, var(--engine-codex) 10%, transparent)",
      };
    case "shell":
      return {
        label: "var(--ok)",
        border: "color-mix(in oklch, var(--ok) 46%, transparent)",
        bg: "color-mix(in oklch, var(--ok) 9%, transparent)",
      };
    default:
      return {
        label: "var(--ink-dim)",
        border: "var(--rule-strong)",
        bg: "color-mix(in oklab, var(--ink) 5%, transparent)",
      };
  }
}

// ── Run -> graph data shaping ────────────────────────────────────────────────

export function buildRunMaps(run: RunState): RunMaps {
  const taskById = new Map<string, WorkerTask>();
  for (const task of run.workerTasks) taskById.set(task.id, task);
  const attemptByTask = new Map<string, WorkerAttempt>();
  for (const attempt of run.workerAttempts) {
    const prev = attemptByTask.get(attempt.workerTaskId);
    if (!prev || attempt.attemptNumber >= prev.attemptNumber) {
      attemptByTask.set(attempt.workerTaskId, attempt);
    }
  }
  return { taskById, attemptByTask };
}

export function sortSteps(steps: StepState[]): StepState[] {
  return [...steps].sort((a, b) => {
    const indexDelta = a.index - b.index;
    if (indexDelta !== 0) return indexDelta;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

// Normalise a planned-agent label to a stable "worker <step>.<n>" form so the
// graph reads as a numbered tree even when the manager left labels blank.
export function displayAgentLabel(
  label: string | undefined,
  stepIndex: number,
  agentIndex: number,
): string {
  const trimmed = label?.trim() ?? "";
  const workerStepLabel = trimmed.match(/^worker\s+\d+\.(\d+)$/i);
  if (workerStepLabel) return `worker ${stepIndex}.${workerStepLabel[1]}`;
  if (/^worker\s+\d+$/i.test(trimmed)) return `worker ${stepIndex}.${agentIndex}`;
  return trimmed || `worker ${stepIndex}.${agentIndex}`;
}

// One row per worker the step will run: a planned agent paired with its task
// and latest attempt. Tasks queued after planning (a verifier follow-up, say)
// outnumber the planned agents and get their own rows so the graph reflects
// every worker the manager actually spawned.
export function agentRowsForStep(
  step: StepState,
  taskById: Map<string, WorkerTask>,
  attemptByTask: Map<string, WorkerAttempt>,
  displayIndex: number,
): AgentRow[] {
  const tasks = step.workerTaskIds
    .map((id) => taskById.get(id))
    .filter((task): task is WorkerTask => Boolean(task));
  const planned = step.plannedAgents ?? [];

  if (planned.length > 0) {
    const rows: AgentRow[] = planned.map((agent, index) => {
      const task = tasks[index];
      return {
        agent: { ...agent, label: displayAgentLabel(agent.label, displayIndex, index + 1) },
        task,
        attempt: task ? attemptByTask.get(task.id) : undefined,
      };
    });
    for (let index = planned.length; index < tasks.length; index++) {
      const task = tasks[index];
      rows.push({
        agent: {
          label: displayAgentLabel(undefined, displayIndex, index + 1),
          summary: task.description,
          runtimePreference: task.runtimePreference,
          modelHint: task.modelHint,
          effortHint: task.effortHint,
        },
        task,
        attempt: attemptByTask.get(task.id),
      });
    }
    return rows;
  }

  return tasks.map((task, index) => ({
    agent: {
      label: displayAgentLabel(task.title, displayIndex, index + 1),
      summary: task.description,
      runtimePreference: task.runtimePreference,
      modelHint: task.modelHint,
      effortHint: task.effortHint,
    },
    task,
    attempt: attemptByTask.get(task.id),
  }));
}

// Collapse a worker's task + attempt + parent-step state into one of the four
// AgentStatusKind buckets the node and inspector paint from.
export function deriveAgentStatus(
  task: WorkerTask | undefined,
  attempt: WorkerAttempt | undefined,
  stepStatus: StepState["status"],
): AgentStatusKind {
  if (
    attempt?.status === "running" ||
    attempt?.status === "launching" ||
    attempt?.status === "preparing" ||
    attempt?.status === "prompt_ready" ||
    attempt?.status === "finishing"
  ) {
    return "running";
  }
  if (task?.status === "running" || task?.status === "claimed") return "running";
  if (task?.status === "accepted" || task?.status === "needs_review" || attempt?.status === "succeeded") {
    return "done";
  }
  if (
    task?.status === "blocked" ||
    task?.status === "failed" ||
    task?.status === "cancelled" ||
    attempt?.status === "failed" ||
    attempt?.status === "timed_out" ||
    attempt?.status === "cancelled"
  ) {
    return "blocked";
  }
  if (stepStatus === "complete") return "done";
  if (stepStatus === "blocked" || stepStatus === "failed") return "blocked";
  return "queued";
}

// A worker task that has reached a terminal "did its job" state.
export function isCompletedTask(task: WorkerTask): boolean {
  return task.status === "accepted" || task.status === "needs_review";
}

// The step Codara is currently rendering worker prompts for. The connector
// glow rides the wire INTO this step — worker execution itself lights the
// step node, not the wire feeding the next queued step.
export function promptGenerationTargetStepId(run: RunState): string | undefined {
  const activePromptCall = run.sparkCalls
    .slice()
    .reverse()
    .find(
      (call) =>
        call.status === "started" &&
        (call.mode === "step_planning" || call.mode === "worker_prompt_generation"),
    );
  if (!activePromptCall) return undefined;

  return sortSteps(run.steps).find((step) => {
    if (["complete", "failed", "skipped"].includes(step.status)) return false;
    if ((step.kind ?? "worker_batch") !== "worker_batch") return false;
    if ((step.plannedAgents?.length ?? 0) === 0) return false;
    return !run.workerTasks.some((task) => task.stepId === step.id && task.status !== "cancelled");
  })?.id;
}

// Distinct files a step has touched, unioned across its workers' latest
// reports. Drives the "code impact" count on the step node.
export function stepFileCount(
  step: StepState,
  attemptByTask: Map<string, WorkerAttempt>,
  reportByAttempt: ReadonlyMap<string, WorkerReport>,
): number {
  const files = new Set<string>();
  for (const taskId of step.workerTaskIds) {
    const attempt = attemptByTask.get(taskId);
    if (!attempt) continue;
    const report = reportByAttempt.get(attempt.id);
    if (!report) continue;
    for (const file of report.filesChanged) files.add(file.path);
  }
  return files.size;
}

// ── Time formatting ──────────────────────────────────────────────────────────

export function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatClock(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// Compact Vercel-build-style duration: "32s", "4m 32s", "1h 04m". Consumers
// keep tabular-nums so the digits stay column-stable while ticking.
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatSince(value: string): string {
  const start = new Date(value).getTime();
  if (Number.isNaN(start)) return "—";
  return formatDurationMs(Math.max(0, Date.now() - start));
}

export function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  return formatDurationMs(Math.max(0, end - start));
}

// ── Live hooks ───────────────────────────────────────────────────────────────

// Forces a re-render every `intervalMs` while `enabled` — keeps elapsed-time
// labels advancing on the wall clock without piping a "now" prop everywhere.
export function useNowTick(intervalMs: number, enabled: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = window.setInterval(() => setTick((n) => (n + 1) | 0), intervalMs);
    return () => window.clearInterval(id);
  }, [enabled, intervalMs]);
}

// True while the run still has a moving piece — an open attempt, a live step,
// or autopilot work in flight. Canvas timers gate their tick on this so a
// finished run does not burn a re-render every second forever.
export function isRunStillTicking(run: RunState): boolean {
  if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
    return false;
  }
  if (run.sparkCalls.some((call) => call.status === "started")) {
    return true;
  }
  if (
    run.workerAttempts.some(
      (attempt) =>
        attempt.status === "preparing" ||
        attempt.status === "prompt_ready" ||
        attempt.status === "launching" ||
        attempt.status === "running" ||
        attempt.status === "finishing",
    )
  ) {
    return true;
  }
  return run.workerTasks.some(
    (task) =>
      task.status === "created" ||
      task.status === "queued" ||
      task.status === "claimed" ||
      task.status === "running" ||
      task.status === "needs_review" ||
      task.status === "retry_queued",
  );
}

// Lazily loads every worker's structured final report from disk and caches it
// by path, so a report file is read exactly once across the whole canvas
// lifetime. Returns an attempt-id keyed map; both the step nodes (file-count
// rollup) and the inspector (full report) read from it without re-fetching.
export function useRunReports(run: RunState): ReadonlyMap<string, WorkerReport> {
  const cacheRef = useRef<Map<string, WorkerReport>>(new Map());
  const [, bump] = useState(0);

  const pathByAttempt = useMemo(() => {
    const map = new Map<string, string>();
    for (const attempt of run.workerAttempts) {
      if (attempt.finalReportPath) map.set(attempt.id, attempt.finalReportPath);
    }
    return map;
  }, [run.workerAttempts]);

  useEffect(() => {
    let cancelled = false;
    const wanted = [...new Set(pathByAttempt.values())];
    const missing = wanted.filter((path) => !cacheRef.current.has(path));
    if (missing.length === 0) return undefined;
    void Promise.all(
      missing.map((path) =>
        window.spark.orchestration
          .readWorkerReport(path)
          // readWorkerReport resolves to null when the file is missing or
          // unparseable; drop those so the cache only holds real reports.
          .then((report) => (report ? ([path, report] as const) : null))
          .catch(() => null),
      ),
    ).then((loaded) => {
      if (cancelled) return;
      let changed = false;
      for (const entry of loaded) {
        if (entry) {
          cacheRef.current.set(entry[0], entry[1]);
          changed = true;
        }
      }
      if (changed) bump((n) => (n + 1) | 0);
    });
    return () => {
      cancelled = true;
    };
  }, [pathByAttempt]);

  return useMemo(() => {
    const next = new Map<string, WorkerReport>();
    for (const [attemptId, path] of pathByAttempt) {
      const report = cacheRef.current.get(path);
      if (report) next.set(attemptId, report);
    }
    return next;
    // cacheRef.current.size advances when a freshly loaded report lands via
    // the bump() re-render, which is exactly when this map must be rebuilt.
  }, [pathByAttempt, cacheRef.current.size]);
}

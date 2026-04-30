import React, { useCallback, useEffect, useState } from "react";
import type {
  PlannedStepAgent,
  RunState,
  StepState,
  WorkerAttempt,
  WorkerTask,
  Workspace,
} from "@shared/types";

interface Props {
  workspace: Workspace | null;
}

export default function RunsView({ workspace }: Props) {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeRun, setActiveRun] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = workspace?.id ?? null;

  const loadActiveRun = useCallback(async (run: RunState | null) => {
    if (!run) {
      setActiveRun(null);
      return;
    }
    const fresh = await window.spark.orchestration.getRun(run.id);
    setActiveRun(fresh ?? run);
  }, []);

  const loadRuns = useCallback(async () => {
    if (!workspaceId) {
      setRuns([]);
      setActiveRun(null);
      return;
    }
    try {
      const next = await window.spark.orchestration.listRuns(workspaceId);
      setRuns(next);
      setActiveRun((current) => {
        const stillExists = current ? next.find((run) => run.id === current.id) : null;
        if (stillExists) return stillExists;
        const fallback = next[0] ?? null;
        if (fallback) void loadActiveRun(fallback);
        return fallback;
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspaceId, loadActiveRun]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    return window.spark.orchestration.onEvent((event) => {
      if (!activeRun || event.runId !== activeRun.id) return;
      void window.spark.orchestration.getRun(activeRun.id).then((fresh) => {
        if (fresh) {
          setActiveRun(fresh);
          setRuns((current) => current.map((r) => (r.id === fresh.id ? fresh : r)));
        }
      });
    });
  }, [activeRun]);

  if (!workspace) {
    return <EmptyState text="No active workspace." />;
  }
  if (error) {
    return <EmptyState text={`Error: ${error}`} tone="danger" />;
  }
  if (runs.length === 0) {
    return (
      <EmptyState text="No runs yet. Pick a plan in the right sidebar and press RUN to start one." />
    );
  }
  if (!activeRun) {
    return <EmptyState text="Select a run from the sidebar." />;
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "auto",
        padding: "12px 16px",
        background: "var(--panel)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <RunHeader run={activeRun} runCount={runs.length} />
      <StepsList run={activeRun} />
    </div>
  );
}

function RunHeader({ run, runCount }: { run: RunState; runCount: number }) {
  return (
    <header
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        paddingBottom: 8,
        borderBottom: "1px solid var(--rule)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span
          style={{
            color: "var(--ink)",
            fontSize: 16,
            fontWeight: 800,
            letterSpacing: "0.01em",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={run.title}
        >
          {run.title}
        </span>
        <span style={{ color: runStatusColor(run.status), fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {run.status}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--muted)", fontSize: 10 }}>
          {runCount} run{runCount === 1 ? "" : "s"}
        </span>
      </div>
      <div style={{ display: "flex", gap: 14, color: "var(--muted)", fontSize: 10 }}>
        <span>steps&nbsp;<b style={{ color: "var(--ink-dim)" }}>{run.steps.length}</b></span>
        <span>tasks&nbsp;<b style={{ color: "var(--ink-dim)" }}>{run.workerTasks.length}</b></span>
        <span>attempts&nbsp;<b style={{ color: "var(--ink-dim)" }}>{run.workerAttempts.length}</b></span>
      </div>
    </header>
  );
}

function StepsList({ run }: { run: RunState }) {
  const taskById = new Map<string, WorkerTask>();
  for (const t of run.workerTasks) taskById.set(t.id, t);
  const attemptByTask = new Map<string, WorkerAttempt>();
  for (const a of run.workerAttempts) {
    const prev = attemptByTask.get(a.workerTaskId);
    if (!prev || a.attemptNumber >= prev.attemptNumber) attemptByTask.set(a.workerTaskId, a);
  }

  if (run.steps.length === 0) {
    return <EmptyState text="Spark hasn't planned any steps yet." />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {run.steps.map((step) => (
        <StepCard
          key={step.id}
          step={step}
          taskById={taskById}
          attemptByTask={attemptByTask}
        />
      ))}
    </div>
  );
}

function StepCard({
  step,
  taskById,
  attemptByTask,
}: {
  step: StepState;
  taskById: Map<string, WorkerTask>;
  attemptByTask: Map<string, WorkerAttempt>;
}) {
  const tone = stepStatusColor(step.status);
  const tasks = step.workerTaskIds
    .map((id) => taskById.get(id))
    .filter((t): t is WorkerTask => Boolean(t));
  const planned = step.plannedAgents ?? [];
  const agentRows = planned.length > 0
    ? planned.map((agent, i) => ({ agent, task: tasks[i], attempt: tasks[i] ? attemptByTask.get(tasks[i].id) : undefined }))
    : tasks.map((task) => ({
        agent: {
          label: task.title,
          summary: "",
          runtimePreference: task.runtimePreference,
          modelHint: task.modelHint,
          effortHint: task.effortHint,
        } as PlannedStepAgent,
        task,
        attempt: attemptByTask.get(task.id),
      }));

  const isActive = step.status === "running" || step.status === "reviewing";

  return (
    <article
      style={{
        background: isActive ? "var(--panel-2)" : "var(--bg)",
        border: `1px solid ${isActive ? "var(--accent)" : "var(--rule)"}`,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          style={{
            color: "var(--muted)",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
            minWidth: 22,
          }}
        >
          STEP&nbsp;{step.index + 1}
        </span>
        <span
          style={{
            flex: 1,
            color: "var(--ink)",
            fontSize: 13,
            fontWeight: 700,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={step.title}
        >
          {step.title}
        </span>
        <span style={{ color: tone, fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {step.status}
        </span>
      </div>
      {step.goal && (
        <div style={{ color: "var(--ink-dim)", fontSize: 11, lineHeight: 1.45 }}>
          {step.goal}
        </div>
      )}
      {agentRows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel>Agents</SectionLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {agentRows.map((row, i) => (
              <AgentBadge key={i} agent={row.agent} task={row.task} attempt={row.attempt} stepStatus={step.status} />
            ))}
          </div>
        </div>
      )}
      {step.acceptanceCriteria.length > 0 && (
        <BulletSection label="Acceptance" items={step.acceptanceCriteria} />
      )}
      {step.verificationCommands.length > 0 && (
        <CommandSection label="Verification" items={step.verificationCommands} />
      )}
      {step.reviewSummary && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <SectionLabel>Review</SectionLabel>
          <div style={{ color: "var(--ink-dim)", fontSize: 11, lineHeight: 1.45 }}>
            {step.reviewSummary}
          </div>
        </div>
      )}
    </article>
  );
}

function AgentBadge({
  agent,
  task,
  attempt,
  stepStatus,
}: {
  agent: PlannedStepAgent;
  task?: WorkerTask;
  attempt?: WorkerAttempt;
  stepStatus: StepState["status"];
}) {
  const status = deriveAgentStatus(task, attempt, stepStatus);
  const tone = runtimeTone(agent.runtimePreference);
  const summary = task?.title || agent.summary || agent.label;
  const exit = attempt?.exitCode;

  return (
    <div
      title={summary}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 9px",
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        fontSize: 11,
        lineHeight: 1.2,
        color: "var(--ink-dim)",
        maxWidth: 360,
      }}
    >
      <Dot status={status} />
      <span
        style={{
          color: tone.label,
          fontWeight: 800,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {agent.runtimePreference}
      </span>
      {agent.modelHint && (
        <span style={{ color: "var(--muted)" }}>{agent.modelHint}</span>
      )}
      {agent.effortHint && (
        <span style={{ color: "var(--muted)", fontSize: 9 }}>· {agent.effortHint}</span>
      )}
      <span
        style={{
          color: "var(--ink-dim)",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {summary}
      </span>
      {exit !== undefined && exit !== 0 && (
        <span style={{ color: "var(--danger)", fontWeight: 700 }}>exit {exit}</span>
      )}
    </div>
  );
}

function BulletSection({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <SectionLabel>{label}</SectionLabel>
      <ul style={{ margin: 0, paddingLeft: 16, color: "var(--ink-dim)", fontSize: 11, lineHeight: 1.45 }}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function CommandSection({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <SectionLabel>{label}</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((cmd, i) => (
          <code
            key={i}
            style={{
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontSize: 10.5,
              color: "var(--ink-dim)",
              background: "var(--bg)",
              padding: "3px 7px",
              border: "1px solid var(--rule)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {cmd}
          </code>
        ))}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        color: "var(--muted)",
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

function Dot({ status }: { status: AgentStatusKind }) {
  const color =
    status === "running"
      ? "var(--accent)"
      : status === "done"
        ? "var(--ok)"
        : status === "blocked"
          ? "var(--danger)"
          : "var(--muted)";
  return (
    <span
      style={{
        width: 6,
        height: 6,
        background: color,
        flex: "0 0 auto",
        animation: status === "running" ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function EmptyState({ text, tone }: { text: string; tone?: "danger" }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: tone === "danger" ? "var(--danger)" : "var(--muted)",
        fontSize: 12,
        padding: 32,
      }}
    >
      {text}
    </div>
  );
}

type AgentStatusKind = "queued" | "running" | "done" | "blocked";

function deriveAgentStatus(
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
  if (task?.status === "running" || task?.status === "claimed" || task?.status === "needs_review") return "running";
  if (task?.status === "accepted" || attempt?.status === "succeeded") return "done";
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

function runtimeTone(runtime: PlannedStepAgent["runtimePreference"]): { label: string; border: string; bg: string } {
  switch (runtime) {
    case "claude":
      return { label: "var(--accent)", border: "var(--accent)", bg: "rgba(240, 196, 25, 0.06)" };
    case "codex":
      return { label: "var(--info)", border: "var(--info)", bg: "rgba(127, 179, 255, 0.06)" };
    case "shell":
      return { label: "var(--ok)", border: "var(--rule-strong)", bg: "transparent" };
    default:
      return { label: "var(--ink-dim)", border: "var(--rule-strong)", bg: "transparent" };
  }
}

function stepStatusColor(status: StepState["status"]): string {
  switch (status) {
    case "running":
    case "reviewing":
      return "var(--accent)";
    case "complete":
      return "var(--ok)";
    case "blocked":
    case "failed":
      return "var(--danger)";
    default:
      return "var(--muted)";
  }
}

function runStatusColor(status: RunState["status"]): string {
  switch (status) {
    case "running":
    case "reviewing":
    case "planning":
      return "var(--accent)";
    case "complete":
      return "var(--ok)";
    case "blocked":
    case "failed":
      return "var(--danger)";
    default:
      return "var(--muted)";
  }
}

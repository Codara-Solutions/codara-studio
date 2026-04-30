import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PlannedStepAgent,
  RunArtifactPaths,
  RunState,
  SparkEvent,
  StepState,
  WorkerAttempt,
  WorkerTask,
  Workspace,
} from "@shared/types";
import DevInspector from "./DevInspector";

interface Props {
  workspace: Workspace | null;
}

interface AgentRow {
  agent: PlannedStepAgent;
  task?: WorkerTask;
  attempt?: WorkerAttempt;
}

export default function RunsView({ workspace }: Props) {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [activeRun, setActiveRun] = useState<RunState | null>(null);
  const [events, setEvents] = useState<SparkEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [artifactPaths, setArtifactPaths] = useState<RunArtifactPaths | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = workspace?.id ?? null;
  const activeRunId = activeRun?.id ?? null;

  const loadRuns = useCallback(async (preferredRunId?: string) => {
    if (!workspaceId) {
      setRuns([]);
      setActiveRun(null);
      return;
    }

    try {
      const next = await window.spark.orchestration.listRuns(workspaceId);
      setRuns(next);
      setActiveRun((current) => {
        const preferred = preferredRunId
          ? next.find((run) => run.id === preferredRunId)
          : null;
        if (preferred) return preferred;
        const stillExists = current ? next.find((run) => run.id === current.id) : null;
        if (stillExists) return stillExists;
        return findBestRun(next);
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [workspaceId]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!activeRunId) {
      setEvents([]);
      setSelectedEventId(null);
      setArtifactPaths(null);
      return;
    }

    let cancelled = false;
    void Promise.all([
      window.spark.orchestration.getRun(activeRunId),
      window.spark.orchestration.listEvents(activeRunId),
      window.spark.orchestration.getArtifactPaths(activeRunId),
    ]).then(([fresh, nextEvents, paths]) => {
      if (cancelled) return;
      if (fresh) {
        setActiveRun(fresh);
        setRuns((current) => replaceRun(current, fresh));
      }
      setEvents(nextEvents);
      setArtifactPaths(paths);
      setSelectedEventId((current) => {
        if (current && nextEvents.some((event) => event.id === current)) return current;
        return nextEvents[nextEvents.length - 1]?.id ?? null;
      });
      setError(null);
    }).catch((err) => {
      if (!cancelled) setError((err as Error).message);
    });

    return () => {
      cancelled = true;
    };
  }, [activeRunId]);

  useEffect(() => {
    if (!workspaceId) return undefined;

    return window.spark.orchestration.onEvent((event) => {
      if (event.workspaceId !== workspaceId) return;
      if (!event.runId) {
        void loadRuns();
        return;
      }
      if (event.type === "run.deleted") {
        void loadRuns(event.runId);
        return;
      }

      void window.spark.orchestration.getRun(event.runId).then((fresh) => {
        if (!fresh || fresh.workspaceId !== workspaceId) return;
        setRuns((current) => replaceRun(current, fresh));
        setActiveRun((current) => {
          if (!current) return fresh;
          if (current.id === fresh.id) return fresh;
          if (isLiveRun(fresh) && !isLiveRun(current)) return fresh;
          return current;
        });
        if (event.runId === activeRunId) {
          setEvents((current) => {
            if (current.some((item) => item.id === event.id)) return current;
            return [...current, event];
          });
          setSelectedEventId((current) => current ?? event.id);
          void window.spark.orchestration.getArtifactPaths(event.runId).then(setArtifactPaths);
        }
        setError(null);
      }).catch((err) => setError((err as Error).message));
    });
  }, [activeRunId, loadRuns, workspaceId]);

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
    return <EmptyState text="Select a run." />;
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        display: "flex",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      <RunSidebar
        runs={runs}
        activeRunId={activeRun.id}
        onSelect={(run) => setActiveRun(run)}
      />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <RunHeader run={activeRun} />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            display: "grid",
            gridTemplateRows: "minmax(240px, 1fr) minmax(210px, 34%)",
          }}
        >
          <RunCanvas run={activeRun} />
          <DevInspector
            workspace={workspace}
            activeRun={activeRun}
            events={events}
            selectedEventId={selectedEventId}
            artifactPaths={artifactPaths}
            onSelectEvent={setSelectedEventId}
          />
        </div>
      </main>
    </div>
  );
}

function RunSidebar({
  runs,
  activeRunId,
  onSelect,
}: {
  runs: RunState[];
  activeRunId: string;
  onSelect: (run: RunState) => void;
}) {
  return (
    <aside
      style={{
        width: 230,
        flex: "0 0 230px",
        borderRight: "1px solid var(--rule)",
        background: "var(--panel)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          padding: "10px 12px",
          borderBottom: "1px solid var(--rule)",
          display: "flex",
          alignItems: "baseline",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.12em" }}>RUNS</span>
        <span style={{ color: "var(--muted)", fontSize: 10 }}>{runs.length}</span>
      </div>
      <div style={{ overflow: "auto", minHeight: 0 }}>
        {runs.map((run) => (
          <RunButton
            key={run.id}
            run={run}
            active={run.id === activeRunId}
            onClick={() => onSelect(run)}
          />
        ))}
      </div>
    </aside>
  );
}

function RunButton({
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
      title={run.title}
      style={{
        appearance: "none",
        width: "100%",
        border: "none",
        borderBottom: "1px solid var(--rule)",
        background: active ? "var(--panel-2)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "9px 12px",
        textAlign: "left",
        fontFamily: "inherit",
        cursor: "default",
        display: "flex",
        flexDirection: "column",
        gap: 5,
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          minWidth: 0,
        }}
      >
        <StatusDot status={run.status} />
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
      </span>
      <span style={{ color: "var(--muted)", fontSize: 9 }}>
        {run.status} · {run.steps.length} steps · {formatTime(run.updatedAt)}
      </span>
    </button>
  );
}

function RunHeader({ run }: { run: RunState }) {
  const activeStep = run.steps.find((step) => step.id === run.currentStepId)
    ?? run.steps.find((step) => step.status === "running" || step.status === "reviewing")
    ?? run.steps.find((step) => step.status !== "complete" && step.status !== "skipped");

  return (
    <header
      style={{
        flex: "0 0 auto",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule)",
        padding: "12px 16px 10px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 16,
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span
            title={run.title}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--ink)",
              fontSize: 15,
              fontWeight: 900,
            }}
          >
            {run.title}
          </span>
          <StatusPill status={run.status} />
        </div>
        <div
          title={activeStep?.goal}
          style={{
            color: "var(--ink-dim)",
            fontSize: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {activeStep ? `Current: ${activeStep.title}` : "Waiting for Spark to plan the first step"}
        </div>
      </div>
      <div style={{ display: "flex", gap: 16, color: "var(--muted)", fontSize: 10 }}>
        <Metric label="steps" value={run.steps.length} />
        <Metric label="tasks" value={run.workerTasks.length} />
        <Metric label="attempts" value={run.workerAttempts.length} />
        <Metric label="auto" value={run.autopilot?.status ?? "idle"} />
      </div>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end" }}>
      <span style={{ color: "var(--muted)", fontSize: 9, letterSpacing: "0.1em" }}>{label}</span>
      <b style={{ color: "var(--ink-dim)", fontSize: 11 }}>{value}</b>
    </span>
  );
}

function RunCanvas({ run }: { run: RunState }) {
  const [zoom, setZoom] = useState(0.72);
  const maps = useMemo(() => buildRunMaps(run), [run]);
  const orderedSteps = useMemo(() => sortSteps(run.steps), [run.steps]);
  const graphWidth = orderedSteps.length === 0
    ? 784
    : 110 + (orderedSteps.length * 320) + 208;
  const contentWidth = Math.max(920, graphWidth);
  const contentHeight = orderedSteps.length === 0 ? 460 : 560;
  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const setBoundedZoom = (next: number) => {
    setZoom(Math.min(1.4, Math.max(0.45, Number(next.toFixed(2)))));
  };

  return (
    <section
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        position: "relative",
        backgroundColor: "var(--bg)",
        backgroundImage:
          "radial-gradient(circle, color-mix(in oklch, var(--muted) 38%, transparent) 1px, transparent 1px)",
        backgroundSize: "22px 22px",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 12,
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          gap: 6,
          background: "var(--panel)",
          border: "1px solid var(--rule)",
          padding: 4,
          boxShadow: "0 10px 24px rgba(0,0,0,0.22)",
        }}
      >
        <ZoomButton label="-" title="Zoom out" onClick={() => setBoundedZoom(zoom - 0.1)} />
        <span style={{ width: 42, textAlign: "center", color: "var(--ink-dim)", fontSize: 10 }}>
          {zoomLabel}
        </span>
        <ZoomButton label="+" title="Zoom in" onClick={() => setBoundedZoom(zoom + 0.1)} />
        <ZoomButton label="1:1" title="Reset zoom" wide onClick={() => setBoundedZoom(1)} />
      </div>

      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "auto",
        }}
      >
        <div
          style={{
            width: Math.ceil(contentWidth * zoom) + 72,
            minHeight: Math.ceil(contentHeight * zoom) + 88,
            padding: "34px 36px",
          }}
        >
          <div
            style={{
              width: contentWidth,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
              display: "flex",
              flexDirection: "column",
              gap: 22,
            }}
          >
            {orderedSteps.length === 0 ? (
              <PlanningGraph run={run} />
            ) : (
              <StepsGraph
                run={run}
                steps={orderedSteps}
                taskById={maps.taskById}
                attemptByTask={maps.attemptByTask}
              />
            )}
            <RunDetails
              run={run}
              steps={orderedSteps}
              taskById={maps.taskById}
              attemptByTask={maps.attemptByTask}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function ZoomButton({
  label,
  title,
  wide,
  onClick,
}: {
  label: string;
  title: string;
  wide?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        appearance: "none",
        width: wide ? 34 : 24,
        height: 24,
        border: "1px solid var(--rule-strong)",
        background: "var(--bg)",
        color: "var(--ink-dim)",
        fontFamily: "inherit",
        fontSize: wide ? 9 : 13,
        fontWeight: 900,
        lineHeight: 1,
        padding: 0,
        cursor: "default",
      }}
    >
      {label}
    </button>
  );
}

function PlanningGraph({ run }: { run: RunState }) {
  return (
    <div
      style={{
        minHeight: 260,
        display: "grid",
        gridTemplateColumns: "110px 86px 260px 86px 240px",
        alignItems: "center",
      }}
    >
      <StartBlock label="RUN" subtitle={run.status} />
      <Connector label="created" />
      <ProcessCard
        title="Spark manager"
        eyebrow="planning"
        summary={run.autopilot?.lastAction ?? "Reading the selected plan and preparing worker steps."}
        status={run.status}
      />
      <Connector label="next" />
      <GhostCard title="Worker steps" subtitle="Appear here as soon as Spark plans them." />
    </div>
  );
}

function StepsGraph({
  run,
  steps,
  taskById,
  attemptByTask,
}: {
  run: RunState;
  steps: StepState[];
  taskById: Map<string, WorkerTask>;
  attemptByTask: Map<string, WorkerAttempt>;
}) {
  return (
    <div
      style={{
        minHeight: 280,
        display: "grid",
        gridTemplateColumns: `110px ${steps.map(() => "82px 238px").join(" ")} 82px 126px`,
        alignItems: "center",
      }}
    >
      <StartBlock label="SPARK" subtitle={run.status} />
      {steps.map((step, index) => (
        <React.Fragment key={step.id}>
          <Connector label={index === 0 ? "planned" : connectorLabel(steps[index - 1], step)} />
          <StepNode
            step={step}
            displayIndex={index + 1}
            taskById={taskById}
            attemptByTask={attemptByTask}
            active={step.id === run.currentStepId}
          />
        </React.Fragment>
      ))}
      <Connector label={run.status === "complete" ? "done" : "finish"} />
      <EndBlock status={run.status} />
    </div>
  );
}

function StartBlock({ label, subtitle }: { label: string; subtitle: string }) {
  return (
    <div
      style={{
        width: 82,
        minHeight: 66,
        background: "oklch(0.13 0 0)",
        border: "1px solid var(--rule-strong)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        color: "var(--ink)",
        boxShadow: "0 12px 30px rgba(0,0,0,0.22)",
      }}
    >
      <span style={{ width: 8, height: 8, background: "var(--accent)" }} />
      <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.08em" }}>{label}</span>
      <span style={{ color: "var(--muted)", fontSize: 9 }}>{subtitle}</span>
    </div>
  );
}

function EndBlock({ status }: { status: RunState["status"] }) {
  return (
    <div
      style={{
        minHeight: 54,
        border: "1px solid var(--rule)",
        background: "color-mix(in oklch, var(--panel) 86%, transparent)",
        color: status === "complete" ? "var(--ok)" : "var(--muted)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10,
        fontWeight: 900,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}
    >
      {status === "complete" ? "complete" : "pending"}
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div
      style={{
        position: "relative",
        minWidth: 82,
        height: 54,
        display: "flex",
        alignItems: "center",
      }}
    >
      <span
        style={{
          width: "100%",
          borderTop: "1px dashed var(--rule-strong)",
        }}
      />
      <span
        style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          color: "var(--muted)",
          fontSize: 9,
          whiteSpace: "nowrap",
          background: "var(--bg)",
          padding: "0 4px",
        }}
      >
        {label}
      </span>
    </div>
  );
}

function StepNode({
  step,
  displayIndex,
  taskById,
  attemptByTask,
  active,
}: {
  step: StepState;
  displayIndex: number;
  taskById: Map<string, WorkerTask>;
  attemptByTask: Map<string, WorkerAttempt>;
  active: boolean;
}) {
  const rows = agentRowsForStep(step, taskById, attemptByTask);
  const tone = stepStatusColor(step.status);
  const nodeActive = active || step.status === "running" || step.status === "reviewing";

  return (
    <article
      title={step.goal || step.title}
      style={{
        width: 238,
        minHeight: 146,
        background: nodeActive
          ? "color-mix(in oklch, var(--panel-2) 88%, var(--accent) 12%)"
          : "color-mix(in oklch, var(--panel) 92%, transparent)",
        border: `1px solid ${nodeActive ? "var(--accent)" : "var(--rule-strong)"}`,
        boxShadow: nodeActive
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 36%, transparent), 0 18px 40px rgba(0,0,0,0.28)"
          : "0 12px 34px rgba(0,0,0,0.22)",
        padding: "11px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "32px minmax(0, 1fr) auto", gap: 8 }}>
        <StepIcon step={step} />
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              color: "var(--ink)",
              fontSize: 12,
              fontWeight: 900,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.title}
          </div>
          <div
            style={{
              color: "var(--muted)",
              fontSize: 9,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            step {displayIndex}
          </div>
        </div>
        <StatusDot status={step.status} />
      </div>

      <div
        style={{
          color: "var(--ink-dim)",
          fontSize: 10,
          lineHeight: 1.35,
          minHeight: 28,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {step.goal || "Worker activity for this step."}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {rows.length === 0 ? (
          <Tag muted>waiting for agents</Tag>
        ) : (
          rows.slice(0, 4).map((row, index) => (
            <AgentTag key={index} row={row} stepStatus={step.status} />
          ))
        )}
        {rows.length > 4 && <Tag muted>+{rows.length - 4}</Tag>}
      </div>

      <div
        style={{
          marginTop: "auto",
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 8,
          color: "var(--muted)",
          fontSize: 9,
        }}
      >
        <span style={{ color: tone, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {step.status}
        </span>
        <span>{step.workerTaskIds.length} task{step.workerTaskIds.length === 1 ? "" : "s"}</span>
      </div>
    </article>
  );
}

function ProcessCard({
  title,
  eyebrow,
  summary,
  status,
}: {
  title: string;
  eyebrow: string;
  summary: string;
  status: RunState["status"];
}) {
  return (
    <article
      style={{
        width: 260,
        minHeight: 132,
        background: "color-mix(in oklch, var(--panel-2) 88%, var(--accent) 8%)",
        border: "1px solid var(--accent)",
        padding: "12px",
        boxShadow: "0 18px 40px rgba(0,0,0,0.28)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusDot status={status} />
        <span style={{ color: "var(--muted)", fontSize: 9, fontWeight: 900, letterSpacing: "0.12em" }}>
          {eyebrow}
        </span>
      </div>
      <div style={{ color: "var(--ink)", fontSize: 13, fontWeight: 900 }}>{title}</div>
      <div style={{ color: "var(--ink-dim)", fontSize: 10, lineHeight: 1.45 }}>{summary}</div>
    </article>
  );
}

function GhostCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      style={{
        width: 240,
        minHeight: 112,
        border: "1px dashed var(--rule-strong)",
        background: "color-mix(in oklch, var(--panel) 62%, transparent)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 7,
        padding: "14px",
      }}
    >
      <span style={{ color: "var(--ink-dim)", fontSize: 12, fontWeight: 900 }}>{title}</span>
      <span style={{ color: "var(--muted)", fontSize: 10, lineHeight: 1.4 }}>{subtitle}</span>
    </div>
  );
}

function StepIcon({ step }: { step: StepState }) {
  const letter = step.title.trim().charAt(0).toUpperCase() || String(step.index + 1);
  return (
    <span
      style={{
        width: 28,
        height: 28,
        border: `1px solid ${stepStatusColor(step.status)}`,
        background: "color-mix(in oklch, var(--panel-2) 78%, var(--accent) 10%)",
        color: stepStatusColor(step.status),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        fontWeight: 900,
      }}
    >
      {letter}
    </span>
  );
}

function AgentTag({ row, stepStatus }: { row: AgentRow; stepStatus: StepState["status"] }) {
  const status = deriveAgentStatus(row.task, row.attempt, stepStatus);
  const tone = runtimeTone(row.agent.runtimePreference);
  const label = row.agent.label || row.task?.title || row.agent.runtimePreference;
  return (
    <span
      title={row.task?.title || row.agent.summary || label}
      style={{
        maxWidth: "100%",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: "var(--ink-dim)",
        padding: "3px 6px",
        fontSize: 9,
        lineHeight: 1.2,
      }}
    >
      <StatusDot status={status} small />
      <b style={{ color: tone.label, textTransform: "uppercase" }}>{row.agent.runtimePreference}</b>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </span>
  );
}

function Tag({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      style={{
        border: "1px solid var(--rule)",
        background: "var(--bg)",
        color: muted ? "var(--muted)" : "var(--ink-dim)",
        padding: "3px 6px",
        fontSize: 9,
      }}
    >
      {children}
    </span>
  );
}

function RunDetails({
  run,
  steps,
  taskById,
  attemptByTask,
}: {
  run: RunState;
  steps: StepState[];
  taskById: Map<string, WorkerTask>;
  attemptByTask: Map<string, WorkerAttempt>;
}) {
  const activeStep = steps.find((step) => step.id === run.currentStepId)
    ?? steps.find((step) => step.status === "running" || step.status === "reviewing")
    ?? steps[0];
  const activeStepNumber = activeStep ? steps.indexOf(activeStep) + 1 : 0;
  const activeTasks = activeStep
    ? activeStep.workerTaskIds.map((id) => taskById.get(id)).filter((task): task is WorkerTask => Boolean(task))
    : [];
  const recentAttempts = run.workerAttempts.slice(-4).reverse();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(260px, 1.2fr) minmax(260px, 1fr)",
        gap: 14,
        maxWidth: 920,
      }}
    >
      <DetailPanel title={activeStep ? `STEP ${activeStepNumber}` : "RUN"}>
        {activeStep ? (
          <>
            <div style={{ color: "var(--ink)", fontSize: 12, fontWeight: 900 }}>{activeStep.title}</div>
            <div style={{ color: "var(--ink-dim)", fontSize: 10, lineHeight: 1.5 }}>
              {activeStep.goal || "No goal recorded for this step yet."}
            </div>
            {activeStep.acceptanceCriteria.length > 0 && (
              <CompactList label="acceptance" items={activeStep.acceptanceCriteria} />
            )}
            {activeStep.verificationCommands.length > 0 && (
              <CompactList label="verify" items={activeStep.verificationCommands} monospace />
            )}
          </>
        ) : (
          <div style={{ color: "var(--muted)", fontSize: 10 }}>Spark has not planned a step yet.</div>
        )}
      </DetailPanel>

      <DetailPanel title="WORKERS">
        {activeTasks.length === 0 && recentAttempts.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 10 }}>No worker activity yet.</div>
        ) : (
          <>
            {activeTasks.slice(0, 4).map((task) => {
              const attempt = attemptByTask.get(task.id);
              return (
                <WorkerLine key={task.id} task={task} attempt={attempt} />
              );
            })}
            {activeTasks.length === 0 && recentAttempts.map((attempt) => (
              <AttemptLine key={attempt.id} attempt={attempt} />
            ))}
          </>
        )}
      </DetailPanel>
    </div>
  );
}

function DetailPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        border: "1px solid var(--rule)",
        background: "color-mix(in oklch, var(--panel) 88%, transparent)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ color: "var(--muted)", fontSize: 9, fontWeight: 900, letterSpacing: "0.12em" }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function CompactList({
  label,
  items,
  monospace,
}: {
  label: string;
  items: string[];
  monospace?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ color: "var(--muted)", fontSize: 9, fontWeight: 800 }}>{label}</span>
      {items.slice(0, 3).map((item, index) => (
        <span
          key={index}
          style={{
            color: "var(--ink-dim)",
            fontSize: 10,
            lineHeight: 1.35,
            fontFamily: monospace ? "var(--font-mono)" : undefined,
            wordBreak: "break-word",
          }}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function WorkerLine({ task, attempt }: { task: WorkerTask; attempt?: WorkerAttempt }) {
  const status = deriveAgentStatus(task, attempt, "running");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "74px minmax(0, 1fr) auto", gap: 8, fontSize: 10 }}>
      <span style={{ color: runtimeTone(task.runtimePreference).label, fontWeight: 900, textTransform: "uppercase" }}>
        {task.runtimePreference}
      </span>
      <span
        title={task.title}
        style={{
          color: "var(--ink-dim)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {task.title}
      </span>
      <span style={{ color: statusColor(status), fontWeight: 800 }}>{attempt?.status ?? task.status}</span>
    </div>
  );
}

function AttemptLine({ attempt }: { attempt: WorkerAttempt }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "74px minmax(0, 1fr) auto", gap: 8, fontSize: 10 }}>
      <span style={{ color: runtimeTone(attempt.runtime).label, fontWeight: 900, textTransform: "uppercase" }}>
        {attempt.runtime}
      </span>
      <span style={{ color: "var(--ink-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        attempt {attempt.attemptNumber}
      </span>
      <span style={{ color: attemptStatusColor(attempt.status), fontWeight: 800 }}>{attempt.status}</span>
    </div>
  );
}

function StatusPill({ status }: { status: RunState["status"] }) {
  return (
    <span
      style={{
        color: runStatusColor(status),
        border: `1px solid ${runStatusColor(status)}`,
        padding: "2px 6px",
        fontSize: 9,
        fontWeight: 900,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        flex: "0 0 auto",
      }}
    >
      {status}
    </span>
  );
}

function StatusDot({
  status,
  small,
}: {
  status: RunState["status"] | StepState["status"] | AgentStatusKind;
  small?: boolean;
}) {
  const color = statusColor(status);
  return (
    <span
      style={{
        width: small ? 5 : 7,
        height: small ? 5 : 7,
        borderRadius: 999,
        background: color,
        flex: "0 0 auto",
        animation: isRunningStatus(status) ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
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
        background: "var(--bg)",
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

function buildRunMaps(run: RunState): {
  taskById: Map<string, WorkerTask>;
  attemptByTask: Map<string, WorkerAttempt>;
} {
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

function agentRowsForStep(
  step: StepState,
  taskById: Map<string, WorkerTask>,
  attemptByTask: Map<string, WorkerAttempt>,
): AgentRow[] {
  const tasks = step.workerTaskIds
    .map((id) => taskById.get(id))
    .filter((task): task is WorkerTask => Boolean(task));
  const planned = step.plannedAgents ?? [];

  if (planned.length > 0) {
    return planned.map((agent, index) => {
      const task = tasks[index];
      return {
        agent,
        task,
        attempt: task ? attemptByTask.get(task.id) : undefined,
      };
    });
  }

  return tasks.map((task) => ({
    agent: {
      label: task.title,
      summary: task.description,
      runtimePreference: task.runtimePreference,
      modelHint: task.modelHint,
      effortHint: task.effortHint,
    },
    task,
    attempt: attemptByTask.get(task.id),
  }));
}

function replaceRun(runs: RunState[], run: RunState): RunState[] {
  const byId = new Map<string, RunState>();
  for (const item of runs) byId.set(item.id, item.id === run.id ? run : item);
  byId.set(run.id, run);
  return Array.from(byId.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function findBestRun(runs: RunState[]): RunState | null {
  return runs.find(isLiveRun) ?? runs[0] ?? null;
}

function isLiveRun(run: RunState): boolean {
  return ["planning", "running", "reviewing", "blocked", "paused"].includes(run.status);
}

function connectorLabel(prev: StepState, next: StepState): string {
  if (prev.status === "complete") return "complete";
  if (next.status === "running" || next.status === "reviewing") return "active";
  if (next.status === "queued" || next.status === "ready") return "queued";
  return "next";
}

function sortSteps(steps: StepState[]): StepState[] {
  return [...steps].sort((a, b) => {
    const indexDelta = a.index - b.index;
    if (indexDelta !== 0) return indexDelta;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

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
  if (task?.status === "running" || task?.status === "claimed") return "running";
  if (task?.status === "accepted" || task?.status === "needs_review" || attempt?.status === "succeeded") return "done";
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
      return { label: "var(--accent)", border: "var(--accent)", bg: "rgba(240, 196, 25, 0.08)" };
    case "codex":
      return { label: "var(--info)", border: "var(--info)", bg: "rgba(127, 179, 255, 0.08)" };
    case "shell":
      return { label: "var(--ok)", border: "var(--rule-strong)", bg: "rgba(80, 220, 150, 0.05)" };
    default:
      return { label: "var(--ink-dim)", border: "var(--rule-strong)", bg: "transparent" };
  }
}

function statusColor(status: RunState["status"] | StepState["status"] | AgentStatusKind): string {
  if (status === "running" || status === "reviewing" || status === "planning") return "var(--accent)";
  if (status === "complete" || status === "done") return "var(--ok)";
  if (status === "blocked" || status === "failed") return "var(--danger)";
  return "var(--muted)";
}

function attemptStatusColor(status: WorkerAttempt["status"]): string {
  if (["running", "launching", "preparing", "prompt_ready", "finishing"].includes(status)) return "var(--accent)";
  if (status === "succeeded") return "var(--ok)";
  if (status === "failed" || status === "timed_out" || status === "cancelled") return "var(--danger)";
  return "var(--muted)";
}

function stepStatusColor(status: StepState["status"]): string {
  return statusColor(status);
}

function runStatusColor(status: RunState["status"]): string {
  return statusColor(status);
}

function isRunningStatus(status: RunState["status"] | StepState["status"] | AgentStatusKind): boolean {
  return status === "running" || status === "reviewing" || status === "planning";
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

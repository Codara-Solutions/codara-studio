import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

const MIN_RUN_CANVAS_ZOOM = 0.3;
const MAX_RUN_CANVAS_ZOOM = 2.5;
const DEFAULT_RUN_CANVAS_ZOOM = 1;
const WHEEL_ZOOM_SENSITIVITY = 0.0014;
const ZOOM_EASE = 0.32;

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
        width: 68,
        flex: "0 0 68px",
        borderRight: "1px solid var(--rule)",
        background: "var(--panel)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          padding: "8px 6px 7px",
          borderBottom: "1px solid var(--rule)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 4,
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.12em" }}>RUNS</span>
        <span style={{ color: "var(--muted)", fontSize: 9, fontWeight: 800 }}>
          {formatRunIndex(runs.length)}
        </span>
      </div>
      <div style={{ overflow: "auto", minHeight: 0, padding: "7px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
        {runs.map((run, index) => (
          <RunButton
            key={run.id}
            run={run}
            index={index + 1}
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
  index,
  active,
  onClick,
}: {
  run: RunState;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  const description = `${run.title}\n${run.status} · ${run.steps.length} steps · ${formatTime(run.updatedAt)}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={description}
      style={{
        appearance: "none",
        width: "100%",
        aspectRatio: "1 / 0.82",
        border: `1px solid ${active ? "var(--accent)" : "var(--rule)"}`,
        borderLeft: `3px solid ${active ? "var(--accent)" : "transparent"}`,
        background: active ? "var(--panel-2)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-dim)",
        padding: "5px 4px",
        textAlign: "center",
        fontFamily: "inherit",
        cursor: "default",
        display: "grid",
        gridTemplateRows: "auto minmax(0, 1fr)",
        alignItems: "center",
        justifyItems: "center",
        gap: 3,
      }}
    >
      <span
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          alignItems: "center",
          width: "100%",
        }}
      >
        <span />
        <StatusDot status={run.status} />
      </span>
      <span
        style={{
          color: active ? "var(--ink)" : "var(--muted)",
          fontSize: 13,
          fontWeight: 900,
          lineHeight: 1,
        }}
      >
        {formatRunIndex(index)}
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
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, max-content)",
          alignItems: "stretch",
          color: "var(--muted)",
        }}
      >
        <Metric label="STEPS" value={run.steps.length} />
        <Metric label="TASKS" value={run.workerTasks.length} separated />
        <Metric label="ATTEMPTS" value={run.workerAttempts.length} separated />
        <Metric label="AUTO" value={run.autopilot?.status ?? "idle"} separated />
      </div>
    </header>
  );
}

function Metric({
  label,
  value,
  separated,
}: {
  label: string;
  value: string | number;
  separated?: boolean;
}) {
  const isNumber = typeof value === "number";
  return (
    <span
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        alignItems: "flex-start",
        justifyContent: "center",
        minWidth: isNumber ? 62 : 86,
        padding: "0 18px",
        borderLeft: separated ? "1px solid var(--rule)" : "none",
      }}
    >
      <span style={{ color: "var(--muted)", fontSize: 9, letterSpacing: "0.12em", fontWeight: 800 }}>
        {label}
      </span>
      <b
        style={{
          color: "var(--ink)",
          fontSize: isNumber ? 18 : 14,
          lineHeight: 1,
          fontWeight: 850,
        }}
      >
        {value}
      </b>
    </span>
  );
}

function RunCanvas({ run }: { run: RunState }) {
  const [zoomLabel, setZoomLabel] = useState(`${Math.round(DEFAULT_RUN_CANVAS_ZOOM * 100)}%`);
  const [isPanning, setIsPanning] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Live transform — written directly to the DOM so animation never blocks on React.
  // x/y go on the pan layer (transform: translate3d), z goes on the inner content as
  // CSS `zoom` so text re-lays-out crisply at every scale instead of bitmap-scaling.
  const xRef = useRef(0);
  const yRef = useRef(0);
  const zRef = useRef(1);
  const targetZRef = useRef(DEFAULT_RUN_CANVAS_ZOOM);
  // Cursor anchor for the in-flight zoom animation: world point + screen point that should stay aligned.
  const anchorRef = useRef<{
    worldX: number;
    worldY: number;
    cursorX: number;
    cursorY: number;
  } | null>(null);
  const animationRef = useRef<number | null>(null);
  const panStartRef = useRef<{
    pointerId: number;
    startCx: number;
    startCy: number;
    startX: number;
    startY: number;
  } | null>(null);
  const centeredRunIdRef = useRef<string | null>(null);

  const maps = useMemo(() => buildRunMaps(run), [run]);
  const orderedSteps = useMemo(() => sortSteps(run.steps), [run.steps]);
  const graphWidth = orderedSteps.length === 0
    ? 784
    : 110 + (orderedSteps.length * 320) + 208;
  const contentWidth = Math.max(920, graphWidth);

  const applyTransform = () => {
    const pan = panRef.current;
    const content = contentRef.current;
    if (!pan || !content) return;
    // Round translate to integer device pixels so the pan layer doesn't get raster-tiled
    // at sub-pixel offsets (which softens text). 2D translate (not translate3d) keeps the
    // browser from forcing a permanent compositor layer that downsamples on re-raster.
    const tx = Math.round(xRef.current);
    const ty = Math.round(yRef.current);
    pan.style.transform = `translate(${tx}px, ${ty}px)`;
    content.style.setProperty("zoom", String(zRef.current));
  };

  const updateZoomLabel = () => {
    const next = `${Math.round(zRef.current * 100)}%`;
    setZoomLabel((cur) => (cur === next ? cur : next));
  };

  const stopAnimation = () => {
    if (animationRef.current !== null) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
  };

  const startAnimation = () => {
    if (animationRef.current !== null) return;
    const tick = () => {
      const dz = targetZRef.current - zRef.current;
      const anchor = anchorRef.current;
      if (Math.abs(dz) < 0.0008) {
        zRef.current = targetZRef.current;
        if (anchor) {
          xRef.current = anchor.cursorX - anchor.worldX * zRef.current;
          yRef.current = anchor.cursorY - anchor.worldY * zRef.current;
        }
        applyTransform();
        updateZoomLabel();
        animationRef.current = null;
        return;
      }
      zRef.current += dz * ZOOM_EASE;
      if (anchor) {
        xRef.current = anchor.cursorX - anchor.worldX * zRef.current;
        yRef.current = anchor.cursorY - anchor.worldY * zRef.current;
      }
      applyTransform();
      updateZoomLabel();
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  };

  const zoomToward = (nextTargetZ: number, cursorX: number, cursorY: number) => {
    const clamped = clampZoom(nextTargetZ);
    if (clamped === targetZRef.current && clamped === zRef.current) return;
    // Anchor on the current rendered position so easing keeps the cursor stable.
    const worldX = (cursorX - xRef.current) / zRef.current;
    const worldY = (cursorY - yRef.current) / zRef.current;
    anchorRef.current = { worldX, worldY, cursorX, cursorY };
    targetZRef.current = clamped;
    startAnimation();
  };

  const zoomBy = (delta: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    zoomToward(
      targetZRef.current + delta,
      viewport.clientWidth / 2,
      viewport.clientHeight / 2,
    );
  };

  const zoomToValue = (value: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    zoomToward(value, viewport.clientWidth / 2, viewport.clientHeight / 2);
  };

  // Native, non-passive wheel listener so preventDefault always works.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;
      const lineHeight = 16;
      const deltaScale = event.deltaMode === 1
        ? lineHeight
        : event.deltaMode === 2
          ? viewport.clientHeight
          : 1;
      const deltaY = event.deltaY * deltaScale;
      const factor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);

      // If a pan is somehow still active, end it cleanly.
      if (panStartRef.current) {
        if (viewport.hasPointerCapture(panStartRef.current.pointerId)) {
          viewport.releasePointerCapture(panStartRef.current.pointerId);
        }
        panStartRef.current = null;
        setIsPanning(false);
      }

      zoomToward(targetZRef.current * factor, cursorX, cursorY);
    };

    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => () => stopAnimation(), []);

  // Center the graph the first time we see a given run. Default to native 100% so
  // text always renders at its true size — sub-100% CSS zoom rasterizes fonts at
  // fractional sizes which looks soft. If the content is wider than the viewport,
  // it just overflows and the user pans; the wheel still zooms out smoothly.
  useLayoutEffect(() => {
    if (centeredRunIdRef.current === run.id) return;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // BCR returns the on-screen visual size — divide by current zoom to get the natural size.
    const rect = content.getBoundingClientRect();
    const naturalW = rect.width / zRef.current;
    const naturalH = rect.height / zRef.current;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    if (naturalW <= 0 || naturalH <= 0 || vw <= 0 || vh <= 0) return;
    centeredRunIdRef.current = run.id;
    const z = clampZoom(DEFAULT_RUN_CANVAS_ZOOM);
    stopAnimation();
    zRef.current = z;
    targetZRef.current = z;
    xRef.current = (vw - naturalW * z) / 2;
    yRef.current = (vh - naturalH * z) / 2;
    anchorRef.current = null;
    applyTransform();
    updateZoomLabel();
  }, [run.id]);

  const startPanning = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    stopAnimation();
    targetZRef.current = zRef.current;
    anchorRef.current = null;
    panStartRef.current = {
      pointerId: event.pointerId,
      startCx: event.clientX,
      startCy: event.clientY,
      startX: xRef.current,
      startY: yRef.current,
    };
    setIsPanning(true);
  };

  const movePanning = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    event.preventDefault();
    xRef.current = start.startX + (event.clientX - start.startCx);
    yRef.current = start.startY + (event.clientY - start.startCy);
    applyTransform();
  };

  const stopPanning = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = panStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    panStartRef.current = null;
    setIsPanning(false);
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
        <ZoomButton label="-" title="Zoom out" onClick={() => zoomBy(-0.12)} />
        <span style={{ width: 42, textAlign: "center", color: "var(--ink-dim)", fontSize: 10 }}>
          {zoomLabel}
        </span>
        <ZoomButton label="+" title="Zoom in" onClick={() => zoomBy(0.12)} />
        <ZoomButton label="1:1" title="Reset zoom" wide onClick={() => zoomToValue(1)} />
      </div>

      <div
        ref={viewportRef}
        onPointerDown={startPanning}
        onPointerMove={movePanning}
        onPointerUp={stopPanning}
        onPointerCancel={stopPanning}
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          cursor: isPanning ? "grabbing" : "grab",
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <div
          ref={panRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            transformOrigin: "0 0",
          }}
        >
          <div
            ref={contentRef}
            style={{
              width: contentWidth,
              display: "flex",
              flexDirection: "column",
              gap: 22,
              textRendering: "geometricPrecision",
              WebkitFontSmoothing: "antialiased",
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
        gridTemplateColumns: `110px ${steps.map(() => "82px 258px").join(" ")} 82px 126px`,
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
  const primaryRow = rows[0];

  return (
    <article
      title={step.goal || step.title}
      style={{
        width: 258,
        minHeight: 166,
        background: nodeActive
          ? "linear-gradient(135deg, color-mix(in oklch, var(--panel-2) 86%, var(--accent) 14%), color-mix(in oklch, var(--panel) 94%, transparent))"
          : "linear-gradient(135deg, color-mix(in oklch, var(--panel) 92%, white 2%), color-mix(in oklch, var(--panel) 92%, transparent))",
        border: `1px solid ${nodeActive ? "var(--accent)" : "var(--rule-strong)"}`,
        borderRadius: 6,
        boxShadow: nodeActive
          ? "0 0 0 1px color-mix(in oklch, var(--accent) 36%, transparent), 0 0 24px color-mix(in oklch, var(--accent) 22%, transparent), 0 18px 44px rgba(0,0,0,0.34)"
          : "0 12px 34px rgba(0,0,0,0.22)",
        padding: "12px 13px",
        display: "flex",
        flexDirection: "column",
        gap: 9,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "32px minmax(0, 1fr) auto", gap: 8, alignItems: "start" }}>
        <StepIcon step={step} />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
          <div
            style={{
              color: "var(--muted)",
              fontSize: 8,
              fontWeight: 900,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            STEP {displayIndex}
          </div>
          <div
            style={{
              color: "var(--ink)",
              fontSize: 13,
              fontWeight: 900,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.title}
          </div>
        </div>
        <span style={{ color: tone, fontSize: 9, fontWeight: 900, textTransform: "uppercase" }}>
          {stepStatusLabel(step.status)}
        </span>
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

      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, minHeight: 24 }}>
        {rows.length === 0 ? (
          <Tag muted>waiting for agents</Tag>
        ) : (
          rows.slice(0, 2).map((row, index) => (
            <AgentTag key={index} row={row} stepStatus={step.status} />
          ))
        )}
        {rows.length > 2 && <Tag muted>+{rows.length - 2}</Tag>}
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: tone, fontWeight: 900, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          <StatusDot status={step.status} small />
          {stepStatusLabel(step.status)}
        </span>
        <span>
          {primaryRow?.task?.status ?? `${step.workerTaskIds.length} task${step.workerTaskIds.length === 1 ? "" : "s"}`}
        </span>
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
  const activeAttempts = activeTasks
    .map((task) => attemptByTask.get(task.id))
    .filter((attempt): attempt is WorkerAttempt => Boolean(attempt));
  const activeAttempt = activeAttempts.find((attempt) => isActiveAttemptStatus(attempt.status)) ?? activeAttempts[0];
  const workItems = activeStep ? buildStepWorkItems(activeStep, activeTasks, attemptByTask) : [];
  const completeTasks = activeTasks.filter(isCompletedTask).length;
  const taskProgress = activeTasks.length === 0 ? null : Math.round((completeTasks / activeTasks.length) * 100);
  const recentAttempts = run.workerAttempts.slice(-5).reverse();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(420px, 0.9fr) minmax(520px, 1.1fr)",
        gap: 16,
        maxWidth: 1260,
      }}
    >
      <DetailPanel
        title={activeStep ? `STEP ${activeStepNumber}` : "RUN"}
        meta={activeStep ? stepStatusLabel(activeStep.status) : run.status}
        right={activeStep ? <ElapsedChip attempt={activeAttempt} fallback={activeStep.updatedAt} /> : undefined}
      >
        {activeStep ? (
          <>
            <div style={{ color: "var(--ink)", fontSize: 16, fontWeight: 900, lineHeight: 1.15 }}>
              {activeStep.title}
            </div>
            <div style={{ color: "var(--ink-dim)", fontSize: 11, lineHeight: 1.5 }}>
              {activeStep.goal || "No goal recorded for this step yet."}
            </div>
            <div
              style={{
                border: "1px solid var(--rule)",
                background: "color-mix(in oklch, var(--bg) 58%, transparent)",
                borderRadius: 5,
                overflow: "hidden",
              }}
            >
              {workItems.length === 0 ? (
                <div style={{ padding: "13px 14px", color: "var(--muted)", fontSize: 11 }}>
                  Waiting for Spark to attach acceptance or verification work.
                </div>
              ) : (
                workItems.map((item, index) => (
                  <WorkItemRow key={`${item.label}-${index}`} item={item} />
                ))
              )}
            </div>
            {taskProgress === null ? (
              <div style={{ color: "var(--muted)", fontSize: 10 }}>
                Worker task progress appears here once Spark creates task records for this step.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, alignItems: "center" }}>
                <ProgressBar value={taskProgress} active={isRunningStatus(activeStep.status)} />
                <span style={{ color: "var(--ink-dim)", fontSize: 11 }}>
                  {completeTasks} / {activeTasks.length}
                </span>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: "var(--muted)", fontSize: 10 }}>Spark has not planned a step yet.</div>
        )}
      </DetailPanel>

      <DetailPanel title="WORKERS & ACTIVITY" meta={`${activeTasks.length || recentAttempts.length} live`}>
        {activeTasks.length === 0 && recentAttempts.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 10 }}>No worker activity yet.</div>
        ) : (
          <>
            <div
              style={{
                border: "1px solid var(--rule)",
                background: "color-mix(in oklch, var(--bg) 58%, transparent)",
                borderRadius: 5,
                overflow: "hidden",
              }}
            >
              {activeTasks.length > 0
                ? activeTasks.slice(0, 4).map((task) => {
                    const attempt = attemptByTask.get(task.id);
                    return <WorkerLine key={task.id} task={task} attempt={attempt} />;
                  })
                : recentAttempts.slice(0, 3).map((attempt) => (
                    <AttemptLine key={attempt.id} attempt={attempt} />
                  ))}
            </div>
            {recentAttempts.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {recentAttempts.map((attempt) => (
                  <ActivityLine key={attempt.id} attempt={attempt} />
                ))}
              </div>
            )}
          </>
        )}
      </DetailPanel>
    </div>
  );
}

function DetailPanel({
  title,
  meta,
  right,
  children,
}: {
  title: string;
  meta?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        border: "1px solid var(--rule)",
        borderRadius: 6,
        background:
          "linear-gradient(135deg, color-mix(in oklch, var(--panel) 94%, white 3%), color-mix(in oklch, var(--panel) 90%, transparent))",
        boxShadow: "0 16px 42px rgba(0,0,0,0.25)",
        minHeight: 222,
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--muted)", fontSize: 10, fontWeight: 900, letterSpacing: "0.12em" }}>
          {title}
        </span>
        {meta && (
          <>
            <span style={{ color: "var(--muted)", fontSize: 10 }}>·</span>
            <span style={{ color: "var(--accent)", fontSize: 10, fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              {meta}
            </span>
          </>
        )}
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </section>
  );
}

interface StepWorkItem {
  label: string;
  text: string;
  status?: AgentStatusKind;
  statusLabel: string;
  monospace?: boolean;
  meta?: string;
}

function WorkItemRow({ item }: { item: StepWorkItem }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "18px minmax(0, 1fr) auto",
        gap: 10,
        alignItems: "center",
        padding: "10px 12px",
        borderTop: "1px solid var(--rule)",
      }}
    >
      <WorkStatusIcon status={item.status} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ color: item.status === "done" ? "var(--accent)" : "var(--ink-dim)", fontSize: 11, fontWeight: 800 }}>
          {item.label}
        </span>
        <span
          style={{
            color: "var(--muted)",
            fontSize: 10,
            fontFamily: item.monospace ? "var(--font-mono)" : undefined,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {item.text}
        </span>
      </div>
      <span
        style={{
          color: item.status ? statusColor(item.status) : "var(--muted)",
          fontSize: 10,
          fontWeight: item.status ? 800 : undefined,
          fontVariantNumeric: "tabular-nums",
          textTransform: item.status ? "uppercase" : undefined,
          whiteSpace: "nowrap",
        }}
      >
        {item.meta ?? item.statusLabel}
      </span>
    </div>
  );
}

function WorkerLine({ task, attempt }: { task: WorkerTask; attempt?: WorkerAttempt }) {
  const status = deriveAgentStatus(task, attempt, "running");
  const tone = runtimeTone(task.runtimePreference);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "88px minmax(0, 1fr) auto auto",
        gap: 12,
        alignItems: "center",
        padding: "9px 12px",
        borderTop: "1px solid var(--rule)",
        fontSize: 10,
      }}
    >
      <span
        style={{
          color: tone.label,
          background: tone.bg,
          border: `1px solid ${tone.border}`,
          padding: "3px 7px",
          fontWeight: 900,
          textTransform: "uppercase",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
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
      <span style={{ color: statusColor(status), fontWeight: 900, textTransform: "uppercase" }}>
        {attempt?.status ?? task.status}
      </span>
      <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
        {attempt ? formatDuration(attempt.startedAt, attempt.finishedAt) : "--:--"}
      </span>
    </div>
  );
}

function AttemptLine({ attempt }: { attempt: WorkerAttempt }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px minmax(0, 1fr) auto", gap: 12, padding: "9px 12px", borderTop: "1px solid var(--rule)", fontSize: 10 }}>
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

function ActivityLine({ attempt }: { attempt: WorkerAttempt }) {
  const time = attempt.startedAt ?? attempt.finishedAt ?? "";
  const text = attempt.error
    ? attempt.error
    : attempt.command
      ? attempt.command
      : attempt.finalReportPath
        ? "final report written"
        : `attempt ${attempt.attemptNumber}`;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "64px 12px minmax(0, 1fr)",
        gap: 7,
        alignItems: "baseline",
        color: "var(--muted)",
        fontSize: 10,
        lineHeight: 1.45,
      }}
    >
      <span style={{ color: attemptStatusColor(attempt.status), fontVariantNumeric: "tabular-nums" }}>
        {time ? formatClock(time) : "--:--:--"}
      </span>
      <span style={{ color: attemptStatusColor(attempt.status), fontWeight: 900 }}>{">"}</span>
      <span
        title={text}
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </span>
    </div>
  );
}

function ProgressBar({ value, active }: { value: number; active: boolean }) {
  return (
    <div
      style={{
        height: 6,
        borderRadius: 999,
        background: "color-mix(in oklch, var(--rule) 52%, transparent)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.max(4, Math.min(100, value))}%`,
          height: "100%",
          borderRadius: 999,
          background: active
            ? "linear-gradient(90deg, var(--accent), color-mix(in oklch, var(--accent) 72%, white 18%))"
            : "var(--ok)",
          boxShadow: active ? "0 0 14px color-mix(in oklch, var(--accent) 42%, transparent)" : undefined,
        }}
      />
    </div>
  );
}

function WorkStatusIcon({ status }: { status?: AgentStatusKind }) {
  const color = status ? statusColor(status) : "var(--muted)";
  const filled = status === "done" || status === "blocked";
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: 999,
        border: `1px solid ${color}`,
        background: filled ? color : "transparent",
        color: "var(--bg)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 9,
        fontWeight: 900,
        lineHeight: 1,
        animation: status === "running" ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    >
      {status === "blocked" ? "x" : null}
    </span>
  );
}

function ElapsedChip({
  attempt,
  fallback,
}: {
  attempt?: WorkerAttempt;
  fallback?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: "var(--ink-dim)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 999,
          border: "1px solid var(--muted)",
        }}
      />
      {attempt ? formatDuration(attempt.startedAt, attempt.finishedAt) : fallback ? formatSince(fallback) : "--:--:--"}
    </span>
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

function clampZoom(value: number): number {
  return Math.min(MAX_RUN_CANVAS_ZOOM, Math.max(MIN_RUN_CANVAS_ZOOM, Number(value.toFixed(2))));
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

function buildStepWorkItems(
  step: StepState,
  tasks: WorkerTask[],
  attemptByTask: Map<string, WorkerAttempt>,
): StepWorkItem[] {
  const requirementRows: StepWorkItem[] = [
    ...step.acceptanceCriteria.slice(0, 3).map((text) => ({
      label: "Acceptance",
      text,
      statusLabel: "required",
    })),
    ...step.verificationCommands.slice(0, 3).map((text) => ({
      label: "Verify",
      text,
      monospace: true,
      statusLabel: "command",
    })),
  ];

  if (requirementRows.length > 0) return requirementRows.slice(0, 4);

  return tasks.slice(0, 4).map((task) => {
    const attempt = attemptByTask.get(task.id);
    const status = deriveAgentStatus(task, attempt, step.status);
    return {
      label: task.runtimePreference.toUpperCase(),
      text: task.description || task.title,
      status,
      statusLabel: attempt?.status ?? task.status,
      meta: attempt ? formatDuration(attempt.startedAt, attempt.finishedAt) : formatTime(task.updatedAt),
    };
  });
}

function isCompletedTask(task: WorkerTask): boolean {
  return task.status === "accepted" || task.status === "needs_review";
}

function isActiveAttemptStatus(status: WorkerAttempt["status"]): boolean {
  return ["preparing", "prompt_ready", "launching", "running", "finishing"].includes(status);
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

function stepStatusLabel(status: StepState["status"]): string {
  switch (status) {
    case "running":
    case "reviewing":
      return "running";
    case "ready":
      return "ready";
    case "complete":
      return "complete";
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

function formatRunIndex(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatClock(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatSince(value: string): string {
  const start = new Date(value).getTime();
  if (Number.isNaN(start)) return "--:--:--";
  return formatDurationMs(Math.max(0, Date.now() - start));
}

function formatDuration(startedAt?: string, finishedAt?: string): string {
  if (!startedAt) return "--:--:--";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return "--:--:--";
  return formatDurationMs(Math.max(0, end - start));
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

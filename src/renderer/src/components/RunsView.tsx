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
  // Lifted state from App: the runs list and selection are owned upstream so
  // the right-panel SparkAgentPanel and this canvas always agree.
  runs: RunState[];
  activeRunId: string | null;
  onSelectRun: (id: string | null) => void;
}

interface AgentRow {
  agent: PlannedStepAgent;
  task?: WorkerTask;
  attempt?: WorkerAttempt;
}

export default function RunsView({ workspace, runs, activeRunId }: Props) {
  // Canvas-local state — events, the chosen event, and resolved artifact
  // paths. The runs list and active selection live in App.tsx.
  const [events, setEvents] = useState<SparkEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [artifactPaths, setArtifactPaths] = useState<RunArtifactPaths | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = workspace?.id ?? null;
  const activeRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [runs, activeRunId],
  );

  // Reload events + artifact paths whenever the selected run changes.
  useEffect(() => {
    if (!activeRunId) {
      setEvents([]);
      setSelectedEventId(null);
      setArtifactPaths(null);
      return;
    }

    let cancelled = false;
    void Promise.all([
      window.spark.orchestration.listEvents(activeRunId),
      window.spark.orchestration.getArtifactPaths(activeRunId),
    ]).then(([nextEvents, paths]) => {
      if (cancelled) return;
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

  // Live-append events for the currently-selected run.
  useEffect(() => {
    if (!workspaceId || !activeRunId) return undefined;

    return window.spark.orchestration.onEvent((event) => {
      if (event.workspaceId !== workspaceId) return;
      if (event.runId !== activeRunId) return;
      setEvents((current) => {
        if (current.some((item) => item.id === event.id)) return current;
        return [...current, event];
      });
      setSelectedEventId((current) => current ?? event.id);
      void window.spark.orchestration.getArtifactPaths(activeRunId).then(setArtifactPaths);
    });
  }, [activeRunId, workspaceId]);

  if (!workspace) {
    return <EmptyState text="No active workspace." />;
  }
  if (error) {
    return <EmptyState text={`Error: ${error}`} tone="danger" />;
  }
  if (runs.length === 0) {
    return (
      <EmptyState
        heading="No runs yet."
        text="Pick a plan in the right panel and press Run."
      />
    );
  }
  if (!activeRun) {
    return <EmptyState text="Select a run from the right panel." />;
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

function RunHeader({ run }: { run: RunState }) {
  const activeStep = run.steps.find((step) => step.id === run.currentStepId)
    ?? run.steps.find((step) => step.status === "running" || step.status === "reviewing")
    ?? run.steps.find((step) => step.status !== "complete" && step.status !== "skipped");

  return (
    <header
      style={{
        flex: "0 0 auto",
        background: "var(--panel)",
        borderBottom: "1px solid var(--rule-soft)",
        padding: "14px 20px 12px",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        gap: 20,
        alignItems: "center",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
          <span
            title={run.title}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: "-0.005em",
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
            fontFamily: "var(--font-sans)",
            fontSize: 12,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {activeStep ? `Now: ${activeStep.title}` : "Waiting for Spark to plan the first step"}
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
        padding: "0 20px",
        borderLeft: separated ? "1px solid var(--rule-soft)" : "none",
      }}
    >
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          letterSpacing: "0.12em",
          fontWeight: 600,
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      <b
        style={{
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: isNumber ? 22 : 13,
          lineHeight: 1,
          fontWeight: isNumber ? 700 : 600,
          fontVariantNumeric: "tabular-nums",
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
          "radial-gradient(circle, color-mix(in oklch, var(--muted) 32%, transparent) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 2,
          display: "flex",
          alignItems: "center",
          gap: 4,
          background: "var(--panel)",
          border: "1px solid var(--rule-soft)",
          borderRadius: 6,
          padding: 4,
          boxShadow: "var(--shadow-1)",
        }}
      >
        <ZoomButton label="-" title="Zoom out" onClick={() => zoomBy(-0.12)} />
        <span
          style={{
            width: 44,
            textAlign: "center",
            color: "var(--ink-dim)",
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            fontVariantNumeric: "tabular-nums",
          }}
        >
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
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none",
        width: wide ? 36 : 24,
        height: 24,
        border: "1px solid var(--rule-soft)",
        borderRadius: 4,
        background: hover ? "var(--hover-strong)" : "transparent",
        color: hover ? "var(--ink)" : "var(--ink-dim)",
        fontFamily: wide ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: wide ? 10 : 13,
        fontWeight: wide ? 600 : 700,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1,
        padding: 0,
        cursor: "default",
        transition:
          "background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)",
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
      {steps.map((step, index) => {
        const prev = index === 0 ? null : steps[index - 1];
        // Energy "flows" along the connector when the previous step is busy
        // (running/reviewing) and this step is still waiting. The first
        // connector (SPARK → step 1) flows when run is running and step 1 is
        // still queued — i.e. Spark is currently planning.
        const flowing = prev
          ? isFlowingBetween(prev, step)
          : run.status === "running" && (step.status === "queued" || step.status === "ready" || step.status === "planning");
        return (
          <React.Fragment key={step.id}>
            <Connector
              label={index === 0 ? "planned" : connectorLabel(prev!, step)}
              flowing={flowing}
            />
            <StepNode
              step={step}
              displayIndex={index + 1}
              taskById={taskById}
              attemptByTask={attemptByTask}
              active={step.id === run.currentStepId}
            />
          </React.Fragment>
        );
      })}
      <Connector
        label={run.status === "complete" ? "done" : "finish"}
        flowing={run.status === "running" && steps.length > 0 && steps[steps.length - 1].status !== "complete" && steps[steps.length - 1].status !== "skipped" && steps[steps.length - 1].status !== "failed"}
      />
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
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        color: "var(--ink)",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <span style={{ width: 8, height: 8, background: "var(--accent)", borderRadius: 2 }} />
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 10,
        }}
      >
        {subtitle}
      </span>
    </div>
  );
}

function EndBlock({ status }: { status: RunState["status"] }) {
  const complete = status === "complete";
  return (
    <div
      style={{
        minHeight: 54,
        border: `1px solid ${complete ? "var(--ok)" : "var(--rule)"}`,
        borderRadius: 6,
        background: complete
          ? "var(--ok-soft)"
          : "color-mix(in oklch, var(--panel) 86%, transparent)",
        color: complete ? "var(--ok)" : "var(--muted)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        boxShadow: complete ? "0 0 14px var(--accent-glow)" : "none",
      }}
    >
      {complete ? "complete" : "pending"}
    </div>
  );
}

function Connector({ label, flowing = false }: { label: string; flowing?: boolean }) {
  return (
    <div
      style={{
        position: "relative",
        minWidth: 82,
        height: 54,
        display: "flex",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          width: "100%",
          borderTop: `1px ${flowing ? "solid" : "dashed"} ${flowing ? "var(--accent, #f0c419)" : "var(--rule)"}`,
          opacity: flowing ? 0.55 : 1,
          transition: "opacity 200ms ease-out",
        }}
      />
      {flowing && (
        <>
          {/* Travelling spark — a small bright dot riding the line. */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: "50%",
              left: 0,
              width: 36,
              height: 2,
              transform: "translateY(-50%)",
              background:
                "linear-gradient(90deg, rgba(240,196,25,0) 0%, rgba(240,196,25,0.95) 50%, rgba(240,196,25,0) 100%)",
              filter: "blur(0.4px) drop-shadow(0 0 4px var(--accent, #f0c419))",
              animation: "spark-connector-flow 1.6s cubic-bezier(.55,.05,.55,.95) infinite",
              pointerEvents: "none",
            }}
          />
          {/* Soft halo behind the line so the whole connector feels alive. */}
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: "50%",
              left: 0,
              right: 0,
              height: 8,
              transform: "translateY(-50%)",
              background:
                "radial-gradient(ellipse at center, rgba(240,196,25,0.18) 0%, rgba(240,196,25,0) 70%)",
              animation: "spark-connector-halo 1.6s ease-in-out infinite",
              pointerEvents: "none",
            }}
          />
        </>
      )}
      <span
        style={{
          position: "absolute",
          top: 0,
          left: "50%",
          transform: "translateX(-50%)",
          color: flowing ? "var(--accent, #f0c419)" : "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          letterSpacing: "0.06em",
          whiteSpace: "nowrap",
          background: "var(--bg)",
          padding: "0 6px",
          textShadow: flowing ? "0 0 8px rgba(240,196,25,0.45)" : "none",
        }}
      >
        {label}
      </span>
    </div>
  );
}

// True when prev is actively producing output and next is waiting for it —
// that's when we want to show energy flowing across the connector.
function isFlowingBetween(prev: StepState, next: StepState): boolean {
  const prevBusy = prev.status === "running" || prev.status === "reviewing";
  const nextWaiting =
    next.status === "queued" || next.status === "ready" || next.status === "planning";
  return prevBusy && nextWaiting;
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
        border: `1px solid ${nodeActive ? "var(--accent-edge)" : "var(--rule-strong)"}`,
        borderRadius: 8,
        boxShadow: nodeActive
          ? "0 0 0 1px var(--accent-edge), 0 0 24px var(--accent-glow), 0 18px 44px rgba(0,0,0,0.34)"
          : "var(--shadow-2)",
        padding: "12px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "32px minmax(0, 1fr) auto", gap: 8, alignItems: "start" }}>
        <StepIcon step={step} />
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <div
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
            }}
          >
            STEP {displayIndex}
          </div>
          <div
            style={{
              color: "var(--ink)",
              fontFamily: "var(--font-sans)",
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.2,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {step.title}
          </div>
        </div>
        <span
          style={{
            color: tone,
            fontFamily: "var(--font-sans)",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {stepStatusLabel(step.status)}
        </span>
      </div>

      <div
        style={{
          color: "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          lineHeight: 1.45,
          minHeight: 30,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
        }}
      >
        {step.goal || "Worker activity for this step."}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, minHeight: 24 }}>
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
          fontFamily: "var(--font-sans)",
          fontSize: 10,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: tone,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
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
        border: "1px solid var(--accent-edge)",
        borderRadius: 8,
        padding: "14px",
        boxShadow: "var(--shadow-2)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusDot status={status} />
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          {eyebrow}
        </span>
      </div>
      <div
        style={{
          color: "var(--ink)",
          fontFamily: "var(--font-sans)",
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.2,
        }}
      >
        {title}
      </div>
      <div
        style={{
          color: "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        {summary}
      </div>
    </article>
  );
}

function GhostCard({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div
      style={{
        width: 240,
        minHeight: 112,
        border: "1px dashed var(--rule)",
        borderRadius: 8,
        background: "color-mix(in oklch, var(--panel) 62%, transparent)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 6,
        padding: "16px",
        fontFamily: "var(--font-sans)",
      }}
    >
      <span
        style={{
          color: "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {title}
      </span>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          lineHeight: 1.45,
        }}
      >
        {subtitle}
      </span>
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
        borderRadius: 6,
        border: `1px solid ${stepStatusColor(step.status)}`,
        background: "color-mix(in oklch, var(--panel-2) 78%, var(--accent) 10%)",
        color: stepStatusColor(step.status),
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        fontWeight: 700,
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
        gap: 6,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: "var(--ink-dim)",
        padding: "3px 7px",
        borderRadius: 3,
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        lineHeight: 1.2,
      }}
    >
      <StatusDot status={status} small />
      <b
        style={{
          color: tone.label,
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {row.agent.runtimePreference}
      </b>
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
        borderRadius: 3,
        background: "var(--bg)",
        color: muted ? "var(--muted)" : "var(--ink-dim)",
        padding: "3px 7px",
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 500,
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
            <div
              style={{
                color: "var(--ink)",
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 700,
                lineHeight: 1.2,
              }}
            >
              {activeStep.title}
            </div>
            <div
              style={{
                color: "var(--ink-dim)",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              {activeStep.goal || "No goal recorded for this step yet."}
            </div>
            <div
              style={{
                border: "1px solid var(--rule-soft)",
                background: "color-mix(in oklch, var(--bg) 58%, transparent)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              {workItems.length === 0 ? (
                <div
                  style={{
                    padding: "14px 16px",
                    color: "var(--muted)",
                    fontFamily: "var(--font-sans)",
                    fontSize: 11,
                  }}
                >
                  Waiting for Spark to attach acceptance or verification work.
                </div>
              ) : (
                workItems.map((item, index) => (
                  <WorkItemRow key={`${item.label}-${index}`} item={item} />
                ))
              )}
            </div>
            {taskProgress === null ? (
              <div
                style={{
                  color: "var(--muted)",
                  fontFamily: "var(--font-sans)",
                  fontSize: 11,
                }}
              >
                Worker task progress appears here once Spark creates task records for this step.
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center" }}>
                <ProgressBar value={taskProgress} active={isRunningStatus(activeStep.status)} />
                <span
                  style={{
                    color: "var(--ink-dim)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {completeTasks} / {activeTasks.length}
                </span>
              </div>
            )}
          </>
        ) : (
          <div
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
            }}
          >
            Spark has not planned a step yet.
          </div>
        )}
      </DetailPanel>

      <DetailPanel title="WORKERS & ACTIVITY" meta={`${activeTasks.length || recentAttempts.length} live`}>
        {activeTasks.length === 0 && recentAttempts.length === 0 ? (
          <div
            style={{
              color: "var(--muted)",
              fontFamily: "var(--font-sans)",
              fontSize: 11,
            }}
          >
            No worker activity yet.
          </div>
        ) : (
          <>
            <div
              style={{
                border: "1px solid var(--rule-soft)",
                background: "color-mix(in oklch, var(--bg) 58%, transparent)",
                borderRadius: 6,
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
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {recentAttempts.map((attempt) => (
                  <ActivityLine key={attempt.id} attempt={attempt} />
                ))}
              </div>
            )}
            <LatestReportPreview attempts={run.workerAttempts} taskById={taskById} />
          </>
        )}
      </DetailPanel>
    </div>
  );
}

// Pulls the most recent attempt that produced a finalReport and renders a
// compact summary (status, summary line, files changed, proof, risks). This
// is what the user wanted surfaced in the run canvas instead of having to
// jump to the Workers tab to read agent output.
function LatestReportPreview({
  attempts,
  taskById,
}: {
  attempts: WorkerAttempt[];
  taskById: Map<string, WorkerTask>;
}) {
  const reported = useMemo(
    () => attempts.filter((attempt) => attempt.finalReportPath).slice().reverse(),
    [attempts],
  );
  const latest = reported[0];
  const [report, setReport] = useState<import("@shared/types").WorkerReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!latest?.finalReportPath) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void window.spark.orchestration
      .readWorkerReport(latest.finalReportPath)
      .then((next) => {
        if (cancelled) return;
        setReport(next);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError((err as Error).message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-load whenever a different attempt's report becomes available, or the
    // path itself changes (e.g. retry overwrote the file).
  }, [latest?.id, latest?.finalReportPath, latest?.finishedAt]);

  if (!latest) return null;
  const task = taskById.get(latest.workerTaskId);
  const labelTone = runtimeTone(latest.runtime);

  return (
    <div
      style={{
        marginTop: 10,
        border: "1px solid var(--rule-soft)",
        background: "color-mix(in oklch, var(--bg) 70%, transparent)",
        borderRadius: 6,
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            color: labelTone.label,
            background: labelTone.bg,
            border: `1px solid ${labelTone.border}`,
            padding: "2px 6px",
            borderRadius: 3,
            fontFamily: "var(--font-mono)",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          {latest.runtime}
        </span>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          Latest report
        </span>
        <span
          style={{
            color: "var(--ink-dim)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={task?.title}
        >
          {task?.title ?? `attempt ${latest.attemptNumber}`}
        </span>
        {report && (
          <span
            style={{
              color: reportStatusColor(report.status),
              fontFamily: "var(--font-sans)",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {report.status}
          </span>
        )}
      </div>
      {loading ? (
        <div style={{ color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: 11 }}>
          Loading report…
        </div>
      ) : loadError ? (
        <div style={{ color: "var(--danger, #d77)", fontFamily: "var(--font-sans)", fontSize: 11 }}>
          Could not read report: {loadError}
        </div>
      ) : !report ? (
        <div style={{ color: "var(--muted)", fontFamily: "var(--font-sans)", fontSize: 11 }}>
          {latest.status === "running" || latest.status === "launching" || latest.status === "preparing"
            ? "Worker hasn't written a final report yet."
            : "No structured report on disk for this attempt."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {report.summary && (
            <div
              style={{
                color: "var(--ink)",
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {report.summary}
            </div>
          )}
          {report.filesChanged.length > 0 && (
            <ReportSection label="Files changed">
              {report.filesChanged.slice(0, 6).map((entry, index) => (
                <div key={`${entry.path}-${index}`} style={reportListItemStyle}>
                  <span style={{ color: "var(--accent)" }}>{entry.path}</span>
                  {entry.reason ? (
                    <span style={{ color: "var(--muted)" }}> — {entry.reason}</span>
                  ) : null}
                </div>
              ))}
              {report.filesChanged.length > 6 && (
                <div style={{ color: "var(--muted)", fontSize: 11 }}>
                  +{report.filesChanged.length - 6} more
                </div>
              )}
            </ReportSection>
          )}
          {report.proof.length > 0 && (
            <ReportSection label="Proof">
              {report.proof.slice(0, 4).map((line, index) => (
                <div key={index} style={reportListItemStyle}>
                  {line}
                </div>
              ))}
            </ReportSection>
          )}
          {(report.risks.length > 0 || report.followups.length > 0) && (
            <ReportSection label="Risks / follow-ups">
              {report.risks.slice(0, 3).map((line, index) => (
                <div key={`r-${index}`} style={{ ...reportListItemStyle, color: "var(--warn, #d9a86a)" }}>
                  {line}
                </div>
              ))}
              {report.followups.slice(0, 3).map((line, index) => (
                <div key={`f-${index}`} style={reportListItemStyle}>
                  → {line}
                </div>
              ))}
            </ReportSection>
          )}
        </div>
      )}
    </div>
  );
}

function ReportSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-sans)",
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

const reportListItemStyle: React.CSSProperties = {
  color: "var(--ink-dim)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  lineHeight: 1.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function reportStatusColor(status: import("@shared/types").WorkerReport["status"]): string {
  switch (status) {
    case "complete":
      return "var(--success, #6ec27a)";
    case "partial":
      return "var(--warn, #d9a86a)";
    case "blocked":
    case "failed":
      return "var(--danger, #d77)";
    default:
      return "var(--ink-dim)";
  }
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
        border: "1px solid var(--rule-soft)",
        borderRadius: 8,
        background:
          "linear-gradient(135deg, color-mix(in oklch, var(--panel) 94%, white 3%), color-mix(in oklch, var(--panel) 90%, transparent))",
        boxShadow: "var(--shadow-2)",
        minHeight: 222,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: "var(--font-sans)",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          {title}
        </span>
        {meta && (
          <>
            <span style={{ color: "var(--muted)", fontSize: 10 }}>·</span>
            <span
              style={{
                color: "var(--accent)",
                fontFamily: "var(--font-sans)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
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
        gridTemplateColumns: "20px minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        padding: "12px 14px",
        borderTop: "1px solid var(--rule-soft)",
      }}
    >
      <WorkStatusIcon status={item.status} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span
          style={{
            color: item.status === "done" ? "var(--accent)" : "var(--ink-dim)",
            fontFamily: "var(--font-sans)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
          }}
        >
          {item.label}
        </span>
        <span
          style={{
            color: "var(--muted)",
            fontFamily: item.monospace ? "var(--font-mono)" : "var(--font-sans)",
            fontSize: 11,
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
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: item.status ? 600 : 500,
          fontVariantNumeric: "tabular-nums",
          textTransform: item.status ? "uppercase" : undefined,
          letterSpacing: item.status ? "0.06em" : undefined,
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
        gridTemplateColumns: "92px minmax(0, 1fr) auto auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        borderTop: "1px solid var(--rule-soft)",
      }}
    >
      <span
        style={{
          color: tone.label,
          background: tone.bg,
          border: `1px solid ${tone.border}`,
          padding: "3px 7px",
          borderRadius: 3,
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          textAlign: "center",
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
          fontFamily: "var(--font-sans)",
          fontSize: 11,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {task.title}
      </span>
      <span
        style={{
          color: statusColor(status),
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {attempt?.status ?? task.status}
      </span>
      <span
        style={{
          color: "var(--muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {attempt ? formatDuration(attempt.startedAt, attempt.finishedAt) : "--:--"}
      </span>
    </div>
  );
}

function AttemptLine({ attempt }: { attempt: WorkerAttempt }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "92px minmax(0, 1fr) auto",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        borderTop: "1px solid var(--rule-soft)",
      }}
    >
      <span
        style={{
          color: runtimeTone(attempt.runtime).label,
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {attempt.runtime}
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
      >
        attempt {attempt.attemptNumber}
      </span>
      <span
        style={{
          color: attemptStatusColor(attempt.status),
          fontFamily: "var(--font-sans)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {attempt.status}
      </span>
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
        gridTemplateColumns: "68px 12px minmax(0, 1fr)",
        gap: 8,
        alignItems: "baseline",
        color: "var(--muted)",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        lineHeight: 1.5,
      }}
    >
      <span
        style={{
          color: attemptStatusColor(attempt.status),
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {time ? formatClock(time) : "--:--:--"}
      </span>
      <span
        style={{
          color: attemptStatusColor(attempt.status),
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
        }}
      >
        {">"}
      </span>
      <span
        title={text}
        style={{
          minWidth: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 11,
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
        height: 4,
        borderRadius: 999,
        background: "var(--rule-soft)",
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
          boxShadow: active ? "0 0 12px var(--accent-glow)" : undefined,
          transition: "width var(--motion) var(--ease-out)",
        }}
      />
    </div>
  );
}

function WorkStatusIcon({ status }: { status?: AgentStatusKind }) {
  const color = status ? statusColor(status) : "var(--muted)";
  const fill = status === "done" ? "var(--ok)" : status === "blocked" ? "var(--danger)" : "transparent";
  const filled = status === "done" || status === "blocked";
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 999,
        border: `1.4px solid ${color}`,
        background: fill,
        color: "var(--bg)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
        animation: status === "running" ? "spark-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    >
      {status === "done" && (
        <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden>
          <path
            d="M1.4 4.6 L3.6 6.8 L7.6 2.2"
            stroke="var(--bg)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {status === "blocked" && (
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden>
          <path
            d="M1.5 1.5 L6.5 6.5 M6.5 1.5 L1.5 6.5"
            stroke="var(--bg)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      )}
      {!filled && status === "running" && (
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
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
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
        padding: "3px 8px",
        borderRadius: 3,
        fontFamily: "var(--font-sans)",
        fontSize: 10,
        fontWeight: 600,
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

function EmptyState({
  text,
  heading,
  tone,
}: {
  text: string;
  heading?: string;
  tone?: "danger";
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        color: tone === "danger" ? "var(--danger)" : "var(--ink-dim)",
        fontFamily: "var(--font-sans)",
        gap: 8,
        padding: 32,
        textAlign: "center",
      }}
    >
      {heading && (
        <span
          style={{
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {heading}
        </span>
      )}
      <span
        style={{
          color: tone === "danger" ? "var(--danger)" : "var(--ink-dim)",
          fontFamily: "var(--font-sans)",
          fontSize: heading ? 13 : 14,
        }}
      >
        {text}
      </span>
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

import React, { useMemo } from "react";
import type { RunState } from "@shared/types";
import {
  agentRowsForStep,
  type AgentRow,
  promptGenerationTargetStepId,
  type RunMaps,
  sortSteps,
  stepFileCount,
} from "./run-format";
import {
  type Box,
  computeRunGraphLayout,
  END_H,
  END_W,
  SPARK_H,
  SPARK_W,
  STEP_H,
  STEP_W,
} from "./graph-layout";
import { GraphWires } from "./GraphWires";
import { EndNode, SparkNode, StepNode, WorkerNode } from "./GraphNodes";
import type { WorkerReport } from "@shared/types";

// Composes the run graph: the wire layer, then every node positioned
// absolutely over it from the shared layout model. When the run has no steps
// yet it renders the planning state — SPARK live, the spine forming.

interface Props {
  run: RunState;
  maps: RunMaps;
  reportByAttempt: ReadonlyMap<string, WorkerReport>;
  selectedStepId: string | null;
  selectedWorkerTaskId: string | null;
  onSelectStep: (id: string) => void;
  onSelectWorker: (id: string) => void;
}

// Absolute wrapper for one node — RunGraph positions, the node paints itself.
function NodeBox({
  box,
  z = 1,
  children,
}: {
  box: Box;
  z?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        zIndex: z,
      }}
    >
      {children}
    </div>
  );
}

export default function RunGraph({
  run,
  maps,
  reportByAttempt,
  selectedStepId,
  selectedWorkerTaskId,
  onSelectStep,
  onSelectWorker,
}: Props) {
  const orderedSteps = useMemo(() => sortSteps(run.steps), [run.steps]);

  // Worker rows per step — derived once so the layout and the nodes share the
  // exact same row identity (and the memoized nodes skip needless re-renders).
  const rowsByStep = useMemo(() => {
    const map = new Map<string, AgentRow[]>();
    orderedSteps.forEach((step, index) => {
      map.set(step.id, agentRowsForStep(step, maps.taskById, maps.attemptByTask, index + 1));
    });
    return map;
  }, [orderedSteps, maps]);

  const layout = useMemo(
    () => computeRunGraphLayout(orderedSteps, rowsByStep),
    [orderedSteps, rowsByStep],
  );
  const promptStepId = useMemo(() => promptGenerationTargetStepId(run), [run]);

  if (orderedSteps.length === 0) {
    return <PlanningGraph run={run} />;
  }

  return (
    <div style={{ position: "relative", width: layout.width, height: layout.height }}>
      <GraphWires
        layout={layout}
        steps={orderedSteps}
        maps={maps}
        promptStepId={promptStepId}
        runStatus={run.status}
      />

      <NodeBox box={layout.sparkBox}>
        <SparkNode runStatus={run.status} />
      </NodeBox>

      {layout.steps.map((stepLayout) => {
        const step = orderedSteps.find((candidate) => candidate.id === stepLayout.stepId);
        if (!step) return null;
        const rows = rowsByStep.get(step.id) ?? [];
        const stepSelected = selectedStepId === step.id;
        return (
          <React.Fragment key={step.id}>
            <NodeBox box={stepLayout.box} z={stepSelected ? 3 : 2}>
              <StepNode
                step={step}
                index={stepLayout.index}
                rows={rows}
                fileCount={stepFileCount(step, maps.attemptByTask, reportByAttempt)}
                active={step.id === run.currentStepId}
                selected={stepSelected}
                onSelect={() => onSelectStep(step.id)}
              />
            </NodeBox>
            {stepLayout.workers.map((workerLayout) => {
              const row = rows[workerLayout.agentIndex];
              if (!row) return null;
              const workerSelected =
                !!workerLayout.taskId && selectedWorkerTaskId === workerLayout.taskId;
              return (
                <NodeBox
                  key={workerLayout.rowKey}
                  box={workerLayout.box}
                  z={workerSelected ? 3 : 1}
                >
                  <WorkerNode
                    row={row}
                    stepStatus={step.status}
                    selected={workerSelected}
                    onSelect={() => {
                      if (workerLayout.taskId) onSelectWorker(workerLayout.taskId);
                    }}
                  />
                </NodeBox>
              );
            })}
          </React.Fragment>
        );
      })}

      <NodeBox box={layout.endBox}>
        <EndNode runStatus={run.status} />
      </NodeBox>
    </div>
  );
}

// ── Planning state ───────────────────────────────────────────────────────────

// While the run has no steps, the graph shows the spine forming: SPARK live on
// the left, skeleton step cards shimmering where the real steps will land,
// COMPLETE pending on the right.
function PlanningGraph({ run }: { run: RunState }) {
  const SKELETON = 2;
  const PAD = 56;
  const GAP = 134;
  const spineY = 150;

  const sparkBox: Box = { x: PAD, y: spineY - SPARK_H / 2, w: SPARK_W, h: SPARK_H };
  const skeletonBoxes: Box[] = [];
  let cursor = sparkBox.x + sparkBox.w + GAP;
  for (let i = 0; i < SKELETON; i++) {
    skeletonBoxes.push({ x: cursor, y: spineY - STEP_H / 2, w: STEP_W, h: STEP_H });
    cursor += STEP_W + GAP;
  }
  const endBox: Box = { x: cursor, y: spineY - END_H / 2, w: END_W, h: END_H };
  const width = endBox.x + endBox.w + PAD;
  const height = spineY + STEP_H / 2 + 80;

  const columns = [sparkBox, ...skeletonBoxes, endBox];
  const wires = columns.slice(0, -1).map((box, i) => {
    const next = columns[i + 1];
    const from = { x: box.x + box.w, y: box.y + box.h / 2 };
    const to = { x: next.x, y: next.y + next.h / 2 };
    const dx = Math.max(46, (to.x - from.x) * 0.5);
    return `M ${from.x},${from.y} C ${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
  });

  return (
    <div style={{ position: "relative", width, height }}>
      <svg
        aria-hidden
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: "absolute", top: 0, left: 0, overflow: "visible", pointerEvents: "none" }}
      >
        {wires.map((d, i) => (
          <g key={i}>
            <path
              d={d}
              fill="none"
              stroke="color-mix(in oklch, var(--accent) 30%, transparent)"
              strokeWidth={1.6}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {i === 0 && (
              <path
                d={d}
                className="spark-wire-flow"
                fill="none"
                stroke="var(--accent)"
                strokeWidth={1.9}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        ))}
      </svg>

      <NodeBox box={sparkBox}>
        <SparkNode runStatus={run.status} />
      </NodeBox>
      {skeletonBoxes.map((box, i) => (
        <NodeBox key={i} box={box}>
          <SkeletonStep index={i + 1} dim={i > 0} />
        </NodeBox>
      ))}
      <NodeBox box={endBox}>
        <EndNode runStatus={run.status} />
      </NodeBox>
    </div>
  );
}

function SkeletonStep({ index, dim }: { index: number; dim: boolean }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        borderRadius: 12,
        border: "1px dashed var(--rule)",
        background: "color-mix(in oklch, var(--panel) 64%, transparent)",
        opacity: dim ? 0.5 : 0.85,
        padding: "13px 15px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
        <span
          style={{
            width: 32,
            height: 32,
            borderRadius: 8,
            border: "1px dashed var(--rule-strong)",
            color: "var(--muted)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            fontWeight: 700,
          }}
        >
          {String(index).padStart(2, "0")}
        </span>
        <Shimmer width={150} height={9} />
      </div>
      <Shimmer width="100%" height={8} />
      <Shimmer width="76%" height={8} />
      <div style={{ marginTop: "auto", display: "flex", gap: 10 }}>
        <Shimmer width={64} height={8} />
        <Shimmer width={48} height={8} />
      </div>
    </div>
  );
}

function Shimmer({ width, height }: { width: number | string; height: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "block",
        width,
        height,
        borderRadius: 999,
        background:
          "linear-gradient(90deg, color-mix(in oklch, var(--ink) 5%, transparent) 0%, color-mix(in oklch, var(--ink) 13%, transparent) 50%, color-mix(in oklch, var(--ink) 5%, transparent) 100%)",
        backgroundSize: "220% 100%",
        animation: "spark-shimmer 2.1s ease-in-out infinite",
      }}
    />
  );
}

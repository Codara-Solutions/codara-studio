import React, { useMemo } from "react";
import type { RunState, StepState } from "@shared/types";
import type { RunGraphLayout, SpineWire, StepLayout } from "./graph-layout";
import { deriveAgentStatus, type RunMaps } from "./run-format";

// The wire layer. One SVG sized to the whole graph, drawn beneath the nodes:
// curved bezier spine wires between SPARK / steps / COMPLETE, and a trunk with
// rounded-corner ribs hanging the workers under each step. Every wire carries
// one of four states; the live path animates a flowing dash.

type WireState = "pending" | "done" | "active" | "blocked";

const WIRE_COLOR: Record<WireState, string> = {
  pending: "var(--rule)",
  done: "color-mix(in oklch, var(--ok) 58%, var(--rule-strong))",
  active: "var(--accent)",
  blocked: "var(--danger)",
};

interface Props {
  layout: RunGraphLayout;
  // Ordered steps — status lookup for wire state.
  steps: StepState[];
  maps: RunMaps;
  promptStepId?: string;
  runStatus: RunState["status"];
}

// Horizontal-flow cubic bezier: control handles pulled along x so the wire
// leaves and enters its ports flat and curves smoothly through the middle
// whenever the two ends sit at different heights (the spine's undulation).
function spinePath(wire: SpineWire): string {
  const { from, to } = wire;
  const dx = Math.max(46, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x},${from.y} C ${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
}

function spineWireState(
  wire: SpineWire,
  stepById: Map<string, StepState>,
  runStatus: RunState["status"],
  promptStepId?: string,
): WireState {
  const target = wire.targetStepId ? stepById.get(wire.targetStepId) : null;
  const source = wire.sourceStepId ? stepById.get(wire.sourceStepId) : null;
  if (target && (target.status === "blocked" || target.status === "failed")) return "blocked";
  if (target && (target.status === "running" || target.status === "reviewing")) return "active";
  if (wire.targetStepId && wire.targetStepId === promptStepId) return "active";
  // The wire leaving SPARK lights up while the manager is still planning.
  if (!wire.sourceStepId && runStatus === "planning") return "active";
  if (source && source.status === "complete") return "done";
  if (!wire.sourceStepId && runStatus !== "idle") return "done";
  if (!wire.targetStepId && runStatus === "complete") return "done";
  return "pending";
}

function stepWireState(status: StepState["status"]): WireState {
  if (status === "blocked" || status === "failed") return "blocked";
  if (status === "running" || status === "reviewing") return "active";
  if (status === "complete") return "done";
  return "pending";
}

// A single wire. The live state lays a flowing dashed stroke over a dim base
// so the spark reads as travelling along the path; the dash animation is a
// CSS keyframe, so prefers-reduced-motion collapses it for free.
function Wire({ d, state }: { d: string; state: WireState }) {
  if (state === "active") {
    return (
      <g>
        <path
          d={d}
          fill="none"
          stroke="color-mix(in oklch, var(--accent) 32%, transparent)"
          strokeWidth={1.6}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={d}
          className="spark-wire-flow"
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.9}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          style={{ filter: "drop-shadow(0 0 3px var(--accent-glow))" }}
        />
      </g>
    );
  }
  return (
    <path
      d={d}
      fill="none"
      stroke={WIRE_COLOR[state]}
      strokeWidth={state === "done" ? 1.7 : 1.5}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      style={
        state === "blocked"
          ? { filter: "drop-shadow(0 0 2px color-mix(in oklch, var(--danger) 38%, transparent))" }
          : state === "done"
            ? { opacity: 0.82 }
            : undefined
      }
    />
  );
}

// A connection point where a wire meets a node — the small detail that makes
// the graph read as wired nodes rather than free-floating cards.
function Port({ x, y, state }: { x: number; y: number; state: WireState }) {
  const color = WIRE_COLOR[state];
  return (
    <circle
      cx={x}
      cy={y}
      r={state === "active" ? 3.5 : 3.1}
      fill={state === "active" ? "color-mix(in oklch, var(--accent) 34%, var(--bg))" : "var(--bg)"}
      stroke={color}
      strokeWidth={1.4}
      vectorEffect="non-scaling-stroke"
      style={state === "active" ? { filter: "drop-shadow(0 0 3px var(--accent-glow))" } : undefined}
    />
  );
}

function GraphWiresImpl({ layout, steps, maps, promptStepId, runStatus }: Props) {
  const stepById = useMemo(() => {
    const map = new Map<string, StepState>();
    for (const step of steps) map.set(step.id, step);
    return map;
  }, [steps]);

  return (
    <svg
      aria-hidden
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      {/* Spine wires — SPARK -> steps -> COMPLETE. */}
      {layout.spineWires.map((wire) => {
        const state = spineWireState(wire, stepById, runStatus, promptStepId);
        return <Wire key={wire.id} d={spinePath(wire)} state={state} />;
      })}

      {/* Worker trunks + ribs. */}
      {layout.steps.map((stepLayout) => {
        if (stepLayout.workers.length === 0) return null;
        return (
          <WorkerBranch
            key={stepLayout.stepId}
            stepLayout={stepLayout}
            step={stepById.get(stepLayout.stepId)}
            maps={maps}
          />
        );
      })}

      {/* Ports — drawn last so they sit crisply on top of every wire end. */}
      {layout.spineWires.length > 0 && (
        <Port
          x={layout.sparkBox.x + layout.sparkBox.w}
          y={layout.sparkBox.y + layout.sparkBox.h / 2}
          state={runStatus === "idle" ? "pending" : "done"}
        />
      )}
      {layout.steps.map((stepLayout) => {
        const step = stepById.get(stepLayout.stepId);
        const state = step ? stepWireState(step.status) : "pending";
        return (
          <g key={`ports-${stepLayout.stepId}`}>
            <Port x={stepLayout.box.x} y={stepLayout.box.y + stepLayout.box.h / 2} state={state} />
            <Port
              x={stepLayout.box.x + stepLayout.box.w}
              y={stepLayout.box.y + stepLayout.box.h / 2}
              state={step?.status === "complete" ? "done" : state}
            />
          </g>
        );
      })}
      <Port
        x={layout.endBox.x}
        y={layout.endBox.y + layout.endBox.h / 2}
        state={runStatus === "complete" ? "done" : runStatus === "failed" ? "blocked" : "pending"}
      />
    </svg>
  );
}

// The trunk + ribs for one step's worker column.
function WorkerBranch({
  stepLayout,
  step,
  maps,
}: {
  stepLayout: StepLayout;
  step?: StepState;
  maps: RunMaps;
}) {
  const { trunkX, box, workers } = stepLayout;
  const stepStatus = step?.status ?? "queued";
  const trunkState = stepWireState(stepStatus);
  const lastWorker = workers[workers.length - 1];
  const trunkTop = box.y + box.h;
  const trunkBottom = lastWorker.box.y + lastWorker.box.h / 2;
  const corner = 12;

  return (
    <g>
      <Wire d={`M ${trunkX},${trunkTop} L ${trunkX},${trunkBottom}`} state={trunkState} />
      {workers.map((worker) => {
        const wcy = worker.box.y + worker.box.h / 2;
        const task = worker.taskId ? maps.taskById.get(worker.taskId) : undefined;
        const attempt = worker.taskId ? maps.attemptByTask.get(worker.taskId) : undefined;
        const agentStatus = deriveAgentStatus(task, attempt, stepStatus);
        const ribState: WireState =
          agentStatus === "running"
            ? "active"
            : agentStatus === "done"
              ? "done"
              : agentStatus === "blocked"
                ? "blocked"
                : "pending";
        return (
          <g key={worker.rowKey}>
            <Wire
              d={`M ${trunkX},${wcy - corner} Q ${trunkX},${wcy} ${trunkX + corner},${wcy} L ${worker.box.x},${wcy}`}
              state={ribState}
            />
            <Port x={worker.box.x} y={wcy} state={ribState} />
          </g>
        );
      })}
    </g>
  );
}

export const GraphWires = React.memo(GraphWiresImpl);
export default GraphWires;

import React, { useMemo } from "react";
import type { RunState, StepState } from "@shared/types";
import type { FanWire, RunGraphLayout, SpineWire } from "./graph-layout";
import { deriveAgentStatus, type RunMaps } from "./run-format";

// The wire layer. One SVG sized to the whole graph, drawn beneath the nodes:
// curved bezier spine wires running SPARK to step to COMPLETE, and one fan
// wire per worker branching out of its step into the near edge of the card,
// each parallel agent's branch lighting up independently, so a running batch
// reads as simultaneous live lanes hanging under the line. Every wire carries
// one of five states; only the live path animates a flowing dash.
//
// `paused` is what an otherwise-active wire becomes while the user has the run
// paused: the lane keeps its place in the picture, but nothing about it may
// suggest work is still travelling along it.
type WireState = "pending" | "done" | "active" | "blocked" | "paused";

const WIRE_COLOR: Record<WireState, string> = {
  pending: "var(--rule)",
  done: "color-mix(in oklch, var(--ok) 58%, var(--rule-strong))",
  active: "var(--accent)",
  blocked: "var(--danger)",
  paused: "color-mix(in oklch, var(--info) 60%, var(--rule-strong))",
};

// The dash flow collapses via CSS for prefers-reduced-motion; the travelling
// dot is SMIL, so it needs an explicit gate. Snapshot at load — a live
// listener is not worth the churn for an accessibility preference.
const REDUCE_MOTION =
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

interface Props {
  layout: RunGraphLayout;
  // Ordered steps — status lookup for wire state.
  steps: StepState[];
  maps: RunMaps;
  promptStepId?: string;
  runStatus: RunState["status"];
}

// Cubic bezier between two ports. The spine flows horizontally, handles
// pulled along x so the wire leaves and enters flat. A fan wire drops out of
// a step's bottom edge and turns into the side of a worker card, so it leaves
// along y and arrives along x: the branch reads as a bracket down the stack
// rather than a diagonal across it.
function flowPath(wire: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  enter?: "left" | "right";
}): string {
  const { from, to } = wire;
  if (wire.enter) {
    const dy = Math.max(30, (to.y - from.y) * 0.55);
    const reach = Math.max(34, Math.abs(to.x - from.x) * 0.55);
    const dx = wire.enter === "right" ? -reach : reach;
    return `M ${from.x},${from.y} C ${from.x},${from.y + dy} ${to.x + dx},${to.y} ${to.x},${to.y}`;
  }
  const dx = Math.max(46, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x},${from.y} C ${from.x + dx},${from.y} ${to.x - dx},${to.y} ${to.x},${to.y}`;
}

// A paused run has no travelling work, so no wire may animate. Everything that
// would have read as live settles into the quiet paused tone instead.
function settleWhilePaused(state: WireState, runPaused: boolean): WireState {
  return runPaused && state === "active" ? "paused" : state;
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
// CSS keyframe, so prefers-reduced-motion collapses it for free. `emphasis`
// (active worker lanes) widens the stroke and adds a travelling dot so the
// working branch is unmistakable; `dimmed` recedes a running step's still-
// pending sibling lanes so contrast, not just hue, carries the signal.
function Wire({
  d,
  state,
  emphasis = false,
  dimmed = false,
}: {
  d: string;
  state: WireState;
  emphasis?: boolean;
  dimmed?: boolean;
}) {
  if (state === "active") {
    return (
      <g>
        <path
          d={d}
          fill="none"
          stroke="color-mix(in oklch, var(--accent) 32%, transparent)"
          strokeWidth={emphasis ? 2.5 : 1.6}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={d}
          className="spark-wire-flow"
          fill="none"
          stroke="var(--accent)"
          strokeWidth={emphasis ? 2.5 : 1.9}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {emphasis && !REDUCE_MOTION && (
          <circle r={2.4} fill="var(--accent)">
            <animateMotion dur="2.6s" repeatCount="indefinite" path={d} />
          </circle>
        )}
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
      style={dimmed ? { opacity: 0.55 } : state === "done" ? { opacity: 0.82 } : undefined}
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
    />
  );
}

function GraphWiresImpl({ layout, steps, maps, promptStepId, runStatus }: Props) {
  const stepById = useMemo(() => {
    const map = new Map<string, StepState>();
    for (const step of steps) map.set(step.id, step);
    return map;
  }, [steps]);
  const runPaused = runStatus === "paused";

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
      {/* Spine wires — links with no fan between them. */}
      {layout.spineWires.map((wire) => {
        const state = settleWhilePaused(
          spineWireState(wire, stepById, runStatus, promptStepId),
          runPaused,
        );
        return <Wire key={wire.id} d={flowPath(wire)} state={state} />;
      })}

      {/* Fan wires: one branch per parallel worker lane, dropping out of the
          step into the near edge of its card. The working lanes render last in
          their own group so they paint on top of idle siblings; pending lanes
          of a running step recede. */}
      {layout.fanWires.map((wire) => {
        const step = stepById.get(wire.stepId);
        const state = settleWhilePaused(fanWireState(wire, step, maps), runPaused);
        if (state === "active") return null;
        const stepLive =
          !runPaused && (step?.status === "running" || step?.status === "reviewing");
        return (
          <Wire
            key={wire.id}
            d={flowPath(wire)}
            state={state}
            dimmed={stepLive && state === "pending"}
          />
        );
      })}
      <g>
        {layout.fanWires.map((wire) => {
          const state = settleWhilePaused(
            fanWireState(wire, stepById.get(wire.stepId), maps),
            runPaused,
          );
          if (state !== "active") return null;
          return <Wire key={wire.id} d={flowPath(wire)} state="active" emphasis />;
        })}
      </g>

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
        const state = settleWhilePaused(
          step ? stepWireState(step.status) : "pending",
          runPaused,
        );
        return (
          <g key={`ports-${stepLayout.stepId}`}>
            <Port x={stepLayout.box.x} y={stepLayout.box.y + stepLayout.box.h / 2} state={state} />
            <Port
              x={stepLayout.box.x + stepLayout.box.w}
              y={stepLayout.box.y + stepLayout.box.h / 2}
              state={step?.status === "complete" ? "done" : state}
            />
            {/* The delegation port: where every branch leaves the step.
                Only drawn when the step actually has workers hanging off it. */}
            {stepLayout.workers.length > 0 && (
              <Port
                x={stepLayout.box.x + stepLayout.box.w / 2}
                y={stepLayout.box.y + stepLayout.box.h}
                state={state}
              />
            )}
            {stepLayout.workers.map((worker) => {
              const task = worker.taskId ? maps.taskById.get(worker.taskId) : undefined;
              const attempt = worker.taskId ? maps.attemptByTask.get(worker.taskId) : undefined;
              const agentStatus = deriveAgentStatus(task, attempt, step?.status ?? "queued");
              const laneState: WireState =
                agentStatus === "running"
                  ? "active"
                  : agentStatus === "done"
                    ? "done"
                    : agentStatus === "blocked"
                      ? "blocked"
                      : "pending";
              // The port rides the layout's own entry point, so it lands on the
              // card edge the branch actually arrives at on either side.
              return (
                <Port
                  key={`wports-${worker.rowKey}`}
                  x={worker.port.x}
                  y={worker.port.y}
                  state={settleWhilePaused(laneState, runPaused)}
                />
              );
            })}
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

// State for one worker's branch: it mirrors the agent's live state, so a
// running agent's branch flows, a finished one sits lit, a blocked one goes
// red — each satellite independent of its siblings.
function fanWireState(wire: FanWire, step: StepState | undefined, maps: RunMaps): WireState {
  const stepStatus = step?.status ?? "queued";
  const task = wire.taskId ? maps.taskById.get(wire.taskId) : undefined;
  const attempt = wire.taskId ? maps.attemptByTask.get(wire.taskId) : undefined;
  const agentStatus = deriveAgentStatus(task, attempt, stepStatus);
  if (agentStatus === "running") return "active";
  if (agentStatus === "done") return "done";
  if (agentStatus === "blocked") return "blocked";
  return "pending";
}

export const GraphWires = React.memo(GraphWiresImpl);
export default GraphWires;

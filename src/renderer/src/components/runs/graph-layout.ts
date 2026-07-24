/**
 * The run graph's coordinate model.
 *
 * One pure function turns a run's ordered steps + worker rows into absolute
 * box geometry: the SPARK origin and a straight left-to-right spine running
 * SPARK → step → step → COMPLETE, with each step's parallel workers orbiting
 * it as satellites — alternating above and below the spine to the step's
 * right, outer lanes eased back so the fan wraps the step like a bracket.
 * A worker connects only to its own step (one branch per agent); the spine
 * itself always links a step to its left and right neighbours, threading the
 * clear channel the orbit leaves around the centreline. Nodes are placed
 * absolutely and the wire layer draws from these same boxes, so the graph
 * reads as one connected object.
 */
import type { StepState } from "@shared/types";
import type { AgentRow } from "./run-format";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface WorkerLayout {
  // Stable key — the task id when the worker is queued, else an agent slot id.
  rowKey: string;
  // Present only once the worker has a task; absent workers are not selectable.
  taskId?: string;
  agentIndex: number;
  box: Box;
}

export interface StepLayout {
  stepId: string;
  // 1-based display index.
  index: number;
  box: Box;
  workers: WorkerLayout[];
}

export interface SpineWire {
  id: string;
  from: Point;
  to: Point;
  // null source => the wire leaves SPARK; null target => it enters COMPLETE.
  sourceStepId: string | null;
  targetStepId: string | null;
}

// One branch of a step's parallel fan: it leaves the step for a worker and
// ends there — a worker is a satellite of its step, not a stop on the spine.
// Wire state is derived per-worker so each parallel lane lights independently.
export interface FanWire {
  id: string;
  from: Point;
  to: Point;
  stepId: string;
  rowKey: string;
  taskId?: string;
}

export interface RunGraphLayout {
  sparkBox: Box;
  steps: StepLayout[];
  endBox: Box;
  spineWires: SpineWire[];
  fanWires: FanWire[];
  width: number;
  height: number;
}

// ── Node dimensions (exported so the renderers paint at the laid-out size) ──
export const SPARK_W = 122;
export const SPARK_H = 98;
export const STEP_W = 304;
export const STEP_H = 164;
export const WORKER_W = 258;
export const WORKER_H = 82;
export const END_W = 132;
export const END_H = 86;

// ── Spacing ─────────────────────────────────────────────────────────────────
const COL_GAP = 134; // horizontal wire run between spine columns
const FAN_GAP = 96; // horizontal wire run for a fan-out / fan-in sweep
const PAD_X = 56; // canvas padding before SPARK / after COMPLETE
const WORKER_GAP = 18; // vertical gap between parallel worker lanes
const TOP_PAD = 70;
const BOTTOM_PAD = 80;
// One orbit lane's vertical pitch — a worker card plus its gap.
const LANE_UNIT = WORKER_H + WORKER_GAP;
// How far the outermost orbit lanes pull back toward their step, and the
// shortest horizontal wire run they may leave. Together these bend a fan of
// 3+ workers into a bracket wrapping the step instead of a flat column.
const ORBIT_INSET = 56;
const MIN_FAN_RUN = 44;
// Clear vertical corridor the orbit leaves around the spine centreline so the
// step-to-step wire threads between the upper and lower worker cards instead
// of clipping their edges.
const SPINE_CHANNEL = 48;

export function boxCenter(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function rightPort(box: Box): Point {
  return { x: box.x + box.w, y: box.y + box.h / 2 };
}

function leftPort(box: Box): Point {
  return { x: box.x, y: box.y + box.h / 2 };
}

// The y-offset of each worker lane's centre from the spine. Lanes alternate
// above/below in half-lane steps offset past the spine channel: the first
// pair straddles the corridor, later pairs orbit further out, and a lone
// worker sits above the spine so even a single-agent step reads as
// delegation off the line, not a widening of it.
function laneOffsets(count: number): number[] {
  const offsets: number[] = [];
  for (let j = 0; j < count; j++) {
    const magnitude = (Math.floor(j / 2) + 0.5) * LANE_UNIT + SPINE_CHANNEL / 2;
    offsets.push(j % 2 === 0 ? -magnitude : magnitude);
  }
  return offsets;
}

// How far a step's orbit rises above the spine (to the top edge of its
// highest worker card). Above always leads below by one lane for odd counts.
function orbitRise(count: number): number {
  if (count === 0) return 0;
  return (Math.ceil(count / 2) - 0.5) * LANE_UNIT + SPINE_CHANNEL / 2 + WORKER_H / 2;
}

/**
 * Lay the whole graph out. Steps run left to right on a straight spine; each
 * step's workers orbit it — alternating above and below the spine to the
 * step's right, outer lanes eased back toward the step — and every lane fans
 * back in to the next spine node, so a batch of three agents reads as three
 * simultaneous branches bracketing their step. The orchestration is the
 * picture. A step with no workers connects straight through.
 */
export function computeRunGraphLayout(
  steps: StepState[],
  rowsByStep: ReadonlyMap<string, readonly AgentRow[]>,
): RunGraphLayout {
  // Spine centreline — deep enough that the tallest orbit's upper lanes
  // still clear the top padding.
  const maxRise = steps.reduce(
    (max, step) => Math.max(max, orbitRise((rowsByStep.get(step.id) ?? []).length)),
    0,
  );
  const spineY = TOP_PAD + Math.max(STEP_H / 2, maxRise);

  const sparkBox: Box = {
    x: PAD_X,
    y: spineY - SPARK_H / 2,
    w: SPARK_W,
    h: SPARK_H,
  };

  const stepLayouts: StepLayout[] = [];
  let cursorX = sparkBox.x + sparkBox.w + COL_GAP;

  steps.forEach((step, i) => {
    const box: Box = {
      x: cursorX,
      y: spineY - STEP_H / 2,
      w: STEP_W,
      h: STEP_H,
    };
    const rows = rowsByStep.get(step.id) ?? [];
    const offsets = laneOffsets(rows.length);
    const maxOffset = offsets.reduce((max, offset) => Math.max(max, Math.abs(offset)), 0);
    const lanesX = box.x + box.w + FAN_GAP;
    const workers: WorkerLayout[] = rows.map((row, j) => {
      const offsetY = offsets[j];
      // Elliptical inset: the further a lane orbits from the spine, the more
      // it eases back toward the step — the fan wraps rather than towers.
      const ratio = maxOffset > 0 ? Math.abs(offsetY) / maxOffset : 0;
      const laneX = Math.max(box.x + box.w + MIN_FAN_RUN, lanesX - ORBIT_INSET * ratio * ratio);
      return {
        rowKey: row.task?.id ?? `${step.id}:agent:${j}`,
        taskId: row.task?.id,
        agentIndex: j,
        box: {
          x: laneX,
          y: spineY + offsetY - WORKER_H / 2,
          w: WORKER_W,
          h: WORKER_H,
        },
      };
    });
    stepLayouts.push({ stepId: step.id, index: i + 1, box, workers });
    const fanRight = workers.reduce((max, worker) => Math.max(max, worker.box.x + worker.box.w), 0);
    cursorX = rows.length > 0 ? fanRight + FAN_GAP : box.x + box.w + COL_GAP;
  });

  const endBox: Box = {
    x: cursorX,
    y: spineY - END_H / 2,
    w: END_W,
    h: END_H,
  };

  // Wires. The spine always links every adjacent pair of spine nodes —
  // SPARK -> step 1 -> ... -> COMPLETE — so the flow of the run is one
  // unbroken line through the steps. Fan wires branch a step to each of its
  // workers and stop there: agents are satellites of the step they belong
  // to, never stops on the spine.
  const spineWires: SpineWire[] = [];
  const fanWires: FanWire[] = [];
  if (stepLayouts.length === 0) {
    spineWires.push({
      id: "spark-end",
      from: rightPort(sparkBox),
      to: leftPort(endBox),
      sourceStepId: null,
      targetStepId: null,
    });
  } else {
    spineWires.push({
      id: `spark-${stepLayouts[0].stepId}`,
      from: rightPort(sparkBox),
      to: leftPort(stepLayouts[0].box),
      sourceStepId: null,
      targetStepId: stepLayouts[0].stepId,
    });
    stepLayouts.forEach((layout, i) => {
      const next = stepLayouts[i + 1];
      const nextBox = next ? next.box : endBox;
      const nextStepId = next ? next.stepId : null;
      spineWires.push({
        id: `${layout.stepId}-${nextStepId ?? "end"}`,
        from: rightPort(layout.box),
        to: leftPort(nextBox),
        sourceStepId: layout.stepId,
        targetStepId: nextStepId,
      });
      for (const worker of layout.workers) {
        fanWires.push({
          id: `out:${layout.stepId}:${worker.rowKey}`,
          from: rightPort(layout.box),
          to: leftPort(worker.box),
          stepId: layout.stepId,
          rowKey: worker.rowKey,
          taskId: worker.taskId,
        });
      }
    });
  }

  // Content extent — the lowest point is whichever orbit's below-spine lane
  // (or the bare step / terminal) reaches deepest. Lanes alternate sides, so
  // every worker box is checked, not just the last one.
  let maxBottom = Math.max(sparkBox.y + sparkBox.h, endBox.y + endBox.h);
  for (const layout of stepLayouts) {
    let bottom = layout.box.y + layout.box.h;
    for (const worker of layout.workers) {
      bottom = Math.max(bottom, worker.box.y + worker.box.h);
    }
    if (bottom > maxBottom) maxBottom = bottom;
  }

  return {
    sparkBox,
    steps: stepLayouts,
    endBox,
    spineWires,
    fanWires,
    width: endBox.x + endBox.w + PAD_X,
    height: maxBottom + BOTTOM_PAD,
  };
}

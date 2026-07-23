/**
 * The run graph's coordinate model.
 *
 * One pure function turns a run's ordered steps + worker rows into absolute
 * box geometry: the SPARK origin, an undulating left-to-right spine of step
 * nodes, a worker trunk hanging under each step, and the COMPLETE terminal.
 * Nodes are placed absolutely and the wire layer draws from these same boxes,
 * so the graph reads as one connected object rather than a grid of cards.
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
  // x of the vertical worker trunk dropping out of the step.
  trunkX: number;
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

export interface RunGraphLayout {
  sparkBox: Box;
  steps: StepLayout[];
  endBox: Box;
  spineWires: SpineWire[];
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
const PAD_X = 56; // canvas padding before SPARK / after COMPLETE
const UNDULATE = 0; // straight spine baseline; worker stacks provide the vertical rhythm
const TRUNK_INSET = 42; // worker trunk x, measured from the step's left edge
const RIB_RUN = 18; // horizontal gap from the trunk to a worker's left edge
const WORKER_TOP_GAP = 32; // gap from the step's bottom edge to the first worker
const WORKER_GAP = 14; // vertical gap between stacked workers
const TOP_PAD = 70;
const BOTTOM_PAD = 80;

export function boxCenter(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function rightPort(box: Box): Point {
  return { x: box.x + box.w, y: box.y + box.h / 2 };
}

function leftPort(box: Box): Point {
  return { x: box.x, y: box.y + box.h / 2 };
}

/**
 * Lay the whole graph out. Steps run left to right on a spine that alternates
 * a small amount above / below its centreline so the connecting wires are
 * genuine curves; each step's workers stack straight down under a trunk that
 * never leaves the step's own horizontal footprint, so a tall worker column
 * can never collide with the next step.
 */
export function computeRunGraphLayout(
  steps: StepState[],
  rowsByStep: ReadonlyMap<string, readonly AgentRow[]>,
): RunGraphLayout {
  // Spine centreline — pushed down far enough that the highest step (offset
  // -UNDULATE) still clears the top padding.
  const spineY = TOP_PAD + UNDULATE + STEP_H / 2;

  const sparkBox: Box = {
    x: PAD_X,
    y: spineY - SPARK_H / 2,
    w: SPARK_W,
    h: SPARK_H,
  };

  const stepLayouts: StepLayout[] = [];
  let cursorX = sparkBox.x + sparkBox.w + COL_GAP;

  steps.forEach((step, i) => {
    const offsetY = steps.length <= 1 ? 0 : i % 2 === 0 ? -UNDULATE : UNDULATE;
    const box: Box = {
      x: cursorX,
      y: spineY + offsetY - STEP_H / 2,
      w: STEP_W,
      h: STEP_H,
    };
    const trunkX = box.x + TRUNK_INSET;
    const rows = rowsByStep.get(step.id) ?? [];
    const workers: WorkerLayout[] = rows.map((row, j) => ({
      rowKey: row.task?.id ?? `${step.id}:agent:${j}`,
      taskId: row.task?.id,
      agentIndex: j,
      box: {
        x: trunkX + RIB_RUN,
        y: box.y + box.h + WORKER_TOP_GAP + j * (WORKER_H + WORKER_GAP),
        w: WORKER_W,
        h: WORKER_H,
      },
    }));
    stepLayouts.push({ stepId: step.id, index: i + 1, box, trunkX, workers });
    cursorX += STEP_W + COL_GAP;
  });

  const endBox: Box = {
    x: cursorX,
    y: spineY - END_H / 2,
    w: END_W,
    h: END_H,
  };

  // Spine wires: SPARK -> step0 -> ... -> stepN -> COMPLETE. With no steps the
  // spine is a single SPARK -> COMPLETE link.
  const spineWires: SpineWire[] = [];
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
    for (let i = 0; i < stepLayouts.length - 1; i++) {
      spineWires.push({
        id: `${stepLayouts[i].stepId}-${stepLayouts[i + 1].stepId}`,
        from: rightPort(stepLayouts[i].box),
        to: leftPort(stepLayouts[i + 1].box),
        sourceStepId: stepLayouts[i].stepId,
        targetStepId: stepLayouts[i + 1].stepId,
      });
    }
    const last = stepLayouts[stepLayouts.length - 1];
    spineWires.push({
      id: `${last.stepId}-end`,
      from: rightPort(last.box),
      to: leftPort(endBox),
      sourceStepId: last.stepId,
      targetStepId: null,
    });
  }

  // Content extent — the lowest point is whichever step's worker column (or
  // the bare step / terminal) reaches deepest.
  let maxBottom = Math.max(sparkBox.y + sparkBox.h, endBox.y + endBox.h);
  for (const layout of stepLayouts) {
    const lastWorker = layout.workers[layout.workers.length - 1];
    const bottom = lastWorker
      ? lastWorker.box.y + lastWorker.box.h
      : layout.box.y + layout.box.h;
    if (bottom > maxBottom) maxBottom = bottom;
  }

  return {
    sparkBox,
    steps: stepLayouts,
    endBox,
    spineWires,
    width: endBox.x + endBox.w + PAD_X,
    height: maxBottom + BOTTOM_PAD,
  };
}

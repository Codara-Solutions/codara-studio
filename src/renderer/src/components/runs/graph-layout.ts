/**
 * The run graph's coordinate model.
 *
 * One pure function turns a run's ordered steps + worker rows into absolute
 * box geometry: the SPARK origin and a straight left-to-right spine running
 * SPARK → step → step → COMPLETE, with each step's workers hanging *beneath*
 * it like tentacles, a rank centred under the step, the outermost drooping
 * furthest so the fan curves instead of sitting as a flat row. The shape is
 * the org chart: Cora orchestrates along the spine, and the teammates it
 * delegates to hang off the step they belong to. A worker connects only to
 * its own step (one branch per agent, leaving the step's bottom edge and
 * entering the worker's top edge); the spine runs clear above the whole fan.
 * Nodes are placed absolutely and the wire layer draws from these same boxes,
 * so the graph reads as one connected object.
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

// One branch of a step's parallel fan: it leaves the step's bottom edge for a
// worker's top edge and ends there, a worker is a satellite of its step, not
// a stop on the spine. Wire state is derived per-worker so each parallel lane
// lights independently. `axis: "v"` tells the wire layer to curve with
// vertical tangents; the spine's horizontal wires leave it unset.
export interface FanWire {
  id: string;
  from: Point;
  to: Point;
  axis: "v";
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
const PAD_X = 56; // canvas padding before SPARK / after COMPLETE
const TOP_PAD = 70;
const BOTTOM_PAD = 80;
// The tentacle drop, clear vertical wire run from a step's bottom edge to
// the top of its worker cards.
const WORKER_DROP = 74;
// Extra droop taken by the outermost tentacles, eased quadratically from the
// centre of the fan. This is what bends a rank of workers into a curve, so a
// batch reads as a fan hanging off the step rather than a flat table row.
const WORKER_ARC = 30;
// Horizontal gap between sibling worker cards in one step's fan.
const WORKER_GAP = 26;

export function boxCenter(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function rightPort(box: Box): Point {
  return { x: box.x + box.w, y: box.y + box.h / 2 };
}

function leftPort(box: Box): Point {
  return { x: box.x, y: box.y + box.h / 2 };
}

function bottomPort(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y + box.h };
}

function topPort(box: Box): Point {
  return { x: box.x + box.w / 2, y: box.y };
}

// Total width a step's fan of workers occupies. A fan wider than the step
// overhangs it evenly on both sides, which the column cursor pays for.
function fanSpan(count: number): number {
  if (count === 0) return 0;
  return count * WORKER_W + (count - 1) * WORKER_GAP;
}

// How far the j-th tentacle of a fan of `count` droops below the shortest
// one, 0 at the centre, WORKER_ARC at the outermost edge.
function tentacleDroop(index: number, count: number): number {
  const last = count - 1;
  if (last <= 0) return 0;
  const spread = Math.abs(index - last / 2) / (last / 2);
  return WORKER_ARC * spread * spread;
}

/**
 * Lay the whole graph out. Steps run left to right on a straight spine; each
 * step's workers hang beneath it as a centred fan, the outermost drooping
 * furthest, so a batch of three agents reads as three tentacles off the step
 * they belong to. The orchestration is the picture: the spine is Cora's line
 * of control, everything below it is delegated work. A step with no workers
 * connects straight through.
 */
export function computeRunGraphLayout(
  steps: StepState[],
  rowsByStep: ReadonlyMap<string, readonly AgentRow[]>,
): RunGraphLayout {
  // Spine centreline. Workers hang below it now, so nothing above the steps
  // competes for room, the fan's depth is paid for in `height` instead.
  const spineY = TOP_PAD + STEP_H / 2;

  const sparkBox: Box = {
    x: PAD_X,
    y: spineY - SPARK_H / 2,
    w: SPARK_W,
    h: SPARK_H,
  };

  const stepLayouts: StepLayout[] = [];
  let cursorX = sparkBox.x + sparkBox.w + COL_GAP;

  steps.forEach((step, i) => {
    const rows = rowsByStep.get(step.id) ?? [];
    // A fan wider than its step overhangs both sides evenly. Push the step in
    // by the overhang so the leftmost worker still clears the previous
    // column, and pay for the right overhang when advancing the cursor.
    const overhang = Math.max(0, (fanSpan(rows.length) - STEP_W) / 2);
    const box: Box = {
      x: cursorX + overhang,
      y: spineY - STEP_H / 2,
      w: STEP_W,
      h: STEP_H,
    };
    const fanLeft = box.x + box.w / 2 - fanSpan(rows.length) / 2;
    const workers: WorkerLayout[] = rows.map((row, j) => ({
      rowKey: row.task?.id ?? `${step.id}:agent:${j}`,
      taskId: row.task?.id,
      agentIndex: j,
      box: {
        x: fanLeft + j * (WORKER_W + WORKER_GAP),
        y: box.y + box.h + WORKER_DROP + tentacleDroop(j, rows.length),
        w: WORKER_W,
        h: WORKER_H,
      },
    }));
    stepLayouts.push({ stepId: step.id, index: i + 1, box, workers });
    cursorX = box.x + box.w + overhang + COL_GAP;
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
          from: bottomPort(layout.box),
          to: topPort(worker.box),
          axis: "v",
          stepId: layout.stepId,
          rowKey: worker.rowKey,
          taskId: worker.taskId,
        });
      }
    });
  }

  // Content extent. The deepest point is whichever tentacle droops furthest
  // (outer ones hang lower, so every worker box is checked, not just the
  // last). The rightmost is normally COMPLETE, but a wide fan under the final
  // step can reach past it, the canvas fits to these numbers, so anything
  // missed here would be silently cropped out of the view.
  let maxBottom = Math.max(sparkBox.y + sparkBox.h, endBox.y + endBox.h);
  let maxRight = endBox.x + endBox.w;
  for (const layout of stepLayouts) {
    let bottom = layout.box.y + layout.box.h;
    for (const worker of layout.workers) {
      bottom = Math.max(bottom, worker.box.y + worker.box.h);
      maxRight = Math.max(maxRight, worker.box.x + worker.box.w);
    }
    if (bottom > maxBottom) maxBottom = bottom;
  }

  return {
    sparkBox,
    steps: stepLayouts,
    endBox,
    spineWires,
    fanWires,
    width: maxRight + PAD_X,
    height: maxBottom + BOTTOM_PAD,
  };
}

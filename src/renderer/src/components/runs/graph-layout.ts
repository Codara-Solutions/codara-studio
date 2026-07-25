/**
 * The run graph's coordinate model.
 *
 * One pure function turns a run's ordered steps + worker rows into absolute
 * box geometry: the SPARK origin and a straight left-to-right spine running
 * SPARK, step, step, COMPLETE, with each step's workers hanging *beneath* it
 * as a vertical stack. The shape is the org chart: Cora orchestrates along the
 * spine, and the teammates it delegates to hang off the step they belong to.
 *
 * Workers stack DOWNWARD, not sideways. A rank of five worker cards laid out
 * in a row is ~1400px wide, which pushed every later step off screen and left
 * the canvas' vertical space empty. Stacked, the same five cost 150px of extra
 * width and spend the height the canvas already has. Each worker connects only
 * to its own step: the branch leaves the step's bottom edge and enters the
 * near vertical edge of the card, so the branches nest like a bracket instead
 * of crossing the cards below them. Past COLUMN_SPLIT_AT workers the stack
 * splits into two mirrored columns (left column first, reading top-down, then
 * the right) so a very wide batch does not become a very tall one.
 *
 * The spine runs clear above the whole fan. Nodes are placed absolutely and
 * the wire layer draws from these same boxes, so the graph reads as one
 * connected object.
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

// Which side of its step's centreline a worker card sits on. A one-column fan
// is always "right"; a split fan mirrors, so both columns are entered from the
// centre and neither branch crosses the other column's cards.
export type FanSide = "left" | "right";

export interface WorkerLayout {
  // Stable key: the task id when the worker is queued, else an agent slot id.
  rowKey: string;
  // Present only once the worker has a task; absent workers are not selectable.
  taskId?: string;
  agentIndex: number;
  box: Box;
  side: FanSide;
  // Where this worker's branch lands: the midpoint of the card edge facing the
  // step's centreline. The wire layer draws its port here too, so the wire and
  // the port can never disagree about where the branch meets the card.
  port: Point;
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
// worker's near edge and ends there, a worker is a satellite of its step, not
// a stop on the spine. Wire state is derived per-worker so each parallel lane
// lights independently. `enter` names the card edge the branch arrives at, so
// the wire layer can leave the step vertically and turn into the card
// horizontally; the spine's straight horizontal wires leave it unset.
export interface FanWire {
  id: string;
  from: Point;
  to: Point;
  enter: FanSide;
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
// Clear vertical wire run from a step's bottom edge to the top of the first
// worker card in its stack, room for the branch to turn out of the step.
const WORKER_DROP = 52;
// Vertical gap between stacked sibling worker cards in one step's fan.
const WORKER_V_GAP = 16;
// Horizontal clearance from the step's centreline (where the branches leave)
// to the near edge of a worker column. This is the bracket's elbow room.
const FAN_INDENT = 46;
// Past this many workers one column would out-run the canvas' height, so the
// stack splits into two mirrored columns.
const COLUMN_SPLIT_AT = 6;

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

// Where each worker of a fan of `count` sits: which column, and how far down
// it. One column hangs to the right of the step's centreline; a fan past the
// split threshold mirrors into two, filling the left column top-down first so
// it reads like any two-column layout.
function fanSlots(count: number): Array<{ side: FanSide; row: number }> {
  if (count <= 0) return [];
  if (count <= COLUMN_SPLIT_AT) {
    return Array.from({ length: count }, (_, index) => ({ side: "right" as const, row: index }));
  }
  const leftCount = Math.ceil(count / 2);
  return Array.from({ length: count }, (_, index) =>
    index < leftCount
      ? { side: "left" as const, row: index }
      : { side: "right" as const, row: index - leftCount },
  );
}

// How far a step's fan reaches past the step box on either side. The column
// cursor pays for both, so a stack can never sit on top of its neighbours.
function fanOverhang(slots: ReadonlyArray<{ side: FanSide }>): {
  left: number;
  right: number;
} {
  const armReach = FAN_INDENT + WORKER_W - STEP_W / 2;
  return {
    left: slots.some((slot) => slot.side === "left") ? Math.max(0, armReach) : 0,
    right: slots.some((slot) => slot.side === "right") ? Math.max(0, armReach) : 0,
  };
}

/**
 * Lay the whole graph out. Steps run left to right on a straight spine; each
 * step's workers hang beneath it as a vertical stack, so a batch of five
 * agents reads as five branches off the step they belong to rather than a
 * flat row wider than the viewport. The orchestration is the picture: the
 * spine is Cora's line of control, everything below it is delegated work. A
 * step with no workers connects straight through.
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
    const slots = fanSlots(rows.length);
    const overhang = fanOverhang(slots);
    // Push the step in by the left overhang so the outermost card still clears
    // the previous column, and pay for the right one when advancing the cursor.
    const box: Box = {
      x: cursorX + overhang.left,
      y: spineY - STEP_H / 2,
      w: STEP_W,
      h: STEP_H,
    };
    const centreX = box.x + box.w / 2;
    const stackTop = box.y + box.h + WORKER_DROP;
    const workers: WorkerLayout[] = rows.map((row, j) => {
      const slot = slots[j];
      const workerBox: Box = {
        x: slot.side === "right" ? centreX + FAN_INDENT : centreX - FAN_INDENT - WORKER_W,
        y: stackTop + slot.row * (WORKER_H + WORKER_V_GAP),
        w: WORKER_W,
        h: WORKER_H,
      };
      return {
        rowKey: row.task?.id ?? `${step.id}:agent:${j}`,
        taskId: row.task?.id,
        agentIndex: j,
        box: workerBox,
        side: slot.side,
        port: {
          x: slot.side === "right" ? workerBox.x : workerBox.x + workerBox.w,
          y: workerBox.y + workerBox.h / 2,
        },
      };
    });
    stepLayouts.push({ stepId: step.id, index: i + 1, box, workers });
    cursorX = box.x + box.w + overhang.right + COL_GAP;
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
          to: worker.port,
          enter: worker.side,
          stepId: layout.stepId,
          rowKey: worker.rowKey,
          taskId: worker.taskId,
        });
      }
    });
  }

  // Content extent. The deepest point is the bottom of the longest worker
  // stack, and the rightmost is normally COMPLETE, but the right column under
  // the final step can reach past it. The canvas fits to these numbers, so
  // anything missed here would be silently cropped out of the view.
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

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
 * of crossing the cards below them. Any fan of two or more hangs off BOTH
 * sides of the step's centreline like octopus arms, which keeps the batch
 * balanced under the step it belongs to and halves how deep the stack runs.
 *
 * Workers a step wired for peer comms can message each other, and the layout
 * says so: a dashed thread chains the peer cards down each column and closes
 * under the fan, so a batch reads as a team rather than as isolated satellites.
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

// Which side of its step's centreline a worker card sits on. A lone worker is
// always "right"; every larger fan mirrors across the centreline, so both
// columns are entered from the centre and neither branch crosses the other
// column's cards.
export type FanSide = "left" | "right";

export interface WorkerLayout {
  // Stable key: the task id when the worker is queued, else an agent slot id.
  rowKey: string;
  // Present only once the worker has a task; absent workers are not selectable.
  taskId?: string;
  agentIndex: number;
  box: Box;
  side: FanSide;
  // True when this worker's task was wired to message its same-step SIBLINGS.
  // Drives the dashed team thread; false for solo workers, for every task that
  // predates the flag, and for deliberately isolated workers.
  //
  // An isolated worker still has a mailbox (the manager reaches it through the
  // same artifacts), so the underlying peerComms flag stays on for it. Drawing
  // the team thread off that flag alone told the user their two deliberately
  // independent investigators were talking to each other, which was the exact
  // opposite of what they had asked for and of what was happening.
  peerComms: boolean;
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
  // True when the step is folded to its compact box. A collapsed step carries
  // NO workers, so every fan wire, worker port and peer thread derived from
  // this layout disappears with it and the spine closes up — which is the
  // whole point: a run with a dozen finished steps stops being a mile wide.
  collapsed: boolean;
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

// A link between SIBLING workers, not a path work travels along: it says the
// two cards it touches share a mailbox and can message each other. Drawn as an
// open polyline (a "chain" segment down one column, or the "bridge" that dips
// under the fan to join the two columns) so the whole batch ends up on one
// dashed thread without an N-squared mesh. The wire layer strokes it dashed
// and muted, and never lets it read as active work.
export interface PeerWire {
  id: string;
  stepId: string;
  kind: "chain" | "bridge";
  points: Point[];
}

export interface RunGraphLayout {
  sparkBox: Box;
  steps: StepLayout[];
  endBox: Box;
  spineWires: SpineWire[];
  fanWires: FanWire[];
  peerWires: PeerWire[];
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
// The folded form of a step: index chip, one line of title, one line of
// stats. Small enough that a long run of finished steps costs a fraction of
// the width their cards plus fans would.
export const COLLAPSED_STEP_W = 168;
export const COLLAPSED_STEP_H = 64;

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
// How far under the deepest card of a fan the peer bridge runs. The dashed
// thread closes below every card, which is empty space no branch wire reaches,
// so joining the two columns costs no crossings.
const PEER_BUS_DROP = 26;

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

// Where each worker of a fan of `count` sits: which column, and how far down
// it. A lone worker hangs to the right of the step's centreline. Every fan of
// two or more mirrors into two columns, ceil(n/2) on the right and the rest on
// the left, each column filled top-down in spawn order. Splitting from two up
// (rather than only past some width) is what makes a batch read as arms either
// side of the step instead of a lopsided tail, and it keeps the deepest column
// half as long.
function fanSlots(count: number): Array<{ side: FanSide; row: number }> {
  if (count <= 0) return [];
  if (count === 1) return [{ side: "right", row: 0 }];
  const rightCount = Math.ceil(count / 2);
  return Array.from({ length: count }, (_, index) =>
    index < rightCount
      ? { side: "right" as const, row: index }
      : { side: "left" as const, row: index - rightCount },
  );
}

// The dashed team thread for one step's fan. Peers chain to the sibling below
// them in their own column, and one bridge dips under the fan to join the two
// columns, so every peer ends up on a single connected thread with n-1 links
// rather than an unreadable n-squared mesh. Cards without the flag are skipped;
// a fan with fewer than two peers gets no thread at all.
function peerWiresForStep(stepId: string, workers: readonly WorkerLayout[]): PeerWire[] {
  const peers = workers.filter((worker) => worker.peerComms);
  if (peers.length < 2) return [];
  // Peer comms is a per-batch fact, so a step is either all-flagged or (across
  // an upgrade boundary, where some sibling tasks predate the flag) mixed. In
  // the mixed case the chain and bridge would run behind the unflagged cards,
  // visually enrolling them in a mailbox they do not have, so draw nothing:
  // truthful and only transitional. Task-less agent slots never veto.
  const mixed = workers.some((worker) => worker.taskId && !worker.peerComms);
  if (mixed) return [];
  const left = peers.filter((peer) => peer.side === "left");
  const right = peers.filter((peer) => peer.side === "right");
  const wires: PeerWire[] = [];
  for (const column of [left, right]) {
    for (let i = 0; i + 1 < column.length; i++) {
      const upper = column[i];
      const lower = column[i + 1];
      wires.push({
        id: `peer:${stepId}:${upper.rowKey}:${lower.rowKey}`,
        stepId,
        kind: "chain",
        // Straight down the card's own centre line, through the gap between
        // the two cards. Branch wires never enter that band, so the thread
        // crosses nothing on its way.
        points: [bottomPort(upper.box), topPort(lower.box)],
      });
    }
  }
  const lastLeft = left[left.length - 1];
  const lastRight = right[right.length - 1];
  if (lastLeft && lastRight) {
    const busY =
      peers.reduce((deepest, peer) => Math.max(deepest, peer.box.y + peer.box.h), 0) +
      PEER_BUS_DROP;
    wires.push({
      id: `peer:${stepId}:bridge`,
      stepId,
      kind: "bridge",
      points: [
        bottomPort(lastLeft.box),
        { x: lastLeft.box.x + lastLeft.box.w / 2, y: busY },
        { x: lastRight.box.x + lastRight.box.w / 2, y: busY },
        bottomPort(lastRight.box),
      ],
    });
  }
  return wires;
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
 *
 * `collapsedStepIds` folds finished steps down to a compact box with no fan.
 * Nothing else has to know: fan wires, worker ports and peer threads are all
 * derived from a step's `workers`, so emptying that list is what makes them
 * vanish, and the spine simply runs shorter.
 */
export function computeRunGraphLayout(
  steps: StepState[],
  rowsByStep: ReadonlyMap<string, readonly AgentRow[]>,
  collapsedStepIds?: ReadonlySet<string>,
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
    const collapsed = collapsedStepIds?.has(step.id) ?? false;
    // A folded step has no fan, so it has no overhang to pay for either — the
    // columns either side of it close right up.
    const slots = collapsed ? [] : fanSlots(rows.length);
    const overhang = fanOverhang(slots);
    // Push the step in by the left overhang so the outermost card still clears
    // the previous column, and pay for the right one when advancing the cursor.
    // Both boxes stay centred on the spine, so the wire layer's ports land on
    // the edges of whichever form the step is currently wearing.
    const box: Box = collapsed
      ? {
          x: cursorX,
          y: spineY - COLLAPSED_STEP_H / 2,
          w: COLLAPSED_STEP_W,
          h: COLLAPSED_STEP_H,
        }
      : {
          x: cursorX + overhang.left,
          y: spineY - STEP_H / 2,
          w: STEP_W,
          h: STEP_H,
        };
    const centreX = box.x + box.w / 2;
    const stackTop = box.y + box.h + WORKER_DROP;
    const workers: WorkerLayout[] = (collapsed ? [] : rows).map((row, j) => {
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
        peerComms: row.task?.peerComms === true && row.task?.isolated !== true,
        port: {
          x: slot.side === "right" ? workerBox.x : workerBox.x + workerBox.w,
          y: workerBox.y + workerBox.h / 2,
        },
      };
    });
    stepLayouts.push({ stepId: step.id, index: i + 1, box, workers, collapsed });
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
  const peerWires: PeerWire[] = [];
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
      peerWires.push(...peerWiresForStep(layout.stepId, layout.workers));
    });
  }

  // Content extent. The deepest point is the bottom of the longest worker
  // stack (or the peer bridge running under it), and the rightmost is normally
  // COMPLETE, but the right column under the final step can reach past it. The
  // canvas fits to these numbers, so anything missed here would be silently
  // cropped out of the view.
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
  for (const wire of peerWires) {
    for (const point of wire.points) {
      if (point.y > maxBottom) maxBottom = point.y;
      if (point.x > maxRight) maxRight = point.x;
    }
  }

  return {
    sparkBox,
    steps: stepLayouts,
    endBox,
    spineWires,
    fanWires,
    peerWires,
    width: maxRight + PAD_X,
    height: maxBottom + BOTTOM_PAD,
  };
}

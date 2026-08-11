// Pure geometry tests for the run graph's coordinate model
// (src/renderer/src/components/runs/graph-layout.ts). The module is
// dependency-free at runtime (only `import type` from @shared/types and
// run-format, both erased by esbuild), so this harness bundles the REAL
// computeRunGraphLayout and asserts on the boxes it produces.
//
//   node scripts/test-run-graph-layout.cjs
//
// What is pinned here: the octopus fan (any batch of two or more hangs off
// BOTH sides of its step), that no two boxes ever overlap, that every worker
// port sits on the card edge facing the step's centreline, that a lone worker
// keeps its old single-card shape, and that the peer thread only appears for
// peer-comms batches and links every peer without an n-squared mesh.
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "components", "runs", "graph-layout.ts");

// Minimal StepState / AgentRow shapes the pure layout reads: it only touches
// step.id and the row's task id + peerComms flag.
const step = (id) => ({ id });
const row = (id, over = {}) => ({
  agent: { label: id },
  task: { id, ...over },
});
const rows = (stepId, count, over = {}) =>
  Array.from({ length: count }, (_, i) => row(`${stepId}-w${i + 1}`, over));

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function allBoxes(layout) {
  const boxes = [
    { name: "spark", box: layout.sparkBox },
    { name: "end", box: layout.endBox },
  ];
  for (const stepLayout of layout.steps) {
    boxes.push({ name: `step:${stepLayout.stepId}`, box: stepLayout.box });
    for (const worker of stepLayout.workers) {
      boxes.push({ name: `worker:${worker.rowKey}`, box: worker.box });
    }
  }
  return boxes;
}

function firstOverlap(layout) {
  const boxes = allBoxes(layout);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i].box, boxes[j].box)) return `${boxes[i].name} / ${boxes[j].name}`;
    }
  }
  return null;
}

async function main() {
  const outfile = path.join(os.tmpdir(), "codara-run-graph-layout-test", "graph-layout.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const { computeRunGraphLayout, WORKER_W } = require(outfile);

  let failures = 0;
  const check = (name, cond) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  };

  const layoutOf = (counts, over = {}) => {
    const steps = counts.map((_, i) => step(`s${i + 1}`));
    const byStep = new Map(
      steps.map((s, i) => [s.id, rows(s.id, counts[i], over)]),
    );
    return computeRunGraphLayout(steps, byStep);
  };

  // ── The octopus fan: two or more workers use both sides ──
  for (const count of [2, 3, 4, 5, 6, 7, 9, 12]) {
    const workers = layoutOf([count]).steps[0].workers;
    const left = workers.filter((w) => w.side === "left");
    const right = workers.filter((w) => w.side === "right");
    check(
      `fan of ${count}: both sides populated (${right.length} right / ${left.length} left)`,
      left.length > 0 && right.length > 0 && left.length + right.length === count,
    );
    check(
      `fan of ${count}: right column takes ceil(n/2)`,
      right.length === Math.ceil(count / 2) && left.length === Math.floor(count / 2),
    );
    // Reading order: spawn order runs top-down within each column.
    const inOrder = (column) =>
      column.every((worker, i) => i === 0 || column[i - 1].box.y < worker.box.y);
    check(`fan of ${count}: each column reads top-down in spawn order`, inOrder(left) && inOrder(right));
    // Every arm is exactly half the depth of the old single stack.
    const rowsDeep = Math.max(right.length, left.length);
    check(
      `fan of ${count}: deepest arm is ${rowsDeep} cards`,
      rowsDeep === Math.ceil(count / 2),
    );
  }

  // ── A lone worker is unchanged: one card, on the right, no peer thread ──
  const solo = layoutOf([1]).steps[0];
  check("fan of 1: single card on the right", solo.workers.length === 1 && solo.workers[0].side === "right");
  check("fan of 1: card hangs below its step", solo.workers[0].box.y > solo.box.y + solo.box.h);
  check("fan of 1: port on the left edge, facing the centreline", solo.workers[0].port.x === solo.workers[0].box.x);
  check("fan of 1: no peer thread", layoutOf([1], { peerComms: true }).peerWires.length === 0);

  // ── Ports face the step's centreline, and cards clear it ──
  for (const count of [1, 2, 5, 8]) {
    const stepLayout = layoutOf([count]).steps[0];
    const centreX = stepLayout.box.x + stepLayout.box.w / 2;
    const facing = stepLayout.workers.every((worker) => {
      const midY = worker.box.y + worker.box.h / 2;
      if (worker.port.y !== midY) return false;
      return worker.side === "right"
        ? worker.port.x === worker.box.x && worker.box.x > centreX
        : worker.port.x === worker.box.x + worker.box.w && worker.box.x + worker.box.w < centreX;
    });
    check(`fan of ${count}: every port sits on the edge facing the centreline`, facing);
    const sameWidth = stepLayout.workers.every((worker) => worker.box.w === WORKER_W);
    check(`fan of ${count}: cards keep the laid-out worker width`, sameWidth);
  }

  // ── No box ever overlaps another, including across neighbouring steps ──
  for (const counts of [[1], [2], [5], [9], [3, 4], [5, 5, 5], [0, 6, 1], [12, 2]]) {
    const layout = layoutOf(counts);
    const clash = firstOverlap(layout);
    check(`counts [${counts}]: no box overlaps (${clash ?? "clean"})`, clash === null);
  }

  // ── Canvas bounds contain every box and every peer wire point ──
  for (const counts of [[5], [9, 2], [3, 3, 3]]) {
    const layout = layoutOf(counts, { peerComms: true });
    const boxesFit = allBoxes(layout).every(
      ({ box }) => box.x >= 0 && box.y >= 0 && box.x + box.w <= layout.width && box.y + box.h <= layout.height,
    );
    const wiresFit = layout.peerWires.every((wire) =>
      wire.points.every((p) => p.x >= 0 && p.y >= 0 && p.x <= layout.width && p.y <= layout.height),
    );
    check(`counts [${counts}]: canvas bounds contain the content`, boxesFit && wiresFit);
  }

  // ── Layout is stable while statuses change ──
  const before = layoutOf([5], { peerComms: true, status: "queued" });
  const after = layoutOf([5], { peerComms: true, status: "running" });
  check(
    "status churn does not move a single box",
    JSON.stringify(before.steps) === JSON.stringify(after.steps) &&
      before.width === after.width &&
      before.height === after.height,
  );

  // ── Peer thread: only for flagged batches, one connected thread ──
  check("no peer flag: no peer wires", layoutOf([5]).peerWires.length === 0);
  for (const count of [2, 3, 5, 8]) {
    const layout = layoutOf([count], { peerComms: true });
    const wires = layout.peerWires;
    // n peers linked by n-1 segments is a thread, not a mesh.
    check(`peers of ${count}: ${count - 1} links, never a mesh`, wires.length === count - 1);
    check(
      `peers of ${count}: exactly one bridge joins the columns`,
      wires.filter((w) => w.kind === "bridge").length === 1,
    );
    // Every peer card must be touched by the thread.
    const touched = new Set();
    const workers = layout.steps[0].workers;
    for (const wire of wires) {
      for (const point of [wire.points[0], wire.points[wire.points.length - 1]]) {
        const hit = workers.find(
          (worker) =>
            Math.abs(point.x - (worker.box.x + worker.box.w / 2)) < 0.001 &&
            (Math.abs(point.y - worker.box.y) < 0.001 ||
              Math.abs(point.y - (worker.box.y + worker.box.h)) < 0.001),
        );
        if (hit) touched.add(hit.rowKey);
      }
    }
    check(`peers of ${count}: every card is on the thread`, touched.size === count);
    // The bridge closes below the deepest card, where no branch wire runs.
    const bridge = wires.find((w) => w.kind === "bridge");
    const deepest = Math.max(...workers.map((w) => w.box.y + w.box.h));
    check(
      `peers of ${count}: bridge runs under the whole fan`,
      bridge.points[1].y > deepest && bridge.points[2].y === bridge.points[1].y,
    );
    check(
      `peers of ${count}: canvas grows to hold the bridge`,
      layout.height > bridge.points[1].y,
    );
  }

  // ── A single flagged peer in a fan draws nothing: a chat of one ──
  const loneSteps = [step("s1")];
  const loneRows = new Map([
    ["s1", [row("s1-w1", { peerComms: true, peers: true }), row("s1-w2"), row("s1-w3")]],
  ]);
  check(
    "one flagged worker among three: no thread to draw",
    computeRunGraphLayout(loneSteps, loneRows).peerWires.length === 0,
  );

  // ── A mixed step is the NORM under the opt-in chat ──
  // The manager flags the two workers that share a contract and leaves the
  // third out. The thread must join the two flagged cards and skip the third.
  const chosenSteps = [step("s1")];
  const chosenRows = new Map([
    [
      "s1",
      [
        row("s1-w1", { peerComms: true, peers: true }),
        row("s1-w2", { peerComms: true, peers: true }),
        row("s1-w3"),
      ],
    ],
  ]);
  const chosen = computeRunGraphLayout(chosenSteps, chosenRows);
  check("two flagged among three: the thread is drawn", chosen.peerWires.length === 1);
  {
    const unflagged = chosen.steps[0].workers.find((w) => w.rowKey === "s1-w3");
    const onThread = chosen.peerWires.some((wire) =>
      wire.points.some(
        (point) =>
          Math.abs(point.x - (unflagged.box.x + unflagged.box.w / 2)) < 0.001 &&
          (Math.abs(point.y - unflagged.box.y) < 0.001 ||
            Math.abs(point.y - (unflagged.box.y + unflagged.box.h)) < 0.001),
      ),
    );
    check("two flagged among three: the unflagged card is not on it", !onThread);
  }

  // ── The upgrade boundary still vetoes ──
  // Membership with no `peers` intent behind it anywhere in the step came from
  // the old auto-gate, so a mix there means "some siblings predate the flag",
  // not "the manager chose", and enrolling them visually would be a lie.
  const upgradeSteps = [step("s1")];
  const upgradeRows = new Map([
    [
      "s1",
      [row("s1-w1", { peerComms: true }), row("s1-w2", { peerComms: true }), row("s1-w3")],
    ],
  ]);
  check(
    "pre-flag membership in a mixed step: no thread to draw",
    computeRunGraphLayout(upgradeSteps, upgradeRows).peerWires.length === 0,
  );
  // ...but an unmixed pre-flag batch still draws, exactly as it used to.
  check("pre-flag membership across the whole step: still drawn", layoutOf([4], { peerComms: true }).peerWires.length === 3);

  // ── Old runs (no flag on any task) render exactly as before ──
  const legacy = layoutOf([4]);
  const flagged = layoutOf([4], { peerComms: true, peers: true });
  check(
    "the peer flag never moves a box",
    JSON.stringify(legacy.steps) === JSON.stringify(
      JSON.parse(JSON.stringify(flagged.steps)).map((s) => ({
        ...s,
        workers: s.workers.map((w) => ({ ...w, peerComms: false, peersFlagged: false })),
      })),
    ),
  );

  // ── A step with no workers still connects straight through ──
  const bare = layoutOf([0, 0]);
  check("stepless fans: spine still links every node", bare.spineWires.length === 3);
  check("stepless fans: no fan or peer wires", bare.fanWires.length === 0 && bare.peerWires.length === 0);

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all run-graph layout checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

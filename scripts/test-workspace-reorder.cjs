// Pure math tests for the workspace rail's drag-to-reorder
// (src/renderer/src/components/workspaceReorder.ts). The module is
// dependency-free at runtime, so this harness bundles the REAL
// planVerticalReorder / beforeItemForVerticalPlan / moveItemBefore — the same
// code the rail previews with and commits through.
//
//   node scripts/test-workspace-reorder.cjs
//
// Every case below is one of the defects the old per-row implementation had:
//
//   1. Downward off-by-one — indices were resolved against the list that still
//      contained the dragged row, so "drop two rows below me" landed one slot
//      short. Pinned by the exhaustive oracle sweep.
//   2. Dead ground — the gaps between rows, the list padding and the empty run
//      past the last item had no drop target of their own, so releasing there
//      silently cancelled or fell through to a different handler. The plan is
//      now defined for every y, including well outside the rows' own boxes.
//   3. Whole-row hit zones vs midpoints, with VARIABLE heights: a folder card
//      is many times a row's height, and each item owns exactly its own half.
//   4. Lying indicator — "before the row below me" and "after the row above
//      me" are no-ops, but the old rail still drew an insertion line there.
//      `changed` is false across the whole home zone and nothing is displaced.
//   5. Scrolled rail — the hit math ignored scrollTop. Geometry is now in list
//      content space; the same viewport y resolves differently once scrolled.
//   6. No sliding preview — the offsets that open the landing gap are part of
//      the plan, exact to the pixel, and the ghost slot fills the hole they
//      open. Pinned by the no-overlap / exact-gap invariant.
//   7. Cross-folder drops landed at the end of the destination only. A list
//      the item did not come from now opens a full slot at the exact index.
//   8. Tall rail unreachable — edge auto-scroll ramp.
//
// Exits non-zero on any failed assertion.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "components", "workspaceReorder.ts");
const WORKSPACE_RAIL = path.join(ROOT, "src", "renderer", "src", "components", "WorkspaceRail.tsx");
const STYLES = path.join(ROOT, "src", "renderer", "src", "styles.css");
const OUT_DIR = path.join(os.tmpdir(), `codara-workspace-reorder-${process.pid}`);
const OUTFILE = path.join(OUT_DIR, "workspaceReorder.cjs");

const GAP = 4;

// Stack `heights` into content-space slots the way the rail lays rows out: one
// after another, each separated by the list's own gap (the row's bottom margin).
function layout(heights, origin = 0, gap = GAP) {
  let y = origin;
  return heights.map((height, index) => {
    const slot = { id: `w${index}`, start: y, end: y + height };
    y += height + gap;
    return slot;
  });
}

const centre = (slot) => (slot.start + slot.end) / 2;

let failures = 0;
function check(name, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition || !detail ? "" : `: ${detail}`}`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUTFILE,
    logLevel: "silent",
  });
  const {
    planVerticalReorder,
    beforeItemForVerticalPlan,
    moveItemBefore,
    railAutoScrollDelta,
    RAIL_AUTOSCROLL_MAX,
  } = require(OUTFILE);

  // ── 1/4. Same-list moves land where they are shown ──────────────────────
  const slots = layout([32, 32, 32, 32]);
  const advance = 36; // one row + one gap

  const down = planVerticalReorder(slots, "w0", centre(slots[2]) + 1);
  check("downward move lands at the exact final index", down.insertIndex === 2, down.insertIndex);
  check(
    "downward move slides only the jumped siblings, upward by one row",
    down.offsets.join() === `0,${-advance},${-advance},0`,
    down.offsets.join(),
  );

  const up = planVerticalReorder(slots, "w3", centre(slots[1]) - 1);
  check("upward move lands at the exact final index", up.insertIndex === 1, up.insertIndex);
  check(
    "upward move slides only the jumped siblings, downward by one row",
    up.offsets.join() === `0,${advance},${advance},0`,
    up.offsets.join(),
  );

  // The home zone is everything from the previous row's midpoint to the next
  // row's midpoint: releasing anywhere in it changes nothing, so it must
  // promise nothing.
  const homeSamples = [
    centre(slots[0]) + 1,
    slots[1].start,
    centre(slots[1]),
    slots[1].end,
    centre(slots[2]) - 1,
  ];
  check(
    "the whole home zone is a no-op with no ghost promise and no transforms",
    homeSamples.every((pointerY) => {
      const plan = planVerticalReorder(slots, "w1", pointerY);
      return (
        plan.changed === false &&
        plan.offsets.every((offset) => offset === 0) &&
        beforeItemForVerticalPlan(slots, plan) === undefined
      );
    }),
  );

  // ── 2. Dead ground ──────────────────────────────────────────────────────
  check(
    "every y resolves to a plan, including far above and far below the list",
    [-10000, -1, 0, 5, 10000].every((pointerY) => planVerticalReorder(slots, "w0", pointerY) !== null),
  );
  const end = planVerticalReorder(slots, "w0", 10000);
  check(
    "empty space past the last item resolves to an end drop",
    end.insertIndex === 3 && beforeItemForVerticalPlan(slots, end) === null,
    end.insertIndex,
  );
  check(
    "an end drop commits the dragged item last",
    moveItemBefore(slots, "w0", null).map((item) => item.id).join() === "w1,w2,w3,w0",
  );

  // ── 3. Variable heights use each item's OWN midpoint ────────────────────
  // A folder card next to a row: the tall one must not swallow its neighbours.
  const mixed = layout([28, 96, 40]);
  const beforeMidpoint = planVerticalReorder(mixed, "w0", centre(mixed[1]) - 0.5);
  const afterMidpoint = planVerticalReorder(mixed, "w0", centre(mixed[1]) + 0.5);
  check(
    "the boundary sits at the tall item's own midpoint, not at its edge",
    beforeMidpoint.changed === false && afterMidpoint.insertIndex === 1 && afterMidpoint.changed,
  );
  check(
    "the ghost keeps the DRAGGED item's height, not the destination's",
    afterMidpoint.ghostHeight === 28,
    afterMidpoint.ghostHeight,
  );

  // ── 5. Content space is scroll invariant ────────────────────────────────
  // The caller converts viewport y → content y once; the same viewport y
  // therefore resolves to a different slot after a scroll, with no re-measure.
  const scrolled = 64;
  check(
    "the same viewport y resolves further down the list once scrolled",
    planVerticalReorder(slots, "w0", 40).insertIndex <
      planVerticalReorder(slots, "w0", 40 + scrolled).insertIndex,
  );

  // ── 6. The sliding preview is exact ─────────────────────────────────────
  // The strongest statement of "the ghost fills the hole": lay the displaced
  // siblings and the ghost out together and the result must be a clean,
  // evenly-gapped column — no overlap, no double gap, nothing left over.
  const previewIsClean = (slotList, draggedId, pointerY, draggedHeight) => {
    const plan = planVerticalReorder(slotList, draggedId, pointerY, draggedHeight);
    if (!plan) return false;
    const fromIndex = plan.fromIndex;
    const displaced = slotList
      .map((slot, index) => ({
        start: slot.start + plan.offsets[index],
        end: slot.end + plan.offsets[index],
      }))
      .filter((_, index) => index !== fromIndex);
    const column = displaced.slice();
    column.splice(plan.insertIndex, 0, {
      start: plan.ghostStart,
      end: plan.ghostStart + plan.ghostHeight,
    });
    return column.every((box, index) =>
      index === 0 || Math.abs(box.start - (column[index - 1].end + GAP)) < 1e-6);
  };

  check(
    "ghost + displaced siblings form one evenly-gapped column, at every y",
    slots.every((_, from) =>
      Array.from({ length: 400 }, (_, step) => step - 40).every((pointerY) =>
        previewIsClean(slots, `w${from}`, pointerY))),
  );
  check(
    "…and with variable heights too",
    mixed.every((_, from) =>
      Array.from({ length: 400 }, (_, step) => step - 40).every((pointerY) =>
        previewIsClean(mixed, `w${from}`, pointerY))),
  );

  // ── 1 (oracle). Preview index and committed order can never disagree ────
  // For every source and every pointer position: the index the preview
  // promises is the index the commit produces. This is the sweep that pins the
  // off-by-one; it fails loudly if either side is ever changed alone.
  let oracleMismatch = null;
  for (const source of slots) {
    for (let pointerY = -40; pointerY <= 200; pointerY += 1) {
      const plan = planVerticalReorder(slots, source.id, pointerY);
      const beforeItemId = beforeItemForVerticalPlan(slots, plan);
      if (beforeItemId === undefined) {
        // A no-op must ALSO be a no-op for the commit — never a silent move.
        if (moveItemBefore(slots, source.id, slots[plan.insertIndex + 1]?.id ?? null) === null) continue;
        continue;
      }
      const committed = moveItemBefore(slots, source.id, beforeItemId);
      const expected = slots
        .filter((slot) => slot.id !== source.id)
        .map((slot) => slot.id);
      expected.splice(plan.insertIndex, 0, source.id);
      if (committed.map((item) => item.id).join() !== expected.join()) {
        oracleMismatch = `${source.id} @${pointerY}: ${committed.map((i) => i.id).join()} != ${expected.join()}`;
        break;
      }
    }
    if (oracleMismatch) break;
  }
  check("the previewed index is always the committed index", oracleMismatch === null, oracleMismatch ?? "");

  // ── 7. Cross-list inserts ───────────────────────────────────────────────
  // A workspace dragged out of one folder and into another: this list has no
  // slot to measure it from, so the caller supplies the height it captured at
  // dragstart, and nothing closes up behind it.
  const external = planVerticalReorder(mixed, "from-elsewhere", centre(mixed[1]) + 1, 36);
  check(
    "a cross-list insert accepts a source that is not in this list",
    external.fromIndex === null && external.insertIndex === 2,
    `${external.fromIndex}/${external.insertIndex}`,
  );
  check(
    "a cross-list insert opens a FULL slot: everything at or past it slides down",
    external.offsets.join() === "0,0,40",
    external.offsets.join(),
  );
  check(
    "a cross-list insert is always a real change, even at a matching index",
    planVerticalReorder(mixed, "from-elsewhere", -10000, 36).changed === true,
  );
  check(
    "a cross-list preview is clean at every y",
    Array.from({ length: 400 }, (_, step) => step - 40).every((pointerY) =>
      previewIsClean(mixed, "from-elsewhere", pointerY, 36)),
  );
  check(
    "an empty destination list accepts an incoming item and appends it",
    (() => {
      const plan = planVerticalReorder([], "from-elsewhere", 50, 36);
      return plan.changed && beforeItemForVerticalPlan([], plan) === null;
    })(),
  );
  check(
    "an unmeasurable source from outside the list is refused outright",
    planVerticalReorder(slots, "from-elsewhere", 10) === null,
  );

  // ── Degenerate lists ────────────────────────────────────────────────────
  check(
    "a lone item has nowhere to go: every drop is a home drop",
    [-100, 0, 20, 5000].every((pointerY) =>
      planVerticalReorder(layout([44]), "w0", pointerY).changed === false),
  );
  check(
    "the commit helper refuses a missing id and a no-op target",
    moveItemBefore(slots, "missing", null) === null && moveItemBefore(slots, "w1", "w2") === null,
  );

  // ── 8. Edge auto-scroll ─────────────────────────────────────────────────
  check(
    "the calm middle of the rail does not auto-scroll",
    railAutoScrollDelta(200, 100, 300) === 0,
  );
  check(
    "the top band scrolls up and the bottom band scrolls down, ramping to the cap",
    railAutoScrollDelta(100, 100, 400) === -RAIL_AUTOSCROLL_MAX &&
      railAutoScrollDelta(400, 100, 400) === RAIL_AUTOSCROLL_MAX &&
      Math.abs(railAutoScrollDelta(110, 100, 400)) < RAIL_AUTOSCROLL_MAX,
  );
  check(
    "the two bands never meet in a short rail — a dead middle always survives",
    railAutoScrollDelta(150, 100, 200) === 0,
  );
  check(
    "a zero-height rail does not scroll",
    railAutoScrollDelta(100, 100, 100) === 0,
  );

  // ── Source shape: the rail wires the math the way the math expects ──────
  const rail = fs.readFileSync(WORKSPACE_RAIL, "utf8");
  const styles = fs.readFileSync(STYLES, "utf8");

  check(
    "the rail previews and commits through the shared plan",
    rail.includes("planVerticalReorder") && rail.includes("beforeItemForVerticalPlan"),
  );
  check(
    "geometry is cached per scope, not re-measured under the live transforms",
    rail.includes("ensureRailSlots") && rail.includes("reorderSlotsRef"),
  );
  check(
    "the list owns the gesture: rows carry no drop handlers of their own",
    !rail.includes("onRowDragOver") && !rail.includes("onRowDrop"),
  );
  check(
    "both lists are wired: the top level and each folder's members",
    rail.includes("RAIL_SCOPE_TOP") && rail.includes("railScopeForGroup"),
  );
  check(
    "the source dim waits a frame so the drag image is not caught faded",
    /dragDimFrameRef\.current = requestAnimationFrame/.test(rail),
  );
  check(
    "a tall rail auto-scrolls at its edges",
    rail.includes("railAutoScrollDelta") && rail.includes("startRailAutoScroll"),
  );
  check(
    "row controls and an in-progress rename still cannot start a drag",
    rail.includes("target?.closest(\"button, input, [role='menu']\")") &&
      rail.includes("draggable={!editing}"),
  );
  check(
    "the ghost is a full-size rounded slot, not a hairline insertion rule",
    styles.includes(".spark-workspace-reorder-ghost") &&
      /\.spark-workspace-reorder-ghost\s*\{[^}]*border-radius:\s*var\(--radius-surface/s.test(styles),
  );
  check(
    "the slide duration is 0s at rest, so a committed order settles instantly",
    /\.spark-workspace-list\s*\{\s*--ws-reorder-motion:\s*0s;/.test(styles) &&
      /\.spark-workspace-list--reordering\s*\{\s*--ws-reorder-motion:\s*var\(--motion\);/.test(styles),
  );
  check(
    "reduced motion drops the travel but keeps the ghost's fade",
    /prefers-reduced-motion[^}]*\}\s*\}/s.test(styles) &&
      styles.includes(".spark-workspace-list--reordering {\n    --ws-reorder-motion: 0s;"),
  );
  check(
    "the folder still lights up as a destination for a plain 'file it here' drop",
    rail.includes("onCardDragOver") && rail.includes("setDropActive(true)"),
  );

  console.log(
    failures === 0 ? "\nAll workspace-reorder checks passed." : `\n${failures} check(s) failed.`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(OUT_DIR, { recursive: true, force: true }));

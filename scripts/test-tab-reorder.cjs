// Pure math tests for the top tab strip's drag-to-reorder
// (src/renderer/src/tabs/tabReorder.ts). The module is dependency-free at
// runtime (only `import type` from ./types, erased by esbuild), so this harness
// bundles the REAL planTabReorder / reorderTargetFor / moveTabInList — the same
// code the strip previews with and the tab model commits with.
//
//   node scripts/test-tab-reorder.cjs
//
// Every case below is one of the defects the old per-tab implementation had:
//
//   1. Rightward off-by-one — indices were resolved against the list that still
//      contained the dragged tab, so "drop after the tab two to my right"
//      landed one slot short. Pinned by the exhaustive oracle sweep.
//   2. Dead ground — the gaps between tabs, the strip padding and the empty run
//      past the last tab had no drop target at all, so releasing there silently
//      cancelled. The plan is now defined for every x, including well outside
//      the tabs' own boxes.
//   3. Whole-tab hit zones vs midpoints, with VARIABLE widths: each tab owns
//      exactly its own half, so a wide file tab doesn't swallow its neighbours.
//   4. Lying indicator — "before the tab to my right" and "after the tab to my
//      left" are no-ops, but the old strip still drew an insertion line there.
//      `changed` is false for the whole home zone and nothing is displaced.
//   5. Scrolled strip — hit math ignored scrollLeft. Geometry is now in strip
//      content space; the same viewport x resolves differently once scrolled.
//   6. No sliding preview — the offsets that open the landing gap are part of
//      the plan, exact to the pixel (dragged width + strip gap), and the marker
//      sits at the centre of that gap.
//   7. Overflowing strip unreachable — edge auto-scroll ramp.
//   8. Close button starting a drag — source-shape check at the end.
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "tabs", "tabReorder.ts");
const OVERFLOW_ENTRY = path.join(ROOT, "src", "renderer", "src", "tabs", "tabStripOverflow.ts");
const TABBAR = path.join(ROOT, "src", "renderer", "src", "tabs", "TabBar.tsx");
const STYLES = path.join(ROOT, "src", "renderer", "src", "styles.css");

const GAP = 4;

// Lay out `widths` left to right with a uniform gap, starting at `origin`.
// Matches .spark-tabbar-scroll (display:flex; gap:4px) in strip content space.
function layout(widths, origin = 0, gap = GAP) {
  const slots = [];
  let x = origin;
  widths.forEach((width, index) => {
    slots.push({ id: `t${index}`, start: x, end: x + width });
    x += width + gap;
  });
  return slots;
}

const centre = (slot) => (slot.start + slot.end) / 2;

// Independent oracle: what the list SHOULD look like after dropping the dragged
// tab at `insertIndex` of the list without it. Deliberately written the naive
// way so it can't share a bug with the production splice.
function oracle(ids, draggedId, insertIndex) {
  const rest = ids.filter((id) => id !== draggedId);
  rest.splice(insertIndex, 0, draggedId);
  return rest;
}

async function main() {
  const outfile = path.join(os.tmpdir(), "codara-tab-reorder-test", "tabReorder.cjs");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
  });
  const {
    planTabReorder,
    reorderTargetFor,
    moveTabInList,
    toStripContentX,
    edgeAutoScrollDelta,
    TAB_STRIP_AUTOSCROLL_MAX,
  } = require(outfile);

  const overflowOutfile = path.join(
    os.tmpdir(),
    "codara-tab-reorder-test",
    "tabStripOverflow.cjs",
  );
  await esbuild.build({
    entryPoints: [OVERFLOW_ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: overflowOutfile,
    logLevel: "silent",
  });
  const { tabStripOverflow } = require(overflowOutfile);

  let failures = 0;
  const check = (name, cond, detail) => {
    if (!cond) failures += 1;
    console.log(`${cond ? "PASS" : "FAIL"} ${name}${!cond && detail !== undefined ? ` — ${detail}` : ""}`);
  };

  // Drive one gesture end to end: plan → (toId, position) → committed list.
  const drop = (slots, draggedId, pointerX) => {
    const plan = planTabReorder(slots, draggedId, pointerX);
    if (!plan) return { plan: null, ids: slots.map((s) => s.id) };
    const target = reorderTargetFor(slots, plan);
    const list = slots.map((s) => ({ id: s.id }));
    const moved = target ? moveTabInList(list, draggedId, target.toId, target.position) : null;
    return { plan, target, ids: (moved ?? list).map((t) => t.id) };
  };

  // ── 1. Rightward moves (the classic off-by-one) ───────────────────────────
  {
    const slots = layout([100, 100, 100, 100]); // t0..t3
    const one = drop(slots, "t0", centre(slots[1]) + 1);
    check("dragging right past one midpoint moves exactly one slot",
      one.plan.insertIndex === 1 && one.ids.join() === "t1,t0,t2,t3", one.ids.join());
    const two = drop(slots, "t0", centre(slots[2]) + 1);
    check("dragging right past two midpoints moves exactly two slots",
      two.plan.insertIndex === 2 && two.ids.join() === "t1,t2,t0,t3", two.ids.join());
    const end = drop(slots, "t0", slots[3].end + 500);
    check("dragging right past the last tab appends",
      end.plan.insertIndex === 3 && end.ids.join() === "t1,t2,t3,t0", end.ids.join());
    check("the append target is (last survivor, after)",
      end.target.toId === "t3" && end.target.position === "after", JSON.stringify(end.target));
  }

  // ── 2. Leftward moves ─────────────────────────────────────────────────────
  {
    const slots = layout([100, 100, 100, 100]);
    const one = drop(slots, "t3", centre(slots[2]) - 1);
    check("dragging left past one midpoint moves exactly one slot",
      one.plan.insertIndex === 2 && one.ids.join() === "t0,t1,t3,t2", one.ids.join());
    const home = drop(slots, "t3", slots[0].start - 500);
    check("dragging left past the first tab lands at index 0",
      home.plan.insertIndex === 0 && home.ids.join() === "t3,t0,t1,t2", home.ids.join());
    check("the first-slot target is (first survivor, before)",
      home.target.toId === "t0" && home.target.position === "before", JSON.stringify(home.target));
  }

  // ── 3. Midpoint boundaries with VARIABLE widths ───────────────────────────
  {
    // A short "terminals" pill between two long file tabs: the boundary must be
    // each tab's own centre, not a uniform pitch or a whole-box hit test.
    const slots = layout([180, 52, 160]);
    const short = slots[1];
    const before = drop(slots, "t0", centre(short) - 0.5);
    const after = drop(slots, "t0", centre(short) + 0.5);
    check("a half-pixel left of a narrow tab's centre stays home",
      before.plan.insertIndex === 0 && before.plan.changed === false, before.plan.insertIndex);
    check("a half-pixel right of a narrow tab's centre commits the swap",
      after.plan.insertIndex === 1 && after.ids.join() === "t1,t0,t2", after.ids.join());
    // Landing inside a WIDE tab's left half must not move anything past it.
    const wide = drop(slots, "t0", slots[2].start + 10);
    check("the left half of a wide tab is still 'before' it",
      wide.plan.insertIndex === 1, wide.plan.insertIndex);
  }

  // ── 4. The home zone never lies ───────────────────────────────────────────
  {
    const slots = layout([100, 100, 100, 100]);
    // Everything from the left neighbour's midpoint to the right neighbour's
    // midpoint is a no-op for t1: the old strip drew an insertion line across
    // all of it and then did nothing on release.
    const samples = [
      centre(slots[0]) + 1,
      slots[1].start - GAP / 2,
      centre(slots[1]),
      slots[1].end + GAP / 2,
      centre(slots[2]) - 1,
    ];
    const allHome = samples.every((x) => {
      const plan = planTabReorder(slots, "t1", x);
      return (
        plan.insertIndex === 1 &&
        plan.changed === false &&
        plan.offsets.every((offset) => offset === 0) &&
        reorderTargetFor(slots, plan) === null
      );
    });
    check("the whole home zone reports no change, no displacement, no target", allHome);
    // ...and one pixel past either neighbour's midpoint, it does move.
    check("just past the right neighbour's midpoint it moves",
      planTabReorder(slots, "t1", centre(slots[2]) + 1).changed === true);
    check("just past the left neighbour's midpoint it moves",
      planTabReorder(slots, "t1", centre(slots[0]) - 1).changed === true);
  }

  // ── 5. Displacement offsets + ghost-slot geometry ─────────────────────────
  {
    const slots = layout([100, 100, 100, 100]);
    const advance = 100 + GAP; // dragged width + strip gap
    const right = planTabReorder(slots, "t0", centre(slots[2]) + 1);
    check("moving right slides only the jumped tabs, left, by one advance",
      right.offsets.join() === [0, -advance, -advance, 0].join(), right.offsets.join());
    const left = planTabReorder(slots, "t3", centre(slots[1]) - 1);
    check("moving left slides only the jumped tabs, right, by one advance",
      left.offsets.join() === [0, advance, advance, 0].join(), left.offsets.join());
    check("the dragged tab is never displaced",
      right.offsets[0] === 0 && left.offsets[3] === 0);
    // The gap that opens is exactly wide enough for the tab plus both gaps, and
    // the ghost slot fills it with one strip gap of air on each side. With t0
    // landing at index 2, the hole is between the displaced t2 and the
    // untouched t3.
    const holeStart = slots[2].end + right.offsets[2];
    const holeEnd = slots[3].start + right.offsets[3];
    check("the opened gap fits the dragged tab exactly",
      holeEnd - holeStart === 100 + 2 * GAP, holeEnd - holeStart);
    check("the ghost slot is exactly the dragged tab's width",
      right.ghostWidth === 100, right.ghostWidth);
    check("the ghost slot sits one strip gap from each displaced neighbour",
      right.ghostStart - holeStart === GAP &&
        holeEnd - (right.ghostStart + right.ghostWidth) === GAP,
      `${right.ghostStart - holeStart} / ${holeEnd - (right.ghostStart + right.ghostWidth)}`);
    check("the plan's centre is the ghost slot's centre",
      right.markerX === right.ghostStart + right.ghostWidth / 2, right.markerX);
    // In a uniform strip, the slot for a given destination is the same wherever
    // the tab came from: the placeholder the user aims at doesn't jitter
    // depending on which side they approached from.
    const fromRight = planTabReorder(slots, "t3", centre(slots[1]) - 1); // → index 1
    const fromLeft = planTabReorder(slots, "t0", centre(slots[1]) + 1); // → index 1
    check("both approaches to the same destination draw one identical slot",
      fromLeft.insertIndex === 1 &&
        fromRight.insertIndex === 1 &&
        fromLeft.ghostStart === fromRight.ghostStart &&
        fromLeft.ghostWidth === fromRight.ghostWidth,
      `${fromLeft.ghostStart} / ${fromRight.ghostStart}`);
    // Ends of the strip: the hole there is one gap narrower than in the middle,
    // so a slot centred on the midpoint between two boxes would overhang the
    // edge tab. Landing first takes over the flow origin exactly; landing last
    // follows the final survivor by one gap.
    const first = planTabReorder(slots, "t3", slots[0].start - 400);
    check("landing first puts the slot at the strip's flow origin",
      first.insertIndex === 0 && first.ghostStart === slots[0].start, first.ghostStart);
    check("landing first leaves exactly one gap before the displaced first tab",
      slots[0].start + first.offsets[0] - (first.ghostStart + first.ghostWidth) === GAP,
      slots[0].start + first.offsets[0] - (first.ghostStart + first.ghostWidth));
    const end = planTabReorder(slots, "t0", 10_000);
    check("landing last follows the final survivor by one gap",
      end.ghostStart === slots[3].end + end.offsets[3] + GAP, end.ghostStart);
    // Variable widths: the slot is always the DRAGGED tab's width, never the
    // width of whatever it is landing next to.
    const mixed = layout([180, 52, 160]);
    const narrow = planTabReorder(mixed, "t1", 10_000);
    check("a narrow tab keeps its own narrow slot at the end",
      narrow.ghostWidth === 52 && narrow.ghostStart === mixed[2].end + narrow.offsets[2] + GAP,
      `${narrow.ghostWidth} / ${narrow.ghostStart}`);
    const wide = planTabReorder(mixed, "t0", 10_000);
    check("a wide tab keeps its own wide slot at the end",
      wide.ghostWidth === 180, wide.ghostWidth);
  }

  // ── 6. Scrolled strip ─────────────────────────────────────────────────────
  {
    // 6 tabs of 100 in a 300px-wide viewport, scrolled 208px right. The tab
    // under a given VIEWPORT x differs from the unscrolled case; the plan must
    // follow the content, not the window.
    const slots = layout([100, 100, 100, 100, 100, 100]);
    const stripLeft = 40;
    const viewportX = stripLeft + 160;
    const unscrolled = planTabReorder(slots, "t0", toStripContentX(viewportX, stripLeft, 0));
    const scrolled = planTabReorder(slots, "t0", toStripContentX(viewportX, stripLeft, 208));
    check("the same viewport x resolves to a different slot once scrolled",
      unscrolled.insertIndex === 1 && scrolled.insertIndex === 3,
      `${unscrolled.insertIndex} / ${scrolled.insertIndex}`);
    check("content-space conversion is scroll-additive",
      toStripContentX(viewportX, stripLeft, 208) === 160 + 208);
    // Geometry measured once, in content space, stays valid across a scroll:
    // the plan for a fixed CONTENT x is scroll-independent.
    const a = planTabReorder(slots, "t0", 350);
    const b = planTabReorder(slots, "t0", 350);
    check("a fixed content x is stable regardless of scroll", a.insertIndex === b.insertIndex);
  }

  // ── 7. Exhaustive sweep against the oracle ────────────────────────────────
  {
    // Every list size 1..6, every dragged tab, every interesting pointer x
    // (well left of the strip, each slot's start/quarter/centre/end, each gap
    // centre, well right of the strip) — plan, target and commit must agree
    // with the naive remove-then-insert.
    const widthSets = [
      [120],
      [120, 80],
      [120, 80, 200],
      [90, 90, 90, 90],
      [64, 210, 88, 150, 72],
      [100, 100, 40, 260, 100, 55],
    ];
    let mismatches = 0;
    let sampled = 0;
    for (const widths of widthSets) {
      const slots = layout(widths, 12);
      const ids = slots.map((s) => s.id);
      const xs = [slots[0].start - 400, slots[slots.length - 1].end + 400];
      for (let i = 0; i < slots.length; i += 1) {
        xs.push(slots[i].start, slots[i].start + (slots[i].end - slots[i].start) / 4);
        xs.push(centre(slots[i]) - 0.5, centre(slots[i]) + 0.5, slots[i].end);
        if (i + 1 < slots.length) xs.push(slots[i].end + GAP / 2);
      }
      for (const draggedId of ids) {
        for (const x of xs) {
          sampled += 1;
          const result = drop(slots, draggedId, x);
          const expected = oracle(ids, draggedId, result.plan.insertIndex);
          // The plan's insertIndex IS the dragged tab's final index.
          if (
            result.ids.join() !== expected.join() ||
            result.ids.indexOf(draggedId) !== result.plan.insertIndex ||
            result.plan.changed !== (result.ids.join() !== ids.join())
          ) {
            mismatches += 1;
            if (mismatches <= 3) {
              console.log(
                `      widths=${widths} dragged=${draggedId} x=${x} ` +
                  `got=${result.ids.join()} want=${expected.join()} idx=${result.plan.insertIndex}`,
              );
            }
          }
        }
      }
    }
    check(`exhaustive sweep matches the oracle (${sampled} drops)`, mismatches === 0, `${mismatches} mismatches`);
  }

  // ── 8. Degenerate inputs ──────────────────────────────────────────────────
  {
    const slots = layout([100, 100, 100]);
    check("an unknown dragged id yields no plan", planTabReorder(slots, "ghost", 150) === null);
    check("an empty strip yields no plan", planTabReorder([], "t0", 0) === null);
    const lone = layout([100]);
    const plan = planTabReorder(lone, "t0", 5_000);
    check("a lone tab can never move",
      plan.changed === false && reorderTargetFor(lone, plan) === null);
    check("moveTabInList refuses a self-move", moveTabInList([{ id: "a" }], "a", "a", "after") === null);
    check("moveTabInList refuses an unknown id",
      moveTabInList([{ id: "a" }, { id: "b" }], "a", "zz", "after") === null);
    check("moveTabInList returns null for a no-op move",
      moveTabInList([{ id: "a" }, { id: "b" }], "a", "b", "before") === null);
    check("moveTabInList preserves every other element",
      moveTabInList([{ id: "a" }, { id: "b" }, { id: "c" }], "c", "a", "before")
        .map((t) => t.id)
        .join() === "c,a,b");
  }

  // ── 9. Edge auto-scroll ───────────────────────────────────────────────────
  {
    const left = 100;
    const right = 700;
    check("the calm middle does not scroll", edgeAutoScrollDelta(400, left, right) === 0);
    const nearLeft = edgeAutoScrollDelta(left + 10, left, right);
    check("near the left edge scrolls left", nearLeft < 0 && nearLeft > -TAB_STRIP_AUTOSCROLL_MAX, nearLeft);
    const nearRight = edgeAutoScrollDelta(right - 10, left, right);
    check("near the right edge scrolls right", nearRight > 0 && nearRight < TAB_STRIP_AUTOSCROLL_MAX, nearRight);
    check("past the left edge clamps to full speed",
      edgeAutoScrollDelta(left - 200, left, right) === -TAB_STRIP_AUTOSCROLL_MAX);
    check("past the right edge clamps to full speed",
      edgeAutoScrollDelta(right + 200, left, right) === TAB_STRIP_AUTOSCROLL_MAX);
    check("the ramp is monotonic toward the edge",
      Math.abs(edgeAutoScrollDelta(left + 5, left, right)) >
        Math.abs(edgeAutoScrollDelta(left + 30, left, right)));
    check("a narrow strip keeps a dead middle",
      edgeAutoScrollDelta(150, 100, 200) === 0 && edgeAutoScrollDelta(101, 100, 200) < 0);
    check("a zero-width strip never scrolls", edgeAutoScrollDelta(5, 10, 10) === 0);
  }

  // 10. Tab strip overflow fades
  {
    const noOverflow = tabStripOverflow(0, 400, 400);
    const stalePosition = tabStripOverflow(50, 400, 400);
    check("a fitting strip has no edge fades",
      noOverflow.left === false && noOverflow.right === false &&
        stalePosition.left === false && stalePosition.right === false);

    const beginning = tabStripOverflow(0, 300, 600);
    check("the beginning shows only the right fade",
      beginning.left === false && beginning.right === true,
      JSON.stringify(beginning));

    const middle = tabStripOverflow(150, 300, 600);
    check("the middle shows both edge fades",
      middle.left === true && middle.right === true,
      JSON.stringify(middle));

    const end = tabStripOverflow(300, 300, 600);
    check("the end shows only the left fade",
      end.left === true && end.right === false,
      JSON.stringify(end));

    const roundingOnly = tabStripOverflow(0.5, 300, 300.5);
    check("subpixel rounding does not create a false fade",
      roundingOnly.left === false && roundingOnly.right === false,
      JSON.stringify(roundingOnly));
  }

  // ── 10. Source shape: the behaviours the geometry can't prove ─────────────
  {
    const tabbar = fs.readFileSync(TABBAR, "utf8");
    const styles = fs.readFileSync(STYLES, "utf8");
    const closeButtons = tabbar.match(/className="spark-tab__close"/g) ?? [];
    const optOuts = tabbar.match(/className="spark-tab__close"\s*\n\s*(?:\/\/[^\n]*\n\s*)*draggable=\{false\}/g) ?? [];
    check("every tab control opts out of dragging",
      closeButtons.length > 0 && optOuts.length === closeButtons.length,
      `${optOuts.length}/${closeButtons.length}`);
    check("the stylesheet blocks drags on tab controls",
      /\.spark-tab__close\s*\{[^}]*-webkit-user-drag:\s*none/s.test(styles));
    check("reorder hit-testing is not per-tab any more",
      !tabbar.includes("reorderPositionFor") && !tabbar.includes("spark-tab__reorder-edge"));
    const ghostRule = styles.match(/\.spark-tab-reorder-ghost\s*\{[^}]*\}/s)?.[0] ?? "";
    check("the strip owns one ghost slot (no insertion line left)",
      tabbar.includes("spark-tab-reorder-ghost") &&
        ghostRule.length > 0 &&
        !tabbar.includes("spark-tab-reorder-marker") &&
        !styles.includes("spark-tab-reorder-marker"));
    check("the ghost is a chip: tab height, tab radius, soft fill + hairline",
      /height:\s*var\(--tab-h\)/.test(ghostRule) &&
        /border-radius:\s*var\(--tab-radius\)/.test(ghostRule) &&
        /background:\s*var\(--accent-soft\)/.test(ghostRule) &&
        /border:\s*1px solid var\(--accent-edge\)/.test(ghostRule));
    check("the ghost is sized and placed from the plan, not from CSS guesses",
      tabbar.includes("reorderPlan.ghostWidth") && tabbar.includes("reorderPlan.ghostStart"));
    check("the ghost fades rather than unmounting between destinations",
      /opacity:\s*0/.test(ghostRule) &&
        /\.spark-tab-reorder-ghost--visible\s*\{[^}]*opacity:\s*1/s.test(styles) &&
        /\.spark-tab-reorder-ghost\s*\{[^}]*transition:[^}]*transform var\(--motion\)/s.test(styles));
    check("the slide is transform-based and transitioned",
      tabbar.includes("translate3d") &&
        /\.spark-tabbar-scroll--reordering \.spark-tab\s*\{[^}]*transform var\(--motion\)/s.test(styles));
    check("reduced motion drops the travel but keeps the fade",
      /@media \(prefers-reduced-motion: reduce\)\s*\{(?:[^{}]|\{[^{}]*\})*\.spark-tab-reorder-ghost\s*\{[^}]*transition:\s*opacity/s.test(styles));
    check("the ghost's containing block is the scroll container",
      /\.spark-tabbar-scroll\s*\{[^}]*position:\s*relative/s.test(styles));
    check("middle-click close and the close button survive",
      tabbar.includes("closeOnMiddleClick") && tabbar.includes('aria-label="Close tab"'));
    check("chat tabs still refuse to drag while renaming", tabbar.includes("draggable={!editing}"));
    check("no magic hex in the reorder styling",
      /var\(--accent-soft\)/.test(ghostRule) && !/#[0-9a-fA-F]{3}/.test(ghostRule));

    // ── Floating pill tabs ────────────────────────────────────────────────
    const tabRule = styles.match(/\n\.spark-tab\s*\{[^}]*\}/s)?.[0] ?? "";
    const activeRule = styles.match(/\.spark-tab--active\s*\{[^}]*\}/s)?.[0] ?? "";
    const barRule = styles.match(/\.spark-tabbar\s*\{[^}]*\}/s)?.[0] ?? "";
    const scrollRule = styles.match(/\.spark-tabbar-scroll\s*\{[^}]*\}/s)?.[0] ?? "";
    check("the strip start has no unconditional left mask",
      !/(?:-webkit-)?mask-image/.test(scrollRule),
      scrollRule.match(/(?:-webkit-)?mask-image:[^;]*/)?.[0]);
    check("overflow state selects the left and right fade modifiers",
      tabbar.includes("spark-tabbar-scroll--overflow-left") &&
        tabbar.includes("spark-tabbar-scroll--overflow-right") &&
        styles.includes(".spark-tabbar-scroll--overflow-left") &&
        styles.includes(".spark-tabbar-scroll--overflow-right"));
    check("scroll and resize changes refresh overflow state",
      tabbar.includes('addEventListener("scroll"') &&
        tabbar.includes("new ResizeObserver(updateStripOverflow)"));
    check("wheel, active-tab visibility and reorder auto-scroll refresh overflow state",
      (tabbar.match(/updateStripOverflow\(\)/g) ?? []).length >= 5 &&
        tabbar.includes("scrollIntoView"));
    check("tabs are rounded on all four corners",
      /border-radius:\s*var\(--tab-radius\);/.test(tabRule), tabRule.match(/border-radius:[^;]*/)?.[0]);
    check("tabs are chips of a fixed height, inset from the strip",
      /height:\s*var\(--tab-h\)/.test(tabRule) && !/border-bottom:\s*none/.test(tabRule));
    check("the chip is shorter than the strip, leaving breathing room",
      /--tab-h:\s*28px/.test(styles) && /--tabbar-h:\s*36px/.test(styles));
    check("the strip centres its chips instead of standing them on its floor",
      /align-items:\s*center/.test(barRule) && /align-items:\s*center/.test(scrollRule));
    check("the active tab is a raised chip, not a merged panel",
      /background:\s*var\(--panel-2\)/.test(activeRule) &&
        /box-shadow:\s*var\(--lift-hi\)/.test(activeRule) &&
        !/margin-bottom:\s*-1px/.test(activeRule));
    check("active and inactive chips are the same box (no reflow on select)",
      !/padding-bottom/.test(activeRule) && !/height/.test(activeRule));
    check("no magic hex in the chip styling",
      !/#[0-9a-fA-F]{3}/.test(tabRule) && !/#[0-9a-fA-F]{3}/.test(activeRule));
    const useTabs = fs.readFileSync(
      path.join(ROOT, "src", "renderer", "src", "tabs", "useTabs.ts"),
      "utf8",
    );
    check("the tab model commits through the same shared move helper",
      useTabs.includes("moveTabInList"));
  }

  console.log(failures === 0 ? "\nAll tab-reorder checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

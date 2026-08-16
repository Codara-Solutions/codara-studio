// Harness for the docked-tab layout helpers in src/renderer/src/tabs/useTabs.ts
// and src/renderer/src/tabs/dock.ts. Two things here are load-bearing and
// invisible until a user relaunches:
//
//   1. TAB_VERSION moved 6 -> 7 for dock cells. Bumping it WITHOUT a migration
//      would make loadPersisted reject every existing blob, silently wiping
//      each workspace's saved layout on first launch.
//   2. A dock cell references another tab by id. A reference that can't
//      resolve has to be pruned, or the grid keeps a hole that shows nothing
//      and can't be closed.
//
//   node scripts/test-dock-layout.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const ENTRY = path.join(ROOT, "src", "renderer", "src", "tabs", "useTabs.ts");
const DOCK_ENTRY = path.join(ROOT, "src", "renderer", "src", "tabs", "dock.ts");

const harnessPlugin = {
  name: "dock-layout-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^react$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export const useCallback = (fn) => fn;\n" +
        "export const useEffect = () => {};\n" +
        "export const useLayoutEffect = () => {};\n" +
        "export const useMemo = (fn) => fn();\n" +
        "export const useRef = (v) => ({ current: v });\n" +
        "export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];\n",
      loader: "js",
    }));
  },
};

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

const leaf = (paneId, extra = {}) => ({ kind: "leaf", paneId, ...extra });
const dockCell = (paneId, tabId, tabKind = "preview") => ({
  kind: "leaf",
  paneId,
  content: { type: "tab", tabId, tabKind },
});
const split = (a, b, ratio = 0.5) => ({ kind: "split", direction: "horizontal", ratio, a, b });
const terminalTab = (id, root, extra = {}) => ({
  id,
  kind: "terminal",
  title: "terminals",
  root,
  activePaneId: "p1",
  ...extra,
});
const previewTab = (id) => ({ id, kind: "preview", title: "preview", url: "http://localhost:3000" });

async function main() {
  const outdir = path.join(os.tmpdir(), "spark-dock-layout-test");
  fs.mkdirSync(outdir, { recursive: true });
  const useTabsOut = path.join(outdir, "useTabs.cjs");
  const dockOut = path.join(outdir, "dock.cjs");
  for (const [entry, outfile] of [
    [ENTRY, useTabsOut],
    [DOCK_ENTRY, dockOut],
  ]) {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      plugins: [harnessPlugin],
      logLevel: "silent",
    });
  }
  const { migratePersisted, validateDockLeaves } = require(useTabsOut);
  const {
    buildDockIndex,
    collectTerminalLeaves,
    collectDockLeaves,
    isDockLeaf,
    canDockTab,
    planOpenInSplit,
    DOCKABLE_KINDS,
  } = require(dockOut);

  // --- migration -----------------------------------------------------------
  const v6 = {
    v: 6,
    activeId: "t1",
    tabs: [terminalTab("t1", split(leaf("p1", { cwd: "/tmp/a" }), leaf("p2"), 0.4))],
  };
  const migrated = migratePersisted(JSON.parse(JSON.stringify(v6)));
  check("v6 blob survives migration", migrated !== null);
  check("v6 blob is stamped as v7", migrated && migrated.v === 7);
  check(
    "v6 layout is preserved verbatim",
    migrated && JSON.stringify(migrated.tabs) === JSON.stringify(v6.tabs),
  );
  check(
    "v7 blob passes through unchanged",
    (() => {
      const out = migratePersisted({ ...v6, v: 7 });
      return out !== null && out.v === 7;
    })(),
  );
  check("pre-v6 blob is still discarded", migratePersisted({ ...v6, v: 5 }) === null);
  check("malformed blob is discarded", migratePersisted({ v: 6 }) === null);
  check("null blob is discarded", migratePersisted(null) === null);

  // --- dangling dock references -------------------------------------------
  const resolvable = validateDockLeaves([
    terminalTab("t1", split(leaf("p1"), dockCell("d1", "prev1"))),
    previewTab("prev1"),
  ]);
  check(
    "a dock cell pointing at a live tab is kept",
    collectDockLeaves(resolvable[0].root).length === 1,
  );

  const dangling = validateDockLeaves([
    terminalTab("t1", split(leaf("p1"), dockCell("d1", "gone"))),
  ]);
  check("a dock cell pointing at a missing tab is pruned", collectDockLeaves(dangling[0].root).length === 0);
  check("pruning collapses the split to the survivor", dangling[0].root.paneId === "p1");
  check("the host tab survives the prune", dangling.length === 1);

  const onlyChild = validateDockLeaves([terminalTab("t1", dockCell("d1", "gone"))]);
  check("a host whose only cell was pruned is dropped", onlyChild.length === 0);

  const repaired = validateDockLeaves([
    terminalTab("t1", split(leaf("p1"), dockCell("d1", "gone")), {
      activePaneId: "d1",
      zoomedPaneId: "d1",
    }),
  ]);
  check("activePaneId is re-aimed at a surviving cell", repaired[0].activePaneId === "p1");
  check("a zoom held by the pruned cell is cleared", repaired[0].zoomedPaneId === null);

  const duplicated = validateDockLeaves([
    terminalTab("t1", split(dockCell("d1", "prev1"), dockCell("d2", "prev1"))),
    previewTab("prev1"),
  ]);
  check(
    "the same tab docked twice keeps only the first cell",
    collectDockLeaves(duplicated[0].root).length === 1,
  );

  const chatPending = validateDockLeaves([
    terminalTab("t1", split(leaf("p1"), dockCell("d1", "run-1", "chat"))),
  ]);
  check(
    "a chat reference is held pending (chat tabs are re-derived after load)",
    collectDockLeaves(chatPending[0].root).length === 1,
  );

  const badKind = validateDockLeaves([
    terminalTab("t1", split(leaf("p1"), dockCell("d1", "x", "runs"))),
    { id: "x", kind: "runs", title: "Runs" },
  ]);
  check("a non-dockable kind is pruned", collectDockLeaves(badKind[0].root).length === 0);

  // --- index + leaf partitioning ------------------------------------------
  const tabs = [
    terminalTab("t1", split(leaf("p1"), dockCell("d1", "prev1"))),
    previewTab("prev1"),
  ];
  const index = buildDockIndex(tabs);
  check("dock index maps the docked tab to its host", index.get("prev1")?.hostTabId === "t1");
  check("dock index maps the docked tab to its cell", index.get("prev1")?.leafId === "d1");
  check("dock index ignores undocked tabs", index.get("t1") === undefined);

  const root = split(leaf("p1"), dockCell("d1", "prev1"));
  check("terminal leaves exclude dock cells", collectTerminalLeaves(root).length === 1);
  check("dock leaves exclude terminals", collectDockLeaves(root).length === 1);
  check("isDockLeaf discriminates", isDockLeaf(dockCell("d1", "x")) && !isDockLeaf(leaf("p1")));

  // --- dockability ---------------------------------------------------------
  check("previews are dockable", canDockTab(previewTab("prev1")));
  check("terminals are not dockable", !canDockTab(terminalTab("t1", leaf("p1"))));
  check(
    "run-owned previews are not dockable",
    !canDockTab({ ...previewTab("prev1"), runId: "run-1" }),
  );

  // --- "Open in split" host resolution ------------------------------------
  // The rule: pair the tab you picked with the surface you are LOOKING AT.
  // Every case below was a way the old lookup ("the active tab if it happens
  // to be a terminal, else the last terminal tab in the strip") put the cell
  // somewhere the user was not.
  const chat = (id) => ({ id, kind: "chat", title: "Cora" });
  const editor = (id) => ({ id, kind: "editor", title: "notes.txt", path: "/w/notes.txt", entry: {} });
  const workerTab = (id) => terminalTab(id, leaf("wp1"), { scope: { kind: "workers", runId: "run-1" } });

  const grid = terminalTab("t1", leaf("p1"));
  check(
    "the grid on screen takes the cell",
    JSON.stringify(planOpenInSplit([grid, previewTab("prev1")], "t1", "prev1")) ===
      JSON.stringify({ kind: "dock", hostTabId: "t1" }),
  );
  check(
    "two non-terminal surfaces pair in a new container",
    JSON.stringify(planOpenInSplit([chat("c1"), editor("e1"), grid], "c1", "e1")) ===
      JSON.stringify({ kind: "container", partnerTabId: "c1" }),
  );
  check(
    "splitting the tab you are already on falls back to the grid you were last in",
    JSON.stringify(planOpenInSplit([grid, terminalTab("t2", leaf("p2")), editor("e1")], "e1", "e1", "t1")) ===
      JSON.stringify({ kind: "dock", hostTabId: "t1" }),
  );
  check(
    "without a remembered grid the fallback is the last one in the strip",
    JSON.stringify(planOpenInSplit([grid, terminalTab("t2", leaf("p2")), editor("e1")], "e1", "e1")) ===
      JSON.stringify({ kind: "dock", hostTabId: "t2" }),
  );
  check(
    "a hidden worker grid is never the host",
    JSON.stringify(planOpenInSplit([workerTab("w1"), editor("e1")], "e1", "e1")) ===
      JSON.stringify({ kind: "new-terminal" }),
  );
  check(
    "a workspace with no grid at all still splits (against a fresh shell)",
    JSON.stringify(planOpenInSplit([editor("e1")], "e1", "e1")) ===
      JSON.stringify({ kind: "new-terminal" }),
  );
  check(
    "a run-owned surface on screen is not a partner",
    JSON.stringify(
      planOpenInSplit([{ id: "r1", kind: "runs", title: "Runs", runId: "run-1" }, grid, editor("e1")], "r1", "e1"),
    ) === JSON.stringify({ kind: "dock", hostTabId: "t1" }),
  );
  check(
    "a partner already docked is left in its grid",
    JSON.stringify(
      planOpenInSplit(
        [terminalTab("t1", split(leaf("p1"), dockCell("d1", "c1", "chat"))), chat("c1"), editor("e1")],
        "c1",
        "e1",
      ),
    ) === JSON.stringify({ kind: "dock", hostTabId: "t1" }),
  );
  check("an undockable tab has no plan", planOpenInSplit([grid], "t1", "t1") === null);

  // --- every workspace surface can be split --------------------------------
  // The complement of this set is deliberate: terminal tabs ARE the grid, and
  // run-owned kinds live in the chat panel's inner strip (canDockTab screens
  // those out separately).
  for (const kind of ["preview", "editor", "chat", "diff", "whiteboard", "usage", "automations"]) {
    check(`${kind} tabs are dockable`, DOCKABLE_KINDS.has(kind));
  }
  check("terminal tabs stay undockable", !DOCKABLE_KINDS.has("terminal"));

  if (failures > 0) {
    console.error(`\n${failures} dock-layout check(s) failed`);
    process.exit(1);
  }
  console.log("all dock-layout checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

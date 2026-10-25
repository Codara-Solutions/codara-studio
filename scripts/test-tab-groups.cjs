// Tab groups (src/renderer/src/tabs/tabGroups.ts) and the layout helpers in
// useTabs.ts that put an agent's tab into a named group. What matters past a
// relaunch: every member carries the same record, members stay adjacent, a
// saved blob round-trips, and a name only ever matches within its workspace.
//
//   node scripts/test-tab-groups.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const TABS_DIR = path.join(ROOT, "src", "renderer", "src", "tabs");

const harnessPlugin = {
  name: "tab-groups-harness",
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

const previewTab = (id, extra = {}) => ({ id, kind: "preview", title: id, url: "http://localhost:3000", ...extra });
const terminalTab = (id, extra = {}) => ({
  id,
  kind: "terminal",
  title: "terminals",
  root: { kind: "leaf", paneId: `${id}-pane` },
  activePaneId: `${id}-pane`,
  ...extra,
});
const ids = (tabs) => tabs.map((tab) => tab.id).join(",");
const groupOf = (tabs, id) => tabs.find((tab) => tab.id === id)?.group ?? null;

async function main() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-tab-groups-test-"));
  const groupsOut = path.join(outdir, "tabGroups.cjs");
  const useTabsOut = path.join(outdir, "useTabs.cjs");
  const nameOut = path.join(outdir, "tab-group-name.cjs");
  for (const [entry, outfile] of [
    [path.join(TABS_DIR, "tabGroups.ts"), groupsOut],
    [path.join(TABS_DIR, "useTabs.ts"), useTabsOut],
    [path.join(SHARED_DIR, "tab-group-name.ts"), nameOut],
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
  const groups = require(groupsOut);
  const {
    appendAgentTerminalToWorkspaceLayout,
    mergeDeferredWorkspaceTerminalLayout,
    migratePersisted,
  } = require(useTabsOut);
  const { normalizeTabGroupName, tabGroupNameKey, TAB_GROUP_NAME_MAX } = require(nameOut);

  // --- names ---------------------------------------------------------------
  check("a name is trimmed and its spaces collapsed", normalizeTabGroupName("  Fix \t login\nflow ") === "Fix login flow");
  check("control characters never reach a name", normalizeTabGroupName("a\u0007b\u009bc") === "a b c");
  check("a numeric name from the CLI reads as its digits", normalizeTabGroupName(2024) === "2024");
  check("a non-name is empty", normalizeTabGroupName({}) === "" && normalizeTabGroupName(NaN) === "");
  check("a long name is cut", normalizeTabGroupName("x".repeat(200)).length === TAB_GROUP_NAME_MAX);
  check("names match ignoring case and spacing", tabGroupNameKey(" Login  Flow") === tabGroupNameKey("login flow"));

  // --- create, join by name ------------------------------------------------
  let tabs = [previewTab("a"), previewTab("b"), terminalTab("c"), previewTab("d")];
  const first = groups.placeTabInNamedGroup(tabs, "b", "Login flow");
  check("a new name starts a group", first !== null && first.group.name === "Login flow");
  check("the first group takes the first color", first.group.color === "blue");
  check("the tab keeps its place when it starts a group", ids(first.tabs) === "a,b,c,d");
  tabs = first.tabs;
  const joined = groups.placeTabInNamedGroup(tabs, "d", "  LOGIN   flow ");
  check("the same name joins the group, case and spacing aside", joined.group.id === first.group.id);
  check("the joined group keeps its own spelling", joined.group.name === "Login flow");
  check("a joining tab moves to the end of the group", ids(joined.tabs) === "a,b,d,c");
  tabs = joined.tabs;
  check(
    "every member carries the same record",
    JSON.stringify(groupOf(tabs, "b")) === JSON.stringify(groupOf(tabs, "d")),
  );
  const second = groups.placeTabInNamedGroup(tabs, "c", "Docs");
  check("another name starts another group with the next free color", second.group.id !== first.group.id && second.group.color === "red");
  check("an empty name groups nothing", groups.placeTabInNamedGroup(tabs, "a", "   ") === null);
  check(
    "colors cycle back to the least used",
    groups.nextTabGroupColor([
      { id: "1", name: "", color: "blue" },
      { id: "2", name: "", color: "red" },
    ]) === "yellow",
  );
  const inserted = groups.insertTabInNamedGroup(tabs, previewTab("e"), "login FLOW");
  check("a new tab is inserted straight into the existing group", ids(inserted.tabs) === "a,b,d,e,c");
  check("a new tab without a name is appended ungrouped", groups.insertTabInNamedGroup(tabs, previewTab("e"), undefined).group === null);
  tabs = groups.placeTabInNamedGroup(inserted.tabs, "c", "Docs").tabs;

  // --- rename, recolor, collapse, ungroup ----------------------------------
  const gid = first.group.id;
  tabs = groups.renameTabGroup(tabs, gid, " Sign in ");
  check("rename updates every member", ["b", "d", "e"].every((id) => groupOf(tabs, id).name === "Sign in"));
  tabs = groups.recolorTabGroup(tabs, gid, "green");
  check("recolor updates every member", ["b", "d", "e"].every((id) => groupOf(tabs, id).color === "green"));
  check("an unknown color is refused", groups.recolorTabGroup(tabs, gid, "chartreuse") === tabs);
  const collapsed = groups.setTabGroupCollapsed(tabs, gid, true);
  const strip = groups.tabStripEntries(collapsed);
  check("a collapsed group shows its chip only", strip.filter((entry) => entry.kind === "tab").map((entry) => entry.tab.id).join(",") === "a,c");
  const chip = strip.find((entry) => entry.kind === "group" && entry.group.id === gid);
  check("the chip counts the hidden members", chip && chip.memberIds.join(",") === "b,d,e");
  const expandedStrip = groups.tabStripEntries(groups.setTabGroupCollapsed(collapsed, gid, false));
  check("expanding shows the members again", expandedStrip.filter((entry) => entry.kind === "tab").length === 5);
  check("the last member is marked", expandedStrip.find((entry) => entry.kind === "tab" && entry.tab.id === "e").lastInGroup === true);
  const ungrouped = groups.ungroupTabGroup(tabs, gid);
  check("ungroup keeps the tabs in place", ids(ungrouped) === ids(tabs));
  check("ungroup removes the membership", ungrouped.every((tab) => tab.group?.id !== gid));

  // --- remove one tab, close ------------------------------------------------
  const removed = groups.moveTabToGroup(tabs, "d", null);
  check("a removed tab leaves right after the group", ids(removed) === "a,b,e,d,c" && !groupOf(removed, "d"));
  const closed = tabs.filter((tab) => tab.group?.id !== gid);
  check("closing a group closes its members only", ids(closed) === "a,c");
  check("the other group survives a close", groups.tabGroupsIn(closed).length === 1);

  // --- normalization ---------------------------------------------------------
  const scattered = [
    previewTab("x", { group: { id: "g1", name: "One", color: "blue" } }),
    previewTab("y"),
    previewTab("z", { group: { id: "g1", name: "Other", color: "pink" } }),
    previewTab("w", { group: { id: "bad id!", name: "Bad", color: "blue" } }),
    previewTab("v", { group: { id: "g2", name: "Two", color: "mauve" } }),
  ];
  const normalized = groups.normalizeTabGroups(scattered);
  check("members are gathered at the first member", ids(normalized) === "x,z,y,w,v");
  check("the first member's record wins", groupOf(normalized, "z").name === "One" && groupOf(normalized, "z").color === "blue");
  check("an unreadable record leaves its tab ungrouped", !groupOf(normalized, "w"));
  check("an unknown color falls back to grey", groupOf(normalized, "v").color === "grey");
  check("normalizing a clean list returns the same array", groups.normalizeTabGroups(normalized) === normalized);

  // --- dragging into and out of a group -------------------------------------
  const dragTabs = groups.normalizeTabGroups([
    previewTab("a"),
    previewTab("b", { group: { id: "g1", name: "G", color: "blue" } }),
    previewTab("c", { group: { id: "g1", name: "G", color: "blue" } }),
    previewTab("d"),
  ]);
  const slots = [
    { id: "a", start: 0, end: 100, chip: false, groupId: null, collapsed: false },
    { id: "chip:g1", start: 100, end: 140, chip: true, groupId: "g1", collapsed: false },
    { id: "b", start: 140, end: 240, chip: false, groupId: "g1", collapsed: false },
    { id: "c", start: 240, end: 340, chip: false, groupId: "g1", collapsed: false },
    { id: "d", start: 340, end: 440, chip: false, groupId: null, collapsed: false },
  ];
  const membersOf = (groupId) => dragTabs.filter((tab) => tab.group?.id === groupId).map((tab) => tab.id);
  const intoGroup = groups.resolveStripDrop({ slots, draggedId: "d", insertIndex: 3, pointerX: 230, membersOf });
  check("dropping between members joins the group", intoGroup && intoGroup.groupId === "g1");
  const intoApplied = groups.applyStripDrop(dragTabs, "d", intoGroup);
  check("the dropped tab lands inside the group", ids(intoApplied) === "a,b,d,c" && groupOf(intoApplied, "d")?.id === "g1");
  const outOfGroup = groups.resolveStripDrop({ slots, draggedId: "b", insertIndex: 0, pointerX: 10, membersOf });
  check("dropping before the chip leaves the group", outOfGroup && outOfGroup.groupId === null);
  const outApplied = groups.applyStripDrop(dragTabs, "b", outOfGroup);
  check("the tab dragged out is ungrouped in front", ids(outApplied) === "b,a,c,d" && !groupOf(outApplied, "b"));
  const pastEdge = groups.resolveStripDrop({ slots, draggedId: "c", insertIndex: 3, pointerX: 400, membersOf });
  check("pulling the last member past its own edge leaves the group", pastEdge && pastEdge.groupId === null && pastEdge.anchor === null);
  const stay = groups.resolveStripDrop({ slots, draggedId: "c", insertIndex: 3, pointerX: 300, membersOf });
  check("a drop that changes nothing is null", stay === null);

  // --- persistence round trip -----------------------------------------------
  const blob = JSON.parse(JSON.stringify({ v: 7, activeId: "a", tabs: inserted.tabs }));
  const restored = migratePersisted(blob);
  check("a saved layout with groups loads at the current version", restored !== null && restored.v === 7);
  const reloaded = groups.normalizeTabGroups(restored.tabs);
  check("groups survive a save and reload", JSON.stringify(reloaded) === JSON.stringify(inserted.tabs));
  check("collapse survives a reload", (() => {
    const saved = JSON.parse(JSON.stringify(groups.setTabGroupCollapsed(inserted.tabs, gid, true)));
    return groups.normalizeTabGroups(saved).find((tab) => tab.id === "b").group.collapsed === true;
  })());

  // --- workspace isolation --------------------------------------------------
  const workspaceA = { workspaceId: "ws-a", tabs: [terminalTab("ta")], activeId: "ta" };
  const workspaceB = { workspaceId: "ws-b", tabs: [terminalTab("tb")], activeId: "tb" };
  const inA = appendAgentTerminalToWorkspaceLayout(workspaceA, { group: "Build" });
  const againA = appendAgentTerminalToWorkspaceLayout(inA.layout, { group: "build" });
  const inB = appendAgentTerminalToWorkspaceLayout(workspaceB, { group: "Build" });
  check("an agent terminal starts the named group", inA.group?.name === "Build");
  check("a second call joins it in the same workspace", againA.group?.id === inA.group.id);
  check("the same name in another workspace is a group of its own", inB.group && inB.group.id !== inA.group.id);
  check("a background agent tab never takes focus", againA.layout.activeId === "ta" && inB.layout.activeId === "tb");
  check("the other workspace's layout is untouched", ids(workspaceB.tabs) === "tb" && ids(inB.layout.tabs).startsWith("tb,"));
  const noGroup = appendAgentTerminalToWorkspaceLayout(workspaceA, {});
  check("without a group the tab opens as before", noGroup.group === null && !groupOf(noGroup.layout.tabs, noGroup.tabId));

  // A workspace whose saved tabs are not loaded yet: the agent's tab joins
  // the saved group of that name, and the two lists merge into one group.
  const saved = groups.placeTabInNamedGroup([terminalTab("s1"), previewTab("s2")], "s1", "Deploy");
  const cold = { workspaceId: "ws-c", tabs: saved.tabs, activeId: "s2" };
  const deferred = appendAgentTerminalToWorkspaceLayout(
    { workspaceId: "ws-c", tabs: [], activeId: null },
    { group: "deploy" },
    groups.tabGroupsIn(cold.tabs),
  );
  check("an agent tab joins the saved group of an unloaded workspace", deferred.group?.id === saved.group.id);
  const merged = mergeDeferredWorkspaceTerminalLayout(cold, deferred.layout);
  check(
    "merging puts it beside the saved members",
    ids(merged.tabs) === `s1,${deferred.tabId},s2` && merged.activeId === "s2",
  );

  fs.rmSync(outdir, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall tab group checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

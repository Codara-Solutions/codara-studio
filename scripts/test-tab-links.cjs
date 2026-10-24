// Tab and group links (src/shared/tab-links.ts) and what they resolve to and
// rearrange in the layouts (src/renderer/src/tabs/tabLinks.ts): a link keeps
// pointing at its tab while it is split into another tab's grid, Split right
// and Split down land beside the tab on screen, and Unsplit gives a terminal
// tab its panes back under the same id.
//
//   node scripts/test-tab-links.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(entry) {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "shared",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const leaf = (paneId) => ({ kind: "leaf", paneId });
const terminal = (id, root, extra = {}) => ({ id, kind: "terminal", title: id, root, activePaneId: root.kind === "leaf" ? root.paneId : root.a.paneId, ...extra });

async function main() {
  const links = await load("src/shared/tab-links.ts");
  const { tabLink, groupLink, parseTabLink, isTabLink, TAB_LINK_TEXT_PATTERN } = links;

  assert.equal(tabLink("ws-1", "term-abc"), "codara://tab/ws-1/term-abc");
  assert.equal(groupLink("ws-1", "grp:login"), "codara://group/ws-1/grp%3Alogin");
  assert.deepEqual(parseTabLink("codara://tab/ws-1/term-abc"), { kind: "tab", workspaceId: "ws-1", id: "term-abc" });
  assert.deepEqual(parseTabLink(groupLink("ws-1", "grp:login")), { kind: "group", workspaceId: "ws-1", id: "grp:login" });
  assert.deepEqual(parseTabLink("  codara://tab/ws-1/term-abc/ "), { kind: "tab", workspaceId: "ws-1", id: "term-abc" }, "trailing slash and spaces");
  for (const bad of ["codara://tab/ws-1", "codara://pane/ws/x", "https://tab/ws/x", "codara://tab/ws/x?y=1", "codara://tab/ws/a%2Fb", "codara://tab/ws/%E0", 42, null]) {
    assert.equal(parseTabLink(bad), null, `rejects ${String(bad)}`);
  }
  assert.equal(isTabLink("codara://group/w/g"), true);
  const line = "Open codara://tab/ws-1/term-abc. Or (codara://group/ws-1/grp-2), then go.";
  assert.deepEqual(line.match(TAB_LINK_TEXT_PATTERN), ["codara://tab/ws-1/term-abc", "codara://group/ws-1/grp-2"], "sentence punctuation stays out");
  console.log("links format, parse and match in running text");

  const t = await load("src/renderer/src/tabs/tabLinks.ts");
  const group = { id: "grp-1", name: "login-flow" };
  const shell = terminal("term-a", leaf("pa"), { group });
  const other = terminal("term-b", { kind: "split", direction: "horizontal", ratio: 0.5, a: leaf("pb1"), b: leaf("pb2") });
  const browser = { id: "preview-1", kind: "preview", title: "localhost", url: "http://localhost:3000", group };
  const editor = { id: "editor-1", kind: "editor", title: "notes.md", path: "/x/notes.md", dirty: true };
  const tabs = [shell, other, browser, editor];
  const layouts = [{ workspaceId: "ws", tabs, loaded: true }];

  const one = t.resolveTabLink(layouts, { kind: "tab", workspaceId: "ws", id: "term-b" });
  assert.deepEqual(one.tabs, [{ tabId: "term-b", kind: "terminal", title: "term-b", paneIds: ["pb1", "pb2"] }]);
  const dirty = t.resolveTabLink(layouts, { kind: "tab", workspaceId: "ws", id: "editor-1" });
  assert.equal(dirty.tabs[0].dirty, true);
  const grouped = t.resolveTabLink(layouts, { kind: "group", workspaceId: "ws", id: "grp-1" });
  assert.deepEqual(grouped.group, group);
  assert.deepEqual(grouped.tabs.map((tab) => tab.tabId), ["term-a", "preview-1"]);
  assert.equal(t.resolveTabLink(layouts, { kind: "tab", workspaceId: "ws", id: "gone" }), null, "closed tab");
  assert.equal(t.resolveTabLink(layouts, { kind: "group", workspaceId: "ws", id: "grp-9" }), null, "empty group");
  assert.equal(t.resolveTabLink(layouts, { kind: "tab", workspaceId: "other", id: "term-a" }), null, "unknown workspace");
  console.log("links resolve to tabs, groups, and nothing once closed");

  assert.deepEqual(t.splitPlacement("right"), { direction: "horizontal", position: "after" });
  assert.deepEqual(t.splitPlacement("down"), { direction: "vertical", position: "after" });
  assert.equal(t.planTabSplit(tabs, "term-a", "term-a").kind, "refused", "the tab on screen cannot split beside itself");
  assert.equal(t.planTabSplit(tabs, null, "term-a").kind, "refused");
  assert.equal(t.planTabSplit(tabs, "term-a", "nope").kind, "refused");
  assert.deepEqual(t.planTabSplit(tabs, "term-a", "preview-1"), { kind: "dock", hostTabId: "term-a", paneId: "pa" });
  assert.deepEqual(t.planTabSplit(tabs, "term-a", "term-b"), { kind: "merge", hostTabId: "term-a", paneId: "pa" });
  assert.deepEqual(t.planTabSplit(tabs, "preview-1", "editor-1"), { kind: "pair", targetId: "preview-1" });
  const workers = terminal("term-w", leaf("pw"), { scope: { kind: "workers", runId: "r" } });
  assert.equal(t.planTabSplit([...tabs, workers], "term-a", "term-w").kind, "refused", "worker views stay put");
  console.log("split plans dock, merge or pair beside the tab on screen");

  const merge = t.mergeTerminalTabInto(tabs, "term-b", "term-a", "pa", "down", "ws");
  assert.ok(merge);
  assert.deepEqual(merge.tabs.map((tab) => tab.id), ["term-a", "preview-1", "editor-1"], "the moved tab leaves the strip");
  const host = merge.tabs[0];
  assert.equal(host.root.direction, "vertical");
  assert.equal(host.root.a.paneId, "pa");
  assert.equal(host.root.b, other.root, "panes keep their ids and sessions");
  assert.equal(host.activePaneId, "pb1");
  assert.equal(merge.merged.tabId, "term-b");
  const aliases = new Map([["term-b", merge.merged]]);
  const after = [{ workspaceId: "ws", tabs: merge.tabs, loaded: true }];
  const alias = t.resolveTabLink(after, { kind: "tab", workspaceId: "ws", id: "term-b" }, aliases);
  assert.deepEqual(alias.tabs, [{ tabId: "term-b", kind: "terminal", title: "term-b", paneIds: ["pb1", "pb2"], mergedInto: "term-a" }], "the old link still finds its panes");
  assert.equal(t.mergeTerminalTabInto(tabs, "term-a", "term-a", "pa", "right", "ws"), null);
  console.log("a terminal tab merges into the grid on screen and its link follows");

  assert.deepEqual(t.planTabUnsplit(merge.tabs, "term-b", aliases), { kind: "unsplit", undock: [], extract: ["term-b"] });
  assert.deepEqual(t.planTabUnsplit(merge.tabs, "term-a", aliases), { kind: "unsplit", undock: [], extract: ["term-b"] });
  assert.equal(t.planTabUnsplit(tabs, "term-b").kind, "refused", "nothing to unsplit");
  const back = t.extractMergedTab(merge.tabs, merge.merged);
  assert.deepEqual(back.map((tab) => tab.id), ["term-a", "term-b", "preview-1", "editor-1"], "returns right after its host");
  assert.equal(back[0].root, shell.root);
  assert.deepEqual(back[1].root, other.root, "keeps its old shape");
  const closedOne = merge.tabs.map((tab) => (tab.id === "term-a" ? { ...tab, root: { kind: "split", direction: "vertical", ratio: 0.5, a: leaf("pa"), b: leaf("pb2") } } : tab));
  const partial = t.extractMergedTab(closedOne, merge.merged);
  assert.deepEqual(partial[1].root, leaf("pb2"), "only the panes still open come back");
  assert.equal(t.extractMergedTab(tabs, merge.merged), null, "nothing to extract once the tab is back");

  const dockedHost = terminal("term-a", { kind: "split", direction: "horizontal", ratio: 0.5, a: leaf("pa"), b: { kind: "leaf", paneId: "dock-1", content: { type: "tab", tabId: "preview-1", tabKind: "preview" } } });
  const dockedTabs = [dockedHost, browser];
  assert.deepEqual(t.planTabUnsplit(dockedTabs, "preview-1"), { kind: "unsplit", undock: ["preview-1"], extract: [] });
  assert.deepEqual(t.planTabUnsplit(dockedTabs, "term-a"), { kind: "unsplit", undock: ["preview-1"], extract: [] });
  const dockedLink = t.resolveTabLink([{ workspaceId: "ws", tabs: dockedTabs, loaded: true }], { kind: "tab", workspaceId: "ws", id: "preview-1" });
  assert.equal(dockedLink.tabs[0].dockedIn, "term-a");
  console.log("unsplit gives docked and merged tabs back");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// codara_tab's rules (src/main/tab-actions.ts): an agent acts alone only on
// tabs it opened, any other tab needs the user's Allow with the card naming
// what is lost, it never closes the terminal it runs in, and another
// workspace stays off limits without the user's cross-workspace grant.
//
//   node scripts/test-tab-actions.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/tab-actions.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  const { decideTabAction } = mod.exports;

  const owned = new Set(["agent-pane"]);
  const running = new Set(["user-agent-pane"]);
  let grant = false;
  const deps = {
    ownsTerminalPane: (paneId) => owned.has(paneId),
    agentRunningIn: (paneId) => running.has(paneId),
    hasWorkspaceGrant: async () => grant,
  };
  const caller = { workspaceId: "ws", runId: null, paneId: "caller-pane" };
  const mine = { tabId: "t-mine", kind: "terminal", title: "dev server", paneIds: ["agent-pane"] };
  const users = { tabId: "t-user", kind: "terminal", title: "claude", paneIds: ["user-agent-pane"] };
  const self = { tabId: "t-self", kind: "terminal", title: "me", paneIds: ["caller-pane"] };
  const editor = { tabId: "e-1", kind: "editor", title: "notes.md", dirty: true };
  const myBrowser = { tabId: "p-1", kind: "preview", title: "localhost", openedBy: { paneId: "caller-pane" } };
  const userBrowser = { tabId: "p-2", kind: "preview", title: "docs" };
  const target = (tabs, extra = {}) => ({ workspaceId: "ws", loaded: true, kind: "tab", tabs, ...extra });
  const group = (tabs) => target(tabs, { kind: "group", group: { id: "g", name: "login-flow" } });

  let decision = await decideTabAction("close", group([mine, myBrowser]), caller, "ws", deps);
  assert.deepEqual(decision, { kind: "act", tabIds: ["t-mine", "p-1"], approval: null, skipped: [] }, "own tabs close at once");

  decision = await decideTabAction("close", group([mine, users, editor]), caller, "ws", deps);
  assert.deepEqual(decision.tabIds, ["t-mine", "t-user", "e-1"]);
  assert.deepEqual(decision.approval, [
    { title: "dev server", kind: "terminal" },
    { title: "claude", kind: "terminal", warning: "agent" },
    { title: "notes.md", kind: "editor", warning: "unsaved" },
  ], "one tab not opened by the agent puts the whole group on the card, with warnings");

  decision = await decideTabAction("close", target([userBrowser]), caller, "ws", deps);
  assert.ok(decision.approval, "a browser tab the user opened needs approval");
  decision = await decideTabAction("close", target([myBrowser]), { ...caller, runId: "run-1" }, "ws", deps);
  assert.ok(decision.approval, "a run does not own a tab its pane opened outside that run");
  const claudeBrowser = { tabId: "p-3", kind: "preview", title: "app", openedBy: { paneId: "caller-pane", sessionId: "s-claude" } };
  decision = await decideTabAction("close", target([claudeBrowser]), { ...caller, sessionId: "s-claude" }, "ws", deps);
  assert.equal(decision.approval, null, "the session that opened a browser tab closes it");
  decision = await decideTabAction("close", target([claudeBrowser]), { ...caller, sessionId: "s-codex" }, "ws", deps);
  assert.ok(decision.approval, "Codex started in Claude's pane does not inherit Claude's browser tabs");
  decision = await decideTabAction("close", target([claudeBrowser]), { ...caller, paneId: "pane-2", sessionId: "s-claude" }, "ws", deps);
  assert.equal(decision.approval, null, "the same session resumed in another pane keeps them");
  decision = await decideTabAction("close", target([claudeBrowser]), { ...caller, sessionId: null }, "ws", deps);
  assert.equal(decision.approval, null, "before the caller's session is captured, its pane decides");

  decision = await decideTabAction("close", group([self, mine]), caller, "ws", deps);
  assert.deepEqual(decision.tabIds, ["t-mine"]);
  assert.deepEqual(decision.skipped, [{ tabId: "t-self", reason: "it holds the terminal you run in" }]);
  decision = await decideTabAction("close", target([self]), caller, "ws", deps);
  assert.equal(decision.code, "nothing_to_do");
  console.log("close: own tabs free, others on the card, never the caller's own pane");

  decision = await decideTabAction("close", target([mine], { workspaceId: "ws-2" }), caller, "ws-2", deps);
  assert.equal(decision.code, "other_workspace", "a link from another workspace is not consent");
  grant = true;
  decision = await decideTabAction("close", target([mine], { workspaceId: "ws-2" }), caller, "ws-2", deps);
  assert.equal(decision.kind, "act", "the user's cross-workspace grant opens it");
  grant = false;

  decision = await decideTabAction("close", group([mine, editor]), caller, "ws-other", deps);
  assert.deepEqual(decision.tabIds, ["t-mine"], "a background workspace closes terminals and browsers only");
  assert.equal(decision.skipped[0].tabId, "e-1");
  decision = await decideTabAction("close", target([mine], { loaded: false }), caller, "ws", deps);
  assert.equal(decision.code, "not_loaded");
  console.log("close: workspace grant, background and unloaded layouts");

  decision = await decideTabAction("split", group([mine]), caller, "ws", deps);
  assert.equal(decision.code, "needs_tab");
  decision = await decideTabAction("split", target([mine]), caller, "ws-other", deps);
  assert.equal(decision.code, "not_on_screen");
  decision = await decideTabAction("split", target([mine]), caller, "ws", deps);
  assert.deepEqual(decision, { kind: "act", tabIds: ["t-mine"], approval: null, skipped: [] });
  decision = await decideTabAction("unsplit", target([users]), caller, "ws", deps);
  assert.ok(decision.approval, "rearranging the user's tab needs approval");
  decision = await decideTabAction("split", target([self]), caller, "ws", deps);
  assert.equal(decision.kind, "act", "an agent may move the terminal it runs in");
  console.log("split and unsplit: one tab, on screen, approval for others' tabs");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

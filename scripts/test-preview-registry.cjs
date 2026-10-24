"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const output = await esbuild.build({ entryPoints: [path.join(__dirname, "../src/renderer/src/components/Preview/registry.ts")], bundle: true, write: false, platform: "node", format: "cjs" });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  const r = mod.exports;
  const activity = [];
  const handle = { getURL: () => "https://example.test/live", getTitle: () => "Live title", getWebContentsId: () => null, showAgentCursor: (value) => activity.push(value) };
  r.registerPreviewTab({ id: "user-a", workspaceId: "a", url: "old", handle });
  r.registerPreviewTab({ id: "run-a", workspaceId: "a", runId: "run-1", url: "old", handle });
  r.registerPreviewTab({ id: "user-b", workspaceId: "b", url: "old", handle });
  r.setActivePreviewTab("user-a", "a");
  r.setActivePreviewTab("chat-a", "a");
  assert.equal(r.listPreviewTabs().length, 2);
  assert.deepEqual(r.listPreviewTabs()[0], { id: "user-a", title: "Live title", url: "https://example.test/live", workspaceId: "a", isActive: false, isLastViewed: true });
  assert.equal(r.pickPreviewTab(null, "run-1").id, "run-a");
  assert.equal(r.pickPreviewTab(null, "run-2"), null);
  assert.equal(r.pickPreviewTab("user-a", "run-1").id, "user-a");
  assert.equal(r.pickPreviewTab("user-b", "run-1"), null);
  assert.equal(r.pickPreviewTab("user-b", null, "b").id, "user-b");
  r.setActivePreviewTab("user-b", "b");
  assert.equal(r.pickPreviewTab(null, "run-1", "a").id, "run-a");
  let opened;
  r.setOpenPreviewTabFn((url, runId, workspaceId) => {
    opened = { url, runId, workspaceId };
    r.registerPreviewTab({ id: "new-a", url, runId, workspaceId, handle });
    return "new-a";
  });
  assert.deepEqual(await r.ensurePreviewTab("https://new.test", "run-2", "a").then(({ tab, opened }) => [tab.id, opened]), ["new-a", true]);
  assert.deepEqual(opened, { url: "https://new.test", runId: "run-2", workspaceId: "a" });
  r.showPreviewControl(r.pickPreviewTab("user-a", null, "a"), { runId: "run-2", action: "Clicking", x: 30, y: 40 });
  r.clearPreviewControl("run-1");
  assert.equal(activity.length, 1);
  r.clearPreviewControl("run-2");
  assert.equal(activity.at(-1), null);
  assert.ok(r.pickPreviewTab("user-a", null, "a"), "clearing control does not close the browser");
  r.unregisterPreviewTab("user-b");
  assert.equal(r.listPreviewTabs().length, 0);
  console.log("preview workspace routing and control tests passed");

  // An agent with no run, in a terminal pane of workspace "pa", while the user
  // looks at workspace "pb".
  const panes = { "pane-a": "pa", "pane-a2": "pa" };
  r.setLocatePaneWorkspaceFn((paneId) => panes[paneId] ?? null);
  const guestHandle = (id) => ({ ...handle, getWebContentsId: () => id });
  r.registerPreviewTab({ id: "user-pa", workspaceId: "pa", url: "u", handle: guestHandle(11) });
  r.registerPreviewTab({ id: "run-pa", workspaceId: "pa", runId: "run-9", url: "u", handle: guestHandle(12) });
  r.registerPreviewTab({ id: "user-pb", workspaceId: "pb", url: "u", handle: guestHandle(13) });
  r.setActivePreviewTab("user-pb", "pb");
  assert.equal(r.pickPreviewTab(null, null, null, "pane-a").id, "user-pa", "the pane's workspace, not the one on screen");
  assert.equal(r.pickPreviewTab("user-pb", null, null, "pane-a"), null, "an explicit tab in another workspace is refused");
  assert.deepEqual(r.listPreviewTabs(null, "pane-a").map((tab) => tab.id).sort(), ["run-pa", "user-pa"]);
  assert.equal(r.findReusablePreviewTab(null, null, "pane-a"), null, "navigate never takes over the user's tab");
  let paneOpened;
  r.setOpenPreviewTabFn((url, runId, workspaceId) => {
    paneOpened = { url, runId, workspaceId };
    r.registerPreviewTab({ id: "agent-pa", url, runId, workspaceId, handle: guestHandle(14) });
    return "agent-pa";
  });
  assert.deepEqual(await r.ensurePreviewTab("https://agent.test", null, null, "pane-a").then(({ tab, opened }) => [tab.id, opened]), ["agent-pa", true]);
  assert.deepEqual(paneOpened, { url: "https://agent.test", runId: null, workspaceId: "pa" });
  assert.deepEqual(await r.ensurePreviewTab("https://agent.test/2", null, null, "pane-a").then(({ tab, opened }) => [tab.id, opened]), ["agent-pa", false], "the agent reuses its own tab, which navigate then loads");
  assert.equal(r.pickPreviewTab(null, null, null, "pane-a").id, "agent-pa");
  assert.equal(r.pickPreviewTab(null, null, null, "pane-a2").id, "user-pa", "another agent never takes this agent's tab");
  assert.equal(r.findReusablePreviewTab(null, null, "pane-a2"), null);
  assert.equal(r.pickPreviewTab(null, "run-9", "pa", "pane-a").id, "run-pa", "a run caller is scoped by its run");
  assert.equal(r.pickPreviewTab(null, null, null, "pane-elsewhere").id, "user-pb", "a caller outside every pane keeps the screen's workspace");
  assert.equal(r.pickPreviewTab(null, null, null, null).id, "user-pb");
  console.log("an agent with no run stays in its pane's workspace and on its own tabs");

  assert.equal(r.isAgentOwnedPreviewTab("agent-pa"), true, "a link click could take over the agent's tab");
  assert.equal(r.isAgentOwnedPreviewTab("user-pa"), false);
  assert.equal(r.isAgentOwnedPreviewTab("run-pa"), false);

  assert.equal(r.findPreviewTabByWebContentsId(14).id, "agent-pa");
  assert.equal(r.findPreviewTabByWebContentsId(99), null);
  r.registerPreviewTab({ id: "popup-pa", workspaceId: "pa", url: "u", handle: guestHandle(15) });
  r.inheritPreviewTabOwner("popup-pa", "agent-pa");
  r.unregisterPreviewTab("agent-pa");
  assert.equal(r.findReusablePreviewTab(null, null, "pane-a").id, "popup-pa", "a tab the agent's page opened stays the agent's");
  assert.equal(r.isAgentOwnedPreviewTab("popup-pa"), true);
  assert.equal(r.isAgentOwnedPreviewTab("agent-pa"), false, "a closed tab keeps no owner");
  assert.equal(r.pickPreviewTab(null, null, null, "pane-a2").id, "user-pa");
  console.log("tabs a page opens map back to their source tab and owner");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

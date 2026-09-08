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
  const handle = { getURL: () => "https://example.test/live", getTitle: () => "Live title", showAgentCursor: (value) => activity.push(value) };
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
  assert.equal((await r.ensurePreviewTab("https://new.test", "run-2", "a")).id, "new-a");
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
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

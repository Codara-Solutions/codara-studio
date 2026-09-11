"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const output = await esbuild.build({ entryPoints: [path.join(__dirname, "../src/main/preview-workspace.ts")], bundle: true, write: false, platform: "node", format: "cjs" });
  const mod = { exports: {} };
  new Function("module", "exports", output.outputFiles[0].text)(mod, mod.exports);
  const scope = mod.exports.scopePreviewWorkspace;
  const params = { runId: "run-a", workspaceId: "user-b", tabId: "tab-b" };
  await scope(params, async id => { assert.equal(id, "run-a"); return { workspaceId: "a" }; });
  assert.equal(params.workspaceId, "a", "the run owns routing even if the selected workspace changes");
  for (const run of [null, {}, { workspaceId: "" }]) {
    await assert.rejects(scope({ runId: "deleted", workspaceId: "b" }, async () => run), /workspace could not be resolved/);
  }
  const user = { workspaceId: "b" };
  await scope(user, async () => { throw new Error("user operations need no run"); });
  assert.equal(user.workspaceId, "b");
  console.log("preview routing refuses unresolved runs and preserves explicit user routing");
})().catch(error => { console.error(error); process.exitCode = 1; });

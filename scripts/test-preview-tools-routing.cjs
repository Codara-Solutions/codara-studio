"use strict";
// Every socket method a codara-studio tool module names has exactly one
// handler in src/main/preview-tools/, and browser handlers always run after
// the caller's workspace is resolved.
//
//   node scripts/test-preview-tools-routing.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadPreviewTools(stubs) {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src/main/preview-tools/index.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [{
      name: "stubs",
      setup(build) {
        build.onResolve({ filter: /^@shared\// }, (args) => ({
          path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
        }));
        for (const [name, contents] of Object.entries(stubs)) {
          build.onResolve({ filter: new RegExp(`(^|/)${name}$`) }, () => ({ path: name, namespace: "stub" }));
          build.onLoad({ filter: new RegExp(`^${name}$`), namespace: "stub" }, () => ({ contents, loader: "js" }));
        }
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, (name) => {
    if (name === "electron") return { ipcMain: { on() {} }, BrowserWindow: { getAllWindows: () => [] }, webContents: { fromId: () => null } };
    return require(name);
  });
  return mod.exports;
}

(async () => {
  const calls = [];
  globalThis.__previewToolCalls = calls;
  const tools = await loadPreviewTools({
    "preview-bridge": `module.exports = { requestPreviewOp: async (op, params) => { globalThis.__previewToolCalls.push({ via: "renderer", op, params }); return { op }; } };`,
    "preview-input": `module.exports = { handlePreviewInputOp: async (op, params) => { globalThis.__previewToolCalls.push({ via: "input", op, params }); return { op }; } };`,
    "preview-navigation": `module.exports = { waitForLoopbackPreviewServer: async () => true };`,
  });

  const { toolRegistry } = require(path.join(ROOT, "resources/codara-studio-mcp/tools/index.cjs"));
  const registry = toolRegistry();
  const named = new Set([...Object.values(registry.toRpc), ...Object.values(registry.hiddenToRpc)]);
  const handled = new Set(tools.previewToolMethods());
  for (const rpc of named) assert.ok(handled.has(rpc), `${rpc} is named by a tool module but no preview-tools module handles it`);
  for (const method of handled) {
    if (method.startsWith("preview.")) assert.ok(named.has(method), `${method} is handled but no tool module calls it`);
  }

  const scoped = [];
  const host = {
    async scopeToCaller(params) { scoped.push({ ...params }); params.workspaceId ??= "ws-caller"; },
    async getRun(runId) { return runId === "run-live" ? { workspaceId: "ws-run" } : null; },
    async mayUseUserBrowser(params) { return params.runId !== "run-live"; },
  };
  await tools.runPreviewTool("preview.snapshot", { callerPid: 7 }, host);
  assert.equal(calls.at(-1).params.workspaceId, "ws-caller", "a caller without a run works in its pane's workspace");
  await tools.runPreviewTool("preview.mouse", { runId: "run-live", x: 1, y: 2 }, host);
  assert.equal(calls.at(-1).via, "input");
  assert.equal(calls.at(-1).params.workspaceId, "ws-run", "a run works in its own workspace");
  await assert.rejects(
    tools.runPreviewTool("preview.click", { runId: "run-gone", selector: "#x" }, host),
    /workspace could not be resolved/,
  );
  const before = calls.length;
  await assert.rejects(tools.runPreviewTool("preview.nope", {}, host), /unknown method/);
  assert.equal(calls.length, before);
  assert.equal(scoped.length, 3);
  assert.equal(tools.hasPreviewTool("terminal.run"), false);

  // Tab ids: preview:<id> is the bare id, chrome:<id> reaches only handlers
  // that can drive a Chrome tab, and only for callers allowed to.
  await tools.runPreviewTool("preview.snapshot", { tabId: "preview:tab-9" }, host);
  assert.equal(calls.at(-1).params.tabId, "tab-9");
  const reaching = calls.length;
  await assert.rejects(
    tools.runPreviewTool("preview.snapshot", { tabId: "chrome:12" }, host),
    (error) => error instanceof tools.PreviewToolParamsError && /cannot drive a Chrome tab yet/.test(error.message),
  );
  await assert.rejects(tools.runPreviewTool("preview.click", { tabId: "chrome:twelve" }, host), /not a Chrome tab id/);
  await assert.rejects(
    tools.runPreviewTool("preview.click", { tabId: "chrome:12", runId: "run-live" }, host),
    /may not use tabs of your own browser/,
  );
  assert.equal(calls.length, reaching, "a refused Chrome call reaches no executor");
  console.log(`preview tool routing: ${handled.size} socket methods, each named by a tool module`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

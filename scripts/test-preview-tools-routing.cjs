"use strict";
// Every socket method a codara-studio tool module names has exactly one
// handler in src/main/preview-tools/, and browser handlers always run after
// the caller's workspace is resolved.
//
//   node scripts/test-preview-tools-routing.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadPreviewTools(stubs) {
  const out = await esbuild.build({
    stdin: {
      contents: `export * from "./index"; export { registerBrowserBackend } from "../browser/targets";`,
      resolveDir: path.join(ROOT, "src/main/preview-tools"),
      loader: "ts",
    },
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-routing-home-"));
  const tools = await loadPreviewTools({
    "preview-bridge": `module.exports = { requestPreviewOp: async (op, params) => {
      globalThis.__previewToolCalls.push({ via: "renderer", op, params });
      return op === "screenshot" ? { tabId: "tab-1", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } : op === "list" ? { op, tabs: [] } : { op };
    } };`,
    "codara-home": `module.exports = { codaraHome: () => ${JSON.stringify(home)} };`,
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

  // A connected Chrome adds its tabs to the list, for callers allowed to use them.
  const unregister = tools.registerBrowserBackend({
    kind: "chrome",
    async resolve() { throw new Error("unused"); },
    async list() { return [{ id: "chrome:12", kind: "chrome", title: "Mail", url: "https://mail.example/" }]; },
  });
  const listed = await tools.runPreviewTool("preview.list", { callerPid: 7 }, host);
  assert.deepEqual(listed, { op: "list", tabs: [{ id: "chrome:12", kind: "chrome", title: "Mail", url: "https://mail.example/" }] });
  const runListed = await tools.runPreviewTool("preview.list", { runId: "run-live" }, host);
  assert.deepEqual(runListed.tabs, [], "a caller that may not use the user's browser does not see its tabs");
  unregister();

  // A screenshot is also a file in the workspace's data folder, for agents
  // that cannot read image content.
  const shot = await tools.runPreviewTool("preview.screenshot", { callerPid: 7 }, host);
  assert.ok(shot.path.startsWith(path.join(home, "workspace-data", "ws-caller", "browser", "screenshots")), shot.path);
  assert.deepEqual(fs.readFileSync(shot.path), Buffer.from("iVBORw0KGgo=", "base64"));
  assert.equal(shot.dataUrl, "data:image/png;base64,iVBORw0KGgo=");
  fs.rmSync(home, { recursive: true, force: true });

  // A handler that runs commands marks itself trustedRunsOnly, and the
  // socket's imported pull-request gate refuses it without an edit there.
  assert.deepEqual(
    tools.previewToolMethods().filter((method) => tools.previewToolRefusesUntrustedRuns(method)),
    ["terminal.servers"],
    "only the dev-server tool starts commands",
  );
  const flagged = await loadPreviewTools({
    servers: `module.exports = { serverTools: { "servers.start": { run: async () => ({}), scope: "none", trustedRunsOnly: true } } };`,
  });
  assert.equal(flagged.previewToolRefusesUntrustedRuns("servers.start"), true);
  assert.equal(flagged.previewToolRefusesUntrustedRuns("preview.snapshot"), false);
  const socket = fs.readFileSync(path.join(ROOT, "src/main/agent-socket.ts"), "utf8");
  const gate = /function isUntrustedPullRequestBlockedMethod[\s\S]*?\n}\n/.exec(socket);
  assert.ok(gate && gate[0].includes("previewToolRefusesUntrustedRuns(method)"), "the socket's imported pull-request gate asks the preview tools");
  console.log(`preview tool routing: ${handled.size} socket methods, each named by a tool module`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

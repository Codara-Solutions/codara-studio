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
      contents: `export * from "./index"; export { registerBrowserBackend, resolveBrowserTarget } from "../browser/targets"; export { recordActedTab, withActedTab } from "../browser/acted-tab";`,
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
    if (name === "electron") {
      const image = (buffer) => ({ getSize: () => ({ width: 1, height: 1 }), crop: () => image(buffer), resize: () => image(buffer), toPNG: () => buffer, toJPEG: () => buffer });
      return {
        ipcMain: { on() {} },
        BrowserWindow: { getAllWindows: () => [] },
        webContents: { fromId: () => null },
        nativeImage: { createFromBuffer: image },
      };
    }
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
  const named9 = await tools.runPreviewTool("preview.snapshot", { tabId: "preview:tab-9" }, host);
  assert.equal(calls.at(-1).params.tabId, "tab-9");
  assert.equal(named9.tabId, "tab-9", "a result names the tab it acted on");
  const reaching = calls.length;
  await assert.rejects(
    tools.runPreviewTool("preview.snapshot", { tabId: "chrome:12" }, host),
    /No Chrome browser is connected/,
    "a Chrome tab id reaches the Chrome version of the tool, which needs a connected browser",
  );
  // Every browser tool that names a tab works on a Chrome tab: either its
  // handler resolves any target, or chrome.ts has its Chrome version.
  for (const method of named) {
    if (!method.startsWith("preview.") || ["preview.list", "preview.inbox"].includes(method)) continue;
    await assert.rejects(
      tools.runPreviewTool(method, { tabId: "chrome:12", action: "close" }, host),
      (error) => !/cannot drive a Chrome tab yet/.test(error.message),
      `${method} has no Chrome version`,
    );
  }
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

  // The tab a call resolved is recorded in the call's async context, so a
  // result names it even when the handler's own value does not.
  const unregisterActed = tools.registerBrowserBackend({
    kind: "preview",
    async resolve(ref) { return { kind: "preview", ref: ref?.tabId ?? "tab-5", workspaceId: null }; },
  });
  const acted = await tools.recordActedTab(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await tools.resolveBrowserTarget({});
    await tools.resolveBrowserTarget({ tabId: "tab-6" });
    return { ok: true };
  });
  assert.deepEqual(acted, { value: { ok: true }, tabId: "tab-5" }, "the first tab resolved is the one reported");
  assert.equal((await tools.recordActedTab(async () => ({ ok: true }))).tabId, null);
  unregisterActed();
  assert.deepEqual(tools.withActedTab({ value: 1 }, "tab-2"), { tabId: "tab-2", value: 1 });
  assert.deepEqual(tools.withActedTab({ tabId: "tab-3" }, "tab-2"), { tabId: "tab-3" }, "a result that names its tab keeps it");
  assert.deepEqual(tools.withActedTab({ tabs: [] }, "tab-2"), { tabs: [] }, "a list of tabs is not one tab's result");
  assert.deepEqual(tools.withActedTab([1], "tab-2"), [1]);
  assert.equal(tools.withActedTab("text", "tab-2"), "text");
  assert.deepEqual(tools.withActedTab({ value: 1 }, null), { value: 1 });

  // A screenshot runs on the tab's browser target, in the caller's
  // workspace, and is also a file in that workspace's data folder, for
  // agents that cannot read image content.
  const png = Buffer.from("iVBORw0KGgo=", "base64");
  const unregisterPreview = tools.registerBrowserBackend({
    kind: "preview",
    async resolve(ref, params) {
      return {
        kind: "preview",
        ref: "tab-1",
        workspaceId: params.workspaceId,
        session: { send: async () => ({}) },
        info: async () => ({ ref: "tab-1", kind: "preview", url: "http://localhost/", title: "Fixture", viewport: { width: 1, height: 1 }, devicePixelRatio: 1 }),
        evaluate: async () => null,
        captureViewport: async () => png,
        showActivity: async () => {},
      };
    },
  });
  const shot = await tools.runPreviewTool("preview.screenshot", { callerPid: 7, format: "png" }, host);
  unregisterPreview();
  assert.ok(shot.path.startsWith(path.join(home, "workspace-data", "ws-caller", "browser", "screenshots")), shot.path);
  assert.deepEqual(fs.readFileSync(shot.path), png);
  assert.equal(shot.dataUrl, "data:image/png;base64,iVBORw0KGgo=");
  fs.rmSync(home, { recursive: true, force: true });

  // A handler that runs commands, writes what the user reads outside the
  // tab (the workspace status in the rail) or reads the person's past agent
  // sessions marks itself trustedRunsOnly, and the socket's imported
  // pull-request gate refuses it without an edit there.
  assert.deepEqual(
    tools.previewToolMethods().filter((method) => tools.previewToolRefusesUntrustedRuns(method)),
    ["terminal.servers", "workspace.status", "session.search"],
    "only the dev-server tool starts commands, only the workspace status writes the rail, only session search reads past sessions",
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

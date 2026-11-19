"use strict";
// The capability table of the user's own browser (src/shared/user-browser-tools.ts):
// every browser tool the studio server offers has a row, docs/mcp-tools.md
// shows the table as it is, and on a Firefox tab a tool or mode marked
// "not available" is refused with the table's reason before anything is
// sent, while Chrome tabs and the tools that work are left alone.
//
//   node scripts/test-user-browser-tools.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load(home) {
  const stubs = {
    "preview-bridge": `module.exports = { requestPreviewOp: async (op) => { throw new Error("no renderer in this test: " + op); } };`,
    "codara-home": `module.exports = { codaraHome: () => ${JSON.stringify(home)} };`,
    "preview-input": `module.exports = { handlePreviewInputOp: async () => ({}) };`,
    "preview-navigation": `module.exports = { waitForLoopbackPreviewServer: async () => true };`,
  };
  const out = await esbuild.build({
    stdin: {
      contents: [
        `export * from "./index";`,
        `export { registerBrowserBackend } from "../browser/targets";`,
        `export { setChromeLinkRuntime } from "../browser/chrome/runtime";`,
        `export * from "../../shared/user-browser-tools";`,
      ].join("\n"),
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
        build.onResolve({ filter: /^@shared\// }, (args) => ({ path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`) }));
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
      return { ipcMain: { on() {} }, BrowserWindow: { getAllWindows: () => [] }, webContents: { fromId: () => null }, nativeImage: { createFromBuffer: () => ({}) } };
    }
    return require(name);
  });
  return mod.exports;
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-user-browser-tools-"));
  try {
    const lib = await load(home);
    const table = lib.USER_BROWSER_TOOLS;

    // Every browser tool has a row, and every row is a tool the server offers.
    const { toolRegistry } = require(path.join(ROOT, "resources/codara-studio-mcp/tools/index.cjs"));
    const registry = toolRegistry();
    const rpcOf = { ...registry.toRpc, ...registry.hiddenToRpc };
    // Browser tools: those served by a preview.* handler or browser.use, and those the server runs itself (codara_preview_run).
    const names = new Set([...registry.tools.map((tool) => tool.name), ...Object.keys(rpcOf)]);
    const browserTools = [...names].filter((name) => (rpcOf[name] ? rpcOf[name].startsWith("preview.") || rpcOf[name] === "browser.use" : name.startsWith("codara_preview_")));
    assert.ok(browserTools.length >= 36, `the registry lists the browser tools (${browserTools.length})`);
    for (const name of browserTools) {
      assert.ok(table[name], `${name} has no row in src/shared/user-browser-tools.ts`);
      if (rpcOf[name]) assert.equal(lib.toolNameOf(rpcOf[name]), name, `${rpcOf[name]} names ${name}`);
    }
    for (const name of Object.keys(table)) assert.ok(browserTools.includes(name), `${name} is in the table but the studio server has no such tool`);
    const statuses = ["works", "degraded", "not available", "not applicable"];
    for (const [name, row] of Object.entries(table)) {
      for (const browser of ["chrome", "firefox"]) {
        assert.ok(statuses.includes(row[browser].status), `${name} ${browser} status`);
        assert.ok(row[browser].how.trim().length > 10, `${name} ${browser} says how or why`);
      }
      if (row.firefox.unavailable) assert.ok(row.modeParam, `${name} names the parameter that picks its modes`);
    }
    assert.match(lib.USER_BROWSER_DISTRIBUTION.firefox, /Temporary install only/);

    // The docs show the table as it is.
    const docs = fs.readFileSync(path.join(ROOT, "docs/mcp-tools.md"), "utf8");
    const shown = docs.split("<!-- user-browser-tools:start -->\n")[1]?.split("\n<!-- user-browser-tools:end -->")[0];
    assert.equal(shown, lib.userBrowserToolsMarkdown(), "docs/mcp-tools.md has the table as src/shared/user-browser-tools.ts makes it: paste userBrowserToolsMarkdown() between the markers");

    // Dispatch: one connected browser, Chrome or Firefox, sharing tab 12.
    const resolved = [];
    let kind = "firefox";
    let findable = true;
    const backend = {
      kind: "chrome",
      locate(ref) {
        if (!findable) throw new Error("not shared");
        return { link: { extensionKind: kind }, tab: { tabId: ref.tabId } };
      },
      summaries: () => [],
    };
    const links = () => [{ extensionKind: kind, allowOpen: false, tabs: new Map(), browser: { name: kind, version: "" } }];
    lib.setChromeLinkRuntime({ server: { links }, backend });
    const unregister = lib.registerBrowserBackend({
      kind: "chrome",
      async resolve(ref) {
        resolved.push(ref);
        throw new Error("reached the browser");
      },
      async list() { return []; },
    });
    const host = { async scopeToCaller() {}, async getRun() { return null; }, async mayUseUserBrowser() { return true; } };
    const call = (method, params) => lib.runPreviewTool(method, { callerPid: 7, tabId: "chrome:12", ...params }, host);
    const refused = async (method, params, pattern) => {
      const before = resolved.length;
      await assert.rejects(call(method, params), pattern, `${method} ${JSON.stringify(params)} is refused`);
      assert.equal(resolved.length, before, `${method} sends nothing to the browser`);
    };
    const reaches = async (method, params) => {
      const before = resolved.length;
      await call(method, params).catch(() => {});
      assert.ok(resolved.length > before, `${method} ${JSON.stringify(params)} reaches the browser`);
    };

    // On a Firefox tab: every tool marked not available, with the table's reason.
    const notAvailable = Object.entries(table).filter(([, row]) => row.firefox.status === "not available").map(([name]) => name);
    assert.deepEqual(notAvailable.sort(), ["codara_preview_audit", "codara_preview_close", "codara_preview_dialog", "codara_preview_emulate", "codara_preview_performance", "codara_preview_record", "codara_preview_resize"]);
    for (const name of notAvailable) {
      await refused(rpcOf[name], { action: "vitals", preset: "mobile", width: 400, height: 600 }, (error) => error.message === `${name} is not available on a Firefox tab: ${table[name].firefox.how}`);
    }
    await refused("preview.emulate", {}, /Emulation needs the DevTools protocol, and Firefox gives extensions no debugger/);
    // A mode: compare sizes is refused, its other modes run.
    await refused("preview.compare", { mode: "sizes" }, /codara_preview_compare sizes is not available on a Firefox tab: Screen sizes resize the page/);
    await reaches("preview.compare", { mode: "list" });
    await refused("preview.chrome", { action: "close" }, /codara_preview_chrome close is not available on a Firefox tab/);
    // What works or degrades runs.
    for (const method of ["preview.snapshot", "preview.click", "preview.screenshot", "preview.console", "preview.storage", "preview.navigate"]) {
      await reaches(method, { selector: "#a", url: "https://example.com/", action: "get" });
    }
    // open has no tab: the Firefox extension's reason, not the popup switch Firefox hides.
    await assert.rejects(call("preview.chrome", { action: "open", url: "https://example.com/", tabId: undefined }), /codara_preview_chrome open is not available on a Firefox tab: Opening tabs is not available in Firefox yet/);

    // A tab that cannot be found is left to the handler, which says why.
    findable = false;
    await reaches("preview.emulate", { preset: "mobile" });
    findable = true;

    // On a Chrome tab nothing is refused by the table.
    kind = "chromium";
    for (const name of notAvailable) await reaches(rpcOf[name], { action: "vitals", preset: "mobile", width: 400, height: 600 });
    await reaches("preview.compare", { mode: "sizes" });
    await assert.rejects(call("preview.chrome", { action: "open", url: "https://example.com/", tabId: undefined }), /has not let agents open tabs/);
    unregister();
    lib.setChromeLinkRuntime(null);

    console.log(`user browser tools: ${Object.keys(table).length} tools, Chrome and Firefox; the docs show the table; Firefox tabs refuse ${notAvailable.length} tools and the modes marked, with the table's reason, before anything is sent`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

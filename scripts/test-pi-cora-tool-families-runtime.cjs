#!/usr/bin/env node
// Drives resources/pi-cora/index.ts against a fake Pi host to cover the
// on-demand Studio tool families end to end: a session starts with the
// families hidden, a session's first request loads what it plainly needs, a
// later turn loads through codara_tools, and a session switch that hides the
// families again cannot leave codara_tools reporting tools the next request
// does not carry.
//
//   node scripts/test-pi-cora-tool-families-runtime.cjs

"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function loadExtension() {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, "resources", "pi-cora", "index.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [{
      name: "extension-host",
      setup(build) {
        build.onResolve({ filter: /^node:module$/ }, () => ({ path: "bridge", namespace: "fixture" }));
        build.onResolve(
          { filter: /^\.\/(compaction|service-tier|deep-search|mcp-bridge)$/ },
          () => ({ path: "services", namespace: "fixture" }),
        );
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: id }) => ({
          contents: id === "bridge"
            ? "export const createRequire = () => () => globalThis.toolFamilyTestBridge;"
            : "export const registerContextCompaction = () => {}; export const registerServiceTierPolicy = () => {}; export const registerDeepSearch = () => {}; export const activeMcpBridgeConfig = () => null; export const registerMcpBridge = () => null;",
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports.default;
}

const WHITEBOARD = ["codara_whiteboard_get", "codara_whiteboard_update"];
const BROWSER = ["codara_preview_navigate"];

async function main() {
  const extension = await loadExtension();
  globalThis.toolFamilyTestBridge = {
    listTools: () =>
      [...WHITEBOARD, ...BROWSER, "codara_complete"].map((name) => ({
        name,
        description: `${name}. Longer detail that the snippet drops.`,
        inputSchema: {},
      })),
    callToolByName: async () => ({ content: [{ type: "text", text: "{}" }] }),
  };
  process.env.CODARA_PI_BRIDGE_PATH = "test-bridge";
  process.env.CODARA_PI_CHAT_MODE = "auto";

  const hooks = new Map();
  const registered = new Map();
  let active = [];
  let setCalls = 0;
  extension({
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(tool) {
      registered.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools(names) {
      setCalls += 1;
      active = [...names];
    },
    getAllTools: () => [...registered.values()].map((tool) => ({ name: tool.name })),
    sendMessage() {},
  });
  const emit = async (name, event, branch) => {
    const ctx = { sessionManager: { getBranch: () => branch }, model: undefined };
    for (const handler of hooks.get(name) ?? []) await handler(event, ctx);
  };
  const isActive = (names) => names.every((name) => active.includes(name));
  const isHidden = (names) => names.every((name) => !active.includes(name));

  assert.ok(registered.has("codara_tools"), "the loader is registered when families exist");
  assert.equal(registered.get("codara_whiteboard_get").promptSnippet, undefined, "deferred tools carry no snippet");
  assert.match(registered.get("codara_complete").promptSnippet, /^codara_complete\.$/, "core tools get a one-line snippet");

  // 1. A fresh session hides every family.
  await emit("session_start", {}, []);
  assert.ok(isHidden([...WHITEBOARD, ...BROWSER]));
  assert.ok(active.includes("codara_complete") && active.includes("codara_tools"));

  // 2. Before the first model request, a request that plainly needs a family
  // loads it for free.
  await emit("before_agent_start", { prompt: "Draw the auth flow as a diagram" }, []);
  assert.ok(isActive(WHITEBOARD));
  assert.ok(isHidden(BROWSER));

  // 3. Once the session has an assistant turn, request text no longer loads
  // anything: changing the tool list there would invalidate the cached prefix.
  const withTurn = [{ type: "message", message: { role: "assistant", content: [] } }];
  await emit("before_agent_start", { prompt: "now open the browser preview" }, withTurn);
  assert.ok(isHidden(BROWSER));

  // 4. codara_tools loads a family on a later turn and returns its guidance.
  const loaded = await registered.get("codara_tools").execute("load", { families: ["browser"] });
  assert.ok(isActive(BROWSER));
  assert.match(loaded.content[0].text, /## browser/);
  assert.match(loaded.content[0].text, /codara_preview_navigate/);

  // 5. A session switch hides the families again; loading the same family a
  // second time must re-activate its tools, not trust an earlier load.
  await emit("session_start", {}, []);
  assert.ok(isHidden([...WHITEBOARD, ...BROWSER]));
  const callsBefore = setCalls;
  await registered.get("codara_tools").execute("reload", { families: ["browser"] });
  assert.ok(isActive(BROWSER), "a family hidden by a session switch loads again");
  assert.equal(setCalls, callsBefore + 1);
  await registered.get("codara_tools").execute("again", { families: ["browser"] });
  assert.equal(setCalls, callsBefore + 1, "an already active family does not rewrite the tool list");

  // 6. A resumed session keeps the families its transcript already used.
  const resumed = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "codara_whiteboard_update" }] } },
  ];
  await emit("session_start", {}, resumed);
  assert.ok(isActive(WHITEBOARD), "a family the transcript used is active again, even after a session hid it");
  assert.ok(isHidden(BROWSER));

  await assert.rejects(registered.get("codara_tools").execute("empty", { families: [] }), /Name at least one family/);

  // 7. Automation mode keeps its automations family active, but the shared
  // prompt still says to load it, so the loader accepts it as a no-op.
  globalThis.toolFamilyTestBridge = {
    listTools: () =>
      ["codara_create_automation", ...BROWSER].map((name) => ({
        name,
        description: `${name}. Longer detail that the snippet drops.`,
        inputSchema: {},
      })),
    callToolByName: async () => ({ content: [{ type: "text", text: "{}" }] }),
  };
  process.env.CODARA_PI_CHAT_MODE = "automation";
  const automationTools = new Map();
  extension({
    on() {},
    registerTool(tool) { automationTools.set(tool.name, tool); },
    getActiveTools: () => [...automationTools.keys()],
    setActiveTools() {},
    getAllTools: () => [...automationTools.values()].map((tool) => ({ name: tool.name })),
    sendMessage() {},
  });
  const loader = automationTools.get("codara_tools");
  assert.ok(loader.parameters.properties.families.items.enum.includes("automations"));
  const automations = await loader.execute("automations", { families: ["automations"] });
  assert.match(automations.content[0].text, /## automations/);
  process.env.CODARA_PI_CHAT_MODE = "auto";

  delete globalThis.toolFamilyTestBridge;
  console.log("pi-cora tool families (session start, first request, loader, session switch): ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

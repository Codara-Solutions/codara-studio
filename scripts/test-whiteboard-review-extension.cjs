"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const output = await esbuild.build({
    entryPoints: [path.resolve("resources/pi-cora/index.ts")], bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "extension-host", setup(build) {
      build.onResolve({ filter: /^node:module$/ }, () => ({ path: "bridge", namespace: "fixture" }));
      build.onResolve({ filter: /^\.\/(compaction|service-tier|deep-search|mcp-bridge)$/ }, () => ({ path: "services", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "bridge"
        ? "export const createRequire = () => () => globalThis.whiteboardTestBridge;"
        : "export const registerContextCompaction = () => {}; export const registerServiceTierPolicy = () => {}; export const registerDeepSearch = () => {}; export const activeMcpBridgeConfig = () => null; export const registerMcpBridge = () => null;" }));
    } }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  const hooks = new Map();
  const registered = new Map();
  const followUps = [];
  let board = { revision: 1 };
  let failed = false;
  globalThis.whiteboardTestBridge = {
    listTools: () => ["codara_whiteboard_update", "codara_whiteboard_review", "codara_complete"].map((name) => ({ name, description: name, inputSchema: {} })),
    callToolByName: async () => ({ isError: failed, content: [{ type: "text", text: JSON.stringify({ ok: !failed, whiteboard: board }) }] }),
  };
  process.env.CODARA_PI_BRIDGE_PATH = "test-bridge";
  mod.exports.default({
    on(name, handler) { hooks.set(name, [...(hooks.get(name) ?? []), handler]); },
    registerTool(tool) { registered.set(tool.name, tool); },
    sendMessage(message, options) { followUps.push({ message, options }); },
  });
  const emit = async (name, event = {}) => { for (const handler of hooks.get(name) ?? []) await handler(event, {}); };
  await registered.get("codara_whiteboard_update").execute("update", {});
  await assert.rejects(registered.get("codara_complete").execute("complete", {}), /still a draft/);
  await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(followUps.length, 1, "ending after a draft schedules actual extension follow-up work");
  assert.equal(followUps[0].options.triggerTurn, true);
  assert.equal(followUps[0].options.deliverAs, "followUp");
  board = { revision: 1, review: { revision: 1 } };
  await registered.get("codara_whiteboard_review").execute("review", {});
  await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(followUps.length, 1, "reviewed boards do not create another turn");
  await registered.get("codara_complete").execute("complete", {});
  await emit("input");
  board = { revision: 2 };
  await registered.get("codara_whiteboard_update").execute("update", {});
  await emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  assert.equal(followUps.length, 1, "an interrupted agent must not restart itself");
  await emit("input");
  failed = true;
  await assert.rejects(registered.get("codara_whiteboard_update").execute("failed", {}));
  await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  assert.equal(followUps.length, 1, "failed writes do not schedule review work");
  delete globalThis.whiteboardTestBridge;
  console.log("whiteboard manager extension continuation and completion tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

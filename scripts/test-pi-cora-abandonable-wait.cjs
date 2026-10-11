#!/usr/bin/env node
// Drives resources/pi-cora/index.ts against a fake Pi host to pin which Studio
// calls an interrupted Cora turn may walk away from. Pi waits for a running
// tool before an aborted turn goes idle, so Stop and Send now keep the Pi
// process only when a long wait hands its abort to the bridge. Every other
// Studio call may already be changing the run and must finish.
//
//   node scripts/test-pi-cora-abandonable-wait.cjs

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
            ? "export const createRequire = () => () => globalThis.abandonableWaitTestBridge;"
            : "export const registerContextCompaction = () => {}; export const registerServiceTierPolicy = () => {}; export const registerDeepSearch = () => {}; export const activeMcpBridgeConfig = () => null; export const registerMcpBridge = () => null;",
        }));
      },
    }],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports.default;
}

const TOOLS = ["codara_wait_for_workers", "codara_wait_for_automation", "codara_spawn_workers", "codara_ask_user"];

async function main() {
  const extension = await loadExtension();
  const calls = [];
  globalThis.abandonableWaitTestBridge = {
    listTools: () => TOOLS.map((name) => ({ name, description: `${name}.`, inputSchema: {} })),
    callToolByName: async (name, _args, signal) => {
      calls.push({ name, signal });
      return { content: [{ type: "text", text: "{}" }] };
    },
  };
  process.env.CODARA_PI_BRIDGE_PATH = "test-bridge";
  process.env.CODARA_PI_CHAT_MODE = "auto";

  const registered = new Map();
  let active = [];
  extension({
    on() {},
    registerTool(tool) {
      registered.set(tool.name, tool);
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools(names) {
      active = [...names];
    },
    getAllTools: () => [...registered.values()].map((tool) => ({ name: tool.name })),
    sendMessage() {},
  });

  const turn = new AbortController();
  for (const name of TOOLS) {
    assert.ok(registered.has(name), `${name} is registered`);
    await registered.get(name).execute(`call-${name}`, {}, turn.signal);
  }
  const signalOf = (name) => calls.find((call) => call.name === name)?.signal;
  assert.equal(signalOf("codara_wait_for_workers"), turn.signal, "a worker wait follows the turn's abort");
  assert.equal(signalOf("codara_wait_for_automation"), turn.signal, "an automation wait follows the turn's abort");
  assert.equal(signalOf("codara_spawn_workers"), undefined, "a spawn always finishes");
  assert.equal(signalOf("codara_ask_user"), undefined, "a question always finishes");

  console.log("PASS only Studio waits follow an interrupted turn's abort");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

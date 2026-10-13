"use strict";
// The codara-studio tool modules, the rosters server.js builds from them, and
// the manifest the Capability Center reads must agree. A tool module added
// under resources/codara-studio-mcp/tools/ reaches every roster and the card
// with no other edit; this suite fails when that stops being true.
//
//   node scripts/test-mcp-tool-manifest.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "resources", "codara-studio-mcp", "server.js");
const TOOLS_DIR = path.join(ROOT, "resources", "codara-studio-mcp", "tools");
const { buildRegistry } = require(path.join(TOOLS_DIR, "index.cjs"));

const MODES = [
  {},
  { SPARK_RUN_ID: "run-1" },
  { SPARK_RUN_ID: "run-1", CODARA_PI_DIRECT_TASK: "1" },
  { SPARK_MCP_MODE: "execute", SPARK_RUN_ID: "run-1" },
  { SPARK_MCP_MODE: "automation", SPARK_RUN_ID: "run-1" },
  { SPARK_MCP_MODE: "worker", SPARK_RUN_ID: "run-1" },
];

function listedTools(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-manifest-"));
  try {
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const result = spawnSync(process.execPath, [SERVER], {
      input,
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, CODARA_HOME_DIR: home, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    return lines.find((line) => line.id === 2).result.tools;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// 1. The module contract.
const registry = buildRegistry();
const moduleFiles = fs.readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".cjs") && file !== "index.cjs");
assert.deepEqual(
  registry.modules.map((mod) => mod.file).sort(),
  moduleFiles.sort(),
  "every .cjs file in tools/ is a module the registry loads",
);
for (const tool of registry.tools) {
  for (const field of ["rpc", "annotations", "step", "hidden"]) {
    assert.ok(!(field in tool), `${tool.name} leaks the registry field ${field} into the MCP definition`);
  }
  assert.ok(!/claude/i.test(JSON.stringify(tool)), `${tool.name} must not mention one agent runtime`);
}
for (const [action, rpc] of Object.entries(registry.stepActionToRpc)) {
  assert.equal(registry.toRpc[`codara_preview_${action}`], rpc, `run step ${action} fires the same RPC as its tool`);
}
const run = registry.tools.find((tool) => tool.name === "codara_preview_run");
assert.deepEqual(
  run.inputSchema.properties.steps.items.properties.action.enum,
  Object.keys(registry.stepActionToRpc),
  "the run tool lists exactly the registered step actions",
);

// Every session re-sends the tool list on each request, so each module spends
// at most its own budget and the budgets together stay under one cap. A
// module that needs more takes it from another module's budget; raising the
// cap raises every session's cost (the roster budgets in
// test-codara-studio-mcp.cjs follow it).
const TOOL_MODULES_BUDGET = 18_300;
let budgeted = 0;
for (const mod of registry.modules) {
  assert.equal(typeof mod.budget, "number", `${mod.file} declares its budget`);
  assert.ok(mod.chars <= mod.budget, `${mod.file} uses ${mod.chars} characters, over its budget of ${mod.budget}`);
  budgeted += mod.budget;
}
assert.ok(budgeted <= TOOL_MODULES_BUDGET, `tool module budgets add up to ${budgeted}, over the cap of ${TOOL_MODULES_BUDGET}`);

// A module dropped into a copy of the folder is picked up with no other edit,
// and the registry rejects the mistakes that would break a roster.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codara-tool-modules-"));
const freshRegistry = () => {
  for (const key of Object.keys(require.cache)) if (key.startsWith(scratch)) delete require.cache[key];
  return require(path.join(scratch, "index.cjs")).buildRegistry(scratch);
};
try {
  fs.cpSync(TOOLS_DIR, scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "zz-probe.cjs"), `module.exports = { order: 55, instructions: "Probe guidance.", tools: [
    { name: "codara_preview_probe", rpc: "preview.probe", annotations: { readOnly: true }, step: { order: 500, properties: { depth: { type: "number" } } },
      description: "Probe.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  ] };\n`);
  const probed = freshRegistry();
  assert.ok(probed.families.browser.includes("codara_preview_probe"));
  assert.equal(probed.toRpc.codara_preview_probe, "preview.probe");
  assert.ok(probed.annotations.readOnly.has("codara_preview_probe"));
  assert.equal(probed.stepActionToRpc.probe, "preview.probe");
  const probedRun = probed.tools.find((tool) => tool.name === "codara_preview_run");
  assert.ok(probedRun.inputSchema.properties.steps.items.properties.action.enum.includes("probe"));
  assert.deepEqual(probedRun.inputSchema.properties.steps.items.properties.depth, { type: "number" });
  assert.deepEqual(probed.instructions, ["Probe guidance."]);
  const index = probed.tools.findIndex((tool) => tool.name === "codara_preview_probe");
  assert.ok(index > probed.tools.findIndex((tool) => tool.name === "codara_preview_resize"), "modules list in order");
  assert.ok(index < probed.tools.findIndex((tool) => tool.name === "codara_preview_run"));

  fs.writeFileSync(path.join(scratch, "zz-probe.cjs"), `module.exports = { order: 55, tools: [
    { name: "codara_preview_list", rpc: "preview.list", description: "Again.", inputSchema: { type: "object" } },
  ] };\n`);
  assert.throws(() => freshRegistry(), /duplicate tool codara_preview_list/);
  fs.writeFileSync(path.join(scratch, "zz-probe.cjs"), `module.exports = { order: 55, tools: [
    { name: "codara_other_step", rpc: "preview.other", step: { order: 1 }, description: "x", inputSchema: { type: "object" } },
  ] };\n`);
  assert.throws(() => freshRegistry(), /cannot be a run step/);
  fs.writeFileSync(path.join(scratch, "zz-probe.cjs"), `module.exports = { order: 55, tools: [
    { name: "codara_preview_norpc", description: "x", inputSchema: { type: "object" } },
  ] };\n`);
  assert.throws(() => freshRegistry(), /needs an rpc/);
  fs.writeFileSync(path.join(scratch, "zz-probe.cjs"), `module.exports = { order: 55, budget: "lots", tools: [] };\n`);
  assert.throws(() => freshRegistry(), /budget must be a number/);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

// 2. The manifest is exactly what the rosters can list.
const manifest = require(SERVER).toolManifest();
const manifestNames = new Set(Object.values(manifest).flat());
assert.equal(manifestNames.size, Object.values(manifest).flat().length, "a tool belongs to one family");
for (const name of registry.tools.map((tool) => tool.name)) {
  assert.ok(manifestNames.has(name), `${name} from the tool modules is in the manifest`);
}
const everListed = new Set();
for (const env of MODES) {
  for (const tool of listedTools(env)) {
    assert.ok(manifestNames.has(tool.name), `${tool.name} (listed with ${JSON.stringify(env)}) is missing from the manifest`);
    everListed.add(tool.name);
  }
}
for (const name of manifestNames) {
  assert.ok(everListed.has(name), `${name} is in the manifest but no roster lists it`);
}

// Every roster that has the browser carries all of it: the same tools for
// Claude Code, Codex, Grok, Cora and her workers.
for (const env of MODES) {
  const names = new Set(listedTools(env).map((tool) => tool.name));
  if (!names.has("codara_preview_list")) continue;
  for (const name of manifest.browser) assert.ok(names.has(name), `${name} is missing with ${JSON.stringify(env)}`);
}

// 3. The installer keeps no list of its own.
const installer = fs.readFileSync(path.join(ROOT, "src", "main", "mcp-installer.ts"), "utf8");
assert.doesNotMatch(installer, /"codara_[a-z_]+"/, "mcp-installer.ts must not hand-keep tool names");
assert.match(installer, /toolManifest/, "mcp-installer.ts reads the server's manifest");

// 4. A browser tool that changes the page is fenced for read-only workers
// (resources/pi-cora/worker-policy.ts), or is listed here as safe for them.
// A new tool that does neither fails here until someone decides.
const FENCE_EXEMPT = new Set([
  "codara_preview_navigate",
  "codara_preview_scroll",
  "codara_preview_hover",
  "codara_preview_resize",
  "codara_preview_inbox",
  // Reloads the page to trace it, as navigate loads one; it never types or clicks.
  "codara_preview_performance",
]);
const policyBundle = require("esbuild").buildSync({
  entryPoints: [path.join(ROOT, "resources", "pi-cora", "worker-policy.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
}).outputFiles[0].text;
const policyModule = { exports: {} };
new Function("module", "exports", "require", policyBundle)(policyModule, policyModule.exports, require);
const readonlyFence = policyModule.exports.fencedToolNames({ CODARA_PI_WORKER_ACCESS: "readonly" });
for (const name of manifest.browser) {
  if (registry.annotations.readOnly.has(name)) {
    assert.ok(!FENCE_EXEMPT.has(name), `${name} is read-only; drop it from FENCE_EXEMPT`);
    continue;
  }
  assert.ok(
    readonlyFence.has(name) !== FENCE_EXEMPT.has(name),
    readonlyFence.has(name)
      ? `${name} is fenced; drop it from FENCE_EXEMPT`
      : `${name} changes the page: add it to FENCE_BRIDGE_MUTATING in resources/pi-cora/worker-policy.ts, mark it readOnly, or list it in FENCE_EXEMPT`,
  );
}

// Terminal tools run commands, so every fenced worker loses all of them.
const shellFence = policyModule.exports.fencedToolNames({ CODARA_PI_WORKER_ACCESS: "edits" });
for (const name of Object.values(manifest).flat()) {
  if (name.startsWith("codara_terminal_")) {
    assert.ok(shellFence.has(name), `${name} runs commands: add it to FENCE_BRIDGE_SHELL in resources/pi-cora/worker-policy.ts`);
  }
}

console.log(`mcp tool manifest: ${manifestNames.size} tools in ${Object.keys(manifest).length} families, ${registry.modules.length} tool modules`);

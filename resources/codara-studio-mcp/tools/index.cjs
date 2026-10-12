"use strict";

// Registry of the tool modules in this folder. server.js builds its rosters
// from what this returns, and the Capability Center reads the same list
// through server.js's toolManifest(), so a module that adds a tool needs no
// edit anywhere else.
//
// A module is any `*.cjs` file next to this one. Helpers shared by modules go
// in ./lib/. A module exports:
//
//   {
//     order: 40,              // modules list their tools in ascending order
//     family: "browser",      // optional, default "browser"; see FAMILIES
//     instructions: "...",    // optional, appended to the initialize text
//     tools: [entry, ...],
//   }
//
// and each entry is an MCP tool definition plus fields this registry strips:
//
//   {
//     name: "codara_preview_console",  // codara_ prefix; browser tools use
//                                      // codara_preview_ so Cora's browser
//                                      // family and worker fences include them
//     rpc: "preview.console",          // agent-socket method the call forwards to
//     description, inputSchema,        // sent to the model as they are
//     annotations: { readOnly, destructive, idempotent, openWorld },
//     step: { order: 130, properties: { ... } },
//                                      // callable as a codara_preview_run step
//                                      // named after the tool; properties are
//                                      // the step fields the run schema lacks
//     hidden: true,                    // callable but not listed
//   }
//
// An entry without rpc is handled inside server.js (only codara_preview_run).

const fs = require("node:fs");
const path = require("node:path");

const FAMILIES = new Set(["browser", "studio"]);
const STRIPPED_FIELDS = new Set(["rpc", "annotations", "step", "hidden"]);
const LOCAL_TOOLS = new Set(["codara_preview_run"]);
const RUN_TOOL = "codara_preview_run";
const STEP_PREFIX = "codara_preview_";

let cached = null;

function moduleFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".cjs") && file !== "index.cjs")
    .sort();
}

function fail(file, message) {
  throw new Error(`codara-studio tool module ${file}: ${message}`);
}

function loadModules(dir) {
  const modules = [];
  for (const file of moduleFiles(dir)) {
    const mod = require(path.join(dir, file));
    if (!mod || !Array.isArray(mod.tools)) fail(file, "must export a tools array");
    if (typeof mod.order !== "number" || !Number.isFinite(mod.order)) fail(file, "must export a numeric order");
    const family = mod.family === undefined ? "browser" : mod.family;
    if (!FAMILIES.has(family)) fail(file, `unknown family ${JSON.stringify(family)}`);
    modules.push({ file, order: mod.order, family, instructions: mod.instructions, tools: mod.tools });
  }
  modules.sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
  return modules;
}

function definition(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([key]) => !STRIPPED_FIELDS.has(key)));
}

function buildRegistry(dir = __dirname) {
  const modules = loadModules(dir);
  const seen = new Set();
  const tools = [];
  const toRpc = {};
  const hiddenToRpc = {};
  const steps = [];
  const families = {};
  const annotations = { readOnly: new Set(), destructive: new Set(), idempotent: new Set(), openWorld: new Set() };
  const instructions = [];
  let runEntry = null;

  for (const mod of modules) {
    if (typeof mod.instructions === "string" && mod.instructions.trim()) instructions.push(mod.instructions.trim());
    for (const entry of mod.tools) {
      const name = entry && entry.name;
      if (typeof name !== "string" || !/^codara_[a-z0-9_]+$/.test(name)) fail(mod.file, `bad tool name ${JSON.stringify(name)}`);
      if (seen.has(name)) fail(mod.file, `duplicate tool ${name}`);
      seen.add(name);
      if (entry.rpc === undefined && !LOCAL_TOOLS.has(name)) fail(mod.file, `${name} needs an rpc`);
      if (entry.rpc !== undefined && (typeof entry.rpc !== "string" || !/^[a-z_]+\.[a-z_.]+$/.test(entry.rpc))) {
        fail(mod.file, `${name} has a bad rpc ${JSON.stringify(entry.rpc)}`);
      }
      if (entry.hidden) {
        hiddenToRpc[name] = entry.rpc;
        continue;
      }
      if (typeof entry.description !== "string" || !entry.inputSchema) fail(mod.file, `${name} needs a description and an inputSchema`);
      for (const [hint, set] of Object.entries(annotations)) {
        if (entry.annotations && entry.annotations[hint] === true) set.add(name);
      }
      if (entry.step) {
        if (!name.startsWith(STEP_PREFIX) || !entry.rpc) fail(mod.file, `${name} cannot be a run step`);
        if (typeof entry.step.order !== "number") fail(mod.file, `${name} step needs a numeric order`);
        steps.push({
          action: name.slice(STEP_PREFIX.length),
          rpc: entry.rpc,
          order: entry.step.order,
          properties: entry.step.properties || {},
        });
      }
      if (name === RUN_TOOL) runEntry = entry;
      if (entry.rpc) toRpc[name] = entry.rpc;
      tools.push(definition(entry));
      (families[mod.family] ||= []).push(name);
    }
  }

  steps.sort((a, b) => a.order - b.order || a.action.localeCompare(b.action));
  const stepActionToRpc = Object.fromEntries(steps.map((step) => [step.action, step.rpc]));
  if (runEntry) {
    const index = tools.findIndex((tool) => tool.name === RUN_TOOL);
    tools[index] = withStepActions(tools[index], steps);
  }

  return {
    tools,
    toRpc,
    hiddenToRpc,
    stepActionToRpc,
    families,
    annotations,
    instructions,
    modules: modules.map((mod) => ({ file: mod.file, order: mod.order, family: mod.family, tools: mod.tools.map((entry) => entry.name) })),
  };
}

// The run tool lists every step action, and a step field another module
// introduces is added once, after the fields the run schema already has.
function withStepActions(runTool, steps) {
  const tool = JSON.parse(JSON.stringify(runTool));
  const item = tool.inputSchema.properties.steps.items;
  item.properties.action.enum = steps.map((step) => step.action);
  for (const step of steps) {
    for (const [key, schema] of Object.entries(step.properties)) {
      if (!(key in item.properties)) item.properties[key] = schema;
    }
  }
  return tool;
}

function toolRegistry() {
  if (!cached) cached = buildRegistry();
  return cached;
}

module.exports = { toolRegistry, buildRegistry };

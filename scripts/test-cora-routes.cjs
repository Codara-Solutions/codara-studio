#!/usr/bin/env node
"use strict";

// Route order for Cora's manager and Pi workers (src/shared/cora-routes.ts)
// and where it is applied.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded.require = (id) => {
    const sibling = id.startsWith("./")
      ? path.join(path.dirname(sourcePath), `${id}.ts`)
      : id.startsWith("@shared/") ? path.join(ROOT, "src", "shared", `${id.slice("@shared/".length)}.ts`) : null;
    if (sibling && fs.existsSync(sibling)) return loadTypeScriptModule(sibling);
    return Module.prototype.require.call(loaded, id);
  };
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

const routes = loadTypeScriptModule(path.join(ROOT, "src", "shared", "cora-routes.ts"));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The default is sign-ins, then OpenRouter, then Subcloud; a partial or
// broken setting keeps every route exactly once.
assert.deepEqual(routes.normalizeCoraRouteOrder(undefined), ["subscription", "openrouter", "subcloud"]);
assert.deepEqual(routes.normalizeCoraRouteOrder(["openrouter", "bogus", "openrouter"]), ["openrouter", "subscription", "subcloud"]);
assert.deepEqual(routes.normalizeCoraRouteOrder("subcloud"), ["subscription", "openrouter", "subcloud"]);

// One model, spelled per route.
assert.deepEqual(routes.routeSpellings("claude-opus-5"), { subscription: "claude-opus-5", openrouter: "anthropic/claude-opus-5", claudecode: "claude-code/claude-opus-5" });
assert.deepEqual(routes.routeSpellings("anthropic/claude-opus-5"), { subscription: "claude-opus-5", openrouter: "anthropic/claude-opus-5", claudecode: "claude-code/claude-opus-5" });
assert.deepEqual(routes.routeSpellings("claude-opus-5@high").claudecode, "claude-code/claude-opus-5@high", "Claude Code keeps the effort");
assert.deepEqual(routes.routeSpellings("gpt-5.6-sol"), { subscription: "gpt-5.6-sol", openrouter: "openai/gpt-5.6-sol" });
assert.deepEqual(routes.routeSpellings("x-ai/grok-4.6"), { subscription: "grok-4.6", openrouter: "x-ai/grok-4.6" });
assert.deepEqual(routes.routeSpellings("moonshotai/kimi-k2"), { openrouter: "moonshotai/kimi-k2" });
assert.deepEqual(routes.routeSpellings("openai/claude-opus-5"), { openrouter: "openai/claude-opus-5" }, "a mismatched prefix is not a sign-in model");
// OpenRouter moves onto a sign-in only for a native id the sign-in serves.
assert.deepEqual(routes.routeSpellings("anthropic/claude-sonnet-4.5"), { openrouter: "anthropic/claude-sonnet-4.5" });
assert.deepEqual(routes.routeSpellings("openai/gpt-4o"), { openrouter: "openai/gpt-4o" });
// A native effort suffix stays native; OpenRouter gets effort as thinking.
assert.deepEqual(routes.routeSpellings("gpt-5.6-sol@high"), { subscription: "gpt-5.6-sol@high", openrouter: "openai/gpt-5.6-sol" });

const order = routes.DEFAULT_CORA_ROUTE_ORDER;
const both = { subscriptions: new Set(["anthropic"]), openRouterModels: new Set(["anthropic/claude-opus-5", "openai/gpt-5.6-sol"]) };
// Sign-in first: an OpenRouter pick runs on the sign-in when one is there.
assert.deepEqual(routes.chooseCoraRoute("claude-opus-5", order, both), { route: "subscription", model: "claude-opus-5" });
assert.deepEqual(routes.chooseCoraRoute("anthropic/claude-opus-5", order, both), { route: "subscription", model: "claude-opus-5" });
// No ChatGPT sign-in: the same model goes through OpenRouter, verified only.
assert.deepEqual(routes.chooseCoraRoute("gpt-5.6-sol", order, both), { route: "openrouter", model: "openai/gpt-5.6-sol" });
assert.deepEqual(routes.chooseCoraRoute("gpt-5.6-sol@high", order, both), { route: "openrouter", model: "openai/gpt-5.6-sol" });
assert.equal(routes.chooseCoraRoute("gpt-5.6-terra", order, both), null, "an unverified OpenRouter id is never used");
assert.equal(
  routes.chooseCoraRoute("openai/gpt-4o", order, { subscriptions: new Set(["openai-codex"]), openRouterModels: new Set() }),
  null,
  "a ChatGPT sign-in does not take a model it does not offer",
);
// The user's order wins.
assert.deepEqual(
  routes.chooseCoraRoute("claude-opus-5", ["openrouter", "subscription", "subcloud"], both),
  { route: "openrouter", model: "anthropic/claude-opus-5" },
);
// Pi's catalog widens what an OpenRouter id may move onto.
const catalog = { subscriptions: new Set(["openai-codex"]), openRouterModels: new Set(["openai/gpt-6.1-sol"]) };
assert.deepEqual(routes.chooseCoraRoute("openai/gpt-6.1-sol", order, catalog), { route: "openrouter", model: "openai/gpt-6.1-sol" });
assert.deepEqual(
  routes.chooseCoraRoute("openai/gpt-6.1-sol", order, { ...catalog, nativeModels: new Set(["gpt-6.1-sol"]) }),
  { route: "subscription", model: "gpt-6.1-sol" },
);
// The effort an OpenRouter id drops is read back for the thinking level.
assert.equal(routes.effortOfModelId("gpt-5.6-sol@low"), "low");
assert.equal(routes.effortOfModelId("openai/gpt-5.6-sol"), undefined);
assert.equal(routes.effortOfModelId(undefined), undefined);
// A worker family counts on any route, so an OpenRouter-only GPT worker
// keeps its GPT assignment.
assert.equal(routes.workerFamilyOfModelId("openai/gpt-5.6-sol"), "codex");
assert.equal(routes.workerFamilyOfModelId("anthropic/claude-opus-5"), "claude");
assert.equal(routes.workerFamilyOfModelId("x-ai/grok-4.6"), "grok");
assert.equal(routes.workerFamilyOfModelId("gpt-5.6-sol@low"), "codex");
assert.equal(routes.workerFamilyOfModelId("moonshotai/kimi-k2"), undefined);
// Claude Code: never in an order unless picked, and only when the launch says
// it may run (a managed worker with Claude Code signed in).
assert.ok(routes.CORA_ROUTES.includes("claudecode"));
assert.ok(!routes.DEFAULT_CORA_ROUTE_ORDER.includes("claudecode"));
assert.ok(!routes.normalizeCoraRouteOrder(undefined).includes("claudecode"));
assert.ok(!routes.normalizeCoraRouteOrder(["openrouter"]).includes("claudecode"), "never appended");
assert.deepEqual(routes.normalizeCoraRouteOrder(["claudecode", "subscription"]), ["claudecode", "subscription", "openrouter", "subcloud"]);
const ccOrder = ["claudecode", "subscription", "openrouter", "subcloud"];
assert.deepEqual(routes.chooseCoraRoute("claude-opus-5@high", ccOrder, both), { route: "subscription", model: "claude-opus-5@high" }, "no claudeCode flag: skipped (Cora herself)");
assert.deepEqual(routes.chooseCoraRoute("claude-opus-5@high", ccOrder, { ...both, claudeCode: true }), { route: "claudecode", model: "claude-code/claude-opus-5@high" });
assert.deepEqual(routes.chooseCoraRoute("anthropic/claude-opus-5", ccOrder, { ...both, claudeCode: true }), { route: "claudecode", model: "claude-code/claude-opus-5" });
assert.deepEqual(routes.chooseCoraRoute("gpt-5.6-sol", ccOrder, { ...both, claudeCode: true }), { route: "openrouter", model: "openai/gpt-5.6-sol" }, "only Claude models");
assert.equal(routes.routeOfModelId("claude-code/claude-opus-5"), "claudecode");
assert.equal(routes.workerFamilyOfModelId("claude-code/claude-opus-5@high"), "claude");
assert.equal(routes.claudeCodeModelOf("claude-code/claude-opus-5@high"), "claude-opus-5@high");
assert.equal(routes.claudeCodeModelOf("claude-code/"), null);
assert.equal(routes.claudeCodeModelOf("claude-opus-5"), null);
assert.equal(routes.coraRouteLabel("claude-code/claude-opus-5"), "Claude Code");
// Subcloud carries nothing until it exists.
assert.equal(routes.chooseCoraRoute("claude-opus-5", ["subcloud"], both), null);

assert.equal(routes.coraRouteLabel("claude-opus-5"), "Claude sign-in");
assert.equal(routes.coraRouteLabel("gpt-5.6-sol"), "ChatGPT sign-in");
assert.equal(routes.coraRouteLabel("anthropic/claude-opus-5"), "OpenRouter key");
assert.equal(routes.coraRouteLabel("subcloud/claude-opus-5"), "Subcloud");
assert.equal(routes.coraRouteLabel(undefined), "Unknown");

// One table per run: who, model, route, account, tokens.
const rows = routes.coraRouteRows(
  [
    { model: "claude-opus-5", accountProfileId: "acct-1234567890", inputTokens: 100, outputTokens: 10 },
    { model: "claude-opus-5", accountProfileId: "acct-1234567890", inputTokens: 50, outputTokens: 5 },
    { model: "openai/gpt-5.6-sol" },
  ],
  [{ model: "anthropic/claude-opus-5", inputTokens: 7, outputTokens: 3 }, { inputTokens: 1 }],
);
assert.deepEqual(
  rows.map(({ who, model, route, account, inputTokens, outputTokens, count }) => [who, model, route, account, inputTokens, outputTokens, count]),
  [
    ["Cora", "claude-opus-5", "Claude sign-in", "acct-123", 150, 15, 2],
    ["Cora", "openai/gpt-5.6-sol", "OpenRouter key", "", 0, 0, 1],
    ["Worker", "anthropic/claude-opus-5", "OpenRouter key", "", 7, 3, 1],
  ],
);
// A Claude Code worker shows the account by its name.
assert.deepEqual(
  routes.coraRouteRows([], [{ model: "claude-code/claude-opus-5@high", accountLabel: "Main", inputTokens: 4 }])
    .map(({ route, account, inputTokens }) => [route, account, inputTokens]),
  [["Claude Code", "Main", 4]],
);

// Claude Code is routed only for managed workers of a trusted run; Cora's own
// route call passes no options, so it can never land there.
const managed = runStore_().match(/const managedWorker = ([^\n]*);\n/);
assert.ok(managed, "managedWorker gate present");
for (const part of ["isPiWorker", "!isAutomationRun", "runHasManagedWorkers(run)", "!task.workflowCall"]) {
  assert.ok(managed[1].includes(part), `managed-worker gate checks ${part}`);
}
// The run's half of that rule, shared with planning and task creation.
assert.match(
  read("src/main/orchestration/project-policy.ts"),
  /export function runHasManagedWorkers\([^)]*\): boolean \{\s*return run\.executionMode !== "direct" && runProjectPolicyMode\(run\) === "trusted";\s*\}/,
);
assert.match(runStore_(), /return loadSettings\(\)\.then\(\(settings\) => routeCoraModel\(chat\.model, settings\)\)/);
assert.match(runStore_(), /: claudeCodeWorker\n\s+\? await runClaudeCodeWorkerSession\(/);
function runStore_() { return read("src/main/orchestration/run-store.ts"); }

// Applied where the manager and the workers launch, and shown where users look.
// The manager routes before its account is pinned and frozen, so a GPT pick
// with no ChatGPT sign-in reaches OpenRouter and records no sign-in account.
const runStore = read("src/main/orchestration/run-store.ts");
const routedAt = runStore.indexOf("const routedModel = await routedManagerModel(run);");
assert.ok(routedAt > 0);
assert.ok(runStore.indexOf("run = await pinImplicitPiManagerAccount(run, routedModel);") > routedAt);
assert.ok(
  runStore.indexOf("chatConfig = await freezeManagerExecutionAccount({ ...resolveChatBackendConfig(run), model: routedModel });") > routedAt,
);
assert.doesNotMatch(read("src/main/orchestration/pi-backend.ts"), /resolveCodaraCoraRouteModel/);
// A Stop or Cancel during those reads ends the turn before it is prepared.
const recheckAt = runStore.indexOf("const stopping = forcePauseWindowClosed(run.id);", routedAt);
assert.ok(recheckAt > routedAt && recheckAt < runStore.indexOf("const preparedTurn = await prepareManagerTurn(run, sparkCall);", routedAt));
assert.match(runStore.slice(recheckAt, recheckAt + 700), /latest\.status === "cancelled"[\s\S]*return latest \?\? null;/);
// The earlier family rewrite counts routes too, and a dropped effort becomes thinking.
assert.match(runStore, /for \(const kind of await routableWorkerRuntimes\(run\)\) availableKinds\.add\(kind\);/);
assert.match(runStore, /const kinds = connected\.map\(\(id\) => workerFamilyOfModelId\(id\)\);/);
assert.match(runStore, /piThinkingLevel\(effortOfModelId\(plannedPiWorkerModel\)\)/);
assert.match(runStore, /const thinking = thinkingOverride \?\? piThinkingForWorker\(task\);/);
assert.match(read("src/main/orchestration/pi-backend.ts"), /provider === "anthropic" \? `\. \$\{CLAUDE_PI_LOGIN_BILLING_NOTE\}`/);
assert.match(runStore, /routeCoraModel\(plannedPiWorkerModel, routeSettings, undefined, \{ managedWorker \}\)/);
assert.match(runStore, /const workerSettings = isAutomationRun \? null : routeSettings;/, "automation workers are routed too");
assert.match(runStore, /coraWorkerModelAvailability\(workerSettings, \{ managedWorker \}\)/, "worker eligibility counts every route, Claude Code for a managed worker");
assert.match(read("src/renderer/src/components/SessionInspector.tsx"), /<RoutesTable rows=\{routes\} \/>/);
assert.match(read("src/renderer/src/components/capabilities/BehaviorSection.tsx"), /CLAUDE_PI_LOGIN_BILLING_NOTE/);
assert.match(read("src/main/storage.ts"), /coraRouteOrder: settings\.coraRouteOrder === undefined \? undefined : normalizeCoraRouteOrder/, "unset stays unset after an upgrade");
assert.doesNotMatch(read("src/main/storage.ts"), /coraRouteOrder: \[\.\.\.DEFAULT_CORA_ROUTE_ORDER\]/);
// A chat on a pinned account is never routed off it.
assert.match(runStore, /if \(chat\.backend !== "pi" \|\| managerRoutePinnedByUser\(run\)\) return chat\.model;/);
assert.match(runStore, /draft\.chatAccountProfileId = candidate\.accountProfileId;\n\s+draft\.chatAccountProfileImplicit = true;/);
assert.match(runStore, /draft\.chatAccountProfileId = resolved\.account\.profileId;\n\s+\/\/ The user picked this account to resume on\.[^\n]*\n(?:\s+\/\/[^\n]*\n)*\s+delete draft\.chatAccountProfileImplicit;/);
// Two turns of a chat on anthropic/claude-opus-5 with sign-ins first: turn 1
// routes to the sign-in and Cora pins that account implicitly; turn 2 must
// still route, not go back to the paid OpenRouter spelling.
{
  const signInFirst = ["subscription", "openrouter", "subcloud"];
  const avail = { subscriptions: new Set(["anthropic"]), openRouterModels: new Set(["anthropic/claude-opus-5"]) };
  const turn = (run) => (routes.managerRoutePinnedByUser(run) ? run.chatModel : routes.chooseCoraRoute(run.chatModel, signInFirst, avail)?.model ?? run.chatModel);
  const chat = { chatModel: "anthropic/claude-opus-5" };
  assert.equal(turn(chat), "claude-opus-5", "turn 1 runs on the sign-in");
  Object.assign(chat, { chatAccountProfileId: "acct-1", chatAccountProfileImplicit: true });
  assert.equal(turn(chat), "claude-opus-5", "turn 2 after Cora's own pin still follows the order");
  delete chat.chatAccountProfileImplicit;
  assert.equal(turn(chat), "anthropic/claude-opus-5", "a pin the user chose keeps the chat as picked");
}
// A Stop that began during setup ends the turn, whatever the status was at its start.
assert.match(runStore, /forcePauseStartCount\(run\.id\) !== entryStops/);

console.log("cora routes: ok");

// "As picked" stays selectable after an order was chosen, and picking it
// clears the setting.
{
  const behavior = read("src/renderer/src/components/capabilities/BehaviorSection.tsx");
  assert.match(behavior, /\n\s+<option value="">As picked \(no reordering\)<\/option>/);
  assert.match(behavior, /event\.target\.value \? normalizeCoraRouteOrder\(event\.target\.value\.split\(","\)\) : undefined/);
}

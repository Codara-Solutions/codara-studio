// Cora is offered worker models only for providers with a usable account
// (src/main/orchestration/worker-model-availability.ts and the pure split in
// src/shared/worker-model-roster.ts). A Claude-only user's Cora must not plan
// Grok or GPT workers that are rerouted or fail at launch.
//
//   node scripts/test-worker-model-availability.cjs
//
// Exits non-zero on any failed assertion.

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-worker-availability-"));

globalThis.__availabilityHarness = { statuses: [], fail: false, claudeCodeReady: true, claudeCodeChecks: 0 };

const harness = {
  name: "worker-model-availability-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /pi-account-auth-store$/ }, () => ({ path: "auth-store", namespace: "stub" }));
    build.onResolve({ filter: /\/agent-runtimes$/ }, () => ({ path: "agent-runtimes", namespace: "stub" }));
    build.onResolve({ filter: /\/pi-model-catalog$/ }, () => ({ path: "pi-model-catalog", namespace: "stub" }));
    build.onResolve({ filter: /\/claude-code-worker$/ }, () => ({ path: "claude-code-worker", namespace: "stub" }));
    build.onLoad({ filter: /^claude-code-worker$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `export async function claudeCodeWorkerReady() {
        globalThis.__availabilityHarness.claudeCodeChecks += 1;
        return globalThis.__availabilityHarness.claudeCodeReady;
      }`,
    }));
    build.onLoad({ filter: /^pi-model-catalog$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: "export async function inspectPiModelCatalog() { return []; }",
    }));
    build.onLoad({ filter: /^auth-store$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: `
        export async function inspectPiAccountProfileAuthStore() {
          if (globalThis.__availabilityHarness.fail) throw new Error("auth store unreadable");
          return { statuses: globalThis.__availabilityHarness.statuses };
        }`,
    }));
    build.onLoad({ filter: /^agent-runtimes$/, namespace: "stub" }, () => ({
      loader: "js",
      contents: "export async function detectAgentRuntimes() { return []; }",
    }));
  },
};

async function load(relative) {
  const outfile = path.join(TMP, `${path.basename(relative, ".ts")}.cjs`);
  await esbuild.build({
    entryPoints: [path.join(ROOT, relative)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    plugins: [harness],
  });
  return require(outfile);
}

async function main() {
  const roster = await load("src/shared/worker-model-roster.ts");
  const availability = await load("src/main/orchestration/worker-model-availability.ts");
  const harnessState = globalThis.__availabilityHarness;

  assert.equal(roster.workerModelSubscription("claude-opus-5"), "anthropic");
  assert.equal(roster.workerModelSubscription("gpt-5.6-sol@high"), "openai-codex");
  assert.equal(roster.workerModelSubscription("grok-4.6"), "xai");
  assert.equal(roster.workerModelSubscription("anthropic/claude-sonnet-4"), null, "OpenRouter ids need a key, not an account");
  console.log("PASS worker models map to the subscription they run on");

  // The direct lane runs the chat's chip model only when it can launch; an
  // OpenAI-only user whose chip is a GPT model the roster does not enable
  // must stay on OpenAI rather than land on a Claude model with no sign-in.
  assert.equal(roster.pickDirectWorkerModel("gpt-5.6-sol", ["claude-opus-5", "gpt-5.6-sol"]), "gpt-5.6-sol");
  assert.equal(roster.pickDirectWorkerModel("gpt-5.6-terra", ["gpt-5.6-sol", "grok-4.6"]), "gpt-5.6-sol");
  assert.equal(roster.pickDirectWorkerModel("gpt-5.6-terra", ["claude-opus-5", "grok-4.6"]), "claude-opus-5");
  assert.equal(roster.pickDirectWorkerModel(undefined, ["grok-4.6"]), "grok-4.6");
  assert.equal(roster.pickDirectWorkerModel("claude-opus-5", []), undefined, "nothing connected keeps the manager path");
  console.log("PASS the direct lane picks a connected model, preferring the chip and its provider");

  const split = roster.partitionWorkerModelsByAccount(
    ["claude-opus-5", "gpt-5.6-sol", "grok-4.6", "qwen/qwen3-coder"],
    new Set(["anthropic"]),
  );
  assert.deepEqual(split.connected, ["claude-opus-5", "qwen/qwen3-coder"]);
  assert.deepEqual(split.disconnected, ["gpt-5.6-sol", "grok-4.6"]);
  console.log("PASS enabled models split by connected account, OpenRouter kept");

  // Default settings enable Claude, GPT and Grok workers.
  const settings = {};
  harnessState.statuses = [
    { provider: "anthropic", connected: true, expired: false },
    { provider: "xai", connected: true, expired: true, canRefresh: false },
  ];
  const claudeOnly = await availability.coraWorkerModelAvailability(settings);
  assert.ok(claudeOnly.connected.every((id) => id.startsWith("claude-")), JSON.stringify(claudeOnly));
  assert.ok(claudeOnly.connected.length > 0);
  assert.ok(claudeOnly.disconnected.includes("grok-4.6"), "an expired, unrefreshable Grok login is not usable");
  assert.ok(claudeOnly.disconnected.some((id) => id.startsWith("gpt-")));
  console.log("PASS a Claude-only user is offered Claude workers only");

  harnessState.statuses = [];
  const none = await availability.coraWorkerModelAvailability(settings);
  assert.equal(none.connected.length, 0);
  assert.ok(none.disconnected.length > 0, "the waiting models are reported so Cora can explain");
  console.log("PASS no connected account leaves no launchable model and names the waiting ones");

  // Route order (cora-routes.ts), with a verified OpenRouter key for GPT.
  const openRouter = await load("src/main/openrouter-config.ts");
  const key = "test-key-not-real";
  const orModels = ["openai/gpt-5.6-sol"];
  const keyed = {
    openRouterApiKey: key,
    openRouterCoraModels: orModels,
    openRouterVerifiedKeyHash: openRouter.openRouterConfigurationHash(key, orModels),
  };
  const ordered = { ...keyed, coraRouteOrder: ["subscription", "openrouter", "subcloud"] };

  // Never set up: OpenRouter carries the model.
  harnessState.statuses = [{ provider: "anthropic", connected: true, expired: false }];
  assert.equal(await availability.routeCoraModel("gpt-5.6-sol", ordered), "openai/gpt-5.6-sol");
  assert.ok((await availability.coraWorkerModelAvailability(ordered)).connected.includes("gpt-5.6-sol"));
  // Set up but expired, or signed out: no silent move to the paid key; the
  // launch fails and says to sign in again.
  for (const broken of [
    { provider: "openai-codex", connected: true, expired: true, canRefresh: false },
    { provider: "openai-codex", connected: false, expired: false },
  ]) {
    harnessState.statuses = [{ provider: "anthropic", connected: true, expired: false }, broken];
    assert.equal(await availability.routeCoraModel("gpt-5.6-sol", ordered), "gpt-5.6-sol", JSON.stringify(broken));
    const split = await availability.coraWorkerModelAvailability(ordered);
    assert.ok(split.disconnected.includes("gpt-5.6-sol") && !split.connected.includes("gpt-5.6-sol"));
  }
  // No order chosen (every existing user after the upgrade, and automations
  // until the user picks one): models launch as picked.
  harnessState.statuses = [{ provider: "anthropic", connected: true, expired: false }];
  assert.equal(await availability.routeCoraModel("gpt-5.6-sol", keyed), "gpt-5.6-sol");
  assert.equal(await availability.routeCoraModel("anthropic/claude-opus-5", { ...keyed, openRouterCoraModels: ["anthropic/claude-opus-5"] }), "anthropic/claude-opus-5");
  assert.ok(!(await availability.coraWorkerModelAvailability(keyed)).connected.includes("gpt-5.6-sol"));
  console.log("PASS routes: a broken sign-in is not swapped for a paid key, and no order means as picked");

  // Claude Code: only a managed worker, only when the user's order has it,
  // only when Claude Code is installed and signed in.
  const ccOrdered = { ...keyed, coraRouteOrder: ["claudecode", "subscription", "openrouter", "subcloud"] };
  harnessState.claudeCodeChecks = 0;
  assert.equal(await availability.routeCoraModel("claude-opus-5@high", ccOrdered, undefined, { managedWorker: true }), "claude-code/claude-opus-5@high");
  assert.equal(await availability.routeCoraModel("claude-opus-5@high", ccOrdered), "claude-opus-5@high", "Cora herself and other launches never get it");
  assert.equal(await availability.routeCoraModel("claude-opus-5@high", ccOrdered, undefined, { managedWorker: false }), "claude-opus-5@high");
  assert.equal(harnessState.claudeCodeChecks, 1, "Claude Code is checked only for a managed worker");
  assert.equal(await availability.routeCoraModel("claude-opus-5@high", ordered, undefined, { managedWorker: true }), "claude-opus-5@high", "not in the order: never used");
  assert.equal(harnessState.claudeCodeChecks, 1, "and not even checked");
  assert.equal(await availability.routeCoraModel("claude-opus-5@high", keyed, undefined, { managedWorker: true }), "claude-opus-5@high", "no order: as picked");
  harnessState.claudeCodeReady = false;
  assert.equal(await availability.routeCoraModel("claude-opus-5@high", ccOrdered, undefined, { managedWorker: true }), "claude-opus-5@high", "not installed or signed out: next route");
  harnessState.claudeCodeReady = true;
  assert.equal(await availability.routeCoraModel("gpt-5.6-sol", ccOrdered, undefined, { managedWorker: true }), "openai/gpt-5.6-sol", "GPT models skip it");
  console.log("PASS routes: Claude Code runs managed Claude workers only, when picked and signed in");

  // A managed worker's planning keeps a Claude model that only Claude Code
  // carries (no Pi sign-in for Claude, only Codex's), so a Claude task is
  // not handed to GPT before routing.
  harnessState.statuses = [{ provider: "openai-codex", connected: true, expired: false }];
  const piOnlyCodex = await availability.coraWorkerModelAvailability(ccOrdered, { managedWorker: true });
  assert.ok(piOnlyCodex.connected.some((id) => id.startsWith("claude-")), JSON.stringify(piOnlyCodex));
  const notManaged = await availability.coraWorkerModelAvailability(ccOrdered);
  assert.ok(!notManaged.connected.some((id) => id.startsWith("claude-")), "only a managed worker plans on Claude Code");
  harnessState.claudeCodeReady = false;
  const signedOut = await availability.coraWorkerModelAvailability(ccOrdered, { managedWorker: true });
  assert.ok(!signedOut.connected.some((id) => id.startsWith("claude-")), "Claude Code signed out: not planned on it");
  harnessState.claudeCodeReady = true;
  console.log("PASS planning: a managed worker keeps a Claude model only Claude Code carries");

  // Worker planning (launchWorkerAttemptInner): with an order chosen, the
  // worker's model is picked by what it is and only the order picks its
  // route. Enabled: Claude Opus, and GPT-5.6 Sol only as its OpenRouter id.
  const gptTask = { runtimePreference: "codex", modelHint: "gpt-5.6-sol" };
  const plan = async (statuses, extra, enabled) => {
    harnessState.statuses = statuses;
    const settings = { ...ordered, coraWorkerModels: enabled, ...extra };
    const { connected } = await availability.coraWorkerModelAvailability(settings);
    const planned = roster.plannedWorkerModel(gptTask, {
      enabledModels: availability.workerPlanningModels(connected, settings),
    });
    return { planned, launched: await availability.routeCoraModel(planned, settings) };
  };
  const claude = { provider: "anthropic", connected: true, expired: false };
  // No ChatGPT sign-in ever: the GPT task keeps GPT, through the key.
  let chosen = await plan([claude], {}, ["claude-opus-5", "openai/gpt-5.6-sol"]);
  assert.equal(chosen.launched, "openai/gpt-5.6-sol", JSON.stringify(chosen));
  // Both spellings enabled, the ChatGPT sign-in expired, sign-ins first: the
  // sign-in spelling launches and fails with "sign in again", never the key.
  chosen = await plan(
    [claude, { provider: "openai-codex", connected: true, expired: true, canRefresh: false }],
    {},
    ["claude-opus-5", "gpt-5.6-sol", "openai/gpt-5.6-sol"],
  );
  assert.equal(chosen.launched, "gpt-5.6-sol", JSON.stringify(chosen));
  // OpenRouter first: the key, as the user ordered.
  chosen = await plan(
    [claude, { provider: "openai-codex", connected: true, expired: false }],
    { coraRouteOrder: ["openrouter", "subscription", "subcloud"] },
    ["claude-opus-5", "gpt-5.6-sol", "openai/gpt-5.6-sol"],
  );
  assert.equal(chosen.launched, "openai/gpt-5.6-sol", JSON.stringify(chosen));
  // No order: planning sees the spellings as they are.
  harnessState.statuses = [claude];
  assert.deepEqual(availability.workerPlanningModels(["openai/gpt-5.6-sol"], keyed), ["openai/gpt-5.6-sol"]);
  console.log("PASS worker planning picks the model, then the order picks its route");

  // The route code keeps only which providers are set up or usable and which
  // OpenRouter ids are verified: never a token, key, email or fingerprint.
  harnessState.statuses = [
    {
      provider: "openai-codex", profileId: "p-1", connected: true, expired: false,
      accountEmail: "someone@example.test", accountFingerprint: "fp-secret-digest", access: "FAKE_access_token",
    },
  ];
  const routeView = await availability.coraRouteAvailability(ordered);
  const serialized = JSON.stringify(routeView, (_, value) => (value instanceof Set ? [...value] : value));
  for (const secret of [key, "someone@example.test", "fp-secret-digest", "FAKE_access_token", "p-1"]) {
    assert.ok(!serialized.includes(secret), `route availability carries ${secret}`);
  }
  assert.deepEqual(Object.keys(routeView).sort(), ["nativeModels", "openRouterModels", "subscriptions"]);
  const availabilitySource = fs.readFileSync(path.join(ROOT, "src/main/orchestration/worker-model-availability.ts"), "utf8");
  assert.doesNotMatch(availabilitySource, /console\.|writeFile|appendFile|fetch\(|commitRunChange|emit\(/, "route lookups log, store or send nothing");
  console.log("PASS route lookups keep provider status and model ids only");

  harnessState.fail = true;
  const unreadable = await availability.coraWorkerModelAvailability(settings);
  assert.ok(unreadable.connected.length >= 3 && unreadable.disconnected.length === 0);
  console.log("PASS an unreadable auth store keeps every enabled model");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });

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

globalThis.__availabilityHarness = { statuses: [], fail: false };

const harness = {
  name: "worker-model-availability-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /pi-account-auth-store$/ }, () => ({ path: "auth-store", namespace: "stub" }));
    build.onResolve({ filter: /\/agent-runtimes$/ }, () => ({ path: "agent-runtimes", namespace: "stub" }));
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

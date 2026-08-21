#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-openrouter-cora-"));
  const outfile = path.join(temporaryRoot, "openrouter-config.cjs");
  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "openrouter-config.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [{
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      }],
    });
    const config = require(outfile);
    const apiKey = "test-openrouter-key";
    const favorites = ["google/gemini-flash-latest", "anthropic/claude-sonnet-4.5"];
    const fingerprint = config.openRouterConfigurationHash(apiKey, favorites);

    assert.equal(
      fingerprint,
      config.openRouterConfigurationHash(apiKey, [...favorites].reverse()),
      "favorite ordering must not invalidate an otherwise identical configuration",
    );
    assert.notEqual(fingerprint, config.openRouterConfigurationHash("another-key", favorites));
    assert.notEqual(fingerprint, config.openRouterConfigurationHash(apiKey, favorites.slice(0, 1)));

    const settings = {
      openRouterApiKey: apiKey,
      openRouterCoraModels: favorites,
      openRouterVerifiedKeyHash: fingerprint,
      coraWorkerModels: ["claude-opus-5", ...favorites],
    };
    assert.equal(config.hasVerifiedOpenRouterKey(settings), true);
    assert.deepEqual(config.configuredOpenRouterCoraModels(settings), favorites);
    assert.deepEqual(config.availableCoraWorkerModels(settings), ["claude-opus-5", ...favorites]);
    assert.deepEqual(
      config.availableCoraWorkerModels({
        ...settings,
        openRouterCoraModels: favorites.slice(0, 1),
      }),
      ["claude-opus-5"],
      "editing the favorite list invalidates every OpenRouter worker until it is checked again",
    );

    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), authorization: init?.headers?.Authorization });
      if (String(url).endsWith("/key")) {
        return new Response(JSON.stringify({ data: { label: "test" } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          id: String(url).split("/model/")[1],
          name: "Verified model",
          supported_parameters: ["tools", "tool_choice"],
        },
      }), { status: 200 });
    };
    try {
      const result = await config.validateOpenRouterConfiguration({
        apiKey,
        coraModelIds: favorites,
      });
      assert.equal(result.ok, true);
      assert.equal(result.keyHash, fingerprint);
      assert.deepEqual(result.models.map((model) => model.id), favorites.slice().sort());
      assert.equal(calls.length, 3);
      assert.ok(calls.every((call) => call.authorization === `Bearer ${apiKey}`));

      globalThis.fetch = async (url) => new Response(JSON.stringify(
        String(url).endsWith("/key")
          ? { data: {} }
          : { data: { supported_parameters: [] } },
      ), { status: 200 });
      const withoutTools = await config.validateOpenRouterConfiguration({
        apiKey,
        coraModelIds: [favorites[0]],
      });
      assert.equal(withoutTools.ok, false);
      assert.match(withoutTools.error, /does not advertise tool calling/);
    } finally {
      globalThis.fetch = originalFetch;
    }

    console.log("OpenRouter Cora validation, favorites, and worker gating: ok");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

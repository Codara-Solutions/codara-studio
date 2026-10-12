#!/usr/bin/env node
"use strict";

// The Worker models page lists every model the signed-in providers offer,
// discovered at runtime by src/main/orchestration/worker-model-catalog.ts.
// This drives it against fake provider endpoints on a loopback server and a
// fake Codex CLI cache and ~/.claude.json in a throwaway folder:
//
//   1. The provider list parsers (Anthropic, ChatGPT Codex, xAI, the Codex
//      CLI cache, Claude Code's extra model options) keep what Cora can route
//      and drop hidden or unroutable ids.
//   2. Requests carry the account's token and the headers each API needs,
//      Anthropic pages are followed, and a refused list becomes a short note.
//   3. The merged catalog labels, orders and badges models; a signed-out
//      provider and a model missing from the account's list each say why.
//   4. The first build is the baseline (nothing New); a model that appears
//      later is New, and nothing switches it on.
//   5. Reads are cached, a forced read goes back to the providers, a stale
//      read is served at once and refreshed behind it, and an expiring token
//      is never used or refreshed.
//   6. Only Codara's own cache file is written (mode 600); the CLI files are
//      read and left byte-for-byte unchanged.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const ROOT = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "worker-model-catalog-"));
process.env.CODARA_HOME_DIR = path.join(ROOT, "codara-home");
process.env.SPARK_HOME_DIR = path.join(ROOT, "codara-home");
process.env.CODEX_HOME = path.join(ROOT, "codex-home");
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const cache = new Map();
function loadTs(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (cache.has(resolved)) return cache.get(resolved);
  const output = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
    fileName: resolved,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(resolved, module);
  loaded.filename = resolved;
  loaded.paths = Module._nodeModulePaths(path.dirname(resolved));
  const nativeRequire = loaded.require.bind(loaded);
  loaded.require = (specifier) => {
    if (specifier === "node:os") return { ...os, homedir: () => path.join(ROOT, "home") };
    if (specifier.startsWith("@shared/")) {
      return loadTs(path.join(__dirname, "..", "src", "shared", `${specifier.slice("@shared/".length)}.ts`));
    }
    if (specifier.startsWith(".")) {
      const candidate = path.join(path.dirname(resolved), `${specifier}.ts`);
      if (fs.existsSync(candidate)) return loadTs(candidate);
    }
    return nativeRequire(specifier);
  };
  cache.set(resolved, loaded.exports);
  loaded._compile(output, resolved);
  return loaded.exports;
}

const wmc = loadTs(path.join(__dirname, "..", "src", "main", "orchestration", "worker-model-catalog.ts"));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

// ── A fake provider ─────────────────────────────────────────────────────────

const provider = {
  anthropicPages: [
    { data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }, { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }], has_more: true, last_id: "claude-sonnet-5" },
    { data: [{ id: "claude-fable-5", display_name: "Claude Fable 5" }, { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" }], has_more: false },
  ],
  anthropicStatus: 200,
  codex: {
    models: [
      { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list", priority: 1, context_window: 500000, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }] },
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 5 },
      { slug: "gpt-reserve", display_name: "GPT-Reserve", visibility: "hide", priority: 4 },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "list", priority: 43 },
    ],
  },
  xai: { data: [{ id: "grok-4.6" }, { id: "grok-5" }], object: "list" },
  requests: [],
};

const server = http.createServer((req, res) => {
  provider.requests.push({ url: req.url, headers: req.headers });
  const url = new URL(req.url, "http://localhost");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/anthropic/v1/models") {
    if (provider.anthropicStatus !== 200) return send(provider.anthropicStatus, { error: "nope" });
    return send(200, url.searchParams.get("after_id") ? provider.anthropicPages[1] : provider.anthropicPages[0]);
  }
  if (url.pathname === "/chatgpt/backend-api/codex/models") return send(200, provider.codex);
  if (url.pathname === "/xai/v1/models") return send(200, provider.xai);
  return send(404, {});
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const baseUrls = { anthropic: `${base}/anthropic`, "openai-codex": `${base}/chatgpt`, xai: `${base}/xai` };

  await check("parsers keep listed, routable models and drop hidden ones", () => {
    const page = wmc.parseAnthropicModelList(provider.anthropicPages[0]);
    assert.deepEqual(page.models.map((model) => model.id), ["claude-opus-5", "claude-sonnet-5"]);
    assert.equal(page.nextAfter, "claude-sonnet-5");
    assert.equal(wmc.parseAnthropicModelList(provider.anthropicPages[1]).nextAfter, null);
    const codex = wmc.parseCodexModelList(provider.codex);
    assert.deepEqual(codex.map((model) => model.id), ["gpt-6.1-sol", "gpt-5.6-sol", "codex-auto-review"]);
    assert.deepEqual(codex[0].thinkingLevels, ["low", "high"]);
    assert.equal(codex[0].contextWindow, 500000);
    assert.deepEqual(wmc.parseXaiModelList(provider.xai).map((model) => model.id), ["grok-4.6", "grok-5"]);
    assert.deepEqual(
      wmc.parseClaudeCodeModelOptions({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]", label: "Fable" }, { nope: 1 }] }),
      [{ id: "claude-fable-5-1" }],
    );
    assert.deepEqual(wmc.parseClaudeCodeModelOptions({}), []);
    const cli = wmc.parseCodexCliCache({ client_version: "0.170.1", fetched_at: "2026-10-01T00:00:00Z", ...provider.codex });
    assert.equal(cli.clientVersion, "0.170.1");
    assert.equal(wmc.codexClientVersion("0.170.1"), "0.170.1");
    assert.equal(wmc.codexClientVersion("0.1.0"), "0.162.0");
    assert.equal(wmc.codexClientVersion("1; rm -rf"), "0.162.0");
    for (const bad of [null, {}, { data: "x" }, []]) assert.throws(() => wmc.parseAnthropicModelList(bad));
    assert.throws(() => wmc.parseCodexModelList({ models: null }));
  });

  await check("routing, labels, badges and order", () => {
    assert.equal(wmc.routableWorkerModel("openai-codex", "gpt-6.1-sol"), true);
    assert.equal(wmc.routableWorkerModel("openai-codex", "codex-auto-review"), false);
    assert.equal(wmc.routableWorkerModel("anthropic", "gpt-6.1-sol"), false);
    assert.equal(wmc.routableWorkerModel("xai", "grok 5; x"), false);
    assert.equal(wmc.prettyModelLabel("claude-opus-4-8"), "Claude Opus 4.8");
    assert.equal(wmc.prettyModelLabel("gpt-6.1-sol"), "GPT-6.1 Sol");
    assert.equal(wmc.prettyModelLabel("grok-4-1-fast"), "Grok 4.1 Fast");
    assert.equal(wmc.isPremiumWorkerModel("claude-fable-5-1"), true);
    assert.equal(wmc.isPremiumWorkerModel("claude-opus-5"), false);
    const sorted = ["claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-5", "claude-fable-5-1", "claude-opus-5"]
      .map((id) => ({ id }))
      .sort(wmc.compareWorkerModels)
      .map((model) => model.id);
    assert.deepEqual(sorted, ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"]);
    assert.deepEqual(
      [{ id: "gpt-5.4" }, { id: "gpt-5.6-sol", priority: 5 }, { id: "gpt-6.1-sol", priority: 1 }].sort(wmc.compareWorkerModels).map((m) => m.id),
      ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.4"],
    );
  });

  await check("requests carry the account's token and each API's headers; Anthropic pages are followed", async () => {
    provider.requests.length = 0;
    const anthropic = await wmc.fetchProviderModels("anthropic", { access: "ant-token", accountId: null }, { fetch, baseUrl: baseUrls.anthropic });
    assert.deepEqual(anthropic.map((model) => model.id), ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5-20251001"]);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.requests[0].headers.authorization, "Bearer ant-token");
    assert.equal(provider.requests[0].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.match(provider.requests[1].url, /after_id=claude-sonnet-5/);
    await wmc.fetchProviderModels("openai-codex", { access: "oa-token", accountId: "acct-1" }, { fetch, baseUrl: baseUrls["openai-codex"], codexClientVersion: "0.170.1" });
    const codexRequest = provider.requests[2];
    assert.equal(codexRequest.headers["chatgpt-account-id"], "acct-1");
    assert.match(codexRequest.url, /client_version=0\.170\.1/);
    await assert.rejects(
      wmc.fetchProviderModels("openai-codex", { access: "oa-token", accountId: null }, { fetch, baseUrl: baseUrls["openai-codex"] }),
      /account id/,
    );
    provider.anthropicStatus = 401;
    await assert.rejects(
      wmc.fetchProviderModels("anthropic", { access: "x", accountId: null }, { fetch, baseUrl: baseUrls.anthropic }),
      /Anthropic refused the model list/,
    );
    provider.anthropicStatus = 200;
    await assert.rejects(
      wmc.fetchProviderModels("xai", { access: "x", accountId: null }, { fetch, baseUrl: "http://127.0.0.1:9" }),
      /could not be reached/,
    );
  });

  // ── The whole catalog over fake deps ────────────────────────────────────────
  const statePath = path.join(process.env.CODARA_HOME_DIR, "worker-model-catalog.json");
  const codexCachePath = path.join(process.env.CODEX_HOME, "models_cache.json");
  const claudeJsonPath = path.join(ROOT, "home", ".claude.json");
  fs.mkdirSync(path.dirname(codexCachePath), { recursive: true });
  fs.mkdirSync(path.dirname(claudeJsonPath), { recursive: true });
  fs.writeFileSync(codexCachePath, JSON.stringify({
    client_version: "0.170.1",
    fetched_at: "2026-10-10T00:00:00Z",
    models: [{ slug: "gpt-6-luna", display_name: "GPT-6-Luna", visibility: "list", priority: 4 }],
  }));
  fs.writeFileSync(claudeJsonPath, JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5-1[1m]" }], projects: {} }));
  const cliBytes = [codexCachePath, claudeJsonPath].map((file) => [file, fs.readFileSync(file)]);

  const pi = [
    { id: "claude-opus-5", label: "Claude Opus 5 (Pi)", provider: "anthropic", reasoning: true, thinkingLevels: ["low", "high", "xhigh"] },
    { id: "claude-opus-4-1", label: "Claude Opus 4.1", provider: "anthropic", reasoning: true, thinkingLevels: ["low"] },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "openai-codex", reasoning: true, thinkingLevels: ["low"] },
    { id: "grok-4.6", label: "Grok 4.6", provider: "xai", reasoning: true, thinkingLevels: ["low"] },
  ];
  let clock = Date.parse("2026-10-12T10:00:00Z");
  let signedIn = new Set(["anthropic", "openai-codex"]);
  const access = {
    anthropic: { access: "ant-token", accountId: null },
    "openai-codex": { access: "oa-token", accountId: "acct-1" },
    xai: null,
  };
  const enabledModels = ["claude-opus-5", "gpt-5.6-sol", "claude-retired-9"];
  const catalog = wmc.createWorkerModelCatalog({
    fetch,
    now: () => clock,
    statePath,
    piCatalog: async () => pi,
    signedInProviders: async () => signedIn,
    readAccess: async (id) => access[id] ?? null,
    enabledModels: async () => enabledModels,
    codexCliCachePath: () => codexCachePath,
    claudeCliConfigPath: () => claudeJsonPath,
    baseUrls,
  });
  const find = (result, id) => result.models.find((model) => model.id === id);

  await check("the first build lists every source, says why a model is out of reach, and marks nothing New", async () => {
    provider.requests.length = 0;
    const first = await catalog.read();
    const ids = first.models.map((model) => model.id);
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5-20251001", "claude-fable-5-1", "claude-opus-4-1", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-6-luna", "grok-4.6"]) {
      assert.ok(ids.includes(id), `${id} is listed`);
    }
    assert.equal(ids.includes("gpt-reserve"), false, "a hidden model is not offered");
    assert.equal(ids.includes("codex-auto-review"), false, "an id Cora cannot route is not offered");
    assert.equal(ids.includes("grok-5"), false, "a signed-out provider is not asked");
    assert.equal(first.models.some((model) => model.isNew), false, "the baseline marks nothing New");
    assert.ok(ids.indexOf("claude-opus-5") < ids.indexOf("gpt-6.1-sol") && ids.indexOf("gpt-6.1-sol") < ids.indexOf("grok-4.6"), "grouped by provider");
    assert.ok(ids.indexOf("gpt-6.1-sol") < ids.indexOf("gpt-5.6-sol"), "the Codex list's own order");

    assert.equal(find(first, "claude-opus-5").label, "Claude Opus 5", "curated label first");
    assert.equal(find(first, "gpt-6.1-sol").label, "GPT-6.1-Sol", "vendor name next");
    assert.equal(find(first, "claude-fable-5-1").label, "Claude Fable 5.1", "raw id made readable last");
    assert.equal(find(first, "claude-fable-5").premium, true);
    assert.deepEqual(find(first, "claude-opus-5").sources, ["provider", "pi"]);
    assert.deepEqual(find(first, "claude-fable-5-1").sources, ["cli"]);
    assert.deepEqual(find(first, "gpt-6.1-sol").thinkingLevels, ["low", "high"]);
    assert.deepEqual(find(first, "claude-opus-5").thinkingLevels, ["low", "high", "xhigh"], "Pi's ladder wins");

    assert.equal(find(first, "claude-opus-5").unavailable, null);
    assert.equal(find(first, "grok-4.6").unavailable, "Not signed in");
    assert.equal(find(first, "claude-opus-4-1").unavailable, "Not in your account's list");
    assert.equal(find(first, "claude-fable-5-1").unavailable, "Not in your account's list");
    assert.equal(find(first, "gpt-6-luna").unavailable, "Not in your account's list");
    assert.equal(find(first, "claude-retired-9").unavailable, "No longer listed", "an enabled id nobody lists stays visible");
    assert.deepEqual(find(first, "claude-retired-9").sources, []);

    const states = Object.fromEntries(first.providers.map((state) => [state.provider, state]));
    assert.equal(states.anthropic.listedFrom, "provider");
    assert.equal(states.xai.signedIn, false);
    assert.equal(states.xai.listedFrom, "pi");
    assert.match(provider.requests.find((request) => request.url.includes("codex/models")).url, /client_version=0\.170\.1/, "the CLI's newer client version is used");
  });

  await check("reads are cached; a forced read asks again; a stale read is served at once and refreshed behind it", async () => {
    provider.requests.length = 0;
    await catalog.read();
    assert.equal(provider.requests.length, 0);
    await catalog.read(true);
    assert.ok(provider.requests.length >= 3);
    provider.requests.length = 0;
    clock += 11 * 60_000;
    const stale = await catalog.read();
    assert.ok(stale.models.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(provider.requests.length >= 3, "the stale read started a refresh");
  });

  await check("a model released later is New, switched off, and kept New for two weeks", async () => {
    clock += 60 * 60_000;
    provider.xai.data.push({ id: "grok-6" });
    provider.anthropicPages[1].data.push({ id: "claude-opus-6", display_name: "Claude Opus 6" });
    signedIn = new Set(["anthropic", "openai-codex", "xai"]);
    access.xai = { access: "xai-token", accountId: null };
    const next = await catalog.read(true);
    assert.equal(find(next, "claude-opus-6").isNew, true);
    assert.equal(find(next, "claude-opus-6").unavailable, null);
    assert.equal(find(next, "grok-6").isNew, true, "a provider signed in later reveals new models");
    assert.equal(find(next, "claude-opus-5").isNew, false);
    assert.deepEqual(enabledModels, ["claude-opus-5", "gpt-5.6-sol", "claude-retired-9"], "nothing is switched on");
    assert.equal(next.models.indexOf(find(next, "claude-opus-6")) < next.models.indexOf(find(next, "claude-opus-5")), true, "newest first");
    clock += 15 * 24 * 60 * 60_000;
    assert.equal(find(await catalog.read(true), "claude-opus-6").isNew, false);
  });

  await check("an expiring token is never used, and the last list is kept with a note", async () => {
    provider.requests.length = 0;
    access.anthropic = "expired";
    const result = await catalog.read(true);
    assert.equal(provider.requests.some((request) => request.url.startsWith("/anthropic")), false);
    const state = result.providers.find((entry) => entry.provider === "anthropic");
    assert.match(state.note, /refresh/);
    assert.ok(find(result, "claude-opus-6"), "the last live list still shows its models");
    assert.equal(find(result, "claude-opus-4-1").unavailable, null, "an old list is a hint, not the account's word");
    access.anthropic = { access: "ant-token", accountId: null };
  });

  await check("only Codara's cache file is written, privately; the CLI files are untouched", async () => {
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(saved.version, 1);
    assert.ok(saved.firstSeen["claude-opus-6"]);
    assert.ok(saved.lastLive.anthropic.models.length > 0);
    assert.equal(JSON.stringify(saved).includes("ant-token"), false, "no token is cached");
    if (process.platform !== "win32") assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    for (const [file, bytes] of cliBytes) assert.deepEqual(fs.readFileSync(file), bytes, `${file} changed`);
    fs.writeFileSync(statePath, "{ not json");
    const reset = await wmc.readCatalogState(statePath);
    assert.deepEqual(reset, wmc.emptyCatalogState());
  });

  await check("the picker shape leaves out ids nobody lists", async () => {
    const result = await catalog.read();
    const listed = result.models.filter((model) => model.sources.length > 0);
    assert.ok(listed.length < result.models.length);
    assert.ok(listed.every((model) => Array.isArray(model.thinkingLevels)));
  });
}

main()
  .then(() => {
    server.close();
    console.log(`PASS worker model catalog (${passed} checks)`);
  })
  .catch((err) => {
    server.close();
    console.error(err);
    process.exit(1);
  });

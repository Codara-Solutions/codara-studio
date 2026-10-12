// Fast-mode fallback through a real, offline Pi agent session.
//
//   node scripts/test-pi-fast-mode-fallback-integration.mjs
//
// The bundled extension asks for fast mode in before_provider_request. When
// the provider refuses it, the extension's message_end hook marks the model
// declined and rewrites the error so Pi's own auto-retry runs the request
// again; the retry must go out at standard speed, the turn must succeed, and
// the user must see Codara's note rather than a provider error. A provider
// registered in-process stands in for Anthropic, so nothing leaves the machine.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const sdkDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(sdkDir, "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")).href);
async function loadTs(file, imports = {}) {
  const exports = {};
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, process, Error, Date, Map, Number, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected runtime import: ${name}`);
    return imports[name];
  } });
  return exports;
}
const { registerServiceTierPolicy } = await loadTs("../resources/pi-cora/service-tier.ts");
const fastMode = await loadTs("../src/shared/fast-mode.ts");
const compaction = await loadTs("../src/shared/context-compaction.ts");
const contextWindow = await loadTs("../src/shared/context-window.ts");
const { PiTurnAccumulator } = await loadTs("../src/main/orchestration/pi-turn.ts", {
  "@shared/context-compaction": compaction,
  "@shared/context-window": contextWindow,
  "@shared/fast-mode": fastMode,
});

async function runTurn({ refusal, modelId = "claude-opus-5", fast = true }) {
  const root = await mkdtemp(join(tmpdir(), "codara-pi-fast-fallback-"));
  let session;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), allowModelNetwork: false, refreshOnCreate: false });
    const requests = [];
    runtime.registerProvider("offline-fast", {
      api: "anthropic-messages", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-key",
      models: [{ id: modelId, name: "Offline fast fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }],
      streamSimple(model, _context, options) {
        const stream = new AssistantMessageEventStream();
        void (async () => {
          // What pi-ai's anthropic-messages builder hands the hook.
          const built = { model: model.id, max_tokens: 4096, stream: true, betas: ["oauth-2025-04-20"], messages: [] };
          const payload = (await options?.onPayload?.(built, model)) ?? built;
          requests.push(structuredClone(payload));
          const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          if (payload.speed === "fast" && refusal) {
            const message = { ...base, content: [], stopReason: "error", errorMessage: refusal };
            stream.push({ type: "error", reason: "error", error: message });
          } else {
            const message = { ...base, content: [{ type: "text", text: "Answered." }], stopReason: "stop" };
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
        })();
        return stream;
      },
    });
    const settings = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 6, baseDelayMs: 1 } });
    const env = { CODARA_PI_PROVIDER: "anthropic", ...(fast ? { CODARA_PI_FAST_MODE: "1" } : {}) };
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Offline fast-mode fixture.",
      extensionFactories: [(pi) => registerServiceTierPolicy(pi, env)] });
    await loader.reload();
    const created = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("offline-fast", modelId), thinkingLevel: "off", resourceLoader: loader, sessionManager: SessionManager.create(root, root), settingsManager: settings, tools: [] });
    session = created.session;
    const notes = [];
    const turn = new PiTurnAccumulator((event) => notes.push(event));
    let settled;
    const done = new Promise((resolve) => { settled = resolve; });
    session.subscribe((event) => {
      turn.consume(event);
      if (event.type === "agent_settled") settled();
    });
    await session.prompt("Answer briefly.");
    let timer;
    try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("turn did not settle")), 5000); })]); }
    finally { clearTimeout(timer); }
    // A second turn shows whether the decline outlives the retry.
    await session.prompt("And again.");
    return { requests, notes, result: turn.result() };
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

// Unsupported model (Opus 4.7 style 400): one refused fast request, one
// standard retry, fast mode stays off for the rest of the process.
{
  const { requests, notes, result } = await runTurn({
    refusal: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Fast mode is not supported for this model"}}',
  });
  assert.equal(requests[0].speed, "fast", "the first request asks for fast mode");
  assert.ok(requests[0].betas.includes("fast-mode-2026-02-01"));
  assert.equal("speed" in requests[1], false, "the retry runs at standard speed");
  assert.equal(requests[1].betas.includes("fast-mode-2026-02-01"), false);
  assert.equal(requests.length, 3, "one refused request, one retry, then the second turn");
  assert.equal("speed" in requests[2], false, "a refused model stays at standard speed for the session");
  assert.equal(result.failure, null, "the turn succeeds instead of failing");
  assert.equal(result.finalText, "Answered.");
  const note = notes.find((event) => event.kind === "system_note" && /declined fast mode/.test(event.message));
  assert.ok(note, "the user is told fast mode was declined");
  assert.match(note.message, /\(HTTP 400\).*standard speed for this session\. Retrying now\.$/);
  assert.equal(notes.some((event) => event.kind === "error"), false, "no provider error reaches the chat");
}

// Usage credits off or exhausted on a subscription: the provider's own text
// says "billing", which Pi treats as never retryable; the rewrite must still
// get the turn through at standard speed.
{
  const { requests, result } = await runTurn({
    refusal: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Fast mode requires usage credits. Check billing settings."}}',
  });
  assert.equal(requests[0].speed, "fast");
  assert.equal("speed" in requests[1], false);
  assert.equal(result.failure, null);
}

// Fast rate limit: retried at standard speed now, fast again after the cooldown.
{
  const { requests, notes, result } = await runTurn({
    refusal: '429 {"type":"error","error":{"type":"rate_limit_error","message":"Fast mode rate limit exceeded"}}',
  });
  assert.equal(requests[0].speed, "fast");
  assert.equal("speed" in requests[1], false);
  assert.equal(result.failure, null);
  assert.ok(notes.some((event) => /\(HTTP 429\).*for a few minutes/.test(event.message ?? "")));
}

// Accepted: every request stays fast and nothing is retried.
{
  const { requests, result } = await runTurn({ refusal: null });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.speed === "fast"));
  assert.equal(result.providerRetried, false);
}

// A model without fast mode, or the setting off, never asks for it.
for (const options of [{ modelId: "claude-sonnet-5" }, { fast: false }]) {
  const { requests } = await runTurn({ refusal: "400 should never be reached", ...options });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !("speed" in request)), JSON.stringify(options));
}

console.log("Pi fast-mode fallback (refusal, credits, rate limit, accepted, unsupported) integration passed");

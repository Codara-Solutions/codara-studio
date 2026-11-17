// test-runner: heavy (peaks near 210 MB)
// Fast-mode fallback through a real, offline Pi agent session.
//
//   node scripts/test-pi-fast-mode-fallback-integration.mjs
//
// The bundled extension asks for fast mode in before_provider_request. When
// the provider refuses it, the extension's message_end hook marks the model
// declined and rewrites the error so Pi's own auto-retry runs the request
// again; the retry must go out at standard speed, the turn must succeed, and
// the user must see Codara's note rather than a provider error. A provider
// registered in-process stands in for Codex, so nothing leaves the machine.
// Only Codex runs fast: a Claude session with the stamp on never asks for it.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const sdkDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
// pi-ai is nested under pi-coding-agent when another copy is hoisted, and
// hoisted otherwise; load the copy the SDK itself resolves.
function piAiModuleUrl(...segments) {
  for (let dir = sdkDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@earendil-works", "pi-ai", ...segments);
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
    if (dirname(dir) === dir) throw new Error(`pi-ai ${segments.join("/")} not found above ${sdkDir}`);
  }
}
const { AssistantMessageEventStream } = await import(piAiModuleUrl("dist", "utils", "event-stream.js"));
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

async function runTurn({ refusal, modelId = "gpt-5.6-sol", provider = "openai-codex", fast = true }) {
  const root = await mkdtemp(join(tmpdir(), "codara-pi-fast-fallback-"));
  let session;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), allowModelNetwork: false, refreshOnCreate: false });
    const requests = [];
    runtime.registerProvider("offline-fast", {
      api: provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-key",
      models: [{ id: modelId, name: "Offline fast fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }],
      streamSimple(model, _context, options) {
        const stream = new AssistantMessageEventStream();
        void (async () => {
          // Roughly what pi-ai's builders hand the hook.
          const built = provider === "anthropic"
            ? { model: model.id, max_tokens: 4096, stream: true, betas: ["oauth-2025-04-20"], messages: [] }
            : { model: model.id, stream: true, store: false, input: [] };
          const payload = (await options?.onPayload?.(built, model)) ?? built;
          requests.push(structuredClone(payload));
          const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
            usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          if ((payload.service_tier === "priority" || payload.speed === "fast") && refusal) {
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
    const env = { CODARA_PI_PROVIDER: provider, ...(fast ? { CODARA_PI_FAST_MODE: "1" } : {}) };
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

const isFast = (request) => request.service_tier === "priority";

// The tier refused outright: one refused fast request, one standard retry,
// fast mode stays off for the rest of the process.
{
  const { requests, notes, result } = await runTurn({
    refusal: '400 {"error":{"type":"invalid_request_error","message":"Unsupported service_tier: priority"}}',
  });
  assert.equal(isFast(requests[0]), true, "the first request asks for fast mode");
  assert.equal("service_tier" in requests[1], false, "the retry runs at standard speed");
  assert.equal(requests.length, 3, "one refused request, one retry, then the second turn");
  assert.equal("service_tier" in requests[2], false, "a refused model stays at standard speed for the session");
  assert.equal(result.failure, null, "the turn succeeds instead of failing");
  assert.equal(result.finalText, "Answered.");
  const note = notes.find((event) => event.kind === "system_note" && /declined fast mode/.test(event.message));
  assert.ok(note, "the user is told fast mode was declined");
  assert.match(note.message, /\(HTTP 400\).*standard speed for this session\. Retrying now\.$/);
  assert.equal(notes.some((event) => event.kind === "error"), false, "no provider error reaches the chat");
}

// The plan does not include the tier: the provider's own text says "billing",
// which Pi treats as never retryable; the rewrite must still get the turn
// through at standard speed.
{
  const { requests, result } = await runTurn({
    refusal: '400 {"error":{"type":"invalid_request_error","message":"The priority service tier is not available on your plan. Check billing settings."}}',
  });
  assert.equal(isFast(requests[0]), true);
  assert.equal("service_tier" in requests[1], false);
  assert.equal(result.failure, null);
}

// Fast rate limit: retried at standard speed now, fast again after the cooldown.
{
  const { requests, notes, result } = await runTurn({
    refusal: '429 {"error":{"type":"rate_limit_error","message":"Rate limit reached for priority processing"}}',
  });
  assert.equal(isFast(requests[0]), true);
  assert.equal("service_tier" in requests[1], false);
  assert.equal(result.failure, null);
  assert.ok(notes.some((event) => /\(HTTP 429\).*for a few minutes/.test(event.message ?? "")));
}

// Accepted: every request stays fast and nothing is retried.
{
  const { requests, result } = await runTurn({ refusal: null });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(isFast));
  assert.equal(result.providerRetried, false);
}

// Claude, even Opus with the stamp on, or the setting off, never asks for it.
for (const options of [
  { provider: "anthropic", modelId: "claude-opus-5" },
  { provider: "anthropic", modelId: "claude-sonnet-5" },
  { fast: false },
]) {
  const { requests } = await runTurn({ refusal: "400 should never be reached", ...options });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !("speed" in request) && !("service_tier" in request)), JSON.stringify(options));
}

console.log("Pi fast-mode fallback (Codex refusal, plan, rate limit, accepted; never Claude) integration passed");

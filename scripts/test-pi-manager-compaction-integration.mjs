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
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, process, Error, require: name => {
    if (!(name in imports)) throw new Error(`Unexpected runtime import: ${name}`);
    return imports[name];
  } });
  return exports;
}
const { registerContextCompaction } = await loadTs("../resources/pi-cora/compaction.ts");
const { PiManagerCompaction } = await loadTs("../src/main/orchestration/pi-manager-compaction.ts");
const shared = await loadTs("../src/shared/context-compaction.ts");
const { PiTurnAccumulator } = await loadTs("../src/main/orchestration/pi-turn.ts", { "@shared/context-compaction": shared });
const root = await mkdtemp(join(tmpdir(), "codara-pi-manager-compact-"));
let session;
try {
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), allowModelNetwork: false, refreshOnCreate: false });
  let normalCalls = 0, summaryCalls = 0;
  const finalText = "Original completed answer.";
  runtime.registerProvider("offline-manager-compaction", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-key",
    models: [{ id: "fixture", name: "Offline manager fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const summary = /summariz/i.test(context.systemPrompt);
        if (summary) summaryCalls++; else normalCalls++;
        const usage = summary
          ? { input: 100, output: 10, cacheRead: 20, cacheWrite: 30, totalTokens: 160 }
          : { input: 2000, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 2090 };
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: summary ? "The user requested a final answer, which was completed. Preserve it without repeating work." : finalText }],
          stopReason: "stop", timestamp: Date.now(), usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: summary ? 0.25 : 0.5 } } };
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Offline manager fixture.",
    extensionFactories: [(pi) => registerContextCompaction(pi, { CODARA_PI_HOST_COMPACTION: "settled", CODARA_PI_COMPACT_AT_TOKENS: "1000" })] });
  await loader.reload();
  const sessionManager = SessionManager.create(root, root);
  sessionManager.appendMessage({ role: "user", content: "Archived context.\n" + "An archived record with no pending action.\n".repeat(500), timestamp: Date.now() });
  sessionManager.appendMessage({ role: "assistant", api: "openai-completions", provider: "offline-manager-compaction", model: "fixture", content: [{ type: "text", text: "The archived request is complete." }], stopReason: "stop", timestamp: Date.now(), usage: { input: 2000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 2010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const created = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("offline-manager-compaction", "fixture"), thinkingLevel: "off", resourceLoader: loader, sessionManager, settingsManager: settings, tools: [] });
  session = created.session;
  const turn = new PiTurnAccumulator(undefined, { captureCost: true });
  const events = [], errors = [];
  let done;
  const complete = new Promise(resolve => { done = resolve; });
  const coordinator = new PiManagerCompaction({ request(command) {
    assert.equal(command.type, "compact");
    assert.equal(session.isIdle, true, "manager compaction begins only after the original agent loop settles");
    return session.compact(command.customInstructions);
  } }, { interrupted: () => false, onSettled: () => done(), onError: error => errors.push(error.message) });
  session.subscribe(event => {
    events.push(event.type);
    turn.consume(event);
    coordinator.consume(event);
  });
  await session.prompt("Produce the final answer. " + "Current request detail. ".repeat(20));
  let timeout;
  try { await Promise.race([complete, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("manager compaction did not settle")), 5000); })]); }
  finally { clearTimeout(timeout); coordinator.dispose(); }
  assert.deepEqual(errors, []);
  assert.equal(normalCalls, 1, "compaction must not rerun an already-completed manager answer");
  assert.equal(summaryCalls, 1);
  assert.equal(events.filter(type => type === "compaction_end").length, 1);
  assert.equal(turn.result().finalText, finalText);
  assert.equal(turn.result().assistantMessageCount, 1);
  const usage = turn.result().usage;
  assert.equal(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens, 2250);
  assert.equal(usage.costUsd, 0.75);
  assert.equal(session.sessionManager.getEntries().filter(entry => entry.type === "compaction").length, 1);
  console.log("Pinned Pi manager settlement, compaction, and usage integration passed");
} finally {
  await session?.dispose();
  await rm(root, { recursive: true, force: true });
}

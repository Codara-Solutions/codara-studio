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
async function loadTs(file) {
  const exports = {};
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports });
  return exports;
}
const { registerContextCompaction } = await loadTs("../resources/pi-cora/compaction.ts");
const { PiWorkerCompaction } = await loadTs("../src/main/orchestration/pi-worker-compaction.ts");
const root = await mkdtemp(join(tmpdir(), "codara-pi-compaction-"));
let session;
try {
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), allowModelNetwork: false, refreshOnCreate: false });
  let normalCalls = 0, summaryCalls = 0, toolCalls = 0;
  runtime.registerProvider("offline-compaction", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-key",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 4096 }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const summary = /summariz/i.test(context.systemPrompt);
        if (summary) summaryCalls += 1; else normalCalls += 1;
        const tool = !summary && normalCalls === 1;
        const content = tool ? [{ type: "toolCall", id: "probe-once", name: "probe", arguments: {} }]
          : [{ type: "text", text: summary ? "The probe completed once and returned durable-marker-42. Finish without repeating it." : "Completed after compaction." }];
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: tool ? 2000 : 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: tool ? 2020 : 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Offline worker fixture.",
    extensionFactories: [(pi) => registerContextCompaction(pi, { CODARA_PI_HOST_COMPACTION: "1", CODARA_PI_COMPACT_AT_TOKENS: "1000" })],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model: runtime.getModel("offline-compaction", "fixture"), settingsManager: settings, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root), tools: ["probe"], customTools: [{ name: "probe", label: "Probe", description: "A test side effect that must occur once.", parameters: { type: "object", properties: {} },
      async execute() { toolCalls += 1; return { content: [{ type: "text", text: "durable-marker-42 " + "Archived datum. ".repeat(1000) }], details: {} }; },
    }],
  }));
  const events = [];
  let resolveSettled, rejectSettled;
  const settled = new Promise((resolve, reject) => { resolveSettled = resolve; rejectSettled = reject; });
  const host = new PiWorkerCompaction({ request: (command) => session.compact(command.customInstructions), prompt: (message) => session.prompt(message) }, { interrupted: () => false, onError: rejectSettled });
  session.subscribe((event) => {
    events.push(event);
    if (host.consume(event)) return;
    if (event.type === "agent_settled") resolveSettled();
  });
  await session.prompt("Run probe once, preserve its marker, and finish.");
  let timer;
  try { await Promise.race([settled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("offline compaction stalled")), 5000); })]); }
  finally { clearTimeout(timer); host.dispose(); }
  assert.equal(toolCalls, 1, "compaction must not replay completed tool effects");
  assert.equal(summaryCalls, 1, "the real Pi session must generate a compaction summary");
  assert.equal(normalCalls, 2, "the host must resume the same task after compaction");
  assert.equal(events.filter((event) => event.type === "compaction_end" && event.result).length, 1);
  assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "compaction" && entry.summary.includes("durable-marker-42")));
  console.log("Pinned Pi compacts between tool rounds and resumes without replaying the tool");
} finally {
  if (session) await session.dispose();
  await rm(root, { recursive: true, force: true });
}

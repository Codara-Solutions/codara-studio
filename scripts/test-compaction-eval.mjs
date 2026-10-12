// Offline evaluation of Cora's context compaction over long agentic runs.
//
// Replays a synthetic 240-tool-call billing migration through a real pinned
// Pi session (offline provider, no network) with Codara's extension and the
// host coordinators that drive it in the app, and compacts it many times. Each
// configuration runs once per summarizer:
//
//   lossy     a fake summarizer that keeps nothing ("Continue the task.")
//   recorded  real-style summaries (scripts/fixtures/compaction-eval/) that
//             paraphrase constraints and drop older detail as they roll
//   failing   a summarizer that errors on every call, so the recovery ladder
//             ends in the extension's model-free summary
//
// After every compaction it inspects the exact context the model receives next
// and checks that the user's constraints, the plan's todos, file states,
// errors, worker results and artifacts survive verbatim, at 1, 3 and 6
// compactions and beyond; that no request outgrows the limit by more than one
// tool round; that every tool ran exactly once; and that compaction never
// loops. A decision recorded with codara_plan_update is required to survive;
// one stated only in assistant prose is reported, not required: once newer
// narration pushes it out of the ledger's recent conclusions it lives in the
// model summary alone, which the lossy summarizer drops by design.
//
// `node scripts/test-compaction-eval.mjs --verbose` prints the per-compaction
// table.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const VERBOSE = process.argv.includes("--verbose");
const sdkDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { AssistantMessageEventStream } = await import(
  pathToFileURL(join(sdkDir, "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js")).href
);

async function loadTs(file) {
  const exports = {};
  const url = new URL(file, import.meta.url);
  const output = ts.transpileModule(await readFile(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const siblings = {};
  for (const [, name] of output.matchAll(/require\("(\.\/[^"]+)"\)/g)) {
    if (!(name in siblings)) siblings[name] = await loadTs(new URL(`${name}.ts`, url).href);
  }
  vm.runInNewContext(output, {
    exports, process, Error, console: { info() {}, warn() {}, log() {} },
    require: (name) => {
      if (!(name in siblings)) throw new Error(`Unexpected runtime import: ${name}`);
      return siblings[name];
    },
  });
  return exports;
}

const { registerContextCompaction } = await loadTs("../resources/pi-cora/compaction.ts");
const { PiManagerCompaction } = await loadTs("../src/main/orchestration/pi-manager-compaction.ts");
const { PiWorkerCompaction } = await loadTs("../src/main/orchestration/pi-worker-compaction.ts");
const recorded = JSON.parse(await readFile(new URL("./fixtures/compaction-eval/real-style-summaries.json", import.meta.url), "utf8"));

const LIMIT_TOKENS = 24_000;
const CONTEXT_WINDOW = 200_000;
const TOTAL_STEPS = 240;

// ── The scenario ───────────────────────────────────────────────────────────

const PROMPT_1 = [
  "Migrate the billing service to the ledger API.",
  "Never modify files under vendor/.",
  "Use pnpm, not npm.",
].join("\n");
const PROMPT_2 = "Also: Keep the public function name chargeCustomer unchanged.";
const PROMPT_3 = "Continue and finish the migration, then summarize what changed.";

/** Needles that must reach the model verbatim after any number of compactions. */
const FACTS = [
  { id: "goal", needle: "Migrate the billing service to the ledger API", at: 0 },
  { id: "constraint:vendor", needle: "Never modify files under vendor/", at: 0 },
  { id: "constraint:pnpm", needle: "Use pnpm, not npm", at: 0 },
  { id: "constraint:api-name", needle: "Keep the public function name chargeCustomer unchanged", at: 90 },
  { id: "file:modified", needle: "src/billing/ledger-client.ts", at: 20 },
  { id: "file:created", needle: "src/billing/refunds.ts", at: 60 },
  { id: "error+fix", needle: "E_LEDGER_TIMEOUT", at: 40 },
  { id: "todo", needle: "Remove legacy adapter", at: 30 },
  { id: "plan:decision", needle: "chargeCustomer stays a thin wrapper over ledger.charge", at: 30 },
  { id: "worker:id", needle: "w-7f3a", at: 80 },
  { id: "worker:report", needle: "/runs/r1/w-7f3a/final-report.json", at: 120 },
];
/** Lives only in assistant prose, so only a summary can carry it. */
const SUMMARY_ONLY = { id: "decision", needle: "queue retries already provide backpressure", at: 12 };

const filler = (step, kind, chars) => {
  const line = `${kind} line for step ${step}: ledger balances, invoices, adjustments and audit trail entries. `;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
};

/** The scripted action for each step: [tool, arguments, output | Error, prose?]. */
function action(step) {
  const size = 3_000 + ((step * 977) % 4_000);
  switch (step) {
    case 12:
      return ["read", { path: "src/billing/queue.ts" }, filler(step, "queue", size),
        "Decision: keep the ledger client synchronous because queue retries already provide backpressure."];
    case 20:
      return ["edit", { path: "src/billing/ledger-client.ts" }, "Applied 3 replacements.\n" + filler(step, "diff", size)];
    case 30:
    case 150:
      return ["codara_plan_update", {
        goal: "Migrate the billing service to the ledger API",
        milestones: [
          { title: "Port invoices", status: "done" },
          { title: "Port refunds", status: step === 30 ? "in_progress" : "done" },
          { title: "Remove legacy adapter", status: step === 30 ? "pending" : "in_progress" },
        ],
        decisions: ["chargeCustomer stays a thin wrapper over ledger.charge"],
      }, "Plan recorded."];
    case 40:
      return ["bash", { command: "pnpm test refunds.spec.ts" }, new Error(`E_LEDGER_TIMEOUT in refunds.spec.ts after 30000ms\n${filler(step, "trace", 2_000)}`)];
    case 55:
      return ["bash", { command: "pnpm test refunds.spec.ts" }, "1 passed\n" + filler(step, "log", size)];
    case 60:
      return ["write", { path: "src/billing/refunds.ts" }, "Wrote 214 lines."];
    case 80:
      return ["codara_spawn_workers", { tasks: [{ title: "Port the remaining refund paths" }] }, "Spawned worker w-7f3a (claude, sonnet) for: Port the remaining refund paths."];
    case 120:
      return ["codara_wait_for_workers", {}, "w-7f3a completed: refund paths ported, 6 files changed. Report: /runs/r1/w-7f3a/final-report.json"];
    default: {
      const kinds = ["read", "bash", "read", "read", "bash"];
      const tool = kinds[step % kinds.length];
      // Models narrate as they go; the narration crowds the decision out of
      // the ledger's short list of recent conclusions.
      const prose = step % 3 === 0 ? `Next I check module-${step % 37} for direct invoice writes.` : undefined;
      return tool === "read"
        ? [tool, { path: `src/billing/module-${step % 37}.ts` }, filler(step, "source", size), prose]
        : [tool, { command: `pnpm lint src/billing/module-${step % 37}.ts` }, filler(step, "lint", size), prose];
    }
  }
}

// ── Measurement helpers ────────────────────────────────────────────────────

function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") return block.text ?? "";
  if (block.type === "thinking") return block.thinking ?? "";
  if (block.type === "toolCall") return `${block.name} ${JSON.stringify(block.arguments ?? {})}`;
  return "";
}
function messageText(message) {
  return typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content) ? message.content.map(blockText).join("\n") : "";
}
function contextText(context) {
  return [context.systemPrompt ?? "", ...context.messages.map(messageText)].join("\n");
}
const tokensOf = (text) => Math.ceil(text.length / 4);

// ── One run ────────────────────────────────────────────────────────────────

async function runScenario({ host, summarizer }) {
  const root = await mkdtemp(join(tmpdir(), "codara-compaction-eval-"));
  const state = {
    executed: 0,
    executions: new Map(),
    turnQuota: TOTAL_STEPS,
    compactions: 0,
    compactionSteps: [],
    awaitingFirstRequestAfter: null,
    checks: [],
    requests: [],
    summaryCalls: 0,
    firstIncluded: new Map(),
  };
  let session;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models"), allowModelNetwork: false, refreshOnCreate: false });
    runtime.registerProvider("offline-eval", {
      api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "offline-test-key",
      models: [{ id: "fixture", name: "Offline eval fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW, maxTokens: 8192 }],
      streamSimple(model, context) {
        const stream = new AssistantMessageEventStream();
        queueMicrotask(() => {
          const text = contextText(context);
          const input = tokensOf(text);
          const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
          const usage = { input, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: input + 40, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
          if (/summariz/i.test(context.systemPrompt ?? "")) {
            state.summaryCalls += 1;
            if (summarizer === "failing") {
              const error = { ...base, content: [], stopReason: "error", errorMessage: "summarizer unavailable (503)", usage };
              stream.push({ type: "error", reason: "error", error });
              stream.end();
              return;
            }
            const summary = summarizer === "lossy" ? "## Goal\nContinue the task.\n\n## Progress\nWork is ongoing." : recordedSummary(state);
            stream.push({ type: "done", reason: "stop", message: { ...base, content: [{ type: "text", text: summary }], stopReason: "stop", usage } });
            stream.end();
            return;
          }
          state.requests.push({ tokens: input, compactions: state.compactions });
          if (state.awaitingFirstRequestAfter !== null) {
            const k = state.awaitingFirstRequestAfter;
            state.awaitingFirstRequestAfter = null;
            const stepAtCompaction = state.compactionSteps[k - 1];
            const due = FACTS.filter((fact) => fact.at < stepAtCompaction);
            state.checks.push({
              k,
              step: stepAtCompaction,
              tokens: input,
              missing: due.filter((fact) => !text.includes(fact.needle)).map((fact) => fact.id),
              due: due.length,
              decision: SUMMARY_ONLY.at < stepAtCompaction ? text.includes(SUMMARY_ONLY.needle) : null,
            });
          }
          if (state.executed < state.turnQuota) {
            const step = state.executed;
            const [tool, args, , prose] = action(step);
            const content = [
              ...(prose ? [{ type: "text", text: prose }] : []),
              { type: "toolCall", id: `call-${step}-${state.requests.length}`, name: tool, arguments: args },
            ];
            stream.push({ type: "done", reason: "toolUse", message: { ...base, content, stopReason: "toolUse", usage } });
          } else {
            stream.push({ type: "done", reason: "stop", message: { ...base, content: [{ type: "text", text: `Turn finished at step ${state.executed}.` }], stopReason: "stop", usage } });
          }
          stream.end();
        });
        return stream;
      },
    });

    const toolNames = ["read", "edit", "write", "bash", "codara_plan_update", "codara_spawn_workers", "codara_wait_for_workers"];
    const customTools = toolNames.map((name) => ({
      name, label: name, description: `Eval ${name}.`,
      parameters: { type: "object", properties: {}, additionalProperties: true },
      async execute() {
        const step = state.executed;
        const [tool, , output] = action(step);
        assert.equal(tool, name, `step ${step} expected ${tool}, the model called ${name}`);
        state.executed += 1;
        state.executions.set(step, (state.executions.get(step) ?? 0) + 1);
        if (output instanceof Error) throw output;
        return { content: [{ type: "text", text: output }], details: {} };
      },
    }));

    const env = {
      CODARA_PI_HOST_COMPACTION: host === "manager" ? "settled" : "1",
      CODARA_PI_COMPACT_AT_TOKENS: String(LIMIT_TOKENS),
    };
    const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 6_000 }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Offline evaluation fixture for long agentic runs.",
      extensionFactories: [(pi) => registerContextCompaction(pi, env)],
    });
    await loader.reload();
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, modelRuntime: runtime, model: runtime.getModel("offline-eval", "fixture"),
      thinkingLevel: "off", settingsManager: settings, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), tools: toolNames, customTools,
    }));

    const reports = [];
    const errors = [];
    let turnDone = null;
    const client = {
      request: (command) => session.compact(command.customInstructions),
      prompt: (message) => session.prompt(message),
    };
    const contract = host === "manager" ? "" : [PROMPT_1, PROMPT_2, PROMPT_3].join("\n");
    const coordinator = host === "manager"
      ? new PiManagerCompaction(client, {
          interrupted: () => false,
          onSettled: () => turnDone?.(),
          onError: (error) => errors.push(error.message),
          onReport: (report) => reports.push(report),
        })
      : new PiWorkerCompaction(client, {
          interrupted: () => false,
          taskContract: () => contract,
          onError: (error) => errors.push(error.message),
          onReport: (report) => reports.push(report),
        });
    session.subscribe((event) => {
      if (event.type === "compaction_end" && event.result) {
        state.compactions += 1;
        state.compactionSteps.push(state.executed);
        state.awaitingFirstRequestAfter = state.compactions;
      }
      if (coordinator.consume(event)) return;
      if (event.type === "agent_settled" && !(coordinator.holdsTurnOpen?.() ?? false)) turnDone?.();
    });

    const runTurn = async (text, quota) => {
      state.turnQuota = quota;
      let timer;
      const done = new Promise((resolve) => { turnDone = resolve; });
      await session.prompt(text);
      try {
        await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`turn stalled at step ${state.executed}`)), 60_000); })]);
      } finally {
        clearTimeout(timer);
      }
    };
    if (host === "manager") {
      await runTurn(PROMPT_1, 90);
      await runTurn(PROMPT_2, 170);
      await runTurn(PROMPT_3, TOTAL_STEPS);
    } else {
      await runTurn(contract, TOTAL_STEPS);
    }
    coordinator.dispose();
    return { state, reports, errors };
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function recordedSummary(state) {
  const k = state.compactions + 1;
  const sections = new Map();
  recorded.fragments.forEach((fragment, index) => {
    if (fragment.afterStep > state.executed) return;
    if (!state.firstIncluded.has(index)) state.firstIncluded.set(index, k);
    const age = k - state.firstIncluded.get(index);
    if (typeof fragment.dropAfterCompactions === "number" && age >= fragment.dropAfterCompactions) return;
    if (!sections.has(fragment.section)) sections.set(fragment.section, []);
    sections.get(fragment.section).push(fragment.text);
  });
  return ["Goal", "Constraints & Preferences", "Progress", "Key Decisions", "Next Steps", "Critical Context"]
    .filter((name) => sections.has(name))
    .map((name) => `## ${name}\n${sections.get(name).join("\n")}`)
    .join("\n\n");
}

// ── Run every configuration ────────────────────────────────────────────────

const ROUND_SLACK_TOKENS = 2_500;
const results = [];
for (const host of ["manager", "worker"]) {
  for (const summarizer of ["lossy", "recorded", "failing"]) {
    const started = Date.now();
    const { state, reports, errors } = await runScenario({ host, summarizer });
    const label = `${host}/${summarizer}`;
    assert.deepEqual(errors, [], `${label}: coordinator errors`);
    assert.equal(state.executed, TOTAL_STEPS, `${label}: every scripted step ran`);
    for (const [step, count] of state.executions) assert.equal(count, 1, `${label}: step ${step} ran ${count} times`);
    assert.ok(state.compactions >= 6, `${label}: expected at least 6 compactions, got ${state.compactions}`);
    // About 300k tokens of tool output through a 24k limit that keeps ~6k
    // needs ~20 compactions at most; a loop would show up as far more.
    assert.ok(state.compactions <= 40, `${label}: ${state.compactions} compactions looks like a loop`);
    assert.equal(reports.length, state.compactions, `${label}: every compaction was host-driven and reported`);
    const maxTokens = Math.max(...state.requests.map((request) => request.tokens));
    assert.ok(maxTokens <= LIMIT_TOKENS + ROUND_SLACK_TOKENS, `${label}: a request reached ${maxTokens} tokens (limit ${LIMIT_TOKENS})`);
    for (const check of state.checks) {
      assert.deepEqual(check.missing, [], `${label}: facts lost after compaction ${check.k}: ${check.missing.join(", ")}`);
      assert.ok(check.tokens < LIMIT_TOKENS, `${label}: compaction ${check.k} left ${check.tokens} tokens`);
    }
    for (const k of [1, 3, 6]) assert.ok(state.checks.some((check) => check.k === k), `${label}: no request followed compaction ${k}`);
    if (summarizer === "failing") {
      assert.ok(reports.length > 0 && reports.every((report) => report.mode === "deterministic"), `${label}: the ladder must end in the model-free summary`);
    } else {
      assert.ok(reports.every((report) => report.outcome !== "failed"), `${label}: no compaction may fail`);
    }
    const at = (k) => state.checks.find((check) => check.k === k);
    const decisionKept = state.checks.filter((check) => check.decision !== null);
    results.push({
      run: label,
      compactions: state.compactions,
      summaryCalls: state.summaryCalls,
      maxRequestTokens: maxTokens,
      afterTokens: [1, 3, 6].map((k) => at(k)?.tokens),
      factsKept: [1, 3, 6].map((k) => `${at(k).due - at(k).missing.length}/${at(k).due}`),
      allChecks: `${state.checks.length} compactions checked, 0 facts lost`,
      decisionKept: `${decisionKept.filter((check) => check.decision).length}/${decisionKept.length}`,
      ms: Date.now() - started,
    });
    if (VERBOSE) {
      console.log(`\n${label}`);
      for (const check of state.checks) {
        console.log(`  k=${String(check.k).padStart(2)} step=${String(check.step).padStart(3)} tokens=${String(check.tokens).padStart(6)} facts=${check.due - check.missing.length}/${check.due} decision=${check.decision}`);
      }
    }
  }
}

console.log("Compaction eval (limit %d tokens, %d tool calls per run):", LIMIT_TOKENS, TOTAL_STEPS);
for (const result of results) {
  console.log(
    `  ${result.run.padEnd(17)} compactions=${String(result.compactions).padStart(2)} maxRequest=${result.maxRequestTokens} ` +
    `after@1/3/6=${result.afterTokens.join("/")} facts@1/3/6=${result.factsKept.join(" ")} ` +
    `decision(summary-only)=${result.decisionKept} ${result.ms}ms`,
  );
}
console.log("Compaction eval passed");

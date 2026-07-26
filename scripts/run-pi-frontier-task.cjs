#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

const { validateRegressionReplayEvidence } = require("./pi-frontier-evidence.cjs");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) throw new Error(`Invalid argument: ${key}`);
    values[key.slice(2)] = argv[++index];
  }
  return values;
}

function requiredFile(value, label) {
  const target = path.resolve(String(value || ""));
  if (!value || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw new Error(`${label} must be an existing file`);
  return target;
}

function requiredDirectory(value, label) {
  const target = path.resolve(String(value || ""));
  if (!value || !fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${label} must be an existing directory`);
  return target;
}

function textFromResult(result) {
  const content = result && typeof result === "object" && Array.isArray(result.content) ? result.content : [];
  return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

function semanticLabel(value) {
  return String(value || "").trim().toLowerCase()
    .replace(/obligation-[a-f0-9]{20}/g, "obligation-<id>")
    .replace(/\b[a-f0-9]{16,64}\b/g, "<hash>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/\s+/g, " ");
}

function admissionAttemptCounts(evidence) {
  const history = Array.isArray(evidence.admissionReviewHistory) ? evidence.admissionReviewHistory : [];
  const executionFailures = history.filter((attempt) => attempt?.kind === "execution").length;
  return {
    admissionAttempts: history.length,
    admissionExecutionFailures: executionFailures,
    admissionReportAttempts: history.length - executionFailures,
  };
}

async function main() {
  if (process.env.CODARA_ALLOW_LIVE_PI_SMOKE !== "1") throw new Error("CODARA_ALLOW_LIVE_PI_SMOKE=1 is required for subscription inference");
  const args = parseArgs(process.argv.slice(2));
  const productRoot = path.resolve(__dirname, "..");
  const workspace = requiredDirectory(args.workspace, "--workspace");
  const promptPath = requiredFile(args.prompt, "--prompt");
  const task = fs.readFileSync(promptPath, "utf8").replaceAll("\r\n", "\n").trim();
  const configDir = requiredDirectory(args["config-dir"] || path.join(os.homedir(), ".Codara", "pi-agent"), "--config-dir");
  const stateDir = path.resolve(String(args["state-dir"] || ""));
  if (!args["state-dir"]) throw new Error("--state-dir is required");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateRelative = path.relative(workspace, stateDir);
  if (stateRelative === "" || (!stateRelative.startsWith(`..${path.sep}`) && stateRelative !== ".." && !path.isAbsolute(stateRelative))) {
    throw new Error("--state-dir must be outside the benchmark workspace");
  }
  const timeoutSeconds = Number(args["timeout-seconds"] || 21_600);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 21_600) throw new Error("--timeout-seconds must be 60-21600");
  const expectedOutcome = args["expected-outcome"] || "final-safe";
  if (expectedOutcome !== "final-safe" && expectedOutcome !== "contract-blocked" && expectedOutcome !== "admission-only") {
    throw new Error("--expected-outcome must be final-safe, contract-blocked, or admission-only");
  }
  const provider = args.provider || "openai-codex";
  const model = args.model || "gpt-5.6-sol";
  const thinking = args.thinking || "high";
  const tracerModel = args["tracer-model"]?.trim() || null;
  const familyAuditorModel = args["family-auditor-model"]?.trim() || null;
  const managedModel = /^[a-z0-9-]+\/[a-z0-9._-]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/;
  if (tracerModel && !managedModel.test(tracerModel)) {
    throw new Error("--tracer-model is invalid");
  }
  if (familyAuditorModel && !managedModel.test(familyAuditorModel)) {
    throw new Error("--family-auditor-model is invalid");
  }
  const runtime = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-runtime.ts"));
  const verification = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-verification.ts"));
  const { PiRpcClient } = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-rpc-client.ts"));
  const { PiTurnAccumulator } = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-turn.ts"));
  const manifest = await verification.discoverPiFrontierVerification(workspace, task);
  const runId = `product-frontier-${randomUUID()}`;
  const manifestPath = path.join(stateDir, `${runId}.json`);
  const manifestText = JSON.stringify(manifest);
  const manifestSha256 = verification.verificationManifestSha256(manifest);
  assert.equal(createHash("sha256").update(manifestText).digest("hex"), manifestSha256);
  fs.writeFileSync(manifestPath, manifestText, { mode: 0o600 });
  const sessionDir = path.join(stateDir, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const agentDir = path.join(configDir, "agents");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  for (const name of [
    "codara-frontier-contract-tracer.md",
    "codara-frontier-contract-auditor.md",
    "codara-frontier-diff-auditor.md",
    "codara-frontier-family-auditor.md",
    "codara-frontier-integration-auditor.md",
  ]) {
    const target = path.join(agentDir, name);
    let contents = fs.readFileSync(path.join(productRoot, "resources/pi-cora/agents", name), "utf8");
    if (name === "codara-frontier-contract-tracer.md" && tracerModel) {
      contents = contents.replace(/^model: .*$/m, `model: ${tracerModel}`);
    }
    if (name === "codara-frontier-family-auditor.md" && familyAuditorModel) {
      contents = contents.replace(/^model: .*$/m, `model: ${familyAuditorModel}`);
    }
    fs.writeFileSync(target, contents, { mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
  }
  const auth = await runtime.inspectPiSubscriptionAuth(path.join(configDir, "auth.json"), provider);
  assert.equal(auth.type, "oauth");
  const location = await runtime.resolvePinnedPiRuntime([path.join(productRoot, "node_modules")]);
  const plan = runtime.buildPiManagerLaunchPlan({
    runtime: location,
    provider,
    configDir,
    sessionDir,
    sessionId: `product-frontier-session-${randomUUID()}`,
    runId,
    mode: "execute",
    executionPolicy: "frontier",
    cwd: workspace,
    bridgePath: path.join(productRoot, "resources/codara-studio-mcp/server.js"),
    extensionPaths: [
      path.join(location.packageRoot, "examples/extensions/subagent/index.ts"),
      path.join(productRoot, "resources/pi-cora/frontier-gate.ts"),
    ],
    frontierManifestPath: manifestPath,
    frontierManifestSha256: manifestSha256,
    processExecutable: process.execPath,
    model,
    thinking,
    sessionName: `Product Frontier benchmark ${path.basename(workspace)}`,
    codaraHomeDir: path.join(os.homedir(), ".Codara"),
  });
  for (const key of Object.keys(plan.env)) assert.equal(key.endsWith("_API_KEY"), false, `metered credential survived: ${key}`);
  const client = new PiRpcClient(plan, { requestTimeoutMs: 120_000, shutdownGraceMs: 3_000 });
  const turn = new PiTurnAccumulator();
  const startedAt = Date.now();
  const toolTrace = [];
  const machineResults = [];
  const subagentRuns = [];
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const unsubscribe = client.onEvent((event) => {
    turn.consume(event);
    if (event.type === "tool_execution_start") {
      toolTrace.push({ phase: "start", tool: event.toolName, atMs: Date.now() - startedAt });
      process.stderr.write(`[product-frontier] start ${event.toolName} @ ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
    }
    if (event.type === "tool_execution_end") {
      toolTrace.push({ phase: "end", tool: event.toolName, error: event.isError === true, atMs: Date.now() - startedAt });
      const text = textFromResult(event.result);
      if (/frontier(?:_machine)?=/.test(text)) machineResults.push({ tool: event.toolName, text: text.slice(-8_000), atMs: Date.now() - startedAt });
      if (event.toolName === "subagent" && Array.isArray(event.result?.details?.results)) {
        subagentRuns.push({
          atMs: Date.now() - startedAt,
          agents: event.result.details.results.map((agent) => ({
            agent: agent?.agent || null,
            model: agent?.model || null,
            exitCode: Number.isInteger(agent?.exitCode) ? agent.exitCode : null,
            stopReason: agent?.stopReason || null,
            usage: agent?.usage && typeof agent.usage === "object" ? {
              input: Number(agent.usage.input || 0),
              output: Number(agent.usage.output || 0),
              cacheRead: Number(agent.usage.cacheRead || 0),
              cacheWrite: Number(agent.usage.cacheWrite || 0),
              turns: Number(agent.usage.turns || 0),
            } : null,
          })),
        });
      }
      process.stderr.write(`[product-frontier] end ${event.toolName} error=${event.isError === true} @ ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
    }
    if (event.type === "agent_settled") settle();
  });
  let timer;
  try {
    await client.start();
    const benchmarkContract = expectedOutcome === "contract-blocked"
      ? "Follow the injected machine gate exactly. This is a cache miss: run baseline, invoke the exact managed contract review, and submit its exact report to admission. Independently test whether the tracked contract is jointly implementable. If and only if admission returns frontier=contract-blocked with CONTRACT_BLOCKER_JSON, do not retry, do not mutate, and end immediately by reporting that exact blocker. Any source or contract edit is a benchmark failure. codara_complete is intentionally unavailable in this isolated harness."
      : expectedOutcome === "admission-only"
        ? "Follow the injected machine gate exactly through baseline, the exact managed contract review, and cora_frontier_admit. This is an admission-only measurement: do not mutate any file, do not implement or repair anything, do not run final verification, and do not use codara_complete. After frontier=admission-verified, end with exactly FRONTIER_ADMISSION_ONLY_OK."
        : "Follow the injected machine gate exactly. This is a cache miss: baseline, the exact managed contract review, admission, implementation, final verification, then the exact diff-bound safety review are mandatory. Do not end after provisional verification. When admission or structural safety validation prints a required_*_subagent_input, invoke that exact content-addressed corrective input directly; it includes the validator's signed feedback. Re-run final verification before another safety review only after mutation or an UNSAFE repair. Never rerun a context-free rejected review. codara_complete is intentionally unavailable in this isolated harness; end only after a tool result says frontier_machine=final-safe.";
    await client.prompt(`${task}\n\nCORA PRODUCT FRONTIER BENCHMARK:\n${benchmarkContract}`);
    await Promise.race([
      settled,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Product Frontier timed out after ${timeoutSeconds}s`)), timeoutSeconds * 1000);
        timer.unref();
      }),
    ]);
    const result = turn.result();
    if (result.failure) throw new Error(result.failure);
    const evidencePath = manifestPath.replace(/\.json$/, ".evidence.json");
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    if (expectedOutcome === "admission-only") {
      const currentManifest = await verification.discoverPiFrontierVerification(workspace, task);
      const expectedObligationIds = new Set(manifest.contractObligations.map((obligation) => obligation.id));
      const admittedObligationIds = new Set((evidence.admissionCuts || []).flatMap((cut) => cut.obligationIds || []));
      const exactCoverage = expectedObligationIds.size === admittedObligationIds.size &&
        [...expectedObligationIds].every((id) => admittedObligationIds.has(id));
      if (evidence.stage !== "admission-verified" || evidence.baselineVerified !== true ||
        evidence.admissionVerified !== true || evidence.admissionSource !== "managed-review" ||
        currentManifest.trackedTreeSha256 !== manifest.trackedTreeSha256 ||
        currentManifest.contractTreeSha256 !== manifest.contractTreeSha256 || !exactCoverage ||
        !result.finalText.trim().endsWith("FRONTIER_ADMISSION_ONLY_OK")) {
        throw new Error(`Product Frontier did not prove mutation-free exact admission (stage=${evidence.stage})`);
      }
      const summary = {
        schemaVersion: 1,
        ok: true,
        expectedOutcome,
        runId,
        provider,
        model,
        thinking,
        tracerModel: tracerModel || "openai-codex/gpt-5.3-codex-spark:low",
        familyAuditorModel: familyAuditorModel || "openai-codex/gpt-5.6-sol:medium",
        durationMs: Date.now() - startedAt,
        usage: result.usage,
        manifestSha256,
        contractObligations: expectedObligationIds.size,
        admissionCuts: evidence.admissionCuts.length,
        coveredObligations: admittedObligationIds.size,
        admissionFamilies: new Set(evidence.admissionCuts.map((cut) => semanticLabel(cut.family)).filter(Boolean)).size,
        admissionOperations: new Set(evidence.admissionCuts.flatMap((cut) => Array.isArray(cut.operations)
          ? cut.operations.map((operation) => semanticLabel(operation)).filter(Boolean)
          : [])).size,
        ...admissionAttemptCounts(evidence),
        envelopeCanonicalized: evidence.admissionReviewHistory?.at(-1)?.canonicalizedEnvelope === true,
        trackedTreeUnchanged: true,
        contractTreeUnchanged: true,
        toolTrace,
        subagentRuns,
        machineResults,
        evidencePath,
        apiCredentialsInherited: false,
      };
      fs.writeFileSync(path.join(stateDir, "product-frontier-summary.json"), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary));
      return;
    }
    if (expectedOutcome === "contract-blocked") {
      const currentManifest = await verification.discoverPiFrontierVerification(workspace, task);
      const currentTrackedTreeSha256 = currentManifest.trackedTreeSha256;
      const currentContractTreeSha256 = currentManifest.contractTreeSha256;
      if (evidence.stage !== "contract-blocked" || evidence.baselineVerified !== true || evidence.admissionVerified !== false ||
        !evidence.admissionBlocker || !evidence.admissionBlockerWitness ||
        evidence.admissionReviewHistory?.at(-1)?.valid !== true ||
        currentTrackedTreeSha256 !== manifest.trackedTreeSha256 || currentContractTreeSha256 !== manifest.contractTreeSha256) {
        throw new Error(`Product Frontier did not prove a mutation-free contract blocker (stage=${evidence.stage})`);
      }
      const summary = {
        schemaVersion: 1,
        ok: true,
        expectedOutcome,
        runId,
        provider,
        model,
        thinking,
        tracerModel: tracerModel || "openai-codex/gpt-5.3-codex-spark:low",
        familyAuditorModel: familyAuditorModel || "openai-codex/gpt-5.6-sol:medium",
        durationMs: Date.now() - startedAt,
        usage: result.usage,
        manifestSha256,
        contractBlocker: evidence.admissionBlocker,
        blockerWitnessOutputSha256: evidence.admissionBlockerWitness.outputSha256,
        trackedTreeUnchanged: true,
        contractTreeUnchanged: true,
        toolTrace,
        subagentRuns,
        machineResults,
        evidencePath,
        apiCredentialsInherited: false,
      };
      fs.writeFileSync(path.join(stateDir, "product-frontier-summary.json"), JSON.stringify(summary, null, 2));
      console.log(JSON.stringify(summary));
      return;
    }
    if (evidence.admissionVerified !== true) {
      const admissionErrors = Array.isArray(evidence.admissionReviewHistory?.at(-1)?.errors)
        ? evidence.admissionReviewHistory.at(-1).errors
        : [];
      const currentManifest = await verification.discoverPiFrontierVerification(workspace, task);
      const failure = {
        schemaVersion: 1,
        ok: false,
        expectedOutcome,
        runId,
        provider,
        model,
        thinking,
        tracerModel: tracerModel || "openai-codex/gpt-5.3-codex-spark:low",
        familyAuditorModel: familyAuditorModel || "openai-codex/gpt-5.6-sol:medium",
        durationMs: Date.now() - startedAt,
        usage: result.usage,
        manifestSha256,
        stage: evidence.stage,
        contractObligations: manifest.contractObligations.length,
        ...admissionAttemptCounts(evidence),
        admissionErrors,
        trackedTreeUnchanged: currentManifest.trackedTreeSha256 === manifest.trackedTreeSha256,
        contractTreeUnchanged: currentManifest.contractTreeSha256 === manifest.contractTreeSha256,
        toolTrace,
        subagentRuns,
        machineResults,
        evidencePath,
        apiCredentialsInherited: false,
      };
      fs.writeFileSync(path.join(stateDir, "product-frontier-summary.json"), JSON.stringify(failure, null, 2));
      throw new Error(`Product Frontier did not pass admission (stage=${evidence.stage}; attempts=${failure.admissionAttempts}; errors=${admissionErrors.join("; ")})`);
    }
    const admittedCutIds = new Set(Array.isArray(evidence.admissionCuts)
      ? evidence.admissionCuts.map((cut) => cut?.id).filter((id) => typeof id === "string")
      : []);
    const cutFamilies = new Map();
    const familyCounts = new Map();
    for (const cut of Array.isArray(evidence.admissionCuts) ? evidence.admissionCuts : []) {
      if (typeof cut?.id !== "string" || typeof cut?.family !== "string") continue;
      const family = cut.family.trim().toLowerCase();
      cutFamilies.set(cut.id, family);
      familyCounts.set(family, (familyCounts.get(family) || 0) + 1);
    }
    const cutKinds = new Map();
    const familyInteractions = new Map();
    for (const probe of Array.isArray(evidence.safetyEvidence) ? evidence.safetyEvidence : []) {
      const kinds = cutKinds.get(probe?.cutId) || new Set();
      kinds.add(probe?.kind);
      cutKinds.set(probe?.cutId, kinds);
      if (probe?.kind === "interaction") {
        const family = cutFamilies.get(probe?.cutId);
        if (family) familyInteractions.set(family, (familyInteractions.get(family) || 0) + 1);
      }
    }
    const completeCutSafety = evidence.finalFingerprint?.changedHunks === 0 ||
      (admittedCutIds.size === evidence.admissionCuts?.length && [...admittedCutIds].every((cutId) =>
        cutKinds.get(cutId)?.has("intended") && cutKinds.get(cutId)?.has("non-regression")));
    const completeFamilySafety = evidence.finalFingerprint?.changedHunks === 0 ||
      [...familyCounts].every(([family, count]) =>
        (familyInteractions.get(family) || 0) >= (count >= 3 ? 2 : count >= 2 ? 1 : 0));
    const regressionEvidence = validateRegressionReplayEvidence(evidence);
    if (evidence.stage !== "final-safe" || evidence.baselineVerified !== true ||
      evidence.finalSafeFingerprint?.sha256 !== evidence.finalFingerprint?.sha256 || evidence.safetyAssessment?.verdict !== "SAFE" ||
      evidence.safetyAssessment?.regressions !== 0 || !Array.isArray(evidence.safetyEvidence) ||
      evidence.safetyEvidence.length !== evidence.safetyAssessment?.probes || !completeCutSafety || !completeFamilySafety || !regressionEvidence.ok) {
      throw new Error(`Product Frontier did not reach structured final SAFE (stage=${evidence.stage}; regressionEvidence=${regressionEvidence.errors.join("; ")})`);
    }
    const summary = {
      schemaVersion: 1,
      ok: true,
      expectedOutcome,
      runId,
      provider,
      model,
      thinking,
      tracerModel: tracerModel || "openai-codex/gpt-5.3-codex-spark:low",
      familyAuditorModel: familyAuditorModel || "openai-codex/gpt-5.6-sol:medium",
      durationMs: Date.now() - startedAt,
      usage: result.usage,
      manifestSha256,
      cacheEligible: manifest.cacheEligible,
      frontierPolicy: manifest.frontierPolicy,
      admissionCuts: evidence.admissionCuts.length,
      deepFamilies: [...familyCounts.values()].filter((count) => count >= 2).length,
      criticalFamilies: [...familyCounts.values()].filter((count) => count >= 3).length,
      safetyReviewAttempts: Array.isArray(evidence.safetyReviewHistory) ? evidence.safetyReviewHistory.length : 0,
      preventedRegressions: Array.isArray(evidence.regressionLedger) ? evidence.regressionLedger.length : 0,
      regressionGeneralizations: regressionEvidence.generalizations,
      changedHunks: evidence.finalFingerprint.changedHunks,
      safetyProbes: evidence.safetyAssessment.probes,
      safetyVerdict: evidence.safetyAssessment.verdict,
      finalDiffSha256: evidence.finalFingerprint.sha256,
      toolTrace,
      subagentRuns,
      machineResults,
      evidencePath,
      apiCredentialsInherited: false,
    };
    fs.writeFileSync(path.join(stateDir, "product-frontier-summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    if (timer) clearTimeout(timer);
    unsubscribe();
    await client.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

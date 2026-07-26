#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

if (process.env.CODARA_ALLOW_LIVE_PI_SMOKE !== "1") {
  console.error("Refusing live subscription inference without CODARA_ALLOW_LIVE_PI_SMOKE=1");
  process.exit(2);
}

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

async function main() {
  const productRoot = path.resolve(__dirname, "..");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codara-frontier-live-"));
  const workspace = path.join(temporary, "workspace");
  const state = path.join(temporary, "state");
  const sessionDir = path.join(temporary, "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const runtime = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-runtime.ts"));
  const verification = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-verification.ts"));
  const { PiRpcClient } = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-rpc-client.ts"));
  const { PiTurnAccumulator } = loadTypeScriptModule(path.join(productRoot, "src/main/orchestration/pi-turn.ts"));
  const sourceConfigDir = process.env.CODARA_PI_SMOKE_CONFIG || path.join(os.homedir(), ".Codara", "pi-agent");
  const admissionOnly = process.env.CODARA_PI_FRONTIER_ADMISSION_ONLY === "1";
  const tracerModel = process.env.CODARA_PI_FRONTIER_TRACER_MODEL?.trim() || null;
  if (tracerModel && !/^[a-z0-9-]+\/[a-z0-9._-]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(tracerModel)) {
    throw new Error("CODARA_PI_FRONTIER_TRACER_MODEL is invalid");
  }
  const configDir = admissionOnly || tracerModel
    ? path.join(temporary, "config")
    : sourceConfigDir;
  if (configDir !== sourceConfigDir) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(sourceConfigDir, "auth.json"), path.join(configDir, "auth.json"));
    if (process.platform !== "win32") fs.chmodSync(path.join(configDir, "auth.json"), 0o600);
  }
  const provider = "openai-codex";
  const model = "gpt-5.6-sol";
  const thinking = "high";
  let client;
  try {
    write(workspace, "package.json", JSON.stringify({
      name: "frontier-live-fixture",
      private: true,
      scripts: { test: "node --test test/*.test.js" },
    }, null, 2));
    write(workspace, "README.md", `# Quota ledger contract

\`QuotaLedger\` is a synchronous in-memory quota state machine.

- The constructor accepts an integer quota from 1 through 10 and starts with zero usage.
- \`reserve(units)\` accepts a positive safe integer only. It throws \`RangeError\` before mutation when the reservation would exceed quota; otherwise it returns the exact detached snapshot.
- \`release(units)\` accepts a positive safe integer only. It throws \`RangeError\` before mutation when usage would become negative; otherwise it returns the exact detached snapshot.
- \`setQuota(quota)\` accepts an integer from 1 through 10. It rejects a quota below current usage before mutation and returns the exact detached snapshot on success.
- \`isAtLimit()\` is a pure query that returns true exactly when usage equals quota. It never mutates state and remains correct after reserve, release, and setQuota transitions.
- \`snapshot()\` returns a newly allocated object with exactly the enumerable keys \`quota\` and \`used\`.
- \`serialize()\` returns JSON for exactly \`{version:1, quota, used}\`. \`QuotaLedger.restore(text)\` accepts only that exact shape and rejects malformed state before exposing a ledger.
`);
    write(workspace, "src/quota-ledger.js", `"use strict";

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(label);
  return value;
}

class QuotaLedger {
  constructor(quota) {
    this.quota = integer(quota, 1, 10, "quota");
    this.used = 0;
  }

  reserve(units) {
    integer(units, 1, Number.MAX_SAFE_INTEGER, "units");
    if (units > this.quota - this.used) throw new RangeError("capacity");
    this.used += units;
    return this.snapshot();
  }

  release(units) {
    integer(units, 1, Number.MAX_SAFE_INTEGER, "units");
    if (units > this.used) throw new RangeError("usage");
    this.used -= units;
    return this.snapshot();
  }

  setQuota(quota) {
    integer(quota, 1, 10, "quota");
    if (quota < this.used) throw new RangeError("usage");
    this.quota = quota;
    return this.snapshot();
  }

  snapshot() { return { quota: this.quota, used: this.used }; }
  serialize() { return JSON.stringify({ version: 1, quota: this.quota, used: this.used }); }

  static restore(text) {
    const value = JSON.parse(text);
    if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).sort().join(",") !== "quota,used,version" || value.version !== 1) {
      throw new RangeError("state");
    }
    const ledger = new QuotaLedger(value.quota);
    integer(value.used, 0, value.quota, "used");
    ledger.used = value.used;
    return ledger;
  }
}

module.exports = { QuotaLedger };
`);
    write(workspace, "test/quota-ledger.test.js", `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { QuotaLedger } = require("../src/quota-ledger.js");

test("transitions are atomic and snapshots detached", () => {
  const ledger = new QuotaLedger(5);
  const first = ledger.reserve(3);
  first.used = 99;
  assert.deepEqual(ledger.snapshot(), { quota: 5, used: 3 });
  assert.throws(() => ledger.reserve(3), RangeError);
  assert.deepEqual(ledger.snapshot(), { quota: 5, used: 3 });
  assert.deepEqual(ledger.release(2), { quota: 5, used: 1 });
  assert.throws(() => ledger.setQuota(0), RangeError);
  assert.deepEqual(ledger.snapshot(), { quota: 5, used: 1 });
});

test("serialization round trips exact state", () => {
  const ledger = new QuotaLedger(4);
  ledger.reserve(2);
  const restored = QuotaLedger.restore(ledger.serialize());
  assert.deepEqual(restored.snapshot(), { quota: 4, used: 2 });
  assert.throws(() => QuotaLedger.restore('{"version":1,"quota":4,"used":2,"extra":true}'), RangeError);
});
`);
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["-c", "user.name=Codara Live", "-c", "user.email=live@codara.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: workspace });
    const manifest = await verification.discoverPiFrontierVerification(workspace);
    assert.equal(manifest.cacheEligible, true);
    assert.ok(manifest.contractPaths.includes("README.md"));
    assert.equal(manifest.commands.length, 1);
    const runId = `frontier-live-${randomUUID()}`;
    const manifestPath = path.join(state, `${runId}.json`);
    const manifestText = JSON.stringify(manifest);
    const manifestSha256 = verification.verificationManifestSha256(manifest);
    assert.equal(createHash("sha256").update(manifestText).digest("hex"), manifestSha256);
    fs.writeFileSync(manifestPath, manifestText, { mode: 0o600 });

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
      sessionId: `frontier-live-session-${randomUUID()}`,
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
      sessionName: "Codara Frontier live product gate",
      codaraHomeDir: path.join(os.homedir(), ".Codara"),
    });
    assert.equal(plan.frontierAdmissionArtifactSha256, null);
    for (const key of Object.keys(plan.env)) {
      assert.equal(key.endsWith("_API_KEY"), false, `metered credential survived: ${key}`);
    }

    client = new PiRpcClient(plan, { requestTimeoutMs: 120_000, shutdownGraceMs: 3_000 });
    const turn = new PiTurnAccumulator();
    const startedAt = Date.now();
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    const toolTrace = [];
    const unsubscribe = client.onEvent((event) => {
      turn.consume(event);
      if (event.type === "tool_execution_start") {
        toolTrace.push({ phase: "start", tool: event.toolName, atMs: Date.now() - startedAt });
        console.log(`[frontier-live] start ${event.toolName} @ ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
      if (event.type === "tool_execution_end") {
        toolTrace.push({ phase: "end", tool: event.toolName, error: event.isError === true, atMs: Date.now() - startedAt });
        console.log(`[frontier-live] end ${event.toolName} error=${event.isError === true} @ ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
      if (event.type === "agent_settled") settle();
    });
    await client.start();
    await client.prompt(admissionOnly
      ? `Run the exact Cora Frontier baseline and managed admission chain on this cache miss, then call cora_frontier_admit. Do not edit any file, do not continue into implementation, and do not use codara_complete. When admission succeeds, reply with exactly FRONTIER_ADMISSION_LIVE_OK and no other text.`
      : `Implement the documented QuotaLedger.isAtLimit() behavior and add focused public regression coverage. Follow the Cora Frontier machine gate exactly: run baseline, use the exact managed admission chain on this cache miss, admit it, implement, run final verification, then use the exact diff-bound safety reviewer. Do not stop after provisional verification. When the tool result says frontier_machine=final-safe, reply with exactly FRONTIER_LIVE_SAFE and no other text. codara_complete is intentionally unavailable in this isolated product-gate smoke.`);
    let timeout;
    try {
      await Promise.race([
        settled,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Frontier live smoke timed out")), 60 * 60 * 1000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    unsubscribe();
    const result = turn.result();
    assert.equal(result.failure, null);
    assert.match(result.finalText.trim(), admissionOnly ? /FRONTIER_ADMISSION_LIVE_OK$/ : /FRONTIER_LIVE_SAFE$/);
    const evidencePath = manifestPath.replace(/\.json$/, ".evidence.json");
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.baselineVerified, true);
    assert.equal(evidence.admissionVerified, true);
    assert.equal(evidence.admissionSource, "managed-review");
    const exactObligationIds = new Set(manifest.contractObligations.map((obligation) => obligation.id));
    const admittedObligationIds = new Set(evidence.admissionCuts.flatMap((cut) => cut.obligationIds));
    assert.deepEqual([...admittedObligationIds].sort(), [...exactObligationIds].sort());
    if (admissionOnly) {
      assert.equal(evidence.stage, "admission-verified");
      assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: workspace, encoding: "utf8" }), "");
      const summary = {
        ok: true,
        phase: "admission-only",
        provider,
        managerModel: model,
        managerThinking: thinking,
        tracerModel: tracerModel || "openai-codex/gpt-5.3-codex-spark:low",
        auditorModel: "openai-codex/gpt-5.6-sol:medium",
        durationMs: Date.now() - startedAt,
        usage: result.usage,
        toolTrace,
        admissionCuts: evidence.admissionCuts.length,
        contractObligations: manifest.contractObligations.length,
        coveredObligations: admittedObligationIds.size,
        workspaceUnchanged: true,
        apiCredentialsInherited: false,
      };
      const outputPath = process.env.CODARA_PI_FRONTIER_ADMISSION_SMOKE_OUTPUT;
      if (outputPath) {
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
        fs.writeFileSync(path.resolve(outputPath), JSON.stringify(summary, null, 2));
      }
      console.log(JSON.stringify(summary));
      return;
    }
    assert.equal(evidence.stage, "final-safe");
    assert.equal(evidence.safetyAssessment.verdict, "SAFE");
    assert.equal(evidence.safetyAssessment.regressions, 0);
    assert.ok(evidence.safetyAssessment.probes >= evidence.finalFingerprint.changedHunks * 2);
    assert.equal(evidence.finalSafeFingerprint.sha256, evidence.finalFingerprint.sha256);
    const safetyObligationIds = new Set(evidence.safetyEvidence
      .filter((probe) => ["intended", "non-regression", "interaction"].includes(probe.kind))
      .flatMap((probe) => probe.obligationIds));
    assert.deepEqual([...admittedObligationIds].sort(), [...exactObligationIds].sort());
    assert.deepEqual([...safetyObligationIds].sort(), [...exactObligationIds].sort());
    const counterfactualEvidence = evidence.safetyEvidence.filter((probe) => probe.kind === "counterfactual");
    const cutFamilies = new Map(evidence.admissionCuts.map((cut) => [cut.id, cut.family.trim().toLowerCase()]));
    const counterfactualFamilies = new Set(counterfactualEvidence.map((probe) => cutFamilies.get(probe.cutId)));
    assert.ok(counterfactualFamilies.size >= manifest.frontierPolicy.minCounterfactualFamilies);
    assert.ok(counterfactualEvidence.every((probe) => probe.observed.includes("ORIGINAL_PASS_MUTANT_FAIL")));
    execFileSync("npm", ["test"], { cwd: workspace, stdio: "pipe" });
    const summary = {
      ok: true,
      provider,
      model,
      thinking,
      durationMs: Date.now() - startedAt,
      usage: result.usage,
      toolTrace,
      admissionCuts: evidence.admissionCuts.length,
      contractObligations: manifest.contractObligations.length,
      coveredObligations: safetyObligationIds.size,
      changedHunks: evidence.finalFingerprint.changedHunks,
      safetyProbes: evidence.safetyAssessment.probes,
      counterfactualProbes: counterfactualEvidence.length,
      counterfactualFamilies: counterfactualFamilies.size,
      safetyVerdict: evidence.safetyAssessment.verdict,
      finalDiffSha256: evidence.finalFingerprint.sha256,
      apiCredentialsInherited: false,
    };
    const outputPath = process.env.CODARA_PI_FRONTIER_SMOKE_OUTPUT;
    if (outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), JSON.stringify(summary, null, 2));
    }
    console.log(JSON.stringify(summary));
  } finally {
    if (client) await client.stop().catch(() => undefined);
    if (process.env.CODARA_KEEP_LIVE_FIXTURE !== "1") fs.rmSync(temporary, { recursive: true, force: true });
    else console.log(`[frontier-live] kept fixture ${temporary}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});

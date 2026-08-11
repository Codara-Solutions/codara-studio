import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app } from "electron";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function write(root: string, relativePath: string, contents: string): string {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

function git(workspace: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}

function waitForInitialFeature(
  sourcePath: string,
  originalSource: string,
  readmePath: string,
  revision: string,
  timeoutMs: number,
): Promise<{ at: string; sourceSha256: string; sourceDiffSha256: string }> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      let source: string;
      try { source = fs.readFileSync(sourcePath, "utf8"); }
      catch { return; }
      if (source === originalSource || !/\bisAtLimit\s*\(/.test(source)) {
        if (Date.now() - startedAt > timeoutMs) {
          clearInterval(interval);
          reject(new Error("The first Frontier attempt did not implement isAtLimit before the injection timeout"));
        }
        return;
      }
      clearInterval(interval);
      const sourceDiff = git(path.dirname(path.dirname(sourcePath)), "diff", "--", "src/quota-ledger.cjs");
      fs.appendFileSync(readmePath, revision);
      const observed = {
        at: new Date().toISOString(),
        sourceSha256: sha256(source),
        sourceDiffSha256: sha256(sourceDiff),
      };
      console.log(`[contract-revision-live] injected authoritative revision after retained feature ${observed.sourceSha256.slice(0, 12)}`);
      resolve(observed);
    }, 25);
    interval.unref();
  });
}

async function run(): Promise<void> {
  assert.equal(process.env.CODARA_ALLOW_LIVE_PI_SMOKE, "1", "live smoke opt-in is required");
  const productRoot = process.env.CODARA_PI_SMOKE_PRODUCT_ROOT;
  assert.ok(productRoot && path.isAbsolute(productRoot), "wrapper must provide the product root");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codara-frontier-contract-revision-live-"));
  const workspace = path.join(temporary, "workspace");
  const codaraHome = path.join(temporary, "codara-home");
  const configDir = path.join(codaraHome, "pi-agent");
  const bridgePath = path.join(temporary, "isolated-bridge.cjs");
  const completionLog = path.join(temporary, "completion.jsonl");
  const nodeExecutable = process.env.CODARA_PI_SMOKE_NODE;
  assert.ok(nodeExecutable && path.isAbsolute(nodeExecutable), "wrapper must provide an absolute Node executable");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  app.setPath("userData", path.join(temporary, "electron-user-data"));

  const sourceAuthDir = process.env.CODARA_PI_SMOKE_CONFIG || path.join(os.homedir(), ".Codara", "pi-agent");
  const sourceAuth = path.join(sourceAuthDir, "auth.json");
  assert.ok(fs.statSync(sourceAuth).isFile(), `Pi OAuth store is missing: ${sourceAuth}`);
  fs.copyFileSync(sourceAuth, path.join(configDir, "auth.json"));
  if (process.platform !== "win32") fs.chmodSync(path.join(configDir, "auth.json"), 0o600);

  fs.writeFileSync(bridgePath, `"use strict";
const fs = require("node:fs");
module.exports.listTools = () => [{
  name: "codara_complete",
  description: "Mark this isolated Codara smoke run complete only after the Frontier machine reports final-safe.",
  inputSchema: { type: "object", properties: { runId: { type: "string" }, summary: { type: "string" } }, additionalProperties: false }
}];
module.exports.callToolByName = async (name, args) => {
  if (name !== "codara_complete") return { isError: true, content: [{ type: "text", text: "unsupported isolated tool" }] };
  fs.appendFileSync(${JSON.stringify(completionLog)}, JSON.stringify({ name, args, at: new Date().toISOString() }) + "\\n");
  return { content: [{ type: "text", text: "isolated codara_complete accepted" }], details: { completed: true } };
};
`, { mode: 0o600 });

  const initialReadme = `# Quota ledger contract

\`QuotaLedger\` is a synchronous in-memory quota state machine exported from \`src/quota-ledger.cjs\`.

- The constructor accepts a safe integer quota from 1 through 10 and starts with zero usage.
- \`reserve(units)\` accepts a positive safe integer. It throws \`RangeError\` before mutation when capacity would be exceeded; otherwise it returns an exact detached snapshot.
- \`release(units)\` accepts a positive safe integer. It throws \`RangeError\` before mutation when usage would become negative; otherwise it returns an exact detached snapshot.
- \`isAtLimit()\` is a pure query returning true exactly when used equals quota. It remains correct after every reserve and release transition.
- \`snapshot()\` returns a new object with exactly the enumerable keys \`quota\` and \`used\`.
- Invalid and failed calls are atomic. Add focused public regression coverage for the new query without weakening existing coverage.
`;
  const contractRevision = `
## Authoritative contract revision

- \`remaining()\` is now also required. It is a pure query returning exactly \`quota - used\`, remains correct after every successful or failed transition, and never changes the shape of \`snapshot()\`.
- Public regression coverage must exercise both \`isAtLimit()\` and \`remaining()\` at zero, partial, and full utilization. This revision is authoritative and must remain in the working tree.
`;
  const source = `"use strict";

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(label);
  return value;
}

class QuotaLedger {
  constructor(quota) {
    positiveSafeInteger(quota, "quota");
    if (quota > 10) throw new RangeError("quota");
    this.quota = quota;
    this.used = 0;
  }

  reserve(units) {
    positiveSafeInteger(units, "units");
    if (units > this.quota - this.used) throw new RangeError("capacity");
    this.used += units;
    return this.snapshot();
  }

  release(units) {
    positiveSafeInteger(units, "units");
    if (units > this.used) throw new RangeError("usage");
    this.used -= units;
    return this.snapshot();
  }

  snapshot() { return { quota: this.quota, used: this.used }; }
}

module.exports = { QuotaLedger };
`;
  const readmePath = write(workspace, "README.md", initialReadme);
  const sourcePath = write(workspace, "src/quota-ledger.cjs", source);
  const testPath = write(workspace, "test/quota-ledger.test.cjs", `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { QuotaLedger } = require("../src/quota-ledger.cjs");

test("valid transitions return detached snapshots", () => {
  const ledger = new QuotaLedger(4);
  const snapshot = ledger.reserve(3);
  snapshot.used = 99;
  assert.deepEqual(ledger.snapshot(), { quota: 4, used: 3 });
  assert.deepEqual(ledger.release(2), { quota: 4, used: 1 });
});

test("failed transitions are atomic", () => {
  const ledger = new QuotaLedger(2);
  ledger.reserve(1);
  assert.throws(() => ledger.reserve(2), RangeError);
  assert.deepEqual(ledger.snapshot(), { quota: 2, used: 1 });
  assert.throws(() => ledger.release(2), RangeError);
  assert.deepEqual(ledger.snapshot(), { quota: 2, used: 1 });
});
`);
  write(workspace, "package.json", JSON.stringify({
    name: "codara-frontier-contract-revision-fixture",
    private: true,
    scripts: { test: "node --test test/*.test.cjs" },
  }, null, 2));
  git(workspace, "init", "--quiet");
  git(workspace, "add", ".");
  git(workspace, "-c", "user.name=Codara Live", "-c", "user.email=live@codara.invalid", "commit", "--quiet", "-m", "fixture");
  execFileSync("npm", ["test"], { cwd: workspace, stdio: "pipe" });

  const runId = `frontier-contract-revision-${randomUUID()}`;
  process.env.CODARA_HOME_DIR = codaraHome;
  process.env.CODARA_PI_SMOKE_BRIDGE_PATH = bridgePath;
  const { codaraPiPaths, createCodaraPiLaunchPlan, inspectCodaraPiAuth } = await import("../src/main/orchestration/pi-runtime-electron");
  const auth = await inspectCodaraPiAuth("openai-codex");
  assert.equal(auth.type, "oauth");
  if (process.env.CODARA_PI_FRONTIER_CONTRACT_REVISION_FIXTURE_ONLY === "1") {
    assert.equal(codaraPiPaths().bridgePath, bridgePath);
    const plan = await createCodaraPiLaunchPlan({
      provider: "openai-codex",
      runId,
      sessionId: `fixture-${randomUUID()}`,
      cwd: workspace,
      mode: "execute",
      executionPolicy: "frontier",
      model: "gpt-5.6-sol",
      thinking: "high",
    });
    assert.equal(plan.env.CODARA_PI_BRIDGE_PATH, bridgePath);
    assert.ok(!Object.keys(plan.env).some((key) => key.toUpperCase().endsWith("_API_KEY")));
    console.log(JSON.stringify({ fixtureOnly: true, workspace, bridgePath, oauth: auth.type }));
    fs.rmSync(temporary, { recursive: true, force: true });
    return;
  }
  const { piBackend } = await import("../src/main/orchestration/pi-backend");

  const startedAt = Date.now();
  const stream: Array<Record<string, unknown>> = [];
  let promptAcceptances = 0;
  const injection = waitForInitialFeature(sourcePath, source, readmePath, contractRevision, 45 * 60 * 1000);
  const decisionPromise = piBackend.requestManagerDecision({
    run: {
      id: runId,
      workspaceId: "contract-revision-live",
      title: "Frontier contract revision live smoke",
      status: "running",
      artifactDir: path.join(temporary, "artifacts"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      plans: [], steps: [], workerTasks: [], workerAttempts: [], sparkCalls: [], humanMessages: [],
      conversationEpoch: 0,
    },
    cwd: workspace,
    mode: "chat",
    settings: {
      defaultShellId: null,
      terminalScrollbackLineLimit: 10_000,
      openRouterApiKey: "",
      openRouterModel: "",
      commitMessageModel: "auto",
      agentMcpSyncEnabled: false,
      agentSkillSyncEnabled: false,
      agentDisabledMcpIds: [],
      agentDisabledSkillIds: [],
      agentMcpCoraManagerIds: [],
      agentMcpPiWorkerIds: [],
      playwrightMcpAutoInstall: false,
      autopilotSandbox: false,
    },
    prompt: "Implement the documented QuotaLedger.isAtLimit() behavior and focused public regression coverage. Work directly in this isolated fixture; do not launch Codara workers. Follow every Cora Frontier machine-gate instruction exactly. If an authoritative contract revision is detected, stop the stale attempt exactly as instructed so Codara can rebuild admission, then finish the original outcome against the revised contract. Call codara_complete exactly once only after frontier_machine=final-safe.",
    inputMessageIds: ["contract-revision-live-user"],
    conversationEpoch: 0,
    onPromptAccepted: () => { promptAcceptances += 1; },
    chat: {
      backend: "pi",
      model: "gpt-5.6-sol",
      mode: "execute",
      effort: "high",
      executionPolicy: "frontier",
      fastMode: false,
      oneMillionContext: false,
    },
  }, (event) => {
    const record = { ...event, atMs: Date.now() - startedAt };
    stream.push(record);
    if (event.kind === "system_note") console.log(`[contract-revision-live] ${event.message}`);
    if (event.kind === "tool_use") console.log(`[contract-revision-live] start ${event.toolName} @ ${Math.round((Date.now() - startedAt) / 1000)}s`);
    if (event.kind === "tool_result" && event.output.includes("CORA_FRONTIER_CONTRACT_DRIFT")) {
      console.log(`[contract-revision-live] machine observed contract drift @ ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
  });

  try {
    const injected = await injection;
    const result = await decisionPromise;
    assert.equal(result.turnFailed, undefined, result.notice);
    assert.equal(result.turnAborted, undefined);
    assert.equal(result.decision.status, "complete");
    assert.equal(promptAcceptances, 1, "a backend-owned contract restart must not re-acknowledge the user prompt");
    const completionStarts = stream.filter((event) => event.kind === "tool_use" && event.toolName === "codara_complete");
    assert.equal(completionStarts.length, 1, "Frontier must attempt codara_complete exactly once");
    const completionResult = stream.find((event) => event.kind === "tool_result" &&
      event.toolUseId === completionStarts[0].toolUseId);
    assert.ok(completionResult && completionResult.isError !== true, "codara_complete did not succeed");
    const revisionNotice = stream.find((event) => event.kind === "system_note" &&
      typeof event.message === "string" && event.message.includes("authoritative contract revision"));
    assert.ok(revisionNotice, "the Studio stream did not expose its contract-revision restart");
    assert.ok(stream.some((event) => event.kind === "tool_result" && typeof event.output === "string" &&
      event.output.includes("CORA_FRONTIER_CONTRACT_DRIFT")), "the stale Pi turn never surfaced the machine drift marker");

    const manifestDir = path.join(configDir, "frontier", "manifests");
    const manifestPath = path.join(manifestDir, `${runId}.json`);
    const evidencePath = path.join(manifestDir, `${runId}.evidence.json`);
    const archiveDir = path.join(manifestDir, `${runId}.revision-1`);
    assert.ok(fs.statSync(archiveDir).isDirectory(), "revision-1 proof archive is missing");
    const archivedFiles = fs.readdirSync(archiveDir).sort();
    assert.ok(archivedFiles.includes(`${runId}.json`));
    assert.ok(archivedFiles.includes(`${runId}.evidence.json`));
    const archivedManifest = JSON.parse(fs.readFileSync(path.join(archiveDir, `${runId}.json`), "utf8"));
    const archivedEvidence = JSON.parse(fs.readFileSync(path.join(archiveDir, `${runId}.evidence.json`), "utf8"));
    const currentManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const currentEvidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    assert.equal(archivedEvidence.stage, "contract-drift");
    assert.ok(archivedEvidence.contractDrift);
    assert.notEqual(archivedManifest.contractTreeSha256, currentManifest.contractTreeSha256);
    assert.equal(currentEvidence.stage, "final-safe");
    assert.equal(currentEvidence.baselineVerified, true);
    assert.equal(currentEvidence.admissionVerified, true);
    assert.equal(currentEvidence.safetyAssessment?.verdict, "SAFE");
    assert.equal(currentEvidence.finalSafeFingerprint?.sha256, currentEvidence.finalFingerprint?.sha256);

    const finalSource = fs.readFileSync(sourcePath, "utf8");
    const finalTest = fs.readFileSync(testPath, "utf8");
    assert.match(finalSource, /\bisAtLimit\s*\(/);
    assert.match(finalSource, /\bremaining\s*\(/);
    assert.match(finalTest, /isAtLimit/);
    assert.match(finalTest, /remaining/);
    assert.match(fs.readFileSync(readmePath, "utf8"), /Authoritative contract revision/);
    execFileSync("npm", ["test"], { cwd: workspace, stdio: "pipe" });
    const externalProbe = path.join(temporary, "external-probe.cjs");
    fs.writeFileSync(externalProbe, `"use strict";
const assert = require("node:assert/strict");
const { QuotaLedger } = require(${JSON.stringify(sourcePath)});
const ledger = new QuotaLedger(3);
assert.equal(ledger.remaining(), 3); assert.equal(ledger.isAtLimit(), false);
ledger.reserve(2); assert.equal(ledger.remaining(), 1); assert.equal(ledger.isAtLimit(), false);
assert.throws(() => ledger.reserve(2), RangeError); assert.equal(ledger.remaining(), 1);
ledger.reserve(1); assert.equal(ledger.remaining(), 0); assert.equal(ledger.isAtLimit(), true);
assert.deepEqual(Object.keys(ledger.snapshot()).sort(), ["quota", "used"]);
ledger.release(3); assert.equal(ledger.remaining(), 3); assert.equal(ledger.isAtLimit(), false);
console.log("EXTERNAL_CONTRACT_REVISION_PASS");
`);
    const externalOutput = execFileSync(nodeExecutable, [externalProbe], { cwd: workspace, encoding: "utf8" }).trim();
    assert.equal(externalOutput, "EXTERNAL_CONTRACT_REVISION_PASS");
    const completions = fs.readFileSync(completionLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(completions.length, 1);

    const summary = {
      ok: true,
      benchmark: "studio-backend-contract-revision-v9.1",
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      thinking: "high",
      durationMs: Date.now() - startedAt,
      promptAcceptances,
      restartCount: 1,
      injected,
      contractSha256: {
        before: archivedManifest.contractTreeSha256,
        after: currentManifest.contractTreeSha256,
      },
      archivedProofFiles: archivedFiles,
      archivedStage: archivedEvidence.stage,
      finalStage: currentEvidence.stage,
      finalDiffSha256: currentEvidence.finalFingerprint.sha256,
      admissionCuts: currentEvidence.admissionCuts.length,
      safetyProbes: currentEvidence.safetyAssessment.probes,
      retainedInitialFeature: /\bisAtLimit\s*\(/.test(finalSource),
      implementedRevisedFeature: /\bremaining\s*\(/.test(finalSource),
      externalProbe: externalOutput,
      completionCalls: completions.length,
      usage: {
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        cacheReadTokens: result.cacheReadTokens ?? 0,
      },
      apiCredentialsInherited: false,
      streamEvents: stream.length,
      fixture: process.env.CODARA_KEEP_LIVE_FIXTURE === "1" ? temporary : null,
    };
    const outputPath = process.env.CODARA_PI_FRONTIER_CONTRACT_REVISION_SMOKE_OUTPUT;
    if (outputPath) {
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), JSON.stringify(summary, null, 2));
    }
    console.log(JSON.stringify(summary));
  } finally {
    await piBackend.disposeChat(runId).catch(() => undefined);
    if (process.env.CODARA_KEEP_LIVE_FIXTURE !== "1") fs.rmSync(temporary, { recursive: true, force: true });
    else console.log(`[contract-revision-live] kept fixture ${temporary}`);
  }
}

void app.whenReady().then(run).then(
  () => app.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    app.exit(1);
  },
);

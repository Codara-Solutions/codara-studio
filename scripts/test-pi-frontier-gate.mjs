#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import {
  admissionArtifactSha256,
  artifactFromPiFrontierAdmission,
  createPiFrontierAdmissionEntry,
  piFrontierAdmissionScope,
} from "../src/main/orchestration/pi-admission-cache.ts";
import {
  discoverPiFrontierVerification,
  verificationManifestSha256,
} from "../src/main/orchestration/pi-verification.ts";
import {
  contractWorkspaceTreeSha256,
  frontierDiffFingerprint,
  loadFrontierVerificationManifest,
  trackedWorkspaceTreeSha256,
} from "../resources/pi-cora/frontier-core.ts";
import { parseContractBlocker } from "../resources/pi-cora/frontier-contract-blocker.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-frontier-gate-"));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-frontier-state-"));
const riskRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-frontier-risk-gate-"));
const originalCwd = process.cwd();
const write = (relativePath, value) => {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
};
const fixtureSource = [
  "export const answer = 1;",
  "function lifecycleRoot() { return answer; }",
  "function serializationRoot() { return answer; }",
  "function verificationRoot() { return answer; }",
  "",
].join("\n");
const managedRequest = (task) => {
  const requestPath = /^REQUEST_PATH=(.+)$/m.exec(task)?.[1];
  const requestSha256 = /^REQUEST_SHA256=([a-f0-9]{64})$/m.exec(task)?.[1];
  assert.ok(requestPath && requestSha256);
  const bytes = fs.readFileSync(requestPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), requestSha256);
  return JSON.parse(bytes.toString("utf8"));
};
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

try {
  git("init", "--quiet");
  write("package.json", JSON.stringify({ name: "frontier-gate-fixture", scripts: { test: "node --test" } }));
  write("README.md", "# Contract\n\nThe exported answer must remain stable.\n");
  write("src/value.js", fixtureSource);
  fs.writeFileSync(path.join(root, "asset.bin"), Buffer.from([0, 1, 2, 0]));
  git("add", "package.json", "README.md", "src/value.js", "asset.bin");
  git("-c", "user.name=Codara Test", "-c", "user.email=test@codara.invalid", "commit", "--quiet", "-m", "fixture");

  const manifest = await discoverPiFrontierVerification(root);
  assert.equal(manifest.cacheEligible, true);
  assert.equal(trackedWorkspaceTreeSha256(root), manifest.trackedTreeSha256);
  assert.equal(contractWorkspaceTreeSha256(root, manifest.contractPaths), manifest.contractTreeSha256);
  const blockerSemantic = {
    class: "underdetermined",
    obligationIds: [manifest.contractObligations[0].id],
    contractCitations: [manifest.contractObligations[0].sources[0].path],
    claim: "Two valid command histories erase the only witness needed to distinguish their required restoration outcomes.",
    lostWitness: "The exact persisted shape commits to but does not retain the normalized input field needed for semantic revalidation.",
    indistinguishableWorlds: [
      "World A exports a valid terminal state after normalized reason digest A and then removes that reason from every observable field.",
      "World B exports the same terminal state after normalized reason digest B and likewise removes that reason from every observable field.",
    ],
    incompatibleOutcomes: [
      "Restoration must accept the byte sequence because it is the canonical export of the valid World A history.",
      "Restoration must reject the same observable byte sequence when it is interpreted as a substituted World B commitment.",
    ],
    witnessCommand: "node -e \"console.log('independent two-world observability witness')\"",
    minimalResolutions: [
      "Persist the normalized reason witness in the exact command record so restoration can recompute the required digest.",
      "Narrow restoration validation to structural commitments and defer full command identity validation until a retry supplies the witness.",
    ],
  };
  const { witnessCommand: _witnessCommand, ...blockerIdentity } = blockerSemantic;
  const blockerId = `blocker-${createHash("sha256").update(canonicalJson(blockerIdentity)).digest("hex").slice(0, 20)}`;
  const blocker = {
    ...blockerSemantic,
    id: blockerId,
  };
  const witnessProgram = `const fs=require('node:fs'),crypto=require('node:crypto'),h=v=>crypto.createHash('sha256').update(v).digest('hex');const contract=h(fs.readFileSync('README.md')),observableA=h(JSON.stringify({persisted:'same'})),observableB=h(JSON.stringify({persisted:'same'})),outcomeA=h('accept-world-a'),outcomeB=h('reject-world-b');if(observableA!==observableB||outcomeA===outcomeB)process.exit(7);console.log(['CONTRACT_BLOCKER_WITNESS=${blockerId}','SAME_OBSERVABLE=true','INCOMPATIBLE_OUTCOMES=true','CITED_CONTRACT_SHA256='+contract+' README.md','OBSERVABLE_A_SHA256='+observableA,'OBSERVABLE_B_SHA256='+observableB,'REQUIRED_OUTCOME_A_SHA256='+outcomeA,'REQUIRED_OUTCOME_B_SHA256='+outcomeB].join('\\n'))`;
  blocker.witnessCommand = `node -e ${JSON.stringify(witnessProgram)}`;
  const blockerOutput = execFileSync(process.execPath, ["-e", witnessProgram], { cwd: root, encoding: "utf8" }).trim();
  const parsedBlocker = parseContractBlocker(
    `CONTRACT_BLOCKER_JSON=${JSON.stringify(blocker)}`,
    manifest,
    [{ command: blocker.witnessCommand, output: blockerOutput }],
  );
  assert.deepEqual(parsedBlocker, { present: true, blocker, errors: [] });
  const promptBoundManifest = await discoverPiFrontierVerification(root,
    "The live request resolves the documented ambiguity by requiring world A's exact outcome.");
  assert.match(parseContractBlocker(
    `CONTRACT_BLOCKER_JSON=${JSON.stringify(blocker)}`,
    promptBoundManifest,
    [{ command: blocker.witnessCommand, output: blockerOutput }],
  ).errors.join("\n"), /must cite and reconcile the signed live user request/);
  assert.match(parseContractBlocker(
    `CONTRACT_BLOCKER_JSON=${JSON.stringify(blocker)}`,
    manifest,
    [],
  ).errors.join("\n"), /exactly one successful admission-auditor Bash execution/);
  assert.match(parseContractBlocker(
    `CONTRACT_BLOCKER_JSON=${JSON.stringify({ ...blocker, id: "blocker-00000000000000000000" })}`,
    manifest,
    [{ command: blocker.witnessCommand, output: blockerOutput }],
  ).errors.join("\n"), /blocker id must equal/);
  assert.match(parseContractBlocker(
    `CONTRACT_BLOCKER_JSON=${JSON.stringify(blocker)}`,
    manifest,
    [{ command: blocker.witnessCommand, output: blockerOutput.replace(/^OBSERVABLE_B_SHA256=[a-f0-9]{64}$/m, `OBSERVABLE_B_SHA256=${"d".repeat(64)}`) }],
  ).errors.join("\n"), /two equal observable SHA-256 values/);
  assert.match(parseContractBlocker(
    `CONTRACT_BLOCKER_JSON=${JSON.stringify(blocker)}`,
    manifest,
    [{ command: blocker.witnessCommand, output: blockerOutput.replace(/^REQUIRED_OUTCOME_B_SHA256=([a-f0-9]{64})$/m, (_line, digest) => `REQUIRED_OUTCOME_B_SHA256=${/^REQUIRED_OUTCOME_A_SHA256=([a-f0-9]{64})$/m.exec(blockerOutput)[1]}`) }],
  ).errors.join("\n"), /two distinct required-outcome SHA-256 values/);
  const observableDigest = /^OBSERVABLE_A_SHA256=([a-f0-9]{64})$/m.exec(blockerOutput)[1];
  const embeddedBlocker = { ...blocker, witnessCommand: `${blocker.witnessCommand} # ${observableDigest}` };
  assert.match(parseContractBlocker(
    `CONTRACT_BLOCKER_JSON=${JSON.stringify(embeddedBlocker)}`,
    manifest,
    [{ command: embeddedBlocker.witnessCommand, output: blockerOutput }],
  ).errors.join("\n"), /derive world and outcome digests at runtime/);
  const manifestPath = path.join(stateRoot, "frontier-manifest.json");
  const manifestText = JSON.stringify(manifest);
  const manifestSha256 = verificationManifestSha256(manifest);
  assert.equal(createHash("sha256").update(manifestText).digest("hex"), manifestSha256);
  fs.writeFileSync(manifestPath, manifestText, { mode: 0o600 });
  assert.equal(loadFrontierVerificationManifest(manifestPath, manifestSha256).workspaceRoot, root);

  process.env.CODARA_PI_EXECUTION_POLICY = "frontier";
  process.env.SPARK_MCP_MODE = "execute";
  process.env.SPARK_RUN_ID = "run-frontier-test";
  process.env.CODARA_PI_FRONTIER_MANIFEST = manifestPath;
  process.env.CODARA_PI_FRONTIER_MANIFEST_SHA256 = manifestSha256;

  const extensionPath = path.resolve(originalCwd, "resources/pi-cora/frontier-gate.ts");
  process.chdir(root);
  const { extensions, errors } = await loadExtensions([extensionPath], root);
  assert.deepEqual(errors, []);
  assert.equal(extensions.length, 1);
  const extension = extensions[0];
  const prompt = await extension.handlers.get("before_agent_start")[0]({ systemPrompt: "base" });
  assert.match(prompt.systemPrompt, /content addressed/);
  assert.match(prompt.systemPrompt, new RegExp(manifestSha256));
  assert.match(prompt.systemPrompt, /cora_frontier_verify/);
  assert.match(prompt.systemPrompt, /cora_frontier_admit/);
  const admissionPrefix = "- Exact admission subagent input: ";
  const admissionInput = JSON.parse(prompt.systemPrompt.split("\n").find((line) => line.startsWith(admissionPrefix)).slice(admissionPrefix.length));
  const admissionRequest = managedRequest(admissionInput.chain[1].task);
  assert.match(admissionRequest.tracerTask, /below 48,000 UTF-8 bytes/);
  assert.match(admissionRequest.auditorTask, /lowercase ASCII only/);
  assert.deepEqual(admissionRequest.contractObligations, manifest.contractObligations);
  assert.match(admissionRequest.auditorTask, /No atom may be omitted/);
  assert.match(admissionRequest.auditorTask, /Numbered frontier\/slice\/cut\/contract\/family aliases/);
  assert.match(admissionRequest.auditorTask, /tracked non-test source file/);
  assert.match(admissionRequest.auditorTask, /Test\/spec\/fixture files are rejected/);
  assert.match(admissionRequest.auditorTask, /never cite an unrelated region merely to manufacture breadth/);
  assert.match(admissionRequest.auditorTask, /normalized by removing numeric and hash labels/);
  assert.match(admissionRequest.auditorTask, /surface conformance 1.*surface conformance 2.*count as one family/);

  const toolCall = extension.handlers.get("tool_call")[0];
  const toolResult = extension.handlers.get("tool_result")[0];
  const call = (toolCallId, toolName, input) => toolCall({ type: "tool_call", toolCallId, toolName, input });
  assert.equal((await call("pre-write", "write", {})).block, true);
  assert.equal((await call("pre-worker", "codara_spawn_workers", {})).block, true);
  assert.equal((await call("pre-bash", "bash", { command: "node -e 'mutate'" })).block, true);
  assert.equal(await call("pre-read", "bash", { command: "rg answer src" }), undefined);
  assert.equal((await call("wrong-review", "subagent", { agent: "cora-frontier-contract-auditor", task: "approximately review" })).block, true);

  const verify = extension.tools.get("cora_frontier_verify").definition;
  const premature = await verify.execute("premature", { phase: "final" });
  assert.equal(premature.isError, true);
  assert.match(premature.content[0].text, /baseline verification has not passed/);

  const baseline = await verify.execute("baseline", { phase: "baseline" });
  assert.equal(baseline.isError, false);
  assert.equal(baseline.details.passed, true);
  assert.match(baseline.content[0].text, /frontier=baseline-verified/);
  const postBaselineWrite = await call("still-locked", "write", {});
  assert.equal(postBaselineWrite.block, true);
  assert.match(postBaselineWrite.reason, /managed contract audit/);

  const admissionRequestPath = /^REQUEST_PATH=(.+)$/m.exec(admissionInput.chain[0].task)[1];
  const admissionRequestBytes = fs.readFileSync(admissionRequestPath);
  fs.appendFileSync(admissionRequestPath, " ");
  const tamperedAdmission = await call("admission-request-tampered", "subagent", admissionInput);
  assert.equal(tamperedAdmission.block, true);
  assert.match(tamperedAdmission.reason, /content-addressed Frontier admission request/);
  fs.writeFileSync(admissionRequestPath, admissionRequestBytes);
  assert.equal(await call("admission-review-error", "subagent", admissionInput), undefined);
  const failedAdmissionExecution = await toolResult({
    type: "tool_result",
    toolCallId: "admission-review-error",
    toolName: "subagent",
    input: admissionInput,
    content: [{ type: "text", text: "subscription worker unavailable" }],
    details: {
      mode: "chain",
      agentScope: "user",
      results: [{ agent: "cora-frontier-contract-tracer", exitCode: 1, stopReason: "error" }],
    },
    isError: true,
  });
  assert.match(failedAdmissionExecution.content.at(-1).text, /frontier_machine=admission-review-refused/);
  const executionFailureEvidence = JSON.parse(fs.readFileSync(manifestPath.replace(/\.json$/i, ".evidence.json"), "utf8"));
  assert.equal(executionFailureEvidence.admissionReviewHistory.at(-1).kind, "execution");
  assert.deepEqual(executionFailureEvidence.admissionReviewHistory.at(-1).errors, [
    "managed admission subagent returned an error",
    "managed admission subagent result topology was incomplete",
  ]);
  assert.equal(await call("admission-review", "subagent", admissionInput), undefined);
  const duplicateAdmission = await call("admission-review-duplicate", "subagent", admissionInput);
  assert.equal(duplicateAdmission.block, true);
  const admissionCuts = [
    {
      id: "read-validation-boundary",
      family: "validation boundary",
      operations: ["read"],
      obligationIds: manifest.contractObligations.map((obligation) => obligation.id),
      contractCitations: ["README.md:3"],
      implementationRoots: ["src/value.js:1"],
      failureMode: "Malformed values cross the documented validation boundary.",
      positiveProbe: "Load a valid exported answer and assert the documented stable value.",
      negativeProbe: "Load a malformed exported answer and assert deterministic rejection.",
    },
    {
      id: "write-state-transition",
      family: "state lifecycle",
      operations: ["write"],
      obligationIds: manifest.contractObligations.map((obligation) => obligation.id),
      contractCitations: ["README.md#contract"],
      implementationRoots: ["src/value.js:1"],
      failureMode: "A failed transition partially publishes an unstable answer.",
      positiveProbe: "Apply one valid state transition and assert the new answer is visible.",
      negativeProbe: "Reject one invalid transition and assert the old answer remains visible.",
    },
    {
      id: "resume-serialization-shape",
      family: "serialization compatibility",
      operations: ["resume"],
      obligationIds: manifest.contractObligations.map((obligation) => obligation.id),
      contractCitations: ["README.md stable export"],
      implementationRoots: ["src/value.js:1", "src/value.js:3"],
      failureMode: "A resumed state silently changes the documented public answer shape.",
      positiveProbe: "Resume a valid stored state and assert exact public answer serialization.",
      negativeProbe: "Resume an older malformed state and assert a bounded compatibility error.",
    },
    {
      id: "inspect-contract-boundary",
      family: "contract observability",
      operations: ["inspect"],
      obligationIds: manifest.contractObligations.map((obligation) => obligation.id),
      contractCitations: ["README.md:3"],
      implementationRoots: ["src/value.js:1", "src/value.js:4"],
      failureMode: "Inspection exposes a value outside the documented stable contract.",
      positiveProbe: "Inspect the stable answer and assert the exact documented value.",
      negativeProbe: "Inspect an unsupported export and assert deterministic absence.",
    },
    {
      id: "verify-regression-boundary",
      family: "regression containment",
      operations: ["verify"],
      obligationIds: manifest.contractObligations.map((obligation) => obligation.id),
      contractCitations: ["README.md#contract"],
      implementationRoots: ["src/value.js:1", "src/value.js:2"],
      failureMode: "A focused change invalidates an unrelated documented caller path.",
      positiveProbe: "Run the focused answer verification and assert the changed behavior.",
      negativeProbe: "Run the complete public suite and assert unrelated behavior remains stable.",
    },
  ];
  const admissionReport = [
    "Independent audit complete.",
    "TOTAL_CUTS=5",
    "TOTAL_FAMILIES=5",
    "TOTAL_OPERATIONS=5",
    "TOTAL_DEEP_FAMILIES=0",
    "TOTAL_CRITICAL_FAMILIES=0",
    `ADMISSION_CUTS_JSON=${JSON.stringify(admissionCuts)}`,
  ].join("\n");
  const repairableAdmissionReport = [
    "Independent audit complete with a semantically valid portfolio and a malformed redundant envelope.",
    "TOTAL_OPERATIONS=99",
    "TOTAL_CUTS=5",
    "TOTAL_FAMILIES=5",
    "TOTAL_DEEP_FAMILIES=0",
    "TOTAL_CRITICAL_FAMILIES=0",
    `ADMISSION_CUTS_JSON=${JSON.stringify(admissionCuts)}`,
  ].join("\n");
  const exactObligationId = manifest.contractObligations[0].id;
  const mistypedObligationId = `${exactObligationId.slice(0, -1)}${exactObligationId.endsWith("0") ? "1" : "0"}`;
  const invalidAdmissionCuts = admissionCuts.map((cut, index) => index < 3
    ? {
      ...cut,
      implementationRoots: [`src/value.js:${index === 2 ? "1-4" : "1"}#slice-${index + 1}`],
      family: `surface conformance ${index + 1}`,
      ...(index === 0 ? { obligationIds: [mistypedObligationId] } : {}),
      ...(index < 2 ? {
        ...(index === 0 ? { operations: ["op:read"] } : {}),
        failureMode: `Slice ${index + 1} is absent from the current scaffold implementation.`,
        positiveProbe: `Slice ${index + 1} exercises the listed valid atoms against exact output.`,
        negativeProbe: `Slice ${index + 1} exercises the listed rejection atoms without mutation.`,
      } : {}),
    }
    : cut);
  const invalidAdmissionReport = [
    "Unbalanced audit requiring correction.",
    "TOTAL_CUTS=5",
    "TOTAL_FAMILIES=5",
    "TOTAL_OPERATIONS=5",
    "TOTAL_DEEP_FAMILIES=0",
    "TOTAL_CRITICAL_FAMILIES=0",
    `ADMISSION_CUTS_JSON=${JSON.stringify(invalidAdmissionCuts)}`,
  ].join("\n");
  const initialAdmissionResult = await toolResult({
    type: "tool_result",
    toolCallId: "admission-review",
    toolName: "subagent",
    input: admissionInput,
    content: [{ type: "text", text: invalidAdmissionReport }],
    details: {
      mode: "chain",
      agentScope: "user",
      results: [
        { agent: "cora-frontier-contract-tracer", exitCode: 0, stopReason: "end" },
        { agent: "cora-frontier-contract-auditor", exitCode: 0, stopReason: "end" },
      ],
    },
    isError: false,
  });
  assert.match(initialAdmissionResult.content.at(-1).text, /admission-review-captured/);
  const admit = extension.tools.get("cora_frontier_admit").definition;
  const invalidAdmission = await admit.execute("admit-invalid", {});
  assert.equal(invalidAdmission.isError, true);
  assert.match(invalidAdmission.content[0].text, /requires at least 4 causal families after numeric\/hash alias normalization/);
  assert.match(invalidAdmission.content[0].text, /operation is a placeholder alias/);
  assert.match(invalidAdmission.content[0].text, /failure modes must not differ only by numeric or id labels/);
  assert.match(invalidAdmission.content[0].text, /probe bodies must not differ only by numeric or id labels/);
  assert.match(invalidAdmission.content[0].text, new RegExp(`nearest exact atlas id: ${exactObligationId}`));
  const admissionRetryPrefix = "required_admission_subagent_input=";
  const correctedAdmissionInput = JSON.parse(invalidAdmission.content[0].text.split("\n")
    .find((line) => line.startsWith(admissionRetryPrefix)).slice(admissionRetryPrefix.length));
  assert.equal(correctedAdmissionInput.agent, "cora-frontier-contract-auditor");
  const correctedAdmissionRequest = managedRequest(correctedAdmissionInput.task);
  assert.equal(correctedAdmissionRequest.kind, "frontier-admission-v12-correction");
  assert.deepEqual(correctedAdmissionRequest.feedback.admissionDiagnostics.missingObligationIds, []);
  assert.deepEqual(correctedAdmissionRequest.feedback.admissionDiagnostics.unknownObligationIds, [mistypedObligationId]);
  assert.deepEqual(correctedAdmissionRequest.feedback.admissionDiagnostics.oversizedCuts, []);
  assert.equal(correctedAdmissionRequest.feedback.admissionDiagnostics.computedTotals.TOTAL_FAMILIES, 3);
  assert.match(correctedAdmissionRequest.correctionTask, /VALIDATOR_FEEDBACK_JSON=/);
  assert.match(correctedAdmissionRequest.correctionTask, /missingObligationIds.*complete rather than truncated samples/);
  assert.match(correctedAdmissionRequest.correctionTask, new RegExp(`nearest exact atlas id: ${exactObligationId}`));
  assert.match(correctedAdmissionRequest.correctionTask, /requires at least 4 causal families after numeric\/hash alias normalization/);
  assert.match(correctedAdmissionRequest.correctionTask, /one constrained packing problem: emit exactly 5 cuts/);
  assert.match(correctedAdmissionRequest.correctionTask, /each carrying 1-8 exact obligationIds/);
  assert.match(correctedAdmissionRequest.correctionTask, /root reuse is allowed when the implementation genuinely centralizes behavior/);
  assert.match(correctedAdmissionRequest.correctionTask, /every root resolves to a causal tracked non-test source region/);
  assert.match(correctedAdmissionRequest.correctionTask, /every printed total derived from that exact array/);
  assert.match(correctedAdmissionRequest.correctionTask, /#slice.*description suffixes never create root diversity/);
  assert.match(correctedAdmissionRequest.correctionTask, /test\/spec\/fixture paths/);
  assert.match(correctedAdmissionRequest.correctionTask, /deliberately discarded/);
  assert.match(correctedAdmissionRequest.correctionTask, /execute its final exact witnessCommand again/);
  assert.match(correctedAdmissionRequest.correctionTask, /OBSERVABLE_A_SHA256/);
  assert.equal((await call("stale-admission-review", "subagent", admissionInput)).block, true);
  assert.equal(await call("admission-correction", "subagent", correctedAdmissionInput), undefined);
  const admissionResult = await toolResult({
    type: "tool_result",
    toolCallId: "admission-correction",
    toolName: "subagent",
    input: correctedAdmissionInput,
    content: [{ type: "text", text: repairableAdmissionReport }],
    details: {
      mode: "single",
      agentScope: "user",
      results: [{ agent: "cora-frontier-contract-auditor", exitCode: 0, stopReason: "end" }],
    },
    isError: false,
  });
  assert.match(admissionResult.content.at(-1).text, /admission-review-captured/);
  const admitted = await admit.execute("admit", {});
  assert.equal(admitted.isError, undefined);
  assert.equal(admitted.details.passed, true);
  assert.equal(admitted.details.cuts, 5);
  assert.equal(admitted.details.families, 5);
  assert.equal(admitted.details.operations, 5);
  assert.equal(admitted.details.envelopeCanonicalized, true);
  assert.match(admitted.content[0].text, /envelope_canonicalized=true/);
  const admittedEvidence = JSON.parse(fs.readFileSync(manifestPath.replace(/\.json$/i, ".evidence.json"), "utf8"));
  assert.equal(admittedEvidence.admissionReviewHistory.at(-1).canonicalizedEnvelope, true);
  assert.deepEqual(admittedEvidence.admissionReviewHistory.at(-1).repairedEnvelopeErrors, [
    "TOTAL_OPERATIONS must equal 5",
    "admission totals must be the five ordered lines immediately before ADMISSION_CUTS_JSON",
  ]);
  assert.match(admittedEvidence.admissionReport, /TOTAL_CUTS=5\nTOTAL_FAMILIES=5\nTOTAL_OPERATIONS=5\nTOTAL_DEEP_FAMILIES=0\nTOTAL_CRITICAL_FAMILIES=0\nADMISSION_CUTS_JSON=/);
  assert.equal(await call("post-admission-write", "write", {}), undefined);

  write("src/value.js", "export const answer = 2;\n");
  const beforeFinalComplete = await call("early-complete", "codara_complete", {});
  assert.equal(beforeFinalComplete.block, true);
  assert.match(beforeFinalComplete.reason, /final repository verification/);

  const final = await verify.execute("final", { phase: "final" });
  assert.equal(final.isError, false);
  assert.equal(final.details.passed, true);
  assert.match(final.details.fingerprint.sha256, /^[a-f0-9]{64}$/);
  assert.equal(final.details.fingerprint.changedHunks, 1);
  assert.equal(final.details.fingerprint.hunks.length, 1);
  const finalHunkId = final.details.fingerprint.hunks[0].id;
  assert.equal(final.details.independentlySafe, false);
  const safetyPrefix = "required_safety_subagent_input=";
  const safetyInput = JSON.parse(final.content[0].text.split("\n").find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  const safetyRequest = managedRequest(safetyInput.task);
  assert.match(safetyRequest.singleTask, /ADMITTED_CUTS_JSON=/);
  assert.deepEqual(safetyRequest.contractObligations, manifest.contractObligations);
  assert.match(safetyRequest.singleTask, /successful bash output.*ORIGINAL_PASS_MUTANT_FAIL/);
  assert.doesNotMatch(safetyRequest.singleTask, /positiveProbe|negativeProbe/);
  const beforeSafetyComplete = await call("pre-safety-complete", "codara_complete", {});
  assert.equal(beforeSafetyComplete.block, true);
  assert.match(beforeSafetyComplete.reason, /independent SAFE diff review/);
  assert.equal(await call("safety-review-invalid", "subagent", safetyInput), undefined);
  const invalidProbeCommand = "node -e \"process.exit(0)\"";
  const invalidProbeEvidence = [{
    id: "only-intended",
    cutId: admissionCuts[0].id,
    hunkId: finalHunkId,
    kind: "intended",
    command: invalidProbeCommand,
    obligationIds: admissionCuts[0].obligationIds,
    contractCitation: "README.md:3",
    expected: "The changed answer remains available to callers.",
    observed: "The focused command exited successfully with the changed answer.",
    verdict: "PASS",
  }];
  const invalidSafety = await toolResult({
    type: "tool_result",
    toolCallId: "safety-review-invalid",
    toolName: "subagent",
    input: safetyInput,
    content: [{ type: "text", text: `SAFETY_EVIDENCE_JSON=${JSON.stringify(invalidProbeEvidence)}\nTOTAL_CHANGED_HUNKS=1\nTOTAL_REVIEWED_HUNKS=1\nTOTAL_PROBES=1\nTOTAL_REGRESSIONS=0\nSAFETY_VERDICT=SAFE` }],
    details: {
      mode: "single", agentScope: "user", results: [{
        agent: "cora-frontier-diff-auditor", exitCode: 0, stopReason: "end",
        messages: [
          { role: "assistant", content: [{ type: "toolCall", id: "invalid-probe-call", name: "bash", arguments: { command: invalidProbeCommand } }] },
          { role: "toolResult", toolCallId: "invalid-probe-call", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
        ],
      }] },
    isError: false,
  });
  assert.match(invalidSafety.content.at(-1).text, /final-not-safe/);
  assert.match(invalidSafety.content.at(-1).text, /at least two structured probes/);
  assert.match(invalidSafety.content.at(-1).text, /paired contract atom/);
  assert.match(invalidSafety.content.at(-1).text, /counterfactual mutation kills/);
  assert.equal((await call("invalid-safety-complete", "codara_complete", {})).block, true);
  const correctiveSafetyInput = JSON.parse(invalidSafety.content.at(-1).text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  assert.notDeepEqual(correctiveSafetyInput, safetyInput);
  const correctiveSafetyRequest = managedRequest(correctiveSafetyInput.task);
  assert.equal(correctiveSafetyRequest.kind, "frontier-safety-v7-single");
  assert.match(correctiveSafetyRequest.singleTask, /VALIDATOR_FEEDBACK_JSON=/);
  assert.match(correctiveSafetyRequest.singleTask, /rejectedReport field contains the complete rejected report/);
  assert.equal(correctiveSafetyRequest.rejectedReport,
    `SAFETY_EVIDENCE_JSON=${JSON.stringify(invalidProbeEvidence)}\nTOTAL_CHANGED_HUNKS=1\nTOTAL_REVIEWED_HUNKS=1\nTOTAL_PROBES=1\nTOTAL_REGRESSIONS=0\nSAFETY_VERDICT=SAFE`);
  assert.match(correctiveSafetyRequest.singleTask, /copy the complete command string/);
  assert.equal((await call("stale-safety-review", "subagent", safetyInput)).block, true);

  // A valid UNSAFE review contributes its exact failing command to the
  // cumulative ledger. After any repair, final SAFE must replay it exactly.
  assert.equal(await call("safety-review-unsafe", "subagent", correctiveSafetyInput), undefined);
  const unsafeEvidence = admissionCuts.flatMap((cut, index) => [
    {
      id: `${cut.id}-intended`,
      cutId: cut.id,
      hunkId: finalHunkId,
      kind: "intended",
      command: `node -e \"require('./src/value.js'); process.stdout.write('intended-${index}')\"`,
      obligationIds: cut.obligationIds,
      contractCitation: cut.contractCitations[0],
      expected: "The changed answer module satisfies this admitted contract cut.",
      observed: index === 0
        ? "The executable counterexample reproduced the documented regression."
        : "The distinct focused intended-behavior command exited successfully.",
      verdict: index === 0 ? "REGRESSION" : "PASS",
    },
    {
      id: `${cut.id}-non-regression`,
      cutId: cut.id,
      hunkId: finalHunkId,
      kind: "non-regression",
      command: `node -e \"require('./src/value.js'); process.stdout.write('regression-${index}')\"`,
      obligationIds: cut.obligationIds,
      contractCitation: cut.contractCitations[0],
      expected: "The admitted cut retains its documented counterexample behavior.",
      observed: "The distinct non-regression command exited successfully.",
      verdict: "PASS",
    },
  ]);
  admissionCuts.slice(0, manifest.frontierPolicy.minCounterfactualFamilies).forEach((cut, index) => unsafeEvidence.push({
    id: `${cut.id}-counterfactual`,
    cutId: cut.id,
    hunkId: finalHunkId,
    kind: "counterfactual",
    command: `node -e \"process.stdout.write('counterfactual-${index}')\"`,
    obligationIds: cut.obligationIds,
    contractCitation: cut.contractCitations[0],
    expected: "A plausible semantic mutant is rejected by the focused oracle.",
    observed: "ORIGINAL_PASS_MUTANT_FAIL was observed in an isolated temporary copy.",
    verdict: "PASS",
  }));
  const unsafeReport = [
    "One exact admitted regression remains.",
    `SAFETY_EVIDENCE_JSON=${JSON.stringify(unsafeEvidence)}`,
    "TOTAL_CHANGED_HUNKS=1",
    "TOTAL_REVIEWED_HUNKS=1",
    `TOTAL_PROBES=${unsafeEvidence.length}`,
    "TOTAL_REGRESSIONS=1",
    "SAFETY_VERDICT=UNSAFE",
  ].join("\n");
  const unsafeSafety = await toolResult({
    type: "tool_result", toolCallId: "safety-review-unsafe", toolName: "subagent", input: correctiveSafetyInput,
    content: [{ type: "text", text: unsafeReport }],
    details: { mode: "single", agentScope: "user", results: [{
      agent: "cora-frontier-diff-auditor", exitCode: 0, stopReason: "end",
      messages: [
        { role: "assistant", content: unsafeEvidence.map((probe, index) =>
          ({ type: "toolCall", id: `unsafe-call-${index}`, name: "bash", arguments: { command: probe.command } })) },
        ...unsafeEvidence.map((probe, index) =>
          ({ role: "toolResult", toolCallId: `unsafe-call-${index}`, toolName: "bash", content: [{ type: "text", text: probe.kind === "counterfactual" ? "ORIGINAL_PASS_MUTANT_FAIL" : "ok" }], isError: false })),
      ],
    }] }, isError: false,
  });
  assert.match(unsafeSafety.content.at(-1).text, /verdict=UNSAFE/);
  const unsafeStored = JSON.parse(fs.readFileSync(manifestPath.replace(/\.json$/, ".evidence.json"), "utf8"));
  assert.equal(unsafeStored.regressionLedger.length, 1);
  assert.equal(unsafeStored.safetyReviewHistory.length, 2);

  assert.equal(await call("repair-edit", "edit", {}), undefined);
  write("src/value.js", "export const answer = 4;\n");
  const repairedFinal = await verify.execute("repaired-final", { phase: "final" });
  const repairedHunkId = repairedFinal.details.fingerprint.hunks[0].id;
  const repairedSafetyInput = JSON.parse(repairedFinal.content[0].text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  const repairedSafetyRequest = managedRequest(repairedSafetyInput.task);
  assert.match(repairedSafetyRequest.singleTask, /MANDATORY_REGRESSION_REPLAYS_JSON=\[\{"id":"replay-/);
  assert.match(repairedSafetyRequest.singleTask, /at least 16 distinct successful bash calls/);
  assert.match(repairedSafetyRequest.singleTask, /exactly one distinct kind regression-generalization probe/);
  assert.match(repairedSafetyRequest.singleTask, /Never blacklist the saved example's literal value/);
  const replayId = repairedSafetyRequest.regressionLedger[0].id;
  assert.equal(await call("safety-review", "subagent", repairedSafetyInput), undefined);
  const safeEvidence = admissionCuts.flatMap((cut, index) => [
    {
      id: `${cut.id}-repaired-intended`,
      cutId: cut.id,
      hunkId: repairedHunkId,
      kind: "intended",
      command: `node -e "require('./src/value.js'); process.stdout.write('repaired-intended-${index}')"`,
      obligationIds: cut.obligationIds,
      contractCitation: cut.contractCitations[0],
      expected: "The changed answer module satisfies this admitted contract cut.",
      observed: "The repaired intended-behavior command exited successfully.",
      verdict: "PASS",
    },
    {
      id: `${cut.id}-repaired-non-regression`,
      cutId: cut.id,
      hunkId: repairedHunkId,
      kind: "non-regression",
      command: `node -e "require('./src/value.js'); process.stdout.write('repaired-regression-${index}')"`,
      obligationIds: cut.obligationIds,
      contractCitation: cut.contractCitations[0],
      expected: "The admitted cut retains its documented counterexample behavior.",
      observed: "The repaired non-regression command exited successfully.",
      verdict: "PASS",
    },
  ]);
  admissionCuts.slice(0, manifest.frontierPolicy.minCounterfactualFamilies).forEach((cut, index) => safeEvidence.push({
    id: `${cut.id}-repaired-counterfactual`,
    cutId: cut.id,
    hunkId: repairedHunkId,
    kind: "counterfactual",
    command: `node -e "process.stdout.write('repaired-counterfactual-${index}')"`,
    obligationIds: cut.obligationIds,
    contractCitation: cut.contractCitations[0],
    expected: "A plausible semantic mutant is rejected by the focused oracle.",
    observed: "ORIGINAL_PASS_MUTANT_FAIL was observed in an isolated temporary copy.",
    verdict: "PASS",
  }));
  safeEvidence.push({
    id: "mandatory-regression-replay",
    cutId: unsafeEvidence[0].cutId,
    hunkId: repairedHunkId,
    kind: "regression-replay",
    command: unsafeEvidence[0].command,
    obligationIds: unsafeEvidence[0].obligationIds,
    contractCitation: unsafeEvidence[0].contractCitation,
    expected: unsafeEvidence[0].expected,
    observed: "The exact previously failing command now satisfies its expected contract.",
    verdict: "PASS",
  });
  const missingGeneralizationReport = [
    "The exact replay passes, but no varied sibling was supplied.",
    `SAFETY_EVIDENCE_JSON=${JSON.stringify(safeEvidence)}`,
    "TOTAL_CHANGED_HUNKS=1",
    "TOTAL_REVIEWED_HUNKS=1",
    `TOTAL_PROBES=${safeEvidence.length}`,
    "TOTAL_REGRESSIONS=0",
    "SAFETY_VERDICT=SAFE",
  ].join("\n");
  const missingGeneralization = await toolResult({
    type: "tool_result", toolCallId: "safety-review", toolName: "subagent", input: repairedSafetyInput,
    content: [{ type: "text", text: missingGeneralizationReport }],
    details: { mode: "single", agentScope: "user", results: [{
      agent: "cora-frontier-diff-auditor", exitCode: 0, stopReason: "end",
      messages: [
        { role: "assistant", content: safeEvidence.map((probe, index) =>
          ({ type: "toolCall", id: `missing-generalization-call-${index}`, name: "bash", arguments: { command: probe.command } })) },
        ...safeEvidence.map((probe, index) => ({
          role: "toolResult", toolCallId: `missing-generalization-call-${index}`, toolName: "bash",
          content: [{ type: "text", text: probe.kind === "counterfactual" ? "ORIGINAL_PASS_MUTANT_FAIL" : "ok" }],
          isError: false,
        })),
      ],
    }] }, isError: false,
  });
  assert.match(missingGeneralization.content.at(-1).text, /requires exactly one distinct metamorphic generalization/);
  const generalizedSafetyInput = JSON.parse(missingGeneralization.content.at(-1).text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  assert.equal(await call("safety-review-generalized", "subagent", generalizedSafetyInput), undefined);
  safeEvidence.push({
    id: "mandatory-regression-generalization",
    cutId: unsafeEvidence[0].cutId,
    hunkId: repairedHunkId,
    kind: "regression-generalization",
    command: `node -e "process.stdout.write('GENERALIZATION_PASS:${replayId}')"`,
    obligationIds: unsafeEvidence[0].obligationIds,
    contractCitation: unsafeEvidence[0].contractCitation,
    expected: unsafeEvidence[0].expected,
    observed: `GENERALIZATION_PASS:${replayId} with a distinct changed-answer literal.`,
    verdict: "PASS",
  });
  const safeReport = [
    "Reviewed hunk src/value.js:1 with intended and compatibility counterexamples.",
    `SAFETY_EVIDENCE_JSON=${JSON.stringify(safeEvidence)}`,
    "TOTAL_CHANGED_HUNKS=1",
    "TOTAL_REVIEWED_HUNKS=1",
    `TOTAL_PROBES=${safeEvidence.length}`,
    "TOTAL_REGRESSIONS=0",
    "SAFETY_VERDICT=SAFE",
  ].join("\n");
  const safetyResult = await toolResult({
    type: "tool_result",
    toolCallId: "safety-review-generalized",
    toolName: "subagent",
    input: generalizedSafetyInput,
    content: [{ type: "text", text: safeReport }],
    details: {
      mode: "single", agentScope: "user", results: [{
        agent: "cora-frontier-diff-auditor", exitCode: 0, stopReason: "end",
        messages: [
          { role: "assistant", content: safeEvidence.map((probe, index) =>
            ({ type: "toolCall", id: `safe-call-${index}`, name: "bash", arguments: { command: probe.command } })) },
          ...safeEvidence.map((probe, index) =>
            ({ role: "toolResult", toolCallId: `safe-call-${index}`, toolName: "bash", content: [{ type: "text", text: probe.kind === "counterfactual"
              ? "ORIGINAL_PASS_MUTANT_FAIL"
              : probe.kind === "regression-generalization"
                ? `GENERALIZATION_PASS:${replayId}`
                : "ok" }], isError: false })),
        ],
      }] },
    isError: false,
  });
  assert.match(safetyResult.content.at(-1).text, /frontier_machine=final-safe/);
  assert.equal(await call("complete", "codara_complete", {}), undefined);

  write("src/value.js", "export const answer = 3;\n");
  const stale = await call("stale-complete", "codara_complete", {});
  assert.equal(stale.block, true);
  assert.match(stale.reason, /changed after final Frontier verification or independent safety review/);
  const evidence = JSON.parse(fs.readFileSync(manifestPath.replace(/\.json$/, ".evidence.json"), "utf8"));
  assert.equal(evidence.stage, "final-stale");
  assert.equal(evidence.baselineVerified, true);
  assert.equal(evidence.admissionVerified, true);
  assert.equal(evidence.admissionCuts.length, 5);
  assert.equal(evidence.finalFingerprint, null);
  assert.equal(evidence.finalSafeFingerprint, null);
  assert.equal(evidence.baselineCommands.length, 1);
  assert.equal(evidence.finalCommands.length, 1);

  // A structurally incomplete report cannot become SAFE or seed the trusted
  // replay ledger. The reviewer may still surface the finding to the manager,
  // but mandatory replays begin only after the whole report validates.
  const salvageFinal = await verify.execute("salvage-final", { phase: "final" });
  const salvageHunkId = salvageFinal.details.fingerprint.hunks[0].id;
  const salvageSafetyInput = JSON.parse(salvageFinal.content[0].text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  assert.equal(await call("salvage-safety-review", "subagent", salvageSafetyInput), undefined);
  const salvageCommand = `node -e "process.stdout.write('salvaged-regression')"`;
  const salvageProbe = {
    id: "salvaged-invalid-envelope-regression",
    cutId: admissionCuts[0].id,
    hunkId: salvageHunkId,
    kind: "non-regression",
    command: salvageCommand,
    obligationIds: admissionCuts[0].obligationIds,
    contractCitation: admissionCuts[0].contractCitations[0],
    expected: "The admitted read boundary retains its prior compatible behavior.",
    observed: "REGRESSION: the exact focused compatibility command reproduced a defect.",
    verdict: "REGRESSION",
  };
  const salvaged = await toolResult({
    type: "tool_result",
    toolCallId: "salvage-safety-review",
    toolName: "subagent",
    input: salvageSafetyInput,
    content: [{ type: "text", text: [
      `SAFETY_EVIDENCE_JSON=${JSON.stringify([salvageProbe])}`,
      "TOTAL_CHANGED_HUNKS=1",
      "TOTAL_REVIEWED_HUNKS=1",
      "TOTAL_PROBES=1",
      "TOTAL_REGRESSIONS=1",
      "SAFETY_VERDICT=UNSAFE",
    ].join("\n") }],
    details: { mode: "single", agentScope: "user", results: [{
      agent: "cora-frontier-diff-auditor", exitCode: 0, stopReason: "end",
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "salvage-call", name: "bash", arguments: { command: salvageCommand } }] },
        { role: "toolResult", toolCallId: "salvage-call", toolName: "bash", content: [{ type: "text", text: "salvaged-regression" }], isError: false },
      ],
    }] },
    isError: false,
  });
  assert.match(salvaged.content.at(-1).text, /frontier_machine=final-not-safe/);
  const salvagedStored = JSON.parse(fs.readFileSync(manifestPath.replace(/\.json$/, ".evidence.json"), "utf8"));
  assert.equal(salvagedStored.regressionLedger.length, 1);
  assert.equal(salvagedStored.safetyReviewHistory.at(-1).valid, false);
  assert.equal(salvagedStored.safetyReviewHistory.at(-1).newRegressionReplayIds.length, 0);

  // A previously proven exact-state admission may replace only the managed
  // contract-review spend. Baseline commands and fresh final safety remain
  // mandatory in the new process.
  write("src/value.js", fixtureSource);
  const cachedManifest = await discoverPiFrontierVerification(root);
  const cachedManifestPath = path.join(stateRoot, "frontier-cached-manifest.json");
  const cachedManifestText = JSON.stringify(cachedManifest);
  const cachedManifestSha = verificationManifestSha256(cachedManifest);
  fs.writeFileSync(cachedManifestPath, cachedManifestText, { mode: 0o600 });
  const cachedScope = piFrontierAdmissionScope(cachedManifest);
  assert.ok(cachedScope);
  const cacheEntry = createPiFrontierAdmissionEntry({
    scope: cachedScope,
    auditorReport: admissionReport,
    provenance: {
      runId: "run-frontier-source",
      manifestSha256: manifestSha256,
      baselineVerified: true,
      admissionVerified: true,
      finalCommandsPassed: true,
      finalSafetyVerdict: "SAFE",
      finalDiffSha256: final.details.fingerprint.sha256,
      finalChangedHunks: 1,
      safetyProbes: 14,
      completedAt: "2026-07-20T12:00:00.000Z",
    },
  });
  const cacheArtifact = artifactFromPiFrontierAdmission(cacheEntry);
  const cacheArtifactPath = path.join(stateRoot, "frontier-admission-hit.json");
  fs.writeFileSync(cacheArtifactPath, JSON.stringify(cacheArtifact), { mode: 0o600 });
  process.env.SPARK_RUN_ID = "run-frontier-cached-test";
  process.env.CODARA_PI_FRONTIER_MANIFEST = cachedManifestPath;
  process.env.CODARA_PI_FRONTIER_MANIFEST_SHA256 = cachedManifestSha;
  process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT = cacheArtifactPath;
  process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256 = admissionArtifactSha256(cacheArtifact);
  const cachedLoaded = await loadExtensions([extensionPath], root);
  assert.deepEqual(cachedLoaded.errors, []);
  const cachedExtension = cachedLoaded.extensions[0];
  const cachedPrompt = await cachedExtension.handlers.get("before_agent_start")[0]({ systemPrompt: "base" });
  assert.match(cachedPrompt.systemPrompt, /Exact-state admission cache: HIT/);
  const cachedVerify = cachedExtension.tools.get("cora_frontier_verify").definition;
  const cachedBaseline = await cachedVerify.execute("cached-baseline", { phase: "baseline" });
  assert.equal(cachedBaseline.isError, false);
  assert.match(cachedBaseline.content[0].text, /admission_cache=cache-candidate-loaded/);
  const cachedAdmit = cachedExtension.tools.get("cora_frontier_admit").definition;
  const cachedAdmission = await cachedAdmit.execute("cached-admit", {});
  assert.equal(cachedAdmission.details.passed, true);
  const cachedEvidence = JSON.parse(fs.readFileSync(cachedManifestPath.replace(/\.json$/, ".evidence.json"), "utf8"));
  assert.equal(cachedEvidence.admissionSource, "cache");
  write("src/value.js", "export const answer = 2;\n");
  const cachedFinal = await cachedVerify.execute("cached-final", { phase: "final" });
  assert.equal(cachedFinal.details.passed, true);
  assert.equal(cachedFinal.details.independentlySafe, false);
  const cachedToolCall = cachedExtension.handlers.get("tool_call")[0];
  const cachedComplete = await cachedToolCall({ type: "tool_call", toolCallId: "cached-complete", toolName: "codara_complete", input: {} });
  assert.equal(cachedComplete.block, true);
  assert.match(cachedComplete.reason, /independent SAFE diff review/);

  // A broad contract activates V3 risk-weighted depth and the exact two-agent
  // specialist/integration safety chain.
  const riskWrite = (relativePath, value) => {
    const target = path.join(riskRoot, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  execFileSync("git", ["-C", riskRoot, "init", "--quiet"]);
  riskWrite("package.json", JSON.stringify({ name: "frontier-risk-fixture", scripts: { test: "node -e \"process.exit(0)\"" } }));
  riskWrite("README.md", "# Contract\n\nThe answer is exact.\n");
  for (let index = 1; index <= 7; index += 1) {
    riskWrite(`docs/contract-${index}.md`, `# Contract ${index}\n\nState transition ${index} is exact and atomic.\n`);
  }
  riskWrite("src/value.js", ["export const answer = 1;", ...Array.from({ length: 30 }, (_value, index) => `function causalRoot${index + 2}() { return ${index + 2}; }`), ""].join("\n"));
  execFileSync("git", ["-C", riskRoot, "add", "."]);
  execFileSync("git", ["-C", riskRoot, "-c", "user.name=Codara Test", "-c", "user.email=test@codara.invalid", "commit", "--quiet", "-m", "risk fixture"]);
  const riskManifest = await discoverPiFrontierVerification(riskRoot);
  assert.equal(riskManifest.contractPaths.length, 8);
  assert.deepEqual(riskManifest.frontierPolicy, {
    schemaVersion: 3,
    targetCuts: 20,
    minFamilies: 10,
    minOperations: 5,
    minDeepFamilies: 5,
    minCriticalFamilies: 2,
    maxObligationsPerCut: 8,
    maxObligationsPerProbe: 4,
    minCounterfactualFamilies: 10,
  });
  const riskManifestPath = path.join(stateRoot, "frontier-risk-manifest.json");
  const riskManifestText = JSON.stringify(riskManifest);
  const riskManifestSha = verificationManifestSha256(riskManifest);
  fs.writeFileSync(riskManifestPath, riskManifestText, { mode: 0o600 });
  process.env.SPARK_RUN_ID = "run-frontier-risk-test";
  process.env.CODARA_PI_FRONTIER_MANIFEST = riskManifestPath;
  process.env.CODARA_PI_FRONTIER_MANIFEST_SHA256 = riskManifestSha;
  delete process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT;
  delete process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256;
  process.chdir(riskRoot);
  const riskLoaded = await loadExtensions([extensionPath], riskRoot);
  assert.deepEqual(riskLoaded.errors, []);
  const riskExtension = riskLoaded.extensions[0];
  const riskPrompt = await riskExtension.handlers.get("before_agent_start")[0]({ systemPrompt: "base" });
  const riskAdmissionInput = JSON.parse(riskPrompt.systemPrompt.split("\n")
    .find((line) => line.startsWith(admissionPrefix)).slice(admissionPrefix.length));
  const riskAdmissionRequest = managedRequest(riskAdmissionInput.chain[1].task);
  assert.match(riskAdmissionRequest.auditorTask, /TOTAL_DEEP_FAMILIES/);
  const riskVerify = riskExtension.tools.get("cora_frontier_verify").definition;
  assert.equal((await riskVerify.execute("risk-baseline", { phase: "baseline" })).details.passed, true);
  const riskToolCall = riskExtension.handlers.get("tool_call")[0];
  const riskToolResult = riskExtension.handlers.get("tool_result")[0];
  assert.equal(await riskToolCall({ type: "tool_call", toolCallId: "risk-admission", toolName: "subagent", input: riskAdmissionInput }), undefined);
  const familySizes = [3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1];
  const riskFamilies = [
    "lifecycle", "persistence", "validation", "concurrency", "serialization", "observability", "recovery",
    "permissions", "routing", "budgeting", "atomicity", "compatibility", "ordering",
  ];
  const riskOperations = ["submit", "approve", "plan", "apply", "snapshot"];
  const riskSemantics = [
    "creation", "closure", "restoration", "checksum", "shape", "precedence", "contention", "cancellation", "retry", "timeout",
    "ownership", "visibility", "isolation", "recovery", "authorization", "routing", "budget", "atomicity", "compatibility", "ordering",
  ];
  const riskCuts = [];
  let riskCutIndex = 0;
  familySizes.forEach((size, familyIndex) => {
    for (let member = 0; member < size; member += 1) {
      const index = riskCutIndex++;
      riskCuts.push({
        id: `risk-cut-${index}`,
        family: riskFamilies[familyIndex],
        operations: [riskOperations[index % riskOperations.length]],
        obligationIds: [riskManifest.contractObligations[index % riskManifest.contractObligations.length].id],
        contractCitations: [`${riskManifest.contractPaths[index % riskManifest.contractPaths.length]}:1`],
        implementationRoots: [`src/value.js:${index + 1}`],
        failureMode: `The ${riskSemantics[index]} invariant crosses its causal boundary incorrectly.`,
        positiveProbe: `Exercise the valid ${riskSemantics[index]} transition and assert its exact observable result.`,
        negativeProbe: `Exercise the invalid ${riskSemantics[index]} boundary and assert atomic rejection.`,
      });
    }
  });
  assert.equal(riskCuts.length, 20);
  const riskAdmissionReport = [
    "Risk-weighted audit complete.",
    "TOTAL_CUTS=20",
    "TOTAL_FAMILIES=13",
    "TOTAL_OPERATIONS=5",
    "TOTAL_DEEP_FAMILIES=5",
    "TOTAL_CRITICAL_FAMILIES=2",
    `ADMISSION_CUTS_JSON=${JSON.stringify(riskCuts)}`,
  ].join("\n");
  await riskToolResult({
    type: "tool_result", toolCallId: "risk-admission", toolName: "subagent", input: riskAdmissionInput,
    content: [{ type: "text", text: riskAdmissionReport }],
    details: { mode: "chain", agentScope: "user", results: [
      { agent: "cora-frontier-contract-tracer", exitCode: 0, stopReason: "end" },
      { agent: "cora-frontier-contract-auditor", exitCode: 0, stopReason: "end" },
    ] }, isError: false,
  });
  const riskAdmitted = await riskExtension.tools.get("cora_frontier_admit").definition.execute("risk-admit", {});
  assert.equal(riskAdmitted.details.cuts, 20);
  riskWrite("src/value.js", "export const answer = 2;\n");
  const riskFinal = await riskVerify.execute("risk-final", { phase: "final" });
  const riskSafetyInput = JSON.parse(riskFinal.content[0].text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  assert.equal(riskSafetyInput.chain.length, 2);
  assert.deepEqual(riskSafetyInput.chain.map((entry) => entry.agent), [
    "cora-frontier-family-auditor", "cora-frontier-integration-auditor",
  ]);
  const riskSafetyRequest = managedRequest(riskSafetyInput.chain[0].task);
  assert.match(riskSafetyRequest.familyTask, /DEEP_CUTS_JSON=/);
  assert.match(riskSafetyRequest.integrationTask, /at least 57 distinct successful bash calls/);
  assert.equal(riskSafetyRequest.kind, "frontier-safety-v11-chain");
  assert.match(riskSafetyRequest.partialReportPath, /\.safety-[0-9]+-[a-f0-9]{16}\.attempt-1\.partial\.txt$/);
  assert.match(riskSafetyRequest.familyTask, /PARTIAL_SAFETY_REPORT_SHA256/);
  assert.doesNotMatch(riskSafetyInput.chain[1].task, /\{previous\}/);
  assert.match(riskSafetyRequest.integrationTask, /deliberately not copied into your task or process arguments/);
  assert.match(riskSafetyRequest.integrationTask, /FIRST_REVIEWER_REPORT_SHA256/);
  assert.match(riskSafetyRequest.integrationTask, /do not copy, reserialize, rename, or claim/);
  assert.match(riskSafetyRequest.familyTask, /Never use e1\/e2-style two-character ids/);
  assert.match(riskSafetyRequest.integrationTask, /one-word observed summaries/);
  assert.equal(await riskToolCall({ type: "tool_call", toolCallId: "risk-safety", toolName: "subagent", input: riskSafetyInput }), undefined);
  const riskHunkId = riskFinal.details.fingerprint.hunks[0].id;
  const riskProbe = (cut, id, kind, sequence) => ({
    id,
    cutId: cut.id,
    hunkId: riskHunkId,
    kind,
    command: `node -e "process.stdout.write('risk-probe-${sequence}')"`,
    obligationIds: cut.obligationIds,
    contractCitation: cut.contractCitations[0],
    expected: `The exact risk contract behavior remains valid for probe ${sequence}.`,
    observed: kind === "counterfactual"
      ? "ORIGINAL_PASS_MUTANT_FAIL proves the focused oracle kills the semantic mutant."
      : `The distinct focused command passed for risk probe ${sequence}.`,
    verdict: "PASS",
  });
  let riskSequence = 0;
  const partialRiskEvidence = riskCuts.slice(0, 12).flatMap((cut) => [
    riskProbe(cut, `${cut.id}-deep-intended`, "intended", riskSequence++),
    riskProbe(cut, `${cut.id}-deep-non-regression`, "non-regression", riskSequence++),
  ]);
  const integrationRiskEvidence = riskCuts.slice(12).flatMap((cut) => [
    riskProbe(cut, `${cut.id}-singleton-intended`, "intended", riskSequence++),
    riskProbe(cut, `${cut.id}-singleton-non-regression`, "non-regression", riskSequence++),
  ]);
  let familyStart = 0;
  familySizes.slice(0, 5).forEach((size, familyIndex) => {
    const cut = riskCuts[familyStart];
    const required = size >= 3 ? 2 : 1;
    for (let index = 0; index < required; index += 1) {
      integrationRiskEvidence.push(riskProbe(
        cut,
        `${cut.id}-interaction-${index}`,
        "interaction",
        riskSequence++,
      ));
    }
    familyStart += size;
  });
  familyStart = 0;
  familySizes.slice(0, 10).forEach((size, familyIndex) => {
    const cut = riskCuts[familyStart];
    integrationRiskEvidence.push(riskProbe(
      cut,
      `${cut.id}-counterfactual-${familyIndex}`,
      "counterfactual",
      riskSequence++,
    ));
    familyStart += size;
  });
  assert.equal(partialRiskEvidence.length, 24);
  assert.equal(integrationRiskEvidence.length, 33);
  const partialRiskReport = `PARTIAL_SAFETY_EVIDENCE_JSON=${JSON.stringify(partialRiskEvidence)}`;
  const riskReport = (evidence, binding) => [
    `FIRST_REVIEWER_REPORT_SHA256=${binding.sha256}`,
    `FIRST_REVIEWER_REPORT_BYTES=${binding.bytes}`,
    `SAFETY_EVIDENCE_JSON=${JSON.stringify(evidence)}`,
    "TOTAL_CHANGED_HUNKS=1",
    "TOTAL_REVIEWED_HUNKS=1",
    "TOTAL_PROBES=57",
    "TOTAL_REGRESSIONS=0",
    "SAFETY_VERDICT=SAFE",
  ].join("\n");
  const riskMessages = (evidence, prefix, finalText = null, binding = null) => [
    ...(binding ? [
      { role: "assistant", content: [{ type: "toolCall", id: `${prefix}-binding`, name: "bash", arguments: { command: binding.command } }] },
      { role: "toolResult", toolCallId: `${prefix}-binding`, toolName: "bash", content: [{ type: "text", text: `${binding.sha256} ${binding.bytes}` }], isError: false },
    ] : []),
    { role: "assistant", content: evidence.map((probe, index) => ({
      type: "toolCall", id: `${prefix}-call-${index}`, name: "bash", arguments: { command: probe.command },
    })) },
    ...evidence.map((probe, index) => ({
      role: "toolResult", toolCallId: `${prefix}-call-${index}`, toolName: "bash",
      content: [{ type: "text", text: probe.kind === "counterfactual" ? "ORIGINAL_PASS_MUTANT_FAIL" : "risk probe passed" }],
      isError: false,
    })),
    ...(finalText ? [{ role: "assistant", content: [{ type: "text", text: finalText }] }] : []),
  ];
  const writePartialPointer = (input, report) => {
    const request = managedRequest(input.chain[0].task);
    const bytes = Buffer.from(report, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(request.partialReportPath, bytes, { mode: 0o600 });
    return {
      path: request.partialReportPath,
      sha256,
      bytes: bytes.length,
      command: `node -e "process.stdout.write('artifact-binding')" '${request.partialReportPath}'`,
      pointer: [
      `PARTIAL_SAFETY_REPORT_PATH=${request.partialReportPath}`,
      `PARTIAL_SAFETY_REPORT_SHA256=${sha256}`,
      `PARTIAL_SAFETY_REPORT_BYTES=${bytes.length}`,
      ].join("\n"),
    };
  };

  // The second reviewer cannot launder a first-reviewer execution into its own
  // payload. V6 binds each payload to only that reviewer's Bash transcript.
  const copiedIntegrationEvidence = integrationRiskEvidence.map((probe, index) => index === 0
    ? { ...probe, command: partialRiskEvidence[0].command }
    : probe);
  const copiedPartialPointer = writePartialPointer(riskSafetyInput, partialRiskReport);
  const tamperedCopiedPointer = copiedPartialPointer.pointer.replace(
    /^PARTIAL_SAFETY_REPORT_SHA256=[a-f0-9]{64}$/m,
    `PARTIAL_SAFETY_REPORT_SHA256=${"0".repeat(64)}`,
  );
  const copiedRisk = await riskToolResult({
    type: "tool_result", toolCallId: "risk-safety", toolName: "subagent", input: riskSafetyInput,
    content: [{ type: "text", text: riskReport(copiedIntegrationEvidence, copiedPartialPointer) }],
    details: { mode: "chain", agentScope: "user", results: [
      {
        agent: "cora-frontier-family-auditor", exitCode: 0, stopReason: "end",
        messages: riskMessages(partialRiskEvidence, "risk-partial-copy", tamperedCopiedPointer),
      },
      {
        agent: "cora-frontier-integration-auditor", exitCode: 0, stopReason: "end",
        messages: riskMessages(integrationRiskEvidence, "risk-integration-copy", null, copiedPartialPointer),
      },
    ] }, isError: false,
  });
  assert.match(copiedRisk.content.at(-1).text, /first reviewer partial-report SHA-256 mismatch/);
  assert.match(copiedRisk.content.at(-1).text, /second reviewer: probe risk-cut-12-singleton-intended does not match a distinct successful bash execution/);
  const bindingSafetyInput = JSON.parse(copiedRisk.content.at(-1).text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  const bindingSafetyRequest = managedRequest(bindingSafetyInput.chain[0].task);
  assert.equal(bindingSafetyRequest.kind, "frontier-safety-v11-chain");
  assert.match(bindingSafetyRequest.rejectedReport, /FIRST_REVIEWER_REPORT_BEGIN/);
  assert.equal(await riskToolCall({
    type: "tool_call", toolCallId: "risk-safety-binding", toolName: "subagent", input: bindingSafetyInput,
  }), undefined);
  const bindingPartialPointer = writePartialPointer(bindingSafetyInput, partialRiskReport);
  const wrongBinding = { ...bindingPartialPointer, sha256: "0".repeat(64) };
  const bindingRisk = await riskToolResult({
    type: "tool_result", toolCallId: "risk-safety-binding", toolName: "subagent", input: bindingSafetyInput,
    content: [{ type: "text", text: riskReport(integrationRiskEvidence, wrongBinding) }],
    details: { mode: "chain", agentScope: "user", results: [
      {
        agent: "cora-frontier-family-auditor", exitCode: 0, stopReason: "end",
        messages: riskMessages(partialRiskEvidence, "risk-partial-binding", bindingPartialPointer.pointer),
      },
      {
        agent: "cora-frontier-integration-auditor", exitCode: 0, stopReason: "end",
        messages: riskMessages(integrationRiskEvidence, "risk-integration-binding", null, bindingPartialPointer),
      },
    ] }, isError: false,
  });
  assert.match(bindingRisk.content.at(-1).text, /second reviewer must report the exact first-reviewer artifact SHA-256/);
  const mergedSafetyInput = JSON.parse(bindingRisk.content.at(-1).text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  assert.equal(await riskToolCall({
    type: "tool_call", toolCallId: "risk-safety-merged", toolName: "subagent", input: mergedSafetyInput,
  }), undefined);
  const mergedPartialPointer = writePartialPointer(mergedSafetyInput, partialRiskReport);
  const mergedRisk = await riskToolResult({
    type: "tool_result", toolCallId: "risk-safety-merged", toolName: "subagent", input: mergedSafetyInput,
    content: [{ type: "text", text: riskReport(integrationRiskEvidence, mergedPartialPointer) }],
    details: { mode: "chain", agentScope: "user", results: [
      {
        agent: "cora-frontier-family-auditor", exitCode: 0, stopReason: "end",
        messages: riskMessages(partialRiskEvidence, "risk-partial-valid", mergedPartialPointer.pointer),
      },
      {
        agent: "cora-frontier-integration-auditor", exitCode: 0, stopReason: "end",
        messages: riskMessages(integrationRiskEvidence, "risk-integration-valid", null, mergedPartialPointer),
      },
    ] }, isError: false,
  });
  assert.match(mergedRisk.content.at(-1).text, /frontier_machine=final-safe/);
  const mergedStored = JSON.parse(fs.readFileSync(riskManifestPath.replace(/\.json$/, ".evidence.json"), "utf8"));
  assert.equal(mergedStored.safetyEvidence.length, 57);
  assert.equal(mergedStored.safetyAssessment.probes, 57);

  // Start a fresh fingerprint before exercising the bounded invalid-report
  // correction path below.
  assert.equal(await riskToolCall({ type: "tool_call", toolCallId: "risk-mutate-after-safe", toolName: "edit", input: {} }), undefined);
  riskWrite("src/value.js", "export const answer = 3;\n");
  const boundedFinal = await riskVerify.execute("risk-bounded-final", { phase: "final" });
  const boundedRegressionCommand = `node -e "process.stdout.write('bounded-chain-regression')"`;
  const boundedRegression = {
    ...partialRiskEvidence[0],
    id: "bounded-chain-regression",
    hunkId: boundedFinal.details.fingerprint.hunks[0].id,
    kind: "non-regression",
    command: boundedRegressionCommand,
    expected: "The deep-family compatibility boundary survives the new exact fingerprint.",
    observed: "REGRESSION: the exact deep-family compatibility probe reproduced a defect.",
    verdict: "REGRESSION",
  };
  const boundedPartialReport = `PARTIAL_SAFETY_EVIDENCE_JSON=${JSON.stringify([boundedRegression])}`;
  let boundedSafetyInput = JSON.parse(boundedFinal.content[0].text.split("\n")
    .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
  const boundedSafetyRequest = managedRequest(boundedSafetyInput.chain[0].task);
  assert.notEqual(boundedSafetyRequest.partialReportPath, mergedPartialPointer.path);
  assert.match(boundedSafetyRequest.partialReportPath, /\.safety-[0-9]+-[a-f0-9]{16}\.attempt-1\.partial\.txt$/);
  assert.equal(await riskToolCall({
    type: "tool_call", toolCallId: "risk-safety-bounded", toolName: "subagent", input: boundedSafetyInput,
  }), undefined);
  const boundedIntegrationReport = [
    "structurally incomplete safety report",
    "SAFETY_EVIDENCE_JSON=[]",
    "TOTAL_CHANGED_HUNKS=1",
    "TOTAL_REVIEWED_HUNKS=1",
    "TOTAL_PROBES=0",
    "TOTAL_REGRESSIONS=0",
    "SAFETY_VERDICT=SAFE",
  ].join("\n");
  let boundedSafetyCallId = "risk-safety-bounded";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const boundedPartialPointer = attempt === 1 ? writePartialPointer(boundedSafetyInput, boundedPartialReport) : null;
    const rejected = await riskToolResult({
      type: "tool_result",
      toolCallId: boundedSafetyCallId,
      toolName: "subagent",
      input: boundedSafetyInput,
      content: [{ type: "text", text: boundedIntegrationReport }],
      details: { mode: "chain", agentScope: "user", results: [
        {
          agent: "cora-frontier-family-auditor", exitCode: 0, stopReason: "end",
          ...(attempt === 1 ? { messages: riskMessages([boundedRegression], "bounded-regression", boundedPartialPointer.pointer) } : {}),
        },
        { agent: "cora-frontier-integration-auditor", exitCode: 0, stopReason: "end" },
      ] },
      isError: false,
    });
    if (attempt === 4) {
      assert.match(rejected.content.at(-1).text, /safety-review-exhausted/);
      assert.match(rejected.content.at(-1).text, /attempts=4/);
      assert.equal((await riskToolCall({
        type: "tool_call", toolCallId: "risk-safety-exhausted", toolName: "subagent", input: boundedSafetyInput,
      })).block, true);
      break;
    }
    if (attempt === 1) {
      const boundedStored = JSON.parse(fs.readFileSync(riskManifestPath.replace(/\.json$/, ".evidence.json"), "utf8"));
      assert.equal(boundedStored.regressionLedger.length, 0);
      assert.equal(boundedStored.safetyReviewHistory.at(-1).newRegressionReplayIds.length, 0);
    }
    const nextInput = JSON.parse(rejected.content.at(-1).text.split("\n")
      .find((line) => line.startsWith(safetyPrefix)).slice(safetyPrefix.length));
    const nextRequest = managedRequest(nextInput.chain[0].task);
    assert.equal(nextRequest.kind, "frontier-safety-v11-chain");
    assert.equal(nextRequest.feedback.attempt, attempt + 1);
    assert.ok(nextRequest.feedback.safetyDiagnostics.allErrors.length > 32);
    assert.equal(nextRequest.feedback.errors.length, 32);
    assert.ok(nextRequest.feedback.safetyDiagnostics.cutIds.length >= 10);
    assert.match(nextRequest.rejectedReport, /FIRST_REVIEWER_REPORT_BEGIN/);
    assert.match(nextRequest.rejectedReport, /structurally incomplete safety report/);
    assert.match(nextRequest.integrationTask, /VALIDATOR_FEEDBACK_JSON=/);
    boundedSafetyInput = nextInput;
    boundedSafetyCallId = `risk-safety-${attempt + 1}`;
    assert.equal(await riskToolCall({
      type: "tool_call", toolCallId: boundedSafetyCallId, toolName: "subagent", input: boundedSafetyInput,
    }), undefined);
  }
  process.chdir(root);

  write("src/value.js", fixtureSource);
  fs.writeFileSync(path.join(root, "asset.bin"), Buffer.from([0, 9, 2, 0]));
  const binaryFingerprint = frontierDiffFingerprint(root);
  assert.equal(binaryFingerprint.changedHunks, 1);
  assert.equal(binaryFingerprint.hunks[0].kind, "tracked");
  assert.match(binaryFingerprint.hunks[0].locator, /binary, rename, mode, or whole-file change/);
  write("new-file.js", "module.exports = true;\n");
  const untrackedFingerprint = frontierDiffFingerprint(root);
  assert.equal(untrackedFingerprint.changedHunks, 2);
  assert.equal(untrackedFingerprint.hunks[1].kind, "untracked");

  write("README.md", "# Revised contract\n\nThe exported answer must now remain stable across a restart.\n");
  assert.notEqual(contractWorkspaceTreeSha256(root, manifest.contractPaths), manifest.contractTreeSha256);
  const driftBlocked = await call("contract-drift-write", "write", {});
  assert.equal(driftBlocked.block, true);
  assert.match(driftBlocked.reason, /CORA_FRONTIER_CONTRACT_DRIFT restart_required=true/);
  const driftFinal = await verify.execute("contract-drift-final", { phase: "final" });
  assert.equal(driftFinal.isError, true);
  assert.match(driftFinal.content[0].text, /frontier=contract-drift/);
  assert.equal(driftFinal.details.restartRequired, true);
  const driftEvidence = JSON.parse(fs.readFileSync(manifestPath.replace(/\.json$/, ".evidence.json"), "utf8"));
  assert.equal(driftEvidence.stage, "contract-drift");
  assert.equal(driftEvidence.contractDrift.expected, manifest.contractTreeSha256);
  assert.match(driftEvidence.contractDrift.actual, /^[a-f0-9]{64}$/);

  fs.writeFileSync(manifestPath, `${manifestText} `);
  assert.throws(
    () => loadFrontierVerificationManifest(manifestPath, manifestSha256),
    /hash mismatch/,
  );
} finally {
  process.chdir(originalCwd);
  delete process.env.CODARA_PI_EXECUTION_POLICY;
  delete process.env.SPARK_MCP_MODE;
  delete process.env.SPARK_RUN_ID;
  delete process.env.CODARA_PI_FRONTIER_MANIFEST;
  delete process.env.CODARA_PI_FRONTIER_MANIFEST_SHA256;
  delete process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT;
  delete process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(stateRoot, { recursive: true, force: true });
  fs.rmSync(riskRoot, { recursive: true, force: true });
}

console.log("Pi Frontier gate: exact managed admission, content-addressed observability blockers, contract-drift restart signaling, diff-bound safety review, and stale-completion refusal verified");

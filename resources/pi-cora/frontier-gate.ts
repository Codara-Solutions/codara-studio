import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadFrontierAdmissionArtifact } from "./frontier-cache";
import {
  CONTRACT_BLOCKER_KEYS,
  parseContractBlocker,
  type ContractBlocker,
} from "./frontier-contract-blocker";
import {
  contractWorkspaceTreeSha256,
  frontierDiffFingerprint,
  loadFrontierVerificationManifest,
  trackedWorkspaceTreeSha256,
  type FrontierDiffFingerprint,
  type FrontierVerificationManifest,
} from "./frontier-core";

const CONTRACT_DRIFT_MARKER = "CORA_FRONTIER_CONTRACT_DRIFT";

type CommandEvidence = {
  id: string;
  command: string;
  args: string[];
  cwdRelative: string;
  exitCode: number;
  durationMs: number;
  stdoutSha256: string;
  stderrSha256: string;
};

type AdmissionCut = {
  id: string;
  family: string;
  operations: string[];
  obligationIds: string[];
  contractCitations: string[];
  implementationRoots: string[];
  failureMode: string;
  positiveProbe: string;
  negativeProbe: string;
};

type SafetyAssessment = {
  changedHunks: number;
  reviewedHunks: number;
  probes: number;
  regressions: number;
  verdict: "SAFE" | "UNSAFE";
};

type SafetyProbeEvidence = {
  id: string;
  cutId: string;
  hunkId: string;
  kind: "intended" | "non-regression" | "interaction" | "counterfactual" | "regression-replay" | "regression-generalization";
  command: string;
  obligationIds: string[];
  contractCitation: string;
  expected: string;
  observed: string;
  verdict: "PASS" | "REGRESSION";
};

type RegressionReplay = {
  id: string;
  cutId: string;
  command: string;
  contractCitation: string;
  expected: string;
  firstObserved: string;
};

type SafetyReviewAttempt = {
  at: string;
  fingerprintSha256: string;
  reportSha256: string | null;
  valid: boolean;
  assessment: SafetyAssessment | null;
  errorCount: number;
  errors: string[];
  newRegressionReplayIds: string[];
};

type AdmissionReviewAttempt = {
  at: string;
  kind?: "execution" | "report-validation";
  reportSha256: string | null;
  canonicalReportSha256?: string | null;
  canonicalizedEnvelope?: boolean;
  repairedEnvelopeErrors?: string[];
  valid: boolean;
  errors: string[];
};


type ReviewFeedback = {
  attempt: number;
  errors: string[];
  rejectedReportSha256: string | null;
  admissionDiagnostics?: {
    missingObligationIds: string[];
    unknownObligationIds: string[];
    oversizedCuts: Array<{ index: number; id: string; obligations: number; maximum: number }>;
    computedTotals: AdmissionTotals;
  };
  safetyDiagnostics?: {
    allErrors: string[];
    unmatchedProbes: Array<{ reviewer: "first" | "second" | "combined"; id: string }>;
    hunkIds: string[];
    cutIds: string[];
    obligationIds: string[];
    interactionFamilies: string[];
    regressionReplayIds: string[];
    regressionGeneralizationIds: string[];
  };
};

type ManagedAdmissionReviewPlan = {
  attempt: number;
  mode: "single" | "chain";
  agents: string[];
  input: Record<string, unknown>;
  requestPath: string;
  requestSha256: string;
};

type ManagedSafetyReviewPlan = {
  key: string;
  attempt: number;
  mode: "single" | "chain";
  agents: string[];
  input: Record<string, unknown>;
  requestPath: string;
  requestSha256: string;
  partialReportPath?: string;
};

const MAX_MANAGED_REVIEW_ATTEMPTS = 4;

const MUTATING_TOOLS = new Set([
  "write",
  "edit",
  "codara_spawn_workers",
  "codara_spawn_terminals",
  "codara_terminal_create",
  "codara_terminal_write",
  "codara_terminal_close",
]);

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function clip(value: string, max = 16_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n[${value.length - max} characters omitted]`;
}

function readOnlyBash(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim().replace(/\s+/g, " ");
  if (/(?:[;&|><`]|\$\()/.test(normalized)) return false;
  return /^(?:pwd|ls\b|find\b|rg\b|grep\b|sed -n\b|head\b|tail\b|cat\b|wc\b|git (?:status|diff|show|log|rev-parse|ls-files)\b)/.test(normalized);
}

function safeEvidenceWrite(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  if (process.platform !== "win32") fs.chmodSync(filePath, 0o600);
}

function writeManagedRequest(filePath: string, value: unknown): string {
  safeEvidenceWrite(filePath, value);
  return hash(fs.readFileSync(filePath));
}

function managedRequestIntact(filePath: string, expectedSha256: string): boolean {
  try { return hash(fs.readFileSync(filePath)) === expectedSha256; }
  catch { return false; }
}

function requestTask(kind: string, filePath: string, sha256: string, field: string, previous = false): string {
  return [
    `CODARA_MANAGED_FRONTIER_REQUEST=${kind}`,
    `REQUEST_PATH=${filePath}`,
    `REQUEST_SHA256=${sha256}`,
    `REQUEST_FIELD=${field}`,
    ...(previous ? ["PREVIOUS_REPORT_BEGIN", "{previous}", "PREVIOUS_REPORT_END"] : []),
  ].join("\n");
}

function textBlocks(content: Array<{ type: string; text?: string }> | undefined): string {
  return (content ?? []).filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n");
}

function loadPartialSafetyReport(
  pointer: string,
  expectedPath: string,
): { report?: string; sha256?: string; bytes?: number; errors: string[] } {
  if (Buffer.byteLength(pointer, "utf8") > 16 * 1024) {
    return { errors: ["first reviewer partial-report pointer exceeds 16 KiB"] };
  }
  const normalized = pointer.replaceAll("\r\n", "\n");
  const pathMatches = [...normalized.matchAll(/^PARTIAL_SAFETY_REPORT_PATH=(.+)$/gm)];
  const shaMatches = [...normalized.matchAll(/^PARTIAL_SAFETY_REPORT_SHA256=([a-f0-9]{64})$/gm)];
  const bytesMatches = [...normalized.matchAll(/^PARTIAL_SAFETY_REPORT_BYTES=([0-9]+)$/gm)];
  if (pathMatches.length !== 1 || shaMatches.length !== 1 || bytesMatches.length !== 1) {
    return { errors: ["first reviewer must return one unambiguous path, SHA-256, and byte-count pointer"] };
  }
  const [pathMatch] = pathMatches;
  const [shaMatch] = shaMatches;
  const [bytesMatch] = bytesMatches;
  if ((pathMatch.index ?? -1) > (shaMatch.index ?? -1) || (shaMatch.index ?? -1) > (bytesMatch.index ?? -1)) {
    return { errors: ["first reviewer partial-report pointer fields are out of order"] };
  }
  if (path.resolve(pathMatch[1]) !== path.resolve(expectedPath)) return { errors: ["first reviewer partial-report path does not match the signed request"] };
  let stat: fs.Stats;
  try { stat = fs.lstatSync(expectedPath); }
  catch { return { errors: ["first reviewer partial-report artifact is missing"] }; }
  if (!stat.isFile()) return { errors: ["first reviewer partial-report artifact must be a regular file"] };
  if (stat.size < 32 || stat.size > 4 * 1024 * 1024 || Number(bytesMatch[1]) !== stat.size) {
    return { errors: ["first reviewer partial-report byte count is invalid"] };
  }
  const bytes = fs.readFileSync(expectedPath);
  const actualSha256 = hash(bytes);
  if (actualSha256 !== shaMatch[1]) return { errors: ["first reviewer partial-report SHA-256 mismatch"] };
  const report = bytes.toString("utf8");
  if (!Buffer.from(report, "utf8").equals(bytes) || report.includes("\0")) {
    return { errors: ["first reviewer partial-report artifact is not exact UTF-8 text"] };
  }
  return { report, sha256: actualSha256, bytes: stat.size, errors: [] };
}

function integrationPartialBindingErrors(
  report: string,
  executions: SuccessfulBashExecution[],
  expectedPath: string,
  expectedSha256: string,
  expectedBytes: number,
): string[] {
  const shaMatches = [...report.matchAll(/^FIRST_REVIEWER_REPORT_SHA256=([a-f0-9]{64})$/gm)];
  const bytesMatches = [...report.matchAll(/^FIRST_REVIEWER_REPORT_BYTES=([0-9]+)$/gm)];
  const errors: string[] = [];
  if (shaMatches.length !== 1 || shaMatches[0]?.[1] !== expectedSha256) {
    errors.push("second reviewer must report the exact first-reviewer artifact SHA-256");
  }
  if (bytesMatches.length !== 1 || Number(bytesMatches[0]?.[1]) !== expectedBytes) {
    errors.push("second reviewer must report the exact first-reviewer artifact byte count");
  }
  const boundExecution = executions.some((execution) =>
    execution.command.includes(expectedPath) && execution.output.includes(expectedSha256) &&
    new RegExp(`(?:^|\\D)${expectedBytes}(?:\\D|$)`).test(execution.output));
  if (!boundExecution) {
    errors.push("second reviewer lacks one successful path-bound Bash execution proving the first-reviewer artifact SHA-256 and byte count");
  }
  return errors;
}

function safetyDiagnostics(errors: string[]): NonNullable<ReviewFeedback["safetyDiagnostics"]> {
  const allErrors = [...new Set(errors)];
  const unmatched = new Map<string, { reviewer: "first" | "second" | "combined"; id: string }>();
  const hunkIds = new Set<string>();
  const cutIds = new Set<string>();
  const obligationIds = new Set<string>();
  const interactionFamilies = new Set<string>();
  const regressionReplayIds = new Set<string>();
  const regressionGeneralizationIds = new Set<string>();
  for (const error of allErrors) {
    const reviewer: "first" | "second" | "combined" = error.startsWith("first reviewer:")
      ? "first"
      : error.startsWith("second reviewer:") ? "second" : "combined";
    const probe = /(?:^|reviewer: )probe ([a-z0-9][a-z0-9._-]*) (?:does not match|lacks )/.exec(error);
    if (probe) {
      const prior = unmatched.get(probe[1]);
      if (!prior || (prior.reviewer === "combined" && reviewer !== "combined")) {
        unmatched.set(probe[1], { reviewer, id: probe[1] });
      }
    }
    const hunk = /^hunk (\S+) requires /.exec(error);
    if (hunk) hunkIds.add(hunk[1]);
    const cut = /^cut (\S+) requires /.exec(error);
    if (cut) cutIds.add(cut[1]);
    const obligation = /^(?:paired|positive) contract atom (\S+) (?:requires|lacks) /.exec(error);
    if (obligation) obligationIds.add(obligation[1]);
    const family = /^family (.+) requires at least /.exec(error);
    if (family) interactionFamilies.add(family[1]);
    const replay = /^mandatory regression replay (replay-[a-f0-9]{16}) requires exactly one exact /.exec(error);
    if (replay) regressionReplayIds.add(replay[1]);
    const generalization = /^mandatory regression replay (replay-[a-f0-9]{16}) requires exactly one distinct /.exec(error);
    if (generalization) regressionGeneralizationIds.add(generalization[1]);
  }
  return {
    allErrors,
    unmatchedProbes: [...unmatched.values()],
    hunkIds: [...hunkIds],
    cutIds: [...cutIds],
    obligationIds: [...obligationIds],
    interactionFamilies: [...interactionFamilies],
    regressionReplayIds: [...regressionReplayIds],
    regressionGeneralizationIds: [...regressionGeneralizationIds],
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function exactInput(actual: unknown, expected: unknown): boolean {
  try { return canonicalJson(actual) === canonicalJson(expected); }
  catch { return false; }
}

function successfulSubagentDetails(details: unknown, mode: "single" | "chain", agents: string[]): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const value = details as Record<string, unknown>;
  if (value.mode !== mode || value.agentScope !== "user" || !Array.isArray(value.results) || value.results.length !== agents.length) return false;
  return value.results.every((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const result = item as Record<string, unknown>;
    return result.agent === agents[index] && result.exitCode === 0 &&
      result.stopReason !== "error" && result.stopReason !== "aborted";
  });
}

type SuccessfulBashExecution = { command: string; output: string };

function subagentResults(details: unknown): Array<Record<string, unknown>> {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const results = (details as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  return results.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function subagentResultText(details: unknown, resultIndex: number): string {
  const result = subagentResults(details)[resultIndex];
  const messages = result?.messages;
  if (!Array.isArray(messages)) return "";
  const blocks: string[] = [];
  for (const messageValue of messages) {
    if (!messageValue || typeof messageValue !== "object" || Array.isArray(messageValue)) continue;
    const message = messageValue as Record<string, unknown>;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = textBlocks(message.content as Array<{ type: string; text?: string }>);
    if (text) blocks.push(text);
  }
  return blocks.join("\n");
}

function successfulBashExecutions(details: unknown, resultIndexes?: number[]): SuccessfulBashExecution[] {
  const results = subagentResults(details);
  const selected = resultIndexes ?? results.map((_item, index) => index);
  const executions: SuccessfulBashExecution[] = [];
  for (const index of selected) {
    const messages = results[index]?.messages;
    if (!Array.isArray(messages)) continue;
    const calls = new Map<string, string>();
    for (const messageValue of messages) {
      if (!messageValue || typeof messageValue !== "object" || Array.isArray(messageValue)) continue;
      const message = messageValue as Record<string, unknown>;
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const partValue of message.content) {
          if (!partValue || typeof partValue !== "object" || Array.isArray(partValue)) continue;
          const part = partValue as Record<string, unknown>;
          const args = part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)
            ? part.arguments as Record<string, unknown>
            : null;
          if (part.type === "toolCall" && part.name === "bash" && typeof part.id === "string" && typeof args?.command === "string") {
            calls.set(part.id, args.command);
          }
        }
      }
      if (message.role === "toolResult" && message.toolName === "bash" && message.isError !== true && typeof message.toolCallId === "string") {
        const command = calls.get(message.toolCallId);
        if (command) executions.push({
          command,
          output: textBlocks(Array.isArray(message.content) ? message.content as Array<{ type: string; text?: string }> : []),
        });
      }
    }
  }
  return executions;
}

const CUT_KEYS = [
  "id", "family", "operations", "obligationIds", "contractCitations", "implementationRoots",
  "failureMode", "positiveProbe", "negativeProbe",
] as const;

const ADMISSION_TOTAL_KEYS = [
  "TOTAL_CUTS", "TOTAL_FAMILIES", "TOTAL_OPERATIONS", "TOTAL_DEEP_FAMILIES", "TOTAL_CRITICAL_FAMILIES",
] as const;

type AdmissionTotals = Record<(typeof ADMISSION_TOTAL_KEYS)[number], number>;


function bounded(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.trim().length >= min && value.length <= max;
}

function boundedList(value: unknown, min: number, max: number, limit: number): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= limit &&
    value.every((item) => bounded(item, min, max)) && new Set(value).size === value.length;
}

function normalizedFamily(value: string): string {
  return value.trim().toLowerCase();
}

function numberedPlaceholder(value: string): boolean {
  const normalized = normalizedFamily(value);
  return /^op[:._-]/.test(normalized) ||
    /^(?:frontier|slice|cut|family|operation|contract)(?:[ ._-]*(?:slice|cut|family|operation))?[ ._:-]*\d+$/.test(normalized);
}

function semanticTemplate(value: string): string {
  return normalizedFamily(value)
    .replace(/obligation-[a-f0-9]{20}/g, "obligation-<id>")
    .replace(/\b[a-f0-9]{16,64}\b/g, "<hash>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/\s+/g, " ");
}

const IMPLEMENTATION_EXTENSIONS = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".mjs",
  ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx",
]);

function isImplementationSourcePath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  if (segments.some((segment) =>
    ["test", "tests", "__tests__", "spec", "specs", "fixtures", "testdata"].includes(segment))) return false;
  const basename = segments.at(-1) ?? "";
  return !/\.(?:test|spec)\.[^.]+$/.test(basename);
}

function callableRegionLines(source: string): number[] {
  const regions = [0];
  const controlFlowKeywords = new Set(["if", "for", "while", "switch", "catch", "with"]);
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
    const methodMatch = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/.exec(trimmed);
    const methodDeclaration = Boolean(methodMatch && !controlFlowKeywords.has(methodMatch[1]));
    const declaration = /\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(trimmed) ||
      /^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed) ||
      methodDeclaration ||
      /^(?:async\s+)?def\s+[A-Za-z_][\w]*\s*\(/.test(trimmed) ||
      /^(?:pub\s+)?(?:async\s+)?fn\s+[A-Za-z_][\w]*\s*\(/.test(trimmed);
    if (declaration) regions.push(index + 1);
  });
  return [...new Set(regions)].sort((left, right) => left - right);
}

function trackedImplementationRoots(workspaceRoot: string): Map<string, number[]> {
  const listing = execFileSync("git", ["-C", workspaceRoot, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const roots = new Map<string, number[]>();
  for (const relative of listing.split("\0").filter(Boolean)) {
    const normalized = relative.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!IMPLEMENTATION_EXTENSIONS.has(path.extname(normalized).toLowerCase())) continue;
    if (!isImplementationSourcePath(normalized)) continue;
    const absolute = path.resolve(workspaceRoot, ...normalized.split("/"));
    let stat: fs.Stats;
    try { stat = fs.lstatSync(absolute); }
    catch { continue; }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
    roots.set(normalized, callableRegionLines(fs.readFileSync(absolute, "utf8")));
  }
  return roots;
}

function canonicalImplementationRoot(
  value: string,
  workspaceRoot: string,
  rootIndex: Map<string, number[]>,
): { canonical?: string; error?: string } {
  const token = value.trim().split(/\s+/)[0]?.split("#")[0] ?? "";
  const match = /^(.+?)(?::L?(\d+)(?:-L?(\d+))?)?$/.exec(token);
  if (!match) return { error: `implementation root has an invalid physical locator: ${value}` };
  const filePart = match[1].replace(/^\.\//, "");
  if (!filePart || path.isAbsolute(filePart) || filePart.split("/").some((part) => part === ".." || !part)) {
    return { error: `implementation root is unsafe: ${value}` };
  }
  const regions = rootIndex.get(filePart);
  if (!regions) return { error: `implementation root must name a tracked source file: ${value}` };
  const absolute = path.resolve(workspaceRoot, ...filePart.split("/"));
  const relative = path.relative(workspaceRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: `implementation root escapes the workspace: ${value}` };
  }
  let stat: fs.Stats;
  try { stat = fs.lstatSync(absolute); }
  catch { return { error: `implementation root file does not exist: ${value}` }; }
  if (!stat.isFile()) return { error: `implementation root must name an existing regular file: ${value}` };
  if (!match[2]) return { canonical: `${filePart}:file` };
  const start = Number(match[2]);
  const end = Number(match[3] ?? match[2]);
  const lineCount = fs.readFileSync(absolute, "utf8").split(/\r?\n/).length;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lineCount) {
    return { error: `implementation root locator is outside the current file: ${value}` };
  }
  const preceding = [...regions].reverse().find((line) => line <= start) ?? 0;
  // A broad or differently sized range must not manufacture a novel root by
  // combining several callable declarations. The start location determines
  // the single physical region; all lines inside that region collapse here.
  return { canonical: `${filePart}:${preceding || "file"}` };
}

function nearestExactObligationId(value: string, candidates: Iterable<string>): string | null {
  let bestDistance = Number.POSITIVE_INFINITY;
  let best: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length !== value.length) continue;
    let distance = 0;
    for (let index = 0; index < value.length && distance <= 2; index += 1) {
      if (value[index] !== candidate[index]) distance += 1;
    }
    if (distance > 2 || distance > bestDistance) continue;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [candidate];
    } else {
      best.push(candidate);
    }
  }
  return bestDistance > 0 && bestDistance <= 2 && best.length === 1 ? best[0] : null;
}

function admissionFamilyDepth(cuts: AdmissionCut[]): Array<{ family: string; cuts: number; interactionProbes: number }> {
  const counts = new Map<string, number>();
  for (const cut of cuts) {
    const family = semanticTemplate(cut.family);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([family, cuts]) => ({ family, cuts, interactionProbes: cuts >= 3 ? 2 : cuts >= 2 ? 1 : 0 }))
    .sort((left, right) => right.cuts - left.cuts || left.family.localeCompare(right.family));
}

function admissionTotals(cuts: AdmissionCut[]): AdmissionTotals {
  const familyDepth = admissionFamilyDepth(cuts);
  return {
    TOTAL_CUTS: cuts.length,
    TOTAL_FAMILIES: new Set(cuts.map((cut) => semanticTemplate(cut.family))).size,
    TOTAL_OPERATIONS: new Set(cuts.flatMap((cut) => cut.operations.map((operation) => semanticTemplate(operation)))).size,
    TOTAL_DEEP_FAMILIES: familyDepth.filter((family) => family.cuts >= 2).length,
    TOTAL_CRITICAL_FAMILIES: familyDepth.filter((family) => family.cuts >= 3).length,
  };
}

function admissionDiagnostics(
  cuts: AdmissionCut[],
  manifest: FrontierVerificationManifest,
): NonNullable<ReviewFeedback["admissionDiagnostics"]> {
  const exactIds = new Set(manifest.contractObligations.map((obligation) => obligation.id));
  const assignedIds = new Set(cuts.flatMap((cut) => cut.obligationIds));
  return {
    missingObligationIds: manifest.contractObligations.map((obligation) => obligation.id)
      .filter((id) => !assignedIds.has(id)),
    unknownObligationIds: [...assignedIds].filter((id) => !exactIds.has(id)).sort(),
    oversizedCuts: cuts.flatMap((cut, index) => cut.obligationIds.length > manifest.frontierPolicy.maxObligationsPerCut
      ? [{
        index: index + 1,
        id: cut.id,
        obligations: cut.obligationIds.length,
        maximum: manifest.frontierPolicy.maxObligationsPerCut,
      }]
      : []),
    computedTotals: admissionTotals(cuts),
  };
}

function validateAdmissionEnvelope(cuts: AdmissionCut[], report: string): string[] {
  const errors: string[] = [];
  const totals = admissionTotals(cuts);
  for (const marker of ADMISSION_TOTAL_KEYS) {
    const matches = [...report.matchAll(new RegExp(`^${marker}=([0-9]+)$`, "gm"))];
    if (matches.length !== 1) errors.push(`admission report requires exactly one ${marker}`);
    else if (Number(matches[0][1]) !== totals[marker]) errors.push(`${marker} must equal ${totals[marker]}`);
  }
  const markerAt = report.indexOf("ADMISSION_CUTS_JSON=");
  const orderedTail = report.slice(0, markerAt).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5);
  const expectedTail = ADMISSION_TOTAL_KEYS.map((marker) => `${marker}=${totals[marker]}`);
  if (orderedTail.length !== expectedTail.length || orderedTail.some((line, index) => line !== expectedTail[index])) {
    errors.push("admission totals must be the five ordered lines immediately before ADMISSION_CUTS_JSON");
  }
  return errors;
}

function canonicalizeAdmissionEnvelope(report: string, cuts: AdmissionCut[]): string {
  const marker = "ADMISSION_CUTS_JSON=";
  const markerAt = report.indexOf(marker);
  if (markerAt < 0) return report;
  const totalLine = new RegExp(`^(?:${ADMISSION_TOTAL_KEYS.join("|")})=.*$`);
  const preamble = report.slice(0, markerAt).replaceAll("\r\n", "\n").split("\n")
    .filter((line) => !totalLine.test(line.trim()));
  while (preamble.length && !preamble[preamble.length - 1].trim()) preamble.pop();
  const totals = admissionTotals(cuts);
  return [
    ...preamble,
    ...ADMISSION_TOTAL_KEYS.map((key) => `${key}=${totals[key]}`),
    report.slice(markerAt).trim(),
  ].join("\n");
}

function minimumSafetyProbes(
  cuts: AdmissionCut[],
  changedHunks: number,
  manifest: FrontierVerificationManifest,
  regressionReplays = 0,
): number {
  const interactionProbes = admissionFamilyDepth(cuts)
    .reduce((total, family) => total + family.interactionProbes, 0);
  const pairedObligations = manifest.contractObligations.filter((obligation) => obligation.proofMode === "paired").length;
  const positiveObligations = manifest.contractObligations.length - pairedObligations;
  const obligationProbes = Math.ceil(pairedObligations / manifest.frontierPolicy.maxObligationsPerProbe) * 2 +
    Math.ceil(positiveObligations / manifest.frontierPolicy.maxObligationsPerProbe);
  return Math.max(
    changedHunks * 2,
    obligationProbes,
    cuts.length * 2 + interactionProbes + manifest.frontierPolicy.minCounterfactualFamilies + regressionReplays * 2,
  );
}

function parseAdmissionCuts(report: string): { cuts?: AdmissionCut[]; errors: string[] } {
  const marker = "ADMISSION_CUTS_JSON=";
  const first = report.indexOf(marker);
  if (first < 0 || report.indexOf(marker, first + marker.length) >= 0) {
    return { errors: ["admission report must contain exactly one ADMISSION_CUTS_JSON marker"] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(report.slice(first + marker.length).trim()); }
  catch { return { errors: ["ADMISSION_CUTS_JSON must be exact trailing JSON"] }; }
  if (!Array.isArray(parsed)) return { errors: ["ADMISSION_CUTS_JSON must be an array"] };
  const errors: string[] = [];
  const cuts: AdmissionCut[] = [];
  parsed.forEach((value, index) => {
    const label = `cut ${index + 1}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    const wanted = [...CUT_KEYS].sort();
    if (keys.length !== wanted.length || keys.some((key, keyIndex) => key !== wanted[keyIndex])) {
      errors.push(`${label} keys must be exactly ${wanted.join(", ")}`);
      return;
    }
    if (!bounded(row.id, 3, 120) || !/^[a-z0-9][a-z0-9._-]*$/.test(row.id)) errors.push(`${label} id invalid`);
    if (!bounded(row.family, 3, 160)) errors.push(`${label} family invalid`);
    if (!boundedList(row.operations, 2, 180, 24)) errors.push(`${label} operations invalid`);
    if (!boundedList(row.obligationIds, 12, 96, 128)) errors.push(`${label} obligationIds invalid`);
    if (!boundedList(row.contractCitations, 3, 500, 24)) errors.push(`${label} contractCitations invalid`);
    if (!boundedList(row.implementationRoots, 3, 320, 24)) errors.push(`${label} implementationRoots invalid`);
    if (!bounded(row.failureMode, 12, 1_000)) errors.push(`${label} failureMode invalid`);
    if (!bounded(row.positiveProbe, 12, 6_000)) errors.push(`${label} positiveProbe invalid`);
    if (!bounded(row.negativeProbe, 12, 6_000)) errors.push(`${label} negativeProbe invalid`);
    if (errors.some((error) => error.startsWith(label))) return;
    cuts.push(row as unknown as AdmissionCut);
  });
  return errors.length ? { errors } : { cuts, errors: [] };
}

function validateAdmissionCuts(
  cuts: AdmissionCut[],
  manifest: FrontierVerificationManifest,
  implementationRootIndex: Map<string, number[]>,
): string[] {
  const errors: string[] = [];
  const familyDepth = admissionFamilyDepth(cuts);
  const totals = admissionTotals(cuts);
  const { targetCuts, minFamilies, minOperations, minDeepFamilies, minCriticalFamilies } = manifest.frontierPolicy;
  if (cuts.length !== targetCuts) errors.push(`expected exactly ${targetCuts} cuts, received ${cuts.length}`);
  const normalized = (values: string[]) => new Set(values.map((value) => value.trim().toLowerCase())).size;
  if (normalized(cuts.map((cut) => cut.id)) !== cuts.length) errors.push("cut ids must be unique");
  if (totals.TOTAL_FAMILIES < minFamilies) errors.push(`requires at least ${minFamilies} causal families after numeric/hash alias normalization`);
  if (totals.TOTAL_OPERATIONS < minOperations) errors.push(`requires at least ${minOperations} causal operations after numeric/hash alias normalization`);
  if (totals.TOTAL_DEEP_FAMILIES < minDeepFamilies) errors.push(`requires at least ${minDeepFamilies} families with two or more cuts`);
  if (totals.TOTAL_CRITICAL_FAMILIES < minCriticalFamilies) errors.push(`requires at least ${minCriticalFamilies} families with three or more cuts`);
  if (normalized(cuts.map((cut) => cut.failureMode)) !== cuts.length) errors.push("failure modes must be unique");
  if (normalized(cuts.map((cut) => cut.positiveProbe)) !== cuts.length ||
    normalized(cuts.map((cut) => cut.negativeProbe)) !== cuts.length) errors.push("probe bodies must be unique");
  if (new Set(cuts.map((cut) => semanticTemplate(cut.failureMode))).size !== cuts.length) {
    errors.push("failure modes must not differ only by numeric or id labels");
  }
  if (new Set(cuts.map((cut) => semanticTemplate(cut.positiveProbe))).size !== cuts.length ||
    new Set(cuts.map((cut) => semanticTemplate(cut.negativeProbe))).size !== cuts.length) {
    errors.push("probe bodies must not differ only by numeric or id labels");
  }
  const obligationsById = new Map(manifest.contractObligations.map((obligation) => [obligation.id, obligation]));
  const obligationCoverage = new Map<string, number>();
  cuts.forEach((cut, index) => {
    if (cut.positiveProbe.trim() === cut.negativeProbe.trim()) errors.push(`cut ${index + 1} probes are identical`);
    if (numberedPlaceholder(cut.family)) errors.push(`cut ${index + 1} family is a numbered placeholder alias`);
    if (cut.operations.some(numberedPlaceholder)) errors.push(`cut ${index + 1} operation is a placeholder alias`);
    const roots = cut.implementationRoots.map((root) => canonicalImplementationRoot(root, manifest.workspaceRoot, implementationRootIndex));
    roots.forEach((root) => { if (root.error) errors.push(`cut ${index + 1} ${root.error}`); });
    if (cut.obligationIds.length > manifest.frontierPolicy.maxObligationsPerCut) {
      errors.push(`cut ${index + 1} exceeds ${manifest.frontierPolicy.maxObligationsPerCut} contract obligations`);
    }
    const citationPaths = new Set(cut.contractCitations.map((citation) =>
      contractPathForCitation(citation, contractSourcePaths(manifest))).filter((value): value is string => Boolean(value)));
    for (const obligationId of cut.obligationIds) {
      const obligation = obligationsById.get(obligationId);
      if (!obligation) {
        const nearest = nearestExactObligationId(obligationId, obligationsById.keys());
        errors.push(`cut ${index + 1} obligation is outside the exact atlas: ${obligationId}${nearest ? `; nearest exact atlas id: ${nearest}` : ""}`);
        continue;
      }
      obligationCoverage.set(obligationId, (obligationCoverage.get(obligationId) ?? 0) + 1);
      if (!obligation.sources.some((source) => citationPaths.has(source.path))) {
        errors.push(`cut ${index + 1} lacks a citation for obligation ${obligationId}`);
      }
    }
    for (const citation of cut.contractCitations) {
      const valid = contractSourcePaths(manifest).some((contractPath) =>
        citation === contractPath || citation.startsWith(`${contractPath}:`) || citation.startsWith(`${contractPath}#`) || citation.startsWith(`${contractPath} `));
      if (!valid) errors.push(`cut ${index + 1} citation is outside the tracked contract set: ${citation}`);
    }
  });
  for (const obligation of manifest.contractObligations) {
    const coverage = obligationCoverage.get(obligation.id) ?? 0;
    if (coverage === 0) errors.push(`contract obligation ${obligation.id} is not assigned to any cut`);
  }
  return errors.slice(0, 48);
}

const SAFETY_EVIDENCE_KEYS = [
  "id", "cutId", "hunkId", "kind", "command", "obligationIds", "contractCitation", "expected", "observed", "verdict",
] as const;

function contractPathForCitation(citation: unknown, contractPaths: string[]): string | null {
  if (typeof citation !== "string") return null;
  return contractPaths.find((contractPath) => citation === contractPath ||
    citation.startsWith(`${contractPath}:`) || citation.startsWith(`${contractPath}#`) ||
    citation.startsWith(`${contractPath} `)) ?? null;
}

function contractSourcePaths(manifest: FrontierVerificationManifest): string[] {
  return manifest.requestContract
    ? [...manifest.contractPaths, manifest.requestContract.sourcePath]
    : manifest.contractPaths;
}

function parseSafetyEvidence(
  report: string,
  fingerprint: FrontierDiffFingerprint,
  executedCommands: SuccessfulBashExecution[],
  manifest: FrontierVerificationManifest,
  admissionCuts: AdmissionCut[],
  regressionLedger: RegressionReplay[],
  markerName = "SAFETY_EVIDENCE_JSON",
  validateCoverage = true,
  allowedKinds?: Set<SafetyProbeEvidence["kind"]>,
): { evidence?: SafetyProbeEvidence[]; errors: string[] } {
  const markerPattern = new RegExp(`^${markerName}=(.*)$`, "gm");
  const matches = [...report.matchAll(markerPattern)];
  if (matches.length !== 1) return { errors: [`safety report requires exactly one single-line ${markerName}`] };
  let parsed: unknown;
  try { parsed = JSON.parse(matches[0][1].trim()); }
  catch { return { errors: [`${markerName} must be exact single-line JSON`] }; }
  if (!Array.isArray(parsed) || parsed.length > Math.max(512, fingerprint.changedHunks * 8)) {
    return { errors: [`${markerName} must be a bounded array`] };
  }
  const errors: string[] = [];
  const evidence: SafetyProbeEvidence[] = [];
  const hunkIds = new Set(fingerprint.hunks.map((hunk) => hunk.id));
  const cutsById = new Map(admissionCuts.map((cut) => [cut.id, cut]));
  parsed.forEach((value, index) => {
    const label = `probe ${index + 1}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    const expectedKeys = [...SAFETY_EVIDENCE_KEYS].sort();
    if (keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])) {
      errors.push(`${label} keys must be exactly ${expectedKeys.join(", ")}`);
      return;
    }
    if (!bounded(row.id, 3, 160) || !/^[a-z0-9][a-z0-9._-]*$/.test(row.id)) errors.push(`${label} id invalid`);
    const cut = typeof row.cutId === "string" ? cutsById.get(row.cutId) : undefined;
    if (!cut) errors.push(`${label} cutId is not in the exact admitted portfolio`);
    if (typeof row.hunkId !== "string" || !hunkIds.has(row.hunkId)) errors.push(`${label} hunkId is not in the exact diff`);
    if (row.kind !== "intended" && row.kind !== "non-regression" && row.kind !== "interaction" && row.kind !== "counterfactual" && row.kind !== "regression-replay" && row.kind !== "regression-generalization") errors.push(`${label} kind invalid`);
    if (!bounded(row.command, 2, 6_000)) errors.push(`${label} command invalid`);
    if (!boundedList(row.obligationIds, 12, 96, manifest.frontierPolicy.maxObligationsPerProbe)) {
      errors.push(`${label} obligationIds invalid or exceeds ${manifest.frontierPolicy.maxObligationsPerProbe}`);
    } else if (cut && row.obligationIds.some((id) => !cut.obligationIds.includes(id))) {
      errors.push(`${label} obligationIds are not contained by its admitted cut`);
    }
    const citedPath = contractPathForCitation(row.contractCitation, contractSourcePaths(manifest));
    const cutPaths = cut?.contractCitations.map((citation) => contractPathForCitation(citation, contractSourcePaths(manifest))).filter(Boolean) ?? [];
    if (!bounded(row.contractCitation, 3, 500) || !citedPath) {
      errors.push(`${label} contractCitation is outside the tracked contract set`);
    } else if (cut && !cutPaths.includes(citedPath)) {
      errors.push(`${label} contractCitation does not support its admitted cut`);
    }
    if (!bounded(row.expected, 8, 2_000)) errors.push(`${label} expected invalid`);
    if (!bounded(row.observed, 8, 2_000)) errors.push(`${label} observed invalid`);
    if (row.kind === "counterfactual" && (typeof row.observed !== "string" || !row.observed.includes("ORIGINAL_PASS_MUTANT_FAIL"))) {
      errors.push(`${label} counterfactual observed must include ORIGINAL_PASS_MUTANT_FAIL`);
    }
    if (row.kind === "regression-generalization" && (typeof row.observed !== "string" ||
      !/GENERALIZATION_(?:PASS|REGRESSION):replay-[a-f0-9]{16}/.test(row.observed))) {
      errors.push(`${label} regression generalization observed must name its replay with GENERALIZATION_PASS or GENERALIZATION_REGRESSION`);
    }
    if (row.verdict !== "PASS" && row.verdict !== "REGRESSION") errors.push(`${label} verdict invalid`);
    if (!errors.some((error) => error.startsWith(label))) {
      const probe = row as unknown as SafetyProbeEvidence;
      if (allowedKinds && !allowedKinds.has(probe.kind)) errors.push(`${label} kind is not permitted in ${markerName}`);
      else evidence.push(probe);
    }
  });
  if (validateCoverage) {
    if (new Set(evidence.map((probe) => probe.id)).size !== evidence.length) errors.push("safety probe ids must be unique");
  for (const hunk of fingerprint.hunks) {
    const probes = evidence.filter((probe) => probe.hunkId === hunk.id);
    if (probes.length < 2) errors.push(`hunk ${hunk.id} requires at least two structured probes`);
    if (!probes.some((probe) => probe.kind === "intended") || !probes.some((probe) => probe.kind === "non-regression")) {
      errors.push(`hunk ${hunk.id} requires intended and non-regression probes`);
    }
  }
  for (const cut of admissionCuts) {
    const probes = evidence.filter((probe) => probe.cutId === cut.id);
    if (probes.length < 2) errors.push(`cut ${cut.id} requires at least two structured probes`);
    if (!probes.some((probe) => probe.kind === "intended") || !probes.some((probe) => probe.kind === "non-regression")) {
      errors.push(`cut ${cut.id} requires intended and non-regression probes`);
    }
  }
  const obligationKinds = new Map<string, Set<string>>();
  for (const probe of evidence) {
    if (probe.kind !== "intended" && probe.kind !== "non-regression" && probe.kind !== "interaction") continue;
    for (const obligationId of probe.obligationIds) {
      const kinds = obligationKinds.get(obligationId) ?? new Set<string>();
      kinds.add(probe.kind);
      obligationKinds.set(obligationId, kinds);
    }
  }
  for (const obligation of manifest.contractObligations) {
    const kinds = obligationKinds.get(obligation.id);
    if (obligation.proofMode === "paired") {
      if (!kinds?.has("intended") || !kinds.has("non-regression")) {
        errors.push(`paired contract atom ${obligation.id} requires distinct intended and non-regression probes`);
      }
    } else if (!kinds?.has("intended") && !kinds?.has("non-regression") && !kinds?.has("interaction")) {
      errors.push(`positive contract atom ${obligation.id} lacks executable safety coverage`);
    }
  }
  const cutsByFamily = new Map<string, AdmissionCut[]>();
  for (const cut of admissionCuts) {
    const family = normalizedFamily(cut.family);
    const familyCuts = cutsByFamily.get(family) ?? [];
    familyCuts.push(cut);
    cutsByFamily.set(family, familyCuts);
  }
  for (const [family, familyCuts] of cutsByFamily) {
    const required = familyCuts.length >= 3 ? 2 : familyCuts.length >= 2 ? 1 : 0;
    if (!required) continue;
    const cutIds = new Set(familyCuts.map((cut) => cut.id));
    const interactions = evidence.filter((probe) => probe.kind === "interaction" && cutIds.has(probe.cutId));
    if (interactions.length < required) {
      errors.push(`family ${family} requires at least ${required} structured cross-cut interaction probes`);
    }
  }
  const counterfactualFamilies = new Set(evidence.filter((probe) => probe.kind === "counterfactual")
    .map((probe) => normalizedFamily(cutsById.get(probe.cutId)?.family ?? ""))
    .filter(Boolean));
  if (counterfactualFamilies.size < manifest.frontierPolicy.minCounterfactualFamilies) {
    errors.push(`requires counterfactual mutation kills across at least ${manifest.frontierPolicy.minCounterfactualFamilies} families`);
  }
  for (const replay of regressionLedger) {
    const matches = evidence.filter((probe) => probe.kind === "regression-replay" &&
      probe.cutId === replay.cutId && probe.command === replay.command &&
      probe.contractCitation === replay.contractCitation && probe.expected === replay.expected);
    if (matches.length !== 1) {
      errors.push(`mandatory regression replay ${replay.id} requires exactly one exact structured replay`);
    }
    const generalizations = evidence.filter((probe) => probe.kind === "regression-generalization" &&
      probe.cutId === replay.cutId && probe.command !== replay.command &&
      probe.contractCitation === replay.contractCitation && probe.expected === replay.expected &&
      probe.observed.includes(`:${replay.id}`));
    if (generalizations.length !== 1) {
      errors.push(`mandatory regression replay ${replay.id} requires exactly one distinct metamorphic generalization`);
    }
  }
  }
  const available = new Map<string, string[]>();
  executedCommands.forEach((execution) => {
    const outputs = available.get(execution.command) ?? [];
    outputs.push(execution.output);
    available.set(execution.command, outputs);
  });
  for (const probe of evidence) {
    const outputs = available.get(probe.command) ?? [];
    const generalizationMarker = probe.kind === "regression-generalization"
      ? /GENERALIZATION_(?:PASS|REGRESSION):replay-[a-f0-9]{16}/.exec(probe.observed)?.[0]
      : null;
    const matchingIndex = probe.kind === "counterfactual"
      ? outputs.findIndex((output) => output.includes("ORIGINAL_PASS_MUTANT_FAIL"))
      : generalizationMarker
        ? outputs.findIndex((output) => output.includes(generalizationMarker))
        : outputs.length ? 0 : -1;
    if (matchingIndex < 0) {
      errors.push(probe.kind === "counterfactual"
        ? `probe ${probe.id} lacks ORIGINAL_PASS_MUTANT_FAIL in its distinct successful bash output`
        : probe.kind === "regression-generalization"
          ? `probe ${probe.id} lacks its replay-bound GENERALIZATION marker in distinct successful bash output`
          : `probe ${probe.id} does not match a distinct successful bash execution`);
    } else {
      outputs.splice(matchingIndex, 1);
    }
  }
  if (evidence.length > executedCommands.length) errors.push("structured probe count exceeds successful bash executions");
  return { evidence, errors };
}

function parseChainSafetyReport(
  partialReport: string,
  integrationReport: string,
  fingerprint: FrontierDiffFingerprint,
  partialCommands: SuccessfulBashExecution[],
  integrationCommands: SuccessfulBashExecution[],
  manifest: FrontierVerificationManifest,
  admissionCuts: AdmissionCut[],
  regressionLedger: RegressionReplay[],
): { assessment?: SafetyAssessment; evidence?: SafetyProbeEvidence[]; errors: string[] } {
  const partial = parseSafetyEvidence(
    partialReport,
    fingerprint,
    partialCommands,
    manifest,
    admissionCuts,
    regressionLedger,
    "PARTIAL_SAFETY_EVIDENCE_JSON",
    false,
    new Set(["intended", "non-regression"]),
  );
  const integration = parseSafetyEvidence(
    integrationReport,
    fingerprint,
    integrationCommands,
    manifest,
    admissionCuts,
    regressionLedger,
    "SAFETY_EVIDENCE_JSON",
    false,
  );
  const mergedEvidence = [...(partial.evidence ?? []), ...(integration.evidence ?? [])];
  const localErrors = [
    ...partial.errors.map((error) => `first reviewer: ${error}`),
    ...integration.errors.map((error) => `second reviewer: ${error}`),
  ];
  const syntheticReport = integrationReport.replace(
    /^SAFETY_EVIDENCE_JSON=.*$/m,
    `SAFETY_EVIDENCE_JSON=${JSON.stringify(mergedEvidence)}`,
  );
  const combined = parseSafetyReport(
    syntheticReport,
    fingerprint,
    [...partialCommands, ...integrationCommands],
    manifest,
    admissionCuts,
    regressionLedger,
  );
  return {
    assessment: localErrors.length ? undefined : combined.assessment,
    evidence: combined.evidence ?? mergedEvidence,
    errors: [...new Set([...localErrors, ...combined.errors])],
  };
}

function parseSafetyReport(
  report: string,
  fingerprint: FrontierDiffFingerprint,
  executedCommands: SuccessfulBashExecution[],
  manifest: FrontierVerificationManifest,
  admissionCuts: AdmissionCut[],
  regressionLedger: RegressionReplay[],
): { assessment?: SafetyAssessment; evidence?: SafetyProbeEvidence[]; errors: string[] } {
  report = report.replaceAll("\r\n", "\n");
  const structured = parseSafetyEvidence(report, fingerprint, executedCommands, manifest, admissionCuts, regressionLedger);
  const markers = ["TOTAL_CHANGED_HUNKS", "TOTAL_REVIEWED_HUNKS", "TOTAL_PROBES", "TOTAL_REGRESSIONS"] as const;
  const errors: string[] = [...structured.errors];
  const values: Record<string, number> = {};
  const tail = report.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5);
  if (tail.length !== 5 || !markers.every((marker, index) => new RegExp(`^${marker}=[0-9]+$`).test(tail[index] || "")) ||
    !/^SAFETY_VERDICT=(SAFE|UNSAFE)$/.test(tail[4] || "")) {
    errors.push("safety report must end with the four ordered totals and SAFETY_VERDICT");
  }
  for (const marker of markers) {
    const matches = [...report.matchAll(new RegExp(`^${marker}=([0-9]+)$`, "gm"))];
    if (matches.length !== 1) errors.push(`safety report requires exactly one ${marker}`);
    else values[marker] = Number(matches[0][1]);
  }
  const verdicts = [...report.matchAll(/^SAFETY_VERDICT=(SAFE|UNSAFE)$/gm)];
  if (verdicts.length !== 1) errors.push("safety report requires exactly one SAFETY_VERDICT");
  if (errors.length && (!structured.evidence || errors.some((error) => !error.startsWith("safety report")))) {
    return { evidence: structured.evidence, errors };
  }
  const assessment: SafetyAssessment = {
    changedHunks: values.TOTAL_CHANGED_HUNKS,
    reviewedHunks: values.TOTAL_REVIEWED_HUNKS,
    probes: values.TOTAL_PROBES,
    regressions: values.TOTAL_REGRESSIONS,
    verdict: verdicts[0][1] as "SAFE" | "UNSAFE",
  };
  if (assessment.changedHunks !== fingerprint.changedHunks) errors.push(`reviewer reported ${assessment.changedHunks} hunks; expected ${fingerprint.changedHunks}`);
  if (assessment.reviewedHunks !== fingerprint.changedHunks) errors.push(`reviewed hunks must equal ${fingerprint.changedHunks}`);
  const minimumProbes = minimumSafetyProbes(admissionCuts, fingerprint.changedHunks, manifest, regressionLedger.length);
  if (assessment.probes < minimumProbes) errors.push(`requires at least ${minimumProbes} probes`);
  if (structured.evidence && assessment.probes !== structured.evidence.length) errors.push(`TOTAL_PROBES must equal ${structured.evidence.length} structured evidence records`);
  const structuredRegressions = structured.evidence?.filter((probe) => probe.verdict === "REGRESSION").length ?? 0;
  if (structured.evidence && assessment.regressions !== structuredRegressions) errors.push(`TOTAL_REGRESSIONS must equal ${structuredRegressions}`);
  if (assessment.verdict === "SAFE" && assessment.regressions !== 0) errors.push("SAFE requires zero regressions");
  if (assessment.verdict === "UNSAFE" && assessment.regressions < 1) errors.push("UNSAFE requires at least one regression");
  return { assessment, evidence: structured.evidence, errors };
}

export default function frontierGate(pi: ExtensionAPI) {
  if (process.env.CODARA_PI_EXECUTION_POLICY !== "frontier" || process.env.SPARK_MCP_MODE !== "execute") return;
  const manifestPath = process.env.CODARA_PI_FRONTIER_MANIFEST?.trim();
  const manifestSha256 = process.env.CODARA_PI_FRONTIER_MANIFEST_SHA256?.trim();
  if (!manifestPath || !manifestSha256) throw new Error("Cora Frontier manifest environment is incomplete");
  const manifest: FrontierVerificationManifest = loadFrontierVerificationManifest(manifestPath, manifestSha256);
  type ContractDrift = { expected: string; actual: string; detectedAt: string };
  let contractDrift: ContractDrift | null = null;
  const detectContractDrift = (): ContractDrift | null => {
    if (!manifest.contractTreeSha256) return null;
    let actual: string;
    try {
      actual = contractWorkspaceTreeSha256(manifest.workspaceRoot, manifest.contractPaths) ?? "unavailable";
    } catch {
      actual = "unavailable";
    }
    if (actual === manifest.contractTreeSha256) return null;
    contractDrift ??= {
      expected: manifest.contractTreeSha256,
      actual,
      detectedAt: new Date().toISOString(),
    };
    return contractDrift;
  };
  const contractDriftText = (drift: ContractDrift) =>
    `${CONTRACT_DRIFT_MARKER} restart_required=true expected=${drift.expected} actual=${drift.actual}`;
  const admissionArtifactPath = process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT?.trim();
  const admissionArtifactSha256 = process.env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256?.trim();
  if (Boolean(admissionArtifactPath) !== Boolean(admissionArtifactSha256)) {
    throw new Error("Cora Frontier admission artifact environment is incomplete");
  }
  const admissionArtifact = admissionArtifactPath && admissionArtifactSha256
    ? loadFrontierAdmissionArtifact(admissionArtifactPath, admissionArtifactSha256, manifest)
    : null;
  const cwdRelativeToRoot = path.relative(manifest.workspaceRoot, process.cwd());
  if (cwdRelativeToRoot === ".." || cwdRelativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(cwdRelativeToRoot)) {
    throw new Error("Cora Frontier workspace root does not contain Pi's working directory");
  }
  const admissionArtifactLaunchFingerprint = admissionArtifact
    ? frontierDiffFingerprint(manifest.workspaceRoot)
    : null;
  const {
    targetCuts, minFamilies, minOperations, minDeepFamilies, minCriticalFamilies,
    maxObligationsPerCut, maxObligationsPerProbe, minCounterfactualFamilies,
  } = manifest.frontierPolicy;
  const implementationRootIndex = trackedImplementationRoots(manifest.workspaceRoot);
  const availableImplementationRegions = [...implementationRootIndex.values()]
    .reduce((total, regions) => total + regions.length, 0);
  const contractPathSample = contractSourcePaths(manifest).slice(0, 512);
  const admissionTraceTask = [
    "Trace the repository's documented contract to causal implementation roots for Frontier admission.",
    `The manifest contains ${manifest.contractPaths.length} tracked contract paths${manifest.requestContract ? " plus the signed live user request" : ""}; inspect every signed obligation and relevant public tests directly. The live request is authoritative contract evidence and must be reconciled with tracked documentation before declaring a blocker.`,
    `The signed request contains a contractObligations atlas with ${manifest.contractObligations.length} content-addressed semantic atoms. Account for every exact obligation id; do not sample, merge comma-list members back together, or replace atoms with reviewer-selected themes.`,
    `CONTRACT_PATH_SAMPLE=${JSON.stringify(contractPathSample)}`,
    `Produce at least ${targetCuts + 4} evidence-backed candidate cuts across at least ${minFamilies} behavioral families and ${minOperations} distinct operations.`,
    "Keep the complete tracer handoff below 48,000 UTF-8 bytes: use compact cut records and omit repeated prose. The auditor has the full signed atlas and repository, so do not paste contract text or mechanically enumerate the atlas outside the compact candidate mapping.",
    `Rank families by contract complexity, failure blast radius, statefulness, concurrency, persistence, lifecycle, precedence, and cross-operation coupling. Preserve at least ${minDeepFamilies} families with two or more genuinely different cuts and at least ${minCriticalFamilies} highest-risk families with three or more cuts.`,
    "Do not split one behavioral family into aliases to fake breadth. A repeated family name is intentional depth and its cuts must exercise non-overlapping invariants.",
    `Each candidate needs 1-${maxObligationsPerCut} exact obligationIds, matching signed-contract citations, implementation roots, a distinct failure mode, and minimally different executable positive and negative probes. Treat every atom independently: a probe for one list member never proves a sibling atom.`,
    "Also test whether every demanded invariant is jointly satisfiable and observable from the exact public/storage shapes the same contract requires. Flag a possible contradiction, lost witness, or two indistinguishable valid worlds explicitly; never invent a blocker merely because implementation is difficult.",
    "Return the complete evidence report to the auditor. Do not emit the final machine payload.",
  ].join("\n");
  const admissionAuditTask = [
    "Independently audit the tracer report below against the repository. Reread contracts, public tests, and implementation; reject invented, duplicate, or already-proved cuts.",
    "",
    "TRACER_REPORT_BEGIN",
    "{previous}",
    "TRACER_REPORT_END",
    "",
    "MACHINE_ADMISSION_CONTRACT",
    `Select exactly ${targetCuts} cuts, at least ${minFamilies} normalized families, and at least ${minOperations} normalized operations.`,
    `At least ${minDeepFamilies} normalized families must have two or more cuts; at least ${minCriticalFamilies} highest-risk families must have three or more cuts. Rank risk from the tracked contract and implementation, not from family-name wording.`,
    "Keep the exact same normalized family string for related cuts; reject aliases that disguise one family as several. Family and operation breadth is computed after numeric and hash labels are stripped, so labels such as `surface conformance 1` and `surface conformance 2` count as one family. Cuts within a deep family must target different invariants, transitions, or failure boundaries.",
    "Every family and operation label must name concrete behavior. Numbered frontier/slice/cut/contract/family aliases and op:/operation-N placeholders are machine-rejected.",
    "Every cut id must match ^[a-z0-9][a-z0-9._-]*$: lowercase ASCII only, beginning with a letter or digit, with no uppercase characters.",
    `Each implementation root must begin with a tracked non-test source file and may use only a real in-range :line or :line-line locator before any description. Test/spec/fixture files are rejected. Fragment/description suffixes, broad ranges, and different lines inside one callable region do not create a new root. This workspace exposes ${availableImplementationRegions} physical callable/file regions. Reuse the same canonical root whenever behavior is genuinely centralized; never cite an unrelated region merely to manufacture breadth.`,
    "Every id, failure mode, positive probe, and negative probe must be distinct. Failure modes and probes are also normalized by removing numeric and hash labels; numbered slice templates therefore do not count as distinct causal evidence.",
    "Every contract citation must begin with an exact signed contract source path, optionally followed by :line, #anchor, or a space and locator. The reserved .codara/__codara_user_request__.md source denotes the immutable live request embedded in the signed manifest; it is not a workspace file.",
    `Map every one of the ${manifest.contractObligations.length} semantic-atom ids across the final cuts. No atom may be omitted, merged with a sibling, or represented by a probe that exercises only another member of its source sentence; every assigned atom must share a tracked path with that cut's citations. Reuse an id only when genuinely different failure boundaries depend on the same atom.`,
    `The signed contract source sample is ${JSON.stringify(contractPathSample)}; inspect the repository and signed manifest for the complete set if the manifest count exceeds the sample.`,
    "Before selecting cuts, independently audit any tracer claim that the contract is contradictory, underdetermined, or unobservable. A genuine blocker requires a mathematical two-world or incompatible-clause argument, not implementation difficulty. Always reconcile the signed live request before declaring a blocker. For a two-world blocker, run one non-mutating Bash witness that reads every cited tracked path and, when present, reads requestContract.text from process.env.CODARA_PI_FRONTIER_MANIFEST, constructs the worlds, derives all digests at runtime, and exits nonzero unless SAME_OBSERVABLE and INCOMPATIBLE_OUTCOMES are both true.",
    `Only if the contract itself cannot be jointly implemented or verified, replace all totals/cuts with exactly one trailing CONTRACT_BLOCKER_JSON object using keys ${CONTRACT_BLOCKER_KEYS.join(", ")}. class is contradiction, underdetermined, or unobservable; indistinguishableWorlds and incompatibleOutcomes each contain exactly two detailed strings; minimalResolutions contains 2-4 contract-level repairs. When a signed live request exists, every blocker must cite and reconcile it; the witness reads its exact text from CODARA_PI_FRONTIER_MANIFEST. witnessCommand must exactly match the successful Bash call, visibly use createHash, sha256sum, or openssl dgst, name every cited contract source, and must not embed any reported 64-hex digest. Its output includes exactly one CONTRACT_BLOCKER_WITNESS=<content-addressed-id>, SAME_OBSERVABLE=true, INCOMPATIBLE_OUTCOMES=true, one CITED_CONTRACT_SHA256=<actual-source-sha256> <exact-path> for every unique cited source, equal OBSERVABLE_A_SHA256/OBSERVABLE_B_SHA256 values, and distinct REQUIRED_OUTCOME_A_SHA256/REQUIRED_OUTCOME_B_SHA256 values. Compute id as blocker- plus the first 20 hex characters of SHA-256 over canonical key-sorted JSON of every field except id and witnessCommand; excluding the command avoids a circular id literal while its exact execution is bound separately. Do not emit ADMISSION_CUTS_JSON in this path.`,
    `End with these exact ordered fields, using real totals:\nTOTAL_CUTS=${targetCuts}\nTOTAL_FAMILIES=<integer>\nTOTAL_OPERATIONS=<integer>\nTOTAL_DEEP_FAMILIES=<integer>\nTOTAL_CRITICAL_FAMILIES=<integer>`,
    "Then emit exactly one final ADMISSION_CUTS_JSON=<json-array> line and no text after it.",
    `Every JSON object must have exactly these keys: ${CUT_KEYS.join(", ")}.`,
  ].join("\n");
  const admissionRequestBasePath = manifestPath.replace(/\.json$/i, ".admission-request.json");
  let admissionCorrection: { feedback: ReviewFeedback; rejectedReport: string } | null = null;
  const createAdmissionReviewPlan = (): ManagedAdmissionReviewPlan => {
    const attempt = admissionCorrection?.feedback.attempt ?? 1;
    const requestPath = attempt === 1
      ? admissionRequestBasePath
      : manifestPath.replace(/\.json$/i, `.admission-request.attempt-${attempt}.json`);
    if (admissionCorrection) {
      const correctionTask = [
        "Correct the previously rejected Frontier admission report against the repository and the exact machine feedback below.",
        `VALIDATOR_FEEDBACK_JSON=${JSON.stringify(admissionCorrection.feedback)}`,
        "Every listed validator error is mandatory. Preserve valid distinct cuts, but repair every rejected field, total, citation, family allocation, and primary-root allocation.",
        `The signed request retains all ${manifest.contractObligations.length} exact contractObligations. Reconcile the replacement report against the entire atlas, not only the validator's truncated error list.`,
        "When VALIDATOR_FEEDBACK_JSON contains admissionDiagnostics, its missingObligationIds and unknownObligationIds arrays are complete rather than truncated samples. Use them as a mechanical repair ledger, while preserving their source-path/cut semantics.",
        `Treat the replacement as one constrained packing problem: emit exactly ${targetCuts} cuts, each carrying 1-${maxObligationsPerCut} exact obligationIds, with at least ${minFamilies} normalized families, ${minOperations} normalized operations, ${minDeepFamilies} families containing two or more cuts, and ${minCriticalFamilies} families containing three or more cuts.`,
        "Canonical primary-root reuse is allowed when the implementation genuinely centralizes behavior. Do not spread cuts across unrelated regions to appear diverse, and do not rename, resize, or suffix the same physical location to imply distinct roots.",
        "Family/operation labels must describe behavior rather than numbered frontier/slice/cut/contract aliases. Family and operation breadth is recounted after numeric and hash labels are removed; numbered variants of the same phrase collapse to one. Every implementation root must resolve to a tracked non-test source file with an optional real in-range line locator; test/spec/fixture paths, broad ranges, #slice, and description suffixes never create root diversity. Failure and probe bodies must remain distinct after numeric and hash labels are removed.",
        `Before responding, parse your own final JSON and mechanically recount: cuts=${targetCuts}; atlas coverage=${manifest.contractObligations.length}; every cut bounded; no unknown or omitted id; every root resolves to a causal tracked non-test source region; family/operation/depth minima satisfied; and every printed total derived from that exact array.`,
        "Do not merely rename duplicate roots or families. Reread the cited contract and implementation where needed, then emit a complete replacement report.",
        "Every successful Bash execution from the rejected attempt has been deliberately discarded. A replacement CONTRACT_BLOCKER_JSON must execute its final exact witnessCommand again during this correction turn, even if that command text was already reported or run previously. Do not merely copy a prior witness transcript.",
        "For a blocker correction, work in this order: finalize all semantic blocker fields; compute the content-addressed id without id/witnessCommand; construct the final command using that id and the exact required marker names; execute that exact command once; verify its output; then copy the byte-identical command into witnessCommand. The output names are exactly CITED_CONTRACT_SHA256, OBSERVABLE_A_SHA256, OBSERVABLE_B_SHA256, REQUIRED_OUTCOME_A_SHA256, and REQUIRED_OUTCOME_B_SHA256—aliases do not replace them.",
        "REJECTED_REPORT_BEGIN",
        admissionCorrection.rejectedReport,
        "REJECTED_REPORT_END",
        "If the rejected report attempted CONTRACT_BLOCKER_JSON, repair every blocker field, citation, content-addressed id, and current-turn executable witness binding; retain that path only if the contract—not the implementation—is demonstrably impossible or unobservable. Otherwise use the normal cut portfolio.",
        "End with either one exact trailing CONTRACT_BLOCKER_JSON=<json-object> line, or the ordered TOTAL_CUTS, TOTAL_FAMILIES, TOTAL_OPERATIONS, TOTAL_DEEP_FAMILIES, TOTAL_CRITICAL_FAMILIES fields followed by exactly one ADMISSION_CUTS_JSON=<json-array> line. No text may follow either payload.",
        `Every JSON object must have exactly these keys: ${CUT_KEYS.join(", ")}.`,
      ].join("\n");
      const requestSha256 = writeManagedRequest(requestPath, {
        schemaVersion: 1,
        kind: "frontier-admission-v12-correction",
        manifestSha256,
        workspaceRoot: manifest.workspaceRoot,
        contractObligations: manifest.contractObligations,
        feedback: admissionCorrection.feedback,
        correctionTask,
      });
      return {
        attempt,
        mode: "single",
        agents: ["cora-frontier-contract-auditor"],
        input: {
          agent: "cora-frontier-contract-auditor",
          task: requestTask("admission-correction", requestPath, requestSha256, "correctionTask"),
          agentScope: "user",
          confirmProjectAgents: false,
          cwd: manifest.workspaceRoot,
        },
        requestPath,
        requestSha256,
      };
    }
    const requestSha256 = writeManagedRequest(requestPath, {
      schemaVersion: 1,
      kind: "frontier-admission-v12",
      manifestSha256,
      workspaceRoot: manifest.workspaceRoot,
      contractObligations: manifest.contractObligations,
      tracerTask: admissionTraceTask,
      auditorTask: admissionAuditTask,
    });
    return {
      attempt,
      mode: "chain",
      agents: ["cora-frontier-contract-tracer", "cora-frontier-contract-auditor"],
      input: {
        chain: [
          {
            agent: "cora-frontier-contract-tracer",
            task: requestTask("admission-tracer", requestPath, requestSha256, "tracerTask"),
          },
          {
            agent: "cora-frontier-contract-auditor",
            task: requestTask("admission-auditor", requestPath, requestSha256, "auditorTask", true),
          },
        ],
        agentScope: "user",
        confirmProjectAgents: false,
        cwd: manifest.workspaceRoot,
      },
      requestPath,
      requestSha256,
    };
  };
  let managedAdmissionReviewPlan = createAdmissionReviewPlan();
  const evidencePath = manifestPath.replace(/\.json$/i, ".evidence.json");
  let baselineVerified = false;
  let baselineEvidence: CommandEvidence[] = [];
  let admissionReviewToolCallId: string | null = null;
  let admissionReviewFingerprint: FrontierDiffFingerprint | null = null;
  let admissionReport: string | null = null;
  let admissionReviewExecutions: SuccessfulBashExecution[] = [];
  let admissionBlocker: ContractBlocker | null = null;
  let admissionBlockerWitness: { command: string; outputSha256: string; output: string } | null = null;
  let admissionCuts: AdmissionCut[] = [];
  let admissionVerified = false;
  let admissionSource: "cache" | "managed-review" | null = null;
  let admissionReviewHistory: AdmissionReviewAttempt[] = [];
  let admissionReviewExhausted = false;
  let finalEvidence: CommandEvidence[] = [];
  let finalFingerprint: FrontierDiffFingerprint | null = null;
  let safetyReviewToolCallId: string | null = null;
  let safetyReviewFingerprint: FrontierDiffFingerprint | null = null;
  let safetyReport: string | null = null;
  let safetyAssessment: SafetyAssessment | null = null;
  let safetyEvidence: SafetyProbeEvidence[] = [];
  let regressionLedger: RegressionReplay[] = [];
  let safetyReviewHistory: SafetyReviewAttempt[] = [];
  let safetyCorrection: ReviewFeedback | null = null;
  let safetyRejectedReport: string | null = null;
  let safetyReviewExhausted = false;
  let managedSafetyReviewPlan: ManagedSafetyReviewPlan | null = null;
  let finalSafeFingerprint: FrontierDiffFingerprint | null = null;
  let verificationSequence = 0;

  const compactCut = (cut: AdmissionCut) => ({
    id: cut.id,
    family: cut.family,
    operations: cut.operations,
    obligationIds: cut.obligationIds,
    contractCitations: cut.contractCitations,
  });

  const safetyReviewPlan = (fingerprint: FrontierDiffFingerprint) => {
    const attempt = safetyCorrection?.attempt ?? 1;
    const planKey = hash(canonicalJson({
      fingerprint,
      regressionLedger,
      safetyCorrection,
      rejectedReportSha256: safetyRejectedReport ? hash(safetyRejectedReport) : null,
    }));
    if (managedSafetyReviewPlan?.key === planKey) return managedSafetyReviewPlan;
    const familyDepth = admissionFamilyDepth(admissionCuts);
    const deepNames = new Set(familyDepth.filter((family) => family.cuts >= 2).map((family) => family.family));
    const deepCuts = admissionCuts.filter((cut) => deepNames.has(semanticTemplate(cut.family)));
    const singletonCuts = admissionCuts.filter((cut) => !deepNames.has(semanticTemplate(cut.family)));
    const minimumProbes = minimumSafetyProbes(admissionCuts, fingerprint.changedHunks, manifest, regressionLedger.length);
    const compactReplays = regressionLedger.map((replay) => ({
      id: replay.id,
      cutId: replay.cutId,
      command: replay.command,
      contractCitation: replay.contractCitation,
      expected: replay.expected,
      firstObserved: replay.firstObserved,
    }));
    const feedbackContract = safetyCorrection
      ? [
        `VALIDATOR_FEEDBACK_JSON=${JSON.stringify(safetyCorrection)}`,
        "This is a corrective review. Every listed validator error is mandatory and must be visibly repaired in the replacement report.",
        "safetyDiagnostics.allErrors and every derived diagnostics array are complete machine-computed sets, not truncated display samples. Repair every listed item in this one replacement attempt.",
        "For each safetyDiagnostics.unmatchedProbes entry, either rerun that record's exact command in its own successful Bash call owned by the named reviewer, or replace the record and command together. Never batch multiple evidence records behind one call.",
        "The signed request's rejectedReport field contains the complete rejected report. Treat it as a repair ledger: preserve every structurally valid record and its atom/hunk polarity, while repairing or splitting only invalid records.",
        `Rerun every retained command as a distinct successful Bash call in this correction attempt. Never cite an earlier attempt's execution. Split every overpacked record into records carrying at most ${maxObligationsPerProbe} obligationIds, with a separate assertion and Bash call for each resulting record.`,
        "Before responding, compare the replacement report against rejectedReport and confirm that no previously covered cut, hunk, semantic atom, polarity, interaction, counterfactual family, or regression replay was dropped.",
      ]
      : [];
    const finalContract = [
      `The final combined report must cover all ${admissionCuts.length} admitted cuts and all exact hunks with at least ${minimumProbes} distinct successful bash calls.`,
      `Every proofMode=paired semantic atom requires its own distinct kind intended probe and its own minimally different kind non-regression counterexample; proofMode=positive atoms require at least one executable record. Each record may carry at most ${maxObligationsPerProbe} obligationIds, all contained by its cut. A command exercising one atom cannot be relabeled as evidence for a sibling atom.`,
      "Every cut requires kind intended and kind non-regression. Every family with two cuts requires at least one additional kind interaction probe; every family with three or more cuts requires at least two.",
      "Each interaction probe must exercise two or more cuts or operations from that family in one scenario; a renamed single-cut probe is invalid.",
      `Run kind counterfactual probes for at least ${minCounterfactualFamilies} distinct admitted families. Each must copy the relevant source to a temporary directory outside the workspace, introduce one plausible minimal semantic mutation, run the same focused oracle against original and mutant, and prove original PASS plus mutant FAIL. Its successful bash output and observed field must both contain the literal ORIGINAL_PASS_MUTANT_FAIL.`,
      `MANDATORY_REGRESSION_REPLAYS_JSON=${JSON.stringify(compactReplays)}`,
      "Run every mandatory replay's exact command again. Preserve its exact cutId, contractCitation, and expected text in one kind regression-replay record. A replay that still fails is REGRESSION and forces UNSAFE.",
      "For every mandatory replay, also design and execute exactly one distinct kind regression-generalization probe. Change at least one non-semantic literal, identifier, digest, ordering, or boundary from the saved command while preserving the same contract expectation, cutId, and citation. Its observed field and successful Bash output must contain GENERALIZATION_PASS:<replay-id> when repaired or GENERALIZATION_REGRESSION:<replay-id> when the bug family survives. Never blacklist the saved example's literal value, repeated-character shape, id, or command text; repair and probe the causal invariant.",
      "Do not modify tracked or nonignored files. Retain every reproduced regression from either reviewer and report UNSAFE; never average failures away.",
      `Before the totals, emit exactly one single-line SAFETY_EVIDENCE_JSON=<json-array> using exactly these keys: ${SAFETY_EVIDENCE_KEYS.join(", ")}. In a single review it contains the complete evidence. In a chain it contains only the second reviewer's new records; the parent gate validates and merges the first reviewer's partial records deterministically.`,
      "Every record id must be unique lowercase ASCII matching ^[a-z0-9][a-z0-9._-]{2,159}$. expected and observed must each contain 8-2000 characters; contractCitation 3-500; command 2-6000. Never use e1/e2-style two-character ids or one-word observed summaries such as PASS/ok/not.",
      "For every evidence.command, copy the complete command string from that successful bash tool call's command argument byte-for-byte. Labels, summaries, placeholders, angle-bracket text, `node heredoc`, and shortened commands are invalid. Design commands shorter than 6000 characters up front.",
      "Before responding, reconcile every evidence.command one-to-one against this reviewer's actual successful bash tool-call history; no one call may support two records and a chain reviewer may not claim the other reviewer's execution.",
      "Use kind intended, non-regression, interaction, counterfactual, regression-replay, or regression-generalization; verdict PASS or REGRESSION; one exact cutId and hunkId; bounded exact obligationIds; a tracked citation whose path is present in that cut's contractCitations; and concrete expected/observed behavior. TOTAL_PROBES must equal the machine-combined record count: the JSON array length in single mode, or the first partial length plus the second JSON array length in chain mode.",
      "Before responding, verify that every paired semantic atom—not merely every admitted cut—has its own intended and non-regression records, and that every deep family has its full interaction quota. The non-regression command must exercise the atom's complement, rejection, precedence, or boundary rather than repeat its intended command. Do not trade one atom, cut, or family quota for another.",
      "End with exactly these five ordered lines and no text after them:",
      `TOTAL_CHANGED_HUNKS=${fingerprint.changedHunks}`,
      `TOTAL_REVIEWED_HUNKS=${fingerprint.changedHunks}`,
      "TOTAL_PROBES=<integer>",
      "TOTAL_REGRESSIONS=<integer>",
      "SAFETY_VERDICT=SAFE|UNSAFE",
    ];
    const common = [
      `DIFF_SHA256=${fingerprint.sha256}`,
      `CHANGED_HUNKS=${fingerprint.changedHunks}`,
      `UNTRACKED_FILES=${fingerprint.untrackedFiles}`,
      `EXACT_HUNKS=${JSON.stringify(fingerprint.hunks)}`,
    ];
    if (!deepCuts.length) {
      const singleTask = [
        "Independently audit and attempt to falsify the exact current Frontier diff.",
        ...feedbackContract,
        ...common,
        `ADMITTED_CUTS_JSON=${JSON.stringify(admissionCuts.map(compactCut))}`,
        `Inspect every changed hunk, every admitted causal cut, and affected callers. Run at least ${minimumProbes} focused probes as separate bash tool calls.`,
        ...finalContract,
      ].join("\n");
      const requestPath = manifestPath.replace(
        /\.json$/i,
        `.safety-${verificationSequence}-${fingerprint.sha256.slice(0, 16)}.attempt-${attempt}.request.json`,
      );
      const requestSha256 = writeManagedRequest(requestPath, {
        schemaVersion: 1,
        kind: "frontier-safety-v7-single",
        manifestSha256,
        workspaceRoot: manifest.workspaceRoot,
        fingerprint,
        regressionLedger,
        contractObligations: manifest.contractObligations,
        feedback: safetyCorrection,
        rejectedReport: safetyCorrection ? safetyRejectedReport : null,
        singleTask,
      });
    managedSafetyReviewPlan = {
        key: planKey,
        attempt,
        mode: "single" as const,
        agents: ["cora-frontier-diff-auditor"],
        input: {
          agent: "cora-frontier-diff-auditor",
          task: requestTask("safety-single", requestPath, requestSha256, "singleTask"),
          agentScope: "user",
          confirmProjectAgents: false,
          cwd: manifest.workspaceRoot,
        },
        requestPath,
        requestSha256,
      };
      return managedSafetyReviewPlan;
    }
    const partialReportPath = manifestPath.replace(
      /\.json$/i,
      `.safety-${verificationSequence}-${fingerprint.sha256.slice(0, 16)}.attempt-${attempt}.partial.txt`,
    );
    try { fs.unlinkSync(partialReportPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const familyTask = [
      "Act as the first read-only specialist in a two-reviewer Frontier safety chain. Falsify every cut in the risk-weighted deep families against the exact frozen diff.",
      ...feedbackContract,
      ...common,
      `DEEP_FAMILIES_JSON=${JSON.stringify(familyDepth.filter((family) => family.cuts >= 2))}`,
      `DEEP_CUTS_JSON=${JSON.stringify(deepCuts.map(compactCut))}`,
      `Run polarity-complete evidence for every semantic atom assigned to the supplied deep cuts: proofMode=paired atoms need intended and minimally different non-regression coverage; positive atoms need intended coverage. One command may bundle at most ${maxObligationsPerProbe} tightly related atoms only when it contains a separate assertion for every listed id. Inspect affected callers and exercise boundaries, precedence, failure atomicity, restart, lifecycle, and concurrency where the contract supports them.`,
      "Do not run the cross-family interaction quota; the second reviewer owns it. Do not modify the repository. The one authorized write is the exact external partial-report artifact named below.",
      "Every record id must be unique lowercase ASCII matching ^[a-z0-9][a-z0-9._-]{2,159}$. expected and observed must each contain 8-2000 characters; contractCitation 3-500; command 2-6000. Never use e1/e2-style two-character ids or one-word observed summaries such as PASS/ok/not.",
      `Build a UTF-8 report containing exactly one PARTIAL_SAFETY_EVIDENCE_JSON=<json-array> line using records with exactly these keys: ${SAFETY_EVIDENCE_KEYS.join(", ")}. Use only kind intended or non-regression and preserve every regression. No final totals or SAFETY_VERDICT belong in this partial report.`,
      `Use the write tool once to write that complete report to this exact authorized external path: ${partialReportPath}`,
      "Then use Bash to compute the exact SHA-256 and byte count of that file. Your final response must contain exactly these three ordered pointer lines and no report bytes or other text:",
      `PARTIAL_SAFETY_REPORT_PATH=${partialReportPath}`,
      "PARTIAL_SAFETY_REPORT_SHA256=<lowercase-sha256>",
      "PARTIAL_SAFETY_REPORT_BYTES=<integer>",
    ].join("\n");
    const integrationTask = [
      "Act as the second independent reviewer and final integrator for the exact frozen Frontier diff.",
      ...feedbackContract,
      ...common,
      `ALL_ADMITTED_CUTS_JSON=${JSON.stringify(admissionCuts.map(compactCut))}`,
      `SINGLETON_CUTS_JSON=${JSON.stringify(singletonCuts.map(compactCut))}`,
      `DEEP_FAMILY_INTERACTION_REQUIREMENTS=${JSON.stringify(familyDepth.filter((family) => family.interactionProbes > 0))}`,
      `The first reviewer completes before you and writes ${partialReportPath}, but its response is deliberately not copied into your task or process arguments. Use one Bash call to compute that exact file's SHA-256 and byte count, with both values visible in the successful output, then read that exact authorized file. Do not alter it or read any sibling external path.`,
      "Before SAFETY_EVIDENCE_JSON, emit exactly one FIRST_REVIEWER_REPORT_SHA256=<lowercase-sha256> line and one FIRST_REVIEWER_REPORT_BYTES=<integer> line matching that successful path-bound Bash call. The parent independently validates both values against the first reviewer's pointer and artifact bytes.",
      "Validate the first reviewer's exact artifact evidence, but do not copy, reserialize, rename, or claim any of its records. The parent gate independently verifies the pointer, binds that partial payload only to the first reviewer's Bash calls, and merges it itself. Your SAFETY_EVIDENCE_JSON must contain only new records backed one-to-one by your own Bash calls. Independently run intended and minimally different non-regression probes for every paired semantic atom assigned to singleton cuts; positive atoms need one intended probe. Then run the required additional cross-cut interaction probes for every deep family, plus any extra probes needed so every exact hunk has intended and non-regression coverage.",
      "You own every mandatory regression replay in the final contract. Execute each exact replay command even when another current probe appears equivalent.",
      ...finalContract,
    ].join("\n");
    const requestPath = manifestPath.replace(
      /\.json$/i,
      `.safety-${verificationSequence}-${fingerprint.sha256.slice(0, 16)}.attempt-${attempt}.request.json`,
    );
    const requestSha256 = writeManagedRequest(requestPath, {
      schemaVersion: 1,
      kind: "frontier-safety-v11-chain",
      manifestSha256,
      workspaceRoot: manifest.workspaceRoot,
      fingerprint,
      regressionLedger,
      contractObligations: manifest.contractObligations,
      feedback: safetyCorrection,
      rejectedReport: safetyCorrection ? safetyRejectedReport : null,
      partialReportPath,
      familyTask,
      integrationTask,
    });
      managedSafetyReviewPlan = {
      key: planKey,
      attempt,
      mode: "chain" as const,
      agents: ["cora-frontier-family-auditor", "cora-frontier-integration-auditor"],
      input: {
        chain: [
          {
            agent: "cora-frontier-family-auditor",
            task: requestTask("safety-family", requestPath, requestSha256, "familyTask"),
          },
          {
            agent: "cora-frontier-integration-auditor",
            task: requestTask("safety-integration", requestPath, requestSha256, "integrationTask"),
          },
        ],
        agentScope: "user",
        confirmProjectAgents: false,
        cwd: manifest.workspaceRoot,
      },
      requestPath,
      requestSha256,
      partialReportPath,
    };
    return managedSafetyReviewPlan;
  };

  const invalidateFinal = (stage?: string, preserveSafetyCorrection = false) => {
    finalFingerprint = null;
    safetyReviewToolCallId = null;
    safetyReviewFingerprint = null;
    safetyReport = null;
    safetyAssessment = null;
    safetyEvidence = [];
    finalSafeFingerprint = null;
    managedSafetyReviewPlan = null;
    if (!preserveSafetyCorrection) {
      safetyCorrection = null;
      safetyRejectedReport = null;
      safetyReviewExhausted = false;
    }
    if (stage) persist(stage);
  };

  const persist = (stage: string) => safeEvidenceWrite(evidencePath, {
    schemaVersion: 1,
    runId: process.env.SPARK_RUN_ID || null,
    policy: "frontier",
    stage,
    manifestSha256,
    trackedTreeSha256: manifest.trackedTreeSha256,
    contractTreeSha256: manifest.contractTreeSha256,
    frontierPolicy: manifest.frontierPolicy,
    cacheEligible: manifest.cacheEligible,
    cacheIneligibilityReasons: manifest.cacheIneligibilityReasons,
    baselineVerified,
    baselineCommands: baselineEvidence,
    admissionReviewFingerprint,
    admissionRequest: {
      path: managedAdmissionReviewPlan.requestPath,
      sha256: managedAdmissionReviewPlan.requestSha256,
      mode: managedAdmissionReviewPlan.mode,
      attempt: managedAdmissionReviewPlan.attempt,
    },
    admissionReport,
    admissionReportSha256: admissionReport ? hash(admissionReport) : null,
    admissionBlocker,
    admissionBlockerWitness,
    admissionCuts,
    admissionFamilyDepth: admissionFamilyDepth(admissionCuts),
    admissionVerified,
    admissionSource,
    admissionReviewHistory,
    admissionReviewExhausted,
    finalCommands: finalEvidence,
    finalFingerprint,
    safetyReviewFingerprint,
    safetyRequest: managedSafetyReviewPlan
      ? {
        path: managedSafetyReviewPlan.requestPath,
        sha256: managedSafetyReviewPlan.requestSha256,
        mode: managedSafetyReviewPlan.mode,
        attempt: managedSafetyReviewPlan.attempt,
        partialReportPath: managedSafetyReviewPlan.partialReportPath ?? null,
      }
      : null,
    safetyReportSha256: safetyReport ? hash(safetyReport) : null,
    safetyAssessment,
    safetyEvidence,
    regressionLedger,
    safetyReviewHistory,
    safetyCorrection,
    safetyRejectedReportSha256: safetyRejectedReport ? hash(safetyRejectedReport) : null,
    safetyReviewExhausted,
    finalSafeFingerprint,
    verificationSequence,
    contractDrift,
    updatedAt: new Date().toISOString(),
  });

  async function runCommands(
    signal: AbortSignal | undefined,
  ): Promise<{ passed: boolean; evidence: CommandEvidence[]; output: string }> {
    if (!manifest.commands.length) {
      return { passed: false, evidence: [], output: "No verification command was discovered. Add a tracked .codara/frontier.json before using Frontier Execute." };
    }
    const evidence: CommandEvidence[] = [];
    const output: string[] = [];
    let passed = true;
    for (const item of manifest.commands) {
      const cwd = item.cwdRelative === "."
        ? manifest.workspaceRoot
        : path.resolve(manifest.workspaceRoot, ...item.cwdRelative.split("/"));
      const startedAt = Date.now();
      const result = await pi.exec(item.command, item.args, { cwd, timeout: item.timeoutMs, signal });
      const record: CommandEvidence = {
        id: item.id,
        command: item.command,
        args: item.args,
        cwdRelative: item.cwdRelative,
        exitCode: result.code,
        durationMs: Date.now() - startedAt,
        stdoutSha256: hash(result.stdout),
        stderrSha256: hash(result.stderr),
      };
      evidence.push(record);
      output.push([
        `command=${item.id}`,
        `argv=${JSON.stringify([item.command, ...item.args])}`,
        `cwd=${item.cwdRelative}`,
        `exit=${result.code}`,
        result.stdout,
        result.stderr,
      ].join("\n"));
      if (result.code !== 0) passed = false;
    }
    return { passed, evidence, output: clip(output.join("\n\n")) };
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}

Cora Frontier machine gate (content addressed):
- The verification manifest SHA-256 is ${manifestSha256}.
- The baseline tracked-tree SHA-256 is ${manifest.trackedTreeSha256}.
- Contract SHA-256: ${manifest.contractTreeSha256 ?? "unavailable; cache reuse disabled"}.
- Verification commands: ${JSON.stringify(manifest.commands.map((command) => ({ id: command.id, argv: [command.command, ...command.args], cwd: command.cwdRelative })))}.
- Exact-state admission cache: ${admissionArtifact ? `HIT from run ${admissionArtifact.provenance.runId}; after baseline call cora_frontier_admit directly` : "MISS; run the exact managed admission chain after baseline"}.
- Before any edit or worker launch, call cora_frontier_verify with phase=baseline. The extension independently confirms the exact tracked baseline and executes every argv-only gate.
- Baseline verification does not unlock mutation. On a cache MISS, next call subagent with the exact managed admission input supplied below. On a cache HIT, skip that model spend. Then call cora_frontier_admit; the gate independently revalidates the causal portfolio either way.
- Exact admission subagent input: ${JSON.stringify(managedAdmissionReviewPlan.input)}
- If admission validation refuses a report and prints required_admission_subagent_input, invoke that exact signed corrective input directly, then call cora_frontier_admit again. Never rerun the original context-free chain.
- If admission returns frontier=contract-blocked, stop immediately and explain the exact machine-validated blocker and minimal contract resolutions to the user. Never mutate around an impossible or unobservable requirement.
- After admission, implement and probe the work. After all edits and worker activity settle, call cora_frontier_verify with phase=final.
- A changed final diff remains provisional. Call subagent with the exact managed safety input printed by final verification. The gate binds the reviewer chain to the current diff, validates full hunk/probe accounting, and accepts only SAFE with zero regressions.
- If structural safety validation prints required_safety_subagent_input, invoke that exact signed corrective input directly. Re-run final verification first only after a mutation or an UNSAFE repair; unchanged corrective retries retain the exact frozen fingerprint.
- codara_complete is refused unless repository gates, independent safety, and the exact current diff fingerprint all agree. Cached admission, when later supplied, will never replace fresh baseline commands, implementation probes, final commands, or final safety review.
- If a tool reports ${CONTRACT_DRIFT_MARKER}, stop mutating immediately and return that exact marker. Codara will rotate the runtime, compile the new contract atlas, and require fresh admission while preserving the working tree.
`,
  }));

  pi.registerTool({
    name: "cora_frontier_admit",
    label: "Cora Frontier admission gate",
    description: "Machine-validate the completed managed contract audit before any repository mutation.",
    promptSnippet: "Validate the exact managed Frontier admission portfolio",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as never,
    async execute() {
      verificationSequence += 1;
      const drift = detectContractDrift();
      if (drift) {
        persist("contract-drift");
        return {
          content: [{ type: "text", text: `frontier=contract-drift\n${contractDriftText(drift)}` }],
          details: { passed: false, contractDrift: drift, restartRequired: true },
          isError: true,
        };
      }
      if (!baselineVerified) {
        return { content: [{ type: "text", text: "frontier=admission-refused\nreason=baseline verification has not passed" }], details: { passed: false }, isError: true };
      }
      if (admissionBlocker) {
        return {
          content: [{ type: "text", text: `frontier=contract-blocked\nCONTRACT_BLOCKER_JSON=${JSON.stringify(admissionBlocker)}` }],
          details: { passed: false, contractBlocked: true, blocker: admissionBlocker },
          isError: true,
        };
      }
      if (admissionVerified) {
        return { content: [{ type: "text", text: `frontier=admission-already-verified\ncuts=${admissionCuts.length}` }], details: { passed: true, cuts: admissionCuts.length } };
      }
      if (!admissionReport || !admissionReviewFingerprint) {
        return { content: [{ type: "text", text: "frontier=admission-refused\nreason=the exact managed admission review has not completed" }], details: { passed: false }, isError: true };
      }
      let currentFingerprint: FrontierDiffFingerprint;
      try { currentFingerprint = frontierDiffFingerprint(manifest.workspaceRoot); }
      catch (error) {
        return { content: [{ type: "text", text: `frontier=admission-refused\nreason=${error instanceof Error ? error.message : String(error)}` }], details: { passed: false }, isError: true };
      }
      const currentTree = trackedWorkspaceTreeSha256(manifest.workspaceRoot);
      if (currentTree !== manifest.trackedTreeSha256 || currentFingerprint.sha256 !== admissionReviewFingerprint.sha256 ||
        currentFingerprint.changedHunks !== admissionReviewFingerprint.changedHunks) {
        admissionReport = null;
        admissionReviewExecutions = [];
        admissionBlockerWitness = null;
        admissionReviewFingerprint = null;
        persist("admission-stale");
        return { content: [{ type: "text", text: "frontier=admission-refused\nreason=workspace changed during managed admission review" }], details: { passed: false }, isError: true };
      }
      const parsedBlocker = parseContractBlocker(admissionReport, manifest, admissionReviewExecutions);
      if (parsedBlocker.blocker && parsedBlocker.errors.length === 0) {
        admissionBlocker = parsedBlocker.blocker;
        const witness = admissionReviewExecutions.find((execution) => execution.command === admissionBlocker?.witnessCommand);
        admissionBlockerWitness = witness
          ? { command: witness.command, outputSha256: hash(witness.output), output: clip(witness.output, 8_000) }
          : null;
        admissionReviewHistory.push({
          at: new Date().toISOString(),
          kind: "report-validation",
          reportSha256: hash(admissionReport),
          valid: true,
          errors: [],
        });
        admissionCorrection = null;
        admissionReviewExhausted = false;
        persist("contract-blocked");
        return {
          content: [{ type: "text", text: clip(`frontier=contract-blocked\nreason=the tracked contract is not jointly implementable or verifiable from its required observables\nCONTRACT_BLOCKER_JSON=${JSON.stringify(admissionBlocker)}`, 96_000) }],
          details: { passed: false, contractBlocked: true, blocker: admissionBlocker },
          isError: true,
        };
      }
      const parsed = parsedBlocker.present ? { errors: parsedBlocker.errors } : parseAdmissionCuts(admissionReport);
      let canonicalizedEnvelope: { originalReportSha256: string; errors: string[] } | null = null;
      let errors = parsed.errors;
      if (parsed.cuts) {
        const portfolioErrors = validateAdmissionCuts(parsed.cuts, manifest, implementationRootIndex);
        const envelopeErrors = validateAdmissionEnvelope(parsed.cuts, admissionReport);
        errors = [...portfolioErrors, ...envelopeErrors];
        if (!portfolioErrors.length && envelopeErrors.length) {
          const originalReportSha256 = hash(admissionReport);
          const canonicalReport = canonicalizeAdmissionEnvelope(admissionReport, parsed.cuts);
          const canonicalErrors = validateAdmissionEnvelope(parsed.cuts, canonicalReport);
          if (!canonicalErrors.length) {
            admissionReport = canonicalReport;
            canonicalizedEnvelope = { originalReportSha256, errors: envelopeErrors };
            errors = [];
          }
        }
      }
      if (!parsed.cuts || errors.length) {
        const rejectedReport = admissionReport;
        admissionReviewHistory.push({
          at: new Date().toISOString(),
          kind: "report-validation",
          reportSha256: hash(rejectedReport),
          valid: false,
          errors: errors.slice(0, 24),
        });
        if (admissionReviewHistory.length > 32) admissionReviewHistory = admissionReviewHistory.slice(-32);
        const exhausted = managedAdmissionReviewPlan.attempt >= MAX_MANAGED_REVIEW_ATTEMPTS;
        admissionReviewExhausted = exhausted;
        let correctiveInput = "";
        if (!exhausted) {
          admissionCorrection = {
            feedback: {
              attempt: managedAdmissionReviewPlan.attempt + 1,
              errors: errors.slice(0, 24),
              rejectedReportSha256: hash(rejectedReport),
              ...(parsed.cuts ? { admissionDiagnostics: admissionDiagnostics(parsed.cuts, manifest) } : {}),
            },
            rejectedReport,
          };
          managedAdmissionReviewPlan = createAdmissionReviewPlan();
          admissionReport = null;
          admissionReviewExecutions = [];
          admissionBlockerWitness = null;
          admissionReviewFingerprint = null;
          admissionSource = null;
          correctiveInput = `\nrequired_admission_subagent_input=${JSON.stringify(managedAdmissionReviewPlan.input)}`;
        }
        persist(exhausted ? "admission-review-exhausted" : "admission-invalid-correction-ready");
        return {
          content: [{ type: "text", text: clip(`frontier=${exhausted ? "admission-review-exhausted" : "admission-refused"}\nreason=managed auditor report failed machine validation\nattempt=${managedAdmissionReviewPlan.attempt - (exhausted ? 0 : 1)}\nerrors=${JSON.stringify(errors)}${correctiveInput}`, 96_000) }],
          details: { passed: false, errors, exhausted, nextAttempt: exhausted ? null : managedAdmissionReviewPlan.attempt },
          isError: true,
        };
      }
      admissionCuts = parsed.cuts;
      admissionBlocker = null;
      admissionBlockerWitness = null;
      admissionVerified = true;
      admissionReviewExhausted = false;
      admissionReviewHistory.push({
        at: new Date().toISOString(),
        kind: "report-validation",
        reportSha256: canonicalizedEnvelope?.originalReportSha256 ?? hash(admissionReport),
        canonicalReportSha256: canonicalizedEnvelope ? hash(admissionReport) : undefined,
        canonicalizedEnvelope: Boolean(canonicalizedEnvelope),
        repairedEnvelopeErrors: canonicalizedEnvelope?.errors,
        valid: true,
        errors: [],
      });
      admissionCorrection = null;
      persist("admission-verified");
      const verifiedTotals = admissionTotals(admissionCuts);
      return {
        content: [{ type: "text", text: `frontier=admission-verified\ncuts=${admissionCuts.length}\nfamilies=${verifiedTotals.TOTAL_FAMILIES}\noperations=${verifiedTotals.TOTAL_OPERATIONS}\nenvelope_canonicalized=${Boolean(canonicalizedEnvelope)}` }],
        details: {
          passed: true,
          cuts: admissionCuts.length,
          families: verifiedTotals.TOTAL_FAMILIES,
          operations: verifiedTotals.TOTAL_OPERATIONS,
          envelopeCanonicalized: Boolean(canonicalizedEnvelope),
        },
      };
    },
  });

  pi.registerTool({
    name: "cora_frontier_verify",
    label: "Cora Frontier verification gate",
    description: "Verify the exact pre-mutation baseline or bind the final current diff to every repository gate.",
    promptSnippet: "Run the content-addressed Frontier baseline/final verification gate",
    parameters: {
      type: "object",
      properties: { phase: { type: "string", enum: ["baseline", "final"] } },
      required: ["phase"],
      additionalProperties: false,
    } as never,
    async execute(_toolCallId, params: { phase: "baseline" | "final" }, signal) {
      verificationSequence += 1;
      const drift = detectContractDrift();
      if (drift) {
        persist("contract-drift");
        return {
          content: [{ type: "text", text: `frontier=contract-drift\nphase=${params.phase}\n${contractDriftText(drift)}` }],
          details: { passed: false, phase: params.phase, contractDrift: drift, restartRequired: true },
          isError: true,
        };
      }
      if (params.phase === "baseline") {
        if (baselineVerified) {
          return { content: [{ type: "text", text: "frontier=baseline-already-verified" }], details: { passed: true, phase: "baseline" } };
        }
        const actualTree = trackedWorkspaceTreeSha256(manifest.workspaceRoot);
        if (actualTree !== manifest.trackedTreeSha256) {
          persist("baseline-stale");
          return {
            content: [{ type: "text", text: `frontier=refused\nphase=baseline\nreason=tracked workspace changed after launch\nexpected=${manifest.trackedTreeSha256}\nactual=${actualTree}` }],
            details: { passed: false, phase: "baseline", expected: manifest.trackedTreeSha256, actual: actualTree },
            isError: true,
          };
        }
        const gate = await runCommands(signal);
        baselineEvidence = gate.evidence;
        const afterTree = trackedWorkspaceTreeSha256(manifest.workspaceRoot);
        baselineVerified = gate.passed && afterTree === manifest.trackedTreeSha256;
        let cacheStatus = admissionArtifact ? "cache-refused-after-baseline" : "cache-miss";
        if (baselineVerified && admissionArtifact && admissionArtifactLaunchFingerprint) {
          const afterFingerprint = frontierDiffFingerprint(manifest.workspaceRoot);
          if (afterFingerprint.sha256 === admissionArtifactLaunchFingerprint.sha256 &&
            afterFingerprint.changedHunks === admissionArtifactLaunchFingerprint.changedHunks) {
            admissionReport = admissionArtifact.auditorReport;
            admissionReviewFingerprint = afterFingerprint;
            admissionSource = "cache";
            cacheStatus = "cache-candidate-loaded";
          }
        }
        persist(baselineVerified ? (admissionSource === "cache" ? "baseline-verified-cache-hit" : "baseline-verified") : "baseline-failed");
        return {
          content: [{ type: "text", text: clip(`frontier=${baselineVerified ? "baseline-verified" : "baseline-failed"}\nadmission_cache=${cacheStatus}\ncommands=${gate.evidence.length}\ntracked_tree_unchanged=${afterTree === manifest.trackedTreeSha256}\n${gate.output}`) }],
          details: { passed: baselineVerified, phase: "baseline", commands: gate.evidence.length, admissionCache: cacheStatus },
          isError: !baselineVerified,
        };
      }
      if (!baselineVerified) {
        return { content: [{ type: "text", text: "frontier=refused\nphase=final\nreason=baseline verification has not passed" }], details: { passed: false, phase: "final" }, isError: true };
      }
      if (!admissionVerified) {
        return { content: [{ type: "text", text: "frontier=refused\nphase=final\nreason=managed contract admission has not passed" }], details: { passed: false, phase: "final" }, isError: true };
      }
      const correctiveFingerprintSha256 = safetyCorrection
        ? safetyReviewFingerprint?.sha256 ?? finalFingerprint?.sha256 ?? null
        : null;
      invalidateFinal(undefined, true);
      const gate = await runCommands(signal);
      finalEvidence = gate.evidence;
      const diffCheck = await pi.exec("git", ["diff", "--check"], { cwd: manifest.workspaceRoot, timeout: 30_000, signal });
      const passed = gate.passed && diffCheck.code === 0;
      finalFingerprint = passed ? frontierDiffFingerprint(manifest.workspaceRoot) : null;
      if (!finalFingerprint || (correctiveFingerprintSha256 && finalFingerprint.sha256 !== correctiveFingerprintSha256)) {
        safetyCorrection = null;
        safetyRejectedReport = null;
        safetyReviewExhausted = false;
        managedSafetyReviewPlan = null;
      }
      if (finalFingerprint?.changedHunks === 0) {
        safetyAssessment = { changedHunks: 0, reviewedHunks: 0, probes: 0, regressions: 0, verdict: "SAFE" };
        finalSafeFingerprint = finalFingerprint;
      }
      persist(!passed ? "final-failed" : finalSafeFingerprint ? "final-safe-no-change" : "final-provisional");
      const safetyInput = finalFingerprint && finalFingerprint.changedHunks > 0
        ? `\nrequired_safety_subagent_input=${JSON.stringify(safetyReviewPlan(finalFingerprint).input)}`
        : "";
      return {
        content: [{ type: "text", text: clip(`frontier=${!passed ? "final-failed" : finalSafeFingerprint ? "final-safe-no-change" : "final-awaiting-independent-safety"}\ncommands=${gate.evidence.length}\ngit_diff_check_exit=${diffCheck.code}${finalFingerprint ? `\ndiff_sha256=${finalFingerprint.sha256}\nchanged_hunks=${finalFingerprint.changedHunks}\nuntracked_files=${finalFingerprint.untrackedFiles}` : ""}${safetyInput}\n${gate.output}\n${diffCheck.stdout}\n${diffCheck.stderr}`, 96_000) }],
        details: { passed, phase: "final", fingerprint: finalFingerprint, independentlySafe: Boolean(finalSafeFingerprint) },
        isError: !passed,
      };
    },
  });

  pi.on("tool_call", async (event) => {
    const drift = detectContractDrift();
    if (drift && (event.toolName === "subagent" || event.toolName === "codara_complete" ||
      MUTATING_TOOLS.has(event.toolName) || (event.toolName === "bash" && !readOnlyBash(event.input?.command)))) {
      persist("contract-drift");
      return { block: true, reason: contractDriftText(drift) };
    }
    if (event.toolName === "subagent") {
      if (exactInput(event.input, managedAdmissionReviewPlan.input)) {
        if (!baselineVerified) return { block: true, reason: "Frontier contract admission requires passing baseline verification first." };
        if (admissionVerified) return { block: true, reason: "Frontier contract admission is already verified." };
        if (admissionBlocker) return { block: true, reason: "Frontier contract admission produced a machine-validated contract blocker. Stop and report it to the user." };
        if (admissionReviewExhausted) return { block: true, reason: `Frontier admission review exhausted ${MAX_MANAGED_REVIEW_ATTEMPTS} machine-validated attempts.` };
        if (admissionReviewToolCallId) return { block: true, reason: "The managed Frontier admission review is already in progress or awaiting validation." };
        if (!managedRequestIntact(managedAdmissionReviewPlan.requestPath, managedAdmissionReviewPlan.requestSha256)) {
          return { block: true, reason: "The content-addressed Frontier admission request changed or disappeared." };
        }
        admissionReviewFingerprint = frontierDiffFingerprint(manifest.workspaceRoot);
        admissionReviewToolCallId = event.toolCallId;
        admissionReport = null;
        admissionReviewExecutions = [];
        admissionBlocker = null;
        admissionBlockerWitness = null;
        admissionSource = null;
        persist("admission-review-started");
        return;
      }
      const requiredSafety = finalFingerprint?.changedHunks ? safetyReviewPlan(finalFingerprint) : null;
      if (finalFingerprint?.changedHunks && requiredSafety && exactInput(event.input, requiredSafety.input)) {
        if (!admissionVerified) return { block: true, reason: "Frontier safety review requires passing contract admission first." };
        if (safetyReviewExhausted) return { block: true, reason: `Frontier safety review exhausted ${MAX_MANAGED_REVIEW_ATTEMPTS} machine-validated attempts for this fingerprint.` };
        if (safetyReviewToolCallId) return { block: true, reason: "The managed Frontier safety review is already in progress." };
        if (!managedRequestIntact(requiredSafety.requestPath, requiredSafety.requestSha256)) {
          return { block: true, reason: "The content-addressed Frontier safety request changed or disappeared." };
        }
        const current = frontierDiffFingerprint(manifest.workspaceRoot);
        if (current.sha256 !== finalFingerprint.sha256 || current.changedHunks !== finalFingerprint.changedHunks) {
          invalidateFinal("final-stale-before-safety");
          return { block: true, reason: "The workspace changed before independent safety review. Re-run final Frontier verification." };
        }
        safetyReviewToolCallId = event.toolCallId;
        safetyReviewFingerprint = current;
        safetyReport = null;
        safetyAssessment = null;
        safetyEvidence = [];
        finalSafeFingerprint = null;
        persist("safety-review-started");
        return;
      }
      return { block: true, reason: "Frontier permits only its exact managed admission chain or exact diff-bound safety reviewer through the Pi subagent tool. Use Codara workers for implementation delegation." };
    }

    const mutatingBash = event.toolName === "bash" && !readOnlyBash(event.input?.command);
    const mutatingTool = MUTATING_TOOLS.has(event.toolName) || mutatingBash;
    if (!baselineVerified || !admissionVerified) {
      if (mutatingTool) {
        return {
          block: true,
          reason: !baselineVerified
            ? "Frontier requires a passing exact-baseline cora_frontier_verify call before mutation or worker launch."
            : "Frontier requires the exact managed contract audit and a passing cora_frontier_admit call before mutation or worker launch.",
        };
      }
    } else if (mutatingTool && (finalFingerprint || finalSafeFingerprint)) {
      invalidateFinal("final-invalidated-by-mutation");
    }

    if (event.toolName !== "codara_complete") return;
    if (!finalFingerprint || !finalSafeFingerprint) {
      return { block: true, reason: "Frontier requires passing final repository verification and independent SAFE diff review before completion." };
    }
    let current: FrontierDiffFingerprint;
    try { current = frontierDiffFingerprint(manifest.workspaceRoot); }
    catch (error) {
      return { block: true, reason: `Frontier could not recompute the final diff fingerprint: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (current.sha256 !== finalFingerprint.sha256 || current.changedHunks !== finalFingerprint.changedHunks ||
      current.sha256 !== finalSafeFingerprint.sha256 || current.changedHunks !== finalSafeFingerprint.changedHunks) {
      invalidateFinal("final-stale");
      return { block: true, reason: "The workspace changed after final Frontier verification or independent safety review. Re-run the final gate and review." };
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent") return;
    const drift = detectContractDrift();
    if (drift) {
      admissionReviewToolCallId = null;
      safetyReviewToolCallId = null;
      admissionReport = null;
      safetyReport = null;
      invalidateFinal(undefined);
      persist("contract-drift");
      return { content: [...event.content, { type: "text", text: contractDriftText(drift) }] };
    }
    if (admissionReviewToolCallId && event.toolCallId === admissionReviewToolCallId && exactInput(event.input, managedAdmissionReviewPlan.input)) {
      admissionReviewToolCallId = null;
      const current = frontierDiffFingerprint(manifest.workspaceRoot);
      const unchanged = admissionReviewFingerprint && current.sha256 === admissionReviewFingerprint.sha256 &&
        current.changedHunks === admissionReviewFingerprint.changedHunks &&
        trackedWorkspaceTreeSha256(manifest.workspaceRoot) === manifest.trackedTreeSha256;
      const requestIntact = managedRequestIntact(managedAdmissionReviewPlan.requestPath, managedAdmissionReviewPlan.requestSha256);
      const executionDetailsValid = successfulSubagentDetails(
        event.details,
        managedAdmissionReviewPlan.mode,
        managedAdmissionReviewPlan.agents,
      );
      const validExecution = requestIntact && !event.isError && executionDetailsValid;
      admissionReport = unchanged && validExecution ? textBlocks(event.content) : null;
      admissionReviewExecutions = unchanged && validExecution
        ? successfulBashExecutions(event.details, [managedAdmissionReviewPlan.mode === "chain" ? 1 : 0])
        : [];
      admissionSource = admissionReport ? "managed-review" : null;
      if (!admissionReport) {
        const executionErrors = [
          ...(!unchanged ? ["workspace changed during managed admission execution"] : []),
          ...(!requestIntact ? ["content-addressed managed admission request changed"] : []),
          ...(event.isError ? ["managed admission subagent returned an error"] : []),
          ...(!executionDetailsValid ? ["managed admission subagent result topology was incomplete"] : []),
        ];
        admissionReviewHistory.push({
          at: new Date().toISOString(),
          kind: "execution",
          reportSha256: null,
          valid: false,
          errors: executionErrors.length ? executionErrors : ["managed admission execution produced no admissible report"],
        });
        if (admissionReviewHistory.length > 32) admissionReviewHistory = admissionReviewHistory.slice(-32);
      }
      persist(admissionReport ? "admission-review-completed" : "admission-review-refused");
      const machineStatus = admissionReport
        ? "frontier_machine=admission-review-captured; call cora_frontier_admit"
        : `frontier_machine=admission-review-refused; workspace_unchanged=${Boolean(unchanged)}; managed_review_succeeded=${validExecution}`;
      return { content: [...event.content, { type: "text", text: machineStatus }] };
    }
    const requiredSafety = safetyReviewFingerprint ? safetyReviewPlan(safetyReviewFingerprint) : null;
    if (safetyReviewToolCallId && event.toolCallId === safetyReviewToolCallId && safetyReviewFingerprint && requiredSafety &&
      exactInput(event.input, requiredSafety.input)) {
      safetyReviewToolCallId = null;
      const current = frontierDiffFingerprint(manifest.workspaceRoot);
      const unchanged = current.sha256 === safetyReviewFingerprint.sha256 && current.changedHunks === safetyReviewFingerprint.changedHunks;
      const validExecution = managedRequestIntact(requiredSafety.requestPath, requiredSafety.requestSha256) &&
        !event.isError && successfulSubagentDetails(event.details, requiredSafety.mode, requiredSafety.agents);
      const integrationReport = unchanged && validExecution ? textBlocks(event.content) : null;
      const partialPointer = unchanged && validExecution && requiredSafety.mode === "chain"
        ? subagentResultText(event.details, 0)
        : null;
      const partialArtifact = requiredSafety.mode === "chain" && requiredSafety.partialReportPath && partialPointer
        ? loadPartialSafetyReport(partialPointer, requiredSafety.partialReportPath)
        : { errors: requiredSafety.mode === "chain" ? ["first reviewer partial-report pointer is missing"] : [] as string[] };
      const partialReport = "report" in partialArtifact && typeof partialArtifact.report === "string"
        ? partialArtifact.report
        : null;
      const integrationExecutions = requiredSafety.mode === "chain"
        ? successfulBashExecutions(event.details, [1])
        : [];
      const integrationBindingErrors = requiredSafety.mode === "chain" && integrationReport && requiredSafety.partialReportPath &&
        partialArtifact.sha256 && typeof partialArtifact.bytes === "number"
        ? integrationPartialBindingErrors(
          integrationReport,
          integrationExecutions,
          requiredSafety.partialReportPath,
          partialArtifact.sha256,
          partialArtifact.bytes,
        )
        : [];
      safetyReport = integrationReport && requiredSafety.mode === "chain"
        ? [
          "FIRST_REVIEWER_REPORT_BEGIN",
          partialReport ?? "",
          "FIRST_REVIEWER_REPORT_END",
          "SECOND_REVIEWER_REPORT_BEGIN",
          integrationReport,
          "SECOND_REVIEWER_REPORT_END",
        ].join("\n")
        : integrationReport;
      const parsedBase = integrationReport
        ? requiredSafety.mode === "chain"
          ? parseChainSafetyReport(
            partialReport ?? "",
            integrationReport,
            safetyReviewFingerprint,
            successfulBashExecutions(event.details, [0]),
            integrationExecutions,
            manifest,
            admissionCuts,
            regressionLedger,
          )
          : parseSafetyReport(
            integrationReport,
            safetyReviewFingerprint,
            successfulBashExecutions(event.details),
            manifest,
            admissionCuts,
            regressionLedger,
          )
        : { errors: ["managed safety review failed or changed the workspace"] };
      const parsed = {
        ...parsedBase,
        errors: [...new Set([...partialArtifact.errors, ...integrationBindingErrors, ...parsedBase.errors])],
      };
      const newRegressionReplayIds: string[] = [];
      if (parsed.errors.length === 0 && parsed.evidence) {
        for (const probe of parsed.evidence.filter((item) => item.verdict === "REGRESSION")) {
          const id = `replay-${hash(`${probe.cutId}\0${probe.command}\0${probe.contractCitation}\0${probe.expected}`).slice(0, 16)}`;
          if (!regressionLedger.some((replay) => replay.id === id)) {
            regressionLedger.push({
              id,
              cutId: probe.cutId,
              command: probe.command,
              contractCitation: probe.contractCitation,
              expected: probe.expected,
              firstObserved: probe.observed,
            });
            newRegressionReplayIds.push(id);
          }
        }
      }
      safetyAssessment = parsed.errors.length ? null : parsed.assessment ?? null;
      safetyEvidence = parsed.errors.length ? [] : parsed.evidence ?? [];
      finalSafeFingerprint = safetyAssessment?.verdict === "SAFE" ? current : null;
      safetyReviewHistory.push({
        at: new Date().toISOString(),
        fingerprintSha256: safetyReviewFingerprint.sha256,
        reportSha256: safetyReport ? hash(safetyReport) : null,
        valid: parsed.errors.length === 0,
        assessment: safetyAssessment,
        errorCount: parsed.errors.length,
        errors: parsed.errors.slice(0, 32),
        newRegressionReplayIds,
      });
      if (safetyReviewHistory.length > 64) safetyReviewHistory = safetyReviewHistory.slice(-64);
      let correctiveInput = "";
      if (parsed.errors.length) {
        const exhausted = requiredSafety.attempt >= MAX_MANAGED_REVIEW_ATTEMPTS;
        safetyReviewExhausted = exhausted;
        if (!exhausted) {
          safetyCorrection = {
            attempt: requiredSafety.attempt + 1,
            errors: parsed.errors.slice(0, 32),
            rejectedReportSha256: safetyReport ? hash(safetyReport) : null,
            safetyDiagnostics: safetyDiagnostics(parsed.errors),
          };
          safetyRejectedReport = safetyReport;
          managedSafetyReviewPlan = null;
          correctiveInput = `\nrequired_safety_subagent_input=${JSON.stringify(safetyReviewPlan(current).input)}`;
        }
      } else {
        safetyCorrection = null;
        safetyRejectedReport = null;
        safetyReviewExhausted = false;
        managedSafetyReviewPlan = null;
      }
      persist(finalSafeFingerprint
        ? "final-safe"
        : safetyAssessment?.verdict === "UNSAFE"
          ? "final-unsafe"
          : safetyReviewExhausted
            ? "safety-review-exhausted"
            : "safety-review-invalid-correction-ready");
      const machineStatus = finalSafeFingerprint
        ? `frontier_machine=final-safe; diff_sha256=${finalSafeFingerprint.sha256}`
        : safetyReviewExhausted
          ? `frontier_machine=safety-review-exhausted; attempts=${MAX_MANAGED_REVIEW_ATTEMPTS}; errors=${JSON.stringify(parsed.errors.slice(0, 32))}; total_errors=${parsed.errors.length}`
          : `frontier_machine=final-not-safe; errors=${JSON.stringify(parsed.errors.slice(0, 32))}; total_errors=${parsed.errors.length}; verdict=${safetyAssessment?.verdict ?? "INVALID"}${correctiveInput}`;
      return { content: [...event.content, { type: "text", text: machineStatus }] };
    }
  });

  persist("loaded");
}

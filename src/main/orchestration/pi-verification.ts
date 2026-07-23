import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TRACKED_FILES = 30_000;
const MAX_TRACKED_BYTES = 768 * 1024 * 1024;
const MAX_COMMANDS = 12;
const MAX_CONTRACT_OBLIGATIONS = 2_048;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const COMMAND_PATTERN = /^(?:[A-Za-z0-9._@+-]+|\.\/[A-Za-z0-9._@+/-]+)$/;

export type PiVerificationCommandSource =
  | "codara-config"
  | "package-json"
  | "cargo"
  | "go"
  | "python"
  | "maven"
  | "gradle"
  | "make";

export interface PiVerificationCommand {
  id: string;
  command: string;
  args: string[];
  cwdRelative: string;
  timeoutMs: number;
  source: PiVerificationCommandSource;
  sourcePath: string;
}

export interface PiFrontierDepthPolicy {
  schemaVersion: 3;
  targetCuts: number;
  minFamilies: number;
  minOperations: number;
  minDeepFamilies: number;
  minCriticalFamilies: number;
  maxObligationsPerCut: number;
  maxObligationsPerProbe: number;
  minCounterfactualFamilies: number;
}

export interface PiContractObligationSource {
  path: string;
  locator: string;
}

export interface PiContractObligation {
  id: string;
  kind: "markdown-atom" | "structured-surface" | "structured-json";
  proofMode: "paired" | "positive";
  title: string;
  sources: PiContractObligationSource[];
  contentSha256: string;
  excerpt: string;
}

export interface PiRequestContract {
  sourcePath: ".codara/__codara_user_request__.md";
  contentSha256: string;
  text: string;
}

export interface PiFrontierVerificationManifest {
  schemaVersion: 4;
  workspaceRoot: string;
  trackedTreeSha256: string;
  contractTreeSha256: string | null;
  cacheEligible: boolean;
  cacheIneligibilityReasons: string[];
  contractPaths: string[];
  requestContract: PiRequestContract | null;
  contractObligations: PiContractObligation[];
  sourceManifests: string[];
  commands: PiVerificationCommand[];
  frontierPolicy: PiFrontierDepthPolicy;
}

type TrackedEntry = {
  mode: string;
  path: string;
  contentSha256: string;
  size: number;
};

type FrontierConfig = {
  schemaVersion: 1;
  commands: Array<{
    id: string;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
  }>;
  contractPaths: string[];
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function piFrontierDepthPolicy(contractPathCount: number, obligationCount = 0): PiFrontierDepthPolicy {
  if (!Number.isSafeInteger(contractPathCount) || contractPathCount < 0 || contractPathCount > MAX_TRACKED_FILES) {
    throw new Error("Frontier contract-path count is outside the supported range");
  }
  if (!Number.isSafeInteger(obligationCount) || obligationCount < 0 || obligationCount > MAX_CONTRACT_OBLIGATIONS) {
    throw new Error("Frontier contract-obligation count is outside the supported range");
  }
  // Small repositories retain the lightweight V2 portfolio. Once the tracked
  // contract spans eight files, breadth alone is no longer a useful proxy for
  // risk: allocate enough cuts for multiple independent views of the most
  // failure-prone families instead of forcing one shallow cut per family.
  const pathTargetCuts = Math.max(5, Math.min(24,
    contractPathCount >= 8 ? contractPathCount * 2 + 4 : contractPathCount + 4));
  const targetCuts = Math.max(pathTargetCuts, Math.min(64, Math.ceil(obligationCount / 8)));
  const minFamilies = Math.max(2, Math.min(targetCuts,
    targetCuts >= 12 ? Math.ceil(targetCuts / 2) : Math.ceil(targetCuts * 2 / 3)));
  return {
    schemaVersion: 3,
    targetCuts,
    minFamilies,
    minOperations: Math.max(2, Math.min(5, Math.ceil(targetCuts / 2))),
    minDeepFamilies: targetCuts >= 12 ? Math.min(8, Math.floor(targetCuts / 4)) : 0,
    minCriticalFamilies: targetCuts >= 30 ? 5 : targetCuts >= 18 ? 2 : targetCuts >= 12 ? 1 : 0,
    maxObligationsPerCut: Math.max(8, Math.ceil(obligationCount / Math.max(1, targetCuts))),
    maxObligationsPerProbe: 4,
    minCounterfactualFamilies: minFamilies,
  };
}

function utf8Order(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function canonicalRelativePath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe workspace-relative path`);
  }
  return normalized;
}

function exactKeys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly ${wanted.join(", ")}`);
  }
}

function boundedText(value: unknown, label: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function boundedTimeout(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 5_000 || Number(value) > 30 * 60 * 1000) {
    throw new Error(`${label} must be an integer between 5000 and 1800000`);
  }
  return Number(value);
}

function parseFrontierConfig(value: unknown): FrontierConfig {
  exactKeys(value, ["schemaVersion", "commands", "contractPaths"], "frontier config");
  if (value.schemaVersion !== 1) throw new Error("frontier config schemaVersion must be 1");
  if (!Array.isArray(value.commands) || value.commands.length > MAX_COMMANDS) {
    throw new Error(`frontier config commands must contain at most ${MAX_COMMANDS} entries`);
  }
  if (!Array.isArray(value.contractPaths) || value.contractPaths.length > 128) {
    throw new Error("frontier config contractPaths must contain at most 128 entries");
  }
  const contractPaths = value.contractPaths.map((entry, index) =>
    canonicalRelativePath(boundedText(entry, `contractPaths[${index}]`), `contractPaths[${index}]`));
  const commands = value.commands.map((entry, index) => {
    exactKeys(entry, ["id", "command", "args", "cwd", "timeoutMs"], `commands[${index}]`);
    const id = boundedText(entry.id, `commands[${index}].id`, 80);
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(id)) {
      throw new Error(`commands[${index}].id is invalid`);
    }
    const command = boundedText(entry.command, `commands[${index}].command`, 240);
    if (!COMMAND_PATTERN.test(command) || command.split("/").includes("..")) {
      throw new Error(`commands[${index}].command must be a basename or safe ./relative executable`);
    }
    if (!Array.isArray(entry.args) || entry.args.length > 64) {
      throw new Error(`commands[${index}].args must contain at most 64 strings`);
    }
    const args = entry.args.map((arg, argIndex) => boundedText(arg, `commands[${index}].args[${argIndex}]`, 1_000));
    const cwd = entry.cwd === "."
      ? "."
      : canonicalRelativePath(boundedText(entry.cwd, `commands[${index}].cwd`), `commands[${index}].cwd`);
    return { id, command, args, cwd, timeoutMs: boundedTimeout(entry.timeoutMs, `commands[${index}].timeoutMs`) };
  });
  if (new Set(commands.map((command) => command.id)).size !== commands.length) {
    throw new Error("frontier config command ids must be unique");
  }
  return { schemaVersion: 1, commands, contractPaths: [...new Set(contractPaths)].sort(utf8Order) };
}

async function gitText(root: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
  });
  return result.stdout;
}

async function resolveGitRoot(cwd: string): Promise<string> {
  const root = (await gitText(resolve(cwd), ["rev-parse", "--show-toplevel"], 1024 * 1024)).trim();
  if (!root) throw new Error("Frontier verification requires a Git workspace");
  return resolve(root);
}

async function readTrackedEntries(root: string): Promise<TrackedEntry[]> {
  const listing = await gitText(root, ["ls-files", "--cached", "--stage", "-z"]);
  const records = listing.split("\0").filter(Boolean);
  if (records.length === 0 || records.length > MAX_TRACKED_FILES) {
    throw new Error(`Frontier verification requires 1-${MAX_TRACKED_FILES} tracked files`);
  }
  let totalBytes = 0;
  const entries: TrackedEntry[] = [];
  for (const record of records) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) \d+\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Could not parse the Git tracked-file index");
    const mode = match[1];
    const indexObjectId = match[2];
    const relativePath = canonicalRelativePath(match[3], "tracked path");
    const absolutePath = join(root, ...relativePath.split("/"));
    if (mode === "160000") {
      entries.push({ mode, path: relativePath, contentSha256: sha256(indexObjectId), size: indexObjectId.length });
      continue;
    }
    const stat = await fs.lstat(absolutePath);
    let content: Buffer;
    if (stat.isSymbolicLink()) {
      content = Buffer.from(await fs.readlink(absolutePath));
    } else if (stat.isFile()) {
      content = await fs.readFile(absolutePath);
    } else {
      throw new Error(`Tracked path is neither a regular file nor symlink: ${relativePath}`);
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_TRACKED_BYTES) {
      throw new Error(`Tracked workspace exceeds ${MAX_TRACKED_BYTES} bytes`);
    }
    entries.push({ mode, path: relativePath, contentSha256: sha256(content), size: content.byteLength });
  }
  return entries.sort((left, right) => utf8Order(left.path, right.path));
}

function treeSha256(entries: TrackedEntry[]): string {
  return sha256(entries.map((entry) =>
    `${entry.mode}\0${entry.path}\0${entry.size}\0${entry.contentSha256}`,
  ).join("\0"));
}

type RawContractObligation = {
  kind: PiContractObligation["kind"];
  proofMode: PiContractObligation["proofMode"];
  title: string;
  semanticKey: string | null;
  source: PiContractObligationSource;
  text: string;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(utf8Order).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function normalizeClause(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitSemanticSentences(value: string): string[] {
  const normalized = normalizeClause(value);
  const sentences: string[] = [];
  let start = 0;
  let inlineCode = false;
  let depth = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "`") {
      inlineCode = !inlineCode;
      continue;
    }
    if (inlineCode) continue;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if ((character === ")" || character === "]" || character === "}") && depth > 0) depth -= 1;
    if (depth !== 0 || !".!?;".includes(character)) continue;
    const next = normalized[index + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const sentence = normalizeClause(normalized.slice(start, index + 1));
    if (sentence) sentences.push(sentence);
    while (index + 1 < normalized.length && /\s/.test(normalized[index + 1])) index += 1;
    start = index + 1;
  }
  const tail = normalizeClause(normalized.slice(start));
  if (tail) sentences.push(tail);
  return sentences.length ? sentences : [normalized];
}

function topLevelComma(value: string): number {
  let inlineCode = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`") {
      inlineCode = !inlineCode;
      continue;
    }
    if (inlineCode) continue;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if ((character === ")" || character === "]" || character === "}") && depth > 0) depth -= 1;
    else if (character === "," && depth === 0) return index;
  }
  return -1;
}

function splitTopLevelNominals(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inlineCode = false;
  let depth = 0;
  const push = (end: number) => {
    const part = normalizeClause(value.slice(start, end)).replace(/^(?:and|or)\s+/i, "");
    if (part) parts.push(part);
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`") {
      inlineCode = !inlineCode;
      continue;
    }
    if (inlineCode) continue;
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      continue;
    }
    if ((character === ")" || character === "]" || character === "}") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const conjunction = /^(?:and|or)\b/i.exec(value.slice(index));
    const boundedConjunction = conjunction && (index === 0 || /[\s,]/.test(value[index - 1]));
    if (character !== "," && !boundedConjunction) continue;
    push(index);
    index += conjunction ? conjunction[0].length - 1 : 0;
    start = index + 1;
  }
  push(value.length);
  return parts;
}

const SHARED_SUBJECT_FINITE_VERB = "(?:accepts?|allows?|becomes?|blocks?|causes?|changes?|clears?|commits?|conflicts?|contains?|counts?|creates?|deletes?|emits?|fails?|feeds?|finishes?|follows?|gets?|includes?|increments?|increases?|keeps?|leaves?|marks?|mutates?|occup(?:y|ies)|orders?|preserves?|produces?|reads?|rebases?|records?|rejects?|remains?|reports?|requires?|resolves?|restores?|returns?|sets?|stores?|succeeds?|throws?|updates?|uses?|validates?|writes?)";
const MODAL_PREDICATE = "(?:must|shall|should|may|cannot|can not|will)";
const CLAUSE_PREDICATE = `(?:are|is|was|were|do|does|${MODAL_PREDICATE}|${SHARED_SUBJECT_FINITE_VERB})`;
const ELLIPTICAL_SUBJECT_MODIFIER = /^(?:approved|blocked|closed|committed|excluded|failed|invalid|malformed|missing|optional|pending|rejected|required|selected|sparse|stale|successful|terminal|unknown)$/i;

function clauseLike(value: string): boolean {
  const clause = normalizeClause(value).replace(/^(?:and|or)\s+/i, "");
  if (!clause || /^(?:when|if|unless|after|before|once|while|where|given|with|for|so|because|therefore|thus|yet|but|must|shall|should|may|cannot|can not|will)\b/i.test(clause)) return false;
  const grammatical = clause.replace(/`[^`]*`/g, " code ");
  const predicate = new RegExp(`\\s+(${CLAUSE_PREDICATE})\\b`, "i").exec(grammatical);
  if (!predicate?.index) return false;
  const subject = grammatical.slice(0, predicate.index).trim();
  if (!subject) return false;
  const head = predicate[1].toLowerCase();
  if (/^(?:are|is|was|were|do|does|must|shall|should|may|cannot|can not|will)$/.test(head)) return true;
  if (/^(?:commit|commits|references|sets|reads|writes|records)$/.test(head)) return false;
  return subject.split(/\s+/).length >= 2 || /^(?:a|an|the|it|they|this|that|these|those|we)\b/i.test(subject);
}

function hasEmbeddedClause(value: string): boolean {
  if (new RegExp(`\\s+(?:are|is|was|were|do|does|${MODAL_PREDICATE})\\b`, "i").test(value)) return true;
  const finite = new RegExp(`\\s+${SHARED_SUBJECT_FINITE_VERB}\\b`, "ig");
  for (const match of value.matchAll(finite)) {
    if (match.index === undefined) continue;
    const segment = value.slice(0, match.index).split(/,|\b(?:and|or)\b/i).at(-1)?.trim() ?? "";
    const words = segment.split(/\s+/).filter(Boolean);
    const head = match[0].trim().toLowerCase();
    const atEnd = match.index + match[0].length === value.length;
    if (atEnd && /^(?:commit|commits|read|reads|record|records|reference|references|set|sets|write|writes)$/.test(head)) continue;
    if (head === "sets" && /\b(?:between|of)\b/i.test(segment)) continue;
    if (words.length >= 2 && !/^(?:at|between|by|for|from|in|of|on|to|with|without)$/i.test(words.at(-1) ?? "")) {
      return true;
    }
  }
  return false;
}

function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inlineCode = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`") {
      inlineCode = !inlineCode;
      continue;
    }
    if (inlineCode) continue;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if ((character === ")" || character === "]" || character === "}") && depth > 0) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(normalizeClause(value.slice(start, index)));
      start = index + 1;
    }
  }
  parts.push(normalizeClause(value.slice(start)));
  return parts.filter(Boolean);
}

function expandIndependentClauses(sentence: string): string[] {
  const terminal = /[.!?;]$/.test(sentence) ? sentence.at(-1) ?? "" : "";
  const body = terminal ? sentence.slice(0, -1).trim() : sentence;
  const pieces = splitTopLevelCommas(body);
  if (pieces.length < 2 || pieces.length > 16) return [sentence];
  const clauses: string[] = [];
  let current = pieces[0];
  for (const piece of pieces.slice(1)) {
    if (clauseLike(current) && clauseLike(piece)) {
      clauses.push(current.replace(/^(?:and|or)\s+/i, ""));
      current = piece;
    } else {
      current = `${current}, ${piece}`;
    }
  }
  clauses.push(current.replace(/^(?:and|or)\s+/i, ""));
  if (clauses.length < 2 || !clauses.every(clauseLike)) return [sentence];
  return clauses.map((clause) => normalizeClause(`${clause}${terminal}`));
}

function expandIndependentColonClauses(sentence: string): string[] {
  const terminal = /[.!?;]$/.test(sentence) ? sentence.at(-1) ?? "" : "";
  const body = terminal ? sentence.slice(0, -1).trim() : sentence;
  let inlineCode = false;
  let depth = 0;
  let colon = -1;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "`") {
      inlineCode = !inlineCode;
      continue;
    }
    if (inlineCode) continue;
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if ((character === ")" || character === "]" || character === "}") && depth > 0) depth -= 1;
    else if (character === ":" && depth === 0) {
      if (colon >= 0) return [sentence];
      colon = index;
    }
  }
  if (colon < 0) return [sentence];
  const left = normalizeClause(body.slice(0, colon));
  const right = normalizeClause(body.slice(colon + 1));
  if (!clauseLike(left) || !clauseLike(right)) return [sentence];
  return [left, right].map((clause) => normalizeClause(`${clause}${terminal}`));
}

function expandConditionalAlternatives(sentence: string): string[] {
  const terminal = /[.!?;]$/.test(sentence) ? sentence.at(-1) ?? "" : "";
  const body = terminal ? sentence.slice(0, -1).trim() : sentence;
  const match = /^((?:if|when|unless)\s+)(.+?)\s+(is|are)\s+(.+),\s+(.+)$/i.exec(body);
  if (!match || !/\bor\b/i.test(match[4])) return [sentence];
  const alternatives = splitTopLevelNominals(match[4]);
  if (alternatives.length < 2 || alternatives.length > 8 ||
    alternatives.some((alternative) => alternative.length < 2 || alternative.length > 160 || clauseLike(alternative))) {
    return [sentence];
  }
  return alternatives.map((alternative) => normalizeClause(
    `${match[1]}${match[2]} ${match[3]} ${alternative}, ${match[5]}${terminal}`,
  ));
}

function expandRepeatedCopulaAlternatives(sentence: string): string[] {
  const terminal = /[.!?;]$/.test(sentence) ? sentence.at(-1) ?? "" : "";
  const body = terminal ? sentence.slice(0, -1).trim() : sentence;
  const match = /^(.*\bwhen\s+)(.+?)\s+(is|are)\s+(.+?)\s+or\s+\3\s+(.+)$/i.exec(body);
  if (!match || [match[2], match[4], match[5]].some((part) => part.length < 2 || part.length > 500)) return [sentence];
  return [
    normalizeClause(`${match[1]}${match[2]} ${match[3]} ${match[4]}${terminal}`),
    normalizeClause(`${match[1]}${match[2]} ${match[3]} ${match[5]}${terminal}`),
  ];
}

function predicateParts(value: string, allowOr: boolean): string[] {
  const conjunction = allowOr ? "(?:and|or)" : "and";
  const conjunctionPattern = new RegExp(
    `^((?:,\\s*(?:${conjunction}\\s+)?|\\s+${conjunction}\\s+))(?=${SHARED_SUBJECT_FINITE_VERB}\\b)`,
    "i",
  );
  const parts: string[] = [];
  let start = 0;
  let inlineCode = false;
  let depth = 0;
  let bareComma = false;
  let explicitConjunction = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`") {
      inlineCode = !inlineCode;
      continue;
    }
    if (inlineCode) continue;
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
      continue;
    }
    if ((character === ")" || character === "]" || character === "}") && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    const match = conjunctionPattern.exec(value.slice(index));
    if (!match) continue;
    if (/\b(?:and|or)\b/i.test(match[1])) explicitConjunction = true;
    else bareComma = true;
    const part = normalizeClause(value.slice(start, index));
    if (part) parts.push(part);
    index += match[1].length - 1;
    start = index + 1;
  }
  const tail = normalizeClause(value.slice(start));
  if (tail) parts.push(tail);
  if (bareComma && !explicitConjunction) return [value];
  return parts;
}

function predicateHasComplement(value: string): boolean {
  const normalized = normalizeClause(value)
    .replace(/^(?:also|always|atomically|exactly|finally|first|immediately|never|not|only|otherwise|permanently|subsequently|synchronously|then|therefore)\s+/i, "");
  const verb = new RegExp(`^${SHARED_SUBJECT_FINITE_VERB}\\b`, "i").exec(normalized);
  return Boolean(verb && normalizeClause(normalized.slice(verb[0].length)).length >= 2);
}

function expandSharedPredicateList(sentence: string): string[] {
  const terminal = /[.!?;]$/.test(sentence) ? sentence.at(-1) ?? "" : "";
  const body = terminal ? sentence.slice(0, -1).trim() : sentence;
  if (/^(?:when|if|unless|after|before|once|while|where|given|with|for)\b/i.test(body)) return [sentence];
  const context = "";
  const subjectAndPredicate = body;
  const predicatePattern = /\s+(are|is|must|shall|should|may|cannot|can not|will|throws?|rejects?|requires?|returns?|becomes?|remains?|increments?|increases?|uses?|includes?|contains?|accepts?|allows?|blocks?|causes?|produces?|stores?|has|have)\s+/gi;
  const match = predicatePattern.exec(subjectAndPredicate);
  if (!match || match.index === undefined) return [sentence];
  const subjectList = subjectAndPredicate.slice(0, match.index).trim();
  if (subjectList.includes(":")) return [sentence];
  if (hasEmbeddedClause(subjectList)) return [sentence];
  let subjects = splitTopLevelNominals(subjectList);
  if (subjects.length < 2 || subjects.length > 12 || subjects.some((subject) => subject.length < 2 || subject.length > 300)) {
    return [sentence];
  }
  const lastWords = subjects.at(-1)?.split(/\s+/) ?? [];
  if (lastWords.length >= 2) {
    const sharedHead = lastWords.at(-1) ?? "";
    subjects = subjects.map((subject, index) => {
      if (index === subjects.length - 1 || subject.split(/\s+/).at(-1)?.toLowerCase() === sharedHead.toLowerCase()) return subject;
      if (ELLIPTICAL_SUBJECT_MODIFIER.test(subject) || /^(?:any|each|every|no)\s+\S+$/i.test(subject)) {
        return `${subject} ${sharedHead}`;
      }
      return subject;
    });
  }
  const predicate = subjectAndPredicate.slice(match.index).trim();
  return subjects.map((subject) => {
    const subjectHead = subject.replace(/`/g, "").split(/\s+/).at(-1) ?? "";
    const singular = !subject.includes("`") && (!/s$/i.test(subjectHead) || /(?:ss|us|is)$/i.test(subjectHead));
    const adjustedPredicate = singular ? predicate.replace(/^are\b/i, "is") : predicate;
    return normalizeClause(`${context}${subject} ${adjustedPredicate}${terminal}`);
  });
}

function expandSharedSubjectPredicates(sentence: string): string[] {
  const terminal = /[.!?;]$/.test(sentence) ? sentence.at(-1) ?? "" : "";
  const body = terminal ? sentence.slice(0, -1).trim() : sentence;
  let context = "";
  let subjectAndPredicates = body;
  if (/^(?:when|if|unless|after|before|once|while|where|given|with|for each|for every)\b/i.test(body)) {
    const comma = topLevelComma(body);
    if (comma >= 0) {
      context = `${body.slice(0, comma + 1).trim()} `;
      subjectAndPredicates = body.slice(comma + 1).trim();
    }
  }

  const modalPredicate = new RegExp(`\\s+(${MODAL_PREDICATE})\\s+`, "i").exec(subjectAndPredicates);
  if (modalPredicate?.index !== undefined) {
    const subject = subjectAndPredicates.slice(0, modalPredicate.index).trim();
    if (subject && !subject.includes(":") && !hasEmbeddedClause(subject)) {
      const modal = modalPredicate[1];
      let predicates = subjectAndPredicates.slice(modalPredicate.index + modalPredicate[0].length).trim();
      const repeatedModal = modal.replace(/\s+/g, "\\s+");
      predicates = predicates.replace(new RegExp(`((?:,\\s*and|\\s+and)\\s+)${repeatedModal}\\s+`, "gi"), "$1");
      const parts = predicateParts(predicates, /^(?:cannot|can not)$/i.test(modal));
      if (parts.length >= 2 && parts.length <= 6 && parts.every(predicateHasComplement)) {
        const distributed = /^(always|atomically|immediately|never|not|synchronously)\s+/i.exec(parts[0])?.[1] ?? "";
        return parts.map((predicate, index) => normalizeClause(
          `${context}${subject} ${modal} ${index > 0 && distributed ? `${distributed} ` : ""}${predicate}${terminal}`,
        ));
      }
    }
  }

  const firstPredicate = new RegExp(`\\s+(${SHARED_SUBJECT_FINITE_VERB})\\b`, "i").exec(subjectAndPredicates);
  if (!firstPredicate || firstPredicate.index === undefined) return [sentence];
  const subject = subjectAndPredicates.slice(0, firstPredicate.index).trim();
  if (!subject || subject.includes(":")) return [sentence];
  if (new RegExp(`\\s+(?:are|is|was|were|do|does|${MODAL_PREDICATE})\\b`, "i").test(subject)) return [sentence];
  const pronounSubject = /^(it|they|we|this|that|these|those)(?:\s+(.+))?$/i.exec(subject);
  if (pronounSubject?.[2] && pronounSubject[2].split(/\s+/).some((word) =>
    !/^(?:also|always|atomically|exactly|finally|first|immediately|never|only|otherwise|permanently|subsequently|synchronously|then|therefore|\w+ly)$/i.test(word))) return [sentence];
  if (/\b(?:covers?|defines?|describes?|documents?|exposes?|handles?|lists?|manages?|models?|offers?|processes?|provides?|represents?|supports?)$/i.test(subject)) return [sentence];
  const predicates = subjectAndPredicates.slice(firstPredicate.index).trim();
  const parts = predicateParts(predicates, false);
  if (parts.length < 2 || parts.length > 6 || !parts.every(predicateHasComplement)) return [sentence];
  const repeatedSubject = pronounSubject
    ? [
      pronounSubject[1],
      ...(pronounSubject[2]?.split(/\s+/).filter((modifier) => !/^(?:never|only)$/i.test(modifier)) ?? []),
    ].join(" ")
    : subject;
  return parts.map((predicate, index) =>
    normalizeClause(`${context}${index === 0 ? subject : repeatedSubject} ${predicate}${terminal}`));
}

function semanticMarkdownAtoms(value: string): string[] {
  return splitSemanticSentences(value).flatMap(expandIndependentColonClauses).flatMap(expandIndependentClauses)
    .flatMap(expandConditionalAlternatives).flatMap(expandRepeatedCopulaAlternatives)
    .flatMap(expandSharedPredicateList).flatMap(expandSharedSubjectPredicates)
    .map(normalizeClause).filter((atom) => atom.length >= 8);
}

function markdownProofMode(atom: string, fencedBlock: boolean): PiContractObligation["proofMode"] {
  if (fencedBlock) return "positive";
  return /`[^`]+`|\b(?:all|always|atomic(?:ally)?|at least|at most|blocks?|byte-identical|cannot|canonical|conflict|corrupt|deduplicated|detached|do not|does not|error|every|exact(?:ly)?|fails?|failure|forbidden|idempotent|increments?|independent|invalid|must|never|no|non-negative|normative|only|ordered|overflow|preserves?|prohibited|required?|requires?|rejects?|remains?|returns?|safe integer|shall|stale_plan|terminal|throws?|through|unique|unsatisfiable)\b/i.test(atom)
    ? "paired"
    : "positive";
}

function markdownContractObligations(relativePath: string, content: string): RawContractObligation[] {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const obligations: RawContractObligation[] = [];
  let heading = relativePath;
  let startLine = 0;
  let block: string[] = [];
  let fenced = false;
  const flush = (endLine: number) => {
    const text = normalizeClause(block.join("\n"));
    block = [];
    if (text.length < 12) return;
    const surfaceMarker = /\[surface:([^\]]+)\]/.exec(text)?.[1]?.trim() ?? null;
    const fencedBlock = text.startsWith("```");
    const atoms = surfaceMarker || fencedBlock ? [text] : semanticMarkdownAtoms(text);
    atoms.forEach((atom, atomIndex) => {
      const lineLocator = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
      obligations.push({
        kind: "markdown-atom",
        proofMode: markdownProofMode(atom, fencedBlock),
        title: heading.slice(0, 200),
        semanticKey: surfaceMarker,
        source: {
          path: relativePath,
          locator: atoms.length === 1 ? lineLocator : `${lineLocator}#atom-${String(atomIndex + 1).padStart(3, "0")}`,
        },
        text: atom,
      });
    });
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (/^\s*```/.test(line)) {
      if (block.length) flush(lineNumber - 1);
      if (!fenced) {
        fenced = true;
        startLine = lineNumber;
        block = [line];
      } else {
        block.push(line);
        fenced = false;
        flush(lineNumber);
      }
      continue;
    }
    if (fenced) {
      block.push(line);
      continue;
    }
    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      if (block.length) flush(lineNumber - 1);
      heading = normalizeClause(headingMatch[1]);
      continue;
    }
    if (!line.trim()) {
      if (block.length) flush(lineNumber - 1);
      continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/.test(line) && block.length) flush(lineNumber - 1);
    if (!block.length) startLine = lineNumber;
    block.push(line);
  }
  if (block.length) flush(lines.length);
  if (!obligations.length && normalizeClause(content).length) {
    obligations.push({
      kind: "markdown-atom",
      proofMode: markdownProofMode(normalizeClause(content), false),
      title: heading.slice(0, 200),
      semanticKey: null,
      source: { path: relativePath, locator: "L1" },
      text: normalizeClause(content),
    });
  }
  return obligations;
}

function surfaceSemanticKey(section: string, value: unknown, index: number): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string" && record.id.trim()) return record.id.trim();
    if (section === "runtimeMethods" && typeof record.name === "string") return `method:${record.name}`;
  }
  if (section === "exports" && typeof value === "string") return `export:${value}`;
  return `${section}:${index}`;
}

function jsonContractObligations(relativePath: string, content: string): RawContractObligation[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { return markdownContractObligations(relativePath, content); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{
      kind: "structured-json",
      proofMode: "paired",
      title: relativePath,
      semanticKey: null,
      source: { path: relativePath, locator: "#/" },
      text: canonicalJson(parsed),
    }];
  }
  const root = parsed as Record<string, unknown>;
  const isSurface = Array.isArray(root.shapes) && root.conformanceChecks &&
    typeof root.conformanceChecks === "object" && !Array.isArray(root.conformanceChecks);
  const obligations: RawContractObligation[] = [];
  if (isSurface) {
    for (const section of ["exports", "runtimeMethods", "shapes", "errors", "operations"] as const) {
      const values = root[section];
      if (!Array.isArray(values)) continue;
      values.forEach((value, index) => {
        const semanticKey = surfaceSemanticKey(section, value, index);
        obligations.push({
          kind: "structured-surface",
          proofMode: "paired",
          title: semanticKey,
          semanticKey,
          source: { path: relativePath, locator: `#/${section}/${index}` },
          text: canonicalJson(value),
        });
      });
    }
    for (const [semanticKey, value] of Object.entries(root.conformanceChecks as Record<string, unknown>).sort(([left], [right]) => utf8Order(left, right))) {
      obligations.push({
        kind: "structured-surface",
        proofMode: "paired",
        title: semanticKey,
        semanticKey,
        source: { path: relativePath, locator: `#/conformanceChecks/${semanticKey.replaceAll("~", "~0").replaceAll("/", "~1")}` },
        text: canonicalJson({ conformanceCheck: value }),
      });
    }
    return obligations;
  }
  for (const [section, value] of Object.entries(root).sort(([left], [right]) => utf8Order(left, right))) {
    const entries = Array.isArray(value)
      ? value.map((item, index) => ({ item, locator: `#/${section}/${index}`, key: `${section}:${index}` }))
      : value && typeof value === "object"
        ? Object.entries(value as Record<string, unknown>).sort(([left], [right]) => utf8Order(left, right))
          .map(([key, item]) => ({ item, locator: `#/${section}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, key: `${section}:${key}` }))
        : [{ item: value, locator: `#/${section}`, key: section }];
    for (const entry of entries) {
      obligations.push({
        kind: "structured-json",
        proofMode: "paired",
        title: entry.key,
        semanticKey: null,
        source: { path: relativePath, locator: entry.locator },
        text: canonicalJson(entry.item),
      });
    }
  }
  return obligations;
}

async function compileContractObligations(
  root: string,
  contractPaths: string[],
  requestContract: PiRequestContract | null,
): Promise<PiContractObligation[]> {
  const raw: RawContractObligation[] = [];
  for (const relativePath of contractPaths) {
    const content = await fs.readFile(join(root, ...relativePath.split("/")), "utf8");
    raw.push(...(relativePath.toLowerCase().endsWith(".json")
      ? jsonContractObligations(relativePath, content)
      : markdownContractObligations(relativePath, content)));
  }
  if (requestContract) {
    raw.push(...markdownContractObligations(requestContract.sourcePath, requestContract.text));
  }
  const groups = new Map<string, RawContractObligation[]>();
  raw.forEach((obligation, index) => {
    const key = obligation.semanticKey ? `semantic:${obligation.semanticKey}` : `source:${index}`;
    const group = groups.get(key) ?? [];
    group.push(obligation);
    groups.set(key, group);
  });
  if (groups.size > MAX_CONTRACT_OBLIGATIONS) {
    throw new Error(`Frontier discovered ${groups.size} contract obligations; the supported maximum is ${MAX_CONTRACT_OBLIGATIONS}`);
  }
  return [...groups.values()].map((group) => {
    const sources = [...new Map(group.map((item) => [`${item.source.path}\0${item.source.locator}`, item.source])).values()]
      .sort((left, right) => utf8Order(left.path, right.path) || utf8Order(left.locator, right.locator));
    const texts = [...new Set(group.map((item) => item.text))].sort(utf8Order);
    const content = canonicalJson({ sources, texts });
    const contentSha256 = sha256(content);
    const primary = group.find((item) => item.kind === "structured-surface") ?? group[0];
    return {
      id: `obligation-${contentSha256.slice(0, 20)}`,
      kind: group.some((item) => item.kind === "structured-surface") ? "structured-surface" : primary.kind,
      proofMode: group.some((item) => item.proofMode === "paired") ? "paired" : "positive",
      title: primary.title.slice(0, 200),
      sources,
      contentSha256,
      excerpt: texts.join(" | ").slice(0, 1_200),
    } satisfies PiContractObligation;
  }).sort((left, right) => utf8Order(left.sources[0]?.path ?? "", right.sources[0]?.path ?? "") ||
    utf8Order(left.sources[0]?.locator ?? "", right.sources[0]?.locator ?? "") || utf8Order(left.id, right.id));
}

function pathDepth(value: string): number {
  return value.split("/").length;
}

function commandId(prefix: string, cwdRelative: string, suffix = "test"): string {
  return `${prefix}-${cwdRelative === "." ? "root" : cwdRelative.replace(/[^a-zA-Z0-9]+/g, "-")}-${suffix}`
    .toLowerCase()
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function packageManagerFor(packagePath: string, packageJson: Record<string, unknown>, tracked: Set<string>): string {
  const declared = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]
    : "";
  if (["npm", "pnpm", "yarn", "bun"].includes(declared)) return declared;
  const directory = packagePath.includes("/") ? dirname(packagePath).replaceAll("\\", "/") : ".";
  const at = (name: string) => directory === "." ? name : `${directory}/${name}`;
  if (tracked.has(at("pnpm-lock.yaml"))) return "pnpm";
  if (tracked.has(at("yarn.lock"))) return "yarn";
  if (tracked.has(at("bun.lock")) || tracked.has(at("bun.lockb"))) return "bun";
  return "npm";
}

function inferredContractPaths(paths: string[]): string[] {
  return paths.filter((file) => {
    const lower = file.toLowerCase();
    const name = lower.split("/").at(-1) || lower;
    return lower.startsWith("docs/") ||
      lower.includes("/docs/") ||
      lower.startsWith("spec/") ||
      lower.includes("/spec/") ||
      /^readme(?:\.|$)/.test(name) ||
      /^(?:surface|public-surface|api-contract|openapi|asyncapi)(?:\.|$)/.test(name) ||
      /^(?:architecture|contract|specification|requirements|contributing)(?:\.|$)/.test(name) ||
      /(?:^|\/)adr[s]?\//.test(lower);
  }).sort(utf8Order);
}

function validateResolvedCwd(root: string, cwdRelative: string): string {
  const target = cwdRelative === "." ? root : resolve(root, ...cwdRelative.split("/"));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Verification cwd escapes the workspace: ${cwdRelative}`);
  }
  return target;
}

async function inferCommands(root: string, paths: string[]): Promise<PiVerificationCommand[]> {
  const tracked = new Set(paths);
  const commands: PiVerificationCommand[] = [];
  const manifests = paths.filter((file) => [
    "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "pytest.ini",
    "setup.cfg", "tox.ini", "pom.xml", "build.gradle", "build.gradle.kts", "Makefile",
  ].includes(file.split("/").at(-1) || "")).sort((left, right) => pathDepth(left) - pathDepth(right) || utf8Order(left, right));
  for (const sourcePath of manifests) {
    if (commands.length >= MAX_COMMANDS) break;
    const name = sourcePath.split("/").at(-1) || sourcePath;
    const cwdRelative = sourcePath.includes("/") ? dirname(sourcePath).replaceAll("\\", "/") : ".";
    validateResolvedCwd(root, cwdRelative);
    if (name === "package.json") {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(await fs.readFile(join(root, ...sourcePath.split("/")), "utf8")); }
      catch { continue; }
      const scripts = parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
        ? parsed.scripts as Record<string, unknown>
        : {};
      const manager = packageManagerFor(sourcePath, parsed, tracked);
      for (const script of ["test", "typecheck"] as const) {
        const body = scripts[script];
        if (typeof body !== "string" || !body.trim()) continue;
        if (script === "test" && /no test specified/i.test(body)) continue;
        commands.push({
          id: commandId(manager, cwdRelative, script),
          command: manager,
          args: manager === "npm" ? ["run", script, "--if-present"] : ["run", script],
          cwdRelative,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          source: "package-json",
          sourcePath,
        });
        if (commands.length >= MAX_COMMANDS) break;
      }
      continue;
    }
    const add = (command: string, args: string[], source: PiVerificationCommandSource) => commands.push({
      id: commandId(source, cwdRelative), command, args, cwdRelative,
      timeoutMs: DEFAULT_TIMEOUT_MS, source, sourcePath,
    });
    if (name === "Cargo.toml") add("cargo", ["test", "--all-targets"], "cargo");
    else if (name === "go.mod") add("go", ["test", "./..."], "go");
    else if (["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].includes(name) &&
      !commands.some((command) => command.source === "python" && command.cwdRelative === cwdRelative)) {
      add("python", ["-m", "pytest"], "python");
    } else if (name === "pom.xml") {
      const wrapper = cwdRelative === "." ? "mvnw" : `${cwdRelative}/mvnw`;
      add(tracked.has(wrapper) ? "./mvnw" : "mvn", ["test"], "maven");
    } else if (name === "build.gradle" || name === "build.gradle.kts") {
      const wrapper = cwdRelative === "." ? "gradlew" : `${cwdRelative}/gradlew`;
      add(tracked.has(wrapper) ? "./gradlew" : "gradle", ["test"], "gradle");
    } else if (name === "Makefile") {
      const body = await fs.readFile(join(root, ...sourcePath.split("/")), "utf8").catch(() => "");
      if (/^test\s*:/m.test(body)) add("make", ["test"], "make");
    }
  }
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.cwdRelative}\0${command.command}\0${command.args.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_COMMANDS);
}

async function readExplicitConfig(root: string, tracked: Set<string>): Promise<FrontierConfig | null> {
  const configPath = ".codara/frontier.json";
  if (!tracked.has(configPath)) return null;
  const parsed: unknown = JSON.parse(await fs.readFile(join(root, ".codara", "frontier.json"), "utf8"));
  return parseFrontierConfig(parsed);
}

export async function discoverPiFrontierVerification(
  cwd: string,
  userRequest?: string,
): Promise<PiFrontierVerificationManifest> {
  const workspaceRoot = await resolveGitRoot(cwd);
  const trackedEntries = await readTrackedEntries(workspaceRoot);
  const trackedPaths = trackedEntries.map((entry) => entry.path);
  const tracked = new Set(trackedPaths);
  const normalizedRequest = userRequest?.replaceAll("\r\n", "\n").trim() ?? "";
  if (normalizedRequest.length > 256_000 || normalizedRequest.includes("\0")) {
    throw new Error("Frontier user request must be bounded UTF-8 text without NUL bytes");
  }
  const requestSourcePath = ".codara/__codara_user_request__.md" as const;
  if (normalizedRequest && tracked.has(requestSourcePath)) {
    throw new Error(`Frontier reserved request-contract path is tracked: ${requestSourcePath}`);
  }
  const requestContract: PiRequestContract | null = normalizedRequest
    ? { sourcePath: requestSourcePath, contentSha256: sha256(normalizedRequest), text: normalizedRequest }
    : null;
  const explicit = await readExplicitConfig(workspaceRoot, tracked);
  const contractPaths = explicit?.contractPaths.length
    ? trackedPaths.filter((file) => explicit.contractPaths.some((scope) => file === scope || file.startsWith(`${scope}/`)))
    : inferredContractPaths(trackedPaths);
  const contractEntries = trackedEntries.filter((entry) => contractPaths.includes(entry.path));
  const contractObligations = await compileContractObligations(workspaceRoot, contractPaths, requestContract);
  const sourceManifests = explicit
    ? [".codara/frontier.json"]
    : trackedPaths.filter((file) => [
        "package.json", "Cargo.toml", "go.mod", "pyproject.toml", "pytest.ini",
        "setup.cfg", "tox.ini", "pom.xml", "build.gradle", "build.gradle.kts", "Makefile",
      ].includes(file.split("/").at(-1) || ""));
  const commands = explicit
    ? explicit.commands.map<PiVerificationCommand>((command) => {
        validateResolvedCwd(workspaceRoot, command.cwd);
        return {
          id: command.id,
          command: command.command,
          args: command.args,
          cwdRelative: command.cwd,
          timeoutMs: command.timeoutMs,
          source: "codara-config",
          sourcePath: ".codara/frontier.json",
        };
      })
    : await inferCommands(workspaceRoot, trackedPaths);
  const untracked = (await gitText(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0").filter(Boolean);
  const cacheIneligibilityReasons: string[] = [];
  if (untracked.length) cacheIneligibilityReasons.push("workspace contains untracked, non-ignored files");
  if (trackedEntries.some((entry) => entry.mode === "160000")) {
    cacheIneligibilityReasons.push("workspace contains a Git submodule whose working tree is outside the exact-state fingerprint");
  }
  if (!contractEntries.length) cacheIneligibilityReasons.push("no tracked contract surface was discovered");
  if (!commands.length) cacheIneligibilityReasons.push("no verification command was discovered or configured");
  return {
    schemaVersion: 4,
    workspaceRoot,
    trackedTreeSha256: treeSha256(trackedEntries),
    contractTreeSha256: contractEntries.length ? treeSha256(contractEntries) : null,
    cacheEligible: cacheIneligibilityReasons.length === 0,
    cacheIneligibilityReasons,
    contractPaths: contractPaths.sort(utf8Order),
    requestContract,
    contractObligations,
    sourceManifests: [...new Set(sourceManifests)].sort(utf8Order),
    commands,
    frontierPolicy: piFrontierDepthPolicy(contractPaths.length + (requestContract ? 1 : 0), contractObligations.length),
  };
}

export function verificationManifestSha256(manifest: PiFrontierVerificationManifest): string {
  return sha256(JSON.stringify(manifest));
}

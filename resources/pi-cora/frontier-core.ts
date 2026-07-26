import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type FrontierVerificationCommand = {
  id: string;
  command: string;
  args: string[];
  cwdRelative: string;
  timeoutMs: number;
  source: string;
  sourcePath: string;
};

export type FrontierDepthPolicy = {
  schemaVersion: 3;
  targetCuts: number;
  minFamilies: number;
  minOperations: number;
  minDeepFamilies: number;
  minCriticalFamilies: number;
  maxObligationsPerCut: number;
  maxObligationsPerProbe: number;
  minCounterfactualFamilies: number;
};

export type FrontierContractObligation = {
  id: string;
  kind: "markdown-atom" | "structured-surface" | "structured-json";
  proofMode: "paired" | "positive";
  title: string;
  sources: Array<{ path: string; locator: string }>;
  contentSha256: string;
  excerpt: string;
};

export type FrontierVerificationManifest = {
  schemaVersion: 4;
  workspaceRoot: string;
  trackedTreeSha256: string;
  contractTreeSha256: string | null;
  cacheEligible: boolean;
  cacheIneligibilityReasons: string[];
  contractPaths: string[];
  requestContract: {
    sourcePath: ".codara/__codara_user_request__.md";
    contentSha256: string;
    text: string;
  } | null;
  contractObligations: FrontierContractObligation[];
  sourceManifests: string[];
  commands: FrontierVerificationCommand[];
  frontierPolicy: FrontierDepthPolicy;
};

export type FrontierDiffFingerprint = {
  sha256: string;
  changedHunks: number;
  untrackedFiles: number;
  hunks: Array<{
    id: string;
    kind: "tracked" | "untracked";
    locator: string;
  }>;
};

const SHA256 = /^[a-f0-9]{64}$/;
const COMMAND = /^(?:[A-Za-z0-9._@+-]+|\.\/[A-Za-z0-9._@+/-]+)$/;
const MAX_BYTES = 768 * 1024 * 1024;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys must be exactly ${expected.join(", ")}`);
  }
}

function string(value: unknown, label: string, max = 1_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function stringList(value: unknown, label: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} strings`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function safeRelative(value: unknown, label: string, allowDot = false): string {
  if (allowDot && value === ".") return ".";
  const text = string(value, label).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (path.isAbsolute(text) || text.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be workspace-relative`);
  }
  return text;
}

function inside(root: string, relativePath: string): string {
  const target = relativePath === "." ? root : path.resolve(root, ...relativePath.split("/"));
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes Frontier workspace: ${relativePath}`);
  }
  return target;
}

function expectedDepthPolicy(contractPathCount: number, obligationCount: number): FrontierDepthPolicy {
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

export function parseFrontierVerificationManifest(value: unknown): FrontierVerificationManifest {
  exactKeys(value, [
    "schemaVersion", "workspaceRoot", "trackedTreeSha256", "contractTreeSha256",
    "cacheEligible", "cacheIneligibilityReasons", "contractPaths", "requestContract", "contractObligations", "sourceManifests", "commands", "frontierPolicy",
  ], "manifest");
  if (value.schemaVersion !== 4) throw new Error("manifest.schemaVersion must be 4");
  const workspaceRoot = path.resolve(string(value.workspaceRoot, "manifest.workspaceRoot", 4_096));
  if (!path.isAbsolute(value.workspaceRoot as string)) throw new Error("manifest.workspaceRoot must be absolute");
  if (typeof value.trackedTreeSha256 !== "string" || !SHA256.test(value.trackedTreeSha256)) {
    throw new Error("manifest.trackedTreeSha256 is invalid");
  }
  if (value.contractTreeSha256 !== null &&
    (typeof value.contractTreeSha256 !== "string" || !SHA256.test(value.contractTreeSha256))) {
    throw new Error("manifest.contractTreeSha256 is invalid");
  }
  if (typeof value.cacheEligible !== "boolean") throw new Error("manifest.cacheEligible must be boolean");
  const cacheIneligibilityReasons = stringList(value.cacheIneligibilityReasons, "manifest.cacheIneligibilityReasons", 16);
  if (value.cacheEligible !== (cacheIneligibilityReasons.length === 0)) {
    throw new Error("manifest.cacheEligible must agree with cacheIneligibilityReasons");
  }
  const contractPaths = stringList(value.contractPaths, "manifest.contractPaths", 30_000)
    .map((entry, index) => safeRelative(entry, `manifest.contractPaths[${index}]`));
  let requestContract: FrontierVerificationManifest["requestContract"] = null;
  if (value.requestContract !== null) {
    exactKeys(value.requestContract, ["sourcePath", "contentSha256", "text"], "manifest.requestContract");
    const sourcePath = safeRelative(value.requestContract.sourcePath, "manifest.requestContract.sourcePath");
    if (sourcePath !== ".codara/__codara_user_request__.md" || contractPaths.includes(sourcePath)) {
      throw new Error("manifest.requestContract.sourcePath is invalid or collides with tracked contractPaths");
    }
    const text = string(value.requestContract.text, "manifest.requestContract.text", 256_000);
    if (typeof value.requestContract.contentSha256 !== "string" || !SHA256.test(value.requestContract.contentSha256) ||
      hash(text) !== value.requestContract.contentSha256) {
      throw new Error("manifest.requestContract.contentSha256 is invalid");
    }
    requestContract = { sourcePath, contentSha256: value.requestContract.contentSha256, text } as FrontierVerificationManifest["requestContract"];
  }
  const contractSourcePaths = requestContract ? [...contractPaths, requestContract.sourcePath] : contractPaths;
  if (!Array.isArray(value.contractObligations) || value.contractObligations.length > 2_048) {
    throw new Error("manifest.contractObligations must contain at most 2048 entries");
  }
  const contractObligations = value.contractObligations.map((entry, index) => {
    const label = `manifest.contractObligations[${index}]`;
    exactKeys(entry, ["id", "kind", "proofMode", "title", "sources", "contentSha256", "excerpt"], label);
    const id = string(entry.id, `${label}.id`, 96);
    if (!/^obligation-[a-f0-9]{20}$/.test(id)) throw new Error(`${label}.id is invalid`);
    if (entry.kind !== "markdown-atom" && entry.kind !== "structured-surface" && entry.kind !== "structured-json") {
      throw new Error(`${label}.kind is invalid`);
    }
    if (entry.proofMode !== "paired" && entry.proofMode !== "positive") throw new Error(`${label}.proofMode is invalid`);
    if (!Array.isArray(entry.sources) || !entry.sources.length || entry.sources.length > 16) {
      throw new Error(`${label}.sources must contain 1-16 entries`);
    }
    const sources = entry.sources.map((source, sourceIndex) => {
      exactKeys(source, ["path", "locator"], `${label}.sources[${sourceIndex}]`);
      const sourcePath = safeRelative(source.path, `${label}.sources[${sourceIndex}].path`);
      if (!contractSourcePaths.includes(sourcePath)) throw new Error(`${label}.sources[${sourceIndex}].path is outside the signed contract sources`);
      return {
        path: sourcePath,
        locator: string(source.locator, `${label}.sources[${sourceIndex}].locator`, 500),
      };
    });
    if (typeof entry.contentSha256 !== "string" || !SHA256.test(entry.contentSha256)) throw new Error(`${label}.contentSha256 is invalid`);
    return {
      id,
      kind: entry.kind,
      proofMode: entry.proofMode,
      title: string(entry.title, `${label}.title`, 200),
      sources,
      contentSha256: entry.contentSha256,
      excerpt: string(entry.excerpt, `${label}.excerpt`, 1_200),
    } as FrontierContractObligation;
  });
  if (new Set(contractObligations.map((obligation) => obligation.id)).size !== contractObligations.length) {
    throw new Error("manifest contract obligation ids must be unique");
  }
  const sourceManifests = stringList(value.sourceManifests, "manifest.sourceManifests", 256)
    .map((entry, index) => safeRelative(entry, `manifest.sourceManifests[${index}]`));
  exactKeys(value.frontierPolicy, [
    "schemaVersion", "targetCuts", "minFamilies", "minOperations", "minDeepFamilies", "minCriticalFamilies",
    "maxObligationsPerCut", "maxObligationsPerProbe", "minCounterfactualFamilies",
  ], "manifest.frontierPolicy");
  const expectedPolicy = expectedDepthPolicy(contractSourcePaths.length, contractObligations.length);
  for (const [key, expected] of Object.entries(expectedPolicy)) {
    if (value.frontierPolicy[key] !== expected) {
      throw new Error(`manifest.frontierPolicy.${key} must equal ${expected}`);
    }
  }
  const frontierPolicy = value.frontierPolicy as unknown as FrontierDepthPolicy;
  if (!Array.isArray(value.commands) || value.commands.length > 12) throw new Error("manifest.commands must contain at most 12 entries");
  const commands = value.commands.map((entry, index) => {
    exactKeys(entry, ["id", "command", "args", "cwdRelative", "timeoutMs", "source", "sourcePath"], `manifest.commands[${index}]`);
    const id = string(entry.id, `manifest.commands[${index}].id`, 80);
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(id)) throw new Error(`manifest.commands[${index}].id invalid`);
    const command = string(entry.command, `manifest.commands[${index}].command`, 240);
    if (!COMMAND.test(command) || command.split("/").includes("..")) throw new Error(`manifest.commands[${index}].command invalid`);
    const args = stringList(entry.args, `manifest.commands[${index}].args`, 64);
    const cwdRelative = safeRelative(entry.cwdRelative, `manifest.commands[${index}].cwdRelative`, true);
    inside(workspaceRoot, cwdRelative);
    if (!Number.isSafeInteger(entry.timeoutMs) || Number(entry.timeoutMs) < 5_000 || Number(entry.timeoutMs) > 1_800_000) {
      throw new Error(`manifest.commands[${index}].timeoutMs invalid`);
    }
    return {
      id,
      command,
      args,
      cwdRelative,
      timeoutMs: Number(entry.timeoutMs),
      source: string(entry.source, `manifest.commands[${index}].source`, 80),
      sourcePath: safeRelative(entry.sourcePath, `manifest.commands[${index}].sourcePath`),
    };
  });
  if (new Set(commands.map((command) => command.id)).size !== commands.length) throw new Error("manifest command ids must be unique");
  return {
    schemaVersion: 4,
    workspaceRoot,
    trackedTreeSha256: value.trackedTreeSha256,
    contractTreeSha256: value.contractTreeSha256 as string | null,
    cacheEligible: value.cacheEligible,
    cacheIneligibilityReasons,
    contractPaths,
    requestContract,
    contractObligations,
    sourceManifests,
    commands,
    frontierPolicy,
  };
}

export function loadFrontierVerificationManifest(
  filePath: string,
  expectedSha256: string,
): FrontierVerificationManifest {
  if (!SHA256.test(expectedSha256)) throw new Error("Frontier manifest expected SHA-256 is invalid");
  const bytes = fs.readFileSync(path.resolve(filePath));
  if (hash(bytes) !== expectedSha256) throw new Error("Frontier verification manifest hash mismatch");
  return parseFrontierVerificationManifest(JSON.parse(bytes.toString("utf8")));
}

function trackedRecords(root: string): Array<{ mode: string; objectId: string; relativePath: string }> {
  const result = spawnSync("git", ["-C", root, "ls-files", "--cached", "--stage", "-z"], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) throw new Error("Frontier could not read the Git index");
  const records = result.stdout.toString("utf8").split("\0").filter(Boolean);
  if (!records.length || records.length > 30_000) throw new Error("Frontier tracked-file count is outside 1-30000");
  return records.map((record) => {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) \d+\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Frontier could not parse the Git index");
    const relativePath = safeRelative(match[3], "tracked path");
    return { mode: match[1], objectId: match[2], relativePath };
  }).sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
}

export function trackedWorkspaceTreeSha256(root: string): string {
  const resolved = path.resolve(root);
  let totalBytes = 0;
  const entries = trackedRecords(resolved).map(({ mode, objectId, relativePath }) => {
    if (mode === "160000") return `${mode}\0${relativePath}\0${objectId.length}\0${hash(objectId)}`;
    const target = inside(resolved, relativePath);
    const stat = fs.lstatSync(target);
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(target))
      : stat.isFile()
        ? fs.readFileSync(target)
        : null;
    if (!bytes) throw new Error(`Frontier tracked path is unsupported: ${relativePath}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BYTES) throw new Error("Frontier tracked workspace exceeds 768 MiB");
    return `${mode}\0${relativePath}\0${bytes.byteLength}\0${hash(bytes)}`;
  });
  return hash(entries.join("\0"));
}

/**
 * Recompute only the signed contract surface using the same byte-level tree
 * encoding as the launch-time manifest. This deliberately reads working-tree
 * bytes (not HEAD blobs): a user, worker, or external process changing a
 * tracked requirement must invalidate the admitted semantic atlas immediately.
 */
export function contractWorkspaceTreeSha256(root: string, contractPaths: string[]): string | null {
  const resolved = path.resolve(root);
  const wanted = new Set(contractPaths.map((entry, index) =>
    safeRelative(entry, `contractPaths[${index}]`)));
  if (wanted.size !== contractPaths.length) throw new Error("Frontier contract paths must be unique");
  const records = trackedRecords(resolved).filter(({ relativePath }) => wanted.has(relativePath));
  if (records.length !== wanted.size) throw new Error("Frontier contract surface changed tracked membership");
  let totalBytes = 0;
  const entries = records.map(({ mode, objectId, relativePath }) => {
    if (mode === "160000") return `${mode}\0${relativePath}\0${objectId.length}\0${hash(objectId)}`;
    const target = inside(resolved, relativePath);
    const stat = fs.lstatSync(target);
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(target))
      : stat.isFile()
        ? fs.readFileSync(target)
        : null;
    if (!bytes) throw new Error(`Frontier contract path is unsupported: ${relativePath}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BYTES) throw new Error("Frontier contract surface exceeds 768 MiB");
    return `${mode}\0${relativePath}\0${bytes.byteLength}\0${hash(bytes)}`;
  });
  return entries.length ? hash(entries.join("\0")) : null;
}

function gitBuffer(root: string, args: string[], maxBuffer = 96 * 1024 * 1024): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer });
  if (result.status !== 0 || result.error) throw new Error(`Frontier git ${args[0]} failed`);
  return result.stdout;
}

export function frontierDiffFingerprint(root: string): FrontierDiffFingerprint {
  const resolved = path.resolve(root);
  const patch = gitBuffer(resolved, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
  const untracked = gitBuffer(resolved, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8").split("\0").filter(Boolean).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (untracked.length > 128) throw new Error("Frontier diff contains more than 128 untracked files");
  let totalBytes = patch.byteLength;
  const untrackedEntries: string[] = [];
  for (const relativePath of untracked) {
    const safePath = safeRelative(relativePath, "untracked path");
    const target = inside(resolved, safePath);
    const stat = fs.lstatSync(target);
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(target))
      : stat.isFile()
        ? fs.readFileSync(target)
        : null;
    if (!bytes) throw new Error(`Frontier untracked path is unsupported: ${safePath}`);
    totalBytes += bytes.byteLength;
    if (totalBytes > 128 * 1024 * 1024) throw new Error("Frontier diff fingerprint exceeds 128 MiB");
    untrackedEntries.push(`${safePath}\0${stat.mode & 0o111}\0${hash(bytes)}`);
  }
  const hunks: FrontierDiffFingerprint["hunks"] = [];
  const patchLines = patch.toString("utf8").split(/\r?\n/);
  let fileOrdinal = 0;
  let hunkOrdinal = 0;
  let fileLocator = "";
  let fileHasHunk = false;
  const cleanLocator = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
  const finishFile = () => {
    if (fileOrdinal > 0 && !fileHasHunk) {
      hunks.push({
        id: `tracked-${fileOrdinal}-change-${hash(fileLocator).slice(0, 12)}`,
        kind: "tracked",
        locator: cleanLocator(`${fileLocator} (binary, rename, mode, or whole-file change)`),
      });
    }
  };
  for (const line of patchLines) {
    if (line.startsWith("diff --git ")) {
      finishFile();
      fileOrdinal += 1;
      hunkOrdinal = 0;
      fileHasHunk = false;
      fileLocator = line;
      continue;
    }
    if (line.startsWith("@@")) {
      hunkOrdinal += 1;
      fileHasHunk = true;
      const locator = cleanLocator(`${fileLocator} ${line}`);
      hunks.push({
        id: `tracked-${fileOrdinal}-hunk-${hunkOrdinal}-${hash(locator).slice(0, 12)}`,
        kind: "tracked",
        locator,
      });
    }
  }
  finishFile();
  untracked.forEach((relativePath, index) => hunks.push({
    id: `untracked-${index + 1}-${hash(relativePath).slice(0, 12)}`,
    kind: "untracked",
    locator: cleanLocator(relativePath),
  }));
  if (hunks.length > 4_096) throw new Error("Frontier diff contains more than 4096 changed hunks");
  return {
    sha256: hash(Buffer.concat([patch, Buffer.from(`\0${untrackedEntries.join("\0")}`)])),
    changedHunks: hunks.length,
    untrackedFiles: untracked.length,
    hunks,
  };
}

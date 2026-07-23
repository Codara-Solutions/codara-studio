import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ChatMode, CoraExecutionPolicy } from "@shared/types";

import { resolveBundledResourcePath } from "../bundled-resources";
import { sparkHome } from "../spark-home";
import { writeFileAtomic } from "../fs-atomic";
import {
  admissionArtifactSha256,
  artifactFromPiFrontierAdmission,
  createPiFrontierAdmissionEntryFromEvidence,
  emptyPiFrontierAdmissionCache,
  parsePiFrontierAdmissionCache,
  recallPiFrontierAdmission,
  upsertPiFrontierAdmission,
  type PiFrontierAdmissionCache,
} from "./pi-admission-cache";
import {
  discoverPiFrontierVerification,
  verificationManifestSha256,
  type PiFrontierVerificationManifest,
} from "./pi-verification";
import {
  buildPiManagerLaunchPlan,
  inspectPiSubscriptionAuth,
  resolvePinnedPiRuntime,
  type PiManagerLaunchPlan,
  type PiSubscriptionAuthStatus,
  type PiSubscriptionProvider,
  type PiThinkingLevel,
  type PiRuntimeLocation,
} from "./pi-runtime";

export interface CodaraPiPaths {
  configDir: string;
  authFile: string;
  sessionDir: string;
  bridgePath: string;
  extensionPath: string;
  workerExtensionPath: string;
  frontierExtensionPath: string;
  frontierManifestDir: string;
  frontierAdmissionCachePath: string;
  managedAgentDir: string;
  managedAgentSources: string[];
}

export interface CreateCodaraPiLaunchOptions {
  provider: PiSubscriptionProvider;
  runId: string;
  mode: "talk" | "execute" | "automation";
  chatMode?: ChatMode;
  executionPolicy?: CoraExecutionPolicy;
  sessionId: string;
  cwd: string;
  model?: string;
  thinking?: PiThinkingLevel;
  sessionName?: string;
  contractPrompt?: string;
}

function codaraPiBridgePath(): string {
  const bundled = resolveBundledResourcePath("codara-studio-mcp", "server.js");
  const smokeOverride = process.env.CODARA_PI_SMOKE_BRIDGE_PATH?.trim();
  if (!smokeOverride) return bundled;
  if (process.env.CODARA_ALLOW_LIVE_PI_SMOKE !== "1" || app.isPackaged) {
    throw new Error("The isolated Pi bridge override is available only to explicit development smoke runs");
  }
  if (!isAbsolute(smokeOverride) || !existsSync(smokeOverride)) {
    throw new Error("The isolated Pi smoke bridge must be an existing absolute path");
  }
  return smokeOverride;
}

export function codaraPiPaths(): CodaraPiPaths {
  const configDir = join(sparkHome(), "pi-agent");
  return {
    configDir,
    authFile: join(configDir, "auth.json"),
    sessionDir: join(configDir, "sessions"),
    bridgePath: codaraPiBridgePath(),
    extensionPath: resolveBundledResourcePath("pi-cora", "index.ts"),
    workerExtensionPath: resolveBundledResourcePath("pi-cora", "worker.ts"),
    frontierExtensionPath: resolveBundledResourcePath("pi-cora", "frontier-gate.ts"),
    frontierManifestDir: join(configDir, "frontier", "manifests"),
    frontierAdmissionCachePath: join(configDir, "frontier", "admission-cache.json"),
    managedAgentDir: join(configDir, "agents"),
    managedAgentSources: [
      resolveBundledResourcePath("pi-cora", "agents", "codara-frontier-contract-tracer.md"),
      resolveBundledResourcePath("pi-cora", "agents", "codara-frontier-contract-auditor.md"),
      resolveBundledResourcePath("pi-cora", "agents", "codara-frontier-diff-auditor.md"),
      resolveBundledResourcePath("pi-cora", "agents", "codara-frontier-family-auditor.md"),
      resolveBundledResourcePath("pi-cora", "agents", "codara-frontier-integration-auditor.md"),
    ],
  };
}

function developmentNodeModulesRoots(): string[] {
  const roots: string[] = [];
  let current = app.getAppPath();
  for (let depth = 0; depth <= 4; depth += 1) {
    roots.push(join(current, "node_modules"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

export async function resolveCodaraPiRuntime(): Promise<PiRuntimeLocation> {
  const roots = app.isPackaged
    ? [
        join(process.resourcesPath, "app.asar", "node_modules"),
        join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
      ]
    : developmentNodeModulesRoots();
  return resolvePinnedPiRuntime(roots);
}

export async function inspectCodaraPiAuth(
  provider: PiSubscriptionProvider,
): Promise<PiSubscriptionAuthStatus> {
  const paths = codaraPiPaths();
  return inspectPiSubscriptionAuth(paths.authFile, provider);
}

export async function createCodaraPiLaunchPlan(
  options: CreateCodaraPiLaunchOptions,
): Promise<PiManagerLaunchPlan> {
  const paths = codaraPiPaths();
  const frontierEnabled = options.mode === "execute" && options.executionPolicy === "frontier";
  const [runtime, auth, frontierManifest] = await Promise.all([
    resolveCodaraPiRuntime(),
    inspectPiSubscriptionAuth(paths.authFile, options.provider),
    frontierEnabled ? discoverPiFrontierVerification(options.cwd, options.contractPrompt) : Promise.resolve(null),
  ]);
  if (auth.expired && !auth.canRefresh) {
    throw new Error(`Pi provider ${options.provider} OAuth session expired and cannot refresh`);
  }
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }),
    ...(frontierEnabled
      ? [
          mkdir(paths.frontierManifestDir, { recursive: true, mode: 0o700 }),
          mkdir(paths.managedAgentDir, { recursive: true, mode: 0o700 }),
        ]
      : []),
  ]);
  let frontierManifestPath: string | undefined;
  let frontierManifestSha256: string | undefined;
  let frontierAdmissionArtifactPath: string | undefined;
  let frontierAdmissionArtifactSha256: string | undefined;
  if (frontierManifest) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(options.runId)) {
      throw new Error("Codara run id cannot be used as a Frontier manifest filename");
    }
    frontierManifestPath = join(paths.frontierManifestDir, `${options.runId}.json`);
    frontierManifestSha256 = verificationManifestSha256(frontierManifest);
    await writeFileAtomic(frontierManifestPath, JSON.stringify(frontierManifest));
    if (process.platform !== "win32") await chmod(frontierManifestPath, 0o600);
    await Promise.all(paths.managedAgentSources.map(async (sourcePath) => {
      const target = join(paths.managedAgentDir, basename(sourcePath));
      await writeFileAtomic(target, await readFile(sourcePath, "utf8"));
      if (process.platform !== "win32") await chmod(target, 0o600);
    }));
    try {
      const cache = parsePiFrontierAdmissionCache(JSON.parse(await readFile(paths.frontierAdmissionCachePath, "utf8")));
      const entry = recallPiFrontierAdmission(cache, frontierManifest);
      if (entry) {
        const artifact = artifactFromPiFrontierAdmission(entry);
        frontierAdmissionArtifactPath = join(paths.frontierManifestDir, `${options.runId}.admission.json`);
        frontierAdmissionArtifactSha256 = admissionArtifactSha256(artifact);
        await writeFileAtomic(frontierAdmissionArtifactPath, JSON.stringify(artifact));
        if (process.platform !== "win32") await chmod(frontierAdmissionArtifactPath, 0o600);
      }
    } catch {
      // Missing, corrupt, or stale caches are strict misses. Frontier continues
      // with a fresh managed audit and never trusts a partially parsed entry.
    }
  }
  return buildPiManagerLaunchPlan({
    runtime,
    provider: options.provider,
    configDir: paths.configDir,
    sessionDir: paths.sessionDir,
    sessionId: options.sessionId,
    runId: options.runId,
    mode: options.mode,
    chatMode: options.chatMode,
    executionPolicy: options.executionPolicy,
    cwd: options.cwd,
    bridgePath: paths.bridgePath,
    extensionPaths: frontierEnabled
      ? [
          paths.extensionPath,
          join(runtime.packageRoot, "examples", "extensions", "subagent", "index.ts"),
          paths.frontierExtensionPath,
        ]
      : [paths.extensionPath],
    frontierManifestPath,
    frontierManifestSha256,
    frontierAdmissionArtifactPath,
    frontierAdmissionArtifactSha256,
    model: options.model,
    thinking: options.thinking ?? "high",
    sessionName: options.sessionName,
    codaraHomeDir: sparkHome(),
  });
}

export interface CreateCodaraPiWorkerLaunchOptions {
  provider: PiSubscriptionProvider;
  runId: string;
  attemptId: string;
  cwd: string;
  model?: string;
  thinking?: PiThinkingLevel;
  sessionName?: string;
}

/**
 * Build an isolated, one-attempt Pi worker. It deliberately loads only the
 * worker extension: the user-facing manager's orchestration tools and persona
 * must not leak into an implementation worker, while Pi's native coding tools
 * remain available.
 */
export async function createCodaraPiWorkerLaunchPlan(
  options: CreateCodaraPiWorkerLaunchOptions,
): Promise<PiManagerLaunchPlan> {
  const paths = codaraPiPaths();
  const [runtime, auth] = await Promise.all([
    resolveCodaraPiRuntime(),
    inspectPiSubscriptionAuth(paths.authFile, options.provider),
  ]);
  if (auth.expired && !auth.canRefresh) {
    throw new Error(`Pi provider ${options.provider} OAuth session expired and cannot refresh`);
  }
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }),
  ]);
  const rawSessionId = `${options.runId}-${options.attemptId}`;
  const sessionId = rawSessionId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 200)
    .replace(/[^A-Za-z0-9]+$/g, "");
  return buildPiManagerLaunchPlan({
    runtime,
    provider: options.provider,
    configDir: paths.configDir,
    sessionDir: paths.sessionDir,
    sessionId,
    runId: options.runId,
    mode: "talk",
    executionPolicy: "fast",
    cwd: options.cwd,
    bridgePath: paths.bridgePath,
    extensionPaths: [paths.workerExtensionPath],
    model: options.model,
    thinking: options.thinking ?? "high",
    sessionName: options.sessionName,
    codaraHomeDir: sparkHome(),
  });
}

export interface PiFrontierCachePromotionResult {
  promoted: boolean;
  reason: string;
  cacheEntryId?: string;
}

export interface PiFrontierRevisionArchive {
  directory: string;
  files: number;
}

/** Preserve the complete content-addressed gate transcript before a revised
 * contract reuses the run's live manifest basename. */
export async function archiveCodaraPiFrontierRevision(
  plan: PiManagerLaunchPlan,
  revision: number,
): Promise<PiFrontierRevisionArchive | null> {
  if (!plan.frontierManifestPath) return null;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1_000) {
    throw new Error("Frontier contract revision number is outside 1-1000");
  }
  const sourceDirectory = dirname(plan.frontierManifestPath);
  const manifestName = basename(plan.frontierManifestPath);
  const stem = manifestName.endsWith(".json") ? manifestName.slice(0, -5) : manifestName;
  const archiveDirectory = join(sourceDirectory, `${stem}.revision-${revision}`);
  await mkdir(archiveDirectory, { recursive: false, mode: 0o700 });
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  const sources = entries.filter((entry) => entry.isFile() &&
    (entry.name === manifestName || entry.name.startsWith(`${stem}.`)) &&
    !entry.name.includes(".revision-"));
  for (const entry of sources) {
    const target = join(archiveDirectory, entry.name);
    await copyFile(join(sourceDirectory, entry.name), target);
    if (process.platform !== "win32") await chmod(target, 0o600);
  }
  return { directory: archiveDirectory, files: sources.length };
}

let frontierCachePromotionQueue = Promise.resolve();

async function promoteCodaraPiFrontierAdmissionNow(
  plan: PiManagerLaunchPlan,
): Promise<PiFrontierCachePromotionResult> {
  if (!plan.frontierManifestPath || !plan.frontierManifestSha256) {
    return { promoted: false, reason: "not a Frontier launch" };
  }
  const manifestBytes = await readFile(plan.frontierManifestPath).catch(() => null);
  if (!manifestBytes || createHash("sha256").update(manifestBytes).digest("hex") !== plan.frontierManifestSha256) {
    return { promoted: false, reason: "manifest is missing or changed" };
  }
  let manifest: PiFrontierVerificationManifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as PiFrontierVerificationManifest;
  } catch {
    return { promoted: false, reason: "manifest JSON is invalid" };
  }
  const evidencePath = plan.frontierManifestPath.replace(/\.json$/i, ".evidence.json");
  let evidence: unknown;
  try { evidence = JSON.parse(await readFile(evidencePath, "utf8")); }
  catch { return { promoted: false, reason: "Frontier evidence is missing or invalid" }; }
  const runId = plan.env.SPARK_RUN_ID;
  let entry;
  try {
    if (typeof runId !== "string") throw new Error("Frontier run id is missing");
    entry = createPiFrontierAdmissionEntryFromEvidence({
      manifest,
      manifestSha256: plan.frontierManifestSha256,
      runId,
      evidence,
    });
  } catch (error) {
    return { promoted: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const paths = codaraPiPaths();
  let cache: PiFrontierAdmissionCache = emptyPiFrontierAdmissionCache();
  try {
    cache = parsePiFrontierAdmissionCache(JSON.parse(await readFile(paths.frontierAdmissionCachePath, "utf8")));
  } catch {
    // A newly validated entry can safely replace a missing or corrupt store.
  }
  const updated = upsertPiFrontierAdmission(cache, entry);
  await mkdir(dirname(paths.frontierAdmissionCachePath), { recursive: true, mode: 0o700 });
  await writeFileAtomic(paths.frontierAdmissionCachePath, JSON.stringify(updated));
  if (process.platform !== "win32") await chmod(paths.frontierAdmissionCachePath, 0o600);
  return { promoted: true, reason: "fresh managed admission stored", cacheEntryId: entry.cacheEntryId };
}

export function promoteCodaraPiFrontierAdmission(
  plan: PiManagerLaunchPlan,
): Promise<PiFrontierCachePromotionResult> {
  const work = frontierCachePromotionQueue.then(() => promoteCodaraPiFrontierAdmissionNow(plan));
  frontierCachePromotionQueue = work.then(() => undefined, () => undefined);
  return work;
}

import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ChatMode, CoraExecutionPolicy } from "@shared/types";

import { resolveBundledResourcePath } from "../bundled-resources";
import { sparkHome } from "../spark-home";
import { loadSettings } from "../storage";
import { managedPiRuntimeNodeModules } from "./pi-runtime-install";
import { writeFileAtomic } from "../fs-atomic";
import {
  buildPiMcpBridgeConfig,
  normalizePiMcpServers,
  type PiMcpAudience,
  type PiMcpServerConfig,
} from "./pi-mcp-config";
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
  resolvePiWebSearchExtension,
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
  mcpConfigDir: string;
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
    mcpConfigDir: join(configDir, "mcp"),
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

// The extension requires the SDK's CJS client build by absolute path: Pi loads
// extensions with a jiti instance rooted at its own package, so a bare
// specifier from a bundled extension file never reaches Codara's node_modules.
function codaraPiMcpSdkDir(): string | null {
  try {
    return dirname(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
  } catch {
    return null;
  }
}

const MCP_CONFIG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Sessions that were SIGKILLed never reach their cleanup, so sweep on write.
async function sweepStalePiMcpConfigs(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const cutoff = Date.now() - MCP_CONFIG_MAX_AGE_MS;
  await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => {
    const file = join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(file, { force: true }).catch(() => undefined);
  }));
}

/**
 * Write the per-session MCP roster for one Pi scope. Returns null whenever no
 * server is assigned, keeping the no-MCP launch byte-identical to before: the
 * env vars stay unset and the bridge never loads the SDK.
 */
async function writePiMcpBridgeConfig(input: {
  audience: PiMcpAudience;
  sessionId: string;
  cwd: string;
  mcpConfigDir: string;
}): Promise<{ mcpConfigPath: string; mcpSdkDir: string } | null> {
  const sdkDir = codaraPiMcpSdkDir();
  if (!sdkDir) return null;
  let servers: PiMcpServerConfig[];
  try {
    const [{ listPiMcpServers }, settings] = await Promise.all([import("../agent-sync"), loadSettings()]);
    servers = normalizePiMcpServers(
      listPiMcpServers({ cwd: input.cwd, scope: input.audience, settings }),
      { cwd: input.cwd },
    );
  } catch {
    // A discovery failure must never block a Pi launch; the session simply
    // starts without third-party MCP tools.
    return null;
  }
  if (servers.length === 0) return null;
  await mkdir(input.mcpConfigDir, { recursive: true, mode: 0o700 });
  void sweepStalePiMcpConfigs(input.mcpConfigDir);
  const mcpConfigPath = join(input.mcpConfigDir, `${input.sessionId}.json`);
  // Credentials live in this file because Pi's environment is stripped of every
  // API key before launch; keep it owner-only like auth.json.
  await writeFileAtomic(mcpConfigPath, JSON.stringify(buildPiMcpBridgeConfig(servers, { audience: input.audience })));
  if (process.platform !== "win32") await chmod(mcpConfigPath, 0o600);
  return { mcpConfigPath, mcpSdkDir: sdkDir };
}

/** Remove a session's roster file once its Pi process is gone. */
export async function cleanupPiMcpBridgeConfig(plan: { mcpConfigPath: string | null }): Promise<void> {
  if (!plan.mcpConfigPath) return;
  await rm(plan.mcpConfigPath, { force: true }).catch(() => undefined);
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

/**
 * Node interpreter for background agent processes. On macOS the main Electron
 * binary registers a Dock tile per process, so every Pi agent (Cora plus each
 * worker) showed up as its own "exec" icon in the Dock while a run was live.
 * The bundled Electron Helper.app is the same executable surface with
 * LSUIElement set, so as-node children launched through it stay out of the
 * Dock (the same pattern VS Code uses for its helper processes). Falls back
 * to the main binary off macOS or when the bundle layout is unexpected.
 */
export function electronAsNodeInterpreter(): string {
  if (process.platform !== "darwin") return process.execPath;
  const helperName = `${basename(process.execPath)} Helper`;
  const helper = join(
    dirname(process.execPath),
    "..",
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "MacOS",
    helperName,
  );
  return existsSync(helper) ? helper : process.execPath;
}

export async function resolveCodaraPiRuntime(): Promise<PiRuntimeLocation> {
  const roots = app.isPackaged
    ? [
        join(process.resourcesPath, "app.asar", "node_modules"),
        join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
      ]
    : developmentNodeModulesRoots();
  // The managed root ($CODARA_HOME/pi-runtime) comes last: an app-bundled
  // build is the one Codara shipped and tested, and Settings' installer only
  // exists to fill the gap when that build is absent. Both are version-exact,
  // so ordering only decides which identical build wins.
  return resolvePinnedPiRuntime([...roots, managedPiRuntimeNodeModules()]);
}

/**
 * Path of the vendored pi-web-search extension, or null when the package is
 * absent. Pi transpiles the package's TypeScript from disk, so packaged builds
 * prefer the unpacked copy (package.json keeps pi-web-search in asarUnpack).
 */
export async function resolveCodaraPiWebSearchExtension(): Promise<string | null> {
  const roots = app.isPackaged
    ? [
        join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
        join(process.resourcesPath, "app.asar", "node_modules"),
      ]
    : developmentNodeModulesRoots();
  return resolvePiWebSearchExtension(roots);
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
  const [runtime, auth, frontierManifest, webSearchExtensionPath, mcp] = await Promise.all([
    resolveCodaraPiRuntime(),
    inspectPiSubscriptionAuth(paths.authFile, options.provider),
    frontierEnabled ? discoverPiFrontierVerification(options.cwd, options.contractPrompt) : Promise.resolve(null),
    resolveCodaraPiWebSearchExtension(),
    writePiMcpBridgeConfig({
      audience: "cora",
      sessionId: options.sessionId,
      cwd: options.cwd,
      mcpConfigDir: paths.mcpConfigDir,
    }),
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
    extensionPaths: [
      ...(frontierEnabled
        ? [
            paths.extensionPath,
            join(runtime.packageRoot, "examples", "extensions", "subagent", "index.ts"),
            paths.frontierExtensionPath,
          ]
        : [paths.extensionPath]),
      // Web search is optional: an absent package simply leaves the roster
      // unchanged rather than handing Pi a path it cannot load.
      ...(webSearchExtensionPath ? [webSearchExtensionPath] : []),
    ],
    frontierManifestPath,
    frontierManifestSha256,
    frontierAdmissionArtifactPath,
    frontierAdmissionArtifactSha256,
    mcpConfigPath: mcp?.mcpConfigPath,
    mcpSdkDir: mcp?.mcpSdkDir,
    model: options.model,
    thinking: options.thinking ?? "high",
    sessionName: options.sessionName,
    codaraHomeDir: sparkHome(),
    processExecutable: electronAsNodeInterpreter(),
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
  /** The run's actual orchestration policy. Undefined falls back to fast so
   * legacy callers keep the historical behavior. */
  executionPolicy?: CoraExecutionPolicy;
  /** Absolute path of the run's peer-comms mailbox dir. Set only for workers
   * in a parallel batch; stamped into the worker env as CODARA_PI_PEER_DIR. */
  peerCommsDir?: string;
  /** The worker task id, stamped as CODARA_PI_SELF_ID alongside peerCommsDir
   * so the worker extension knows its own mailbox identity. */
  peerSelfId?: string;
  /** Automation (loom) worker context. When set, the session's bridge roster
   * flips to SPARK_MCP_MODE "worker" (studio tools plus codara_ask_user and
   * codara_request_next_iteration), the automation/node identity is stamped
   * into the env for the bridge's runId/nodeId auto-injection, and the
   * extension's tool-access fence is armed from access/blockedTools. */
  automation?: {
    automationId: string;
    nodeId?: string;
    access?: "full" | "edits" | "readonly";
    blockedTools?: string[];
    /** Dirs OUTSIDE the workspace a fenced worker may still write: the attempt
     * dir (mandatory final report) and, for chat participants, the shared
     * board dir. Stamped as CODARA_PI_WORKER_WRITE_ALLOW for the extension's
     * write-containment veto. Ignored without an edits/readonly access. */
    writeAllowDirs?: string[];
  };
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
  const [runtime, auth, webSearchExtensionPath] = await Promise.all([
    resolveCodaraPiRuntime(),
    inspectPiSubscriptionAuth(paths.authFile, options.provider),
    resolveCodaraPiWebSearchExtension(),
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
  // Per session, not per run: parallel workers of one run must not share a
  // roster file that another attempt is rewriting.
  const mcp = await writePiMcpBridgeConfig({
    audience: "worker",
    sessionId,
    cwd: options.cwd,
    mcpConfigDir: paths.mcpConfigDir,
  });
  const plan = buildPiManagerLaunchPlan({
    runtime,
    provider: options.provider,
    configDir: paths.configDir,
    sessionDir: paths.sessionDir,
    sessionId,
    runId: options.runId,
    mode: "talk",
    executionPolicy: options.executionPolicy ?? "fast",
    cwd: options.cwd,
    bridgePath: paths.bridgePath,
    // Research workers get web_search alongside the worker extension; see the
    // manager plan above for why a missing package is not an error.
    extensionPaths: [
      paths.workerExtensionPath,
      ...(webSearchExtensionPath ? [webSearchExtensionPath] : []),
    ],
    mcpConfigPath: mcp?.mcpConfigPath,
    mcpSdkDir: mcp?.mcpSdkDir,
    model: options.model,
    thinking: options.thinking ?? "high",
    sessionName: options.sessionName,
    codaraHomeDir: sparkHome(),
    processExecutable: electronAsNodeInterpreter(),
  });
  // Frozen contract with resources/pi-cora/worker.ts: parallel-batch workers
  // read exactly these two env names to reach the run's peer-comms mailbox
  // without shelling out to the CLI helper. Both or neither.
  if (options.peerCommsDir && options.peerSelfId) {
    plan.env.CODARA_PI_PEER_DIR = resolve(options.peerCommsDir);
    plan.env.CODARA_PI_SELF_ID = options.peerSelfId;
  }
  // Automation (loom) workers. The plain "talk" plan gives the bridge the bare
  // studio roster; a loom worker instead needs the WORKER roster (studio tools
  // plus codara_ask_user + codara_request_next_iteration) and the automation/
  // node identity the bridge auto-injects into those RPCs. The extension's
  // tool-access fence reads the two CODARA_PI_WORKER_* names; blockedTools
  // entries are bare identifiers by validation, so the comma join is safe.
  if (options.automation) {
    plan.env.SPARK_MCP_MODE = "worker";
    plan.env.SPARK_AUTOMATION_ID = options.automation.automationId;
    if (options.automation.nodeId) plan.env.SPARK_NODE_ID = options.automation.nodeId;
    if (options.automation.access && options.automation.access !== "full") {
      plan.env.CODARA_PI_WORKER_ACCESS = options.automation.access;
      // Write containment allowlist rides only with a fenced preset; without
      // one the extension never consults it.
      const allow = (options.automation.writeAllowDirs ?? [])
        .map((dir) => dir.trim())
        .filter((dir) => dir.length > 0)
        .map((dir) => resolve(dir));
      if (allow.length > 0) {
        plan.env.CODARA_PI_WORKER_WRITE_ALLOW = JSON.stringify(allow);
      }
    }
    const blocked = (options.automation.blockedTools ?? [])
      .map((tool) => tool.trim())
      .filter((tool) => /^[A-Za-z][A-Za-z0-9_]*$/.test(tool));
    if (blocked.length > 0) {
      plan.env.CODARA_PI_WORKER_BLOCKED_TOOLS = blocked.join(",");
    }
  }
  return plan;
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

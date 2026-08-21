import { app } from "electron";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ChatMode,
  CoraExecutionPolicy,
  ProjectPolicyMode,
} from "@shared/types";

import { resolveBundledResourcePath } from "../bundled-resources";
import {
  mintAgentSocketCapability,
  revokeAgentSocketCapability,
} from "../agent-socket-capabilities";
import { codaraHome } from "../codara-home";
import { loadSettings } from "../storage";
import {
  availableCoraWorkerModels,
  configuredOpenRouterCoraModels,
  hasVerifiedOpenRouterKey,
} from "../openrouter-config";
import { managedPiRuntimeNodeModules } from "./pi-runtime-install";
import { writeFileAtomic } from "../fs-atomic";
import {
  buildPiMcpBridgeConfig,
  normalizePiMcpServers,
  type PiMcpAudience,
  type PiMcpServerConfig,
} from "./pi-mcp-config";
import {
  buildPiManagerLaunchPlan,
  inspectPiSubscriptionAuth,
  resolvePinnedPiRuntime,
  resolvePiWebSearchExtension,
  type PiManagerLaunchPlan,
  type PiProvider,
  type PiSubscriptionProvider,
  type PiThinkingLevel,
  type PiRuntimeLocation,
} from "./pi-runtime";
import {
  normalizePiAccountProfileId,
  normalizePiExecutionAccount,
  type PiExecutionAccount,
  type PiExecutionAccountRequest,
} from "./pi-account-execution";

export interface CodaraPiPaths {
  configDir: string;
  authFile: string;
  sessionDir: string;
  bridgePath: string;
  extensionPath: string;
  workerExtensionPath: string;
  mcpConfigDir: string;
}

export interface CreateCodaraPiLaunchOptions {
  provider: PiProvider;
  apiKey?: string;
  runId: string;
  mode: "talk" | "execute" | "automation";
  chatMode?: ChatMode;
  executionPolicy?: CoraExecutionPolicy;
  sessionId: string;
  cwd: string;
  model?: string;
  thinking?: PiThinkingLevel;
  sessionName?: string;
  projectPolicyMode?: ProjectPolicyMode;
  /** Explicit profile pin; undefined asks the central resolver for its default. */
  accountProfileId?: string;
  /** Pre-resolved once per turn so session matching and launch cannot diverge. */
  resolvedAccount?: PiExecutionAccount;
  /** Same contract for fast mode: the value the caller compared identity
   *  against. Undefined reads the setting here. */
  openAiFastMode?: boolean;
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

export function codaraPiPaths(configDir = join(codaraHome(), "pi-agent")): CodaraPiPaths {
  return {
    configDir,
    authFile: join(configDir, "auth.json"),
    // Authentication and mutable account caches are private to a profile, but
    // transcript continuity belongs to the Codara run. Switching accounts
    // restarts the Pi process against the same canonical session directory.
    sessionDir: join(codaraHome(), "pi-agent", "sessions"),
    bridgePath: codaraPiBridgePath(),
    extensionPath: resolveBundledResourcePath("pi-cora", "index.ts"),
    workerExtensionPath: resolveBundledResourcePath("pi-cora", "worker.ts"),
    mcpConfigDir: join(configDir, "mcp"),
  };
}

/**
 * The composer's fast-mode toggle (AppSettings.openAiFastMode). Read
 * fail-closed: any error means OFF, because the wrong answer costs the user 2x
 * on every OpenAI token rather than merely running at normal speed.
 */
async function openAiFastModeEnabled(): Promise<boolean> {
  try {
    return (await loadSettings()).openAiFastMode === true;
  } catch {
    return false;
  }
}

/**
 * The fast mode a session for `provider` would actually launch with. Anthropic
 * is always false — it has no priority tier, and buildPiManagerLaunchPlan
 * refuses to stamp the flag for it regardless of the setting. Callers that
 * compare session identity resolve this ONCE per turn and pass the same value
 * back into the launch options, so the identity check and the process env can
 * never disagree about a setting the user flipped mid-turn.
 */
export async function resolveCodaraPiFastMode(
  provider: PiProvider,
): Promise<boolean> {
  if (provider === "anthropic" || provider === "openrouter") return false;
  return openAiFastModeEnabled();
}

export async function resolveCodaraPiExecutionAccount(
  request: PiExecutionAccountRequest,
): Promise<PiExecutionAccount> {
  const preferredAccountProfileId = normalizePiAccountProfileId(
    request.preferredAccountProfileId,
  );
  // Keep credential inspection behind the auth-store boundary. The execution
  // layer receives only an opaque profile id and its private config directory;
  // tokens and provider identities never enter launch plans or run state.
  const { resolvePiAccountRuntimeProfile } = await import("./pi-account-auth-store");
  const selection = await resolvePiAccountRuntimeProfile({
    provider: request.provider,
    ...(preferredAccountProfileId ? { preferredAccountProfileId } : {}),
    requirePreferred: Boolean(preferredAccountProfileId),
  });
  return normalizePiExecutionAccount(
    {
      provider: request.provider,
      ...(preferredAccountProfileId ? { preferredAccountProfileId } : {}),
    },
    selection,
  );
}

export async function resolveCodaraOpenRouterApiKey(model: string): Promise<string> {
  const settings = await loadSettings();
  if (
    !hasVerifiedOpenRouterKey(settings) ||
    !configuredOpenRouterCoraModels(settings).includes(model)
  ) {
    throw new Error(
      `OpenRouter model ${model} is not verified for Cora. Check the key and model in Settings > API and model.`,
    );
  }
  return settings.openRouterApiKey.trim();
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

/** Remove every process-scoped bridge resource once its Pi process is gone. */
export async function cleanupPiMcpBridgeConfig(plan: {
  mcpConfigPath: string | null;
  agentSocketCapabilityId?: string;
}): Promise<void> {
  revokeAgentSocketCapability(plan.agentSocketCapabilityId);
  if (plan.mcpConfigPath) {
    await rm(plan.mcpConfigPath, { force: true }).catch(() => undefined);
  }
}

function attachUntrustedSocketCapability(
  plan: PiManagerLaunchPlan,
  input:
    | { audience: "untrusted-pi-manager"; runId: string }
    | {
        audience: "untrusted-pi-worker";
        runId: string;
        attemptId: string;
      },
): PiManagerLaunchPlan {
  const capability = mintAgentSocketCapability(input);
  Object.assign(plan.env, capability.environment);
  plan.agentSocketCapabilityId = capability.id;
  plan.agentSocketCapabilityExpiresAt = capability.expiresAt;
  return plan;
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

export async function createCodaraPiLaunchPlan(
  options: CreateCodaraPiLaunchOptions,
): Promise<PiManagerLaunchPlan> {
  const isOpenRouter = options.provider === "openrouter";
  const accountRequest = {
    provider: options.provider as PiSubscriptionProvider,
    ...(options.accountProfileId
      ? { preferredAccountProfileId: options.accountProfileId }
      : {}),
  };
  const account = isOpenRouter
    ? { configDir: codaraPiPaths().configDir }
    : options.resolvedAccount
      ? normalizePiExecutionAccount(accountRequest, options.resolvedAccount)
      : await resolveCodaraPiExecutionAccount(accountRequest);
  const paths = codaraPiPaths(account.configDir);
  const untrustedPullRequest =
    options.projectPolicyMode === "untrusted-pull-request";
  const [runtime, auth, webSearchExtensionPath, mcp, settings] = await Promise.all([
    resolveCodaraPiRuntime(),
    isOpenRouter
      ? Promise.resolve(null)
      : inspectPiSubscriptionAuth(paths.authFile, options.provider as PiSubscriptionProvider),
    resolveCodaraPiWebSearchExtension(),
    untrustedPullRequest
      ? Promise.resolve(null)
      : writePiMcpBridgeConfig({
          audience: "cora",
          sessionId: options.sessionId,
          cwd: options.cwd,
          mcpConfigDir: paths.mcpConfigDir,
        }),
    loadSettings(),
  ]);
  if (auth?.expired && !auth.canRefresh) {
    throw new Error(`Pi provider ${options.provider} OAuth session expired and cannot refresh`);
  }
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }),
  ]);
  const plan = buildPiManagerLaunchPlan({
    runtime,
    provider: options.provider,
    apiKey: options.apiKey,
    accountProfileId: account.accountProfileId,
    openAiFastMode:
      options.openAiFastMode ?? (await resolveCodaraPiFastMode(options.provider)),
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
      paths.extensionPath,
      // Web search is optional: an absent package simply leaves the roster
      // unchanged rather than handing Pi a path it cannot load.
      ...(!untrustedPullRequest && webSearchExtensionPath
        ? [webSearchExtensionPath]
        : []),
    ],
    mcpConfigPath: mcp?.mcpConfigPath,
    mcpSdkDir: mcp?.mcpSdkDir,
    model: options.model,
    thinking: options.thinking ?? "high",
    sessionName: options.sessionName,
    projectPolicyMode: options.projectPolicyMode,
    codaraHomeDir: codaraHome(),
    processExecutable: electronAsNodeInterpreter(),
  });
  plan.env.CODARA_PI_WORKER_MODELS = JSON.stringify(availableCoraWorkerModels(settings));
  return untrustedPullRequest
    ? attachUntrustedSocketCapability(plan, {
        audience: "untrusted-pi-manager",
        runId: options.runId,
      })
    : plan;
}

export interface CreateCodaraPiWorkerLaunchOptions {
  provider: PiProvider;
  apiKey?: string;
  runId: string;
  attemptId: string;
  cwd: string;
  model?: string;
  thinking?: PiThinkingLevel;
  sessionName?: string;
  /** Persisted profile pin when recovering the same attempt. */
  accountProfileId?: string;
  /** Main-only exact account resolved and stamped before plan side effects. */
  resolvedAccount?: PiExecutionAccount;
  /** The run's actual orchestration policy. Undefined falls back to fast so
   * legacy callers keep the historical behavior. */
  executionPolicy?: CoraExecutionPolicy;
  projectPolicyMode?: ProjectPolicyMode;
  /** Exact app-owned files outside cwd that an untrusted PR worker may write
   * (normally only its mandatory final-report.json). */
  untrustedWriteAllowFiles?: string[];
  /** Continue a FINISHED worker's transcript instead of minting a fresh
   * session: the previous attempt's persisted Pi session id, already vetted by
   * the spawn-time reuse gate. Launching with the same `--session-id` against
   * the canonical session dir resumes it, so the new prompt lands as the next
   * turn of that conversation. Undefined launches cold as before. */
  resumeSessionId?: string;
  /** A manager-less Cora chat turn. These workers get the compact direct-task
   * contract and the structured submit_result tool instead of the full fleet
   * handoff protocol. Loom automations deliberately keep their own contract. */
  directTask?: {
    finalReportPath: string;
    studioTools?: boolean;
  };
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
  const isOpenRouter = options.provider === "openrouter";
  const untrustedPullRequest =
    options.projectPolicyMode === "untrusted-pull-request";
  const accountRequest = {
    provider: options.provider as PiSubscriptionProvider,
    ...(options.accountProfileId
      ? { preferredAccountProfileId: options.accountProfileId }
      : {}),
  };
  const account = isOpenRouter
    ? { configDir: codaraPiPaths().configDir }
    : options.resolvedAccount
      ? normalizePiExecutionAccount(
          accountRequest,
          options.resolvedAccount,
        )
      : await resolveCodaraPiExecutionAccount(accountRequest);
  const paths = codaraPiPaths(account.configDir);
  const [runtime, auth, webSearchExtensionPath] = await Promise.all([
    resolveCodaraPiRuntime(),
    isOpenRouter
      ? Promise.resolve(null)
      : inspectPiSubscriptionAuth(paths.authFile, options.provider as PiSubscriptionProvider),
    resolveCodaraPiWebSearchExtension(),
  ]);
  if (auth?.expired && !auth.canRefresh) {
    throw new Error(`Pi provider ${options.provider} OAuth session expired and cannot refresh`);
  }
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }),
  ]);
  // A follow-up resume reuses the source attempt's exact id (it went through
  // this same sanitizer when first minted; buildPiManagerLaunchPlan re-asserts
  // the safe charset). Everything else derives a fresh per-attempt id.
  const rawSessionId = options.resumeSessionId?.trim() || `${options.runId}-${options.attemptId}`;
  const sessionId = rawSessionId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "")
    .slice(0, 200)
    .replace(/[^A-Za-z0-9]+$/g, "");
  if (!sessionId) throw new Error("Pi worker session id is invalid");
  // Per session, not per run: parallel workers of one run must not share a
  // roster file that another attempt is rewriting.
  const mcp =
    untrustedPullRequest
      ? null
      : await writePiMcpBridgeConfig({
          audience: "worker",
          sessionId,
          cwd: options.cwd,
          mcpConfigDir: paths.mcpConfigDir,
        });
  try {
    const plan = buildPiManagerLaunchPlan({
      runtime,
      provider: options.provider,
      apiKey: options.apiKey,
      accountProfileId: account.accountProfileId,
      openAiFastMode: await openAiFastModeEnabled(),
      configDir: paths.configDir,
      sessionDir: paths.sessionDir,
      sessionId,
      runId: options.runId,
      mode: "talk",
      executionPolicy: options.executionPolicy ?? "fast",
      projectPolicyMode: options.projectPolicyMode,
      retainBuiltinToolsForUntrustedWorker: untrustedPullRequest,
      cwd: options.cwd,
      bridgePath: paths.bridgePath,
      // Research workers get web_search alongside the worker extension; see
      // the manager plan above for why a missing package is not an error.
      extensionPaths: [
        paths.workerExtensionPath,
        ...(!untrustedPullRequest && webSearchExtensionPath
          ? [webSearchExtensionPath]
          : []),
      ],
      mcpConfigPath: mcp?.mcpConfigPath,
      mcpSdkDir: mcp?.mcpSdkDir,
      model: options.model,
      thinking: options.thinking ?? "high",
      sessionName: options.sessionName,
      codaraHomeDir: codaraHome(),
      processExecutable: electronAsNodeInterpreter(),
    });
    // Frozen contract with resources/pi-cora/worker.ts: parallel-batch workers
    // read exactly these two env names to reach the run's peer-comms mailbox
    // without shelling out to the CLI helper. Both or neither.
    if (options.peerCommsDir && options.peerSelfId) {
      plan.env.CODARA_PI_PEER_DIR = resolve(options.peerCommsDir);
      plan.env.CODARA_PI_SELF_ID = options.peerSelfId;
    }
    if (options.directTask) {
      plan.env.CODARA_PI_DIRECT_TASK = "1";
      plan.env.CODARA_PI_FINAL_REPORT = resolve(options.directTask.finalReportPath);
      if (options.directTask.studioTools) {
        plan.env.CODARA_PI_DIRECT_STUDIO_TOOLS = "1";
      }
    }
    // Automation (loom) workers. The plain "talk" plan gives the bridge the
    // bare studio roster; a loom worker instead needs the WORKER roster and
    // the automation/node identity used by the bridge and access fence.
    if (options.automation) {
      plan.env.SPARK_MCP_MODE = "worker";
      plan.env.SPARK_AUTOMATION_ID = options.automation.automationId;
      if (options.automation.nodeId) plan.env.SPARK_NODE_ID = options.automation.nodeId;
      if (options.automation.access && options.automation.access !== "full") {
        plan.env.CODARA_PI_WORKER_ACCESS = options.automation.access;
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
    if (untrustedPullRequest) {
      plan.env.CODARA_PI_WORKER_ACCESS = "edits";
      const allow = (options.untrustedWriteAllowFiles ?? [])
        .map((file) => file.trim())
        .filter(Boolean)
        .map((file) => resolve(file));
      if (allow.length > 0) {
        plan.env.CODARA_PI_WORKER_WRITE_ALLOW_FILES = JSON.stringify(allow);
      }
      attachUntrustedSocketCapability(plan, {
        audience: "untrusted-pi-worker",
        runId: options.runId,
        attemptId: options.attemptId,
      });
    }
    return plan;
  } catch (error) {
    await cleanupPiMcpBridgeConfig({
      mcpConfigPath: mcp?.mcpConfigPath ?? null,
    });
    throw error;
  }
}

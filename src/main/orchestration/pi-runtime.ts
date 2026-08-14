import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ChatMode,
  CoraExecutionPolicy,
  ProjectPolicyMode,
} from "@shared/types";
import { resolveCompactAtTokens } from "@shared/context-compaction";

export const CODARA_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const CODARA_PI_VERSION = "0.84.2";
/** Vendored Pi extension that registers the provider-native web_search tool.
 * It is a normal dependency of this repo, never the user's own pi packages. */
export const CODARA_PI_WEB_SEARCH_PACKAGE = "pi-web-search";
export const CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Context tokens at which Cora's Pi sessions compact. Pi's own trigger sits at
 * contextWindow - 16384, which is ~984k on the 1M-window models; Codara wants
 * a far smaller working context. The launcher stamps the effective value into
 * CODARA_PI_COMPACT_AT_TOKENS for every manager and worker plan, and the
 * bundled extension (resources/pi-cora/compaction.ts) is the enforcement
 * point.
 *
 * The number itself lives in @shared/context-compaction so the renderer's
 * context meter measures against the same ceiling. The extension keeps a third
 * copy because resources/ cannot import from src;
 * scripts/test-pi-cora-extension.cjs asserts all three agree.
 */
export { DEFAULT_PI_COMPACT_AT_TOKENS } from "@shared/context-compaction";

/** Read the user's compaction override. Absurd values (0, negative, NaN) fall
 *  back to the default rather than disabling compaction. */
export function resolvePiCompactAtTokens(
  baseEnv: NodeJS.ProcessEnv = process.env,
): number {
  return resolveCompactAtTokens(baseEnv.CODARA_PI_COMPACT_AT_TOKENS);
}

export type PiSubscriptionProvider = "anthropic" | "openai-codex";
export type PiManagerMode = "talk" | "execute" | "automation";
export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface PiRuntimeLocation {
  packageRoot: string;
  packageJsonPath: string;
  entrypoint: string;
  version: typeof CODARA_PI_VERSION;
}

export interface PiSubscriptionAuthStatus {
  provider: PiSubscriptionProvider;
  type: "oauth";
  expiresAt: number | null;
  expired: boolean;
  canRefresh: boolean;
}

export interface PiManagerLaunchOptions {
  runtime: PiRuntimeLocation;
  provider: PiSubscriptionProvider;
  configDir: string;
  /** Opaque account profile whose private configDir was selected. */
  accountProfileId?: string;
  sessionDir: string;
  sessionId: string;
  runId: string;
  mode: PiManagerMode;
  /** Original composer mode. Auto uses the execute roster but a distinct
   * system contract so conversational turns do not enter the completion
   * protocol. */
  chatMode?: ChatMode;
  executionPolicy?: CoraExecutionPolicy;
  cwd: string;
  bridgePath: string;
  extensionPaths: readonly string[];
  /** Mode-600 JSON roster of user MCP servers assigned to this session's scope.
   * Both this and mcpSdkDir must be present or the bridge stays dormant. */
  mcpConfigPath?: string;
  /** Directory holding the MCP SDK's CJS client build. The extension requires
   * it by absolute path because a packaged extension cannot resolve bare
   * specifiers from inside app.asar. */
  mcpSdkDir?: string;
  frontierManifestPath?: string;
  frontierManifestSha256?: string;
  frontierAdmissionArtifactPath?: string;
  frontierAdmissionArtifactSha256?: string;
  processExecutable?: string;
  model?: string;
  thinking?: PiThinkingLevel;
  sessionName?: string;
  /** Repository policy/resource discovery mode. Missing preserves legacy trusted behavior. */
  projectPolicyMode?: ProjectPolicyMode;
  /**
   * Internal worker-only seam. Untrusted managers have no native Pi tools;
   * workers keep the native file tools so the bundled tool_call fence can
   * contain them. Never set this for a manager session.
   */
  retainBuiltinToolsForUntrustedWorker?: boolean;
  codaraHomeDir?: string;
  /**
   * The composer's fast-mode toggle (AppSettings.openAiFastMode). Applies the faster (and
   * pricier) OpenAI service tier to this session. Anthropic sessions ignore
   * it entirely: the bundled extension strips any tier for that provider no
   * matter what this says. Defaults to off so a missing setting can never
   * silently buy the 2x tier.
   */
  openAiFastMode?: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface PiManagerLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  provider: PiSubscriptionProvider;
  /** Opaque account profile that owns this process; no credential material. */
  accountProfileId?: string;
  model: string;
  thinking: PiThinkingLevel;
  sessionId: string;
  executionPolicy: CoraExecutionPolicy;
  projectPolicyMode: ProjectPolicyMode;
  frontierManifestPath: string | null;
  frontierManifestSha256: string | null;
  frontierAdmissionArtifactSha256: string | null;
  /** Set only when a roster was handed over, so the caller can delete the file
   * when the session ends. */
  mcpConfigPath: string | null;
  /** Process-local revocation handle for an untrusted Pi socket claim. Never
   * serialized or exposed to the renderer. */
  agentSocketCapabilityId?: string;
  /** Absolute lease boundary for the process-local socket claim. Main-only;
   * a live Pi process must be rotated instead of reusing an expired lease. */
  agentSocketCapabilityExpiresAt?: number;
}

const DEFAULT_MODELS: Record<PiSubscriptionProvider, string> = {
  // Never make the premium tier an implicit fallback. Callers that passed the
  // user's explicit Fable selection keep it; missing model choices land on
  // Opus so the Settings gate cannot be bypassed by a provider default.
  anthropic: "claude-opus-5",
  "openai-codex": "gpt-5.6-sol",
};

const API_CREDENTIAL_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_AD_TOKEN",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertSafeSegment(value: string, label: string): void {
  if (!nonEmptyString(value) || value.length > 200 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`${label} must use Pi's safe session-id character set`);
  }
}

function validateProviderModel(provider: PiSubscriptionProvider, model: string): void {
  const valid = provider === "anthropic" ? model.startsWith("claude-") : model.startsWith("gpt-");
  if (!valid) throw new Error(`Model ${model} is not compatible with Pi provider ${provider}`);
}

/**
 * Locate the exact Pi build Codara was tested against. Search roots are
 * node_modules directories, allowing callers to provide both development and
 * app.asar.unpacked locations without this pure module importing Electron.
 */
export async function resolvePinnedPiRuntime(
  nodeModulesRoots: readonly string[],
): Promise<PiRuntimeLocation> {
  const mismatches: string[] = [];
  for (const root of nodeModulesRoots) {
    const packageRoot = join(resolve(root), "@earendil-works", "pi-coding-agent");
    const packageJsonPath = join(packageRoot, "package.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(manifest) || manifest.name !== CODARA_PI_PACKAGE) continue;
    if (manifest.version !== CODARA_PI_VERSION) {
      mismatches.push(`${packageJsonPath} (${String(manifest.version)})`);
      continue;
    }
    const bin = isRecord(manifest.bin) ? manifest.bin.pi : null;
    if (!nonEmptyString(bin)) throw new Error(`Pinned Pi package has no pi executable: ${packageJsonPath}`);
    const entrypoint = join(packageRoot, bin);
    const entryStat = await stat(entrypoint).catch(() => null);
    if (!entryStat?.isFile()) throw new Error(`Pinned Pi executable is missing: ${entrypoint}`);
    return {
      packageRoot,
      packageJsonPath,
      entrypoint,
      version: CODARA_PI_VERSION,
    };
  }
  const detail = mismatches.length ? ` Version mismatches: ${mismatches.join(", ")}.` : "";
  throw new Error(`Codara's pinned Pi runtime ${CODARA_PI_VERSION} is not installed.${detail}`);
}

/**
 * Locate the vendored pi-web-search extension entry, reading the package's own
 * `pi` manifest instead of hardcoding its layout. Returns null rather than
 * throwing: web search is an enhancement, so a build without the package must
 * still launch a session.
 */
export async function resolvePiWebSearchExtension(
  nodeModulesRoots: readonly string[],
): Promise<string | null> {
  for (const root of nodeModulesRoots) {
    const packageRoot = join(resolve(root), CODARA_PI_WEB_SEARCH_PACKAGE);
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(manifest) || manifest.name !== CODARA_PI_WEB_SEARCH_PACKAGE) continue;
    const piManifest = isRecord(manifest.pi) ? manifest.pi : null;
    const declared = Array.isArray(piManifest?.extensions) ? piManifest.extensions : [];
    for (const entry of declared) {
      if (!nonEmptyString(entry)) continue;
      const entryPath = resolve(packageRoot, entry);
      const entryStat = await stat(entryPath).catch(() => null);
      if (entryStat?.isFile()) return entryPath;
    }
  }
  return null;
}

/**
 * Validate that Pi will authenticate through an OAuth subscription record. The
 * returned object deliberately contains no access or refresh token.
 */
export async function inspectPiSubscriptionAuth(
  authFilePath: string,
  provider: PiSubscriptionProvider,
  now = Date.now(),
): Promise<PiSubscriptionAuthStatus> {
  const authStat = await stat(authFilePath);
  if (process.platform !== "win32" && (authStat.mode & 0o077) !== 0) {
    throw new Error("Pi subscription auth must not be readable by group or other users");
  }
  const parsed: unknown = JSON.parse(await readFile(authFilePath, "utf8"));
  if (!isRecord(parsed)) throw new Error("Pi auth store must contain a JSON object");
  const record = parsed[provider];
  if (!isRecord(record) || record.type !== "oauth") {
    throw new Error(`Pi provider ${provider} is not authenticated with OAuth`);
  }
  if (!nonEmptyString(record.access)) {
    throw new Error(`Pi provider ${provider} has no OAuth access token`);
  }
  const expiresAt = typeof record.expires === "number" && Number.isFinite(record.expires)
    ? record.expires
    : null;
  return {
    provider,
    type: "oauth",
    expiresAt,
    expired: expiresAt !== null && expiresAt <= now,
    canRefresh: nonEmptyString(record.refresh),
  };
}

/**
 * Strip every API-key override before launching Pi. OAuth is read only from
 * Codara's isolated, mode-600 auth store; inheriting a shell API key would
 * silently turn a subscription experiment into metered API usage.
 */
export function buildPiSubscriptionEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  configDir: string,
  sessionDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (API_CREDENTIAL_NAMES.has(upper) || upper.endsWith("_API_KEY") || upper.endsWith("_API_KEY_FILE") ||
      upper.startsWith("CODARA_PI_") || upper === "SPARK_AGENT_SOCKET" ||
      upper === "SPARK_AGENT_TOKEN" || upper === "SPARK_AGENT_CAPABILITY" ||
      upper === "SPARK_MCP_MODE" || upper === "SPARK_RUN_ID" ||
      upper === "SPARK_AUTOMATION_ID" || upper === "SPARK_NODE_ID") continue;
    env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.PI_CODING_AGENT_DIR = resolve(configDir);
  env.PI_CODING_AGENT_SESSION_DIR = resolve(sessionDir);
  env.PI_TELEMETRY = "0";
  // pi-web-search reads an optional search-model override from this path and
  // otherwise defaults to $HOME/.pi, the user's own pi installation. Pin it
  // inside Codara's isolated agent dir: no file exists there, so the extension
  // searches with the session's own model and Codara never reads ~/.pi.
  env.PI_WEB_SEARCH_CONFIG = join(resolve(configDir), "web-search.json");
  return env;
}

/** Build the deterministic RPC launch used by the experimental Cora backend. */
export function buildPiManagerLaunchPlan(options: PiManagerLaunchOptions): PiManagerLaunchPlan {
  assertSafeSegment(options.sessionId, "Pi session id");
  assertSafeSegment(options.runId, "Codara run id");
  const model = options.model?.trim() || DEFAULT_MODELS[options.provider];
  validateProviderModel(options.provider, model);
  const thinking = options.thinking ?? "high";
  const executionPolicy: CoraExecutionPolicy =
    options.executionPolicy === "deep" || options.executionPolicy === "frontier"
      ? options.executionPolicy
      : "fast";
  const projectPolicyMode: ProjectPolicyMode =
    options.projectPolicyMode === "untrusted-pull-request"
      ? "untrusted-pull-request"
      : "trusted";
  if (
    projectPolicyMode === "untrusted-pull-request" &&
    executionPolicy === "frontier"
  ) {
    throw new Error(
      "Frontier verification cannot run against an untrusted pull-request checkout.",
    );
  }
  const extensionPaths = options.extensionPaths.map((value) => resolve(value));
  if (extensionPaths.length === 0) throw new Error("Cora's Pi backend requires a bundled extension");
  const frontierGateEnabled = executionPolicy === "frontier" && options.mode === "execute";
  if (frontierGateEnabled) {
    if (!options.frontierManifestPath || !/^[a-f0-9]{64}$/.test(options.frontierManifestSha256 ?? "")) {
      throw new Error("Cora's Pi Frontier route requires a content-addressed verification manifest");
    }
    if (Boolean(options.frontierAdmissionArtifactPath) !== Boolean(options.frontierAdmissionArtifactSha256) ||
      (options.frontierAdmissionArtifactSha256 && !/^[a-f0-9]{64}$/.test(options.frontierAdmissionArtifactSha256))) {
      throw new Error("Cora's Pi Frontier admission artifact must be a complete content-addressed pair");
    }
  }

  const args = [
    options.runtime.entrypoint,
    "--mode",
    "rpc",
    projectPolicyMode === "untrusted-pull-request"
      ? "--no-approve"
      : "--approve",
    "--provider",
    options.provider,
    "--model",
    model,
    "--thinking",
    thinking,
    "--session-id",
    options.sessionId,
    "--session-dir",
    resolve(options.sessionDir),
    "--no-extensions",
  ];
  if (
    projectPolicyMode === "untrusted-pull-request" &&
    !options.retainBuiltinToolsForUntrustedWorker
  ) {
    args.push(
      "--no-builtin-tools",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    );
  } else if (projectPolicyMode === "untrusted-pull-request") {
    args.push(
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    );
  }
  if (options.sessionName?.trim()) args.push("--name", options.sessionName.trim());
  if (options.provider === "anthropic") {
    args.push("--system-prompt", CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT);
  }
  for (const extensionPath of extensionPaths) args.push("--extension", extensionPath);

  const env = buildPiSubscriptionEnvironment(
    options.baseEnv ?? process.env,
    options.configDir,
    options.sessionDir,
  );
  env.SPARK_MCP_MODE = options.mode;
  env.SPARK_RUN_ID = options.runId;
  env.CODARA_PI_CHAT_MODE = options.chatMode ?? options.mode;
  env.CODARA_PI_EXECUTION_POLICY = executionPolicy;
  env.CODARA_PI_PROJECT_POLICY = projectPolicyMode;
  env.CODARA_PI_BRIDGE_PATH = resolve(options.bridgePath);
  // Every Cora Pi process (manager and worker) flows through this builder, so
  // the compaction trigger is stamped once here rather than at each call site.
  // buildPiSubscriptionEnvironment drops CODARA_PI_* from the inherited
  // environment, which makes this the only source the extension can read.
  env.CODARA_PI_COMPACT_AT_TOKENS = String(
    resolvePiCompactAtTokens(options.baseEnv ?? process.env),
  );
  // Service-tier policy inputs. The extension's before_provider_request hook
  // is the only seam Pi 0.84.2 gives us for the request body, and it needs to
  // know which provider this process talks to and whether Settings enabled the
  // faster OpenAI tier. Fast mode is stamped only for OpenAI providers: an
  // Anthropic plan never carries the flag at all, which is the first of the
  // two places that guarantee Anthropic can never run a priority tier.
  env.CODARA_PI_PROVIDER = options.provider;
  if (options.openAiFastMode === true && options.provider !== "anthropic") {
    env.CODARA_PI_FAST_MODE = "1";
  }
  // Both names or neither: a half-configured bridge would leave the extension
  // unable to load the SDK and would surface as a session-start failure.
  const mcpEnabled =
    projectPolicyMode === "trusted" &&
    Boolean(options.mcpConfigPath && options.mcpSdkDir);
  if (mcpEnabled) {
    env.CODARA_PI_MCP_CONFIG = resolve(options.mcpConfigPath!);
    env.CODARA_PI_MCP_SDK_DIR = resolve(options.mcpSdkDir!);
  }
  if (frontierGateEnabled) {
    env.CODARA_PI_FRONTIER_MANIFEST = resolve(options.frontierManifestPath!);
    env.CODARA_PI_FRONTIER_MANIFEST_SHA256 = options.frontierManifestSha256!;
    if (options.frontierAdmissionArtifactPath) {
      env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT = resolve(options.frontierAdmissionArtifactPath);
      env.CODARA_PI_FRONTIER_ADMISSION_ARTIFACT_SHA256 = options.frontierAdmissionArtifactSha256!;
    }
  }
  if (options.codaraHomeDir) env.CODARA_HOME_DIR = resolve(options.codaraHomeDir);

  return {
    command: options.processExecutable || process.execPath,
    args,
    cwd: resolve(options.cwd),
    env,
    provider: options.provider,
    ...(options.accountProfileId
      ? { accountProfileId: options.accountProfileId }
      : {}),
    model,
    thinking,
    sessionId: options.sessionId,
    executionPolicy,
    projectPolicyMode,
    frontierManifestPath: frontierGateEnabled ? resolve(options.frontierManifestPath!) : null,
    frontierManifestSha256: frontierGateEnabled ? options.frontierManifestSha256! : null,
    frontierAdmissionArtifactSha256: frontierGateEnabled
      ? options.frontierAdmissionArtifactSha256 ?? null
      : null,
    mcpConfigPath: mcpEnabled ? resolve(options.mcpConfigPath!) : null,
  };
}

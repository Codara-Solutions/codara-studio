import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ChatMode, CoraExecutionPolicy } from "@shared/types";

export const CODARA_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const CODARA_PI_VERSION = "0.82.0";
export const CLAUDE_SUBSCRIPTION_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";

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
  frontierManifestPath?: string;
  frontierManifestSha256?: string;
  frontierAdmissionArtifactPath?: string;
  frontierAdmissionArtifactSha256?: string;
  processExecutable?: string;
  model?: string;
  thinking?: PiThinkingLevel;
  sessionName?: string;
  codaraHomeDir?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface PiManagerLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  provider: PiSubscriptionProvider;
  model: string;
  thinking: PiThinkingLevel;
  sessionId: string;
  executionPolicy: CoraExecutionPolicy;
  frontierManifestPath: string | null;
  frontierManifestSha256: string | null;
  frontierAdmissionArtifactSha256: string | null;
}

const DEFAULT_MODELS: Record<PiSubscriptionProvider, string> = {
  // Never make the premium tier an implicit fallback. Callers that passed the
  // user's explicit Fable selection keep it; missing model choices land on
  // Opus so the Settings gate cannot be bypassed by a provider default.
  anthropic: "claude-opus-4-8",
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
      upper.startsWith("CODARA_PI_") || upper === "SPARK_MCP_MODE" || upper === "SPARK_RUN_ID") continue;
    env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.PI_CODING_AGENT_DIR = resolve(configDir);
  env.PI_CODING_AGENT_SESSION_DIR = resolve(sessionDir);
  env.PI_TELEMETRY = "0";
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
    "--approve",
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
  env.CODARA_PI_BRIDGE_PATH = resolve(options.bridgePath);
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
    model,
    thinking,
    sessionId: options.sessionId,
    executionPolicy,
    frontierManifestPath: frontierGateEnabled ? resolve(options.frontierManifestPath!) : null,
    frontierManifestSha256: frontierGateEnabled ? options.frontierManifestSha256! : null,
    frontierAdmissionArtifactSha256: frontierGateEnabled
      ? options.frontierAdmissionArtifactSha256 ?? null
      : null,
  };
}

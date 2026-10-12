import { app } from "electron";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  ChatMode,
  CoraExecutionPolicy,
  ProjectPolicyMode,
} from "@shared/types";

import { familyForSubscription } from "../../shared/agent-families";
import { anthropicModelSupportsFastMode } from "../../shared/fast-mode";
import { resolveBundledResourcePath } from "../bundled-resources";
import {
  mintAgentSocketCapability,
  revokeAgentSocketCapability,
} from "../agent-socket-capabilities";
import { codaraHome } from "../codara-home";
import { loadSettings, onSettingsSaved } from "../storage";
import type { AgentPiMcpLiveStatus } from "@shared/types";
import {
  configuredOpenRouterCoraModels,
  hasVerifiedOpenRouterKey,
} from "../openrouter-config";
import { coraWorkerModelAvailability } from "./worker-model-availability";
import { forgetResolvedBinary, resolveBinary } from "../binary-resolver";
import { getEnrichedEnv } from "../path-reconstruction";
import { writeFileAtomic } from "../fs-atomic";
import {
  buildPiMcpBridgeConfig,
  normalizePiMcpServers,
  piMcpStatusPath,
  type PiMcpAudience,
  type PiMcpServerConfig,
} from "./pi-mcp-config";
import {
  buildPiManagerLaunchPlan,
  inspectPiSubscriptionAuth,
  mergeCodaraPiAgentSettings,
  piPackageRootsForBinary,
  resolveInstalledPiRuntime,
  resolvePinnedPiRuntime,
  resolvePiWebSearchExtension,
  type PiManagerLaunchPlan,
  type PiProvider,
  type PiSubscriptionProvider,
  type PiThinkingLevel,
  type PiRuntimeLocation,
  windowsGitBashCandidates,
} from "./pi-runtime";
import {
  legacyAuthFailureAsNoAccount,
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
  fastMode?: boolean;
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
 * The composer's fast-mode toggle (AppSettings.openAiFastMode; the key predates
 * Anthropic support). Read fail-closed: any error means OFF, because the wrong
 * answer bills a premium rate on every token rather than merely running at
 * normal speed.
 */
async function fastModeSettingEnabled(): Promise<boolean> {
  try {
    return (await loadSettings()).openAiFastMode === true;
  } catch {
    return false;
  }
}

// An unreadable settings file means Auto, never a launch failure.
async function autoCompactPercentSetting(): Promise<number | null> {
  try {
    return (await loadSettings()).coraAutoCompactPercent ?? null;
  } catch {
    return null;
  }
}

/**
 * The fast mode a session for `provider` and `model` would actually launch
 * with. Managers and workers both resolve it here, from the one global
 * setting, which is how a worker inherits the manager's fast mode. OpenRouter
 * and providers without a fast mode are always false, and so is a Claude model
 * the API would refuse it for. Callers that compare session identity resolve
 * this ONCE per turn and pass the same value back into the launch options, so
 * the identity check and the process env can never disagree about a setting
 * the user flipped mid-turn.
 */
export async function resolveCodaraPiFastMode(
  provider: PiProvider,
  model: string | undefined,
): Promise<boolean> {
  if (provider === "openrouter") return false;
  if (provider === "anthropic" && !anthropicModelSupportsFastMode(model)) return false;
  if (provider !== "anthropic" && provider !== "openai-codex") return false;
  return fastModeSettingEnabled();
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
  {
    // A terminal may have rotated this account's token since the last
    // reconcile; a launch on a stale refresh token would fail outright.
    const { unifiedAccountsFor } = await import("./unified-account-registry");
    const accounts = unifiedAccountsFor(request.provider);
    await (preferredAccountProfileId
      ? accounts.reconcileProfile(preferredAccountProfileId)
      : accounts.reconcileDefault()
    ).catch(() => null);
  }
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

interface LivePiMcpRoster {
  audience: PiMcpAudience;
  cwd: string;
  content: string;
}

// Rosters of running Cora sessions, by file path. A Capability Center change
// rewrites them, and the bridge inside each session re-reads its file before
// the next prompt, so an open chat gains or loses a server without a restart.
const livePiMcpRosters = new Map<string, LivePiMcpRoster>();
let livePiMcpRefreshHooked = false;
let livePiMcpRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let livePiMcpRefreshTail: Promise<void> = Promise.resolve();
let lastPiMcpDiscoveryError: string | null = null;

/** The last MCP discovery failure behind a Pi launch, for the Capability Center. */
export function piMcpDiscoveryError(): string | null {
  return lastPiMcpDiscoveryError;
}

// Sessions that were SIGKILLed never reach their cleanup, so sweep on write.
// A live roster is never swept: its session is still running.
async function sweepStalePiMcpConfigs(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const cutoff = Date.now() - MCP_CONFIG_MAX_AGE_MS;
  await Promise.all(entries.filter((name) => name.endsWith(".json")).map(async (name) => {
    const file = join(directory, name);
    if (livePiMcpRosters.has(file) || livePiMcpRosters.has(file.replace(/\.status\.json$/, ".json"))) return;
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(file, { force: true }).catch(() => undefined);
  }));
}

async function discoverPiMcpServers(audience: PiMcpAudience, cwd: string): Promise<PiMcpServerConfig[] | null> {
  try {
    const [{ listPiMcpServers }, settings] = await Promise.all([import("../agent-sync"), loadSettings()]);
    const servers = normalizePiMcpServers(
      listPiMcpServers({ cwd, scope: audience, settings }),
      { cwd },
    );
    lastPiMcpDiscoveryError = null;
    return servers;
  } catch (error) {
    // A discovery failure must never block a Pi launch; the session simply
    // starts without third-party MCP tools, and the Capability Center shows why.
    lastPiMcpDiscoveryError = error instanceof Error ? error.message : String(error);
    console.warn("[pi-mcp] MCP server discovery failed:", lastPiMcpDiscoveryError);
    return null;
  }
}

async function writeRosterFile(path: string, content: string): Promise<void> {
  // Credentials live in this file because Pi's environment is stripped of every
  // API key before launch; keep it owner-only like auth.json.
  await writeFileAtomic(path, content);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

/**
 * Write the per-session MCP roster for one Pi scope. A one-shot roster is not
 * written when no server is assigned, keeping that launch byte-identical to
 * before: the env vars stay unset and the bridge never loads the SDK. A live
 * roster (Cora's own sessions) is always written, even empty, because a
 * server assigned mid-chat must reach the session that is already running.
 */
async function writePiMcpBridgeConfig(input: {
  audience: PiMcpAudience;
  sessionId: string;
  cwd: string;
  mcpConfigDir: string;
  live?: boolean;
}): Promise<{ mcpConfigPath: string; mcpSdkDir: string } | null> {
  const sdkDir = codaraPiMcpSdkDir();
  if (!sdkDir) return null;
  const servers = await discoverPiMcpServers(input.audience, input.cwd);
  if (!input.live && (!servers || servers.length === 0)) return null;
  await mkdir(input.mcpConfigDir, { recursive: true, mode: 0o700 });
  void sweepStalePiMcpConfigs(input.mcpConfigDir);
  // One file per launch, never per session: a chat relaunched under the same
  // session id must not share a roster with the process still shutting down,
  // whose cleanup deletes its own roster file and live entry.
  const mcpConfigPath = join(input.mcpConfigDir, `${input.sessionId}-${randomUUID().slice(0, 8)}.json`);
  const content = JSON.stringify(buildPiMcpBridgeConfig(servers ?? [], { audience: input.audience, live: input.live }));
  await writeRosterFile(mcpConfigPath, content);
  if (input.live) {
    livePiMcpRosters.set(mcpConfigPath, { audience: input.audience, cwd: input.cwd, content });
    hookLivePiMcpRefresh();
  }
  return { mcpConfigPath, mcpSdkDir: sdkDir };
}

function hookLivePiMcpRefresh(): void {
  if (livePiMcpRefreshHooked) return;
  livePiMcpRefreshHooked = true;
  onSettingsSaved(() => scheduleLivePiMcpRefresh());
  void import("../agent-sync")
    .then(({ onAgentAssetsChanged }) => onAgentAssetsChanged(() => scheduleLivePiMcpRefresh()))
    .catch(() => undefined);
}

function scheduleLivePiMcpRefresh(): void {
  if (livePiMcpRosters.size === 0) return;
  if (livePiMcpRefreshTimer) clearTimeout(livePiMcpRefreshTimer);
  livePiMcpRefreshTimer = setTimeout(() => {
    livePiMcpRefreshTimer = null;
    void refreshLivePiMcpRosters();
  }, 150);
}

/**
 * Re-resolve every running Cora session's roster and rewrite the files whose
 * servers changed. A failed discovery keeps the current roster rather than
 * disconnecting servers that are working.
 */
export function refreshLivePiMcpRosters(): Promise<void> {
  // One pass at a time: a pass that resolved before a later settings change
  // must not land its older roster after the newer pass already wrote.
  const pass = livePiMcpRefreshTail.then(refreshLivePiMcpRostersOnce);
  livePiMcpRefreshTail = pass.catch(() => undefined);
  return pass;
}

async function refreshLivePiMcpRostersOnce(): Promise<void> {
  for (const [path, roster] of [...livePiMcpRosters]) {
    const servers = await discoverPiMcpServers(roster.audience, roster.cwd);
    if (!servers) continue;
    const content = JSON.stringify(buildPiMcpBridgeConfig(servers, { audience: roster.audience, live: true }));
    if (content === roster.content || !livePiMcpRosters.has(path)) continue;
    try {
      await writeRosterFile(path, content);
      roster.content = content;
      // The session ended while this write was in flight; its cleanup already
      // ran, so the credentials file this write recreated is removed here.
      if (!livePiMcpRosters.has(path)) await rm(path, { force: true }).catch(() => undefined);
    } catch (error) {
      console.warn("[pi-mcp] could not refresh a live MCP roster:", error);
    }
  }
}

/**
 * Connection state per server, as reported by the bridges of running Cora
 * sessions. Keyed by the sanitized server name the bridge uses; when several
 * chats report the same server, the newest report wins.
 */
export async function readLivePiMcpStatuses(): Promise<Map<string, AgentPiMcpLiveStatus>> {
  const merged = new Map<string, AgentPiMcpLiveStatus>();
  for (const path of livePiMcpRosters.keys()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(piMcpStatusPath(path), "utf8"));
    } catch {
      continue;
    }
    const servers = (parsed as { servers?: unknown })?.servers;
    if (!Array.isArray(servers)) continue;
    for (const entry of servers) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      const status = record.status;
      if (!name || (status !== "pending" && status !== "connected" && status !== "failed" && status !== "disconnected")) continue;
      const live: AgentPiMcpLiveStatus = {
        status,
        tools: typeof record.tools === "number" ? record.tools : 0,
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString(),
        ...(typeof record.error === "string" && record.error ? { error: record.error } : {}),
      };
      const key = name.toLowerCase();
      const previous = merged.get(key);
      if (!previous || previous.updatedAt < live.updatedAt) merged.set(key, live);
    }
  }
  return merged;
}

/** Remove every process-scoped bridge resource once its Pi process is gone. */
export async function cleanupPiMcpBridgeConfig(plan: {
  mcpConfigPath: string | null;
  agentSocketCapabilityId?: string;
}): Promise<void> {
  revokeAgentSocketCapability(plan.agentSocketCapabilityId);
  if (plan.mcpConfigPath) {
    livePiMcpRosters.delete(plan.mcpConfigPath);
    await rm(plan.mcpConfigPath, { force: true }).catch(() => undefined);
    await rm(piMcpStatusPath(plan.mcpConfigPath), { force: true }).catch(() => undefined);
  }
}

/**
 * The skill folders a trusted Pi session loads. Undefined keeps Pi's own
 * discovery, so a discovery failure never costs a session its skills.
 */
async function resolveCodaraPiSkillPaths(cwd: string, configDir: string): Promise<string[] | undefined> {
  try {
    const [{ listPiSkillPaths }, settings] = await Promise.all([import("../agent-sync"), loadSettings()]);
    return listPiSkillPaths({ cwd, piAgentDir: configDir, settings });
  } catch (error) {
    console.warn("[pi-skills] skill discovery failed; Pi falls back to its own:", error);
    return undefined;
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

function bundledNodeModulesRoots(): string[] {
  return app.isPackaged
    ? [
        join(process.resourcesPath, "app.asar", "node_modules"),
        join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
      ]
    : developmentNodeModulesRoots();
}

/**
 * The Pi build bundled with the app, which Codara's main process uses as a
 * library: credential storage, the sign-in flows and the model catalog. It
 * never runs a Cora session.
 */
export async function resolveCodaraPiLibrary(): Promise<PiRuntimeLocation> {
  return resolvePinnedPiRuntime(bundledNodeModulesRoots());
}

function insideBundledTree(packageRoot: string): boolean {
  const target = resolve(packageRoot);
  return bundledNodeModulesRoots().some((root) => target.startsWith(`${resolve(root)}${sep}`));
}

/**
 * The Pi the user installed (`npm install -g @earendil-works/pi-coding-agent`),
 * the same `pi` their terminals run. Updating it is the user's call. The
 * app's own bundled copy never counts, even when a development PATH puts
 * its `pi` first.
 */
export async function resolveUserPiRuntime(): Promise<PiRuntimeLocation> {
  const binary = await resolveBinary("pi");
  // A miss is re-probed next time: the user may install Pi while Codara runs.
  if (!binary) forgetResolvedBinary("pi");
  const fromBinary = binary ? await piPackageRootsForBinary(binary) : [];
  // Version-manager shims (asdf, mise, Volta) link nowhere near the package;
  // npm itself says where its global packages live.
  const npmRoot = await npmGlobalRoot();
  const roots = [
    ...fromBinary,
    ...(npmRoot ? [join(npmRoot, "@earendil-works", "pi-coding-agent")] : []),
  ].filter((root) => !insideBundledTree(root));
  try {
    return await resolveInstalledPiRuntime(roots);
  } catch (error) {
    forgetResolvedBinary("pi");
    throw error;
  }
}

let npmRootCache: { value: string | null; at: number } | null = null;
const NPM_ROOT_TTL_MS = 5 * 60 * 1000;

/** Forget the cached npm root, after an install moved things around. */
export function forgetNpmGlobalRoot(): void {
  npmRootCache = null;
}

/** `npm root -g`, cached for a few minutes; null when npm cannot answer. */
async function npmGlobalRoot(): Promise<string | null> {
  if (npmRootCache && Date.now() - npmRootCache.at < NPM_ROOT_TTL_MS) return npmRootCache.value;
  const env = await getEnrichedEnv().catch(() => process.env);
  const value = await new Promise<string | null>((resolvePromise) => {
    const [command, args] =
      process.platform === "win32"
        ? ["cmd.exe", ["/c", "npm", "root", "-g"]]
        : ["npm", ["root", "-g"]];
    execFile(command, args, { env, timeout: 5_000, windowsHide: true }, (error, stdout) => {
      const root = String(stdout ?? "").trim();
      resolvePromise(!error && root && isAbsolute(root) ? root : null);
    });
  });
  npmRootCache = { value, at: Date.now() };
  return value;
}

let failedUserPiVersion: string | null = null;

/**
 * Stop launching the user's Pi at `version` for the rest of this app session,
 * after a Cora process on it failed to start. Updating Pi to any other
 * version makes it eligible again.
 */
export function markUserPiRuntimeFailed(version: string): void {
  failedUserPiVersion = version;
}

/**
 * The Pi that runs Cora's sessions: the user's own install once there is
 * one, and until then the build bundled with the app, so Cora keeps
 * working on a machine without Node while Settings recommends installing
 * Pi. A user install that already failed to start falls back the same way.
 */
export async function resolveCodaraPiRuntime(): Promise<PiRuntimeLocation> {
  const user = await resolveUserPiRuntime().catch(() => null);
  if (user && user.version !== failedUserPiVersion) return user;
  return resolveCodaraPiLibrary();
}

function expiredSignInError(provider: PiProvider): Error {
  const name = provider === "openrouter" ? "OpenRouter" : familyForSubscription(provider).displayName;
  return new Error(
    `Cora's ${name} sign-in expired and cannot be renewed (OAuth session expired). Sign in again in Settings > Accounts.`,
  );
}

let windowsBashPath: Promise<string | null> | null = null;

/** Git for Windows' bash.exe, resolved once; null off Windows or when absent. */
function resolveWindowsBashPath(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  windowsBashPath ??= (async () => {
    const git = await resolveBinary("git").catch(() => null);
    for (const candidate of windowsGitBashCandidates(process.env, git)) {
      const found = await stat(candidate).catch(() => null);
      if (found?.isFile()) return candidate;
    }
    return null;
  })();
  return windowsBashPath;
}

/**
 * Keep Codara's keys in the isolated agent dir's settings.json: Pi's retry
 * budget and, on Windows, the bash it must use. Rewritten only when the
 * merged content differs, since manager and worker processes of one account
 * share the file. Best-effort: Pi's defaults still launch a working session.
 */
async function writeCodaraPiAgentSettings(configDir: string): Promise<void> {
  const file = join(configDir, "settings.json");
  try {
    const raw = await readFile(file, "utf8").catch(() => null);
    let existing: unknown = {};
    if (raw !== null) {
      // A file that does not parse was edited by hand; never overwrite it.
      try { existing = JSON.parse(raw); }
      catch { return; }
    }
    const merged = mergeCodaraPiAgentSettings(existing, {
      shellPath: await resolveWindowsBashPath(),
    });
    const next = `${JSON.stringify(merged, null, 2)}\n`;
    if (next === raw) return;
    await writeFileAtomic(file, next, { mode: 0o600 });
  } catch (error) {
    console.warn(`[pi-runtime] could not write ${file}:`, error);
  }
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
  // The roster holds MCP credentials, so every path that throws after it was
  // written, including a sibling of this Promise.all rejecting, removes it.
  const mcpWrite = untrustedPullRequest
    ? Promise.resolve(null)
    : writePiMcpBridgeConfig({
        audience: "cora",
        sessionId: options.sessionId,
        cwd: options.cwd,
        mcpConfigDir: paths.mcpConfigDir,
        live: true,
      });
  try {
    const [runtime, auth, webSearchExtensionPath, mcp, settings, skillPaths] = await Promise.all([
      resolveCodaraPiRuntime(),
      isOpenRouter
        ? Promise.resolve(null)
        : inspectPiSubscriptionAuth(paths.authFile, options.provider as PiSubscriptionProvider).catch(
            (error: unknown) => {
              throw account.accountProfileId
                ? error
                : legacyAuthFailureAsNoAccount(error, options.provider as PiSubscriptionProvider);
            },
          ),
      resolveCodaraPiWebSearchExtension(),
      mcpWrite,
      loadSettings(),
      untrustedPullRequest
        ? Promise.resolve(undefined)
        : resolveCodaraPiSkillPaths(options.cwd, paths.configDir),
    ]);
    if (auth?.expired && !auth.canRefresh) {
      throw expiredSignInError(options.provider);
    }
    await Promise.all([
      mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
      mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }),
    ]);
    await writeCodaraPiAgentSettings(paths.configDir);
    const plan = buildPiManagerLaunchPlan({
      runtime,
      provider: options.provider,
      apiKey: options.apiKey,
      accountProfileId: account.accountProfileId,
      fastMode:
        options.fastMode ?? (await resolveCodaraPiFastMode(options.provider, options.model)),
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
      skillPaths,
      model: options.model,
      thinking: options.thinking ?? "high",
      sessionName: options.sessionName,
      projectPolicyMode: options.projectPolicyMode,
      autoCompactPercent: settings.coraAutoCompactPercent,
      codaraHomeDir: codaraHome(),
      processExecutable: electronAsNodeInterpreter(),
    });
    // Cora is offered only models it can launch; the ones waiting on a sign-in
    // are named separately so it can tell the user instead of planning on them.
    const workerModels = await coraWorkerModelAvailability(settings);
    plan.env.CODARA_PI_WORKER_MODELS = JSON.stringify(workerModels.connected);
    if (workerModels.disconnected.length > 0) {
      plan.env.CODARA_PI_WORKER_MODELS_DISCONNECTED = JSON.stringify(workerModels.disconnected);
    }
    if (settings.coraAlwaysVerifyEdits) plan.env.CODARA_PI_ALWAYS_VERIFY_EDITS = "1";
    return untrustedPullRequest
      ? attachUntrustedSocketCapability(plan, {
          audience: "untrusted-pi-manager",
          runId: options.runId,
        })
      : plan;
  } catch (error) {
    const written = await mcpWrite.catch(() => null);
    await cleanupPiMcpBridgeConfig({ mcpConfigPath: written?.mcpConfigPath ?? null });
    throw error;
  }
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
  const [runtime, auth, webSearchExtensionPath, skillPaths] = await Promise.all([
    resolveCodaraPiRuntime(),
    isOpenRouter
      ? Promise.resolve(null)
      : inspectPiSubscriptionAuth(paths.authFile, options.provider as PiSubscriptionProvider).catch(
          (error: unknown) => {
            throw account.accountProfileId
              ? error
              : legacyAuthFailureAsNoAccount(error, options.provider as PiSubscriptionProvider);
          },
        ),
    resolveCodaraPiWebSearchExtension(),
    untrustedPullRequest
      ? Promise.resolve(undefined)
      : resolveCodaraPiSkillPaths(options.cwd, paths.configDir),
  ]);
  if (auth?.expired && !auth.canRefresh) {
    throw expiredSignInError(options.provider);
  }
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeCodaraPiAgentSettings(paths.configDir);
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
      fastMode: await resolveCodaraPiFastMode(options.provider, options.model),
      autoCompactPercent: await autoCompactPercentSetting(),
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
      skillPaths,
      model: options.model,
      thinking: options.thinking ?? "high",
      sessionName: options.sessionName,
      codaraHomeDir: codaraHome(),
      processExecutable: electronAsNodeInterpreter(),
    });
    plan.env.CODARA_PI_HOST_COMPACTION = "1";
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
      plan.env.CODARA_PI_DIRECT_STUDIO_TOOLS = "1";
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

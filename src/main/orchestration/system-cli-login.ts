import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, promises as fs, type FSWatcher } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { PiSubscriptionProvider } from "@shared/types";
import { isCodaraManagedCliPath } from "./codara-managed-cli-roots";
import {
  anthropicAccountFingerprint,
  normalizeAccountEmail,
  readCodexCliAccountIdentity,
  readGrokCliAccountIdentity,
} from "./native-cli-account-identity";

/**
 * The System login: whatever login `claude`, `codex` or `grok` uses when
 * started from Codara's inherited environment with no override. Codara reads
 * only who it is, never a token: Claude's identity comes from `.claude.json`
 * and its signed-in state from the existence of the credential (the macOS
 * Keychain is asked whether the item exists, without -w, so no secret is
 * read and no prompt appears); Codex and Grok identities come from their
 * auth.json claims, decoded in memory and dropped. Nothing here writes, locks
 * or refreshes anything.
 */

export interface SystemLogin {
  provider: PiSubscriptionProvider;
  /** The resolved home: a user-set CLAUDE_CONFIG_DIR / CODEX_HOME / GROK_HOME, or the default one. */
  home: string;
  signedIn: boolean;
  /** Codex only: signed in with an API key rather than a ChatGPT login. */
  apiKey?: boolean;
  email?: string;
  identityFingerprint?: string;
}

export interface SystemLoginOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Test seam for the Keychain existence check. */
  securityBinary?: string;
}

const MAX_CONFIG_BYTES = 32 * 1024 * 1024;
const MAX_AUTH_BYTES = 256 * 1024;
const KEYCHAIN_SERVICE = "Claude Code-credentials";

function userHome(options: SystemLoginOptions): string {
  return options.homeDir ?? homedir();
}

/** A user-set home, unless it names a directory Codara manages (a retired export). */
function userSetHome(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || isCodaraManagedCliPath(trimmed)) return null;
  return resolve(trimmed);
}

export function systemCliHome(provider: PiSubscriptionProvider, options: SystemLoginOptions = {}): string {
  const env = options.env ?? process.env;
  const home = userHome(options);
  if (provider === "anthropic") return userSetHome(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
  if (provider === "openai-codex") return userSetHome(env.CODEX_HOME) ?? join(home, ".codex");
  return userSetHome(env.GROK_HOME) ?? join(home, ".grok");
}

async function readSmallJson(path: string, maxBytes: number): Promise<unknown> {
  try {
    const stats = await fs.stat(path);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    return JSON.parse(await fs.readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  return fs.stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function claudeKeychainService(configDirEnv: string | null): string {
  if (!configDirEnv) return KEYCHAIN_SERVICE;
  const suffix = createHash("sha256").update(resolve(configDirEnv).normalize("NFC")).digest("hex").slice(0, 8);
  return `${KEYCHAIN_SERVICE}-${suffix}`;
}

/** Whether a Keychain item exists. No -w: the secret is never read and no prompt can appear. */
function keychainItemExists(service: string, securityBinary: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile(
      securityBinary,
      ["find-generic-password", "-a", userInfo().username, "-s", service],
      { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error) => resolvePromise(!error),
    );
  });
}

async function readClaudeSystemLogin(options: SystemLoginOptions): Promise<SystemLogin> {
  const env = options.env ?? process.env;
  const configDirEnv = userSetHome(env.CLAUDE_CONFIG_DIR);
  const home = configDirEnv ?? join(userHome(options), ".claude");
  const legacy = join(home, ".config.json");
  const configFile = (await isFile(legacy))
    ? legacy
    : join(configDirEnv ?? userHome(options), ".claude.json");
  const config = await readSmallJson(configFile, MAX_CONFIG_BYTES);
  const oauthAccount = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : null;
  const uuid = typeof oauthAccount?.accountUuid === "string" ? oauthAccount.accountUuid.trim() : "";
  const email = normalizeAccountEmail(oauthAccount?.emailAddress);
  const platform = options.platform ?? process.platform;
  let signedIn = await isFile(join(home, ".credentials.json"));
  if (!signedIn && platform === "darwin" && process.env.CODARA_DISABLE_KEYCHAIN !== "1") {
    signedIn = await keychainItemExists(
      claudeKeychainService(configDirEnv),
      options.securityBinary ?? "/usr/bin/security",
    );
  }
  return {
    provider: "anthropic",
    home,
    signedIn,
    ...(email ? { email } : {}),
    ...(uuid ? { identityFingerprint: anthropicAccountFingerprint(uuid) } : {}),
  };
}

async function readCodexSystemLogin(options: SystemLoginOptions): Promise<SystemLogin> {
  const home = systemCliHome("openai-codex", options);
  const authFile = join(home, "auth.json");
  const parsed = await readSmallJson(authFile, MAX_AUTH_BYTES);
  if (!isRecord(parsed)) return { provider: "openai-codex", home, signedIn: false };
  const hasTokens = isRecord(parsed.tokens);
  const apiKey = typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0;
  if (!hasTokens) {
    return { provider: "openai-codex", home, signedIn: apiKey, ...(apiKey ? { apiKey: true } : {}) };
  }
  const identity = await readCodexCliAccountIdentity(authFile);
  return {
    provider: "openai-codex",
    home,
    signedIn: true,
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
  };
}

async function readGrokSystemLogin(options: SystemLoginOptions): Promise<SystemLogin> {
  const home = systemCliHome("xai", options);
  const authFile = join(home, "auth.json");
  if (!(await isFile(authFile))) return { provider: "xai", home, signedIn: false };
  const identity = await readGrokCliAccountIdentity(authFile);
  return {
    provider: "xai",
    home,
    signedIn: Boolean(identity.fingerprint || identity.email),
    ...(identity.email ? { email: identity.email } : {}),
    ...(identity.fingerprint ? { identityFingerprint: identity.fingerprint } : {}),
  };
}

export async function readSystemLogin(
  provider: PiSubscriptionProvider,
  options: SystemLoginOptions = {},
): Promise<SystemLogin> {
  if (provider === "anthropic") return readClaudeSystemLogin(options);
  if (provider === "openai-codex") return readCodexSystemLogin(options);
  return readGrokSystemLogin(options);
}

export interface Disposable {
  dispose(): void;
}

/**
 * Call `onChange` when the System login's files change. Read-only: a watcher
 * never creates the directory it watches, and a home that does not exist yet
 * is simply not watched.
 */
export function watchSystemLogin(
  provider: PiSubscriptionProvider,
  onChange: () => void,
  options: SystemLoginOptions = {},
): Disposable {
  const home = systemCliHome(provider, options);
  const directories = provider === "anthropic" ? [home, userHome(options)] : [home];
  const names =
    provider === "anthropic" ? new Set([".credentials.json", ".claude.json", ".config.json"]) : new Set(["auth.json"]);
  const watchers: FSWatcher[] = [];
  for (const directory of new Set(directories)) {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (!filename || names.has(String(filename))) onChange();
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Nothing to watch yet.
    }
  }
  return {
    dispose() {
      for (const watcher of watchers) watcher.close();
    },
  };
}

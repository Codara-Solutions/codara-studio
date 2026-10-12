import { randomBytes } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertCodaraOwnedEntry,
  assertCodaraOwnedWrite,
  isPathInside,
  isProtectedCliPath,
  OutsideWriteError,
  protectedCliPaths,
} from "../outside-write-guard";
import {
  CLAUDE_ACCOUNT_SCOPED_CONFIG_KEYS,
  updateClaudeGlobalConfig,
} from "./claude-cli-live-login";
import { atomicWritePrivateFile } from "./native-cli-atomic-file";

/**
 * The homes Codara runs Claude Code, Codex and Grok in for a managed
 * account. Each is a directory under Codara's own home whose shared state
 * (projects, sessions, skills, settings) links into the user's own CLI home,
 * while the login and everything account-scoped stays private. The user's
 * home is only ever read here: a link target that does not exist is not
 * created, nothing is moved into it, and a link the CLI replaced with a file
 * of its own is left alone.
 *
 * Shared names are an allowlist (Codex excepted, see below), so a name a new
 * CLI version invents stays private until someone classifies it: a new
 * credential-bearing file can never be shared by accident.
 *
 * Windows is a deliberate no-op for links (creating one needs privileges
 * most users lack): a managed home there is simply private.
 */

const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/** ~/.claude entries a managed Claude home links to, when they exist. */
export const CLAUDE_SHARED_STATE_NAMES: readonly string[] = [
  "projects",
  "todos",
  "plans",
  "skills",
  "agents",
  "commands",
  "plugins",
  "output-styles",
  "file-history",
  "CLAUDE.md",
  "settings.json",
  "keybindings.json",
  "history.jsonl",
];

/**
 * Codex follows T3 Code's layout: every top-level entry of the user's Codex
 * home is linked except these, which hold the login or per-account caches.
 */
export const CODEX_PRIVATE_STATE_NAMES: readonly string[] = [
  "auth.json",
  "models_cache.json",
  "log",
  "memories",
  "tmp",
];

/** ~/.grok entries a managed Grok home links to, when they exist. */
export const GROK_SHARED_STATE_NAMES: readonly string[] = [
  "sessions",
  "skills",
  "personas",
  "memory",
  "AGENTS.md",
];

/** A managed Grok home's private copy of the System config. */
export const GROK_CONFIG_FILE = "config.toml";

export interface ManagedHomeLog {
  (message: string): void;
}

const warnedReplacedLinks = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
}

/**
 * A managed home must sit inside `root` (its CLI's directory under Codara's
 * home) and must not be, contain, or sit inside any home of the user's
 * (Orca's assertOutsideDefaultClaudeHomes). Every provisioning and purge
 * step asks first.
 */
export function assertManagedHome(home: string, root: string): void {
  const absolute = resolve(home);
  if (!isPathInside(absolute, root) || resolve(root) === absolute) {
    throw new OutsideWriteError(absolute);
  }
  if (isProtectedCliPath(absolute)) throw new OutsideWriteError(absolute);
  for (const protectedPath of protectedCliPaths()) {
    if (isPathInside(protectedPath, absolute)) throw new OutsideWriteError(absolute);
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  assertCodaraOwnedWrite(path);
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("A managed CLI home is a symlink or not a directory");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    await fs.chmod(path, 0o700);
  }
}

/** Point `entry` at `target` by a temporary link renamed over it, never a gap. */
async function placeLink(entry: string, target: string, directory: boolean): Promise<void> {
  assertCodaraOwnedEntry(entry);
  const temporary = join(dirname(entry), `.${basename(entry)}.codara-link-${randomBytes(4).toString("hex")}`);
  await fs.symlink(target, temporary, directory ? "dir" : "file");
  try {
    await fs.rename(temporary, entry);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export type SharedLinkOutcome = "linked" | "kept" | "missing-target" | "replaced-by-cli" | "error";

/**
 * Link `home/name` to `source/name` when the source exists. An existing
 * correct link is kept; a link of Codara's to another place is re-pointed;
 * a real file or directory (the CLI replaced the link, or wrote there before
 * the source existed) is left alone and logged once.
 */
async function ensureSharedLink(
  home: string,
  source: string,
  name: string,
  log?: ManagedHomeLog,
): Promise<SharedLinkOutcome> {
  const target = join(source, name);
  const entry = join(home, name);
  try {
    const targetStats = await fs.stat(target).catch(() => null);
    const entryStats = await lstatOrNull(entry);
    if (!targetStats) return "missing-target";
    if (entryStats && !entryStats.isSymbolicLink()) {
      const key = `${home}\0${name}`;
      if (!warnedReplacedLinks.has(key)) {
        warnedReplacedLinks.add(key);
        log?.(`[accounts] ${name} in a managed CLI home is a file of its own; it stays private`);
      }
      return "replaced-by-cli";
    }
    if (entryStats && (await fs.readlink(entry)) === target) return "kept";
    await placeLink(entry, target, targetStats.isDirectory());
    return "linked";
  } catch (error) {
    log?.(
      `[accounts] could not link ${name} in a managed CLI home: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "error";
  }
}

/**
 * A private name that is a link (an older layout shared it) becomes the
 * home's own: the link goes, and the CLI or the account code writes a real
 * file there. Nothing behind the link is touched.
 */
async function unlinkPrivateName(home: string, name: string): Promise<void> {
  const entry = join(home, name);
  const stats = await lstatOrNull(entry);
  if (!stats?.isSymbolicLink()) return;
  assertCodaraOwnedEntry(entry);
  await fs.unlink(entry);
}

// ---------------------------------------------------------------------------
// Claude Code.

/** The System `.claude.json` of a Claude home, read-only. */
export function systemClaudeConfigFile(systemHome: string, systemConfigDirEnv: string | null): string {
  return join(systemConfigDirEnv ?? dirname(resolve(systemHome)), ".claude.json");
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const stats = await fs.stat(path);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return null;
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Entries older Codara builds wrote into the user's config; never copied. */
function isCodaraMcpEntry(value: unknown): boolean {
  return isRecord(value) && value._sparkManaged === true;
}

function userMcpServers(config: Record<string, unknown> | null): Record<string, unknown> {
  const servers: Record<string, unknown> = {};
  if (!config || !isRecord(config.mcpServers)) return servers;
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!isCodaraMcpEntry(server)) servers[name] = server;
  }
  return servers;
}

/**
 * The `.claude.json` a managed home starts with: the user's own, minus the
 * account it is signed in as (identity, user id and the caches computed for
 * that account) and minus the entries older Codara builds added.
 */
export function managedClaudeConfigFrom(
  system: Record<string, unknown> | null,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(system ?? {}) };
  for (const key of CLAUDE_ACCOUNT_SCOPED_CONFIG_KEYS) delete config[key];
  delete config.userID;
  const servers = userMcpServers(system);
  if (Object.keys(servers).length > 0) config.mcpServers = servers;
  else delete config.mcpServers;
  return config;
}

export interface ClaudeManagedHomeInput {
  /** The managed CLAUDE_CONFIG_DIR. */
  home: string;
  /** Codara's claude-cli directory: every managed home sits inside it. */
  root: string;
  /** The System login's Claude home (~/.claude or a user-set CLAUDE_CONFIG_DIR). */
  systemHome: string;
  /** A user-set CLAUDE_CONFIG_DIR, or null when the System login uses ~/.claude. */
  systemConfigDirEnv: string | null;
  log?: ManagedHomeLog;
}

/**
 * Create or refresh a managed Claude home: links for the shared allowlist,
 * a Codara-generated `.claude.json` on first use, and on every later call a
 * one-way merge of the user's MCP servers (theirs win on equal names,
 * nothing is removed) so a server added globally shows up here too. That
 * write lands in the home's own `.claude.json` under Claude Code's lock.
 */
export async function ensureClaudeManagedHome(input: ClaudeManagedHomeInput): Promise<void> {
  assertManagedHome(input.home, input.root);
  await ensurePrivateDirectory(input.home);
  if (process.platform !== "win32") {
    for (const name of CLAUDE_SHARED_STATE_NAMES) {
      await ensureSharedLink(input.home, input.systemHome, name, input.log);
    }
  }
  const system = await readJsonObject(
    systemClaudeConfigFile(input.systemHome, input.systemConfigDirEnv),
  );
  const configFile = join(input.home, ".claude.json");
  const existing = await lstatOrNull(configFile);
  if (!existing) {
    await atomicWritePrivateFile(
      configFile,
      `${JSON.stringify(managedClaudeConfigFrom(system), null, 2)}\n`,
    );
    return;
  }
  if (existing.isSymbolicLink() || !existing.isFile()) return;
  const servers = userMcpServers(system);
  if (Object.keys(servers).length === 0) return;
  const home = { configDir: input.home, configDirEnv: input.home, homeDir: dirname(input.home) };
  await updateClaudeGlobalConfig(home, (config) => {
    const current = isRecord(config.mcpServers) ? config.mcpServers : {};
    let changed = false;
    const merged: Record<string, unknown> = { ...current };
    for (const [name, server] of Object.entries(servers)) {
      if (JSON.stringify(current[name]) === JSON.stringify(server)) continue;
      merged[name] = server;
      changed = true;
    }
    return changed ? { ...config, mcpServers: merged } : null;
  }).catch((error: unknown) => {
    input.log?.(
      `[accounts] could not merge MCP servers into a managed Claude home: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

// ---------------------------------------------------------------------------
// Codex.

export interface CodexManagedHomeInput {
  /** The managed CODEX_HOME. */
  home: string;
  /** Codara's codex-cli directory. */
  root: string;
  /** The System login's Codex home (~/.codex or a user-set CODEX_HOME). */
  systemHome: string;
  log?: ManagedHomeLog;
}

/**
 * Create or refresh a managed Codex home (T3 Code's CodexHomeLayout): every
 * top-level entry of the user's Codex home is linked except the private
 * names, a private name left as a link by an older layout becomes the
 * home's own, and entries missing from the user's home are not created.
 */
export async function ensureCodexManagedHome(input: CodexManagedHomeInput): Promise<void> {
  assertManagedHome(input.home, input.root);
  await ensurePrivateDirectory(input.home);
  for (const name of CODEX_PRIVATE_STATE_NAMES) await unlinkPrivateName(input.home, name);
  if (process.platform === "win32") return;
  const names = await fs.readdir(input.systemHome).catch(() => [] as string[]);
  const privateNames = new Set(CODEX_PRIVATE_STATE_NAMES);
  for (const name of names) {
    // Lock and temporary files of a running Codex are its own business.
    if (privateNames.has(name) || name.endsWith(".lock") || name.startsWith(".")) continue;
    await ensureSharedLink(input.home, input.systemHome, name, input.log);
  }
}

// ---------------------------------------------------------------------------
// Grok.

export interface GrokManagedHomeInput {
  /** The managed GROK_HOME. */
  home: string;
  /** Codara's grok-cli directory. */
  root: string;
  /** The System login's Grok home (~/.grok or a user-set GROK_HOME). */
  systemHome: string;
  log?: ManagedHomeLog;
}

/**
 * Create or refresh a managed Grok home: the shared allowlist is linked when
 * the user's entries exist, and `config.toml` is a private copy of the
 * user's, regenerated when theirs changes, so Grok never writes through to
 * the user's config from a managed account.
 */
export async function ensureGrokManagedHome(input: GrokManagedHomeInput): Promise<void> {
  assertManagedHome(input.home, input.root);
  await ensurePrivateDirectory(input.home);
  if (process.platform !== "win32") {
    for (const name of GROK_SHARED_STATE_NAMES) {
      await ensureSharedLink(input.home, input.systemHome, name, input.log);
    }
  }
  await unlinkPrivateName(input.home, GROK_CONFIG_FILE);
  const source = await fs
    .readFile(join(input.systemHome, GROK_CONFIG_FILE), "utf8")
    .catch(() => null);
  if (source === null) return;
  const target = join(input.home, GROK_CONFIG_FILE);
  const current = await fs.readFile(target, "utf8").catch(() => null);
  if (current === source) return;
  await atomicWritePrivateFile(target, source);
}

// ---------------------------------------------------------------------------
// Purge.

/**
 * Remove a managed account's directory for good. The path must sit strictly
 * inside `accountsRoot`; rm never follows the links inside it, so what they
 * point at in the user's home stays.
 */
export async function purgeManagedPath(path: string, accountsRoot: string): Promise<boolean> {
  const absolute = resolve(path);
  if (!isPathInside(absolute, accountsRoot) || absolute === resolve(accountsRoot)) {
    throw new OutsideWriteError(absolute);
  }
  assertCodaraOwnedEntry(absolute);
  const stats = await lstatOrNull(absolute);
  if (!stats) return false;
  if (stats.isSymbolicLink()) {
    await fs.unlink(absolute);
    return true;
  }
  if (isProtectedCliPath(absolute)) throw new OutsideWriteError(absolute);
  await fs.rm(absolute, { recursive: true, force: true });
  return true;
}

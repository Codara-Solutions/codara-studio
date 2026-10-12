import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";

import { codaraHome, defaultCodaraHome, LEGACY_DIR_NAMES } from "./codara-home";
import { restoreUserNotify } from "./codex-notify-installer";
import { writeFileAtomic } from "./fs-atomic";
import { isGeneratedHookCommand, isTransientPath } from "./hook-installer";
import { globalInstallBlockedReason } from "./mcp-installer";
import { parseTomlText } from "./mcp-toml";
import { claudeUserConfigFile, personalClaudeConfigDir } from "./orchestration/claude-paths";
import { resolveCodexHomePaths } from "./orchestration/codex-home";
import { defaultPersonalGrokHomeDir } from "./orchestration/grok-cli-account-profiles";
import { outsideWriteCapability } from "./outside-write-guard";

/**
 * The one place Codara edits another tool's config: it takes back what
 * earlier builds wrote into the user's Claude Code, Codex and Grok configs
 * (hooks in settings.json, the codara-studio server in ~/.claude.json and
 * config.toml, the Codex notify program). Section 10 of the accounts spec.
 *
 * Conservative by construction: an entry is removed only when it is exactly
 * what a Codara build generated, every other byte is kept, the original is
 * copied to <codaraHome>/backups/global-config-cleanup/<ISO>/ first, a file
 * that does not parse is never rewritten, and a file that changed between
 * read and write is left for the next boot. Runs at every boot and is
 * read-only when nothing matches, so an older build on the same machine that
 * re-adds its entries is cleaned again.
 */

/** Explicit exception to the outside-write guard: this cleanup, and only it. */
const CLEANUP_WRITE = outsideWriteCapability("the one-time cleanup of entries older Codara builds wrote");

export type CleanupResult =
  | "cleaned"
  | "nothing"
  | "user-modified-skip"
  | "conflict-retry"
  | "parse-error-skip";

export interface CleanupFileReport {
  path: string;
  result: CleanupResult;
  removed: string[];
  backup?: string;
}

export interface GlobalConfigCleanupReport {
  at: string;
  backupDir: string | null;
  files: CleanupFileReport[];
  /** `.codara-backup-*` files earlier builds left beside the configs; listed, never removed. */
  leftoverBackups: string[];
  /** Why the user's own CLI configs were left alone in this run, when the installer's gate refused. */
  skipped?: string;
}

export interface GlobalConfigCleanupOptions {
  /** "Codara tools in other apps" is on: its MCP entries are the user's choice. */
  keepMcpEntries?: boolean;
  home?: string;
  claudeSettingsPath?: string;
  claudeConfigPath?: string;
  codexConfigPath?: string | null;
  grokConfigPath?: string;
  /** Codara's own Claude homes, walked for private settings.json files. */
  managedClaudeRoot?: string;
  now?: () => Date;
  /** Test seam: runs between the first read and the re-read of a file. */
  beforeReread?: (path: string) => Promise<void>;
  /** Why this instance may not touch the user's CLI configs; the installer's gate by default. */
  blockedReason?: () => Promise<string | null>;
  /** A config that is itself throwaway (in a temp directory) is cleaned even then. */
  isThrowawayPath?: (path: string) => Promise<boolean>;
  /** The home the user's own install runs with; ~/.codarastudio by default. */
  defaultHome?: string;
}

type Plan = { next: string; removed: string[] } | "nothing" | "parse-error";

// ---------------------------------------------------------------------------
// Claude settings.json hooks.

const HOOK_HANDLER_KEYS = new Set(["type", "command", "timeout", "_codaraManaged", "_codaraVersion", "_sparkManaged", "_sparkVersion"]);
const HOOK_GROUP_KEYS = new Set(["matcher", "hooks", "_codaraManaged", "_codaraVersion", "_sparkManaged", "_sparkVersion"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isGeneratedHookHandler(handler: unknown): boolean {
  return (
    isRecord(handler) &&
    onlyKeys(handler, HOOK_HANDLER_KEYS) &&
    handler.type === "command" &&
    isGeneratedHookCommand(handler.command)
  );
}

// Re-serialize the way the file was written: its indent, and whether it ends
// in a newline.
function serializeLike(original: string, value: unknown): string {
  const indent = /\n([ \t]+)"/.exec(original)?.[1] ?? "  ";
  const text = JSON.stringify(value, null, indent.includes("\t") ? "\t" : indent.length);
  return original.endsWith("\n") ? `${text}\n` : text;
}

export function planClaudeSettings(text: string): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "parse-error";
  }
  if (!isRecord(parsed)) return "parse-error";
  const hooks = parsed.hooks;
  if (!isRecord(hooks)) return "nothing";
  const removed: string[] = [];
  const nextHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[event] = groups;
      continue;
    }
    const keep: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        keep.push(group);
        continue;
      }
      const survivors = group.hooks.filter((handler) => !isGeneratedHookHandler(handler));
      const dropped = group.hooks.length - survivors.length;
      if (dropped === 0) {
        keep.push(group);
        continue;
      }
      if (survivors.length > 0) {
        keep.push({ ...group, hooks: survivors });
      } else if (!onlyKeys(group, HOOK_GROUP_KEYS)) {
        // A group carrying keys of the user's own stays exactly as it was.
        keep.push(group);
        continue;
      }
      for (let i = 0; i < dropped; i += 1) removed.push(`hooks.${event}`);
    }
    // An event array this pass emptied goes; one the user left empty stays.
    if (keep.length === 0 && groups.length > 0) continue;
    nextHooks[event] = keep;
  }
  if (removed.length === 0) return "nothing";
  return { next: serializeLike(text, { ...parsed, hooks: nextHooks }), removed };
}

// ---------------------------------------------------------------------------
// ~/.claude.json mcpServers.

const MANAGED_MCP_NAMES = new Set(["codara-studio", "cora-preview", "cora-orchestrator"]);
const MANAGED_MCP_KEYS = new Set(["type", "command", "args", "env", "_sparkManaged", "_sparkVersion"]);
const MANAGED_SERVER_SCRIPT = /(?:^|[\\/])(?:codara-studio-mcp|cora-preview-mcp|cora-orchestrator-mcp|spark-preview-mcp|spark-orchestrator-mcp)[\\/]server\.js$/;

/**
 * Whose "Codara tools in other apps" entries a run may take back. An entry
 * baked for another Codara home is that home's opt-in, which this instance's
 * setting says nothing about. The default home also owns the homes it was
 * renamed or copied from, and entries of builds that baked no SPARK_HOME_DIR,
 * which no other home can claim.
 */
export interface HomeOwner {
  homes: ReadonlySet<string>;
  unmarked: boolean;
}

function canonicalPath(value: string): string {
  let out: string;
  try {
    out = realpathSync(value);
  } catch {
    out = resolve(value);
  }
  return process.platform === "win32" ? out.toLowerCase() : out;
}

export function homeOwner(home: string, defaultHome: string = defaultCodaraHome()): HomeOwner {
  const own = canonicalPath(home);
  const isDefault = own === canonicalPath(defaultHome);
  const legacy = isDefault ? LEGACY_DIR_NAMES.map((name) => canonicalPath(join(dirname(defaultHome), name))) : [];
  return { homes: new Set([own, ...legacy]), unmarked: isDefault };
}

// A null owner (Codara's own managed copies) accepts every home.
function bakedForHome(env: unknown, owner: HomeOwner | null): boolean {
  if (owner === null) return true;
  const baked = isRecord(env) ? env.SPARK_HOME_DIR : undefined;
  if (typeof baked !== "string" || baked.trim() === "") return owner.unmarked;
  return owner.homes.has(canonicalPath(baked.trim()));
}

function isGeneratedMcpEntry(name: string, entry: unknown, owner: HomeOwner | null = null): boolean {
  if (!MANAGED_MCP_NAMES.has(name) && !name.startsWith("spark-")) return false;
  if (!isRecord(entry) || entry._sparkManaged !== true || !onlyKeys(entry, MANAGED_MCP_KEYS)) return false;
  const args = entry.args;
  if (!Array.isArray(args) || typeof args[0] !== "string" || !MANAGED_SERVER_SCRIPT.test(args[0])) return false;
  return bakedForHome(entry.env, owner);
}

export function planClaudeUserConfig(text: string, owner: HomeOwner | null = null): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "parse-error";
  }
  if (!isRecord(parsed)) return "parse-error";
  const servers = parsed.mcpServers;
  if (!isRecord(servers)) return "nothing";
  const removed: string[] = [];
  const nextServers: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (isGeneratedMcpEntry(name, entry, owner)) removed.push(`mcpServers.${name}`);
    else nextServers[name] = entry;
  }
  if (removed.length === 0) return "nothing";
  return { next: serializeLike(text, { ...parsed, mcpServers: nextServers }), removed };
}

// ---------------------------------------------------------------------------
// config.toml (Codex and Grok): the marked codara-studio blocks, and Codex's
// notify program.

const TOML_BLOCKS: ReadonlyArray<[string, string]> = [
  ["# >>> SPARK_AGENT_BUILTIN_MCP", "# <<< SPARK_AGENT_BUILTIN_MCP"],
  ["# >>> SPARK_AGENT_ORCHESTRATOR_MCP", "# <<< SPARK_AGENT_ORCHESTRATOR_MCP"],
];
const TOML_SERVER_NAMES = new Set(["codara-studio", "cora-preview", "cora-orchestrator", "spark-preview", "spark-orchestrator"]);
const TOML_SERVER_KEYS = new Set(["command", "args", "enabled", "startup_timeout_sec", "tool_timeout_sec", "env"]);
const TOML_ENV_KEYS = new Set(["ELECTRON_RUN_AS_NODE", "SPARK_HOME_DIR", "SPARK_MCP_MODE"]);

// The block must hold nothing but codara-studio-shaped server tables.
function isGeneratedTomlBlock(block: string, owner: HomeOwner | null = null): boolean {
  const parsed = parseTomlText(block);
  if (!parsed.ok) return false;
  const keys = Object.keys(parsed.value);
  if (keys.length !== 1 || keys[0] !== "mcp_servers") return false;
  const servers = parsed.value.mcp_servers;
  if (!isRecord(servers) || Object.keys(servers).length === 0) return false;
  for (const [name, table] of Object.entries(servers)) {
    if (!TOML_SERVER_NAMES.has(name) || !isRecord(table) || !onlyKeys(table, TOML_SERVER_KEYS)) return false;
    if (table.env !== undefined && (!isRecord(table.env) || !onlyKeys(table.env, TOML_ENV_KEYS))) return false;
    const args = table.args;
    if (!Array.isArray(args) || typeof args[0] !== "string" || !MANAGED_SERVER_SCRIPT.test(args[0])) return false;
    if (!bakedForHome(table.env, owner)) return false;
  }
  return true;
}

function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}

function lineEnd(text: string, index: number): number {
  const nl = text.indexOf("\n", index);
  return nl < 0 ? text.length : nl + 1;
}

export function planTomlConfig(
  text: string,
  options: { mcp: boolean; notify: boolean; owner?: HomeOwner | null },
): Plan {
  if (!parseTomlText(text).ok) return "parse-error";
  let next = text;
  const removed: string[] = [];
  if (options.mcp) {
    for (const [startMarker, endMarker] of TOML_BLOCKS) {
      for (;;) {
        const at = next.indexOf(startMarker);
        if (at < 0) break;
        const close = next.indexOf(endMarker, at);
        if (close < 0) break;
        const from = lineStart(next, at);
        const to = lineEnd(next, close);
        if (!isGeneratedTomlBlock(next.slice(from, to), options.owner ?? null)) break;
        const candidate = next.slice(0, from) + next.slice(to);
        if (!parseTomlText(candidate).ok) break;
        next = candidate;
        removed.push(startMarker.replace("# >>> ", ""));
      }
    }
  }
  if (options.notify) {
    const restored = restoreUserNotify(next);
    if (restored) {
      next = restored.text;
      removed.push(restored.previous.length > 0 ? "notify (your own value restored)" : "notify");
    }
  }
  return removed.length === 0 ? "nothing" : { next, removed };
}

// ---------------------------------------------------------------------------
// The procedure.

interface Target {
  label: string;
  path: string;
  plan: (text: string) => Plan;
  claudeLock?: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isoStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    const stats = await fs.lstat(path);
    if (!stats.isFile() && !stats.isSymbolicLink()) return null;
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function withClaudeConfigLock<T>(path: string, run: () => Promise<T>): Promise<T | "conflict-retry"> {
  let release: (() => Promise<void>) | null = null;
  try {
    // Claude Code's own lock for ~/.claude.json, with the settings Claude
    // uses, so a write of Claude's cannot interleave with this one. The only
    // lock Codara ever takes in a user's home, and only here.
    release = await lock(path, {
      realpath: false,
      lockfilePath: `${path}.lock`,
      retries: { retries: 20, minTimeout: 50, maxTimeout: 500 },
      stale: 10_000,
    });
  } catch {
    return "conflict-retry";
  }
  try {
    return await run();
  } finally {
    await release().catch(() => undefined);
  }
}

class Backups {
  private dir: string | null = null;
  private manifest: Array<{ path: string; sha256Before: string; sha256After: string; removed: string[] }> = [];

  constructor(
    private readonly root: string,
    private readonly stamp: string,
  ) {}

  get directory(): string | null {
    return this.dir;
  }

  async save(label: string, path: string, before: string, after: string, removed: string[]): Promise<string> {
    this.dir ??= join(this.root, this.stamp);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const copy = join(this.dir, label);
    await writeFileAtomic(copy, before, { mode: 0o600 });
    this.manifest.push({ path, sha256Before: sha256(before), sha256After: sha256(after), removed });
    await writeFileAtomic(join(this.dir, "manifest.json"), `${JSON.stringify(this.manifest, null, 2)}\n`, { mode: 0o600 });
    return copy;
  }
}

async function cleanFile(target: Target, backups: Backups, options: GlobalConfigCleanupOptions): Promise<CleanupFileReport> {
  const first = await readOrNull(target.path);
  if (first === null) return { path: target.path, result: "nothing", removed: [] };
  const plan = target.plan(first);
  if (plan === "nothing") return { path: target.path, result: "nothing", removed: [] };
  if (plan === "parse-error") return { path: target.path, result: "parse-error-skip", removed: [] };
  const backup = await backups.save(target.label, target.path, first, plan.next, plan.removed);
  const write = async (): Promise<CleanupResult> => {
    await options.beforeReread?.(target.path);
    const again = await readOrNull(target.path);
    if (again !== first) return "conflict-retry";
    const real = await fs.realpath(target.path).catch(() => target.path);
    const mode = (await fs.stat(real)).mode & 0o777;
    await writeFileAtomic(real, plan.next, { mode, outsideWrite: CLEANUP_WRITE });
    return "cleaned";
  };
  const result = target.claudeLock ? await withClaudeConfigLock(target.path, write) : await write();
  return { path: target.path, result, removed: result === "cleaned" ? plan.removed : [], backup };
}

async function leftoverBackups(dirs: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const dir of dirs) {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of entries) {
      if (name.includes(".codara-backup-")) found.push(join(dir, name));
    }
  }
  return found.sort();
}

// Older builds also wrote hooks into a managed Claude home's own
// settings.json when the user had none to link to, and a managed home's
// private .claude.json can carry a copied server entry. Those files are
// Codara's, but a session started there would get the old entries beside the
// injected ones, so they go through the same pass. Only real files and
// directories are walked: a link into the user's ~/.claude is never followed.
async function managedClaudeFiles(root: string, name: string, depth = 3): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) found.push(path);
    else if (entry.isDirectory() && depth > 0) found.push(...(await managedClaudeFiles(path, name, depth - 1)));
  }
  return found.sort();
}

function codexConfigPath(): string | null {
  try {
    return resolveCodexHomePaths().configPath;
  } catch {
    return null;
  }
}

function reportPath(home: string): string {
  return join(home, "global-config-cleanup.json");
}

export async function runGlobalConfigCleanup(
  options: GlobalConfigCleanupOptions = {},
): Promise<GlobalConfigCleanupReport> {
  const home = options.home ?? codaraHome();
  const now = (options.now ?? (() => new Date()))();
  const backups = new Backups(join(home, "backups", "global-config-cleanup"), isoStamp(now));
  const claudeSettingsPath = options.claudeSettingsPath ?? join(personalClaudeConfigDir(), "settings.json");
  const claudeConfigPath = options.claudeConfigPath ?? claudeUserConfigFile();
  const codexPath = options.codexConfigPath === undefined ? codexConfigPath() : options.codexConfigPath;
  const grokPath = options.grokConfigPath ?? join(defaultPersonalGrokHomeDir(), "config.toml");
  const mcp = options.keepMcpEntries !== true;
  // A temporary home, or a build running from a temporary folder or a
  // worktree, has no say over the user's own CLI configs: the installer
  // refuses to write them for it, its default-off settings are not the
  // user's choice, and the backups and report would vanish with it. It
  // cleans only configs that are throwaway themselves (an e2e run's fake
  // HOME) and Codara's own managed homes.
  const blocked = await (options.blockedReason ?? globalInstallBlockedReason)();
  const throwaway = options.isThrowawayPath ?? isTransientPath;
  const mayTouch = async (path: string | null): Promise<boolean> =>
    path !== null && (blocked === null || (await throwaway(path)));
  const [claudeSettingsOk, claudeConfigOk, codexOk, grokOk] = await Promise.all(
    [claudeSettingsPath, claudeConfigPath, codexPath, grokPath].map(mayTouch),
  );
  const owner = homeOwner(home, options.defaultHome);

  const managedRoot = options.managedClaudeRoot ?? join(home, "claude-cli");
  const managedSettings = await managedClaudeFiles(managedRoot, "settings.json");
  const managedUserConfigs = mcp ? await managedClaudeFiles(managedRoot, ".claude.json") : [];
  const targets: Target[] = [
    ...(claudeSettingsOk ? [{ label: "claude-settings.json", path: claudeSettingsPath, plan: planClaudeSettings }] : []),
    ...managedSettings.map((path, index) => ({
      label: `codara-claude-home-${index + 1}-settings.json`,
      path,
      plan: planClaudeSettings,
    })),
    ...(mcp && claudeConfigOk
      ? [{ label: "claude.json", path: claudeConfigPath, plan: (text: string) => planClaudeUserConfig(text, owner), claudeLock: true }]
      : []),
    // Codara's own managed homes: every copy there is Codara's to clean.
    ...managedUserConfigs.map((path, index) => ({
      label: `codara-claude-home-${index + 1}-claude.json`,
      path,
      plan: (text: string) => planClaudeUserConfig(text),
      claudeLock: true,
    })),
    ...(codexPath && codexOk
      ? [{ label: "codex-config.toml", path: codexPath, plan: (text: string) => planTomlConfig(text, { mcp, notify: true, owner }) }]
      : []),
    ...(mcp && grokOk
      ? [{ label: "grok-config.toml", path: grokPath, plan: (text: string) => planTomlConfig(text, { mcp: true, notify: false, owner }) }]
      : []),
  ];
  const files: CleanupFileReport[] = [];
  for (const target of targets) {
    try {
      files.push(await cleanFile(target, backups, options));
    } catch (err) {
      console.warn("[global-config-cleanup]", target.path, (err as Error).message);
      files.push({ path: target.path, result: "conflict-retry", removed: [] });
    }
  }
  const report: GlobalConfigCleanupReport = {
    at: now.toISOString(),
    backupDir: files.some((file) => file.result === "cleaned") ? backups.directory : null,
    files,
    leftoverBackups: await leftoverBackups(
      [dirname(claudeSettingsPath), dirname(claudeConfigPath), codexPath ? dirname(codexPath) : null, dirname(grokPath)].filter(
        (dir): dir is string => dir !== null,
      ),
    ),
    ...(blocked ? { skipped: blocked } : {}),
  };
  await recordReport(home, report);
  return report;
}

// The last run that cleaned something is what Settings, About reports, so a
// later boot that finds nothing does not hide where the backup went.
async function recordReport(home: string, report: GlobalConfigCleanupReport): Promise<void> {
  const previous = await readGlobalConfigCleanupReport(home);
  const cleaned = report.backupDir ? report : previous?.lastCleaned ?? null;
  const stored = { version: 1, last: report, lastCleaned: cleaned };
  try {
    await fs.mkdir(home, { recursive: true });
    await writeFileAtomic(reportPath(home), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn("[global-config-cleanup] could not record the report:", (err as Error).message);
  }
}

export async function readGlobalConfigCleanupReport(
  home: string = codaraHome(),
): Promise<{ last: GlobalConfigCleanupReport | null; lastCleaned: GlobalConfigCleanupReport | null } | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(reportPath(home), "utf8")) as Record<string, unknown>;
    return {
      last: (parsed.last as GlobalConfigCleanupReport | undefined) ?? null,
      lastCleaned: (parsed.lastCleaned as GlobalConfigCleanupReport | undefined) ?? null,
    };
  } catch {
    return null;
  }
}

/** The one line Settings, About shows; null when nothing was ever cleaned. */
export async function globalConfigCleanupNotice(home: string = codaraHome()): Promise<string | null> {
  const report = await readGlobalConfigCleanupReport(home);
  const dir = report?.lastCleaned?.backupDir;
  if (!dir) return null;
  return `Removed Codara's old entries from your Claude Code and Codex config. Backup: ${dir}`;
}

export const __test = { isGeneratedTomlBlock, isGeneratedMcpEntry };

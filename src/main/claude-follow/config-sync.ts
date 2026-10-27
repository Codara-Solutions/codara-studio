import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { outsideWriteCapability } from "../outside-write-guard";
import {
  claudeGlobalConfigFile,
  updateClaudeGlobalConfig,
  type ClaudeLiveHome,
} from "../orchestration/claude-cli-live-login";
import { atomicWritePrivateFile, readPrivateJsonFile } from "../orchestration/native-cli-atomic-file";

/**
 * Two-way sync of the MCP servers and folder trust between the user's own
 * `.claude.json` and the live slot's, while plain `claude` follows Codara.
 *
 * A following terminal writes the live slot's `.claude.json`: a server added
 * with `claude mcp add`, a folder trusted at its prompt. Those must still be
 * there when the user stops following or deletes Codara, and what the user
 * adds while on their own login must reach the live slot. Only these keys
 * move, each server by name:
 *
 *   mcpServers                                (user scope)
 *   projects[<folder>].mcpServers             (local scope)
 *   projects[<folder>].hasTrustDialogAccepted
 *   projects[<folder>].enabledMcpjsonServers, .disabledMcpjsonServers,
 *   projects[<folder>].enableAllProjectMcpServers   (.mcp.json approvals)
 *
 * It is a three-way merge against the values both sides last agreed on,
 * kept in Codara's folder: a change on one side is copied to the other, a
 * removal on one side removes it on the other, and when both changed the
 * user's file wins (folder trust given on either side stays given). Every
 * write re-reads its file under the lock Claude Code takes for its own
 * config writes and applies a value only if that entry still is what the
 * merge saw, so a concurrent Claude Code save is never undone; an entry that
 * moved meanwhile waits for the next pass. Every other key, and every entry
 * older Codara builds marked as theirs, is left as it is.
 *
 * Folder trust Codara added itself, before launching Claude Code in a
 * workspace (claude-pretrust.ts), is the live slot's own and never moves:
 * the folders are listed in a record next to the live slot, and their trust
 * leaves are left out of the merge on both sides.
 */

/** The one write into the user's own `.claude.json`. */
const USER_CONFIG_SYNC = outsideWriteCapability(
  "claude-follow: MCP servers and folder trust synced back into the user's .claude.json",
);

const BASE_VERSION = 1;

export const CLAUDE_FOLLOW_SYNCED_PROJECT_KEYS = [
  "hasTrustDialogAccepted",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "enableAllProjectMcpServers",
] as const;

type Leaves = Map<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCodaraEntry(value: unknown): boolean {
  return isRecord(value) && (value._sparkManaged === true || value._codaraManaged === true);
}

/** A default value counts as absent, so a fresh project entry never spreads. */
function meaningful(key: string, value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return key !== "hasTrustDialogAccepted" || value === true;
}

const leafKey = (...path: string[]): string => JSON.stringify(path);

const PRETRUSTED_VERSION = 1;

/** Codara's list of the folders it trusted in a live slot: next to the slot, never inside the user's homes. */
export function claudePretrustedFoldersFile(liveHome: ClaudeLiveHome): string {
  return join(dirname(liveHome.configDir), "pretrusted-folders.json");
}

/** The folders Codara trusted in this live slot; empty when the record is missing or unreadable. */
export async function readClaudePretrustedFolders(liveHome: ClaudeLiveHome): Promise<Set<string>> {
  const read = await readPrivateJsonFile(claudePretrustedFoldersFile(liveHome));
  if (read.kind !== "value" || !isRecord(read.value) || read.value.version !== PRETRUSTED_VERSION) return new Set();
  const folders = Array.isArray(read.value.folders) ? read.value.folders : [];
  return new Set(folders.filter((folder): folder is string => typeof folder === "string"));
}

export function formatClaudePretrustedFolders(folders: Iterable<string>): string {
  return `${JSON.stringify({ version: PRETRUSTED_VERSION, folders: [...folders].sort() }, null, 2)}\n`;
}

/** The synced entries of one config, keyed by their path. */
export function syncedLeaves(config: Record<string, unknown> | null): Leaves {
  const leaves: Leaves = new Map();
  if (!config) return leaves;
  if (isRecord(config.mcpServers)) {
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (!isCodaraEntry(server)) leaves.set(leafKey("mcpServers", name), server);
    }
  }
  if (isRecord(config.projects)) {
    for (const [folder, project] of Object.entries(config.projects)) {
      if (!isRecord(project)) continue;
      if (isRecord(project.mcpServers)) {
        for (const [name, server] of Object.entries(project.mcpServers)) {
          if (!isCodaraEntry(server)) leaves.set(leafKey("projects", folder, "mcpServers", name), server);
        }
      }
      for (const key of CLAUDE_FOLLOW_SYNCED_PROJECT_KEYS) {
        if (meaningful(key, project[key])) leaves.set(leafKey("projects", folder, key), project[key]);
      }
    }
  }
  return leaves;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The project entry Claude Code itself starts a folder with. Claude Code
 * reads a folder's entry as it is, without filling in defaults, so a folder
 * this sync adds gets every one of them, as Claude Code's own trust prompt
 * would write it.
 */
export const CLAUDE_DEFAULT_PROJECT_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
});

function freshProjectConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(CLAUDE_DEFAULT_PROJECT_CONFIG)) as Record<string, unknown>;
}

/** Set (or with undefined, remove) one synced entry in a config object, in place. */
function applyLeaf(config: Record<string, unknown>, key: string, value: unknown): void {
  const path = JSON.parse(key) as string[];
  if (path[0] === "mcpServers") {
    const servers = isRecord(config.mcpServers) ? { ...config.mcpServers } : {};
    if (value === undefined) delete servers[path[1]];
    else servers[path[1]] = value;
    config.mcpServers = servers;
    return;
  }
  const projects = isRecord(config.projects) ? { ...config.projects } : {};
  const folder = path[1];
  if (value === undefined && !isRecord(projects[folder])) return;
  const project = isRecord(projects[folder]) ? { ...projects[folder] } : freshProjectConfig();
  if (path[2] === "mcpServers") {
    const servers = isRecord(project.mcpServers) ? { ...project.mcpServers } : {};
    if (value === undefined) delete servers[path[3]];
    else servers[path[3]] = value;
    project.mcpServers = servers;
  } else if (value === undefined) {
    // Back to Claude Code's default rather than a missing key it may not expect.
    if (path[2] in CLAUDE_DEFAULT_PROJECT_CONFIG) {
      project[path[2]] = JSON.parse(JSON.stringify(CLAUDE_DEFAULT_PROJECT_CONFIG[path[2]])) as unknown;
    } else {
      delete project[path[2]];
    }
  } else {
    project[path[2]] = value;
  }
  projects[folder] = project;
  config.projects = projects;
}

function readLeaf(leaves: Leaves, key: string): unknown {
  return leaves.get(key);
}

export interface MergePlan {
  toUser: Map<string, unknown>;
  toLive: Map<string, unknown>;
  /** What both sides hold once the plan lands. */
  agreed: Map<string, unknown>;
}

/** The three-way merge: each side's change wins over the base, the user's over a conflict. */
export function planConfigMerge(user: Leaves, live: Leaves, base: Leaves): MergePlan {
  const toUser = new Map<string, unknown>();
  const toLive = new Map<string, unknown>();
  const agreed = new Map<string, unknown>();
  const keys = new Set([...user.keys(), ...live.keys(), ...base.keys()]);
  for (const key of keys) {
    const u = readLeaf(user, key);
    const l = readLeaf(live, key);
    const b = readLeaf(base, key);
    let value: unknown;
    if (same(u, l)) value = u;
    else if (same(u, b)) value = l;
    else if (same(l, b)) value = u;
    else if (JSON.parse(key).at(-1) === "hasTrustDialogAccepted") value = u === true || l === true ? true : u;
    else value = u;
    if (!same(u, value)) toUser.set(key, value);
    if (!same(l, value)) toLive.set(key, value);
    if (value !== undefined) agreed.set(key, value);
  }
  return { toUser, toLive, agreed };
}

export interface ConfigSyncInput {
  /** The user's own Claude home, read for `.claude.json` only. */
  userHome: ClaudeLiveHome;
  liveHome: ClaudeLiveHome;
  /** Codara's record of what both sides last agreed on. */
  baseFile: string;
  log?: (message: string) => void;
  /** Test seam: runs after the plan and before the writes. */
  beforeWrite?: () => Promise<void>;
}

export interface ConfigSyncReport {
  toUser: number;
  toLive: number;
  /** Entries that changed under the merge and wait for the next pass. */
  deferred: number;
  userWritable: boolean;
}

async function readConfig(file: string): Promise<Record<string, unknown> | null> {
  const stats = await fs.lstat(file).catch(() => null);
  if (!stats) return null;
  if (!stats.isFile()) throw new Error("not a regular file");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("not an object");
  return parsed;
}

async function readBase(file: string): Promise<Leaves> {
  const read = await readPrivateJsonFile(file);
  if (read.kind !== "value" || !isRecord(read.value) || read.value.version !== BASE_VERSION) return new Map();
  const leaves = isRecord(read.value.leaves) ? read.value.leaves : {};
  return new Map(Object.entries(leaves));
}

async function writeBase(file: string, leaves: Leaves): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicWritePrivateFile(
    file,
    `${JSON.stringify({ version: BASE_VERSION, leaves: Object.fromEntries(leaves) })}\n`,
  );
}

/**
 * Apply `changes` to one side under its lock. An entry is written only if
 * the file still holds what the merge read; the keys actually written are
 * returned.
 */
async function applySide(
  home: ClaudeLiveHome,
  seen: Leaves,
  changes: Map<string, unknown>,
  capability?: Parameters<typeof updateClaudeGlobalConfig>[2],
): Promise<Set<string>> {
  const applied = new Set<string>();
  if (changes.size === 0) return applied;
  await updateClaudeGlobalConfig(
    home,
    (config) => {
      const now = syncedLeaves(config);
      for (const [key, value] of changes) {
        if (!same(readLeaf(now, key), readLeaf(seen, key))) continue;
        applyLeaf(config, key, value);
        applied.add(key);
      }
      return applied.size > 0 ? config : null;
    },
    capability,
  );
  return applied;
}

/** One pass of the sync. Throws only when Codara's own record cannot be written. */
export async function syncClaudeFollowConfig(input: ConfigSyncInput): Promise<ConfigSyncReport> {
  const userFile = await claudeGlobalConfigFile(input.userHome);
  const liveFile = await claudeGlobalConfigFile(input.liveHome);
  let user: Record<string, unknown> | null;
  let userWritable = true;
  try {
    user = await readConfig(userFile);
  } catch {
    // A link or a file that does not parse is left exactly as it is; the
    // live slot still gets what the user's side last agreed on.
    user = null;
    userWritable = false;
  }
  if ((await fs.lstat(userFile).catch(() => null))?.isSymbolicLink()) userWritable = false;
  let live: Record<string, unknown> | null;
  try {
    live = await readConfig(liveFile);
  } catch {
    return { toUser: 0, toLive: 0, deferred: 0, userWritable };
  }
  if (!live) return { toUser: 0, toLive: 0, deferred: 0, userWritable };
  const pretrusted = await readClaudePretrustedFolders(input.liveHome);
  const withoutPretrusted = (leaves: Leaves): Leaves => {
    for (const folder of pretrusted) leaves.delete(leafKey("projects", folder, "hasTrustDialogAccepted"));
    return leaves;
  };
  const base = withoutPretrusted(await readBase(input.baseFile));
  const userLeaves = userWritable ? withoutPretrusted(syncedLeaves(user)) : base;
  const liveLeaves = withoutPretrusted(syncedLeaves(live));
  const plan = planConfigMerge(userLeaves, liveLeaves, base);
  if (!userWritable) plan.toUser.clear();
  await input.beforeWrite?.();

  const appliedLive = await applySide(input.liveHome, liveLeaves, plan.toLive).catch((error: unknown) => {
    input.log?.(`[claude-follow] the live slot's settings were not synced: ${String(error)}`);
    return new Set<string>();
  });
  // A missing ~/.claude.json is created only when there is something to keep.
  const appliedUser = userWritable
    ? await applySide(input.userHome, userLeaves, plan.toUser, USER_CONFIG_SYNC).catch((error: unknown) => {
        input.log?.(`[claude-follow] your .claude.json was not synced: ${String(error)}`);
        return new Set<string>();
      })
    : new Set<string>();

  // The record moves only for entries that now agree on both sides.
  const next = new Map(base);
  let deferred = 0;
  const keys = new Set([...plan.toUser.keys(), ...plan.toLive.keys(), ...plan.agreed.keys(), ...base.keys()]);
  for (const key of keys) {
    const userDone = !plan.toUser.has(key) || appliedUser.has(key);
    const liveDone = !plan.toLive.has(key) || appliedLive.has(key);
    if (!userDone || !liveDone) {
      deferred += 1;
      continue;
    }
    const value = plan.agreed.get(key);
    if (value === undefined) next.delete(key);
    else next.set(key, value);
  }
  if (!same(Object.fromEntries(next), Object.fromEntries(base))) await writeBase(input.baseFile, next);
  return { toUser: appliedUser.size, toLive: appliedLive.size, deferred, userWritable };
}

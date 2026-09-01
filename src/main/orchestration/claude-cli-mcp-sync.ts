import { promises as fs } from "node:fs";
import { join } from "node:path";
import { CLAUDE_CLI_CONFIG_FILE } from "./claude-cli-account-profiles";
import { atomicWritePrivateFile } from "./native-cli-atomic-file";

/**
 * MCP servers are a property of the USER's toolbox, not of an Anthropic
 * account: the same person wants the same servers whichever login is active.
 * Claude Code keeps them in `.claude.json`, which sits beside `~/.claude`
 * rather than inside it, so the shared-state links (native-cli-shared-state)
 * never covered them. That file also carries `oauthAccount`, the identity
 * the account pairing is built on, so it deliberately stays per account. The
 * result was that every managed account started with an empty MCP list while
 * the personal login had a full one.
 *
 * This module shares ONLY the `mcpServers` object across those files and
 * leaves every other key, identity included, untouched.
 *
 * The merge is three-way against a baseline of the last synced state
 * (mcp-servers.json under the Claude accounts root). Without a baseline a
 * union would resurrect a server the user had just deleted: it would still be
 * present in the other files and flow back. With one, an entry missing from a
 * file it used to be in reads as a deletion. When an entry changed on more
 * than one side the most recently written file wins, and an edit outranks a
 * deletion so a rename or a token refresh is never lost to a stale copy.
 */

/** A server definition. Opaque: Claude Code owns the shape, we only move it. */
export type McpServerConfig = unknown;
export type McpServerMap = Record<string, McpServerConfig>;

export interface McpSyncFile {
  /** The `.claude.json` this participant reads. */
  path: string;
  /**
   * Whether the file may be created when it does not exist. The personal file
   * is Claude Code's own and is only ever updated in place; a managed account
   * that has never been launched has no file yet and gets a minimal one so its
   * first session already sees the servers.
   */
  create: boolean;
}

export interface McpSyncResult {
  /** Server names in the merged set. */
  names: string[];
  /** Files whose mcpServers block was rewritten. */
  written: string[];
  /** True when the merged set differs from the baseline. */
  changed: boolean;
}

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
export const CLAUDE_CLI_MCP_BASELINE_FILE = "mcp-servers.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable stringify so key order cannot make an unchanged entry look edited. */
function fingerprint(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
      return out;
    }
    return node;
  };
  return JSON.stringify(walk(value) ?? null);
}

interface ReadFile {
  path: string;
  create: boolean;
  exists: boolean;
  /** Parsed document, or null when the file is absent or unreadable. */
  doc: Record<string, unknown> | null;
  servers: McpServerMap;
  mtimeMs: number;
}

async function readParticipant(file: McpSyncFile): Promise<ReadFile> {
  const base = { path: file.path, create: file.create, servers: {}, mtimeMs: 0 };
  // "Absent" and "unreadable" must never be confused. An absent managed file
  // is created; an unreadable one is left exactly as it is, because rewriting
  // it would replace a config whose OTHER keys (the account identity, the
  // project history) we could not read and therefore cannot preserve.
  let stat;
  try {
    stat = await fs.stat(file.path);
  } catch {
    return { ...base, exists: false, doc: null };
  }
  const unreadable: ReadFile = { ...base, exists: true, doc: null };
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return unreadable;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file.path, "utf8"));
    if (!isRecord(parsed)) return unreadable;
    const servers = isRecord(parsed.mcpServers) ? (parsed.mcpServers as McpServerMap) : {};
    return {
      path: file.path,
      create: file.create,
      exists: true,
      doc: parsed,
      servers,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return unreadable;
  }
}

async function readBaseline(path: string): Promise<McpServerMap> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    if (!isRecord(parsed)) return {};
    const servers = parsed.mcpServers;
    return isRecord(servers) ? (servers as McpServerMap) : {};
  } catch {
    return {};
  }
}

/**
 * Three-way merge across every participant that could be read. Files that do
 * not exist yet are not evidence of a deletion, so only files that exist (or
 * that the baseline says once held the entry) can vote one away.
 */
export function mergeMcpServers(
  baseline: McpServerMap,
  participants: readonly {
    servers: McpServerMap;
    mtimeMs: number;
    exists: boolean;
    readable?: boolean;
  }[],
): McpServerMap {
  // Only files we could actually READ get a vote. An unreadable one is not
  // evidence that a server was deleted.
  const present = participants.filter(
    (participant) => participant.exists && participant.readable !== false,
  );
  const names = new Set<string>([
    ...Object.keys(baseline),
    ...present.flatMap((participant) => Object.keys(participant.servers)),
  ]);
  const merged: McpServerMap = {};
  for (const name of names) {
    const holders = present.filter((participant) =>
      Object.prototype.hasOwnProperty.call(participant.servers, name),
    );
    const known = Object.prototype.hasOwnProperty.call(baseline, name);
    if (!known) {
      // Added somewhere since the last sync: newest writer defines it.
      const winner = holders.reduce<(typeof holders)[number] | null>(
        (best, participant) => (best === null || participant.mtimeMs > best.mtimeMs ? participant : best),
        null,
      );
      if (winner) merged[name] = winner.servers[name];
      continue;
    }
    const baseFingerprint = fingerprint(baseline[name]);
    const edited = holders.filter(
      (participant) => fingerprint(participant.servers[name]) !== baseFingerprint,
    );
    if (edited.length > 0) {
      // An edit outranks a deletion: the user changed it somewhere.
      const winner = edited.reduce((best, participant) =>
        participant.mtimeMs > best.mtimeMs ? participant : best,
      );
      merged[name] = winner.servers[name];
      continue;
    }
    // Unchanged wherever it still is. A file that dropped it deleted it.
    if (holders.length === present.length) merged[name] = baseline[name];
  }
  return merged;
}

export interface SyncClaudeCliMcpServersInput {
  files: readonly McpSyncFile[];
  /** Where the last-synced set is remembered (the Claude accounts root). */
  baselinePath: string;
  log?: (message: string) => void;
}

/**
 * Share the MCP server list across the personal and managed `.claude.json`
 * files. Best-effort by design: a file that cannot be read is skipped rather
 * than failing a launch, and nothing outside `mcpServers` is ever touched.
 */
export async function syncClaudeCliMcpServers(
  input: SyncClaudeCliMcpServersInput,
): Promise<McpSyncResult> {
  const participants = await Promise.all(input.files.map(readParticipant));
  const baseline = await readBaseline(input.baselinePath);
  const merged = mergeMcpServers(
    baseline,
    participants.map((participant) => ({ ...participant, readable: participant.doc !== null })),
  );
  const mergedFingerprint = fingerprint(merged);
  const written: string[] = [];
  for (const participant of participants) {
    if (!participant.exists && !participant.create) continue;
    if (participant.exists && participant.doc === null) continue;
    if (fingerprint(participant.servers) === mergedFingerprint) continue;
    const doc = participant.doc ?? {};
    const next =
      Object.keys(merged).length > 0
        ? { ...doc, mcpServers: merged }
        : (() => {
            const copy = { ...doc };
            delete copy.mcpServers;
            return copy;
          })();
    try {
      await atomicWritePrivateFile(participant.path, `${JSON.stringify(next, null, 2)}\n`, {
        maxBytes: MAX_CONFIG_BYTES,
      });
      written.push(participant.path);
    } catch (error) {
      input.log?.(
        `[accounts] could not share the MCP server list into ${participant.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const changed = mergedFingerprint !== fingerprint(baseline);
  if (changed || written.length > 0) {
    try {
      await atomicWritePrivateFile(
        input.baselinePath,
        `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`,
        { maxBytes: MAX_CONFIG_BYTES },
      );
    } catch (error) {
      // A baseline that cannot be written only costs precision on the NEXT
      // merge (a deletion could be resurrected once); the files are correct.
      input.log?.(
        `[accounts] could not record the shared MCP baseline: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { names: Object.keys(merged).sort(), written, changed };
}

/** The `.claude.json` a managed account directory reads. */
export function managedClaudeConfigFile(configDir: string): string {
  return join(configDir, CLAUDE_CLI_CONFIG_FILE);
}

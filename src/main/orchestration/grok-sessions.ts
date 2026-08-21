// Grok Build on-disk session helpers.
//
// Grok stores each session under
//   $GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/
// with `updates.jsonl` as the conversation log and `summary.json` as the
// index. Encoding is encodeURIComponent of the absolute cwd. When that name
// exceeds 255 bytes, Grok uses a slug+hash directory and records the original
// path in a `.cwd` file inside the group.

import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isCodaraManagedCliPath } from "./codara-managed-cli-roots";
import { defaultPersonalGrokHomeDir } from "./grok-cli-account-profiles";
import {
  GROK_CLI_SHARED_STATE_DIR_SET,
  GROK_CLI_SHARED_STATE_FILE_SET,
} from "./native-cli-shared-state";

const GROK_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCODED_CWD_MAX_BYTES = 255;

export function grokHomeDir(homeDir?: string | null): string {
  return homeDir && homeDir.trim() ? resolve(homeDir) : defaultPersonalGrokHomeDir();
}

export function grokSessionsRoot(homeDir?: string | null): string {
  return join(grokHomeDir(homeDir), "sessions");
}

export function encodeGrokCwd(cwd: string): string {
  return encodeURIComponent(resolve(cwd));
}

export function grokSessionGroupDirForCwd(
  cwd: string,
  homeDir?: string | null,
): string {
  return join(grokSessionsRoot(homeDir), encodeGrokCwd(cwd));
}

export function grokSessionDir(
  cwd: string,
  sessionId: string,
  homeDir?: string | null,
): string {
  return join(grokSessionGroupDirForCwd(cwd, homeDir), sessionId);
}

export function grokSessionTranscriptPath(
  cwd: string,
  sessionId: string,
  homeDir?: string | null,
): string {
  return join(grokSessionDir(cwd, sessionId, homeDir), "updates.jsonl");
}

export function grokSessionSummaryPath(
  cwd: string,
  sessionId: string,
  homeDir?: string | null,
): string {
  return join(grokSessionDir(cwd, sessionId, homeDir), "summary.json");
}

export function isGrokSessionId(value: string): boolean {
  return GROK_SESSION_ID_PATTERN.test(value);
}

function isCodaraSharedGrokStateLink(root: string, path: string): boolean {
  if (dirname(path) !== root) return false;
  const name = basename(path);
  if (
    !GROK_CLI_SHARED_STATE_DIR_SET.has(name) &&
    !GROK_CLI_SHARED_STATE_FILE_SET.has(name)
  ) {
    return false;
  }
  return isCodaraManagedCliPath(root);
}

export async function assertSafeGrokStoragePath(
  homeDir: string,
  targetPath: string,
  options: {
    includeLeaf?: boolean;
    requireLeaf?: boolean;
    leafType?: "file" | "directory";
  } = {},
): Promise<string> {
  const root = resolve(homeDir);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    rel.startsWith("/") ||
    rel.startsWith("\\")
  ) {
    throw new Error("Grok storage path escapes the selected account.");
  }
  const checkedTarget =
    target === root || options.includeLeaf ? target : dirname(target);
  const checkedRel = relative(root, checkedTarget);
  const pieces = checkedRel ? checkedRel.split(/[\\/]+/).filter(Boolean) : [];
  let cursor = root;
  let sawLeaf = false;
  for (let index = -1; index < pieces.length; index += 1) {
    if (index >= 0) cursor = join(cursor, pieces[index]);
    const isLeaf = options.includeLeaf && cursor === target;
    const stat = await fs.lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    if (!stat) {
      if (isLeaf && options.requireLeaf) {
        throw new Error("Grok session path does not exist.");
      }
      break;
    }
    let effective = stat;
    if (stat.isSymbolicLink()) {
      if (!isCodaraSharedGrokStateLink(root, cursor)) {
        throw new Error("Grok storage path contains a symbolic-link ancestor.");
      }
      const real = await fs
        .stat(cursor)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        });
      if (!real) {
        if (isLeaf && options.requireLeaf) {
          throw new Error("Grok session path does not exist.");
        }
        break;
      }
      effective = real;
    }
    if (!isLeaf && !effective.isDirectory()) {
      throw new Error("Grok storage ancestor is not a directory.");
    }
    if (isLeaf && options.leafType === "file" && !effective.isFile()) {
      throw new Error("Grok session file is not a regular file.");
    }
    if (isLeaf && options.leafType === "directory" && !effective.isDirectory()) {
      throw new Error("Grok session path is not a directory.");
    }
    if (isLeaf) sawLeaf = true;
  }
  if (options.requireLeaf && !sawLeaf) {
    throw new Error("Grok session path does not exist.");
  }
  return target;
}

export async function resolveSafeGrokTranscriptPath(
  cwd: string,
  sessionId: string,
  homeDir?: string | null,
  options: { requireExisting?: boolean } = {},
): Promise<string> {
  const root = grokHomeDir(homeDir);
  const path = grokSessionTranscriptPath(cwd, sessionId, homeDir);
  return assertSafeGrokStoragePath(root, path, {
    includeLeaf: true,
    requireLeaf: options.requireExisting,
    leafType: "file",
  });
}

async function readGroupCwdMarker(dir: string): Promise<string | null> {
  const marker = join(dir, ".cwd");
  const text = await fs.readFile(marker, "utf8").catch(() => null);
  const cwd = text?.trim();
  return cwd && isAbsolute(cwd) ? resolve(cwd) : null;
}

export async function resolveGrokSessionGroupDir(
  cwd: string,
  homeDir?: string | null,
): Promise<string> {
  const root = grokHomeDir(homeDir);
  const sessionsRoot = grokSessionsRoot(homeDir);
  await assertSafeGrokStoragePath(root, sessionsRoot, {
    includeLeaf: true,
    leafType: "directory",
  });
  const encoded = encodeGrokCwd(cwd);
  const direct = join(sessionsRoot, encoded);
  if (Buffer.byteLength(encoded, "utf8") <= ENCODED_CWD_MAX_BYTES) {
    return direct;
  }
  const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const target = resolve(cwd);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(sessionsRoot, entry.name);
    const marked = await readGroupCwdMarker(dir);
    if (marked && marked === target) return dir;
  }
  return direct;
}

export interface GrokSessionDiscovery {
  sessionId: string;
  transcriptPath: string;
}

/**
 * Newest Grok session for `cwd` created at or after `since`. Used to capture
 * the id of a hand-typed `grok` that just launched in a pane.
 */
export async function discoverGrokSessionForCwd(
  cwd: string,
  since: number,
  excludeSessionIds?: ReadonlySet<string>,
  homeDir?: string | null,
): Promise<GrokSessionDiscovery | null> {
  const root = grokHomeDir(homeDir);
  const group = await resolveGrokSessionGroupDir(cwd, homeDir);
  await assertSafeGrokStoragePath(root, group, {
    includeLeaf: true,
    leafType: "directory",
  });
  let entries: string[];
  try {
    entries = await fs.readdir(group);
  } catch {
    return null;
  }
  let best: GrokSessionDiscovery | null = null;
  let bestCreated = -1;
  for (const name of entries) {
    if (!isGrokSessionId(name)) continue;
    if (excludeSessionIds?.has(name.toLowerCase())) continue;
    const dir = join(group, name);
    const transcript = join(dir, "updates.jsonl");
    try {
      await assertSafeGrokStoragePath(root, dir, {
        includeLeaf: true,
        requireLeaf: true,
        leafType: "directory",
      });
      const stat = await fs.lstat(dir);
      const created =
        stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      if (created + 5 < since) continue;
      if (created > bestCreated) {
        bestCreated = created;
        best = { sessionId: name, transcriptPath: transcript };
      }
    } catch {
      // vanished between readdir and stat
    }
  }
  return best;
}

export interface GrokSessionSummaryRecord {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAtMs: number;
  transcriptPath: string;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function readGrokSessionSummary(
  sessionDir: string,
  homeDir?: string | null,
): Promise<GrokSessionSummaryRecord | null> {
  const root = grokHomeDir(homeDir);
  const summaryPath = join(sessionDir, "summary.json");
  try {
    await assertSafeGrokStoragePath(root, summaryPath, {
      includeLeaf: true,
      requireLeaf: true,
      leafType: "file",
    });
  } catch {
    return null;
  }
  const raw = await fs.readFile(summaryPath, "utf8").catch(() => null);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const info =
    record.info && typeof record.info === "object" && !Array.isArray(record.info)
      ? (record.info as Record<string, unknown>)
      : {};
  const sessionId =
    textField(info.id) ??
    textField(record.session_id) ??
    basename(sessionDir);
  if (!isGrokSessionId(sessionId)) return null;
  const cwd = textField(info.cwd) ?? textField(record.cwd);
  if (!cwd || !isAbsolute(cwd)) return null;
  const title =
    textField(record.generated_title) ??
    textField(record.session_summary) ??
    "Untitled session";
  const updated =
    textField(record.updated_at) ??
    textField(record.last_active_at) ??
    textField(record.created_at);
  const updatedAtMs = updated ? Date.parse(updated) : 0;
  return {
    sessionId,
    cwd: resolve(cwd),
    title,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    transcriptPath: join(sessionDir, "updates.jsonl"),
  };
}

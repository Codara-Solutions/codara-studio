// Antigravity's own list of its conversations. agy keeps one summary row per
// conversation in conversation_summaries.db; the session index reads that one
// table, read only, and closes the file at once. Nothing else of agy's is
// read: not raw_summary, not its full-text table, not the per-conversation
// databases, and never its sign-in or settings. agy itself is never run.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isSafeSessionId } from "../../shared/session-search";

export const ANTIGRAVITY_SUMMARY_DB = "conversation_summaries.db";

/** The pointer word an Antigravity pane keeps when it has no conversation id; never a conversation of its own. */
const CONTINUE_WORD = "continue";
const COLUMNS = [
  "conversation_id",
  "title",
  "preview",
  "step_count",
  "last_modified_time",
  "workspace_uris",
  "parent_conversation_id",
  "nesting_depth",
] as const;
const MAX_CONVERSATIONS = 2_000;
const TEXT_CHARS = 2_000;

export interface AntigravityConversation {
  id: string;
  title: string;
  preview: string;
  steps: number;
  lastAt: number | null;
  /** The first local folder of the conversation's workspace. */
  cwd: string | null;
}

interface SummaryStatement {
  all(...params: (string | number)[]): Record<string, unknown>[];
}

export interface SummaryDatabase {
  prepare(sql: string): SummaryStatement;
  close(): void;
}

export function antigravityCliDir(home: string = homedir()): string {
  return join(home, ".gemini", "antigravity-cli");
}

type SqliteOpen = new (path: string, options?: { readOnly?: boolean }) => SummaryDatabase;

function sqliteDatabase(): SqliteOpen {
  const builtin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const sqlite = (builtin?.("node:sqlite") ?? createRequire(__filename)("node:sqlite")) as { DatabaseSync: SqliteOpen };
  return sqlite.DatabaseSync;
}

/**
 * Opens agy's database without writing beside it. A read-only open of a WAL
 * database still creates its -wal and -shm files, so unless both are there
 * already (agy has it open) the file is read as immutable: that covers agy
 * closed, and a crashed agy that left only a -wal. While agy runs, its WAL
 * holds the newest rows and a read-only open shares it, as any reader does.
 * A read that fails while agy changes the file throws, and the caller keeps
 * what it read last.
 */
export function openSummaryDatabase(dbPath: string): SummaryDatabase {
  const DatabaseSync = sqliteDatabase();
  if (existsSync(`${dbPath}-wal`) && existsSync(`${dbPath}-shm`)) return new DatabaseSync(dbPath, { readOnly: true });
  return new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1`, { readOnly: true });
}

/**
 * Go's sqlite drivers write times as "2006-01-02 15:04:05.999999999-07:00";
 * an epoch number in seconds or milliseconds is taken too. Null when neither.
 * A time written without a zone is read as UTC, which is what Go's drivers
 * write when they leave the zone out.
 */
export function parseSummaryTime(value: unknown): number | null {
  if (typeof value === "number" || typeof value === "bigint") {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?/i.exec(value.trim());
  if (!match) return null;
  const fraction = (match[3] ?? "").slice(0, 3).padEnd(3, "0");
  const zone = !match[4] || match[4].toUpperCase() === "Z" ? "Z" : match[4].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const at = Date.parse(`${match[1]}T${match[2]}.${fraction}${zone}`);
  return Number.isFinite(at) ? at : null;
}

/** The first local folder in workspace_uris: a JSON list or a comma-separated one, of file URIs or paths. */
export function summaryWorkspaceFolder(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let entries: unknown[];
  try {
    const parsed: unknown = JSON.parse(value);
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = value.split(/[,\n]/);
  }
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (/^file:/i.test(text)) {
      try {
        return fileURLToPath(text);
      } catch {
        continue;
      }
    }
    if (text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text)) return text;
  }
  return null;
}

function clip(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, TEXT_CHARS) : "";
}

/**
 * The top-level conversations in the summary database, newest first. Throws
 * when the file cannot be opened or the table has another shape, so the
 * index keeps what it last read instead of emptying.
 */
export function readAntigravitySummaries(
  dbPath: string,
  openReadOnly: (path: string) => SummaryDatabase = openSummaryDatabase,
): AntigravityConversation[] {
  const db = openReadOnly(dbPath);
  try {
    const present = new Set(db.prepare("PRAGMA table_info(conversation_summaries)").all().map((row) => row.name));
    const missing = COLUMNS.filter((column) => !present.has(column));
    if (missing.length > 0) throw new Error(`conversation_summaries lacks ${missing.join(", ")}`);
    const rows = db
      .prepare(
        `SELECT ${COLUMNS.join(", ")} FROM conversation_summaries
         WHERE nesting_depth = 0 AND (parent_conversation_id IS NULL OR parent_conversation_id = '')
         ORDER BY last_modified_time DESC LIMIT ?`,
      )
      .all(MAX_CONVERSATIONS);
    const conversations: AntigravityConversation[] = [];
    for (const row of rows) {
      const id = row.conversation_id;
      // The id is typed into a shell as `agy --conversation <id>`.
      if (!isSafeSessionId(id) || id === CONTINUE_WORD) continue;
      conversations.push({
        id,
        title: clip(row.title),
        preview: clip(row.preview),
        steps: Math.max(0, Math.floor(Number(row.step_count) || 0)),
        lastAt: parseSummaryTime(row.last_modified_time),
        cwd: summaryWorkspaceFolder(row.workspace_uris),
      });
    }
    return conversations;
  } finally {
    db.close();
  }
}

/** agy's conversations now, or null when its database cannot be read. */
export function currentAntigravityConversations(): AntigravityConversation[] | null {
  try {
    return readAntigravitySummaries(join(antigravityCliDir(), ANTIGRAVITY_SUMMARY_DB));
  } catch {
    return null;
  }
}

/** Folders compare as the file system does: without case on Windows. */
export function sameFolder(a: string | null, b: string | null, platform: NodeJS.Platform = process.platform): boolean {
  if (a === null || b === null) return false;
  const fold = (path: string) => (platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  return fold(a) === fold(b);
}

/**
 * Whether `agy --continue` could reopen a conversation another pane already
 * names. agy does not say whether "latest" is per folder, so both the latest
 * overall and the latest of the pane's folder count.
 */
export function continueReopensNamed(
  conversations: readonly AntigravityConversation[],
  cwd: string | null,
  named: readonly string[],
): boolean {
  const newest = (items: readonly AntigravityConversation[]) =>
    items.reduce<AntigravityConversation | null>((best, item) => ((item.lastAt ?? 0) > (best?.lastAt ?? -1) ? item : best), null);
  const latest = [newest(conversations), cwd ? newest(conversations.filter((item) => sameFolder(item.cwd, cwd))) : null];
  return latest.some((item) => item !== null && named.includes(item.id));
}

/**
 * The top-level conversations agy marks as not fully idle: a running agy is
 * working in them now. Only `not_fully_idle` is read for this; agy's
 * `status` text has no documented values. Empty when the column is missing.
 */
export function readLiveAntigravityConversations(
  dbPath: string,
  openReadOnly: (path: string) => SummaryDatabase = openSummaryDatabase,
): string[] {
  const db = openReadOnly(dbPath);
  try {
    const present = new Set(db.prepare("PRAGMA table_info(conversation_summaries)").all().map((row) => row.name));
    if (!present.has("not_fully_idle") || !present.has("nesting_depth")) return [];
    return db
      .prepare(
        `SELECT conversation_id FROM conversation_summaries
         WHERE nesting_depth = 0 AND not_fully_idle IN (1, 'true', 'TRUE') LIMIT ?`,
      )
      .all(MAX_CONVERSATIONS)
      .map((row) => row.conversation_id)
      .filter((id): id is string => isSafeSessionId(id) && id !== CONTINUE_WORD);
  } finally {
    db.close();
  }
}

export interface AntigravityConversationActivity {
  /** The id is a top-level conversation in agy's list. */
  known: boolean;
  /** It, or a subagent conversation under it, is marked not fully idle by agy. */
  busy: "conversation" | "subagent" | null;
}

/**
 * What agy itself says about one conversation and every subagent
 * conversation under it (parent_conversation_id, followed down). Null when
 * the table lacks a column this needs: then nothing can be shown. Throws
 * when the file cannot be read, like the readers above.
 */
export function readAntigravityConversationActivity(
  dbPath: string,
  conversationId: string,
  openReadOnly: (path: string) => SummaryDatabase = openSummaryDatabase,
): AntigravityConversationActivity | null {
  const db = openReadOnly(dbPath);
  try {
    const present = new Set(db.prepare("PRAGMA table_info(conversation_summaries)").all().map((row) => row.name));
    if (!["conversation_id", "parent_conversation_id", "nesting_depth", "not_fully_idle"].every((column) => present.has(column))) {
      return null;
    }
    // UNION, not UNION ALL: a parent loop in the table ends the walk.
    const rows = db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT conversation_id FROM conversation_summaries WHERE conversation_id = ?
           UNION SELECT c.conversation_id FROM conversation_summaries c JOIN tree t ON c.parent_conversation_id = t.id
         )
         SELECT s.conversation_id, s.nesting_depth, s.parent_conversation_id, s.not_fully_idle
         FROM conversation_summaries s JOIN tree ON s.conversation_id = tree.id LIMIT ?`,
      )
      .all(conversationId, MAX_CONVERSATIONS);
    const busyFlag = (value: unknown) => value === 1 || value === 1n || value === "true" || value === "TRUE";
    let known = false;
    let busy: AntigravityConversationActivity["busy"] = null;
    for (const row of rows) {
      if (row.conversation_id === conversationId) {
        known ||= Number(row.nesting_depth) === 0 && (row.parent_conversation_id === null || row.parent_conversation_id === "");
        if (busyFlag(row.not_fully_idle)) busy = "conversation";
      } else if (busyFlag(row.not_fully_idle)) {
        busy ??= "subagent";
      }
    }
    // A walk cut at the limit may have left a busy subagent unread.
    if (rows.length >= MAX_CONVERSATIONS) return null;
    return { known, busy };
  } finally {
    db.close();
  }
}

/** The conversations a running agy works in now; empty when the database cannot be read. */
export function currentLiveAntigravityConversations(): string[] {
  try {
    return readLiveAntigravityConversations(join(antigravityCliDir(), ANTIGRAVITY_SUMMARY_DB));
  } catch {
    return [];
  }
}

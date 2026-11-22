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
 * database still creates its -wal and -shm files, so while agy has none open
 * the file is read as immutable. While agy runs, its WAL holds the newest
 * rows and a read-only open shares it, as any reader does.
 */
export function openSummaryDatabase(dbPath: string): SummaryDatabase {
  const DatabaseSync = sqliteDatabase();
  if (existsSync(`${dbPath}-wal`)) return new DatabaseSync(dbPath, { readOnly: true });
  return new DatabaseSync(`${pathToFileURL(dbPath).href}?immutable=1`, { readOnly: true });
}

/**
 * Go's sqlite drivers write times as "2006-01-02 15:04:05.999999999-07:00";
 * an epoch number in seconds or milliseconds is taken too. Null when neither.
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

function sameFolder(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && resolve(a) === resolve(b);
}

/**
 * The conversation a pane started as a new agy session is in: the only
 * conversation of its folder changed since it started that no other pane
 * names. Null while there is none, or more than one, to choose from.
 */
export function paneConversation(
  conversations: readonly AntigravityConversation[],
  pane: { cwd: string; since: number; named: readonly string[] },
): string | null {
  const candidates = conversations.filter(
    (item) =>
      sameFolder(item.cwd, pane.cwd) && item.lastAt !== null && item.lastAt >= pane.since && !pane.named.includes(item.id),
  );
  return candidates.length === 1 ? candidates[0].id : null;
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

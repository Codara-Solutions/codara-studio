// The agent session index: a SQLite FTS5 database under Codara's own home,
// built from the agent CLIs' transcripts, which it only ever reads.
//
// It runs on the session index thread (session-index-worker.ts), never on
// the main thread, and is written to be gentle:
// - transcripts are streamed in fixed chunks (jsonl-reader.ts) and only the
//   prose of each message is kept, so memory never holds a transcript;
// - every file remembers its size, mtime, inode and the byte offset of the
//   last complete line, so a pass reads only what was appended since;
// - work is cut into short slices with a pause between them (IndexPacer),
//   and no transaction stays open across a pause, so searches answer while
//   a pass runs.
//
// The index is a cache: a schema change or a damaged file rebuilds it from
// the transcripts.

import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import {
  buildFtsMatch,
  sessionCwdKey,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
  type SessionSearchAgent,
  type SessionSearchHit,
  type SessionTranscript,
  type SessionTranscriptMessage,
} from "@shared/session-search";
import { ROLLOUT_FILENAME_UUID_RE } from "../orchestration/codex-sessions";
import { endsWithNewlineAt, readJsonlLines } from "./jsonl-reader";
import {
  LINE_PARSERS,
  applyGrokSummary,
  coraRunCwd,
  initialTranscriptState,
  parseCoraRun,
  restoreTranscriptState,
  sessionTitle,
  type IndexedMessage,
  type TranscriptState,
} from "./transcript-parsers";

const SCHEMA_VERSION = 1;

/** One FTS row holds at most this much of a message; longer ones are split. */
const CHUNK_CHARS = 8_000;
/** A pass commits and pauses after this many transcript bytes or messages. */
const SLICE_BYTES = 2 * 1024 * 1024;
const SLICE_MESSAGES = 400;
const RUN_JSON_MAX_BYTES = 16 * 1024 * 1024;
const SUMMARY_MAX_BYTES = 512 * 1024;
const CODEX_INDEX_MAX_BYTES = 8 * 1024 * 1024;
/** Candidate sessions ranked before recency reorders them. */
const CANDIDATE_SESSIONS = 300;
// Session ids end up in a resume command typed into a shell, so only these
// shapes are indexed: the ids the CLIs themselves mint.
const UUID_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PI_SESSION_FILE = /_([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.jsonl$/;
const CORA_RUN_ID = /^run-[A-Za-z0-9_-]{1,128}$/;

// ── node:sqlite, typed to what this file uses ─────────────────────────────

type SqlValue = string | number | bigint | null | Uint8Array;

interface SqlStatement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  all(...params: SqlValue[]): Record<string, unknown>[];
  iterate(...params: SqlValue[]): IterableIterator<Record<string, unknown>>;
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

type SqliteModule = { DatabaseSync: new (path: string) => SqlDatabase };

function loadSqlite(): SqliteModule {
  const builtin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const fromBuiltin = builtin?.("node:sqlite") as SqliteModule | undefined;
  if (fromBuiltin) return fromBuiltin;
  return createRequire(__filename)("node:sqlite") as SqliteModule;
}

// ── Sources ───────────────────────────────────────────────────────────────

/** A folder of one agent's transcripts, resolved by the main process. */
export interface SessionSourceRoot {
  agent: SessionSearchAgent;
  dir: string;
}

interface DiscoveredFile {
  agent: SessionSearchAgent;
  path: string;
  /** The session the file belongs to, from its name or folder. */
  sessionId: string;
  size: number;
  mtimeMs: number;
  ino: string;
  root: string;
}

/** Pauses between slices of work; throws to abandon the pass. */
export interface IndexPacer {
  checkpoint(): Promise<void>;
}

export interface SyncProgress {
  filesTotal: number;
  filesDone: number;
}

export interface SyncSummary {
  filesTotal: number;
  filesRead: number;
  bytesRead: number;
  skippedLines: number;
  removedFiles: number;
}

export interface IndexStats {
  sessions: number;
  messages: number;
  byAgent: Partial<Record<SessionSearchAgent, { sessions: number; messages: number }>>;
  bytes: number;
  lastSyncAt: number | null;
  built: boolean;
}

export interface IndexSearchInput {
  query: string;
  agents: readonly SessionSearchAgent[];
  /** Folder keys (sessionCwdKey) a session's folder must equal or sit under; null is every folder. */
  scopeKeys: readonly string[] | null;
  limit: number;
  offset: number;
  now: number;
  /** Words in an excerpt: few for the rail's two lines, more for an agent. */
  snippetTokens: number;
}

/** Where a session's transcript is, for Reveal transcript. */
export interface IndexSessionRecord {
  agent: SessionSearchAgent;
  sessionId: string;
  transcriptPath: string | null;
}

type Row = Record<string, unknown>;

function num(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_CHARS) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_CHARS) {
    // Split on whitespace so a word is never cut in two.
    let cut = rest.lastIndexOf(" ", CHUNK_CHARS);
    const newline = rest.lastIndexOf("\n", CHUNK_CHARS);
    if (newline > cut) cut = newline;
    if (cut < CHUNK_CHARS / 2) cut = CHUNK_CHARS;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function sessionKey(agent: SessionSearchAgent, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export function parseSessionKey(key: string): { agent: SessionSearchAgent; sessionId: string } | null {
  const colon = key.indexOf(":");
  if (colon <= 0) return null;
  const agent = key.slice(0, colon) as SessionSearchAgent;
  const sessionId = key.slice(colon + 1);
  if (!["claude", "codex", "grok", "pi", "cora"].includes(agent) || !sessionId) return null;
  return { agent, sessionId };
}

// ── The index ─────────────────────────────────────────────────────────────

export class SessionIndex {
  private readonly db: SqlDatabase;
  private inTransaction = false;
  private readonly statements = new Map<string, SqlStatement>();

  private constructor(
    readonly dbPath: string,
    private readonly platform: string,
    db: SqlDatabase,
  ) {
    this.db = db;
  }

  /** Opens (or creates) the index. A file from another schema is replaced. */
  static async open(dbPath: string, platform: string = process.platform): Promise<SessionIndex> {
    await fs.mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
    const { DatabaseSync } = loadSqlite();
    let db = new DatabaseSync(dbPath);
    if (!SessionIndex.schemaMatches(db)) {
      db.close();
      await SessionIndex.removeFiles(dbPath);
      db = new DatabaseSync(dbPath);
    }
    const index = new SessionIndex(dbPath, platform, db);
    index.configure();
    await index.restrictPermissions();
    return index;
  }

  /** The database file and its WAL companions. */
  static async removeFiles(dbPath: string): Promise<void> {
    await Promise.all(
      ["", "-wal", "-shm", "-journal"].map((suffix) => fs.rm(`${dbPath}${suffix}`, { force: true })),
    );
  }

  private static schemaMatches(db: SqlDatabase): boolean {
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
      if (!table) {
        // A brand new file is fine; anything else without our meta is not ours.
        const any = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get();
        return num(any?.n) === 0;
      }
      const row = db.prepare("SELECT value FROM meta WHERE key='schema'").get();
      return row?.value === String(SCHEMA_VERSION);
    } catch {
      return false;
    }
  }

  private configure(): void {
    // Small page cache, no memory map, a capped WAL and a soft heap ceiling:
    // the index thread's native memory stays a few MB whatever the volume.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -4096;
      PRAGMA mmap_size = 0;
      PRAGMA temp_store = FILE;
      PRAGMA journal_size_limit = 8388608;
      PRAGMA soft_heap_limit = 67108864;
      PRAGMA foreign_keys = OFF;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT,
        first_prompt TEXT,
        cwd TEXT,
        cwd_key TEXT,
        model TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        last_at INTEGER,
        transcript TEXT,
        workspace_id TEXT,
        UNIQUE (agent, session_id)
      );
      CREATE INDEX IF NOT EXISTS sessions_by_last ON sessions (last_at);
      CREATE INDEX IF NOT EXISTS sessions_by_cwd ON sessions (cwd_key);
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        agent TEXT NOT NULL,
        session_row INTEGER NOT NULL,
        size INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        ino TEXT NOT NULL,
        offset INTEGER NOT NULL,
        state TEXT,
        skipped INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS files_by_session ON files (session_row);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        session_row INTEGER NOT NULL,
        file_row INTEGER NOT NULL,
        role TEXT NOT NULL,
        part INTEGER NOT NULL,
        ts INTEGER
      );
      CREATE INDEX IF NOT EXISTS messages_by_session ON messages (session_row, part, ts);
      CREATE INDEX IF NOT EXISTS messages_by_file ON messages (file_row);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5 (
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  }

  private async restrictPermissions(): Promise<void> {
    if (this.platform === "win32") return;
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.chmod(`${this.dbPath}${suffix}`, 0o600).catch(() => undefined);
    }
  }

  close(): void {
    this.commit();
    this.db.close();
  }

  private stmt(sql: string): SqlStatement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private begin(): void {
    if (this.inTransaction) return;
    this.db.exec("BEGIN");
    this.inTransaction = true;
  }

  private commit(): void {
    if (!this.inTransaction) return;
    this.db.exec("COMMIT");
    this.inTransaction = false;
  }

  private rollback(): void {
    if (!this.inTransaction) return;
    try {
      this.db.exec("ROLLBACK");
    } finally {
      this.inTransaction = false;
    }
  }

  private meta(key: string): string | null {
    return strOrNull(this.stmt("SELECT value FROM meta WHERE key = ?").get(key)?.value);
  }

  private setMeta(key: string, value: string): void {
    this.stmt("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ── Discovery ───────────────────────────────────────────────────────────

  private async discover(
    root: SessionSourceRoot,
    pacer: IndexPacer,
    out: DiscoveredFile[],
  ): Promise<void> {
    const add = async (path: string, sessionId: string): Promise<void> => {
      const stat = await fs.lstat(path).catch(() => null);
      // Never follow a link: Codara's own account homes link back into the
      // personal folders, which are walked as roots of their own.
      if (!stat?.isFile()) return;
      out.push({
        agent: root.agent,
        path,
        sessionId,
        size: stat.size,
        mtimeMs: Math.floor(stat.mtimeMs),
        ino: `${stat.dev}:${stat.ino}`,
        root: root.dir,
      });
      if (out.length % 200 === 0) await pacer.checkpoint();
    };
    const dirs = async (dir: string) =>
      (await fs.readdir(dir, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    const files = async (dir: string) =>
      (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isFile());

    switch (root.agent) {
      case "claude":
        // <projects>/<folder>/<session>.jsonl; subagent transcripts sit one
        // level deeper and are not sessions of their own.
        for (const folder of await dirs(root.dir)) {
          for (const entry of await files(join(root.dir, folder.name))) {
            if (!entry.name.endsWith(".jsonl")) continue;
            const sessionId = entry.name.slice(0, -".jsonl".length);
            if (UUID_SESSION_ID.test(sessionId)) await add(join(root.dir, folder.name, entry.name), sessionId);
          }
        }
        return;
      case "codex": {
        // sessions/YYYY/MM/DD/rollout-*.jsonl, or the flat archived_sessions.
        const pending = [root.dir];
        // Throws for a missing root, which keeps what the index holds for it.
        await fs.readdir(root.dir);
        while (pending.length > 0) {
          const dir = pending.pop() as string;
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) pending.push(path);
            else if (entry.isFile()) {
              const match = ROLLOUT_FILENAME_UUID_RE.exec(entry.name);
              if (match) await add(path, match[1].toLowerCase());
            }
          }
        }
        return;
      }
      case "grok":
        // sessions/<encoded folder>/<session>/chat_history.jsonl
        for (const group of await dirs(root.dir)) {
          const groupDir = join(root.dir, group.name);
          for (const session of await dirs(groupDir).catch(() => [])) {
            if (!UUID_SESSION_ID.test(session.name)) continue;
            await add(join(groupDir, session.name, "chat_history.jsonl"), session.name);
          }
        }
        return;
      case "pi":
        // sessions/--<folder>--/<created>_<session>.jsonl
        for (const bucket of await dirs(root.dir)) {
          for (const entry of await files(join(root.dir, bucket.name))) {
            const match = PI_SESSION_FILE.exec(entry.name);
            if (match) await add(join(root.dir, bucket.name, entry.name), match[1]);
          }
        }
        return;
      case "cora":
        // runs/<run id>/run.json
        for (const run of await dirs(root.dir)) {
          if (!CORA_RUN_ID.test(run.name)) continue;
          await add(join(root.dir, run.name, "run.json"), run.name);
        }
        return;
    }
  }

  // ── A pass ──────────────────────────────────────────────────────────────

  /**
   * Brings the index up to date with the transcripts under `roots`. Files of
   * agents left out of `agents` are dropped from the index; files that are
   * gone are dropped only when their folder could be read this time, so an
   * unmounted or unreadable folder never empties the index.
   */
  async sync(
    roots: readonly SessionSourceRoot[],
    agents: ReadonlySet<SessionSearchAgent>,
    pacer: IndexPacer,
    onProgress: (progress: SyncProgress) => void = () => undefined,
  ): Promise<SyncSummary> {
    const found: DiscoveredFile[] = [];
    const readRoots: string[] = [];
    for (const root of roots) {
      if (!agents.has(root.agent)) continue;
      try {
        await this.discover(root, pacer, found);
        readRoots.push(root.dir);
      } catch {
        // Missing or unreadable: keep what the index already holds for it.
      }
    }
    // Two roots can hold copies of one transcript (a synced folder, an old
    // account home, an archived Codex rollout): the fullest copy wins. A copy
    // keeps its file name; the segments one Codex session continues in do not.
    const bySession = new Map<string, DiscoveredFile>();
    for (const file of found) {
      const key = `${sessionKey(file.agent, file.sessionId)}/${basename(file.path)}`;
      const kept = bySession.get(key);
      if (!kept || file.size > kept.size || (file.size === kept.size && file.mtimeMs > kept.mtimeMs)) {
        bySession.set(key, file);
      }
    }
    found.length = 0;
    found.push(...bySession.values());
    // Newest first, so the sessions people look for first are searchable first.
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const summary: SyncSummary = {
      filesTotal: found.length,
      filesRead: 0,
      bytesRead: 0,
      skippedLines: 0,
      removedFiles: 0,
    };
    onProgress({ filesTotal: found.length, filesDone: 0 });
    const codexTitles = await this.codexThreadTitles(roots, agents);

    try {
      let done = 0;
      for (const file of found) {
        const read = await this.indexFile(file, pacer, codexTitles);
        if (read.bytes > 0 || read.reset) summary.filesRead += 1;
        summary.bytesRead += read.bytes;
        summary.skippedLines += read.skippedLines;
        done += 1;
        onProgress({ filesTotal: found.length, filesDone: done });
      }
      summary.removedFiles = await this.removeVanished(found, readRoots, agents, pacer);
      this.setMeta("lastSyncAt", String(Date.now()));
      this.setMeta("built", "1");
      this.commit();
    } catch (err) {
      this.rollback();
      throw err;
    }
    return summary;
  }

  /** Codex keeps the names of its threads in session_index.jsonl beside sessions/. */
  private async codexThreadTitles(
    roots: readonly SessionSourceRoot[],
    agents: ReadonlySet<SessionSearchAgent>,
  ): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    if (!agents.has("codex")) return titles;
    const files = new Set(
      roots.filter((root) => root.agent === "codex").map((root) => join(dirname(root.dir), "session_index.jsonl")),
    );
    for (const path of files) {
      const stat = await fs.stat(path).catch(() => null);
      if (!stat?.isFile() || stat.size > CODEX_INDEX_MAX_BYTES) continue;
      await readJsonlLines(path, 0, {
        end: stat.size,
        onLine: (line) => {
          try {
            const record = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
            if (typeof record.id === "string" && typeof record.thread_name === "string" && record.thread_name.trim()) {
              titles.set(record.id.toLowerCase(), record.thread_name.trim());
            }
          } catch {
            // A line being written.
          }
        },
      }).catch(() => undefined);
    }
    return titles;
  }

  private sessionRow(agent: SessionSearchAgent, sessionId: string): number {
    this.stmt("INSERT OR IGNORE INTO sessions (agent, session_id) VALUES (?, ?)").run(agent, sessionId);
    return num(this.stmt("SELECT id FROM sessions WHERE agent = ? AND session_id = ?").get(agent, sessionId)?.id);
  }

  private deleteFileMessages(fileRow: number): void {
    this.stmt("DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE file_row = ?)").run(fileRow);
    this.stmt("DELETE FROM messages WHERE file_row = ?").run(fileRow);
  }

  private insertMessage(sessionRow: number, fileRow: number, message: IndexedMessage): void {
    chunkText(message.text).forEach((chunk, part) => {
      const { lastInsertRowid } = this.stmt(
        "INSERT INTO messages (session_row, file_row, role, part, ts) VALUES (?, ?, ?, ?, ?)",
      ).run(sessionRow, fileRow, message.role, part, message.at);
      this.stmt("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(lastInsertRowid, chunk);
    });
  }

  /** The session row's facts and its searchable title, from a file's state. */
  private updateSession(
    sessionRow: number,
    state: TranscriptState,
    file: DiscoveredFile,
    fallbackTitle: string | null,
    workspaceId: string | null = null,
  ): void {
    const cwdKey = state.cwd ? sessionCwdKey(state.cwd, this.platform) : null;
    const title = state.customTitle ?? fallbackTitle ?? sessionTitle(state);
    const previous = this.stmt("SELECT title FROM sessions WHERE id = ?").get(sessionRow);
    this.stmt(`
      UPDATE sessions SET
        cwd = COALESCE(cwd, ?),
        cwd_key = COALESCE(cwd_key, ?),
        model = COALESCE(?, model),
        first_prompt = COALESCE(first_prompt, ?),
        -- A session in several files (Codex segments) shows its newest one.
        transcript = CASE
          WHEN transcript IS NULL OR transcript = ?
            OR ? >= COALESCE((SELECT mtime FROM files WHERE path = transcript), 0)
          THEN ? ELSE transcript END,
        workspace_id = COALESCE(?, workspace_id),
        message_count = (SELECT COUNT(*) FROM messages WHERE session_row = ? AND part = 0),
        started_at = MIN(
          COALESCE(?, 9e15),
          COALESCE((SELECT MIN(ts) FROM messages WHERE session_row = ? AND part = 0), 9e15)
        ),
        last_at = (SELECT MAX(ts) FROM messages WHERE session_row = ? AND part = 0)
      WHERE id = ?
    `).run(
      state.cwd,
      cwdKey,
      state.model,
      state.firstPrompt,
      file.path,
      file.mtimeMs,
      file.path,
      workspaceId,
      sessionRow,
      state.startedAt,
      sessionRow,
      sessionRow,
      sessionRow,
    );
    this.stmt("UPDATE sessions SET started_at = NULL WHERE id = ? AND started_at >= 9e15").run(sessionRow);
    if (title && title !== previous?.title) {
      this.stmt("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionRow);
      // The title is searchable too, as its own row (part -1, no file).
      this.stmt("DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_row = ? AND part = -1)").run(sessionRow);
      this.stmt("DELETE FROM messages WHERE session_row = ? AND part = -1").run(sessionRow);
      const { lastInsertRowid } = this.stmt(
        "INSERT INTO messages (session_row, file_row, role, part, ts) VALUES (?, 0, 'title', -1, NULL)",
      ).run(sessionRow);
      this.stmt("INSERT INTO messages_fts (rowid, text) VALUES (?, ?)").run(lastInsertRowid, title);
    }
  }

  private saveFile(
    fileRow: number | null,
    file: DiscoveredFile,
    sessionRow: number,
    offset: number,
    size: number,
    state: TranscriptState,
    skipped: boolean,
  ): number {
    if (fileRow === null) {
      const { lastInsertRowid } = this.stmt(`
        INSERT INTO files (path, agent, session_row, size, mtime, ino, offset, state, skipped)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(file.path, file.agent, sessionRow, size, file.mtimeMs, file.ino, offset, JSON.stringify(state), skipped ? 1 : 0);
      return num(lastInsertRowid);
    }
    this.stmt(`
      UPDATE files SET session_row = ?, size = ?, mtime = ?, ino = ?, offset = ?, state = ?, skipped = ?
      WHERE id = ?
    `).run(sessionRow, size, file.mtimeMs, file.ino, offset, JSON.stringify(state), skipped ? 1 : 0, fileRow);
    return fileRow;
  }

  /** Drops a session no file holds any more, or recounts one that lost a file. */
  private dropSessionIfEmpty(sessionRow: number): void {
    const files = num(this.stmt("SELECT COUNT(*) AS n FROM files WHERE session_row = ?").get(sessionRow)?.n);
    if (files > 0) {
      this.stmt(`
        UPDATE sessions SET
          message_count = (SELECT COUNT(*) FROM messages WHERE session_row = ? AND part = 0),
          last_at = (SELECT MAX(ts) FROM messages WHERE session_row = ? AND part = 0),
          transcript = (SELECT path FROM files WHERE session_row = ? ORDER BY mtime DESC LIMIT 1)
        WHERE id = ?
      `).run(sessionRow, sessionRow, sessionRow, sessionRow);
      return;
    }
    this.stmt("DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_row = ?)").run(sessionRow);
    this.stmt("DELETE FROM messages WHERE session_row = ?").run(sessionRow);
    this.stmt("DELETE FROM sessions WHERE id = ?").run(sessionRow);
  }

  private async indexFile(
    file: DiscoveredFile,
    pacer: IndexPacer,
    codexTitles: ReadonlyMap<string, string>,
  ): Promise<{ bytes: number; reset: boolean; skippedLines: number }> {
    const row = this.stmt("SELECT id, size, mtime, ino, offset, state, skipped FROM files WHERE path = ?").get(file.path);
    const unchanged = row && num(row.size) === file.size && num(row.mtime) === file.mtimeMs && row.ino === file.ino;
    if (unchanged) return { bytes: 0, reset: false, skippedLines: 0 };

    if (file.agent === "cora") return this.indexCoraRun(file, row ?? null);

    const sameFile = row !== undefined && row.ino === file.ino;
    const grown = sameFile && file.size >= num(row.size) && num(row.offset) <= file.size;
    if (row && sameFile && num(row.skipped) === 1 && file.size >= num(row.size)) {
      // A rejected transcript stays rejected while it only grows.
      this.begin();
      this.saveFile(num(row.id), file, num(row.session_row), num(row.offset), file.size, restoreTranscriptState(strOrNull(row.state)), true);
      this.commit();
      return { bytes: 0, reset: false, skippedLines: 0 };
    }
    const append = Boolean(row && grown && (await endsWithNewlineAt(file.path, num(row.offset)).catch(() => false)));
    const reset = !append;
    let fileRow: number | null = row ? num(row.id) : null;
    const state = append ? restoreTranscriptState(strOrNull(row?.state)) : initialTranscriptState();
    const start = append ? num(row?.offset) : 0;

    if (file.agent === "grok") await this.applyGrokSummaryFile(file.path, state);
    this.begin();
    const sessionRow = this.sessionRow(file.agent, file.sessionId);
    if (reset && fileRow !== null) {
      const previousSession = num(row?.session_row);
      this.deleteFileMessages(fileRow);
      if (previousSession !== sessionRow) {
        this.stmt("UPDATE files SET session_row = ? WHERE id = ?").run(sessionRow, fileRow);
        this.dropSessionIfEmpty(previousSession);
      }
    }
    // Until the read completes, the stored size is how far it got, so a pass
    // cut short never leaves the file looking unchanged.
    fileRow = this.saveFile(fileRow, file, sessionRow, start, start, state, false);
    // Reads below await the disk; no transaction stays open across them.
    this.commit();
    const titleFor = () =>
      file.agent === "codex" ? (codexTitles.get(file.sessionId.toLowerCase()) ?? null) : null;

    const parse = LINE_PARSERS[file.agent as Exclude<SessionSearchAgent, "cora">];
    const pending: IndexedMessage[] = [];
    let sliceBytes = 0;
    let rejected = false;
    // Each slice commits its messages together with the offset just past
    // the last line they came from, so a pass cut short resumes exactly there.
    const flush = async (endOffset: number, done: boolean) => {
      this.begin();
      for (const message of pending) this.insertMessage(sessionRow, fileRow as number, message);
      pending.length = 0;
      this.saveFile(fileRow, file, sessionRow, endOffset, done ? file.size : endOffset, state, false);
      this.updateSession(sessionRow, state, file, titleFor());
      this.commit();
      await pacer.checkpoint();
    };

    let lineStart = start;
    const result = await readJsonlLines(file.path, start, {
      end: file.size,
      onLine: async (line, endOffset) => {
        parse(line, state, (message) => pending.push(message));
        sliceBytes += endOffset - lineStart;
        lineStart = endOffset;
        if (state.rejected) {
          rejected = true;
          return false;
        }
        if (sliceBytes >= SLICE_BYTES || pending.length >= SLICE_MESSAGES) {
          sliceBytes = 0;
          await flush(endOffset, false);
        }
        return true;
      },
    });
    const offset = result.offset;

    if (rejected) {
      this.begin();
      this.deleteFileMessages(fileRow);
      this.saveFile(fileRow, file, sessionRow, offset, file.size, state, true);
      this.dropSessionIfEmpty(sessionRow);
      this.commit();
      return { bytes: offset - start, reset, skippedLines: result.skippedLines };
    }
    await flush(offset, true);
    return { bytes: offset - start, reset, skippedLines: result.skippedLines };
  }

  private async applyGrokSummaryFile(transcriptPath: string, state: TranscriptState): Promise<void> {
    const summaryPath = join(dirname(transcriptPath), "summary.json");
    const stat = await fs.stat(summaryPath).catch(() => null);
    if (!stat?.isFile() || stat.size > SUMMARY_MAX_BYTES) return;
    const raw = await fs.readFile(summaryPath, "utf8").catch(() => null);
    if (raw) applyGrokSummary(raw, state);
  }

  /** run.json is rewritten in place, so a changed run is read again whole. */
  private async indexCoraRun(file: DiscoveredFile, row: Row | null): Promise<{ bytes: number; reset: boolean; skippedLines: number }> {
    if (file.size > RUN_JSON_MAX_BYTES) return { bytes: 0, reset: false, skippedLines: 0 };
    const raw = await fs.readFile(file.path, "utf8").catch(() => null);
    const run = raw ? parseCoraRun(raw) : null;
    let cwd: string | null = null;
    const eventsPath = join(dirname(file.path), "events.jsonl");
    const eventsSize = (await fs.stat(eventsPath).catch(() => null))?.size ?? 0;
    if (eventsSize > 0) {
      await readJsonlLines(eventsPath, 0, {
        end: Math.min(eventsSize, 256 * 1024),
        onLine: (line) => {
          cwd = coraRunCwd(line);
          return false;
        },
      }).catch(() => undefined);
    }
    const state = initialTranscriptState();
    state.cwd = cwd;
    this.begin();
    const sessionRow = this.sessionRow("cora", file.sessionId);
    let fileRow: number | null = row ? num(row.id) : null;
    if (fileRow !== null) this.deleteFileMessages(fileRow);
    if (!run) {
      fileRow = this.saveFile(fileRow, file, sessionRow, file.size, file.size, state, true);
      this.dropSessionIfEmpty(sessionRow);
      this.commit();
      return { bytes: 0, reset: true, skippedLines: 0 };
    }
    state.model = run.model;
    state.title = run.title;
    for (const message of run.messages) {
      if (message.role === "user" && state.firstPrompt === null) state.firstPrompt = message.text.slice(0, 300);
      if (message.at !== null && (state.startedAt === null || message.at < state.startedAt)) state.startedAt = message.at;
    }
    fileRow = this.saveFile(fileRow, file, sessionRow, file.size, file.size, state, false);
    for (const message of run.messages) this.insertMessage(sessionRow, fileRow, message);
    this.updateSession(sessionRow, state, file, null, run.workspaceId);
    this.commit();
    return { bytes: file.size, reset: true, skippedLines: 0 };
  }

  private async removeVanished(
    found: readonly DiscoveredFile[],
    readRoots: readonly string[],
    agents: ReadonlySet<SessionSearchAgent>,
    pacer: IndexPacer,
  ): Promise<number> {
    const present = new Set(found.map((file) => file.path));
    const rows = this.stmt("SELECT id, path, agent, session_row FROM files").all();
    let removed = 0;
    for (const row of rows) {
      const path = String(row.path);
      if (present.has(path)) continue;
      const agent = row.agent as SessionSearchAgent;
      const underReadRoot = readRoots.some((root) => path.startsWith(root.endsWith(sep) ? root : root + sep));
      if (agents.has(agent) && !underReadRoot) continue;
      this.begin();
      this.deleteFileMessages(num(row.id));
      this.stmt("DELETE FROM files WHERE id = ?").run(num(row.id));
      this.dropSessionIfEmpty(num(row.session_row));
      this.commit();
      removed += 1;
      if (removed % 50 === 0) await pacer.checkpoint();
    }
    return removed;
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  stats(): IndexStats {
    const sessions = this.stmt("SELECT COUNT(*) AS n, COALESCE(SUM(message_count), 0) AS m FROM sessions WHERE message_count > 0").get();
    const pages = this.stmt("PRAGMA page_count").get();
    const pageSize = this.stmt("PRAGMA page_size").get();
    const lastSync = this.meta("lastSyncAt");
    const byAgent: IndexStats["byAgent"] = {};
    for (const row of this.stmt(
      "SELECT agent, COUNT(*) AS n, COALESCE(SUM(message_count), 0) AS m FROM sessions WHERE message_count > 0 GROUP BY agent",
    ).all()) {
      byAgent[row.agent as SessionSearchAgent] = { sessions: num(row.n), messages: num(row.m) };
    }
    return {
      sessions: num(sessions?.n),
      messages: num(sessions?.m),
      byAgent,
      bytes: num(pages?.page_count) * num(pageSize?.page_size),
      lastSyncAt: lastSync ? Number(lastSync) : null,
      built: this.meta("built") === "1",
    };
  }

  private filterClause(input: Pick<IndexSearchInput, "agents" | "scopeKeys">): { sql: string; params: SqlValue[] } {
    const clauses = ["s.message_count > 0"];
    const params: SqlValue[] = [];
    clauses.push(`s.agent IN (${input.agents.map(() => "?").join(", ") || "NULL"})`);
    params.push(...input.agents);
    if (input.scopeKeys) {
      const keys = input.scopeKeys.filter(Boolean);
      if (keys.length === 0 || !keys.includes("/")) {
        const ors = keys.map(() => "(s.cwd_key = ? OR substr(s.cwd_key, 1, ?) = ?)");
        clauses.push(ors.length > 0 ? `(${ors.join(" OR ")})` : "0");
        for (const key of keys) params.push(key, key.length + 1, `${key}/`);
      }
    }
    return { sql: clauses.join(" AND "), params };
  }

  /**
   * With a query: sessions whose messages or title match every word (any
   * word when none matches all), best match first, recent ones lifted. With
   * no query: the most recent sessions.
   */
  search(input: IndexSearchInput): { hits: Omit<SessionSearchHit, "cwdExists">[]; hasMore: boolean } {
    const filter = this.filterClause(input);
    const match = buildFtsMatch(input.query);
    if (!match) {
      const rows = this.db
        .prepare(`
          SELECT s.* FROM sessions s WHERE ${filter.sql}
          ORDER BY s.last_at DESC LIMIT ? OFFSET ?
        `)
        .all(...filter.params, input.limit + 1, input.offset);
      return {
        hits: rows.slice(0, input.limit).map((row) => this.toHit(row, null, null)),
        hasMore: rows.length > input.limit,
      };
    }
    let candidates = this.rankedSessions(match, filter);
    if (candidates.length === 0) {
      const any = buildFtsMatch(input.query, "any");
      if (any && any !== match) candidates = this.rankedSessions(any, filter);
    }
    const day = 86_400_000;
    // bm25 is negative, lower is better; a recent session's score is
    // stretched further below zero, up to 60% for one from today.
    const scored = candidates.map((row) => {
      const age = Math.max(0, input.now - num(row.last_at)) / day;
      return { row, score: num(row.best) * (1 + 0.6 * Math.exp(-age / 45)) };
    });
    scored.sort((a, b) => a.score - b.score || num(b.row.last_at) - num(a.row.last_at));
    const page = scored.slice(input.offset, input.offset + input.limit);
    const snippet = this.stmt(
      "SELECT snippet(messages_fts, 0, ?, ?, '…', ?) AS text FROM messages_fts WHERE messages_fts MATCH ? AND rowid = ?",
    );
    const tokens = Math.max(4, Math.min(64, Math.floor(input.snippetTokens) || 12));
    return {
      hits: page.map(({ row }) => {
        const hitMatch = String(row.hit_match);
        let mid = num(row.mid);
        let role = String(row.role);
        if (role === "title") {
          // The row shows the title already: the excerpt comes from the
          // best matching message, and there is none when only the title matched.
          const message = this.stmt(`
            SELECT m.id AS mid, m.role AS role
            FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
            WHERE messages_fts MATCH ? AND m.session_row = ? AND m.part >= 0
            ORDER BY bm25(messages_fts) LIMIT 1
          `).get(hitMatch, BigInt(num(row.id)));
          if (!message) return this.toHit(row, null, null);
          mid = num(message.mid);
          role = String(message.role);
        }
        // A JS number binds as a REAL, and FTS5 then ignores the rowid
        // constraint and answers with the first match; a BigInt binds as an INTEGER.
        const text = strOrNull(snippet.get(SNIPPET_MARK_START, SNIPPET_MARK_END, tokens, hitMatch, BigInt(mid))?.text);
        return this.toHit(row, text, role === "user" ? "user" : "assistant");
      }),
      hasMore: scored.length > input.offset + input.limit,
    };
  }

  private rankedSessions(match: string, filter: { sql: string; params: SqlValue[] }): Row[] {
    // SQLite returns the other columns of the row MIN() picked, so each
    // session comes back with its best matching message. MATERIALIZED keeps
    // bm25() in the FTS query itself, where FTS5 allows it.
    return this.db
      .prepare(`
        WITH hits AS MATERIALIZED (
          SELECT m.session_row AS sid, m.id AS mid, m.role AS role, bm25(messages_fts) AS rank
          FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
          WHERE messages_fts MATCH ?
        )
        SELECT s.*, h.mid AS mid, h.role AS role, MIN(h.rank) AS best, ? AS hit_match
        FROM hits h JOIN sessions s ON s.id = h.sid
        WHERE ${filter.sql}
        GROUP BY h.sid
        ORDER BY best ASC
        LIMIT ${CANDIDATE_SESSIONS}
      `)
      .all(match, match, ...filter.params);
  }

  private toHit(
    row: Row,
    snippet: string | null,
    role: SessionSearchHit["snippetRole"],
  ): Omit<SessionSearchHit, "cwdExists"> {
    const agent = row.agent as SessionSearchAgent;
    const sessionId = String(row.session_id);
    return {
      key: sessionKey(agent, sessionId),
      agent,
      sessionId,
      title: strOrNull(row.title) ?? strOrNull(row.first_prompt) ?? "Untitled session",
      snippet,
      snippetRole: snippet === null ? null : role,
      cwd: strOrNull(row.cwd),
      model: strOrNull(row.model),
      messageCount: num(row.message_count),
      startedAt: numOrNull(row.started_at),
      lastAt: numOrNull(row.last_at),
      workspaceId: strOrNull(row.workspace_id),
    };
  }

  session(key: string): IndexSessionRecord | null {
    const parsed = parseSessionKey(key);
    if (!parsed) return null;
    const row = this.stmt("SELECT transcript FROM sessions WHERE agent = ? AND session_id = ?").get(parsed.agent, parsed.sessionId);
    if (!row) return null;
    return { agent: parsed.agent, sessionId: parsed.sessionId, transcriptPath: strOrNull(row.transcript) };
  }

  /** The session's messages as indexed, oldest first, for a read-only view. */
  transcript(key: string, limit: number): SessionTranscript | null {
    const parsed = parseSessionKey(key);
    if (!parsed) return null;
    const session = this.stmt("SELECT * FROM sessions WHERE agent = ? AND session_id = ?").get(parsed.agent, parsed.sessionId);
    if (!session) return null;
    const sessionRow = num(session.id);
    const total = num(
      this.stmt("SELECT COUNT(*) AS n FROM messages WHERE session_row = ? AND part = 0").get(sessionRow)?.n,
    );
    const messages: SessionTranscriptMessage[] = [];
    // Iterated, not collected: a long session never sits in memory whole.
    for (const row of this.stmt(`
      SELECT m.role AS role, m.part AS part, m.ts AS ts, f.text AS text
      FROM messages m JOIN messages_fts f ON f.rowid = m.id
      WHERE m.session_row = ? AND m.part >= 0
      ORDER BY COALESCE(m.ts, 0), m.id
    `).iterate(sessionRow)) {
      const text = String(row.text ?? "");
      if (num(row.part) > 0) {
        // The next piece of a message split across rows.
        if (messages.length > 0) messages[messages.length - 1].text += ` ${text}`;
        continue;
      }
      if (messages.length >= limit) break;
      messages.push({ role: row.role === "user" ? "user" : "assistant", text, at: numOrNull(row.ts) });
    }
    return {
      key,
      agent: parsed.agent,
      title: strOrNull(session.title) ?? strOrNull(session.first_prompt) ?? "Untitled session",
      cwd: strOrNull(session.cwd),
      messages,
      total,
    };
  }
}

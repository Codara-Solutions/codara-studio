import { existsSync, readFileSync, renameSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { sparkHome } from "../spark-home";
import { writeFileAtomic } from "../fs-atomic";

// Cora memory v2: curated semantic guidance, two markdown tiers.
//
//   ~/.Codara/memory/MEMORY.md                    the global tier
//   ~/.Codara/memory/workspaces/<id>.md           the per-workspace tier
//   ~/.Codara/memory/memory-state.json            the enable/disable toggles
//
// The markdown file IS the prompt payload. Injection pastes the raw file body
// (byte-capped) into the manager turn's dynamic tail; parsing exists only for
// dedup, TTL, and the user-line preservation guardrail, so a malformed file
// degrades to weird but harmless text, never a failure.
//
// Provenance grammar: bullets ("- " or "* ", leading indentation allowed) may
// start with [auto YYYY-MM-DD run:<runId>], [auto YYYY-MM-DD], or
// [cora YYYY-MM-DD]. Everything else (untagged bullets, prose, headings) is
// user-authored: preserved verbatim, never deleted by the app, counted toward
// the byte cap. Tagged bullets belong to Cora and may be pruned, rewritten, or
// expired.
//
// Writers: only Cora (via the codara_remember RPC) and the run-completion
// auto-emitters (workspace-lessons.ts -> appendAutoMemories). Workers never
// write and never receive automatic injection; Cora copies applicable lines
// into worker task descriptions.
//
// run-memory.ts is untouched and never merged into this module: that file is
// the episodic outcome ledger (distilled fingerprints of finished runs), this
// one is curated semantic guidance. They serve different prompts and different
// TTL/curation policies.
//
// This module imports only spark-home + fs-atomic, never run-store,
// manager-protocol, or shared types, so there is no import cycle and no
// cross-dependency on the IPC/tool-definition side.

// ── constants ───────────────────────────────────────────────────────────────

/** Hard byte cap per memory file. Injection truncates here; adds reject. */
export const MEMORY_FILE_MAX_BYTES = 4096;
/** Soft cap: the injected section grows a consolidation footer past this. */
export const MEMORY_FILE_SOFT_BYTES = 3277;
/** Programmatic bullets are whitespace-collapsed and ellipsis-truncated here. */
export const MAX_BULLET_LENGTH = 300;
/** Per-run codara_remember call budget (counted at the agent-socket handler). */
export const MAX_REMEMBER_CALLS_PER_RUN = 5;
/** Per-run cap on bullets added via codara_remember (agent-socket handler). */
export const MAX_BULLETS_ADDED_PER_RUN = 10;

const AUTO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CORA_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const MEMORY_TRUNCATION_NOTICE =
  "[memory truncated at 4 KB: ask Cora to consolidate, or trim the file]";

export function memoryFullError(usedBytes: number, capBytes: number): string {
  return (
    `memory full (${usedBytes}/${capBytes} bytes): consolidate first with action "replace" ` +
    `(rewrite the [cora]/[auto] lines shorter or drop stale ones; untagged user lines must be kept)`
  );
}

export function userLinesExceedCapError(path: string): string {
  return `user-authored content alone exceeds the cap; ask the user to trim ${path}`;
}

export function memoryDisabledError(scope: MemoryScope): string {
  return `memory is disabled for this ${scope}; tell the user if they asked you to remember something`;
}

export function memorySoftCapFooter(usedBytes: number, capBytes: number): string {
  return (
    `This memory file is ${usedBytes}/${capBytes} bytes. ` +
    `Consolidate it with codara_remember action "replace" before adding more.`
  );
}

// ── types (self-contained; the IPC/UI side keeps its own mirrors) ───────────

export type MemoryScope = "workspace" | "global";

export interface MemoryTierStatus {
  enabled: boolean;
  path: string;
  bytesUsed: number;
  bytesCap: number;
  overCap: boolean;
  counts: { user: number; cora: number; auto: number };
}

export interface MemoryStatus {
  global: MemoryTierStatus;
  workspace: MemoryTierStatus;
}

export interface RememberResult {
  bytesUsed: number;
  bytesCap: number;
  message: string;
}

interface MemoryState {
  version: number;
  globalEnabled: boolean;
  workspaces: Record<string, { enabled: boolean }>;
}

interface BulletTag {
  source: "auto" | "cora";
  date: string;
  runId?: string;
}

interface MemoryLine {
  /** The exact on-disk line; serialization re-emits it verbatim. */
  raw: string;
  /** auto/cora = tagged bullets Cora owns; user = everything else non-blank. */
  kind: "auto" | "cora" | "user" | "blank";
  tag?: BulletTag;
  /** Bullet text after the tag (tagged) or after the marker (untagged bullet). */
  bulletText?: string;
}

interface MemoryFile {
  /** Managed header (title line + comment block); regenerated on writes. */
  headerLines: string[];
  lines: MemoryLine[];
}

// ── paths and state ─────────────────────────────────────────────────────────

function memoryRoot(): string {
  return join(sparkHome(), "memory");
}

// Strip path separators and other unsafe characters so a workspaceId can never
// escape the memory dir or collide with a control character. Falls back to a
// stable placeholder when sanitizing empties the value. Copied from
// run-memory.ts (not imported: the two modules must stay decoupled).
function sanitize(workspaceId: string): string {
  const cleaned = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "_unknown";
}

export function globalMemoryPath(): string {
  return join(memoryRoot(), "MEMORY.md");
}

export function workspaceMemoryPath(workspaceId: string): string {
  return join(memoryRoot(), "workspaces", `${sanitize(workspaceId)}.md`);
}

function statePath(): string {
  return join(memoryRoot(), "memory-state.json");
}

// Null prototype so a hostile "__proto__" workspace id lands as an ordinary
// own property instead of mutating a prototype (same as workspace-lessons had).
function emptyWorkspaceToggles(): Record<string, { enabled: boolean }> {
  return Object.create(null) as Record<string, { enabled: boolean }>;
}

/** Missing file / missing fields read as enabled. */
function readState(): MemoryState {
  const fallback: MemoryState = {
    version: 1,
    globalEnabled: true,
    workspaces: emptyWorkspaceToggles(),
  };
  const path = statePath();
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MemoryState>;
    const workspaces = emptyWorkspaceToggles();
    if (raw.workspaces && typeof raw.workspaces === "object" && !Array.isArray(raw.workspaces)) {
      for (const [id, entry] of Object.entries(raw.workspaces)) {
        if (entry && typeof entry === "object" && typeof entry.enabled === "boolean") {
          workspaces[id] = { enabled: entry.enabled };
        }
      }
    }
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      globalEnabled: raw.globalEnabled !== false,
      workspaces,
    };
  } catch {
    return fallback;
  }
}

function tierEnabled(state: MemoryState, scope: MemoryScope, workspaceId: string): boolean {
  // The global toggle is the master switch: a disabled global tier disables
  // memory outright, including per-workspace files (see formatCoraMemoryForTurn).
  if (!state.globalEnabled) return false;
  if (scope === "global") return true;
  return state.workspaces[workspaceId]?.enabled !== false;
}

// ── workspace metadata for the header (best-effort) ─────────────────────────

// The header names the workspace and its cwd so a user browsing
// ~/.Codara/memory/workspaces can tell the files apart. Resolved from
// spark-state.json (the persisted AppState) purely best-effort: a missing or
// unreadable state file degrades to the raw workspaceId.
function resolveWorkspaceMeta(workspaceId: string): { name: string; cwd: string } {
  try {
    const raw = JSON.parse(readFileSync(join(sparkHome(), "spark-state.json"), "utf8")) as {
      workspaces?: Array<{ id?: unknown; name?: unknown; cwd?: unknown }>;
    };
    const match = raw.workspaces?.find((entry) => entry?.id === workspaceId);
    if (match) {
      return {
        name: typeof match.name === "string" && match.name.trim() ? match.name : workspaceId,
        cwd: typeof match.cwd === "string" && match.cwd.trim() ? match.cwd : "(unknown)",
      };
    }
  } catch {
    // fall through to the id-based fallback
  }
  return { name: workspaceId, cwd: "(unknown)" };
}

const HEADER_OWNERSHIP_LINES = [
  "     Bullets tagged [auto ...] or [cora ...] belong to Cora and may be pruned,",
  "     rewritten, or expired. Untagged lines are yours; Cora never deletes them. -->",
];

function buildHeader(scope: MemoryScope, workspaceId: string): string[] {
  if (scope === "global") {
    return [
      "# Cora memory (global)",
      "<!-- Managed by Cora; applies to every workspace. Edit freely in the editor; keep it under 4 KB.",
      ...HEADER_OWNERSHIP_LINES,
    ];
  }
  const meta = resolveWorkspaceMeta(workspaceId);
  return [
    `# Cora memory (workspace: ${meta.name})`,
    `<!-- cwd: ${meta.cwd}`,
    "     Managed by Cora. Edit freely in the editor; keep it under 4 KB.",
    ...HEADER_OWNERSHIP_LINES,
  ];
}

/** Fresh-file template. The global variant suggests a starting heading. */
function templateFile(scope: MemoryScope, workspaceId: string): MemoryFile {
  const lines: MemoryLine[] =
    scope === "global"
      ? [
          { raw: "", kind: "blank" },
          { raw: "## About the user", kind: "user" },
          { raw: "", kind: "blank" },
        ]
      : [{ raw: "", kind: "blank" }];
  return { headerLines: buildHeader(scope, workspaceId), lines };
}

// ── parsing / serialization ─────────────────────────────────────────────────

const BULLET_PATTERN = /^\s*[-*]\s+(.*)$/;
const TAG_PATTERN = /^\[(auto|cora)\s+(\d{4}-\d{2}-\d{2})(?:\s+run:([^\]\s]+))?\]\s*(.*)$/;

function parseLine(raw: string): MemoryLine {
  if (raw.trim().length === 0) return { raw, kind: "blank" };
  const bullet = BULLET_PATTERN.exec(raw);
  if (!bullet) return { raw, kind: "user" };
  const tagged = TAG_PATTERN.exec(bullet[1]);
  if (!tagged) return { raw, kind: "user", bulletText: bullet[1] };
  return {
    raw,
    kind: tagged[1] as "auto" | "cora",
    tag: { source: tagged[1] as "auto" | "cora", date: tagged[2], runId: tagged[3] },
    bulletText: tagged[4],
  };
}

// The header comment must close within this many lines after the title. An
// unclosed comment (a user deleted the "-->" while editing) must not swallow
// the rest of the file into the regenerated-on-write header; past this bound
// only the title line counts as header and the comment lines stay ordinary
// user content. The shipped template's comment is 4 lines.
const HEADER_COMMENT_MAX_LINES = 8;

// A code-fence marker line. Everything inside a fence is the user's, even
// text that happens to look like a tagged bullet, so an example of the tag
// format inside a fence is never pruned, expired, or deduped.
const FENCE_PATTERN = /^\s*```/;

/**
 * Split a file into the managed header (the "# Cora memory" title line plus an
 * immediately following, properly closed comment block) and content lines.
 * Both halves preserve raw text; serializeMemoryFile(parseMemoryFile(x)) === x
 * for any LF input, so a hand-edited file survives a programmatic write
 * byte-for-byte outside the lines the write actually touched.
 */
export function parseMemoryFile(content: string): MemoryFile {
  const rawLines = content.split(/\r?\n/);
  const headerLines: string[] = [];
  let index = 0;
  if (rawLines.length > 0 && rawLines[0].startsWith("# Cora memory")) {
    headerLines.push(rawLines[0]);
    index = 1;
    if (index < rawLines.length && rawLines[index].trimStart().startsWith("<!--")) {
      let closedAt = -1;
      const limit = Math.min(rawLines.length, index + HEADER_COMMENT_MAX_LINES);
      for (let i = index; i < limit; i += 1) {
        if (rawLines[i].includes("-->")) {
          closedAt = i;
          break;
        }
      }
      if (closedAt >= 0) {
        for (let i = index; i <= closedAt; i += 1) headerLines.push(rawLines[i]);
        index = closedAt + 1;
      }
      // Unclosed or overlong comment: it stays in the content lines below,
      // where it is user-owned and survives every programmatic write.
    }
  }
  const lines: MemoryLine[] = [];
  let inFence = false;
  for (const raw of rawLines.slice(index)) {
    if (FENCE_PATTERN.test(raw)) {
      inFence = !inFence;
      lines.push({ raw, kind: "user" });
      continue;
    }
    if (inFence) {
      // No bullet/tag parsing inside a fence: the whole raw line is the
      // user's text (an unclosed fence runs to end of file, like markdown).
      lines.push(raw.trim().length === 0 ? { raw, kind: "blank" } : { raw, kind: "user" });
      continue;
    }
    lines.push(parseLine(raw));
  }
  return { headerLines, lines };
}

export function serializeMemoryFile(file: MemoryFile): string {
  return [...file.headerLines, ...file.lines.map((line) => line.raw)].join("\n");
}

// Measures what a write would put on disk (including the trailing newline the
// writer normalizes in), so byte-cap decisions match the resulting file size.
function fileBytes(file: MemoryFile): number {
  let content = serializeMemoryFile(file);
  if (!content.endsWith("\n")) content += "\n";
  return Buffer.byteLength(content, "utf8");
}

// ── TTL / dedup helpers ─────────────────────────────────────────────────────

/** Unparseable dates read as fresh: we cannot prove such a line stale. */
function isExpired(line: MemoryLine, now: number): boolean {
  if (!line.tag) return false;
  const created = Date.parse(line.tag.date);
  if (!Number.isFinite(created)) return false;
  const ttl = line.tag.source === "auto" ? AUTO_TTL_MS : CORA_TTL_MS;
  return now - created > ttl;
}

/** Read-side filter; never rewrites the file (pure reads must not write). */
function withoutExpired(file: MemoryFile, now: number): MemoryFile {
  return { ...file, lines: file.lines.filter((line) => !isExpired(line, now)) };
}

/** Write-side prune: expired tagged lines physically leave the file. */
function pruneExpired(file: MemoryFile, now: number): void {
  file.lines = file.lines.filter((line) => !isExpired(line, now));
}

/** Dedup key: tag stripped, lowercased, whitespace collapsed, trailing punctuation dropped. */
function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
}

function lineKey(line: MemoryLine): string | null {
  const text = line.bulletText ?? (line.kind === "user" ? line.raw : undefined);
  if (text === undefined) return null;
  const key = normalizeKey(text);
  return key.length > 0 ? key : null;
}

/** Collapse whitespace and cap at MAX_BULLET_LENGTH with an ellipsis. */
function cleanBulletText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_BULLET_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_BULLET_LENGTH - 1)}…`;
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function autoBulletRaw(text: string, date: string, runId: string): string {
  return runId ? `- [auto ${date} run:${runId}] ${text}` : `- [auto ${date}] ${text}`;
}

function coraBulletRaw(text: string, date: string): string {
  return `- [cora ${date}] ${text}`;
}

interface AddOutcome {
  added: number;
  replaced: number;
  alreadyKnown: number;
}

/**
 * Dedup-aware add shared by the auto and cora write paths. A bullet whose
 * normalized key matches an existing tagged line replaces that line in place
 * (newest tag wins); a duplicate of a user-authored line is dropped and counted
 * as already known; user lines are never removed or retagged by dedup.
 */
function addBullets(file: MemoryFile, texts: string[], makeRaw: (text: string) => string): AddOutcome {
  const outcome: AddOutcome = { added: 0, replaced: 0, alreadyKnown: 0 };
  for (const rawText of texts) {
    const text = cleanBulletText(rawText);
    if (!text) continue;
    const key = normalizeKey(text);
    if (!key) continue;
    const line = parseLine(makeRaw(text));
    let handled = false;
    for (let i = 0; i < file.lines.length; i += 1) {
      const existing = file.lines[i];
      if (lineKey(existing) !== key) continue;
      if (existing.kind === "user") {
        outcome.alreadyKnown += 1;
      } else {
        file.lines[i] = line;
        outcome.replaced += 1;
      }
      handled = true;
      break;
    }
    if (handled) continue;
    // Keep at most one trailing blank between content and the appended bullet.
    while (file.lines.length > 0 && file.lines[file.lines.length - 1].kind === "blank") {
      file.lines.pop();
    }
    file.lines.push(line);
    outcome.added += 1;
  }
  return outcome;
}

// ── file IO ─────────────────────────────────────────────────────────────────

function readMemoryFile(path: string): MemoryFile | null {
  if (!existsSync(path)) return null;
  try {
    return parseMemoryFile(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Programmatic write: header refreshed (name + cwd may have changed since
 * creation), directories created lazily, tmp+rename atomic.
 */
async function writeMemoryFile(scope: MemoryScope, workspaceId: string, file: MemoryFile): Promise<void> {
  file.headerLines = buildHeader(scope, workspaceId);
  const path = scope === "global" ? globalMemoryPath() : workspaceMemoryPath(workspaceId);
  await mkdir(join(path, ".."), { recursive: true });
  let content = serializeMemoryFile(file);
  if (!content.endsWith("\n")) content += "\n";
  await writeFileAtomic(path, content);
}

/**
 * Load a file for a programmatic write. The managed header is refreshed
 * immediately (not at write time) so every byte-cap decision measures the
 * same header the write will actually put on disk.
 */
function loadForWrite(scope: MemoryScope, workspaceId: string): MemoryFile {
  const path = scope === "global" ? globalMemoryPath() : workspaceMemoryPath(workspaceId);
  const file = readMemoryFile(path) ?? templateFile(scope, workspaceId);
  file.headerLines = buildHeader(scope, workspaceId);
  return file;
}

// Per-path write serialization. Every read-modify-write in this module runs
// through the queue for its target file, so a codara_remember call racing a
// run-completion auto-append (or two runs completing together) cannot
// interleave: the second writer re-reads the file only after the first one's
// rename has landed. The map holds one settled-tail promise per path and
// cleans up after itself, so it stays empty at rest.
const fileWriteQueues = new Map<string, Promise<void>>();

function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileWriteQueues.get(path) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileWriteQueues.set(path, tail);
  void tail.then(() => {
    if (fileWriteQueues.get(path) === tail) fileWriteQueues.delete(path);
  });
  return run;
}

function tierPath(scope: MemoryScope, workspaceId: string): string {
  return scope === "global" ? globalMemoryPath() : workspaceMemoryPath(workspaceId);
}

// ── migration from ~/.Codara/lessons.json ───────────────────────────────────

let migration: Promise<void> | null = null;

function ensureMigrated(): Promise<void> {
  if (!migration) migration = migrateLegacyLessons();
  return migration;
}

/**
 * One-shot import of the v1 lessons ledger. Each workspace's unexpired lessons
 * become [auto <createdAt date> run:<runId>] bullets in that workspace's md
 * (their original dates carry over, so the 30-day auto TTL keeps aging them),
 * then the ledger is renamed to lessons.json.bak. Best-effort end to end: a
 * malformed ledger is renamed away without import rather than retried forever.
 */
async function migrateLegacyLessons(): Promise<void> {
  const legacyPath = join(sparkHome(), "lessons.json");
  try {
    if (!existsSync(legacyPath)) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
    } catch {
      parsed = null;
    }
    const workspaces = (parsed as { workspaces?: unknown } | null)?.workspaces;
    if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)) {
      const now = Date.now();
      const state = readState();
      for (const [workspaceId, entries] of Object.entries(workspaces as Record<string, unknown>)) {
        if (!workspaceId || !Array.isArray(entries)) continue;
        // A disabled tier means no write, migration included. The original
        // data survives in lessons.json.bak either way.
        if (!tierEnabled(state, "workspace", workspaceId)) continue;
        await withPathLock(tierPath("workspace", workspaceId), async () => {
          const file = loadForWrite("workspace", workspaceId);
          pruneExpired(file, now);
          let imported = 0;
          for (const entry of entries) {
            const lesson = entry as { text?: unknown; runId?: unknown; createdAt?: unknown };
            if (typeof lesson?.text !== "string" || !lesson.text.trim()) continue;
            const createdAtMs = Date.parse(typeof lesson.createdAt === "string" ? lesson.createdAt : "");
            if (Number.isFinite(createdAtMs) && now - createdAtMs > AUTO_TTL_MS) continue;
            const date = Number.isFinite(createdAtMs)
              ? new Date(createdAtMs).toISOString().slice(0, 10)
              : todayStamp();
            const runId = typeof lesson.runId === "string" ? lesson.runId : "";
            const outcome = addBullets(file, [lesson.text], (text) => autoBulletRaw(text, date, runId));
            imported += outcome.added + outcome.replaced;
          }
          if (imported === 0) return;
          evictAutosUntilFit(file);
          if (fileBytes(file) <= MEMORY_FILE_MAX_BYTES) {
            await writeMemoryFile("workspace", workspaceId, file);
          }
        });
      }
    }
    renameSync(legacyPath, `${legacyPath}.bak`);
  } catch (err) {
    console.warn("[cora-memory] lessons.json migration failed:", err);
  }
}

// ── auto-eviction ───────────────────────────────────────────────────────────

/**
 * Evict oldest [auto] bullets (unparseable dates count as newest, so they go
 * last) until the file fits the hard cap or no [auto] bullets remain. Only the
 * auto tier is evictable: [cora] lines were deliberate and user lines are
 * untouchable.
 */
function evictAutosUntilFit(file: MemoryFile): void {
  while (fileBytes(file) > MEMORY_FILE_MAX_BYTES) {
    let oldestIndex = -1;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (let i = 0; i < file.lines.length; i += 1) {
      const line = file.lines[i];
      if (line.kind !== "auto") continue;
      const created = Date.parse(line.tag?.date ?? "");
      const time = Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER;
      if (oldestIndex === -1 || time < oldestTime) {
        oldestIndex = i;
        oldestTime = time;
      }
    }
    if (oldestIndex === -1) return;
    file.lines.splice(oldestIndex, 1);
  }
}

// ── injection ───────────────────────────────────────────────────────────────

/** Truncate to a byte budget without splitting a UTF-8 sequence. */
function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

interface RenderedTier {
  body: string;
  footer: string | null;
}

/**
 * One tier's injected body: the raw file with expired tagged lines filtered
 * (read side only; the file is not rewritten), truncated at the hard cap with
 * a visible notice. Returns null when the file is missing or has no content
 * beyond the managed header.
 */
function renderTier(path: string, now: number): RenderedTier | null {
  const file = readMemoryFile(path);
  if (!file) return null;
  const filtered = withoutExpired(file, now);
  if (!filtered.lines.some((line) => line.kind !== "blank")) return null;
  let body = serializeMemoryFile(filtered).trimEnd();
  if (body.length === 0) return null;
  if (Buffer.byteLength(body, "utf8") > MEMORY_FILE_MAX_BYTES) {
    body = `${truncateUtf8(body, MEMORY_FILE_MAX_BYTES)}\n${MEMORY_TRUNCATION_NOTICE}`;
  }
  const usedBytes = fileBytes(file);
  // Boundary is >= so the footer and the renderer's "nearly full" warning
  // (AgentCapabilitiesDialog's ceil(cap * 0.8) threshold) flip at 3277 together.
  const footer =
    usedBytes >= MEMORY_FILE_SOFT_BYTES
      ? memorySoftCapFooter(usedBytes, MEMORY_FILE_MAX_BYTES)
      : null;
  return { body, footer };
}

function renderMemorySections(workspaceId: string, now: number): string | null {
  const state = readState();
  // Global disabled is the master off switch: nothing is injected at all.
  if (!state.globalEnabled) return null;
  const sections: string[] = [];
  const globalTier = renderTier(globalMemoryPath(), now);
  if (globalTier) {
    sections.push(
      `CORA MEMORY, GLOBAL (user-editable file: ${globalMemoryPath()}; applies to every workspace; apply unless this run's own evidence contradicts it)`,
      globalTier.body,
      ...(globalTier.footer ? [globalTier.footer] : []),
      "[END CORA MEMORY GLOBAL]",
    );
  }
  if (tierEnabled(state, "workspace", workspaceId)) {
    const workspaceTier = renderTier(workspaceMemoryPath(workspaceId), now);
    if (workspaceTier) {
      sections.push(
        `CORA MEMORY, THIS WORKSPACE (user-editable file: ${workspaceMemoryPath(workspaceId)}; overrides the global section on conflict)`,
        workspaceTier.body,
        ...(workspaceTier.footer ? [workspaceTier.footer] : []),
        "[END CORA MEMORY WORKSPACE]",
      );
    }
  }
  return sections.length > 0 ? sections.join("\n") : null;
}

// Injection is hash-gated once per run, not per turn: the section is injected
// on the first manager turn of a run and re-injected only when the rendered
// bytes change (a write landed, the user edited a file, a toggle flipped) or
// when the caller forces it (canonical replay after a rewind rebuilds the CLI
// session, which lost the earlier injection). Same bounded LRU shape as
// loadRunManagerGuidance in spark-agent-backend.ts. Each entry keeps the hash
// recorded before it (one level), so a turn whose prompt was never accepted by
// the provider can be rolled back and the retry injects again.
interface RunMemoryInjection {
  hash: string;
  prior?: string;
}
const runMemoryHashes = new Map<string, RunMemoryInjection>();
const RUN_MEMORY_HASH_LIMIT = 64;

function touchInjectedHash(runId: string, entry: RunMemoryInjection): void {
  runMemoryHashes.delete(runId);
  runMemoryHashes.set(runId, entry);
  while (runMemoryHashes.size > RUN_MEMORY_HASH_LIMIT) {
    const oldest = runMemoryHashes.keys().next();
    if (oldest.done) break;
    runMemoryHashes.delete(oldest.value);
  }
}

/**
 * Roll back the last recorded injection for a run. Called from run-store when
 * a manager turn fails BEFORE the provider accepted its prompt: that turn's
 * rendered memory never reached the session, so the retry must inject again.
 * Mirrors canonical replay's ownership semantics (a failed pre-submission
 * attempt does not consume the injection). One level of history is enough:
 * only one manager turn is in flight per run.
 */
export function releaseCoraMemoryInjection(runId: string): void {
  const entry = runMemoryHashes.get(runId);
  if (!entry) return;
  if (entry.prior === undefined) runMemoryHashes.delete(runId);
  else runMemoryHashes.set(runId, { hash: entry.prior });
}

/**
 * The injection seam called from run-store's prepareManagerTurn. Returns the
 * rendered CORA MEMORY sections for the dynamic tail of this turn, or null
 * when there is nothing to inject or the unchanged content was already
 * injected earlier in this run.
 */
export async function formatCoraMemoryForTurn(
  workspaceId: string,
  runId: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  await ensureMigrated();
  const rendered = renderMemorySections(workspaceId, Date.now());
  if (rendered === null) return null;
  const hash = createHash("sha256").update(rendered).digest("hex");
  const existing = runMemoryHashes.get(runId);
  if (existing?.hash === hash && !opts?.force) {
    // Already carried by this run's session. Refresh the LRU position only;
    // recording nothing keeps a later releaseCoraMemoryInjection able to roll
    // back the injection that actually happened.
    touchInjectedHash(runId, existing);
    return null;
  }
  touchInjectedHash(runId, { hash, prior: existing?.hash });
  return rendered;
}

// ── write paths ─────────────────────────────────────────────────────────────

/**
 * Run-completion auto-emitter seam (workspace-lessons.ts). Writes
 * [auto <today> run:<runId>] bullets with dedup and TTL pruning; on overflow
 * it evicts expired then oldest [auto] bullets, and whatever still cannot fit
 * is silently dropped. Fire-and-forget: never throws, and a disabled tier
 * writes nothing.
 */
export async function appendAutoMemories(
  workspaceId: string,
  texts: string[],
  runId: string,
): Promise<void> {
  try {
    await ensureMigrated();
    if (!workspaceId || texts.length === 0) return;
    const state = readState();
    if (!tierEnabled(state, "workspace", workspaceId)) return;
    await withPathLock(tierPath("workspace", workspaceId), async () => {
      const file = loadForWrite("workspace", workspaceId);
      const date = todayStamp();
      pruneExpired(file, Date.now());
      const outcome = addBullets(file, texts, (text) => autoBulletRaw(text, date, runId));
      if (outcome.added + outcome.replaced === 0) return;
      evictAutosUntilFit(file);
      // Still over cap after evicting every [auto] line means cora/user content
      // fills the file; the incoming auto lessons are dropped rather than
      // truncating anything the app does not own.
      if (fileBytes(file) > MEMORY_FILE_MAX_BYTES) return;
      await writeMemoryFile("workspace", workspaceId, file);
    });
  } catch (err) {
    console.warn("[cora-memory] failed to append auto memories:", err);
  }
}

/**
 * codara_remember action "add". Stamps each bullet [cora <today>], dedups
 * (replace-in-place against tagged lines, "already known" against user lines),
 * prunes expired, and REJECTS on overflow with the exact consolidate-first
 * error. Throws Error with the contract strings; the RPC layer forwards them
 * as tool errors.
 */
export async function rememberAdd(
  scope: MemoryScope,
  workspaceId: string,
  bullets: string[],
  _runId: string,
): Promise<RememberResult> {
  await ensureMigrated();
  const state = readState();
  if (!tierEnabled(state, scope, workspaceId)) {
    throw new Error(memoryDisabledError(scope));
  }
  return withPathLock(tierPath(scope, workspaceId), async () => {
    const file = loadForWrite(scope, workspaceId);
    const date = todayStamp();
    pruneExpired(file, Date.now());
    const outcome = addBullets(file, bullets, (text) => coraBulletRaw(text, date));
    const bytesUsed = fileBytes(file);
    if (bytesUsed > MEMORY_FILE_MAX_BYTES) {
      throw new Error(memoryFullError(bytesUsed, MEMORY_FILE_MAX_BYTES));
    }
    if (outcome.added + outcome.replaced > 0) {
      await writeMemoryFile(scope, workspaceId, file);
    }
    const parts: string[] = [];
    if (outcome.added > 0) parts.push(`added ${outcome.added}`);
    if (outcome.replaced > 0) parts.push(`updated ${outcome.replaced}`);
    if (outcome.alreadyKnown > 0) parts.push(`${outcome.alreadyKnown} already known`);
    return {
      bytesUsed,
      bytesCap: MEMORY_FILE_MAX_BYTES,
      message: parts.length > 0 ? `Memory updated (${parts.join(", ")}).` : "Nothing to remember.",
    };
  });
}

/** Whitespace-normalized text a preservation check compares lines by. */
function preservationKey(line: MemoryLine): string | null {
  if (line.kind !== "user") return null;
  const text = (line.bulletText ?? line.raw).replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}

/**
 * codara_remember action "replace": the consolidation path. The new body
 * becomes the whole file (header regenerated), with three guardrails:
 *
 *  - every user-authored line of the CURRENT file must reappear in the new
 *    body AS a user-kind line (whitespace-normalized exact match). Reappearing
 *    under an [auto]/[cora] tag does NOT count: that would launder the user's
 *    line into a Cora-owned one the next prune could expire. Missing lines
 *    reject the call, unless confirmDropUserLines, which the manager may only
 *    set when the user explicitly asked for the removal;
 *  - any NEW untagged bullet line is auto-stamped [cora <today>] so Cora
 *    cannot mint user-owned bullets it would then be forbidden to curate;
 *  - any NEW non-bullet line (prose, heading, comment, fence) is rejected
 *    outright: those cannot carry a tag under the grammar, so letting Cora
 *    write them would create immortal Cora-authored content.
 */
export async function rememberReplace(
  scope: MemoryScope,
  workspaceId: string,
  body: string,
  confirmDropUserLines: boolean,
  _runId: string,
): Promise<RememberResult> {
  await ensureMigrated();
  const state = readState();
  if (!tierEnabled(state, scope, workspaceId)) {
    throw new Error(memoryDisabledError(scope));
  }
  const path = tierPath(scope, workspaceId);
  return withPathLock(path, async () => {
    const current = readMemoryFile(path);
    const next = parseMemoryFile(body);
    const date = todayStamp();

    const currentUserKeys = new Set<string>();
    for (const line of current?.lines ?? []) {
      const key = preservationKey(line);
      if (key) currentUserKeys.add(key);
    }

    // Walk the body once: stamp new untagged bullets, collect the keys that
    // reappear as user-kind lines (the only form that counts as preserved),
    // and catch minted non-bullet lines.
    const nextUserKeys = new Set<string>();
    const mintedNonBullets: string[] = [];
    for (let i = 0; i < next.lines.length; i += 1) {
      const line = next.lines[i];
      if (line.kind !== "user") continue;
      const text = (line.bulletText ?? line.raw).replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (line.bulletText !== undefined) {
        // Untagged bullet: the user's if it matches a current user line
        // verbatim, otherwise it is new and gets Cora's stamp.
        if (currentUserKeys.has(text)) nextUserKeys.add(text);
        else next.lines[i] = parseLine(coraBulletRaw(cleanBulletText(line.bulletText), date));
      } else {
        if (currentUserKeys.has(text)) nextUserKeys.add(text);
        else mintedNonBullets.push(text);
      }
    }

    if (mintedNonBullets.length > 0) {
      throw new Error(
        `only bullet lines may be added by Cora; prose and headings belong to the user. New non-bullet lines in the body:\n` +
          mintedNonBullets.map((line) => `  ${line}`).join("\n"),
      );
    }

    const missing = [...currentUserKeys].filter((key) => !nextUserKeys.has(key));
    if (missing.length > 0 && !confirmDropUserLines) {
      throw new Error(
        `replace would drop these user-authored lines (a user line must reappear untagged; carrying its text under an [auto]/[cora] tag counts as dropping it):\n` +
          missing.map((line) => `  ${line}`).join("\n") +
          `\nInclude them in the new body verbatim, or pass confirm_drop_user_lines: true only if the user asked for the removal.`,
      );
    }

    const bytesUsed = fileBytes({ ...next, headerLines: buildHeader(scope, workspaceId) });
    if (bytesUsed > MEMORY_FILE_MAX_BYTES) {
      const userBytes = Buffer.byteLength(
        next.lines
          .filter((line) => line.kind === "user")
          .map((line) => line.raw)
          .join("\n"),
        "utf8",
      );
      if (userBytes > MEMORY_FILE_MAX_BYTES) {
        throw new Error(userLinesExceedCapError(path));
      }
      throw new Error(memoryFullError(bytesUsed, MEMORY_FILE_MAX_BYTES));
    }

    await writeMemoryFile(scope, workspaceId, next);
    return {
      bytesUsed,
      bytesCap: MEMORY_FILE_MAX_BYTES,
      message:
        missing.length > 0
          ? `Memory rewritten; dropped ${missing.length} user-authored line(s) with confirmation.`
          : "Memory rewritten.",
    };
  });
}

// ── status / toggles / clearing ─────────────────────────────────────────────

function tierStatus(state: MemoryState, scope: MemoryScope, workspaceId: string | null): MemoryTierStatus {
  // No active workspace: the workspace tier has no backing file yet, so it
  // reports disabled with an empty path (the renderer's documented contract).
  if (scope === "workspace" && workspaceId === null) {
    return {
      enabled: false,
      path: "",
      bytesUsed: 0,
      bytesCap: MEMORY_FILE_MAX_BYTES,
      overCap: false,
      counts: { user: 0, cora: 0, auto: 0 },
    };
  }
  const path = scope === "global" ? globalMemoryPath() : workspaceMemoryPath(workspaceId as string);
  const file = readMemoryFile(path);
  const counts = { user: 0, cora: 0, auto: 0 };
  for (const line of file?.lines ?? []) {
    if (line.kind === "user") counts.user += 1;
    else if (line.kind === "cora") counts.cora += 1;
    else if (line.kind === "auto") counts.auto += 1;
  }
  const bytesUsed = file ? fileBytes(file) : 0;
  return {
    enabled: tierEnabled(state, scope, workspaceId ?? ""),
    path,
    bytesUsed,
    bytesCap: MEMORY_FILE_MAX_BYTES,
    overCap: bytesUsed > MEMORY_FILE_MAX_BYTES,
    counts,
  };
}

export async function getMemoryStatus(workspaceId: string | null): Promise<MemoryStatus> {
  await ensureMigrated();
  const state = readState();
  return {
    global: tierStatus(state, "global", workspaceId),
    workspace: tierStatus(state, "workspace", workspaceId),
  };
}

export async function setMemoryEnabled(
  scope: MemoryScope,
  workspaceId: string | null,
  enabled: boolean,
): Promise<void> {
  await ensureMigrated();
  if (scope === "workspace" && workspaceId === null) {
    throw new Error("workspace scope requires a workspaceId");
  }
  await withPathLock(statePath(), async () => {
    const state = readState();
    if (scope === "global") {
      state.globalEnabled = enabled;
    } else {
      state.workspaces[workspaceId as string] = { enabled };
    }
    await mkdir(memoryRoot(), { recursive: true });
    await writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  });
}

/**
 * Default: remove only Cora's [auto]/[cora] lines, keeping every user line.
 * includeUserLines rewrites the file to the fresh template (the one action
 * allowed to discard user content; it is user-initiated from the UI).
 * Works regardless of toggles: clearing disabled memory must still be possible.
 */
export async function clearMemory(
  scope: MemoryScope,
  workspaceId: string | null,
  includeUserLines: boolean,
): Promise<void> {
  await ensureMigrated();
  if (scope === "workspace" && workspaceId === null) {
    throw new Error("workspace scope requires a workspaceId");
  }
  const wsId = workspaceId ?? "";
  await withPathLock(tierPath(scope, wsId), async () => {
    if (includeUserLines) {
      await writeMemoryFile(scope, wsId, templateFile(scope, wsId));
      return;
    }
    const file = readMemoryFile(tierPath(scope, wsId));
    if (!file) return;
    file.lines = file.lines.filter((line) => line.kind !== "auto" && line.kind !== "cora");
    await writeMemoryFile(scope, wsId, file);
  });
}

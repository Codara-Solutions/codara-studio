import { existsSync, readFileSync, renameSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { codaraHome } from "../codara-home";
import { writeFileAtomic } from "../fs-atomic";
import {
  coraProfileRoot,
  DEFAULT_CORA_PROFILE_ID,
  formatCoraProfileForTurn,
  normalizeCoraProfileId,
  resolveCoraProfile,
} from "./cora-profiles";
import { containsSecret, isCoreMemoryItem } from "@shared/memory-items";
import { listMemoryItems, markMemoryItemsUsed, renderLearnedMemory, selectLearnedMemory } from "./memory-items";

// Cora memory v2: curated semantic guidance, two markdown tiers.
//
//   ~/.codarastudio/memory/MEMORY.md                    default profile global tier
//   ~/.codarastudio/memory/workspaces/<id>.md           default profile workspace tier
//   ~/.codarastudio/memory/profiles/<profile>/...       named isolated profiles
//   ~/.codarastudio/memory/memory-state.json            the enable/disable toggles
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
// the byte cap. Tagged bullets belong to Cora and may be pruned or rewritten.
// Only [auto] bullets expire: a [cora] line is something the user said or Cora
// deliberately curated, so it stays until a consolidation or the user drops it.
//
// Writers: manager and direct Cora chats (via codara_remember), plus the
// run-completion auto-emitters (workspace-lessons.ts -> appendAutoMemories).
// Delegated workers receive read-only injection and report new lessons for
// Cora to curate; automation workers receive no memory injection.
//
// run-memory.ts is untouched and never merged into this module: that file is
// the episodic outcome ledger (distilled fingerprints of finished runs), this
// one is curated semantic guidance. They serve different prompts and different
// TTL/curation policies.
//
// This module imports only spark-home, fs-atomic, cora-profiles, the learned
// item store (memory-items.ts, which never imports back) and the pure shared
// memory helpers, never run-store or manager-protocol, so there is no import
// cycle and no cross-dependency on the IPC/tool-definition side.
//
// Memory v3 adds learned items under these files. The files stay the
// always-injected core; formatCoraMemoryForTurn appends the learned items
// that matter for the turn, within a fixed budget, and sends each one at most
// once per session.

// ── constants ───────────────────────────────────────────────────────────────

/** Hard byte cap per memory file. Injection truncates here; adds reject. */
export const MEMORY_FILE_MAX_BYTES = 4096;
/** Soft cap: the injected section grows a consolidation footer past this. */
export const MEMORY_FILE_SOFT_BYTES = 3277;
/** Auto bullets are ellipsis-truncated here; codara_remember rejects longer ones. */
export const MAX_BULLET_LENGTH = 500;
/** codara_remember call budget per manager turn (counted at the agent-socket handler). */
export const MAX_REMEMBER_CALLS_PER_RUN = 5;
/** Per-turn cap on bullets added via codara_remember (agent-socket handler). */
export const MAX_BULLETS_ADDED_PER_RUN = 10;

const AUTO_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The global template's starter heading. The app wrote it, so it never counts
// as a line the user authored (status counts, replace preservation).
const TEMPLATE_HEADING = "## About the user";

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

/**
 * What the codara_remember budget is counted against. The budget stops a
 * runaway write loop inside one manager turn, not memory over a chat's whole
 * life (a chat is one run that can last weeks), so each user message starts a
 * fresh budget.
 */
export function rememberBudgetKey(run: {
  id: string;
  humanMessages?: ReadonlyArray<{ id: string; author: string }>;
}): string {
  const messages = run.humanMessages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].author === "user") return `${run.id}:${messages[i].id}`;
  }
  return run.id;
}

export function bulletTooLongError(index: number, length: number): string {
  return (
    `bullet ${index} is ${length} characters; the limit is ${MAX_BULLET_LENGTH}. ` +
    `Nothing was saved: shorten it and call codara_remember again`
  );
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
  // The tier's own switch is on, but the profile's global switch is off and
  // overrides it, so `enabled` reports false.
  blockedByGlobal: boolean;
  path: string;
  bytesUsed: number;
  bytesCap: number;
  overCap: boolean;
  counts: { user: number; cora: number; auto: number };
}

export interface MemoryStatus {
  profile: { id: string; name: string; identityPath: string; isDefault: boolean };
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
  profileGlobals: Record<string, { enabled: boolean }>;
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
  return join(codaraHome(), "memory");
}

// Strip path separators and other unsafe characters so a workspaceId can never
// escape the memory dir or collide with a control character. Falls back to a
// stable placeholder when sanitizing empties the value. Copied from
// run-memory.ts (not imported: the two modules must stay decoupled).
function sanitize(workspaceId: string): string {
  const cleaned = workspaceId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "_unknown";
}

export function globalMemoryPath(profileId = DEFAULT_CORA_PROFILE_ID): string {
  return join(coraProfileRoot(profileId), "MEMORY.md");
}

export function workspaceMemoryPath(
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
): string {
  return join(coraProfileRoot(profileId), "workspaces", `${sanitize(workspaceId)}.md`);
}

function statePath(): string {
  return join(memoryRoot(), "memory-state.json");
}

// Null prototype so a hostile "__proto__" workspace id lands as an ordinary
// own property instead of mutating a prototype (same as workspace-lessons had).
function emptyWorkspaceToggles(): Record<string, { enabled: boolean }> {
  return Object.create(null) as Record<string, { enabled: boolean }>;
}

function profileWorkspaceKey(profileId: string, workspaceId: string): string {
  const id = normalizeCoraProfileId(profileId);
  return id === DEFAULT_CORA_PROFILE_ID ? workspaceId : `profile:${id}:workspace:${workspaceId}`;
}

/** Missing file / missing fields read as enabled. */
function readState(): MemoryState {
  const fallback: MemoryState = {
    version: 1,
    globalEnabled: true,
    workspaces: emptyWorkspaceToggles(),
    profileGlobals: emptyWorkspaceToggles(),
  };
  const path = statePath();
  if (!existsSync(path)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MemoryState>;
    const workspaces = emptyWorkspaceToggles();
    const profileGlobals = emptyWorkspaceToggles();
    if (raw.workspaces && typeof raw.workspaces === "object" && !Array.isArray(raw.workspaces)) {
      for (const [id, entry] of Object.entries(raw.workspaces)) {
        if (entry && typeof entry === "object" && typeof entry.enabled === "boolean") {
          workspaces[id] = { enabled: entry.enabled };
        }
      }
    }
    if (raw.profileGlobals && typeof raw.profileGlobals === "object" && !Array.isArray(raw.profileGlobals)) {
      for (const [id, entry] of Object.entries(raw.profileGlobals)) {
        if (entry && typeof entry === "object" && typeof entry.enabled === "boolean") {
          profileGlobals[normalizeCoraProfileId(id)] = { enabled: entry.enabled };
        }
      }
    }
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      globalEnabled: raw.globalEnabled !== false,
      workspaces,
      profileGlobals,
    };
  } catch {
    return fallback;
  }
}

function tierEnabled(
  state: MemoryState,
  scope: MemoryScope,
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
): boolean {
  // The global toggle is the master switch: a disabled global tier disables
  // memory outright, including per-workspace files (see formatCoraMemoryForTurn).
  const id = normalizeCoraProfileId(profileId);
  const globalEnabled = id === DEFAULT_CORA_PROFILE_ID
    ? state.globalEnabled
    : state.profileGlobals[id]?.enabled !== false;
  if (!globalEnabled) return false;
  if (scope === "global") return true;
  return state.workspaces[profileWorkspaceKey(id, workspaceId)]?.enabled !== false;
}

/** Whether a tier is switched on, for readers outside this module (the prior
 * runs ledger in run-memory.ts honors the same switches). */
export function isMemoryEnabled(
  scope: MemoryScope,
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
): boolean {
  return tierEnabled(readState(), scope, workspaceId, profileId);
}

// ── workspace metadata for the header (best-effort) ─────────────────────────

// The header names the workspace and its cwd so a user browsing
// ~/.codarastudio/memory/workspaces can tell the files apart. Resolved from
// spark-state.json (the persisted AppState) purely best-effort: a missing or
// unreadable state file degrades to the raw workspaceId.
function resolveWorkspaceMeta(workspaceId: string): { name: string; cwd: string } {
  try {
    const raw = JSON.parse(readFileSync(join(codaraHome(), "spark-state.json"), "utf8")) as {
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

function buildHeader(
  scope: MemoryScope,
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
): string[] {
  const profile = resolveCoraProfile(profileId);
  if (scope === "global") {
    return [
      profile.id === DEFAULT_CORA_PROFILE_ID
        ? "# Cora memory (global)"
        : `# Cora memory (profile: ${profile.name})`,
      "<!-- Managed by Cora; applies to every workspace. Edit freely in the editor; keep it under 4 KB.",
      ...HEADER_OWNERSHIP_LINES,
    ];
  }
  const meta = resolveWorkspaceMeta(workspaceId);
  return [
    profile.id === DEFAULT_CORA_PROFILE_ID
      ? `# Cora memory (workspace: ${meta.name})`
      : `# Cora memory (profile: ${profile.name}, workspace: ${meta.name})`,
    `<!-- cwd: ${meta.cwd}`,
    "     Managed by Cora. Edit freely in the editor; keep it under 4 KB.",
    ...HEADER_OWNERSHIP_LINES,
  ];
}

/** Fresh-file template. The global variant suggests a starting heading. */
function templateFile(
  scope: MemoryScope,
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
): MemoryFile {
  const lines: MemoryLine[] =
    scope === "global"
      ? [
          { raw: "", kind: "blank" },
          { raw: TEMPLATE_HEADING, kind: "user" },
          { raw: "", kind: "blank" },
        ]
      : [{ raw: "", kind: "blank" }];
  return { headerLines: buildHeader(scope, workspaceId, profileId), lines };
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
  if (line.tag?.source !== "auto") return false;
  const created = Date.parse(line.tag.date);
  if (!Number.isFinite(created)) return false;
  return now - created > AUTO_TTL_MS;
}

/** The bare starter heading the app wrote; anything the user typed counts. */
function isTemplateHeading(line: MemoryLine): boolean {
  return line.kind === "user" && line.raw.trim() === TEMPLATE_HEADING;
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

function collapseBulletText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Collapse whitespace and cap at MAX_BULLET_LENGTH with an ellipsis. */
function cleanBulletText(value: string): string {
  const collapsed = collapseBulletText(value);
  if (collapsed.length <= MAX_BULLET_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_BULLET_LENGTH - 1)}…`;
}

export function secretInMemoryError(index: number): string {
  return (
    `bullet ${index} looks like a password, token or key. Memory is pasted into every future prompt, ` +
    `so it never stores secrets. Nothing was saved`
  );
}

function assertNoSecrets(texts: string[]): void {
  texts.forEach((text, index) => {
    if (containsSecret(text)) throw new Error(secretInMemoryError(index + 1));
  });
}

// codara_remember never truncates: a cut-off memory loses its actionable tail
// while the tool reports success, so an overlong bullet fails the whole call
// before anything is written and Cora retries with a shorter sentence.
function assertBulletsFit(texts: string[]): void {
  texts.forEach((text, index) => {
    const length = collapseBulletText(text).length;
    if (length > MAX_BULLET_LENGTH) throw new Error(bulletTooLongError(index + 1, length));
  });
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
async function writeMemoryFile(
  scope: MemoryScope,
  workspaceId: string,
  file: MemoryFile,
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<void> {
  file.headerLines = buildHeader(scope, workspaceId, profileId);
  const path = scope === "global"
    ? globalMemoryPath(profileId)
    : workspaceMemoryPath(workspaceId, profileId);
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
function loadForWrite(
  scope: MemoryScope,
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
): MemoryFile {
  const path = scope === "global"
    ? globalMemoryPath(profileId)
    : workspaceMemoryPath(workspaceId, profileId);
  const file = readMemoryFile(path) ?? templateFile(scope, workspaceId, profileId);
  file.headerLines = buildHeader(scope, workspaceId, profileId);
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

function tierPath(
  scope: MemoryScope,
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
): string {
  return scope === "global"
    ? globalMemoryPath(profileId)
    : workspaceMemoryPath(workspaceId, profileId);
}

// ── migration from ~/.codarastudio/lessons.json ───────────────────────────────────

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
  const legacyPath = join(codaraHome(), "lessons.json");
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

interface RenderedMemory {
  /** PROFILE plus the markdown tiers, or null when there is none. */
  core: string | null;
  globalEnabled: boolean;
  workspaceEnabled: boolean;
}

function renderMemory(
  workspaceId: string,
  now: number,
  profileId = DEFAULT_CORA_PROFILE_ID,
): RenderedMemory {
  const state = readState();
  const sections: string[] = [];
  // The profile is identity, not memory: the memory switches never hide it.
  const profileSection = formatCoraProfileForTurn(profileId);
  if (profileSection) sections.push(profileSection);
  // Global disabled is the master off switch for memory: no tier is injected.
  if (!tierEnabled(state, "global", workspaceId, profileId)) {
    return { core: sections.length > 0 ? sections.join("\n") : null, globalEnabled: false, workspaceEnabled: false };
  }
  const profile = resolveCoraProfile(profileId);
  const globalPath = globalMemoryPath(profileId);
  const globalTier = renderTier(globalPath, now);
  if (globalTier) {
    sections.push(
      profile.id === DEFAULT_CORA_PROFILE_ID
        ? `CORA MEMORY, GLOBAL (user-editable file: ${globalPath}; applies to every workspace; apply unless this run's own evidence contradicts it)`
        : `CORA MEMORY, PROFILE GLOBAL (user-editable file: ${globalPath}; applies to every workspace for this profile; apply unless this run's own evidence contradicts it)`,
      globalTier.body,
      ...(globalTier.footer ? [globalTier.footer] : []),
      "[END CORA MEMORY GLOBAL]",
    );
  }
  const workspaceEnabled = tierEnabled(state, "workspace", workspaceId, profileId);
  if (workspaceEnabled) {
    const workspacePath = workspaceMemoryPath(workspaceId, profileId);
    const workspaceTier = renderTier(workspacePath, now);
    if (workspaceTier) {
      sections.push(
        profile.id === DEFAULT_CORA_PROFILE_ID
          ? `CORA MEMORY, THIS WORKSPACE (user-editable file: ${workspacePath}; overrides the global section on conflict)`
          : `CORA MEMORY, THIS WORKSPACE (user-editable file: ${workspacePath}; overrides profile-global memory on conflict)`,
        workspaceTier.body,
        ...(workspaceTier.footer ? [workspaceTier.footer] : []),
        "[END CORA MEMORY WORKSPACE]",
      );
    }
  }
  return { core: sections.length > 0 ? sections.join("\n") : null, globalEnabled: true, workspaceEnabled };
}

/** Read-only context for a worker prompt (and its re-send after a worker
 * compaction). Unlike manager injection it is not gated per session: every
 * worker starts with a fresh context. `query` is the task text the learned
 * items are ranked against. */
export function formatCoraMemoryForWorker(
  workspaceId: string,
  profileId = DEFAULT_CORA_PROFILE_ID,
  query = "",
): string | null {
  const rendered = renderMemory(workspaceId, Date.now(), profileId);
  let learned: string | null = null;
  try {
    const selection = selectLearnedMemory({
      profileId,
      workspaceId,
      query,
      includeGlobal: rendered.globalEnabled,
      includeWorkspace: rendered.workspaceEnabled,
      coreText: rendered.core ?? "",
    });
    learned = renderLearnedMemory(selection);
    markMemoryItemsUsed(profileId, [...selection.core, ...selection.relevant].map((item) => item.id));
  } catch {
    learned = null;
  }
  const parts = [rendered.core, learned].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n") : null;
}

// Injection is hash-gated once per run, not per turn: the section is injected
// on the first manager turn of a run and re-injected only when the rendered
// bytes change (a write landed, the user edited a file, a toggle flipped) or
// when the caller forces it (canonical replay after a rewind rebuilds the CLI
// session, which lost the earlier injection). Same bounded LRU shape as
// loadRunManagerGuidance in agent-backend.ts. Each entry keeps the hash
// recorded before it (one level), so a turn whose prompt was never accepted by
// the provider can be rolled back and the retry injects again.
interface RunMemoryInjection {
  hash: string;
  prior?: string;
  /** Learned item id -> text this session already carries. */
  learned: Map<string, string>;
  priorLearned?: Map<string, string>;
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
  if (entry.prior === undefined && entry.priorLearned === undefined) runMemoryHashes.delete(runId);
  else runMemoryHashes.set(runId, { hash: entry.prior ?? "", learned: entry.priorLearned ?? new Map() });
}

/**
 * Forget that a run's session carries the memory sections, so the next manager
 * turn injects them again. Called when an in-session compaction summarized
 * the turn that carried them, which the run cannot otherwise notice (a
 * replaced session is covered by canonical replay's force instead). Unlike
 * releaseCoraMemoryInjection this keeps no history to roll back to.
 */
export function resetCoraMemoryInjection(runId: string): void {
  runMemoryHashes.delete(runId);
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
  opts?: { force?: boolean; profileId?: string; query?: string },
): Promise<string | null> {
  await ensureMigrated();
  const profileId = opts?.profileId ?? DEFAULT_CORA_PROFILE_ID;
  const rendered = renderMemory(workspaceId, Date.now(), profileId);
  const existing = runMemoryHashes.get(runId);
  const force = opts?.force === true;
  const carried = force ? new Map<string, string>() : new Map(existing?.learned ?? []);

  // The learned block is a delta: each item reaches a session once (again
  // only if its text changed), so a long chat does not re-paste the same
  // memories every turn, and a compaction or replay (force) starts over.
  let learnedBlock: string | null = null;
  let learnedIds: string[] = [];
  try {
    const selection = selectLearnedMemory({
      profileId,
      workspaceId,
      query: opts?.query ?? "",
      includeGlobal: rendered.globalEnabled,
      includeWorkspace: rendered.workspaceEnabled,
      coreText: rendered.core ?? "",
    });
    const fresh = {
      core: selection.core.filter((item) => carried.get(item.id) !== item.text),
      relevant: selection.relevant.filter((item) => carried.get(item.id) !== item.text),
    };
    const resent = new Set([...fresh.core, ...fresh.relevant].map((item) => item.id));
    // A delta only adds, so an item the session already carries keeps
    // applying until it is withdrawn in so many words: one the user deleted,
    // one a newer statement replaced, or every item once memory is switched
    // off. Without this a deleted memory stays in force until the next
    // compaction. One the user reworded is sent again in its new words.
    const inForce = new Map(
      listMemoryItems(profileId, { workspaceId })
        .filter((item) => item.status === "active" &&
          (item.scope === "global" ? rendered.globalEnabled : rendered.workspaceEnabled))
        .map((item) => [item.id, item]),
    );
    const retracted: Array<{ id: string; text: string }> = [];
    for (const [id, text] of carried) {
      if (resent.has(id)) continue;
      const current = inForce.get(id);
      if (current?.text === text) continue;
      if (current) {
        (isCoreMemoryItem(current) ? fresh.core : fresh.relevant).push(current);
        continue;
      }
      retracted.push({ id, text });
      carried.delete(id);
    }
    learnedBlock = renderLearnedMemory(fresh, { delta: carried.size > 0 || retracted.length > 0, retracted });
    for (const item of [...fresh.core, ...fresh.relevant]) carried.set(item.id, item.text);
    learnedIds = [...fresh.core, ...fresh.relevant].map((item) => item.id);
  } catch {
    learnedBlock = null;
  }

  const hash = rendered.core === null ? "" : createHash("sha256").update(rendered.core).digest("hex");
  const coreChanged = rendered.core !== null && (existing?.hash !== hash || force);
  if (!coreChanged && learnedBlock === null) {
    // Already carried by this run's session. Refresh the LRU position only;
    // recording nothing keeps a later releaseCoraMemoryInjection able to roll
    // back the injection that actually happened.
    if (existing) touchInjectedHash(runId, existing);
    return null;
  }
  touchInjectedHash(runId, {
    hash: rendered.core === null ? existing?.hash ?? "" : hash,
    prior: existing?.hash,
    learned: carried,
    priorLearned: existing ? new Map(existing.learned) : undefined,
  });
  markMemoryItemsUsed(profileId, learnedIds);
  const parts = [coreChanged ? rendered.core : null, learnedBlock].filter((part): part is string => Boolean(part));
  return parts.join("\n");
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
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<void> {
  try {
    await ensureMigrated();
    if (!workspaceId || texts.length === 0) return;
    const state = readState();
    if (!tierEnabled(state, "workspace", workspaceId, profileId)) return;
    await withPathLock(tierPath("workspace", workspaceId, profileId), async () => {
      const file = loadForWrite("workspace", workspaceId, profileId);
      const date = todayStamp();
      pruneExpired(file, Date.now());
      const outcome = addBullets(file, texts, (text) => autoBulletRaw(text, date, runId));
      if (outcome.added + outcome.replaced === 0) return;
      evictAutosUntilFit(file);
      // Still over cap after evicting every [auto] line means cora/user content
      // fills the file; the incoming auto lessons are dropped rather than
      // truncating anything the app does not own.
      if (fileBytes(file) > MEMORY_FILE_MAX_BYTES) return;
      await writeMemoryFile("workspace", workspaceId, file, profileId);
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
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<RememberResult> {
  await ensureMigrated();
  const state = readState();
  if (!tierEnabled(state, scope, workspaceId, profileId)) {
    throw new Error(memoryDisabledError(scope));
  }
  assertBulletsFit(bullets);
  assertNoSecrets(bullets);
  return withPathLock(tierPath(scope, workspaceId, profileId), async () => {
    const file = loadForWrite(scope, workspaceId, profileId);
    const date = todayStamp();
    pruneExpired(file, Date.now());
    const outcome = addBullets(file, bullets, (text) => coraBulletRaw(text, date));
    const bytesUsed = fileBytes(file);
    if (bytesUsed > MEMORY_FILE_MAX_BYTES) {
      throw new Error(memoryFullError(bytesUsed, MEMORY_FILE_MAX_BYTES));
    }
    if (outcome.added + outcome.replaced > 0) {
      await writeMemoryFile(scope, workspaceId, file, profileId);
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
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<RememberResult> {
  await ensureMigrated();
  const state = readState();
  if (!tierEnabled(state, scope, workspaceId, profileId)) {
    throw new Error(memoryDisabledError(scope));
  }
  const path = tierPath(scope, workspaceId, profileId);
  return withPathLock(path, async () => {
    const current = readMemoryFile(path);
    const next = parseMemoryFile(body);
    const date = todayStamp();

    const currentUserKeys = new Set<string>();
    for (const line of current?.lines ?? []) {
      if (isTemplateHeading(line)) continue;
      const key = preservationKey(line);
      if (key) currentUserKeys.add(key);
    }

    // Walk the body once: stamp new untagged bullets, collect the keys that
    // reappear as user-kind lines (the only form that counts as preserved),
    // and catch minted non-bullet lines.
    const nextUserKeys = new Set<string>();
    const mintedNonBullets: string[] = [];
    const newBullets: string[] = [];
    for (let i = 0; i < next.lines.length; i += 1) {
      const line = next.lines[i];
      if (line.kind !== "user") continue;
      const text = (line.bulletText ?? line.raw).replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (line.bulletText !== undefined) {
        // Untagged bullet: the user's if it matches a current user line
        // verbatim, otherwise it is new and gets Cora's stamp.
        if (currentUserKeys.has(text)) nextUserKeys.add(text);
        else {
          newBullets.push(line.bulletText);
          next.lines[i] = parseLine(coraBulletRaw(collapseBulletText(line.bulletText), date));
        }
      } else if (currentUserKeys.has(text)) {
        nextUserKeys.add(text);
      } else if (!isTemplateHeading(line)) {
        mintedNonBullets.push(text);
      }
    }
    assertBulletsFit(newBullets);
    assertNoSecrets(newBullets);

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

    const bytesUsed = fileBytes({
      ...next,
      headerLines: buildHeader(scope, workspaceId, profileId),
    });
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

    await writeMemoryFile(scope, workspaceId, next, profileId);
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

function tierStatus(
  state: MemoryState,
  scope: MemoryScope,
  workspaceId: string | null,
  profileId = DEFAULT_CORA_PROFILE_ID,
): MemoryTierStatus {
  // No active workspace: the workspace tier has no backing file yet, so it
  // reports disabled with an empty path (the renderer's documented contract).
  if (scope === "workspace" && workspaceId === null) {
    return {
      enabled: false,
      blockedByGlobal: false,
      path: "",
      bytesUsed: 0,
      bytesCap: MEMORY_FILE_MAX_BYTES,
      overCap: false,
      counts: { user: 0, cora: 0, auto: 0 },
    };
  }
  const path = scope === "global"
    ? globalMemoryPath(profileId)
    : workspaceMemoryPath(workspaceId as string, profileId);
  const file = readMemoryFile(path);
  const counts = { user: 0, cora: 0, auto: 0 };
  // Counts describe what Cora sees: expired lines still on disk until the next
  // write prunes them are not injected, so they are not counted either.
  const live = file ? withoutExpired(file, Date.now()) : null;
  for (const line of live?.lines ?? []) {
    if (isTemplateHeading(line)) continue;
    if (line.kind === "user") counts.user += 1;
    else if (line.kind === "cora") counts.cora += 1;
    else if (line.kind === "auto") counts.auto += 1;
  }
  const bytesUsed = file ? fileBytes(file) : 0;
  const enabled = tierEnabled(state, scope, workspaceId ?? "", profileId);
  const ownSwitch = scope === "workspace" &&
    state.workspaces[profileWorkspaceKey(normalizeCoraProfileId(profileId), workspaceId ?? "")]?.enabled !== false;
  return {
    enabled,
    blockedByGlobal: !enabled && ownSwitch,
    path,
    bytesUsed,
    bytesCap: MEMORY_FILE_MAX_BYTES,
    overCap: bytesUsed > MEMORY_FILE_MAX_BYTES,
    counts,
  };
}

export async function getMemoryStatus(
  workspaceId: string | null,
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<MemoryStatus> {
  await ensureMigrated();
  const state = readState();
  const profile = resolveCoraProfile(profileId);
  return {
    profile: {
      id: profile.id,
      name: profile.name,
      identityPath: profile.identityPath,
      isDefault: profile.isDefault,
    },
    global: tierStatus(state, "global", workspaceId, profileId),
    workspace: tierStatus(state, "workspace", workspaceId, profileId),
  };
}

export interface MemoryDocument {
  content: string;
  revision: string;
  bytesCap: number;
}

function memoryDocument(scope: MemoryScope, workspaceId: string, profileId: string): MemoryDocument {
  const path = tierPath(scope, workspaceId, profileId);
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new Error("This memory file is too large to edit on the phone. Trim it in Studio first.");
  }
  return {
    content: parseMemoryFile(raw).lines.map((line) => line.raw).join("\n"),
    revision: createHash("sha256").update(raw).digest("hex"),
    bytesCap: MEMORY_FILE_MAX_BYTES,
  };
}

export async function readMemoryDocument(
  scope: MemoryScope,
  workspaceId: string | null,
  profileId: string,
): Promise<MemoryDocument> {
  if (scope === "workspace" && !workspaceId) throw new Error("Choose a workspace first.");
  await ensureMigrated();
  return withPathLock(tierPath(scope, workspaceId ?? "", profileId), async () => {
    resolveCoraProfile(profileId);
    return memoryDocument(scope, workspaceId ?? "", profileId);
  });
}

export async function updateMemoryDocument(
  scope: MemoryScope,
  workspaceId: string | null,
  profileId: string,
  revision: string,
  change: { action: "save"; content: string } | { action: "clear"; includeUserLines: boolean },
): Promise<MemoryDocument> {
  if (scope === "workspace" && !workspaceId) throw new Error("Choose a workspace first.");
  await ensureMigrated();
  const wsId = workspaceId ?? "";
  return withPathLock(tierPath(scope, wsId, profileId), async () => {
    resolveCoraProfile(profileId);
    // The comparison shares the writers' lock, so a remember call that lands
    // while the phone is editing cannot be lost to its older draft.
    if (memoryDocument(scope, wsId, profileId).revision !== revision) {
      throw new Error("Memory changed in Studio. Reload the latest version before saving or clearing.");
    }
    let file: MemoryFile;
    if (change.action === "save") {
      file = parseMemoryFile([...buildHeader(scope, wsId, profileId), change.content].join("\n"));
      if (fileBytes(file) > MEMORY_FILE_MAX_BYTES) {
        throw new Error("Memory is limited to 4 KB including its heading. Shorten the text and try again.");
      }
    } else if (change.includeUserLines) {
      file = emptyFile(scope, wsId, profileId);
    } else {
      file = loadForWrite(scope, wsId, profileId);
      file.lines = file.lines.filter((line) => line.kind !== "auto" && line.kind !== "cora");
    }
    await writeMemoryFile(scope, wsId, file, profileId);
    return memoryDocument(scope, wsId, profileId);
  });
}

export async function setMemoryEnabled(
  scope: MemoryScope,
  workspaceId: string | null,
  enabled: boolean,
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<void> {
  await ensureMigrated();
  if (scope === "workspace" && workspaceId === null) {
    throw new Error("workspace scope requires a workspaceId");
  }
  await withPathLock(statePath(), async () => {
    const state = readState();
    const id = normalizeCoraProfileId(profileId);
    if (scope === "global" && id === DEFAULT_CORA_PROFILE_ID) {
      state.globalEnabled = enabled;
    } else if (scope === "global") {
      state.profileGlobals[id] = { enabled };
    } else {
      state.workspaces[profileWorkspaceKey(id, workspaceId as string)] = { enabled };
    }
    await mkdir(memoryRoot(), { recursive: true });
    await writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  });
}

/**
 * Create a tier's file from the fresh template when it does not exist yet, so
 * the editor has a file to open. An existing file is never touched, and the
 * existence check runs inside the path lock so a racing remember call cannot
 * be overwritten by the template.
 */
export async function ensureMemoryFile(
  scope: MemoryScope,
  workspaceId: string | null,
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<string> {
  await ensureMigrated();
  if (scope === "workspace" && !workspaceId) {
    throw new Error("workspace scope requires a workspaceId");
  }
  const wsId = workspaceId ?? "";
  resolveCoraProfile(profileId);
  const path = tierPath(scope, wsId, profileId);
  await withPathLock(path, async () => {
    if (existsSync(path)) return;
    await writeMemoryFile(scope, wsId, templateFile(scope, wsId, profileId), profileId);
  });
  return path;
}

/** Remove toggle records owned by a deleted named profile. Its markdown tree
 * is trashed separately by the profile deletion IPC. */
export async function deleteProfileMemoryState(profileId: string): Promise<void> {
  const id = normalizeCoraProfileId(profileId);
  if (id === DEFAULT_CORA_PROFILE_ID) {
    throw new Error("The built-in Cora memory state cannot be deleted.");
  }
  await withPathLock(statePath(), async () => {
    const state = readState();
    delete state.profileGlobals[id];
    const prefix = `profile:${id}:workspace:`;
    for (const key of Object.keys(state.workspaces)) {
      if (key.startsWith(prefix)) delete state.workspaces[key];
    }
    await mkdir(memoryRoot(), { recursive: true });
    await writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`);
  });
}

/** What "delete all" leaves behind: the managed header and nothing else. */
function emptyFile(scope: MemoryScope, workspaceId: string, profileId: string): MemoryFile {
  return { headerLines: buildHeader(scope, workspaceId, profileId), lines: [] };
}

/**
 * Default: remove only Cora's [auto]/[cora] lines, keeping every user line.
 * includeUserLines leaves only the managed header (the one action allowed to
 * discard user content; it is user-initiated from the UI).
 * Works regardless of toggles: clearing disabled memory must still be possible.
 */
export async function clearMemory(
  scope: MemoryScope,
  workspaceId: string | null,
  includeUserLines: boolean,
  profileId = DEFAULT_CORA_PROFILE_ID,
): Promise<void> {
  await ensureMigrated();
  if (scope === "workspace" && workspaceId === null) {
    throw new Error("workspace scope requires a workspaceId");
  }
  const wsId = workspaceId ?? "";
  await withPathLock(tierPath(scope, wsId, profileId), async () => {
    if (includeUserLines) {
      await writeMemoryFile(scope, wsId, emptyFile(scope, wsId, profileId), profileId);
      return;
    }
    const file = readMemoryFile(tierPath(scope, wsId, profileId));
    if (!file) return;
    file.lines = file.lines.filter((line) => line.kind !== "auto" && line.kind !== "cora");
    await writeMemoryFile(scope, wsId, file, profileId);
  });
}

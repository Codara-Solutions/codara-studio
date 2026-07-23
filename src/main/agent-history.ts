// Per-workspace agent conversation history.
//
// Lists past Claude/Codex CLI sessions for a workspace cwd so the terminal
// pane-toolbar history menu can offer "resume this conversation". Claude
// buckets transcripts per-cwd (~/.claude/projects/<encoded-cwd>/<uuid>.jsonl),
// so listing is a cheap readdir; Codex buckets by DATE (~/.codex/sessions/
// YYYY/MM/DD/rollout-*.jsonl) and records the cwd only inside the file, so the
// Codex side scans a bounded window of recent day-folders and head-reads each
// candidate. Everything here is read-only and best-effort: a vanished file or
// unparseable line skips that entry, never fails the listing.
//
// Titles come from the first real user message. That read is head-only (fixed
// byte budget) so multi-MB transcripts stay cheap to list.

import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { claudeProjectsDirForCwd } from "./orchestration/claude-paths";
import { extractSessionUuid, sessionsDirFor } from "./orchestration/codex-sessions";

export interface AgentHistoryEntry {
  runtime: "claude" | "codex";
  sessionId: string;
  cwd: string;
  // First real user message (whitespace-collapsed, capped) — or a runtime
  // fallback label when no clean title could be extracted.
  title: string;
  // ISO timestamp of the transcript's last write (mtime) — "when this
  // conversation last had activity", which is what the menu sorts/labels by.
  lastActivityAt: string;
  transcriptPath: string;
}

// Head-read budget per transcript. Big enough to skate past injected context
// blocks and meta lines to the first genuine user message in practice, small
// enough that listing dozens of sessions costs a few MB of reads total.
const TITLE_SCAN_BYTES = 128 * 1024;
const TITLE_MAX_CHARS = 120;
// How many day-folders back the Codex scan walks. Codex history beyond a month
// is unlikely to be worth a resume; the window keeps cold-cache listings fast.
const CODEX_SCAN_DAYS = 30;
// Hard cap on Codex rollout files whose heads we read per listing. Each read
// costs an open+16-128KB read; a date-bucketed hoard of stale rollouts must
// not turn one popover open into thousands of file reads.
const CODEX_SCAN_FILE_CAP = 200;

function collapseTitle(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1)}…` : text;
}

// True for user-message payloads that are tooling noise, not conversation:
// slash-command envelopes, command stdout echoes, caveat banners, and injected
// context blocks (Codex environment/instructions wrappers start with '<').
function isNoiseUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.length === 0 ||
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<user_instructions>") ||
    t.startsWith("<environment_context>") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("Caveat: ")
  );
}

// Pull the first real user-message text out of a Claude transcript head.
// Exported for scripts/test-agent-history.cjs. Returns null when the head
// holds no usable user text (stillborn session, pure tool traffic) — and
// `sidechain: true` when the file is a subagent transcript that should not be
// listed at all.
export function extractClaudeTitle(headText: string): { title: string | null; sidechain: boolean } {
  let sidechain = false;
  for (const line of headText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // truncated tail of the fixed-size head read
    }
    const r = rec as {
      type?: unknown;
      isMeta?: unknown;
      isSidechain?: unknown;
      message?: { content?: unknown };
    };
    if (r.isSidechain === true) sidechain = true;
    if (r.type !== "user" || r.isMeta === true) continue;
    const content = r.message?.content;
    if (typeof content === "string") {
      if (isNoiseUserText(content)) continue;
      const title = collapseTitle(content);
      if (title) return { title, sidechain };
      continue;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type !== "text" || typeof b.text !== "string") continue;
        if (isNoiseUserText(b.text)) continue;
        const title = collapseTitle(b.text);
        if (title) return { title, sidechain };
      }
    }
  }
  return { title: null, sidechain };
}

// Codex rollout heads mix schema generations; accept the user-message shapes
// Codex has used (response_item message with input_text blocks, event_msg
// user_message) and skip injected '<...>' context wrappers. Exported for
// scripts/test-agent-history.cjs.
export function extractCodexTitle(headText: string): string | null {
  for (const line of headText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const payload = (rec as { payload?: unknown }).payload ?? rec;
    const p = payload as {
      type?: unknown;
      role?: unknown;
      content?: unknown;
      message?: unknown;
    };
    if (p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      for (const block of p.content) {
        const b = block as { type?: unknown; text?: unknown };
        if ((b.type === "input_text" || b.type === "text") && typeof b.text === "string") {
          if (isNoiseUserText(b.text)) continue;
          const title = collapseTitle(b.text);
          if (title) return title;
        }
      }
    }
    if (p.type === "user_message" && typeof p.message === "string") {
      if (isNoiseUserText(p.message)) continue;
      const title = collapseTitle(p.message);
      if (title) return title;
    }
  }
  return null;
}

async function readHead(path: string, bytes = TITLE_SCAN_BYTES): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listClaudeHistory(
  cwd: string,
  limit: number,
  dirOverride?: string,
): Promise<AgentHistoryEntry[]> {
  const dir = dirOverride ?? claudeProjectsDirForCwd(cwd);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // no sessions for this cwd yet
  }
  const candidates: Array<{ path: string; sessionId: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = basename(name, ".jsonl");
    // Only main-session transcripts are resumable by id; skip stray files.
    if (!UUID_RE.test(sessionId)) continue;
    const path = join(dir, name);
    try {
      const stat = await fs.stat(path);
      candidates.push({ path, sessionId, mtimeMs: stat.mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: AgentHistoryEntry[] = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    const head = await readHead(c.path);
    if (head === null) continue;
    const { title, sidechain } = extractClaudeTitle(head);
    // No user message in the head = stillborn (never messaged) or a transcript
    // of pure tool traffic — `claude --resume` would refuse it anyway.
    if (sidechain || title === null) continue;
    out.push({
      runtime: "claude",
      sessionId: c.sessionId,
      cwd,
      title,
      lastActivityAt: new Date(c.mtimeMs).toISOString(),
      transcriptPath: c.path,
    });
  }
  return out;
}

// Compare paths case-insensitively with separators unified (mirrors the
// private normalizePath in codex-sessions.ts) so a Windows drive-letter or
// backslash mismatch doesn't hide a session.
function normalizePath(p: string): string {
  return p.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function listCodexHistory(
  cwd: string,
  limit: number,
  opts?: { sessionsDirForDate?: (date: Date) => string; now?: Date },
): Promise<AgentHistoryEntry[]> {
  const dirFor = opts?.sessionsDirForDate ?? sessionsDirFor;
  const now = opts?.now ?? new Date();
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (let dayBack = 0; dayBack < CODEX_SCAN_DAYS; dayBack += 1) {
    const dir = dirFor(new Date(now.getTime() - dayBack * 24 * 60 * 60 * 1000));
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue; // no sessions that day
    }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const stat = await fs.stat(path);
        files.push({ path, mtimeMs: stat.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const target = normalizePath(cwd);
  const out: AgentHistoryEntry[] = [];
  let scanned = 0;
  for (const f of files) {
    if (out.length >= limit || scanned >= CODEX_SCAN_FILE_CAP) break;
    scanned += 1;
    const sessionId = extractSessionUuid(f.path);
    if (!sessionId) continue;
    const head = await readHead(f.path);
    if (head === null) continue;
    // The leading session_meta records the rollout's cwd; other-workspace
    // sessions are filtered here since the date bucketing mixes everything.
    const cwdMatch = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
    if (!cwdMatch) continue;
    let recordedCwd: string;
    try {
      recordedCwd = JSON.parse(`"${cwdMatch[1]}"`) as string;
    } catch {
      continue;
    }
    if (normalizePath(recordedCwd) !== target) continue;
    const title = extractCodexTitle(head);
    if (title === null) continue; // never-messaged rollout — nothing to resume
    out.push({
      runtime: "codex",
      sessionId,
      cwd,
      title,
      lastActivityAt: new Date(f.mtimeMs).toISOString(),
      transcriptPath: f.path,
    });
  }
  return out;
}

/**
 * All resumable agent conversations for a workspace cwd, newest activity
 * first, both runtimes merged. `limit` bounds EACH runtime's scan (the menu
 * truncates visually anyway). Test seams: `claudeDir` points the Claude scan
 * at a fixture directory; `codexSessionsDirForDate`/`now` do the same for the
 * date-bucketed Codex walk.
 */
export async function listAgentHistoryForCwd(
  cwd: string,
  opts?: {
    limit?: number;
    claudeDir?: string;
    codexSessionsDirForDate?: (date: Date) => string;
    now?: Date;
  },
): Promise<AgentHistoryEntry[]> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 40, 100));
  const [claude, codex] = await Promise.all([
    listClaudeHistory(cwd, limit, opts?.claudeDir),
    listCodexHistory(cwd, limit, {
      sessionsDirForDate: opts?.codexSessionsDirForDate,
      now: opts?.now,
    }),
  ]);
  return [...claude, ...codex].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  );
}

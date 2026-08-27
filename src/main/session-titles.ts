// Shared transcript-title extraction for the two session listers
// (agent-history.ts → pane-toolbar clock menu, worker-sessions.ts → the
// worker session picker and Settings). Claude Code writes an LLM-generated
// `{"type":"ai-title","aiTitle":"…"}` record into most transcripts shortly
// after a session starts — the best available description of a session — so
// both listers prefer it and fall back to the first real user message. This
// module owns the "what counts as a real user message" rules so the two
// listers cannot drift apart again (they previously had independent filters,
// and the weaker one let `<local-command-caveat>` banners surface as titles).

import { promises as fs } from "node:fs";

// Wrapper blocks the CLIs inject around (or instead of) genuine user prose:
// slash-command envelopes, local-command stdout/caveat banners, and injected
// context. Stripped wholesale — an unclosed wrapper swallows to end-of-text,
// which is what we want for records truncated by a fixed-size head read.
const WRAPPER_TAGS = [
  "system-reminder",
  "environment_context",
  "user_instructions",
  "command-name",
  "command-message",
  "command-args",
  "command-contents",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "task-notification",
];
const WRAPPER_BLOCK_RE = new RegExp(
  WRAPPER_TAGS.map((tag) => `<${tag}>[\\s\\S]*?(?:</${tag}>|$)`).join("|"),
  "gi",
);

// Strip injected wrappers and collapse whitespace; null when nothing genuine
// remains. The "Caveat: " check catches the bare first-run banner Claude Code
// emits outside any wrapper tag.
export function sanitizeUserText(raw: string): string | null {
  const cleaned = raw.replace(WRAPPER_BLOCK_RE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.startsWith("Caveat: ")) return null;
  return cleaned;
}

export function clampTitle(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Joined text of a message's content — string form, or the text/input_text
// blocks of the array form (Claude and Codex shapes respectively).
export function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const pieces: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type !== "text" && part.type !== "input_text") continue;
    if (typeof part.text === "string" && part.text) pieces.push(part.text);
  }
  return pieces.length > 0 ? pieces.join(" ") : null;
}

export interface ClaudeTranscriptHead {
  // Claude Code's own generated topic label, verbatim (whitespace-collapsed).
  aiTitle: string | null;
  // First user message that survives sanitizeUserText, unclamped.
  firstUserText: string | null;
  // A subagent record appeared — agent-history treats the whole file as a
  // sidechain transcript; worker-sessions only requires a main-lane user.
  sawSidechain: boolean;
  // At least one non-sidechain, non-meta user record exists (resumable).
  hasUser: boolean;
  // A main-lane assistant record appeared: the model actually answered, so
  // the transcript is a conversation even when every user record in the head
  // is tooling noise (slash-command envelopes) or tool results.
  sawAssistant: boolean;
  cwd: string | null;
  startedAtMs: number | null;
}

export function parseClaudeHead(headText: string): ClaudeTranscriptHead {
  const out: ClaudeTranscriptHead = {
    aiTitle: null,
    firstUserText: null,
    sawSidechain: false,
    hasUser: false,
    sawAssistant: false,
    cwd: null,
    startedAtMs: null,
  };
  for (const line of headText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // truncated tail of a fixed-size head read
    }
    if (!isRecord(rec)) continue;
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      const title = rec.aiTitle.replace(/\s+/g, " ").trim();
      if (title && out.aiTitle === null) out.aiTitle = title;
      continue;
    }
    if (rec.type === "assistant") {
      if (rec.isSidechain !== true) out.sawAssistant = true;
      continue;
    }
    if (rec.type !== "user") continue;
    if (rec.isSidechain === true) {
      out.sawSidechain = true;
      continue;
    }
    if (rec.isMeta === true) continue;
    out.hasUser = true;
    if (out.cwd === null && typeof rec.cwd === "string") out.cwd = rec.cwd;
    if (out.startedAtMs === null && typeof rec.timestamp === "string") {
      const parsed = Date.parse(rec.timestamp);
      if (Number.isFinite(parsed)) out.startedAtMs = parsed;
    }
    if (out.firstUserText === null) {
      const message = isRecord(rec.message) ? rec.message : null;
      const text = textFromContent(message?.content);
      const sanitized = text === null ? null : sanitizeUserText(text);
      if (sanitized) out.firstUserText = sanitized;
    }
  }
  return out;
}

export interface CodexTranscriptHead {
  cwd: string | null;
  startedAtMs: number | null;
  // First user message that survives sanitizeUserText, unclamped. Codex has
  // no ai-title equivalent.
  firstUserText: string | null;
}

// ---- ai-title deep scan ----
//
// The ai-title record is appended once, early in a session's life — usually
// within the first ~150 lines — but big pasted-context lines can push it past
// a fixed head read (680KB deep in one observed transcript). When the head
// parse misses it, this bounded chunked scan looks deeper. Results are cached
// by (mtime, size): dormant transcripts never rescan, and a found title
// survives file growth since the record is immutable once written.

const AI_TITLE_SCAN_MAX_BYTES = 4 * 1024 * 1024;
const AI_TITLE_SCAN_CHUNK = 256 * 1024;
const AI_TITLE_MARKER = '"ai-title"';
const AI_TITLE_CACHE_MAX = 1000;

interface AiTitleCacheEntry {
  mtimeMs: number;
  size: number;
  aiTitle: string | null;
}

const aiTitleCache = new Map<string, AiTitleCacheEntry>();

function aiTitleFromLine(line: string): string | null {
  if (!line.includes(AI_TITLE_MARKER)) return null;
  try {
    const rec: unknown = JSON.parse(line.trim());
    if (isRecord(rec) && rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      const title = rec.aiTitle.replace(/\s+/g, " ").trim();
      return title || null;
    }
  } catch {
    // partial or foreign line
  }
  return null;
}

async function scanFileForAiTitle(path: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, "r");
    const chunk = Buffer.alloc(AI_TITLE_SCAN_CHUNK);
    let carry = Buffer.alloc(0);
    let offset = 0;
    while (offset < AI_TITLE_SCAN_MAX_BYTES) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      let buffer = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = buffer.indexOf(0x0a)) !== -1) {
        const title = aiTitleFromLine(buffer.subarray(0, newline).toString("utf8"));
        if (title) return title;
        buffer = buffer.subarray(newline + 1);
      }
      carry = buffer;
      // A multi-megabyte single line cannot be the tiny ai-title record;
      // drop marker-free oversized carries to bound memory.
      if (carry.length > AI_TITLE_SCAN_CHUNK && !carry.includes(AI_TITLE_MARKER)) {
        carry = Buffer.alloc(0);
      }
    }
    return aiTitleFromLine(carry.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

/**
 * Cached lookup of a transcript's ai-title record beyond the head bytes the
 * listers already read. Callers should consult parseClaudeHead().aiTitle
 * first and only fall through here when the head missed it.
 */
export async function findClaudeAiTitle(
  path: string,
  stat: { mtimeMs: number; size: number },
): Promise<string | null> {
  const cached = aiTitleCache.get(path);
  if (
    cached &&
    (cached.mtimeMs === stat.mtimeMs || (cached.aiTitle !== null && stat.size >= cached.size))
  ) {
    return cached.aiTitle;
  }
  const aiTitle = await scanFileForAiTitle(path);
  if (aiTitleCache.size >= AI_TITLE_CACHE_MAX) aiTitleCache.clear();
  aiTitleCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, aiTitle });
  return aiTitle;
}

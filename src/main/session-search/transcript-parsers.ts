// Line parsers for the session index: one per agent CLI, each folding the
// records of a transcript into the session's facts (its folder, model,
// title, first prompt) and the plain user and assistant text worth finding.
// Tool calls and their outputs, reasoning, images and the context the CLIs
// inject around a prompt are left out: they are most of a transcript's
// bytes and none of what people search for.
//
// Pure: no Electron, no database. A parser's state is plain JSON so the index
// can store it with the file and resume an append-only transcript exactly
// where the last pass stopped.

import type { SessionSearchAgent } from "@shared/session-search";
import { isInteractiveCodexSource } from "../orchestration/codex-sessions";
import { sanitizeUserText, stripInjectedContext } from "../session-titles";

export interface IndexedMessage {
  role: "user" | "assistant";
  text: string;
  at: number | null;
}

/** What a transcript says about its session; persisted between passes. */
export interface TranscriptState {
  /** The id inside the transcript, when it carries one (Codex, Pi). */
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  /** A title the agent itself gave the session. */
  title: string | null;
  /** A title the user set (Claude's /rename); wins over `title`. */
  customTitle: string | null;
  firstPrompt: string | null;
  startedAt: number | null;
  /** Not the user's own conversation (a Codex subagent thread): left out. */
  rejected: boolean;
}

export function initialTranscriptState(): TranscriptState {
  return {
    sessionId: null,
    cwd: null,
    model: null,
    title: null,
    customTitle: null,
    firstPrompt: null,
    startedAt: null,
    rejected: false,
  };
}

export function restoreTranscriptState(raw: string | null): TranscriptState {
  const base = initialTranscriptState();
  if (!raw) return base;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return base;
    const src = parsed as Record<string, unknown>;
    const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
    return {
      sessionId: text(src.sessionId),
      cwd: text(src.cwd),
      model: text(src.model),
      title: text(src.title),
      customTitle: text(src.customTitle),
      firstPrompt: text(src.firstPrompt),
      startedAt: typeof src.startedAt === "number" ? src.startedAt : null,
      rejected: src.rejected === true,
    };
  } catch {
    return base;
  }
}

export type LineParser = (line: string, state: TranscriptState, emit: (message: IndexedMessage) => void) => void;

// ── Text ──────────────────────────────────────────────────────────────────

/** Longest stretch of one message the index keeps. */
export const MAX_MESSAGE_CHARS = 32_000;
export const FIRST_PROMPT_CHARS = 300;
export const TITLE_CHARS = 120;

// Context blocks the CLIs wrap around a prompt, beyond the ones
// sanitizeUserText already strips for titles.
const EXTRA_WRAPPER_TAGS = [
  "user_info",
  "send_user_message_question_reply",
  "external_codex_apps_open_page",
  "recommended_plugins",
  "turn_aborted",
  "permissions instructions",
  "collaboration_mode",
];
const EXTRA_WRAPPER_RE = new RegExp(
  EXTRA_WRAPPER_TAGS.map((tag) => `<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}>|$)`).join("|"),
  "gi",
);
// Codex inserts these as whole input blocks before the typed prompt.
const INJECTED_BLOCK_RE = /^\s*(?:# AGENTS\.md instructions|# Chrome tabs:|# Files mentioned by the user|<[A-Za-z_][\w -]*>)/;

// C0 controls other than tab and newline, DEL, and the C1 range. The snippet
// markers are control characters, so none may reach the index.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Index form of a message: no control characters, tidy spacing, bounded. */
export function cleanIndexText(raw: string): string {
  const text = raw
    .replace(CONTROL_RE, " ")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;
}

/** A prompt as the person typed it, without injected context; null if nothing is left. */
export function cleanUserPrompt(raw: string): string | null {
  const stripped = stripInjectedContext(
    raw.replace(EXTRA_WRAPPER_RE, " ").replace(/<\/?user_query>/gi, " "),
  );
  // sanitizeUserText also recognizes the bare caveat banner; it collapses
  // whitespace, so it only decides whether anything genuine is left.
  if (sanitizeUserText(stripped) === null) return null;
  const text = cleanIndexText(stripped);
  return text ? text : null;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function noteFirstPrompt(state: TranscriptState, text: string): void {
  if (state.firstPrompt === null) state.firstPrompt = oneLine(text, FIRST_PROMPT_CHARS);
}

function noteStart(state: TranscriptState, at: number | null): void {
  if (at !== null && (state.startedAt === null || at < state.startedAt)) state.startedAt = at;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(line: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function timestampOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Joined text blocks of a message body, string or block-array form. */
function blockText(content: unknown, kinds: readonly string[], skipInjected = false): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const pieces: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || typeof block.type !== "string" || !kinds.includes(block.type)) continue;
    const text = typeof block.text === "string" ? block.text : null;
    if (!text) continue;
    if (skipInjected && INJECTED_BLOCK_RE.test(text)) continue;
    pieces.push(text);
  }
  return pieces.length > 0 ? pieces.join("\n\n") : null;
}

function emitUser(state: TranscriptState, raw: string | null, at: number | null, emit: (m: IndexedMessage) => void): void {
  if (!raw) return;
  const text = cleanUserPrompt(raw);
  if (!text) return;
  noteFirstPrompt(state, text);
  noteStart(state, at);
  emit({ role: "user", text, at });
}

function emitAssistant(state: TranscriptState, raw: string | null, at: number | null, emit: (m: IndexedMessage) => void): void {
  if (!raw) return;
  const text = cleanIndexText(raw);
  if (!text) return;
  noteStart(state, at);
  emit({ role: "assistant", text, at });
}

// ── Claude Code: ~/.claude/projects/<folder>/<session>.jsonl ───────────────

export const parseClaudeLine: LineParser = (line, state, emit) => {
  // Most of a transcript is tool output, attachments and file snapshots.
  // Records that cannot matter are recognized by their raw text before any
  // JSON parse; a false positive only costs the parse.
  const user = line.includes('"type":"user"');
  const assistant = !user && line.includes('"type":"assistant"');
  const titled = !user && !assistant && (line.includes('"ai-title"') || line.includes('"custom-title"') || line.includes('"type":"summary"'));
  if (!user && !assistant && !titled) return;
  // An assistant record holds one content block; only a text block is prose.
  if (assistant && !line.includes('"type":"text"')) return;
  // A user record of tool results alone has no prose either.
  if (user && line.includes('"tool_result"') && !line.includes('"type":"text"')) return;
  const record = parseRecord(line);
  if (!record) return;
  switch (record.type) {
    case "ai-title": {
      const title = str(record.aiTitle);
      if (title) state.title = oneLine(title, TITLE_CHARS);
      return;
    }
    case "custom-title": {
      const title = str(record.customTitle);
      if (title) state.customTitle = oneLine(title, TITLE_CHARS);
      return;
    }
    case "summary": {
      const title = str(record.summary);
      if (title && state.title === null) state.title = oneLine(title, TITLE_CHARS);
      return;
    }
    case "user":
    case "assistant":
      break;
    default:
      return;
  }
  if (record.isSidechain === true) return;
  const at = timestampOf(record.timestamp);
  if (state.cwd === null && typeof record.cwd === "string" && record.cwd) state.cwd = record.cwd;
  const message = isRecord(record.message) ? record.message : null;
  if (!message) return;
  if (record.type === "user") {
    if (record.isMeta === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return;
    emitUser(state, blockText(message.content, ["text"]), at, emit);
    return;
  }
  const model = str(message.model);
  if (model && model !== "<synthetic>") state.model = model;
  emitAssistant(state, blockText(message.content, ["text"]), at, emit);
};

// ── Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ────────────────────

export const parseCodexLine: LineParser = (line, state, emit) => {
  const meta = line.includes('"session_meta"');
  const context = !meta && line.includes('"turn_context"');
  const message = !meta && !context && line.includes('"response_item"') && line.includes('"type":"message"');
  if (!meta && !context && !message) return;
  const record = parseRecord(line);
  if (!record) return;
  const payload = isRecord(record.payload) ? record.payload : null;
  if (!payload) return;
  if (record.type === "session_meta") {
    if (state.sessionId !== null) return;
    state.sessionId = str(payload.id) ?? str(payload.session_id);
    if (state.cwd === null) state.cwd = str(payload.cwd);
    noteStart(state, timestampOf(payload.timestamp) ?? timestampOf(record.timestamp));
    const title = str(payload.title) ?? str(payload.thread_name);
    if (title) state.title = oneLine(title, TITLE_CHARS);
    // Subagent threads, exec runs and the desktop and browser clients are
    // not conversations a terminal can resume; the same rule as the
    // Settings session list (isInteractiveCodexSource).
    if (
      payload.thread_source === "subagent" ||
      (isRecord(payload.source) && "subagent" in payload.source) ||
      (payload.source !== undefined && !isInteractiveCodexSource(payload.source, payload.originator))
    ) {
      state.rejected = true;
    }
    return;
  }
  if (record.type === "turn_context") {
    if (state.cwd === null) state.cwd = str(payload.cwd);
    const model = str(payload.model);
    if (model) state.model = model;
    return;
  }
  if (record.type !== "response_item" || payload.type !== "message") return;
  const at = timestampOf(record.timestamp);
  // `event_msg` user and agent messages repeat these response items; the
  // response items are in every rollout format, so they are the ones read.
  if (payload.role === "user") {
    emitUser(state, blockText(payload.content, ["input_text", "text"], true), at, emit);
  } else if (payload.role === "assistant") {
    emitAssistant(state, blockText(payload.content, ["output_text", "text"]), at, emit);
  }
};

// ── Grok Build: ~/.grok/sessions/<folder>/<session>/chat_history.jsonl ────

export const parseGrokLine: LineParser = (line, state, emit) => {
  const user = line.includes('"type":"user"');
  const assistant = !user && line.includes('"type":"assistant"');
  if (!user && !assistant) return;
  const record = parseRecord(line);
  if (!record) return;
  const at = timestampOf(record.timestamp) ?? timestampOf(record.created_at);
  if (record.type === "user") {
    // Skills lists, server rosters and compaction notes arrive as user
    // records the CLI wrote itself.
    if (record.synthetic_reason !== undefined && record.synthetic_reason !== null) return;
    emitUser(state, blockText(record.content, ["text"]), at, emit);
    return;
  }
  if (record.type !== "assistant") return;
  const model = str(record.model_id);
  if (model) state.model = model;
  emitAssistant(state, blockText(record.content, ["text"]), at, emit);
};

/** Grok's summary.json: the session's folder, title and model. */
export function applyGrokSummary(raw: string, state: TranscriptState): void {
  const record = parseRecord(raw);
  if (!record) return;
  const info = isRecord(record.info) ? record.info : {};
  state.sessionId = str(info.id) ?? str(record.session_id) ?? state.sessionId;
  state.cwd = str(info.cwd) ?? str(record.cwd) ?? state.cwd;
  const title = str(record.generated_title) ?? str(record.session_summary);
  if (title) state.title = oneLine(title, TITLE_CHARS);
  const model = str(record.current_model_id);
  if (model) state.model = model;
  noteStart(state, timestampOf(record.created_at));
}

// ── Pi: ~/.pi/agent/sessions/--<folder>--/<created>_<session>.jsonl ────────

export const parsePiLine: LineParser = (line, state, emit) => {
  const record = parseRecord(line);
  if (!record) return;
  const at = timestampOf(record.timestamp);
  switch (record.type) {
    case "session":
      state.sessionId = str(record.id) ?? state.sessionId;
      if (state.cwd === null) state.cwd = str(record.cwd);
      noteStart(state, at);
      return;
    case "session_info": {
      const name = str(record.name) ?? str(record.title);
      if (name) state.customTitle = oneLine(name, TITLE_CHARS);
      return;
    }
    case "model_change": {
      const model = str(record.modelId) ?? str(record.model);
      if (model) state.model = model;
      return;
    }
    case "message":
      break;
    default:
      return;
  }
  const message = isRecord(record.message) ? record.message : null;
  if (!message) return;
  if (message.role === "user") {
    emitUser(state, blockText(message.content, ["text"]), at, emit);
  } else if (message.role === "assistant") {
    const model = str(message.model);
    if (model) state.model = model;
    emitAssistant(state, blockText(message.content, ["text"]), at, emit);
  }
};

// ── Cora: <codara home>/runs/<run>/run.json ────────────────────────────────

export interface CoraRunTranscript {
  runId: string;
  workspaceId: string | null;
  title: string | null;
  model: string | null;
  messages: IndexedMessage[];
}

/** A Cora chat as the run store saved it: its title and the chat's messages. */
export function parseCoraRun(raw: string): CoraRunTranscript | null {
  const record = parseRecord(raw);
  if (!record) return null;
  const runId = str(record.id);
  if (!runId) return null;
  const messages: IndexedMessage[] = [];
  const human = Array.isArray(record.humanMessages) ? record.humanMessages : [];
  for (const entry of human) {
    if (!isRecord(entry) || typeof entry.message !== "string") continue;
    const role = entry.author === "user" ? "user" : entry.author === "spark" ? "assistant" : null;
    if (!role) continue;
    const text = role === "user" ? cleanUserPrompt(entry.message) : cleanIndexText(entry.message);
    if (!text) continue;
    messages.push({ role, text, at: timestampOf(entry.createdAt) });
  }
  return {
    runId,
    workspaceId: str(record.workspaceId),
    title: str(record.title) ? oneLine(String(record.title), TITLE_CHARS) : null,
    model: str(record.chatModel),
    messages,
  };
}

/** The folder a Cora run started in, from the first record of its event log. */
export function coraRunCwd(firstEventLine: string): string | null {
  const record = parseRecord(firstEventLine);
  const payload = record && isRecord(record.payload) ? record.payload : null;
  return payload ? str(payload.cwd) : null;
}

export const LINE_PARSERS: Readonly<Record<Exclude<SessionSearchAgent, "cora">, LineParser>> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  grok: parseGrokLine,
  pi: parsePiLine,
};

/** The title a session shows: the user's own, the agent's, then the first prompt. */
export function sessionTitle(state: TranscriptState): string | null {
  return state.customTitle ?? state.title ?? (state.firstPrompt ? oneLine(state.firstPrompt, TITLE_CHARS) : null);
}

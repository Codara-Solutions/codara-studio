// Agent session search: the shapes main, the index thread and the renderer
// share, the preference that turns it on, and the pure helpers each side
// needs (the FTS query a typed search becomes, the snippet markers, the
// progress line). The index itself is src/main/session-search/.

export type SessionSearchAgent = "claude" | "codex" | "grok" | "pi" | "cora";

export const SESSION_SEARCH_AGENTS: readonly SessionSearchAgent[] = [
  "claude",
  "codex",
  "grok",
  "pi",
  "cora",
];

export const SESSION_SEARCH_AGENT_LABEL: Readonly<Record<SessionSearchAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
  cora: "Cora",
};

/**
 * The session ids a resume command may carry. Every id the index holds has
 * this shape (main only indexes ids the CLIs mint); the renderer checks again
 * before typing one into a shell.
 */
export function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

export function isSessionSearchAgent(value: unknown): value is SessionSearchAgent {
  return typeof value === "string" && (SESSION_SEARCH_AGENTS as readonly string[]).includes(value);
}

/** Workspace: the workspace's folder. Project: every worktree of its repository. */
export type SessionSearchScope = "workspace" | "project" | "all";

export interface SessionSearchPreferences {
  enabled: boolean;
  /** The agents whose sessions are indexed. */
  agents: SessionSearchAgent[];
  /** The one-time "Indexing your agent sessions" dialog was shown. */
  introSeen: boolean;
  /**
   * What the codara_session_search agent tool may read: the calling
   * workspace's project, or every indexed session.
   */
  agentToolScope: "project" | "all";
}

export const DEFAULT_SESSION_SEARCH_PREFERENCES: SessionSearchPreferences = {
  enabled: true,
  agents: [...SESSION_SEARCH_AGENTS],
  introSeen: false,
  agentToolScope: "project",
};

export function normalizeSessionSearchPreferences(raw: unknown): SessionSearchPreferences {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const agents = Array.isArray(src.agents)
    ? SESSION_SEARCH_AGENTS.filter((agent) => (src.agents as unknown[]).includes(agent))
    : [...DEFAULT_SESSION_SEARCH_PREFERENCES.agents];
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_SESSION_SEARCH_PREFERENCES.enabled,
    agents,
    introSeen: src.introSeen === true,
    agentToolScope: src.agentToolScope === "all" ? "all" : "project",
  };
}

// ── Requests and answers ──────────────────────────────────────────────────

export interface SessionSearchRequest {
  query: string;
  scope: SessionSearchScope;
  /** The workspace folder the Workspace and Project scopes are measured from. */
  cwd: string | null;
  /** Null or empty means every enabled agent. */
  agents?: SessionSearchAgent[] | null;
  limit?: number;
  offset?: number;
  /** With an empty query, pinned sessions lead the list. */
  pinnedFirst?: boolean;
  /** Longer excerpts, for a surface with room to read them. */
  wideSnippets?: boolean;
}

/** The part of a session a search matched: its name, what you said, what the agent said. */
export type SessionMatchKind = "name" | "user" | "assistant";

export interface SessionSearchMatch {
  kind: SessionMatchKind;
  /** The best matching text of that part, with SNIPPET_MARK_START/END around each hit. */
  snippet: string;
}

export interface SessionSearchHit {
  /** `${agent}:${sessionId}`: what the renderer hands back for row actions. */
  key: string;
  agent: SessionSearchAgent;
  sessionId: string;
  /** The name the person gave the session, else its own title or first prompt. */
  title: string;
  /** The session's own title when the person renamed it, else null. */
  originalTitle: string | null;
  pinned: boolean;
  /** The git branch the transcript recorded, when the agent records one. */
  branch: string | null;
  /** One entry per part that matched: name, then what you said, then the agent. */
  matches: SessionSearchMatch[];
  /** Matched text with SNIPPET_MARK_START/END around each hit; null for a recent list or a title-only match. */
  snippet: string | null;
  /** Which side said the matched text. */
  snippetRole: "user" | "assistant" | null;
  cwd: string | null;
  /** False when the session's folder is gone from this computer. */
  cwdExists: boolean;
  model: string | null;
  messageCount: number;
  startedAt: number | null;
  lastAt: number | null;
  /** Cora chats: the workspace the run belongs to. */
  workspaceId: string | null;
}

export interface SessionSearchResult {
  hits: SessionSearchHit[];
  hasMore: boolean;
  tookMs: number;
  status: SessionSearchStatus;
}

export type SessionSearchPhase = "off" | "idle" | "indexing" | "paused" | "error";

export interface SessionSearchStatus {
  enabled: boolean;
  phase: SessionSearchPhase;
  /** Why automatic indexing waits, when it does. */
  pausedReason: "battery" | "busy" | null;
  /** No index has finished yet on this computer. */
  firstBuild: boolean;
  /** Transcripts found and read in the current (or last) pass. */
  filesTotal: number;
  filesDone: number;
  sessions: number;
  messages: number;
  indexBytes: number;
  lastSyncAt: number | null;
  error: string | null;
  /** The one-time intro dialog may open now. */
  introPending: boolean;
}

export const EMPTY_SESSION_SEARCH_STATUS: SessionSearchStatus = {
  enabled: false,
  phase: "off",
  pausedReason: null,
  firstBuild: true,
  filesTotal: 0,
  filesDone: 0,
  sessions: 0,
  messages: 0,
  indexBytes: 0,
  lastSyncAt: null,
  error: null,
  introPending: false,
};

export interface SessionTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  at: number | null;
}

export interface SessionTranscript {
  key: string;
  agent: SessionSearchAgent;
  title: string;
  cwd: string | null;
  messages: SessionTranscriptMessage[];
  /** Every message the index holds for the session, of which `messages` is the start. */
  total: number;
}

/** The end of a conversation, for a preview beside a list. */
export interface SessionPreview {
  key: string;
  /** Oldest first; each message's first part only, clipped. */
  messages: SessionTranscriptMessage[];
  /** Every message the index holds for the session. */
  total: number;
}

// ── Names and pins ────────────────────────────────────────────────────────

export interface SessionLabel {
  name?: string;
  pinned?: boolean;
}

export type SessionLabels = Record<string, SessionLabel>;

export const SESSION_NAME_MAX = 120;

/** One line of at most SESSION_NAME_MAX characters, or null when nothing is left. */
export function cleanSessionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name ? [...name].slice(0, SESSION_NAME_MAX).join("").trim() : null;
}

// ── Snippet markers ───────────────────────────────────────────────────────

// Control characters never survive indexing (cleanIndexText strips them), so
// these cannot collide with transcript text.
export const SNIPPET_MARK_START = "\u0001";
export const SNIPPET_MARK_END = "\u0002";

export interface SnippetPart {
  text: string;
  mark: boolean;
}

export function splitSnippetMarks(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let mark = false;
  let run = "";
  for (const char of snippet) {
    if (char === SNIPPET_MARK_START || char === SNIPPET_MARK_END) {
      if (run) parts.push({ text: run, mark });
      run = "";
      mark = char === SNIPPET_MARK_START;
      continue;
    }
    run += char;
  }
  if (run) parts.push({ text: run, mark });
  return parts;
}

/**
 * Cuts the text before the first marked word to its last `maxLead`
 * characters, from a word start, so an excerpt clamped to a few lines keeps
 * the match in view.
 */
export function trimSnippetLead(parts: SnippetPart[], maxLead: number): SnippetPart[] {
  const [first, ...rest] = parts;
  if (!first || first.mark || rest.length === 0 || first.text.length <= maxLead) return parts;
  const start = first.text.length - maxLead;
  const tail = first.text.slice(start);
  const space = /\s/.test(first.text[start - 1]) ? -1 : tail.search(/\s/);
  const lead = space >= 0 && space < tail.length - 1 ? tail.slice(space + 1) : tail;
  return [{ text: `\u2026${lead}`, mark: false }, ...rest];
}

// ── Query ─────────────────────────────────────────────────────────────────

const MAX_QUERY_TERMS = 12;

/** The words of a typed query, as the index tokenizes them. */
export function sessionQueryTerms(query: string): string[] {
  return query
    .normalize("NFKC")
    .slice(0, 512)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, MAX_QUERY_TERMS);
}

/**
 * The FTS5 MATCH expression for a typed query: every word must appear, the
 * last one as a prefix so results follow the typing. Each term is quoted, so
 * nothing the user types reaches FTS5 as syntax. Null when there is no word.
 */
export function buildFtsMatch(query: string, mode: "all" | "any" = "all"): string | null {
  const terms = sessionQueryTerms(query);
  if (terms.length === 0) return null;
  const quoted = terms.map((term, index) => {
    const body = `"${term.replace(/"/g, '""')}"`;
    return index === terms.length - 1 ? `${body}*` : body;
  });
  return quoted.join(mode === "all" ? " " : " OR ");
}

// ── Progress line ─────────────────────────────────────────────────────────

/** 46K, 1.2M: a count that fits a status line. */
export function compactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** "172 of 172 sessions · 46K messages searchable" */
export function sessionSearchProgressLine(status: SessionSearchStatus): string {
  const messages = `${compactCount(status.messages)} ${plural(status.messages, "message", "messages")} searchable`;
  if (status.phase === "indexing") {
    if (status.filesTotal === 0) return "Finding your sessions…";
    return `${status.filesDone} of ${status.filesTotal} ${plural(status.filesTotal, "session", "sessions")} · ${messages}`;
  }
  return `${status.sessions} ${plural(status.sessions, "session", "sessions")} · ${messages}`;
}

export function formatIndexBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** "Just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago". */
export type SessionDayGroup = "Today" | "Yesterday" | "This week" | "Older";

/** Which day heading a session falls under, by the calendar of this computer. */
export function sessionDayGroup(at: number | null, now: number): SessionDayGroup {
  if (at === null || !Number.isFinite(at)) return "Older";
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const daysBack = (days: number) => {
    const day = new Date(midnight);
    day.setDate(day.getDate() - days);
    return day.getTime();
  };
  if (at >= midnight.getTime()) return "Today";
  if (at >= daysBack(1)) return "Yesterday";
  if (at >= daysBack(6)) return "This week";
  return "Older";
}

/** 12m, 1h 12m, 3d 4h: from a session's first message to its last. Empty when unknown. */
export function sessionLengthLabel(startedAt: number | null, lastAt: number | null): string {
  if (startedAt === null || lastAt === null || lastAt < startedAt) return "";
  const minutes = Math.round((lastAt - startedAt) / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

export function relativeAge(at: number | null, now: number): string {
  if (at === null || !Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/** Normalized folder key the scope filters compare by prefix. */
export function sessionCwdKey(cwd: string, platform: string): string {
  const slashed = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const key = slashed === "" ? "/" : slashed;
  return platform === "win32" ? key.toLowerCase() : key;
}

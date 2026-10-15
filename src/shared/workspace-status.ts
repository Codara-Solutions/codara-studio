// A workspace's status and one-line progress note: what the agents working in
// it (or the user, by hand) say about where the work stands. Shared by main,
// which stores and serves it (src/main/workspace-status/), the codara-studio
// tool that sets it, and the renderer, which shows it in the rail. Pure, so
// the unit suite loads it without Electron and the web build without Node.

export const WORKSPACE_STATUS_IDS = ["todo", "in_progress", "in_review", "done", "blocked"] as const;

export type WorkspaceStatusId = (typeof WORKSPACE_STATUS_IDS)[number];

export const WORKSPACE_STATUS_LABELS: Record<WorkspaceStatusId, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  blocked: "Blocked",
};

/** The theme token each status is drawn in; light themes re-tint them. */
export const WORKSPACE_STATUS_TONES: Record<WorkspaceStatusId, string> = {
  todo: "var(--muted)",
  in_progress: "var(--info)",
  in_review: "var(--automation)",
  done: "var(--ok)",
  blocked: "var(--danger)",
};

/** One line in the rail; longer notes are cut with an ellipsis. */
export const WORKSPACE_STATUS_NOTE_MAX = 140;
/** The notes kept per workspace, newest last, current one included. */
export const WORKSPACE_STATUS_CHECKPOINTS_MAX = 5;
const AUTHOR_LABEL_MAX = 40;

export interface WorkspaceStatusAuthor {
  kind: "agent" | "user";
  /** "Claude Code", "Codex", "Cora", "You", ... */
  label: string;
}

export interface WorkspaceStatusCheckpoint {
  status: WorkspaceStatusId | null;
  note: string | null;
  at: number;
  by: WorkspaceStatusAuthor;
}

export interface WorkspaceStatusEntry {
  status: WorkspaceStatusId | null;
  note: string | null;
  updatedAt: number;
  by: WorkspaceStatusAuthor;
  checkpoints: WorkspaceStatusCheckpoint[];
}

/**
 * A change. A field left out keeps its value; status null and an empty or
 * null note remove that part, and clear removes both.
 */
export interface WorkspaceStatusPatch {
  status?: WorkspaceStatusId | null;
  note?: string | null;
  clear?: boolean;
}

export type WorkspaceStatusMap = Record<string, WorkspaceStatusEntry>;

export interface WorkspaceStatusChange {
  workspaceId: string;
  entry: WorkspaceStatusEntry | null;
}

export function isWorkspaceStatusId(value: unknown): value is WorkspaceStatusId {
  return typeof value === "string" && (WORKSPACE_STATUS_IDS as readonly string[]).includes(value);
}

const STATUS_ALIASES: Record<string, WorkspaceStatusId> = {
  to_do: "todo",
  todo: "todo",
  open: "todo",
  in_progress: "in_progress",
  inprogress: "in_progress",
  progress: "in_progress",
  working: "in_progress",
  wip: "in_progress",
  doing: "in_progress",
  in_review: "in_review",
  inreview: "in_review",
  review: "in_review",
  needs_review: "in_review",
  done: "done",
  complete: "done",
  completed: "done",
  finished: "done",
  blocked: "blocked",
  stuck: "blocked",
};

/**
 * The status an agent or the CLI meant: the ids, their labels, and a few
 * common spellings ("In progress", "in-review", "completed"). Null when it is
 * none of them.
 */
export function parseWorkspaceStatusId(raw: unknown): WorkspaceStatusId | null {
  if (typeof raw !== "string") return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return STATUS_ALIASES[key] ?? null;
}

// Terminal escapes first, so their parameter bytes do not survive as text.
const ANSI_SEQUENCES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
// Invisible characters that reorder or hide text: a note must read the same
// in the rail as in the tool call that wrote it, and the next agent that
// reads it back must not get text the user never saw. Bidi marks and
// overrides, zero-width characters, word joiners and invisible operators,
// the byte order mark, and the tag characters and supplementary variation
// selectors that can carry hidden text. Written as escapes so the source
// itself holds no invisible characters.
const INVISIBLE_CHARS =
  /[\u{061c}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// A note is one short line; nothing past this many code units is ever shown,
// so a huge payload is cut before the expressions above walk it.
const NOTE_INPUT_MAX = 8_192;

function cutToCodePoints(text: string, max: number): { text: string; cut: boolean } {
  const points = Array.from(text);
  if (points.length <= max) return { text, cut: false };
  return { text: `${points.slice(0, max - 1).join("").trimEnd()}…`, cut: true };
}

/**
 * One plain line of at most WORKSPACE_STATUS_NOTE_MAX characters: terminal
 * escapes, control and invisible characters dropped, line breaks and runs of
 * whitespace folded to single spaces, and the rest cut with an ellipsis.
 */
export function sanitizeWorkspaceStatusNote(raw: unknown): { note: string; truncated: boolean } {
  if (typeof raw !== "string") return { note: "", truncated: false };
  const oversized = raw.length > NOTE_INPUT_MAX;
  const flat = (oversized ? raw.slice(0, NOTE_INPUT_MAX) : raw)
    .replace(ANSI_SEQUENCES, "")
    .replace(CONTROL_CHARS, " ")
    .replace(INVISIBLE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  const { text, cut } = cutToCodePoints(flat, WORKSPACE_STATUS_NOTE_MAX);
  return { note: text, truncated: cut || oversized };
}

export function sanitizeWorkspaceStatusAuthor(raw: unknown): WorkspaceStatusAuthor {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const kind = value.kind === "user" ? "user" : "agent";
  const label = cutToCodePoints(sanitizeWorkspaceStatusNote(value.label).note, AUTHOR_LABEL_MAX).text;
  return { kind, label: label || (kind === "user" ? "You" : "Agent") };
}

function normalizeStatusField(raw: unknown): WorkspaceStatusId | null {
  return isWorkspaceStatusId(raw) ? raw : null;
}

function normalizeNoteField(raw: unknown): string | null {
  return sanitizeWorkspaceStatusNote(raw).note || null;
}

function normalizeTime(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function normalizeCheckpoint(raw: unknown): WorkspaceStatusCheckpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const status = normalizeStatusField(value.status);
  const note = normalizeNoteField(value.note);
  if (!status && !note) return null;
  return { status, note, at: normalizeTime(value.at), by: sanitizeWorkspaceStatusAuthor(value.by) };
}

/** A stored or received entry, or null when it holds neither a status nor a note. */
export function normalizeWorkspaceStatusEntry(raw: unknown): WorkspaceStatusEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const status = normalizeStatusField(value.status);
  const note = normalizeNoteField(value.note);
  if (!status && !note) return null;
  const checkpoints = (Array.isArray(value.checkpoints) ? value.checkpoints : [])
    .map(normalizeCheckpoint)
    .filter((checkpoint): checkpoint is WorkspaceStatusCheckpoint => checkpoint !== null)
    .slice(-WORKSPACE_STATUS_CHECKPOINTS_MAX);
  return {
    status,
    note,
    updatedAt: normalizeTime(value.updatedAt),
    by: sanitizeWorkspaceStatusAuthor(value.by),
    checkpoints,
  };
}

const MAX_WORKSPACES = 1_000;

export function normalizeWorkspaceStatusMap(raw: unknown): WorkspaceStatusMap {
  const out: WorkspaceStatusMap = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let count = 0;
  for (const [workspaceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_WORKSPACES) break;
    if (!isWorkspaceIdLike(workspaceId)) continue;
    const entry = normalizeWorkspaceStatusEntry(value);
    if (!entry) continue;
    out[workspaceId] = entry;
    count += 1;
  }
  return out;
}

export function isWorkspaceIdLike(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype"
  );
}

export interface WorkspaceStatusApplied {
  entry: WorkspaceStatusEntry | null;
  changed: boolean;
  noteTruncated: boolean;
}

/**
 * The entry after `patch`. Every change that moves the status or the note
 * adds a checkpoint (the newest is the current state); repeating the current
 * state changes nothing. An entry left with neither a status nor a note is
 * removed (null).
 */
export function applyWorkspaceStatusPatch(
  current: WorkspaceStatusEntry | null,
  patch: WorkspaceStatusPatch,
  by: WorkspaceStatusAuthor,
  now: number,
): WorkspaceStatusApplied {
  if (patch.clear) return { entry: null, changed: current !== null, noteTruncated: false };
  let status = current?.status ?? null;
  let note = current?.note ?? null;
  let noteTruncated = false;
  // Callers parse the status first; anything else is ignored, never a clear.
  if (patch.status === null) status = null;
  else if (isWorkspaceStatusId(patch.status)) status = patch.status;
  if (patch.note !== undefined) {
    const sanitized = sanitizeWorkspaceStatusNote(patch.note ?? "");
    note = sanitized.note || null;
    noteTruncated = sanitized.truncated;
  }
  if (!status && !note) return { entry: null, changed: current !== null, noteTruncated };
  if (current && current.status === status && current.note === note) {
    return { entry: current, changed: false, noteTruncated };
  }
  const author = sanitizeWorkspaceStatusAuthor(by);
  const checkpoints = [...(current?.checkpoints ?? []), { status, note, at: now, by: author }].slice(
    -WORKSPACE_STATUS_CHECKPOINTS_MAX,
  );
  return { entry: { status, note, updatedAt: now, by: author, checkpoints }, changed: true, noteTruncated };
}

/** Labels for an agent runtime or an MCP client name ("claude-code", "codex-mcp-client"). */
export function workspaceStatusAgentLabel(runtimeOrClient: string | null | undefined): string {
  const value = (runtimeOrClient ?? "").toLowerCase();
  if (/claude/.test(value)) return "Claude Code";
  if (/codex/.test(value)) return "Codex";
  if (/grok/.test(value)) return "Grok";
  if (/cora/.test(value)) return "Cora";
  if (/(^|[^a-z])pi([^a-z]|$)/.test(value)) return "Pi";
  return "Agent";
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function workspaceStatusAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

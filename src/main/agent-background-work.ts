import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AgentBackgroundSummary } from "@shared/agent-board";

// Background work an agent session still owns after its own turn ended:
// Claude Code's background shells, subagents, workflows and monitors. They
// report back by themselves and wake the session, so a pane holding any of
// them is not ready, and its "finished" alert waits until they drain. The
// terminal notifier (terminal-agent-notify.ts) keeps one tracker per pane;
// nothing here is Claude specific beyond the inputs it parses.
//
// Sources, most trusted first:
//   1. Claude's Stop and SubagentStop hook input lists the session's in-flight
//      background tasks (`background_tasks`, documented as what lets a hook
//      tell "session is done" from "session is paused waiting for background
//      work to wake it"). Each list replaces the one before.
//   2. OSC 7501 child records: Claude reports each running background agent
//      or workflow under its task id and clears the record once it ends.
//   3. The session's own files, read only: a task's output file (for a
//      subagent, its transcript) grows while it works. A subagent's
//      `.meta.json` "finished" flag does not end a task here: a background
//      subagent stops and resumes many times while it waits on work of its
//      own (one fired SubagentStop a dozen times while still listed as
//      running), and Claude wakes the session when a task really ends, so the
//      next hook list is the trusted end.
//
// A shell running a long-lived service (a dev server, a watcher, `tail -f`)
// is not work the agent waits on: it never ends, and Claude is ready for the
// next prompt beside it. Such shells are tracked but never count.
//
// Nothing may keep a pane busy forever. A task stops counting once nothing
// has shown it alive (its output, its hooks, its status record, the pane
// repainting an agent's live timer) for BACKGROUND_QUIET_MS, and the notifier
// clears the tracker when the agent exits or its session changes.

export type BackgroundTaskKind = "agent" | "shell" | "workflow" | "monitor" | "other";

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  label: string | null;
  // When the task first appeared, and the newest sign that it still works.
  since: number;
  lastSignAt: number;
  // In the latest hook list / reported by a live OSC 7501 child record.
  listed: boolean;
  reported: boolean;
  // A shell running a service that never ends by itself (see the header).
  service: boolean;
}

/**
 * A task with no sign of life for this long stops counting. Agents show
 * signs constantly (hooks for every tool call, Claude repainting their live
 * timer, transcript writes), so this mostly bounds shells whose output goes
 * somewhere Codara cannot see and long-running services such as a dev server.
 */
export const BACKGROUND_QUIET_MS = 30 * 60_000;

// A task that ended stays ended this long even if a list written a moment
// before its end arrives after it (hook files and the pty are separate
// channels). A list after that window may name it again (a resumed subagent).
const ENDED_MEMORY_MS = 15_000;
const MAX_TASKS = 64;
const LABEL_MAX = 160;
// Claude's task ids are short alphanumerics; anything else is not used to
// build a file path.
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Where Claude keeps a session's subagent files and task outputs. */
export interface BackgroundSessionPaths {
  subagentsDir: string | null;
  tasksDir: string | null;
}

// Commands that start something meant to keep running: dev servers, file
// watchers, log followers, tunnels. Best effort; a miss only means the pane
// shows background work until the shell goes quiet.
const SERVICE_COMMAND_RE = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch|storybook)\b`,
    String.raw`\b(?:next|nuxt|astro|remix|tauri|electron-vite)\s+dev\b`,
    String.raw`\bnext\s+start\b`,
    String.raw`\bvite\b(?!\s+build)`,
    String.raw`\bng\s+serve\b`,
    String.raw`\bwebpack(?:-dev-server|\s+serve)\b`,
    String.raw`\b(?:nodemon|uvicorn|gunicorn|jupyter|ngrok|cloudflared|http-server|live-server)\b`,
    String.raw`\bnpx\s+serve\b`,
    String.raw`\bhttp\.server\b`,
    String.raw`\bflask\s+run\b`,
    String.raw`\brails\s+(?:s|server)\b`,
    String.raw`\bmanage\.py\s+runserver\b`,
    String.raw`\bexpo\s+start\b`,
    String.raw`\bcargo\s+watch\b`,
    String.raw`(?:^|\s)--watch(?:\s|$)`,
    String.raw`\btail\b[^|;&]*\s-[a-zA-Z]*[fF]\b`,
    String.raw`\bdocker(?:\s+compose|-compose)\s+up\b(?![^|;&]*\s(?:-d|--detach)\b)`,
  ].join("|"),
  "i",
);

export function isServiceCommand(command: unknown, description?: unknown): boolean {
  if (typeof command === "string" && SERVICE_COMMAND_RE.test(command)) return true;
  return typeof description === "string" && /\b(?:dev server|watch mode|file watcher)\b/i.test(description);
}

export function backgroundTaskKind(type: unknown): BackgroundTaskKind {
  const value = typeof type === "string" ? type.toLowerCase() : "";
  if (value === "shell" || value === "local_bash" || value === "bash") return "shell";
  if (value === "monitor") return "monitor";
  if (value === "workflow" || value === "local_workflow") return "workflow";
  if (/agent|teammate/.test(value)) return "agent";
  return "other";
}

function agentLike(kind: BackgroundTaskKind): boolean {
  return kind === "agent" || kind === "workflow";
}

function runningStatus(status: unknown): boolean {
  // Claude lists only in-flight work; a missing status counts as running.
  return typeof status !== "string" || /^(?:running|pending|in_progress|active|paused)$/i.test(status);
}

function oneLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > LABEL_MAX ? `${flat.slice(0, LABEL_MAX - 1).trimEnd()}…` : flat;
}

/**
 * Session paths from a Claude hook payload: the transcript sits at
 * `<project>/<session>.jsonl` with subagents under `<project>/<session>/
 * subagents/`, and task outputs sit in `tasks/` next to the session's
 * scratchpad directory. Either may be missing on other Claude versions.
 */
export function claudeBackgroundPaths(payload: Record<string, unknown> | null): BackgroundSessionPaths {
  const transcript = typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
  const scratchpad = typeof payload?.scratchpad_dir === "string" ? payload.scratchpad_dir : "";
  return {
    subagentsDir:
      transcript && /\.jsonl$/i.test(transcript)
        ? path.join(transcript.replace(/\.jsonl$/i, ""), "subagents")
        : null,
    tasksDir: scratchpad && path.isAbsolute(scratchpad) ? path.join(path.dirname(scratchpad), "tasks") : null,
  };
}

export class BackgroundWork {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly ended = new Map<string, number>();
  paths: BackgroundSessionPaths = { subagentsDir: null, tasksDir: null };

  get size(): number {
    return this.tasks.size;
  }

  /** Every task known, live or quiet. */
  all(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  /** Tasks that still count: no service, and something showed them alive recently. */
  live(now: number, quietMs = BACKGROUND_QUIET_MS): BackgroundTask[] {
    return this.all().filter((task) => counts(task, now, quietMs));
  }

  isActive(now: number, quietMs = BACKGROUND_QUIET_MS): boolean {
    for (const task of this.tasks.values()) {
      if (counts(task, now, quietMs)) return true;
    }
    return false;
  }

  summary(now: number, quietMs = BACKGROUND_QUIET_MS): AgentBackgroundSummary {
    const out: AgentBackgroundSummary = { agents: 0, shells: 0, other: 0 };
    for (const task of this.live(now, quietMs)) {
      if (agentLike(task.kind)) out.agents += 1;
      else if (task.kind === "shell") out.shells += 1;
      else out.other += 1;
    }
    return out;
  }

  /**
   * A hook's `background_tasks` list. Tasks it does not name are gone, unless
   * a live status record still reports them. Being listed again is not a
   * sign of life: a dev server is listed after every turn while doing
   * nothing. Returns false when the input carries no list at all.
   */
  applyHookList(list: unknown, now: number, paths?: BackgroundSessionPaths): boolean {
    if (!Array.isArray(list)) return false;
    this.pruneEnded(now);
    if (paths && (paths.subagentsDir || paths.tasksDir)) this.paths = paths;
    const named = new Set<string>();
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      if (!id || !runningStatus(entry.status) || this.ended.has(id)) continue;
      named.add(id);
      const kind = backgroundTaskKind(entry.type);
      const label = oneLabel(entry.description) ?? oneLabel(entry.name) ?? oneLabel(entry.command);
      const service = kind === "shell" && isServiceCommand(entry.command, entry.description);
      const existing = this.tasks.get(id);
      if (existing) {
        existing.kind = kind === "other" ? existing.kind : kind;
        existing.label = label ?? existing.label;
        existing.listed = true;
        existing.service = existing.kind === "shell" && (service || existing.service);
      } else if (this.tasks.size < MAX_TASKS) {
        this.tasks.set(id, { id, kind, label, since: now, lastSignAt: now, listed: true, reported: false, service });
      }
    }
    for (const [id, task] of this.tasks) {
      if (named.has(id)) continue;
      if (task.reported) task.listed = false;
      else this.tasks.delete(id);
    }
    return true;
  }

  /** An OSC 7501 child record: the program reports this task as running. */
  applyStatusChild(id: string, label: string | null, now: number): void {
    if (!id) return;
    this.pruneEnded(now);
    if (this.ended.has(id)) return;
    const existing = this.tasks.get(id);
    if (existing) {
      existing.reported = true;
      existing.lastSignAt = Math.max(existing.lastSignAt, now);
      existing.label = existing.label ?? oneLabel(label);
      return;
    }
    if (this.tasks.size >= MAX_TASKS) return;
    // Child records exist for agents, teammates and workflows only.
    this.tasks.set(id, {
      id,
      kind: "agent",
      label: oneLabel(label),
      since: now,
      lastSignAt: now,
      listed: false,
      reported: true,
      service: false,
    });
  }

  /** The program cleared every child record (it is shutting its UI down). */
  clearStatusChildren(): void {
    for (const [id, task] of this.tasks) {
      if (!task.reported) continue;
      task.reported = false;
      if (!task.listed) this.tasks.delete(id);
    }
  }

  /** The task ended: its status record was cleared. */
  end(id: string, now: number): boolean {
    this.ended.set(id, now);
    return this.tasks.delete(id);
  }

  /** Something shows this task still works (its hooks, its files). */
  noteTaskSign(id: string, at: number): void {
    const task = this.tasks.get(id);
    if (task && at > task.lastSignAt) task.lastSignAt = at;
  }

  /**
   * The agent's screen repainted. Claude redraws a running background
   * agent's elapsed time every second, so that counts for agents; a shell's
   * row is static and the bytes could be anything else.
   */
  noteScreenSign(at: number): void {
    for (const task of this.tasks.values()) {
      if (agentLike(task.kind) && at > task.lastSignAt) task.lastSignAt = at;
    }
  }

  clear(): void {
    this.tasks.clear();
    this.ended.clear();
    this.paths = { subagentsDir: null, tasksDir: null };
  }

  private pruneEnded(now: number): void {
    for (const [id, at] of this.ended) {
      if (now - at > ENDED_MEMORY_MS) this.ended.delete(id);
    }
  }
}

function counts(task: BackgroundTask, now: number, quietMs: number): boolean {
  return !task.service && now - task.lastSignAt < quietMs;
}

export interface BackgroundFileSign {
  id: string;
  modifiedAt: number | null;
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    const stats = await fs.stat(file);
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * When each task's files last changed. Read only (stat), and every failure
 * (a moved home, another Claude version's layout) just yields no sign: the
 * hook lists and the quiet window still decide.
 */
export async function probeBackgroundFiles(
  paths: BackgroundSessionPaths,
  tasks: readonly Pick<BackgroundTask, "id" | "kind" | "service">[],
): Promise<BackgroundFileSign[]> {
  const out: BackgroundFileSign[] = [];
  for (const task of tasks) {
    if (task.service || !SAFE_ID_RE.test(task.id)) continue;
    let modifiedAt: number | null = null;
    if (paths.tasksDir) modifiedAt = await mtimeOf(path.join(paths.tasksDir, `${task.id}.output`));
    if (task.kind === "agent" && paths.subagentsDir) {
      const transcript = await mtimeOf(path.join(paths.subagentsDir, `agent-${task.id}.jsonl`));
      if (transcript !== null && (modifiedAt === null || transcript > modifiedAt)) modifiedAt = transcript;
    }
    out.push({ id: task.id, modifiedAt });
  }
  return out;
}

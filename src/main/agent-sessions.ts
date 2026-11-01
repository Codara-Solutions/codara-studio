// Sessions one agent starts for another (codara_session_start and friends).
// The agent runs in an ordinary agent-owned terminal: terminal.create opens
// it, the cross-workspace approval and the ownership ledger apply as for any
// terminal, and the pane's notifier reports its state. All this module adds
// is the record that outlives the caller and the pane: who asked, and how the
// last turn ended, so a later session in that workspace can still find it.
//
// The brief travels in a private file and never through a shell's quoting:
// the command line names only the file. Records hold what the agents said,
// so the file is the user's alone, like the session transcripts it summarizes.
//
// Electron-free: agent-socket.ts wires the live pane state, the unit suite
// (scripts/test-agent-sessions.cjs) fakes it.

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import {
  AGENT_SESSION_BRIEF_MAX_CHARS,
  AGENT_SESSION_EFFORTS,
  AGENT_SESSION_LIST_MESSAGE_CHARS,
  AGENT_SESSION_MAX_LIVE,
  AGENT_SESSION_MESSAGE_MAX_CHARS,
  AGENT_SESSION_RUNTIMES,
  AGENT_SESSION_WAIT_DEFAULT_SECONDS,
  AGENT_SESSION_WAIT_MAX_SECONDS,
  agentSessionLive,
  agentSessionSettled,
  agentSessionState,
  type AgentSessionLive,
  type AgentSessionRecord,
  type AgentSessionRuntime,
  type AgentSessionState,
  type AgentSessionStatus,
} from "@shared/agent-sessions";
import { tabLink } from "@shared/tab-links";
import { writeFileAtomic } from "./fs-atomic";
import { buildStandingTerminalCommand } from "./orchestration/standing-terminals";

export const AGENT_SESSIONS_FILE = "agent-sessions.json";
export const AGENT_SESSION_BRIEFS_DIR = "agent-session-briefs";
const FILE_VERSION = 1;
const MAX_RECORDS = 200;
const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const WAIT_POLL_MS = 500;
const MAX_EARLY_TURN_ENDS = 32;
// The value lands in a shell line, quoted: a leading dash would still read as a flag.
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+[\]-]{0,127}$/;
const TITLE_MAX = 60;
const SAFE_ID = /^as-[A-Za-z0-9-]{1,64}$/;

export interface AgentSessionStartRequest {
  brief: string;
  runtime: AgentSessionRuntime;
  model: string | null;
  effort: string | null;
  title: string;
}

/** The request, or why it is refused. */
export function parseAgentSessionStart(params: Record<string, unknown>): AgentSessionStartRequest | string {
  const { brief, runtime, model, effort, title } = params;
  if (typeof brief !== "string" || !brief.trim()) return "brief is required";
  if (brief.length > AGENT_SESSION_BRIEF_MAX_CHARS) {
    return `brief is limited to ${AGENT_SESSION_BRIEF_MAX_CHARS} characters; put the rest in a file and name it in the brief`;
  }
  if (brief.includes("\0")) return "brief cannot contain NUL characters";
  if (!AGENT_SESSION_RUNTIMES.includes(runtime as AgentSessionRuntime)) {
    return `runtime must be one of ${AGENT_SESSION_RUNTIMES.join(", ")}`;
  }
  if (model !== undefined && model !== null && (typeof model !== "string" || !SAFE_MODEL.test(model))) {
    return "model must be a plain model name";
  }
  if (
    effort !== undefined &&
    effort !== null &&
    !AGENT_SESSION_EFFORTS.includes(effort as (typeof AGENT_SESSION_EFFORTS)[number])
  ) {
    return `effort must be one of ${AGENT_SESSION_EFFORTS.join(", ")}`;
  }
  if (title !== undefined && title !== null && typeof title !== "string") return "title must be a string";
  const named = typeof title === "string" ? title.trim() : "";
  const firstLine = brief.trim().split("\n", 1)[0]?.trim() ?? "";
  return {
    brief,
    runtime: runtime as AgentSessionRuntime,
    model: typeof model === "string" ? model : null,
    effort: typeof effort === "string" ? effort : null,
    title: (named || firstLine).slice(0, TITLE_MAX),
  };
}

function shellQuote(value: string, platform: NodeJS.Platform): string {
  return platform === "win32"
    ? `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The line typed into the new pane. A command substitution puts the brief in
 * as one argument however it is written, so the agent's first message is the
 * brief itself. PowerShell has no form that survives every quote in a native
 * argument, so there the agent is told to read the file.
 */
export function agentSessionCommand(input: {
  runtime: AgentSessionRuntime;
  model: string | null;
  effort: string | null;
  briefPath: string;
  codexTrust: string | null;
  compaction?: { codexTokenLimit?: number | null; claudeSettingsPath?: string | null };
  platform?: NodeJS.Platform;
}): string {
  const platform = input.platform ?? process.platform;
  const parts = [
    buildStandingTerminalCommand(
      input.runtime,
      input.model ?? undefined,
      input.effort ?? undefined,
      input.compaction,
    ),
  ];
  // Nobody can answer Codex's trust prompt for an agent started this way.
  if (input.runtime === "codex" && input.codexTrust) parts.push("-c", shellQuote(input.codexTrust, platform));
  parts.push(
    platform === "win32"
      ? shellQuote(`Read the file ${input.briefPath} and do what it says.`, platform)
      : `"$(cat ${shellQuote(input.briefPath, platform)})"`,
  );
  return parts.join(" ");
}

export interface AgentSessionView {
  id: string;
  status: AgentSessionStatus;
  detail: string | null;
  runtime: AgentSessionRuntime;
  model: string | null;
  effort: string | null;
  title: string;
  workspaceId: string;
  workspace: string;
  cwd: string;
  branch: string | null;
  paneId: string;
  tabId: string;
  link: string;
  startedAt: string;
  finishedAt: string | null;
  tool: string | null;
  finalMessage: string | null;
  finalMessageCut?: boolean;
}

export interface AgentSessionTurnEnd {
  paneId: string;
  failed: boolean;
  message: string | null;
  at: number;
}

export type AgentSessionCaller = { workspaceId: string | null; process: string | null };

export interface AgentSessionsDeps {
  /** Folder for the record file and the brief files. */
  dir: string;
  live(paneId: string): AgentSessionLive | null;
  now?(): number;
  bootAt?: number;
  log?(message: string): void;
}

export interface AgentSessionWaitResult {
  reason: "any_settled" | "all_settled" | "timeout" | "cancelled";
  sessions: AgentSessionView[];
}

function validRecord(value: unknown): value is AgentSessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    SAFE_ID.test(record.id) &&
    AGENT_SESSION_RUNTIMES.includes(record.runtime as AgentSessionRuntime) &&
    typeof record.paneId === "string" &&
    typeof record.tabId === "string" &&
    typeof record.workspaceId === "string" &&
    typeof record.startedAt === "number" &&
    typeof record.promptAt === "number"
  );
}

export class AgentSessions {
  private readonly records = new Map<string, AgentSessionRecord>();
  private loaded: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private reserved = 0;
  // A quick turn can end before terminal.create returns and its record exists.
  private readonly earlyTurnEnds = new Map<string, AgentSessionTurnEnd>();
  private readonly now: () => number;
  private readonly bootAt: number;

  constructor(private readonly deps: AgentSessionsDeps) {
    this.now = deps.now ?? Date.now;
    this.bootAt = deps.bootAt ?? this.now();
  }

  private get file(): string {
    return join(this.deps.dir, AGENT_SESSIONS_FILE);
  }

  private briefPath(id: string): string {
    return join(this.deps.dir, AGENT_SESSION_BRIEFS_DIR, `${id}.md`);
  }

  load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    const stat = await fsp.lstat(this.file).catch(() => null);
    if (stat?.isFile() && stat.size <= MAX_FILE_BYTES) {
      try {
        const parsed = JSON.parse(await fsp.readFile(this.file, "utf8")) as { sessions?: unknown };
        for (const entry of Array.isArray(parsed?.sessions) ? parsed.sessions : []) {
          if (validRecord(entry)) this.records.set(entry.id, entry);
        }
      } catch {
        this.deps.log?.("agent-sessions: unreadable record file, starting empty");
      }
    }
    this.prune();
    // A brief is needed only until its first turn ends. A crash can leave one
    // behind, and a brief is private text with no other reader.
    const dir = join(this.deps.dir, AGENT_SESSION_BRIEFS_DIR);
    for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
      const id = name.replace(/\.md$/, "");
      const record = this.records.get(id);
      if (!record || record.turnEndedAt !== null || record.closedAt !== null) {
        await fsp.rm(join(dir, name), { force: true }).catch(() => undefined);
      }
    }
  }

  private prune(): void {
    const cutoff = this.now() - MAX_RECORD_AGE_MS;
    for (const record of this.records.values()) {
      if (record.startedAt < cutoff) this.records.delete(record.id);
    }
    const excess = this.records.size - MAX_RECORDS;
    if (excess <= 0) return;
    const oldest = [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt);
    for (const record of oldest.slice(0, excess)) this.records.delete(record.id);
  }

  private persist(): Promise<void> {
    const body = `${JSON.stringify({ version: FILE_VERSION, sessions: [...this.records.values()] })}\n`;
    const next = this.writes.then(
      () => writeFileAtomic(this.file, body, { mode: 0o600 }),
      () => writeFileAtomic(this.file, body, { mode: 0o600 }),
    );
    this.writes = next.catch((error: unknown) => {
      this.deps.log?.(`agent-sessions: could not save records: ${String(error)}`);
    });
    return this.writes as Promise<void>;
  }

  /** Flushes pending writes, for tests and for quit. */
  async flush(): Promise<void> {
    await this.writes.catch(() => undefined);
  }

  /**
   * Holds one place under the live cap while a start is under way, so calls
   * made together cannot all pass it. Null when the cap is reached; the
   * caller releases the place once the record exists or the start failed.
   */
  reserve(): (() => void) | null {
    const live = [...this.records.values()].filter((record) => agentSessionLive(this.state(record).status)).length;
    if (live + this.reserved >= AGENT_SESSION_MAX_LIVE) return null;
    this.reserved += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reserved -= 1;
    };
  }

  async writeBrief(id: string, brief: string): Promise<string> {
    const path = this.briefPath(id);
    await fsp.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFileAtomic(path, brief, { mode: 0o600 });
    return path;
  }

  async removeBrief(id: string): Promise<void> {
    await fsp.rm(this.briefPath(id), { force: true }).catch(() => undefined);
  }

  add(record: AgentSessionRecord): Promise<void> {
    this.records.set(record.id, record);
    this.prune();
    const early = this.earlyTurnEnds.get(record.paneId);
    this.earlyTurnEnds.delete(record.paneId);
    if (early && early.at >= record.promptAt) this.applyTurnEnd(record, early);
    return this.persist();
  }

  get(id: string): AgentSessionRecord | null {
    return this.records.get(id) ?? null;
  }

  private forPane(paneId: string): AgentSessionRecord[] {
    return [...this.records.values()].filter((record) => record.paneId === paneId);
  }

  /** A turn ended in the session's pane: the answer, or how it failed. */
  noteTurnEnd(event: AgentSessionTurnEnd): void {
    const records = this.forPane(event.paneId);
    if (records.length === 0) {
      if (this.reserved === 0) return;
      if (this.earlyTurnEnds.size >= MAX_EARLY_TURN_ENDS) this.earlyTurnEnds.clear();
      this.earlyTurnEnds.set(event.paneId, event);
      return;
    }
    for (const record of records) this.applyTurnEnd(record, event);
    void this.persist();
  }

  private applyTurnEnd(record: AgentSessionRecord, event: AgentSessionTurnEnd): void {
    record.turnEndedAt = event.at;
    record.finalMessage = event.message ? event.message.slice(0, AGENT_SESSION_MESSAGE_MAX_CHARS) : null;
    record.failure = event.failed ? (event.message ?? "The turn ended with an error.") : null;
    void this.removeBrief(record.id);
  }

  notePaneClosed(paneId: string): void {
    const records = this.forPane(paneId).filter((record) => record.closedAt === null);
    if (records.length === 0) return;
    for (const record of records) {
      record.closedAt = this.now();
      void this.removeBrief(record.id);
    }
    void this.persist();
  }

  /** A follow-up went in: whatever came before no longer answers the caller. */
  notePrompt(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.promptAt = this.now();
    record.finalMessage = null;
    record.failure = null;
    void this.persist();
  }

  state(record: AgentSessionRecord): AgentSessionState {
    return agentSessionState(record, this.deps.live(record.paneId), this.now(), this.bootAt);
  }

  view(record: AgentSessionRecord, options: { cut?: boolean } = {}): AgentSessionView {
    const live = this.deps.live(record.paneId);
    const { status, detail } = this.state(record);
    const cut =
      options.cut === true &&
      record.finalMessage !== null &&
      record.finalMessage.length > AGENT_SESSION_LIST_MESSAGE_CHARS;
    return {
      id: record.id,
      status,
      detail,
      runtime: record.runtime,
      model: record.model,
      effort: record.effort,
      title: record.title,
      workspaceId: record.workspaceId,
      workspace: record.workspaceName,
      cwd: record.cwd,
      branch: record.branch,
      paneId: record.paneId,
      tabId: record.tabId,
      link: tabLink(record.workspaceId, record.tabId),
      startedAt: new Date(record.startedAt).toISOString(),
      finishedAt:
        (status === "finished" || status === "failed") && record.turnEndedAt !== null
          ? new Date(record.turnEndedAt).toISOString()
          : null,
      tool: status === "working" ? (live?.tool ?? null) : null,
      finalMessage: cut ? record.finalMessage!.slice(0, AGENT_SESSION_LIST_MESSAGE_CHARS) : record.finalMessage,
      ...(cut ? { finalMessageCut: true } : {}),
    };
  }

  /**
   * Sessions started from the caller's workspace, newest first. Any agent
   * there may read them; only the one that started a session may write to it
   * (agent-socket.ts checks that against the terminal's owner). A caller with
   * no workspace sees only what its own process started.
   */
  visibleTo(caller: AgentSessionCaller): AgentSessionRecord[] {
    return [...this.records.values()]
      .filter((record) =>
        caller.workspaceId
          ? record.callerWorkspaceId === caller.workspaceId
          : Boolean(caller.process) && record.ownerProcess === caller.process,
      )
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async wait(input: {
    records: readonly AgentSessionRecord[];
    mode: "any" | "all";
    timeoutMs: number;
    cancelled(): boolean;
    pollMs?: number;
  }): Promise<AgentSessionWaitResult> {
    const deadline = this.now() + input.timeoutMs;
    const views = () => input.records.map((record) => this.view(record));
    for (;;) {
      const sessions = views();
      const settled = sessions.filter((session) => agentSessionSettled(session.status)).length;
      if (input.mode === "any" && settled > 0) return { reason: "any_settled", sessions };
      if (input.mode === "all" && settled === sessions.length) return { reason: "all_settled", sessions };
      if (input.cancelled()) return { reason: "cancelled", sessions };
      if (this.now() >= deadline) return { reason: "timeout", sessions };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, input.pollMs ?? WAIT_POLL_MS);
        timer.unref?.();
      });
    }
  }
}

// The user typed here this recently: a paste would join their draft.
export const AGENT_SESSION_QUIET_INPUT_MS = 20_000;
export const AGENT_SESSION_LIST_LIMIT = 50;

/**
 * Why a follow-up may not go in now. Writing is typing into a live prompt, so
 * it goes in only between turns, where a turn end then answers this message
 * and no earlier one. A prompt waiting for a person is left to the person: a
 * line and Enter would answer it, and that could approve what the session
 * asked permission for. Text the user left unsent would be submitted with the
 * line; Claude parks it first (stashDraft), other agents cannot.
 */
export function agentSessionMessageRefusal(input: {
  status: AgentSessionStatus;
  runtime: string | null;
  running: boolean;
  lastUserInputAt: number;
  lastSubmitAt: number;
  now: number;
}): string | null {
  if (input.status === "closed") return "its tab was closed";
  if (input.status === "needs_you") return "it is waiting for the user, who answers in its tab";
  if (input.status === "starting" || input.status === "working") {
    return "it is working; wait for it to finish, then send this";
  }
  if (!input.running) return "it is asleep to save memory; the user must open its tab first";
  if (!input.runtime) return "its agent has exited";
  const draft = input.lastUserInputAt > input.lastSubmitAt;
  if (draft && (input.runtime !== "claude" || input.now - input.lastUserInputAt < AGENT_SESSION_QUIET_INPUT_MS)) {
    return "the user is typing in its tab; retry shortly";
  }
  return null;
}

/** A wait's length in milliseconds, or why it is refused. */
export function agentSessionWaitMs(value: unknown): number | string {
  if (value === undefined || value === null) return AGENT_SESSION_WAIT_DEFAULT_SECONDS * 1000;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "timeoutSeconds must be a number of seconds";
  }
  return Math.min(value, AGENT_SESSION_WAIT_MAX_SECONDS) * 1000;
}

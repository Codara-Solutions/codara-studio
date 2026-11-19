// A managed Cora worker run by the official Claude Code CLI instead of Pi
// (route `claude-code/`, src/shared/cora-routes.ts). Claude Code runs headless
// (`claude -p`) on the account a new Studio Claude terminal would get, with
// the codara-studio server's worker tools (no board or whiteboard writes)
// and Studio's settings without its hooks.
// Claude Code owns the loop, its tools and its compaction; Studio reads its
// stream-json output so every tool call shows in the run, and the worker
// writes the same final-report.json a Pi worker would.
//
// Credentials: this module never reads, copies, stores or repairs a login,
// and never runs the account service's credential sync. The account is chosen
// from the profile list alone (ids and labels, account-profiles.json), the
// child gets that account's CLAUDE_CONFIG_DIR and signs in itself, and
// "signed in or not" comes from `claude auth status`, Claude Code's own
// answer. Requests are never rewritten: this starts a process from an
// allowlisted environment and reads what it prints.
// scripts/test-claude-code-worker.cjs checks the import graph and spies on
// the file system for login records during a launch.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { scrubSecrets } from "@shared/memory-items";
import { psTimeEnvironment } from "../owned-process-tree";
import { CODARA_CLAUDE_CLI_DIRNAME, codaraHomeDir, isCodaraManagedCliPath } from "./codara-managed-cli-roots";
import { CLAUDE_CLI_PERSONAL_PROFILE_ID, isClaudeCliManagedProfileId } from "./claude-cli-profile-ids";

const CLAUDE_CODE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The effort as Claude Code's `--effort` takes it, or undefined. */
export function claudeCodeEffortFlag(effort: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return effort && CLAUDE_CODE_EFFORTS.has(effort) ? (effort as "low" | "medium" | "high" | "xhigh" | "max") : undefined;
}

export type ClaudeCodeEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "tool"; name: string }
  | { kind: "tool_failed" }
  | { kind: "text"; text: string }
  | {
      kind: "result";
      ok: boolean;
      usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
      sessionId?: string;
    };

/** One headless worker turn: Studio's launch args (hooks, codara-studio
 *  server), the provider flags Studio's own Claude sessions use, then
 *  stream-json output and the attempt folder for the report. The prompt goes
 *  in on stdin. */
export function claudeCodeWorkerArgv(input: {
  launchArgs: readonly string[];
  providerArgs: readonly string[];
  attemptDir: string;
}): string[] {
  return [...input.launchArgs, ...input.providerArgs,
    "-p", "--output-format", "stream-json", "--verbose", "--add-dir", input.attemptDir];
}

/** `claude-opus-5@high` as the values of Claude Code's model and effort flags. */
export function claudeCodeModelAndEffort(model: string, fallbackEffort: string | undefined) {
  const at = model.indexOf("@");
  if (at < 0) return { model, effort: fallbackEffort };
  return { model: model.slice(0, at), effort: model.slice(at + 1) || fallbackEffort };
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
function oneLine(text: unknown, max: number): string {
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Text bound for the pane and the worker log: secrets replaced (the app's
 *  scrubber) before it is cut, so a key cut in half cannot slip through. */
function safeLine(text: unknown, max: number): string {
  return oneLine(typeof text === "string" ? scrubSecrets(text) : "", max);
}

/** A tool's name as it may be shown and logged: Claude Code's own tool and
 *  MCP tool names fit this; anything else is just "tool". */
function toolName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(name) ? name : "tool";
}

/** The pane and log line for a tool call: its name only. Its input (a
 *  command, a path, a query) is never kept. */
export function claudeCodeToolLine(event: { name: string }): string {
  return event.name;
}

/** The events one line of Claude Code's stream-json output carries. */
export function parseClaudeCodeStreamLine(line: string): ClaudeCodeEvent[] {
  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(line));
  } catch {
    return [];
  }
  if (!event) return [];
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    return [{ kind: "session", sessionId: event.session_id }];
  }
  const content = record(event.message)?.content;
  const blocks = (Array.isArray(content) ? content : []).map(record);
  if (event.type === "assistant") {
    return blocks.flatMap((block): ClaudeCodeEvent[] => {
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return [{ kind: "tool", name: toolName(block.name) }];
      }
      return block?.type === "text" && typeof block.text === "string" && block.text.trim()
        ? [{ kind: "text", text: safeLine(block.text, 700) }]
        : [];
    });
  }
  if (event.type === "user") {
    // A failed tool's output is not kept, only that it failed.
    return blocks
      .filter((block) => block?.type === "tool_result" && block.is_error === true)
      .map((): ClaudeCodeEvent => ({ kind: "tool_failed" }));
  }
  if (event.type !== "result") return [];
  const usage = record(event.usage);
  return [{
    kind: "result",
    ok: event.is_error !== true && event.subtype === "success",
    usage: {
      input: count(usage?.input_tokens),
      output: count(usage?.output_tokens),
      cacheRead: count(usage?.cache_read_input_tokens),
      cacheWrite: count(usage?.cache_creation_input_tokens),
    },
    ...(typeof event.session_id === "string" ? { sessionId: event.session_id } : {}),
  }];
}

export interface ClaudeCodeProcess {
  /** The turn's end. `cleanedUp` is false when something the turn started
   *  could not be confirmed gone (the caller then keeps its hold and starts
   *  nothing more). */
  done: Promise<{ exitCode: number; stderrTail: string; cleanedUp: boolean }>;
  /** Stop Claude Code and every process it started. True only once a
   *  process listing confirmed none is left; false when something still
   *  lived at the deadline or the listing could not be read. */
  kill(): Promise<boolean>;
}

const DRAIN_AFTER_EXIT_MS = 1_000;
const teardownTiming = {
  /** SIGTERM first, then this long before SIGKILL. */
  graceMs: 3_000,
  /** How long SIGKILL and the check are retried before teardown is
   *  reported incomplete. */
  killDeadlineMs: 30_000,
  pollMs: 100,
};

/** One row of the teardown listing. `sessionId` is -1 where `ps` has no
 *  session column (macOS). */
export interface ClaudeCodeListedProcess {
  pid: number;
  parentPid: number;
  groupId: number;
  sessionId: number;
  zombie: boolean;
  startedAt: string;
}

const TEARDOWN_PS_TIMEOUT_MS = 3_000;
const LINUX_PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;
const OTHER_PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/;

/** Every process's pid, parent, group, session, state and start time. Null
 *  when `ps` failed or timed out: never an empty list in its place. Only
 *  these columns are read, never a command line or an environment. */
function listProcessesForTeardown(): ClaudeCodeListedProcess[] | null {
  const linux = process.platform === "linux";
  const result = spawnSync("ps", ["-axo", linux ? "pid=,ppid=,pgid=,sid=,stat=,lstart=" : "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8",
    env: psTimeEnvironment(),
    timeout: TEARDOWN_PS_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || !result.stdout.trim()) return null;
  const rows: ClaudeCodeListedProcess[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = (linux ? LINUX_PS_LINE : OTHER_PS_LINE).exec(line);
    if (!match) continue;
    const [pid, parentPid, groupId] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const sessionId = linux ? Number(match[4]) : -1;
    const stat = linux ? match[5] : match[4];
    rows.push({ pid, parentPid, groupId, sessionId, zombie: stat.startsWith("Z"), startedAt: (linux ? match[6] : match[5]).trim() });
  }
  return rows.length > 0 ? rows : null;
}

let processListing: () => ClaudeCodeListedProcess[] | null = listProcessesForTeardown;

/** Tests only: the ownership rules of a teardown, without signals. `root`
 *  is what the start recorded: the root's start time and the last moment
 *  it was known alive. */
export function claudeCodeOwnedProcessesForTests(
  rootPid: number,
  root?: { startedAt?: string; heldUntil: number },
): {
  members(listing: readonly ClaudeCodeListedProcess[], listedAt?: number): ClaudeCodeListedProcess[];
  readonly ambiguous: readonly ClaudeCodeListedProcess[];
} {
  return new OwnedProcesses(rootPid, root);
}

/** Tests only: replace the teardown listing (null restores `ps`) and shorten
 *  the teardown timing. */
export function setClaudeCodeTeardownForTests(input: {
  listing?: ((real: () => ClaudeCodeListedProcess[] | null) => ClaudeCodeListedProcess[] | null) | null;
  graceMs?: number;
  killDeadlineMs?: number;
} | null): void {
  processListing = input?.listing ? () => input.listing!(listProcessesForTeardown) : listProcessesForTeardown;
  teardownTiming.graceMs = input?.graceMs ?? 3_000;
  teardownTiming.killDeadlineMs = input?.killDeadlineMs ?? 30_000;
}

/** `ps` prints start times to the second, and the clock it derives them
 *  from may sit a second off the wall clock: a start this close to a moment
 *  is neither before nor after it. */
const START_MARGIN_S = 1;
function startSecond(startedAt: string): number {
  const ms = Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Number.NaN;
}
/** Surely started before `moment` (ms). False when the stamp is unreadable. */
const startedBefore = (startedAt: string, moment: number): boolean =>
  startSecond(startedAt) < Math.floor(moment / 1000) - START_MARGIN_S;
/** Surely started after `moment` (ms). False when the stamp is unreadable. */
const startedAfter = (startedAt: string, moment: number): boolean =>
  startSecond(startedAt) > Math.floor(moment / 1000) + START_MARGIN_S;

/** A process group or session the worker held. */
interface HeldId {
  /** The start time of the process whose pid is this id, once it was seen
   *  as the worker's. */
  leader?: string;
  /** The last moment (ms) one of the worker's processes was seen in it. */
  heldUntil: number;
}

/**
 * Everything a worker started, by identity: a pid together with its start
 * time, so a pid the system hands to another process is never taken for
 * the worker's. Claude Code is spawned detached, so it leads a new session
 * and a new process group. In each listing:
 *   - a process is the worker's when its pid and start time are one already
 *     seen as the worker's, or its parent is the worker's in this listing;
 *   - a group or session one of the worker's processes is in now is the
 *     worker's, and so is everything else in it (an id cannot be handed on
 *     while a process still uses it);
 *   - a process in a session the worker held that surely started before the
 *     last moment the session was seen held was born into it (a process
 *     joins a session only at birth or by leading a new one), so it is the
 *     worker's: this finds a helper left by a tool that exited;
 *   - the process whose pid is a held id, with another start time than that
 *     id's known leader or surely started after the id was last held, shows
 *     the id was handed on: it is dropped, and nothing is adopted by it;
 *   - anything else in a held group or session cannot be told apart: it is
 *     never signalled, and while it lives the teardown is not confirmed (the
 *     caller keeps its account hold).
 * Only pids, parents, groups, sessions, states and start times are read
 * (`ps`), never a command line or an environment.
 *
 * What this cannot reach: a process that starts a new session of its own
 * (setsid) after its last known ancestor exited and before any listing saw
 * it. That needs an OS container (a cgroup); the teardown then reports
 * nothing left only for what it can see. And a signal goes to a pid the
 * listing just confirmed, a moment later: the system could hand that pid on
 * in between only by running through every other free pid first.
 */
class OwnedProcesses {
  private readonly known = new Map<number, string>();
  private readonly groups = new Map<number, HeldId>();
  private readonly sessions = new Map<number, HeldId>();
  /** Groups one of the worker's processes was in at the last listing: the
   *  only groups signalled by their id. */
  private confirmedGroups = new Set<number>();
  /** Processes in a held group or session at the last listing that could
   *  not be told to be the worker's. */
  ambiguous: ClaudeCodeListedProcess[] = [];

  constructor(private readonly rootPid: number, root?: { startedAt?: string; heldUntil: number }) {
    const held = (): HeldId => ({ ...(root?.startedAt ? { leader: root.startedAt } : {}), heldUntil: root?.heldUntil ?? 0 });
    this.groups.set(rootPid, held());
    if (process.platform === "linux") this.sessions.set(rootPid, held());
    if (root?.startedAt) this.known.set(rootPid, root.startedAt);
  }

  /** The root has not exited yet at `moment`: its group and session are
   *  still the worker's then. */
  holdRoot(moment: number): void {
    for (const held of [this.groups.get(this.rootPid), this.sessions.get(this.rootPid)]) {
      if (held && moment > held.heldUntil) held.heldUntil = moment;
    }
  }

  /** The worker's live processes in `listing` (taken at `listedAt`),
   *  learning every new one; `ambiguous` holds what could not be told. */
  members(listing: readonly ClaudeCodeListedProcess[], listedAt = Date.now()): ClaudeCodeListedProcess[] {
    const byPid = new Map(listing.map((row) => [row.pid, row] as const));
    // A held id whose own pid is now another process: handed on.
    for (const held of [this.groups, this.sessions]) {
      for (const [id, entry] of [...held]) {
        const leader = byPid.get(id);
        if (!leader) continue;
        const handedOn = entry.leader !== undefined
          ? leader.startedAt !== entry.leader
          : startedAfter(leader.startedAt, entry.heldUntil);
        if (handedOn) held.delete(id);
      }
    }
    const owned = new Map<number, ClaudeCodeListedProcess>();
    const ownGroups = new Set<number>();
    const ownSessions = new Set<number>();
    const leads = (row: ClaudeCodeListedProcess, id: number, entry: HeldId | undefined): boolean =>
      entry !== undefined && row.pid === id &&
      (entry.leader !== undefined ? entry.leader === row.startedAt : startedBefore(row.startedAt, entry.heldUntil));
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of listing) {
        if (owned.has(row.pid) || row.pid <= 1 || row.pid === process.pid) continue;
        const group = this.groups.get(row.groupId);
        const session = row.sessionId > 1 ? this.sessions.get(row.sessionId) : undefined;
        const ours =
          this.known.get(row.pid) === row.startedAt ||
          owned.has(row.parentPid) ||
          (row.groupId > 1 && ownGroups.has(row.groupId)) ||
          (row.sessionId > 1 && ownSessions.has(row.sessionId)) ||
          leads(row, row.groupId, group) ||
          leads(row, row.sessionId, session) ||
          (session !== undefined && startedBefore(row.startedAt, session.heldUntil));
        if (!ours) continue;
        owned.set(row.pid, row);
        if (row.groupId > 1) ownGroups.add(row.groupId);
        if (row.sessionId > 1) ownSessions.add(row.sessionId);
        grew = true;
      }
    }
    for (const row of owned.values()) this.known.set(row.pid, row.startedAt);
    for (const pid of [...this.known.keys()]) if (!owned.has(pid)) this.known.delete(pid);
    for (const [ids, held] of [[ownGroups, this.groups], [ownSessions, this.sessions]] as const) {
      for (const id of ids) {
        const entry = held.get(id) ?? { heldUntil: 0 };
        entry.heldUntil = Math.max(entry.heldUntil, listedAt);
        const leader = owned.get(id);
        if (leader && entry.leader === undefined) entry.leader = leader.startedAt;
        held.set(id, entry);
      }
    }
    const live = [...owned.values()].filter((row) => !row.zombie);
    // An id with no live process left is retired: nothing can join it
    // again. One with only processes that could not be told stays held, so
    // they keep counting.
    const running = listing.filter((row) => !row.zombie);
    const liveGroups = new Set(running.map((row) => row.groupId));
    const liveSessions = new Set(running.map((row) => row.sessionId));
    for (const id of [...this.groups.keys()]) if (!liveGroups.has(id)) this.groups.delete(id);
    for (const id of [...this.sessions.keys()]) if (!liveSessions.has(id)) this.sessions.delete(id);
    this.confirmedGroups = new Set(live.map((row) => row.groupId).filter((id) => id > 1));
    this.ambiguous = running.filter((row) =>
      !owned.has(row.pid) && row.pid > 1 && row.pid !== process.pid &&
      (this.groups.has(row.groupId) || (row.sessionId > 1 && this.sessions.has(row.sessionId))));
    return live;
  }

  /**
   * Signal what the listing just taken confirmed: each of the worker's
   * processes by pid, and each group one of them is in. When that listing
   * failed, only the root's group, and only while the root has not exited
   * (its pid, and so its group id, cannot be handed on before that).
   */
  signal(sig: NodeJS.Signals, members: readonly ClaudeCodeListedProcess[] | null, rootAlive: boolean): void {
    const groups = new Set(members === null ? [] : this.confirmedGroups);
    if (rootAlive) groups.add(this.rootPid);
    for (const group of groups) {
      try {
        process.kill(-group, sig);
      } catch {
        // Gone already.
      }
    }
    for (const member of members ?? []) {
      try {
        process.kill(member.pid, sig);
      } catch {
        // Exited between the listing and the signal.
      }
    }
  }
}

/** What the start of a process recorded about it, for its teardown. */
interface OwnedRoot {
  pid: number | undefined;
  /** Its start time, read right after it was spawned (its pid cannot be
   *  handed on before Node reaps it). */
  startedAt?: string;
  /** False once it exited (and was reaped). */
  alive: () => boolean;
  /** The last moment it was alive: now, or when it exited. */
  heldUntil: () => number;
}

/**
 * End everything a worker started: SIGTERM, a grace period, then SIGKILL
 * retried until the deadline. Every round lists processes again, so a
 * helper born during teardown is found and ended too. A listing that fails
 * or times out counts as "may still be alive", never as "gone", and so does
 * a process that cannot be told to be the worker's or not: the result is
 * true only once a listing confirmed nothing of either is left.
 */
async function stopProcessTree(root: OwnedRoot): Promise<boolean> {
  const pid = root.pid;
  if (!pid) return true;
  if (process.platform === "win32") {
    // Best effort, never proof: taskkill's status does not show that a
    // child whose parent already exited is gone. (Workers do not run on
    // Windows yet: claudeCodeWorkerSupported.)
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    return false;
  }
  const owned = new OwnedProcesses(pid, { startedAt: root.startedAt, heldUntil: root.heldUntil() });
  const pause = () => new Promise((resolve) => setTimeout(resolve, teardownTiming.pollMs));
  /** The live members now; null when that cannot be told. */
  const look = (): ClaudeCodeListedProcess[] | null => {
    const listedAt = Date.now();
    if (root.alive()) owned.holdRoot(listedAt);
    const listing = processListing();
    return listing ? owned.members(listing, listedAt) : null;
  };
  const unsettled = (members: readonly ClaudeCodeListedProcess[] | null) =>
    members === null || members.length > 0 || owned.ambiguous.length > 0;
  const termed = new Set<string>();
  const term = (members: readonly ClaudeCodeListedProcess[]) => {
    const fresh = members.filter((member) => !termed.has(`${member.pid}@${member.startedAt}`));
    for (const member of fresh) termed.add(`${member.pid}@${member.startedAt}`);
    return fresh;
  };
  // Nothing is signalled before a listing has shown the tree: ending Claude
  // Code first would orphan a process that left its group before anyone saw
  // it. Each listing then SIGTERMs what it shows for the first time.
  let listedOnce = false;
  const termRound = (members: readonly ClaudeCodeListedProcess[] | null) => {
    if (members === null) return;
    const fresh = term(members);
    if (!listedOnce) {
      listedOnce = true;
      owned.signal("SIGTERM", fresh, root.alive());
      return;
    }
    for (const member of fresh) {
      try {
        process.kill(member.pid, "SIGTERM");
      } catch {
        // Exited already.
      }
    }
  };
  let last = look();
  termRound(last);
  const graceEnd = Date.now() + teardownTiming.graceMs;
  while (Date.now() < graceEnd && unsettled(last)) {
    await pause();
    last = look();
    termRound(last);
  }
  // A process that could not be told apart is never signalled, so only
  // the worker's own are waited on past the grace period.
  // Each round signals exactly what its own listing just showed.
  const killEnd = Date.now() + teardownTiming.killDeadlineMs;
  while (last === null || last.length > 0) {
    if (Date.now() >= killEnd) break;
    const now = look();
    last = now;
    if (now !== null) {
      listedOnce = true;
      if (now.length === 0) break;
      owned.signal("SIGKILL", now, root.alive());
    }
    await pause();
  }
  // No listing ever worked: Claude Code's own group is still ended (its id
  // is its own until it exits); the result stays unconfirmed.
  if (!listedOnce && last === null) owned.signal("SIGKILL", null, root.alive());
  // Only Linux lists sessions, which is what finds a helper that left its
  // group before any listing saw it; elsewhere "nothing left" is not proven.
  return claudeCodeWorkerSupported() && !unsettled(last);
}

/**
 * Claude Code workers run where their teardown can confirm that nothing is
 * left: Linux, whose process listing carries the session. macOS lists no
 * session id and Windows has no listing here, so the route is not offered
 * there yet.
 */
export function claudeCodeWorkerSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux";
}

/**
 * Start a process that leads its own session and process group, and own
 * everything it starts: `kill()` ends all of it, and `done` comes once the
 * process exited and its teardown settled. Its start time is read at once,
 * while its pid cannot be handed on, so the teardown knows it by identity.
 */
function startOwnedProcess(input: {
  binary: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Written to stdin and closed; null leaves stdin closed. */
  stdin: string | null;
  onStdout: (chunk: string) => void;
  /** Called once with any output left unterminated at the end. */
  onEnd?: () => void;
}): ClaudeCodeProcess {
  const child: ChildProcess = spawn(input.binary, [...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdio: [input.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let exitedAt: number | null = null;
  child.once("exit", () => {
    exitedAt = Date.now();
  });
  const root: OwnedRoot = {
    pid: child.pid,
    startedAt: child.pid ? processListing()?.find((row) => row.pid === child.pid)?.startedAt : undefined,
    alive: () => exitedAt === null,
    heldUntil: () => exitedAt ?? Date.now(),
  };
  let stopping: Promise<boolean> | null = null;
  const stopTree = () => (stopping ??= stopProcessTree(root));
  let stderrTail = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => input.onStdout(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
  });
  if (child.stdin) {
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.stdin ?? "");
  }
  const done = new Promise<{ exitCode: number; stderrTail: string; cleanedUp: boolean }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number, cleanedUp: boolean) => {
      if (settled) return;
      settled = true;
      input.onEnd?.();
      resolve({ exitCode, stderrTail: safeLine(stderrTail, 2_000), cleanedUp });
    };
    child.on("error", (error) => {
      stderrTail = `${stderrTail}\n${error.message}`.slice(-2_000);
      // Nothing started without a pid; with one, its teardown decides.
      if (!child.pid) finish(127, true);
      else void stopTree().then((clean) => finish(127, clean), () => finish(127, false));
    });
    // The process ends with nothing it started still running. A background
    // process left holding its output would keep "close" from ever firing,
    // so the exit also ends the tree after a moment to drain.
    const end = (code: number | null, signal: NodeJS.Signals | null) => {
      const exitCode = code ?? (signal ? 130 : 1);
      void stopTree().then((clean) => finish(exitCode, clean), () => finish(exitCode, false));
    };
    child.on("close", end);
    child.on("exit", (code, signal) => {
      setTimeout(() => end(code, signal), DRAIN_AFTER_EXIT_MS).unref?.();
    });
  });
  return { done, kill: stopTree };
}

/** Start Claude Code, hand it the prompt on stdin, and report each event.
 *  It leads its own session and process group, so Stop and the end of the
 *  turn reach everything it started. */
export function startClaudeCodeWorker(input: {
  binary: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  onEvent: (event: ClaudeCodeEvent) => void;
}): ClaudeCodeProcess {
  let buffered = "";
  const emit = (line: string) => {
    for (const event of parseClaudeCodeStreamLine(line)) {
      try {
        input.onEvent(event);
      } catch {
        // A display failure must not end the worker.
      }
    }
  };
  return startOwnedProcess({
    binary: input.binary,
    argv: input.argv,
    env: input.env,
    cwd: input.cwd,
    stdin: input.prompt,
    onStdout: (chunk) => {
      const lines = (buffered + chunk).split("\n");
      buffered = lines.pop() ?? "";
      lines.forEach(emit);
    },
    onEnd: () => {
      if (buffered.trim()) emit(buffered);
      buffered = "";
    },
  });
}

/**
 * The worker's environment, built from an allowlist rather than from
 * Studio's own: no provider keys or base URLs, and none of the session
 * markers an enclosing Claude Code sets (CLAUDECODE, CLAUDE_CODE_*), so the
 * child sets its own. Only the account's CLAUDE_CONFIG_DIR and the hook and
 * run ids a worker pane carries are added.
 */
const CHILD_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
  "TMPDIR", "TMP", "TEMP", "SSH_AUTH_SOCK",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  // Windows needs these to start anything at all.
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
]);
const HOOK_ENV_NAMES = new Set(["SPARK_HOOK_URL", "SPARK_HOOK_TOKEN", "SPARK_PANE_ID"]);

export function claudeCodeWorkerEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  configDirEnv: string | null;
  hookEnv: Record<string, string> | null;
  codaraHome: string;
  runId: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.baseEnv)) {
    if (typeof value !== "string") continue;
    const upper = key.toUpperCase();
    if (CHILD_ENV_NAMES.has(upper) || upper.startsWith("LC_")) env[key] = value;
  }
  if (input.configDirEnv) env.CLAUDE_CONFIG_DIR = input.configDirEnv;
  for (const [key, value] of Object.entries(input.hookEnv ?? {})) {
    if (HOOK_ENV_NAMES.has(key) && typeof value === "string") env[key] = value;
  }
  env.SPARK_HOME_DIR = input.codaraHome;
  env.SPARK_RUN_ID = input.runId;
  return env;
}

export interface ClaudeCodeWorkerAccount {
  profileId: string;
  label: string;
  /** CLAUDE_CONFIG_DIR for the child; null runs on the user's own login. */
  configDirEnv: string | null;
}

const PROFILES_FILE = "account-profiles.json";
const PROFILES_MAX_BYTES = 256 * 1024;

/**
 * The account a new Studio Claude terminal launches with, read from the
 * profile list alone (ids, labels, the default). A managed account runs in
 * Codara's live slot, the System login with the user's own CLAUDE_CONFIG_DIR
 * (or none). No login record is opened.
 */
export async function claudeCodeWorkerAccount(input: {
  accountRoot?: string;
  baseEnv?: NodeJS.ProcessEnv;
} = {}): Promise<ClaudeCodeWorkerAccount> {
  const root = resolve(input.accountRoot ?? join(codaraHomeDir(), CODARA_CLAUDE_CLI_DIRNAME)).normalize("NFC");
  const configured = (input.baseEnv ?? process.env).CLAUDE_CONFIG_DIR?.trim();
  const personal: ClaudeCodeWorkerAccount = {
    profileId: CLAUDE_CLI_PERSONAL_PROFILE_ID,
    label: "Claude Code login",
    configDirEnv: configured && !isCodaraManagedCliPath(configured) ? resolve(configured) : null,
  };
  let text: string;
  try {
    const file = join(root, PROFILES_FILE);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > PROFILES_MAX_BYTES) throw new Error("The Claude account list is not a readable file.");
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return personal;
    throw error;
  }
  const list = record(JSON.parse(text));
  const defaultId = list?.defaultProfileId;
  if (!isClaudeCliManagedProfileId(defaultId)) return personal;
  const profile = (Array.isArray(list?.profiles) ? list.profiles : []).map(record).find((entry) => entry?.id === defaultId);
  if (!profile) return personal;
  return {
    profileId: defaultId,
    label: typeof profile.label === "string" && profile.label.trim() ? oneLine(profile.label, 80) : "Claude account",
    configDirEnv: resolve(root, "live", "home").normalize("NFC"),
  };
}

const STATUS_PROBE_TIMEOUT_MS = 15_000;
const STATUS_PROBE_MAX_BYTES = 16 * 1024;

/**
 * Claude Code's own `auth status --json`, reduced to one boolean (null when
 * it gave no answer). Nothing else from its output is kept. The probe is
 * started and owned like a worker turn (startOwnedProcess): `track` hands it
 * to the attempt, so the attempt's Stop and teardown reach it and anything
 * it started, and a probe whose processes could not be confirmed gone
 * answers null.
 */
export async function claudeCodeSignedIn(
  binary: string,
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; track?: (probe: ClaudeCodeProcess) => void } = {},
): Promise<boolean | null> {
  const { signal, track } = options;
  if (signal?.aborted) return null;
  let stdout = "";
  const probe = startOwnedProcess({
    binary,
    argv: ["auth", "status", "--json"],
    env,
    cwd: homedir(),
    stdin: null,
    onStdout: (chunk) => {
      if (stdout.length < STATUS_PROBE_MAX_BYTES) stdout += chunk.slice(0, STATUS_PROBE_MAX_BYTES - stdout.length);
    },
  });
  track?.(probe);
  const stop = () => void probe.kill().catch(() => false);
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, STATUS_PROBE_TIMEOUT_MS);
  try {
    // Signed out exits non-zero and still prints its JSON.
    const result = await probe.done;
    if (!result.cleanedUp || signal?.aborted) return null;
    const loggedIn = record(JSON.parse(stdout))?.loggedIn;
    return typeof loggedIn === "boolean" ? loggedIn : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

const READY_TTL_MS = 60_000;
let readyCache: { at: number; ready: Promise<boolean> } | null = null;

/** Claude Code is installed and says the account a new Claude terminal gets
 *  is signed in. Checked at most once a minute. */
export function claudeCodeWorkerReady(now = Date.now()): Promise<boolean> {
  if (readyCache && now - readyCache.at < READY_TTL_MS) return readyCache.ready;
  const ready = (async () => {
    if (!claudeCodeWorkerSupported()) return false;
    const { resolveBinary } = await import("../binary-resolver");
    const binary = await resolveBinary("claude");
    if (!binary) return false;
    const account = await claudeCodeWorkerAccount();
    const env = claudeCodeWorkerEnv({ baseEnv: process.env, configDirEnv: account.configDirEnv, hookEnv: null, codaraHome: codaraHomeDir(), runId: "" });
    return (await claudeCodeSignedIn(binary, env)) === true;
  })().catch(() => false);
  readyCache = { at: now, ready };
  return ready;
}

export interface ClaudeCodeWorkerLaunch {
  binary: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  accountLabel: string;
  /** Hand the account hold back once the process has exited. */
  release: () => void;
}

/**
 * One launch on the account a new Studio Claude terminal would get now.
 * Studio's launch and provider arguments come from the caller. The account
 * hold is a plain lease: taking and releasing it never touches a login.
 */
export async function prepareClaudeCodeWorkerLaunch(input: {
  runId: string;
  attemptDir: string;
  launchArgs: readonly string[];
  providerArgs: readonly string[];
  hookEnv: Record<string, string> | null;
  codaraHome: string;
  acquireLease: (profileId: string) => () => void;
  binary?: string | null;
  account?: ClaudeCodeWorkerAccount;
  baseEnv?: NodeJS.ProcessEnv;
  /** The attempt's Stop: checked before the sign-in probe starts, and it
   *  ends the probe if it lands while the probe runs. */
  signal?: AbortSignal;
  /** Hands the sign-in probe to the attempt that owns its processes
   *  (ClaudeCodeWorkerAttempt.track). */
  track?: (probe: ClaudeCodeProcess) => void;
}): Promise<ClaudeCodeWorkerLaunch> {
  const stoppedError = () => new Error("Claude Code worker was stopped.");
  if (!claudeCodeWorkerSupported()) {
    throw new Error("Claude Code workers run on Linux only for now: Studio cannot yet confirm that a stopped worker left nothing running on this system.");
  }
  if (input.signal?.aborted) throw stoppedError();
  const binary = input.binary !== undefined ? input.binary : await (await import("../binary-resolver")).resolveBinary("claude");
  if (!binary) throw new Error("Claude Code is not installed: the `claude` command was not found.");
  const account = input.account ?? (await claudeCodeWorkerAccount({ baseEnv: input.baseEnv }));
  const env = claudeCodeWorkerEnv({
    baseEnv: input.baseEnv ?? process.env,
    configDirEnv: account.configDirEnv,
    hookEnv: input.hookEnv,
    codaraHome: input.codaraHome,
    runId: input.runId,
  });
  if (input.signal?.aborted) throw stoppedError();
  const signedIn = await claudeCodeSignedIn(binary, env, { signal: input.signal, track: input.track });
  if (input.signal?.aborted) throw stoppedError();
  if (signedIn !== true) {
    throw new Error(
      signedIn === false
        ? `Claude Code is not signed in to "${account.label}". Sign in to this account in a Claude terminal, then run the task again.`
        : `Claude Code did not say whether "${account.label}" is signed in. Open a Claude terminal on this account to check, then run the task again.`,
    );
  }
  const releaseLease = input.acquireLease(account.profileId);
  let released = false;
  return {
    binary,
    argv: claudeCodeWorkerArgv({ launchArgs: input.launchArgs, providerArgs: input.providerArgs, attemptDir: input.attemptDir }),
    env,
    accountLabel: account.label,
    release: () => {
      if (released) return;
      released = true;
      releaseLease();
    },
  };
}

/**
 * The end of one worker attempt, decided once after every turn's processes
 * were torn down. A Stop recorded at that moment wins over a report, and a
 * teardown that was not confirmed wins over both: the attempt then fails as
 * "stopped, cleanup not confirmed" and the account hold is kept.
 */
export function claudeCodeWorkerVerdict(input: {
  reportReady: boolean;
  failure: string | null;
  stopped: boolean;
  cleanedUp: boolean;
}): { succeeded: true } | { succeeded: false; stopped: boolean; message: string } {
  if (!input.cleanedUp) {
    return {
      succeeded: false,
      stopped: input.stopped,
      message: "Claude Code worker stopped, but some of its processes could not be confirmed gone; the account stays marked in use.",
    };
  }
  if (input.stopped) return { succeeded: false, stopped: true, message: "Claude Code worker was stopped." };
  if (input.failure !== null || !input.reportReady) {
    return { succeeded: false, stopped: false, message: input.failure ?? "Claude Code worker ended without a report." };
  }
  return { succeeded: true };
}

/**
 * The run's finish path, for a Claude Code attempt that came back with a
 * report: true when a Stop was recorded for the attempt meanwhile (the
 * pause committed it as cancelled, its launch was aborted, or a Stop is
 * still tearing the run down). The report then never becomes a success.
 */
export function claudeCodeStopOwnsVerdict(input: {
  exitCode: number;
  attemptStatus: string;
  launchAborted: boolean;
  stopInProgress: boolean;
}): boolean {
  return input.exitCode === 0 && (input.attemptStatus === "cancelled" || input.launchAborted || input.stopInProgress);
}

/**
 * The one function every error saved with a Claude Code worker's run goes
 * through (the failure report, the attempt record, the event journal).
 * Only Studio's own fixed lines are saved, each matched whole: a message
 * that names the account (its label is the user's own text and may hold a
 * name, an email or a path) is saved as its fixed form without the label,
 * and anything else (an exception from the system, a path, Claude Code's
 * own output) as one fixed line. The full text is shown in the worker pane
 * only.
 */
const SAVED_ERRORS: ReadonlyArray<readonly [RegExp, string | null]> = [
  [/^Claude Code is not signed in to "[^\n]*"\. Sign in to this account in a Claude terminal, then run the task again\.$/,
    "Claude Code is not signed in to the account a new Claude terminal uses. Sign in to it in a Claude terminal, then run the task again."],
  [/^Claude Code did not say whether "[^\n]*" is signed in\. Open a Claude terminal on this account to check, then run the task again\.$/,
    "Claude Code did not say whether the account a new Claude terminal uses is signed in. Open a Claude terminal to check, then run the task again."],
  [/^Claude Code is not installed: the `claude` command was not found\.$/, null],
  [/^Claude Code workers run on Linux only for now: Studio cannot yet confirm that a stopped worker left nothing running on this system\.$/, null],
  [/^Claude Code worker was stopped\.$/, null],
  [/^Claude Code worker was interrupted before it started\.$/, null],
  [/^Claude Code worker stopped, but some of its processes could not be confirmed gone; the account stays marked in use\.$/, null],
  [/^Claude Code worker completed without a parseable final-report\.json\.$/, null],
  [/^Claude Code exited with code -?\d{1,4} before writing its final report\.$/, null],
  [/^Claude Code worker ended without a report\.$/, null],
  [/^Studio's settings for Claude Code workers are not ready yet\. Run the task again in a moment\.$/, null],
  [/^Studio's settings for Claude Code workers could not be prepared\. Run the task again in a moment\.$/, null],
  [/^An earlier Claude Code worker in this run left processes that could not be confirmed gone\. Restart Studio once they are stopped, then run the task again\.$/, null],
];
/** Why nothing more runs in a run after a worker whose processes could not
 *  be confirmed gone (run-store's unconfirmedWorkerCleanup). */
export const UNCONFIRMED_CLEANUP_ERROR =
  "An earlier Claude Code worker in this run left processes that could not be confirmed gone. Restart Studio once they are stopped, then run the task again.";
const SAVED_ERROR_FALLBACK = "Claude Code worker failed; the worker pane shows the details.";

export function claudeCodeSavedError(message: string): string {
  const line = message.trim();
  for (const [form, saved] of SAVED_ERRORS) if (form.test(line)) return saved ?? line;
  return SAVED_ERROR_FALLBACK;
}

/**
 * Every process one worker attempt started, across all its turns, and the
 * single place its Stop is recorded. A Stop ends every turn's process, not
 * only the last one; no turn starts after a Stop or after an earlier turn
 * whose teardown was not confirmed; and `teardown()` is true only when every
 * turn's processes were confirmed gone (the caller keeps its account hold
 * otherwise).
 */
export class ClaudeCodeWorkerAttempt {
  private stopRecorded = false;
  private readonly aborter = new AbortController();
  /** Aborted by a Stop: hands the Stop to work that is not a turn yet (the
   *  launch's sign-in probe). */
  readonly signal = this.aborter.signal;
  private incomplete = false;
  private readonly processes: ClaudeCodeProcess[] = [];

  constructor(private readonly stoppedElsewhere: () => boolean = () => false) {}

  /** A Stop was recorded for this attempt (here or through the launch). */
  get stopped(): boolean {
    return this.stopRecorded || this.stoppedElsewhere();
  }

  /** Some turn's processes could not be confirmed gone. */
  get teardownIncomplete(): boolean {
    return this.incomplete;
  }

  /** Start one turn's process. Must stay synchronous between the checks and
   *  the start, so a Stop either lands before (nothing starts) or reaches
   *  the new process through `stop()`. */
  start(spawnTurn: () => ClaudeCodeProcess): ClaudeCodeProcess {
    if (this.stopped) throw new Error("Claude Code worker was stopped.");
    if (this.incomplete) {
      throw new Error("An earlier Claude Code turn left processes that could not be confirmed stopped.");
    }
    const started = spawnTurn();
    this.processes.push(started);
    return started;
  }

  /** Own a process this attempt started outside a turn (the sign-in
   *  probe): a Stop reaches it, and the teardown waits for it. */
  track(started: ClaudeCodeProcess): void {
    this.processes.push(started);
    if (this.stopped) void started.kill().catch(() => false);
  }

  /** The end of a turn started here. An unconfirmed teardown blocks every
   *  later turn and report. */
  async end(started: ClaudeCodeProcess): Promise<{ exitCode: number; stderrTail: string; cleanedUp: boolean }> {
    const result = await started.done;
    if (!result.cleanedUp) this.incomplete = true;
    return result;
  }

  /** Record a Stop and end every turn's processes. */
  stop(): void {
    this.stopRecorded = true;
    this.aborter.abort();
    for (const started of this.processes) void started.kill().catch(() => false);
  }

  /** End every turn's processes; true only when all were confirmed gone. */
  async teardown(): Promise<boolean> {
    const results = await Promise.all(this.processes.map((started) => started.kill().catch(() => false)));
    if (results.some((clean) => !clean)) this.incomplete = true;
    return !this.incomplete;
  }
}

/**
 * The worker's turns: the task, then at most one turn on the same session to
 * write a missing report. `stopped` is read right before each turn starts
 * and after each report read, so a Stop that lands during the launch or
 * while the report is read never starts a turn and never ends as a success;
 * `turn` must start its process synchronously.
 */
export async function runClaudeCodeWorkerTurns<Report>(input: {
  prompt: string;
  stopped: () => boolean;
  turn: (prompt: string, resume?: string) => Promise<number>;
  sessionId: () => string | undefined;
  readReport: () => Promise<Report | null>;
  finalizePrompt: () => Promise<string>;
  onFinalizing?: () => void;
}): Promise<{ exitCode: number; report: Report | null }> {
  const stoppedError = () => new Error("Claude Code worker was stopped.");
  const check = () => {
    if (input.stopped()) throw stoppedError();
  };
  check();
  const exitCode = await input.turn(input.prompt);
  let report = await input.readReport();
  check();
  const session = input.sessionId();
  if (!report && session) {
    const prompt = await input.finalizePrompt();
    check();
    input.onFinalizing?.();
    await input.turn(prompt, session);
    report = await input.readReport();
    check();
  }
  return { exitCode, report };
}

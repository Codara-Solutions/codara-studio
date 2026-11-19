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

import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
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

/** Tests only: replace the teardown listing (null restores `ps`) and shorten
 *  the teardown timing. */
/** Tests only: the ownership rules of a teardown, without signals. */
export function claudeCodeOwnedProcessesForTests(rootPid: number): { members(listing: readonly ClaudeCodeListedProcess[]): ClaudeCodeListedProcess[] } {
  return new OwnedProcesses(rootPid);
}

export function setClaudeCodeTeardownForTests(input: {
  listing?: ((real: () => ClaudeCodeListedProcess[] | null) => ClaudeCodeListedProcess[] | null) | null;
  graceMs?: number;
  killDeadlineMs?: number;
} | null): void {
  processListing = input?.listing ? () => input.listing!(listProcessesForTeardown) : listProcessesForTeardown;
  teardownTiming.graceMs = input?.graceMs ?? 3_000;
  teardownTiming.killDeadlineMs = input?.killDeadlineMs ?? 30_000;
}

/**
 * Everything a worker started, as a set that only grows. Claude Code is
 * spawned detached, so it leads a new session and a new process group.
 * A process is the worker's when it is in that session, in a group or
 * session a known member of it leads or joined, or below one of those by
 * parent. A tool that makes its own group stays in the session, so a
 * helper it starts there is found even after the tool exits and the helper
 * is reparented. Only pids, parents, groups, sessions and start times are
 * read (`ps`), never a command line or an environment.
 *
 * What this cannot reach: a process that starts a new session of its own
 * (setsid) after its last known ancestor exited and before any listing saw
 * it. That needs an OS container (a cgroup); the teardown then reports
 * nothing left only for what it can see.
 */
class OwnedProcesses {
  private readonly known = new Map<number, string>();
  private readonly groups = new Set<number>();
  private readonly sessions = new Set<number>();

  constructor(rootPid: number) {
    this.groups.add(rootPid);
    if (process.platform === "linux") this.sessions.add(rootPid);
  }

  /** The live members in `listing`, learning every new one. A group or
   *  session with no process left in the listing is retired: nothing can
   *  join it again, so a later process that reuses its id is not ours. */
  members(listing: readonly ClaudeCodeListedProcess[]): ClaudeCodeListedProcess[] {
    const owned = new Map<number, ClaudeCodeListedProcess>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of listing) {
        if (owned.has(row.pid) || row.pid <= 1 || row.pid === process.pid) continue;
        const ours =
          this.known.get(row.pid) === row.startedAt ||
          this.groups.has(row.groupId) ||
          (row.sessionId > 1 && this.sessions.has(row.sessionId)) ||
          owned.has(row.parentPid);
        if (!ours) continue;
        owned.set(row.pid, row);
        this.known.set(row.pid, row.startedAt);
        if (row.groupId > 1 && !this.groups.has(row.groupId)) {
          this.groups.add(row.groupId);
          grew = true;
        }
        if (row.sessionId > 1 && !this.sessions.has(row.sessionId)) {
          this.sessions.add(row.sessionId);
          grew = true;
        }
        grew = true;
      }
    }
    const live = [...owned.values()].filter((row) => !row.zombie);
    const liveGroups = new Set(live.map((row) => row.groupId));
    const liveSessions = new Set(live.map((row) => row.sessionId));
    for (const group of [...this.groups]) if (!liveGroups.has(group)) this.groups.delete(group);
    for (const session of [...this.sessions]) if (!liveSessions.has(session)) this.sessions.delete(session);
    for (const pid of [...this.known.keys()]) if (!owned.has(pid)) this.known.delete(pid);
    return live;
  }

  signal(sig: NodeJS.Signals, members: readonly ClaudeCodeListedProcess[] | null): void {
    // Only groups that had a live member at the last listing are still
    // held: a group id cannot be handed to another process while one of its
    // members lives, so these are signalled even when this round's listing
    // failed.
    for (const group of this.groups) {
      try {
        process.kill(-group, sig);
      } catch {
        // Gone already.
      }
    }
    // Single pids only when a listing just confirmed who they are.
    for (const member of members ?? []) {
      try {
        process.kill(member.pid, sig);
      } catch {
        // Exited between the listing and the signal.
      }
    }
  }
}

/**
 * End everything a worker started: SIGTERM, a grace period, then SIGKILL
 * retried until the deadline. Every round lists processes again, so a
 * helper born during teardown is found and ended too. A listing that fails
 * or times out counts as "may still be alive", never as "gone": the result
 * is true only once a listing confirmed nothing is left.
 */
async function stopProcessTree(pid: number | undefined): Promise<boolean> {
  if (!pid) return true;
  if (process.platform === "win32") {
    // Best effort, never proof: taskkill's status does not show that a
    // child whose parent already exited is gone. (Workers do not run on
    // Windows yet: claudeCodeWorkerSupported.)
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
    return false;
  }
  const owned = new OwnedProcesses(pid);
  const pause = () => new Promise((resolve) => setTimeout(resolve, teardownTiming.pollMs));
  /** The live members now; null when that cannot be told. */
  const look = (): ClaudeCodeListedProcess[] | null => {
    const listing = processListing();
    return listing ? owned.members(listing) : null;
  };
  const round = (sig: NodeJS.Signals) => owned.signal(sig, look());
  const termed = new Set<string>();
  const term = (members: readonly ClaudeCodeListedProcess[] | null) => {
    const fresh = (members ?? []).filter((member) => !termed.has(`${member.pid}@${member.startedAt}`));
    for (const member of fresh) termed.add(`${member.pid}@${member.startedAt}`);
    return fresh;
  };
  {
    const first = look();
    owned.signal("SIGTERM", term(first));
  }
  let last = look();
  const graceEnd = Date.now() + teardownTiming.graceMs;
  while (Date.now() < graceEnd && (last === null || last.length > 0)) {
    await pause();
    last = look();
    // A helper born since the last look gets its SIGTERM too, once.
    const fresh = term(last);
    for (const member of fresh) {
      try {
        process.kill(member.pid, "SIGTERM");
      } catch {
        // Exited already.
      }
    }
  }
  const killEnd = Date.now() + teardownTiming.killDeadlineMs;
  while (last === null || last.length > 0) {
    round("SIGKILL");
    await pause();
    last = look();
    if (Date.now() >= killEnd) break;
  }
  // Only Linux lists sessions, which is what finds a helper that left its
  // group before any listing saw it; elsewhere "nothing left" is not proven.
  return claudeCodeWorkerSupported() && last !== null && last.length === 0;
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

/** Start Claude Code, hand it the prompt on stdin, and report each event.
 *  It leads its own process group, so Stop and the end of the turn reach
 *  everything it started. */
export function startClaudeCodeWorker(input: {
  binary: string;
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  prompt: string;
  onEvent: (event: ClaudeCodeEvent) => void;
}): ClaudeCodeProcess {
  const child: ChildProcessWithoutNullStreams = spawn(input.binary, [...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let buffered = "";
  let stderrTail = "";
  let stopping: Promise<boolean> | null = null;
  const stopTree = () => (stopping ??= stopProcessTree(child.pid));
  const emit = (line: string) => {
    for (const event of parseClaudeCodeStreamLine(line)) {
      try {
        input.onEvent(event);
      } catch {
        // A display failure must not end the worker.
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop() ?? "";
    lines.forEach(emit);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input.prompt);
  const done = new Promise<{ exitCode: number; stderrTail: string; cleanedUp: boolean }>((resolve) => {
    let settled = false;
    const finish = (exitCode: number, cleanedUp: boolean) => {
      if (settled) return;
      settled = true;
      if (buffered.trim()) emit(buffered);
      resolve({ exitCode, stderrTail: safeLine(stderrTail, 2_000), cleanedUp });
    };
    child.on("error", (error) => {
      stderrTail = `${stderrTail}\n${error.message}`.slice(-2_000);
      // Nothing started without a pid; with one, its teardown decides.
      if (!child.pid) finish(127, true);
      else void stopTree().then((clean) => finish(127, clean), () => finish(127, false));
    });
    // The turn ends with nothing it started still running. A background
    // process left holding Claude Code's output would keep "close" from ever
    // firing, so the exit also ends the group after a moment to drain.
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

/** Claude Code's own `auth status --json`, reduced to one boolean (null when
 *  it gave no answer). Nothing else from its output is kept. */
export function claudeCodeSignedIn(binary: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean | null> {
  return new Promise((resolveStatus) => {
    if (signal?.aborted) {
      resolveStatus(null);
      return;
    }
    execFile(
      binary,
      ["auth", "status", "--json"],
      { env, cwd: homedir(), timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true, ...(signal ? { signal, killSignal: "SIGKILL" as const } : {}) },
      // Signed out exits non-zero and still prints its JSON.
      (_error, stdout) => {
        try {
          const loggedIn = record(JSON.parse(String(stdout ?? "")))?.loggedIn;
          resolveStatus(typeof loggedIn === "boolean" ? loggedIn : null);
        } catch {
          resolveStatus(null);
        }
      },
    );
  });
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
  const signedIn = await claudeCodeSignedIn(binary, env, input.signal);
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
 * Studio's own messages for a Claude Code worker, the only error text saved
 * with the run (the failure report, the attempt record, the event journal).
 * Anything else (an exception from the system, a path, Claude Code's own
 * output) is saved as one fixed line; its detail is shown in the worker
 * pane only.
 */
const SAVED_ERROR_FORMS: readonly RegExp[] = [
  /^Claude Code is not installed: the `claude` command was not found\.$/,
  /^Claude Code is not signed in to "[^"\n]{1,80}"\. Sign in to this account in a Claude terminal, then run the task again\.$/,
  /^Claude Code did not say whether "[^"\n]{1,80}" is signed in\. Open a Claude terminal on this account to check, then run the task again\.$/,
  /^Claude Code workers run on Linux only for now: Studio cannot yet confirm that a stopped worker left nothing running on this system\.$/,
  /^Claude Code worker was stopped\.$/,
  /^Claude Code worker was interrupted before it started\.$/,
  /^Claude Code worker stopped, but some of its processes could not be confirmed gone; the account stays marked in use\.$/,
  /^Claude Code worker completed without a parseable final-report\.json\.$/,
  /^Claude Code exited with code -?\d{1,4} before writing its final report\.$/,
  /^Claude Code worker ended without a report\.$/,
  /^Studio's (settings|tools) for Claude Code workers [^\n/\\]{1,120}\.$/,
];
const SAVED_ERROR_FALLBACK = "Claude Code worker failed; the worker pane shows the details.";

export function claudeCodeSavedError(message: string): string {
  const line = message.trim();
  return SAVED_ERROR_FORMS.some((form) => form.test(line)) ? line : SAVED_ERROR_FALLBACK;
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

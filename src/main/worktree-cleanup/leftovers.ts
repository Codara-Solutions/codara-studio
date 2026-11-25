import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { WorktreeLeftoverProcess } from "@shared/worktree-cleanup";
import { cleanText, linuxCwdOf } from "../agent-worktrees";
import { psTimeEnvironment, readProcFile } from "../owned-process-tree";

// Processes left running in a merged worktree (a dev server an agent started
// and never stopped), which the rail's Clean up names and, on a yes, stops.
// The rule: a signal goes only to a process the user confirmed, each by its
// own pid (never a group), and only while it is that process: the same pid,
// start time and raw argument bytes the question showed, still working
// inside the worktree, all read again in the same tick as the signal
// (linuxSameNow, macSameNow, with the window they leave). Anything that
// cannot be read is unknown, never "gone": nothing is signalled for it and
// the worktree stays. Never stopped, only named (and the worktree stays):
// Codara's own processes; a pane's shell and anything below a pane that no
// agent started; and, outside the panes, anything with a terminal attached
// or that is a shell, which the user runs in a terminal of their own. Below
// a pane, an agent's descendants may be stopped even with the pane's
// terminal attached: that terminal is Codara's. The terminal is read again
// at the signal too. Only a click stops anything; the unattended mode never
// does.

// Real POSIX paths as the system gives them, compared exactly: a backslash
// is part of a name here, and a case-sensitive volume has "a" and "A".
function isAtOrUnder(candidate: string, dir: string): boolean {
  const a = candidate.replace(/\/+$/, "") || "/";
  const b = dir.replace(/\/+$/, "") || "/";
  return a === b || a.startsWith(b === "/" ? "/" : `${b}/`);
}

export interface ProcessFacts {
  pid: number;
  parentPid: number;
  /** When it started, as the system spells it: a reused pid has another. */
  start: string;
  /** Its arguments as started, the program first. */
  argv: string[];
  /** False when the system gives them only flattened into one line (macOS). */
  argvExact: boolean;
  /** Its arguments as the raw bytes the system gives (argvKeyOf): what a confirmation binds. */
  argvKey: string;
  startedAtMs: number | null;
  /** Null when it cannot be read. */
  cwd: string | null;
  /** Its controlling terminal as the system names it; null when it has none. */
  tty: string | null;
  command: string;
  /** Exited, waiting for its parent to collect it. */
  zombie: boolean;
}

export interface LeftoverSystem {
  appPid: number;
  /** The shells (or agents) of the terminal panes. */
  sessionPids(): readonly number[];
  /** Null when it is gone; throws when it cannot be read. */
  facts(pid: number): Promise<ProcessFacts | null>;
  /** Every process's pid and parent; null when they cannot be listed. */
  table(): Promise<ReadonlyArray<{ pid: number; parentPid: number }> | null>;
  /**
   * Signals each target only if, read again in the same tick as the signal
   * with nothing awaited in between, it still has that start, raw arguments
   * and terminal and works inside `real`. Per pid: true when sent, otherwise
   * why not. One read covers all targets where the system allows it.
   */
  signal(targets: readonly SignalTarget[], signal: "SIGTERM" | "SIGKILL", real: string): Map<number, true | string>;
  wait(ms: number): Promise<void>;
  now(): number;
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
}

export interface SignalTarget {
  pid: number;
  start: string;
  commandKey: string;
  tty: string | null;
}

export interface Leftover extends WorktreeLeftoverProcess {
  start: string;
  /** Its terminal when it was named: one attached since is not what was confirmed. */
  tty: string | null;
  /** Its argument list, hashed: with the pid and start, what makes it the same process. */
  commandKey: string;
  /** Why it is not stopped; the worktree then stays. */
  blocked?: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "login"]);
const AGENTS = new Set(["claude", "codex", "cora", "pi", "gemini", "grok", "agy", "aider", "opencode", "cursor-agent", "amp"]);
const RUNNERS = new Set(["node", "nodejs", "python", "python3", "deno", "bun", "ruby", "php", "perl", "tsx", "ts-node", "uvicorn"]);
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx"]);
/** Why a shell, or anything with a terminal, outside Codara's panes is left alone. */
export const ELSEWHERE = "it belongs to a terminal outside Codara. Exit it there or cd out of the folder, then Clean up again";
const WORD = /^[\w@+.:-]{1,40}$/;

function nameOf(word: string | undefined): string {
  return cleanText(basename((word ?? "").replace(/^-/, "")), 40);
}

/**
 * "node server.js", "npm run dev", "vite": the program and its script, never
 * other arguments. Only from exact arguments, and only a script right after
 * the program: past any option a word may be that option's value, and from a
 * flattened line no word can be placed.
 */
export function programOf(argv: readonly string[], exact = true): string {
  const name = nameOf(argv[0]) || "a program";
  if (!exact) return name;
  const [first, second] = argv.slice(1);
  const plain = (word: string | undefined): word is string => Boolean(word) && WORD.test(word!) && !word!.startsWith("-");
  if (PACKAGE_RUNNERS.has(name) && plain(first)) {
    if ((first === "run" || first === "exec") && plain(second)) return `${name} ${first} ${second}`;
    return `${name} ${first}`;
  }
  if (RUNNERS.has(name) && first !== undefined && !first.startsWith("-")) {
    const script = basename(first);
    if (WORD.test(script) && script === first.slice(first.length - script.length)) return `${name} ${script}`;
  }
  return name;
}

/** The raw argument bytes, hashed: no decoding can make two lists look alike. */
export function argvKeyOf(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function isAgentCommand(command: string): boolean {
  return command
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .some((word) => AGENTS.has(nameOf(word).replace(/\.(c?js|mjs)$/, "")));
}

/**
 * What each process found inside `real` is, and whether it may be stopped.
 * `panes` names the tab of each terminal pane's shell. Processes already gone
 * are left out. Null when the processes cannot be listed.
 */
export async function describeLeftovers(
  system: LeftoverSystem,
  real: string,
  pids: readonly number[],
  panes: ReadonlyMap<number, string>,
): Promise<Leftover[] | null> {
  const table = await system.table().catch(() => null);
  if (!table) return null;
  const parentOf = new Map(table.map((entry) => [entry.pid, entry.parentPid]));
  const sessions = new Set([...system.sessionPids(), ...panes.keys()]);
  const app = new Set<number>();
  for (let pid: number | undefined = system.appPid; pid !== undefined && pid > 1 && !app.has(pid); pid = parentOf.get(pid)) app.add(pid);
  const tabOf = (pid: number) => panes.get(pid) ?? "a terminal tab";
  const out: Leftover[] = [];
  for (const pid of [...new Set(pids)]) {
    let facts: ProcessFacts | null;
    try {
      facts = await system.facts(pid);
    } catch {
      out.push({ pid, start: "", commandKey: "", tty: null, program: "a program", blocked: "it could not be read" });
      continue;
    }
    if (!facts || facts.zombie) continue;
    const ancestors: number[] = [];
    for (let up: number | undefined = facts.parentPid; up !== undefined && up > 1 && !ancestors.includes(up); up = parentOf.get(up)) {
      ancestors.push(up);
    }
    const session = ancestors.find((up) => sessions.has(up));
    // Below Codara itself, not merely below what started it: a process that
    // lost its parent now hangs from init or the service manager, often
    // Codara's own ancestors.
    const appAt = ancestors.indexOf(system.appPid);
    const sessionAt = session === undefined ? -1 : ancestors.indexOf(session);
    let blocked: string | undefined;
    let startedBy: string | undefined;
    // A pane's shell is Codara's child too: named as the tab it is.
    if (sessions.has(pid)) blocked = `it is the terminal of ${tabOf(pid)}. Close that tab first`;
    else if (app.has(pid) || (appAt >= 0 && (sessionAt < 0 || appAt < sessionAt))) blocked = "it is part of Codara";
    if (!blocked && session !== undefined) {
      const chain = await Promise.all(ancestors.slice(0, sessionAt + 1).map((up) => system.facts(up).catch(() => null)));
      // Below a pane, at any depth, it is the user's unless an agent started
      // it: an ancestor that cannot be read is not taken for an agent.
      if (chain.some((entry) => entry && isAgentCommand(entry.command))) {
        startedBy = `started by an agent that is still open: ${tabOf(session)}`;
      } else {
        blocked = `it runs in ${tabOf(session)}. Stop it there first`;
      }
    } else if (!blocked && (facts.tty !== null || SHELLS.has(nameOf(facts.argv[0])))) {
      // Outside Codara's panes: a terminal of the user's own works in it.
      blocked = ELSEWHERE;
    }
    if (!blocked && (facts.cwd === null || !isAtOrUnder(facts.cwd, real))) {
      blocked = facts.cwd === null ? "its folder cannot be read. Stop it yourself, then Clean up again" : "it only has a file open in it. Close that file first";
    }
    const runningMs = facts.startedAtMs === null ? undefined : Math.max(0, system.now() - facts.startedAtMs);
    out.push({
      pid,
      start: facts.start,
      commandKey: facts.argvKey,
      tty: facts.tty,
      program: programOf(facts.argv, facts.argvExact),
      ...(runningMs !== undefined ? { runningMs } : {}),
      ...(startedBy ? { startedBy } : {}),
      ...(blocked ? { blocked } : {}),
    });
  }
  return out;
}

/** What a confirmation of these processes is tied to: each one's pid and start, in this worktree. */
export function leftoverFingerprint(real: string, list: readonly Leftover[]): string {
  const ids = list.map((entry) => `${entry.pid}:${entry.start}:${entry.commandKey}`).sort();
  return createHash("sha256").update(`${real}\0${ids.join("\0")}`).digest("hex").slice(0, 32);
}

/** The public part, for the renderer. */
export function shownLeftover(entry: Leftover): WorktreeLeftoverProcess {
  return {
    pid: entry.pid,
    program: entry.program,
    ...(entry.runningMs !== undefined ? { runningMs: entry.runningMs } : {}),
    ...(entry.startedBy ? { startedBy: entry.startedBy } : {}),
  };
}

const POLL_MS = 100;
const ATTACHED = "a terminal was attached to it since you said yes, so it was not stopped";
const SLOW = "the system did not answer in time, so it was not stopped";
const CHANGED = "it changed since you said yes, so it was not stopped";
const KILL_WAIT_MS = 2_000;

type Seen = "gone" | "unknown" | ProcessFacts;

/**
 * Stops exactly `list` (confirmed, none blocked): SIGTERM, then SIGKILL for
 * what is left after the grace, each by its own pid. Returns those still
 * running inside the worktree at the end, or whose state could not be read,
 * with why. One that moved out of the worktree is left alone and not counted;
 * a pid that now belongs to another process is gone.
 */
export async function stopLeftovers(
  system: LeftoverSystem,
  real: string,
  list: readonly Leftover[],
): Promise<Array<{ entry: Leftover; why: string }>> {
  const look = async (entry: Leftover): Promise<Seen> => {
    let facts: ProcessFacts | null;
    try {
      facts = await system.facts(entry.pid);
    } catch {
      return "unknown";
    }
    if (!facts || facts.zombie || facts.start !== entry.start || facts.argvKey !== entry.commandKey) return "gone";
    // Alive and the same, but where it works cannot be read: unknown.
    if (facts.cwd === null) return "unknown";
    return facts;
  };
  const inside = (seen: Seen) => typeof seen === "object" && seen.cwd !== null && isAtOrUnder(seen.cwd, real);
  // Why the last signal meant for each was not sent, when it was not.
  const refused = new Map<number, string>();
  const send = async (targets: readonly Leftover[], signal: "SIGTERM" | "SIGKILL") => {
    const due: Leftover[] = [];
    for (const entry of targets) {
      const seen = await look(entry);
      if (!inside(seen)) continue;
      if ((seen as ProcessFacts).tty !== entry.tty) {
        refused.set(entry.pid, ATTACHED);
        continue;
      }
      due.push(entry);
    }
    if (!due.length) return;
    let sent: Map<number, true | string>;
    try {
      sent = system.signal(
        due.map(({ pid, start, commandKey, tty }) => ({ pid, start, commandKey, tty })),
        signal,
        real,
      );
    } catch {
      sent = new Map(due.map((entry) => [entry.pid, "whether it could be stopped could not be read"]));
    }
    for (const entry of due) {
      const result = sent.get(entry.pid) ?? "it was not stopped";
      if (result === true) refused.delete(entry.pid);
      else refused.set(entry.pid, result);
    }
  };
  const waitFor = async (targets: readonly Leftover[], ms: number) => {
    const until = system.now() + ms;
    const alive = async (entries: readonly Leftover[]) => {
      const out: Leftover[] = [];
      for (const entry of entries) if ((await look(entry)) !== "gone") out.push(entry);
      return out;
    };
    let left = await alive(targets);
    while (left.length && system.now() < until) {
      await system.wait(POLL_MS);
      left = await alive(left);
    }
    return left;
  };
  await send(list, "SIGTERM");
  let left = await waitFor(list, system.graceMs ?? 3_000);
  if (left.length) {
    await send(left, "SIGKILL");
    left = await waitFor(left, KILL_WAIT_MS);
  }
  const failed: Array<{ entry: Leftover; why: string }> = [];
  for (const entry of left) {
    const seen = await look(entry);
    if (seen === "unknown") failed.push({ entry, why: "whether it stopped could not be read" });
    else if (inside(seen)) failed.push({ entry, why: refused.get(entry.pid) ?? "it did not stop, even when forced" });
  }
  return failed;
}

// ── The system ─────────────────────────────────────────────────────────────

const CLOCK_TICKS_PER_SECOND = 100;

function run(file: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    execFile(file, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024, env: psTimeEnvironment(), windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
      done({ code, stdout: String(stdout ?? "") });
    });
  });
}

function goneCode(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

async function linuxBoot(): Promise<number | null> {
  const text = (await readProcFile("/proc/stat").catch(() => null))?.toString("utf8") ?? "";
  const match = /^btime\s+(\d+)$/m.exec(text);
  return match ? Number(match[1]) : null;
}

// After the name: state, ppid, pgrp, session, tty_nr (field 7 of the whole
// line), ..., starttime (field 22). A tty_nr of 0 is no controlling terminal.
function linuxStat(text: string): { state: string; parentPid: number; tty: string | null; ticks: string; name: string } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || !/^\d+$/.test(fields[19] ?? "") || !/^-?\d+$/.test(fields[4] ?? "")) return null;
  return { state: fields[0], parentPid, tty: fields[4] === "0" ? null : fields[4], ticks: fields[19], name: text.slice(open + 1, close) };
}

// Null when it is gone; throws when it cannot be read.
async function linuxStatOf(pid: number): Promise<NonNullable<ReturnType<typeof linuxStat>> | null> {
  let text: string;
  try {
    text = (await readProcFile(`/proc/${pid}/stat`)).toString("utf8");
  } catch (err) {
    if (goneCode(err)) return null;
    throw err;
  }
  const parsed = linuxStat(text);
  if (!parsed) throw new Error(`/proc/${pid}/stat could not be read`);
  return parsed;
}

async function linuxFacts(pid: number): Promise<ProcessFacts | null> {
  const before = await linuxStatOf(pid);
  if (!before) return null;
  const [placed, argv, boot] = await Promise.all([
    linuxCwdOf(pid).catch(() => null),
    // Unreadable arguments make it unknown, never another process.
    readProcFile(`/proc/${pid}/cmdline`),
    linuxBoot(),
  ]);
  // Read on both sides: a pid reused between the reads is not this process.
  const after = await linuxStatOf(pid);
  if (!after) return null;
  if (after.ticks !== before.ticks) throw new Error(`process ${pid} changed while it was read`);
  const words = argv.toString("utf8").split("\0");
  if (words.at(-1) === "") words.pop();
  return {
    pid,
    parentPid: after.parentPid,
    start: after.ticks,
    startedAtMs: boot === null ? null : (boot + Number(after.ticks) / CLOCK_TICKS_PER_SECOND) * 1000,
    // Only when the link's text names that very folder (device and inode):
    // a folder deleted since, whatever its text says, is unknown.
    cwd: placed && "cwd" in placed ? placed.cwd : null,
    tty: after.tty,
    command: words.length ? words.join(" ") : `[${after.name}]`,
    argv: words.length ? words : [`[${after.name}]`],
    argvExact: true,
    argvKey: argvKeyOf(argv),
    zombie: after.state === "Z" || after.state === "X",
  };
}

async function linuxTable(): Promise<Array<{ pid: number; parentPid: number }> | null> {
  const names = await fsp.readdir("/proc").catch(() => null);
  if (!names) return null;
  const pids = names.filter((name) => /^\d+$/.test(name)).map(Number);
  const rows: Array<{ pid: number; parentPid: number }> = [];
  for (let i = 0; i < pids.length; i += 64) {
    const batch = await Promise.all(
      pids.slice(i, i + 64).map(async (pid) => {
        const stat = await readProcFile(`/proc/${pid}/stat`).catch(() => null);
        const parsed = stat ? linuxStat(stat.toString("utf8")) : null;
        return parsed ? { pid, parentPid: parsed.parentPid } : null;
      }),
    );
    for (const row of batch) if (row) rows.push(row);
  }
  return rows.length ? rows : null;
}

// Two leading columns (a number, then a word), a terminal, lstart, args.
const PS_FACTS = /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

/** ps's terminal column: "??" (macOS) or "?" when there is none. */
function psTty(word: string): string | null {
  return word === "??" || word === "?" || word === "-" ? null : word;
}

// Null when it is gone (ps lists nothing and says so); throws otherwise.
async function macPs(pid: number): Promise<{ parentPid: number; state: string; tty: string | null; start: string; command: string } | null> {
  const out = await run("ps", ["-o", "ppid=,stat=,tty=,lstart=,args=", "-p", String(pid)]);
  const match = PS_FACTS.exec(out.stdout.split(/\r?\n/)[0] ?? "");
  if (!match) {
    if (out.code === 1 && !out.stdout.trim()) return null;
    throw new Error(`ps could not read process ${pid}`);
  }
  return { parentPid: Number(match[1]), state: match[2], tty: psTty(match[3]), start: match[4].replace(/\s+/g, " "), command: match[5] ?? "" };
}

async function macFacts(pid: number): Promise<ProcessFacts | null> {
  const before = await macPs(pid);
  if (!before) return null;
  const lsof = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwd = lsof.stdout.split(/\r?\n/).find((line) => line.startsWith("n/"))?.slice(1) ?? null;
  // ps gives the start to the second only: the command line must match too.
  const after = await macPs(pid);
  if (!after) return null;
  if (after.start !== before.start || after.command !== before.command || after.tty !== before.tty) throw new Error(`process ${pid} changed while it was read`);
  const startedAtMs = Date.parse(after.start);
  return {
    pid,
    parentPid: after.parentPid,
    start: after.start,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    cwd,
    tty: after.tty,
    command: after.command,
    argv: after.command.split(/\s+/).filter(Boolean),
    argvExact: false,
    // The closest to raw macOS gives without native code: ps's one line.
    argvKey: argvKeyOf(after.command),
    zombie: after.state.includes("Z"),
  };
}

async function macTable(): Promise<Array<{ pid: number; parentPid: number }> | null> {
  const out = await run("ps", ["-axo", "pid=,ppid="]);
  if (out.code !== 0) return null;
  const rows = out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((cols) => cols.length === 2 && cols.every(Number.isSafeInteger))
    .map(([pid, parentPid]) => ({ pid, parentPid }));
  return rows.length ? rows : null;
}

// Right before a signal, synchronously: the same start, the same raw
// arguments, the same terminal (none, unless it was a pane's), and a working
// directory inside the worktree that its link's text truly names (same
// device and inode). Any read that fails is a no, with why.
//
// What stays open without a pidfd (Node has none): the process can exit and
// its pid be taken by another between these reads and kill(), a window of a
// few system calls in which the pid space would have to wrap around. Linux
// binds to the start in clock ticks plus the raw arguments plus the folder;
// macOS to the start to the second plus ps's argument line plus the folder.
function linuxSameNow(target: SignalTarget, real: string): true | string {
  const { pid } = target;
  try {
    const stat = linuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    if (!stat || stat.ticks !== target.start || stat.state === "Z" || stat.state === "X") return CHANGED;
    if (stat.tty !== target.tty) return ATTACHED;
    if (argvKeyOf(readFileSync(`/proc/${pid}/cmdline`)) !== target.commandKey) return CHANGED;
    const text = readlinkSync(`/proc/${pid}/cwd`);
    const here = statSync(`/proc/${pid}/cwd`);
    const named = statSync(text);
    return named.dev === here.dev && named.ino === here.ino && isAtOrUnder(text, real) ? true : CHANGED;
  } catch {
    return CHANGED;
  }
}

/** How long one synchronous read may hold Codara's main process at a signal (macOS). */
export const SIGNAL_READ_TIMEOUT_MS = 500;

const PS_NOW = /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

type SyncRun = (file: string, args: string[]) => { stdout: string; timedOut: boolean };

function syncRun(file: string, args: string[]): { stdout: string; timedOut: boolean } {
  try {
    const stdout = execFileSync(file, args, {
      env: psTimeEnvironment(),
      timeout: SIGNAL_READ_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { stdout, timedOut: false };
  } catch (err) {
    const failure = err as { code?: unknown; signal?: unknown; stdout?: unknown };
    // ps and lsof exit 1 when one pid is gone, and still list the others.
    return { stdout: String(failure.stdout ?? ""), timedOut: failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM" };
  }
}

/**
 * macOS: one ps and one lsof for every target at once, each cut off after
 * SIGNAL_READ_TIMEOUT_MS; one that did not answer in time sends nothing.
 */
export function macSameNow(targets: readonly SignalTarget[], real: string, exec: SyncRun = syncRun): Map<number, true | string> {
  const out = new Map<number, true | string>();
  if (!targets.length) return out;
  const list = targets.map((target) => String(target.pid)).join(",");
  const ps = exec("ps", ["-o", "pid=,tty=,lstart=,args=", "-p", list]);
  if (ps.timedOut) return new Map(targets.map((target) => [target.pid, SLOW]));
  const rows = new Map<number, { tty: string | null; start: string; args: string }>();
  for (const line of ps.stdout.split(/\r?\n/)) {
    const match = PS_NOW.exec(line);
    if (match) rows.set(Number(match[1]), { tty: psTty(match[2]), start: match[3].replace(/\s+/g, " "), args: match[4] ?? "" });
  }
  const lsof = exec("/usr/sbin/lsof", ["-a", "-p", list, "-d", "cwd", "-Fpn"]);
  if (lsof.timedOut) return new Map(targets.map((target) => [target.pid, SLOW]));
  const cwds = new Map<number, string>();
  let current = 0;
  for (const line of lsof.stdout.split(/\r?\n/)) {
    if (line.startsWith("p")) current = Number(line.slice(1));
    else if (line.startsWith("n/") && current) cwds.set(current, line.slice(1));
  }
  for (const target of targets) {
    const row = rows.get(target.pid);
    const cwd = cwds.get(target.pid);
    if (!row || row.start !== target.start || argvKeyOf(row.args) !== target.commandKey) out.set(target.pid, CHANGED);
    else if (row.tty !== target.tty) out.set(target.pid, ATTACHED);
    else out.set(target.pid, cwd !== undefined && isAtOrUnder(cwd, real) ? true : CHANGED);
  }
  return out;
}

/** The real system on Linux and macOS; null elsewhere, where a process inside keeps holding the worktree. */
export function systemLeftovers(options: { appPid: number; sessionPids: () => readonly number[] }): LeftoverSystem | undefined {
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") return undefined;
  return {
    appPid: options.appPid,
    sessionPids: options.sessionPids,
    facts: linux ? linuxFacts : macFacts,
    table: linux ? linuxTable : macTable,
    signal: (targets, signal, real) => {
      // One process at a time, never a group, init or Codara itself.
      const valid = targets.filter(({ pid }) => Number.isSafeInteger(pid) && pid > 1 && pid !== options.appPid);
      const verdicts = linux ? new Map(valid.map((target) => [target.pid, linuxSameNow(target, real)])) : macSameNow(valid, real);
      const out = new Map<number, true | string>(targets.map(({ pid }) => [pid, "it is not a process that may be stopped"]));
      // Nothing awaited between the reads and here.
      for (const { pid } of valid) {
        const verdict = verdicts.get(pid) ?? CHANGED;
        if (verdict !== true) {
          out.set(pid, verdict);
          continue;
        }
        try {
          process.kill(pid, signal);
          out.set(pid, true);
        } catch {
          out.set(pid, CHANGED);
        }
      }
      return out;
    },
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
  };
}

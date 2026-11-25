import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { WorktreeLeftoverProcess } from "@shared/worktree-cleanup";
import { cleanText } from "../agent-worktrees";
import { psTimeEnvironment, readProcFile } from "../owned-process-tree";

// Processes left running in a merged worktree (a dev server an agent started
// and never stopped), which the rail's Clean up names and, on a yes, stops.
// The rule: a signal goes only to a process the user confirmed, each by its
// own pid (never a group), and only while it is that process: the same pid,
// start time and argument list the question showed (read on both sides of
// its folder, and on Linux the start read again in the same instant as the
// signal), still working inside the worktree. Anything that cannot be read
// is unknown, never "gone": nothing is signalled for it and the worktree
// stays. Codara's own processes, the shells of terminal panes and what the
// user runs in a pane are never stopped: they are named, and the worktree
// stays. Only a click stops anything; the unattended mode never does.

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
  startedAtMs: number | null;
  /** Null when it cannot be read. */
  cwd: string | null;
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
   * Signals `pid` only if it still started at `start`, checked as close to
   * the signal as the system allows; false when it was not sent.
   */
  signal(pid: number, signal: "SIGTERM" | "SIGKILL", start: string): boolean;
  wait(ms: number): Promise<void>;
  now(): number;
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
}

export interface Leftover extends WorktreeLeftoverProcess {
  start: string;
  /** Its argument list, hashed: with the pid and start, what makes it the same process. */
  commandKey: string;
  /** Why it is not stopped; the worktree then stays. */
  blocked?: string;
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "pwsh", "login"]);
const AGENTS = new Set(["claude", "codex", "cora", "pi", "gemini", "grok", "agy", "aider", "opencode", "cursor-agent", "amp"]);
const RUNNERS = new Set(["node", "nodejs", "python", "python3", "deno", "bun", "ruby", "php", "perl", "tsx", "ts-node", "uvicorn"]);
const PACKAGE_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx"]);
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

function keyOf(argv: readonly string[]): string {
  return createHash("sha256").update(argv.join("\0")).digest("hex").slice(0, 16);
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
      out.push({ pid, start: "", commandKey: "", program: "a program", blocked: "it could not be read" });
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
      const parent = chain[0];
      // What the user typed into a pane's shell is theirs to stop there.
      if (facts.parentPid === session && parent && SHELLS.has(nameOf(parent.command.split(/\s+/)[0]))) {
        blocked = `it runs in ${tabOf(session)}. Stop it there first`;
      } else if (chain.some((entry) => entry && isAgentCommand(entry.command))) {
        startedBy = `started by an agent that is still open: ${tabOf(session)}`;
      } else {
        startedBy = `started from ${tabOf(session)}, still open`;
      }
    }
    if (!blocked && (facts.cwd === null || !isAtOrUnder(facts.cwd, real))) {
      blocked = facts.cwd === null ? "its folder cannot be read" : "it only has a file open in it. Close that file first";
    }
    const runningMs = facts.startedAtMs === null ? undefined : Math.max(0, system.now() - facts.startedAtMs);
    out.push({
      pid,
      start: facts.start,
      commandKey: keyOf(facts.argv),
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
    if (!facts || facts.zombie || facts.start !== entry.start || keyOf(facts.argv) !== entry.commandKey) return "gone";
    // Alive and the same, but where it works cannot be read: unknown.
    if (facts.cwd === null) return "unknown";
    return facts;
  };
  const inside = (seen: Seen) => typeof seen === "object" && seen.cwd !== null && isAtOrUnder(seen.cwd, real);
  const send = async (targets: readonly Leftover[], signal: "SIGTERM" | "SIGKILL") => {
    for (const entry of targets) {
      if (!inside(await look(entry))) continue;
      try {
        system.signal(entry.pid, signal, entry.start);
      } catch {
        /* Gone between the check and the signal. */
      }
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
    else if (inside(seen)) failed.push({ entry, why: "it did not stop, even when forced" });
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

function linuxStat(text: string): { state: string; parentPid: number; ticks: string; name: string } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const parentPid = Number(fields[1]);
  if (!Number.isSafeInteger(parentPid) || !/^\d+$/.test(fields[19] ?? "")) return null;
  return { state: fields[0], parentPid, ticks: fields[19], name: text.slice(open + 1, close) };
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
  const [cwd, argv, boot] = await Promise.all([
    fsp.readlink(`/proc/${pid}/cwd`).catch(() => null),
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
    // As the kernel gives it: a folder removed since reads "<path> (deleted)",
    // which is not inside anything, and a real name may end the same way.
    cwd,
    command: words.length ? words.join(" ") : `[${after.name}]`,
    argv: words.length ? words : [`[${after.name}]`],
    argvExact: true,
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

const PS_FACTS = /^\s*(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

// Null when it is gone (ps lists nothing and says so); throws otherwise.
async function macPs(pid: number): Promise<{ parentPid: number; state: string; start: string; command: string } | null> {
  const out = await run("ps", ["-o", "ppid=,stat=,lstart=,args=", "-p", String(pid)]);
  const match = PS_FACTS.exec(out.stdout.split(/\r?\n/)[0] ?? "");
  if (!match) {
    if (out.code === 1 && !out.stdout.trim()) return null;
    throw new Error(`ps could not read process ${pid}`);
  }
  return { parentPid: Number(match[1]), state: match[2], start: match[3].replace(/\s+/g, " "), command: match[4] ?? "" };
}

async function macFacts(pid: number): Promise<ProcessFacts | null> {
  const before = await macPs(pid);
  if (!before) return null;
  const lsof = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwd = lsof.stdout.split(/\r?\n/).find((line) => line.startsWith("n/"))?.slice(1) ?? null;
  // ps gives the start to the second only: the command line must match too.
  const after = await macPs(pid);
  if (!after) return null;
  if (after.start !== before.start || after.command !== before.command) throw new Error(`process ${pid} changed while it was read`);
  const startedAtMs = Date.parse(after.start);
  return {
    pid,
    parentPid: after.parentPid,
    start: after.start,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    cwd,
    command: after.command,
    argv: after.command.split(/\s+/).filter(Boolean),
    argvExact: false,
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

/** The real system on Linux and macOS; null elsewhere, where a process inside keeps holding the worktree. */
export function systemLeftovers(options: { appPid: number; sessionPids: () => readonly number[] }): LeftoverSystem | undefined {
  const linux = process.platform === "linux";
  if (!linux && process.platform !== "darwin") return undefined;
  return {
    appPid: options.appPid,
    sessionPids: options.sessionPids,
    facts: linux ? linuxFacts : macFacts,
    table: linux ? linuxTable : macTable,
    signal: (pid, signal, start) => {
      // One process, never a group, init or Codara itself.
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === options.appPid) return false;
      if (linux) {
        // Read in the same instant as the signal, with nothing awaited in
        // between: a pid freed and reused has a later start. (Node offers no
        // pidfd to bind it closer.)
        let now: ReturnType<typeof linuxStat>;
        try {
          now = linuxStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
        } catch {
          return false;
        }
        if (!now || now.ticks !== start) return false;
      } else {
        // macOS: its start once more, just before the signal (to the second).
        let now: string;
        try {
          now = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { env: psTimeEnvironment(), timeout: 2_000, encoding: "utf8" });
        } catch {
          return false;
        }
        if (now.trim().replace(/\s+/g, " ") !== start) return false;
      }
      process.kill(pid, signal);
      return true;
    },
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
  };
}

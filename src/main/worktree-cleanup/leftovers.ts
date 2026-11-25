import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { basename } from "node:path";
import type { WorktreeLeftoverProcess } from "@shared/worktree-cleanup";
import { cleanText } from "../agent-worktrees";
import { psTimeEnvironment, readProcFile } from "../owned-process-tree";

// Processes left running in a merged worktree (a dev server an agent started
// and never stopped), which the rail's Clean up names and, on a yes, stops.
// Nothing is signalled unless, right before the signal, it is the same
// process (same pid and start time) and still works inside the worktree. A
// process group is signalled only when every member of it was confirmed,
// its leader included; otherwise each process alone. Codara's own processes,
// the shells of terminal panes and what the user runs in a pane are never
// stopped: they are named, and the worktree stays.

// As inspect.ts judges it, without loading it: index.ts builds the system eagerly.
function isAtOrUnder(candidate: string, dir: string): boolean {
  const key = (path: string) => {
    const slashed = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    return process.platform === "darwin" ? slashed.toLowerCase() : slashed;
  };
  const a = key(candidate);
  const b = key(dir);
  return a === b || a.startsWith(b.endsWith("/") ? b : `${b}/`);
}

export interface ProcessFacts {
  pid: number;
  parentPid: number;
  group: number;
  /** When it started, as the system spells it: a reused pid has another. */
  start: string;
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
  /** Null when it is gone. */
  facts(pid: number): Promise<ProcessFacts | null>;
  /** Every process's pid, parent and group; null when they cannot be listed. */
  table(): Promise<ReadonlyArray<{ pid: number; parentPid: number; group: number }> | null>;
  /** A negative pid signals that process group. */
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  wait(ms: number): Promise<void>;
  now(): number;
  /** How long SIGTERM gets before SIGKILL. */
  graceMs?: number;
}

export interface Leftover extends WorktreeLeftoverProcess {
  start: string;
  /** Its parent is init or the user's service manager, and no tab leads to it. */
  orphan: boolean;
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

/** "node server.js", "npm run dev", "vite": the program and its script, never other arguments. */
export function programOf(command: string): string {
  const words = command.trim().split(/\s+/).filter(Boolean);
  const name = nameOf(words[0]) || "a program";
  const args = words.slice(1).filter((word) => !word.startsWith("-"));
  if (PACKAGE_RUNNERS.has(name) && args[0] && WORD.test(args[0])) {
    if ((args[0] === "run" || args[0] === "exec") && args[1] && WORD.test(args[1])) return `${name} ${args[0]} ${args[1]}`;
    return `${name} ${args[0]}`;
  }
  if (RUNNERS.has(name) && args[0]) {
    const script = basename(args[0]);
    if (WORD.test(script)) return `${name} ${script}`;
  }
  return name;
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
    const facts = await system.facts(pid).catch(() => null);
    if (!facts || facts.zombie) continue;
    const ancestors: number[] = [];
    for (let up: number | undefined = facts.parentPid; up !== undefined && up > 1 && !ancestors.includes(up); up = parentOf.get(up)) {
      ancestors.push(up);
    }
    const session = ancestors.find((up) => sessions.has(up));
    const appAt = ancestors.findIndex((up) => app.has(up));
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
    let orphan = false;
    if (session === undefined && appAt < 0) {
      if (facts.parentPid === 1) orphan = true;
      else {
        const parent = await system.facts(facts.parentPid).catch(() => null);
        orphan = Boolean(parent && nameOf(parent.command.split(/\s+/)[0]) === "systemd" && /--user\b/.test(parent.command));
      }
    }
    const runningMs = facts.startedAtMs === null ? undefined : Math.max(0, system.now() - facts.startedAtMs);
    out.push({
      pid,
      start: facts.start,
      program: programOf(facts.command),
      ...(runningMs !== undefined ? { runningMs } : {}),
      ...(startedBy ? { startedBy } : {}),
      orphan,
      ...(blocked ? { blocked } : {}),
    });
  }
  return out;
}

/** What a confirmation of these processes is tied to: each one's pid and start, in this worktree. */
export function leftoverFingerprint(real: string, list: readonly Leftover[]): string {
  const ids = list.map((entry) => `${entry.pid}:${entry.start}`).sort();
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

/**
 * Stops exactly `list` (confirmed, none blocked): SIGTERM, then SIGKILL for
 * what is left after the grace. Returns those still running inside the
 * worktree at the end, with why; a process that moved out of it, or whose pid
 * now belongs to another process, is left alone and is not counted.
 */
export async function stopLeftovers(
  system: LeftoverSystem,
  real: string,
  list: readonly Leftover[],
): Promise<Array<{ entry: Leftover; why: string }>> {
  const confirmed = new Map(list.map((entry) => [entry.pid, entry.start]));
  const same = async (pid: number, start: string | undefined) => {
    const facts = await system.facts(pid).catch(() => null);
    return facts && !facts.zombie && start !== undefined && facts.start === start ? facts : null;
  };
  const inside = async (pid: number, start: string | undefined) => {
    const facts = await same(pid, start);
    return facts && facts.cwd !== null && isAtOrUnder(facts.cwd, real) ? facts : null;
  };
  const send = async (targets: readonly Leftover[], signal: "SIGTERM" | "SIGKILL") => {
    const table = await system.table().catch(() => null);
    const groups = new Set<number>();
    for (const entry of targets) {
      const facts = await inside(entry.pid, entry.start);
      if (!facts) continue;
      let whole = false;
      if (table && facts.group > 1 && confirmed.has(facts.group)) {
        const members = table.filter((row) => row.group === facts.group);
        whole = members.length > 0 && members.every((row) => confirmed.has(row.pid));
        for (const member of whole ? members : []) {
          if (!(await inside(member.pid, confirmed.get(member.pid)))) whole = false;
        }
      }
      try {
        if (whole) {
          if (groups.has(facts.group)) continue;
          groups.add(facts.group);
          system.signal(-facts.group, signal);
        } else system.signal(entry.pid, signal);
      } catch {
        /* Gone between the check and the signal. */
      }
    }
  };
  const running = async (targets: readonly Leftover[]) => {
    const alive: Leftover[] = [];
    for (const entry of targets) if (await same(entry.pid, entry.start)) alive.push(entry);
    return alive;
  };
  const waitFor = async (targets: readonly Leftover[], ms: number) => {
    const until = system.now() + ms;
    let left = await running(targets);
    while (left.length && system.now() < until) {
      await system.wait(POLL_MS);
      left = await running(left);
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
    if (await inside(entry.pid, entry.start)) failed.push({ entry, why: "it did not stop, even when forced" });
  }
  return failed;
}

// ── The system ─────────────────────────────────────────────────────────────

const CLOCK_TICKS_PER_SECOND = 100;

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(file, args, { timeout: 3_000, maxBuffer: 8 * 1024 * 1024, env: psTimeEnvironment(), windowsHide: true }, (error, stdout) =>
      done(error ? null : String(stdout)),
    );
  });
}

async function linuxBoot(): Promise<number | null> {
  const text = (await readProcFile("/proc/stat").catch(() => null))?.toString("utf8") ?? "";
  const match = /^btime\s+(\d+)$/m.exec(text);
  return match ? Number(match[1]) : null;
}

function linuxStat(text: string): { state: string; parentPid: number; group: number; ticks: string; name: string } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const parentPid = Number(fields[1]);
  const group = Number(fields[2]);
  if (!Number.isSafeInteger(parentPid) || !Number.isSafeInteger(group) || !/^\d+$/.test(fields[19] ?? "")) return null;
  return { state: fields[0], parentPid, group, ticks: fields[19], name: text.slice(open + 1, close) };
}

async function linuxFacts(pid: number): Promise<ProcessFacts | null> {
  const stat = await readProcFile(`/proc/${pid}/stat`).catch(() => null);
  const parsed = stat ? linuxStat(stat.toString("utf8")) : null;
  if (!parsed) return null;
  const [cwd, argv, boot] = await Promise.all([
    fsp.readlink(`/proc/${pid}/cwd`).catch(() => null),
    readProcFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0)),
    linuxBoot(),
  ]);
  const words = argv.toString("utf8").split("\0").filter(Boolean);
  return {
    pid,
    parentPid: parsed.parentPid,
    group: parsed.group,
    start: parsed.ticks,
    startedAtMs: boot === null ? null : (boot + Number(parsed.ticks) / CLOCK_TICKS_PER_SECOND) * 1000,
    cwd: cwd ? cwd.replace(/ \(deleted\)$/, "") : null,
    command: words.length ? words.join(" ") : `[${parsed.name}]`,
    zombie: parsed.state === "Z" || parsed.state === "X",
  };
}

async function linuxTable(): Promise<Array<{ pid: number; parentPid: number; group: number }> | null> {
  const names = await fsp.readdir("/proc").catch(() => null);
  if (!names) return null;
  const pids = names.filter((name) => /^\d+$/.test(name)).map(Number);
  const rows: Array<{ pid: number; parentPid: number; group: number }> = [];
  for (let i = 0; i < pids.length; i += 64) {
    const batch = await Promise.all(
      pids.slice(i, i + 64).map(async (pid) => {
        const stat = await readProcFile(`/proc/${pid}/stat`).catch(() => null);
        const parsed = stat ? linuxStat(stat.toString("utf8")) : null;
        return parsed ? { pid, parentPid: parsed.parentPid, group: parsed.group } : null;
      }),
    );
    for (const row of batch) if (row) rows.push(row);
  }
  return rows.length ? rows : null;
}

const PS_FACTS = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s?(.*)$/;

async function macFacts(pid: number): Promise<ProcessFacts | null> {
  const out = await run("ps", ["-o", "ppid=,pgid=,stat=,lstart=,args=", "-p", String(pid)]);
  const match = out ? PS_FACTS.exec(out.split(/\r?\n/)[0] ?? "") : null;
  if (!match) return null;
  const lsof = await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const cwd = lsof?.split(/\r?\n/).find((line) => line.startsWith("n/"))?.slice(1) ?? null;
  const start = match[4].replace(/\s+/g, " ");
  const startedAtMs = Date.parse(start);
  return {
    pid,
    parentPid: Number(match[1]),
    group: Number(match[2]),
    start,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    cwd,
    command: match[5] ?? "",
    zombie: match[3].includes("Z"),
  };
}

async function macTable(): Promise<Array<{ pid: number; parentPid: number; group: number }> | null> {
  const out = await run("ps", ["-axo", "pid=,ppid=,pgid="]);
  if (!out) return null;
  const rows = out
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((cols) => cols.length === 3 && cols.every(Number.isSafeInteger))
    .map(([pid, parentPid, group]) => ({ pid, parentPid, group }));
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
    signal: (pid, signal) => {
      // Never the whole session, init or Codara itself.
      if (pid === 0 || pid === -1 || Math.abs(pid) === 1 || Math.abs(pid) === options.appPid) return;
      process.kill(pid, signal);
    },
    wait: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
  };
}

import { spawn, spawnSync } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";

export interface OwnedProcessIdentity {
  pid: number;
  parentPid: number;
  startedAt: string;
  depth: number;
  /** The full command line as `ps` prints it; empty when unavailable. */
  command: string;
}

export interface OwnedProcessTree {
  rootPid: number;
  members: readonly OwnedProcessIdentity[];
}

const MAX_PS_OUTPUT_BYTES = 4 * 1024 * 1024;
const PS_TIMEOUT_MS = 1_000;
// The command-line listing is far slower than the narrow one (`ps` walks
// every process's argv), so it is only ever read asynchronously and only by
// callers that need to know WHAT a process is, never on a teardown path.
const PS_WITH_COMMANDS_TIMEOUT_MS = 6_000;
// Full-width command lines (`ww`) are long on a machine running browsers and
// Electron apps. Past this the listing counts as unavailable rather than
// parsed in part: a cut listing silently misses processes, and agent
// hibernation decides from it whether a pane holds anything but its agent.
const MAX_PS_WITH_COMMANDS_BYTES = 16 * 1024 * 1024;
// `lstart` is a fixed ctime-style stamp ("Tue Sep  1 23:48:34 2026"); the
// command line follows it and runs to the end of the line.
const PS_LINE_RE_WITH_ARGS =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*?)\s*$/;
// The narrow form has no command column: everything after the parent pid is
// the start stamp.
const PS_LINE_RE_BARE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

type ListedProcess = Omit<OwnedProcessIdentity, "depth">;

/**
 * The environment for a `ps` whose `lstart` is parsed. procps 4 and BSD ps
 * print that column in the locale's time format ("mié oct 14", "jeu. oct.
 * 15"), which neither PS_LINE_RE_WITH_ARGS nor processStartMs reads, so the
 * row would be dropped or its time misread. LC_TIME=C keeps the ctime
 * stamp. LC_ALL would override it, so its value moves to LC_CTYPE, which
 * keeps command lines decoded as before.
 */
export function psTimeEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, LC_TIME: "C" };
  if (next.LC_ALL) {
    next.LC_CTYPE = next.LC_ALL;
    delete next.LC_ALL;
  }
  return next;
}

// The command-line listing is shared between polling callers (the terminal
// notifier's sweep, once per pane) instead of forked per pane per tick.
let cachedWithCommands: { at: number; list: readonly ListedProcess[] } | null =
  null;
let inflightWithCommands: Promise<readonly ListedProcess[] | null> | null =
  null;

function safePid(pid: unknown): pid is number {
  return (
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid !== process.pid
  );
}

function parsePsOutput(stdout: string, lineRe: RegExp): ListedProcess[] {
  const processes: ListedProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const startedAt = match[3].trim();
    if (
      !safePid(pid) ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !startedAt
    )
      continue;
    processes.push({ pid, parentPid, startedAt, command: match[4] ?? "" });
  }
  return processes;
}

/** The fast narrow listing: pid, parent and start time. Synchronous. */
function listProcesses(): readonly ListedProcess[] | null {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
    maxBuffer: MAX_PS_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string")
    return null;
  return parsePsOutput(result.stdout, PS_LINE_RE_BARE);
}

// ── Linux: /proc instead of `ps` ────────────────────────────────────────────
// The pollers (the terminal notifier every 2 s, the session trackers every
// 3 s) forked `ps -axww` about 30 times a minute, and each `ps` reads every
// process's stat, status and command line. On Linux the same facts are in
// /proc, read here without a child, and a pane's own subtree is found through
// each thread's `children` file without listing the machine.

// USER_HZ: /proc/<pid>/stat counts start times in it, and Linux fixes it at
// 100 on every architecture Node runs on.
const CLOCK_TICKS_PER_SECOND = 100;
// The kernel moves btime when the wall clock is stepped (NTP, suspend), and
// `ps` reads it on every run, so it is re-read now and then.
const BOOT_TIME_MAX_AGE_MS = 60_000;
let bootSeconds: { value: number | null; at: number } | null = null;
let childrenFiles: boolean | undefined;

// The /proc reads, replaceable by tests to inject read errors.
interface ProcReader {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Buffer>;
  readdir(path: string): Promise<string[]>;
}
const systemProcReader: ProcReader = {
  readText: (path) => fsp.readFile(path, "utf8"),
  readBytes: (path) => fsp.readFile(path),
  readdir: (path) => fsp.readdir(path),
};
let procReader: ProcReader = systemProcReader;

/** Tests only: replace some /proc reads (null restores the real ones). */
export function setProcReaderForTests(reader: Partial<ProcReader> | null): void {
  procReader = reader ? { ...systemProcReader, ...reader } : systemProcReader;
  bootSeconds = null;
}

// A read that failed because the process (or one of its threads) exited
// while it was read. Any other failure (EACCES, EMFILE, EIO, a hidepid
// mount, a hardened /proc) says nothing about the process: the /proc answer
// is then incomplete and is never returned. The listing falls back to `ps`,
// exactly what ran before /proc was read, and is null when `ps` fails too.
// Callers stop panes on what a listing leaves out.
function exitedWhileRead(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

const UNKNOWN = Symbol("unknown");
type Unknown = typeof UNKNOWN;

async function linuxBootSeconds(): Promise<number | null> {
  if (bootSeconds && Date.now() - bootSeconds.at < BOOT_TIME_MAX_AGE_MS) return bootSeconds.value;
  let value: number | null = null;
  try {
    const match = /^btime\s+(\d+)$/m.exec(await procReader.readText("/proc/stat"));
    value = match ? Number(match[1]) : null;
  } catch {
    value = null;
  }
  bootSeconds = { value, at: Date.now() };
  return value;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The stamp `ps -o lstart` prints under LC_TIME=C, in local time. */
export function lstartStamp(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[at.getDay()]} ${MONTHS[at.getMonth()]} ${String(at.getDate()).padStart(2, " ")} ${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())} ${at.getFullYear()}`;
}

/** Parent pid, start time in clock ticks and name from /proc/<pid>/stat. */
export function parseProcStat(text: string): { parentPid: number; startTicks: number; name: string } | null {
  // The name sits in parentheses and may itself hold spaces and parentheses.
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const parentPid = Number(fields[1]);
  const startTicks = Number(fields[19]);
  if (!Number.isSafeInteger(parentPid) || parentPid < 0 || !Number.isFinite(startTicks)) return null;
  return { parentPid, startTicks, name: text.slice(open + 1, close) };
}

/** One process from /proc: null when it exited while being read, UNKNOWN when it could not be read. */
async function readLinuxProcess(pid: number, boot: number | null): Promise<ListedProcess | null | Unknown> {
  let stat: string;
  let argv: Buffer;
  try {
    [stat, argv] = await Promise.all([
      procReader.readText(`/proc/${pid}/stat`),
      procReader.readBytes(`/proc/${pid}/cmdline`),
    ]);
  } catch (error) {
    return exitedWhileRead(error) ? null : UNKNOWN;
  }
  const parsed = parseProcStat(stat);
  if (!parsed) return UNKNOWN;
  const startedAt =
    boot === null ? "" : lstartStamp(boot + Math.floor(parsed.startTicks / CLOCK_TICKS_PER_SECOND));
  const words = argv.toString("utf8").split("\0");
  while (words.length > 0 && words[words.length - 1] === "") words.pop();
  // `ps` shows a process without a command line (a kernel thread, a
  // zombie) by its bracketed name.
  const command = words.length > 0 ? words.join(" ") : `[${parsed.name}]`;
  return { pid, parentPid: parsed.parentPid, startedAt, command };
}


async function linuxProcessTable(): Promise<readonly ListedProcess[] | null> {
  let names: string[];
  try {
    names = await procReader.readdir("/proc");
  } catch {
    return null;
  }
  const boot = await linuxBootSeconds();
  const rows = await Promise.all(
    names.filter((name) => /^\d+$/.test(name)).map(Number).filter(safePid).map((pid) => readLinuxProcess(pid, boot)),
  );
  if (rows.includes(UNKNOWN)) return null;
  const listed = rows.filter((row): row is ListedProcess => row !== null && row !== UNKNOWN);
  return listed.length === 0 ? null : listed;
}

/**
 * Direct children of `pid`, across all its threads. Null when it is gone,
 * UNKNOWN when a list could not be read (never an empty list in its place).
 */
async function linuxChildPids(pid: number): Promise<number[] | null | Unknown> {
  let tasks: string[];
  try {
    tasks = await procReader.readdir(`/proc/${pid}/task`);
  } catch (error) {
    return exitedWhileRead(error) ? null : UNKNOWN;
  }
  const lists = await Promise.all(
    tasks.map((task) =>
      procReader.readText(`/proc/${pid}/task/${task}/children`).catch((error: unknown) =>
        // A thread that ended has no children left to list.
        exitedWhileRead(error) ? "" : UNKNOWN,
      ),
    ),
  );
  if (lists.includes(UNKNOWN)) return UNKNOWN;
  const children = new Set<number>();
  for (const list of lists as string[]) {
    for (const word of list.split(" ")) {
      const child = Number(word);
      if (word && safePid(child)) children.add(child);
    }
  }
  return [...children];
}

/** True when this kernel lists children per thread (CONFIG_PROC_CHILDREN). */
function linuxChildrenFiles(): boolean {
  if (childrenFiles === undefined) {
    childrenFiles = process.platform === "linux" && existsSync(`/proc/self/task/${process.pid}/children`);
  }
  return childrenFiles;
}

/** `rootPids` and everything below them, from /proc. Null when a read failed (incomplete). */
async function linuxSubtrees(rootPids: readonly number[]): Promise<ListedProcess[] | null> {
  const boot = await linuxBootSeconds();
  const seen = new Set<number>();
  let level = rootPids.filter((pid) => safePid(pid));
  const listed: ListedProcess[] = [];
  while (level.length > 0) {
    const fresh = level.filter((pid) => !seen.has(pid));
    for (const pid of fresh) seen.add(pid);
    const [rows, children] = await Promise.all([
      Promise.all(fresh.map((pid) => readLinuxProcess(pid, boot))),
      Promise.all(fresh.map((pid) => linuxChildPids(pid))),
    ]);
    if (rows.includes(UNKNOWN) || children.includes(UNKNOWN)) return null;
    for (const row of rows) if (row && row !== UNKNOWN) listed.push(row);
    level = children.flatMap((list) => (list && list !== UNKNOWN ? list : []));
  }
  return listed;
}

/**
 * The processes at and below `rootPids` with their command lines. On Linux
 * only those subtrees are read; elsewhere it is the whole listing (which
 * holds them). Null when the platform cannot tell.
 */
export function processesUnder(
  rootPids: readonly number[],
  maxAgeMs = 0,
): Promise<readonly ListedProcess[] | null> {
  if (!linuxChildrenFiles()) return listProcessesWithCommands(maxAgeMs);
  // An incomplete subtree is never an answer: the whole listing instead
  // (from /proc when that reads in full, else `ps`).
  return linuxSubtrees(rootPids).then((subtree) => subtree ?? listProcessesWithCommands(maxAgeMs));
}

/**
 * The listing with command lines, read off the main thread (from /proc on
 * Linux, from `ps` elsewhere). `maxAgeMs` reuses a listing taken within that
 * window; concurrent callers share one in-flight read. Null when the
 * platform cannot list processes or the read failed.
 */
export function listProcessesWithCommands(
  maxAgeMs = 0,
): Promise<readonly ListedProcess[] | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  if (
    maxAgeMs > 0 &&
    cachedWithCommands &&
    Date.now() - cachedWithCommands.at <= maxAgeMs
  ) {
    return Promise.resolve(cachedWithCommands.list);
  }
  if (inflightWithCommands) return inflightWithCommands;
  const read =
    process.platform === "linux"
      ? linuxProcessTable().then((list) => list ?? psListingWithCommands())
      : psListingWithCommands();
  inflightWithCommands = read
    .then((list) => {
      if (list) cachedWithCommands = { at: Date.now(), list };
      return list;
    })
    .finally(() => {
      inflightWithCommands = null;
    });
  return inflightWithCommands;
}

/** `ps -axww` with command lines; null when it fails, times out or overflows. */
function psListingWithCommands(): Promise<readonly ListedProcess[] | null> {
  return new Promise<readonly ListedProcess[] | null>(
    (resolve) => {
      let stdout = "";
      let overflowed = false;
      let settled = false;
      const finish = (value: readonly ListedProcess[] | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      let child: ReturnType<typeof spawn>;
      try {
        // `ww`: full command lines. Without it `ps` cuts each line to
        // $COLUMNS when that is set (an app started from a terminal), and a
        // cut command line no longer names the program it runs.
        child = spawn("ps", ["-axww", "-o", "pid=,ppid=,lstart=,args="], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
          env: psTimeEnvironment(),
        });
      } catch {
        finish(null);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(null);
      }, PS_WITH_COMMANDS_TIMEOUT_MS);
      timer.unref();
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (overflowed) return;
        if (stdout.length + chunk.length > MAX_PS_WITH_COMMANDS_BYTES) {
          overflowed = true;
          stdout = "";
          return;
        }
        stdout += chunk;
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code !== 0 || overflowed) {
          finish(null);
          return;
        }
        const parsed = parsePsOutput(stdout, PS_LINE_RE_WITH_ARGS);
        finish(parsed.length === 0 ? null : parsed);
      });
    },
  );
}

function buildTree(
  listed: readonly ListedProcess[],
  rootPid: number,
): OwnedProcessTree | null {
  const byPid = new Map(listed.map((entry) => [entry.pid, entry]));
  if (!byPid.has(rootPid)) return null;

  const depths = new Map<number, number>([[rootPid, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of listed) {
      if (depths.has(entry.pid)) continue;
      const parentDepth = depths.get(entry.parentPid);
      if (parentDepth === undefined) continue;
      depths.set(entry.pid, parentDepth + 1);
      changed = true;
    }
  }

  const members = listed
    .filter((entry) => depths.has(entry.pid))
    .map((entry) => ({ ...entry, depth: depths.get(entry.pid)! }))
    .sort((left, right) => right.depth - left.depth || right.pid - left.pid);
  return { rootPid, members };
}

/**
 * Capture the exact process identities below a child Codara spawned. Children
 * are ordered before parents so teardown cannot orphan a still-running tool
 * by killing its Pi parent first. Start timestamps make later signaling safe
 * even if a PID is recycled during the shutdown grace period.
 */
export function captureOwnedProcessTree(
  rootPid: number,
): OwnedProcessTree | null {
  if (!safePid(rootPid)) return null;
  const listed = listProcesses();
  if (!listed) return null;
  return buildTree(listed, rootPid);
}

function currentMembers(
  tree: OwnedProcessTree,
): readonly OwnedProcessIdentity[] {
  const listed = listProcesses();
  if (!listed) return [];
  const identities = new Map(
    listed.map((entry) => [entry.pid, entry.startedAt]),
  );
  return tree.members.filter(
    (member) => identities.get(member.pid) === member.startedAt,
  );
}

export function signalOwnedProcessTree(
  tree: OwnedProcessTree | null,
  signal: NodeJS.Signals,
): number {
  if (!tree) return 0;
  let signaled = 0;
  for (const member of currentMembers(tree)) {
    if (!safePid(member.pid)) continue;
    try {
      process.kill(member.pid, signal);
      signaled += 1;
    } catch {
      // Best effort: a process can exit between the identity check and signal.
    }
  }
  return signaled;
}

export function isOwnedProcessTreeAlive(
  tree: OwnedProcessTree | null,
): boolean {
  return tree ? currentMembers(tree).length > 0 : false;
}

// `ps -o lstart` prints a ctime-style stamp ("Tue Sep  1 23:48:34 2026") that
// Date.parse reads as local time; null when the platform gave something else.
export function processStartMs(startedAt: string): number | null {
  const ms = Date.parse(startedAt.replace(/\s+/g, " "));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Every process below `rootPid` that started at or after `sinceMs`, excluding
 * the root itself. Null when the process list is unavailable (Windows, ps
 * failure) so callers can tell "nothing there" from "cannot tell".
 */
export function descendantsStartedAfter(
  rootPid: number,
  sinceMs: number,
): OwnedProcessIdentity[] | null {
  const tree = captureOwnedProcessTree(rootPid);
  if (!tree) return null;
  return tree.members.filter((member) => {
    if (member.pid === rootPid) return false;
    const started = processStartMs(member.startedAt);
    return started !== null && started >= sinceMs;
  });
}

/** The subset of `members` still running under the same start time. */
export function aliveProcesses(
  members: readonly OwnedProcessIdentity[],
): OwnedProcessIdentity[] {
  if (members.length === 0) return [];
  return [...currentMembers({ rootPid: members[0].pid, members })];
}

/**
 * Every process below `rootPid` right now with its command line, excluding
 * the root. Async because the command-line listing is slow on some machines;
 * `maxAgeMs` lets a polling caller reuse a listing taken within that window
 * where the whole listing is read (not on Linux, which reads the subtree).
 * Null when the process list is unavailable.
 */
export async function descendantProcessesWithCommands(
  rootPid: number,
  maxAgeMs = 0,
): Promise<OwnedProcessIdentity[] | null> {
  if (!safePid(rootPid)) return null;
  const listed = await processesUnder([rootPid], maxAgeMs);
  if (!listed) return null;
  const tree = buildTree(listed, rootPid);
  if (!tree) return null;
  return tree.members.filter((member) => member.pid !== rootPid);
}

/** `pid` and then its ancestors, nearest first. Null when `pid` is not listed. */
export function processChainIn(
  listed: readonly { pid: number; parentPid: number }[],
  pid: number,
): number[] | null {
  const parentOf = new Map(listed.map((entry) => [entry.pid, entry.parentPid]));
  if (!parentOf.has(pid)) return null;
  const chain: number[] = [];
  let current: number | undefined = pid;
  while (current !== undefined && current > 0 && !chain.includes(current)) {
    chain.push(current);
    current = parentOf.get(current);
  }
  return chain;
}

/**
 * `pid` and its ancestors from a live listing. `maxAgeMs` reuses a recent
 * listing. Null when the process list is unavailable or `pid` has exited.
 */
export async function processChain(pid: number, maxAgeMs = 0): Promise<number[] | null> {
  if (!safePid(pid)) return null;
  const listed = await listProcessesWithCommands(maxAgeMs);
  return listed ? processChainIn(listed, pid) : null;
}

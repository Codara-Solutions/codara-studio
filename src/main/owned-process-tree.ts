import { spawn, spawnSync } from "node:child_process";

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
// `lstart` is a fixed ctime-style stamp ("Tue Sep  1 23:48:34 2026"); the
// command line follows it and runs to the end of the line.
const PS_LINE_RE_WITH_ARGS =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*?)\s*$/;
// The narrow form has no command column: everything after the parent pid is
// the start stamp.
const PS_LINE_RE_BARE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

type ListedProcess = Omit<OwnedProcessIdentity, "depth">;

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

/**
 * The listing with command lines, read off the main thread. `maxAgeMs`
 * reuses a listing taken within that window; concurrent callers share one
 * in-flight read. Null when the platform has no `ps` or it failed.
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
  inflightWithCommands = new Promise<readonly ListedProcess[] | null>(
    (resolve) => {
      let stdout = "";
      let settled = false;
      const finish = (value: readonly ListedProcess[] | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value) cachedWithCommands = { at: Date.now(), list: value };
        resolve(value);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("ps", ["-axo", "pid=,ppid=,lstart=,args="], {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
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
        if (stdout.length < MAX_PS_OUTPUT_BYTES) stdout += chunk;
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(null);
          return;
        }
        const parsed = parsePsOutput(stdout, PS_LINE_RE_WITH_ARGS);
        finish(parsed.length === 0 ? null : parsed);
      });
    },
  ).finally(() => {
    inflightWithCommands = null;
  });
  return inflightWithCommands;
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
 * `maxAgeMs` lets a polling caller reuse a listing taken within that window.
 * Null when the process list is unavailable.
 */
export async function descendantProcessesWithCommands(
  rootPid: number,
  maxAgeMs = 0,
): Promise<OwnedProcessIdentity[] | null> {
  if (!safePid(rootPid)) return null;
  const listed = await listProcessesWithCommands(maxAgeMs);
  if (!listed) return null;
  const tree = buildTree(listed, rootPid);
  if (!tree) return null;
  return tree.members.filter((member) => member.pid !== rootPid);
}

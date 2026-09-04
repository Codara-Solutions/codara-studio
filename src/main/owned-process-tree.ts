import { spawnSync } from "node:child_process";

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
// Generous on purpose: a null listing means a teardown cannot find the
// children it has to signal, and a loaded CI runner takes well over half a
// second to print every command line.
const PS_TIMEOUT_MS = 2_500;
// `lstart` is a fixed ctime-style stamp ("Tue Sep  1 23:48:34 2026"); the
// command line follows it and runs to the end of the line.
const PS_LINE_RE_WITH_ARGS =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*?)\s*$/;
// The narrow form has no command column: everything after the parent pid is
// the start stamp, exactly as the listing was read before command lines.
const PS_LINE_RE_BARE = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

// Callers that poll (the terminal notifier's one-second sweep, once per
// watched pane) share one listing per short window instead of forking `ps`
// per pane per tick. Signalling and teardown paths ask for a fresh list.
let cachedList: {
  at: number;
  list: readonly Omit<OwnedProcessIdentity, "depth">[];
} | null = null;

function safePid(pid: unknown): pid is number {
  return (
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid !== process.pid
  );
}

function listProcesses(
  maxAgeMs = 0,
): readonly Omit<OwnedProcessIdentity, "depth">[] | null {
  if (process.platform === "win32") return null;
  if (maxAgeMs > 0 && cachedList && Date.now() - cachedList.at <= maxAgeMs) {
    return cachedList.list;
  }
  // The command line is wanted (it names which agent a process is) but never
  // required: teardown only needs pid, parent and start time, and a listing
  // that fails with the wider columns must not leave a child unsignalled. So
  // fall back to the narrow form, with empty command lines, before giving up.
  const processes =
    runPs(["-axo", "pid=,ppid=,lstart=,args="], PS_LINE_RE_WITH_ARGS) ??
    runPs(["-axo", "pid=,ppid=,lstart="], PS_LINE_RE_BARE);
  if (!processes) return null;
  cachedList = { at: Date.now(), list: processes };
  return processes;
}

function runPs(
  args: string[],
  lineRe: RegExp,
): Array<Omit<OwnedProcessIdentity, "depth">> | null {
  const result = spawnSync("ps", args, {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
    maxBuffer: MAX_PS_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string")
    return null;
  const processes: Array<Omit<OwnedProcessIdentity, "depth">> = [];
  for (const line of result.stdout.split(/\r?\n/)) {
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
  // An empty listing means the columns did not parse at all on this platform;
  // treat it as a failure so the caller can try the narrower form.
  return processes.length === 0 ? null : processes;
}

/**
 * Capture the exact process identities below a child Codara spawned. Children
 * are ordered before parents so teardown cannot orphan a still-running tool
 * by killing its Pi parent first. Start timestamps make later signaling safe
 * even if a PID is recycled during the shutdown grace period.
 */
export function captureOwnedProcessTree(
  rootPid: number,
  maxAgeMs = 0,
): OwnedProcessTree | null {
  if (!safePid(rootPid)) return null;
  const listed = listProcesses(maxAgeMs);
  if (!listed) return null;
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

function currentMembers(
  tree: OwnedProcessTree,
  maxAgeMs = 0,
): readonly OwnedProcessIdentity[] {
  const listed = listProcesses(maxAgeMs);
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
  maxAgeMs = 0,
): OwnedProcessIdentity[] | null {
  const tree = captureOwnedProcessTree(rootPid, maxAgeMs);
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
  maxAgeMs = 0,
): OwnedProcessIdentity[] {
  if (members.length === 0) return [];
  return [...currentMembers({ rootPid: members[0].pid, members }, maxAgeMs)];
}

/**
 * Every process below `rootPid` right now, excluding the root. Null when the
 * process list is unavailable. `maxAgeMs` lets a polling caller reuse a
 * listing taken within that window.
 */
export function descendantProcesses(
  rootPid: number,
  maxAgeMs = 0,
): OwnedProcessIdentity[] | null {
  const tree = captureOwnedProcessTree(rootPid, maxAgeMs);
  if (!tree) return null;
  return tree.members.filter((member) => member.pid !== rootPid);
}

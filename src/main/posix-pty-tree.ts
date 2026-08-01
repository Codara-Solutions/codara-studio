import { spawnSync } from "node:child_process";

interface PtyWithOwnedSlave {
  pid: number;
  // node-pty's POSIX UnixTerminal stores the slave returned by forkpty /
  // posix_spawn here (for example /dev/ttys004 or /dev/pts/7). It is private
  // in node-pty's TypeScript surface, but it is the narrowest ownership token
  // available to us: unlike a cwd, command name, or uid, one slave belongs to
  // exactly this PTY.
  _pty?: unknown;
}

export interface PosixPtyProcessIdentity {
  pid: number;
  parentPid: number;
  startedAt: string;
  depth: number;
}

export interface PosixPtyTreeTarget {
  rootPid: number;
  ttyPath: string;
  members: readonly PosixPtyProcessIdentity[];
}

export interface PosixPtyTreeDependencies {
  platform: NodeJS.Platform;
  listExactTtyProcesses: (
    ttyPath: string,
  ) => readonly Omit<PosixPtyProcessIdentity, "depth">[] | null;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
}

const SAFE_POSIX_TTY_PATH = /^\/dev\/(?:pts\/[0-9]+|tty[A-Za-z0-9._-]+)$/;
const MAX_PS_OUTPUT_BYTES = 256 * 1024;
const PS_TIMEOUT_MS = 250;
export const POSIX_PTY_FORCE_GRACE_MS = 350;

function defaultListExactTtyProcesses(
  ttyPath: string,
): readonly Omit<PosixPtyProcessIdentity, "depth">[] | null {
  // `-t` asks ps for this one controlling terminal. Do not use `-A`, pgrep,
  // command matching, cwd matching, or uid matching: those all inspect or can
  // select processes outside the PTY Codara owns.
  const result = spawnSync(
    "ps",
    ["-t", ttyPath, "-o", "pid=,ppid=,lstart="],
    {
      encoding: "utf8",
      timeout: PS_TIMEOUT_MS,
      maxBuffer: MAX_PS_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  return parseExactTtyProcessList(result.stdout);
}

const DEFAULT_DEPENDENCIES: PosixPtyTreeDependencies = {
  platform: process.platform,
  listExactTtyProcesses: defaultListExactTtyProcesses,
  signal: (pid, signal) => process.kill(pid, signal),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
};

function dependencies(
  overrides?: Partial<PosixPtyTreeDependencies>,
): PosixPtyTreeDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function safeOwnedPid(pid: unknown): pid is number {
  return (
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    pid !== process.pid
  );
}

export function parseExactTtyProcessList(
  stdout: string,
): readonly Omit<PosixPtyProcessIdentity, "depth">[] {
  const processes: Array<Omit<PosixPtyProcessIdentity, "depth">> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!safeOwnedPid(pid) || !Number.isSafeInteger(parentPid) || parentPid < 0) {
      continue;
    }
    const startedAt = match[3].trim();
    if (!startedAt) continue;
    processes.push({ pid, parentPid, startedAt });
  }
  return processes;
}

export function capturePosixPtyTree(
  pty: PtyWithOwnedSlave,
  overrides?: Partial<PosixPtyTreeDependencies>,
): PosixPtyTreeTarget | null {
  const deps = dependencies(overrides);
  if (deps.platform === "win32" || !safeOwnedPid(pty.pid)) return null;
  if (typeof pty._pty !== "string" || !SAFE_POSIX_TTY_PATH.test(pty._pty)) {
    return null;
  }

  const listed = deps.listExactTtyProcesses(pty._pty);
  if (!listed) return null;
  const byPid = new Map(listed.map((entry) => [entry.pid, entry]));
  if (!byPid.has(pty.pid)) {
    // The root has already exited, the slave path is stale, or the process
    // listing failed to describe the handle we own. In every case, fail
    // closed instead of signaling whatever currently occupies the tty.
    return null;
  }

  const depths = new Map<number, number>([[pty.pid, 0]]);
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
    // Children before parents prevents an exiting shell from reparenting a
    // still-live child between signals.
    .sort((left, right) => right.depth - left.depth || right.pid - left.pid);

  return {
    rootPid: pty.pid,
    ttyPath: pty._pty,
    members,
  };
}

function currentOwnedMembers(
  target: PosixPtyTreeTarget,
  deps: PosixPtyTreeDependencies,
): readonly PosixPtyProcessIdentity[] {
  const current = deps.listExactTtyProcesses(target.ttyPath);
  if (!current) return [];
  const identities = new Map(
    current.map((entry) => [entry.pid, entry.startedAt]),
  );
  return target.members.filter(
    (member) => identities.get(member.pid) === member.startedAt,
  );
}

export function signalPosixPtyTree(
  target: PosixPtyTreeTarget | null,
  signal: NodeJS.Signals,
  overrides?: Partial<PosixPtyTreeDependencies>,
): number {
  if (!target) return 0;
  const deps = dependencies(overrides);
  if (deps.platform === "win32") return 0;

  let signaled = 0;
  for (const member of currentOwnedMembers(target, deps)) {
    if (!safeOwnedPid(member.pid)) continue;
    try {
      deps.signal(member.pid, signal);
      signaled += 1;
    } catch {
      // ESRCH means it exited between the exact-tty snapshot and signal.
      // EPERM and every other failure are likewise best-effort cleanup.
    }
  }
  return signaled;
}

export function isPosixPtyTreeAlive(
  target: PosixPtyTreeTarget | null,
  overrides?: Partial<PosixPtyTreeDependencies>,
): boolean {
  if (!target) return false;
  const deps = dependencies(overrides);
  if (deps.platform === "win32") return false;
  return currentOwnedMembers(target, deps).length > 0;
}

export function beginPosixPtyTreeTeardown(
  target: PosixPtyTreeTarget | null,
  graceMs = POSIX_PTY_FORCE_GRACE_MS,
  overrides?: Partial<PosixPtyTreeDependencies>,
): void {
  if (!target) return;
  const deps = dependencies(overrides);
  if (deps.platform === "win32") return;

  // SIGHUP is the normal terminal-loss signal and gives shells/agent CLIs a
  // chance to flush. Only identities that still belong to this exact PTY are
  // eligible for the bounded SIGKILL fallback.
  signalPosixPtyTree(target, "SIGHUP", deps);
  const timer = deps.setTimer(
    () => signalPosixPtyTree(target, "SIGKILL", deps),
    Math.max(0, Math.min(2_000, Math.trunc(graceMs))),
  );
  timer.unref?.();
}

import { spawnSync } from "node:child_process";

export interface OwnedProcessIdentity {
  pid: number;
  parentPid: number;
  startedAt: string;
  depth: number;
}

export interface OwnedProcessTree {
  rootPid: number;
  members: readonly OwnedProcessIdentity[];
}

const MAX_PS_OUTPUT_BYTES = 2 * 1024 * 1024;
const PS_TIMEOUT_MS = 500;

function safePid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid;
}

function listProcesses(): readonly Omit<OwnedProcessIdentity, "depth">[] | null {
  if (process.platform === "win32") return null;
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,lstart="], {
    encoding: "utf8",
    timeout: PS_TIMEOUT_MS,
    maxBuffer: MAX_PS_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;

  const processes: Array<Omit<OwnedProcessIdentity, "depth">> = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const startedAt = match[3].trim();
    if (!safePid(pid) || !Number.isSafeInteger(parentPid) || parentPid < 0 || !startedAt) continue;
    processes.push({ pid, parentPid, startedAt });
  }
  return processes;
}

/**
 * Capture the exact process identities below a child Codara spawned. Children
 * are ordered before parents so teardown cannot orphan a still-running tool
 * by killing its Pi parent first. Start timestamps make later signaling safe
 * even if a PID is recycled during the shutdown grace period.
 */
export function captureOwnedProcessTree(rootPid: number): OwnedProcessTree | null {
  if (!safePid(rootPid)) return null;
  const listed = listProcesses();
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

function currentMembers(tree: OwnedProcessTree): readonly OwnedProcessIdentity[] {
  const listed = listProcesses();
  if (!listed) return [];
  const identities = new Map(listed.map((entry) => [entry.pid, entry.startedAt]));
  return tree.members.filter((member) => identities.get(member.pid) === member.startedAt);
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

export function isOwnedProcessTreeAlive(tree: OwnedProcessTree | null): boolean {
  return tree ? currentMembers(tree).length > 0 : false;
}

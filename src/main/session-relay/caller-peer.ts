// Where a call on the agent socket really comes from, read from the kernel
// rather than from anything the caller sends. An answer typed in for the user
// (session.relay mode "answer") must come from outside Codara, but the root
// token sits in a file every process of the user can read, and the callerPid
// the MCP server sends is only what the caller says. So the processes that
// hold the other end of the TCP connection are looked up in /proc, and each
// counts as inside Codara when any of these holds:
//   - it descends from Codara's main process (every pane, agent CLI, MCP
//     server and Cora run does);
//   - its environment names a pane or a run (SPARK_PANE_ID and friends): a
//     command sent to the background with `&`, nohup, setsid or a double fork
//     loses its parent but keeps the environment it started with;
//   - it runs in a cgroup of Codara's own processes, which `env -i` does not
//     leave;
//   - any of that cannot be read.
// When Codara's main process shares its cgroup with what started it, the
// cgroup tells nothing, and every caller counts as unverified.
//
// What this does not stop: a process started inside Codara that deliberately
// starts a new program outside both its environment and its cgroup (systemd-run,
// at, cron), one that gets the outside assistant itself to send the answer,
// forging the hook or notify files so a session at a dialog looks idle,
// editing Codara's files on disk, and a dev build's app.* tools. It is defence
// in depth on a one-user machine, not a boundary against a process running as
// that user: it keeps agents from answering through their tools or a terminal
// command; it is not a sandbox.
// Linux only: elsewhere the caller cannot be checked, and an answer waits for
// Send like any relay.

import { promises as fsp } from "node:fs";
import type { RelayAnswerCaller } from "@shared/session-relay";

export interface ProcFs {
  read(path: string): Promise<string>;
  list(path: string): Promise<string[]>;
  link(path: string): Promise<string>;
}

const realProcFs: ProcFs = {
  read: (path) => fsp.readFile(path, "utf8"),
  list: (path) => fsp.readdir(path),
  link: (path) => fsp.readlink(path),
};

const ESTABLISHED = "01";
// A chain longer than this is not a real process tree.
const MAX_DEPTH = 128;

function port(address: string | undefined): number {
  const hex = address?.split(":")[1];
  return hex ? Number.parseInt(hex, 16) : -1;
}

/**
 * The inodes of the client ends of the connections from clientPort to
 * serverPort, read from a /proc/net/tcp or tcp6 table. Codara's own end
 * (local serverPort) never matches.
 */
export function clientSocketInodes(table: string, clientPort: number, serverPort: number): string[] {
  const inodes: string[] = [];
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== ESTABLISHED) continue;
    if (port(fields[1]) !== clientPort || port(fields[2]) !== serverPort) continue;
    if (/^\d+$/.test(fields[9]) && fields[9] !== "0") inodes.push(fields[9]);
  }
  return inodes;
}

/** The parent pid from a /proc/<pid>/stat line (the name may hold spaces and parentheses). */
export function parentPidOf(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  return Number.isSafeInteger(ppid) && ppid >= 0 ? ppid : null;
}

const gone = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * Every process that holds one of these sockets open, and every process
 * whose open files could not be read (another user's, or one that made
 * itself undumpable) and so might hold one too. A process or descriptor
 * that ended meanwhile is neither.
 */
export async function socketHolders(
  inodes: readonly string[],
  fs: ProcFs = realProcFs,
): Promise<{ holders: number[]; hidden: number[] }> {
  const wanted = new Set(inodes.map((inode) => `socket:[${inode}]`));
  const pids = (await fs.list("/proc")).filter((name) => /^\d+$/.test(name));
  const holders: number[] = [];
  const hidden: number[] = [];
  await Promise.all(
    pids.map(async (pid) => {
      let fds: string[];
      try {
        fds = await fs.list(`/proc/${pid}/fd`);
      } catch (err) {
        if (!gone(err)) hidden.push(Number(pid));
        return;
      }
      for (const fd of fds) {
        let target = "";
        try {
          target = await fs.link(`/proc/${pid}/fd/${fd}`);
        } catch (err) {
          if (gone(err)) continue;
          hidden.push(Number(pid));
          return;
        }
        if (wanted.has(target)) {
          holders.push(Number(pid));
          return;
        }
      }
    }),
  );
  return { holders, hidden };
}

/**
 * `pid` and all its ancestors, nearest first, up to a process with no parent
 * (pid 1, or the root of a pid namespace). Null when one cannot be read or
 * the chain is not a real one (too deep, or a loop): a partial chain could
 * hide Codara above where it stops.
 */
export async function ancestry(pid: number, fs: ProcFs = realProcFs): Promise<number[] | null> {
  const chain: number[] = [];
  let current = pid;
  while (current > 0) {
    if (chain.length >= MAX_DEPTH || chain.includes(current)) return null;
    chain.push(current);
    const stat = await fs.read(`/proc/${current}/stat`).catch(() => null);
    const parent = stat === null ? null : parentPidOf(stat);
    if (parent === null) return null;
    current = parent;
  }
  return chain;
}

// Variables Codara gives every pane's shell or run process, and that their
// children inherit.
const CODARA_ORIGIN_ENV = /(?:^|\0)SPARK_(?:PANE_ID|RUN_ID|AGENT_SOCKET|AGENT_TOKEN)=/;

/** Whether a /proc/<pid>/environ block names a Codara pane or run. */
export function hasCodaraOrigin(environ: string): boolean {
  return CODARA_ORIGIN_ENV.test(environ);
}

const readCgroup = (pid: number, fs: ProcFs) => fs.read(`/proc/${pid}/cgroup`).then((text) => text.trim());

/**
 * The cgroups Codara's own processes run in: its main process's and those of
 * everything below it (an agent may be moved to a scope of its own), minus
 * those of the processes that started Codara (a terminal, a test runner),
 * which it shares with programs that are not Codara's. Null when Codara's
 * main process has no cgroup of its own (it could not be read, or it is its
 * launcher's): then a pane's processes cannot be told apart from the
 * launcher's other programs by cgroup at all.
 */
export async function codaraCgroups(appPid: number, fs: ProcFs = realProcFs): Promise<Set<string> | null> {
  const pids = (await fs.list("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  const children = new Map<number, number[]>();
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await fs.read(`/proc/${pid}/stat`).catch(() => null);
      const parent = stat === null ? null : parentPidOf(stat);
      if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), pid]);
    }),
  );
  const members = [appPid];
  for (let i = 0; i < members.length && members.length < 100_000; i += 1) {
    for (const child of children.get(members[i]) ?? []) if (!members.includes(child)) members.push(child);
  }
  const own = await readCgroup(appPid, fs).catch(() => null);
  if (!own) return null;
  const inside = new Set(
    (await Promise.all(members.map((pid) => readCgroup(pid, fs).catch(() => null)))).filter((cg): cg is string => !!cg),
  );
  for (const pid of ((await ancestry(appPid, fs)) ?? []).slice(1)) {
    const cg = await readCgroup(pid, fs).catch(() => null);
    if (cg === own) return null;
    if (cg) inside.delete(cg);
  }
  return inside;
}

const SHARED_CGROUP =
  "Codara runs in the same cgroup as the program that started it, so it cannot tell its own processes from others";
let sharedCgroupLogged = false;

/** Why this calling process counts as inside Codara, or cannot be placed, or null. */
async function insideReason(pid: number, appPid: number, cgroups: Set<string> | null, fs: ProcFs): Promise<string | null> {
  const chain = await ancestry(pid, fs);
  if (!chain) return "Codara could not read the calling process's parents";
  if (chain.includes(appPid)) return INSIDE;
  const environ = await fs.read(`/proc/${pid}/environ`).catch(() => null);
  if (environ === null) return "Codara could not read the calling process's environment";
  if (hasCodaraOrigin(environ)) return INSIDE;
  if (cgroups === null) return SHARED_CGROUP;
  const cgroup = await readCgroup(pid, fs).catch(() => null);
  if (cgroup === null) return "Codara could not read the calling process's cgroup";
  return cgroups.has(cgroup) ? INSIDE : null;
}

const INSIDE = "it came from a process running inside Codara";

/**
 * Whether the caller on this connection runs outside Codara.
 * Fails closed: anything it cannot read counts as inside.
 */
export async function answerCallerCheck(input: {
  platform: NodeJS.Platform;
  clientPort: number | undefined;
  serverPort: number | undefined;
  appPid: number;
  fs?: ProcFs;
}): Promise<RelayAnswerCaller> {
  const fs = input.fs ?? realProcFs;
  const unverified = (why: string): RelayAnswerCaller => ({ verified: false, why });
  if (input.platform !== "linux") return unverified("Codara can check where an answer comes from only on Linux");
  if (!input.clientPort || !input.serverPort) return unverified("Codara could not see the calling connection");
  try {
    const tables = await Promise.all(
      ["/proc/net/tcp", "/proc/net/tcp6"].map((path) => fs.read(path).catch(() => "")),
    );
    const inodes = tables.flatMap((table) => clientSocketInodes(table, input.clientPort!, input.serverPort!));
    const { holders, hidden } = inodes.length > 0 ? await socketHolders(inodes, fs) : { holders: [], hidden: [] };
    if (holders.length === 0) return unverified("Codara could not find the calling process");
    const cgroups = await codaraCgroups(input.appPid, fs);
    if (cgroups === null && !sharedCgroupLogged) {
      sharedCgroupLogged = true;
      console.warn(`[relay] answers from your phone wait for Send: ${SHARED_CGROUP}`);
    }
    for (const holder of holders) {
      const why = await insideReason(holder, input.appPid, cgroups, fs);
      if (why === INSIDE) return { verified: false, why, inside: true };
      if (why) return unverified(why);
    }
    // A process of Codara's whose open files cannot be read may share the
    // connection. Others (system services, an ssh-agent) are not Codara's;
    // their environment is not readable either, so only the tree and the
    // cgroup tell.
    for (const pid of hidden) {
      const chain = await ancestry(pid, fs);
      const cgroup = await readCgroup(pid, fs).catch(() => null);
      const ours = chain === null || chain.includes(input.appPid) || cgroup === null || cgroups === null || cgroups.has(cgroup);
      if (!ours) continue;
      // Only a process that is provably gone is no longer a candidate.
      const exited = await fs.read(`/proc/${pid}/stat`).then(() => false, (err) => gone(err));
      if (!exited) return unverified("a process Codara cannot inspect may share the calling connection");
    }
    return { verified: true };
  } catch {
    return unverified("Codara could not read the calling process");
  }
}

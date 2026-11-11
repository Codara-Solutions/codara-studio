// Where a call on the agent socket really comes from, read from the kernel
// rather than from anything the caller sends. An answer typed in for the user
// (session.relay mode "answer") must come from outside Codara, but the root
// token sits in a file every process of the user can read, and the callerPid
// the MCP server sends is only what the caller says. So the processes that
// hold the other end of the TCP connection are looked up in /proc, and none
// of them may descend from Codara's main process, which every terminal pane,
// agent CLI, MCP server and Cora run does.
//
// What this does not stop: a process started inside Codara that deliberately
// leaves its process tree before it connects (setsid with a double fork,
// systemd-run, at, cron), or one that gets the outside assistant itself to
// send the answer. Any process of the user can do what the user can, so this
// keeps agents from answering through their tools or a plain command; it is
// not a sandbox. Linux only: elsewhere the caller cannot be checked, and an
// answer waits for Send like any relay.

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

/**
 * Whether the caller on this connection runs outside Codara's process tree.
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
    for (const holder of holders) {
      const chain = await ancestry(holder, fs);
      if (!chain) return unverified("Codara could not read the calling process's parents");
      if (chain.includes(input.appPid)) {
        return { verified: false, why: "it came from a process running inside Codara", inside: true };
      }
    }
    // A process under Codara whose open files cannot be read may share the
    // connection. Others (system services, an ssh-agent) are not Codara's.
    for (const pid of hidden) {
      const chain = await ancestry(pid, fs);
      if (chain === null || chain.includes(input.appPid)) {
        const exited = chain === null && !(await fs.read(`/proc/${pid}/stat`).then(() => true, () => false));
        if (!exited) return unverified("a process Codara cannot inspect may share the calling connection");
      }
    }
    return { verified: true };
  } catch {
    return unverified("Codara could not read the calling process");
  }
}

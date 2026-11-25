// Which Antigravity conversation an agy process has open, and whether agy
// says it is idle: the proof agent hibernation needs before it stops agy.
//
// agy holds one presence lock per open conversation,
// <agy dir>/presence/<conversation id>.lock, for as long as the conversation
// is open (agy 1.5.16: store.acquireConversationPresence). The open file is
// read off the process (Linux /proc/<pid>/fd links, macOS lsof), never the
// lock's contents. agy's own busy flag comes from conversation_summaries.db
// (session-search/antigravity-summaries.ts). Every answer that cannot be
// shown is a refusal: a wrong stop costs the user a turn or a subagent.

import { execFile } from "node:child_process";
import { readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { MAYBE_AGY_RE, type AgentHibernationRefusal } from "../shared/agent-hibernation";
import { isSafeSessionId } from "../shared/session-search";
import { listProcessesWithCommands } from "./owned-process-tree";
import {
  ANTIGRAVITY_SUMMARY_DB,
  antigravityCliDir,
  readAntigravityConversationActivity,
  type AntigravityConversationActivity,
} from "./session-search/antigravity-summaries";

const execFileAsync = promisify(execFile);
const CONTINUE_WORD = "continue";
const MAX_FDS = 4_096;

/** A conversation id a pane may reopen with `agy --conversation <id>`. */
export function isAntigravityConversationId(value: unknown): value is string {
  return isSafeSessionId(value) && value !== CONTINUE_WORD;
}

/** The conversation ids among a process's open file paths, from agy's presence folder only. */
export function presenceIdsFromPaths(paths: readonly string[], presenceDir: string): string[] {
  const dir = resolve(presenceDir);
  const ids = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith("/") || resolve(dirname(path)) !== dir) continue;
    const match = /^(.+)\.lock$/.exec(basename(path));
    if (match && isAntigravityConversationId(match[1])) ids.add(match[1]);
  }
  return [...ids];
}

/** File paths in `lsof -F n` output. */
export function lsofPaths(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

export interface ProcFs {
  readdir: (path: string) => Promise<string[]>;
  readlink: (path: string) => Promise<string>;
}

const gone = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * Every file a Linux process has open, from /proc/<pid>/fd. Null unless each
 * descriptor was read and the set did not change meanwhile: one left out
 * could be a second lock. A process gone since it was listed holds nothing.
 */
export async function linuxOpenFilePaths(pid: number, fs: ProcFs = { readdir, readlink }): Promise<string[] | null> {
  const dir = `/proc/${pid}/fd`;
  const fds = await fs.readdir(dir).catch((error) => (gone(error) ? null : Promise.reject(error)));
  if (fds === null) return [];
  if (fds.length > MAX_FDS) return null;
  const readAll = async (): Promise<string[] | null> => {
    const out: string[] = [];
    for (const fd of fds) {
      const path = await fs.readlink(`${dir}/${fd}`).catch(() => null);
      if (path === null) return null;
      out.push(path);
    }
    return out;
  };
  // Listed, read, listed, read, listed: the same numbers each time and the
  // same targets both times, so a descriptor opened, or closed and its
  // number reused, anywhere in the scan shows.
  const sameList = async (): Promise<boolean | "gone"> => {
    const again = await fs.readdir(dir).catch((error) => (gone(error) ? null : undefined));
    // The process may have exited mid-read: it holds nothing.
    if (again === null) return "gone";
    return again !== undefined && again.length === fds.length && fds.every((fd) => again.includes(fd));
  };
  const paths = await readAll();
  const middle = await sameList();
  if (middle === "gone") return [];
  if (paths === null || !middle) return null;
  const second = await readAll();
  const last = await sameList();
  if (last === "gone") return [];
  if (second === null || !last || second.some((path, i) => path !== paths[i])) return null;
  return paths;
}

async function openFilePaths(pid: number, platform: NodeJS.Platform): Promise<string[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") return await linuxOpenFilePaths(pid);
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(pid), "-F", "n", "-w"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      return lsofPaths(stdout);
    }
  } catch {
    return null;
  }
  return null;
}

/** The conversations agy process `pid` has open; null when its files cannot be read (Windows always). */
export async function antigravityOpenConversations(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  presenceDir?: string,
): Promise<string[] | null> {
  // The OS names open files by their real path: a presence folder reached
  // through a link must be compared as its target. Unresolvable: unknown.
  const dir = presenceDir ?? (await realpath(join(antigravityCliDir(), "presence")).catch(() => null));
  if (!dir) return null;
  const paths = await openFilePaths(pid, platform);
  return paths ? presenceIdsFromPaths(paths, dir) : null;
}

export type AntigravitySleepVerdict = { ok: true } | { ok: false; reason: AgentHibernationRefusal; detail: string };

/**
 * Whether the agy process may be stopped for its pane to resume
 * `conversationId` later: it has exactly that conversation open, agy lists
 * it as a top-level conversation, and agy marks neither it nor a subagent
 * under it as working. Pure: the caller reads both inputs.
 */
export function judgeAntigravitySleep(
  conversationId: unknown,
  open: readonly string[] | null,
  activity: AntigravityConversationActivity | null | undefined,
): AntigravitySleepVerdict {
  if (!isAntigravityConversationId(conversationId)) {
    return { ok: false, reason: "conversation-unknown", detail: "no conversation id" };
  }
  if (!open) return { ok: false, reason: "conversation-unknown", detail: "open conversation unreadable" };
  if (open.length !== 1) {
    // A subagent or a second conversation may hold one too: nothing proves
    // which one the pane would come back to.
    return { ok: false, reason: "conversation-unknown", detail: `agy holds ${open.length} conversations open` };
  }
  if (open[0] !== conversationId) {
    return { ok: false, reason: "conversation-unknown", detail: "agy has another conversation open" };
  }
  if (activity === undefined) return { ok: false, reason: "conversation-unknown", detail: "conversation list unreadable" };
  if (activity === null) return { ok: false, reason: "unknown-state", detail: "agy's conversation list has another shape" };
  if (!activity.known) return { ok: false, reason: "conversation-unknown", detail: "not in agy's conversation list" };
  if (activity.busy === "conversation") return { ok: false, reason: "agent-busy", detail: "agy marks it working" };
  if (activity.busy === "subagent") return { ok: false, reason: "agent-busy", detail: "a subagent is working" };
  return { ok: true };
}

/** agy's own view of one conversation; undefined when the database cannot be read. */
/** agy's flags alone, as a sleep verdict: the last check before the stop. */
export function antigravityActivityVerdict(
  conversationId: string,
  activityOf: (id: string) => AntigravityConversationActivity | null | undefined = currentConversationActivity,
): AntigravitySleepVerdict {
  if (!isAntigravityConversationId(conversationId)) return judgeAntigravitySleep(conversationId, null, undefined);
  return judgeAntigravitySleep(conversationId, [conversationId], activityOf(conversationId));
}

export function currentConversationActivity(conversationId: string): AntigravityConversationActivity | null | undefined {
  try {
    return readAntigravityConversationActivity(join(antigravityCliDir(), ANTIGRAVITY_SUMMARY_DB), conversationId);
  } catch {
    return undefined;
  }
}

// agy's print mode ends on its own, and a remote connection or remote agents
// carry the session beyond this pane: none of them is an idle prompt to stop.
const AGY_NOT_INTERACTIVE_RE = /(?:^|\s)(?:-p|--print|--prompt|--remote-control|--remote-agent|acp|mic-serve)(?:[\s=]|$)/;

export interface AntigravityReaders {
  open: (pid: number) => Promise<string[] | null>;
  activity: (conversationId: string) => AntigravityConversationActivity | null | undefined;
}

const liveReaders: AntigravityReaders = {
  open: (pid) => antigravityOpenConversations(pid),
  activity: currentConversationActivity,
};

/** Hibernation's check of the agy process the census found under the pane. */
export async function antigravitySleepVerdict(
  agentPid: number,
  agentCommand: string,
  conversationId: unknown,
  read: AntigravityReaders = liveReaders,
): Promise<AntigravitySleepVerdict> {
  if (AGY_NOT_INTERACTIVE_RE.test(agentCommand)) {
    return { ok: false, reason: "other-processes", detail: "agy is not an interactive session" };
  }
  const open = await read.open(agentPid).catch(() => null);
  return judgeAntigravitySleep(conversationId, open, isAntigravityConversationId(conversationId) ? read.activity(conversationId) : undefined);
}

// The listing joins argv with spaces: any command with an agy path segment
// is looked at. Reading a process that is not agy finds no lock; missing one
// would let two agy processes write one conversation.
export { MAYBE_AGY_RE };

/**
 * Before a sleeping pane runs `agy --conversation <id>`: true when some agy
 * on this machine has that conversation open or agy marks it working, so a
 * second agy must not open it. "missing" when agy no longer lists it as a
 * top-level conversation (nothing to reopen); null when that cannot be read.
 */
export async function antigravityConversationHeld(
  conversationId: string,
  activityOf: (id: string) => AntigravityConversationActivity | null | undefined = currentConversationActivity,
): Promise<boolean | "missing" | null> {
  if (!isAntigravityConversationId(conversationId)) return null;
  const activity = activityOf(conversationId);
  if (activity === undefined || activity === null) return null;
  if (activity.busy) return true;
  if (!activity.known) return "missing";
  const processes = await listProcessesWithCommands(0).catch(() => null);
  if (!processes) return null;
  for (const proc of processes) {
    if (!MAYBE_AGY_RE.test(proc.command)) continue;
    const open = await antigravityOpenConversations(proc.pid);
    if (!open) return null;
    if (open.includes(conversationId)) return true;
  }
  return false;
}

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
import { readdir, readlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { runtimeFromProcessCommand } from "../shared/agent-patterns";
import type { AgentHibernationRefusal } from "../shared/agent-hibernation";
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

async function openFilePaths(pid: number, platform: NodeJS.Platform): Promise<string[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") {
      const fds = await readdir(`/proc/${pid}/fd`).catch((error: NodeJS.ErrnoException) => {
        // Gone since it was listed: it holds nothing open.
        if (error?.code === "ENOENT") return [] as string[];
        throw error;
      });
      if (fds.length > MAX_FDS) return null;
      const paths: string[] = [];
      for (const fd of fds) {
        // A descriptor closed since the listing holds nothing.
        const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null);
        if (target) paths.push(target);
      }
      return paths;
    }
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
  presenceDir: string = join(antigravityCliDir(), "presence"),
): Promise<string[] | null> {
  const paths = await openFilePaths(pid, platform);
  return paths ? presenceIdsFromPaths(paths, presenceDir) : null;
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

/**
 * Before a sleeping pane runs `agy --conversation <id>`: true when some agy
 * on this machine has that conversation open or agy marks it working, so a
 * second agy must not open it. Null when that cannot be read.
 */
export async function antigravityConversationHeld(conversationId: string): Promise<boolean | null> {
  if (!isAntigravityConversationId(conversationId)) return null;
  const activity = currentConversationActivity(conversationId);
  if (activity === undefined || activity === null) return null;
  if (activity.busy) return true;
  const processes = await listProcessesWithCommands(0).catch(() => null);
  if (!processes) return null;
  for (const proc of processes) {
    if (runtimeFromProcessCommand(proc.command) !== "antigravity") continue;
    const open = await antigravityOpenConversations(proc.pid);
    if (!open) return null;
    if (open.includes(conversationId)) return true;
  }
  return false;
}

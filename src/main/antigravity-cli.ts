// Google's Antigravity CLI (`agy`) as a terminal agent: the user's own
// binary and their own Google sign-in, started typed into a pane's shell like
// `pi`. Codara only asks whether the binary is there, so the new-tab menu can
// show the install command instead of a shell's "command not found". It never
// runs agy itself. Of agy's own files it reads one table, read only: the
// conversation list in conversation_summaries.db, which the session picker
// offers, marks as open where agy says it is not fully idle, and the restore
// guard checks (session-search/antigravity-summaries.ts).
// Nothing else.

import { dirname } from "node:path";

import { runtimeFromProcessCommand } from "../shared/agent-patterns";
import { isSafeSessionId } from "../shared/session-search";
import { findBinaryOutsideNpm } from "./binary-resolver";
import type { IpcHandle } from "./ipc";
import { descendantProcessesWithCommands } from "./owned-process-tree";
import { sessionPid } from "./pty-manager";
import {
  continueReopensNamed,
  currentAntigravityConversations,
  currentLiveAntigravityConversations,
} from "./session-search/antigravity-summaries";

export const ANTIGRAVITY_BINARY = "agy";

export interface AntigravityStatus {
  installed: boolean;
  /** False when agy sits in a known folder the login shell's PATH lacks. */
  onPath: boolean;
  /** The folder agy was found in, or null. */
  dir: string | null;
}

// A miss is kept for 30 s so opening the menu again does not search again;
// a found agy is looked up each time, so an uninstall shows up too. A click
// on the row asks afresh, so an install made meanwhile is never missed.
const MISS_CACHE_MS = 30_000;
let missAt = 0;

export async function antigravityStatus(fresh = false): Promise<AntigravityStatus> {
  if (!fresh && missAt && Date.now() - missAt < MISS_CACHE_MS) return { installed: false, onPath: false, dir: null };
  const found = await findBinaryOutsideNpm(ANTIGRAVITY_BINARY);
  missAt = found ? 0 : Date.now();
  return found
    ? { installed: true, onPath: found.onPath, dir: dirname(found.path) }
    : { installed: false, onPath: false, dir: null };
}

/**
 * Whether a real agy process runs under the pane's shell. A restore pointer
 * is saved only then: printed text that looks like a typed `agy` saves none.
 */
export async function antigravityRunsInPane(paneId: string): Promise<boolean> {
  const rootPid = sessionPid(paneId);
  if (rootPid === null) return false;
  const below = await descendantProcessesWithCommands(rootPid, 500).catch(() => null);
  return below?.some((proc) => runtimeFromProcessCommand(proc.command) === "antigravity") ?? false;
}

// `agy --continue` reopens agy's latest conversation, and agy does not say
// whether "latest" is per folder. Until it does, one Antigravity pane per app
// run reopens it, and the same pane keeps it when it restarts again. Kept
// here rather than in the window, so a reload does not hand it out twice.
let continuePane: string | null = null;

/**
 * Whether this pane may run `agy --continue`. A restore after a restart
 * takes the claim when it is free; a restart after the pane's process died
 * only checks it, so it never reopens another pane's latest conversation.
 * Neither continues when agy's latest conversation is one another pane
 * names by id (`named`, from every workspace's tabs, saved ones included):
 * that pane reopens it itself. A refused take leaves the claim free.
 */
export function claimAntigravityContinue(
  paneId: string,
  take = true,
  named: readonly string[] = [],
  cwd: string | null = null,
): boolean {
  const holder = take ? (continuePane ?? paneId) : continuePane;
  if (holder !== paneId) return false;
  // Checked on every continue, the restart after the process died included:
  // the latest conversation can change while the pane holds the claim.
  if (named.length > 0) {
    const conversations = currentAntigravityConversations();
    if (conversations && continueReopensNamed(conversations, cwd, named)) return false;
  }
  continuePane = paneId;
  return true;
}

function namedIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isSafeSessionId).slice(0, 200) : [];
}

/** Gives the claim back when its pane never started agy (closed first, or the spawn failed). */
export function releaseAntigravityContinue(paneId: string): void {
  if (continuePane === paneId) continuePane = null;
}

export function registerAntigravityIpc(handle: IpcHandle): void {
  handle("antigravity:live-conversations", () => currentLiveAntigravityConversations());
  handle("antigravity:claim-continue", (_e, paneId: unknown, take: unknown, named: unknown, cwd: unknown) =>
    typeof paneId === "string" && paneId.length > 0
      ? claimAntigravityContinue(paneId, take !== false, namedIds(named), typeof cwd === "string" ? cwd : null)
      : false,
  );
  handle("antigravity:release-continue", (_e, paneId: unknown) => {
    if (typeof paneId === "string") releaseAntigravityContinue(paneId);
  });
  handle("antigravity:status", (_e, fresh: unknown) => antigravityStatus(fresh === true));
  handle("antigravity:runs-in-pane", (_e, paneId: unknown) =>
    typeof paneId === "string" ? antigravityRunsInPane(paneId) : false,
  );
}

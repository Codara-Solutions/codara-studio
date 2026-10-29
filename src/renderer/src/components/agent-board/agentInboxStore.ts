import { useSyncExternalStore } from "react";
import {
  emptyAgentInboxPrefs,
  parseAgentInboxPrefs,
  restoreAgentInbox,
  snapshotAgentInbox,
  type AgentInboxPrefs,
  type AgentInboxSnapshot,
} from "@shared/agent-inbox";

// What the user decided about each agent on the Agents tab (settled,
// snoozed, pinned, renamed, marked unread), kept in localStorage like the
// rest of the rail's layout, plus the last actions undo can take back and
// the quiet line in the footer that offers it. One store for the window.

export const AGENT_INBOX_STORAGE_KEY = "codara.rail.agents.inbox";
const UNDO_DEPTH = 20;
/** How long the footer line offers Undo after an action. */
export const AGENT_INBOX_NOTICE_MS = 8_000;

export interface AgentInboxNotice {
  id: number;
  text: string;
}

interface UndoEntry {
  snapshots: AgentInboxSnapshot[];
}

function read(): AgentInboxPrefs {
  try {
    const raw = window.localStorage.getItem(AGENT_INBOX_STORAGE_KEY);
    return raw ? parseAgentInboxPrefs(JSON.parse(raw), Date.now()) : emptyAgentInboxPrefs();
  } catch {
    return emptyAgentInboxPrefs();
  }
}

let prefs: AgentInboxPrefs = read();
let notice: AgentInboxNotice | null = null;
let noticeTimer: number | null = null;
let noticeSeq = 0;
const undo: UndoEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function write(next: AgentInboxPrefs): void {
  prefs = next;
  try {
    window.localStorage.setItem(AGENT_INBOX_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* remembering is best-effort */
  }
}

// Another window of Codara changed the same prefs.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== AGENT_INBOX_STORAGE_KEY) return;
    prefs = read();
    emit();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAgentInboxPrefs(): AgentInboxPrefs {
  return prefs;
}

export function useAgentInboxPrefs(): AgentInboxPrefs {
  return useSyncExternalStore(subscribe, getAgentInboxPrefs);
}

export function useAgentInboxNotice(): AgentInboxNotice | null {
  return useSyncExternalStore(subscribe, () => notice);
}

function showNotice(text: string): void {
  noticeSeq += 1;
  notice = { id: noticeSeq, text };
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    noticeTimer = null;
    notice = null;
    emit();
  }, AGENT_INBOX_NOTICE_MS);
}

/**
 * Applies an action to the prefs. With `undoText`, the keys it touched can be
 * put back with undoAgentInbox and the footer says so for a few seconds.
 */
export function updateAgentInbox(
  change: (current: AgentInboxPrefs) => AgentInboxPrefs,
  undoable?: { keys: readonly string[]; text: string },
): void {
  const before = prefs;
  const next = change(before);
  if (next === before) return;
  if (undoable && undoable.keys.length > 0) {
    undo.push({ snapshots: snapshotAgentInbox(before, undoable.keys) });
    if (undo.length > UNDO_DEPTH) undo.shift();
    showNotice(undoable.text);
  }
  write(next);
  emit();
}

/** Takes back the latest undoable action; false when there is none. */
export function undoAgentInbox(): boolean {
  const entry = undo.pop();
  if (!entry) return false;
  write(restoreAgentInbox(prefs, entry.snapshots));
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = null;
  notice = null;
  emit();
  return true;
}

export function canUndoAgentInbox(): boolean {
  return undo.length > 0;
}

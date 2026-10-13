// What agents did in the user's own browser: every tool call on a Chrome
// tab, with the agent that made it. Kept in memory for Settings and appended
// to <codara home>/chrome-link/activity.jsonl, and the extension is told
// which agent used each tab so its popup can show it.

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { parseTabRef } from "../tab-ref";

export interface ChromeActivityEntry {
  at: string;
  /** The tool name agents call, such as codara_preview_click. */
  tool: string;
  /** chrome:<tabId> or chrome:<linkId>/<tabId>, when the call named a tab. */
  tab: string | null;
  agent: string;
  workspaceId: string | null;
  detail?: string;
}

type AgentLabeler = (params: Record<string, unknown>) => string;
type UsageSink = (entry: ChromeActivityEntry, ref: { tabId: number; linkId: string | null }) => void;

const RECENT_LIMIT = 200;
const FILE_LIMIT_BYTES = 2_000_000;

const recent: ChromeActivityEntry[] = [];
const listeners = new Set<(entry: ChromeActivityEntry) => void>();
let labeler: AgentLabeler = defaultAgentLabel;
let usageSink: UsageSink | null = null;
let file: string | null = null;
let writing: Promise<void> = Promise.resolve();

function defaultAgentLabel(params: Record<string, unknown>): string {
  if (typeof params.runId === "string" && params.runId) return `Cora run ${params.runId}`;
  if (typeof params.callerPaneId === "string" && params.callerPaneId) return `Agent in pane ${params.callerPaneId}`;
  return "An agent outside Codara's terminals";
}

export function setChromeAgentLabeler(next: AgentLabeler | null): void {
  labeler = next ?? defaultAgentLabel;
}

export function setChromeUsageSink(next: UsageSink | null): void {
  usageSink = next;
}

export function setChromeActivityFile(path: string | null): void {
  file = path;
}

export function chromeAgentLabel(params: Record<string, unknown>): string {
  try {
    return labeler(params) || defaultAgentLabel(params);
  } catch {
    return defaultAgentLabel(params);
  }
}

export function toolNameOf(method: string): string {
  return method.startsWith("preview.") ? `codara_preview_${method.slice("preview.".length)}` : method;
}

export function recordChromeActivity(entry: ChromeActivityEntry): void {
  recent.push(entry);
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  for (const listener of listeners) listener(entry);
  const target = file;
  if (!target) return;
  writing = writing.then(async () => {
    try {
      await mkdir(dirname(target), { recursive: true });
      const size = await stat(target).then((info) => info.size, () => 0);
      if (size > FILE_LIMIT_BYTES) await rename(target, `${target}.1`).catch(() => {});
      await appendFile(target, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // The in-memory list still shows it.
    }
  });
}

// What a call aimed at, where that is not something the user typed: a
// URL an agent loads or a tab action. Typed text and evaluated code stay
// out of the log, since they can carry what the user is signed in with.
function callDetail(method: string, params: Record<string, unknown>): string | undefined {
  if (method === "preview.navigate" && typeof params.url === "string") return `to ${params.url.slice(0, 300)}`;
  if (method === "preview.chrome" && typeof params.action === "string") return params.action.slice(0, 20);
  return undefined;
}

/** One browser tool call that named a Chrome tab, as the socket dispatches it. */
export function noteChromeToolCall(method: string, params: Record<string, unknown>): ChromeActivityEntry | null {
  let ref;
  try {
    ref = parseTabRef(params.tabId);
  } catch {
    return null;
  }
  if (ref?.kind !== "chrome") return null;
  const entry: ChromeActivityEntry = {
    at: new Date().toISOString(),
    tool: toolNameOf(method),
    tab: typeof params.tabId === "string" ? params.tabId.trim() : null,
    agent: chromeAgentLabel(params),
    workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null,
  };
  const detail = callDetail(method, params);
  if (detail) entry.detail = detail;
  recordChromeActivity(entry);
  try {
    usageSink?.(entry, { tabId: ref.tabId, linkId: ref.linkId });
  } catch {
    /* the popup's "used by" line is best effort */
  }
  return entry;
}

export function recentChromeActivity(limit = 50): ChromeActivityEntry[] {
  return recent.slice(-limit).reverse();
}

export function onChromeActivity(listener: (entry: ChromeActivityEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Wait for pending writes (tests). */
export function flushChromeActivity(): Promise<void> {
  return writing;
}

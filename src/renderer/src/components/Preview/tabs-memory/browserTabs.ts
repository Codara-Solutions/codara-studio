// Every browser tab's state for the tabs and memory view: whether it sleeps,
// when it was last on screen, how much memory its page uses, and the title
// and URL to show while it has no page. BrowserPane reports here; the toolbar
// chip, the tabs popover and the agent bridge (previewRpc.ts) read and wake.

import { useSyncExternalStore } from "react";
import { presenceState } from "../agent-presence/store";
import { sleepBlocker, tabsToAutoSleep, type SleepBlocker, type SleepCandidate } from "./sleepPolicy";

export interface BrowserTabRecord {
  id: string;
  workspaceId: string | null;
  title: string;
  url: string;
  visible: boolean;
  lastSeenAt: number;
  asleep: boolean;
  asleepAt: number | null;
  /** The page's last picture, shown while it sleeps. */
  snapshot: string | null;
  isolated: boolean;
  recording: boolean;
  /** The page process's memory at the last reading; null asleep or unread. */
  memoryBytes: number | null;
}

const records = new Map<string, BrowserTabRecord>();
const listeners = new Set<() => void>();
let version = 0;
let list: BrowserTabRecord[] = [];
let appMemoryBytes: number | null = null;
let workspaceNames = new Map<string, string>();

const AUTO_SLEEP_KEY = "codara.browser.autoSleep";
let autoSleep = readAutoSleep();

function readAutoSleep(): boolean {
  try {
    return window.localStorage.getItem(AUTO_SLEEP_KEY) !== "off";
  } catch {
    return true;
  }
}

function emit(): void {
  version += 1;
  list = [...records.values()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function patch(id: string, change: Partial<BrowserTabRecord>): void {
  const current = records.get(id);
  if (!current) return;
  let changed = false;
  for (const key of Object.keys(change) as Array<keyof BrowserTabRecord>) {
    if (current[key] !== change[key]) changed = true;
  }
  if (!changed) return;
  records.set(id, { ...current, ...change });
  emit();
}

export function noteBrowserTab(id: string, input: { workspaceId: string | null; url: string; isolated: boolean }): void {
  const current = records.get(id);
  if (current) {
    patch(id, { workspaceId: input.workspaceId, isolated: input.isolated, url: current.url || input.url });
    return;
  }
  records.set(id, {
    id,
    workspaceId: input.workspaceId,
    title: "",
    url: input.url,
    visible: false,
    lastSeenAt: Date.now(),
    asleep: false,
    asleepAt: null,
    snapshot: null,
    isolated: input.isolated,
    recording: false,
    memoryBytes: null,
  });
  ensureTimer();
  emit();
}

export function forgetBrowserTab(id: string): void {
  wakeUrls.delete(id);
  if (records.delete(id)) emit();
}

export function noteTabPage(id: string, page: { title?: string; url?: string }): void {
  const change: Partial<BrowserTabRecord> = {};
  if (page.title !== undefined) change.title = page.title;
  if (page.url) change.url = page.url;
  patch(id, change);
}

export function noteTabVisible(id: string, visible: boolean): void {
  const current = records.get(id);
  if (!current) return;
  // Seen until the moment it leaves the screen, so the 30 minutes count from then.
  if (current.visible !== visible || visible) patch(id, { visible, lastSeenAt: Date.now() });
  // Switching tabs is a natural moment to check, besides the minute timer.
  if (current.visible !== visible) runAutoSleep();
}

export function setTabRecording(id: string, recording: boolean): void {
  patch(id, { recording });
}

export function setTabMemory(id: string, memoryBytes: number | null): void {
  patch(id, { memoryBytes });
}

function candidate(record: BrowserTabRecord): SleepCandidate {
  const presence = presenceState(record.id);
  return {
    id: record.id,
    asleep: record.asleep,
    visible: record.visible,
    lastSeenAt: record.lastSeenAt,
    isolated: record.isolated,
    recording: record.recording,
    agentActiveAt: presence.driver ? presence.activeAt : null,
  };
}

/** Why the tab cannot sleep right now, or null. */
export function tabSleepBlocker(id: string): SleepBlocker | null {
  const record = records.get(id);
  return record ? sleepBlocker(candidate(record), Date.now()) : null;
}

/** Puts a tab to sleep; refused while it is in use. */
export function sleepTab(id: string): boolean {
  const record = records.get(id);
  if (!record || record.asleep || sleepBlocker(candidate(record), Date.now())) return false;
  patch(id, { asleep: true, asleepAt: Date.now(), memoryBytes: null });
  return true;
}

// The URL an agent navigates a sleeping tab to, so it wakes there instead of
// loading its old page first.
const wakeUrls = new Map<string, string>();

export function wakeTab(id: string, url?: string): void {
  const record = records.get(id);
  if (!record?.asleep) return;
  if (url) wakeUrls.set(id, url);
  patch(id, { asleep: false, asleepAt: null, lastSeenAt: Date.now() });
}

export function takeWakeUrl(id: string): string | null {
  const url = wakeUrls.get(id) ?? null;
  wakeUrls.delete(id);
  return url;
}

export function setTabSnapshot(id: string, snapshot: string | null): void {
  patch(id, { snapshot });
}

export function isTabAsleep(id: string): boolean {
  return records.get(id)?.asleep ?? false;
}

/** Sleeps every awake tab outside the workspace on screen that may sleep. */
export function sleepTabsOutside(workspaceId: string | null): number {
  let count = 0;
  for (const record of [...records.values()]) {
    if (record.workspaceId !== workspaceId && sleepTab(record.id)) count += 1;
  }
  return count;
}

export function autoSleepEnabled(): boolean {
  return autoSleep;
}

export function setAutoSleepEnabled(enabled: boolean): void {
  autoSleep = enabled;
  try {
    window.localStorage.setItem(AUTO_SLEEP_KEY, enabled ? "on" : "off");
  } catch {
    /* the choice holds for this session only */
  }
  emit();
  if (enabled) runAutoSleep();
}

export function runAutoSleep(now = Date.now()): string[] {
  const due = tabsToAutoSleep([...records.values()].map(candidate), now, { enabled: autoSleep });
  for (const id of due) sleepTab(id);
  return due;
}

let timer: ReturnType<typeof setInterval> | null = null;
function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => runAutoSleep(), 60_000);
}

export function setBrowserWorkspaceNames(names: ReadonlyArray<readonly [string, string]>): void {
  const next = new Map(names);
  if (next.size === workspaceNames.size && [...next].every(([id, name]) => workspaceNames.get(id) === name)) return;
  workspaceNames = next;
  emit();
}

export function browserWorkspaceName(id: string | null): string {
  return (id && workspaceNames.get(id)) || "Other workspace";
}

export function appMemory(): number | null {
  return appMemoryBytes;
}

// One reading at a time, shared by every chip and popover that asks.
let polling = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let fastPolls = 0;

async function readMemory(): Promise<void> {
  const read = window.spark?.previewBridge?.tabMemory;
  if (!read) return;
  try {
    const reading = await read();
    let changed = appMemoryBytes !== reading.appBytes;
    appMemoryBytes = reading.appBytes;
    for (const record of records.values()) {
      const bytes = record.asleep ? null : reading.tabs[record.id] ?? null;
      if (record.memoryBytes !== bytes) {
        records.set(record.id, { ...record, memoryBytes: bytes });
        changed = true;
      }
    }
    if (changed) emit();
  } catch {
    /* the readout stays at its last value */
  }
}

function schedulePoll(): void {
  if (pollTimer || polling === 0) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    await readMemory();
    schedulePoll();
  }, fastPolls > 0 ? 3_000 : 15_000);
}

/** Keeps memory readings coming while the caller is mounted; `fast` while a view lists them. */
export function watchTabMemory(fast: boolean): () => void {
  polling += 1;
  if (fast) fastPolls += 1;
  if (fast || polling === 1) void readMemory();
  schedulePoll();
  return () => {
    polling -= 1;
    if (fast) fastPolls -= 1;
    if (polling === 0 && pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
}

const getVersion = () => version;

export function useBrowserTabs(): BrowserTabRecord[] {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return list;
}

export function useBrowserTab(id: string | undefined): BrowserTabRecord | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return id ? records.get(id) ?? null : null;
}

export function useAutoSleep(): boolean {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return autoSleep;
}
